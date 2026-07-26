// SKILL PROGRESSION — techniques earned from training drills.
//
// Design: summery/research-trophies/00-DECISION.md §4, chosen from 5-agent research.
//
// THE RULE THAT MATTERS: progression here is **horizontal**. A technique unlocks a new thing you can
// DO; it never makes you numerically stronger. Reasons, from the research:
//   • The card powers from the parent Saltiz app are ALREADY a vertical (stat) axis. Stacking a second
//     one is exactly how Brawl Stars' Power 1–11 (+100% HP/damage at max) earned its pay-to-win
//     reputation, and Ranked's "12 brawlers at Power 11" gate is its most-criticised feature.
//   • Rocket League — the closest genre match — ships ZERO ability progression on purpose, and is the
//     reference for competitive football feeling fair.
//   • So: unlock OPTIONS (like FIFA's skill-move star ratings, which gate *which tricks you may
//     attempt* but still demand the input), not numbers.
// Consequences enforced by test-techniques.mjs: every technique is kind:'ability', none carries a
// stat multiplier, none is purchasable, and none is gated behind trophies. Techniques are earned by
// EXECUTION in training. Keep it that way.
//
// Trophies and techniques are deliberately independent: drills pay 0 trophies (so they can't be farmed
// for rank) and techniques cost 0 trophies (so a low-ranked player isn't locked out of learning).
//
// The bottom half of this file is the EFFECT HELPER layer: the pure math each ability needs, so that
// wiring one into shared/sim.js is a one-line call to a tested function instead of new logic inside the
// highest-regression file in the repo. See test-technique-effects.mjs and
// docs/superpowers/specs/2026-07-26-technique-wiring-design.md.

import { QUICK_CHARGE, BOMB, DETACH_SIDE, SUPER_USES } from './constants.js';

// Medals per drill, worst → best. BRONZE is what unlocks the technique; silver/gold are mastery
// (status only — deliberately no extra power, or the medal would become a stat gate).
export const MEDALS = ['bronze', 'silver', 'gold'];

// Score multiples of a drill's target that earn each medal.
const MEDAL_AT = { bronze: 1, silver: 1.5, gold: 2 };

// ---- DRILLS -----------------------------------------------------------------------------------
// Each drill builds on the EXISTING training ground (shared/training.js: keeper, sentries, still
// dummies) and scores one specific mechanic. `target` is the score for bronze; 1.5x silver, 2x gold.
// `mechanic` names the real system it teaches, so a reader can find it in docs/MECHANICS.md.
export const DRILLS = [
  {
    id: 'charge-control',
    he: 'שליטה בעוצמה',
    goal: 'עצור את הטעינה בדיוק בעוצמה המבוקשת',
    mechanic: 'kick',       // MECHANICS.md §1 charge system / §2 carrier kick
    target: 6,              // successful stops inside the requested charge window
    unit: 'עצירות מדויקות',
  },
  {
    id: 'bend-wall',
    he: 'סביב הקיר',
    goal: 'הכנס את הכדור לשער מעבר לקיר חוסם',
    mechanic: 'kick',
    target: 4,
    unit: 'שערים',
  },
  {
    id: 'bomb-timing',
    he: 'תזמון פצצה',
    goal: 'פוצץ את הפצצה בדיוק כשהיריב בטווח',
    mechanic: 'bomb',       // MECHANICS.md bombs
    target: 5,
    unit: 'פגיעות',
  },
  {
    id: 'wall-course',
    he: 'מסלול קירות',
    goal: 'בנה קירות ועבור את המסלול בזמן',
    mechanic: 'wall',
    target: 3,
    unit: 'מסלולים',
  },
  {
    id: 'strip-duel',
    he: 'קרב חטיפה',
    goal: 'חטוף את הכדור מהיריב בלי לאבד אותו',
    mechanic: 'strip',      // MECHANICS.md aimed-shot strip
    target: 5,
    unit: 'חטיפות',
  },
  {
    id: 'super-cycle',
    he: 'מחזור סופר',
    goal: 'נצל את שלושת השימושים בסופר בלי לבזבז',
    mechanic: 'super',
    target: 3,
    unit: 'מחזורים מושלמים',
  },
];

// ---- TECHNIQUES -------------------------------------------------------------------------------
// `effect` is a machine-readable hint for the sim/client hook that implements the ability. It names a
// CAPABILITY, never a magnitude — see the rule at the top of this file.
export const TECHNIQUES = [
  {
    id: 'feint',
    he: 'פיינט',
    kind: 'ability',
    drill: 'charge-control',
    effect: 'cancel-charge',
    desc: 'שחרר טעינה בלי לבעוט — מכר בעיטה מדומה והמשך לרוץ',
  },
  {
    id: 'banana',
    he: 'בננה',
    kind: 'ability',
    drill: 'bend-wall',
    effect: 'curve-kick',
    desc: 'עקם את הכדור סביב מגן או קיר',
  },
  {
    id: 'cook',
    he: 'בישול פצצה',
    kind: 'ability',
    drill: 'bomb-timing',
    effect: 'hold-fuse',
    desc: 'החזק את הפצצה כדי לקצר את הפתיל ולפוצץ בתזמון שלך',
  },
  {
    id: 'vault',
    he: 'דילוג קיר',
    kind: 'ability',
    drill: 'wall-course',
    effect: 'hop-own-wall',
    desc: 'דלג מעל קיר שבנית במקום להקיף אותו',
  },
  {
    id: 'precise-strip',
    he: 'חטיפה מדויקת',
    kind: 'ability',
    drill: 'strip-duel',
    effect: 'strip-window',
    desc: 'קריאה מושלמת פותחת חלון חטיפה — אותה חטיפה, תזמון סלחני יותר',
  },
  {
    id: 'chain-super',
    he: 'שרשור סופר',
    kind: 'ability',
    drill: 'super-cycle',
    effect: 'carry-super-use',
    desc: 'שימוש שלא נוצל נשמר למחזור הסופר הבא',
  },
];

function asArray(v) { return Array.isArray(v) ? v : []; }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

export function techniqueById(id) { return TECHNIQUES.find((t) => t.id === id) || null; }
export function drillById(id) { return DRILLS.find((d) => d.id === id) || null; }
export function techniqueForDrill(drillId) { return TECHNIQUES.find((t) => t.drill === drillId) || null; }

// The medal a given score earns on a given drill, or null for a failed attempt.
export function medalFor(drillId, score) {
  const d = drillById(drillId);
  if (!d) return null;
  const s = Math.max(0, num(score));
  if (s >= d.target * MEDAL_AT.gold) return 'gold';
  if (s >= d.target * MEDAL_AT.silver) return 'silver';
  if (s >= d.target * MEDAL_AT.bronze) return 'bronze';
  return null;
}

// Persisted shape: { drills: { [drillId]: { best, attempts } } }. Medals and unlocks are DERIVED from
// `best` rather than stored, so there's a single source of truth and no way for the two to disagree.
export function emptyDrillState() { return { drills: {} }; }

function drillsOf(state) {
  const d = state && state.drills;
  return (d && typeof d === 'object' && !Array.isArray(d)) ? d : {};
}

export function drillProgress(state, drillId) {
  const row = drillsOf(state)[drillId];
  const best = Math.max(0, num(row && row.best));
  return { best, attempts: Math.max(0, num(row && row.attempts)), medal: medalFor(drillId, best) };
}

// Record one attempt. Returns NEW state (never mutates). `best` only ever climbs — a later bad run
// cannot take away a medal or a technique, because you don't unlearn a skill you've demonstrated.
export function recordDrillResult(state, drillId, score) {
  const next = { drills: { ...drillsOf(state) } };
  if (!drillById(drillId)) return next; // unknown drill — ignore rather than throw
  const prev = next.drills[drillId] || { best: 0, attempts: 0 };
  next.drills[drillId] = {
    best: Math.max(Math.max(0, num(prev.best)), Math.max(0, num(score))),
    attempts: Math.max(0, num(prev.attempts)) + 1,
  };
  return next;
}

// A technique is unlocked once its drill has earned at least BRONZE.
export function isUnlocked(state, techniqueId) {
  const t = techniqueById(techniqueId);
  if (!t) return false;
  return drillProgress(state, t.drill).medal != null;
}

export function unlockedTechniques(state) {
  return TECHNIQUES.filter((t) => isUnlocked(state, t.id));
}

export function techniqueCount(state) { return unlockedTechniques(state).length; }

// Set of `effect` strings the sim/client should enable for this player. The sim reads THIS, never the
// drill state, so the gameplay hooks stay decoupled from how techniques are earned.
export function activeEffects(state) {
  return new Set(unlockedTechniques(state).map((t) => t.effect));
}

export { asArray };

// ================================================================================================
// EFFECT HELPERS — pure math for the six abilities. NO sim state, NO mutation of anything passed in.
// ================================================================================================
// Every function here exists so the corresponding change inside shared/sim.js is ONE line. That is the
// whole point: sim.js is shared by the server and every client, so an ability's *rules* belong in a
// file that can be unit-tested in isolation, and only the *hook* belongs in the sim.
//
// Rule of the file (see the header): these helpers may change WHAT you can do or WHERE something goes.
// None of them may make a player numerically stronger — the tests in test-technique-effects.mjs assert
// that directly (a curve conserves the ball's speed; a clean strip has the same power; the super bank
// is capped at what you already earned).

// The effect id of each technique, by name, so a hook site never spells a string literal.
export const EFFECT = Object.freeze({
  FEINT: 'cancel-charge',
  CURVE: 'curve-kick',
  COOK: 'hold-fuse',
  VAULT: 'hop-own-wall',
  STRIP: 'strip-window',
  CHAIN: 'carry-super-use',
});

const EFFECT_IDS = new Set(TECHNIQUES.map((t) => t.effect));

// Is `id` active for this player? `effects` is whatever the roster handed the sim: a Set (from
// activeEffects) or an Array (anything that crossed JSON — a Set serialises to `{}`, so the wire /
// room-state path MUST use the array form; see effectList). Anything else, including undefined for a
// player who predates the feature, is simply "no techniques".
export function hasEffect(effects, id) {
  if (!effects || !EFFECT_IDS.has(id)) return false;
  if (effects instanceof Set) return effects.has(id);
  return Array.isArray(effects) && effects.includes(id);
}

// JSON-safe form of activeEffects — this is what belongs on a roster message / in room state.
export function effectList(state) { return [...activeEffects(state)]; }

// ---- feint (cancel-charge) ---------------------------------------------------------------------
// Dropping a charge without kicking is ALREADY free in the sim (release `hold` without `fire`), but it
// is silent: nothing reaches the other clients, so there is nothing to sell. The ability is therefore
// the BROADCAST TELL — the same `firing` flag a real kick raises (wire flags bit 0) with no ball
// leaving your feet. That is why it needs no new wire field and no new physics.
export const FEINT_MIN_CHARGE = QUICK_CHARGE; // a fake has to LOOK like a real windup, so it needs one
export const FEINT_CD = 0.6;                  // ...and can't strobe: one fake per this many seconds

// The exact patch to Object.assign onto the player, or null if the feint is not allowed. Returning a
// patch (instead of taking the player) is what keeps this testable and keeps sim.js to one line — and
// the key whitelist is asserted in the tests, so this can never quietly grow to touch other state.
export function feintPatch(view) {
  const v = view || {};
  if (!hasEffect(v.effects, EFFECT.FEINT)) return null;
  if (num(v.charge) < FEINT_MIN_CHARGE) return null; // nothing wound up = nothing to fake
  if (num(v.cd) > 0) return null;                    // still cooling down
  return { _charge: 0, _superLatched: false, firing: true, feintCd: FEINT_CD };
}

// ---- banana (curve-kick) ----------------------------------------------------------------------
// A curve is a ROTATION of the ball's velocity, never a change to its magnitude: bending a shot must
// not also make it harder, or the technique becomes the stat buff this whole system refuses to be.
// Total bend at full spin ≈ CURVE_RATE / ln(1/CURVE_DECAY) ≈ 1.5/3.0 ≈ 0.5 rad (~29°) — enough to
// come round a defender or a wall corner, nowhere near enough to boomerang.
export const CURVE_RATE = 1.5;   // rad/s of turn at |spin| = 1
export const CURVE_DECAY = 0.05; // fraction of the spin retained per second (a bend, not an orbit)

function clampSpin(s) { const n = num(s); return n > 1 ? 1 : n < -1 ? -1 : n; } // a hacked client cannot send spin 99

// One integration step of a curving ball. Returns the new velocity and the decayed spin. Spin 0 is the
// EXACT identity (same numbers back), so calling this on every ball in the game costs nothing and
// changes nothing for the 99% of kicks that have no curve.
export function curveStep(vx, vy, spin, dt) {
  const s = clampSpin(spin);
  if (!s) return { vx, vy, spin: 0 };
  const d = num(dt);
  if (d <= 0) return { vx, vy, spin: s };
  const a = CURVE_RATE * s * d;
  const c = Math.cos(a), sn = Math.sin(a);
  return { vx: vx * c - vy * sn, vy: vx * sn + vy * c, spin: s * Math.pow(CURVE_DECAY, d) };
}

// ---- cook (hold-fuse) --------------------------------------------------------------------------
// Cooking a grenade — hold it after pulling the pin so it lands with a burnt-down fuse and can't be
// dodged or thrown back — with the risk that makes it fair: hold too long and it goes off in your
// hand. (Call of Duty MW3 is the reference; see the design doc.)
//
// COOK_GRACE is not flavour, it's the bug fix: aiming a lob in this game is ALREADY a press-drag-
// release, i.e. already a hold. Without a grace window, unlocking `cook` would silently start cooking
// every bomb you merely aimed — and eventually blow one up in your hand for aiming too carefully.
export const COOK_GRACE = 0.35;   // seconds of hold that cost nothing (covers a normal aim-drag)
// Floor on the planted fuse. Below ~2 snapshots (SNAPSHOT_RATE 60Hz) the bomb never renders on the
// enemy's screen at all, which reads as a desync rather than as skill. 0.12s is ~7 frames: visible,
// and still far under human reaction time — which is exactly what cooking is for.
export const COOK_MIN_FUSE = 0.12;

function baseFuseOf(v) { const n = num(v); return n > 0 ? n : BOMB.fuse; }
function cookBurn(heldSec) { return Math.max(0, num(heldSec) - COOK_GRACE); }

// The fuse a bomb should be planted with after `heldSec` of holding the button.
export function cookedFuse(baseFuse, heldSec) {
  const base = baseFuseOf(baseFuse);
  return Math.max(COOK_MIN_FUSE, base - cookBurn(heldSec));
}
// Held past the WHOLE fuse: it detonates in your hand. The sim's job at that point is to ignore the
// lob and plant at the planter's feet with fuse 0 — which, with bomberOnCenter already true there,
// means you eat your own blast and launch. That risk is what keeps cook from being a free upgrade.
export function cookOverdone(baseFuse, heldSec) {
  return cookBurn(heldSec) >= baseFuseOf(baseFuse);
}

// ---- vault (hop-own-wall) ----------------------------------------------------------------------
// Fortnite's hurdle: run into a low obstacle and you go over it, keeping your momentum. Modelled the
// same way — as an absence of collision, not as an airborne state — because a timed "in the air"
// window is what produces players ejected inside geometry, and because a stateless rule is one the
// client can reproduce exactly (it knows wall.team and its own team) with no new wire field.
// Only YOUR OWN BUILT walls. Never an enemy's (that would delete cover as a mechanic) and never a
// field dry wall (that is arena geometry, not something you put there).
export function vaultsWall(effects, player, wall) {
  if (!wall || !player) return false;
  if (!hasEffect(effects, EFFECT.VAULT)) return false;
  if (wall.field) return false;
  return wall.team === player.team;
}

// The wall list to hand resolveWalls for this player. Returns the SAME ARRAY when nothing is
// vaultable — this sits inside the per-substep movement loop for every player every tick, so the
// common case must not allocate.
export function passableWalls(effects, player, walls) {
  if (!walls || !hasEffect(effects, EFFECT.VAULT)) return walls;
  let any = false;
  for (const w of walls) if (vaultsWall(effects, player, w)) { any = true; break; }
  return any ? walls.filter((w) => !vaultsWall(effects, player, w)) : walls;
}

// ---- precise-strip (strip-window) --------------------------------------------------------------
// The specced version of this technique ("the same strip, more forgiving timing") is a stat buff in
// disguise: a lower charge threshold means you strip balls your opponent cannot. So the effect is
// re-cut to be genuinely horizontal — a precise strip is CLEANER, not stronger. Today a stripped ball
// squirts off to a random side (the sim's only strip randomness); with this technique it comes off
// straight down the line you shot, so the strip is a play you can follow up instead of a coin flip.
// Same power, predictable outcome, and one less Math.random in the sim.
// `roll` stays the CALLER's random draw (the sim owns state.rng), so this function is pure.
export function stripDetachSide(effects, roll) {
  if (hasEffect(effects, EFFECT.STRIP)) return 0;
  return (num(roll) * 2 - 1) * DETACH_SIDE; // unchanged from sim.js today
}

// ---- chain-super (carry-super-use) -------------------------------------------------------------
// A super that lapses with uses left currently destroys them. This banks ONE — conservation, not
// amplification: you can never get more than you earned, and the cap keeps it from becoming a
// stockpile. Deliberately 1 and not SUPER_USES: Supercell moved Brawl Stars Gadgets off banked
// per-match uses onto cooldowns precisely because hoarded charges warp how a match is played.
export const SUPER_BANK_MAX = 1;

// How much of an expiring super's leftover uses survives.
export function bankSuperUses(effects, leftoverUses) {
  if (!hasEffect(effects, EFFECT.CHAIN)) return 0;
  return Math.min(SUPER_BANK_MAX, Math.max(0, Math.floor(num(leftoverUses))));
}
// The uses a freshly-filled super starts with. Without the technique this is exactly SUPER_USES, even
// if a stale bank is sitting on the player — so a lost/removed unlock can never leak power.
export function superUsesOnFill(effects, banked) {
  if (!hasEffect(effects, EFFECT.CHAIN)) return SUPER_USES;
  return SUPER_USES + Math.min(SUPER_BANK_MAX, Math.max(0, Math.floor(num(banked))));
}
