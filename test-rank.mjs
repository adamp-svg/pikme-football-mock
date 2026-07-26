// Game-side RANK math (shared/rank.js). Run: node test-rank.mjs
//
// The SERVER still owns every APPLIED number (pikme-server data/football-rank.js) — the game never
// writes a rank. What the game now also does is DISPLAY and PREVIEW: which tier a standing falls in,
// its Hebrew name, how full the bar is, the honest badge under the split ledger (sticky floor over an
// unfloored raw), and "beat these two: +80" BEFORE the match starts.
//
// Every constant and every function mirrored from the server MUST stay identical to it.
// test-rank-parity.mjs proves that against the sibling checkout, function by function — this file
// pins the values on their own so a drift shows up here too, with a readable expectation.
//
// Spec: summery/research-trophies/15-RANKED-EVENT-SPEC.md §1 (the absolute upset table) + §2 (the
// split ledger). Every number below was taken from EXECUTING the server module, not from the prose.

import * as rankNs from './shared/rank.js'
import {
    RANK_TIERS, TIER_MIN, TIER_HE, botCeiling,
    tierIndexFromRank, tierNameHe, tierProgress, nextTierAt,
} from './shared/rank.js'

let failures = 0
function assert(cond, msg) {
    if (cond) console.log('  ✓', msg)
    else { console.error('  ✗', msg); failures++ }
}
function eq(actual, expected, msg) {
    assert(actual === expected, `${msg} (got ${actual}, want ${expected})`)
}
function close(actual, expected, msg, tol = 0.001) {
    assert(Math.abs(actual - expected) < tol, `${msg} (got ${actual}, want ~${expected})`)
}
// Namespace-guarded lookups: a MISSING export must COUNT as a failure, not kill the run with a
// SyntaxError on the import line (which would report 0 failures for a completely absent module).
function fn(name) {
    return typeof rankNs[name] === 'function' ? rankNs[name] : () => NaN
}
function arr(name) {
    return Array.isArray(rankNs[name]) ? rankNs[name] : []
}

console.log('ladder constants (must match the server):')
eq(RANK_TIERS.length, 7, '7 tiers')
eq(TIER_MIN.join(','), '0,200,500,900,1400,2200,3200', 'tier entry thresholds')
eq(TIER_HE.length, 7, 'a Hebrew name per tier')
eq(TIER_HE[0], 'ברונזה', 'bronze = ברונזה')
eq(TIER_HE[6], 'אגדה', 'legend = אגדה')

console.log('tierIndexFromRank:')
eq(tierIndexFromRank(0), 0, '0 = bronze')
eq(tierIndexFromRank(199), 0, '199 = bronze')
eq(tierIndexFromRank(200), 1, '200 = silver')
eq(tierIndexFromRank(899), 2, '899 = gold')
eq(tierIndexFromRank(900), 3, '900 = platinum')
eq(tierIndexFromRank(3200), 6, '3200 = legend')
eq(tierIndexFromRank(99999), 6, 'above legend stays legend')
eq(tierIndexFromRank(-5), 0, 'negative clamps to bronze')
eq(tierIndexFromRank(undefined), 0, 'missing clamps to bronze')

console.log('tierNameHe:')
eq(tierNameHe(0), 'ברונזה', '0 trophies')
eq(tierNameHe(950), 'פלטינה', '950 trophies')
eq(tierNameHe(5000), 'אגדה', '5000 trophies')

console.log('tierProgress — how full the bar to the next tier is (0..1):')
close(tierProgress(0), 0, 'at the very start of bronze the bar is empty')
close(tierProgress(100), 0.5, 'halfway through bronze (0→200)')
close(tierProgress(199), 0.995, 'just short of silver')
close(tierProgress(200), 0, 'entering silver resets the bar')
close(tierProgress(700), 0.5, 'halfway through gold (500→900)')
close(tierProgress(3200), 1, 'legend has no next tier — the bar reads full')
close(tierProgress(9999), 1, 'and stays full above it')

console.log('nextTierAt — the number the bar is counting toward:')
eq(nextTierAt(0), 200, 'from bronze, next is 200')
eq(nextTierAt(950), 1400, 'from platinum, next is 1400')
eq(nextTierAt(3200), null, 'legend is the top — nothing to count toward')

console.log('botCeiling (same formula as the server: 60 + 80*L):')
// CHANGED 2026-07-26 — rank is HUMANS-ONLY, so bots carry a player nowhere and the ceiling is 0 at
// every difficulty. Mirrors pikme-server/data/football-rank.js; test-rank-parity.mjs asserts the two
// agree at all 12 levels. Server-side spec: pikme-server/test-football-rank-humans.mjs.
eq(botCeiling(0), 0, 'L0 = 0 (was 60)')
eq(botCeiling(5), 0, 'L5 = 0 (was 460)')
eq(botCeiling(11), 0, 'L11 = 0 (was 940)')
eq(botCeiling(50), 0, 'out-of-range level is still 0')

console.log('atBotCeiling is DELETED and must stay deleted:')
// It had become an unconditional `true`, and hub-rank.js used it to latch a hatched meter and a 🔒 onto
// every badge with an injected botLevel. "This mode cannot move your rank" belongs to shared/ranked.js.
assert(rankNs.atBotCeiling === undefined, 'shared/rank.js no longer exports atBotCeiling')

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// §1 — THE ABSOLUTE UPSET TABLE, mirrored so the game can preview a payout.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════

console.log('§1 constants — copied VERBATIM from the server, no re-derivation:')
eq(rankNs.UPSET_G_CLAMP, 4, 'g is clamped to ±4')
eq(arr('UPSET_WIN').join(','), '4,6,9,15,25,45,65,85,105', 'the WIN row, index = g + 4')
eq(arr('UPSET_LOSS').join(','), '-26,-24,-22,-21,-20,-16,-11,-7,-5', 'the LOSS row')
eq(arr('UPSET_DRAW').join(','), '-10,-8,-6,-3,2,8,14,19,24', 'the DRAW row')
eq(rankNs.UPSET_EVEN_WIN, 25, 'the even win (+25) — every bonus is measured against this row')
eq(rankNs.UPSET_EVEN_LOSS, -20, 'the even loss (−20)')
eq(rankNs.UPSET_EVEN_DRAW, 2, 'the even draw (+2)')
eq(rankNs.UPSET_WIN_STEP, 20, 'כל דרגה מעליך = +20 — the one sentence the table has to be teachable in')
eq(rankNs.TEAM_TOP_WEIGHT, 0.5, 'team aggregate weights the top player by 0.5 over the mean')
eq(rankNs.MAX_DELTA_FRACTION, 0.4, 'the per-match cap is 0.4 × my tier width')
eq(arr('MAX_DELTA').join(','), '80,120,160,200,320,400,400', 'the cap per tier — LEGEND IS 400 FLAT')
eq(rankNs.UPSET_BUDGET, 200, 'positive gap bonuses draw from 200 per player per EVENT')
eq(rankNs.UPSET_MIN_MATCHES, 5, 'a tier under 5 lifetime ranked matches is not trusted as a gap')
eq(rankNs.DUO_SPREAD_SHIELD, 3, 'my own side spread ≥ 3 tiers prices a LOSS at g = 0')
eq(rankNs.LOSS_SHIELD_BELOW, TIER_MIN[1], 'below the silver entry a loss costs 0 — derived, not a literal 200')
eq(arr('MEET_RATES').join(','), '1,0.6,0.3,0', 'repeat-opponent decay 100/60/30/0%')
eq(rankNs.FLOOR_CONFIRMATIONS, 3, 'the sticky floor advances after 3 matches held at the entry')

console.log('MAX_DELTA is FINITE at all 7 indices — the NaN trap the spec caught:')
// TIER_MIN has SEVEN entries, so TIER_MIN[7] is undefined and 0.4 × (undefined − 3200) is NaN. A
// legend would have earned nothing, forever, with no error. Both halves asserted: the computed form
// for 0..5, and the trap itself, so nobody "simplifies" MAX_DELTA back into a formula.
for (let i = 0; i < 7; i++) {
    assert(Number.isFinite(arr('MAX_DELTA')[i]), `MAX_DELTA[${i}] is a finite number`)
}
for (let i = 0; i <= 5; i++) {
    eq(arr('MAX_DELTA')[i], 0.4 * (TIER_MIN[i + 1] - TIER_MIN[i]), `MAX_DELTA[${i}] = 0.4 × tier width`)
}
assert(!Number.isFinite(0.4 * (TIER_MIN[7] - TIER_MIN[6])), 'and the formula IS NaN at legend — hence the hard-coded 400')
eq(arr('MAX_DELTA')[6], 400, 'legend caps at 400 FLAT')

console.log('tierFrac — a FLOAT, because integer buckets put a +20 cliff on a 1-point difference:')
close(fn('tierFrac')(0), 0, '0 = 0.00')
close(fn('tierFrac')(100), 0.5, '100 = halfway through bronze')
close(fn('tierFrac')(199), 0.995, '199 = 0.995')
close(fn('tierFrac')(200), 1, '200 = exactly silver')
close(fn('tierFrac')(700), 2.5, '700 = mid gold')
close(fn('tierFrac')(899), 2.9975, '899 = 2.9975, NOT 3 — this is the whole point of the float')
close(fn('tierFrac')(900), 3, '900 = exactly platinum')
close(fn('tierFrac')(3200), 6, '3200 = legend = 6.00')
close(fn('tierFrac')(999999), 6, 'above legend stays 6.00 flat — there is no 8th TIER_MIN to interpolate toward')
close(fn('tierFrac')(-100), 0, 'negative clamps to 0')
close(fn('tierFrac')(undefined), 0, 'missing clamps to 0, never NaN')
close(fn('tierFrac')('abc'), 0, 'garbage clamps to 0, never NaN')

console.log('highWaterFrac — monotone, so TANKING IS WORTH EXACTLY 0:')
close(fn('highWaterFrac')({ rankPoints: 500, rankPeak: 900 }), 3, 'a gold who peaked at platinum still counts as platinum')
close(fn('highWaterFrac')({ rankPoints: 500 }), 2, 'with no peak stored, the live standing is the mark')
close(fn('highWaterFrac')({ rankPointsRaw: 100, rankPoints: 200, rankPeak: 0 }), 1, 'the DISPLAY wins over a lower raw — the badge is what was proven')
close(fn('highWaterFrac')({ rankPoints: 0, rankFracPeak: 4.5 }), 4.5, 'an explicitly stored finer float is honoured')
close(fn('highWaterFrac')({}), 0, 'nothing known = 0, never NaN')

console.log('teamTier — mean + 0.5 × (max − mean), HUMANS ONLY:')
close(fn('teamTier')([0, 0]), 0, 'a bronze pair aggregates to 0.00')
close(fn('teamTier')([0, 6]), 4.5, 'bronze + legend = 4.50 (the 2v2 shortcut 0.75·max + 0.25·min agrees here)')
close(fn('teamTier')([0, 0, 6]), 4, '3v3 bronze+bronze+legend = 4.00 — the 2v2 shortcut would say 4.50 and DELETE the middle player')
eq(fn('teamTier')([]), null, 'an empty side is NULL, not bronze — the caller must degrade to g = 0')
eq(fn('teamTier')(null), null, 'an unknown side is NULL too')
eq(fn('teamTier')(['x']), null, 'all-garbage is NULL, never NaN')
// ⚠️ EXECUTED, not assumed, and a genuine footgun: `Number(null) === 0`, so a null entry is NOT dropped
// as unknown — it reads as a BRONZE teammate. `['x', null]` is therefore a side with one known member at
// 0.00, not an unknown side. Asserted so nobody "fixes" one repo's filter without the other.
eq(fn('teamTier')(['x', null]), 0, 'a null entry reads as bronze 0.00 (Number(null) === 0), it is NOT treated as unknown')

console.log('tierSpread — the duo LOSS shield input:')
close(fn('tierSpread')([0, 6]), 6, 'bronze duoing with a legend is a 6-tier spread')
close(fn('tierSpread')([2]), 0, 'a solo player has no internal spread')
close(fn('tierSpread')([]), 0, 'and neither does an empty side')

console.log('upsetGap — g = oppTeamTier − myTeamTier, clamped ±4:')
close(fn('upsetGap')({ myFracs: [0, 0], oppFracs: [6, 6] }), 4, 'bronze pair vs legend pair = +4')
close(fn('upsetGap')({ myFracs: [6], oppFracs: [0] }), -4, 'legend vs bronze = −4')
close(fn('upsetGap')({ myFracs: [0], oppFracs: null }), 0, 'an UNKNOWN opposing side is g = 0, never a guess')
close(fn('upsetGap')({ myFracs: [0, 6], oppFracs: [0, 6] }), 0, 'a CARRIED bronze gets no bonus — identical sides are g = 0')

console.log('upsetDelta — the table lookup, INTERPOLATED and UNROUNDED:')
const rows = { win: [4, 6, 9, 15, 25, 45, 65, 85, 105], loss: [-26, -24, -22, -21, -20, -16, -11, -7, -5], draw: [-10, -8, -6, -3, 2, 8, 14, 19, 24] }
for (const [result, row] of Object.entries(rows)) {
    for (let i = 0; i < row.length; i++) {
        const g = i - 4
        close(fn('upsetDelta')(g, result), row[i], `${result} at g=${g} pays ${row[i]}`)
    }
}
close(fn('upsetDelta')(0.5, 'win'), 35, 'g=+0.5 interpolates to +35 (between +25 and +45)')
close(fn('upsetDelta')(-0.5, 'win'), 20, 'g=−0.5 interpolates to +20')
close(fn('upsetDelta')(2.5, 'draw'), 16.5, 'the draw row interpolates too')
close(fn('upsetDelta')(-0.5, 'loss'), -20.5, 'and so does the loss row')
close(fn('upsetDelta')(6, 'win'), 105, 'g beyond +4 clamps to the +4 row — distance stops paying past 4 tiers')
close(fn('upsetDelta')(-6, 'loss'), -26, 'and beyond −4 clamps to the −4 row')
eq(fn('upsetDelta')(0, 'abandoned'), 0, 'an unknown result pays NOTHING rather than guessing a row')
close(fn('upsetDelta')(0.0025, 'win'), 25.05, 'the 899-vs-900 case: a ONE POINT difference swings the win by 0.05, not by +20')

console.log('maxDeltaFor — takes a tier INDEX and FLOORS it:')
eq(fn('maxDeltaFor')(0), 80, 'bronze caps at 80')
eq(fn('maxDeltaFor')(2), 160, 'gold caps at 160')
eq(fn('maxDeltaFor')(2.9975), 160, 'a 2.9975 frac is STILL gold — it must not reach platinum 200')
eq(fn('maxDeltaFor')(6), 400, 'legend caps at 400')
eq(fn('maxDeltaFor')(7), 400, 'out of range above clamps to legend')
eq(fn('maxDeltaFor')(-1), 80, 'out of range below clamps to bronze')

console.log('meetRate — repeat-opponent decay, and NEVER a taper on ignorance:')
eq(fn('meetRate')(0), 1, '0 meetings means "we do not know who that was" → full rate')
eq(fn('meetRate')(1), 1, 'first meeting pays 100%')
eq(fn('meetRate')(2), 0.6, 'second pays 60%')
eq(fn('meetRate')(3), 0.3, 'third pays 30%')
eq(fn('meetRate')(4), 0, 'fourth pays 0%')
eq(fn('meetRate')(9), 0, 'and it stays 0 after that')
eq(fn('meetRate')(undefined), 1, 'a missing count is full rate, not zero')

console.log('streakBonus — mirrored so the preview can include it:')
eq(fn('streakBonus')(1), 0, 'a single win is not a streak')
eq(fn('streakBonus')(2), 2, '+2 from the 2nd consecutive win')
eq(fn('streakBonus')(6), 10, 'capped at +10')
eq(fn('streakBonus')(-3), 0, 'a LOSS streak adds nothing')

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// §2 — THE SPLIT LEDGER, display side. The game must paint the same number the server stores.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════

console.log('§2 displayedRank — sticky BADGE over honest POINTS (step 8):')
eq(fn('displayedRank')({ rankPointsRaw: 1374, rankFloor: 4 }), 1400, 'a raw 26 under the diamond entry still DISPLAYS 1400 — the badge never drops')
eq(fn('displayedRank')({ rankPointsRaw: 1500, rankFloor: 4 }), 1500, 'above the floor the raw is shown as-is')
eq(fn('displayedRank')({ rankPointsRaw: 0, rankFloor: 6 }), 3200, 'a legend who dumped everything still shows the legend entry')
eq(fn('displayedRank')({ rankPoints: 640 }), 640, 'no raw and no floor = the legacy field, unchanged (pre-migration accounts)')
eq(fn('displayedRank')({ rankPointsRaw: -50, rankFloor: 0 }), 0, 'a negative raw clamps to 0 — the badge art cannot render below bronze')
eq(fn('displayedRank')({}), 0, 'nothing known = 0, never NaN')

console.log('rankDebt — how far under the badge the honest ledger has fallen:')
// This is the number that makes the ledger VISIBLE. Without it a feeder who threw 20 matches sees an
// unchanged badge and an unchanged meter and correctly concludes the losses were free.
eq(fn('rankDebt')({ rankPointsRaw: 1374, rankFloor: 4 }), 26, '26 raw points must be re-earned before the badge can move again')
eq(fn('rankDebt')({ rankPointsRaw: 1500, rankFloor: 4 }), 0, 'no debt above the floor')
eq(fn('rankDebt')({ rankPointsRaw: 1000, rankFloor: 4 }), 400, '20 thrown losses = 400 points of debt (the whole point of §2)')

console.log('badgeTierIndex — step 9 made VISIBLE: points can outrun the CONFIRMED badge:')
eq(fn('badgeTierIndex')({ rankPoints: 604 }), 2, 'without a floor it is the pure points function every old call site expects')
eq(fn('badgeTierIndex')({ rankPoints: 604, rankFloor: 1 }), 1, 'ONE bought +105 upset lifts the points to gold but the badge stays כסף')
eq(fn('badgeTierIndex')({ rankPoints: 250, rankFloor: 4 }), 1, 'and the floor can only CAP, never inflate — a diamond floor with silver points reads silver')
eq(fn('badgeTierIndex')({ rankPoints: 3300, rankFloor: 6 }), 6, 'a confirmed legend reads legend')

console.log('confirmedTierHe — the badge straight off the ratcheted floor:')
eq(fn('confirmedTierHe')(0), 'ברונזה', 'floor 0 = ברונזה')
eq(fn('confirmedTierHe')(3), 'פלטינה', 'floor 3 = פלטינה')
eq(fn('confirmedTierHe')(6), 'אגדה', 'floor 6 = אגדה')
eq(fn('confirmedTierHe')(99), 'אגדה', 'out of range clamps to the top')
eq(fn('confirmedTierHe')(undefined), 'ברונזה', 'missing clamps to the bottom')

console.log('tierProgressIn — the meter has to fill inside the BADGE tier, not the points tier:')
close(fn('tierProgressIn')(604, 1), 1, '604 points inside a כסף badge reads FULL (the promotion is pending, not absent)')
close(fn('tierProgressIn')(350, 1), 0.5, 'halfway through כסף (200→500)')
close(fn('tierProgressIn')(1400, 4), 0, 'entering יהלום resets it')
close(fn('tierProgressIn')(3200, 6), 1, 'the top tier reads FULL — an empty meter at max rank looks like a bug')

console.log('rankBadge — everything the hub needs to paint an HONEST badge, in one call:')
const badge = fn('rankBadge')({ rankPointsRaw: 1374, rankFloor: 4, floorProgress: 0 })
eq(badge && badge.points, 1400, 'the number shown is the floored display')
eq(badge && badge.raw, 1374, 'the honest ledger is carried alongside it, not hidden')
eq(badge && badge.debt, 26, 'and so is the debt')
eq(badge && badge.tierIdx, 4, 'the badge tier is the confirmed one')
eq(badge && badge.tierHe, 'יהלום', 'with its Hebrew name')
const promo = fn('rankBadge')({ rankPointsRaw: 604, rankFloor: 1, floorProgress: 1 })
eq(promo && promo.tierHe, 'כסף', 'a pending promotion still wears the CONFIRMED badge')
eq(promo && promo.promoNeeded, 2, 'and reports the 2 remaining confirmations, so the UI can show pips')
eq(promo && promo.promoting, true, 'flagged as promoting, which is what a "2/3" chip renders from')
const plain = fn('rankBadge')({ rankPoints: 640 })
eq(plain && plain.points, 640, 'a pre-migration account with only rankPoints still renders')
eq(plain && plain.tierHe, 'זהב', 'at its points tier, because no floor is known')
eq(plain && plain.promoting, false, 'and nothing is claimed about a promotion we cannot see')

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// THE PREVIEW — "beat these two: +80", computed BEFORE the match. Display only; the server settles.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════

console.log('previewMatchDelta — the user\'s own case, executed against the server and mirrored here:')
const RANKED = { isRanked: true, myMatches: 50 }
const bronzePair = { ...RANKED, rankPoints: 0, rankPointsRaw: 0, myTeamFracs: [0, 0] }
eq(fn('previewMatchDelta')({ ...bronzePair, result: 'win', oppFracs: [6, 6], oppMatches: [50, 50] }), 80,
    'ברונזה+ברונזה beat אגדה+אגדה: table +105, bronze cap 80 binds → +80')
eq(fn('previewMatchDelta')({ ...bronzePair, result: 'win', oppFracs: [0, 0], oppMatches: [50, 50] }), 25,
    'ברונזה+ברונזה beat ברונזה+ברונזה → +25. The applied ratio is 80/25 = 3.20x')
eq(fn('previewMatchDelta')({ ...RANKED, result: 'win', rankPoints: 3200, rankPointsRaw: 3200, myTeamFracs: [6, 6], oppFracs: [0, 0], oppMatches: [50, 50] }), 4,
    'אגדה+אגדה beat ברונזה+ברונזה → +4, so the spread across one fixture is 20x')
eq(fn('previewMatchDelta')({ ...RANKED, result: 'win', rankPoints: 0, rankPointsRaw: 0, myTeamFracs: [0], oppFracs: [6], oppMatches: [50] }), 80,
    '1v1 ברונזה beats אגדה → +80 too: HEADCOUNT DOES NOT MULTIPLY')
eq(fn('previewMatchDelta')({ ...RANKED, result: 'win', rankPoints: 500, rankPointsRaw: 500, myTeamFracs: [2, 2], oppFracs: [5, 5], oppMatches: [50, 50] }), 85,
    'זהב+זהב beat אלוף+אלוף → +85 (the cap does not bind above bronze)')
eq(fn('previewMatchDelta')({ ...RANKED, result: 'win', rankPoints: 500, rankPointsRaw: 500 }), 25,
    'OPPONENT UNKNOWN — no receipt on the wire yet → the even row, +25. THIS IS WHAT SHIPS TODAY')

console.log('the preview degrades safely on every missing input:')
eq(fn('previewMatchDelta')({ ...RANKED, result: 'win', rankPoints: 0, rankPointsRaw: 0, myTeamFracs: [0], oppFracs: [6], oppMatches: [1] }), 25,
    'an opponent under 5 lifetime ranked matches CANNOT CONFER a gap → +25')
eq(fn('previewMatchDelta')({ ...RANKED, result: 'win', rankPoints: 0, rankPointsRaw: 0, myTeamFracs: [0], oppFracs: [6], oppMatches: [50], myMatches: 2 }), 25,
    'and an unproven ME cannot COLLECT one → +25 (the gate is SYMMETRIC or "alt feeds main" stays open)')
eq(fn('previewMatchDelta')({ result: 'win', isBotMatch: true, rankPoints: 500 }), 0,
    'a BOT match pays 0 — checked before any rail, so no forged roster of legends can mint an upset')
eq(fn('previewMatchDelta')({}), 0, 'an empty call is 0, not NaN')
eq(fn('previewMatchDelta')({ result: 'nonsense', rankPoints: 500 }), 0, 'an unknown result is 0')

console.log('the preview honours the rails, not just the table:')
eq(fn('previewMatchDelta')({ ...bronzePair, result: 'win', oppFracs: [6, 6], oppMatches: [50, 50], upsetBudgetUsed: 200 }), 25,
    'with the EVENT budget spent, a max upset pays only the even row')
eq(fn('previewMatchDelta')({ ...bronzePair, result: 'win', oppFracs: [6, 6], oppMatches: [50, 50], upsetBudgetUsed: 165 }), 60,
    'a partly-spent budget pays the remainder: 25 + 35')
eq(fn('previewMatchDelta')({ ...RANKED, result: 'loss', rankPoints: 500, rankPointsRaw: 500, myTeamFracs: [2], oppFracs: [6], oppMatches: [50], upsetBudgetUsed: 200 }), -5,
    'THE CHEAP LOSS SURVIVES AN EMPTY BUDGET — −5, not −20. A reduced cost is not points gained')
eq(fn('previewMatchDelta')({ ...RANKED, result: 'draw', rankPoints: 500, rankPointsRaw: 500, myTeamFracs: [2], oppFracs: [6], oppMatches: [50], upsetBudgetUsed: 200 }), 2,
    'but a DRAW bonus IS a gain, so it does fall back to +2 when the budget is empty')
eq(fn('previewMatchDelta')({ ...bronzePair, result: 'win', oppFracs: [6, 6], oppMatches: [50, 50], opponentMeetings: 4 }), 0,
    'a 4th meeting pays 0 even on a max upset — the decay scales the FINAL delta')
eq(fn('previewMatchDelta')({ ...RANKED, result: 'win', rankPoints: 500, rankPointsRaw: 500, myTeamFracs: [2], oppFracs: [2], oppMatches: [50], opponentMeetings: 2 }), 15,
    'a 2nd meeting pays 60% of the even win')
eq(fn('previewMatchDelta')({ ...RANKED, result: 'loss', rankPoints: 500, rankPointsRaw: 500, myTeamFracs: [2], oppFracs: [2], oppMatches: [50], opponentMeetings: 3 }), -6,
    'and the decay applies to LOSSES ALIKE (−20 × 30%) — the shipped rule gated on `base > 0`, which let one alt absorb unlimited tank-losses')
eq(fn('previewMatchDelta')({ ...RANKED, result: 'win', rankPoints: 500, rankPointsRaw: 500, myTeamFracs: [2], oppFracs: [2], oppMatches: [50], streakAfter: 3 }), 29,
    'a 3-win streak adds +4 inside the preview too')
eq(fn('previewMatchDelta')({ ...RANKED, result: 'loss', rankPoints: 150, rankPointsRaw: 150, myTeamFracs: [0], oppFracs: [0], oppMatches: [50] }), 0,
    'under the silver entry a loss costs 0 — this replaces the deleted BANDS[0].loss = 0')
// REWRITTEN 2026-07-26 (repair pass). This asserted the spec's LITERAL step 6 — the shield reads
// `rankPointsRaw` — and that version, executed, relocated §2's free-loss sink rather than killing it: the
// display is floored at TIER_MIN[rankFloor], so any account with rankFloor ≥ 1 parked its raw under 200 and
// then lost infinitely for exactly 0 while keeping its badge. Shield now keyed to the DISPLAY, both repos.
// Regression witness: test-rank-repairs.mjs §1 + pikme-server/test-football-repairs.mjs §1.
eq(fn('previewMatchDelta')({ ...RANKED, result: 'loss', rankPoints: 200, rankPointsRaw: 150, myTeamFracs: [0], oppFracs: [0], oppMatches: [50] }), -20,
    'a drained raw under a 200 BADGE is NOT shielded — that was the sink; the shield reads the display')
eq(fn('previewMatchDelta')({ ...RANKED, result: 'loss', rankPoints: 3200, rankPointsRaw: 3200, myTeamFracs: [6, 0], oppFracs: [6, 0], oppMatches: [50, 50] }), -20,
    'the duo LOSS shield: an internal spread ≥ 3 tiers prices the loss at g = 0, so helping a friend never costs more than playing alone')
eq(fn('previewMatchDelta')({ result: 'loss', rankPoints: 500, rankPointsRaw: 500, myMatches: 50, firstLossToday: true }), 0,
    'OUTSIDE ranked the first loss of the day is still free')
eq(fn('previewMatchDelta')({ ...RANKED, result: 'loss', rankPoints: 500, rankPointsRaw: 500, firstLossToday: true }), -20,
    'INSIDE ranked it is not — a free daily re-roll inside a 10-match event')

console.log('previewMatchDetail — the post-match / pre-match CHIP data (ship the chip or don\'t ship the table):')
const det = fn('previewMatchDetail')({ ...bronzePair, result: 'win', oppFracs: [6, 6], oppMatches: [50, 50] })
eq(det && det.delta, 80, 'delta +80')
close(det && det.g, 4, 'g = +4 → "4 דרגות מעליך"')
eq(det && det.gKnown, true, 'the gap is MEASURED, so the chip may claim it')
eq(det && det.gReason, 'measured', 'and says why')
eq(det && det.table, 105, 'the raw table value, before the cap')
eq(det && det.even, 25, 'the even row it is measured against')
eq(det && det.capped, true, 'the bronze cap bound')
eq(det && det.maxDelta, 80, 'and it was 80')
eq(det && det.bonusPaid, 55, '55 of the event budget was drawn')
eq(det && det.upsetBudgetUsed, 55, 'leaving the running total at 55')
eq(det && det.meetRate, 1, 'first meeting, full rate')
const unknown = fn('previewMatchDetail')({ ...RANKED, result: 'win', rankPoints: 500, rankPointsRaw: 500 })
eq(unknown && unknown.gKnown, false, 'with no opponent tiers the chip MUST NOT claim a gap')
eq(unknown && unknown.gReason, 'no-opponent-tiers', 'and the reason names the missing wire, so this can never go silent')
eq(unknown && unknown.delta, 25, 'while still paying the even row')

console.log('previewPayouts — the pre-match "what is this match worth" triple:')
const pay = fn('previewPayouts')({ ...bronzePair, oppFracs: [6, 6], oppMatches: [50, 50] })
eq(pay && pay.win, 80, 'beat these two: +80')
eq(pay && pay.loss, 0, 'lose to them: 0 (raw 0 is under the silver entry, so the loss is shielded)')
eq(pay && pay.draw, 24, 'draw with them: +24')
const payGold = fn('previewPayouts')({ ...RANKED, rankPoints: 500, rankPointsRaw: 500, myTeamFracs: [2], oppFracs: [6], oppMatches: [50] })
eq(payGold && payGold.win, 105, 'a זהב beating an אגדה: the FULL +105 (gap +4, and gold\'s 160 cap does not bind — only bronze\'s 80 does)')
eq(payGold && payGold.loss, -5, 'and losing to them costs only −5')
const payEven = fn('previewPayouts')({ ...RANKED, rankPoints: 500, rankPointsRaw: 500 })
eq(payEven && payEven.win, 25, 'with no opponent tiers the preview promises the even row')
eq(payEven && payEven.loss, -20, 'both ways')
eq(payEven && payEven.draw, 2, 'and the even draw')

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
