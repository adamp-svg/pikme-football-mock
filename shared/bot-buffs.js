// Card-rarity -> gameplay buff. SINGLE SOURCE, shared on purpose.
//
// The server APPLIES these multipliers (addPlayer buffs) and the settings panel DISPLAYS them
// (public/match-info.js). Those used to be two hand-copied tables, which is exactly how a "+20%"
// on screen drifts away from the +12% the sim is really running. Both ends now import this file.
//
// Slot order is fixed by SLOT_META in client.js: [0] shot / [1] speed / [2] utility.

export const RARITY_BUFF_PCT = { legendary: 0.20, epic: 0.12, rare: 0.07, common: 0.03 };

// Player-facing rarity names, next to the table that gives each rarity its meaning.
// client.js keeps its own HEB_RAR for the album UI — test-bot-buffs.mjs pins the two together.
export const RARITY_LABEL_HE = { legendary: 'אגדי', epic: 'אדיר', rare: 'נדיר', common: 'נפוץ' };

// An empty slot is neutral (0% -> a 1.0 multiplier), never a penalty.
export const pctOf = (slot) => (slot ? (RARITY_BUFF_PCT[slot.r] || 0) : 0);

// Turn a sanitized loadout into the sim multipliers addPlayer understands.
// Shot: faster charge = 1/(1-p). Speed: +p. Utility: shorter cooldowns = (1-p).
export function buffsFromLoadout(loadout) {
  const L = Array.isArray(loadout) ? loadout : [];
  const shot = pctOf(L[0]), speed = pctOf(L[1]), util = pctOf(L[2]);
  return { cardShot: 1 / (1 - shot), speedBuff: 1 + speed, cardUtil: 1 - util };
}

// Sum of a loadout's 3 slot buff %s (0..0.6) — a player's total "card power".
export function loadoutTotalPct(loadout) {
  const L = Array.isArray(loadout) ? loadout : [];
  return pctOf(L[0]) + pctOf(L[1]) + pctOf(L[2]);
}

// --- The EXTREME cheat tier -----------------------------------------------------------------
// At the top of the difficulty ladder a bot does NOT derive its buffs from its cards: it gets a
// flat cheat set that is STRONGER than three legendaries (0.286/0.30/0.35 vs 0.20/0.20/0.20).
// That is why the settings readout inverts the real `buffs` instead of re-reading the rarities —
// reading the cards would under-report a cheating bot by a third.
export const EXTREME_SKILL = 0.95;   // a side scalar at/above this is the cheat tier
export const EXTREME_BOT_BUFFS = { cardShot: 1.4, speedBuff: 1.30, cardUtil: 0.65 };

// Which skill scalar a bot on `team` is playing at: the PARTNER scalar if a human is on its side,
// otherwise the ENEMY scalar. `level` is a DIFFICULTY_LEVELS entry ({enemy, partner}).
export function botSideScalar(level, teamHasHuman) {
  if (!level) return 0;
  return teamHasHuman ? level.partner : level.enemy;
}

// --- Display ---------------------------------------------------------------------------------
// Invert the sim multipliers back into the per-slot percentages a player can read. Exact inverse
// of buffsFromLoadout, so it is correct for card-derived buffs AND for the flat cheat set.
export function buffPercents(buffs) {
  const b = buffs || {};
  const shotMul = Number(b.cardShot) > 0 ? Number(b.cardShot) : 1;
  const speedMul = Number(b.speedBuff) > 0 ? Number(b.speedBuff) : 1;
  const utilMul = Number(b.cardUtil) > 0 ? Number(b.cardUtil) : 1;
  return {
    shot: 1 - 1 / shotMul,   // cardShot = 1/(1-p)
    speed: speedMul - 1,     // speedBuff = 1+p
    util: 1 - utilMul,       // cardUtil = 1-p
  };
}

// Total boost across the 3 slots, as a percentage — the headline "card power" number.
export function totalBoostPct(buffs) {
  const p = buffPercents(buffs);
  return p.shot + p.speed + p.util;
}
