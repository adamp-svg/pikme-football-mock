// FIRST RUN — does a brand-new player really get the lobby tour, on the REAL page?
//
// Design: docs/superpowers/specs/2026-07-28-hub-tour-lab-design.md
//
// This is NOT the lab. It loads `/` — the actual game — with a fresh Chrome profile, so there is no
// sandbox, no dummy album, no blocked localStorage. Everything here is the shipped path:
//
//   • the tour auto-launches on the first visit to the hub, and the PITCH tutorial (level 1) is held
//     back until it is out of the way — client.js's tuMaybeAutoStart() hands over and is called back;
//   • skipping hands the floor back too, so a kid who waves the lobby away still gets taught to play;
//   • a SECOND load does not ask again (the first-run flag persisted for real);
//   • an EMPTY album runs the screen legend only — with no cards there is nothing to drag and the
//     wardrobe is card-gated, so the card half would be a hand pointing at things that cannot happen;
//   • with cards, the full nineteen run, and NOTHING the lesson does is written to the real
//     localStorage — saveLoadout/saveCosmetic reach postPrefs(), which the app persists under the
//     player's PHONE NUMBER.
//
// Two hosts, on purpose, because they are two different surfaces:
//   LAN IP    → DEV_LOCAL false → no injected album → the empty-album path a real new player hits
//   localhost → DEV_LOCAL true  → DEV_SAMPLE_CARDS  → the with-cards path
//
// Needs the server: PORT=3013 node server.js
// Run: node _hub-firstrun-verify.mjs      Screenshots land in ./_tu-shots/
import { WebSocket } from 'ws';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { networkInterfaces } from 'node:os';

const PORT = process.env.PORT || 3013;
const lanIp = () => Object.values(networkInterfaces()).flat()
  .filter((n) => n && n.family === 'IPv4' && !n.internal).map((n) => n.address)[0];
const LAN = process.env.HOST || lanIp() || '127.0.0.1';
const SHOTS = new URL('./_tu-shots/', import.meta.url).pathname;
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

let failures = 0;
const check = (cond, msg) => { console.log((cond ? '  ✅ ' : '  ❌ ') + msg); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(SHOTS, { recursive: true });

// One browser per scenario: a FRESH PROFILE is the only honest way to be a brand-new player, and the
// whole question here is what happens on a device that has never seen the game.
async function browser(cdpPort, label) {
  const profile = `/tmp/hub-firstrun-${label}-${process.pid}`;
  rmSync(profile, { recursive: true, force: true });
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
    '--window-size=844,390', 'about:blank',
  ], { stdio: 'ignore' });
  let wsUrl = null;
  for (let i = 0; i < 60 && !wsUrl; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
      const pages = (await r.json()).filter((t) => t.type === 'page');
      if (pages.length) wsUrl = pages[0].webSocketDebuggerUrl;
    } catch { /* not up */ }
    if (!wsUrl) await sleep(250);
  }
  if (!wsUrl) throw new Error('Chrome never exposed a page target');
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.once('open', r));
  let id = 0; const pending = new Map(); const errors = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
    if (m.method === 'Runtime.exceptionThrown') { const d = m.params?.exceptionDetails; errors.push(d?.exception?.description || d?.text || 'unknown'); }
  });
  const cdp = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id; pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
    setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error(`CDP timeout: ${method}`)); } }, 20000);
  });
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 2, mobile: true });
  await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await cdp('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });

  const api = {
    errors,
    close() { try { ws.close(); } catch {} try { chrome.kill(); } catch {} try { rmSync(profile, { recursive: true, force: true }); } catch {} },
    ev: async (e) => (await cdp('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result.value,
    go: (url) => cdp('Page.navigate', { url }),
    async shot(name) {
      const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
      writeFileSync(`${SHOTS}${name}.png`, Buffer.from(data, 'base64'));
      console.log(`     📸 _tu-shots/${name}.png`);
    },
    touch: (type, x, y) => cdp('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] }),
  };
  api.state = () => api.ev('window.HubTour ? window.HubTour.state() : null');
  api.vis = (sel) => api.ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return 'missing';const s=getComputedStyle(e);return (s.display!=='none'&&s.visibility!=='hidden'&&e.getClientRects().length)?'shown':'hidden';})()`);
  api.rect = (sel) => api.ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  api.waitFor = async (fn, ms = 12000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(200); } return null; };
  api.tapDark = async () => { await api.touch('touchStart', 60, 200); await sleep(30); await api.touch('touchEnd', 60, 200); await sleep(240); };
  // WAIT FOR THE LAYOUT TO STOP MOVING before trusting a rect. The hub is a scaled stage: fitHub()
  // runs at load and again as fonts/art settle, so a rect read the instant a page appears can be from
  // a different scale than the one that exists a frame later. Measured: the ? button reported
  // (18,7,30) mid-reflow and (43,18,28) once settled — so a tap aimed at the first reading missed,
  // which is exactly how "tapping the ? does nothing" looked in this test while the button was fine.
  api.settled = async (sel, tries = 40) => {
    let last = null;
    for (let i = 0; i < tries; i++) {
      const r = await api.rect(sel);
      if (r && last && Math.abs(r.x - last.x) < 0.5 && Math.abs(r.y - last.y) < 0.5) return r;
      last = r; await sleep(120);
    }
    return last;
  };
  api.tapAt = async (sel) => { const r = await api.settled(sel); if (!r) throw new Error(`no ${sel}`); await api.touch('touchStart', r.x, r.y); await sleep(40); await api.touch('touchEnd', r.x, r.y); await sleep(350); };
  // A real card grab: UP first (dy < -16, mostly vertical) or the carousel reads it as a swipe.
  api.liftTo = async (fromSel, toSel) => {
    const a = await api.rect(fromSel), b = await api.rect(toSel);
    if (!a || !b) throw new Error(`missing ${fromSel} or ${toSel}`);
    await api.touch('touchStart', a.x, a.y); await sleep(30);
    for (let i = 1; i <= 4; i++) { await api.touch('touchMove', a.x, a.y - i * 8); await sleep(25); }
    const lx = a.x, ly = a.y - 32;
    for (let i = 1; i <= 12; i++) { await api.touch('touchMove', lx + (b.x - lx) * (i / 12), ly + (b.y - ly) * (i / 12)); await sleep(25); }
    await api.touch('touchEnd', b.x, b.y); await sleep(450);
  };
  return api;
}

// ==============================================================================================
console.log(`\n🧪 FIRST RUN on the REAL page — http://${LAN}:${PORT}/\n`);

// ---- SCENARIO 1 · a brand-new device, EMPTY album --------------------------------------------
console.log('▶ a brand-new player arrives (empty album — the real new-player surface)');
const b1 = await browser(9451, 'empty');
try {
  await b1.go(`http://${LAN}:${PORT}/`);
  const ran = await b1.waitFor(async () => { const s = await b1.state(); return s && s.running ? s : null; }, 20000);
  check(!!ran, 'the lobby tour launched itself — nobody asked for it');
  check(!!ran && ran.tour === 'home', `an empty album runs the SCREEN LEGEND only (tour='${ran?.tour}')`);
  check(!!ran && ran.stepIds.length === 13, `13 steps, no card lessons — with no cards there is nothing to drag (${ran?.stepIds.length})`);
  check(!!ran && ran.stepId === 'settings', `and it opens on ⚙ (step 1 = '${ran?.stepId}')`);
  // THE PITCH TUTORIAL IS HELD BACK. Before this change, tuMaybeAutoStart() took a brand-new player
  // straight into level 1 on the server's `welcome` and they never saw the hub at all.
  check(await b1.vis('#home') === 'shown', 'we are on the HUB, not on a pitch — level 1 is held back');
  check(await b1.vis('#game') !== 'shown', '…and the match screen is not up');
  // "Everything dims except the one live thing" — asserted on the REAL page, per element, because a
  // bright lobby with a correct caption is a screenshot that reads as working and is not.
  // A beat first: `.hub-tu-gate .hub > *` has `transition: filter .18s ease`, so measuring the instant
  // `running` flips catches the transition's START — which reads as `grayscale(0) brightness(1)`, a
  // no-op filter. An earlier version of this check compared against the string 'none' and therefore
  // PASSED on an undimmed lobby. Numbers, not strings, and after the transition.
  await sleep(500);
  const dim = await b1.ev(`JSON.stringify({
    scrim: !!document.querySelector('.ht-scrim'),
    gate: document.body.classList.contains('hub-tu-gate'),
    lit: getComputedStyle(document.querySelector('#hub-settings')).filter,
    hero: getComputedStyle(document.querySelector('#pick-hero-btn')).filter,
    pitch: getComputedStyle(document.querySelector('.hub-pitch')).filter,
    friends: getComputedStyle(document.querySelector('#friends-btn')).filter
  })`);
  const d = JSON.parse(dim);
  check(d.scrim && d.gate, `the gate and the backdrop scrim are up (${dim})`);
  check(d.lit === 'none', 'the element being described is at full brightness');
  // Dimmed means the brightness multiplier is actually below 1 — `grayscale(0) brightness(1)` is a
  // no-op that is not the string 'none'.
  const darkened = (f) => { const m = /brightness\(([\d.]+)\)/.exec(f || ''); return !!m && parseFloat(m[1]) <= 0.9; };
  check(darkened(d.hero) && darkened(d.pitch) && darkened(d.friends),
    `everything else is really dimmed — hero, pitch and the sat buttons (${dim})`);
  await b1.shot('first-01-empty-album-legend');

  // ---- skipping hands the floor back ---------------------------------------------------------
  console.log('\n▶ the kid taps «דלג ✕» — a lesson nobody can escape is a trap');
  check(await b1.vis('#tu-hub-skip') === 'shown', 'the way out is on screen');
  await b1.tapAt('#tu-hub-skip');
  const stopped = await b1.waitFor(async () => { const s = await b1.state(); return s && !s.running ? s : null; }, 6000);
  check(!!stopped, 'the tour stopped');
  check(!!stopped && stopped.skipped === true, 'and it recorded a SKIP, which is not the same as finishing');
  // The hand-back: client.js resumes its own auto-start, so the pitch tutorial follows.
  const level1 = await b1.waitFor(async () => (await b1.vis('#home')) !== 'shown', 12000);
  check(!!level1, 'the PITCH tutorial took over on the way out — the kid is still taught to play');
  await b1.shot('first-02-skip-hands-over-to-level1');

  // ---- second launch: do not ask again -------------------------------------------------------
  console.log('\n▶ they open the game again tomorrow');
  await b1.go(`http://${LAN}:${PORT}/`);
  await sleep(9000);
  const s2 = await b1.state();
  check(!!s2 && !s2.running && !s2.waiting, 'the lobby tour does NOT come back');
  check(!!s2 && s2.skipped === true, 'the first-run flag really persisted to localStorage');
  check(await b1.ev("localStorage.getItem('fbHubTourSkipped') === '1'"), 'fbHubTourSkipped = 1');

  // ---- THE ? BUTTON — the lobby's own way back in ---------------------------------------------
  // As a RETURNING player: the pitch levels done too, so nothing auto-starts and the kid is simply
  // standing on the lobby. Without this the previous step's level 1 owns the screen and every hub rect
  // is zero — which an earlier version of these checks passed vacuously (0 < 90 is true).
  console.log('\n▶ the ? in the lobby corner replays it, forever');
  await b1.ev("localStorage.setItem('fbTuDone','basics,combat,tricks'); localStorage.setItem('fbTutorialDone','1')");
  await b1.go(`http://${LAN}:${PORT}/`);
  const onHub = await b1.waitFor(async () => (await b1.vis('#home')) === 'shown' && (await b1.vis('#hub-howto')) === 'shown', 20000);
  check(!!onHub, 'a returning player stands on the lobby, nothing auto-starts, and the ? is there');
  await b1.settled('#hub-howto');
  await b1.shot('first-05-lobby-with-question-mark');   // the ? at rest, before anything is tapped
  const where = await b1.ev(`(()=>{
    const h=document.querySelector('#hub-howto').getBoundingClientRect();
    const g=document.querySelector('#hub-settings').getBoundingClientRect();
    const pfp=document.querySelector('#home-face').getBoundingClientRect();
    return JSON.stringify({
      // Every one of these requires a REAL rect: an element that is not on screen reports zeros, and
      // zero-is-less-than-ninety is true — which is how the first version of this check passed while
      // the hub was not even the visible screen.
      corner: h.width > 8 && h.left < 90 && h.top < 60,   // the stage's TOP-LEFT, the only free corner
      clearOfPfp: h.width > 8 && h.right <= pfp.left + 1, // .hub-pfp starts at x=95 in stage px
      smallerThanGear: h.width > 8 && h.width < g.width,
      h: {x:Math.round(h.x), y:Math.round(h.y), w:Math.round(h.width)},
      pfpX: Math.round(pfp.left), gearX: Math.round(g.x)
    });
  })()`);
  const w = JSON.parse(where);
  check(w.corner, `it sits in the TOP-LEFT corner (${where})`);
  check(w.clearOfPfp, 'and does not overlap the profile box beside it');
  check(w.smallerThanGear, 'it is smaller than ⚙ — a help affordance, not a control');
  // The tour is already skipped on this profile, so this proves the ? ignores the first-run flags.
  await b1.tapAt('#hub-howto');
  const replay = await b1.waitFor(async () => { const s = await b1.state(); return s && s.running ? s : null; }, 12000);
  check(!!replay, 'tapping it starts the tour again, even though this player already waved it away');
  check(!!replay && replay.tour === 'home', `same album rules apply on a replay (tour='${replay?.tour}')`);
  await b1.shot('first-06-question-mark-replay');
  // And the exit is not sitting on top of the ? — the same corner collision that hit ⚙ on step 1.
  const noClash = await b1.ev(`(()=>{
    const s=document.querySelector('#tu-hub-skip').getBoundingClientRect();
    const h=document.querySelector('#hub-howto').getBoundingClientRect();
    return !(s.right<h.left||s.left>h.right||s.bottom<h.top||s.top>h.bottom);
  })()`);
  check(noClash === false, 'and «דלג ✕» stepped down out of the ?\'s way');
  check(b1.errors.length === 0, `no uncaught JS errors${b1.errors.length ? `\n     ${b1.errors.slice(0, 3).join('\n     ')}` : ''}`);
} finally { b1.close(); }

// ---- SCENARIO 2 · a player WITH cards --------------------------------------------------------
// localhost, where DEV_LOCAL hands the client DEV_SAMPLE_CARDS — the only way to exercise the card
// half without an app injecting a real album.
console.log('\n▶ a brand-new player who HAS cards (localhost sample album) — the full nineteen');
const b2 = await browser(9452, 'cards');
try {
  await b2.go(`http://127.0.0.1:${PORT}/`);
  const ran = await b2.waitFor(async () => { const s = await b2.state(); return s && s.running ? s : null; }, 20000);
  check(!!ran, 'the tour launched');
  check(!!ran && ran.tour === 'full', `with cards it runs the FULL tour (tour='${ran?.tour}')`);
  check(!!ran && ran.stepIds.length === 19, `19 steps (${ran?.stepIds.length})`);
  const before = await b2.ev("JSON.stringify({ l: localStorage.getItem('pikme-loadout'), c: localStorage.getItem('pikme_cosmetic') })");

  // Walk the legend.
  for (let i = 0; i < 13; i++) await b2.tapDark();
  const atHero = await b2.waitFor(async () => { const s = await b2.state(); return s && s.stepId === 'hero' ? s : null; }, 8000);
  check(!!atHero, `the legend handed over to the hero lesson (stepId=${(await b2.state())?.stepId})`);
  // The hero step needs a RARE in the album; DEV_SAMPLE_CARDS has two.
  const rare = await b2.ev("!!document.querySelector('#home-carousel .cf-card.rarity-rare')");
  check(rare, 'the sample album has a rare to teach with');
  await b2.liftTo('#home-carousel .cf-card.rarity-rare', '#pick-hero-btn');
  const gold = await b2.waitFor(async () => { const s = await b2.state(); return s && String(s.cosmetic).endsWith(':gold') ? s : null; }, 8000);
  check(!!gold, `the hero really re-skinned on the real page (myCosmetic = ${(await b2.state())?.cosmetic})`);
  await b2.shot('first-03-cards-hero-gold');

  // Three slot explanations, then the drag, then «הכי טוב».
  for (let i = 0; i < 3; i++) await b2.tapDark();
  const atDrag = await b2.waitFor(async () => { const s = await b2.state(); return s && s.stepId === 'slot' ? s : null; }, 8000);
  check(!!atDrag, `the slot legend handed over to the drag (stepId=${(await b2.state())?.stepId})`);
  await b2.liftTo('#home-carousel .cf-card.cf-center', '#power-slots .pslot[data-slot="0"]');
  const atBest = await b2.waitFor(async () => { const s = await b2.state(); return s && s.stepId === 'best' ? s : null; }, 8000);
  check(!!atBest, `and that to «הכי טוב» (stepId=${(await b2.state())?.stepId})`);
  await b2.tapAt('#select-best-btn');
  const finished = await b2.waitFor(async () => { const s = await b2.state(); return s && !s.running ? s : null; }, 8000);
  check(!!finished, 'the tour finished');
  check(!!finished && finished.finished === true, 'and recorded a FINISH (not a skip)');
  await b2.shot('first-04-cards-finished');

  // ---- THE INVARIANT THAT MATTERS ON A REAL DEVICE -------------------------------------------
  // No sandbox here: this is real localStorage. saveLoadout/saveCosmetic reach postPrefs(), which the
  // app persists under the player's PHONE NUMBER, so a leak is a leak into their actual account.
  const after = await b2.ev("JSON.stringify({ l: localStorage.getItem('pikme-loadout'), c: localStorage.getItem('pikme_cosmetic') })");
  check(after === before, `the lesson wrote NOTHING to the player's real prefs\n     before ${before}\n     after  ${after}`);
  check(await b2.ev("localStorage.getItem('fbHubTourDone') === '1'"), 'fbHubTourDone = 1, so it will not fire again');
  // And the pitch tutorial follows a FINISH as well as a skip.
  const level1b = await b2.waitFor(async () => (await b2.vis('#home')) !== 'shown', 12000);
  check(!!level1b, 'the pitch tutorial took over after the lobby tour finished');
  check(b2.errors.length === 0, `no uncaught JS errors${b2.errors.length ? `\n     ${b2.errors.slice(0, 3).join('\n     ')}` : ''}`);
} finally { b2.close(); }

console.log(`\n${failures ? '❌' : '✅'} ${failures ? failures + ' FAILED' : 'ALL PASS'}\n`);
process.exit(failures ? 1 : 0);
