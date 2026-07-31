// Measure how tall the CLUBS screen is on an iPhone viewport with a FULL club.
// An empty club never scrolls, so measuring one proves nothing — the real member row is cloned to 30
// (the cap), which is the case the layout actually has to survive.
//   PORT=3014 node _ui-measure.mjs               → current CSS
//   PORT=3014 NO_DENSITY=1 node _ui-measure.mjs  → density pass disabled, for a before/after
import { WebSocket } from 'ws'
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

const TOK = readFileSync('/tmp/ftoken.txt', 'utf8').trim()
const PORT = process.env.PORT || 3014
const CDP = 9477
const PROF = `/tmp/ui-${process.pid}`
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${PROF}`, '--no-first-run',
    '--disable-gpu', '--hide-scrollbars', '--window-size=402,874', 'about:blank'], { stdio: 'ignore' })
process.on('exit', () => { try { chrome.kill() } catch {} })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let url
for (let i = 0; i < 60; i++) {
  try {
    const j = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()
    const p = j.filter((t) => t.type === 'page')
    if (p.length) { url = p[0].webSocketDebuggerUrl; break }
  } catch { /* not up yet */ }
  await sleep(250)
}
const ws = new WebSocket(url); await new Promise((r) => ws.once('open', r))
let id = 0; const pend = new Map()
ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id) } })
const send = (m, p = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })) })
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.value

await send('Runtime.enable'); await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 402, height: 874, deviceScaleFactor: 2, mobile: true })
await send('Page.navigate', { url: `http://localhost:${PORT}/?ftoken=${encodeURIComponent(TOK)}` })
await sleep(6500)

if (process.env.NO_DENSITY) {
  await ev(`(()=>{const st=document.createElement('style');
    st.textContent='.member-list{display:flex!important}.member .pos{display:block!important}.club-actions{display:block!important}.club-actions>*{margin-bottom:8px!important}';
    document.head.appendChild(st); return 'off'})()`)
}

await ev(`document.querySelectorAll('.screen').forEach(s=>s.classList.add('hidden'));document.getElementById('clubs').classList.remove('hidden');'ok'`)
await sleep(2500)

const injected = await ev(`(()=>{
  const l=document.querySelector('#clubs .member-list'); if(!l) return 'NO LIST';
  const proto=l.querySelector('.member'); if(!proto) return 'NO ROW';
  l.classList.remove('solo');
  for(let i=1;i<30;i++) l.append(proto.cloneNode(true));
  return 'rows='+l.querySelectorAll('.member').length })()`)
await sleep(800)

const m = await ev(`(()=>{const b=document.querySelector('#clubs .subpage-body'); if(!b) return null;
  const l=document.querySelector('#clubs .member-list');
  return { scrollHeight: Math.round(b.scrollHeight), viewport: Math.round(b.clientHeight),
    screensOfScroll: +(b.scrollHeight/b.clientHeight).toFixed(2),
    memberListPx: l ? Math.round(l.getBoundingClientRect().height) : 0,
    columns: l ? getComputedStyle(l).gridTemplateColumns : 'n/a' }})()`)

console.log(process.env.NO_DENSITY ? 'BEFORE (density off)' : 'AFTER  (density on)', '·', injected)
console.log(JSON.stringify(m, null, 1))
mkdirSync('/tmp/uishots', { recursive: true })
const { data } = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
writeFileSync(`/tmp/uishots/${process.env.NO_DENSITY ? 'before' : 'after'}.png`, Buffer.from(data, 'base64'))
process.exit(0)
