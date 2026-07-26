import { clampLevel } from './difficulty.js';

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

// --- WHICH CARDS A BOT HOLDS (level → loadout) -----------------------------------------------
// A bot's cards come from ITS OWN difficulty level, never from the human's album. That is a
// deliberate design call, not an oversight — see test-bot-cards.mjs §6 and OPEN_ITEMS P1 #4.
// Lives here rather than in server.js because this file is already the single source for
// rarity→strength, and a second hand-copied rarity table in server.js is exactly the drift this
// module was written to stop.

// Weakest→strongest. The ONE ordering; every rank comparison below indexes into it.
export const RARITY_LADDER = ['common', 'rare', 'epic', 'legendary'];

// Smooth ramp: weak bots pull mostly commons and can have empty slots; strong bots pull epics/
// legendaries and fill up; the top levels are GUARANTEED legendaries. `min`/`max` = card count
// range, `w` = per-slot rarity weights (relative), `leg` = guaranteed legendary slots.
// TUNABLE: endpoints are fixed (L0-1 ~no legendary, L10-11 = 3 legendaries); the curve between
// is free to adjust. Indexed by difficulty level 0..11.
export const RARITY_BY_LEVEL = [
  { min: 0, max: 2, w: { common: 80, rare: 18, epic: 2,  legendary: 0 },   leg: 0 }, // L0
  { min: 1, max: 2, w: { common: 72, rare: 22, epic: 4,  legendary: 2 },   leg: 0 }, // L1
  { min: 1, max: 3, w: { common: 55, rare: 30, epic: 12, legendary: 3 },   leg: 0 }, // L2
  { min: 2, max: 3, w: { common: 42, rare: 33, epic: 18, legendary: 7 },   leg: 0 }, // L3
  { min: 2, max: 3, w: { common: 30, rare: 33, epic: 25, legendary: 12 },  leg: 0 }, // L4
  { min: 2, max: 3, w: { common: 20, rare: 30, epic: 34, legendary: 16 },  leg: 0 }, // L5
  { min: 3, max: 3, w: { common: 12, rare: 26, epic: 40, legendary: 22 },  leg: 0 }, // L6
  { min: 3, max: 3, w: { common: 6,  rare: 20, epic: 44, legendary: 30 },  leg: 0 }, // L7
  { min: 3, max: 3, w: { common: 0,  rare: 14, epic: 46, legendary: 40 },  leg: 1 }, // L8  >=1 guaranteed
  { min: 3, max: 3, w: { common: 0,  rare: 6,  epic: 40, legendary: 54 },  leg: 2 }, // L9  >=2 guaranteed
  { min: 3, max: 3, w: { common: 0,  rare: 0,  epic: 0,  legendary: 100 }, leg: 3 }, // L10 3 legendaries
  { min: 3, max: 3, w: { common: 0,  rare: 0,  epic: 0,  legendary: 100 }, leg: 3 }, // L11 3 legendaries
];

// The album is numbers 1..50 in each rarity (saltiz-cards migration 0003) — bot card ART is drawn
// from that whole range, so a bot's cards look like real cards without being the human's cards.
const CARDS_PER_RARITY = 50;

// THE LADDER'S PROMISE: [floor, ceiling] on a level's TOTAL card power (sum of the 3 slot %s, so
// 0…0.60). The weights above are per-slot and INDEPENDENT, which gave every level an unbounded
// range — a level-8 bot rolled the full 3-legendary loadout 15.9% of the time and a level-2 bot
// could reach 0.60, the same ceiling as "קטלני". Sampling stays (bots must differ from each other);
// the tails get clamped back into the band. Bounds are the pre-fix p5/p95 per level, rounded to
// keep both columns monotone, so ~90% of rolls are untouched and the MEAN barely moves
// (test-bot-cards.mjs §5 pins that). Same shape of fix Clash Royale's "tournament standard" uses —
// clamp the collection to the tier's level rather than let it decide the match.
export const CARD_POWER_BAND = [
  [0.00, 0.10], // L0
  [0.03, 0.16], // L1
  [0.03, 0.23], // L2
  [0.06, 0.29], // L3
  [0.09, 0.35], // L4
  [0.12, 0.40], // L5
  [0.18, 0.46], // L6
  [0.23, 0.52], // L7
  [0.34, 0.56], // L8  ceiling stops short of 0.60 on purpose: 3 legendaries is L9+ only
  [0.43, 0.60], // L9
  [0.60, 0.60], // L10 fixed — leg:3 makes floor == ceiling
  [0.60, 0.60], // L11
];

// The strongest rarity level L is allowed to SHOW: the top rarity with a non-zero weight, or
// legendary outright once the level guarantees one.
export function maxRarityForLevel(level) {
  const spec = RARITY_BY_LEVEL[clampLevel(level)];
  if (spec.leg > 0) return RARITY_LADDER.length - 1;
  return RARITY_LADDER.reduce((m, r, i) => ((spec.w[r] || 0) > 0 ? i : m), 0);
}

// Weighted rarity pick from a level's relative weights.
function weightedRarity(w, rng) {
  const total = (w.common || 0) + (w.rare || 0) + (w.epic || 0) + (w.legendary || 0);
  if (total <= 0) return 'common';
  let r = rng() * total;
  if ((r -= w.common || 0) < 0) return 'common';
  if ((r -= w.rare || 0) < 0) return 'rare';
  if ((r -= w.epic || 0) < 0) return 'epic';
  return 'legendary';
}

// A bot loadout drawn purely from ITS level. Places any guaranteed legendaries, rolls a card count
// in [min,max], fills the rest by weighted rarity, then applies the "make sense" rule. Same
// [s0,s1,s2] shape as sanitizeLoadout, so buffsFromLoadout consumes it directly (display == sim).
// `rng` is injectable so the model is reproducible under test.
export function botLoadoutForLevel(level, rng = Math.random) {
  const L = clampLevel(level);
  const spec = RARITY_BY_LEVEL[L];
  const num = () => 1 + Math.floor(rng() * CARDS_PER_RARITY);
  const out = [null, null, null];
  // Fisher-Yates over the 3 slots, inline: which slot holds which card must not be biased, or
  // "shot" would systematically get the good card and the speed/utility slots the leftovers.
  const slots = [0, 1, 2];
  for (let i = 2; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [slots[i], slots[j]] = [slots[j], slots[i]]; }
  let placed = 0;
  for (let i = 0; i < Math.min(3, spec.leg); i++) out[slots[placed++]] = { r: 'legendary', n: num() };
  const count = Math.max(spec.leg, spec.min + Math.floor(rng() * (spec.max - spec.min + 1)));
  for (; placed < Math.min(3, count); placed++) out[slots[placed]] = { r: weightedRarity(spec.w, rng), n: num() };
  // "Make sense" rule: you cannot have empty slots while holding a card better than RARE. A bot with
  // an epic/legendary must be full — fill every remaining empty with a COMMON (one epic + two commons,
  // never one epic + two empties). A bot whose best card is only common/rare may keep empties.
  const rareIdx = RARITY_LADDER.indexOf('rare');
  const top = out.reduce((m, s) => (s ? Math.max(m, RARITY_LADDER.indexOf(s.r)) : m), -1);
  if (top > rareIdx) for (let s = 0; s < 3; s++) if (!out[s]) out[s] = { r: 'common', n: num() };
  // Guaranteed-legendary slots are the ones placed first; a repair must never eat a guarantee.
  return fitToBand(out, L, spec.leg > 0 ? slots.slice(0, Math.min(3, spec.leg)) : []);
}

// Total card power in integer BASIS POINTS. Summing the 2-decimal pcts in binary floats gives
// 0.03 + 0.07 = 0.09999999999999999, and a band edge compared against that flips the wrong way.
const bpOf = (loadout) => loadout.reduce((s, x) => s + (x ? Math.round(RARITY_BUFF_PCT[x.r] * 100) : 0), 0);
const stepBp = (rarityIdx) => Math.round(RARITY_BUFF_PCT[RARITY_LADDER[rarityIdx]] * 100);

// Walk a rolled loadout back into its level's band, one rarity step at a time.
//
// Emptiness is already decided by the caller and is NEVER changed here — repair only re-rarities
// slots that already hold a card. That is what makes this terminate: each demote strictly lowers the
// total and each promote strictly raises it, so the loop can only move toward the band, and it stops
// the moment a step would carry it past the opposite edge (no oscillation, no "fix" that adds a card
// and re-triggers the fill rule). The 16-step guard is belt-and-braces, not the real bound.
//
// Which slot moves: DEMOTE the strongest (that is the card lying about the level — a legendary on a
// level-2 bot) and PROMOTE the weakest (raising the floor beats gilding an already-good card). Same
// instinct as Brawl Stars handing Ranked players three max-level brawlers: lift the floor, cap the top.
function fitToBand(out, level, guardedSlots) {
  const [loPct, hiPct] = CARD_POWER_BAND[level];
  const lo = Math.round(loPct * 100), hi = Math.round(hiPct * 100);
  const cap = maxRarityForLevel(level);
  const guarded = new Set(guardedSlots);
  for (let guard = 0; guard < 16; guard++) {
    const t = bpOf(out);
    if (t > hi) {
      let pick = -1, pickIdx = -1;
      for (let s = 0; s < 3; s++) {
        if (!out[s] || guarded.has(s)) continue;
        const i = RARITY_LADDER.indexOf(out[s].r);
        if (i > pick) { pick = i; pickIdx = s; }
      }
      if (pickIdx < 0 || pick <= 0) return out;                    // nothing left above common
      const after = t - stepBp(pick) + stepBp(pick - 1);
      if (after < lo) return out;                                  // one step would clear the whole band
      out[pickIdx] = { r: RARITY_LADDER[pick - 1], n: out[pickIdx].n };
      continue;
    }
    if (t < lo) {
      let pick = RARITY_LADDER.length, pickIdx = -1;
      for (let s = 0; s < 3; s++) {
        if (!out[s]) continue;
        const i = RARITY_LADDER.indexOf(out[s].r);
        if (i < pick && i < cap) { pick = i; pickIdx = s; }
      }
      if (pickIdx < 0) return out;                                 // every card already at the level's cap
      const after = t - stepBp(pick) + stepBp(pick + 1);
      if (after > hi) return out;
      out[pickIdx] = { r: RARITY_LADDER[pick + 1], n: out[pickIdx].n };
      continue;
    }
    return out;                                                    // inside the band
  }
  return out;
}
