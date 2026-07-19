// Web game client: renders the authoritative state with client-side prediction
// for your own player and interpolation for everyone else + the ball.

import {
  FIELD, GOAL, BALL_RADIUS, CHARACTERS, TEAM, PROJECTILE, BOMB, MOVE_ACCEL,
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
  speedMul: 1,
  sizeMul: 1,
  ballSizeMul: 2,
  carrySpeedMul: 0.7,
  shotPower: 820,
  bulletSpeed: PROJECTILE.speed,
  bulletKnockback: PROJECTILE.knockback,
  bombPower: BOMB.power,
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
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'pause', paused: true }));
}
function closeSettings() {
  settingsPanel.classList.add('hidden');
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'pause', paused: false }));
}
pauseBtn.addEventListener('click', openSettings);
document.getElementById('resume').addEventListener('click', closeSettings);
document.getElementById('reset-settings').addEventListener('click', () => {
  settings.speedMul = 1; settings.sizeMul = 1;
  settings.carrySpeedMul = 0.7; settings.ballSizeMul = 2; settings.shotPower = 820;
  settings.bulletSpeed = PROJECTILE.speed;
  settings.bulletKnockback = PROJECTILE.knockback;
  settings.bombPower = BOMB.power;
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
      // Right stick is AIM: release = shoot with the built-up charge in the
      // aimed direction. A tiny flick cancels (drops the charge, no shot).
      if (Math.hypot(touchR.dx, touchR.dy) > 12) releaseShot({ x: touchR.dx, y: touchR.dy });
      else chargeStart = null;
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
// Offscreen canvas caches the STATIC background (pitch + stands): drawn once
// per resize, then blitted each frame instead of re-rendering all the vectors.
const bgCanvas = document.createElement('canvas');
const bgCtx = bgCanvas.getContext('2d');
let ctx = mainCtx; // active draw target (temporarily repointed to bgCtx while caching)
let scale = 1, offX = 0, offY = 0, dpr = 1, standBandH = 0;

function resize() {
  dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  bgCanvas.width = canvas.width;
  bgCanvas.height = canvas.height;
  // Reserve top + bottom bands for the stands; fit the pitch between them.
  standBandH = Math.round(innerHeight * 0.12);
  const pitchAreaH = innerHeight - 2 * standBandH;
  const s = Math.min(innerWidth / FIELD.W, pitchAreaH / FIELD.H);
  scale = s;
  offX = (innerWidth - FIELD.W * s) / 2;
  offY = standBandH + (pitchAreaH - FIELD.H * s) / 2;
  renderBackground();
}

// Render the static background to the offscreen cache (temporarily repoints ctx).
function renderBackground() {
  bgCtx.clearRect(0, 0, bgCanvas.width, bgCanvas.height);
  ctx = bgCtx;
  try { drawStands(); drawPitch(); } finally { ctx = mainCtx; }
}
addEventListener('resize', resize);

function wx(x) { return (offX + x * scale) * dpr; }
function wy(y) { return (offY + y * scale) * dpr; }
function ws_(v) { return v * scale * dpr; }
function screenToWorld(px, py) {
  return { x: (px - offX) / scale, y: (py - offY) / scale };
}

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

// Stands: top band = opposing team's fans, bottom band = your team's fans,
// each a row of supporter cards in that team's colour.
function drawStands() {
  const myTeam = me.team || 'A';
  const oppTeam = myTeam === 'A' ? 'B' : 'A';
  const H = standBandH * dpr;
  drawStandBand(0, H, TEAM[oppTeam].color, true);
  drawStandBand(canvas.height - H, H, TEAM[myTeam].color, false);
}
function drawStandBand(y, h, color, isTop) {
  ctx.fillStyle = '#0a0f1c';
  ctx.fillRect(0, y, canvas.width, h);
  // team strip along the pitch-facing edge
  ctx.save();
  ctx.globalAlpha = 0.55; ctx.fillStyle = color;
  const strip = Math.max(2, 3 * dpr);
  ctx.fillRect(0, isTop ? y + h - strip : y, canvas.width, strip);
  ctx.restore();
  // supporter cards
  const pad = 7 * dpr;
  const cardH = h - pad * 2;
  const cardW = cardH * 0.66;
  const gap = 7 * dpr;
  const n = Math.max(0, Math.floor((canvas.width - pad) / (cardW + gap)));
  const extra = (canvas.width - pad - n * (cardW + gap)) / 2;
  for (let i = 0; i < n; i++) {
    const x = pad + extra + i * (cardW + gap);
    const cy = y + pad;
    roundRect(ctx, x, cy, cardW, cardH, 5 * dpr); ctx.fillStyle = color; ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.85)';
    roundRect(ctx, x + cardW * 0.14, cy + cardH * 0.12, cardW * 0.72, cardH * 0.5, 3 * dpr); ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,.22)';
    roundRect(ctx, x + cardW * 0.14, cy + cardH * 0.68, cardW * 0.72, cardH * 0.16, 2 * dpr); ctx.fill();
  }
}

function drawPitch() {
  // grass + mow stripes
  ctx.fillStyle = '#2f9e44';
  ctx.fillRect(wx(0), wy(0), ws_(FIELD.W), ws_(FIELD.H));
  const stripes = 8, sw = FIELD.W / stripes;
  for (let i = 0; i < stripes; i++) {
    ctx.fillStyle = i % 2 ? 'rgba(255,255,255,.05)' : 'rgba(0,0,0,.05)';
    ctx.fillRect(wx(i * sw), wy(0), ws_(sw), ws_(FIELD.H));
  }
  ctx.strokeStyle = 'rgba(255,255,255,.7)';
  ctx.lineWidth = Math.max(1, ws_(3));
  // border
  ctx.strokeRect(wx(6), wy(6), ws_(FIELD.W - 12), ws_(FIELD.H - 12));
  // halfway line + center circle
  ctx.beginPath();
  ctx.moveTo(wx(FIELD.W / 2), wy(6)); ctx.lineTo(wx(FIELD.W / 2), wy(FIELD.H - 6));
  ctx.stroke();
  ctx.beginPath(); ctx.arc(wx(FIELD.W / 2), wy(FIELD.H / 2), ws_(70), 0, Math.PI * 2); ctx.stroke();
  // goals — inset net box with mesh, and a bright frame at the goal line
  for (const side of ['L', 'R']) {
    const x0 = side === 'L' ? 0 : FIELD.W - GOAL.depth;    // net box near edge
    const lineX = side === 'L' ? GOAL.depth : FIELD.W - GOAL.depth; // goal line (front)
    // net fill
    ctx.fillStyle = 'rgba(255,255,255,.10)';
    ctx.fillRect(wx(x0), wy(GOAL_TOP), ws_(GOAL.depth), ws_(GOAL.width));
    // net mesh
    ctx.strokeStyle = 'rgba(255,255,255,.30)'; ctx.lineWidth = Math.max(1, ws_(1));
    for (let i = 1; i < 5; i++) {
      const gx = x0 + (GOAL.depth / 5) * i;
      ctx.beginPath(); ctx.moveTo(wx(gx), wy(GOAL_TOP)); ctx.lineTo(wx(gx), wy(GOAL_BOTTOM)); ctx.stroke();
    }
    for (let j = 1; j < 6; j++) {
      const gy = GOAL_TOP + (GOAL.width / 6) * j;
      ctx.beginPath(); ctx.moveTo(wx(x0), wy(gy)); ctx.lineTo(wx(x0 + GOAL.depth), wy(gy)); ctx.stroke();
    }
    // goal-line frame (posts)
    ctx.strokeStyle = '#fff'; ctx.lineWidth = Math.max(3, ws_(5));
    ctx.beginPath(); ctx.moveTo(wx(lineX), wy(GOAL_TOP)); ctx.lineTo(wx(lineX), wy(GOAL_BOTTOM)); ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(wx(lineX), wy(GOAL_TOP), ws_(4), 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(wx(lineX), wy(GOAL_BOTTOM), ws_(4), 0, Math.PI * 2); ctx.fill();
  }
}

function drawPlayer(p) {
  const ch = CHARACTERS[p.char] || CHARACTERS.player;
  const isMe = p.id === me.playerId;
  const x = wx(p.x), y = wy(p.y), r = ws_(ch.radius * settings.sizeMul);
  // aim pointer
  const al = r * 1.9;
  ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = Math.max(2, ws_(3));
  ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + p.aimX * al, y + p.aimY * al); ctx.stroke();
  // body
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = TEAM[p.team].color; ctx.fill();
  ctx.lineWidth = Math.max(2, ws_(isMe ? 4 : 2.5));
  ctx.strokeStyle = isMe ? '#fff' : 'rgba(0,0,0,.35)'; ctx.stroke();
  if (p.firing) { ctx.beginPath(); ctx.arc(x, y, r + ws_(8), 0, Math.PI * 2); ctx.strokeStyle = 'rgba(255,220,120,.9)'; ctx.lineWidth = Math.max(2, ws_(3)); ctx.stroke(); }
  // emoji
  ctx.font = `${r * 1.1}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(ch.emoji, x, y + r * 0.06);
  // local-player marker (no names) — small white arrow above you
  if (isMe) {
    const ty = y - r - ws_(6);
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.moveTo(x, ty + ws_(7));
    ctx.lineTo(x - ws_(6), ty);
    ctx.lineTo(x + ws_(6), ty);
    ctx.closePath();
    ctx.fill();
  }
}

function drawBall(b) {
  const x = wx(b.x), y = wy(b.y), r = ws_(BALL_RADIUS * settings.ballSizeMul);
  // flat sprite — white disc, dark rim, small center dot (no shadow)
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = '#fff'; ctx.fill();
  ctx.lineWidth = Math.max(1, ws_(2)); ctx.strokeStyle = '#1a1a1a'; ctx.stroke();
  ctx.fillStyle = '#222';
  ctx.beginPath(); ctx.arc(x, y, r * 0.3, 0, Math.PI * 2); ctx.fill();
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
  ctx.save();
  ctx.setLineDash([ws_(9), ws_(9)]);
  ctx.strokeStyle = `rgba(255,${g},${g},${0.5 + 0.4 * charge})`;
  ctx.lineWidth = Math.max(2, ws_(3 + 3 * charge));
  ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(ex, ey); ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath(); ctx.arc(ex, ey, ws_(11), 0, Math.PI * 2);
  ctx.strokeStyle = `rgba(255,${g},${g},.9)`; ctx.lineWidth = Math.max(2, ws_(3)); ctx.stroke();
  ctx.beginPath(); ctx.arc(ex, ey, ws_(3 + 4 * charge), 0, Math.PI * 2);
  ctx.fillStyle = `rgba(255,${g},${g},.95)`; ctx.fill();
  ctx.restore();
}

function drawProjectile(pr) {
  const x = wx(pr.x), y = wy(pr.y), r = ws_(PROJECTILE.radius);
  const col = TEAM[pr.team].color;
  // no shadowBlur — canvas shadows are very expensive on mobile
  ctx.beginPath(); ctx.arc(x, y, r + ws_(2), 0, Math.PI * 2);
  ctx.fillStyle = col; ctx.fill();
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = '#fff'; ctx.fill();
}

function drawBomb(bomb) {
  const x = wx(bomb.x), y = wy(bomb.y);
  const r = ws_(15);
  // danger radius preview
  ctx.beginPath(); ctx.arc(x, y, ws_(BOMB.radius), 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(239,68,68,.08)'; ctx.fill();
  ctx.setLineDash([ws_(6), ws_(6)]);
  ctx.strokeStyle = 'rgba(239,68,68,.5)'; ctx.lineWidth = Math.max(1, ws_(2)); ctx.stroke();
  ctx.setLineDash([]);
  // body — blink faster as the fuse runs down
  const t = bomb.fuse / BOMB.fuse;
  const blink = t < 0.35 ? (Math.floor(bomb.fuse * 12) % 2 === 0) : true;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = '#141414'; ctx.fill();
  ctx.lineWidth = Math.max(2, ws_(3)); ctx.strokeStyle = blink ? '#ff5252' : '#555'; ctx.stroke();
  // fuse spark
  ctx.font = `${r * 1.1}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('💣', x, y);
}

function drawBlast(bl) {
  const p = 1 - bl.life / bl.maxLife; // 0..1
  const x = wx(bl.x), y = wy(bl.y), rad = ws_(bl.radius * p);
  ctx.save();
  ctx.globalAlpha = Math.max(0, bl.life / bl.maxLife);
  ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,180,60,.35)'; ctx.fill();
  ctx.lineWidth = Math.max(2, ws_(6)); ctx.strokeStyle = 'rgba(255,240,180,.9)'; ctx.stroke();
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
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bgCanvas, 0, 0); // cached pitch + stands (no per-frame vector redraw)

  const view = interpolated();
  if (view) {
    for (const bl of view.blasts) drawBlast(bl);
    for (const bomb of view.bombs) drawBomb(bomb);

    // ease rendered own-player toward the prediction to smooth reconciliation
    if (predicted) {
      if (!rendered) rendered = { ...predicted };
      rendered.x += (predicted.x - rendered.x) * 0.35;
      rendered.y += (predicted.y - rendered.y) * 0.35;
    }

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
