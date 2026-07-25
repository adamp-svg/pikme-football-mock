// THE BOT/HUMAN SPLIT — the bug that made every bot economy control inert in production.
// Run: node test-roster-humans.mjs
//
// WHAT WAS BROKEN: `fillBots` (server.js) appends bot entries — each carrying `isBot: true` — into the
// SAME `roster` array that is sent as `matchStart.players`. The client stored that as `matchRoster`
// (commented "(humans)") and built `rosterIds` from all of it with no isBot filter. So every bot counted
// as a human:
//
//   solo vs 3 bots, SHIPPED:  { humanOpponents: 2, vsHuman: true,  humanCount: 4, xpFactor: 1.00 }
//   solo vs 3 bots, FIXED:    { humanOpponents: 0, vsHuman: false, humanCount: 1, xpFactor: 0.20 }
//
// Consequence: TROPHY_BOT_FLOOR, the roster grade, botTaper, BOT_RATE, botCeiling, BOT_DAILY_CAP and the
// winsVsBot gate have NEVER executed on a matchmade or vs-bots match. Asks #3/#4/#6 were therefore a bug
// fix, not a feature.
//
// The rule lives in shared/roster.js rather than inline in client.js so it is unit-testable, and so the
// SERVER can apply the identical rule when it starts computing the authoritative count.

import { humanRosterIds, rosterCounts, HUMAN_FRAC_BASE, HUMAN_FRAC_SPAN } from './shared/roster.js'

let failures = 0
function assert(cond, msg) {
    if (cond) console.log('  ✓', msg)
    else { console.error('  ✗', msg); failures++ }
}
function eq(actual, expected, msg) {
    assert(actual === expected, `${msg} (got ${actual}, want ${expected})`)
}

// Shapes exactly as the wire delivers them: roster entries from matchStart.players (bots carry
// isBot:true, humans isBot:false), snapshot players from the sim (id + team only).
const H = (id, team) => ({ id, name: 'Human', team, isBot: false })
const B = (id, team) => ({ id, name: 'Bot', team, isBot: true })
const P = (id, team) => ({ id, team })

console.log('humanRosterIds filters bots out of the roster:')
{
    const roster = [H('m-1', 'A'), B('b-1', 'A'), B('b-2', 'B'), B('b-3', 'B')]
    const ids = humanRosterIds(roster)
    eq(ids.size, 1, 'a solo-vs-3-bots roster yields exactly ONE human id')
    assert(ids.has('m-1'), 'and it is the real player')
    assert(!ids.has('b-1'), 'the bot teammate is excluded')
    assert(!ids.has('b-3'), 'the bot opponents are excluded')
}
{
    const roster = [H('m-1', 'A'), H('m-2', 'A'), H('m-3', 'B'), H('m-4', 'B')]
    eq(humanRosterIds(roster).size, 4, 'an all-human roster yields four ids')
}
eq(humanRosterIds([]).size, 0, 'an empty roster yields none')
eq(humanRosterIds(null).size, 0, 'a missing roster yields none, never throws')
{
    // An older server build, or a mode that predates the flag, may omit isBot entirely. Treat a missing
    // flag as HUMAN: under-counting humans would silently halve honest players' payouts, which is the
    // worse failure. Bots have carried isBot:true since fillBots was written.
    const roster = [{ id: 'm-1', team: 'A' }, { id: 'x', team: 'B', isBot: true }]
    const ids = humanRosterIds(roster)
    eq(ids.size, 1, 'an entry with no isBot flag counts as human')
    assert(!ids.has('x'), 'while an explicit bot is still excluded')
}

console.log('rosterCounts — solo vs 3 bots (the bug case):')
{
    const roster = [H('m-1', 'A'), B('b-1', 'A'), B('b-2', 'B'), B('b-3', 'B')]
    const players = [P('m-1', 'A'), P('b-1', 'A'), P('b-2', 'B'), P('b-3', 'B')]
    const c = rosterCounts({ roster, players, opponentTeam: 'B' })
    eq(c.humanOpponents, 0, 'humanOpponents = 0 (was 2)')
    eq(c.vsHuman, false, 'vsHuman = false (was true)')
    eq(c.humanCount, 1, 'humanCount = 1, just me (was 4)')
    eq(c.totalPlayers, 4, 'totalPlayers = 4')
    eq(c.xpFactor, 0.20, 'xpFactor = 0.20 (was 1.00) — the all-bot grade')
}

console.log('rosterCounts — the other three 2v2 shapes:')
{
    const roster = [H('m-1', 'A'), B('b-1', 'A'), H('m-2', 'B'), B('b-2', 'B')]
    const players = [P('m-1', 'A'), P('b-1', 'A'), P('m-2', 'B'), P('b-2', 'B')]
    const c = rosterCounts({ roster, players, opponentTeam: 'B' })
    eq(c.humanOpponents, 1, 'one human opponent')
    eq(c.humanCount, 2, 'two humans in the match')
    eq(c.xpFactor, 0.47, 'xpFactor = 0.47 → the 0.65 roster grade')
}
{
    const roster = [H('m-1', 'A'), H('m-2', 'A'), H('m-3', 'B'), B('b-1', 'B')]
    const players = [P('m-1', 'A'), P('m-2', 'A'), P('m-3', 'B'), P('b-1', 'B')]
    const c = rosterCounts({ roster, players, opponentTeam: 'B' })
    eq(c.humanOpponents, 1, 'one human opponent, one bot opponent')
    eq(c.humanCount, 3, 'three humans')
    eq(c.xpFactor, 0.73, 'xpFactor = 0.73 → the 0.80 grade')
}
{
    const roster = [H('m-1', 'A'), H('m-2', 'A'), H('m-3', 'B'), H('m-4', 'B')]
    const players = [P('m-1', 'A'), P('m-2', 'A'), P('m-3', 'B'), P('m-4', 'B')]
    const c = rosterCounts({ roster, players, opponentTeam: 'B' })
    eq(c.humanOpponents, 2, 'two human opponents')
    eq(c.humanCount, 4, 'four humans')
    eq(c.xpFactor, 1.00, 'xpFactor = 1.00 — full rate')
}

console.log('a bot that REPLACED a human mid-match (AFK) no longer counts as human:')
{
    // server.js flips p.isBot on the sim player after AFK_SECONDS. The roster entry it was built from
    // said isBot:false, so the roster alone cannot see it — the snapshot must be allowed to override.
    const roster = [H('m-1', 'A'), H('m-2', 'A'), H('m-3', 'B'), H('m-4', 'B')]
    const players = [P('m-1', 'A'), P('m-2', 'A'), { id: 'm-3', team: 'B', isBot: true }, P('m-4', 'B')]
    const c = rosterCounts({ roster, players, opponentTeam: 'B' })
    eq(c.humanOpponents, 1, 'the AFK opponent is counted as a bot, not a human')
    eq(c.humanCount, 3, 'and the match has three humans, not four')
}

console.log('3v3 grades across all six shapes (five other slots → fifths):')
for (const [humansOther, want] of [[0, 0.20], [1, 0.36], [2, 0.52], [3, 0.68], [4, 0.84], [5, 1.00]]) {
    const roster = [H('me', 'A')]
    const players = [P('me', 'A')]
    for (let i = 0; i < 5; i++) {
        const team = i < 2 ? 'A' : 'B'
        const id = 'p' + i
        const isHuman = i < humansOther
        roster.push(isHuman ? H(id, team) : B(id, team))
        players.push(P(id, team))
    }
    const c = rosterCounts({ roster, players, opponentTeam: 'B' })
    eq(c.xpFactor, want, `3v3 with ${humansOther} other humans → xpFactor ${want}`)
}

console.log('degenerate input never throws and never over-credits:')
{
    const c = rosterCounts({ roster: null, players: null, opponentTeam: 'B' })
    eq(c.totalPlayers, 4, 'no snapshot assumes a full 2v2 rather than dividing by zero')
    eq(c.humanCount, 0, 'and credits nobody')
    eq(c.xpFactor, 0.20, 'so the grade is the all-bot floor, not the full rate')
    eq(c.vsHuman, false, 'and it does not claim a human opponent')
}
{
    // 1v1: one other slot.
    const c = rosterCounts({ roster: [H('a', 'A'), H('b', 'B')], players: [P('a', 'A'), P('b', 'B')], opponentTeam: 'B' })
    eq(c.xpFactor, 1.00, '1v1 vs a human = 1.00')
    const d = rosterCounts({ roster: [H('a', 'A'), B('b', 'B')], players: [P('a', 'A'), P('b', 'B')], opponentTeam: 'B' })
    eq(d.xpFactor, 0.20, '1v1 vs a bot = 0.20')
}

console.log('the encoding the server inverts is preserved exactly:')
eq(HUMAN_FRAC_BASE, 0.2, 'base 0.2')
eq(HUMAN_FRAC_SPAN, 0.8, 'span 0.8 — pikme-server rosterRate inverts (xpFactor - 0.2) / 0.8')

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
