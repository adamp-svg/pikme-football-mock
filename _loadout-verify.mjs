// POWER SLOTS AUTO-FILL — real-browser verification (Chrome via CDP, no puppeteer).
//
// The question: does a player who never opened the card screen actually PLAY with buffs?
// Asserting on the lobby DOM is not enough — the buff is applied server-side from whatever
// `loadout` the socket was told. So this harness records the WIRE (a patched window.WebSocket
// installed before client.js runs) and reads back the server's own record of my loadout from
// the `roster` frame it broadcasts inside a match.
//
// Scenarios, each on a clean profile-storage state:
//   A  fresh player, album present at load        → join must already carry 3 cards
//   B  album arrives AFTER the socket joined       → the regression: myLoadout is null, so
//                                                    reconcileOnCardChange() used to skip the
//                                                    resync and the server kept 3 empty slots
//   C  SALTIZ_LOADOUT = [null,null,null] injected  → must backfill (a real state: the tour, and
//                                                    any device that saved three holes)
//   D  app pushes prefs mid-session with a hole    → the wire must carry the BACKFILLED slots
//   E  deliberate removal                          → holds for the session, refilled next entry
//   F  a match entered from a path with no explicit syncLoadout (training ground) still plays
//      with the effective slots
//
// Needs the server:  PORT=3016 node server.js
// Run:               PORT=3016 node _loadout-verify.mjs
import { WebSocket } from 'ws'
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'

const PORT = process.env.PORT || 3016
const PAGE = process.env.URL || `http://localhost:${PORT}/`
const CDP_PORT = Number(process.env.CDP_PORT || 9451)
const PROFILE = `/tmp/lab-loadout-${process.pid}`
const SHOTS = new URL('./_loadout-shots/', import.meta.url).pathname
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

let failures = 0
const check = (cond, msg) => { console.log((cond ? '  ✅ ' : '  ❌ ') + msg); if (!cond) failures++ }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
// SURFACE exceptions instead of swallowing them, and wrap every snippet in an IIFE: a top-level
// `const x` in one Runtime.evaluate persists on the global for the whole page lifetime, so the next
// snippet that declares the same name dies with a SyntaxError a naive harness reports as `undefined`.
async function evalJs(expr) {
  const r = await send('Runtime.evaluate', { expression: `(() => { ${expr} })()`, awaitPromise: true, returnByValue: true })
  if (r?.exceptionDetails) {
    const d = r.exceptionDetails
    throw new Error('page threw: ' + (d.exception?.description || d.text) + '\n  in: ' + expr.slice(0, 200))
  }
  return r?.result?.value
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  if (r?.data) writeFileSync(SHOTS + name + '.png', Buffer.from(r.data, 'base64'))
}
async function waitFor(expr, ms = 8000) {
  for (let i = 0; i < ms / 100; i++) { if (await evalJs(expr)) return true; await sleep(100) }
  return false
}

await send('Page.enable')
await send('Runtime.enable')
await send('Network.enable')

// The album the app would inject. Deliberately mixed so "best three" is a real ranking decision:
// rankForLoadout is rarity → copies → worth, so the answer is legendary/5 (2 copies), legendary/12,
// legendary/20 — NOT the 900k-worth common that rankCards would put first.
const ALBUM = [
  { r: 'common', n: 3, c: 9, w: 900000 }, { r: 'rare', n: 22, c: 1, w: 800000 },
  { r: 'epic', n: 7, c: 3, w: 210000 }, { r: 'legendary', n: 12, c: 1, w: 120000 },
  { r: 'legendary', n: 5, c: 2, w: 90000 }, { r: 'legendary', n: 20, c: 1, w: 300000 },
]
const BEST3 = [{ r: 'legendary', n: 5 }, { r: 'legendary', n: 20 }, { r: 'legendary', n: 12 }]
const shape = (l) => (Array.isArray(l) ? l.map((s) => (s && s.r ? s.r[0] + s.n : '·')).join(' ') : String(l))
const filled = (l) => (Array.isArray(l) ? l.filter((s) => s && s.r).length : 0)

// Installed BEFORE client.js: records every JSON frame in and out of the game socket. Nothing in
// the client is aware of it — the recorded `loadout` is literally what the server was told.
const RECORDER = `
  window.__wsOut = []; window.__wsIn = [];
  (() => {
    const Orig = window.WebSocket;
    function Patched(url, protos) {
      const s = protos === undefined ? new Orig(url) : new Orig(url, protos);
      const send = s.send.bind(s);
      s.send = (d) => { if (typeof d === 'string') { try { window.__wsOut.push(JSON.parse(d)) } catch {} } return send(d) };
      s.addEventListener('message', (e) => { if (typeof e.data === 'string') { try { window.__wsIn.push(JSON.parse(e.data)) } catch {} } });
      return s;
    }
    Patched.prototype = Orig.prototype;
    for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) Patched[k] = Orig[k];
    window.WebSocket = Patched;
  })();
`

let initScriptId = null
async function load({ cards, loadout, storage } = {}) {
  if (initScriptId) { await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: initScriptId }); initScriptId = null }
  // A clean slate per scenario: without this, the previous scenario's `pikme-loadout` decides the next.
  await send('Page.navigate', { url: `http://localhost:${PORT}/favicon.ico` })
  await sleep(200)
  await evalJs('try { localStorage.clear() } catch {} return 1')
  const pre = []
  if (cards !== undefined) pre.push(`window.SALTIZ_CARDS = ${JSON.stringify(cards)};`)
  if (loadout !== undefined) pre.push(`window.SALTIZ_LOADOUT = ${JSON.stringify(loadout)};`)
  // MEASURED, not assumed. On a genuinely fresh profile two onboarding flows fire before the hub is
  // reachable, and both invalidate these scenarios:
  //   • the LEVEL-0 tutorial launches a match, so the hub is hidden and its 700ms album poll (the
  //     thing that notices a late album) never runs at all;
  //   • the hub TOUR raises client.js's `tuHub` sandbox flag and calls emptySlots(), so the lobby
  //     legitimately shows three empty slots and effectiveLoadout() takes its OLD, non-backfilling
  //     branch — every DOM assertion here would read that as the bug.
  // Mark both done so these scenarios measure the shipped hub.
  for (const k of ['fbTutorialSkipped', 'fbHubTourDone', 'fbTuHubSkipped']) pre.push(`try { localStorage.setItem('${k}', '1') } catch {}`)
  for (const [k, v] of Object.entries(storage || {})) pre.push(`try { localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)}) } catch {}`)
  const r = await send('Page.addScriptToEvaluateOnNewDocument', { source: RECORDER + '\n' + pre.join('\n') })
  initScriptId = r.identifier
  jsErrors.length = 0
  await send('Page.navigate', { url: PAGE })
  await waitFor(`return !!document.getElementById('power-slots')`)
  // client.js calls connect() at module scope, so the socket opens on its own.
  const joined = await waitFor(`return (window.__wsOut || []).some((m) => m.type === 'join')`)
  if (!joined) throw new Error('socket never sent join')
  await sleep(400)
}
const outFrames = (type) => evalJs(`return (window.__wsOut || []).filter((m) => m.type === ${JSON.stringify(type)})`)
const lastOut = async (type) => { const f = await outFrames(type); return f[f.length - 1] || null }
const slotsInDom = () => evalJs(`
  return [...document.querySelectorAll('#power-slots .pslot')].map((el) => (el.querySelector('canvas, img') ? 'card' : 'empty'))
`)

console.log(`\n=== POWER-SLOT AUTO-FILL (${PAGE}) ===`)

// ---------------------------------------------------------------------------
console.log('\nA. FRESH PLAYER — never opened the card screen, album present at load')
await load({ cards: ALBUM })
{
  const join = await lastOut('join')
  console.log('     join.loadout =', shape(join.loadout))
  check(filled(join.loadout) === 3, 'the JOIN frame already carries three cards (server buffs from this)')
  check(JSON.stringify(join.loadout) === JSON.stringify(BEST3), 'and they are rankForLoadout\'s best three (rarity → copies)')
  const dom = await slotsInDom()
  check(dom.length === 3 && dom.every((s) => s === 'card'), 'all three lobby slots render a card: ' + JSON.stringify(dom))
  await shot('A-fresh')
}

// ---------------------------------------------------------------------------
console.log('\nB. ALBUM ARRIVES AFTER THE SOCKET JOINED (app fetches cards late)')
await load({ cards: [] })
{
  const join = await lastOut('join')
  console.log('     join.loadout =', shape(join.loadout), '(correct — the album really is empty here)')
  check(filled(join.loadout) === 0, 'joins with empty slots, as it must — there are no cards yet')
  await evalJs(`window.SALTIZ_CARDS = ${JSON.stringify(ALBUM)}; return 1`)
  const sawCards = await waitFor(`return (window.__wsOut || []).some((m) => m.type === 'setCards' && (m.cards || []).length)`, 6000)
  check(sawCards, 'the client noticed the album and pushed setCards')
  await sleep(600)
  const sl = await lastOut('setLoadout')
  console.log('     setLoadout after the album landed =', sl ? shape(sl.loadout) : '(never sent)')
  check(!!sl && filled(sl.loadout) === 3, 'THE CRUX: the client re-sent a FULL loadout, so the server can buff us')
  const dom = await slotsInDom()
  check(dom.every((s) => s === 'card'), 'lobby slots caught up too: ' + JSON.stringify(dom))
  await shot('B-late-album')
}

// ---------------------------------------------------------------------------
console.log('\nC. SALTIZ_LOADOUT = [null,null,null] — three saved holes from another device')
await load({ cards: ALBUM, loadout: [null, null, null] })
{
  const join = await lastOut('join')
  console.log('     join.loadout =', shape(join.loadout))
  check(filled(join.loadout) === 3, 'three explicit holes still enter the match full')
  await shot('C-three-holes')
}

// ---------------------------------------------------------------------------
console.log('\nD. APP PUSHES PREFS MID-SESSION with one card and two holes')
await load({ cards: ALBUM })
{
  await evalJs(`window.__pikmeApplyPrefs({ loadout: [{ r: 'epic', n: 7 }, null, null] }); return 1`)
  await sleep(300)
  const sl = await lastOut('setLoadout')
  console.log('     setLoadout =', sl ? shape(sl.loadout) : '(never sent)')
  check(!!sl && filled(sl.loadout) === 3, 'the wire carries the BACKFILLED slots, not the two holes')
  check(!!sl && sl.loadout[0] && sl.loadout[0].r === 'epic' && +sl.loadout[0].n === 7, "the app's deliberate slot-0 pick is untouched")
  const rest = (sl?.loadout || []).slice(1).map((s) => s && s.r)
  check(rest.every((r) => r === 'legendary'), 'and the two holes took the best UNUSED cards: ' + JSON.stringify(rest))
  await shot('D-prefs-push')
}

// ---------------------------------------------------------------------------
console.log('\nE. DELIBERATE REMOVAL — holds for the session, refilled on the next entry')
await load({ cards: ALBUM })
{
  const before = await lastOut('setLoadout')
  const hasProbe = await evalJs(`return !!(window.__loadoutProbe && window.__loadoutProbe.remove)`)
  check(hasProbe, 'the __loadoutProbe test seam exists (client.js)')
  if (!hasProbe) { console.log('     (skipping E — no seam)'); }
  else await evalJs(`window.__loadoutProbe.remove(1); return 1`)
  await sleep(300)
  const sl = await lastOut('setLoadout')
  console.log('     after removing slot 1 =', sl ? shape(sl.loadout) : '(never sent)')
  check(!!sl && sl !== before && !sl.loadout[1], 'removing a card actually empties the slot (no instant re-equip)')
  check(!!sl && filled(sl.loadout) === 2, 'the other two slots are untouched')
  // The other half of the ruling: auto-fill must never OVERRIDE a choice. Entering a match is the
  // moment the choke point in sendMsg fires, so this is where an over-eager backfill would show up.
  await evalJs(`document.getElementById('training-btn')?.click(); return 1`)
  await sleep(250)
  await evalJs(`document.getElementById('tc-ground')?.click(); return 1`)
  await waitFor(`return (window.__wsIn || []).some((m) => m.type === 'matchStart')`, 8000)
  const atEntry = await evalJs(`
    const out = window.__wsOut || [];
    const at = out.findIndex((m) => m.type === 'training');
    for (let i = at - 1; i >= 0; i--) if (out[i].type === 'join' || out[i].type === 'setLoadout') return out[i].loadout;
    return null;
  `)
  console.log('     loadout at match entry =', shape(atEntry))
  check(Array.isArray(atEntry) && !atEntry[1] && filled(atEntry) === 2, 'entering a match does NOT refill the slot emptied on purpose')
  const persisted = await evalJs(`return localStorage.getItem('pikme-loadout')`)
  console.log('     persisted =', persisted)
  // Same tab, next entry: reload with the persisted value in place and no injected loadout.
  await load({ cards: ALBUM, storage: { 'pikme-loadout': persisted } })
  const join = await lastOut('join')
  console.log('     next entry join.loadout =', shape(join.loadout))
  check(filled(join.loadout) === 3, 'the next entry starts full again (the ruling: never enter a match empty)')
  await shot('E-removal')
}

// ---------------------------------------------------------------------------
console.log('\nE2. A DELIBERATE PICK IS NEVER UPGRADED AWAY')
await load({ cards: ALBUM })
{
  // Equip the album's WORST card in slot 0 on purpose. The backfill would love to put a legendary
  // there; the ruling says it must not.
  await evalJs(`window.__loadoutProbe.equip(0, { r: 'common', n: 3 }); return 1`)
  await sleep(250)
  await evalJs(`document.getElementById('training-btn')?.click(); return 1`)
  await sleep(250)
  await evalJs(`document.getElementById('tc-ground')?.click(); return 1`)
  await waitFor(`return (window.__wsIn || []).some((m) => m.type === 'matchStart')`, 8000)
  const atEntry = await evalJs(`
    const out = window.__wsOut || [];
    const at = out.findIndex((m) => m.type === 'training');
    for (let i = at - 1; i >= 0; i--) if (out[i].type === 'join' || out[i].type === 'setLoadout') return out[i].loadout;
    return null;
  `)
  console.log('     loadout at match entry =', shape(atEntry))
  check(!!atEntry && atEntry[0] && atEntry[0].r === 'common' && +atEntry[0].n === 3, 'the deliberately-equipped common is still in slot 0')
  check(filled(atEntry) === 3, 'and the other two slots are full')
  await shot('E2-deliberate-pick')
}

// ---------------------------------------------------------------------------
console.log('\nF. THE PATH WITH NO EXPLICIT syncLoadout (training ground)')
// `member.loadout` on the server is written by exactly two messages — `join` and `setLoadout` — so
// whatever the LAST of those carried before the match message left the socket IS what
// buffsFromLoadout() ran on. Training's own frames carry no loadout to read back, so assert the wire.
await load({ cards: [] })
{
  await evalJs(`window.SALTIZ_CARDS = ${JSON.stringify(ALBUM)}; return 1`)
  await waitFor(`return (window.__wsOut || []).some((m) => m.type === 'setCards' && (m.cards || []).length)`, 6000)
  await sleep(600)
  await evalJs(`document.getElementById('training-btn')?.click(); return 1`)
  await sleep(250)
  await evalJs(`document.getElementById('tc-ground')?.click(); return 1`)
  const started = await waitFor(`return (window.__wsIn || []).some((m) => m.type === 'matchStart')`, 8000)
  check(started, 'the training match started')
  const known = await evalJs(`
    const out = window.__wsOut || [];
    const at = out.findIndex((m) => m.type === 'training');
    if (at < 0) return null;
    for (let i = at - 1; i >= 0; i--) if (out[i].type === 'join' || out[i].type === 'setLoadout') return { type: out[i].type, loadout: out[i].loadout };
    return null;
  `)
  console.log('     last loadout the server was told before `training` =', known ? shape(known.loadout) + ' (' + known.type + ')' : '(nothing)')
  check(!!known && filled(known.loadout) === 3, 'the server already held three cards on a path that never calls syncLoadout')
  await shot('F-training')
}

// ---------------------------------------------------------------------------
console.log('\nG. END TO END — the SERVER\'s own roster for a real bot match')
await load({ cards: [] })
{
  await evalJs(`window.SALTIZ_CARDS = ${JSON.stringify(ALBUM)}; return 1`)
  await waitFor(`return (window.__wsOut || []).some((m) => m.type === 'setCards' && (m.cards || []).length)`, 6000)
  await sleep(600)
  await evalJs(`document.getElementById('training-btn')?.click(); return 1`)
  await sleep(250)
  await evalJs(`document.getElementById('tc-bots')?.click(); return 1`)
  await sleep(400)
  const picked = await evalJs(`
    const c = document.querySelector('#game-select [data-mode-id]');
    if (!c) return null;
    c.click();
    return c.dataset.modeId;
  `)
  check(!!picked, 'picked a mode card from the vs-bots picker: ' + picked)
  const started = await waitFor(`return (window.__wsIn || []).some((m) => m.type === 'matchStart' && Array.isArray(m.players))`, 10000)
  check(started, 'the bot match started')
  // matchStart.players[me].loadout is sanitizeLoadout(member.loadout, member.cards) — the server's
  // OWN record, the same member.loadout buffsFromLoadout() turned into this player's multipliers.
  const mine = await evalJs(`
    const ms = (window.__wsIn || []).find((m) => m.type === 'matchStart' && Array.isArray(m.players));
    if (!ms) return null;
    const me = ms.players.find((p) => p && p.id === ms.playerId);
    return me ? { loadout: me.loadout } : null;
  `)
  console.log('     server roster, my loadout =', mine ? shape(mine.loadout) : '(not in roster)')
  check(!!mine && filled(mine.loadout) === 3, 'THE SERVER buffs this player from three cards')
  await shot('G-botmatch')
}

console.log('\n--- page errors ---')
if (jsErrors.length) { for (const e of jsErrors.slice(0, 6)) console.log('  ⚠️ ' + String(e).split('\n')[0]) }
check(jsErrors.length === 0, 'no uncaught page exceptions')

console.log(failures ? `\n${failures} CHECK(S) FAILED\n` : '\nALL PASS\n')
try { chrome.kill() } catch { /* gone */ }
process.exit(failures ? 1 : 0)
