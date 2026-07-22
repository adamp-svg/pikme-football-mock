// Web game client: renders the authoritative state with client-side prediction
// for your own player and interpolation for everyone else + the ball.

import {
  FIELD, GOAL, POST_R, PENALTY, BALL_RADIUS, CHARACTERS, TEAM, PROJECTILE, BOMB, MOVE_ACCEL,
  SHOOT_CHARGE_TIME, MAG_SIZE, GOAL_RESET, GOAL_FREEZE_HOLD, MATCH_DURATION,
  BUSH_REVEAL_DIST, SHOT_REVEAL_TIME, BUILD_MAG, BUILT_WALL, BUILD_WINDUP, FULL_CHARGE, BOMB_LOB_RANGE, clamp,
} from '/shared/constants.js';
import { ARENA, resolveWalls, pointInBush } from '/shared/arena.js';
import { PEN, TRAIN_ARENA } from '/shared/training.js';
import { decodeSnapshot } from '/shared/wire.js';
import { drawHero, ACTION_DUR } from '/heroes.js';
import {
  HERO_KEYS, HERO_NAMES, SIGNATURE_NAMES, SKIN_KEYS, SKIN_NAMES, SKIN_RARITY,
  DEFAULT_COSMETIC, normalizeCosmetic,
} from '/shared/cosmetics.js';
let slotIds = [], slotTeam = [], rosterVersion = -1; // binary-snapshot slot->id/team (from the 'roster' control msg)

const PENALTY_TOP = (FIELD.H - PENALTY.width) / 2;
const PENALTY_BOTTOM = (FIELD.H + PENALTY.width) / 2;

const INPUT_RATE = 60;         // inputs sent per second (matches server tick)
const INPUT_DT = 1 / INPUT_RATE;
const INTERP_DELAY = 100;      // ms we render remote entities in the past
const GOAL_TOP = (FIELD.H - GOAL.width) / 2;
const GOAL_BOTTOM = (FIELD.H + GOAL.width) / 2;

// --------------------------------------------------------------------------
// State
// --------------------------------------------------------------------------
let ws = null;
let me = { playerId: null, team: null, char: 'striker' };
let matchId = null;            // stable per-match id from matchStart (app-bound matchResult key)
let training = false;          // true in the training ground (no clock, penned dummy, reset-ball)
let matchResultSent = false;   // one-shot guard: matchResult is posted to the app exactly once per match
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

const chosenChar = 'player'; // one player type (physics); look is set by the cosmetic below
const PREVIEW_KIT = { J: '#3f7bd6', JS: '#2c5aa6' }; // home/picker preview kit colours
function loadCosmetic() { try { return normalizeCosmetic(localStorage.getItem('pikme_cosmetic')); } catch { return DEFAULT_COSMETIC; } }
function saveCosmetic(c) { try { localStorage.setItem('pikme_cosmetic', c); } catch { /* private mode */ } }
let myCosmetic = loadCosmetic();          // this player's chosen "hero:skin"
// Card powers: 3 equipped slots (0 Shot / 1 Speed / 2 Utility), each an owned card
// {r,n} whose RARITY sets the buff strength. Persisted like myCosmetic. null => the
// slot auto-fills from the album's top-3; the server derives the actual buff %.
function loadLoadout() { try { const s = localStorage.getItem('pikme-loadout'); const a = s && JSON.parse(s); return Array.isArray(a) ? a : null; } catch { return null; } }
function saveLoadout(a) { try { localStorage.setItem('pikme-loadout', JSON.stringify(a)); } catch { /* private mode */ } }
let myLoadout = loadLoadout();            // null => auto-fill top-3; else a saved [{r,n}|null] x3
let cosmeticById = {};                    // playerId -> "hero:skin", from the roster control frame
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
// Each slot maps to one OR MORE files; a slot with several files picks one at
// random per play (variety). Custom cues live under /audio (SFX) — see mapping
// in ../../football assets/current-game-sounds/README.md.
const SOUND_FILES = {
  step1: ['/audio/step-grass-1.mp3'], step2: ['/audio/step-grass-2.mp3'],
  kick: ['/audio/kick.mp3'],                                               // kicking the held ball
  powerShot: ['/audio/kick-power-shoot.mp3'],                              // a fully-charged bullet (your "power shoot")
  hit: ['/audio/hit.mp3'], pickup: ['/audio/pickup.mp3'],
  shot: ['/audio/shot-gun-blop.mp3', '/audio/shot-shoot.mp3'],             // firing a normal bullet
  ui: ['/audio/ui-click.mp3'],
  select: ['/audio/enter-room.mp3'],                                       // menu selection cue
  explosion: ['/audio/explosion-bomb.mp3', '/audio/explosion-bomb-large.mp3'], // bomb blast
  wallBreak: ['/audio/wall-break.mp3'],                                    // a built wall is destroyed
  wallBreakStrong: ['/audio/wall-break-strong.mp3'],                       // ...by a FULL-power shot (or bomb)
  wallHit: ['/audio/wall-krack.mp3'],                                      // bullet/ball smacks a wall (no break)
  goalHappy: ['/audio/goal-happy.mp3'], goalConceded: ['/audio/loss.mp3'], // scored for us / against us
  win: ['/audio/win-victory.mp3'], loss: ['/audio/loss.mp3'],             // match-end stings
};
let audioCtx = null;
let masterGain = null;
let soundEnabled = true;   // SFX (bomb/kick/hit/ui) — the 🔊 button
let musicEnabled = true;   // background music on/off — the 🎵 button
let musicUserVol = 0.6;    // user music volume 0..1 (multiplies each track's own base level)
const soundBuffers = new Map();
let soundLoading = null;
let soundEventsReady = false;
let previousBallOwner = null;
let previousResetTimer = 0;
let knownBlasts = new Set();
let knownImpacts = new Set();

// ---- Player animation state (client-inferred → heroes.js drawHero) --------
// The wire only carries velocity/firing/power + the bombs/walls/blasts/impacts
// lists, so we infer each action from those events; see getAnim/triggerAnim.
const animState = {};                 // playerId -> { action, t0, dur, prio, ...params }
let knownBombs = new Set();
let knownWalls = new Map(); // wall id -> { cx, cy, hp, fragile, maxHp } (last snapshot it was seen)
const firingPrev = {};                // playerId -> firing flag last snapshot
const ANIM_PRIO = { shoot: 2, kick: 2, bomb: 3, wall: 4, hit: 5, fly: 6 };
function nearestPlayer(players, x, y, maxD, team) {
  let best = null, bd = maxD;
  for (const pl of players) { if (team && pl.team !== team) continue; const d = Math.hypot(pl.x - x, pl.y - y); if (d < bd) { bd = d; best = pl; } }
  return best;
}
function triggerAnim(id, action, params) {
  const now = performance.now(), prio = ANIM_PRIO[action] || 0, cur = animState[id];
  if (cur && (now - cur.t0) < cur.dur * 1000 && prio < (cur.prio || 0)) return; // keep a higher-priority action
  animState[id] = Object.assign({ action, t0: now, dur: ACTION_DUR[action] || 0.5, prio }, params || {});
}
// Which animation a player is in right now: goal freeze > active timed action > run/idle by velocity.
function getAnim(p) {
  if (latest && latest.lastGoal) return { action: p.team === latest.lastGoal ? 'celebrate' : 'concede' };
  const s = animState[p.id], now = performance.now();
  if (s && (now - s.t0) < s.dur * 1000) return Object.assign({ u: (now - s.t0) / (s.dur * 1000) }, s);
  const sp = Math.hypot(p.vx || 0, p.vy || 0);
  if (sp < 12) return { action: 'idle', facing: 'front' };
  return { action: 'run', facing: (p.vy < 0 && -p.vy >= 0.5 * sp) ? 'back' : 'front' }; // back only in the 10→2 wedge
}

let screenShakeUntil = 0;
let screenShakeStrength = 0;
let lastStepAt = 0;
let lastStepPos = null;
let stepVariant = 0;

try { soundEnabled = localStorage.getItem('pikme-sound') !== 'off'; } catch { /* private mode */ }
try { musicEnabled = localStorage.getItem('pikme-music') !== 'off'; } catch { /* private mode */ }
try { const v = parseFloat(localStorage.getItem('pikme-musicvol')); if (Number.isFinite(v)) musicUserVol = Math.min(1, Math.max(0, v)); } catch { /* private mode */ }

// 🔊 button = SFX only (bomb/kick/hit/ui). Music has its own 🎵 toggle + volume slider.
function updateSoundButton() {
  const btn = document.getElementById('sound-btn');
  if (btn) {
    btn.textContent = soundEnabled ? '🔊' : '🔇';
    btn.classList.toggle('muted', !soundEnabled);
    btn.setAttribute('aria-label', soundEnabled ? 'השתקת אפקטים' : 'הפעלת אפקטים');
    btn.title = soundEnabled ? 'אפקטים' : 'אפקטים מושתקים';
  }
  if (masterGain) masterGain.gain.value = soundEnabled ? 0.72 : 0;
  updateMusicButton();
}
function updateMusicButton() {
  const btn = document.getElementById('music-btn');
  if (btn) {
    btn.textContent = '🎵';
    btn.classList.toggle('muted', !musicEnabled);
    btn.setAttribute('aria-label', musicEnabled ? 'השתקת מוזיקה' : 'הפעלת מוזיקה');
    btn.title = musicEnabled ? 'מוזיקה' : 'מוזיקה מושתקת';
  }
  applyMusicVol();
}
// Effective music volume = the track's own base level × the user's music-volume slider.
function applyMusicVol() {
  const v = musicEnabled ? musicVol * musicUserVol : 0;
  if (musicGain) musicGain.gain.value = v;          // iOS + desktop: the real volume knob
  else if (musicEl) musicEl.volume = v;             // fallback before the graph exists (desktop)
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
    // soundBuffers: slot name -> AudioBuffer[] (one entry per variant file).
    soundLoading = Promise.allSettled(Object.entries(SOUND_FILES).flatMap(([name, urls]) =>
      urls.map(async (url, i) => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`sound ${response.status}: ${url}`);
        const buffer = await audioCtx.decodeAudioData(await response.arrayBuffer());
        const arr = soundBuffers.get(name) || [];
        arr[i] = buffer;
        soundBuffers.set(name, arr);
      })));
  }
  primeMusic(); // bless the music element in this same gesture so iOS lets it autoplay later
}

function playSound(name, volume = 1, rate = 1) {
  if (!soundEnabled || !audioCtx || !masterGain) return;
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  const variants = soundBuffers.get(name);
  if (!variants || !variants.length) return;
  const buffer = variants.length === 1 ? variants[0] : variants[Math.floor(Math.random() * variants.length)];
  if (!buffer) return;
  const source = audioCtx.createBufferSource();
  const gain = audioCtx.createGain();
  source.buffer = buffer;
  source.playbackRate.value = rate;
  gain.gain.value = volume;
  source.connect(gain).connect(masterGain);
  source.start();
}

// Positional SFX get quieter the further the event is from the local player's view:
// a shot smacking a wall across the pitch is faint, and cross-field events fade to
// silence. Returns a 0..1 volume multiplier (squared for a punchy near / faint far
// curve). Non-positional cues (goals, win/loss, UI, music) skip this.
const SFX_FALLOFF = 900; // world units: ~one screen width; beyond it ≈ inaudible
function proximity(x, y) {
  if (!rendered) return 1;
  const d = Math.hypot(x - rendered.x, y - rendered.y);
  const p = clamp(1 - d / SFX_FALLOFF, 0, 1);
  return p * p;
}

// --------------------------------------------------------------------------
// Background music — long tracks streamed via <audio> (not decoded into WebAudio
// buffers). One random song loops through a match; a 5s trimmed track plays over
// the pre-match lobby countdown. Muting the SFX button mutes music too.
// --------------------------------------------------------------------------
const MUSIC_TRACKS = [   // real matches: one of these picked at random and looped
  '/audio/music/pixel-kickoff.mp3', '/audio/music/pixel-rush.mp3',
];
const HOME_MUSIC = '/audio/music/stadium-pulse.mp3';     // the main-lobby (home) theme, looped
const TRAINING_MUSIC = '/audio/music/goooaaall-good.mp3'; // the training ground's own theme
const LOBBY_MUSIC = '/audio/music/lobby-waiting-countdown.mp3'; // full 9s clip; cut at kickoff when the countdown is shorter
let musicEl = null;      // ONE reused <audio> element, blessed once by a user gesture
let musicKind = null;    // 'match' | 'training' | 'lobby' | null — dedupes repeat start calls
let musicVol = 0;        // base volume of the current track (before the music slider)
let musicPrimed = false; // has a tap "blessed" musicEl so iOS lets it autoplay later?
let musicSrcNode = null; // MediaElementSource wrapping musicEl (created once)
let musicGain = null;    // the knob we actually turn — iOS ignores <audio>.volume

function ensureMusicEl() {
  if (!musicEl) { musicEl = new Audio(); musicEl.preload = 'auto'; musicEl.volume = 1; }
  return musicEl;
}
// iOS/WKWebView IGNORES HTMLMediaElement.volume (only the hardware buttons change <audio>
// level), so mute/volume must go through the WebAudio graph. Route the music element via a
// MediaElementSource -> GainNode -> destination; the GainNode is controllable on iOS and
// shares the gesture-unlocked audio session. Same-origin media, so no CORS silencing. The
// source node can only be created ONCE per element, hence the guard.
function ensureMusicGraph() {
  if (musicGain || !audioCtx || !musicEl) return;
  try {
    musicSrcNode = audioCtx.createMediaElementSource(musicEl);
    musicGain = audioCtx.createGain();
    musicSrcNode.connect(musicGain).connect(audioCtx.destination);
    musicEl.volume = 1;   // the GainNode owns the level from here on
    applyMusicVol();
  } catch { /* already connected / unsupported → fall back to musicEl.volume */ }
}
// iOS/WKWebView silently DROPS the first html-audio play when it races AudioContext
// startup — which is exactly the lobby countdown (it fires right after the Quick Match
// tap that creates the context). SFX are WebAudio so they're unaffected; match music only
// works because it plays seconds later once the session has settled. Fix: reuse ONE <audio>
// element and "bless" it inside the tap gesture with an unmuted-but-silent real play, so
// every later track — including the very first countdown clip — is allowed to sound.
function primeMusic() {
  ensureMusicEl();
  ensureMusicGraph();
  if (musicPrimed) return;
  try {
    musicEl.loop = false;
    musicVol = 0; applyMusicVol();      // silent via the gain, but a real UNMUTED play → blesses iOS
    if (!musicEl.src) musicEl.src = LOBBY_MUSIC;
    const p = musicEl.play();
    const settle = () => { if (musicKind === null) { try { musicEl.pause(); musicEl.currentTime = 0; } catch { /* fine */ } } musicPrimed = true; };
    if (p && p.then) p.then(settle).catch(() => { musicPrimed = true; }); else settle();
  } catch { /* no audio support */ }
}
function stopMusic() {
  if (musicEl) { try { musicEl.pause(); } catch { /* already gone */ } }
  musicKind = null; // keep the (blessed) element around for reuse
}
function playMusic(src, loop, volume) {
  ensureMusicEl();
  ensureMusicGraph();
  musicVol = volume;
  try {
    const abs = new URL(src, location.href).href;
    if (musicEl.src !== abs) musicEl.src = src;
    musicEl.currentTime = 0;
    musicEl.loop = !!loop;
    applyMusicVol();                    // sets musicGain.gain (iOS) or musicEl.volume (fallback)
    const p = musicEl.play();
    if (p && p.catch) p.catch(() => { /* autoplay blocked until a gesture */ });
  } catch { /* no audio support */ }
}
function startMatchMusic() {
  const src = MUSIC_TRACKS[Math.floor(Math.random() * MUSIC_TRACKS.length)];
  musicKind = 'match';
  playMusic(src, true, 0.32);
}
function startTrainingMusic() {
  musicKind = 'training';
  playMusic(TRAINING_MUSIC, true, 0.32);
}
function startLobbyCountdownMusic() {
  if (musicKind === 'lobby') return; // countdown payloads repeat every tick; start once
  musicKind = 'lobby';
  playMusic(LOBBY_MUSIC, false, 0.5);
}
function startHomeMusic() {
  if (musicKind === 'home') return;  // already looping the menu theme
  if (!audioCtx) return;             // not unlocked yet — retried on the first tap (see below)
  musicKind = 'home';
  playMusic(HOME_MUSIC, true, 0.32);
}

// Haptics. The web Vibration API covers Android/desktop; iOS WKWebView ignores
// it, so we ALSO notify the native RN shell (expo-haptics) via postMessage.
const VIBE = { hit: 12, playerHit: 28, bomb: [55, 45, 100], goal: [55, 45, 55, 45, 150], concede: 25 };
function haptic(kind) {
  try { if (navigator.vibrate) navigator.vibrate(VIBE[kind] || 15); } catch { /* unsupported */ }
  try { if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify({ t: 'haptic', kind })); } catch { /* not in app */ }
}

// Match-end report to the native RN host (one-way, same bridge as haptic()). The
// game stays 100% PII-free — it reports the outcome; the app attributes it to the
// phone it holds. A snapshot player is HUMAN iff its id is in matchRoster (humans
// captured at match start), else a bot. Never throws off-app (desktop/browser).
function postMatchResult(myT, opT, myScore, opScore) {
  try {
    const result = myScore > opScore ? 'win' : (myScore < opScore ? 'loss' : 'draw');
    const rosterIds = new Set(matchRoster.map((p) => p.id));
    const players = (latest && latest.players) || [];
    const humanOpponents = players.filter((p) => p.team === opT && rosterIds.has(p.id)).length;
    const payload = {
      t: 'matchResult',
      matchId,
      result,                       // win | loss | draw, from MY team's perspective
      myTeam: myT,
      myScore,
      opScore,
      durationSec: MATCH_DURATION,
      humanOpponents,               // opponents whose snapshot id is in matchRoster
      vsHuman: humanOpponents > 0,
    };
    window.ReactNativeWebView?.postMessage(JSON.stringify(payload));
  } catch { /* not in app */ }
}

function processSnapshotSounds(snap) {
  const blastIds = new Set((snap.blasts || []).map((b) => b.id));
  const impactIds = new Set((snap.impacts || []).map((i) => i.id));
  if (soundEventsReady) {
    if (previousResetTimer <= 0 && snap.resetTimer > 0 && snap.lastGoal) {
      const ourGoal = snap.lastGoal === me.team;
      playSound(ourGoal ? 'goalHappy' : 'goalConceded', ourGoal ? 1 : 0.82);
      haptic(ourGoal ? 'goal' : 'concede'); // melodic buzz when we score
      confettiBurst(ourGoal ? 90 : 45);      // the stands erupt on a goal
    }
    if (previousBallOwner === null && snap.ball.owner !== null) {
      playSound('pickup', snap.ball.owner === me.playerId ? 0.55 : 0.28, snap.ball.owner === me.playerId ? 1.08 : 0.96);
    }
    const newBlasts = (snap.blasts || []).filter((b) => !knownBlasts.has(b.id));
    for (const blast of newBlasts) {
      playSound('explosion', 0.85 * proximity(blast.x, blast.y), 0.92 + Math.random() * 0.12);
      const distance = rendered ? Math.hypot(blast.x - rendered.x, blast.y - rendered.y) : 0;
      screenShakeStrength = Math.max(screenShakeStrength, clamp(12 - distance / 65, 2, 12));
      screenShakeUntil = performance.now() + 260;
      haptic('bomb'); // bigger vibration for the blast
    }
    // Walls gone since last snapshot were destroyed this frame. A built wall only ever
    // vanishes AT full hp from a one-shot: a FULL-power bullet or a bomb (weaker hits chip
    // its hp down over earlier snapshots). Bombs sound their own blast, so the "strong"
    // break sting is reserved for a full-hp break with no blast landing on it.
    const curWallIds = new Set((snap.walls || []).map((w) => w.id));
    let brokeAny = false, brokeStrong = false, breakProx = 0;
    const brokenAt = [];
    for (const [id, info] of knownWalls) {
      if (curWallIds.has(id)) continue;
      brokeAny = true;
      brokenAt.push(info);
      breakProx = Math.max(breakProx, proximity(info.cx, info.cy));
      const byBomb = newBlasts.some((b) => Math.hypot(b.x - info.cx, b.y - info.cy) < BOMB.radius);
      if (!info.fragile && info.hp >= info.maxHp && !byBomb) brokeStrong = true;
    }
    if (brokeAny) playSound(brokeStrong ? 'wallBreakStrong' : 'wallBreak', 0.85 * breakProx, 0.94 + Math.random() * 0.12);

    for (const impact of snap.impacts || []) {
      if (knownImpacts.has(impact.id)) continue;
      if (impact.type === 'wall') {
        // The hit that DESTROYED a wall is already covered by the break sting above —
        // don't double it with a krack. Otherwise it's a non-breaking smack.
        const destroyed = brokenAt.some((info) => Math.hypot(info.cx - impact.x, info.cy - impact.y) < 100);
        if (!destroyed) playSound('wallHit', 0.4 * proximity(impact.x, impact.y), 0.98 + Math.random() * 0.06);
      } else {
        const volume = impact.type === 'player' ? 0.5 : 0.34;   // player | ball
        const rate = (impact.type === 'ball' ? 1.12 : 0.96) + Math.random() * 0.06;
        playSound('hit', volume * proximity(impact.x, impact.y), rate);
      }
      haptic(impact.type === 'player' ? 'playerHit' : 'hit'); // buzz on each hit
    }

    // --- animation triggers (same new-event diffing as the sounds above) ---
    const players = snap.players || [];
    for (const b of snap.blasts || []) if (!knownBlasts.has(b.id)) {          // blown off his feet
      for (const pl of players) { const dx = pl.x - b.x, dy = pl.y - b.y, d = Math.hypot(dx, dy);
        if (d < BOMB.radius) triggerAnim(pl.id, 'fly', { dir: [dx || 0.001, dy], strength: clamp(1 - d / BOMB.radius, 0.15, 1) }); }
    }
    for (const im of snap.impacts || []) if (im.type === 'player' && !knownImpacts.has(im.id)) { // took a hit
      const pl = nearestPlayer(players, im.x, im.y, 42);
      if (pl) triggerAnim(pl.id, 'hit', { force: Math.hypot(pl.vx || 0, pl.vy || 0) > 300 ? 1 : 0, dir: [im.dx || -1, im.dy || 0] });
    }
    for (const b of snap.bombs || []) if (!knownBombs.has(b.id)) {            // planted a bomb
      const pl = nearestPlayer(players, b.x, b.y, 70, b.team); if (pl) triggerAnim(pl.id, 'bomb');
    }
    for (const w of snap.walls || []) if (!knownWalls.has(w.id)) {            // built a wall
      const pl = nearestPlayer(players, w.x, w.y, 130, w.team); if (pl) triggerAnim(pl.id, 'wall', { aimSign: (w.x - pl.x) >= 0 ? 1 : -1 });
    }
    for (const p of players) if (p.firing && !firingPrev[p.id]) {            // kick (had the ball) vs shoot
      const hadBall = snap.ball.owner === p.id || previousBallOwner === p.id;
      triggerAnim(p.id, hadBall ? 'kick' : 'shoot', { power: !!p.power, aimSign: (p.aimX || 0) >= 0 ? 1 : -1 });
    }
  }
  previousBallOwner = snap.ball.owner;
  previousResetTimer = snap.resetTimer;
  knownBlasts = blastIds;
  knownImpacts = impactIds;
  knownBombs = new Set((snap.bombs || []).map((b) => b.id));
  knownWalls = new Map((snap.walls || []).map((w) => [w.id, { cx: w.cx, cy: w.cy, hp: w.hp, fragile: w.fragile, maxHp: w.maxHp }]));
  for (const p of (snap.players || [])) firingPrev[p.id] = !!p.firing;
  soundEventsReady = true;
}

// --- On-device crash reporting: show any runtime error on screen ---
function showFatal(msg) {
  try {
    const el = document.getElementById('fatal');
    if (!el) return;
    el.classList.remove('hidden');
    el.textContent = '⚠️ שגיאה (צלמו מסך):\n' + msg;
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
function showScreen(name) {
  // Home loops the menu theme; the pitch + pre-match lobby keep their own music; anything
  // else (friends, etc.) is silent. Quick-match shows 'home' UNDER the VS overlay, so leave
  // music alone then — the lobby countdown music owns that moment and replaces whatever plays.
  if (name === 'home') { if (!quickVs) startHomeMusic(); }
  else if (name !== 'game' && name !== 'lobby') stopMusic();
  for (const k in screens) screens[k].classList.toggle('hidden', k !== name);
}

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

// Pikme identity for Friends & Challenges: the app injects window.PIKME_FOOTBALL_TOKEN
// (same precedent as window.SALTIZ_XP); ?ftoken= is the dev fallback. PIKME_API is the
// pikme-server REST base for the friends endpoints (Task 3).
const FOOTBALL_TOKEN = (() => { try { return window.PIKME_FOOTBALL_TOKEN || new URLSearchParams(location.search).get('ftoken') || null; } catch { return null; } })();
const PIKME_API = (window.PIKME_API || (location.hostname === 'localhost' ? 'http://localhost:3001' : 'https://pikme-server.onrender.com')).replace(/\/$/, '');
let MY_USER_ID = null; // filled from the welcome message (authenticated connections only)

// ---- Player album (cards) -------------------------------------------------
// The app injects window.SALTIZ_CARDS pre-load: a compact, non-PII list [{r,n,c,w}]
// (rarity, card number, copies, worth). Empty on the web/dev without the app.
const CARD_ART_BASE = 'https://pxsjmychuxwufcvqixgu.supabase.co/storage/v1/object/public/cards';
const RARITY_GLOW = { common: '#9ab0c5', rare: '#4ea0ff', epic: '#b46bff', legendary: '#ffb800' };
const RARITY_RANK = { legendary: 3, epic: 2, rare: 1, common: 0 };
// Local-dev only: without the app there's no injected album, so the hub/carousel
// look empty. On localhost we preview a small sample; on any real host (device or
// Render) we NEVER fake it — return the injected cards or nothing.
const DEV_LOCAL = ['localhost', '127.0.0.1', '0.0.0.0'].includes(location.hostname);
const DEV_SAMPLE_CARDS = [
  { r: 'legendary', n: 12, c: 1, w: 640000 }, { r: 'epic', n: 7, c: 3, w: 210000 },
  { r: 'rare', n: 22, c: 1, w: 95000 }, { r: 'common', n: 3, c: 5, w: 30000 },
  { r: 'rare', n: 31, c: 2, w: 88000 }, { r: 'legendary', n: 5, c: 1, w: 300000 },
];
function myCards() {
  if (Array.isArray(window.SALTIZ_CARDS)) return window.SALTIZ_CARDS.slice(0, 256);
  return DEV_LOCAL ? DEV_SAMPLE_CARDS : [];
}
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
// Global toast: a top-level #fp-toast element (outside every .screen), so it's visible
// regardless of which screen (home/lobby/game/friends) the user is on when it fires.
const fpToastEl = document.getElementById('fp-toast');
let _toastT = null;
function toast(msg) {
  if (!fpToastEl) { alert(msg); return; }
  fpToastEl.textContent = msg;
  fpToastEl.classList.remove('hidden');
  if (_toastT) clearTimeout(_toastT);
  _toastT = setTimeout(() => fpToastEl.classList.add('hidden'), 2000);
}

// Show the player's character (their avatar as the face) on the home menu.
function renderHomeCharacter() {
  homeNameEl.textContent = MY_NAME;
  if (MY_AVATAR) { homeFaceEl.style.backgroundImage = `url("${MY_AVATAR}")`; homeFaceEl.textContent = ''; }
  else { homeFaceEl.style.backgroundImage = 'none'; homeFaceEl.textContent = memberInitials(MY_NAME); }
  renderCarousel();
  renderPowerSlots();
  renderHubStats();
  renderHubXp();
  _cardsSig = cardsSig();
}

// Album-derived stats + collector rank on the home hub — all from myCards(), so it
// works the moment the app injects window.SALTIZ_CARDS. The 3rd chip upgrades from
// "copies" to real total views automatically if the app ever injects window.SALTIZ_PROFILE.views.
let _cardsSig = '';
const HUB_RANKS = [
  { min: 5000000, label: '🏆 אספן אגדי' },
  { min: 1000000, label: '💎 אספן אדיר' },
  { min: 250000,  label: '⭐ אספן נדיר' },
  { min: 50000,   label: '🃏 אספן נפוץ' },
  { min: 0,       label: '🌱 אספן מתחיל' },
];
function fmtCompact(n) {
  n = Math.round(Number(n) || 0);
  if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 0 : 1).replace(/\.0$/, '') + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'K';
  return String(n);
}
function setTxt(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }
function cardsSig() {
  const c = myCards(); const x = window.SALTIZ_XP;
  return c.length + ':' + (c[0] ? c[0].r + c[0].n + c[0].w : '') + ':' + (x ? (x.xp ?? x.level ?? '') : '');
}
function renderHubStats() {
  const cards = myCards();
  const videos = new Set(cards.map((c) => c.n)).size;              // distinct card moments owned (of 50)
  const worth = cards.reduce((s, c) => s + (c.w || 0), 0);
  const copies = cards.reduce((s, c) => s + (c.c || 1), 0);
  const views = window.SALTIZ_PROFILE && Number(window.SALTIZ_PROFILE.views);
  setTxt('hub-count', videos + '/50');
  setTxt('hub-worth', fmtCompact(worth));
  if (Number.isFinite(views) && views > 0) { setTxt('hub-extra', fmtCompact(views)); setTxt('hub-extra-l', 'צפיות'); }
  else { setTxt('hub-extra', fmtCompact(copies)); setTxt('hub-extra-l', 'עותקים'); }
  const rankEl = document.getElementById('hub-rank');
  if (rankEl) {
    if (cards.length) {
      rankEl.textContent = (HUB_RANKS.find((r) => worth >= r.min) || HUB_RANKS[HUB_RANKS.length - 1]).label;
      rankEl.classList.remove('hidden');
    } else rankEl.classList.add('hidden');
  }
}

// Football XP bar in the hub top slot. CONTRACT with the experience agent: they
// own the numbers via window.SALTIZ_XP = { xp } (source of truth; the app injects
// it into the WebView like SALTIZ_CARDS); I own the bar's render here. level/next
// follow their spec: level = floor((1+sqrt(1+xp/12.5))/2), xp-to-next = 100*level.
function levelFromXp(xp) { return Math.max(1, Math.floor((1 + Math.sqrt(1 + Math.max(0, xp) / 12.5)) / 2)); }
function renderHubXp() {
  const el = document.getElementById('hub-xp'); if (!el) return;
  const src = window.SALTIZ_XP;
  const xp = src && Number.isFinite(+src.xp) ? +src.xp : (DEV_LOCAL ? 1240 : 0); // honest level-1 default until the app injects XP
  const level = src && +src.level ? +src.level : levelFromXp(xp);
  const base = 50 * level * (level - 1), span = 100 * level;
  const into = Math.max(0, xp - base), pct = span ? Math.max(0, Math.min(1, into / span)) : 0;
  el.innerHTML = '<div class="hub-xp-top"><span class="hub-xp-lvl">רמה <b>' + level + '</b></span>'
    + '<span class="hub-xp-amt">' + fmtCompact(into) + ' / ' + fmtCompact(span) + ' XP</span></div>'
    + '<div class="hub-xp-bar"><b style="width:' + (pct * 100).toFixed(1) + '%"></b></div>';
  el.classList.remove('hidden');
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
    el.dataset.idx = i; // card-powers drag: identify which card was grabbed
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
  // One gesture, two intents: a mostly-HORIZONTAL drag SPINS the coverflow smoothly
  // (follows the finger, snaps + flicks on release); a mostly-UPWARD drag lifts the
  // grabbed card onto a power slot. Intent locks on the first meaningful movement.
  let sx = null, sy = null, mode = null, dragCard = null, ghost = null;
  let cfStart = 0, lastX = 0, lastT = 0, vel = 0;
  const clearGhost = () => {
    if (ghost) { ghost.remove(); ghost = null; }
    document.querySelectorAll('.pslot.pslot-over').forEach((s) => s.classList.remove('pslot-over'));
  };
  const slotUnder = (x, y) => { const el = document.elementFromPoint(x, y); return el && el.closest ? el.closest('.pslot') : null; };
  carouselEl.addEventListener('pointerdown', (e) => {
    sx = e.clientX; sy = e.clientY; mode = null; dragCard = null;
    cfStart = cfIndex; lastX = e.clientX; lastT = performance.now(); vel = 0;
    const cardEl = e.target && e.target.closest ? e.target.closest('.cf-card') : null;
    if (cardEl && cardEl.dataset.idx != null) dragCard = cfCards[+cardEl.dataset.idx] || null;
    stopCarouselAuto();
    // Capture keeps the WHOLE gesture on the carousel — including lifting a card up and
    // OFF the carousel onto a slot — so the sequence doesn't die mid-drag.
    try { carouselEl.setPointerCapture(e.pointerId); } catch { /* older webviews */ }
  });
  carouselEl.addEventListener('pointermove', (e) => {
    if (sx == null) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (!mode) {
      if (dragCard && dy < -16 && Math.abs(dy) > Math.abs(dx) * 0.6) mode = 'drag'; // clear lift -> drag (up-and-over to a side slot)
      else if (Math.abs(dx) > 20) mode = 'swipe';
    }
    if (mode === 'swipe') {
      carouselEl.classList.add('cf-dragging');          // no CSS transition while it tracks the finger
      cfIndex = cfStart - dx / CF_SPACING;              // fractional coverflow follows the drag 1:1
      layoutCarousel();
      const now = performance.now();
      if (now > lastT) { vel = (e.clientX - lastX) / (now - lastT); lastX = e.clientX; lastT = now; }
    } else if (mode === 'drag') {
      if (!ghost) {
        ghost = document.createElement('div');
        ghost.className = 'pslot-ghost rarity-' + dragCard.r;
        const gi = document.createElement('img'); gi.alt = '';
        gi.src = `${CARD_ART_BASE}/${dragCard.r}/${dragCard.n}.webp`;
        ghost.appendChild(gi); document.body.appendChild(ghost);
      }
      ghost.style.left = e.clientX + 'px'; ghost.style.top = e.clientY + 'px';
      const slot = slotUnder(e.clientX, e.clientY);
      document.querySelectorAll('.pslot.pslot-over').forEach((s) => s.classList.remove('pslot-over'));
      if (slot) slot.classList.add('pslot-over');
    }
  });
  const end = (e) => {
    if (sx == null) return;
    if (mode === 'swipe') {
      carouselEl.classList.remove('cf-dragging');       // re-enable transition -> smooth snap
      const flick = vel < -0.45 ? 1 : vel > 0.45 ? -1 : 0; // a fast release spins one more (momentum)
      setCarousel(Math.round(cfIndex) + flick);
    } else if (mode === 'drag' && dragCard) {
      const slot = slotUnder(e.clientX, e.clientY);
      if (slot && slot.dataset.slot != null) setSlotCard(+slot.dataset.slot, dragCard); // drop ANY grabbed card into the slot
    }
    clearGhost();
    sx = sy = null; mode = null; dragCard = null;
    startCarouselAuto();
  };
  carouselEl.addEventListener('pointerup', end);
  carouselEl.addEventListener('pointercancel', end);
})();

// ---- Card powers: equipped-loadout slots -----------------------------------
// 3 fixed slots by the hero. Slot index = power; the RARITY of the card in it sets
// the strength. The server owns the actual buff math — here we only mirror the % for
// display and tell the server which card sits in which slot.
const RARITY_PCT = { legendary: 20, epic: 12, rare: 7, common: 3 };
const SLOT_META = [
  { icon: '⚡', label: 'בעיטה', desc: 'הבעיטה נטענת מהר יותר — קל יותר לשחרר בעיטת עוצמה מלאה לעבר השער.' },   // Shot: faster charge
  { icon: '🏃', label: 'מהירות', desc: 'רצים מהר יותר בלי הכדור — מגיעים ראשונים לכל כדור חופשי.' },            // Speed: faster move
  { icon: '🛡️', label: 'הגנה', desc: 'זמני התאוששות וטעינת קיר קצרים יותר — הפצצה והחומה חוזרות מהר.' },       // Utility: faster cooldowns / wall reload
];
const HEB_RAR = { common: 'נפוץ', rare: 'נדיר', epic: 'אדיר', legendary: 'אגדי' };
function cardOwned(r, n) { return myCards().some((c) => c.r === r && +c.n === +n); }
function validSlot(s) { return s && s.r && s.n != null && cardOwned(s.r, s.n) ? { r: s.r, n: +s.n } : null; }
// The 3-slot loadout used for rendering + sending: a saved loadout (validated against
// the current album) wins; otherwise auto-fill the album's top-3 into slots 0,1,2.
function effectiveLoadout() {
  if (Array.isArray(myLoadout)) return [0, 1, 2].map((i) => validSlot(myLoadout[i]));
  const top = rankCards(myCards()).slice(0, 3);
  return [0, 1, 2].map((i) => (top[i] ? { r: top[i].r, n: +top[i].n } : null));
}
// Drop `card` into `slotIdx` (evict any prior occupant + any other slot holding the same
// card — one instance per card), persist, re-render, and tell the server live.
function setSlotCard(slotIdx, card) {
  const eff = effectiveLoadout();
  if (card) for (let i = 0; i < 3; i++) if (eff[i] && eff[i].r === card.r && +eff[i].n === +card.n) eff[i] = null;
  eff[slotIdx] = card ? { r: card.r, n: +card.n } : null;
  myLoadout = eff; saveLoadout(myLoadout);
  renderPowerSlots();
  sendMsg({ type: 'setLoadout', loadout: myLoadout });
}
// Card thumbnail rendered PIXELATED like the stadium audience: the webp is blitted into a
// device-res canvas with imageSmoothingEnabled=false (nearest-neighbor, cover-fit), matching the
// crowd's crunchy card-art look instead of a smooth photo. w/h are the CSS box dims (for aspect + buffer).
function slotCardEl(card, cls, w, h) {
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  const cv = document.createElement('canvas');
  cv.className = cls;
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  const g = cv.getContext('2d'); g.imageSmoothingEnabled = false;
  const img = new Image();
  img.onload = () => {
    const s = Math.max(cv.width / img.naturalWidth, cv.height / img.naturalHeight); // cover
    const dw = img.naturalWidth * s, dh = img.naturalHeight * s;
    g.imageSmoothingEnabled = false;
    g.clearRect(0, 0, cv.width, cv.height);
    g.drawImage(img, (cv.width - dw) / 2, (cv.height - dh) / 2, dw, dh);
  };
  img.onerror = () => { cv.style.display = 'none'; };
  img.src = `${CARD_ART_BASE}/${card.r}/${card.n}.webp`;
  return cv;
}
const powerSlotsEl = document.getElementById('power-slots');
function renderPowerSlots() {
  if (!powerSlotsEl) return;
  const eff = effectiveLoadout();
  powerSlotsEl.innerHTML = '';
  eff.forEach((card, i) => {
    const meta = SLOT_META[i];
    const item = document.createElement('div'); item.className = 'pslot-item';
    const el = document.createElement('div');
    el.className = 'pslot' + (card ? ' rarity-' + card.r : ' pslot-empty');
    el.dataset.slot = i;
    if (card) el.appendChild(slotCardEl(card, 'pslot-art', 42, 54));
    const icon = document.createElement('span'); icon.className = 'pslot-icon'; icon.textContent = meta.icon;
    const buff = document.createElement('span'); buff.className = 'pslot-buff';
    buff.textContent = card ? '+' + (RARITY_PCT[card.r] || 0) + '%' : '—';
    el.appendChild(icon); el.appendChild(buff);
    // Tap a slot to see what its power does (and remove the card from there).
    el.addEventListener('click', () => showSlotInfo(i));
    const cap = document.createElement('span'); cap.className = 'pslot-cap'; cap.textContent = meta.label; // words: what each slot is
    item.appendChild(el); item.appendChild(cap);
    powerSlotsEl.appendChild(item);
  });
  // "Pick best" — reset to the auto top-3 loadout (clears any manual picks).
  const best = document.createElement('button'); best.className = 'pslot-best'; best.textContent = '★ הטובים ביותר';
  best.addEventListener('click', () => { myLoadout = null; saveLoadout(myLoadout); renderPowerSlots(); sendMsg({ type: 'setLoadout', loadout: effectiveLoadout() }); }); // select cue comes from the delegated menu listener
  powerSlotsEl.appendChild(best);
}
// Tap-a-slot info popup: what the power does + the equipped card's buff, with a remove action.
let powerInfoEl = null;
function hidePowerInfo() { if (powerInfoEl) powerInfoEl.classList.add('hidden'); }
function showSlotInfo(i) {
  const meta = SLOT_META[i]; const card = effectiveLoadout()[i];
  if (!powerInfoEl) {
    powerInfoEl = document.createElement('div');
    powerInfoEl.className = 'pinfo hidden'; powerInfoEl.dir = 'rtl';
    powerInfoEl.innerHTML = '<div class="pinfo-card"></div>';
    powerInfoEl.addEventListener('click', (e) => { if (e.target === powerInfoEl) hidePowerInfo(); });
    document.body.appendChild(powerInfoEl);
  }
  const box = powerInfoEl.querySelector('.pinfo-card');
  box.className = 'pinfo-card' + (card ? ' rarity-' + card.r : '');
  box.innerHTML =
    '<button class="pinfo-x" aria-label="סגור">✕</button>'
    + '<div class="pinfo-head"><span class="pinfo-icon">' + meta.icon + '</span><b>' + meta.label + '</b></div>'
    + '<p class="pinfo-desc">' + meta.desc + '</p>'
    + (card
      ? '<div class="pinfo-eq">קלף מצויד: ' + (HEB_RAR[card.r] || '') + ' · <span class="pinfo-pct">+' + (RARITY_PCT[card.r] || 0) + '% חוזק</span></div>'
      : '<p class="pinfo-empty">חריץ ריק — גררו קלף מהאוסף לכאן כדי לצייד את הכוח.</p>')
    + '<div class="pinfo-tiers">נדירות הקלף קובעת את החוזק: נפוץ +3% · נדיר +7% · אדיר +12% · אגדי +20%</div>'
    + (card ? '<button class="pinfo-remove">הסר קלף מהחריץ</button>' : '');
  box.querySelector('.pinfo-x').addEventListener('click', hidePowerInfo);
  const rm = box.querySelector('.pinfo-remove');
  if (rm) rm.addEventListener('click', () => { setSlotCard(i, null); hidePowerInfo(); });
  powerInfoEl.classList.remove('hidden');
}
// In-match HUD: the 3 equipped cards next to the timer (read-only).
const matchPowersEl = document.getElementById('match-powers');
function renderMatchPowers() {
  if (!matchPowersEl) return;
  const eff = effectiveLoadout();
  matchPowersEl.innerHTML = '';
  eff.forEach((card, i) => {
    const el = document.createElement('div');
    el.className = 'mpwr' + (card ? ' rarity-' + card.r : ' mpwr-empty');
    if (card) el.appendChild(slotCardEl(card, 'mpwr-art', 26, 34));
    else { const s = document.createElement('span'); s.textContent = SLOT_META[i].icon; el.appendChild(s); }
    matchPowersEl.appendChild(el);
  });
}

// ---- Home dancing character -------------------------------------------------
const homeCharCanvas = document.getElementById('home-char');
const homeCharCtx = homeCharCanvas ? homeCharCanvas.getContext('2d') : null;
let homeDanceRAF = null;
// Home preview: the player's chosen hero+skin, jogging gently in place. Uses the
// same drawHero() renderer as the pitch, so what you pick is exactly what you get.
function drawDancer(g, W, H, t) {
  g.clearRect(0, 0, W, H);
  g.imageSmoothingEnabled = false;
  const sf = H / 46, ox = W / 2, feetY = H - sf * 4;
  const walkPhase = t * 0.008;                 // gentle in-place jog
  const dir = Math.sin(t * 0.0009);            // slow look left/right
  drawHero(g, ox, feetY, sf, dir, walkPhase, 0.7, false, myCosmetic, PREVIEW_KIT, t / 1000);
}
function startHomeDance() {
  if (!homeCharCtx || homeDanceRAF) return;
  let lastCardCheck = 0;
  const loop = () => {
    const now = performance.now();
    if (!homeEl.classList.contains('hidden')) {
      drawDancer(homeCharCtx, homeCharCanvas.width, homeCharCanvas.height, now);
      if (now - lastCardCheck > 700) {            // late album injection (cold cache) -> refresh the hub
        lastCardCheck = now;
        if (cardsSig() !== _cardsSig) renderHomeCharacter();
      }
    }
    homeDanceRAF = requestAnimationFrame(loop);
  };
  loop();
}

// ---- Hero picker overlay ----------------------------------------------------
// Full-screen character select: pick a hero (grid) + a tier (Base/Gold/Holo/
// Signature) with a live preview. Saves to localStorage and tells the server.
(function setupHeroPicker() {
  const overlay = document.getElementById('hero-picker');
  const btnOpen = document.getElementById('pick-hero-btn');
  if (!overlay || !btnOpen) return;
  const previewCv = document.getElementById('pick-preview');
  const previewCtx = previewCv.getContext('2d');
  const nameEl = document.getElementById('pick-name');
  const tiersEl = document.getElementById('pick-tiers');
  const heroesEl = document.getElementById('pick-heroes');
  let sel = { hero: 'striker', skin: 'base' };
  let previewRAF = null;

  // static thumbnail of a hero in the currently-selected tier
  function drawThumb(cv, heroKey) {
    const g = cv.getContext('2d'); g.clearRect(0, 0, cv.width, cv.height);
    g.imageSmoothingEnabled = false;
    const sf = cv.height / 40, ox = cv.width / 2, feetY = cv.height - sf * 3;
    drawHero(g, ox, feetY, sf, 1, 0, 0, false, `${heroKey}:${sel.skin}`, PREVIEW_KIT, 0);
  }
  function refreshName() {
    const hn = HERO_NAMES[sel.hero];
    nameEl.textContent = sel.skin === 'sig' ? `${SIGNATURE_NAMES[sel.hero]} · ${hn}` : `${hn} · ${SKIN_NAMES[sel.skin]}`;
  }
  function refreshHeroSel() {
    heroesEl.querySelectorAll('.pick-hero').forEach((el) => {
      const on = el.dataset.hero === sel.hero;
      el.classList.toggle('on', on);
      drawThumb(el.querySelector('canvas'), el.dataset.hero);
    });
  }
  function refreshTierSel() {
    tiersEl.querySelectorAll('.pick-tier').forEach((el) => el.classList.toggle('on', el.dataset.skin === sel.skin));
  }

  // build tier chips + hero grid once
  SKIN_KEYS.forEach((sk) => {
    const b = document.createElement('button');
    b.className = 'pick-tier r-' + SKIN_RARITY[sk]; b.dataset.skin = sk;
    b.innerHTML = `<span class="dot"></span>${SKIN_NAMES[sk]}`;
    b.addEventListener('click', () => { sel.skin = sk; refreshTierSel(); refreshHeroSel(); refreshName(); });
    tiersEl.appendChild(b);
  });
  HERO_KEYS.forEach((hk) => {
    const cell = document.createElement('button');
    cell.className = 'pick-hero'; cell.dataset.hero = hk;
    const c = document.createElement('canvas'); c.width = 66; c.height = 78;
    const lbl = document.createElement('span'); lbl.textContent = HERO_NAMES[hk];
    cell.appendChild(c); cell.appendChild(lbl);
    cell.addEventListener('click', () => { sel.hero = hk; refreshHeroSel(); refreshName(); });
    heroesEl.appendChild(cell);
  });

  function open() {
    unlockAudio();
    const cut = myCosmetic.indexOf(':');
    sel = { hero: myCosmetic.slice(0, cut), skin: myCosmetic.slice(cut + 1) };
    refreshTierSel(); refreshHeroSel(); refreshName();
    overlay.classList.remove('hidden');
    if (!previewRAF) {
      const loop = () => {
        const t = performance.now();
        previewCtx.clearRect(0, 0, previewCv.width, previewCv.height);
        previewCtx.imageSmoothingEnabled = false;
        const sf = previewCv.height / 34, ox = previewCv.width / 2, feetY = previewCv.height - sf * 3;
        drawHero(previewCtx, ox, feetY, sf, Math.sin(t * 0.0009), t * 0.008, 0.7, false, `${sel.hero}:${sel.skin}`, PREVIEW_KIT, t / 1000);
        previewRAF = requestAnimationFrame(loop);
      };
      loop();
    }
  }
  function close() { overlay.classList.add('hidden'); if (previewRAF) { cancelAnimationFrame(previewRAF); previewRAF = null; } }
  function saveAndClose() {
    myCosmetic = normalizeCosmetic(`${sel.hero}:${sel.skin}`);
    saveCosmetic(myCosmetic);
    sendMsg({ type: 'setCosmetic', cosmetic: myCosmetic });
    close();
  }

  btnOpen.addEventListener('click', open);
  document.getElementById('pick-close').addEventListener('click', close);
  document.getElementById('pick-save').addEventListener('click', saveAndClose);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
})();

// The user/home screen is shown first (no title gate): render identity + card
// carousel, start the character dance, and connect straight away.
renderHomeCharacter();
showScreen('home');
startHomeDance();
connect(MY_NAME, MY_AVATAR);
// Cold load can't autoplay the menu theme (browser/iOS gesture policy), so kick it off on
// the user's first interaction — but only if they're still on the home screen.
addEventListener('pointerdown', () => {
  unlockAudio();
  if (homeEl && !homeEl.classList.contains('hidden') && !quickVs) startHomeMusic();
}, { once: true, capture: true });

// A crisp "enter-room" cue whenever the user selects something in the menus — a button or a
// card. Clicking empty space (the stadium canvas behind the UI) stays silent. Skipped during
// gameplay (taps are game actions) and for the audio/settings controls, which keep their own cue.
document.addEventListener('click', (e) => {
  if (!gameEl.classList.contains('hidden')) return;                     // in a match → taps are gameplay
  if (e.target.closest('#sound-btn, #music-btn, #settings')) return;    // these have their own click sound
  if (e.target.closest('button:not([disabled]), .cf-card, [role="button"]')) playSound('select', 0.65);
}, true);

// Home actions.
document.getElementById('quick-match-btn').addEventListener('click', () => { unlockAudio(); sendMsg({ type: 'quickMatch' }); });
document.getElementById('friends-btn').addEventListener('click', () => { unlockAudio(); roomErrorEl.classList.add('hidden'); showScreen('friends'); });
document.getElementById('training-btn').addEventListener('click', () => { unlockAudio(); sendMsg({ type: 'training' }); });
document.getElementById('reset-ball-btn').addEventListener('click', () => { sendMsg({ type: 'resetBall' }); });
// Friends actions.
document.getElementById('create-room-btn').addEventListener('click', () => { unlockAudio(); sendMsg({ type: 'createRoom' }); });
document.getElementById('join-room-btn').addEventListener('click', () => {
  unlockAudio();
  const code = (joinCodeEl.value || '').trim().toUpperCase();
  if (code.length < 3) { showRoomError('הכניסו קוד חדר'); return; }
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
  const sp = playNowBtn.querySelector('span'); if (sp) sp.textContent = 'מתחיל…';
});
function resetPlayNow() {
  playNowBtn.classList.remove('armed');
  const sp = playNowBtn.querySelector('span'); if (sp) sp.textContent = 'שחק עכשיו';
}
// Clear the team lists when entering a fresh room.
function clearLobbyLists() {
  memberRows.clear();
  teamListEl.A.innerHTML = ''; teamListEl.B.innerHTML = '';
}

// --------------------------------------------------------------------------
// Friends & Challenges (Slice 1) — pikme-server REST (Task 3) + WS presence/
// challenge messages (Tasks 4-6). Only reachable for authenticated (Pikme)
// connections: MY_USER_ID is set from `welcome`, which fires loadFriends().
// --------------------------------------------------------------------------
function apiHeaders() { return { 'content-type': 'application/json', 'football-auth': FOOTBALL_TOKEN || '' }; }
async function apiGet(path) {
  try {
    const r = await fetch(`${PIKME_API}${path}`, { headers: apiHeaders() });
    if (!r.ok) { toast('החיבור נכשל, נסה שוב'); return []; }
    return r.json();
  } catch { toast('החיבור נכשל, נסה שוב'); return []; }
}
async function apiPost(path, body) {
  try {
    const r = await fetch(`${PIKME_API}${path}`, { method: 'POST', headers: apiHeaders(), body: JSON.stringify(body) });
    if (!r.ok) { toast('החיבור נכשל, נסה שוב'); return false; }
    return true;
  } catch { toast('החיבור נכשל, נסה שוב'); return false; }
}

let FRIENDS = [];          // [{userId, nickName, image}]
let ONLINE = new Set();    // userIds currently online (from friendsPresence)

async function loadFriends() {
  FRIENDS = await apiGet('/handle-friends');
  sendMsg({ type: 'setFriends', friends: FRIENDS.map((f) => f.userId) });
  renderFriends();
  loadRequests();
}
async function loadRequests() {
  const reqs = await apiGet('/handle-friends/requests');
  renderRequests(reqs);
}
async function searchFriends(q) {
  if (!q || q.length < 2) { renderSearch([]); return; }
  renderSearch(await apiGet(`/handle-friends/search?q=${encodeURIComponent(q)}`));
}

function friendRow(f, opts = {}) {
  const online = ONLINE.has(f.userId);
  const div = document.createElement('div');
  div.className = 'friend-row' + (online ? ' online' : '');
  const dot = document.createElement('span'); dot.className = 'friend-dot';
  const pfp = document.createElement('img'); pfp.className = 'friend-pfp';
  const imgUrl = (f.image || '').toString();
  if (/^https?:\/\//i.test(imgUrl)) pfp.src = imgUrl;
  const nm = document.createElement('span'); nm.className = 'friend-name'; nm.textContent = f.nickName || '';
  div.append(dot, pfp, nm);
  const btn = document.createElement('button');
  btn.className = 'friend-act';
  if (opts.kind === 'search') { btn.textContent = 'הוסף'; btn.onclick = async () => { if (await apiPost('/handle-friends/request', { toUserId: f.userId })) { btn.textContent = 'נשלח'; btn.disabled = true; } }; }
  else if (opts.kind === 'request') { btn.textContent = 'אישור'; btn.onclick = async () => { if (await apiPost('/handle-friends/respond', { requestId: f.requestId, action: 'accept' })) { loadFriends(); } }; }
  else { btn.textContent = 'אתגר'; btn.disabled = !online; btn.onclick = () => sendMsg({ type: 'challenge', toUserId: f.userId }); }
  div.appendChild(btn);
  return div;
}
function renderList(id, items, opts) { const el = document.getElementById(id); if (!el) return; el.innerHTML = ''; items.forEach((f) => el.appendChild(friendRow(f, opts))); }
function renderFriends() { renderList('friend-list', FRIENDS, { kind: 'friend' }); }
function renderSearch(items) { renderList('friend-search-results', items, { kind: 'search' }); }
function renderRequests(items) { renderList('friend-requests', items, { kind: 'request' }); }

function showChallengePrompt(challengeId, fromName) {
  if (!confirm(`${fromName} מזמין אותך למשחק. לקבל?`)) { sendMsg({ type: 'challengeRespond', challengeId, accept: false }); return; }
  sendMsg({ type: 'challengeRespond', challengeId, accept: true });
}

document.getElementById('friend-search')?.addEventListener('input', (e) => searchFriends(e.target.value.trim()));

// --------------------------------------------------------------------------
// Networking
// --------------------------------------------------------------------------
let pingIv = null;        // ping interval for the current socket (cleared on close)
let reconnectT = null;    // pending auto-reconnect timer
function connect(name, avatar) {
  // wss when the page is served over https (Render), ws for local dev.
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}`);
  ws.binaryType = 'arraybuffer'; // snapshots arrive as compact binary frames
  ws.onopen = () => {
    setNet('connected');
    ws.send(JSON.stringify({ type: 'join', authToken: FOOTBALL_TOKEN, name, avatar, cards: myCards(), cosmetic: myCosmetic, loadout: effectiveLoadout() }));
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
    slotIds = []; slotTeam = []; rosterVersion = -1; // reset the binary-snapshot roster baseline
    if (!startEl.classList.contains('hidden')) return; // still on the title screen
    showScreen('home');
    resetPlayNow();
    if (!reconnectT) reconnectT = setTimeout(() => { reconnectT = null; connect(name, avatar); }, 1500);
  };
  ws.onmessage = (e) => {
    if (typeof e.data !== 'string') { // compact binary snapshot
      if (!me.playerId) return; // ignore stray snapshots while in the lobby
      const snap = decodeSnapshot(new DataView(e.data), slotIds, slotTeam, rosterVersion);
      if (!snap) return; // roster seam / stale rosterVersion — wait for the matching roster
      processSnapshotSounds(snap);
      latest = snap;
      snapCount++;
      holdingBall = snap.ball.owner === me.playerId;
      snaps.push({ tRecv: performance.now(), snap });
      if (snaps.length > 60) snaps.shift();
      reconcile(snap);
      return;
    }
    const msg = JSON.parse(e.data);
    if (msg.type === 'welcome') {
      myMemberId = msg.id; // our lobby identity; playerId + team arrive with matchStart
      MY_USER_ID = msg.userId || null;
      if (MY_USER_ID) loadFriends();
    } else if (msg.type === 'roster') {
      rosterVersion = msg.v; // slot->id/team map for the binary snapshots that follow
      slotIds = msg.slots.map((s) => s.id);
      slotTeam = msg.slots.map((s) => s.team);
      cosmeticById = {}; msg.slots.forEach((s) => { cosmeticById[s.id] = s.c || DEFAULT_COSMETIC; }); // per-player look (humans + bots)
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
      showRoomError(msg.msg || 'לא ניתן להצטרף לחדר');
      showScreen('friends');
    } else if (msg.type === 'lobby') {
      if (quickVs) updateVsCountdown(msg); else updateLobbyUI(msg);
    } else if (msg.type === 'matchStart') {
      enterMatch(msg);
    } else if (msg.type === 'toLobby') {
      exitToLobby();
    } else if (msg.type === 'pong') {
      ping = Math.round(performance.now() - msg.t);
    } else if (msg.type === 'friendsPresence') {
      ONLINE = new Set(msg.online || []);
      renderFriends();
    } else if (msg.type === 'challengeReceived') {
      showChallengePrompt(msg.challengeId, msg.fromName);
    } else if (msg.type === 'challengeDeclined') {
      toast('היריב דחה את האתגר');
    } else if (msg.type === 'challengeError') {
      toast(msg.msg || 'האתגר נכשל');
    } else if (msg.type === 'challengeSent') {
      toast('אתגר נשלח');
    }
  };
}

// --------------------------------------------------------------------------
// Lobby <-> match transitions
// --------------------------------------------------------------------------
function enterMatch(msg) {
  me = { playerId: msg.playerId, team: msg.team, char: chosenChar };
  if (msg.settings) { Object.assign(settings, msg.settings); syncSliderUI(); }
  // apply this player's saved bot-difficulty to the match room
  if (botDifficulty && botDifficulty !== 'normal' && ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'settings', botDifficulty }));
  // Reset all interpolation / prediction / sound state for the fresh match.
  latest = null; snaps = []; predicted = null; rendered = null; predVel = { x: 0, y: 0 };
  previousBallOwner = null; previousResetTimer = 0;
  knownBlasts = new Set(); knownImpacts = new Set(); knownWalls = new Map(); knownBombs = new Set(); soundEventsReady = false;
  specialBtn.textContent = specialIcon(me.char);
  matchRoster = Array.isArray(msg.players) ? msg.players : [];
  matchId = msg.matchId || null; // stable id for this match's app-bound result
  matchResultSent = false;       // arm the one-shot matchResult post for the fresh match
  audienceReady = false; // rebuild seat assignment for this match's roster
  training = msg.mode === 'training';
  document.getElementById('train-tag').classList.toggle('hidden', !training);
  document.getElementById('reset-ball-btn').classList.toggle('hidden', !training);
  renderMatchPowers(); // equipped-cards HUD next to the timer (read-only)
  showScreen('game');
  resize();
  renderBackground(); // re-cache the field/stands in our team colours
  if (training) hideTeamIntro();                      // training: straight onto the pitch, no intro
  else if (msg.intro > 0) { quickVs = false; hideTeamIntro(); playPromo(msg.intro); } // team reveal + card-meteor promo
  else if (quickVs) { quickVs = false; hideTeamIntro(); } // the VS countdown already served as the intro
  else showTeamIntro(msg.players);                    // fallback: brief VS intro overlay
  resetPlayNow();
  if (training) startTrainingMusic();                  // training ground gets its own theme
  else startMatchMusic();                              // real match: random background song
}

// Match ended in a private room -> back to that room's lobby (rematch).
function exitToLobby() {
  me = { playerId: null, team: null, char: chosenChar };
  latest = null; snaps = []; predicted = null; rendered = null;
  stopMusic();
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
  if (msg.phase === 'countdown' && msg.countdown > 0) { tiCountEl.textContent = msg.countdown; tiCountEl.classList.remove('hidden'); startLobbyCountdownMusic(); }
  else { tiCountEl.classList.add('hidden'); if (musicKind === 'lobby') stopMusic(); }
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
      nm.textContent = p.id === myMemberId ? `${p.name} (אני)` : p.name;
      rankCards(p.cards).slice(0, 3).forEach((c) => cw.appendChild(introCardEl(c)));
    } else { av.textContent = '🤖'; nm.textContent = 'בוט'; }
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

// ---- Match-start promo cinematic --------------------------------------------
// After matchStart, before play: reveal MY team's heroes, then the team's top-3
// cards meteor onto the pitch (whoosh + impact haptic + screen shake), scaled up
// by rarity. Those 3 are the match's "power boosters" (gameplay hook: promoBoosters).
// The server holds the sim frozen (room.introT) for the same window, so no match
// time is lost and nothing moves behind the overlay.
const promoEl = document.getElementById('promo');
let promoBoosters = [];       // the team's top-3 cards that landed this match (future power-ups)
let promoActive = false;      // true while the promo plays — suppresses the frozen kickoff banner behind it
function promoHeroCanvas(cosmetic) {
  const cv = document.createElement('canvas'); cv.width = 120; cv.height = 140; cv.className = 'promo-hero-cv';
  const g = cv.getContext('2d'); g.imageSmoothingEnabled = false;
  const sf = cv.height / 42, ox = cv.width / 2, feetY = cv.height - sf * 3;
  drawHero(g, ox, feetY, sf, 0.4, 0, 0.6, false, cosmetic || DEFAULT_COSMETIC, PREVIEW_KIT, 0);
  return cv;
}
// Drama scales AGGRESSIVELY with the card's real power: rarity tier + worth
// (worth already bakes in views × the rarity multiplier) + duplicate count.
function cardDrama(c) {
  const rank = RARITY_RANK[c.r] || 0;                                   // tier 0..3
  const worthBoost = Math.min(1, Math.max(0, (Math.log10((c.w || 0) + 1) - 3.3) / 2.7)); // ~0 @2k -> ~1 @1M
  const dupeBoost = Math.min(1, ((c.c || 1) - 1) / 5);                  // 0..1 over 1..6 copies
  return { rank, power: rank + worthBoost * 1.6 + dupeBoost * 1.1 };    // 0 .. ~5.7
}
// Legendary fire: a wall of OUR pixel-fire sprite (fire-sheet.png, 32 frames) around
// the card — each tile a sprite window with its own size/phase/speed/mirror.
function buildFireWall(card, cardW) {
  const wall = document.createElement('div'); wall.className = 'promo-flames';
  const N = 7;
  for (let i = 0; i < N; i++) {
    const t = document.createElement('div'); t.className = 'fire-tile';
    const w = 18 + Math.round(Math.random() * 16);
    t.style.width = w + 'px';
    t.style.height = Math.round(w / (94 / 88) * (1.5 + Math.random() * 0.9)) + 'px';
    t.style.setProperty('--sw', (32 * w) + 'px');                       // sheet width = 32 frames
    t.style.left = Math.round(-12 + (i / (N - 1)) * (cardW + 24) - w / 2) + 'px';
    t.style.bottom = (-8 + Math.round(Math.random() * 12)) + 'px';
    t.style.animationDuration = (0.55 + Math.random() * 0.5).toFixed(2) + 's';
    t.style.animationDelay = '-' + (Math.random() * 0.9).toFixed(2) + 's'; // desync start frame
    if (Math.random() < 0.5) t.style.transform = 'scaleX(-1)';          // mirror some
    wall.appendChild(t);
  }
  card.appendChild(wall);
}
// One card's meteor entrance into its hero's landing zone. k/kn = fan slot within the hero.
function meteorCard(zone, flashEl, c, k, kn) {
  const { rank, power } = cardDrama(c);
  const el = document.createElement('div');
  el.className = 'promo-card rarity-' + c.r;
  el.style.setProperty('--glow', RARITY_GLOW[c.r] || '#fff');
  el.style.setProperty('--start-scale', (2.4 + power * 0.7).toFixed(2)); // bigger entry the stronger the card
  el.style.setProperty('--glow-px', (14 + power * 12).toFixed(0) + 'px');
  el.style.setProperty('--land-x', ((k - (kn - 1) / 2) * 42) + 'px');   // fan the hero's cards (wider spread)
  el.style.zIndex = String(10 + k);
  const fallMs = Math.round(460 + power * 55);                          // heavier cards fall a touch longer
  el.style.transitionDuration = (fallMs / 1000) + 's';
  if (rank === 3) buildFireWall(el, 66);                                // legendary fire (our sprite sheet)
  const inner = document.createElement('div');
  inner.className = 'promo-card-inner rarity-' + c.r; inner.dataset.n = c.n;
  const img = document.createElement('img'); img.alt = '';
  img.onerror = () => inner.classList.add('cf-noart');
  img.src = `${CARD_ART_BASE}/${c.r}/${c.n}.webp`;
  inner.appendChild(img); el.appendChild(inner);
  zone.appendChild(el);
  playSound('shot', Math.min(1, 0.4 + power * 0.12), Math.max(0.5, 0.82 - power * 0.06)); // whoosh (lower = heavier)
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('land')));
  setTimeout(() => {                                                    // impact
    playSound('explosion', Math.min(1, 0.4 + power * 0.13), Math.max(0.6, 1.28 - power * 0.07));
    haptic(power >= 3 ? 'bomb' : 'hit');
    promoEl.style.setProperty('--shake', (3 + power * 4).toFixed(0) + 'px');
    promoEl.classList.remove('shake'); void promoEl.offsetWidth; promoEl.classList.add('shake');
    flashEl.classList.remove('hit'); void flashEl.offsetWidth; flashEl.classList.add('hit');
    el.classList.add('landed');
  }, fallMs + 20);
}
function playPromo(introMs) {
  if (!promoEl) return;
  promoActive = true;
  const heroesEl = promoEl.querySelector('.promo-heroes');
  const flashEl = document.getElementById('promo-flash');
  heroesEl.innerHTML = '';
  // my team (2 slots; bot fill). Each hero gets its OWN top cards beneath it.
  const mates = matchRoster.filter((p) => p.team === me.team);
  const queue = []; promoBoosters = [];
  for (let i = 0; i < 2; i++) {
    const p = mates[i] || null;
    const col = document.createElement('div'); col.className = 'promo-hero';
    col.appendChild(promoHeroCanvas(p ? p.cosmetic : DEFAULT_COSMETIC));
    const nm = document.createElement('div'); nm.className = 'promo-hero-name';
    nm.textContent = p ? (p.id === myMemberId ? `${p.name} (אני)` : p.name) : 'בוט';
    col.appendChild(nm);
    const zone = document.createElement('div'); zone.className = 'promo-hero-cards';
    col.appendChild(zone); heroesEl.appendChild(col);
    // Same cards as the lobby loadout: MY live equipped set, teammates' equipped set from
    // the roster; fall back to their top-3 only if no loadout came through.
    const enrich = (slot) => { if (!slot) return null; const src = (p && p.cards) || myCards(); return src.find((c) => c.r === slot.r && +c.n === +slot.n) || { r: slot.r, n: +slot.n, w: 0, c: 1 }; };
    const eq = (p && p.id === myMemberId) ? effectiveLoadout() : (p && p.loadout);
    const cards = (Array.isArray(eq) ? eq.map(enrich).filter(Boolean) : rankCards((p && p.cards) || []).slice(0, 3));
    promoBoosters.push(...cards); preloadCards(cards);
    cards.forEach((c, k) => queue.push({ zone, card: c, k, kn: cards.length }));
  }
  promoEl.classList.remove('hidden');
  requestAnimationFrame(() => promoEl.classList.add('show'));
  const startDelay = 620;
  const perCard = Math.max(500, Math.min(680, Math.floor(((introMs || 4600) - 1700) / Math.max(1, queue.length)))); // longer gap between cards
  queue.forEach((j, idx) => setTimeout(() => meteorCard(j.zone, flashEl, j.card, j.k, j.kn), startDelay + idx * perCard));
  const done = (introMs || 4600) - 300;                                // linger on the landed cards, then reveal as the server unfreezes
  setTimeout(() => { promoActive = false; promoEl.classList.remove('show'); setTimeout(() => promoEl.classList.add('hidden'), 340); }, done);
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
  lobbyTitleEl.innerHTML = `<span></span> ${isPrivate ? 'חדר פרטי' : 'משחק מהיר'} <span></span>`;
  lobbyCodeWrap.classList.toggle('hidden', !isPrivate);
  if (isPrivate && msg.code) lobbyCodeEl.textContent = msg.code;
  // Team picking + PLAY NOW are private-room only; quick match auto-teams + auto-starts.
  joinBtn.A.style.display = isPrivate ? '' : 'none';
  joinBtn.B.style.display = isPrivate ? '' : 'none';
  playNowBtn.style.display = isPrivate ? '' : 'none';
  lobbyHintEl.textContent = isPrivate
    ? 'בחרו קבוצה ואז שחקו עכשיו. מקומות פנויים יתמלאו בבוטים.'
    : 'מחפש שחקנים… המשחק יתחיל אוטומטית.';

  if (msg.phase === 'countdown' && msg.countdown > 0) {
    countdownEl.textContent = msg.countdown;
    countdownEl.classList.remove('hidden');
    startLobbyCountdownMusic();
  } else {
    countdownEl.classList.add('hidden');
    if (musicKind === 'lobby') stopMusic();
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
    const label = m.id === myMemberId ? `${m.name} (אני)` : m.name;
    if (nm.textContent !== label) nm.textContent = label;
    st.textContent = m.inMatch ? '● במשחק' : '';
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
  const map = { connected: 'מחובר', 'reconnecting…': 'מתחבר מחדש…', disconnected: 'מנותק' };
  document.getElementById('net').textContent = map[s] || s;
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
  resolveWalls(e, r, latest && latest.walls, undefined, fieldArena().walls);
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
let holding = false;       // fire trigger currently HELD (charge builds server-side)
let fireQueued = false;    // a real fire (pulled-out release) this frame
let specialQueued = false; // special skill
let buildQueued = false;   // a wall build was released this frame
let buildHold = null;      // aim captured at build-button release (drag-to-aim)
let aimHold = null;        // aim captured at right-stick release (fire direction)
let chargeStart = null;    // timestamp the hold began — LOCAL charge estimate for the HUD only
const AIM_DEADZONE_PX = 12; // stick/cursor pull past this = a real shot; inside it = cancel

let specialAim = { x: 0, y: 0 };   // captured lob offset (0..1 of BOMB_LOB_RANGE, true-world dir) for the next special edge
let bombDrag = { active: false, id: null, cx: 0, cy: 0, dx: 0, dy: 0, aimed: false };
const MAX_LOB_DRAG_PX = 90;        // screen drag that maps to a full-range lob

let buildHolding = false;  // build control currently HELD (windup ramps server-side)
let buildStart = null;     // timestamp the build hold began — LOCAL windup estimate for the HUD
const BUILD_MS = BUILD_WINDUP * 1000;
function beginBuild() { if (!buildHolding) { buildHolding = true; buildStart = performance.now(); } }
function currentWindup() { return buildStart === null ? 0 : Math.min(1, (performance.now() - buildStart) / BUILD_MS); }
function cancelBuild() { buildHolding = false; buildStart = null; buildHold = null; }

// Build a wall — like a shot, you can drag to aim (pull-to-build) then release.
function releaseBuild(aim) { buildQueued = true; if (aim) buildHold = aim; playSound('ui', 0.5, 0.86); }

const CHARGE_MS = SHOOT_CHARGE_TIME * 1000;
function beginCharge() { if (!me.playerId) return; if (!holding) { holding = true; chargeStart = performance.now(); } } // no firing/charge (or shot sound) outside a live match — tapping the menu is silent
function currentCharge() { return chargeStart === null ? 0 : Math.min(1, (performance.now() - chargeStart) / CHARGE_MS); }
// Commit a shot: fire in the pulled-out direction. The SERVER owns the actual
// charge (accumulated from the held trigger); we just flag the release.
function releaseShot(aim) {
  if (!holding) return; // charge already consumed — a second trigger source must not re-fire
  if (aim) aimHold = aim;
  fireQueued = true;
  const c = currentCharge();
  if (holdingBall) playSound('kick', 0.85, 0.92 + c * 0.16);        // kicking the held ball
  else if (c >= FULL_CHARGE) playSound('powerShot', 0.7);           // fully-charged bullet — the "power shoot" cue
  else playSound('shot', 0.38, 0.92 + c * 0.16);                    // a normal bullet (gun blop / shoot)
  holding = false; chargeStart = null;
}
// Cancel a charge: trigger returned to centre — no shot, no sound.
function cancelCharge() { if (!holding) return; holding = false; chargeStart = null; aimHold = null; }
// Is the aim pulled out of the deadzone (mouse/keyboard aim toward the cursor)?
function aimPulled() {
  if (!rendered) return true;
  const w = screenToWorld(mouse.x, mouse.y);
  return Math.hypot(w.x - rendered.x, w.y - rendered.y) > ownRadius() * 1.3;
}

const keys = {};
addEventListener('keydown', (e) => {
  keys[e.key.toLowerCase()] = true;
  if (e.key === ' ' && !e.repeat) beginCharge();     // hold space to charge
  if (e.key.toLowerCase() === 'e') specialQueued = true;
  if (e.key.toLowerCase() === 'q' && !e.repeat) beginBuild(); // hold Q to wind up a wall
});
addEventListener('keyup', (e) => {
  keys[e.key.toLowerCase()] = false;
  if (e.key === ' ') { if (aimPulled()) releaseShot(); else cancelCharge(); } // release fires; cursor on self cancels
  if (e.key.toLowerCase() === 'q') { if (currentWindup() >= 1) releaseBuild(); else cancelBuild(); } // release builds in facing dir; early = cancel
});

let mouse = { x: 0, y: 0, down: false };
const canvas = document.getElementById('canvas');
canvas.addEventListener('mousemove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; });
canvas.addEventListener('mousedown', (e) => {
  if (e.button === 2) { specialQueued = true; specialAim = { x: 0, y: 0 }; }   // right-click = special, feet plant
  else { mouse.down = true; beginCharge(); }       // hold left-click to charge
});
addEventListener('mouseup', (e) => { if (mouse.down && e.button !== 2) { if (aimPulled()) releaseShot(); else cancelCharge(); } mouse.down = false; });
addEventListener('contextmenu', (e) => e.preventDefault());

// Special-skill button (touch + click)
const specialBtn = document.getElementById('special');
const pauseBtn = document.getElementById('pause-btn');
const soundBtn = document.getElementById('sound-btn');
const settingsPanel = document.getElementById('settings');
// Bomb: a TAP plants at your feet (rocket-jump). A press-and-DRAG aims a short lob;
// release past the deadzone throws it, release back inside the deadzone (after having
// dragged out) cancels — no bomb, no sound, no cooldown.
if (specialBtn) {
  specialBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { specialBtn.setPointerCapture(e.pointerId); } catch { /* older webview */ }
    bombDrag = { active: true, id: e.pointerId, cx: e.clientX, cy: e.clientY, dx: 0, dy: 0, aimed: false };
  });
  specialBtn.addEventListener('pointermove', (e) => {
    if (!bombDrag.active || e.pointerId !== bombDrag.id) return;
    bombDrag.dx = e.clientX - bombDrag.cx; bombDrag.dy = e.clientY - bombDrag.cy;
    if (Math.hypot(bombDrag.dx, bombDrag.dy) > AIM_DEADZONE_PX) bombDrag.aimed = true; // once out, stays "aimed" even if it returns to center
  });
  const endBombDrag = (e) => {
    if (!bombDrag.active || e.pointerId !== bombDrag.id) return;
    const len = Math.hypot(bombDrag.dx, bombDrag.dy);
    if (len > AIM_DEADZONE_PX) {
      // A real drag = aimed lob. Map drag magnitude to a 0..1 fraction of the range.
      const frac = Math.min(1, len / MAX_LOB_DRAG_PX);
      let dx = bombDrag.dx / len, dy = bombDrag.dy / len;
      if (flipView()) dx = -dx; // screen -> true-world for team B's mirrored view
      specialAim = { x: dx * frac, y: dy * frac };
      specialQueued = true; playSound('hit', 0.5, 0.82); flashSpecialCooldown();
    } else if (bombDrag.aimed) {
      // Dragged out of the deadzone at some point, then brought back in before releasing
      // = cancel. No bomb, no sound, no cooldown.
    } else {
      // No meaningful drag at all = a tap = feet plant (rocket-jump). Snappy, like before.
      specialAim = { x: 0, y: 0 };
      specialQueued = true; playSound('hit', 0.5, 0.82); flashSpecialCooldown();
    }
    bombDrag.active = false; bombDrag.id = null; bombDrag.dx = 0; bombDrag.dy = 0; bombDrag.aimed = false;
  };
  specialBtn.addEventListener('pointerup', endBombDrag);
  specialBtn.addEventListener('pointercancel', endBombDrag);
}

// Build button — press and DRAG to aim the wall (pull-to-build), release to place.
// A plain tap builds in the direction you're facing. Pointer events cover mouse+touch.
const buildBtn = document.getElementById('build');
let buildDrag = { active: false, id: null, cx: 0, cy: 0, dx: 0, dy: 0 };
if (buildBtn) {
  buildBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { buildBtn.setPointerCapture(e.pointerId); } catch { /* older webview */ }
    buildDrag = { active: true, id: e.pointerId, cx: e.clientX, cy: e.clientY, dx: 0, dy: 0 };
    beginBuild();
  });
  buildBtn.addEventListener('pointermove', (e) => {
    if (!buildDrag.active || e.pointerId !== buildDrag.id) return;
    buildDrag.dx = e.clientX - buildDrag.cx; buildDrag.dy = e.clientY - buildDrag.cy;
  });
  const endBuildDrag = (e) => {
    if (!buildDrag.active || e.pointerId !== buildDrag.id) return;
    // Release only COMMITS if the windup is full AND the aim is pulled out of the deadzone;
    // otherwise it cancels (no wall, no charge). The server also gates on windup.
    const pulled = Math.hypot(buildDrag.dx, buildDrag.dy) > AIM_DEADZONE_PX;
    if (pulled && currentWindup() >= 1) releaseBuild({ x: buildDrag.dx, y: buildDrag.dy });
    else cancelBuild();
    buildDrag.active = false; buildDrag.id = null; buildDrag.dx = 0; buildDrag.dy = 0;
    buildHolding = false; buildStart = null;
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
// 🎵 music toggle (separate from SFX) + the music-volume slider in settings.
const musicBtn = document.getElementById('music-btn');
if (musicBtn) musicBtn.addEventListener('click', () => {
  unlockAudio();
  musicEnabled = !musicEnabled;
  try { localStorage.setItem('pikme-music', musicEnabled ? 'on' : 'off'); } catch { /* private mode */ }
  updateMusicButton();
});
const musicVolSlider = document.getElementById('s-musicvol');
if (musicVolSlider) {
  musicVolSlider.value = String(musicUserVol);
  musicVolSlider.addEventListener('input', () => {
    musicUserVol = Math.min(1, Math.max(0, parseFloat(musicVolSlider.value) || 0));
    try { localStorage.setItem('pikme-musicvol', String(musicUserVol)); } catch { /* private mode */ }
    applyMusicVol();
  });
}
updateMusicButton();

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
// Bot difficulty selector — persists locally, pushed live to the authoritative server.
let botDifficulty = (() => { try { return localStorage.getItem('pikme-bot-diff') || 'normal'; } catch { return 'normal'; } })();
const diffBtns = Array.from(document.querySelectorAll('#difficulty .diff-btn'));
function syncDifficultyUI() { for (const b of diffBtns) b.classList.toggle('active', b.dataset.diff === botDifficulty); }
function setDifficulty(d) {
  botDifficulty = d;
  try { localStorage.setItem('pikme-bot-diff', d); } catch { /* private mode */ }
  syncDifficultyUI();
  playSound('ui', 0.5, 1.05);
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'settings', botDifficulty: d }));
}
for (const b of diffBtns) b.addEventListener('click', () => setDifficulty(b.dataset.diff));

function openSettings() {
  playSound('ui', 0.45);
  holding = false; chargeStart = null; fireQueued = false; specialQueued = false; aimHold = null;
  settingsPanel.classList.remove('hidden');
  syncSliderUI();
  syncDifficultyUI();
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
      // Right stick is AIM. Released while pulled OUT -> fire in that direction.
      // Released back at CENTRE (deadzone) -> CANCEL (no shot).
      if (Math.hypot(touchR.dx, touchR.dy) > AIM_DEADZONE_PX) releaseShot({ x: touchR.dx, y: touchR.dy });
      else cancelCharge();
      touchR.id = null; touchR.dx = 0; touchR.dy = 0; touchR.active = false; stickR.classList.add('hidden');
    }
  }
}, { passive: false });

// iOS can fire touchcancel instead of touchend (system gesture / notification).
// Reset the sticks so a controller can never get stuck.
addEventListener('touchcancel', (e) => {
  for (const t of e.changedTouches) {
    if (t.identifier === touchL.id) { touchL.id = null; touchL.dx = 0; touchL.dy = 0; stickL.classList.add('hidden'); }
    else if (t.identifier === touchR.id) { cancelCharge(); touchR.id = null; touchR.dx = 0; touchR.dy = 0; touchR.active = false; stickR.classList.add('hidden'); }
  }
}, { passive: false });

// Build the current input from whichever control scheme is active.
function sampleInput() {
  // Settings pause only this player. A realtime multiplayer room must never be
  // globally frozen by one client (especially if that client disconnects).
  if (!settingsPanel.classList.contains('hidden')) {
    // Paused: drop any charge/queued edges so nothing accumulates and fires on resume.
    holding = false; chargeStart = null; fireQueued = false; specialQueued = false; buildQueued = false; aimHold = null; buildHold = null;
    buildHolding = false; buildStart = null;
    bombDrag.active = false; specialAim = { x: 0, y: 0 };
    return { moveX: 0, moveY: 0, aimX: 0, aimY: 0, hold: false, fire: false, special: false, build: false };
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
  const fire = fireQueued; fireQueued = false;
  const special = specialQueued; specialQueued = false;
  const sax = special ? specialAim.x : 0, say = special ? specialAim.y : 0;
  if (special) specialAim = { x: 0, y: 0 };
  const build = buildQueued; buildQueued = false;
  return { moveX, moveY, aimX, aimY, hold: holding, fire, special, build, buildHold: buildHolding, sax, say };
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
const BAND = 380;           // depth (world units) of the top/bottom touchline terraces (~4 audience rows, packed pitch->edge)

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
const AUD = { seatW: 64, seatH: 86, gapX: 6, gapY: 9, capPerCard: 12, capTotal: 260 };
// The crowd animates as N offscreen layers, each with its own rapid, out-of-phase
// jitter — overlapping they read as a chaotic jumping mob, not one smooth wave.
const N_LAYERS = 6;
const LAYERS = Array.from({ length: N_LAYERS }, (_, i) => ({
  fy: 8.5 + i * 1.7, phy: i * 1.9, ay: 6 + (i % 3) * 3,   // vertical jump: fast, varied
  fx: 5.5 + i * 1.1, phx: i * 2.7 + 1, ax: 2 + (i % 2) * 3, // small side sway
}));
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
// Spread `pool` across a section's seats: if there are more cards than seats, fill
// every seat; if fewer, space the cards out so the album is visible among empty
// seats (never clumped). Called PER section so top / bottom / goal all show the
// same set. Only the user's own cards are used — few cards => mostly empty stands.
function spreadPool(seats, pool) {
  const S = seats.length, P = pool.length;
  if (!S || !P) return;
  const place = (st, c) => { st.r = c.r; st.n = c.n; audSeats.push(st); };
  if (P >= S) { for (let i = 0; i < S; i++) place(seats[i], pool[i]); return; }
  const step = S / P;
  for (let k = 0; k < P; k++) place(seats[Math.min(S - 1, Math.round(k * step + step * 0.5))], pool[k]);
}
function buildAudienceSeats() {
  audSeats = [];
  const pool = expandPool(rankCards(myCards())); // ONLY the user's own album; sparse if few
  if (!pool.length) return;                        // no cards -> empty stands (as requested)
  const midX = FIELD.W / 2;
  const regions = [
    [-NET, 0, 0, FIELD.H], [FIELD.W, 0, FIELD.W + NET, FIELD.H],           // behind each goal
    [-NET, -BAND, midX, 0], [midX, -BAND, FIELD.W + NET, 0],               // top
    [-NET, FIELD.H, midX, FIELD.H + BAND], [midX, FIELD.H, FIELD.W + NET, FIELD.H + BAND], // bottom
  ];
  for (const [x0, y0, x1, y1] of regions) {
    const rw = x1 - x0, rh = y1 - y0;
    const cols = Math.max(1, Math.floor(rw / (AUD.seatW + AUD.gapX)));
    const rows = Math.max(1, Math.floor(rh / (AUD.seatH + AUD.gapY)));
    const usedW = cols * AUD.seatW + (cols - 1) * AUD.gapX;
    const usedH = rows * AUD.seatH + (rows - 1) * AUD.gapY;
    const gap = 2;
    const ox = x1 <= 0 ? x1 - usedW - gap : x0 >= FIELD.W ? x0 + gap : x0 + (rw - usedW) / 2;
    const oy = y1 <= 0 ? y1 - usedH - gap : y0 >= FIELD.H ? y0 + gap : y0 + (rh - usedH) / 2;
    const seats = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      seats.push({ x: ox + c * (AUD.seatW + AUD.gapX), y: oy + r * (AUD.seatH + AUD.gapY), r: null, n: null, layer: (r * cols + c) % N_LAYERS });
    }
    spreadPool(seats, pool); // every section shows the user's cards spread among empty seats
  }
  preloadCards(pool);
}
// Perf: the audience is baked into two offscreen layers (even/odd seats), sized like
// the field cache. Each frame we blit those TWO images with opposite vertical bob — a
// lively crowd wave for ~2 drawImage/frame instead of ~80. Re-baked only when card art
// finishes loading (audNeedsRebake) or the canvas resizes.
let audLayers = null, audNeedsRebake = false;
function bakeAudience() {
  const W = bgCanvas.width, H = bgCanvas.height;
  audLayers = Array.from({ length: N_LAYERS }, () => document.createElement('canvas'));
  const gx = audLayers.map((c) => { c.width = W; c.height = H; const g = c.getContext('2d'); g.imageSmoothingEnabled = false; return g; });
  const sw = Math.ceil(ws_(AUD.seatW)), sh = Math.ceil(ws_(AUD.seatH));
  for (const s of audSeats) {
    if (!s.r) continue;
    const g = gx[s.layer % N_LAYERS];
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
  const t = performance.now() * 0.001;
  const ox = -(camX + NET * scale), oy = -(camY + BAND * scale);
  ctx.save();
  // Clip to OUTSIDE the pitch so the crowd is cut cleanly at the touchlines (fans
  // behind the boards) instead of spilling onto the grass.
  ctx.beginPath();
  ctx.rect(0, 0, wbW, wbH);
  ctx.rect(wx(0), wy(0), ws_(FIELD.W), ws_(FIELD.H));
  ctx.clip('evenodd');
  for (let L = 0; L < audLayers.length; L++) {
    const p = LAYERS[L];
    const dx = Math.sin(t * p.fx + p.phx) * ws_(p.ax);
    const dy = Math.sin(t * p.fy + p.phy) * ws_(p.ay);
    ctx.drawImage(audLayers[L], ox + dx, oy + dy);
  }
  ctx.restore();
}

// ---- Confetti: fans throwing colour into the air, ambient + goal bursts --------
const confetti = [];
let confPrevT = 0;
const CONFETTI_COLS = ['#ff5b4c', '#3d84ff', '#ffcb43', '#e9e0b8', '#7ee081', '#ff8fd0', '#ffffff', '#b46bff'];
function spawnConfetti(x, y, up) {
  if (confetti.length > 200) return;
  confetti.push({
    x, y,
    vx: (Math.random() * 2 - 1) * 150,
    vy: up ? -(220 + Math.random() * 260) : (40 + Math.random() * 90),
    rot: Math.random() * 6.28, vr: (Math.random() * 2 - 1) * 12,
    col: CONFETTI_COLS[(Math.random() * CONFETTI_COLS.length) | 0],
    life: 2 + Math.random() * 1.8, sz: 9 + Math.random() * 9,
  });
}
// A burst thrown up from the stands (all four sides) — used on a goal.
function confettiBurst(n) {
  for (let i = 0; i < n; i++) {
    const top = Math.random() < 0.5;
    const x = -NET + Math.random() * (FIELD.W + 2 * NET);
    const y = top ? -Math.random() * BAND : FIELD.H + Math.random() * BAND;
    spawnConfetti(x, y, true);
  }
}
function updateConfetti(dt) {
  if (me.team == null) return;
  // ambient: a light trickle thrown up from random stand spots (goals add big bursts)
  if (Math.random() < 0.3) {
    const top = Math.random() < 0.5;
    spawnConfetti(-NET + Math.random() * (FIELD.W + 2 * NET), top ? -Math.random() * BAND : FIELD.H + Math.random() * BAND, true);
  }
  for (let i = confetti.length - 1; i >= 0; i--) {
    const p = confetti[i];
    p.vy += 340 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt; p.life -= dt;
    if (p.life <= 0) confetti.splice(i, 1);
  }
}
function drawConfetti() {
  for (const p of confetti) {
    const s = ws_(p.sz);
    ctx.save();
    ctx.translate(wx(p.x), wy(p.y)); ctx.rotate(p.rot);
    ctx.globalAlpha = Math.min(1, p.life);
    ctx.fillStyle = p.col;
    ctx.fillRect(-s / 2, -s / 2, s, s * 0.55);
    ctx.restore();
  }
  ctx.globalAlpha = 1;
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
  if (training) drawPenZone();    // training: outline the dummy's confinement box
}

// Faint outline of the training dummy's pen (PEN is shared with the server).
function drawPenZone() {
  const sx = wx(PEN.x0), sy = wy(PEN.y0), sw = ws_(PEN.x1 - PEN.x0), sh = ws_(PEN.y1 - PEN.y0);
  ctx.save();
  ctx.globalAlpha = 0.10;
  ctx.fillStyle = TEAM.B.color;
  ctx.fillRect(Math.round(sx), Math.round(sy), Math.round(sw), Math.round(sh));
  ctx.globalAlpha = 0.5;
  ctx.strokeStyle = TEAM.B.color;
  ctx.lineWidth = Math.max(1, ws_(3));
  ctx.setLineDash([ws_(18), ws_(14)]);
  ctx.strokeRect(Math.round(sx), Math.round(sy), Math.round(sw), Math.round(sh));
  ctx.restore();
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

// The on-pitch athlete is now drawn by drawHero() in /heroes.js, which renders
// any hero+skin cosmetic. drawPlayer resolves the player's cosmetic and calls it.
function drawPlayer(p) {
  const ch = CHARACTERS[p.char] || CHARACTERS.player;
  const isMe = p.id === me.playerId;
  const x = wx(p.x), y = wy(p.y), r = ws_(ch.radius * settings.sizeMul);
  const team = teamColor(p.team);
  if (p.power) { // OVERCHARGE available: a pulsing RED ring (matches the red aim line = overcharge)
    const t = performance.now() / 1000;
    const pulse = 0.55 + 0.45 * Math.sin(t * 6);
    ctx.save(); ctx.strokeStyle = `rgba(255,64,64,${pulse.toFixed(2)})`; ctx.lineWidth = Math.max(1, ws_(3.5)); ctx.setLineDash([ws_(7), ws_(6)]);
    ctx.beginPath(); ctx.arc(x, y, r + ws_(7), t * 2, t * 2 + Math.PI * 2); ctx.stroke(); ctx.setLineDash([]); ctx.restore();
  }
  if (isMe) { // LOCAL charge meter: an arc that FILLS as you hold — amber -> GOLD at full power
    const c = currentCharge();
    if (c > 0.02) {
      const full = c >= FULL_CHARGE;
      ctx.save();
      ctx.strokeStyle = full ? 'rgba(255,214,64,0.95)' : 'rgba(255,166,54,0.9)';
      ctx.lineWidth = Math.max(2, ws_(4)); ctx.lineCap = 'round';
      ctx.beginPath(); ctx.arc(x, y, r + ws_(11), -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, c)); ctx.stroke();
      ctx.restore();
    }
  }
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
  // Look = this player's cosmetic (from the roster frame). Fall back to my own
  // pick for the local player before the roster arrives, else the default hero.
  const cos = cosmeticById[p.id] || (isMe ? myCosmetic : DEFAULT_COSMETIC);
  const anim = getAnim(p);
  drawHero(ctx, ox, feetY, sf, dir, walkPhase, moving, p.firing, cos, { J: team, JS: shade(team) }, performance.now() / 1000, anim);

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

// Cast the aim from (x0,y0) along (ax,ay) to the FIELD EDGE. Never stops on a player
// body — so an aiming player can't out a hidden (bushed) enemy.
function raycastAim(x0, y0, ax, ay) {
  // Aim line is a full-length DIRECTION indicator: it runs to the FIELD EDGE (feels
  // "infinite"), not stopping at the small cover walls (which read as a glitchy short
  // line). It never terminates on a player, so it can't out a hidden (bushed) enemy.
  let t = Infinity;
  if (ax > 1e-6) t = Math.min(t, (FIELD.W - x0) / ax); else if (ax < -1e-6) t = Math.min(t, (0 - x0) / ax);
  if (ay > 1e-6) t = Math.min(t, (FIELD.H - y0) / ay); else if (ay < -1e-6) t = Math.min(t, (0 - y0) / ay);
  if (!isFinite(t) || t < 0) t = 0;
  return { x: x0 + ax * t, y: y0 + ay * t };
}

// Infinite pale aim line to the first obstacle. Faded GREY normally; faded RED when
// OVERCHARGED. Charge no longer sets the length (always full) — it ramps the alpha.
function drawAimIndicator(wxp, wyp, ax, ay, charge = 0, overcharged = false) {
  const px = wx(wxp), py = wy(wyp);
  const hit = raycastAim(wxp, wyp, ax, ay);
  const ex = wx(hit.x), ey = wy(hit.y);
  const rgb = overcharged ? '255,64,64' : '176,176,176';
  const col = `rgba(${rgb},${(0.32 + 0.45 * charge).toFixed(3)})`;
  const mc = `rgba(${rgb},.95)`;
  const dx = ex - px, dy = ey - py, dist = Math.hypot(dx, dy) || 1;
  const ux = dx / dist, uy = dy / dist;
  const block = Math.max(2, ws_(6)), gap = block * 1.6, startOff = ws_(22);
  for (let d = startOff; d < dist - ws_(8); d += block + gap) {
    pxi(px + ux * d - block / 2, py + uy * d - block / 2, block, block, col);
  }
  const mark = Math.max(2, ws_(9)), tk = Math.max(1, Math.round(ws_(3)));
  pxi(ex - mark, ey - tk / 2, mark * 2, tk, mc); pxi(ex - tk / 2, ey - mark, tk, mark * 2, mc);
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
  // Match clock counts DOWN to 0:00, then the match ends. Training has no clock.
  const timerEl = document.getElementById('timer');
  if (training) {
    timerEl.classList.add('hidden');
  } else {
    timerEl.classList.remove('hidden');
    const remain = Math.max(0, Math.ceil(MATCH_DURATION - (latest.elapsed || 0)));
    const m = Math.floor(remain / 60), s = remain % 60;
    timerEl.textContent = `${m}:${String(s).padStart(2, '0')}`;
    timerEl.classList.toggle('urgent', remain <= 10 && latest.phase !== 'ended');
  }
  document.getElementById('net').textContent = `${ping}ms · ${snapRate}/s`;

  // Build-wall HUD: charges + reload on the build button; "hidden" cue when in a bush.
  const meP = latest.players && latest.players.find((pp) => pp.id === me.playerId);
  if (meP) updateBuildHud(meP);
  const hiddenCue = document.getElementById('stealth-cue');
  if (hiddenCue) hiddenCue.classList.toggle('on', !!(rendered && inBushAt(rendered.x, rendered.y) && latest.ball.owner !== me.playerId));
  const powerCue = document.getElementById('power-cue');
  if (powerCue) powerCue.classList.toggle('on', !!(meP && meP.power)); // charged -> full shot/kick available

  const banner = document.getElementById('banner');
  if (promoActive) { banner.classList.add('hidden'); banner.classList.remove('count'); }
  else if (latest.phase === 'ended') {
    const txt = myScore === opScore ? 'תיקו' : (myScore > opScore ? 'הכחולים ניצחו' : 'האדומים ניצחו');
    banner.textContent = txt;
    banner.style.color = myScore > opScore ? TEAM.A.color : (opScore > myScore ? TEAM.B.color : '#fff');
    banner.classList.remove('count'); banner.classList.remove('hidden');
    // Report the final result to the app exactly once (PII-free, one-way bridge).
    if (!matchResultSent) {
      matchResultSent = true;
      postMatchResult(myT, opT, myScore, opScore);
      stopMusic();                                                    // clear the pitch for the sting
      if (myScore !== opScore) playSound(myScore > opScore ? 'win' : 'loss', 0.9);
    }
  } else if (latest.resetTimer > 0 && latest.lastGoal) {
    // "GOAL!" during the freeze that shows the scoring positions, then 3-2-1.
    const showing = latest.resetTimer > GOAL_RESET - GOAL_FREEZE_HOLD;
    if (showing) { banner.textContent = 'גול!'; banner.style.color = teamColor(latest.lastGoal); banner.classList.remove('count'); }
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

// Built walls are CAPSULES with an `angle` (any orientation). Render as a rotated slab
// (len x thick) centred at (cx,cy). Runs inside the team-B mirror, so a world-space
// ctx.rotate(angle) auto-mirrors correctly — no manual negation. Helper falls back to the
// AABB box for anything without capsule params (defensive).
function wallSlab(w) {
  const hasCap = w.angle != null && w.cx != null;
  const cx = wx(hasCap ? w.cx : w.x + w.w / 2), cy = wy(hasCap ? w.cy : w.y + w.h / 2);
  const L = ws_(hasCap ? w.hl * 2 : Math.max(w.w, w.h)), T = ws_(hasCap ? w.ht * 2 : Math.min(w.w, w.h));
  return { cx, cy, L, T, angle: hasCap ? w.angle : (w.w >= w.h ? 0 : Math.PI / 2) };
}
// Fragile wall (built in a bush/penalty): glassy, translucent, always cracked.
function drawFragileWall(w) {
  const s = wallSlab(w);
  ctx.save();
  ctx.translate(s.cx, s.cy); ctx.rotate(s.angle);
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = '#8fb8c8'; ctx.fillRect(-s.L / 2, -s.T / 2, s.L, s.T);
  ctx.fillStyle = '#dbeef7'; ctx.fillRect(-s.L / 2, -s.T / 2, s.L, Math.max(2, ws_(4)));
  ctx.globalAlpha = 1;
  ctx.strokeStyle = 'rgba(18,38,52,.7)'; ctx.lineWidth = Math.max(1, ws_(2));
  for (let i = 0; i < 3; i++) { const a = i * 2.1 + w.id; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(a) * s.L * 0.4, Math.sin(a) * s.T * 0.4); ctx.stroke(); }
  ctx.setLineDash([Math.max(2, ws_(6)), Math.max(2, ws_(5))]);
  ctx.strokeStyle = 'rgba(219,238,247,.85)'; ctx.strokeRect(-s.L / 2, -s.T / 2, s.L, s.T); ctx.setLineDash([]);
  ctx.restore();
}
function drawBuiltWall(w) {
  if (w.fragile) return drawFragileWall(w);
  const f = (w.hp || 1) / (w.maxHp || 1);
  const g = Math.round(60 + 46 * f);
  const top = `rgb(190,${g + 26},72)`, face = `rgb(120,${Math.round(52 * f) + 26},36)`, hi = 'rgba(255,224,170,.35)';
  const s = wallSlab(w), lift = Math.max(2, ws_(5));
  ctx.save();
  ctx.translate(s.cx, s.cy); ctx.rotate(s.angle);
  ctx.fillStyle = 'rgba(0,0,0,.28)'; ctx.fillRect(-s.L / 2 + ws_(3), -s.T / 2 + ws_(4), s.L, s.T); // drop shadow
  ctx.fillStyle = face; ctx.fillRect(-s.L / 2, -s.T / 2, s.L, s.T);                                 // body
  ctx.fillStyle = top; ctx.fillRect(-s.L / 2, -s.T / 2, s.L, s.T - lift);                           // lit top
  ctx.fillStyle = hi; ctx.fillRect(-s.L / 2, -s.T / 2, s.L, Math.max(2, ws_(3)));                   // top highlight
  ctx.fillStyle = 'rgba(30,14,0,.35)';                                                              // plank lines
  for (let x = -s.L / 2 + ws_(26); x < s.L / 2; x += Math.max(4, ws_(26))) ctx.fillRect(Math.round(x), -s.T / 2, 1, s.T);
  if (f < 0.99) { ctx.strokeStyle = 'rgba(20,8,0,.7)'; ctx.lineWidth = Math.max(1, ws_(2)); const n = f < 0.34 ? 4 : 2; for (let i = 0; i < n; i++) { const a = i * 2.2 + w.id; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(a) * s.L * 0.35, Math.sin(a) * s.T * 0.5); ctx.stroke(); } }
  ctx.restore();
  // HP pips: screen-space above the centre (unrotated, easy to read).
  const pipY = s.cy - s.T / 2 - Math.max(2, ws_(9));
  const px0 = s.cx - ((w.maxHp || 1) * Math.max(3, ws_(11))) / 2;
  for (let i = 0; i < (w.maxHp || 1); i++) pxi(px0 + i * Math.max(3, ws_(11)), pipY, Math.max(2, ws_(8)), Math.max(2, ws_(5)), i < w.hp ? '#ffd27a' : 'rgba(0,0,0,.4)');
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

// Client-side stealth: can the local player SEE `p`? Teammates always; an enemy in
// a bush is hidden unless close, carrying the ball, or they FIRED from inside the
// bush (which reveals them for BUSH_FIRE_REVEAL).
const BUSH_FIRE_REVEAL = 1000; // ms an enemy stays visible after shooting from a bush
const firedReveal = {};
function canSeePlayer(p) {
  if (p.team === me.team) return true;
  const inBush = inBushAt(p.x, p.y);
  if (p.firing && inBush) firedReveal[p.id] = performance.now();
  if (!inBush) return true;
  // Carrying the ball does NOT reveal a bushed enemy — you must get close or catch them firing.
  if (performance.now() - (firedReveal[p.id] || -1e9) < BUSH_FIRE_REVEAL) return true;
  if (rendered && Math.hypot(rendered.x - p.x, rendered.y - p.y) < BUSH_REVEAL_DIST) return true;
  return false;
}

// Active obstacle layout: training swaps in its custom asymmetric field.
function fieldArena() { return training ? TRAIN_ARENA : ARENA; }
// Bush test against the active layout (pointInBush only knows the global one).
function inBushAt(x, y) {
  for (const g of fieldArena().bushes) if (x > g.x && x < g.x + g.w && y > g.y && y < g.y + g.h) return true;
  return false;
}

function drawObstacles() {
  const t = performance.now() / 1000;
  const A = fieldArena();
  for (const g of A.bushes) drawBush(g, t);
  for (const tr of A.trampolines) drawTramp(tr, t);
  for (const w of A.walls) drawWallBlock(w);
  if (latest && latest.walls) for (const w of latest.walls) drawBuiltWall(w);
  // Ghost preview while dragging the build button.
  if (buildDrag.active && rendered) {
    let dx = buildDrag.dx, dy = buildDrag.dy;
    if (flipView()) dx = -dx;
    const l = Math.hypot(dx, dy);
    let ax, ay;
    if (l > 12) { ax = dx / l; ay = dy / l; }
    else { const meV = latest && latest.players.find((q) => q.id === me.playerId); ax = meV ? meV.aimX : 1; ay = meV ? meV.aimY : 0; }
    // Ghost at the exact angle it'll build: perpendicular to aim, quantized like the sim.
    let ang = Math.atan2(ay, ax) + Math.PI / 2;
    ang = Math.round(ang / (Math.PI / 16)) * (Math.PI / 16);
    const cx = rendered.x + ax * BUILT_WALL.offset, cy = rendered.y + ay * BUILT_WALL.offset;
    const L = ws_(BUILT_WALL.len), T = ws_(BUILT_WALL.thick);
    ctx.save();
    const wind = currentWindup(); // 0..1 local estimate
    ctx.globalAlpha = 0.25 + 0.6 * wind; // faint at start, near-solid at full
    ctx.translate(wx(cx), wy(cy)); ctx.rotate(ang);
    ctx.fillStyle = wind >= 1 ? '#ffd27a' : '#ffb347';
    ctx.fillRect(-L / 2, -T / 2, L, T);
    // a thin progress bar under the ghost so the 0.5s read is unambiguous
    if (wind < 1) { ctx.globalAlpha = 0.9; ctx.fillStyle = '#fff'; ctx.fillRect(-L / 2, T / 2 + 3, L * wind, 3); }
    ctx.globalAlpha = 1; ctx.restore();
  }
  // Ghost marker while aiming a bomb lob.
  if (bombDrag.active && rendered) {
    const len = Math.hypot(bombDrag.dx, bombDrag.dy);
    if (len > AIM_DEADZONE_PX) {
      const frac = Math.min(1, len / MAX_LOB_DRAG_PX);
      let dx = bombDrag.dx / len, dy = bombDrag.dy / len;
      if (flipView()) dx = -dx;
      const tx = rendered.x + dx * frac * BOMB_LOB_RANGE;
      const ty = rendered.y + dy * frac * BOMB_LOB_RANGE;
      ctx.save(); ctx.globalAlpha = 0.5;
      ctx.fillStyle = '#ff5a4d';
      ctx.beginPath(); ctx.arc(wx(tx), wy(ty), ws_(26), 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1; ctx.restore();
    }
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
  drawAudience(); // card-art crowd (dynamic, jumping) on top of the cached terraces
  { const cn = performance.now(); const cdt = confPrevT ? Math.min(0.05, (cn - confPrevT) / 1000) : 0.016; confPrevT = cn; updateConfetti(cdt); drawConfetti(); }
  drawObstacles(); // walls / bushes / trampolines (static layout + built walls)

  const view = interpolated();
  if (view) {
    for (const bl of view.blasts) drawBlast(bl);
    for (const bomb of view.bombs) drawBomb(bomb);

    // Ball — if I'm carrying it, glue it to my predicted position (no lag).
    let ballDraw = view.ball;
    const bOwner = view.ball.owner;
    if (bOwner === me.playerId && rendered) {
      const meView = view.players.find((pp) => pp.id === me.playerId);
      const ax = meView ? meView.aimX : 1, ay = meView ? meView.aimY : 0;
      const al = Math.hypot(ax, ay) || 1;
      const off = ownRadius() + BALL_RADIUS * settings.ballSizeMul;
      ballDraw = { x: rendered.x + (ax / al) * off, y: rendered.y + (ay / al) * off };
    }
    // Don't draw the ball if a HIDDEN enemy is carrying it — the ball would betray their spot.
    const bCarrier = bOwner && bOwner !== me.playerId ? view.players.find((pp) => pp.id === bOwner) : null;
    const ballHidden = bCarrier && bCarrier.team !== me.team && !canSeePlayer(bCarrier);
    if (!ballHidden) drawBall(ballDraw);

    // Aim-to-shoot indicator for the local player: infinite line, grey normally,
    // RED when overcharged (the meter is up). Owner-only — never drawn for others.
    const aim = currentAim();
    if (aim.aiming && rendered) {
      const meNow = view.players.find((pp) => pp.id === me.playerId);
      drawAimIndicator(rendered.x, rendered.y, aim.ax, aim.ay, currentCharge(), !!(meNow && meNow.power));
    }
    for (const p of view.players) {
      const isMe = p.id === me.playerId && rendered;
      const dp = isMe ? { ...p, x: rendered.x, y: rendered.y, vx: predVel.x, vy: predVel.y } : p;
      if (!isMe && !canSeePlayer(p)) continue; // hidden enemy — fully concealed (no position tell)
      // You + teammates hidden in a bush render translucent, so you can tell you're concealed.
      if (dp.team === me.team && inBushAt(dp.x, dp.y)) {
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
      // AMBER -> GOLD as it charges. Red is reserved for OVERCHARGE (the aim line),
      // so the charge tint must not read as red.
      stickR.style.borderColor = `rgba(255,${Math.round(150 + 60 * chg)},60,.95)`;
      if (knob) knob.style.background = `rgba(255,${Math.round(165 + 45 * chg)},70,${0.4 + 0.5 * chg})`;
    }
  }
}
requestAnimationFrame(frame);
