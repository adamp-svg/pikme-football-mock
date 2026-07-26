// THE RANKED MODE RULE (shared/ranked.js). Run: node test-ranked-mode.mjs
//
// "Rank is earned ONLY in ranked events, humans only" is the user's ruling. This file tests the
// STRUCTURAL half of it: which modes pay rank, what a ranked match must satisfy, how a rage-quit is
// priced, and what the badge says before a player has ever played ranked.
//
// ⚠️ THE MODULE IS DEAD CODE ON PURPOSE, TODAY. The ranked queue does not exist yet (spec S7,
// shared/ranked-queue.js), so nothing calls any of this. Gating rank on it now would take rank to ZERO
// for every player with nothing to replace it — the live modes (quick match, goal brawl, 3v3,
// party/friends, training, builder) are all unranked by this rule. The rule is written and tested so
// the queue slice is a wiring job, not a design job.
//
// Spec: summery/research-trophies/15-RANKED-EVENT-SPEC.md §3 (the event) + §4 (לא מדורג).

import * as ranked from './shared/ranked.js'

let failures = 0
function assert(cond, msg) {
    if (cond) console.log('  ✓', msg)
    else { console.error('  ✗', msg); failures++ }
}
function eq(actual, expected, msg) {
    assert(actual === expected, `${msg} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`)
}
function fn(name) {
    return typeof ranked[name] === 'function' ? ranked[name] : () => undefined
}
function arr(name) {
    return Array.isArray(ranked[name]) ? ranked[name] : []
}

// A human roster entry and a bot one, shaped exactly like server.js builds them for matchStart.
const H = (id) => ({ id, name: id, team: 'A', isBot: false })
const B = (id) => ({ id, name: id, team: 'B', isBot: true })

console.log('WHICH MODES PAY RANK — today, NONE of them:')
eq(ranked.RANKED_MODE, 'ranked', 'the ranked mode id is `ranked` (the future MODES card id AND FORMATS key)')
eq(ranked.RANKED_TEAM_SIZE, 1, 'ranked is 1v1 — the only format whose queue math works at this population')
assert(arr('RANKED_MODES').length > 0, 'there is at least one ranked mode id')
assert(arr('RANKED_MODES').includes('ranked'), 'and `ranked` is in it')
// The live surfaces, named individually so a new mode cannot quietly inherit rank by being added.
for (const m of ['quick', 'brawl', '3v3', 'private', 'party', 'training', 'builder', 'botgame']) {
    eq(fn('paysRank')(m), false, `${m} pays NO rank`)
}
eq(fn('paysRank')('ranked'), true, 'only the ranked mode pays rank')
eq(fn('paysRank')(), false, 'an ABSENT mode pays no rank — the gate fails CLOSED')
eq(fn('paysRank')(null), false, 'and so does a null one')
eq(fn('paysRank')('RANKED'), false, 'the match is exact — a near-miss must not smuggle rank in')
{
    // The list of live modes is asserted against paysRank so the two can never disagree: if somebody
    // adds a mode to RANKED_MODES that is already live, this fails.
    const live = arr('LIVE_MODES')
    assert(live.length >= 6, `LIVE_MODES enumerates today's shipped modes (${live.length})`)
    assert(live.every((m) => !fn('paysRank')(m)), 'NOT ONE live mode pays rank today — the module is dead-code-safe')
    assert(!live.includes('ranked'), 'and `ranked` is not live yet')
}

console.log('MATCHMAKER-ASSIGNED ONLY — no challenges, no private rooms, no accepted invites:')
eq(ranked.RANKED_SOURCE, 'matchmaker', 'the one legal source of a ranked pairing')
eq(fn('isRankedSource')('matchmaker'), true, 'the matchmaker qualifies')
for (const s of ['challenge', 'invite', 'private', 'code', 'party', 'rematch']) {
    eq(fn('isRankedSource')(s), false, `${s} does NOT — a chosen opponent is a win-trading pipe`)
}
eq(fn('isRankedSource')(undefined), false, 'an UNKNOWN source fails closed too')

console.log('rankedMatchQualifies — the ranked mode AND an all-human roster AND the matchmaker:')
const OK = { mode: 'ranked', source: 'matchmaker', roster: [H('a'), H('b')] }
{
    const v = fn('rankedMatchQualifies')(OK) || {}
    eq(v.ok, true, 'a matchmade all-human ranked 1v1 qualifies')
    eq(v.reason, 'ok', 'and says so')
    eq(v.humanCount, 2, 'reporting the human count')
    eq(v.allHuman, true, 'and that the roster was clean')
}
eq((fn('rankedMatchQualifies')({ ...OK, mode: 'quick' }) || {}).reason, 'not-ranked-mode', 'quick match does not qualify')
eq((fn('rankedMatchQualifies')({ ...OK, mode: '3v3' }) || {}).reason, 'not-ranked-mode', 'nor does 3v3')
eq((fn('rankedMatchQualifies')({ ...OK, mode: undefined }) || {}).reason, 'not-ranked-mode', 'nor does a match with no mode at all')
eq((fn('rankedMatchQualifies')({ ...OK, source: 'challenge' }) || {}).reason, 'not-matchmade', 'a friend CHALLENGE does not qualify even in the ranked mode')
eq((fn('rankedMatchQualifies')({ ...OK, source: 'private' }) || {}).reason, 'not-matchmade', 'nor does a private room')
eq((fn('rankedMatchQualifies')({ ...OK, source: undefined }) || {}).reason, 'not-matchmade', 'nor does an unstated source')
eq((fn('rankedMatchQualifies')({ ...OK, roster: [H('a'), B('bot-1')] }) || {}).reason, 'roster-has-bots', 'ONE bot in the roster disqualifies the whole match')
eq((fn('rankedMatchQualifies')({ ...OK, roster: [H('a'), B('bot-1')] }) || {}).ok, false, 'and it is not ok')
eq((fn('rankedMatchQualifies')({ ...OK, roster: [] }) || {}).reason, 'roster-unknown', 'an EMPTY roster is unknown, not "all human"')
eq((fn('rankedMatchQualifies')({ ...OK, roster: null }) || {}).reason, 'roster-unknown', 'and so is a missing one — fail closed')
eq((fn('rankedMatchQualifies')({ ...OK, roster: [H('a')] }) || {}).reason, 'too-few-humans', 'a solo room is not a ranked match, however human it is')
eq((fn('rankedMatchQualifies')({ ...OK, teamSize: 1 }) || {}).ok, true, 'a declared teamSize 1 with 2 players is consistent')
eq((fn('rankedMatchQualifies')({ ...OK, roster: [H('a'), H('b'), H('c')], teamSize: 1 }) || {}).reason, 'wrong-headcount', 'a 1v1 room holding 3 people is not a 1v1')
eq((fn('rankedMatchQualifies')({ ...OK, roster: [H('a'), H('a')] }) || {}).reason, 'duplicate-ids',
    'two entries claiming the SAME id is a self-match, not a pairing — and it must not be reported as "bots"')
eq((fn('rankedMatchQualifies')({}) || {}).ok, false, 'an empty call does not qualify')
assert(typeof (fn('rankedMatchQualifies')({}) || {}).reason === 'string', 'and it still returns a reason string rather than throwing')

console.log('the roster rule is COMPOSED from shared/roster.js, not reimplemented:')
// A missing isBot flag counts as HUMAN there (an older build that omitted it must not halve honest
// payouts). That default is inherited here deliberately, and it is the one place this gate fails OPEN.
eq((fn('rankedMatchQualifies')({ ...OK, roster: [{ id: 'a' }, { id: 'b' }] }) || {}).ok, true,
    'a roster with no isBot flags at all reads as human — inherited from shared/roster.js on purpose')
eq((fn('rankedMatchQualifies')({ ...OK, roster: [{ id: 'a' }, { id: null, isBot: false }] }) || {}).reason, 'roster-unknown',
    'but an entry with NO id cannot be counted, so the roster is unknown')

console.log('⚠️ THE FORFEIT HOLE: the gate must read the START roster, never the live snapshot:')
// server.js checkAfk sets `p.isBot = true` on the SIM player after 10s of no input. If the ranked gate
// read the snapshot, a player could go AFK, get flagged a bot, turn the match into a "bot match" and
// walk away from the loss for free. The gate reads matchStart.players; the forfeit is priced separately.
{
    const afkSnapshot = [{ id: 'a', team: 'A', isBot: false }, { id: 'b', team: 'B', isBot: true }]
    const v = fn('rankedMatchQualifies')({ ...OK, roster: [H('a'), H('b')], players: afkSnapshot }) || {}
    eq(v.ok, true, 'a player going AFK mid-match does NOT un-rank the match')
    eq(v.reason, 'ok', 'the verdict is unchanged by the snapshot')
}

console.log('a RAGE-QUIT is a forfeit, priced at 100% — never a free escape:')
eq(ranked.RANKED_FORFEIT_RATE, 1, 'a forfeit settles at the FULL table value, with no discount for leaving')
eq(ranked.RANKED_AFK_FORFEIT_SEC, 10, 'and 10s of no input is a forfeit too (server.js AFK_SECONDS)')
{
    const f = fn('forfeitResults')({ quitterTeam: 'A' }) || {}
    eq(f.ok, true, 'a quit by team A resolves')
    eq(f.results && f.results.A, 'loss', 'the leaver takes the LOSS')
    eq(f.results && f.results.B, 'win', 'and the opponent gets the WIN')
    eq(f.reason, 'forfeit', 'labelled a forfeit, so the settle can log it')
}
{
    const f = fn('forfeitResults')({ quitterTeam: 'B' }) || {}
    eq(f.results && f.results.B, 'loss', 'symmetric for team B')
    eq(f.results && f.results.A, 'win', 'the other side wins')
}
eq((fn('forfeitResults')({ quitterTeam: 'C' }) || {}).ok, false, 'an unknown team does not resolve')
eq((fn('forfeitResults')({ quitterTeam: 'C' }) || {}).reason, 'unknown-team', 'and says why rather than guessing a loser')
eq((fn('forfeitResults')({}) || {}).ok, false, 'no quitter = nothing to settle')
eq(fn('forfeitResultFor')({ myTeam: 'A', quitterTeam: 'A' }), 'loss', 'from the leaver\'s own seat it is a loss')
eq(fn('forfeitResultFor')({ myTeam: 'B', quitterTeam: 'A' }), 'win', 'from the other seat it is a win')
eq(fn('forfeitResultFor')({ myTeam: 'B', quitterTeam: 'C' }), null, 'and null when we cannot tell')
{
    // The reason the forfeit BITES is §2's unfloored ledger: before it, a loss at any tier entry cost
    // exactly 0, so quitting at 1400 was free. Named here because it is the only thing making this real.
    const inputs = fn('forfeitSettleInputs')({ quitterTeam: 'A', myTeam: 'A' }) || {}
    eq(inputs.result, 'loss', 'the settle input for the leaver is a plain loss')
    eq(inputs.isRanked, true, 'flagged isRanked, which DROPS the free first-loss-of-the-day re-roll')
    eq(inputs.isBotMatch, false, 'and explicitly NOT a bot match, whatever checkAfk did to the sim player')
    eq(inputs.xpFactor, 1, 'with the all-human roster grade pinned — a ranked room cannot contain a bot')
}
eq(ranked.RANKED_XP_FACTOR, 1, 'RANKED_XP_FACTOR is 1: ranked rooms are all-human by construction')

console.log('the ranked ROOM must never grow a bot:')
const flags = ranked.RANKED_ROOM_FLAGS || {}
eq(flags.noBots, true, 'noBots — the flag fillBots must return early on (4 call sites, spec §6)')
eq(flags.isRanked, true, 'isRanked — what drops the free daily loss and gates the event budget')
eq(flags.teamSize, 1, 'teamSize 1')
eq(flags.format, 'ranked', 'and the FORMATS key')
assert(Object.isFrozen(ranked.RANKED_ROOM_FLAGS), 'the flags are frozen — a room must not be able to mutate its own ranked-ness')

console.log('HAS THIS PLAYER EVER PLAYED RANKED (spec §4):')
// `rankSeeded` is NOT the discriminator — footballDefaults sets it true on brand-new accounts too.
eq(fn('hasPlayedRanked')({ rankedMatches: 1, rankPoints: 0 }), true, 'one ranked match is enough')
eq(fn('hasPlayedRanked')({ rankedMatches: 0, rankPoints: 640 }), true, 'a LEGACY account seeded to 640 counts as ranked — it must show זהב, not לא מדורג')
eq(fn('hasPlayedRanked')({ rankedMatches: 0, rankPoints: 0 }), false, 'a brand-new account has not')
eq(fn('hasPlayedRanked')({}), false, 'and neither has an unknown one')
eq(fn('hasPlayedRanked')({ rankedMatches: 0, rankPoints: 0, rankSeeded: true }), false, 'rankSeeded:true does NOT make an account ranked — it is true on every new account')
eq(fn('isUnranked')({ rankedMatches: 0, rankPoints: 0 }), true, 'isUnranked is the exact complement')
eq(fn('isUnranked')({ rankedMatches: 0, rankPoints: 640 }), false, 'both ways')

console.log('PLACEMENTS — the badge is hidden until 3 are played:')
eq(ranked.RANKED_PLACEMENTS, 3, '3 placement matches (Rocket League)')
eq(ranked.RANKED_MATCH_BUDGET, 10, '10 ranked matches per player per event (FUT Champions ships 15/5)')
eq(ranked.RANKED_ENTRY_TROPHIES, 1000, 'the entry gate is 1,000 גביעים — literally XP_TIER_MIN[1]')
eq(fn('inPlacements')({ rankedMatches: 1 }), true, 'match 1 is a placement')
eq(fn('inPlacements')({ rankedMatches: 2 }), true, 'so is match 2')
eq(fn('inPlacements')({ rankedMatches: 3 }), false, 'after 3, placements are done')
eq(fn('inPlacements')({ rankedMatches: 0 }), false, 'a player who has never played is UNRANKED, not "in placements"')
eq(fn('inPlacements')({ rankedMatches: 0, rankPoints: 640 }), false, 'and a legacy seed is not in placements either — it never entered the event')
eq(fn('placementsLeft')({ rankedMatches: 1 }), 2, '2 placements left after the first')
eq(fn('placementsLeft')({ rankedMatches: 5 }), 0, 'never negative')

console.log('the EVENT budget:')
eq(fn('eventMatchesLeft')({ eventMatches: 3 }), 7, '3 played of 10 leaves 7')
eq(fn('eventMatchesLeft')({ eventMatches: 10 }), 0, 'a spent budget is 0')
eq(fn('eventMatchesLeft')({ eventMatches: 99 }), 0, 'and never negative')
eq(fn('eventMatchesLeft')({}), 10, 'a fresh event has the whole budget')

console.log('THE HEBREW (RTL) — לא מדורג and the label the hub paints:')
eq(ranked.RANK_UNRANKED_HE, 'לא מדורג', 'the unranked label')
assert(typeof ranked.RANKED_UNRANKED_SUB_HE === 'string' && ranked.RANKED_UNRANKED_SUB_HE.length > 0, 'there is a sub-line explaining how to get a rank')
assert(String(ranked.RANKED_UNRANKED_SUB_HE || '').includes('3'), 'and it names the 3 placement matches')
eq(fn('rankLabelHe')({ rankedMatches: 0, rankPoints: 0 }), 'לא מדורג', 'a new account reads לא מדורג')
eq(fn('rankLabelHe')({ rankedMatches: 0, rankPoints: 640 }), 'זהב', 'a legacy 640 seed reads זהב, unmarked')
eq(fn('rankLabelHe')({ rankedMatches: 2, rankPoints: 300 }), 'דירוג 2/3', 'during placements the TIER IS HIDDEN and the count is shown')
eq(fn('rankLabelHe')({ rankedMatches: 3, rankPoints: 300, rankFloor: 1 }), 'כסף', 'once placed, the CONFIRMED tier is the label')
eq(fn('rankLabelHe')({ rankedMatches: 3, rankPoints: 604, rankFloor: 1 }), 'כסף', 'gold POINTS with a silver FLOOR still reads כסף — step 9 made visible')
eq(fn('rankLabelHe')({ rankedMatches: 3, rankPointsRaw: 1374, rankFloor: 4 }), 'יהלום', 'and a raw below the badge still reads the badge — no relegation')
eq(fn('rankLabelHe')({}), 'לא מדורג', 'nothing known reads לא מדורג')

console.log('the badge must NOT be padlocked by this module (the regression it replaces):')
// `atBotCeiling` returned an unconditional true and hub-rank.js latched `hub-tier-capped` — a hatched
// bar and a 🔒 — onto every badge. "This mode cannot move your rank" is a property of the MODE, and it
// is answered HERE. It must answer NO for every live mode, or the padlock is back by another name.
for (const m of ['quick', 'brawl', '3v3', 'training', 'builder', 'botgame', 'private']) {
    eq(fn('rankLockedForMode')(m), true, `${m} cannot move rank, so the hub MAY say so for ${m}`)
}
eq(fn('rankLockedForMode')('ranked'), false, 'the ranked mode is the one place it is not locked')
eq(fn('rankLockedForMode')(undefined), false, 'an UNKNOWN mode paints NO lock — "we were not told" must never render as 🔒, which is exactly the bug atBotCeiling shipped')

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
