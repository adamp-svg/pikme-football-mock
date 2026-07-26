// THE RANKED MODE RULE — "rank is earned ONLY in ranked events, humans only" (user ruling, 2026-07-26).
//
// shared/rank.js answers "what is this match worth". THIS file answers the question that comes first:
// **does this match count at all?** Which modes pay rank, what a ranked pairing must satisfy, what a
// rage-quit costs, and what the badge says before a player has ever played ranked.
//
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// ⚠️ HALF OF THIS FILE IS LIVE; THE OTHER HALF HAS NO CALLER YET. Know which half you are reading.
//
//   LIVE — imported and called on every hub render by public/hub-rank.js: `isUnranked`, `inPlacements`,
//     `placementsLeft`, `placementLabelHe`, `rankLockedForMode`, plus the Hebrew copy (RANK_UNRANKED_HE,
//     RANKED_PLACEMENTS, RANKED_UNRANKED_SUB_HE). This is the לא מדורג badge. Audit it as shipped code.
//   NO CALLER YET (S7) — the QUEUE/FORFEIT half: `rankedMatchQualifies`, `isRankedSource`,
//     `forfeitResults`, `forfeitResultFor`, `forfeitSettleInputs`, `RANKED_ROOM_FLAGS`,
//     `RANKED_XP_FACTOR`, `eventMatchesLeft`, `rankedMatchesLeft`. Referenced only by test-ranked-mode.mjs.
//
// ⚠️ AND THE RULE THIS FILE STATES IS NOT YET THE RULE THE SERVER APPLIES. `paysRank()` is false for every
// mode a player can launch, but pikme-server's record-match settles rank on EVERY human match in EVERY
// mode (its `isRanked` is hard-false until S7), so today the game and the server disagree on purpose:
// gating the server on this now would take rank to ZERO for every player with nothing to replace it. The
// rule is written and tested first so the queue slice is a WIRING job, not a design job — and until that
// wiring lands, do not hand `rankLockedForMode` a live mode id: it would padlock a mode that does pay.
//
// THE CALLERS THAT WILL SWITCH IT ON, in order:
//   1. `shared/ranked-queue.js` (S7) — bands + the three pairing rules; stamps `source: 'matchmaker'`.
//   2. `server.js` — a ranked room built from RANKED_ROOM_FLAGS: `if (room.noBots) return;` as line 1 of
//      `fillBots` (FOUR call sites: startBuilderMatch, startBotGame, leaveCurrentRoom — which backfills
//      a bot into a LIVE match — and startMatch), plus forfeit-on-leave and forfeit-on-AFK.
//   3. `shared/ranked-receipt.js` (S6) — signs the match-end receipt whose `parts[]` carry the tiers.
//   4. `pikme-server` `POST /handle-user/football/record-ranked` — the only route that may apply a
//      ranked delta. It calls `computeMatchRankDetail` + `applyRankLedger`, not the trophy path.
// Until (1) exists, `paysRank()` is false for everything the player can actually launch — which is this
// file's ANSWER, not the server's behaviour. See the disagreement note above.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
//
// Spec: summery/research-trophies/15-RANKED-EVENT-SPEC.md §3 (the event) + §4 (לא מדורג + the UX).
// Tests: test-ranked-mode.mjs. Browser-safe (no node: imports) — the hub imports it over HTTP.

import { humanRosterIds } from './roster.js';
import { TIER_HE, badgeTierIndex, displayedRank, confirmedTierHe } from './rank.js';

// ── WHICH MODES PAY RANK ───────────────────────────────────────────────────────────────────────────
// One id, used as BOTH the client MODES card id and the server FORMATS key, because every other mode
// already does that (`CARD_TO_FORMAT` maps only the legacy '2v2' → 'quick') and a second name for the
// one mode whose whole point is auditability would be a drift waiting to happen.
export const RANKED_MODE = 'ranked';
export const RANKED_FORMAT = 'ranked';

// 1v1. Spec §3: 1v1 hits a 60s median queue at C ≥ 2 while 2v2 needs C ≥ 6 (12 once split into bands),
// and at PCU ≈ 2–3 for the whole game a 2v2 ranked queue never fills. The cost is named, not hidden:
// the game people actually play is 2v2, so a 1v1 ladder measures a slightly different game. 2v2 ranked
// lands once a real window measures C ≥ 12.
export const RANKED_TEAM_SIZE = 1;

// The allow-list. It is an allow-list and not a deny-list on purpose: a NEW mode must not be able to
// inherit rank by simply existing.
export const RANKED_MODES = Object.freeze([RANKED_MODE]);

// Everything shipped today, enumerated so `paysRank` can be asserted false for each of them one by one.
// Sources: client MODES (`public/client.js`) ids 2v2/brawl/3v3 → server FORMATS keys quick/brawl/3v3,
// plus the `roomJoined.mode` values server.js sends: 'training' | 'builder' | 'botgame' | 'private'.
// 'party' is the private-room game-offer path (`ready` carries `game`).
// ⚠️ ADDING A MODE? Add it HERE, not to RANKED_MODES, unless it is genuinely the ranked event.
export const LIVE_MODES = Object.freeze(['quick', 'brawl', '3v3', 'private', 'party', 'training', 'builder', 'botgame']);

// Does this mode move rank at all? Exact string match — a near-miss ('RANKED') must not smuggle rank in,
// and an ABSENT mode fails CLOSED. That closed default is the opposite of shared/roster.js's isBot
// default (which counts a missing flag as human), and the asymmetry is intended: under-crediting a real
// human is the worse failure there, while paying rank for a match we cannot identify is the worse
// failure here.
export function paysRank(mode) {
  return typeof mode === 'string' && RANKED_MODES.includes(mode);
}

// ── MATCHMAKER-ASSIGNED ONLY ───────────────────────────────────────────────────────────────────────
// Spec §1/§3: no challenges, no private rooms, no accepted invites on the rank track. This is the
// cheapest of the three anti-collusion gates — cheaper than any cap — because a chosen opponent is a
// win-trading pipe by construction, and with upsets paying up to 4.2x the incentive is large.
// The blocked names are the real ones in server.js: `challenge` / `challengeRespond` →
// startChallengeMatch, the `joinCode` path, and `roomJoined { mode: 'private' }`.
export const RANKED_SOURCE = 'matchmaker';
export const UNRANKED_SOURCES = Object.freeze(['challenge', 'invite', 'private', 'code', 'party', 'rematch']);

export function isRankedSource(source) {
  return source === RANKED_SOURCE;
}

// ── DOES THIS FINISHED MATCH COUNT? ────────────────────────────────────────────────────────────────
// Three conditions, checked cheapest-first so the common answer ("no, it's a quick match") costs one
// string compare:
//   1. the ranked MODE
//   2. assigned by the MATCHMAKER
//   3. an ALL-HUMAN roster
//
// ⚠️ THE ROSTER IS JUDGED AT MATCH START, NEVER FROM THE LIVE SNAPSHOT, and this is the difference
// between a working forfeit and a free escape. `checkAfk` (server.js) sets `p.isBot = true` on the SIM
// player after AFK_SECONDS. If this gate read the snapshot, a losing player could stop touching the
// screen for 10 seconds, become a "bot", turn the match into a bot match — which pays ZERO rank — and
// walk away from the loss at no cost. `players` is therefore accepted and DELIBERATELY IGNORED here;
// the AFK/quit case is priced by `forfeitResults` below.
//
//   mode        the room's mode id ('ranked' for the event; 'quick'/'brawl'/… for everything live)
//   source      how the pairing was made — only RANKED_SOURCE qualifies
//   roster      matchStart.players, i.e. the START roster: humans AND bots, each flagged
//   players     the live snapshot. ACCEPTED AND IGNORED — see above
//   teamSize    optional; when given, the headcount must be exactly teamSize × 2
//
// Returns { ok, reason, humanCount, allHuman }. `reason` is always a string, never null, so a caller can
// log WHY a match did not count — a ranked settle that silently pays nothing is the failure mode this
// whole design is trying to avoid.
export function rankedMatchQualifies({ mode, source, roster, players, teamSize } = {}) {
  void players; // ← intentional. See the AFK note above; removing this `void` is a real bug.
  const no = (reason, extra = {}) => ({ ok: false, reason, humanCount: 0, allHuman: false, ...extra });

  if (!paysRank(mode)) return no('not-ranked-mode');
  if (!isRankedSource(source)) return no('not-matchmade');

  const list = Array.isArray(roster) ? roster : null;
  if (!list || !list.length) return no('roster-unknown');
  // An entry with no id cannot be attributed to an account, so the roster is not knowable — not "clean".
  if (list.some((p) => !p || p.id == null)) return no('roster-unknown');
  // Two entries claiming the SAME id is a self-match (or a duplicated connection), never a real pairing.
  const ids = list.map((p) => p.id);
  if (new Set(ids).size !== ids.length) return no('duplicate-ids');

  // The one rule for "who is a human" lives in shared/roster.js and is NOT reimplemented here — it is
  // the same function the client's match report and (next) the server's authoritative count use. Note
  // it counts a MISSING isBot flag as human on purpose; that default is inherited, and it is the single
  // place this gate fails open.
  const humanIds = humanRosterIds(list);
  const humanCount = humanIds.size;
  const allHuman = humanCount === list.length;
  if (!allHuman) return no('roster-has-bots', { humanCount, allHuman });
  if (list.length < 2) return no('too-few-humans', { humanCount, allHuman });
  const size = Number(teamSize);
  if (Number.isFinite(size) && size > 0 && list.length !== size * 2) {
    return no('wrong-headcount', { humanCount, allHuman });
  }
  return { ok: true, reason: 'ok', humanCount, allHuman };
}

// ── THE RANKED ROOM ────────────────────────────────────────────────────────────────────────────────
// Frozen so a room cannot mutate its own ranked-ness at runtime. `noBots` is the flag `fillBots` must
// return early on — spec §6 counts FOUR call sites, including `leaveCurrentRoom`, which backfills a bot
// into a LIVE match. "The word בוט must never appear in the ranked flow."
//
// ⚠️ FOR THE SEAT THAT ADDS THE `FORMATS['ranked']` ROW — and a CORRECTION to spec §8(d), which is
// stale. §8(d) says `roomField` reads `.cleanField` so declaring `field` "achieves nothing". Re-grepped
// at implementation time: server.js:472 runs `for (const f of Object.values(FORMATS)) if (f.field)
// f.cleanField = sanitizeField(f.field)` at boot, so declaring `field` IS the correct and sufficient
// thing to do — exactly as FORMATS['3v3'] does. Declaring a raw `cleanField` by hand would SKIP
// sanitizeField. `roomTeamSize` already handles teamSize 1 and `spawnPos` already handles k === 1
// (shared/sim.js), so a `field` on the row is the only arena work a 1v1 ranked format needs.
// A ranked row that declares NEITHER silently plays on MAIN_FIELD_CLEAN, which is the real trap.
export const RANKED_ROOM_FLAGS = Object.freeze({
  noBots: true,
  isRanked: true,
  teamSize: RANKED_TEAM_SIZE,
  format: RANKED_FORMAT,
});

// A ranked room is all-human by construction, so the server's stepped roster grade is always 1.0 there.
// Pinned as a named constant because the CLIENT's reported xpFactor is not safe to use for a ranked
// settle: `checkAfk` flips `p.isBot`, so an AFK opponent would drop the reported grade to 0.65/0.80 and
// QUIETLY UNDERPAY the player who stayed. shared/rank.js's preview pins the same 1.0.
export const RANKED_XP_FACTOR = 1;

// ── A MID-MATCH RAGE-QUIT IS A FORFEIT ─────────────────────────────────────────────────────────────
// Spec §3: "a ranked leaver FORFEITS (loss at 100% of the band, opponent gets the win); AFK ≥ 10s is a
// forfeit too, not isBot = true." Both halves matter:
//   • 100%, no discount. Quitting must never be cheaper than losing, or every losing position ends in a
//     disconnect. Rocket League and Brawl Stars both price a leave as a full loss.
//   • not isBot. Flagging the leaver a bot would make the match a BOT match, which pays zero rank — the
//     exact free escape the forfeit exists to close.
//
// ⚠️ WHAT ACTUALLY MAKES THIS BITE IS §2's UNFLOORED LEDGER, not this file. Executed against the shipped
// pre-§2 code, `applyRankDelta({ rankPoints: 1400, delta: −26, rankFloor: 4 })` returned 1400: a thrown
// loss at ANY tier entry cost EXACTLY 0, so a "full-price" forfeit at 1400 was still free. The badge
// still never drops, but the raw ledger now takes the hit.
//
// ⚠️ ONE HOLE LEFT, NAMED: below TIER_MIN[1] (200) raw, rail 6 zeroes every loss, so a brand-new player
// CAN quit for free. That is the deliberate no-going-backwards protection for new players, and the
// placement gate (RANKED_PLACEMENTS) plus the 1,000-גביעים entry are what keep it from being a farmable
// alt strategy. Do not "fix" it by exempting forfeits without re-reading spec §1 rail 6.
export const RANKED_FORFEIT_RATE = 1;

// server.js AFK_SECONDS. Mirrored (not imported) because shared/constants.js does not own it and the
// value is a RULE here, not a tuning knob: it is what "put the phone down" costs.
export const RANKED_AFK_FORFEIT_SEC = 10;

const TEAMS = ['A', 'B'];

// Who won and who lost when `quitterTeam` walked out. Returns a per-team result map so one settle can
// write both rows from one event.
export function forfeitResults({ quitterTeam, teams = TEAMS } = {}) {
  const list = Array.isArray(teams) && teams.length === 2 ? teams : TEAMS;
  if (!list.includes(quitterTeam)) {
    // Never guess a loser. An unresolvable forfeit must be logged, not settled.
    return { ok: false, results: null, quitterTeam: null, reason: 'unknown-team' };
  }
  const other = list.find((t) => t !== quitterTeam);
  return {
    ok: true,
    results: { [quitterTeam]: 'loss', [other]: 'win' },
    quitterTeam,
    reason: 'forfeit',
  };
}

// The same answer from one seat's point of view. null when we cannot tell — the caller must not settle.
export function forfeitResultFor({ myTeam, quitterTeam } = {}) {
  const f = forfeitResults({ quitterTeam });
  if (!f.ok || !TEAMS.includes(myTeam)) return null;
  return f.results[myTeam] || null;
}

// Exactly what a forfeit hands to `computeMatchRankDetail` for one player. Spelled out as a function
// rather than left to each call site because three of these four fields are the ones a naive settle gets
// wrong: `isRanked` (drops the free first-loss-of-the-day, which would otherwise be a free re-roll
// inside a 10-match event), `isBotMatch: false` (whatever checkAfk did to the sim player), and
// `xpFactor: 1` (see RANKED_XP_FACTOR).
export function forfeitSettleInputs({ quitterTeam, myTeam } = {}) {
  return {
    result: forfeitResultFor({ myTeam, quitterTeam }),
    isRanked: true,
    isBotMatch: false,
    xpFactor: RANKED_XP_FACTOR,
    forfeit: true,
  };
}

// ── THE EVENT ──────────────────────────────────────────────────────────────────────────────────────
// Placements: the badge is hidden until 3 are played (Rocket League). There is NO separate seeding
// formula — the gap table IS the placement system.
export const RANKED_PLACEMENTS = 3;
// 10 ranked matches per player per event. FUT Champions ships 15/5; 10 × ~4 min ≈ 40 min inside a 75-min
// window. The budget is what keeps attendees RESIDENT, which is what produces the concurrency.
export const RANKED_MATCH_BUDGET = 10;
// Entry gate: 1,000 גביעים — literally XP_TIER_MIN[1], and Brawl Stars' own Ranked gate. No card gate.
export const RANKED_ENTRY_TROPHIES = 1000;

export function eventMatchesLeft({ eventMatches } = {}) {
  const n = Math.max(0, Math.round(Number(eventMatches) || 0));
  return Math.max(0, RANKED_MATCH_BUDGET - n);
}

// ── לא מדורג — HAS THIS PLAYER EVER PLAYED RANKED? ─────────────────────────────────────────────────
// Spec §4, verified: `rankSeeded` is NOT the discriminator. `footballDefaults` sets
// `rankPoints: 0, rankTier: 'bronze', rankSeeded: true` on brand-new accounts too, so a new account and
// a legacy one are indistinguishable by that flag. The real test is:
//
//     unranked = (rankedMatches|0) === 0 && (rankPoints|0) === 0
//
// which reads a legacy account seeded to 640 as RANKED (it shows זהב, unmarked — nobody is reduced) and
// a brand-new account as לא מדורג.
export function hasPlayedRanked({ rankedMatches, rankPoints, rankPointsRaw } = {}) {
  const played = Math.max(0, Math.round(Number(rankedMatches) || 0));
  const pts = Math.max(0, Number(rankPoints) || 0);
  // rankPointsRaw is read too, for a doc migrated to the split ledger before rankPoints is rewritten.
  const raw = Math.max(0, Number(rankPointsRaw) || 0);
  return played > 0 || pts > 0 || raw > 0;
}

export function isUnranked(stats) {
  return !hasPlayedRanked(stats);
}

// In placements = has entered the event but has not finished 3 matches. It requires at least ONE ranked
// match, so a LEGACY seed (rankedMatches 0, rankPoints 640) is NOT "in placements" — it never entered
// the event, and telling a זהב they are unplaced would read as a demotion.
export function inPlacements({ rankedMatches } = {}) {
  const n = Math.max(0, Math.round(Number(rankedMatches) || 0));
  return n >= 1 && n < RANKED_PLACEMENTS;
}

export function placementsLeft({ rankedMatches } = {}) {
  const n = Math.max(0, Math.round(Number(rankedMatches) || 0));
  return Math.max(0, RANKED_PLACEMENTS - n);
}

export const RANK_UNRANKED_HE = 'לא מדורג';
export const RANKED_UNRANKED_SUB_HE = 'שחק 3 משחקי דירוג באירוע הבא כדי לקבל דרגה';
export const RANKED_MODE_HE = 'מדורג';

// The one label the badge, the leaderboard row and the post-match screen must all agree on.
//
// ⚠️ RTL: the placements form contains digits and a slash. Hebrew is RTL, so `דירוג 2/3` renders as
// `דירוג 3/2` unless the UI wraps the number in `<span dir="ltr">`. Same for every rank delta and every
// timer. This function returns TEXT; isolating it is the caller's job — see public/hub-rank.js.
export function placementLabelHe(done, total = RANKED_PLACEMENTS) {
  const n = Math.max(0, Math.round(Number(done) || 0));
  return `דירוג ${n}/${total}`;
}

export function rankLabelHe(stats = {}) {
  if (isUnranked(stats)) return RANK_UNRANKED_HE;
  if (inPlacements(stats)) return placementLabelHe(stats.rankedMatches);
  // Past placements: the CONFIRMED badge, which is min(points tier, ratcheted floor) — so one bought
  // +105 upset lifts the points without painting the next tier. With no floor stored this degrades to
  // the pure points tier, which is what every pre-ranked account has.
  const points = displayedRank(stats);
  const idx = badgeTierIndex({ rankPoints: points, rankFloor: stats.rankFloor });
  return TIER_HE[idx];
}

// Re-exported so a caller that only wants "the badge off the floor" does not have to reach into
// shared/rank.js as well.
export { confirmedTierHe };

// ── "THIS MODE CANNOT MOVE YOUR RANK" ──────────────────────────────────────────────────────────────
// The honest replacement for the DELETED `atBotCeiling`, which had become an unconditional `true` and
// latched `hub-tier-capped` — a hatched meter and a 🔒 — onto every badge the moment the app injected a
// botLevel (which it always does). The state is real; it was just attached to the wrong question. It is
// a property of the MODE, not of a bot ceiling that no longer exists.
//
// ⚠️ AN UNKNOWN MODE PAINTS NO LOCK. "We were not told what this is" must never render as 🔒 — that is
// precisely the bug this replaces. Only a mode we can NAME as unranked earns the lock, which is why
// LIVE_MODES is load-bearing here and not just documentation.
export function rankLockedForMode(mode) {
  if (typeof mode !== 'string' || !mode) return false;
  return LIVE_MODES.includes(mode) && !paysRank(mode);
}
