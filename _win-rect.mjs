// THE decisive test: at the SAME camera, do two devices show the SAME WORLD RECT? Compares __view().winWorld
// — the world rectangle actually inside the play window — which a mean-colour grid over uniform turf cannot
// see (that is how a 143-unit vertical shift survived the previous check).
import { spawn } from 'node:child_process'; import { WebSocket } from 'ws';
const PAGE = process.env.URL || 'http://localhost:3012/', CDP = 9505;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const DEVS = [
  { id: 'iphone17pro', name: 'iPhone 17 Pro', w: 874, h: 402, dpr: 3 },
  { id: 'iphone17max', name: 'iPhone 17 Pro Max', w: 956, h: 440, dpr: 3 },
  { id: 'a15', name: 'Galaxy A15', w: 800, h: 360, dpr: 3 },
  { id: 'inset', name: 'phone w/ 60px inset', w: 874, h: 342, dpr: 3 },
  { id: 'ipad11', name: 'iPad Pro 11"', w: 1194, h: 834, dpr: 2 },
  { id: 'ipad13', name: 'iPad Pro 13"', w: 1366, h: 1024, dpr: 2 },
  { id: 'tabs9', name: 'Galaxy Tab S9', w: 1280, h: 800, dpr: 2 },
];
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=/tmp/win-${process.pid}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
process.on('exit', () => { try { chrome.kill(); } catch {} });
let u; for (let i = 0; i < 60 && !u; i++) { try { const r = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json(); const p = r.filter(t => t.type === 'page'); if (p.length) u = p[0].webSocketDebuggerUrl; } catch {} if (!u) await sleep(250); }
const ws = new WebSocket(u); await new Promise(r => ws.once('open', r));
let id = 0; const pend = new Map();
ws.on('message', raw => { const m = JSON.parse(raw.toString()); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } });
const cdp = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('t/o ' + m)); } }, 25000); });
const ev = async e => (await cdp('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result.value;
await cdp('Page.enable'); await cdp('Runtime.enable');
const out = [];
for (const d of DEVS) {
  await cdp('Emulation.setDeviceMetricsOverride', { width: d.w, height: d.h, deviceScaleFactor: d.dpr, mobile: true });
  await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await cdp('Page.navigate', { url: PAGE }); await sleep(700);
  await ev(`(()=>{try{localStorage.setItem('fbHubTourSkipped','1');localStorage.setItem('fbHubTourDone','1');localStorage.removeItem('fbTutorialDoneSet');localStorage.removeItem('fbTutorialDone');localStorage.removeItem('fbTutorialSkipped');}catch{}return 1})()`);
  await cdp('Page.navigate', { url: PAGE }); await sleep(9500);
  const v = await ev('window.__view()');
  out.push({ d, v });
  console.log(d.name.padEnd(22), `window ${v.winWorld.w}x${v.winWorld.h} at (${v.winWorld.x}, ${v.winWorld.y}) · sky ${v.bandY} · stadium ${v.bandX}`);
}
let fails = 0; const ok = (c, m) => { console.log((c ? '  ✅ ' : '  ❌ ') + m); if (!c) fails++; };
console.log('');
const W = out.map(o => o.v.winWorld.w), H = out.map(o => o.v.winWorld.h);
ok(Math.max(...W) - Math.min(...W) <= 2, `every device's window is the same WIDTH (${Math.min(...W)}–${Math.max(...W)} units)`);
ok(Math.max(...H) - Math.min(...H) <= 2, `every device's window is the same HEIGHT (${Math.min(...H)}–${Math.max(...H)} units)`);
// The same camera must put the window at the same world ORIGIN — this is what the missing offsets broke.
const Y = out.map(o => o.v.winWorld.y);
ok(Math.max(...Y) - Math.min(...Y) <= 3, `and at the same world ORIGIN y (${Math.min(...Y)}–${Math.max(...Y)}) — the shift bug`);
ok(out.filter(o => o.d.h >= 700).every(o => o.v.bandY > 20 && o.v.bandX === 0), 'tablets: sky top/bottom, no side bands');
ok(out.filter(o => o.d.h < 500).every(o => o.v.bandY === 0), 'phones: no sky');
ok(out.find(o => o.d.id === 'inset').v.bandX > 20, `a phone with an inset gets STADIUM at the sides (${out.find(o => o.d.id === 'inset').v.bandX} art px) instead of losing pitch`);
console.log(fails ? `\n❌ ${fails} FAILED` : '\n✅ identical window on every device');
ws.close(); process.exit(0);
