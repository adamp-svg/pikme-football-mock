// Web game client: renders the authoritative state with client-side prediction
// for your own player and interpolation for everyone else + the ball.

import {
  FIELD, GOAL, POST_R, PENALTY, BALL_RADIUS, CHARACTERS, TEAM, PROJECTILE, BOMB, MOVE_ACCEL,
  SHOOT_CHARGE_TIME, MAG_SIZE, GOAL_RESET, GOAL_FREEZE_HOLD, MATCH_DURATION,
  BUSH_REVEAL_DIST, SHOT_REVEAL_TIME, BUILD_MAG, BUILT_WALL, clamp,
} from '/shared/constants.js';
import { ARENA, resolveWalls, pointInBush } from '/shared/arena.js';

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

// ---- Player album (cards) -------------------------------------------------
// The app injects window.SALTIZ_CARDS pre-load: a compact, non-PII list [{r,n,c,w}]
// (rarity, card number, copies, worth). Empty on the web/dev without the app.
const CARD_ART_BASE = 'https://pxsjmychuxwufcvqixgu.supabase.co/storage/v1/object/public/cards';
const RARITY_GLOW = { common: '#9ab0c5', rare: '#4ea0ff', epic: '#b46bff', legendary: '#ffb800' };
const RARITY_RANK = { legendary: 3, epic: 2, rare: 1, common: 0 };
function myCards() { return Array.isArray(window.SALTIZ_CARDS) ? window.SALTIZ_CARDS.slice(0, 256) : []; }
// Best-first: worth, then rarity, then copies. Drives the carousel + the top-3 intro.
function rankCards(cards) {
  return [...(cards || [])].sort((a, b) =>
    (b.w || 0) - (a.w || 0) ||
    (RARITY_RANK[b.r] || 0) - (RARITY_RANK[a.r] || 0) ||
    (b.c || 0) - (a.c || 0));
}
// Lazily-loaded card-front <img>s, keyed "rarity_number". crossOrigin left unset so the
// public Supabase art loads without a CORS handshake (the game never reads canvas pixels).
const _cardImgs = new Map();
function cardImage(r, n) {
  const key = r + '_' + n;
  let img = _cardImgs.get(key);
  if (!img) {
    img = new Image();
    img.onload = () => { img.ready = true; audNeedsRebake = true; };
    img.onerror = () => { img.failed = true; };
    img.src = `${CARD_ART_BASE}/${r}/${n}.webp`;
    _cardImgs.set(key, img);
  }
  return img;
}
function preloadCards(cards) { for (const c of (cards || [])) cardImage(c.r, c.n); }

const specialIcon = () => '💣'; // special is Bomb
function memberInitials(name) { return (name || '?').trim().slice(0, 2).toUpperCase(); }
function sendMsg(o) { if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(o)); }
function showRoomError(msg) { roomErrorEl.textContent = msg; roomErrorEl.classList.remove('hidden'); }

// Show the player's character (their avatar as the face) on the home menu.
function renderHomeCharacter() {
  homeNameEl.textContent = MY_NAME;
  if (MY_AVATAR) { homeFaceEl.style.backgroundImage = `url("${MY_AVATAR}")`; homeFaceEl.textContent = ''; }
  else { homeFaceEl.style.backgroundImage = 'none'; homeFaceEl.textContent = memberInitials(MY_NAME); }
  renderCarousel();
}

// Coverflow carousel of the player's cards on the home screen: best card centered,
// up to 5 visible with the sides shrinking + fading outward. Purely visual
// (auto-advance + swipe). Hidden when the player has no cards.
const carouselEl = document.getElementById('home-carousel');
let cfCards = [], cfIndex = 0, cfTimer = null;
const CF_SPACING = 60, CF_STEP = 0.2, CF_MAX = 2; // ±2 visible => 5 cards
function renderCarousel() {
  cfCards = rankCards(myCards());
  carouselEl.innerHTML = '';
  stopCarouselAuto();
  if (!cfCards.length) { carouselEl.classList.add('hidden'); return; }
  carouselEl.classList.remove('hidden');
  cfIndex = 0;
  preloadCards(cfCards);
  cfCards.forEach((c, i) => {
    const el = document.createElement('div');
    el.className = 'cf-card rarity-' + c.r;
    el.dataset.n = c.n;
    const img = document.createElement('img');
    img.alt = '';
    img.onerror = () => el.classList.add('cf-noart');
    img.src = `${CARD_ART_BASE}/${c.r}/${c.n}.webp`;
    el.appendChild(img);
    if (c.c > 1) { const b = document.createElement('span'); b.className = 'cf-badge'; b.textContent = '×' + c.c; el.appendChild(b); }
    el.addEventListener('click', () => setCarousel(i));
    carouselEl.appendChild(el);
  });
  layoutCarousel();
  startCarouselAuto();
}
function layoutCarousel() {
  const kids = carouselEl.children, n = kids.length;
  for (let i = 0; i < n; i++) {
    let off = i - cfIndex;
    if (off > n / 2) off -= n; else if (off < -n / 2) off += n; // wrap => symmetric coverflow
    const a = Math.abs(off), el = kids[i];
    if (a > CF_MAX) {
      el.style.opacity = '0'; el.style.pointerEvents = 'none';
      el.style.transform = `translateX(${off * CF_SPACING * 1.4}px) scale(.4)`;
      continue;
    }
    el.style.opacity = a === 0 ? '1' : a === 1 ? '.82' : '.5';
    el.style.pointerEvents = 'auto';
    el.style.zIndex = String(10 - a);
    el.style.transform = `translateX(${off * CF_SPACING}px) scale(${1 - a * CF_STEP})`;
    el.classList.toggle('cf-center', a === 0);
  }
}
function setCarousel(i) {
  if (!cfCards.length) return;
  cfIndex = ((i % cfCards.length) + cfCards.length) % cfCards.length;
  layoutCarousel();
}
function startCarouselAuto() { stopCarouselAuto(); if (cfCards.length > 1) cfTimer = setInterval(() => setCarousel(cfIndex + 1), 2600); }
function stopCarouselAuto() { if (cfTimer) { clearInterval(cfTimer); cfTimer = null; } }
(function bindCarouselSwipe() {
  let sx = null;
  carouselEl.addEventListener('pointerdown', (e) => { sx = e.clientX; stopCarouselAuto(); try { carouselEl.setPointerCapture(e.pointerId); } catch { /* older webviews */ } });
  carouselEl.addEventListener('pointermove', (e) => {
    if (sx == null) return;
    const dx = e.clientX - sx;
    if (Math.abs(dx) > 34) { setCarousel(cfIndex + (dx < 0 ? 1 : -1)); sx = e.clientX; } // spin as the finger drags
  });
  const end = () => { if (sx != null) { sx = null; startCarouselAuto(); } };
  carouselEl.addEventListener('pointerup', end);
  carouselEl.addEventListener('pointercancel', end);
})();

// ---- Home dancing character -------------------------------------------------
const homeCharCanvas = document.getElementById('home-char');
const homeCharCtx = homeCharCanvas ? homeCharCanvas.getContext('2d') : null;
let homeDanceRAF = null;
// A blocky footballer doing a little dance (bob + arm pumps + sway) on the home screen.
function drawDancer(g, W, H, t) {
  g.clearRect(0, 0, W, H);
  g.imageSmoothingEnabled = false;
  const sf = H / 46, ox = W / 2, feetY = H - sf * 4;
  const P = (x, y, w, h, c) => { g.fillStyle = c; g.fillRect(Math.round(x), Math.round(y), Math.max(1, Math.round(w)), Math.max(1, Math.round(h))); };
  const S = (u) => u * sf;
  const beat = t * 0.005;
  const bounce = Math.abs(Math.sin(beat * 2)) * 3, sway = Math.sin(beat) * 3;
  const armL = Math.sin(beat * 2) * 6, armR = -armL, legL = Math.sin(beat * 2) * 2;
  const topY = -30 - bounce;
  const X = (u) => ox + sway + S(u), Y = (u) => feetY + S(topY + u);
  const sk = '#e7b072', skS = '#c8925a', hair = '#3a2a17', J = '#3f7bd6', JS = '#2c5aa6', wht = '#f2efe4', sh = '#eef0f2', boot = '#20232a';
  P(ox - S(8), feetY + S(-1), S(16), S(3), 'rgba(0,0,0,.28)');                 // ground shadow
  P(X(-4), Y(20), S(3), S(6 + legL), sk); P(X(-4), Y(26 + legL), S(4), S(2), boot);
  P(X(1), Y(20), S(3), S(6 - legL), sk); P(X(1), Y(26 - legL), S(4), S(2), boot);
  P(X(-5), Y(17), S(10), S(4), sh);                                            // shorts
  P(X(-5), Y(9), S(10), S(9), J); P(X(-5), Y(9), S(2), S(9), JS); P(X(3), Y(9), S(2), S(9), JS); P(X(-1), Y(11), S(2), S(5), wht); // torso
  P(X(-8), Y(9 + armL), S(3), S(6), J); P(X(-8), Y(15 + armL), S(3), S(2), sk); // arms pumping
  P(X(5), Y(9 + armR), S(3), S(6), J); P(X(5), Y(15 + armR), S(3), S(2), sk);
  P(X(-5), Y(0), S(10), S(9), sk); P(X(-5), Y(0), S(10), S(3), hair);          // head + hair
  P(X(-3), Y(4), S(2), S(2), wht); P(X(1), Y(4), S(2), S(2), wht);
  P(X(-2), Y(4), S(1), S(2), '#20242b'); P(X(2), Y(4), S(1), S(2), '#20242b');
  P(X(-1), Y(7), S(3), S(1), skS);
}
function startHomeDance() {
  if (!homeCharCtx || homeDanceRAF) return;
  const loop = () => {
    if (!homeEl.classList.contains('hidden')) drawDancer(homeCharCtx, homeCharCanvas.width, homeCharCanvas.height, performance.now());
    homeDanceRAF = requestAnimationFrame(loop);
  };
  loop();
}

// The user/home screen is shown first (no title gate): render identity + card
// carousel, start the character dance, and connect straight away.
renderHomeCharacter();
showScreen('home');
startHomeDance();
connect(MY_NAME, MY_AVATAR);

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
    ws.send(JSON.stringify({ type: 'join', name, avatar, cards: myCards() }));
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
      if (msg.mode === 'quick') { quickVs = true; showScreen('home'); } // VS + countdown overlay drives the wait
      else { quickVs = false; hideVs(); showScreen('lobby'); }
    } else if (msg.type === 'toHome') {
      if (msg.online != null) homeOnlineEl.textContent = msg.online;
      me = { playerId: null, team: null, char: chosenChar };
      quickVs = false; hideVs(); showScreen('home');
    } else if (msg.type === 'roomError') {
      quickVs = false; hideVs();
      showRoomError(msg.msg || 'Could not join room');
      showScreen('friends');
    } else if (msg.type === 'lobby') {
      if (quickVs) updateVsCountdown(msg); else updateLobbyUI(msg);
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
  matchRoster = Array.isArray(msg.players) ? msg.players : [];
  audienceReady = false; // rebuild seat assignment for this match's roster
  showScreen('game');
  resize();
  renderBackground(); // re-cache the field/stands in our team colours
  if (quickVs) { quickVs = false; hideTeamIntro(); } // the VS countdown already served as the intro
  else showTeamIntro(msg.players);                    // private room: brief VS intro overlay
  resetPlayNow();
}

// Match ended in a private room -> back to that room's lobby (rematch).
function exitToLobby() {
  me = { playerId: null, team: null, char: chosenChar };
  latest = null; snaps = []; predicted = null; rendered = null;
  showScreen('lobby');
  resetPlayNow();
}

// ---- Team intro overlay + match roster --------------------------------------
let matchRoster = [];        // [{id,name,avatar,team,cards}] from matchStart (humans)
let audienceReady = false;   // seat layout rebuilt per match (see drawAudience)
const teamIntroEl = document.getElementById('team-intro');
const tiCountEl = document.getElementById('ti-count');
let introTimer = null;
let quickVs = false; // true while the quick-match VS + countdown overlay drives the pre-match wait
function hideVs() { if (tiCountEl) tiCountEl.classList.add('hidden'); hideTeamIntro(); }
// Quick-match VS screen: HOME (my team) vs RIVALS from lobby members (bots fill empty
// slots), with the big 5..0 countdown. Refreshed on every lobby payload.
function updateVsCountdown(msg) {
  if (!teamIntroEl) return;
  const mine = (msg.members.find((m) => m.id === myMemberId) || {}).team || 'A';
  const cols = teamIntroEl.querySelectorAll('.ti-col');
  fillIntroCol(cols[0], msg.members, mine);
  fillIntroCol(cols[1], msg.members, mine === 'A' ? 'B' : 'A');
  preloadCards(msg.members.flatMap((m) => m.cards || []));
  if (msg.phase === 'countdown' && msg.countdown > 0) { tiCountEl.textContent = msg.countdown; tiCountEl.classList.remove('hidden'); }
  else tiCountEl.classList.add('hidden');
  teamIntroEl.classList.remove('hidden');
  requestAnimationFrame(() => teamIntroEl.classList.add('show'));
}
function introCardEl(c) {
  const el = document.createElement('div');
  el.className = 'ti-card rarity-' + c.r; el.dataset.n = c.n;
  const img = document.createElement('img'); img.alt = '';
  img.onerror = () => el.classList.add('cf-noart');
  img.src = `${CARD_ART_BASE}/${c.r}/${c.n}.webp`;
  el.appendChild(img);
  return el;
}
function fillIntroCol(colEl, players, team) {
  const rows = colEl.querySelector('.ti-rows'); rows.innerHTML = '';
  const humans = players.filter((p) => p.team === team);
  for (let i = 0; i < 2; i++) {
    const p = humans[i];
    const row = document.createElement('div'); row.className = 'ti-row';
    const av = document.createElement('div'); av.className = 'ti-av';
    const nm = document.createElement('div'); nm.className = 'ti-name';
    const cw = document.createElement('div'); cw.className = 'ti-cards';
    if (p) {
      if (p.avatar) av.style.backgroundImage = `url("${p.avatar}")`;
      else av.textContent = memberInitials(p.name);
      nm.textContent = p.id === myMemberId ? `${p.name} (you)` : p.name;
      rankCards(p.cards).slice(0, 3).forEach((c) => cw.appendChild(introCardEl(c)));
    } else { av.textContent = '🤖'; nm.textContent = 'BOT'; }
    row.append(av, nm, cw);
    rows.appendChild(row);
  }
}
function showTeamIntro(players) {
  if (!teamIntroEl || !Array.isArray(players)) return;
  const mine = me.team === 'B' ? 'B' : 'A';
  const cols = teamIntroEl.querySelectorAll('.ti-col');
  fillIntroCol(cols[0], players, mine);                       // home column = my team
  fillIntroCol(cols[1], players, mine === 'A' ? 'B' : 'A');   // away column = rivals
  preloadCards(players.flatMap((p) => p.cards || []));
  teamIntroEl.classList.remove('hidden');
  requestAnimationFrame(() => teamIntroEl.classList.add('show'));
  clearTimeout(introTimer);
  introTimer = setTimeout(hideTeamIntro, 3000);
}
function hideTeamIntro() {
  clearTimeout(introTimer);
  if (!teamIntroEl) return;
  if (tiCountEl) tiCountEl.classList.add('hidden');
  teamIntroEl.classList.remove('show');
  setTimeout(() => teamIntroEl.classList.add('hidden'), 340);
}
// Tap-to-skip only applies to the brief match-start intro, not the quick-match countdown.
if (teamIntroEl) teamIntroEl.addEventListener('click', () => { if (!quickVs) hideTeamIntro(); });

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
  // Keep the prediction out of walls (built walls arrive in the snapshot) so the
  // local player slides along cover instead of clipping through then rubber-banding.
  const e = { x: predicted.x, y: predicted.y, vx: predVel.x, vy: predVel.y };
  resolveWalls(e, r, latest && latest.walls);
  predicted.x = e.x; predicted.y = e.y; predVel.x = e.vx; predVel.y = e.vy;
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
let buildQueued = false;   // a wall build was released this frame
let buildHold = null;      // aim captured at build-button release (drag-to-aim)
let aimHold = null;        // aim captured at right-stick release
let chargeStart = null;    // timestamp when the current aim-hold began (charging)
let pendingCharge = 0;     // 0..1 charge captured on release

// Build a wall — like a shot, you can drag to aim (pull-to-build) then release.
function releaseBuild(aim) { buildQueued = true; if (aim) buildHold = aim; playSound('ui', 0.5, 0.86); }

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
  if (e.key.toLowerCase() === 'q' && !e.repeat) releaseBuild(); // build a wall in the facing direction
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

// Build button — press and DRAG to aim the wall (pull-to-build), release to place.
// A plain tap builds in the direction you're facing. Pointer events cover mouse+touch.
const buildBtn = document.getElementById('build');
let buildDrag = { active: false, id: null, cx: 0, cy: 0, dx: 0, dy: 0 };
if (buildBtn) {
  buildBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { buildBtn.setPointerCapture(e.pointerId); } catch { /* older webview */ }
    buildDrag = { active: true, id: e.pointerId, cx: e.clientX, cy: e.clientY, dx: 0, dy: 0 };
  });
  buildBtn.addEventListener('pointermove', (e) => {
    if (!buildDrag.active || e.pointerId !== buildDrag.id) return;
    buildDrag.dx = e.clientX - buildDrag.cx; buildDrag.dy = e.clientY - buildDrag.cy;
  });
  const endBuildDrag = (e) => {
    if (!buildDrag.active || e.pointerId !== buildDrag.id) return;
    if (Math.hypot(buildDrag.dx, buildDrag.dy) > 12) releaseBuild({ x: buildDrag.dx, y: buildDrag.dy });
    else releaseBuild();
    buildDrag.active = false; buildDrag.id = null; buildDrag.dx = 0; buildDrag.dy = 0;
  };
  buildBtn.addEventListener('pointerup', endBuildDrag);
  buildBtn.addEventListener('pointercancel', endBuildDrag);
}
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
    if (specialBtn.contains(t.target) || pauseBtn.contains(t.target) || soundBtn.contains(t.target) || (buildBtn && buildBtn.contains(t.target))) continue; // buttons aren't sticks
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
  // A build-button drag aims the wall the same way; overrides aim for this frame.
  if (buildHold) { aimX = flip ? -buildHold.x : buildHold.x; aimY = buildHold.y; buildHold = null; }
  const shoot = shootQueued; shootQueued = false;
  const special = specialQueued; specialQueued = false;
  const build = buildQueued; buildQueued = false;
  const charge = shoot ? pendingCharge : 0;
  if (shoot) pendingCharge = 0;
  return { moveX, moveY, aimX, aimY, shoot, special, build, charge };
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
// --- True pixel-art pipeline (Minecraft look) ---------------------------------
// The whole world is rendered into a LOW-RES buffer (`worldBuf`) at ART_PX
// device-pixels per art-pixel, then nearest-neighbour up-scaled onto the display.
// That single up-scale is what turns every edge into a chunky, aliased block.
// The HUD/overlays are drawn straight onto the crisp full-res main canvas after.
const ART_PX = 3.25;                 // device px per art-pixel (bigger = chunkier)
const worldBuf = document.createElement('canvas');
const wbCtx = worldBuf.getContext('2d');
let wbW = 1, wbH = 1;                 // world-buffer dims (art px)
// Offscreen canvas caches the STATIC field (grass, lines, goals, stands) for the
// whole world incl. the behind-goal net areas; blitted at the camera offset.
const bgCanvas = document.createElement('canvas');
const bgCtx = bgCanvas.getContext('2d');
let ctx = wbCtx;            // active draw target (world draws target the low-res buffer)
let scale = 1, dpr = 1;     // scale = ART pixels per world unit
let camX = 0, camY = 0;     // camera offset in ART px (subtracted in wx/wy)
const NET = GOAL.depth;     // net depth behind each goal line
const BAND = 240;           // depth (world units) of the top/bottom touchline terraces (~3 audience rows)

function resize() {
  dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  canvas.style.imageRendering = 'pixelated'; // keep the up-scaled blocks crisp
  // Low-res world buffer: render the scene small, then blow it up ×ART_PX.
  wbW = Math.max(1, Math.ceil(canvas.width / ART_PX));
  wbH = Math.max(1, Math.ceil(canvas.height / ART_PX));
  worldBuf.width = wbW; worldBuf.height = wbH;
  wbCtx.imageSmoothingEnabled = false;
  // Tighter zoom (Brawl-Stars-like): player renders large, camera scrolls both
  // axes. `scale` is now ART px/world-unit; ×ART_PX keeps on-screen zoom ~same.
  scale = 1.85 * wbW / FIELD.W;
  bgCanvas.width = Math.ceil((FIELD.W + 2 * NET) * scale);
  bgCanvas.height = Math.ceil((FIELD.H + 2 * BAND) * scale);
  bgCtx.imageSmoothingEnabled = false;
  renderBackground();
}

// Centre the camera on the local player, clamped to the field (+ behind-goal end
// terraces horizontally, + top/bottom touchline terraces vertically). The side
// terraces sit off-pitch, so walking to an edge pans the camera to reveal them.
function updateCamera() {
  const cx = rendered ? rendered.x : FIELD.W / 2;
  const cy = rendered ? rendered.y : FIELD.H / 2;
  const minX = -NET * scale, maxX = (FIELD.W + NET) * scale - wbW;
  camX = clamp(cx * scale - wbW / 2, minX, Math.max(minX, maxX));
  const fieldHpx = FIELD.H * scale, worldHpx = (FIELD.H + 2 * BAND) * scale;
  const minY = -BAND * scale, maxY = (FIELD.H + BAND) * scale - wbH;
  if (worldHpx <= wbH) camY = (fieldHpx - wbH) / 2; // whole bowl fits — centre the pitch
  else camY = clamp(cy * scale - wbH / 2, minY, Math.max(minY, maxY));
}

// World -> ART px (through the camera).
function wx(x) { return x * scale - camX; }
function wy(y) { return y * scale - camY; }
function ws_(v) { return v * scale; }
// Integer-snapped rect fill — the core of the crisp pixel look. All world sprites
// draw through this so their edges land exactly on the low-res grid.
function pxi(x, y, w, h, col) {
  ctx.fillStyle = col;
  ctx.fillRect(Math.round(x), Math.round(y), Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
}
function screenToWorld(px, py) {
  // CSS px -> art px, then invert the camera; undo the flip for a mirrored B view.
  const ax = px * dpr / ART_PX, ay = py * dpr / ART_PX;
  const cx = flipView() ? (wbW - ax) : ax;
  return { x: (cx + camX) / scale, y: (ay + camY) / scale };
}

// Render the static field to the offscreen cache. Temporarily point the camera so
// wx/wy produce bg-local coords (bg pixel 0,0 = world (-NET, -BAND)).
function renderBackground() {
  const sx = camX, sy = camY, sctx = ctx;
  camX = -NET * scale; camY = -BAND * scale; ctx = bgCtx;
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

// Deterministic value noise (stable across re-caches) — drives grass flecks,
// cobble shading, etc. so the pixel textures don't shimmer.
function hash(x, y) { const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return n - Math.floor(n); }

// Cobblestone terraces packed with a blocky mob crowd, wrapping the pitch on all
// four sides. The end terraces (behind the goals) are always in frame; the top and
// bottom touchline terraces sit off-pitch and scroll in as you walk to the edges.
function drawStands() {
  const cA = teamColor('A'), cB = teamColor('B'), midX = FIELD.W / 2;
  drawFanWall(-NET, 0, 0, FIELD.H, cA);                          // behind A's (left) goal
  drawFanWall(FIELD.W, 0, FIELD.W + NET, FIELD.H, cB);           // behind B's (right) goal
  // Split each side terrace at halfway so every team's colours fill its own half.
  drawFanWall(-NET, -BAND, midX, 0, cA);                         // top,    home half
  drawFanWall(midX, -BAND, FIELD.W + NET, 0, cB);                // top,    away half
  drawFanWall(-NET, FIELD.H, midX, FIELD.H + BAND, cA);          // bottom, home half
  drawFanWall(midX, FIELD.H, FIELD.W + NET, FIELD.H + BAND, cB); // bottom, away half
}
function drawFanWall(x0, y0, x1, y1, color) {
  const ax0 = Math.round(wx(x0)), ay0 = Math.round(wy(y0));
  const aw = Math.round(ws_(x1 - x0)), ah = Math.round(ws_(y1 - y0));
  ctx.fillStyle = '#33383a'; ctx.fillRect(ax0, ay0, aw, ah);
  // Cobblestone courses — mottled grey blocks with a top-light edge.
  const b = Math.max(3, Math.round(ws_(26)));
  for (let ay = ay0; ay < ay0 + ah; ay += b) {
    for (let ax = ax0; ax < ax0 + aw; ax += b) {
      const h = hash(ax * 0.7, ay * 0.7);
      ctx.fillStyle = h > 0.7 ? '#6b726a' : h > 0.4 ? '#585f59' : '#484f4a';
      ctx.fillRect(ax + 1, ay + 1, b - 2, b - 2);
      ctx.fillStyle = 'rgba(255,255,255,.06)';
      ctx.fillRect(ax + 1, ay + 1, b - 2, Math.max(1, Math.round(b * 0.18)));
    }
  }
  // Faint team-colour wash so the terrace still reads as home/away even when the
  // card audience (drawn dynamically on top) is sparse or still loading.
  ctx.globalAlpha = 0.1; ctx.fillStyle = color; ctx.fillRect(ax0, ay0, aw, ah); ctx.globalAlpha = 1;
}

// ---- Card audience -----------------------------------------------------------
// Real album cards fill the terraces as a jumping crowd: the local player's own
// cards on their side (home), the opposing team's cards pooled on the far side.
// Seats are laid out once per match (buildAudienceSeats) then drawn per-frame with
// a bob, inside the mirrored-world transform so home stays on the player's own side.
const AUD = { seatW: 64, seatH: 86, gapX: 6, gapY: 9, bob: 8, capPerCard: 12, capTotal: 220, fillMult: 1.6 };
let audSeats = [];
// Expand a ranked card list into one entry per copy (capped), best-worth first.
function expandPool(cards) {
  const out = [];
  for (const c of cards) {
    const copies = Math.max(1, Math.min(AUD.capPerCard, c.c || 1));
    for (let k = 0; k < copies; k++) { out.push(c); if (out.length >= AUD.capTotal) return out; }
  }
  return out;
}
// Fill one side's seats from its card pool. Proportional: the number of occupied
// seats scales with collection size (few cards => visibly sparse), and cards cycle
// to fill ~fillMult× the owned count so a small album still reads as a modest crowd —
// capped at the side's capacity so a big collection packs the stands.
function fillSideSeats(seats, pool) {
  if (!pool.length) return;
  const target = Math.min(seats.length, Math.ceil(pool.length * AUD.fillMult));
  for (let i = 0; i < target; i++) {
    const c = pool[i % pool.length];
    seats[i].r = c.r; seats[i].n = c.n;
    audSeats.push(seats[i]);
  }
}
function buildAudienceSeats() {
  audSeats = [];
  const midX = FIELD.W / 2, mine = me.team === 'B' ? 'B' : 'A';
  const regions = [
    [-NET, 0, 0, FIELD.H, 'A'], [FIELD.W, 0, FIELD.W + NET, FIELD.H, 'B'],
    [-NET, -BAND, midX, 0, 'A'], [midX, -BAND, FIELD.W + NET, 0, 'B'],
    [-NET, FIELD.H, midX, FIELD.H + BAND, 'A'], [midX, FIELD.H, FIELD.W + NET, FIELD.H + BAND, 'B'],
  ];
  // Collect seat slots per side (home = my regions, away = rival regions), in rows.
  const side = { me: [], rv: [] };
  for (const [x0, y0, x1, y1, rt] of regions) {
    const key = rt === mine ? 'me' : 'rv';
    const rw = x1 - x0, rh = y1 - y0;
    const cols = Math.max(1, Math.floor(rw / (AUD.seatW + AUD.gapX)));
    const rows = Math.max(1, Math.floor(rh / (AUD.seatH + AUD.gapY)));
    const usedW = cols * AUD.seatW + (cols - 1) * AUD.gapX;
    const usedH = rows * AUD.seatH + (rows - 1) * AUD.gapY;
    const gap = 2; // front row hugs the pitch (cards right up to the touchline)
    // Anchor to the FIELD-facing edge so the front row hugs the pitch (not centred far out).
    const ox = x1 <= 0 ? x1 - usedW - gap
      : x0 >= FIELD.W ? x0 + gap
      : x0 + (rw - usedW) / 2;
    const oy = y1 <= 0 ? y1 - usedH - gap
      : y0 >= FIELD.H ? y0 + gap
      : y0 + (rh - usedH) / 2;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      side[key].push({ x: ox + c * (AUD.seatW + AUD.gapX), y: oy + r * (AUD.seatH + AUD.gapY), r: null, n: null, seed: r * 1.7 + c * 0.9 + (key === 'rv' ? 3 : 0) });
    }
  }
  const myPool = expandPool(rankCards(myCards()));                          // home = you
  const rivalPool = expandPool(rankCards(
    matchRoster.filter((p) => p.team && p.team !== mine).flatMap((p) => p.cards || []))); // away = rivals pooled
  fillSideSeats(side.me, myPool);
  fillSideSeats(side.rv, rivalPool);
  preloadCards([...myPool, ...rivalPool]);
}
// Perf: the audience is baked into two offscreen layers (even/odd seats), sized like
// the field cache. Each frame we blit those TWO images with opposite vertical bob — a
// lively crowd wave for ~2 drawImage/frame instead of ~80. Re-baked only when card art
// finishes loading (audNeedsRebake) or the canvas resizes.
let audLayers = null, audNeedsRebake = false;
function bakeAudience() {
  const W = bgCanvas.width, H = bgCanvas.height;
  audLayers = [document.createElement('canvas'), document.createElement('canvas')];
  const gx = audLayers.map((c) => { c.width = W; c.height = H; const g = c.getContext('2d'); g.imageSmoothingEnabled = false; return g; });
  const sw = Math.ceil(ws_(AUD.seatW)), sh = Math.ceil(ws_(AUD.seatH));
  for (let i = 0; i < audSeats.length; i++) {
    const s = audSeats[i]; if (!s.r) continue;
    const g = gx[i & 1];
    const px = Math.round((s.x + NET) * scale), py = Math.round((s.y + BAND) * scale); // bg-cache coords
    const img = cardImage(s.r, s.n);
    if (img.ready) g.drawImage(img, px, py, sw, sh);
    else { g.fillStyle = RARITY_GLOW[s.r] || '#8a97a8'; g.fillRect(px, py, sw, sh); }
    g.strokeStyle = 'rgba(0,0,0,.45)'; g.lineWidth = 1; g.strokeRect(px + 0.5, py + 0.5, sw - 1, sh - 1);
  }
}
function drawAudience() {
  if (me.team == null) return;
  if (!audienceReady) { buildAudienceSeats(); audienceReady = true; audNeedsRebake = true; }
  if (audNeedsRebake || !audLayers || audLayers[0].width !== bgCanvas.width) { bakeAudience(); audNeedsRebake = false; }
  const b = Math.sin(performance.now() * 0.004) * ws_(AUD.bob);
  const ox = -(camX + NET * scale), oy = -(camY + BAND * scale);
  ctx.drawImage(audLayers[0], ox, oy + b);   // even seats bob up
  ctx.drawImage(audLayers[1], ox, oy - b);   // odd seats bob down — crowd wave
}

// Quartz-white line palette for all pitch markings.
const MARK = '#e9e6d8', MARK_EDGE = '#c8c4b2';
function markThick() { return Math.max(1, Math.round(ws_(7))); }

// Grass-block surface. A noisy tile is generated once and tiled as a pattern
// (fast — no per-pixel loop even on big canvases), then subtle mowing stripes
// are overlaid. Only re-runs into the static cache, so a cached tile is plenty.
let grassPat = null, grassPatKey = '';
function ensureGrassTile() {
  const key = 'g'; // tile is scale-independent art px; build once
  if (grassPat && grassPatKey === key) return;
  grassPatKey = key;
  const N = 64;
  const tc = document.createElement('canvas'); tc.width = N; tc.height = N;
  const tctx = tc.getContext('2d');
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let col = '#549934';
    const h = hash(x, y);
    if (h > 0.9) col = '#63aa41'; else if (h > 0.8) col = '#5aa23a'; else if (h < 0.1) col = '#468028';
    tctx.fillStyle = col; tctx.fillRect(x, y, 1, 1);
  }
  grassPat = bgCtx.createPattern(tc, 'repeat');
}
function fillGrass(x0w, y0w, x1w, y1w) {
  ensureGrassTile();
  const ax0 = Math.floor(wx(x0w)), ay0 = Math.floor(wy(y0w));
  const aw = Math.ceil(wx(x1w)) - ax0, ah = Math.ceil(wy(y1w)) - ay0;
  ctx.fillStyle = grassPat; ctx.fillRect(ax0, ay0, aw, ah);
  // Mowing stripes: alternating faint light/dark bands across the pitch.
  const stripeH = Math.max(3, Math.round(ws_(72)));
  for (let ay = ay0, i = 0; ay < ay0 + ah; ay += stripeH, i++) {
    ctx.fillStyle = i % 2 ? 'rgba(255,255,255,.055)' : 'rgba(18,54,18,.10)';
    ctx.fillRect(ax0, ay, aw, stripeH);
  }
}

// Penalty box drawn as chunky quartz blocks: front edge + the two sides + spot.
function drawPenaltyBox(lineX, innerX) {
  const t = markThick();
  const xa = Math.min(wx(lineX), wx(innerX)), xw = Math.abs(wx(innerX) - wx(lineX));
  pxi(wx(innerX) - t / 2, wy(PENALTY_TOP), t, ws_(PENALTY_BOTTOM - PENALTY_TOP), MARK); // front
  pxi(xa, wy(PENALTY_TOP) - t / 2, xw, t, MARK);      // top side
  pxi(xa, wy(PENALTY_BOTTOM) - t / 2, xw, t, MARK);   // bottom side
  const spotX = lineX + (innerX - lineX) * 0.62;
  pxi(wx(spotX) - t / 2, wy(FIELD.H / 2) - t / 2, t, t, MARK);
}

function drawField() {
  fillGrass(0, 0, FIELD.W, FIELD.H);
  const t = markThick();
  const L = 10, R = FIELD.W - 10, T = 10, B = FIELD.H - 10;
  // Boundary rectangle (quartz blocks).
  pxi(wx(L), wy(T) - t / 2, ws_(R - L), t, MARK);
  pxi(wx(L), wy(B) - t / 2, ws_(R - L), t, MARK);
  pxi(wx(L) - t / 2, wy(T), t, ws_(B - T), MARK);
  pxi(wx(R) - t / 2, wy(T), t, ws_(B - T), MARK);
  // Halfway line + blocky centre circle + spot.
  pxi(wx(FIELD.W / 2) - t / 2, wy(T), t, ws_(B - T), MARK);
  const cx = FIELD.W / 2, cy = FIELD.H / 2, rr = 90, pieces = 40;
  for (let i = 0; i < pieces; i++) {
    const a = i / pieces * Math.PI * 2;
    pxi(wx(cx + Math.cos(a) * rr) - t / 2, wy(cy + Math.sin(a) * rr) - t / 2, t, t, i % 4 ? MARK : MARK_EDGE);
  }
  pxi(wx(cx) - t / 2, wy(cy) - t / 2, t, t, MARK);
  drawPenaltyBox(0, PENALTY.depth);                 // left box
  drawPenaltyBox(FIELD.W, FIELD.W - PENALTY.depth); // right box
  // Biome bits: poppies + dandelions dotted on the turf (never on the markings).
  const flowers = [[180, 170], [330, 900], [1480, 250], [1770, 860], [520, 560], [1420, 800], [820, 180], [1180, 970]];
  for (let i = 0; i < flowers.length; i++) {
    const [fx, fy] = flowers[i];
    if (Math.abs(fx - cx) < rr + 40 && Math.abs(fy - cy) < rr + 40) continue;
    const c = i % 2 ? '#f5c518' : '#d94b3f';
    const s = Math.max(1, Math.round(ws_(9)));
    pxi(wx(fx), wy(fy), s, s, c);
    pxi(wx(fx) + Math.round(s / 3), wy(fy) + s, Math.max(1, Math.round(s / 3)), s, '#3f7a2a'); // stem
  }
  drawGoal(0, -NET);              // left: line at x=0, net behind (to -NET)
  drawGoal(FIELD.W, FIELD.W + NET); // right: line at x=W, net behind (to W+NET)
}
function drawGoal(lineX, backX) {
  const x0 = Math.min(lineX, backX), w = Math.abs(backX - lineX);
  const nx = wx(x0), ny = wy(GOAL_TOP), nw = ws_(w), nh = ws_(GOAL.width);
  // Dark net backing.
  pxi(nx, ny, nw, nh, '#28312a');
  // Square rope lattice.
  const step = Math.max(3, Math.round(ws_(26)));
  for (let ax = Math.round(nx); ax < nx + nw; ax += step) pxi(ax, ny, 1, nh, 'rgba(236,236,220,.30)');
  for (let ay = Math.round(ny); ay < ny + nh; ay += step) pxi(nx, ay, nw, 1, 'rgba(236,236,220,.30)');
  // Quartz frame on the goal line + chunky corner posts.
  const t = Math.max(2, Math.round(ws_(POST_R * 1.6)));
  pxi(wx(lineX) - t / 2, ny, t, nh, '#eef0f2');
  for (const py of [GOAL_TOP, GOAL_BOTTOM]) {
    pxi(wx(lineX) - t, wy(py) - t, t * 2, t * 2, '#c9cdd2');
    pxi(wx(lineX) - t, wy(py) - t, t * 2, t, '#fff8ea');
  }
}

// Darken a #rrggbb colour (team-kit side shading).
function shade(hex, m = 0.72) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round((n >> 16 & 255) * m), g = Math.round((n >> 8 & 255) * m), b = Math.round((n & 255) * m);
  return `rgb(${r},${g},${b})`;
}

// Chunky Steve/Alex-style kit player, drawn as integer voxels into the low-res
// buffer. Faces the camera and mirrors L<->R toward the aim (`dir`); the whole
// world buffer is flipped for team B, so passing true-world dir stays correct.
// Units are "sprite pixels" with the feet at `feetY`; `sf` scales them to art px.
function drawKitAvatar(ox, feetY, sf, dir, J, JS, walkPhase, moving, firing) {
  const S = (u) => u * sf;
  const sk = '#e7b072', skS = '#c8925a', hair = '#3a2a17', hairS = '#2c2012';
  const eye = '#20242b', wht = '#f2efe4', sh = '#eef0f2', shS = '#c9cdd2', boot = '#20232a', bootS = '#0f1116';
  const swing = Math.sin(walkPhase) * 2 * moving;
  const bob = Math.abs(Math.cos(walkPhase)) * moving;
  const topY = -28 + bob;                              // head top, feet-relative
  const X = (u) => ox + S(u);
  const Y = (u) => feetY + S(topY + u);                // u measured down from head top
  // grounded contact shadow (does not bob)
  pxi(ox + S(-7), feetY + S(-1), S(14), S(3), 'rgba(0,0,0,.30)');
  // legs (skin) + boots — opposite stride
  pxi(X(-4), Y(20), S(3), S(6 + swing), sk);
  pxi(X(-4), Y(26 + swing), S(4), S(2), boot); pxi(X(-4), Y(27 + swing), S(4), S(1), bootS);
  pxi(X(1), Y(20), S(3), S(6 - swing), sk);
  pxi(X(1), Y(26 - swing), S(4), S(2), boot); pxi(X(1), Y(27 - swing), S(4), S(1), bootS);
  // shorts
  pxi(X(-5), Y(17), S(10), S(4), sh); pxi(X(-5), Y(20), S(10), S(1), shS);
  // torso jersey (side shade + number stripe)
  pxi(X(-5), Y(9), S(10), S(9), J);
  pxi(X(-5), Y(9), S(2), S(9), JS); pxi(X(3), Y(9), S(2), S(9), JS);
  pxi(X(-1), Y(11), S(2), S(5), wht);
  // arms (jersey sleeve + skin hand) swinging opposite the legs
  pxi(X(-8), Y(9 - swing), S(3), S(6), J); pxi(X(-8), Y(15 - swing), S(3), S(2), sk);
  pxi(X(5), Y(9 + swing), S(3), S(6), J); pxi(X(5), Y(15 + swing), S(3), S(2), sk);
  // head: skin + hair cap + sideburns
  pxi(X(-5), Y(0), S(10), S(9), sk);
  pxi(X(-5), Y(0), S(10), S(3), hair);
  pxi(X(-5), Y(0), S(2), S(6), hairS); pxi(X(3), Y(0), S(2), S(6), hairS);
  // face — eyes shift toward the facing direction
  const ex = dir >= 0 ? 1 : -1;
  pxi(X(-3 + ex), Y(4), S(2), S(2), wht); pxi(X(1 + ex), Y(4), S(2), S(2), wht);
  pxi(X(-2 + ex), Y(4), S(1), S(2), eye); pxi(X(2 + ex), Y(4), S(1), S(2), eye);
  pxi(X(-1), Y(7), S(3), S(1), skS);
  // muzzle-flash outline while firing
  if (firing) {
    const tk = Math.max(1, Math.round(sf));
    pxi(X(-9), Y(-1), S(18), tk, '#ffd54c'); pxi(X(-9), Y(29), S(18), tk, '#ffd54c');
    pxi(X(-9), Y(-1), tk, S(30), '#ffd54c'); pxi(X(9) - tk, Y(-1), tk, S(30), '#ffd54c');
  }
}

function drawPlayer(p) {
  const ch = CHARACTERS[p.char] || CHARACTERS.player;
  const isMe = p.id === me.playerId;
  const x = wx(p.x), y = wy(p.y), r = ws_(ch.radius * settings.sizeMul);
  const team = teamColor(p.team);
  const speed = Math.hypot(p.vx || 0, p.vy || 0);
  const moving = clamp(speed / Math.max(1, ch.speed * settings.speedMul), 0, 1);
  let idSeed = 0;
  for (let i = 0; i < p.id.length; i++) idSeed = (idSeed + p.id.charCodeAt(i)) % 97;
  const walkPhase = performance.now() * (0.011 + moving * 0.011) + idSeed;
  const dir = (p.aimX || 0) >= 0 ? 1 : -1;
  // Avatar scale is tied directly to the (settings-driven) collision radius so
  // the Player-size slider visibly grows/shrinks the athlete across its range.
  // 0.103 keeps the default sizeMul looking the same as before; the small floor
  // just stops it collapsing at extreme-tiny settings.
  const sf = Math.max(0.2, r * 0.103);        // sprite-pixel -> art px
  const feetY = y + 14 * sf;                  // centres the 28-tall sprite on p.y
  const ox = Math.round(x);
  drawKitAvatar(ox, feetY, sf, dir, team, shade(team), walkPhase, moving, p.firing);

  // Local player: pixel corner-bracket + bobbing marker so you find yourself fast.
  if (isMe) {
    const bw = Math.round(r * 2.4), bh = Math.round(r * 2.7);
    const bx = ox - Math.round(r * 1.2), by = Math.round(y - r * 1.35);
    const cl = Math.max(2, Math.round(ws_(9))), tk = Math.max(1, Math.round(ws_(3))), col = '#fff2a8';
    pxi(bx, by, cl, tk, col); pxi(bx, by, tk, cl, col);
    pxi(bx + bw - cl, by, cl, tk, col); pxi(bx + bw - tk, by, tk, cl, col);
    pxi(bx, by + bh - tk, cl, tk, col); pxi(bx, by + bh - cl, tk, cl, col);
    pxi(bx + bw - cl, by + bh - tk, cl, tk, col); pxi(bx + bw - tk, by + bh - cl, tk, cl, col);
    const ty = by - Math.round(ws_(11));
    pxi(ox - ws_(5), ty, ws_(10), ws_(7), '#ffdd43'); pxi(ox - ws_(2), ty + ws_(7), ws_(4), ws_(4), '#ffdd43');
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
  const W = ctx.canvas.width, H = ctx.canvas.height; // low-res buffer dims (art px)
  const m = 9; // keep the arrow this far inside the edges (art px)
  if (sx >= m && sx <= W - m && sy >= m && sy <= H - m) return; // ball is visible
  const dx = sx - W / 2, dy = sy - H / 2;
  const ang = Math.atan2(dy, dx);
  const ex = clamp(sx, m, W - m), ey = clamp(sy, m, H - m);
  const size = 5;
  ctx.save();
  ctx.translate(ex, ey);
  ctx.fillStyle = 'rgba(10,16,10,.6)';
  ctx.beginPath(); ctx.arc(0, 0, size * 1.1, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#f8efd5';
  ctx.beginPath(); ctx.arc(0, 0, size * 0.5, 0, Math.PI * 2); ctx.fill();
  ctx.rotate(ang);
  ctx.fillStyle = '#ffe27a';
  ctx.beginPath();
  ctx.moveTo(size * 1.6, 0);
  ctx.lineTo(size * 0.55, -size * 0.75);
  ctx.lineTo(size * 0.55, size * 0.75);
  ctx.closePath(); ctx.fill();
  ctx.restore();
}

function drawBall(b) {
  const x = wx(b.x), y = wy(b.y), r = ws_(BALL_RADIUS * settings.ballSizeMul);
  const white = '#f4efe0', whiteHi = '#fdfaf0', whiteSh = '#d7d2c2', black = '#1f201b';
  pxi(x - r * .72, y + r * .72, r * 1.44, r * .34, 'rgba(0,0,0,.30)');       // contact shadow
  // Round-ish body: a plus of two rects clips the corners.
  pxi(x - r, y - r * .62, r * 2, r * 1.24, white);
  pxi(x - r * .62, y - r, r * 1.24, r * 2, white);
  pxi(x - r * .66, y + r * .28, r * 1.32, r * .36, whiteSh);                 // underside shade
  pxi(x - r * .7, y - r * .7, r * .48, r * .42, whiteHi);                    // top-left glint
  // Black panels — centre pentagon + spokes, nudged as it rolls.
  const o = Math.round((b.x + b.y) * .03) % 2;
  const s = r * .34;
  pxi(x - s, y - s, s * 2, s * 2, black);
  pxi(x - r * .86, y - r * .2 + o * r * .12, s, s, black);
  pxi(x + r * .5, y + r * .08 - o * r * .12, s, s, black);
  pxi(x - r * .16, y - r * .9, s, s, black);
  pxi(x - r * .1, y + r * .5 + o * r * .1, s, s, black);
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
  const steps = 9, block = Math.max(2, ws_(5 + charge * 4));
  const col = `rgba(255,${g},${g},${0.55 + 0.4 * charge})`;
  for (let i = 2; i <= steps; i++) {
    const t = i / steps;
    pxi(px + ax * len * t - block / 2, py + ay * len * t - block / 2, block, block, col);
  }
  const mark = Math.max(2, ws_(12 + charge * 5)), tk = Math.max(1, Math.round(ws_(3)));
  const mc = `rgba(255,${g},${g},.95)`;
  pxi(ex - mark, ey - mark, mark * 2, tk, mc); pxi(ex - mark, ey + mark - tk, mark * 2, tk, mc);
  pxi(ex - mark, ey - mark, tk, mark * 2, mc); pxi(ex + mark - tk, ey - mark, tk, mark * 2, mc);
}

function drawProjectile(pr) {
  const x = wx(pr.x), y = wy(pr.y), r = ws_(PROJECTILE.radius);
  const col = teamColor(pr.team);
  pxi(x - r * 1.7, y - r * .45, r * 3.4, r * .9, 'rgba(255,237,142,.42)'); // tracer
  pxi(x - r * 1.15, y - r * 1.15, r * 2.3, r * 2.3, col);
  pxi(x - r * .55, y - r * .55, r * 1.1, r * 1.1, '#fff0aa');
}

// Special = a TNT block: red body, white "TNT" band, wood-grain top, live fuse.
function drawBomb(bomb) {
  const x = wx(bomb.x), y = wy(bomb.y), r = ws_(16);
  // danger radius preview
  ctx.beginPath(); ctx.arc(x, y, ws_(BOMB.radius), 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(239,68,68,.07)'; ctx.fill();
  ctx.setLineDash([ws_(6), ws_(6)]);
  ctx.strokeStyle = 'rgba(239,68,68,.5)'; ctx.lineWidth = Math.max(1, ws_(2)); ctx.stroke();
  ctx.setLineDash([]);
  const t = bomb.fuse / BOMB.fuse;
  const blink = t < 0.35 ? (Math.floor(bomb.fuse * 12) % 2 === 0) : true;
  const red = '#b3352a', redD = '#8f2a20', redHi = '#cf4636';
  const L = x - r, T = y - r, W = r * 2, H = r * 2;
  pxi(L, T - r * .42, W, r * .42, '#7d5a34'); pxi(L, T - r * .42, W, r * .13, '#8f6a40'); // wood top
  pxi(L, T, W, H, red);
  pxi(L, T, W, r * .28, redHi); pxi(L, T, r * .28, H, redHi);
  pxi(L + W - r * .28, T, r * .28, H, redD); pxi(L, T + H - r * .28, W, r * .28, redD);
  pxi(L, y - r * .34, W, r * .68, '#efe7d2'); pxi(L, y - r * .34, W, r * .13, '#fff8e6'); pxi(L, y + r * .22, W, r * .12, '#cabfa6'); // band
  const lc = '#7a2018', u = Math.max(1, Math.round(r * .16));
  pxi(x - r * .62, y - r * .16, u * 3, u, lc); pxi(x - r * .62 + u, y - r * .16, u, u * 3, lc);                 // T
  pxi(x - r * .06, y - r * .16, u, u * 3, lc); pxi(x - r * .06 + u * 2, y - r * .16, u, u * 3, lc); pxi(x - r * .06 + u, y - r * .16 + u, u, u, lc); // N
  pxi(x + r * .34, y - r * .16, u * 3, u, lc); pxi(x + r * .34 + u, y - r * .16, u, u * 3, lc);                 // T
  pxi(x + r * .5, T - r * .55, r * .22, r * .55, '#5b4a2c');                                                    // fuse
  if (blink) { pxi(x + r * .42, T - r * .98, r * .48, r * .48, '#ffe27a'); pxi(x + r * .55, T - r * .86, r * .22, r * .22, '#fff'); }
  else pxi(x + r * .48, T - r * .78, r * .28, r * .28, '#f0792c');
}

// TNT detonation: fat pixel fire core -> flung embers -> blocky smoke -> flash.
function drawBlast(bl) {
  const p = 1 - bl.life / bl.maxLife; // 0..1
  const x = wx(bl.x), y = wy(bl.y), rad = ws_(bl.radius * p);
  const seed = (bl.id * 0.61803398875) % 1;
  const fade = Math.max(0, 1 - p);
  ctx.save();
  // Fire core — chunky filled disc that shrinks as the blast ages.
  const coreR = ws_(bl.radius) * 0.42 * Math.max(0, 1 - p * 1.6);
  const cstep = Math.max(2, Math.round(ws_(7)));
  ctx.globalAlpha = fade;
  for (let ry = -coreR; ry <= coreR; ry += cstep) {
    for (let rx = -coreR; rx <= coreR; rx += cstep) {
      const d = Math.hypot(rx, ry); if (d > coreR) continue;
      pxi(x + rx, y + ry, cstep, cstep, d < coreR * .45 ? '#fff6d0' : d < coreR * .75 ? '#ffce3a' : '#ff7a1e');
    }
  }
  // Flung embers — stable directions per blast id.
  for (let i = 0; i < 26; i++) {
    const jitter = ((Math.sin((i + 1) * 91.733 + seed * 77) + 1) * .5);
    const a = i * 2.399963 + seed * Math.PI * 2;
    const travel = rad * (.2 + jitter * .9);
    const sz = Math.max(2, ws_(4 + (i % 4) * 2) * (1 - p * .4));
    ctx.globalAlpha = fade * (.5 + jitter * .5);
    pxi(x + Math.cos(a) * travel - sz / 2, y + Math.sin(a) * travel - sz / 2, sz, sz,
      i % 5 === 0 ? '#fff7c2' : (i % 3 === 0 ? '#c8382b' : '#ff9b27'));
  }
  // Blocky smoke rolls up behind the sparks.
  if (p > .16) {
    for (let i = 0; i < 12; i++) {
      const a = i * 2.12 + seed * 5;
      const dist = rad * (.12 + (i % 4) * .16);
      const sz = ws_(11 + (i % 3) * 7) * (0.55 + p * .5);
      ctx.globalAlpha = fade * .4;
      pxi(x + Math.cos(a) * dist - sz / 2, y + Math.sin(a) * dist - sz / 2 - ws_(bl.radius) * p * .15, sz, sz, i % 2 ? '#2b2924' : '#493f36');
    }
  }
  // Hard white flash at the instant of detonation.
  if (p < .16) { const core = ws_(26) * (1 + p * 2); ctx.globalAlpha = 1 - p / .16; pxi(x - core / 2, y - core / 2, core, core, '#fffbe0'); }
  ctx.globalAlpha = 1;
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
      : impact.type === 'tramp'
        ? ['#eafff9', '#7bfff0', '#1aa79a']
        : ['#fff0bd', '#a99d7f', '#5a5549'];
  ctx.save();
  ctx.globalAlpha = fade;
  // Pixel burst sprays back from the collision normal.
  const count = impact.type === 'player' ? 16 : 11;
  for (let i = 0; i < count; i++) {
    const spread = ((i / Math.max(1, count - 1)) - .5) * 1.7;
    const a = back + spread + Math.sin(i * 12.31 + impact.id) * .12;
    const dist = ws_(8 + (i % 5) * 8) * (0.3 + p);
    const size = Math.max(2, ws_(impact.type === 'player' ? 7 : 5) * (1 - p * .45));
    pxi(x + Math.cos(a) * dist - size / 2, y + Math.sin(a) * dist - size / 2, size, size, palette[i % palette.length]);
  }
  // Distinct centre marks: pixel X for players, square ring for ball/wall.
  const mark = ws_(10 + p * 22), tk = Math.max(1, Math.round(Math.max(ws_(3), mark * .18)));
  const col = palette[0];
  if (impact.type === 'player') {
    for (let k = -mark; k <= mark; k += Math.max(2, tk)) {
      pxi(x + k - tk / 2, y + k - tk / 2, tk, tk, col);
      pxi(x + k - tk / 2, y - k - tk / 2, tk, tk, col);
    }
  } else {
    pxi(x - mark, y - mark, mark * 2, tk, col); pxi(x - mark, y + mark - tk, mark * 2, tk, col);
    pxi(x - mark, y - mark, tk, mark * 2, col); pxi(x + mark - tk, y - mark, tk, mark * 2, col);
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

// Reflect build charges + reload progress on the build button.
function updateBuildHud(p) {
  if (!buildBtn) return;
  const pips = buildBtn.querySelectorAll('.build-pips i');
  const ammo = p.buildAmmo != null ? p.buildAmmo : BUILD_MAG;
  for (let i = 0; i < pips.length; i++) pips[i].classList.toggle('full', i < ammo);
  const cd = buildBtn.querySelector('.build-cd');
  if (cd) cd.style.transform = `scaleX(${ammo < BUILD_MAG ? (p.buildFrac || 0) : 0})`;
  buildBtn.classList.toggle('empty', ammo <= 0);
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

  // Build-wall HUD: charges + reload on the build button; "hidden" cue when in a bush.
  const meP = latest.players && latest.players.find((pp) => pp.id === me.playerId);
  if (meP) updateBuildHud(meP);
  const hiddenCue = document.getElementById('stealth-cue');
  if (hiddenCue) hiddenCue.classList.toggle('on', !!(rendered && pointInBush(rendered.x, rendered.y) && latest.ball.owner !== me.playerId));

  const banner = document.getElementById('banner');
  if (latest.phase === 'ended') {
    const txt = myScore === opScore ? 'DRAW' : (myScore > opScore ? 'BLUE WINS' : 'RED WINS');
    banner.textContent = txt;
    banner.style.color = myScore > opScore ? TEAM.A.color : (opScore > myScore ? TEAM.B.color : '#fff');
    banner.classList.remove('count'); banner.classList.remove('hidden');
  } else if (latest.resetTimer > 0 && latest.lastGoal) {
    // "GOAL!" during the freeze that shows the scoring positions, then 3-2-1.
    const showing = latest.resetTimer > GOAL_RESET - GOAL_FREEZE_HOLD;
    if (showing) { banner.textContent = 'GOAL!'; banner.style.color = teamColor(latest.lastGoal); banner.classList.remove('count'); }
    else { banner.textContent = String(Math.ceil(latest.resetTimer)); banner.style.color = ''; banner.classList.add('count'); } // main-menu countdown look
    banner.classList.remove('hidden');
  } else if (latest.resetTimer > 0) {
    banner.textContent = Math.ceil(latest.resetTimer).toString();
    banner.style.color = ''; banner.classList.add('count');
    banner.classList.remove('hidden');
  } else {
    banner.classList.remove('count'); banner.classList.add('hidden');
  }
}

function frame() {
  requestAnimationFrame(frame);
  try { renderFrame(); }
  catch (e) { showFatal('frame: ' + e.message + '\n' + ((e.stack || '').split('\n')[1] || '').trim()); }
}
// --------------------------------------------------------------------------
// Arena obstacles — walls, bushes, trampolines. Drawn in the dynamic world layer
// (static layout from /shared/arena.js + built walls from the snapshot) so this
// stays out of the cached-background code. Blocks are raised with a top face +
// bevel + ground shadow to match the TNT bomb's block-height.
// --------------------------------------------------------------------------
const STONE_PAL = { top: '#8f897a', face: '#615c50', hi: 'rgba(255,255,255,.16)', shadow: '#403c35' };

// One raised block (used by stone + built walls). box in WORLD coords.
function drawBlockBox(box, pal, opts = {}) {
  const ax = wx(box.x), ay = wy(box.y), aw = ws_(box.w), ah = ws_(box.h);
  const lift = Math.max(3, ws_(16));            // fake height of the block front face
  const bev = Math.max(2, Math.round(ws_(5)));
  pxi(ax + bev, ay + ah - lift + bev, aw, lift, 'rgba(0,0,0,.30)'); // ground shadow at the base
  pxi(ax, ay - lift, aw, ah + lift, pal.face);   // extruded body (front + sides)
  pxi(ax, ay - lift, aw, ah, pal.top);           // lit top face
  pxi(ax, ay - lift, aw, bev, pal.hi);           // top edge highlight
  pxi(ax, ay - lift, bev, ah, pal.hi);           // left edge highlight
  pxi(ax + aw - bev, ay - lift, bev, ah + lift, pal.shadow); // right edge shadow
  if (opts.texture) opts.texture(ax, ay - lift, aw, ah);
}

function drawWallBlock(w) {
  drawBlockBox(w, STONE_PAL, {
    texture: (ax, ay, aw, ah) => {           // stone courses on the top face
      ctx.fillStyle = 'rgba(0,0,0,.16)';
      for (let y = ay + Math.round(ws_(22)); y < ay + ah; y += Math.max(4, ws_(22))) ctx.fillRect(ax, Math.round(y), aw, 1);
    },
  });
}

function drawBuiltWall(w) {
  const f = (w.hp || 1) / (w.maxHp || 1);
  const g = Math.round(60 + 46 * f);
  const pal = { top: `rgb(190,${g + 26},72)`, face: `rgb(120,${Math.round(52 * f) + 26},36)`, hi: 'rgba(255,224,170,.30)', shadow: '#4a2c12' };
  drawBlockBox(w, pal, {
    texture: (ax, ay, aw, ah) => {
      const along = w.w >= w.h;                // plank lines
      ctx.fillStyle = 'rgba(30,14,0,.35)';
      if (along) for (let x = ax + Math.round(ws_(26)); x < ax + aw; x += Math.max(4, ws_(26))) ctx.fillRect(Math.round(x), ay, 1, ah);
      else for (let y = ay + Math.round(ws_(26)); y < ay + ah; y += Math.max(4, ws_(26))) ctx.fillRect(ax, Math.round(y), aw, 1);
    },
  });
  // Damage cracks + HP pips grow as it's chipped.
  if (f < 0.99) {
    const cx = wx(w.x + w.w / 2), cy = wy(w.y + w.h / 2 - 16);
    ctx.strokeStyle = 'rgba(20,8,0,.7)'; ctx.lineWidth = Math.max(1, ws_(2));
    const n = f < 0.34 ? 4 : 2;
    for (let i = 0; i < n; i++) { const a = i * 2.2 + w.id; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * ws_(w.w * .35), cy + Math.sin(a) * ws_(w.h * .35)); ctx.stroke(); }
  }
  const pipY = wy(w.y) - ws_(16) - Math.max(2, ws_(7));
  for (let i = 0; i < (w.maxHp || 1); i++) {
    pxi(wx(w.x) + i * Math.max(3, ws_(11)) + 2, pipY, Math.max(2, ws_(8)), Math.max(2, ws_(5)), i < w.hp ? '#ffd27a' : 'rgba(0,0,0,.4)');
  }
}

function drawBush(g, t) {
  const ax = wx(g.x), ay = wy(g.y), aw = ws_(g.w), ah = ws_(g.h);
  pxi(ax + ws_(4), ay + ws_(6), aw, ah, 'rgba(0,0,0,.16)');       // soft shadow
  pxi(ax, ay, aw, ah, '#1f5325');                                  // dark base
  // Iterate in WORLD space so the leaf texture is anchored to the pitch — it no
  // longer crawls/shimmers as the camera pans (that was the "jiggle"). Sway is a
  // slow, tiny drift so the bush reads as essentially static.
  const stepW = 30, px = ws_(stepW);
  for (let wyv = g.y + stepW * .3; wyv < g.y + g.h; wyv += stepW) {
    for (let wxv = g.x + stepW * .3; wxv < g.x + g.w; wxv += stepW) {
      const h = hash(wxv * 0.11, wyv * 0.11);
      const sway = Math.sin(t * 0.25 + wxv * 0.02) * ws_(0.8);
      const s = px * (0.7 + h * 0.5);
      pxi(wx(wxv) + sway, wy(wyv), s, s, h > 0.6 ? '#3a8a3c' : '#2f7331');
    }
  }
  // brighter top flecks
  for (let wxv = g.x + stepW * .6; wxv < g.x + g.w; wxv += stepW * 1.5) {
    const sway = Math.sin(t * 0.25 + wxv * 0.02) * ws_(0.8);
    pxi(wx(wxv) + sway, wy(g.y) + ws_(6), Math.max(2, ws_(4)), Math.max(2, ws_(8)), 'rgba(150,220,110,.55)');
  }
}

function drawTramp(tr, t) {
  const x = wx(tr.x), y = wy(tr.y), r = ws_(tr.r);
  ctx.save();
  ctx.beginPath(); ctx.arc(x, y + ws_(6), r + ws_(3), 0, 7); ctx.fillStyle = 'rgba(0,0,0,.28)'; ctx.fill(); // shadow
  ctx.beginPath(); ctx.arc(x, y, r + ws_(4), 0, 7); ctx.fillStyle = '#0e3038'; ctx.fill();               // rim
  ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fillStyle = '#1aa79a'; ctx.fill();
  ctx.beginPath(); ctx.arc(x, y - ws_(3), r * .8, 0, 7); ctx.fillStyle = '#3fe0cf'; ctx.fill();
  ctx.strokeStyle = 'rgba(6,30,34,.55)'; ctx.lineWidth = Math.max(1, ws_(4));
  for (let rr = r - ws_(10); rr > ws_(8); rr -= ws_(12)) { ctx.beginPath(); ctx.arc(x, y, rr, 0, 7); ctx.stroke(); }
  const bob = Math.sin(t * 4) * ws_(3);                                                                   // bouncing up-arrow
  ctx.fillStyle = 'rgba(255,255,255,.9)';
  ctx.beginPath(); ctx.moveTo(x, y - ws_(14) + bob); ctx.lineTo(x - ws_(11), y + ws_(3) + bob); ctx.lineTo(x + ws_(11), y + ws_(3) + bob); ctx.fill();
  ctx.restore();
}

// A hidden enemy in a bush — only a faint grass rustle betrays them.
function drawRustle(p, t) {
  ctx.save(); ctx.globalAlpha = 0.5;
  for (let i = 0; i < 4; i++) {
    const a = t * 3 + i * 1.6;
    pxi(wx(p.x) + Math.cos(a) * ws_(12) - ws_(2), wy(p.y) + Math.sin(a * 1.3) * ws_(8), Math.max(2, ws_(4)), Math.max(2, ws_(9)), 'rgba(130,205,95,.9)');
  }
  ctx.globalAlpha = 1; ctx.restore();
}

// Client-side stealth: can the local player SEE `p`? Teammates always; an enemy in
// a bush is hidden unless close, carrying the ball, or they FIRED from inside the
// bush (which reveals them for BUSH_FIRE_REVEAL).
const BUSH_FIRE_REVEAL = 1000; // ms an enemy stays visible after shooting from a bush
const firedReveal = {};
function canSeePlayer(p) {
  if (p.team === me.team) return true;
  const inBush = pointInBush(p.x, p.y);
  if (p.firing && inBush) firedReveal[p.id] = performance.now();
  if (!inBush) return true;
  if (latest && latest.ball && latest.ball.owner === p.id) return true;
  if (performance.now() - (firedReveal[p.id] || -1e9) < BUSH_FIRE_REVEAL) return true;
  if (rendered && Math.hypot(rendered.x - p.x, rendered.y - p.y) < BUSH_REVEAL_DIST) return true;
  return false;
}

function drawObstacles() {
  const t = performance.now() / 1000;
  for (const g of ARENA.bushes) drawBush(g, t);
  for (const tr of ARENA.trampolines) drawTramp(tr, t);
  for (const w of ARENA.walls) drawWallBlock(w);
  if (latest && latest.walls) for (const w of latest.walls) drawBuiltWall(w);
  // Ghost preview while dragging the build button.
  if (buildDrag.active && rendered) {
    let dx = buildDrag.dx, dy = buildDrag.dy;
    if (flipView()) dx = -dx;
    const l = Math.hypot(dx, dy);
    let ax, ay;
    if (l > 12) { ax = dx / l; ay = dy / l; }
    else { const meV = latest && latest.players.find((q) => q.id === me.playerId); ax = meV ? meV.aimX : 1; ay = meV ? meV.aimY : 0; }
    const horiz = Math.abs(ax) >= Math.abs(ay);
    const gw = horiz ? BUILT_WALL.thick : BUILT_WALL.len;
    const gh = horiz ? BUILT_WALL.len : BUILT_WALL.thick;
    const cx = rendered.x + ax * BUILT_WALL.offset, cy = rendered.y + ay * BUILT_WALL.offset;
    ctx.save(); ctx.globalAlpha = 0.4;
    pxi(wx(cx - gw / 2), wy(cy - gh / 2), ws_(gw), ws_(gh), '#ffd27a');
    ctx.globalAlpha = 1; ctx.restore();
  }
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
    const amp = screenShakeStrength * left * (dpr / ART_PX); // shake in ART px
    camX += (Math.random() * 2 - 1) * amp;
    camY += (Math.random() * 2 - 1) * amp;
  } else {
    screenShakeStrength = 0;
  }

  // --- Render the whole world into the low-res buffer -------------------------
  ctx = wbCtx;
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#0c120c';
  ctx.fillRect(0, 0, wbW, wbH); // backdrop behind the field
  // Team B sees a horizontally-mirrored pitch so they too attack left->right.
  ctx.save();
  if (flipView()) { ctx.translate(wbW, 0); ctx.scale(-1, 1); }
  ctx.drawImage(bgCanvas, -(camX + NET * scale), -(camY + BAND * scale)); // cached field at camera offset
  drawAudience(); // card-art crowd (dynamic, bobbing) on top of the cached terraces
  drawObstacles(); // walls / bushes / trampolines (static layout + built walls)

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
      const isMe = p.id === me.playerId && rendered;
      const dp = isMe ? { ...p, x: rendered.x, y: rendered.y, vx: predVel.x, vy: predVel.y } : p;
      if (!isMe && !canSeePlayer(p)) { drawRustle(p, performance.now() / 1000); continue; } // hidden enemy
      // You + teammates hidden in a bush render translucent, so you can tell you're concealed.
      if (dp.team === me.team && pointInBush(dp.x, dp.y)) {
        ctx.save(); ctx.globalAlpha = 0.5; drawPlayer(dp); ctx.restore();
      } else drawPlayer(dp);
    }
    for (const pr of view.projectiles) drawProjectile(pr);
    for (const impact of view.impacts) drawImpact(impact);
    drawOffscreenBallArrow(view.ball);
  }
  ctx.restore(); // end the mirrored world

  // --- Blow the buffer up onto the display (nearest-neighbour = fat pixels) ---
  ctx = mainCtx;
  mainCtx.imageSmoothingEnabled = false;
  mainCtx.drawImage(worldBuf, 0, 0, wbW, wbH, 0, 0, canvas.width, canvas.height);
  drawHUD(); // HUD/overlays draw crisp, in full-res screen space
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
