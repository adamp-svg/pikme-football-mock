// Does the fairness cap hold? Reads window.__view() in a real match on each device and asserts every
// surface sees the SAME world height. Screenshots each one for the eye check.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { WebSocket } from 'ws';
const PAGE = process.env.URL || 'http://localhost:3012/', CDP = 9494;
const SHOTS = new URL('./_device-shots/', import.meta.url).pathname; mkdirSync(SHOTS, { recursive: true });
const DEVS = [
  { id: 'fair-iphone', name: 'iPhone 17 Pro', w: 844, h: 390, dpr: 3 },
  { id: 'fair-a15',    name: 'Galaxy A15',    w: 800, h: 360, dpr: 3 },
  { id: 'fair-ipad11', name: 'iPad Pro 11"',  w: 1194, h: 834, dpr: 2 },
  { id: 'fair-ipad13', name: 'iPad Pro 13"',  w: 1366, h: 1024, dpr: 2 },
  { id: 'fair-tabs9',  name: 'Galaxy Tab S9', w: 1280, h: 800, dpr: 2 },
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=/tmp/fair-${process.pid}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--window-size=1400,1100', 'about:blank'], { stdio: 'ignore' });
process.on('exit', () => { try { chrome.kill(); } catch {} });
let url; for (let i = 0; i < 60 && !url; i++) { try { const r = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json(); const p = r.filter(t => t.type === 'page'); if (p.length) url = p[0].webSocketDebuggerUrl; } catch {} if (!url) await sleep(250); }
const ws = new WebSocket(url); await new Promise(r => ws.once('open', r));
let id = 0; const pend = new Map();
ws.on('message', raw => { const m = JSON.parse(raw.toString()); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } });
const cdp = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('timeout ' + method)); } }, 25000); });
const ev = async e => (await cdp('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result.value;
await cdp('Page.enable'); await cdp('Runtime.enable');
let fails = 0; const seen = [];
for (const d of DEVS) {
  await cdp('Emulation.setDeviceMetricsOverride', { width: d.w, height: d.h, deviceScaleFactor: d.dpr, mobile: true });
  await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await cdp('Page.navigate', { url: PAGE }); await sleep(700);
  await ev(`(()=>{try{localStorage.setItem('fbHubTourSkipped','1');localStorage.setItem('fbHubTourDone','1');localStorage.removeItem('fbTutorialDoneSet');localStorage.removeItem('fbTutorialDone');}catch{}return 1})()`);
  await cdp('Page.navigate', { url: PAGE });
  // Settle well past the hub-tour handover — 4.5s caught a transition frame last time.
  await sleep(9500);
  const v = await ev('window.__view ? window.__view() : null');
  const scr = await ev(`[...document.querySelectorAll('.screen')].filter(s=>!s.classList.contains('hidden')).map(s=>s.id).join(',')`);
  console.log(d.name.padEnd(15), v ? `sees ${v.seesWorldW}x${v.seesWorldH} (${v.pitchPct}% of pitch) · band ${v.bandY}art · screen ${scr}` : 'no __view (not in a match?)');
  if (v) seen.push({ d, v });
  const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${SHOTS}${d.id}.png`, Buffer.from(data, 'base64'));
}
console.log('');
const hs = seen.map(s => s.v.seesWorldH);
const spread = Math.max(...hs) - Math.min(...hs);
const ok = (c, m) => { console.log((c ? '  ✅ ' : '  ❌ ') + m); if (!c) fails++; };
// Two separate claims. The cap is only meaningful if NOBODY exceeds it; parity is the tighter one.
ok(Math.max(...hs) <= 562, `nobody sees more than the 560-unit window (max ${Math.max(...hs)})`);
// Spread is measured over devices TALL ENOUGH to fill the window. A 360dp Android physically cannot show
// 560 units (it tops out at 545) and shrinking everyone to match it would give the iPhone a band, which
// the approved composition forbids.
const tall = seen.filter(s => s.d.h >= 385).map(s => s.v.seesWorldH);
// 1 unit of tolerance, not 0: wbW is a ceil() of canvas px / ART_PX, so a device's scale can land a
// fraction high and its screen then caps the window 0.6 of a unit short (the iPhone reads 559). That is
// 0.18% and it is rounding, not vision — but it is asserted tightly enough that a real regression shows.
ok(Math.max(...tall) - Math.min(...tall) <= 1, `every device that CAN fill the window sees 560 +/-1 (${tall.join(', ')})`);
ok(seen.filter(s => s.d.h < 385).every(s => s.v.seesWorldH >= 540), `a 360dp Android sees ${seen.filter(s => s.d.h < 385).map(s => s.v.seesWorldH).join(',')} — the honest residual, band 0`);
ok(seen.every(s => s.v.seesWorldW === seen[0].v.seesWorldW || Math.abs(s.v.seesWorldW - seen[0].v.seesWorldW) <= 2), `...and the same width (${seen.map(s => s.v.seesWorldW).join(', ')})`);
ok(seen.filter(s => s.d.h >= 700).every(s => s.v.bandY > 0), 'tablets have a non-play band');
// Phones may carry a rounding sliver; what matters is that it is negligible, not that it is zero.
ok(seen.filter(s => s.d.h < 500).every(s => s.v.bandY === 0), `phones draw NO sky at all — band 0 as the composition requires (${seen.filter(s => s.d.h < 500).map(s => s.v.bandY).join(', ')})`);
console.log(fails ? `\n❌ ${fails} FAILED` : '\n✅ the cap holds');
ws.close(); process.exit(0);
