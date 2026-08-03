/* AUDIT / ROOT CAUSE: THE CLUBS+RANK BLOCK IS STILL LOST ON THE PROFILE PAGE.
 * The 2026-08-03 "re-inject on every repaint" fix did not close the race — it moved it.
 *
 * TWO MEASURED FACTS.
 *
 * FACT 1 — 100% REPRODUCIBLE, 59/59 LOADS ACROSS EVERY CONFIGURATION TRIED.
 *   On every single load, at every viewport, the block is appended into a `.pf-side` that
 *   renderProfile HAS ALREADY REPLACED — `parent.isConnected === false`. That append is DEAD: it
 *   paints nothing, it is garbage-collected. This is the defect, it does not depend on machine speed,
 *   and it is LIVE IN PROD. It is the assertion this harness keeps, because it cannot be argued away
 *   as flakiness.
 *
 * FACT 2 — SOMETIMES THE DEAD APPEND IS THE ONLY ONE, and then the block never reaches the document
 *   at all. Measured 8 of 59 instrumented loads (~14%). Every one of those had `appends === 1`; every
 *   surviving load had `appends === 2` (one dead, one live). This is precisely Adam's "sometimes shows
 *   the clubs and membership and sometimes doesn't".
 *
 * ⚠️ WHAT THE TRIGGER FOR FACT 2 IS *NOT* — MEASURED AND REFUTED. DO NOT RE-DERIVE THESE:
 *   • HTTP cache state — COLD (Network.clearBrowserCache before every load) vs WARM: 0/16 vs 0/16.
 *   • a fresh browser process (the app cold-start shape) vs a warm one: 0/16 vs 0/16.
 *   • the stats-call latency shape — micro-task vs setTimeout 0/30/120/250/600ms: block PRESENT in
 *     6/6 (and that sweep was itself contaminated, see the observer-effect warning below).
 *   • devicePixelRatio (2 vs 3), touch emulation on/off, and viewport size: all reproduce both
 *     outcomes.
 *   The observed losses clustered in the FIRST loads after a harness start and at 800x360, but no
 *   single knob reproduced them on demand. Do not spend more time isolating it: FACT 1 is sufficient
 *   to justify the fix, and the fix makes FACT 2 unreachable by construction.
 *
 * THE MECHANISM (read out of the code, then measured here):
 *   clubs.js injectInto():
 *       const host = $('.pf-side')            ← the pane node is captured HERE
 *       const p = await api('/player/'+id)    ← ...then it awaits the network
 *       host.appendChild(block)               ← ...and appends to the node captured BEFORE the await
 *   profile.js renderProfile(): `root.innerHTML = ''` then builds a BRAND NEW .pf-side. openProfile()
 *   paints twice — once from cached numbers, then again after `await fetchOwnStats()`.
 *   So when the second paint lands while /player/:id is in flight, `host` is detached and the block is
 *   appended into garbage. And that attempt is never retried: injectMyClubs() holds
 *   `_myClubsBusy = true` for the whole duration of the await, so the MutationObserver callback
 *   belonging to that very repaint — the thing the fix added — hits `if (_myClubsBusy) return` and
 *   no-ops. The two guards cancel each other out.
 *
 * ⚠️ OBSERVER-EFFECT WARNING — THE REASON THIS BUG SURVIVED A "FIXED" VERDICT.
 * This race is destroyed by instrumentation. An earlier version of THIS FILE logged inside the
 * MutationObserver callback and inside the /player/ fetch stub; those extra microtasks reordered the
 * repaint and the block came out PRESENT in 6/6 cases — a false PASS that would have closed the bug.
 * The probe below is ONE synchronous `push(this.isConnected)` inside appendChild and nothing else.
 * DO NOT add awaits, querySelector calls, console.log or timeline pushes to it.
 * For the same reason `_profile-clubs-race.mjs` reports ✅ FIXED: its stats stub answers only after a
 * `setTimeout` MACROTASK, and it reuses one warm browser. Both choices hide this defect.
 *
 * NOTE ON THE FIX THAT DID LAND (32927fb): that commit compacts the pane so the block FITS without
 * scrolling (verified by _audit-profile-side-fit.mjs — 0px overflow at 360/390/430, iPad untouched).
 * It is orthogonal to this defect and does not address it: no amount of compaction can show a block
 * that is not in the document. Both fixes are needed.
 *
 * Run: node _audit-clubs-inject-lost.mjs [port] [trialsPerArm]      # default 3016, 4
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = process.argv[2] || '3016'
const TRIALS = Number(process.argv[3] || 4)
const OUT = '/private/tmp/claude-501/-Users-adamleeperelman-Documents-pikeme/24a0f464-af08-4018-9ddf-e3fad2a0324f/scratchpad/clubslost'
mkdirSync(OUT, { recursive: true })
setTimeout(() => { console.error('TIMEOUT'); process.exit(2) }, 1800000).unref?.()

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const CDP = 9481
const VIEWPORTS = [
  { name: '844x390 iPhone 14/15/16', w: 844, h: 390, dpr: 3 },
  { name: '800x360 Galaxy A15', w: 800, h: 360, dpr: 3 },
]
// Both arms are kept because the fresh-process arm was the last plausible trigger for FACT 2 and it
// came back 0/16 — recorded here so the refutation stays reproducible rather than becoming folklore.
const ARMS = [
  { id: 'A: FRESH browser process per load', fresh: true },
  { id: 'B: one warm browser process, N loads', fresh: false },
]

// Stubs every API in-page and delivers the socket `welcome` the game needs. The ONLY instrumentation
// is the one synchronous isConnected push — see the observer-effect warning above.
const STUB = `(() => {
  window.SALTIZ_CARDS = [{ r:'legendary', n:5, c:1, w:900 }];
  window.SALTIZ_XP = { xp: 4200, level: 9 };
  try { for (const k of ['fbTutorialSkipped','fbHubTourDone','fbHubTourSkipped','fbTuHubSkipped']) localStorage.setItem(k,'1'); } catch (e) {}
  window.__ap = [];
  const realAppend = Node.prototype.appendChild;
  Node.prototype.appendChild = function (kid) {
    if (kid && kid.classList && kid.classList.contains('pf-clubs')) window.__ap.push(this.isConnected);
    return realAppend.call(this, kid);
  };
  const RealWS = window.WebSocket;
  window.WebSocket = function (...a) { const s = new RealWS(...a);
    s.addEventListener('open', () => setTimeout(() => { try { s.onmessage && s.onmessage({ data: JSON.stringify({ type:'welcome', id:'m-me', userId:'u-me' }) }); } catch(e){} }, 400));
    return s; };
  window.WebSocket.prototype = RealWS.prototype;
  const ME = { me:{ id:'u-me', nickName:'אדם' }, club:{ id:'c1', name:'האריות', emblem:'🦁', tag:'ABC', type:'open',
      minTrophies:0, myRole:'member', canAdmit:false, count:2, maxMembers:30, members:[], pending:[] },
    metrics:[], scopes:{}, labels:{}, maxMembers:30, rows:[], totalRanked:0 };
  const PLAYER = { id:'u-me', nickName:'אדם', trophies:1200,
    ranks:{ trophies:{place:7,of:120}, ranked:{place:3,of:64} },
    club:{ id:'c1', name:'האריות', emblem:'🦁', count:2, role:'member' },
    scopes:{ city:{id:'1',label:'תל אביב'}, school:{id:'2',label:'עמל להבים'}, class:{id:'3',label:'ז׳3'} }, friend:true };
  const json = (b) => new Response(JSON.stringify(b), { status:200, headers:{ 'Content-Type':'application/json' } });
  const rf = window.fetch;
  window.fetch = async (u, o) => {
    const url = String(u);
    if (url.includes('/player/')) return json(PLAYER);
    if (url.includes('/clubs') || url.includes('/dev/clubs')) return json(ME);
    if (url.includes('/dev/progress') || url.includes('/handle-friends/rank')) return json({ xp: 4200, level: 9, rankPoints: 340, wins: 13 });
    if (url.includes('/handle-friends')) return json([]);
    return rf(u, o);
  };
})()`

let udSeq = 0
async function openBrowser() {
  const dir = `${OUT}/ud${++udSeq}`
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
  const chrome = spawn(CHROME, [`--remote-debugging-port=${CDP}`, '--headless=new', '--no-first-run',
    `--user-data-dir=${dir}`, 'about:blank'], { stdio: 'ignore' })
  let t
  for (let i = 0; i < 60 && !t; i++) { await sleep(250); try { t = (await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()).find(x => x.type === 'page') } catch {} }
  if (!t) { chrome.kill(); throw new Error('chrome never came up') }
  const { WebSocket } = await import('ws')
  const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise(r => ws.on('open', r))
  let id = 0; const pend = new Map()
  const send = (m, p = {}) => new Promise(r => { pend.set(++id, r); ws.send(JSON.stringify({ id, method: m, params: p })) })
  ws.on('message', d => { const m = JSON.parse(d.toString()); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id) } })
  await send('Page.enable'); await send('Runtime.enable')
  await send('Page.addScriptToEvaluateOnNewDocument', { source: STUB })
  return { send, close: () => { try { ws.close() } catch {} chrome.kill() },
    evl: async (e) => (await send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: e }))?.result?.value }
}

async function trial(b, V, n) {
  await b.send('Emulation.setDeviceMetricsOverride', { width: V.w, height: V.h, deviceScaleFactor: V.dpr, mobile: true })
  await b.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?ftoken=harness&cb=${V.w}-${n}-${Date.now()}` })
  await sleep(6500)
  await b.evl(`document.getElementById('home-face')?.click()`)
  await sleep(3000)
  return await b.evl(`(() => ({ clubsInDoc: !!document.querySelector('.pf-side .pf-clubs'),
    flags: (window.__ap || []).slice() }))()`)
}

async function main() {
  const rows = []
  for (const V of VIEWPORTS) {
    for (const ARM of ARMS) {
      console.log(`\n── ${V.name}  ·  ${ARM.id} ──────────────────────`)
      let missing = 0, everDetached = 0
      let shared = ARM.fresh ? null : await openBrowser()
      for (let n = 1; n <= TRIALS; n++) {
        const b = ARM.fresh ? await openBrowser() : shared
        let r
        try { r = await trial(b, V, n) } finally { if (ARM.fresh) b.close() }
        const det = (r.flags || []).filter(x => x === false).length
        if (!r.clubsInDoc) missing++
        if (det > 0) everDetached++
        console.log(`   trial ${String(n).padStart(2)}  .pf-clubs=${(r.clubsInDoc ? 'PRESENT' : '❌ MISSING').padEnd(12)}` +
          ` appends=${r.flags.length}  parent.isConnected=${JSON.stringify(r.flags)}  detachedAppends=${det}`)
      }
      if (shared) shared.close()
      rows.push({ V, ARM, missing, everDetached })
      console.log(`   → ${missing}/${TRIALS} loads LOSE the block entirely;  ${everDetached}/${TRIALS} loads append into a DETACHED pane`)
    }
  }

  console.log(`\n═══════════════════════════════════════════════════════════════════════════════`)
  console.log(`VERDICT`)
  console.log(`═══════════════════════════════════════════════════════════════════════════════`)
  console.log(`  ${'viewport'.padEnd(24)} ${'arm'.padEnd(46)} ${'MISSING'.padStart(8)} ${'detached'.padStart(9)}`)
  for (const r of rows) console.log(`  ${r.V.name.padEnd(24)} ${r.ARM.id.padEnd(46)} ${String(r.missing + '/' + TRIALS).padStart(8)} ${String(r.everDetached + '/' + TRIALS).padStart(9)}`)
  const anyMissing = rows.some(r => r.missing > 0)
  const allDetached = rows.every(r => r.everDetached === TRIALS)
  console.log(`\n  ${allDetached ? '❌' : '  '} EVERY load appends into a detached .pf-side: ${allDetached ? 'YES — 100%, this is the defect' : 'no'}`)
  console.log(`  ${anyMissing ? '❌' : '  '} block ends up missing from the document: ${anyMissing ? 'YES' : 'not in THIS sample (it is ~14% overall — see FACT 2 in the header)'}`)
  console.log(`\n  A fix has to do BOTH of these, or the race just moves again:`)
  console.log(`    1. re-resolve the host AFTER the await (or bail if the captured host went detached),`)
  console.log(`       so the block is never appended into a pane that was already replaced; and`)
  console.log(`    2. make the busy guard RETRY rather than DROP — remember that a mutation arrived`)
  console.log(`       while busy and re-run once the in-flight attempt finishes, instead of returning.`)
  console.log(`  Caching /player/:id would also take the await off the hot path entirely.`)
  console.log(`\n  The detached-append count is the assertion to keep: it is 100% reproducible, it does`)
  console.log(`  not depend on machine speed, and it cannot be argued away as flakiness.`)
  process.exit(allDetached || anyMissing ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(1) })
