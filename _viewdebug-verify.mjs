// Prove the on-screen view readout (?viewdebug=1) works, on two real device metrics.
//
// What has to be true:
//   1. OFF by default (no #view-debug in a clean profile, no query param).
//   2. ?viewdebug=1 shows it, and every number in the DOM text equals window.__view().
//   3. It SURVIVES a URL that lost the param — the app rebuilds the WebView URL every launch
//      (?name=&avatar=&v=CACHE_BUST), so the localStorage key is the only thing that carries over.
//   4. ?viewdebug=0 turns it off and clears the key, and a later plain load stays off.
//   5. Zero layout shift: canvas size + document scroll size + a hub element rect are identical on/off.
// The canvas is tainted by cross-origin card art, so pixels come from screenshots + _png.mjs.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { WebSocket } from 'ws';
import { decodePng } from '/Users/adamleeperelman/Documents/pikeme/football-mock/_png.mjs';

const PAGE = process.env.URL || 'http://localhost:3012/';
const CDP = 9577;
const OUT = '/private/tmp/claude-501/-Users-adamleeperelman-Documents-pikeme/984e7843-a957-4d6b-97c1-5edee68d8436/scratchpad/shots/';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=/tmp/vdbg-${process.pid}`,
   '--no-first-run', '--disable-gpu', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
process.on('exit', () => { try { chrome.kill(); } catch {} });

let url;
for (let i = 0; i < 60 && !url; i++) {
  try { const r = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
        const p = r.filter(t => t.type === 'page'); if (p.length) url = p[0].webSocketDebuggerUrl; } catch {}
  if (!url) await sleep(250);
}
const ws = new WebSocket(url); await new Promise(r => ws.once('open', r));
let id = 0; const pend = new Map();
ws.on('message', raw => { const m = JSON.parse(raw.toString());
  if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } });
const cdp = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method: m, params: p }));
  setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('t/o ' + m)); } }, 25000); });
const ev = async e => (await cdp('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result.value;
await cdp('Page.enable'); await cdp('Runtime.enable');

let fails = 0;
const results = [];
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };

// Full shot at device resolution + a crop of just the block, then MEASURE the crop: pure-green glyphs on
// pure black inside a magenta frame. A block that failed to paint scores ~0% green, so this is a real
// legibility check and not an assertion. Pixels only ever come from screenshots — the canvas is tainted.
const shoot = async (dev, rect, tag) => {
  const fullBuf = Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).data, 'base64');
  writeFileSync(`${OUT}${dev.id}-${tag}-full.png`, fullBuf);
  const fi = decodePng(fullBuf);
  ok(fi.w === Math.round(dev.w * dev.dpr) && fi.h === Math.round(dev.h * dev.dpr),
     `${tag}: full shot is device-resolution ${fi.w}x${fi.h} (expected ${Math.round(dev.w * dev.dpr)}x${Math.round(dev.h * dev.dpr)})`);
  const crop = Buffer.from((await cdp('Page.captureScreenshot', { format: 'png', clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h, scale: 1 } })).data, 'base64');
  writeFileSync(`${OUT}${dev.id}-${tag}-overlay.png`, crop);
  const ci = decodePng(crop);
  let green = 0, black = 0, magenta = 0, other = 0;
  for (let i = 0; i < ci.data.length; i += ci.ch) {
    const R = ci.data[i], G = ci.data[i + 1], B = ci.data[i + 2];
    if (R < 60 && G > 180 && B < 60) green++;
    else if (R < 40 && G < 40 && B < 40) black++;
    else if (R > 180 && G < 60 && B > 180) magenta++;
    else other++;
  }
  const n = green + black + magenta + other;
  console.log(`  ${tag}: crop ${ci.w}x${ci.h} device px | green ${(green / n * 100).toFixed(1)}% black ${(black / n * 100).toFixed(1)}% magenta ${(magenta / n * 100).toFixed(1)}% other ${(other / n * 100).toFixed(1)}%`);
  ok(green / n > 0.03, `${tag}: glyph pixels present (${(green / n * 100).toFixed(1)}% pure green)`);
  ok(magenta / n > 0.01, `${tag}: magenta frame present (${(magenta / n * 100).toFixed(1)}%)`);
  ok(other / n < 0.10, `${tag}: nothing else bleeds into the block (${(other / n * 100).toFixed(1)}% non-palette px)`);
  return ci;
};

// Four viewports, because "the iPhone" is not one number. 844x390 is what every earlier measurement in
// this repo used and what the PLAY_H comment calls the reference phone; a real iPhone 17 Pro in landscape
// is 874x402. wbW = ceil(innerWidth * min(dpr,2) / 3.25), so a different width lands on a different
// ceil() and can land on a different `scale`. dpr is the other asymmetry: capped at 2 while a phone
// reports 3 and an iPad reports 2.
const DEVICES = [
  { id: 'iphone-ref',     label: 'ref 844x390 (dpr3)',   w: 844, h: 390, dpr: 3 },
  { id: 'iphone17pro',    label: 'iPhone 17 Pro (dpr3)', w: 874, h: 402, dpr: 3 },
  { id: 'iphone-max',     label: 'Pro Max 956x440(dpr3)', w: 956, h: 440, dpr: 3 },
  { id: 'ipadpro11',      label: 'iPad Pro 11 (dpr2)',   w: 1194, h: 834, dpr: 2 },
];

const go = async (u, waitMs = 2600) => { await cdp('Page.navigate', { url: u }); await sleep(waitMs); };
const PROBE_JS = `(function(){
  try {
    var box = function (el) { if (!el) return null; var r = el.getBoundingClientRect();
      return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)].join(','); };
    var e = document.getElementById('view-debug');
    var cs = e ? getComputedStyle(e) : null;
    var c = document.getElementById('canvas');
    var ls; try { ls = localStorage.getItem('fbViewDebug'); } catch (x) { ls = 'ERR'; }
    return {
      present: !!e,
      text: e ? e.textContent : null,
      rectStr: box(e),
      pe: cs ? cs.pointerEvents : null,
      pos: cs ? cs.position : null,
      fontPx: cs ? cs.fontSize : null,
      z: cs ? cs.zIndex : null,
      view: window.__view ? window.__view() : null,
      ls: ls,
      layout: {
        cw: c ? c.width : null, ch: c ? c.height : null,
        sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight,
        bw: document.body.scrollWidth, bh: document.body.scrollHeight,
        hub: box(document.querySelector('.hub')),
      },
    };
  } catch (err) { return { probeError: String(err) }; }
})()`;
const probe = async () => {
  const p = await ev(PROBE_JS);
  if (!p || p.probeError) throw new Error('probe failed: ' + (p && p.probeError));
  if (p.rectStr) { const [x, y, w, h] = p.rectStr.split(',').map(Number); p.rect = { x, y, w, h }; }
  return p;
};

for (const dev of DEVICES) {
  console.log(`\n=== ${dev.label}  ${dev.w}x${dev.h} dpr${dev.dpr} ===`);
  await cdp('Emulation.setDeviceMetricsOverride', { width: dev.w, height: dev.h, deviceScaleFactor: dev.dpr, mobile: true });
  await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

  // --- 1. OFF by default (clean storage, no param) --------------------------
  await go(PAGE, 1200);
  await ev(`(()=>{try{localStorage.clear()}catch{}return 1})()`);
  await go(PAGE);
  const off = await probe();
  ok(off.present === false, `off by default: #view-debug absent (present=${off.present}, ls=${off.ls})`);
  const baseline = off.layout;

  // --- 2. ?viewdebug=1 -----------------------------------------------------
  await go(PAGE + '?viewdebug=1');
  const on = await probe();
  ok(on.present === true, `?viewdebug=1 shows it (rect ${JSON.stringify(on.rect)}, font ${on.fontPx})`);
  ok(on.ls === '1', `the param persisted the key: localStorage.fbViewDebug=${JSON.stringify(on.ls)}`);
  ok(on.pos === 'fixed' && on.pe === 'none', `position=${on.pos} pointer-events=${on.pe}`);
  ok(JSON.stringify(on.layout) === JSON.stringify(baseline),
     `no layout shift: ${JSON.stringify(on.layout)} vs off ${JSON.stringify(baseline)}`);
  console.log('  --- on-screen text ---');
  for (const l of (on.text || '').split('\n')) console.log('  | ' + l);
  console.log('  --- window.__view() ---');
  console.log('  ' + JSON.stringify(on.view));

  // Every printed number must equal __view(). Checked field by field, not by eyeball.
  const v = on.view, T = on.text || '';
  const has = (s) => T.includes(s);
  ok(has(`${v.vw}×${v.vh}`), `text carries vw×vh = ${v.vw}×${v.vh}`);
  ok(has(`${v.wbW}×${v.wbH}`), `text carries wbW×wbH = ${v.wbW}×${v.wbH}`);
  ok(has(`scale ${v.scale}`), `text carries scale = ${v.scale}`);
  ok(has(`${v.playW}×${v.playH}`), `text carries playW×playH = ${v.playW}×${v.playH}`);
  ok(has(`${v.bandX},${v.bandY}art`), `text carries bandX,bandY = ${v.bandX},${v.bandY}`);
  ok(has(`${v.seesWorldW}×${v.seesWorldH}`), `text carries seesWorld = ${v.seesWorldW}×${v.seesWorldH}`);
  ok(/dpr \d/.test(T), `text carries dpr (line: ${T.split('\n')[0]})`);

  // --- screenshots at TRUE device scale (what a simulator screenshot is) ----
  // NOTE clip.scale is a multiplier ON TOP of the emulated deviceScaleFactor, so it must stay 1: with
  // scale:dpr the first run of this harness produced a 7866x3618 "iPhone" shot, i.e. 3x too big.
  await shoot(dev, on.rect, 'hub');

  // Glyph height in DEVICE px is what decides whether a human can read the screenshot.
  const glyphPx = Math.round(parseFloat(on.fontPx) * dev.dpr);
  ok(glyphPx >= 24, `glyph size in the screenshot = ${glyphPx} device px (${on.fontPx} CSS x dpr ${dev.dpr})`);

  // --- 3. survives a URL with NO param (the app's cache-busting relaunch) ---
  await go(`${PAGE}?name=Adam&avatar=https%3A%2F%2Fx%2Fa.png&v=${Date.now()}`);
  const survived = await probe();
  ok(survived.present === true, `survives the app-shaped URL (name/avatar/v=CACHE_BUST, no viewdebug): present=${survived.present}`);

  // --- 4. ?viewdebug=0 turns it off and clears the key ----------------------
  await go(PAGE + '?viewdebug=0');
  const offAgain = await probe();
  ok(offAgain.present === false && offAgain.ls === null, `?viewdebug=0 hides it and clears the key (present=${offAgain.present}, ls=${offAgain.ls})`);
  await go(PAGE);
  const stayOff = await probe();
  ok(stayOff.present === false, `stays off on the next plain load (present=${stayOff.present})`);

  // --- 5. the programmatic toggle -------------------------------------------
  const t1 = await ev(`(()=>{window.__viewDebug(true);const e=document.getElementById('view-debug');return {p:!!e,ls:localStorage.getItem('fbViewDebug')}})()`);
  ok(t1.p === true && t1.ls === '1', `__viewDebug(true) -> present=${t1.p} ls=${t1.ls}`);
  const t2 = await ev(`(()=>{window.__viewDebug(false);return {p:!!document.getElementById('view-debug'),ls:localStorage.getItem('fbViewDebug')}})()`);
  ok(t2.p === false && t2.ls === null, `__viewDebug(false) -> present=${t2.p} ls=${t2.ls}`);

  // --- 6. IN A MATCH — the only state where the numbers mean anything --------
  // resize() is called from exactly one place (the matchStart handler), so on the hub wb/scale/dpr are
  // still 1. The block says UNSIZED there on purpose. Same route _same-field.mjs uses: skip the hub tour,
  // clear the tutorial flags, and tutorial level 1 auto-starts with the player at a FIXED world spot — so
  // the two devices land on an identical camera and their `win` rects are directly comparable.
  await ev(`(()=>{try{localStorage.setItem('fbHubTourSkipped','1');localStorage.setItem('fbHubTourDone','1');
    localStorage.setItem('fbViewDebug','1');localStorage.removeItem('fbTutorialDoneSet');
    localStorage.removeItem('fbTutorialDone');localStorage.removeItem('fbTutorialSkipped');}catch{}return 1})()`);
  await go(PAGE, 9500);
  const inMatch = await probe();
  ok(inMatch.present === true, `in-match: block still up (present=${inMatch.present})`);
  ok((inMatch.text || '').startsWith('VIEW  sized'), `in-match: header says sized (got "${(inMatch.text || '').split('\n')[0]}")`);
  ok(inMatch.view.wbW > 1 && inMatch.view.scale !== 1, `in-match: resize() has run (wb ${inMatch.view.wbW}x${inMatch.view.wbH}, scale ${inMatch.view.scale})`);
  ok(inMatch.layout.cw === Math.round(dev.w * Math.min(dev.dpr, 2)),
     `in-match: canvas is ${inMatch.layout.cw}x${inMatch.layout.ch} (dpr capped at 2: expected width ${Math.round(dev.w * Math.min(dev.dpr, 2))})`);
  console.log('  --- on-screen text (IN MATCH) ---');
  for (const l of (inMatch.text || '').split('\n')) console.log('  | ' + l);
  console.log('  --- window.__view() (IN MATCH) ---');
  console.log('  ' + JSON.stringify(inMatch.view));
  const mv = inMatch.view, MT = inMatch.text || '';
  ok(MT.includes(`${mv.wbW}×${mv.wbH}`), `in-match text carries wbW×wbH = ${mv.wbW}×${mv.wbH}`);
  ok(MT.includes(`scale ${mv.scale}`), `in-match text carries scale = ${mv.scale}`);
  ok(MT.includes(`${mv.playW}×${mv.playH}`), `in-match text carries playW×playH = ${mv.playW}×${mv.playH}`);
  ok(MT.includes(`${mv.bandX},${mv.bandY}art`), `in-match text carries bandX,bandY = ${mv.bandX},${mv.bandY}`);
  ok(MT.includes(`${mv.seesWorldW}×${mv.seesWorldH}`), `in-match text carries seesWorld = ${mv.seesWorldW}×${mv.seesWorldH}`);
  await shoot(dev, inMatch.rect, 'match');
  results.push({ dev, view: mv, text: MT });

  await ev(`(()=>{try{localStorage.clear()}catch{}return 1})()`);
}

// Side by side, which is the whole reason the readout exists.
console.log('\n=== IN-MATCH COMPARISON (read this the way a screenshot of two simulators reads) ===');
console.log('device'.padEnd(23) + 'vw×vh'.padEnd(11) + 'wb'.padEnd(10) + 'scale'.padEnd(9) + 'play'.padEnd(10) + 'band'.padEnd(9) + 'window world rect');
for (const r of results) {
  const v = r.view, w = v.winWorld || {};
  console.log(r.dev.label.padEnd(23)
    + `${v.vw}×${v.vh}`.padEnd(11)
    + `${v.wbW}×${v.wbH}`.padEnd(10)
    + String(v.scale).padEnd(9)
    + `${v.playW}×${v.playH}`.padEnd(10)
    + `${v.bandX},${v.bandY}`.padEnd(9)
    + `${w.w}×${w.h} @${w.x},${w.y}`);
}
// The claim under test: every device shows the same world rect inside its window.
const rects = results.map(r => JSON.stringify(r.view.winWorld));
ok(new Set(rects).size === 1, `all ${results.length} devices show ONE window world rect (${new Set(rects).size} distinct)`);

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
ws.close();
process.exit(fails ? 1 : 0);
