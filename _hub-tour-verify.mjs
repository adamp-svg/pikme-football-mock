// HUB TOUR LAB — REAL-BROWSER verification (Chrome via CDP, no puppeteer).
//
// Design: docs/superpowers/specs/2026-07-28-hub-tour-lab-design.md
//
// What only a browser can prove here:
//   • the lobby really is the lobby — 7 dummy cards in the real carousel, 3 EMPTY real slots,
//     the basic hero — because the sandbox has to win over effectiveLoadout()'s auto-fill and over
//     DEV_SAMPLE_CARDS, and both of those read their inputs at module-evaluation time;
//   • the coach is actually VISIBLE (#tutorial lives inside #game, which is display:none on the
//     hub — a text assertion passes while the screen is blank, which is how that shipped once);
//   • the two drags work under REAL TOUCH: a card can only be grabbed by LIFTING it (dy < -16,
//     mostly vertical), and the drop is resolved with elementFromPoint, which ignores anything the
//     gate left at pointer-events:none;
//   • the rare really turns the hero gold (a COMMON re-writes 'striker:base' and changes nothing);
//   • and that the lesson writes NOTHING and sends NOTHING — saveLoadout/saveCosmetic reach
//     postPrefs(), which the app persists under the player's phone number.
//
// Needs the lab server: PORT=3013 node server.js   (override with URL=/PORT=)
// Run: node _hub-tour-verify.mjs      Screenshots land in ./_tu-shots/
import { WebSocket } from 'ws';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { networkInterfaces } from 'node:os';

const PORT = process.env.PORT || 3013;
// NOT localhost: DEV_LOCAL is true for localhost/127.0.0.1/0.0.0.0 and hands the client
// DEV_SAMPLE_CARDS plus dev defaults — a different surface from the one the user opens on his
// phone. Resolved at RUNTIME because this machine has changed networks mid-session before.
const lanIp = () => Object.values(networkInterfaces()).flat()
  .filter((n) => n && n.family === 'IPv4' && !n.internal).map((n) => n.address)[0];
const HOST = process.env.HOST || lanIp() || 'localhost';
const PAGE = process.env.URL || `http://${HOST}:${PORT}/_hub-tour.html`;
const CDP_PORT = Number(process.env.CDP_PORT || 9413);
const PROFILE = `/tmp/lab-hub-verify-${process.pid}`;   // fresh profile => genuinely empty localStorage
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
// Both wrapped: killing Chrome and deleting its profile race each other, and an ENOTEMPTY from the
// cleanup would print a stack trace under a PASSING run and read as a failure.
process.on('exit', () => {
  try { chrome.kill(); } catch { /* already gone */ }
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch { /* Chrome still holds it */ }
});

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
const jsErrors = [];
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id); pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
  }
  // Console errors are evidence, not noise: a loop that throws every frame still looks "running"
  // from outside, because rAF reschedules before the body runs.
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params?.exceptionDetails;
    jsErrors.push(d?.exception?.description || d?.text || 'unknown');
  }
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
const count = (sel) => evalJs(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
const vis = (sel) => evalJs(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return 'missing';const s=getComputedStyle(e);return (s.display!=='none'&&s.visibility!=='hidden'&&e.getClientRects().length)?'shown':'hidden';})()`);
const text = async (sel) => (await evalJs(`(document.querySelector(${JSON.stringify(sel)})||{}).textContent||''`)).trim();
const state = () => evalJs('window.__labState ? window.__labState() : null');

// A REAL grab, not a straight line. The carousel only treats a press as a card lift when the
// pointer travels UP by more than 16px and mostly vertically (client.js ~1596) — anything else is
// read as a swipe. The slots and the hero are BELOW the carousel, so every one of these drags is
// up-then-down, which is exactly what the coach's hand mimes.
async function liftTo(fromSel, toSel) {
  const a = await rectOf(fromSel), b = await rectOf(toSel);
  if (!a || !b) throw new Error(`missing ${fromSel} or ${toSel}`);
  await touch('touchStart', a.x, a.y);
  await sleep(30);
  for (let i = 1; i <= 4; i++) { await touch('touchMove', a.x, a.y - i * 8); await sleep(25); }   // the LIFT
  const lx = a.x, ly = a.y - 32;
  for (let i = 1; i <= 12; i++) {
    await touch('touchMove', lx + (b.x - lx) * (i / 12), ly + (b.y - ly) * (i / 12));
    await sleep(25);
  }
  await touch('touchEnd', b.x, b.y);
  await sleep(450);
}
async function waitFor(fn, ms = 10000, every = 150) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(every); }
  return null;
}

console.log(`\n🧪 HUB TOUR LAB — ${PAGE}\n`);
await cdp('Page.navigate', { url: PAGE });

// ---------------------------------------------------------------------------------------------
console.log('▶ the lobby, cloned');
const st0 = await waitFor(async () => { const s = await state(); return s && s.running ? s : null; }, 15000);
check(!!st0, 'the lesson started (window.__labState reports running)');
// Card art comes from a remote bucket. The first screenshot of this lab caught seven blank cards —
// which was the shot racing the network, not a bug, but a blank-carded screenshot cannot be read as
// evidence that the lobby looks like the lobby. Wait for the art, then shoot.
const artIn = await waitFor(async () => {
  const n = await evalJs("[...document.querySelectorAll('#home-carousel .cf-card img')].filter(i=>i.naturalWidth>0).length");
  return n === 7 ? n : null;
}, 12000);
check(!!artIn, `all 7 cards have real art loaded (${artIn || 0}/7)`);
await shot('lab-01-start');

check(await count('#home-carousel .cf-card') === 7, `carousel holds 7 dummy cards (got ${await count('#home-carousel .cf-card')})`);
check(await count('#home-carousel .cf-card.rarity-rare') === 1, 'exactly one of them is RARE');
check(await count('#home-carousel .cf-card.rarity-common') === 6, 'the other six are COMMON');
// Every slot empty on arrival. Without SALTIZ_LOADOUT = [null,null,null], effectiveLoadout()
// auto-fills the album's top three and lesson 1 is finished before the kid touches anything.
check(await count('#power-slots .pslot') === 3, 'the real hub rendered 3 power slots');
check(await count('#power-slots .pslot.pslot-empty') === 3, `all 3 slots start EMPTY (got ${await count('#power-slots .pslot.pslot-empty')} empty)`);
check(await vis('#pick-hero-btn') === 'shown', 'the hero is on screen');
// The album must be dummies, not the localhost sample pack.
const albumIsOurs = await evalJs('JSON.stringify((window.__lab&&window.__lab.cards||[]).map(c=>c.r))');
check(albumIsOurs === '["rare","common","common","common","common","common","common"]', `the album is the lab's own deck (${albumIsOurs})`);

// ---------------------------------------------------------------------------------------------
console.log('\n▶ the coach is actually visible, and the rest of the hub is inert');
check(await vis('#tutorial') === 'shown', '#tutorial is SHOWN (not rendering into #game\'s hidden subtree)');
check(await evalJs("document.getElementById('tutorial').parentElement === document.body"), 'the coach was re-homed onto <body>');
check(await vis('#tu-hand') === 'shown', 'the pointing hand is on screen');
check(await text('#tu-cap') === 'גרור לכאן', `caption reads «גרור לכאן» (got «${await text('#tu-cap')}»)`);
check(await count('#tu-pips i') === 2, 'two pips — two lessons');
check(await evalJs("document.body.classList.contains('hub-tu-gate')"), 'the gate is up');
check(await evalJs("document.querySelector('.hub-cards').classList.contains('tu-live')"), 'the carousel is lit');
check(await evalJs("document.querySelector('#power-slots').classList.contains('tu-live')"), 'the SLOTS are lit too — elementFromPoint ignores pointer-events:none, so an unlit target eats every drop');
check(await evalJs("getComputedStyle(document.querySelector('#quick-match-btn')).pointerEvents === 'none'"), '⚽ (not part of this lesson) is untappable');
check(await evalJs("getComputedStyle(document.querySelector('#quick-match-btn')).filter !== 'none'"), '…and visibly dimmed rather than removed');
check(await vis('#tu-hub-skip') === 'shown', 'there is a way out (דלג ✕)');
// THE SCENERY IS DIMMED TOO. The gate only reaches `.hub > *`; the stadium is painted behind #home,
// so on the first run the lesson ran on a fully bright lobby with every per-element check passing.
check(await vis('.lab-scrim') === 'shown', 'the backdrop scrim is up — "everything dims" includes the scenery the gate cannot reach');
check(await evalJs("getComputedStyle(document.querySelector('.hub-pitch')).filter !== 'none'"), 'the pitch art itself is dimmed');
// THE CAPTION MUST NOT COVER WHAT THE LESSON POINTS AT. Generalised from a fault found by
// screenshot on the level-4 tour, and asserted for BOTH ends of the drag on every step, because the
// caption is fixed and the targets move with fitHub.
const capClear = (sel) => evalJs(`(()=>{
  const c=document.querySelector('.tu-caption').getBoundingClientRect();
  const t=document.querySelector(${JSON.stringify(sel)});
  if(!t) return null;
  const r=t.getBoundingClientRect();
  const hit = !(c.right<r.left||c.left>r.right||c.bottom<r.top||c.top>r.bottom);
  return { clear: !hit, cap:{y:Math.round(c.y),h:Math.round(c.height)}, tgt:{y:Math.round(r.y),h:Math.round(r.height)} };
})()`);
const capVsCard = await capClear('#home-carousel .cf-card.cf-center');
check(!!capVsCard && capVsCard.clear, `the caption does not cover the card being pointed at (${JSON.stringify(capVsCard)})`);
const capVsSlot = await capClear('#power-slots .pslot[data-slot="0"]');
check(!!capVsSlot && capVsSlot.clear, `…nor the slot it has to land in (${JSON.stringify(capVsSlot)})`);
check(await evalJs("document.querySelector('#power-slots .pslot[data-slot=\"0\"]').classList.contains('lab-drop')"), 'slot 0 is ringed as the drop target');
// The hand must be ON the card it points at, not merely inside the viewport.
const spot = await evalJs(`(()=>{
  const t=document.getElementById('tutorial'), s=document.querySelector('#home-carousel .cf-card.cf-center');
  if(!t||!s) return null;
  const cs=getComputedStyle(t), x=parseFloat(cs.getPropertyValue('--tu-x')), y=parseFloat(cs.getPropertyValue('--tu-y'));
  const r=s.getBoundingClientRect();
  return { inside: x>=r.x&&x<=r.right&&y>=r.y&&y<=r.bottom, x, y, r:{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)} };
})()`);
check(!!spot && spot.inside, `the hand starts ON the front card (${JSON.stringify(spot)})`);
check((await state()).carouselFrozen === true, 'the carousel auto-rotate is frozen — otherwise the card under the hand drifts away');

// THE GESTURE IS PULL-UP-THEN-SWIPE, IN THAT ORDER. Asserted by sampling the hand's own animation
// at fixed points rather than by eye: a diagonal sweep looks similar in a still frame but is the
// gesture the carousel reads as a SWIPE, so a kid copying it would spin the deck instead of picking
// a card up. Read straight off the WAAPI timeline — the shape of the mime, not a screenshot of it.
// Read off the AUTHORED KEYFRAMES, not off rendered style: setting currentTime on a paused
// animation and reading getComputedStyle in the same task returns a value that lags a frame, which
// made an earlier version of this check report the hand 11px up at a keyframe that says 34.
// The keyframe list is the gesture — the shape, in order, with no sampling to get wrong.
const gesture = await evalJs(`(()=>{
  const h=document.getElementById('tu-hand'), a=h.getAnimations()[0];
  if(!a || !a.effect) return null;
  const num = (s) => String(s||'0px 0px').split(' ').map(v=>Math.round(parseFloat(v)||0));
  const ks = a.effect.getKeyframes().map(k => { const t=num(k.translate); return { o:+(k.computedOffset ?? k.offset ?? 0).toFixed(2), x:t[0]||0, y:t[1]||0, op:k.opacity }; });
  const at = (o) => ks.find(k => Math.abs(k.o - o) < 0.005) || null;
  return { playing: a.playState === 'running', n: ks.length, ks,
           up: at(0.16), hold: at(0.32), across: at(0.56), down: at(0.74) };
})()`);
check(!!gesture && gesture.playing, 'the hand is actually animating (playState running)');
check(!!gesture?.up && gesture.up.y <= -16 && Math.abs(gesture.up.x) === 0,
  `beat 1 is a STRAIGHT PULL UP, no sideways travel yet — ${JSON.stringify(gesture?.up)}. The real handler needs dy < -16 and mostly vertical, else it reads as a carousel swipe`);
check(!!gesture?.hold && Math.abs(gesture.hold.x) === 0 && gesture.hold.y === gesture.up.y,
  `…and the hand HOLDS up there, so the pull reads as its own action — ${JSON.stringify(gesture?.hold)}`);
check(!!gesture?.across && Math.abs(gesture.across.x) > 20 && gesture.across.y === gesture.hold.y,
  `beat 2 swipes ACROSS at the lifted height — ${JSON.stringify(gesture?.across)}`);
check(!!gesture?.down && gesture.down.y > gesture.across.y && Math.abs(gesture.down.x) > Math.abs(gesture.across.x),
  `…and only then sets the card down on the target — ${JSON.stringify(gesture?.down)}`);

// ---------------------------------------------------------------------------------------------
console.log('\n▶ LESSON 1 — lift a card into a power slot');
await liftTo('#home-carousel .cf-card.cf-center', '#power-slots .pslot[data-slot="0"]');
const filled = await waitFor(async () => (await count('#power-slots .pslot:not(.pslot-empty)')) > 0, 6000);
check(!!filled, 'a REAL slot really filled');
const st1 = await waitFor(async () => { const s = await state(); return s && s.stepId === 'hero' ? s : null; }, 6000);
check(!!st1, `the machine advanced to lesson 2 (stepId=${(await state())?.stepId})`);
check(await text('#tu-cap') === 'נדיר על הגיבור', `caption swapped to «נדיר על הגיבור» (got «${await text('#tu-cap')}»)`);
check(await evalJs("document.querySelector('#pick-hero-btn').classList.contains('lab-drop')"), 'the HERO is now the ringed target');
check(await evalJs("document.querySelector('#pick-hero-btn').classList.contains('tu-live')"), 'the hero is lit, so the drop can land on it');
await shot('lab-02-slot-filled');

// ---------------------------------------------------------------------------------------------
console.log('\n▶ LESSON 2 — the rare on the hero');
await liftTo('#home-carousel .cf-card.rarity-rare', '#pick-hero-btn');
const gold = await waitFor(async () => {
  const s = await state();
  return s && s.writes.some((w) => w.k === 'pikme_cosmetic' && String(w.v).endsWith(':gold'));
}, 6000);
check(!!gold, 'the hero really went RARE → gold (setHeroSkinByRarity ran with the rare card)');
const fin = await waitFor(async () => (await vis('.lab-done')) === 'shown', 6000);
// The cosmetic ALSO went out on the wire — a second, independent code path (sendMsg) saying the same
// thing as the blocked localStorage write, and the one the sandbox has to intercept so a dummy album
// is never described to the server as this player's look.
const goldSend = (await state()).sends.some((m) => m.type === 'setCosmetic' && m.cosmetic === 'striker:gold');
check(goldSend, `setCosmetic('striker:gold') was produced and intercepted (${JSON.stringify((await state()).sends)})`);
check(!!fin, 'the lesson finished and offered another go');
check(await evalJs("!document.body.classList.contains('hub-tu-gate')"), 'the gate came down — the hub is tappable again');
check(await vis('.lab-scrim') !== 'shown', 'the scrim came down with it — the lobby is at full brightness again');
await shot('lab-03-hero-gold');
// THE PAYOFF, PHOTOGRAPHED. The finale panel covers the hero it just changed, and «base → gold» is
// the entire point of lesson 2 — so the panel is lifted for one frame to shoot the hero itself.
// A pixel assertion is not available here: the hero DANCES, so its pixels differ frame to frame
// whatever the skin is. This screenshot is for reading, and it gets read.
await evalJs("document.querySelector('.lab-done').classList.add('hidden')");
await sleep(400);
await shot('lab-04-hero-gold-uncovered');
await evalJs("document.querySelector('.lab-done').classList.remove('hidden')");

// ---------------------------------------------------------------------------------------------
console.log('\n▶ the lesson wrote NOTHING and sent NOTHING');
// saveLoadout / saveCosmetic both reach postPrefs(), which the app persists under the player's
// PHONE NUMBER. A leak here is a leak into a real account, so this is asserted, never assumed.
check(await evalJs("localStorage.getItem('pikme_cosmetic') === null"), 'no hero was persisted to localStorage');
check(await evalJs("localStorage.getItem('pikme-loadout') === null"), 'no loadout was persisted to localStorage');
const sends = (await state()).sends || [];
check(sends.every((m) => m.type === 'setLoadout' || m.type === 'setCosmetic'), 'only loadout/cosmetic messages were intercepted');
check(await evalJs("!!window.__lab && window.__lab.writes.length > 0"), `the writes were attempted and BLOCKED (${(await state()).writes.length} recorded) — proof the real code path ran`);
check(await evalJs("!window.ReactNativeWebView"), 'no app bridge on this surface, so postPrefs() had nowhere to go either');

console.log('\n▶ console');
check(jsErrors.length === 0, `no uncaught JS errors${jsErrors.length ? `\n     ${jsErrors.slice(0, 4).join('\n     ')}` : ''}`);

console.log(`\n${failures ? '❌' : '✅'} ${failures ? failures + ' FAILED' : 'ALL PASS'}\n`);
ws.close();
process.exit(failures ? 1 : 0);
