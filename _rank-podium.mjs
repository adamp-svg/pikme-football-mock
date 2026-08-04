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
 *   node _rank-podium.mjs [port]        # default 3016
 */
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = process.argv[2] || '3016'
const OUT = '/private/tmp/claude-501/-Users-adamleeperelman-Documents-pikeme/2ba97360-cc2f-4b64-9852-05d9f15da5fd/scratchpad/rankpodium'
mkdirSync(OUT, { recursive: true })
try { rmSync(OUT + '/profile', { recursive: true, force: true }) } catch {}
setTimeout(() => { console.error('TIMEOUT'); process.exit(2) }, 180000).unref?.()

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const CDP = 9433

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

async function main() {
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
      const real = window.fetch;
      const J = (o) => Promise.resolve(new Response(JSON.stringify(o), { status:200, headers:{'Content-Type':'application/json'} }));
      window.fetch = (u,o) => { const s=String(u);
        if (s.includes('/clubs/me')) return J(ME);
        if (s.includes('/clubs/board') && s.includes('scope=personal')) return J(window.__PBOARD);
        if (s.includes('/clubs/board')) return J({ metric:'trophies', scope:'city', k:null, totalRanked:0, mineScopeId:null, rows:[] });
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
      gaps: document.querySelectorAll('.scope-gap').length,
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

  // Screenshot the last-rendered scenario (TIE_B) for a visual sanity check too.
  await evl(`document.querySelector('.scope-podium')?.scrollIntoView({block:'center'})`)
  await sleep(400)
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  if (shot?.data) writeFileSync(`${OUT}/rank-podium.png`, Buffer.from(shot.data, 'base64'))
  console.log('\nshot ->', `${OUT}/rank-podium.png`)

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
