/* FRIEND REQUESTS — both directions, on the REAL client.
 *
 * Adam 2026-08-01: "friend request have stopped working in friends and also in the clubs frend
 * request … show those sent and thos recived, allow to accept and reject or cancel".
 *
 * The API half is covered by node tests in pikme-server (friends.direction.test.js: the re-arm of a
 * stale declined/accepted row, /requests/sent, /cancel). THIS harness covers the half those cannot
 * see: that the lobby actually PAINTS the two lists and that the three buttons call the three
 * endpoints. The friends API is stubbed in-page, so no login, no Mongo and no live token are needed —
 * what is real is the client, the DOM and the handlers.
 *
 *   node _friend-requests.mjs [port]        # default 3016
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = process.argv[2] || '3016'
const OUT = '/private/tmp/claude-501/-Users-adamleeperelman-Documents-pikeme/24a0f464-af08-4018-9ddf-e3fad2a0324f/scratchpad/friendreq'
mkdirSync(OUT, { recursive: true })
try { rmSync(OUT + '/profile', { recursive: true, force: true }) } catch {}
setTimeout(() => { console.error('TIMEOUT'); process.exit(2) }, 180000).unref?.()

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const CDP = 9437

const results = []
const check = (label, cond, detail) => { results.push(!!cond); console.log(`  ${cond ? '✓' : '✗'} ${label}${detail !== undefined ? '  — ' + detail : ''}`) }

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
  ws.on('message', d => { const m = JSON.parse(d.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id) } })
  await send('Page.enable'); await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 2, mobile: true })

  // ── the stubbed friends backend, mirroring the real routes ────────────────────────────────────
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      window.SALTIZ_CARDS = [{ r:'legendary', n:5, c:1, w:900 }];
      window.SALTIZ_XP = { xp: 4200, level: 9 };
      try { for (const k of ['fbTutorialSkipped','fbHubTourDone','fbHubTourSkipped','fbTuHubSkipped']) localStorage.setItem(k,'1'); } catch (e) {}
      // In-memory request store + a call log, so the test asserts on what the CLIENT ASKED FOR.
      window.__api = [];
      const state = {
        incoming: [{ requestId: 'r-in-1', fromUserId: 'u-dan', nickName: 'דן', image: null }],
        sent:     [{ requestId: 'r-out-1', toUserId: 'u-maya', nickName: 'מאיה', image: null }],
      };
      const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
      // ⚠️ THE GATE THAT MAKES A NAIVE VERSION OF THIS HARNESS MEASURE NOTHING: loadFriends()
      // returns immediately unless BOTH FOOTBALL_TOKEN and MY_USER_ID are set, and MY_USER_ID only
      // arrives on the server's welcome for a socket it AUTHENTICATED. ?ftoken=harness is not a real
      // JWT, so the game server sends a welcome with no userId, nothing ever calls the friends API,
      // and every assertion below fails against a perfectly working client. So the harness delivers a
      // welcome carrying a userId itself, on the real socket, after the client has attached onmessage.
      const RealWS = window.WebSocket;
      window.WebSocket = function (...a) {
        const s = new RealWS(...a);
        s.addEventListener('open', () => setTimeout(() => {
          try { s.onmessage && s.onmessage({ data: JSON.stringify({ type: 'welcome', id: 'm-me', userId: 'u-me', field: null, chars: null }) }); } catch (e) {}
        }, 700));
        return s;
      };
      window.WebSocket.prototype = RealWS.prototype;
      const realFetch = window.fetch;
      window.fetch = (u, o) => {
        const url = String(u); const method = (o && o.method) || 'GET';
        const body = o && o.body ? JSON.parse(o.body) : null;
        if (url.includes('/handle-friends') || url.includes('/dev/friends')) {
          window.__api.push(method + ' ' + url.replace(/^https?:\\/\\/[^/]+/, '') + (body ? ' ' + JSON.stringify(body) : ''));
          if (url.includes('/requests/sent')) return Promise.resolve(json(state.sent));
          if (url.includes('/requests'))      return Promise.resolve(json(state.incoming));
          if (url.includes('/cancel'))   { state.sent = state.sent.filter(r => r.requestId !== body.requestId); return Promise.resolve(json({ ok: true })); }
          if (url.includes('/respond'))  { state.incoming = state.incoming.filter(r => r.requestId !== body.requestId); return Promise.resolve(json({ ok: true })); }
          if (url.includes('/request'))  { state.sent = state.sent.concat([{ requestId: 'r-out-new', toUserId: body.toUserId, nickName: 'חדש', image: null }]); return Promise.resolve(json({ ok: true })); }
          if (url.includes('/search'))   return Promise.resolve(json([{ userId: 'u-new', nickName: 'שחקן חדש', image: null }]));
          return Promise.resolve(json([]));   // GET /handle-friends (the friends list itself)
        }
        return realFetch(u, o);
      };
    })()`,
  })
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?ftoken=harness` })
  await sleep(6000)

  const evl = async (expr) => (await send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: expr }))?.result?.value

  // open friends → the בקשות tab
  await evl(`document.getElementById('friends-btn').click()`)
  await sleep(1200)
  await evl(`document.querySelector('.fr-tab[data-tab="requests"]').click()`)
  await sleep(1200)

  const read = () => evl(`(() => {
    const rows = (id) => [...document.querySelectorAll('#' + id + ' .friend-row')].map(r => ({
      name: (r.querySelector('.friend-name')||{}).textContent || '',
      btns: [...r.querySelectorAll('button')].map(b => b.textContent),
    }));
    const txt = (id) => (document.getElementById(id)||{}).textContent || '';
    return {
      received: rows('friend-requests'), sent: rows('friend-requests-sent'),
      receivedText: txt('friend-requests'), sentText: txt('friend-requests-sent'),
      headings: [...document.querySelectorAll('.fr-pane[data-pane="requests"] .fr-sec-h')].map(h => h.textContent),
      badge: (document.getElementById('fr-req-badge')||{}).textContent,
      badgeHidden: !!(document.getElementById('fr-req-badge')||{}).classList?.contains('hidden'),
      api: window.__api.slice(),
    };
  })()`)

  console.log('\n1) BOTH DIRECTIONS ARE PAINTED')
  let s = await read()
  console.log('   ', JSON.stringify({ received: s.received, sent: s.sent, headings: s.headings }))
  check('the pane has a received heading and a sent heading', s.headings.length === 2, JSON.stringify(s.headings))
  check('the received request is listed', s.received.length === 1 && s.received[0].name === 'דן')
  // Set membership, not order: friendRow appends the reject button before the accept one, so the DOM
  // order is [דחה, אישור] while RTL paints accept first. Asserting the array order would be asserting
  // an implementation detail that has nothing to do with the feature.
  check('...with accept AND reject', ['אישור', 'דחה'].every((t) => (s.received[0]?.btns || []).includes(t)), JSON.stringify(s.received[0]?.btns))
  check('the SENT request is listed (this list did not exist before)', s.sent.length === 1 && s.sent[0].name === 'מאיה')
  check('...with a cancel button and nothing else', JSON.stringify(s.sent[0]?.btns) === JSON.stringify(['בטל']), JSON.stringify(s.sent[0]?.btns))
  check('the client asked BOTH endpoints', s.api.some(c => c.includes('/requests')) && s.api.some(c => c.includes('/requests/sent')))
  check('the badge counts INCOMING only', s.badge === '1' && !s.badgeHidden, `badge=${s.badge}`)

  console.log('\n2) CANCEL a sent request')
  await evl(`[...document.querySelectorAll('#friend-requests-sent .friend-row button')].find(b => b.textContent === 'בטל').click()`)
  await sleep(1400)
  s = await read()
  check('POST /cancel carried the requestId', s.api.some(c => c.startsWith('POST') && c.includes('/cancel') && c.includes('r-out-1')), s.api.filter(c => c.includes('cancel'))[0])
  check('the sent list is empty afterwards', s.sent.length === 0)
  check('...and says so instead of going blank', s.sentText.includes('לא שלחת'), JSON.stringify(s.sentText.trim().slice(0, 30)))
  check('the received list is untouched', s.received.length === 1)

  console.log('\n3) ACCEPT a received request')
  await evl(`[...document.querySelectorAll('#friend-requests .friend-row button')].find(b => b.textContent === 'אישור').click()`)
  await sleep(1600)
  s = await read()
  check('POST /respond accept carried the requestId', s.api.some(c => c.includes('/respond') && c.includes('accept') && c.includes('r-in-1')), s.api.filter(c => c.includes('respond'))[0])
  check('the received list empties', s.received.length === 0)
  check('...and says so', s.receivedText.includes('אין בקשות'), JSON.stringify(s.receivedText.trim().slice(0, 30)))
  check('the badge is hidden at zero', s.badgeHidden, `badge=${s.badge} hidden=${s.badgeHidden}`)

  console.log('\n4) SENDING from search lands in «ששלחתי» immediately')
  await evl(`document.querySelector('.fr-tab[data-tab="add"]').click()`)
  await sleep(600)
  await evl(`(() => { const i = document.getElementById('friend-search'); i.value = 'שחקן'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  await sleep(1500)
  await evl(`[...document.querySelectorAll('#friend-search-results .friend-row button')].find(b => b.textContent === 'הוסף')?.click()`)
  await sleep(1600)
  await evl(`document.querySelector('.fr-tab[data-tab="requests"]').click()`)
  await sleep(1000)
  s = await read()
  check('POST /request was sent', s.api.some(c => c.startsWith('POST') && /\/request(\?|$| )/.test(c.replace(/\{.*/, ' ')) || (c.startsWith('POST') && c.includes('/request ') && !c.includes('/requests'))), s.api.filter(c => c.includes('POST') && c.includes('/request') && !c.includes('/requests')).slice(-1)[0])
  check('the new request is visible in the SENT list right away', s.sent.length === 1, JSON.stringify(s.sent))

  const shot = await send('Page.captureScreenshot', { format: 'png' })
  if (shot?.data) writeFileSync(`${OUT}/friend-requests.png`, Buffer.from(shot.data, 'base64'))
  console.log('\nshot ->', `${OUT}/friend-requests.png`)
  ws.close(); chrome.kill()

  const pass = results.every(Boolean)
  console.log(pass ? '\n✅ friend requests work in both directions' : `\n❌ ${results.filter(r => !r).length} of ${results.length} checks failed`)
  process.exit(pass ? 0 : 1)
}
main().catch(e => { console.error(e); process.exit(1) })
