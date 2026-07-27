// LEVEL 4 «מרכז» (the hub tour) — REAL-BROWSER verification (Chrome via CDP, no puppeteer).
//
// Separate from _tu-verify.mjs on purpose: that file drives the PITCH levels and is being edited
// by another agent in parallel, and a new file cannot conflict on merge.
//
// What only a browser can prove here:
//   • the mock lobby really covers the hub, and its controls latch their own steps;
//   • the hand lands on mock furniture (the coach was written for sticks on a canvas);
//   • the handover: the mock DISMISSES for the finale and the real ⚽ is the live target;
//   • the gate makes the rest of the real hub inert for that finale — .tu-off would have left it
//     clickable, which is the corner-tap bug (76686d6) all over again;
//   • and that the tutorial writes NOTHING — saveLoadout/saveCosmetic reach postPrefs(), which the
//     app persists under the player's phone number, so a leak is a leak into their real account.
//
// Needs a game server: PORT=3014 node server.js   (override with URL=/PORT=)
// Run: node _tu-hub-verify.mjs      Screenshots land in ./_tu-shots/
import { WebSocket } from 'ws';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { networkInterfaces } from 'node:os';

const PORT = process.env.PORT || 3014;
// NOT localhost. DEV_LOCAL is true for localhost/127.0.0.1/0.0.0.0 and hands the client a sample
// album plus dev defaults, which is a different surface from the one a kid uses — the first run of
// this script passed its empty-album checks vacuously for exactly that reason.
// Resolved at RUNTIME rather than hardcoded: this machine changed networks mid-session and a
// pinned IP simply stopped answering.
const lanIp = () => Object.values(networkInterfaces()).flat()
  .filter((n) => n && n.family === 'IPv4' && !n.internal).map((n) => n.address)[0];
const HOST = process.env.HOST || lanIp() || 'localhost';
const PAGE = process.env.URL || `http://${HOST}:${PORT}/`;
const CDP_PORT = Number(process.env.CDP_PORT || 9414);
const PROFILE = `/tmp/tu-hub-verify-${process.pid}`;   // fresh profile => genuinely empty localStorage
const SHOTS = new URL('./_tu-shots/', import.meta.url).pathname;
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

let failures = 0;
const check = (cond, msg) => { console.log((cond ? '  ✅ ' : '  ❌ ') + msg); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(SHOTS, { recursive: true });
rmSync(PROFILE, { recursive: true, force: true });

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  '--window-size=844,390', 'about:blank',
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
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(`CDP timeout: ${method}`)); } }, 20000);
});
const evalJs = async (expr) => (await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.value;
const shot = async (name) => {
  const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${SHOTS}${name}.png`, Buffer.from(data, 'base64'));
  console.log(`     📸 _tu-shots/${name}.png`);
};

await cdp('Page.enable');
await cdp('Runtime.enable');
// Console errors are evidence, not noise. A step machine that throws every frame still looks
// "running" from the outside — the rAF chain reschedules before the body runs — so without this a
// dead loop reads as a passing state check.
const jsErrors = [];
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params?.exceptionDetails;
    jsErrors.push(d?.exception?.description || d?.text || 'unknown');
  }
});
await cdp('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 2, mobile: true });
await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await cdp('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });

const touch = (type, x, y) => cdp('Input.dispatchTouchEvent', {
  type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }],
});
const rectOf = (sel) => evalJs(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,w:r.width,h:r.height};})()`);
const vis = (sel) => evalJs(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return 'missing';const s=getComputedStyle(e);return (s.display!=='none'&&s.visibility!=='hidden'&&e.getClientRects().length)?'shown':'hidden';})()`);
const text = (sel) => evalJs(`(document.querySelector(${JSON.stringify(sel)})||{}).textContent||''`);
const cap = async () => (await text('#tu-cap')).trim();
// 'missing' is not 'hidden'. When the tour correctly never launches, the mock element was never
// built at all — so an `=== 'hidden'` check fails on a PASS. Ask the question actually meant.
const notShown = async (sel) => (await vis(sel)) !== 'shown';
// Wait for the step machine to actually be running rather than sleeping a guessed interval: the
// tour launches asynchronously (it waits for the socket's welcome and for #home to be up), and a
// fixed sleep races it — which is exactly what made 'the coach launched itself' flap.
async function waitForTour(ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const st = await evalJs('window.__tuHubState && window.__tuHubState()');
    if (st && st.on) return st;
    await sleep(150);
  }
  return null;
}
async function tap(sel) {
  const r = await rectOf(sel);
  if (!r) throw new Error(`no element ${sel}`);
  await touch('touchStart', r.x, r.y);
  await sleep(40);
  await touch('touchEnd', r.x, r.y);
  await sleep(400);
}
// A real drag: press one element, travel to another, release there.
async function dragTo(fromSel, toSel) {
  const a = await rectOf(fromSel), b = await rectOf(toSel);
  if (!a || !b) throw new Error(`missing ${fromSel} or ${toSel}`);
  await touch('touchStart', a.x, a.y);
  for (let i = 1; i <= 12; i++) {
    await touch('touchMove', a.x + (b.x - a.x) * (i / 12), a.y + (b.y - a.y) * (i / 12));
    await sleep(30);
  }
  await touch('touchEnd', b.x, b.y);
  await sleep(500);
}
// Is the coach's spotlight actually ON the element it claims? --tu-x/--tu-y is where the coach
// aimed; assert that point falls inside the target's own rect.
const spotInside = (sel) => evalJs(`(()=>{
  const t=document.getElementById('tutorial'), s=document.querySelector(${JSON.stringify(sel)});
  if(!t||!s) return null;
  const cs=getComputedStyle(t);
  const x=parseFloat(cs.getPropertyValue('--tu-x')), y=parseFloat(cs.getPropertyValue('--tu-y'));
  const r=s.getBoundingClientRect();
  if(!r.width) return null;
  return {inside: x>=r.x && x<=r.right && y>=r.y && y<=r.bottom, x, y, r:{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}};
})()`);

// =======================================================================================
console.log(`\n1) ENTRY — level 1 done: the hub tour launches itself onto a MOCK lobby (${PAGE})`);
await cdp('Page.navigate', { url: PAGE });
await sleep(3000);
await evalJs(`localStorage.setItem('fbTuDone','basics'); localStorage.removeItem('fbTuHubSkipped'); localStorage.removeItem('pikme-loadout'); localStorage.removeItem('pikme_cosmetic');`);
await cdp('Page.addScriptToEvaluateOnNewDocument', {
  source: `window.__leaks=[]; window.ReactNativeWebView={postMessage:(m)=>window.__leaks.push(m)};`,
});
await cdp('Page.navigate', { url: PAGE });
// Wait for the machine, not the clock. Step 1 is also a 2.5s dwell that advances ITSELF, so a
// long settle would sail straight past the caption being asserted here.
const launched = await waitForTour();
{
  check(await evalJs('!!window.__leaks') === true, 'the app-bridge stub is installed');
  check(!!launched, `the coach launched itself — no tap needed (${JSON.stringify(launched)})`);
  check(await vis('#tutorial') === 'shown', `the coach overlay is on screen (classes: ${await evalJs("document.getElementById('tutorial').className")})`);
  check(jsErrors.length === 0, `no JS errors so far (${jsErrors.slice(0, 2).join(' | ') || 'none'})`);
  check(await vis('#tu-mock') === 'shown', 'the MOCK lobby is up');
  check(await cap() === 'גביעים', `step 1 caption is «גביעים» (got «${await cap()}»)`);
  await shot('h01-trophies');
}

console.log('2) THE MOCK COVERS THE REAL HUB — nothing real is reachable during the lesson');
{
  const covers = await evalJs(`(()=>{const m=document.getElementById('tu-mock');if(!m)return false;const r=m.getBoundingClientRect();return r.width>=innerWidth-1 && r.height>=innerHeight-1;})()`);
  check(covers === true, 'the mock fills the viewport');
  // The honest test of "unreachable": what does a tap at the real button's coordinates actually hit?
  const hit = await evalJs(`(()=>{const b=document.getElementById('quick-match-btn');if(!b)return 'no button';const r=b.getBoundingClientRect();const e=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return e?(e.closest('#tu-mock')?'mock':(e.id||e.className)):'nothing';})()`);
  check(hit === 'mock', `a tap where the real ⚽ sits lands on the mock instead (${hit})`);
  check(await evalJs(`document.querySelectorAll('#tum-deck .tum-card').length`) === 3, 'the mock deck has three cards');
  check(await evalJs(`document.querySelectorAll('#tum-slots .tum-slot:not(.tum-full)').length`) === 3, 'all three mock slots start empty');
}

console.log('3) STEP 1 — the trophy bar is a DWELL: nothing to tap, so watching it is the lesson');
{
  const sp = await spotInside('#tum-trophies');
  check(!!sp && sp.inside, `the coach points inside the mock trophy bar (${sp ? `${Math.round(sp.x)},${Math.round(sp.y)} in ${JSON.stringify(sp.r)}` : 'no rect'})`);
  await sleep(3200);   // the 2.5s dwell, measured from launch rather than from page load
  check(await cap() === 'הקלפים שלך', `advanced on its own, with no input at all (got «${await cap()}»)`);
  await shot('h02-deck');
}

console.log('4) STEP 2 — the deck: tap a card and it is picked up');
{
  const sp = await spotInside('#tum-deck');
  check(!!sp && sp.inside, 'the coach points inside the mock deck');
  await tap('#tum-deck .tum-card[data-c="1"]');
  check(await evalJs(`!!document.querySelector('.tum-card.tum-picked')`) === true, 'the card visibly comes up — a kid can see what they are holding');
  check(await cap() === 'גרור לכאן', `advanced to the slots step (got «${await cap()}»)`);
  await shot('h03-slots');
}

console.log('5) STEP 3 — the slots: put the card in');
{
  const sp = await spotInside('#tum-slots');
  check(!!sp && sp.inside, 'the coach points inside the mock slots');
  await dragTo('#tum-deck .tum-card[data-c="1"]', '#tum-slots .tum-slot[data-s="0"]');
  const full = await evalJs(`document.querySelectorAll('#tum-slots .tum-slot.tum-full').length`);
  check(full >= 1, `a slot is filled (${full})`);
  check(await cap() === 'החלף מראה', `advanced to the hero step (got «${await cap()}»)`);
  await shot('h04-hero');
}

console.log('6) STEPS 4-5 — hero and friends, both on the mock, both visibly DO something');
{
  const before = await text('#tum-hero .tum-hero-ic');
  await tap('#tum-hero');
  check((await text('#tum-hero .tum-hero-ic')) !== before, 'tapping the hero changes it — the tap has a visible consequence');
  check(await cap() === 'שחק עם חבר', `advanced to the friends step (got «${await cap()}»)`);
  await tap('#tum-friends');
  // Read the CLASS, not visibility: by the time this runs the step has advanced and the whole mock
  // has been dismissed, so a visibility check would be measuring the handover, not the friends row.
  check(await evalJs(`!document.getElementById('tum-friendrow').classList.contains('hidden')`) === true, 'tapping friends reveals a friends row');
  await sleep(400);
  check(await cap() === 'קדימה!', `advanced to the finale (got «${await cap()}»)`);
  await shot('h05-play');
}

console.log('7) THE HANDOVER — the mock dismisses and the FINALE points at the real ⚽');
{
  check(await vis('#tu-mock') === 'hidden', 'the mock is gone');
  check(await vis('#home') === 'shown', 'the real hub is back');
  const sp = await spotInside('#quick-match-btn');
  check(!!sp && sp.inside, `the coach points inside the REAL quick-match button (${sp ? `${Math.round(sp.x)},${Math.round(sp.y)}` : 'no rect'})`);
  // "Inside the target" is not enough on its own: the target itself can be off-screen. It WAS —
  // the hub carried a stale scale-to-fit while the mock covered it, putting the button at x=1457
  // in an 844px viewport, so the tap that ends the tutorial was unreachable and the hand pointed
  // faithfully at nothing.
  const onScreen = await evalJs(`(()=>{const b=document.getElementById('quick-match-btn');const r=b.getBoundingClientRect();return r.x>=0&&r.y>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1;})()`);
  check(onScreen === true, 'and that button is actually ON SCREEN — a hand can point faithfully at something unreachable');
  const under = await evalJs(`(()=>{const b=document.getElementById('quick-match-btn');const r=b.getBoundingClientRect();const e=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return e?(e.closest('#quick-match-btn')?'the button':(e.id||e.tagName)):'nothing';})()`);
  check(under === 'the button', `a tap at its centre lands on the button (${under})`);
  check(await evalJs(`document.body.classList.contains('hub-tu-gate')`) === true, 'the gate is on for the real hub');
  const pe = await evalJs(`getComputedStyle(document.getElementById('hub-settings')).pointerEvents`);
  check(pe === 'none', `⚙ is untappable (${pe}) — .tu-off alone would have left it clickable`);
  const live = await evalJs(`getComputedStyle(document.getElementById('quick-match-btn')).pointerEvents`);
  check(live === 'auto', `but the real ⚽ IS tappable (${live})`);
  await shot('h06-handover');
}

console.log('8) THE FINALE — the ⚽ tap ends the lesson AND starts a real match');
{
  await tap('#quick-match-btn');
  await sleep(1800);
  const done = await evalJs(`localStorage.getItem('fbTuDone')||''`);
  check(done.includes('mercaz'), `the level is recorded as done (${done})`);
  check(await evalJs(`document.body.classList.contains('hub-tu-gate')`) === false, 'the gate is gone');
  check(await vis('#tutorial') === 'hidden', 'the coach is gone');
  check(await vis('#tu-mock') === 'hidden', 'the mock is gone');
  // Assert the STATE MACHINE, not a side effect. An earlier version of this check read a search
  // button's display and reported a match had started when nothing had been tapped at all — a
  // stuck step machine passing as a success.
  const st = await evalJs('window.__tuHubState && window.__tuHubState()');
  check(!!st && st.on === false, `the tour has ended (${JSON.stringify(st)})`);
  check(!!st && st.ev === null || (st && st.ev && st.ev.played === true), 'the finale tap was registered');
  await shot('h07-after');
}

console.log('9) THE TUTORIAL WROTE NOTHING');
{
  const loadout = await evalJs(`localStorage.getItem('pikme-loadout')`);
  const cosmetic = await evalJs(`localStorage.getItem('pikme_cosmetic')`);
  check(loadout === null, `pikme-loadout was never written (${JSON.stringify(loadout)})`);
  check(cosmetic === null, `pikme_cosmetic was never written (${JSON.stringify(cosmetic)})`);
  const leaks = await evalJs(`(window.__leaks||[]).filter(m=>String(m).includes('prefs')).length`);
  check(leaks === 0, `nothing was posted to the app bridge (${leaks} prefs message(s))`);
}

console.log('10) SKIP + PICKER — it can be dismissed, and it is a level like any other');
{
  await evalJs(`localStorage.setItem('fbTuDone','basics'); localStorage.removeItem('fbTuHubSkipped');`);
  await cdp('Page.navigate', { url: PAGE });
  await sleep(2500);
  check(await vis('#tu-hub-skip') === 'shown', 'a skip button exists — the gate would otherwise trap a kid on a lesson');
  await tap('#tu-hub-skip');
  check(await notShown('#tu-mock'), 'skipping dismisses the mock');
  check(await evalJs(`document.body.classList.contains('hub-tu-gate')`) === false, 'and lifts the gate, so the hub is usable');
  check((await evalJs(`localStorage.getItem('fbTuDone')||''`)).includes('mercaz') === false, 'skipping is NOT finishing — it stays available to take properly');
  await cdp('Page.navigate', { url: PAGE });
  await sleep(2500);
  check(await notShown('#tu-mock'), 'and it does not ambush them again on the next load');

  await evalJs(`localStorage.setItem('fbTuDone','basics,combat,tricks,mercaz')`);
  await cdp('Page.navigate', { url: PAGE });
  await sleep(2500);
  await tap('#training-btn');
  await tap('#tc-howto');
  await sleep(400);
  const levels = await evalJs(`[...document.querySelectorAll('#tu-levels .tu-lv')].map(b=>b.textContent.trim())`);
  check(Array.isArray(levels) && levels.length === 4, `four levels in the picker (${Array.isArray(levels) ? levels.length : 'none'})`);
  check(Array.isArray(levels) && /מרכז/.test(levels[3] || ''), `מרכז is listed: «${Array.isArray(levels) ? levels[3] : ''}»`);
  await shot('h08-picker');
}

check(jsErrors.length === 0, `no JS errors during the whole run (${jsErrors.slice(0, 3).join(' | ') || 'none'})`);
console.log(failures === 0 ? '\n✅ ALL PASS' : `\n❌ ${failures} FAILED`);
try { chrome.kill(); } catch {}
process.exit(failures ? 1 : 0);
