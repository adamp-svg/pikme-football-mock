/* Proves the CLUBS screen is not CROPPED on any surface it ships to, by driving the REAL client.
 *
 * Why it stubs fetch instead of building a fixture page: the thing under test is the interaction
 * between clubs.js's real DOM, clubs.css's real rules and .subpage-body's real height. A hand-built
 * replica of the markup would pass while the shipped screen still clipped — I have written that
 * useless test before. So this loads the actual page, installs the stub BEFORE any script runs, and
 * lets renderMyClub() / renderFind() / renderNoClub() / renderCreate() build the DOM they really build.
 *
 * ⚠️ THE THREE TRAPS THIS HARNESS EXISTS TO AVOID — every one of them produced a green run on a
 *    visibly cropped screen at some point:
 *
 *  1. THE WRONG VIEWPORT. The old version of this file ran at 1212x560. That is the PITCH CAMERA
 *     WINDOW in world units, not a CSS viewport. The real in-app surface is 844x390 (iPhone 17 Pro
 *     landscape) and the tightest Android ships 800x360. The device list below is the phone subset of
 *     _device-matrix.mjs's DEVICES, at their real CSS sizes.
 *
 *  2. `scrollHeight === clientHeight` IS NOT A FIT. A grid item stretched by `align-items:stretch`
 *     into an auto-sized row is laid out TALLER than the grid box and reports a perfect internal fit
 *     while hanging out of its parent. Measured 844x390 before the fix: .club-side scrollHeight 318
 *     === clientHeight 318, bottom 381, parent bottom 370. So this checks CONTAINMENT (bottom vs the
 *     nearest clipping ancestor) as well, and it checks it for every painted node.
 *
 *  3. `overflow:hidden` IS STILL PROGRAMMATICALLY SCROLLABLE. Setting scrollTop from script moves a
 *     hidden box, so a naive "canScroll" probe reports true on content the user can never reach. The
 *     reachability probe here dispatches a real mouseWheel and re-reads scrollTop.
 *
 *   node _clubs-split.mjs [port]        # default 3016
 *   VIEWS=myclub,find node _clubs-split.mjs        # subset
 *   ONLY=iphone-17-pro node _clubs-split.mjs       # one device
 */
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
const step = m => console.error('· ' + m)

const PORT = process.argv[2] || '3016'
const OUT = '/private/tmp/claude-501/-Users-adamleeperelman-Documents-pikeme/00ddc158-6376-4024-ba10-455d2c7bceff/scratchpad/clubshot'
mkdirSync(OUT, { recursive: true })
try { rmSync(OUT + '/profile', { recursive: true, force: true }) } catch {}
setTimeout(() => { console.error('TIMEOUT — harness hung'); process.exit(2) }, 600000).unref?.()

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const CDP = Number(process.env.CDP_PORT || 9405)
const PROFILE = process.env.PROFILE || '/tmp/wffix1'

// The phone subset of _device-matrix.mjs DEVICES, at their REAL CSS viewports, plus the surfaces a
// fix must not regress. `safe` marks the synthetic run described below.
const DEVICES = [
  { id: 'iphone-17-pro', w: 844, h: 390, dpr: 3, kind: 'phone', label: "iPhone 17 Pro — Adam's device" },
  { id: 'galaxy-a15', w: 800, h: 360, dpr: 3, kind: 'phone', label: 'Galaxy A15 (shortest shipped)' },
  { id: 'galaxy-s24-ultra', w: 915, h: 412, dpr: 3, kind: 'phone', label: 'Galaxy S24 Ultra' },
  // SAFE-AREA STAND-IN. env(safe-area-inset-*) all resolve to 0px in headless Chrome, so a headless
  // run under-measures the notched phone. On a Dynamic Island iPhone held sideways iOS reports
  // 59px left/right and 21px bottom: against .subpage's 18px/20px fallbacks that is -82px of WIDTH
  // and -1px of height, and the WIDTH is what deepens the crop (a narrower side column wraps its
  // text). 844-82 = 762 x 389 reproduces exactly that content box without hacking the CSS.
  { id: 'iphone-17-pro-safearea', w: 762, h: 389, dpr: 3, kind: 'phone', label: 'iPhone 17 Pro w/ landscape safe area (762x389 stand-in)' },
  { id: 'ipad-pro-11', w: 1194, h: 834, dpr: 2, kind: 'tablet', label: 'iPad Pro 11"' },
  { id: 'galaxy-tab-s9', w: 1280, h: 800, dpr: 2, kind: 'tablet', label: 'Galaxy Tab S9' },
  { id: 'iphone-17-pro-port', w: 390, h: 844, dpr: 3, kind: 'portrait', label: 'iPhone 17 Pro PORTRAIT' },
  { id: 'ipad-pro-11-port', w: 834, h: 1194, dpr: 2, kind: 'portrait', label: 'iPad Pro 11" PORTRAIT' },
]

const ROLES = ['president', 'vice', 'senior', 'member']
const NAMES = ['אדם', 'יונתן', 'נועה', 'איתי', 'שירה', 'דניאל', 'מאיה', 'עומר', 'תמר', 'רון',
  'ליאור', 'אביב', 'יעל', 'גיא', 'הילה', 'אורי', 'שני', 'אלון', 'נטע', 'עידו',
  'רועי', 'ספיר', 'יובל', 'אמיר', 'טל', 'נדב', 'מיכל', 'אסף', 'דור', 'ענבר']

// Shaped to the REAL /handle-clubs/me contract (pikme-server routes-pikme/clubs.js). clubs.js bails
// on `!state.me.me`, so a fixture missing that field silently renders the offline hero instead.
const ME = {
  me: { id: 'u0', nickName: 'אדם' },
  maxMembers: 30, k: 3,
  metrics: [{ key: 'trophies', labelHe: 'הכי הרבה גביעים', unitHe: 'גביעים' }, { key: 'ranked', labelHe: 'דירוג', unitHe: 'דירוג' }, { key: 'goals', labelHe: 'הכי הרבה שערים', unitHe: 'שערים' }, { key: 'wins', labelHe: 'הכי הרבה נצחונות', unitHe: 'נצחונות' }, { key: 'cards', labelHe: 'הכי הרבה קלפים', unitHe: 'קלפים' }],
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
const FIND_ROWS = Array.from({ length: 8 }, (_, i) => ({
  id: 'f' + i, emblem: ['🏰', '⚡', '🦈', '🔥', '⭐', '🐉', '👑', '⚽'][i],
  name: ['נבחרת הצפון', 'אלופי חיפה', 'כוכבי רמת גן', 'אריות הדרום', 'הפועל שכונה', 'מכבי ילדים', 'ברק ירושלים', 'להבות פתח תקווה'][i],
  type: ['open', 'invite', 'closed'][i % 3], minTrophies: i * 300, count: 30 - i * 3,
  action: ['join', 'request', 'closed', 'locked', 'full'][i % 5], friendsInside: i % 3 ? 0 : 2,
}))

// ── the page-side measurement. Kept as one string so it runs identically for every view. ────────────
const MEASURE = `(() => {
  const rnd = n => Math.round(n * 10) / 10;
  const q = s => document.querySelector(s);
  const body = q('#clubs .subpage-body');
  if (!body) return { error: 'no .subpage-body' };
  const cs = e => getComputedStyle(e);
  const painted = e => { const s = cs(e); return s.display !== 'none' && s.visibility !== 'hidden' && +s.opacity !== 0 && e.getClientRects().length > 0; };
  // The CONTENT bottom of a box: border-box bottom minus border and (for a clipping box) nothing else
  // — padding-bottom is inside the clip, so a drop shadow living in the padding is still visible.
  const clipBottom = e => { const r = e.getBoundingClientRect(); return r.bottom - parseFloat(cs(e).borderBottomWidth || 0); };

  // Is this node CUT — i.e. painted past a boundary the USER cannot get past? Walk up: an ancestor
  // that scrolls (auto/scroll) means the content is merely below a fold and is reachable, so stop and
  // call it fine. An ancestor with overflow hidden/clip means amputation. The viewport is the last
  // boundary, and only counts if the page itself cannot scroll.
  const cutBy = (e) => {
    const b = e.getBoundingClientRect().bottom;
    for (let p = e.parentElement; p && p !== document.documentElement; p = p.parentElement) {
      const s = cs(p);
      const oy = s.overflowY, ox = s.overflowX;
      if (oy === 'visible' && ox === 'visible') continue;
      if (oy === 'auto' || oy === 'scroll') return null;              // reachable by scrolling
      const cb = clipBottom(p);
      if (b > cb + 1) return { by: (p.id ? '#' + p.id : '.' + String(p.className).trim().split(/\\s+/).join('.')), over: rnd(b - cb) };
      return null;                                                    // clipped, but inside the clip
    }
    const pg = document.scrollingElement;
    if (pg.scrollHeight <= pg.clientHeight + 1 && b > innerHeight + 1) return { by: 'viewport', over: rnd(b - innerHeight) };
    return null;
  };

  const cuts = [];
  for (const e of document.querySelectorAll('#clubs .subpage-body *')) {
    if (!painted(e)) continue;
    const r = e.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    const c = cutBy(e);
    if (c) cuts.push({ sel: (e.tagName.toLowerCase() + '.' + String(e.className).trim().split(/\\s+/).join('.')).slice(0, 46), text: (e.textContent || '').trim().slice(0, 18), h: rnd(r.height), bottom: rnd(r.bottom), over: c.over, by: c.by });
  }
  cuts.sort((a, b) => b.over - a.over);

  const boxOf = e => { if (!e) return null; const r = e.getBoundingClientRect(); return { w: rnd(r.width), h: rnd(r.height), x: rnd(r.x), y: rnd(r.y), bottom: rnd(r.bottom) }; };
  const grid = q('#clubs .club-2col'), side = q('#clubs .club-side'), main = q('#clubs .club-main');
  const pg = document.scrollingElement;
  const out = {
    vw: innerWidth, vh: innerHeight,
    page: { scrollW: pg.scrollWidth, clientW: pg.clientWidth, scrollH: pg.scrollHeight, clientH: pg.clientHeight },
    body: { ...boxOf(body), scrollH: body.scrollHeight, clientH: body.clientHeight, overflowY: cs(body).overflowY, display: cs(body).display },
    head: rnd(q('#clubs .subpage-head').getBoundingClientRect().height),
    bands: Object.fromEntries(['.subpage-head .builder-btn', '.club-hero', '.club-card', '.myscopes', '.myscope',
      '.club-actions', '.club-actions .club-cta', '.club-actions .club-ghost', '.club-side > .club-ghost:last-child',
      '.club-input', '.club-form', '.club-go', '.scope-tabs', '.emblem-row']
      .map(s => { const e = q('#clubs ' + s); return [s, e ? rnd(e.getBoundingClientRect().height) : null] })
      .filter(([, v]) => v != null)),
    headMb: cs(q('#clubs .subpage-head')).marginBottom,
    pad: cs(q('#clubs .subpage')).padding,
    split: body.classList.contains('club-split'),
    cuts: cuts.slice(0, 8), cutCount: cuts.length,
  };
  if (grid) {
    out.grid = { ...boxOf(grid), rows: cs(grid).gridTemplateRows, cols: cs(grid).gridTemplateColumns };
    out.side = { ...boxOf(side), scrollH: side.scrollHeight, clientH: side.clientHeight, overflowY: cs(side).overflowY };
    out.main = { ...boxOf(main), scrollH: main.scrollHeight, clientH: main.clientHeight, overflowY: cs(main).overflowY };
    out.sideKids = [...side.children].map(e => ({ cls: String(e.className).split(' ')[0], h: rnd(e.getBoundingClientRect().height) }));
    out.sideNeed = rnd([...side.children].reduce((s, e) => s + e.getBoundingClientRect().height, 0) + (side.children.length - 1) * parseFloat(cs(side).rowGap || 0) + parseFloat(cs(side).paddingBottom || 0));
    out.actionsInSide = !!side.querySelector('.club-actions');
  } else {
    const kids = [...body.children];
    out.kids = kids.map(e => ({ cls: String(e.className).split(' ')[0], h: rnd(e.getBoundingClientRect().height), bottom: rnd(e.getBoundingClientRect().bottom) }));
    out.belowFold = rnd(Math.max(0, ...kids.map(e => e.getBoundingClientRect().bottom)) - innerHeight);
  }
  return out;
})()`

// Reachability, proved with a real gesture rather than a scrollTop poke (which moves an
// overflow:hidden box and therefore proves nothing).
const REACH = `(() => {
  const rnd = n => Math.round(n * 10) / 10;
  const body = document.querySelector('#clubs .subpage-body');
  const main = document.querySelector('#clubs .club-main');
  const form = document.querySelector('#clubs .subpage-body > .club-form');
  const pick = [['body', body], ['main', main], ['form', form]].filter(([, e]) => e);
  return Object.fromEntries(pick.map(([k, e]) => [k, { top: rnd(e.scrollTop), max: rnd(e.scrollHeight - e.clientHeight) }]));
})()`

async function main() {
  rmSync(PROFILE, { recursive: true, force: true })
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${CDP}`, '--headless=new', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${PROFILE}`, '--disable-gpu', '--hide-scrollbars', '--window-size=1400,1100', 'about:blank',
  ], { stdio: 'ignore' })
  process.on('exit', () => { try { chrome.kill() } catch {} })

  let target
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(250)
    try { target = (await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()).find(t => t.type === 'page') } catch {}
  }
  if (!target) { chrome.kill(); throw new Error('chrome never came up') }

  const { WebSocket } = await import('ws')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise(r => ws.on('open', r))
  let id = 0
  const pending = new Map()
  const send = (method, params = {}) => new Promise(res => { pending.set(++id, res); ws.send(JSON.stringify({ id, method, params })) })
  ws.on('message', d => { const m = JSON.parse(d.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id) } })
  const evalJs = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }))?.result?.value

  await send('Page.enable'); await send('Runtime.enable')
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      const ME = ${JSON.stringify(ME)};
      const FIND = ${JSON.stringify(FIND_ROWS)};
      window.__noclub = false;
      const real = window.fetch;
      const json = (o) => Promise.resolve(new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      window.fetch = (u, o) => {
        const s = String(u);
        if (s.includes('/clubs/me')) return json(window.__noclub ? Object.assign({}, ME, { club: null }) : ME);
        if (s.includes('/clubs/find')) return json({ myTrophies: 4200, rows: FIND });
        if (s.includes('/clubs/board')) return json({ rows: [], k: 3, totalRanked: 0 });
        return real(u, o);
      };
      window.PIKME_FOOTBALL_TOKEN = 'harness';
    })()`,
  })

  const WANT_VIEWS = (process.env.VIEWS || 'myclub,find,noclub,create').split(',')
  const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null
  const results = []
  const shot = async (name) => {
    const s = await send('Page.captureScreenshot', { format: 'png' })
    if (s?.data) writeFileSync(`${OUT}/${name}.png`, Buffer.from(s.data, 'base64'))
  }

  for (const d of DEVICES) {
    if (ONLY && !ONLY.includes(d.id)) continue
    console.error(`\n=== ${d.label} — ${d.w}x${d.h} @${d.dpr}x ===`)
    await send('Emulation.setDeviceMetricsOverride', { width: d.w, height: d.h, deviceScaleFactor: d.dpr, mobile: true })
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?ftoken=harness` })
    await sleep(2600)
    await evalJs(`(() => { document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden')); document.getElementById('clubs').classList.remove('hidden'); })()`)
    await sleep(900)

    for (const view of WANT_VIEWS) {
      if (view === 'myclub') {
        await evalJs(`(() => { window.__noclub = false; const c = document.getElementById('clubs'); c.classList.add('hidden'); c.classList.remove('hidden'); })()`)
        await sleep(1100)
      } else if (view === 'find') {
        const ok = await evalJs(`(() => { const b = document.querySelector('#clubs .club-actions .club-cta') || document.querySelector('#clubs .club-side .club-cta'); if (!b) return false; b.click(); return true; })()`)
        if (!ok) { console.error('  !! could not reach find'); continue }
        await sleep(1200)
      } else if (view === 'noclub') {
        await evalJs(`(() => { window.__noclub = true; const c = document.getElementById('clubs'); c.classList.add('hidden'); c.classList.remove('hidden'); })()`)
        await sleep(1300)
      } else if (view === 'create') {
        // reachable only from the no-club landing: hero, [find], [create]
        const ok = await evalJs(`(() => { const b = [...document.querySelectorAll('#clubs .club-side .club-cta, #clubs .subpage-body > .club-cta')].pop(); if (!b) return false; b.click(); return true; })()`)
        if (!ok) { console.error('  !! could not reach create'); continue }
        await sleep(900)
      }

      const m = await evalJs(MEASURE)
      // Real-gesture reachability: three wheel ticks over the middle of the panel.
      await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: Math.round(d.w / 2), y: Math.round(d.h / 2), deltaX: 0, deltaY: 600, pointerType: 'mouse' })
      await sleep(120)
      await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: Math.round(d.w / 2), y: Math.round(d.h / 2), deltaX: 0, deltaY: 600, pointerType: 'mouse' })
      await sleep(250)
      const reach = await evalJs(REACH)
      const pageAfter = await evalJs('({ y: Math.round(scrollY), bodyTop: Math.round((document.querySelector("#clubs .subpage-body")||{scrollTop:0}).scrollTop) })')
      await evalJs(`(() => { document.querySelectorAll('#clubs .subpage-body, #clubs .club-main, #clubs .club-side, #clubs .subpage-body > .club-form').forEach(e => e && (e.scrollTop = 0)); scrollTo(0,0); })()`)
      await sleep(120)
      await shot(`${d.id}-${view}`)
      results.push({ device: d.id, kind: d.kind, w: d.w, h: d.h, view, m, reach, pageAfter })

      const tag = `${d.id}/${view}`
      const fails = []
      if (m.error) fails.push(m.error)
      else {
        if (m.page.scrollW > m.page.clientW + 1) fails.push(`page scrolls sideways (${m.page.scrollW} > ${m.page.clientW})`)
        if (m.page.scrollH > m.page.clientH + 1) fails.push(`page itself scrolls (${m.page.scrollH} > ${m.page.clientH})`)
        if (m.cutCount) fails.push(`${m.cutCount} node(s) CUT — worst ${m.cuts[0].sel} "${m.cuts[0].text}" by ${m.cuts[0].over}px (${m.cuts[0].by})`)
        if (m.side) {
          if (m.side.scrollH > m.side.clientH + 1) fails.push(`.club-side does not FIT (scrollH ${m.side.scrollH} > clientH ${m.side.clientH})`)
          if (m.side.bottom > m.body.bottom + 1) fails.push(`.club-side hangs past .subpage-body (${m.side.bottom} > ${m.body.bottom})`)
          if (d.kind !== 'portrait' && !['auto', 'scroll'].includes(m.main.overflowY)) fails.push(`.club-main is not the scroller (${m.main.overflowY})`)
          if (d.kind !== 'portrait' && m.main.w < m.side.w) fails.push(`roster column narrower than the side column`)
          if (view === 'myclub' && !m.actionsInSide) fails.push('actions are not in the side column')
        }
        // Anything below the fold must be REACHABLE. If a real wheel moved nothing and content
        // exceeds its box, the content is amputated no matter what the overflow property says.
        const stuck = Object.entries(reach).filter(([, v]) => v.max > 2 && v.top === 0)
        if (stuck.length && pageAfter.y === 0) fails.push(`content below the fold did not move on a real wheel: ${stuck.map(([k, v]) => k + ' max ' + v.max).join(', ')}`)
      }
      const grid = m.grid ? ` grid ${m.grid.rows}` : ''
      console.error(`  ${fails.length ? '❌' : '✅'} ${view.padEnd(7)} body ${m.body?.h}h scrollH ${m.body?.scrollH} · side ${m.side ? m.side.h + 'h need ' + m.sideNeed : '—'}${grid}`)
      fails.forEach(f => console.error(`       · ${f}`))
      results[results.length - 1].fails = fails
    }
  }

  writeFileSync(`${OUT}/report.json`, JSON.stringify(results, null, 2))
  const bad = results.filter(r => r.fails?.length)
  console.log(JSON.stringify(results.map(r => ({
    device: r.device, view: r.view, size: `${r.w}x${r.h}`,
    avail: r.m.body?.h, need: r.m.sideNeed ?? null, sideH: r.m.side?.h ?? null,
    bodyScrollH: r.m.body?.scrollH, bodyClientH: r.m.body?.clientH, bodyOverflow: r.m.body?.overflowY,
    head: r.m.head, pad: r.m.pad, cuts: r.m.cutCount, worst: r.m.cuts?.[0] || null, bands: r.m.bands,
    sideKids: r.m.sideKids || r.m.kids, belowFold: r.m.belowFold, reach: r.reach,
    fails: r.fails,
  })), null, 2))
  console.error(`\nshots -> ${OUT}`)
  console.error(bad.length ? `\n❌ ${bad.length} FAILING (device,view) PAIRS: ` + bad.map(b => b.device + '/' + b.view).join(', ')
    : `\n✅ every device/view clean (${results.length} pairs)`)
  ws.close(); chrome.kill()
  process.exit(bad.length ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(1) })
