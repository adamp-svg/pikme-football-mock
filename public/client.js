// Web game client: renders the authoritative state with client-side prediction
// for your own player and interpolation for everyone else + the ball.

import {
  FIELD, GOAL, POST_R, PENALTY, BALL_RADIUS, CHARACTERS, TEAM, PROJECTILE, BOMB, MOVE_ACCEL,
  SHOOT_CHARGE_TIME, MAG_SIZE, GOAL_RESET, GOAL_FREEZE_HOLD, MATCH_DURATION, clamp,
} from '/shared/constants.js';

const PENALTY_TOP = (FIELD.H - PENALTY.width) / 2;
const PENALTY_BOTTOM = (FIELD.H + PENALTY.width) / 2;

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
  shotPower: 1850,
  bulletSpeed: 720,
  bulletKnockback: 1500,
  bombPower: 1500,
};

// --------------------------------------------------------------------------
// Sound — short CC0 cues, mixed locally in the browser/WKWebView
// --------------------------------------------------------------------------
const SOUND_FILES = {
  step1: '/audio/step-grass-1.mp3', step2: '/audio/step-grass-2.mp3',
  kick: '/audio/kick.mp3', hit: '/audio/hit.mp3', pickup: '/audio/pickup.mp3',
  shot: '/audio/shot.mp3', ui: '/audio/ui-click.mp3',
  explosion: '/audio/explosion.mp3',
  goalHappy: '/audio/goal-happy.mp3', goalConceded: '/audio/goal.mp3',
};
let audioCtx = null;
let masterGain = null;
let soundEnabled = true;
const soundBuffers = new Map();
let soundLoading = null;
let soundEventsReady = false;
let previousBallOwner = null;
let previousResetTimer = 0;
let knownBlasts = new Set();
let knownImpacts = new Set();
let screenShakeUntil = 0;
let screenShakeStrength = 0;
let lastStepAt = 0;
let lastStepPos = null;
let stepVariant = 0;

try { soundEnabled = localStorage.getItem('pikme-sound') !== 'off'; } catch { /* private mode */ }

function updateSoundButton() {
  const btn = document.getElementById('sound-btn');
  if (!btn) return;
  btn.textContent = soundEnabled ? '🔊' : '🔇';
  btn.classList.toggle('muted', !soundEnabled);
  btn.setAttribute('aria-label', soundEnabled ? 'Mute sound' : 'Turn sound on');
  btn.title = soundEnabled ? 'Mute sound' : 'Turn sound on';
  if (masterGain) masterGain.gain.value = soundEnabled ? 0.72 : 0;
}

function unlockAudio() {
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    audioCtx = new AudioContextClass();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = soundEnabled ? 0.72 : 0;
    masterGain.connect(audioCtx.destination);
  }
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  if (!soundLoading) {
    soundLoading = Promise.allSettled(Object.entries(SOUND_FILES).map(async ([name, url]) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`sound ${response.status}: ${url}`);
      const buffer = await audioCtx.decodeAudioData(await response.arrayBuffer());
      soundBuffers.set(name, buffer);
    }));
  }
}

function playSound(name, volume = 1, rate = 1) {
  if (!soundEnabled || !audioCtx || !masterGain) return;
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  const buffer = soundBuffers.get(name);
  if (!buffer) return;
  const source = audioCtx.createBufferSource();
  const gain = audioCtx.createGain();
  source.buffer = buffer;
  source.playbackRate.value = rate;
  gain.gain.value = volume;
  source.connect(gain).connect(masterGain);
  source.start();
}

// Haptics. The web Vibration API covers Android/desktop; iOS WKWebView ignores
// it, so we ALSO notify the native RN shell (expo-haptics) via postMessage.
const VIBE = { hit: 12, playerHit: 28, bomb: [55, 45, 100], goal: [55, 45, 55, 45, 150], concede: 25 };
function haptic(kind) {
  try { if (navigator.vibrate) navigator.vibrate(VIBE[kind] || 15); } catch { /* unsupported */ }
  try { if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify({ t: 'haptic', kind })); } catch { /* not in app */ }
}

function processSnapshotSounds(snap) {
  const blastIds = new Set((snap.blasts || []).map((b) => b.id));
  const impactIds = new Set((snap.impacts || []).map((i) => i.id));
  if (soundEventsReady) {
    if (previousResetTimer <= 0 && snap.resetTimer > 0 && snap.lastGoal) {
      const ourGoal = snap.lastGoal === me.team;
      playSound(ourGoal ? 'goalHappy' : 'goalConceded', ourGoal ? 1 : 0.82);
      haptic(ourGoal ? 'goal' : 'concede'); // melodic buzz when we score
    }
    if (previousBallOwner === null && snap.ball.owner !== null) {
      playSound('pickup', snap.ball.owner === me.playerId ? 0.55 : 0.28, snap.ball.owner === me.playerId ? 1.08 : 0.96);
    }
    for (const blast of snap.blasts || []) {
      if (!knownBlasts.has(blast.id)) {
        playSound('explosion', 0.8, 0.92 + Math.random() * 0.12);
        const distance = rendered ? Math.hypot(blast.x - rendered.x, blast.y - rendered.y) : 0;
        screenShakeStrength = Math.max(screenShakeStrength, clamp(12 - distance / 65, 2, 12));
        screenShakeUntil = performance.now() + 260;
        haptic('bomb'); // bigger vibration for the blast
      }
    }
    for (const impact of snap.impacts || []) {
      if (knownImpacts.has(impact.id)) continue;
      const volume = impact.type === 'player' ? 0.5 : (impact.type === 'ball' ? 0.34 : 0.18);
      const rate = impact.type === 'wall' ? 1.3 : (impact.type === 'ball' ? 1.12 : 0.96);
      playSound('hit', volume, rate + Math.random() * 0.06);
      haptic(impact.type === 'player' ? 'playerHit' : 'hit'); // buzz on each hit
    }
  }
  previousBallOwner = snap.ball.owner;
  previousResetTimer = snap.resetTimer;
  knownBlasts = blastIds;
  knownImpacts = impactIds;
  soundEventsReady = true;
}

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
document.addEventListener('visibilitychange', () => {
  if (!audioCtx) return;
  if (document.hidden) audioCtx.suspend().catch(() => {});
  else if (soundEnabled) audioCtx.resume().catch(() => {});
});

// --------------------------------------------------------------------------
// Screens: start -> home -> (friends) -> lobby -> game
// --------------------------------------------------------------------------
const startEl = document.getElementById('start');
const homeEl = document.getElementById('home');
const friendsEl = document.getElementById('friends');
const lobbyEl = document.getElementById('lobby');
const gameEl = document.getElementById('game');
const screens = { start: startEl, home: homeEl, friends: friendsEl, lobby: lobbyEl, game: gameEl };
function showScreen(name) { for (const k in screens) screens[k].classList.toggle('hidden', k !== name); }

// Home + friends refs.
const homeOnlineEl = document.getElementById('home-online');
const homeFaceEl = document.getElementById('home-face');
const homeNameEl = document.getElementById('home-name');
const joinCodeEl = document.getElementById('join-code');
const roomErrorEl = document.getElementById('room-error');
// Lobby refs.
const lobbyOnlineEl = document.getElementById('lobby-online');
const lobbyTitleEl = document.getElementById('lobby-title');
const lobbyCodeWrap = document.getElementById('lobby-code-wrap');
const lobbyCodeEl = document.getElementById('lobby-code');
const lobbyHintEl = document.getElementById('lobby-hint');
const teamListEl = { A: document.getElementById('team-a-list'), B: document.getElementById('team-b-list') };
const joinBtn = { A: document.getElementById('join-a'), B: document.getElementById('join-b') };
const countdownEl = document.getElementById('lobby-countdown');
const playNowBtn = document.getElementById('play-now');
let myMemberId = null;        // this client's lobby member id (from welcome)
let myLobbyTeam = 'A';        // my chosen lobby team (mirrors server)
let roomMode = 'quick';       // 'quick' | 'private'
let roomCode = null;

// Local perspective: every player always sees THEIR team as blue attacking
// left->right, so team B's view is mirrored horizontally + colours are remapped.
function flipView() { return me.team === 'B'; }
function teamColor(t) { return t === me.team ? TEAM.A.color : TEAM.B.color; }

// Identity handed over by the Saltiz app through the WebView URL (?name=&avatar=).
const _params = new URLSearchParams(location.search);
const MY_NAME = (_params.get('name') || 'Player').toString().slice(0, 16);
const MY_AVATAR = _params.get('avatar') || null;

const specialIcon = () => '💣'; // special is Bomb
function memberInitials(name) { return (name || '?').trim().slice(0, 2).toUpperCase(); }
function sendMsg(o) { if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(o)); }
function showRoomError(msg) { roomErrorEl.textContent = msg; roomErrorEl.classList.remove('hidden'); }

// Show the player's character (their avatar as the face) on the home menu.
function renderHomeCharacter() {
  homeNameEl.textContent = MY_NAME;
  if (MY_AVATAR) { homeFaceEl.style.backgroundImage = `url("${MY_AVATAR}")`; homeFaceEl.textContent = ''; }
  else { homeFaceEl.style.backgroundImage = 'none'; homeFaceEl.textContent = memberInitials(MY_NAME); }
}

// Title -> connect + show home menu.
document.getElementById('play').addEventListener('click', () => {
  unlockAudio();
  renderHomeCharacter();
  showScreen('home');
  connect(MY_NAME, MY_AVATAR);
});

// Home actions.
document.getElementById('quick-match-btn').addEventListener('click', () => { unlockAudio(); sendMsg({ type: 'quickMatch' }); });
document.getElementById('friends-btn').addEventListener('click', () => { unlockAudio(); roomErrorEl.classList.add('hidden'); showScreen('friends'); });
// Friends actions.
document.getElementById('create-room-btn').addEventListener('click', () => { unlockAudio(); sendMsg({ type: 'createRoom' }); });
document.getElementById('join-room-btn').addEventListener('click', () => {
  unlockAudio();
  const code = (joinCodeEl.value || '').trim().toUpperCase();
  if (code.length < 3) { showRoomError('Enter a room code'); return; }
  sendMsg({ type: 'joinRoom', code });
});
document.getElementById('friends-back').addEventListener('click', () => showScreen('home'));
// Lobby actions.
document.getElementById('lobby-leave').addEventListener('click', () => { sendMsg({ type: 'leaveRoom' }); showScreen('home'); });
joinBtn.A.addEventListener('click', () => sendMsg({ type: 'setTeam', team: 'A' }));
joinBtn.B.addEventListener('click', () => sendMsg({ type: 'setTeam', team: 'B' }));
playNowBtn.addEventListener('click', () => {
  unlockAudio();
  sendMsg({ type: 'ready' });
  playNowBtn.classList.add('armed');
  const sp = playNowBtn.querySelector('span'); if (sp) sp.textContent = 'STARTING…';
});
function resetPlayNow() {
  playNowBtn.classList.remove('armed');
  const sp = playNowBtn.querySelector('span'); if (sp) sp.textContent = 'PLAY NOW';
}
// Clear the team lists when entering a fresh room.
function clearLobbyLists() {
  memberRows.clear();
  teamListEl.A.innerHTML = ''; teamListEl.B.innerHTML = '';
}

// --------------------------------------------------------------------------
// Networking
// --------------------------------------------------------------------------
let pingIv = null;        // ping interval for the current socket (cleared on close)
let reconnectT = null;    // pending auto-reconnect timer
function connect(name, avatar) {
  // wss when the page is served over https (Render), ws for local dev.
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}`);
  ws.onopen = () => {
    setNet('connected');
    ws.send(JSON.stringify({ type: 'join', name, avatar }));
    if (pingIv) clearInterval(pingIv);
    pingIv = setInterval(sendPing, 1500);
  };
  // If the socket drops (network / server restart / WebView backgrounding), the
  // game would otherwise freeze forever — so fall back to the home menu and retry.
  ws.onclose = () => {
    setNet('reconnecting…');
    if (pingIv) { clearInterval(pingIv); pingIv = null; }
    me = { playerId: null, team: null, char: chosenChar };
    latest = null; snaps = []; predicted = null; rendered = null;
    if (!startEl.classList.contains('hidden')) return; // still on the title screen
    showScreen('home');
    resetPlayNow();
    if (!reconnectT) reconnectT = setTimeout(() => { reconnectT = null; connect(name, avatar); }, 1500);
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'welcome') {
      myMemberId = msg.id; // our lobby identity; playerId + team arrive with matchStart
    } else if (msg.type === 'home') {
      homeOnlineEl.textContent = msg.online; // count only — don't yank the user off a sub-screen
    } else if (msg.type === 'roomJoined') {
      roomMode = msg.mode; roomCode = msg.code || null;
      clearLobbyLists(); resetPlayNow();
      showScreen('lobby');
    } else if (msg.type === 'toHome') {
      if (msg.online != null) homeOnlineEl.textContent = msg.online;
      me = { playerId: null, team: null, char: chosenChar };
      showScreen('home');
    } else if (msg.type === 'roomError') {
      showRoomError(msg.msg || 'Could not join room');
      showScreen('friends');
    } else if (msg.type === 'lobby') {
      updateLobbyUI(msg);
    } else if (msg.type === 'matchStart') {
      enterMatch(msg);
    } else if (msg.type === 'toLobby') {
      exitToLobby();
    } else if (msg.type === 'snapshot') {
      if (!me.playerId) return; // ignore stray snapshots while in the lobby
      processSnapshotSounds(msg);
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

// --------------------------------------------------------------------------
// Lobby <-> match transitions
// --------------------------------------------------------------------------
function enterMatch(msg) {
  me = { playerId: msg.playerId, team: msg.team, char: chosenChar };
  if (msg.settings) { Object.assign(settings, msg.settings); syncSliderUI(); }
  // Reset all interpolation / prediction / sound state for the fresh match.
  latest = null; snaps = []; predicted = null; rendered = null; predVel = { x: 0, y: 0 };
  previousBallOwner = null; previousResetTimer = 0;
  knownBlasts = new Set(); knownImpacts = new Set(); soundEventsReady = false;
  specialBtn.textContent = specialIcon(me.char);
  showScreen('game');
  resize();
  renderBackground(); // re-cache the field/stands in our team colours
  resetPlayNow();
}

// Match ended in a private room -> back to that room's lobby (rematch).
function exitToLobby() {
  me = { playerId: null, team: null, char: chosenChar };
  latest = null; snaps = []; predicted = null; rendered = null;
  showScreen('lobby');
  resetPlayNow();
}

// Keyed reconcile of the two team lists (avoids reloading avatar <img>s every tick).
const memberRows = new Map(); // id -> row element
function buildMemberRow(m, listEl) {
  const row = document.createElement('div');
  row.className = 'member-row';
  const av = document.createElement('div'); av.className = 'member-av';
  const nm = document.createElement('div'); nm.className = 'member-name';
  const st = document.createElement('div'); st.className = 'member-status';
  row.append(av, nm, st);
  memberRows.set(m.id, row);
  listEl.appendChild(row);
  return row;
}
function updateLobbyUI(msg) {
  roomMode = msg.mode || roomMode;
  if (msg.code) roomCode = msg.code;
  const isPrivate = msg.mode === 'private';
  lobbyOnlineEl.textContent = msg.online;
  lobbyTitleEl.innerHTML = `<span></span> ${isPrivate ? 'PRIVATE ROOM' : 'QUICK MATCH'} <span></span>`;
  lobbyCodeWrap.classList.toggle('hidden', !isPrivate);
  if (isPrivate && msg.code) lobbyCodeEl.textContent = msg.code;
  // Team picking + PLAY NOW are private-room only; quick match auto-teams + auto-starts.
  joinBtn.A.style.display = isPrivate ? '' : 'none';
  joinBtn.B.style.display = isPrivate ? '' : 'none';
  playNowBtn.style.display = isPrivate ? '' : 'none';
  lobbyHintEl.textContent = isPrivate
    ? 'Pick a team, then PLAY NOW. Empty slots fill with bots.'
    : 'Finding players… the match starts automatically.';

  if (msg.phase === 'countdown' && msg.countdown > 0) {
    countdownEl.textContent = msg.countdown;
    countdownEl.classList.remove('hidden');
  } else {
    countdownEl.classList.add('hidden');
  }

  const seen = new Set();
  for (const m of msg.members) {
    seen.add(m.id);
    const listEl = teamListEl[m.team === 'B' ? 'B' : 'A'];
    let row = memberRows.get(m.id);
    if (!row) row = buildMemberRow(m, listEl);
    else if (row.parentElement !== listEl) listEl.appendChild(row); // moved teams
    const [av, nm, st] = row.children;
    if (row._avatar !== (m.avatar || '')) {
      row._avatar = m.avatar || '';
      av.innerHTML = '';
      if (m.avatar) {
        const img = document.createElement('img');
        img.src = m.avatar; img.alt = '';
        img.onerror = () => { av.innerHTML = ''; av.textContent = memberInitials(m.name); };
        av.appendChild(img);
      } else { av.textContent = memberInitials(m.name); }
    }
    const label = m.id === myMemberId ? `${m.name} (you)` : m.name;
    if (nm.textContent !== label) nm.textContent = label;
    st.textContent = m.inMatch ? '● playing' : '';
    row.classList.toggle('is-me', m.id === myMemberId);
    if (m.id === myMemberId) myLobbyTeam = m.team === 'B' ? 'B' : 'A';
  }
  for (const [id, row] of memberRows) {
    if (!seen.has(id)) { row.remove(); memberRows.delete(id); }
  }
  joinBtn.A.classList.toggle('current', myLobbyTeam === 'A');
  joinBtn.B.classList.toggle('current', myLobbyTeam === 'B');
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
function releaseShot(aim) {
  pendingCharge = currentCharge();
  if (aim) aimHold = aim;
  shootQueued = true;
  playSound(holdingBall ? 'kick' : 'shot', holdingBall ? 0.85 : 0.38, 0.92 + pendingCharge * 0.16);
  chargeStart = null;
}

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
const soundBtn = document.getElementById('sound-btn');
const settingsPanel = document.getElementById('settings');
function triggerSpecial(e) {
  if (e) e.preventDefault();
  specialQueued = true;
  playSound('hit', 0.5, 0.82);
  flashSpecialCooldown();
}
specialBtn.addEventListener('touchstart', triggerSpecial, { passive: false });
specialBtn.addEventListener('mousedown', triggerSpecial);
updateSoundButton();
soundBtn.addEventListener('click', () => {
  unlockAudio();
  if (soundEnabled) playSound('ui', 0.55);
  soundEnabled = !soundEnabled;
  try { localStorage.setItem('pikme-sound', soundEnabled ? 'on' : 'off'); } catch { /* private mode */ }
  updateSoundButton();
  if (soundEnabled) setTimeout(() => playSound('ui', 0.55, 1.08), 30);
});

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
  playSound('ui', 0.45);
  shootQueued = false; specialQueued = false; aimHold = null;
  settingsPanel.classList.remove('hidden');
  syncSliderUI();
}
function closeSettings() {
  playSound('ui', 0.45, 1.06);
  settingsPanel.classList.add('hidden');
}
pauseBtn.addEventListener('click', openSettings);
document.getElementById('resume').addEventListener('click', closeSettings);
document.getElementById('reset-settings').addEventListener('click', () => {
  settings.speedMul = 0.8; settings.sizeMul = 1.25;
  settings.carrySpeedMul = 0.9; settings.ballSizeMul = 2; settings.shotPower = 1850;
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
    if (specialBtn.contains(t.target) || pauseBtn.contains(t.target) || soundBtn.contains(t.target)) continue; // buttons aren't sticks
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

  // Sticks/keyboard are captured in the player's own (screen) frame; a mirrored
  // team-B view means "screen right" is true-world left, so negate their X.
  const flip = flipView();
  if (usingTouch) {
    // Left stick = move, right stick = aim (release to shoot).
    moveX = touchL.dx / STICK_MAX; moveY = touchL.dy / STICK_MAX;
    aimX = touchR.dx / STICK_MAX; aimY = touchR.dy / STICK_MAX;
    if (flip) { moveX = -moveX; aimX = -aimX; }
  } else {
    if (keys['w'] || keys['arrowup']) moveY -= 1;
    if (keys['s'] || keys['arrowdown']) moveY += 1;
    if (keys['a'] || keys['arrowleft']) moveX -= 1;
    if (keys['d'] || keys['arrowright']) moveX += 1;
    if (flip) moveX = -moveX;
    // aim = from own player toward mouse (screenToWorld is flip-aware -> true world)
    if (rendered) {
      const w = screenToWorld(mouse.x, mouse.y);
      aimX = w.x - rendered.x; aimY = w.y - rendered.y;
      const l = Math.hypot(aimX, aimY) || 1; aimX /= l; aimY /= l;
    }
  }
  // A right-stick release captured its aim direction — use it for this shot.
  if (aimHold) { aimX = flip ? -aimHold.x : aimHold.x; aimY = aimHold.y; aimHold = null; }
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
function screenToWorld(px, py) {
  // Invert the camera; for a mirrored team-B view, also undo the horizontal flip.
  const cx = flipView() ? (canvas.width - px * dpr) : (px * dpr);
  return { x: (cx + camX) / scale, y: (py * dpr + camY) / scale };
}

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
      vx: lerp(pa.vx || 0, pb.vx || 0), vy: lerp(pa.vy || 0, pb.vy || 0),
      aimX: lerp(pa.aimX, pb.aimX), aimY: lerp(pa.aimY, pb.aimY),
    };
  });
  const ball = { x: lerp(a.ball.x, b.ball.x), y: lerp(a.ball.y, b.ball.y), owner: b.ball.owner };
  const bProj = new Map((b.projectiles || []).map((p) => [p.id, p]));
  const projectiles = (a.projectiles || []).map((pa) => {
    const pb = bProj.get(pa.id);
    return pb ? { ...pa, x: lerp(pa.x, pb.x), y: lerp(pa.y, pb.y) } : pa;
  });
  return {
    players, ball, projectiles,
    bombs: a.bombs || [], blasts: a.blasts || [], impacts: a.impacts || [],
  };
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
  drawFanWall(-NET, 0, teamColor('A'));                 // behind A's (left) goal
  drawFanWall(FIELD.W, FIELD.W + NET, teamColor('B'));   // behind B's (right) goal
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

// Penalty box: three lines (front + the two sides), goal-line side is the edge,
// plus a penalty spot. lineX = goal line, innerX = front edge (into the pitch).
function drawPenaltyBox(lineX, innerX) {
  ctx.strokeStyle = '#e9e0b8'; ctx.lineWidth = Math.max(2, ws_(4));
  ctx.beginPath();
  ctx.moveTo(wx(lineX), wy(PENALTY_TOP));
  ctx.lineTo(wx(innerX), wy(PENALTY_TOP));
  ctx.lineTo(wx(innerX), wy(PENALTY_BOTTOM));
  ctx.lineTo(wx(lineX), wy(PENALTY_BOTTOM));
  ctx.stroke();
  const spotX = lineX + (innerX - lineX) * 0.62;
  ctx.fillStyle = '#e9e0b8';
  ctx.fillRect(wx(spotX) - ws_(4), wy(FIELD.H / 2) - ws_(4), ws_(8), ws_(8));
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
  drawPenaltyBox(0, PENALTY.depth);                 // left box
  drawPenaltyBox(FIELD.W, FIELD.W - PENALTY.depth); // right box
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
  const team = teamColor(p.team);
  const ang = Math.atan2(p.aimY, p.aimX) + Math.PI / 2;
  const unit = Math.max(2, r / 7);
  const speed = Math.hypot(p.vx || 0, p.vy || 0);
  const moving = clamp(speed / Math.max(1, ch.speed * settings.speedMul), 0, 1);
  let idSeed = 0;
  for (let i = 0; i < p.id.length; i++) idSeed = (idSeed + p.id.charCodeAt(i)) % 97;
  const walkPhase = performance.now() * (0.013 + moving * 0.009) + idSeed;
  const stride = Math.sin(walkPhase) * r * 0.22 * moving;
  const armSwing = -stride * 0.8;
  const bob = Math.abs(Math.cos(walkPhase)) * r * 0.08 * moving;
  const sway = Math.sin(walkPhase) * r * 0.035 * moving;

  // The shadow stays grounded while the block athlete bobs and swings limbs.
  ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
  ctx.fillStyle = 'rgba(17,27,15,.35)';
  ctx.fillRect(-r * (.72 + moving * .08), r * .12, r * (1.44 + moving * .16), r * .78);
  ctx.translate(sway, -bob);
  // Alternating boots make direction and running speed readable at a glance.
  ctx.fillStyle = '#252824';
  ctx.fillRect(-r * .7, r * .36 + stride, r * .52, r * .43);
  ctx.fillRect(r * .18, r * .36 - stride, r * .52, r * .43);
  ctx.fillStyle = '#111512';
  ctx.fillRect(-r * .7, r * .67 + stride, r * .52, r * .16);
  ctx.fillRect(r * .18, r * .67 - stride, r * .52, r * .16);
  // Jersey and opposite arm swing preserve the chunky voxel silhouette.
  ctx.fillStyle = team;
  ctx.fillRect(-r * .82, -r * .25, r * 1.64, r * .85);
  ctx.fillStyle = 'rgba(255,255,255,.82)';
  ctx.fillRect(-r * .82, r * .07, r * 1.64, unit * 1.35);
  ctx.fillStyle = team;
  ctx.fillRect(-r * 1.03, -r * .18 + armSwing, r * .23, r * .62);
  ctx.fillRect(r * .8, -r * .18 - armSwing, r * .23, r * .62);
  ctx.fillStyle = '#d6a46e';
  ctx.fillRect(-r * 1.03, r * .29 + armSwing, r * .23, r * .18);
  ctx.fillRect(r * .8, r * .29 - armSwing, r * .23, r * .18);
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
  drawAmmoBar(p, x, y, r);
}

// Segmented ammo bar under a player: filled pips = loaded rounds, the next pip
// fills as it reloads (or all pips fill together during a full empty-reload).
function drawAmmoBar(p, cx, cy, r) {
  const ammo = p.ammo == null ? MAG_SIZE : p.ammo;
  const frac = p.reloadFrac || 0;
  const reloading = !!p.reloading;
  const w = r * 0.5, h = Math.max(2, r * 0.24), gap = r * 0.18;
  const total = MAG_SIZE * w + (MAG_SIZE - 1) * gap;
  const y = cy + r * 1.28;
  let x = cx - total / 2;
  for (let i = 0; i < MAG_SIZE; i++) {
    ctx.fillStyle = 'rgba(8,12,8,.6)';
    ctx.fillRect(x, y, w, h);
    let fill = 0;
    if (reloading) fill = frac;          // empty mag: all pips fill together
    else if (i < ammo) fill = 1;          // loaded round
    else if (i === ammo) fill = frac;     // the round currently trickling back
    if (fill > 0) {
      ctx.fillStyle = fill >= 1 ? '#ffe27a' : 'rgba(255,226,122,.72)';
      ctx.fillRect(x, y, w * fill, h);
    }
    ctx.strokeStyle = 'rgba(0,0,0,.45)'; ctx.lineWidth = Math.max(1, ws_(1));
    ctx.strokeRect(x, y, w, h);
    x += w + gap;
  }
}

// When the ball is off-screen, pin an arrow to the nearest screen edge pointing
// toward it, so you always know where the ball is.
function drawOffscreenBallArrow(ball) {
  if (!ball) return;
  const sx = wx(ball.x), sy = wy(ball.y);
  const W = canvas.width, H = canvas.height;
  const m = 30 * dpr; // keep the arrow this far inside the edges
  if (sx >= m && sx <= W - m && sy >= m && sy <= H - m) return; // ball is visible
  const dx = sx - W / 2, dy = sy - H / 2;
  const ang = Math.atan2(dy, dx);
  const ex = clamp(sx, m, W - m), ey = clamp(sy, m, H - m);
  const size = 15 * dpr;
  ctx.save();
  ctx.translate(ex, ey);
  // round backing so the marker reads over any field colour
  ctx.fillStyle = 'rgba(10,16,10,.55)';
  ctx.beginPath(); ctx.arc(0, 0, size * 1.05, 0, Math.PI * 2); ctx.fill();
  // little ball dot
  ctx.fillStyle = '#f8efd5';
  ctx.beginPath(); ctx.arc(0, 0, size * 0.5, 0, Math.PI * 2); ctx.fill();
  // triangle pointing toward the ball
  ctx.rotate(ang);
  ctx.fillStyle = '#ffe27a';
  ctx.beginPath();
  ctx.moveTo(size * 1.5, 0);
  ctx.lineTo(size * 0.55, -size * 0.7);
  ctx.lineTo(size * 0.55, size * 0.7);
  ctx.closePath(); ctx.fill();
  ctx.restore();
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
  // Returns a TRUE-world aim direction (the aim indicator is drawn inside the
  // mirrored world for team B, so it must not be pre-flipped here).
  if (usingTouch) {
    const m = Math.hypot(touchR.dx, touchR.dy);
    if (touchR.id !== null && m > 12) {
      const sx = flipView() ? -touchR.dx : touchR.dx;
      return { aiming: true, ax: sx / m, ay: touchR.dy / m };
    }
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
  const col = teamColor(pr.team);
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
  const fade = Math.max(0, 1 - p);
  // A stepped shockwave sells the radius without losing the voxel look.
  const ringCount = 28;
  ctx.globalAlpha = fade * .85;
  for (let i = 0; i < ringCount; i++) {
    const a = (i / ringCount) * Math.PI * 2;
    const sz = Math.max(ws_(4), ws_(11) * (1 - p * .45));
    ctx.fillStyle = i % 3 === 0 ? '#fff1a0' : '#ff8b25';
    ctx.fillRect(x + Math.cos(a) * rad - sz / 2, y + Math.sin(a) * rad - sz / 2, sz, sz);
  }
  // Hot fragments travel at different speeds; the id keeps their paths stable.
  const seed = (bl.id * 0.61803398875) % 1;
  for (let i = 0; i < 34; i++) {
    const jitter = ((Math.sin((i + 1) * 91.733 + seed * 77) + 1) * .5);
    const a = i * 2.399963 + seed * Math.PI * 2;
    const travel = rad * (.18 + jitter * .92);
    const sz = Math.max(ws_(3), ws_(5 + (i % 5) * 2) * (1 - p * .35));
    ctx.globalAlpha = fade * (.55 + jitter * .45);
    ctx.fillStyle = i % 5 === 0 ? '#fff7c2' : (i % 3 === 0 ? '#ef3f2f' : '#ff9b27');
    ctx.fillRect(x + Math.cos(a) * travel - sz / 2, y + Math.sin(a) * travel - sz / 2, sz, sz);
  }
  // Late, blocky smoke rolls behind the sparks.
  if (p > .16) {
    for (let i = 0; i < 13; i++) {
      const a = i * 2.12 + seed * 5;
      const dist = rad * (.12 + (i % 4) * .16);
      const sz = ws_(12 + (i % 3) * 8) * (0.55 + p * .5);
      ctx.globalAlpha = fade * .38;
      ctx.fillStyle = i % 2 ? '#2b2924' : '#494238';
      ctx.fillRect(x + Math.cos(a) * dist - sz / 2, y + Math.sin(a) * dist - sz / 2, sz, sz);
    }
  }
  // White-hot square core flashes only at detonation.
  if (p < .32) {
    const core = ws_(24) * (1 + p * 2.2);
    ctx.globalAlpha = 1 - p / .32;
    ctx.fillStyle = '#fffbe0'; ctx.fillRect(x - core / 2, y - core / 2, core, core);
    ctx.fillStyle = '#ffd03b'; ctx.fillRect(x - core * .3, y - core * .3, core * .6, core * .6);
  }
  ctx.restore();
}

function drawImpact(impact) {
  const p = clamp(1 - impact.life / impact.maxLife, 0, 1);
  const fade = 1 - p;
  const x = wx(impact.x), y = wy(impact.y);
  const dx = impact.dx || 1, dy = impact.dy || 0;
  const back = Math.atan2(-dy, -dx);
  const palette = impact.type === 'player'
    ? ['#fff5b0', '#ffba32', '#ef493f']
    : impact.type === 'ball'
      ? ['#ffffff', '#e9e0b8', '#64d34f']
      : ['#fff0bd', '#a99d7f', '#5a5549'];
  ctx.save();
  ctx.globalAlpha = fade;

  // Pixel burst sprays back from the collision normal.
  const count = impact.type === 'player' ? 16 : 11;
  for (let i = 0; i < count; i++) {
    const spread = ((i / Math.max(1, count - 1)) - .5) * 1.7;
    const a = back + spread + Math.sin(i * 12.31 + impact.id) * .12;
    const dist = ws_(8 + (i % 5) * 8) * (0.3 + p);
    const size = ws_(impact.type === 'player' ? 7 : 5) * (1 - p * .45);
    ctx.fillStyle = palette[i % palette.length];
    ctx.fillRect(x + Math.cos(a) * dist - size / 2, y + Math.sin(a) * dist - size / 2, size, size);
  }

  // Distinct centre marks: cross-hit for players, square ring for ball/wall.
  const mark = ws_(10 + p * 22);
  ctx.strokeStyle = palette[0];
  ctx.lineWidth = Math.max(ws_(3), mark * .18);
  if (impact.type === 'player') {
    ctx.beginPath();
    ctx.moveTo(x - mark, y - mark); ctx.lineTo(x + mark, y + mark);
    ctx.moveTo(x + mark, y - mark); ctx.lineTo(x - mark, y + mark);
    ctx.stroke();
  } else {
    ctx.strokeRect(x - mark, y - mark, mark * 2, mark * 2);
  }
  ctx.restore();
}

function drawHUD() {
  if (!latest) return;
  // Score shown from my perspective: my team (blue) on the left, opponent (red) right.
  const myT = me.team || 'A', opT = myT === 'A' ? 'B' : 'A';
  const myScore = latest.score[myT], opScore = latest.score[opT];
  document.getElementById('scoreA').textContent = myScore;
  document.getElementById('scoreB').textContent = opScore;
  // Match clock counts DOWN to 0:00, then the match ends.
  const remain = Math.max(0, Math.ceil(MATCH_DURATION - (latest.elapsed || 0)));
  const m = Math.floor(remain / 60), s = remain % 60;
  const timerEl = document.getElementById('timer');
  timerEl.textContent = `${m}:${String(s).padStart(2, '0')}`;
  timerEl.classList.toggle('urgent', remain <= 10 && latest.phase !== 'ended');
  document.getElementById('net').textContent = `${ping}ms · ${snapRate}/s`;

  const banner = document.getElementById('banner');
  if (latest.phase === 'ended') {
    const txt = myScore === opScore ? 'DRAW' : (myScore > opScore ? 'BLUE WINS' : 'RED WINS');
    banner.textContent = txt;
    banner.style.color = myScore > opScore ? TEAM.A.color : (opScore > myScore ? TEAM.B.color : '#fff');
    banner.classList.remove('hidden');
  } else if (latest.resetTimer > 0 && latest.lastGoal) {
    // "GOAL!" during the freeze that shows the scoring positions, then 3-2-1.
    const showing = latest.resetTimer > GOAL_RESET - GOAL_FREEZE_HOLD;
    banner.textContent = showing ? 'GOAL!' : String(Math.ceil(latest.resetTimer));
    banner.style.color = teamColor(latest.lastGoal); // blue if I scored, red if conceded
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
  if (gameEl.classList.contains('hidden')) return; // in the lobby — nothing to draw
  // Ease the drawn local player toward the prediction, then point the camera at it.
  if (predicted) {
    if (!rendered) rendered = { ...predicted };
    rendered.x += (predicted.x - rendered.x) * 0.35;
    rendered.y += (predicted.y - rendered.y) * 0.35;
    const now = performance.now();
    if (!lastStepPos) lastStepPos = { ...rendered };
    const moved = Math.hypot(rendered.x - lastStepPos.x, rendered.y - lastStepPos.y);
    if (moved > 22 && now - lastStepAt > 230 && Math.hypot(predVel.x, predVel.y) > 35 && !(latest && latest.resetTimer > 0)) {
      playSound(stepVariant++ % 2 ? 'step1' : 'step2', holdingBall ? 0.12 : 0.16, 0.94 + Math.random() * 0.12);
      lastStepAt = now;
      lastStepPos = { ...rendered };
    } else if (moved > 70) {
      // Teleports/kickoffs should not queue a burst of footsteps.
      lastStepPos = { ...rendered };
    }
  }
  updateCamera();
  if (performance.now() < screenShakeUntil) {
    const left = (screenShakeUntil - performance.now()) / 260;
    camX += (Math.random() * 2 - 1) * screenShakeStrength * dpr * left;
    camY += (Math.random() * 2 - 1) * screenShakeStrength * dpr * left;
  } else {
    screenShakeStrength = 0;
  }

  ctx.fillStyle = '#172018';
  ctx.fillRect(0, 0, canvas.width, canvas.height); // backdrop behind the field
  // Team B sees a horizontally-mirrored pitch so they too attack left->right.
  ctx.save();
  if (flipView()) { ctx.translate(canvas.width, 0); ctx.scale(-1, 1); }
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
      if (p.id === me.playerId && rendered) {
        drawPlayer({ ...p, x: rendered.x, y: rendered.y, vx: predVel.x, vy: predVel.y });
      }
      else drawPlayer(p);
    }
    for (const pr of view.projectiles) drawProjectile(pr);
    for (const impact of view.impacts) drawImpact(impact);
    drawOffscreenBallArrow(view.ball);
  }
  ctx.restore(); // end the mirrored world; HUD/overlays draw in normal screen space
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
