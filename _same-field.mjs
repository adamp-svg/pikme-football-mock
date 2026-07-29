// Do the iPhone and the iPad show the SAME FIELD, with sky only in the iPad's extra proportion?
//
// Numbers alone (1212x560 on both) prove the geometry; this proves the PICTURE. Both devices are put at
// the same deterministic camera position — tutorial level 1 step 1 spawns the player at a fixed spot — and
// the PLAY WINDOW of each is captured, decoded, and reduced to a grid of mean colours. Same world region
// on screen => matching grids, even though the iPad renders it at a bigger scale (more pixels, same view).
// The canvas is tainted by cross-origin card art, so screenshots + _png.mjs are the only way to see pixels.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { WebSocket } from 'ws';
import { decodePng } from './_png.mjs';

const PAGE = process.env.URL || 'http://localhost:3012/', CDP = 9501;
const SHOTS = new URL('./_device-shots/', import.meta.url).pathname; mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=/tmp/samef-${process.pid}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
process.on('exit', () => { try { chrome.kill(); } catch {} });
let url; for (let i = 0; i < 60 && !url; i++) { try { const r = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json(); const p = r.filter(t => t.type === 'page'); if (p.length) url = p[0].webSocketDebuggerUrl; } catch {} if (!url) await sleep(250); }
const ws = new WebSocket(url); await new Promise(r => ws.once('open', r));
let id = 0; const pend = new Map();
ws.on('message', raw => { const m = JSON.parse(raw.toString()); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } });
const cdp = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('t/o ' + m)); } }, 25000); });
const ev = async e => (await cdp('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result.value;
await cdp('Page.enable'); await cdp('Runtime.enable');

let fails = 0; const ok = (c, m) => { console.log((c ? '  ✅ ' : '  ❌ ') + m); if (!c) fails++; };
const GRID_X = 16, GRID_Y = 8;
const grid = (img) => {                       // mean colour per cell, resolution-independent
  const out = [];
  for (let gy = 0; gy < GRID_Y; gy++) for (let gx = 0; gx < GRID_X; gx++) {
    const x0 = Math.floor(gx * img.w / GRID_X), x1 = Math.floor((gx + 1) * img.w / GRID_X);
    const y0 = Math.floor(gy * img.h / GRID_Y), y1 = Math.floor((gy + 1) * img.h / GRID_Y);
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
      const i = (y * img.w + x) * img.ch; r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; n++;
    }
    out.push([r / n, g / n, b / n]);
  }
  return out;
};

const capture = async (dev) => {
  await cdp('Emulation.setDeviceMetricsOverride', { width: dev.w, height: dev.h, deviceScaleFactor: dev.dpr, mobile: true });
  await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await cdp('Page.navigate', { url: PAGE }); await sleep(700);
  // Fresh tutorial, hub tour out of the way: level 1 step 1 spawns the player at a FIXED world spot, so
  // both devices end up with an identical camera — which is what makes the two pictures comparable.
  await ev(`(()=>{try{localStorage.setItem('fbHubTourSkipped','1');localStorage.setItem('fbHubTourDone','1');localStorage.removeItem('fbTutorialDoneSet');localStorage.removeItem('fbTutorialDone');localStorage.removeItem('fbTutorialSkipped');}catch{}return 1})()`);
  await cdp('Page.navigate', { url: PAGE }); await sleep(9500);
  const v = await ev('window.__view()');
  const dprReal = dev.dpr;
  const bandCss = v.bandY * 3.25 / dprReal;                 // ART px -> CSS px
  const winCss = v.playH * 3.25 / dprReal;
  const clip = { x: 0, y: Math.round(bandCss + 4), width: v.vw, height: Math.round(winCss - 8), scale: 1 };
  const b64 = (await cdp('Page.captureScreenshot', { format: 'png', clip })).data;
  writeFileSync(`${SHOTS}same-${dev.id}-window.png`, Buffer.from(b64, 'base64'));
  const full = (await cdp('Page.captureScreenshot', { format: 'png' })).data;
  writeFileSync(`${SHOTS}same-${dev.id}-full.png`, Buffer.from(full, 'base64'));
  return { v, img: decodePng(Buffer.from(b64, 'base64')) };
};

const PHONE = { id: 'iphone', name: 'iPhone 17 Pro', w: 844, h: 390, dpr: 2 };
const TABLET = { id: 'ipad11', name: 'iPad Pro 11"', w: 1194, h: 834, dpr: 2 };
const a = await capture(PHONE), b = await capture(TABLET);

console.log(`\n${PHONE.name}: window ${a.v.seesWorldW}x${a.v.seesWorldH} world units · band ${a.v.bandY} art px · captured ${a.img.w}x${a.img.h}px`);
console.log(`${TABLET.name}: window ${b.v.seesWorldW}x${b.v.seesWorldH} world units · band ${b.v.bandY} art px · captured ${b.img.w}x${b.img.h}px\n`);

ok(a.v.seesWorldW === b.v.seesWorldW && Math.abs(a.v.seesWorldH - b.v.seesWorldH) <= 1,
  `both see the same field: ${a.v.seesWorldW}x${a.v.seesWorldH} vs ${b.v.seesWorldW}x${b.v.seesWorldH} world units`);
ok(a.v.bandY === 0, `iPhone has NO sky — band ${a.v.bandY}`);
ok(b.v.bandY > 20, `iPad has sky only in its extra proportion — band ${b.v.bandY} art px each side`);

// Picture comparison: mean colour per cell, mean absolute difference across the grid.
const ga = grid(a.img), gb = grid(b.img);
let sum = 0, worst = 0;
for (let i = 0; i < ga.length; i++) {
  const d = (Math.abs(ga[i][0] - gb[i][0]) + Math.abs(ga[i][1] - gb[i][1]) + Math.abs(ga[i][2] - gb[i][2])) / 3;
  sum += d; worst = Math.max(worst, d);
}
const mad = sum / ga.length;
console.log(`\nplay-window picture: mean cell difference ${mad.toFixed(1)}/255, worst cell ${worst.toFixed(1)}/255 (${GRID_X}x${GRID_Y} grid)`);
ok(mad < 18, `the two windows show the SAME picture (mean difference ${mad.toFixed(1)}/255; sprites differ in size, the field does not)`);
console.log(`\nscreenshots: _device-shots/same-iphone-*.png · _device-shots/same-ipad11-*.png`);
console.log(fails ? `\n❌ ${fails} FAILED` : '\n✅ same field on both, sky only where the iPad is bigger');
ws.close(); process.exit(0);
