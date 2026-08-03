/* WHY THE PROFILE'S RIGHT BANNER SOMETIMES SHOWS THE CLUBS/MEMBERSHIP BLOCK AND SOMETIMES DOES NOT.
 *
 * Adam 2026-08-03: "the football status right banner with the hero and rank — it sometimes shows the
 * clubs and membership and sometimes doesn't."
 *
 * THE HYPOTHESIS this measures (read out of the code, then proven here):
 *   openProfile() paints the page TWICE —
 *     1. showScreen('profile')   → removes .hidden → clubs.js's MutationObserver fires and schedules
 *                                  injectInto('.pf-side', …) at +250ms
 *     2. renderProfile(#1)       → builds .pf-side from cached numbers
 *     3. await fetchOwnStats()   → network (/dev/progress or /handle-friends/rank)
 *     4. renderProfile(#2)       → REBUILDS the DOM, destroying anything injected into it
 *   Nothing re-fires the observer afterwards (it only watches the `class` attribute of #profile).
 *   So the block survives only when render #2 happens BEFORE the 250ms injection:
 *     stats fast  → render #2, then inject  → block PRESENT
 *     stats slow  → inject, then render #2  → block WIPED
 *
 * Run: node _profile-clubs-race.mjs [port]     # default 3016
 * It runs the same page twice, changing ONLY the stats latency (0ms vs 600ms).
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = process.argv[2] || '3016'
const OUT = '/private/tmp/claude-501/-Users-adamleeperelman-Documents-pikeme/24a0f464-af08-4018-9ddf-e3fad2a0324f/scratchpad/clubsrace'
mkdirSync(OUT, { recursive: true })
try { rmSync(OUT + '/profile', { recursive: true, force: true }) } catch {}
setTimeout(() => { console.error('TIMEOUT'); process.exit(2) }, 180000).unref?.()

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const CDP = 9443
// The two cases differ ONLY in how long the profile's stats call takes.
const CASES = [
  { name: 'stats FAST (0ms)   — render #2 lands before the 250ms inject', delay: 0 },
  { name: 'stats SLOW (600ms) — render #2 lands after the 250ms inject', delay: 600 },
  // The residual hole in the re-inject fix: /player/:id is a network round trip, and if the repaint
  // lands DURING it, the block is appended to a pane that has already been discarded — while the
  // mutation that would re-trigger the injection is swallowed by the busy flag. Needs playerDelay >
  // statsDelay so render #2 fires mid-request.
  { name: 'REPAINT MID-REQUEST — /player slow (500ms), stats land at 200ms', delay: 200, playerDelay: 500 },
]

async function main() {
  const chrome = spawn(CHROME, [`--remote-debugging-port=${CDP}`, '--headless=new', '--no-first-run',
    `--user-data-dir=${OUT}/profile`, 'about:blank'], { stdio: 'ignore' })
  let t
  for (let i = 0; i < 40 && !t; i++) { await sleep(250); try { t = (await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()).find(x => x.type === 'page') } catch {} }
  if (!t) { chrome.kill(); throw new Error('chrome never came up') }
  const { WebSocket } = await import('ws')
  const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise(r => ws.on('open', r))
  let id = 0; const pend = new Map()
  const send = (m, p = {}) => new Promise(r => { pend.set(++id, r); ws.send(JSON.stringify({ id, method: m, params: p })) })
  ws.on('message', d => { const m = JSON.parse(d.toString()); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id) } })
  await send('Page.enable'); await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 2, mobile: true })

  let script = null
  const results = []
  for (const c of CASES) {
    if (script) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: script })
    const added = await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
        window.SALTIZ_CARDS = [{ r:'legendary', n:5, c:1, w:900 }];
        window.SALTIZ_XP = { xp: 4200, level: 9 };
        try { for (const k of ['fbTutorialSkipped','fbHubTourDone','fbHubTourSkipped','fbTuHubSkipped']) localStorage.setItem(k,'1'); } catch (e) {}
        const RealWS = window.WebSocket;
        window.WebSocket = function (...a) { const s = new RealWS(...a);
          s.addEventListener('open', () => setTimeout(() => { try { s.onmessage && s.onmessage({ data: JSON.stringify({ type:'welcome', id:'m-me', userId:'u-me' }) }); } catch(e){} }, 500));
          return s; };
        window.WebSocket.prototype = RealWS.prototype;
        const ME = { me:{ id:'u-me', nickName:'אדם' }, club:{ id:'c1', name:'האריות', emblem:'🦁', tag:'ABC', type:'open',
            minTrophies:0, myRole:'member', canAdmit:false, count:2, maxMembers:30, members:[], pending:[] },
          metrics:[], scopes:{}, labels:{}, maxMembers:30 };
        const PLAYER = { id:'u-me', nickName:'אדם', trophies:1200,
          ranks:{ trophies:{place:7,of:120}, ranked:{place:3,of:64} },
          club:{ id:'c1', name:'האריות', emblem:'🦁', count:2, role:'member' },
          scopes:{ city:{id:'1',label:'תל אביב'}, school:{id:'2',label:'ביה״ס'}, class:{id:'3',label:'ז׳3'} }, friend:true };
        const json = (b) => new Response(JSON.stringify(b), { status:200, headers:{ 'Content-Type':'application/json' } });
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        const rf = window.fetch;
        window.__timeline = [];
        window.fetch = async (u, o) => {
          const url = String(u);
          if (url.includes('/player/')) {
            window.__timeline.push('player:start');
            await wait(${c.playerDelay || 0});
            window.__timeline.push('player:done');
            return json(PLAYER);
          }
          if (url.includes('/clubs') || url.includes('/dev/clubs')) return json(ME);
          // THE VARIABLE UNDER TEST: how long the profile's stats call takes.
          if (url.includes('/dev/progress') || url.includes('/handle-friends/rank')) {
            window.__timeline.push('stats:start');
            await wait(${c.delay});
            window.__timeline.push('stats:done');
            return json({ xp: 4200, level: 9, rankPoints: 0, wins: 13 });
          }
          if (url.includes('/handle-friends')) return json([]);
          return rf(u, o);
        };
      })()`,
    })
    script = added?.identifier || null
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?ftoken=harness&cb=${c.delay}` })
    await sleep(7000)
    const evl = async (e) => (await send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: e }))?.result?.value
    await evl(`document.getElementById('home-face')?.click()`)
    await sleep(3000)   // well past both the 250ms inject and the 600ms stats
    const r = await evl(`(() => ({
      sideExists: !!document.querySelector('.pf-side'),
      clubsBlock: !!document.querySelector('.pf-side .pf-clubs'),
      ranksBlock: !!document.querySelector('.pf-side .pc-ranks'),
      // A subtree observer that re-injects must never append the block twice — that would be two
      // clubs strips stacked in the pane.
      clubsCount: document.querySelectorAll('.pf-side .pf-clubs').length,
      // PRESENT is not the same as VISIBLE: the block is appended at the BOTTOM of a 176px-wide,
      // full-height pane. On a landscape phone the hero + name + badge + trophies + slots already
      // fill it, so the clubs/rank strip can sit past the fold and need a deliberate scroll.
      fold: (() => { const side=document.querySelector('.pf-side'), b=document.querySelector('.pf-side .pf-clubs');
        if(!side||!b) return null;
        const sr=side.getBoundingClientRect(), br=b.getBoundingClientRect();
        return { paneVisibleH: Math.round(sr.height), paneScrollH: side.scrollHeight,
                 blockTopWithinPane: Math.round(br.top - sr.top),
                 hiddenBelowFold: Math.max(0, Math.round(br.bottom - sr.bottom)),
                 needsScroll: br.bottom > sr.bottom + 1 }; })(),
      ranksCount: document.querySelectorAll('.pf-side .pc-ranks').length,
      timeline: (window.__timeline || []).join(' → '),
    }))()`)
    results.push([c, r])
    console.log(`\n=== ${c.name} ===`)
    console.log('   timeline      :', r?.timeline)
    console.log('   .pf-side      :', r?.sideExists)
    console.log('   clubs block   :', r?.clubsBlock ? 'PRESENT' : '❌ MISSING')
    console.log('   ranks block   :', r?.ranksBlock ? 'PRESENT' : '❌ MISSING')
    console.log('   copies        : clubs=' + r?.clubsCount + ' ranks=' + r?.ranksCount + (r?.clubsCount === 1 ? '' : '  ⚠ DUPLICATED'))
    console.log('   visibility    :', JSON.stringify(r?.fold))
  }
  ws.close(); chrome.kill()

  const fast = results[0][1], slow = results[1][1]
  const every = results.every(([, r]) => r && r.clubsBlock && r.ranksBlock && r.clubsCount === 1 && r.ranksCount === 1)
  console.log('\n---------------- VERDICT ----------------')
  // AFTER THE FIX this must pass on BOTH paths: the subtree observer re-injects after every repaint,
  // so the stats latency stops deciding whether the pane is complete.
  const bothOk = every   // EVERY case, including the mid-request repaint — not just the first two
  if (bothOk) console.log('✅ FIXED — clubs + rank present, exactly once, on ALL ' + results.length + ' paths')
  else if (fast?.clubsBlock && !slow?.clubsBlock) console.log('❌ RACE STILL PRESENT — slow stats still loses the block')
  else console.log('❌ unexpected: fast=' + JSON.stringify(fast) + ' slow=' + JSON.stringify(slow))
  process.exit(bothOk ? 0 : 1)
}
main().catch(e => { console.error(e); process.exit(1) })
