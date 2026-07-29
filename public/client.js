// Web game client: renders the authoritative state with client-side prediction
// for your own player and interpolation for everyone else + the ball.

import {
  FIELD, GOAL, POST_R, PENALTY, BALL_RADIUS, CHARACTERS, TEAM, PROJECTILE, BOMB, MOVE_ACCEL,
  SHOOT_CHARGE_TIME, SUPER_CHARGE_RATE, MAG_SIZE, GOAL_RESET, GOAL_FREEZE_HOLD, MATCH_DURATION, OVERTIME_DURATION,
  BUSH_REVEAL_DIST, SHOT_REVEAL_TIME, BUILD_MAG, BUILT_WALL, BUILD_DIST_MAX, BUILD_WINDUP, BUILD_WINDUP_SLOW, FULL_CHARGE, QUICK_CHARGE, BOMB_LOB_RANGE, VISION_RANGE, clamp,
  defaultSettings, isPracticeMode,
} from '/shared/constants.js';
import { ARENA, resolveWalls, pointInBush, segBlockedByWall, buildArenaFromField, capsuleAABB, wallPlacement } from '/shared/arena.js';
import { PEN, TRAIN_ARENA } from '/shared/training.js';
import {
  TU_LEVELS, TU_RING, TU_GOAL, TU3_BUSH, TU2_WALL, tuLevel, stepsIn, stepAt, doneStage,
  advance, isStepDone, showNudge, nudgeFor, captionFor, subFor, tuHasControl, isTutorialOver,
  bombHit, tuUnlocked, nextLevel, tuOffered, markersFor, tuIsHub, TU_HUB_LEVEL,
  tuIsMockStep, introducesFor,
} from '/shared/tutorial.js';
import { drawModeArt } from '/mode-art.js';
import { newDragCancel, updateDragCancel, releaseCancels } from '/shared/drag-cancel.js';
import { MAIN_FIELD } from '/shared/main-field.js';
import { FIELD_PRESETS } from '/shared/field-presets.js';
import { FIELD_SIZES, SIZE_IDS, DEFAULT_SIZE, sizeOf, sizeOfField, canHost } from '/shared/field-sizes.js';
import { MAX_SPAWNS_PER_TEAM, teamForX, spawnCounts, spawnCapacity, defaultSpawns } from '/shared/field-spawns.js';
import { DIFFICULTY_LEVELS, DEFAULT_LEVEL, clampLevel, levelAt, botLevelFromXp } from '/shared/difficulty.js';
import { decodeSnapshot } from '/shared/wire.js';
import { onPong, onSnapshot, resetNetHud, renderNetHud, hideNetHud, NET_DEBUG } from '/net-hud.js';
import { openMatchInfo, closeMatchInfo } from '/match-info.js';
import { setPixelText, mountPixelDigitCss } from '/pixel-digits.js';
import { renderHubRank, pollRank, armRankReveal } from '/hub-rank.js';
import { TROPHIES_HE } from '/shared/rank.js';
import { rankTopCards as rankFriendTop } from '/shared/friend-cards.js';
import { SALTIZ_BOTS, SALTIZ_BOT_BY_ID, botLevelOf, xpForSaltizBot, saltizBotLoadout, searchSaltizBots, colorForMemberId } from '/shared/saltiz-bots.js';
import { QUICK_GROUPS, phraseById, REACTION_EMOJI, sanitizeFreeText, freeTextLeft, FREE_TEXT_MAX } from '/shared/quick-messages.js';
import { CHAT_WORDS, CHAT_EMOTES, CHAT_SHEET, chatById, CHAT_BUBBLE_MS, CHAT_SEND_GAP_MS, CHAT_BURST_N, CHAT_BURST_MS, CHAT_COOLDOWN_MS } from '/shared/quick-chat.js';
import { rosterCounts } from '/shared/roster.js';
import { drawHero, ACTION_DUR, LOBBY_DANCES } from '/heroes.js';
import { mountHeroFx } from '/hero-fx.js';
import {
  HERO_KEYS, HERO_NAMES, SIGNATURE_NAMES, SKIN_KEYS, SKIN_NAMES, SKIN_RARITY,
  DEFAULT_COSMETIC, normalizeCosmetic,
} from '/shared/cosmetics.js';
import { buildProfileModel, readHeroPlays, readBestBotLevel, bumpHeroPlays, bumpBestBotLevel, heroKeyOf } from '/shared/profile-stats.js';
import { jointKey, resolveJointStyle, overrideOf, cycleJointStyle, setJointOverride, pruneJointOverrides } from '/shared/joint-style.js';
import { renderProfile } from '/profile.js';
let slotIds = [], slotTeam = [], rosterVersion = -1; // binary-snapshot slot->id/team (from the 'roster' control msg)

// TEMP diagnostic: a visible build tag so we can tell for certain whether the device is running
// the freshly-deployed game. If you don't see this green tag bottom-left, you're on stale code.
// Dev build badge. Positioned bottom-CENTRE, not bottom-left: the builder's «נקה הכל» button sits in
// that corner now that the bars are tight, and this badge covered it and made it unreadable.
// Bottom-centre is free (the builder's hint overlay is at bottom:68px).
const BUILD_TAG = 'BUILD ✅ 25JUL-v5';
try {
  const _mk = () => { const d = document.createElement('div'); d.textContent = BUILD_TAG; d.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:2px;z-index:999999;font:bold 10px monospace;color:#0f0;background:rgba(0,0,0,.45);padding:1px 5px;border-radius:3px;pointer-events:none;opacity:.6'; document.body.appendChild(d); };
  if (document.body) _mk(); else addEventListener('DOMContentLoaded', _mk);
} catch { /* non-browser */ }

const PENALTY_TOP = (FIELD.H - PENALTY.width) / 2;
const PENALTY_BOTTOM = (FIELD.H + PENALTY.width) / 2;

const INPUT_RATE = 60;         // inputs sent per second (matches the server tick). 120Hz pending: needs the tick-counting tests re-tuned to DT first (see summery/REACTIVITY_ROADMAP.md).
const INPUT_DT = 1 / INPUT_RATE;
const INTERP_DELAY = 55;       // ms we render remote entities in the past (~3 snapshots at 60Hz; was 100 = too laggy)
const GOAL_TOP = (FIELD.H - GOAL.width) / 2;
const GOAL_BOTTOM = (FIELD.H + GOAL.width) / 2;

// --------------------------------------------------------------------------
// State
// --------------------------------------------------------------------------
let ws = null;
let me = { playerId: null, team: null, char: 'striker' };
let matchId = null;            // stable per-match id from matchStart (app-bound matchResult key)
let matchGoalsToWin = 0;       // first-to-N from matchStart; 0 = timed (most goals wins)
let matchDiffLevel = null;     // authoritative bot difficulty (0..11) — matchStart, then live `bots` frames
// The LOWEST level this match ever ran at, and what matchResult reports as the trophy BOT CEILING.
// Difficulty is changeable mid-match in a vs-bots room, so a single number is gameable in one
// direction or the other: report the JOIN level and you can quietly drop to level 0 for the whole
// match while still claiming the join ceiling; report the LATEST and you can play level 0 and flick
// to קטלני at the whistle. The floor is the only honest answer — you cannot claim a ceiling above the
// easiest bots you actually faced.
let matchDiffFloor = null;
let matchOpponentKey = '';     // server-computed opaque id of MY human opponents (win-trading cap); '' vs bots
let training = false;          // true in the training ground (no clock, penned dummy, reset-ball)
let tutorial = false;          // true in the scripted first match (the kids' onboarding — see the
                               // TUTORIAL section near the bottom of this file)
let matchResultSent = false;   // one-shot guard: matchResult is posted to the app exactly once per match
let myMatchStats = null;       // per-player tallies for THIS match (goals/strips/saves/…), sent by the server at match end
let _pendingPost = null;       // deferred postMatchResult fn — fires once matchStats arrives (or a fallback timer)
let snaps = [];                // interpolation buffer: {tRecv, snap}
let latest = null;             // most recent snapshot (for HUD/own authoritative)
let predicted = null;          // {x, y} predicted own position
let rendered = null;           // {x, y} smoothed own position actually drawn
let predVel = { x: 0, y: 0 };  // predicted own velocity (eased — matches the sim)
let seq = 0;
// Client-side prediction reconciliation: keep the movement inputs the server hasn't acked yet
// ({seq,moveX,moveY,dt}); on each snapshot, snap to the authoritative own pos and REPLAY these
// so the prediction stays drift-free instead of lerp-lagging. Flag lets us fall back instantly.
const USE_REPLAY = true;
let pendingInputs = [];
let ping = 0;
// Snapshots/sec, as a ROLLING 1s window over actual arrival times.
//
// This was a fixed-phase sampler (`setInterval(() => { snapRate = snapCount; snapCount = 0 }, 1000)`)
// started at page load, so the value it published was up to a second STALE — and at kickoff that
// stale value was the lobby's 0. The net HUD reads snapRate, sees 0 < poor threshold 30, and after
// its 600ms escalate dwell paints «חיבור לא יציב» on a flawless connection. Reproduced in
// test-net-warmup.mjs: perfect 3ms LAN + stale 0 -> false 'poor' at 601ms.
//
// A rolling window can't go stale, and `null` (= "don't know yet") until a full second of history
// exists means the first frames of a match are never judged on a half-filled window. net-quality
// treats a null rate as Infinity, i.e. ignored.
// Cached `--pd-px` per element (pixel-numeral block size). Declared HERE, not next to its helpers
// further down, because resize() clears it — and resize() is defined above those helpers. A const
// is in its temporal dead zone until evaluation reaches it, and this file has shipped a TDZ crash
// to TestFlight once already.
const _pdPxCache = new Map();

const SNAP_WIN_MS = 1000;
let snapTimes = [];   // arrival times (performance.now) inside the window
let snapFirstAt = null;
let snapRate = null;  // snapshots/sec, or null while still warming up
function noteSnapshotRate(now) {
  const last = snapTimes.length ? snapTimes[snapTimes.length - 1] : null;
  // A break longer than the window means this is a FRESH stream — a new match, a resume from
  // backgrounding, a reconnect. Re-warm rather than judging its first few arrivals: the socket
  // outlives a match, so without this the next kickoff reads 1/s, 2/s… and cries wolf again.
  if (last == null || now - last > SNAP_WIN_MS) { snapTimes = []; snapFirstAt = now; }
  snapTimes.push(now);
  const cut = now - SNAP_WIN_MS;
  while (snapTimes.length && snapTimes[0] < cut) snapTimes.shift();
  // Only meaningful once the window is genuinely full — otherwise a 3-snapshot-old match reads
  // as "3/s" and looks like a dying connection.
  snapRate = (now - snapFirstAt) >= SNAP_WIN_MS ? snapTimes.length : null;
}
function resetSnapshotRate() { snapTimes = []; snapFirstAt = null; snapRate = null; }

const chosenChar = 'player'; // one player type (physics); look is set by the cosmetic below
const PREVIEW_KIT = { J: '#3f7bd6', JS: '#2c5aa6' }; // home/picker preview kit colours

// ---- Cross-device EXTRA prefs (settings / controls / builder) --------------------------------
// Everything the player tunes that used to live ONLY in localStorage (so it died on a reinstall or a
// new phone). The app injects the server-saved bag as window.SALTIZ_PREFS before the game's scripts
// run; we mirror it into localStorage HERE — before any module reads those keys — then post changes
// back out via postPrefs(). Values are plain strings (exactly what localStorage holds).
const PREF_KEYS = [
  'pikme-sound', 'pikme-music', 'pikme-musicvol', 'pikme-soundvol', 'pikme-diff-level', // audio + difficulty
  'fbControls', 'fbAimSens', 'fbBombMax', 'fbWallMax',                                   // touch layout + aim feel
  'pikme-field-v1', 'pikme-fields', 'pikme-field-name',                                  // builder fields (corner style now lives on the field itself)
  'saltizBotFriends',                                                                    // which named bots you added as friends
  'fbHeroPlays', 'fbBestBotLevel',                                                       // profile page: most-played hero + peak bot level
];
const PREF_MAX_BYTES = 200000; // don't ship an unbounded builder library to the backend
function readExtraPrefs() {
  const out = {};
  try { for (const k of PREF_KEYS) { const v = localStorage.getItem(k); if (v != null) out[k] = v; } } catch { /* private mode */ }
  try { if (JSON.stringify(out).length > PREF_MAX_BYTES) delete out['pikme-fields']; } catch { /* ignore */ } // saved-field library is the big one
  return out;
}
function applyExtraPrefs(bag) {
  if (!bag || typeof bag !== 'object') return 0;
  let n = 0;
  try { for (const k of PREF_KEYS) if (typeof bag[k] === 'string') { localStorage.setItem(k, bag[k]); n++; } } catch { /* private mode */ }
  return n;
}
// Restore the injected bag at boot (server-saved wins — it's rewritten on every change).
applyExtraPrefs(window.SALTIZ_PREFS);
// ONE hook instead of touching all ~11 save sites: any write to a tracked key schedules a debounced
// prefs push. Installed AFTER the boot restore above so restoring doesn't echo straight back out, and
// it can't drift when new settings/builder save points are added later.
try {
  const _setItem = localStorage.setItem.bind(localStorage);
  localStorage.setItem = function (k, v) { _setItem(k, v); if (PREF_KEYS.indexOf(k) >= 0) postPrefs(); };
} catch { /* private mode */ }
// Cross-device prefs: the app injects window.SALTIZ_COSMETIC / SALTIZ_LOADOUT (server-saved, keyed by
// phone) BEFORE the game loads; those WIN over localStorage so a fresh device restores your hero/loadout.
// On change we persist locally, tell the game server, AND post {t:'prefs'} out so the app saves it.
function loadCosmetic() {
  try {
    const inj = window.SALTIZ_COSMETIC;
    if (inj && typeof inj === 'string') return normalizeCosmetic(inj);
    return normalizeCosmetic(localStorage.getItem('pikme_cosmetic'));
  } catch { return DEFAULT_COSMETIC; }
}
// LEVEL 4's demo: the look is a LESSON, not a choice. postPrefs() below reaches the app, which
// saves prefs under the player's phone number, so a demo hero must not get that far.
function saveCosmetic(c) { if (tuHub) return; try { localStorage.setItem('pikme_cosmetic', c); } catch { /* private mode */ } postPrefs(); }
// Push the player's prefs out to the app (which saves them under the phone). Debounced — a slider
// drag or a controls-editor drag would otherwise fire this on every tick.
let _prefsT = null;
function postPrefs() {
  if (_prefsT) clearTimeout(_prefsT);
  _prefsT = setTimeout(() => {
    _prefsT = null;
    try {
      window.ReactNativeWebView?.postMessage(JSON.stringify({
        t: 'prefs', cosmetic: myCosmetic, loadout: myLoadout, prefs: readExtraPrefs(),
      }));
    } catch { /* not in app */ }
  }, 700);
}
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
function loadLoadout() {
  try {
    const inj = window.SALTIZ_LOADOUT; // server-saved cross-device loadout wins over local
    if (Array.isArray(inj)) return [0, 1, 2].map((i) => (inj[i] && inj[i].r && inj[i].n != null ? { r: inj[i].r, n: +inj[i].n } : null));
    const s = localStorage.getItem('pikme-loadout'); const a = s && JSON.parse(s); return Array.isArray(a) ? a : null;
  } catch { return null; }
}
// `tuHub` guard, matching saveCosmetic above: while a hub lesson is running NOTHING is persisted.
// setSlotCard and swapSlots already return before reaching here, but #select-best-btn's handler calls
// saveLoadout directly — so without this, one tap of «הכי טוב» during the lobby tour would write the
// lesson's loadout to localStorage AND postPrefs() it to the app, which saves under the player's
// PHONE NUMBER. The invariant is "the tutorial cannot write", so it is enforced at the write.
function saveLoadout(a) { if (tuHub) return; try { localStorage.setItem('pikme-loadout', JSON.stringify(a)); } catch { /* private mode */ } postPrefs(); }
let myLoadout = loadLoadout();            // null => auto-fill top-3; else a saved [{r,n}|null] x3

// ---- THE LOBBY TOUR'S SEAM (public/hub-tour.js) ----------------------------------------------
// The tour runs on the real hub with the real handlers, and nothing it does may survive it. Three
// things it cannot do from outside this module, because myLoadout / myCosmetic / tuHub are private:
//   begin()    raise the sandbox flag and snapshot what the player had;
//   end()      put both back, lower the flag, and re-tell the server the truth;
//   cosmetic() read the LIVE hero, which is how the tour knows the rare landed (base → gold). Read
//              through here rather than off a localStorage write, because during the tour there
//              aren't any.
// Restoring `myLoadout` by reference keeps `null` meaning null — that is "auto-fill the album's top
// three", a different state from an explicit [null,null,null], and flattening the two would silently
// change what a player with no saved loadout sees afterwards.
let _hubSnap = null;
// The lobby's 🎛️ shortcut (index.html, inside the settings card). The controls editor drags the LIVE
// sticks, so it only means anything inside a match — which left no way to reach it from the hub at all.
// This flag is set when the shortcut starts a training room and consumed when that room opens.
let pendingControlsEditor = false;
window.__hubPrefs = {
  begin() {
    if (_hubSnap) return;
    _hubSnap = { loadout: myLoadout, cosmetic: myCosmetic };
    tuHub = true;
  },
  end() {
    if (!_hubSnap) return;
    myLoadout = _hubSnap.loadout;
    myCosmetic = _hubSnap.cosmetic;
    const hadCards = 'cards' in _hubSnap;
    const cards = _hubSnap.cards;
    _hubSnap = null;
    // The demo deck goes with the lesson. A player who owns nothing must be looking at an empty hub
    // again the moment it ends — not at seven cards they do not have.
    if (hadCards) { window.SALTIZ_CARDS = cards; renderCarousel(); renderHubStats(); }
    tuHub = false;                      // lowered BEFORE the re-sends, or they would be swallowed too
    renderPowerSlots();                 // the hero canvas reads myCosmetic live (drawDancer), so it follows
    syncLoadout();
    sendMsg({ type: 'setCosmetic', cosmetic: myCosmetic });
  },
  // CLEAR THE SLOTS FOR THE LESSON, in memory only.
  // Without this the card half of the tour is vacuous: `myLoadout` is null for anyone who has never
  // arranged their powers, and effectiveLoadout() reads that as "auto-fill the album's top three" —
  // so every slot is already full when the tour arrives, "drag a card into a slot" is complete before
  // the kid touches anything, and «הכי טוב» has nothing to do either. Measured on the real page: both
  // steps self-completed and the tour ran its card half in about a second.
  // An explicit [null,null,null] is NOT the same value as null — it means "three empty slots" rather
  // than "fill them for me" — which is exactly what the lesson needs, and why end() restores the
  // snapshot by reference instead of rebuilding it.
  emptySlots() {
    if (!_hubSnap) return;              // only inside a tour; never a way to wipe a real loadout
    myLoadout = [null, null, null];
    renderPowerSlots();
  },
  // A DEMO ALBUM, for a player who owns nothing yet.
  // Without it the card half of the tour cannot run at all: no cards means no carousel, nothing to drag
  // into a slot and nothing to drop on the hero. myCards() reads window.SALTIZ_CARDS (the app injects
  // it pre-load), so handing it a temporary deck and re-rendering is enough — no client internals move.
  // The previous album is remembered and put back by end(), including the case where there wasn't one:
  // `'cards' in snap` distinguishes "no album" from "not swapped", which plain `undefined` cannot.
  demoAlbum(cards) {
    if (!_hubSnap || 'cards' in _hubSnap) return;      // only inside a tour, and only once
    _hubSnap.cards = window.SALTIZ_CARDS;
    window.SALTIZ_CARDS = cards;
    renderCarousel(); renderPowerSlots(); renderHubStats();
  },
  // HOLD THE CAROUSEL STILL FOR THE LESSON.
  // startCarouselAuto() spins the coverflow every 2.6s, which means the card the coach's hand is
  // pointing at slides out from under it — and worse, whichever card happens to be at the front when
  // the hero step arrives is the one a player will actually grab. Measured on the real page: the front
  // card was a LEGENDARY while the hand pointed at a 90px rare tucked behind it, so the natural drag
  // produced setHeroSkinByRarity('legendary'), no gold, and the step could never complete.
  // The lab had been hiding this: its sandbox filters the 2.6s interval out, so the bench froze and
  // the shipped tour did not.
  freezeCarousel() { stopCarouselAuto(); },
  thawCarousel() { startCarouselAuto(); },
  cosmetic: () => myCosmetic,
};
// MID-SESSION prefs push from the app (it can call this any time after load — e.g. the player's prefs
// changed on another device). Hero + loadout apply LIVE; the extras bag lands in localStorage and takes
// effect where it's read (audio/difficulty immediately-ish, controls/builder on their next open).
// Deliberately does NOT postPrefs() back — that would echo the app's own write into a loop.
window.__pikmeApplyPrefs = function (p) {
  try {
    if (!p || typeof p !== 'object') return false;
    if (typeof p.cosmetic === 'string' && p.cosmetic) {
      myCosmetic = normalizeCosmetic(p.cosmetic);
      try { localStorage.setItem('pikme_cosmetic', myCosmetic); } catch { /* private mode */ }
      sendMsg({ type: 'setCosmetic', cosmetic: myCosmetic });
    }
    if (Array.isArray(p.loadout)) {
      myLoadout = [0, 1, 2].map((i) => (p.loadout[i] && p.loadout[i].r && p.loadout[i].n != null ? { r: p.loadout[i].r, n: +p.loadout[i].n } : null));
      try { localStorage.setItem('pikme-loadout', JSON.stringify(myLoadout)); } catch { /* private mode */ }
      sendMsg({ type: 'setLoadout', loadout: myLoadout });
    }
    applyExtraPrefs(p.prefs);
    if (typeof renderHomeCharacter === 'function') renderHomeCharacter(); // repaint hero + power slots
    return true;
  } catch { return false; }
};
let cosmeticById = {};                    // playerId -> "hero:skin", from the roster control frame
let holdingBall = false;     // am I currently carrying the ball?
let mySuper = false;         // am I in SUPER (overcharge ready)? → local charge ring fills 2× faster
let mySuperLatched = false;  // I began loading a shot while in super → keep the red aim + red ring until I fire (mirrors the sim's _superLatched)

// Live-tunable settings (pause menu). Client keeps its own copy for prediction
// + rendering and pushes changes to the authoritative server.
// THE SIM'S OWN DEFAULTS, not a copy of them. This used to be a hand-written literal, and it had
// drifted to EIGHT of the ten keys in SETTING_KEYS: bombReloadSpeed and wallReloadSpeed were added to
// defaultSettings() and never mirrored here. syncSliderUI() formats every SETTING_KEY, so opening the
// settings panel before a matchStart had filled the gaps threw
// «undefined is not an object (evaluating 'v.toFixed')» straight over the pitch.
// It only reproduced sometimes because matchStart carries `settings` and Object.assign patched the
// holes after the fact — so the crash needed the panel opened BEFORE that arrived.
// Importing the function means the next key added to the sim cannot desync this again.
const settings = defaultSettings();

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
let soundEnabled = true;   // SFX master on/off (kept true; volume drives loudness)
// NEW-PLAYER DEFAULTS: both sit at 50% (user, 2026-07-27 — a first game used to open at 72% SFX /
// 60% music, loud enough that the first thing some players did was reach for the sliders). These are
// only the starting values: the reads a few lines below let ANY stored 'pikme-soundvol' /
// 'pikme-musicvol' win, so an existing player's own setting is never rewritten to 50%.
// Both sliders take their position from these variables, so the numbers here are what the settings
// screen shows on a first run — index.html deliberately carries no `value` attribute.
let soundVol = 0.35;       // SFX volume 0..1 (settings slider) — shipped default, from the same export
let musicEnabled = true;   // background music on/off — the 🎵 button
// SHIPPED AT 0, from the same export: the game starts with the music silent, and a player who wants it
// raises the slider. This is a product-wide default and the loudest thing in this batch of changes —
// flagged as such when it went in, and it is one number to put back.
let musicUserVol = 0;      // user music volume 0..1 (multiplies each track's own base level)
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
try { const v = parseFloat(localStorage.getItem('pikme-soundvol')); if (Number.isFinite(v)) soundVol = Math.min(1, Math.max(0, v)); } catch { /* private mode */ }

// 🔊 button = SFX only (bomb/kick/hit/ui). Music has its own 🎵 toggle + volume slider.
function updateSoundButton() {
  const btn = document.getElementById('sound-btn');
  if (btn) {
    btn.textContent = soundEnabled ? '🔊' : '🔇';
    btn.classList.toggle('muted', !soundEnabled);
    btn.setAttribute('aria-label', soundEnabled ? 'השתקת אפקטים' : 'הפעלת אפקטים');
    btn.title = soundEnabled ? 'אפקטים' : 'אפקטים מושתקים';
  }
  if (masterGain) masterGain.gain.value = soundEnabled ? soundVol : 0;
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
    masterGain.gain.value = soundEnabled ? soundVol : 0;
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
const VIBE = { hit: 12, playerHit: 28, bomb: [55, 45, 100], goal: [55, 45, 55, 45, 150], concede: 25, cancel: [15, 40, 15], rearm: 10 };
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
    // HOW HUMAN WAS THIS MATCH — one rule, in shared/roster.js, unit-tested by test-roster-humans.mjs.
    //
    // ⚠️ FIXED 2026-07-26. This used to build its id set from ALL of `matchRoster`, and `fillBots`
    // appends bot entries into that same array, so BOTS COUNTED AS HUMANS: a solo-vs-3-bots match
    // reported { humanOpponents: 2, vsHuman: true, humanCount: 4, xpFactor: 1.00 }. Every bot-economy
    // control on the server — the roster grade, TROPHY_BOT_FLOOR, botTaper, BOT_RATE, botCeiling,
    // BOT_DAILY_CAP, the winsVsBot gate — was therefore dead code in production. It now reports
    // { 0, false, 1, 0.20 } for that match.
    //
    // xpFactor stays the wire format (0.2 + 0.8 × humanFrac, 2dp) because pikme-server inverts it back
    // into the stepped 0.50 / 0.65 / 0.80 / 1.00 grade — do not change the encoding on one side only.
    const { humanOpponents, vsHuman, humanCount, totalPlayers, xpFactor } = rosterCounts({
      roster: matchRoster,
      players: (latest && latest.players) || [],
      opponentTeam: opT,
    });
    // TROPHY inputs (the game reports, the SERVER decides — see pikme-server data/football-trophies.js).
    // opponentKey comes from matchStart, computed server-side: it must be stable ACROSS matches for the
    // win-trading cap to work, and member ids are per-connection (`m-<counter>`), so the client cannot
    // build it itself. '' for a bots-only match.
    const payload = {
      t: 'matchResult',
      matchId,
      result,                       // win | loss | draw, from MY team's perspective
      myTeam: myT,
      myScore,
      opScore,
      durationSec: MATCH_DURATION,
      humanOpponents,               // opponents whose snapshot id is in matchRoster
      vsHuman,                      // true iff a real human was on the opposing team
      humanCount,                   // total humans in the match (incl. me)
      totalPlayers,                 // filled slots (humans + bots)
      xpFactor,                     // XP multiplier: 0.2 (all bots) .. 1.0 (all humans)
      botLevel: matchDiffFloor,     // LOWEST room difficulty 0..11 this match ran at → the trophy BOT CEILING
      opponentKey: matchOpponentKey, // server-computed opaque id of MY human opponents ('' vs bots)
      stats: myMatchStats || null,  // MY per-player tallies: { goals, strips, saves, shots, bombs, walls }
    };
    // PROFILE COUNTERS. Local, but PREF_KEYS-mirrored, so they follow the account to a new device.
    // Written HERE and not in the app because the app never learns which hero was worn, nor the bot
    // level the room actually ran at. Wrapped: localStorage THROWS in private mode, and this sits on
    // the match-end path — the profile page showing an empty state is fine, a thrown match end is not.
    try {
      const plays = bumpHeroPlays(readHeroPlays((k) => localStorage.getItem(k)), heroKeyOf(myCosmetic));
      localStorage.setItem('fbHeroPlays', JSON.stringify(plays));
      const peak = bumpBestBotLevel(readBestBotLevel((k) => localStorage.getItem(k)), matchDiffFloor);
      if (peak != null) localStorage.setItem('fbBestBotLevel', String(peak));
    } catch { /* private mode: the profile page just shows its empty state */ }
    window.ReactNativeWebView?.postMessage(JSON.stringify(payload));
  } catch { /* not in app */ }
}

function processSnapshotSounds(snap) {
  const blastIds = new Set((snap.blasts || []).map((b) => b.id));
  const impactIds = new Set((snap.impacts || []).map((i) => i.id));
  if (soundEventsReady) {
    if (previousResetTimer <= 0 && snap.resetTimer > 0 && snap.lastGoal) {
      const ourGoal = snap.lastGoal === me.team;
      if (tutorial && ourGoal) tuEv.scored = true;   // latch: completes the goal + super steps
      playSound(ourGoal ? 'goalHappy' : 'goalConceded', ourGoal ? 1 : 0.82);
      haptic(ourGoal ? 'goal' : 'concede'); // melodic buzz when we score
      // A TUTORIAL GOAL GETS THE BADGE TOO. It used to be withheld here, and the reason recorded was
      // real: the comic word sits at H*0.40 with a starburst reaching S*0.30 above it, and the coach's
      // caption sits at top:64px — on a landscape phone those overlap, so the word lands on the next
      // lesson's instruction. But withholding it left a kid who had just scored with a jingle and an
      // empty screen, which is not the trade anybody wanted (user, having played it on his phone:
      // "when player make a goal in this training put the goal badge").
      // So the collision is answered instead of avoided, in two ways that cost nothing:
      //   * the CAPTION steps aside while the word is up (`.tutorial.celebrating`, toggled in tuTick)
      //     — during the goal beat the standing instruction is one the kid has just obeyed, so there
      //     is nothing to cover up;
      //   * the word is cut to ONE beat instead of the match's 2.3s, because the next step now lands
      //     ~1s after the goal (TU_GOAL_HOLD) and its instruction must not wait on an animation.
      // (tuFinish()'s confetti is the reward for finishing a whole level and is untouched.)
      confettiBurst(ourGoal ? 90 : 45);        // the stands erupt on a goal
      triggerCelebration(ourGoal ? 'goal-us' : 'goal-them', tutorial ? { dur: TU_CELEB_SEC } : null);
      crowdHypeT = performance.now();          // crowd leaps up, then settles over ~2.5s
    }
    // TUTORIAL: the ball came LOOSE off an enemy carrier — that is the strip step's whole lesson,
    // and the moment its caption flips from «חטוף!» to «גול!». Read here, where both the previous
    // and the current owner are in hand.
    if (tutorial && previousBallOwner && snap.ball.owner === null) {
      const prev = (snap.players || []).find((p) => p.id === previousBallOwner);
      if (prev && prev.team !== me.team) tuEv.stripped = true;
    }
    if (previousBallOwner === null && snap.ball.owner !== null) {
      // My own pickup = full (it's at me); an OTHER player's is distance-attenuated like every positional SFX.
      playSound('pickup', snap.ball.owner === me.playerId ? 0.55 : 0.28 * proximity(snap.ball.x, snap.ball.y), snap.ball.owner === me.playerId ? 1.08 : 0.96);
    }
    const newBlasts = (snap.blasts || []).filter((b) => !knownBlasts.has(b.id));
    // TUTORIAL: a blast that went off ON TOP of the step's marked foe completes the bomb step.
    // Deliberately not "any blast" — aiming the lob IS the lesson — but bombHit() is generous
    // (1.5x the blast radius), because a kid whose throw lands a sprite short has understood it.
    if (tutorial && newBlasts.length) {
      const st = stepAt(tuLvl, tuStage);
      const foe = st && st.done === 'bombHitFoe' ? tuFoePos(st.markerKey) : null;
      if (foe && newBlasts.some((b) => bombHit(b.x, b.y, foe.x, foe.y))) tuEv.bombHitFoe = true;
      // ...and a blast that goes off under MY OWN feet arms the fly step: if real distance follows
      // within the next moment or so, that was a rocket jump (see tuTick).
      if (rendered && newBlasts.some((b) => Math.hypot(b.x - rendered.x, b.y - rendered.y) < BOMB.radius)) {
        tuSelfBlastAt = performance.now();
        tuSelfBlastPos = { x: rendered.x, y: rendered.y };
      }
    }
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
      // TUTORIAL: landing a shot on ANY enemy is a hit. Nothing shoots back in there, so a
      // player-impact IS the kid hitting something. Latched, not sampled: a dropped frame must not
      // lose the hit that finishes the lesson.
      // quickHit and chargedHit are that same hit ATTRIBUTED to the gesture that fired it, and both
      // have to be assembled here because the two halves arrive at different times: the release is
      // local and instant (releaseShot stamps tuQuickShotAt under QUICK_CHARGE and tuFullShotAt at
      // FULL_CHARGE), the impact comes back off the wire a bullet-flight plus an RTT later.
      // Anything inside the window is that release's bullet — a bullet only lives PROJECTILE.ttl
      // (1.3s) whatever its charge, and releaseShot clears each stamp on a release of the other
      // kind, so neither gesture can ever inherit the other's hit.
      // chargedHit is the FULL-shot step's whole predicate: the hold, plus proof it was aimed.
      if (tutorial && pl && pl.team !== me.team) {
        tuEv.hitEnemy = true;
        const now = performance.now();
        if (tuQuickShotAt && now - tuQuickShotAt <= TU_SHOT_HIT_MS) tuEv.quickHit = true;
        if (tuFullShotAt && now - tuFullShotAt <= TU_SHOT_HIT_MS) tuEv.chargedHit = true;
      }
    }
    for (const b of snap.bombs || []) if (!knownBombs.has(b.id)) {            // planted a bomb
      // A LOB lands up to BOMB_LOB_RANGE (250) from the planter, so a proximity search near the
      // landing spot misses the thrower and the arc collapses to a teleport. Resolve the planter
      // by OWNER id (carried on the wire) and only fall back to proximity if they've left the view.
      const pl = players.find((q) => q.id === b.owner) || nearestPlayer(players, b.x, b.y, 70, b.team);
      if (pl) triggerAnim(pl.id, 'bomb');
      bombSpawnT.set(b.id, performance.now());                                // fly-in intro; ring/dust fire on impact (see drawBomb)
      bombSrc.set(b.id, pl ? { x: pl.x, y: pl.y } : { x: b.x, y: b.y });      // arc FROM the thrower to where it lands
    }
    for (const w of snap.walls || []) if (!knownWalls.has(w.id)) {            // built a wall
      // TUTORIAL: a fresh wall completes the fence step. Nothing else on that pitch builds —
      // the sentry never does — so a new wall is unambiguously the kid's.
      if (tutorial) tuEv.wallBuilt = true;
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
const screens = { start: startEl, home: homeEl, friends: friendsEl, lobby: lobbyEl, game: gameEl,
  profile: document.getElementById('profile') };   // own-profile stats page (public/profile.js)
let sticksReady = false; // set once the touch-stick system is initialised (below); gates refreshSticks() from showScreen
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
  // The connection warning belongs to the PITCH. renderFrame() stops drawing off the pitch, so
  // without this the last frame's bars/toast/spinner freeze on top of the hub — the player sees
  // «חיבור לא יציב» in a menu, with nothing running and nothing to clear it.
  if (name !== 'game') hideNetHud();
  if (sticksReady) refreshSticks(); // show the always-on joysticks on the pitch, hide them elsewhere
}

// Home + friends refs.
const homeOnlineEl = document.getElementById('home-online');
const homeFaceEl = document.getElementById('home-face');
// ---- Own profile page (public/profile.js) ---------------------------------
// Tapping your own avatar opens it. #home-face had NO handler at all before this.
// The page is shown IMMEDIATELY with the numbers the game already holds (cards, hero, arenas,
// trophies), then re-rendered when the career block arrives — so it never shows a blank frame and
// never depends on the API being reachable.
function profileArenaCount() {
  try { const a = JSON.parse(localStorage.getItem('pikme-fields') || '[]'); return Array.isArray(a) ? a.length : 0; }
  catch { return 0; }
}
// The career block. This MUST follow the same routing rule as fetchOwnProgress(): on a dev/LAN host
// pikme-server's CORS allowlist excludes us, so a direct call is discarded by the browser no matter
// what the API answers — /dev/progress is the game server's own same-origin passthrough. In the app,
// /handle-friends/rank is the only token-authed route that can resolve who we are.
async function fetchOwnStats() {
  const phone = (() => { try { return _params.get('phone'); } catch { return null; } })();
  try {
    if (DEV_HOST) return await apiGet(`/dev/progress${phone ? `?phone=${encodeURIComponent(phone)}` : ''}`, true);
    if (FOOTBALL_TOKEN) return await apiGet('/handle-friends/rank');
    return phone ? await apiGet(`/handle-user/football/stats?phone=${encodeURIComponent(phone)}`) : null;
  } catch { return null; }
}
function profileInputs() {
  const cards = myCards();
  return {
    xpState: currentXpState(), rank: window.SALTIZ_RANK || null,
    cards, cosmetic: myCosmetic || DEFAULT_COSMETIC,
    unlockedHeroes: unlockedHeroCount(), loadout: rankForLoadout(cards).slice(0, 3),
    heroPlays: readHeroPlays((k) => localStorage.getItem(k)),
    bestBotLevel: readBestBotLevel((k) => localStorage.getItem(k)),
    arenaCount: profileArenaCount(), friendCount: FRIENDS.length,
  };
}
async function openProfile() {
  const root = document.getElementById('profile');
  if (!root) return;
  const opts = { name: MY_NAME, drawHero, onBack: () => showScreen('home') };
  showScreen('profile');
  renderProfile(root, buildProfileModel(profileInputs()), opts);
  const stats = await fetchOwnStats();
  // Only repaint if the player is still ON the page — a late response must not yank them back.
  if (stats && !screens.profile.classList.contains('hidden')) {
    renderProfile(root, buildProfileModel({ ...profileInputs(), stats }), opts);
  }
}
homeFaceEl?.addEventListener('click', () => { unlockAudio(); openProfile(); });
homeFaceEl?.setAttribute('role', 'button');
homeFaceEl?.setAttribute('aria-label', 'הפרופיל שלי');
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
// My display identity, captured at connect. `connect(name, avatar)` takes these as parameters, and
// during a SEARCH there is no lobby payload echoing my member back, so the search screen has no other
// source for my own row.
let myDisplayName = 'שחקן', myAvatarUrl = null;
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
// Fallback host was https://pikme-server.onrender.com, which is DEAD (Render answers a plain-text
// 404). In-app that never showed because the app injects window.PIKME_API, but any browser test —
// phone Safari against the Render game, or a LAN IP — got silently broken friends and DMs with no
// error anywhere. The live API is server.pikme.tv; only a true localhost page assumes a local one.
const PIKME_API = (window.PIKME_API || (location.hostname === 'localhost' ? 'http://localhost:3001' : 'https://server.pikme.tv')).replace(/\/$/, '');

// ---- RANK self-fetch --------------------------------------------------------
// The hub badge reads window.SALTIZ_RANK, which the app WebView injects. That inject only exists in
// app builds we don't control, and never in a browser — so without this the badge silently falls
// back to the legacy xp level and the whole RANK ladder is invisible outside a fresh app build.
// We fetch our OWN standing and write the SAME global, so pollRank() picks it up unchanged.
//
// The app stays authoritative: it injects a per-match `delta` we cannot know, so a real inject is
// never overwritten. Two sources, in order of trust:
//   1. football token  → GET /handle-friends/rank   (identity from the signed token)
//   2. ?phone=         → GET /handle-user/football/stats?phone=…  (unauthenticated, browser testing)
// delta stays 0: this is a standing read, not a match result, and a wrong delta would animate a
// jump that never happened.
//
// ⚠️ THIS BLOCK MUST STAY ABOVE startHomeDance() (which is *invoked* at module level and calls
// loop() SYNCHRONOUSLY on its first frame → fetchOwnRank()). It shipped below it once and the hub
// died on the device with "Cannot access '_rankSelfAt' before initialization" — a TDZ crash that
// neither the source-assertion tests nor a curl of the served bytes can see, because neither
// EXECUTES the module. `apiGet` is a hoisted function declaration, so calling it from up here is
// fine; `let`/`const` state is not hoisted, which is the whole trap.
const RANK_SELF_MS = 60000;      // standing barely moves outside a match; don't hammer the API
let _rankSelfAt = 0, _rankSelfBusy = false;
// Which globals did WE fill? We may refresh our own values, but an app inject is authoritative and
// must never be clobbered — so we only ever overwrite what we wrote.
let _mineRank = false, _mineXp = false;
// Fetches BOTH progression numbers, because they have the same problem and the same source.
//
// גביעים/xp used to be app-inject-only with no fallback: renderHubXp() reads window.SALTIZ_XP and
// otherwise shows `DEV_LOCAL ? 1240 : 0`, and DEV_LOCAL is only localhost/127.0.0.1/0.0.0.0. So on
// ANY other surface — the LAN IP the user tests from, prod in a browser, or an app build older than
// the SALTIZ_XP inject — the trophies bar sat at 0 and could never move, no matter what the server
// held. That is exactly what "I won against bots and my trophies did not go up" was: the server had
// 1840, the bar was reading its own hardcoded 0.
// One call serves both: /handle-friends/rank and /football/stats?phone= each return xp, level AND
// rankPoints/rankTier.
async function fetchOwnProgress() {
  const needRank = !window.SALTIZ_RANK || _mineRank;
  const needXp = !window.SALTIZ_XP || _mineXp;
  if (!needRank && !needXp) return;                     // the app injected both — it wins, always
  if (_rankSelfBusy) return;
  const now = performance.now();
  if (_rankSelfAt && now - _rankSelfAt < RANK_SELF_MS) return;
  const phone = (() => { try { return _params.get('phone'); } catch { return null; } })();
  if (!FOOTBALL_TOKEN && !phone) return;                // no identity, nothing to ask for
  _rankSelfBusy = true;
  try {
    // pikme-server's CORS is an allowlist that covers the Render game origin but NOT localhost or a
    // LAN IP, so on a dev surface the direct call is discarded by the browser no matter what the API
    // returns. DEV_HOST (localhost + private ranges) routes through the game server's own
    // same-origin /dev/progress passthrough instead; the app and prod keep calling the API directly.
    const r = DEV_HOST
      ? await apiGet(`/dev/progress${FOOTBALL_TOKEN ? '' : `?phone=${encodeURIComponent(phone)}`}`, true)
      : FOOTBALL_TOKEN
        ? await apiGet('/handle-friends/rank')
        : await apiGet(`/handle-user/football/stats?phone=${encodeURIComponent(phone)}`);
    _rankSelfAt = performance.now();
    if (!r) return;
    // A pre-rank backend answers 200 with no rankPoints — that is "not deployed yet", not rank 0,
    // so leave SALTIZ_RANK unset and let the legacy xp badge stand.
    const rp = Number(r.rankPoints);
    if (Number.isFinite(rp) && (!window.SALTIZ_RANK || _mineRank)) {
      window.SALTIZ_RANK = { rankPoints: rp, rankTier: r.rankTier || null, delta: 0, botLevel: null };
      _mineRank = true;
    }
    // Trophies. Only `xp` is required — `level` is derived by levelFromXp() when absent, so a
    // backend that stops sending it still works. 0 is a legitimate value for a new player, so the
    // test is isFinite, not truthiness.
    const xp = Number(r.xp);
    if (Number.isFinite(xp) && (!window.SALTIZ_XP || _mineXp)) {
      const lvl = Number(r.level);
      window.SALTIZ_XP = Number.isFinite(lvl) && lvl > 0 ? { xp, level: lvl } : { xp };
      _mineXp = true;
    }
  } finally { _rankSelfBusy = false; }
}
// Kept as an alias: the hub loop and any other caller still say fetchOwnRank().
const fetchOwnRank = fetchOwnProgress;
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
// ---- PRIVATE-HOST TEST HOOK -----------------------------------------------------------------
// DEV_LOCAL is deliberately NOT widened: it also drives DEV_SAMPLE_CARDS, the fake-XP fallbacks at
// three sites and the dev reveal panels, so broadening it would silently switch those on for every
// LAN visitor. DEV_HOST is a SEPARATE predicate used only for the difficulty pin below.
// Why this exists: difficulty comes from window.SALTIZ_XP, which only the app injects, so on the
// LAN IP the fallback was xp 0 => level 0 — the WEAKEST tier in the game, on BOTH sides. Every
// browser test session was testing a tier no real player ever meets.
const DEV_HOST = DEV_LOCAL || /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?)/.test(location.hostname);
// ?diff=N pins the bot difficulty for this page load. Read from the URL ONLY (never persisted),
// and only honoured on a private host, so a public deployment cannot be handed an easy-bot farm.
// ---- ?watch=1 — WATCH the bots instead of playing them --------------------------------------
// Requested: "I don't want to play it, I want to watch a real life simulation for all bots."
// Joins a bot-only room (server: startSpectate) and renders it with the real client: real arena,
// real physics, real server-side AI, all four players bots. Combine with ?diff=N to pick the level.
// URL-only and DEV_HOST-gated, exactly like DIFF_PIN below — a public visitor cannot spin up rooms.
// No client-side "spectator" plumbing is needed beyond this: matchStart arrives with playerId null,
// and flushInput() already refuses to send without one.
let SPECTATING = false;   // set by enterMatch when the server says this is a watch-only room
const WATCH = (() => {
  try { return /[?&]watch=1\b/.test(location.search); } catch { return false; }
})();

const DIFF_PIN = (() => {
  if (!DEV_HOST) return null;
  const raw = new URLSearchParams(location.search).get('diff');
  if (raw == null || raw === '' || !/^\d+$/.test(raw)) return null;
  return clampLevel(parseInt(raw, 10));
})();
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
// ---- LEVEL 4's sandbox flag ------------------------------------------------------------
// The hub tour teaches on a MOCK lobby it draws itself (see tuMockBuild), so it never touches the
// real album, loadout or hero at all. These guards stay anyway, as a cheap invariant: while the
// tutorial is running, nothing it does is ever persisted. That matters because saveLoadout and
// saveCosmetic both reach postPrefs(), which the app writes to the server under the player's
// PHONE NUMBER — so "the tutorial cannot write" is worth enforcing rather than assuming.
//
// Declared up here rather than in the hub-tour block below: the write guards read it, and
// module-scope rendering runs long before that block is evaluated (a `let` down there would be
// read before its declaration and throw a temporal-dead-zone ReferenceError at load).
let tuHub = false;
function tuHubRunning() { return tuHub; }

function myCards() {
  const raw = Array.isArray(window.SALTIZ_CARDS) ? window.SALTIZ_CARDS.slice(0, 256)
    : (DEV_LOCAL ? DEV_SAMPLE_CARDS : []);
  return raw.map((c) => (c && typeof c.r === 'string' && c.r !== c.r.toLowerCase())
    ? { ...c, r: c.r.toLowerCase() } : c);
}
// Hero unlocks: every 7 DISTINCT cards owned opens the next hero, in rarity order
// (striker → alien). 0-6 → striker only, 7-13 → +dwarf, etc. Always ≥1 (striker free).
//
// ⚠️ THIS WAS HARDCODED `true` AND SHIPPED (found 2026-07-27, from the user: "now they are unlocked
// for all heroes"). It short-circuits BOTH unlockedHeroCount() and isHeroUnlocked(), so every hero was
// open to everyone and the card-count gate above had simply never run in production. It arrived inside
// `c58c327 checkpoint: parallel agents' in-flight work` — a batch commit, which is how a debug switch
// gets pushed without anyone reviewing it as a decision.
//
// Now OPT-IN PER LOAD, not ambient: `?heroes=all`. It is deliberately NOT tied to DEV_LOCAL or
// DEV_HOST, because a gate that behaves one way on a laptop and another on a phone is the trap this
// repo keeps paying for — the LAN surface silently running difficulty LEVEL 0 invalidated a whole
// round of bot reports the same way. One value everywhere, and an explicit query flag when you want to
// look at every hero.
const DEV_UNLOCK_ALL = new URLSearchParams(location.search).get('heroes') === 'all';
function distinctOwnedCount() { return new Set(myCards().map((c) => c.r + '/' + c.n)).size; }
function unlockedHeroCount() { return DEV_UNLOCK_ALL ? HERO_KEYS.length : Math.max(1, Math.min(HERO_KEYS.length, Math.floor(distinctOwnedCount() / 7) + 1)); }
function isHeroUnlocked(hk) { if (DEV_UNLOCK_ALL) return HERO_KEYS.includes(hk); const i = HERO_KEYS.indexOf(hk); return i >= 0 && i < unlockedHeroCount(); }
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
    // Decode OFF the main thread so a card finishing doesn't hitch the 120Hz loop; marks
    // ready when fully decoded (preload at matchStart warms the whole crowd before kickoff).
    if (img.decode) img.decode().then(() => { img.ready = true; audNeedsRebake = true; }).catch(() => {});
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
  renderHubTier();     // the badge over the hero: RANK when the app injects it, legacy XP level otherwise
  _cardsSig = cardsSig();
  _cardsOnlySig = cardsOnlySig();
}

// Album-derived stats + collector rank on the home hub — all from myCards(), so it
// works the moment the app injects window.SALTIZ_CARDS. The 3rd chip upgrades from
// "copies" to real total views automatically if the app ever injects window.SALTIZ_PROFILE.views.
let _cardsSig = '';
let _cardsOnlySig = ''; // deep album fingerprint; distinguishes an album change from an xp-only change
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
// Deep album fingerprint: every card's rarity+number+count (sorted, order-independent) so ANY
// add/remove/count change trips the hub poll — the old first-card-only hash missed swaps.
function cardsOnlySig() {
  const c = myCards();
  return c.length + ':' + c.map((x) => x.r[0] + x.n + 'x' + x.c).sort().join(',');
}
function cardsSig() {
  const x = window.SALTIZ_XP;
  return cardsOnlySig() + '|' + (x ? (x.xp ?? x.level ?? '') : '');
}
// The app changed the album while we're live. Reconcile everything that references cards:
//   • push the fresh album to the server (was frozen at join → stale loadout/bot-buff validation),
//   • eagerly drop loadout slots whose card is gone (so they can't silently reappear if re-added),
//   • demote a now-locked selected hero to the best still-unlocked one.
function reconcileOnCardChange() {
  sendMsg({ type: 'setCards', cards: myCards() });
  if (Array.isArray(myLoadout)) {
    const cleaned = [0, 1, 2].map((i) => validSlot(myLoadout[i]));
    const changed = [0, 1, 2].some((i) => {
      const a = myLoadout[i] ? { r: myLoadout[i].r, n: +myLoadout[i].n } : null;
      return JSON.stringify(a) !== JSON.stringify(cleaned[i]);
    });
    if (changed) { myLoadout = cleaned; saveLoadout(myLoadout); sendMsg({ type: 'setLoadout', loadout: myLoadout }); }
  }
  const cut = myCosmetic.indexOf(':'), hero = cut >= 0 ? myCosmetic.slice(0, cut) : myCosmetic;
  if (!isHeroUnlocked(hero)) {
    const best = HERO_KEYS[unlockedHeroCount() - 1];
    myCosmetic = normalizeCosmetic(best + ':' + (cut >= 0 ? myCosmetic.slice(cut + 1) : 'base'));
    saveCosmetic(myCosmetic); sendMsg({ type: 'setCosmetic', cosmetic: myCosmetic });
  }
}
function renderHubStats() {
  const cards = myCards();
  const owned = new Set(cards.map((c) => c.r + '/' + c.n)).size;   // distinct cards owned, of the 200-card album (r+n = one card)
  const worth = cards.reduce((s, c) => s + (c.w || 0), 0);
  const copies = cards.reduce((s, c) => s + (c.c || 1), 0);        // total copies held (duplicates included)
  const views = window.SALTIZ_PROFILE && Number(window.SALTIZ_PROFILE.views);
  setTxt('hub-count', owned + '/200');
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
// ---- XP reward reveal state (post-match) — see the reveal module below renderHubXp ----
let _xpShown = null;        // xp value currently reflected on the hub bar
let _xpRevealing = false;   // while true the reveal animation OWNS the bar (the 700ms poll must not snap it)
let _awaitXpReveal = false; // a match just ended -> the NEXT xp increase should celebrate (not silently snap)
const XP_REDUCE = matchMedia('(prefers-reduced-motion: reduce)').matches;
function renderHubXp() {
  const el = document.getElementById('hub-xp'); if (!el) return;
  const src = window.SALTIZ_XP;
  const xp = src && Number.isFinite(+src.xp) ? +src.xp : (DEV_LOCAL ? 1240 : 0); // honest level-1 default until the app injects XP
  if (!_xpRevealing) _xpShown = xp;   // keep the tracker synced with what's shown (unless a reveal is animating)
  const level = src && +src.level ? +src.level : levelFromXp(xp);
  const base = 50 * level * (level - 1), span = 100 * level;
  const into = Math.max(0, xp - base), pct = span ? Math.max(0, Math.min(1, into / span)) : 0;
  // This bar is now גביעים (trophies) — the MONOTONIC collectible. Same number as before (xp), new
  // name + a pixel-art trophy, because "XP" read like a second ranking next to the rank badge.
  // The RANK (losable) is the badge over the hero. See shared/rank.js for the terminology note.
  el.innerHTML = '<div class="hub-xp-top"><span class="hub-xp-lvl">רמה <b>' + level + '</b></span>'
    + '<span class="hub-xp-amt"><span class="saltiz-icon si-trophy" aria-hidden="true"></span>'
    + '<span dir="ltr">' + fmtCompact(into) + ' / ' + fmtCompact(span) + '</span>'
    + ' ' + TROPHIES_HE + '</span></div>'
    + '<div class="hub-xp-bar"><b style="width:' + (pct * 100).toFixed(1) + '%"></b></div>';
  el.classList.remove('hidden');
}

// ============================================================================
// XP REWARD REVEAL — when you land back on the hub after a match:
//   (1) a big "+N XP" number pops in the CENTRE of the screen and METEORS down
//       onto the XP bar, (2) the bar fills with a shower of confetti, and
//   (3) on a level-up the new "רמה N" drops in from the centre, then the bar
//       resets and keeps filling. Data-driven: it animates from the xp last
//       shown to the new window.SALTIZ_XP the app injects on return (on
//       localhost there's no app, so we simulate the gain — see below).
// ============================================================================
function currentXpRaw() {
  const s = window.SALTIZ_XP;
  return s && Number.isFinite(+s.xp) ? +s.xp : (DEV_LOCAL ? 1240 : 0);
}
// Update the EXISTING hub bar DOM in place (no innerHTML rebuild) to a given xp.
function setXpBar(xp) {
  const el = document.getElementById('hub-xp'); if (!el) return;
  let bar = el.querySelector('.hub-xp-bar > b'), lvlB = el.querySelector('.hub-xp-lvl b'), amt = el.querySelector('.hub-xp-amt');
  if (!bar || !lvlB || !amt) { renderHubXp(); bar = el.querySelector('.hub-xp-bar > b'); lvlB = el.querySelector('.hub-xp-lvl b'); amt = el.querySelector('.hub-xp-amt'); if (!bar) return; }
  const level = levelFromXp(xp), base = 50 * level * (level - 1), span = 100 * level;
  const into = Math.max(0, xp - base), pct = span ? Math.max(0, Math.min(1, into / span)) : 0;
  lvlB.textContent = level;
  // Keep the trophy: this is the גביעים bar, and textContent alone would strip the icon. It is now
  // the icon pack's real cup (si-trophy) instead of the hand-built box-shadow one in rank.css.
  amt.innerHTML = '<span class="saltiz-icon si-trophy" aria-hidden="true"></span>'
    + '<span dir="ltr">' + fmtCompact(into) + ' / ' + fmtCompact(span) + '</span>'
    + ' ' + TROPHIES_HE;
  bar.style.width = (pct * 100).toFixed(1) + '%';
}
function _xpEase(p) { return 1 - Math.pow(1 - p, 3); }
function _xpTween(dur, upd, done) {
  if (XP_REDUCE) { upd(1, 1); done && done(); return; }
  const t0 = performance.now();
  (function fr(now) { let p = Math.min(1, (now - t0) / dur); upd(_xpEase(p), p); if (p < 1) requestAnimationFrame(fr); else done && done(); })(performance.now());
}
// --- full-screen confetti + big-number overlay (its own layer; the game's
//     confettiBurst is world-space on the match canvas, unusable on the hub) ---
let _xpFxCv = null, _xpFxCtx = null, _xpBig = null, _xpFxParts = [], _xpFxRAF = null, _xpFxLast = 0;
function xpFxEnsure() {
  if (_xpFxCv) return;
  const root = document.createElement('div'); root.id = 'xp-reveal';
  _xpFxCv = document.createElement('canvas'); _xpFxCv.id = 'xp-confetti';
  _xpBig = document.createElement('div'); _xpBig.id = 'xp-bignum';
  root.appendChild(_xpFxCv); root.appendChild(_xpBig); document.body.appendChild(root);
  _xpFxCtx = _xpFxCv.getContext('2d');
  _xpFxCv.width = innerWidth * devicePixelRatio; _xpFxCv.height = innerHeight * devicePixelRatio;
  _xpFxCtx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
}
function xpConfetti(n) {
  xpFxEnsure();
  for (let i = 0; i < n; i++) _xpFxParts.push({
    x: Math.random() * innerWidth, y: -10 - Math.random() * 50,
    vx: (Math.random() * 2 - 1) * 90, vy: 120 + Math.random() * 200,
    rot: Math.random() * 6.28, vr: (Math.random() * 2 - 1) * 11,
    col: CONFETTI_COLS[(Math.random() * CONFETTI_COLS.length) | 0],
    life: 1.7 + Math.random() * 1.3, sz: 7 + Math.random() * 8,
  });
  if (!_xpFxRAF) { _xpFxLast = performance.now(); _xpFxRAF = requestAnimationFrame(xpFxLoop); }
}
function xpFxLoop(now) {
  const dt = Math.min(0.05, (now - _xpFxLast) / 1000); _xpFxLast = now;
  const c = _xpFxCtx;
  if (_xpFxCv.width !== innerWidth * devicePixelRatio || _xpFxCv.height !== innerHeight * devicePixelRatio) {
    _xpFxCv.width = innerWidth * devicePixelRatio; _xpFxCv.height = innerHeight * devicePixelRatio;
    c.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  }
  c.clearRect(0, 0, innerWidth, innerHeight);
  for (let i = _xpFxParts.length - 1; i >= 0; i--) {
    const p = _xpFxParts[i]; p.vy += 320 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt; p.life -= dt;
    if (p.life <= 0 || p.y > innerHeight + 24) { _xpFxParts.splice(i, 1); continue; }
    c.save(); c.globalAlpha = Math.min(1, p.life); c.translate(p.x, p.y); c.rotate(p.rot);
    c.fillStyle = p.col; c.fillRect(-p.sz / 2, -p.sz / 2, p.sz, p.sz * 1.5); c.restore();
  }
  if (_xpFxParts.length) _xpFxRAF = requestAnimationFrame(xpFxLoop);
  else { _xpFxRAF = null; c.clearRect(0, 0, innerWidth, innerHeight); }
}
// Pop a big number in the centre, hold, then meteor it down to `rectGetter()`.
function xpBigNum(text, color, isLevel, rectGetter, onLanded) {
  xpFxEnsure();
  const w = _xpBig; w.textContent = text; w.style.color = color; w.style.direction = isLevel ? 'rtl' : 'ltr'; w.style.display = 'block';
  const cx = innerWidth / 2, cy = innerHeight / 2;
  const r = rectGetter && rectGetter();
  const tx = r ? (r.left + r.width / 2 - cx) : 0;
  const ty = r ? (r.top + r.height / 2 - cy) : -cy * 0.55;
  const frames = [
    { transform: 'translate(-50%,-50%) scale(.2)', opacity: 0, offset: 0 },
    { transform: 'translate(-50%,-50%) scale(1.16)', opacity: 1, offset: .17, easing: 'cubic-bezier(.2,1.7,.4,1)' },
    { transform: 'translate(-50%,-50%) scale(1)', opacity: 1, offset: .36 },
    { transform: `translate(calc(-50% + ${tx}px), calc(-50% + ${ty}px)) scale(.34)`, opacity: .95, offset: .9, easing: 'cubic-bezier(.5,0,.9,1)' },
    { transform: `translate(calc(-50% + ${tx}px), calc(-50% + ${ty}px)) scale(.18)`, opacity: 0, offset: 1 },
  ];
  if (!w.animate) { w.style.display = 'none'; onLanded && onLanded(); return; }
  const a = w.animate(frames, { duration: XP_REDUCE ? 280 : 1150, fill: 'forwards' });
  a.onfinish = () => { w.style.display = 'none'; onLanded && onLanded(); };
}
const _hubXpRect = () => { const el = document.getElementById('hub-xp'); return el ? el.getBoundingClientRect() : null; };
// Fill fromXp -> toXp, splitting at each level boundary so a level-up can drop its number.
function fillWithLevels(fromXp, toXp, done) {
  const segs = []; let cur = fromXp, L = levelFromXp(fromXp);
  while (levelFromXp(toXp) > L) { const boundary = 50 * (L + 1) * L; segs.push({ from: cur, to: boundary, up: L + 1 }); cur = boundary; L++; }
  segs.push({ from: cur, to: toXp, up: null });
  const totalGain = Math.max(1, toXp - fromXp); let i = 0;
  (function runSeg() {
    if (i >= segs.length) { done && done(); return; }
    const s = segs[i++]; const dur = Math.max(480, 1500 * (s.to - s.from) / totalGain); let lastBurst = 0;
    _xpTween(dur, (e) => {
      setXpBar(s.from + (s.to - s.from) * e);
      const t = performance.now(); if (t - lastBurst > 85) { lastBurst = t; xpConfetti(3); }
    }, () => {
      if (s.up != null) {                                   // crossed a level
        try { if (typeof playSound === 'function') playSound('win', 0.75); } catch (e) {}
        xpConfetti(60);
        xpBigNum('רמה ' + s.up, '#7bd0ff', true, _hubXpRect, () => runSeg());
      } else runSeg();
    });
  })();
}
// Public entry: play the whole reveal from `fromXp` to `toXp`.
function playXpReveal(fromXp, toXp) {
  if (_xpRevealing || toXp <= fromXp) return;
  _xpRevealing = true; _awaitXpReveal = false;
  xpFxEnsure(); setXpBar(fromXp);
  const gain = Math.round(toXp - fromXp);
  try { if (typeof playSound === 'function') playSound('goalHappy', 0.6); } catch (e) {}
  xpBigNum('+' + fmtCompact(gain) + ' ' + TROPHIES_HE, '#ffcb43', false, _hubXpRect, () => {
    xpConfetti(24);
    fillWithLevels(fromXp, toXp, () => { _xpShown = toXp; _xpRevealing = false; renderHomeCharacter(); });
  });
}
// LOCALHOST ONLY: no native app to inject post-match XP, so fake the bump so the
// reveal is testable on :3012. Alternates a within-level gain and a level-up gain
// so both cases can be seen across successive matches. Never runs on device/Render.
let _devXpN = 0;
function simulateXpGainForDemo() {
  if (!DEV_LOCAL) return;
  const from = currentXpRaw(), L = levelFromXp(from), base = 50 * L * (L - 1), span = 100 * L, into = from - base;
  const levelUp = (_devXpN++ % 2 === 1);
  const gain = levelUp ? (span - into) + Math.round(span * 0.4) : Math.max(30, Math.round((span - into) * 0.6));
  setTimeout(() => { window.SALTIZ_XP = { xp: from + gain }; }, 900); // the 700ms hub poll picks it up -> playXpReveal
}
// LOCALHOST preview: tap the XP bar to play the reveal instantly (alternating a
// normal gain and a level-up) — a match is 120s, too long to test the real flow.
if (DEV_LOCAL) {
  const _xb = document.querySelector('.hub-xpbar') || document.getElementById('hub-xp');
  if (_xb) _xb.addEventListener('click', () => {
    if (_xpRevealing) return;
    const from = currentXpRaw(), L = levelFromXp(from), span = 100 * L, into = from - 50 * L * (L - 1);
    const up = (_devXpN++ % 2 === 1);
    const gain = up ? (span - into) + Math.round(span * 0.4) : Math.max(30, Math.round((span - into) * 0.6));
    window.SALTIZ_XP = { xp: from + gain }; _xpShown = from; playXpReveal(from, from + gain);
  });
}

// LOCALHOST preview for the RANK reveal: tap the badge over the hero to cycle the four cases that
// matter — a gain, a tier promotion, a DROP, and the bot ceiling. There's no app on :3012 to inject
// window.SALTIZ_RANK, and a real match is 120s, so this is the only practical way to eyeball the drop
// treatment. Never runs on device/Render.
if (DEV_LOCAL) {
  const cases = [
    { from: 180, delta: 30, note: 'gain + promotion to כסף' },
    { from: 620, delta: 25, note: 'plain gain in זהב' },
    { from: 620, delta: -8, note: 'a DROP — muted, no celebration' },
    { from: 940, delta: 0, note: 'at the L11 bot ceiling — meter reads LOCKED' },
  ];
  let _devRkN = 0;
  const _rb = document.getElementById('hub-tier');
  if (_rb) _rb.addEventListener('click', () => {
    const c = cases[_devRkN++ % cases.length];
    console.log('[rank preview]', c.note);
    import('/hub-rank.js').then((m) => m.devSimulate(c.from, c.delta));
  });
  // Seed a visible starting state on localhost so the badge shows a real rank before the first tap.
  if (!window.SALTIZ_RANK) window.SALTIZ_RANK = { rankPoints: 620, delta: 0, botLevel: 11 };
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
  // This badge is the RANK (the losable ladder) whenever the app has injected it — that's what a tier
  // badge should actually mean, and its little meter now counts toward the next rank tier.
  // renderHubRank() returns false when there's no rank data (older app build), and we fall back to the
  // legacy XP-level ladder below so the badge is never blank.
  if (renderHubRank()) return;
  box.classList.remove('hub-tier-rank', 'hub-tier-capped');
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
  { icon: '⚡', label: 'בעיטה', buff: 'טעינה', desc: 'הבעיטה נטענת מהר יותר — קל יותר לשחרר בעיטת עוצמה מלאה לעבר השער.' },   // Shot: faster charge
  { icon: '🏃', label: 'מהירות', buff: 'ריצה', desc: 'רצים מהר יותר בלי הכדור — מגיעים ראשונים לכל כדור חופשי.' },            // Speed: faster move
  { icon: '🛡️', label: 'הגנה', buff: 'קירור', desc: 'זמני התאוששות וטעינת קיר קצרים יותר — הפצצה והחומה חוזרות מהר.' },       // Utility: faster cooldowns / wall reload
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
  // LEVEL 4's demo: equip IN MEMORY so the slot fills and the step completes, but write nothing —
  // no localStorage, no postPrefs (the app would persist it under the player's phone), no socket.
  if (tuHub) { myLoadout = eff; renderPowerSlots(); return; }
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
  if (tuHub) { myLoadout = eff; renderPowerSlots(); return; }   // LEVEL 4 lesson: never persisted
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
// Album = a 2×2 grid of tier DECKS; tapping one expands it INLINE into a coverflow carousel.
let cardsOpenTier = null;                                          // null = deck grid; else the open rarity
const cardsCarIdx = { legendary: 0, epic: 0, rare: 0, common: 0 }; // centred card index per tier carousel
const TIER_ORDER = ['legendary', 'epic', 'rare', 'common'];
// The unequipped album cards of one tier, best-worth first — the contents of that tier's deck.
function albumGroup(rar) {
  const eff = effectiveLoadout();
  const isEq = (c) => eff.some((s) => s && s.r === c.r && +s.n === +c.n);
  return myCards().filter((c) => c.r === rar && !isEq(c)).sort((a, b) => (b.w || 0) - (a.w || 0));
}
const albumCardAt = (rar, i) => albumGroup(rar)[i] || null;
// One-shot "landed in a slot" pop — called AFTER renderCardsPage() rebuilds the node.
function popCardsSlot(i) {
  const el = document.querySelector('#cards-slots .pslot[data-slot="' + i + '"]');
  if (!el || el.classList.contains('pslot-empty')) return;   // don't pop an emptied slot
  el.classList.add('pslot-pop');
  el.addEventListener('animationend', () => el.classList.remove('pslot-pop'), { once: true });
}
function renderCardsPage() {
  const slotsEl = document.getElementById('cards-slots');
  const deckEl = document.getElementById('cards-deck');
  if (!slotsEl || !deckEl) return;
  const eff = effectiveLoadout();
  slotsEl.innerHTML = '';
  eff.forEach((card, i) => {
    const meta = SLOT_META[i];
    const item = document.createElement('div');
    item.className = 'pslot-item' + (card ? ' is-filled rarity-' + card.r : ' is-empty');
    const el = document.createElement('div');
    el.className = 'pslot' + (card ? ' rarity-' + card.r : ' pslot-empty') + (i === cardsSelSlot ? ' pslot-sel' : '');
    el.dataset.slot = i;
    // Power-icon coin: ALWAYS visible (card or not) so the player knows what this slot boosts.
    const pwr = document.createElement('span'); pwr.className = 'pslot-pwr'; pwr.textContent = meta.icon; el.appendChild(pwr);
    if (card) el.appendChild(slotCardEl(card, 'pslot-art', 48, 62));
    else { const add = document.createElement('span'); add.className = 'pslot-add pslot-emptyic'; add.textContent = '+'; el.appendChild(add); }
    // Tap = power info; drag a filled slot = swap onto another slot, or drop off every slot to
    // unequip (card returns to its rarity tier). Handled by the delegated bindCardsSlotDrag() below.
    const info = document.createElement('div'); info.className = 'pslot-info';
    const cap = document.createElement('span'); cap.className = 'pslot-cap'; cap.textContent = meta.label;
    const buff = document.createElement('span'); buff.className = 'pslot-buffline';
    if (card) buff.innerHTML = '<b>+' + (RARITY_PCT[card.r] || 0) + '%</b> ' + (meta.buff || 'חוזק');
    else buff.textContent = 'גרור קלף לכאן';
    info.appendChild(cap); info.appendChild(buff);
    item.appendChild(el); item.appendChild(info);
    slotsEl.appendChild(item);
  });
  // ---- Album: a 2×2 grid of tier DECKS; tap one to open its coverflow carousel inline. ----
  if (cardsOpenTier && !albumGroup(cardsOpenTier).length) cardsOpenTier = null;   // opened deck ran dry
  deckEl.className = 'cards-deck ' + (cardsOpenTier ? 'cards-album-open' : 'cards-album-grid');
  deckEl.innerHTML = '';
  if (cardsOpenTier) renderAlbumCarousel(deckEl); else renderAlbumGrid(deckEl);
}

// The 4 tier decks (legendary→common). EVERY tier keeps its square — an empty one shows ×0.
function renderAlbumGrid(deckEl) {
  const grid = document.createElement('div'); grid.className = 'tdeck-grid';
  TIER_ORDER.forEach((rar) => {
    const list = albumGroup(rar);
    const d = document.createElement('div');
    d.className = 'tdeck rarity-' + rar + (list.length ? '' : ' tdeck-empty');
    d.dataset.tier = rar;
    const count = document.createElement('span'); count.className = 'tdeck-count'; count.textContent = '×' + list.length; d.appendChild(count);
    const pile = document.createElement('div'); pile.className = 'tdeck-pile';
    if (list.length) {
      const e1 = document.createElement('div'); e1.className = 'tdeck-edge tdeck-e1';
      const e2 = document.createElement('div'); e2.className = 'tdeck-edge tdeck-e2';
      const top = document.createElement('div'); top.className = 'tdeck-top rarity-' + rar;
      top.appendChild(slotCardEl(list[0], 'tdeck-art', 60, 84));   // best card faces up on the pile
      pile.appendChild(e1); pile.appendChild(e2); pile.appendChild(top);
    } else {
      pile.classList.add('tdeck-pile-empty');
    }
    d.appendChild(pile);
    grid.appendChild(d);
  });
  deckEl.appendChild(grid);
}

// One tier opened: coverflow carousel (swipe to browse; drag the centre card onto a slot to equip).
function renderAlbumCarousel(deckEl) {
  const rar = cardsOpenTier; const list = albumGroup(rar);
  const wrap = document.createElement('div'); wrap.className = 'tcar';
  const top = document.createElement('div'); top.className = 'tcar-top';
  const back = document.createElement('button'); back.type = 'button'; back.className = 'tcar-back'; back.dataset.tcarBack = '1'; back.textContent = '‹ חפיסות';
  const tabs = document.createElement('div'); tabs.className = 'tcar-tabs';
  TIER_ORDER.forEach((r) => {
    const g = albumGroup(r);
    const t = document.createElement('button'); t.type = 'button';
    t.className = 'tcar-tab rarity-' + r + (r === rar ? ' on' : '');
    t.dataset.tcarTab = r; t.textContent = g.length; if (!g.length) t.disabled = true;
    tabs.appendChild(t);
  });
  top.appendChild(back); top.appendChild(tabs); wrap.appendChild(top);
  const stage = document.createElement('div'); stage.className = 'tcar-stage';
  list.forEach((c, i) => {
    const el = document.createElement('div'); el.className = 'tcar-card rarity-' + c.r;
    el.dataset.i = i; el.dataset.r = c.r; el.dataset.n = c.n;
    el.appendChild(slotCardEl(c, 'tcar-art', 96, 130));
    const tag = document.createElement('span'); tag.className = 'tcar-tag'; tag.textContent = '#' + c.n; el.appendChild(tag);
    if (c.w) { const w = document.createElement('span'); w.className = 'tcar-worth'; w.textContent = c.w; el.appendChild(w); }
    if (c.c > 1) { const b = document.createElement('span'); b.className = 'cf-badge'; b.textContent = '×' + c.c; el.appendChild(b); }
    stage.appendChild(el);
  });
  wrap.appendChild(stage);
  const hint = document.createElement('div'); hint.className = 'tcar-hint'; hint.innerHTML = '‹ החליקו לדפדוף · <b>גררו את הקלף המרכזי אל חריץ</b> ›';
  wrap.appendChild(hint);
  deckEl.appendChild(wrap);
  layoutAlbumCarousel();
}

// Coverflow placement: centred card big, neighbours peel back on both sides.
function layoutAlbumCarousel() {
  const rar = cardsOpenTier; if (!rar) return;
  const stage = document.querySelector('#cards-deck .tcar-stage'); if (!stage) return;
  const cards = stage.querySelectorAll('.tcar-card'); if (!cards.length) return;
  const i0 = Math.max(0, Math.min(cardsCarIdx[rar], cards.length - 1)); cardsCarIdx[rar] = i0;
  cards.forEach((el) => {
    const i = +el.dataset.i, off = i - i0, a = Math.abs(off);
    el.style.transform = 'translateX(' + (off * 58) + 'px) scale(' + Math.max(0.6, 1 - a * 0.16) + ')';
    el.style.opacity = a > 2 ? 0 : 1 - a * 0.18;
    el.style.zIndex = 100 - a;
    el.style.pointerEvents = a > 2 ? 'none' : 'auto';
    el.classList.toggle('tcar-center', off === 0);
  });
}
// ---- Album gestures (delegated on #cards-deck; survive re-renders) ----------------------
// GRID:      tap a deck -> open its carousel.
// CAROUSEL:  ‹back -> grid · tab -> switch tier · tap a side card -> centre it ·
//            swipe left/right -> browse · drag the CENTRE card up onto a slot -> equip.
(function bindAlbumDeck() {
  const deck = document.getElementById('cards-deck');
  if (!deck) return;
  // clicks: open a deck, go back, switch tier (buttons/decks sit outside the swipe surface).
  deck.addEventListener('click', (e) => {
    const back = e.target && e.target.closest ? e.target.closest('[data-tcar-back]') : null;
    if (back) { cardsOpenTier = null; renderCardsPage(); return; }
    const tab = e.target && e.target.closest ? e.target.closest('.tcar-tab') : null;
    if (tab) { if (!tab.disabled) { cardsOpenTier = tab.dataset.tcarTab; renderCardsPage(); } return; }
    const td = e.target && e.target.closest ? e.target.closest('.tdeck') : null;
    if (td && !td.classList.contains('tdeck-empty')) { cardsOpenTier = td.dataset.tier; renderCardsPage(); }
  });
  // pointer: carousel swipe + drag-the-centre-card-to-a-slot (mirrors the lobby lift-to-equip).
  let sx = null, sy = null, mode = null, onCenter = false, cardEl = null, ghost = null, pid = null;
  const TH = 8;
  const slotUnder = (x, y) => { const el = document.elementFromPoint(x, y); return el && el.closest ? el.closest('.pslot') : null; };
  const clearOver = () => document.querySelectorAll('.pslot.pslot-over').forEach((s) => s.classList.remove('pslot-over'));
  const reset = () => { if (ghost) { ghost.remove(); ghost = null; } clearOver(); sx = sy = null; mode = null; onCenter = false; cardEl = null; pid = null; };
  deck.addEventListener('pointerdown', (e) => {
    const c = e.target && e.target.closest ? e.target.closest('.tcar-card') : null;
    if (!c) { sx = null; return; }
    cardEl = c; sx = e.clientX; sy = e.clientY; mode = null; pid = e.pointerId;
    onCenter = c.classList.contains('tcar-center');
    try { deck.setPointerCapture(pid); } catch { /* older webviews */ }
  });
  deck.addEventListener('pointermove', (e) => {
    if (sx == null) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (!mode) {
      if (onCenter && dy < -TH && Math.abs(dy) >= Math.abs(dx) * 0.7) mode = 'lift'; // pull the centre card up
      else if (Math.abs(dx) > TH || Math.abs(dy) > TH) mode = 'swipe';
      else return;
    }
    if (mode === 'lift') {
      const card = albumCardAt(cardsOpenTier, cardsCarIdx[cardsOpenTier]); if (!card) return;
      if (!ghost) {
        ghost = document.createElement('div'); ghost.className = 'pslot-ghost rarity-' + card.r;
        const gi = document.createElement('img'); gi.alt = ''; gi.src = `${CARD_ART_BASE}/${card.r}/${card.n}.webp`;
        ghost.appendChild(gi); document.body.appendChild(ghost);
      }
      ghost.style.left = e.clientX + 'px'; ghost.style.top = e.clientY + 'px';
      clearOver(); const s = slotUnder(e.clientX, e.clientY); if (s) s.classList.add('pslot-over');
    }
  });
  const end = (e) => {
    if (sx == null) { reset(); return; }
    if (mode === 'lift') {
      const s = slotUnder(e.clientX, e.clientY);
      const card = albumCardAt(cardsOpenTier, cardsCarIdx[cardsOpenTier]);
      if (s && s.dataset.slot != null && card) { setSlotCard(+s.dataset.slot, { r: card.r, n: +card.n }); renderCardsPage(); popCardsSlot(+s.dataset.slot); }
    } else if (mode === 'swipe') {
      const rar = cardsOpenTier, list = albumGroup(rar), dx = e.clientX - sx;   // drag right→left = next card
      if (dx < -30) cardsCarIdx[rar] = Math.min(list.length - 1, cardsCarIdx[rar] + 1);
      else if (dx > 30) cardsCarIdx[rar] = Math.max(0, cardsCarIdx[rar] - 1);
      layoutAlbumCarousel();
    } else if (cardEl && !cardEl.classList.contains('tcar-center')) {
      cardsCarIdx[cardsOpenTier] = +cardEl.dataset.i; layoutAlbumCarousel();     // tap a side card -> centre it
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
      if (slot && slot.dataset.slot != null) popCardsSlot(+slot.dataset.slot);   // pop the destination on a swap
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
  [0, 1, 2].forEach((i, k) => setTimeout(() => popCardsSlot(i), k * 70));   // staggered "all landed" cascade
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
// In-match HUD: BOTH TEAMS' power cards, flanking the clock/scoreboard — my team on the LEFT rail
// (me first), the opponents on the RIGHT. Same read that Brawl Stars' match HUD gives you: who is on
// the pitch and what they are carrying, without opening anything. Read-only.
//
// It used to be only MY three cards in the top-right corner, which told you nothing about the
// players you were actually up against. Card sources are unchanged — introCardsFor() already resolves
// my LIVE loadout, another player's echoed loadout, and a bot's synthesized one.
const matchPowersEl = document.getElementById('match-powers');
const matchPowersFoeEl = document.getElementById('match-powers-foe');
// One rail = one row per player. `mine` marks my own row so it reads as "you" at a glance.
function fillPowerRail(rail, players, teamCls) {
  if (!rail) return;
  rail.innerHTML = '';
  rail.classList.toggle('mpwr-foe-rail', teamCls === 'foe');
  for (const p of players) {
    const row = document.createElement('div');
    row.className = 'mpwr-row' + (p.id === myMemberId ? ' mpwr-me' : '');
    const who = document.createElement('span');
    who.className = 'mpwr-who';
    const isBot = !!(p.isBot || p.bot) || !p.name;
    who.textContent = p.id === myMemberId ? 'אני' : (isBot ? '🤖' : memberInitials(p.name));
    who.title = p.name || 'בוט';
    const cards = document.createElement('span');
    cards.className = 'mpwr-cards';
    const list = introCardsFor(p);
    // A player with no cards still gets a row (their seat exists) — three empty frames, so the rail
    // never silently shrinks and re-flows mid-match when a loadout echo arrives late.
    for (let i = 0; i < 3; i++) {
      const c = list[i];
      const el = document.createElement('div');
      el.className = 'mpwr' + (c ? ' rarity-' + c.r : ' mpwr-empty');
      if (c) el.appendChild(slotCardEl(c, 'mpwr-art', 26, 34));
      cards.appendChild(el);
    }
    row.append(who, cards);
    rail.appendChild(row);
  }
}
function renderMatchPowers() {
  const hud = document.getElementById('hud');
  const myTeam = me.team === 'B' ? 'B' : 'A';
  // Order: me first, then team-mates — my own cards stay in the same place every match.
  const sortMine = (a, b) => (a.id === myMemberId ? -1 : b.id === myMemberId ? 1 : 0);
  const mine = matchRoster.filter((p) => p && p.team === myTeam).sort(sortMine);
  const foe = matchRoster.filter((p) => p && p.team !== myTeam);
  // No roster yet (training ground, or a mode that sends none): fall back to just my own loadout so
  // the rail is never empty where it used to show my three cards.
  fillPowerRail(matchPowersEl, mine.length ? mine : [{ id: myMemberId, name: 'אני' }], 'mine');
  fillPowerRail(matchPowersFoeEl, foe, 'foe');
  // Card size is driven off the format: 5 rows of full-size cards would eat the top of the screen.
  if (hud) hud.dataset.teamSize = String(Math.max(1, matchTeamSize | 0 || 2));
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
      if (now - lastCardCheck > 700 && !_xpRevealing) {  // while a reveal animates, it OWNS the bar — don't snap it
        lastCardCheck = now;
        // RANK arrives on its own channel (window.SALTIZ_RANK), so it needs its own check —
        // cardsSig() only tracks the album + xp and would miss a rank-only change.
        // fetchOwnRank() is a no-op when the app injected; otherwise it fills the same global
        // (rate-limited internally) so the badge works in a browser and in pre-rank app builds.
        fetchOwnRank();
        pollRank();
        const sig = cardsSig();
        if (sig !== _cardsSig) {
          const newXp = currentXpRaw();
          // Album changed (not just xp) -> reconcile loadout/hero + push fresh cards to the server.
          if (cardsOnlySig() !== _cardsOnlySig) { _cardsOnlySig = cardsOnlySig(); reconcileOnCardChange(); }
          // A match just ended and the app injected MORE xp -> celebrate the gain instead of snapping.
          if (_awaitXpReveal && _xpShown != null && newXp > _xpShown + 0.5) {
            _cardsSig = sig;                       // consume the signature so we don't also snap-render
            playXpReveal(_xpShown, newXp);
          } else renderHomeCharacter();
        }
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
  const fxCanvas = document.getElementById('wardrobe-fx');
  const heroFx = fxCanvas ? mountHeroFx(fxCanvas) : null;   // per-hero ambience background
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
      el.classList.toggle('locked', !isHeroUnlocked(el.dataset.hero)); // req5: shadow un-owned heroes
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
    b.addEventListener('click', () => { sel.skin = sk; refreshTierSel(); refreshHeroSel(); refreshName(); commit(); });
    tiersEl.appendChild(b);
  });
  HERO_KEYS.forEach((hk) => {
    const cell = document.createElement('button');
    cell.className = 'pick-hero'; cell.dataset.hero = hk;
    const c = document.createElement('canvas'); c.width = 66; c.height = 78;
    const lbl = document.createElement('span'); lbl.textContent = HERO_NAMES[hk];
    cell.appendChild(c); cell.appendChild(lbl);
    cell.addEventListener('click', () => {
      if (!isHeroUnlocked(hk)) { toast(`נעול — ${(HERO_KEYS.indexOf(hk) * 7)} קלפים לפתיחה`); return; } // req4: locked heroes not selectable
      sel.hero = hk; if (heroFx) heroFx.setHero(hk); refreshHeroSel(); refreshSkinThumbs(); refreshName(); commit();
    });
    heroesEl.appendChild(cell);
  });

  function open() {
    unlockAudio();
    const cut = myCosmetic.indexOf(':');
    sel = { hero: myCosmetic.slice(0, cut), skin: myCosmetic.slice(cut + 1) };
    if (!isHeroUnlocked(sel.hero)) sel.hero = HERO_KEYS[unlockedHeroCount() - 1]; // clamp to best unlocked
    refreshTierSel(); refreshHeroSel(); refreshSkinThumbs(); refreshName();
    overlay.classList.remove('hidden');
    if (heroFx) { heroFx.resize(); heroFx.setHero(sel.hero); heroFx.start(); }
    if (!previewRAF) {
      const loop = () => {
        const t = performance.now();
        previewCtx.clearRect(0, 0, previewCv.width, previewCv.height);
        previewCtx.imageSmoothingEnabled = false;
        const sf = previewCv.height / 44, ox = previewCv.width / 2, feetY = previewCv.height - sf * 5; // headroom so tall hats / hover / sig skins never clip the bitmap
        drawHero(previewCtx, ox, feetY, sf, Math.sin(t * 0.0009), t * 0.008, 0.7, false, `${sel.hero}:${sel.skin}`, PREVIEW_KIT, t / 1000);
        previewRAF = requestAnimationFrame(loop);
      };
      loop();
    }
  }
  function close() { overlay.classList.add('hidden'); if (heroFx) heroFx.stop(); if (previewRAF) { cancelAnimationFrame(previewRAF); previewRAF = null; } }
  // req2: no save button — every hero/costume tap auto-saves. Last pressed is the one kept.
  function commit() {
    myCosmetic = normalizeCosmetic(`${sel.hero}:${sel.skin}`);
    saveCosmetic(myCosmetic);
    sendMsg({ type: 'setCosmetic', cosmetic: myCosmetic });
    restartHomeRoutine();                       // fresh dance routine on every hero/costume change
  }

  btnOpen.addEventListener('click', open);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); }); // outside-click closes (no ✕, no save)
  // …and a VISIBLE way out, to match every other page. back-nav.js generates the «‹ חזרה» pill and
  // gives it this id (its EXITS table), so the button lands on close() — which stops the hero-fx
  // canvas and cancels the preview rAF. Bound by delegation because that button is created after this
  // IIFE runs: back-nav.js is a classic script and this module is deferred.
  overlay.addEventListener('click', (e) => { if (e.target?.closest?.('#hero-picker-close')) close(); });
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

// ---- MODES: one source of truth for every mode surface ----------------------
// There used to be FOUR hand-written copies of the mode list (#arena, #party,
// #game-select, plus the hub strip). They drifted: goal-brawl went live on the
// server but stayed «בקרוב» in three of them, and the #arena launcher forgot to
// send diffLevel so its bots never XP-scaled. Both bugs were only possible
// because the list was duplicated. Add a mode HERE and every surface updates.
//
//   state 'live' — playable now
//   state 'dev'  — not built yet; renders locked and says so when tapped
//   party        — offerable inside a private/party room (`ready` carries `game`)
//   launch()     — how the PUBLIC queue for this mode is joined
// `hue` drives the card's title band — one colour per mode, so you can tell them apart at a
// glance (Brawl Stars' colour dictionary). `art` is the pixel scene id in mode-art.js.
// `soon` is what a not-yet-built mode promises INSTEAD of a bare «בקרוב».
const MODES = [
  {
    id: '2v2', ic: '⚽', name: 'כדורגל · 2 נגד 2', sub: 'אצטדיון הבלוקים',
    meta: ['ראשון ל-3', 'עד 2 דק׳'], hue: ['#7fd48f', '#4fae66'],
    // `format` ties this row to the server's FORMATS key, so the VS/teams page can name the mode
    // you're waiting in. Every matchmade row needs one.
    state: 'live', party: true, format: 'quick',
    // A deliberate mode pick (this card) carries the 10s matchmaking budget, unlike the yellow
    // quick-match button (5s) — both resolve to the same server format, so only the message they
    // send can tell the two entry points apart. `matchmade` is that split; `quickMatch` keeps its own.
    launch: () => sendMsg({ type: 'matchmade', format: 'quick', diffLevel: xpDiffLevel(), trophies: myTrophies() }),
  },
  {
    id: 'brawl', ic: '🥅', name: 'קרב על השער', sub: 'אצטדיון הבלוקים',
    meta: ['הכי הרבה גולים', '2 דקות'], hue: ['#ffd06a', '#e8a02f'],
    state: 'live', party: true, format: 'brawl',
    launch: () => sendMsg({ type: 'goalBrawl', diffLevel: xpDiffLevel(), trophies: myTrophies() }),
  },
  {
    id: '3v3', ic: '⚽', name: 'כדורגל · 3 נגד 3', sub: 'מגרש שלושות · יותר טירוף',
    meta: ['ראשון ל-3', '6 שחקנים'], hue: ['#8fb6ef', '#4f7fd4'],
    // party: a private room may play 3v3 too. The server applies the format the moment the host picks
    // it (`partyGame`), which is what raises the room's capacity from 4 to 6 — without that the card
    // was pickable but the 5th friend hit "החדר מלא".
    state: 'live', party: true, format: '3v3',
    launch: () => sendMsg({ type: 'matchmade', format: '3v3', diffLevel: xpDiffLevel(), trophies: myTrophies() }),
  },
  {
    id: 'cup', ic: '🏆', name: 'טורניר', sub: 'עונתי · סוללת משחקים',
    meta: ['עונה 1', 'בפיתוח'], hue: ['#e0a2f0', '#a45cc4'], state: 'dev', soon: 'עונה 1',
  },
];
const modeById = (id) => MODES.find((m) => m.id === id) || null;
// Join a mode's public queue. Every launcher goes through here so the audio unlock and
// the loadout sync can never be forgotten on one path (which is how #arena's bots ended
// up unscaled — that launcher had drifted from the gold button's).
function launchMode(id) {
  const m = modeById(id);
  if (!m || m.state !== 'live' || !m.launch) return;
  unlockAudio(); syncLoadout(); m.launch();
}

// Render one surface. `kind` is 'launch' (joins a public queue straight away) or
// 'party' (picks the game for a private room — the room start sends it as `game`).
// Live modes first, dev tail last. Locked cards stay TAPPABLE and explain themselves
// rather than being dead pixels.
//
// BOTH surfaces now draw the SAME portrait pixel-art card; the party surfaces (the team page and the
// host's picker sheet) just render it one size down (`pc-mini`). They used to be a separate list of
// text rows (`.modecard`), so the game you pick with friends looked nothing like the game you pick in
// the lobby — two visual languages for one choice. `kind` still drives FILTER + BEHAVIOUR, only the
// look is now shared.
function renderModeList(el) {
  const kind = el.dataset.modes === 'party' ? 'party' : 'launch';
  const list = MODES.filter((m) => (kind === 'party' ? m.party || m.state === 'dev' : true));
  const live = list.filter((m) => m.state === 'live');
  const dev = list.filter((m) => m.state !== 'live');
  el.innerHTML = '';
  for (const m of [...live, ...dev]) {
    const card = document.createElement('button');
    card.dataset.modeId = m.id;
    card.dataset.modeKind = kind;
    // The PICKER card: coloured title band · pixel-art scene · rule strip. Four fit across the
    // landscape stage at full size; the mini variant fits the same four inside a panel.
    card.className = 'pcard' + (kind === 'party' ? ' pc-mini' : '') + (m.state === 'live' ? '' : ' lock');
    card.style.setProperty('--band-hi', m.hue[0]);
    card.style.setProperty('--band-lo', m.hue[1]);
    card.innerHTML = `<span class="pc-band"><span class="pc-ic">${m.ic}</span>`
      + `<span class="pc-tx"><b>${m.name}</b><small>${m.sub}</small></span></span>`
      + `<span class="pc-art"><canvas class="pc-cv" aria-hidden="true"></canvas></span>`
      + (m.state === 'live'
        ? `<span class="pc-meta"><span>${m.meta[0]}</span><span>${m.meta[1]}</span></span>`
        : `<span class="pc-soon">${m.soon || 'בקרוב'}</span>`);
    el.appendChild(card);
    drawModeArt(card.querySelector('.pc-cv'), m.id);
  }
}
function renderAllModeLists() { document.querySelectorAll('.mode-list').forEach(renderModeList); }
renderAllModeLists();

// One delegated handler for every surface — the reason a new mode needs no new wiring.
document.addEventListener('click', (e) => {
  const card = e.target.closest('[data-mode-id]'); // .modecard (party rows) or .pcard (picker)
  if (!card) return;
  const m = modeById(card.dataset.modeId);
  if (!m) return;
  if (m.state !== 'live') { toast('בקרוב — עוד לא מוכן'); return; } // tappable, not dead
  if (card.dataset.modeKind === 'party') {
    unlockAudio(); syncLoadout();
    // TEAM PAGE (#party): only the HOST's tap is a decision — it is a ROOM fact (capacity, arena and
    // win rule all follow from it, and every member's team page shows it), so it lands immediately
    // via `partyGame` and groups everyone up. Anyone ELSE's tap is a VOTE — visible to the whole
    // room as a glow (renderPartyVotes), but it changes nothing about the room and does not
    // navigate anywhere; `partyGame` is the only message that can start the match (item 3).
    if (card.closest('#party')) {
      if (isRoomHost) {
        selectedGame = m.id;
        sendMsg({ type: 'partyGame', game: m.id });
        closePartyChatSheet();
        showScreen('lobby');
      } else {
        sendMsg({ type: 'partyVote', game: m.id });
      }
      return;
    }
    // Private/party room, OUTSIDE #party (the game-select picker overlay — see openGameSelect):
    // remember the pick; the room start sends it as `game`. Which flow we're in is decided by the
    // CONTAINER, not by gameSelectMode — that flag is stale state from whichever flow opened the
    // overlay last.
    selectedGame = m.id;
    if (!pendingPartyApply) sendMsg({ type: 'partyGame', game: m.id });
    closeGameSelect();
    if (gameSelectMode === 'setup') { pendingPartyApply = true; sendMsg({ type: 'createRoom' }); } // → roomJoined applies picks
    else { sendMsg({ type: 'ready', game: selectedGame }); toast('מתחילים…'); }
    return;
  }
  launchMode(m.id);
});

// ---- Lobby-redesign sub-screens (arena / news / shop / clubs) ---------------
// Register the new .screen divs so the existing showScreen() drives open/close.
// 'thread' is registered here but deliberately NOT in the tap-outside-to-dismiss list below —
// a conversation shouldn't close on a stray tap next to a bubble.
// 'friend-select' is deliberately NOT registered here: it is a MODAL over #party now (opened/closed
// directly via openInviteSheet/closeInviteSheet, same pattern as #game-select), not a page
// showScreen() should ever hide #party for or vice-versa.
for (const id of ['arena', 'news', 'shop', 'clubs', 'cards', 'rank', 'party', 'thread']) {
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
  if (t.closest('button, a, input, textarea, select, label, [role="button"], [contenteditable], .pslot, .pslot-item, .tdeck, .tcar, .friend-row, .fr-tab')) return false;
  // Dismiss only on the page's own EMPTY structural whitespace — outer padding of the sub-page,
  // the body's gaps/side-margins, the header whitespace, or a bare heading. Visible content tiles
  // (shop items, news/club cards, mode cards, …) are the "main area" and are left alone, so the
  // default is always keep-open — content or controls added by other agents never trigger it.
  return t.matches('.subpage, .subpage-body, .subpage-head, h2');
}
for (const id of ['arena', 'news', 'shop', 'clubs', 'rank', 'cards', 'friends', 'profile']) {
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
// The #arena launchers are gone — that list is rendered from MODES and handled by the
// delegated .modecard[data-mode-id] listener. The hub strip's goal-brawl shortcut stays
// (it is a baked layout box), but it launches THROUGH the table so it can never drift.
document.getElementById('goal-brawl-btn')?.addEventListener('click', () => launchMode('brawl'));

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
// Named so LEVEL 4's finale can start a real match itself. It must NOT do that by synthesising a
// click on the button: the tutorial's own capture-phase handler swallows that click on purpose, and
// syncLoadout() below would push the tutorial's demo album to the server if it ran before teardown.
function startQuickMatch() { unlockAudio(); syncLoadout(); sendMsg({ type: 'quickMatch', diffLevel: xpDiffLevel(), trophies: myTrophies() }); }
document.getElementById('quick-match-btn').addEventListener('click', startQuickMatch);
// Cancel a live search. Hidden once a group resolves — at that point a room exists and the match is
// about to start, so "cancel" would mean leaving a match, not a queue.
document.getElementById('ti-search-cancel')?.addEventListener('click', () => {
  if (!searchingLive) return;
  sendMsg({ type: 'cancelSearch' });
  hideSearching(); quickVs = false; hideVs(); showScreen('home');
});
document.getElementById('friends-btn').addEventListener('click', () => {
  unlockAudio(); showScreen('friends');
  const s = document.getElementById('friend-search'); if (s) s.value = '';
  renderSearch([]); setFriendsTab('list');
  loadFriends(); // #3: refresh on open (also self-heals a failed initial load / WS reconnect)
  loadThreads(); // unread dots + last-message previews on the friend cards
});
document.getElementById('training-btn').addEventListener('click', () => { unlockAudio(); document.getElementById('train-choose')?.classList.remove('hidden'); });
document.getElementById('tc-cancel')?.addEventListener('click', () => document.getElementById('train-choose')?.classList.add('hidden'));
// The training ground opens AT the picked level (the server used to always start it at the default,
// so the sentry ignored the picker until you re-picked mid-session). Change it live with the 🤖 chip.
document.getElementById('tc-ground')?.addEventListener('click', () => { document.getElementById('train-choose')?.classList.add('hidden'); unlockAudio(); sendMsg({ type: 'training', diffLevel }); });
document.getElementById('tc-bots')?.addEventListener('click', () => { document.getElementById('train-choose')?.classList.add('hidden'); unlockAudio(); syncLoadout(); sendMsg({ type: 'botGame', diffLevel }); }); // play-with-bots uses the manual difficulty picker (change it live in settings)
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
// Play with friends: team-first. «שחק עם חברים» creates the party room and lands straight on the
// team page (#party) — there is no separate invite-first step. Inviting happens FROM the team page,
// via the `+` tile next to the hero (opens #friend-select as a modal — see openInviteSheet below).
document.getElementById('play-friends-btn')?.addEventListener('click', () => {
  unlockAudio();
  openPartyDirect();
});
function openPartyDirect() {
  // roomCode is cleared with lastLobby, not left behind: the code chip falls back to it, and a fresh
  // party rendered before `roomJoined` lands would otherwise flash the PREVIOUS room's number — a
  // number a kid might read out to a friend before the real one arrives.
  selectedGame = null; partyFlow = true; invitedSet.clear(); lastLobby = null; roomCode = '';
  syncLoadout(); loadFriends();      // refresh presence so the roster's `+` sheet has fresh candidates
  partyRenderSig = '';               // force a real rebuild even if a previous party left the same sig
  showScreen('party'); renderParty(); // show the team page IMMEDIATELY (solo empty state) — don't wait on the round-trip
  sendMsg({ type: 'createRoom' });    // roomJoined lands the real room a beat later and re-renders
}
// Friends screen is friends-only (look / add / remove). Room create/join moved to the
// «שחק עם חברים» party flow. The screen matches the clubs sub-page layout and has NO back
// button — you leave by tapping the empty background (see isDismissBackdrop wiring above).

// Friends redesign: segmented tabs (list · requests · add). Panes keep the original ids so
// loadFriends()/searchFriends()/render* are untouched — this only shows/hides the panes.
function setFriendsTab(tab) {
  document.querySelectorAll('#friends .fr-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('#friends .fr-pane').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== tab));
  if (tab === 'add') { const s = document.getElementById('friend-search'); if (s) setTimeout(() => s.focus(), 40); }
  if (tab === 'online') renderOnlineFriends();
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
  sendMsg({ type: 'ready', game: selectedGame }); // party picks land here via #party / #game-select
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
// The approval panel is drawn into EVERY container that wants one, not into a single element.
//
// THE BUG THIS FIXES, end to end: a friend who joins by CODE does not enter the room — the server
// puts them in `room.pending`, sends them `joinPending` (the «ממתין לאישור המארח…» overlay) and sends
// the HOST a `joinRequest`. The host's only way to answer it was `#room-requests`, which lives inside
// `#lobby`. But the whole play-with-friends flow lands on `#party` instead (openPartyDirect, and every
// lobby payload re-asserts it), so #lobby is never on screen for the person holding the decision. The
// request was therefore unanswerable: the host saw a friend "waiting", the friend waited for ever, and
// nobody was told why. So the panel now exists on both screens and both are filled from here.
const roomRequestHosts = () => [roomRequestsEl, document.getElementById('party-requests')].filter(Boolean);
function renderRoomRequests() {
  const reqs = isRoomHost ? [...pendingReqs.values()] : [];
  for (const host of roomRequestHosts()) {
    host.innerHTML = '';
    host.classList.toggle('hidden', reqs.length === 0);
    if (!reqs.length) continue;
    const h = document.createElement('div'); h.className = 'room-req-h'; h.textContent = 'בקשות הצטרפות';
    host.appendChild(h);
    for (const r of reqs) {
      const row = document.createElement('div'); row.className = 'room-req';
      const av = document.createElement('div'); av.className = 'room-req-av';
      if (r.avatar) av.style.backgroundImage = `url("${r.avatar}")`; else av.textContent = memberInitials(r.name);
      const nm = document.createElement('div'); nm.className = 'room-req-name'; nm.textContent = r.name || 'שחקן';
      const ok = document.createElement('button'); ok.className = 'room-req-ok'; ok.textContent = 'אישור';
      const no = document.createElement('button'); no.className = 'room-req-no'; no.textContent = 'דחייה';
      // Listeners per rendered row, as before. decideRequest re-renders BOTH panels, so answering on
      // one screen clears the row from the other — the two copies cannot disagree.
      ok.addEventListener('click', () => decideRequest(r.joinerId, true));
      no.addEventListener('click', () => decideRequest(r.joinerId, false));
      row.append(av, nm, ok, no);
      host.appendChild(row);
    }
  }
}
function decideRequest(joinerId, accept) {
  sendMsg({ type: ROOM_MSG.DECIDE, joinerId, accept });
  pendingReqs.delete(joinerId);         // resolved locally; the server won't re-notify for this one
  renderRoomRequests();
}
function kickMember(memberId) { sendMsg({ type: ROOM_MSG.KICK, memberId }); }
// Party-roster kick (item 5): same confirm PATTERN as removeFriend() — a destructive action on
// another person asks first. The #lobby team-row kick above stays as it was (no confirm); this is
// a NEW affordance on the #party roster blocks, so it gets the confirm the task asked for without
// changing the existing control's behaviour. The server enforces host-only regardless (kick is
// refused for a non-host in server.js), so this confirm is UX, not the real guard.
function confirmKickMember(memberId, name) {
  if (!confirm(`להסיר את ${name || 'השחקן'} מהקבוצה?`)) return;
  kickMember(memberId);
}

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
async function apiGet(path, sameOrigin) {
  try {
    // sameOrigin: hit THIS server instead of PIKME_API (used by the /dev/progress passthrough, which
    // exists precisely because the API's CORS allowlist excludes dev hosts).
    const r = await fetch(sameOrigin ? path : `${PIKME_API}${path}`, { headers: apiHeaders() });
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
async function apiDelete(path) {
  try {
    const r = await fetch(`${PIKME_API}${path}`, { method: 'DELETE', headers: apiHeaders() });
    if (!r.ok) { toast('החיבור נכשל, נסה שוב'); return false; }
    return true;
  } catch { toast('החיבור נכשל, נסה שוב'); return false; }
}

// (fetchOwnRank lives up with PIKME_API — it must be initialized before startHomeDance() runs.)

// The named SALTIZ BOT friends — אורי / פז / נווה / שובל. Identity, level and the 3 power slots all
// come from shared/saltiz-bots.js, which the SERVER reads too, so the cards on the friend card are
// the cards the bot actually plays with (display == gameplay) without the client stating either.
//
// They are OPT-IN as of 2026-07-26: no longer pinned into everyone's list. You find one by typing its
// name in the add-friend tab and tap הוסף, exactly like a real player — the difference being that
// "friendship" with a bot is local (they have no account to write a friends map on), so it lives in
// localStorage under a PREF_KEYS key and therefore follows the account across devices via the prefs
// bag. Removing one is the same gesture as removing a real friend (openFriendProfile → הסר חבר).
const BOT_FRIENDS = SALTIZ_BOTS.map((b) => {
  const loadout = saltizBotLoadout(b);
  const cards = loadout.filter(Boolean).map((s) => ({ r: s.r, n: s.n, c: 1, w: 0 }));
  return {
    userId: b.id, nickName: b.nickName, isBot: true, color: b.color,
    level: b.level, botLevel: botLevelOf(b), xp: xpForSaltizBot(b),
    cards, owned: cards.length, worth: 0,
  };
});
const BOT_FRIENDS_KEY = 'saltizBotFriends';
// ids of the bots this player added. Unknown ids are dropped on read, so retiring a bot from the
// roster can never leave a ghost row in someone's list.
function loadAddedBots() {
  try {
    const raw = JSON.parse(localStorage.getItem(BOT_FRIENDS_KEY) || '[]');
    return new Set((Array.isArray(raw) ? raw : []).filter((id) => SALTIZ_BOT_BY_ID.has(id)));
  } catch { return new Set(); }
}
let ADDED_BOTS = loadAddedBots();
function saveAddedBots() {
  // Writing through localStorage.setItem is what schedules the cross-device prefs push (the hook
  // installed at PREF_KEYS) — don't "optimise" this into an in-memory-only update.
  try { localStorage.setItem(BOT_FRIENDS_KEY, JSON.stringify([...ADDED_BOTS])); } catch { /* private mode */ }
}
const addedBotFriends = () => BOT_FRIENDS.filter((b) => ADDED_BOTS.has(b.userId));
function addBotFriend(id) {
  if (!SALTIZ_BOT_BY_ID.has(id) || ADDED_BOTS.has(id)) return false;
  ADDED_BOTS.add(id); saveAddedBots(); return true;
}
function removeBotFriend(id) {
  if (!ADDED_BOTS.delete(id)) return false;
  saveAddedBots(); return true;
}
let FRIENDS = addedBotFriends();   // [{userId, nickName, image, isBot?}] — real friends + added bots
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
  // No app identity (web/dev, or token not injected): the REST list is unreachable, but the bots the
  // player added are local, so show those rather than a blank panel.
  if (!FOOTBALL_TOKEN || !MY_USER_ID) { FRIENDS = addedBotFriends(); renderFriends(); return; }
  if (friendsBusy) return;
  friendsBusy = true;
  listMsg('friend-list', 'טוען חברים…');
  const res = await apiGet('/handle-friends');
  friendsBusy = false;
  if (res === null) { FRIENDS = addedBotFriends(); renderFriends(); return; } // load failed → at least the bots
  const real = Array.isArray(res) ? res : [];
  sendMsg({ type: 'setFriends', friends: real.map((f) => f.userId) }); // real ids only (presence)
  FRIENDS = [...real, ...addedBotFriends()];
  renderFriends();
  loadRequests();
}

// Green bulb on the hub friends button whenever at least one friend is online.
function updateFriendsDot() {
  const d = document.getElementById('friends-dot');
  if (d) d.classList.toggle('hidden', ONLINE.size === 0);
}
async function loadRequests() {
  const reqs = await apiGet('/handle-friends/requests');       // secondary list — stay silent on error
  renderRequests(Array.isArray(reqs) ? reqs : []);
}
// The named bots that match this query and aren't already in the list. Resolved LOCALLY: they have no
// account for the server's nickName search to find, so they'd be unsearchable if we waited on the API.
// That also means they still work with no identity and when the API is down — which is the point of
// having house players at all.
const botSearchHits = (q) => searchSaltizBots(q)
  .filter((b) => !ADDED_BOTS.has(b.id))
  .map((b) => BOT_FRIENDS.find((f) => f.userId === b.id))
  .filter(Boolean);

async function searchFriends(q) {
  if (!q || q.length < 2) { renderSearch([]); return; }
  const bots = botSearchHits(q);
  // Bots first: they're the only results guaranteed to be addable right now, and they're what a
  // player typing "פז" is looking for.
  if (!MY_USER_ID) {
    if (bots.length) { renderSearch(bots); return; }
    listMsg('friend-search-results', 'התחברו דרך האפליקציה כדי לחפש');
    return;
  }
  const seq = ++searchSeq;
  listMsg('friend-search-results', 'מחפש…');
  const res = await apiGet(`/handle-friends/search?q=${encodeURIComponent(q)}`);
  if (seq !== searchSeq) return;                                // a newer query already fired
  if (res === null) { renderSearch(bots); if (!bots.length) listMsg('friend-search-results', 'החיפוש נכשל — נסו שוב'); return; }
  const found = [...bots, ...(Array.isArray(res) ? res : [])];
  if (!found.length) { listMsg('friend-search-results', 'לא נמצאו תוצאות'); return; }
  renderSearch(found);
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
  if (f.isBot) {
    const tag = document.createElement('span'); tag.className = 'friend-bot-tag';
    tag.textContent = opts.kind === 'search' ? `🤖 בוט · רמה ${f.level || 1}` : '🤖 בוט';
    div.appendChild(tag);
    // In the LIST a bot has no challenge button (it's invited from the party panel, not challenged);
    // in SEARCH it falls through to the add button below.
    if (opts.kind !== 'search') return div;
  }
  const btn = document.createElement('button');
  btn.className = 'friend-act';
  if (opts.kind === 'search') {
    btn.textContent = 'הוסף';
    // A bot friendship is local (no account to request), so adding is instant — no pending state.
    if (f.isBot) btn.onclick = () => { if (addBotFriend(f.userId)) { btn.textContent = 'נוסף'; btn.disabled = true; toast(`${f.nickName} נוסף לחברים`); loadFriends(); } };
    else btn.onclick = async () => { if (await apiPost('/handle-friends/request', { toUserId: f.userId })) { btn.textContent = 'נשלח'; btn.disabled = true; } };
  }
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
const friendCardsCache = new Map(); // userId -> [{r,n}] top cards (lazy, per session)

// Render 3 power slots into `container`: filled with top-3 art, empty = dashed placeholder.
function paintFriendSlots(container, cards) {
  container.innerHTML = '';
  const top = rankFriendTop(cards, 3);
  for (let i = 0; i < 3; i++) {
    const c = top[i];
    const slot = document.createElement('div');
    slot.className = 'fc-slot' + (c ? ' rarity-' + c.r : ' fc-slot-empty');
    if (c) {
      const im = document.createElement('img'); im.className = 'fc-slot-art'; im.loading = 'lazy'; im.alt = '';
      im.onerror = () => im.removeAttribute('src'); im.src = `${CARD_ART_BASE}/${c.r}/${c.n}.webp`;
      slot.appendChild(im);
    }
    container.appendChild(slot);
  }
}

// Fill a friend's slots: bots/inline cards render immediately; real friends lazy-fetch (cached).
function fillFriendSlots(container, f) {
  const inline = Array.isArray(f.cards) ? f.cards : null;
  if (inline) { paintFriendSlots(container, inline); return; }
  const cached = friendCardsCache.get(f.userId);
  if (cached) { paintFriendSlots(container, cached); return; }
  paintFriendSlots(container, []); // placeholders while loading
  if (!f.userId || !FOOTBALL_TOKEN) return;
  apiGet(`/handle-friends/${f.userId}/cards`).then((res) => {
    const cards = res && Array.isArray(res.cards) ? res.cards : [];
    friendCardsCache.set(f.userId, cards);
    if (container.isConnected) paintFriendSlots(container, cards);
  });
}

// Rich friend card: profile pic, name, presence, always-present stats row + 3 power slots.
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
  // Unread count for this friend's thread.
  const unread = threadUnread(f.userId);
  if (unread) { const u = document.createElement('span'); u.className = 'fc-unread'; u.textContent = unread > 9 ? '9+' : String(unread); top.appendChild(u); }
  main.appendChild(top);
  // Stats row — always shown, zeros when unknown. Replaced by the last message when there is one,
  // so the list reads like a conversation list once people start talking.
  //
  // That last message is a SPEECH BUBBLE tailed at the badge and running left, not the flat preview
  // line it used to be: this is the same chat as the lobby's, so it gets the same plate (see .pr-say)
  // and the tail says which of the two people in the row said it. It renders through the same span →
  // .fc-say path whichever kind the message is, so a preset, a typed line and a shared arena can't
  // end up looking like three different features.
  const meta = document.createElement('div'); meta.className = 'fc-meta';
  const last = (THREADS.get(f.userId) || {}).last;
  const preview = msgPreview(last);
  if (preview) {
    // The TAIL is what claims authorship, so it only points at the badge when THEY sent the message.
    // My own last message gets the same plate with no tail and the thread's "mine" colours — a bubble
    // growing out of their badge with my words in it says the wrong thing about who spoke.
    meta.classList.add('fc-say');
    if (last && last.fromUserId === MY_USER_ID) meta.classList.add('mine');
    const say = document.createElement('span');
    say.textContent = preview;                       // always textContent: a typed line is the sender's words
    meta.appendChild(say);
  }
  else meta.textContent = ['דרגה ' + (f.level || 0), 'XP ' + fmtCompact(f.xp || 0), 'שווי ' + fmtCompact(f.worth || 0), 'קלפים ' + (f.owned || 0)].join(' · ');
  main.appendChild(meta);
  // Power slots — always 3; filled with top cards (inline for bots, lazy-fetched for real friends).
  const slots = document.createElement('div'); slots.className = 'fc-slots';
  main.appendChild(slots);
  fillFriendSlots(slots, f);
  div.append(pfp, main);
  // Tapping the card opens the conversation (the standard chat-list gesture); the AVATAR still
  // opens the profile modal, so #5 stays reachable in one tap. Bots have no thread, so their
  // card keeps the original profile-on-tap behaviour.
  pfp.addEventListener('click', (e) => { e.stopPropagation(); openFriendProfile(f); });
  div.addEventListener('click', () => { if (canMessage(f)) openThread(f); else openFriendProfile(f); });
  return div;
}
// Compact friend profile modal (#5): hero avatar, top power cards, division + XP/worth/owned.
function openFriendProfile(f) {
  const modal = document.getElementById('friend-profile-modal'); if (!modal) return;
  const pfp = document.getElementById('fp-pfp'); pfp.innerHTML = ''; pfp.style.background = '';
  const img = (f.image || '').toString();
  if (/^https?:\/\//i.test(img)) { const im = document.createElement('img'); im.src = img; im.alt = ''; pfp.appendChild(im); }
  else { pfp.textContent = memberInitials(f.nickName); if (f.color) pfp.style.background = f.color; }
  document.getElementById('fp-online').classList.toggle('hidden', !(ONLINE.has(f.userId) || f.isBot));
  document.getElementById('fp-name').textContent = f.nickName || '';
  const { tier, sub } = rankTierFromLevel(f.level || 0);
  document.getElementById('fp-div').textContent = `${tier.ic} ${tier.label} ${sub}`;
  document.getElementById('fp-stats').textContent = ['XP ' + fmtCompact(f.xp || 0), 'שווי ' + fmtCompact(f.worth || 0), 'קלפים ' + (f.owned || 0)].join(' · ');
  fillFriendSlots(document.getElementById('fp-slots'), f); // reuses the shared cache from B4
  // Remove lives HERE and nowhere else on purpose: the friend list's own gesture is tap-to-chat, and a
  // × sitting next to it on a scrolling touch list deletes people by accident.
  const rm = document.getElementById('fp-remove');
  if (rm) {
    rm.classList.remove('hidden');
    rm.textContent = 'הסר חבר';
    rm.disabled = false;
    rm.onclick = () => removeFriend(f, rm);
  }
  modal.classList.remove('hidden');
}
// Remove a friend — a bot is local state, a real friend is the server's `DELETE /handle-friends/:id`
// (which unfriends BOTH sides). Confirmed first: it is not undoable for a real friend, who has to
// re-accept a fresh request.
async function removeFriend(f, btn) {
  if (!f || !confirm(`להסיר את ${f.nickName || 'החבר'} מרשימת החברים?`)) return;
  if (btn) { btn.disabled = true; btn.textContent = 'מסיר…'; }
  const ok = f.isBot ? removeBotFriend(f.userId) : await apiDelete(`/handle-friends/${f.userId}`);
  if (!ok) { if (btn) { btn.disabled = false; btn.textContent = 'הסר חבר'; } return; }
  // Drop it from the local view immediately, then reconcile with the server list.
  FRIENDS = FRIENDS.filter((x) => x.userId !== f.userId);
  partySel.delete(f.userId);            // an invite pick can't survive the friendship
  friendCardsCache.delete(f.userId);
  closeFriendProfile();
  renderFriends();
  toast(`${f.nickName || 'החבר'} הוסר`);
  loadFriends();
}
function closeFriendProfile() { document.getElementById('friend-profile-modal')?.classList.add('hidden'); }
document.getElementById('fp-close')?.addEventListener('click', closeFriendProfile);
document.getElementById('friend-profile-modal')?.addEventListener('click', (e) => { if (e.target.id === 'friend-profile-modal') closeFriendProfile(); });
function renderFriends() {
  const el = document.getElementById('friend-list');
  if (el) {
    if (!FRIENDS.length) { listMsg('friend-list', 'עדיין אין חברים — חפשו כינוי כדי להוסיף'); }
    else { el.innerHTML = ''; FRIENDS.forEach((f) => el.appendChild(friendCardEl(f))); }
  }
  renderPartyInvite();
}
// Connected tab: only friends currently online (bots count as always-online, matching friendCardEl).
function renderOnlineFriends() {
  const el = document.getElementById('friend-online');
  if (!el) return;
  const online = FRIENDS.filter((f) => ONLINE.has(f.userId) || f.isBot);
  const badge = document.getElementById('fr-online-badge');
  if (badge) { badge.textContent = String(online.length); badge.classList.toggle('hidden', online.length === 0); }
  if (!online.length) { listMsg('friend-online', 'אף חבר לא מחובר כרגע'); return; }
  el.innerHTML = '';
  online.forEach((f) => el.appendChild(friendCardEl(f)));
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

// --------------------------------------------------------------------------
// Friend threads — preset phrases, short typed lines, and shared arenas (pikme-server
// /handle-messages).
//
// Phrase WORDING lives in shared/quick-messages.js and never travels — the backend stores only the
// id, so phrases can change without a backend deploy and an unknown id is simply skipped by an older
// client.
//
// A typed line (`kind: 'text'`) is the one message that carries the sender's own words. It is capped
// at FREE_TEXT_MAX and run through the SHARED sanitizer, and pikme-server re-runs its own copy of
// that same sanitizer, so the composer's counter and what actually gets stored cannot disagree. The
// cap is the width of the bubble it renders in, which is also what stops this from turning into a
// general messaging surface: a friend thread is people who added each other, same audience as a
// private party room.
//
// Bot friends have no real userId, so they have no thread (their card opens the profile).
// --------------------------------------------------------------------------
const THREADS = new Map();      // friendUserId -> { unread, last }
let threadWith = null;          // the friend whose thread is open
let threadMsgs = [];            // messages in the open thread, oldest first
let threadPollT = 0;

// apiPost() returns a boolean; sending needs the created message back, so this variant
// returns the parsed body (or null on failure) without duplicating the error toast.
async function apiPostJson(path, body) {
  try {
    const r = await fetch(`${PIKME_API}${path}`, { method: 'POST', headers: apiHeaders(), body: JSON.stringify(body) });
    if (!r.ok) { toast(r.status === 429 ? 'שלחת יותר מדי הודעות, רגע…' : 'השליחה נכשלה'); return null; }
    return await r.json();
  } catch { toast('השליחה נכשלה'); return null; }
}

// Can this friend be messaged at all? Bots aren't real accounts, and without an app token
// there's no identity to send as.
function canMessage(f) { return !!(f && f.userId && !f.isBot && FOOTBALL_TOKEN && MY_USER_ID); }

function threadUnread(userId) { return (THREADS.get(userId) || {}).unread || 0; }
function totalUnread() { let n = 0; for (const t of THREADS.values()) n += t.unread || 0; return n; }

// One-line preview of a message for the friend card ('' when this build can't render it).
function msgPreview(m) {
  if (!m) return '';
  if (m.kind === 'arena') return '🏟️ ' + ((m.arena && m.arena.name) || 'מגרש');
  if (m.kind === 'text') return (m.text || '').trim();
  const p = phraseById(m.presetId);
  return p ? p.text : '';
}

async function loadThreads() {
  if (!FOOTBALL_TOKEN || !MY_USER_ID) return;
  const res = await apiGet('/handle-messages/threads');
  if (!Array.isArray(res)) return;                 // stay silent on error — this is a background poll
  THREADS.clear();
  for (const t of res) if (t && t.userId) THREADS.set(t.userId, { unread: t.unread || 0, last: t.last || null });
  updateUnreadBadges();
  renderFriends();
}

// Numeric unread badge on the hub friends button (the green dot next to it stays presence-only).
function updateUnreadBadges() {
  const b = document.getElementById('friends-unread');
  if (!b) return;
  const n = totalUnread();
  b.textContent = n > 9 ? '9+' : String(n);
  b.classList.toggle('hidden', n === 0);
}

// ---- Opening / rendering a thread -----------------------------------------

function openThread(f) {
  if (!canMessage(f)) return;
  threadWith = f;
  threadMsgs = [];
  loadThread._sig = '';   // a fresh open must always render, even if it's the same thread again
  const nameEl = document.getElementById('th-name');
  if (nameEl) nameEl.textContent = f.nickName || '';
  const dot = document.getElementById('th-dot');
  if (dot) dot.classList.toggle('online', ONLINE.has(f.userId));
  const pfp = document.getElementById('th-pfp');
  if (pfp) {
    pfp.innerHTML = ''; pfp.style.background = '';
    const img = (f.image || '').toString();
    if (/^https?:\/\//i.test(img)) { const im = document.createElement('img'); im.src = img; im.alt = ''; pfp.appendChild(im); }
    else { pfp.textContent = memberInitials(f.nickName); if (f.color) pfp.style.background = f.color; }
  }
  showScreen('thread');
  renderThread(true);
  loadThread();
}

async function loadThread() {
  if (!threadWith) return;
  const who = threadWith.userId;
  const res = await apiGet(`/handle-messages/thread?withUserId=${encodeURIComponent(who)}`);
  if (!threadWith || threadWith.userId !== who) return;   // user moved on while it loaded
  if (!Array.isArray(res)) { renderThread(false, 'לא הצלחנו לטעון את השיחה'); return; }
  // The poll re-fetches every few seconds. Re-rendering an unchanged thread would scroll the
  // view back to the bottom under someone who is reading further up, so bail when nothing moved.
  const sig = res.map((m) => m.id + ':' + (m.reactions || []).map((r) => r.userId + r.emoji).join('')).join('|');
  const unchanged = sig === loadThread._sig;
  loadThread._sig = sig;
  threadMsgs = res;
  if (unchanged) return;
  // The server marked them read as part of this fetch — mirror that locally so the badge
  // clears immediately instead of waiting for the next threads poll.
  const t = THREADS.get(who);
  if (t) { t.unread = 0; updateUnreadBadges(); renderFriends(); }
  renderThread();
}

function renderThread(loading, errText) {
  const el = document.getElementById('th-msgs');
  if (!el) return;
  el.innerHTML = '';
  if (errText) { const d = document.createElement('div'); d.className = 'th-empty'; d.textContent = errText; el.appendChild(d); return; }
  if (loading && !threadMsgs.length) { const d = document.createElement('div'); d.className = 'th-empty'; d.textContent = 'טוען…'; el.appendChild(d); return; }
  if (!threadMsgs.length) { const d = document.createElement('div'); d.className = 'th-empty'; d.textContent = 'אין עדיין הודעות — שלחו את הראשונה!'; el.appendChild(d); return; }
  for (const m of threadMsgs) {
    const row = msgEl(m);
    if (row) el.appendChild(row);              // null = a kind/phrase this build doesn't know
  }
  el.scrollTop = el.scrollHeight;
}

function msgEl(m) {
  const mine = m.fromUserId === MY_USER_ID;
  // Unknown phrase ids come from a NEWER client — skip the bubble rather than render a blank one.
  if (m.kind === 'preset' && !phraseById(m.presetId)) return null;
  const row = document.createElement('div');
  row.className = 'th-row' + (mine ? ' mine' : '');
  const bub = document.createElement('div');
  bub.className = 'th-bub' + (m.kind === 'arena' ? ' arena' : '') + (m.kind === 'text' ? ' typed' : '');
  if (m.kind === 'arena') bub.appendChild(arenaCardEl(m));
  // Always textContent for a typed line: it is the only string here the sender chose, and the
  // sanitizer strips control/bidi characters but makes no claim about markup.
  else if (m.kind === 'text') bub.textContent = m.text || '';
  else bub.textContent = phraseById(m.presetId).text;
  if (m.reactions && m.reactions.length) {
    const r = document.createElement('div'); r.className = 'th-reacts';
    r.textContent = m.reactions.map((x) => x.emoji).join(' ');
    bub.appendChild(r);
  }
  bindReactPress(bub, m);
  row.appendChild(bub);
  return row;
}

// A shared arena: name, a size line, and the two things you can do with it.
function arenaCardEl(m) {
  const a = m.arena || {};
  const wrap = document.createElement('div'); wrap.className = 'th-arena';
  const t = document.createElement('div'); t.className = 'th-arena-name';
  t.textContent = '🏟️ ' + (a.name || 'מגרש');
  const sub = document.createElement('div'); sub.className = 'th-arena-sub';
  sub.textContent = fpCount(a.field) + ' אלמנטים';
  const acts = document.createElement('div'); acts.className = 'th-arena-acts';
  const play = document.createElement('button'); play.type = 'button'; play.className = 'th-arena-btn';
  play.textContent = 'שחק';
  play.onclick = (e) => { e.stopPropagation(); playSharedArena(a); };
  const save = document.createElement('button'); save.type = 'button'; save.className = 'th-arena-btn ghost';
  save.textContent = 'שמור';
  save.onclick = (e) => { e.stopPropagation(); saveSharedArena(a); };
  acts.append(play, save);
  wrap.append(t, sub, acts);
  return wrap;
}

// Play a received arena: the server already re-sanitizes the layout in builderMatch, so this
// reuses the existing "play my field vs bots" path with no new server code.
function playSharedArena(a) {
  if (!a || !a.field) return;
  unlockAudio && unlockAudio();
  syncLoadout && syncLoadout();
  sendMsg({ type: 'builderMatch', field: fpNormField(a.field) });
}

// Save a received arena into the builder library. Writes localStorage ONLY — deliberately not
// routed through the prefs bag, which silently drops the whole library past PREF_MAX_BYTES.
function saveSharedArena(a) {
  if (!a || !a.field) return;
  const saves = fpLoadSaves();
  if (saves.length >= FP_MAX_SLOTS) { toast('ספריית המגרשים מלאה'); return; }
  const base = (a.name || '').trim() || fpNextDefault();
  const taken = new Set(saves.map((s) => s.name));
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base} (${i})`;   // never overwrite an existing field
  saves.push({ id: fpNewId(), name, field: fpNormField(a.field) });
  toast(fpWriteSaves(saves) ? `נשמר כ"${name}"` : 'השמירה נכשלה');
}

// ---- Sending ---------------------------------------------------------------

async function sendPreset(presetId) {
  if (!threadWith) return;
  const m = await apiPostJson('/handle-messages/send', { toUserId: threadWith.userId, kind: 'preset', presetId });
  if (m) { threadMsgs.push(m); renderThread(); }
}

// A typed line. Sanitized HERE before it goes out so the message the sender sees appended is the
// same object the server stored (apiPostJson returns the saved message, so no optimistic echo can
// disagree with it). An empty result is dropped silently — there is nothing to tell the player that
// they didn't already see in the counter.
async function sendText(raw) {
  if (!threadWith) return false;
  const text = sanitizeFreeText(raw);
  if (!text) return false;
  const m = await apiPostJson('/handle-messages/send', { toUserId: threadWith.userId, kind: 'text', text });
  if (m) { threadMsgs.push(m); renderThread(); }
  return !!m;
}

async function sendArena(save) {
  if (!threadWith || !save) return;
  const m = await apiPostJson('/handle-messages/send', {
    toUserId: threadWith.userId, kind: 'arena', arena: { name: save.name, field: save.field },
  });
  if (m) { threadMsgs.push(m); renderThread(); }
  else toast('המגרש גדול מדי לשיתוף');   // the only 400 the arena path can produce
}

// ---- Reactions -------------------------------------------------------------

let reactFor = null;   // message the reaction bar is open for

function bindReactPress(el, m) {
  let timer = 0;
  const start = () => { clearTimeout(timer); timer = setTimeout(() => openReactBar(el, m), 420); };
  const cancel = () => clearTimeout(timer);
  el.addEventListener('pointerdown', start);
  el.addEventListener('pointerup', cancel);
  el.addEventListener('pointerleave', cancel);
  el.addEventListener('pointercancel', cancel);
  // Long-press on a touch device fires the OS text-selection/callout otherwise.
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}

function openReactBar(anchor, m) {
  const bar = document.getElementById('th-react');
  if (!bar) return;
  reactFor = m;
  bar.innerHTML = '';
  for (const emoji of REACTION_EMOJI) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'th-react-btn';
    b.textContent = emoji;
    b.onclick = () => { reactTo(m, emoji); closeReactBar(); };
    bar.appendChild(b);
  }
  const r = anchor.getBoundingClientRect();
  bar.classList.remove('hidden');
  const bw = bar.offsetWidth || 200;
  // Keep the bar on-screen when the bubble sits near an edge.
  bar.style.left = Math.max(8, Math.min(window.innerWidth - bw - 8, r.left + r.width / 2 - bw / 2)) + 'px';
  bar.style.top = Math.max(8, r.top - 52) + 'px';
}
function closeReactBar() { reactFor = null; document.getElementById('th-react')?.classList.add('hidden'); }

async function reactTo(m, emoji) {
  const updated = await apiPostJson('/handle-messages/react', { messageId: m.id, emoji });
  if (!updated) return;
  const i = threadMsgs.findIndex((x) => x.id === m.id);
  if (i >= 0) threadMsgs[i] = updated;
  renderThread();
}

// ---- Composer sheets -------------------------------------------------------

let sheetGroup = QUICK_GROUPS[0] ? QUICK_GROUPS[0].id : '';

function openPhraseSheet() {
  const sheet = document.getElementById('th-sheet');
  if (!sheet) return;
  renderPhraseSheet();
  sheet.classList.remove('hidden');
}
function renderPhraseSheet() {
  const tabs = document.getElementById('th-sheet-tabs');
  const list = document.getElementById('th-sheet-list');
  if (!tabs || !list) return;
  tabs.innerHTML = '';
  for (const g of QUICK_GROUPS) {
    const b = document.createElement('button'); b.type = 'button';
    b.className = 'th-sheet-tab' + (g.id === sheetGroup ? ' active' : '');
    b.textContent = g.name;
    b.onclick = () => { sheetGroup = g.id; renderPhraseSheet(); };
    tabs.appendChild(b);
  }
  const group = QUICK_GROUPS.find((g) => g.id === sheetGroup) || QUICK_GROUPS[0];
  list.innerHTML = '';
  for (const p of (group ? group.phrases : [])) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'th-phrase';
    b.textContent = p.text;
    b.onclick = () => { document.getElementById('th-sheet')?.classList.add('hidden'); sendPreset(p.id); };
    list.appendChild(b);
  }
}

function openArenaSheet() {
  const sheet = document.getElementById('th-arena-sheet');
  const list = document.getElementById('th-arena-list');
  if (!sheet || !list) return;
  const saves = fpLoadSaves();
  list.innerHTML = '';
  if (!saves.length) {
    const d = document.createElement('div'); d.className = 'th-empty';
    d.textContent = 'אין מגרשים שמורים — בנו מגרש קודם';
    list.appendChild(d);
  } else {
    for (const s of saves) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'th-phrase';
      b.textContent = `🏟️ ${s.name || 'מגרש'} · ${fpCount(s.field)}`;
      b.onclick = () => { sheet.classList.add('hidden'); sendArena(s); };
      list.appendChild(b);
    }
  }
  sheet.classList.remove('hidden');
}

// ---- Wiring ----------------------------------------------------------------

document.getElementById('th-back')?.addEventListener('click', () => { threadWith = null; showScreen('friends'); });
document.getElementById('th-say')?.addEventListener('click', () => { unlockAudio(); openPhraseSheet(); });
// Typed line. The counter reads the SHARED sanitizer, so what it counts is what the server keeps —
// an emoji is one character in both places and trailing spaces never count. maxLength sits above the
// cap on purpose so the counter can visibly reach 0 before the field stops accepting keys; the
// sanitizer, not the field, is what actually enforces the limit.
(() => {
  const form = document.getElementById('th-form');
  const input = document.getElementById('th-text');
  const left = document.getElementById('th-left');
  if (!form || !input) return;
  input.maxLength = FREE_TEXT_MAX + 10;
  const paint = () => {
    if (!left) return;
    const rem = freeTextLeft(input.value);
    left.textContent = input.value ? String(Math.max(0, rem)) : '';
    left.classList.toggle('over', rem <= 0);
  };
  paint();
  input.addEventListener('input', paint);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const raw = input.value;
    if (!sanitizeFreeText(raw)) return;
    // Cleared BEFORE the round trip: the field is where the player types next, and leaving their sent
    // words sitting in it while the request flies reads as "it didn't send". On failure the text goes
    // back, so a dropped request never silently eats the message.
    input.value = ''; paint();
    if (!await sendText(raw)) { input.value = raw; paint(); }
  });
})();
document.getElementById('th-share')?.addEventListener('click', () => { unlockAudio(); openArenaSheet(); });
document.getElementById('th-sheet-close')?.addEventListener('click', () => document.getElementById('th-sheet')?.classList.add('hidden'));
document.getElementById('th-arena-close')?.addEventListener('click', () => document.getElementById('th-arena-sheet')?.classList.add('hidden'));
// The thread header is the way back to the profile modal, which used to be the card's own tap.
document.getElementById('th-who')?.addEventListener('click', () => { if (threadWith) openFriendProfile(threadWith); });
// Any tap outside the reaction bar dismisses it (capture, so it beats the bubble's own handlers).
document.addEventListener('pointerdown', (e) => {
  if (reactFor && !e.target.closest('#th-react')) closeReactBar();
}, true);

// ---- Background poll -------------------------------------------------------
// Messages are stored, not pushed, so the client polls: fast while a thread is open, slow
// otherwise (just to keep the unread badge honest). Paused in a match and when the tab/WebView
// is backgrounded, so it never competes with gameplay traffic.
const THREAD_TICK_MS = 8000;
const THREADS_EVERY_TICKS = 3;   // → the badge refreshes about every 24s
let threadTick = 0;
function startThreadPoll() {
  if (threadPollT) return;
  threadPollT = setInterval(() => {
    if (!FOOTBALL_TOKEN || !MY_USER_ID || document.hidden) return;
    if (screens.game && !screens.game.classList.contains('hidden')) return;    // in a match
    const threadOpen = threadWith && screens.thread && !screens.thread.classList.contains('hidden');
    if (threadOpen) loadThread();
    if (++threadTick % THREADS_EVERY_TICKS === 0) loadThreads();
  }, THREAD_TICK_MS);
}

// --- Party flow: invite online friends into the lobby, then pick a game ------------------
// Host-only panel of ONLINE friends (FRIENDS ∩ ONLINE). Shown in the private-room lobby.
function renderPartyInvite() {
  const el = document.getElementById('party-invite'); if (!el) return;
  const show = false; // invites now happen on the dedicated invite screen (party flow) → keep the groups page clean
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
      if (f.isBot) sendMsg({ type: 'addBot', botId: f.userId, name: f.nickName });
      else { sendMsg({ type: 'inviteFriend', toUserId: f.userId }); btn.textContent = 'הוזמן'; btn.disabled = true; }
    };
    row.append(dot, nm, btn); el.appendChild(row);
  });
}
// Incoming party invite → simple accept/decline (matches showChallengePrompt's pattern).
function showPartyInvite(code, fromName) {
  if (!confirm(`${fromName} מזמין אותך לקבוצה. להצטרף?`)) { sendMsg({ type: 'partyRespond', code, accept: false }); return; }
  partyFlow = true;   // invited member also lands on the #party roster
  sendMsg({ type: 'partyRespond', code, accept: true });
}
// Party flow: team-first (see openPartyDirect above). The room already exists by the time anyone
// sees a friend list — #friend-select is a SHEET opened from the `+` tile on the team page, not a
// step of its own, so there is one flow: host or invited member, always #party. Join-by-code lives
// in the same sheet so a player who'd rather join a friend's room can still enter their shared code.
const friendSelectEl = document.getElementById('friend-select');
const joinCodeEl = document.getElementById('join-code');
const partySel = new Set();          // userIds selected for the party
let selectedGame = null;             // chosen minigame (set in step 2, drives the lobby start)
let pendingPartyApply = false;       // apply the picks once the fresh room's roomJoined arrives
let partyFlow = false;               // true while in the play-with-friends flow (host OR invited member) → land on the #party roster
let lastLobby = null;                // last lobby payload, so the party roster can re-render as members accept
const invitedSet = new Set();        // userIds invited this session (shown as "pending" until they join)
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
// Invite screen: three live sections — online (invitable) / pending (invited) / accepted.
// The party room is created when this screen OPENS so invites + accepts are live here.
function inviteRowEl(f) {
  // THE FRIENDS-PAGE CARD, one size down. It was a `.friend-row` — a dot, a photo, a name and a button
  // — so the same person looked like two different things depending on which screen you were on. This
  // reuses `friendCardEl`'s markup (avatar, name, stats/last-message, the three power slots) and only
  // changes the ACTION: on the friends page a card opens a conversation; here it invites.
  const card = friendCardEl(f);
  card.classList.add('fc-mini');
  // friendCardEl wires tap → thread and avatar → profile. Neither is what this screen is for, and a
  // listener cannot be removed once added, so the card is CLONED (clones drop listeners) and the
  // avatar's profile tap is re-attached deliberately.
  const clean = card.cloneNode(true);
  clean.querySelector('.fc-pfp')?.addEventListener('click', (e) => { e.stopPropagation(); openFriendProfile(f); });
  const pending = invitedSet.has(f.userId) && !f.isBot;
  const act = document.createElement('button');
  act.className = 'fc-invite' + (pending ? ' is-pending' : '');
  act.textContent = pending ? 'ממתין…' : 'הזמן';
  act.disabled = pending;
  const invite = () => {
    if (pending) return;
    if (f.isBot) sendMsg({ type: 'addBot', botId: f.userId, name: f.nickName });
    else { sendMsg({ type: 'inviteFriend', toUserId: f.userId }); invitedSet.add(f.userId); }
    renderInvite();
  };
  act.addEventListener('click', (e) => { e.stopPropagation(); invite(); });
  clean.addEventListener('click', invite);            // the whole card invites — a phone-sized target
  clean.appendChild(act);
  return clean;
}
function acceptedRowEl(m) {
  const row = document.createElement('div'); row.className = 'friend-row online' + (m.isBot ? ' is-bot' : '');
  const dot = document.createElement('span'); dot.className = 'friend-dot';
  const nm = document.createElement('span'); nm.className = 'friend-name'; nm.textContent = (m.isBot ? '🤖 ' : '') + (m.name || '');
  const tag = document.createElement('span'); tag.className = 'friend-bot-tag'; tag.textContent = '✓ בקבוצה';
  row.append(dot, nm, tag);
  return row;
}
function renderInvite() {
  renderInviteActions();
  const onlineEl = document.getElementById('fs-online');
  const pendEl = document.getElementById('fs-pending');
  const accEl = document.getElementById('fs-accepted');
  if (!onlineEl || !pendEl || !accEl) return;
  const accepted = ((lastLobby || {}).members || []).filter((m) => m.id !== myMemberId);
  const accName = new Set(accepted.map((m) => m.name || ''));
  // Skip rebuild when nothing changed (avoids re-loading friend avatars on every broadcast).
  const cands = FRIENDS.filter((f) => f.isBot || ONLINE.has(f.userId));
  const isig = cands.map((f) => (f.userId || f.nickName) + ':' + (ONLINE.has(f.userId) ? 1 : 0) + ':' + (invitedSet.has(f.userId) ? 1 : 0)).join('|') + '#' + accepted.map((m) => m.name).join(',');
  if (isig === renderInvite._sig && onlineEl.childElementCount + pendEl.childElementCount + accEl.childElementCount) return;
  renderInvite._sig = isig;
  onlineEl.innerHTML = ''; pendEl.innerHTML = ''; accEl.innerHTML = '';
  let nOnline = 0, nPend = 0;
  FRIENDS.filter((f) => f.isBot || ONLINE.has(f.userId)).forEach((f) => {
    if (accName.has(f.nickName || '')) return;                 // already joined → accepted section
    if (invitedSet.has(f.userId) && !f.isBot) { pendEl.appendChild(inviteRowEl(f)); nPend++; }
    else { onlineEl.appendChild(inviteRowEl(f)); nOnline++; }
  });
  accepted.forEach((m) => accEl.appendChild(acceptedRowEl(m)));
  if (!nOnline) onlineEl.innerHTML = '<div class="pi-empty">אין חברים מחוברים כרגע</div>';
  document.getElementById('fs-pending-wrap')?.classList.toggle('hidden', !nPend);
  document.getElementById('fs-accepted-wrap')?.classList.toggle('hidden', !accepted.length);
}
// The left column's live bits. `lastLobby.code` is the CURRENT party room's code — always real by
// the time this sheet can open, since the party room now exists for the whole party's lifetime.
function renderInviteActions() {
  const code = (lastLobby || {}).code || null;
  const el = document.getElementById('fs-code');
  if (el) { el.textContent = code || '---'; el.disabled = !code; }
}
// Opens the invite SHEET over the team page — never creates or leaves a room itself (the party room
// already exists; ANY member, host or not, can open this — item 4). Stays open after an invite so
// several friends can be invited in one visit; closing it (× or backdrop tap) just hides it, landing
// back on #party underneath, which was never touched.
function openInviteSheet() {
  invitedSet.clear();
  if (joinCodeEl) joinCodeEl.value = '';
  loadFriends();                              // refresh presence so online friends show as candidates
  renderInvite(); renderInviteActions();
  friendSelectEl?.classList.remove('hidden');
}
function closeInviteSheet() { friendSelectEl?.classList.add('hidden'); }
function closeFriendSelect() { closeInviteSheet(); }
document.getElementById('friend-select-close')?.addEventListener('click', closeInviteSheet);
// Tap the dim backdrop to close (modal convention), drag-safe via isDismissBackdrop.
let fsDownBackdrop = false;
friendSelectEl?.addEventListener('pointerdown', (e) => { fsDownBackdrop = isDismissBackdrop(e.target, friendSelectEl); });
friendSelectEl?.addEventListener('click', (e) => { if (fsDownBackdrop && isDismissBackdrop(e.target, friendSelectEl)) { fsDownBackdrop = false; closeInviteSheet(); } });
// Power-slots page: tap the empty background (outside the panel) to go back to the hub.
const cardsScreenEl = document.getElementById('cards');
let cardsDownBackdrop = false;
cardsScreenEl?.addEventListener('pointerdown', (e) => { cardsDownBackdrop = isDismissBackdrop(e.target, cardsScreenEl); });
cardsScreenEl?.addEventListener('click', (e) => { if (cardsDownBackdrop && isDismissBackdrop(e.target, cardsScreenEl)) { cardsDownBackdrop = false; showScreen('home'); } });
// JOIN BY CODE. Now a <form>, so the phone keyboard's "go" key works as well as the button — and the
// submit has to be intercepted or the page navigates and the socket dies. Always leaves whatever
// room we're currently in first — the sheet only opens from inside a real party now, so "join by
// code" here means "abandon this party and join a different one", never "discard a throwaway room".
function joinByCode() {
  unlockAudio();
  const code = (joinCodeEl?.value || '').trim().toUpperCase();
  if (code.length < 3) { showRoomError('הכניסו קוד חדר'); return; }
  sendMsg({ type: 'leaveRoom' });
  lastLobby = null;
  sendMsg({ type: 'joinRoom', code });
  closeInviteSheet();
}
document.getElementById('fs-join')?.addEventListener('submit', (e) => { e.preventDefault(); joinByCode(); });
document.getElementById('join-room-btn')?.addEventListener('click', (e) => { e.preventDefault(); joinByCode(); });
// TAP THE CODE TO COPY IT. `navigator.clipboard` is unavailable on a plain-http LAN origin (it needs a
// secure context), which is exactly how this game is tested — so it falls back to selecting the text,
// and either way the label confirms, because a copy button that looks like it did nothing is worse than
// no button.
document.getElementById('fs-code')?.addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const code = (btn.textContent || '').trim();
  if (!code || code === '---') return;
  let done = false;
  try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(code); done = true; } } catch { /* insecure origin */ }
  if (!done) { const r = document.createRange(); r.selectNodeContents(btn); getSelection()?.removeAllRanges(); getSelection()?.addRange(r); }
  toast(done ? `הקוד ${code} הועתק` : `הקוד: ${code}`);
});
// A FRESH ROOM. Dissolves the room this screen opened with (no orphan) and opens another, so a host who
// shared a stale code can rotate it. Invites already sent are dropped with the old room, hence the reset.
document.getElementById('fs-new-room')?.addEventListener('click', () => {
  sendMsg({ type: 'leaveRoom' });
  invitedSet.clear(); lastLobby = null; partyFlow = true;
  sendMsg({ type: 'createRoom' });
  renderInvite();
  toast('חדר חדש נוצר');
});

// Game picker overlay. mode 'setup' = from the friend-select flow (create room + apply picks);
// mode 'lobby' = host re-opening it inside the lobby (start immediately). Only 2v2 is live.
const gameSelectEl = document.getElementById('game-select');
let gameSelectMode = 'lobby';
function openGameSelect(mode) { gameSelectMode = mode || 'lobby'; if (gameSelectEl) gameSelectEl.classList.remove('hidden'); }
function closeGameSelect() { if (gameSelectEl) gameSelectEl.classList.add('hidden'); }
document.getElementById('pick-game-btn')?.addEventListener('click', () => {
  unlockAudio();
  if (selectedGame) { syncLoadout(); sendMsg({ type: 'ready', game: selectedGame }); toast('מתחילים…'); } // game already chosen in setup → start
  else openGameSelect('lobby');
});
document.getElementById('game-select-close')?.addEventListener('click', closeGameSelect);
// Backdrop only — the cards themselves are rendered from MODES and handled by the
// delegated .modecard[data-mode-id] listener.
gameSelectEl?.addEventListener('click', (e) => {
  if (e.target === gameSelectEl) closeGameSelect();
});
// Once the fresh party room is created (host), apply the picks: bots via addBot, real friends
// via inviteFriend. Called from the roomJoined handler.
function applyPartyPicks() {
  // THE GAME GOES FIRST, BEFORE THE INVITES. In the SETUP flow the card is picked before the room
  // exists, so the `partyGame` send at the picker is skipped (there is nothing to send it to) and this
  // is the only place it can land. Without it a host who chose 3v3 here got a room that still seated
  // FOUR — the same capacity bug the picker path fixes, surviving in the other flow. And it must
  // precede the invites: capacity is teamSize x 2, so inviting five friends into a not-yet-3v3 room
  // bounces the last one on "החדר מלא".
  if (selectedGame) sendMsg({ type: 'partyGame', game: selectedGame });
  const byId = new Map(FRIENDS.map((f) => [f.userId, f]));
  for (const uid of partySel) {
    const f = byId.get(uid); if (!f) continue;
    if (f.isBot) sendMsg({ type: 'addBot', botId: f.userId, name: f.nickName });
    else sendMsg({ type: 'inviteFriend', toUserId: uid });
  }
  const n = partySel.size;
  toast(n ? `מזמין ${n} חברים…` : 'החדר מוכן — הזמינו חברים או התחילו');
}

// ---- Play With Friends · party ROSTER (#party) ------------------------------
// YOU render big in the middle (rank/xp chip above, power cards below); each party
// member renders smaller alongside. Driven by the room's `lobby` members (cosmetic +
// loadout carried in the payload). rank/xp is best-effort (self from window.SALTIZ_XP;
// mates matched to the friends list by avatar/name) and hidden when unknown.
const partyEl = document.getElementById('party');
const partyRosterEl = document.getElementById('party-roster');
function partyHeroCanvas(cosmetic, big) {
  const cv = document.createElement('canvas');
  cv.width = big ? 92 : 56; cv.height = big ? 108 : 66;
  cv.className = 'pr-hero ' + (big ? 'pr-hero-big' : 'pr-hero-sm');
  const g = cv.getContext('2d'); g.imageSmoothingEnabled = false;
  const sf = cv.height / 42, ox = cv.width / 2, feetY = cv.height - sf * 3;
  drawHero(g, ox, feetY, sf, 0.4, 0, 0.6, false, cosmetic || DEFAULT_COSMETIC, PREVIEW_KIT, 0);
  return cv;
}
function teamHeroCanvas(cosmetic, team) {
  const cv = document.createElement('canvas'); cv.width = 44; cv.height = 52;
  const g = cv.getContext('2d'); g.imageSmoothingEnabled = false;
  const sf = cv.height / 42, ox = cv.width / 2, feetY = cv.height - sf * 3;
  // Stare-down: team A sits in the RIGHT column so it gazes left→centre (dir<0); team B (left) gazes right→centre.
  const dir = team === 'B' ? 0.7 : -0.7;
  drawHero(g, ox, feetY, sf, dir, 0, 0.6, false, cosmetic || DEFAULT_COSMETIC, PREVIEW_KIT, 0);
  return cv;
}
function partyCardsRow(cards) {
  const row = document.createElement('div'); row.className = 'pr-cards';
  (cards || []).filter(Boolean).slice(0, 3).forEach((c) => {
    const im = document.createElement('img'); im.className = 'pr-card rarity-' + c.r; im.alt = '';
    im.loading = 'lazy'; im.onerror = () => im.removeAttribute('src');
    im.src = `${CARD_ART_BASE}/${c.r}/${c.n}.webp`;
    row.appendChild(im);
  });
  return row;
}
function myRankXpText() {
  const x = window.SALTIZ_XP; if (!x) return '';
  const xp = +x.xp || 0; const lvl = +x.level || levelFromXp(xp);
  return `דרגה ${lvl} · XP ${fmtCompact(xp)}`;
}
function mateRankText(m) {
  if (m.isBot) return '';
  const f = FRIENDS.find((fr) => (m.avatar && fr.image === m.avatar) || fr.nickName === m.name);
  if (!f) return '';
  const bits = [];
  if (f.rank != null) bits.push('#' + f.rank);
  if (f.level != null) bits.push('דרגה ' + f.level);
  return bits.join(' · ');
}
function partyBlock({ big, name, cosmetic, cards, rankText, chat, memberId, canKick }) {
  const wrap = document.createElement('div'); wrap.className = big ? 'pr-me' : 'pr-mate';
  // SPEECH BUBBLE — the member's last message, above their hero.
  // IN FLOW, not absolutely positioned: at 3v3 there are six blocks on a phone, and absolute bubbles
  // overlapped their neighbours and clipped each other (screenshotted, twice). A reserved slot costs a
  // little height and can never collide. The slot is ALWAYS present so a message arriving does not
  // shove the roster around, and `textContent` (never innerHTML) is what makes a player-authored
  // string safe to render.
  const say = document.createElement('div');
  say.className = 'pr-say' + (chat && (chat.text || chat.chatId) ? ' has' : '');
  if (chat && (chat.text || chat.chatId)) say.appendChild(chatBubbleNode(chat));
  wrap.appendChild(say);
  if (rankText) { const r = document.createElement('div'); r.className = 'pr-rank'; r.textContent = rankText; wrap.appendChild(r); }
  wrap.appendChild(partyHeroCanvas(cosmetic, big));
  const nm = document.createElement('div'); nm.className = 'pr-name'; nm.textContent = name; wrap.appendChild(nm);
  wrap.appendChild(partyCardsRow(cards));
  // HOST-ONLY KICK (item 5) — never on yourself (`big` blocks, i.e. .pr-me, never get one). A real
  // <button> so isDismissBackdrop's generic control whitelist keeps a tap on it from also reading as
  // a tap on the party's empty background (which would leave the room — see partyEl's click guard).
  if (!big && canKick && memberId) {
    const kick = document.createElement('button');
    kick.type = 'button'; kick.className = 'pr-kick'; kick.textContent = '✕';
    kick.setAttribute('aria-label', 'הסרה מהקבוצה');
    kick.addEventListener('click', (e) => { e.stopPropagation(); confirmKickMember(memberId, name); });
    wrap.appendChild(kick);
  }
  return wrap;
}
// + TILE (item 2): pixel-art `+` beside the hero, ALWAYS present (any party size, not just solo) —
// opens the invite sheet as a modal over this page. Built from the shared icon pack directly
// (.build-icon > .saltiz-icon.si-add), not a text glyph, so it never depends on the page-wide
// emoji→icon compatibility layer having already run.
function partyAddTile() {
  const btn = document.createElement('button');
  btn.type = 'button'; btn.id = 'party-invite-tile'; btn.className = 'pr-add';
  btn.setAttribute('aria-label', 'הזמן חבר');
  const ic = document.createElement('span'); ic.className = 'pr-add-ic build-icon';
  const sp = document.createElement('span'); sp.className = 'saltiz-icon si-add'; sp.setAttribute('aria-hidden', 'true');
  ic.appendChild(sp);
  const lb = document.createElement('span'); lb.className = 'pr-add-label'; lb.textContent = 'הזמן חבר';
  btn.append(ic, lb);
  btn.addEventListener('click', (e) => { e.stopPropagation(); unlockAudio(); openInviteSheet(); });
  return btn;
}
// The room's code, on the team page. Updated OUTSIDE renderParty's no-rebuild guard below, because it
// changes on its own schedule: `roomJoined` brings the code in while the roster is byte-identical to
// what is already drawn, and a chip updated after the guard would stay «····» until somebody joined.
function renderPartyCode(lob) {
  const wrap = document.getElementById('party-code-wrap');
  const el = document.getElementById('party-code');
  if (!wrap || !el) return;
  const code = (lob && lob.code) || roomCode || '';
  wrap.classList.toggle('hidden', !code);
  if (code) el.textContent = code;
}
// Tap to copy — a room number exists to be passed to somebody. clipboard.writeText needs a secure
// context and this is served over plain http on the LAN, so the failure path is real and gets a toast
// that shows the code instead of silently doing nothing.
document.getElementById('party-code-wrap')?.addEventListener('click', async (e) => {
  e.stopPropagation();
  const code = document.getElementById('party-code')?.textContent || '';
  if (!code) return;
  try { await navigator.clipboard.writeText(code); toast('הקוד הועתק'); }
  catch { toast(`קוד החדר: ${code}`); }
});
let partyRenderSig = '';
function renderParty(msg) {
  if (!partyRosterEl) return;
  renderPartyCode(msg || lastLobby || {});
  const members = (msg || lastLobby || {}).members || [];
  // Each block renders a hero canvas + card art (expensive). Lobby broadcasts fire often, so
  // skip the full rebuild when the roster is unchanged (this was the friends→group lag).
  // `m.chat.at` and `m.vote` are in the signature on purpose: without them a new message or a fresh
  // vote would be skipped by the no-rebuild guard below and never appear.
  const sig = members.map((m) => (m.id || '') + ':' + (m.name || '') + ':' + (m.isBot ? 1 : 0) + ':' + JSON.stringify(m.cosmetic || 0) + ':' + JSON.stringify(m.loadout || 0) + ':' + ((m.chat && m.chat.at) || 0) + ':' + (m.vote || '')).join('|')
    + '#' + JSON.stringify(myCosmetic || 0) + '#' + JSON.stringify(effectiveLoadout()) + '#' + (isRoomHost ? 1 : 0) + '#' + MY_NAME
    + '#' + ((msg || lastLobby || {}).game || '') + '#' + ((msg || lastLobby || {}).maxPlayers || 0);
  const lob = msg || lastLobby || {};
  if (sig === partyRenderSig && partyRosterEl.childElementCount) { renderPartyVotes(lob); return; } // unchanged roster → still refresh votes (cheap, no canvas rebuild)
  partyRenderSig = sig;
  const mates = members.filter((m) => m.id !== myMemberId);
  const meMember = members.find((m) => m.id === myMemberId) || null;
  const meBlock = partyBlock({ big: true, name: MY_NAME + ' (אני)', cosmetic: myCosmetic, cards: effectiveLoadout(), rankText: myRankXpText(), chat: meMember && meMember.chat });
  // canKick: host-only (item 5) — the server enforces this too; see confirmKickMember/kickMember.
  const mateBlock = (m) => partyBlock({ big: false, name: (m.isBot ? '🤖 ' : '') + (m.name || ''), cosmetic: m.cosmetic, cards: m.loadout, rankText: mateRankText(m), chat: m.chat, memberId: m.id, canKick: isRoomHost });
  // YOU sit in the MIDDLE with mates flanking you left + right (one row, wraps if needed); the `+`
  // TILE (item 2) always sits right next to your own hero, whatever the party's size.
  partyRosterEl.innerHTML = '';
  const half = Math.ceil(mates.length / 2);
  mates.slice(0, half).forEach((m) => partyRosterEl.appendChild(mateBlock(m)));
  partyRosterEl.appendChild(meBlock);
  partyRosterEl.appendChild(partyAddTile());
  mates.slice(half).forEach((m) => partyRosterEl.appendChild(mateBlock(m)));
  // SOLO EMPTY STATE: its own line (#party-solo-hint), a SIBLING of the roster right after it —
  // never a flex ITEM of .party-roster. An earlier version appended a `.pr-empty` div straight INTO
  // partyRosterEl (flex-direction:row, wrap): a whole sentence rarely fits beside the hero + the `+`
  // tile, so it wrapped onto its own row and pushed the mode-list entirely below the 390px landscape
  // fold (measured via CDP: the roster alone grew to 261px). Putting the same text on #party-hint
  // instead (tried next) just moved the problem: that element sits AFTER .party-games, so the
  // message itself ended up below the fold along with the games. #party-solo-hint sits BEFORE
  // .party-games, so it is always visible without scrolling regardless of the games list's height.
  const soloHint = document.getElementById('party-solo-hint');
  if (soloHint) soloHint.classList.toggle('hidden', !!mates.length);
  // Every member can advance to the groups page to pick a team; only the host starts. Unrelated to
  // the solo state above — this is the pre-existing host-progress hint, next to the games list.
  const hint = document.getElementById('party-hint');
  if (hint) { hint.textContent = 'בחרו משחק ואז קבוצה — המארח מתחיל'; hint.classList.toggle('hidden', isRoomHost); }
  // The picked mode and this room's capacity, so "3 נגד 3" is visible to everyone rather than being
  // a fact only the host's client knows.
  const gh = document.querySelector('.party-games-h');
  if (gh) {
    const picked = lob.game ? modeById(lob.game) : null;
    const cap = lob.maxPlayers ? ` · עד ${lob.maxPlayers} שחקנים` : '';
    gh.textContent = picked ? `${picked.name}${cap}` : 'בחרו משחק';
  }
  renderPartyChat(lob);
  notePartyChatHistory(members); renderPartyChatLog(); refreshPartyChatBubbleHint();
  renderPartyVotes(lob);
  // Once the HOST decides (item 3), everyone still on the team page follows to team-select — the
  // host's own tap already did this locally the instant they tapped; this is what gets everyone
  // ELSE there too, since a non-host's tap no longer navigates (it only votes). Guarded by
  // `!isRoomHost` so the host's own (already-navigated) client doesn't re-enter; harmless either way
  // since #party is hidden for them by the time this broadcast lands.
  if (lob.game && !isRoomHost) { closeInviteSheet(); closePartyChatSheet(); showScreen('lobby'); }
}
// PER-MODE VOTE GLOW (item 3) — cheap enough to run on every lobby broadcast even when the roster
// rebuild above was skipped: a small coloured dot per voter on the card they picked, and the ONE
// card matching `lob.game` (the host's decision) marked `.mode-picked`. Scoped to #party's own
// mode-list only — #game-select's legacy picker is untouched.
function renderPartyVotes(lob) {
  const list = document.querySelector('#party .mode-list[data-modes="party"]');
  if (!list) return;
  const members = (lob && lob.members) || [];
  const votesByGame = new Map();
  for (const m of members) {
    if (!m.vote) continue;
    const arr = votesByGame.get(m.vote) || []; arr.push(m); votesByGame.set(m.vote, arr);
  }
  list.querySelectorAll('.pcard[data-mode-id]').forEach((card) => {
    const id = card.dataset.modeId;
    card.classList.toggle('mode-picked', !!(lob && lob.game === id));
    const voters = votesByGame.get(id) || [];
    let dots = card.querySelector('.pc-votes');
    if (!voters.length) { dots?.remove(); return; }
    if (!dots) { dots = document.createElement('span'); dots.className = 'pc-votes'; card.appendChild(dots); }
    dots.innerHTML = '';
    voters.slice(0, 6).forEach((m) => {
      const d = document.createElement('span'); d.className = 'pc-vote-dot';
      d.style.background = colorForMemberId(m.id);
      d.title = m.name || '';
      dots.appendChild(d);
    });
  });
}
// ---- PARTY CHAT SHEET: scrolling history (item 2) -------------------------------------------
// A rolling client-side log — the wire only ever carries each member's LATEST message
// (lobbyPayload's `member.chat`), so the sheet's history is assembled here from the broadcasts as
// they arrive, keyed per member by `chat.at` so the same message is never appended twice.
let partyChatLog = [];                // [{id,name,isBot,chat}], oldest first, capped
const partyChatSeenAt = new Map();    // memberId -> last chat.at already logged
function notePartyChatHistory(members) {
  for (const m of members) {
    const at = m.chat && m.chat.at; if (!at) continue;
    if (partyChatSeenAt.get(m.id) === at) continue;
    partyChatSeenAt.set(m.id, at);
    partyChatLog.push({ id: m.id, name: m.name, isBot: !!m.isBot, chat: m.chat });
  }
  if (partyChatLog.length > 40) partyChatLog = partyChatLog.slice(-40);
}
function renderPartyChatLog() {
  const el = document.getElementById('party-chat-log'); if (!el) return;
  el.innerHTML = '';
  if (!partyChatLog.length) {
    const d = document.createElement('div'); d.className = 'pchat-log-empty'; d.textContent = 'אין הודעות עדיין';
    el.appendChild(d);
  } else {
    for (const e of partyChatLog) {
      const row = document.createElement('div'); row.className = 'pchat-log-row' + (e.id === myMemberId ? ' me' : '');
      const nm = document.createElement('span'); nm.className = 'pchat-log-name'; nm.textContent = (e.isBot ? '🤖 ' : '') + (e.name || '');
      const bd = document.createElement('span'); bd.className = 'pchat-log-msg'; bd.appendChild(chatBubbleNode(e.chat));
      row.append(nm, bd); el.appendChild(row);
    }
  }
  el.scrollTop = el.scrollHeight;   // newest message always visible at the bottom
}
// ---- PARTY CHAT SHEET: open/close (revision of the old always-on rail) --------------------------
// #party-chat-log / #party-chat (rendered above/below) moved INTO this sheet unchanged — only the
// container hosting them changed. The slide itself is a CSS transform transition on `.open` (see
// .party-chat-sheet in style.css); there is nothing to animate from here.
const partyChatSheetEl = document.getElementById('party-chat-sheet');
const partyChatBubbleEl = document.getElementById('party-chat-bubble');
let partyChatSheetSeenAt = 0; // Date.now() as of the last open — drives the unread hint below
function partyChatSheetIsOpen() { return !!(partyChatSheetEl && partyChatSheetEl.classList.contains('open')); }
function openPartyChatSheet() {
  if (!partyChatSheetEl) return;
  partyChatSheetEl.classList.add('open');
  // The icon lives at the bottom RIGHT and sits above the sheet in z-order, so while the sheet is up
  // it has to ride above the sheet's top edge — otherwise it parks on the composer's input/send.
  // See `.party-chat-bubble.sheet-open` in style.css.
  partyChatBubbleEl?.classList.add('sheet-open');
  partyChatSheetSeenAt = Date.now();
  refreshPartyChatBubbleHint();
}
function closePartyChatSheet() {
  partyChatSheetEl?.classList.remove('open');
  partyChatBubbleEl?.classList.remove('sheet-open');
}
function togglePartyChatSheet() { if (partyChatSheetIsOpen()) closePartyChatSheet(); else openPartyChatSheet(); }
// The icon's own tap toggles — stopPropagation keeps it from ALSO bubbling into partyEl's backdrop
// listener below, mirroring partyAddTile's identical guard on the `+` tile.
partyChatBubbleEl?.addEventListener('click', (e) => { e.stopPropagation(); unlockAudio(); togglePartyChatSheet(); });
// Unread hint: cheap re-use of the SAME `member.chat`/`chat.at` state the roster bubbles already
// render from (notePartyChatHistory above) — "is there a logged message from someone else newer than
// the last time I opened the sheet". Never lit while the sheet is already open.
function refreshPartyChatBubbleHint() {
  if (!partyChatBubbleEl) return;
  const unread = !partyChatSheetIsOpen() && partyChatLog.some((e) => e.id !== myMemberId && e.chat && e.chat.at > partyChatSheetSeenAt);
  partyChatBubbleEl.classList.toggle('has-unread', unread);
}
// ---- PARTY CHAT ----------------------------------------------------------------------------
// Two ways to say something on the team page: tap a PRESET phrase (the same list the friend threads
// use, so there is nothing new to moderate), or type up to 40 characters. The message comes back on
// the next lobby broadcast as `member.chat` and renders as a bubble over that member's hero, so the
// sender sees their own message arrive exactly as everyone else does — no optimistic local echo that
// could disagree with what the room actually received.
//
// Free text is PARTY-ONLY and the server enforces it (shared/quick-messages.js FREE_TEXT_ROOMS);
// this hides the input rather than relying on that refusal, so the affordance matches the rule.
// The lobby composer speaks the IN-MATCH vocabulary (shared/quick-chat.js), not the friend-thread
// presets: a team page is the moment before a match, so "פס!" and a thumbs-up are the right words and
// «בוא נתאמן» is not. Words send as an id; emotes send as an id and render as the sprite the match
// uses, so the same message looks the same in the lobby and in the game.
// CSS percentage background-position is `(container - image) * pct`, NOT a per-cell offset, so
// `-col * 100%` (the obvious-looking formula) puts the sheet in the wrong place and the bubble renders
// blank — which is exactly how the first emote bubble looked. For an N x M sheet the cell sits at
// col/(cols-1) by row/(rows-1).
function chatSpriteStyle(el, item) {
  const { url, cols, rows } = CHAT_SHEET;
  el.style.backgroundImage = `url(${url})`;
  el.style.backgroundSize = `${cols * 100}% ${rows * 100}%`;
  el.style.backgroundPosition = `${(item.col / (cols - 1)) * 100}% ${(item.row / (rows - 1)) * 100}%`;
}
function chatBubbleNode(chat) {
  // ONE renderer for every surface (roster blocks and team rows), so a bubble cannot look like two
  // different things in two places. Emote → the pixel sprite from the shared sheet; word or free text
  // → the text itself, always via textContent.
  const span = document.createElement('span');
  const item = chat.chatId ? chatById(chat.chatId) : null;
  if (item && item.kind === 'emote') {
    span.className = 'bub-emote';
    chatSpriteStyle(span, item);
    span.setAttribute('aria-label', item.icon || item.id);
  } else {
    span.textContent = chat.text || (item ? item.text : '');
  }
  return span;
}
// The composer lives on BOTH team surfaces (the party roster and the lobby's team page), so it is
// BUILT here rather than written twice in the markup — two hand-copied copies of one control is how the
// MODES list drifted into four different versions.
function pchatMarkup(box) {
  if (box.childElementCount) return;
  box.innerHTML = '';
  const presets = document.createElement('div'); presets.className = 'pchat-presets';
  const form = document.createElement('form'); form.className = 'pchat-row'; form.autocomplete = 'off';
  const input = document.createElement('input');
  input.type = 'text'; input.className = 'pchat-input'; input.placeholder = 'כתבו הודעה…';
  input.maxLength = FREE_TEXT_MAX + 10;   // slack, so the counter can visibly reach 0 before the field stops
  input.setAttribute('aria-label', 'הודעה לקבוצה');
  const left = document.createElement('span'); left.className = 'pchat-left'; left.textContent = String(FREE_TEXT_MAX);
  const send = document.createElement('button'); send.type = 'submit'; send.className = 'pchat-send'; send.textContent = 'שלח';
  form.append(input, left, send);
  box.append(presets, form);
}
const pchatWired = new WeakSet();
function renderPartyChat(lob, boxId) {
  const box = document.getElementById(boxId || 'party-chat'); if (!box) return;
  pchatMarkup(box);
  const presets = box.querySelector('.pchat-presets');
  const form = box.querySelector('.pchat-row');
  const input = box.querySelector('.pchat-input');
  const left = box.querySelector('.pchat-left');
  // The picker is static, so build it once: the 8 calls, then the 8 emotes.
  if (presets && !presets.childElementCount) {
    for (const w of CHAT_WORDS) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'pchat-pre'; b.textContent = w.text; b.dataset.chatId = w.id;
      presets.appendChild(b);
    }
    for (const e of CHAT_EMOTES) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'pchat-pre is-emote'; b.dataset.chatId = e.id;
      b.setAttribute('aria-label', e.icon || e.id);
      chatSpriteStyle(b, e);
      presets.appendChild(b);
    }
  }
  const canType = lob && lob.freeText !== false;   // free text is party-only; the server agrees
  if (form) form.classList.toggle('hidden', !canType);
  if (!pchatWired.has(box)) {
    pchatWired.add(box);
    const sendChat = (o) => sendMsg({ type: 'partyChat', ...o });
    presets?.addEventListener('click', (e) => {
      const b = e.target.closest('[data-chat-id]'); if (!b) return;
      sendChat({ chatId: b.dataset.chatId });
    });
    form?.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = sanitizeFreeText(input ? input.value : '');
      if (!text) return;
      sendChat({ text });
      if (input) input.value = '';
      if (left) left.textContent = String(FREE_TEXT_MAX);
    });
    // The counter uses the SHARED sanitizer, so what it counts is what the server keeps: an emoji is
    // one character in both places and trailing spaces never count.
    input?.addEventListener('input', () => {
      if (!left) return;
      const rem = freeTextLeft(input.value);
      left.textContent = String(Math.max(0, rem));
      left.classList.toggle('over', rem <= 0);
    });
  }
}

// Host taps a live game → groups (#lobby, existing team-pick + play-now). Tapping the
// empty background LEAVES the party room (sub-page convention), sent via leaveToLobby().
let partyDownBackdrop = false;
partyEl?.addEventListener('pointerdown', (e) => { partyDownBackdrop = isDismissBackdrop(e.target, partyEl); });
partyEl?.addEventListener('click', (e) => {
  // Mode cards are rendered from MODES and handled by the delegated listener; here we
  // only need to keep a tap ON a card from being read as a backdrop tap (= leave room).
  // Matched on [data-mode-id], not on a class name — the party surface renders `.pcard` now, and
  // this guard silently stopped covering it when it was still spelled `.modecard`.
  if (e.target.closest('[data-mode-id]')) return;
  if (partyDownBackdrop && isDismissBackdrop(e.target, partyEl)) {
    partyDownBackdrop = false;
    // The chat sheet is a hovering overlay, not a navigation. While it's open, "tap the room" (the
    // same backdrop this listener already treats as a dismiss target) means CLOSE THE SHEET, per
    // the user's ask ("click the room it goes back down") — never also leave the party. Only once
    // the sheet is already closed does a backdrop tap fall through to its original meaning.
    if (partyChatSheetIsOpen()) { closePartyChatSheet(); return; }
    leaveToLobby();
  }
});

document.getElementById('friend-search')?.addEventListener('input', (e) => searchFriends(e.target.value.trim()));

// --------------------------------------------------------------------------
// Networking
// --------------------------------------------------------------------------
let pingIv = null;        // ping interval for the current socket (cleared on close)
let reconnectT = null;    // pending auto-reconnect timer
function connect(name, avatar) {
  myDisplayName = name || 'שחקן';
  myAvatarUrl = avatar || null;
  // wss when the page is served over https (Render), ws for local dev.
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}`);
  ws.binaryType = 'arraybuffer'; // snapshots arrive as compact binary frames
  ws.onopen = () => {
    setNet('connected');
    ws.send(JSON.stringify({ type: 'join', authToken: FOOTBALL_TOKEN, name, avatar, cards: myCards(), cosmetic: myCosmetic, loadout: effectiveLoadout() }));
    if (pingIv) clearInterval(pingIv);
    pingIv = setInterval(sendPing, 1000);   // 1s: enough RTT samples for a usable jitter figure
    loadFriends(); // register friends → server replies friendsPresence → bulb reflects online friends
    startThreadPoll();
    // ?watch=1 — go straight into a bot-only match. Sent right after `join` because the server
    // handles a socket's messages in order, so the member exists by the time this lands.
    if (WATCH && DEV_HOST) ws.send(JSON.stringify({ type: 'spectate', diffLevel: DIFF_PIN != null ? DIFF_PIN : diffLevel }));
  };
  // If the socket drops (network / server restart / WebView backgrounding), the
  // game would otherwise freeze forever — so fall back to the home menu and retry.
  ws.onclose = () => {
    setNet('reconnecting…');
    resetNetHud(); resetSnapshotRate();   // stale RTT/snapshot samples must not haunt the next socket
    if (pingIv) { clearInterval(pingIv); pingIv = null; }
    me = { playerId: null, team: null, char: chosenChar };
    latest = null; snaps = []; predicted = null; rendered = null;
    slotIds = []; slotTeam = []; rosterVersion = -1; // reset the binary-snapshot roster baseline
    if (!startEl.classList.contains('hidden')) return; // still on the title screen
    showScreen('home');
    resetPlayNow();
    if (!reconnectT) reconnectT = setTimeout(() => { reconnectT = null; connect(name, avatar); }, 900 + Math.floor(Math.random() * 900)); // jitter: avoid a synchronized reconnect storm on a deploy/flap
  };
  ws.onmessage = (e) => {
    if (typeof e.data !== 'string') { // compact binary snapshot
      // Ignore stray snapshots while in the lobby — but a SPECTATOR legitimately has no playerId
      // (server sends matchStart with playerId: null), and this one guard was enough to leave the
      // pitch completely empty while the arena and HUD rendered fine.
      if (!me.playerId && !SPECTATING) return;
      const snap = decodeSnapshot(new DataView(e.data), slotIds, slotTeam, rosterVersion);
      if (!snap) return; // roster seam / stale rosterVersion — wait for the matching roster
      processSnapshotSounds(snap);
      latest = snap;
      { const tNow = performance.now(); noteSnapshotRate(tNow); onSnapshot(tNow); } // rolling rate + freeze-gap stamp, one clock read
      holdingBall = snap.ball.owner === me.playerId;
      { const meP = snap.players && snap.players.find((p) => p.id === me.playerId); mySuper = !!(meP && meP.power); } // SUPER ready → charge fills 2× (mirrors sim)
      snaps.push({ tRecv: performance.now(), snap });
      if (snaps.length > 60) snaps.shift();
      if (me.playerId) reconcile(snap);   // nothing to reconcile without a local player
      return;
    }
    const msg = JSON.parse(e.data);
    if (msg.type === 'welcome') {
      myMemberId = msg.id; // our lobby identity; playerId + team arrive with matchStart
      MY_USER_ID = msg.userId || null;
      if (MY_USER_ID) { loadFriends(); loadThreads(); }   // unread badge without opening the screen
      // FIRST RUN: a brand-new player is taken straight into the tutorial. Fired here, on the
      // server's own hello, so the room request cannot race the socket coming up.
      tuMaybeAutoStart();
    } else if (msg.type === 'roster') {
      rosterVersion = msg.v; // slot->id/team map for the binary snapshots that follow
      slotIds = msg.slots.map((s) => s.id);
      slotTeam = msg.slots.map((s) => s.team);
      cosmeticById = {}; msg.slots.forEach((s) => { cosmeticById[s.id] = s.c || DEFAULT_COSMETIC; }); // per-player look (humans + bots)
    } else if (msg.type === 'bots') {
      // Refreshed bot dossier for the settings readout — sent when a mid-match backfill adds a bot
      // that `matchStart`'s roster could not have contained (e.g. a human left).
      matchBots = Array.isArray(msg.bots) ? msg.bots : [];
      if (typeof msg.diffLevel === 'number') {
        matchDiffLevel = msg.diffLevel;
        matchDiffFloor = matchDiffFloor == null ? msg.diffLevel : Math.min(matchDiffFloor, msg.diffLevel);
      }
      // Fold the fresh dossier back into the roster and repaint the in-match card rails. Two reasons:
      // a backfill bot that replaced a leaver needs a row, and a MID-GAME difficulty change re-rolls
      // every bot's cards server-side — without this the rails would keep showing the old level's
      // cards, i.e. the HUD would be lying about what the opponents are carrying.
      {
        const byId = new Map(matchRoster.filter(Boolean).map((p) => [p.id, p]));
        for (const b of matchBots) byId.set(b.id, b); // fresh entry wins
        matchRoster = [...byId.values()];
      }
      renderMatchPowers();
    } else if (msg.type === 'home') {
      homeOnlineEl.textContent = msg.online; // count only — don't yank the user off a sub-screen
    } else if (msg.type === 'roomJoined') {
      // RESOLUTION. The banner is chosen by HUMAN COUNT, never by mmReason: a 'deadline' group can
      // contain exactly one human, and announcing "נמצאו יריבים!" over four bots is the dishonesty
      // this screen was rebuilt to remove.
      if (searchingLive) showResolution((msg.humans | 0) >= 2);
      else hideSearching();
      roomMode = msg.mode; roomCode = msg.code || null;
      isRoomHost = !!msg.host;                 // #14: host gets approval + kick controls
      clearRoomRequests(); hideRoomWait();     // fresh room: no stale pending UI / waiting overlay
      clearLobbyLists(); resetPlayNow();
      // EVERY public matchmade mode gets the same pre-match VS/teams page (players + bots + power
      // cards) and the same countdown. Gated on the server's `matchmade` flag, NOT on a mode name —
      // goal-brawl used to fall through to the bare #lobby list purely because this read
      // `mode === 'quick'`, so the two live modes looked like different games. `|| mode === 'quick'`
      // keeps a pre-flag server working during a rolling deploy.
      if (msg.matchmade || msg.mode === 'quick') { quickVs = true; showScreen('home'); startLobbyMusic(); } // VS + countdown overlay drives the wait
      else if (partyFlow) { quickVs = false; hideVs(); startLobbyMusic(); showScreen('party'); renderParty(); } // team-first: always the roster, host or invited member alike
      else { quickVs = false; hideVs(); showScreen('lobby'); startLobbyMusic(); }           // #12: lobby theme instantly
      if (pendingPartyApply && isRoomHost) { pendingPartyApply = false; applyPartyPicks(); } // add picked bots + invite friends
    } else if (msg.type === 'toHome') {
      if (msg.online != null) homeOnlineEl.textContent = msg.online;
      me = { playerId: null, team: null, char: chosenChar };
      partyFlow = false; lastLobby = null; invitedSet.clear(); closeInviteSheet();
      clearRoomRequests(); hideRoomWait();   // #14: no stale host/joiner room UI back home
      quickVs = false; hideVs(); hideSearching(); showScreen('home');
      if (matchResultSent) {                 // a real match just finished -> celebrate the XP the app injects on return
        _awaitXpReveal = true;
        armRankReveal();                     // ...and reveal the RANK change, which may be a DROP
        // Force the progression re-read NOW instead of waiting out RANK_SELF_MS. The reveal only
        // fires when the client OBSERVES xp increase (see the hub loop), and when we own the value
        // rather than the app -- an app build older than the SALTIZ_XP inject, or any browser
        // surface -- that observation is gated behind a 60s rate limit. So the match ends, the
        // server credits the trophies, and the animation silently never plays because the client is
        // still holding the pre-match number. Reported as "I don't see the score increase animation
        // after a bot game". Zero-ing the timestamp lets the next 700ms poll fetch immediately.
        // Harmless when the app DOES inject: _mineXp is false then, so fetchOwnProgress leaves
        // window.SALTIZ_XP alone and the app's own injectXp drives the reveal as before.
        _rankSelfAt = 0;
        simulateXpGainForDemo();             // localhost only (no native app to inject xp); no-op on device/Render
      }
    } else if (msg.type === 'chat') {
      onChatMessage(msg.pid, msg.id);   // someone spoke -> bubble over THEIR hero, for everyone
    } else if (msg.type === 'roomError') {
      quickVs = false; hideVs(); hideSearching(); hideRoomWait(); partyFlow = false; closeInviteSheet();
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
      partyFlow = false; lastLobby = null; closeInviteSheet();
      toast('הוסרת מהחדר על ידי המארח');
      showScreen('home');
    } else if (msg.type === ROOM_MSG.JOIN_REQUEST) {     // #14 host: someone wants to join
      pendingReqs.set(msg.joinerId, { joinerId: msg.joinerId, userId: msg.userId || null, name: msg.name || 'שחקן', avatar: msg.avatar || null, cosmetic: msg.cosmetic, cards: msg.cards || [] });
      renderRoomRequests();
      toast('בקשת הצטרפות חדשה');
    } else if (msg.type === ROOM_MSG.JOIN_CANCELLED) {   // #14 host: that pending joiner left
      pendingReqs.delete(msg.joinerId);
      renderRoomRequests();
    } else if (msg.type === 'searching') {
      showSearching(msg);
    } else if (msg.type === 'lobby') {
      if (quickVs) { updateVsCountdown(msg); }
      else { lastLobby = msg; updateLobbyUI(msg);
        if (partyFlow && friendSelectEl && !friendSelectEl.classList.contains('hidden')) renderInvite();
        if (partyEl && !partyEl.classList.contains('hidden')) renderParty(msg); }
    } else if (msg.type === 'matchStats') {
      myMatchStats = msg.stats || null;                 // per-player tallies for the just-ended match
      if (_pendingPost) { const f = _pendingPost; _pendingPost = null; f(); } // release a deferred result post
    } else if (msg.type === 'matchStart') {
      enterMatch(msg);
    } else if (msg.type === 'toLobby') {
      exitToLobby();
    } else if (msg.type === 'pong') {
      ping = Math.round(performance.now() - msg.t);
      onPong(ping);                                     // feed the jitter window
    } else if (msg.type === 'friendsPresence') {
      ONLINE = new Set(msg.online || []);
      updateFriendsDot();
      if (!document.getElementById('friends')?.classList.contains('hidden')) renderOnlineFriends();
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
  // SPECTATING: there is no local player, so hide the controls that would pretend otherwise.
  // Everything else — HUD, score, clock, cards, sounds — is exactly what a player sees.
  if (msg.spectate) {
    SPECTATING = true;
    document.body.classList.add('spectate');
    if (!document.getElementById('spectate-css')) {
      const st = document.createElement('style');
      st.id = 'spectate-css';
      st.textContent = '.spectate #stickL,.spectate #stickR,.spectate #special,.spectate #build,'
        + '.spectate #controls-edit-btn,.spectate #stealth{display:none!important}'
        + '.spectate #watch-tag{position:fixed;left:8px;bottom:8px;z-index:60;font:600 11px/1.4 ui-monospace,monospace;'
        + 'color:#fff;background:rgba(0,0,0,.55);padding:4px 8px;border-radius:6px;pointer-events:none}';
      document.head.appendChild(st);
    }
    if (!document.getElementById('watch-tag')) {
      const t = document.createElement('div');
      t.id = 'watch-tag';
      t.textContent = `WATCHING BOTS · level ${msg.diffLevel} · camera follows the ball`;
      document.body.appendChild(t);
    }
  }
  clearRoomRequests(); hideRoomWait();   // #14: drop any host/joiner room UI as the match starts
  if (msg.settings) { Object.assign(settings, msg.settings); syncSliderUI(); }
  // apply this room's bot difficulty LEVEL. ONLY quick-match derives it from player XP (fair
  // matchmaking); play-with-bots / training / private / builder keep the manual picker value.
  // (training isn't set until below, so read msg.mode here.)
  const xpModes = msg.mode === 'quick';
  const lvlToSend = xpModes ? xpDiffLevel() : diffLevel;
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'settings', diffLevel: lvlToSend }));
  // Reset all interpolation / prediction / sound state for the fresh match.
  latest = null; snaps = []; predicted = null; rendered = null; predVel = { x: 0, y: 0 };
  previousBallOwner = null; previousResetTimer = 0;
  knownBlasts = new Set(); knownImpacts = new Set(); knownWalls = new Map(); knownBombs = new Set(); soundEventsReady = false;
  specialBtn.textContent = specialIcon(me.char);
  matchRoster = Array.isArray(msg.players) ? msg.players : [];
  // The bots in this match, with their difficulty + card slots + the buffs the sim really applies.
  // Shown in the settings panel; refreshed by the 'bots' control frame after a mid-match backfill.
  matchBots = matchRoster.filter((p) => p && p.isBot);
  // Pull the WHOLE crowd's card art onto the device at kickoff so it never pops in mid-match
  // (the wire only ever carries compact position/state data — never art). Images cache in
  // _cardImgs for the session and in the browser/WebView HTTP cache across sessions.
  preloadCards(myCards()); matchRoster.forEach((p) => preloadCards(p.cards));
  // Match FORMAT: first-to-N goals, or 0 = timed (most goals). Sent by the server since the
  // format is a per-room property (a private room can pick brawl); the client can't infer it.
  matchGoalsToWin = msg.goalsToWin | 0;
  // Players per side for THIS match (2 normally, 3 at 3v3). Drives the my-team reveal, which used to
  // hardcode two columns and so hid the third teammate entirely. Server-sent, like goalsToWin.
  matchTeamSize = Math.max(1, msg.teamSize | 0 || 2);
  matchId = msg.matchId || null; // stable id for this match's app-bound result
  // The room's AUTHORITATIVE bot difficulty, straight from the server (the client can't infer it —
  // xpDiffLevel() is only what we ASKED for, and a private/party room may have set its own). Reported
  // in matchResult so the backend can apply the trophy BOT CEILING for the level actually played.
  matchDiffLevel = (typeof msg.diffLevel === 'number') ? msg.diffLevel : null;
  matchDiffFloor = matchDiffLevel; // fresh match: the floor starts at the level it kicked off on
  matchOpponentKey = typeof msg.opponentKey === 'string' ? msg.opponentKey : '';
  matchResultSent = false;       // arm the one-shot matchResult post for the fresh match
  myMatchStats = null; _pendingPost = null; // clear last match's per-player tallies + any pending post
  celeb = null;                  // clear any lingering goal/win/lose celebration overlay
  audienceReady = false; // rebuild seat assignment for this match's roster
  training = msg.mode === 'training';
  tutorial = msg.mode === 'tutorial';
  if (msg.mode) roomMode = msg.mode; // keep the room tier (training/botgame/builder/private/quick) for settings gating
  // Field-builder match: server sends a custom arena layout — build the render/collision arena
  // from it (hard walls + bushes). Dry walls ride the snapshot as built walls. null otherwise.
  customArena = msg.arena ? buildArenaFromField(msg.arena) : null;
  document.getElementById('train-tag').classList.toggle('hidden', !training);
  // Training-only bot-level chip: shows the live level and opens the difficulty grid (mid-game).
  document.getElementById('train-diff')?.classList.toggle('hidden', !training);
  syncDiffChips();
  // Controls editor gets its OWN top-bar button beside ⚙ — in EVERY mode, not just the training
  // ground (user, 2026-07-26: "in the games add the control edit icon"). It used to be training-only
  // "so a real match can't have someone editing mid-play", but ⚙ הגדרות is already reachable
  // mid-match and does not pause either, so the trade-off is one the player already owns: the editor
  // hides the live sticks (openControlsEditor), so while it is open you are standing still. Being
  // able to fix a badly-placed thumb button in the match where you noticed it beats remembering to
  // go back to training. It lives inside #game, so leaving the pitch hides it with the screen.
  document.getElementById('edit-controls-btn')?.classList.remove('hidden');
  // The lobby's 🎛️ started this training room for exactly one reason. A beat first, so the editor opens
  // onto a laid-out pitch rather than mid-transition.
  if (pendingControlsEditor) { pendingControlsEditor = false; setTimeout(openControlsEditor, 350); }
  // Quick chat rides with it: same cluster, same lifetime. Inside #game, so leaving the pitch hides it.
  document.getElementById('chat-btn')?.classList.remove('hidden');
  document.getElementById('chat-sheet')?.classList.add('hidden');
  document.getElementById('reset-ball-btn').classList.toggle('hidden', !training);
  // TUTORIAL: strip the pitch of everything the lesson hasn't reached. The top-bar cluster
  // (controls editor, quick chat) and the settings gear are three more unexplained buttons in the
  // corner of a screen a seven-year-old is meeting for the first time.
  // #hud goes too, and that one is not just tidiness: the tutorial room is noClock, but the HUD
  // still renders MATCH_DURATION ticking down. A first-timer being taught to walk should not be
  // watching a countdown — a clock that means nothing still reads as time pressure. It takes the
  // 0-0 score and the card rails with it. All of it returns the moment the tutorial ends.
  // #banner goes with the rest: after the kid scores on a goal step the sim runs its normal
  // kickoff reset, and .banner.count draws a 200px countdown number over the next lesson. In a
  // tutorial that is a countdown to nothing — the coach owns the messaging here.
  const tuChrome = ['edit-controls-btn', 'chat-btn', 'pause-btn', 'hud', 'banner'];
  if (tutorial) {
    for (const id of tuChrome) document.getElementById(id)?.classList.add('tu-off');
    tuEnter(msg.tuLevel | 0);
  } else {
    for (const id of tuChrome) document.getElementById(id)?.classList.remove('tu-off');
    tuExit();
  }
  renderMatchPowers(); // equipped-cards HUD next to the timer (read-only)
  showScreen('game');
  resize();
  renderBackground(); // re-cache the field/stands in our team colours
  if (training || tutorial) hideTeamIntro();          // training/tutorial: straight onto the pitch, no intro
  else if (msg.intro > 0) { quickVs = false; hideTeamIntro(); playPromo(msg.intro); } // team reveal + card-meteor promo
  else if (quickVs) { quickVs = false; hideTeamIntro(); } // the VS countdown already served as the intro
  else showTeamIntro(msg.players);                    // fallback: brief VS intro overlay
  resetPlayNow();
  if (training || tutorial) startTrainingMusic();      // training ground + tutorial get the calm theme
  else startMatchMusic();                              // real match: random background song
}

// Match ended in a private room -> back to that room's lobby (rematch).
function exitToLobby() {
  me = { playerId: null, team: null, char: chosenChar };
  latest = null; snaps = []; predicted = null; rendered = null;
  tutorial = false; tuExit();   // leaving the pitch always takes the coach with it
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
  partyFlow = false; lastLobby = null; invitedSet.clear(); closeInviteSheet(); closePartyChatSheet();
  quickVs = false; hideVs(); hideTeamIntro(); hideRoomWait(); clearRoomRequests();
  me = { playerId: null, team: null, char: chosenChar };
  latest = null; snaps = []; predicted = null; rendered = null;
  tutorial = false; tuExit();   // leaving the pitch always takes the coach with it
  resetPlayNow();
  stopMusic();
  showScreen('home'); // startHomeMusic() fires here (quickVs is false)
}

// ---- Team intro overlay + match roster --------------------------------------
let matchRoster = [];        // [{id,name,avatar,team,cards}] from matchStart (humans)
let matchTeamSize = 2;       // players per side this match (matchStart.teamSize) — 3 at 3v3
let matchBots = [];          // [{id,team,loadout,buffs,skill,botLevel}] — the bots, for the settings readout
let audienceReady = false;   // seat layout rebuilt per match (see drawAudience)
let crowdHypeT = -1e9;        // timestamp of the last goal — the crowd erupts (leaps) then settles
const teamIntroEl = document.getElementById('team-intro');
const tiCountEl = document.getElementById('ti-count');
const tiModeEl = document.getElementById('ti-mode');
let introTimer = null;
// quickVs is declared above the startup init block (hoisted to avoid a load-time TDZ:
// showScreen('home') reads it for the lobby-music gate before this point would run).
function hideVs() { if (tiCountEl) tiCountEl.classList.add('hidden'); tiModeEl?.classList.add('hidden'); hideTeamIntro(); }
// Name the mode + its win rule on the VS page. The name comes from the MODES table (matched on the
// `format` key the server sends) so it can't drift from the picker; the rule comes from the room,
// because that's the value the sim will actually enforce.
function showVsMode(msg) {
  if (!tiModeEl) return;
  const m = MODES.find((x) => x.format && x.format === msg.format);
  const rule = msg.rule || (msg.goalsToWin > 0 ? `ראשון ל-${msg.goalsToWin}` : 'הכי הרבה גולים · 2 דקות');
  tiModeEl.querySelector('.ti-mode-name').textContent = m ? `${m.ic} ${m.name}` : '';
  tiModeEl.querySelector('.ti-mode-rule').textContent = rule;
  tiModeEl.classList.remove('hidden');
}
// SEARCHING — a ticket is live and no room exists yet, so there is no `lobby` payload to ride on.
// My own row is rendered from local state; opponent rows are deliberately EMPTY. Preview bots used to
// fill them from the first tick, which made the wait look like a decided lineup.
let searchingLive = false;
function showSearching(msg) {
  if (!teamIntroEl) return;
  searchingLive = true;
  const box0 = document.getElementById('ti-search');
  box0?.classList.remove('found', 'alone');   // a fresh search must not inherit the last one's banner
  quickVs = true;
  const perTeam = Math.max(1, ((msg.slots && msg.slots.total) || 4) / 2);
  // No `loadout` needed: introCardsFor() already special-cases p.id === myMemberId and reads
  // effectiveLoadout() directly, so my row shows my LIVE slots rather than a snapshot.
  const mine = { id: myMemberId, name: myDisplayName, team: 'A', avatar: myAvatarUrl, cards: myCards() };
  const cols = teamIntroEl.querySelectorAll('.ti-col');
  fillIntroCol(cols[0], [mine], 'A', perTeam);
  fillIntroCol(cols[1], [], 'B', perTeam);
  // The search's countdown lives in renderSearchChrome's small inline #ti-search-timer now, NOT
  // setTiCount/#ti-count — that giant "5..4..3.." number means "kickoff is certain and imminent"
  // everywhere else in this game (updateVsCountdown drives it for the real kickoff). Reusing it for a
  // search BUDGET lied on the common path (the search can still widen, grace-extend, or end in bots),
  // and a granted grace ticket reports a flat fresh remainingMs, so the giant number could round to 0,
  // hide (setTiCount(null)), then reappear at 5 and count down again — reading exactly like the lag
  // this redesign exists to stop looking like. setTiCount/#ti-count are otherwise untouched.
  renderSearchChrome(msg);
  teamIntroEl.classList.remove('hidden');
  requestAnimationFrame(() => teamIntroEl.classList.add('show'));
  startLobbyMusic();
}
function renderSearchChrome(msg) {
  const box = document.getElementById('ti-search');
  if (!box) return;
  box.classList.remove('hidden');
  const total = (msg.slots && msg.slots.total) || 4;
  const filled = (msg.slots && msg.slots.filled) || 1;
  const pips = document.getElementById('ti-search-pips');
  pips.innerHTML = '';
  for (let i = 0; i < total; i++) { const d = document.createElement('i'); if (i < filled) d.className = 'on'; pips.appendChild(d); }
  const band = document.getElementById('ti-search-band');
  band.textContent = msg.bandLo && msg.bandHi
    ? (msg.bandLo === msg.bandHi ? `רמה ${msg.bandLo}` : `רמה ${msg.bandLo}–${msg.bandHi}`) : '';
  const n = +msg.searchingCount || 0;
  document.getElementById('ti-search-sub').textContent = n > 1 ? `${n} שחקנים מחפשים כרגע` : '';
  document.getElementById('ti-search-title').textContent = 'מחפש יריבים...';
  // Small SECONDARY inline timer (⏱ N) — see the note at showSearching's call site for why this is
  // not the giant #ti-count. NEVER hidden/nulled while a search is live: a grace extension genuinely
  // adds time (a fresh ticket's remainingMs really does jump back up), so the honest move is to let
  // the number rise rather than hide it and pop back — the band chip above (רמה 5 -> רמה 4–6) is what
  // explains WHY the wait continued, exactly as it already does for the pip row / searching count.
  const timer = document.getElementById('ti-search-timer');
  if (timer) timer.textContent = `⏱ ${Math.max(0, Math.ceil((msg.remainingMs || 0) / 1000))}`;
}
function hideSearching() {
  searchingLive = false;
  document.getElementById('ti-search')?.classList.add('hidden');
}
function showResolution(foundHumans) {
  const box = document.getElementById('ti-search');
  const title = document.getElementById('ti-search-title');
  const sub = document.getElementById('ti-search-sub');
  if (!box || !title) { hideSearching(); return; }
  searchingLive = false;
  box.classList.remove('hidden');
  box.classList.add(foundHumans ? 'found' : 'alone');
  title.textContent = foundHumans ? 'נמצאו יריבים!' : 'אין שחקנים פנויים כרגע';
  sub.textContent = '';
  document.getElementById('ti-search-pips')?.querySelectorAll('i').forEach((d) => d.classList.add('on'));
  const timer = document.getElementById('ti-search-timer'); // search is over — no more budget to show
  if (timer) timer.textContent = '';
}
// Quick-match VS screen: HOME (my team) vs RIVALS from lobby members (bots fill empty
// slots), with the big 5..0 countdown. Refreshed on every lobby payload.
function updateVsCountdown(msg) {
  if (!teamIntroEl) return;
  // Keep whatever resolution banner showResolution set; only a fresh search replaces it.
  const searchBox = document.getElementById('ti-search');
  const keepBanner = searchBox && !searchBox.classList.contains('hidden')
    && (searchBox.classList.contains('found') || searchBox.classList.contains('alone'));
  // #18: the server previews the bots that will fill the empty slots (msg.bots — each with team +
  // loadout + cards), so opponents show WITH their power cards during the wait/countdown, not only at
  // the pre-kickoff reveal. fillIntroCol already renders isBot rows + loadout art.
  const roster = (msg.members || []).concat(msg.bots || []);
  const mine = (roster.find((m) => m.id === myMemberId) || {}).team || 'A';
  const cols = teamIntroEl.querySelectorAll('.ti-col');
  // Rows per side come from the room's format (2 today; 3/5 when those formats land), never from
  // the roster length — empty slots must still render as the "waiting for a player" placeholder.
  const perTeam = Math.max(1, +msg.teamSize || 2);
  fillIntroCol(cols[0], roster, mine, perTeam);
  fillIntroCol(cols[1], roster, mine === 'A' ? 'B' : 'A', perTeam);
  showVsMode(msg);
  preloadCards(roster.flatMap((m) => introCardsFor(m)));
  startLobbyMusic(); // #12: lobby theme plays for the whole wait (starts on entry, loops through the countdown)
  setTiCount(msg.phase === 'countdown' && msg.countdown > 0 ? msg.countdown : null);
  if (!keepBanner) hideSearching();
  teamIntroEl.classList.remove('hidden');
  requestAnimationFrame(() => teamIntroEl.classList.add('show'));
}
// The 5..0 number lives OVER the centre gutter (see .ti-count), so showing it has to hide «נגד» —
// one helper does both, because two call sites toggling `.hidden` by hand is how they drift apart.
// `null` clears it.
function setTiCount(n) {
  if (!tiCountEl) return;
  if (n == null) { tiCountEl.classList.add('hidden'); teamIntroEl && teamIntroEl.classList.remove('counting'); return; }
  tiCountEl.textContent = n;
  tiCountEl.classList.remove('hidden');
  teamIntroEl && teamIntroEl.classList.add('counting');
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
function fillIntroCol(colEl, players, team, perTeam = 2) {
  const rows = colEl.querySelector('.ti-rows'); rows.innerHTML = '';
  colEl.dataset.size = perTeam;   // CSS shrinks the rows for the bigger formats
  const roster = players.filter((p) => p.team === team);
  for (let i = 0; i < perTeam; i++) {
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
      // Bot level + XP badge — the server previews each bot's level (from player-XP-driven difficulty).
      if (isBot && Number.isFinite(+p.level)) {
        const lv = document.createElement('span'); lv.className = 'ti-lvl';
        lv.style.cssText = 'display:block;font-size:11px;font-weight:700;opacity:.78;margin-top:1px';
        lv.textContent = `רמה ${+p.level} · ${fmtCompact(+p.xp || 0)} XP`;
        nm.appendChild(lv);
      }
      introCardsFor(p).forEach((c) => cw.appendChild(introCardEl(c))); // bots included (#18)
    } else { row.classList.add('ti-empty'); av.textContent = '⌛'; nm.textContent = 'מחפש...'; }
    row.append(av, nm, cw);
    rows.appendChild(row);
  }
}
function showTeamIntro(players) {
  if (!teamIntroEl || !Array.isArray(players)) return;
  const mine = me.team === 'B' ? 'B' : 'A';
  const cols = teamIntroEl.querySelectorAll('.ti-col');
  // Rows per side = THIS match's format (matchStart.teamSize). Omitting it defaulted to 2, so the
  // 3v3 match-start intro silently dropped the third player on each side.
  const perTeam = Math.max(1, matchTeamSize | 0 || 2);
  fillIntroCol(cols[0], players, mine, perTeam);                       // home column = my team
  fillIntroCol(cols[1], players, mine === 'A' ? 'B' : 'A', perTeam);   // away column = rivals
  preloadCards(players.flatMap((p) => introCardsFor(p)));     // #18: bots' loadout art too
  teamIntroEl.classList.remove('hidden');
  requestAnimationFrame(() => teamIntroEl.classList.add('show'));
  clearTimeout(introTimer);
  introTimer = setTimeout(hideTeamIntro, 3000);
}
function hideTeamIntro() {
  clearTimeout(introTimer);
  if (!teamIntroEl) return;
  setTiCount(null);
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
  // My team — one column per slot, from THIS match's team size (2 normally, 3 at 3v3). Was a
  // hardcoded 2, which silently dropped the third teammate from the reveal at 3v3.
  const mates = matchRoster.filter((p) => p.team === me.team);
  const perTeam = Math.max(1, matchTeamSize | 0 || 2);
  promoEl.dataset.size = perTeam;   // CSS tightens the columns so 3 heroes still fit the width
  const queue = []; promoBoosters = [];
  for (let i = 0; i < perTeam; i++) {
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
  // 5th child: the chat bubble slot. Appended AFTER kick so the existing [av, nm, st] destructure and
  // `row.children[3]` kick lookup both keep working.
  const say = document.createElement('div'); say.className = 'mr-say';
  row.append(av, nm, st, kick, say);
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
  // Party flow: invites already happened on the invite screen — the groups page is just
  // team-pick + a BIG «שחק עכשיו» for the host. The «בחר משחק» picker is superseded (the game
  // was chosen on the roster), and the lobby invite panel is hidden (renderPartyInvite).
  const pickGameBtn = document.getElementById('pick-game-btn');
  if (pickGameBtn) pickGameBtn.style.display = 'none';
  playNowBtn.style.display = (isPrivate && isRoomHost) ? '' : 'none';
  { const sp = playNowBtn.querySelector('span'); if (sp) sp.textContent = 'שחק עכשיו'; }
  lobbyHintEl.textContent = !isPrivate
    ? 'מחפש שחקנים… המשחק יתחיל אוטומטית.'
    : isRoomHost
      ? 'בחרו קבוצות ואז «שחק עכשיו». מקומות פנויים יתמלאו בבוטים.'
      : 'בחרו קבוצה — המארח יתחיל את המשחק.';
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
    const cos = m.cosmetic || DEFAULT_COSMETIC;
    const heroKey = cos + '|' + m.team;     // redraw when the look OR the team (gaze) changes
    if (row._cos !== heroKey) {             // small HERO drawn from the member's cosmetic (was an avatar photo)
      row._cos = heroKey;
      av.innerHTML = '';
      av.appendChild(teamHeroCanvas(cos, m.team));
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
    // The member's last message, as a bubble on their row — same renderer the party roster uses.
    const say = row.children[4];
    if (say) {
      const stamp = (m.chat && m.chat.at) || 0;
      if (say._stamp !== stamp) {
        say._stamp = stamp;
        say.innerHTML = '';
        say.classList.toggle('has', !!(m.chat && (m.chat.text || m.chat.chatId)));
        if (m.chat && (m.chat.text || m.chat.chatId)) say.appendChild(chatBubbleNode(m.chat));
      }
    }
  }
  for (const [id, row] of memberRows) {
    if (!seen.has(id)) { row.remove(); memberRows.delete(id); }
  }
  // EMPTY SEATS. The columns were purely a list of who had joined, so a 3v3 room looked exactly like a
  // 2v2 one until the sixth player arrived — nothing on the page said how many seats a side has, and
  // the bots that fill them appear only at kickoff. One placeholder per unfilled seat, so the shape of
  // the match is visible while you wait.
  const size = msg.teamSize || 2;
  for (const t of ['A', 'B']) {
    const listEl = teamListEl[t]; if (!listEl) continue;
    const taken = msg.members.filter((m) => (m.team === 'B' ? 'B' : 'A') === t).length;
    for (const ghost of [...listEl.querySelectorAll('.member-ghost')]) ghost.remove();
    for (let i = taken; i < size; i++) {
      const g = document.createElement('div');
      g.className = 'member-row member-ghost';
      const av = document.createElement('div'); av.className = 'member-av';
      const nm = document.createElement('div'); nm.className = 'member-name';
      nm.textContent = 'בוט';          // short on purpose: the column is ~120px on a phone and
                                        // 'מקום פנוי · בוט' truncated to 'מקום פנוי ·'
      g.append(av, nm);
      listEl.appendChild(g);
    }
    const head = document.querySelector(`[data-team-head="${t}"]`);
    if (head) head.textContent = `${taken}/${size}`;
  }
  joinBtn.A.classList.toggle('current', myLobbyTeam === 'A');
  joinBtn.B.classList.toggle('current', myLobbyTeam === 'B');
  // The lobby gets the same composer as the roster page: this IS the team page.
  renderPartyChat(msg, 'lobby-chat');
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
// `slowing` = was this step taken while the SERVER was winding up a wall? The sim halves your
// speed for the whole windup (shared/sim.js, BUILD_WINDUP_SLOW). If the prediction skips that,
// the local hero — and the build ghost anchored to it — runs ahead for as long as you hold the
// button and then rubber-bands mid-aim, so the wall lands off by that drift.
// We can't recompute the sim's gate locally: it also depends on p.buildCd, which is NOT on the
// wire and is scaled per player by cdMul/cardUtil. The authoritative `winding` flag IS on the
// wire and the sim raises it under the same conditions it applies the slow — so follow that
// (see ownBuildSlowing) instead of mirroring a cooldown the client would get wrong for anyone
// holding a utility card.
// STILL UNMIRRORED (pre-existing, larger than this drift for buffed players): p.speedBuff and
// p.slowStacks, neither of which is on the wire.
function ownSpeed(slowing) {
  const base = (CHARACTERS[me.char]?.speed || CHARACTERS.player.speed) * settings.speedMul;
  const spd = holdingBall ? base * settings.carrySpeedMul : base;
  return slowing ? spd * BUILD_WINDUP_SLOW : spd;
}
// currentWindup() already resolves "is the server actually winding for me" — it runs on the
// local clock for one round-trip's grace and then follows the snapshot's `winding` flag, so it
// is 0 when a cooldown, an empty mag or a ball in hand is blocking the build.
function ownBuildSlowing() { return buildHolding && currentWindup() > 0; }
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
// `slowing` is the build-windup state of THE STEP BEING PREDICTED, not of now — a replay of
// older inputs has to reproduce the speed each of them actually ran at (see pendingInputs).
function stepPrediction(moveX, moveY, dt, slowing) {
  let mx = moveX, my = moveY;
  const len = Math.hypot(mx, my);
  if (len > 1) { mx /= len; my /= len; }
  const spd = ownSpeed(slowing);
  const tvx = mx * spd, tvy = my * spd;
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

// Reconcile the prediction against the authoritative snapshot. With USE_REPLAY: hard-set to
// the server's own-player pos/vel, drop inputs the server already applied (seq <= lastSeq),
// then re-apply the still-unacked ones — so own motion is drift-free even on real RTT instead
// of the old lerp-lag/rubber-band. (Movement is deterministic vs the server; a hit's knockback
// inside the unacked window is a small bounded error, corrected on the next snapshot.)
function reconcile(snap) {
  const server = snap.players.find((p) => p.id === me.playerId);
  if (!server) return;
  if (!predicted) { predicted = { x: server.x, y: server.y }; rendered = { ...predicted }; predVel = { x: 0, y: 0 }; pendingInputs = []; return; }
  if (snap.resetTimer > 0) { // kickoff freeze: sit exactly where the server puts us
    predicted.x = server.x; predicted.y = server.y; predVel.x = 0; predVel.y = 0; pendingInputs = []; return;
  }
  if (!USE_REPLAY) {
    predicted.x += (server.x - predicted.x) * 0.2;
    predicted.y += (server.y - predicted.y) * 0.2;
    return;
  }
  const ack = server.lastSeq || 0;
  predicted.x = server.x; predicted.y = server.y;
  predVel.x = server.vx || 0; predVel.y = server.vy || 0;
  while (pendingInputs.length && pendingInputs[0].seq <= ack) pendingInputs.shift();
  for (const p of pendingInputs) stepPrediction(p.moveX, p.moveY, p.dt, p.slowing);
}

// --------------------------------------------------------------------------
// Input — keyboard/mouse (desktop) + dual touch joysticks (mobile)
// --------------------------------------------------------------------------
let holding = false;       // fire trigger currently HELD (charge builds server-side)
let fireQueued = false;    // a real fire (pulled-out release) this frame
let aimedShot = false;     // was THIS queued shot AIMED (aim pulled) vs a bare quick tap? → sent as inp.aimed
let specialQueued = false; // special skill
let buildQueued = false;   // a wall build was released this frame
let buildHold = null;      // aim captured at build-button release (drag-to-aim)
let aimHold = null;        // aim captured at right-stick release (fire direction)
let chargeStart = null;    // timestamp the hold began — LOCAL charge estimate for the HUD only
const AIM_DEADZONE_PX = 12; // stick/cursor pull past this = a real shot; inside it = cancel
// ---- Brawl-Stars-style drag-to-aim: SENSITIVITY (finger travel → max distance) + per-control REACH ----
// Client-only aim FEEL: the server never reads these, but they matter in real matches too, so they live
// here (persisted to localStorage) and are NOT part of SETTING_KEYS (which auto-syncs to the server).
function loadAimNum(k, d) { try { const v = parseFloat(localStorage.getItem(k)); return Number.isFinite(v) ? v : d; } catch { return d; } }
// PULL DISTANCE, per control. This is how far past the dead-zone your thumb must travel to reach
// MAX reach — i.e. the sensitivity. It is PER CONTROL because a wall (short, precise placement) and
// a bomb (long lob) want different thumb throws. Drawn in the editor as the OUTER square around each
// button, so it's a thing you see and size rather than an abstract slider number (Brawl Stars makes
// stick size itself the sensitivity control for the same reason).
const AIM_SENS_KEY = { bomb: 'fbSensBomb', wall: 'fbSensWall' };
// Pull-square defaults, from the same exported settings as CTL_SHIPPED_LAYOUT. Recovered from that
// layout's own `sens` values, because ce-save writes the draft to BOTH places from one number.
const aimSens = { bomb: loadAimNum('fbSensBomb', 71.5625), wall: loadAimNum('fbSensWall', 57.01173400878906) };
let aimSensPx = loadAimNum('fbAimSens', 160);                      // legacy global fallback (pre-per-control saves)
let bombMaxPx = loadAimNum('fbBombMax', BOMB_LOB_RANGE);           // bomb lob reach ceiling (server hard-caps at BOMB_LOB_RANGE)
let wallMaxPx = loadAimNum('fbWallMax', BUILT_WALL.offset + 32);   // wall total reach; default 92 = old offset+thick (feel-preserving)
// Cancel dead-zone (Brawl: drag back toward centre = cancel) — the state machine itself lives in
// shared/drag-cancel.js so it is unit-testable and both buttons share one rule.
// PULL RESPONSE CURVE — the second dimension of aim feel, on top of the sensitivity DISTANCE above.
// Sensitivity says how far you must drag to reach max; the curve says how the reach is DISTRIBUTED
// across that drag (Brawl-Stars-style: the throw lands where you point, and short pulls stay short).
// Applied as frac = t^AIM_CURVE on the normalized 0..1 pull, so both endpoints stay pinned (0→0, 1→1)
// and the cancel dead-zone + max reach are untouched. Purely input feel; the sim never sees it.
//
// NOT a setting. The user's call (2026-07-25): "remove the עקומת משיכה, leave it on accurate 2.2" —
// so the curve is PINNED at the precise end of the old 0.6–2.2 slider. Most of the drag buys fine
// control up close and max reach needs a full pull, which is the Brawl-Stars-style aim we want by
// default. Don't re-expose it as a slider; the stale `fbAimCurve` key is deliberately ignored.
const AIM_CURVE = 2.2;
// IDLE OPACITY of the on-screen controls. Every shipped editor in the genre exposes this (CoD Mobile
// + Free Fire transparency sliders; Unreal makes ActiveOpacity/InactiveOpacity first-class engine
// params) — it's the one rung Brawl Stars' editor lacks. Controls go fully opaque while touched.
// 0.5 is the previous hard-coded .stick value, so the default is a no-op.
let ctlIdleOp = loadAimNum('fbCtlOpacity', 0.5);
function applyCtlOpacity() { document.documentElement.style.setProperty('--ctl-idle-op', String(ctlIdleOp)); }
applyCtlOpacity();
// Shared drag → 0..1 fraction (after the deadzone, capped by that control's pull distance).
// `ctl` is 'bomb' or 'wall'; the outer square drawn in the editor IS this number.
function aimFrac(len, ctl) {
  const s = Math.max(aimSens[ctl] || aimSensPx, AIM_DEADZONE_PX + 1);
  const t = clamp((len - AIM_DEADZONE_PX) / (s - AIM_DEADZONE_PX), 0, 1);
  return Math.pow(t, AIM_CURVE);   // endpoints pinned: 0→0, 1→1
}
function buildPushFrac(dx, dy) { return aimFrac(Math.hypot(dx, dy), 'wall'); }
// Wall aimMag (0..1) the sim consumes: dist = offset + aimMag*BUILD_DIST_MAX, scaled so a full drag reaches wallMaxPx.
function wallReachFrac(dx, dy) { return clamp(buildPushFrac(dx, dy) * (wallMaxPx - BUILT_WALL.offset) / BUILD_DIST_MAX, 0, 1); }
// Shared cancel/haptic updater — call from BOTH pointermove handlers after updating drag.dx/dy,
// and once per frame (a finger held still inside the zone stops emitting pointermoves but the
// dwell still has to elapse). The machine is in shared/drag-cancel.js; this only fires the buzz.
function pumpDragCancel(drag) {
  const edge = updateDragCancel(drag, performance.now());
  if (edge) haptic(edge);
}

let specialAim = { x: 0, y: 0 };   // captured lob offset (0..1 of BOMB_LOB_RANGE, true-world dir) for the next special edge
let bombDrag = { active: false, id: null, cx: 0, cy: 0, dx: 0, dy: 0, ...newDragCancel() };

let buildHolding = false;  // build control currently HELD (windup ramps server-side)
let buildStart = null;     // timestamp the build hold began — LOCAL windup estimate for the HUD
const BUILD_MS = BUILD_WINDUP * 1000;
function beginBuild() { if (holdingBall) return; if (!buildHolding) { buildHolding = true; buildStart = performance.now(); } } // no building while carrying the ball
// How full the wall wind-up ring is (0..1). The local clock drives it for smoothness, but the
// SERVER owns whether a wind-up is happening at all: sim.js refuses to accumulate `buildWindup`
// while the placement cooldown (BUILD_COOLDOWN, 0.4s after each wall) is running or the mag is
// empty. Trusting the local clock alone is what produced the "ring fills, release, no wall"
// window right after building — the ring promised something the server would reject.
// So: run locally for one round-trip's grace, then follow the snapshot. If the server is not
// winding by then we are blocked → report 0, which keeps the ring empty AND makes release
// cancel (endBuildDrag commits only at >= 1) instead of silently eating the input.
const BUILD_SYNC_GRACE_MS = 150;
function currentWindup() {
  if (buildStart === null) return 0;
  const held = performance.now() - buildStart;
  const local = Math.min(1, held / BUILD_MS);
  if (held < BUILD_SYNC_GRACE_MS) return local;
  const meP = latest && latest.players && latest.players.find((pp) => pp.id === me.playerId);
  if (!meP) return local;                       // no snapshot yet — nothing better to go on
  return meP.winding ? local : 0;               // server isn't winding => cooldown or no charges
}
function cancelBuild() { buildHolding = false; buildStart = null; buildHold = null; }

// Build a wall — like a shot, you can drag to aim (pull-to-build) then release.
function releaseBuild(aim) { buildQueued = true; if (aim) { buildHold = aim; buildHold.frac = wallReachFrac(aim.x, aim.y); } playSound('ui', 0.5, 0.86); flushInput(); }

const CHARGE_MS = SHOOT_CHARGE_TIME * 1000;
function beginCharge() { if (!me.playerId) return; if (!holding) { holding = true; chargeStart = performance.now(); } } // no firing/charge (or shot sound) outside a live match — tapping the menu is silent
function currentCharge() { return chargeStart === null ? 0 : Math.min(1, (performance.now() - chargeStart) / CHARGE_MS * (mySuper ? SUPER_CHARGE_RATE : 1)); } // SUPER fills 2× faster (mirrors sim)
// Commit a shot: fire in the pulled-out direction. The SERVER owns the actual
// charge (accumulated from the held trigger); we just flag the release.
function releaseShot(aim) {
  if (!holding) return; // charge already consumed — a second trigger source must not re-fire
  if (aim) aimHold = aim;
  // AIMED = the touch aim-stick was pulled (aim arg present), or on desktop the mouse aim is
  // pulled out of the deadzone. A bare tap with no pull = a QUICK shot (no push, slow only).
  aimedShot = aim ? true : (!usingTouch && aimPulled());
  fireQueued = true;
  // Instant local shot feedback: a muzzle flash at the barrel + a short shake + a 1-frame
  // recoil, so the release READS immediately (the authoritative bullet/ball follows a tick
  // later). Purely cosmetic — predVel is re-eased to the stick every step, so it can't desync.
  if (rendered) {
    let ax, ay;
    if (aim) { const l = Math.hypot(aim.x, aim.y) || 1; ax = (flipView() ? -aim.x : aim.x) / l; ay = aim.y / l; }
    else { const mv = latest && latest.players && latest.players.find((p) => p.id === me.playerId); ax = mv ? mv.aimX : 1; ay = mv ? mv.aimY : 0; }
    const off = ownRadius() + BALL_RADIUS;
    spawnFlash(rendered.x + ax * off, rendered.y + ay * off, ownRadius() * 0.9);
    shake(holdingBall ? 5 : 3.5, 90);
    if (predVel) { predVel.x -= ax * 60; predVel.y -= ay * 60; }
  }
  const c = currentCharge();
  // TUTORIAL: everything the coach can know about a shot from the RELEASE alone is decided here,
  // where the client knows its own charge exactly. Two of the three facts are only halves, though,
  // because the tutorial's two shooting steps ask about the LANDING as well:
  //   * chargedShot — released at full power. Kept because it is true and cheap, but no step
  //     completes on it any more: the full-shot step now insists on a hit (`chargedHit`), since a
  //     full release that sailed into the touchline was still congratulated by the old predicate.
  //   * tuFullShotAt — the stamp that turns it into `chargedHit` when an enemy impact follows.
  //   * tuQuickShotAt — the same stamp for a tap, which the impact handler upgrades to `quickHit`.
  // Both stamps are CLEARED by a release of the other kind rather than left to rot, so a kid who
  // taps, misses, then holds and hits can never be credited with the tap they didn't land (or the
  // other way round). Counts a kick as well as a bullet — holding longer makes both stronger.
  if (tutorial && c >= FULL_CHARGE) tuEv.chargedShot = true;
  if (tutorial) {
    tuQuickShotAt = c < QUICK_CHARGE ? performance.now() : 0;
    tuFullShotAt = c >= FULL_CHARGE ? performance.now() : 0;
    // The TAP step's completion is a COUNT of quick releases and nothing else — no hit, by design
    // (see shared/tutorial.js). A tally, so it survives the kid tapping faster than a frame.
    if (c < QUICK_CHARGE) tuEv.quickShots = (tuEv.quickShots || 0) + 1;
    // The under-hold CORRECTION, mirror of the over-hold one sampled in tuTick. It belongs at the
    // release: an over-hold is a thumb still down and has to be answered mid-charge, but letting go
    // early is only knowable once you have let go. Only a step that ASKS for it watches (fixWhen),
    // so the tap step — where a short release is the whole lesson — can never trip it.
    const stNow = stepAt(tuLvl, tuStage);
    if (stNow && stNow.fixWhen === 'underHeld' && c < FULL_CHARGE) tuEv.underHeld = true;
  }
  if (holdingBall) playSound('kick', 0.85, 0.92 + c * 0.16);        // kicking the held ball
  else if (c >= FULL_CHARGE) playSound('powerShot', 0.7);           // fully-charged bullet — the "power shoot" cue
  else playSound('shot', 0.38, 0.92 + c * 0.16);                    // a normal bullet (gun blop / shoot)
  holding = false; chargeStart = null;
  flushInput(); // send the shot edge (with its aim) immediately — don't wait for the send tick
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
  if (e.key.toLowerCase() === 'e' && !holdingBall && !bombCooling()) { specialQueued = true; flashSpecialCooldown(); } // bomb locked while carrying OR reloading
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
  if (e.button === 2) { if (!holdingBall && !bombCooling()) { specialQueued = true; specialAim = { x: 0, y: 0 }; flashSpecialCooldown(); } }   // right-click = special (locked while carrying/reloading)
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
    if (holdingBall || bombCooling()) return; // LOCKED while carrying OR reloading — no drag, no feedback, no restart
    try { specialBtn.setPointerCapture(e.pointerId); } catch { /* older webview */ }
    bombDrag = { active: true, id: e.pointerId, cx: e.clientX, cy: e.clientY, dx: 0, dy: 0, ...newDragCancel() };
  });
  specialBtn.addEventListener('pointermove', (e) => {
    if (!bombDrag.active || e.pointerId !== bombDrag.id) return;
    bombDrag.dx = e.clientX - bombDrag.cx; bombDrag.dy = e.clientY - bombDrag.cy;
    pumpDragCancel(bombDrag); // latch aim + arm/disarm cancel + edge-haptic
  });
  const endBombDrag = (e) => {
    if (!bombDrag.active || e.pointerId !== bombDrag.id) return;
    const len = Math.hypot(bombDrag.dx, bombDrag.dy);
    if (releaseCancels(bombDrag)) {
      // Lifted INSIDE the cancel zone after a real aim = CANCEL. No bomb, no cooldown.
      // Position decides, not the armed flag — see shared/drag-cancel.js.
      if (!bombDrag.wasCancel) haptic('cancel'); // aborted before the ✕ had time to show
      shake(3, 110);
    } else if (len > AIM_DEADZONE_PX) {
      // A real drag = aimed lob. Sensitivity maps drag → fraction; reach caps the world distance.
      const reach = aimFrac(len, 'bomb') * bombMaxPx;  // world px (≤ bombMaxPx ≤ BOMB_LOB_RANGE)
      let dx = bombDrag.dx / len, dy = bombDrag.dy / len;
      if (flipView()) dx = -dx; // screen -> true-world for team B's mirrored view
      const f = reach / BOMB_LOB_RANGE;               // 0..1 fraction the sim consumes (server re-clamps ≤1)
      specialAim = { x: dx * f, y: dy * f };
      specialQueued = true; playSound('hit', 0.5, 0.82); flashSpecialCooldown();
    } else {
      // No meaningful drag at all = a tap = feet plant (rocket-jump). Snappy, like before.
      specialAim = { x: 0, y: 0 };
      specialQueued = true; playSound('hit', 0.5, 0.82); flashSpecialCooldown();
    }
    bombDrag.active = false; bombDrag.id = null; bombDrag.dx = 0; bombDrag.dy = 0;
    Object.assign(bombDrag, newDragCancel());
    flushInput(); // send the special edge (with its lob aim) immediately
  };
  specialBtn.addEventListener('pointerup', endBombDrag);
  specialBtn.addEventListener('pointercancel', endBombDrag);
}

// Build button — press and DRAG to aim the wall (pull-to-build), release to place.
// A plain tap builds in the direction you're facing. Pointer events cover mouse+touch.
const buildBtn = document.getElementById('build');
let buildDrag = { active: false, id: null, cx: 0, cy: 0, dx: 0, dy: 0, ...newDragCancel() };
if (buildBtn) {
  buildBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (holdingBall) return; // fence is LOCKED while carrying — no drag, no windup, no exhaust
    try { buildBtn.setPointerCapture(e.pointerId); } catch { /* older webview */ }
    buildDrag = { active: true, id: e.pointerId, cx: e.clientX, cy: e.clientY, dx: 0, dy: 0, ...newDragCancel() };
    beginBuild();
  });
  buildBtn.addEventListener('pointermove', (e) => {
    if (!buildDrag.active || e.pointerId !== buildDrag.id) return;
    buildDrag.dx = e.clientX - buildDrag.cx; buildDrag.dy = e.clientY - buildDrag.cy;
    pumpDragCancel(buildDrag); // latch aim + arm/disarm cancel + edge-haptic (shared with the bomb)
  });
  const endBuildDrag = (e) => {
    if (!buildDrag.active || e.pointerId !== buildDrag.id) return;
    if (releaseCancels(buildDrag)) {
      // Lifted INSIDE the cancel zone after a real aim = CANCEL. Position decides, not the armed
      // flag: releasing anywhere OUTSIDE that zone is a valid aim and must build (see
      // shared/drag-cancel.js — the latched band is what used to eat walls silently).
      if (!buildDrag.wasCancel) haptic('cancel'); // aborted before the ✕ had time to show
      cancelBuild(); shake(3, 110);
    } else {
      // Release only COMMITS if the windup is full AND the aim is pulled out of the deadzone;
      // otherwise it cancels (no wall, no charge). The server also gates on windup.
      const pulled = Math.hypot(buildDrag.dx, buildDrag.dy) > AIM_DEADZONE_PX;
      if (pulled && currentWindup() >= 1) releaseBuild({ x: buildDrag.dx, y: buildDrag.dy });
      else cancelBuild();
    }
    buildDrag.active = false; buildDrag.id = null; buildDrag.dx = 0; buildDrag.dy = 0;
    Object.assign(buildDrag, newDragCancel());
    buildHolding = false; buildStart = null;
  };
  buildBtn.addEventListener('pointerup', endBuildDrag);
  buildBtn.addEventListener('pointercancel', endBuildDrag);
}
updateSoundButton();
soundBtn?.addEventListener('click', () => {
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
const soundVolSlider = document.getElementById('s-soundvol');
if (soundVolSlider) {
  soundVolSlider.value = String(soundVol);
  soundVolSlider.addEventListener('input', () => {
    soundVol = Math.min(1, Math.max(0, parseFloat(soundVolSlider.value) || 0));
    try { localStorage.setItem('pikme-soundvol', String(soundVol)); } catch { /* private mode */ }
    if (masterGain) masterGain.gain.value = soundEnabled ? soundVol : 0;
  });
}
document.getElementById('open-controls-btn')?.addEventListener('click', () => { if (typeof openControlsEditor === 'function') openControlsEditor(); });
// FROM THE LOBBY: 🎛️ in the settings card. The editor needs live sticks to drag, so this takes the
// player to the training ground and opens it there — the same room «אימון» → «מגרש אימונים» opens, and
// the same editor #edit-controls-btn opens once inside. Not a synthetic click chain: the room is
// requested directly and the editor is opened by enterMatch when the room actually arrives.
document.getElementById('hub-controls')?.addEventListener('click', () => {
  // Hidden off the hub (see openSettings), and refused as well as hidden: a shortcut that requests a
  // new room is not something to leave one stray class away from firing mid-match.
  if (!homeEl || homeEl.classList.contains('hidden')) return;
  unlockAudio();
  closeSettings();
  pendingControlsEditor = true;
  sendMsg({ type: 'training', diffLevel });
});
updateMusicButton();

// Local cooldown shading for the button (approximate; server is authoritative).
let specialCdUntil = 0;
const bombCooling = () => performance.now() < specialCdUntil; // true while the bomb is reloading → button LOCKED
const bombCdMs = () => (CHARACTERS.player.specialCooldown * 1000) / (settings.bombReloadSpeed || 1); // live: training reload-speed scales it
function flashSpecialCooldown() {
  if (bombCooling()) return;                 // already reloading — never restart (that's the "never reloads" bug)
  specialCdUntil = performance.now() + bombCdMs();
}

// --- Pause + settings panel ---
const SETTING_KEYS = ['speedMul', 'sizeMul', 'carrySpeedMul', 'ballSizeMul', 'shotPower', 'bulletSpeed', 'bulletKnockback', 'bombPower', 'bombReloadSpeed', 'wallReloadSpeed'];
const SETTING_FMT = {
  speedMul: (v) => v.toFixed(2) + '×',
  sizeMul: (v) => v.toFixed(2) + '×',
  carrySpeedMul: (v) => v.toFixed(2) + '×',
  ballSizeMul: (v) => v.toFixed(2) + '×',
  shotPower: (v) => String(Math.round(v)),
  bulletSpeed: (v) => String(Math.round(v)),
  bulletKnockback: (v) => String(Math.round(v)),
  bombPower: (v) => String(Math.round(v)),
  bombReloadSpeed: (v) => v.toFixed(2) + '×',
  wallReloadSpeed: (v) => v.toFixed(2) + '×',
};

function syncSliderUI() {
  for (const k of SETTING_KEYS) {
    const slider = document.getElementById('s-' + k);
    const label = document.getElementById('v-' + k);
    // Guard, not a fix: `settings` now comes from defaultSettings() so every SETTING_KEY is present.
    // This is here because the failure mode was so bad — a formatter calling .toFixed on a missing
    // value threw inside the settings panel and painted an error banner across a LIVE match. A key
    // that somehow has no value should render as blank, never take the game down with it.
    const v = settings[k];
    if (!Number.isFinite(v)) continue;
    if (slider) slider.value = v;
    if (label) label.textContent = SETTING_FMT[k](v);
  }
}
function sendSettings() {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'settings', settings }));
}
// Bot level from the player's XP — vs-bots + quick-match derive the bot difficulty from XP
// instead of a manual picker (bots reflect the player; start at level 0, cap at 11). Same
// window.SALTIZ_XP source of truth as the hub XP bar; DEV_LOCAL falls back to the hub's 1240.
function xpDiffLevel() {
  if (DIFF_PIN != null) return DIFF_PIN; // ?diff=N on a private host — see DEV_HOST above
  const src = window.SALTIZ_XP;
  const xp = src && Number.isFinite(+src.xp) ? +src.xp : (DEV_LOCAL ? 1240 : 0);
  return botLevelFromXp(xp);
}
// The number the hub bar prints as גביעים IS the XP number, so matchmaking needs no new metric.
// Sent with every queue request; the server bands on it.
// NOTE: window.SALTIZ_XP is an OBJECT ({xp, level?}) — same shape xpDiffLevel() reads above via
// `src.xp` — not a bare number. `+(window.SALTIZ_XP || 0)` would coerce that object to NaN and this
// would always send 0, silently pinning every player to the bottom band, so this unwraps `.xp`.
const myTrophies = () => { const x = window.SALTIZ_XP; return Math.max(0, (x && Number.isFinite(+x.xp)) ? +x.xp : 0); };
// Difficulty LADDER selector — a level index (enemy + partner skill live in shared/difficulty.js).
// Manual slider now only drives training / private / builder; persists locally, pushed live.
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
// The picked level is shown in TWO more places than the settings grid, because that grid is behind ⚙:
//   · the builder's 🤖 button (cycles the level before ▶ שחק — the same one-tap pattern as 📐 גודל)
//   · the training ground's 🤖 chip beside 🎯 אימון (tap → the settings grid, changeable mid-game)
// One function updates both, so a level change anywhere can't leave a stale label somewhere else.
function syncDiffChips() {
  const lvl = levelAt(diffLevel);
  const b = document.getElementById('b-diff');
  if (b) { b.textContent = `🤖 ${lvl.name}`; b.title = `רמת בוטים למשחק מהבונה: ${lvl.name} · ${lvl.hint}`; }
  const t = document.getElementById('train-diff');
  if (t) { t.textContent = `🤖 ${lvl.name}`; t.title = `רמת בוטים: ${lvl.name} · ${lvl.hint} — הקש לשינוי`; }
}
function setDifficulty(i) {
  diffLevel = clampLevel(i);
  try { localStorage.setItem('pikme-diff-level', String(diffLevel)); } catch { /* private mode */ }
  syncDifficultyUI();
  syncDiffChips();
  playSound('ui', 0.5, 1.05);
  // Live push. The server accepts it only where a mid-match change is legitimate (training / vs-bots /
  // builder / private) and echoes the applied level back on the `bots` frame, which is what keeps
  // matchDiffLevel — and therefore the dossier readout — honest after a mid-game change.
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'settings', diffLevel }));
}
syncDifficultyUI();
syncDiffChips();

function openSettings() {
  playSound('ui', 0.45);
  holding = false; chargeStart = null; fireQueued = false; specialQueued = false; aimHold = null;
  settingsPanel.classList.remove('hidden');
  // Context-tiered settings. Audio (sound+music) is ALWAYS shown.
  //  - training ground (mode 'training'): + controls + difficulty + game mechanics
  //  - friends (private) / vs-bots (botgame) / builder: + difficulty
  //  - main lobby / quick match: audio only
  const inGame = !gameEl.classList.contains('hidden');
  const trainingGround = inGame && training;
  // vs-bots + quick-match derive difficulty from XP (no manual picker); training/private/builder keep it.
  const diffAllowed = inGame && (training || roomMode === 'botgame' || roomMode === 'private' || roomMode === 'builder');
  // THE LOBBY-ONLY SHORTCUTS, hidden everywhere else. ⚙ is reachable mid-match, and neither of these
  // means anything there: the ? would run a lesson ABOUT THE HUB on top of a live match, and the 🎛️
  // would ask for a brand-new training room while the player is already in one. In a match the editor
  // is reachable properly anyway — that is what #setting-controls below is for.
  const onHub = !inGame && !!homeEl && !homeEl.classList.contains('hidden');
  document.getElementById('hub-howto')?.classList.toggle('hidden', !onHub);
  document.getElementById('hub-controls')?.classList.toggle('hidden', !onHub);
  document.getElementById('setting-controls')?.classList.toggle('hidden', !trainingGround);
  document.getElementById('setting-mechanics')?.classList.toggle('hidden', !trainingGround);
  document.getElementById('setting-difficulty')?.classList.toggle('hidden', !diffAllowed);
  // INFO sections (bots + connection) — shown in EVERY game, not tiered like the sliders above:
  // knowing who you're playing and why it feels laggy is never a training-only concern. Reads
  // fresh state on each repaint, so the ping ticks and a mid-match bot backfill shows up live.
  openMatchInfo(() => ({
    bots: matchBots,
    diffLevel: matchDiffLevel,
    myTeam: me && me.team,
    inMatch: !gameEl.classList.contains('hidden'),
  }));
  syncSliderUI();
  syncDifficultyUI();
}
function closeSettings() {
  playSound('ui', 0.45, 1.06);
  settingsPanel.classList.add('hidden');
  closeMatchInfo();   // stop the 2Hz repaint while the panel is closed
}
pauseBtn.addEventListener('click', openSettings);
// The training chip is a shortcut INTO the difficulty grid — no second picker to keep in sync.
document.getElementById('train-diff')?.addEventListener('click', () => {
  openSettings();
  document.getElementById('setting-difficulty')?.scrollIntoView({ block: 'nearest' });
});
document.getElementById('resume').addEventListener('click', closeSettings);
// #15: click the dark backdrop (outside the settings card) to close — no ✕ button.
settingsPanel.addEventListener('click', (e) => { if (e.target === settingsPanel) closeSettings(); });
document.getElementById('reset-settings').addEventListener('click', () => {
  settings.speedMul = 0.8; settings.sizeMul = 1.25;
  settings.carrySpeedMul = 0.9; settings.ballSizeMul = 2; settings.shotPower = 1850;
  settings.bulletSpeed = 720;
  settings.bulletKnockback = 1500;
  settings.bombPower = 1500;
  settings.bombReloadSpeed = 1; settings.wallReloadSpeed = 1;
  // Bomb/wall REACH are client-only mechanics sliders that now live in this panel — reset them here
  // (the controls editor's איפוס only owns the input-feel ones).
  for (const s of _aimSliders) {
    if (s.id !== 's-bombMax' && s.id !== 's-wallMax') continue;
    s.set(s.def); try { localStorage.removeItem(s.key); } catch { /* private mode */ } seedAimSlider(s);
  }
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
// Touch-capable device? The always-on joysticks show only here (desktop keeps mouse/keyboard).
// On localhost we also show them so the layout is previewable in a desktop browser.
const IS_TOUCH = DEV_LOCAL || ('ontouchstart' in window) || navigator.maxTouchPoints > 0 || matchMedia('(pointer: coarse)').matches;

// ---- Customisable control layout (Brawl-Stars-style "edit controls") --------
// Persisted per control: {cx,cy = CENTER as fraction of viewport, size = px, locked}.
// A `locked` control renders at a FIXED anchor and no longer floats to the touch.
const CTL_DEFAULTS = { move: { size: 120 }, aim: { size: 120 }, bomb: { size: 82 }, wall: { size: 58 } };
// THE SHIPPED LAYOUT — the user's own, exported from his dev instance (2026-07-28) and adopted as the
// default so a new player starts on a tuned pad instead of the computed fallback.
//
// `cx`/`cy` are FRACTIONS of the viewport, which is what makes this safe to ship: the pad lands in the
// same relative place on any screen. `size` and `sens` are px and are NOT scaled — they are thumb-sized
// quantities, and a thumb is the same size on every phone.
//
// `locked: true` on all four is part of the setting, not an accident: a locked control sits at its
// anchor instead of floating to wherever the touch landed. That is how he plays.
//
// It applies ONLY to a player with nothing saved (see loadCtlLayout). Anyone who has been in the
// controls editor keeps their own layout — a default is not a migration.
const CTL_SHIPPED_LAYOUT = {
  move: { cx: 0.12585812356979406, cy: 0.72636815920398,   size: 120,                locked: true },
  aim:  { cx: 0.8730726309151596,  cy: 0.7168876775903686, size: 120,                locked: true },
  bomb: { cx: 0.76893819405958,    cy: 0.7204075880942454, size: 74.5455322265625,  sens: 71.5625,          locked: true },
  wall: { cx: 0.827914214293849,   cy: 0.5100672741377829, size: 54.89776611328125, sens: 57.01173400878906, locked: true },
};
let ctlLayout = loadCtlLayout();
// A FRESH COPY every time, never the constant itself: the controls editor mutates ctlLayout in place
// (ce-save writes `ctlLayout[c] = {...}`), so handing out the shared object would let one player's drag
// edit the shipped default for the rest of the session.
function loadCtlLayout() {
  try {
    const raw = localStorage.getItem('fbControls');
    if (raw) return JSON.parse(raw) || {};
  } catch { /* private mode, or corrupt JSON — fall through to the shipped layout */ }
  return JSON.parse(JSON.stringify(CTL_SHIPPED_LAYOUT));
}
function saveCtlLayout() { try { localStorage.setItem('fbControls', JSON.stringify(ctlLayout)); } catch { /* private mode */ } }
// Resolve a locked control to live screen px, or null if it's still floating/default.
function ctlPx(c) {
  const L = ctlLayout[c]; if (!L || !L.locked) return null;
  return { x: L.cx * innerWidth, y: L.cy * innerHeight, size: L.size || CTL_DEFAULTS[c].size };
}
function stickSize(c) { const p = ctlPx(c); return p ? p.size : CTL_DEFAULTS[c].size; }
function stickMax(c) { return stickSize(c) * STICK_RATIO; }
function stickLocked(c) { const L = ctlLayout[c]; return !!(L && L.locked); }

// ---- Always-on joysticks (Brawl-Stars fixed sticks) -------------------------
// The move/aim sticks are ALWAYS visible on the pitch at a fixed anchor (not floating
// to the touch): move bottom-left, aim bottom-right but LEFT of the right-edge bomb/wall
// column so nothing overlaps. Touch anywhere in that half drives the knob from the anchor.
const STICK_MARGIN = 26;
function defaultAnchor(c) {
  const s = stickSize(c);
  if (c === 'move') return { x: STICK_MARGIN + s / 2, y: innerHeight - STICK_MARGIN - s / 2, size: s };
  // aim: keep its right edge clear of the bomb button (which hugs the right edge ~112px in, 82px wide)
  const x = Math.max(innerWidth * 0.5 + s / 2 + 8, innerWidth - 208 - s / 2);
  return { x, y: innerHeight - STICK_MARGIN - s / 2, size: s };
}
// The live anchor for a stick: a saved LOCKED custom position wins, else the default anchor.
function stickAnchor(c) {
  const L = ctlLayout[c];
  if (L && L.locked) return { x: L.cx * innerWidth, y: L.cy * innerHeight, size: L.size || CTL_DEFAULTS[c].size };
  return defaultAnchor(c);
}
// Park each stick at its anchor with a centred knob while idle; hide off the pitch / on desktop.
function refreshSticks() {
  const show = IS_TOUCH && !gameEl.classList.contains('hidden')
    && (typeof settingsPanel === 'undefined' || settingsPanel.classList.contains('hidden'))
    && !editingControls;
  for (const [c, el, touch] of [['move', stickL, touchL], ['aim', stickR, touchR]]) {
    if (!el) continue;
    if (!show) { el.classList.add('hidden'); el.classList.remove('active'); continue; }
    el.classList.remove('hidden');
    if (touch.id === null) {           // idle -> sit at anchor, knob centred (an active stick is placed by the touch handler)
      const a = stickAnchor(c), half = a.size / 2;
      el.style.left = `${Math.round(a.x - half)}px`;
      el.style.top = `${Math.round(a.y - half)}px`;
      const k = el.querySelector('.knob'); if (k) k.style.transform = 'translate(0px, 0px)';
    }
  }
}

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
    // HUD CHROME IS NOT THE PITCH. This used to be a hand-listed set of five elements, so every new
    // HUD control had to remember to add itself — and the quick-chat button did not, which is why
    // tapping it also grabbed a stick and started aiming a shot (user, 2026-07-26: "when a user
    // presses the chat, or settings it should not try to focus the shoot").
    // Now it is a RULE: anything that is a real control, or lives inside a HUD panel, is never a
    // stick. `closest` walks up from the touch target, so a tap on an icon INSIDE a button counts too.
    if (t.target instanceof Element && t.target.closest(
      'button, a, input, select, textarea, label, [role="button"], [role="dialog"],'
      + '#hud, #chat-sheet, #settings, #controls-editor, .chat-sheet, .settings,'
      + '.controls-editor, .match-powers, .train-diff'
    )) continue;
    const ad = adBoardAt(t.clientX, t.clientY); if (ad) { openAd(ad); continue; } // board tap, not a stick
    const which = claimStick(t);
    if (which === 'L' && touchL.id === null) {
      // Fixed stick: the base stays at its anchor; touching anywhere in the zone drives the
      // knob, delta measured from the anchor (Brawl-Stars always-on joystick).
      const a = stickAnchor('move');
      touchL.id = t.identifier; touchL.cx = a.x; touchL.cy = a.y;
      touchL.dx = 0; touchL.dy = 0; touchL.max = a.size * STICK_RATIO;
      placeStick(stickL, a.x, a.y, 0, 0); stickL.classList.add('active');
    } else if (which === 'R' && touchR.id === null) {
      const a = stickAnchor('aim');
      touchR.id = t.identifier; touchR.cx = a.x; touchR.cy = a.y;
      touchR.dx = 0; touchR.dy = 0; touchR.active = true; touchR.aimedOut = false; touchR.max = a.size * STICK_RATIO;
      placeStick(stickR, a.x, a.y, 0, 0); stickR.classList.add('active');
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
      // Left stick is MOVE: just stop. Base stays visible at its anchor (knob recenters).
      touchL.id = null; touchL.dx = 0; touchL.dy = 0; stickL.classList.remove('active'); refreshSticks();
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
      touchR.id = null; touchR.dx = 0; touchR.dy = 0; touchR.active = false; touchR.aimedOut = false; stickR.classList.remove('active'); refreshSticks();
    }
  }
}, { passive: false });

// iOS can fire touchcancel instead of touchend (system gesture / notification).
// Reset the sticks so a controller can never get stuck.
addEventListener('touchcancel', (e) => {
  for (const t of e.changedTouches) {
    if (t.identifier === touchL.id) { touchL.id = null; touchL.dx = 0; touchL.dy = 0; stickL.classList.remove('active'); refreshSticks(); }
    else if (t.identifier === touchR.id) { cancelCharge(); touchR.id = null; touchR.dx = 0; touchR.dy = 0; touchR.active = false; stickR.classList.remove('active'); refreshSticks(); }
  }
}, { passive: false });

// The stick system is now initialised: allow showScreen() to drive the always-on sticks,
// park them at their anchors now, and re-anchor them on viewport resize/rotate.
sticksReady = true;
refreshSticks();
addEventListener('resize', refreshSticks);

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
    // Live size readout — every shipped editor (CoD Mobile, Free Fire) shows the number you're
    // dragging to, so a size can be reproduced instead of eyeballed.
    puck.dataset.size = `${Math.round(d.size)}px`;
    // PULL SQUARE (bomb/wall only): the outer box is the thumb travel that reaches max reach. It's
    // drawn centred on the button, so its half-extent past the button edge IS the pull distance.
    const sens = puck.querySelector('.ce-sens');
    if (sens && d.sens != null) {
      const box = d.sens * 2;                      // full width of the pull square (radius → diameter)
      sens.style.width = sens.style.height = `${box}px`;
      sens.style.left = `${d.size / 2 - box / 2}px`;
      sens.style.top = `${d.size / 2 - box / 2}px`;
      sens.dataset.sens = `משיכה ${Math.round(d.sens)}px`;
    }
  }
}
// Corner-handle drag → one signed delta. Takes the DOMINANT axis rather than Math.max of the two:
// with max(), a purely horizontal shrink reads max(-40, 0) = 0 and the handle simply refuses to move
// inward. Callers pass the deltas already oriented so that positive = grow for their corner.
function cornerDelta(dx, dy) { return Math.abs(dx) >= Math.abs(dy) ? dx : dy; }
// Real safe-area insets in px. env() can't be read from JS, so a probe element carries them as
// padding and we read the computed value back. Cached per layout pass; re-measured on resize.
let _saProbe = null;
function safeInsets() {
  if (!_saProbe) {
    _saProbe = document.createElement('div');
    _saProbe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;visibility:hidden;'
      + 'padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);';
    document.body.appendChild(_saProbe);
  }
  const s = getComputedStyle(_saProbe);
  return { t: parseFloat(s.paddingTop) || 0, r: parseFloat(s.paddingRight) || 0,
           b: parseFloat(s.paddingBottom) || 0, l: parseFloat(s.paddingLeft) || 0 };
}
function openControlsEditor() {
  if (!ceOverlay) return;
  editingControls = true;
  ceDraft = {};
  for (const c of ['move', 'aim', 'bomb', 'wall']) {
    const p = ctlPx(c);
    ceDraft[c] = p ? { cx: p.x / innerWidth, cy: p.y / innerHeight, size: p.size } : defaultCtlDraft(c);
    // Pull controls carry their thumb-travel radius into the draft so the outer square can be sized
    // and dragged like any other dimension (committed on save, discarded on cancel).
    if (c === 'bomb' || c === 'wall') ceDraft[c].sens = aimSens[c];
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
  const sensGrip = puck.querySelector('.ce-sens-grip');
  let mode = null, sx = 0, sy = 0, sSize = 0, sCx = 0, sCy = 0, sSens = 0;
  puck.addEventListener('pointerdown', (e) => {
    e.preventDefault(); e.stopPropagation();
    try { puck.setPointerCapture(e.pointerId); } catch { /* older webview */ }
    // Three grabbable things: the outer pull square's grip (sensitivity), the corner handle
    // (button size), and the body (position). Check the pull grip FIRST — it sits outside the
    // button, so it can't be reached once the body claims the gesture.
    mode = (sensGrip && e.target === sensGrip) ? 'sens' : (e.target === handle) ? 'resize' : 'move';
    sx = e.clientX; sy = e.clientY; sSize = ceDraft[c].size; sCx = ceDraft[c].cx; sCy = ceDraft[c].cy;
    sSens = ceDraft[c].sens || 0;
    puck.classList.add('dragging');
  });
  puck.addEventListener('pointermove', (e) => {
    if (!mode) return;
    if (mode === 'move') {
      // Clamp inside the SAFE AREA, not just the viewport. Apple HIG: keep controls clear of the
      // notch / Dynamic Island / home indicator. viewport-fit=cover means innerWidth/Height paint
      // UNDER them, so a bare 0..innerWidth clamp happily parks a control beneath the notch.
      const half = ceDraft[c].size / 2, sa = safeInsets();
      const nx = sCx * innerWidth + (e.clientX - sx), ny = sCy * innerHeight + (e.clientY - sy);
      ceDraft[c].cx = clamp(nx, sa.l + half, innerWidth - sa.r - half) / innerWidth;
      ceDraft[c].cy = clamp(ny, sa.t + half, innerHeight - sa.b - half) / innerHeight;
    } else if (mode === 'sens') {
      // Drag the outer square out/in to set how far the thumb travels for MAX reach. Floor is the
      // dead-zone + a little, so the pull can never collapse to "any touch = max".
      // NOTE the sign: this grip is on the TOP-LEFT corner, so dragging LEFT/UP grows the box
      // (away from centre) and right/down shrinks it. Using the bottom-right form (clientX - sx)
      // here inverts the whole control — that was the "size inverted" bug.
      ceDraft[c].sens = clamp(sSens + cornerDelta(sx - e.clientX, sy - e.clientY), AIM_DEADZONE_PX + 18, 220);
    } else {
      // Min sizes follow Apple HIG touch targets (44pt primary); sticks want more to be usable.
      const isBtn = (c === 'bomb' || c === 'wall');
      const d = cornerDelta(e.clientX - sx, e.clientY - sy); // bottom-right grip: right/down grows
      ceDraft[c].size = clamp(sSize + d, isBtn ? 44 : 80, isBtn ? 130 : 190);
    }
    layoutPucks();
  });
  const end = () => { mode = null; puck.classList.remove('dragging'); };
  puck.addEventListener('pointerup', end);
  puck.addEventListener('pointercancel', end);
}

// Client-only tunables (persist to localStorage, apply in real matches too). NOT in SETTING_KEYS —
// the server never reads them. They are split across TWO panels on purpose:
//   • controls editor  → INPUT FEEL: idle opacity (the pull CURVE is pinned, see AIM_CURVE)
//   • settings→mechanics (training) → GAME REACH: how far a bomb lands / a wall builds
// The `fmt` gives each its own unit so an opacity doesn't render as "1px".
const _aimSliders = [
  { id: 's-ctlOpacity', vid: 'v-ctlOpacity', key: 'fbCtlOpacity', def: 0.5,                  get: () => ctlIdleOp, set: (v) => { ctlIdleOp = v; applyCtlOpacity(); },
    fmt: (v) => Math.round(v * 100) + '%' },
  { id: 's-bombMax',  vid: 'v-bombMax',  key: 'fbBombMax',  def: BOMB_LOB_RANGE,            get: () => bombMaxPx, set: (v) => { bombMaxPx = v; } },
  { id: 's-wallMax',  vid: 'v-wallMax',  key: 'fbWallMax',  def: BUILT_WALL.offset + 32,    get: () => wallMaxPx, set: (v) => { wallMaxPx = v; } },
];
const _aimFmt = (s, v) => (s.fmt ? s.fmt(v) : Math.round(v) + 'px');
function seedAimSlider(s) { const el = document.getElementById(s.id), lab = document.getElementById(s.vid); if (el) el.value = String(s.get()); if (lab) lab.textContent = _aimFmt(s, s.get()); }
for (const s of _aimSliders) {
  const el = document.getElementById(s.id); if (!el) continue;
  seedAimSlider(s);
  el.addEventListener('input', () => {
    const v = parseFloat(el.value);
    if (!Number.isFinite(v)) return;
    s.set(v);
    try { localStorage.setItem(s.key, String(v)); } catch { /* private mode */ }
    const lab = document.getElementById(s.vid); if (lab) lab.textContent = _aimFmt(s, v);
  });
}
document.getElementById('ce-save')?.addEventListener('click', () => {
  for (const c of ['move', 'aim', 'bomb', 'wall']) ctlLayout[c] = { ...ceDraft[c], locked: true };
  // The pull square is a FEEL pref, not a layout box — commit it to its own key so it applies in
  // real matches too (ctlLayout only drives position/size).
  for (const c of ['bomb', 'wall']) {
    const v = ceDraft[c] && ceDraft[c].sens;
    if (!Number.isFinite(v)) continue;
    aimSens[c] = v;
    try { localStorage.setItem(AIM_SENS_KEY[c], String(v)); } catch { /* private mode */ }
  }
  saveCtlLayout(); applyCtlLayout(); closeControlsEditor(); if (sticksReady) refreshSticks();
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
  // Restore only the INPUT-FEEL defaults (idle opacity; the pull curve is pinned, not a setting).
  // The bomb/wall REACH sliders now live in Settings → mechanics, so they're reset by that panel's
  // איפוס, not by this one.
  for (const s of _aimSliders) {
    if (s.id !== 's-ctlOpacity') continue;
    s.set(s.def); try { localStorage.removeItem(s.key); } catch { /* private mode */ } seedAimSlider(s);
  }
  // ...and the per-control pull distances (the outer squares).
  for (const c of ['bomb', 'wall']) { aimSens[c] = 90; try { localStorage.removeItem(AIM_SENS_KEY[c]); } catch { /* private mode */ } }
  closeControlsEditor();
});
editBtn?.addEventListener('click', openControlsEditor);

// ── IN-MATCH QUICK CHAT ──────────────────────────────────────────────────────────────────────────
// A word/emote picker beside 🎛️. The wire carries an ID only; the server validates it against
// shared/quick-chat.js and relays { pid, id } to everyone in the room, so a bubble appears over the
// SENDER's hero for every player — which is what "the messages should appear from the player itself,
// visible for all" asks for.
//
// The sheet is RENDERED from the catalogue, never hand-written: same rule as the MODES table, which
// drifted across four hand-copied copies before it was centralised.
const chatBtn = document.getElementById('chat-btn');
const chatSheet = document.getElementById('chat-sheet');
// pid -> { id, until }. One bubble per player: a second message REPLACES the first rather than
// stacking, per COMMUNICATION_SET.md ("collapse duplicates instead of stacking").
const chatBubbles = new Map();
let _chatLastAt = 0, _chatBurst = [], _chatCoolUntil = 0;

// The emote sheet, drawn onto the canvas for bubbles. Same file the CSS uses for the picker, so the
// browser fetches it once.
const chatSheetImg = new Image();
chatSheetImg.src = CHAT_SHEET.url;

function chatSheetOpen() { return chatSheet && !chatSheet.classList.contains('hidden'); }
function closeChatSheet() { chatSheet?.classList.add('hidden'); }

function renderChatSheet() {
  if (!chatSheet || chatSheet.dataset.built) return;
  chatSheet.dataset.built = '1';
  const words = document.getElementById('chat-words');
  const emotes = document.getElementById('chat-emotes');
  for (const w of CHAT_WORDS) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = w.text; b.dataset.chatId = w.id;
    words.appendChild(b);
  }
  for (const e of CHAT_EMOTES) {
    const b = document.createElement('button');
    b.type = 'button'; b.dataset.chatId = e.id; b.setAttribute('aria-label', e.icon);
    const sp = document.createElement('span');
    sp.className = 'qc-emote';
    // Percentage sprite maths for a cols x rows grid: n / (n-1) * 100. Set from the catalogue so the
    // cell mapping is defined once.
    sp.style.backgroundPosition = `${(e.col / (CHAT_SHEET.cols - 1)) * 100}% ${(e.row / (CHAT_SHEET.rows - 1)) * 100}%`;
    b.appendChild(sp);
    emotes.appendChild(b);
  }
  chatSheet.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-chat-id]');
    if (b) sendChat(b.dataset.chatId);
  });
}

function sendChat(id) {
  if (!chatById(id)) return;
  const now = performance.now();
  // The client cooldown is a courtesy so the UI feels honest; the SERVER enforces the real rule.
  if (now < _chatCoolUntil || now - _chatLastAt < CHAT_SEND_GAP_MS) return;
  _chatBurst = _chatBurst.filter((t) => now - t < CHAT_BURST_MS);
  if (_chatBurst.length >= CHAT_BURST_N) { _chatCoolUntil = now + CHAT_COOLDOWN_MS; paintChatCooldown(); return; }
  _chatBurst.push(now); _chatLastAt = now;
  sendMsg({ type: 'chat', id });
  closeChatSheet();                       // one tap sends and gets out of the way
  paintChatCooldown();
}

function paintChatCooldown() {
  if (!chatBtn) return;
  const cool = () => {
    const now = performance.now();
    const busy = now < _chatCoolUntil || now - _chatLastAt < CHAT_SEND_GAP_MS;
    chatBtn.classList.toggle('chat-cool', busy);
    if (busy) setTimeout(cool, 120);
  };
  cool();
}

// Called from the message router when the server relays someone's message.
function onChatMessage(pid, id) {
  if (!chatById(id)) return;
  chatBubbles.set(pid, { id, until: performance.now() + CHAT_BUBBLE_MS });
}

// Draw every live bubble above its player, in FULL-RES screen space.
//
// Called after the world buffer has been blitted, so `ctx` is mainCtx and one art pixel is ART_PX
// device pixels. wx()/wy() return world-buffer coords, hence the x ART_PX. Words are ordinary
// anti-aliased text at a normal weight — deliberately NOT the chunky CELEB_FONT and not inside the
// pixelated buffer. Emotes keep nearest-neighbour sampling, because they ARE pixel art.
function drawChatBubbles(view) {
  const players = (view && view.players) || [];
  const now = performance.now();
  for (const p of players) {
    const e = chatBubbles.get(p.id);
    if (!e) continue;
    if (now > e.until) { chatBubbles.delete(p.id); continue; }
    const item = chatById(e.id);
    if (!item) continue;
    // Fade the last 300ms so a bubble leaves rather than blinks out.
    const left = e.until - now;
    const a = left < 300 ? Math.max(0, left / 300) : 1;
    const cx = wx(p.x) * ART_PX;
    const top = (wy(p.y) - ws_(52)) * ART_PX;
    ctx.save();
    ctx.globalAlpha = a;
    if (item.kind === 'emote') {
      const S = 30 * dpr, c = CHAT_SHEET.cell;
      ctx.imageSmoothingEnabled = false;           // pixel art: keep the blocks hard
      roundRectPath(cx - S * 0.62, top - S * 0.62, S * 1.24, S * 1.24, S * 0.26);
      ctx.fillStyle = 'rgba(10,16,11,.72)'; ctx.fill();
      if (chatSheetImg.complete && chatSheetImg.naturalWidth) {
        ctx.drawImage(chatSheetImg, item.col * c, item.row * c, c, c, cx - S / 2, top - S / 2, S, S);
      }
    } else {
      // Normal small UI text, smoothed.
      ctx.imageSmoothingEnabled = true;
      const fs = 13 * dpr;
      ctx.font = '600 ' + fs + 'px system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const padX = 9 * dpr, h = 22 * dpr;
      const w = ctx.measureText(item.text).width + padX * 2;
      roundRectPath(cx - w / 2, top - h / 2, w, h, 8 * dpr);
      ctx.fillStyle = 'rgba(10,16,11,.82)'; ctx.fill();
      ctx.lineWidth = Math.max(1, 1.5 * dpr);
      ctx.strokeStyle = 'rgba(240,228,185,.55)'; ctx.stroke();
      ctx.fillStyle = '#fff4ca';
      ctx.fillText(item.text, cx, top + 0.5 * dpr);
    }
    ctx.restore();
  }
}

// (roundRectPath already exists further down — reused, not redefined.)

chatBtn?.addEventListener('click', () => {
  renderChatSheet();
  chatSheet?.classList.toggle('hidden');
});
// Tapping the pitch dismisses the sheet, so it never sits between you and the ball.
addEventListener('pointerdown', (ev) => {
  if (!chatSheetOpen()) return;
  if (chatSheet.contains(ev.target) || chatBtn.contains(ev.target)) return;
  closeChatSheet();
}, true);

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
  // buildDist (0..1) = how far the button was dragged -> the sim builds the wall that much
  // further out (up to one wall thickness). Live during a drag, latched on release.
  let buildDist = buildHolding && buildDrag.active ? wallReachFrac(buildDrag.dx, buildDrag.dy) : 0;
  if (buildHold) { aimX = flip ? -buildHold.x : buildHold.x; aimY = buildHold.y; buildDist = buildHold.frac || 0; buildHold = null; }
  // #6/#11: the client sends its aim vector (needed for CHARGED shots + the aim line + wall
  // build). For a QUICK shot the SIM decides the aim server-side (goal if carrying, else the
  // nearest enemy, with the snooker-angle impulse) and may IGNORE this vector. We deliberately
  // do NOT compute quick-shot aim here — leaving that to the sim agent (do not add it client-side).
  const fire = fireQueued; fireQueued = false;
  const aimed = fire ? aimedShot : false; aimedShot = false; // aimed shot vs quick tap (see releaseShot)
  // A ball CARRIER can't bomb or build (hands full) — drop those inputs (server enforces this too).
  const special = specialQueued && !holdingBall; specialQueued = false;
  const sax = special ? specialAim.x : 0, say = special ? specialAim.y : 0;
  if (specialQueued || special) specialAim = { x: 0, y: 0 };
  const build = buildQueued && !holdingBall; buildQueued = false;
  const inp = { moveX, moveY, aimX, aimY, hold: holding, fire, aimed, special, build, buildHold: buildHolding && !holdingBall, buildDist, sax, say };
  // TUTORIAL: a control the current step has not taught does not exist — hidden on screen AND
  // dropped here, so a stray tap on a button nobody explained cannot do anything surprising.
  return tutorial ? tuGate(inp) : inp;
}

// Send inputs + advance prediction at a fixed rate.
// Sample + send one input packet NOW (no prediction step). Called every tick by the loop
// below AND synchronously on action EDGES (shoot/build/special) so a trigger never waits up
// to a full send-interval — that removes ~0-16ms of input latency on the actions that matter.
function flushInput() {
  if (!ws || ws.readyState !== ws.OPEN || !me.playerId) return null;
  try { const inp = sampleInput(); seq++; ws.send(JSON.stringify({ type: 'input', seq, ...inp })); return { seq, ...inp }; }
  catch (e) { showFatal('input: ' + e.message); return null; }
}
setInterval(() => {
  const sent = flushInput();
  if (sent && predicted && !(latest && latest.resetTimer > 0)) {
    const slowing = ownBuildSlowing();
    stepPrediction(sent.moveX, sent.moveY, INPUT_DT, slowing);
    // Record this timestep's movement so a later snapshot can replay it from the server base.
    // (Edge flushes — shot/build/special — deliberately DON'T record: they carry the same
    // movement but don't advance a timestep, so replaying them would double-count motion.)
    // `slowing` rides along so the replay re-runs each step at the speed it really had.
    if (USE_REPLAY) { pendingInputs.push({ seq: sent.seq, moveX: sent.moveX, moveY: sent.moveY, dt: INPUT_DT, slowing }); if (pendingInputs.length > 256) pendingInputs.shift(); }
  }
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
const wbCtx = worldBuf.getContext('2d', { alpha: false }); // fully painted each frame -> skip per-pixel blending
let wbW = 1, wbH = 1;                 // world-buffer dims (art px)
// Offscreen canvas caches the STATIC field (grass, lines, goals, stands) for the
// whole world incl. the behind-goal net areas; blitted at the camera offset.
const bgCanvas = document.createElement('canvas');
const bgCtx = bgCanvas.getContext('2d'); // keep alpha: renderBackground clearRects to transparent (bowl corners show the worldBuf backdrop)
let ctx = wbCtx;            // active draw target (world draws target the low-res buffer)
let scale = 1, dpr = 1;     // scale = ART pixels per world unit
// The fair play window: how much pitch anyone is allowed to see, in world units. 1212x560 is what the
// reference phone (iPhone 17 Pro, 844x390) sees at CAM_ZOOM 1.65 — the surface the game was tuned on,
// so it is the reference rather than an invented number. Only the height needs stating; the width
// already falls out of `scale`.
// 540, not the iPhone's own 560. The cap can only ever take view AWAY, so a phone SHORTER than the
// reference cannot reach 560: a 360dp-tall Galaxy A15 tops out at 546, which left a 14-unit spread and
// meant the shortest phones were the ones now at a disadvantage. 540 is under every supported phone's
// ceiling, so all of them land on it exactly — measured across iPhone 17 Pro, Galaxy A15/S24, S24
// Ultra, iPad mini/11"/13" and Galaxy Tab S9 in _fair-check.mjs. It costs the reference phone 20 units
// (3.6%) of height and buys exact parity. Lower this if a shorter phone than 360dp ever ships.
const PLAY_H = 540;
let playH = 1;              // the window's height in ART px (= PLAY_H * scale, capped by the screen)
let bandY = 0;              // ART px of non-play band above the window (and the same below it)
let viewOffY = 0;           // wy()'s extra offset, so the window sits below the top band

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
  _pdPxCache.clear();   // --pd-px could come from a media query; re-read it after a rotate/resize
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
  // FAIR PLAY WINDOW. `scale` above is derived from WIDTH alone, so every device has always seen the
  // same 1212 world units across — and however many units of HEIGHT its screen happened to be worth.
  // Measured on the real devices: a phone sees 560 units tall, an iPad Pro 13" sees 909, which is 62%
  // more pitch for the tablet player. Same width, free extra vision vertically.
  // So the window is capped at PLAY_H units and the surplus screen becomes non-play band. Note this
  // does NOT touch `scale`: sprite size, the background bake and every existing draw call are
  // unchanged, because the width fit was already the binding constraint on every real device. The cap
  // is a camera clamp plus a mask, nothing more.
  playH = Math.min(wbH, PLAY_H * scale);
  bandY = Math.round((wbH - playH) / 2);
  // NOTE a tiny band (1-2 ART px on a 360dp Android) is left alone deliberately. Snapping it shut and
  // handing the screen back to the window was tried and is worse than the sliver it removes: it lets
  // that device see 546 units against everyone else's 540, which is the exact inequality this cap
  // exists to remove. The band stays; drawSkyBands just paints a sliver flat instead of composing
  // scenery into it.
  bgCanvas.width = Math.ceil((FIELD.W + 2 * BACK) * scale);
  bgCanvas.height = Math.ceil((FIELD.H + 2 * BAND) * scale);
  bgCtx.imageSmoothingEnabled = false;
  renderBackground();
}

// Centre the camera on the local player, clamped to the field (+ behind-goal end
// terraces horizontally, + top/bottom touchline terraces vertically). The side
// terraces sit off-pitch, so walking to an edge pans the camera to reveal them.
function updateCamera() {
  // Spectating has no local player, so the ball is the subject — which is also what a broadcast
  // camera does. The goal-lead and terrace clamps below then work unchanged off that point.
  const spec = WATCH && latest && latest.ball;
  const cx = spec ? latest.ball.x : (rendered ? rendered.x : FIELD.W / 2);
  const cy = spec ? latest.ball.y : (rendered ? rendered.y : FIELD.H / 2);
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
  // The vertical clamp works against the PLAY WINDOW (playH), not the screen (wbH). That substitution
  // is the whole fairness fix: clamping to the screen is what let a taller device pull more pitch into
  // view. With playH the window is the same size everywhere, so every player's camera reveals the same
  // amount of grass and a tablet's extra screen stays outside it.
  const fieldHpx = FIELD.H * scale, worldHpx = (FIELD.H + 2 * CAM_BAND) * scale;
  const minY = -CAM_BAND * scale, maxY = (FIELD.H + CAM_BAND) * scale - playH;
  const tY = worldHpx <= playH ? (fieldHpx - playH) / 2 : clamp(cy * scale - playH / 2, minY, Math.max(minY, maxY)); // whole bowl fits -> centre
  const EASE = 0.30;  // was 0.22 — tighter camera follow so the view doesn't drag behind you
  if (Math.abs(tX - camX) > wbW * 0.6 || Math.abs(tY - camY) > wbH * 0.6) { camX = tX; camY = tY; }
  else { camX += (tX - camX) * EASE; camY += (tY - camY) * EASE; }
}

// Observability for the fairness cap, in the same spirit as HubTour.state(): the whole point of the
// cap is a number that must match across devices, and a claim like "everyone sees the same pitch" is
// worth nothing unless a harness can read it back. _device-matrix.mjs asserts against this.
window.__view = () => ({
  vw: innerWidth, vh: innerHeight, wbW, wbH, scale: +scale.toFixed(4),
  bandY, playH: Math.round(playH),
  seesWorldW: Math.round(wbW / scale), seesWorldH: Math.round(playH / scale),
  pitchPct: +((playH / scale) / FIELD.H * 100).toFixed(1),
});

// The non-play bands, drawn into the world buffer after the world so they cover it, and before the
// blit so they scale up with the same fat pixels as everything else.
//
// WHAT GOES IN THEM depends on what is behind them, and only one of the two cases gets sky:
//   * band over PITCH — the tablet's surplus screen, grass a phone player would not be shown. It has
//     to be hidden for the cap to mean anything, and it is covered with SkyBand's clouds/balloons.
//   * band over the real TERRACE — when the player walks within ~280 units of a touchline the window
//     edge crosses the line and the band genuinely overlaps the stands. Those are world geometry and
//     are left alone: they scroll with the world, exactly as they do today.
// Drawing stadium into the band instead was tried first and rejected on sight: the band is
// screen-fixed, so world-locked stands slide around inside a static frame and read as broken. Sky is
// ambient and owes the pitch no fixed geometry, which is why it can live in a fixed frame at all.
function drawSkyBands() {
  if (bandY <= 0 || !window.SkyBand) return;
  const t = performance.now() / 1000;
  // Under ~4 ART px there is no room to compose anything — a cloud is 3px of its own. Paint the sliver
  // flat in the sky's own base tone: the mask still holds (which is what fairness needs) and no phone
  // pays for scenery it cannot see.
  const SLIVER = 4;
  // The blimp's advertising banner. Passed from here rather than left to sky-band.js's default: the
  // module is generic scenery and the brand belongs to the game.
  const SKY_BANNER = 'סולטיז';
  const flat = (window.SkyBand.palette && window.SkyBand.palette.sky1) || '#18385f';
  const pitchTopArt = -camY + viewOffY;                       // ART y of world y = 0
  const pitchBotArt = FIELD.H * scale - camY + viewOffY;      // ART y of world y = FIELD.H
  // How close this edge of the window is to its touchline: 0 at midfield, 1 once the line is reached.
  const reach = Math.max(1, (FIELD.H - PLAY_H) / 2 * scale);
  const approach = (gapArt) => clamp(1 - gapArt / reach, 0, 1);

  // TOP: sky covers from the pitch's top edge down to the window, and nothing above it (that is stand).
  const topSkyFrom = Math.max(0, pitchTopArt);
  if (topSkyFrom < bandY) {
    const r = { x: 0, y: topSkyFrom, w: wbW, h: bandY - topSkyFrom };
    if (r.h < SLIVER) { wbCtx.fillStyle = flat; wbCtx.fillRect(r.x, r.y, r.w, r.h); }
    else SkyBand.draw(wbCtx, r, { camX, t, bannerText: SKY_BANNER, side: 'top', edgeApproach: approach(pitchTopArt) });
  }
  // BOTTOM: mirrored — sky from the window's lower edge down to the pitch's bottom edge.
  const winBot = bandY + playH;
  const botSkyTo = Math.min(wbH, pitchBotArt);
  if (botSkyTo > winBot) {
    const r = { x: 0, y: winBot, w: wbW, h: botSkyTo - winBot };
    if (r.h < SLIVER) { wbCtx.fillStyle = flat; wbCtx.fillRect(r.x, r.y, r.w, r.h); }
    else SkyBand.draw(wbCtx, r, { camX, t, bannerText: SKY_BANNER, side: 'bottom', edgeApproach: approach(wbH - pitchBotArt) });
  }
}

// World -> ART px (through the camera).
function wx(x) { return x * scale - camX; }
// `viewOffY` slides the whole world down by the top band's depth, so camY keeps meaning "world y at the
// top of the play window" and every existing draw call lands inside the window with no changes. It is
// zeroed while renderBackground() bakes the stadium, which draws into its own canvas at its own origin
// and would otherwise come out shifted by the band.
function wy(y) { return y * scale - camY + viewOffY; }
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
  const sx = camX, sy = camY, sctx = ctx, soff = viewOffY;
  camX = -BACK * scale; camY = -BAND * scale; ctx = bgCtx; viewOffY = 0; // bake at the canvas origin
  try {
    bgCtx.clearRect(0, 0, bgCanvas.width, bgCanvas.height);
    drawStands();
    drawSeatChairs(); // empty stadium seats — static furniture; card spectators bob on top later
    drawField();
  } finally { ctx = sctx; camX = sx; camY = sy; viewOffY = soff; }
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
    { kind: 'logo', logo: '/assets/saltiz-icon.png', text: 'סולטיז', bg: '#0d1636', fg: '#ffd54a' },
    { kind: 'youtube', text: 'YouTube', bg: '#ffffff', fg: '#ff0000' },
    { kind: 'name', text: 'שובל', bg: '#2a0d4a', fg: '#ff8ae6' },
    { kind: 'name', text: 'נווה', bg: '#0d3a2a', fg: '#8affa0' },
    { kind: 'marquee', text: 'ארז האבא הווינר של דן, טומי ודניאל', bg: '#160d36', fg: '#ffd54a' },
    { kind: 'name', text: 'אורי', bg: '#3a220d', fg: '#ffbf5a' },
    { kind: 'name', text: 'פז', bg: '#0d2438', fg: '#5ad6ff' },
    { kind: 'saltiz', text: 'סולטיז TV', bg: '#160d36', fg: '#ff5ad0' },
    { kind: 'name', text: 'שובל · נווה · אורי · פז', bg: '#0d2a1c', fg: '#8affa0' },
  ];
}
let _adBoardRects = [];            // {x,y,w,h,link} SCREEN px — for tap hit-testing
const BOARD_H = 44;                // world-units thickness of the LED perimeter boards (must stay < LANE)
// Path a rounded rect (native roundRect when available, manual arcTo fallback for old webviews).
function roundRectPath(x, y, w, h, r) {
  if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); return; }
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
// The following three draw an ad board's CONTENT centred on the current (already
// translated/rotated) origin. Lpx = board length, Tpx = board thickness (both screen px).
// YouTube: red rounded plate + white play triangle + dark wordmark (bg is white).
function drawYouTubeContent(Lpx, Tpx) {
  const h = Tpx * 0.66, w = h * 1.4, r = h * 0.28, fs = Tpx * 0.5;
  ctx.font = `900 ${fs}px system-ui, sans-serif`;
  const label = 'YouTube', tw = ctx.measureText(label).width, gap = h * 0.32;
  const x0 = -(w + gap + tw) / 2, y0 = -h / 2;
  ctx.fillStyle = '#ff0000'; roundRectPath(x0, y0, w, h, r); ctx.fill();
  ctx.fillStyle = '#fff'; const tx = x0 + w * 0.42, ts = h * 0.3;
  ctx.beginPath(); ctx.moveTo(tx - ts * 0.7, -ts); ctx.lineTo(tx - ts * 0.7, ts); ctx.lineTo(tx + ts, 0); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#282828'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText(label, x0 + w + gap, 0); ctx.textAlign = 'center';
}
// Saltiz wordmark: bold gradient fill with a pulsing neon glow.
function drawSaltizContent(Lpx, Tpx, text, fg, t) {
  const fs = Tpx * 0.5, pulse = 0.5 + 0.5 * Math.sin(t * 3);
  ctx.font = `900 ${fs}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const grad = ctx.createLinearGradient(-Lpx / 2, 0, Lpx / 2, 0);
  grad.addColorStop(0, '#ffe9a3'); grad.addColorStop(0.5, fg); grad.addColorStop(1, '#ff8ae6');
  ctx.shadowColor = fg; ctx.shadowBlur = 4 + 10 * pulse;
  ctx.fillStyle = grad; ctx.fillText(text, 0, 0, Lpx * 0.94); ctx.shadowBlur = 0;
}
// Plain sponsor/name text with a softer pulsing glow.
function drawBoardText(Lpx, Tpx, text, fg, t) {
  const fs = Tpx * 0.46, pulse = 0.5 + 0.5 * Math.sin(t * 2.4);
  ctx.font = `800 ${fs}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.shadowColor = fg; ctx.shadowBlur = 3 + 6 * pulse;
  ctx.fillStyle = fg; ctx.fillText(text, 0, 0, Lpx * 0.94); ctx.shadowBlur = 0;
}
// Build (once) a LOW-RES copy of a logo so it draws as chunky pixels (matches the block art).
const _pixLogos = new Map();
function pixelatedLogo(url, cells) {
  const key = url + '@' + cells;
  const cached = _pixLogos.get(key);
  if (cached) return cached;
  const im = adImage(url);
  if (!im.ready) return null;
  const aspect = (im.naturalWidth / im.naturalHeight) || 1;
  const cw = Math.max(1, Math.round(cells * aspect)), ch = cells;
  const pc = document.createElement('canvas'); pc.width = cw; pc.height = ch;
  const pctx = pc.getContext('2d'); pctx.imageSmoothingEnabled = true; pctx.drawImage(im, 0, 0, cw, ch);
  _pixLogos.set(key, pc); return pc;
}
// Pixelated app logo + wordmark, centred on the (already translated/rotated) origin.
function drawLogoContent(Lpx, Tpx, url, label, fg, t) {
  const pc = pixelatedLogo(url, 34);
  const h = Tpx * 0.86, w = pc ? h * (pc.width / pc.height) : h;
  const fs = Tpx * 0.5; ctx.font = `900 ${fs}px system-ui, sans-serif`;
  const tw = label ? ctx.measureText(label).width : 0, gap = label ? h * 0.3 : 0;
  const x0 = -(w + gap + tw) / 2;
  if (pc) { const sm = ctx.imageSmoothingEnabled; ctx.imageSmoothingEnabled = false; ctx.drawImage(pc, x0, -h / 2, w, h); ctx.imageSmoothingEnabled = sm; }
  if (label) {
    const pulse = 0.5 + 0.5 * Math.sin(t * 3);
    ctx.shadowColor = fg; ctx.shadowBlur = 4 + 8 * pulse; ctx.fillStyle = fg;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(label, x0 + w + gap, 0);
    ctx.shadowBlur = 0; ctx.textAlign = 'center';
  }
}
// Marquee: text scrolls continuously LEFT -> RIGHT along the board length, wrapping around.
function drawMarqueeContent(Lpx, Tpx, text, fg, t) {
  const fs = Tpx * 0.5; ctx.font = `800 ${fs}px system-ui, sans-serif`;
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  const tw = ctx.measureText(text).width, span = Lpx + tw;
  const x = -Lpx / 2 - tw + ((t * (span / 6)) % span); // full pass every ~6s, moving rightward
  const pulse = 0.5 + 0.5 * Math.sin(t * 2.4);
  ctx.shadowColor = fg; ctx.shadowBlur = 3 + 6 * pulse; ctx.fillStyle = fg;
  ctx.fillText(text, x, 0); ctx.shadowBlur = 0; ctx.textAlign = 'center';
}
function drawAdBoards() {
  const ads = stadiumAds(); if (!ads.length) return;
  _adBoardRects = [];
  const t = performance.now() / 1000;
  const idxBase = Math.floor(t / 3.5); // rotate the boards every 3.5s (snappier)
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
    if (sw <= 0 || sh <= 0) continue;
    ctx.fillStyle = '#0b0f14'; ctx.fillRect(sx, sy, sw, sh);                    // frame
    ctx.fillStyle = ad.bg || '#16233c'; ctx.fillRect(sx + 1, sy + 1, sw - 2, sh - 2);
    ctx.save(); ctx.beginPath(); ctx.rect(sx, sy, sw, sh); ctx.clip();          // keep all content on the board
    if (ad.img) { const im = adImage(ad.img); if (im.ready) ctx.drawImage(im, sx, sy, sw, sh); }
    else {
      const Lpx = vertical ? sh : sw, Tpx = Math.max(9, vertical ? sw : sh);
      ctx.save(); ctx.translate(sx + sw / 2, sy + sh / 2); if (vertical) ctx.rotate(-Math.PI / 2);
      if (ad.kind === 'youtube') drawYouTubeContent(Lpx, Tpx);
      else if (ad.kind === 'saltiz') drawSaltizContent(Lpx, Tpx, ad.text || 'סולטיז', ad.fg || '#ffd54a', t);
      else if (ad.kind === 'logo') drawLogoContent(Lpx, Tpx, ad.logo, ad.text, ad.fg || '#ffd54a', t);
      else if (ad.kind === 'marquee') drawMarqueeContent(Lpx, Tpx, ad.text || '', ad.fg || '#fff', t);
      else drawBoardText(Lpx, Tpx, ad.text || 'סולטיז', ad.fg || '#fff', t);
      ctx.restore();
      // Excitement: a bright gloss band sweeping across the board.
      const sweep = ((t * 0.5 + oi * 0.17) % 1);
      const bw = Math.max(sh, sw * 0.10);
      ctx.globalAlpha = 0.10; ctx.fillStyle = '#ffffff';
      ctx.fillRect(sx - bw + sweep * (sw + bw * 2), sy, bw, sh);
      ctx.globalAlpha = 1;
    }
    ctx.restore();                                                             // end board clip
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

// ---- Comic celebration overlay (goal / win / lose), Hebrew, screen-space -------------------
// Replaces the flat DOM banner text with a kinetic comic word on a starburst: overshoot pop,
// speed lines, halftone ring, thick outline. Drawn on the display canvas after the HUD.
let celeb = null; // { kind, text, c1, c2, muted, speed, ease, dur, start }
const CELEB_FONT = '"Arial Black","Arial Hebrew","Helvetica Neue",system-ui,sans-serif';
const celBack = (x) => { const c1 = 2.4, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };
const celCubic = (x) => 1 - Math.pow(1 - x, 3);
const celElastic = (x) => { if (x <= 0 || x >= 1) return clamp(x, 0, 1); const c4 = (2 * Math.PI) / 3; return Math.pow(2, -10 * x) * Math.sin((x * 10 - 0.75) * c4) + 1; };
// `over` lets a caller bend one of the presets for its own context without inventing a second entry
// in the table — the tutorial shortens the goal word's hold (see processSnapshotSounds) and nothing
// else about it. Applied over the preset, so a caller can only override fields the preset defines.
function triggerCelebration(kind, over = null) {
  const P = {
    'goal-us':   { text: 'גול!',   c1: '#ffe14a', c2: '#ff8f1f', ease: 'back',    speed: true,  dur: 2.3 },
    'goal-them': { text: 'ספגנו',  c1: '#c3d2ea', c2: '#8fa6c8', ease: 'cubic',   speed: false, dur: 1.7, muted: true },
    'win':       { text: 'ניצחון!', c1: '#8bffb0', c2: '#ffcf1f', ease: 'elastic', speed: true,  dur: 0 },
    'lose':      { text: 'כמעט!',  c1: '#cfe0ff', c2: '#8fa6c8', ease: 'cubic',   speed: false, dur: 0, muted: true },
    'draw':      { text: 'תיקו',   c1: '#ffe14a', c2: '#ff8f1f', ease: 'back',    speed: true,  dur: 0 },
  }[kind];
  if (!P) return;
  celeb = { ...P, ...(over || {}), kind, start: performance.now() };
  shake(P.muted ? 5 : 11, P.muted ? 260 : 360);
  if (kind === 'win') confettiBurst(150);
}
function drawCelebration() {
  if (!celeb) return;
  const g = mainCtx, W = canvas.width, H = canvas.height;
  const el = (performance.now() - celeb.start) / 1000;
  let alpha = 1;
  if (celeb.dur > 0) { if (el > celeb.dur) alpha = 1 - (el - celeb.dur) / 0.4; if (alpha <= 0) { celeb = null; return; } }
  const cx = W / 2, cy = H * 0.40, S = Math.min(W, H);
  g.save();
  g.textAlign = 'center'; g.textBaseline = 'middle';
  // impact flash on the first frames
  if (el < 0.16) { g.globalAlpha = (1 - el / 0.16) * (celeb.muted ? 0.35 : 0.6); g.fillStyle = celeb.muted ? '#22355c' : '#ffffff'; g.fillRect(0, 0, W, H); g.globalAlpha = 1; }
  // comic speed lines radiating from the centre
  if (celeb.speed) {
    const sp = Math.min(1, el / 0.5);
    g.save(); g.translate(cx, cy); g.globalAlpha = alpha * 0.5 * sp; g.strokeStyle = 'rgba(255,255,255,0.18)';
    for (let i = 0; i < 28; i++) { const a = i / 28 * Math.PI * 2 + el * 0.25, r0 = S * 0.30, r1 = S * 0.66; g.lineWidth = (i % 2 ? 1 : 3) * (S / 360); g.beginPath(); g.moveTo(Math.cos(a) * r0, Math.sin(a) * r0); g.lineTo(Math.cos(a) * r1, Math.sin(a) * r1); g.stroke(); }
    g.restore();
  }
  // starburst behind the word (scales in with overshoot, slow spin)
  const bs = Math.max(0, celBack(Math.min(1, el / 0.4)));
  g.save(); g.translate(cx, cy); g.rotate(el * 0.3); g.scale(bs, bs); g.globalAlpha = alpha;
  const spikes = 18, rO = S * 0.30, rI = S * 0.205;
  g.fillStyle = celeb.muted ? '#2a3550' : '#ff2e40'; g.beginPath();
  for (let i = 0; i < spikes * 2; i++) { const a = i / (spikes * 2) * Math.PI * 2, r = i % 2 ? rO : rI; g.lineTo(Math.cos(a) * r, Math.sin(a) * r); } g.closePath(); g.fill();
  g.fillStyle = celeb.muted ? '#1b2338' : '#ffd21f'; g.beginPath();
  for (let i = 0; i < spikes * 2; i++) { const a = i / (spikes * 2) * Math.PI * 2 + 0.12, r = (i % 2 ? rO : rI) * 0.72; g.lineTo(Math.cos(a) * r, Math.sin(a) * r); } g.closePath(); g.fill();
  g.restore();
  // halftone dot ring
  g.save(); g.translate(cx, cy); g.globalAlpha = alpha * 0.45; g.fillStyle = celeb.muted ? 'rgba(255,255,255,.5)' : 'rgba(0,0,0,.5)';
  for (let i = 0; i < 56; i++) { const a = i / 56 * Math.PI * 2, r = S * 0.345 + Math.sin(i * 3 + el * 4) * (S * 0.008); g.beginPath(); g.arc(Math.cos(a) * r, Math.sin(a) * r, (i % 3 ? 1.6 : 2.6) * (S / 360), 0, 7); g.fill(); }
  g.restore();
  // the word — whole-string overshoot (RTL-safe), thick outline, gradient fill
  let fontPx = S * (celeb.text.length <= 3 ? 0.22 : celeb.text.length <= 5 ? 0.16 : 0.13);
  g.font = '900 ' + fontPx + 'px ' + CELEB_FONT;
  const tw = g.measureText(celeb.text).width; if (tw > W * 0.9) { fontPx *= (W * 0.9) / tw; g.font = '900 ' + fontPx + 'px ' + CELEB_FONT; }
  const easeFn = celeb.ease === 'elastic' ? celElastic : celeb.ease === 'cubic' ? celCubic : celBack;
  const s = Math.max(0.01, easeFn(Math.min(1, el / 0.5)));
  const bounce = el > 0.5 ? 1 + Math.sin((el - 0.5) * 8) * Math.exp(-(el - 0.5) * 4) * 0.05 : 1;
  g.save(); g.globalAlpha = alpha; g.translate(cx, celeb.muted ? cy + S * 0.02 : cy); g.scale(s * bounce, s * bounce);
  g.shadowColor = 'rgba(0,0,0,0.55)'; g.shadowBlur = fontPx * 0.12; g.shadowOffsetY = fontPx * 0.06;
  g.lineWidth = fontPx * 0.16; g.lineJoin = 'round'; g.strokeStyle = celeb.muted ? '#141a26' : '#111'; g.strokeText(celeb.text, 0, 0);
  g.shadowColor = 'transparent';
  const grad = g.createLinearGradient(0, -fontPx / 2, 0, fontPx / 2); grad.addColorStop(0, celeb.c1); grad.addColorStop(1, celeb.c2);
  g.fillStyle = grad; g.fillText(celeb.text, 0, 0);
  g.restore();
  g.restore();
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
  if ((p.power || (isMe && mySuperLatched)) && !(isMe && bombDrag.active)) { // OVERCHARGE available OR a super shot is loaded (latched) — pulsing RED ring stays until fired (suppressed on the local hero while aiming a bomb)
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
  // danger radius preview (the blast zone) — always shown for a planted bomb.
  ctx.beginPath(); ctx.arc(x, y, ws_(BOMB.radius), 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(239,68,68,.07)'; ctx.fill();
  ctx.setLineDash([ws_(6), ws_(6)]);
  ctx.strokeStyle = 'rgba(239,68,68,.5)'; ctx.lineWidth = Math.max(1, ws_(2)); ctx.stroke();
  ctx.setLineDash([]);
  // FLY-IN intro (lob arc): the bomb ARCS in from the thrower to where it lands over FLY_MS —
  // ease-out horizontally toward the landing spot + a sine hop for the throw. On arrival it kicks
  // a ground shock ring + dust + a small screen shake (once). Transforms the BODY only.
  const FLY_MS = 460;
  const lt0 = bombSpawnT.get(bomb.id);
  ctx.save();
  if (lt0 != null) {
    const p = clamp((performance.now() - lt0) / FLY_MS, 0, 1);
    if (p < 1) {
      const ux = 1 - (1 - p) * (1 - p);              // ease-out toward the landing spot
      const hop = Math.sin(p * Math.PI);             // 0→1→0 arc height factor
      const src = bombSrc.get(bomb.id);
      const sx = src ? wx(src.x) : x, sy = src ? wy(src.y) : y;
      // Body-centre SCREEN position at any progress q along this same arc (ease-out glide + sine hop).
      const posAt = (q) => {
        const uq = 1 - (1 - q) * (1 - q), hq = Math.sin(q * Math.PI);
        return { x: x + (sx - x) * (1 - uq), y: y + (sy - y) * (1 - uq) - hq * r * 7 };
      };
      // FUSE TRAIL — smoke + sparks sampled back along the arc from the lit fuse tip. Sells the
      // throw as an airborne, fuse-lit object. Drawn first (behind body/shadow), absolute coords.
      const TRAIL_N = 14, TRAIL_STEP = 0.05, TIP_X = r * 0.5, TIP_Y = -r * 1.9; // fuse-tip offset in the sprite
      for (let i = TRAIL_N; i >= 1; i--) {
        const q = p - i * TRAIL_STEP; if (q <= 0) continue;
        const bp = posAt(q), px = bp.x + TIP_X, py = bp.y + TIP_Y;
        const life = 1 - i / TRAIL_N;                // ~0 oldest → ~1 nearest the bomb
        ctx.globalAlpha = 0.30 * life;               // smoke puff: grows + fades as it ages
        ctx.fillStyle = '#6b6257';
        const ss = r * (0.35 + (1 - life) * 0.9);
        ctx.fillRect(px - ss / 2, py - ss / 2, ss, ss);
        if (i <= 6) {                                // hot spark near the head only
          ctx.globalAlpha = life;
          ctx.fillStyle = i % 2 ? '#ffe27a' : '#ff9b27';
          const sk = r * 0.32 * life;
          ctx.fillRect(px - sk / 2, py - sk / 2, sk, sk);
        }
      }
      ctx.globalAlpha = 1;
      // A ground shadow at the LANDING spot that grows as the bomb drops — sells the throw.
      ctx.save();
      ctx.globalAlpha = 0.28 * (0.35 + 0.65 * p);
      ctx.fillStyle = '#000';
      ctx.beginPath(); ctx.ellipse(x, y + r * 0.5, r * (0.5 + 0.6 * p), r * (0.24 + 0.28 * p), 0, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      if (src) ctx.translate((sx - x) * (1 - ux), (sy - y) * (1 - ux));
      ctx.translate(0, -hop * r * 7);   // higher arc hop — clearly a thrown bomb
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
  // Radial reload ring: full when the mag is topped up, else the trickling round's progress.
  buildBtn.style.setProperty('--cd', ammo >= BUILD_MAG ? 1 : (p.buildFrac || 0));
  buildBtn.classList.toggle('empty', ammo <= 0);
}

// --- Pixel numerals for the clock + score -----------------------------------------------------
// The BLOCK SIZE lives in style.css as `--pd-px` on `.timer` / `.score`, so the clock and score are
// resized by editing one number in the stylesheet rather than here. Read once per element and
// cached: getComputedStyle forces a style recalc, and drawHUD runs 60×/second.
const scoreDashEl = document.querySelector('#hud .score .dash');
function pdPx(el, fallback) {
  if (!el) return fallback;
  let v = _pdPxCache.get(el);
  if (v === undefined) {
    v = parseFloat(getComputedStyle(el).getPropertyValue('--pd-px')) || fallback;
    _pdPxCache.set(el, v);
  }
  return v;
}
const clockPx = () => pdPx(document.getElementById('timer'), 2);
const scorePx = () => pdPx(document.getElementById('scoreA'), 3);
mountPixelDigitCss();

function drawHUD() {
  if (!latest) return;
  // Score shown from my perspective: my team (blue) on the left, opponent (red) right.
  const myT = me.team || 'A', opT = myT === 'A' ? 'B' : 'A';
  const myScore = latest.score[myT], opScore = latest.score[opT];
  // Pixel-block numerals (public/pixel-digits.js), not text — matches the pixel art, and stays
  // crisp at any size. The size comes from each element's own --pd-px, so the clock and the score
  // are tuned purely in style.css. setPixelText no-ops when the value hasn't changed, so this is
  // free on a steady frame even though drawHUD runs at 60Hz.
  setPixelText(document.getElementById('scoreA'), myScore, scorePx());
  setPixelText(scoreDashEl, '–', scorePx());
  setPixelText(document.getElementById('scoreB'), opScore, scorePx());
  // Format caption + match point. Without this, first-to-3 rendered as bare digits and
  // you could win (or lose) the match with no warning that the next goal decided it.
  const fmtEl = document.getElementById('score-fmt');
  if (fmtEl) {
    const otNow = OVERTIME_DURATION > 0 && latest.phase !== 'ended' && (latest.elapsed || 0) >= MATCH_DURATION;
    if (training) { fmtEl.textContent = ''; fmtEl.classList.remove('match-point'); }
    else if (otNow) { fmtEl.textContent = 'גול הזהב'; fmtEl.classList.add('match-point'); }
    else if (matchGoalsToWin > 0) {
      const N = matchGoalsToWin;
      const onPoint = myScore === N - 1 || opScore === N - 1;
      fmtEl.textContent = onPoint
        ? (myScore === opScore ? 'הגול הבא מנצח' : myScore > opScore ? 'נקודת ניצחון' : 'נקודת הפסד')
        : `ראשון ל-${N}`;
      fmtEl.classList.toggle('match-point', onPoint && latest.phase !== 'ended');
    } else {
      fmtEl.textContent = 'הכי הרבה גולים';
      fmtEl.classList.remove('match-point');
    }
  }
  // Match clock counts DOWN to 0:00, then the match ends. Training has no clock.
  const timerEl = document.getElementById('timer');
  if (training) {
    timerEl.classList.add('hidden');
  } else {
    timerEl.classList.remove('hidden');
    // OVERTIME needs no wire field: the clock only passes MATCH_DURATION when the sim
    // extended a level match into golden goal (a decided match ends at the cap instead).
    const inOT = OVERTIME_DURATION > 0 && latest.phase !== 'ended' && (latest.elapsed || 0) >= MATCH_DURATION;
    const cap = inOT ? MATCH_DURATION + OVERTIME_DURATION : MATCH_DURATION;
    const remain = Math.max(0, Math.ceil(cap - (latest.elapsed || 0)));
    const m = Math.floor(remain / 60), s = remain % 60;
    setPixelText(timerEl, `${m}:${String(s).padStart(2, '0')}`, clockPx());
    timerEl.classList.toggle('urgent', remain <= 10 && latest.phase !== 'ended');
    timerEl.classList.toggle('overtime', inOT);
  }
  // Connection quality: warn the player when their OWN link degrades. Shows nothing while
  // healthy — see public/net-hud.js + net-quality.js (unit-tested in test-net-quality.mjs).
  renderNetHud({ snapRate, unacked: pendingInputs.length, wsOpen: !!(ws && ws.readyState === ws.OPEN) });
  // The raw ping/snapshot numbers were always a developer diagnostic, never player-facing:
  // ?debug=net now renders them from net-hud's own readout, so this chip stays hidden.
  { const netEl = document.getElementById('net'); if (netEl) netEl.style.display = NET_DEBUG ? '' : 'none'; }

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
    // Win/lose is the canvas comic overlay (drawCelebration) — keep the DOM banner hidden.
    banner.classList.add('hidden'); banner.classList.remove('count');
    if (!matchResultSent) {
      matchResultSent = true;
      stopMusic();                                                    // clear the pitch for the sting
      if (myScore !== opScore) playSound(myScore > opScore ? 'win' : 'loss', 0.9);
      triggerCelebration(myScore > opScore ? 'win' : (myScore < opScore ? 'lose' : 'draw'));
      // PRACTICE PAYS NOTHING. Per the user (2026-07-27) the training ground must never move trophies
      // or rank, and this post is the ONLY thing that can move them — pikme-server credits both tracks
      // off matchResult (xpDelta is the גביעים/trophy track, rankDelta the ladder). `training` and
      // `builder` are endless (noClock) so they never reached here anyway; `botgame` did, and paid out
      // at a merely-discounted rate rather than zero. Suppressing the post beats asking the server for
      // zero: it stays game-side, so no API change and no app rebuild.
      // The celebration above still runs — you won, you should see it. Only the payout is withheld, and
      // the hub then has nothing to reveal on return, which is correct.
      // Guarded, NOT an early `return`: this runs inside the per-frame HUD update, and returning here
      // would silently skip everything after this branch for the rest of the frame.
      if (!isPracticeMode(roomMode)) {
        // Post the result WITH the per-player stats: fire as soon as the server's matchStats arrives,
        // else a 1.2s fallback posts without them (never miss the record).
        _pendingPost = () => { _pendingPost = null; postMatchResult(myT, opT, myScore, opScore); };
        if (myMatchStats) { const f = _pendingPost; _pendingPost = null; f(); }
        else setTimeout(() => { if (_pendingPost) { const f = _pendingPost; _pendingPost = null; f(); } }, 1200);
      }
    }
  } else if (latest.resetTimer > 0 && latest.lastGoal) {
    // GOAL! is the canvas comic overlay (fired on the goal event). Hide the DOM banner during
    // the freeze; once it ticks 3-2-1 the DOM shows the countdown number.
    const showing = latest.resetTimer > GOAL_RESET - GOAL_FREEZE_HOLD;
    if (showing) { banner.classList.add('hidden'); banner.classList.remove('count'); }
    else { banner.textContent = String(Math.ceil(latest.resetTimer)); banner.style.color = ''; banner.classList.add('count'); banner.classList.remove('hidden'); } // main-menu countdown look
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

const WOOD_PAL = { top: '#b07d42', face: '#7a5327', hi: 'rgba(255,240,200,.28)', shadow: '#4a2f16' };
// A crate = a single-cell WOODEN box (mechanically a solid indestructible wall). Extruded like
// the stone block, wood-toned, with plank seams + an X-brace + frame — the option-1 look.
function drawCrateBox(w) {
  drawBlockBox(w, WOOD_PAL, {
    texture: (ax, ay, aw, ah) => {
      ctx.fillStyle = 'rgba(0,0,0,.18)';                                     // vertical plank seams
      const step = Math.max(3, Math.round(aw / 4));
      for (let x = ax + step; x < ax + aw - 1; x += step) ctx.fillRect(Math.round(x), ay, 1, ah);
      ctx.strokeStyle = 'rgba(74,47,22,.9)';
      ctx.lineWidth = Math.max(2, ws_(4));                                   // X-brace
      ctx.beginPath();
      ctx.moveTo(ax + 2, ay + 2); ctx.lineTo(ax + aw - 2, ay + ah - 2);
      ctx.moveTo(ax + aw - 2, ay + 2); ctx.lineTo(ax + 2, ay + ah - 2);
      ctx.stroke();
      ctx.lineWidth = Math.max(2, ws_(3));                                   // frame
      ctx.strokeRect(ax + 1, ay + 1, aw - 2, ah - 2);
    },
  });
}
function drawWallBlock(w) {
  if (w.crate) return drawCrateBox(w);                            // single-cell wooden crate
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
// HP indicator for a wall BLOCK: maxHp pips above its centre, the first `hp` filled.
// A player wall is 4 abutting blocks that tile into one bar, so we only draw pips on a
// block that has ALREADY taken damage — a pristine wall stays clean (no 12-pip clutter),
// and a dinged segment shows exactly which part of the wall is weakened.
function drawWallPips(w) {
  if ((w.hp || 1) >= (w.maxHp || 1)) return; // undamaged block → no pips
  const s = wallSlab(w);
  const pipY = s.cy - s.T / 2 - Math.max(2, ws_(9));
  const px0 = s.cx - ((w.maxHp || 1) * Math.max(3, ws_(11))) / 2;
  for (let i = 0; i < (w.maxHp || 1); i++) pxi(px0 + i * Math.max(3, ws_(11)), pipY, Math.max(2, ws_(8)), Math.max(2, ws_(5)), i < w.hp ? '#ffd27a' : 'rgba(0,0,0,.4)');
}
function drawBuiltWall(w) {
  if (w.fragile) { drawFragileWall(w); drawWallPips(w); return; }
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
  drawWallPips(w); // one HP indicator for the whole (one-piece) wall
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
const REVEAL_FULL_DIST = BUSH_REVEAL_DIST * 0.5; // fully opaque by this range; fades out to BUSH_REVEAL_DIST
const firedReveal = {};
const spotHidden = {};  // enemy id -> was it fully hidden last frame (for the reveal edge)
const spotStart = {};   // enemy id -> perf.now() when it was first spotted out of a bush
// Brawl-Stars-style proximity reveal: how visible is enemy `p` to the LOCAL player, 0..1.
// A bushed enemy is hidden far away and FADES IN as you close (over BUSH_REVEAL_DIST -> half),
// so it never hard-pops. Open enemies / teammates / a fresh fire-from-bush are fully visible.
// It reads `rendered` (my own position), so the reveal is naturally per-player.
function bushRevealAlpha(p) {
  if (p.team === me.team) return 1;
  const inBush = inBushAt(p.x, p.y);
  if (p.firing && inBush) firedReveal[p.id] = performance.now();
  if (!inBush) return 1;
  if (performance.now() - (firedReveal[p.id] || -1e9) < BUSH_FIRE_REVEAL) return 1; // just fired -> spotted
  if (!rendered) return 0;
  const d = Math.hypot(rendered.x - p.x, rendered.y - p.y);
  if (d >= BUSH_REVEAL_DIST) return 0;            // too far -> hidden
  if (d <= REVEAL_FULL_DIST) return 1;            // right on top of them -> solid
  const t = (BUSH_REVEAL_DIST - d) / (BUSH_REVEAL_DIST - REVEAL_FULL_DIST);
  return t * t * (3 - 2 * t);                     // smoothstep fade-in
}
// Boolean form for non-render callers (auto-aim etc.): visible at all?
function canSeePlayer(p) { return bushRevealAlpha(p) > 0.02; }
// A brief "spotted!" pop above an enemy the instant they're revealed out of a bush — an
// expanding ring + a comic "!" that pops (overshoot) and fades over ~0.6s. World-space (wbCtx).
function drawSpottedCue(worldX, worldY, el) {
  const u = Math.min(1, el / 0.6);
  const a = u < 0.6 ? 1 : Math.max(0, 1 - (u - 0.6) / 0.4);
  const s = Math.max(0, celBack(Math.min(1, el / 0.18)));
  const x = wx(worldX), y = wy(worldY) - ws_(34);
  ctx.save();
  ctx.globalAlpha = a;
  const rr = ws_(6) + celCubic(u) * ws_(16);
  ctx.strokeStyle = '#ffd21f'; ctx.lineWidth = Math.max(1, ws_(2));
  ctx.beginPath(); ctx.arc(x, y, rr, 0, 7); ctx.stroke();
  ctx.translate(x, y); ctx.scale(s, s);
  const bw = Math.max(2, ws_(4)), bh = Math.max(4, ws_(13));
  ctx.fillStyle = '#111'; ctx.fillRect(-bw / 2 - 1, -bh / 2 - 1, bw + 2, bh * 0.62 + 2); ctx.fillRect(-bw / 2 - 1, bh * 0.30 - 1, bw + 2, bw + 2);
  ctx.fillStyle = '#ffd21f'; ctx.fillRect(-bw / 2, -bh / 2, bw, bh * 0.62); ctx.fillRect(-bw / 2, bh * 0.30, bw, bw);
  ctx.restore();
}

// Active obstacle layout: training swaps in its custom asymmetric field.
let customArena = null; // field-builder match: custom {walls,bushes} from matchStart.arena (else null)
function fieldArena() { return customArena || (training ? TRAIN_ARENA : ARENA); }
// Bush test against the active layout (pointInBush only knows the global one).
function inBushAt(x, y) {
  for (const g of fieldArena().bushes) if (x > g.x && x < g.x + g.w && y > g.y && y < g.y + g.h) return true;
  return false;
}

// A charge ring around the LOCAL player — same look as the shoot charge meter (drawPlayer).
// Reused for the wall wind-up and the bomb-throw wind-up so all three read identically.
function drawPlayerChargeRing(frac, col, fullCol) {
  if (!rendered || frac <= 0.02) return;
  const x = wx(rendered.x), y = wy(rendered.y), r = ws_(ownRadius());
  ctx.save();
  ctx.strokeStyle = frac >= 1 ? (fullCol || col) : col;
  ctx.lineWidth = Math.max(2, ws_(4)); ctx.lineCap = 'round';
  ctx.beginPath(); ctx.arc(x, y, r + ws_(11), -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, frac)); ctx.stroke();
  ctx.restore();
}

function drawObstacles() {
  const t = performance.now() / 1000;
  const A = fieldArena();
  for (const g of A.bushes) drawBush(g, t);
  for (const tr of A.trampolines) drawTramp(tr, t);
  for (const w of A.walls) drawWallBlock(w);
  // Steel-wall corner joints — smooth L/T/X at any angle (square mitre or round disc; no gap/"+").
  for (const j of wallJoints(A.walls, A.joints)) {
    ctx.save(); ctx.fillStyle = '#6b7280';
    if (j.style === 'round') { ctx.beginPath(); ctx.arc(wx(j.cx), wy(j.cy), ws_(j.r), 0, 7); ctx.fill(); }
    else { ctx.beginPath(); ctx.moveTo(wx(j.poly[0].x), wy(j.poly[0].y)); for (let k = 1; k < j.poly.length; k++) ctx.lineTo(wx(j.poly[k].x), wy(j.poly[k].y)); ctx.closePath(); ctx.fill(); }
    ctx.fillStyle = 'rgba(255,255,255,.10)'; ctx.fill(); ctx.restore(); // faint sheen → reads as one piece with the slabs
  }
  if (latest && latest.walls) for (const w of latest.walls) drawBuiltWall(w);
  // Ghost preview while dragging the build button.
  if (buildDrag.active && rendered && !holdingBall) {
    let dx = buildDrag.dx, dy = buildDrag.dy;
    if (flipView()) dx = -dx;
    const l = Math.hypot(dx, dy);
    let ax, ay;
    if (l > 12) { ax = dx / l; ay = dy / l; }
    else { const meV = latest && latest.players.find((q) => q.id === me.playerId); ax = meV ? meV.aimX : 1; ay = meV ? meV.aimY : 0; }
    // The ghost IS the placement: one shared formula (angle quantization, push distance AND the
    // in-field clamp that slides a wall built near a line back inside the pitch). Duplicating it
    // here is how the preview used to lie by up to ~160px along a touchline.
    const ghost = wallPlacement(rendered.x, rendered.y, ax, ay, wallReachFrac(dx, dy));
    const ang = ghost.angle, cx = ghost.cx, cy = ghost.cy;
    const L = ws_(BUILT_WALL.len), T = ws_(BUILT_WALL.thick);
    const canc = buildDrag.cancelArmed; // drag pulled back toward centre → releasing now cancels
    ctx.save();
    const wind = currentWindup(); // 0..1 local estimate
    ctx.globalAlpha = canc ? 0.32 : (0.25 + 0.6 * wind); // faint at start, near-solid at full
    ctx.translate(wx(cx), wy(cy)); ctx.rotate(ang);
    ctx.fillStyle = canc ? '#ff4d4d' : (wind >= 1 ? '#ffd27a' : '#ffb347');
    ctx.fillRect(-L / 2, -T / 2, L, T);
    if (canc) { // red ✕ over the ghost = will cancel on release
      ctx.globalAlpha = 0.95; ctx.strokeStyle = 'rgba(255,80,80,1)'; ctx.lineWidth = ws_(5); ctx.lineCap = 'round';
      const x = ws_(11);
      ctx.beginPath(); ctx.moveTo(-x, -x); ctx.lineTo(x, x); ctx.moveTo(x, -x); ctx.lineTo(-x, x); ctx.stroke();
    }
    ctx.globalAlpha = 1; ctx.restore();
    // Wind-up read = a CHARGE RING around the player (same as the shoot meter), not a loading line.
    drawPlayerChargeRing(wind, canc ? 'rgba(255,77,77,0.9)' : 'rgba(255,166,54,0.9)', canc ? 'rgba(255,120,120,0.95)' : 'rgba(255,214,64,0.95)');
  }
  // Bomb-lob aim: a trajectory line + landing circle at the projected spot (THIS is the aim).
  // No charge-ring on the hero's own body — the user doesn't want a red circle on the hero.
  if (bombDrag.active && rendered && !holdingBall) {
    const len = Math.hypot(bombDrag.dx, bombDrag.dy);
    if (bombDrag.cancelArmed) {
      // Cancel state: a hollow RED ring + ✕ at the hero's feet — releasing now throws nothing.
      ctx.save(); ctx.globalAlpha = 0.9;
      ctx.strokeStyle = 'rgba(255,77,77,1)'; ctx.lineWidth = ws_(4); ctx.lineCap = 'round';
      const px = wx(rendered.x), py = wy(rendered.y), r = ws_(24);
      ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.stroke();
      const x = r * 0.6;
      ctx.beginPath(); ctx.moveTo(px - x, py - x); ctx.lineTo(px + x, py + x); ctx.moveTo(px + x, py - x); ctx.lineTo(px - x, py + x); ctx.stroke();
      ctx.globalAlpha = 1; ctx.restore();
    } else if (len > AIM_DEADZONE_PX) {
      const reach = aimFrac(len, 'bomb') * bombMaxPx; // sensitivity → fraction, reach caps the world distance
      let dx = bombDrag.dx / len, dy = bombDrag.dy / len;
      if (flipView()) dx = -dx; // screen -> true-world for team B's mirrored view
      const tx = rendered.x + dx * reach, ty = rendered.y + dy * reach;
      ctx.save();
      ctx.globalAlpha = 0.35; ctx.strokeStyle = '#ffb347'; ctx.lineWidth = ws_(3); ctx.setLineDash([ws_(6), ws_(6)]);
      ctx.beginPath(); ctx.moveTo(wx(rendered.x), wy(rendered.y)); ctx.lineTo(wx(tx), wy(ty)); ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 0.55; ctx.fillStyle = '#ff5a4d';
      ctx.beginPath(); ctx.arc(wx(tx), wy(ty), ws_(26), 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1; ctx.restore();
    }
  }
}

function renderFrame() {
  if (gameEl.classList.contains('hidden')) return; // in the lobby — nothing to draw
  // Tutorial step machine. Runs off the render clock (not a timer) so the coach and the pitch it
  // is pointing at can never disagree about which frame they are on.
  if (tutorial) {
    const tn = performance.now();
    const tdt = tuPrevT ? Math.min(0.05, (tn - tuPrevT) / 1000) : 0.016;
    tuPrevT = tn;
    tuTick(tdt);
  } else { tuPrevT = 0; }
  // Super-latch (visual): once I start charging while in super, keep the red aim + ring until I
  // release (fire) — even if super expires mid-charge, matching the sim's persisted super shot.
  if (holding) { if (mySuper) mySuperLatched = true; } else { mySuperLatched = false; }
  // Ease the drawn local player toward the prediction, then point the camera at it.
  if (predicted) {
    if (!rendered) rendered = { ...predicted };
    rendered.x += (predicted.x - rendered.x) * 0.55; // was 0.35 — tighter follow of the (instant) prediction = sharper
    rendered.y += (predicted.y - rendered.y) * 0.55;
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
  tuDrawWorld();   // tutorial: this step's one pitch cue (ring / target chevron / goal arrow), under the players
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
    // The ball is ALWAYS visible so you can track it even into a bush — the bushed enemy
    // CARRIER stays hidden (see the player loop below), but the ball itself never disappears.
    // (ball is drawn AFTER the players below, so a body standing over it never hides it)

    // Aim-to-shoot indicator for the local player: infinite line, grey normally,
    // RED when overcharged (the meter is up). Owner-only — never drawn for others.
    const aim = currentAim();
    if (aim.aiming && rendered) {
      const meNow = view.players.find((pp) => pp.id === me.playerId);
      drawAimIndicator(rendered.x, rendered.y, aim.ax, aim.ay, currentCharge(), !!(meNow && meNow.power) || mySuperLatched);
    }
    for (const p of view.players) {
      const isMe = p.id === me.playerId && rendered;
      const dp = isMe ? { ...p, x: rendered.x, y: rendered.y, vx: predVel.x, vy: predVel.y } : p;
      // Bushed enemies FADE IN as the local player approaches (Brawl-Stars proximity reveal),
      // rather than hard-popping. alpha 0 => fully concealed; skip drawing (no position tell).
      let alpha = 1;
      if (!isMe && dp.team !== me.team) {
        alpha = bushRevealAlpha(p);
        const hiddenNow = alpha <= 0.02;
        if (!hiddenNow && spotHidden[p.id]) spotStart[p.id] = performance.now(); // hidden -> spotted edge
        spotHidden[p.id] = hiddenNow;
        if (hiddenNow) continue;
      } else if (dp.team === me.team && inBushAt(dp.x, dp.y)) {
        alpha = 0.5; // you + teammates in a bush render translucent, so you know you're concealed
      }
      if (alpha < 1) { ctx.save(); ctx.globalAlpha = alpha; drawPlayer(dp); ctx.restore(); }
      else drawPlayer(dp);
      // "spotted!" pop when a bushed enemy is first revealed to me
      if (!isMe && dp.team !== me.team && spotStart[p.id]) {
        const el = (performance.now() - spotStart[p.id]) / 1000;
        if (el <= 0.6) drawSpottedCue(dp.x, dp.y, el); else delete spotStart[p.id];
      }
    }
    drawBall(ballDraw); // ball ON TOP of the bodies — always visible, even in a bush
    for (const pr of view.projectiles) drawProjectile(pr);
    for (const impact of view.impacts) drawImpact(impact);
    drawOffscreenBallArrow(view.ball);
  }
  ctx.restore(); // end the mirrored world

  drawSkyBands();  // cap the view: everything outside the play window stops being pitch

  // --- Blow the buffer up onto the display (nearest-neighbour = fat pixels) ---
  ctx = mainCtx;
  mainCtx.imageSmoothingEnabled = false;
  mainCtx.drawImage(worldBuf, 0, 0, wbW, wbH, 0, 0, canvas.width, canvas.height);
  drawHUD(); // HUD/overlays draw crisp, in full-res screen space
  // Chat bubbles draw HERE, not in the world loop: the world is rendered into a low-res buffer and
  // blown up x ART_PX with nearest-neighbour, so a word drawn there comes out chunky (user: "make the
  // player words appear as normal small text, currently it is also pixelated"). In this pass the
  // canvas is full device resolution, so the text is as crisp as the DOM HUD.
  if (chatBubbles.size) drawChatBubbles(view);
  drawCelebration(); // comic goal/win/lose word, on top of everything
  const specialCooling = performance.now() < specialCdUntil;
  specialBtn.classList.toggle('cooling', specialCooling);
  specialBtn.classList.toggle('ready', !specialCooling); // Brawl-style charged-Super pulse
  // Drag-back-to-centre CANCEL cue (Brawl): red frame + ✕ on the button being aimed.
  // Pump the machine per frame as well as per pointermove: a finger parked inside the cancel zone
  // emits no further move events, and the dwell still has to elapse for the ✕ to appear.
  // NOTE the ✕ trails the rule by CANCEL_DWELL_MS on purpose — releasing inside the zone always
  // cancels (releaseCancels), but the cue waits for the finger to settle so a thumb sweeping
  // across the centre to re-aim doesn't strobe it. That early release buzzes instead.
  if (bombDrag.active) pumpDragCancel(bombDrag);
  if (buildDrag.active) pumpDragCancel(buildDrag);
  specialBtn.classList.toggle('cancel-armed', bombDrag.active && !!bombDrag.cancelArmed);
  if (buildBtn) buildBtn.classList.toggle('cancel-armed', buildDrag.active && !!buildDrag.cancelArmed);
  // Radial cooldown ring: fills 0→1 as the bomb recharges; full when ready.
  { const cdMs = bombCdMs(); specialBtn.style.setProperty('--cd', specialCooling && cdMs > 0 ? 1 - (specialCdUntil - performance.now()) / cdMs : 1); }

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

// ===================== TUTORIAL — the scripted levels =====================
// docs/superpowers/specs/2026-07-27-tutorial-onboarding-design.md
//
// A SILENT coach for a kids' audience: no character, no dialogue, and the game never pauses.
// Per step it dims everything but the one live control, animates a hand doing the actual
// gesture, and prints 1-2 Hebrew words. The bar is that a child who cannot read Hebrew still
// finishes — the hand carries the lesson, the words only confirm it (Epic: "don't expect them
// to take the time to read").
//
//   LEVEL 1 · יסודות — move -> shoot -> goal -> super
//   LEVEL 2 · קרב    — shoot the ball -> bomb -> wall -> strip the carrier
//
// The STEP MACHINE is here, in the client, not on the server: a server-side one puts an RTT in
// front of every hint, so on a bad connection the hand points AFTER the kid already did the
// thing. The server owns only what the sim alone can do and reads the same level table we do.
// The rules themselves live in shared/tutorial.js so they unit-test.
const TU_DONE_KEY = 'fbTuDone';        // comma-separated ids of FINISHED levels
const TU_LEGACY_KEY = 'fbTutorialDone'; // the boolean the first ship wrote, kept in sync

// Which levels this player has finished. Migrates the old boolean: it could only ever have meant
// level 1, so that is exactly what it seeds.
function tuDoneSet() {
  try {
    const raw = localStorage.getItem(TU_DONE_KEY);
    if (raw != null) return new Set(raw.split(',').filter(Boolean));
    const s = new Set();
    if (localStorage.getItem(TU_LEGACY_KEY) === '1') s.add(TU_LEVELS[0].id);
    return s;
  } catch { return new Set(); }
}
function tuMarkDone(id) {
  const s = tuDoneSet(); s.add(id);
  try {
    localStorage.setItem(TU_DONE_KEY, [...s].join(','));
    localStorage.setItem(TU_LEGACY_KEY, '1'); // anything still reading the old flag stays right
  } catch { /* private mode */ }
}

let tuLvl = 0;           // which level is running
let tuStage = 0;         // 0..stepsIn(tuLvl)-1, then doneStage()
let tuStepT = 0;         // seconds inside the current step (drives the stuck-nudge)
let tuFinishAt = 0;      // performance.now() at which the finale card shows (0 = not pending)
let tuPrevT = 0;         // previous frame stamp, for the step machine's dt
let tuDoneAt = 0;        // when the current step first completed (0 = not yet) — drives minDwell
// Has the kid PRESSED the control this step is introducing? One-way per step, reset on every step
// change like every other per-step latch. It is the whole of the veil's off-switch: the screen dims
// only while a brand-new button is unused, and un-dims on the first press (not on the step being
// completed — see tuGate and tuRenderOverlay).
let tuIntroUsed = false;
// A stick this far off centre counts as "they moved". Not `> 0`: a resting thumb on a floating stick
// reads a pixel or two of drift, and un-dimming the screen before the kid has done anything would
// teach them nothing at all.
const TU_STICK_DEAD = 0.15;
// How long a tutorial goal's comic word stays up before it fades (seconds). Short on purpose: the
// coach advances ~TU_GOAL_HOLD (1s) after the goal, and the caption is suppressed while the word is
// on screen, so a match-length 2.3s hold would gag the NEXT lesson's instruction for over a second.
const TU_CELEB_SEC = 0.8;
// A blast that went off on top of ME, and where I was standing at the time. The fly step watches
// the pair: a blast under your feet followed by real distance covered IS a rocket jump, and it
// needs no new wire field to detect.
let tuSelfBlastAt = 0, tuSelfBlastPos = null;
// The pending shot, by gesture: performance.now() of a release under QUICK_CHARGE / at FULL_CHARGE,
// 0 for none. Each is half of one step's predicate — `quickHit` and the full-shot step's
// `chargedHit`. See releaseShot (the stamps) and the impact handler (the payoffs).
let tuQuickShotAt = 0, tuFullShotAt = 0;
// How long a stamp stays good. A bullet is bulletSpeed 720 x chargeMul for PROJECTILE.ttl (1.3s)
// and then expires — the TTL is the same whatever the charge, only the distance differs (~410px on
// a tap, ~936px fully charged), so ONE window serves both stamps. 2s covers the whole flight plus a
// bad phone's RTT and still cannot reach a shot from a later, separate press.
const TU_SHOT_HIT_MS = 2000;
let tuReplay = false;    // replay from אימון => a way out exists. A first run has none.
// One-way latches for events seen in the snapshot stream. Latched rather than sampled so a
// dropped frame cannot lose the goal (or the strip, or the blast) that completes a step.
// `quickShots` is the odd one out and is a TALLY, not a flag: level 1's tap step wants three quick
// releases and does not care where they land (shared/tutorial.js `needs`). It still resets with the
// rest of them on every step change, so a count can never leak into the next lesson.
const tuBlankEv = () => ({ hitEnemy: false, quickHit: false, quickShots: 0, overHeld: false, underHeld: false, chargedShot: false, chargedHit: false, scored: false, bombHitFoe: false, wallBuilt: false, stripped: false, foundFoe: false, flew: false });
let tuEv = tuBlankEv();

const tuEl = document.getElementById('tutorial');
const tuHandEl = document.getElementById('tu-hand');
const tuCapEl = document.getElementById('tu-cap');
const tuNudgeEl = document.getElementById('tu-nudge');
const tuPipsEl = document.getElementById('tu-pips');
const tuDoneEl = document.getElementById('tu-done');
const tuLevelsEl = document.getElementById('tu-levels');

// Which on-screen element a step's spotlight points at. move/aim are the sticks (their anchor
// moves with the controls editor); bomb/wall are fixed buttons.
const TU_SPOT_SEL = {
  bomb: '#special', wall: '#build',
  // LEVEL 4 (the hub tour). tuSpotRect below already resolves ANY selector via
  // getBoundingClientRect, so pointing the hand at hub furniture costs no new code.
  // `.hub-xpbar` rather than `#hub-xp`: renderHubXp() rebuilds #hub-xp's innerHTML on every poll,
  // so the BOX is the stable thing to point at, not its contents.
  // Steps 1-5 point at the tutorial's OWN mock lobby; only the finale points at the real hub.
  mockTrophies: '#tum-trophies', mockDeck: '#tum-deck', mockSlots: '#tum-slots',
  mockHero: '#tum-hero', mockFriends: '#tum-friends',
  hubPlay: '#quick-match-btn',
};
function tuSpotRect(which) {
  if (which === 'move' || which === 'aim') {
    const a = stickAnchor(which);
    return a ? { x: a.x, y: a.y, size: a.size } : null;
  }
  const el = document.querySelector(TU_SPOT_SEL[which] || '');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (!r.width) return null;
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, size: Math.max(r.width, r.height) };
}

// Launch a level. `replay` is the אימון entry: it leaves the exit button in place.
function startTutorial(level, replay) {
  tuReplay = !!replay;
  unlockAudio();
  // A HUB level has no room: no pitch to set up, nothing for the sim to own, and no server change
  // at all. It runs against the DOM, right here, driven by its own rAF.
  if (tuIsHub(level)) { tuHubEnter(level | 0, replay); return; }
  sendMsg({ type: 'tutorial', level: level | 0 });
}


// ---- LEVEL 4's MOCK LOBBY --------------------------------------------------------------
// The tour teaches on a lobby the tutorial draws itself, not on the live hub. That was a
// deliberate reversal: the first build ran on the real hub and a browser found four bugs in a row
// that all shared one root — the real hub is a moving target. The wardrobe turned out to be an
// overlay rather than a screen swap, the carousel auto-rotates and completed a step with no input
// at all, effectiveLoadout() pre-filled the slots so the drag step was already done on arrival,
// and localhost silently injects a sample album that hid the empty-album path completely. Three
// agents also change this hub daily, so a tour bound to its selectors breaks on someone else's
// schedule.
//
// A mock cannot drift out from under the lesson, and it removes the risk that actually mattered:
// with no real setSlotCard in the loop, a lesson card can never reach a kid's real cross-device
// loadout. The FINALE still points at the real ⚽ — see tuHubStepIsMock.
let tuMockEl = null;
let tuMockSel = null;      // which mock card the kid has picked up
const TU_MOCK_HEROES = ['🦸', '🧙', '🤖', '🐲'];
let tuMockHeroI = 0;

function tuMockBuild() {
  if (tuMockEl) return tuMockEl;
  const el = document.createElement('div');
  el.id = 'tu-mock';
  el.dir = 'rtl';
  el.innerHTML = `
    <div class="tum-stage">
      <div class="tum-top">
        <div id="tum-trophies" class="tum-trophies">
          <span class="tum-tro-ic">🏆</span>
          <span class="tum-tro-n">120</span>
          <span class="tum-tro-l">גביעים</span>
          <span class="tum-tro-bar"><b></b></span>
        </div>
        <button id="tum-friends" class="tum-side" type="button"><span>👥</span><b>חברים</b></button>
      </div>
      <div class="tum-mid">
        <button id="tum-hero" class="tum-hero" type="button"><span class="tum-hero-ic">🦸</span><b>הגיבור שלי</b></button>
        <div id="tum-deck" class="tum-deck">
          <button class="tum-card r-rare" type="button" data-c="0"><span>⚡</span></button>
          <button class="tum-card r-epic" type="button" data-c="1"><span>🔥</span></button>
          <button class="tum-card r-common" type="button" data-c="2"><span>🛡️</span></button>
        </div>
      </div>
      <div id="tum-slots" class="tum-slots">
        <div class="tum-slot" data-s="0"><span>+</span></div>
        <div class="tum-slot" data-s="1"><span>+</span></div>
        <div class="tum-slot" data-s="2"><span>+</span></div>
      </div>
      <div id="tum-friendrow" class="tum-friendrow hidden"><span>🙂 אורי</span><span>🙂 פז</span><span>🙂 נווה</span></div>
    </div>`;
  document.body.appendChild(el);
  tuMockEl = el;

  // Deck: tap a card to pick it up. Highlighted so a kid can SEE they are now holding something —
  // the drag step that follows is otherwise a mystery about what is being dragged.
  el.querySelectorAll('.tum-card').forEach((c) => {
    c.addEventListener('click', (e) => {
      e.stopPropagation();
      el.querySelectorAll('.tum-card').forEach((o) => o.classList.remove('tum-picked'));
      c.classList.add('tum-picked');
      tuMockSel = c;
      if (tuHubEv) tuHubEv.deckMoved = true;
    });
  });
  // Slots: drop a picked card in. Both a real DRAG and a tap work — the caption teaches the drag,
  // but a seven-year-old who taps instead must not be stuck on an unfailable step.
  const fillSlot = (sl) => {
    const src = tuMockSel || el.querySelector('.tum-card:not(.tum-used)');
    if (!sl || !src || sl.classList.contains('tum-full')) return false;
    sl.classList.add('tum-full');
    sl.innerHTML = src.innerHTML;
    src.classList.add('tum-used');
    src.classList.remove('tum-picked');
    tuMockSel = null;
    if (tuHubEv) tuHubEv.slotFilled = true;
    return true;
  };
  // A tap on the slot itself.
  el.querySelectorAll('.tum-slot').forEach((sl) => {
    sl.addEventListener('click', (e) => { e.stopPropagation(); fillSlot(sl); });
  });
  // A DRAG onto the slot. This has to hit-test the release point rather than listen on the slot:
  // a touch pointer keeps IMPLICIT CAPTURE on the element the gesture started on, so every
  // pointermove and the pointerup are delivered to the CARD — the slot never hears the drop, and
  // the step silently never completes. The real lobby's bindSlotDrag solves it the same way
  // (slotUnder via elementFromPoint), which is why it works there.
  el.addEventListener('pointerup', (e) => {
    if (!e.target.closest || !e.target.closest('.tum-card')) return;
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const sl = under && under.closest ? under.closest('.tum-slot') : null;
    if (sl) fillSlot(sl);
  });
  el.querySelector('#tum-hero').addEventListener('click', (e) => {
    e.stopPropagation();
    tuMockHeroI = (tuMockHeroI + 1) % TU_MOCK_HEROES.length;
    el.querySelector('.tum-hero-ic').textContent = TU_MOCK_HEROES[tuMockHeroI];
    if (tuHubEv) tuHubEv.heroTapped = true;
  });
  el.querySelector('#tum-friends').addEventListener('click', (e) => {
    e.stopPropagation();
    el.querySelector('#tum-friendrow').classList.remove('hidden');
    if (tuHubEv) tuHubEv.friendsTapped = true;
  });
  return el;
}

// Reset the mock to a clean lobby, so a replay does not start with the slots already filled.
function tuMockReset() {
  const el = tuMockBuild();
  tuMockSel = null; tuMockHeroI = 0;
  el.querySelector('.tum-hero-ic').textContent = TU_MOCK_HEROES[0];
  el.querySelector('#tum-friendrow').classList.add('hidden');
  el.querySelectorAll('.tum-card').forEach((c) => c.classList.remove('tum-used', 'tum-picked'));
  const glyphs = ['⚡', '🔥', '🛡️'];
  el.querySelectorAll('.tum-card').forEach((c, i) => { c.innerHTML = `<span>${glyphs[i]}</span>`; });
  el.querySelectorAll('.tum-slot').forEach((sl, i) => { sl.classList.remove('tum-full'); sl.innerHTML = '<span>+</span>'; sl.dataset.s = i; });
  return el;
}
function tuMockShow() { tuMockReset().classList.remove('hidden'); }
function tuMockHide() { tuMockEl?.classList.add('hidden'); }

// =====================================================================================
// LEVEL 4 · מרכז — the hub tour
// =====================================================================================
// Design: docs/superpowers/specs/2026-07-27-hub-tour-level4-design.md
//
// Same step machine, same hand, same captions, same nudge as the pitch levels. Two differences,
// both forced by the screen it runs on:
//   1) NO ROOM. There is no pitch, so there is nothing for the server to set up and nothing to
//      send it. startTutorial branches on `where` and never opens a socket for this level.
//   2) ITS OWN CLOCK. tuTick is driven by the match render loop, which does not run on the hub, so
//      this level ticks itself off requestAnimationFrame.
// Completion comes from one-way TAP latches instead of snapshot events, but isStepDone reads them
// generically (`!!ctx[s.done]`), so shared/tutorial.js needed no special-casing at all.
// tuHub / tuHubRunning() are declared up with the demo album — the write guards need them early.
// Deliberately NOT the global `tutorial` flag, which gates match input/render paths this level
// has no business in.
let tuHubRAF = 0;
let tuHubPrev = 0;
let tuHubEv = null;         // one-way latches, same contract as tuEv
const tuHubBlankEv = () => ({ sawTrophies: false, deckMoved: false, slotFilled: false,
  heroTapped: false, friendsTapped: false, played: false });
const tuOnHub = () => !!homeEl && !homeEl.classList.contains('hidden');
const tuHubStepIsMock = () => tuIsMockStep(tuLvl, tuStage);

// Whitelist the one live target so the gate CSS lets taps through to it.
// Applied on every STEP CHANGE, never per frame: re-deriving pointer-events every repaint is
// exactly the shape of the corner-tap bug (76686d6), where a tappable thing silently wasn't.
function tuHubMarkLive() {
  document.querySelectorAll('.tu-live').forEach((el) => el.classList.remove('tu-live'));
  const s = stepAt(tuLvl, tuStage);
  const sel = s && TU_SPOT_SEL[s.spotlight];
  if (!sel) return;
  const el = document.querySelector(sel);
  if (!el) return;
  el.classList.add('tu-live');
  // On the real hub the target sits INSIDE a box the gate dimmed, so whitelisting the element
  // alone would leave its own ancestor swallowing the tap.
  const box = el.closest('.hub > *');
  if (box) box.classList.add('tu-live');
}

function tuHubCtx() {
  // Every flag is now a plain latch off the mock's own controls — no composites, because nothing
  // in this lesson navigates away any more.
  return {
    ...tuHubEv,
    stepElapsed: tuStepT,
    sinceDone: tuDoneAt ? (performance.now() - tuDoneAt) / 1000 : 0,
  };
}

// The hub tour needs its OWN way out. The pitch levels dismiss with #leave-lobby-btn, which is a
// match control and is not on this screen — and the gate makes every other button inert, so
// without this a kid who wants to just play is trapped on a lesson. Built in JS rather than added
// to index.html: that file is shared with several other agents and this needs no markup from them.
let tuHubSkipEl = null;
function tuHubSkipBtn() {
  if (tuHubSkipEl) return tuHubSkipEl;
  const b = document.createElement('button');
  b.id = 'tu-hub-skip'; b.type = 'button'; b.textContent = 'דלג ✕';
  b.addEventListener('click', (e) => { e.stopPropagation(); tuHubSkip(); });
  document.body.appendChild(b);   // NOT inside #tutorial: the coach hides itself between steps,
                                  // and an exit that disappears with it is not an exit
  tuHubSkipEl = b;
  return b;
}
// Skipping is NOT finishing: the level stays ▶ in the picker so it can be taken properly later.
function tuHubSkip() {
  tuHubMarkSkipped();
  tuHubExit();
}
// Remember the offer was made, so auto-launch doesn't ambush them again on the next load. Separate
// from the done-set on purpose — «מרכז» must still read as unfinished in the 🎓 picker.
const TU_HUB_SKIP_KEY = 'fbTuHubSkipped';
function tuHubMarkSkipped() { try { localStorage.setItem(TU_HUB_SKIP_KEY, '1'); } catch { /* private mode */ } }
function tuHubWasSkipped() { try { return localStorage.getItem(TU_HUB_SKIP_KEY) === '1'; } catch { return false; } }

// The coach overlay LIVES INSIDE #game (index.html), because every level before this one ran on
// the pitch. On the hub, #game is display:none — so the hand, the caption, the pips and the veil
// were all rendered into a hidden subtree and a kid would have seen the mock lobby with no
// instructions on it whatsoever. Nothing in the DOM said so: #tutorial itself had no .hidden class
// and its textContent read correctly, which is why assertions on text passed while the screen was
// blank. Re-home it on <body> for the duration (.tutorial is position:fixed/inset:0, so it renders
// identically anywhere) and put it back exactly where it was on the way out.
let tuElHome = null;
function tuCoachToBody() {
  if (!tuEl || tuEl.parentElement === document.body) return;
  tuElHome = { parent: tuEl.parentElement, next: tuEl.nextSibling };
  document.body.appendChild(tuEl);
}
function tuCoachRestore() {
  if (!tuEl || !tuElHome) return;
  tuElHome.parent.insertBefore(tuEl, tuElHome.next);
  tuElHome = null;
}

function tuHubEnter(level, replay) {
  if (tuHub) return;
  tuLvl = Number.isInteger(level) && tuLevel(level) ? level : TU_HUB_LEVEL;
  tuStage = 0; tuStepT = 0; tuDoneAt = 0; tuFinishAt = 0;
  tuHub = true; tuReplay = !!replay;
  tuHubEv = tuHubBlankEv();
  tuEl?.classList.remove('celebrating');   // belt and braces: a goal word never happens on the hub,
                                           // and its class must never arrive here still set (tuExit)
  tuMockShow();                                    // the lesson happens on our OWN lobby
  tuCoachToBody();                                 // ...and the coach has to be able to draw on it
  document.body.classList.add('hub-tu-gate');
  tuDoneEl?.classList.add('hidden');
  tuEl?.classList.remove('hidden');
  const pips = stepsIn(tuLvl);
  if (tuPipsEl && tuPipsEl.childElementCount !== pips) {
    tuPipsEl.innerHTML = Array.from({ length: pips }, () => '<i></i>').join('');
  }
  tuHubSkipBtn().classList.remove('hidden');
  tuHubMarkLive();
  tuRenderOverlay();
  tuHubPrev = performance.now();
  if (!tuHubRAF) tuHubRAF = requestAnimationFrame(tuHubLoop);
}

function tuHubExit() {
  if (!tuHub) return;
  tuHub = false;
  if (tuHubRAF) { cancelAnimationFrame(tuHubRAF); tuHubRAF = 0; }
  document.body.classList.remove('hub-tu-gate');
  document.querySelectorAll('.tu-live').forEach((el) => el.classList.remove('tu-live'));
  tuHubSkipEl?.classList.add('hidden');
  tuEl?.classList.add('hidden');
  tuCoachRestore();
  tuMockHide();
}

function tuHubLoop(now) {
  if (!tuHub) { tuHubRAF = 0; return; }
  tuHubRAF = requestAnimationFrame(tuHubLoop);
  const dt = Math.min(0.25, Math.max(0, (now - tuHubPrev) / 1000));
  tuHubPrev = now;
  if (tuFinishAt) { if (now >= tuFinishAt) { tuFinishAt = 0; tuHubFinish(); } return; }
  if (isTutorialOver(tuLvl, tuStage)) return;

  // The lesson lives on our own lobby until the finale, which hands over to the real hub. Both are
  // on this screen, so there is no "away" state to freeze any more — that whole class of bug went
  // with the mock.
  const mock = tuHubStepIsMock();
  tuMockEl?.classList.toggle('hidden', !mock);
  // The coach rides above the MOCK, so during those steps it must show no matter what real screen
  // happens to be underneath. Gating it on #home alone hid the captions and the skip button behind
  // the mock — which a browser caught and no unit test could.
  tuEl?.classList.toggle('hidden', !(mock || tuOnHub()));
  tuStepT += dt;

  const s = stepAt(tuLvl, tuStage);
  // The trophy bar cannot be tapped at all: seeing it IS the step, and minDwell paces it. Every
  // other flag is latched by the mock's own controls (see tuMockBuild).
  if (s && s.done === 'sawTrophies') tuHubEv.sawTrophies = true;

  const ctx = tuHubCtx();
  if (!tuDoneAt && isStepDone(tuLvl, tuStage, ctx)) tuDoneAt = performance.now();
  const last = stepsIn(tuLvl) - 1;
  if (tuStage === last && isStepDone(tuLvl, tuStage, ctx)) {
    tuStage = doneStage(tuLvl); tuFinishAt = now + 350;
    tuRenderOverlay();
    return;
  }
  const next = advance(tuLvl, tuStage, ctx);
  if (next !== tuStage) {
    tuStage = next; tuStepT = 0; tuDoneAt = 0;
    const nowMock = tuHubStepIsMock();
    tuMockEl?.classList.toggle('hidden', !nowMock);
    // THE HANDOVER. fitHub() only runs at load and on resize, so the real hub can be carrying a
    // stale scale by the time the mock lets go of the screen — and it measurably was: the finale's
    // hand pointed at x=1457 in an 844px viewport, i.e. off-screen, so the one tap that ends the
    // tutorial could never be made. Re-fit before handing the screen back.
    if (!nowMock) fitHub();
    tuHubMarkLive();
    playSound('pickup', 0.5, 1.25);                // the same "yes, that" chime the pitch levels use
    haptic('goal');
  }
  // Re-rendered every frame on purpose: the hub is a scaled stage (fitHub) and the play strip
  // scrolls, so a target's rect is not static.
  tuRenderOverlay();
}

// The level ends on the ⚽ tap. The button's own handler has already started the match by the time
// this runs, so all that is left is to record the level and get the coach and the gate off screen —
// the kid is on their way into a real game, which IS the celebration.
function tuHubFinish() {
  const L = tuLevel(tuLvl);
  if (L) tuMarkDone(L.id);
  const play = tuHubEv && tuHubEv.played;
  tuHubExit();
  if (play) return;                                // already heading into a match
  tuDoneEl?.classList.remove('hidden');
  confettiBurst(120);
}

// The finale's tap is latched on POINTERDOWN, and deliberately NOT swallowed.
//
// An earlier version intercepted the click and re-launched the match itself after teardown. That
// existed to stop syncLoadout() pushing demo cards to the server — and the mock lobby deleted the
// demo album, so the whole reason is gone. Letting the real button do its own job is simpler, and
// it removes a failure mode that actually bit: the interception did not fire, so the match started
// while the tutorial still thought it was waiting, leaving the gate up and the level unrecorded.
// pointerdown is the signal the mock's own drag already proved reliable under real touch.
document.addEventListener('pointerdown', (e) => {
  if (!tuHub || !tuHubEv || !e.target.closest) return;
  if (e.target.closest('#quick-match-btn')) tuHubEv.played = true;
}, true);

// A test seam. The hub tour's whole state is module-local, so a browser check that "the level
// finished" can otherwise only infer it from side effects — which is how a stuck step machine
// reads as a passing test. _tu-hub-verify.mjs uses this to assert the machine itself.
window.__tuHubState = () => ({ on: tuHub, stage: tuStage, finishAt: tuFinishAt, ev: tuHubEv && { ...tuHubEv } });

// Called from enterMatch when the room is a tutorial room.
function tuEnter(level) {
  tuLvl = Number.isInteger(level) && tuLevel(level) ? level : 0;
  tuStage = 0; tuStepT = 0; tuFinishAt = 0; tuDoneAt = 0; tuIntroUsed = false;
  tuSelfBlastAt = 0; tuSelfBlastPos = null; tuQuickShotAt = 0; tuFullShotAt = 0;
  tuEv = tuBlankEv();
  tuDoneEl?.classList.add('hidden');
  tuEl?.classList.remove('hidden', 'celebrating');
  const pips = stepsIn(tuLvl);
  if (tuPipsEl && tuPipsEl.childElementCount !== pips) {
    tuPipsEl.innerHTML = Array.from({ length: pips }, () => '<i></i>').join('');
  }
  // A first run has NO way out — the whole point of an unskippable tutorial. A replay keeps its
  // exit, because a player who chose to revisit it has already proved they don't need trapping.
  document.getElementById('leave-lobby-btn')?.classList.toggle('tu-off', !tuReplay);
  tuSyncControls();
  tuRenderOverlay();
}

function tuExit() {
  tuEl?.classList.add('hidden');
  // `celebrating` (the caption stepping aside for a goal word) is toggled by tuTick, and tuTick stops
  // running the moment the level is over — so a level whose LAST step is a goal, which is level 1 and
  // level 3's shape, would leave it set. It has to come off here: the hub tour re-uses this very
  // element, and a stale class would hide its caption for the whole of level 4.
  tuEl?.classList.remove('celebrating', 'veiled');
  tuDoneEl?.classList.add('hidden');
  for (const id of ['special', 'build', 'stickR', 'leave-lobby-btn', 'hud', 'edit-controls-btn', 'chat-btn', 'pause-btn', 'banner']) {
    document.getElementById(id)?.classList.remove('tu-off');
  }
}

// Which controls physically exist right now. A button a step has not taught is hidden AND its
// input dropped (tuGate), so a kid cannot press something nobody explained. Level 1 never shows
// 💣 or 🧱 at all; level 2 introduces them one at a time.
function tuSyncControls() {
  document.getElementById('stickR')?.classList.toggle('tu-off', !tuHasControl(tuLvl, tuStage, 'aim'));
  document.getElementById('special')?.classList.toggle('tu-off', !tuHasControl(tuLvl, tuStage, 'bomb'));
  document.getElementById('build')?.classList.toggle('tu-off', !tuHasControl(tuLvl, tuStage, 'wall'));
}

// Zero every input a step has not unlocked. The server does not police this — it does not need
// to; a solo, endless, reward-free room has nothing worth cheating for.
function tuGate(inp) {
  if (!tuHasControl(tuLvl, tuStage, 'move')) { inp.moveX = 0; inp.moveY = 0; }
  if (!tuHasControl(tuLvl, tuStage, 'aim')) { inp.hold = false; inp.fire = false; inp.aimed = false; }
  if (!tuHasControl(tuLvl, tuStage, 'bomb')) { inp.special = false; inp.sax = 0; inp.say = 0; }
  if (!tuHasControl(tuLvl, tuStage, 'wall')) { inp.build = false; inp.buildHold = false; inp.buildDist = 0; }
  // ...and while we have the kid's actual gesture in hand: did they just USE the control this step is
  // introducing? That is the veil's off-switch, and this is the only place in the client where the
  // real input lives, so it is latched here rather than reconstructed from a snapshot.
  // Read AFTER the gate above, deliberately: a stray tap on a button this step never taught has just
  // been zeroed, so it can never be the thing that clears the veil.
  // On the FIRST PRESS, not on the step completing — «when a player click the new button dark screen
  // disapears». For 🧱 the hold counts (buildHold is live for the whole drag); 💣 has no held state in
  // this client, so its edge (`special`, queued on release) is the earliest honest signal there is.
  if (!tuIntroUsed) {
    for (const c of introducesFor(tuLvl, tuStage)) {
      if (c === 'move' && Math.hypot(inp.moveX, inp.moveY) > TU_STICK_DEAD) tuIntroUsed = true;
      else if (c === 'aim' && (inp.hold || inp.fire || inp.aimed)) tuIntroUsed = true;
      else if (c === 'bomb' && inp.special) tuIntroUsed = true;
      else if (c === 'wall' && (inp.build || inp.buildHold)) tuIntroUsed = true;
    }
  }
  return inp;
}

// The live position of a step's marked foe, straight from the snapshot. Resolved by id prefix
// (the server names them `<key>-<roomId>`), so the marker tracks a foe that has been shoved,
// bombed or has walked into its goal — a fixed world point would drift off them.
function tuFoeSnap(key) {
  if (!latest || !key) return null;
  return (latest.players || []).find((q) => q.id && q.id.indexOf(`${key}-`) === 0) || null;
}
function tuFoePos(key) {
  const p = tuFoeSnap(key);
  return p ? { x: p.x, y: p.y } : null;
}

const tuCtx = () => ({
  px: rendered ? rendered.x : (predicted ? predicted.x : 0),
  py: rendered ? rendered.y : (predicted ? predicted.y : 0),
  ...tuEv,
  stepElapsed: tuStepT,
  sinceDone: tuDoneAt ? (performance.now() - tuDoneAt) / 1000 : 0,
});

// One step of the machine, per rendered frame.
function tuTick(dt) {
  if (!tutorial) return;
  if (tuFinishAt) { if (performance.now() >= tuFinishAt) { tuFinishAt = 0; tuFinish(); } return; }
  if (isTutorialOver(tuLvl, tuStage)) return;

  // The goal word owns the middle of the screen for its beat, and the caption sits in the same
  // place — so the caption steps aside for it (styled in style.css) rather than being drawn under a
  // starburst. Toggled up here, ABOVE the freeze return below, because the whole of the word's beat
  // happens inside that freeze; anywhere lower and the class would never go on.
  tuEl?.classList.toggle('celebrating', !!celeb);

  // The FINAL step of a level ends it. Don't sit out the kickoff reset first — let the
  // celebration play for a beat, then the finale card.
  if (tuStage === stepsIn(tuLvl) - 1 && isStepDone(tuLvl, tuStage, tuCtx())) {
    tuStage = doneStage(tuLvl); tuFinishAt = performance.now() + 1600;
    tuRenderOverlay();
    return;
  }
  // Mid-level goal reset: freeze the coach so the goal badge has the screen to itself, and so the
  // step timer doesn't bank idle seconds and fire a stuck-nudge the moment play resumes. The room
  // clamps that freeze to TU_GOAL_HOLD (1s) for a tutorial, so this is now a one-second beat and no
  // longer the five dead seconds it used to sit out — see updateTutorial in server.js. The coach
  // still waits for the freeze to END rather than racing it: the next stage's setup would otherwise
  // land on a body the sim is still holding still.
  if (latest && latest.resetTimer > 0) return;

  tuStepT += dt;
  // Two flags are sampled here rather than latched off a snapshot event, because they are about a
  // SIGHTING and a MOVEMENT, not a moment: spotting the foe in the bush, and having been thrown by
  // your own blast. Once true they stay true for the step, like every other flag.
  //
  // foundFoe asks the RENDERER's own stealth function rather than measuring a distance, so what
  // completes the step is exactly what the kid can see: bushRevealAlpha is the same value the foe
  // is drawn at, and 0.6 is comfortably past the fade-in — a sprite that faint is a hint, not a
  // sighting, and the step should not tick over on something the kid would not swear they saw.
  const st = stepAt(tuLvl, tuStage);
  if (st && st.done === 'foundFoe' && !tuEv.foundFoe && rendered) {
    const foe = tuFoeSnap(st.findKey);
    if (foe && inBushAt(foe.x, foe.y) && bushRevealAlpha(foe) >= 0.6) tuEv.foundFoe = true;
  }
  if (rendered && tuSelfBlastAt && !tuEv.flew) {
    const age = performance.now() - tuSelfBlastAt;
    if (age > 1600) { tuSelfBlastAt = 0; tuSelfBlastPos = null; }
    else if (tuSelfBlastPos && Math.hypot(rendered.x - tuSelfBlastPos.x, rendered.y - tuSelfBlastPos.y) > 260) tuEv.flew = true;
  }
  // The over-hold correction is sampled here for the same reason: it is about a charge that is
  // STILL GROWING under the kid's thumb, and it has to be answered while the thumb is down — not
  // on release, by which time the mistake is over and the ring has already emptied. Only a step
  // that ASKS for the correction watches for it (st.fixWhen), so the charge step, whose whole
  // lesson is the hold, can never trip it.
  if (st && st.fixWhen === 'overHeld' && !tuEv.overHeld && holding && currentCharge() >= QUICK_CHARGE) tuEv.overHeld = true;
  // minDwell: remember WHEN the step completed, so advance() can hold it open afterwards.
  if (!tuDoneAt && isStepDone(tuLvl, tuStage, tuCtx())) tuDoneAt = performance.now();
  const next = advance(tuLvl, tuStage, tuCtx());
  if (next !== tuStage) {
    tuStage = next; tuStepT = 0; tuDoneAt = 0; tuIntroUsed = false;
    tuSelfBlastAt = 0; tuSelfBlastPos = null; tuQuickShotAt = 0; tuFullShotAt = 0;
    tuEv = tuBlankEv();
    sendMsg({ type: 'tuStage', n: tuStage });   // server sets the pitch up for the new step
    tuSyncControls();
    playSound('pickup', 0.5, 1.25);             // a small "yes, that" chime between steps
    haptic('goal');
  }
  tuRenderOverlay();
}

// Position the spotlight + hand over the live control and print this step's words.
function tuRenderOverlay() {
  if (!tuEl) return;
  if (isTutorialOver(tuLvl, tuStage)) { tuEl.classList.add('hidden'); return; }
  const s = stepAt(tuLvl, tuStage);
  if (!s) return;
  // The spotlight tracks the control's REAL position, so a stick the player moved or resized in
  // the controls editor keeps its hand pointing at the right place.
  const a = s.spotlight ? tuSpotRect(s.spotlight) : null;
  // THE VEIL — the dark screen — and the whole rule for it, reported from a phone: it appears ONLY on
  // a step that hands the kid a control they have never had (introducesFor: move, aim, bomb, wall —
  // four steps in the entire tutorial), and it goes the instant they press that control, for the rest
  // of the step. Before this it was up on every step of every level, which dimmed half the tutorial
  // for a kid who already knew how to walk, and kept dimming it after they had found the right button.
  // Everything else the coach does is untouched and still runs on every step: the pointing hand, the
  // caption, the second line, the pips. Only the DIMMING is conditional now.
  // `no-spot`'s even dim went with it. That was the dim used by the steps pointing at the GRASS
  // rather than at a button, and under the new rule those steps introduce nothing — no veil means no
  // veil, so the class stopped having anything to say. (The rect is still what the HAND is positioned
  // from, below; only the veil stopped caring.)
  // A HUB step (level 4) keeps the veil it has always had, and is the one exemption. That level's
  // whole subject is the furniture it points at — a trophy bar, a deck, three power slots — so every
  // one of its steps IS introducing something the kid has never seen, and the dim is the second half
  // of a look its own gate already starts (.hub-tu-gate greys the lobby). Nothing about the hub was
  // reported; leaving it alone is deliberate, not an oversight.
  const introducing = !tuIntroUsed && introducesFor(tuLvl, tuStage).length > 0;
  tuEl.classList.toggle('veiled', !!a && (tuIsHub(tuLvl) || introducing));
  if (a) {
    tuEl.style.setProperty('--tu-x', `${Math.round(a.x)}px`);
    tuEl.style.setProperty('--tu-y', `${Math.round(a.y)}px`);
    tuEl.style.setProperty('--tu-r', `${Math.round(a.size * 0.95)}px`);
  }
  tuHandEl.className = `tu-hand gest-${s.gesture}`;
  tuHandEl.style.display = a ? '' : 'none';
  const cap = captionFor(tuLvl, tuStage, tuCtx());
  if (tuCapEl.textContent !== cap) tuCapEl.textContent = cap;   // reassigning restarts the pop
  // ONE second line, decided by two pure functions and never by this file. showNudge() says
  // whether the line is escalated at all — either the kid has gone quiet past `nudgeAfter`, or
  // they just made the mistake the step is watching for (`fixWhen`, which does not wait). If it
  // is, nudgeFor() picks between the correction and the stuck-hint; if it isn't, subFor() picks
  // between the step's standing `sub` (how the control works) and its `sub2` (the payoff, once
  // `when` has latched — «גם אתה יכול להתחבא שם» the moment they spot the foe in the bush).
  // A kid who is doing fine is told what the button does; a kid who isn't is told what to fix;
  // a kid who just succeeded is told what it MEANT. The 'nudging' class styles all of that the
  // same way on purpose: the correction is the same "look here" beat as the hint, not a scold.
  const nudging = showNudge(tuLvl, tuStage, tuCtx());
  tuEl.classList.toggle('nudging', nudging);
  const second = nudging ? nudgeFor(tuLvl, tuStage, tuCtx()) : subFor(tuLvl, tuStage, tuCtx());
  if (tuNudgeEl.textContent !== second) tuNudgeEl.textContent = second;
  tuNudgeEl.classList.toggle('hidden', !second);
  const pips = tuPipsEl ? tuPipsEl.children : [];
  for (let i = 0; i < pips.length; i++) {
    pips[i].className = i < tuStage ? 'done' : i === tuStage ? 'on' : '';
  }
}

// The one world-space cue for this step, drawn on the pitch under the players. Called from
// renderFrame INSIDE the mirrored world transform, so wx/wy/ws_ apply as they do everywhere else.
function tuDrawWorld() {
  if (!tutorial || isTutorialOver(tuLvl, tuStage)) return;
  const s = stepAt(tuLvl, tuStage);
  if (!s) return;
  const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 260);
  // A step may name more than one cue (markersFor), drawn in the order it lists them so a step can
  // decide what sits on top: the ball-shot step draws its goal arrow first and the ball's chevron
  // over it. One shared pulse, so two cues on the same pitch breathe together instead of beating
  // against each other.
  for (const m of markersFor(s)) tuDrawCue(m, s, pulse);
}
function tuDrawCue(m, s, pulse) {
  if (m === 'ring') {
    // Walk here. A ring on the grass reads as a destination in every game a kid has played.
    const r = ws_(TU_RING.r) * (0.92 + 0.08 * pulse);
    ctx.save();
    ctx.lineWidth = Math.max(2, ws_(9));
    ctx.strokeStyle = `rgba(255,208,106,${0.55 + 0.35 * pulse})`;
    ctx.beginPath(); ctx.arc(wx(TU_RING.x), wy(TU_RING.y), r, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = `rgba(255,208,106,${0.10 + 0.08 * pulse})`; ctx.fill();
    ctx.restore();
  } else if (m === 'foe' || m === 'ball') {
    // Hit THIS. A bobbing chevron over the target, not a ring — a ring on a body would read as
    // "stand here", which is a different instruction the kid has already been given once.
    const at = m === 'ball'
      ? (latest ? { x: latest.ball.x, y: latest.ball.y } : null)
      : tuFoePos(s.markerKey);
    if (at) tuChevron(at.x, at.y, pulse);
  } else if (m === 'wallspot') {
    // A dashed outline the exact size of a built wall, standing where it should go. Showing the
    // placement beats describing it, and it gives the kid something to aim the drag at.
    const spot = TU2_WALL.spot;
    ctx.save();
    ctx.setLineDash([Math.max(3, ws_(14)), Math.max(3, ws_(10))]);
    ctx.lineWidth = Math.max(2, ws_(7));
    ctx.strokeStyle = `rgba(255,208,106,${0.55 + 0.35 * pulse})`;
    ctx.strokeRect(wx(spot.x) - ws_(BUILT_WALL.thick) / 2, wy(spot.y) - ws_(BUILT_WALL.len) / 2,
                   ws_(BUILT_WALL.thick), ws_(BUILT_WALL.len));
    ctx.restore();
    ctx.save();
    ctx.setLineDash([]);
    ctx.restore();
  } else if (m === 'aimline') {
    // WHERE TO POINT THE STICK — the one thing a kid cannot read off a mark lying on the grass. A
    // ghost of the shot itself: it leaves the kid's body, passes through the ball, and carries on the
    // SAME line until it runs off the pitch, which — when the three of them are lined up — is dead in
    // the goal mouth.
    // Extending the AIM rather than bending the line toward the goal is what makes it honest: a
    // bullet shoves the ball along the bullet's own line (MECHANICS §2), so a kid standing off the
    // lane watches the far end climb into the side netting, and lining it up again is what drops it
    // back into the mouth. A ghost that hooked into the goal from wherever they stood would be
    // promising a shot the sim will not play.
    // Anchored to `rendered` and the SNAPSHOT ball, never to TU2_SHOOT: the kid can walk, and the
    // ball leaves the moment they hit it, so a line drawn from the stage's literals would be lying
    // within a second of the step starting.
    if (!rendered || !latest) return;
    const dx = latest.ball.x - rendered.x, dy = latest.ball.y - rendered.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 40) return;   // ball at their feet: there is a body there, not a line
    // Gone the instant the step is satisfied. The 5s goal freeze that follows is the kid's to watch
    // the ball sitting in the net with; a hint still telling them to shoot it is noise on a job done.
    if (isStepDone(tuLvl, tuStage, tuCtx())) return;
    const ux = dx / dist, uy = dy / dist;
    // Ride the ray out to the first pitch edge it meets — the goal line ahead, or a touchline if
    // they are aiming off. Clipping instead of using a fixed length is what lets the far end be the
    // feedback: it lands in the mouth only when the aim actually scores.
    const hits = [];
    if (ux > 1e-3) hits.push((TU_GOAL.x - rendered.x) / ux);
    if (uy > 1e-3) hits.push((FIELD.H - rendered.y) / uy);
    if (uy < -1e-3) hits.push(-rendered.y / uy);
    const len = hits.length ? Math.min(...hits) : dist + 300;
    const off = 26;          // world px: clear of a 21px body, so the line does not stab the sprite
    if (len <= off) return;
    const d1 = Math.max(2, ws_(10)), d2 = Math.max(2, ws_(10));
    ctx.save();
    ctx.globalAlpha = 0.26 + 0.18 * pulse;
    ctx.strokeStyle = '#ffd06a';
    // THIN, and the floor is 1px, not 2. This is the thinnest stroke in the coach layer on purpose:
    // the bomb's ghost trajectory — the closest existing "this is only a hint" line — is ws_(3), the
    // goal arrow is ws_(22), and the user's word for what this should be was "thin". Anything with
    // heft reads as an object lying on the pitch, which is the failure the arrow already had.
    ctx.lineWidth = Math.max(1, ws_(2.5));
    ctx.lineCap = 'butt';                  // square ends keep short dashes from fattening into pills
    ctx.setLineDash([d1, d2]);
    // The dashes CRAWL toward the goal. Every other dashed thing this client draws is STATIC and
    // means "an object goes here" (the wall ghost, the bomb's blast ring), so movement is what keeps
    // a dashed line lying across the pitch from reading as one more thing in the way.
    ctx.lineDashOffset = -((performance.now() / 20) % (d1 + d2));
    ctx.beginPath();
    ctx.moveTo(wx(rendered.x + ux * off), wy(rendered.y + uy * off));
    ctx.lineTo(wx(rendered.x + ux * len), wy(rendered.y + uy * len));
    ctx.stroke();
    ctx.restore();
  } else if (m === 'bush') {
    // Outline the bush and drop a chevron on it. The bush already renders as scenery; this says
    // "that one, go in it".
    const b = TU3_BUSH;
    ctx.save();
    ctx.lineWidth = Math.max(2, ws_(9));
    ctx.strokeStyle = `rgba(255,208,106,${0.5 + 0.35 * pulse})`;
    ctx.strokeRect(wx(b.x), wy(b.y), ws_(b.w), ws_(b.h));
    ctx.restore();
    tuChevron(b.x + b.w / 2, b.y + b.h / 2, pulse);
  } else if (m === 'goal') {
    // Kick it there. A fat arrow along the shot lane into the mouth of the goal.
    const y = wy(TU_GOAL.y), x0 = wx(TU_GOAL.x - 620), x1 = wx(TU_GOAL.x - 90);
    ctx.save();
    ctx.globalAlpha = 0.42 + 0.28 * pulse;
    ctx.strokeStyle = '#ffd06a'; ctx.lineWidth = Math.max(3, ws_(22)); ctx.lineCap = 'butt';
    ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1 - ws_(60), y); ctx.stroke();
    ctx.fillStyle = '#ffd06a';
    ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(x1 - ws_(70), y - ws_(46)); ctx.lineTo(x1 - ws_(70), y + ws_(46)); ctx.closePath(); ctx.fill();
    ctx.restore();
  }
}
// A downward chevron bobbing over a world point.
function tuChevron(wxx, wyy, pulse) {
  const bob = ws_(10) * pulse;
  const x = wx(wxx), y = wy(wyy) - ws_(120) - bob, w = ws_(30);
  ctx.save();
  ctx.fillStyle = `rgba(255,208,106,${0.7 + 0.3 * pulse})`;
  ctx.beginPath(); ctx.moveTo(x - w, y); ctx.lineTo(x + w, y); ctx.lineTo(x, y + w * 1.2); ctx.closePath(); ctx.fill();
  ctx.restore();
}

// Level finished. Celebration only — no XP, no trophies, no cards (c86fa82: practice pays nothing).
function tuFinish() {
  const L = tuLevel(tuLvl);
  if (L) tuMarkDone(L.id);
  tuEl?.classList.add('hidden');
  const nxt = nextLevel(tuDoneSet());
  const nextBtn = document.getElementById('tu-next-btn');
  if (nextBtn) {
    // A kid on a roll should never have to go and find a menu.
    const has = nxt != null && nxt !== tuLvl;
    nextBtn.classList.toggle('hidden', !has);
    if (has) { nextBtn.textContent = `המשך ל${tuLevel(nxt).name} ›`; nextBtn.dataset.level = String(nxt); }
  }
  const t = document.getElementById('tu-done-title');
  if (t) t.textContent = nxt == null ? 'אתה מוכן!' : 'כל הכבוד!';
  tuDoneEl?.classList.remove('hidden');
  confettiBurst(120);
}

document.getElementById('tu-done-btn')?.addEventListener('click', () => {
  tuDoneEl?.classList.add('hidden');
  leaveToLobby();
});
document.getElementById('tu-next-btn')?.addEventListener('click', (e) => {
  const n = Number(e.currentTarget.dataset.level || 0);
  tuDoneEl?.classList.add('hidden');
  startTutorial(n, tuReplay);
});

// ---- The level picker -----------------------------------------------------------------
// אימון → 🎓 איך משחקים? opens this. Rendered from TU_LEVELS, so level 3 needs no UI work.
function renderTuLevels() {
  if (!tuLevelsEl) return;
  const done = tuDoneSet();
  const list = tuLevelsEl.querySelector('.tu-lv-list');
  if (!list) return;
  // Only OFFERED levels. Mapping over the whole table is what put the parked hub tour in this menu,
  // and the index has to survive the filter — it IS the level id everywhere else — so the filter runs
  // on entries, not on the array. Empty rows are dropped rather than rendered as a gap.
  list.innerHTML = TU_LEVELS.map((L, i) => {
    if (!tuOffered(i)) return '';
    const open = tuUnlocked(i, done);
    const fin = done.has(L.id);
    const badge = fin ? '⭐' : open ? '▶' : '🔒';
    return `<button class="tc-opt tu-lv${open ? '' : ' locked'}" data-level="${i}"${open ? '' : ' aria-disabled="true"'}>`
      + `<b>${badge} ${L.ic} ${L.name}</b><small>${open ? L.sub : 'סיימו את השלב הקודם'}</small></button>`;
  }).join('');
}
tuLevelsEl?.querySelector('.tu-lv-list')?.addEventListener('click', (e) => {
  const b = e.target.closest('.tu-lv');
  if (!b) return;
  const i = Number(b.dataset.level || 0);
  if (!tuUnlocked(i, tuDoneSet())) { toast('סיימו קודם את השלב הקודם'); return; }
  tuLevelsEl.classList.add('hidden');
  startTutorial(i, true);   // anything reached from the menu is a replay: it keeps its exit
});
document.getElementById('tu-lv-cancel')?.addEventListener('click', () => tuLevelsEl?.classList.add('hidden'));

// אימון → 🎓 איך משחקים? — unconditional: the done-set gates the AUTO-launch, never access.
document.getElementById('tc-howto')?.addEventListener('click', () => {
  document.getElementById('train-choose')?.classList.add('hidden');
  renderTuLevels();
  tuLevelsEl?.classList.remove('hidden');
});

// FIRST RUN: level 1 unfinished => it is what the app opens into, and there is no skip. Fired
// once the socket has answered `welcome`, so the room request cannot race the connection.
// Only LEVEL 1 ever auto-launches; every later level is offered, never forced.
function tuMaybeAutoStart() {
  if (tutorial || tuHubRunning()) return;
  if (!homeEl || homeEl.classList.contains('hidden')) return; // only from a cold start on the hub
  // THE LOBBY TOUR COMES FIRST (public/hub-tour.js). A brand-new player's first screen IS the hub, so
  // the screen gets explained before they are dropped onto a pitch. It hands the floor straight back
  // when it finishes OR is skipped — this same function, which then starts level 1 — so the pitch
  // tutorial follows the lobby tour rather than racing it.
  // Its own two localStorage keys decide whether it is pending; nothing about the level table or the
  // 🎓 picker is involved, and level 4 «מרכז» stays parked (`offered: false`) as it was.
  if (window.HubTour?.pending() && window.HubTour.begin(tuMaybeAutoStart)) return;
  const done = tuDoneSet();
  // LEVEL 1: the app opens into it, and there is no skip.
  if (!done.has(TU_LEVELS[0].id)) { startTutorial(0, false); return; }
  // ...and that is the ONLY auto-launch now. The hub tour used to fire here on a kid's first arrival
  // at the lobby; it is parked (`offered: false`, shared/tutorial.js), so the branch that started it
  // is gated on tuOffered below rather than deleted — the tour still works, it is just not shown.
  // LEVEL 4 (the hub tour): the first time a kid actually REACHES the hub, which is the moment it
  // is about. The only other level that ever auto-runs, and unlike level 1 it is SKIPPABLE — a
  // brand-new player has nothing else to do yet, but a kid standing on the hub does. Passing
  // replay:true is what keeps the exit alive; tuReplay means "a way out exists", which is exactly
  // what is wanted here, so it is not a lie about provenance.
  const hub = TU_LEVELS[TU_HUB_LEVEL];
  if (hub && tuOffered(TU_HUB_LEVEL) && !done.has(hub.id) && !tuHubWasSkipped() && tuUnlocked(TU_HUB_LEVEL, done)) startTutorial(TU_HUB_LEVEL, true);
}

// ===================== FIELD BUILDER (self-contained DOM editor) =====================
// Place bushes / rotatable hard walls / dry walls on a scaled pitch, save to localStorage,
// then "Play" launches a vs-bots match on that field (server type:'builderMatch').
const FB_KEY = 'pikme-field-v1';
// The pitch currently being AUTHORED. Its size is a named record (shared/field-sizes.js) that
// travels INSIDE the saved field, so a layout can never be reopened at dimensions it wasn't drawn
// for. FB_W/FB_H are `let` and follow the active size — every derived read (fbToWorld, the percent
// transform, the joint SVG viewBox, the mirror) picks the new numbers up on the next fbRender().
let fbSizeId = DEFAULT_SIZE;
let FB_W = sizeOf(fbSizeId).W, FB_H = sizeOf(fbSizeId).H;
const FB_WALL = { hl: 88, ht: 16 };   // half-thickness 16 → thin wall (thick 32), same as before. Literal (not FB_GRID/2) to avoid a TDZ if declaration order shifts.
// Steel-wall corner joint style: 'square' = filled mitre corner, 'round' = disc. Both gapless/no-"+".
// Literal-returning IIFE (references no later const) so it can't hit a TDZ wherever it lands.
// Corner style is NOT a session setting any more. It was one localStorage flag applied to every
// corner of every field, chosen before the author had drawn a single wall (project owner, 2026-07-27:
// corners should build themselves; the choice belongs on the corner you selected). Each corner now
// auto-styles from its own angle and stores an override on the FIELD (`fbField.joints`) when the
// author overrides it — so it travels with the field, into the match, and through undo.
// Rule + key format: shared/joint-style.js. Old 'pikme-joint-style' values are simply ignored.
const FB_BUSH = { w: 224, h: 160 };
const FB_GRID = 50;                          // fine grid cell — snap + overlay. Cell COUNT is per-size (s2v2 40x22, sBig 52x30, sHuge 58x34); every size is a whole, even number of cells on both axes so the centre line stays a junction and mirroring is exact.
const fbSnap = (v) => Math.round(v / FB_GRID) * FB_GRID;            // snaps to grid JUNCTIONS (cell corners)
const fbSnapCell = (v) => Math.floor(v / FB_GRID) * FB_GRID + FB_GRID / 2; // snaps to CELL CENTRES (the box grid) — used for walls so they line up with crates
let fbField = { version: 4, size: DEFAULT_SIZE, bushes: [], hardWalls: [], dryWalls: [], crates: [], spawns: [], ball: null, joints: {} };
let fbTool = null;   // 'bush' | 'hard' | 'dry' | 'crate' | 'spawn' | 'ball' | null (placement tool)
let fbSel = null;    // { type, i } selected element, or { type:'joint', key } for a corner | null
let fbLiveJoints = []; // last rendered corners (derived, not stored) — the selection + prune read this
let fbDrag = null;   // active pointer drag
const fbPit = () => document.getElementById('builder-pitch');
// MARKERS (start slots + the ball) are not geometry: nothing collides with them, so they stay out of
// the overlap groups. The ball is a single point in the data model (the sim wants one spot, not a
// list), and is exposed here as a 0-or-1 array holding the LIVE object — so the generic select/move
// code mutates the real ball through it. Only delete needs to know the difference (fbDeleteEl).
const fbList = (t) => (t === 'bush' ? fbField.bushes : t === 'hard' ? fbField.hardWalls : t === 'crate' ? fbField.crates
  : t === 'spawn' ? fbField.spawns : t === 'ball' ? (fbField.ball ? [fbField.ball] : []) : fbField.dryWalls);
const FB_MARKER = (t) => t === 'spawn' || t === 'ball';
// THE one place a builder field object is constructed. Every rebuild path goes through it —
// load, undo/redo restore, clear-all, and the saved-field library's normalizer — because the
// bug this replaces was three separate `{ version: 1, ... }` literals that each silently DROPPED
// the size, so a big pitch came back as a 2000x1100 one with its elements still out at x=2500.
// A field with no `size` was drawn before sizes existed, so it IS s2v2. Never rescale it.
// v3 adds `spawns` (start slots) + `ball` (kickoff spot). A v1/v2 save simply has neither, which is
// exactly "this field doesn't declare a formation" — the sim then runs its formula, unchanged.
// version 4 adds `joints` — per-corner style overrides. Every earlier field (1/3, and the built-in
// presets) simply has none, which means "every corner auto-styles", i.e. exactly how they looked
// before. Nothing to migrate: absence IS the old behaviour.
function fbNorm(j, sizeId) {
  const size = sizeOf(sizeId != null ? sizeId : (j && j.size)).id;
  const rawJoints = j && j.joints && typeof j.joints === 'object' && !Array.isArray(j.joints) ? j.joints : {};
  const joints = {};
  // Keep only the two real looks. A junk value must not survive a load, or it would resolve to AUTO
  // for evermore while still occupying a key that prune() then treats as a deliberate choice.
  for (const k of Object.keys(rawJoints)) if (rawJoints[k] === 'square' || rawJoints[k] === 'round') joints[k] = rawJoints[k];
  return {
    version: 4, size,
    bushes: (j && j.bushes) || [], hardWalls: (j && j.hardWalls) || [], dryWalls: (j && j.dryWalls) || [], crates: (j && j.crates) || [],
    spawns: (j && Array.isArray(j.spawns)) ? j.spawns : [],
    ball: (j && j.ball && typeof j.ball === 'object') ? { x: +j.ball.x, y: +j.ball.y } : null,
    joints,
  };
}
function fbLoad() { try { const j = JSON.parse(localStorage.getItem(FB_KEY)); if (j && j.version) return fbNorm(j); } catch (e) {} return fbNorm(null, DEFAULT_SIZE); }
function fbSave() {
  // Drop overrides whose corner no longer exists. Deleting or moving a wall orphans its corner
  // silently, and a stale key would later be inherited by a DIFFERENT corner that happens to land on
  // the same junction — a style the author never chose for it. fbLiveJoints is what was last drawn.
  if (fbField.joints && Object.keys(fbField.joints).length && fbLiveJoints.length) {
    fbField.joints = pruneJointOverrides(fbField.joints, new Set(fbLiveJoints.map((j) => j.key)));
  }
  try { localStorage.setItem(FB_KEY, JSON.stringify(fbField)); } catch (e) {}
}

// --- Arena SIZE (shared/field-sizes.js) -----------------------------------------------------
// Would anything currently placed fall outside `size`? Used to refuse a SHRINK rather than
// silently clamping or deleting a player's work — the one rule the size design never breaks is
// that authored coordinates are never rewritten behind the author's back.
function fbOutOfBounds(size) {
  const over = (x, y) => x < 0 || y < 0 || x > size.W || y > size.H;
  for (const b of [...fbField.bushes, ...fbField.crates]) if (over(b.x, b.y) || over(b.x + b.w, b.y + b.h)) return true;
  for (const w of [...fbField.hardWalls, ...fbField.dryWalls]) for (const p of fbEnds(w)) if (over(p.x, p.y)) return true;
  // Markers count: a shrink that left a start slot or the ball outside the pitch would spawn a
  // player in the void, and the server would silently clamp it somewhere the author never chose.
  for (const s of [...fbField.spawns, ...(fbField.ball ? [fbField.ball] : [])]) if (over(s.x, s.y)) return true;
  return false;
}
// Point the builder at a size. `keep` = only re-sync the view to the field's existing size (used by
// undo/redo and open), so it neither mutates the field nor pushes a history entry.
// Growing is always allowed; shrinking is refused while anything sits outside the smaller pitch.
function fbApplySize(id, { keep = false } = {}) {
  const size = sizeOf(id);
  if (!keep && size.id !== fbField.size && fbOutOfBounds(size)) {
    fbFlash(`יש אלמנטים מחוץ למגרש ${size.name} — הזיזו או מחקו אותם קודם`);
    return false;
  }
  fbSizeId = size.id; FB_W = size.W; FB_H = size.H;
  const root = document.getElementById('builder');
  if (root) root.style.setProperty('--fb-aspect', `${size.W} / ${size.H}`);
  const btn = document.getElementById('b-size');
  if (btn) { btn.textContent = `📐 ${size.name}`; btn.title = `גודל מגרש: ${size.name} · ${size.sub}`; }
  if (!keep && size.id !== fbField.size) { fbField.size = size.id; fbRender(); fbPush(); }
  else fbRender();
  return true;
}
// Cycle to the next size in the picker order. Skips nothing — an un-hostable size is still
// AUTHORABLE, so the gate lives on ▶ שחק, not here.
function fbCycleSize() {
  const i = SIZE_IDS.indexOf(fbField.size);
  fbApplySize(SIZE_IDS[(i + 1 + SIZE_IDS.length) % SIZE_IDS.length]);
}

// --- Undo / redo (snapshot stack) ---
let fbHist = [], fbHistIdx = -1;
function fbSnapshot() { return JSON.stringify(fbField); }
function fbHistInit() { fbHist = [fbSnapshot()]; fbHistIdx = 0; }
function fbPush() { fbHist = fbHist.slice(0, fbHistIdx + 1); fbHist.push(fbSnapshot()); if (fbHist.length > 60) fbHist.shift(); fbHistIdx = fbHist.length - 1; fbSave(); fbUpdateHistBtns(); }
// Undo/redo restores the SIZE too — a size change is an undoable edit like any other, so stepping
// back past one has to put the canvas back as well, not just the elements on it.
function fbRestore(json) { const j = JSON.parse(json); fbField = fbNorm(j); fbSeedSpawns(); fbSel = null; fbApplySize(fbField.size, { keep: true }); fbSave(); fbRender(); fbUpdateHistBtns(); }
function fbUndo() { if (fbHistIdx > 0) { fbHistIdx--; fbRestore(fbHist[fbHistIdx]); } }
function fbRedo() { if (fbHistIdx < fbHist.length - 1) { fbHistIdx++; fbRestore(fbHist[fbHistIdx]); } }
function fbUpdateHistBtns() { const u = document.getElementById('b-undo'), r = document.getElementById('b-redo'); if (u) u.disabled = fbHistIdx <= 0; if (r) r.disabled = fbHistIdx >= fbHist.length - 1; }
// The פינה button mirrors the SELECTED corner. It reports the author's choice for that corner ('auto'
// included) rather than what is on screen, because those differ: an AUTO corner already draws as a
// square or a disc, and a button reading ⬛ on an auto corner would look like an override that is not
// there. Disabled with no corner selected — a control with no target must not look pressable.
function fbSyncJointBtn() {
  const bj = document.getElementById('b-joint');
  if (!bj) return;
  const sel = fbSel && fbSel.type === 'joint' ? fbSel.key : null;
  if (!sel) {
    bj.disabled = true; bj.textContent = '⬛ פינה'; bj.style.opacity = '.45';
    bj.title = 'בחרו פינה במגרש כדי לשנות את הסגנון שלה';
    return;
  }
  const mode = overrideOf(fbField.joints, sel);
  const live = fbLiveJoints.find((j) => j.key === sel);
  const shown = live ? (live.style === 'round' ? '⬤' : '⬛') : '⬛';
  bj.disabled = false; bj.style.opacity = '1';
  bj.textContent = mode === 'auto' ? `אוטו ${shown} פינה` : `${mode === 'round' ? '⬤' : '⬛'} פינה`;
  bj.title = mode === 'auto'
    ? `אוטומטי — הפינה נבחרת לפי הזווית (כרגע ${shown}). לחצו כדי לקבוע ידנית.`
    : 'לחצו כדי להחליף סגנון · עוד לחיצה מחזירה לאוטומטי';
}
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
  if (type === 'bush' || type === 'crate') return { box: [el.x, el.y, el.x + el.w, el.y + el.h] };
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
// Does `el` overlap another element in its OWN category? Solids (walls + crates) share a group
// so none may overlap each other; bushes only clash with bushes (a solid over a bush is allowed).
function fbOverlapsAny(el, type, skip) {
  const fa = fbFoot(el, type);
  const group = type === 'bush' ? ['bush'] : ['hard', 'dry', 'crate'];
  for (const t of group) { const arr = fbList(t); for (let i = 0; i < arr.length; i++) { if (t === type && i === skip) continue; if (fbPairOverlap(fa, fbFoot(arr[i], t))) return true; } }
  return false;
}
function fbFlash(msg) { const h = document.querySelector('#builder .builder-hint'); if (!h) return; const prev = h.textContent; h.textContent = msg; h.style.color = '#ff8a8a'; setTimeout(() => { h.textContent = prev; h.style.color = ''; }, 1200); }

// ---- Field picker: clone an in-game preset OR a saved field into the builder --------------
const FP_SAVES_KEY = 'pikme-fields';
const FB_NAME_KEY = 'pikme-field-name';
const FP_MAX_SLOTS = 30;
let fbFieldName = ''; // the builder's active field name (shown by the title, persisted)
function fpNewId() { return 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function fpCloneArr(a) { return Array.isArray(a) ? a.map((o) => ({ ...o })) : []; }
// Deep-copies a field for the saved-field library. Carries `size` through: a saved slot must
// remember the pitch it was drawn on, or cloning a big field into the builder would reopen it at
// 2000x1100 with every element stranded outside the canvas.
// Carries `spawns`/`ball` too — dropping them here is the same class of bug as the `size` drop this
// function's comment already documents: a saved field would lose its formation on the way in or out.
// Carries `joints` for the same reason: a saved field that lost its per-corner styling would reopen
// with every corner back on AUTO, quietly discarding a decision the author made corner by corner.
function fpNormField(f) {
  return {
    version: 4, size: sizeOfField(f).id,
    bushes: fpCloneArr(f && f.bushes), hardWalls: fpCloneArr(f && f.hardWalls), dryWalls: fpCloneArr(f && f.dryWalls), crates: fpCloneArr(f && f.crates),
    spawns: fpCloneArr(f && f.spawns), ball: (f && f.ball) ? { x: f.ball.x, y: f.ball.y } : null,
    joints: { ...((f && f.joints && typeof f.joints === 'object' && !Array.isArray(f.joints)) ? f.joints : {}) },
  };
}
// Saved slots: validated + id-stamped + deep-copied. Corrupt/non-object entries are skipped so a
// bad row can't crash the list; every entry gets a stable id for identity-safe delete/rename.
function fpLoadSaves() {
  try {
    const a = JSON.parse(localStorage.getItem(FP_SAVES_KEY));
    if (!Array.isArray(a)) return [];
    return a.filter((s) => s && typeof s === 'object' && s.field && typeof s.field === 'object')
      .map((s) => ({ id: typeof s.id === 'string' ? s.id : fpNewId(), name: typeof s.name === 'string' ? s.name : '', field: fpNormField(s.field) }));
  } catch { return []; }
}
function fpWriteSaves(a) { try { localStorage.setItem(FP_SAVES_KEY, JSON.stringify(a)); return true; } catch { return false; } }
function fpCount(f) { const n = fpNormField(f); return n.bushes.length + n.hardWalls.length + n.dryWalls.length + n.crates.length; }
// Next unused "מגרש N" default (max existing N + 1) so deletes never produce a colliding default.
function fpNextDefault() { let max = 0; for (const s of fpLoadSaves()) { const m = /^מגרש (\d+)$/.exec(s.name || ''); if (m) max = Math.max(max, +m[1]); } return `מגרש ${max + 1}`; }

// Active field name — shown by the builder title AND persisted so it survives reopen/reload.
function fbSetName(name) { fbFieldName = name || ''; const el = document.getElementById('builder-fieldname'); if (el) el.textContent = fbFieldName ? `· ${fbFieldName}` : ''; try { localStorage.setItem(FB_NAME_KEY, fbFieldName); } catch { /* private mode */ } }
function fbLoadName() { try { return localStorage.getItem(FB_NAME_KEY) || 'טיוטה'; } catch { return 'טיוטה'; } }

// In-sheet NAME input — works inside the RN WebView (window.prompt is a no-op there). Promise
// resolves to the entered string, or null if cancelled. Wired in the builder init block below.
let _fpNameResolve = null;
function fpAskName(title, def = '') {
  return new Promise((resolve) => {
    _fpNameResolve = resolve;
    const t = document.getElementById('field-name-title'); if (t) t.textContent = title;
    const inp = document.getElementById('field-name-input'); if (inp) inp.value = def;
    document.getElementById('field-name-modal')?.classList.remove('hidden');
    setTimeout(() => { try { inp.focus(); inp.select(); } catch { /* */ } }, 40);
  });
}
function fpNameDone(commit) {
  const inp = document.getElementById('field-name-input');
  document.getElementById('field-name-modal')?.classList.add('hidden');
  const r = _fpNameResolve; _fpNameResolve = null;
  if (r) r(commit ? (inp ? inp.value : '') : null); // null == cancelled
}

// Load a field into the builder: deep-copy (never mutate the preset/saved source), drop to SELECT
// mode (fbSetTool null) so the first tap edits rather than draws, and it's undoable (fbPush).
function fpLoadInto(field, name) { fbField = JSON.parse(JSON.stringify(fpNormField(field))); fbSeedSpawns(); fbSel = null; fbSetTool(null); fbRender(); fbPush(); fbSetName(name || ''); fbFlash('נטען ✓'); closeFieldPicker(); }
function fpRow(name, sub, active, onLoad, onDel, onRename) {
  const row = document.createElement('div'); row.className = 'friend-row' + (active ? ' field-row-active' : '');
  const nm = document.createElement('span'); nm.className = 'field-row-name'; nm.textContent = name; row.appendChild(nm);
  if (sub) { const s = document.createElement('span'); s.className = 'field-row-sub'; s.textContent = sub; row.appendChild(s); }
  const acts = document.createElement('div'); acts.className = 'field-row-actions';
  const load = document.createElement('button'); load.className = 'field-load-btn'; load.textContent = 'טען'; load.setAttribute('aria-label', 'טען מגרש'); load.onclick = onLoad; acts.appendChild(load);
  if (onRename) { const r = document.createElement('button'); r.className = 'field-ren-btn'; r.textContent = '✎'; r.setAttribute('aria-label', 'שנה שם'); r.onclick = onRename; acts.appendChild(r); }
  if (onDel) { const d = document.createElement('button'); d.className = 'field-del-btn'; d.textContent = '🗑'; d.setAttribute('aria-label', 'מחק מגרש'); d.onclick = onDel; acts.appendChild(d); }
  row.appendChild(acts); return row;
}
function renderFpIngame() {
  const el = document.getElementById('fp-ingame'); if (!el) return; el.innerHTML = '';
  for (const p of FIELD_PRESETS) el.appendChild(fpRow(p.name, `${fpCount(p.field)} פריטים`, fbFieldName === p.name, () => fpLoadInto(p.field, p.name)));
}
function renderFpSaved() {
  const el = document.getElementById('fp-saved'); if (!el) return; el.innerHTML = '';
  const saves = fpLoadSaves();
  if (!saves.length) { const m = document.createElement('div'); m.className = 'field-row-sub'; m.textContent = 'אין מגרשים שמורים — שמור עותק'; el.appendChild(m); return; }
  saves.forEach((s) => el.appendChild(fpRow(s.name || 'מגרש', `${fpCount(s.field)} פריטים`, fbFieldName === s.name,
    () => fpLoadInto(s.field, s.name || 'מגרש'),
    () => { fpWriteSaves(fpLoadSaves().filter((x) => x.id !== s.id)); renderFpSaved(); }, // delete BY ID (stale-index safe)
    async () => {
      const raw = await fpAskName('שנה שם', s.name || ''); if (raw === null) return;
      const nn = raw.trim().slice(0, 40); if (!nn) return;
      const a = fpLoadSaves(); const idx = a.findIndex((x) => x.id === s.id); if (idx < 0) return;
      a[idx].name = nn; if (!fpWriteSaves(a)) { fbFlash('שמירה נכשלה'); return; }
      if (fbFieldName === s.name) fbSetName(nn); renderFpSaved();
    })));
}
// Save the current builder field as a named slot: name via the in-sheet input; same-name = OVERWRITE
// (no silent duplicates); cap at FP_MAX_SLOTS; report a failed write instead of a false success.
async function fpSaveCurrent() {
  const raw = await fpAskName('שמור מגרש', fpNextDefault()); if (raw === null) return; // cancelled → nothing saved
  const name = raw.trim().slice(0, 40) || fpNextDefault();
  const saves = fpLoadSaves();
  const idx = saves.findIndex((s) => s.name === name);
  const entry = { id: idx >= 0 ? saves[idx].id : fpNewId(), name, field: fpNormField(fbField) };
  if (idx >= 0) saves[idx] = entry;
  else { if (saves.length >= FP_MAX_SLOTS) { fbFlash(`מקסימום ${FP_MAX_SLOTS} מגרשים`); return; } saves.push(entry); }
  if (!fpWriteSaves(saves)) { fbFlash('שמירה נכשלה — אחסון מלא?'); return; }
  fbSetName(name); renderFpSaved(); fbFlash(idx >= 0 ? 'עודכן ✓' : 'נשמר ✓');
}
function setFpTab(tab) {
  document.querySelectorAll('#field-picker .fr-tab').forEach((t) => t.classList.toggle('active', t.dataset.fptab === tab));
  document.querySelectorAll('#field-picker .fr-pane').forEach((p) => p.classList.toggle('hidden', p.dataset.fppane !== tab));
}
function openFieldPicker() { const el = document.getElementById('field-picker'); if (!el) return; renderFpIngame(); renderFpSaved(); setFpTab('ingame'); el.classList.remove('hidden'); }
function closeFieldPicker() { document.getElementById('field-picker')?.classList.add('hidden'); }
function fbToWorld(cx, cy) { const r = fbPit().getBoundingClientRect(); return { x: Math.max(0, Math.min(FB_W, (cx - r.left) / r.width * FB_W)), y: Math.max(0, Math.min(FB_H, (cy - r.top) / r.height * FB_H)) }; }
// Capsule end points (along `angle`) — matches segBlockedByWall's c0/c1.
function fbEnds(w) { const ca = Math.cos(w.angle), sa = Math.sin(w.angle); return [{ x: w.cx - ca * w.hl, y: w.cy - sa * w.hl }, { x: w.cx + ca * w.hl, y: w.cy + sa * w.hl }]; }
// --- Overlap RESOLUTION (merge instead of reject) ---
function fbBoxOverlap(a, b) { return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y; }
// Overlapping bushes MERGE into one: the union bounding box (all coords are grid-snapped, so
// the union stays cell-aligned). Repeats until the grown bush overlaps nothing new.
function fbMergeBushesInto(idx) {
  let again = true;
  while (again) {
    again = false; const base = fbField.bushes[idx]; if (!base) return idx;
    for (let i = fbField.bushes.length - 1; i >= 0; i--) {
      if (i === idx) continue; const o = fbField.bushes[i];
      if (!fbBoxOverlap(base, o)) continue;
      const x0 = Math.min(base.x, o.x), y0 = Math.min(base.y, o.y);
      const x1 = Math.max(base.x + base.w, o.x + o.w), y1 = Math.max(base.y + base.h, o.y + o.h);
      base.x = x0; base.y = y0; base.w = x1 - x0; base.h = y1 - y0;
      fbField.bushes.splice(i, 1); if (i < idx) idx--; again = true;
    }
  }
  return idx;
}
// Smallest angle between two capsule directions, folded into [0, PI/2] (walls are undirected).
function fbAngleDiff(a, b) { let d = Math.abs(a - b) % Math.PI; return d > Math.PI / 2 ? Math.PI - d : d; }
// Perpendicular distance from wall w's infinite centre-line to a point.
function fbLineDist(w, px, py) { const ca = Math.cos(w.angle), sa = Math.sin(w.angle); return Math.abs((px - w.cx) * -sa + (py - w.cy) * ca); }
// Merge two (near-)collinear walls into one spanning capsule along a's direction.
function fbMergeWall(a, b) {
  const ang = a.angle, ux = Math.cos(ang), uy = Math.sin(ang);
  let tmin = Infinity, tmax = -Infinity;
  for (const p of [...fbEnds(a), ...fbEnds(b)]) { const t = (p.x - a.cx) * ux + (p.y - a.cy) * uy; if (t < tmin) tmin = t; if (t > tmax) tmax = t; }
  const midT = (tmin + tmax) / 2;
  return { cx: Math.round(a.cx + ux * midT), cy: Math.round(a.cy + uy * midT), angle: ang, hl: Math.round((tmax - tmin) / 2), ht: Math.max(a.ht, b.ht) };
}
// Resolve a just-placed/moved wall against same-type walls:
//  · collinear overlap  → MERGE into one longer wall
//  · crossing (angled)  → ALLOW (an intersection, e.g. a "+")
//  · parallel-but-offset overlap (the "weird Y") → REJECT (not placeable there)
// Returns { ok, idx } — idx tracks the wall through any splices.
function fbResolveWall(type, idx) {
  const arr = fbList(type); if (!arr[idx]) return { ok: true, idx };
  let again = true;
  while (again) {
    again = false; const w = arr[idx]; if (!w) break;
    for (let i = arr.length - 1; i >= 0; i--) {
      if (i === idx) continue; const o = arr[i];
      if (!fbPairOverlap(fbFoot(w, type), fbFoot(o, type))) continue;
      if (fbAngleDiff(w.angle, o.angle) >= 0.18) continue; // crossing → allowed intersection
      // near-parallel: collinear (both endpoints near w's line) → merge; else offset → reject
      const collinear = fbLineDist(w, o.cx, o.cy) < w.ht + o.ht;
      if (!collinear) return { ok: false, idx };
      Object.assign(w, fbMergeWall(w, o));
      arr.splice(i, 1); if (i < idx) idx--; again = true; break;
    }
  }
  return { ok: true, idx };
}
// STEEL-WALL CORNER JOINTS — smooth at ANY angle, never a gap and never a stub "+".
// Because walls are cell-snapped with full-cell coverage they OVERSHOOT the junction, so a plain
// disc can't hide the stubs and can't reach an acute miter apex. Instead, per junction we build a
// convex hull from features LOCAL to the corner: (a) the walls' cross-section anchors at J (hull
// stays flush to every wall → no gap), (b) the cap-corner tips of any short "stub" end (swallows
// the overshoot → no "+"), and (c) the outer miter apex of each arm pair (keeps acute corners
// sharp). Returns per junction { cx, cy, r, poly }: `poly` = the filled SQUARE joint; `r` = the
// bounding radius of that hull = the ROUND joint disc. Render-only (collision already blocks).
function convexHull(pts) { // Andrew monotone chain
  const P = pts.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  if (P.length < 3) return P;
  const cr = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lo = []; for (const p of P) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  const hi = []; for (let i = P.length - 1; i >= 0; i--) { const p = P[i]; while (hi.length >= 2 && cr(hi[hi.length - 2], hi[hi.length - 1], p) <= 0) hi.pop(); hi.push(p); }
  lo.pop(); hi.pop(); return lo.concat(hi);
}
function jointPolygon(walls, J) {
  const ARM_MIN = 30;   // > overshoot(25): an overshoot end is a STUB, a real body is an ARM
  const MITER = 3.0;    // miter limit — bevel corners sharper than ~asin(1/3) half-angle
  const pts = [], arms = []; let anyStub = false;
  for (const w of walls) {
    const u = { x: Math.cos(w.angle), y: Math.sin(w.angle) }, n = { x: -Math.sin(w.angle), y: Math.cos(w.angle) };
    const ht = w.ht, hl = w.hl;
    const s = (J.x - w.cx) * u.x + (J.y - w.cy) * u.y;      // signed pos of J along the centre-line
    const Jc = { x: w.cx + u.x * s, y: w.cy + u.y * s };    // J projected onto the wall
    pts.push({ x: Jc.x + n.x * ht, y: Jc.y + n.y * ht }, { x: Jc.x - n.x * ht, y: Jc.y - n.y * ht }); // anchors → no gap
    const side = (dir, ext) => {
      if (ext > ARM_MIN) arms.push({ g: { x: u.x * dir, y: u.y * dir }, ht });
      else { anyStub = true; const tx = Jc.x + u.x * dir * ext, ty = Jc.y + u.y * dir * ext; pts.push({ x: tx + n.x * ht, y: ty + n.y * ht }, { x: tx - n.x * ht, y: ty - n.y * ht }); }
    };
    side(1, hl - s); side(-1, hl + s);
  }
  if (!anyStub) return null; // pure mid-span crossing = an intended "+"; leave it
  // `minAngle` = the sharpest real arm pair at this junction. It is what AUTO styling reads
  // (shared/joint-style.js): the pairs rejected by MITER just below are exactly the ones whose mitre
  // would spike, so they must be MEASURED here even though no apex point is emitted for them —
  // skipping them would report an acute corner as if it were a clean right angle.
  let minAngle = null;
  for (let i = 0; i < arms.length; i++) for (let j = i + 1; j < arms.length; j++) {
    const a = arms[i], b = arms[j];
    const dot = Math.max(-1, Math.min(1, a.g.x * b.g.x + a.g.y * b.g.y)), th = Math.acos(dot);
    if (th < 0.15 || Math.PI - th < 0.15) continue;
    if (minAngle == null || th < minAngle) minAngle = th;
    const sh = Math.sin(th / 2); if (1 / sh > MITER) continue;
    let bx = -(a.g.x + b.g.x), by = -(a.g.y + b.g.y); const bl = Math.hypot(bx, by) || 1; bx /= bl; by /= bl;
    const m = Math.max(a.ht, b.ht) / sh; pts.push({ x: J.x + bx * m, y: J.y + by * m });
  }
  return { poly: convexHull(pts), minAngle };
}
let _wjRef = null, _wjOut = null, _wjOvr = null; // memoize the GAME path — arena walls are a stable ref; the editor's fbField.hardWalls mutates in place, so it's never cached
// `overrides` = the field's per-corner style map ({ "x:y": 'square'|'round' }); absent → every corner
// takes its AUTO look. Each returned joint carries `key`/`style` so the renderer never re-derives them.
function wallJoints(walls, overrides) {
  const cacheable = walls === fieldArena().walls;
  // The overrides map is part of the cache identity: a corner restyled while the same arena is loaded
  // must repaint, and caching on `walls` alone would serve the old look until the next arena swap.
  if (cacheable && walls === _wjRef && overrides === _wjOvr && _wjOut) return _wjOut; // static arena joints — recomputed only on arena swap, not every frame
  const hw = (walls || []).filter((w) => w && w.angle != null && w.cx != null);
  const raw = [];
  for (let i = 0; i < hw.length; i++) for (let j = i + 1; j < hw.length; j++) {
    const A = hw[i], B = hw[j];
    const dax = Math.cos(A.angle), day = Math.sin(A.angle), dbx = Math.cos(B.angle), dby = Math.sin(B.angle);
    const den = dax * dby - day * dbx;
    if (Math.abs(den) < 1e-4) continue; // parallel/collinear → merged elsewhere, no corner
    const t = ((B.cx - A.cx) * dby - (B.cy - A.cy) * dbx) / den;
    const ix = A.cx + dax * t, iy = A.cy + day * t;
    const tol = Math.max(A.ht, B.ht) + 2;
    const ta = Math.abs((ix - A.cx) * dax + (iy - A.cy) * day), tb = Math.abs((ix - B.cx) * dbx + (iy - B.cy) * dby);
    if (ta <= A.hl + tol && tb <= B.hl + tol) raw.push({ x: ix, y: iy, i, j });
  }
  const rad = hw.reduce((m, w) => Math.max(m, w.ht), 0) * 1.5 + 4;
  const clusters = []; // merge coincident corners (T / X / 3+ walls at one point)
  for (const p of raw) {
    let c = clusters.find((c) => Math.hypot(c.x - p.x, c.y - p.y) <= rad);
    if (!c) { c = { x: p.x, y: p.y, set: new Set() }; clusters.push(c); }
    c.set.add(p.i); c.set.add(p.j);
  }
  const out = [];
  for (const c of clusters) {
    const j = jointPolygon([...c.set].map((i) => hw[i]), { x: c.x, y: c.y });
    const poly = j && j.poly;
    if (poly && poly.length >= 3) {
      let r = 0; for (const p of poly) r = Math.max(r, Math.hypot(p.x - c.x, p.y - c.y)); // bounding disc = round joint
      const key = jointKey(c.x, c.y);
      out.push({ cx: c.x, cy: c.y, r, poly, key, minAngle: j.minAngle, style: resolveJointStyle(overrides, key, j.minAngle) });
    }
  }
  if (cacheable) { _wjRef = walls; _wjOut = out; _wjOvr = overrides; }
  return out;
}
// SEED THE DEFAULT FORMATION as real, draggable markers.
//
// A field with no authored slots used to render an EMPTY pitch while the match quietly used the
// built-in formula, so an author could neither see nor adjust where players actually start (user,
// 2026-07-26: "put the players position, like the one in the arena builder, in the correct place").
// The markers come from shared/field-spawns.js — the SAME maths the sim uses — so seeding changes
// nothing about where anyone spawns; it only makes the existing positions visible and editable.
// Sized for the builder's own ▶ שחק match (FB_MATCH_TEAM per side) and clamped to the field size.
function fbSeedSpawns() {
  if (!fbField) return;
  if (Array.isArray(fbField.spawns) && fbField.spawns.length) return;   // author's slots win
  fbField.spawns = defaultSpawns(FB_MATCH_TEAM, fbField.size).map((s) => ({ x: Math.round(s.x), y: Math.round(s.y), team: s.team }));
}

function fbRender() {
  const pit = fbPit(); if (!pit) return;
  pit.querySelectorAll('.bel,.bhandle').forEach((e) => e.remove());
  const pctL = (x) => (x / FB_W * 100) + '%', pctT = (y) => (y / FB_H * 100) + '%';
  // w/h null => the element is a POINT (a marker): it keeps a fixed on-screen size from CSS instead of
  // scaling with the pitch. One grid cell is ~9px wide on the builder's ~370px pitch, which made the
  // start-slot discs unreadable dots; a marker is a position, not an area, so screen size is right.
  const mk = (type, i, cx, cy, w, h, angle) => {
    const d = document.createElement('div');
    d.className = 'bel ' + type + (fbSel && fbSel.type === type && fbSel.i === i ? ' sel' : '');
    d.style.left = pctL(cx); d.style.top = pctT(cy);
    if (w != null) { d.style.width = pctL(w); d.style.height = pctT(h); }
    if (angle != null) d.style.setProperty('--ang', angle + 'rad');
    d.dataset.type = type; d.dataset.i = i;
    pit.appendChild(d);
    return d;
  };
  fbField.bushes.forEach((b, i) => mk('bush', i, b.x + b.w / 2, b.y + b.h / 2, b.w, b.h, null));
  fbField.hardWalls.forEach((w, i) => mk('hard', i, w.cx, w.cy, w.hl * 2, w.ht * 2, w.angle));
  // Steel-wall corner joints → an SVG overlay (world coords) so a mitre POLYGON is drawable in the
  // DOM and matches the in-game canvas exactly. Persistent (survives the .bel/.bhandle cleanup above).
  const NS = 'http://www.w3.org/2000/svg';
  let svg = pit.querySelector('svg.bjoints');
  if (!svg) { svg = document.createElementNS(NS, 'svg'); svg.setAttribute('class', 'bjoints'); svg.setAttribute('viewBox', '0 0 ' + FB_W + ' ' + FB_H); svg.setAttribute('preserveAspectRatio', 'none'); svg.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:2'; pit.appendChild(svg); }
  svg.innerHTML = '';
  // The corner is never placed by hand — it exists because two walls meet, and it styles itself
  // (shared/joint-style.js). It IS selectable though: tap one and the פינה button restyles that corner
  // alone. The <svg> stays pointer-events:none so it never eats a tap meant for the pitch; each joint
  // re-enables events for itself, and only while a selection tool is active (see the pointerdown).
  fbLiveJoints = wallJoints(fbField.hardWalls, fbField.joints);
  for (const j of fbLiveJoints) {
    let el;
    if (j.style === 'round') { el = document.createElementNS(NS, 'circle'); el.setAttribute('cx', j.cx); el.setAttribute('cy', j.cy); el.setAttribute('r', j.r); }
    else { el = document.createElementNS(NS, 'polygon'); el.setAttribute('points', j.poly.map((p) => p.x + ',' + p.y).join(' ')); }
    const picked = fbSel && fbSel.type === 'joint' && fbSel.key === j.key;
    el.setAttribute('fill', '#7b828d');
    el.setAttribute('stroke', picked ? '#ffd34d' : '#43484f');
    el.setAttribute('stroke-width', picked ? '3' : '1');
    el.setAttribute('class', 'bjoint');
    el.dataset.key = j.key;
    // ALWAYS tappable, and the pointerdown decides what a tap means. Gating this on the active tool
    // at render time meant a corner drawn with the wall tool stayed pointer-events:none until the next
    // repaint, so switching to ✋ and tapping it did nothing (caught in the browser, not by a unit
    // test). Harmless with a placement tool active: the event still bubbles to the pitch, and the
    // normal path looks for `.bel`, which a joint is not — so drawing over a corner still draws.
    el.style.pointerEvents = 'auto';
    svg.appendChild(el);
  }
  fbField.dryWalls.forEach((w, i) => mk('dry', i, w.cx, w.cy, w.hl * 2, w.ht * 2, w.angle));
  fbField.crates.forEach((c, i) => mk('crate', i, c.x + c.w / 2, c.y + c.h / 2, c.w, c.h, null));
  // MARKERS on top (z-index in CSS): one cell wide, labelled so a slot's team is never a guess.
  fbField.spawns.forEach((s, i) => {
    const el = mk('spawn', i, s.x, s.y, null, null, null);
    el.classList.add(s.team === 'B' ? 'spawn-b' : 'spawn-a'); el.dataset.lbl = s.team;
  });
  // No ball marker: the kickoff spot is the centre for every match and every field (see attachBall).
  // Fields saved before that rule may still carry a `ball` point; it round-trips untouched but is not
  // drawn, because drawing it would advertise a position the match ignores.
  fbUpdateCap();
  // Selection can change from a dozen places (tap, tool switch, undo, delete) — syncing the corner
  // control here means every one of them is covered, instead of remembering to call it at each site.
  fbSyncJointBtn();
}
// "How many players does this map hold?" — min(A slots, B slots), because a 3-vs-1 layout can only
// seat 1v1 without stacking two players on one marker. Rendered as a live badge next to the size
// button so the author sees the answer while placing, plus what a shortfall/surplus will do.
// ▶ שחק launches a 2v2 vs bots (server: startBuilderMatch), so that is what a shortfall/surplus is
// measured against — quoting a capacity with no reference point is what makes "6 slots" ambiguous.
const FB_MATCH_TEAM = 2;
function fbUpdateCap() {
  const el = document.getElementById('b-cap'); if (!el) return;
  const c = spawnCounts(fbField.spawns), cap = spawnCapacity(fbField.spawns);
  // No ⚽ chip any more: the ball's kickoff spot is not field data, so there is nothing per-field to
  // advertise. The rule is stated UNCONDITIONALLY in the tooltip instead of only on fields that happen
  // to carry a legacy ball point — it applies to every field, so every field should say so.
  const rule = '\nיותר נקודות משחקנים = בכל משחק נבחרות נקודות אחרות (רנדומלי). פחות = השאר מתחילים במערך הקבוע.'
    + '\n⚽ הכדור תמיד מתחיל במרכז המגרש. אחרי ספיגה — אצל שחקן של הקבוצה שספגה.';
  if (!c.A && !c.B) {
    el.textContent = '👥 מערך ברירת מחדל';
    el.title = 'לא הוצבו נקודות פתיחה — השחקנים מסתדרים לפי המערך הקבוע של המשחק' + rule;
    el.classList.remove('cap-warn'); return;
  }
  const short = cap < FB_MATCH_TEAM;
  el.textContent = `👥 ${cap} נגד ${cap}` + (short ? ` · משחק ${FB_MATCH_TEAM} נגד ${FB_MATCH_TEAM}` : (cap > FB_MATCH_TEAM ? ' · רנדומלי' : ''));
  el.classList.toggle('cap-warn', short || c.A !== c.B);
  el.title = `נקודות פתיחה: קבוצה A ${c.A} · קבוצה B ${c.B}`
    + (c.A !== c.B ? ' — לא מאוזן: הקיבולת נקבעת לפי הצד הקטן' : '')
    + (short ? `\n▶ שחק הוא ${FB_MATCH_TEAM} נגד ${FB_MATCH_TEAM} — שחקנים ללא נקודה מתחילים במערך הקבוע` : '')
    + rule;
}
// Move a selected element to (wx,wy) — grid-snapped.
function fbMoveSel(wx, wy) {
  if (!fbSel) return; const L = fbList(fbSel.type)[fbSel.i]; if (!L) return;
  // Bushes snap their TOP-LEFT CORNER to a grid line (matches how they're drawn) so a moved
  // bush stays cell-aligned; centre-snapping put even-width bushes half a cell off the grid.
  if (fbSel.type === 'bush' || fbSel.type === 'crate') { L.x = fbSnap(wx - L.w / 2); L.y = fbSnap(wy - L.h / 2); }
  // Markers ARE their point: snap the point itself to a cell centre (same grid the walls use), and
  // keep the stored team — dragging a slot into the other half is a deliberate high-press layout,
  // not a mistake to auto-correct. Tap it with the 🏁 tool to flip the team.
  else if (FB_MARKER(fbSel.type)) { L.x = fbSnapCell(wx); L.y = fbSnapCell(wy); }
  else { L.cx = fbSnapCell(wx); L.cy = fbSnapCell(wy); } // walls snap to the box grid (cell centres)
  fbRender();
}
let fbDraw = null; // { type, ax, ay, i } while DRAWING a new wall/bush from a fixed anchor
// Update the element being drawn: a wall becomes a LINE anchor->cursor (free angle =>
// rotation is built in); a bush becomes the rectangle anchor->cursor. Grid-snapped.
function fbDrawUpdate(wx, wy) {
  if (!fbDraw) return;
  if (fbDraw.type === 'bush') {
    const bx = fbSnap(wx), by = fbSnap(wy); // bushes snap their corner to junctions
    const b = fbField.bushes[fbDraw.i]; if (!b) return;
    b.x = Math.min(fbDraw.ax, bx); b.y = Math.min(fbDraw.ay, by);
    b.w = Math.max(FB_GRID, Math.abs(bx - fbDraw.ax)); b.h = Math.max(FB_GRID, Math.abs(by - fbDraw.ay));
  } else {
    const bx = fbSnapCell(wx), by = fbSnapCell(wy); // walls snap endpoints to the box grid (cell centres)
    const L = fbList(fbDraw.type)[fbDraw.i]; if (!L) return;
    const dx = bx - fbDraw.ax, dy = by - fbDraw.ay;
    const dist = Math.hypot(dx, dy);
    // Endpoints are cell CENTRES, so extend the span by ONE full cell (½ each end) so the first and
    // last boxes are covered edge-to-edge — segments tile with no gaps and connect into L-shapes.
    L.angle = dist > 0.5 ? Math.atan2(dy, dx) : 0;
    L.hl = Math.round((dist + FB_GRID) / 2);
    L.cx = Math.round((fbDraw.ax + bx) / 2);
    L.cy = Math.round((fbDraw.ay + by) / 2);
  }
  fbRender();
}
function fbDeleteEl(el) {
  if (!el) return;
  const t = el.dataset.type;
  // The ball is a single field, not a list slot — fbList('ball') hands out a throwaway wrapper, so
  // splicing it would delete nothing and look like a broken eraser.
  if (t === 'ball') { if (fbField.ball) { fbField.ball = null; if (fbSel && fbSel.type === 'ball') fbSel = null; fbRender(); } return; }
  const arr = fbList(t); const i = +el.dataset.i;
  if (i >= 0 && i < arr.length) { arr.splice(i, 1); if (fbSel && fbSel.type === t && fbSel.i === i) fbSel = null; fbRender(); }
}
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
  addCopies('hard', wall); addCopies('dry', wall); addCopies('bush', bush); addCopies('crate', bush); // crates mirror like boxes
  // START SLOTS mirror as points, and a side/diagonal mirror FLIPS the team — that is the whole
  // point: place your 3 slots on the left, tap ⇆ צד, and the opponents' 3 appear opposite them.
  // A top mirror stays on the same half, so the team is unchanged. Capped per team so a repeated
  // mirror can't breed slots past the limit. The single ball has no mirror image — it stays put.
  {
    const cap = MAX_SPAWNS_PER_TEAM;
    const copies = [];
    for (const s of fbField.spawns) {
      const flip = mode !== 'top';
      const c = { x: mode === 'top' ? s.x : mx(s.x), y: mode === 'sides' ? s.y : my(s.y), team: flip ? (s.team === 'A' ? 'B' : 'A') : s.team };
      const dup = [...fbField.spawns, ...copies].some((o) => o.team === c.team && Math.abs(o.x - c.x) < 1 && Math.abs(o.y - c.y) < 1);
      const n = [...fbField.spawns, ...copies].filter((o) => o.team === c.team).length;
      if (!dup && n < cap) copies.push(c);
    }
    fbField.spawns.push(...copies);
  }
  fbSel = null; fbRender(); fbPush();
}
// Field zoom: scale the arena's layout HEIGHT (aspect keeps width in step) so the stage's
// overflow gives native scroll-to-pan; fbToWorld reads the live rect, so placement stays exact.
let fbZoom = 1;
function fbSetZoom(z) {
  fbZoom = Math.max(1, Math.min(3, Math.round(z * 100) / 100));
  const a = document.querySelector('#builder .builder-arena');
  if (a) a.style.setProperty('--bz', fbZoom);
}
let fbTwoFinger = false; // true while a 2-finger pinch/pan gesture is active (suppresses draw)
function fbCancelDraw() { if (fbDraw) { const arr = fbList(fbDraw.type); if (fbDraw.i >= 0 && fbDraw.i < arr.length) arr.splice(fbDraw.i, 1); fbDraw = null; fbRender(); } fbDrag = null; }
function openBuilder() { fbField = fbLoad(); fbSeedSpawns(); fbSel = null; fbSetTool('hard'); fbApplySize(fbField.size, { keep: true }); fbHistInit(); fbUpdateHistBtns(); fbSetZoom(1); fbSetName(fbLoadName()); }
(function fbWire() {
  const pit = document.getElementById('builder-pitch'); if (!pit) return;
  const bscr = document.getElementById('builder'); if (bscr) screens.builder = bscr;
  document.getElementById('field-builder-btn')?.addEventListener('click', () => { unlockAudio && unlockAudio(); showScreen('builder'); openBuilder(); });
  document.querySelectorAll('#builder .btool').forEach((btn) => btn.addEventListener('click', () => fbSetTool(fbTool === btn.dataset.tool ? null : btn.dataset.tool)));
  document.getElementById('b-delete')?.addEventListener('click', () => { if (fbSel) { fbList(fbSel.type).splice(fbSel.i, 1); fbSel = null; fbRender(); fbPush(); } });
  // Clear-all empties the ELEMENTS, not the pitch: you keep authoring at the size you chose.
  document.getElementById('b-clear')?.addEventListener('click', () => { fbField = fbNorm(null, fbField.size); fbSeedSpawns(); fbSel = null; fbRender(); fbPush(); fbSetName('טיוטה'); });
  document.getElementById('b-size')?.addEventListener('click', () => fbCycleSize());
  // 🤖 bot level for the playtest — cycles the SHARED level (setDifficulty persists it + pushes it
  // live), so what you pick here is what the settings panel shows once the match starts.
  document.getElementById('b-diff')?.addEventListener('click', () => {
    setDifficulty((diffLevel + 1) % DIFFICULTY_LEVELS.length);
    fbFlash(`רמת בוטים: ${levelAt(diffLevel).name} · ${levelAt(diffLevel).hint}`);
  });
  document.querySelectorAll('#builder [data-mirror]').forEach((btn) => btn.addEventListener('click', () => fbMirror(btn.dataset.mirror)));
  document.getElementById('b-undo')?.addEventListener('click', fbUndo);
  document.getElementById('b-redo')?.addEventListener('click', fbRedo);
  document.getElementById('b-save')?.addEventListener('click', () => { fbSave(); const h = document.querySelector('#builder .builder-hint'); if (h) { const p = h.textContent; h.textContent = 'נשמר ✓'; h.style.color = '#7CFC7C'; setTimeout(() => { h.textContent = p; h.style.color = ''; }, 1200); } });
  // Field picker: open the floating panel to clone an in-game preset or a saved field.
  // Joint-style toggle (square mitre ⬛ ↔ round ⬤). Both are gapless/no-"+"; render-only.
  // פינה now acts on the SELECTED corner only: auto → square → round → auto, so the automatic look is
  // always recoverable. With no corner selected it is disabled and says so — the button can no longer
  // restyle a whole field, and it can no longer be pressed before the corner it describes exists.
  { const bj = document.getElementById('b-joint');
    if (bj) {
      fbSyncJointBtn();
      bj.addEventListener('click', () => {
        if (!fbSel || fbSel.type !== 'joint') return;             // nothing selected → nothing to restyle
        const next = cycleJointStyle(overrideOf(fbField.joints, fbSel.key));
        fbField.joints = setJointOverride(fbField.joints, fbSel.key, next);
        fbRender(); fbSyncJointBtn(); fbPush();                    // one undo step per corner change
      });
    } }
  document.getElementById('builder-fields')?.addEventListener('click', () => { unlockAudio && unlockAudio(); openFieldPicker(); });
  document.querySelectorAll('#field-picker .fr-tab').forEach((t) => t.addEventListener('click', () => setFpTab(t.dataset.fptab)));
  document.querySelectorAll('#field-picker [data-fp-close]').forEach((el) => el.addEventListener('click', closeFieldPicker));
  document.getElementById('fp-save-current')?.addEventListener('click', fpSaveCurrent);
  // In-sheet name modal (save/rename) — OK/Cancel + Enter/Escape.
  document.getElementById('field-name-ok')?.addEventListener('click', () => fpNameDone(true));
  document.querySelectorAll('#field-name-modal [data-fpname-cancel]').forEach((el) => el.addEventListener('click', () => fpNameDone(false)));
  document.getElementById('field-name-input')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); fpNameDone(true); } else if (e.key === 'Escape') { e.preventDefault(); fpNameDone(false); } });
  // Escape closes the name modal first, else the picker.
  addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!document.getElementById('field-name-modal')?.classList.contains('hidden')) fpNameDone(false);
    else if (!document.getElementById('field-picker')?.classList.contains('hidden')) closeFieldPicker();
  });
  // ▶ שחק is gated on the size being HOSTABLE, not merely authorable. A match on a non-base size
  // would render bigger while the sim still used 2000x1100 goal lines, penalty boxes and spawns —
  // wrong in a way that looks like a physics bug. Refuse loudly instead. See RUNTIME_SIZES.
  document.getElementById('builder-play')?.addEventListener('click', () => {
    fbSave();
    if (!canHost(fbField.size)) { fbFlash(`מגרש ${sizeOf(fbField.size).name} — אפשר לבנות, משחק בקרוב`); return; }
    // diffLevel: playtest your field against the bots you PICKED with the 🤖 button in the rail
    // (this path used to send none, so every builder match ran at the default level).
    unlockAudio && unlockAudio(); syncLoadout && syncLoadout(); sendMsg({ type: 'builderMatch', field: fbField, diffLevel });
  });
  document.getElementById('b-zoom-in')?.addEventListener('click', () => fbSetZoom(fbZoom + 0.25));
  document.getElementById('b-zoom-out')?.addEventListener('click', () => fbSetZoom(fbZoom - 0.25));
  document.getElementById('b-zoom-reset')?.addEventListener('click', () => fbSetZoom(1));
  document.querySelector('#builder .builder-stage')?.addEventListener('wheel', (e) => { e.preventDefault(); fbSetZoom(fbZoom + (e.deltaY < 0 ? 0.2 : -0.2)); }, { passive: false });
  // Two-finger PINCH to zoom + two-finger DRAG to pan (natural mobile gesture).
  const stage = document.querySelector('#builder .builder-stage');
  if (stage) {
    const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const mid = (t) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });
    let d0 = 0, z0 = 1, mx0 = 0, my0 = 0, sx0 = 0, sy0 = 0, on = false;
    stage.addEventListener('touchstart', (e) => { if (e.touches.length === 2) { on = true; fbTwoFinger = true; fbCancelDraw(); d0 = dist(e.touches) || 1; z0 = fbZoom; const m = mid(e.touches); mx0 = m.x; my0 = m.y; sx0 = stage.scrollLeft; sy0 = stage.scrollTop; e.preventDefault(); } }, { passive: false });
    stage.addEventListener('touchmove', (e) => { if (on && e.touches.length === 2) { e.preventDefault(); const m = mid(e.touches); fbSetZoom(z0 * (dist(e.touches) / d0)); stage.scrollLeft = sx0 - (m.x - mx0); stage.scrollTop = sy0 - (m.y - my0); } }, { passive: false });
    const endGesture = (e) => { if (e.touches.length < 2 && on) { on = false; setTimeout(() => { fbTwoFinger = false; }, 60); } };
    stage.addEventListener('touchend', endGesture); stage.addEventListener('touchcancel', endGesture);
  }
  pit.addEventListener('pointerdown', (e) => {
    if (fbTwoFinger) return; // a pinch/pan is in progress — don't start drawing
    const w = fbToWorld(e.clientX, e.clientY);
    const el = e.target.closest('.bel');
    // A CORNER was tapped. Corners are derived geometry, so this selects (never places, never drags)
    // and hands the פינה button a target. Gated to the selection tools: while a wall/bush tool is
    // active the same tap must keep drawing, and a corner sits exactly where authors draw.
    const jel = e.target.closest('.bjoint');
    if (jel && (fbTool === 'move' || fbTool === null)) {
      fbSel = { type: 'joint', key: jel.dataset.key };
      fbRender(); fbSyncJointBtn();
      return;
    }
    // ERASER — remove what you touch/drag over.
    if (fbTool === 'eraser') { fbDrag = { id: e.pointerId, erase: true, pre: fbSnapshot() }; try { pit.setPointerCapture(e.pointerId); } catch (x) {} fbDeleteEl(el); return; }
    // MOVE — grab an element and drag it (no placement, no resize).
    if (fbTool === 'move') {
      if (el) { fbSel = { type: el.dataset.type, i: +el.dataset.i }; fbDrag = { id: e.pointerId, move: true, pre: fbSnapshot() }; try { pit.setPointerCapture(e.pointerId); } catch (x) {} fbRender(); }
      else { fbSel = null; fbRender(); }
      return;
    }
    // WALL tools — DRAW a line from a fixed anchor (grid-snapped, any angle).
    if (fbTool === 'hard' || fbTool === 'dry') {
      const ax = fbSnapCell(w.x), ay = fbSnapCell(w.y); // anchor on the box grid (cell centre)
      fbList(fbTool).push({ cx: ax, cy: ay, angle: 0, hl: FB_GRID / 2, ht: FB_WALL.ht }); // a tap = one FULL cell long (50), thin (32)
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
    // START SLOT — PLACE a marker at the cell centre. Team is guessed from the half (A defends the
    // left goal), which makes the common case a single tap. Tapping an EXISTING slot flips its team
    // instead of stacking a second marker on it — that's how you author a high-press start.
    if (fbTool === 'spawn') {
      const pre = fbSnapshot();
      if (el && el.dataset.type === 'spawn') {
        const s = fbField.spawns[+el.dataset.i];
        if (s) {
          const to = s.team === 'A' ? 'B' : 'A';
          if (spawnCounts(fbField.spawns)[to] >= MAX_SPAWNS_PER_TEAM) { fbFlash(`מקסימום ${MAX_SPAWNS_PER_TEAM} נקודות פתיחה לקבוצה`); return; }
          s.team = to; fbSel = { type: 'spawn', i: +el.dataset.i }; fbRender(); fbPush();
        }
        return;
      }
      const sx = fbSnapCell(w.x), sy = fbSnapCell(w.y);
      const team = teamForX(sx, sizeOf(fbField.size));
      if (spawnCounts(fbField.spawns)[team] >= MAX_SPAWNS_PER_TEAM) { fbFlash(`מקסימום ${MAX_SPAWNS_PER_TEAM} נקודות פתיחה לקבוצה ${team}`); return; }
      fbField.spawns.push({ x: sx, y: sy, team });
      fbSel = { type: 'spawn', i: fbField.spawns.length - 1 };
      fbDrag = { id: e.pointerId, move: true, pre }; try { pit.setPointerCapture(e.pointerId); } catch (x) {} fbRender(); return;
    }
    // CRATE — PLACE a single grid cell in the cell under the cursor. No resize; optional drag to
    // reposition. Overlap is checked on release (a crate can't sit on another solid).
    if (fbTool === 'crate') {
      const pre = fbSnapshot();
      const ax = Math.floor(w.x / FB_GRID) * FB_GRID, ay = Math.floor(w.y / FB_GRID) * FB_GRID;
      fbField.crates.push({ x: ax, y: ay, w: FB_GRID, h: FB_GRID });
      fbSel = { type: 'crate', i: fbField.crates.length - 1 };
      fbDrag = { id: e.pointerId, move: true, pre }; try { pit.setPointerCapture(e.pointerId); } catch (x) {} fbRender(); return;
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
      // Overlaps no longer reject outright: bushes MERGE, walls merge-if-collinear / allow-if-crossing.
      if (fbDraw.type === 'bush') { fbDraw.i = fbMergeBushesInto(fbDraw.i); fbSel = { type: 'bush', i: fbDraw.i }; fbRender(); fbPush(); }
      else {
        const res = fbResolveWall(fbDraw.type, fbDraw.i);
        if (!res.ok) { fbList(fbDraw.type).splice(fbDraw.i, 1); fbSel = null; fbRender(); fbFlash('אי אפשר להניח קיר כאן'); }
        else { fbSel = { type: fbDraw.type, i: res.idx }; fbRender(); fbPush(); }
      }
    } else if (fbDrag.move && fbSel) {
      if (fbSel.type === 'bush') { fbSel.i = fbMergeBushesInto(fbSel.i); fbRender(); if (fbDrag.pre !== fbSnapshot()) fbPush(); }
      else if (fbSel.type === 'crate') {
        const L = fbList('crate')[fbSel.i];
        if (L && fbOverlapsAny(L, 'crate', fbSel.i)) { fbRestore(fbDrag.pre); fbFlash('אי אפשר לחפוף ארגז'); }
        else if (fbDrag.pre !== fbSnapshot()) fbPush();
      }
      // MARKERS: no overlap rule to resolve (nothing collides with a start spot), so a move is just
      // committed. Without this branch they fell into the wall resolver below and vanished.
      else if (FB_MARKER(fbSel.type)) { if (fbDrag.pre !== fbSnapshot()) fbPush(); }
      else {
        const res = fbResolveWall(fbSel.type, fbSel.i);
        if (!res.ok) { fbRestore(fbDrag.pre); fbFlash('אי אפשר להניח קיר כאן'); }
        else { fbSel.i = res.idx; fbRender(); if (fbDrag.pre !== fbSnapshot()) fbPush(); }
      }
    } else if (fbDrag.erase) {
      if (fbDrag.pre !== fbSnapshot()) fbPush();
    }
    fbDraw = null; fbDrag = null;
  });
})();
