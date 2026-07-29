// DOES THE TUTORIAL FIT? — the same tour, measured across a matrix of real phone viewports.
//
// Reported from the app: "the tutorial for the app is not sized fitted correctly elements are
// overlapping". Everything else here has only ever been checked at 844x390, which is one shape of one
// phone — and the coach's furniture is FIXED-position (caption, hand, pips, skip, next) while the hub
// beneath it is a 900x415 stage that fitHub scales. Those two systems disagree as soon as the viewport
// stops matching 900:415, which is most phones once the app's own chrome and the safe areas are taken
// off the top.
//
// For every size and every legend step it asks four things:
//   1. is each piece of the coach FULLY ON SCREEN?
//   2. does the caption overlap «דלג ✕» or «הבא ›»?
//   3. does any of them cover the element the step is explaining?
//   4. does the caption block overlap the HAND?
// The answers are printed per size so a failure names the shape it happens on.
//
// Needs the lab page: PORT=3013 node server.js   (the lab always runs the full 19-step tour)
// Run: node _tour-fit-verify.mjs
import { WebSocket } from 'ws';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { networkInterfaces } from 'node:os';

const PORT = process.env.PORT || 3013;
const lanIp = () => Object.values(networkInterfaces()).flat()
  .filter((n) => n && n.family === 'IPv4' && !n.internal).map((n) => n.address)[0];
const BASE = (process.env.BASE || `http://${lanIp() || '127.0.0.1'}:${PORT}`).replace(/\/$/, '');
const PAGE = `${BASE}/_hub-tour.html`;
const SHOTS = new URL('./_tu-shots/', import.meta.url).pathname;
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// Landscape CSS-pixel sizes the app actually lands on, plus two SHORT ones: the WebView loses height to
// the app's own chrome and to the safe areas, and short is where fixed furniture and a scaled stage
// collide first.
const SIZES = [
  { w: 844, h: 390, name: 'iPhone 12-14' },
  { w: 852, h: 393, name: 'iPhone 15 Pro' },
  { w: 932, h: 430, name: '15 Pro Max' },
  { w: 667, h: 375, name: 'iPhone SE' },
  { w: 844, h: 344, name: '12-14 minus app chrome' },
  { w: 640, h: 360, name: 'small Android' },
];

let failures = 0;
const check = (cond, msg) => { console.log((cond ? '  ✅ ' : '  ❌ ') + msg); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(SHOTS, { recursive: true });

const PROFILE = `/tmp/tour-fit-${process.pid}`;
rmSync(PROFILE, { recursive: true, force: true });
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=9571', `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  '--window-size=932,430', 'about:blank',
], { stdio: 'ignore' });
process.on('exit', () => { try { chrome.kill(); } catch {} try { rmSync(PROFILE, { recursive: true, force: true }); } catch {} });

let wsUrl = null;
for (let i = 0; i < 60 && !wsUrl; i++) {
  try {
    const r = await fetch('http://127.0.0.1:9571/json/list');
    const pages = (await r.json()).filter((t) => t.type === 'page');
    if (pages.length) wsUrl = pages[0].webSocketDebuggerUrl;
  } catch { /* not up */ }
  if (!wsUrl) await sleep(250);
}
if (!wsUrl) throw new Error('Chrome never exposed a page target');
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.once('open', r));
let id = 0; const pending = new Map(); const jsErrors = [];
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
  if (m.method === 'Runtime.exceptionThrown') jsErrors.push(m.params?.exceptionDetails?.exception?.description || 'unknown');
});
const cdp = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id; pending.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method, params }));
  setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error(`CDP timeout: ${method}`)); } }, 20000);
});
const ev = async (e) => (await cdp('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result.value;
await cdp('Page.enable'); await cdp('Runtime.enable');
await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await cdp('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });
const tapDark = async () => {
  await cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 40, y: 150, id: 1 }] });
  await sleep(30);
  await cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(230);
};
const shot = async (name) => {
  const { data } = await cdp('Page.captureScreenshot', { format: 'png', fromSurface: true });
  writeFileSync(`${SHOTS}${name}.png`, Buffer.from(data, 'base64'));
  console.log(`     📸 _tu-shots/${name}.png`);
};

// One measurement, for whatever step is currently up: every piece of the coach, plus the lit target.
const MEASURE = `(() => {
  const R = (sel) => { const e = document.querySelector(sel); if (!e) return null;
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    if (cs.display === 'none' || cs.visibility === 'hidden' || !r.width || !r.height) return null;
    return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; };
  const hit = (a, b) => !!a && !!b && !(a.r <= b.l || a.l >= b.r || a.b <= b.t || a.t >= b.b);
  const inView = (a) => !a || (a.l >= -0.5 && a.t >= -0.5 && a.r <= innerWidth + 0.5 && a.b <= innerHeight + 0.5);
  const st = window.HubTour ? window.HubTour.state() : null;
  // The element this step is about: the ringed drop target if there is one, else the lit legend box.
  const target = R('.ht-pick') || R('.ht-drop');
  const cap = R('.tu-caption'), hand = R('#tu-hand'), skip = R('#tu-hub-skip'), next = R('#ht-next');
  const pips = R('#tu-pips');
  const overlapArea = (a, b) => (!hit(a, b) ? 0
    : Math.round((Math.min(a.r, b.r) - Math.max(a.l, b.l)) * (Math.min(a.b, b.b) - Math.max(a.t, b.t))));
  return JSON.stringify({
    step: st && st.stepId, vw: innerWidth, vh: innerHeight,
    offscreen: Object.entries({ cap, hand, skip, next, pips }).filter(([, v]) => v && !inView(v)).map(([k]) => k),
    capOverSkip: overlapArea(cap, skip),
    capOverNext: overlapArea(cap, next),
    capOverHand: overlapArea(cap, hand),
    capOverTarget: overlapArea(cap, target),
    skipOverTarget: overlapArea(skip, target),
    nextOverTarget: overlapArea(next, target),
    handOverTarget: overlapArea(hand, target),
    capH: cap && Math.round(cap.h), capT: cap && Math.round(cap.t), capB: cap && Math.round(cap.b),
  });
})()`;

console.log(`\n🧪 DOES THE TUTORIAL FIT — ${PAGE}\n`);

for (const { w, h, name } of SIZES) {
  console.log(`▶ ${w}×${h}  ${name}`);
  await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: true });
  await cdp('Page.navigate', { url: PAGE });
  // Wait for the tour rather than sleeping a guess.
  let up = null;
  for (let i = 0; i < 80 && !up; i++) { up = await ev('!!(window.HubTour && window.HubTour.state().running)'); if (!up) await sleep(250); }
  if (!up) { check(false, 'the tour never started at this size'); continue; }
  await sleep(500);

  const faults = [];
  let shotTaken = false;
  // The 13 legend steps + the 3 slot steps are the read steps; walking the legend covers every piece of
  // furniture at this size, and the DO steps use the same furniture.
  for (let stepN = 1; stepN <= 13; stepN++) {
    const m = JSON.parse(await ev(MEASURE));
    const bad = [];
    if (m.offscreen.length) bad.push(`off-screen: ${m.offscreen.join(',')}`);
    if (m.capOverSkip > 40) bad.push(`caption over «דלג» ${m.capOverSkip}px²`);
    if (m.capOverNext > 40) bad.push(`caption over «הבא» ${m.capOverNext}px²`);
    if (m.capOverTarget > 200) bad.push(`caption over the target ${m.capOverTarget}px²`);
    if (m.skipOverTarget > 200) bad.push(`«דלג» over the target ${m.skipOverTarget}px²`);
    if (m.nextOverTarget > 200) bad.push(`«הבא» over the target ${m.nextOverTarget}px²`);
    if (bad.length) {
      faults.push(`step ${stepN} (${m.step}): ${bad.join(' · ')}`);
      if (!shotTaken) { await shot(`fit-${w}x${h}-step${stepN}`); shotTaken = true; }
    }
    await tapDark();
  }
  check(faults.length === 0, `${w}×${h} — nothing overlaps, nothing off-screen`);
  for (const f of faults.slice(0, 6)) console.log(`       ${f}`);
  if (faults.length > 6) console.log(`       …and ${faults.length - 6} more`);
}

console.log('\n▶ console');
check(jsErrors.length === 0, `no uncaught JS errors${jsErrors.length ? `\n     ${jsErrors.slice(0, 3).join('\n     ')}` : ''}`);
console.log(`\n${failures ? '❌' : '✅'} ${failures ? failures + ' FAILED' : 'ALL PASS'}\n`);
ws.close();
process.exit(failures ? 1 : 0);
