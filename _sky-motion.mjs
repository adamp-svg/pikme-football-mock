// Is the sky actually MOVING in the real client? Samples the band's pixels a second apart and
// compares them. A layout screenshot cannot answer this; a pixel diff can.
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
const PAGE = process.env.URL || 'http://localhost:3012/', CDP = 9496;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=/tmp/skym-${process.pid}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
process.on('exit', () => { try { chrome.kill(); } catch {} });
let url; for (let i = 0; i < 60 && !url; i++) { try { const r = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json(); const p = r.filter(t => t.type === 'page'); if (p.length) url = p[0].webSocketDebuggerUrl; } catch {} if (!url) await sleep(250); }
const ws = new WebSocket(url); await new Promise(r => ws.once('open', r));
let id = 0; const pend = new Map();
ws.on('message', raw => { const m = JSON.parse(raw.toString()); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } });
const cdp = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('timeout ' + m)); } }, 25000); });
const ev = async e => (await cdp('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result.value;
await cdp('Page.enable'); await cdp('Runtime.enable');
await cdp('Emulation.setDeviceMetricsOverride', { width: 1366, height: 1024, deviceScaleFactor: 2, mobile: true });
await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await cdp('Page.navigate', { url: PAGE }); await sleep(700);
await ev(`(()=>{try{localStorage.setItem('fbHubTourSkipped','1');localStorage.setItem('fbHubTourDone','1');localStorage.removeItem('fbTutorialDoneSet');localStorage.removeItem('fbTutorialDone');}catch{}return 1})()`);
await cdp('Page.navigate', { url: PAGE }); await sleep(9500);

console.log('reduced-motion reported by the page :', await ev(`matchMedia('(prefers-reduced-motion: reduce)').matches`));
console.log('SkyBand.reducedMotion()             :', await ev(`window.SkyBand && SkyBand.reducedMotion ? SkyBand.reducedMotion() : 'n/a'`));
console.log('view                                :', JSON.stringify(await ev('window.__view ? __view() : null')));

// Hash a horizontal strip through the middle of the top band, twice, ~1.2s apart.
const strip = `(() => {
  const c = document.getElementById('canvas'); const g = c.getContext('2d');
  const v = window.__view(); const dpr = c.width / v.vw;
  const y = Math.round(v.bandY * ${3.25} * dpr / 2);   // middle-ish of the band, in device px
  const d = g.getImageData(0, Math.max(1, y), c.width, 2).data;
  let h = 0; for (let i = 0; i < d.length; i += 4) h = (h * 31 + d[i] + d[i+1] * 7 + d[i+2] * 13) | 0;
  return h;
})()`;
const a = await ev(strip); await sleep(1200); const b = await ev(strip); await sleep(1200); const c2 = await ev(strip);
console.log(`\nband pixel hash: ${a}  ->  ${b}  ->  ${c2}`);
console.log(a === b && b === c2 ? '  ❌ STATIC — the band is not animating' : '  ✅ the band changes between frames (drift is live)');
ws.close(); process.exit(0);
