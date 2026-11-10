'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Game, TEAM, TICK_RATE } = require('./game');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_ROOMS = 200;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (urlPath === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }
  let file = path.normalize(path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) {
      // SPA fallback so /r/CODE links work
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => {
        if (e2) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(html);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });

const rooms = new Map();
const clients = new Set();
let nextPlayerId = 1;

function genRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id;
  do {
    id = '';
    for (let i = 0; i < 6; i++) id += chars[crypto.randomInt(chars.length)];
  } while (rooms.has(id));
  return id;
}

function clean(str, max) {
  return String(str ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

function clampInt(v, min, max, def) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
}

class Room {
  constructor({ name, isPublic, password, maxPlayers }) {
    this.id = genRoomId();
    this.name = name;
    this.isPublic = isPublic;
    this.password = password || '';
    this.maxPlayers = maxPlayers;
    this.settings = { scoreLimit: 3, timeLimit: 3 };
    this.players = new Map();
    this.hostId = null;
    this.game = null;
    this.createdAt = Date.now();
  }

  info() {
    return {
      id: this.id,
      name: this.name,
      players: this.players.size,
      max: this.maxPlayers,
      locked: !!this.password,
      playing: !!this.game,
    };
  }

  state() {
    return {
      t: 'room',
      id: this.id,
      name: this.name,
      isPublic: this.isPublic,
      locked: !!this.password,
      maxPlayers: this.maxPlayers,
      settings: this.settings,
      hostId: this.hostId,
      playing: !!this.game,
      players: [...this.players.values()].map((p) => ({ id: p.id, name: p.name, team: p.team, avatar: p.avatar })),
    };
  }

  broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const p of this.players.values()) send(p.ws, data);
  }

  sync() { this.broadcast(this.state()); }

  system(text) { this.broadcast({ t: 'chat', sys: true, text }); }

  add(player) {
    this.players.set(player.id, player);
    player.room = this;
    player.team = TEAM.SPEC;
    player.input = 0;
    player.disc = null;
    if (this.hostId == null) this.hostId = player.id;
    send(player.ws, { t: 'joined', id: this.id });
    this.system(`${player.name} entrou na sala`);
    this.sync();
    if (this.game) send(player.ws, this.game.snapshot());
  }

  remove(player) {
    if (!this.players.delete(player.id)) return;
    player.room = null;
    player.disc = null;
    if (this.players.size === 0) {
      rooms.delete(this.id);
      return;
    }
    if (this.hostId === player.id) {
      this.hostId = this.players.keys().next().value;
      const h = this.players.get(this.hostId);
      this.system(`${h.name} agora é o administrador`);
    }
    this.system(`${player.name} saiu da sala`);
    this.sync();
  }

  setTeam(player, team) {
    if (player.team === team) return;
    player.team = team;
    player.input = 0;
    if (this.game) {
      if (team === TEAM.SPEC) this.game.removePlayer(player);
      else this.game.spawnPlayer(player);
    }
    this.sync();
  }

  start() {
    if (this.game) return;
    this.game = new Game(this);
    this.system('A partida começou!');
    this.sync();
  }

  stop() {
    if (!this.game) return;
    this.game = null;
    for (const p of this.players.values()) p.disc = null;
    this.broadcast({ t: 'stopped' });
    this.sync();
  }

  tick() {
    if (!this.game) return;
    const events = this.game.step();
    if (events) {
      for (const ev of events) {
        if (ev.type === 'over') { this.stop(); return; }
        this.broadcast({ t: 'ev', ev });
      }
    }
    this.broadcast(this.game.snapshot());
  }
}

function lobbyList() {
  return [...rooms.values()].filter((r) => r.isPublic).map((r) => r.info())
    .sort((a, b) => b.players - a.players || a.name.localeCompare(b.name));
}

function handle(player, msg) {
  const room = player.room;
  const isHost = room && room.hostId === player.id;

  switch (msg.t) {
    case 'hello': {
      player.name = clean(msg.name, 20) || `Jogador${player.id}`;
      send(player.ws, { t: 'welcome', id: player.id, name: player.name });
      break;
    }
    case 'list':
      send(player.ws, { t: 'rooms', rooms: lobbyList() });
      break;
    case 'create': {
      if (!player.name) return;
      if (room) room.remove(player);
      if (rooms.size >= MAX_ROOMS) return send(player.ws, { t: 'error', msg: 'Limite de salas atingido.' });
      const r = new Room({
        name: clean(msg.name, 40) || `Sala de ${player.name}`,
        isPublic: msg.isPublic !== false,
        password: clean(msg.password, 30),
        maxPlayers: clampInt(msg.maxPlayers, 2, 20, 12),
      });
      rooms.set(r.id, r);
      r.add(player);
      break;
    }
    case 'join': {
      if (!player.name) return;
      const id = clean(msg.id, 10).toUpperCase();
      const r = rooms.get(id);
      if (!r) return send(player.ws, { t: 'error', msg: 'Sala não encontrada.' });
      if (r === room) return;
      if (r.players.size >= r.maxPlayers) return send(player.ws, { t: 'error', msg: 'A sala está cheia.' });
      if (r.password && clean(msg.password, 30) !== r.password) {
        return send(player.ws, { t: 'needPassword', id: r.id, name: r.name, wrong: msg.password != null });
      }
      if (room) room.remove(player);
      r.add(player);
      break;
    }
    case 'leave':
      if (room) room.remove(player);
      send(player.ws, { t: 'left' });
      break;
    case 'chat': {
      if (!room) return;
      const text = clean(msg.text, 140);
      if (!text) return;
      const now = Date.now();
      player.chatTimes = (player.chatTimes || []).filter((t) => now - t < 5000);
      if (player.chatTimes.length >= 6) return;
      player.chatTimes.push(now);
      if (text.startsWith('/avatar')) {
        player.avatar = [...text.slice(7).trim()].slice(0, 2).join('');
        room.sync();
        return;
      }
      room.broadcast({ t: 'chat', from: player.name, team: player.team, text });
      break;
    }
    case 'team': {
      if (!room) return;
      const team = clampInt(msg.team, 0, 2, 0);
      const targetId = msg.id ?? player.id;
      const target = room.players.get(targetId);
      if (!target) return;
      if (!isHost && (target !== player || room.game)) return;
      room.setTeam(target, team);
      break;
    }
    case 'input':
      if (room) player.input = clampInt(msg.k, 0, 31, 0);
      break;
    case 'start':
      if (isHost) room.start();
      break;
    case 'stop':
      if (isHost) room.stop();
      break;
    case 'pause':
      if (isHost && room.game) {
        room.game.paused = !room.game.paused;
        room.system(room.game.paused ? 'Jogo pausado' : 'Jogo retomado');
        room.broadcast(room.game.snapshot());
      }
      break;
    case 'settings': {
      if (!isHost) return;
      const s = msg.settings || {};
      if (s.scoreLimit != null) room.settings.scoreLimit = clampInt(s.scoreLimit, 0, 20, 3);
      if (s.timeLimit != null) room.settings.timeLimit = clampInt(s.timeLimit, 0, 30, 3);
      if (s.isPublic != null) room.isPublic = !!s.isPublic;
      if (s.password != null) room.password = clean(s.password, 30);
      if (s.name != null) room.name = clean(s.name, 40) || room.name;
      if (s.maxPlayers != null) room.maxPlayers = clampInt(s.maxPlayers, Math.max(2, room.players.size), 20, room.maxPlayers);
      room.sync();
      break;
    }
    case 'kick': {
      if (!isHost || msg.id === player.id) return;
      const target = room.players.get(msg.id);
      if (!target) return;
      room.remove(target);
      send(target.ws, { t: 'kicked' });
      room.system(`${target.name} foi expulso`);
      break;
    }
    case 'host': {
      if (!isHost) return;
      const target = room.players.get(msg.id);
      if (!target) return;
      room.hostId = target.id;
      room.system(`${target.name} agora é o administrador`);
      room.sync();
      break;
    }
    case 'ping':
      send(player.ws, { t: 'pong', c: msg.c });
      break;
  }
}

wss.on('connection', (ws) => {
  const player = { id: nextPlayerId++, ws, name: '', room: null, team: TEAM.SPEC, input: 0, avatar: '' };
  clients.add(player);
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg && typeof msg.t === 'string') handle(player, msg);
  });
  ws.on('close', () => {
    clients.delete(player);
    if (player.room) player.room.remove(player);
  });
});

const TICK_MS = 1000 / TICK_RATE;
let last = performance.now();
let acc = 0;
setInterval(() => {
  const now = performance.now();
  acc += now - last;
  last = now;
  if (acc > 250) acc = 250;
  while (acc >= TICK_MS) {
    for (const r of rooms.values()) r.tick();
    acc -= TICK_MS;
  }
}, 4);

server.listen(PORT, () => console.log(`Haxball clone rodando em http://localhost:${PORT}`));
