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
async function tap(sel) {
  const r = await rectOf(sel);
  if (!r) throw new Error(`no element ${sel}`);
  await touch('touchStart', r.x, r.y);
  await sleep(40);
  await touch('touchEnd', r.x, r.y);
  await sleep(350);
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
// WHERE THE WRITE INVARIANT STARTS. client.js validates the injected loadout against the album at
// BOOT (loadout entries for cards you do not own are dropped, and that re-saves) — those writes are
// its own housekeeping and happen before the tour exists. The invariant is about what the TOUR does,
// so it is measured from here, not from page load.
const writes0 = (await state()).writes.length;
console.log(`     (${writes0} pre-tour write(s) by client.js's own boot: ${JSON.stringify((await state()).writes.map((w) => w.k))})`);
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
console.log('\n▶ the coach is up, everything else is dark and inert');
check(await vis('#tutorial') === 'shown', '#tutorial is SHOWN (not rendering into #game\'s hidden subtree)');
check(await evalJs("document.getElementById('tutorial').parentElement === document.body"), 'the coach was re-homed onto <body>');
check(await vis('#tu-hand') === 'shown', 'the pointing hand is on screen');
check(await evalJs("document.body.classList.contains('hub-tu-gate')"), 'the gate is up');
check(await vis('.ht-scrim') === 'shown', 'the backdrop scrim is up — "everything dims" includes the scenery the gate cannot reach');
check(await evalJs("getComputedStyle(document.querySelector('.hub-pitch')).filter !== 'none'"), 'the pitch art itself is dimmed');
check(await vis('#tu-hub-skip') === 'shown', 'there is a way out (דלג ✕)');
check((await state()).carouselFrozen === true, 'the carousel auto-rotate is frozen — otherwise the card under the hand drifts away');

// THE ORDER IS THE WHOLE POINT OF THIS ROUND: the home legend first, then the hero, then the three
// slots explained, then the drag, then «הכי טוב». Asserted as one list so a re-order cannot pass.
const HOME_ORDER = [
  ['settings', 'הגדרות', '#hub-settings'],
  ['online',   'מחוברים', '.hub-online'],
  ['friends',  'חברים', '#friends-btn'],
  ['clubs',    'מועדונים', '[data-open-screen="clubs"]'],
  ['store',    'חנות', '[data-open-screen="shop"]'],
  ['news',     'חדשות', '[data-open-screen="news"]'],
  ['rank',     'דירוג', '#rank-btn'],
  ['quick',    'משחק מהיר', '#quick-match-btn'],
  ['choose',   'בחר משחק', '[data-open-screen="arena"]'],
  ['withfr',   'שחק עם חברים', '#play-friends-btn'],
  ['training', 'אימון', '#training-btn'],
  ['builder',  'בונה מגרש', '#field-builder-btn'],
  ['profile',  'הפרופיל שלי', '#home-face'],
];
// The Hebrew word only. The captions carry a leading ⚡/🏃/🛡️, and icon-system.js REPLACES emoji in
// the DOM with pixel sprites — so textContent comes back without them. The sprite is wanted (it is the
// game's own look), so the check is `includes`, not equality.
const SLOT_ORDER = [
  ['slot0', 'בעיטה',  '#power-slots .pslot[data-slot="0"]'],
  ['slot1', 'מהירות', '#power-slots .pslot[data-slot="1"]'],
  ['slot2', 'הגנה',   '#power-slots .pslot[data-slot="2"]'],
];
const FULL_ORDER = [...HOME_ORDER.map((o) => o[0]), 'hero', ...SLOT_ORDER.map((o) => o[0]), 'slot', 'best'];
const st = await state();
check(st.tour === 'full', `the default run is the full tour (got '${st.tour}')`);
check(JSON.stringify(st.stepIds) === JSON.stringify(FULL_ORDER),
  `19 steps, home first then the cards: ${JSON.stringify(st.stepIds)}`);
check(st.stepId === 'settings', `it OPENS on the home legend, not on a card (step 1 = '${st.stepId}')`);
check(await count('#tu-pips i') === 19, `19 pips (got ${await count('#tu-pips i')})`);

// A READ step: lit, named, explained, INERT, and the hand clear of the thing it points at.
// The hand is 54px and most of these targets are smaller, so a hand centred on ⚙ hides the very
// element being described — which is what the first screenshot of the legend showed.
async function readStep(i, id, name, sel, label) {
  const s = await state();
  if (s.stepId !== id) { console.log(`  ❌ ${label} should be '${id}', machine says '${s.stepId}'`); failures++; return false; }
  const lit = await evalJs(`(()=>{
    const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return null;
    const box=e.closest('.hub > *')||e;
    const h=document.getElementById('tu-hand').getBoundingClientRect();
    const r=e.getBoundingClientRect(), cx=r.x+r.width/2, cy=r.y+r.height/2;
    return { pick: e.classList.contains('ht-pick'), boxShown: box.classList.contains('ht-show'),
             filter: getComputedStyle(box).filter, pe: getComputedStyle(e).pointerEvents,
             handCovers: cx>=h.left&&cx<=h.right&&cy>=h.top&&cy<=h.bottom };
  })()`);
  const cap = await text('#tu-cap'), sub = await text('#tu-nudge');
  const ok = lit && lit.pick && lit.boxShown && lit.filter === 'none' && lit.pe === 'none'
    && !lit.handCovers && cap.includes(name) && sub.length > 3;
  if (!ok) { console.log(`  ❌ ${label} ${id}: ${JSON.stringify({ lit, cap, sub })}`); failures++; return false; }
  console.log(`  ✅ ${label} «${name}» lit, inert, explained, hand clear — «${sub}»`);
  return true;
}
// Advance a read step the way a kid does: a tap on the dark.
async function tapDark() {
  await touch('touchStart', 60, 200); await sleep(30); await touch('touchEnd', 60, 200);
  await sleep(260);
}

// ---------------------------------------------------------------------------------------------
console.log('\n▶ STEPS 1-13 · THE HOME LEGEND');
check(await vis('.ht-catch') === 'shown', 'a read step puts the tap-catcher up');
check(await vis('#ht-next') === 'shown', '…and a «הבא ›» button for anyone who wants one');
let legendFaults = 0;
for (let i = 0; i < HOME_ORDER.length; i++) {
  const [id, name, sel] = HOME_ORDER[i];
  if (!await readStep(i, id, name, sel, `${i + 1}.`)) { legendFaults++; break; }
  if (i === 0) await shot('lab-01-home-settings');
  if (i === 7) await shot('lab-02-home-quickplay');
  if (i === 12) await shot('lab-03-home-profile');
  await tapDark();
}
check(legendFaults === 0, `all 13 home elements lit the right thing, left it inert, and explained it`);
check(await vis('#home') === 'shown', 'we are still on the hub — no legend step navigated away');

// ---------------------------------------------------------------------------------------------
console.log('\n▶ STEP 14 · THE HERO — the rare card, dragged onto him');
const atHero = await waitFor(async () => { const s = await state(); return s && s.stepId === 'hero' ? s : null; }, 6000);
check(!!atHero, `the legend handed over to the hero lesson (stepId=${(await state())?.stepId})`);
check(await text('#tu-cap') === 'נדיר על הגיבור', `caption reads «נדיר על הגיבור» (got «${await text('#tu-cap')}»)`);
check(await evalJs("!document.querySelector('.ht-catch')"), 'the tap-catcher is GONE for a drag step — left up it would eat the gesture');
check(await evalJs("document.querySelector('.hub-cards').classList.contains('tu-live')"), 'the carousel is live again');
check(await evalJs("document.querySelector('#pick-hero-btn').classList.contains('tu-live')"), 'the hero is live, so the drop can land on it');
check(await evalJs("getComputedStyle(document.querySelector('#quick-match-btn')).pointerEvents === 'none'"), '⚽ (not part of this lesson) is untappable');
// THE CAPTION MUST NOT COVER WHAT THE LESSON POINTS AT — generalised from a fault found by screenshot
// on the level-4 tour, and checked on both ends because the caption is fixed while the targets move
// with fitHub.
// "Clear" means the caption does not sit ON the target: it must miss the target's CENTRE and cover no
// more than a quarter of its height. A strict any-overlap test fails on a graze that hides nothing —
// the hero's button box is 246px tall and its bottom edge laps 9px into the caption while the
// character itself, a 210px canvas centred in it, is nowhere near. The fault worth catching is a
// caption covering the thing being pointed at, not two rectangles touching.
const capClear = (sel) => evalJs(`(()=>{
  const c=document.querySelector('.tu-caption').getBoundingClientRect();
  const t=document.querySelector(${JSON.stringify(sel)});
  if(!t) return null;
  const r=t.getBoundingClientRect();
  const cx=r.x+r.width/2, cy=r.y+r.height/2;
  const onCentre = cx>=c.left&&cx<=c.right&&cy>=c.top&&cy<=c.bottom;
  const overlapY = Math.max(0, Math.min(c.bottom,r.bottom)-Math.max(c.top,r.top));
  const frac = overlapY/r.height;
  return { clear: !onCentre && frac <= 0.25, onCentre, frac:+frac.toFixed(2),
           cap:{y:Math.round(c.y),h:Math.round(c.height)}, tgt:{y:Math.round(r.y),h:Math.round(r.height)} };
})()`);
const capVsCard = await capClear('#home-carousel .cf-card.rarity-rare');
check(!!capVsCard && capVsCard.clear, `the caption does not cover the card (${JSON.stringify(capVsCard)})`);
const capVsHero = await capClear('#pick-hero-btn');
check(!!capVsHero && capVsHero.clear, `…nor the hero it has to land on (${JSON.stringify(capVsHero)})`);
// The hand must be ON the card it points at, not merely inside the viewport.
const spot = await evalJs(`(()=>{
  const t=document.getElementById('tutorial'), s=document.querySelector('#home-carousel .cf-card.rarity-rare');
  if(!t||!s) return null;
  const cs=getComputedStyle(t), x=parseFloat(cs.getPropertyValue('--tu-x')), y=parseFloat(cs.getPropertyValue('--tu-y'));
  const r=s.getBoundingClientRect();
  return { inside: x>=r.x&&x<=r.right&&y>=r.y&&y<=r.bottom, x, y };
})()`);
check(!!spot && spot.inside, `the hand starts ON the rare card (${JSON.stringify(spot)})`);

// THE GESTURE IS PULL-UP-THEN-SWIPE, IN THAT ORDER. Read off the AUTHORED KEYFRAMES, not off rendered
// style: setting currentTime on a paused animation and reading getComputedStyle in the same task
// returns a value that lags a frame, which had an earlier version of this check reporting the hand
// 11px up at a keyframe that says 48. The keyframe list IS the gesture.
const gesture = await evalJs(`(()=>{
  const h=document.getElementById('tu-hand'), a=h.getAnimations()[0];
  if(!a || !a.effect) return null;
  const num = (s) => String(s||'0px 0px').split(' ').map(v=>Math.round(parseFloat(v)||0));
  const ks = a.effect.getKeyframes().map(k => { const t=num(k.translate); return { o:+(k.computedOffset ?? k.offset ?? 0).toFixed(2), x:t[0]||0, y:t[1]||0 }; });
  const at = (o) => ks.find(k => Math.abs(k.o - o) < 0.005) || null;
  return { playing: a.playState === 'running', up: at(0.16), hold: at(0.32), across: at(0.56), down: at(0.74) };
})()`);
check(!!gesture && gesture.playing, 'the hand is animating (playState running)');
check(!!gesture?.up && gesture.up.y <= -40 && Math.abs(gesture.up.x) === 0,
  `beat 1 is a STRAIGHT PULL UP and it is HIGH — ${JSON.stringify(gesture?.up)} (raised to 48 on request; the real handler needs dy < -16 and mostly vertical or it reads as a carousel swipe)`);
check(!!gesture?.hold && Math.abs(gesture.hold.x) === 0 && gesture.hold.y === gesture.up.y,
  `…and the hand HOLDS up there, so the pull reads as its own action — ${JSON.stringify(gesture?.hold)}`);
check(!!gesture?.across && Math.abs(gesture.across.x) > 20 && gesture.across.y === gesture.hold.y,
  `beat 2 swipes ACROSS at the lifted height — ${JSON.stringify(gesture?.across)}`);
check(!!gesture?.down && gesture.down.y > gesture.across.y,
  `…and only then sets the card down on the target — ${JSON.stringify(gesture?.down)}`);

await liftTo('#home-carousel .cf-card.rarity-rare', '#pick-hero-btn');
// Read through client.js's own seam (window.__hubPrefs.cosmetic), because during the tour NOTHING is
// written — the sandbox flag stops saveCosmetic before localStorage. The live myCosmetic is the truth.
const gold = await waitFor(async () => {
  const s = await state();
  return s && s.cosmetic === 'striker:gold';
}, 6000);
check(!!gold, `the hero really went RARE → gold (myCosmetic = ${(await state()).cosmetic})`);
const goldSend = (await state()).sends.some((m) => m.type === 'setCosmetic' && m.cosmetic === 'striker:gold');
check(goldSend, `setCosmetic('striker:gold') was produced and intercepted (${JSON.stringify((await state()).sends)})`);
await shot('lab-04-hero-gold');

// ---------------------------------------------------------------------------------------------
console.log('\n▶ STEPS 15-17 · WHAT EACH SLOT DOES — explained while they are still empty');
const atSlots = await waitFor(async () => { const s = await state(); return s && s.stepId === 'slot0' ? s : null; }, 6000);
check(!!atSlots, `the hero lesson handed over to the slot legend (stepId=${(await state())?.stepId})`);
// The reason this comes BEFORE the drag: an empty slot is the only time each one shows its own
// ⚡/🏃/🛡️ glyph instead of a card, so the thing being explained is actually on screen.
check(await count('#power-slots .pslot.pslot-empty') === 3, `all 3 slots are still EMPTY while being explained (got ${await count('#power-slots .pslot.pslot-empty')})`);
check(await vis('.ht-catch') === 'shown', 'the tap-catcher came back for these read steps');
let slotFaults = 0;
for (let i = 0; i < SLOT_ORDER.length; i++) {
  const [id, name, sel] = SLOT_ORDER[i];
  if (!await readStep(i, id, name, sel, `${15 + i}.`)) { slotFaults++; break; }
  if (i === 0) await shot('lab-05-slot-explained');
  await tapDark();
}
check(slotFaults === 0, 'all three slots were named and explained, each inert');

// ---------------------------------------------------------------------------------------------
console.log('\n▶ STEP 18 · A CARD INTO A SLOT');
const atDrag = await waitFor(async () => { const s = await state(); return s && s.stepId === 'slot' ? s : null; }, 6000);
check(!!atDrag, `the slot legend handed over to the drag (stepId=${(await state())?.stepId})`);
check(await text('#tu-cap') === 'גרור לכאן', `caption reads «גרור לכאן» (got «${await text('#tu-cap')}»)`);
check(await evalJs("!document.querySelector('.ht-catch')"), 'the catcher is down again for the drag');
check(await evalJs("document.querySelector('#power-slots').classList.contains('tu-live')"), 'the SLOTS are lit — elementFromPoint ignores pointer-events:none, so an unlit target eats every drop');
check(await evalJs("document.querySelector('#power-slots .pslot[data-slot=\"0\"]').classList.contains('ht-drop')"), 'slot 0 is ringed as the drop target');
await liftTo('#home-carousel .cf-card.cf-center', '#power-slots .pslot[data-slot="0"]');
const filled = await waitFor(async () => (await count('#power-slots .pslot:not(.pslot-empty)')) > 0, 6000);
check(!!filled, 'a REAL slot really filled');
await shot('lab-06-slot-filled');

// ---------------------------------------------------------------------------------------------
console.log('\n▶ STEP 19 · «הכי טוב» fills all three in one tap');
const atBest = await waitFor(async () => { const s = await state(); return s && s.stepId === 'best' ? s : null; }, 6000);
check(!!atBest, `the machine reached the last step (stepId=${(await state())?.stepId})`);
check(await text('#tu-cap') === 'הכי טוב', `caption reads «הכי טוב» (got «${await text('#tu-cap')}»)`);
check(await evalJs("document.getElementById('tu-hand').classList.contains('gest-tap')"), 'the hand switched to the TAP mime for a button step');
check(await evalJs("document.querySelector('#select-best-btn').classList.contains('tu-live')"), '✨ הכי טוב is the lit, tappable target');
const beforeBest = await count('#power-slots .pslot:not(.pslot-empty)');
await tap('#select-best-btn');
// NOT asserted by counting filled slots afterwards: this is the last step, so the tour finishes and
// RESTORES the player's loadout within the same beat — an earlier version of this check raced that and
// read the reverted state. The deterministic evidence is the message «הכי טוב» produces: setLoadout
// with three cards in it, intercepted on its way to the socket.
const fin = await waitFor(async () => (await vis('.ht-done')) === 'shown', 8000);
check(!!fin, 'the tour finished');
const bestSend = (await state()).sends.find((m) => m.type === 'setLoadout'
  && Array.isArray(m.loadout) && m.loadout.filter(Boolean).length === 3);
check(!!bestSend, `«הכי טוב» equipped all three at once, in one tap (was ${beforeBest} before it): ${JSON.stringify(bestSend?.loadout)}`);
check(await evalJs("!document.body.classList.contains('hub-tu-gate')"), 'the gate came down — the hub is tappable again');
check(await vis('.ht-scrim') !== 'shown', 'the scrim came down with it — the lobby is at full brightness again');
check(await evalJs("!document.querySelector('.ht-catch')"), 'the tap-catcher was removed on the way out');

// ---- THE REVERT — "nothing the lesson does is saved" ----------------------------------------
// The kid equipped a card, re-skinned the hero, then filled all three slots. None of it may survive
// the lesson. The lab starts from SALTIZ_LOADOUT=[null,null,null] and 'striker:base', so "back as it
// was" is checkable exactly.
const restored = await waitFor(async () => (await count('#power-slots .pslot.pslot-empty')) === 3, 5000);
check(!!restored, `every slot is EMPTY again — the lesson's loadout did not survive it (${await count('#power-slots .pslot.pslot-empty')}/3 empty)`);
check((await state()).cosmetic === 'striker:base', `and the hero is back in his own skin (myCosmetic = ${(await state()).cosmetic})`);
await shot('lab-07-best-equipped');
// The payoff, photographed with the panel lifted for one frame: three equipped slots and a gold hero.
// A pixel assertion is not available — the hero DANCES, so its pixels differ frame to frame whatever
// the skin is. This screenshot is for reading, and it gets read.
await evalJs("document.querySelector('.ht-done').classList.add('hidden')");
await sleep(400);
await shot('lab-08-final-uncovered');

// ---------------------------------------------------------------------------------------------
console.log('\n▶ ONE loop, and the lesson wrote NOTHING and sent NOTHING');
// finish() runs inside a tick that has already queued its successor, so a hand-off used to leave the
// previous run's loop alive: two loops, double stepT, and both able to consume one done() and skip a
// step between them.
await evalJs("window.__labStart('cards')");
await sleep(500);
const t0 = (await state()).stepT; await sleep(1000);
const dT = (await state()).stepT - t0;
check(dT > 0.6 && dT < 1.5, `exactly one machine ticks after a restart — 1.0s of wall clock moved stepT by ${dT.toFixed(2)}s (two loops would roughly double it)`);
// saveLoadout / saveCosmetic both reach postPrefs(), which the app persists under the player's PHONE
// NUMBER. A leak here is a leak into a real account, so this is asserted, never assumed.
check(await evalJs("localStorage.getItem('pikme_cosmetic') === null"), 'no hero was persisted to localStorage');
check(await evalJs("localStorage.getItem('pikme-loadout') === null"), 'no loadout was persisted to localStorage');
check((await state()).sends.every((m) => m.type === 'setLoadout' || m.type === 'setCosmetic'), 'only loadout/cosmetic messages were intercepted');
// ZERO, not "blocked at the last moment": with the sandbox flag raised, setSlotCard / swapSlots /
// saveLoadout / saveCosmetic all return before they reach localStorage at all. The proof that the real
// code path ran is elsewhere — a real slot filled, and setCosmetic went out on the wire.
// The invariant is about the PLAYER'S PREFS, not about every key on the page: the tour legitimately
// records its own first-run flag (fbHubTourDone), and that one MUST persist in the real game or a kid
// gets the lesson again on every launch. What must never be touched is the loadout and the hero —
// saveLoadout/saveCosmetic reach postPrefs(), which the app writes under the player's PHONE NUMBER.
const during = (await state()).writes.slice(writes0);
const prefWrites = during.filter((w) => w.k === 'pikme-loadout' || w.k === 'pikme_cosmetic');
check(prefWrites.length === 0, `the TOUR attempted no write to the loadout or the hero (its writes: ${JSON.stringify(during.map((w) => w.k))})`);
check(during.some((w) => w.k === 'fbHubTourDone'), 'the tour DID record its own first-run flag — that is what stops it firing again tomorrow');
check((await state()).sends.some((m) => m.type === 'setCosmetic'), 'the real setHeroSkinByRarity path ran (setCosmetic on the wire)');
check(await evalJs("!window.ReactNativeWebView"), 'no app bridge on this surface, so postPrefs() had nowhere to go either');

console.log('\n▶ console');
check(jsErrors.length === 0, `no uncaught JS errors${jsErrors.length ? `\n     ${jsErrors.slice(0, 4).join('\n     ')}` : ''}`);

console.log(`\n${failures ? '❌' : '✅'} ${failures ? failures + ' FAILED' : 'ALL PASS'}\n`);
ws.close();
process.exit(failures ? 1 : 0);
