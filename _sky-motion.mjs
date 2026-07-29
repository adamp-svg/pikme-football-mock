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

// Clip a screenshot to a strip through the middle of the top band and compare the bytes. Screenshot
// clipping cannot fail the way an in-page getImageData can, and it is what the eye actually sees.
const v = await ev('window.__view()');
const bandDevY = Math.round(v.bandY * 3.25 / 2);   // ART px -> CSS px
const clip = { x: 0, y: Math.max(1, Math.round(bandDevY * 0.5)), width: v.vw, height: Math.max(8, Math.round(bandDevY * 0.6)), scale: 1 };
const shot = async () => (await cdp('Page.captureScreenshot', { format: 'png', clip })).data;
const s1 = await shot(); await sleep(1200); const s2 = await shot(); await sleep(1200); const s3 = await shot();
const same = (a, b) => a === b;
console.log(`\nband strip ${clip.width}x${clip.height} at y=${clip.y}: ${s1.length} / ${s2.length} / ${s3.length} bytes`);
console.log(same(s1, s2) && same(s2, s3)
  ? '  ❌ STATIC — three captures 1.2s apart are byte-identical'
  : '  ✅ MOVING — the band differs between captures');
// Is the whole frame animating at all, or is the page just idle?
const full = async () => (await cdp('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: Math.round(v.vh * 0.45), width: v.vw, height: 40, scale: 1 } })).data;
const f1 = await full(); await sleep(1000); const f2 = await full();
console.log(f1 === f2 ? '  (a pitch strip is also identical — the whole frame may be idle)' : '  (the pitch strip differs, so the render loop is running)');
ws.close(); process.exit(0);
