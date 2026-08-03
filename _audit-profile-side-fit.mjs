/* AUDIT: WHY ADAM STILL CANNOT SEE THE CLUBS + TROPHIES/RANKED BLOCK ON THE PROFILE PAGE.
 *
 * Two fixes already landed and are NOT re-litigated here:
 *   (a) .pf-side was overflow:hidden → it now has overflow-y:auto        (public/profile.js)
 *   (b) a 250ms timer race orphaned the block → a childList+subtree
 *       MutationObserver now re-injects on every repaint                  (public/clubs.js)
 *
 * ⚠️ HEADLINE #1 — FIX (b) DID NOT CLOSE THE RACE, IT MOVED IT. Measured below, 4/4 viewports:
 * the block is built exactly ONCE and appended into a `.pf-side` that renderProfile HAS ALREADY
 * REPLACED — `parent.isConnected === false` — and nothing ever retries. No amount of pane
 * compaction can show a block that is not in the document. This defect is LIVE IN PROD.
 *
 *   clubs.js injectInto():
 *       const host = $('.pf-side')            ← pane node captured HERE
 *       const p = await api('/player/'+id)    ← ...then awaits the network
 *       host.appendChild(block)               ← ...appends to the node captured BEFORE the await
 *   profile.js renderProfile(): `root.innerHTML = ''` then builds a BRAND NEW .pf-side.
 *   injectMyClubs() holds `_myClubsBusy = true` for the whole duration of that await, so the
 *   MutationObserver callback belonging to that very repaint — the thing fix (b) added — hits
 *   `if (_myClubsBusy) return` and no-ops. The two guards cancel each other out.
 *
 * ⚠️ OBSERVER-EFFECT WARNING. This bug is destroyed by heavy instrumentation. An earlier version of
 * this harness logged inside the MutationObserver callback and inside the /player/ fetch stub; those
 * extra microtasks reordered the repaint and the block came out PRESENT in 6/6 cases — a false PASS.
 * The probe here is ONE synchronous `push(this.isConnected)` inside appendChild and nothing else.
 * Do not add awaits, querySelector calls or logging to it. For the same reason
 * `_profile-clubs-race.mjs` reports PASS: its stats stub answers after a `setTimeout` MACROTASK.
 * Remove that macrotask and the identical code fails.
 *
 * ⚠️ FORCING THE BLOCK IN. To measure geometry at all, the harness must inject the block, since the
 * product loses it. It toggles a dummy CLASS on #profile — NOT a data-attribute: clubs.js observes
 * `attributeFilter: ['class']`, so a `data-*` poke fires nothing (that mistake produced a whole run
 * of false "structural" verdicts here). The toggle always succeeds, which is itself the proof that
 * the loss is purely a race and nothing structural.
 *
 * ⚠️ TWO CODE STATES ARE MEASURED, because public/profile.js is being edited concurrently by another
 * agent and the two states answer different questions:
 *   HEAD  = git HEAD == the LIVE PROD bytes (sha verified in Q6) == what Adam's phone runs today.
 *           Served by CDP request interception, so nothing on disk is touched.
 *   TREE  = the current working tree, i.e. the sibling agent's in-progress compaction.
 *
 * WHAT THIS MEASURES
 *   Q0  the injection loss: appended-into-detached count            (minimal perturbation)
 *   Q1  what consumes .pf-side's height, child by child, per viewport, WITH .pf-clubs present
 *   Q2  the EXACT px overflow = the minimum that must be reclaimed for zero-scroll
 *   Q3  px saved by each candidate trim, measured by applying it and re-reading scrollHeight
 *   Q4  anything OTHER than height that could hide the block (ancestor overflow/clip/transform/
 *       z-index/filter/safe-area insets/zero-height render)
 *   Q5  is .pf-side genuinely finger-scrollable — real touch events, does scrollTop move
 *   Q6  do the LIVE PROD bytes contain fixes (a) and (b), and do they match HEAD
 *
 * READ-ONLY on product code. Q3 overrides are harness-injected <style> tags that are removed again.
 *
 * Run: node _audit-profile-side-fit.mjs [port]        # default 3016
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = process.argv[2] || '3016'
const OUT = '/private/tmp/claude-501/-Users-adamleeperelman-Documents-pikeme/24a0f464-af08-4018-9ddf-e3fad2a0324f/scratchpad/sidefit'
mkdirSync(OUT, { recursive: true })
try { rmSync(OUT + '/prof', { recursive: true, force: true }) } catch {}
setTimeout(() => { console.error('TIMEOUT'); process.exit(2) }, 1500000).unref?.()

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const CDP = 9461
// The BASELINE is the LIVE PROD bytes, fetched over HTTP — not `git show HEAD`. HEAD is not a stable
// reference here: the sibling agent committed the compaction fix mid-run of an earlier pass of this
// harness, which silently turned the "before" arm into an "after" arm. Prod is what Adam's phone
// actually runs, and it is the only baseline that cannot move underneath the measurement.
// Verified for this run: public/clubs.js and public/clubs.css are byte-identical prod↔worktree
// (sha256 a83efcb6… and e9285546…), so profile.js is the ONLY file that differs.
const PROD_PROFILE_JS = Buffer.from(
  await (await fetch('https://pikme-football.onrender.com/profile.js')).arrayBuffer())

const VIEWPORTS = [
  { name: '800x360  Galaxy A15 (shortest)', w: 800, h: 360, dpr: 3 },
  { name: '844x390  iPhone 14/15/16', w: 844, h: 390, dpr: 3 },
  { name: '932x430  iPhone Pro Max', w: 932, h: 430, dpr: 3 },
  { name: '1194x834 iPad', w: 1194, h: 834, dpr: 2 },
]

// Q3 candidates, run against the HEAD baseline only. Each applied ALONE then removed.
const CANDIDATES = [
  { id: 'hero-137to110', ugly: 'very low', why: 'hero canvas 137 → 110px',
    css: '.pf-side > .pf-hero-canvas { height: 110px !important; width: 106px !important; }' },
  { id: 'hero-137to96', ugly: 'low', why: 'hero canvas 137 → 96px',
    css: '.pf-side > .pf-hero-canvas { height: 96px !important; width: 92px !important; }' },
  { id: 'slots-34to26', ugly: 'low', why: 'power slots 34 → 26px, margin-top 4 → 0',
    css: '.pf-side .pf-slot { width: 26px !important; height: 26px !important; } .pf-side-slots { margin-top: 0 !important; }' },
  { id: 'slots-hidden', ugly: 'HIGH (drops a feature)', why: 'power-slots row removed from the pane',
    css: '.pf-side-slots { display: none !important; }' },
  { id: 'gap-4to2', ugly: 'none', why: '.pf-side flex gap 4 → 2px',
    css: '.pf-side { gap: 2px !important; }' },
  { id: 'pad-10to6', ugly: 'none', why: '.pf-side padding-block 10 → 6px',
    css: '.pf-side { padding-top: 6px !important; padding-bottom: 6px !important; }' },
  { id: 'clubs-mt10to2-gap7to4', ugly: 'none', why: '.pf-clubs margin-top 10 → 2, gap 7 → 4',
    css: '.pf-side .pf-clubs { margin-top: 2px !important; gap: 4px !important; }' },
  { id: 'myscope-pad8to3', ugly: 'none', why: '.myscope padding 8px 4px → 3px 3px',
    css: '.pf-side .myscope { padding: 3px 3px !important; }' },
  { id: 'myscope-em18to12', ugly: 'low', why: '.myscope emoji 18 → 12px',
    css: '.pf-side .myscope .em { font-size: 12px !important; }' },
  { id: 'pcrank-pad9to3', ugly: 'none', why: '.pc-rank padding 9px 6px → 3px 4px',
    css: '.pf-side .pc-rank { padding: 3px 4px !important; }' },
  { id: 'pcrank-b20to13', ugly: 'low', why: '.pc-rank number 20 → 13px',
    css: '.pf-side .pc-rank b { font-size: 13px !important; }' },
  { id: 'pcsec-hidden', ugly: 'medium (drops "מועדון ושיוך")', why: 'the .pc-sec heading row removed',
    css: '.pf-side .pc-sec { display: none !important; }' },
  { id: 'myscopes-2col', ugly: 'medium (2 rows of 2)', why: '.myscopes 4-col → 2-col',
    css: '.pf-side .myscopes { grid-template-columns: 1fr 1fr !important; }' },
  { id: 'board2-hidden', ugly: 'medium (drops "מקום N מתוך M")', why: 'the second .pf-board line removed',
    css: '.pf-side .pf-board ~ .pf-board { display: none !important; }' },
  { id: 'trophies+board-lineheight', ugly: 'none', why: '.pf-trophies/.pf-board line-height 1.1',
    css: '.pf-side .pf-trophies, .pf-side .pf-board { line-height: 1.1 !important; }' },
  { id: 'badge-pad3to1', ugly: 'none', why: '.pf-badge padding 3px 7px → 1px 6px',
    css: '.pf-side .pf-badge { padding: 1px 6px !important; }' },
  { id: 'COMBO-tier1-zero-ugliness', ugly: 'NONE — whitespace only', why: 'COMBO: gap 4→2, pad 10→6, badge pad, line-heights, clubs mt/gap, myscope pad, pc-rank pad',
    css: `.pf-side { gap: 2px !important; padding-top: 6px !important; padding-bottom: 6px !important; }
          .pf-side .pf-badge { padding: 1px 6px !important; }
          .pf-side .pf-trophies, .pf-side .pf-board { line-height: 1.1 !important; }
          .pf-side .pf-clubs { margin-top: 2px !important; gap: 4px !important; }
          .pf-side .myscope { padding: 3px 3px !important; }
          .pf-side .pc-rank { padding: 3px 4px !important; }` },
  { id: 'COMBO-tier1+fontsizes', ugly: 'low', why: 'COMBO tier1 + myscope emoji 12 + pc-rank number 13 + pc-sec 11',
    css: `.pf-side { gap: 2px !important; padding-top: 6px !important; padding-bottom: 6px !important; }
          .pf-side .pf-badge { padding: 1px 6px !important; }
          .pf-side .pf-trophies, .pf-side .pf-board { line-height: 1.1 !important; }
          .pf-side .pf-clubs { margin-top: 2px !important; gap: 4px !important; }
          .pf-side .myscope { padding: 3px 3px !important; } .pf-side .myscope .em { font-size: 12px !important; }
          .pf-side .pc-rank { padding: 3px 4px !important; } .pf-side .pc-rank b { font-size: 13px !important; }
          .pf-side .pc-sec { font-size: 11px !important; }` },
  { id: 'COMBO-tier1+fonts+hero110+slots26', ugly: 'low', why: 'COMBO above + hero 110 + slots 26',
    css: `.pf-side { gap: 2px !important; padding-top: 6px !important; padding-bottom: 6px !important; }
          .pf-side .pf-badge { padding: 1px 6px !important; }
          .pf-side .pf-trophies, .pf-side .pf-board { line-height: 1.1 !important; }
          .pf-side .pf-clubs { margin-top: 2px !important; gap: 4px !important; }
          .pf-side .myscope { padding: 3px 3px !important; } .pf-side .myscope .em { font-size: 12px !important; }
          .pf-side .pc-rank { padding: 3px 4px !important; } .pf-side .pc-rank b { font-size: 13px !important; }
          .pf-side .pc-sec { font-size: 11px !important; }
          .pf-side > .pf-hero-canvas { height: 110px !important; width: 106px !important; }
          .pf-side .pf-slot { width: 26px !important; height: 26px !important; } .pf-side-slots { margin-top: 0 !important; }` },
  { id: 'COMBO-...+slots-hidden', ugly: 'HIGH (drops the slots strip)', why: 'COMBO above but the slots row removed entirely',
    css: `.pf-side { gap: 2px !important; padding-top: 6px !important; padding-bottom: 6px !important; }
          .pf-side .pf-badge { padding: 1px 6px !important; }
          .pf-side .pf-trophies, .pf-side .pf-board { line-height: 1.1 !important; }
          .pf-side .pf-clubs { margin-top: 2px !important; gap: 4px !important; }
          .pf-side .myscope { padding: 3px 3px !important; } .pf-side .myscope .em { font-size: 12px !important; }
          .pf-side .pc-rank { padding: 3px 4px !important; } .pf-side .pc-rank b { font-size: 13px !important; }
          .pf-side .pc-sec { font-size: 11px !important; }
          .pf-side > .pf-hero-canvas { height: 110px !important; width: 106px !important; }
          .pf-side-slots { display: none !important; }` },
]

// Injected before any page script. Stubs every API in-page and delivers the socket `welcome` the game
// needs, exactly as _profile-clubs-race.mjs does. The ONLY instrumentation is one synchronous
// isConnected push — see the observer-effect warning above.
const STUB = `(() => {
  window.SALTIZ_CARDS = [{ r:'legendary', n:5, c:1, w:900 },{ r:'epic', n:2, c:2, w:400 },{ r:'rare', n:7, c:3, w:120 }];
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
  // REALISTIC label lengths — a short stub would understate the strip's height.
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
    if (url.includes('/dev/progress') || url.includes('/handle-friends/rank')) return json({ xp: 4200, level: 9, rankPoints: 340, wins: 13, losses: 6, draws: 2 });
    if (url.includes('/handle-friends')) return json([]);
    return rf(u, o);
  };
})()`

const MEASURE = `(() => {
  const side = document.querySelector('.pf-side');
  if (!side) return { err: 'no .pf-side' };
  const cs = getComputedStyle(side);
  const gap = parseFloat(cs.rowGap) || 0;
  const padT = parseFloat(cs.paddingTop) || 0, padB = parseFloat(cs.paddingBottom) || 0;
  const kids = [...side.children].map((k) => {
    const s = getComputedStyle(k), r = k.getBoundingClientRect();
    const mt = parseFloat(s.marginTop) || 0, mb = parseFloat(s.marginBottom) || 0;
    return { tag: k.tagName.toLowerCase(), cls: k.className || '(none)',
      h: Math.round(r.height * 10) / 10, mt, mb, marginBox: Math.round((r.height + mt + mb) * 10) / 10 };
  });
  const b = side.querySelector('.pf-clubs');
  const sr = side.getBoundingClientRect();
  let block = null;
  if (b) {
    const br = b.getBoundingClientRect();
    block = { offsetH: b.offsetHeight, topWithinPane: Math.round(br.top - sr.top),
      hiddenBelowFold: Math.max(0, Math.round(br.bottom - sr.bottom)), zeroHeight: br.height < 1,
      childHeights: [...b.children].map(c => ({ cls: c.className, h: Math.round(c.getBoundingClientRect().height * 10) / 10,
        mt: parseFloat(getComputedStyle(c).marginTop) || 0 })),
      hitTestTop: (() => { const e = document.elementFromPoint(br.left + br.width / 2, br.top + 4);
        return e ? (e.className || e.tagName) : null; })() };
  }
  return { innerH: innerHeight,
    pane: { clientH: side.clientHeight, scrollH: side.scrollHeight, rectW: Math.round(sr.width * 10) / 10,
      gap, padT, padB, overflowPx: Math.max(0, side.scrollHeight - side.clientHeight), overflowY: cs.overflowY },
    kids, block,
    sumMarginBoxes: Math.round(kids.reduce((a, k) => a + k.marginBox, 0) * 10) / 10,
    gapsTotal: Math.max(0, kids.length - 1) * gap };
})()`

const AUDIT_HIDING = `(() => {
  const side = document.querySelector('.pf-side');
  const b = side && side.querySelector('.pf-clubs');
  const chain = []; let n = side;
  while (n && n !== document.documentElement) {
    const s = getComputedStyle(n), r = n.getBoundingClientRect();
    chain.push({ sel: (n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') +
        (n.className && typeof n.className === 'string' ? '.' + n.className.trim().split(/\\s+/).join('.') : '')).slice(0, 24),
      overflowX: s.overflowX, overflowY: s.overflowY, clipPath: s.clipPath, transform: s.transform,
      filter: s.filter, zIndex: s.zIndex, position: s.position, opacity: s.opacity, visibility: s.visibility,
      contain: s.contain, h: Math.round(r.height), clientH: n.clientHeight, scrollH: n.scrollHeight });
    n = n.parentElement;
  }
  const wrap = document.querySelector('.pf-wrap');
  const ws = wrap && getComputedStyle(wrap);
  const resolved = ws ? [ws.paddingTop, ws.paddingRight, ws.paddingBottom, ws.paddingLeft].join(' ') : null;
  let notched = null;
  if (wrap) {
    // profile.js uses max(10px, var(--sa-*, env(safe-area-inset-*))). Headless env() is 0, so simulate
    // a notched iPhone the way _iphone.html does and see what the pane actually loses.
    const root = document.documentElement;
    root.style.setProperty('--sa-top', '0px'); root.style.setProperty('--sa-right', '59px');
    root.style.setProperty('--sa-bottom', '21px'); root.style.setProperty('--sa-left', '59px');
    const w2 = getComputedStyle(wrap), s2 = document.querySelector('.pf-side');
    notched = { pad: [w2.paddingTop, w2.paddingRight, w2.paddingBottom, w2.paddingLeft].join(' '),
      paneClientH: s2.clientHeight, paneScrollH: s2.scrollHeight,
      overflowPx: Math.max(0, s2.scrollHeight - s2.clientHeight) };
    for (const k of ['--sa-top','--sa-right','--sa-bottom','--sa-left']) root.style.removeProperty(k);
  }
  return { chain, wrapPadding: resolved, notchedSim: notched,
    blockRect: b ? (() => { const r = b.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height),
        insideViewport: r.top >= 0 && r.bottom <= innerHeight }; })() : null };
})()`

async function main() {
  const chrome = spawn(CHROME, [`--remote-debugging-port=${CDP}`, '--headless=new', '--no-first-run',
    `--user-data-dir=${OUT}/prof`, 'about:blank'], { stdio: 'ignore' })
  let t
  for (let i = 0; i < 40 && !t; i++) { await sleep(250); try { t = (await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()).find(x => x.type === 'page') } catch {} }
  if (!t) { chrome.kill(); throw new Error('chrome never came up') }
  const { WebSocket } = await import('ws')
  const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise(r => ws.on('open', r))
  let id = 0; const pend = new Map()
  const send = (m, p = {}) => new Promise(r => { pend.set(++id, r); ws.send(JSON.stringify({ id, method: m, params: p })) })
  // SERVE HEAD's profile.js by interception when serveHead is on — nothing on disk is touched.
  let serveProd = false
  ws.on('message', d => {
    const m = JSON.parse(d.toString())
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); return }
    if (m.method === 'Fetch.requestPaused') {
      const rid = m.params.requestId
      if (serveProd && /\/profile\.js(\?|$)/.test(m.params.request.url)) {
        send('Fetch.fulfillRequest', { requestId: rid, responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'text/javascript; charset=utf-8' },
            { name: 'Cache-Control', value: 'no-store' }],
          body: PROD_PROFILE_JS.toString('base64') })
      } else send('Fetch.continueRequest', { requestId: rid })
    }
  })
  await send('Page.enable'); await send('Runtime.enable')
  await send('Fetch.enable', { patterns: [{ urlPattern: '*profile.js*', requestStage: 'Request' }] })
  await send('Page.addScriptToEvaluateOnNewDocument', { source: STUB })
  const evl = async (e) => (await send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: e }))?.result?.value

  // Force the block in: toggle a dummy CLASS (attributeFilter is ['class'] — data-* fires nothing).
  const force = async () => {
    for (let i = 0; i < 8; i++) {
      if (await evl(`!!document.querySelector('.pf-side .pf-clubs')`)) return true
      await evl(`(() => { const p = document.getElementById('profile');
        if (p) { p.classList.add('audit-poke'); p.classList.remove('audit-poke'); } return true; })()`)
      await sleep(600)
    }
    return await evl(`!!document.querySelector('.pf-side .pf-clubs')`)
  }

  const report = []
  for (const V of VIEWPORTS) {
    for (const VARIANT of ['PROD (Adam\'s phone today)', 'FIXED (committed 32927fb)']) {
      serveProd = VARIANT.startsWith('PROD')
      await send('Emulation.setDeviceMetricsOverride', { width: V.w, height: V.h, deviceScaleFactor: V.dpr, mobile: true })
      await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
      await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?ftoken=harness&cb=${V.w}x${V.h}-${serveProd ? 'prod' : 'tree'}` })
      await sleep(6500)
      await evl(`document.getElementById('home-face')?.click()`)
      await sleep(3000)

      const servedIsProd = await evl(`(() => { const st = document.getElementById('pf-css');
        return st ? !/@media \\(max-height/.test(st.textContent) : null; })()`)
      const loss = await evl(`(() => ({
        clubsInDoc: !!document.querySelector('.pf-side .pf-clubs'),
        appends: (window.__ap || []).length,
        connectedFlags: (window.__ap || []).slice(),
        appendedDetached: (window.__ap || []).filter(x => x === false).length }))()`)
      const forced = await force()
      const base = await evl(MEASURE)
      if (base?.err) { console.log(`\n### ${V.name} / ${VARIANT}\n  ERROR: ${base.err}`); continue }
      const hide = await evl(AUDIT_HIDING)

      // Q3 only against the HEAD baseline — TREE already implements a combo of its own.
      const savings = []
      if (serveProd) {
        for (const c of CANDIDATES) {
          await evl(`(() => { let s = document.getElementById('__audit_ovr');
            if (!s) { s = document.createElement('style'); s.id = '__audit_ovr'; document.head.appendChild(s); }
            s.textContent = ${JSON.stringify(c.css)}; return true; })()`)
          await sleep(200)
          const m = await evl(`(() => { const s = document.querySelector('.pf-side');
            const b = s.querySelector('.pf-clubs'), sr = s.getBoundingClientRect();
            return { scrollH: s.scrollHeight, overflowPx: Math.max(0, s.scrollHeight - s.clientHeight),
              blockFits: b ? (b.getBoundingClientRect().bottom <= sr.bottom + 1) : null }; })()`)
          savings.push({ ...c, saved: base.pane.scrollH - m.scrollH, after: m })
          await evl(`document.getElementById('__audit_ovr')?.remove()`)
          await sleep(110)
        }
      }

      // Q5 — real touch, now that there IS something to scroll
      const rect = await evl(`(() => { const r = document.querySelector('.pf-side').getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`)
      await evl(`document.querySelector('.pf-side').scrollTop = 0`)
      const tp = (y) => [{ x: rect.x, y, radiusX: 12, radiusY: 12, force: 1, id: 1 }]
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: tp(rect.y + 60) })
      for (let dy = 10; dy <= 120; dy += 10) { await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: tp(rect.y + 60 - dy) }); await sleep(16) }
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await sleep(700)
      const afterRaw = await evl(`document.querySelector('.pf-side').scrollTop`)
      await evl(`document.querySelector('.pf-side').scrollTop = 0`)
      await send('Input.synthesizeScrollGesture', { x: rect.x, y: rect.y, xDistance: 0, yDistance: -140, gestureSourceType: 'touch', speed: 800 })
      await sleep(900)
      const afterFling = await evl(`document.querySelector('.pf-side').scrollTop`)
      const progMax = await evl(`(() => { const s = document.querySelector('.pf-side'); s.scrollTop = 9999; return s.scrollTop; })()`)
      const atBottom = await evl(`(() => { const s = document.querySelector('.pf-side'); s.scrollTop = 9999;
        const b = s.querySelector('.pf-clubs'); if (!b) { s.scrollTop = 0; return null; }
        const sr = s.getBoundingClientRect(), br = b.getBoundingClientRect();
        const r = { fullyVisible: br.top >= sr.top - 1 && br.bottom <= sr.bottom + 1,
          clippedPx: Math.max(0, Math.round(br.bottom - sr.bottom)) + Math.max(0, Math.round(sr.top - br.top)) };
        s.scrollTop = 0; return r; })()`)
      const touch = { afterRaw, afterFling, progMax, atBottom }

      report.push({ V, VARIANT, loss, forced, base, hide, savings, touch })

      console.log(`\n\n═══════════════════════════════════════════════════════════════════════════════════`)
      console.log(`### ${V.name}   ·   ${VARIANT}   (innerHeight=${base.innerH})`)
      console.log(`═══════════════════════════════════════════════════════════════════════════════════`)
      console.log(`  variant sanity check — injected CSS has NO max-height media query (i.e. these are the PROD bytes): ${servedIsProd}`)
      console.log(`  Q0 INJECTION as the product actually behaves (unforced):`)
      console.log(`     .pf-clubs in document = ${loss.clubsInDoc ? '✅ PRESENT' : '❌ MISSING'}   appends=${loss.appends}` +
        `   appended-into-DETACHED-pane=${loss.appendedDetached}   parent.isConnected=${JSON.stringify(loss.connectedFlags)}`)
      console.log(`     forced in by a class-toggle poke: ${forced ? 'YES → the loss is PURELY a race, nothing structural' : 'NO → structural'}`)
      console.log(`\n  .pf-side  clientH=${base.pane.clientH}  scrollH=${base.pane.scrollH}  OVERFLOW=${base.pane.overflowPx}px` +
        `   width=${base.pane.rectW}  overflow-y=${base.pane.overflowY}   padding ${base.pane.padT}/${base.pane.padB}   gap ${base.pane.gap}px`)
      console.log(`\n  Q1 WHAT CONSUMES THE PANE (direct children, top → bottom):`)
      console.log(`  ${'child'.padEnd(20)} ${'h'.padStart(7)} ${'mt'.padStart(4)} ${'mb'.padStart(4)} ${'marginBox'.padStart(10)}`)
      for (const k of base.kids) console.log(`  ${(k.cls === '(none)' ? k.tag : k.cls).slice(0, 20).padEnd(20)} ${String(k.h).padStart(7)} ${String(k.mt).padStart(4)} ${String(k.mb).padStart(4)} ${String(k.marginBox).padStart(10)}`)
      console.log(`  ${'— children total'.padEnd(20)}${' '.repeat(18)}${String(base.sumMarginBoxes).padStart(10)}`)
      console.log(`  ${`+ gaps (${base.pane.gap}×${Math.max(0, base.kids.length - 1)})`.padEnd(20)}${' '.repeat(18)}${String(base.gapsTotal).padStart(10)}`)
      console.log(`  ${'+ padding'.padEnd(20)}${' '.repeat(18)}${String(base.pane.padT + base.pane.padB).padStart(10)}`)
      console.log(`  ${'= scrollHeight'.padEnd(20)}${' '.repeat(18)}${String(base.pane.scrollH).padStart(10)}   vs clientH ${base.pane.clientH}`)
      if (base.block) {
        console.log(`\n  .pf-clubs: offsetH=${base.block.offsetH}  starts ${base.block.topWithinPane}px into the pane` +
          ` → ${base.block.hiddenBelowFold}px BELOW THE FOLD   zeroHeight=${base.block.zeroHeight}`)
        for (const c of base.block.childHeights) console.log(`     ${c.cls.padEnd(11)} h=${String(c.h).padStart(6)}  mt=${c.mt}`)
        console.log(`     elementFromPoint at its top edge → ${base.block.hitTestTop}`)
      }
      console.log(`\n  Q2 MINIMUM PX TO RECLAIM FOR ZERO SCROLLING: ${base.pane.overflowPx}px`)
      if (savings.length) {
        console.log(`\n  Q3 CANDIDATE SAVINGS (each applied alone, measured against this baseline):`)
        console.log(`  ${'saved'.padStart(6)} ${'residual'.padStart(9)} ${'fits?'.padStart(6)}  ${'ugliness'.padEnd(28)} what`)
        for (const s of [...savings].sort((a, b) => b.saved - a.saved)) {
          console.log(`  ${String(s.saved + 'px').padStart(6)} ${String(s.after.overflowPx + 'px').padStart(9)} ${String(s.after.overflowPx === 0 ? 'YES' : 'no').padStart(6)}  ${s.ugly.slice(0, 28).padEnd(28)} ${s.why}`)
        }
      }
      console.log(`\n  Q5 TOUCH SCROLLABILITY of .pf-side:`)
      console.log(`     raw touch drag → scrollTop=${touch.afterRaw} (${touch.afterRaw > 0 ? 'WORKS' : 'no movement'})   ` +
        `synth touch fling → scrollTop=${touch.afterFling} (${touch.afterFling > 0 ? 'WORKS' : 'no movement'})   programmatic max=${touch.progMax}`)
      if (touch.atBottom) console.log(`     scrolled to bottom → block fullyVisible=${touch.atBottom.fullyVisible} clippedPx=${touch.atBottom.clippedPx}`)
      console.log(`\n  Q4 OTHER HIDING MECHANISMS — ancestor chain from .pf-side up:`)
      for (const c of hide.chain) console.log(`     ${c.sel.padEnd(22)} ovf=${(c.overflowX + '/' + c.overflowY).padEnd(15)} pos=${c.position.padEnd(8)} z=${String(c.zIndex).padEnd(5)} ` +
        `tr=${(c.transform === 'none' ? 'none' : 'SET').padEnd(4)} clip=${(c.clipPath === 'none' ? 'none' : 'SET').padEnd(4)} filter=${(c.filter === 'none' ? 'none' : 'SET').padEnd(4)} ` +
        `contain=${c.contain.padEnd(4)} op=${c.opacity} vis=${c.visibility}  h=${c.h} (client ${c.clientH}, scroll ${c.scrollH})`)
      console.log(`     .pf-wrap padding (no notch): ${hide.wrapPadding}`)
      console.log(`     SIMULATED NOTCH (--sa 59/21): ${JSON.stringify(hide.notchedSim)}`)
      console.log(`     block rect vs viewport: ${JSON.stringify(hide.blockRect)}`)
    }
  }
  await send('Fetch.disable')
  ws.close(); chrome.kill()

  // ── Q6 ──────────────────────────────────────────────────────────────────────────────────────────
  console.log(`\n\n═══════════════════════════════════════════════════════════════════════════════════`)
  console.log(`Q6  LIVE PROD BYTES — https://pikme-football.onrender.com`)
  console.log(`═══════════════════════════════════════════════════════════════════════════════════`)
  for (const [file, checks] of [
    ['/profile.js', [['overflow-y: auto on .pf-side', /\.pf-side\s*\{[^}]*overflow-y:\s*auto/],
      ['min-height: 0 on .pf-side', /\.pf-side\s*\{[^}]*min-height:\s*0/],
      ['any max-height media query (the compaction)', /@media\s*\(max-height/]]],
    ['/clubs.js', [['injectMyClubs defined', /async function injectMyClubs/],
      ["watch('profile', injectMyClubs", /watch\('profile',\s*injectMyClubs/],
      ['childList: true', /childList:\s*true/], ['subtree: true', /subtree:\s*true/],
      ['host captured BEFORE the await (THE LIVE BUG)', /const host = \(Array\.isArray/]]],
  ]) {
    try {
      const r = await fetch('https://pikme-football.onrender.com' + file)
      const txt = await r.text()
      console.log(`\n  ${file}  http ${r.status}  ${txt.length} bytes`)
      for (const [label, re] of checks) console.log(`     ${(re.test(txt) ? '✅ present' : '❌ absent ').padEnd(12)} ${label}`)
      if (file === '/clubs.js') {
        const live = txt.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).filter(l => /setTimeout\(\(\)\s*=>\s*injectInto/.test(l)).length
        console.log(`     ${(live === 0 ? '✅ absent ' : '❌ STILL LIVE').padEnd(12)} old 250ms setTimeout(()=>injectInto) in NON-COMMENT lines (${live} hits)`)
      }
    } catch (e) { console.log(`  ${file}  FETCH FAILED: ${e.message}`) }
  }

  // ── SUMMARY ─────────────────────────────────────────────────────────────────────────────────────
  console.log(`\n\n═══════════════════════════════════════════════════════════════════════════════════`)
  console.log(`SUMMARY`)
  console.log(`═══════════════════════════════════════════════════════════════════════════════════`)
  console.log(`\n  Q0 — DOES THE BLOCK EVEN REACH THE DOCUMENT (unforced)?`)
  console.log(`  ${'viewport'.padEnd(32)} ${'variant'.padEnd(24)} ${'block'.padEnd(9)} ${'appends'.padStart(7)} ${'detached'.padStart(9)} force-recovers`)
  for (const r of report) console.log(`  ${r.V.name.padEnd(32)} ${r.VARIANT.padEnd(24)} ${(r.loss.clubsInDoc ? 'PRESENT' : 'MISSING').padEnd(9)} ${String(r.loss.appends).padStart(7)} ${String(r.loss.appendedDetached).padStart(9)} ${r.forced ? 'yes' : 'NO'}`)
  console.log(`\n  Q1/Q2 — WITH .pf-clubs present: px that MUST be reclaimed for zero scrolling`)
  console.log(`  ${'viewport'.padEnd(32)} ${'variant'.padEnd(24)} ${'clientH'.padStart(8)} ${'scrollH'.padStart(8)} ${'RECLAIM'.padStart(8)} ${'clubs h'.padStart(8)} ${'belowFold'.padStart(10)}`)
  for (const r of report) console.log(`  ${r.V.name.padEnd(32)} ${r.VARIANT.padEnd(24)} ${String(r.base.pane.clientH).padStart(8)} ${String(r.base.pane.scrollH).padStart(8)} ` +
    `${String(r.base.pane.overflowPx).padStart(8)} ${String(r.base.block ? r.base.block.offsetH : '—').padStart(8)} ${String(r.base.block ? r.base.block.hiddenBelowFold : '—').padStart(10)}`)
  console.log(`\n  Q5 — does a finger move .pf-side?`)
  for (const r of report) console.log(`  ${r.V.name.padEnd(32)} ${r.VARIANT.padEnd(24)} rawDrag=${String(r.touch.afterRaw).padStart(5)}  fling=${String(r.touch.afterFling).padStart(5)}  progMax=${String(r.touch.progMax).padStart(5)}`)

  const heads = report.filter(r => r.VARIANT.startsWith('PROD'))
  const worst = heads.reduce((a, b) => (b.base.pane.overflowPx > a.base.pane.overflowPx ? b : a))
  console.log(`\n  WORST PROD VIEWPORT: ${worst.V.name} needs ${worst.base.pane.overflowPx}px reclaimed.`)
  console.log(`  Candidates that ALONE reach zero overflow there (cheapest first):`)
  const solo = worst.savings.filter(s => s.after.overflowPx === 0).sort((a, b) => a.saved - b.saved)
  if (!solo.length) console.log(`     NONE — a combination is required`)
  for (const s of solo) console.log(`     ${String(s.saved + 'px').padStart(6)}  [${s.ugly}]  ${s.id}`)
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
