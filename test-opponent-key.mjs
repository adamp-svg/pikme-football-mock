// shared/opponent-key.js — the opaque opponent id behind the backend's win-trading cap.
// Run: node test-opponent-key.mjs
//
// The whole point of this key is that it stays the SAME when two accounts meet again. If it drifted
// per match, the cap would never fire and nobody would notice — so that's the property tested hardest.

import { opponentKeyFrom, opponentKeyFor } from './shared/opponent-key.js';

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log('  ✓', msg);
  else { console.error('  ✗', msg); failures++; }
}

// Two logged-in accounts. Connection ids (m-N) change every match; userIds do not.
const alice1 = { id: 'm-1', userId: 'user-alice' };
const bob1 = { id: 'm-2', userId: 'user-bob' };
const carol1 = { id: 'm-3', userId: 'user-carol' };
// The SAME two people reconnecting later — fresh connection ids, same accounts.
const alice2 = { id: 'm-77', userId: 'user-alice' };
const bob2 = { id: 'm-78', userId: 'user-bob' };

console.log('opponentKeyFrom basics:');
assert(opponentKeyFrom([]) === '', 'no opponents (bots only) = empty key, never capped');
assert(opponentKeyFrom(null) === '', 'null is survivable');
assert(opponentKeyFrom(['', null, undefined]) === '', 'blank ids are dropped, leaving an empty key');
assert(opponentKeyFrom(['a']).length === 32, 'a key is a 32-char hash');
assert(!opponentKeyFrom(['user-alice']).includes('user-alice'), 'the account id is NOT recoverable from the key');

console.log('order independence — both sides of a pairing must agree:');
assert(opponentKeyFrom(['a', 'b']) === opponentKeyFrom(['b', 'a']), 'argument order does not change the key');
assert(opponentKeyFrom(['a', 'b', 'c']) === opponentKeyFrom(['c', 'a', 'b']), 'holds for 3 opponents too');

console.log('distinctness:');
assert(opponentKeyFrom(['a']) !== opponentKeyFrom(['b']), 'different opponents = different keys');
assert(opponentKeyFrom(['a']) !== opponentKeyFrom(['a', 'b']), 'a 1v1 vs a 2v2 with the same person differ');

console.log('THE KEY PROPERTY — stable across matches (the cap fires on a rematch):');
const m1 = opponentKeyFor([[alice1, 'A'], [bob1, 'B']], alice1, 'A');
const m2 = opponentKeyFor([[alice2, 'A'], [bob2, 'B']], alice2, 'A');
assert(m1 === m2, 'Alice vs Bob yields the SAME key on a later match despite new connection ids');
assert(m1 !== '', 'and it is not empty');

console.log('the key is a PER-PLAYER view ("who I faced"), NOT a shared pairing id:');
const aliceView = opponentKeyFor([[alice1, 'A'], [bob1, 'B']], alice1, 'A');
const bobView = opponentKeyFor([[alice1, 'A'], [bob1, 'B']], bob1, 'B');
assert(aliceView !== bobView, 'Alice and Bob get DIFFERENT keys — each hashes the other, not the pairing');
assert(aliceView === opponentKeyFrom(['user-bob']), "Alice's key identifies Bob");
assert(bobView === opponentKeyFrom(['user-alice']), "Bob's key identifies Alice");
// This is correct because each key is counted in its OWN player's document (opponentsToday lives on
// the footballstats doc of the player it belongs to). They don't need to match — both players hit the
// 3-meeting cap on the same match anyway, because they played the same matches.
assert(
    opponentKeyFor([[alice2, 'A'], [bob2, 'B']], bob2, 'B') === bobView,
    "and Bob's own key for Alice is likewise stable across matches",
);

console.log('a reshuffled 2v2 is a DIFFERENT matchup, so it starts its own count:');
const dave1 = { id: 'm-4', userId: 'user-dave' };
const pairing1 = opponentKeyFor([[alice1, 'A'], [carol1, 'A'], [bob1, 'B'], [dave1, 'B']], alice1, 'A');
const pairing2 = opponentKeyFor([[alice1, 'A'], [bob1, 'A'], [carol1, 'B'], [dave1, 'B']], alice1, 'A');
assert(pairing1 === opponentKeyFrom(['user-bob', 'user-dave']), 'Alice faced Bob+Dave');
assert(pairing1 !== pairing2, 'after teams shuffle she faces Carol+Dave — a new key, counted separately');

console.log('team filtering:');
const withMate = opponentKeyFor([[alice1, 'A'], [carol1, 'A'], [bob1, 'B']], alice1, 'A');
assert(withMate === opponentKeyFrom(['user-bob']), 'a TEAM-MATE is not an opponent and is excluded');
assert(opponentKeyFor([[alice1, 'A']], alice1, 'A') === '', 'solo vs bots = empty key');
assert(opponentKeyFor([[alice1, 'A'], [bob1, null]], alice1, 'A') === '', 'an unassigned member is ignored');

console.log('guests (no userId) fall back to the connection id — honestly uncappable:');
const guest1 = { id: 'm-9' };
const guest2 = { id: 'm-40' };
const g1 = opponentKeyFor([[alice1, 'A'], [guest1, 'B']], alice1, 'A');
const g2 = opponentKeyFor([[alice2, 'A'], [guest2, 'B']], alice2, 'A');
assert(g1 !== '' && g1 !== g2, 'a guest opponent yields a DIFFERENT key each match, so no cap applies');

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
