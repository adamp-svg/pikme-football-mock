/* CONNECTED PLAYERS (#online) — on the REAL client.
 *
 * Adam 2026-08-03: "if a player presses the connect button it opens a page with all connected player,
 * the user can then send a frenid invite or invite to play."
 *
 * The SERVER half (who is on the roster, the field list, the invite relaxation, the cooldown) is
 * covered by test-online-roster.mjs against a real server. THIS harness covers the half that cannot
 * see: that the hub chip opens the page, that rows paint with the right per-row STATE, and that the
 * two buttons call the two things they claim to. The roster arrives through a stubbed socket and the
 * friends API is stubbed in-page, so no login, no Mongo and no live token are needed — the client,
 * the DOM and the handlers are real.
 *
 *   node _online-page.mjs [port]        # default 3016
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = process.argv[2] || '3016'
const OUT = '/private/tmp/claude-501/-Users-adamleeperelman-Documents-pikeme/24a0f464-af08-4018-9ddf-e3fad2a0324f/scratchpad/onlinepage'
mkdirSync(OUT, { recursive: true })
try { rmSync(OUT + '/profile', { recursive: true, force: true }) } catch {}
setTimeout(() => { console.error('TIMEOUT'); process.exit(2) }, 180000).unref?.()

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const CDP = 9438

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

  // ── stubs: the friends API + a socket that answers whoOnline with a known roster ───────────────
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      window.SALTIZ_CARDS = [{ r:'legendary', n:5, c:1, w:900 }];
      window.SALTIZ_XP = { xp: 4200, level: 9 };
      try { for (const k of ['fbTutorialSkipped','fbHubTourDone','fbHubTourSkipped','fbTuHubSkipped']) localStorage.setItem(k,'1'); } catch (e) {}
      window.__api = [];   // every friends-API call the CLIENT made
      window.__ws  = [];   // every socket message the CLIENT sent
      // The roster the page is asked to render. Four rows, one per state the row logic has:
      //   u-friend already a friend · u-maya already asked · u-dan fresh · u-busy in a match
      window.__roster = [
        { userId: 'u-dan',    name: 'דן',   avatar: null, cosmetic: 'ninja:base', level: 7, inMatch: false },
        { userId: 'u-friend', name: 'יואב', avatar: null, cosmetic: 'tank:base',  level: 3, inMatch: false },
        { userId: 'u-maya',   name: 'מאיה', avatar: null, cosmetic: 'wizard:base',level: 5, inMatch: false },
        { userId: 'u-busy',   name: 'נועה', avatar: null, cosmetic: 'robot:base', level: 8, inMatch: true  },
      ];
      const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
      // ⚠️ THE GATE (same one _friend-requests.mjs documents): loadFriends() no-ops unless BOTH
      // FOOTBALL_TOKEN and MY_USER_ID are set, and MY_USER_ID only arrives on a welcome the server
      // AUTHENTICATED. ?ftoken=harness is not a real JWT, so the harness delivers the welcome itself.
      // It also answers whoOnline locally: the roster is the server's job and is tested there, and a
      // real one here would be empty (this socket is the only member).
      const RealWS = window.WebSocket;
      window.WebSocket = function (...a) {
        const s = new RealWS(...a);
        const deliver = (o) => { try { s.onmessage && s.onmessage({ data: JSON.stringify(o) }); } catch (e) {} };
        window.__deliver = deliver;
        const realSend = s.send.bind(s);
        s.send = (raw) => {
          try {
            const m = JSON.parse(raw);
            window.__ws.push(m);
            // Answer the roster ask in-page, one tick later, exactly as a server would.
            if (m.type === 'whoOnline') { setTimeout(() => deliver({ type: 'onlineList', players: window.__roster }), 30); return; }
            // Confirm invites by default. Switched OFF for the refusal test, where the server answers
            // partyError INSTEAD of partyInviteSent — delivering both would be a state that cannot
            // happen, and asserting on it would prove nothing about the revert.
            if (m.type === 'inviteFriend') { if (window.__autoConfirmInvite !== false) setTimeout(() => deliver({ type: 'partyInviteSent', toUserId: m.toUserId }), 30); return; }
          } catch (e) {}
          return realSend(raw);
        };
        s.addEventListener('open', () => setTimeout(() => deliver({ type: 'welcome', id: 'm-me', userId: 'u-me', field: null, chars: null }), 700));
        return s;
      };
      window.WebSocket.prototype = RealWS.prototype;
      const realFetch = window.fetch;
      window.fetch = (u, o) => {
        const url = String(u); const method = (o && o.method) || 'GET';
        const body = o && o.body ? JSON.parse(o.body) : null;
        if (url.includes('/handle-friends') || url.includes('/dev/friends')) {
          window.__api.push(method + ' ' + url.replace(/^https?:\\/\\/[^/]+/, '') + (body ? ' ' + JSON.stringify(body) : ''));
          if (url.includes('/requests/sent')) return Promise.resolve(json([{ requestId: 'r-out-1', toUserId: 'u-maya', nickName: 'מאיה', image: null }]));
          if (url.includes('/requests'))      return Promise.resolve(json([]));
          if (url.includes('/request'))       return Promise.resolve(json({ ok: true }));
          if (url.match(/\\/handle-friends\\/?($|\\?)/)) return Promise.resolve(json([{ userId: 'u-friend', nickName: 'יואב', image: null }]));
          return Promise.resolve(json([]));
        }
        return realFetch(u, o);
      };
    })()`,
  })
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?ftoken=harness` })
  await sleep(6000)

  const evl = async (expr) => (await send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: expr }))?.result?.value
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' })
    if (r?.data) { const { writeFileSync } = await import('node:fs'); writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, 'base64')) }
  }

  const read = () => evl(`(() => {
    const scr = document.getElementById('online');
    const rows = [...document.querySelectorAll('#online-list .friend-row')].map(r => ({
      name: (r.querySelector('.friend-name')||{}).textContent || '',
      sub:  (r.querySelector('.on-sub')||{}).textContent || '',
      busy: !!r.querySelector('.on-busy'),
      // ⚠️ READ THE SPRITE, NOT THE GLYPH. public/icon-system.js swaps ➕/👥/✓ out of the DOM for
      // pixel-art sprites (.saltiz-icon.si-add / .si-friends / .si-confirm), so textContent legitimately
      // comes back as " חבר". Asserting on the emoji character measured the icon pack, not the feature.
      btns: [...r.querySelectorAll('button')].map(b => ({
        t: b.textContent.trim(), off: !!b.disabled,
        ic: [...b.querySelectorAll('.saltiz-icon')].map(i => [...i.classList].find(c => c.startsWith('si-'))).filter(Boolean).join(','),
      })),
    }));
    return {
      open: !!scr && !scr.classList.contains('hidden'),
      rows,
      listText: (document.getElementById('online-list')||{}).textContent || '',
      api: window.__api.slice(),
      wsTypes: window.__ws.map(m => m.type),
      ws: window.__ws.slice(),
    };
  })()`)
  const rowOf = (s, name) => s.rows.find(r => r.name === name)
  const btnOf = (row, needle) => (row?.btns || []).find(b => b.t.includes(needle))

  console.log('\n1) THE CHIP IS A CONTROL AND IT OPENS THE PAGE')
  const chip = await evl(`(() => {
    const b = document.getElementById('hub-online-btn'); if (!b) return null;
    const cs = getComputedStyle(b); const r = b.getBoundingClientRect();
    return { tag: b.tagName, count: (document.getElementById('home-online')||{}).textContent,
             radius: cs.borderRadius, cursor: cs.cursor, w: Math.round(r.width), h: Math.round(r.height) };
  })()`)
  check('the connected chip is a <button>', chip && chip.tag === 'BUTTON', JSON.stringify(chip))
  check('#home-online survived (the 5Hz count still has its target)', chip && chip.count !== undefined && chip.count !== '')
  check('it does not look like a UA button', chip && chip.radius === '0px' && chip.cursor === 'pointer')
  await evl(`document.getElementById('hub-online-btn').click()`)
  await sleep(1200)
  let s = await read()
  check('tapping it opens #online', s.open)
  check('the client asked the server for the roster', s.wsTypes.includes('whoOnline'))

  console.log('\n2) THE ROSTER PAINTS, WITH PER-ROW STATE')
  console.log('   ', JSON.stringify(s.rows))
  check('all four connected players are listed', s.rows.length === 4, `${s.rows.length} rows`)
  check('a stranger row shows hero · level', (rowOf(s, 'דן')?.sub || '').includes('Ninja') && (rowOf(s, 'דן')?.sub || '').includes('רמה 7'), rowOf(s, 'דן')?.sub)
  check('the in-match player is marked', rowOf(s, 'נועה')?.busy === true)
  check('...and is STILL invitable (explicit ruling)', btnOf(rowOf(s, 'נועה'), 'הזמן')?.off === false)
  check('an existing friend cannot be re-friended', btnOf(rowOf(s, 'יואב'), 'חבר')?.off === true && btnOf(rowOf(s, 'יואב'), 'חבר')?.ic === 'si-confirm', JSON.stringify(rowOf(s, 'יואב')?.btns))
  check('someone already asked reads נשלחה', btnOf(rowOf(s, 'מאיה'), 'נשלחה')?.off === true, JSON.stringify(rowOf(s, 'מאיה')?.btns))
  check('a fresh stranger gets a live ➕ and a live 👥', btnOf(rowOf(s, 'דן'), 'חבר')?.off === false && btnOf(rowOf(s, 'דן'), 'הזמן')?.off === false)
  check('...drawn with the add + friends sprites, not raw emoji', btnOf(rowOf(s, 'דן'), 'חבר')?.ic === 'si-add' && btnOf(rowOf(s, 'דן'), 'הזמן')?.ic === 'si-friends', JSON.stringify(rowOf(s, 'דן')?.btns))
  await shot('online-844x390')

  console.log('\n3) ➕ SENDS A FRIEND REQUEST')
  const apiBefore = s.api.filter(c => c.includes('POST') && c.includes('/request')).length
  await evl(`(() => { const r = [...document.querySelectorAll('#online-list .friend-row')].find(r => r.querySelector('.friend-name').textContent === 'דן');
    [...r.querySelectorAll('button')].find(b => b.textContent.includes('חבר')).click(); })()`)
  await sleep(1500)
  s = await read()
  const reqCalls = s.api.filter(c => c.startsWith('POST') && c.includes('/handle-friends/request'))
  check('POST /handle-friends/request carried the right userId', reqCalls.some(c => c.includes('u-dan')), reqCalls[0])
  check('...exactly once', reqCalls.length === apiBefore + 1, `${reqCalls.length} call(s)`)
  check('the button now reads נשלחה and is dead', btnOf(rowOf(s, 'דן'), 'נשלחה')?.off === true, JSON.stringify(rowOf(s, 'דן')?.btns))
  // THE RACE THIS CAUGHT: the stub's /requests/sent deliberately does NOT list the new request, which
  // is what an eventually-consistent read looks like. A plain `SENT_TO = new Set(server list)` wiped
  // the optimistic mark ~1s later and the row offered to send it all over again.
  await sleep(2500)
  s = await read()
  check('...and it STAYS נשלחה after the sent-list refresh comes back without it', btnOf(rowOf(s, 'דן'), 'נשלחה')?.off === true, JSON.stringify(rowOf(s, 'דן')?.btns))

  console.log('\n4) 👥 INVITES TO THE PARTY')
  await evl(`(() => { const r = [...document.querySelectorAll('#online-list .friend-row')].find(r => r.querySelector('.friend-name').textContent === 'דן');
    [...r.querySelectorAll('button')].find(b => b.textContent.includes('הזמן')).click(); })()`)
  await sleep(1000)
  s = await read()
  const inv = s.ws.filter(m => m.type === 'inviteFriend')
  check('inviteFriend went out for that player', inv.length === 1 && inv[0].toUserId === 'u-dan', JSON.stringify(inv))
  check('the button now reads הוזמן', btnOf(rowOf(s, 'דן'), 'הוזמן')?.off === true, JSON.stringify(rowOf(s, 'דן')?.btns))

  console.log('\n5) A REFUSED INVITE MUST NOT KEEP SAYING הוזמן')
  // The server refuses for real reasons: the 1.5s anti-flood cooldown, a full room, a room already in
  // a match. It answers partyError and NOT partyInviteSent, so the stub stops confirming here.
  await evl(`window.__autoConfirmInvite = false`)
  await evl(`(() => { const r = [...document.querySelectorAll('#online-list .friend-row')].find(r => r.querySelector('.friend-name').textContent === 'נועה');
    [...r.querySelectorAll('button')].find(b => b.textContent.includes('הזמן')).click(); })()`)
  await sleep(500)
  s = await read()
  check('the tapped row says הוזמן while the answer is pending', btnOf(rowOf(s, 'נועה'), 'הוזמן')?.off === true, JSON.stringify(rowOf(s, 'נועה')?.btns))
  await evl(`window.__deliver({ type: 'partyError', msg: 'רגע אחד…' })`)
  await sleep(600)
  s = await read()
  check('a refused invite goes back to an invitable 👥', btnOf(rowOf(s, 'נועה'), 'הזמן')?.off === false, JSON.stringify(rowOf(s, 'נועה')?.btns))
  check('...and the CONFIRMED invite is untouched by that error', btnOf(rowOf(s, 'דן'), 'הוזמן')?.off === true, JSON.stringify(rowOf(s, 'דן')?.btns))

  console.log('\n6) NOBODY ONLINE')
  await evl(`window.__deliver({ type: 'onlineList', players: [] })`)
  await sleep(500)
  s = await read()
  check('the empty state explains itself', s.rows.length === 0 && s.listText.includes('אף אחד'), s.listText.trim())

  console.log('\n7) THE POLL STOPS WHEN THE PAGE CLOSES')
  await evl(`document.querySelector('#online [data-home-back]').click()`)
  await sleep(500)
  const before = await evl(`window.__ws.filter(m => m.type === 'whoOnline').length`)
  await sleep(6000)   // longer than the 5s poll interval
  const after = await evl(`window.__ws.filter(m => m.type === 'whoOnline').length`)
  check('back returns to the hub', !(await read()).open)
  check('no roster asks once the page is closed', after === before, `${before} → ${after}`)

  console.log('\n8) A BUSY EVENING FITS — 10 PLAYERS ON A 390px-TALL PHONE')
  // The clipped-profile-pane lesson: a list that overflows must SCROLL, and the document behind it
  // must not, or the bottom rows are simply unreachable on a phone.
  await evl(`window.__roster = ['דן','יואב','מאיה','נועה','איתי','שירה','עומר','תמר','רון','ליאור']
    .map((n, i) => ({ userId: 'u' + i, name: n, avatar: null, cosmetic: 'ninja:base', level: i + 1, inMatch: i % 4 === 3 }))`)
  await evl(`document.getElementById('hub-online-btn').click()`)
  await sleep(1200)
  const fit = await evl(`(() => {
    const b = document.querySelector('#online .subpage-body');
    const rows = [...document.querySelectorAll('#online-list .friend-row')];
    b.scrollTop = 99999;
    const last = rows[rows.length - 1].getBoundingClientRect(), bb = b.getBoundingClientRect();
    return { rows: rows.length, canScroll: b.scrollHeight > b.clientHeight + 1, atBottom: b.scrollTop > 0,
             lastVisible: last.bottom <= bb.bottom + 1 && last.top >= bb.top - 1,
             docScroll: document.scrollingElement.scrollHeight - document.scrollingElement.clientHeight };
  })()`)
  check('all ten rows are in the DOM', fit.rows === 10, `${fit.rows}`)
  check('the list scrolls instead of clipping', fit.canScroll && fit.atBottom, JSON.stringify(fit))
  check('the LAST row is reachable', fit.lastVisible)
  check('the page itself never scrolls (landscape WebView)', fit.docScroll === 0, `${fit.docScroll}px`)
  await shot('online-844x390-scrolled')

  // iPad, the other shape Adam checks.
  await send('Emulation.setDeviceMetricsOverride', { width: 1194, height: 834, deviceScaleFactor: 2, mobile: true })
  await evl(`document.getElementById('hub-online-btn').click()`)
  await sleep(1200)
  await shot('online-ipad')

  const passed = results.filter(Boolean).length
  console.log(`\n${passed}/${results.length} PASS   shots: ${OUT}`)
  ws.close(); chrome.kill()
  process.exit(passed === results.length ? 0 : 1)
}

main().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2) })
