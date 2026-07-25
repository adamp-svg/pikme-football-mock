// RANK display math — the competitive ladder, shown as the tier badge over the hero.
//
// ⚠️ TERMINOLOGY (set 2026-07-25). Two separate progression tracks, don't mix them up:
//   • RANK (this file) — ברונזה…אגדה, CAN GO DOWN, capped by the bot ceiling, human-only at the top.
//     Rendered as the badge over the hero with a small meter inside it (public/hub-rank.js).
//   • גביעים / "trophies" — the MONOTONIC number the player collects, derived from xp. Never drops,
//     pays every match. Rendered as the top-row bar (renderHubXp in client.js).
//   The internal field for rank is `rankPoints`; "trophies" in the UI is the xp track. See
//   pikme-server/data/football-rank.js and summery/research-trophies/00-DECISION.md.
//
// ⚠️ The GAME NEVER COMPUTES A RANK DELTA. pikme-server owns every number and the app injects the
// result as `window.SALTIZ_RANK = { rankPoints, rankTier, delta, botLevel }`. This module only knows
// how to render what arrives.
//
// The ladder constants MUST stay identical to the server's RANK_TIERS / TIER_MIN / botCeiling —
// `test-rank-parity.mjs` fails the build if they drift.

export const RANK_TIERS = ['bronze', 'silver', 'gold', 'platinum', 'diamond', 'champion', 'legend'];
export const TIER_MIN = [0, 200, 500, 900, 1400, 2200, 3200];
// Hebrew tier names for the badge (RTL UI). Same order as RANK_TIERS.
export const TIER_HE = ['ברונזה', 'כסף', 'זהב', 'פלטינה', 'יהלום', 'אלוף', 'אגדה'];
// What each track is CALLED, kept here so copy can't drift between the hub and the post-match screen.
export const RANK_HE = 'דרגה';        // this ladder
export const TROPHIES_HE = 'גביעים';  // the OTHER track (the xp-derived collectible)

const BOT_LEVEL_MAX = 11; // mirrors DIFFICULTY_LEVELS in difficulty.js

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// How far bots at difficulty level L can carry a player. Same formula as the server — a bot match pays
// nothing at or above this, which is what makes the difficulty picker the progression gate.
export function botCeiling(botLevel) {
  const L = Math.max(0, Math.min(BOT_LEVEL_MAX, Math.round(num(botLevel))));
  return 60 + 80 * L;
}

export function tierIndexFromRank(rankPoints) {
  const t = Math.max(0, num(rankPoints));
  let idx = 0;
  for (let i = 0; i < TIER_MIN.length; i++) if (t >= TIER_MIN[i]) idx = i;
  return idx;
}

export function tierNameHe(rankPoints) {
  return TIER_HE[tierIndexFromRank(rankPoints)];
}

// The rank points the meter is counting toward, or null at the top tier.
export function nextTierAt(rankPoints) {
  const idx = tierIndexFromRank(rankPoints);
  return idx >= TIER_MIN.length - 1 ? null : TIER_MIN[idx + 1];
}

// 0..1 fill of the badge's meter toward the next tier. The top tier has nowhere to go, so it reads
// FULL rather than empty — an empty meter at max rank looks like a bug.
export function tierProgress(rankPoints) {
  const t = Math.max(0, num(rankPoints));
  const idx = tierIndexFromRank(t);
  const next = nextTierAt(t);
  if (next == null) return 1;
  const lo = TIER_MIN[idx];
  return Math.max(0, Math.min(1, (t - lo) / (next - lo)));
}

// True when bot matches have stopped paying this player — drives the "raise the difficulty" nudge.
export function atBotCeiling(rankPoints, botLevel) {
  return Math.max(0, num(rankPoints)) >= botCeiling(botLevel);
}

export { BOT_LEVEL_MAX };
