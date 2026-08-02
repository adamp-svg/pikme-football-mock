/* IS IT MISSING, OR IS IT CLIPPED? — the friend profile card and my own profile side panel.
 *
 * Adam 2026-08-02, on iPhone: "in the my profile ... the right panel the hero and user stats the
 * clubs etc are clipped. i see the clubs clipped and the trophies and ranked not visible (which they
 * are in the ipad)" and "when i click a friend profile it dosnt show me his rank".
 *
 * Those are two different failures if the rank block is ABSENT, and ONE failure if it is present in
 * the DOM but sitting below a container that cannot scroll. This measures which, on both surfaces, at
 * the real in-app sizes: iPhone landscape (844x390 — the game is landscape-locked) vs iPad (1194x834).
 *
 *   node _panel-clip.mjs [port]        # default 3016
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = process.argv[2] || '3016'
const OUT = '/private/tmp/claude-501/-Users-adamleeperelman-Documents-pikeme/24a0f464-af08-4018-9ddf-e3fad2a0324f/scratchpad/panelclip'
mkdirSync(OUT, { recursive: true })
try { rmSync(OUT + '/profile', { recursive: true, force: true }) } catch {}
setTimeout(() => { console.error('TIMEOUT'); process.exit(2) }, 180000).unref?.()

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const CDP = 9438
const DEVICES = [
  { name: 'iPhone landscape', w: 844, h: 390 },
  { name: 'iPad landscape', w: 1194, h: 834 },
]

async function main() {
  const chrome = spawn(CHROME, [`--remote-debugging-port=${CDP}`, '--headless=new', '--no-first-run',
    `--user-data-dir=${OUT}/profile`, 'about:blank'], { stdio: 'ignore' })
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
  ws.on('message', d => { const m = JSON.parse(d.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id) } })
  await send('Page.enable'); await send('Runtime.enable')

  // Stub both APIs: the friends list (so a friend exists to tap) and clubs /player/:id (the source of
  // the ranks block). Authenticated-socket gate handled the same way as _friend-requests.mjs.
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      window.SALTIZ_CARDS = [{ r:'legendary', n:5, c:1, w:900 }];
      window.SALTIZ_XP = { xp: 4200, level: 9 };
      try { for (const k of ['fbTutorialSkipped','fbHubTourDone','fbHubTourSkipped','fbTuHubSkipped']) localStorage.setItem(k,'1'); } catch (e) {}
      const RealWS = window.WebSocket;
      window.WebSocket = function (...a) {
        const s = new RealWS(...a);
        s.addEventListener('open', () => setTimeout(() => {
          try { s.onmessage && s.onmessage({ data: JSON.stringify({ type:'welcome', id:'m-me', userId:'u-me' }) }); } catch (e) {}
        }, 700));
        return s;
      };
      window.WebSocket.prototype = RealWS.prototype;
      const FRIEND = { userId:'u-dan', nickName:'דן', image:null, xp:4200, level:9, tier:3, wins:12, worth:900000, owned:42 };
      const PLAYER = { id:'u-dan', nickName:'דן', image:null, trophies:1200, level:9,
        ranks:{ trophies:{ place:7, of:120 }, ranked:{ place:3, of:64 } },
        club:{ id:'c1', name:'האריות', emblem:'🦁', count:12, role:'member' },
        scopes:{ city:{id:'1',label:'תל אביב'}, school:{id:'2',label:'בית ספר'}, class:{id:'3',label:'ז׳3'} },
        friend:true, friendPending:false, careerGoals:30, wins:12, cards:42 };
      const json = (b) => new Response(JSON.stringify(b), { status:200, headers:{ 'Content-Type':'application/json' } });
      const realFetch = window.fetch;
      window.fetch = (u, o) => {
        const url = String(u);
        if (url.includes('/player/'))            return Promise.resolve(json(PLAYER));
        if (url.includes('/requests/sent'))      return Promise.resolve(json([]));
        if (url.includes('/handle-friends/requests')) return Promise.resolve(json([]));
        if (url.includes('/handle-friends'))     return Promise.resolve(json([FRIEND]));
        if (url.includes('/dev/clubs/me') || url.endsWith('/me')) return Promise.resolve(json({ club:null, metrics:[], scopes:{} }));
        if (url.includes('/dev/clubs') || url.includes('/handle-clubs')) return Promise.resolve(json({}));
        return realFetch(u, o);
      };
    })()`,
  })

  const evl = async (expr) => (await send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: expr }))?.result?.value

  for (const d of DEVICES) {
    await send('Emulation.setDeviceMetricsOverride', { width: d.w, height: d.h, deviceScaleFactor: 2, mobile: true })
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?ftoken=harness&cb=${d.w}` })
    await sleep(6500)
    // open friends → tap the friend row (that is what opens the profile card)
    await evl(`document.getElementById('friends-btn').click()`)
    await sleep(1200)
    await evl(`(document.querySelector("#friend-list .friend-row .friend-pfp") || document.querySelector("#friend-list .friend-row"))?.click()`)
    await sleep(2500)   // clubs.js injects asynchronously after fetching /player/:id

    const diag = await evl(`(() => ({ rows: document.querySelectorAll('#friend-list .friend-row').length, listText: (document.getElementById('friend-list')||{}).innerText || '', screen: [...document.querySelectorAll('.screen')].filter(s=>!s.classList.contains('hidden')).map(s=>s.id) }))()`); console.log('  diag:', JSON.stringify(diag));
    const r = await evl(`(() => {
      const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) }; };
      const modal = document.getElementById('friend-profile-modal');
      const host  = modal && (modal.querySelector('.fp-body') || modal);
      const ranks = modal && modal.querySelector('.pc-ranks');
      const clubs = modal && modal.querySelector('.fp-clubs');
      const vis = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= window.innerHeight && r.height > 0; };
      const scrolls = (el) => { if (!el) return null; const s = getComputedStyle(el);
        return { overflowY: s.overflowY, canScroll: el.scrollHeight > el.clientHeight + 1 }; };
      return {
        viewport: window.innerWidth + 'x' + window.innerHeight,
        modalOpen: !!(modal && !modal.classList.contains('hidden')),
        ranksInDOM: !!ranks, ranksBox: box(ranks), ranksFullyVisible: vis(ranks),
        clubsInDOM: !!clubs, clubsBox: box(clubs), clubsFullyVisible: vis(clubs),
        hostBox: box(host), hostScroll: scrolls(host),
        modalText: (modal && modal.innerText || '').replace(/\\s+/g,' ').slice(0, 120),
      };
    })()`)
    console.log(`\n=== ${d.name} (${d.w}x${d.h}) ===`)
    console.log('  viewport      :', r?.viewport, ' modal open:', r?.modalOpen)
    console.log('  ranks in DOM  :', r?.ranksInDOM, ' box:', JSON.stringify(r?.ranksBox), ' fully visible:', r?.ranksFullyVisible)
    console.log('  clubs in DOM  :', r?.clubsInDOM, ' box:', JSON.stringify(r?.clubsBox), ' fully visible:', r?.clubsFullyVisible)
    console.log('  host          :', JSON.stringify(r?.hostBox), JSON.stringify(r?.hostScroll))
    console.log('  verdict       :', r?.ranksInDOM
      ? (r?.ranksFullyVisible ? 'rank IS shown' : '⚠ rank is in the DOM but CLIPPED / off-screen')
      : '⚠ rank block was never injected')
  }
  ws.close(); chrome.kill()
}
main().catch(e => { console.error(e); process.exit(1) })
