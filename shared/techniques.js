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
