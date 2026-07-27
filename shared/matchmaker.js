// MATCHMAKING POLICY — pure. No sockets, no rooms, no Date.now().
//
// Lives in shared/ and takes `now` as a parameter for one reason: the policy is the part that is
// worth testing, and testing it through a socket server means timers, flakes and (per
// boot-test-server.mjs) false greens from stale processes. server.js owns every side effect.
//
// The band unit is playerLevelFromXp — already shared with the client, and already what the hub bar
// prints as רמה. The game's גביעים number IS its XP number, so "match by trophies" needs no new
// metric.
import { playerLevelFromXp } from './difficulty.js';
import { MM_BAND_TOP } from './constants.js';

/** Trophies -> matchmaking band (1..MM_BAND_TOP). Everything at or above the top collapses. */
export function bandOf(trophies) {
  const lv = playerLevelFromXp(Math.max(0, Number(trophies) || 0));
  return Math.min(MM_BAND_TOP, Math.max(1, lv));
}

/**
 * Which bands a ticket at `level` will accept once widened by `widen` (0|1|2).
 * The FLOOR IS ASYMMETRIC: a level-1 player never accepts anything above L2, however long they wait.
 * At the bottom of the ladder one level is a much larger skill gap than at the top, and a beginner
 * fed to an L3 has a worse time than a beginner who waited.
 */
export function acceptedBand(level, widen) {
  const L = Math.min(MM_BAND_TOP, Math.max(1, level | 0));
  const w = Math.min(2, Math.max(0, widen | 0));
  const lo = Math.max(1, L - w);
  const hi = Math.min(MM_BAND_TOP, L === 1 ? Math.min(2, L + w) : L + w);
  return { lo, hi };
}

/**
 * Both tickets must accept each other. One-sided compatibility is how an L1 who accepts only L1-L2
 * gets dragged into an L3's widened net.
 */
export function mutuallyCompatible(a, b) {
  const A = acceptedBand(a.level, a.widen), B = acceptedBand(b.level, b.widen);
  return b.level >= A.lo && b.level <= A.hi && a.level >= B.lo && a.level <= B.hi;
}

/**
 * How wide a ticket searches, given how long it has waited.
 *   0-40% of its budget -> exact level      ("similarly leveled first")
 *   40-100%             -> +/-1             ("one up one below")
 *   in grace            -> +/-2             ("wait another 5 seconds")
 * Past the budget WITHOUT grace it stays at +/-1: it is resolving this tick, so widening would only
 * pull in a mismatch on the way out the door.
 */
export function widenFor(elapsedMs, budgetMs, graceActive) {
  if (graceActive) return 2;
  const frac = budgetMs > 0 ? elapsedMs / budgetMs : 1;
  return frac < 0.4 ? 0 : 1;
}
