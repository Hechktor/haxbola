'use strict';

const TICK_RATE = 60;

const STADIUM = {
  width: 420,
  height: 200,
  fieldW: 370,
  fieldH: 170,
  goalY: 64,
  goalDepth: 30,
  kickoffRadius: 75,
  spawnDistance: 170,
  postRadius: 8,
};

const PHYS = {
  playerRadius: 15,
  playerInvMass: 0.5,
  playerDamping: 0.96,
  playerAccel: 0.1,
  kickingAccel: 0.07,
  playerBCoef: 0.5,
  kickStrength: 5,
  kickRange: 4,
  ballRadius: 10,
  ballInvMass: 1,
  ballDamping: 0.99,
  ballBCoef: 0.5,
  wallBCoef: 1,
};

const INPUT = { UP: 1, DOWN: 2, LEFT: 4, RIGHT: 8, KICK: 16 };
const TEAM = { SPEC: 0, RED: 1, BLUE: 2 };

const POSTS = [
  { x: -STADIUM.fieldW, y: -STADIUM.goalY },
  { x: -STADIUM.fieldW, y: STADIUM.goalY },
  { x: STADIUM.fieldW, y: -STADIUM.goalY },
  { x: STADIUM.fieldW, y: STADIUM.goalY },
].map((p) => ({ ...p, vx: 0, vy: 0, r: STADIUM.postRadius, invMass: 0, bCoef: 0.5 }));

function makeBall() {
  return { x: 0, y: 0, vx: 0, vy: 0, r: PHYS.ballRadius, invMass: PHYS.ballInvMass, bCoef: PHYS.ballBCoef };
}

function collideDiscs(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = Math.hypot(dx, dy);
  const minDist = a.r + b.r;
  if (dist >= minDist || dist === 0) return false;
  const totalInv = a.invMass + b.invMass;
  if (totalInv === 0) return false;
  const nx = dx / dist;
  const ny = dy / dist;
  const overlap = minDist - dist;
  a.x -= nx * overlap * (a.invMass / totalInv);
  a.y -= ny * overlap * (a.invMass / totalInv);
  b.x += nx * overlap * (b.invMass / totalInv);
  b.y += ny * overlap * (b.invMass / totalInv);
  const vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
  if (vn < 0) {
    const j = (-(1 + a.bCoef * b.bCoef) * vn) / totalInv;
    a.vx -= nx * j * a.invMass;
    a.vy -= ny * j * a.invMass;
    b.vx += nx * j * b.invMass;
    b.vy += ny * j * b.invMass;
  }
  return true;
}

function bounce(d, axis, limit, sign) {
  // keep d[axis] * sign + r <= limit
  const v = axis === 'x' ? 'vx' : 'vy';
  if (d[axis] * sign + d.r > limit) {
    d[axis] = (limit - d.r) * sign;
    if (d[v] * sign > 0) d[v] = -d[v] * d.bCoef * PHYS.wallBCoef;
  }
}

function constrainBall(ball) {
  const S = STADIUM;
  const absX = Math.abs(ball.x);
  const sx = ball.x < 0 ? -1 : 1;
  if (absX > S.fieldW) {
    // inside goal net
    bounce(ball, 'y', S.goalY, 1);
    bounce(ball, 'y', S.goalY, -1);
    bounce(ball, 'x', S.fieldW + S.goalDepth, sx);
  } else {
    bounce(ball, 'y', S.fieldH, 1);
    bounce(ball, 'y', S.fieldH, -1);
    if (Math.abs(ball.y) > S.goalY) bounce(ball, 'x', S.fieldW, sx);
  }
}

function constrainPlayerOuter(p) {
  const S = STADIUM;
  for (const s of [1, -1]) {
    if (p.x * s + p.r > S.width) { p.x = (S.width - p.r) * s; if (p.vx * s > 0) p.vx = 0; }
    if (p.y * s + p.r > S.height) { p.y = (S.height - p.r) * s; if (p.vy * s > 0) p.vy = 0; }
  }
}

function constrainKickoff(p, kickingTeam) {
  const S = STADIUM;
  const side = p.team === TEAM.RED ? -1 : 1; // own half sign
  const distC = Math.hypot(p.x, p.y);
  if (p.team === kickingTeam) {
    if (distC > S.kickoffRadius && p.x * side < 0) {
      p.x = 0;
      if (p.vx * side < 0) p.vx = 0;
    }
  } else {
    if (p.x * side < p.r) {
      p.x = p.r * side;
      if (p.vx * side < 0) p.vx = 0;
    }
    const minD = S.kickoffRadius + p.r;
    const d = Math.hypot(p.x, p.y);
    if (d < minD) {
      const nx = d === 0 ? side : p.x / d;
      const ny = d === 0 ? 0 : p.y / d;
      p.x = nx * minD;
      p.y = ny * minD;
      const vn = p.vx * nx + p.vy * ny;
      if (vn < 0) { p.vx -= vn * nx; p.vy -= vn * ny; }
    }
  }
}

class Game {
  constructor(room) {
    this.room = room;
    this.ball = makeBall();
    this.score = [0, 0];
    this.time = 0; // ticks of live play
    this.phase = 'kickoff'; // kickoff | live | goal | ended
    this.phaseTimer = 0;
    this.kickoffTeam = TEAM.RED;
    this.paused = false;
    this.lastTouch = null;
    this.prevTouch = null;
    this.tick = 0;
    this.resetPositions();
  }

  playing() {
    return [...this.room.players.values()].filter((p) => p.team !== TEAM.SPEC);
  }

  spawnPlayer(p) {
    const S = STADIUM;
    const teammates = this.playing().filter((o) => o.team === p.team && o !== p && o.disc);
    const idx = teammates.length;
    const offsets = [0, 55, -55, 110, -110, 165, -165];
    const side = p.team === TEAM.RED ? -1 : 1;
    p.disc = {
      x: S.spawnDistance * side + (idx >= offsets.length ? side * 40 : 0),
      y: offsets[idx % offsets.length],
      vx: 0, vy: 0,
      r: PHYS.playerRadius,
      invMass: PHYS.playerInvMass,
      bCoef: PHYS.playerBCoef,
      team: p.team,
    };
    p.kickReady = true;
  }

  removePlayer(p) {
    p.disc = null;
  }

  resetPositions() {
    this.ball = makeBall();
    for (const p of this.room.players.values()) p.disc = null;
    for (const p of this.playing()) this.spawnPlayer(p);
    this.phase = 'kickoff';
    this.lastTouch = null;
    this.prevTouch = null;
  }

  touch(p) {
    if (this.lastTouch !== p.id) {
      this.prevTouch = this.lastTouch;
      this.lastTouch = p.id;
    }
    if (this.phase === 'kickoff') this.phase = 'live';
  }

  step() {
    if (this.paused) return null;
    this.tick++;
    const events = [];
    const players = this.playing().filter((p) => p.disc);
    const ball = this.ball;

    for (const p of players) {
      const d = p.disc;
      const k = p.input;
      let dx = 0, dy = 0;
      if (k & INPUT.UP) dy -= 1;
      if (k & INPUT.DOWN) dy += 1;
      if (k & INPUT.LEFT) dx -= 1;
      if (k & INPUT.RIGHT) dx += 1;
      const kicking = (k & INPUT.KICK) !== 0;
      if (!kicking) p.kickReady = true;
      d.kicking = kicking;
      if (dx || dy) {
        const len = Math.hypot(dx, dy);
        const acc = kicking ? PHYS.kickingAccel : PHYS.playerAccel;
        d.vx += (dx / len) * acc;
        d.vy += (dy / len) * acc;
      }
      if (kicking && p.kickReady && this.phase !== 'ended') {
        const bx = ball.x - d.x, by = ball.y - d.y;
        const dist = Math.hypot(bx, by);
        if (dist < d.r + ball.r + PHYS.kickRange && dist > 0 && this.canTouchBall(p)) {
          ball.vx += (bx / dist) * PHYS.kickStrength * ball.invMass;
          ball.vy += (by / dist) * PHYS.kickStrength * ball.invMass;
          p.kickReady = false;
          this.touch(p);
          events.push({ type: 'kick' });
        }
      }
    }

    for (const p of players) {
      const d = p.disc;
      d.x += d.vx; d.y += d.vy;
      d.vx *= PHYS.playerDamping; d.vy *= PHYS.playerDamping;
    }
    ball.x += ball.vx; ball.y += ball.vy;
    ball.vx *= PHYS.ballDamping; ball.vy *= PHYS.ballDamping;

    for (let i = 0; i < players.length; i++) {
      for (let j = i + 1; j < players.length; j++) collideDiscs(players[i].disc, players[j].disc);
    }
    for (const p of players) {
      if (collideDiscs(p.disc, ball)) this.touch(p);
      for (const post of POSTS) collideDiscs(p.disc, post);
    }
    for (const post of POSTS) collideDiscs(ball, post);

    constrainBall(ball);
    for (const p of players) {
      constrainPlayerOuter(p.disc);
      if (this.phase === 'kickoff') constrainKickoff(p.disc, this.kickoffTeam);
    }

    if (this.phase === 'live') {
      this.time++;
      const scored = this.checkGoal();
      if (scored) {
        const team = scored;
        this.score[team - 1]++;
        this.phase = 'goal';
        this.phaseTimer = TICK_RATE * 3;
        this.kickoffTeam = team === TEAM.RED ? TEAM.BLUE : TEAM.RED;
        const scorer = this.room.players.get(this.lastTouch);
        const assistP = this.room.players.get(this.prevTouch);
        events.push({
          type: 'goal',
          team,
          scorer: scorer ? scorer.name : null,
          ownGoal: scorer ? scorer.team !== team : false,
          assist: assistP && scorer && assistP.team === team && scorer.team === team ? assistP.name : null,
        });
      } else {
        const s = this.room.settings;
        const timeUp = s.timeLimit > 0 && this.time >= s.timeLimit * 60 * TICK_RATE;
        if (timeUp && this.score[0] !== this.score[1]) this.endMatch(events);
      }
    } else if (this.phase === 'goal') {
      if (--this.phaseTimer <= 0) {
        const s = this.room.settings;
        const scoreReached = s.scoreLimit > 0 && Math.max(...this.score) >= s.scoreLimit;
        const timeUp = s.timeLimit > 0 && this.time >= s.timeLimit * 60 * TICK_RATE;
        if (scoreReached || (timeUp && this.score[0] !== this.score[1])) this.endMatch(events);
        else this.resetPositions();
      }
    } else if (this.phase === 'ended') {
      if (--this.phaseTimer <= 0) events.push({ type: 'over' });
    }
    return events;
  }

  canTouchBall(p) {
    return !(this.phase === 'kickoff' && p.team !== this.kickoffTeam);
  }

  checkGoal() {
    const b = this.ball;
    if (Math.abs(b.y) < STADIUM.goalY && Math.abs(b.x) > STADIUM.fieldW + b.r * 0) {
      return b.x < 0 ? TEAM.BLUE : TEAM.RED;
    }
    return 0;
  }

  endMatch(events) {
    this.phase = 'ended';
    this.phaseTimer = TICK_RATE * 4;
    const winner = this.score[0] > this.score[1] ? TEAM.RED : TEAM.BLUE;
    events.push({ type: 'end', winner, score: [...this.score] });
  }

  snapshot() {
    const r = (v) => Math.round(v * 10) / 10;
    const players = [];
    for (const p of this.playing()) {
      if (!p.disc) continue;
      players.push([p.id, r(p.disc.x), r(p.disc.y), p.disc.kicking ? 1 : 0]);
    }
    return {
      t: 's',
      k: this.tick,
      b: [r(this.ball.x), r(this.ball.y)],
      p: players,
      sc: this.score,
      tm: Math.floor(this.time / TICK_RATE),
      ph: this.phase,
      ko: this.kickoffTeam,
      pa: this.paused ? 1 : 0,
    };
  }
}

module.exports = { Game, STADIUM, PHYS, INPUT, TEAM, TICK_RATE, POSTS };
