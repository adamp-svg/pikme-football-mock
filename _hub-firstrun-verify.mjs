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
// BASE lets this be pointed at a deployed origin (BASE=https://pikme-football.onrender.com) instead of
// the dev server. The two-host trick below only works locally — DEV_LOCAL is a localhost-only predicate
// — so against a remote origin the with-cards half cannot run and says so rather than skipping quietly.
const BASE = (process.env.BASE || `http://${LAN}:${PORT}`).replace(/\/$/, '');
const LOCAL_CARDS = `http://127.0.0.1:${PORT}`;
const REMOTE = !!process.env.BASE;

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
  // WAIT FOR THE STYLESHEETS. Until style.css arrives there is no `.hidden { display: none }`, so a
  // modal that is supposed to be closed renders wide open and every element reports an unscaled rect.
  // Against a fast dev server this flash is invisible; against a deployed origin it is long enough that
  // assertions land inside it — which is how "the ? is not in the settings box" failed on prod while
  // prod was byte-identical to local. `#settings` computing display:none is the proof CSS is applied.
  api.styled = async (ms = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const ok = await api.ev("getComputedStyle(document.querySelector('#settings')).display === 'none'"
        + " && !!document.querySelector('#hub-settings') && document.querySelector('#hub-settings').getBoundingClientRect().width > 0");
      if (ok) return true;
      await sleep(200);
    }
    return false;
  };
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
console.log(`\n🧪 FIRST RUN on the REAL page — ${BASE}/\n`);

// ---- SCENARIO 1 · a brand-new device, EMPTY album --------------------------------------------
console.log('▶ a brand-new player arrives (empty album — the real new-player surface)');
const b1 = await browser(9451, 'empty');
try {
  await b1.go(`${BASE}/`);
  const ran = await b1.waitFor(async () => { const s = await b1.state(); return s && s.running ? s : null; }, 20000);
  check(!!ran, 'the lobby tour launched itself — nobody asked for it');
  // A BRAND-NEW PLAYER OWNS NOTHING — which is precisely who this tour is for. So the hub is filled with
  // a demo deck for the length of the lesson and every step can be taught on something real, rather than
  // the card half being dropped.
  check(!!ran && ran.tour === 'full', `an empty album still gets the FULL tour, on a demo deck (tour='${ran?.tour}')`);
  check(!!ran && ran.stepIds.length === 19, `all 19 steps (${ran?.stepIds.length})`);
  const deck = await b1.ev(`JSON.stringify({
    cards: document.querySelectorAll('#home-carousel .cf-card').length,
    rare: document.querySelectorAll('#home-carousel .cf-card.rarity-rare').length,
    common: document.querySelectorAll('#home-carousel .cf-card.rarity-common').length,
    marked: document.body.classList.contains('ht-demo'),
    tag: getComputedStyle(document.querySelector('#home-carousel .cf-card'), '::after').content
  })`);
  const d0 = JSON.parse(deck);
  check(d0.cards === 7, `7 demo cards in the REAL carousel (${d0.cards})`);
  check(d0.rare === 1 && d0.common === 6, `6 common + 1 rare, as specified (${d0.common} + ${d0.rare})`);
  check(d0.marked && /דוגמה/.test(d0.tag || ''), `and every one is MARKED as an example (${d0.tag})`);
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
  // THE DEMO DECK GOES WITH THE LESSON. A player who owns nothing must be looking at an empty hub again,
  // not at seven cards they do not have.
  const gone = await b1.waitFor(async () => (await b1.ev("document.querySelectorAll('#home-carousel .cf-card').length")) === 0, 5000);
  check(gone !== null, `the demo deck was taken away with it (${await b1.ev("document.querySelectorAll('#home-carousel .cf-card').length")} cards left)`);
  check(await b1.ev("!document.body.classList.contains('ht-demo')"), 'and the «דוגמה» marking is gone');
  check(!!stopped && stopped.skipped === true, 'and it recorded a SKIP, which is not the same as finishing');
  // The hand-back: client.js resumes its own auto-start, so the pitch tutorial follows.
  const level1 = await b1.waitFor(async () => (await b1.vis('#home')) !== 'shown', 12000);
  check(!!level1, 'the PITCH tutorial took over on the way out — the kid is still taught to play');
  await b1.shot('first-02-skip-hands-over-to-level1');

  // ---- second launch: do not ask again -------------------------------------------------------
  console.log('\n▶ they open the game again tomorrow');
  await b1.go(`${BASE}/`);
  await sleep(9000);
  const s2 = await b1.state();
  check(!!s2 && !s2.running && !s2.waiting, 'the lobby tour does NOT come back');
  check(!!s2 && s2.skipped === true, 'the first-run flag really persisted to localStorage');
  check(await b1.ev("localStorage.getItem('fbHubTourSkipped') === '1'"), 'fbHubTourSkipped = 1');

  // ---- THE ? BUTTON — the lobby's own way back in ---------------------------------------------
  // As a RETURNING player: the pitch levels done too, so nothing auto-starts and the kid is simply
  // standing on the lobby. Without this the previous step's level 1 owns the screen and every hub rect
  // is zero — which an earlier version of these checks passed vacuously (0 < 90 is true).
  console.log('\n▶ the ? inside SETTINGS replays it, forever');
  await b1.ev("localStorage.setItem('fbTuDone','basics,combat,tricks'); localStorage.setItem('fbTutorialDone','1')");
  await b1.go(`${BASE}/`);
  const onHub = await b1.waitFor(async () => (await b1.vis('#home')) === 'shown', 20000);
  check(!!onHub, 'a returning player stands on the lobby and nothing auto-starts');
  check(await b1.styled(), 'the stylesheets have landed (so a closed modal really reads as closed)');
  // It lives INSIDE the settings panel now, so it must NOT be on the lobby itself.
  check(await b1.vis('#hub-howto') !== 'shown', 'the ? is not loose on the hub — it is in the settings box');
  // Reached the way a player reaches it: ⚙ on the lobby.
  // Retried, not assumed: against a deployed origin the hub is still settling for a while after the
  // first paint (fitHub re-runs, art arrives), so a single tap can land on a layout that has moved.
  // A probe confirmed ⚙ itself opens the panel on prod every time it is actually hit.
  let opened = null;
  for (let attempt = 1; attempt <= 3 && !opened; attempt++) {
    await b1.tapAt('#hub-settings');
    opened = await b1.waitFor(async () => (await b1.vis('#settings')) === 'shown' && (await b1.vis('#hub-howto')) === 'shown', 4000);
    if (!opened) console.log(`     (⚙ tap ${attempt} did not open the panel — retrying)`);
  }
  check(!!opened, 'main lobby → ⚙ → the ? is there');
  await b1.settled('#hub-howto');
  await b1.shot('first-05-question-mark-in-settings');
  const where = await b1.ev(`(()=>{
    const h=document.querySelector('#hub-howto').getBoundingClientRect();
    const card=document.querySelector('#settings .settings-card').getBoundingClientRect();
    const vol=document.querySelector('#s-soundvol').getBoundingClientRect();
    const title=document.querySelector('#settings h2').getBoundingClientRect();
    return JSON.stringify({
      // Every one of these needs a REAL rect: an off-screen element reports zeros, and
      // zero-is-less-than-ninety is true — which is how an earlier version of this check passed while
      // the hub was not even the visible screen.
      inCard: h.width > 8 && h.left >= card.left - 1 && h.top >= card.top - 1 && h.right <= card.right + 1,
      topLeftOfCard: h.width > 8 && (h.left - card.left) < 40 && (h.top - card.top) < 40,
      overTheVolume: h.width > 8 && h.bottom <= vol.top,     // "just over the sound volume"
      small: h.width > 8 && h.width <= 30,
      h: {x:Math.round(h.x), y:Math.round(h.y), w:Math.round(h.width)},
      card: {x:Math.round(card.x), y:Math.round(card.y)},
      volY: Math.round(vol.top), titleY: Math.round(title.top)
    });
  })()`);
  const w = JSON.parse(where);
  check(w.inCard, `it is inside the settings card (${where})`);
  check(w.topLeftOfCard, 'in its TOP-LEFT corner');
  check(w.overTheVolume, 'and above the 🔊 sound-volume row, as asked');
  check(w.small, 'small (≤30px)');
  // The tour is already skipped on this profile, so this proves the ? ignores the first-run flags.
  await b1.tapAt('#hub-howto');
  const replay = await b1.waitFor(async () => { const s = await b1.state(); return s && s.running ? s : null; }, 12000);
  check(!!replay, 'tapping it starts the tour again, even though this player already waved it away');
  // The same album rules apply on a replay — which now means an empty album gets the demo deck and the
  // full nineteen, not a shortened tour.
  check(!!replay && replay.tour === 'full', `a replay on an empty album also gets the demo deck (tour='${replay?.tour}')`);
  check(await b1.ev("document.querySelectorAll('#home-carousel .cf-card').length") === 7, 'the 7 demo cards are back for the replay');
  // AND THE PANEL IS GONE. #settings is a fixed overlay at z-index 20 with a blurred backdrop; a
  // lesson running underneath it would point a hand at a hub nobody can see or touch.
  check(await b1.vis('#settings') !== 'shown', 'the settings panel closed itself first — the lesson is not running under a modal');

  await b1.shot('first-06-question-mark-replay');
  // ---- A REPLAY'S FINISH PANEL MUST HAVE A WAY OUT ------------------------------------------
  // It is full-screen at z-index 42 and «עוד פעם» restarts the tour, so without «סגירה» finishing a
  // replay traps the player on the lobby.
  await b1.tapAt('#tu-hub-skip');            // end the replay the quick way
  await sleep(600);
  const replayPanel = await b1.vis('.ht-done');
  if (replayPanel === 'shown') {
    check(await b1.vis('#ht-close') === 'shown', 'the replay panel offers «סגירה»');
    await b1.tapAt('#ht-close');
    check(await b1.waitFor(async () => (await b1.vis('.ht-done')) !== 'shown', 4000) !== null, 'and it closes, leaving the player on the lobby');
  } else {
    // A SKIP does not show the panel at all, which is also a valid way out — say which path ran
    // rather than passing silently on a check that never happened.
    console.log('     (skipped a replay → no finish panel, so nothing to dismiss)');
    check(await b1.vis('#home') === 'shown', 'skipping a replay leaves the player on the lobby');
  }

  // ---- 🎛️ BESIDE THE ? : lobby → training ground with the controls editor open ---------------
  // The editor drags the LIVE sticks, so it only means anything inside a match — from the hub there was
  // no way to reach it at all. This is the whole chain, end to end, from a cold lobby.
  // Runs LAST in this scenario: it deliberately leaves the lobby, so anything that needs the hub has
  // to have happened already. (An earlier ordering put it first and the later lobby check then failed
  // while looking at the training ground.)
  await b1.waitFor(async () => (await b1.vis('#home')) === 'shown', 8000);
  let opened2 = null;
  for (let attempt = 1; attempt <= 3 && !opened2; attempt++) {
    await b1.tapAt('#hub-settings');
    opened2 = await b1.waitFor(async () => (await b1.vis('#hub-controls')) === 'shown', 4000);
  }
  check(!!opened2, 'the 🎛️ is in the settings card too');
  const pair = await b1.ev(`(()=>{
    const q=document.querySelector('#hub-howto').getBoundingClientRect();
    const c=document.querySelector('#hub-controls').getBoundingClientRect();
    return JSON.stringify({ sameRow: Math.abs(q.top-c.top) < 2, beside: c.left > q.left && (c.left-q.right) < 20,
                            sameSize: Math.abs(q.width-c.width) < 2, q:Math.round(q.left), c:Math.round(c.left) });
  })()`);
  const pr = JSON.parse(pair);
  check(pr.sameRow && pr.beside && pr.sameSize, `it sits NEXT TO the ?, same row and size (${pair})`);
  await b1.shot('first-08-settings-two-icons');
  await b1.tapAt('#hub-controls');
  // It has to leave the lobby, land in the training ground, and have the editor already up.
  const inTraining = await b1.waitFor(async () => (await b1.vis('#game')) === 'shown', 15000);
  check(!!inTraining, 'it takes you out of the lobby and into a room');
  const editorUp = await b1.waitFor(async () => (await b1.vis('#controls-editor')) === 'shown', 12000);
  check(!!editorUp, 'and the CONTROLS EDITOR is already open when you get there');
  await b1.shot('first-09-controls-editor-from-lobby');

  // ---- BOTH SHORTCUTS ARE LOBBY-ONLY -------------------------------------------------------
  // ⚙ is reachable mid-match, and neither shortcut means anything there: the ? would run a lesson about
  // the HUB on top of a live match, and the 🎛️ would ask for a brand-new room while the player is in
  // one. We are in the training ground right now, which is the place to prove it.
  const cancel = await b1.ev("!!document.querySelector('#controls-editor button.ce-cancel, #ce-cancel')");
  await b1.ev(`(()=>{const b=[...document.querySelectorAll('#controls-editor button')].find(x=>/ביטול/.test(x.textContent));if(b)b.click();})()`);
  await sleep(500);
  let inMatchSettings = null;
  for (let attempt = 1; attempt <= 3 && !inMatchSettings; attempt++) {
    await b1.tapAt('#pause-btn');
    inMatchSettings = await b1.waitFor(async () => (await b1.vis('#settings')) === 'shown', 4000);
  }
  check(!!inMatchSettings, `the in-match ⚙ opens settings (editor cancel found: ${cancel})`);
  check(await b1.vis('#hub-howto') !== 'shown', 'the ? is NOT there in a match');
  check(await b1.vis('#hub-controls') !== 'shown', 'and neither is the 🎛️');
  // The in-match route to the editor is still there — this is not a removal, just a relocation.
  check(await b1.vis('#setting-controls') === 'shown', '…while the match\'s own «עריכת מיקום הבקרות» still is');
  await b1.shot('first-10-settings-in-match-no-shortcuts');
  // And refused as well as hidden: one stray class should not be able to fire either of them.
  const refused = await b1.ev(`(()=>{
    const before = window.HubTour.state().running;
    document.querySelector('#hub-howto').click();
    return JSON.stringify({ before, after: window.HubTour.state().running });
  })()`);
  check(JSON.parse(refused).after === false, `and clicking the ? anyway does nothing off the hub (${refused})`);
  check(b1.errors.length === 0, `no uncaught JS errors${b1.errors.length ? `\n     ${b1.errors.slice(0, 3).join('\n     ')}` : ''}`);
} finally { b1.close(); }

// ---- SCENARIO 2 · a player WITH cards --------------------------------------------------------
// localhost, where DEV_LOCAL hands the client DEV_SAMPLE_CARDS — the only way to exercise the card
// half without an app injecting a real album.
if (REMOTE) {
  console.log('\n▶ a brand-new player who HAS cards — SKIPPED against a remote origin');
  console.log('     (DEV_SAMPLE_CARDS only exists on localhost, and only the app injects a real album,');
  console.log('      so the card half cannot be exercised here. Run without BASE= for that.)');
} else {
console.log('\n▶ a brand-new player who HAS cards (localhost sample album) — the full nineteen');
const b2 = await browser(9452, 'cards');
try {
  await b2.go(`${LOCAL_CARDS}/`);
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

  // ---- THE CAROUSEL IS STILL, AND THE RARE IS THE FRONT CARD --------------------------------
  // Both were real bugs on this page: the coverflow auto-rotates every 2.6s (the lab's sandbox filters
  // that interval out, so the bench froze and the shipped tour did not), and the front card — the only
  // one anybody actually grabs, 141px against the side cards' 90 — was whatever had spun in. Measured
  // before the fix: a LEGENDARY at the front with the rare tucked behind it, so the obvious drag gave
  // setHeroSkinByRarity('legendary') and the step could never complete.
  const front1 = await b2.ev("(document.querySelector('#home-carousel .cf-card.cf-center')||{}).className||''");
  check(/rarity-rare/.test(front1), `the RARE is the front card, so the obvious drag is the taught one (${front1})`);
  await sleep(3200);   // longer than one 2.6s rotation
  const front2 = await b2.ev("(document.querySelector('#home-carousel .cf-card.cf-center')||{}).className||''");
  check(front2 === front1, `and it is STILL there 3.2s later — the auto-rotate is frozen (${front2})`);

  // ---- A WRONG CARD ON THE HERO IS CORRECTED, NOT IGNORED ----------------------------------
  // A common/epic/legendary re-skins to base/holo/sig, so `done` stays false. Without a word on screen
  // the kid is left dragging at a lesson that looks broken — which is exactly what was reported.
  // Grab it the way a player can: CENTRE a non-rare first (the carousel's own tap-a-side-card-to-centre
  // behaviour), because a card behind the front one cannot be picked up — the front card is on top and
  // takes the touch. An earlier version of this check dragged from a side card's coordinates and
  // silently moved the RARE instead, which passed the lesson and failed the test.
  const notRare = await b2.ev(`(()=>{
    const c=[...document.querySelectorAll('#home-carousel .cf-card')].find(e=>!e.classList.contains('rarity-rare'));
    if(!c) return null; c.click(); return c.className;
  })()`);
  check(!!notRare, `there is a non-rare card to try it with (${notRare})`);
  await sleep(600);   // the coverflow animates to centre
  const centred = await b2.ev("(document.querySelector('#home-carousel .cf-card.cf-center')||{}).className||''");
  check(!/rarity-rare/.test(centred), `a non-rare is at the front for this attempt (${centred})`);
  await b2.liftTo('#home-carousel .cf-card.cf-center', '#pick-hero-btn');
  const corrected = await b2.waitFor(async () => (await b2.ev("(document.querySelector('#tu-nudge')||{}).textContent||''")).includes('לא הנדיר'), 5000);
  check(!!corrected, 'dropping the WRONG card says so at once: «זה לא הנדיר — קח את הקלף הכחול»');
  check((await b2.state()).stepId === 'hero', 'and the step is still the hero step — a wrong card advances nothing');

  // Now the taught gesture. Bring the rare back to the front first, as a player would after a wrong go.
  await b2.ev("document.querySelector('#home-carousel .cf-card.rarity-rare').click()");
  await sleep(600);
  await b2.liftTo('#home-carousel .cf-card.cf-center', '#pick-hero-btn');
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
  // ---- «הכי טוב» HOLDS FOR 2s BEFORE THE TOUR ENDS ----------------------------------------
  // User: "when pressing the equipped best should equipe best and wait 2 seconds before exiting". It is
  // the last step, and the exit restores the player's own loadout — so without the hold the three cards
  // appear and vanish in the same breath.
  const t0 = Date.now();
  await b2.tapAt('#select-best-btn');
  const filled3 = await b2.waitFor(async () => (await b2.ev("document.querySelectorAll('#power-slots .pslot:not(.pslot-empty)').length")) === 3, 6000);
  check(!!filled3, 'all three slots fill on the tap');
  const held = await b2.ev("(document.querySelector('#tu-cap')||{}).textContent||''");
  check(held.includes('החזקים'), `and the caption says what just happened while it holds («${held}»)`);
  const finished = await b2.waitFor(async () => { const s = await b2.state(); return s && !s.running ? s : null; }, 12000);
  const heldFor = (Date.now() - t0) / 1000;
  check(!!finished, 'the tour finished');
  check(heldFor >= 2, `…but only after holding ~2s so the kid SEES the three cards land (${heldFor.toFixed(1)}s from the tap)`);
  check(!!finished && finished.finished === true, 'and recorded a FINISH (not a skip)');
  await b2.shot('first-04-cards-finished');

  // ---- THE INVARIANT THAT MATTERS ON A REAL DEVICE -------------------------------------------
  // No sandbox here: this is real localStorage. saveLoadout/saveCosmetic reach postPrefs(), which the
  // app persists under the player's PHONE NUMBER, so a leak is a leak into their actual account.
  const after = await b2.ev("JSON.stringify({ l: localStorage.getItem('pikme-loadout'), c: localStorage.getItem('pikme_cosmetic') })");
  check(after === before, `the lesson wrote NOTHING to the player's real prefs\n     before ${before}\n     after  ${after}`);
  check(await b2.ev("localStorage.getItem('fbHubTourDone') === '1'"), 'fbHubTourDone = 1, so it will not fire again');
  // ---- THE PITCH TUTORIAL MUST ACTUALLY BE VISIBLE WHEN IT POPS ----------------------------
  // The finish panel is fixed/inset:0 at z-index 42. It used to be left up while level 1 started
  // underneath, so the kid landed in the pitch tutorial with a full-screen «יפה מאוד! / עוד פעם» over
  // it — the lesson had begun and could neither be seen nor reached (photographed:
  // _tu-shots/probe-after-finish.png). This is the guard for that.
  const level1b = await b2.waitFor(async () => (await b2.vis('#home')) !== 'shown', 12000);
  check(!!level1b, 'the pitch tutorial took over after the lobby tour finished');
  check(await b2.vis('.ht-done') !== 'shown', 'and the finish panel got OUT OF THE WAY — the tutorial is not behind a modal');
  check(await b2.vis('#game') === 'shown', 'the match screen is the one on top');
  // AND THE LOBBY TOUR'S STYLING IS OFF THE BODY. `ht-tour` carries this tour's restyling of the shared
  // coach (caption at the bottom on a plate, smaller text, pips above it). Left on, the PITCH tutorial
  // inherited it and drew its caption — authored at the TOP — down over the build tag. Caught in a
  // screenshot of the hand-off; asserted here so it cannot come back.
  const endState = await b2.ev(`JSON.stringify({
    body: document.body.className,
    capTop: Math.round(document.querySelector('.tu-caption').getBoundingClientRect().top),
    vh: window.innerHeight
  })`);
  const a = JSON.parse(endState);
  check(!/ht-tour|ht-read|ht-inert|hub-tu-gate/.test(a.body), `no lobby-tour classes left on <body> («${a.body}»)`);
  check(a.capTop < a.vh / 2, `the pitch tutorial's caption is back at the TOP where it is authored (y=${a.capTop} of ${a.vh})`);
  await b2.shot('first-07-pitch-tutorial-pops');
  check(b2.errors.length === 0, `no uncaught JS errors${b2.errors.length ? `\n     ${b2.errors.slice(0, 3).join('\n     ')}` : ''}`);
} finally { b2.close(); }
}

console.log(`\n${failures ? '❌' : '✅'} ${failures ? failures + ' FAILED' : 'ALL PASS'}\n`);
process.exit(failures ? 1 : 0);
