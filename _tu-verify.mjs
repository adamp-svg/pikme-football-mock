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
  check(pips === 4, `four progress pips (${pips})`);
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
}

console.log('6) nothing overflows the phone viewport');
{
  const over = await evalJs('({sx: document.scrollingElement.scrollWidth - innerWidth, sy: document.scrollingElement.scrollHeight - innerHeight})');
  check(over.sx <= 0 && over.sy <= 0, `no page overflow (x ${over.sx}, y ${over.sy})`);
  const capBox = await rectOf('.tu-caption b');
  check(capBox && capBox.y > 0 && capBox.y < 390, `caption sits on screen (y ${capBox ? Math.round(capBox.y) : '?'} of 390)`);
}

console.log('7) shooting the dummy finishes step 2');
{
  // Aim up-left-ish toward the dummy and let go — a quick release is a shot.
  for (let i = 0; i < 14 && (await text('#tu-cap')).trim() !== 'גול!'; i++) {
    await stickDrag('#stickR', -20, -46, 260);   // pull the aim stick toward the dummy, release
    await sleep(420);
  }
  const cap = (await text('#tu-cap')).trim();
  check(cap === 'גול!', `advanced to step 3, caption «גול!» (got «${cap}»)`);
  await shot('03-step3-goal');
}

console.log('8) the done-flag is still unset mid-tutorial (it is written only at the finale)');
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
  await shot('04-replay-entry');
  await evalJs('document.getElementById("tc-howto").click()');
  await sleep(3000);
  check(await vis('#tutorial') === 'shown', 'replay starts the tutorial even with the flag set');
  check((await text('#tu-cap')).trim() === 'זוז!', 'replay starts from step 1');
  check(await vis('#leave-lobby-btn') === 'shown', 'a REPLAY keeps its way out (only the first run traps you)');
  await shot('05-replay-running');
}

ws.close(); chrome.kill();
console.log(failures === 0 ? '\n✅ ALL PASS' : `\n❌ ${failures} FAILED`);
process.exit(failures ? 1 : 0);
