// Authoritative game server + tiny static file server.
// - Serves the web game from /public and /shared
// - Runs ONE match room at a fixed 30Hz tick
// - Fills empty slots with bots so a single player can test the feel
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
// Match room
// ---------------------------------------------------------------------------
let state = createState();
const clients = new Map(); // ws -> playerId
const inputs = new Map(); // playerId -> latest input
let botCounter = 0;
let paused = false; // toggled from the in-game pause menu
let msgErrCount = 0; // throttle logging of message-handler errors

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

// Humans always join Team A (blue, left, attacking right). Replace a Team-A bot
// if present; else take a free A slot; only fall back to B if A is full of humans.
function humanSlot() {
  const aBot = Object.values(state.players).find((p) => p.isBot && p.team === 'A');
  if (aBot) {
    const { slot } = aBot;
    removePlayer(state, aBot.id);
    inputs.delete(aBot.id);
    return { team: 'A', slot };
  }
  const usedA = new Set(Object.values(state.players).filter((p) => p.team === 'A').map((p) => p.slot));
  if (!usedA.has(0)) return { team: 'A', slot: 0 };
  if (!usedA.has(1)) return { team: 'A', slot: 1 };
  // Team A full of humans -> fall back to a Team-B bot.
  const bBot = Object.values(state.players).find((p) => p.isBot && p.team === 'B');
  if (bBot) { const { slot } = bBot; removePlayer(state, bBot.id); inputs.delete(bBot.id); return { team: 'B', slot }; }
  return assignSlot();
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
      if (d < 430) { shoot = true; charge = d > 200 ? 0.7 : 0.35; }
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
// Game loop — endless; the match never ends, goals just keep tallying.
// ---------------------------------------------------------------------------
let tickErrCount = 0;
function tick() {
  if (paused) return; // frozen; broadcast keeps sending the last snapshot
  try {
    updateBots();
    const inputMap = {};
    for (const [id, inp] of inputs) inputMap[id] = inp;
    step(state, inputMap, DT);
    // Clear one-shot action flags so a held input doesn't re-fire every tick.
    for (const inp of inputs.values()) { inp.shoot = false; inp.special = false; inp.charge = 0; }
  } catch (e) {
    // Never let a bad tick crash the process — log it (throttled) and keep going.
    if (tickErrCount++ < 5) console.error('TICK ERROR:', (e && e.stack) || e);
  }
}

function snapshot() {
  const r1 = (v) => Math.round(v * 10) / 10;
  const players = Object.values(state.players).map((p) => ({
    id: p.id, name: p.name, char: p.char, team: p.team,
    x: r1(p.x), y: r1(p.y),
    aimX: Math.round(p.aimX * 100) / 100, aimY: Math.round(p.aimY * 100) / 100,
    firing: p.firing, lastSeq: p.lastSeq,
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
  };
}

let bcErrCount = 0;
function broadcast() {
  try {
    const snap = snapshot();
    const msg = JSON.stringify(snap);
    for (const ws of clients.keys()) {
      if (ws.readyState === ws.OPEN) { try { ws.send(msg); } catch { /* dead socket */ } }
    }
  } catch (e) {
    if (bcErrCount++ < 5) console.error('BROADCAST ERROR:', (e && e.stack) || e);
  }
}

setInterval(tick, 1000 / TICK_RATE);
setInterval(broadcast, 1000 / SNAPSHOT_RATE);

// ---------------------------------------------------------------------------
// WebSocket handling
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let playerId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    try {

    if (msg.type === 'join') {
      if (playerId) return;
      const char = DEFAULT_CHAR;
      const name = (msg.name || 'Player').toString().slice(0, 14);
      const { team, slot } = humanSlot();
      playerId = `p-${Date.now()}-${Math.floor(state.tick)}-${clients.size}`;
      addPlayer(state, playerId, { name, char, team, slot, isBot: false });
      inputs.set(playerId, { seq: 0, moveX: 0, moveY: 0, aimX: 0, aimY: 0, shoot: false, special: false, charge: 0 });
      clients.set(ws, playerId);
      fillBots(); // top back up to 4 in case teams were uneven
      ws.send(JSON.stringify({
        type: 'welcome', playerId, team, char,
        field: FIELD, chars: CHARACTERS,
      }));
      return;
    }

    if (msg.type === 'input' && playerId) {
      const prev = inputs.get(playerId) || {};
      // Latch the charge captured on the frame that set shoot.
      let charge = prev.charge || 0;
      if (msg.shoot) charge = msg.charge || 0;
      inputs.set(playerId, {
        seq: msg.seq,
        moveX: msg.moveX || 0,
        moveY: msg.moveY || 0,
        aimX: msg.aimX || 0,
        aimY: msg.aimY || 0,
        // latch one-shot actions true until the tick consumes them
        shoot: prev.shoot || !!msg.shoot,
        special: prev.special || !!msg.special,
        charge,
      });
      return;
    }

    if (msg.type === 'settings' && msg.settings) {
      applySettings(msg.settings);
      return;
    }

    if (msg.type === 'pause') {
      paused = !!msg.paused;
      return;
    }

    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', t: msg.t }));
    }

    } catch (e) { if (msgErrCount++ < 5) console.error('MSG ERROR:', (e && e.stack) || e); }
  });

  ws.on('close', () => {
    if (playerId) {
      removePlayer(state, playerId);
      inputs.delete(playerId);
      clients.delete(ws);
      fillBots(); // replace the leaver with a bot
    }
  });
});

fillBots();
attachBall(state, 'A'); // kick off with Team A (Blue) in possession
server.listen(PORT, () => {
  console.log(`\n⚽ Football mock running:`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   Open in 4 tabs for 4 real players, or play solo vs bots.\n`);
});
