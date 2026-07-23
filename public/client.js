// Web game client: renders the authoritative state with client-side prediction
// for your own player and interpolation for everyone else + the ball.

import {
  FIELD, GOAL, POST_R, PENALTY, BALL_RADIUS, CHARACTERS, TEAM, PROJECTILE, BOMB, MOVE_ACCEL,
  SHOOT_CHARGE_TIME, MAG_SIZE, GOAL_RESET, GOAL_FREEZE_HOLD, MATCH_DURATION,
  BUSH_REVEAL_DIST, SHOT_REVEAL_TIME, BUILD_MAG, BUILT_WALL, BUILD_WINDUP, FULL_CHARGE, QUICK_CHARGE, BOMB_LOB_RANGE, VISION_RANGE, clamp,
} from '/shared/constants.js';
import { ARENA, resolveWalls, pointInBush, segBlockedByWall, buildArenaFromField, capsuleAABB } from '/shared/arena.js';
import { PEN, TRAIN_ARENA } from '/shared/training.js';
import { DIFFICULTY_LEVELS, DEFAULT_LEVEL, clampLevel } from '/shared/difficulty.js';
import { decodeSnapshot } from '/shared/wire.js';
import { drawHero, ACTION_DUR, LOBBY_DANCES } from '/heroes.js';
import {
  HERO_KEYS, HERO_NAMES, SIGNATURE_NAMES, SKIN_KEYS, SKIN_NAMES, SKIN_RARITY,
  DEFAULT_COSMETIC, normalizeCosmetic,
} from '/shared/cosmetics.js';
let slotIds = [], slotTeam = [], rosterVersion = -1; // binary-snapshot slot->id/team (from the 'roster' control msg)

// TEMP diagnostic: a visible build tag so we can tell for certain whether the device is running
// the freshly-deployed game. If you don't see this green tag bottom-left, you're on stale code.
const BUILD_TAG = 'BUILD ✅ 23JUL-v4';
try {
  const _mk = () => { const d = document.createElement('div'); d.textContent = BUILD_TAG; d.style.cssText = 'position:fixed;left:4px;bottom:4px;z-index:999999;font:bold 12px monospace;color:#0f0;background:rgba(0,0,0,.6);padding:2px 6px;border-radius:3px;pointer-events:none'; document.body.appendChild(d); };
  if (document.body) _mk(); else addEventListener('DOMContentLoaded', _mk);
} catch { /* non-browser */ }

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
// Re-skin the current hero by a card's rarity (keeps hero TYPE, swaps the tier). Mirrors
// the picker's save path; the home preview (drawDancer) reads myCosmetic live so it updates.
function setHeroSkinByRarity(rarity) {
  const skin = RARITY_SKIN[rarity]; if (!skin) return;
  const hero = (myCosmetic.split(':')[0]) || 'striker';
  myCosmetic = normalizeCosmetic(`${hero}:${skin}`);
  saveCosmetic(myCosmetic);
  sendMsg({ type: 'setCosmetic', cosmetic: myCosmetic });
  toast('מראה הגיבור עודכן לפי נדירות הקלף');
}
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
// Object spawn timestamps (ms) so drawBuiltWall/drawBomb can play a short intro anim
// (walls pop-in, bombs squash-land) from the moment the object first appears in a snapshot.
const wallSpawnT = new Map();         // wall id -> performance.now() when first seen
const bombSpawnT = new Map();         // bomb id -> performance.now() when first seen
const bombSrc = new Map();            // bomb id -> {x,y} it FLIES IN from (the thrower) for the lob-arc intro
const bombLanded = new Set();         // bomb ids whose impact shockwave has already fired
const WALL_BUILD_MS = 260;            // wall pop-in duration
const BOMB_LAND_MS = 200;             // bomb squash-land duration

// ---- Lightweight world-space particle FX (dust puffs + wood shards) --------
// Stored in WORLD coords so they track the camera + team-B mirror; drawn via wx/wy/ws_.
const fx = [];                        // { x,y,vx,vy,g,life,max,size,rot,vr,kind,col }
let fxPrevT = 0;
function spawnDust(x, y, n, opts = {}) {
  const spd = opts.spd || 90, up = opts.up || 60, col = opts.col || '210,196,166';
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    fx.push({ x, y, vx: Math.cos(a) * spd * (0.4 + Math.random() * 0.8), vy: -Math.random() * up - 10,
      g: 180, life: 0, max: 0.35 + Math.random() * 0.35, size: (opts.size || 5) * (0.6 + Math.random() * 0.8),
      rot: 0, vr: 0, kind: 'dust', col });
  }
}
function spawnShards(x, y, n, cols, fast) {
  const base = fast ? 220 : 120, life = fast ? 0.42 : 0.55;   // "fast" = snappier burst, shorter fade
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.6, sp = base + Math.random() * 240;
    fx.push({ x: x + (Math.random() - 0.5) * 44, y: y + (Math.random() - 0.5) * 26,
      vx: Math.cos(a) * sp + (Math.random() - 0.5) * 130, vy: Math.sin(a) * sp - 70,
      g: 700, life: 0, max: life + Math.random() * 0.4, size: 5 + Math.random() * 7,
      rot: Math.random() * 7, vr: (Math.random() - 0.5) * 20, kind: 'shard',
      col: cols[(Math.random() * cols.length) | 0] });
  }
}
// A brief white burst flash (wall break) — no motion, fast fade.
function spawnFlash(x, y, size) { fx.push({ x, y, vx: 0, vy: 0, g: 0, life: 0, max: 0.13, size, rot: 0, vr: 0, kind: 'flash' }); }
// A ground shock ring (bomb land) — expands from r0 to r1 as it fades.
function spawnRing(x, y, r0, r1) { fx.push({ x, y, vx: 0, vy: 0, g: 0, life: 0, max: 0.32, size: 0, r0, r1, kind: 'ring' }); }
function updateFx(dt) {
  for (const p of fx) { p.life += dt; p.vy += p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt; }
  for (let i = fx.length - 1; i >= 0; i--) if (fx[i].life >= fx[i].max) fx.splice(i, 1);
}
function drawFx() {
  for (const p of fx) {
    const k = 1 - p.life / p.max;
    if (p.kind === 'dust') {
      ctx.fillStyle = `rgba(${p.col},${(0.5 * k).toFixed(3)})`;
      ctx.beginPath(); ctx.arc(wx(p.x), wy(p.y), Math.max(1, ws_(p.size * (0.6 + 0.6 * k))), 0, 7); ctx.fill();
    } else if (p.kind === 'flash') {
      ctx.fillStyle = `rgba(255,240,200,${(k * 0.6).toFixed(3)})`;
      ctx.beginPath(); ctx.arc(wx(p.x), wy(p.y), ws_(p.size * (1.2 - 0.4 * k)), 0, 7); ctx.fill();
    } else if (p.kind === 'ring') {
      const rr = p.r0 + (p.r1 - p.r0) * (1 - k);
      ctx.save(); ctx.globalAlpha = k * 0.75; ctx.strokeStyle = '#fff2cf'; ctx.lineWidth = Math.max(1, ws_(3 * k));
      ctx.beginPath(); ctx.arc(wx(p.x), wy(p.y), ws_(rr), 0, 7); ctx.stroke(); ctx.restore(); ctx.globalAlpha = 1;
    } else {
      ctx.save(); ctx.translate(wx(p.x), wy(p.y)); ctx.rotate(p.rot); ctx.globalAlpha = clamp(k * 1.5, 0, 1);
      ctx.fillStyle = p.col; const s = ws_(p.size); ctx.fillRect(-s / 2, -s / 2, s, s * 0.72);
      ctx.restore(); ctx.globalAlpha = 1;
    }
  }
}
function shake(strength, ms) { screenShakeStrength = Math.max(screenShakeStrength, strength); screenShakeUntil = Math.max(screenShakeUntil, performance.now() + (ms || 200)); }
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
// Which animation a player is in right now: goal freeze > interrupt (hit/fly) > wall windup
// (the winding channel pose) > active timed action > run/idle by velocity.
function getAnim(p) {
  if (latest && latest.lastGoal) return { action: p.team === latest.lastGoal ? 'celebrate' : 'concede' };
  const s = animState[p.id], now = performance.now();
  const timed = (s && (now - s.t0) < s.dur * 1000) ? Object.assign({ u: (now - s.t0) / (s.dur * 1000) }, s) : null;
  // A knockback/flinch (which also INTERRUPTS the build server-side) overrides the channel pose.
  if (timed && (timed.action === 'hit' || timed.action === 'fly')) return timed;
  // Winding up a wall: server sends `winding` per player; the local player uses its own hold
  // for zero-latency feedback. Show the braced channel pose until the wall commits.
  const winding = p.winding || (p.id === me.playerId && buildHolding);
  if (winding) return { action: 'buildwind', aimSign: (p.aimX || 0) >= 0 ? 1 : -1 };
  if (timed) return timed;
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
// Music plays through the SAME proven path as SFX — a decoded AudioBuffer -> GainNode ->
// destination. iOS ignores <audio>.volume AND its MediaElementSource capture is unreliable
// (the volume knob did nothing and playback stuttered on/off), so we don't use an <audio>
// element at all. A BufferSource's gain attenuates reliably on iOS, exactly like SFX do.
function applyMusicVol() {
  const v = clamp(musicEnabled ? musicVol * musicUserVol : 0, 0, 1);
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  if (musicGain) musicGain.gain.value = v;
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
  ensureMusicGain(); // music (BufferSource) plays through this gain, unlocked by the same gesture
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
let musicKind = null;    // 'match' | 'training' | 'lobby' | 'home' | null — dedupes repeat starts
let musicVol = 0;        // base volume of the current track (before the music slider)
let musicGain = null;    // volume knob: BufferSource -> musicGain -> destination
let musicSource = null;  // the currently-playing AudioBufferSourceNode
let musicBuf = null;     // decoded buffer of the current track (one at a time → bounded memory)
let musicBufSrc = '';    // which url musicBuf holds (skip re-decode when replaying the same track)
let musicToken = 0;      // bumped on every start/stop to cancel an in-flight decode

function ensureMusicGain() {
  if (!musicGain && audioCtx) { musicGain = audioCtx.createGain(); musicGain.connect(audioCtx.destination); applyMusicVol(); }
}
function stopMusicSource() {
  if (musicSource) { try { musicSource.stop(); } catch { /* not started */ } try { musicSource.disconnect(); } catch { /* fine */ } musicSource = null; }
}
function stopMusic() {
  musicToken++;          // cancel any in-flight decode/start
  stopMusicSource();
  musicKind = null;
}
// Decode the track (kept as the single current buffer) and play it looped through the gain.
// Fire-and-forget; a newer start supersedes an in-flight one via musicToken. Buffer playback
// is the same path SFX use — reliable volume + no stutter on iOS, unlike an <audio> element.
async function playMusic(src, loop, volume) {
  if (!audioCtx) return; // not unlocked yet — the caller retries after the first gesture
  ensureMusicGain();
  musicVol = volume; applyMusicVol();
  const token = ++musicToken;
  stopMusicSource();
  try {
    if (musicBufSrc !== src || !musicBuf) {
      const resp = await fetch(src);
      if (!resp.ok) return;
      const buf = await audioCtx.decodeAudioData(await resp.arrayBuffer());
      if (token !== musicToken) return;   // superseded while decoding
      musicBuf = buf; musicBufSrc = src;
    }
    if (token !== musicToken) return;
    const s = audioCtx.createBufferSource();
    s.buffer = musicBuf; s.loop = !!loop;
    s.connect(musicGain);
    s.start();
    musicSource = s;
  } catch { /* fetch/decode failed → silent */ }
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
// #12: the lobby/waiting theme starts the instant you enter a lobby (not only at the
// countdown) and LOOPS for the whole wait, so entering feels instant. Idempotent — the
// repeating lobby/countdown payloads call it every tick; it actually starts exactly once.
function startLobbyMusic() {
  if (musicKind === 'lobby') return;
  musicKind = 'lobby';
  playMusic(LOBBY_MUSIC, true, 0.5);
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
    // XP SCALING by how HUMAN the match is. Humans = snapshot players whose id is in matchRoster.
    // Factor ramps from 0.2 (I'm the only human — a full lobby of bots) to 1.0 (every other slot
    // is a human): xpFactor = 0.2 + 0.8 * (otherHumans / otherSlots). The backend multiplies its
    // base match XP by this, so an all-human match earns XP ~5x faster than a bot-filled one.
    const totalPlayers = players.length || 4;
    const humanCount = players.filter((p) => rosterIds.has(p.id)).length; // includes me
    const otherSlots = Math.max(1, totalPlayers - 1);
    const humanFrac = Math.max(0, Math.min(1, (humanCount - 1) / otherSlots));
    const xpFactor = Math.round((0.2 + 0.8 * humanFrac) * 100) / 100; // 0.20 .. 1.00
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
      humanCount,                   // total humans in the match (incl. me)
      totalPlayers,                 // filled slots (humans + bots)
      xpFactor,                     // XP multiplier: 0.2 (all bots) .. 1.0 (all humans)
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
      crowdHypeT = performance.now();          // crowd leaps up, then settles over ~2.5s
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
    for (const info of brokenAt) {                          // V3 "Burst": white flash + fast shards + quick fade
      if (info.fragile) { spawnFlash(info.cx, info.cy, 22); spawnDust(info.cx, info.cy, 8, { col: '150,180,120', spd: 90, up: 50, size: 4 }); continue; }
      spawnFlash(info.cx, info.cy, brokeStrong ? 40 : 30);
      spawnShards(info.cx, info.cy, brokeStrong ? 20 : 14, ['#7a4a24', '#9c6a30', '#c8963e'], true);
      spawnDust(info.cx, info.cy, brokeStrong ? 12 : 8, { col: '120,86,52', spd: 130, up: 80 });
    }
    if (brokeAny) shake(clamp((brokeStrong ? 11 : 6) * breakProx, 2, 11), 200);

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
      bombSpawnT.set(b.id, performance.now());                                // fly-in intro; ring/dust fire on impact (see drawBomb)
      bombSrc.set(b.id, pl ? { x: pl.x, y: pl.y } : { x: b.x, y: b.y });      // arc FROM the thrower to where it lands
    }
    for (const w of snap.walls || []) if (!knownWalls.has(w.id)) {            // built a wall
      const pl = nearestPlayer(players, w.x, w.y, 130, w.team); if (pl) triggerAnim(pl.id, 'wall', { aimSign: (w.x - pl.x) >= 0 ? 1 : -1 });
      wallSpawnT.set(w.id, performance.now());                                // pop-in intro (see drawBuiltWall)
      spawnDust(w.x, w.y, 10, { col: '150,120,80', spd: 90, up: 55 });        // dust as the planks assemble in
      shake(clamp(4 * proximity(w.x, w.y), 1, 4), 160);
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
  for (const id of wallSpawnT.keys()) if (!knownWalls.has(id)) wallSpawnT.delete(id); // prune intro timers for gone objects
  for (const id of bombSpawnT.keys()) if (!knownBombs.has(id)) { bombSpawnT.delete(id); bombLanded.delete(id); bombSrc.delete(id); }
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
  if (name === 'home') {
    if (!quickVs) startHomeMusic();
    // Always land the play strip on the primary 2v2 button (flush at the RTL start = right edge),
    // so it's the most-visible mode; swiping reveals play-friends/training/coming-soon.
    // WebKit (iOS WebView, the real target) RTL: the start edge is scrollLeft 0.
    const strip = document.getElementById('play-strip');
    if (strip) strip.scrollLeft = 0;
  }
  else if (name !== 'game' && name !== 'lobby') stopMusic();
  for (const k in screens) screens[k].classList.toggle('hidden', k !== name);
}

// Home + friends refs.
const homeOnlineEl = document.getElementById('home-online');
const homeFaceEl = document.getElementById('home-face');
const homeNameEl = document.getElementById('home-name');
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
// Dropping a card on the hero re-skins it by the card's rarity (SKIN_RARITY tiers):
// common→base, rare→gold, epic→holo, legendary→sig. Hero TYPE is kept; only the tier changes.
const RARITY_SKIN = { common: 'base', rare: 'gold', epic: 'holo', legendary: 'sig' };
// Local-dev only: without the app there's no injected album, so the hub/carousel
// look empty. On localhost we preview a small sample; on any real host (device or
// Render) we NEVER fake it — return the injected cards or nothing.
const DEV_LOCAL = ['localhost', '127.0.0.1', '0.0.0.0'].includes(location.hostname);
// Worth-order intentionally DIFFERS from rarity-order here so "select best" is visibly
// distinct on localhost: the highest-worth card is a common, and the rarest (legendary)
// cards have modest worth — so rarity-then-copies picks the two legendaries, not the common.
const DEV_SAMPLE_CARDS = [
  { r: 'common', n: 3, c: 9, w: 900000 }, { r: 'rare', n: 22, c: 1, w: 800000 },
  { r: 'epic', n: 7, c: 3, w: 210000 }, { r: 'legendary', n: 12, c: 1, w: 120000 },
  { r: 'legendary', n: 5, c: 2, w: 90000 }, { r: 'legendary', n: 20, c: 1, w: 300000 },
  { r: 'common', n: 8, c: 5, w: 50000 }, { r: 'rare', n: 31, c: 3, w: 70000 },
];
// Rarity from the app can arrive with inconsistent casing (e.g. "Legendary"). Every rarity
// map here (RARITY_RANK/PCT/GLOW, HEB_RAR), the CSS rarity-<r> classes and the art URLs use
// LOWERCASE keys — so an un-lowercased rarity ranks as 0 and gets dropped from "select best"
// (the "2 legend + 1 epic instead of 3 legend" bug). Normalize casing at the single source.
function myCards() {
  const raw = Array.isArray(window.SALTIZ_CARDS) ? window.SALTIZ_CARDS.slice(0, 256)
    : (DEV_LOCAL ? DEV_SAMPLE_CARDS : []);
  return raw.map((c) => (c && typeof c.r === 'string' && c.r !== c.r.toLowerCase())
    ? { ...c, r: c.r.toLowerCase() } : c);
}
// Best-first: worth, then rarity, then copies. Drives the carousel + the top-3 intro.
function rankCards(cards) {
  return [...(cards || [])].sort((a, b) =>
    (b.w || 0) - (a.w || 0) ||
    (RARITY_RANK[b.r] || 0) - (RARITY_RANK[a.r] || 0) ||
    (b.c || 0) - (a.c || 0));
}
// "Best" loadout ranking: RARITY first, then DUPLICATION (copies), then worth as a
// tiebreak. Distinct from rankCards (worth-first) which drives the carousel — the
// #select-best-btn uses this so the equipped powers are the rarest/most-owned cards.
function rankForLoadout(cards) {
  return [...(cards || [])].sort((a, b) =>
    (RARITY_RANK[b.r] || 0) - (RARITY_RANK[a.r] || 0) ||
    (b.c || 0) - (a.c || 0) ||
    (b.w || 0) - (a.w || 0));
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
function showRoomError(msg) { toast(msg); } // room controls left the friends screen — errors now toast
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
  renderHubTier();
  _cardsSig = cardsSig();
}

// Album-derived stats + collector rank on the home hub — all from myCards(), so it
// works the moment the app injects window.SALTIZ_CARDS. The 3rd chip upgrades from
// "copies" to real total views automatically if the app ever injects window.SALTIZ_PROFILE.views.
let _cardsSig = '';
// Collector tiers — icon-forward pixel badge (icon + one short word; «אספן» prefix dropped
// so the emblem stays minimal). Icon read as the art, word as the tier.
const HUB_RANKS = [
  { min: 5000000, ic: '🏆', word: 'אגדי' },
  { min: 1000000, ic: '💎', word: 'אדיר' },
  { min: 250000,  ic: '⭐', word: 'נדיר' },
  { min: 50000,   ic: '🃏', word: 'נפוץ' },
  { min: 0,       ic: '🌱', word: 'מתחיל' },
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
      const r = HUB_RANKS.find((x) => worth >= x.min) || HUB_RANKS[HUB_RANKS.length - 1];
      rankEl.innerHTML = '<span class="px-ic">' + r.ic + '</span><span class="px-word">' + r.word + '</span>';
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

// --- Competitive rank ladder: 7 tiers × 4 sub-ranks (28 divisions), driven by the
// football level. 1 level = 1 sub-rank → ברונזה 1..4 = levels 1..4, כסף 1 = level 5, …,
// אלוף 4 = level 28+. Progress bar = XP progress into the current level (= toward the next
// sub-rank). Same source of truth as the XP bar (window.SALTIZ_XP / levelFromXp), mirroring
// the worth-derived #hub-rank collector badge but for rank. ---
const RANK_TIERS = [
  { key: 'bronze',  label: 'ברונזה', ic: '🥉', c1: '#f2b578', c2: '#a6702f' },
  { key: 'silver',  label: 'כסף',    ic: '🥈', c1: '#e9eff4', c2: '#98a6b2' },
  { key: 'gold',    label: 'זהב',    ic: '🥇', c1: '#ffe27a', c2: '#e0a92a' },
  { key: 'diamond', label: 'יהלום',  ic: '💎', c1: '#96e6f7', c2: '#3f9fc0' },
  { key: 'mythic',  label: 'מיתי',   ic: '🔮', c1: '#d7abff', c2: '#8a4fd0' },
  { key: 'legend',  label: 'אגדי',   ic: '👑', c1: '#ffa8ba', c2: '#e0435f' },
  { key: 'master',  label: 'אלוף',   ic: '🏆', c1: '#ffe9a0', c2: '#d99a1e' },
];
const RANK_SUBS = 4;
function rankTierFromLevel(level) {
  const total = RANK_TIERS.length * RANK_SUBS;                  // 28 divisions
  const idx = Math.max(0, Math.min(total - 1, (level | 0) - 1));
  return { tier: RANK_TIERS[Math.floor(idx / RANK_SUBS)], sub: (idx % RANK_SUBS) + 1,
    maxed: ((level | 0) - 1) >= total - 1 };
}
function currentXpState() {
  const src = window.SALTIZ_XP;
  const xp = src && Number.isFinite(+src.xp) ? +src.xp : (DEV_LOCAL ? 1240 : 0);
  const level = src && +src.level ? +src.level : levelFromXp(xp);
  const base = 50 * level * (level - 1), span = 100 * level;
  const pct = span ? Math.max(0, Math.min(1, (xp - base) / span)) : 0;
  return { xp, level, pct };
}
// Fills the #hub-tier pixel badge over the hero: big tier icon + sub-rank number only
// (minimal text — tier is read from the icon + colour), progress bar toward the next sub-rank.
function renderHubTier() {
  const box = document.getElementById('hub-tier');
  const lbl = document.getElementById('hub-tier-lbl');
  const fill = document.getElementById('hub-tier-fill');
  if (!box || !lbl) return;
  const { level, pct } = currentXpState();
  const { tier, sub, maxed } = rankTierFromLevel(level);
  lbl.innerHTML = '<span class="px-ic">' + tier.ic + '</span><span class="px-sub">' + sub + '</span>';
  box.style.setProperty('--c1', tier.c1);
  box.style.setProperty('--c2', tier.c2);
  if (fill) fill.style.width = (maxed ? 100 : pct * 100).toFixed(1) + '%';
}

// Coverflow carousel of the player's cards on the home screen: best card centered,
// up to 5 visible with the sides shrinking + fading outward. Purely visual
// (auto-advance + swipe). Hidden when the player has no cards.
const carouselEl = document.getElementById('home-carousel');
let cfCards = [], cfIndex = 0, cfTimer = null;
// DENSE carousel: one BIG front card, the rest progressively smaller and MOSTLY HIDDEN
// behind it (just peeking) — a tight stack, not a spread. CF_MAX=5 => up to 11 cards shown
// (front + 5 each side). CF_SPACING is the swipe sensitivity (px of drag per card).
const CF_SPACING = 70, CF_STEP = 0.2, CF_MAX = 5;
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
  // Dense stack: the front card (a=0) is full size; each card further from front is a small
  // step SMALLER and only slightly offset, so it tucks MOSTLY BEHIND the front and just peeks.
  // STEP_X is intentionally small (tight stack, not spread); STEP_S shrinks them progressively.
  const STEP_X = 14, STEP_S = 0.12;
  const kids = carouselEl.children, n = kids.length;
  for (let i = 0; i < n; i++) {
    let off = i - cfIndex;
    if (off > n / 2) off -= n; else if (off < -n / 2) off += n; // wrap => symmetric stack
    const a = Math.abs(off), el = kids[i];
    if (a > CF_MAX + 0.5) { // beyond the 11-card window: fully hidden
      el.style.opacity = '0'; el.style.pointerEvents = 'none';
      el.style.transform = `translateX(${off * STEP_X}px) scale(${Math.max(0.2, 1 - a * STEP_S)})`;
      continue;
    }
    const k = Math.min(a, CF_MAX);
    const scale = Math.max(0.34, 1 - k * STEP_S);   // front biggest; deeper cards smaller
    el.style.opacity = String(Math.max(0.32, 1 - k * 0.12));
    el.style.pointerEvents = 'auto';
    el.style.zIndex = String(60 - Math.round(a * 5)); // front on top, deeper cards behind
    el.style.transform = `translateX(${off * STEP_X}px) scale(${scale})`;
    el.classList.toggle('cf-center', a < 0.5);
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
  const heroBtn = document.getElementById('pick-hero-btn');
  const clearGhost = () => {
    if (ghost) { ghost.remove(); ghost = null; }
    document.querySelectorAll('.pslot.pslot-over').forEach((s) => s.classList.remove('pslot-over'));
    if (heroBtn) heroBtn.classList.remove('hub-hero-over');
  };
  const slotUnder = (x, y) => { const el = document.elementFromPoint(x, y); return el && el.closest ? el.closest('.pslot') : null; };
  const heroUnder = (x, y) => { const el = document.elementFromPoint(x, y); return !!(el && el.closest && el.closest('#pick-hero-btn')); };
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
      if (heroBtn) heroBtn.classList.toggle('hub-hero-over', !slot && heroUnder(e.clientX, e.clientY));
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
      else if (heroUnder(e.clientX, e.clientY)) setHeroSkinByRarity(dragCard.r);        // drop on the hero -> re-skin by rarity
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
  const top = rankForLoadout(myCards()).slice(0, 3); // default powers = best by rarity, then copies
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
// Exchange the cards in two slots (lobby drag slot->slot). Moving existing entries never
// creates a duplicate, so no extra de-dupe is needed; an empty source/target just moves.
function swapSlots(a, b) {
  if (a === b) return;
  const eff = effectiveLoadout();
  const t = eff[a]; eff[a] = eff[b]; eff[b] = t;
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
    el.dataset.slot = i;                 // kept: carousel drag-to-equip drops onto this
    // Slots now show ONLY the card art (or the slot's power glyph when empty) — no buff %.
    if (card) el.appendChild(slotCardEl(card, 'pslot-art', 52, 68));
    else { const ic = document.createElement('span'); ic.className = 'pslot-emptyic'; ic.textContent = meta.icon; el.appendChild(ic); }
    // Tap / drag are handled by the delegated bindSlotDrag() below (tap opens the room,
    // drag swaps between slots or removes when dropped outside). dataset.slot is the target.
    const cap = document.createElement('span'); cap.className = 'pslot-cap'; cap.textContent = meta.label; // label text: what each slot is
    item.appendChild(el); item.appendChild(cap);
    powerSlotsEl.appendChild(item);
  });
  // Re-apply the baked/edited layout so equipping a card (which rebuilds these items) doesn't
  // reset the slot positions. No-op in the shipped app (editor absent) — baked CSS nth-child holds.
  if (window.__lobbyApplyLayout) window.__lobbyApplyLayout();
}

// ---- Cards page: equipped slots + album deck (opened by tapping a home slot) ----------
// Tap a slot to select it, then tap a deck card to equip it there (reuses setSlotCard, so
// it persists + tells the server, exactly like the home carousel drag-to-equip).
let cardsSelSlot = 0;
const FAN_CARD_W = 66;  // card width in the album fan
const FAN_PEEK = 26;    // visible sliver per overlapped card (so ~50 fit as a scrollable spread)
function renderCardsPage() {
  const slotsEl = document.getElementById('cards-slots');
  const deckEl = document.getElementById('cards-deck');
  if (!slotsEl || !deckEl) return;
  const eff = effectiveLoadout();
  slotsEl.innerHTML = '';
  eff.forEach((card, i) => {
    const meta = SLOT_META[i];
    const item = document.createElement('div'); item.className = 'pslot-item';
    const el = document.createElement('div');
    el.className = 'pslot' + (card ? ' rarity-' + card.r : ' pslot-empty') + (i === cardsSelSlot ? ' pslot-sel' : '');
    el.dataset.slot = i;
    if (card) el.appendChild(slotCardEl(card, 'pslot-art', 62, 80));
    else { const ic = document.createElement('span'); ic.className = 'pslot-emptyic'; ic.textContent = meta.icon; el.appendChild(ic); }
    // Tap = power info; drag a filled slot = swap onto another slot, or drop off every slot to
    // unequip (card returns to its rarity tier). Handled by the delegated bindCardsSlotDrag() below.
    const cap = document.createElement('span'); cap.className = 'pslot-cap'; cap.textContent = meta.label;
    item.appendChild(el); item.appendChild(cap);
    slotsEl.appendChild(item);
  });
  deckEl.innerHTML = '';
  deckEl.classList.add('cards-deck-fan');
  const all = myCards();
  if (!all.length) { deckEl.innerHTML = '<div class="subpage-note"><b>אין קלפים עדיין</b><span>הקלפים שלך יופיעו כאן</span></div>'; return; }
  // Album as an overlapping "cards spread on a table" per tier: highest tier first, best worth
  // first within a tier. Each tier is a horizontally-scrollable fan where every card shows only
  // a peeking edge (handles ~50/tier). Tap a card to reveal it; drag a card onto a slot to equip
  // (gestures handled by bindFanDrag() below). FAN_PEEK = visible sliver width per card.
  const TIER_ORDER = ['legendary', 'epic', 'rare', 'common'];
  const byWorth = (a, b) => (b.w || 0) - (a.w || 0);
  const isEquipped = (c) => eff.some((s) => s && s.r === c.r && +s.n === +c.n);
  TIER_ORDER.forEach((rar) => {
    // Equipped cards leave the album (they now live in a slot); removing one puts it back.
    const group = all.filter((c) => c.r === rar && !isEquipped(c)).sort(byWorth);
    if (!group.length) return;
    // Each tier is its OWN enclosed box (rarity-colored border) so cards can never read as
    // belonging to a neighbouring tier's header.
    const sec = document.createElement('div'); sec.className = 'cards-tier rarity-' + rar;
    const head = document.createElement('div');
    head.className = 'cards-tier-head rarity-' + rar;
    head.innerHTML = '<span class="cards-tier-name">' + (HEB_RAR[rar] || rar) + '</span><span class="cards-tier-count">' + group.length + '</span>';
    sec.appendChild(head);
    const fan = document.createElement('div'); fan.className = 'cards-fan';
    const track = document.createElement('div'); track.className = 'fan-track';
    track.style.width = ((group.length - 1) * FAN_PEEK + FAN_CARD_W) + 'px';
    group.forEach((c, idx) => {
      const el = document.createElement('div');
      el.className = 'fan-card rarity-' + c.r;
      el.style.left = (idx * FAN_PEEK) + 'px';
      el.style.zIndex = idx + 1;
      el.dataset.r = c.r; el.dataset.n = c.n;
      el.appendChild(slotCardEl(c, 'fan-card-art', FAN_CARD_W, 88));
      if (c.c > 1) { const b = document.createElement('span'); b.className = 'cf-badge'; b.textContent = '×' + c.c; el.appendChild(b); }
      const tag = document.createElement('span'); tag.className = 'fan-card-tag'; tag.textContent = '#' + c.n; el.appendChild(tag);
      track.appendChild(el);
    });
    fan.appendChild(track);
    sec.appendChild(fan);
    deckEl.appendChild(sec);
  });
}
// ---- Album fan gestures (delegated on #cards-deck) -------------------------------------
// The deck is a set of overlapping "spread on a table" fans (one per tier). On a fan card:
//   TAP           -> reveal it (enlarged; only one revealed at a time).
//   SWIPE SIDEWAYS-> browse the fan; the card under the finger POPS UP (.peek) so you can see
//                    which one you're on (at rest each card shows only a ~26px sliver). Scroll
//                    is driven in JS (the fan is touch-action:none) so the peek tracks the finger.
//   PULL UP       -> lift the card into a ghost; drop it on a slot (#cards-slots) to equip.
//                    You can pull up mid-browse — it grabs whichever card is under the finger.
// A revealed card can be dragged in any direction to equip. Dropping off a slot is a no-op.
(function bindFanDrag() {
  const deck = document.getElementById('cards-deck');
  if (!deck) return;
  let sx = null, sy = null, mode = null, card = null, cardEl = null, ghost = null, scroller = null, startScroll = 0, pid = null, peekEl = null;
  const TH = 8;
  const slotUnder = (x, y) => { const el = document.elementFromPoint(x, y); return el && el.closest ? el.closest('.pslot') : null; };
  // Topmost RESTING fan-card under the point. We drop the current peek first so its scaled-up
  // box can't shadow the neighbour the finger has actually moved onto.
  const cardUnder = (x, y) => {
    const prev = peekEl; if (prev) prev.classList.remove('peek');
    const el = document.elementFromPoint(x, y);
    const fc = el && el.closest ? el.closest('.fan-card') : null;
    if (prev && prev !== fc) { /* stays un-peeked */ } else if (prev) prev.classList.add('peek');
    return fc;
  };
  const setPeek = (fc) => { if (fc === peekEl) return; if (peekEl) peekEl.classList.remove('peek'); peekEl = fc || null; if (peekEl) peekEl.classList.add('peek'); };
  const clearPeek = () => { if (peekEl) { peekEl.classList.remove('peek'); peekEl = null; } };
  const grab = (fc) => { cardEl = fc; card = { r: fc.dataset.r, n: +fc.dataset.n }; };
  const clear = () => {
    if (ghost) { ghost.remove(); ghost = null; }
    clearPeek();
    document.querySelectorAll('.pslot.pslot-over').forEach((s) => s.classList.remove('pslot-over'));
  };
  const reset = () => { clear(); sx = sy = null; mode = null; card = null; cardEl = null; scroller = null; pid = null; };
  deck.addEventListener('pointerdown', (e) => {
    const fc = e.target && e.target.closest ? e.target.closest('.fan-card') : null;
    if (!fc) { sx = null; return; }
    grab(fc);
    scroller = fc.closest('.cards-fan'); startScroll = scroller ? scroller.scrollLeft : 0;
    sx = e.clientX; sy = e.clientY; mode = null; pid = e.pointerId;
    setPeek(fc);   // the pressed card lifts immediately
  });
  deck.addEventListener('pointermove', (e) => {
    if (sx == null) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (!mode) {
      const revealed = cardEl && cardEl.classList.contains('revealed');
      // Pull-up wins even when a bit diagonal (natural "pull it out" motion); a revealed card
      // lifts in any direction; otherwise a clear sideways move browses the fan.
      if ((dy < -TH && Math.abs(dy) >= Math.abs(dx) * 0.7) || (revealed && Math.hypot(dx, dy) > TH)) {
        mode = 'lift'; try { deck.setPointerCapture(pid); } catch { /* older webviews */ }
      } else if (Math.abs(dx) > TH || Math.abs(dy) > TH) { mode = 'scroll'; } else return;
    }
    if (mode === 'scroll') {
      if (scroller) scroller.scrollLeft = startScroll - dx;      // JS-driven for touch + mouse
      const fc = cardUnder(e.clientX, e.clientY); setPeek(fc);   // peek follows the finger
      if (dy < -TH * 1.8 && fc) {                                // pulled up mid-browse -> grab THIS card
        grab(fc); mode = 'lift'; try { deck.setPointerCapture(pid); } catch { /* older webviews */ }
      } else return;
    }
    // lift
    clearPeek();
    if (!ghost) {
      ghost = document.createElement('div'); ghost.className = 'pslot-ghost rarity-' + card.r;
      const gi = document.createElement('img'); gi.alt = ''; gi.src = `${CARD_ART_BASE}/${card.r}/${card.n}.webp`;
      ghost.appendChild(gi); document.body.appendChild(ghost);
    }
    ghost.style.left = e.clientX + 'px'; ghost.style.top = e.clientY + 'px';
    const slot = slotUnder(e.clientX, e.clientY);
    document.querySelectorAll('.pslot.pslot-over').forEach((s) => s.classList.remove('pslot-over'));
    if (slot) slot.classList.add('pslot-over');
  });
  const end = (e) => {
    if (sx == null) { reset(); return; }
    if (mode === 'lift') {
      const slot = slotUnder(e.clientX, e.clientY);
      if (slot && slot.dataset.slot != null) { setSlotCard(+slot.dataset.slot, { r: card.r, n: +card.n }); renderCardsPage(); }
    } else if (mode == null && cardEl) {
      const was = cardEl.classList.contains('revealed');   // tap toggles reveal (one at a time)
      deck.querySelectorAll('.fan-card.revealed').forEach((el) => el.classList.remove('revealed'));
      if (!was) cardEl.classList.add('revealed');
    }
    reset();
  };
  deck.addEventListener('pointerup', end);
  deck.addEventListener('pointercancel', reset);
})();
// ---- Cards-page slot gestures (delegated on #cards-slots, survives re-renders) --------------
// Mirrors the lobby's bindSlotDrag but for the cards room. On a FILLED slot:
//   TAP   -> open the power info popup (what the power does + the equipped card's buff).
//   DRAG  -> onto ANOTHER slot: swap the two cards (move a card between powers).
//         -> dropped anywhere OFF every slot: unequip — the card returns to its rarity tier
//            in the album (renderCardsPage re-adds it since it's no longer equipped).
// An empty slot can't be dragged; a tap still opens its info ("drag a card here").
(function bindCardsSlotDrag() {
  const slotsEl = document.getElementById('cards-slots');
  if (!slotsEl) return;
  let sx = null, sy = null, srcSlot = null, srcCard = null, mode = null, ghost = null, pid = null;
  const TH = 8;
  const slotUnder = (x, y) => { const el = document.elementFromPoint(x, y); return el && el.closest ? el.closest('.pslot') : null; };
  const clear = () => {
    if (ghost) { ghost.remove(); ghost = null; }
    document.querySelectorAll('.pslot.pslot-over').forEach((s) => s.classList.remove('pslot-over'));
  };
  const reset = () => { clear(); sx = sy = null; srcSlot = null; srcCard = null; mode = null; pid = null; };
  slotsEl.addEventListener('pointerdown', (e) => {
    const slotEl = e.target && e.target.closest ? e.target.closest('.pslot') : null;
    if (!slotEl || slotEl.dataset.slot == null) { srcSlot = null; return; }
    srcSlot = +slotEl.dataset.slot; srcCard = effectiveLoadout()[srcSlot];
    sx = e.clientX; sy = e.clientY; mode = null; pid = e.pointerId;
    try { slotsEl.setPointerCapture(pid); } catch { /* older webviews */ }
  });
  slotsEl.addEventListener('pointermove', (e) => {
    if (sx == null || srcSlot == null) return;
    if (!mode) {
      if (srcCard && Math.hypot(e.clientX - sx, e.clientY - sy) > TH) mode = 'drag'; // only a FILLED slot drags
      else return;
    }
    if (!ghost) {
      ghost = document.createElement('div'); ghost.className = 'pslot-ghost rarity-' + srcCard.r;
      const gi = document.createElement('img'); gi.alt = ''; gi.src = `${CARD_ART_BASE}/${srcCard.r}/${srcCard.n}.webp`;
      ghost.appendChild(gi); document.body.appendChild(ghost);
    }
    ghost.style.left = e.clientX + 'px'; ghost.style.top = e.clientY + 'px';
    const slot = slotUnder(e.clientX, e.clientY);
    document.querySelectorAll('.pslot.pslot-over').forEach((s) => s.classList.remove('pslot-over'));
    if (slot && +slot.dataset.slot !== srcSlot) slot.classList.add('pslot-over');
    ghost.classList.toggle('pslot-ghost-remove', !slot);  // off every slot -> "release to send back to the album"
  });
  const end = (e) => {
    if (sx == null || srcSlot == null) { reset(); return; }
    if (mode === 'drag') {
      const slot = slotUnder(e.clientX, e.clientY);
      if (slot && slot.dataset.slot != null && +slot.dataset.slot !== srcSlot) swapSlots(srcSlot, +slot.dataset.slot);
      else if (!slot) setSlotCard(srcSlot, null);   // dropped off every slot -> unequip, card returns to its tier
      // dropped back on the same slot -> no-op
      renderCardsPage();
    } else {
      showSlotInfo(srcSlot);   // a tap -> power info popup
    }
    reset();
  };
  slotsEl.addEventListener('pointerup', end);
  slotsEl.addEventListener('pointercancel', reset);
})();
// "Equip best" inside the cards room: auto-fill the 3 slots with the best cards (rarity, then
// copies — same as the home #select-best-btn), then refresh both the room and the lobby slots.
document.getElementById('cards-best-btn')?.addEventListener('click', () => {
  unlockAudio();
  const top = rankForLoadout(myCards()).slice(0, 3);
  myLoadout = [0, 1, 2].map((i) => (top[i] ? { r: top[i].r, n: +top[i].n } : null));
  saveLoadout(myLoadout);
  renderPowerSlots(); renderCardsPage();
  sendMsg({ type: 'setLoadout', loadout: myLoadout });
});
// ---- Lobby slot gestures (delegated on #power-slots, survives re-renders) --------------
// TAP a slot            -> open the cards room, targeting that slot.
// DRAG a filled slot onto another slot -> SWAP the two cards.
// DRAG a filled slot and release OUTSIDE any slot -> REMOVE that card.
// An empty slot can't be dragged; tapping it still opens the room to add a card.
(function bindSlotDrag() {
  if (!powerSlotsEl) return;
  let sx = null, sy = null, srcSlot = null, srcCard = null, mode = null, ghost = null;
  const TH = 10; // px of movement before a press counts as a drag (below = tap)
  const heroBtn = document.getElementById('pick-hero-btn');
  const slotUnder = (x, y) => { const el = document.elementFromPoint(x, y); return el && el.closest ? el.closest('.pslot') : null; };
  const heroUnder = (x, y) => { const el = document.elementFromPoint(x, y); return !!(el && el.closest && el.closest('#pick-hero-btn')); };
  const clear = () => {
    if (ghost) { ghost.remove(); ghost = null; }
    powerSlotsEl.classList.remove('slots-dragging');
    document.querySelectorAll('.pslot.pslot-over').forEach((s) => s.classList.remove('pslot-over'));
    if (heroBtn) heroBtn.classList.remove('hub-hero-over');
  };
  const reset = () => { clear(); sx = sy = null; srcSlot = null; srcCard = null; mode = null; };
  powerSlotsEl.addEventListener('pointerdown', (e) => {
    const slotEl = e.target && e.target.closest ? e.target.closest('.pslot') : null;
    if (!slotEl || slotEl.dataset.slot == null) { srcSlot = null; return; }
    srcSlot = +slotEl.dataset.slot; srcCard = effectiveLoadout()[srcSlot];
    sx = e.clientX; sy = e.clientY; mode = null;
    try { powerSlotsEl.setPointerCapture(e.pointerId); } catch { /* older webviews */ }
  });
  powerSlotsEl.addEventListener('pointermove', (e) => {
    if (sx == null || srcSlot == null) return;
    if (!mode) {
      if (srcCard && Math.hypot(e.clientX - sx, e.clientY - sy) > TH) mode = 'drag'; // only a FILLED slot drags
      else return;
    }
    if (!ghost) {
      ghost = document.createElement('div');
      ghost.className = 'pslot-ghost rarity-' + srcCard.r;
      const gi = document.createElement('img'); gi.alt = '';
      gi.src = `${CARD_ART_BASE}/${srcCard.r}/${srcCard.n}.webp`;
      ghost.appendChild(gi); document.body.appendChild(ghost);
      powerSlotsEl.classList.add('slots-dragging');
    }
    ghost.style.left = e.clientX + 'px'; ghost.style.top = e.clientY + 'px';
    const slot = slotUnder(e.clientX, e.clientY);
    const onHero = !slot && heroUnder(e.clientX, e.clientY); // over the hero -> re-skin (never removes the card)
    document.querySelectorAll('.pslot.pslot-over').forEach((s) => s.classList.remove('pslot-over'));
    if (slot && +slot.dataset.slot !== srcSlot) slot.classList.add('pslot-over');
    if (heroBtn) heroBtn.classList.toggle('hub-hero-over', onHero);
    ghost.classList.toggle('pslot-ghost-remove', !slot && !onHero); // off both slots AND hero -> "release to remove"
  });
  const end = (e) => {
    if (sx == null || srcSlot == null) { reset(); return; }
    if (mode === 'drag') {
      const slot = slotUnder(e.clientX, e.clientY);
      if (slot && slot.dataset.slot != null && +slot.dataset.slot !== srcSlot) swapSlots(srcSlot, +slot.dataset.slot);
      else if (!slot && srcCard && heroUnder(e.clientX, e.clientY)) setHeroSkinByRarity(srcCard.r); // drop on hero -> re-skin, card STAYS in its slot
      else if (!slot) setSlotCard(srcSlot, null);   // dropped off every slot AND the hero -> remove
      // dropped back on the same slot -> no-op
    } else {
      cardsSelSlot = srcSlot; renderCardsPage(); showScreen('cards'); // a tap -> open the room on this slot
    }
    reset();
  };
  powerSlotsEl.addEventListener('pointerup', end);
  powerSlotsEl.addEventListener('pointercancel', reset);
})();
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
    // #15: no ✕ — the popup closes on an outside/backdrop click (handler bound above).
    '<div class="pinfo-head"><span class="pinfo-icon">' + meta.icon + '</span><b>' + meta.label + '</b></div>'
    + '<p class="pinfo-desc">' + meta.desc + '</p>'
    + (card
      ? '<div class="pinfo-eq">קלף מצויד: ' + (HEB_RAR[card.r] || '') + ' · <span class="pinfo-pct">+' + (RARITY_PCT[card.r] || 0) + '% חוזק</span></div>'
      : '<p class="pinfo-empty">חריץ ריק — גררו קלף מהאוסף לכאן כדי לצייד את הכוח.</p>')
    + '<div class="pinfo-tiers">נדירות הקלף קובעת את החוזק: נפוץ +3% · נדיר +7% · אדיר +12% · אגדי +20%</div>'
    + (card ? '<button class="pinfo-remove">הסר קלף מהחריץ</button>' : '');
  const rm = box.querySelector('.pinfo-remove');
  if (rm) rm.addEventListener('click', () => { setSlotCard(i, null); hidePowerInfo(); renderCardsPage(); }); // removed card returns to the album
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
// The idle lobby hero runs a looping routine: a random emote for 5s, then walk
// for 30s, over and over — a fresh (non-repeating) move each cycle. Starts on a
// dance at load, and restarts (dancing first) on any hero/costume change.
// Emote pool = LOBBY_DANCES minus 'walk'. Wardrobe preview stays walk-only.
const LOBBY_EMOTES = LOBBY_DANCES.filter((a) => a !== 'walk');
const pickEmote = () => LOBBY_EMOTES[Math.floor(Math.random() * LOBBY_EMOTES.length)] || 'walk';
const DANCE_MS = 5000, WALK_MS = 30000;        // 5s dance, then 30s walk
let homeQueue = [];                            // pending [action, durationMs] steps
let homeCur = 'walk';                          // action playing right now
let homeCurEnd = 0;                            // performance.now() ms when the current step ends
let homeLastEmote = null;                      // avoid the same dance two cycles running
function advanceHomeRoutine(nowMs) {
  if (nowMs < homeCurEnd) return;              // current step still running
  if (!homeQueue.length) {                     // build the next cycle: dance (5s) → walk (30s)
    let a = pickEmote(), guard = 0;
    while (a === homeLastEmote && LOBBY_EMOTES.length > 1 && guard++ < 8) a = pickEmote();
    homeLastEmote = a;
    homeQueue = [[a, DANCE_MS], ['walk', WALK_MS]];
  }
  const [act, dur] = homeQueue.shift();
  homeCur = act; homeCurEnd = nowMs + dur;
}
function restartHomeRoutine() { homeQueue = []; homeCurEnd = 0; }   // next frame starts a fresh dance
// Home preview: the player's chosen hero+skin performing the current emote. Uses the
// same drawHero() renderer as the pitch, so what you pick is exactly what you get.
function drawDancer(g, W, H, t) {
  g.clearRect(0, 0, W, H);
  g.imageSmoothingEnabled = false;
  const sf = H / 46, ox = W / 2, feetY = H - sf * 4;
  const dir = Math.sin(t * 0.0009);            // slow look left/right
  advanceHomeRoutine(t);
  if (homeCur === 'walk') {
    drawHero(g, ox, feetY, sf, dir, t * 0.008, 0.7, false, myCosmetic, PREVIEW_KIT, t / 1000);  // gentle in-place jog
  } else {
    drawHero(g, ox, feetY, sf, dir, 0, 0, false, myCosmetic, PREVIEW_KIT, t / 1000, { action: homeCur });
  }
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

  // static thumbnail of a hero in a given skin (defaults to the currently-selected skin)
  function drawThumb(cv, heroKey, skinKey) {
    if (!cv) return;
    const g = cv.getContext('2d'); g.clearRect(0, 0, cv.width, cv.height);
    g.imageSmoothingEnabled = false;
    const sf = cv.height / 40, ox = cv.width / 2, feetY = cv.height - sf * 3;
    drawHero(g, ox, feetY, sf, 1, 0, 0, false, `${heroKey}:${skinKey || sel.skin}`, PREVIEW_KIT, 0);
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
  // Costumes carousel: each skin swatch previews the CURRENT hero wearing that skin, so it
  // re-draws whenever the selected hero changes.
  function refreshSkinThumbs() {
    tiersEl.querySelectorAll('.pick-tier').forEach((el) => drawThumb(el.querySelector('canvas'), sel.hero, el.dataset.skin));
  }

  // build costume (skin) carousel + hero-type carousel once
  SKIN_KEYS.forEach((sk) => {
    const b = document.createElement('button');
    b.className = 'pick-tier r-' + SKIN_RARITY[sk]; b.dataset.skin = sk;
    const c = document.createElement('canvas'); c.width = 60; c.height = 72;
    const lbl = document.createElement('span'); lbl.className = 'pick-lbl'; lbl.innerHTML = `<span class="dot"></span>${SKIN_NAMES[sk]}`;
    b.appendChild(c); b.appendChild(lbl);
    b.addEventListener('click', () => { sel.skin = sk; refreshTierSel(); refreshHeroSel(); refreshName(); });
    tiersEl.appendChild(b);
  });
  HERO_KEYS.forEach((hk) => {
    const cell = document.createElement('button');
    cell.className = 'pick-hero'; cell.dataset.hero = hk;
    const c = document.createElement('canvas'); c.width = 66; c.height = 78;
    const lbl = document.createElement('span'); lbl.textContent = HERO_NAMES[hk];
    cell.appendChild(c); cell.appendChild(lbl);
    cell.addEventListener('click', () => { sel.hero = hk; refreshHeroSel(); refreshSkinThumbs(); refreshName(); });
    heroesEl.appendChild(cell);
  });

  function open() {
    unlockAudio();
    const cut = myCosmetic.indexOf(':');
    sel = { hero: myCosmetic.slice(0, cut), skin: myCosmetic.slice(cut + 1) };
    refreshTierSel(); refreshHeroSel(); refreshSkinThumbs(); refreshName();
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
    restartHomeRoutine();                       // fresh dance routine on every hero/costume change
    close();
  }

  btnOpen.addEventListener('click', open);
  document.getElementById('pick-save').addEventListener('click', saveAndClose);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); }); // #15: outside-click closes (no ✕)
})();

// The user/home screen is shown first (no title gate): render identity + card
// carousel, start the character dance, and connect straight away.
let quickVs = false; // quick-match VS/countdown flag — MUST be declared before init runs, since showScreen() reads it for lobby music (was a startup TDZ crash)
renderHomeCharacter();
showScreen('home');
startHomeDance();
connect(MY_NAME, MY_AVATAR);

// ---- Lobby hub scale-to-fit -------------------------------------------------
// The hub is authored at a fixed 900x415 logical stage; scale it uniformly to the
// viewport so the whole hub grows/shrinks as one unit and never clips (like a canvas).
const HUB_W = 900, HUB_H = 415;
const hubStageEl = document.querySelector('#home .hub');
function fitHub() {
  if (!hubStageEl) return;
  const s = Math.min(window.innerWidth / HUB_W, window.innerHeight / HUB_H);
  hubStageEl.style.transform = 'translate(-50%,-50%) scale(' + s + ')';
}
addEventListener('resize', fitHub);
fitHub();

// ---- Lobby-redesign sub-screens (arena / news / shop / clubs) ---------------
// Register the new .screen divs so the existing showScreen() drives open/close.
for (const id of ['arena', 'news', 'shop', 'clubs', 'cards', 'rank']) {
  const el = document.getElementById(id);
  if (el) screens[id] = el;
}
// Shop daily-deal countdown to next local midnight (cosmetic basis for the «מבצע יומי» row).
const shopTimerEl = document.getElementById('shop-daily-timer');
if (shopTimerEl) {
  const p2 = (n) => String(n).padStart(2, '0');
  const tickShopTimer = () => {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
    let s = Math.max(0, Math.floor((next - now) / 1000));
    const h = Math.floor(s / 3600); s -= h * 3600;
    const m = Math.floor(s / 60); s -= m * 60;
    shopTimerEl.textContent = 'מתאפס בעוד ' + p2(h) + ':' + p2(m) + ':' + p2(s);
  };
  tickShopTimer();
  setInterval(tickShopTimer, 1000);
}
document.querySelectorAll('[data-open-screen]').forEach((el) => {
  el.addEventListener('click', () => { if (!el.disabled) showScreen(el.dataset.openScreen); });
});
document.querySelectorAll('[data-home-back]').forEach((el) => {
  el.addEventListener('click', () => showScreen('home'));
});

// Tap-outside-to-leave: every lobby sub-page (shop / friends / clubs / arena / news / rank /
// cards) also returns to the hub when the user taps an EMPTY / non-button region — i.e.
// anything that is NOT an interactive control. On the friends screen the "main area" is the
// centred panel, so only the stadium around it dismisses (taps inside the panel are ignored).
// The ‹ back buttons still work too. Safe by design: (1) we require BOTH the pointerdown and
// the click to land on a dismiss target, so a card drag/scroll that ends on the backdrop never
// closes the page; (2) genuine controls — buttons/inputs plus the app's non-button widgets
// (album cards, power slots, friend rows, tabs) — are whitelisted and always keep the page open.
function isDismissBackdrop(t, screenEl) {
  if (!t) return false;
  if (t === screenEl) return true;                                    // stadium around a panel / outer page margin
  if (t.closest('.home-wrap')) return false;                          // inside the friends panel = main area → keep open
  // Interactive controls always keep the page open (buttons/links/inputs + non-button widgets).
  if (t.closest('button, a, input, textarea, select, label, [role="button"], [contenteditable], .pslot, .pslot-item, .fan-card, .cards-fan, .friend-row, .fr-tab')) return false;
  // Dismiss only on the page's own EMPTY structural whitespace — outer padding of the sub-page,
  // the body's gaps/side-margins, the header whitespace, or a bare heading. Visible content tiles
  // (shop items, news/club cards, mode cards, …) are the "main area" and are left alone, so the
  // default is always keep-open — content or controls added by other agents never trigger it.
  return t.matches('.subpage, .subpage-body, .subpage-head, h2');
}
for (const id of ['arena', 'news', 'shop', 'clubs', 'rank', 'cards', 'friends']) {
  const scr = screens[id];
  if (!scr) continue;
  let downOnBackdrop = false;
  scr.addEventListener('pointerdown', (e) => { downOnBackdrop = isDismissBackdrop(e.target, scr); });
  scr.addEventListener('click', (e) => {
    if (downOnBackdrop && isDismissBackdrop(e.target, scr)) { downOnBackdrop = false; showScreen('home'); }
  });
}
// Arena "2 נגד 2" launches the same quick match as the home Quick Match button.
// Push my live equipped loadout to the server right before entering a match, so the countdown/reveal
// other players see (and my own server-side record) match my slots even if join raced card-loading.
function syncLoadout() { sendMsg({ type: 'setLoadout', loadout: effectiveLoadout() }); }
document.getElementById('arena-2v2-btn')?.addEventListener('click', () => { unlockAudio(); syncLoadout(); sendMsg({ type: 'quickMatch' }); });

// Hub top-left: settings opens the shared settings/pause panel; exit asks the RN app host.
document.getElementById('hub-settings')?.addEventListener('click', () => { unlockAudio(); openSettings(); });
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
document.getElementById('quick-match-btn').addEventListener('click', () => { unlockAudio(); syncLoadout(); sendMsg({ type: 'quickMatch' }); });
document.getElementById('friends-btn').addEventListener('click', () => {
  unlockAudio(); showScreen('friends');
  const s = document.getElementById('friend-search'); if (s) s.value = '';
  renderSearch([]); setFriendsTab('list');
  loadFriends(); // #3: refresh on open (also self-heals a failed initial load / WS reconnect)
});
document.getElementById('training-btn').addEventListener('click', () => { unlockAudio(); sendMsg({ type: 'training' }); });
document.getElementById('reset-ball-btn').addEventListener('click', () => { sendMsg({ type: 'resetBall' }); });
// Pick-best loadout (restored): null loadout => effectiveLoadout() auto-fills the album's
// top-3 into the slots; persist, re-render the home slots, and tell the server live.
document.getElementById('select-best-btn')?.addEventListener('click', () => {
  unlockAudio();
  // Equip the 3 best cards by rarity, then duplication (see rankForLoadout).
  const top = rankForLoadout(myCards()).slice(0, 3);
  myLoadout = [0, 1, 2].map((i) => (top[i] ? { r: top[i].r, n: +top[i].n } : null));
  saveLoadout(myLoadout);
  renderPowerSlots();
  sendMsg({ type: 'setLoadout', loadout: myLoadout });
  toast('צוידו הקלפים הטובים ביותר');
});
// Play with friends: STEP 1 — pick friends (multi-select), STEP 2 — pick the minigame,
// then a room is created and the picks are applied. Join-by-code lives in step 1.
document.getElementById('play-friends-btn')?.addEventListener('click', () => {
  unlockAudio();
  openFriendSelect();               // step 1: choose friends (or join by code)
});
// Friends screen is friends-only (look / add / remove). Room create/join moved to the
// «שחק עם חברים» party flow. The screen matches the clubs sub-page layout and has NO back
// button — you leave by tapping the empty background (see isDismissBackdrop wiring above).

// Friends redesign: segmented tabs (list · requests · add). Panes keep the original ids so
// loadFriends()/searchFriends()/render* are untouched — this only shows/hides the panes.
function setFriendsTab(tab) {
  document.querySelectorAll('#friends .fr-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('#friends .fr-pane').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== tab));
  if (tab === 'add') { const s = document.getElementById('friend-search'); if (s) setTimeout(() => s.focus(), 40); }
}
document.querySelectorAll('#friends .fr-tab').forEach((t) => t.addEventListener('click', () => { unlockAudio(); setFriendsTab(t.dataset.tab); }));

// Task 2: rank button (under the news satellite). Shows the player's LIVE football
// leaderboard position (server ranks by xp desc; /handle-friends/rank resolves userId→phone).
// Rank opens its own screen: big label = current DIVISION (tier + sub-rank, from the level),
// sub-line = LIVE global leaderboard position (server ranks by xp desc; /handle-friends/rank
// resolves userId→phone). The active tier tile in the ladder is highlighted.
const rankMeDiv = document.getElementById('rank-me-div');
const rankMeIc = document.getElementById('rank-me-ic');
const rankMeSub = document.getElementById('rank-me-sub');
function renderRankMeDivision() {
  const { tier, sub } = rankTierFromLevel(currentXpState().level);
  if (rankMeIc) rankMeIc.textContent = tier.ic;
  if (rankMeDiv) rankMeDiv.textContent = tier.label + ' ' + sub;
  document.querySelectorAll('#rank .rank-tier').forEach((t) => t.classList.toggle('on', t.dataset.tier === tier.key));
}
document.getElementById('rank-btn')?.addEventListener('click', async () => {
  unlockAudio();
  showScreen('rank');
  renderRankMeDivision();                                   // division is always known (from level)
  if (rankMeSub) rankMeSub.textContent = 'טוען דירוג עולמי…';
  if (!FOOTBALL_TOKEN) { if (rankMeSub) rankMeSub.textContent = 'התחברו דרך האפליקציה לדירוג עולמי'; return; }
  const res = await apiGet('/handle-friends/rank');
  if (!res) { if (rankMeSub) rankMeSub.textContent = 'טעינת הדירוג העולמי נכשלה — נסו שוב'; return; }
  if (res.rank == null) { if (rankMeSub) rankMeSub.textContent = 'עדיין לא בטבלה — שחקו משחק כדי להיכנס'; return; }
  if (rankMeSub) rankMeSub.textContent = 'מקום עולמי #' + res.rank + ' מתוך ' + res.totalPlayers + ' שחקנים';
});
// #14/#15: joiner "waiting for approval" overlay — the cancel button withdraws the pending
// request (leaveRoom -> server drops it + returns us home). The outside/backdrop-click handler
// is registered further down, right after `roomWaitEl` is declared (referencing it up here is a
// top-level TDZ that halts the whole module).
document.getElementById('room-wait-cancel')?.addEventListener('click', () => { sendMsg({ type: 'leaveRoom' }); hideRoomWait(); });
// Lobby actions.
document.getElementById('lobby-leave').addEventListener('click', leaveToLobby); // #17
// #17: leave-to-lobby button, available in-match AND in the training ground.
document.getElementById('leave-lobby-btn')?.addEventListener('click', leaveToLobby);
joinBtn.A.addEventListener('click', () => sendMsg({ type: 'setTeam', team: 'A' }));
joinBtn.B.addEventListener('click', () => sendMsg({ type: 'setTeam', team: 'B' }));
playNowBtn.addEventListener('click', () => {
  unlockAudio();
  syncLoadout();
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
// Private-room membership (#14) — host approval, kick, joiner "waiting" state.
// EXACT wire contract is owned by the server agent; kept here as constants so it's
// trivial to reconcile. Verified against server.js:
//   S->C  joinRequest {joinerId,userId,name,avatar,cosmetic,cards}  (to HOST, one per joiner)
//         joinRequestCancelled {joinerId}                            (to HOST — joiner left)
//         joinPending {code}                                         (to JOINER — awaiting approval)
//         joinRejected {code,reason}   reason: rejected|full|closed  (to JOINER)
//         kicked {code}                                              (to the removed member)
//         roomJoined {mode,code,host:<bool>}                         (host flag on entry)
//         lobby {... host:<hostMemberId|null>, members:[...]}        (host === myMemberId => I host)
//   C->S  joinDecision {joinerId,accept}   |  kick {memberId}   |  leaveRoom {}
const ROOM_MSG = {
  JOIN_REQUEST: 'joinRequest', JOIN_CANCELLED: 'joinRequestCancelled',
  PENDING: 'joinPending', REJECTED: 'joinRejected', KICKED: 'kicked',
  DECIDE: 'joinDecision', KICK: 'kick',
};
let isRoomHost = false;                 // am I this room's host? (roomJoined.host / lobby.host === myMemberId)
const pendingReqs = new Map();          // joinerId -> request, awaiting my (host) accept/reject
const roomRequestsEl = document.getElementById('room-requests');
const roomWaitEl = document.getElementById('room-wait');
// #14/#15: outside/backdrop click on the "waiting for approval" overlay withdraws the request.
// Registered HERE (not with the other top-level listeners above) so it runs AFTER roomWaitEl is
// declared — a reference before this line is a TDZ that halts module evaluation.
roomWaitEl?.addEventListener('click', (e) => { if (e.target === roomWaitEl) { sendMsg({ type: 'leaveRoom' }); hideRoomWait(); } });

function clearRoomRequests() { pendingReqs.clear(); renderRoomRequests(); }
function renderRoomRequests() {
  if (!roomRequestsEl) return;
  const reqs = isRoomHost ? [...pendingReqs.values()] : [];
  roomRequestsEl.innerHTML = '';
  roomRequestsEl.classList.toggle('hidden', reqs.length === 0);
  if (!reqs.length) return;
  const h = document.createElement('div'); h.className = 'room-req-h'; h.textContent = 'בקשות הצטרפות';
  roomRequestsEl.appendChild(h);
  for (const r of reqs) {
    const row = document.createElement('div'); row.className = 'room-req';
    const av = document.createElement('div'); av.className = 'room-req-av';
    if (r.avatar) av.style.backgroundImage = `url("${r.avatar}")`; else av.textContent = memberInitials(r.name);
    const nm = document.createElement('div'); nm.className = 'room-req-name'; nm.textContent = r.name || 'שחקן';
    const ok = document.createElement('button'); ok.className = 'room-req-ok'; ok.textContent = 'אישור';
    const no = document.createElement('button'); no.className = 'room-req-no'; no.textContent = 'דחייה';
    ok.addEventListener('click', () => decideRequest(r.joinerId, true));
    no.addEventListener('click', () => decideRequest(r.joinerId, false));
    row.append(av, nm, ok, no);
    roomRequestsEl.appendChild(row);
  }
}
function decideRequest(joinerId, accept) {
  sendMsg({ type: ROOM_MSG.DECIDE, joinerId, accept });
  pendingReqs.delete(joinerId);         // resolved locally; the server won't re-notify for this one
  renderRoomRequests();
}
function kickMember(memberId) { sendMsg({ type: ROOM_MSG.KICK, memberId }); }

function showRoomWait(code) {
  if (!roomWaitEl) return;
  const c = roomWaitEl.querySelector('.room-wait-code');
  if (c) c.textContent = code || roomCode || '···';
  roomWaitEl.classList.remove('hidden');
}
function hideRoomWait() { if (roomWaitEl) roomWaitEl.classList.add('hidden'); }

// --------------------------------------------------------------------------
// Friends & Challenges (Slice 1) — pikme-server REST (Task 3) + WS presence/
// challenge messages (Tasks 4-6). Only reachable for authenticated (Pikme)
// connections: MY_USER_ID is set from `welcome`, which fires loadFriends().
// --------------------------------------------------------------------------
function apiHeaders() { return { 'content-type': 'application/json', 'football-auth': FOOTBALL_TOKEN || '' }; }
// #3: returns null on FAILURE (so callers can show an inline error/retry state) vs an
// array/object on success — a silent [] used to hide "couldn't load" behind "no friends".
async function apiGet(path) {
  try {
    const r = await fetch(`${PIKME_API}${path}`, { headers: apiHeaders() });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}
async function apiPost(path, body) {
  try {
    const r = await fetch(`${PIKME_API}${path}`, { method: 'POST', headers: apiHeaders(), body: JSON.stringify(body) });
    if (!r.ok) { toast('החיבור נכשל, נסה שוב'); return false; }
    return true;
  } catch { toast('החיבור נכשל, נסה שוב'); return false; }
}

// 3 built-in BOT friends — always available (online), invitable into a party from the
// invite panel (→ addBot). They fill out the friends list so solo players can "play with
// friends" immediately. Not real users: they don't go through search/request/presence.
const BOT_FRIENDS = [
  { userId: 'bot-friend-1', nickName: 'שובל', isBot: true, color: '#e0556b', level: 12, xp: 5400, rank: 3,
    cards: [{ r: 'legendary', n: 1 }, { r: 'epic', n: 7 }, { r: 'rare', n: 22 }] },
  { userId: 'bot-friend-2', nickName: 'אורית', isBot: true, color: '#4ea0ff', level: 8, xp: 2600, rank: 11,
    cards: [{ r: 'epic', n: 3 }, { r: 'rare', n: 15 }, { r: 'common', n: 8 }] },
  { userId: 'bot-friend-3', nickName: 'נווה', isBot: true, color: '#b46bff', level: 15, xp: 7200, rank: 1,
    cards: [{ r: 'legendary', n: 5 }, { r: 'legendary', n: 2 }, { r: 'epic', n: 9 }] },
  { userId: 'bot-friend-4', nickName: 'פז', isBot: true, color: '#f0a934', level: 5, xp: 1200, rank: 24,
    cards: [{ r: 'rare', n: 31 }, { r: 'common', n: 3 }, { r: 'common', n: 12 }] },
];
let FRIENDS = [...BOT_FRIENDS];   // [{userId, nickName, image, isBot?}] — bots always present
let ONLINE = new Set();    // userIds currently online (from friendsPresence)
let friendsBusy = false;   // in-flight guard so the friends fetch isn't stacked
let searchSeq = 0;         // drops out-of-order search responses

// A small placeholder row (loading / empty / error) inside a friend list. `onClick`, if
// given, makes it a tap-to-retry row.
function listMsg(id, text, onClick) {
  const el = document.getElementById(id); if (!el) return;
  el.innerHTML = '';
  const d = document.createElement('div');
  d.className = 'friend-empty' + (onClick ? ' friend-retry' : '');
  d.textContent = text;
  if (onClick) d.addEventListener('click', onClick);
  el.appendChild(d);
}

async function loadFriends() {
  // No app identity (web/dev, or token not injected) -> say so instead of showing a blank,
  // silently-broken panel.
  // No app identity (web/dev): still show the built-in bot friends so the list isn't empty.
  if (!FOOTBALL_TOKEN || !MY_USER_ID) { FRIENDS = [...BOT_FRIENDS]; renderFriends(); return; }
  if (friendsBusy) return;
  friendsBusy = true;
  listMsg('friend-list', 'טוען חברים…');
  const res = await apiGet('/handle-friends');
  friendsBusy = false;
  if (res === null) { FRIENDS = [...BOT_FRIENDS]; renderFriends(); return; } // load failed → at least the bots
  const real = Array.isArray(res) ? res : [];
  sendMsg({ type: 'setFriends', friends: real.map((f) => f.userId) }); // real ids only (presence)
  FRIENDS = [...real, ...BOT_FRIENDS];
  renderFriends();
  loadRequests();
}
async function loadRequests() {
  const reqs = await apiGet('/handle-friends/requests');       // secondary list — stay silent on error
  renderRequests(Array.isArray(reqs) ? reqs : []);
}
async function searchFriends(q) {
  if (!q || q.length < 2) { renderSearch([]); return; }
  if (!MY_USER_ID) { listMsg('friend-search-results', 'התחברו דרך האפליקציה כדי לחפש'); return; }
  const seq = ++searchSeq;
  listMsg('friend-search-results', 'מחפש…');
  const res = await apiGet(`/handle-friends/search?q=${encodeURIComponent(q)}`);
  if (seq !== searchSeq) return;                                // a newer query already fired
  if (res === null) { listMsg('friend-search-results', 'החיפוש נכשל — נסו שוב'); return; }
  if (!Array.isArray(res) || !res.length) { listMsg('friend-search-results', 'לא נמצאו תוצאות'); return; }
  renderSearch(res);
}

function friendRow(f, opts = {}) {
  const online = ONLINE.has(f.userId) || !!f.isBot;   // built-in bot friends are always available
  const div = document.createElement('div');
  div.className = 'friend-row' + (online ? ' online' : '') + (f.isBot ? ' is-bot' : '');
  const dot = document.createElement('span'); dot.className = 'friend-dot';
  const pfp = document.createElement('img'); pfp.className = 'friend-pfp';
  const imgUrl = (f.image || '').toString();
  if (/^https?:\/\//i.test(imgUrl)) pfp.src = imgUrl;
  const nm = document.createElement('span'); nm.className = 'friend-name'; nm.textContent = f.nickName || '';
  div.append(dot, pfp, nm);
  // Bots in the friends list: no challenge/remove — just a tag. They're invitable in the party panel.
  if (f.isBot && opts.kind !== 'search') {
    const tag = document.createElement('span'); tag.className = 'friend-bot-tag'; tag.textContent = '🤖 בוט';
    div.appendChild(tag);
    return div;
  }
  const btn = document.createElement('button');
  btn.className = 'friend-act';
  if (opts.kind === 'search') { btn.textContent = 'הוסף'; btn.onclick = async () => { if (await apiPost('/handle-friends/request', { toUserId: f.userId })) { btn.textContent = 'נשלח'; btn.disabled = true; } }; }
  else if (opts.kind === 'request') {
    btn.textContent = 'אישור';
    btn.onclick = async () => { if (await apiPost('/handle-friends/respond', { requestId: f.requestId, action: 'accept' })) { loadFriends(); } };
    const dec = document.createElement('button');
    dec.className = 'friend-act ghost'; dec.textContent = 'דחה';
    dec.onclick = async () => { if (await apiPost('/handle-friends/respond', { requestId: f.requestId, action: 'decline' })) { loadRequests(); } };
    div.appendChild(dec);
  }
  else { btn.textContent = 'אתגר'; btn.disabled = !online; btn.onclick = () => sendMsg({ type: 'challenge', toUserId: f.userId }); }
  div.appendChild(btn);
  return div;
}
function renderList(id, items, opts, emptyText) {
  const el = document.getElementById(id); if (!el) return;
  el.innerHTML = '';
  if (!items || !items.length) { if (emptyText) listMsg(id, emptyText); return; }
  items.forEach((f) => el.appendChild(friendRow(f, opts)));
}
// Rich friend card for the friends window: profile pic, name, xp/rank, top-3 cards.
function friendCardEl(f) {
  const online = ONLINE.has(f.userId) || !!f.isBot;
  const div = document.createElement('div');
  div.className = 'friend-card' + (online ? ' online' : '') + (f.isBot ? ' is-bot' : '');
  const pfp = document.createElement('div'); pfp.className = 'fc-pfp';
  const img = (f.image || '').toString();
  if (/^https?:\/\//i.test(img)) { const im = document.createElement('img'); im.src = img; im.alt = ''; pfp.appendChild(im); }
  else { pfp.textContent = memberInitials(f.nickName); if (f.color) pfp.style.background = f.color; }
  const main = document.createElement('div'); main.className = 'fc-main';
  const top = document.createElement('div'); top.className = 'fc-top';
  const dot = document.createElement('span'); dot.className = 'friend-dot';
  const nm = document.createElement('span'); nm.className = 'fc-name'; nm.textContent = f.nickName || '';
  top.append(dot, nm);
  if (f.isBot) { const t = document.createElement('span'); t.className = 'friend-bot-tag'; t.textContent = '🤖'; top.appendChild(t); }
  main.appendChild(top);
  const metaBits = [];
  if (f.rank != null) metaBits.push('🏅 #' + f.rank);
  if (f.level != null) metaBits.push('דרגה ' + f.level);
  if (f.xp != null) metaBits.push('XP ' + fmtCompact(f.xp));
  if (metaBits.length) { const meta = document.createElement('div'); meta.className = 'fc-meta'; meta.textContent = metaBits.join(' · '); main.appendChild(meta); }
  const cards = Array.isArray(f.cards) ? f.cards.slice(0, 3) : [];
  if (cards.length) {
    const row = document.createElement('div'); row.className = 'fc-cards';
    cards.forEach((c) => { const im = document.createElement('img'); im.className = 'fc-card rarity-' + c.r; im.loading = 'lazy'; im.alt = ''; im.onerror = () => im.removeAttribute('src'); im.src = `${CARD_ART_BASE}/${c.r}/${c.n}.webp`; row.appendChild(im); });
    main.appendChild(row);
  }
  div.append(pfp, main);
  return div;
}
function renderFriends() {
  const el = document.getElementById('friend-list');
  if (el) {
    if (!FRIENDS.length) { listMsg('friend-list', 'עדיין אין חברים — חפשו כינוי כדי להוסיף'); }
    else { el.innerHTML = ''; FRIENDS.forEach((f) => el.appendChild(friendCardEl(f))); }
  }
  renderPartyInvite();
}
function renderSearch(items) { renderList('friend-search-results', items, { kind: 'search' }); }
function renderRequests(items) {
  const list = Array.isArray(items) ? items : [];
  renderList('friend-requests', list, { kind: 'request' }, 'אין בקשות חברות');
  const badge = document.getElementById('fr-req-badge');
  if (badge) { badge.textContent = String(list.length); badge.classList.toggle('hidden', list.length === 0); }
}

function showChallengePrompt(challengeId, fromName) {
  if (!confirm(`${fromName} מזמין אותך למשחק. לקבל?`)) { sendMsg({ type: 'challengeRespond', challengeId, accept: false }); return; }
  sendMsg({ type: 'challengeRespond', challengeId, accept: true });
}

// --- Party flow: invite online friends into the lobby, then pick a game ------------------
// Host-only panel of ONLINE friends (FRIENDS ∩ ONLINE). Shown in the private-room lobby.
function renderPartyInvite() {
  const el = document.getElementById('party-invite'); if (!el) return;
  const show = isRoomHost && roomMode === 'private';
  el.classList.toggle('hidden', !show);
  if (!show) return;
  // Online real friends + the always-available bot friends.
  const online = FRIENDS.filter((f) => f.isBot || ONLINE.has(f.userId));
  el.innerHTML = '';
  const h = document.createElement('div'); h.className = 'pi-h'; h.textContent = 'הזמן חברים למשחק';
  el.appendChild(h);
  if (!online.length) {
    const d = document.createElement('div'); d.className = 'pi-empty';
    d.textContent = 'אין חברים מחוברים כרגע';
    el.appendChild(d); return;
  }
  online.forEach((f) => {
    const row = document.createElement('div'); row.className = 'pi-row' + (f.isBot ? ' is-bot' : '');
    const dot = document.createElement('span'); dot.className = 'friend-dot';
    const nm = document.createElement('span'); nm.className = 'pi-name'; nm.textContent = (f.isBot ? '🤖 ' : '') + (f.nickName || '');
    const btn = document.createElement('button'); btn.className = 'friend-act'; btn.textContent = 'הזמן';
    // Bots aren't WS peers — invite them via addBot; real friends go through inviteFriend.
    btn.onclick = () => {
      if (f.isBot) sendMsg({ type: 'addBot', name: f.nickName });
      else { sendMsg({ type: 'inviteFriend', toUserId: f.userId }); btn.textContent = 'הוזמן'; btn.disabled = true; }
    };
    row.append(dot, nm, btn); el.appendChild(row);
  });
}
// Incoming party invite → simple accept/decline (matches showChallengePrompt's pattern).
function showPartyInvite(code, fromName) {
  if (!confirm(`${fromName} מזמין אותך לקבוצה. להצטרף?`)) { sendMsg({ type: 'partyRespond', code, accept: false }); return; }
  sendMsg({ type: 'partyRespond', code, accept: true });
}
// Party flow: STEP 1 — pick which friends to play with (multi-select). STEP 2 — pick the
// minigame. Then a room is created, the picks are applied (bots → addBot, real friends →
// inviteFriend), and the lobby opens. Join-by-code lives at the bottom of step 1 so a player
// who'd rather join a friend's room can still enter their shared code.
const friendSelectEl = document.getElementById('friend-select');
const joinCodeEl = document.getElementById('join-code');
const partySel = new Set();          // userIds selected for the party
let selectedGame = null;             // chosen minigame (set in step 2, drives the lobby start)
let pendingPartyApply = false;       // apply the picks once the fresh room's roomJoined arrives
function partyCandidates() { return FRIENDS.filter((f) => f.isBot || ONLINE.has(f.userId)); } // available to invite
function renderFriendSelect() {
  const el = document.getElementById('friend-select-list'); if (!el) return;
  el.innerHTML = '';
  const cands = partyCandidates();
  if (!cands.length) { const d = document.createElement('div'); d.className = 'pi-empty'; d.textContent = 'אין חברים זמינים כרגע'; el.appendChild(d); return; }
  cands.forEach((f) => {
    const row = document.createElement('button'); row.type = 'button';
    row.className = 'fs-row' + (partySel.has(f.userId) ? ' sel' : '') + (f.isBot ? ' is-bot' : '');
    const pfp = document.createElement('div'); pfp.className = 'fc-pfp sm';
    const img = (f.image || '').toString();
    if (/^https?:\/\//i.test(img)) { const im = document.createElement('img'); im.src = img; im.alt = ''; pfp.appendChild(im); }
    else { pfp.textContent = memberInitials(f.nickName); if (f.color) pfp.style.background = f.color; }
    const nm = document.createElement('span'); nm.className = 'fs-name'; nm.textContent = (f.isBot ? '🤖 ' : '') + (f.nickName || '');
    const chk = document.createElement('span'); chk.className = 'fs-chk'; chk.textContent = partySel.has(f.userId) ? '✓' : '';
    row.append(pfp, nm, chk);
    row.onclick = () => { if (partySel.has(f.userId)) partySel.delete(f.userId); else partySel.add(f.userId); renderFriendSelect(); };
    el.appendChild(row);
  });
}
function openFriendSelect() {
  partySel.clear(); selectedGame = null;
  if (joinCodeEl) joinCodeEl.value = '';
  syncLoadout(); loadFriends();               // refresh presence so online friends show as candidates
  renderFriendSelect();
  friendSelectEl?.classList.remove('hidden');
}
function closeFriendSelect() { friendSelectEl?.classList.add('hidden'); }
document.getElementById('friend-select-close')?.addEventListener('click', closeFriendSelect);
friendSelectEl?.addEventListener('click', (e) => { if (e.target === friendSelectEl) closeFriendSelect(); });
document.getElementById('friend-select-go')?.addEventListener('click', () => {
  unlockAudio(); closeFriendSelect(); openGameSelect('setup');   // step 2: pick the minigame
});
document.getElementById('join-room-btn')?.addEventListener('click', () => {
  unlockAudio();
  const code = (joinCodeEl?.value || '').trim().toUpperCase();
  if (code.length < 3) { showRoomError('הכניסו קוד חדר'); return; }
  closeFriendSelect();
  sendMsg({ type: 'joinRoom', code });
});

// Game picker overlay. mode 'setup' = from the friend-select flow (create room + apply picks);
// mode 'lobby' = host re-opening it inside the lobby (start immediately). Only 2v2 is live.
const gameSelectEl = document.getElementById('game-select');
let gameSelectMode = 'lobby';
function openGameSelect(mode) { gameSelectMode = mode || 'lobby'; if (gameSelectEl) gameSelectEl.classList.remove('hidden'); }
function closeGameSelect() { if (gameSelectEl) gameSelectEl.classList.add('hidden'); }
document.getElementById('pick-game-btn')?.addEventListener('click', () => {
  unlockAudio();
  if (selectedGame) { syncLoadout(); sendMsg({ type: 'ready' }); toast('מתחילים…'); } // game already chosen in setup → start
  else openGameSelect('lobby');
});
document.getElementById('game-select-close')?.addEventListener('click', closeGameSelect);
gameSelectEl?.addEventListener('click', (e) => {
  if (e.target === gameSelectEl) { closeGameSelect(); return; }               // backdrop
  const card = e.target.closest('.modecard[data-game]'); if (!card) return;   // ignore locked/coming-soon
  unlockAudio(); syncLoadout();
  selectedGame = card.dataset.game || '2v2';
  closeGameSelect();
  if (gameSelectMode === 'setup') { pendingPartyApply = true; sendMsg({ type: 'createRoom' }); } // → roomJoined applies picks
  else { sendMsg({ type: 'ready' }); toast('מתחילים…'); }
});
// Once the fresh party room is created (host), apply the picks: bots via addBot, real friends
// via inviteFriend. Called from the roomJoined handler.
function applyPartyPicks() {
  const byId = new Map(FRIENDS.map((f) => [f.userId, f]));
  for (const uid of partySel) {
    const f = byId.get(uid); if (!f) continue;
    if (f.isBot) sendMsg({ type: 'addBot', name: f.nickName });
    else sendMsg({ type: 'inviteFriend', toUserId: uid });
  }
  const n = partySel.size;
  toast(n ? `מזמין ${n} חברים…` : 'החדר מוכן — הזמינו חברים או התחילו');
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
      isRoomHost = !!msg.host;                 // #14: host gets approval + kick controls
      clearRoomRequests(); hideRoomWait();     // fresh room: no stale pending UI / waiting overlay
      clearLobbyLists(); resetPlayNow();
      if (msg.mode === 'quick') { quickVs = true; showScreen('home'); startLobbyMusic(); } // VS + countdown overlay drives the wait
      else { quickVs = false; hideVs(); showScreen('lobby'); startLobbyMusic(); }           // #12: lobby theme instantly
      if (pendingPartyApply && isRoomHost) { pendingPartyApply = false; applyPartyPicks(); } // add picked bots + invite friends
    } else if (msg.type === 'toHome') {
      if (msg.online != null) homeOnlineEl.textContent = msg.online;
      me = { playerId: null, team: null, char: chosenChar };
      clearRoomRequests(); hideRoomWait();   // #14: no stale host/joiner room UI back home
      quickVs = false; hideVs(); showScreen('home');
    } else if (msg.type === 'roomError') {
      quickVs = false; hideVs(); hideRoomWait();
      showRoomError(msg.msg || 'לא ניתן להצטרף לחדר');
      showScreen('home'); // create/join failed → land on the hub (room controls left the friends screen)
    } else if (msg.type === ROOM_MSG.PENDING) {          // #14 joiner: waiting for host approval
      roomCode = msg.code || roomCode;
      showRoomWait(msg.code);
    } else if (msg.type === ROOM_MSG.REJECTED) {         // #14 joiner: host declined / room full/closed
      hideRoomWait();
      toast(msg.reason === 'full' ? 'החדר מלא' : msg.reason === 'closed' ? 'החדר נסגר' : 'המארח דחה את הבקשה');
      showScreen('friends');
    } else if (msg.type === ROOM_MSG.KICKED) {           // #14: host removed me from the room
      hideRoomWait(); clearRoomRequests();
      me = { playerId: null, team: null, char: chosenChar };
      latest = null; snaps = []; predicted = null; rendered = null;
      quickVs = false; hideVs(); hideTeamIntro(); resetPlayNow(); stopMusic();
      toast('הוסרת מהחדר על ידי המארח');
      showScreen('home');
    } else if (msg.type === ROOM_MSG.JOIN_REQUEST) {     // #14 host: someone wants to join
      pendingReqs.set(msg.joinerId, { joinerId: msg.joinerId, userId: msg.userId || null, name: msg.name || 'שחקן', avatar: msg.avatar || null, cosmetic: msg.cosmetic, cards: msg.cards || [] });
      renderRoomRequests();
      toast('בקשת הצטרפות חדשה');
    } else if (msg.type === ROOM_MSG.JOIN_CANCELLED) {   // #14 host: that pending joiner left
      pendingReqs.delete(msg.joinerId);
      renderRoomRequests();
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
      renderPartyInvite();                 // party lobby: refresh who's invitable
    } else if (msg.type === 'partyInvite') {
      showPartyInvite(msg.code, msg.fromName || 'חבר');
    } else if (msg.type === 'partyInviteSent') {
      toast('ההזמנה נשלחה');
    } else if (msg.type === 'partyInviteAccepted') {
      toast(`${msg.name || 'חבר'} הצטרף`);
      renderPartyInvite();
    } else if (msg.type === 'partyError') {
      toast(msg.msg || 'ההזמנה נכשלה');
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
  clearRoomRequests(); hideRoomWait();   // #14: drop any host/joiner room UI as the match starts
  if (msg.settings) { Object.assign(settings, msg.settings); syncSliderUI(); }
  // apply this player's saved difficulty LEVEL to the match room
  if (diffLevel !== DEFAULT_LEVEL && ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'settings', diffLevel }));
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
  // Field-builder match: server sends a custom arena layout — build the render/collision arena
  // from it (hard walls + bushes). Dry walls ride the snapshot as built walls. null otherwise.
  customArena = msg.arena ? buildArenaFromField(msg.arena) : null;
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
  clearRoomRequests();
  startLobbyMusic(); // #12: rematch lobby gets the waiting theme right away (was silent)
  showScreen('lobby');
  resetPlayNow();
}

// #17: always-available "back to lobby" (חזרה ללובי). Leave the current match / room /
// training cleanly and return to the home hub. `leaveRoom` is the server's catch-all (it
// removes me from the room/match and answers with `toHome`); we also navigate locally so
// the exit feels instant even before that reply lands.
function leaveToLobby() {
  sendMsg({ type: 'leaveRoom' });
  quickVs = false; hideVs(); hideTeamIntro(); hideRoomWait(); clearRoomRequests();
  me = { playerId: null, team: null, char: chosenChar };
  latest = null; snaps = []; predicted = null; rendered = null;
  resetPlayNow();
  stopMusic();
  showScreen('home'); // startHomeMusic() fires here (quickVs is false)
}

// ---- Team intro overlay + match roster --------------------------------------
let matchRoster = [];        // [{id,name,avatar,team,cards}] from matchStart (humans)
let audienceReady = false;   // seat layout rebuilt per match (see drawAudience)
let crowdHypeT = -1e9;        // timestamp of the last goal — the crowd erupts (leaps) then settles
const teamIntroEl = document.getElementById('team-intro');
const tiCountEl = document.getElementById('ti-count');
let introTimer = null;
// quickVs is declared above the startup init block (hoisted to avoid a load-time TDZ:
// showScreen('home') reads it for the lobby-music gate before this point would run).
function hideVs() { if (tiCountEl) tiCountEl.classList.add('hidden'); hideTeamIntro(); }
// Quick-match VS screen: HOME (my team) vs RIVALS from lobby members (bots fill empty
// slots), with the big 5..0 countdown. Refreshed on every lobby payload.
function updateVsCountdown(msg) {
  if (!teamIntroEl) return;
  // #18: the server previews the bots that will fill the empty slots (msg.bots — each with team +
  // loadout + cards), so opponents show WITH their power cards during the wait/countdown, not only at
  // the pre-kickoff reveal. fillIntroCol already renders isBot rows + loadout art.
  const roster = (msg.members || []).concat(msg.bots || []);
  const mine = (roster.find((m) => m.id === myMemberId) || {}).team || 'A';
  const cols = teamIntroEl.querySelectorAll('.ti-col');
  fillIntroCol(cols[0], roster, mine);
  fillIntroCol(cols[1], roster, mine === 'A' ? 'B' : 'A');
  preloadCards(roster.flatMap((m) => introCardsFor(m)));
  startLobbyMusic(); // #12: lobby theme plays for the whole wait (starts on entry, loops through the countdown)
  if (msg.phase === 'countdown' && msg.countdown > 0) { tiCountEl.textContent = msg.countdown; tiCountEl.classList.remove('hidden'); }
  else { tiCountEl.classList.add('hidden'); }
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
// #18: the intro/countdown power cards for ONE participant. Prefer their EQUIPPED loadout
// (what they're actually running) — the server includes each BOT's synthesized loadout in
// the matchStart roster (players[].loadout, with isBot:true), so bots show their cards too —
// and fall back to a human's album top-3 if no loadout came through.
function introCardsFor(p) {
  if (!p) return [];
  // MY row: render straight from my LIVE equipped loadout — the same source the power-slots UI uses —
  // so the countdown always matches what's actually in my slots, even if the server echo lags a change
  // (or the join raced card-loading and stored an empty loadout). Same source as the matchStart reveal.
  if (p.id === myMemberId) return effectiveLoadout().filter(Boolean).map((s) => ({ r: s.r, n: +s.n }));
  if (Array.isArray(p.loadout)) return p.loadout.filter(Boolean).map((s) => ({ r: s.r, n: +s.n }));
  return rankCards(p.cards || []).slice(0, 3);
}
function fillIntroCol(colEl, players, team) {
  const rows = colEl.querySelector('.ti-rows'); rows.innerHTML = '';
  const roster = players.filter((p) => p.team === team);
  for (let i = 0; i < 2; i++) {
    const p = roster[i];
    const row = document.createElement('div'); row.className = 'ti-row';
    const av = document.createElement('div'); av.className = 'ti-av';
    const nm = document.createElement('div'); nm.className = 'ti-name';
    const cw = document.createElement('div'); cw.className = 'ti-cards';
    if (p) {
      const isBot = !!(p.isBot || p.bot) || !p.name;
      if (!isBot && p.avatar) av.style.backgroundImage = `url("${p.avatar}")`;
      else av.textContent = isBot ? '🤖' : memberInitials(p.name);
      nm.textContent = isBot ? (p.name || 'בוט') : (p.id === myMemberId ? `${p.name} (אני)` : p.name);
      introCardsFor(p).forEach((c) => cw.appendChild(introCardEl(c))); // bots included (#18)
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
  preloadCards(players.flatMap((p) => introCardsFor(p)));     // #18: bots' loadout art too
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
  // #14: host-only kick control (shown/wired per-update in updateLobbyUI). 4th child —
  // the [av,nm,st] destructure below stays valid.
  const kick = document.createElement('button'); kick.className = 'member-kick hidden'; kick.textContent = '✕'; kick.setAttribute('aria-label', 'הסרה מהחדר');
  row.append(av, nm, st, kick);
  memberRows.set(m.id, row);
  listEl.appendChild(row);
  return row;
}
function updateLobbyUI(msg) {
  roomMode = msg.mode || roomMode;
  if (msg.code) roomCode = msg.code;
  const isPrivate = msg.mode === 'private';
  const wasHost = isRoomHost;
  isRoomHost = !!(isPrivate && msg.host && msg.host === myMemberId); // #14: host controls (approval + kick), tracks host hand-off
  if (isRoomHost !== wasHost) renderRoomRequests();                  // re-render only when host status flips (not every 5Hz tick)
  lobbyOnlineEl.textContent = msg.online;
  lobbyTitleEl.innerHTML = `<span></span> ${isPrivate ? 'חדר פרטי' : 'משחק מהיר'} <span></span>`;
  lobbyCodeWrap.classList.toggle('hidden', !isPrivate);
  if (isPrivate && msg.code) lobbyCodeEl.textContent = msg.code;
  // Team picking + PLAY NOW are private-room only; quick match auto-teams + auto-starts.
  joinBtn.A.style.display = isPrivate ? '' : 'none';
  joinBtn.B.style.display = isPrivate ? '' : 'none';
  // Party flow: the HOST starts via the game picker ("בחר משחק"); play-now is superseded for
  // private rooms. Non-host members wait for the host to pick.
  const pickGameBtn = document.getElementById('pick-game-btn');
  playNowBtn.style.display = 'none';
  if (pickGameBtn) {
    pickGameBtn.style.display = (isPrivate && isRoomHost) ? '' : 'none';
    const sp = pickGameBtn.querySelector('span');
    if (sp) sp.textContent = selectedGame ? 'התחל · 2 נגד 2' : 'בחר משחק'; // game pre-chosen in setup → start CTA
  }
  lobbyHintEl.textContent = !isPrivate
    ? 'מחפש שחקנים… המשחק יתחיל אוטומטית.'
    : isRoomHost
      ? 'הזמינו חברים מחוברים, בחרו קבוצות, ואז «בחר משחק». מקומות פנויים יתמלאו בבוטים.'
      : 'ממתינים שהמארח יבחר משחק… בחרו קבוצה בינתיים.';
  renderPartyInvite();

  startLobbyMusic(); // #12: lobby theme plays for the whole wait (starts on entry, loops through the countdown)
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
    const label = m.id === myMemberId ? `${m.name} (אני)` : m.name;
    if (nm.textContent !== label) nm.textContent = label;
    st.textContent = m.inMatch ? '● במשחק' : '';
    row.classList.toggle('is-me', m.id === myMemberId);
    const kick = row.children[3];
    if (kick) {
      const canKick = isRoomHost && m.id !== myMemberId;   // #14: host removes already-joined players
      kick.classList.toggle('hidden', !canKick);
      kick.onclick = canKick ? () => kickMember(m.id) : null;
    }
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

// #8: mirror shared/sim.js clampXYToArea — the walkable area is the pitch PLUS the two goal
// net-pockets reachable through the mouth, so the local prediction lets the player walk INTO
// the goal instead of rubber-banding at the goal line. Keep in sync with the sim.
function clampToPlayArea(x, y, r) {
  const x1 = clamp(x, r, FIELD.W - r), y1 = clamp(y, r, FIELD.H - r);                                          // the pitch
  const x2 = clamp(x, r - GOAL.depth, FIELD.W - r + GOAL.depth), y2 = clamp(y, GOAL_TOP + r, GOAL_BOTTOM - r); // mouth band into both pockets
  const d1 = (x - x1) * (x - x1) + (y - y1) * (y - y1);
  const d2 = (x - x2) * (x - x2) + (y - y2) * (y - y2);
  return d1 <= d2 ? { x: x1, y: y1 } : { x: x2, y: y2 };
}
// Advance the local prediction one input step, easing velocity like the sim.
function stepPrediction(moveX, moveY, dt) {
  let mx = moveX, my = moveY;
  const len = Math.hypot(mx, my);
  if (len > 1) { mx /= len; my /= len; }
  const tvx = mx * ownSpeed(), tvy = my * ownSpeed();
  predVel.x += (tvx - predVel.x) * MOVE_ACCEL;
  predVel.y += (tvy - predVel.y) * MOVE_ACCEL;
  const r = ownRadius();
  const c = clampToPlayArea(predicted.x + predVel.x * dt, predicted.y + predVel.y * dt, r);
  predicted.x = c.x; predicted.y = c.y;
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
  if (e.key === ' ') { if (aimPulled() || currentCharge() < QUICK_CHARGE) releaseShot(); else cancelCharge(); } // aimed OR quick tap fires; a long no-aim hold does nothing
  if (e.key.toLowerCase() === 'q') { if (currentWindup() >= 1) releaseBuild(); else cancelBuild(); } // release builds in facing dir; early = cancel
});

let mouse = { x: 0, y: 0, down: false };
const canvas = document.getElementById('canvas');
// #1 ROOT CAUSE of the "quick shot out of nowhere": iOS/WKWebView synthesises mouse
// events (mousedown/mouseup) ~300ms AFTER a touch that didn't preventDefault. Those
// phantom clicks land on the right half of the pitch, so mousedown->beginCharge() +
// mouseup->(aimPulled? releaseShot()) fired a real bullet with no deliberate input.
// Touch drives its own charge/aim path (see the joystick handlers), so on a touch
// device the mouse listeners must NOT run at all. Desktop never sets usingTouch.
canvas.addEventListener('mousemove', (e) => { if (usingTouch) return; mouse.x = e.clientX; mouse.y = e.clientY; });
// Tap an ad board (off-pitch perimeter) → ask the app to open its link. World-space
// hit-test via the flip-aware screenToWorld, so it works for both teams' mirrored views.
function adBoardAt(clientX, clientY) {
  if (!_adBoardRects.length) return null;
  const w = screenToWorld(clientX, clientY);
  for (const b of _adBoardRects) if (w.x >= b.x0 && w.x <= b.x1 && w.y >= b.y0 && w.y <= b.y1) return b;
  return null;
}
function openAd(board) {
  playSound('ui', 0.5);
  try { window.ReactNativeWebView?.postMessage(JSON.stringify({ t: 'openAd', link: board.link })); } catch { /* not in app */ }
}
canvas.addEventListener('mousedown', (e) => {
  if (usingTouch) return;                                                     // ignore synthesized-from-touch mouse events
  const ad = adBoardAt(e.clientX, e.clientY); if (ad) { openAd(ad); return; } // board tap, not a shot
  if (e.button === 2) { specialQueued = true; specialAim = { x: 0, y: 0 }; }   // right-click = special, feet plant
  else { mouse.down = true; beginCharge(); }       // hold left-click to charge
});
addEventListener('mouseup', (e) => { if (usingTouch) return; if (mouse.down && e.button !== 2) { if (aimPulled() || currentCharge() < QUICK_CHARGE) releaseShot(); else cancelCharge(); } mouse.down = false; }); // aimed OR quick tap fires; a long no-aim hold does nothing
addEventListener('contextmenu', (e) => e.preventDefault());

// Special-skill button (touch + click)
const specialBtn = document.getElementById('special');
const pauseBtn = document.getElementById('pause-btn');
const soundBtn = document.getElementById('sound-btn');
const leaveLobbyBtn = document.getElementById('leave-lobby-btn'); // #17
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
// Difficulty LADDER selector — a level index (enemy + partner skill live in shared/difficulty.js).
// Persists locally, pushed live to the authoritative server.
let diffLevel = (() => { try { return clampLevel(parseInt(localStorage.getItem('pikme-diff-level'), 10)); } catch { return DEFAULT_LEVEL; } })();
const diffContainer = document.getElementById('difficulty');
const diffBtns = [];
if (diffContainer) {
  diffContainer.innerHTML = '';
  DIFFICULTY_LEVELS.forEach((lvl) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'diff-btn' + (lvl.enemy >= 0.95 ? ' diff-extreme' : '');
    b.dataset.level = lvl.id;
    b.innerHTML = `<span class="diff-name">${lvl.name}</span><span class="diff-hint">${lvl.hint}</span>`;
    b.addEventListener('click', () => setDifficulty(lvl.id));
    diffContainer.appendChild(b);
    diffBtns.push(b);
  });
}
function syncDifficultyUI() { for (const b of diffBtns) b.classList.toggle('active', +b.dataset.level === diffLevel); }
function setDifficulty(i) {
  diffLevel = clampLevel(i);
  try { localStorage.setItem('pikme-diff-level', String(diffLevel)); } catch { /* private mode */ }
  syncDifficultyUI();
  playSound('ui', 0.5, 1.05);
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'settings', diffLevel }));
}
syncDifficultyUI();

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
// #15: click the dark backdrop (outside the settings card) to close — no ✕ button.
settingsPanel.addEventListener('click', (e) => { if (e.target === settingsPanel) closeSettings(); });
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
const STICK_MAX = 52;              // knob travel for the default 120px stick box
const STICK_RATIO = STICK_MAX / 120; // keep travel proportional when the stick is resized
const touchL = { id: null, cx: 0, cy: 0, dx: 0, dy: 0, max: STICK_MAX };
const touchR = { id: null, cx: 0, cy: 0, dx: 0, dy: 0, active: false, max: STICK_MAX };
let usingTouch = false;

// ---- Customisable control layout (Brawl-Stars-style "edit controls") --------
// Persisted per control: {cx,cy = CENTER as fraction of viewport, size = px, locked}.
// A `locked` control renders at a FIXED anchor and no longer floats to the touch.
const CTL_DEFAULTS = { move: { size: 120 }, aim: { size: 120 }, bomb: { size: 82 }, wall: { size: 58 } };
let ctlLayout = loadCtlLayout();
function loadCtlLayout() { try { return JSON.parse(localStorage.getItem('fbControls')) || {}; } catch { return {}; } }
function saveCtlLayout() { try { localStorage.setItem('fbControls', JSON.stringify(ctlLayout)); } catch { /* private mode */ } }
// Resolve a locked control to live screen px, or null if it's still floating/default.
function ctlPx(c) {
  const L = ctlLayout[c]; if (!L || !L.locked) return null;
  return { x: L.cx * innerWidth, y: L.cy * innerHeight, size: L.size || CTL_DEFAULTS[c].size };
}
function stickSize(c) { const p = ctlPx(c); return p ? p.size : CTL_DEFAULTS[c].size; }
function stickMax(c) { return stickSize(c) * STICK_RATIO; }
function stickLocked(c) { const L = ctlLayout[c]; return !!(L && L.locked); }

// Apply the saved layout: size both sticks; position+size the two skill buttons.
function applyCtlLayout() {
  stickL.style.width = stickL.style.height = `${stickSize('move')}px`;
  stickR.style.width = stickR.style.height = `${stickSize('aim')}px`;
  for (const [c, el] of [['bomb', specialBtn], ['wall', buildBtn]]) {
    const p = ctlPx(c); if (!p || !el) continue;
    el.style.left = `${Math.round(p.x - p.size / 2)}px`;
    el.style.top = `${Math.round(p.y - p.size / 2)}px`;
    el.style.right = 'auto'; el.style.bottom = 'auto';
    el.style.width = el.style.height = `${p.size}px`;
    el.style.fontSize = `${Math.round(p.size * 0.48)}px`;
  }
}

function placeStick(el, cx, cy, dx, dy) {
  el.classList.remove('hidden');
  const half = el.offsetWidth / 2 || 60;
  el.style.left = `${cx - half}px`;
  el.style.top = `${cy - half}px`;
  el.querySelector('.knob').style.transform = `translate(${dx}px, ${dy}px)`;
}

addEventListener('touchstart', (e) => {
  usingTouch = true;
  // Only claim touches as joystick/aim input while the GAME screen is up. Off the pitch (hub,
  // lobby, friends), returning here lets native touch scroll the games strip + tap hub buttons —
  // the global joystick-claim + touchmove preventDefault was eating the #play-strip swipe.
  if (gameEl.classList.contains('hidden')) return;
  if (!settingsPanel.classList.contains('hidden')) return; // paused: ignore game touches
  if (editingControls) return; // the layout editor owns all touches while open
  for (const t of e.changedTouches) {
    if (specialBtn.contains(t.target) || pauseBtn.contains(t.target) || soundBtn.contains(t.target) || (buildBtn && buildBtn.contains(t.target)) || (leaveLobbyBtn && leaveLobbyBtn.contains(t.target))) continue; // buttons aren't sticks
    const ad = adBoardAt(t.clientX, t.clientY); if (ad) { openAd(ad); continue; } // board tap, not a stick
    const which = claimStick(t);
    if (which === 'L' && touchL.id === null) {
      // Locked move stick: snap the base to its fixed anchor (touch anywhere in the
      // zone still drives it, delta measured from the anchor). Floating: base = touch.
      const a = stickLocked('move') ? ctlPx('move') : null;
      touchL.id = t.identifier; touchL.cx = a ? a.x : t.clientX; touchL.cy = a ? a.y : t.clientY;
      touchL.dx = 0; touchL.dy = 0; touchL.max = stickMax('move');
      placeStick(stickL, touchL.cx, touchL.cy, 0, 0);
    } else if (which === 'R' && touchR.id === null) {
      const a = stickLocked('aim') ? ctlPx('aim') : null;
      touchR.id = t.identifier; touchR.cx = a ? a.x : t.clientX; touchR.cy = a ? a.y : t.clientY;
      touchR.dx = 0; touchR.dy = 0; touchR.active = true; touchR.aimedOut = false; touchR.max = stickMax('aim');
      placeStick(stickR, touchR.cx, touchR.cy, 0, 0);
      beginCharge(); // start charging as soon as you touch the aim stick
    }
  }
}, { passive: false });

// Which stick a fresh touch controls. A locked stick claims touches that land near
// its fixed anchor; otherwise fall back to the screen-half rule (floating sticks).
function claimStick(t) {
  const near = (c) => { const p = ctlPx(c); return p && Math.hypot(t.clientX - p.x, t.clientY - p.y) <= p.size * 0.9; };
  if (stickLocked('move') && near('move')) return 'L';
  if (stickLocked('aim') && near('aim')) return 'R';
  return t.clientX < innerWidth / 2 ? 'L' : 'R';
}

addEventListener('touchmove', (e) => {
  let gameTouch = false;
  for (const t of e.changedTouches) {
    if (t.identifier === touchL.id) { updateStick(touchL, stickL, t); gameTouch = true; }
    else if (t.identifier === touchR.id) { updateStick(touchR, stickR, t); gameTouch = true; }
  }
  if (gameTouch) e.preventDefault(); // stop iOS text-selection/scroll during a stick drag (NOT slider/settings drags)
}, { passive: false });

function updateStick(stick, el, t) {
  let dx = t.clientX - stick.cx, dy = t.clientY - stick.cy;
  const len = Math.hypot(dx, dy);
  const max = stick.max || STICK_MAX;
  if (len > max) { dx = dx / len * max; dy = dy / len * max; }
  stick.dx = dx; stick.dy = dy;
  if (Math.hypot(dx, dy) > AIM_DEADZONE_PX) stick.aimedOut = true; // latch: player deliberately aimed
  el.querySelector('.knob').style.transform = `translate(${dx}px, ${dy}px)`;
}

addEventListener('touchend', (e) => {
  for (const t of e.changedTouches) {
    if (t.identifier === touchL.id) {
      // Left stick is MOVE: just stop.
      touchL.id = null; touchL.dx = 0; touchL.dy = 0; stickL.classList.add('hidden');
    }
    else if (t.identifier === touchR.id) {
      // Right stick is AIM/SHOOT:
      //  - pulled OUT on release  -> fire in that direction (aimed shot)
      //  - a TAP / centred hold    -> fire a QUICK shot (the sim auto-aims it; guide showed where)
      //  - pulled out THEN dragged back into the deadzone -> deliberate CANCEL (no shot)
      if (Math.hypot(touchR.dx, touchR.dy) > AIM_DEADZONE_PX) releaseShot({ x: touchR.dx, y: touchR.dy }); // aimed -> fire in that dir
      else if (touchR.aimedOut) cancelCharge();                            // pulled out then back in -> deliberate cancel
      else if (currentCharge() < QUICK_CHARGE) releaseShot();              // a short no-aim TAP -> quick auto-aimed shot
      else cancelCharge();                                                 // a LONG no-aim press does NOTHING (charged shots need aim)
      touchR.id = null; touchR.dx = 0; touchR.dy = 0; touchR.active = false; touchR.aimedOut = false; stickR.classList.add('hidden');
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

// ---- Control-layout editor (training only, Brawl-Stars "edit controls") -----
let editingControls = false;
const editBtn = document.getElementById('edit-controls-btn');
const ceOverlay = document.getElementById('controls-editor');
const cePucks = ceOverlay ? [...ceOverlay.querySelectorAll('.ce-puck')] : [];
let ceDraft = {}; // working copy while the editor is open

// Where each control sits by default (as viewport fractions), used to seed the
// editor before the player has customised anything. Mirrors the CSS defaults.
function defaultCtlDraft(c) {
  const s = CTL_DEFAULTS[c].size, w = innerWidth, h = innerHeight;
  if (c === 'move') return { cx: 110 / w, cy: (h - 110) / h, size: s };
  if (c === 'aim')  return { cx: (w - 110) / w, cy: (h - 110) / h, size: s };
  if (c === 'bomb') return { cx: (w - 112 - 41) / w, cy: (h - 88 - 41) / h, size: s };
  return { cx: (w - 124 - 29) / w, cy: (h - 182 - 29) / h, size: s }; // wall
}
function layoutPucks() {
  for (const puck of cePucks) {
    const d = ceDraft[puck.dataset.ctl];
    puck.style.width = puck.style.height = `${d.size}px`;
    puck.style.left = `${d.cx * innerWidth - d.size / 2}px`;
    puck.style.top = `${d.cy * innerHeight - d.size / 2}px`;
  }
}
function openControlsEditor() {
  if (!ceOverlay) return;
  editingControls = true;
  ceDraft = {};
  for (const c of ['move', 'aim', 'bomb', 'wall']) {
    const p = ctlPx(c);
    ceDraft[c] = p ? { cx: p.x / innerWidth, cy: p.y / innerHeight, size: p.size } : defaultCtlDraft(c);
  }
  layoutPucks();
  ceOverlay.classList.remove('hidden');
  stickL.classList.add('hidden'); stickR.classList.add('hidden'); // no live sticks during edit
}
function closeControlsEditor() { editingControls = false; if (ceOverlay) ceOverlay.classList.add('hidden'); }

// Drag a puck to move; drag its corner handle to resize.
for (const puck of cePucks) {
  const c = puck.dataset.ctl;
  const handle = puck.querySelector('.ce-resize');
  let mode = null, sx = 0, sy = 0, sSize = 0, sCx = 0, sCy = 0;
  puck.addEventListener('pointerdown', (e) => {
    e.preventDefault(); e.stopPropagation();
    try { puck.setPointerCapture(e.pointerId); } catch { /* older webview */ }
    mode = (e.target === handle) ? 'resize' : 'move';
    sx = e.clientX; sy = e.clientY; sSize = ceDraft[c].size; sCx = ceDraft[c].cx; sCy = ceDraft[c].cy;
    puck.classList.add('dragging');
  });
  puck.addEventListener('pointermove', (e) => {
    if (!mode) return;
    if (mode === 'move') {
      const half = ceDraft[c].size / 2;
      const nx = sCx * innerWidth + (e.clientX - sx), ny = sCy * innerHeight + (e.clientY - sy);
      ceDraft[c].cx = clamp(nx, half, innerWidth - half) / innerWidth;
      ceDraft[c].cy = clamp(ny, half, innerHeight - half) / innerHeight;
    } else {
      const isBtn = (c === 'bomb' || c === 'wall');
      const d = Math.max(e.clientX - sx, e.clientY - sy);
      ceDraft[c].size = clamp(sSize + d, isBtn ? 44 : 80, isBtn ? 130 : 190);
    }
    layoutPucks();
  });
  const end = () => { mode = null; puck.classList.remove('dragging'); };
  puck.addEventListener('pointerup', end);
  puck.addEventListener('pointercancel', end);
}

document.getElementById('ce-save')?.addEventListener('click', () => {
  for (const c of ['move', 'aim', 'bomb', 'wall']) ctlLayout[c] = { ...ceDraft[c], locked: true };
  saveCtlLayout(); applyCtlLayout(); closeControlsEditor();
});
document.getElementById('ce-cancel')?.addEventListener('click', closeControlsEditor);
document.getElementById('ce-reset')?.addEventListener('click', () => {
  ctlLayout = {}; saveCtlLayout();
  // wipe inline styles so the CSS defaults (and floating sticks) come back
  for (const el of [specialBtn, buildBtn]) {
    if (!el) continue;
    for (const p of ['left', 'top', 'right', 'bottom', 'width', 'height', 'fontSize']) el.style[p] = '';
  }
  stickL.style.width = stickL.style.height = ''; stickR.style.width = stickR.style.height = '';
  closeControlsEditor();
});
editBtn?.addEventListener('click', openControlsEditor);

applyCtlLayout();                       // apply any saved layout on load
addEventListener('resize', applyCtlLayout); // keep locked px in sync with orientation

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
    moveX = touchL.dx / touchL.max; moveY = touchL.dy / touchL.max;
    aimX = touchR.dx / touchR.max; aimY = touchR.dy / touchR.max;
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
  // #6/#11: the client sends its aim vector (needed for CHARGED shots + the aim line + wall
  // build). For a QUICK shot the SIM decides the aim server-side (goal if carrying, else the
  // nearest enemy, with the snooker-angle impulse) and may IGNORE this vector. We deliberately
  // do NOT compute quick-shot aim here — leaving that to the sim agent (do not add it client-side).
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
const CAM_ZOOM = 1.65;               // #7: world-view zoom (ART px/world, before ART_PX). Lower = wider view so the goal NET is framed when near a goal. Was 1.85.
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
const NET = GOAL.depth;     // gameplay net-pocket depth (matches the sim: ball + players)
const NET_VIS = 170;        // DEEPER visual net drawn behind the goal line (decoration only; must be <= BACK)
// --- Stadium seating ----------------------------------------------------------
// Every side of the bowl is exactly THREE rows of stadium seats deep. One card
// spectator sits in one seat (some seats stay empty). These sizes drive the seat
// grid, the terrace depth (draw), and how far the camera may pan past a wall.
// Compact seat GRID (tight pitch) with a fixed, larger CARD drawn on top of each seat,
// so the album packs a big ~800-seat bowl of overlapping card art. cardW/cardH is the
// shared spectator size — the front-row PLAYER cards use the same size (see drawPlayerSeats).
// Each SEAT cell is the full size of an audience card (req: "each seat = size of the
// audience card") — cards fill their seat 1:1 with a small gap, no overlap-packing.
const AUD = { seatW: 72, seatH: 92, gapX: 6, gapY: 8, capPerCard: 12, capTotal: 800, cardW: 72, cardH: 92 };
const ROWS = 3;                       // stand depth: exactly THREE rows of seats per side
const ROW_X = AUD.seatW + AUD.gapX;   // behind-goal row pitch (rows stack along X)
const ROW_Y = AUD.seatH + AUD.gapY;   // touchline  row pitch (rows stack along Y)
const LANE = 56;                      // clear perimeter lane (ad boards) between the pitch and the front seat row
const BAND = ROWS * ROW_Y + LANE;     // touchline terrace depth = 3 rows + the board lane
const BACK = ROWS * ROW_X + LANE;     // behind-goal terrace = 3 rows + lane, measured FROM the goal line
// Camera limit: reveal the wall/net plus up to HALF of the third (back) row, then stop.
const CAM_BAND = 2.5 * ROW_Y + LANE;
const CAM_BACK = 2.5 * ROW_X + LANE;

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
  // #7: eased the zoom out a touch (CAM_ZOOM 1.85 -> 1.65) so the goal net/area frames
  // in view when a player is near a goal instead of sitting clipped at the screen edge.
  scale = CAM_ZOOM * wbW / FIELD.W;
  bgCanvas.width = Math.ceil((FIELD.W + 2 * BACK) * scale);
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
  // Req1 — GOAL-LEAD: as the player approaches either goal line, push the camera target
  // PAST the player toward that goal so more of the goal + net is revealed. The lead ramps
  // up over the final LEAD_ZONE of the pitch and is bounded by the CAM_BACK clamp below, so
  // it can never over-pan past half of the back (3rd) row.
  const LEAD_ZONE = FIELD.W * 0.32, LEAD_MAX = NET + CAM_BACK * 0.6;
  let lead = 0;
  if (cx < LEAD_ZONE) lead = -(1 - cx / LEAD_ZONE) * LEAD_MAX;                 // near left goal → pan left
  else if (cx > FIELD.W - LEAD_ZONE) lead = (1 - (FIELD.W - cx) / LEAD_ZONE) * LEAD_MAX; // near right goal → pan right
  // Req2 — CLAMP: reveal the wall/net plus AT MOST half of the third (back) row, then stop.
  // CAM_BACK/CAM_BAND = 2.5 rows + board lane (half of the 3rd row exposed).
  const minX = -CAM_BACK * scale, maxX = (FIELD.W + CAM_BACK) * scale - wbW;
  const tX = clamp((cx + lead) * scale - wbW / 2, minX, Math.max(minX, maxX));
  const fieldHpx = FIELD.H * scale, worldHpx = (FIELD.H + 2 * CAM_BAND) * scale;
  const minY = -CAM_BAND * scale, maxY = (FIELD.H + CAM_BAND) * scale - wbH;
  const tY = worldHpx <= wbH ? (fieldHpx - wbH) / 2 : clamp(cy * scale - wbH / 2, minY, Math.max(minY, maxY)); // whole bowl fits -> centre
  const EASE = 0.22;
  if (Math.abs(tX - camX) > wbW * 0.6 || Math.abs(tY - camY) > wbH * 0.6) { camX = tX; camY = tY; }
  else { camX += (tX - camX) * EASE; camY += (tY - camY) * EASE; }
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
// wx/wy produce bg-local coords (bg pixel 0,0 = world (-BACK, -BAND)).
function renderBackground() {
  const sx = camX, sy = camY, sctx = ctx;
  camX = -BACK * scale; camY = -BAND * scale; ctx = bgCtx;
  try {
    bgCtx.clearRect(0, 0, bgCanvas.width, bgCanvas.height);
    drawStands();
    drawSeatChairs(); // empty stadium seats — static furniture; card spectators bob on top later
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
  drawFanWall(-BACK, 0, 0, FIELD.H, cA);                          // behind A's (left) goal — deep end terrace
  drawFanWall(FIELD.W, 0, FIELD.W + BACK, FIELD.H, cB);           // behind B's (right) goal — deep end terrace
  // Split each side terrace at halfway so every team's colours fill its own half.
  drawFanWall(-BACK, -BAND, midX, 0, cA);                         // top,    home half
  drawFanWall(midX, -BAND, FIELD.W + BACK, 0, cB);                // top,    away half
  drawFanWall(-BACK, FIELD.H, midX, FIELD.H + BAND, cA);          // bottom, home half
  drawFanWall(midX, FIELD.H, FIELD.W + BACK, FIELD.H + BAND, cB); // bottom, away half
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
// The empty stadium seats are baked into the STATIC background (drawSeatChairs); the
// card spectators sit in those seats and BOB per-frame as animated layers on top —
// the local player's own album on their side (home), pooled on the far side.
// The crowd animates as offscreen layers, one per WAVE COLUMN (a narrow vertical slice of the
// bowl along X, ~2 seats wide). Each column has its OWN out-of-phase bob (so columns jump
// ASYNCHRONOUSLY, not as one block) plus a wave-phase that steps across X to roll a travelling
// MEXICAN WAVE. 12 columns ≈ 12 drawImage/frame (was 6 — still light).
const N_LAYERS = 12;                        // = wave columns
// Per-column bob params — pseudo-random-ish freq/phase/amp so no two columns sync up.
const LAYERS = Array.from({ length: N_LAYERS }, (_, i) => ({
  fy: 8 + (i * 2.7 % 5), phy: i * 1.7, ay: 16 + (i % 4) * 6,      // vertical jump: fast, varied
  fx: 4.5 + (i % 3) * 0.9, phx: i * 2.7 + 1, ax: 0.6 + (i % 2) * 0.8, // slight side sway
}));
let audSeats = [];
// The crowd is filled from ALL players' cards (see the fill block below + allCards): highest
// rarity in the front rows, seated from my side + position outward until the cards run out.
function buildAudienceSeats() {
  audSeats = [];
  const midX = FIELD.W / 2;
  const cA = teamColor('A'), cB = teamColor('B');
  // NO seats directly behind the net: clear the goal-mouth band plus a TWO-SEAT gap on each
  // side, so behind-goal seats sit only on the FLANKS, next to the net (never behind it).
  const gapY = 2 * ROW_Y;
  const clrTop = GOAL_TOP - gapY, clrBot = GOAL_BOTTOM + gapY;
  // Each section: [x0,y0,x1,y1, ax, ay, color]. ax/ay anchor the seat block in the region:
  //   'lo' flush to x0/y0, 'hi' flush to x1/y1, 'mid' centred.
  // Team 'A' owns the LEFT half of the bowl, 'B' the RIGHT half (split at midX). Each seat is
  // tagged with its team so the fill can populate MY side from my album and the away side
  // separately (see the fill block below).
  const sections = [
    // TOUCHLINES (rows stack in Y): centred along X, anchored toward the pitch.
    [-BACK, -BAND, midX, 0, 'mid', 'hi', 'A'], [midX, -BAND, FIELD.W + BACK, 0, 'mid', 'hi', 'B'],                                  // top
    [-BACK, FIELD.H, midX, FIELD.H + BAND, 'mid', 'lo', 'A'], [midX, FIELD.H, FIELD.W + BACK, FIELD.H + BAND, 'mid', 'lo', 'B'],     // bottom
    // BEHIND-GOAL FLANKS (rows stack in X): flush to the goal line, anchored TOWARD the net
    // (the 2-seat gap to the net is held by clrTop/clrBot). None sit behind the net.
    [-BACK, 0, 0, clrTop, 'hi', 'hi', 'A'], [-BACK, clrBot, 0, FIELD.H, 'hi', 'lo', 'A'],                                           // left goal flanks
    [FIELD.W, 0, FIELD.W + BACK, clrTop, 'lo', 'hi', 'B'], [FIELD.W, clrBot, FIELD.W + BACK, FIELD.H, 'lo', 'lo', 'B'],             // right goal flanks
  ];
  const gap = 2;
  for (const [x0, y0, x1, y1, ax, ay, team] of sections) {
    const color = team === 'A' ? cA : cB;
    const rw = x1 - x0, rh = y1 - y0;
    if (rw < ROW_X * 0.6 || rh < ROW_Y * 0.6) continue; // skip a flank too thin for even one row
    // Depth from the pitch: touchlines stack in rows (Y), flanks in cols (X).
    const isEnd = x1 <= 0 || x0 >= FIELD.W;
    // Rows deep = the SEATABLE depth (region minus the board LANE) / pitch → still ~3 rows.
    const cols = Math.max(1, Math.round((isEnd ? rw - LANE : rw) / ROW_X));
    const rows = Math.max(1, Math.round((isEnd ? rh : rh - LANE) / ROW_Y));
    const usedW = cols * AUD.seatW + (cols - 1) * AUD.gapX;
    const usedH = rows * AUD.seatH + (rows - 1) * AUD.gapY;
    // The anchor (ax/ay) points TOWARD the pitch, so the anchored end holds the front row.
    const depthN = isEnd ? cols : rows;
    const nearHigh = isEnd ? ax === 'hi' : ay === 'hi';
    // Hold the front row back from the pitch by LANE, so the perimeter LED boards sit in a
    // clean lane BETWEEN the field and the crowd (not on top of the front seats).
    const gx = isEnd ? LANE : gap;   // flanks are depth-in-X → inset toward the goal line
    const gy = isEnd ? gap : LANE;   // touchlines are depth-in-Y → inset toward the touchline
    const ox = ax === 'lo' ? x0 + gx : ax === 'hi' ? x1 - usedW - gx : x0 + (rw - usedW) / 2;
    const oy = ay === 'lo' ? y0 + gy : ay === 'hi' ? y1 - usedH - gy : y0 + (rh - usedH) / 2;
    const seats = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const idx = isEnd ? c : r;
      const rank = nearHigh ? idx : depthN - 1 - idx;   // 0 = back row, depthN-1 = front (nearest pitch)
      const nf = depthN > 1 ? rank / (depthN - 1) : 1;  // 0 far .. 1 near
      // Front rows draw LAST (higher layer = on top) and brick-stagger by half a pitch on
      // alternate rows → a packed stand receding upward, not a flat grid.
      let sx = ox + c * ROW_X, sy = oy + r * ROW_Y;
      if (rank % 2 === 1) { if (isEnd) sy += ROW_Y * 0.5; else sx += ROW_X * 0.5; }
      // Layer = wave-column by WORLD-X: drives both the async per-column bob and the travelling
      // wave (adjacent columns are out of phase, so the crowd never moves as one flat block).
      const wcol = clamp(Math.round((sx + BACK) / (FIELD.W + 2 * BACK) * (N_LAYERS - 1)), 0, N_LAYERS - 1);
      audSeats.push({ x: sx, y: sy, r: null, n: null, color, team, nf, layer: wcol });
    }
  }
  // FILL: scatter cards RANDOMLY across the WHOLE bowl and fill as many seats as possible — if
  // the album is smaller than the bowl the pool CYCLES so the stands still read full (a real
  // crowd is the same faces repeated), rather than a sparse cluster on one side.
  const pool = allCards();     // every player's cards, duplicates expanded
  if (pool.length) {
    const order = audSeats.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; const t = order[i]; order[i] = order[j]; order[j] = t; } // shuffle seats
    for (let k = 0; k < order.length; k++) { const s = audSeats[order[k]], c = pool[k % pool.length]; s.r = c.r; s.n = c.n; }
  }
  audSeats.sort((a, b) => a.nf - b.nf);      // bake far → near so front cards overlap on top
  preloadCards(pool);
}
// Every card in the match as INDIVIDUAL fans, rarity-first. DUPLICATES COUNT: a card owned ×N
// takes N seats. My full album is ALWAYS included (not just when the roster is empty — the
// training roster may carry a few bot cards, which must NOT replace my collection), plus every
// OTHER roster player's cards.
function allCards() {
  const bag = [];
  const push = (cards) => { for (const c of (cards || [])) { const copies = Math.max(1, c.c || 1); for (let k = 0; k < copies; k++) bag.push(c); } };
  push(myCards());                                                    // my whole album, duplicates expanded
  for (const p of matchRoster) if (p.id !== myMemberId) push(p.cards); // + everyone else in the match
  bag.sort((a, b) => (RARITY_RANK[b.r] || 0) - (RARITY_RANK[a.r] || 0) || (b.w || 0) - (a.w || 0) || (b.c || 0) - (a.c || 0));
  return bag;
}
// The seated card's rect INSIDE a seat cell (px,py,cellW,cellH), in whatever pixel
// space the caller is in. Shared by drawSeat (the empty well) and bakeAudience (the
// card), so a spectator lands exactly in its seat.
function seatCardRect(px, py, cw, ch) {
  const padX = Math.round(cw * 0.15), padTop = Math.round(ch * 0.14), padBot = Math.round(ch * 0.12);
  return { x: px + padX, y: py + padTop, w: Math.max(2, cw - padX * 2), h: Math.max(2, ch - padTop - padBot) };
}
// One stadium seat: a moulded plastic bucket (team-coloured shell + darker well),
// drawn into the STATIC background. Card spectators bob on top of the well later.
// One moulded stadium seat, pixel-art style: a team-coloured BACKREST (upper) with a
// darker padded insert + rim light, a small seam, and a SEAT BASE below with its own
// highlight and under-shadow. Reads as a real flip-up bucket even when no card sits in it.
function drawSeat(x, y, w, h, col) {
  const ix = Math.round(x), iy = Math.round(y), cw = Math.max(3, Math.round(w)), ch = Math.max(3, Math.round(h));
  const g = Math.max(1, Math.round(cw * 0.12));                 // gap to the neighbouring seat
  const sx = ix + g, sy = iy + g, sw = cw - g * 2, sh = ch - g * 2;
  if (sw < 3 || sh < 3) return;
  const R = (a, b, ww, hh, c) => { ctx.fillStyle = c; ctx.fillRect(Math.round(a), Math.round(b), Math.max(1, Math.round(ww)), Math.max(1, Math.round(hh))); };
  const backH = Math.max(2, Math.round(sh * 0.58));
  // Backrest
  R(sx, sy, sw, backH, shade(col, 0.72));                                          // shell
  R(sx + sw * 0.15, sy + backH * 0.16, sw * 0.7, backH * 0.66, shade(col, 0.92));  // padded insert
  R(sx, sy, sw, sh * 0.05, 'rgba(255,255,255,.22)');                               // top rim light
  R(sx, sy + backH * 0.16, sw * 0.08, backH * 0.66, 'rgba(255,255,255,.10)');      // left edge sheen
  R(sx, sy + backH - sh * 0.04, sw, sh * 0.04, 'rgba(0,0,0,.30)');                 // seam under the backrest
  // Seat base
  const padY = sy + backH + Math.max(1, Math.round(sh * 0.03)), padH = sy + sh - padY;
  R(sx, padY, sw, padH, shade(col, 0.56));
  R(sx, padY, sw, padH * 0.22, 'rgba(255,255,255,.12)');                           // front-lip light
  R(sx, padY + padH - padH * 0.28, sw, padH * 0.28, 'rgba(0,0,0,.34)');            // under-shadow
}
function drawSeatChairs() {
  for (const s of audSeats) drawSeat(wx(s.x), wy(s.y), ws_(AUD.seatW), ws_(AUD.seatH), s.color || '#8a97a8');
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
  // Every spectator card is the SAME fixed size (matches the front-row player cards). The
  // seat grid is tighter than the card, so cards overlap into a packed wall of album art.
  const cardW = Math.round(ws_(AUD.cardW)), cardH = Math.round(ws_(AUD.cardH));
  const halfW = ws_(AUD.seatW / 2), halfH = ws_(AUD.seatH / 2);
  for (const s of audSeats) {
    if (!s.r) continue; // empty seat — the chair is already in the background
    const g = gx[s.layer % N_LAYERS];
    const ccx = (s.x + BACK) * scale + halfW, ccy = (s.y + BAND) * scale + halfH; // seat centre, bg-cache coords
    const rect = { x: Math.round(ccx - cardW / 2), y: Math.round(ccy - cardH / 2), w: cardW, h: cardH };
    const img = cardImage(s.r, s.n);
    if (img.ready) g.drawImage(img, rect.x, rect.y, rect.w, rect.h);
    else { g.fillStyle = RARITY_GLOW[s.r] || '#8a97a8'; g.fillRect(rect.x, rect.y, rect.w, rect.h); }
    g.strokeStyle = 'rgba(0,0,0,.45)'; g.lineWidth = 1; g.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);
  }
}
function drawAudience() {
  if (me.team == null) return;
  if (!audienceReady) { buildAudienceSeats(); renderBackground(); audienceReady = true; audNeedsRebake = true; } // re-bake bg so the empty seats appear
  if (audNeedsRebake || !audLayers || audLayers[0].width !== bgCanvas.width) { bakeAudience(); audNeedsRebake = false; }
  const t = performance.now() * 0.001;
  const ox = -(camX + BACK * scale), oy = -(camY + BAND * scale);
  ctx.save();
  // Clip to OUTSIDE the pitch so the crowd is cut cleanly at the touchlines (fans
  // behind the boards) instead of spilling onto the grass.
  ctx.beginPath();
  ctx.rect(0, 0, wbW, wbH);
  ctx.rect(wx(0), wy(0), ws_(FIELD.W), ws_(FIELD.H));
  ctx.clip('evenodd');
  // Goal eruption: for ~2.5s after a goal the whole crowd bobs harder AND leaps up in sync.
  const hype = clamp(1 - (performance.now() - crowdHypeT) / 2500, 0, 1);
  const amp = 1 + hype * 1.8, jump = hype * ws_(30) * Math.abs(Math.sin(t * 9));
  // Each layer L = one wave-column. Two motions combine:
  //  1) ASYNC bob — per-column freq/phase (LAYERS[L]) so adjacent columns jump out of sync,
  //     reading as individually-jumping fans, not one moving block.
  //  2) A travelling MEXICAN WAVE — a sharp one-sided crest whose phase steps with the column,
  //     so a raised band of standing fans rolls across the bowl left→right.
  const WAVE_SPEED = 2.4, WAVE_STEP = (Math.PI * 2) / N_LAYERS, WAVE_AMP = 34;
  for (let L = 0; L < audLayers.length; L++) {
    const p = LAYERS[L];
    const wave = Math.max(0, Math.sin(t * WAVE_SPEED - L * WAVE_STEP)) ** 3 * ws_(WAVE_AMP); // sharp one-sided crest
    const dx = Math.sin(t * p.fx + p.phx) * ws_(p.ax) * (1 + hype * 0.6);
    const dy = Math.sin(t * p.fy + p.phy) * ws_(p.ay) * amp - jump - wave;
    ctx.drawImage(audLayers[L], ox + dx, oy + dy);
  }
  ctx.restore();
}

// ---- Stadium props: perimeter ad boards + team benches -----------------------
// Ad content is fed by the app (or CMS) via window.PIKME_STADIUM = { ads:[{img,text,
// bg,fg,link}] }; falls back to house banners so the boards are never blank. Tapping a
// board asks the RN shell to open the link (reuses the postMessage bridge).
const _adImgs = new Map();
function adImage(url) {
  let img = _adImgs.get(url);
  if (!img) { img = new Image(); img.onload = () => { img.ready = true; }; img.onerror = () => { img.failed = true; }; img.src = url; _adImgs.set(url, img); }
  return img;
}
function stadiumAds() {
  const cfg = (typeof window !== 'undefined' && window.PIKME_STADIUM) || null;
  if (cfg && Array.isArray(cfg.ads) && cfg.ads.length) return cfg.ads;
  return [
    { text: 'PIKME', bg: '#1b2a4a', fg: '#ffd27a' },
    { text: 'COLLECT · PLAY · WIN', bg: '#3a1b4a', fg: '#ffffff' },
    { text: 'YOUR AD HERE', bg: '#123a2a', fg: '#7ee08a' },
  ];
}
let _adBoardRects = [];            // {x,y,w,h,link} SCREEN px — for tap hit-testing
const BOARD_H = 44;                // world-units thickness of the LED perimeter boards (must stay < LANE)
function drawAdBoards() {
  const ads = stadiumAds(); if (!ads.length) return;
  _adBoardRects = [];
  const idxBase = Math.floor(performance.now() / 5000); // rotate the boards every 5s
  // Boards hug the pitch just OUTSIDE the boundary, in the lane held clear of the crowd.
  // Goal-line boards are split ABOVE and BELOW the goal mouth so they never cross the net.
  const sides = [
    [0, -BOARD_H, FIELD.W, 0, 0, false],                                            // top touchline
    [0, FIELD.H, FIELD.W, FIELD.H + BOARD_H, 1, false],                             // bottom touchline
    [-BOARD_H, 0, 0, GOAL_TOP, 2, true], [-BOARD_H, GOAL_BOTTOM, 0, FIELD.H, 3, true],                             // left goal line (flanks)
    [FIELD.W, 0, FIELD.W + BOARD_H, GOAL_TOP, 4, true], [FIELD.W, GOAL_BOTTOM, FIELD.W + BOARD_H, FIELD.H, 5, true], // right goal line (flanks)
  ];
  for (const [x0, y0, x1, y1, oi, vertical] of sides) {
    const ad = ads[(idxBase + oi) % ads.length];
    const sx = Math.round(wx(x0)), sy = Math.round(wy(y0)), sw = Math.round(ws_(x1 - x0)), sh = Math.round(ws_(y1 - y0));
    ctx.fillStyle = '#0b0f14'; ctx.fillRect(sx, sy, sw, sh);                    // frame
    ctx.fillStyle = ad.bg || '#16233c'; ctx.fillRect(sx + 1, sy + 1, sw - 2, sh - 2);
    if (ad.img) { const im = adImage(ad.img); if (im.ready) { ctx.save(); ctx.beginPath(); ctx.rect(sx, sy, sw, sh); ctx.clip(); ctx.drawImage(im, sx, sy, sw, sh); ctx.restore(); } }
    else {
      ctx.save(); ctx.translate(sx + sw / 2, sy + sh / 2); if (vertical) ctx.rotate(-Math.PI / 2);
      const fs = Math.max(7, ws_((vertical ? (x1 - x0) : (y1 - y0)) * 0.46));
      ctx.fillStyle = ad.fg || '#fff'; ctx.font = `800 ${fs}px system-ui, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(ad.text || 'PIKME', 0, 0); ctx.restore();
    }
    ctx.fillStyle = 'rgba(255,255,255,.14)'; ctx.fillRect(sx, sy, sw, Math.max(1, ws_(2.5))); // top gloss
    if (ad.link) _adBoardRects.push({ x0, y0, x1, y1, link: ad.link }); // WORLD rect for tap hit-test
  }
}
// Covered team dugout on the bottom touchline. The player's own team bench shows their
// three loadout POWER CARDS; the opponent bench shows coaching-staff silhouettes.
// The two players' POWER CARDS get their own front-row seats — 3 per player, CLOSEST to
// the field (front of the crowd), same size as the crowd cards. My loadout sits on the near
// (bottom) touchline; the opponent's on the far (top). Missing loadout slots draw as empty
// seats. (Opponent loadout isn't sent to the client yet, so that row shows empty for now.)
function drawPlayerSeats() {
  const cw = AUD.cardW, ch = AUD.cardH, gap = 16, n = 3;
  const rowW = n * cw + (n - 1) * gap, x0 = FIELD.W / 2 - rowW / 2;
  const home = effectiveLoadout();
  const myTeam = me.team === 'B' ? 'B' : 'A', oppTeam = myTeam === 'A' ? 'B' : 'A';
  const seatRow = (topY, cards, col) => {
    for (let i = 0; i < n; i++) {
      const sx = wx(x0 + i * (cw + gap)), sy = wy(topY), sW = ws_(cw), sH = ws_(ch);
      ctx.fillStyle = 'rgba(0,0,0,.32)'; ctx.fillRect(sx + ws_(3), sy + ws_(5), sW, sH); // drop shadow
      const c = cards[i];
      if (c) {
        const im = cardImage(c.r, c.n);
        if (im.ready) ctx.drawImage(im, sx, sy, sW, sH);
        else { ctx.fillStyle = RARITY_GLOW[c.r] || '#8a97a8'; ctx.fillRect(sx, sy, sW, sH); }
        ctx.lineWidth = Math.max(1, ws_(2.5)); ctx.strokeStyle = shade(col, 0.95); ctx.strokeRect(sx, sy, sW, sH); // team frame
      } else {
        drawSeat(sx, sy, sW, sH, col); // empty player seat (loadout slot not filled)
      }
    }
  };
  seatRow(FIELD.H + BOARD_H + 6, home, teamColor(myTeam));                    // near touchline = my power cards
  seatRow(-BOARD_H - 6 - ch, [null, null, null], teamColor(oppTeam));         // far touchline = opponent (empty)
}
function drawStadiumProps() {
  drawAdBoards();
  drawPlayerSeats();
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
    const x = -BACK + Math.random() * (FIELD.W + 2 * BACK);
    const y = top ? -Math.random() * BAND : FIELD.H + Math.random() * BAND;
    spawnConfetti(x, y, true);
  }
}
function updateConfetti(dt) {
  if (me.team == null) return;
  // ambient: a light trickle thrown up from random stand spots (goals add big bursts)
  if (Math.random() < 0.3) {
    const top = Math.random() < 0.5;
    spawnConfetti(-BACK + Math.random() * (FIELD.W + 2 * BACK), top ? -Math.random() * BAND : FIELD.H + Math.random() * BAND, true);
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
  drawGoal(0, -NET_VIS);              // left: line at x=0, DEEP net behind (to -NET_VIS)
  drawGoal(FIELD.W, FIELD.W + NET_VIS); // right: line at x=W, DEEP net behind
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
  // Hidden in a bush: render YOURSELF semi-transparent so you can see you're concealed
  // (enemies can't see you at all — this is just the local "you're in cover" cue).
  const bushedMe = isMe && inBushAt(p.x, p.y);
  if (bushedMe) { ctx.save(); ctx.globalAlpha = 0.5; }
  drawHero(ctx, ox, feetY, sf, dir, walkPhase, moving, p.firing, cos, { J: team, JS: shade(team) }, performance.now() / 1000, anim);
  if (bushedMe) ctx.restore();

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
  // Auto-aim REMOVED (per request): the indicator always shows your MANUAL aim. Quick shots
  // no longer auto-target the nearest enemy / goal — you point where you shoot.
  return manualAim();
}
// Raw manual aim from the stick / mouse (true-world).
function manualAim() {
  if (usingTouch) {
    const m = Math.hypot(touchR.dx, touchR.dy);
    if (touchR.id !== null && m > 12) { const sx = flipView() ? -touchR.dx : touchR.dx; return { aiming: true, ax: sx / m, ay: touchR.dy / m }; }
    return { aiming: false };
  }
  if (!rendered) return { aiming: false };
  const w = screenToWorld(mouse.x, mouse.y);
  let ax = w.x - rendered.x, ay = w.y - rendered.y;
  const l = Math.hypot(ax, ay) || 1;
  return { aiming: true, ax: ax / l, ay: ay / l };
}
// Where a QUICK shot would go (mirrors the sim): the nearest point on the enemy goal when
// carrying, else the nearest ENEMY in line of sight. Returns a true-world unit dir, or null.
function quickShotTarget() {
  if (!rendered || !latest) return null;
  const carrying = latest.ball && latest.ball.owner === me.playerId;
  if (carrying) {
    const goalX = me.team === 'A' ? FIELD.W : 0;         // A attacks right, B attacks left
    const m = BALL_RADIUS + POST_R;
    const gy = clamp(rendered.y, GOAL_TOP + m, GOAL_BOTTOM - m);
    const ax = goalX - rendered.x, ay = gy - rendered.y, l = Math.hypot(ax, ay) || 1;
    return { ax: ax / l, ay: ay / l };
  }
  const walls = fieldArena().walls.concat(latest.walls || []);
  let best = null, bestD = Infinity;
  for (const t of (latest.players || [])) {
    if (t.team === me.team) continue;
    if (!canSeePlayer(t)) continue;
    const dx = t.x - rendered.x, dy = t.y - rendered.y, d = dx * dx + dy * dy;
    if (d > VISION_RANGE * VISION_RANGE || d >= bestD) continue;
    if (walls.some((w) => segBlockedByWall(w, rendered.x, rendered.y, t.x, t.y, 0))) continue;
    bestD = d; best = t;
  }
  if (!best) return null;
  const ax = best.x - rendered.x, ay = best.y - rendered.y, l = Math.hypot(ax, ay) || 1;
  return { ax: ax / l, ay: ay / l };
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
  // FLY-IN intro (lob arc): the bomb ARCS in from the thrower to where it lands over FLY_MS —
  // ease-out horizontally toward the landing spot + a sine hop for the throw. On arrival it kicks
  // a ground shock ring + dust + a small screen shake (once). Transforms the BODY only.
  const FLY_MS = 340;
  const lt0 = bombSpawnT.get(bomb.id);
  ctx.save();
  if (lt0 != null) {
    const p = clamp((performance.now() - lt0) / FLY_MS, 0, 1);
    if (p < 1) {
      const ux = 1 - (1 - p) * (1 - p);              // ease-out toward the landing spot
      const src = bombSrc.get(bomb.id);
      if (src) { const sx = wx(src.x), sy = wy(src.y); ctx.translate((sx - x) * (1 - ux), (sy - y) * (1 - ux)); }
      ctx.translate(0, -Math.sin(p * Math.PI) * r * 4);   // arc hop
    } else if (!bombLanded.has(bomb.id)) {                // arrival → shockwave
      bombLanded.add(bomb.id);
      spawnRing(bomb.x, bomb.y, 12, 58);
      spawnDust(bomb.x, bomb.y, 10, { col: '200,188,160', spd: 95, up: 55, size: 4 });
      shake(clamp(4 * proximity(bomb.x, bomb.y), 1, 4), 130);
    }
  }
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
  ctx.restore(); // end land-intro transform
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
  if (w.angle != null && w.cx != null) return drawStoneSlab(w); // rotatable HARD wall (field builder)
  drawBlockBox(w, STONE_PAL, {
    texture: (ax, ay, aw, ah) => {           // stone courses on the top face
      ctx.fillStyle = 'rgba(0,0,0,.16)';
      for (let y = ay + Math.round(ws_(22)); y < ay + ah; y += Math.max(4, ws_(22))) ctx.fillRect(ax, Math.round(y), aw, 1);
    },
  });
}
// An angled INDESTRUCTIBLE hard wall — rotated stone slab (mirrors drawBuiltWall's slab,
// stone palette, no HP/cracks). Runs inside the team-B mirror so world-space rotate is fine.
function drawStoneSlab(w) {
  const s = wallSlab(w), lift = Math.max(2, ws_(5));
  ctx.save();
  ctx.translate(s.cx, s.cy); ctx.rotate(s.angle);
  ctx.fillStyle = 'rgba(0,0,0,.30)'; ctx.fillRect(-s.L / 2 + ws_(3), -s.T / 2 + ws_(4), s.L, s.T); // shadow
  ctx.fillStyle = '#6b7280'; ctx.fillRect(-s.L / 2, -s.T / 2, s.L, s.T);                            // stone face
  ctx.fillStyle = '#8b93a1'; ctx.fillRect(-s.L / 2, -s.T / 2, s.L, s.T - lift);                     // lit top
  ctx.fillStyle = 'rgba(255,255,255,.22)'; ctx.fillRect(-s.L / 2, -s.T / 2, s.L, Math.max(2, ws_(3))); // highlight
  ctx.fillStyle = 'rgba(0,0,0,.18)';                                                                // stone courses
  for (let x = -s.L / 2 + ws_(22); x < s.L / 2; x += Math.max(4, ws_(22))) ctx.fillRect(Math.round(x), -s.T / 2, 1, s.T);
  ctx.restore();
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
  // Build-in "Assemble" (V3): for the first WALL_BUILD_MS the planks reveal left→right
  // (a clip that sweeps along the wall's length), so it reads as being built.
  const bt0 = wallSpawnT.get(w.id); let bp = 1, flash = 0;
  if (bt0 != null) { bp = clamp((performance.now() - bt0) / WALL_BUILD_MS, 0, 1); flash = (1 - bp) * 0.5; }
  ctx.save();
  ctx.translate(s.cx, s.cy); ctx.rotate(s.angle);
  if (bp < 1) { const rv = 1 - Math.pow(1 - bp, 3); ctx.beginPath(); ctx.rect(-s.L / 2, -s.T / 2 - ws_(6), s.L * rv, s.T + ws_(12)); ctx.clip(); }
  ctx.fillStyle = 'rgba(0,0,0,.28)'; ctx.fillRect(-s.L / 2 + ws_(3), -s.T / 2 + ws_(4), s.L, s.T); // drop shadow
  ctx.fillStyle = face; ctx.fillRect(-s.L / 2, -s.T / 2, s.L, s.T);                                 // body
  ctx.fillStyle = top; ctx.fillRect(-s.L / 2, -s.T / 2, s.L, s.T - lift);                           // lit top
  ctx.fillStyle = hi; ctx.fillRect(-s.L / 2, -s.T / 2, s.L, Math.max(2, ws_(3)));                   // top highlight
  ctx.fillStyle = 'rgba(30,14,0,.35)';                                                              // plank lines
  for (let x = -s.L / 2 + ws_(26); x < s.L / 2; x += Math.max(4, ws_(26))) ctx.fillRect(Math.round(x), -s.T / 2, 1, s.T);
  if (f < 0.99) { ctx.strokeStyle = 'rgba(20,8,0,.7)'; ctx.lineWidth = Math.max(1, ws_(2)); const n = f < 0.34 ? 4 : 2; for (let i = 0; i < n; i++) { const a = i * 2.2 + w.id; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(a) * s.L * 0.35, Math.sin(a) * s.T * 0.5); ctx.stroke(); } }
  if (flash > 0) { ctx.fillStyle = `rgba(255,240,200,${(flash * 0.6).toFixed(3)})`; ctx.fillRect(-s.L / 2, -s.T / 2, s.L, s.T); } // build-in flash
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
let customArena = null; // field-builder match: custom {walls,bushes} from matchStart.arena (else null)
function fieldArena() { return customArena || (training ? TRAIN_ARENA : ARENA); }
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
  ctx.drawImage(bgCanvas, -(camX + BACK * scale), -(camY + BAND * scale)); // cached field at camera offset
  drawAudience(); // card-art crowd (dynamic, jumping) on top of the cached terraces
  drawStadiumProps(); // perimeter ad boards + team benches (in front of the crowd, off-pitch)
  { const cn = performance.now(); const cdt = confPrevT ? Math.min(0.05, (cn - confPrevT) / 1000) : 0.016; confPrevT = cn; updateConfetti(cdt); drawConfetti(); }
  drawObstacles(); // walls / bushes / trampolines (static layout + built walls)
  { const fn = performance.now(); const fdt = fxPrevT ? Math.min(0.05, (fn - fxPrevT) / 1000) : 0.016; fxPrevT = fn; updateFx(fdt); drawFx(); } // dust + wood-shard particles

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
  const specialCooling = performance.now() < specialCdUntil;
  specialBtn.classList.toggle('cooling', specialCooling);
  specialBtn.classList.toggle('ready', !specialCooling); // Brawl-style charged-Super pulse

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

// ===================== FIELD BUILDER (self-contained DOM editor) =====================
// Place bushes / rotatable hard walls / dry walls on a scaled pitch, save to localStorage,
// then "Play" launches a vs-bots match on that field (server type:'builderMatch').
const FB_KEY = 'pikme-field-v1';
const FB_W = 2000, FB_H = 1100;
const FB_WALL = { hl: 88, ht: 16 };   // default wall capsule half-dims (len 176 / thick 32)
const FB_BUSH = { w: 224, h: 160 };
const FB_GRID = 50;                          // fine grid cell (40 x 22 cells) — snap + overlay
const fbSnap = (v) => Math.round(v / FB_GRID) * FB_GRID;
let fbField = { version: 1, bushes: [], hardWalls: [], dryWalls: [] };
let fbTool = null;   // 'bush' | 'hard' | 'dry' | null (placement tool)
let fbSel = null;    // { type, i } selected element | null
let fbDrag = null;   // active pointer drag
const fbPit = () => document.getElementById('builder-pitch');
const fbList = (t) => (t === 'bush' ? fbField.bushes : t === 'hard' ? fbField.hardWalls : fbField.dryWalls);
function fbLoad() { try { const j = JSON.parse(localStorage.getItem(FB_KEY)); if (j && j.version) return { version: 1, bushes: j.bushes || [], hardWalls: j.hardWalls || [], dryWalls: j.dryWalls || [] }; } catch (e) {} return { version: 1, bushes: [], hardWalls: [], dryWalls: [] }; }
function fbSave() { try { localStorage.setItem(FB_KEY, JSON.stringify(fbField)); } catch (e) {} }
// --- Undo / redo (snapshot stack) ---
let fbHist = [], fbHistIdx = -1;
function fbSnapshot() { return JSON.stringify(fbField); }
function fbHistInit() { fbHist = [fbSnapshot()]; fbHistIdx = 0; }
function fbPush() { fbHist = fbHist.slice(0, fbHistIdx + 1); fbHist.push(fbSnapshot()); if (fbHist.length > 60) fbHist.shift(); fbHistIdx = fbHist.length - 1; fbSave(); fbUpdateHistBtns(); }
function fbRestore(json) { const j = JSON.parse(json); fbField = { version: 1, bushes: j.bushes || [], hardWalls: j.hardWalls || [], dryWalls: j.dryWalls || [] }; fbSel = null; fbSave(); fbRender(); fbUpdateHistBtns(); }
function fbUndo() { if (fbHistIdx > 0) { fbHistIdx--; fbRestore(fbHist[fbHistIdx]); } }
function fbRedo() { if (fbHistIdx < fbHist.length - 1) { fbHistIdx++; fbRestore(fbHist[fbHistIdx]); } }
function fbUpdateHistBtns() { const u = document.getElementById('b-undo'), r = document.getElementById('b-redo'); if (u) u.disabled = fbHistIdx <= 0; if (r) r.disabled = fbHistIdx >= fbHist.length - 1; }
// --- Overlap detection (no two elements may overlap) ---
function fbSegSegDist(ax, ay, bx, by, cx, cy, ex, ey) {
  const ux = bx - ax, uy = by - ay, vx = ex - cx, vy = ey - cy, wx = ax - cx, wy = ay - cy;
  const a = ux * ux + uy * uy, b = ux * vx + uy * vy, c = vx * vx + vy * vy, d = ux * wx + uy * wy, e = vx * wx + vy * wy, D = a * c - b * b;
  let sN, sD = D || 1, tN, tD = D || 1;
  if ((D || 0) < 1e-9) { sN = 0; sD = 1; tN = e; tD = c || 1; }
  else { sN = b * e - c * d; tN = a * e - b * d; if (sN < 0) { sN = 0; tN = e; tD = c || 1; } else if (sN > sD) { sN = sD; tN = e + b; tD = c || 1; } }
  if (tN < 0) { tN = 0; if (-d < 0) sN = 0; else if (-d > a) sN = sD; else { sN = -d; sD = a || 1; } }
  else if (tN > tD) { tN = tD; const t2 = -d + b; if (t2 < 0) sN = 0; else if (t2 > a) sN = sD; else { sN = t2; sD = a || 1; } }
  const sc = Math.abs(sN) < 1e-9 ? 0 : sN / sD, tc = Math.abs(tN) < 1e-9 ? 0 : tN / tD;
  return Math.hypot(wx + sc * ux - tc * vx, wy + sc * uy - tc * vy);
}
function fbFoot(el, type) {
  if (type === 'bush') return { box: [el.x, el.y, el.x + el.w, el.y + el.h] };
  const [x0, y0, x1, y1] = [...fbEnds(el)].flatMap((p) => [p.x, p.y]); return { seg: [x0, y0, x1, y1], r: el.ht };
}
function fbSegRectDist(s, box) { // min distance segment<->AABB (0 if it enters the box)
  const [ax, ay, bx, by] = s, [x0, y0, x1, y1] = box;
  const inside = (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
  if (inside(ax, ay) || inside(bx, by)) return 0;
  return Math.min(
    fbSegSegDist(ax, ay, bx, by, x0, y0, x1, y0), fbSegSegDist(ax, ay, bx, by, x1, y0, x1, y1),
    fbSegSegDist(ax, ay, bx, by, x1, y1, x0, y1), fbSegSegDist(ax, ay, bx, by, x0, y1, x0, y0));
}
function fbPairOverlap(fa, fb) {
  if (fa.box && fb.box) return fa.box[0] < fb.box[2] && fa.box[2] > fb.box[0] && fa.box[1] < fb.box[3] && fa.box[3] > fb.box[1];
  if (fa.seg && fb.seg) return fbSegSegDist(...fa.seg, ...fb.seg) < (fa.r + fb.r - 1);
  const seg = fa.seg || fb.seg, box = fa.box || fb.box, r = (fa.seg ? fa.r : fb.r);
  return fbSegRectDist(seg, box) < r - 1;
}
// Does `el` overlap another element in its OWN category? (walls vs walls, bushes vs bushes;
// a wall over a bush is allowed — that's an intentional weak/hidden wall.)
function fbOverlapsAny(el, type, skip) {
  const fa = fbFoot(el, type);
  const group = type === 'bush' ? ['bush'] : ['hard', 'dry'];
  for (const t of group) { const arr = fbList(t); for (let i = 0; i < arr.length; i++) { if (t === type && i === skip) continue; if (fbPairOverlap(fa, fbFoot(arr[i], t))) return true; } }
  return false;
}
function fbFlash(msg) { const h = document.querySelector('#builder .builder-hint'); if (!h) return; const prev = h.textContent; h.textContent = msg; h.style.color = '#ff8a8a'; setTimeout(() => { h.textContent = prev; h.style.color = ''; }, 1200); }
function fbToWorld(cx, cy) { const r = fbPit().getBoundingClientRect(); return { x: Math.max(0, Math.min(FB_W, (cx - r.left) / r.width * FB_W)), y: Math.max(0, Math.min(FB_H, (cy - r.top) / r.height * FB_H)) }; }
// Capsule end points (along `angle`) — matches segBlockedByWall's c0/c1.
function fbEnds(w) { const ca = Math.cos(w.angle), sa = Math.sin(w.angle); return [{ x: w.cx - ca * w.hl, y: w.cy - sa * w.hl }, { x: w.cx + ca * w.hl, y: w.cy + sa * w.hl }]; }
function fbRender() {
  const pit = fbPit(); if (!pit) return;
  pit.querySelectorAll('.bel,.bhandle').forEach((e) => e.remove());
  const pctL = (x) => (x / FB_W * 100) + '%', pctT = (y) => (y / FB_H * 100) + '%';
  const mk = (type, i, cx, cy, w, h, angle) => {
    const d = document.createElement('div');
    d.className = 'bel ' + type + (fbSel && fbSel.type === type && fbSel.i === i ? ' sel' : '');
    d.style.left = pctL(cx); d.style.top = pctT(cy); d.style.width = pctL(w); d.style.height = pctT(h);
    if (angle != null) d.style.setProperty('--ang', angle + 'rad');
    d.dataset.type = type; d.dataset.i = i;
    pit.appendChild(d);
  };
  fbField.bushes.forEach((b, i) => mk('bush', i, b.x + b.w / 2, b.y + b.h / 2, b.w, b.h, null));
  fbField.hardWalls.forEach((w, i) => mk('hard', i, w.cx, w.cy, w.hl * 2, w.ht * 2, w.angle));
  fbField.dryWalls.forEach((w, i) => mk('dry', i, w.cx, w.cy, w.hl * 2, w.ht * 2, w.angle));
}
// Move a selected element to (wx,wy) — grid-snapped.
function fbMoveSel(wx, wy) {
  if (!fbSel) return; const L = fbList(fbSel.type)[fbSel.i]; if (!L) return;
  wx = fbSnap(wx); wy = fbSnap(wy);
  if (fbSel.type === 'bush') { L.x = wx - L.w / 2; L.y = wy - L.h / 2; }
  else { L.cx = wx; L.cy = wy; }
  fbRender();
}
let fbDraw = null; // { type, ax, ay, i } while DRAWING a new wall/bush from a fixed anchor
// Update the element being drawn: a wall becomes a LINE anchor->cursor (free angle =>
// rotation is built in); a bush becomes the rectangle anchor->cursor. Grid-snapped.
function fbDrawUpdate(wx, wy) {
  if (!fbDraw) return; const bx = fbSnap(wx), by = fbSnap(wy);
  if (fbDraw.type === 'bush') {
    const b = fbField.bushes[fbDraw.i]; if (!b) return;
    b.x = Math.min(fbDraw.ax, bx); b.y = Math.min(fbDraw.ay, by);
    b.w = Math.max(FB_GRID, Math.abs(bx - fbDraw.ax)); b.h = Math.max(FB_GRID, Math.abs(by - fbDraw.ay));
  } else {
    const L = fbList(fbDraw.type)[fbDraw.i]; if (!L) return;
    const dx = bx - fbDraw.ax, dy = by - fbDraw.ay;
    const len = Math.max(L.ht * 2, Math.hypot(dx, dy)); // >= a single cube
    L.angle = Math.atan2(dy, dx); L.hl = Math.round(len / 2);
    L.cx = Math.round(fbDraw.ax + Math.cos(L.angle) * L.hl);
    L.cy = Math.round(fbDraw.ay + Math.sin(L.angle) * L.hl);
  }
  fbRender();
}
function fbDeleteEl(el) { if (!el) return; const arr = fbList(el.dataset.type); const i = +el.dataset.i; if (i >= 0 && i < arr.length) { arr.splice(i, 1); if (fbSel && fbSel.type === el.dataset.type && fbSel.i === i) fbSel = null; fbRender(); } }
function fbSetTool(t) { fbTool = t; fbSel = null; document.querySelectorAll('#builder .btool').forEach((b) => b.classList.toggle('active', b.dataset.tool === t)); fbRender(); }
// Mirror all elements. mode: 'sides' (L<->R across x-centre), 'top' (T<->B across y-centre),
// 'diag' (180° point symmetry). Adds the mirrored copies to what's already placed.
function fbMirror(mode) {
  const mx = (x) => FB_W - x, my = (y) => FB_H - y;
  const wall = (w) => mode === 'sides' ? { ...w, cx: mx(w.cx), angle: -w.angle }
    : mode === 'top' ? { ...w, cy: my(w.cy), angle: -w.angle }
    : { ...w, cx: mx(w.cx), cy: my(w.cy) };                    // diag = 180°
  const bush = (b) => mode === 'sides' ? { ...b, x: mx(b.x + b.w) }
    : mode === 'top' ? { ...b, y: my(b.y + b.h) }
    : { ...b, x: mx(b.x + b.w), y: my(b.y + b.h) };
  const addCopies = (type, fn) => { const orig = fbList(type).slice(); for (const e of orig) { const c = fn(e); if (!fbOverlapsAny(c, type, -1)) fbList(type).push(c); } };
  addCopies('hard', wall); addCopies('dry', wall); addCopies('bush', bush);
  fbSel = null; fbRender(); fbPush();
}
function openBuilder() { fbField = fbLoad(); fbSel = null; fbSetTool('hard'); fbHistInit(); fbUpdateHistBtns(); }
(function fbWire() {
  const pit = document.getElementById('builder-pitch'); if (!pit) return;
  const bscr = document.getElementById('builder'); if (bscr) screens.builder = bscr;
  document.getElementById('field-builder-btn')?.addEventListener('click', () => { unlockAudio && unlockAudio(); showScreen('builder'); openBuilder(); });
  document.querySelectorAll('#builder .btool').forEach((btn) => btn.addEventListener('click', () => fbSetTool(fbTool === btn.dataset.tool ? null : btn.dataset.tool)));
  document.getElementById('b-delete')?.addEventListener('click', () => { if (fbSel) { fbList(fbSel.type).splice(fbSel.i, 1); fbSel = null; fbRender(); fbPush(); } });
  document.getElementById('b-clear')?.addEventListener('click', () => { fbField = { version: 1, bushes: [], hardWalls: [], dryWalls: [] }; fbSel = null; fbRender(); fbPush(); });
  document.querySelectorAll('#builder [data-mirror]').forEach((btn) => btn.addEventListener('click', () => fbMirror(btn.dataset.mirror)));
  document.getElementById('b-undo')?.addEventListener('click', fbUndo);
  document.getElementById('b-redo')?.addEventListener('click', fbRedo);
  document.getElementById('b-save')?.addEventListener('click', () => { fbSave(); const h = document.querySelector('#builder .builder-hint'); if (h) { const p = h.textContent; h.textContent = 'נשמר ✓'; h.style.color = '#7CFC7C'; setTimeout(() => { h.textContent = p; h.style.color = ''; }, 1200); } });
  document.getElementById('builder-play')?.addEventListener('click', () => { fbSave(); unlockAudio && unlockAudio(); syncLoadout && syncLoadout(); sendMsg({ type: 'builderMatch', field: fbField }); });
  pit.addEventListener('pointerdown', (e) => {
    const w = fbToWorld(e.clientX, e.clientY);
    const el = e.target.closest('.bel');
    // ERASER — remove what you touch/drag over.
    if (fbTool === 'eraser') { fbDrag = { id: e.pointerId, erase: true, pre: fbSnapshot() }; try { pit.setPointerCapture(e.pointerId); } catch (x) {} fbDeleteEl(el); return; }
    // WALL tools — DRAW a line from a fixed anchor (grid-snapped, any angle).
    if (fbTool === 'hard' || fbTool === 'dry') {
      const ax = fbSnap(w.x), ay = fbSnap(w.y);
      fbList(fbTool).push({ cx: ax, cy: ay, angle: 0, hl: FB_WALL.ht, ht: FB_WALL.ht });
      fbDraw = { type: fbTool, ax, ay, i: fbList(fbTool).length - 1 }; fbSel = { type: fbTool, i: fbDraw.i };
      fbDrag = { id: e.pointerId }; try { pit.setPointerCapture(e.pointerId); } catch (x) {} fbRender(); return;
    }
    // BUSH — DRAW a rectangle from a fixed anchor.
    if (fbTool === 'bush') {
      const ax = fbSnap(w.x), ay = fbSnap(w.y);
      fbField.bushes.push({ x: ax, y: ay, w: FB_GRID, h: FB_GRID });
      fbDraw = { type: 'bush', ax, ay, i: fbField.bushes.length - 1 }; fbSel = { type: 'bush', i: fbDraw.i };
      fbDrag = { id: e.pointerId }; try { pit.setPointerCapture(e.pointerId); } catch (x) {} fbRender(); return;
    }
    // NO TOOL — select + drag-move an existing element.
    if (el) { fbSel = { type: el.dataset.type, i: +el.dataset.i }; fbDrag = { id: e.pointerId, move: true, pre: fbSnapshot() }; try { pit.setPointerCapture(e.pointerId); } catch (x) {} fbRender(); }
    else { fbSel = null; fbRender(); }
  });
  pit.addEventListener('pointermove', (e) => {
    if (!fbDrag) return; const w = fbToWorld(e.clientX, e.clientY);
    if (fbDraw) fbDrawUpdate(w.x, w.y);
    else if (fbDrag.erase) { const t = document.elementFromPoint(e.clientX, e.clientY); fbDeleteEl(t && t.closest ? t.closest('.bel') : null); }
    else if (fbDrag.move && fbSel) fbMoveSel(w.x, w.y);
  });
  pit.addEventListener('pointerup', (e) => {
    if (!fbDrag) return;
    try { pit.releasePointerCapture(e.pointerId); } catch (x) {}
    if (fbDraw) {
      const L = fbList(fbDraw.type)[fbDraw.i];
      if (L && fbOverlapsAny(L, fbDraw.type, fbDraw.i)) { fbList(fbDraw.type).splice(fbDraw.i, 1); fbSel = null; fbRender(); fbFlash('אי אפשר לחפוף אלמנטים'); }
      else fbPush();
    } else if (fbDrag.move && fbSel) {
      const L = fbList(fbSel.type)[fbSel.i];
      if (L && fbOverlapsAny(L, fbSel.type, fbSel.i)) { fbRestore(fbDrag.pre); fbFlash('אי אפשר לחפוף אלמנטים'); }
      else if (fbDrag.pre !== fbSnapshot()) fbPush();
    } else if (fbDrag.erase) {
      if (fbDrag.pre !== fbSnapshot()) fbPush();
    }
    fbDraw = null; fbDrag = null;
  });
})();
