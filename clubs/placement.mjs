// Top-K placement scoring — how a CITY / SCHOOL / CLASS / CLUB is ranked against its own kind.
//
// The problem this solves: Tel Aviv has thousands of players and a village has three. Ranking a scope
// by the SUM of its members' xp makes the big city win by headcount alone, every metric, forever.
//
// The answer is how school cross-country has scored for a century: a team's score is the sum of its
// best K finishers' PLACES, and the lowest total wins. Depth past K is worth nothing, so a city can
// not buy a title with population — but a small place with three genuinely strong players can win.
//
//   תל אביב  national places 2,3,4,5  → best 3 = 2+3+4 = 9
//   small city         places 1,3,4   → best 3 = 1+3+4 = 8   ← wins
//
// A scope with fewer than K ranked players pads the empty slots with (N + 1), one worse than last
// place, so a single prodigy in a two-player town can not carry it. That padding is the whole reason
// this is fair without a population table — which we do not have anyway: the bundled directory
// carries {id, nameHe} per city and nothing else.
//
// Pure. No I/O, no db, no clock. Every metric here is "more is better" (xp, trophies, goals, wins, cards).

export const DEFAULT_K = 3

// Standard COMPETITION ranking (1,2,2,4) over `value`, descending — ties share the better place and
// consume the slots below them, which is what every leaderboard a kid has ever seen does.
// → Map of playerId -> place (1 = best).
export function nationalPlaces(players, { value = (p) => p.value, id = (p) => p.id } = {}) {
  const sorted = [...players].sort((a, b) => value(b) - value(a))
  const places = new Map()
  let place = 0
  let prevValue = null
  sorted.forEach((p, i) => {
    const v = value(p)
    if (prevValue === null || v !== prevValue) {
      place = i + 1
      prevValue = v
    }
    places.set(id(p), place)
  })
  return places
}

// Score ONE scope from the national places of the players in it.
// Returns { score, counted, members, padded } — `score` is the cross-country total, lower is better.
export function scopeScore(memberPlaces, totalRanked, k = DEFAULT_K) {
  const best = [...memberPlaces].sort((a, b) => a - b).slice(0, k)
  const padValue = totalRanked + 1
  const padded = Math.max(0, k - best.length)
  const score = best.reduce((s, p) => s + p, 0) + padded * padValue
  return { score, counted: best.length, members: memberPlaces.length, padded }
}

// Rank every scope of one kind (all cities, all schools, all clubs …) against each other.
//
//   players   [{ id, value, ...scope keys }]
//   scopeOf   player -> scope id, or null/undefined when the player is not in one
//
// Returns rows sorted best-first, each { scopeId, score, counted, members, padded, rank, best }.
// `rank` is competition ranking over `score` ASCENDING (lower total = better).
export function rankScopes(players, scopeOf, { k = DEFAULT_K, value, id } = {}) {
  const places = nationalPlaces(players, { value, id })
  const getId = id || ((p) => p.id)
  const totalRanked = players.length

  const byScope = new Map()
  for (const p of players) {
    const s = scopeOf(p)
    if (s === null || s === undefined || s === '') continue
    const key = String(s)
    if (!byScope.has(key)) byScope.set(key, [])
    byScope.get(key).push(places.get(getId(p)))
  }

  const rows = [...byScope.entries()].map(([scopeId, memberPlaces]) => ({
    scopeId,
    best: Math.min(...memberPlaces),
    ...scopeScore(memberPlaces, totalRanked, k),
  }))

  // Lower score wins. Tie-break on the single best place inside the scope, so two scopes on the same
  // total are separated by who owns the higher individual finisher — never left in insertion order.
  rows.sort((a, b) => a.score - b.score || a.best - b.best || String(a.scopeId).localeCompare(String(b.scopeId)))

  let rank = 0
  let prev = null
  rows.forEach((row, i) => {
    const key = `${row.score}:${row.best}`
    if (prev === null || key !== prev) {
      rank = i + 1
      prev = key
    }
    row.rank = rank
  })
  return rows
}
