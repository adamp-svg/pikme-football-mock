// POWER-SLOT AUTO-FILL — the rule that decides whether a player gets any card buffs at all.
//
// The ruling (Adam, 2026-07-31): a player who never opened the card screen must NOT walk into a
// match with three empty power slots. Empty is only ever a deliberate, in-session choice.
//
// This pins the pure half (shared/loadout.js). The wiring half — that the SERVER is actually told,
// on every entry path — is measured in a real browser by _loadout-verify.mjs.
// Run: node test-loadout-backfill.mjs
import assert from 'node:assert'
import { RARITY_RANK, rankForLoadout, backfillLoadout, equippedCount } from './shared/loadout.js'
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

console.log('backfill — a slot emptied ON PURPOSE stays empty')
t('the held slot is skipped and the others still fill', () => {
  // The decision (documented in shared/loadout.js): a slot the player emptied this session is held
  // empty by an {off:1} marker the client keeps in memory + localStorage, and loadLoadout() drops on
  // the next entry. Without it, removal is a no-op — the freed card is by definition the best
  // unequipped one, so it re-equips itself on the very next render.
  const held = new Set([1])
  const out = backfillLoadout([null, null, null], ALBUM, (i) => held.has(i))
  assert.deepEqual(ids(out), ['legendary/5', null, 'legendary/20'])
})
t('holding a slot does not consume the card that would have gone in it', () => {
  const out = backfillLoadout([null, null, null], ALBUM, (i) => i === 0)
  assert.deepEqual(ids(out), [null, 'legendary/5', 'legendary/20'])
})
t('all three held = all three empty (a player may play with no powers)', () => {
  assert.deepEqual(backfillLoadout([null, null, null], ALBUM, () => true), [null, null, null])
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
