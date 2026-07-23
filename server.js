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
  createState, addPlayer, removePlayer, step, attachBall, setField,
} from './shared/sim.js';
import {
  TICK_RATE, DT, SNAPSHOT_RATE, MAX_PLAYERS, FIELD, GOAL, CHARACTERS, DEFAULT_CHAR, ENDED_HOLD, INTRO_PROMO,
  MAG_SIZE, AMMO_REGEN, EMPTY_RELOAD, BUILD_MAG, BUILD_RELOAD,
} from './shared/constants.js';
import { ARENA } from './shared/arena.js';
import { encodeKeyframe } from './shared/wire.js';
import { normalizeCosmetic, randomBotCosmetic, DEFAULT_COSMETIC, HERO_KEYS, SKIN_KEYS } from './shared/cosmetics.js';
import { verifyFootballToken } from './shared/football-auth.js';
const BACKPRESSURE_LIMIT = 64 * 1024; // drop a snapshot to a client whose send buffer is backed up (slow/backgrounded)
import { computeBotInputs, createBotMemory } from './shared/bot-ai.js';
import { DIFFICULTY_LEVELS, DEFAULT_LEVEL, clampLevel, levelAt, levelFromLegacy, xpForBotLevel, displayLevelForBot } from './shared/difficulty.js';
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
const FOOTBALL_TOKEN_SECRET = process.env.FOOTBALL_TOKEN_SECRET || null;
const onlineByUser = new Map(); // userId -> member (authenticated connections only)
const challenges = new Map(); // challengeId -> { fromUserId, toUserId }
let challengeCounter = 0;
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
    diffLevel: DEFAULT_LEVEL,   // difficulty ladder index (enemy + partner skill) — see shared/difficulty.js
    botCounter: 0,
    matchCounter: 0,         // increments each match — feeds the stable per-match id
    hostId: null,            // member.id of a private room's creator/HOST — only they may accept/reject/kick
    pending: new Map(),      // memberId -> member awaiting the host's approval to join (private rooms)
    invited: new Set(),      // userIds the host invited to the party — they auto-admit (no approval step)
    lobbyBots: [],           // bots invited from the friends list — shown in the lobby, become match bots at kickoff
    members: new Set(),      // member objects
    slotIds: null, slotTeam: null, rosterVersion: 0, // binary-snapshot slot->id/team mapping
  };
}

// Private-room codes are 3-digit numeric strings "000".."999" (zero-padded), unique among ALL active
// rooms (public "pub-*" / training "train-*" ids can never collide with a 3-digit code). Returns null
// only if all 1000 codes are somehow taken.
function genCode() {
  for (let tries = 0; tries < 4000; tries++) {
    const code = String(Math.floor(Math.random() * 1000)).padStart(3, '0');
    if (!rooms.has(code)) return code;
  }
  return null;
}
// Normalize a user-typed join code to the stored 3-digit form: keep digits, pad to 3 ("7" -> "007").
// Empty -> '' (never matches). A >3-digit string is returned as-is (also won't match a real code).
function normalizeRoomCode(raw) {
  const digits = String(raw == null ? '' : raw).replace(/\D/g, '');
  if (!digits) return '';
  return digits.length <= 3 ? digits.padStart(3, '0') : digits;
}

function emptyInput() {
  return { seq: 0, moveX: 0, moveY: 0, aimX: 0, aimY: 0, hold: false, fire: false, special: false, build: false, buildHold: false, sax: 0, say: 0 };
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
  for (const b of (room.lobbyBots || [])) (b.team === 'B' ? B++ : A++);
  return A <= B ? 'A' : 'B';
}
// Keep humans + invited lobby bots within the room cap (drop excess bots when humans arrive).
function trimLobbyBots(room) {
  while (room.lobbyBots.length && room.members.size + room.lobbyBots.length > MAX_PLAYERS) room.lobbyBots.pop();
}

// req6 — a match bot is drawn only UP TO the highest hero tier any human in the room has
// selected (HERO_KEYS = the rarity ladder striker→alien). Below the cap it's uniform; very
// rarely (1/20) one tier ABOVE the cap, clamped at alien. Skin stays random. Empty room ⇒ striker cap.
function botCosmeticForRoom(room, rand = Math.random) {
  let maxIdx = 0;
  for (const m of (room.members || [])) {
    if (m.inMatch) continue;
    const i = HERO_KEYS.indexOf(normalizeCosmetic(m.cosmetic).split(':')[0]);
    if (i > maxIdx) maxIdx = i;
  }
  const top = HERO_KEYS.length - 1;
  const heroIdx = (rand() < 1 / 20 && maxIdx < top) ? maxIdx + 1 : Math.floor(rand() * (maxIdx + 1));
  return `${HERO_KEYS[heroIdx]}:${SKIN_KEYS[Math.floor(rand() * SKIN_KEYS.length)]}`;
}

function fillBots(room, rosterOut) {
  if (room.mode === 'training') return; // training has its own fixed dummy + sentry — no backfill
  const teamCount = (t) => Object.values(room.state.players).filter((p) => p.team === t).length;
  const usedSlots = (t) => new Set(Object.values(room.state.players).filter((p) => p.team === t).map((p) => p.slot));
  // #18 — consume the countdown PREVIEW plan (room.botPlan) so the bots that actually spawn keep the
  // team/slot/loadout/cosmetic the VS/countdown already showed (preview == match). Matched by
  // (team,slot); a leftover entry is reused in order, and with no plan we fall back to generating.
  const plan = Array.isArray(room.botPlan) ? room.botPlan.slice() : [];
  const takePlanned = (team, slot) => { let i = plan.findIndex((p) => p.team === team && p.slot === slot); if (i < 0) i = plan.length ? 0 : -1; return i >= 0 ? plan.splice(i, 1)[0] : null; };
  while (Object.keys(room.state.players).length < MAX_PLAYERS) {
    const team = teamCount('A') <= teamCount('B') ? 'A' : 'B';
    const slot = usedSlots(team).has(0) ? 1 : 0;
    const id = `bot-${room.id}-${++room.botCounter}`;
    const planned = takePlanned(team, slot);
    const cosmetic = (planned && planned.cosmetic) || botCosmeticForRoom(room);
    // Task 18 — a bot's CARDS mirror the humans: EXTREME bots keep a fixed strong 3-card loadout +
    // their movement-SPEED/power cheat; every other bot reuses its PREVIEWED loadout (or a fresh
    // RANDOM 1..human-equipped-count when no preview exists), and its buffs are DERIVED from that
    // same loadout (buffsFromLoadout) so what the intro/countdown shows == what the bot plays with.
    // A bot gets the EXTREME fixed loadout + cheat buffs only when ITS side is at the top of the
    // ladder: the partner scalar if this team holds a human, else the enemy scalar.
    const teamHasHuman = Object.values(room.state.players).some((p) => !p.isBot && p.team === team);
    const sideScalar = teamHasHuman ? levelAt(room.diffLevel).partner : levelAt(room.diffLevel).enemy;
    let loadout, buffs;
    if (sideScalar >= 0.95) {
      loadout = extremeBotLoadout();
      buffs = { cardShot: 1.4, speedBuff: 1.30, cardUtil: 0.65 };
    } else {
      loadout = planned ? planned.loadout : botLoadoutForLevel(room.diffLevel);
      buffs = buffsFromLoadout(loadout);
    }
    addPlayer(room.state, id, { name: 'Bot', char: DEFAULT_CHAR, team, slot, isBot: true, cosmetic, buffs });
    room.inputs.set(id, emptyInput());
    if (rosterOut) rosterOut.push({ id, name: 'Bot', avatar: null, team, cards: loadoutToCards(loadout), cosmetic, loadout, isBot: true });
  }
}

// ---------------------------------------------------------------------------
// Bot AI (per room) — delegates to the shared, testable controller in
// shared/bot-ai.js (team coordinator + utility action selection + context
// steering + fog-of-war stealth + skill/latency). Tests: test-bot-ai.mjs; A/B: bot-eval.mjs.
// ---------------------------------------------------------------------------
function updateBots(room) {
  applyTeamSkill(room); // set per-team difficulty (enemy vs partner) before deciding inputs
  const inputs = computeBotInputs(room.state, room.botMem, DT);
  for (const id in inputs) room.inputs.set(id, inputs[id]);
}
// Map the room's difficulty LEVEL to a per-team skill scalar: the team(s) holding a human get
// the PARTNER skill, the all-bot team gets the ENEMY skill. (No human on a team, e.g. pure-bot
// or training, is treated as an enemy side.) Read live each tick by the bot AI.
function applyTeamSkill(room) {
  const lvl = levelAt(room.diffLevel);
  const human = { A: false, B: false };
  for (const p of Object.values(room.state.players)) if (!p.isBot && (p.team === 'A' || p.team === 'B')) human[p.team] = true;
  room.botMem.teamSkill = { A: human.A ? lvl.partner : lvl.enemy, B: human.B ? lvl.partner : lvl.enemy };
}

// Training ground: drive the penned dummy from the shared, testable controller.
function updateTrainingDummy(room) {
  const dummy = trainingDummyInput(room.state, room.dummyId);
  if (dummy) room.inputs.set(room.dummyId, dummy);
  // Training sentry is the "enemy": map the level's ENEMY scalar to the sentry's easy/normal/hard tier.
  const et = levelAt(room.diffLevel).enemy;
  const sentryTier = et < 0.18 ? 'easy' : et < 0.66 ? 'normal' : 'hard';
  const sentry = trainingSentryInput(room.state, room.sentryId, room.sentryMem, DT, sentryTier);
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

// --- Host approval helpers (private rooms) --------------------------------------------------------
// The HOST is the member whose id === room.hostId. Only they may accept/reject/kick (enforced in the
// message handlers, never trusted from the client).
function hostMember(room) {
  if (!room || !room.hostId) return null;
  for (const m of room.members) if (m.id === room.hostId) return m;
  return null;
}
function notifyHost(room, payload) {
  const h = hostMember(room);
  if (h) send(h.ws, payload);
}
// A pending (un-admitted) joiner is dropped from its room's pending map + the host is told to remove
// the request row. Safe to call for a member with no pending request.
function clearPending(member) {
  const room = member.pendingRoom;
  if (!room) return;
  member.pendingRoom = null;
  room.pending.delete(member.id);
  notifyHost(room, { type: 'joinRequestCancelled', joinerId: member.id });
}
// The host left a still-populated room: hand host to any remaining member and repopulate that new
// host's pending-request UI so waiting joiners aren't stranded.
function transferHost(room) {
  const next = room.members.values().next().value;
  if (!next) return;
  room.hostId = next.id;
  for (const p of room.pending.values()) {
    send(next.ws, { type: 'joinRequest', joinerId: p.id, userId: p.userId || null, name: p.name, avatar: p.avatar || null, cosmetic: p.cosmetic || DEFAULT_COSMETIC, cards: p.cards || [] });
  }
}

function quickMatch(member, diffLevel) {
  leaveCurrentRoom(member);
  // Join the forming public room if there's space & it hasn't started; else open one.
  if (!publicRoom || publicRoom.phase === 'match' || publicRoom.members.size >= MAX_PLAYERS) {
    publicRoom = makeRoom(`pub-${++roomCounter}`, false);
    rooms.set(publicRoom.id, publicRoom);
  }
  const room = publicRoom;
  // Bots reflect the joining player's XP-driven level. Applied before the countdown/preview so the
  // VS badge + previewed bot cards match from the first tick. Shared public room => last-writer-wins.
  if (typeof diffLevel === 'number') room.diffLevel = clampLevel(diffLevel);
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
  addPlayer(room.state, member.id, { name: member.name, char: DEFAULT_CHAR, team: 'A', slot: 0, isBot: false, cosmetic: member.cosmetic || DEFAULT_COSMETIC, buffs: buffsFromLoadout(member.loadout) });
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

// Validate + clamp a client-supplied field layout (never trust the wire). Caps counts
// and clamps every number into the pitch / sane capsule sizes.
function sanitizeField(field) {
  if (!field || typeof field !== 'object') return null;
  const num = (v, lo, hi, d) => (typeof v === 'number' && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  const cap = (w) => ({
    cx: num(w && w.cx, 0, FIELD.W, FIELD.W / 2), cy: num(w && w.cy, 0, FIELD.H, FIELD.H / 2),
    angle: num(w && w.angle, -Math.PI * 2, Math.PI * 2, 0),
    hl: num(w && w.hl, 20, 300, 88), ht: num(w && w.ht, 8, 60, 16),
  });
  const arr = (a) => (Array.isArray(a) ? a : []);
  return {
    version: 1,
    bushes: arr(field.bushes).slice(0, 12).map((b) => ({ x: num(b && b.x, 0, FIELD.W, 0), y: num(b && b.y, 0, FIELD.H, 0), w: num(b && b.w, 40, 600, 200), h: num(b && b.h, 40, 600, 150) })),
    hardWalls: arr(field.hardWalls).slice(0, 20).map(cap),
    dryWalls: arr(field.dryWalls).slice(0, 20).map(cap),
  };
}

// Solo "play my field vs bots": instant, endless, custom field + backfilled bots (2v2).
function startBuilderMatch(member, field) {
  leaveCurrentRoom(member);
  const room = makeRoom(`build-${++roomCounter}`, false, 'builder');
  rooms.set(room.id, room);
  addToRoom(member, room);
  room.state = createState();
  room.state.noClock = true; // endless — tinker + playtest freely
  const clean = sanitizeField(field);
  if (clean) setField(room.state, clean);
  room.inputs.clear();
  room.botCounter = 0;
  addPlayer(room.state, member.id, { name: member.name, char: DEFAULT_CHAR, team: 'A', slot: 0, isBot: false, cosmetic: member.cosmetic || DEFAULT_COSMETIC, buffs: buffsFromLoadout(member.loadout) });
  room.inputs.set(member.id, emptyInput());
  member.team = 'A'; member.inMatch = true; member.afk = false; member.lastInputAt = nowMs();
  const matchId = `${room.id}-${++matchSeq}`;
  const roster = [{ id: member.id, name: member.name, avatar: member.avatar || null, team: 'A', cards: member.cards || [], cosmetic: member.cosmetic || DEFAULT_COSMETIC, loadout: sanitizeLoadout(member.loadout, member.cards), isBot: false }];
  room.phase = 'match';
  fillBots(room, roster); // backfill bots on both teams
  attachBall(room.state, 'A');
  room.endHoldT = 0;
  send(member.ws, { type: 'roomJoined', mode: 'builder', code: null });
  send(member.ws, { type: 'matchStart', mode: 'builder', matchId, playerId: member.id, team: 'A', field: FIELD, chars: CHARACTERS, settings: room.state.settings, players: roster, arena: clean });
  room.rosterVersion++; broadcastRoster(room);
}

// Training option: a full 2v2 MATCH vs bots only (default arena, real clock). Instant,
// solo entry; the human is team A and every other slot is a bot. Difficulty from the client.
function startBotGame(member, diffLevel) {
  leaveCurrentRoom(member);
  const room = makeRoom(`bots-${++roomCounter}`, false, 'match');
  rooms.set(room.id, room);
  addToRoom(member, room);
  room.state = createState();
  if (typeof diffLevel === 'number') room.diffLevel = clampLevel(diffLevel);
  room.inputs.clear();
  room.botCounter = 0;
  addPlayer(room.state, member.id, { name: member.name, char: DEFAULT_CHAR, team: 'A', slot: 0, isBot: false, cosmetic: member.cosmetic || DEFAULT_COSMETIC, buffs: buffsFromLoadout(member.loadout) });
  room.inputs.set(member.id, emptyInput());
  member.team = 'A'; member.inMatch = true; member.afk = false; member.lastInputAt = nowMs();
  const matchId = `${room.id}-${++matchSeq}`;
  const roster = [{ id: member.id, name: member.name, avatar: member.avatar || null, team: 'A', cards: member.cards || [], cosmetic: member.cosmetic || DEFAULT_COSMETIC, loadout: sanitizeLoadout(member.loadout, member.cards), isBot: false }];
  room.phase = 'match';
  fillBots(room, roster); // fill the other 3 slots with bots
  attachBall(room.state, 'A');
  room.endHoldT = 0;
  send(member.ws, { type: 'roomJoined', mode: 'botgame', code: null });
  send(member.ws, { type: 'matchStart', mode: 'botgame', matchId, playerId: member.id, team: 'A', field: FIELD, chars: CHARACTERS, settings: room.state.settings, players: roster });
  room.rosterVersion++; broadcastRoster(room);
}

// A challenge accept drops both players into a fresh private room on opposite teams
// and starts the normal countdown → match. Reuses the private-room lifecycle.
function startChallengeMatch(a, b) {
  leaveCurrentRoom(a);
  leaveCurrentRoom(b);
  const code = genCode();
  if (!code) { send(a.ws, { type: 'challengeError', msg: 'אין קודי חדר פנויים' }); send(b.ws, { type: 'challengeError', msg: 'אין קודי חדר פנויים' }); return; }
  const room = makeRoom(code, true);
  rooms.set(room.id, room);
  room.hostId = a.id; // challenger nominally hosts; both are auto-admitted (a challenge IS mutual consent — no approval step)
  addToRoom(a, room);
  addToRoom(b, room);
  a.team = 'A';
  b.team = 'B';
  send(a.ws, { type: 'roomJoined', mode: 'private', code: room.id, host: true });
  send(b.ws, { type: 'roomJoined', mode: 'private', code: room.id, host: false });
  startCountdown(room);
  broadcastLobby(room);
}

function createPrivateRoom(member) {
  leaveCurrentRoom(member);
  const code = genCode();
  if (!code) { send(member.ws, { type: 'roomError', msg: 'אין קודי חדר פנויים, נסו שוב' }); return; }
  const room = makeRoom(code, true);
  rooms.set(room.id, room);
  room.hostId = member.id; // the creator is the HOST — only they may accept/reject/kick
  addToRoom(member, room);
  send(member.ws, { type: 'roomJoined', mode: 'private', code: room.id, host: true });
  broadcastLobby(room);
}

// Join-by-code: the joiner does NOT enter the room yet — they go PENDING and the HOST is notified.
// The host's joinDecision (accept) admits them; reject/leave/disconnect drops them.
function joinPrivateRoom(member, code) {
  const room = rooms.get(normalizeRoomCode(code));
  if (!room || !room.isPrivate) { send(member.ws, { type: 'roomError', msg: 'החדר לא נמצא' }); return; }
  if (room.phase === 'match') { send(member.ws, { type: 'roomError', msg: 'המשחק כבר התחיל' }); return; }
  if (room.members.size >= MAX_PLAYERS) { send(member.ws, { type: 'roomError', msg: 'החדר מלא' }); return; }
  if (room.pending.size >= MAX_PLAYERS) { send(member.ws, { type: 'roomError', msg: 'יותר מדי בקשות, נסו שוב' }); return; }
  leaveCurrentRoom(member); // leaves any current room AND clears a prior pending request (clearPending runs first)
  member.pendingRoom = room;
  room.pending.set(member.id, member);
  send(member.ws, { type: 'joinPending', code: room.id });
  notifyHost(room, { type: 'joinRequest', joinerId: member.id, userId: member.userId || null, name: member.name, avatar: member.avatar || null, cosmetic: member.cosmetic || DEFAULT_COSMETIC, cards: member.cards || [] });
}

// Remove a member from their room; clean up / keep the match alive as needed.
function leaveCurrentRoom(member) {
  clearPending(member); // if this member had an outstanding join request, drop it + tell that host
  const room = member.room;
  if (!room) return;
  const wasInMatch = member.inMatch;
  const wasHost = room.hostId === member.id;
  room.members.delete(member);
  member.room = null; member.inMatch = false;
  if (wasInMatch && room.phase === 'match') {
    if (room.state.players[member.id]) { removePlayer(room.state, member.id); room.inputs.delete(member.id); }
    fillBots(room);
    if (humansInRoom(room) === 0) endRoom(room);
    else if (room.phase === 'match') { room.rosterVersion++; broadcastRoster(room); } // a bot backfilled a slot
  }
  if (room.members.size === 0) destroyRoom(room);
  else { if (wasHost) transferHost(room); broadcastLobby(room); } // host disconnect/leave -> hand off to a remaining member
}

function destroyRoom(room) {
  rooms.delete(room.id);
  if (publicRoom === room) publicRoom = null;
  // Any joiners still waiting on this (now gone) room's host must be returned to the lobby.
  if (room.pending) {
    for (const p of room.pending.values()) { p.pendingRoom = null; send(p.ws, { type: 'joinRejected', code: room.id, reason: 'closed' }); }
    room.pending.clear();
  }
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

  room.lobbyBots = []; // reservation consumed — fillBots creates the real match bots
  room.state = createState();
  room.botMem = createBotMemory();
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
  const introMs = Math.round(INTRO_PROMO * 1000);
  // Roster for the team-intro overlay: EACH participant's team + album (cards) + equipped card-powers
  // (loadout). Built BEFORE matchStart is sent, and bots are APPENDED below (Task 18) so the countdown/
  // intro payload carries bot cards too — the client reads players[].loadout to render them.
  const roster = assigned.map(([m, team]) => ({ id: m.id, name: m.name, avatar: m.avatar || null, team, cards: m.cards || [], cosmetic: m.cosmetic || DEFAULT_COSMETIC, loadout: sanitizeLoadout(m.loadout, m.cards), isBot: false }));
  for (const [m, team, slot] of assigned) {
    addPlayer(room.state, m.id, { name: m.name, char: DEFAULT_CHAR, team, slot, isBot: false, cosmetic: m.cosmetic || DEFAULT_COSMETIC, buffs: buffsFromLoadout(m.loadout) });
    room.inputs.set(m.id, emptyInput());
    m.team = team; m.inMatch = true; m.afk = false; m.lastInputAt = nowMs();
  }
  // Size this match's bots to the humans: total card-power target + equipped-count ceiling + a pool of
  // the humans' real card numbers (for valid bot card art), then fill empty slots — collecting each
  // bot's synthesized loadout into `roster` so the intro shows bot cards too (Task 18).
  room.botBuffTarget = humanBuffTarget(assigned);
  room.botLoadoutParams = botLoadoutParamsFromHumans(assigned);
  fillBots(room, roster);
  for (const [m, team] of assigned) {
    send(m.ws, { type: 'matchStart', matchId, playerId: m.id, team, field: FIELD, chars: CHARACTERS, settings: room.state.settings, players: roster, intro: introMs });
  }
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
    room.state = createState(); room.botMem = createBotMemory(); room.inputs.clear(); room.botCounter = 0;
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
    buildWindup: p.buildWindup, // winding flag (wire.js overloads buildFrac with this when > 0)
  }));
  return {
    type: 'snapshot',
    tick: state.tick, phase: state.phase, elapsed: Math.floor(state.elapsed),
    resetTimer: state.resetTimer, lastGoal: state.lastGoal, score: state.score,
    ball: { x: r1(state.ball.x), y: r1(state.ball.y), owner: state.ball.owner },
    players,
    projectiles: state.projectiles.map((p) => ({ id: p.id, x: r1(p.x), y: r1(p.y), team: p.team })),
    walls: state.builtWalls.map((w) => ({ id: w.id, x: w.x, y: w.y, w: w.w, h: w.h, hp: w.hp, maxHp: w.maxHp, team: w.team, fragile: w.fragile, angle: w.angle })),
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
  ensureBotPlan(room); // #18: keep the previewed bot fill fresh for the matchmaking VS/countdown
  // #18 fix: send each human's EQUIPPED loadout (not just their album) so the VS/countdown shows the
  // cards they actually picked in their power slots — matching what the pre-kickoff reveal shows. Without
  // this the client falls back to album top-3 during the countdown, so humans and bots looked inconsistent.
  const list = [...room.members].map((m) => ({ id: m.id, name: m.name, avatar: m.avatar || null, team: m.team, inMatch: m.inMatch, cosmetic: m.cosmetic || DEFAULT_COSMETIC, cards: m.cards || [], loadout: sanitizeLoadout(m.loadout, m.cards) }));
  // Invited lobby bots render as members (isBot) so the party looks populated before kickoff.
  for (const b of (room.lobbyBots || [])) list.push({ id: b.id, name: b.name, avatar: null, team: b.team, inMatch: false, isBot: true, cosmetic: b.cosmetic || DEFAULT_COSMETIC, cards: [], loadout: [null, null, null] });
  // #18: on the quick-match VS, show the bots that WILL fill the empty slots (with their cards) while
  // you wait. Private rooms also backfill bots at kickoff, but their lobby is for real friends, so we
  // don't preview bots there — they still appear at the pre-kickoff reveal.
  const showBots = !room.isPrivate && room.phase !== 'match';
  const bots = (showBots && Array.isArray(room.botPlan))
    ? room.botPlan.map((b, i) => ({ id: `botprev-${room.id}-${i}`, name: 'Bot', avatar: null, team: b.team, isBot: true, cards: b.cards, loadout: b.loadout,
        level: displayLevelForBot(room.diffLevel), xp: xpForBotLevel(room.diffLevel) })) // bot level+XP for the countdown badge
    : [];
  return {
    type: 'lobby',
    mode: room.isPrivate ? 'private' : 'quick',
    code: room.isPrivate ? room.id : null,
    phase: room.phase,
    countdown: room.phase === 'countdown' ? Math.max(0, Math.ceil(room.countdownT)) : 0,
    online: onlineCount(),
    host: room.hostId || null, // member.id of the HOST; a client shows host controls when host === its own welcome id
    members: list,
    bots,
  };
}
function broadcastLobby(room) {
  const payload = lobbyPayload(room);
  for (const m of room.members) if (!m.inMatch) send(m.ws, payload);
}

// Presence: which of THIS member's friends are currently connected.
function sendPresenceTo(member) {
  if (!member) return;
  const online = (member.friends || []).filter((uid) => onlineByUser.has(uid));
  send(member.ws, { type: 'friendsPresence', online });
}
// When user `userId` connects/disconnects, refresh presence for everyone who has
// them as a friend.
function notifyFriendsOfPresence(userId) {
  for (const m of members.values()) {
    if (m.userId && Array.isArray(m.friends) && m.friends.includes(userId)) sendPresenceTo(m);
  }
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
// The full card album: numbers 1..50 in EACH rarity => 200 cards total (see saltiz-cards migration
// 0003: card_number between 1 and 50). Bots draw their card art from this whole range.
const CARDS_PER_RARITY = 50;
const randomCardNum = () => 1 + Math.floor(Math.random() * CARDS_PER_RARITY);
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
  const used = new Set(); // one card instance per loadout: first slot to claim a card wins
  const pick = (slot) => {
    if (!slot || !CARD_RARITIES.includes(slot.r)) return null;
    const n = Math.trunc(Number(slot.n));
    if (!Number.isFinite(n) || n < 1 || n > 200) return null;
    const key = slot.r + '#' + n;
    if (used.has(key)) return null; // already consumed by an earlier slot — no cross-slot duplicates
    if (!owned.some((c) => c.r === slot.r && c.n === n)) return null;
    used.add(key);
    return { r: slot.r, n };
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
  return { cardShot: 1 / (1 - shot), speedBuff: 1 + speed, cardUtil: 1 - util };
}

// --- Bots get RANDOM card powers roughly matching the human players in the match ------------------
// Sum of a loadout's 3 slot buff %s (0..0.6) — a player's total "card power".
function loadoutTotalPct(loadout) {
  const L = Array.isArray(loadout) ? loadout : [];
  return pctOf(L[0]) + pctOf(L[1]) + pctOf(L[2]);
}
// Average card power across a match's assigned humans — the level bots are sized to. 0 if nobody has cards.
function humanBuffTarget(assigned) {
  const humans = (assigned || []).filter((a) => a && a[0]);
  if (!humans.length) return 0;
  return humans.reduce((s, a) => s + loadoutTotalPct(a[0].loadout), 0) / humans.length;
}
// Probabilistically round a per-slot target to an ADJACENT rarity step so the EXPECTED buff equals the
// target (unbiased even at the legendary 0.20 cap) while still varying between bots. Each slot lands on
// a real rarity, so a bot's buff always equals "a card".
const RARITY_PCT_STEPS = [0, 0.03, 0.07, 0.12, 0.20]; // empty / common / rare / epic / legendary
function pickRarityPct(target) {
  const t = Math.max(0, Math.min(0.20, Number(target) || 0));
  let lo = 0, hi = 0.20;
  for (let i = 0; i < RARITY_PCT_STEPS.length - 1; i++) {
    if (t >= RARITY_PCT_STEPS[i] && t <= RARITY_PCT_STEPS[i + 1]) { lo = RARITY_PCT_STEPS[i]; hi = RARITY_PCT_STEPS[i + 1]; break; }
  }
  if (hi === lo) return lo;
  return Math.random() < (t - lo) / (hi - lo) ? hi : lo;
}
// A RANDOM bot loadout whose 3 slot buffs roughly match `targetTotal` (the human average): each slot is
// target/3 probabilistically rounded to a rarity, so E[total] == target. Same shape as buffsFromLoadout.
function randomBotBuffs(targetTotal) {
  const per = Math.max(0, Number(targetTotal) || 0) / 3;
  const shot = pickRarityPct(per), speed = pickRarityPct(per), util = pickRarityPct(per);
  return { cardShot: 1 / (1 - shot), speedBuff: 1 + speed, cardUtil: 1 - util };
}

// --- Bot DISPLAY loadouts (Task 18): match the humans' card COUNT + rarities, shown in the intro -----
// Non-empty slots in a sanitized loadout = a player's equipped card count.
function equippedCount(loadout) {
  const L = Array.isArray(loadout) ? loadout : [];
  return (L[0] ? 1 : 0) + (L[1] ? 1 : 0) + (L[2] ? 1 : 0);
}
// Inverse of RARITY_BUFF_PCT: a rarity-step pct -> its rarity name.
const PCT_TO_RARITY = { 0.03: 'common', 0.07: 'rare', 0.12: 'epic', 0.20: 'legendary' };
// Per-match bot sizing derived from the assigned humans: the MAX equipped count (ceiling for a bot's
// random card count) and the per-slot rarity target (human avg total / 3). Bot card NUMBERS are drawn
// from the whole 200-card album (randomCardNum), not the humans' owned cards, so bots get variety.
function botLoadoutParamsFromHumans(assigned) {
  const humans = (assigned || []).filter((a) => a && a[0]);
  let maxCount = 0;
  for (const a of humans) maxCount = Math.max(maxCount, equippedCount(sanitizeLoadout(a[0].loadout, a[0].cards)));
  return { maxCount, perSlotTarget: humanBuffTarget(assigned) / 3 };
}
// A random bot loadout: k = random 1..maxCount cards (humans equip N -> bot gets 1..N), each dropped in
// a random slot at a rarity roughly matching the humans (a chosen slot is never empty — >= common). Each
// card's NUMBER is drawn RANDOMLY from the full 1..50 album for its rarity (all 200 cards in play), so
// bots no longer just mirror the human's owned cards. Same [s0,s1,s2] shape as sanitizeLoadout, so
// buffsFromLoadout consumes it directly (display == gameplay).
function randomBotLoadout(params) {
  const p = params || {};
  const maxCount = Math.max(0, Math.floor(Number(p.maxCount) || 0));
  const out = [null, null, null];
  if (maxCount < 1) return out; // humans have no cards -> bot has none either
  const perSlotTarget = Math.max(0, Number(p.perSlotTarget) || 0);
  const k = 1 + Math.floor(Math.random() * maxCount); // 1..maxCount
  for (const s of shuffle([0, 1, 2]).slice(0, k)) {
    let pct = pickRarityPct(perSlotTarget);
    if (!pct) pct = 0.03; // a chosen slot always holds a real card (>= common)
    const r = PCT_TO_RARITY[pct] || 'common';
    out[s] = { r, n: randomCardNum() };
  }
  // "Make sense" rule: you cannot have empty slots if you hold a card stronger than RARE. A bot with an
  // epic/legendary must be full — fill every remaining empty slot with a COMMON (e.g. one epic + two
  // commons, never one epic + two empty). A bot whose best card is only common/rare may keep empties.
  const strongRank = CARD_RARITIES.indexOf('rare'); // > rare == epic/legendary
  const topRank = out.reduce((m, s) => (s ? Math.max(m, CARD_RARITIES.indexOf(s.r)) : m), -1);
  if (topRank > strongRank) {
    for (let s = 0; s < 3; s++) if (!out[s]) out[s] = { r: 'common', n: randomCardNum() };
  }
  return out;
}
// EXTREME bots show 3 fixed legendary cards (matching their fixed strong buffs).
function extremeBotLoadout() { return [{ r: 'legendary', n: 1 }, { r: 'legendary', n: 2 }, { r: 'legendary', n: 3 }]; }

// --- Level-based bot cards: a bot's cards reflect ITS OWN level (0..11), not the humans' -----
// Smooth ramp: weak bots pull mostly commons and can have empty slots; strong bots pull epics/
// legendaries and fill up; the top levels are GUARANTEED legendaries. `min`/`max` = card count
// range, `w` = per-slot rarity weights (relative), `leg` = guaranteed legendary slots.
// TUNABLE: endpoints are fixed (L0-1 ~rare legendary, L10-11 = 3 legendaries); the curve between
// is free to adjust. Indexed by difficulty level 0..11.
const RARITY_BY_LEVEL = [
  { min: 0, max: 2, w: { common: 80, rare: 18, epic: 2,  legendary: 0 },   leg: 0 }, // L0
  { min: 1, max: 2, w: { common: 72, rare: 22, epic: 4,  legendary: 2 },   leg: 0 }, // L1  ~2% legendary
  { min: 1, max: 3, w: { common: 55, rare: 30, epic: 12, legendary: 3 },   leg: 0 }, // L2
  { min: 2, max: 3, w: { common: 42, rare: 33, epic: 18, legendary: 7 },   leg: 0 }, // L3
  { min: 2, max: 3, w: { common: 30, rare: 33, epic: 25, legendary: 12 },  leg: 0 }, // L4
  { min: 2, max: 3, w: { common: 20, rare: 30, epic: 34, legendary: 16 },  leg: 0 }, // L5
  { min: 3, max: 3, w: { common: 12, rare: 26, epic: 40, legendary: 22 },  leg: 0 }, // L6
  { min: 3, max: 3, w: { common: 6,  rare: 20, epic: 44, legendary: 30 },  leg: 0 }, // L7  ~1 legendary
  { min: 3, max: 3, w: { common: 0,  rare: 14, epic: 46, legendary: 40 },  leg: 1 }, // L8  >=1 guaranteed
  { min: 3, max: 3, w: { common: 0,  rare: 6,  epic: 40, legendary: 54 },  leg: 2 }, // L9  >=2 guaranteed
  { min: 3, max: 3, w: { common: 0,  rare: 0,  epic: 0,  legendary: 100 }, leg: 3 }, // L10 3 legendaries
  { min: 3, max: 3, w: { common: 0,  rare: 0,  epic: 0,  legendary: 100 }, leg: 3 }, // L11 3 legendaries
];
// Weighted rarity pick from a level's relative weights.
function weightedRarity(w) {
  const total = (w.common || 0) + (w.rare || 0) + (w.epic || 0) + (w.legendary || 0);
  if (total <= 0) return 'common';
  let r = Math.random() * total;
  if ((r -= w.common || 0) < 0) return 'common';
  if ((r -= w.rare || 0) < 0) return 'rare';
  if ((r -= w.epic || 0) < 0) return 'epic';
  return 'legendary';
}
// A bot loadout drawn purely from ITS level. Places any guaranteed legendaries, rolls a card
// count in [min,max], fills the rest by weighted rarity, then applies the same "no empty slot if
// holding > rare" rule as randomBotLoadout. Card NUMBERS are random across the full 1..50 album.
// Same [s0,s1,s2] shape, so buffsFromLoadout consumes it directly (display == gameplay).
function botLoadoutForLevel(level) {
  const spec = RARITY_BY_LEVEL[clampLevel(level)];
  const out = [null, null, null];
  const slots = shuffle([0, 1, 2]);
  let placed = 0;
  for (let i = 0; i < Math.min(3, spec.leg); i++) out[slots[placed++]] = { r: 'legendary', n: randomCardNum() };
  const count = Math.max(spec.leg, spec.min + Math.floor(Math.random() * (spec.max - spec.min + 1)));
  for (; placed < Math.min(3, count); placed++) out[slots[placed]] = { r: weightedRarity(spec.w), n: randomCardNum() };
  // "Make sense" rule: no empty slot if holding a card stronger than RARE — fill empties with commons.
  const strongRank = CARD_RARITIES.indexOf('rare');
  const topRank = out.reduce((m, s) => (s ? Math.max(m, CARD_RARITIES.indexOf(s.r)) : m), -1);
  if (topRank > strongRank) for (let s = 0; s < 3; s++) if (!out[s]) out[s] = { r: 'common', n: randomCardNum() };
  return out;
}
// A loadout -> the compact [{r,n,c,w}] card list the roster/album UI expects.
function loadoutToCards(loadout) {
  return (Array.isArray(loadout) ? loadout : []).filter(Boolean).map((s) => ({ r: s.r, n: s.n, c: 1, w: 0 }));
}
// #18 — preview the bots that will fill this room's empty slots (team/slot/loadout/cosmetic) so the
// quick-match VS/countdown can show opponent bots + their cards BEFORE kickoff. Mirrors startMatch's
// human team/slot assignment + fillBots' balancing so the (team,slot) keys line up, and reuses the
// same rarity-matching as match time. fillBots then consumes this plan verbatim (preview == match).
function computeBotPlan(room) {
  const humans = [...room.members].filter((m) => !m.inMatch).slice(0, MAX_PLAYERS);
  const teamSlots = { A: [0, 1], B: [0, 1] };
  const assigned = [];
  for (const m of humans) { const t = m.team === 'B' ? 'B' : 'A'; if (teamSlots[t].length) assigned.push([m, t, teamSlots[t].shift()]); else assigned.push([m, null, null]); }
  for (const a of assigned) { if (a[1]) continue; const t = teamSlots.A.length ? 'A' : 'B'; a[1] = t; a[2] = teamSlots[t].shift(); }
  const plan = [];
  const countT = (t) => assigned.filter((a) => a[1] === t).length + plan.filter((b) => b.team === t).length;
  const usedT = (t) => new Set([...assigned.filter((a) => a[1] === t).map((a) => a[2]), ...plan.filter((b) => b.team === t).map((b) => b.slot)]);
  const humanT = { A: assigned.some((a) => a[1] === 'A'), B: assigned.some((a) => a[1] === 'B') };
  const lvl = levelAt(room.diffLevel);
  while (humans.length + plan.length < MAX_PLAYERS) {
    const team = countT('A') <= countT('B') ? 'A' : 'B';
    const slot = usedT(team).has(0) ? 1 : 0;
    const sideScalar = humanT[team] ? lvl.partner : lvl.enemy; // this preview-bot's side skill
    const loadout = sideScalar >= 0.95 ? extremeBotLoadout() : botLoadoutForLevel(room.diffLevel);
    plan.push({ team, slot, loadout, cards: loadoutToCards(loadout), cosmetic: botCosmeticForRoom(room) });
  }
  return plan;
}
// Signature of the human roster (+ difficulty) — the bot plan is re-rolled only when this changes, so
// previewed cards stay STABLE across the 5Hz countdown ticks instead of flickering every frame.
function humanSignature(room) {
  const hs = [...room.members].filter((m) => !m.inMatch)
    .map((m) => `${m.id}:${m.team || ''}:${equippedCount(sanitizeLoadout(m.loadout, m.cards))}`).sort();
  return `${room.diffLevel}|${hs.join(',')}`;
}
function ensureBotPlan(room) {
  if (!room || room.mode === 'training' || room.phase === 'match') { room.botPlan = null; room.botPlanSig = null; return; }
  const sig = humanSignature(room);
  if (room.botPlanSig === sig && Array.isArray(room.botPlan)) return; // unchanged roster -> keep stable cards
  room.botPlanSig = sig;
  room.botPlan = computeBotPlan(room);
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
        const ident = verifyFootballToken(msg.authToken, FOOTBALL_TOKEN_SECRET);
        // Authenticated → use Pikme identity; guest → typed name, no userId.
        let name = (ident?.nickName || msg.name || 'Player').toString().slice(0, 16);
        let avatar = (ident?.image || msg.avatar || '').toString().slice(0, 400) || null;
        if (avatar && avatar.startsWith('http://')) avatar = 'https://' + avatar.slice(7);
        const cards = sanitizeCards(msg.cards);
        member = { id, ws, userId: ident?.userId || null, name, avatar, cards, loadout: sanitizeLoadout(msg.loadout, cards), cosmetic: normalizeCosmetic(msg.cosmetic), team: 'A', inMatch: false, afk: false, lastInputAt: nowMs(), room: null, pendingRoom: null, friends: [] };
        members.set(ws, member);
        if (member.userId) { onlineByUser.set(member.userId, member); notifyFriendsOfPresence(member.userId); }
        send(ws, { type: 'welcome', id, field: FIELD, chars: CHARACTERS, userId: member.userId });
        send(ws, { type: 'home', online: onlineCount() });
        return;
      }
      if (!member) return;

      // Cosmetic (hero+skin) chosen on the home screen; applied at the next match start.
      if (msg.type === 'setCosmetic') { member.cosmetic = normalizeCosmetic(msg.cosmetic); return; }
      // Card-powers loadout chosen on the home screen; validated vs the member's album,
      // baked into buffs at the next match start.
      if (msg.type === 'setLoadout') { member.loadout = sanitizeLoadout(msg.loadout, member.cards); return; }
      if (msg.type === 'quickMatch') { quickMatch(member, msg.diffLevel); return; }
      if (msg.type === 'training') { startTraining(member); return; }
      if (msg.type === 'builderMatch') { startBuilderMatch(member, msg.field); return; }
      if (msg.type === 'botGame') { startBotGame(member, msg.diffLevel); return; }
      if (msg.type === 'resetBall') { // training only: recenter the ball on demand
        const r = member.room;
        if (r && r.mode === 'training' && r.phase === 'match') attachBall(r.state, member.team);
        return;
      }
      if (msg.type === 'createRoom') { createPrivateRoom(member); return; }
      if (msg.type === 'joinRoom') { joinPrivateRoom(member, msg.code); return; }
      if (msg.type === 'joinDecision') { // HOST accepts/rejects a pending joiner (host-only, enforced server-side)
        const r = member.room;
        if (!r || !r.isPrivate || r.hostId !== member.id) return;
        const joinerId = (msg.joinerId || '').toString();
        const joiner = r.pending.get(joinerId);
        if (!joiner) return; // already resolved / left
        r.pending.delete(joinerId);
        joiner.pendingRoom = null;
        if (msg.accept && r.members.size < MAX_PLAYERS && r.phase !== 'match') {
          addToRoom(joiner, r);
          trimLobbyBots(r); // a real human takes priority over an invited bot
          send(joiner.ws, { type: 'roomJoined', mode: 'private', code: r.id, host: false });
          broadcastLobby(r); // updated roster to everyone waiting in the room
        } else {
          send(joiner.ws, { type: 'joinRejected', code: r.id, reason: msg.accept ? 'full' : 'rejected' });
        }
        return;
      }
      if (msg.type === 'kick') { // HOST removes an already-joined member (host-only, enforced server-side)
        const r = member.room;
        if (!r || r.hostId !== member.id) return;
        const targetId = (msg.memberId || '').toString();
        if (!targetId || targetId === r.hostId) return; // a host can't kick themselves
        // A "lobby bot" (invited from the friends list) is just a reservation — drop it directly.
        if (targetId.startsWith('lbot-')) {
          const n = r.lobbyBots.length;
          r.lobbyBots = r.lobbyBots.filter((b) => b.id !== targetId);
          if (r.lobbyBots.length !== n) broadcastLobby(r);
          return;
        }
        let target = null;
        for (const t of r.members) if (t.id === targetId) { target = t; break; }
        if (!target) return;
        send(target.ws, { type: 'kicked', code: r.id });
        leaveCurrentRoom(target); // drops them (+ bot backfill if mid-match) and re-broadcasts the lobby
        return;
      }
      if (msg.type === 'setFriends') {
        const list = Array.isArray(msg.friends) ? msg.friends.filter((x) => typeof x === 'string').slice(0, 500) : [];
        member.friends = list;
        sendPresenceTo(member);
        return;
      }
      if (msg.type === 'challenge') {
        const toUserId = (msg.toUserId || '').toString();
        if (!member.userId) { send(ws, { type: 'challengeError', msg: 'לא מחובר' }); return; }
        if (!member.friends.includes(toUserId)) { send(ws, { type: 'challengeError', msg: 'לא חבר' }); return; }
        const target = onlineByUser.get(toUserId);
        if (!target) { send(ws, { type: 'challengeError', msg: 'לא מחובר כרגע' }); return; }
        const challengeId = `c-${++challengeCounter}`;
        challenges.set(challengeId, { fromUserId: member.userId, toUserId });
        send(target.ws, { type: 'challengeReceived', challengeId, fromUserId: member.userId, fromName: member.name });
        send(ws, { type: 'challengeSent', toUserId });
        return;
      }
      if (msg.type === 'challengeRespond') {
        const c = challenges.get((msg.challengeId || '').toString());
        if (!c || c.toUserId !== member.userId) return;
        challenges.delete(msg.challengeId);
        const challenger = onlineByUser.get(c.fromUserId);
        if (!msg.accept) { if (challenger) send(challenger.ws, { type: 'challengeDeclined', byUserId: member.userId }); return; }
        if (!challenger) { send(ws, { type: 'challengeError', msg: 'היריב התנתק' }); return; }
        startChallengeMatch(challenger, member);
        return;
      }
      // Party invite: host invites an ONLINE friend into their private room. No 3-digit code
      // and no host-approval step (the host initiated it — mutual consent, like a challenge).
      if (msg.type === 'inviteFriend') {
        const toUserId = (msg.toUserId || '').toString();
        if (!member.userId) { send(ws, { type: 'partyError', msg: 'לא מחובר' }); return; }
        if (!member.friends.includes(toUserId)) { send(ws, { type: 'partyError', msg: 'לא חבר' }); return; }
        // Ensure I host a private room to invite into (self-heal if I lost/left it).
        let r = member.room;
        if (!r || !r.isPrivate || r.hostId !== member.id) { createPrivateRoom(member); r = member.room; }
        if (!r) { send(ws, { type: 'partyError', msg: 'לא ניתן ליצור חדר' }); return; }
        if (r.phase === 'match') { send(ws, { type: 'partyError', msg: 'המשחק כבר התחיל' }); return; }
        if (r.members.size >= MAX_PLAYERS) { send(ws, { type: 'partyError', msg: 'החדר מלא' }); return; }
        const target = onlineByUser.get(toUserId);
        if (!target) { send(ws, { type: 'partyError', msg: 'החבר לא מחובר' }); return; }
        r.invited.add(toUserId);
        send(target.ws, { type: 'partyInvite', code: r.id, fromUserId: member.userId, fromName: member.name });
        send(ws, { type: 'partyInviteSent', toUserId });
        return;
      }
      if (msg.type === 'partyRespond') {
        if (!msg.accept) return; // decline: nothing to clean up (nothing joined yet)
        const r = rooms.get(normalizeRoomCode(msg.code));
        if (!r || !r.isPrivate) { send(ws, { type: 'partyError', msg: 'החדר לא נמצא' }); return; }
        if (!member.userId || !r.invited.has(member.userId)) { send(ws, { type: 'partyError', msg: 'ההזמנה פגה' }); return; }
        if (r.phase === 'match') { send(ws, { type: 'partyError', msg: 'המשחק כבר התחיל' }); return; }
        if (r.members.size >= MAX_PLAYERS) { send(ws, { type: 'partyError', msg: 'החדר מלא' }); return; }
        leaveCurrentRoom(member);            // drop any current room / pending request first
        addToRoom(member, r);                // AUTO-admit — the host invited them
        trimLobbyBots(r);                    // a real human takes priority over an invited bot
        send(ws, { type: 'roomJoined', mode: 'private', code: r.id, host: false });
        const host = hostMember(r);
        if (host) send(host.ws, { type: 'partyInviteAccepted', name: member.name });
        broadcastLobby(r);
        return;
      }
      // Add a BOT to the party (invited from the friends list). Host-only; shows in the lobby
      // and becomes a match bot at kickoff (fillBots). name is the friend-list bot's display name.
      if (msg.type === 'addBot') {
        const r = member.room;
        if (!r || !r.isPrivate || r.hostId !== member.id) return;
        if (r.phase === 'match') { send(ws, { type: 'partyError', msg: 'המשחק כבר התחיל' }); return; }
        if (r.members.size + r.lobbyBots.length >= MAX_PLAYERS) { send(ws, { type: 'partyError', msg: 'החדר מלא' }); return; }
        const name = (msg.name || 'בוט').toString().slice(0, 24);
        r.lobbyBots.push({ id: `lbot-${r.id}-${++r.botCounter}`, name, team: balancedTeam(r) });
        broadcastLobby(r);
        return;
      }
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
        const active = (Math.abs(msg.moveX || 0) + Math.abs(msg.moveY || 0) > 0.1) || !!msg.hold || !!msg.fire || !!msg.special || !!msg.build || !!msg.buildHold;
        if (active) {
          member.lastInputAt = nowMs();
          if (member.afk) {
            member.afk = false;
            const p = room.state.players[member.id];
            if (p) {
              p.isBot = false;
              // While AFK, bot-ai drove this human and set the DIFFICULTY multipliers (chargeRate/cdMul).
              // Strip them so the returning human has no bot difficulty; their CARD buffs (cardShot/
              // cardUtil/speedBuff) were never touched by bot-ai, so they persist untouched.
              p.chargeRate = 1; p.cdMul = 1;
            }
          }
        }
        const prev = room.inputs.get(member.id) || {};
        room.inputs.set(member.id, {
          seq: msg.seq, moveX: msg.moveX || 0, moveY: msg.moveY || 0, aimX: msg.aimX || 0, aimY: msg.aimY || 0,
          // hold = a level signal (charging now); fire = an EDGE (release), latched
          // sticky until the next tick consumes it so a fire between ticks isn't lost.
          hold: !!msg.hold, fire: prev.fire || !!msg.fire,
          special: prev.special || !!msg.special, build: prev.build || !!msg.build,
          buildHold: !!msg.buildHold, sax: msg.sax || 0, say: msg.say || 0,
        });
        return;
      }
      if (msg.type === 'settings' && room) {
        if (msg.settings) applySettings(room, msg.settings);
        // New: fluent difficulty LADDER — a level index that sets enemy + partner skill.
        if (msg.diffLevel != null) room.diffLevel = clampLevel(msg.diffLevel);
        // Legacy: a stale client may still send a string tier — bridge it to a level index.
        else if (['easy', 'normal', 'hard', 'extreme'].includes(msg.botDifficulty)) room.diffLevel = levelFromLegacy(msg.botDifficulty);
        if (room.botMem) applyTeamSkill(room); // apply live (also re-applied each tick)
        return;
      }
      if (msg.type === 'ping') { send(ws, { type: 'pong', t: msg.t }); return; }
    } catch (e) { if (msgErrCount++ < 5) console.error('MSG ERROR:', (e && e.stack) || e); }
  });

  ws.on('close', () => {
    if (!member) return;
    members.delete(ws);
    if (member.userId && onlineByUser.get(member.userId) === member) {
      onlineByUser.delete(member.userId);
      notifyFriendsOfPresence(member.userId);
    }
    leaveCurrentRoom(member);
  });
});

server.listen(PORT, () => {
  console.log(`\n⚽ Football mock running:`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   Home -> Quick Match (public room) or Play With Friends (private code room).\n`);
});
