/* Task 1 (stadium + drill-down, slice 1): the pedestal podium on the אני (personal) board.
 *
 * Bootstrap copied from _rank-personal.mjs — the clubs API is stubbed in-page so no token, no Mongo
 * and no live server are needed; the client, DOM and handlers are real. Same two gates documented
 * there and in _rank-full-board.mjs:
 *   1. clubs.js BAILS unless /me answers with a `me` key, leaving #scope-wrap hidden and the board empty.
 *   2. the rank screen opens from #rank-btn — there is no [data-open-screen] for it.
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
// 6 stubbed players, ranked 1..6 — enough to prove the podium takes the top 3 and the list below
// starts at #4, never repeating a podium id.
const PERSONAL = {
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
      const ME=${JSON.stringify(ME)}, P=${JSON.stringify(PERSONAL)};
      const real = window.fetch;
      const J = (o) => Promise.resolve(new Response(JSON.stringify(o), { status:200, headers:{'Content-Type':'application/json'} }));
      window.fetch = (u,o) => { const s=String(u);
        if (s.includes('/clubs/me')) return J(ME);
        if (s.includes('/clubs/board') && s.includes('scope=personal')) return J(P);
        if (s.includes('/clubs/board')) return J({ metric:'trophies', scope:'city', k:null, totalRanked:0, mineScopeId:null, rows:[] });
        if (s.includes('/clubs/find')) return J({ myTrophies: 8800, rows: [] });
        return real(u,o); };
      window.PIKME_FOOTBALL_TOKEN='harness';
    })()`,
  })
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?ftoken=harness` })
  await sleep(3500)

  // Gate 2: the rank screen opens from #rank-btn, not a [data-open-screen] delegate.
  await send('Runtime.evaluate', { expression: `document.getElementById('rank-btn').click()` })
  await sleep(1500)
  // Land on the אני tab explicitly (it may already be default, but don't assume).
  await send('Runtime.evaluate', {
    expression: `[...document.querySelectorAll('#scope-board .scope-tab')].find(t=>t.textContent==='אני')?.click()`,
  })
  await sleep(2000)

  const r = await send('Runtime.evaluate', { expression: `(() => {
  const pod = document.querySelector('.scope-podium')
  if (!pod) return JSON.stringify({ ok: false, why: 'no .scope-podium' })
  const places = [...pod.querySelectorAll('.pod-place')]
  const rows = [...document.querySelectorAll('.scope-row')]
  return JSON.stringify({
    ok: true,
    places: places.length,
    order: places.map(p => p.querySelector('.pod-disc').textContent),
    names: places.map(p => p.querySelector('.pod-name').textContent),
    values: places.map(p => p.querySelector('.pod-val').textContent),
    firstIsCentre: places[1].classList.contains('first'),
    // the three on the podium must NOT repeat in the list below it
    listRanks: rows.map(x => x.querySelector('.pos').textContent),
  })
})()`, returnByValue: true })

  await send('Runtime.evaluate', { expression: `document.querySelector('.scope-podium')?.scrollIntoView({block:'center'})` })
  await sleep(400)
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  if (shot?.data) writeFileSync(`${OUT}/rank-podium.png`, Buffer.from(shot.data, 'base64'))
  console.log('shot ->', `${OUT}/rank-podium.png`)

  ws.close(); chrome.kill()

  const got = JSON.parse(r.result.value)
  console.log(got)
  if (!got.ok) throw new Error('FAIL: ' + got.why)
  if (got.places !== 3) throw new Error(`FAIL: expected 3 places, got ${got.places}`)
  // visual order is 2 · 1 · 3 so #1 sits centre and tallest
  if (got.order.join(',') !== '2,1,3') throw new Error(`FAIL: order was ${got.order}`)
  if (!got.firstIsCentre) throw new Error('FAIL: #1 is not the centre column')
  if (got.listRanks.some(x => ['1','2','3'].includes(x))) throw new Error('FAIL: podium ranks repeated in the list')
  console.log('PASS')
}
main().catch(e => { console.error(e); process.exit(1) })
