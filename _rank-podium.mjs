/* Task 1 (stadium + drill-down, slice 1): the pedestal podium on the אני (personal) board.
 *
 * Bootstrap copied from _rank-personal.mjs — the clubs API is stubbed in-page so no token, no Mongo
 * and no live server are needed; the client, DOM and handlers are real. Same two gates documented
 * there and in _rank-full-board.mjs:
 *   1. clubs.js BAILS unless /me answers with a `me` key, leaving #scope-wrap hidden and the board empty.
 *   2. the rank screen opens from #rank-btn — there is no [data-open-screen] for it.
 *
 * Four scenarios, one page load. The personal-board fixture is MUTABLE (window.__PBOARD) so each
 * scenario can swap it and force a fresh /board fetch by re-clicking the אני tab — renderBoard()
 * does `host.innerHTML = ''` on every call, so re-clicking the already-active tab is a full redraw.
 *   1. BASE       — ranks 1..6, contiguous. The brief's own spec assertions (2·1·3 order, centred #1,
 *                   podium ranks never repeat in the list).
 *   2. GAP        — ranks [1,2,3,1202,1203,1204]. Regression check: the divider before the big jump
 *                   must still render even though ranks 1-3 are now drawn on the podium, not in the
 *                   list. (Review finding: `prev` used to start at null unconditionally, so the first
 *                   surviving row's gap check always compared against null and the divider never fired.)
 *   3. TIE_A      — ranks [1,1,1,2]. Proves the podium is chosen BY POSITION, not by `rank<=3`: three
 *                   ties fill three distinct places, and the rank-2 row (not on the podium) still
 *                   shows up in the list below — a naive `rank<=3` filter would also delete it.
 *   4. TIE_B      — ranks [1,1,1,1]. The sharper version: four rows tied at rank 1. Three go on the
 *                   podium, and the 4th MUST still be in the list — a `rank<=3` filter deletes it too,
 *                   since its rank (1) also passes the test.
 *
 *   node _rank-podium.mjs [port] [cdpPort]        # port default 3016; cdpPort default: an OS-assigned
 *                                                  # free port (override with CDP_PORT= or this arg)
 */
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { createServer } from 'node:net'

const PORT = process.argv[2] || '3016'
const OUT = '/private/tmp/claude-501/-Users-adamleeperelman-Documents-pikeme/2ba97360-cc2f-4b64-9852-05d9f15da5fd/scratchpad/rankpodium'
mkdirSync(OUT, { recursive: true })
try { rmSync(OUT + '/profile', { recursive: true, force: true }) } catch {}
setTimeout(() => { console.error('TIMEOUT'); process.exit(2) }, 180000).unref?.()

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
// REVIEW FIX — this used to be a bare `const CDP = 9433`. With 20+ concurrent agents in this repo that
// is a live collision, not a hypothetical one: measured 2026-08-04, a run of this file attached to a
// Chrome another agent already had listening on 9433 and reported a false FAIL (page errors) while
// every real assertion passed. `CDP_PORT` env var / 3rd argv slot forces a specific port (for
// reproducing a result); with neither given, ask the OS for an ephemeral one — nobody else can be
// bound to a port the kernel just handed out, so the default case can no longer collide at all.
const freePort = (fallback) => new Promise((resolve) => {
  const srv = createServer()
  srv.on('error', () => resolve(fallback))
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)) })
})
const CDP = Number(process.env.CDP_PORT || process.argv[3]) || await freePort(9433)

const ME = {
  me: { id: 'u0', nickName: 'אדם' }, maxMembers: 30, k: 3,
  metrics: [{ key: 'trophies', labelHe: 'הכי הרבה גביעים', unitHe: 'גביעים' }],
  scopes: { city: { id: '2025178902' }, school: { id: 'x' }, grade: 5, classNumber: 2 },
  club: null,
}
// 1. BASE — 6 stubbed players, ranked 1..6, contiguous.
const BASE = {
  metric: 'trophies', scope: 'personal', totalRanked: 6,
  me: { rank: 5, value: 8850 },
  rows: [
    { rank: 1, userId: 'a1', nickName: 'דן', club: 'אריות תל אביב', emblem: '🦁', value: 91200, isMe: false },
    { rank: 2, userId: 'a2', nickName: 'מאיה', club: null, emblem: null, value: 88400, isMe: false },
    { rank: 3, userId: 'a3', nickName: 'רוני', club: null, emblem: null, value: 80100, isMe: false },
    { rank: 4, userId: 'a4', nickName: 'עומר', club: 'נשרים', emblem: '🦅', value: 8900, isMe: false },
    { rank: 5, userId: 'a5', nickName: 'יעל', club: null, emblem: null, value: 8850, isMe: true },
    { rank: 6, userId: 'a6', nickName: 'רון', club: null, emblem: null, value: 8790, isMe: false },
  ],
}
// 2. GAP — ranks 1,2,3 (podium) then a big jump to 1202,1203,1204 (the window around "me").
const GAP = {
  metric: 'trophies', scope: 'personal', totalRanked: 1300,
  me: { rank: 1204, value: 80 },
  rows: [
    { rank: 1, userId: 'g1', nickName: 'A', club: null, emblem: null, value: 900, isMe: false },
    { rank: 2, userId: 'g2', nickName: 'B', club: null, emblem: null, value: 800, isMe: false },
    { rank: 3, userId: 'g3', nickName: 'C', club: null, emblem: null, value: 700, isMe: false },
    { rank: 1202, userId: 'g4', nickName: 'D', club: null, emblem: null, value: 100, isMe: false },
    { rank: 1203, userId: 'g5', nickName: 'E', club: null, emblem: null, value: 90, isMe: false },
    { rank: 1204, userId: 'g6', nickName: 'F', club: null, emblem: null, value: 80, isMe: true },
  ],
}
// 3. TIE_A — three-way tie at rank 1, then a clean rank 2. Positional pick must draw 3 distinct
// places from the tie, and the rank-2 row (not chosen) must still appear in the list below.
const TIE_A = {
  metric: 'trophies', scope: 'personal', totalRanked: 4,
  me: { rank: 2, value: 400 },
  rows: [
    { rank: 1, userId: 't1', nickName: 'Alpha', club: null, emblem: null, value: 500, isMe: false },
    { rank: 1, userId: 't2', nickName: 'Beta', club: null, emblem: null, value: 500, isMe: false },
    { rank: 1, userId: 't3', nickName: 'Gamma', club: null, emblem: null, value: 500, isMe: false },
    { rank: 2, userId: 't4', nickName: 'Delta', club: null, emblem: null, value: 400, isMe: true },
  ],
}
// 4. TIE_B — four-way tie at rank 1. The sharpest version: a `rank<=3` filter would match ALL FOUR
// (every row's rank is 1, and 1<=3), deleting the 4th from the list entirely. Positional selection
// must not.
const TIE_B = {
  metric: 'trophies', scope: 'personal', totalRanked: 4,
  me: { rank: 1, value: 300 },
  rows: [
    { rank: 1, userId: 'q1', nickName: 'W1', club: null, emblem: null, value: 300, isMe: false },
    { rank: 1, userId: 'q2', nickName: 'W2', club: null, emblem: null, value: 300, isMe: false },
    { rank: 1, userId: 'q3', nickName: 'W3', club: null, emblem: null, value: 300, isMe: false },
    { rank: 1, userId: 'q4', nickName: 'W4', club: null, emblem: null, value: 300, isMe: true },
  ],
}
// 5. IDLESS — final-review finding: the server OMITS `userId` when its identity join misses
// (pikme-server routes-pikme/clubs.js:1200: `u ? { userId: String(u._id) } : {}`), which used to make
// `podiumId()` return the literal string "undefined" for the row. Ranks 1 and 5 both lack `userId` here
// (and lack `nickName`, so the row falls back to the default 'שחקן' — the exact shape a missed identity
// join produces), rank 1 lands ON the podium and rank 5 does NOT. Before the fix, rank 1's "undefined"
// entered the podium Set and rank 5's OWN "undefined" collided with it, so rank 5 vanished from the list
// and `prev` was never advanced for it either, drawing a spurious `.scope-gap` before rank 6.
const IDLESS = {
  metric: 'trophies', scope: 'personal', totalRanked: 6,
  me: { rank: 3, value: 700 },
  rows: [
    { rank: 1, nickName: null, club: null, emblem: null, value: 900, isMe: false },
    { rank: 2, userId: 'i2', nickName: 'B', club: null, emblem: null, value: 800, isMe: false },
    { rank: 3, userId: 'i3', nickName: 'C', club: null, emblem: null, value: 700, isMe: true },
    { rank: 4, userId: 'i4', nickName: 'D', club: null, emblem: null, value: 600, isMe: false },
    { rank: 5, nickName: null, club: null, emblem: null, value: 500, isMe: false },
    { rank: 6, userId: 'i6', nickName: 'F', club: null, emblem: null, value: 400, isMe: false },
  ],
}

// TASK 2 — the podium on the five GROUP tabs (עיר / בית ספר / שכבה / כיתה / מועדון).
// Group rows are { rank, scopeId, value, members, label?, emblem? } — no nickName, no userId. City and
// school ship WITHOUT a label (the server never sends Hebrew names — see clubs.js's DIR comment), so a
// correct podium here proves the resolve-before-draw ordering; club ships WITH a label already (a club
// name is not something the client derives) so it proves the podium does not stomp a label that is
// already there. scopeId values below are real ids from public/data/schools-directory.json so
// cityName()/schoolName() actually resolve instead of falling back to the id.
const CITY = {
  metric: 'trophies', scope: 'city', k: 3, totalRanked: 5, mineScopeId: '2025178902',
  rows: [
    { rank: 1, scopeId: '2025178902', value: 91200, members: 12 },   // תל אביב-יפו
    { rank: 2, scopeId: '1807972421', value: 88400, members: 9 },    // אום אל-פחם
    { rank: 3, scopeId: '475307122', value: 80100, members: 7 },     // אופקים
    { rank: 4, scopeId: '1444028396', value: 8900, members: 4 },     // אבן שמואל
    { rank: 5, scopeId: '1247515152', value: 8790, members: 2 },     // אבנת
  ],
}
const SCHOOL = {
  metric: 'trophies', scope: 'school', k: 3, totalRanked: 5, mineScopeId: '414482',
  rows: [
    { rank: 1, scopeId: '414482', value: 41200, members: 30 },
    { rank: 2, scopeId: '510784', value: 38400, members: 28 },
    { rank: 3, scopeId: '511212', value: 30100, members: 25 },
    { rank: 4, scopeId: '510255', value: 8900, members: 12 },
    { rank: 5, scopeId: '510339', value: 8790, members: 9 },
  ],
}
// REVIEW FIX (2026-08-04) — a city/school the directory can't resolve. `999999999999` is deliberately
// absent from public/data/schools-directory.json (grepped, 0 hits), so `cityName()` returns null for it
// and PASS 1's fallback (`r.label = r.label || String(r.scopeId)`) backfills the RAW id — exactly the
// case the back button must NOT print verbatim. Ranks 1-3 use real, resolvable ids so the podium paints
// normally; rank 4 (the row the harness clicks, same "first .scope-row" convention as CITY above) is
// the unresolvable one.
const CITY_UNRESOLVED = {
  metric: 'trophies', scope: 'city', k: 3, totalRanked: 4, mineScopeId: '2025178902',
  rows: [
    { rank: 1, scopeId: '2025178902', value: 91200, members: 12 },   // תל אביב-יפו
    { rank: 2, scopeId: '1807972421', value: 88400, members: 9 },    // אום אל-פחם
    { rank: 3, scopeId: '475307122', value: 80100, members: 7 },     // אופקים
    { rank: 4, scopeId: '999999999999', value: 8900, members: 4 },   // not in the directory, on purpose
  ],
}
// Club rows arrive WITH a label already (a club has a user-given name, resolved server-side) — the
// resolve loop's `if (!r.label)` guard must leave it alone.
const CLUB = {
  metric: 'trophies', scope: 'club', k: 3, totalRanked: 5, mineScopeId: 'c1',
  rows: [
    { rank: 1, scopeId: 'c1', value: 51200, members: 18, label: 'אריות תל אביב', emblem: '🦁' },
    { rank: 2, scopeId: 'c2', value: 48400, members: 15, label: 'נשרים', emblem: '🦅' },
    { rank: 3, scopeId: 'c3', value: 40100, members: 11, label: 'הזאבים' },
    { rank: 4, scopeId: 'c4', value: 8900, members: 6, label: 'כרישים' },
    { rank: 5, scopeId: 'c5', value: 8790, members: 3, label: 'נמרים' },
  ],
}
// שכבה/כיתה stay at zero rows — same as the pre-existing default stub — to prove the split loop did not
// break the "not enough players yet" empty state for the two school-scoped tabs.
const EMPTY_GROUP = (scope) => ({ metric: 'trophies', scope, k: 3, totalRanked: 0, mineScopeId: null, rows: [] })

// TASK 4 — drilling into a group row. The server's actual shipped contract (per the task-4 brief's
// "server contract Task 3 actually shipped" section): a `?key=` request answers with the PERSONAL body
// shape (scope:'personal', because the rows ARE PLAYERS) plus a `drill:{kind,key}` envelope. 4 rows so
// the podium (top 3) and the list (the 4th) both get exercised in one fixture, the same reasoning as
// the CITY/SCHOOL/CLUB fixtures above.
const DRILL = {
  metric: 'trophies', scope: 'personal', totalRanked: 4, me: { rank: null, value: 0 },
  rows: [
    { rank: 1, userId: 'd1', nickName: 'שחקן1', club: null, emblem: null, value: 500, isMe: false },
    { rank: 2, userId: 'd2', nickName: 'שחקן2', club: null, emblem: null, value: 400, isMe: false },
    { rank: 3, userId: 'd3', nickName: 'שחקן3', club: null, emblem: null, value: 300, isMe: false },
    { rank: 4, userId: 'd4', nickName: 'שחקן4', club: null, emblem: null, value: 200, isMe: false },
  ],
}

async function main() {
  console.log(`[rank-podium] target server :${PORT} · chrome CDP :${CDP}`)
  const chrome = spawn(CHROME, [`--remote-debugging-port=${CDP}`, '--headless=new', '--no-first-run',
    `--user-data-dir=${OUT}/profile`, '--window-size=844,390', 'about:blank'], { stdio: 'ignore' })
  let target
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(250)
    try { target = (await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()).find(t => t.type === 'page') } catch {}
  }
  if (!target) { chrome.kill(); throw new Error('chrome never came up') }
  const { WebSocket } = await import('ws')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise(r => ws.on('open', r))
  let id = 0; const pending = new Map()
  const send = (m, p = {}) => new Promise(res => { pending.set(++id, res); ws.send(JSON.stringify({ id, method: m, params: p })) })
  const evl = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true }))?.result?.value
  const errors = []
  ws.on('message', d => {
    const m = JSON.parse(d.toString())
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id) }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params?.exceptionDetails?.exception?.description || 'exception')
    if (m.method === 'Log.entryAdded' && m.params?.entry?.level === 'error') errors.push((m.params.entry.url||'') + ' :: ' + m.params.entry.text)
  })
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 3, mobile: true })
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      const ME=${JSON.stringify(ME)};
      window.__PBOARD = ${JSON.stringify(BASE)};   // mutable — each scenario overwrites this, then re-clicks the tab
      // Task 2 — one fixture per GROUP scope, also mutable so the harness can swap city/school/club in
      // and confirm שכבה/כיתה still 0-row-empty after the render split.
      window.__GBOARD = {
        city: ${JSON.stringify(CITY)},
        school: ${JSON.stringify(SCHOOL)},
        grade: ${JSON.stringify(EMPTY_GROUP('grade'))},
        class: ${JSON.stringify(EMPTY_GROUP('class'))},
        club: ${JSON.stringify(CLUB)},
      };
      window.__DRILL = ${JSON.stringify(DRILL)};
      // Every /clubs/board URL this page ever asks for, in order — Task 4's own assertions read this
      // directly (does a drill request carry &key=, does a tab change stop carrying it) rather than
      // inferring it from the DOM, which is the only way to prove the REQUEST shape, not just the render.
      window.__asked = [];
      const real = window.fetch;
      const J = (o) => Promise.resolve(new Response(JSON.stringify(o), { status:200, headers:{'Content-Type':'application/json'} }));
      window.fetch = (u,o) => { const s=String(u);
        if (s.includes('/clubs/board')) window.__asked.push(s);
        if (s.includes('/clubs/me')) return J(ME);
        // Task 4 — a drill-down request carries &key=. The server answers with the PERSONAL body shape
        // (rows are players) plus a drill envelope naming what was asked for, no matter which group
        // scope the key came from — that mirrors the real server, which canonicalises the key but does
        // not care which tab it arrived from.
        if (s.includes('/clubs/board') && /[?&]key=/.test(s)) {
          const km = /scope=([a-z]+)/.exec(s); const kind = km ? km[1] : 'city';
          return J(Object.assign({}, window.__DRILL, { drill: { kind, key: '99032825' } }));
        }
        if (s.includes('/clubs/board') && s.includes('scope=personal')) return J(window.__PBOARD);
        if (s.includes('/clubs/board')) {
          const m = /scope=([a-z]+)/.exec(s); const sc = m ? m[1] : null;
          const fixture = sc && window.__GBOARD[sc];
          return J(fixture || { metric:'trophies', scope: sc || 'city', k:null, totalRanked:0, mineScopeId:null, rows:[] });
        }
        if (s.includes('/clubs/find')) return J({ myTrophies: 8800, rows: [] });
        return real(u,o); };
      window.PIKME_FOOTBALL_TOKEN='harness';
    })()`,
  })
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?ftoken=harness` })
  await sleep(3500)

  // Gate 2: the rank screen opens from #rank-btn, not a [data-open-screen] delegate.
  await evl(`document.getElementById('rank-btn').click()`)
  await sleep(1500)
  await evl(`[...document.querySelectorAll('#scope-board .scope-tab')].find(t=>t.textContent==='אני')?.click()`)
  await sleep(2000)

  const READ = `(() => {
    const pod = document.querySelector('.scope-podium')
    const places = pod ? [...pod.querySelectorAll('.pod-place')] : []
    const rows = [...document.querySelectorAll('.scope-row')]
    return JSON.stringify({
      ok: !!pod,
      places: places.length,
      order: places.map(p => p.querySelector('.pod-disc')?.textContent ?? null),
      names: places.map(p => p.querySelector('.pod-name')?.textContent ?? null),
      values: places.map(p => p.querySelector('.pod-val')?.textContent ?? null),
      firstIsCentre: places[1] ? places[1].classList.contains('first') : false,
      listRanks: rows.map(x => x.querySelector('.pos').textContent),
      listUids: rows.map(x => x.dataset.uid ?? null),
      listNames: rows.map(x => (x.querySelector('.nm b') || {}).textContent ?? null),
      gaps: document.querySelectorAll('.scope-gap').length,
      minePlaces: places.map(p => p.classList.contains('mine')),
      mineNames: places.map(p => p.querySelector('.pod-name')?.textContent ?? null),
    })
  })()`

  const fails = []
  const check = (label, cond, detail) => {
    console.log(`  ${cond ? '✓' : '✗'} ${label}${detail !== undefined ? '  — ' + detail : ''}`)
    if (!cond) fails.push(label)
  }
  const reload = async (fixture) => {
    await evl(`window.__PBOARD = ${JSON.stringify(fixture)}`)
    await evl(`[...document.querySelectorAll('#scope-board .scope-tab')].find(t=>t.textContent==='אני')?.click()`)
    await sleep(1500)
    return JSON.parse(await evl(READ))
  }

  console.log('\n1) BASE — ranks 1..6, contiguous (the brief\'s own spec)')
  let got = JSON.parse(await evl(READ))
  console.log('   ', got)
  check('a .scope-podium rendered', got.ok)
  check('3 places', got.places === 3, got.places)
  check('visual order 2·1·3', got.order.join(',') === '2,1,3', got.order.join(','))
  check('#1 sits in the centre column', got.firstIsCentre)
  check('podium ranks (1,2,3) never repeat in the list', !got.listRanks.some(x => ['1','2','3'].includes(x)), got.listRanks.join(','))

  console.log('\n2) GAP — ranks [1,2,3,1202,1203,1204]: the divider must survive the podium skip')
  got = await reload(GAP)
  console.log('   ', got)
  check('3 places', got.places === 3, got.places)
  check('list starts at 1202 (podium ranks excluded)', got.listRanks.join(',') === '1202,1203,1204', got.listRanks.join(','))
  check('exactly one .scope-gap divider (the 3→1202 jump)', got.gaps === 1, got.gaps)

  console.log('\n3) TIE_A — ranks [1,1,1,2]: positional pick, not rank<=3')
  got = await reload(TIE_A)
  console.log('   ', got)
  check('3 places, all filled (no empty placeholder)', got.places === 3 && got.names.every(n => n), got.names.join(','))
  check('3 DISTINCT names on the podium', new Set(got.names).size === 3, got.names.join(','))
  check('the rank-2 row (not on the podium) still appears in the list', got.listUids.includes('t4') && got.listRanks.length === 1, JSON.stringify(got.listUids))

  console.log('\n4) TIE_B — ranks [1,1,1,1]: a rank<=3 filter would delete the 4th row too')
  got = await reload(TIE_B)
  console.log('   ', got)
  check('3 places, all filled (no empty placeholder)', got.places === 3 && got.names.every(n => n), got.names.join(','))
  check('3 DISTINCT names on the podium', new Set(got.names).size === 3, got.names.join(','))
  check('the 4th tied row still appears in the list (rank<=3 would delete it)', got.listUids.includes('q4') && got.listRanks.length === 1, JSON.stringify(got.listUids))

  console.log('\n4b) IDLESS — two identity-less rows (no userId), one on the podium (rank 1) one off it (rank 5)')
  got = await reload(IDLESS)
  console.log('   ', got)
  check('3 places on the podium', got.places === 3, got.places)
  check('the list is ranks 4,5,6 — contiguous, nothing swallowed', got.listRanks.join(',') === '4,5,6', got.listRanks.join(','))
  check('the identity-less rank-5 row is IN the list (not eaten by a shared "undefined" id)', got.listRanks.includes('5'), JSON.stringify(got.listRanks))
  check('rank 5 renders the default nickname, not blank/undefined', got.listNames[got.listRanks.indexOf('5')] === 'שחקן', JSON.stringify(got.listNames))
  check('no spurious .scope-gap (ranks 1..6 are contiguous once the podium is subtracted)', got.gaps === 0, got.gaps)
  // REVIEW FIX (item 3) — rank 3 in this fixture is `isMe:true` AND lands on the podium (top 3). The
  // caller must not be the one row on the whole screen with no "this is you" marker just because they
  // reached the podium — renderPodium used to apply neither `.mine` nor the ' · אני' suffix at all.
  check('the caller\'s own podium slot carries .pod-place.mine', got.minePlaces.some(Boolean), JSON.stringify(got.minePlaces))
  check('exactly one podium slot is mine (not every slot, not none)', got.minePlaces.filter(Boolean).length === 1, JSON.stringify(got.minePlaces))
  check('the mine slot\'s name carries the " · אני" suffix', got.mineNames.some(n => n && n.includes(' · אני')), JSON.stringify(got.mineNames))

  // Screenshot the last-rendered scenario (TIE_B) for a visual sanity check too.
  const shoot = async (name) => {
    // Scoped to #scope-board — same trap as READ_GROUP's note lookup above: an unscoped selector
    // matches the OTHER, hidden-but-still-in-DOM .scope-note from the "no club yet" screen (clubs.js:172,
    // never torn down, just `.hidden`-toggled) before it ever reaches this panel's own element, so the
    // viewport silently never scrolls — caught because every screenshot came back byte-identical.
    await evl(`document.querySelector('#scope-board .scope-podium, #scope-board .scope-note')?.scrollIntoView({block:'center'})`)
    await sleep(400)
    const s = await send('Page.captureScreenshot', { format: 'png' })
    if (s?.data) writeFileSync(`${OUT}/tab-${name}.png`, Buffer.from(s.data, 'base64'))
    console.log('shot ->', `${OUT}/tab-${name}.png`)
  }
  await shoot('personal-tieb')

  // ── TASK 2 — the podium on the five GROUP tabs ──────────────────────────────────────────────────
  // Group rows have no nickName/userId — the podium prints r.label — so this is the exact case the
  // brief warns about: draw before the resolve loop runs and it shows «1953726605» instead of «חיפה».
  const READ_GROUP = `(() => {
    const pod = document.querySelector('.scope-podium')
    const places = pod ? [...pod.querySelectorAll('.pod-place')] : []
    // Scoped to #scope-board — .scope-note also appears in the unrelated "no club yet" screen
    // (clubs.js:172), and an unscoped querySelector picked THAT one up first, which is what made
    // the first draft of 5d/5e fail on a real bug in the test, not in clubs.js.
    const note = document.querySelector('#scope-board .scope-note')
    return JSON.stringify({
      hasPodium: !!pod,
      names: places.map(p => (p.querySelector('.pod-name')||{}).textContent || ''),
      // a group podium must show resolved Hebrew names, never a raw numeric id
      rawIds: places.some(p => /^\\d{6,}$/.test(((p.querySelector('.pod-name')||{}).textContent||'').trim())),
      listCount: document.querySelectorAll('#scope-board .scope-row').length,
      noteText: note ? note.textContent : '',
    })
  })()`
  const clickTab = async (label) => {
    await evl(`[...document.querySelectorAll('#scope-board .scope-tab')].find(t=>t.textContent==='${label}')?.click()`)
    await sleep(1500)
    return JSON.parse(await evl(READ_GROUP))
  }

  console.log('\n5a) עיר tab — the brief\'s own city assertion (5 stubbed group rows, no server-sent label)')
  let g = await clickTab('עיר')
  console.log('   ', g)
  if (!g.hasPodium) throw new Error('FAIL: no podium on the city tab')
  if (g.rawIds) throw new Error('FAIL: podium printed a raw scopeId instead of a Hebrew name')
  console.log('PASS city podium', g)
  check('a .scope-podium rendered on the city tab', g.hasPodium)
  check('podium never prints a raw scopeId — resolved Hebrew names only', !g.rawIds, g.names.join(','))
  check('2 city rows left in the list (5 stubbed − 3 on the podium)', g.listCount === 2, g.listCount)
  await shoot('city')

  console.log('\n5b) בית ספר tab — same server-shape, resolved via schoolName() instead of cityName()')
  g = await clickTab('בית ספר')
  console.log('   ', g)
  check('a .scope-podium rendered on the school tab', g.hasPodium)
  check('school podium is resolved names, not raw ids', !g.rawIds, g.names.join(','))
  check('2 school rows left in the list (5 stubbed − 3 on the podium)', g.listCount === 2, g.listCount)
  await shoot('school')

  console.log('\n5c) מועדון tab — club rows arrive WITH a label already; the resolve pass must not clobber it')
  g = await clickTab('מועדון')
  console.log('   ', g)
  check('a .scope-podium rendered on the club tab', g.hasPodium)
  check('club podium shows the real club names in 2·1·3 order', g.names.join(',') === 'נשרים,אריות תל אביב,הזאבים', g.names.join(','))
  check('2 club rows left in the list (5 stubbed − 3 on the podium)', g.listCount === 2, g.listCount)
  await shoot('club')

  console.log('\n5d) שכבה tab — stubbed with ZERO rows: must stay the pre-existing empty note, no podium')
  g = await clickTab('שכבה')
  console.log('   ', g)
  check('no podium when the group has zero rows', !g.hasPodium)
  check('the empty-state note still renders', /עדיין אין מספיק שחקנים/.test(g.noteText), g.noteText)
  await shoot('grade-empty')

  console.log('\n5e) כיתה tab — same zero-row regression check')
  g = await clickTab('כיתה')
  console.log('   ', g)
  check('no podium when the group has zero rows', !g.hasPodium)
  check('the empty-state note still renders', /עדיין אין מספיק שחקנים/.test(g.noteText), g.noteText)
  await shoot('class-empty')

  // ── TASK 4 — tapping a group row opens that entity's players ───────────────────────────────────
  // Server contract (task-4-brief, authoritative section): a `?key=` request answers with the
  // PERSONAL body shape (scope:'personal' — the rows ARE PLAYERS) plus `drill:{kind,key}`. So the
  // existing `if (data.scope==='personal') return renderPersonal(...)` dispatch already routes this;
  // what Task 4 adds is the click, the request, and the back affordance.
  console.log('\n6) Task 4 — clicking a city row opens the drill-down')
  g = await clickTab('עיר')   // land back on the city group board, 2 rows in the list below the podium
  await evl(`window.__asked = []`)   // isolate: only the request the click below triggers
  await evl(`document.querySelector('#scope-board .scope-row').click()`)
  await sleep(1500)
  let d = JSON.parse(await evl(`(() => {
    const back = document.querySelector('.scope-back')
    const pod = document.querySelector('.scope-podium')
    const rows = [...document.querySelectorAll('#scope-board .scope-row')]
    return JSON.stringify({
      asked: window.__asked.filter(u => u.includes('key=')),
      back: !!back,
      backText: back ? back.textContent : '',
      podium: !!pod,
      podNames: pod ? [...pod.querySelectorAll('.pod-name')].map(n => n.textContent) : [],
      rowCount: rows.length,
      rowsHaveUid: rows.length > 0 && rows.every(r => !!r.dataset.uid),
      rowsLookLikeGroups: rows.some(r => / שחקנים$/.test(((r.querySelector('.nm small') || {}).textContent || '').trim())),
    })
  })()`))
  console.log('   ', d)
  check('the request carried key=', d.asked.length > 0, JSON.stringify(d.asked))
  check('a back affordance appears', d.back, d.backText)
  check('the drilled view renders a podium', d.podium)
  check('podium rows are players (nicknames, not a group label)', d.podNames.length === 3 && d.podNames.every(n => /^שחקן/.test(n)), d.podNames.join(','))
  check('remaining rows carry data-uid (players), not scope ids', d.rowsHaveUid, d.rowCount)
  check('remaining rows are NOT group rows ("N שחקנים" member-count text)', !d.rowsLookLikeGroups)

  console.log('\n7) Task 4 — changing tab clears the drill (no stale key= on the next request)')
  await evl(`window.__asked = []`)
  await evl(`[...document.querySelectorAll('#scope-board .scope-tab')].find(t=>t.textContent==='בית ספר')?.click()`)
  await sleep(1500)
  const afterTab = JSON.parse(await evl(`JSON.stringify(window.__asked)`))
  console.log('   after tab change, asked:', afterTab)
  check('a request followed the tab change', afterTab.length > 0, afterTab.length)
  check('the tab-change request carries no key= (drill was cleared)', afterTab.every(u => !u.includes('key=')), JSON.stringify(afterTab))

  console.log('\n8) Task 4 — changing metric also clears the drill')
  g = await clickTab('עיר')
  await evl(`document.querySelector('#scope-board .scope-row').click()`)
  await sleep(1500)
  await evl(`window.__asked = []`)
  await evl(`document.querySelector('#scope-board .metric-pill').click()`)
  await sleep(1500)
  const afterMetric = JSON.parse(await evl(`JSON.stringify(window.__asked)`))
  console.log('   after metric change, asked:', afterMetric)
  check('a request followed the metric change', afterMetric.length > 0, afterMetric.length)
  check('the metric-change request carries no key= (drill was cleared)', afterMetric.every(u => !u.includes('key=')), JSON.stringify(afterMetric))

  // ── REVIEW FIX — an unresolved city/school must not print its raw scopeId on the back button ──────
  // PASS 1 in renderBoard() backfills `r.label` with `String(r.scopeId)` whenever cityName()/schoolName()
  // return null, so by the time `open()` runs `r.label` is NEVER falsy — testing it directly (the
  // original code) buries the back button's scopeWord() fallback forever. `r.unresolved` is the fix:
  // recorded BEFORE that fallback line runs, so `open()` can still tell "the directory resolved a name"
  // apart from "nothing did." CITY_UNRESOLVED's rank-4 row uses a scopeId (999999999999) grepped absent
  // from schools-directory.json, so cityName() genuinely returns null for it — not a stubbed lie.
  console.log('\n9) REVIEW FIX — an unresolved city falls back to scopeWord(), never the raw scopeId')
  await evl(`window.__GBOARD.city = ${JSON.stringify(CITY_UNRESOLVED)}`)
  await evl(`[...document.querySelectorAll('#scope-board .scope-tab')].find(t=>t.textContent==='עיר')?.click()`)
  await sleep(1500)
  await evl(`document.querySelector('#scope-board .scope-row').click()`)
  await sleep(1500)
  const unresolved = JSON.parse(await evl(`(() => {
    const back = document.querySelector('.scope-back')
    return JSON.stringify({ back: !!back, backText: back ? back.textContent : '' })
  })()`))
  console.log('   ', unresolved)
  check('a back affordance appears for the unresolved city', unresolved.back, unresolved.backText)
  check('back button text is scopeWord(\'city\') = "עיר", never the raw scopeId digits',
    unresolved.back && unresolved.backText.includes('עיר') && !unresolved.backText.includes('999999999999'),
    unresolved.backText)

  ws.close(); chrome.kill()

  // /dev/clubs/my-cards and /dev/friends/rank are pre-existing, unrelated 403s on every dev server
  // here (client.js identity/card passthroughs outside this harness's fetch stub and outside the
  // football-token allowlist) — confirmed present on main before this task, nothing to do with
  // clubs.js. Same class of noise _rank-personal.mjs already filters for /dev/progress.
  const real = errors.filter(e => !/favicon|schools-directory|net::ERR|\/dev\/progress|my-cards|friends\/rank/.test(e))
  if (real.length) fails.push(`page errors: ${real.slice(0, 3).join(' | ')}`)

  console.log(fails.length ? `\n❌ FAIL (${fails.length}):\n  ` + fails.join('\n  ') : '\n✅ PASS — all scenarios')
  process.exit(fails.length ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(1) })
