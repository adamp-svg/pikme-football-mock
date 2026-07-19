// Authoritative game server + tiny static file server.
// - Serves the web game from /public and /shared
// - Runs a LOBBY -> COUNTDOWN -> MATCH room state machine
// - Fills empty match slots with bots; idle players convert to bots (reclaimable)
//
// Transport is raw WebSocket (via `ws`) for the mock — low overhead, easy to
// reason about. We'll revisit Socket.io/reconnection when embedding in the app.

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
  MAG_SIZE, AMMO_REGEN, EMPTY_RELOAD,
} from './shared/constants.js';

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
  // allow /shared/* and /public/*; default other paths into /public
  if (!urlPath.startsWith('/shared/') && !urlPath.startsWith('/public/')) {
    urlPath = '/public' + urlPath;
  }
  const filePath = path.normalize(path.join(__dirname, urlPath));
  if (!filePath.startsWith(__dirname)) { res.writeHead(403); return res.end('forbidden'); }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      // Always serve fresh files so re-opening the game in the WebView picks up
      // the latest tuning without stale-cache surprises.
      'Cache-Control': 'no-store, must-revalidate',
    });
    res.end(data);
  });
});

// ---------------------------------------------------------------------------
// Room state
// ---------------------------------------------------------------------------
const COUNTDOWN_TIME = 5;    // seconds from first "Play Now" to kickoff
const AFK_SECONDS = 10;      // no meaningful input for this long -> becomes a bot
const TEAM_CAP = 2;          // players per team in a 2v2 match

let state = createState();          // sim state — recreated for each match
const members = new Map();          // ws -> member (a connected client)
const inputs = new Map();           // sim playerId -> latest input (humans in-match + bots)
let roomPhase = 'lobby';            // 'lobby' | 'countdown' | 'match'
let countdownT = 0;                 // seconds left in the pre-match countdown
let endHoldT = 0;                   // seconds elapsed on the end-of-match screen
let botCounter = 0;
let memberCounter = 0;
let msgErrCount = 0, tickErrCount = 0, bcErrCount = 0;

const nowMs = () => Date.now();

// member = { id, ws, name, avatar, ready, inMatch, afk, lastInputAt }

function applySettings(s) {
  const c = (v, lo, hi, d) => (typeof v === 'number' && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  const cur = state.settings;
  // Preserve EVERY key — a missing key would become NaN in the sim.
  state.settings = {
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

function teamCounts() {
  let A = 0, B = 0;
  for (const p of Object.values(state.players)) (p.team === 'A' ? A++ : B++);
  return { A, B };
}

// Pick the emptier team + a free slot (0/1) within it.
function assignSlot() {
  const { A, B } = teamCounts();
  const team = A <= B ? 'A' : 'B';
  const usedSlots = new Set(
    Object.values(state.players).filter((p) => p.team === team).map((p) => p.slot)
  );
  const slot = usedSlots.has(0) ? 1 : 0;
  return { team, slot };
}

function fillBots() {
  while (Object.keys(state.players).length < MAX_PLAYERS) {
    const { team, slot } = assignSlot();
    const id = `bot-${++botCounter}`;
    addPlayer(state, id, { name: 'Bot', char: DEFAULT_CHAR, team, slot, isBot: true });
    inputs.set(id, { seq: 0, moveX: 0, moveY: 0, aimX: 0, aimY: 0, shoot: false, special: false });
  }
}

// ---------------------------------------------------------------------------
// Bot AI: carry + shoot on goal, PASS to a teammate who's better placed,
// chase loose balls, and defend by firing bullets at an enemy carrier.
// ---------------------------------------------------------------------------
function updateBots() {
  const b = state.ball;
  const carrier = b.owner ? state.players[b.owner] : null;
  for (const p of Object.values(state.players)) {
    if (!p.isBot) continue;
    const oppGoalX = p.team === 'A' ? FIELD.W : 0;
    const goalY = FIELD.H / 2;
    const mate = Object.values(state.players).find((q) => q.team === p.team && q.id !== p.id);

    let moveX = 0, moveY = 0, aimX = p.aimX, aimY = p.aimY, shoot = false, special = false, charge = 0;

    if (b.owner === p.id) {
      // I have the ball — drive at the goal.
      const distGoal = Math.hypot(oppGoalX - p.x, goalY - p.y);
      moveX = oppGoalX - p.x; moveY = goalY - p.y;
      aimX = oppGoalX - p.x; aimY = goalY - p.y;
      if (distGoal < 300) {
        shoot = true; charge = 1; // full-power shot on goal
      } else if (mate) {
        const mateDistGoal = Math.hypot(oppGoalX - mate.x, goalY - mate.y);
        const mateNear = Math.hypot(mate.x - p.x, mate.y - p.y);
        if (mateDistGoal < distGoal - 50 && mateNear < 380 && Math.random() < 0.05) {
          aimX = mate.x - p.x; aimY = mate.y - p.y; // pass to the better-placed teammate
          shoot = true; charge = 0.5; // measured pass
        }
      }
    } else if (carrier && carrier.team === p.team) {
      // Teammate has it — push forward and spread to get open.
      moveX = oppGoalX - p.x; moveY = (goalY + (p.slot === 0 ? -130 : 130)) - p.y;
      aimX = oppGoalX - p.x; aimY = goalY - p.y;
    } else if (carrier) {
      // Enemy has it — close in and spray bullets to knock it loose.
      moveX = b.x - p.x; moveY = b.y - p.y;
      aimX = b.x - p.x; aimY = b.y - p.y;
      const d = Math.hypot(b.x - p.x, b.y - p.y);
      // A carrier is immune below full charge, so bots must fully charge to strip it.
      if (d < 430) { shoot = true; charge = 1; }
      if (d < 150 && Math.random() < 0.012) special = true; // occasional bomb
    } else {
      // Loose ball — go collect it.
      moveX = b.x - p.x; moveY = b.y - p.y;
      aimX = oppGoalX - p.x; aimY = goalY - p.y;
    }

    const mLen = Math.hypot(moveX, moveY) || 1;
    const aLen = Math.hypot(aimX, aimY) || 1;
    inputs.set(p.id, {
      seq: (inputs.get(p.id)?.seq || 0) + 1,
      moveX: moveX / mLen, moveY: moveY / mLen,
      aimX: aimX / aLen, aimY: aimY / aLen,
      shoot, special, charge,
    });
  }
}

// ---------------------------------------------------------------------------
// Lobby / matchmaking
// ---------------------------------------------------------------------------
function send(ws, obj) {
  if (ws.readyState === ws.OPEN) { try { ws.send(JSON.stringify(obj)); } catch { /* dead socket */ } }
}

// Auto-assign a joining member to the emptier lobby team.
function balancedTeam() {
  let A = 0, B = 0;
  for (const m of members.values()) (m.team === 'B' ? B++ : A++);
  return A <= B ? 'A' : 'B';
}

function lobbyPayload() {
  const list = [...members.values()].map((m) => ({
    id: m.id, name: m.name, avatar: m.avatar || null, team: m.team, ready: m.ready, inMatch: m.inMatch,
  }));
  return {
    type: 'lobby',
    phase: roomPhase,
    countdown: roomPhase === 'countdown' ? Math.max(0, Math.ceil(countdownT)) : 0,
    online: members.size,
    waiting: list.filter((m) => !m.inMatch).length,
    members: list,
  };
}

function broadcastLobby() {
  const payload = lobbyPayload();
  for (const ws of members.keys()) send(ws, payload);
}

function emptyInput() {
  return { seq: 0, moveX: 0, moveY: 0, aimX: 0, aimY: 0, shoot: false, special: false, charge: 0 };
}

// Begin (or refresh) the shared pre-match countdown.
function startCountdown() {
  roomPhase = 'countdown';
  countdownT = COUNTDOWN_TIME;
  broadcastLobby();
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Turn the ready members into a fresh match, honouring each player's chosen team
// (up to 2 per team); empty slots become bots.
function startMatch() {
  const ready = [...members.values()].filter((m) => m.ready && !m.inMatch);
  if (ready.length === 0) { backToLobby(); return; } // everyone bailed during countdown

  state = createState();
  inputs.clear();

  // Take up to TEAM_CAP ready players per chosen team; extras stay waiting.
  const picked = [];
  for (const team of ['A', 'B']) {
    const forTeam = shuffle(ready.filter((m) => (m.team || 'A') === team)).slice(0, TEAM_CAP);
    forTeam.forEach((m, slot) => {
      addPlayer(state, m.id, { name: m.name, char: DEFAULT_CHAR, team, slot, isBot: false });
      inputs.set(m.id, emptyInput());
      m.inMatch = true; m.afk = false; m.lastInputAt = nowMs();
      send(m.ws, { type: 'matchStart', playerId: m.id, team, field: FIELD, chars: CHARACTERS, settings: state.settings });
      picked.push(m);
    });
  }
  if (picked.length === 0) { backToLobby(); return; }
  // Clear ready flags (including extras who didn't fit — they go back to waiting).
  for (const m of members.values()) m.ready = false;

  fillBots();
  attachBall(state, Math.random() < 0.5 ? 'A' : 'B');
  endHoldT = 0;
  roomPhase = 'match';
  broadcastLobby();
}

// No human left in the match -> tear it down and return everyone to the lobby.
function backToLobby() {
  roomPhase = 'lobby';
  countdownT = 0;
  endHoldT = 0;
  for (const m of members.values()) { m.inMatch = false; m.ready = false; m.afk = false; }
  state = createState();
  inputs.clear();
  for (const ws of members.keys()) send(ws, { type: 'toLobby' });
  broadcastLobby();
}

// A member who readies up mid-match drops straight into an open bot slot,
// preferring a slot on the team they chose in the lobby.
function placeIntoMatch(member) {
  const bots = Object.values(state.players).filter((p) => p.isBot);
  const bot = bots.find((p) => p.team === (member.team || 'A')) || bots[0];
  if (!bot) return false; // match full of humans
  const { team, slot } = bot;
  removePlayer(state, bot.id);
  inputs.delete(bot.id);
  addPlayer(state, member.id, { name: member.name, char: DEFAULT_CHAR, team, slot, isBot: false });
  inputs.set(member.id, emptyInput());
  member.team = team; // may differ from preference if that team was full
  member.inMatch = true; member.ready = false; member.afk = false; member.lastInputAt = nowMs();
  send(member.ws, { type: 'matchStart', playerId: member.id, team, field: FIELD, chars: CHARACTERS, settings: state.settings });
  return true;
}

// Convert idle in-match humans to bots; nothing here re-humanizes them — that
// happens the instant a real input arrives (see the 'input' handler).
function checkAfk() {
  const t = nowMs();
  for (const m of members.values()) {
    if (!m.inMatch || m.afk) continue;
    const p = state.players[m.id];
    if (!p) continue;
    if (t - m.lastInputAt > AFK_SECONDS * 1000) { m.afk = true; p.isBot = true; }
  }
}

function humansInMatch() {
  let n = 0;
  for (const m of members.values()) if (m.inMatch) n++;
  return n;
}

// ---------------------------------------------------------------------------
// Game loop
// ---------------------------------------------------------------------------
function tick() {
  try {
    if (roomPhase === 'countdown') {
      countdownT -= DT;
      if (countdownT <= 0) startMatch();
      return;
    }
    if (roomPhase !== 'match') return;

    checkAfk();
    updateBots();
    const inputMap = {};
    for (const [id, inp] of inputs) inputMap[id] = inp;
    step(state, inputMap, DT);
    // Clear one-shot action flags so a held input doesn't re-fire every tick.
    for (const inp of inputs.values()) { inp.shoot = false; inp.special = false; inp.charge = 0; }

    if (state.phase === 'ended') {
      endHoldT += DT; // show the final score, then everyone back to the lobby
      if (endHoldT >= ENDED_HOLD) backToLobby();
    } else if (humansInMatch() === 0) {
      backToLobby();
    }
  } catch (e) {
    if (tickErrCount++ < 5) console.error('TICK ERROR:', (e && e.stack) || e);
  }
}

function snapshot() {
  const r1 = (v) => Math.round(v * 10) / 10;
  const players = Object.values(state.players).map((p) => ({
    id: p.id, name: p.name, char: p.char, team: p.team,
    x: r1(p.x), y: r1(p.y),
    vx: r1(p.vx + p.kvx), vy: r1(p.vy + p.kvy),
    aimX: Math.round(p.aimX * 100) / 100, aimY: Math.round(p.aimY * 100) / 100,
    firing: p.firing, lastSeq: p.lastSeq,
    ammo: p.ammo, reloading: p.reloadLock > 0,
    // progress 0..1 of whatever is refilling next (full reload, or the trickle round)
    reloadFrac: Math.round(100 * (p.reloadLock > 0
      ? 1 - p.reloadLock / EMPTY_RELOAD
      : (p.ammo < MAG_SIZE ? p.ammoT / AMMO_REGEN : 0))) / 100,
  }));
  return {
    type: 'snapshot',
    tick: state.tick,
    phase: state.phase,
    elapsed: Math.floor(state.elapsed),
    resetTimer: state.resetTimer,
    lastGoal: state.lastGoal,
    score: state.score,
    ball: { x: r1(state.ball.x), y: r1(state.ball.y), owner: state.ball.owner },
    players,
    projectiles: state.projectiles.map((p) => ({ id: p.id, x: r1(p.x), y: r1(p.y), team: p.team })),
    bombs: state.bombs.map((b) => ({ id: b.id, x: r1(b.x), y: r1(b.y), team: b.team, fuse: Math.round(b.fuse * 100) / 100 })),
    blasts: state.blasts.map((b) => ({ id: b.id, x: r1(b.x), y: r1(b.y), radius: b.radius, life: b.life, maxLife: b.maxLife })),
    impacts: state.impacts.map((i) => ({
      id: i.id, type: i.type, target: i.target, team: i.team,
      x: r1(i.x), y: r1(i.y), dx: i.dx, dy: i.dy,
      life: i.life, maxLife: i.maxLife,
    })),
  };
}

function broadcastSnapshot() {
  try {
    if (roomPhase !== 'match') return;
    const msg = JSON.stringify(snapshot());
    for (const [ws, m] of members) {
      if (m.inMatch && ws.readyState === ws.OPEN) { try { ws.send(msg); } catch { /* dead socket */ } }
    }
  } catch (e) {
    if (bcErrCount++ < 5) console.error('BROADCAST ERROR:', (e && e.stack) || e);
  }
}

setInterval(tick, 1000 / TICK_RATE);
setInterval(broadcastSnapshot, 1000 / SNAPSHOT_RATE);
setInterval(broadcastLobby, 200); // 5Hz lobby/presence refresh (also drives the countdown)

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

    // First message: identify + enter the lobby.
    if (msg.type === 'join') {
      if (member) return;
      const id = `m-${++memberCounter}`;
      const name = (msg.name || 'Player').toString().slice(0, 16);
      let avatar = (msg.avatar || '').toString().slice(0, 400) || null;
      if (avatar && avatar.startsWith('http://')) avatar = 'https://' + avatar.slice(7);
      const team = balancedTeam(); // auto-balance; player can switch in the lobby
      member = { id, ws, name, avatar, team, ready: false, inMatch: false, afk: false, lastInputAt: nowMs() };
      members.set(ws, member);
      send(ws, { type: 'welcome', id, field: FIELD, chars: CHARACTERS });
      broadcastLobby();
      return;
    }

    if (!member) return;

    // Switch team in the lobby to line up with a friend (not allowed mid-match).
    if (msg.type === 'setTeam') {
      if (member.inMatch || roomPhase === 'match') return;
      if (msg.team === 'A' || msg.team === 'B') { member.team = msg.team; broadcastLobby(); }
      return;
    }

    // Press "Play Now".
    if (msg.type === 'ready') {
      if (member.inMatch) return;
      member.ready = true;
      if (roomPhase === 'lobby') startCountdown();
      else if (roomPhase === 'match') placeIntoMatch(member);
      // during 'countdown' the flag is enough — they join at kickoff
      broadcastLobby();
      return;
    }

    if (msg.type === 'input') {
      if (!member.inMatch) return;
      const active = (Math.abs(msg.moveX || 0) + Math.abs(msg.moveY || 0) > 0.1) || !!msg.shoot || !!msg.special;
      if (active) {
        member.lastInputAt = nowMs();
        if (member.afk) { member.afk = false; const p = state.players[member.id]; if (p) p.isBot = false; } // reclaim
      }
      const prev = inputs.get(member.id) || {};
      let charge = prev.charge || 0;
      if (msg.shoot) charge = msg.charge || 0;
      inputs.set(member.id, {
        seq: msg.seq,
        moveX: msg.moveX || 0,
        moveY: msg.moveY || 0,
        aimX: msg.aimX || 0,
        aimY: msg.aimY || 0,
        shoot: prev.shoot || !!msg.shoot,
        special: prev.special || !!msg.special,
        charge,
      });
      return;
    }

    if (msg.type === 'settings' && msg.settings) { applySettings(msg.settings); return; }

    if (msg.type === 'ping') { send(ws, { type: 'pong', t: msg.t }); return; }

    } catch (e) { if (msgErrCount++ < 5) console.error('MSG ERROR:', (e && e.stack) || e); }
  });

  ws.on('close', () => {
    if (!member) return;
    const wasInMatch = member.inMatch;
    members.delete(ws);
    if (wasInMatch && roomPhase === 'match') {
      // Replace the leaver with a bot so the match keeps 2v2 shape.
      if (state.players[member.id]) { removePlayer(state, member.id); inputs.delete(member.id); }
      fillBots();
      if (humansInMatch() === 0) backToLobby();
    }
    broadcastLobby();
  });
});

server.listen(PORT, () => {
  console.log(`\n⚽ Football mock running:`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   Lobby -> Play Now -> ${COUNTDOWN_TIME}s countdown -> match (bots fill empty slots).\n`);
});
