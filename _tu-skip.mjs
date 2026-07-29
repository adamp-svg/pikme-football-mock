// Does «דלג ›» actually get a first-timer out of the tutorial, and stay out?
import { spawn } from 'node:child_process'; import { WebSocket } from 'ws';
const PAGE = process.env.URL || 'http://localhost:3012/', CDP = 9502;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=/tmp/tusk-${process.pid}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
process.on('exit', () => { try { chrome.kill(); } catch {} });
let u; for (let i = 0; i < 60 && !u; i++) { try { const r = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json(); const p = r.filter(t => t.type === 'page'); if (p.length) u = p[0].webSocketDebuggerUrl; } catch {} if (!u) await sleep(250); }
const ws = new WebSocket(u); await new Promise(r => ws.once('open', r));
let id = 0; const pend = new Map();
ws.on('message', raw => { const m = JSON.parse(raw.toString()); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } });
const cdp = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('t/o ' + m)); } }, 25000); });
const ev = async e => (await cdp('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result.value;
const touch = (t, x, y) => cdp('Input.dispatchTouchEvent', { type: t, touchPoints: t === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
await cdp('Page.enable'); await cdp('Runtime.enable');
await cdp('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 2, mobile: true });
await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await cdp('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });
let fails = 0; const ok = (c, m) => { console.log((c ? '  ✅ ' : '  ❌ ') + m); if (!c) fails++; };
const screens = () => ev(`[...document.querySelectorAll('.screen')].filter(s=>!s.classList.contains('hidden')).map(s=>s.id).join(',')`);

// FIRST RUN: fresh profile, hub tour waved off so the pitch tutorial is what auto-starts.
await cdp('Page.navigate', { url: PAGE }); await sleep(700);
await ev(`(()=>{try{localStorage.clear();localStorage.setItem('fbHubTourSkipped','1');localStorage.setItem('fbHubTourDone','1');}catch{}return 1})()`);
await cdp('Page.navigate', { url: PAGE }); await sleep(9000);
ok(await screens() === 'game', `a first run auto-starts the tutorial (screen: ${await screens()})`);
const box = await ev(`(()=>{const e=document.getElementById('tu-skip'); if(!e) return null; const r=e.getBoundingClientRect(); const s=getComputedStyle(e);
  return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),w:Math.round(r.width),h:Math.round(r.height),shown:s.display!=='none'&&s.visibility!=='hidden'&&r.width>0};})()`);
ok(box && box.shown, `the skip button is on screen (${box ? box.w + 'x' + box.h + 'px at ' + box.x + ',' + box.y : 'MISSING'})`);
ok(box && box.w >= 44 || (box && box.h >= 34), `and it is a real touch target (${box ? box.w + 'x' + box.h : '?'})`);
// It must be far from the sticks a child is being taught to use.
const stickL = await ev(`(()=>{const e=document.getElementById('stickL'); if(!e) return null; const r=e.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
if (box && stickL) { const d = Math.hypot(box.x - stickL.x, box.y - stickL.y); ok(d > 250, `and ${Math.round(d)}px from the move stick — not a mis-tap risk`); }

await touch('touchStart', box.x, box.y); await touch('touchEnd', box.x, box.y); await sleep(2500);
ok(await screens() === 'home', `tapping it lands on the hub (screen: ${await screens()})`);
ok(await ev(`localStorage.getItem('fbTutorialSkipped')`) === '1', 'and records the skip');
ok(await ev(`(localStorage.getItem('fbTutorialDoneSet')||'') === '' && localStorage.getItem('fbTutorialDone') !== '1'`),
  'without lying that the tutorial was COMPLETED (nothing marked done)');
// RELOAD: it must not trap them again...
await cdp('Page.navigate', { url: PAGE }); await sleep(9000);
ok(await screens() === 'home', `a reload no longer forces the tutorial (screen: ${await screens()})`);
// ...but «איך משחקים?» must still offer it.
const list = await ev(`(()=>{const b=document.getElementById('tc-howto'); if(!b) return 'no howto button'; b.click();
  return new Promise(r=>setTimeout(()=>r([...document.querySelectorAll('#tu-levels .tu-lv')].map(e=>e.textContent.trim().slice(0,14)).join(' | ')),400));})()`);
ok(typeof list === 'string' && list.includes('יסודות'), `and «איך משחקים?» still lists every level: ${list}`);
console.log(fails ? `\n❌ ${fails} FAILED` : '\n✅ skip works, is recorded, and does not fake completion');
ws.close(); process.exit(0);
