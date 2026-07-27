// LEVEL 4 «מרכז» (the hub tour) — REAL-BROWSER verification (Chrome via CDP, no puppeteer).
//
// Separate from _tu-verify.mjs on purpose: that file drives the PITCH levels and is being edited
// by another agent in parallel, and a new file cannot conflict on merge.
//
// What only a browser can prove here:
//   • the hand lands ON hub furniture (the coach was written for sticks on a canvas);
//   • the gate really makes the rest of the hub inert — .tu-off would have left it clickable;
//   • the demo album shows up at all (renderCarousel hides an empty carousel outright);
//   • and THE SANDBOX: that a lesson which equips cards and changes hero writes nothing. That is
//     the one that matters — saveLoadout/saveCosmetic reach postPrefs(), which the app persists
//     under the player's phone number, so a leak here is a leak into their real account.
//
// Needs a game server: PORT=3014 node server.js   (override with URL=/PORT=)
// Run: node _tu-hub-verify.mjs      Screenshots land in ./_tu-shots/
import { WebSocket } from 'ws';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';

const PORT = process.env.PORT || 3014;
// NOT localhost: DEV_LOCAL is true for localhost/127.0.0.1/0.0.0.0 and hands the client a sample
// album, which hides the empty-album path this level exists for. The first run of this script
// passed the demo checks vacuously for exactly that reason. LAN IP => genuinely no cards.
const HOST = process.env.HOST || '192.168.200.84';
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
console.log(`\n1) ENTRY — level 1 done, empty album: the hub tour launches itself (${PAGE})`);
await cdp('Page.navigate', { url: PAGE });
await sleep(3500);
// Level 1 finished, nothing else. This is the exact state a kid is in the moment they first
// reach the hub — and the state the exemption exists for (מרכז must not wait for קרב/טריקים).
await evalJs(`localStorage.setItem('fbTuDone','basics'); localStorage.removeItem('fbTuHubSkipped'); localStorage.removeItem('pikme-loadout'); localStorage.removeItem('pikme_cosmetic');`);
// Capture anything the page tries to send the APP. This is the leak that matters: the app writes
// prefs to the server under the player's phone number.
await cdp('Page.addScriptToEvaluateOnNewDocument', {
  source: `window.__leaks=[]; window.ReactNativeWebView={postMessage:(m)=>window.__leaks.push(m)};`,
});
await cdp('Page.navigate', { url: PAGE });
// Short: step 1 is a 2.5s dwell that advances ITSELF, so a long settle would sail past the very
// caption being asserted. (It did, on the first run of this script.)
await sleep(2200);
{
  check(await evalJs('!!window.__leaks') === true, 'the app-bridge stub is installed');
  check(await vis('#home') === 'shown', 'we are on the hub');
  check(await vis('#tutorial') === 'shown', 'the coach launched itself — no tap needed');
  check(await evalJs(`document.body.classList.contains('hub-tu-gate')`) === true, 'the hub gate is on');
  check(await cap() === 'גביעים', `step 1 caption is «גביעים» (got «${await cap()}»)`);
  await shot('h01-trophies');
}

console.log('2) THE DEMO ALBUM — an empty album still has something to teach on');
{
  check(await vis('#home-carousel') === 'shown', 'the carousel is on screen (renderCarousel hides an EMPTY one outright)');
  check(await evalJs(`document.querySelectorAll('#home-carousel .cf-card.cf-demo').length`) === 3, 'three demo cards');
  check(await evalJs(`getComputedStyle(document.querySelector('.cf-card.cf-demo'),'::after').content.includes('דוגמה')`) === true,
    'each is marked «דוגמה» — a kid is not shown cards they do not own without being told');
  // The effectiveLoadout() trap: with a null loadout it auto-fills the best three, which would
  // fill every slot before the drag step began and complete it on arrival.
  check(await evalJs(`document.querySelectorAll('#power-slots .pslot.pslot-empty').length`) === 3,
    'all three slots arrive EMPTY, so the drag step has something to teach');
}

console.log('3) THE GATE — everything except the live target is inert');
{
  check(await evalJs(`[...document.querySelectorAll('.tu-live')].length > 0`) === true, 'a live target is whitelisted');
  await tap('#hub-settings');
  check(await vis('#home') === 'shown', 'tapping ⚙ mid-lesson does not leave the hub (dimmed AND untappable)');
  await tap('.hub-sat[data-open-screen="shop"]');
  check(await vis('#home') === 'shown', 'tapping 🛒 חנות does not leave the hub either');
  const pe = await evalJs(`getComputedStyle(document.getElementById('hub-settings')).pointerEvents`);
  check(pe === 'none', `⚙ really has pointer-events:none (${pe}) — .tu-off alone would have left it clickable`);
}

console.log('4) STEP 1 — the trophy bar is a DWELL: it cannot be tapped, so watching it is the lesson');
{
  await sleep(2000);                       // let the 2.5s dwell finish
  check(await cap() === 'הקלפים שלך', `advanced to the deck step on its own, with no input at all (got «${await cap()}»)`);
  await shot('h02-deck');
}

console.log('5) STEP 2 — the deck: a real swipe on the carousel');
{
  const s = await spotInside('#home-carousel');
  check(!!s && s.inside, 'the coach points inside the carousel');
  const cards = await evalJs(`document.querySelectorAll('#home-carousel .cf-card').length`);
  check(cards >= 2, `something to swipe between (${cards} cards)`);
  // A real SWIPE — the gesture the caption teaches. (A tap that moves the stack also counts, via
  // the loop's tap-to-move check, but the swipe is what «החלק» is asking for.)
  const cr = await rectOf('#home-carousel');
  await touch('touchStart', cr.x + 60, cr.y);
  for (let i = 1; i <= 10; i++) { await touch('touchMove', cr.x + 60 - i * 14, cr.y); await sleep(25); }
  await touch('touchEnd', cr.x - 80, cr.y);
  await sleep(900);
  check(await cap() === 'גרור לכאן', `advanced to the slots step (got «${await cap()}»)`);
  await shot('h03-slots');
}

console.log('6) STEP 3 — the slots: DRAG a card in, the real gesture');
{
  const s = await spotInside('#power-slots');
  check(!!s && s.inside, 'the coach points inside the power slots');
  await dragTo('#home-carousel .cf-card', '#power-slots .pslot[data-slot="0"]');
  const filled = await evalJs(`document.querySelectorAll('#power-slots .pslot:not(.pslot-empty)').length`);
  check(filled >= 1, `a card is now equipped (${filled} slot(s) filled)`);
  check(await cap() === 'החלף מראה', `advanced to the hero step (got «${await cap()}»)`);
  await shot('h04-hero');
}

console.log('7) STEPS 4-5 — hero and friends open their OWN screen, and the step waits for the return');
{
  await tap('#pick-hero-btn');
  check(await vis('#home') === 'hidden', 'the wardrobe took over the screen');
  check(await vis('#tutorial') === 'hidden', 'the coach hid itself rather than point at a button that is gone');
  check(await cap() === 'החלף מראה', 'the step has NOT completed on the tap alone');
  await evalJs(`(document.querySelector('#hero-pick .hp-close, #hero-pick [data-home-back], [data-home-back]')||{click(){}}).click()`);
  await sleep(900);
  check(await vis('#home') === 'shown', 'back on the hub');
  check(await cap() === 'שחק עם חבר', `the hero step completed on the RETURN (got «${await cap()}»)`);
  await shot('h05-friends');

  await tap('#friends-btn');
  await sleep(600);
  check(await vis('#friends') === 'shown', 'the friends screen opened');
  await evalJs(`(document.querySelector('#friends [data-home-back]')||{click(){}}).click()`);
  await sleep(900);
  check(await cap() === 'קדימה!', `the friends step completed on the return (got «${await cap()}»)`);
  await shot('h06-play');
}

console.log('8) STEP 6 — the ⚽ tap ends the lesson AND starts a real match');
{
  const s = await spotInside('#quick-match-btn');
  check(!!s && s.inside, 'the coach points inside the quick-match button');
  await tap('#quick-match-btn');
  await sleep(1200);
  check(await evalJs(`localStorage.getItem('fbTuDone')||''`).then((v) => v.includes('mercaz')), 'the level is recorded as done');
  check(await evalJs(`document.body.classList.contains('hub-tu-gate')`) === false, 'the gate is gone');
  check(await vis('#tutorial') === 'hidden', 'the coach is gone');
  await shot('h07-after');
}

console.log('9) THE SANDBOX — a lesson that equipped a card and changed hero wrote NOTHING');
{
  // The whole point. Unsandboxed, setSlotCard -> saveLoadout -> postPrefs would have pushed demo
  // cards into the player's real cross-device loadout via the app.
  const loadout = await evalJs(`localStorage.getItem('pikme-loadout')`);
  const cosmetic = await evalJs(`localStorage.getItem('pikme_cosmetic')`);
  check(loadout === null, `pikme-loadout was never written (${JSON.stringify(loadout)})`);
  check(cosmetic === null, `pikme_cosmetic was never written (${JSON.stringify(cosmetic)})`);
  const leaks = await evalJs(`(window.__leaks||[]).filter(m=>String(m).includes('prefs')).length`);
  check(leaks === 0, `nothing was posted to the app bridge (${leaks} prefs message(s))`);
  // And the demo is really gone, not just hidden.
  const demoLeft = await evalJs(`document.querySelectorAll('.cf-card.cf-demo').length`);
  check(demoLeft === 0, `no demo card survives the lesson (${demoLeft} left)`);
}

console.log('10) THE PICKER + REPLAY — מרכז is a level like any other');
{
  await evalJs(`localStorage.setItem('fbTuDone','basics,combat,tricks,mercaz')`);
  await cdp('Page.navigate', { url: PAGE });
  await sleep(4000);
  check(await vis('#tutorial') === 'hidden', 'it does NOT auto-launch once it is done');
  await tap('#training-btn');
  await sleep(500);
  await tap('#tc-howto');
  await sleep(500);
  const levels = await evalJs(`[...document.querySelectorAll('#tu-levels .tu-lv')].map(b=>b.textContent.trim())`);
  check(Array.isArray(levels) && levels.length === 4, `four levels in the picker (${Array.isArray(levels) ? levels.length : 'none'})`);
  check(Array.isArray(levels) && /מרכז/.test(levels[3] || '') && /⭐/.test(levels[3] || ''), `מרכז shows as done: «${Array.isArray(levels) ? levels[3] : ''}»`);
  await shot('h08-picker');
}

console.log(failures === 0 ? '\n✅ ALL PASS' : `\n❌ ${failures} FAILED`);
try { chrome.kill(); } catch {}
process.exit(failures ? 1 : 0);
