// MATCHMAKING POLICY — pure, no sockets, no timers.
//
// `now` is a PARAMETER, so this drives time by passing timestamps. The suite already has one test
// that hangs (test-bot-ladder.mjs); do not add a second by sleeping.
import { bandOf, acceptedBand, mutuallyCompatible, widenFor, planMatches } from './shared/matchmaker.js';
import { MM_BUDGET_QUICK_MS, MM_BUDGET_MODE_MS, MM_ALONE_MS, MM_GRACE_MS, MM_BAND_TOP } from './shared/constants.js';

let failed = 0;
const ok = (l, c, x = '') => { if (!c) failed++; console.log(`  ${c ? '✅' : '❌'} ${l}${x ? ` — ${x}` : ''}`); };

console.log('bands');
ok('0 trophies -> L1', bandOf(0) === 1, String(bandOf(0)));
ok('340 trophies -> L3', bandOf(340) === 3, String(bandOf(340)));
ok('1000 trophies -> L5', bandOf(1000) === 5, String(bandOf(1000)));
// playerLevelFromXp(30000) is 25; without the ceiling the top player matches nobody.
ok('30000 trophies collapses to the top band', bandOf(30000) === MM_BAND_TOP, String(bandOf(30000)));
ok('12000 trophies also collapses to the top band', bandOf(12000) === MM_BAND_TOP, String(bandOf(12000)));
ok('garbage is treated as the floor, not NaN', bandOf(undefined) === 1 && bandOf(-5) === 1);

console.log('\naccepted band');
ok('widen 0 is exact', JSON.stringify(acceptedBand(5, 0)) === '{"lo":5,"hi":5}');
ok('widen 1 is +/-1', JSON.stringify(acceptedBand(5, 1)) === '{"lo":4,"hi":6}');
ok('widen 2 is +/-2', JSON.stringify(acceptedBand(5, 2)) === '{"lo":3,"hi":7}');
// The floor is ASYMMETRIC: at the bottom of the ladder a one-level gap is a far bigger skill gap.
ok('L1 widened by 1 accepts L1-L2 only, never below', JSON.stringify(acceptedBand(1, 1)) === '{"lo":1,"hi":2}');
ok('L1 widened by 2 still stops at L2', JSON.stringify(acceptedBand(1, 2)) === '{"lo":1,"hi":2}');
ok('L2 widened by 2 stops at L1 below and L4 above', JSON.stringify(acceptedBand(2, 2)) === '{"lo":1,"hi":4}');
ok('the top band does not widen past itself', acceptedBand(MM_BAND_TOP, 2).hi === MM_BAND_TOP);

console.log('\nmutual compatibility');
ok('same level always matches', mutuallyCompatible({ level: 5, widen: 0 }, { level: 5, widen: 0 }));
ok('a widened L3 does NOT capture an unwidened L1',
  !mutuallyCompatible({ level: 3, widen: 2 }, { level: 1, widen: 0 }));
ok('...and still does not once L1 has widened, because L1 caps at L2',
  !mutuallyCompatible({ level: 3, widen: 2 }, { level: 1, widen: 2 }));
ok('L4 and L5 match only when at least one has widened',
  !mutuallyCompatible({ level: 4, widen: 0 }, { level: 5, widen: 0 })
  && mutuallyCompatible({ level: 4, widen: 1 }, { level: 5, widen: 1 }));
ok('compatibility is symmetric',
  mutuallyCompatible({ level: 4, widen: 1 }, { level: 5, widen: 1 })
  === mutuallyCompatible({ level: 5, widen: 1 }, { level: 4, widen: 1 }));

console.log('\nwiden schedule');
const B = MM_BUDGET_QUICK_MS; // 5000
ok('t=0 is exact', widenFor(0, B, false) === 0);
ok('t=39% is still exact', widenFor(B * 0.39, B, false) === 0);
ok('t=40% widens to +/-1', widenFor(B * 0.40, B, false) === 1);
ok('t=99% is still +/-1', widenFor(B * 0.99, B, false) === 1);
ok('grace widens to +/-2', widenFor(B * 1.2, B, true) === 2);
ok('past budget WITHOUT grace stays at +/-1 (it is about to resolve)', widenFor(B * 1.2, B, false) === 1);

console.log('\nplanMatches');
const OPTS = { roomMaxFor: (m) => (m === '3v3' ? 6 : 4) };
// Build a ticket. queuedAt is explicit so every case controls its own clock.
const T = (memberId, level, queuedAt, budgetMs = MM_BUDGET_QUICK_MS, mode = 'quick', graceUntil = null) =>
  ({ memberId, mode, level, trophies: 0, queuedAt, budgetMs, graceUntil });

{ // 4 same-band players -> one full group, immediately, without waiting out any budget
  const r = planMatches([T('a', 5, 0), T('b', 5, 0), T('c', 5, 0), T('d', 5, 0)], 100, OPTS);
  ok('4 compatible tickets form one group at t=100ms', r.groups.length === 1, JSON.stringify(r.groups.map((g) => g.memberIds)));
  ok('...with reason "full"', r.groups[0]?.reason === 'full', r.groups[0]?.reason);
  ok('...and nobody left waiting', r.waiting.length === 0, String(r.waiting.length));
}
{ // 3 of 4 -> nothing yet, all three reported as searching
  const r = planMatches([T('a', 5, 0), T('b', 5, 0), T('c', 5, 0)], 100, OPTS);
  ok('3 of 4 does NOT start early', r.groups.length === 0);
  ok('all three are waiting', r.waiting.length === 3);
  // searchingCount INCLUDES SELF (matches the design's "3 שחקנים מחפשים כרגע" mockup copy for a pool
  // of 3), so 3 here is correct, not an off-by-one — the old label ("...the other two") implied 2 and
  // would send a future debugger chasing a phantom bug that isn't there.
  ok('each sees searchingCount 3 (self + the other two, not just the other two)', r.waiting.every((w) => w.searchingCount === 3), JSON.stringify(r.waiting.map((w) => w.searchingCount)));
  ok('phase is "searching" at t=100ms', r.waiting.every((w) => w.phase === 'searching'));
}
{ // 3v3 needs 6, not 4
  const six = ['a','b','c','d','e','f'].map((id) => T(id, 5, 0, MM_BUDGET_MODE_MS, '3v3'));
  ok('5 tickets do not fill a 3v3', planMatches(six.slice(0, 5), 100, OPTS).groups.length === 0);
  ok('6 tickets do', planMatches(six, 100, OPTS).groups.length === 1);
}
{ // modes never mix
  const r = planMatches([T('a', 5, 0), T('b', 5, 0), T('c', 5, 0, MM_BUDGET_MODE_MS, '3v3'), T('d', 5, 0, MM_BUDGET_MODE_MS, '3v3')], 100, OPTS);
  ok('a quick ticket is never grouped with a 3v3 ticket', r.groups.length === 0 && r.waiting.length === 4);
}
{ // FAIRNESS: the oldest ticket seeds. FIVE tickets for FOUR slots, so somebody must be left out —
  // with only four this assertion could not fail. 'old' has waited 4s; four fresh L5s just arrived.
  // Seeding by newest would form a group of the four fresh arrivals and leave 'old' waiting again.
  const r = planMatches([
    T('fresh1', 5, 3900), T('old', 5, 0), T('fresh2', 5, 3900), T('fresh3', 5, 3900), T('fresh4', 5, 3900),
  ], 4000, OPTS);
  ok('exactly one group of 4 forms', r.groups.length === 1 && r.groups[0].memberIds.length === 4, JSON.stringify(r.groups.map((g) => g.memberIds)));
  ok('the longest-waiting ticket is in it', r.groups[0]?.memberIds.includes('old'), JSON.stringify(r.groups[0]?.memberIds));
  ok('...and the one left out is a fresh arrival, not the oldest', r.waiting.length === 1 && r.waiting[0].memberId.startsWith('fresh'), JSON.stringify(r.waiting.map((w) => w.memberId)));
}
{ // MUTUAL compatibility through the real planner, not just the predicate
  // L1 (widened, caps at L2) + three L3s at t=4s. The L3s have widened to +/-1 and would accept L2..L4.
  // The beginner DOES get its own group here (short-circuited as 'alone', which is correct — nobody
  // compatible exists). What must never happen is the beginner sharing a group WITH an L3, so assert
  // that and not "the beginner is ungrouped".
  const r = planMatches([T('beginner', 1, 0), T('x', 3, 0), T('y', 3, 0), T('z', 3, 0)], 4000, OPTS);
  const mixed = r.groups.some((g) => g.memberIds.includes('beginner') && g.memberIds.length > 1);
  ok('an L1 is never in the same group as an L3', !mixed, JSON.stringify(r.groups.map((g) => g.memberIds)));
  ok('...and the L1 is served alone instead of waiting forever',
    r.groups.some((g) => g.memberIds.length === 1 && g.memberIds[0] === 'beginner' && g.reason === 'alone'),
    JSON.stringify(r.groups));
}
{ // ALONE: one ticket, empty pool -> resolves at MM_ALONE_MS with reason 'alone'
  const solo = [T('a', 5, 0)];
  ok('a lone ticket does not resolve at t=1900ms', planMatches(solo, 1900, OPTS).groups.length === 0);
  const r = planMatches(solo, MM_ALONE_MS, OPTS);
  ok('...and does at t=MM_ALONE_MS', r.groups.length === 1, String(r.groups.length));
  ok('...with reason "alone"', r.groups[0]?.reason === 'alone', r.groups[0]?.reason);
  ok('...as a group of one human', r.groups[0]?.memberIds.length === 1);
}
{ // NOT LATCHED: alone at 1.5s, company at 1.8s -> both keep their FULL budget and get matched later.
  const two = [T('a', 5, 0), T('b', 5, 1800)];
  const r = planMatches(two, 1900, OPTS);
  ok('company before the 2s mark cancels the short-circuit', r.groups.length === 0, JSON.stringify(r.groups));
  ok('both are still searching', r.waiting.length === 2);
  // They are only 2 of 4, so they resolve on 'a's own budget, together, with bots for the rest.
  const r2 = planMatches(two, MM_BUDGET_QUICK_MS, OPTS);
  ok('at a\'s budget they resolve TOGETHER, not separately', r2.groups.length === 1 && r2.groups[0].memberIds.length === 2,
    JSON.stringify(r2.groups.map((g) => g.memberIds)));
  ok('...with reason "deadline", not "alone"', r2.groups[0]?.reason === 'deadline', r2.groups[0]?.reason);
}
{ // GRACE: granted only when the room is theoretically completable.
  // 2 humans, roomMax 4 -> 1 + 1 nearby = 2 < 4 -> NO grace, resolve at deadline.
  const r = planMatches([T('a', 5, 0), T('b', 5, 0)], MM_BUDGET_QUICK_MS, OPTS);
  ok('2 of 4 gets no grace — the room cannot be completed', (r.grants || []).length === 0 && r.groups.length === 1);
  // 4 humans, incompatible at +/-1 but WITHIN the +/-2 nearby window: a is L5, three are L7.
  // At the deadline a accepts L4-L6 and they accept L6-L8, so no group forms — but |7-5| = 2, so
  // nearby = 3 and 1 + 3 >= roomMax, which is exactly the case grace exists for.
  // (L8 would NOT work here: |8-5| = 3 falls outside the nearby window, so no grace and no group.)
  const r2 = planMatches([T('a', 5, 0), T('p', 7, 0), T('q', 7, 0), T('r', 7, 0)], MM_BUDGET_QUICK_MS, OPTS);
  ok('a completable-but-mismatched pool grants grace', (r2.grants || []).length > 0, JSON.stringify(r2.grants));
  ok('...and grants it to the SEED, not to everyone at once', (r2.grants || []).length === 1, JSON.stringify(r2.grants));
}
{ // Grace is granted at most once: a ticket carrying an EXPIRED graceUntil resolves, never re-grants.
  const expired = [{ memberId: 'a', mode: 'quick', level: 5, trophies: 0, queuedAt: 0, budgetMs: MM_BUDGET_QUICK_MS, graceUntil: MM_BUDGET_QUICK_MS + MM_GRACE_MS }];
  const r = planMatches(expired, MM_BUDGET_QUICK_MS + MM_GRACE_MS, OPTS);
  ok('an expired grace resolves instead of extending again', r.groups.length === 1 && (r.grants || []).length === 0, JSON.stringify(r));
  ok('...with reason "grace"', r.groups[0]?.reason === 'grace', r.groups[0]?.reason);
}
{ // A ticket inside its grace reports phase 'grace' and a +/-2 band.
  // Grace is only ever GRANTED when nearby already clears roomMax (see the revocable-grace test
  // below), so a ticket cannot legitimately be inGrace with zero company in the pool — that state
  // is unreachable and would (correctly) revoke on the spot. Give it the same kind of company the
  // grant tests use: L7s that are theoretically nearby at widen 2 but not YET actually compatible
  // (long budgetMs so they just sit there rather than resolving/interfering themselves).
  const farCompany = ['p', 'q', 'r'].map((id) => T(id, 7, 0, 999999));
  const inGrace = [{ memberId: 'a', mode: 'quick', level: 5, trophies: 0, queuedAt: 0, budgetMs: MM_BUDGET_QUICK_MS, graceUntil: 9000 }, ...farCompany];
  const w = planMatches(inGrace, 6000, OPTS).waiting.find((x) => x.memberId === 'a');
  ok('phase is "grace" inside the grace window', w?.phase === 'grace', w?.phase);
  ok('...and the band is +/-2', w?.bandLo === 3 && w?.bandHi === 7, `${w?.bandLo}-${w?.bandHi}`);
}
{ // Band reported for display widens visibly at 40%.
  // The partner is L6, NOT L9: with nobody compatible at all, 'a' would short-circuit as 'alone' at
  // MM_ALONE_MS and never appear in `waiting` to be inspected. L6 is incompatible at widen 0 and
  // compatible at widen 1, which is precisely the transition being measured.
  const pair = () => [T('a', 5, 0), T('b', 6, 0)];
  const w0 = planMatches(pair(), 100, OPTS).waiting.find((x) => x.memberId === 'a');
  const w1 = planMatches(pair(), MM_BUDGET_QUICK_MS * 0.5, OPTS).waiting.find((x) => x.memberId === 'a');
  ok('band starts exact', w0.bandLo === 5 && w0.bandHi === 5, `${w0.bandLo}-${w0.bandHi}`);
  ok('band widens to 4-6 at half budget', w1.bandLo === 4 && w1.bandHi === 6, `${w1.bandLo}-${w1.bandHi}`);
  ok('phase reports "widened" then', w1.phase === 'widened', w1.phase);
}
{ // remainingMs counts down and never goes negative.
  const w = planMatches([T('a', 5, 0), T('b', 6, 0)], 3000, OPTS).waiting.find((x) => x.memberId === 'a');
  ok('remainingMs is budget - elapsed', w.remainingMs === MM_BUDGET_QUICK_MS - 3000, String(w.remainingMs));
}
{ // The group's level is the MEDIAN, not the seed's — the bug in joinMatchmade today.
  // L4 + three L5s at half budget: widen 1 makes them all mutually compatible, so a FULL group forms
  // before any deadline logic runs. The seed is L4 and the median is 5, so a median bug is visible.
  const r = planMatches([T('a', 4, 0), T('b', 5, 0), T('c', 5, 0), T('d', 5, 0)], MM_BUDGET_QUICK_MS * 0.5, OPTS);
  ok('the group forms full at half budget', r.groups[0]?.reason === 'full', JSON.stringify(r.groups));
  ok('group level is the MEDIAN of its humans, not the seed\'s', r.groups[0]?.level === 5, String(r.groups[0]?.level));
}
{ // planMatches must not mutate its input — the caller owns ticket state.
  const t = T('a', 5, 0);
  const before = JSON.stringify(t);
  planMatches([t], MM_ALONE_MS, OPTS);
  ok('input tickets are not mutated', JSON.stringify(t) === before);
}

{ // FIX (review finding 1): `nearby` must respect the asymmetric floor too, not just
  // acceptedBand/mutuallyCompatible directly — an L1 can NEVER become mutually compatible with an
  // L3 (L1 caps at L2 even fully widened), so it must not count as "nearby" for one, and must not
  // be handed a futile grace window of its own either.
  const r = planMatches([T('lo', 1, 0), T('x', 3, 0), T('y', 3, 0), T('z', 3, 0)], MM_BUDGET_QUICK_MS, OPTS);
  ok('an L1 padding a nearby-but-impossible cluster is not granted a futile grace window', (r.grants || []).length === 0, JSON.stringify(r.grants));
  ok('...it resolves immediately instead, alone, and not mislabeled "grace"',
    r.groups.some((g) => g.memberIds.length === 1 && g.memberIds[0] === 'lo' && g.reason !== 'grace'),
    JSON.stringify(r.groups));
}
{ // FIX (review findings 2 & 3): grace is REVOCABLE — a futile wait ends the moment it becomes
  // futile, the same "never latched" philosophy as the alone short-circuit — and a granted-this-
  // tick ticket still shows up in `waiting` (correct phase/band/remainingMs) and still counts in
  // everyone else's searchingCount, instead of vanishing like a truly-seated ticket.
  //
  // Tick 1: a(L5) is incompatible with p,q,r(L7) but they all look nearby-completable, so a grants
  // itself grace. In the SAME tick, q and r group with EACH OTHER on their own real deadline —
  // spending the exact reinforcements a's grant was counting on. (p also grants itself here, off
  // its own recomputed nearby that excludes a — accepted per the brief: one pass can still justify
  // more than one grant off a cluster; that is not what this fix targets.)
  const tick1 = planMatches([T('a', 5, 0), T('p', 7, 0), T('q', 7, 0), T('r', 7, 0), T('far', 6, 4900)], MM_BUDGET_QUICK_MS, OPTS);
  const aGrant = (tick1.grants || []).find((g) => g.memberId === 'a');
  ok('tick 1: a grants itself grace off a room that (this tick) still looks completable', !!aGrant, JSON.stringify(tick1.grants));
  ok('...q and r group with each other in the SAME tick, spending the reinforcements a relied on',
    tick1.groups.some((g) => g.memberIds.includes('q') && g.memberIds.includes('r')), JSON.stringify(tick1.groups));
  const aWaiting1 = tick1.waiting.find((w) => w.memberId === 'a');
  ok('a granted-this-tick ticket still appears in `waiting`, not dropped like a seated one', !!aWaiting1, JSON.stringify(tick1.waiting));
  ok('...reporting phase "grace" and the +/-2 band it was just granted',
    aWaiting1?.phase === 'grace' && aWaiting1.bandLo === 3 && aWaiting1.bandHi === 7, JSON.stringify(aWaiting1));
  ok('...and the FULL fresh grace duration as remainingMs', aWaiting1?.remainingMs === MM_GRACE_MS, String(aWaiting1?.remainingMs));
  ok('bystanders see the TRUE still-searching count (a, p in grace + far genuinely searching = 3), not undercounted',
    tick1.waiting.every((w) => w.searchingCount === 3), JSON.stringify(tick1.waiting.map((w) => [w.memberId, w.searchingCount])));

  // Tick 2: the caller has stamped a's and p's graceUntil from tick 1's grants; q and r are gone —
  // they are in a match now, so they are simply absent from the tickets this call is given. Well
  // before either window would naturally expire (both graceUntil=10000), the room they were
  // extended for no longer exists.
  const tick2 = planMatches([
    { memberId: 'a', mode: 'quick', level: 5, trophies: 0, queuedAt: 0, budgetMs: MM_BUDGET_QUICK_MS, graceUntil: aGrant.graceUntil },
    { memberId: 'p', mode: 'quick', level: 7, trophies: 0, queuedAt: 0, budgetMs: MM_BUDGET_QUICK_MS, graceUntil: aGrant.graceUntil },
    T('far', 6, 4900),
  ], 6000, OPTS);
  ok('resolved WELL before its 10000ms grace window would have expired (revoked at t=6000)', 6000 < aGrant.graceUntil, String(aGrant.graceUntil));
  ok('a and p resolve together the moment their room stops being completable, reason "grace"',
    tick2.groups.some((g) => g.memberIds.includes('a') && g.memberIds.includes('p') && g.reason === 'grace'),
    JSON.stringify(tick2.groups));
  ok('...and "far" (not part of the collapsed justification) is left genuinely searching',
    tick2.waiting.length === 1 && tick2.waiting[0].memberId === 'far', JSON.stringify(tick2.waiting));
}
{ // The at-most-once gate must actually be EXERCISED: an expired grace meets a FRESH nearby
  // cluster at the exact expiry instant, so completability is true — yet it must still not
  // re-grant. (The pre-existing "expired grace" test above uses a lone ticket where nearby=0
  // regardless of the gate, so it never caught a reviewer mutation of `!graceSpent` to `!inGrace`.)
  const gate = planMatches([
    { memberId: 'a', mode: 'quick', level: 5, trophies: 0, queuedAt: 0, budgetMs: MM_BUDGET_QUICK_MS, graceUntil: MM_BUDGET_QUICK_MS + MM_GRACE_MS },
    T('p', 7, 0), T('q', 7, 0), T('r', 7, 0),
  ], MM_BUDGET_QUICK_MS + MM_GRACE_MS, OPTS);
  ok('a completable nearby cluster at the expiry instant still does not re-grant',
    (gate.grants || []).length === 0, JSON.stringify(gate.grants));
  ok('...it resolves via its expired grace instead', gate.groups.some((g) => g.memberIds.includes('a') && g.reason === 'grace'), JSON.stringify(gate.groups));
  ok('...while the nearby cluster groups on its own, unaffected',
    gate.groups.some((g) => g.memberIds.includes('p') && g.memberIds.includes('q') && g.memberIds.includes('r') && g.reason === 'deadline'),
    JSON.stringify(gate.groups));
}

console.log(failed ? `\n❌ ${failed} failed` : '\n✅ all passed');
process.exit(failed ? 1 : 0);
