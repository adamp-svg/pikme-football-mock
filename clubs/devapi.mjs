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
function makeClub(name, ownerId, emblem = '🏰') {
  const id = `c${++clubSeq}`
  clubs.set(id, { id, name, emblem, ownerId, memberIds: [ownerId], joinPolicy: 'open', createdSeq: clubSeq })
  byId.get(ownerId).clubId = id
  return clubs.get(id)
}
function seedClubs() {
  const groups = [['אלופי הצפון', 'u30', '🦁'], ['נבחרת השכונה', 'u3', '⚡'], ['ילדי המדבר', 'u62', '🐪'], ['הכרישים', 'u12', '🦈']]
  for (const [name, owner, emblem] of groups) if (byId.has(owner)) makeClub(name, owner, emblem)
  // fill each seeded club with nearby players so overlap ordering has signal
  for (const club of clubs.values()) {
    const owner = byId.get(club.ownerId)
    const near = players.filter((p) => !p.clubId && p.cityId === owner.cityId).slice(0, 5)
    for (const p of near) { p.clubId = club.id; club.memberIds.push(p.id) }
  }
}
seedClubs()

// ── scope helpers ─────────────────────────────────────────────────────────────────────────────────
const scopeKeyOf = (kind) => (p) => {
  if (kind === 'city') return p.cityId
  if (kind === 'school') return p.schoolId
  if (kind === 'class') return p.schoolId && p.grade != null && p.classNumber != null
    ? `${p.schoolId}|${p.grade}|${p.classNumber}` : null
  if (kind === 'club') return p.clubId
  return null
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
    json(res, 200, {
      me: { id: me.id, nickName: me.nickName, xp: me.xp, trophies: me.trophies, goals: me.goals, wins: me.wins, cards: me.cards },
      scopes: myScopes(me),
      metrics: METRICS,
      maxMembers: MAX_CLUB_MEMBERS,
      k: DEFAULT_K,
      club: club && {
        id: club.id, name: club.name, emblem: club.emblem, joinPolicy: club.joinPolicy,
        isPresident: club.ownerId === me.id, count: club.memberIds.length,
        members: club.memberIds.map((id) => ({
          id, nickName: byId.get(id).nickName, xp: byId.get(id).xp,
          role: id === club.ownerId ? 'president' : 'member',
        })).sort((a, b) => b.xp - a.xp),
      },
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

  if (urlPath === '/api/clubs/find') {
    const rows = [...clubs.values()].map((c) => {
      const members = c.memberIds.map((id) => byId.get(id))
      const overlap = members.reduce((s, p) => s + closeness(me, p), 0)
      return {
        id: c.id, name: c.name, emblem: c.emblem, count: c.memberIds.length,
        full: c.memberIds.length >= MAX_CLUB_MEMBERS, joinPolicy: c.joinPolicy, _o: overlap,
      }
    }).sort((a, b) => b._o - a._o || a.count - b.count)
    json(res, 200, { rows: rows.map(({ _o, ...r }) => r) })
    return true
  }

  if (urlPath === '/api/clubs/suggest') {
    const rows = players
      .filter((p) => p.id !== me.id && !p.clubId)
      .map((p) => ({ p, c: closeness(me, p) }))
      .sort((a, b) => b.c - a.c || b.p.xp - a.p.xp)
      .slice(0, 12)
      .map(({ p }) => ({ id: p.id, nickName: p.nickName, xp: p.xp }))
    json(res, 200, { rows })
    return true
  }

  if (req.method === 'POST' && urlPath === '/api/clubs/create') {
    readBody(req).then((body) => {
      const name = String(body.name || '').trim()
      if (name.length < 2 || name.length > 20) return json(res, 400, { error: 'bad_name' })
      if (me.clubId) return json(res, 409, { error: 'already_in_club' })
      const club = makeClub(name, me.id, String(body.emblem || '🏰').slice(0, 4))
      json(res, 200, { ok: true, clubId: club.id })
    })
    return true
  }

  if (req.method === 'POST' && urlPath === '/api/clubs/join') {
    readBody(req).then((body) => {
      const club = clubs.get(String(body.clubId))
      if (!club) return json(res, 404, { error: 'no_club' })
      if (club.memberIds.length >= MAX_CLUB_MEMBERS) return json(res, 409, { error: 'club_full' })
      if (me.clubId) leave(me)
      club.memberIds.push(me.id)
      me.clubId = club.id
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

function leave(me) {
  const club = clubs.get(me.clubId)
  if (!club) { me.clubId = null; return }
  club.memberIds = club.memberIds.filter((id) => id !== me.id)
  me.clubId = null
  if (club.ownerId === me.id) {
    if (club.memberIds.length === 0) clubs.delete(club.id)
    else club.ownerId = club.memberIds[0] // presidency passes down rather than orphaning the club
  }
}
