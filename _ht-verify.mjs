// HUB TOUR × LIVE MATCH — real-browser proof that the lobby tour cannot paint over a match.
//
// The bug this exists for: screenshots from the phone/iPad showed the hub tour's furniture (a
// pointing hand, a caption, card art) drawn over a running match, with #game the visible .screen —
// and it survived both localStorage keys being set.
//
// So this does not screenshot and eyeball. It enumerates EVERY element the tour owns (its own ht-*
// DOM plus the coach layer it borrows and re-parents) and asserts that during a live match none of
// them is painted, and that none of the tour's body classes is still on <body>.
//
// Needs a game server: PORT=3012 node server.js   (override with URL=/PORT=)
// Run: node _ht-verify.mjs      Screenshots land in ./_tu-shots/ as ht-*.png
import { WebSocket } from 'ws';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';

const PORT = process.env.PORT || 3012;
const PAGE = process.env.URL || `http://localhost:${PORT}/`;
const CDP_PORT = Number(process.env.CDP_PORT || 9433);
const PROFILE = `/tmp/ht-verify-profile-${process.pid}`;   // fresh profile => empty localStorage => first run
const SHOTS = new URL('./_tu-shots/', import.meta.url).pathname;   // the repo's (gitignored) shot dir
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

let failures = 0;
const check = (cond, msg) => { console.log((cond ? '  PASS ' : '  FAIL ') + msg); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(SHOTS, { recursive: true });
rmSync(PROFILE, { recursive: true, force: true });

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  '--window-size=844,390', 'about:blank',
], { stdio: 'ignore' });
process.on('exit', () => { try { chrome.kill(); } catch {} try { rmSync(PROFILE, { recursive: true, force: true }); } catch {} });

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
const evalJs = async (expr) => {
  const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('page threw: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
};
const shot = async (name) => {
  const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${SHOTS}ht-${name}.png`, Buffer.from(data, 'base64'));
  console.log(`     shot _tu-shots/ht-${name}.png`);
};

await cdp('Page.enable');
await cdp('Runtime.enable');
await cdp('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 2, mobile: true });
await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await cdp('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });

// ---------------------------------------------------------------------------------------
// THE AUDIT. Every element the tour can put on screen, listed by hand rather than by a wildcard:
//   its own DOM          .ht-scrim .ht-catch #ht-next #tu-hub-skip .ht-done .ht-badge .ht-drop
//                        .ht-show .ht-dim .ht-pick .tu-live
//   the coach it borrows #tutorial (moved to <body> by coachToBody) and everything inside it
// "Painted" = laid out (a client rect), display/visibility not off, opacity not 0, and the pixel
// box actually intersects the viewport. That is the honest test: the tour hides itself with
// .hidden on some of these, and a class alone proves nothing either way.
// ---------------------------------------------------------------------------------------
const AUDIT = `(() => {
  const SELS = ['.ht-scrim','.ht-catch','#ht-next','#tu-hub-skip','.ht-done','.ht-badge',
                '.ht-drop','.ht-show','.ht-dim','.ht-pick','.tu-live',
                '#tutorial','#tu-hand','.tu-caption','#tu-cap','#tu-nudge','#tu-pips','#tu-veil'];
  const painted = (el) => {
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
    }
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    return r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
  };
  const out = [];
  for (const sel of SELS) for (const el of document.querySelectorAll(sel)) {
    if (!painted(el)) continue;
    const r = el.getBoundingClientRect();
    out.push({ sel, id: el.id || null, cls: el.className, parent: el.parentElement?.id || el.parentElement?.tagName,
               rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
               text: (el.textContent || '').trim().slice(0, 40) });
  }
  const htClasses = [...document.body.classList].filter((c) => c === 'hub-tu-gate' || c.startsWith('ht-'));
  const scr = {};
  for (const s of document.querySelectorAll('.screen')) scr[s.id] = !s.classList.contains('hidden');
  return {
    painted: out, htClasses, screens: scr,
    tutorialParent: document.getElementById('tutorial')?.parentElement?.id || document.getElementById('tutorial')?.parentElement?.tagName || null,
    state: window.HubTour ? window.HubTour.state() : null,
    keys: { done: localStorage.getItem('fbHubTourDone'), skip: localStorage.getItem('fbHubTourSkipped') },
    // THE STATE LEAK, not just the paint. The tour empties the player's three power slots in memory
    // (prefs().emptySlots()) so the "drag a card in" lesson has somewhere to drop, and only its exit
    // path puts them back. A tour that is never torn down therefore sends the player into a real match
    // with no cards equipped — visible in _tu-shots/ht-02 vs ht-03 — and leaves client.js's tuHub write-guard
    // raised, which silences every loadout/cosmetic save for the rest of the session.
    slotsFilled: document.querySelectorAll('#power-slots .pslot:not(.pslot-empty)').length,
  };
})()`;

const audit = () => evalJs(AUDIT);
const report = (a) => {
  console.log('     screens visible:', Object.entries(a.screens).filter(([, v]) => v).map(([k]) => k).join(',') || '(none)');
  console.log('     body ht classes:', a.htClasses.join(' ') || '(none)');
  console.log('     #tutorial parent:', a.tutorialParent);
  if (a.state) console.log('     HubTour.state:', JSON.stringify({ running: a.state.running, waiting: a.state.waiting, step: a.state.step, stepId: a.state.stepId, finished: a.state.finished, skipped: a.state.skipped }));
  for (const p of a.painted) console.log(`     PAINTED ${p.sel}${p.id ? '#' + p.id : ''} in ${p.parent} rect=${p.rect.join(',')} "${p.text}"`);
};

// Start a real match vs bots. .click() on purpose: the tour deliberately makes the hub inert, and
// the question under test is what happens when a match starts UNDERNEATH a running tour — the app
// shell, a friend's challenge and a matchmade room can all do that without a hub tap.
async function startBotMatch() {
  await evalJs(`document.getElementById('training-btn').click()`);
  await sleep(400);
  await evalJs(`document.getElementById('tc-bots').click()`);
  for (let i = 0; i < 40; i++) {
    if (await evalJs(`!document.getElementById('game').classList.contains('hidden')`)) return true;
    await sleep(250);
  }
  return false;
}

console.log(`\n1) FIRST RUN on a fresh profile — the lobby tour should own the hub (${PAGE})`);
await cdp('Page.navigate', { url: PAGE });
await sleep(6000);
{
  const a = await audit();
  report(a);
  check(a.screens.home === true, 'the hub is the visible screen');
  check(!!a.state?.running, 'the hub tour is running');
  check(a.painted.some((p) => p.sel === '#tu-hand'), 'its pointing hand is painted');
  console.log('     power slots filled during the lesson:', a.slotsFilled, '(the tour empties them on purpose)');
  await shot('01-tour-on-hub');
}

console.log('\n2) A MATCH STARTS UNDER THE RUNNING TOUR — nothing of the tour may be painted');
{
  const entered = await startBotMatch();
  await sleep(1500);
  const a = await audit();
  report(a);
  check(entered && a.screens.game === true, 'the match screen is up and the match is running');
  check(a.screens.home === false, 'the hub is hidden');
  check(a.painted.length === 0, `no hub-tour element is painted over the match (found ${a.painted.length})`);
  check(a.htClasses.length === 0, `no tour class left on <body> (found ${a.htClasses.join(' ') || 'none'})`);
  check(a.state && a.state.running === false, 'the tour machine is stopped');
  check(a.tutorialParent === 'game', `#tutorial is back inside #game (it is in ${a.tutorialParent})`);
  check(a.keys.done === null && a.keys.skip === null, `interrupted is neither done nor skipped (done=${a.keys.done}, skip=${a.keys.skip})`);
  await shot('02-match-under-tour');
}

console.log('\n2b) BACK ON THE HUB — the lesson\'s sandbox was rolled back, the hub is live again');
{
  await evalJs(`document.getElementById('leave-lobby-btn')?.click()`);
  await sleep(2000);
  const a = await audit();
  report(a);
  check(a.screens.home === true, 'the hub is back');
  check(a.slotsFilled === 3, `the player's three power slots are equipped again (found ${a.slotsFilled}) — the tour's emptySlots() was undone`);
  check(a.painted.length === 0, `no hub-tour element left on the hub (found ${a.painted.length})`);
  check(a.htClasses.length === 0, `no tour class on <body> (found ${a.htClasses.join(' ') || 'none'})`);
  await shot('02b-hub-after-abandon');
}

console.log('\n3) BOTH KEYS SET — reload, go straight into a match, tour must never appear');
{
  await evalJs(`localStorage.setItem('fbHubTourDone','1');localStorage.setItem('fbHubTourSkipped','1')`);
  await cdp('Page.navigate', { url: PAGE });
  await sleep(6000);
  let a = await audit();
  check(a.state?.running === false && a.state?.waiting === false, 'the tour did not start (both keys set)');
  const entered = await startBotMatch();
  await sleep(1500);
  a = await audit();
  report(a);
  check(entered && a.screens.game === true, 'the match is running');
  check(a.painted.length === 0, `no hub-tour element is painted (found ${a.painted.length})`);
  check(a.htClasses.length === 0, `no tour class on <body> (found ${a.htClasses.join(' ') || 'none'})`);
  await shot('03-match-keys-set');
}

console.log('\n3b) A LOBBY LESSON MAY NOT BE STARTED FROM INSIDE A MATCH');
{
  const started = await evalJs(`(()=>{window.HubTour.start('full');return window.HubTour.state().running;})()`);
  await sleep(600);
  const a = await audit();
  check(started === false && a.painted.length === 0, `HubTour.start() during a match is refused (running=${started}, painted=${a.painted.length})`);
}

console.log('\n4) THE REPLAY PATH — the tour started on the hub, then a match starts under it');
{
  await evalJs(`document.getElementById('leave-lobby-btn')?.click()`);
  await sleep(1200);
  const home = await evalJs(`!document.getElementById('home').classList.contains('hidden')`);
  if (!home) { await evalJs(`document.getElementById('resume')?.click()`); await sleep(600); }
  const back = await evalJs(`!document.getElementById('home').classList.contains('hidden')`);
  console.log('     back on the hub:', back);
  if (back) {
    await evalJs(`window.HubTour.start('full')`);
    await sleep(2500);
    let a = await audit();
    check(!!a.state?.running, 'the replay tour is running on the hub');
    await shot('04a-replay-tour');
    const entered = await startBotMatch();
    await sleep(1500);
    a = await audit();
    report(a);
    check(entered && a.screens.game === true, 'the match is running');
    check(a.painted.length === 0, `no hub-tour element is painted over the match (found ${a.painted.length})`);
    check(a.htClasses.length === 0, `no tour class on <body> (found ${a.htClasses.join(' ') || 'none'})`);
    await shot('04b-match-under-replay');
  } else {
    check(false, 'could not get back to the hub to test the replay path');
  }
}

console.log('\n5) THE REAL ENTRY AND THE REAL EXIT — ⚙ → ? starts it, «דלג ✕» ends it');
{
  await evalJs(`document.getElementById('leave-lobby-btn')?.click()`);
  await sleep(2000);
  const back = await evalJs(`!document.getElementById('home').classList.contains('hidden')`);
  check(back, 'back on the hub');
  // The lobby's own path: the ? lives inside the settings card, and its handler closes that modal
  // first («המשך») before starting. Driven through the buttons, not through HubTour.start().
  await evalJs(`document.getElementById('hub-settings').click()`);
  await sleep(500);
  check(await evalJs(`!document.getElementById('settings').classList.contains('hidden')`), 'the settings card is open');
  await evalJs(`document.getElementById('hub-howto').click()`);
  await sleep(1200);
  let a = await audit();
  check(!!a.state?.running, 'the ? button really starts the lobby tour');
  check(a.painted.some((p) => p.sel === '#tu-hub-skip'), 'and «דלג ✕» is on screen as the way out');
  await shot('05a-tour-from-question-mark');
  // …and the exit works. This button's id is shared with client.js's parked level-4 tour, so the
  // handler is now bound defensively — which means it has to be proved, not assumed.
  await evalJs(`document.getElementById('tu-hub-skip').click()`);
  await sleep(600);
  a = await audit();
  report(a);
  check(a.state?.running === false, '«דלג ✕» stops the tour');
  check(a.state?.skipped === true, 'and records a SKIP (not a finish)');
  check(a.painted.length === 0, `nothing of the tour is left on the hub (found ${a.painted.length})`);
  check(a.htClasses.length === 0, `no tour class on <body> (found ${a.htClasses.join(' ') || 'none'})`);
  check(a.slotsFilled === 3, `the player's power slots are back (found ${a.slotsFilled})`);
  await shot('05b-after-skip');
}

console.log(`\n${failures ? failures + ' FAILURE(S)' : 'ALL CHECKS PASSED'}\n`);
process.exit(failures ? 1 : 0);
