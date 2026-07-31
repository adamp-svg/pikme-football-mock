// POWER-SLOT AUTO-FILL — the rule that decides whether a player gets any card buffs at all.
//
// THE RULING (Adam, 2026-07-31, second and final word): "make the cards power slots always have the
// best cards by default whenever a user is in the main lobby ALWAYS!!!!!!!!" Every empty slot fills
// with the best unequipped card, unconditionally. A deliberate PICK is still never overwritten —
// "by default" is about the default, not about beating the player's choice.
//
// SUPERSEDED (same day, earlier): "auto-fill when ENTERING A MATCH", with one carve-out — a slot the
// player emptied on purpose stayed empty for the session, via an {off:1} marker read through a
// `heldEmpty` predicate that used to be backfillLoadout's third argument. The three tests at the
// bottom of the backfill block asserted THAT behaviour; they are still here, flipped, each with a
// note on why — so the next agent can see the old rule was removed on purpose, not lost.
//
// This pins the pure half (shared/loadout.js). The wiring half — that the SERVER is actually told,
// on every entry path — is measured in a real browser by _loadout-verify.mjs.
// Run: node test-loadout-backfill.mjs
import assert from 'node:assert'
import { RARITY_RANK, rankForLoadout, backfillLoadout, bestUnequipped, equippedCount } from './shared/loadout.js'
import { RARITY_LADDER, buffsFromLoadout, loadoutTotalPct } from './shared/bot-buffs.js'

let pass = 0
const t = (name, fn) => { fn(); pass++; console.log('  ✔', name) }

// Deliberately mixed: the highest-WORTH card is a common and the legendaries are cheap, so a
// worth-first ranking and a rarity-first ranking give visibly different answers.
const ALBUM = [
  { r: 'common', n: 3, c: 9, w: 900000 },
  { r: 'rare', n: 22, c: 1, w: 800000 },
  { r: 'epic', n: 7, c: 3, w: 210000 },
  { r: 'legendary', n: 12, c: 1, w: 120000 },
  { r: 'legendary', n: 5, c: 2, w: 90000 },
  { r: 'legendary', n: 20, c: 1, w: 300000 },
]
const ids = (l) => l.map((s) => (s ? s.r + '/' + s.n : null))

console.log('rarity rank')
t('matches bot-buffs RARITY_LADDER — one ordering in the repo, not two', () => {
  assert.deepEqual(RARITY_RANK, { common: 0, rare: 1, epic: 2, legendary: 3 })
  for (const r of RARITY_LADDER) assert.equal(RARITY_RANK[r], RARITY_LADDER.indexOf(r))
})

console.log('rankForLoadout — rarity, then copies, then worth')
t('rarity beats worth: the 900k common never outranks a 90k legendary', () => {
  assert.deepEqual(ids(rankForLoadout(ALBUM)).slice(0, 3), ['legendary/5', 'legendary/20', 'legendary/12'])
})
t('copies break a rarity tie before worth does', () => {
  // legendary/5 has 2 copies and the LOWEST worth of the three legendaries — it still comes first.
  const top = rankForLoadout(ALBUM)[0]
  assert.equal(top.n, 5)
  assert.equal(top.c, 2)
})
t('worth is the last tiebreak', () => {
  const same = [{ r: 'epic', n: 1, c: 1, w: 10 }, { r: 'epic', n: 2, c: 1, w: 99 }]
  assert.deepEqual(ids(rankForLoadout(same)), ['epic/2', 'epic/1'])
})
t('does not mutate the album it was handed', () => {
  const copy = ALBUM.slice()
  rankForLoadout(copy)
  assert.deepEqual(ids(copy.map((c) => c)), ids(ALBUM.map((c) => c)))
})
t('an empty / missing album ranks to nothing instead of throwing', () => {
  assert.deepEqual(rankForLoadout([]), [])
  assert.deepEqual(rankForLoadout(null), [])
  assert.deepEqual(rankForLoadout(undefined), [])
})

console.log('backfill — THE RULING: never enter a match with an empty slot')
t('null loadout (never opened the card screen) fills with the best three', () => {
  assert.deepEqual(ids(backfillLoadout(null, ALBUM)), ['legendary/5', 'legendary/20', 'legendary/12'])
})
t('[null,null,null] — a real, distinct state — fills identically', () => {
  // The old code treated these two as different: null meant "auto-fill", three explicit holes meant
  // "three empty slots". A player cannot tell them apart, and neither should the sim.
  assert.deepEqual(ids(backfillLoadout([null, null, null], ALBUM)), ids(backfillLoadout(null, ALBUM)))
})
t('a partly-filled loadout keeps its picks and fills only the holes', () => {
  const out = backfillLoadout([null, { r: 'common', n: 3 }, null], ALBUM)
  assert.equal(out[1].r, 'common', 'the deliberate pick is never upgraded away')
  assert.equal(out[1].n, 3)
  assert.deepEqual(ids(out), ['legendary/5', 'common/3', 'legendary/20'])
})
t('a slot is never filled with a card another slot already holds', () => {
  const out = backfillLoadout([{ r: 'legendary', n: 5 }, null, null], ALBUM)
  assert.deepEqual(ids(out), ['legendary/5', 'legendary/20', 'legendary/12'])
})
t('a duplicated slot loses the later copy and backfills — same rule as sanitizeLoadout', () => {
  // The server drops a cross-slot duplicate outright. If the client kept it, the lobby would draw a
  // card the sim had already thrown away.
  const out = backfillLoadout([{ r: 'epic', n: 7 }, { r: 'epic', n: 7 }, null], ALBUM)
  assert.equal(new Set(ids(out)).size, 3, 'three distinct cards: ' + JSON.stringify(ids(out)))
  assert.deepEqual(ids(out), ['epic/7', 'legendary/5', 'legendary/20'])
})
t('a full loadout is returned untouched, in its own order', () => {
  const mine = [{ r: 'common', n: 3 }, { r: 'rare', n: 22 }, { r: 'epic', n: 7 }]
  assert.deepEqual(ids(backfillLoadout(mine, ALBUM)), ['common/3', 'rare/22', 'epic/7'])
})
t('a small album fills what it can and leaves the rest empty', () => {
  const out = backfillLoadout(null, [{ r: 'rare', n: 4, c: 1, w: 5 }])
  assert.deepEqual(ids(out), ['rare/4', null, null])
})
t('no album at all is three empty slots, not a crash', () => {
  assert.deepEqual(backfillLoadout(null, []), [null, null, null])
  assert.deepEqual(backfillLoadout(null, null), [null, null, null])
})
t('never mutates the slots it was handed', () => {
  const mine = [null, { r: 'common', n: 3 }, null]
  backfillLoadout(mine, ALBUM)
  assert.deepEqual(ids(mine), [null, 'common/3', null])
})
t('always returns exactly three slots, whatever the input length', () => {
  for (const input of [null, [], [null], [null, null, null, null, null]]) {
    assert.equal(backfillLoadout(input, ALBUM).length, 3)
  }
})
t('junk slots are treated as holes, not carried through', () => {
  const out = backfillLoadout([{ r: 'epic' }, { n: 9 }, {}], ALBUM)   // no n / no r / neither
  assert.equal(equippedCount(out), 3)
  for (const s of out) assert.ok(s.r && s.n != null)
})
t('a leftover {off:1} from an old build is a hole, not a slot', () => {
  // Builds before the 2026-07-31 ruling persisted this marker into localStorage. Every phone that
  // ran one still has it; client.js loadLoadout() reads it as null, and here it is junk like any
  // other. Neither end may honour it, or the ruling stops at the upgrade boundary.
  assert.equal(equippedCount(backfillLoadout([{ off: 1 }, { off: 1 }, { off: 1 }], ALBUM)), 3)
})
t('the loadout it returns is a fixed point — re-running it changes nothing', () => {
  // Every lobby entry now re-runs this (showScreen('home') → renderPowerSlots → effectiveLoadout).
  // If it were not idempotent, walking in and out of the hub would churn the player's slots.
  const once = backfillLoadout(null, ALBUM)
  assert.deepEqual(ids(backfillLoadout(once, ALBUM)), ids(once))
})

console.log('backfill — THE FLIPPED CASES: a slot emptied on purpose no longer stays empty')
// ⚠️ These three asserted the OPPOSITE until 2026-07-31. The old rule was that a slot the player
// emptied this session was held empty by an {off:1} marker, honoured through a `heldEmpty`
// predicate passed as backfillLoadout's third argument. Adam overruled it — "ALWAYS!!!!!!!!" — so
// the marker, the predicate and the argument are all gone. Kept and inverted rather than deleted:
// the deletion is the point, and a missing test reads like an oversight.
t('a third argument cannot hold a slot empty any more — it is ignored', () => {
  // WAS: ['legendary/5', null, 'legendary/20'] with heldEmpty = (i) => i === 1.
  const held = new Set([1])
  const out = backfillLoadout([null, null, null], ALBUM, (i) => held.has(i))
  assert.deepEqual(ids(out), ['legendary/5', 'legendary/20', 'legendary/12'])
})
t('the function takes exactly two parameters — the predicate is not merely unused, it is gone', () => {
  // Arity, not behaviour: an ignored third argument would still let a caller BELIEVE it can ask for
  // a hole. Nothing in the codebase may have that affordance.
  assert.equal(backfillLoadout.length, 2)
})
t('holding slot 0 no longer shifts the best card down a slot', () => {
  // WAS: [null, 'legendary/5', 'legendary/20'].
  const out = backfillLoadout([null, null, null], ALBUM, (i) => i === 0)
  assert.deepEqual(ids(out), ['legendary/5', 'legendary/20', 'legendary/12'])
})
t('there is no longer any way to sit in the lobby with three empty slots and a full album', () => {
  // WAS: all three held = all three empty ("a player may play with no powers"). Deliberately
  // un-buffed play is the one thing this ruling gives up; nobody asked for it and it is strictly
  // worse for the player.
  assert.deepEqual(ids(backfillLoadout([null, null, null], ALBUM, () => true)), ['legendary/5', 'legendary/20', 'legendary/12'])
})

console.log('the remove gesture is a SWAP-OUT — bestUnequipped')
t('removing a card swaps in the next-best, never the card just removed', () => {
  // The three legendaries are equipped; pulling legendary/5 out of slot 0 must bring in epic/7 (the
  // best card in NEITHER of the other two slots), not hand legendary/5 straight back.
  const slots = [{ r: 'legendary', n: 5 }, { r: 'legendary', n: 20 }, { r: 'legendary', n: 12 }]
  assert.deepEqual(bestUnequipped(slots, ALBUM), { r: 'epic', n: 7 })
})
t('it reads the OUTGOING card out of the slots it is handed — that is the exclusion', () => {
  // Called after the slot was cleared instead, the answer is the freed card and the gesture is a
  // visual no-op. This is the ordering bug the helper exists to make impossible to write.
  const cleared = [null, { r: 'legendary', n: 20 }, { r: 'legendary', n: 12 }]
  assert.deepEqual(bestUnequipped(cleared, ALBUM), { r: 'legendary', n: 5 })
})
t('no other card in the album => null, and the caller must refuse the removal', () => {
  const solo = [{ r: 'rare', n: 4, c: 1, w: 5 }]
  assert.equal(bestUnequipped([{ r: 'rare', n: 4 }, null, null], solo), null)
  assert.equal(bestUnequipped([null, null, null], []), null)
  assert.equal(bestUnequipped(null, null), null)
})
t('the swapped-in card obeys the same ranking as the backfill — one rule, not two', () => {
  const out = bestUnequipped([{ r: 'legendary', n: 5 }, null, null], ALBUM)
  assert.deepEqual(out, backfillLoadout([{ r: 'legendary', n: 5 }, null, null], ALBUM)[1])
})
t('a swap-out never leaves a hole for the backfill to find', () => {
  // The whole loop: pull each slot in turn, drop the replacement in, and the result is still full.
  let slots = backfillLoadout(null, ALBUM)
  for (const i of [0, 1, 2]) {
    const next = bestUnequipped(slots, ALBUM)
    assert.ok(next, 'a 6-card album always has a spare')
    slots = slots.map((s, k) => (k === i ? next : s))
    assert.equal(equippedCount(backfillLoadout(slots, ALBUM)), 3)
    assert.equal(new Set(ids(slots)).size, 3, 'and never duplicates: ' + JSON.stringify(ids(slots)))
  }
})

console.log('what the sim actually does with it')
t('the fresh player now gets REAL multipliers, not a flat 1.0', () => {
  const before = buffsFromLoadout([null, null, null])
  assert.deepEqual(before, { cardShot: 1, speedBuff: 1, cardUtil: 1 }, 'three empty slots are no buff at all')
  const after = buffsFromLoadout(backfillLoadout(null, ALBUM))
  assert.ok(after.cardShot > 1 && after.speedBuff > 1 && after.cardUtil < 1)
  assert.ok(Math.abs(loadoutTotalPct(backfillLoadout(null, ALBUM)) - 0.60) < 1e-9, '3 legendaries = the 60% ceiling')
})
t('backfilling can only ever help — total card power never drops', () => {
  const cases = [null, [null, null, null], [{ r: 'common', n: 3 }, null, null], [null, { r: 'rare', n: 22 }, null]]
  for (const c of cases) {
    assert.ok(loadoutTotalPct(backfillLoadout(c, ALBUM)) >= loadoutTotalPct(c || []))
  }
})

console.log(`\n${pass} passed`)
