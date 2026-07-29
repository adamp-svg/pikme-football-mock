// Does the stadium descend out of the sky as a player walks to the touchline?
// Drives the REAL move stick upward on an iPad viewport and samples the transition each step. A
// screenshot cannot show a transition; this can.
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
const PAGE = process.env.URL || 'http://localhost:3012/', CDP = 9498;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=/tmp/skya-${process.pid}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
process.on('exit', () => { try { chrome.kill(); } catch {} });
let url; for (let i = 0; i < 60 && !url; i++) { try { const r = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json(); const p = r.filter(t => t.type === 'page'); if (p.length) url = p[0].webSocketDebuggerUrl; } catch {} if (!url) await sleep(250); }
const ws = new WebSocket(url); await new Promise(r => ws.once('open', r));
let id = 0; const pend = new Map();
ws.on('message', raw => { const m = JSON.parse(raw.toString()); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } });
const cdp = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('timeout ' + m)); } }, 25000); });
const ev = async e => (await cdp('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result.value;
const touch = (type, x, y) => cdp('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
await cdp('Page.enable'); await cdp('Runtime.enable');
await cdp('Emulation.setDeviceMetricsOverride', { width: 1366, height: 1024, deviceScaleFactor: 2, mobile: true });
await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await cdp('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });
await cdp('Page.navigate', { url: PAGE }); await sleep(700);
await ev(`(()=>{try{localStorage.setItem('fbHubTourSkipped','1');localStorage.setItem('fbHubTourDone','1');localStorage.removeItem('fbTutorialDoneSet');localStorage.removeItem('fbTutorialDone');}catch{}return 1})()`);
await cdp('Page.navigate', { url: PAGE }); await sleep(9500);

const v0 = await ev('window.__view()');
console.log(`iPad 1366x1024 · band ${v0.bandY} art px · window ${v0.seesWorldH} world units tall\n`);
const stick = await ev(`(()=>{const e=document.getElementById('stickL'); if(!e) return null; const r=e.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2)};})()`);
if (!stick) { console.log('no move stick on screen — cannot walk'); process.exit(1); }

console.log('walking UP toward the top touchline:');
console.log('  t      camY   stadium in top band   what the band shows');
await touch('touchStart', stick.x, stick.y);
const rows = [];
for (let i = 0; i < 12; i++) {
  await touch('touchMove', stick.x, stick.y - 70);   // hold the stick fully up
  await sleep(600);
  const v = await ev('window.__view()');
  rows.push(v);
  const pct = Math.round(v.stadiumTop / v.bandY * 100);
  console.log(`  ${String(i * 0.6 + 0.6).padStart(4)}s ${String(v.camY).padStart(7)}   ${String(v.stadiumTop).padStart(3)}/${v.bandY} art px (${String(pct).padStart(3)}%)   ${'█'.repeat(Math.round(pct / 5)).padEnd(20, '·')}`);
}
await touch('touchEnd', stick.x, stick.y);
const first = rows[0].stadiumTop, last = rows[rows.length - 1].stadiumTop;
const monotonic = rows.every((r, i) => i === 0 || r.stadiumTop >= rows[i - 1].stadiumTop - 2);
let fails = 0; const ok = (c, m) => { console.log((c ? '  ✅ ' : '  ❌ ') + m); if (!c) fails++; };
console.log('');
ok(first < rows[0].bandY * 0.35, `starts mostly SKY (${first}/${rows[0].bandY} art px of stadium at midfield)`);
ok(last >= rows[0].bandY - 2, `ends fully STADIUM at the touchline (${last}/${rows[0].bandY})`);
ok(monotonic, 'the stadium arrives progressively — it descends rather than popping in');

// THE BAND MUST BE PURE SKY — the approved composition forbids world content in it, and standing ON the
// touchline is the worst case: that is where the terrace and grass used to bleed through. Pixels come from
// a CLIPPED SCREENSHOT decoded with _png.mjs, because the game canvas is tainted by cross-origin card art
// and getImageData() throws a SecurityError.
const vEnd = await ev('window.__view()');
const bandCss = Math.round(vEnd.bandY * 3.25 / (2732 / vEnd.vw <= 0 ? 2 : (2732 / vEnd.vw)));
const bandPx = Math.max(6, Math.round(vEnd.bandY * 3.25 / 2) - 6);   // inside the band, clear of its edge
const clipShot = async (y, h) => (await cdp('Page.captureScreenshot', { format: 'png', clip: { x: 0, y, width: vEnd.vw, height: h, scale: 1 } })).data;
const bandB64 = await clipShot(2, bandPx);
const { decodePng, share } = await import('./_png.mjs');
const bandImg = decodePng(Buffer.from(bandB64, 'base64'));
const turf = share(bandImg, (r, g, b) => g > r + 18 && g > b + 12 && g > 60);
const cloudy = share(bandImg, (r, g, b) => r > 190 && g > 200 && b > 210);
console.log(`\nband at the touchline (${bandImg.w}x${bandImg.h}px sampled): ${turf.pct}% turf-coloured, ${cloudy.pct}% cloud-white`);
ok(turf.pct < 1, `the band holds NO pitch and no stands — pure sky (${turf.pct}% turf-coloured)`);
ok(cloudy.pct > 2, `and it is actually composed sky, not a flat fill (${cloudy.pct}% cloud-white)`);
void bandCss;
console.log(fails ? `\n❌ ${fails} FAILED` : '\n✅ composition holds: pure sky band, stadium arrives in the window');
ws.close(); process.exit(0);
