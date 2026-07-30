// Tests for the top-K placement scoring that ranks cities / schools / classes / clubs.
// Run: node test-clubs-placement.mjs   (picked up by `for f in test*.mjs; do node $f; done`)
import assert from 'node:assert'
import { nationalPlaces, scopeScore, rankScopes, DEFAULT_K } from './clubs/placement.mjs'

let pass = 0
const t = (name, fn) => { fn(); pass++; console.log('  ✔', name) }

console.log('national places')
t('descending value, 1 = best', () => {
  const places = nationalPlaces([{ id: 'a', value: 10 }, { id: 'b', value: 30 }, { id: 'c', value: 20 }])
  assert.equal(places.get('b'), 1)
  assert.equal(places.get('c'), 2)
  assert.equal(places.get('a'), 3)
})
t('ties share the better place and consume the slot below (1,2,2,4)', () => {
  const places = nationalPlaces([
    { id: 'a', value: 50 }, { id: 'b', value: 40 }, { id: 'c', value: 40 }, { id: 'd', value: 10 },
  ])
  assert.equal(places.get('a'), 1)
  assert.equal(places.get('b'), 2)
  assert.equal(places.get('c'), 2)
  assert.equal(places.get('d'), 4)
})
t('everyone tied is all first', () => {
  const places = nationalPlaces([{ id: 'a', value: 7 }, { id: 'b', value: 7 }])
  assert.equal(places.get('a'), 1)
  assert.equal(places.get('b'), 1)
})

console.log('scope score')
t('sums the best K places only — depth past K is worth nothing', () => {
  assert.equal(scopeScore([2, 3, 4, 5], 100).score, 9)   // 2+3+4, the 5 is ignored
  assert.equal(scopeScore([2, 3, 4], 100).score, 9)      // identical with no depth at all
})
t('short scopes pad with N+1, one worse than last place', () => {
  const r = scopeScore([1], 50)                          // one player, national #1
  assert.equal(r.padded, 2)
  assert.equal(r.score, 1 + 51 + 51)
  assert.equal(r.counted, 1)
  assert.equal(r.members, 1)
})
t('an empty scope scores pure padding', () => {
  assert.equal(scopeScore([], 10).score, 3 * 11)
})

console.log("Adam's example — the small city must beat תל אביב")
t('TLV places 2,3,4,5 (score 9) lose to a 3-player city on 1,3,4 (score 8)', () => {
  const players = [
    { id: 'v1', city: 'village', value: 100 },   // national 1
    { id: 't1', city: 'tlv',     value: 90 },    // national 2
    { id: 'v2', city: 'village', value: 80 },    // national 3
    { id: 'v3', city: 'village', value: 70 },    // national 4
    { id: 't2', city: 'tlv',     value: 60 },    // national 5
    { id: 't3', city: 'tlv',     value: 50 },    // national 6
    { id: 't4', city: 'tlv',     value: 40 },    // national 7
  ]
  const rows = rankScopes(players, (p) => p.city)
  const village = rows.find((r) => r.scopeId === 'village')
  const tlv = rows.find((r) => r.scopeId === 'tlv')
  assert.equal(village.score, 1 + 3 + 4)
  assert.equal(tlv.score, 2 + 5 + 6)
  assert.equal(village.rank, 1)
  assert.equal(tlv.rank, 2)
})
t('headcount alone never wins — 40 mediocre players lose to 3 strong ones', () => {
  const players = [
    { id: 's1', city: 'small', value: 1000 },
    { id: 's2', city: 'small', value: 999 },
    { id: 's3', city: 'small', value: 998 },
    ...Array.from({ length: 40 }, (_, i) => ({ id: `b${i}`, city: 'big', value: 100 - i })),
  ]
  const rows = rankScopes(players, (p) => p.city)
  assert.equal(rows[0].scopeId, 'small')
  assert.equal(rows[0].members, 3)
  assert.equal(rows[1].members, 40)
})
t('one prodigy in a two-player town cannot carry it', () => {
  const players = [
    { id: 'p', city: 'tiny', value: 10000 },                                  // national 1
    { id: 'q', city: 'tiny', value: 1 },                                      // national last
    ...Array.from({ length: 10 }, (_, i) => ({ id: `m${i}`, city: 'mid', value: 500 - i })),
  ]
  const rows = rankScopes(players, (p) => p.city)
  assert.equal(rows[0].scopeId, 'mid', 'the town with real depth wins')
  const tiny = rows.find((r) => r.scopeId === 'tiny')
  assert.equal(tiny.padded, 1)
})

console.log('scope ranking mechanics')
t('players with no scope are skipped, not bucketed under null', () => {
  const rows = rankScopes(
    [{ id: 'a', city: 'x', value: 5 }, { id: 'b', city: null, value: 9 }, { id: 'c', value: 1 }],
    (p) => p.city
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].scopeId, 'x')
})
t('equal totals break on the better individual place, never insertion order', () => {
  // both scopes total 1+2+3 vs 1+2+3 is impossible with distinct places, so build a real tie:
  // scope A places 1,4,5 = 10 · scope B places 2,3,5 = 10 → A wins on its better best (1 < 2)
  const players = [
    { id: 'a1', s: 'A', value: 100 }, { id: 'b1', s: 'B', value: 90 }, { id: 'b2', s: 'B', value: 80 },
    { id: 'a2', s: 'A', value: 70 }, { id: 'a3', s: 'A', value: 60 }, { id: 'b3', s: 'B', value: 60 },
  ]
  const rows = rankScopes(players, (p) => p.s)
  assert.equal(rows[0].score, rows[1].score, 'this fixture is meant to tie on score')
  assert.equal(rows[0].scopeId, 'A')
  assert.equal(rows[0].rank, 1)
  assert.equal(rows[1].rank, 2)
})
t('K is configurable', () => {
  const players = Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, s: 'one', value: 60 - i }))
  assert.equal(rankScopes(players, (p) => p.s, { k: 1 })[0].score, 1)
  assert.equal(rankScopes(players, (p) => p.s, { k: 5 })[0].score, 1 + 2 + 3 + 4 + 5)
  assert.equal(DEFAULT_K, 3)
})
t('custom value/id accessors', () => {
  const rows = rankScopes(
    [{ uid: 'a', s: 'x', xp: 10 }, { uid: 'b', s: 'x', xp: 20 }],
    (p) => p.s,
    { value: (p) => p.xp, id: (p) => p.uid }
  )
  assert.equal(rows[0].score, 1 + 2 + 3) // two real places + one pad (N+1 = 3)
})

console.log(`\n${pass} assertions passed`)
