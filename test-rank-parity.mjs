// CROSS-REPO PARITY: the game's rank ladder (shared/rank.js) must match the server's
// (pikme-server/data/football-rank.js) exactly. Run: node test-rank-parity.mjs
//
// Why this test exists: the server OWNS every applied number, but the game has to draw the tier badge,
// the meter and — since the ranked-event slice — PREVIEW a payout before the match ("beat these two:
// +80"). If the two ladders drift, the hub shows a player as "זהב 480" while the server has already
// promoted them, or the pre-match chip promises +80 and the settle pays +25. Silent, confusing, and
// hard to trace. This fails loudly instead.
//
// ⚠️ IT USED TO GUARD FIVE THINGS (tier names, thresholds, botCeiling ×12, two Hebrew-label checks) and
// that is exactly why the last drift got through: none of the §1 upset table, none of the §2 ledger and
// none of the fractional tier math was covered. It now compares CONSTANTS, the TABLE at every gap in
// both directions (integer AND fractional), every mirrored FUNCTION, and the whole PREVIEW pipeline
// against the server's own computeMatchRank over a fixture matrix.
//
// ⚠️ IT ALSO USED TO EXIT 0 WITH "SKIP" when the sibling checkout was missing. A conditional guard is
// not a guard: the one situation where a drift is most likely (a CI box or a fresh clone that has only
// the game) was the exact situation where the check turned itself off and reported success. Missing
// sibling is now a HARD FAILURE with instructions, not a pass.

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import * as game from './shared/rank.js';
import { RANK_TIERS, TIER_MIN, TIER_HE, botCeiling } from './shared/rank.js';

const require = createRequire(import.meta.url);
const SERVER_MODULE = '../pikme-server/data/football-rank.js';
const serverPath = new URL(SERVER_MODULE, import.meta.url).pathname;

if (!existsSync(serverPath)) {
  console.error(`  ✗ sibling server checkout NOT FOUND at ${SERVER_MODULE} — parity CANNOT be verified.`);
  console.error('    Clone pikme-server next to football-mock (they are siblings, not a dependency).');
  console.error('    This is a hard failure on purpose: a check that turns itself off is not a check,');
  console.error('    and a fresh clone is the most likely place for a rank drift to ship unnoticed.');
  console.error('\n1 FAILURE(S)');
  process.exit(1);
}

const server = require(SERVER_MODULE);

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log('  ✓', msg);
  else { console.error('  ✗', msg); failures++; }
}
function eq(a, b, msg) {
  assert(a === b, `${msg} (game ${JSON.stringify(a)} vs server ${JSON.stringify(b)})`);
}
function eqArr(a, b, msg) {
  const ga = Array.isArray(a) ? a.join(',') : String(a);
  const sa = Array.isArray(b) ? b.join(',') : String(b);
  assert(ga === sa, `${msg} (game [${ga}] vs server [${sa}])`);
}
// A missing export must COUNT as a mismatch, not kill the run on the import line.
function gfn(name) {
  return typeof game[name] === 'function' ? game[name] : () => NaN;
}
const CLOSE = 1e-9;
function near(a, b) {
  if (a === b) return true;
  const x = Number(a); const y = Number(b);
  if (Number.isNaN(x) && Number.isNaN(y)) return true;
  return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) < CLOSE;
}

console.log('── the ladder (was the whole test) ───────────────────────────────────────────');
eqArr(RANK_TIERS, server.RANK_TIERS, 'tier names match');
eqArr(TIER_MIN, server.TIER_MIN, 'tier thresholds match');

// Every difficulty level, not just the ends — an off-by-one in the formula would slip past a 2-point check.
let ceilMismatch = null;
for (let L = 0; L <= 11; L++) {
  if (botCeiling(L) !== server.botCeiling(L)) { ceilMismatch = `L${L}: game ${botCeiling(L)} vs server ${server.botCeiling(L)}`; break; }
}
assert(ceilMismatch === null, `botCeiling matches at every difficulty level 0..11${ceilMismatch ? ' — ' + ceilMismatch : ''}`);

// A Hebrew name for every tier the server can return, or the badge renders blank.
assert(TIER_HE.length === server.RANK_TIERS.length, 'a Hebrew label exists for every server tier');
assert(TIER_HE.every((s) => typeof s === 'string' && s.length > 0), 'no Hebrew label is empty');

console.log('── §1 CONSTANTS — the game must COPY these, never re-derive them ─────────────');
eq(game.UPSET_G_CLAMP, server.UPSET_G_CLAMP, 'UPSET_G_CLAMP');
eqArr(game.UPSET_WIN, server.UPSET_WIN, 'UPSET_WIN row');
eqArr(game.UPSET_LOSS, server.UPSET_LOSS, 'UPSET_LOSS row');
eqArr(game.UPSET_DRAW, server.UPSET_DRAW, 'UPSET_DRAW row');
eq(game.UPSET_EVEN_WIN, server.UPSET_EVEN_WIN, 'UPSET_EVEN_WIN');
eq(game.UPSET_EVEN_LOSS, server.UPSET_EVEN_LOSS, 'UPSET_EVEN_LOSS');
eq(game.UPSET_EVEN_DRAW, server.UPSET_EVEN_DRAW, 'UPSET_EVEN_DRAW');
eq(game.UPSET_WIN_STEP, server.UPSET_WIN_STEP, 'UPSET_WIN_STEP (כל דרגה מעליך)');
eq(game.TEAM_TOP_WEIGHT, server.TEAM_TOP_WEIGHT, 'TEAM_TOP_WEIGHT');
eq(game.MAX_DELTA_FRACTION, server.MAX_DELTA_FRACTION, 'MAX_DELTA_FRACTION');
eqArr(game.MAX_DELTA, server.MAX_DELTA, 'MAX_DELTA per tier (legend is 400 FLAT, not a formula)');
eq(game.UPSET_BUDGET, server.UPSET_BUDGET, 'UPSET_BUDGET per player per event');
eq(game.UPSET_MIN_MATCHES, server.UPSET_MIN_MATCHES, 'UPSET_MIN_MATCHES');
eq(game.DUO_SPREAD_SHIELD, server.DUO_SPREAD_SHIELD, 'DUO_SPREAD_SHIELD');
eq(game.LOSS_SHIELD_BELOW, server.LOSS_SHIELD_BELOW, 'LOSS_SHIELD_BELOW');
eqArr(game.MEET_RATES, server.MEET_RATES, 'MEET_RATES decay');
eq(game.FLOOR_CONFIRMATIONS, server.FLOOR_CONFIRMATIONS, 'FLOOR_CONFIRMATIONS');
// The NaN trap, asserted on BOTH sides: if anybody "simplifies" MAX_DELTA back into
// 0.4 × (TIER_MIN[i+1] − TIER_MIN[i]), legend silently earns nothing forever.
assert((game.MAX_DELTA || []).every((v) => Number.isFinite(v)), 'every game MAX_DELTA entry is finite');
assert((server.MAX_DELTA || []).every((v) => Number.isFinite(v)), 'every server MAX_DELTA entry is finite');

console.log('── §1 THE TABLE at every gap, BOTH DIRECTIONS ────────────────────────────────');
// Integer rows first, then quarter-tier fractions — the interpolation is the part a re-implementation
// gets wrong, and a table that only agrees on the 9 integer rows is a table that has already drifted.
for (const result of ['win', 'loss', 'draw']) {
  let bad = null;
  for (let i = -8; i <= 8 && bad === null; i++) {
    const g = i / 2; // −4 … +4 in half-tier steps, so both signs and both halves of every row
    const mine = gfn('upsetDelta')(g, result);
    const theirs = server.upsetDelta(g, result);
    if (!near(mine, theirs)) bad = `g=${g}: game ${mine} vs server ${theirs}`;
  }
  assert(bad === null, `upsetDelta '${result}' matches at every half-tier gap −4…+4${bad ? ' — ' + bad : ''}`);
}
for (const result of ['win', 'loss', 'draw']) {
  let bad = null;
  // Beyond the clamp in both directions, plus the 899-vs-900 hair, plus garbage.
  for (const g of [-9, -6, -4.5, -0.0025, 0.0025, 2.9975, 4.5, 6, 9, NaN, undefined, null, 'x']) {
    const mine = gfn('upsetDelta')(g, result);
    const theirs = server.upsetDelta(g, result);
    if (!near(mine, theirs)) { bad = `g=${JSON.stringify(g)}: game ${mine} vs server ${theirs}`; break; }
  }
  assert(bad === null, `upsetDelta '${result}' matches outside the clamp and on garbage${bad ? ' — ' + bad : ''}`);
}
{
  let bad = null;
  for (const result of ['abandoned', '', null, undefined, 'WIN']) {
    const mine = gfn('upsetDelta')(0, result);
    const theirs = server.upsetDelta(0, result);
    if (!near(mine, theirs)) { bad = `result=${JSON.stringify(result)}: game ${mine} vs server ${theirs}`; break; }
  }
  assert(bad === null, `an unknown RESULT degrades identically in both repos${bad ? ' — ' + bad : ''}`);
}

console.log('── §1 the mirrored FUNCTIONS ─────────────────────────────────────────────────');
function sweep(name, inputs, call) {
  let bad = null;
  for (const inp of inputs) {
    const mine = call(gfn(name), inp);
    const theirs = call(server[name], inp);
    if (!near(mine, theirs)) { bad = `${JSON.stringify(inp)}: game ${mine} vs server ${theirs}`; break; }
  }
  assert(bad === null, `${name} matches over ${inputs.length} inputs${bad ? ' — ' + bad : ''}`);
}
const oneArg = (f, v) => f(v);
sweep('tierFrac', [0, 1, 100, 199, 200, 499, 500, 700, 899, 900, 1399, 1400, 2199, 2200, 3199, 3200, 5000, 999999, -1, NaN, undefined, null, 'abc'], oneArg);
sweep('maxDeltaFor', [-2, -1, 0, 0.5, 1, 1.9, 2, 2.9975, 3, 4, 5, 6, 6.5, 7, 99, NaN, undefined], oneArg);
sweep('meetRate', [0, 1, 2, 3, 4, 5, 9, -1, 1.4, 2.6, NaN, undefined, null], oneArg);
sweep('streakBonus', [-5, -1, 0, 1, 2, 3, 4, 5, 6, 7, 20, NaN, undefined], oneArg);
// `['x', null]` is in here on purpose: Number(null) === 0, so a null entry reads as a BRONZE teammate
// rather than as unknown. Both repos must agree on that quirk or one of them invents a bronze opponent.
sweep('teamTier', [[], [0], [0, 0], [0, 6], [0, 0, 6], [2, 3, 4], [6, 6, 6], [1.5, 2.5], null, undefined, ['x'], [0, 'x'], ['x', null], [-3, 9]], oneArg);
sweep('tierSpread', [[], [2], [0, 6], [1, 2, 3], [4, 4], null, ['x', 2]], oneArg);
sweep('highWaterFrac', [
  {}, { rankPoints: 0 }, { rankPoints: 500 }, { rankPoints: 500, rankPeak: 900 },
  { rankPointsRaw: 100, rankPoints: 200, rankPeak: 0 }, { rankPoints: 0, rankFracPeak: 4.5 },
  { rankPoints: 3200, rankFracPeak: 99 }, { rankPoints: 'x', rankPeak: 'y' },
], oneArg);
// Added by the repair pass: the floor is EVIDENCE-BOUNDED in both repos, and the two must agree on what
// counts as evidence — including that an ABSENT rankPeak is NO bound (TOP_TIER). If one side "fixes" that
// default alone, one repo relegates badges the other keeps.
sweep('floorEvidenceIndex', [
  {}, { rankPeak: 0 }, { rankPeak: 3200 }, { rankPointsRaw: 0, rankPoints: 0, rankPeak: 0 },
  { rankPointsRaw: 1374, rankPoints: 1400, rankPeak: 1400 }, { rankPointsRaw: 1374, rankPoints: 0, rankPeak: 0 },
  { rankPointsRaw: 0, rankPoints: 0 }, { rankPoints: 640, rankPeak: 700 }, { rankPeak: 'x' },
  { rankPeak: NaN }, { rankPointsRaw: 99999, rankPeak: 0 }, { rankPointsRaw: -5, rankPoints: -5, rankPeak: -5 },
], oneArg);
sweep('upsetGap', [
  { myFracs: [0, 0], oppFracs: [6, 6] }, { myFracs: [6], oppFracs: [0] }, { myFracs: [0], oppFracs: null },
  { myFracs: null, oppFracs: [6] }, { myFracs: [0, 6], oppFracs: [0, 6] }, { myFracs: [2], oppFracs: [2.5] },
  {},
], oneArg);

console.log('── the §2 LEDGER, display side: the game must paint what the server stores ────');
{
  // displayedRank / badgeTierIndex are the game's half of steps 8-9. They are compared against the
  // server's applyRankLedger / tierFromRank, which are the authority.
  let bad = null;
  const cases = [
    { rankPointsRaw: 1374, rankFloor: 4 }, { rankPointsRaw: 1500, rankFloor: 4 },
    { rankPointsRaw: 0, rankFloor: 6 }, { rankPointsRaw: 0, rankFloor: 0 },
    { rankPointsRaw: 604, rankFloor: 1 }, { rankPointsRaw: 210, rankFloor: 0 },
    { rankPointsRaw: -50, rankFloor: 0 }, { rankPoints: 640 }, {},
    // Peak-bearing shapes, added by the repair pass. A bare ratchet used to resurrect a wiped account's
    // 3,200 on BOTH sides; now the evidence caps it, and the two must cap it identically.
    { rankPointsRaw: 0, rankPoints: 0, rankPeak: 0, rankFloor: 6 },
    { rankPointsRaw: 0, rankPoints: 0, rankPeak: 3200, rankFloor: 6 },
    { rankPointsRaw: 1374, rankPoints: 1400, rankPeak: 1400, rankFloor: 4 },
    { rankPointsRaw: 100, rankPoints: 200, rankPeak: 250, rankFloor: 1 },
    { rankPointsRaw: 0, rankPoints: 0, rankPeak: 199, rankFloor: 4 },
    { rankPointsRaw: 640, rankPoints: 640, rankPeak: 700, rankFloor: 2 },
  ];
  for (const c of cases) {
    const mine = gfn('displayedRank')(c);
    // delta 0 through the server's own ledger IS the display rule, with nothing else moving.
    const theirs = server.applyRankLedger({ ...c, delta: 0 }).rankPoints;
    if (!near(mine, theirs)) { bad = `${JSON.stringify(c)}: game ${mine} vs server ${theirs}`; break; }
  }
  assert(bad === null, `displayedRank == applyRankLedger(delta 0).rankPoints over ${cases.length} cases${bad ? ' — ' + bad : ''}`);
}
{
  let bad = null;
  const cases = [
    { rankPoints: 604 }, { rankPoints: 604, rankFloor: 1 }, { rankPoints: 250, rankFloor: 4 },
    { rankPoints: 3300, rankFloor: 6 }, { rankPoints: 0, rankFloor: 0 }, { rankPoints: 1400, rankFloor: 4 },
    { rankPoints: 899, rankFloor: 2 }, { rankPoints: 'x', rankFloor: 2 },
  ];
  for (const c of cases) {
    const mine = (game.RANK_TIERS || [])[gfn('badgeTierIndex')(c)];
    const theirs = server.tierFromRank(c);
    if (mine !== theirs) { bad = `${JSON.stringify(c)}: game ${mine} vs server ${theirs}`; break; }
  }
  assert(bad === null, `badgeTierIndex names the same tier as tierFromRank over ${cases.length} cases${bad ? ' — ' + bad : ''}`);
}
{
  let bad = null;
  for (let f = -1; f <= 8; f++) {
    const mine = gfn('confirmedTierHe')(f);
    const idx = server.RANK_TIERS.indexOf(server.confirmedTier(f));
    const theirs = TIER_HE[idx];
    if (mine !== theirs) { bad = `floor ${f}: game ${mine} vs server ${theirs}`; break; }
  }
  assert(bad === null, `confirmedTierHe tracks the server's confirmedTier at every floor${bad ? ' — ' + bad : ''}`);
}
{
  // STEP 9's counter. rankBadge is otherwise built from displayedRank + badgeTierIndex, which are both
  // checked above, but `promoting` is its own claim: the hub renders a "2/3" chip from it, and a chip
  // that fires when the server is NOT counting a confirmation is a promise the ladder will not keep.
  // The server's own tell is applyRankLedger incrementing floorProgress on a zero delta.
  let bad = null;
  const cases = [
    { rankPointsRaw: 604, rankFloor: 1 }, { rankPointsRaw: 250, rankFloor: 1 },
    { rankPointsRaw: 210, rankFloor: 0 }, { rankPointsRaw: 199, rankFloor: 0 },
    { rankPointsRaw: 1374, rankFloor: 4 }, { rankPointsRaw: 2200, rankFloor: 4 },
    { rankPointsRaw: 3200, rankFloor: 6 }, { rankPointsRaw: 99999, rankFloor: 6 },
  ];
  for (const c of cases) {
    const mine = !!(gfn('rankBadge')(c) || {}).promoting;
    const r = server.applyRankLedger({ ...c, delta: 0, floorProgress: 0 });
    const theirs = r.floorProgress > 0 || r.promoted;
    if (mine !== theirs) { bad = `${JSON.stringify(c)}: game promoting=${mine} vs server counting=${theirs}`; break; }
  }
  assert(bad === null, `rankBadge.promoting fires exactly when the server counts a confirmation${bad ? ' — ' + bad : ''}`);
}

console.log('── THE PREVIEW must equal what the server will actually settle ───────────────');
// This is the assertion that would have caught the last drift. The game's previewMatchDelta is compared
// against the server's own computeMatchRank over a fixture matrix.
//
// ⚠️ xpFactor is pinned to 1 and DELIBERATELY not a preview input: a ranked room is all-human by
// construction (shared/ranked.js RANKED_ROOM_FLAGS.noBots), so the roster grade is always 1.0 there.
// If ranked ever admits a mixed roster, this pin is the thing that will start failing — which is the
// point. The preview is display-only; the server still settles.
const PREVIEW_CASES = [];
for (const result of ['win', 'loss', 'draw']) {
  for (const [rp, myFracs] of [[0, [0, 0]], [0, [0]], [250, [1]], [500, [2]], [500, [2, 2]], [899, [2.9975]], [1400, [4]], [3200, [6, 6]], [3200, [6, 0]]]) {
    for (const opp of [null, [0], [6], [6, 6], [2], [5, 5], [3]]) {
      for (const budget of [0, 165, 200]) {
        for (const meets of [0, 1, 2, 3, 4]) {
          for (const streak of [0, 3]) {
            PREVIEW_CASES.push({
              result, rankPoints: rp, rankPointsRaw: rp, myTeamFracs: myFracs,
              oppFracs: opp, oppMatches: opp ? opp.map(() => 50) : null,
              myMatches: 50, upsetBudgetUsed: budget, opponentMeetings: meets,
              streakAfter: streak, isRanked: true,
            });
          }
        }
      }
    }
  }
}
// Plus the degrading / edge shapes, which are where a mirror usually diverges.
PREVIEW_CASES.push(
  { result: 'win', isBotMatch: true, rankPoints: 500, isRanked: true },
  { result: 'loss', isBotMatch: true, rankPoints: 500, isRanked: true },
  { result: 'win', rankPoints: 0, rankPointsRaw: 0, myTeamFracs: [0], oppFracs: [6], oppMatches: [1], myMatches: 50, isRanked: true },
  { result: 'win', rankPoints: 0, rankPointsRaw: 0, myTeamFracs: [0], oppFracs: [6], oppMatches: [50], myMatches: 2, isRanked: true },
  { result: 'win', rankPoints: 0, rankPointsRaw: 0, myTeamFracs: [0], oppFracs: ['x'], oppMatches: [50], myMatches: 50, isRanked: true },
  { result: 'loss', rankPoints: 500, rankPointsRaw: 500, firstLossToday: true, myMatches: 50 },
  { result: 'loss', rankPoints: 500, rankPointsRaw: 500, firstLossToday: true, myMatches: 50, isRanked: true },
  { result: 'loss', rankPoints: 200, rankPointsRaw: 150, myTeamFracs: [0], oppFracs: [0], oppMatches: [50], myMatches: 50, isRanked: true },
  { result: 'nonsense', rankPoints: 500, isRanked: true },
  { result: 'win', rankPoints: 500, rankPeak: 3200, rankPointsRaw: 500, oppFracs: [6], oppMatches: [50], myMatches: 50, isRanked: true },
  {},
);
{
  let bad = null; let n = 0;
  for (const c of PREVIEW_CASES) {
    const mine = gfn('previewMatchDelta')(c);
    const theirs = server.computeMatchRank({ ...c, xpFactor: 1 });
    n++;
    if (mine !== theirs) { bad = `${JSON.stringify(c)}: game ${mine} vs server ${theirs}`; break; }
  }
  assert(bad === null, `previewMatchDelta == computeMatchRank over ${n} fixtures${bad ? ' — ' + bad : ''}`);
}
{
  // The CHIP fields too — "2 דרגות מעליך · ×2.6" is part of the table, not decoration, so g/meetRate/
  // gReason must be the same on both sides or the game explains a number the server did not pay.
  const KEYS = ['delta', 'g', 'gKnown', 'gReason', 'myFrac', 'table', 'even', 'bonusPaid', 'bonusCharged', 'upsetBudgetUsed', 'meetRate', 'capped', 'maxDelta'];
  let bad = null; let n = 0;
  for (const c of PREVIEW_CASES) {
    const mine = gfn('previewMatchDetail')(c) || {};
    const theirs = server.computeMatchRankDetail({ ...c, xpFactor: 1 });
    n++;
    for (const k of KEYS) {
      const same = typeof theirs[k] === 'number' ? near(mine[k], theirs[k]) : mine[k] === theirs[k];
      if (!same) { bad = `${k} on ${JSON.stringify(c)}: game ${JSON.stringify(mine[k])} vs server ${JSON.stringify(theirs[k])}`; break; }
    }
    if (bad) break;
  }
  assert(bad === null, `previewMatchDetail matches all ${KEYS.length} chip fields over ${n} fixtures${bad ? ' — ' + bad : ''}`);
}

{
  // THE xpFactor PIN, made explicit. The sweep above compares at xpFactor 1 because the game has no
  // rosterRate (it lives in football-xp.js, next to the trophy economy). That pin used to hide a real
  // over-promise: the preview IGNORED the argument, so a caller wiring a live room's grade into a queue
  // chip got +25 where the server pays +20 (0.80) or +13 (0.20). The game now REFUSES a grade it cannot
  // apply, and this asserts both halves — the server still applies it, the game still declines to guess.
  const mixed = { result: 'win', rankPoints: 600, rankPointsRaw: 600, myMatches: 50 };
  eq(server.computeMatchRank({ ...mixed, xpFactor: 0.8 }), 20, 'the SERVER applies the 0.80 roster grade');
  eq(server.computeMatchRank({ ...mixed, xpFactor: 0.2 }), 13, 'and the 0.20 one');
  eq(gfn('previewMatchDelta')({ ...mixed, xpFactor: 0.8 }), 0, 'the GAME promises nothing rather than +25');
  eq(gfn('previewMatchDetail')({ ...mixed, xpFactor: 0.2 }).gReason, 'roster-grade-unknown', 'and names why');
  eq(gfn('previewMatchDelta')({ ...mixed, xpFactor: 1 }), server.computeMatchRank({ ...mixed, xpFactor: 1 }),
    'at the all-human 1.0 — the only grade a ranked room can have — the two agree exactly');
}

console.log('── names the game must NOT resurrect ─────────────────────────────────────────');
// BANDS / bandFor / OPPONENT_DAILY_LIMIT were deleted server-side. A cliff and a decay cannot both be
// the rule, and a per-tier band cannot express "upsets pay more" at all. If either name reappears on
// either side, the two repos are describing different games.
assert(server.BANDS === undefined && game.BANDS === undefined, 'BANDS is gone from BOTH repos');
assert(server.bandFor === undefined && game.bandFor === undefined, 'bandFor is gone from BOTH repos');
assert(server.OPPONENT_DAILY_LIMIT === undefined && game.OPPONENT_DAILY_LIMIT === undefined, 'OPPONENT_DAILY_LIMIT is gone from BOTH repos');
assert(game.atBotCeiling === undefined, 'atBotCeiling stays deleted game-side (it padlocked every badge)');

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
