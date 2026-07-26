// RANK math — the competitive ladder, shown as the tier badge over the hero and (since the ranked-event
// slice) PREVIEWABLE before a match starts.
//
// ⚠️ WHAT ACTUALLY PAYS RANK TODAY, because three files used to claim otherwise: EVERY human match in
// EVERY live mode (quick, brawl, 3v3, private, party) pays the g = 0 row — +25 / −20 / +2 — because
// pikme-server's record-match settles unconditionally and its `isRanked` is hard-false. Bot matches pay
// nothing. The "rank only inside a ranked event" gate lands WITH the mode (spec S7): gating on it now
// would take rank to zero for everyone with nothing to replace it. Do not read the design intent below as
// a description of the running system, and do not wire `setRankMode('quick')` on the strength of it —
// that would paint 🔒 "this mode does not move your rank" on a mode that does.
//
// ⚠️ TERMINOLOGY (set 2026-07-25). Two separate progression tracks, don't mix them up:
//   • RANK (this file) — ברונזה…אגדה, CAN GO DOWN, humans-only. Designed to be earned only in a ranked
//     event; today every human match pays it (see above).
//     Rendered as the badge over the hero with a small meter inside it (public/hub-rank.js).
//   • גביעים / "trophies" — the MONOTONIC number the player collects, derived from xp. Never drops,
//     pays every match. Rendered as the top-row bar (renderHubXp in client.js).
//   The internal field for rank is `rankPoints`; "trophies" in the UI is the xp track. See
//   pikme-server/data/football-rank.js and summery/research-trophies/00-DECISION.md.
//
// ⚠️ THE GAME STILL NEVER WRITES A RANK. pikme-server owns every APPLIED number and the app injects the
// result as `window.SALTIZ_RANK`. What this file adds is DISPLAY and PREVIEW:
//   • display — the §2 split ledger (sticky badge over an honest, unfloored raw), so the hub can paint
//     the same number the server stored instead of guessing from `rankPoints` alone.
//   • preview — "beat these two: +80" BEFORE the match. A preview that disagrees with the settle is a
//     bug IN THIS FILE, which is exactly what test-rank-parity.mjs exists to catch.
//
// Every constant and every mirrored function below is COPIED VERBATIM from
// pikme-server/data/football-rank.js. Do not re-derive, do not "simplify", do not retune one side:
// test-rank-parity.mjs compares the constants, the whole table at every gap in both directions, every
// mirrored function, and the full preview pipeline against the server, and FAILS THE BUILD on a drift.
// A constant change is a TWO-REPO change.
//
// Spec: summery/research-trophies/15-RANKED-EVENT-SPEC.md §1 (the absolute upset table) + §2 (the split
// ledger). Tests: test-rank.mjs (values) · test-rank-parity.mjs (cross-repo) · test-hub-rank.mjs (paint).
//
// Browser-safe on purpose: public/client.js imports this over HTTP (`/shared/rank.js`), so NO node:
// imports may ever appear here.

export const RANK_TIERS = ['bronze', 'silver', 'gold', 'platinum', 'diamond', 'champion', 'legend'];
export const TIER_MIN = [0, 200, 500, 900, 1400, 2200, 3200];
// Hebrew tier names for the badge (RTL UI). Same order as RANK_TIERS.
export const TIER_HE = ['ברונזה', 'כסף', 'זהב', 'פלטינה', 'יהלום', 'אלוף', 'אגדה'];
// What each track is CALLED, kept here so copy can't drift between the hub and the post-match screen.
export const RANK_HE = 'דרגה';        // this ladder
export const TROPHIES_HE = 'גביעים';  // the OTHER track (the xp-derived collectible)

const BOT_LEVEL_MAX = 11; // mirrors DIFFICULTY_LEVELS in difficulty.js
const TOP_TIER = TIER_MIN.length - 1;

function num(v, dflt = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// Round away from zero so a -1.6 loss reads as -2, not -1: magnitude first, sign after.
function scale(base, rate) {
  return Math.sign(base) * Math.round(Math.abs(base) * rate);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// §1 — THE ABSOLUTE UPSET TABLE. This table IS the delta; the old per-tier `BANDS` are DELETED.
//
//   g = oppTeamTier − myTeamTier, a FRACTIONAL tier index, clamped ±4 and INTERPOLATED between rows.
//
// The win row is `25 + 20·g` for g ≥ 0 so it is teachable in one Hebrew sentence — כל דרגה מעליך = +20.
// The loss row is solved BACKWARDS from a break-even win rate of ≈ P(win) − 8pp, which makes the
// break-even curve ONE monotone line (86.7% → 4.5%) at every tier instead of a different one per band.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════

// Beating someone 6 tiers up is not worth more than 4 tiers up — the pool that far apart is thin enough
// that the extra range only prices exploits.
export const UPSET_G_CLAMP = 4;
// Index = g + UPSET_G_CLAMP, so index 0 is g = −4 and index 8 is g = +4.
//                              −4   −3  −2  −1   0   +1  +2  +3  +4
export const UPSET_WIN = [4, 6, 9, 15, 25, 45, 65, 85, 105];
export const UPSET_LOSS = [-26, -24, -22, -21, -20, -16, -11, -7, -5];
export const UPSET_DRAW = [-10, -8, -6, -3, 2, 8, 14, 19, 24];
// The g = 0 row, named separately because EVERY bonus is measured against it (rail 4) and because it is
// the value the whole system degrades to while the signed match receipt does not exist yet.
export const UPSET_EVEN_WIN = UPSET_WIN[UPSET_G_CLAMP];    // +25
export const UPSET_EVEN_LOSS = UPSET_LOSS[UPSET_G_CLAMP];  // −20
export const UPSET_EVEN_DRAW = UPSET_DRAW[UPSET_G_CLAMP];  // +2
export const UPSET_WIN_STEP = 20;                          // כל דרגה מעליך = +20

// Team aggregate: T = mean(tierIdx) + TEAM_TOP_WEIGHT × (max − mean), HUMANS ONLY.
// In 2v2 that equals 0.75·max + 0.25·min — but do NOT ship the literal 2v2 form: 3v3 is live and the
// shortcut deletes the middle player ([bronze,bronze,legend] reads 4.50 instead of the correct 4.00).
export const TEAM_TOP_WEIGHT = 0.5;

// Rail 3 — the per-match cap, 0.4 × the width of MY HIGH-WATER tier.
// ⚠️ LEGEND IS 400 FLAT, and this is a real bug the spec caught before it shipped: TIER_MIN has SEVEN
// entries, so TIER_MIN[7] is `undefined`, `0.4 × (undefined − 3200)` is NaN, and a NaN delta is dropped
// silently — a legend would have earned NOTHING, FOREVER, with no error. Hard-coded, and asserted
// finite ×7 in test-rank.mjs (which also asserts the formula IS NaN at legend, so nobody re-derives it).
export const MAX_DELTA_FRACTION = 0.4;
export const MAX_DELTA = [80, 120, 160, 200, 320, 400, 400];

// Rail 4 — the per-player, per-EVENT allowance for POSITIVE gap bonuses. 200 is exactly the sum of the
// four full win bonuses (20+40+60+80): each rung you skip pays full price ONCE per event. A ברונזה
// max-upset win draws 55 (80 − 25), so ~3.6 of them per event.
export const UPSET_BUDGET = 200;

// Rail 1 — lifetime ranked matches before a player's tier is trusted as a gap, applied SYMMETRICALLY:
// an unproven OPPONENT contributes my own frac (g → 0) so it cannot CONFER a bonus, and an unproven ME
// gets g = 0 so I cannot COLLECT one. Gating only the receiving side leaves "make an alt, feed your
// main" wide open, because in that pipe the alt is the LOSER.
export const UPSET_MIN_MATCHES = 5;

// If MY OWN side's internal spread is this many tiers or more, a LOSS is priced at g = 0, so duoing down
// never costs more than a solo even loss. The WIN is deliberately NOT shielded — "the weaker member gets
// more" is a paid boosting service.
export const DUO_SPREAD_SHIELD = 3;

// Rail 6 — below this DISPLAYED standing a loss costs 0. Replaces the deleted BANDS[0].loss = 0: new
// players still cannot go backwards at all. Keyed to TIER_MIN[1] rather than a literal 200 so a ladder
// retune moves it automatically.
//
// ⚠️ IT READS THE DISPLAY, NOT `rankPointsRaw`, and the spec's literal step 6 (which says the raw) is the
// version that shipped and was WRONG: the display is floored at TIER_MIN[rankFloor], so ANY account with
// rankFloor ≥ 1 could drain its raw under 200 and then lose infinitely for exactly 0 while still wearing
// its badge — §2's free-loss sink relocated, not killed. Keyed to the display, the only players shielded
// are the ones the rail is for: a badge still under כסף. The preview must move with the settle or the
// pre-match chip promises a free loss the server will charge. See pikme-server/data/football-rank.js.
export const LOSS_SHIELD_BELOW = TIER_MIN[1];

// Rail 5 — repeat-opponent decay, replacing the OPPONENT_DAILY_LIMIT = 3 cliff. Meeting 1/2/3/4+ pays
// 100/60/30/0%.
//
// ⚠️ THIS SCALES THE FINAL DELTA — GAINS AND LOSSES ALIKE. The rule it replaces did the opposite (it
// gated on `base > 0`, "a loss still costs — farming must never be risk-free"), and inheriting that
// would let one rank-0 alt absorb unlimited tank-losses at the full −26. Symmetric decay IS a partial
// free pass on repeat opponents — saying so out loud because it is a real cost — and the unfloored
// ledger (§2) is what keeps the residual non-zero.
export const MEET_RATES = [1.0, 0.60, 0.30, 0];

// §2 step 9 — matches that must FINISH at or above a tier entry before the sticky floor advances.
// Rail 3 binds only in bronze (80 < the +105 table max), so above bronze the clamp is a no-op and
// 499+105, 899+105, 1399+105, 2199+105 each BOUGHT a permanent badge through the sticky floor.
//
// ⚠️ "RANKED matches" is the spec's wording and NOT what the server counts today: applyRankLedger takes no
// isRanked flag and the route calls it on every settled match, so a QUICK match confirms a rung. That is
// deliberate — `rankedMatches` is hard-0 until S7, so requiring ranked matches would freeze every badge at
// its seeded tier forever — but the "2/3" chip this drives is counting all matches, not ranked ones.
export const FLOOR_CONFIRMATIONS = 3;

// The pre-existing streak rail, mirrored so the preview can include it (the server applies it between
// rails 4 and 5, so a farmed repeat match cannot collect an undecayed streak bonus).
export const STREAK_STEP = 2;   // +2 per consecutive win from the 2nd
export const STREAK_MAX = 10;

// RETIRED 2026-07-26 — mirrors the server, which now returns 0 at every level.
// Rank is HUMANS-ONLY: bot matches pay no rank at any difficulty, so bots carry a player nowhere and
// the difficulty picker is no longer a rank gate. Kept (returning 0) rather than deleted because
// test-rank-parity.mjs asserts this function against the server's at all 12 levels, so the name has to
// retire in both repos in the same commit. See pikme-server/data/football-rank.js.
export function botCeiling(botLevel) {
  void botLevel;
  void BOT_LEVEL_MAX;
  return 0;
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

// ── rail 2: the FRACTIONAL tier index ──────────────────────────────────────────────────────────────
// A float, not a bucket, and that is load-bearing: integer buckets put a +20 cliff (a whole 80% swing on
// the win) on a ONE POINT difference — 899 vs 900. Interpolating cuts that swing to 0.05 points, which
// rounds away entirely. Display it rounded; never compute with the rounded value.
// The top tier is open-ended and has no next threshold, so it reads exactly TOP_TIER (6.00) forever.
export function tierFrac(rankPoints) {
  const p = Math.max(0, num(rankPoints));
  for (let i = TOP_TIER; i >= 0; i--) {
    if (p >= TIER_MIN[i]) {
      if (i >= TOP_TIER) return TOP_TIER;
      const width = TIER_MIN[i + 1] - TIER_MIN[i];
      return width > 0 ? i + (p - TIER_MIN[i]) / width : i;
    }
  }
  return 0;
}

// The HIGH-WATER fractional tier: max(live frac, highest ever reached). Monotone, so TANKING IS WORTH
// EXACTLY 0 — for g, for MAX_DELTA and for the leaderboard. Dumping זהב 899 → 500 would otherwise raise
// your g against the same pool by a full +1.00 = +20/win.
// `rankPeak` ALREADY EXISTS on the server's stats doc, so the high-water needs no new column;
// `rankFracPeak` is accepted for when a finer float is stored later.
export function highWaterFrac({ rankPoints, rankPointsRaw, rankPeak, rankFracPeak } = {}) {
  const live = Math.max(num(rankPoints), num(rankPointsRaw));
  const peak = Math.max(live, num(rankPeak));
  return Math.max(tierFrac(peak), clamp(num(rankFracPeak), 0, TOP_TIER));
}

// Team aggregate, HUMANS ONLY. Returns null for an unknown side so the caller can degrade to g = 0
// instead of silently treating "I don't know" as "bronze".
export function teamTier(fracs) {
  if (!Array.isArray(fracs)) return null;
  const list = fracs.map(Number).filter((n) => Number.isFinite(n)).map((n) => clamp(n, 0, TOP_TIER));
  if (!list.length) return null;
  const mean = list.reduce((a, b) => a + b, 0) / list.length;
  return mean + TEAM_TOP_WEIGHT * (Math.max(...list) - mean);
}

// The widest internal tier spread on one side, used by the duo LOSS shield.
export function tierSpread(fracs) {
  if (!Array.isArray(fracs)) return 0;
  const list = fracs.map(Number).filter((n) => Number.isFinite(n));
  if (list.length < 2) return 0;
  return Math.max(...list) - Math.min(...list);
}

// g = oppTeamTier − myTeamTier, clamped ±4. An unknown side (no receipt yet) is g = 0, never a guess.
// HEADCOUNT DOES NOT MULTIPLY: beating one אגדה in 1v1 and two in 2v2 both aggregate to 6.00, so both pay
// +105. The gap is DISTANCE, not COUNT. A CARRIED bronze therefore gets no bonus either
// (bronze+legend vs bronze+legend is g = 0).
export function upsetGap({ myFracs, oppFracs } = {}) {
  const mine = teamTier(myFracs);
  const theirs = teamTier(oppFracs);
  if (mine === null || theirs === null) return 0;
  return clamp(theirs - mine, -UPSET_G_CLAMP, UPSET_G_CLAMP);
}

function upsetRow(result) {
  return result === 'win' ? UPSET_WIN : result === 'loss' ? UPSET_LOSS : result === 'draw' ? UPSET_DRAW : null;
}

// The table lookup, INTERPOLATED. Returns the unrounded table value; the caller rounds once, at the end,
// after every rate has been applied.
export function upsetDelta(g, result) {
  const row = upsetRow(result);
  if (!row) return 0; // unknown result — pay nothing rather than guess
  const i = clamp(num(g), -UPSET_G_CLAMP, UPSET_G_CLAMP) + UPSET_G_CLAMP;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  if (lo === hi) return row[lo];
  return row[lo] + (i - lo) * (row[hi] - row[lo]);
}

// Rail 3. Takes a tier INDEX (floor of a frac — a 2.9975 is still gold, and must still cap at gold's 160).
export function maxDeltaFor(tierIdx) {
  return MAX_DELTA[clamp(Math.floor(num(tierIdx)), 0, TOP_TIER)];
}

// Rail 5. Meeting 0 means "we don't know who that was" (bot match, or a client too old to send an
// opponentKey) — never taper on ignorance.
export function meetRate(meetings) {
  const m = Math.max(0, Math.round(num(meetings)));
  if (m <= 1) return MEET_RATES[0];
  return MEET_RATES[Math.min(m - 1, MEET_RATES.length - 1)];
}

export function streakBonus(streakAfter) {
  const s = Math.round(num(streakAfter));
  if (s < 2) return 0;
  return Math.min(STREAK_MAX, STREAK_STEP * (s - 1));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// §2 — THE SPLIT LEDGER, DISPLAY SIDE: sticky BADGE over honest POINTS.
//
// The server owns steps 7-9 (applyRankLedger). What the game needs is the same READ so the hub paints
// the stored truth rather than re-deriving a tier from `rankPoints` and disagreeing:
//
//   step 8  rankPoints (shown) = max(rankPointsRaw, TIER_MIN[rankFloor])   ← the badge never drops
//   step 9  the BADGE is min(pointsTier, confirmedFloor)                   ← one bought upset ≠ a badge
//
// "No relegation" is preserved EXACTLY. But a thrown loss is no longer free: 20 of them cost 400 raw
// points the player must re-earn before the badge can move again, and `rankDebt` is what makes that
// visible. Without it a feeder sees an unchanged badge, an unchanged meter, and correctly concludes the
// losses cost nothing.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════

// The unfloored ledger value, defaulting to the legacy `rankPoints` for a doc that has not been migrated
// yet — so a partially-migrated account still renders instead of reading as 0.
function rawStanding({ rankPointsRaw, rankPoints } = {}) {
  return Number.isFinite(Number(rankPointsRaw))
    ? Math.max(0, Math.round(Number(rankPointsRaw)))
    : Math.max(0, Math.round(num(rankPoints)));
}

function floorIndex(rankFloor) {
  return clamp(Math.round(num(rankFloor)), 0, TOP_TIER);
}

// The highest tier the account's OWN STANDING can vouch for: max(raw, display, stored peak) → tier index.
// Mirrors the server's `floorEvidenceIndex` verbatim.
//
// WHY: `rankFloor` is a stored ratchet and step 8 rebuilds the display out of it, so the floor was
// authoritative entirely on its own — and footballPublicStats ships rankFloor to the client. Executed on
// the pre-repair code: an account whose rankPoints, rankPointsRaw and rankPeak were all zeroed still
// painted אגדה here, client-side, with an empty ledger. No match was even needed.
//
// An ABSENT `rankPeak` means NO BOUND (returns TOP_TIER), and that direction is not negotiable on the game
// side: the app injects `rankPoints`/`rankFloor` and no peak, so bounding on ignorance would relegate every
// real badge in the hub. Fail-open here, fail-closed on the server, which is where the write happens.
export function floorEvidenceIndex({ rankPointsRaw, rankPoints, rankPeak } = {}) {
  if (!Number.isFinite(Number(rankPeak))) return TOP_TIER;
  return tierIndexFromRank(Math.max(num(rankPointsRaw), num(rankPoints), num(rankPeak)));
}

// The floor as the ledger actually applies it: the stored ratchet, capped by the evidence.
function effectiveFloorIndex({ rankPointsRaw, rankPoints, rankFloor, rankPeak } = {}) {
  return Math.min(floorIndex(rankFloor), floorEvidenceIndex({ rankPointsRaw, rankPoints, rankPeak }));
}

// STEP 8 — the number the badge, the leaderboard and `g` all read.
export function displayedRank({ rankPointsRaw, rankPoints, rankFloor, rankPeak } = {}) {
  const floor = effectiveFloorIndex({ rankPointsRaw, rankPoints, rankFloor, rankPeak });
  return Math.max(TIER_MIN[floor], rawStanding({ rankPointsRaw, rankPoints }));
}

// How far UNDER the sticky badge the honest ledger has fallen. 0 for everyone who has not thrown matches.
export function rankDebt({ rankPointsRaw, rankPoints, rankFloor, rankPeak } = {}) {
  const floor = effectiveFloorIndex({ rankPointsRaw, rankPoints, rankFloor, rankPeak });
  return Math.max(0, TIER_MIN[floor] - rawStanding({ rankPointsRaw, rankPoints }));
}

// STEP 9 made visible. Mirrors the server's `tierFromRank`: `rankFloor` is OPTIONAL and can only CAP,
// never inflate. Absent, this is the pure points function every pre-ranked call site expects — which is
// also why step 9 is invisible until the floor is actually passed in.
export function badgeTierIndex({ rankPoints, rankFloor } = {}) {
  const byPoints = tierIndexFromRank(rankPoints);
  const f = Number(rankFloor);
  if (!Number.isFinite(f)) return byPoints;
  return Math.min(byPoints, floorIndex(f));
}

// The badge the player has actually CONFIRMED, straight off the ratcheted floor.
export function confirmedTierHe(rankFloor) {
  return TIER_HE[floorIndex(rankFloor)];
}

// The meter has to fill inside the BADGE tier, not the points tier: a player with gold points and a
// silver badge should see a FULL silver meter (promotion pending), not a 34%-through-gold one.
export function tierProgressIn(rankPoints, tierIdx) {
  const idx = clamp(Math.floor(num(tierIdx)), 0, TOP_TIER);
  const lo = TIER_MIN[idx];
  const next = idx >= TOP_TIER ? null : TIER_MIN[idx + 1];
  if (next == null) return 1;
  return clamp((Math.max(0, num(rankPoints)) - lo) / (next - lo), 0, 1);
}

// Everything the hub needs to paint an HONEST badge, in one call, so hub-rank.js does not re-derive any
// of it. `raw` and `debt` are carried alongside the display on purpose: hiding them is what made a
// thrown loss look free.
export function rankBadge({ rankPointsRaw, rankPoints, rankFloor, floorProgress, rankPeak } = {}) {
  const raw = rawStanding({ rankPointsRaw, rankPoints });
  // `rankPeak` is optional and only ever CAPS the floor (see floorEvidenceIndex) — absent, this is exactly
  // the pre-repair behaviour, which is what the hub sees today.
  const points = displayedRank({ rankPointsRaw, rankPoints, rankFloor, rankPeak });
  const floorKnown = Number.isFinite(Number(rankFloor));
  const tierIdx = badgeTierIndex({ rankPoints: points, rankFloor });
  const nextIdx = floorKnown ? effectiveFloorIndex({ rankPointsRaw, rankPoints, rankFloor, rankPeak }) + 1 : -1;
  // "Promoting" = the points already clear the next entry but the confirmations are not in yet. This is
  // the ONLY honest way to render 499+105: gold points, a כסף badge, and a 2/3 chip.
  const promoting = floorKnown && nextIdx <= TOP_TIER && points >= TIER_MIN[nextIdx];
  const done = Math.max(0, Math.round(num(floorProgress)));
  return {
    points,
    raw,
    debt: rankDebt({ rankPointsRaw, rankPoints, rankFloor, rankPeak }),
    tierIdx,
    tierHe: TIER_HE[tierIdx],
    tierName: RANK_TIERS[tierIdx],
    progress: tierProgressIn(points, tierIdx),
    floorKnown,
    promoting,
    promoDone: promoting ? Math.min(done, FLOOR_CONFIRMATIONS) : 0,
    promoNeeded: promoting ? Math.max(0, FLOOR_CONFIRMATIONS - done) : 0,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// THE PREVIEW — "beat these two: +80", computed before the match. §1 rails 1-6, in order.
//
// ⚠️ NO CALLER YET. Nothing in public/ or server.js calls previewMatchDetail / previewMatchDelta /
// previewPayouts — grep before assuming otherwise. The first consumer is the ranked queue screen (S7/S9),
// which does not exist, and today it would promise the even row (+25 / −20 / +2) for every real match
// because no opponent tier is on the wire. The DISPLAY half above (rankBadge) IS live in
// public/hub-rank.js; this half is not. Same split as shared/ranked.js, which flags itself the same way.
//
// ⚠️ DISPLAY ONLY. pikme-server settles every match; this is what the game may PROMISE. It is a
// deliberate mirror of `computeMatchRankDetail`, and test-rank-parity.mjs compares it against the
// server's own function over ~1,900 fixtures — including every degrading shape — so a divergence fails
// the build instead of shipping a chip that lies.
//
// ⚠️ NO `xpFactor`. The server multiplies by the stepped roster grade (0.65/0.80/1.00 for a mixed room);
// a RANKED room is all-human by construction (shared/ranked.js RANKED_ROOM_FLAGS.noBots on all four
// fillBots paths), so the grade is always 1.0 there and taking it as a preview input would only invite a
// caller to preview a match that cannot exist. Parity pins the comparison at xpFactor 1 — if ranked ever
// admits a mixed roster, that pin is what starts failing, which is the intended alarm.
//
// ⚠️ THE OPPONENT'S RANK IS NOT ON THE WIRE TODAY. `opponentKey` is an irreversible per-player hash, not
// a pairing id; `matchStart` is sent five lines BEFORE room.phase = 'match', so it cannot carry a result;
// and the app relay is a fixed literal field list, so no new postMessage field can be added. The answer
// is a receipt signed at MATCH END (spec S6). So EVERY opponent tier here is OPTIONAL and unknown by
// default, and an absent one degrades to EXACTLY the g = 0 row (+25 / −20 / +2). That is what makes this
// shippable today. Nothing may BREAK when it is absent — and nothing may silently PAY either, which is
// why an opponent with no lifetime match count is treated as unproven rather than as a real gap.
//
// `gReason` is the field that stops this going silent: 'no-opponent-tiers' | 'opponent-unproven' |
// 'opponent-tier-unknown' | 'self-unproven' | 'duo-loss-shield' | 'measured' | 'loss-shielded' |
// 'bot-match' | 'first-loss-free' | 'unknown-result'. Log it; never render a gap when gKnown is false.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
export function previewMatchDetail({
  result, rankPoints, rankPointsRaw, rankPeak, rankFracPeak,
  myFrac, myTeamFracs, oppFracs, oppMatches, myMatches,
  upsetBudgetUsed, isRanked,
  isBotMatch, streakAfter, firstLossToday, opponentMeetings, xpFactor,
} = {}) {
  const budgetBefore = clamp(num(upsetBudgetUsed), 0, UPSET_BUDGET);
  // STEP 1 — my own standing. High-water, and an explicit `myFrac` may RAISE the mark but never lower it
  // below what the standing and the stored peak already prove: a myFrac under my own high-water is the
  // tank this rail exists to kill, and a stale 12h token claim would otherwise walk the mark backwards.
  const derivedFrac = highWaterFrac({ rankPoints, rankPointsRaw, rankPeak, rankFracPeak });
  const explicitFrac = Number(myFrac);
  const myF = Number.isFinite(explicitFrac)
    ? Math.max(clamp(explicitFrac, 0, TOP_TIER), derivedFrac)
    : derivedFrac;
  const nothing = (gReason) => ({
    delta: 0, g: 0, gKnown: false, gReason, myFrac: myF, table: 0, even: 0,
    bonus: 0, bonusPaid: 0, bonusCharged: 0, upsetBudgetUsed: budgetBefore,
    meetRate: 1, capped: false, maxDelta: maxDeltaFor(Math.floor(myF)),
  });

  if (!upsetRow(result)) return nothing('unknown-result');
  // ROSTER GRADE. This function has no `rosterRate` — the server's lives in football-xp.js next to the
  // trophy economy, and mirroring it would drag that economy in here (see the xpFactor note above). It
  // used to accept the argument and IGNORE it, which is the silent-over-promise class: at xpFactor 0.80
  // the preview promised +25 where the server pays +20, and at 0.20 it promised +25 against +13. A ranked
  // room is all-human by construction, so the only caller that can hit this is one wiring a live room's
  // reported grade into a queue chip — which must render NOTHING rather than a number that is 25-92% high.
  // A non-numeric xpFactor is ignorance, not a mixed roster, and keeps the shipped default of 1.0.
  const grade = Number(xpFactor);
  if (Number.isFinite(grade) && grade !== 1) return nothing('roster-grade-unknown');
  // HUMANS ONLY. Checked BEFORE any rail, so no rail can leak a bot payout and a forged roster of
  // "legends" cannot mint an upset. A bot match is fully neutral: no gain AND no loss, at every
  // difficulty and every standing — practising must never cost rank.
  if (isBotMatch) return nothing('bot-match');
  // Anti-tilt, and DROPPED INSIDE RANKED: a free daily loss is a free re-roll in a 10-match event.
  if (result === 'loss' && firstLossToday && !isRanked) return nothing('first-loss-free');

  // STEP 1 (cont.) — resolve the opposing side. UPSET_MIN_MATCHES is applied SYMMETRICALLY.
  const mine = (Array.isArray(myTeamFracs) && myTeamFracs.length) ? myTeamFracs : [myF];
  const counts = Array.isArray(oppMatches) ? oppMatches : [];
  let gKnown = Array.isArray(oppFracs) && oppFracs.length > 0;
  let gReason = gKnown ? 'measured' : 'no-opponent-tiers';
  const theirs = (Array.isArray(oppFracs) ? oppFracs : []).map((v, i) => {
    const f = Number(v);
    if (!Number.isFinite(f)) { gKnown = false; gReason = 'opponent-tier-unknown'; return myF; }
    const n = Number(counts[i]);
    if (!Number.isFinite(n) || n < UPSET_MIN_MATCHES) {
      // An unproven opponent contributes MY tier, so it can neither confer a bonus nor a cheap loss.
      gKnown = false; gReason = 'opponent-unproven'; return myF;
    }
    return clamp(f, 0, TOP_TIER);
  });

  // STEP 2 — aggregate, clamp, interpolate.
  let g = upsetGap({ myFracs: mine, oppFracs: theirs });
  const mm = Number(myMatches);
  if (Number.isFinite(mm) && mm < UPSET_MIN_MATCHES) {
    // …and an unproven ME cannot COLLECT one either.
    g = 0; gKnown = false; gReason = 'self-unproven';
  }
  if (result === 'loss' && tierSpread(mine) >= DUO_SPREAD_SHIELD && g !== 0) {
    // Duoing down must never cost MORE than a solo even loss, or helping a friend is a penalty.
    g = 0; gReason = 'duo-loss-shield';
  }

  const table = upsetDelta(g, result);
  const even = upsetDelta(0, result);

  // STEP 3 — the per-match cap, keyed to MY high-water tier (so a tank cannot widen its own cap).
  const cap = maxDeltaFor(Math.floor(myF));
  const capped = Math.abs(table) > cap;
  let d = clamp(table, -cap, cap);

  // STEP 4 — draw a POSITIVE bonus from the event budget.
  // A NEGATIVE bonus is never capped, and neither is the CHEAP LOSS at g > 0: `d − even` is +15 for a
  // −5 loss against a much stronger side, but that is a reduced COST, not points gained, and the spec is
  // explicit that it must survive an empty budget. Hence the `d > 0` half of this condition.
  const bonus = d - even;
  let bonusPaid = 0;
  if (bonus > 0 && d > 0) {
    bonusPaid = Math.min(bonus, Math.max(0, UPSET_BUDGET - budgetBefore));
    d = even + bonusPaid;
  }

  // The pre-existing streak rail, kept, and riding HERE — before the meeting decay — so a farmed repeat
  // match cannot collect an undecayed streak bonus. (The server's roster-grade multiply sits alongside
  // it and is pinned to 1.0 here; see the xpFactor note above.)
  if (result === 'win' && d > 0) d += streakBonus(streakAfter);
  const rate = 1;
  d *= rate;

  // STEP 5 — the meeting multiplier, on the FINAL delta, gains and losses alike.
  const mr = meetRate(opponentMeetings);
  d *= mr;

  let delta = scale(d, 1);
  // STEP 6 — the sub-כסף shield, keyed to the DISPLAYED standing (max of raw and display), NOT the raw
  // alone. See LOSS_SHIELD_BELOW: reading the raw made every floored account an unlimited free-loss sink.
  const rawBase = Number.isFinite(Number(rankPointsRaw)) ? Math.max(0, Number(rankPointsRaw)) : Math.max(0, num(rankPoints));
  const shieldBase = Math.max(rawBase, Math.max(0, num(rankPoints)));
  if (result === 'loss' && shieldBase < LOSS_SHIELD_BELOW) { delta = 0; gReason = 'loss-shielded'; }

  // Charge the budget only for what was actually PAID OUT — a bonus decayed to nothing by the meeting
  // multiplier must not burn the event allowance.
  const bonusCharged = Math.max(0, Math.round(bonusPaid * rate * mr));
  return {
    delta, g, gKnown, gReason, myFrac: myF, table, even,
    bonus, bonusPaid, bonusCharged,
    upsetBudgetUsed: clamp(budgetBefore + bonusCharged, 0, UPSET_BUDGET),
    meetRate: mr, capped, maxDelta: cap,
  };
}

// The integer façade, mirroring the server's `computeMatchRank`.
export function previewMatchDelta(args = {}) {
  return previewMatchDetail(args).delta;
}

// The pre-match question the player actually asks: "what is this match worth?" All three outcomes from
// one standing, so the mode card / queue screen can show `נצחון +80 · הפסד −5` before kickoff. The three
// are alternatives, so they all draw against the SAME upsetBudgetUsed — nothing is spent until a match
// is settled by the server.
export function previewPayouts(args = {}) {
  return {
    win: previewMatchDelta({ ...args, result: 'win' }),
    loss: previewMatchDelta({ ...args, result: 'loss' }),
    draw: previewMatchDelta({ ...args, result: 'draw' }),
  };
}

// `atBotCeiling` was DELETED here on 2026-07-26 and must not come back.
//
// It answered "have bots stopped paying this player", which the humans-only ruling turned into an
// unconditional `true`. That was not harmless: `hub-rank.js` toggled `hub-tier-capped` on
// `botLevel != null && atBotCeiling(...)`, so the hatched meter and the 🔒 latched onto EVERY player's
// badge the moment the app injected a botLevel — a permanent broken-looking lock, shipped by a function
// that had become a constant.
//
// The state it was trying to express — "this mode cannot move your rank" — is real and worth showing,
// but it is a property of the MODE (is this the ranked event?), not of a ceiling that no longer exists.
// `shared/ranked.js` owns that question (`rankLockedForMode`). See
// summery/research-trophies/15-RANKED-EVENT-SPEC.md.

export { BOT_LEVEL_MAX };
