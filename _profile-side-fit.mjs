/* DOES THE PROFILE'S SIDE PANE FIT ITS CONTENT WITHOUT SCROLLING?
 *
 * Adam 2026-08-03, after the race fix: "I still cannot see it." PRESENT IS NOT VISIBLE. clubs.js
 * appends .pf-clubs (a .myscopes strip + the גביעים/דירוג .pc-ranks block) to the BOTTOM of the
 * 176px-wide .pf-side pane. The game is landscape-locked, so an iPhone gives that column ~370px of
 * usable height against an iPad's ~814px — identical code, fine on the tablet, past the fold on the
 * phone. Making the pane scrollable only made the block REACHABLE; it did not make it VISIBLE, and
 * nobody drags a 176px column they have no reason to believe holds anything.
 *
 * THIS ASSERTS THE REAL BAR: at every phone-class viewport the whole injected block — including its
 * .pc-ranks child — sits inside .pf-side's visible box with ZERO scrolling.
 *   • rect bottoms: .pf-clubs and .pc-ranks bottom <= .pf-side bottom (+1px rounding)
 *   • .pf-side.scrollHeight <= clientHeight + 1   (nothing to scroll at all)
 * The iPad row (1194x834) is here as the DO-NO-HARM control: it passes today and must keep passing.
 *
 * It also prints a per-child height breakdown of the pane, because "it does not fit" is useless
 * without knowing which px to reclaim.
 *
 * Setup (stubs, the socket `welcome` the client waits for, opening the profile via #home-face) is
 * copied from _profile-clubs-race.mjs — same traps, same stub payloads, so the measured heights are
 * of real data shapes (club name, 3 scopes, 2 ranks).
 *
 * Run: node _profile-side-fit.mjs [port]        # default 3016
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = process.argv[2] || '3016'
const OUT = '/private/tmp/claude-501/-Users-adamleeperelman-Documents-pikeme/24a0f464-af08-4018-9ddf-e3fad2a0324f/scratchpad/sidefit'
mkdirSync(OUT, { recursive: true })
try { rmSync(OUT + '/profile', { recursive: true, force: true }) } catch {}
setTimeout(() => { console.error('TIMEOUT'); process.exit(2) }, 240000).unref?.()

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const CDP = 9451

// Landscape-locked, so width > height everywhere. The three phones are the ones the app ships to;
// the iPad is the control that must not regress.
const VIEWS = [
  { name: 'iPhone SE       800x360', w: 800, h: 360, dpr: 2, phone: true },
  { name: 'iPhone 12/13    844x390', w: 844, h: 390, dpr: 3, phone: true },
  { name: 'iPhone Pro Max  932x430', w: 932, h: 430, dpr: 3, phone: true },
  { name: 'iPad (control) 1194x834', w: 1194, h: 834, dpr: 2, phone: false },
]

// Same stub payloads as _profile-clubs-race.mjs: a club with a name, 3 scopes, both ranks.
const STUB = `(() => {
  window.SALTIZ_CARDS = [{ r:'legendary', n:5, c:1, w:900 }];
  window.SALTIZ_XP = { xp: 4200, level: 9 };
  // WORST CASE ON PURPOSE. buildProfileModel fills head.boardRank/boardTotal from window.SALTIZ_RANK
  // (rank + totalPlayers), and the pane then renders a SECOND .pf-board line — «מקום 12 מתוך 4210».
  // The app's WebView injects SALTIZ_RANK, so that row is what the player actually gets; a stub
  // without it measures a pane 16px shorter than the real one and would let a too-tight fix pass.
  window.SALTIZ_RANK = { rankPoints: 620, rankTier: 'silver', rank: 12, totalPlayers: 4210, delta: 0, botLevel: null };
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
  const rf = window.fetch;
  window.fetch = async (u, o) => {
    const url = String(u);
    if (url.includes('/player/')) return json(PLAYER);
    if (url.includes('/clubs') || url.includes('/dev/clubs')) return json(ME);
    // ⚠️ THE await IS LOAD-BEARING, do not "simplify" it away. The profile's stats call decides when
    // render #2 happens, and clubs.js drops any repaint that mutates the pane while its /player
    // request is in flight (_myClubsBusy). Answering stats with NO tick at all makes render #2 land
    // inside that window, so the block gets appended to the node render #2 already threw away and
    // the pane measures as un-injected — this harness reported "no .pf-clubs injected" on all four
    // viewports until this line awaited. Same shape as _profile-clubs-race.mjs, which awaits too.
    if (url.includes('/dev/progress') || url.includes('/handle-friends/rank')) {
      await new Promise((r) => setTimeout(r, 0));
      return json({ xp: 4200, level: 9, rankPoints: 0, wins: 13 });
    }
    if (url.includes('/handle-friends')) return json([]);
    return rf(u, o);
  };
})()`

// Measured in-page. Bottoms are compared as rects, which is what the eye actually sees; the
// scrollHeight check is the independent second opinion (a block can be inside the box only because
// the pane is scrolled).
const MEASURE = `(() => {
  const side = document.querySelector('.pf-side');
  const blk  = document.querySelector('.pf-side .pf-clubs');
  const rnk  = document.querySelector('.pf-side .pc-ranks');
  if (!side) return { err: 'no .pf-side' };
  if (!blk)  return { err: 'no .pf-clubs injected' };
  if (!rnk)  return { err: 'no .pc-ranks injected' };
  const sr = side.getBoundingClientRect(), br = blk.getBoundingClientRect(), rr = rnk.getBoundingClientRect();
  const kids = [...side.children].map((c) => ({
    cls: c.className || c.tagName.toLowerCase(),
    h: Math.round(c.getBoundingClientRect().height),
  }));
  const nm = document.querySelector('.pf-side .pf-name');
  return {
    // ⚠️ THE ANTI-SQUASH GUARD. .pf-side is a flex COLUMN, and .pf-name sets overflow:hidden — which
    // per spec zeroes its automatic minimum size, so an over-full pane silently crushes the player's
    // own name to 0px instead of overflowing. Measured before the fix: name = 0px on all three
    // phones, 18px on the iPad. Without this assertion a "fix" could pass by squashing the pane's
    // contents to nothing, which is not fitting — it is losing content quietly.
    nameH: nm ? Math.round(nm.getBoundingClientRect().height) : -1,
    blkKids: [...blk.children].map((c) => ({
      cls: c.className || c.tagName.toLowerCase(),
      h: Math.round(c.getBoundingClientRect().height),
    })),
    // A NOTE, NOT AN ASSERTION — this one belongs to clubs.css, which this harness's owner does not
    // edit. .myscopes is grid-template-columns: repeat(4, 1fr) and it is being asked to fit a 176px
    // pane, so the strip runs wider than the column and the first cell (the club) is clipped by the
    // pane edge. It is PRE-EXISTING and viewport-independent: the iPad row below, which no media
    // query in profile.js touches, shows the same or a larger number. Printed so the vertical fix is
    // never credited with causing it, and so the horizontal bug does not get lost.
    scopesOverflowX: (() => { const s = blk.querySelector('.myscopes'); if (!s) return null;
      const cells = [...s.children].map((c) => c.getBoundingClientRect());
      if (!cells.length) return null;
      const pad = parseFloat(getComputedStyle(side).paddingLeft) || 0;
      return Math.round(Math.max(0, (sr.left + pad) - Math.min(...cells.map((c) => c.left)))); })(),
    scrollTop: Math.round(side.scrollTop),
    paneVisibleH: Math.round(sr.height),
    paneClientH: side.clientHeight,
    paneScrollH: side.scrollHeight,
    overflowPx: Math.max(0, side.scrollHeight - side.clientHeight),
    blockTopWithinPane: Math.round(br.top - sr.top),
    blockH: Math.round(br.height),
    clubsHiddenBelow: Math.round(Math.max(0, br.bottom - sr.bottom)),
    ranksHiddenBelow: Math.round(Math.max(0, rr.bottom - sr.bottom)),
    ranksBottomWithinPane: Math.round(rr.bottom - sr.top),
    kids,
  };
})()`

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
  await send('Page.addScriptToEvaluateOnNewDocument', { source: STUB })

  const rows = []
  for (const v of VIEWS) {
    await send('Emulation.setDeviceMetricsOverride', { width: v.w, height: v.h, deviceScaleFactor: v.dpr, mobile: v.phone })
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?ftoken=harness&vp=${v.w}x${v.h}` })
    await sleep(7000)
    const evl = async (e) => (await send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: e }))?.result?.value
    await evl(`document.getElementById('home-face')?.click()`)
    await sleep(3000)          // past the 250ms inject and the stats round-trip
    const r = await evl(MEASURE)
    rows.push([v, r])

    console.log(`\n=== ${v.name} ===`)
    if (r?.err) { console.log('   ❌ ' + r.err); continue }
    console.log(`   pane visible/scroll : ${r.paneClientH} / ${r.paneScrollH}  (overflow ${r.overflowPx}px, scrollTop ${r.scrollTop})`)
    console.log(`   .pf-clubs           : top +${r.blockTopWithinPane} h ${r.blockH}, hidden below fold ${r.clubsHiddenBelow}px`)
    console.log(`   .pc-ranks           : bottom at +${r.ranksBottomWithinPane} of ${r.paneVisibleH}, hidden below fold ${r.ranksHiddenBelow}px`)
    console.log('   pane children       : ' + r.kids.map(k => `${k.cls}=${k.h}`).join('  '))
    console.log('   .pf-clubs children  : ' + r.blkKids.map(k => `${k.cls}=${k.h}`).join('  '))
    console.log(`   .pf-name height     : ${r.nameH}px` + (r.nameH > 0 ? '' : '  ⚠ SQUASHED TO NOTHING'))
    console.log(`   note, clubs.css     : .myscopes 4-col strip runs ${r.scopesOverflowX}px past the pane's start edge (pre-existing, not asserted)`)
  }
  ws.close(); chrome.kill()

  console.log('\n---------------- VERDICT ----------------')
  let bad = 0
  for (const [v, r] of rows) {
    const fits = !r?.err && r.clubsHiddenBelow === 0 && r.ranksHiddenBelow === 0
      && r.paneScrollH <= r.paneClientH + 1 && r.scrollTop === 0 && r.nameH > 0
    if (!fits) bad++
    const why = r?.err ? r.err
      : [r.clubsHiddenBelow ? `clubs ${r.clubsHiddenBelow}px past fold` : null,
         r.ranksHiddenBelow ? `ranks ${r.ranksHiddenBelow}px past fold` : null,
         r.paneScrollH > r.paneClientH + 1 ? `pane scrolls ${r.overflowPx}px` : null,
         r.nameH > 0 ? null : 'the name is squashed to 0px'].filter(Boolean).join(', ')
    console.log(`${fits ? '✅' : '❌'} ${v.name}` + (fits ? '  — fully visible, no scroll' : '  — ' + why))
  }
  console.log(bad === 0
    ? '\n✅ ZERO-SCROLL FIT on all ' + rows.length + ' viewports'
    : `\n❌ ${bad}/${rows.length} viewports still need a scroll to see the clubs + rank block`)
  process.exit(bad === 0 ? 0 : 1)
}
main().catch(e => { console.error(e); process.exit(1) })
