// Authoritative game server + tiny static file server.
// - Serves the web game from /public and /shared
// - Room manager: a public QUICK-MATCH room + private code rooms (play with friends)
// - Each room runs its own LOBBY -> COUNTDOWN -> MATCH state machine
// - Fills empty match slots with bots; idle players convert to bots (reclaimable)

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';

import {
  createState, addPlayer, removePlayer, step, attachBall,
} from './shared/sim.js';
import {
  TICK_RATE, DT, SNAPSHOT_RATE, MAX_PLAYERS, FIELD, CHARACTERS, DEFAULT_CHAR, ENDED_HOLD,
  MAG_SIZE, AMMO_REGEN, EMPTY_RELOAD, BUILD_MAG, BUILD_RELOAD,
} from './shared/constants.js';
import { ARENA } from './shared/arena.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3010;

// ---------------------------------------------------------------------------
// Static file server (so the browser can import /shared/*.js ES modules)
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/public/index.html';
  if (!urlPath.startsWith('/shared/') && !urlPath.startsWith('/public/')) {
    urlPath = '/public' + urlPath;
  }
  const filePath = path.normalize(path.join(__dirname, urlPath));
  if (!filePath.startsWith(__dirname)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-store, must-revalidate',
    });
    res.end(data);
  });
});

// ---------------------------------------------------------------------------
// Room manager
// ---------------------------------------------------------------------------
const COUNTDOWN_TIME = 5;    // seconds from start to kickoff
const AFK_SECONDS = 10;      // no meaningful input for this long -> becomes a bot
const TEAM_CAP = 2;          // players per team in a 2v2 match

const members = new Map();   // ws -> member (a connected client)
const rooms = new Map();     // roomId -> room
let publicRoom = null;       // the current forming quick-match room (in lobby/countdown)
let memberCounter = 0, roomCounter = 0;
let msgErrCount = 0, tickErrCount = 0, bcErrCount = 0;

const nowMs = () => Date.now();
// member = { id, ws, name, avatar, team, inMatch, afk, lastInputAt, room }

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) { try { ws.send(JSON.stringify(obj)); } catch { /* dead socket */ } }
}
function onlineCount() { return members.size; }

function makeRoom(id, isPrivate) {
  return {
    id, isPrivate: !!isPrivate,
    phase: 'lobby',          // lobby | countdown | match
    countdownT: 0, endHoldT: 0,
    state: createState(),
    inputs: new Map(),       // playerId -> input
    botCounter: 0,
    members: new Set(),      // member objects
  };
}

const CODE_CHARS = 'ACDEFHJKLMNPRTUVWXY34679'; // no ambiguous chars (0/O/1/I…)
function genCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  } while (rooms.has(code));
  return code;
}

function emptyInput() {
  return { seq: 0, moveX: 0, moveY: 0, aimX: 0, aimY: 0, shoot: false, special: false, build: false, charge: 0 };
}
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr;
}

function applySettings(room, s) {
  const c = (v, lo, hi, d) => (typeof v === 'number' && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  const cur = room.state.settings;
  room.state.settings = {
    speedMul: c(s.speedMul, 0.1, 3, cur.speedMul),
    sizeMul: c(s.sizeMul, 0.2, 3, cur.sizeMul),
    ballSizeMul: c(s.ballSizeMul, 0.2, 4, cur.ballSizeMul),
    carrySpeedMul: c(s.carrySpeedMul, 0.1, 1, cur.carrySpeedMul),
    shotPower: c(s.shotPower, 100, 3000, cur.shotPower),
    bulletSpeed: c(s.bulletSpeed, 50, 1500, cur.bulletSpeed),
    bulletKnockback: c(s.bulletKnockback, 0, 2500, cur.bulletKnockback),
    bombPower: c(s.bombPower, 0, 5000, cur.bombPower),
  };
}

// Emptier team among a room's members (for auto-balancing on join).
function balancedTeam(room) {
  let A = 0, B = 0;
  for (const m of room.members) (m.team === 'B' ? B++ : A++);
  return A <= B ? 'A' : 'B';
}

function fillBots(room) {
  const teamCount = (t) => Object.values(room.state.players).filter((p) => p.team === t).length;
  const usedSlots = (t) => new Set(Object.values(room.state.players).filter((p) => p.team === t).map((p) => p.slot));
  while (Object.keys(room.state.players).length < MAX_PLAYERS) {
    const team = teamCount('A') <= teamCount('B') ? 'A' : 'B';
    const slot = usedSlots(team).has(0) ? 1 : 0;
    const id = `bot-${room.id}-${++room.botCounter}`;
    addPlayer(room.state, id, { name: 'Bot', char: DEFAULT_CHAR, team, slot, isBot: true });
    room.inputs.set(id, emptyInput());
  }
}

// ---------------------------------------------------------------------------
// Bot AI (per room) — chase/pass/shoot, plus bombs, defensive walls, static-wall
// avoidance, and lurking in bushes to ambush.
// ---------------------------------------------------------------------------
const BOT_RADIUS = 30;
// Nudge a unit move dir away from any static wall just ahead so bots don't jam on it.
function avoidWalls(x, y, mx, my) {
  const ax = x + mx * 90, ay = y + my * 90; // lookahead point
  for (const w of ARENA.walls) {
    const nx = Math.max(w.x, Math.min(ax, w.x + w.w));
    const ny = Math.max(w.y, Math.min(ay, w.y + w.h));
    const dx = ax - nx, dy = ay - ny, d = Math.hypot(dx, dy);
    if (d < BOT_RADIUS + 44) {
      if (d > 0.01) { mx += (dx / d) * 1.5; my += (dy / d) * 1.5; }
      else { const ox = mx, oy = my; mx = ox - oy * 1.5; my = oy + ox * 1.5; } // dead-centre: veer
    }
  }
  const l = Math.hypot(mx, my) || 1;
  return [mx / l, my / l];
}
function nearestBush(x, y) {
  let best = null, bd = 1e9;
  for (const g of ARENA.bushes) {
    const cx = g.x + g.w / 2, cy = g.y + g.h / 2, d = Math.hypot(cx - x, cy - y);
    if (d < bd) { bd = d; best = { x: cx, y: cy }; }
  }
  return best;
}
function updateBots(room) {
  const state = room.state, b = state.ball;
  const carrier = b.owner ? state.players[b.owner] : null;
  const players = Object.values(state.players);
  for (const p of players) {
    if (!p.isBot) continue;
    const oppGoalX = p.team === 'A' ? FIELD.W : 0;
    const ownGoalX = p.team === 'A' ? 0 : FIELD.W;
    const goalY = FIELD.H / 2;
    const mate = players.find((q) => q.team === p.team && q.id !== p.id);
    const distBall = Math.hypot(b.x - p.x, b.y - p.y);
    const mateDistBall = mate ? Math.hypot(b.x - mate.x, b.y - mate.y) : 1e9;
    const iAmClosest = distBall <= mateDistBall;
    let moveX = 0, moveY = 0, aimX = p.aimX, aimY = p.aimY, shoot = false, special = false, build = false, charge = 0;

    if (b.owner === p.id) {
      // Carrying: drive at goal; shoot when close; sometimes pass to a better-placed mate.
      const distGoal = Math.hypot(oppGoalX - p.x, goalY - p.y);
      moveX = oppGoalX - p.x; moveY = goalY - p.y;
      aimX = oppGoalX - p.x; aimY = goalY - p.y;
      if (distGoal < 320) { shoot = true; charge = 1; }
      else if (mate) {
        const mateDistGoal = Math.hypot(oppGoalX - mate.x, goalY - mate.y);
        if (mateDistGoal < distGoal - 50 && Math.hypot(mate.x - p.x, mate.y - p.y) < 380 && Math.random() < 0.05) {
          aimX = mate.x - p.x; aimY = mate.y - p.y; shoot = true; charge = 0.5;
        }
      }
    } else if (carrier && carrier.team === p.team) {
      // Teammate carries: get open ahead as a passing option.
      moveX = oppGoalX - p.x; moveY = (goalY + (p.slot === 0 ? -130 : 130)) - p.y;
      aimX = oppGoalX - p.x; aimY = goalY - p.y;
    } else if (carrier) {
      // Enemy carries. Closer bot presses (spray + bomb); the other drops back and
      // lurks in a bush near its own goal to ambush.
      const threat = Math.abs(carrier.x - ownGoalX) < FIELD.W * 0.5;
      if (iAmClosest || distBall < 260) {
        moveX = carrier.x - p.x; moveY = carrier.y - p.y;
        aimX = carrier.x - p.x; aimY = carrier.y - p.y;
        if (distBall < 430) { shoot = true; charge = 1; }                              // spray to knock it loose
        if (distBall < 210 && p.specialCd <= 0 && Math.random() < 0.035) special = true; // bomb the carrier
      } else {
        const bush = nearestBush(ownGoalX + (p.team === 'A' ? 320 : -320), goalY);
        const tx = bush ? bush.x : ownGoalX + (p.team === 'A' ? 280 : -280);
        const ty = bush ? bush.y : goalY + (p.slot === 0 ? -120 : 120);
        moveX = tx - p.x; moveY = ty - p.y;
        aimX = carrier.x - p.x; aimY = carrier.y - p.y;
      }
      // Throw up a defensive wall between the goal and the incoming carrier.
      if (threat && p.buildAmmo >= 1 && p.buildCd <= 0 &&
          Math.abs(p.x - ownGoalX) <= Math.abs(carrier.x - ownGoalX) + 90 && Math.random() < 0.02) {
        build = true; aimX = carrier.x - p.x; aimY = carrier.y - p.y; shoot = false; special = false;
      }
    } else {
      // Loose ball. Closest bot chases; the other lurks in the nearest bush.
      if (iAmClosest) {
        moveX = b.x - p.x; moveY = b.y - p.y;
        aimX = oppGoalX - p.x; aimY = goalY - p.y;
      } else {
        const bush = nearestBush(p.x, p.y);
        const tx = bush ? bush.x : FIELD.W / 2;
        const ty = bush ? bush.y : goalY + (p.slot === 0 ? -140 : 140);
        moveX = tx - p.x; moveY = ty - p.y;
        aimX = b.x - p.x; aimY = b.y - p.y;
      }
    }

    const mLen = Math.hypot(moveX, moveY) || 1;
    const [mvx, mvy] = avoidWalls(p.x, p.y, moveX / mLen, moveY / mLen);
    const aLen = Math.hypot(aimX, aimY) || 1;
    room.inputs.set(p.id, {
      seq: (room.inputs.get(p.id)?.seq || 0) + 1,
      moveX: mvx, moveY: mvy,
      aimX: aimX / aLen, aimY: aimY / aLen,
      shoot, special, build, charge,
    });
  }
}

// ---------------------------------------------------------------------------
// Room membership + matchmaking
// ---------------------------------------------------------------------------
function addToRoom(member, room) {
  member.room = room;
  member.team = balancedTeam(room);
  member.inMatch = false; member.afk = false;
  room.members.add(member);
}

function quickMatch(member) {
  leaveCurrentRoom(member);
  // Join the forming public room if there's space & it hasn't started; else open one.
  if (!publicRoom || publicRoom.phase === 'match' || publicRoom.members.size >= MAX_PLAYERS) {
    publicRoom = makeRoom(`pub-${++roomCounter}`, false);
    rooms.set(publicRoom.id, publicRoom);
  }
  const room = publicRoom;
  addToRoom(member, room);
  send(member.ws, { type: 'roomJoined', mode: 'quick', code: null });
  if (room.phase === 'lobby') startCountdown(room); // quick match: joining kicks off the countdown
  broadcastLobby(room);
}

function createPrivateRoom(member) {
  leaveCurrentRoom(member);
  const room = makeRoom(genCode(), true);
  rooms.set(room.id, room);
  addToRoom(member, room);
  send(member.ws, { type: 'roomJoined', mode: 'private', code: room.id });
  broadcastLobby(room);
}

function joinPrivateRoom(member, code) {
  const room = rooms.get((code || '').toUpperCase());
  if (!room || !room.isPrivate) { send(member.ws, { type: 'roomError', msg: 'Room not found' }); return; }
  if (room.phase === 'match') { send(member.ws, { type: 'roomError', msg: 'Match already in progress' }); return; }
  if (room.members.size >= MAX_PLAYERS) { send(member.ws, { type: 'roomError', msg: 'Room is full' }); return; }
  leaveCurrentRoom(member);
  addToRoom(member, room);
  send(member.ws, { type: 'roomJoined', mode: 'private', code: room.id });
  broadcastLobby(room);
}

// Remove a member from their room; clean up / keep the match alive as needed.
function leaveCurrentRoom(member) {
  const room = member.room;
  if (!room) return;
  const wasInMatch = member.inMatch;
  room.members.delete(member);
  member.room = null; member.inMatch = false;
  if (wasInMatch && room.phase === 'match') {
    if (room.state.players[member.id]) { removePlayer(room.state, member.id); room.inputs.delete(member.id); }
    fillBots(room);
    if (humansInRoom(room) === 0) endRoom(room);
  }
  if (room.members.size === 0) destroyRoom(room);
  else broadcastLobby(room);
}

function destroyRoom(room) {
  rooms.delete(room.id);
  if (publicRoom === room) publicRoom = null;
}

function startCountdown(room) {
  room.phase = 'countdown';
  room.countdownT = COUNTDOWN_TIME;
  broadcastLobby(room);
}

// Everyone still in the room (not already playing) starts the match, honouring
// chosen teams (up to 2 each); empty slots become bots.
function startMatch(room) {
  const humans = [...room.members].filter((m) => !m.inMatch).slice(0, MAX_PLAYERS);
  if (humans.length === 0) { endRoom(room); return; }

  room.state = createState();
  room.inputs.clear();
  room.botCounter = 0;

  const teamSlots = { A: [0, 1], B: [0, 1] };
  const assigned = [];
  for (const m of humans) { // first pass — honour chosen team when a slot is free
    const t = m.team === 'B' ? 'B' : 'A';
    if (teamSlots[t].length) assigned.push([m, t, teamSlots[t].shift()]);
    else assigned.push([m, null, null]);
  }
  for (const a of assigned) { // overflow -> any open slot
    if (a[1]) continue;
    const t = teamSlots.A.length ? 'A' : 'B';
    a[1] = t; a[2] = teamSlots[t].shift();
  }
  // Roster for the team-intro overlay: every human, their team + album (cards).
  const roster = assigned.map(([m, team]) => ({ id: m.id, name: m.name, avatar: m.avatar || null, team, cards: m.cards || [] }));
  for (const [m, team, slot] of assigned) {
    addPlayer(room.state, m.id, { name: m.name, char: DEFAULT_CHAR, team, slot, isBot: false });
    room.inputs.set(m.id, emptyInput());
    m.team = team; m.inMatch = true; m.afk = false; m.lastInputAt = nowMs();
    send(m.ws, { type: 'matchStart', playerId: m.id, team, field: FIELD, chars: CHARACTERS, settings: room.state.settings, players: roster });
  }
  fillBots(room);
  attachBall(room.state, Math.random() < 0.5 ? 'A' : 'B');
  room.endHoldT = 0;
  room.phase = 'match';
  if (publicRoom === room) publicRoom = null; // next quick-matchers form a fresh room
  broadcastLobby(room);
}

// Match over (time up, or last human left). Public rooms dissolve -> home;
// private rooms return to their lobby so friends can rematch with the same code.
function endRoom(room) {
  const hadHumans = [...room.members];
  if (room.isPrivate && room.members.size > 0) {
    room.phase = 'lobby'; room.countdownT = 0; room.endHoldT = 0;
    room.state = createState(); room.inputs.clear(); room.botCounter = 0;
    for (const m of room.members) { m.inMatch = false; m.afk = false; }
    for (const m of room.members) send(m.ws, { type: 'toLobby' });
    broadcastLobby(room);
  } else {
    for (const m of hadHumans) { m.room = null; m.inMatch = false; send(m.ws, { type: 'toHome', online: onlineCount() }); }
    destroyRoom(room);
  }
}

function checkAfk(room) {
  const t = nowMs();
  for (const m of room.members) {
    if (!m.inMatch || m.afk) continue;
    const p = room.state.players[m.id];
    if (!p) continue;
    if (t - m.lastInputAt > AFK_SECONDS * 1000) { m.afk = true; p.isBot = true; }
  }
}
function humansInRoom(room) {
  let n = 0;
  for (const m of room.members) if (m.inMatch) n++;
  return n;
}

// ---------------------------------------------------------------------------
// Per-room tick
// ---------------------------------------------------------------------------
function tickRoom(room) {
  if (room.phase === 'countdown') {
    room.countdownT -= DT;
    if (room.countdownT <= 0) startMatch(room);
    return;
  }
  if (room.phase !== 'match') return;
  checkAfk(room);
  updateBots(room);
  const inputMap = {};
  for (const [id, inp] of room.inputs) inputMap[id] = inp;
  step(room.state, inputMap, DT);
  for (const inp of room.inputs.values()) { inp.shoot = false; inp.special = false; inp.build = false; inp.charge = 0; }
  if (room.state.phase === 'ended') {
    room.endHoldT += DT;
    if (room.endHoldT >= ENDED_HOLD) endRoom(room);
  } else if (humansInRoom(room) === 0) {
    endRoom(room);
  }
}

function tickAll() {
  try {
    for (const room of [...rooms.values()]) tickRoom(room);
  } catch (e) { if (tickErrCount++ < 5) console.error('TICK ERROR:', (e && e.stack) || e); }
}

// ---------------------------------------------------------------------------
// Snapshots + lobby/home presence
// ---------------------------------------------------------------------------
function snapshot(room) {
  const state = room.state;
  const r1 = (v) => Math.round(v * 10) / 10;
  const players = Object.values(state.players).map((p) => ({
    id: p.id, name: p.name, char: p.char, team: p.team,
    x: r1(p.x), y: r1(p.y),
    vx: r1(p.vx + p.kvx), vy: r1(p.vy + p.kvy),
    aimX: Math.round(p.aimX * 100) / 100, aimY: Math.round(p.aimY * 100) / 100,
    firing: p.firing, lastSeq: p.lastSeq,
    ammo: p.ammo, reloading: p.reloadLock > 0,
    reloadFrac: Math.round(100 * (p.reloadLock > 0
      ? 1 - p.reloadLock / EMPTY_RELOAD
      : (p.ammo < MAG_SIZE ? p.ammoT / AMMO_REGEN : 0))) / 100,
    buildAmmo: p.buildAmmo,
    buildFrac: Math.round(100 * (p.buildAmmo < BUILD_MAG ? p.buildAmmoT / BUILD_RELOAD : 0)) / 100,
  }));
  return {
    type: 'snapshot',
    tick: state.tick, phase: state.phase, elapsed: Math.floor(state.elapsed),
    resetTimer: state.resetTimer, lastGoal: state.lastGoal, score: state.score,
    ball: { x: r1(state.ball.x), y: r1(state.ball.y), owner: state.ball.owner },
    players,
    projectiles: state.projectiles.map((p) => ({ id: p.id, x: r1(p.x), y: r1(p.y), team: p.team })),
    walls: state.builtWalls.map((w) => ({ id: w.id, x: w.x, y: w.y, w: w.w, h: w.h, hp: w.hp, maxHp: w.maxHp, team: w.team })),
    bombs: state.bombs.map((b) => ({ id: b.id, x: r1(b.x), y: r1(b.y), team: b.team, fuse: Math.round(b.fuse * 100) / 100 })),
    blasts: state.blasts.map((b) => ({ id: b.id, x: r1(b.x), y: r1(b.y), radius: b.radius, life: b.life, maxLife: b.maxLife })),
    impacts: state.impacts.map((i) => ({ id: i.id, type: i.type, target: i.target, team: i.team, x: r1(i.x), y: r1(i.y), dx: i.dx, dy: i.dy, life: i.life, maxLife: i.maxLife })),
  };
}

function broadcastSnapshots() {
  try {
    for (const room of rooms.values()) {
      if (room.phase !== 'match') continue;
      const msg = JSON.stringify(snapshot(room));
      for (const m of room.members) {
        if (m.inMatch && m.ws.readyState === m.ws.OPEN) { try { m.ws.send(msg); } catch { /* dead socket */ } }
      }
    }
  } catch (e) { if (bcErrCount++ < 5) console.error('BROADCAST ERROR:', (e && e.stack) || e); }
}

function lobbyPayload(room) {
  const list = [...room.members].map((m) => ({ id: m.id, name: m.name, avatar: m.avatar || null, team: m.team, inMatch: m.inMatch, cards: m.cards || [] }));
  return {
    type: 'lobby',
    mode: room.isPrivate ? 'private' : 'quick',
    code: room.isPrivate ? room.id : null,
    phase: room.phase,
    countdown: room.phase === 'countdown' ? Math.max(0, Math.ceil(room.countdownT)) : 0,
    online: onlineCount(),
    members: list,
  };
}
function broadcastLobby(room) {
  const payload = lobbyPayload(room);
  for (const m of room.members) if (!m.inMatch) send(m.ws, payload);
}

// 5Hz presence: home count to roomless clients, lobby state to waiting room members.
function broadcastPresence() {
  const online = onlineCount();
  for (const m of members.values()) {
    if (!m.room) send(m.ws, { type: 'home', online });
  }
  for (const room of rooms.values()) {
    if (room.phase !== 'match') broadcastLobby(room);
  }
}

setInterval(tickAll, 1000 / TICK_RATE);
setInterval(broadcastSnapshots, 1000 / SNAPSHOT_RATE);
setInterval(broadcastPresence, 200);

// Sanitize the album handed over from the app (join.cards): a compact, non-PII list
// [{r,n,c,w}]. Validate rarity/number, clamp copies/worth, cap the length.
const CARD_RARITIES = ['common', 'rare', 'epic', 'legendary'];
function sanitizeCards(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const card of raw) {
    if (!card || !CARD_RARITIES.includes(card.r)) continue;
    const n = Math.trunc(Number(card.n));
    if (!Number.isFinite(n) || n < 1 || n > 200) continue;
    out.push({
      r: card.r, n,
      c: Math.max(1, Math.min(99, Math.trunc(Number(card.c)) || 1)),
      w: Math.max(0, Number(card.w) || 0),
    });
    if (out.length >= 256) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// WebSocket handling
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let member = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    try {
      if (msg.type === 'join') {
        if (member) return;
        const id = `m-${++memberCounter}`;
        const name = (msg.name || 'Player').toString().slice(0, 16);
        let avatar = (msg.avatar || '').toString().slice(0, 400) || null;
        if (avatar && avatar.startsWith('http://')) avatar = 'https://' + avatar.slice(7);
        member = { id, ws, name, avatar, cards: sanitizeCards(msg.cards), team: 'A', inMatch: false, afk: false, lastInputAt: nowMs(), room: null };
        members.set(ws, member);
        send(ws, { type: 'welcome', id, field: FIELD, chars: CHARACTERS });
        send(ws, { type: 'home', online: onlineCount() });
        return;
      }
      if (!member) return;

      if (msg.type === 'quickMatch') { quickMatch(member); return; }
      if (msg.type === 'createRoom') { createPrivateRoom(member); return; }
      if (msg.type === 'joinRoom') { joinPrivateRoom(member, msg.code); return; }
      if (msg.type === 'leaveRoom') {
        leaveCurrentRoom(member);
        send(ws, { type: 'toHome', online: onlineCount() });
        return;
      }

      const room = member.room;
      if (msg.type === 'setTeam') {
        // Team picking only in a private room's lobby.
        if (!room || !room.isPrivate || member.inMatch || room.phase === 'match') return;
        if (msg.team === 'A' || msg.team === 'B') { member.team = msg.team; broadcastLobby(room); }
        return;
      }
      if (msg.type === 'ready') { // "Play Now" in a private room
        if (!room || member.inMatch) return;
        if (room.phase === 'lobby') startCountdown(room);
        return;
      }
      if (msg.type === 'input') {
        if (!room || !member.inMatch) return;
        const active = (Math.abs(msg.moveX || 0) + Math.abs(msg.moveY || 0) > 0.1) || !!msg.shoot || !!msg.special || !!msg.build;
        if (active) {
          member.lastInputAt = nowMs();
          if (member.afk) { member.afk = false; const p = room.state.players[member.id]; if (p) p.isBot = false; }
        }
        const prev = room.inputs.get(member.id) || {};
        let charge = prev.charge || 0;
        if (msg.shoot) charge = msg.charge || 0;
        room.inputs.set(member.id, {
          seq: msg.seq, moveX: msg.moveX || 0, moveY: msg.moveY || 0, aimX: msg.aimX || 0, aimY: msg.aimY || 0,
          shoot: prev.shoot || !!msg.shoot, special: prev.special || !!msg.special, build: prev.build || !!msg.build, charge,
        });
        return;
      }
      if (msg.type === 'settings' && msg.settings && room) { applySettings(room, msg.settings); return; }
      if (msg.type === 'ping') { send(ws, { type: 'pong', t: msg.t }); return; }
    } catch (e) { if (msgErrCount++ < 5) console.error('MSG ERROR:', (e && e.stack) || e); }
  });

  ws.on('close', () => {
    if (!member) return;
    members.delete(ws);
    leaveCurrentRoom(member);
  });
});

server.listen(PORT, () => {
  console.log(`\n⚽ Football mock running:`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   Home -> Quick Match (public room) or Play With Friends (private code room).\n`);
});
