// Tutorial onboarding — REAL-BROWSER verification (Chrome via CDP, no puppeteer).
//
// Why this exists: the tutorial's whole job is visual and touch-driven, and unit tests cannot see
// a caption clipped off the top of a notched phone or a spotlight pointing at the wrong stick.
// This drives the actual client with actual touch events on a landscape phone viewport and reads
// the DOM back, taking a screenshot at every step (repo convention — layout claims get
// screenshotted, not asserted).
//
// Needs a game server: PORT=3012 node server.js   (override with URL=/PORT=)
// Run: node _tu-verify.mjs        Screenshots land in ./_tu-shots/
import { WebSocket } from 'ws';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';

const PORT = process.env.PORT || 3012;
const PAGE = process.env.URL || `http://localhost:${PORT}/`;
const CDP_PORT = Number(process.env.CDP_PORT || 9412);
const PROFILE = `/tmp/tu-verify-profile-${process.pid}`;  // fresh profile => EMPTY localStorage => first run
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

// --- minimal CDP client ---------------------------------------------------------------
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
// A real phone in landscape, with touch — the surface this feature is for. Without touch the
// client hides the sticks entirely and the coach would be pointing at nothing.
await cdp('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 2, mobile: true });
await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await cdp('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });

// --- touch helpers: drive the REAL on-screen sticks -------------------------------------
const touch = (type, x, y) => cdp('Input.dispatchTouchEvent', {
  type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }],
});
const rectOf = (sel) => evalJs(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,w:r.width,h:r.height};})()`);
// Push a stick in a direction for `ms`, then let go.
async function stickDrag(sel, dx, dy, ms) {
  const r = await rectOf(sel);
  if (!r) throw new Error(`no element ${sel}`);
  await touch('touchStart', r.x, r.y);
  await touch('touchMove', r.x + dx, r.y + dy);
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { await touch('touchMove', r.x + dx, r.y + dy); await sleep(50); }
  await touch('touchEnd', r.x + dx, r.y + dy);
}
// Is the HAND actually drawn on the control it is supposed to point at? The `--tu-x/--tu-y` vars
// only prove the coach AIMED at it; the hand itself is then moved by its gesture keyframes
// (circle: +/-34px, pull: up to -46px), so the honest check samples its real rect over a full
// animation cycle and asserts it stays within the gesture's own amplitude of the target.
async function handOnTarget(sel, maxOff) {
  const r = await evalJs(`(async()=>{
    const h=document.getElementById('tu-hand'), s=document.querySelector(${JSON.stringify(sel)});
    if(!h||!s) return null;
    let worst=0;
    for(let i=0;i<14;i++){
      const a=h.getBoundingClientRect(), b=s.getBoundingClientRect();
      if(!b.width) return null;
      worst=Math.max(worst, Math.hypot((a.x+a.width/2)-(b.x+b.width/2),(a.y+a.height/2)-(b.y+b.height/2)));
      await new Promise(r=>setTimeout(r,90));
    }
    return Math.round(worst);
  })()`);
  return r;
}
const vis = (sel) => evalJs(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return 'missing';const s=getComputedStyle(e);return (s.display!=='none'&&s.visibility!=='hidden'&&e.getClientRects().length)?'shown':'hidden';})()`);
const text = (sel) => evalJs(`(document.querySelector(${JSON.stringify(sel)})||{}).textContent||''`);

// =======================================================================================
console.log(`\n1) FIRST RUN — a fresh profile lands straight in the tutorial (${PAGE})`);
await cdp('Page.navigate', { url: PAGE });
await sleep(4000);
{
  check(await evalJs('localStorage.getItem("fbTutorialDone")') === null, 'started with no done-flag (genuinely a first run)');
  check(await vis('#game') === 'shown', 'the pitch is on screen without anyone tapping Play');
  check(await vis('#tutorial') === 'shown', 'the coach layer is up');
  check((await text('#tu-cap')).trim() === 'זוז!', `step 1 caption is «זוז!» (got «${(await text('#tu-cap')).trim()}»)`);
  await shot('01-step1-move');
}

console.log('2) step 1 shows ONLY the move stick — nothing unexplained on screen');
{
  check(await vis('#stickL') === 'shown', 'move stick present');
  check(await vis('#stickR') === 'hidden', 'aim stick hidden (not taught yet)');
  check(await vis('#special') === 'hidden', '💣 hidden');
  check(await vis('#build') === 'hidden', '🧱 hidden');
  check(await vis('#pause-btn') === 'hidden', '⚙ hidden');
  check(await vis('#chat-btn') === 'hidden', 'quick chat hidden');
  check(await vis('#leave-lobby-btn') === 'hidden', 'no way out on a first run (unskippable)');
  check(await vis('#tu-hand') === 'shown', 'the pointing hand is drawn');
  const pips = await evalJs('document.querySelectorAll("#tu-pips i").length');
  check(pips === 5, `five progress pips for level 1 (${pips})`);
  const onPip = await evalJs('[...document.querySelectorAll("#tu-pips i")].findIndex(e=>e.className==="on")');
  check(onPip === 0, `the first pip is the live one (index ${onPip})`);
}

console.log('3) the hand points at the move stick, and the spotlight follows it');
{
  const d = await evalJs(`(()=>{
    const t=document.getElementById('tutorial'), s=document.getElementById('stickL');
    const r=s.getBoundingClientRect();
    const x=parseFloat(getComputedStyle(t).getPropertyValue('--tu-x'));
    const y=parseFloat(getComputedStyle(t).getPropertyValue('--tu-y'));
    return Math.hypot(x-(r.x+r.width/2), y-(r.y+r.height/2));
  })()`);
  check(d < 6, `spotlight sits on the move stick (${Math.round(d)}px off centre)`);
  const off = await handOnTarget('#stickL', 60);
  check(off != null && off <= 60, `and the HAND itself orbits it, never straying (worst ${off}px over a full circle)`);
}

console.log('4) walking into the ring finishes step 1 and unlocks the aim stick');
{
  await stickDrag('#stickL', 60, 0, 6000);   // push right, toward the ring
  await sleep(600);
  const cap = (await text('#tu-cap')).trim();
  check(cap === 'ירה!', `advanced to step 2, caption «ירה!» (got «${cap}»)`);
  check(await vis('#stickR') === 'shown', 'aim stick appeared');
  check(await vis('#special') === 'hidden', '💣 still hidden');
  check(await vis('#build') === 'hidden', '🧱 still hidden');
  const onPip = await evalJs('[...document.querySelectorAll("#tu-pips i")].findIndex(e=>e.className==="on")');
  const donePip = await evalJs('document.querySelectorAll("#tu-pips i.done").length');
  check(onPip === 1 && donePip === 1, `pips advanced (on=${onPip}, done=${donePip})`);
  await shot('02-step2-shoot');
}

console.log('5) the spotlight moves to the aim stick for the shooting step');
{
  const d = await evalJs(`(()=>{
    const t=document.getElementById('tutorial'), s=document.getElementById('stickR');
    const r=s.getBoundingClientRect();
    const x=parseFloat(getComputedStyle(t).getPropertyValue('--tu-x'));
    const y=parseFloat(getComputedStyle(t).getPropertyValue('--tu-y'));
    return Math.hypot(x-(r.x+r.width/2), y-(r.y+r.height/2));
  })()`);
  check(d < 6, `spotlight moved to the aim stick (${Math.round(d)}px off centre)`);
  const g = await evalJs('document.getElementById("tu-hand").className');
  check(/gest-pull/.test(g), `hand switched to the hold-drag-release gesture (${g})`);
  const off = await handOnTarget('#stickR', 70);
  check(off != null && off <= 70, `and the HAND stays on it through the drag mime (worst ${off}px)`);
}

console.log('6) nothing overflows the phone viewport');
{
  const over = await evalJs('({sx: document.scrollingElement.scrollWidth - innerWidth, sy: document.scrollingElement.scrollHeight - innerHeight})');
  check(over.sx <= 0 && over.sy <= 0, `no page overflow (x ${over.sx}, y ${over.sy})`);
  const capBox = await rectOf('.tu-caption b');
  check(capBox && capBox.y > 0 && capBox.y < 390, `caption sits on screen (y ${capBox ? Math.round(capBox.y) : '?'} of 390)`);
}

console.log('7) shooting the dummy finishes the shoot step');
{
  // A QUICK release auto-aims at the nearest enemy (MECHANICS §3), so a short tap is enough here.
  for (let i = 0; i < 14 && (await text('#tu-cap')).trim() === 'ירה!'; i++) {
    await stickDrag('#stickR', -20, -46, 260);
    await sleep(420);
  }
  check((await text('#tu-cap')).trim() === 'החזק חזק!', `-> the CHARGE step «החזק חזק!» (got «${(await text('#tu-cap')).trim()}»)`);
  await shot('03-step3-charge');
}

console.log('8) the charge step needs a FULL hold — a tap will not do');
{
  // Tap repeatedly: the step must NOT pass on quick shots, or "hold longer = stronger" is not
  // being taught at all, which was the whole reason this step exists.
  for (let i = 0; i < 4; i++) { await stickDrag('#stickR', -30, -30, 120); await sleep(260); }
  check((await text('#tu-cap')).trim() === 'החזק חזק!', 'four quick taps did NOT complete it');
  // Now hold past SHOOT_CHARGE_TIME (2.0s) and release.
  for (let i = 0; i < 6 && (await text('#tu-cap')).trim() === 'החזק חזק!'; i++) {
    await stickDrag('#stickR', -30, -30, 2400);
    await sleep(500);
  }
  check((await text('#tu-cap')).trim() === 'גול!', `a full-power release advanced it -> «גול!» (got «${(await text('#tu-cap')).trim()}»)`);
  await shot('04-step4-goal');
}

console.log('8b) the done-flag is still unset mid-tutorial (it is written only at the finale)');
{
  check(await evalJs('localStorage.getItem("fbTutorialDone")') === null, 'no flag yet — a kid who quits halfway gets the tutorial again');
}

console.log('9) REPLAY is reachable and unconditional');
{
  // Set the flag by hand (as a finished player would have) and go back to the hub.
  await evalJs('localStorage.setItem("fbTutorialDone","1")');
  await cdp('Page.navigate', { url: PAGE });
  await sleep(3500);
  check(await vis('#home') === 'shown', 'with the flag set, a reload lands on the hub — the tutorial does NOT re-hijack');
  check(await vis('#tutorial') === 'hidden', 'no coach layer on the hub');
  await evalJs('document.getElementById("training-btn").click()');
  await sleep(400);
  check(await vis('#tc-howto') === 'shown', '«🎓 איך משחקים?» is in the אימון sheet');
  await shot('05-replay-entry');
  await evalJs('document.getElementById("tc-howto").click()');
  await sleep(500);
  check(await vis('#tu-levels') === 'shown', 'it opens the LEVEL PICKER, not the tutorial directly');
  // Read innerHTML, not textContent: icon-system.js swaps ⭐/▶/⚽ for pixel sprites, so the
  // badge is gone from textContent while being perfectly visible on screen (see the screenshot).
  const rows = await evalJs('[...document.querySelectorAll("#tu-levels .tu-lv")].map(e=>({html:e.querySelector("b").innerHTML, locked:e.className.includes("locked"), name:e.querySelector("b").textContent.trim()}))');
  check(Array.isArray(rows) && rows.length === 2, `two levels listed (${rows && rows.length})`);
  check(rows && /⭐|si-star|star/.test(rows[0].html) && !rows[0].locked, `level 1 shows finished + unlocked (${rows && rows[0].name})`);
  check(rows && !rows[1].locked && /קרב/.test(rows[1].name), `level 2 is unlocked and playable (${rows && rows[1].name})`);
  await shot('06-level-picker');
  await evalJs('document.querySelector("#tu-levels .tu-lv[data-level=\\"0\\"]").click()');
  await sleep(3000);
  check(await vis('#tutorial') === 'shown', 'replay starts the tutorial even with the flag set');
  check((await text('#tu-cap')).trim() === 'זוז!', 'replay starts from step 1');
  check(await vis('#leave-lobby-btn') === 'shown', 'a REPLAY keeps its way out (only the first run traps you)');
  await shot('07-replay-running');
}

console.log('10) a LOCKED level says so instead of being dead pixels');
{
  await evalJs('localStorage.removeItem("fbTuDone"); localStorage.removeItem("fbTutorialDone")');
  await cdp('Page.navigate', { url: PAGE });
  await sleep(3500);
  // Fresh again => level 1 auto-runs. Leave it, then look at the picker.
  await evalJs('localStorage.setItem("fbTuDone","")');   // nothing finished, but no auto-hijack loop
  await cdp('Page.navigate', { url: PAGE });
  await sleep(3000);
  await evalJs('document.getElementById("training-btn").click()');
  await sleep(300);
  await evalJs('document.getElementById("tc-howto").click()');
  await sleep(400);
  const locked = await evalJs('[...document.querySelectorAll("#tu-levels .tu-lv")].map(e=>e.className.includes("locked"))');
  check(locked && locked[0] === false && locked[1] === true, `level 2 locked until level 1 is done (${JSON.stringify(locked)})`);
  await shot('08-level2-locked');
}

console.log('11) LEVEL 2 step 1 — shoot the ball, with 💣/🧱 still not yet introduced');
{
  await evalJs(`localStorage.setItem("fbTuDone","basics")`);   // level 1 finished => level 2 open
  await cdp('Page.navigate', { url: PAGE });
  await sleep(3000);
  await evalJs('document.getElementById("training-btn").click()');
  await sleep(300);
  await evalJs('document.getElementById("tc-howto").click()');
  await sleep(400);
  await evalJs('document.querySelector("#tu-levels .tu-lv[data-level=\\"1\\"]").click()');
  await sleep(3500);
  check((await text('#tu-cap')).trim() === 'שוט לכדור!', `caption «שוט לכדור!» (got «${(await text('#tu-cap')).trim()}»)`);
  check(await vis('#stickR') === 'shown', 'aim stick is live from the first step of level 2');
  check(await vis('#special') === 'hidden', '💣 not introduced yet');
  check(await vis('#build') === 'hidden', '🧱 not introduced yet');
  const onPip = await evalJs('[...document.querySelectorAll("#tu-pips i")].findIndex(e=>e.className==="on")');
  check(onPip === 0, `pips reset for the new level (on=${onPip})`);
  await shot('09-l2-step1-ballshot');

  // Shoot it in for real — bullets snooker a loose ball, and the ball is pickup-locked, so this
  // is the only way through.
  for (let i = 0; i < 20 && (await text('#tu-cap')).trim() === 'שוט לכדור!'; i++) {
    await stickDrag('#stickR', 52, 0, 700);   // pull RIGHT (the ball) and hold past QUICK_CHARGE
    await sleep(420);
  }
  check((await text('#tu-cap')).trim() === 'פצצה!', `shot the ball in -> step 2 «פצצה!» (got «${(await text('#tu-cap')).trim()}»)`);
}

console.log('12) 💣 appears exactly when its step does, and the hand moves onto it');
{
  check(await vis('#special') === 'shown', '💣 is now on screen');
  check(await vis('#build') === 'hidden', '🧱 still held back');
  const d = await evalJs(`(()=>{
    const t=document.getElementById('tutorial'), s=document.getElementById('special');
    const r=s.getBoundingClientRect();
    const x=parseFloat(getComputedStyle(t).getPropertyValue('--tu-x'));
    const y=parseFloat(getComputedStyle(t).getPropertyValue('--tu-y'));
    return Math.hypot(x-(r.x+r.width/2), y-(r.y+r.height/2));
  })()`);
  check(d < 6, `spotlight sits on the 💣 button (${Math.round(d)}px off centre)`);
  const off = await handOnTarget('#special', 70);
  check(off != null && off <= 70, `and the HAND is drawn on the 💣, not near it (worst ${off}px)`);
  await shot('10-l2-step2-bomb');

  // Lob it at the foe: drag the 💣 button toward them and let go.
  for (let i = 0; i < 14 && (await text('#tu-cap')).trim() === 'פצצה!'; i++) {
    await stickDrag('#special', 40, 0, 200);   // lob RIGHT, at the foe
    await sleep(2200);   // BOMB.fuse is 1.725s — the blast is what completes the step
  }
  check((await text('#tu-cap')).trim() === 'בנה קיר!', `bombed them -> step 3 «בנה קיר!» (got «${(await text('#tu-cap')).trim()}»)`);
}

console.log('13) 🧱 appears for the wall step — and 💣 is NOT taken back');
{
  check(await vis('#build') === 'shown', '🧱 is now on screen');
  check(await vis('#special') === 'shown', '💣 stayed — nothing taught is ever re-locked');
  const d = await evalJs(`(()=>{
    const t=document.getElementById('tutorial'), s=document.getElementById('build');
    const r=s.getBoundingClientRect();
    const x=parseFloat(getComputedStyle(t).getPropertyValue('--tu-x'));
    const y=parseFloat(getComputedStyle(t).getPropertyValue('--tu-y'));
    return Math.hypot(x-(r.x+r.width/2), y-(r.y+r.height/2));
  })()`);
  check(d < 6, `spotlight moved to the 🧱 button (${Math.round(d)}px off centre)`);
  const off = await handOnTarget('#build', 70);
  check(off != null && off <= 70, `and the HAND is drawn on the 🧱 (worst ${off}px)`);
  await shot('11-l2-step3-wall');

  // A wall needs BUILD_WINDUP (0.5s) of hold before the release places it.
  for (let i = 0; i < 10 && (await text('#tu-cap')).trim() === 'בנה קיר!'; i++) {
    await stickDrag('#build', 30, 0, 950);     // build RIGHT, between me and the sentry
    await sleep(700);
  }
  check((await text('#tu-cap')).trim() === 'חטוף!', `built it -> step 4 «חטוף!» (got «${(await text('#tu-cap')).trim()}»)`);
  await shot('12-l2-step4-strip');
}

ws.close(); chrome.kill();
console.log(failures === 0 ? '\n✅ ALL PASS' : `\n❌ ${failures} FAILED`);
process.exit(failures ? 1 : 0);
