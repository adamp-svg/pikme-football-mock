// DEV clubs + scoped-ranking API for the game client.
//
// ⚠️ This is the PROTOTYPE surface, in-memory, seeded, no auth. Clubs belong in `pikme-server`
// (that is where identity, friends, footballstats.{xp,wins,careerGoals}, the trophy track and
// PlayerCardStats.totalCards already live, and where the other dev left the `group` scope seam in
// routes-pikme/leaderboard/scope.js). This module exists so the UI can be built and reviewed against
// the AGREED RESPONSE SHAPES before anything is deployed to a live server. Swap the base URL and the
// client does not change.
//
// Endpoints (all GET unless noted):
//   /api/clubs/me                      → my club + my derived scopes (city/school/grade/class)
//   /api/clubs/board?metric=&scope=    → scopes of one kind ranked against each other (top-3 placement)
//   /api/clubs/find                    → clubs near me, ordered by overlap with my scopes
//   /api/clubs/suggest                 → players to befriend/invite, ordered class → school → grade → city
//   POST /api/clubs/create  {name}     → create a club, become its president
//   POST /api/clubs/join    {clubId}   → join (respects the 30 cap)
//   POST /api/clubs/leave              → leave; membership of city/school/class is NOT leaveable
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { rankScopes, DEFAULT_K } from './placement.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dir = JSON.parse(fs.readFileSync(path.join(__dirname, '../public/data/schools-directory.json'), 'utf8'))

export const MAX_CLUB_MEMBERS = 30

// Club shape follows Brawl Stars, per CLAUDE.md's "research the big games" rule:
//   • three types — open (instant join if you clear the bar) · invite (request, president approves) ·
//     closed (nobody new)
//   • a minimum-TROPHY requirement the president sets, shown on every listing
//   • a recommended list with a Refresh, plus search by name
//   • four ranks: president > vice > senior > member. Each rank accepts and kicks strictly BELOW
//     itself; the president can never be kicked.
// Sources: supercell support "Creating or Joining a Club", gamerempire clubs guide, mobilematters roles guide.
export const CLUB_TYPES = ['open', 'invite', 'closed']
export const ROLES = ['president', 'vice', 'senior', 'member']
const roleRank = (r) => ROLES.indexOf(r)
// Can `actor` act on `target`? Strictly-below rule, so a senior can kick a member but never a senior.
export const canActOn = (actor, target) => roleRank(actor) < roleRank(target)
export const canAdmit = (role) => roleRank(role) <= roleRank('senior')

export const METRICS = [
  { key: 'xp', labelHe: 'הכי הרבה XP' },
  { key: 'trophies', labelHe: 'הכי הרבה גביעים' },
  { key: 'goals', labelHe: 'הכי הרבה שערים' },
  { key: 'wins', labelHe: 'הכי הרבה נצחונות' },
  { key: 'cards', labelHe: 'הכי הרבה קלפים' },
]
const SCOPE_KINDS = ['city', 'school', 'class', 'club']

// City/school display names come from the SAME bundled directory the app's onboarding uses, so a club
// built here and a profile filled in the app always read the same Hebrew name for the same id.
const CITY_MERGES = { '675414749': '2025178902' }
const CITY_NAME_OVERRIDES = { '2025178902': 'תל אביב-יפו' }
const canonicalCity = (id) => CITY_MERGES[String(id)] || String(id)
const cities = dir.cities.filter((c) => !CITY_MERGES[c.id])
  .map((c) => ({ ...c, nameHe: CITY_NAME_OVERRIDES[c.id] || c.nameHe }))
const cityById = new Map(cities.map((c) => [c.id, c]))
const schoolById = new Map(dir.schools.map((s) => [s.id, s]))
const GRADE_HE = { 1: 'א׳', 2: 'ב׳', 3: 'ג׳', 4: 'ד׳', 5: 'ה׳', 6: 'ו׳', 7: 'ז׳', 8: 'ח׳', 9: 'ט׳', 10: 'י׳', 11: 'י״א', 12: 'י״ב' }

// ── seeded demo population ────────────────────────────────────────────────────────────────────────
// Deterministic (no Math.random) so screenshots and tests are reproducible. Two of the cities are
// deliberately tiny and strong, so the small-city case is visible on screen rather than argued about.
const NAMES = ['אדם', 'נווה', 'שובל', 'פז', 'אורי', 'יהלי', 'רוני', 'איתי', 'ליאם', 'דניאל', 'עומר', 'מאיה',
  'גיא', 'תמר', 'יובל', 'אלון', 'שירה', 'נועה', 'עידו', 'רותם', 'אריאל', 'הדר', 'טל', 'ניר']
const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) } return Math.abs(h) }

function seedPlayers() {
  const picks = [
    // [cityName, schoolIndexWithinCity, howManyPlayers, strengthBias]
    ['תל אביב-יפו', 0, 14, 0.55], ['תל אביב-יפו', 1, 9, 0.5], ['חיפה', 0, 11, 0.6],
    ['ירושלים', 0, 12, 0.5], ['באר שבע', 0, 8, 0.45], ['רעננה', 0, 6, 0.7],
    ['אבו תלול', 0, 3, 0.95], ['בית ג׳ן', 0, 3, 0.92], ['ירוחם', 0, 4, 0.8],
  ]
  const players = []
  let n = 0
  for (const [cityName, schoolIdx, count, bias] of picks) {
    const city = cities.find((c) => c.nameHe === cityName) || cities[hash(cityName) % cities.length]
    const schools = dir.schools.filter((s) => canonicalCity(s.cityId) === city.id)
    const school = schools[schoolIdx % Math.max(1, schools.length)] || schools[0]
    for (let i = 0; i < count; i++) {
      const id = `u${++n}`
      const r = (hash(id + cityName) % 1000) / 1000
      const strength = bias * 0.6 + r * 0.4
      players.push({
        id,
        nickName: `${NAMES[n % NAMES.length]}${n > NAMES.length ? n : ''}`,
        cityId: city.id,
        schoolId: school ? school.id : null,
        grade: 4 + (hash(id) % 6),
        classNumber: 1 + (hash(id + 'c') % 4),
        clubId: null,
        xp: Math.round(strength * 48000),
        trophies: Math.round(strength * 3200),
        goals: Math.round(strength * 410),
        wins: Math.round(strength * 190),
        cards: Math.round(strength * 170),
      })
    }
  }
  return players
}

const players = seedPlayers()
const byId = new Map(players.map((p) => [p.id, p]))
const ME = 'u1' // the demo caller

// Seeded clubs, so "find clubs near me" has something to order.
let clubSeq = 0
const clubs = new Map()
const friendRequests = new Map() // `${from}->${to}` -> 'pending' | 'accepted'
const joinRequests = new Map()   // clubId -> Set(userId)

function makeClub(name, ownerId, emblem = '🏰', type = 'open', minTrophies = 0) {
  const id = `c${++clubSeq}`
  clubs.set(id, { id, name, emblem, ownerId, type, minTrophies, members: [{ id: ownerId, role: 'president' }], createdSeq: clubSeq })
  byId.get(ownerId).clubId = id
  return clubs.get(id)
}
function seedClubs() {
  const groups = [
    ['אלופי הצפון', 'u30', '🦁', 'open', 0],
    ['נבחרת השכונה', 'u3', '⚡', 'open', 0],
    ['ילדי המדבר', 'u62', '🐪', 'invite', 1200],
    ['הכרישים', 'u12', '🦈', 'closed', 2400],
  ]
  for (const [name, owner, emblem, type, min] of groups) if (byId.has(owner)) makeClub(name, owner, emblem, type, min)
  const RANKS = ['vice', 'senior', 'member', 'member', 'member']
  for (const club of clubs.values()) {
    const owner = byId.get(club.ownerId)
    const near = players.filter((p) => !p.clubId && p.cityId === owner.cityId).slice(0, 5)
    near.forEach((p, i) => { p.clubId = club.id; club.members.push({ id: p.id, role: RANKS[i] || 'member' }) })
  }
}
seedClubs()

const memberIdsOf = (club) => club.members.map((m) => m.id)
const roleOf = (club, userId) => club.members.find((m) => m.id === userId)?.role || null
const friendState = (a, b) => friendRequests.get(`${a}->${b}`) || friendRequests.get(`${b}->${a}`) || null
const areFriends = (a, b) => friendState(a, b) === 'accepted'

// ── scope helpers ─────────────────────────────────────────────────────────────────────────────────
const scopeKeyOf = (kind) => (p) => {
  if (kind === 'city') return p.cityId
  if (kind === 'school') return p.schoolId
  if (kind === 'class') return p.schoolId && p.grade != null && p.classNumber != null
    ? `${p.schoolId}|${p.grade}|${p.classNumber}` : null
  if (kind === 'club') return p.clubId
  return null
}

// A player's own national place on one metric — what the profile shows as "דירוג גביעים / XP".
function nationalPlaceOf(userId, metric) {
  const sorted = [...players].sort((a, b) => b[metric] - a[metric])
  let place = 0, prev = null
  for (let i = 0; i < sorted.length; i++) {
    if (prev === null || sorted[i][metric] !== prev) { place = i + 1; prev = sorted[i][metric] }
    if (sorted[i].id === userId) return { place, of: sorted.length }
  }
  return { place: null, of: sorted.length }
}

// The PUBLIC view of another player — used by the friend card, the in-game name tap and the profile.
//
// ⚠️ PRIVACY SPLIT, deliberate. Club and city are public: a club is user-chosen and public by nature
// (Brawl Stars shows it to everyone), and a city is coarse. School, grade and class are returned ONLY
// to an accepted friend — "this 12-year-old is in class ז׳3 at this named school" is precisely what
// the app's frozen profile spec keeps off public rows, and a match puts you next to strangers.
// To make everything public, delete the `friend` guard below — one line, deliberately easy to find.
function publicPlayer(viewerId, p) {
  const friend = viewerId === p.id || areFriends(viewerId, p.id)
  const club = p.clubId ? clubs.get(p.clubId) : null
  return {
    id: p.id,
    nickName: p.nickName,
    xp: p.xp, trophies: p.trophies, goals: p.goals, wins: p.wins, cards: p.cards,
    ranks: { trophies: nationalPlaceOf(p.id, 'trophies'), xp: nationalPlaceOf(p.id, 'xp') },
    club: club && { id: club.id, name: club.name, emblem: club.emblem, role: roleOf(club, p.id), count: club.members.length },
    scopes: {
      city: p.cityId ? { id: p.cityId, label: scopeLabel('city', p.cityId) } : null,
      school: friend && p.schoolId ? { id: p.schoolId, label: scopeLabel('school', p.schoolId) } : null,
      class: friend && scopeKeyOf('class')(p) ? { id: scopeKeyOf('class')(p), label: scopeLabel('class', scopeKeyOf('class')(p)) } : null,
    },
    friend,
    friendPending: friendState(viewerId, p.id) === 'pending',
  }
}
function scopeLabel(kind, id) {
  if (kind === 'city') return cityById.get(id)?.nameHe || id
  if (kind === 'school') return schoolById.get(id)?.displayName || id
  if (kind === 'class') {
    const [sid, g, c] = String(id).split('|')
    return `${GRADE_HE[g] || g}${c} · ${schoolById.get(sid)?.displayName || ''}`
  }
  if (kind === 'club') return clubs.get(id)?.name || id
  return String(id)
}
const emblemFor = (kind, id) => (kind === 'club' ? clubs.get(id)?.emblem || '🏰' : { city: '🏙️', school: '🏫', class: '🎒' }[kind])

// Derived scopes are READ-ONLY: they come from the app profile and a player can never leave them.
function myScopes(me) {
  return {
    city: me.cityId ? { id: me.cityId, label: scopeLabel('city', me.cityId) } : null,
    school: me.schoolId ? { id: me.schoolId, label: scopeLabel('school', me.schoolId) } : null,
    class: scopeKeyOf('class')(me) ? { id: scopeKeyOf('class')(me), label: scopeLabel('class', scopeKeyOf('class')(me)) } : null,
    club: me.clubId ? { id: me.clubId, label: scopeLabel('club', me.clubId) } : null,
  }
}

function board(metric, kind) {
  const rows = rankScopes(players, scopeKeyOf(kind), { value: (p) => p[metric] })
  return rows.map((r) => ({
    rank: r.rank, scopeId: r.scopeId, label: scopeLabel(kind, r.scopeId), emblem: emblemFor(kind, r.scopeId),
    score: r.score, members: r.members, padded: r.padded, best: r.best,
  }))
}

// Closeness drives ORDER ONLY. The payload never says WHY someone ranked high and never returns another
// player's city/school/grade/class — his frozen profile spec forbids exposing academic details on a
// public row, and "same class as you" is exactly such a detail.
function closeness(me, p) {
  let s = 0
  if (me.schoolId && p.schoolId === me.schoolId) {
    s += 40
    if (p.grade === me.grade) { s += 20; if (p.classNumber === me.classNumber) s += 40 }
  }
  if (me.cityId && p.cityId === me.cityId) s += 15
  return s
}

// ── router ────────────────────────────────────────────────────────────────────────────────────────
const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}
const readBody = (req) => new Promise((resolve) => {
  let b = ''
  req.on('data', (c) => { b += c })
  req.on('end', () => { try { resolve(JSON.parse(b || '{}')) } catch { resolve({}) } })
})

export function handleClubsApi(req, res, urlPath) {
  if (!urlPath.startsWith('/api/clubs')) return false
  const q = new URL(req.url, 'http://x').searchParams
  const me = byId.get(ME)

  if (urlPath === '/api/clubs/me') {
    const club = me.clubId ? clubs.get(me.clubId) : null
    const myRole = club ? roleOf(club, me.id) : null
    json(res, 200, {
      me: { id: me.id, nickName: me.nickName, xp: me.xp, trophies: me.trophies, goals: me.goals, wins: me.wins, cards: me.cards },
      scopes: myScopes(me),
      ranks: { trophies: nationalPlaceOf(me.id, 'trophies'), xp: nationalPlaceOf(me.id, 'xp') },
      metrics: METRICS,
      maxMembers: MAX_CLUB_MEMBERS,
      k: DEFAULT_K,
      club: club && {
        id: club.id, name: club.name, emblem: club.emblem, type: club.type, minTrophies: club.minTrophies,
        myRole, canAdmit: canAdmit(myRole), count: club.members.length,
        pending: canAdmit(myRole) ? [...(joinRequests.get(club.id) || [])].map((id) => ({ id, nickName: byId.get(id)?.nickName, trophies: byId.get(id)?.trophies })) : [],
        members: club.members.map(({ id, role }) => ({
          id, nickName: byId.get(id).nickName, xp: byId.get(id).xp, trophies: byId.get(id).trophies, role,
          isFriend: areFriends(me.id, id), friendPending: friendState(me.id, id) === 'pending', isMe: id === me.id,
          canKick: canActOn(myRole, role),
        })).sort((a, b) => b.trophies - a.trophies),
      },
    })
    return true
  }

  // The public card for any player — friend list, in-game name tap, profile page.
  if (urlPath.startsWith('/api/clubs/player/')) {
    const p = byId.get(urlPath.split('/').pop())
    if (!p) return json(res, 404, { error: 'no_player' }), true
    json(res, 200, publicPlayer(me.id, p))
    return true
  }

  if (req.method === 'POST' && urlPath === '/api/clubs/friend-request') {
    readBody(req).then((body) => {
      const to = String(body.userId || '')
      if (!byId.has(to) || to === me.id) return json(res, 400, { error: 'bad_target' })
      if (areFriends(me.id, to)) return json(res, 409, { error: 'already_friends' })
      // Mirrors pikme-server /handle-friends/request: a reverse pending request is an ACCEPT, not a
      // duplicate — otherwise two players who both tap «הוסף» sit in limbo forever.
      if (friendRequests.get(`${to}->${me.id}`) === 'pending') {
        friendRequests.set(`${to}->${me.id}`, 'accepted')
        return json(res, 200, { ok: true, mutual: true })
      }
      friendRequests.set(`${me.id}->${to}`, 'pending')
      json(res, 200, { ok: true })
    })
    return true
  }

  if (urlPath === '/api/clubs/board') {
    const metric = METRICS.some((m) => m.key === q.get('metric')) ? q.get('metric') : 'xp'
    const kind = SCOPE_KINDS.includes(q.get('scope')) ? q.get('scope') : 'city'
    const rows = board(metric, kind)
    const mine = myScopes(me)[kind]
    json(res, 200, { metric, scope: kind, k: DEFAULT_K, totalRanked: players.length, mineScopeId: mine?.id || null, rows })
    return true
  }

  // Brawl-Stars-shaped: a RECOMMENDED list you can refresh, or a name search. Every listing carries
  // the two things that decide whether you can get in — type and the trophy bar.
  if (urlPath === '/api/clubs/find') {
    const term = (q.get('q') || '').trim()
    const seed = Number(q.get('seed') || 0)
    let rows = [...clubs.values()].map((c) => {
      const overlap = memberIdsOf(c).reduce((s, id) => s + closeness(me, byId.get(id)), 0)
      const friendsInside = memberIdsOf(c).filter((id) => areFriends(me.id, id)).length
      const full = c.members.length >= MAX_CLUB_MEMBERS
      const meets = me.trophies >= c.minTrophies
      return {
        id: c.id, name: c.name, emblem: c.emblem, type: c.type, minTrophies: c.minTrophies,
        count: c.members.length, full, meets, friendsInside,
        // What tapping the button will actually do, decided server-side so the client never guesses.
        action: full ? 'full' : c.type === 'closed' ? 'closed' : !meets ? 'locked' : c.type === 'open' ? 'join' : 'request',
        _o: overlap + friendsInside * 25,
      }
    })
    if (term) rows = rows.filter((c) => c.name.includes(term))
    // Recommended = closeness first. Refresh rotates the tail so the list feels alive without
    // reordering the genuinely-best matches.
    rows.sort((a, b) => b._o - a._o || a.count - b.count)
    if (!term && seed) { const head = rows.slice(0, 2), tail = rows.slice(2); for (let i = 0; i < seed % Math.max(1, tail.length); i++) tail.push(tail.shift()); rows = [...head, ...tail] }
    json(res, 200, { rows: rows.map(({ _o, ...r }) => r), myTrophies: me.trophies, term })
    return true
  }

  if (urlPath === '/api/clubs/suggest') {
    const rows = players
      .filter((p) => p.id !== me.id && !p.clubId)
      .map((p) => ({ p, c: closeness(me, p) }))
      .sort((a, b) => b.c - a.c || b.p.xp - a.p.xp)
      .slice(0, 12)
      .map(({ p }) => ({
        id: p.id, nickName: p.nickName, xp: p.xp, trophies: p.trophies,
        isFriend: areFriends(me.id, p.id), friendPending: friendState(me.id, p.id) === 'pending',
      }))
    json(res, 200, { rows })
    return true
  }

  if (req.method === 'POST' && urlPath === '/api/clubs/create') {
    readBody(req).then((body) => {
      const name = String(body.name || '').trim()
      if (name.length < 2 || name.length > 20) return json(res, 400, { error: 'bad_name' })
      if (me.clubId) return json(res, 409, { error: 'already_in_club' })
      const type = CLUB_TYPES.includes(body.type) ? body.type : 'open'
      const min = Math.max(0, Math.min(9999, Number(body.minTrophies) || 0))
      const club = makeClub(name, me.id, String(body.emblem || '🏰').slice(0, 4), type, min)
      json(res, 200, { ok: true, clubId: club.id })
    })
    return true
  }

  if (req.method === 'POST' && urlPath === '/api/clubs/join') {
    readBody(req).then((body) => {
      const club = clubs.get(String(body.clubId))
      if (!club) return json(res, 404, { error: 'no_club' })
      if (club.members.length >= MAX_CLUB_MEMBERS) return json(res, 409, { error: 'club_full' })
      if (club.type === 'closed') return json(res, 403, { error: 'closed' })
      if (me.trophies < club.minTrophies) return json(res, 403, { error: 'below_trophies', need: club.minTrophies })
      // Open → straight in. Invite-only → a request the president or a senior approves.
      if (club.type === 'invite') {
        if (!joinRequests.has(club.id)) joinRequests.set(club.id, new Set())
        joinRequests.get(club.id).add(me.id)
        return json(res, 200, { ok: true, requested: true })
      }
      if (me.clubId) leave(me)
      club.members.push({ id: me.id, role: 'member' })
      me.clubId = club.id
      json(res, 200, { ok: true, joined: true })
    })
    return true
  }

  // President / VP / senior approving a pending request.
  if (req.method === 'POST' && urlPath === '/api/clubs/admit') {
    readBody(req).then((body) => {
      const club = me.clubId ? clubs.get(me.clubId) : null
      if (!club || !canAdmit(roleOf(club, me.id))) return json(res, 403, { error: 'not_allowed' })
      const who = String(body.userId || '')
      if (!joinRequests.get(club.id)?.has(who)) return json(res, 404, { error: 'no_request' })
      if (club.members.length >= MAX_CLUB_MEMBERS) return json(res, 409, { error: 'club_full' })
      const p = byId.get(who)
      if (p.clubId) leave(p)
      club.members.push({ id: who, role: 'member' })
      p.clubId = club.id
      joinRequests.get(club.id).delete(who)
      json(res, 200, { ok: true })
    })
    return true
  }

  // Kick — strictly below your own rank (Brawl Stars rule); the president can never be kicked.
  if (req.method === 'POST' && urlPath === '/api/clubs/kick') {
    readBody(req).then((body) => {
      const club = me.clubId ? clubs.get(me.clubId) : null
      if (!club) return json(res, 403, { error: 'not_allowed' })
      const who = String(body.userId || '')
      if (!canActOn(roleOf(club, me.id), roleOf(club, who))) return json(res, 403, { error: 'not_allowed' })
      leave(byId.get(who))
      json(res, 200, { ok: true })
    })
    return true
  }

  if (req.method === 'POST' && urlPath === '/api/clubs/leave') {
    leave(me)
    json(res, 200, { ok: true })
    return true
  }

  json(res, 404, { error: 'no_route' })
  return true
}

function leave(p) {
  const club = clubs.get(p.clubId)
  if (!club) { p.clubId = null; return }
  const wasPresident = roleOf(club, p.id) === 'president'
  club.members = club.members.filter((m) => m.id !== p.id)
  p.clubId = null
  if (!wasPresident) return
  // Presidency passes to the most senior remaining member rather than orphaning the club — the same
  // succession Brawl Stars uses when a president leaves.
  if (club.members.length === 0) { clubs.delete(club.id); joinRequests.delete(club.id); return }
  club.members.sort((a, b) => roleRank(a.role) - roleRank(b.role) || byId.get(b.id).trophies - byId.get(a.id).trophies)
  club.members[0].role = 'president'
  club.ownerId = club.members[0].id
}
