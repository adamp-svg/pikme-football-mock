// DEVICE MATRIX — what the game actually looks like on every surface it ships to.
//
// Why this exists: "in an ipad its not good" is a layout report, and layout reports in this repo get
// SCREENSHOTTED, not argued about (see the pikme-football-verify-with-chrome convention and the
// _tu-verify.mjs harness this is modelled on). Every other harness here is pinned to ONE viewport —
// 844x390, the user's phone — so nothing in the repo has ever looked at a tablet, in either
// orientation. This drives the real client at each device's real CSS viewport, screenshots the hub and
// the in-match view, and MEASURES the things that go wrong when an aspect ratio changes:
//
//   * horizontal overflow (the page must never scroll sideways);
//   * anything overhanging the viewport (a control half off-screen is unusable, not just ugly);
//   * how much of the 2000x1100 pitch is actually on screen — the camera is built for a phone's
//     ~2.16 ratio, and an iPad is 1.33-1.43, so this is where a tablet diverges most;
//   * PORTRAIT. A phone is locked landscape by the app shell; an iPad is not, so portrait is a real
//     surface here and nothing has ever checked it.
//
// Needs a game server: PORT=3012 node server.js   (override with URL=/PORT=)
// Run: node _device-matrix.mjs            Screenshots land in ./_device-shots/
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { WebSocket } from 'ws';

const PORT = process.env.PORT || 3012;
const PAGE = process.env.URL || `http://localhost:${PORT}/`;
const CDP_PORT = Number(process.env.CDP_PORT || 9471);
const PROFILE = `/tmp/dev-matrix-profile-${process.pid}`;
const SHOTS = new URL('./_device-shots/', import.meta.url).pathname;
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// CSS viewports (points, not pixels) as iOS reports them. Landscape unless the name says otherwise.
const DEVICES = [
  { id: 'iphone-17-pro',   w: 844,  h: 390,  dpr: 3, label: 'iPhone 17 Pro (the reference surface)' },
  // ANDROID. Samsung's landscape height is SHORTER than the iPhone's (360-384 against 390), which
  // matters because the coach's furniture is sized in vh — a phone can be tighter than the reference,
  // not just a tablet roomier. Galaxy A-series is the volume seller and the smallest of the three.
  { id: 'galaxy-a15',      w: 800,  h: 360,  dpr: 3, label: 'Galaxy A15 / S24 (360dp tall)' },
  { id: 'galaxy-s24-ultra', w: 915, h: 412,  dpr: 3, label: 'Galaxy S24 Ultra' },
  { id: 'galaxy-tab-s9',   w: 1280, h: 800,  dpr: 2, label: 'Galaxy Tab S9 (Android tablet)' },
  { id: 'ipad-pro-11',     w: 1194, h: 834,  dpr: 2, label: 'iPad Pro 11" (for comparison)' },
  // PORTRAIT. The app shell locks the football screen to landscape, but expo-host.md is explicit that an
  // orientation lock is a HINT — iPadOS has been reported to ignore declared orientations outright, and
  // the LAN browser surface honours no lock at all. So portrait has to be measured, not assumed away: it
  // must stay correct (integer art pixels, the same 1212x560 window) even though it is cosmetically
  // band-heavy, because the width binds and the whole surplus becomes sky.
  { id: 'ipad-pro-11-port',  w: 834,  h: 1194, dpr: 2, label: 'iPad Pro 11" PORTRAIT' },
  { id: 'galaxy-tab-s9-port', w: 800, h: 1280, dpr: 2, label: 'Galaxy Tab S9 PORTRAIT' },
  { id: 'iphone-17-pro-port', w: 390, h: 844,  dpr: 3, label: 'iPhone 17 Pro PORTRAIT (browser only)' },
];

let failures = 0;
const notes = [];
const check = (cond, msg) => { console.log((cond ? '  ✅ ' : '  ❌ ') + msg); if (!cond) { failures++; notes.push(msg); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(SHOTS, { recursive: true });
rmSync(PROFILE, { recursive: true, force: true });

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  '--window-size=1400,1100', 'about:blank',
], { stdio: 'ignore' });
process.on('exit', () => { try { chrome.kill(); } catch {} rmSync(PROFILE, { recursive: true, force: true }); });

async function targetWs() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const pages = (await r.json()).filter((t) => t.type === 'page');
      if (pages.length) return pages[0].webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('Chrome never exposed a page target');
}
const ws = new WebSocket(await targetWs());
await new Promise((r) => ws.once('open', r));
let cdpId = 0;
const pending = new Map();
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
});
const cdp = (method, params = {}) => new Promise((res, rej) => {
  const id = ++cdpId; pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(`CDP timeout: ${method}`)); } }, 25000);
});
const evalJs = async (expr) => (await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.value;
const shot = async (name) => {
  const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${SHOTS}${name}.png`, Buffer.from(data, 'base64'));
  console.log(`     📸 _device-shots/${name}.png`);
};

await cdp('Page.enable');
await cdp('Runtime.enable');

// What overhangs the viewport, and by how much. Only VISIBLE, painted boxes count — the client keeps
// a lot of `.hidden` screens parked in the DOM and their rects are meaningless.
//
// CLIPPED ANCESTORS ARE SKIPPED, and that correction is the whole difference between a finding and a
// false alarm: the first run of this harness reported `.hub-pitch` overhanging by 117-191px on all six
// devices INCLUDING the phone the user says is fine. `.hub-pitch` is `left:-14%; right:-14%` on purpose,
// inside a wrapper with `overflow:hidden` — a deliberate bleed that is never visible past the edge. An
// overhang only matters if something can actually paint outside the window.
const OVERHANG = `(() => {
  const vw = innerWidth, vh = innerHeight, out = [];
  const clipped = (e) => {
    for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (s.overflow !== 'visible' || s.overflowX !== 'visible' || s.overflowY !== 'visible') return true;
    }
    return false;
  };
  for (const e of document.querySelectorAll('body *')) {
    const s = getComputedStyle(e);
    if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity === 0) continue;
    if (e.getClientRects().length === 0) continue;
    const r = e.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) continue;
    if (s.position === 'fixed' && r.width >= vw && r.height >= vh) continue;   // full-screen shades
    if (clipped(e)) continue;
    const over = Math.max(0, Math.round(r.right - vw), Math.round(-r.left), Math.round(r.bottom - vh), Math.round(-r.top));
    if (over > 2) out.push({ sel: e.id ? '#' + e.id : '.' + (e.className || '').toString().split(' ')[0], over });
  }
  return out.sort((a, b) => b.over - a.over).slice(0, 6);
})()`;

// How much of the pitch is on screen. The world is FIELD.W x FIELD.H (2000x1100) and the client picks
// a scale per frame; comparing the two ratios is what says whether a tablet sees more, less, or a
// differently-shaped slice of the pitch than the phone the game was tuned on.
// `#canvas` BY ID, never `querySelector('canvas')`: the hub has its own canvases (#home-char, the
// wardrobe FX, the picker preview) and the loose selector grabbed the 200x210 hub character, which is
// why the first run of this harness reported a "234x246 canvas" on every device.
const VIEWPORT_FACTS = `(() => {
  const c = document.getElementById('canvas');
  const r = c && c.getBoundingClientRect();
  return {
    vw: innerWidth, vh: innerHeight, ratio: +(innerWidth / innerHeight).toFixed(3),
    scrollW: document.documentElement.scrollWidth, scrollH: document.documentElement.scrollHeight,
    canvas: r ? { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) } : null,
    dpr: devicePixelRatio,
  };
})()`;

for (const d of DEVICES) {
  console.log(`\n=== ${d.label} — ${d.w}x${d.h} @${d.dpr}x ===`);
  await cdp('Emulation.setDeviceMetricsOverride', { width: d.w, height: d.h, deviceScaleFactor: d.dpr, mobile: true });
  await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await cdp('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });
  // A fresh profile does NOT land in the pitch tutorial, which the first run of this harness assumed:
  // hub-tour.js runs first (`client.js: HubTour.pending() && HubTour.begin(tuMaybeAutoStart)`) and only
  // hands over when it is finished or waved away, so every "in-match" measurement was really taken on
  // the hub with the tour's own overlay up. Waving the hub tour away first is what actually gets the
  // pitch on screen; its keys are hub-tour.js's DONE_KEY/SKIP_KEY.
  await cdp('Page.navigate', { url: PAGE });
  await sleep(600);
  await evalJs(`(()=>{try{localStorage.setItem('fbHubTourSkipped','1');localStorage.removeItem('fbTutorialDoneSet');localStorage.removeItem('fbTutorialDone');}catch{} return 1;})()`);
  await cdp('Page.navigate', { url: PAGE });
  await sleep(4500);   // tutorial level 1 auto-starts: room + first snapshot + the coach's first frame

  const facts = await evalJs(VIEWPORT_FACTS);
  console.log(`     viewport ${facts.vw}x${facts.vh} ratio ${facts.ratio} · canvas ${facts.canvas ? facts.canvas.w + 'x' + facts.canvas.h : 'none'}`);
  check(facts.scrollW <= facts.vw + 1, `no sideways scroll (scrollWidth ${facts.scrollW} vs ${facts.vw})`);

  const over = await evalJs(OVERHANG);
  check(over.length === 0, `nothing overhangs the viewport${over.length ? ' — worst: ' + over.map((o) => `${o.sel}+${o.over}px`).join(', ') : ''}`);

  if (facts.canvas) {
    // The canvas must FILL the screen: a pitch that leaves bars, or one wider than the window, is the
    // clearest single symptom of an aspect ratio the renderer was not built for.
    check(Math.abs(facts.canvas.w - facts.vw) <= 2 && Math.abs(facts.canvas.h - facts.vh) <= 2,
      `canvas fills the viewport (${facts.canvas.w}x${facts.canvas.h} at ${facts.canvas.x},${facts.canvas.y})`);
  }

  // THE PIXEL-ALIGNMENT INVARIANT. An art pixel must occupy a whole number of HARDWARE pixels. It did
  // not: a dpr cap of 2 meant a 3x phone rendered at 4.5 hardware px per art px while a 2x tablet got a
  // clean 3.0, so the grid wobbled on the phone and not on the tablet — a large part of what "the iPad
  // and the iPhone look different" actually was, once the camera window itself had been made identical.
  // __view() reports both the chosen factor and the one that reaches the glass; they must be equal (the
  // backing store IS the hardware) and integer. Measured on the pixels too — see the run-length check in
  // the commit that added this: every run in the pitch is a whole multiple of artPx.
  const view = await evalJs('window.__view ? window.__view() : null');
  if (view && view.hwPerArt != null) {
    check(Number.isInteger(view.hwPerArt) && view.hwPerArt === view.artPx,
      `art pixel lands on whole hardware pixels (artPx ${view.artPx}, hwPerArt ${view.hwPerArt})`);
    check(view.seesWorldW === 1212 && view.seesWorldH === 560,
      `play window is the fair 1212x560 (${view.seesWorldW}x${view.seesWorldH})`);
  }
  await shot(`${d.id}-01-boot`);

  // The coach's own furniture: caption + the two sticks. These are the elements sized off vh/vw, so a
  // tablet is exactly where the clamps stop being right.
  const ui = await evalJs(`(() => {
    const pick = (sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), fs: Math.round(parseFloat(getComputedStyle(e).fontSize)) }; };
    return { cap: pick('#tu-cap'), sub: pick('#tu-nudge'), stickL: pick('#stickL'), stickR: pick('#stickR'), veil: pick('#tu-veil') };
  })()`);
  console.log('     ui:', JSON.stringify(ui));
  if (ui.cap) {
    // Proportion, not absolute px: the same 31px heading that reads well on a 390-tall phone is a
    // caption in a 1024-tall tablet, which is the "too small on iPad" half of the same bug.
    const pct = +((ui.cap.fs / facts.vh) * 100).toFixed(1);
    check(pct >= 5 && pct <= 11, `caption is ${ui.cap.fs}px = ${pct}% of the screen height (want 5-11%)`);
  }
  // BOTH sticks must actually EXIST before their insets mean anything. Tutorial level 1 step 1 enables
  // the move stick only, so `#stickR` is display:none with a 0x0 rect — and a zero-width right stick
  // made the "right inset" the full viewport width, which this harness first reported as every device
  // failing, phone included. A control that is deliberately not on screen is not a layout finding.
  if (ui.stickL && ui.stickR && ui.stickL.w > 0 && ui.stickR.w > 0) {
    check(ui.stickL.y + ui.stickL.h <= facts.vh + 2 && ui.stickR.y + ui.stickR.h <= facts.vh + 2,
      'both sticks sit inside the bottom edge');
    // On a phone the sticks are near the corners. On a tablet a fixed px inset leaves them marooned in
    // the middle of a much wider screen, out of thumb reach — measure the gap rather than eyeball it.
    const leftGap = ui.stickL.x, rightGap = facts.vw - (ui.stickR.x + ui.stickR.w);
    console.log(`     stick insets: left ${Math.round(leftGap)}px · right ${Math.round(rightGap)}px (${((leftGap / facts.vw) * 100).toFixed(1)}% / ${((rightGap / facts.vw) * 100).toFixed(1)}%)`);
    check(leftGap / facts.vw < 0.12 && rightGap / facts.vw < 0.12, 'sticks stay within a thumb of the side edges (<12% inset)');
  }

  // ...and the HUB, the other screen a tablet owner spends time on. Marking the tutorial done and
  // reloading is the shortest honest route to it (same thing finishing it does).
  await evalJs(`(()=>{try{localStorage.setItem('fbTutorialDoneSet', JSON.stringify(['basics','combat','tricks']));localStorage.setItem('fbTutorialDone','1');}catch{} return 1;})()`);
  await cdp('Page.navigate', { url: PAGE });
  await sleep(3000);
  const hubFacts = await evalJs(VIEWPORT_FACTS);
  const hubOver = await evalJs(OVERHANG);
  check(hubFacts.scrollW <= hubFacts.vw + 1, `hub: no sideways scroll (${hubFacts.scrollW} vs ${hubFacts.vw})`);
  check(hubOver.length === 0, `hub: nothing overhangs${hubOver.length ? ' — worst: ' + hubOver.map((o) => `${o.sel}+${o.over}px`).join(', ') : ''}`);
  await shot(`${d.id}-02-hub`);
}

console.log(`\n${failures ? '❌ ' + failures + ' FINDING(S)' : '✅ every device clean'}`);
if (failures) { console.log('\nFindings:'); notes.forEach((n) => console.log('  · ' + n)); }
console.log(`Screenshots: _device-shots/`);
ws.close();
process.exit(0);
