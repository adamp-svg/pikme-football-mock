/* Proves the CLUBS screen fits a landscape phone without scrolling, by driving the REAL client.
 *
 * Why it stubs fetch instead of building a fixture page: the thing under test is the interaction
 * between clubs.js's real DOM, clubs.css's real rules and .subpage-body's real height. A hand-built
 * replica of the markup would pass while the shipped screen still scrolled — I have written that
 * useless test before. So this loads the actual page, installs the stub BEFORE any script runs, and
 * lets renderMyClub() build the DOM it really builds.
 *
 * The assertion is scrollHeight vs clientHeight on the OUTER body. Careful: a squashed flex child
 * reports scrollHeight == clientHeight even when its content overflows, so that number alone is not
 * evidence — this also checks that .club-main is a real scroller and that both columns have width.
 *
 *   node _clubs-split.mjs [port]        # default 3016
 */
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { rmSync } from 'node:fs'
const step = m => console.error('· ' + m)

const PORT = process.argv[2] || '3016'
const OUT = '/private/tmp/claude-501/-Users-adamleeperelman-Documents-pikeme/00ddc158-6376-4024-ba10-455d2c7bceff/scratchpad/clubshot'
mkdirSync(OUT, { recursive: true })
try { rmSync(OUT + '/profile', { recursive: true, force: true }) } catch {}
setTimeout(() => { console.error('TIMEOUT — harness hung'); process.exit(2) }, 90000).unref?.()

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const CDP = 9333

const ROLES = ['president', 'vice', 'senior', 'member']
const NAMES = ['אדם', 'יונתן', 'נועה', 'איתי', 'שירה', 'דניאל', 'מאיה', 'עומר', 'תמר', 'רון',
  'ליאור', 'אביב', 'יעל', 'גיא', 'הילה', 'אורי', 'שני', 'אלון', 'נטע', 'עידו',
  'רועי', 'ספיר', 'יובל', 'אמיר', 'טל', 'נדב', 'מיכל', 'אסף', 'דור', 'ענבר']

// Shaped to the REAL /handle-clubs/me contract (pikme-server routes-pikme/clubs.js). clubs.js bails
// on `!state.me.me`, so a fixture missing that field silently renders the offline hero instead.
const ME = {
  me: { id: 'u0', nickName: 'אדם' },
  maxMembers: 30, k: 3,
  metrics: [{ key: 'xp', labelHe: 'XP' }, { key: 'trophies', labelHe: 'גביעים' }],
  scopes: { city: { id: '2025178902' }, school: { id: 'x' }, grade: 5, classNumber: 2 },
  club: {
    id: 'c1', tag: '#ABC123', emblem: '🦁', name: 'אריות תל אביב', myRole: 'president',
    type: 'open', minTrophies: 1200, canAdmit: true, count: 30, maxMembers: 30,
    pending: [{ id: 'p1', nickName: 'מתן', trophies: 980 }],
    members: NAMES.map((n, i) => ({
      id: 'u' + i, nickName: n, role: ROLES[Math.min(3, i)], trophies: 4200 - i * 97,
      isMe: i === 0, isFriend: i % 5 === 1, friendPending: i % 7 === 3, canKick: i !== 0,
    })),
  },
}

const rpc = (ws, id, method, params) => ws.send(JSON.stringify({ id, method, params }))

async function main() {
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${CDP}`, '--headless=new', '--no-first-run',
    `--user-data-dir=${OUT}/profile`, '--window-size=1212,560', 'about:blank',
  ], { stdio: 'ignore' })

  step('chrome spawned')
  let target
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(250)
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()
      target = list.find(t => t.type === 'page')
    } catch {}
  }
  if (!target) { chrome.kill(); throw new Error('chrome never came up') }

  step('page target: ' + target.id)
  const { WebSocket } = await import('ws').catch(() => ({ WebSocket: globalThis.WebSocket }))
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise(r => ws.on ? ws.on('open', r) : (ws.onopen = r))

  let id = 0
  const pending = new Map()
  const send = (method, params = {}) => new Promise(res => { pending.set(++id, res); rpc(ws, id, method, params) })
  const onMsg = (raw) => {
    const m = JSON.parse(raw)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id) }
  }
  ws.on ? ws.on('message', d => onMsg(d.toString())) : (ws.onmessage = e => onMsg(e.data))

  step('ws open')
  await send('Page.enable'); await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1212, height: 560, deviceScaleFactor: 2, mobile: true,
  })

  // Stub BEFORE any page script runs, so clubs.js's own fetch calls resolve to the fixture.
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      const ME = ${JSON.stringify(ME)};
      const real = window.fetch;
      window.fetch = (u, o) => {
        const s = String(u);
        if (s.includes('/clubs/me')) return Promise.resolve(new Response(JSON.stringify(ME), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        if (s.includes('/clubs/find')) return Promise.resolve(new Response(JSON.stringify({ myTrophies: 4200, rows: [] }), { status: 200 }));
        return real(u, o);
      };
      window.PIKME_FOOTBALL_TOKEN = 'harness';
    })()`,
  })

  step('stub installed')
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?ftoken=harness` })
  await sleep(3500)

  // Open the clubs screen the way the app does, then let the render settle.
  await send('Runtime.evaluate', {
    expression: `(() => {
      document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
      document.getElementById('clubs').classList.remove('hidden');
    })()`,
  })
  await sleep(2500)

  step('clubs screen opened')
  const r = await send('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => {
      const body = document.querySelector('#clubs .subpage-body');
      const grid = document.querySelector('#clubs .club-2col');
      const side = document.querySelector('#clubs .club-side');
      const main = document.querySelector('#clubs .club-main');
      const rows = document.querySelectorAll('#clubs .club-main .member').length;
      const page = document.scrollingElement;
      if (!grid) return { rendered: false, bodyHTML: body ? body.innerHTML.slice(0, 300) : 'no body' };
      const box = e => { const b = e.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), x: Math.round(b.x), y: Math.round(b.y) }; };
      return {
        rendered: true, rows,
        viewport: { w: innerWidth, h: innerHeight },
        page:  { scrollH: page.scrollHeight, clientH: page.clientHeight },
        body:  { scrollH: body.scrollHeight, clientH: body.clientHeight, overflowY: getComputedStyle(body).overflowY },
        grid: box(grid), side: box(side), main: box(main),
        mainScroll: { scrollH: main.scrollHeight, clientH: main.clientHeight, overflowY: getComputedStyle(main).overflowY },
        sideBottom: Math.round(side.getBoundingClientRect().bottom),
        actionsInSide: !!side.querySelector('.club-actions'),
        bandSticky: getComputedStyle(document.querySelector('#clubs .club-band')).position,
        sideKids: [...side.children].map(e => { const c = getComputedStyle(e); return { cls: e.className, h: Math.round(e.getBoundingClientRect().height), flex: c.flex, alignSelf: c.alignSelf, alignContent: c.alignContent }; }),
        mainKids: [...main.children].map(e => { const c = getComputedStyle(e); return { cls: e.className, h: Math.round(e.getBoundingClientRect().height), flex: c.flex, alignContent: c.alignContent }; }),
        memberH: Math.round((main.querySelector('.member')||{getBoundingClientRect:()=>({height:0})}).getBoundingClientRect().height),
      };
    })()`,
  })

  const v = r?.result?.value
  console.log(JSON.stringify(v, null, 2))

  const shot = await send('Page.captureScreenshot', { format: 'png' })
  if (shot?.data) {
    writeFileSync(`${OUT}/clubs-landscape.png`, Buffer.from(shot.data, 'base64'))
    console.log('\nscreenshot ->', `${OUT}/clubs-landscape.png`)
  }

  // Portrait fallback must still work — the same screen in a browser held upright.
  await send('Emulation.setDeviceMetricsOverride', { width: 402, height: 874, deviceScaleFactor: 2, mobile: true })
  await sleep(1200)
  const p = await send('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => {
      const g = document.querySelector('#clubs .club-2col');
      return { cols: getComputedStyle(g).gridTemplateColumns, mainOverflow: getComputedStyle(document.querySelector('#clubs .club-main')).overflowY };
    })()`,
  })
  console.log('\nportrait:', JSON.stringify(p?.result?.value))
  const shot2 = await send('Page.captureScreenshot', { format: 'png' })
  if (shot2?.data) writeFileSync(`${OUT}/clubs-portrait.png`, Buffer.from(shot2.data, 'base64'))

  ws.close(); chrome.kill()

  if (!v?.rendered) { console.log('\nFAIL: the split never rendered'); process.exit(1) }
  const fails = []
  if (v.body.scrollH > v.body.clientH + 2) fails.push(`outer body still scrolls (${v.body.scrollH} > ${v.body.clientH})`)
  if (v.page.scrollH > v.page.clientH + 2) fails.push(`page still scrolls (${v.page.scrollH} > ${v.page.clientH})`)
  if (v.side.w < 150) fails.push(`side column too narrow (${v.side.w}px)`)
  if (v.main.w < v.side.w) fails.push(`list column (${v.main.w}) is not wider than the side (${v.side.w})`)
  if (v.mainScroll.overflowY !== 'auto' && v.mainScroll.overflowY !== 'scroll') fails.push(`.club-main is not a scroller (${v.mainScroll.overflowY})`)
  if (v.sideBottom > v.viewport.h + 2) fails.push(`side column runs off the bottom (${v.sideBottom} > ${v.viewport.h})`)
  if (!v.actionsInSide) fails.push('actions are not in the side column')
  console.log(fails.length ? '\nFAIL:\n  ' + fails.join('\n  ') : '\nPASS — both columns used, nothing scrolls but the roster')
  process.exit(fails.length ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(1) })
