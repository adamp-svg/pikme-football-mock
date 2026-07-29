// Which way does the sky move when the camera pans? Convention in client.js: a world-fixed object is
// drawn at world_x*scale - camX, so raising camX moves the world LEFT. Distant sky must move LEFT too,
// only less. If it moves RIGHT, the parallax is inverted.
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
const CDP = 9497, PAGE = process.env.URL || 'http://127.0.0.1:3012/_sky-band.html';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=/tmp/skyp-${process.pid}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--window-size=1300,1200', 'about:blank'], { stdio: 'ignore' });
process.on('exit', () => { try { chrome.kill(); } catch {} });
let url; for (let i = 0; i < 60 && !url; i++) { try { const r = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json(); const p = r.filter(t => t.type === 'page'); if (p.length) url = p[0].webSocketDebuggerUrl; } catch {} if (!url) await sleep(250); }
const ws = new WebSocket(url); await new Promise(r => ws.once('open', r));
let id = 0; const pend = new Map();
ws.on('message', raw => { const m = JSON.parse(raw.toString()); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } });
const cdp = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('timeout ' + m)); } }, 20000); });
const ev = async e => (await cdp('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result.value;
await cdp('Page.enable'); await cdp('Runtime.enable');
await cdp('Page.navigate', { url: PAGE }); await sleep(2500);
// Freeze drift so only camX moves things.
await ev(`(()=>{const b=document.getElementById('motion'); if(b && b.getAttribute('aria-pressed')!=='true') b.click(); return 1})()`);
await sleep(400);

// Track SINGLE distinctive objects instead of the cloud field: clouds wrap through mod() and their
// centroid barely moves, which makes the sign hard to read. The red hot-air balloon and the blue ad
// blimp are each one object with a unique hue, so their centroid IS their position.
const centroid = (test) => `(() => {
  const c = document.getElementById('ipad'); const g = c.getContext('2d');
  const d = g.getImageData(0, 0, c.width, Math.round(c.height * 0.20)).data;
  let sum = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], gg = d[i+1], b = d[i+2];
    if (${test}) { sum += (i / 4) % c.width; n++; }
  }
  return n > 40 ? +(sum / n).toFixed(1) : null;
})()`;
const RED = centroid('r > 150 && gg < 110 && b < 100');      // hot-air balloon envelope
const BLUE = centroid('b > 150 && r < 110 && gg > 90 && gg < 160'); // blimp body
const setCam = async (v) => { await ev(`(()=>{const s=document.getElementById('cam-x'); s.value=${v}; s.dispatchEvent(new Event('input',{bubbles:true})); return 1})()`); await sleep(500); };

for (const [name, expr] of [['red hot-air balloon', RED], ['blue ad blimp', BLUE]]) {
  await setCam(-1000); const a = await ev(expr);
  await setCam(0);     const m = await ev(expr);
  await setCam(1000);  const b = await ev(expr);
  if (a == null || b == null) { console.log(`${name.padEnd(20)} not found (a=${a} b=${b})`); continue; }
  const d = +(b - a).toFixed(1);
  console.log(`${name.padEnd(20)} camX -1000 -> ${a} · 0 -> ${m} · +1000 -> ${b}   shift ${d > 0 ? '+' : ''}${d}px`);
  console.log(d < -2 ? '  ✅ moves LEFT as camX rises — same direction as the world, correct'
    : d > 2 ? '  ❌ moves RIGHT as camX rises — INVERTED against the world'
    : '  ⚠ barely moves — parallax coefficient may be too small to read');
}
ws.close(); process.exit(0);
