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
  // Tracks a FRESH grant issued this same tick — distinct from `taken` (seated in a group): a
  // just-granted ticket must not be double-counted as a `mates`/`nearby` body for anyone else
  // processed later in this pass, but unlike a seated ticket it still belongs in `waiting` (with a
  // synthetic grace view) and still counts toward everyone else's searchingCount.
  const granted = new Set();

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
      const mates = order.filter((t) => t.memberId !== seed.memberId && !taken.has(t.memberId) && !granted.has(t.memberId)
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

      if (inGrace || elapsed >= seed.budgetMs) {
        // Completability: is the room theoretically reachable from tickets that aren't yet
        // mutually compatible with the seed, but could become so at the max widen (2)? This is
        // what decides whether to GRANT grace, keep an existing grant alive, or REVOKE it early.
        // Reusing mutuallyCompatible (both sides forced to widen 2) rather than raw level distance
        // is load-bearing: acceptedBand's asymmetric floor means an L1 can NEVER become compatible
        // with an L3 even fully widened, so raw "|Δlevel| <= 2" would count an L1 as "nearby" for
        // an L3 (and vice versa) when the room can mathematically never seat both.
        const nearby = pool.filter((t) => t.memberId !== seed.memberId && !taken.has(t.memberId) && !granted.has(t.memberId)
          && mutuallyCompatible({ level: seed.level, widen: 2 }, { level: t.level, widen: 2 })).length;
        const completable = 1 + nearby >= roomMax;

        if (!graceSpent && !inGrace) {
          // 3. GRACE — first time past budget. Grant once if the room is theoretically completable.
          //    A single pass can still justify more than one grant off the same cluster (e.g. two
          //    mutually-incompatible seeds each see enough real headroom once each other's claims
          //    are excluded) — accepted, not a bug, because grace is REVOCABLE below. What must not
          //    happen is one seed's justification silently outliving the bodies it counted on.
          if (completable) {
            grants.push({ memberId: seed.memberId, graceUntil: now + MM_GRACE_MS });
            // Resolved for THIS tick, but NOT "taken": a granted ticket must not be double-counted
            // as a `mates`/`nearby` body by anyone processed later in this pass, but (unlike a
            // seated ticket) it still owes a `waiting` entry and still counts in everyone else's
            // searchingCount — see the granted-ticket branch below.
            granted.add(seed.memberId);
            continue;
          }
          // Not completable — fall straight through to deadline below.
        } else if (inGrace && completable) {
          continue; // still plausible — keep waiting out the window (reported in `waiting` below)
        }
        // 4. DEADLINE / REVOKED / EXPIRED — out of runway one way or another: never granted and not
        //    completable ('deadline'); REVOKED mid-window because the room it was extended for no
        //    longer exists ('grace' — NOT LATCHED, exactly like the alone short-circuit: a futile
        //    wait ends the moment it becomes futile, not just when its window expires); or an
        //    already-EXPIRED grace ('grace', at most once — does not re-grant even if the pool now
        //    looks completable again). Take whoever is compatible; bots fill the rest.
        emit([seed, ...mates.slice(0, roomMax - 1)], graceSpent ? 'grace' : 'deadline');
        continue;
      }
    }

    // Anyone not SEATED this tick is still searching (a fresh grant included — see below).
    // searchingCount is what the screen shows, and it counts SEARCHERS in this mode — not
    // onlineCount(), which includes people browsing the shop.
    const stillWaiting = pool.filter((t) => !taken.has(t.memberId));
    for (const t of stillWaiting) {
      if (granted.has(t.memberId)) {
        // Just granted THIS call: the real ticket's `graceUntil` is still unset (the caller stamps
        // it from `grants` after this returns), so `view` above still reflects its pre-grant state.
        // Report the grant's own terms instead — the +/-2 band it was just handed and the FULL
        // fresh window — not the stale widen-1 band / already-elapsed remainingMs from before it.
        const band = acceptedBand(t.level, 2);
        waiting.push({
          memberId: t.memberId, phase: 'grace', bandLo: band.lo, bandHi: band.hi,
          searchingCount: stillWaiting.length, remainingMs: MM_GRACE_MS,
        });
        continue;
      }
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
