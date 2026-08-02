/* The three UI changes of 2026-08-02, measured on the REAL client at the REAL in-app sizes.
 *
 *   1. MY PROFILE side panel scrolls — the clubs + גביעים/דירוג blocks were clipped on iPhone.
 *   2. A FRIEND's card shows their rank — the block used to be injected BESIDE the card, not in it.
 *   3. Unfriending asks first, with the game's own dialog (window.confirm is not shown by every
 *      WebView host, which is why the guard never reached the player).
 *
 * iPhone landscape is 844x390 (the game is landscape-locked) and iPad is 1194x834 — the pair that
 * matters, because every one of these bugs was invisible on the tablet and broken on the phone.
 *
 *   node _profile-friend-ui.mjs [port]        # default 3016
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = process.argv[2] || '3016'
const OUT = '/private/tmp/claude-501/-Users-adamleeperelman-Documents-pikeme/24a0f464-af08-4018-9ddf-e3fad2a0324f/scratchpad/profileui'
mkdirSync(OUT, { recursive: true })
try { rmSync(OUT + '/profile', { recursive: true, force: true }) } catch {}
setTimeout(() => { console.error('TIMEOUT'); process.exit(2) }, 240000).unref?.()

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const CDP = 9439
const DEVICES = [
  { name: 'iPhone landscape', w: 844, h: 390 },
  { name: 'iPad landscape', w: 1194, h: 834 },
]
const results = []
const check = (label, cond, detail) => { results.push(!!cond); console.log(`    ${cond ? '✓' : '✗'} ${label}${!cond && detail !== undefined ? '  — ' + detail : ''}`) }

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

  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      window.SALTIZ_CARDS = [{ r:'legendary', n:5, c:1, w:900 }];
      window.SALTIZ_XP = { xp: 4200, level: 9 };
      try { for (const k of ['fbTutorialSkipped','fbHubTourDone','fbHubTourSkipped','fbTuHubSkipped']) localStorage.setItem(k,'1'); } catch (e) {}
      // The friends REST needs an AUTHENTICATED socket: loadFriends() bails unless FOOTBALL_TOKEN and
      // MY_USER_ID are both set, and MY_USER_ID only arrives on a welcome the server sends to a socket
      // it verified. ?ftoken=harness is not a real JWT, so the harness delivers the welcome itself.
      const RealWS = window.WebSocket;
      window.WebSocket = function (...a) {
        const s = new RealWS(...a);
        s.addEventListener('open', () => setTimeout(() => {
          try { s.onmessage && s.onmessage({ data: JSON.stringify({ type:'welcome', id:'m-me', userId:'u-me' }) }); } catch (e) {}
        }, 600));
        return s;
      };
      window.WebSocket.prototype = RealWS.prototype;
      const FRIEND = { userId:'u-dan', nickName:'דן', image:null, xp:4200, level:9, tier:3, wins:12, worth:900000, owned:42 };
      const PLAYER = { id:'u-dan', nickName:'דן', image:null, trophies:1200, level:9,
        ranks:{ trophies:{ place:7, of:120 }, ranked:{ place:3, of:64 } },
        club:{ id:'c1', name:'האריות', emblem:'🦁', count:12, role:'member' },
        scopes:{ city:{id:'1',label:'תל אביב'}, school:{id:'2',label:'בית ספר'}, class:{id:'3',label:'ז׳3'} },
        friend:true, friendPending:false, careerGoals:30, wins:12, cards:42 };
      window.__deletes = [];
      const json = (b) => new Response(JSON.stringify(b), { status:200, headers:{ 'Content-Type':'application/json' } });
      const realFetch = window.fetch;
      window.fetch = (u, o) => {
        const url = String(u); const method = (o && o.method) || 'GET';
        if (method === 'DELETE' && url.includes('/handle-friends/')) { window.__deletes.push(url); return Promise.resolve(json({ ok:true })); }
        if (url.includes('/player/')) return Promise.resolve(json(PLAYER));
        if (url.includes('/requests/sent') || url.includes('/handle-friends/requests')) return Promise.resolve(json([]));
        if (url.includes('/handle-friends')) return Promise.resolve(json([FRIEND]));
        if (url.includes('/clubs/me')) return Promise.resolve(json({ club:null, metrics:[], scopes:{}, me:{ id:'u-me' } }));
        if (url.includes('/clubs') || url.includes('/dev/')) return Promise.resolve(json({}));
        return realFetch(u, o);
      };
    })()`,
  })

  const evl = async (e) => (await send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: e }))?.result?.value

  for (const d of DEVICES) {
    await send('Emulation.setDeviceMetricsOverride', { width: d.w, height: d.h, deviceScaleFactor: 2, mobile: true })
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?ftoken=harness&cb=${d.w}` })
    await sleep(7000)
    console.log(`\n=== ${d.name} (${d.w}x${d.h}) ===`)

    // ---- 1. MY PROFILE: the side panel must be able to scroll to its own bottom -----------------
    await evl(`(document.getElementById('home-face') || document.querySelector('#home .home-face'))?.click()`)
    await sleep(2200)   // openProfile() fetches stats, then clubs.js injects into .pf-side
    // showScreen is module-private; the profile opens from the hub's own control, so fall back to
    // the hash/route the page uses if the button is not where we guessed.
    const prof = await evl(`(() => {
      const side = document.querySelector('.pf-side');
      if (!side) return { open:false };
      const cs = getComputedStyle(side);
      return { open:true, overflowY: cs.overflowY,
        scrollable: side.scrollHeight > side.clientHeight + 1,
        reachable: cs.overflowY === 'auto' || cs.overflowY === 'scroll',
        scrollH: side.scrollHeight, clientH: side.clientHeight };
    })()`)
    if (prof?.open) {
      check('my profile side panel can scroll (overflow-y auto/scroll)', prof.reachable, `overflowY=${prof.overflowY}`)
      console.log(`      content ${prof.scrollH}px in a ${prof.clientH}px column → ${prof.scrollable ? 'overflows, and is reachable' : 'fits'}`)
    } else {
      console.log('    (profile screen not reachable from here — checked via CSS below)')
      const css = await evl(`(() => { for (const s of document.styleSheets) { try { for (const r of s.cssRules) if (r.selectorText === '.pf-side') return r.style.overflowY; } catch(e){} } return 'not-found'; })()`)
      check('.pf-side rule is scrollable', css === 'auto', `overflow-y: ${css}`)
    }

    // ---- 2. FRIEND CARD: rank inside the card, and reachable ------------------------------------
    await evl(`document.getElementById('friends-btn')?.click()`)
    await sleep(1500)
    await evl(`(document.querySelector('#friend-list .fc-pfp') || document.querySelector('#friend-list .friend-card'))?.click()`)
    await sleep(2600)   // clubs.js fetches /player/:id then injects
    const fr = await evl(`(() => {
      const modal = document.getElementById('friend-profile-modal');
      const card = modal && modal.querySelector('.fp-card');
      const ranks = modal && modal.querySelector('.pc-ranks');
      const inCard = !!(ranks && card && card.contains(ranks));
      const cs = card && getComputedStyle(card);
      return {
        open: !!(modal && !modal.classList.contains('hidden')),
        ranksInDOM: !!ranks, ranksInsideCard: inCard,
        text: ranks ? ranks.innerText.replace(/\\s+/g,' ').trim() : null,
        cardScrolls: cs ? (cs.overflowY === 'auto' || cs.overflowY === 'scroll') : null,
        // the injected wrapper is .fp-clubs; .pc-ranks is its child, so the wrapper is what must
        // sit before the destructive button.
        beforeRemove: (() => { const w = modal && modal.querySelector('.fp-clubs');
          return !!(w && w.nextElementSibling && w.nextElementSibling.id === 'fp-remove'); })(),
      };
    })()`)
    check('friend card opened', fr?.open)
    check('the rank block exists', fr?.ranksInDOM)
    check('...INSIDE the card, not beside it (the actual bug)', fr?.ranksInsideCard)
    check('...and it really shows גביעים + דירוג', /גביעים/.test(fr?.text || '') && /דירוג/.test(fr?.text || ''), JSON.stringify(fr?.text))
    check('...sitting above the remove button', fr?.beforeRemove)
    check('the card scrolls, so it is reachable at any height', fr?.cardScrolls)

    // ---- 3. UNFRIEND asks first, in-game ---------------------------------------------------------
    await evl(`window.__deletes = []`)
    await evl(`document.getElementById('fp-remove')?.click()`)
    await sleep(700)
    const asked = await evl(`(() => ({ dialog: !!document.querySelector('.ask-modal'), deletes: (window.__deletes||[]).length,
      title: (document.querySelector('.ask-title')||{}).textContent || '',
      buttons: [...document.querySelectorAll('.ask-btn')].map(b => b.textContent) }))()`)
    check('a confirm dialog appeared (the game\'s own, not the host\'s)', asked?.dialog)
    check('...naming the friend', /דן/.test(asked?.title || ''), JSON.stringify(asked?.title))
    check('...offering cancel AND remove', (asked?.buttons || []).includes('בטל') && (asked?.buttons || []).includes('הסר'), JSON.stringify(asked?.buttons))
    check('NOTHING deleted while the question is open', asked?.deletes === 0, `${asked?.deletes} DELETE(s) already sent`)

    await evl(`window.__askProbe.answer(false)`)
    await sleep(500)
    const cancelled = await evl(`(() => ({ dialog: !!document.querySelector('.ask-modal'), deletes: (window.__deletes||[]).length }))()`)
    check('cancel closes it and deletes nothing', !cancelled?.dialog && cancelled?.deletes === 0, JSON.stringify(cancelled))

    await evl(`document.getElementById('fp-remove')?.click()`)
    await sleep(600)
    await evl(`window.__askProbe.answer(true)`)
    await sleep(900)
    const confirmed = await evl(`(() => ({ deletes: (window.__deletes||[]).length, url: (window.__deletes||[])[0] || null }))()`)
    check('confirming removes exactly once', confirmed?.deletes === 1, JSON.stringify(confirmed))
    check('...and it hit the right friend', /u-dan/.test(confirmed?.url || ''), JSON.stringify(confirmed?.url))
  }

  ws.close(); chrome.kill()
  const pass = results.every(Boolean)
  console.log(pass ? '\n✅ profile scroll, friend rank and the unfriend guard all behave'
                   : `\n❌ ${results.filter(r => !r).length} of ${results.length} checks failed`)
  process.exit(pass ? 0 : 1)
}
main().catch(e => { console.error(e); process.exit(1) })
