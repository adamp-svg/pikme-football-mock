// Trophy DISPLAY math — shared by the client hub UI and (later) any server-side lobby badge.
//
// ⚠️ The GAME NEVER COMPUTES A TROPHY DELTA. pikme-server owns every number
// (`data/football-trophies.js`, applied in `/football/record-match`); the app injects the result as
// `window.SALTIZ_TROPHIES = { trophies, trophyTier, delta, botCeiling }`. This module only knows how to
// render what arrives: which tier a count sits in, its Hebrew name, how full the bar to the next tier
// is, and whether bots have stopped paying (the "raise the difficulty" nudge).
//
// The ladder constants below MUST stay identical to the server's TROPHY_TIERS / TIER_MIN / botCeiling.
// `test-trophies-parity.mjs` fails the build if they drift.
// Design: summery/research-trophies/00-DECISION.md

export const TROPHY_TIERS = ['bronze', 'silver', 'gold', 'platinum', 'diamond', 'champion', 'legend'];
export const TIER_MIN = [0, 200, 500, 900, 1400, 2200, 3200];
// Hebrew names for the hub badge (RTL UI). Same order as TROPHY_TIERS.
export const TIER_HE = ['ברונזה', 'כסף', 'זהב', 'פלטינה', 'יהלום', 'אלוף', 'אגדה'];
// What the player-facing number is called, so copy stays consistent across the hub + post-match.
export const TROPHY_HE = 'גביעים';
export const TIER_LABEL_HE = 'דרגה';

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

export function tierIndexFromTrophies(trophies) {
  const t = Math.max(0, num(trophies));
  let idx = 0;
  for (let i = 0; i < TIER_MIN.length; i++) if (t >= TIER_MIN[i]) idx = i;
  return idx;
}

export function tierNameHe(trophies) {
  return TIER_HE[tierIndexFromTrophies(trophies)];
}

// The trophy count the bar is counting toward, or null at the top tier.
export function nextTierAt(trophies) {
  const idx = tierIndexFromTrophies(trophies);
  return idx >= TIER_MIN.length - 1 ? null : TIER_MIN[idx + 1];
}

// 0..1 fill of the bar toward the next tier. Legend has nowhere to go, so it reads full rather than
// empty — an "empty bar at max rank" looks like a bug.
export function tierProgress(trophies) {
  const t = Math.max(0, num(trophies));
  const idx = tierIndexFromTrophies(t);
  const next = nextTierAt(t);
  if (next == null) return 1;
  const lo = TIER_MIN[idx];
  return Math.max(0, Math.min(1, (t - lo) / (next - lo)));
}

// True when bot matches have stopped paying this player, i.e. show the "העלה את רמת הקושי" nudge.
export function atBotCeiling(trophies, botLevel) {
  return Math.max(0, num(trophies)) >= botCeiling(botLevel);
}
