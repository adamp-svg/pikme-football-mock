// REPAIR PASS, GAME SIDE — the three defects that reach shared/rank.js. Run: node test-rank-repairs.mjs
//
// The server is the authority (pikme-server/data/football-rank.js); this file is its mirror, and
// test-rank-parity.mjs fails the build when the two disagree. Each section below has a twin in
// pikme-server/test-football-repairs.mjs.
//
//   1. RAIL 6 reads the DISPLAYED standing, not `rankPointsRaw`. The spec's literal step 6 shipped and
//      relocated §2's free-loss sink: the display is floored at TIER_MIN[rankFloor], so any account with
//      rankFloor ≥ 1 could drain its raw under 200 and lose infinitely for 0 while wearing its badge.
//      The PREVIEW must promise what the server settles, so it moves in the same commit or the chip lies.
//
//   2. `rankFloor` is EVIDENCE-BOUNDED. `displayedRank` rebuilt the standing out of an injected floor
//      alone, so a hub handed { rankPoints: 0, rankFloor: 6 } painted אגדה with an empty ledger — and
//      footballPublicStats ships rankFloor to the client, so a wiped account did exactly that. When
//      rankPeak IS known the floor may not claim a tier max(raw, display, peak) does not reach; when it
//      is absent there is NO bound, because dropping a legitimate badge on a missing field is worse.
//
//   3. THE PREVIEW REFUSES AN UNKNOWN ROSTER GRADE. previewMatchDetail has no xpFactor (the server
//      multiplies by the stepped roster rate, which lives in football-xp.js and is not mirrored here), and
//      it used to IGNORE the argument silently: `previewMatchDelta({ xpFactor: 0.8 })` promised +25 where
//      the server pays +20, and at 0.20 it promised +25 against +13 — a 48-92% over-promise that
//      test-rank-parity.mjs cannot catch, because parity pins xpFactor to 1. It now degrades to "no
//      promise" instead of a wrong one, exactly like an unknown opponent tier does.

import * as rank from './shared/rank.js';

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log('  ✓', msg);
  else { console.error('  ✗', msg); failures++; }
}
function eq(actual, expected, msg) {
  assert(actual === expected, `${msg} (got ${actual}, want ${expected})`);
}
// Namespace lookup so a MISSING export counts as one failure instead of killing the run on the call.
const F = (name) => (typeof rank[name] === 'function' ? rank[name] : () => undefined);
const TIER_MIN = rank.TIER_MIN;

const EVEN = { myTeamFracs: [1], oppFracs: [1], oppMatches: [50], myMatches: 50 };

console.log('1. RAIL 6 — the preview shields on the DISPLAYED standing, like the server:');
eq(F('previewMatchDelta')({ result: 'loss', rankPoints: 200, rankPointsRaw: 150, ...EVEN }), -20,
  'a כסף parked at its entry with a drained raw is NOT shielded');
eq(F('previewMatchDelta')({ result: 'loss', rankPoints: 150, rankPointsRaw: 150, ...EVEN }), 0,
  'an honest 150 with nothing propping it up still is');
eq(F('previewMatchDelta')({ result: 'loss', rankPoints: 0, rankPointsRaw: 0, ...EVEN, myTeamFracs: [0], oppFracs: [0] }), 0,
  'and a brand-new player cannot go backwards at all');
eq(F('previewMatchDetail')({ result: 'loss', rankPoints: 200, rankPointsRaw: 150, ...EVEN }).gReason, 'measured',
  'the chip reason names the real rail, not a shield that did not fire');
eq(F('previewPayouts')({ rankPoints: 200, rankPointsRaw: 150, ...EVEN }).loss, -20,
  'so the pre-match "הפסד −20" the queue screen shows is the number that will be charged');

console.log('\n2. THE STICKY FLOOR IS EVIDENCE-BOUNDED — the hub cannot paint a badge off a bare floor:');
assert(typeof rank.floorEvidenceIndex === 'function', 'floorEvidenceIndex() is exported (mirrors the server)');
{
  const ev = F('floorEvidenceIndex');
  eq(ev({ rankPointsRaw: 0, rankPoints: 0, rankPeak: 0 }), 0, 'no standing supports only ברונזה');
  eq(ev({ rankPointsRaw: 0, rankPoints: 0, rankPeak: 3200 }), 6, 'a legend peak supports אגדה');
  eq(ev({ rankPointsRaw: 1374, rankPoints: 1400, rankPeak: 1400 }), 4, 'the highest of the three wins');
  eq(ev({}), 6, 'NO rankPeak = NO bound — a field the app does not inject must never demote anyone');
}
{
  // The wiped account, which is what the server now refuses to re-inflate.
  const wiped = { rankPointsRaw: 0, rankPoints: 0, rankPeak: 0, rankFloor: 6 };
  eq(F('displayedRank')(wiped), 0, 'displayedRank does not resurrect 3,200 out of a bare floor');
  eq(F('rankDebt')(wiped), 0, 'and reports no debt, because there is no badge to be under');
  eq((F('rankBadge')(wiped) || {}).tierHe, 'ברונזה', 'the badge reads ברונזה, not אגדה');
  eq((F('rankBadge')(wiped) || {}).points, 0, 'with 0 points');
}
{
  // …and the sticky badge an honest player earned is untouched, which is the whole constraint.
  const honest = { rankPointsRaw: 1374, rankPoints: 1400, rankPeak: 1400, rankFloor: 4 };
  eq(F('displayedRank')(honest), 1400, 'an honest יהלום still displays 1400 with a 1374 ledger');
  eq(F('rankDebt')(honest), 26, 'and the 26-point debt is still visible');
  eq((F('rankBadge')(honest) || {}).tierHe, 'יהלום', 'badge holds at יהלום — "no relegation" is preserved');
  // Back-compat: today the app injects no rankPeak, so nothing may change for the shapes the hub sees.
  eq(F('displayedRank')({ rankPointsRaw: 1374, rankFloor: 4 }), 1400, 'no rankPeak passed → unchanged behaviour');
  eq(F('displayedRank')({ rankPointsRaw: 0, rankFloor: 6 }), TIER_MIN[6], 'and a bare floor still floors, absent evidence');
  eq((F('rankBadge')({ rankPoints: 604, rankFloor: 1 }) || {}).tierHe, 'כסף', 'step 9 still caps the badge at the confirmed tier');
}

console.log('\n3. THE PREVIEW REFUSES A ROSTER GRADE IT CANNOT APPLY:');
eq(F('previewMatchDelta')({ result: 'win', rankPoints: 600, ...EVEN }), 25, 'no xpFactor at all → the even win, as before');
eq(F('previewMatchDelta')({ result: 'win', rankPoints: 600, ...EVEN, xpFactor: 1 }), 25, 'an explicit all-human 1.0 → the same');
eq(F('previewMatchDelta')({ result: 'win', rankPoints: 600, ...EVEN, xpFactor: 0.8 }), 0,
  'a MIXED roster (0.8) promises nothing — the server would pay 20, and 25 is a 25% over-promise');
eq(F('previewMatchDetail')({ result: 'win', rankPoints: 600, ...EVEN, xpFactor: 0.2 }).gReason, 'roster-grade-unknown',
  'and it says WHY, so the queue screen renders neutral instead of a wrong number');
eq(F('previewMatchDetail')({ result: 'win', rankPoints: 600, ...EVEN, xpFactor: 0.2 }).gKnown, false,
  'gKnown is false, which every chip already treats as "do not render a gap"');
eq(F('previewPayouts')({ rankPoints: 600, ...EVEN, xpFactor: 0.65 }).win, 0, 'previewPayouts refuses too, all three rows');
eq(F('previewMatchDelta')({ result: 'win', rankPoints: 600, ...EVEN, xpFactor: 'x' }), 25,
  'a non-numeric grade is ignorance, not a mixed roster → the even row (the shipped default)');

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
