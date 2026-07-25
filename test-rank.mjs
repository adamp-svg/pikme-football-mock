// Game-side RANK display math (shared/rank.js). Run: node test-rank.mjs
//
// The SERVER owns every trophy number (pikme-server data/football-rank.js) — the game never
// computes a delta. This module only knows how to DISPLAY what the server sends: which tier a count
// falls in, its Hebrew name, how full the bar to the next tier is, and whether the player has hit
// their bot ceiling (so the hub can nudge "raise the difficulty to keep climbing").
//
// The ladder constants here MUST stay identical to the server's. test-rank-parity.mjs proves it.

import {
    RANK_TIERS, TIER_MIN, TIER_HE, botCeiling,
    tierIndexFromRank, tierNameHe, tierProgress, atBotCeiling, nextTierAt,
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
eq(botCeiling(0), 60, 'L0 = 60')
eq(botCeiling(5), 460, 'L5 = 460')
eq(botCeiling(11), 940, 'L11 = 940')
eq(botCeiling(50), 940, 'clamped at L11')

console.log('atBotCeiling — drives the "raise the difficulty" nudge:')
assert(atBotCeiling(460, 5) === true, 'at the L5 ceiling → nudge')
assert(atBotCeiling(500, 5) === true, 'past the L5 ceiling → nudge')
assert(atBotCeiling(459, 5) === false, 'one short of it → no nudge')
assert(atBotCeiling(940, 11) === true, 'at the top bot ceiling → nudge (only humans pay now)')
assert(atBotCeiling(0, 0) === false, 'a new player on the tutorial level is not capped yet')

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
