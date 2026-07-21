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
  TICK_RATE, DT, SNAPSHOT_RATE, MAX_PLAYERS, FIELD, GOAL, CHARACTERS, DEFAULT_CHAR, ENDED_HOLD, INTRO_PROMO,
  MAG_SIZE, AMMO_REGEN, EMPTY_RELOAD, BUILD_MAG, BUILD_RELOAD,
} from './shared/constants.js';
import { ARENA } from './shared/arena.js';
import { encodeKeyframe } from './shared/wire.js';
import { normalizeCosmetic, randomBotCosmetic, DEFAULT_COSMETIC } from './shared/cosmetics.js';
const BACKPRESSURE_LIMIT = 64 * 1024; // drop a snapshot to a client whose send buffer is backed up (slow/backgrounded)
import { computeBotInputs, createBotMemory } from './shared/bot-ai.js';
import { PEN, CENTER, TRAIN_ARENA, penDummy, trainingDummyInput, createSentryMem, trainingSentryInput, leashSentry } from './shared/training.js';

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
// Module-level monotonic match counter — never resets, so matchId is globally unique even when a
// private room CODE is reused by a later room instance (a per-room counter would collide and the
// backend's recordedMatchIds idempotency guard could silently drop a legit match).
let matchSeq = 0;
let msgErrCount = 0, tickErrCount = 0, bcErrCount = 0;

const nowMs = () => Date.now();
// member = { id, ws, name, avatar, team, inMatch, afk, lastInputAt, room }

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) { try { ws.send(JSON.stringify(obj)); } catch { /* dead socket */ } }
}
function onlineCount() { return members.size; }

function makeRoom(id, isPrivate, mode = 'match') {
  return {
    id, isPrivate: !!isPrivate,
    mode,                    // 'match' | 'training' (solo practice vs a penned dummy)
    phase: 'lobby',          // lobby | countdown | match
    countdownT: 0, endHoldT: 0, introT: 0,
    state: createState(),
    inputs: new Map(),       // playerId -> input
    botMem: createBotMemory(), // persistent bot-AI memory (roles, aim, beliefs)
    botCounter: 0,
    matchCounter: 0,         // increments each match — feeds the stable per-match id
    members: new Set(),      // member objects
    slotIds: null, slotTeam: null, rosterVersion: 0, // binary-snapshot slot->id/team mapping
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
  return { seq: 0, moveX: 0, moveY: 0, aimX: 0, aimY: 0, hold: false, fire: false, special: false, build: false };
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
  if (room.mode === 'training') return; // training has its own fixed dummy + sentry — no backfill
  const teamCount = (t) => Object.values(room.state.players).filter((p) => p.team === t).length;
  const usedSlots = (t) => new Set(Object.values(room.state.players).filter((p) => p.team === t).map((p) => p.slot));
  while (Object.keys(room.state.players).length < MAX_PLAYERS) {
    const team = teamCount('A') <= teamCount('B') ? 'A' : 'B';
    const slot = usedSlots(team).has(0) ? 1 : 0;
    const id = `bot-${room.id}-${++room.botCounter}`;
    addPlayer(room.state, id, { name: 'Bot', char: DEFAULT_CHAR, team, slot, isBot: true, cosmetic: randomBotCosmetic() });
    room.inputs.set(id, emptyInput());
  }
}

// ---------------------------------------------------------------------------
// Bot AI (per room) — delegates to the shared, testable controller in
// shared/bot-ai.js (team coordinator + utility action selection + context
// steering + fog-of-war stealth + skill/latency). Tests: test-bot-ai.mjs; A/B: bot-eval.mjs.
// ---------------------------------------------------------------------------
function updateBots(room) {
  const inputs = computeBotInputs(room.state, room.botMem, DT);
  for (const id in inputs) room.inputs.set(id, inputs[id]);
}

// Training ground: drive the penned dummy from the shared, testable controller.
function updateTrainingDummy(room) {
  const dummy = trainingDummyInput(room.state, room.dummyId);
  if (dummy) room.inputs.set(room.dummyId, dummy);
  const sentry = trainingSentryInput(room.state, room.sentryId, room.sentryMem, DT);
  if (sentry) room.inputs.set(room.sentryId, sentry);
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
  // Room is full (all human slots taken) -> start now; no point waiting out the countdown.
  if (room.members.size >= MAX_PLAYERS) { startMatch(room); return; }
  if (room.phase === 'lobby') startCountdown(room); // first in: open the 5s matchmaking window
  broadcastLobby(room);
}

// Solo training ground: instant entry, no lobby/countdown, endless clock, and
// two enemies — a penned roaming dummy by the far goal + a midfield sentry that
// fires at you. Reuses the whole match render/snapshot pipeline.
function startTraining(member) {
  leaveCurrentRoom(member);
  const room = makeRoom(`train-${++roomCounter}`, false, 'training');
  rooms.set(room.id, room);
  addToRoom(member, room);

  room.state = createState();
  room.state.noClock = true;      // never transitions to 'ended'
  room.state.arena = TRAIN_ARENA; // custom field: top-left bush + bottom-right steel wall
  room.inputs.clear();
  room.botCounter = 0;

  // You are team A (spawn left, attack the right goal).
  addPlayer(room.state, member.id, { name: member.name, char: DEFAULT_CHAR, team: 'A', slot: 0, isBot: false, cosmetic: member.cosmetic || DEFAULT_COSMETIC });
  room.inputs.set(member.id, emptyInput());
  member.team = 'A'; member.inMatch = true; member.afk = false; member.lastInputAt = nowMs();

  // One penned dummy on team B, in front of the right goal.
  const dummyId = `dummy-${room.id}`;
  addPlayer(room.state, dummyId, { name: 'Target', char: DEFAULT_CHAR, team: 'B', slot: 0, isBot: true, cosmetic: randomBotCosmetic() });
  room.inputs.set(dummyId, emptyInput());
  room.dummyId = dummyId;
  const d = room.state.players[dummyId];
  d.x = (PEN.x0 + PEN.x1) / 2; d.y = FIELD.H / 2; // start centred in the pen

  // One "sentry" enemy at midfield: holds the centre, always aims at you, fires
  // in random bursts. Not penned — it just steers back to CENTER if shoved.
  const sentryId = `sentry-${room.id}`;
  addPlayer(room.state, sentryId, { name: 'Sentry', char: DEFAULT_CHAR, team: 'B', slot: 1, isBot: true, cosmetic: randomBotCosmetic() });
  room.inputs.set(sentryId, emptyInput());
  room.sentryId = sentryId;
  room.sentryMem = createSentryMem();
  const sen = room.state.players[sentryId];
  sen.x = CENTER.x; sen.y = CENTER.y;

  const matchId = `${room.id}-${++matchSeq}`;
  const roster = [{ id: member.id, name: member.name, avatar: member.avatar || null, team: 'A', cards: member.cards || [] }];
  attachBall(room.state, 'A');
  room.endHoldT = 0;
  room.phase = 'match';
  send(member.ws, { type: 'roomJoined', mode: 'training', code: null });
  send(member.ws, { type: 'matchStart', mode: 'training', matchId, playerId: member.id, team: 'A', field: FIELD, chars: CHARACTERS, settings: room.state.settings, players: roster });
  room.rosterVersion++; broadcastRoster(room);
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
  if (!room || !room.isPrivate) { send(member.ws, { type: 'roomError', msg: 'החדר לא נמצא' }); return; }
  if (room.phase === 'match') { send(member.ws, { type: 'roomError', msg: 'המשחק כבר התחיל' }); return; }
  if (room.members.size >= MAX_PLAYERS) { send(member.ws, { type: 'roomError', msg: 'החדר מלא' }); return; }
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
    else if (room.phase === 'match') { room.rosterVersion++; broadcastRoster(room); } // a bot backfilled a slot
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
  room.botMem = createBotMemory(room.botDifficulty);
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
  // Stable per-match id (roomId + GLOBAL monotonic match seq): unique per match instance across the
  // whole process — a reused private-room code can't collide with an earlier room's matchId — and
  // identical if the same matchStart is resent. Feeds matchResult idempotency downstream (app -> backend).
  const matchId = `${room.id}-${++matchSeq}`;
  // Roster for the team-intro overlay: every human, their team + album (cards).
  const roster = assigned.map(([m, team]) => ({ id: m.id, name: m.name, avatar: m.avatar || null, team, cards: m.cards || [], cosmetic: m.cosmetic || DEFAULT_COSMETIC }));
  const introMs = Math.round(INTRO_PROMO * 1000);
  for (const [m, team, slot] of assigned) {
    addPlayer(room.state, m.id, { name: m.name, char: DEFAULT_CHAR, team, slot, isBot: false, cosmetic: m.cosmetic || DEFAULT_COSMETIC });
    room.inputs.set(m.id, emptyInput());
    m.team = team; m.inMatch = true; m.afk = false; m.lastInputAt = nowMs();
    send(m.ws, { type: 'matchStart', matchId, playerId: m.id, team, field: FIELD, chars: CHARACTERS, settings: room.state.settings, players: roster, intro: introMs });
  }
  fillBots(room);
  attachBall(room.state, Math.random() < 0.5 ? 'A' : 'B');
  room.endHoldT = 0;
  room.introT = INTRO_PROMO;   // hold the sim frozen while the client plays the promo (see tickRoom)
  room.phase = 'match';
  room.rosterVersion++; broadcastRoster(room); // slot->id map for binary snapshots — sent before any snapshot
  if (publicRoom === room) publicRoom = null; // next quick-matchers form a fresh room
  broadcastLobby(room);
}

// Match over (time up, or last human left). Public rooms dissolve -> home;
// private rooms return to their lobby so friends can rematch with the same code.
function endRoom(room) {
  const hadHumans = [...room.members];
  if (room.isPrivate && room.members.size > 0) {
    room.phase = 'lobby'; room.countdownT = 0; room.endHoldT = 0;
    room.state = createState(); room.botMem = createBotMemory(room.botDifficulty); room.inputs.clear(); room.botCounter = 0;
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
  if (room.introT > 0) {                    // pre-kickoff promo: freeze the sim so the clock + play wait for the cinematic
    room.introT -= DT;
    for (const inp of room.inputs.values()) { inp.fire = false; inp.special = false; inp.build = false; }
    return;                                 // snapshots keep broadcasting the frozen kickoff state
  }
  if (room.mode === 'training') {
    updateTrainingDummy(room);
  } else {
    checkAfk(room);
    updateBots(room);
  }
  const inputMap = {};
  for (const [id, inp] of room.inputs) inputMap[id] = inp;
  step(room.state, inputMap, DT);
  if (room.mode === 'training') {
    penDummy(room.state, room.dummyId);    // keep the dummy inside its pen after physics
    leashSentry(room.state, room.sentryId); // keep the sentry anchored to midfield
  }
  for (const inp of room.inputs.values()) { inp.fire = false; inp.special = false; inp.build = false; } // consume edges; hold persists as a level
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
    firing: p.firing, lastSeq: p.lastSeq, power: p.power,
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

// Roster: the slot->id/team mapping for the compact binary snapshots, sent as a JSON
// control frame whenever the player set changes (match start + mid-match bot backfill).
// TCP ordering guarantees it precedes the snapshots that reference its rosterVersion.
function broadcastRoster(room) {
  const ps = Object.values(room.state.players);
  room.slotIds = ps.map((p) => p.id);
  room.slotTeam = ps.map((p) => p.team);
  const payload = { type: 'roster', v: room.rosterVersion, slots: ps.map((p, i) => ({ i, id: p.id, team: p.team, c: p.cosmetic || DEFAULT_COSMETIC })) };
  for (const m of room.members) if (m.inMatch && m.ws.readyState === m.ws.OPEN) send(m.ws, payload);
}

function broadcastSnapshots() {
  try {
    for (const room of rooms.values()) {
      if (room.phase !== 'match' || !room.slotIds) continue;
      const buf = encodeKeyframe(snapshot(room), room.slotIds, room.rosterVersion); // compact binary, encoded once per room
      for (const m of room.members) {
        if (!m.inMatch || m.ws.readyState !== m.ws.OPEN) continue;
        if (m.ws.bufferedAmount > BACKPRESSURE_LIMIT) continue; // backpressure: drop a stale frame for a backed-up client
        try { m.ws.send(buf); } catch { /* dead socket */ }
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

// Card-powers loadout: 3 slots, each holding one owned card {r,n} (or null). Slot 0 =
// Shot, 1 = Speed, 2 = Utility. Validate every slotted card is actually IN the member's
// sanitized album (drop anything not owned) — the client only says WHICH card in WHICH
// slot; the server owns rarity->strength so a client can't send an arbitrary buff.
function sanitizeLoadout(raw, memberCards) {
  const owned = Array.isArray(memberCards) ? memberCards : [];
  const pick = (slot) => {
    if (!slot || !CARD_RARITIES.includes(slot.r)) return null;
    const n = Math.trunc(Number(slot.n));
    if (!Number.isFinite(n) || n < 1 || n > 200) return null;
    return owned.some((c) => c.r === slot.r && c.n === n) ? { r: slot.r, n } : null;
  };
  const arr = Array.isArray(raw) ? raw : [];
  return [pick(arr[0]), pick(arr[1]), pick(arr[2])];
}

// Rarity -> buff percentage ("album matters"). Server derives this from its OWN card
// record — NEVER a client-sent %. Empty slot => neutral (0% => 1.0 multiplier).
const RARITY_BUFF_PCT = { legendary: 0.20, epic: 0.12, rare: 0.07, common: 0.03 };
const pctOf = (slot) => (slot ? (RARITY_BUFF_PCT[slot.r] || 0) : 0);
// Turn a sanitized loadout into the sim multipliers addPlayer understands.
// Shot: faster charge = 1/(1-p). Speed: +p. Utility: shorter cooldowns = (1-p).
function buffsFromLoadout(loadout) {
  const L = Array.isArray(loadout) ? loadout : [];
  const shot = pctOf(L[0]), speed = pctOf(L[1]), util = pctOf(L[2]);
  return { chargeRate: 1 / (1 - shot), speedBuff: 1 + speed, cdMul: 1 - util };
}

// ---------------------------------------------------------------------------
// WebSocket handling
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  let member = null;
  try { req.socket.setNoDelay(true); } catch { /* disable Nagle so tiny 60Hz frames aren't batched */ }

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
        const cards = sanitizeCards(msg.cards);
        member = { id, ws, name, avatar, cards, loadout: sanitizeLoadout(msg.loadout, cards), cosmetic: normalizeCosmetic(msg.cosmetic), team: 'A', inMatch: false, afk: false, lastInputAt: nowMs(), room: null };
        members.set(ws, member);
        send(ws, { type: 'welcome', id, field: FIELD, chars: CHARACTERS });
        send(ws, { type: 'home', online: onlineCount() });
        return;
      }
      if (!member) return;

      // Cosmetic (hero+skin) chosen on the home screen; applied at the next match start.
      if (msg.type === 'setCosmetic') { member.cosmetic = normalizeCosmetic(msg.cosmetic); return; }
      // Card-powers loadout chosen on the home screen; validated vs the member's album,
      // baked into buffs at the next match start.
      if (msg.type === 'setLoadout') { member.loadout = sanitizeLoadout(msg.loadout, member.cards); return; }
      if (msg.type === 'quickMatch') { quickMatch(member); return; }
      if (msg.type === 'training') { startTraining(member); return; }
      if (msg.type === 'resetBall') { // training only: recenter the ball on demand
        const r = member.room;
        if (r && r.mode === 'training' && r.phase === 'match') attachBall(r.state, member.team);
        return;
      }
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
        const active = (Math.abs(msg.moveX || 0) + Math.abs(msg.moveY || 0) > 0.1) || !!msg.hold || !!msg.fire || !!msg.special || !!msg.build;
        if (active) {
          member.lastInputAt = nowMs();
          if (member.afk) { member.afk = false; const p = room.state.players[member.id]; if (p) p.isBot = false; }
        }
        const prev = room.inputs.get(member.id) || {};
        room.inputs.set(member.id, {
          seq: msg.seq, moveX: msg.moveX || 0, moveY: msg.moveY || 0, aimX: msg.aimX || 0, aimY: msg.aimY || 0,
          // hold = a level signal (charging now); fire = an EDGE (release), latched
          // sticky until the next tick consumes it so a fire between ticks isn't lost.
          hold: !!msg.hold, fire: prev.fire || !!msg.fire,
          special: prev.special || !!msg.special, build: prev.build || !!msg.build,
        });
        return;
      }
      if (msg.type === 'settings' && room) {
        if (msg.settings) applySettings(room, msg.settings);
        if (['easy', 'normal', 'hard'].includes(msg.botDifficulty)) {
          room.botDifficulty = msg.botDifficulty;
          if (room.botMem) room.botMem.skill = msg.botDifficulty; // live — read each tick by the bot AI
        }
        return;
      }
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
