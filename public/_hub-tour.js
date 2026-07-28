// HUB TOUR LAB — the two-lesson coach. Loaded LAST, after client.js has rendered the hub.
// Design: docs/superpowers/specs/2026-07-28-hub-tour-lab-design.md
//
// Two lessons, on the real lobby, with the real drag handlers:
//   1. lift a card out of the carousel into a POWER SLOT
//   2. lift the RARE card onto the HERO  → base → gold, the visible payoff
//
// Nothing here reaches into client.js. It reads the DOM the hub renders, and it latches completion
// off the writes the sandbox blocks (setSlotCard → 'pikme-loadout', setHeroSkinByRarity →
// 'pikme_cosmetic'), which is why no socket and no module-private state is needed.
//
// The coach FURNITURE is the shipped one — #tutorial, .tu-veil, .tu-hand, #tu-cap, #tu-nudge,
// #tu-pips, body.hub-tu-gate, .tu-live, #tu-hub-skip. Only the hand's PATH is new: every shipped
// mime is a fixed CSS keyframe shape, and a drag from a named card to a named target is directed.

const lab = window.__lab || { writes: [], lastWrite: () => null, carouselFrozen: false };

const $ = (s) => document.querySelector(s);
const tuEl = $('#tutorial');
const handEl = $('#tu-hand');
const capEl = $('#tu-cap');
const nudgeEl = $('#tu-nudge');
const pipsEl = $('#tu-pips');

// Seconds of no progress before the coach escalates: the hand grows (shipped CSS) and the second
// line switches to the fix-it wording. No clock, no fail state — this is the only thing that ever
// reacts to time.
const NUDGE_AFTER = 9;

// ---------------------------------------------------------------------------------------------
// The lessons
// ---------------------------------------------------------------------------------------------
// `src` is where the finger STARTS (the spotlight and the hand's origin), `dst` is where it has to
// end up (the dashed ring). Both are resolved fresh every frame: the hub is a scaled stage (fitHub)
// and the carousel re-lays out, so a rect captured once is a rect that will be wrong.
//
// LESSON 1 aims at the FRONT card, `.cf-card.cf-center` — the biggest and frontmost of the stack,
// the only one a seven-year-old can reliably grab. With the rare given the album's top worth, the
// carousel's own ranking puts it there, so both lessons start from the same easy target and differ
// only in where the card goes. Equipping does not remove a card from the album (renderCarousel
// reads myCards(), not the loadout), so it is still there for lesson 2.
const STEPS = [
  {
    id: 'slot',
    cap: 'גרור לכאן',
    sub: 'קלף במשבצת = כוח במשחק',
    nudge: 'הרם את הקלף למעלה — ואז למשבצת',
    src: () => $('#home-carousel .cf-card.cf-center') || $('#home-carousel .cf-card'),
    dst: () => $('#power-slots .pslot[data-slot="0"]'),
    // BOTH ENDS must be live. slotUnder() resolves the drop with document.elementFromPoint, and
    // that skips anything with `pointer-events: none` — so a gate that lit only the carousel would
    // let the kid lift a card and then swallow every single drop.
    live: ['.hub-cards', '#power-slots'],
    // The real slot really filled. Read off the class renderPowerSlots writes, not off our own
    // bookkeeping: `.pslot-empty` is present exactly while a slot holds nothing.
    done: () => !!$('#power-slots .pslot:not(.pslot-empty)'),
  },
  {
    id: 'hero',
    cap: 'נדיר על הגיבור',
    sub: 'קלף נדיר = מראה מיוחד',
    nudge: 'גרור את הקלף הנדיר על הדמות',
    src: () => $('#home-carousel .cf-card.rarity-rare') || $('#home-carousel .cf-card.cf-center'),
    dst: () => $('#pick-hero-btn'),
    live: ['.hub-cards', '#pick-hero-btn'],
    // The hero really changed tier. setHeroSkinByRarity maps rarity → skin (common:'base',
    // rare:'gold'), then saveCosmetic attempts the write the sandbox blocks and records. Asserting
    // ':gold' rather than "a cosmetic write happened" is the difference between teaching this
    // lesson and passing it by dropping a COMMON on the hero — which re-writes 'striker:base' and
    // changes nothing on screen.
    done: () => String(lab.lastWrite('pikme_cosmetic') || '').endsWith(':gold'),
  },
];

let step = 0;
let stepT = 0;
let prevT = 0;
let running = false;
let handAnim = null;
let handKey = '';       // the geometry the current hand animation was built for
let doneEl = null;

// ---------------------------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------------------------
// The hub renders asynchronously (card art preloads, fitHub runs on load), so the lesson waits for
// the things it points at to actually exist rather than for a guessed delay.
function hubReady() {
  return !!($('#home') && !$('#home').classList.contains('hidden')
    && $('#home-carousel .cf-card')
    && $('#power-slots .pslot[data-slot="0"]')
    && $('#pick-hero-btn'));
}

// #tutorial lives inside #game, which is display:none on the hub — so the hand, caption and veil
// would all render into a hidden subtree and the kid would see a lobby with no instructions at all.
// Nothing in the DOM says so (no .hidden class, textContent reads correctly), which is exactly how
// that shipped once. .tutorial is position:fixed/inset:0, so it renders identically on <body>.
function coachToBody() {
  if (tuEl && tuEl.parentElement !== document.body) document.body.appendChild(tuEl);
}

function markLive() {
  document.querySelectorAll('.tu-live').forEach((el) => el.classList.remove('tu-live'));
  document.querySelectorAll('.lab-drop').forEach((el) => el.classList.remove('lab-drop'));
  const s = STEPS[step];
  if (!s) return;
  for (const sel of s.live) {
    const el = $(sel);
    if (!el) { console.warn('[lab] live target missing:', sel); continue; }
    el.classList.add('tu-live');
    // The gate dims and disables per direct child of .hub, so the ANCESTOR box has to be lit too or
    // it swallows the tap on its own child.
    const box = el.closest('.hub > *');
    if (box) box.classList.add('tu-live');
  }
  const dst = s.dst();
  if (dst) dst.classList.add('lab-drop');
}

// Dim the SCENERY the gate cannot reach. `.hub-tu-gate .hub > *` dims every hub box, but the
// stadium a player actually sees is painted behind #home — not a child of .hub — so without this the
// lesson runs on a fully lit lobby. Injected INSIDE .hub at z-index 1: .hub-pitch is z-index auto and
// every interactive box is 2..6, so it lands above the scenery and below everything the kid touches.
function scrim() {
  if ($('.lab-scrim')) return;
  const hub = $('.hub');
  if (!hub) return;
  const el = document.createElement('div');
  el.className = 'lab-scrim';
  hub.appendChild(el);
}

function badge() {
  if ($('.lab-badge')) return;
  const b = document.createElement('div');
  b.className = 'lab-badge';
  b.textContent = 'קלפים לדוגמה · שיעור';
  document.body.appendChild(b);
}

// A way out. The gate makes the whole hub inert, so without this the page is a trap — and the
// pitch levels' exit (#leave-lobby-btn) is a match control that does not exist on this screen.
// Reuses #tu-hub-skip's shipped styling.
function skipBtn() {
  let b = $('#tu-hub-skip');
  if (b) return b;
  b = document.createElement('button');
  b.id = 'tu-hub-skip'; b.type = 'button'; b.textContent = 'דלג ✕';
  b.addEventListener('click', (e) => { e.stopPropagation(); finish(true); });
  document.body.appendChild(b);
  return b;
}

// ---------------------------------------------------------------------------------------------
// The hand
// ---------------------------------------------------------------------------------------------
const centre = (el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }; };

// One directed mime: lift, travel, hold on the target, fade back. Rebuilt only when the geometry
// or the escalation actually changes — re-creating a WAAPI animation every frame restarts it, and a
// hand that restarts 60 times a second does not move.
function aimHand(from, to, nudging) {
  const dx = Math.round(to.x - from.x), dy = Math.round(to.y - from.y);
  const key = `${dx},${dy},${nudging ? 1 : 0}`;
  if (key === handKey) return;
  handKey = key;
  handAnim?.cancel();
  // The LIFT is not decoration: the real carousel handler only counts a grab as a drag when the
  // pointer goes UP by more than 16px and mostly vertically (client.js ~1596) — a flat sideways
  // pull is read as a carousel swipe instead. A kid copying this mime does the gesture that works.
  handAnim = handEl.animate([
    { translate: '0px 0px', opacity: 1, offset: 0 },
    { translate: '0px -22px', opacity: 1, offset: 0.18 },
    { translate: `${dx}px ${dy}px`, opacity: 1, offset: 0.62 },
    { translate: `${dx}px ${dy}px`, opacity: 1, offset: 0.80 },
    { translate: `${dx}px ${dy}px`, opacity: 0, offset: 0.90 },
    { translate: '0px 0px', opacity: 0, offset: 0.96 },
    { translate: '0px 0px', opacity: 1, offset: 1 },
  ], { duration: nudging ? 1600 : 2500, iterations: Infinity, easing: 'ease-in-out' });
}

function render() {
  const s = STEPS[step];
  if (!s) return;
  const srcEl = s.src(), dstEl = s.dst();
  if (!srcEl || !dstEl) { console.warn('[lab] step', s.id, 'lost its target'); return; }
  const from = centre(srcEl), to = centre(dstEl);

  // The hand starts on the card.
  tuEl.style.setProperty('--tu-x', `${Math.round(from.x)}px`);
  tuEl.style.setProperty('--tu-y', `${Math.round(from.y)}px`);

  const nudging = stepT >= NUDGE_AFTER && !s.done();
  tuEl.classList.toggle('nudging', nudging);
  aimHand(from, to, nudging);

  if (capEl.textContent !== s.cap) capEl.textContent = s.cap;   // reassigning restarts the pop
  const second = nudging ? s.nudge : s.sub;
  if (nudgeEl.textContent !== second) nudgeEl.textContent = second;
  nudgeEl.classList.toggle('hidden', !second);

  for (let i = 0; i < pipsEl.children.length; i++) {
    pipsEl.children[i].className = i < step ? 'done' : i === step ? 'on' : '';
  }
}

// ---------------------------------------------------------------------------------------------
// The machine
// ---------------------------------------------------------------------------------------------
function tick(now) {
  if (!running) return;
  requestAnimationFrame(tick);
  const dt = Math.min(0.25, Math.max(0, (now - prevT) / 1000));
  prevT = now;
  stepT += dt;

  const s = STEPS[step];
  if (s && s.done()) {
    step += 1; stepT = 0; handKey = '';
    if (step >= STEPS.length) { finish(false); return; }
    markLive();
    // The same "yes, that" chime the pitch levels use is inside client.js and not reachable from
    // here; the visible advance (pip + new caption + the hand jumping to its new target) carries it.
  }
  render();
}

function finish(skipped) {
  running = false;
  document.body.classList.remove('hub-tu-gate');
  document.querySelectorAll('.tu-live').forEach((el) => el.classList.remove('tu-live'));
  document.querySelectorAll('.lab-drop').forEach((el) => el.classList.remove('lab-drop'));
  $('.lab-scrim')?.remove();          // the lobby goes back to full brightness
  handAnim?.cancel(); handAnim = null;
  tuEl.classList.add('hidden');
  $('#tu-hub-skip')?.classList.add('hidden');
  if (skipped) return;

  // No reward, no score, no payout — a bench, so the only thing on offer is another go.
  if (!doneEl) {
    doneEl = document.createElement('div');
    doneEl.className = 'lab-done';
    doneEl.innerHTML = '<b>יפה מאוד!</b><small>הכוח במשבצת · המראה על הגיבור</small>'
      + '<button id="lab-again" type="button">עוד פעם</button>';
    document.body.appendChild(doneEl);
    doneEl.querySelector('#lab-again').addEventListener('click', () => location.reload());
  }
  doneEl.classList.remove('hidden');
}

function start() {
  document.body.classList.add('lab-tour');
  coachToBody();
  badge();
  skipBtn().classList.remove('hidden');
  tuEl.classList.remove('hidden');
  // The shipped `.veiled` radial spotlight is deliberately NOT used. Measured: a hole big enough to
  // cover both ends of a drag came out at r=255px on an 844x390 screen, which washed the dim off
  // most of the lobby — and it is redundant here anyway, because the gate already dims every hub box
  // except the lit one, per element and with hard edges. The scrim below handles the scenery the gate
  // cannot reach.
  scrim();
  document.body.classList.add('hub-tu-gate');
  if (pipsEl.childElementCount !== STEPS.length) {
    pipsEl.innerHTML = STEPS.map(() => '<i></i>').join('');
  }
  step = 0; stepT = 0; handKey = '';
  markLive();
  render();
  running = true; prevT = performance.now();
  requestAnimationFrame(tick);

  if (!lab.carouselFrozen) {
    console.warn('[lab] the carousel auto-rotate was NOT frozen — the 2600ms interval in '
      + 'startCarouselAuto() has changed. The card under the hand will drift. '
      + 'Fix CAROUSEL_MS in _hub-tour-sandbox.js.');
  }
}

// A test seam: the whole lesson is module-local, so a browser check can otherwise only infer
// progress from side effects — which is how a stuck machine reads as a passing test.
window.__labState = () => ({
  running, step, stepT: Math.round(stepT * 10) / 10,
  stepId: STEPS[step] ? STEPS[step].id : 'done',
  done: STEPS.map((s) => { try { return !!s.done(); } catch { return false; } }),
  carouselFrozen: !!lab.carouselFrozen,
  writes: lab.writes.slice(),
  sends: (lab.sends || []).slice(),
});

(function waitForHub(tries = 0) {
  if (hubReady()) { start(); return; }
  if (tries > 200) { console.error('[lab] hub never rendered — nothing to teach on'); return; }
  setTimeout(() => waitForHub(tries + 1), 50);
})();
