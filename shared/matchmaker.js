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
import { MM_BAND_TOP, MM_ALONE_MS, MM_GRACE_MS } from './constants.js';

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

/** Median of a numeric array, rounded to an integer band. */
function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/**
 * Decide, for this instant, which waiting players become matches.
 *
 * PURE: no Date.now(), no mutation of `tickets`, no I/O. The caller stamps `graceUntil` from
 * `grants` and performs every side effect. That split is what lets the whole policy be tested
 * without a socket server — and per boot-test-server.mjs, socket tests in this repo have produced
 * false GREENS, so keeping policy out of them is not a stylistic preference.
 *
 * @param {Iterable} tickets  {memberId, mode, level, trophies, queuedAt, budgetMs, graceUntil}
 * @param {number} now        ms on the same clock as queuedAt
 * @param {{roomMaxFor:(mode:string)=>number}} opts
 */
export function planMatches(tickets, now, opts) {
  const all = [...tickets];
  const roomMaxFor = opts.roomMaxFor;
  const groups = [], waiting = [], grants = [];
  const taken = new Set();

  // Per mode: formats never mix. A first-to-3 player and a timed player are not playing the same
  // game, so pooling them would produce a match one of them did not choose.
  const byMode = new Map();
  for (const t of all) {
    if (!byMode.has(t.mode)) byMode.set(t.mode, []);
    byMode.get(t.mode).push(t);
  }

  for (const [mode, pool] of byMode) {
    const roomMax = Math.max(1, roomMaxFor(mode) | 0);
    // Cache each ticket's current search width once — it is read O(n) times below.
    const view = new Map();
    for (const t of pool) {
      const graceActive = !!t.graceUntil && now < t.graceUntil;
      const widen = widenFor(now - t.queuedAt, t.budgetMs, graceActive);
      view.set(t.memberId, { level: t.level, widen, graceActive });
    }

    // OLDEST FIRST. Seeding by newest lets a fresh arrival take the partner someone has been
    // waiting nine seconds for, and that player then waits again.
    const order = [...pool].sort((a, b) => a.queuedAt - b.queuedAt);

    for (const seed of order) {
      if (taken.has(seed.memberId)) continue;
      const sv = view.get(seed.memberId);
      const elapsed = now - seed.queuedAt;

      // Everyone still free who accepts the seed AND is accepted by it.
      const mates = order.filter((t) => t.memberId !== seed.memberId && !taken.has(t.memberId)
        && mutuallyCompatible(sv, view.get(t.memberId)));

      const emit = (members, reason) => {
        for (const m of members) taken.add(m.memberId);
        const levels = members.map((m) => m.level);
        const lo = Math.min(...levels), hi = Math.max(...levels);
        groups.push({ mode, memberIds: members.map((m) => m.memberId), reason, level: median(levels), bandLo: lo, bandHi: hi });
      };

      // 1. FULL — every slot human. Resolve now; do not wait out any budget. This is the user's
      //    "4 players for 2v2, no need to wait the full 10 seconds".
      if (1 + mates.length >= roomMax) { emit([seed, ...mates.slice(0, roomMax - 1)], 'full'); continue; }

      const graceUntil = seed.graceUntil || 0;
      const inGrace = graceUntil && now < graceUntil;
      const graceSpent = graceUntil > 0;

      // 2. ALONE — nobody compatible exists, so the search cannot succeed. Resolve fast and say so
      //    rather than running a countdown that is theatre. NOT LATCHED: this is recomputed every
      //    tick, so a ticket that gains company before MM_ALONE_MS keeps its full budget.
      if (!mates.length && !graceSpent && elapsed >= MM_ALONE_MS && elapsed < seed.budgetMs) {
        emit([seed], 'alone'); continue;
      }

      if (inGrace) { /* still extended — fall through to waiting */ }
      else if (elapsed >= seed.budgetMs) {
        // 3. GRACE — the pool is theoretically completable, so one extra window is worth it.
        //    Counted from same-mode tickets within +/-2 levels, NOT from onlineCount(): somebody
        //    idling in the shop must not cost a searching player five seconds.
        const nearby = pool.filter((t) => t.memberId !== seed.memberId && !taken.has(t.memberId)
          && Math.abs(t.level - seed.level) <= 2).length;
        if (!graceSpent && 1 + nearby >= roomMax) {
          grants.push({ memberId: seed.memberId, graceUntil: now + MM_GRACE_MS });
          // Resolved for THIS tick. Without this, every other ticket in the same nearby-but-
          // incompatible cluster (e.g. three mutually-compatible L7s next to a lone L5) would
          // independently re-derive the same "1 + nearby >= roomMax" completability off of a body
          // that is no longer free, and each would grant itself its own grace instead of the L7s
          // grouping with each other below via 'deadline'. It drops out of `waiting` for this one
          // tick too (it reappears with phase 'grace' next tick, once the caller has stamped it).
          taken.add(seed.memberId);
          continue;
        }
        // 4. DEADLINE — out of time. Take whoever is compatible; bots fill the rest.
        emit([seed, ...mates.slice(0, roomMax - 1)], graceSpent ? 'grace' : 'deadline');
        continue;
      }
    }

    // Anyone not grouped this tick is still searching. searchingCount is what the screen shows, and
    // it counts SEARCHERS in this mode — not onlineCount(), which includes people browsing the shop.
    const stillWaiting = pool.filter((t) => !taken.has(t.memberId));
    for (const t of stillWaiting) {
      const v = view.get(t.memberId);
      const band = acceptedBand(t.level, v.widen);
      const phase = v.graceActive ? 'grace' : v.widen > 0 ? 'widened' : 'searching';
      waiting.push({
        memberId: t.memberId, phase, bandLo: band.lo, bandHi: band.hi,
        searchingCount: stillWaiting.length,
        remainingMs: Math.max(0, (v.graceActive ? t.graceUntil - now : t.budgetMs - (now - t.queuedAt))),
      });
    }
  }
  return { groups, waiting, grants };
}
