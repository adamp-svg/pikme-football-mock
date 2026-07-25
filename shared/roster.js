// WHO IN THIS MATCH IS A HUMAN — one rule, shared by the client's match report and (next) the server's
// authoritative count. Pure: no DOM, no wire, no imports. Tests: test-roster-humans.mjs.
//
// ⚠️ THE BUG THIS EXISTS TO KILL. `fillBots` in server.js appends bot entries — each carrying
// `isBot: true` — into the SAME array that ships as `matchStart.players`. The client stored that whole
// thing as `matchRoster`, labelled it "(humans)", and built its id set from all of it. So bots counted
// as humans and a solo-vs-3-bots match reported:
//
//     { humanOpponents: 2, vsHuman: true, humanCount: 4, xpFactor: 1.00 }   ← every value wrong
//
// which means TROPHY_BOT_FLOOR, the stepped roster grade, botTaper, BOT_RATE, botCeiling, BOT_DAILY_CAP
// and the winsVsBot badge gate have never once executed on a matchmade or vs-bots match. The whole
// bot-vs-human economy was dead code in production, so asks #3/#4/#6 were a bug fix, not a feature.
//
// The rule is HERE and not inline in postMatchResult for two reasons: it is the only way to unit-test it
// (client.js needs a browser), and pikme-server has to be able to apply the identical rule when it stops
// trusting the client's count — a guest browser tab or an AFK friend can still fake a full-human room.

// The wire encoding the SERVER inverts. `rosterRate` in pikme-server/data/football-xp.js recovers the
// fraction as (xpFactor - HUMAN_FRAC_BASE) / HUMAN_FRAC_SPAN, so these two must not drift.
export const HUMAN_FRAC_BASE = 0.2;
export const HUMAN_FRAC_SPAN = 0.8;

// A participant is a bot only when something SAYS SO. A missing flag counts as human on purpose: an
// older server build (or a mode predating the flag) that omitted it would otherwise halve honest
// players' payouts, and under-crediting a real human is the worse of the two failures. Bots have
// carried `isBot: true` since fillBots was written.
function isBot(p) {
  return !!(p && p.isBot);
}

// The ids of the REAL people in a match roster (`matchStart.players`), bots removed.
export function humanRosterIds(roster) {
  const out = new Set();
  if (!Array.isArray(roster)) return out;
  for (const p of roster) {
    if (p && p.id != null && !isBot(p)) out.add(p.id);
  }
  return out;
}

// Everything the match report needs to describe "how human was this match".
//   roster        matchStart.players — humans AND bots, each flagged
//   players       the latest snapshot's players (authoritative on who is still IN the match)
//   opponentTeam  'A' | 'B' — the team that is not mine
//
// A participant counts as human iff its roster entry is human AND its snapshot entry has not since been
// flagged a bot. That second clause matters: server.js flips `p.isBot` on the sim player after
// AFK_SECONDS, and the roster entry it was built from still says isBot:false, so the roster alone cannot
// see an AFK drop-out.
export function rosterCounts({ roster, players, opponentTeam } = {}) {
  const humanIds = humanRosterIds(roster);
  const snap = Array.isArray(players) ? players : [];
  const isHuman = (p) => p && humanIds.has(p.id) && !isBot(p);

  const humanOpponents = snap.filter((p) => p.team === opponentTeam && isHuman(p)).length;
  const humanCount = snap.filter(isHuman).length; // includes me
  // No snapshot means we cannot see the room. Assume a full 2v2 for the slot maths, but credit nobody —
  // guessing high here would hand out the full-rate grade for a match we know nothing about.
  const totalPlayers = snap.length || 4;
  const otherSlots = Math.max(1, totalPlayers - 1);
  const otherHumans = Math.max(0, humanCount - 1);
  const humanFrac = Math.max(0, Math.min(1, otherHumans / otherSlots));

  return {
    humanOpponents,
    vsHuman: humanOpponents > 0,
    humanCount,
    totalPlayers,
    // Rounded to 2dp because that is what the server's inversion expects to receive.
    xpFactor: Math.round((HUMAN_FRAC_BASE + HUMAN_FRAC_SPAN * humanFrac) * 100) / 100,
  };
}
