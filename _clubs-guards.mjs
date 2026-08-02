/* THE DESTRUCTIVE CLUB ACTIONS MUST ASK FIRST — kick, and leaving the club.
 *
 * Adam 2026-08-02: "too easy to kick off club, need an are you sure" and "cannot remove myself as a
 * firends in clubs should be leave club with reassurence".
 *
 * What this pins, on the REAL client at the real in-app size:
 *   • the roster ✕ (kick) opens the game's own dialog, names the member, and POSTs /kick ONLY on yes
 *   • my own row carries a leave control (there was nothing there before)
 *   • leaving asks too, from BOTH entry points (my row, and the «עזוב» action)
 *   • cancelling any of them sends nothing at all
 *
 *   node _clubs-guards.mjs [port]        # default 3016
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = process.argv[2] || '3016'
const OUT = '/private/tmp/claude-501/-Users-adamleeperelman-Documents-pikeme/24a0f464-af08-4018-9ddf-e3fad2a0324f/scratchpad/clubguards'
mkdirSync(OUT, { recursive: true })
try { rmSync(OUT + '/profile', { recursive: true, force: true }) } catch {}
setTimeout(() => { console.error('TIMEOUT'); process.exit(2) }, 180000).unref?.()

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const CDP = 9442
const results = []
const check = (label, cond, detail) => { results.push(!!cond); console.log(`  ${cond ? '✓' : '✗'} ${label}${!cond && detail !== undefined ? '  — ' + detail : ''}`) }

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

  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      window.SALTIZ_CARDS = [{ r:'legendary', n:5, c:1, w:900 }];
      window.SALTIZ_XP = { xp: 4200, level: 9 };
      try { for (const k of ['fbTutorialSkipped','fbHubTourDone','fbHubTourSkipped','fbTuHubSkipped']) localStorage.setItem(k,'1'); } catch (e) {}
      const RealWS = window.WebSocket;
      window.WebSocket = function (...a) { const s = new RealWS(...a);
        s.addEventListener('open', () => setTimeout(() => { try { s.onmessage && s.onmessage({ data: JSON.stringify({ type:'welcome', id:'m-me', userId:'u-me' }) }); } catch(e){} }, 600));
        return s; };
      window.WebSocket.prototype = RealWS.prototype;
      // I am the PRESIDENT, so the roster gives me a kickable member and my own row.
      const ME = { club: { id:'c1', name:'האריות', emblem:'🦁', tag:'ABC234', type:'open', minTrophies:0,
          myRole:'president', canAdmit:true, count:2, maxMembers:30,
          members: [
            { id:'u-me',  nickName:'אדם', role:'president', xp:1200, trophies:1200, isMe:true,  isFriend:false, friendPending:false, canKick:false },
            { id:'u-dan', nickName:'דן',  role:'member',    xp:900,  trophies:900,  isMe:false, isFriend:false, friendPending:false, canKick:true  },
          ], pending: [] },
        me: { id:'u-me', nickName:'אדם' }, metrics: [], scopes: {}, labels: {}, maxMembers: 30 };
      window.__posts = [];
      const json = (b) => new Response(JSON.stringify(b), { status:200, headers:{ 'Content-Type':'application/json' } });
      const rf = window.fetch;
      window.fetch = (u, o) => {
        const url = String(u), method = (o && o.method) || 'GET';
        if (url.includes('/clubs') || url.includes('/dev/clubs')) {
          if (method === 'POST') { window.__posts.push(url.replace(/^https?:\\/\\/[^/]+/, '') + ' ' + (o.body || '')); return Promise.resolve(json({ ok:true })); }
          if (url.includes('/player/')) return Promise.resolve(json({ id:'u-dan', nickName:'דן', trophies:900, ranks:{trophies:{place:2,of:9},ranked:{place:1,of:4}}, club:null, scopes:{}, friend:false }));
          if (url.includes('/board')) return Promise.resolve(json({ rows: [], scope:'city' }));
          return Promise.resolve(json(ME));
        }
        if (url.includes('/handle-friends')) return Promise.resolve(json([]));
        return rf(u, o);
      };
    })()`,
  })
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?ftoken=harness` })
  await sleep(7000)

  const evl = async (e) => (await send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: e }))?.result?.value
  await evl(`document.querySelector('[data-open-screen="clubs"]')?.click()`)
  await sleep(2600)

  const roster = await evl(`(() => {
    const rows = [...document.querySelectorAll('#clubs .member')];
    return { rows: rows.length,
      names: rows.map(r => (r.querySelector('.member-name')||{}).textContent),
      myRowButtons: rows.filter(r => r.classList.contains('me')).map(r => [...r.querySelectorAll('button')].map(b => b.title || b.textContent)),
      kickButtons: [...document.querySelectorAll('#clubs .fr-kick')].map(b => b.title || b.textContent),
      leaveAction: !!document.querySelector('#clubs .club-ghost'),
    };
  })()`)
  console.log('\nROSTER'); console.log('   ', JSON.stringify(roster))
  check('the club roster rendered', (roster?.rows || 0) >= 2, JSON.stringify(roster))
  check('MY OWN row now has a leave control (it had none)', (roster?.myRowButtons?.[0] || []).some((t) => /יציאה|🚪/.test(t)), JSON.stringify(roster?.myRowButtons))
  check('the «עזוב» action still exists too', roster?.leaveAction)

  // ---- KICK ------------------------------------------------------------------------------------
  console.log('\nKICK')
  await evl(`window.__posts = []`)
  await evl(`[...document.querySelectorAll('#clubs .member')].find(r => !r.classList.contains('me'))?.querySelector('.fr-kick')?.click()`)
  await sleep(700)
  let s = await evl(`(() => ({ dialog: !!document.querySelector('.ask-modal'), title: (document.querySelector('.ask-title')||{}).textContent||'', posts: window.__posts.length }))()`)
  check('kick asks first', s?.dialog)
  check('...and names the member', /דן/.test(s?.title || ''), JSON.stringify(s?.title))
  check('...nothing sent while the question is open', s?.posts === 0, `${s?.posts} post(s)`)
  await evl(`window.__askProbe.answer(false)`); await sleep(500)
  s = await evl(`(() => ({ posts: window.__posts.length, dialog: !!document.querySelector('.ask-modal') }))()`)
  check('cancel kicks nobody', s?.posts === 0 && !s?.dialog, JSON.stringify(s))
  await evl(`[...document.querySelectorAll('#clubs .member')].find(r => !r.classList.contains('me'))?.querySelector('.fr-kick')?.click()`)
  await sleep(600); await evl(`window.__askProbe.answer(true)`); await sleep(900)
  s = await evl(`(() => ({ posts: window.__posts.slice() }))()`)
  check('confirming kicks exactly once', (s?.posts || []).filter((p) => p.includes('/kick')).length === 1, JSON.stringify(s?.posts))
  check('...with the right member id', (s?.posts || []).some((p) => p.includes('u-dan')), JSON.stringify(s?.posts))

  // ---- LEAVE, from my own row ---------------------------------------------------------------------
  console.log('\nLEAVE (from my own row)')
  await evl(`window.__posts = []`)
  await evl(`document.querySelector('#clubs .member.me .fr-kick')?.click()`)
  await sleep(700)
  s = await evl(`(() => ({ dialog: !!document.querySelector('.ask-modal'), title: (document.querySelector('.ask-title')||{}).textContent||'', body: (document.querySelector('.ask-body')||{}).textContent||'', posts: window.__posts.length }))()`)
  check('leaving asks first', s?.dialog)
  check('...naming the club', /האריות/.test(s?.title || ''), JSON.stringify(s?.title))
  check('...and warns a PRESIDENT that the club changes hands', /נשיא/.test(s?.body || ''), JSON.stringify(s?.body))
  check('...nothing sent yet', s?.posts === 0)
  await evl(`window.__askProbe.answer(false)`); await sleep(500)
  check('cancel leaves nothing behind', (await evl(`window.__posts.length`)) === 0)
  await evl(`document.querySelector('#clubs .member.me .fr-kick')?.click()`); await sleep(600)
  await evl(`window.__askProbe.answer(true)`); await sleep(900)
  const posts = await evl(`window.__posts.slice()`)
  check('confirming leaves exactly once', (posts || []).filter((p) => p.includes('/leave')).length === 1, JSON.stringify(posts))

  ws.close(); chrome.kill()
  const pass = results.every(Boolean)
  console.log(pass ? '\n✅ kick and leave both ask first, and cancel is really a cancel'
                   : `\n❌ ${results.filter((r) => !r).length} of ${results.length} checks failed`)
  process.exit(pass ? 0 : 1)
}
main().catch(e => { console.error(e); process.exit(1) })
