'use strict';
(() => {
  const STADIUM = { width: 420, height: 200, fieldW: 370, fieldH: 170, goalY: 64, goalDepth: 30, kickoffRadius: 75, postRadius: 8 };
  const PLAYER_R = 15, BALL_R = 10;
  const TICK_MS = 1000 / 60;
  const INTERP_DELAY = 3; // ticks
  const INPUT = { UP: 1, DOWN: 2, LEFT: 4, RIGHT: 8, KICK: 16 };
  const TEAM_COLORS = { 1: '#e56e56', 2: '#5689e5' };
  const TEAM_NAMES = { 0: 'Espectadores', 1: 'Vermelho', 2: 'Azul' };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const state = {
    ws: null, myId: null, myName: localStorage.getItem('hax_name') || '',
    screen: 'name', room: null, players: new Map(),
    snaps: [], baseTick: null, baseTime: 0, latest: null,
    input: 0, lastSentInput: -1, pendingJoin: null, goalFx: null,
  };

  // ---------- Screens & UI helpers ----------
  function show(screen) {
    state.screen = screen;
    for (const el of document.querySelectorAll('.screen')) el.classList.remove('active');
    $('screen-' + screen).classList.add('active');
    if (screen === 'room') resize();
  }
  let toastTimer;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }
  function openModal(id) { $(id).classList.add('open'); const i = $(id).querySelector('input'); if (i) setTimeout(() => i.focus(), 30); }
  function closeModals() { for (const m of document.querySelectorAll('.modal')) m.classList.remove('open'); }
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeModals));
  document.querySelectorAll('.modal').forEach((m) => m.addEventListener('click', (e) => { if (e.target === m) closeModals(); }));

  function roomCodeFromUrl() {
    const m = location.hash.match(/^#([A-Za-z0-9]{6})$/) || location.pathname.match(/^\/r\/([A-Za-z0-9]{6})/);
    return m ? m[1].toUpperCase() : null;
  }

  // ---------- Networking ----------
  function send(msg) { if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(msg)); }

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    state.ws = ws;
    $('conn-status').textContent = 'Conectando...';
    ws.onopen = () => {
      $('conn-status').textContent = '';
      if (state.myName && state.screen !== 'name') send({ t: 'hello', name: state.myName });
    };
    ws.onmessage = (e) => onMessage(JSON.parse(e.data));
    ws.onclose = () => {
      $('conn-status').textContent = 'Conexão perdida. Reconectando...';
      if (state.screen === 'room') { toast('Conexão perdida. Reconectando...'); leaveRoomUi(); }
      setTimeout(connect, 1500);
    };
  }

  function onMessage(m) {
    switch (m.t) {
      case 'welcome':
        state.myId = m.id;
        state.myName = m.name;
        $('lobby-name').textContent = m.name;
        if (state.pendingJoin) { send({ t: 'join', id: state.pendingJoin }); state.pendingJoin = null; }
        if (state.screen === 'name') { show('lobby'); refreshList(); }
        break;
      case 'rooms': renderRoomList(m.rooms); break;
      case 'joined':
        closeModals();
        state.snaps = []; state.latest = null; state.baseTick = null;
        $('chat-log').innerHTML = '';
        history.replaceState(null, '', '#' + m.id);
        show('room');
        break;
      case 'room': onRoomState(m); break;
      case 'needPassword':
        $('password-room').textContent = m.name;
        $('password-error').textContent = m.wrong ? 'Senha incorreta.' : '';
        $('input-password').value = '';
        $('form-password').dataset.room = m.id;
        openModal('modal-password');
        break;
      case 'error': toast(m.msg); if (state.screen === 'name') { show('lobby'); refreshList(); } break;
      case 'chat': addChat(m); break;
      case 's': onSnapshot(m); break;
      case 'ev': onEvent(m.ev); break;
      case 'stopped': state.snaps = []; state.latest = null; state.baseTick = null; updatePanelVisibility(true); break;
      case 'kicked': toast('Você foi expulso da sala.'); leaveRoomUi(); break;
      case 'left': leaveRoomUi(); break;
      case 'pong': $('ping').textContent = `${Math.round(performance.now() - m.c)} ms`; break;
    }
  }

  function leaveRoomUi() {
    state.room = null;
    state.snaps = []; state.latest = null;
    history.replaceState(null, '', location.pathname.startsWith('/r/') ? '/' : location.pathname);
    if (state.myId) { show('lobby'); refreshList(); } else show('name');
  }

  setInterval(() => { if (state.screen === 'room') send({ t: 'ping', c: performance.now() }); }, 2000);

  // ---------- Name ----------
  $('input-name').value = state.myName;
  $('form-name').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('input-name').value.trim();
    if (!name) return;
    state.myName = name;
    localStorage.setItem('hax_name', name);
    state.pendingJoin = roomCodeFromUrl();
    send({ t: 'hello', name });
  });
  $('btn-change-name').addEventListener('click', () => show('name'));

  // ---------- Lobby ----------
  function refreshList() { send({ t: 'list' }); }
  setInterval(() => { if (state.screen === 'lobby') refreshList(); }, 3000);
  $('btn-refresh').addEventListener('click', refreshList);

  function renderRoomList(rooms) {
    const tbody = $('room-list');
    tbody.innerHTML = rooms.map((r) => `
      <tr>
        <td>${r.locked ? '🔒 ' : ''}${esc(r.name)}</td>
        <td>${r.players}/${r.max}</td>
        <td>${r.playing ? 'Em jogo' : 'Aguardando'}</td>
        <td><button class="btn small primary" data-join="${r.id}" ${r.players >= r.max ? 'disabled' : ''}>Entrar</button></td>
      </tr>`).join('');
    $('room-empty').style.display = rooms.length ? 'none' : 'block';
  }
  $('room-list').addEventListener('click', (e) => {
    const id = e.target.dataset.join;
    if (id) send({ t: 'join', id });
  });
  $('form-code').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = $('input-code').value.trim().toUpperCase();
    if (code) send({ t: 'join', id: code });
  });
  $('btn-create').addEventListener('click', () => {
    $('create-name').value = `Sala de ${state.myName}`;
    openModal('modal-create');
  });
  $('form-create').addEventListener('submit', (e) => {
    e.preventDefault();
    send({
      t: 'create',
      name: $('create-name').value,
      isPublic: document.querySelector('input[name=vis]:checked').value === 'public',
      password: $('create-password').value,
      maxPlayers: Number($('create-max').value),
    });
  });
  $('form-password').addEventListener('submit', (e) => {
    e.preventDefault();
    send({ t: 'join', id: e.target.dataset.room, password: $('input-password').value });
  });

  // ---------- Room ----------
  function isHost() { return state.room && state.room.hostId === state.myId; }

  function onRoomState(r) {
    const wasPlaying = state.room && state.room.playing;
    state.room = r;
    state.players = new Map(r.players.map((p) => [p.id, p]));
    $('room-name').textContent = r.name;
    $('room-badge').textContent = `${r.isPublic ? 'Pública' : 'Privada'}${r.locked ? ' 🔒' : ''} · ${r.id}`;
    document.body.classList.toggle('is-host', isHost());
    const lists = { 0: [], 1: [], 2: [] };
    for (const p of r.players) lists[p.team].push(p);
    const row = (p) => `
      <li class="${p.id === state.myId ? 'me' : ''}">
        ${p.id === r.hostId ? '<span class="crown" title="Administrador">★</span>' : ''}
        <span class="pname">${esc(p.name)}</span>
        ${p.team !== 1 ? `<button class="pbtn r" data-move="${p.id}" data-team="1" title="Vermelho">V</button>` : ''}
        ${p.team !== 0 ? `<button class="pbtn s" data-move="${p.id}" data-team="0" title="Espectador">E</button>` : ''}
        ${p.team !== 2 ? `<button class="pbtn b" data-move="${p.id}" data-team="2" title="Azul">A</button>` : ''}
        ${p.id !== state.myId ? `<button class="pbtn h" data-host="${p.id}" title="Tornar administrador">★</button><button class="pbtn k" data-kick="${p.id}" title="Expulsar">✕</button>` : ''}
      </li>`;
    $('list-red').innerHTML = lists[1].map(row).join('');
    $('list-spec').innerHTML = lists[0].map(row).join('');
    $('list-blue').innerHTML = lists[2].map(row).join('');
    const me = state.players.get(state.myId);
    document.querySelectorAll('.join-btn').forEach((b) => {
      b.style.visibility = me && Number(b.dataset.team) !== me.team && (isHost() || !r.playing) ? 'visible' : 'hidden';
    });
    if (document.activeElement !== $('set-score')) $('set-score').value = r.settings.scoreLimit;
    if (document.activeElement !== $('set-time')) $('set-time').value = r.settings.timeLimit;
    if (document.activeElement !== $('set-public')) $('set-public').value = r.isPublic ? '1' : '0';
    $('btn-start').textContent = r.playing ? 'Encerrar partida' : 'Iniciar partida';
    $('btn-start').classList.toggle('primary', !r.playing);
    $('btn-start').classList.toggle('danger', r.playing);
    $('btn-pause').disabled = !r.playing;
    if (!r.playing) { $('score-red').textContent = 0; $('score-blue').textContent = 0; $('clock').textContent = '00:00'; }
    if (wasPlaying !== r.playing || wasPlaying === undefined) updatePanelVisibility(!r.playing);
  }

  function updatePanelVisibility(open) { $('panel').classList.toggle('open', open); }
  function togglePanel() { $('panel').classList.toggle('open'); }

  $('panel').addEventListener('click', (e) => {
    const t = e.target;
    if (t.dataset.move) send({ t: 'team', id: Number(t.dataset.move), team: Number(t.dataset.team) });
    else if (t.dataset.kick) send({ t: 'kick', id: Number(t.dataset.kick) });
    else if (t.dataset.host) send({ t: 'host', id: Number(t.dataset.host) });
    else if (t.classList.contains('join-btn')) send({ t: 'team', team: Number(t.dataset.team) });
    else if (t === $('panel') && state.room && state.room.playing) updatePanelVisibility(false);
  });
  $('set-score').addEventListener('change', (e) => send({ t: 'settings', settings: { scoreLimit: Number(e.target.value) } }));
  $('set-time').addEventListener('change', (e) => send({ t: 'settings', settings: { timeLimit: Number(e.target.value) } }));
  $('set-public').addEventListener('change', (e) => send({ t: 'settings', settings: { isPublic: e.target.value === '1' } }));
  $('set-password').addEventListener('change', (e) => {
    send({ t: 'settings', settings: { password: e.target.value } });
    toast(e.target.value ? 'Senha definida' : 'Senha removida');
  });
  $('btn-start').addEventListener('click', () => send({ t: state.room.playing ? 'stop' : 'start' }));
  $('btn-pause').addEventListener('click', () => send({ t: 'pause' }));
  $('btn-random').addEventListener('click', () => {
    const ids = [...state.players.keys()].sort(() => Math.random() - 0.5);
    ids.forEach((id, i) => send({ t: 'team', id, team: (i % 2) + 1 }));
  });
  $('btn-panel').addEventListener('click', togglePanel);
  $('btn-leave').addEventListener('click', () => send({ t: 'leave' }));
  $('btn-invite').addEventListener('click', async () => {
    const link = `${location.origin}/#${state.room.id}`;
    const text = state.room.locked ? `${link} (senha necessária)` : link;
    try { await navigator.clipboard.writeText(link); toast('Link copiado: ' + text); }
    catch { prompt('Copie o link da sala:', link); }
  });

  // ---------- Chat ----------
  function addChat(m) {
    const log = $('chat-log');
    const div = document.createElement('div');
    if (m.sys) { div.className = 'sys' + (m.goal ? ' goal' : ''); div.textContent = m.text; }
    else div.innerHTML = `<span class="from t${m.team}">${esc(m.from)}:</span> ${esc(m.text)}`;
    const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 10;
    log.appendChild(div);
    while (log.children.length > 200) log.removeChild(log.firstChild);
    if (atBottom) log.scrollTop = log.scrollHeight;
  }
  $('form-chat').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('input-chat').value.trim();
    if (v) send({ t: 'chat', text: v });
    $('input-chat').value = '';
    $('input-chat').blur();
  });

  // ---------- Events ----------
  function onEvent(ev) {
    if (ev.type === 'goal') {
      const color = TEAM_NAMES[ev.team];
      let text = `⚽ GOL do ${color}!`;
      if (ev.scorer) text += ev.ownGoal ? ` (contra de ${ev.scorer})` : ` ${ev.scorer}${ev.assist ? `, assistência de ${ev.assist}` : ''}`;
      addChat({ sys: true, goal: true, text });
      state.goalFx = { team: ev.team, start: performance.now(), text: ev.ownGoal ? 'GOL CONTRA!' : 'GOL!' };
    } else if (ev.type === 'end') {
      addChat({ sys: true, goal: true, text: `🏆 Fim de jogo! ${TEAM_NAMES[ev.winner]} venceu por ${ev.score[0]} x ${ev.score[1]}` });
      state.goalFx = { team: ev.winner, start: performance.now(), text: `${TEAM_NAMES[ev.winner].toUpperCase()} VENCEU!`, long: true };
    }
  }

  // ---------- Snapshots & interpolation ----------
  function estTick(now) { return state.baseTick + (now - state.baseTime) / TICK_MS; }

  function onSnapshot(s) {
    const now = performance.now();
    if (state.baseTick === null || Math.abs(estTick(now) - s.k) > 30 || s.pa) {
      state.baseTick = s.k; state.baseTime = now; state.snaps = [];
    } else {
      const err = s.k - estTick(now);
      if (err > 0) state.baseTime -= err * TICK_MS * 0.5; // snapshot arrived early: catch up quickly
      else state.baseTime -= err * TICK_MS * 0.02;
    }
    state.snaps.push(s);
    if (state.snaps.length > 60) state.snaps.shift();
    state.latest = s;
    $('score-red').textContent = s.sc[0];
    $('score-blue').textContent = s.sc[1];
    const limit = state.room ? state.room.settings.timeLimit * 60 : 0;
    const mm = String(Math.floor(s.tm / 60)).padStart(2, '0');
    const ss = String(s.tm % 60).padStart(2, '0');
    $('clock').textContent = `${mm}:${ss}`;
    $('clock').classList.toggle('overtime', limit > 0 && s.tm >= limit);
  }

  function interpolated(now) {
    const snaps = state.snaps;
    if (!snaps.length) return null;
    const latest = snaps[snaps.length - 1];
    if (latest.pa) return latest;
    const t = estTick(now) - INTERP_DELAY;
    let a = null, b = null;
    for (let i = snaps.length - 1; i >= 0; i--) {
      if (snaps[i].k <= t) { a = snaps[i]; b = snaps[i + 1] || null; break; }
    }
    if (!a) return snaps[0];
    if (!b) return a;
    const f = (t - a.k) / (b.k - a.k);
    const lerp = (x, y) => x + (y - x) * f;
    const amap = new Map(a.p.map((p) => [p[0], p]));
    return {
      ...b,
      b: [lerp(a.b[0], b.b[0]), lerp(a.b[1], b.b[1])],
      p: b.p.map((p) => {
        const q = amap.get(p[0]);
        if (!q || Math.hypot(q[1] - p[1], q[2] - p[2]) > 60) return p;
        return [p[0], lerp(q[1], p[1]), lerp(q[2], p[2]), p[3]];
      }),
    };
  }

  // ---------- Rendering ----------
  const canvas = $('canvas');
  const ctx = canvas.getContext('2d');
  let view = { scale: 1, ox: 0, oy: 0 };

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    const margin = 20;
    const scale = Math.min(canvas.width / (STADIUM.width * 2 + margin * 2), canvas.height / (STADIUM.height * 2 + margin * 2));
    view = { scale, ox: canvas.width / 2, oy: canvas.height / 2 };
  }
  window.addEventListener('resize', resize);

  function drawField() {
    const S = STADIUM;
    ctx.fillStyle = '#1a2125';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.translate(view.ox, view.oy);
    ctx.scale(view.scale, view.scale);
    // grass
    ctx.fillStyle = '#718c5a';
    ctx.fillRect(-S.width, -S.height, S.width * 2, S.height * 2);
    const stripes = 14;
    const sw = (S.width * 2) / stripes;
    ctx.fillStyle = 'rgba(0,0,0,0.05)';
    for (let i = 0; i < stripes; i += 2) ctx.fillRect(-S.width + i * sw, -S.height, sw, S.height * 2);
    // lines
    ctx.strokeStyle = '#c7e6bd';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.rect(-S.fieldW, -S.fieldH, S.fieldW * 2, S.fieldH * 2);
    ctx.moveTo(0, -S.fieldH); ctx.lineTo(0, S.fieldH);
    ctx.moveTo(S.kickoffRadius, 0); ctx.arc(0, 0, S.kickoffRadius, 0, Math.PI * 2);
    ctx.stroke();
    // goal areas (decorative arcs)
    ctx.beginPath();
    for (const sx of [-1, 1]) {
      ctx.moveTo(sx * S.fieldW, -110);
      ctx.arc(sx * S.fieldW, 0, 110, -Math.PI / 2, Math.PI / 2, sx > 0);
    }
    ctx.globalAlpha = 0.5; ctx.stroke(); ctx.globalAlpha = 1;
    // nets
    for (const sx of [-1, 1]) {
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillRect(sx < 0 ? -S.fieldW - S.goalDepth : S.fieldW, -S.goalY, S.goalDepth, S.goalY * 2);
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(sx * S.fieldW, -S.goalY);
      ctx.lineTo(sx * (S.fieldW + S.goalDepth), -S.goalY);
      ctx.lineTo(sx * (S.fieldW + S.goalDepth), S.goalY);
      ctx.lineTo(sx * S.fieldW, S.goalY);
      ctx.stroke();
    }
    // posts
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
      circle(sx * S.fieldW, sy * S.goalY, S.postRadius, sx < 0 ? '#ffcccc' : '#ccccff', '#000', 2);
    }
    ctx.restore();
  }

  function circle(x, y, r, fill, stroke, lw) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = fill; ctx.fill();
    if (stroke) { ctx.lineWidth = lw; ctx.strokeStyle = stroke; ctx.stroke(); }
  }

  function drawGame(snap, now) {
    ctx.save();
    ctx.translate(view.ox, view.oy);
    ctx.scale(view.scale, view.scale);
    for (const [id, x, y, kicking] of snap.p) {
      const pl = state.players.get(id);
      if (!pl) continue;
      const me = id === state.myId;
      if (me) {
        ctx.beginPath(); ctx.arc(x, y, PLAYER_R + 6, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 2; ctx.stroke();
      }
      circle(x, y, PLAYER_R, TEAM_COLORS[pl.team] || '#888', kicking ? '#fff' : '#000', 2);
      const label = pl.avatar || '';
      if (label) {
        ctx.fillStyle = '#fff'; ctx.font = 'bold 13px system-ui, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(label, x, y + 1);
      }
      ctx.font = '11px system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillText(pl.name, x + 1, y + PLAYER_R + 5);
      ctx.fillStyle = '#fff';
      ctx.fillText(pl.name, x, y + PLAYER_R + 4);
    }
    circle(snap.b[0], snap.b[1], BALL_R, '#fff', '#000', 2);

    // overlays
    if (snap.pa) banner('PAUSADO', '#fff', 1);
    else if (snap.ph === 'kickoff' && state.latest && state.latest.tm === 0 && snap.sc[0] + snap.sc[1] === 0) {
      ctx.globalAlpha = 0.8;
      ctx.font = 'bold 16px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = '#fff';
      ctx.fillText(`Saída de bola: ${TEAM_NAMES[snap.ko]}`, 0, -STADIUM.fieldH + 22);
      ctx.globalAlpha = 1;
    }
    const fx = state.goalFx;
    if (fx) {
      const dur = fx.long ? 4000 : 3000;
      const t = (now - fx.start) / dur;
      if (t >= 1) state.goalFx = null;
      else banner(fx.text, TEAM_COLORS[fx.team], Math.min(1, (1 - t) * 3), 1 + Math.min(t * 4, 1) * 0.2);
    }
    ctx.restore();
  }

  function banner(text, color, alpha, scale = 1) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.scale(scale, scale);
    ctx.font = 'bold 64px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 6; ctx.strokeStyle = '#000';
    ctx.strokeText(text, 0, 0);
    ctx.fillStyle = color; ctx.fillText(text, 0, 0);
    ctx.restore();
  }

  function frame() {
    requestAnimationFrame(frame);
    if (state.screen !== 'room') return;
    const now = performance.now();
    drawField();
    const snap = interpolated(now);
    if (snap && state.room && state.room.playing) drawGame(snap, now);
  }
  requestAnimationFrame(frame);

  // ---------- Input ----------
  const keys = new Set();
  const KEYMAP = {
    ArrowUp: INPUT.UP, KeyW: INPUT.UP, ArrowDown: INPUT.DOWN, KeyS: INPUT.DOWN,
    ArrowLeft: INPUT.LEFT, KeyA: INPUT.LEFT, ArrowRight: INPUT.RIGHT, KeyD: INPUT.RIGHT,
    Space: INPUT.KICK, KeyX: INPUT.KICK, ControlLeft: INPUT.KICK, ShiftLeft: INPUT.KICK,
  };
  let touchBits = 0;
  function updateInput() {
    let k = touchBits;
    for (const code of keys) k |= KEYMAP[code] || 0;
    state.input = k;
    if (k !== state.lastSentInput) { state.lastSentInput = k; send({ t: 'input', k }); }
  }
  const typing = () => ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName);
  window.addEventListener('keydown', (e) => {
    if (state.screen !== 'room') return;
    if (typing()) {
      if (e.code === 'Escape') document.activeElement.blur();
      return;
    }
    if (e.code === 'Enter') { e.preventDefault(); keys.clear(); updateInput(); $('input-chat').focus(); return; }
    if (e.code === 'Escape') { togglePanel(); return; }
    if (e.code === 'KeyP' && isHost() && state.room.playing) { send({ t: 'pause' }); return; }
    if (KEYMAP[e.code]) { e.preventDefault(); keys.add(e.code); updateInput(); }
  });
  window.addEventListener('keyup', (e) => { if (keys.delete(e.code)) updateInput(); });
  window.addEventListener('blur', () => { keys.clear(); touchBits = 0; updateInput(); });

  // touch controls
  if ('ontouchstart' in window || navigator.maxTouchPoints > 0) document.body.classList.add('touch');
  const joy = $('joy'), knob = $('joy-knob');
  let joyId = null, moveBits = 0, kickBit = 0;
  function joyMove(t) {
    const r = joy.getBoundingClientRect();
    let dx = t.clientX - (r.left + r.width / 2), dy = t.clientY - (r.top + r.height / 2);
    const len = Math.hypot(dx, dy), max = r.width / 2;
    if (len > max) { dx = dx / len * max; dy = dy / len * max; }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    moveBits = 0;
    if (len > 12) {
      const nx = dx / Math.max(len, 1), ny = dy / Math.max(len, 1);
      if (ny < -0.38) moveBits |= INPUT.UP; if (ny > 0.38) moveBits |= INPUT.DOWN;
      if (nx < -0.38) moveBits |= INPUT.LEFT; if (nx > 0.38) moveBits |= INPUT.RIGHT;
    }
    touchBits = moveBits | kickBit; updateInput();
  }
  joy.addEventListener('touchstart', (e) => { e.preventDefault(); const t = e.changedTouches[0]; joyId = t.identifier; joyMove(t); });
  joy.addEventListener('touchmove', (e) => { e.preventDefault(); for (const t of e.changedTouches) if (t.identifier === joyId) joyMove(t); });
  const joyEnd = (e) => { for (const t of e.changedTouches) if (t.identifier === joyId) { joyId = null; moveBits = 0; knob.style.transform = ''; touchBits = kickBit; updateInput(); } };
  joy.addEventListener('touchend', joyEnd); joy.addEventListener('touchcancel', joyEnd);
  const kickBtn = $('touch-kick');
  kickBtn.addEventListener('touchstart', (e) => { e.preventDefault(); kickBit = INPUT.KICK; kickBtn.classList.add('active'); touchBits = moveBits | kickBit; updateInput(); });
  const kickEnd = (e) => { e.preventDefault(); kickBit = 0; kickBtn.classList.remove('active'); touchBits = moveBits; updateInput(); };
  kickBtn.addEventListener('touchend', kickEnd); kickBtn.addEventListener('touchcancel', kickEnd);

  // ---------- Boot ----------
  connect();
  if (state.myName && roomCodeFromUrl()) $('input-name').focus();
})();
