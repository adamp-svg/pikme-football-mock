// HYPOTHESIS 2 UNDER TEST: "the dpr cap (Math.min(devicePixelRatio,2)) is the asymmetry that makes an
// iPhone (dpr 3) and an iPad (dpr 2) see different world regions."
//
// THE ONLY CONTROLLED EXPERIMENT that can answer it: hold the CSS viewport FIXED and vary ONLY
// deviceScaleFactor. Any difference in seesWorldW/seesWorldH is then caused by dpr and nothing else.
// Comparing an iPhone metric to an iPad metric confounds dpr with viewport and proves nothing about dpr.
//
// Measured IN A MATCH, because resize() is called from exactly one place (the matchStart handler) and on
// the hub every number is still at its initial 1x1/scale-1 value.
// The canvas is tainted by cross-origin card art -> pixels come from screenshots + _png.mjs.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { WebSocket } from 'ws';
import { decodePng } from './_png.mjs';

const PAGE = process.env.URL || 'http://localhost:3012/';
const CDP = 9581;
const OUT = '/private/tmp/claude-501/-Users-adamleeperelman-Documents-pikeme/984e7843-a957-4d6b-97c1-5edee68d8436/scratchpad/dpr/';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=/tmp/dprsweep-${process.pid}`,
   '--no-first-run', '--disable-gpu', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
process.on('exit', () => { try { chrome.kill(); } catch {} });

let wsurl;
for (let i = 0; i < 60 && !wsurl; i++) {
  try { const r = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
        const p = r.filter(t => t.type === 'page'); if (p.length) wsurl = p[0].webSocketDebuggerUrl; } catch {}
  if (!wsurl) await sleep(250);
}
const ws = new WebSocket(wsurl); await new Promise(r => ws.once('open', r));
let id = 0; const pend = new Map();
ws.on('message', raw => { const m = JSON.parse(raw.toString());
  if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } });
const cdp = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method: m, params: p }));
  setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('t/o ' + m)); } }, 30000); });
const ev = async e => (await cdp('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result.value;
await cdp('Page.enable'); await cdp('Runtime.enable');

// ---- the sweep -------------------------------------------------------------
// Group A: the reference phone viewport at every dpr including the two real ones (2 and 3) and one
//          BELOW the cap (1.5) so we can see the cap actually bite.
// Group B: the iPad viewport at the same dpr ladder. If dpr were the cause, iPad@3 would look like
//          iPhone@3 and unlike iPad@2.
const VIEWPORTS = [
  { id: 'phone844', w: 844, h: 390 },
  { id: 'phone874', w: 874, h: 402 },
  { id: 'ipad1194', w: 1194, h: 834 },
];
const DPRS = [1, 1.5, 2, 2.5, 3];

const PRIME = `(()=>{try{localStorage.setItem('fbHubTourSkipped','1');localStorage.setItem('fbHubTourDone','1');
  localStorage.setItem('fbViewDebug','1');localStorage.removeItem('fbTutorialDoneSet');
  localStorage.removeItem('fbTutorialDone');localStorage.removeItem('fbTutorialSkipped');}catch{}return 1})()`;

const PROBE = `(()=>{const c=document.getElementById('canvas');const e=document.getElementById('view-debug');
  return {view: window.__view?window.__view():null, cw:c?c.width:null, ch:c?c.height:null,
          dprRaw: devicePixelRatio, text: e?e.textContent:null,
          sized: c ? Math.abs(c.width - Math.round(innerWidth*Math.min(devicePixelRatio||1,2)))<=2 : null};})()`;

// Sky band boundary straight off the glass: the band is SKY (blue-dominant), the window below it is
// pitch/stadium (green or grey). Scan a column near the left edge (away from the HUD) and find the last
// blue-dominant row from the top. Returned in DEVICE px and converted to CSS px by the caller.
function skyBottomDevicePx(img, xFrac = 0.06) {
  const x = Math.floor(img.w * xFrac);
  let last = -1;
  for (let y = 0; y < img.h; y++) {
    const i = (y * img.w + x) * img.ch;
    const R = img.data[i], G = img.data[i + 1], B = img.data[i + 2];
    if (B > R + 8 && B > G + 4) last = y; else if (last >= 0 && y > last + 6) break;
  }
  return last;
}

const rows = [];
for (const vp of VIEWPORTS) {
  for (const dpr of DPRS) {
    await cdp('Emulation.setDeviceMetricsOverride', { width: vp.w, height: vp.h, deviceScaleFactor: dpr, mobile: true });
    await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await cdp('Page.navigate', { url: PAGE }); await sleep(1200);
    await ev(PRIME);
    await cdp('Page.navigate', { url: PAGE }); await sleep(11000);
    const p = await ev(PROBE);
    const tag = `${vp.id}-dpr${String(dpr).replace('.', '_')}`;
    let sky = null, shotW = null, shotH = null;
    try {
      const buf = Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).data, 'base64');
      writeFileSync(`${OUT}${tag}.png`, buf);
      const img = decodePng(buf); shotW = img.w; shotH = img.h;
      sky = skyBottomDevicePx(img);
    } catch (e) { sky = 'ERR ' + e.message; }
    const v = p.view || {};
    rows.push({ vp: vp.id, cssW: vp.w, cssH: vp.h, dpr, dprRaw: p.dprRaw, sized: p.sized,
                cw: p.cw, ch: p.ch, wbW: v.wbW, wbH: v.wbH, scale: v.scale,
                playW: v.playW, playH: v.playH, bandX: v.bandX, bandY: v.bandY,
                sees: `${v.seesWorldW}×${v.seesWorldH}`, seesW: v.seesWorldW, seesH: v.seesWorldH,
                win: v.winWorld, skyDev: sky, shot: `${shotW}x${shotH}`, text: p.text });
    console.log(`${tag}  sized=${p.sized}  canvas ${p.cw}x${p.ch}  wb ${v.wbW}x${v.wbH}  scale ${v.scale}  play ${v.playW}x${v.playH}  band ${v.bandX},${v.bandY}art  sees ${v.seesWorldW}x${v.seesWorldH}  win ${v.winWorld ? `${v.winWorld.w}x${v.winWorld.h}@${v.winWorld.x},${v.winWorld.y}` : 'n/a'}  skyBottom ${sky}dev`);
    await ev(`(()=>{try{localStorage.clear()}catch{}return 1})()`);
  }
}

console.log('\n=== SWEEP TABLE (CSS viewport fixed within a group; only dpr varies) ===');
console.log('viewport'.padEnd(10) + 'dpr'.padEnd(6) + 'canvas'.padEnd(12) + 'wb'.padEnd(11) + 'scale'.padEnd(9)
  + 'play(art)'.padEnd(12) + 'bandY art'.padEnd(11) + 'bandY css'.padEnd(11) + 'SEES(world)'.padEnd(13) + 'win world rect'.padEnd(26) + 'skyBottom css');
for (const r of rows) {
  const ART = 3.25, cap = Math.min(r.dpr, 2);
  const bandCss = r.bandY == null ? 'n/a' : (r.bandY * ART / cap).toFixed(1);
  const skyCss = typeof r.skyDev === 'number' && r.skyDev >= 0 ? (r.skyDev / r.dpr).toFixed(1) : String(r.skyDev);
  console.log(String(r.vp).padEnd(10) + String(r.dpr).padEnd(6) + `${r.cw}x${r.ch}`.padEnd(12)
    + `${r.wbW}x${r.wbH}`.padEnd(11) + String(r.scale).padEnd(9)
    + `${r.playW}x${r.playH}`.padEnd(12) + String(r.bandY).padEnd(11) + bandCss.padEnd(11)
    + r.sees.padEnd(13) + (r.win ? `${r.win.w}x${r.win.h}@${r.win.x},${r.win.y}` : 'n/a').padEnd(26) + skyCss);
}

console.log('\n=== VERDICT INPUTS ===');
for (const vp of VIEWPORTS) {
  const g = rows.filter(r => r.vp === vp.id);
  const seesSet = new Set(g.map(r => r.sees));
  const scaleSet = new Set(g.map(r => String(r.scale)));
  const winWH = new Set(g.map(r => r.win ? `${r.win.w}x${r.win.h}` : 'n/a'));
  console.log(`${vp.id} (${vp.w}x${vp.h}): distinct SEES across dpr ${[...DPRS].join('/')} = ${seesSet.size} -> ${[...seesSet].join(' | ')}`);
  console.log(`${vp.id}: distinct win w×h = ${winWH.size} -> ${[...winWH].join(' | ')}`);
  console.log(`${vp.id}: distinct scale = ${scaleSet.size} -> ${[...scaleSet].join(' | ')}   (scale is ART px/world = RESOLUTION)`);
}
const allSees = new Set(rows.map(r => r.sees));
console.log(`\nACROSS ALL ${rows.length} (viewport × dpr) combinations: distinct SEES = ${allSees.size} -> ${[...allSees].join(' | ')}`);

writeFileSync(OUT + 'rows.json', JSON.stringify(rows, null, 2));
ws.close();
process.exit(0);
