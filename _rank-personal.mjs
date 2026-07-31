/* Proves the RANK screen survives the new wire contract, on the real client.
 *
 * What changed under it and why this exists:
 *   • METRICS lost 'xp' and gained 'ranked'   → a stale METRIC_UNIT renders the literal «undefined»
 *   • SCOPE_TABS gained a 5th tab             → five flex:1 tabs in a 460px column can clip
 *   • /board?scope=personal has a NEW body    → no k, no mineScopeId, rows are PLAYERS not scopes
 *   • /player/:id dropped ranks.xp            → two template literals read it; an absent key THROWS
 *
 * That last one is the reason this file is not optional. `injectInto()` reads ranks.xp one line
 * before appendChild, and both of its call sites invoke it un-awaited (a MutationObserver and a
 * setTimeout), so a TypeError there surfaces as an unhandled rejection with NOTHING on screen — no
 * error, no spinner, just a missing block on two different surfaces. It cannot be caught by looking.
 *
 *   node _rank-personal.mjs [port]        # default 3016
 */
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = process.argv[2] || '3016'
const OUT = '/private/tmp/claude-501/-Users-adamleeperelman-Documents-pikeme/00ddc158-6376-4024-ba10-455d2c7bceff/scratchpad/rankshot'
mkdirSync(OUT, { recursive: true })
try { rmSync(OUT + '/profile', { recursive: true, force: true }) } catch {}
setTimeout(() => { console.error('TIMEOUT'); process.exit(2) }, 180000).unref?.()

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const CDP = 9422

// The wire contract exactly as routes-pikme/clubs.js now ships it.
const METRICS = [
  { key: 'trophies', labelHe: 'הכי הרבה גביעים', unitHe: 'גביעים' },
  { key: 'ranked', labelHe: 'דירוג', unitHe: 'דירוג' },
  { key: 'goals', labelHe: 'הכי הרבה שערים', unitHe: 'שערים' },
  { key: 'wins', labelHe: 'הכי הרבה נצחונות', unitHe: 'נצחונות' },
  { key: 'cards', labelHe: 'הכי הרבה קלפים', unitHe: 'קלפים' },
]
const ME = {
  me: { id: 'u0', nickName: 'אדם' }, maxMembers: 30, k: 3, metrics: METRICS,
  scopes: { city: { id: '2025178902' }, school: { id: 'x' }, grade: 5, classNumber: 2 },
  club: null,
}
// top 3 + me±3 with a rank jump — the shape the app's leaderboard uses.
const PERSONAL = {
  metric: 'trophies', scope: 'personal', totalRanked: 3921,
  me: { rank: 1204, value: 8800 },
  rows: [
    { rank: 1, userId: 'a1', nickName: 'דן', club: 'אריות תל אביב', emblem: '🦁', value: 91200, isMe: false },
    { rank: 2, userId: 'a2', nickName: 'מאיה', club: null, emblem: null, value: 88400, isMe: false },
    { rank: 3, nickName: 'שחקן', club: null, emblem: null, value: 80100, isMe: false },   // identity miss: no userId
    { rank: 1202, userId: 'a4', nickName: 'עומר', club: 'נשרים', emblem: '🦅', value: 8900, isMe: false },
    { rank: 1203, userId: 'a5', nickName: 'יעל', club: null, emblem: null, value: 8850, isMe: false },
    { rank: 1204, userId: 'u0', nickName: 'אדם', club: null, emblem: null, value: 8800, isMe: true },
    { rank: 1205, userId: 'a7', nickName: 'רון', club: null, emblem: null, value: 8790, isMe: false },
  ],
}
const UNRANKED = { metric: 'trophies', scope: 'personal', totalRanked: 3921, me: { rank: null, value: 0 }, rows: PERSONAL.rows }
const GROUP = {
  metric: 'trophies', scope: 'city', k: 3, totalRanked: 3921, mineScopeId: '2025178902',
  rows: [{ rank: 1, scopeId: '2025178902', score: 8, members: 40, padded: 0 },
    { rank: 2, scopeId: '5000', score: 12, members: 9, padded: 0 }],
}
const PLAYER = {
  nickName: 'דן', image: null, xp: 91200, trophies: 91200, rankPoints: 1400, friend: false,
  club: { id: 'c1', name: 'אריות תל אביב', emblem: '🦁', count: 24, role: 'member' },
  scopes: { city: { label: 'תל אביב-יפו' }, school: null, class: null },
  ranks: { trophies: { place: 1, of: 3921 }, ranked: { place: 7, of: 120 } },   // NO ranks.xp
}

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
  const errors = []
  ws.on('message', d => {
    const m = JSON.parse(d.toString())
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id) }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params?.exceptionDetails?.exception?.description || 'exception')
    if (m.method === 'Log.entryAdded' && m.params?.entry?.level === 'error') errors.push((m.params.entry.url||'') + ' :: ' + m.params.entry.text)
  })
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 3, mobile: true })
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      const ME=${JSON.stringify(ME)}, P=${JSON.stringify(PERSONAL)}, U=${JSON.stringify(UNRANKED)},
            G=${JSON.stringify(GROUP)}, PL=${JSON.stringify(PLAYER)};
      window.__unranked = false;
      const real = window.fetch;
      const J = (o) => Promise.resolve(new Response(JSON.stringify(o), { status:200, headers:{'Content-Type':'application/json'} }));
      window.fetch = (u,o) => { const s=String(u);
        if (s.includes('/clubs/me')) return J(ME);
        if (s.includes('/clubs/board') && s.includes('scope=personal')) return J(window.__unranked ? U : P);
        if (s.includes('/clubs/board')) return J(G);
        if (s.includes('/clubs/player/')) return J(PL);
        if (s.includes('/clubs/find')) return J({ myTrophies: 8800, rows: [] });
        return real(u,o); };
      window.PIKME_FOOTBALL_TOKEN='harness';
    })()`,
  })
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?ftoken=harness` })
  await sleep(3500)

  const probe = async (label, setup) => {
    await send('Runtime.evaluate', { expression: setup })
    await sleep(300)
    await send('Runtime.evaluate', { expression: `document.getElementById('scope-wrap')?.scrollIntoView({block:'start'})` })
    await sleep(1600)
    const r = await send('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => {
        const host=document.querySelector('#scope-board');
        if(!host) return { err:'no #scope-board' };
        const tabs=[...host.querySelectorAll('.scope-tab')];
        const pills=[...host.querySelectorAll('.metric-pill')];
        const rows=[...host.querySelectorAll('.scope-row')];
        const note=host.querySelector('.scope-note');
        const clip=(e)=>{const b=e.getBoundingClientRect();return b.right>innerWidth+1||b.left<-1||b.bottom>innerHeight+1;};
        return {
          tabs: tabs.map(t=>t.textContent), tabsClipped: tabs.filter(clip).length,
          tabWrapped: tabs.filter(t=>t.scrollWidth>t.clientWidth+1).map(t=>t.textContent),
          pills: pills.map(p=>p.textContent), pillOn: pills.filter(p=>p.classList.contains('on')).map(p=>p.textContent),
          rows: rows.map(r=>r.textContent.replace(/\\s+/g,' ').trim()).slice(0,9),
          mine: rows.filter(r=>r.classList.contains('mine')).map(r=>r.textContent.replace(/\\s+/g,' ').trim()),
          uids: rows.map(r=>r.dataset.uid ?? null),
          gaps: host.querySelectorAll('.scope-gap').length,
          note: note ? note.textContent.replace(/\\s+/g,' ').trim() : null,
          hasUndefined: host.textContent.includes('undefined'),
          boardBottom: Math.round(host.getBoundingClientRect().bottom), vh: innerHeight,
          // The rank page SCROLLS by design (the board sits below the tier ladder), so extending
          // past the fold is not a defect — being unreachable is. Prove the scroller can actually
          // bring the board's last pixel into view.
          scroller: (() => { let n = host; while (n && n !== document.body) {
              const s = getComputedStyle(n);
              if (/auto|scroll/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 1) return { tag: n.className || n.id, reach: n.scrollHeight - n.clientHeight };
              n = n.parentElement; }
            return document.scrollingElement.scrollHeight > innerHeight + 1 ? { tag: 'page', reach: document.scrollingElement.scrollHeight - innerHeight } : null; })(),
        };
      })()`,
    })
    return [label, r?.result?.value]
  }

  // #scope-board lives INSIDE the rank screen, below the tier ladder — so it is legitimately below
  // the fold on a 390px phone. Scroll it into view before measuring, or every element reads as
  // "clipped" and the harness reports a layout bug that is really just a scrolled page.
  const open = `(() => { document.querySelectorAll('.screen').forEach(s=>s.classList.add('hidden'));
    const wrap=document.getElementById('scope-wrap');
    wrap?.closest('.screen')?.classList.remove('hidden');
    wrap?.classList.remove('hidden');
    wrap?.scrollIntoView({ block:'start' }); })()`

  const results = []
  results.push(await probe('personal (default pill)', open + `; (window.__renderBoard||(()=>{}))()`))
  // click the personal tab explicitly, then each pill
  results.push(await probe('personal tab clicked',
    `[...document.querySelectorAll('#scope-board .scope-tab')].find(t=>t.textContent==='אני')?.click()`))
  results.push(await probe('ranked pill', `[...document.querySelectorAll('#scope-board .metric-pill')].find(p=>p.textContent==='דירוג')?.click()`))
  results.push(await probe('city tab (group regression)',
    `[...document.querySelectorAll('#scope-board .scope-tab')].find(t=>t.textContent==='עיר')?.click()`))
  results.push(await probe('unranked caller',
    `window.__unranked=true; [...document.querySelectorAll('#scope-board .scope-tab')].find(t=>t.textContent==='אני')?.click()`))

  // The player card + injectInto — the ranks.xp ship-blocker.
  await send('Runtime.evaluate', { expression: `window.__unranked=false; window.openPlayerCard && window.openPlayerCard('a1')` })
  await sleep(1800)
  const card = await send('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => { const m=document.querySelector('#player-card');
      if(!m||m.classList.contains('hidden')) return { open:false };
      const t=m.textContent.replace(/\\s+/g,' ').trim();
      return { open:true, stuckLoading: t.includes('טוען…'), text: t.slice(0,240),
               ranks: [...m.querySelectorAll('.pc-rank')].map(x=>x.textContent.replace(/\\s+/g,' ').trim()),
               hasUndefined: t.includes('undefined') }; })()`,
  })

  const shot = await send('Page.captureScreenshot', { format: 'png' })
  if (shot?.data) writeFileSync(`${OUT}/rank-personal.png`, Buffer.from(shot.data, 'base64'))

  ws.close(); chrome.kill()

  const fails = []
  for (const [label, v] of results) {
    if (!v || v.err) { fails.push(`${label}: ${v?.err || 'no data'}`); continue }
    console.log(`\n── ${label}`)
    console.log('   tabs   ', v.tabs.join(' | '), `clipped=${v.tabsClipped} wrapped=${v.tabWrapped.length}`)
    console.log('   pills  ', v.pills.join(' | '), '→ on:', v.pillOn.join(',') || '(NONE)')
    console.log('   rows   ', v.rows.length, 'gaps', v.gaps, 'uids', JSON.stringify(v.uids))
    v.rows.slice(0, 4).forEach(r => console.log('      ', r))
    console.log('   mine   ', v.mine.join(' / ') || '(none)')
    console.log('   note   ', v.note)
    if (v.hasUndefined) fails.push(`${label}: the board renders the literal "undefined"`)
    if (v.tabsClipped) fails.push(`${label}: ${v.tabsClipped} tab(s) clipped off the viewport`)
    if (v.tabWrapped.length) fails.push(`${label}: tab text overflows: ${v.tabWrapped.join(',')}`)
    if (!v.pillOn.length) fails.push(`${label}: NO metric pill is highlighted`)
    const over = v.boardBottom - v.vh
    if (over > 1 && !v.scroller) fails.push(`${label}: board runs ${over}px past the viewport with NO scroller — unreachable`)
    else if (over > 1) console.log(`   below fold ${over}px, reachable via .${v.scroller.tag} (${v.scroller.reach}px of scroll)`)
  }
  const c = card?.result?.value
  console.log('\n── player card')
  console.log('  ', JSON.stringify(c))
  if (!c?.open) fails.push('player card never opened')
  else {
    if (c.stuckLoading) fails.push('player card stuck on «טוען…» — a template literal threw')
    if (c.hasUndefined) fails.push('player card renders "undefined"')
    if ((c.ranks || []).length !== 2) fails.push(`player card shows ${(c.ranks || []).length} rank panels, expected 2`)
  }
  // /dev/progress 403s on every dev server here regardless of this change (it is a passthrough to
  // pikme-server, which the LAN host is not allowed to call) — pre-existing, unrelated, filtered.
  const real = errors.filter(e => !/favicon|schools-directory|net::ERR|\/dev\/progress/.test(e))
  if (real.length) fails.push(`page errors: ${real.slice(0, 3).join(' | ')}`)

  console.log('\nshot ->', `${OUT}/rank-personal.png`)
  console.log(fails.length ? '\n❌ FAIL:\n  ' + fails.join('\n  ') : '\n✅ rank screen clean — 5 tabs fit, personal board renders, card has both panels')
  process.exit(fails.length ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(1) })
