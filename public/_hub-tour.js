// HUB TOUR LAB — the coach. Loaded LAST, after client.js has rendered the hub.
// Design: docs/superpowers/specs/2026-07-28-hub-tour-lab-design.md
//
// TWO TOURS on the same cloned lobby, picked by ?tour= :
//
//   cards     (default)  DO IT lessons, on the real controls with the real drag handlers:
//                        1. lift a card into a POWER SLOT
//                        2. lift the RARE card onto the HERO  → base → gold
//                        3. tap «הכי טוב» and watch all three slots fill at once
//
//   elements  ?tour=elements   A LEGEND, not a lesson: thirteen things on this screen, one at a
//                        time, each lit while everything else stays dark, with its name and what it
//                        does. Nothing here navigates — every lit element is left INERT on purpose,
//                        because tapping ⚙ or 👥 would leave the hub and take the tour with it.
//
// Nothing reaches into client.js. Progress is read off the DOM the hub renders and off the writes
// the sandbox blocks (setSlotCard → 'pikme-loadout', setHeroSkinByRarity → 'pikme_cosmetic'), so no
// socket and no module-private state is needed.
//
// The coach FURNITURE is the shipped one — #tutorial, .tu-hand, .tu-caption, #tu-cap, #tu-nudge,
// #tu-pips, body.hub-tu-gate, .tu-live, #tu-hub-skip — including `.tutorial.nudging .tu-hand`,
// which is the hand growing when the kid goes quiet. Only the hand's directed PATH is new.

const lab = window.__lab || { writes: [], lastWrite: () => null, carouselFrozen: false, sends: [] };

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const tuEl = $('#tutorial');
const handEl = $('#tu-hand');
const capEl = $('#tu-cap');
const nudgeEl = $('#tu-nudge');
const pipsEl = $('#tu-pips');

// Seconds of no progress before the coach escalates: the hand grows (shipped CSS) and the second
// line switches to the fix-it wording. No clock, no fail state — the only thing that reacts to time.
const NUDGE_AFTER = 9;

// How far straight UP the mime pulls the card before it goes anywhere sideways. Well over the 16px
// the real handler demands (client.js ~1596), and raised from 34 on the user's note to make the hand
// go higher — the pull has to read as a deliberate lift, not a wobble, on a card that is 192px tall.
const LIFT = 48;

// ---------------------------------------------------------------------------------------------
// TOUR 1 · cards — do it, on the real controls
// ---------------------------------------------------------------------------------------------
// `src` is where the finger STARTS (the hand's origin), `dst` where it has to end up (the ring).
// Both are resolved fresh every frame: the hub is a scaled stage (fitHub) and the carousel re-lays
// out, so a rect captured once is a rect that will be wrong.
//
// Lessons 1 and 2 both start at the FRONT card, `.cf-card.cf-center` — the biggest and frontmost of
// the stack, the only one a seven-year-old can reliably grab. The rare holds the album's top worth,
// so the carousel's own ranking puts it there. Equipping does not remove a card from the album
// (renderCarousel reads myCards(), not the loadout), so it is still there for lesson 2.
const CARD_STEPS = [
  {
    id: 'slot', gesture: 'drag',
    cap: 'גרור לכאן',
    sub: 'קלף במשבצת = כוח במשחק',
    nudge: 'הרם את הקלף למעלה — ואז למשבצת',
    src: () => $('#home-carousel .cf-card.cf-center') || $('#home-carousel .cf-card'),
    dst: () => $('#power-slots .pslot[data-slot="0"]'),
    // BOTH ENDS must be live. slotUnder() resolves the drop with document.elementFromPoint, and that
    // skips anything with `pointer-events: none` — so a gate that lit only the carousel would let the
    // kid lift a card and then swallow every drop.
    live: ['.hub-cards', '#power-slots'],
    // The real slot really filled. Read off the class renderPowerSlots writes: `.pslot-empty` is
    // present exactly while a slot holds nothing.
    done: () => !!$('#power-slots .pslot:not(.pslot-empty)'),
  },
  {
    id: 'hero', gesture: 'drag',
    cap: 'נדיר על הגיבור',
    sub: 'קלף נדיר = מראה מיוחד',
    nudge: 'גרור את הקלף הנדיר על הדמות',
    src: () => $('#home-carousel .cf-card.rarity-rare') || $('#home-carousel .cf-card.cf-center'),
    dst: () => $('#pick-hero-btn'),
    live: ['.hub-cards', '#pick-hero-btn'],
    // The hero really changed tier. setHeroSkinByRarity maps rarity → skin (common:'base',
    // rare:'gold'), then saveCosmetic attempts the write the sandbox blocks and records. Asserting
    // ':gold' rather than "a cosmetic write happened" is the difference between teaching this lesson
    // and passing it by dropping a COMMON on the hero, which re-writes 'striker:base' and changes
    // nothing on screen.
    done: () => String(lab.lastWrite('pikme_cosmetic') || '').endsWith(':gold'),
  },
  {
    // THE SHORTCUT, taught last on purpose: a kid who has already dragged one card in by hand
    // understands what «הכי טוב» just did for them. Taught first it would fill every slot before
    // they had any idea what a slot was, and lesson 1 would have nothing empty to drop into.
    id: 'best', gesture: 'tap',
    cap: 'הכי טוב',
    sub: 'ממלא לבד את שלושת החזקים',
    nudge: 'הקש על ✨ הכי טוב',
    src: () => $('#select-best-btn'),
    dst: () => $('#select-best-btn'),
    live: ['#select-best-btn'],
    // All three, not "some": the button's whole point is that it fills the lot in one tap.
    done: () => $$('#power-slots .pslot:not(.pslot-empty)').length === 3,
  },
];

// ---------------------------------------------------------------------------------------------
// TOUR 2 · elements — what everything on this screen is
// ---------------------------------------------------------------------------------------------
// The order is the user's, verbatim. Each step lights ONE element, names it, and says what it does.
// `read: true` marks the whole tour as read-only: the lit element is visible but NOT tappable, so a
// tap on ⚙ or 👥 cannot navigate away and abandon the tour halfway down the list. Advancing is a tap
// anywhere on the dark, or «הבא ›».
const ELEMENT_STEPS = [
  { id: 'settings', spot: '#hub-settings',              cap: 'הגדרות',      sub: 'צלילים, שליטה ושפה' },
  { id: 'online',   spot: '.hub-online',                cap: 'מחוברים',     sub: 'כמה שחקנים משחקים עכשיו' },
  { id: 'friends',  spot: '#friends-btn',               cap: 'חברים',       sub: 'הוסף חברים והזמן אותם למשחק' },
  { id: 'clubs',    spot: '[data-open-screen="clubs"]', cap: 'מועדונים',    sub: 'קבוצה של שחקנים שמשחקים יחד' },
  { id: 'store',    spot: '[data-open-screen="shop"]',  cap: 'חנות',        sub: 'קלפים ומראות חדשים' },
  { id: 'news',     spot: '[data-open-screen="news"]',  cap: 'חדשות',       sub: 'מה חדש במשחק' },
  { id: 'rank',     spot: '#rank-btn',                  cap: 'דירוג',       sub: 'המקום שלך מול כל השחקנים' },
  { id: 'quick',    spot: '#quick-match-btn',           cap: 'משחק מהיר',   sub: '2 נגד 2 — מתחיל מיד' },
  { id: 'choose',   spot: '[data-open-screen="arena"]', cap: 'בחר משחק',    sub: 'כל מצבי המשחק' },
  { id: 'withfr',   spot: '#play-friends-btn',          cap: 'שחק עם חברים', sub: 'חדר פרטי — משחקים יחד' },
  { id: 'training', spot: '#training-btn',              cap: 'אימון',       sub: 'שיעורים ותרגול בלי לחץ' },
  { id: 'builder',  spot: '#field-builder-btn',         cap: 'בונה מגרש',   sub: 'בנה מגרש משלך' },
  { id: 'profile',  spot: '#home-face',                 cap: 'הפרופיל שלי', sub: 'השם, התמונה והשיאים שלך' },
].map((s) => ({
  ...s, gesture: 'tap', read: true,
  src: () => $(s.spot), dst: () => $(s.spot),
  nudge: 'הקש להמשך',
  done: () => advanceReq,
}));

const TOURS = { cards: CARD_STEPS, elements: ELEMENT_STEPS };
const tourName = (() => {
  try { return new URLSearchParams(location.search).get('tour') === 'elements' ? 'elements' : 'cards'; }
  catch { return 'cards'; }
})();

let STEPS = [];
let tour = tourName;
let step = 0;
let stepT = 0;
let prevT = 0;
let running = false;
let advanceReq = false;   // the read-only tour's "next" signal
let handAnim = null;
let handKey = '';         // the geometry the current hand animation was built for
let doneEl = null;
let catchEl = null;
// Which run of the machine a tick belongs to. finish() is called FROM INSIDE tick, and that tick has
// already queued its successor by then — so starting the next tour immediately (the «סיור במסך ›»
// hand-off does exactly that) leaves the old frame alive and two loops running the same globals.
// Two loops double stepT, and if both see the same `done()` in one frame they take a step each and
// skip one. A token, checked at the top of every tick, retires the old loop on the spot.
let runToken = 0;

// ---------------------------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------------------------
// The hub renders asynchronously (card art preloads, fitHub runs on load), so the lesson waits for
// the things it points at to exist rather than for a guessed delay.
function hubReady() {
  return !!($('#home') && !$('#home').classList.contains('hidden')
    && $('#home-carousel .cf-card')
    && $('#power-slots .pslot[data-slot="0"]')
    && $('#pick-hero-btn'));
}

// #tutorial lives inside #game, which is display:none on the hub — so the hand, caption and pips
// would render into a hidden subtree and the kid would see a lobby with no instructions at all.
// Nothing in the DOM says so (no .hidden class, textContent reads correctly), which is exactly how
// that shipped once. .tutorial is position:fixed/inset:0, so it renders identically on <body>.
function coachToBody() {
  if (tuEl && tuEl.parentElement !== document.body) document.body.appendChild(tuEl);
}

// Dim the SCENERY the gate cannot reach. `.hub-tu-gate .hub > *` dims every hub box, but the stadium
// a player actually sees is painted behind #home — not a child of .hub — so without this the tour
// runs on a fully lit lobby. Injected INSIDE .hub at z-index 1: .hub-pitch is z-index auto and every
// interactive box is 2..6, so it lands above the scenery and below everything the kid looks at.
function scrim() {
  if ($('.lab-scrim')) return;
  const hub = $('.hub');
  if (!hub) return;
  const el = document.createElement('div');
  el.className = 'lab-scrim';
  hub.appendChild(el);
}

function clearMarks() {
  $$('.tu-live, .lab-drop, .lab-show, .lab-dim, .lab-pick')
    .forEach((el) => el.classList.remove('tu-live', 'lab-drop', 'lab-show', 'lab-dim', 'lab-pick'));
}

// Light exactly ONE element while everything else stays dark, WITHOUT making it tappable.
//
// A CSS filter on a parent cannot be undone by a child, and the gate dims per `.hub > *` box — so
// lighting `#training-btn`, which lives inside `#play-strip`, means un-dimming the strip and then
// dimming its other children individually. That is the only way to get "just this one" out of a
// filter-based gate.
function showOnly(el) {
  const box = el.closest('.hub > *') || el;
  box.classList.add('lab-show');
  if (box !== el) {
    for (const kid of box.children) if (kid !== el && !kid.contains(el)) kid.classList.add('lab-dim');
  }
  el.classList.add('lab-pick');
}

function markLive() {
  clearMarks();
  const s = STEPS[step];
  if (!s) return;
  if (s.read) {
    // READ-ONLY: visible, never tappable. `.tu-live` would hand the element its pointer events back
    // and one tap would leave the hub.
    const el = s.src();
    if (el) showOnly(el); else console.warn('[lab] element step lost its target:', s.spot);
    return;
  }
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

function badge() {
  if ($('.lab-badge')) return;
  const b = document.createElement('div');
  b.className = 'lab-badge';
  b.textContent = tour === 'elements' ? 'סיור במסך · שיעור' : 'קלפים לדוגמה · שיעור';
  document.body.appendChild(b);
}

// A way out. The gate makes the whole hub inert, so without this the page is a trap — and the pitch
// levels' exit (#leave-lobby-btn) is a match control that does not exist on this screen. Reuses
// #tu-hub-skip's shipped styling.
function skipBtn() {
  let b = $('#tu-hub-skip');
  if (b) return b;
  b = document.createElement('button');
  b.id = 'tu-hub-skip'; b.type = 'button'; b.textContent = 'דלג ✕';
  b.addEventListener('click', (e) => { e.stopPropagation(); finish(true); });
  document.body.appendChild(b);
  return b;
}

// The read-only tour's advance: a transparent catcher over the whole screen plus a «הבא ›» button.
// The catcher sits at z-index 39 — under #tutorial (40) and #tu-hub-skip (41), over the hub — so the
// caption and the exit still work and every other tap just means "next".
function nextCatcher(on) {
  if (!on) { catchEl?.remove(); catchEl = null; $('#lab-next')?.remove(); return; }
  if (catchEl) return;
  catchEl = document.createElement('div');
  catchEl.className = 'lab-catch';
  catchEl.addEventListener('pointerdown', () => { advanceReq = true; });
  document.body.appendChild(catchEl);
  const b = document.createElement('button');
  b.id = 'lab-next'; b.type = 'button'; b.textContent = 'הבא ›';
  b.addEventListener('click', (e) => { e.stopPropagation(); advanceReq = true; });
  document.body.appendChild(b);
}

// ---------------------------------------------------------------------------------------------
// The hand
// ---------------------------------------------------------------------------------------------
const centre = (el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }; };

// The hand's own size (54px, .tu-hand in style.css) plus a little air. It has to clear the target,
// not overlap it.
const HAND = 54;
// Just OUTSIDE the target: below when there is room, otherwise above. Kept on the x centre so the
// finger still reads as pointing at that specific box and not at its neighbour.
function tapAnchor(t) {
  const gap = HAND / 2 + 8;
  const below = t.y + t.h / 2 + gap;
  const above = t.y - t.h / 2 - gap;
  const y = (below + HAND / 2 < window.innerHeight - 4) ? below : above;
  return { x: t.x, y: Math.max(HAND / 2 + 2, y) };
}

// TWO BEATS, in this order: PULL THE CARD STRAIGHT UP, hold it there, THEN swipe across to the
// target. Not one diagonal sweep — that is the same gesture the carousel reads as a SWIPE, and a kid
// copying it would spin the deck instead of picking a card up.
//
// The order is the mechanic, not a style choice: the real handler only latches a grab when the
// pointer has travelled UP by more than 16px and mostly vertically (client.js ~1596). Everything
// else is a carousel swipe. So the mime pulls up, pauses long enough for the lift to register as a
// separate action, then carries the card sideways at that height and sets it down on the target.
//
// Rebuilt only when the geometry or the escalation changes — re-creating a WAAPI animation every
// frame restarts it, and a hand that restarts 60 times a second never moves.
function aimHand(from, to, nudging) {
  const dx = Math.round(to.x - from.x), dy = Math.round(to.y - from.y);
  const key = `drag:${dx},${dy},${nudging ? 1 : 0}`;
  if (key === handKey) return;
  handKey = key;
  handAnim?.cancel();
  handEl.className = 'tu-hand';          // no CSS mime: this one is driven by the keyframes below
  handAnim = handEl.animate([
    { translate: '0px 0px', opacity: 1, offset: 0 },                          // on the card
    { translate: `0px ${-LIFT}px`, opacity: 1, offset: 0.16 },                 // 1. PULL UP
    { translate: `0px ${-LIFT}px`, opacity: 1, offset: 0.32 },                 //    …and hold, so it reads
    // 2. SWIPE — carried ACROSS at the lifted height first, so the sideways move is unmistakably a
    //    second, separate motion…
    { translate: `${Math.round(dx * 0.62)}px ${-LIFT}px`, opacity: 1, offset: 0.56 },
    { translate: `${dx}px ${dy}px`, opacity: 1, offset: 0.74 },                //    …then set down on it
    { translate: `${dx}px ${dy}px`, opacity: 1, offset: 0.86 },                //    the release, held
    { translate: `${dx}px ${dy}px`, opacity: 0, offset: 0.93 },
    { translate: '0px 0px', opacity: 0, offset: 0.98 },
    { translate: '0px 0px', opacity: 1, offset: 1 },
  ], { duration: nudging ? 1900 : 2900, iterations: Infinity, easing: 'ease-in-out' });
}

// A press with no travel — the shipped `.gest-tap` mime, which is a short jab twice then a pause.
// Reused rather than re-authored: it is the same "press this" the pitch levels teach with.
function tapHand() {
  if (handKey === 'tap') return;
  handKey = 'tap';
  handAnim?.cancel(); handAnim = null;
  handEl.className = 'tu-hand gest-tap';
}

function render() {
  const s = STEPS[step];
  if (!s) return;
  const srcEl = s.src(), dstEl = s.dst();
  if (!srcEl || !dstEl) { console.warn('[lab] step', s.id, 'lost its target'); return; }
  const from = centre(srcEl), to = centre(dstEl);

  // WHERE THE HAND SITS.
  // A drag starts on the card, so the hand starts there — it is holding it.
  // A TAP is different: the hand is 54px and most of these targets are smaller than that, so a hand
  // centred on ⚙ simply HIDES the one thing the step is describing (caught by screenshot on the
  // element tour's first step). It sits just outside the target instead — below it normally, above it
  // when there is no room below, which is where the shipped hand art points anyway.
  const anchor = s.gesture === 'tap' ? tapAnchor(from) : from;
  tuEl.style.setProperty('--tu-x', `${Math.round(anchor.x)}px`);
  tuEl.style.setProperty('--tu-y', `${Math.round(anchor.y)}px`);

  const nudging = stepT >= NUDGE_AFTER && !s.done();
  tuEl.classList.toggle('nudging', nudging);
  if (s.gesture === 'drag') aimHand(from, to, nudging); else tapHand();

  if (capEl.textContent !== s.cap) capEl.textContent = s.cap;   // reassigning restarts the pop
  // On the element tour the second line is the EXPLANATION and is never replaced by a nudge — "what
  // this button does" is the entire content of the step, and swapping it for «הקש להמשך» after nine
  // seconds would delete the lesson from the screen of anyone who reads slowly.
  const second = (nudging && !s.read) ? s.nudge : s.sub;
  if (nudgeEl.textContent !== second) nudgeEl.textContent = second;
  nudgeEl.classList.toggle('hidden', !second);

  for (let i = 0; i < pipsEl.children.length; i++) {
    pipsEl.children[i].className = i < step ? 'done' : i === step ? 'on' : '';
  }
}

// ---------------------------------------------------------------------------------------------
// The machine
// ---------------------------------------------------------------------------------------------
function tick(now, token) {
  if (!running || token !== runToken) return;   // a frame left over from the previous tour
  requestAnimationFrame((t) => tick(t, token));
  const dt = Math.min(0.25, Math.max(0, (now - prevT) / 1000));
  prevT = now;
  stepT += dt;

  const s = STEPS[step];
  if (s && s.done()) {
    step += 1; stepT = 0; handKey = ''; advanceReq = false;
    if (step >= STEPS.length) { finish(false); return; }
    markLive();
  }
  render();
}

function finish(skipped) {
  running = false;
  document.body.classList.remove('hub-tu-gate');
  clearMarks();
  nextCatcher(false);
  $('.lab-scrim')?.remove();          // the lobby goes back to full brightness
  handAnim?.cancel(); handAnim = null;
  tuEl.classList.add('hidden');
  $('#tu-hub-skip')?.classList.add('hidden');
  if (skipped) return;

  // No reward, no score, no payout — a bench. The card tour hands off to the screen tour, which is
  // the order they teach in: what the cards do first, then what the rest of the lobby is.
  const next = tour === 'cards'
    ? '<button id="lab-elements" type="button">סיור במסך ›</button>'
    : '';
  if (!doneEl) {
    doneEl = document.createElement('div');
    doneEl.className = 'lab-done';
    document.body.appendChild(doneEl);
  }
  doneEl.innerHTML = (tour === 'cards'
    ? '<b>יפה מאוד!</b><small>הכוח במשבצת · המראה על הגיבור · הכי טוב במגע אחד</small>'
    : '<b>עכשיו אתה מכיר את המסך</b><small>שלוש עשרה פינות — כולן שלך</small>')
    + next + '<button id="lab-again" type="button">עוד פעם</button>';
  doneEl.querySelector('#lab-again').addEventListener('click', () => start(tour, true));
  doneEl.querySelector('#lab-elements')?.addEventListener('click', () => start('elements', true));
  doneEl.classList.remove('hidden');
}

function start(which, restart) {
  tour = TOURS[which] ? which : 'cards';
  // A step whose element is gone is dropped rather than allowed to stall the tour: this hub is
  // edited daily by other agents, and the console line names exactly what went missing.
  STEPS = TOURS[tour].filter((s) => {
    const ok = !!s.src();
    if (!ok) console.warn(`[lab] dropping step '${s.id}' — no element for ${s.spot || '(dynamic)'}`);
    return ok;
  });
  if (!STEPS.length) { console.error('[lab] no steps have targets on this screen'); return; }

  doneEl?.classList.add('hidden');
  document.body.classList.add('lab-tour');
  document.body.classList.toggle('lab-read', tour === 'elements');
  coachToBody();
  if (restart) $('.lab-badge')?.remove();
  badge();
  skipBtn().classList.remove('hidden');
  tuEl.classList.remove('hidden');
  // The shipped `.veiled` radial spotlight is deliberately NOT used. Measured: a hole big enough to
  // cover both ends of a drag came out at r=255px on an 844x390 screen, which washed the dim off most
  // of the lobby — and it is redundant, because the gate dims every hub box except the lit one, per
  // element and with hard edges. The scrim handles the scenery the gate cannot reach.
  scrim();
  document.body.classList.add('hub-tu-gate');
  if (pipsEl.childElementCount !== STEPS.length) {
    pipsEl.innerHTML = STEPS.map(() => '<i></i>').join('');
  }
  step = 0; stepT = 0; handKey = ''; advanceReq = false;
  nextCatcher(tour === 'elements');
  markLive();
  render();
  running = true; prevT = performance.now();
  const token = ++runToken;
  requestAnimationFrame((t) => tick(t, token));

  if (!lab.carouselFrozen) {
    console.warn('[lab] the carousel auto-rotate was NOT frozen — the 2600ms interval in '
      + 'startCarouselAuto() has changed. The card under the hand will drift. '
      + 'Fix CAROUSEL_MS in _hub-tour-sandbox.js.');
  }
}

// A test seam: the whole tour is module-local, so a browser check can otherwise only infer progress
// from side effects — which is how a stuck machine reads as a passing test.
window.__labState = () => ({
  running, tour, step, stepT: Math.round(stepT * 10) / 10,
  stepId: STEPS[step] ? STEPS[step].id : 'done',
  stepIds: STEPS.map((s) => s.id),
  cap: capEl.textContent, sub: nudgeEl.textContent,
  done: STEPS.map((s) => { try { return !!s.done(); } catch { return false; } }),
  carouselFrozen: !!lab.carouselFrozen,
  writes: lab.writes.slice(),
  sends: (lab.sends || []).slice(),
});
// So the verifier can run the second tour without a reload.
window.__labStart = (which) => start(which, true);

(function waitForHub(tries = 0) {
  if (hubReady()) { start(tourName, false); return; }
  if (tries > 200) { console.error('[lab] hub never rendered — nothing to teach on'); return; }
  setTimeout(() => waitForHub(tries + 1), 50);
})();
