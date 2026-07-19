// Web game client: renders the authoritative state with client-side prediction
// for your own player and interpolation for everyone else + the ball.

import {
  FIELD, GOAL, POST_R, BALL_RADIUS, CHARACTERS, TEAM, PROJECTILE, BOMB, MOVE_ACCEL,
  SHOOT_CHARGE_TIME, clamp,
} from '/shared/constants.js';

const INPUT_RATE = 30;         // inputs sent per second (matches server tick)
const INPUT_DT = 1 / INPUT_RATE;
const INTERP_DELAY = 100;      // ms we render remote entities in the past
const GOAL_TOP = (FIELD.H - GOAL.width) / 2;
const GOAL_BOTTOM = (FIELD.H + GOAL.width) / 2;

// --------------------------------------------------------------------------
// State
// --------------------------------------------------------------------------
let ws = null;
let me = { playerId: null, team: null, char: 'striker' };
let snaps = [];                // interpolation buffer: {tRecv, snap}
let latest = null;             // most recent snapshot (for HUD/own authoritative)
let predicted = null;          // {x, y} predicted own position
let rendered = null;           // {x, y} smoothed own position actually drawn
let predVel = { x: 0, y: 0 };  // predicted own velocity (eased — matches the sim)
let seq = 0;
let ping = 0;
let snapCount = 0;   // snapshots received since last sample
let snapRate = 0;    // snapshots/sec (on-screen diagnostic)
setInterval(() => { snapRate = snapCount; snapCount = 0; }, 1000);

const chosenChar = 'player'; // one player type
let holdingBall = false;     // am I currently carrying the ball?

// Live-tunable settings (pause menu). Client keeps its own copy for prediction
// + rendering and pushes changes to the authoritative server.
const settings = {
  speedMul: 0.8,
  sizeMul: 1.25,
  carrySpeedMul: 0.9,
  ballSizeMul: 2,
  shotPower: 1000,
  bulletSpeed: 720,
  bulletKnockback: 1500,
  bombPower: 1500,
};

// --- On-device crash reporting: show any runtime error on screen ---
function showFatal(msg) {
  try {
    const el = document.getElementById('fatal');
    if (!el) return;
    el.classList.remove('hidden');
    el.textContent = '⚠️ ERROR (screenshot this):\n' + msg;
  } catch { /* ignore */ }
}
addEventListener('error', (e) => showFatal(`${e.message}\n${(e.filename || '').split('/').pop()}:${e.lineno || '?'}:${e.colno || '?'}`));
addEventListener('unhandledrejection', (e) => showFatal('promise: ' + ((e.reason && e.reason.message) || e.reason)));

// --------------------------------------------------------------------------
// Start screen
// --------------------------------------------------------------------------
const startEl = document.getElementById('start');
const gameEl = document.getElementById('game');

const specialIcon = () => '💣'; // special is Bomb

document.getElementById('play').addEventListener('click', () => {
  const name = 'Player'; // names aren't shown in-game
  startEl.classList.add('hidden');
  gameEl.classList.remove('hidden');
  document.getElementById('special').textContent = specialIcon(chosenChar);
  resize();
  connect(name, chosenChar);
});

// --------------------------------------------------------------------------
// Networking
// --------------------------------------------------------------------------
function connect(name, char) {
  // wss when the page is served over https (Render), ws for local dev.
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}`);
  ws.onopen = () => {
    setNet('connected');
    ws.send(JSON.stringify({ type: 'join', name, char }));
    setInterval(sendPing, 1500);
  };
  ws.onclose = () => setNet('disconnected');
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'welcome') {
      me = { playerId: msg.playerId, team: msg.team, char: msg.char };
      specialBtn.textContent = specialIcon(msg.char);
      renderBackground(); // re-cache stands with the correct team colours
    } else if (msg.type === 'snapshot') {
      latest = msg;
      snapCount++;
      holdingBall = msg.ball.owner === me.playerId;
      snaps.push({ tRecv: performance.now(), snap: msg });
      if (snaps.length > 60) snaps.shift();
      reconcile(msg);
    } else if (msg.type === 'pong') {
      ping = Math.round(performance.now() - msg.t);
    }
  };
}

function sendPing() {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'ping', t: performance.now() }));
}

function setNet(s) {
  document.getElementById('net').textContent = s === 'connected' ? 'live' : s;
}

// --------------------------------------------------------------------------
// Prediction + reconciliation (own player, movement only)
// --------------------------------------------------------------------------
function ownSpeed() {
  const base = (CHARACTERS[me.char]?.speed || CHARACTERS.player.speed) * settings.speedMul;
  return holdingBall ? base * settings.carrySpeedMul : base;
}
function ownRadius() { return (CHARACTERS[me.char]?.radius || 21) * settings.sizeMul; }

// Advance the local prediction one input step, easing velocity like the sim.
function stepPrediction(moveX, moveY, dt) {
  let mx = moveX, my = moveY;
  const len = Math.hypot(mx, my);
  if (len > 1) { mx /= len; my /= len; }
  const tvx = mx * ownSpeed(), tvy = my * ownSpeed();
  predVel.x += (tvx - predVel.x) * MOVE_ACCEL;
  predVel.y += (tvy - predVel.y) * MOVE_ACCEL;
  const r = ownRadius();
  predicted.x = clamp(predicted.x + predVel.x * dt, r, FIELD.W - r);
  predicted.y = clamp(predicted.y + predVel.y * dt, r, FIELD.H - r);
}

// Gently pull the prediction toward the authoritative position (no hard replay
// — keeps motion smooth on a low-latency LAN).
function reconcile(snap) {
  const server = snap.players.find((p) => p.id === me.playerId);
  if (!server) return;
  if (!predicted) { predicted = { x: server.x, y: server.y }; rendered = { ...predicted }; return; }
  if (snap.resetTimer > 0) { // kickoff freeze: sit exactly where the server puts us
    predicted.x = server.x; predicted.y = server.y; predVel.x = 0; predVel.y = 0; return;
  }
  predicted.x += (server.x - predicted.x) * 0.2;
  predicted.y += (server.y - predicted.y) * 0.2;
}

// --------------------------------------------------------------------------
// Input — keyboard/mouse (desktop) + dual touch joysticks (mobile)
// --------------------------------------------------------------------------
let shootQueued = false;   // a shot was released this frame
let specialQueued = false; // special skill
let aimHold = null;        // aim captured at right-stick release
let chargeStart = null;    // timestamp when the current aim-hold began (charging)
let pendingCharge = 0;     // 0..1 charge captured on release

const CHARGE_MS = SHOOT_CHARGE_TIME * 1000;
function beginCharge() { if (chargeStart === null) chargeStart = performance.now(); }
function currentCharge() { return chargeStart === null ? 0 : Math.min(1, (performance.now() - chargeStart) / CHARGE_MS); }
function releaseShot(aim) { pendingCharge = currentCharge(); if (aim) aimHold = aim; shootQueued = true; chargeStart = null; }

const keys = {};
addEventListener('keydown', (e) => {
  keys[e.key.toLowerCase()] = true;
  if (e.key === ' ' && !e.repeat) beginCharge();     // hold space to charge
  if (e.key.toLowerCase() === 'e') specialQueued = true;
});
addEventListener('keyup', (e) => {
  keys[e.key.toLowerCase()] = false;
  if (e.key === ' ') releaseShot();                  // release to fire
});

let mouse = { x: 0, y: 0, down: false };
const canvas = document.getElementById('canvas');
canvas.addEventListener('mousemove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; });
canvas.addEventListener('mousedown', (e) => {
  if (e.button === 2) { specialQueued = true; }   // right-click = special
  else { mouse.down = true; beginCharge(); }       // hold left-click to charge
});
addEventListener('mouseup', (e) => { if (mouse.down && e.button !== 2) releaseShot(); mouse.down = false; });
addEventListener('contextmenu', (e) => e.preventDefault());

// Special-skill button (touch + click)
const specialBtn = document.getElementById('special');
const pauseBtn = document.getElementById('pause-btn');
const settingsPanel = document.getElementById('settings');
function triggerSpecial(e) { if (e) e.preventDefault(); specialQueued = true; flashSpecialCooldown(); }
specialBtn.addEventListener('touchstart', triggerSpecial, { passive: false });
specialBtn.addEventListener('mousedown', triggerSpecial);

// Local cooldown shading for the button (approximate; server is authoritative).
let specialCdUntil = 0;
function flashSpecialCooldown() {
  const cd = (CHARACTERS[me.char] || CHARACTERS.player).specialCooldown * 1000;
  specialCdUntil = performance.now() + cd;
}

// --- Pause + settings panel ---
const SETTING_KEYS = ['speedMul', 'sizeMul', 'carrySpeedMul', 'ballSizeMul', 'shotPower', 'bulletSpeed', 'bulletKnockback', 'bombPower'];
const SETTING_FMT = {
  speedMul: (v) => v.toFixed(2) + '×',
  sizeMul: (v) => v.toFixed(2) + '×',
  carrySpeedMul: (v) => v.toFixed(2) + '×',
  ballSizeMul: (v) => v.toFixed(2) + '×',
  shotPower: (v) => String(Math.round(v)),
  bulletSpeed: (v) => String(Math.round(v)),
  bulletKnockback: (v) => String(Math.round(v)),
  bombPower: (v) => String(Math.round(v)),
};

function syncSliderUI() {
  for (const k of SETTING_KEYS) {
    const slider = document.getElementById('s-' + k);
    const label = document.getElementById('v-' + k);
    if (slider) slider.value = settings[k];
    if (label) label.textContent = SETTING_FMT[k](settings[k]);
  }
}
function sendSettings() {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'settings', settings }));
}
function openSettings() {
  shootQueued = false; specialQueued = false; aimHold = null;
  settingsPanel.classList.remove('hidden');
  syncSliderUI();
}
function closeSettings() {
  settingsPanel.classList.add('hidden');
}
pauseBtn.addEventListener('click', openSettings);
document.getElementById('resume').addEventListener('click', closeSettings);
document.getElementById('reset-settings').addEventListener('click', () => {
  settings.speedMul = 0.8; settings.sizeMul = 1.25;
  settings.carrySpeedMul = 0.9; settings.ballSizeMul = 2; settings.shotPower = 1000;
  settings.bulletSpeed = 720;
  settings.bulletKnockback = 1500;
  settings.bombPower = 1500;
  syncSliderUI(); sendSettings();
});
for (const k of SETTING_KEYS) {
  const slider = document.getElementById('s-' + k);
  if (!slider) continue;
  slider.addEventListener('input', () => {
    settings[k] = parseFloat(slider.value);
    document.getElementById('v-' + k).textContent = SETTING_FMT[k](settings[k]);
    sendSettings();
  });
}

// Touch joysticks
const stickL = document.getElementById('stickL');
const stickR = document.getElementById('stickR');
const touchL = { id: null, cx: 0, cy: 0, dx: 0, dy: 0 };
const touchR = { id: null, cx: 0, cy: 0, dx: 0, dy: 0, active: false };
let usingTouch = false;
const STICK_MAX = 52;

function placeStick(el, cx, cy, dx, dy) {
  el.classList.remove('hidden');
  el.style.left = `${cx - 60}px`;
  el.style.top = `${cy - 60}px`;
  el.querySelector('.knob').style.transform = `translate(${dx}px, ${dy}px)`;
}

addEventListener('touchstart', (e) => {
  usingTouch = true;
  if (!settingsPanel.classList.contains('hidden')) return; // paused: ignore game touches
  for (const t of e.changedTouches) {
    if (specialBtn.contains(t.target) || pauseBtn.contains(t.target)) continue; // buttons aren't sticks
    const left = t.clientX < innerWidth / 2;
    if (left && touchL.id === null) {
      touchL.id = t.identifier; touchL.cx = t.clientX; touchL.cy = t.clientY; touchL.dx = 0; touchL.dy = 0;
      placeStick(stickL, touchL.cx, touchL.cy, 0, 0);
    } else if (!left && touchR.id === null) {
      touchR.id = t.identifier; touchR.cx = t.clientX; touchR.cy = t.clientY; touchR.dx = 0; touchR.dy = 0; touchR.active = true;
      placeStick(stickR, touchR.cx, touchR.cy, 0, 0);
      beginCharge(); // start charging as soon as you touch the aim stick
    }
  }
}, { passive: false });

addEventListener('touchmove', (e) => {
  for (const t of e.changedTouches) {
    if (t.identifier === touchL.id) updateStick(touchL, stickL, t);
    else if (t.identifier === touchR.id) updateStick(touchR, stickR, t);
  }
}, { passive: false });

function updateStick(stick, el, t) {
  let dx = t.clientX - stick.cx, dy = t.clientY - stick.cy;
  const len = Math.hypot(dx, dy);
  if (len > STICK_MAX) { dx = dx / len * STICK_MAX; dy = dy / len * STICK_MAX; }
  stick.dx = dx; stick.dy = dy;
  el.querySelector('.knob').style.transform = `translate(${dx}px, ${dy}px)`;
}

addEventListener('touchend', (e) => {
  for (const t of e.changedTouches) {
    if (t.identifier === touchL.id) {
      // Left stick is MOVE: just stop.
      touchL.id = null; touchL.dx = 0; touchL.dy = 0; stickL.classList.add('hidden');
    }
    else if (t.identifier === touchR.id) {
      // Right stick is AIM. Dragged past the deadzone -> aimed charged shot.
      // A quick tap (no drag) -> instant QUICK SHOT in the current facing dir.
      if (Math.hypot(touchR.dx, touchR.dy) > 12) releaseShot({ x: touchR.dx, y: touchR.dy });
      else releaseShot(); // quick shot (low charge, current aim)
      touchR.id = null; touchR.dx = 0; touchR.dy = 0; touchR.active = false; stickR.classList.add('hidden');
    }
  }
}, { passive: false });

// iOS can fire touchcancel instead of touchend (system gesture / notification).
// Reset the sticks so a controller can never get stuck.
addEventListener('touchcancel', (e) => {
  for (const t of e.changedTouches) {
    if (t.identifier === touchL.id) { touchL.id = null; touchL.dx = 0; touchL.dy = 0; stickL.classList.add('hidden'); }
    else if (t.identifier === touchR.id) { chargeStart = null; touchR.id = null; touchR.dx = 0; touchR.dy = 0; touchR.active = false; stickR.classList.add('hidden'); }
  }
}, { passive: false });

// Build the current input from whichever control scheme is active.
function sampleInput() {
  // Settings pause only this player. A realtime multiplayer room must never be
  // globally frozen by one client (especially if that client disconnects).
  if (!settingsPanel.classList.contains('hidden')) {
    return { moveX: 0, moveY: 0, aimX: 0, aimY: 0, shoot: false, special: false, charge: 0 };
  }
  let moveX = 0, moveY = 0, aimX = 0, aimY = 0;

  if (usingTouch) {
    // Left stick = move, right stick = aim (release to shoot).
    moveX = touchL.dx / STICK_MAX; moveY = touchL.dy / STICK_MAX;
    aimX = touchR.dx / STICK_MAX; aimY = touchR.dy / STICK_MAX;
  } else {
    if (keys['w'] || keys['arrowup']) moveY -= 1;
    if (keys['s'] || keys['arrowdown']) moveY += 1;
    if (keys['a'] || keys['arrowleft']) moveX -= 1;
    if (keys['d'] || keys['arrowright']) moveX += 1;
    // aim = from own player toward mouse (world space)
    if (rendered) {
      const w = screenToWorld(mouse.x, mouse.y);
      aimX = w.x - rendered.x; aimY = w.y - rendered.y;
      const l = Math.hypot(aimX, aimY) || 1; aimX /= l; aimY /= l;
    }
  }
  // A right-stick release captured its aim direction — use it for this shot.
  if (aimHold) { aimX = aimHold.x; aimY = aimHold.y; aimHold = null; }
  const shoot = shootQueued; shootQueued = false;
  const special = specialQueued; specialQueued = false;
  const charge = shoot ? pendingCharge : 0;
  if (shoot) pendingCharge = 0;
  return { moveX, moveY, aimX, aimY, shoot, special, charge };
}

// Send inputs + advance prediction at a fixed rate.
setInterval(() => {
  if (!ws || ws.readyState !== ws.OPEN || !me.playerId) return;
  try {
    const inp = sampleInput();
    seq++;
    ws.send(JSON.stringify({ type: 'input', seq, ...inp }));
    if (predicted && !(latest && latest.resetTimer > 0)) stepPrediction(inp.moveX, inp.moveY, INPUT_DT);
  } catch (e) { showFatal('input: ' + e.message); }
}, 1000 / INPUT_RATE);

// --------------------------------------------------------------------------
// Rendering
// --------------------------------------------------------------------------
const mainCtx = canvas.getContext('2d');
// Offscreen canvas caches the STATIC field (grass, lines, goals, stands) for the
// whole world incl. the behind-goal net areas; blitted at the camera offset.
const bgCanvas = document.createElement('canvas');
const bgCtx = bgCanvas.getContext('2d');
let ctx = mainCtx;          // active draw target
let scale = 1, dpr = 1;     // scale = canvas px per world unit (dpr folded in)
let camX = 0, camY = 0;     // camera offset in canvas px (subtracted in wx/wy)
const NET = GOAL.depth;     // net depth behind each goal line

function resize() {
  dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  // Tighter zoom (Brawl-Stars-like): the player renders large and the camera
  // scrolls in both axes, showing ~half the arena at a time.
  scale = 1.85 * canvas.width / FIELD.W;
  bgCanvas.width = Math.ceil((FIELD.W + 2 * NET) * scale);
  bgCanvas.height = Math.ceil(FIELD.H * scale);
  renderBackground();
}

// Centre the camera on the local player, clamped to the field (+ behind-goal net).
function updateCamera() {
  const cx = rendered ? rendered.x : FIELD.W / 2;
  const cy = rendered ? rendered.y : FIELD.H / 2;
  const minX = -NET * scale, maxX = (FIELD.W + NET) * scale - canvas.width;
  camX = clamp(cx * scale - canvas.width / 2, minX, Math.max(minX, maxX));
  const fieldHpx = FIELD.H * scale;
  if (fieldHpx <= canvas.height) camY = (fieldHpx - canvas.height) / 2; // centre vertically
  else camY = clamp(cy * scale - canvas.height / 2, 0, fieldHpx - canvas.height);
}

// World -> canvas px (through the camera). scale already includes dpr.
function wx(x) { return x * scale - camX; }
function wy(y) { return y * scale - camY; }
function ws_(v) { return v * scale; }
function screenToWorld(px, py) { return { x: (px * dpr + camX) / scale, y: (py * dpr + camY) / scale }; }

// Render the static field to the offscreen cache. Temporarily point the camera so
// wx/wy produce bg-local coords (bg pixel 0,0 = world (-NET, 0)).
function renderBackground() {
  const sx = camX, sy = camY, sctx = ctx;
  camX = -NET * scale; camY = 0; ctx = bgCtx;
  try {
    bgCtx.clearRect(0, 0, bgCanvas.width, bgCanvas.height);
    drawStands();
    drawField();
  } finally { ctx = sctx; camX = sx; camY = sy; }
}
addEventListener('resize', resize);

// Interpolate remote entities to `renderTime`.
function interpolated() {
  const renderTime = performance.now() - INTERP_DELAY;
  let s0 = null, s1 = null;
  for (let i = snaps.length - 1; i >= 0; i--) {
    if (snaps[i].tRecv <= renderTime) { s0 = snaps[i]; s1 = snaps[i + 1] || snaps[i]; break; }
  }
  if (!s0) { s0 = snaps[0]; s1 = snaps[0]; }
  if (!s0) return null;
  const span = s1.tRecv - s0.tRecv;
  const t = span > 0 ? clamp((renderTime - s0.tRecv) / span, 0, 1) : 0;

  const lerp = (a, b) => a + (b - a) * t;
  const a = s0.snap, b = s1.snap;
  const players = a.players.map((pa) => {
    const pb = b.players.find((p) => p.id === pa.id) || pa;
    return {
      ...pa,
      x: lerp(pa.x, pb.x), y: lerp(pa.y, pb.y),
      aimX: lerp(pa.aimX, pb.aimX), aimY: lerp(pa.aimY, pb.aimY),
    };
  });
  const ball = { x: lerp(a.ball.x, b.ball.x), y: lerp(a.ball.y, b.ball.y), owner: b.ball.owner };
  const bProj = new Map((b.projectiles || []).map((p) => [p.id, p]));
  const projectiles = (a.projectiles || []).map((pa) => {
    const pb = bProj.get(pa.id);
    return pb ? { ...pa, x: lerp(pa.x, pb.x), y: lerp(pa.y, pb.y) } : pa;
  });
  return { players, ball, projectiles, bombs: a.bombs || [], blasts: a.blasts || [] };
}

function roundRect(c, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

// Fans behind each goal (in the net-behind area), in that team's colour.
function drawStands() {
  drawFanWall(-NET, 0, TEAM.A.color);                 // behind A's (left) goal
  drawFanWall(FIELD.W, FIELD.W + NET, TEAM.B.color);   // behind B's (right) goal
}
function drawFanWall(x0, x1, color) {
  ctx.fillStyle = '#222923';
  ctx.fillRect(wx(x0), wy(0), ws_(x1 - x0), ws_(FIELD.H));
  // Stone block courses make the side strips feel like compact stadium stands.
  const block = ws_(24);
  for (let y = 0; y < FIELD.H; y += 24) {
    for (let x = x0; x < x1; x += 24) {
      const odd = (Math.floor(y / 24) + Math.floor((x - x0) / 24)) % 2;
      ctx.fillStyle = odd ? '#465149' : '#566058';
      ctx.fillRect(wx(x) + 1, wy(y) + 1, block - 2, block - 2);
      ctx.fillStyle = 'rgba(255,255,255,.08)';
      ctx.fillRect(wx(x) + 2, wy(y) + 2, block - 4, Math.max(1, ws_(3)));
    }
  }
  const cw = ws_(14), ch = ws_(14), gap = ws_(8);
  const wpx = ws_(x1 - x0), hpx = ws_(FIELD.H);
  const cols = Math.max(1, Math.floor(wpx / (cw + gap)));
  const rows = Math.max(1, Math.floor(hpx / (ch + gap)));
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const px = wx(x0) + gap + c * (cw + gap);
    const py = wy(0) + gap + r * (ch + gap);
    ctx.fillStyle = '#d5ad75'; ctx.fillRect(px + cw * .2, py, cw * .6, ch * .42);
    ctx.fillStyle = color; ctx.fillRect(px, py + ch * .38, cw, ch * .62);
    ctx.fillStyle = 'rgba(255,255,255,.22)'; ctx.fillRect(px, py + ch * .38, cw, ch * .14);
  }
}

function drawField() {
  // Original block-grass pattern: large tiles with tiny pixel flecks.
  ctx.fillStyle = '#4b9c36';
  ctx.fillRect(wx(0), wy(0), ws_(FIELD.W), ws_(FIELD.H));
  const tile = 50;
  for (let gy = 0; gy < FIELD.H; gy += tile) {
    for (let gx = 0; gx < FIELD.W; gx += tile) {
      const odd = (Math.floor(gx / tile) + Math.floor(gy / tile)) % 2;
      ctx.fillStyle = odd ? '#4f9f38' : '#469234';
      ctx.fillRect(wx(gx), wy(gy), ws_(tile + 1), ws_(tile + 1));
      ctx.fillStyle = odd ? '#62ad44' : '#3e842e';
      ctx.fillRect(wx(gx + 8), wy(gy + 10), ws_(7), ws_(4));
      ctx.fillRect(wx(gx + 33), wy(gy + 35), ws_(5), ws_(3));
    }
  }
  ctx.strokeStyle = '#e9e0b8'; ctx.lineWidth = Math.max(2, ws_(5));
  ctx.strokeRect(wx(5), wy(5), ws_(FIELD.W - 10), ws_(FIELD.H - 10));
  ctx.beginPath(); ctx.moveTo(wx(FIELD.W / 2), wy(5)); ctx.lineTo(wx(FIELD.W / 2), wy(FIELD.H - 5)); ctx.stroke();
  // Stepped centre circle reads as a ring built from pale blocks.
  const cx = FIELD.W / 2, cy = FIELD.H / 2, rr = 80, pieces = 32;
  ctx.fillStyle = '#e9e0b8';
  for (let i = 0; i < pieces; i++) {
    const a = i / pieces * Math.PI * 2;
    ctx.fillRect(wx(cx + Math.cos(a) * rr - 4), wy(cy + Math.sin(a) * rr - 4), ws_(8), ws_(8));
  }
  ctx.fillRect(wx(cx - 5), wy(cy - 5), ws_(10), ws_(10));
  drawGoal(0, -NET);              // left: line at x=0, net behind (to -NET)
  drawGoal(FIELD.W, FIELD.W + NET); // right: line at x=W, net behind (to W+NET)
}
function drawGoal(lineX, backX) {
  const x0 = Math.min(lineX, backX), w = Math.abs(backX - lineX);
  // Dark inset and square rope lattice.
  ctx.fillStyle = 'rgba(20,25,20,.35)';
  ctx.fillRect(wx(x0), wy(GOAL_TOP), ws_(w), ws_(GOAL.width));
  ctx.strokeStyle = 'rgba(242,229,181,.48)'; ctx.lineWidth = Math.max(1, ws_(2));
  for (let i = 1; i < 5; i++) { const gx = x0 + (w / 5) * i; ctx.beginPath(); ctx.moveTo(wx(gx), wy(GOAL_TOP)); ctx.lineTo(wx(gx), wy(GOAL_BOTTOM)); ctx.stroke(); }
  for (let j = 1; j < 6; j++) { const gy = GOAL_TOP + (GOAL.width / 6) * j; ctx.beginPath(); ctx.moveTo(wx(x0), wy(gy)); ctx.lineTo(wx(x0 + w), wy(gy)); ctx.stroke(); }
  // Block-built crossbar and chunky collision posts.
  ctx.strokeStyle = '#f1e7c4'; ctx.lineWidth = Math.max(3, ws_(7));
  ctx.beginPath(); ctx.moveTo(wx(lineX), wy(GOAL_TOP)); ctx.lineTo(wx(lineX), wy(GOAL_BOTTOM)); ctx.stroke();
  for (const py of [GOAL_TOP, GOAL_BOTTOM]) {
    const pr = ws_(POST_R * 1.4);
    ctx.fillStyle = '#827b68'; ctx.fillRect(wx(lineX) - pr, wy(py) - pr + ws_(2), pr * 2, pr * 2);
    ctx.fillStyle = '#fff5d4'; ctx.fillRect(wx(lineX) - pr, wy(py) - pr, pr * 2, pr * 1.35);
  }
}

function drawPlayer(p) {
  const ch = CHARACTERS[p.char] || CHARACTERS.player;
  const isMe = p.id === me.playerId;
  const x = wx(p.x), y = wy(p.y), r = ws_(ch.radius * settings.sizeMul);
  const team = TEAM[p.team].color;
  const ang = Math.atan2(p.aimY, p.aimX) + Math.PI / 2;
  const unit = Math.max(2, r / 7);
  ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
  // Square ground shadow, boots, body, arms and head form a tiny block athlete.
  ctx.fillStyle = 'rgba(17,27,15,.35)'; ctx.fillRect(-r * .78, -r * .55 + unit * 3, r * 1.56, r * 1.35);
  ctx.fillStyle = '#252824';
  ctx.fillRect(-r * .7, r * .37, r * .52, r * .42); ctx.fillRect(r * .18, r * .37, r * .52, r * .42);
  ctx.fillStyle = team;
  ctx.fillRect(-r * .82, -r * .25, r * 1.64, r * .85);
  ctx.fillStyle = 'rgba(255,255,255,.82)';
  ctx.fillRect(-r * .82, r * .07, r * 1.64, unit * 1.35);
  ctx.fillStyle = team;
  ctx.fillRect(-r * 1.03, -r * .18, r * .23, r * .62); ctx.fillRect(r * .8, -r * .18, r * .23, r * .62);
  // Square head faces the aim direction (up in local space).
  ctx.fillStyle = '#916439'; ctx.fillRect(-r * .58, -r * .96 + unit, r * 1.16, r * .86);
  ctx.fillStyle = '#d6a46e'; ctx.fillRect(-r * .58, -r * .96, r * 1.16, r * .73);
  ctx.fillStyle = '#2a1b12';
  ctx.fillRect(-r * .38, -r * .98, r * .76, unit * 1.7);
  ctx.fillRect(-r * .34, -r * .64, unit * 1.35, unit * 1.35);
  ctx.fillRect(r * .16, -r * .64, unit * 1.35, unit * 1.35);
  if (p.firing) {
    ctx.strokeStyle = '#ffd54c'; ctx.lineWidth = unit * 1.5;
    ctx.strokeRect(-r * 1.12, -r * 1.1, r * 2.24, r * 2.12);
  }
  ctx.restore();
  // Crisp selection bracket and arrow for the local player.
  if (isMe) {
    ctx.strokeStyle = '#fff2a8'; ctx.lineWidth = Math.max(2, ws_(3));
    ctx.strokeRect(x - r * 1.2, y - r * 1.2, r * 2.4, r * 2.4);
    const ty = y - r * 1.55;
    ctx.fillStyle = '#ffdd43'; ctx.fillRect(x - ws_(5), ty, ws_(10), ws_(8));
    ctx.fillRect(x - ws_(2), ty + ws_(8), ws_(4), ws_(4));
  }
}

function drawBall(b) {
  const x = wx(b.x), y = wy(b.y), r = ws_(BALL_RADIUS * settings.ballSizeMul);
  // Pixel football with clipped square corners and a simple dark patch pattern.
  const s = r * .38;
  ctx.fillStyle = 'rgba(20,28,18,.28)'; ctx.fillRect(x - r * .8, y + r * .65, r * 1.6, r * .42);
  ctx.fillStyle = '#24231f'; ctx.fillRect(x - r, y - r * .62, r * 2, r * 1.24); ctx.fillRect(x - r * .62, y - r, r * 1.24, r * 2);
  ctx.fillStyle = '#f8efd5'; ctx.fillRect(x - r * .83, y - r * .52, r * 1.66, r * 1.04); ctx.fillRect(x - r * .52, y - r * .83, r * 1.04, r * 1.66);
  ctx.fillStyle = '#292923'; ctx.fillRect(x - s, y - s, s * 2, s * 2);
  ctx.fillRect(x - r * .82, y - r * .44, s, s); ctx.fillRect(x + r * .44, y + r * .16, s, s);
}

// Current aim of the local player (for the aim-to-shoot indicator).
function currentAim() {
  if (usingTouch) {
    const m = Math.hypot(touchR.dx, touchR.dy);
    if (touchR.id !== null && m > 12) return { aiming: true, ax: touchR.dx / m, ay: touchR.dy / m };
    return { aiming: false };
  }
  if (!rendered) return { aiming: false };
  const w = screenToWorld(mouse.x, mouse.y);
  let ax = w.x - rendered.x, ay = w.y - rendered.y;
  const l = Math.hypot(ax, ay) || 1;
  return { aiming: true, ax: ax / l, ay: ay / l };
}

function drawAimIndicator(wxp, wyp, ax, ay, charge = 0) {
  const px = wx(wxp), py = wy(wyp);
  const len = ws_(150 + 130 * charge);            // longer as it charges
  const ex = px + ax * len, ey = py + ay * len;
  const g = Math.round(255 * (1 - charge));        // white -> red with charge
  const steps = 9, block = ws_(5 + charge * 4);
  ctx.fillStyle = `rgba(255,${g},${g},${0.55 + 0.4 * charge})`;
  for (let i = 2; i <= steps; i++) {
    const t = i / steps;
    ctx.fillRect(px + ax * len * t - block / 2, py + ay * len * t - block / 2, block, block);
  }
  const mark = ws_(12 + charge * 5);
  ctx.strokeStyle = `rgba(255,${g},${g},.95)`; ctx.lineWidth = Math.max(2, ws_(3));
  ctx.strokeRect(ex - mark, ey - mark, mark * 2, mark * 2);
}

function drawProjectile(pr) {
  const x = wx(pr.x), y = wy(pr.y), r = ws_(PROJECTILE.radius);
  const col = TEAM[pr.team].color;
  ctx.fillStyle = 'rgba(255,237,142,.42)'; ctx.fillRect(x - r * 1.7, y - r * .45, r * 3.4, r * .9);
  ctx.fillStyle = col; ctx.fillRect(x - r * 1.15, y - r * 1.15, r * 2.3, r * 2.3);
  ctx.fillStyle = '#fff0aa'; ctx.fillRect(x - r * .55, y - r * .55, r * 1.1, r * 1.1);
}

function drawBomb(bomb) {
  const x = wx(bomb.x), y = wy(bomb.y);
  const r = ws_(15);
  // danger radius preview
  ctx.beginPath(); ctx.arc(x, y, ws_(BOMB.radius), 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(239,68,68,.07)'; ctx.fill();
  ctx.setLineDash([ws_(6), ws_(6)]);
  ctx.strokeStyle = 'rgba(239,68,68,.5)'; ctx.lineWidth = Math.max(1, ws_(2)); ctx.stroke();
  ctx.setLineDash([]);
  // body — blink faster as the fuse runs down
  const t = bomb.fuse / BOMB.fuse;
  const blink = t < 0.35 ? (Math.floor(bomb.fuse * 12) % 2 === 0) : true;
  ctx.fillStyle = blink ? '#f14f3e' : '#6b6252'; ctx.fillRect(x - r, y - r, r * 2, r * 2);
  ctx.fillStyle = '#242620'; ctx.fillRect(x - r * .76, y - r * .76, r * 1.52, r * 1.52);
  ctx.fillStyle = '#55564b'; ctx.fillRect(x - r * .58, y - r * .58, r * .65, r * .28);
  ctx.fillStyle = '#8b5c26'; ctx.fillRect(x + r * .28, y - r * 1.27, r * .28, r * .65);
  ctx.fillStyle = blink ? '#fff08a' : '#f0792c'; ctx.fillRect(x + r * .17, y - r * 1.48, r * .55, r * .45);
}

function drawBlast(bl) {
  const p = 1 - bl.life / bl.maxLife; // 0..1
  const x = wx(bl.x), y = wy(bl.y), rad = ws_(bl.radius * p);
  ctx.save();
  ctx.globalAlpha = Math.max(0, bl.life / bl.maxLife);
  const count = 12;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const dist = rad * (.45 + (i % 3) * .2);
    const sz = Math.max(ws_(5), rad * (i % 2 ? .18 : .12));
    ctx.fillStyle = i % 3 === 0 ? '#fff0a3' : (i % 3 === 1 ? '#ff9e2b' : '#ef4c32');
    ctx.fillRect(x + Math.cos(a) * dist - sz / 2, y + Math.sin(a) * dist - sz / 2, sz, sz);
  }
  ctx.restore();
}

function drawHUD() {
  if (!latest) return;
  document.getElementById('scoreA').textContent = latest.score.A;
  document.getElementById('scoreB').textContent = latest.score.B;
  const t = latest.elapsed || 0;
  const m = Math.floor(t / 60), s = t % 60;
  document.getElementById('timer').textContent = `${m}:${String(s).padStart(2, '0')}`;
  document.getElementById('net').textContent = `${ping}ms · ${snapRate}/s`;

  const banner = document.getElementById('banner');
  if (latest.phase === 'ended') {
    const { A, B } = latest.score;
    const txt = A === B ? 'DRAW' : (A > B ? 'BLUE WINS' : 'RED WINS');
    banner.textContent = txt; banner.style.color = A > B ? TEAM.A.color : (B > A ? TEAM.B.color : '#fff');
    banner.classList.remove('hidden');
  } else if (latest.resetTimer > 0 && latest.lastGoal) {
    banner.textContent = 'GOAL!'; banner.style.color = TEAM[latest.lastGoal].color;
    banner.classList.remove('hidden');
  } else if (latest.resetTimer > 0) {
    banner.textContent = Math.ceil(latest.resetTimer).toString(); banner.style.color = '#fff';
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }
}

function frame() {
  requestAnimationFrame(frame);
  try { renderFrame(); }
  catch (e) { showFatal('frame: ' + e.message + '\n' + ((e.stack || '').split('\n')[1] || '').trim()); }
}
function renderFrame() {
  // Ease the drawn local player toward the prediction, then point the camera at it.
  if (predicted) {
    if (!rendered) rendered = { ...predicted };
    rendered.x += (predicted.x - rendered.x) * 0.35;
    rendered.y += (predicted.y - rendered.y) * 0.35;
  }
  updateCamera();

  ctx.fillStyle = '#172018';
  ctx.fillRect(0, 0, canvas.width, canvas.height); // backdrop behind the field
  ctx.drawImage(bgCanvas, -(camX + NET * scale), -camY); // cached field at camera offset

  const view = interpolated();
  if (view) {
    for (const bl of view.blasts) drawBlast(bl);
    for (const bomb of view.bombs) drawBomb(bomb);

    // Ball — if I'm carrying it, glue it to my predicted position (no lag).
    let ballDraw = view.ball;
    if (view.ball.owner === me.playerId && rendered) {
      const meView = view.players.find((pp) => pp.id === me.playerId);
      const ax = meView ? meView.aimX : 1, ay = meView ? meView.aimY : 0;
      const al = Math.hypot(ax, ay) || 1;
      const off = ownRadius() + BALL_RADIUS * settings.ballSizeMul;
      ballDraw = { x: rendered.x + (ax / al) * off, y: rendered.y + (ay / al) * off };
    }
    drawBall(ballDraw);

    // Aim-to-shoot indicator for the local player (reflects charge).
    const aim = currentAim();
    if (aim.aiming && rendered) drawAimIndicator(rendered.x, rendered.y, aim.ax, aim.ay, currentCharge());
    for (const p of view.players) {
      if (p.id === me.playerId && rendered) drawPlayer({ ...p, x: rendered.x, y: rendered.y });
      else drawPlayer(p);
    }
    for (const pr of view.projectiles) drawProjectile(pr);
  }
  drawHUD();
  specialBtn.classList.toggle('cooling', performance.now() < specialCdUntil);

  // Charge power indicator: the right (aim) stick reddens as you hold.
  // (Cheap colour changes only — no per-frame box-shadow, which thrashes paint.)
  const knob = stickR.querySelector('.knob');
  const chargingNow = chargeStart !== null && touchR.id !== null;
  const bucket = chargingNow ? Math.round(currentCharge() * 5) : -1; // 0..5, only restyle on change
  if (bucket !== stickR._chgBucket) {
    stickR._chgBucket = bucket;
    if (bucket < 0) {
      stickR.style.borderColor = '';
      if (knob) knob.style.background = '';
    } else {
      const chg = bucket / 5;
      const g = Math.round(120 * (1 - chg));
      stickR.style.borderColor = `rgba(255,${g},${g},.95)`;
      if (knob) knob.style.background = `rgba(255,${Math.round(60 * (1 - chg))},60,${0.4 + 0.5 * chg})`;
    }
  }
}
requestAnimationFrame(frame);
