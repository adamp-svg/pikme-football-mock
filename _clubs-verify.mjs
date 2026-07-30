// CLUBS + SCOPED RANKING — real-browser verification (Chrome via CDP, no puppeteer).
// Mirrors the harness in _hub-tour-verify.mjs. Opens the hub, forces each sub-screen visible, asserts
// what actually rendered, and writes screenshots to _clubs-shots/.
//
//   PORT=3013 node _clubs-verify.mjs
import { WebSocket } from 'ws'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'

const PORT = process.env.PORT || 3013
const PAGE = process.env.URL || `http://localhost:${PORT}/`
const CDP_PORT = Number(process.env.CDP_PORT || 9433)
const PROFILE = `/tmp/lab-clubs-${process.pid}`
const SHOTS = new URL('./_clubs-shots/', import.meta.url).pathname
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

let failures = 0
const check = (cond, msg) => { console.log((cond ? '  ✅ ' : '  ❌ ') + msg); if (!cond) failures++ }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// Poll instead of guessing a sleep. Anything that re-renders here is a debounce plus a fetch, so a
// fixed wait either races the round trip or pads every run — a 1200ms sleep read the pre-search list
// and reported a failure against working code.
async function waitFor(expr, ms = 6000) {
  for (let i = 0; i < ms / 100; i++) { if (await evalJs(expr)) return true; await sleep(100) }
  return false
}

mkdirSync(SHOTS, { recursive: true })
rmSync(PROFILE, { recursive: true, force: true })

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  '--window-size=402,874', 'about:blank',
], { stdio: 'ignore' })
process.on('exit', () => {
  try { chrome.kill() } catch { /* gone */ }
  try { rmSync(PROFILE, { recursive: true, force: true }) } catch { /* held */ }
})

async function targetWs() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
      const pages = (await r.json()).filter((t) => t.type === 'page')
      if (pages.length) return pages[0].webSocketDebuggerUrl
    } catch { /* not up */ }
    await sleep(250)
  }
  throw new Error('Chrome never exposed a page target')
}

const ws = new WebSocket(await targetWs())
await new Promise((r) => ws.once('open', r))
let cdpId = 0
const pending = new Map()
const jsErrors = []
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString())
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id) }
  if (m.method === 'Runtime.exceptionThrown') {
    jsErrors.push(m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text)
  }
})
const send = (method, params = {}) => new Promise((r) => {
  const id = ++cdpId
  pending.set(id, r)
  ws.send(JSON.stringify({ id, method, params }))
})
// Surface exceptions instead of swallowing them. Returning only `.result.value` hides a thrown
// evaluate as `undefined`, and a falsy `undefined` then reads as an honest test failure. That cost a
// long debugging round: a `const i = …` declared by one evaluate stayed in the global scope, so a
// LATER `const i = …` was a redeclaration SyntaxError, the whole snippet never ran, and the search
// looked broken while it worked fine. Two lessons, both encoded here: never leak a top-level `const`
// between evaluates (wrap snippets in an IIFE), and never let an evaluate fail quietly.
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r?.exceptionDetails) {
    const msg = r.exceptionDetails.exception?.description || r.exceptionDetails.text
    console.log(`  ⚠️  evaluate threw: ${String(msg).split('\n')[0]}`)
    failures++
  }
  return r?.result?.value
}

await send('Runtime.enable')
await send('Page.enable')
await send('Page.navigate', { url: PAGE })
await sleep(3500)

// Headless Chrome hands back a STALE frame if nothing has driven the compositor since the last
// capture — the first run of this script screenshotted the clubs screen three times while the DOM
// was provably on #rank, and two animation frames did not fix it. Nudging the device metrics forces
// a genuine relayout + repaint, which is what makes the PNG match the DOM the assertions just read.
const VW = 402, VH = 874
async function shot(name) {
  await send('Emulation.setDeviceMetricsOverride', { width: VW, height: VH - 1, deviceScaleFactor: 2, mobile: true })
  await evalJs(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r('ok'))))`)
  await send('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: 2, mobile: true })
  await evalJs(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r('ok'))))`)
  const { data } = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
  writeFileSync(`${SHOTS}${name}.png`, Buffer.from(data, 'base64'))
  console.log(`     → _clubs-shots/${name}.png`)
}

// Force one sub-screen visible the way the hub does (toggling .hidden), and hide the rest.
const openScreen = (id) => evalJs(`
  document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
  const n = document.getElementById(${JSON.stringify(id)});
  n.classList.remove('hidden');
  'ok'`)

console.log('\nCLUBS — my club (the seeded caller starts in one)')
await openScreen('clubs')
await sleep(1200)
check(await evalJs(`!!document.querySelector('#clubs .club-card')`), 'club card renders for a member')
check(await evalJs(`/\\d+\\/30/.test(document.querySelector('#clubs .club-count').textContent)`), 'member count shows the 30 cap')
check(await evalJs(`document.querySelectorAll('#clubs .soon-pill').length === 0`), 'no «בקרוב» stubs left on the clubs screen')
check(await evalJs(`document.querySelectorAll('#clubs .myscope').length === 4`), 'city / school / class / club strip renders 4 cells')
check(await evalJs(`document.querySelectorAll('#clubs .myscope.locked').length === 3`), 'city, school and class are marked locked (not leaveable)')
await shot('02-clubs-my-club')

console.log('\nCLUBS — add a friend straight from the member list')
check(await evalJs(`document.querySelectorAll('#clubs .member .role').length > 0`), 'members show their rank (נשיא / סגן / בכיר / חבר)')
check(await evalJs(`!!document.querySelector('#clubs .fr-add')`), 'an add-friend button sits on members you are not friends with')
await evalJs(`document.querySelector('#clubs .fr-add').click(); 'ok'`)
await sleep(1100)
check(await evalJs(`[...document.querySelectorAll('#clubs .fr-state')].some(n => n.textContent.includes('נשלחה'))`),
  'tapping it sends the request and the row switches to «נשלחה»')
await shot('08-clubs-add-friend')

console.log('\nPLAYER CARD — tap a name anywhere')
await evalJs(`document.querySelector('#clubs .member-name').click(); 'ok'`)
await sleep(1200)
check(await evalJs(`!document.getElementById('player-card')?.classList.contains('hidden')`), 'tapping a member name opens the player card')
check(await evalJs(`document.querySelectorAll('#player-card .pc-rank').length === 2`), 'it shows both national placements (גביעים + XP)')
check(await evalJs(`document.querySelectorAll('#player-card .myscope').length === 4`), 'it shows city / school / class / club')
check(await evalJs(`document.querySelectorAll('#player-card .myscope.hidden-scope').length === 2`),
  'PRIVACY: a non-friend’s school and class read «רק לחברים», not the real values')
await shot('09-player-card')
await evalJs(`document.getElementById('player-card').classList.add('hidden'); 'ok'`)

console.log('\nCLUBS — leave, and the landing takes over')
await evalJs(`[...document.querySelectorAll('#clubs .club-ghost')].find(b => b.textContent.includes('עזבו'))?.click(); 'ok'`)
await sleep(1000)
check(await evalJs(`!!document.querySelector('#clubs .club-hero')`), 'club landing renders once you have no club')
check(await evalJs(`!document.querySelector('#clubs .club-card')`), 'the club card is gone')
check(await evalJs(`document.querySelectorAll('#clubs .myscope.locked').length === 3`),
  'leaving a CLUB does not leave the city/school/class — those are still there and still locked')
await shot('01-clubs-landing')

console.log('\nCLUBS — create')
await evalJs(`[...document.querySelectorAll('#clubs .club-cta')].find(b => b.textContent.includes('צור'))?.click(); 'ok'`)
await sleep(600)
check(await evalJs(`!!document.querySelector('#clubs .club-input')`), 'create form renders')
await evalJs(`(() => { const i = document.querySelector('#clubs .club-input'); i.value = 'אלופי סולטיז'; return 'ok' })()`)
await shot('07-clubs-create')
await evalJs(`document.querySelector('#clubs .club-go').click(); 'ok'`)
await sleep(1100)
check(await evalJs(`document.querySelector('#clubs .club-card .nm b')?.textContent === 'אלופי סולטיז'`),
  'created club is named exactly what the user typed')
check(await evalJs(`document.querySelector('#clubs .club-card .nm small')?.textContent.includes('נשיא')`),
  'the creator becomes president')

console.log('\nCLUBS — find, Brawl-Stars shaped')
await evalJs(`[...document.querySelectorAll('#clubs .club-cta')].find(b => b.textContent.includes('מועדונים אחרים') || b.textContent.includes('חפש'))?.click(); 'ok'`)
await sleep(1100)
check(await evalJs(`document.querySelectorAll('#clubs .club-find-row').length > 0`), 'find-clubs list renders rows')
check(await evalJs(`[...document.querySelectorAll('#clubs .club-find-row small')].some(n => /פתוח|באישור|סגור/.test(n.textContent))`),
  'every listing shows its type (פתוח / באישור / סגור)')
// Assert the NUMBER, not the emoji: icon-system.js walks the DOM and swaps every emoji for a pixel
// sprite <img>, so textContent legitimately loses the 🏆. Checking for the character reports a
// failure against working UI — it cost a debugging round the first time.
check(await evalJs(`[...document.querySelectorAll('#clubs .club-find-row small')].some(n => /מ־[\\d,]+/.test(n.textContent))`),
  'listings show the minimum-trophy bar')
check(await evalJs(`document.querySelectorAll('#clubs .club-find-row small .saltiz-icon').length > 0`),
  'the trophy emoji was swapped for a pixel sprite by icon-system.js (a <span class="saltiz-icon">, not an <img>)')
check(await evalJs(`[...document.querySelectorAll('#clubs .club-join')].some(b => b.disabled && /סגור|גביעים|מלא/.test(b.textContent))`),
  'a club you cannot enter shows why and its button is disabled')
check(await evalJs(`[...document.querySelectorAll('#clubs .club-join')].some(b => b.textContent === 'בקש')`),
  'an invite-only club offers «בקש», not «הצטרף»')
check(await evalJs(`!!document.querySelector('#clubs input[placeholder="חיפוש לפי שם"]')`), 'name search box present')
check(await evalJs(`[...document.querySelectorAll('#clubs .club-ghost')].some(b => b.textContent.includes('רענן'))`), 'refresh button present')
check(await evalJs(`!document.body.innerHTML.includes('אותה כיתה') && !document.body.innerHTML.includes('same class')`),
  'PRIVACY: no row explains WHY it ranked high (no class/school labelling)')
await shot('03-clubs-find')

console.log('\nCLUBS — search by name filters the list')
const before = await evalJs(`document.querySelectorAll('#clubs .club-find-row').length`)
await evalJs(`(() => {
  const box = document.querySelector('#clubs input[placeholder="חיפוש לפי שם"]');
  box.value = 'כרישים';
  box.dispatchEvent(new Event('input'));
  return 'ok';
})()`)
await waitFor(`document.querySelectorAll('#clubs .club-find-row').length < ${before}`)
const after = await evalJs(`document.querySelectorAll('#clubs .club-find-row').length`)
const onlyMatch = await evalJs(`[...document.querySelectorAll('#clubs .club-find-row .nm b')].every(n => n.textContent.includes('כרישים'))`)
check(after < before && after > 0, `search narrows the list (${before} → ${after})`)
check(onlyMatch, 'every remaining row matches the term')
await shot('10-clubs-search')

console.log('\nRANK — scoped boards')
// Reload before switching sections. Chrome kept handing back the last CLUBS frame for every capture
// after this point even though the DOM was provably on #rank (verified via elementFromPoint and
// getComputedStyle) and neither rAF nor a device-metrics nudge dislodged it. A fresh navigation is
// the one thing that reliably gives the compositor something new to draw.
await send('Page.navigate', { url: PAGE })
await sleep(3000)
await openScreen('rank')
await sleep(1600)
check(await evalJs(`document.querySelectorAll('#scope-board .metric-pill').length === 5`), '5 pressable metrics (xp · גביעים · שערים · נצחונות · קלפים)')
check(await evalJs(`document.querySelectorAll('#scope-board .scope-tab').length === 4`), '4 scope tabs (עיר · בית ספר · כיתה · מועדון)')
check(await evalJs(`document.querySelectorAll('#scope-board .scope-row').length > 0`), 'city board renders ranked rows')
check(await evalJs(`!!document.querySelector('#scope-board .scope-row.mine')`), "the caller's own city is highlighted")

// The whole point of the design: a tiny city outranks תל אביב on placement scoring.
const top = await evalJs(`(() => {
  const r = document.querySelector('#scope-board .scope-row');
  return { name: r.querySelector('.nm b').textContent, members: r.querySelector('.nm small').textContent, score: r.querySelector('.sc').textContent };
})()`)
const tlv = await evalJs(`(() => {
  const r = [...document.querySelectorAll('#scope-board .scope-row')].find(x => x.querySelector('.nm b').textContent.includes('תל אביב'));
  return r ? { pos: r.querySelector('.pos').textContent, members: r.querySelector('.nm small').textContent } : null;
})()`)
console.log(`     #1 = ${top.name} (${top.members}) · תל אביב at #${tlv?.pos} (${tlv?.members})`)
check(Number(tlv?.pos) > 1, 'a small city outranks תל אביב — headcount does not win')
await shot('04-rank-city-xp')

console.log('\nRANK — press a different metric, then a different scope')
await evalJs(`document.querySelectorAll('#scope-board .metric-pill')[2].click(); 'ok'`)
await sleep(800)
check(await evalJs(`document.querySelectorAll('#scope-board .metric-pill')[2].classList.contains('on')`), 'metric switch is sticky')
check(await evalJs(`document.querySelector('#scope-board .scope-note').textContent.includes('שערים')`), 'the note names the selected metric')
await shot('05-rank-goals')

await evalJs(`document.querySelectorAll('#scope-board .scope-tab')[3].click(); 'ok'`)
await sleep(800)
check(await evalJs(`document.querySelectorAll('#scope-board .scope-row').length > 0`), 'club-vs-club board renders')
await shot('06-rank-clubs')

check(jsErrors.length === 0, `no uncaught JS errors${jsErrors.length ? ' — ' + jsErrors[0] : ''}`)
console.log(failures ? `\n${failures} FAILED` : '\nall checks passed')
process.exit(failures ? 1 : 0)
