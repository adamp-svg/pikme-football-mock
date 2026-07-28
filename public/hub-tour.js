// THE LOBBY TOUR — a kid's first ninety seconds on the hub. SHIPPED, not a lab page.
// Design: docs/superpowers/specs/2026-07-28-hub-tour-lab-design.md
//
// It runs on the REAL hub: real markup, real CSS, real drag handlers, the player's own album. There
// is no mock lobby and nothing is redrawn — a lesson that does not look like the thing it teaches was
// the reason the previous attempt was thrown away.
//
// AUTO-LAUNCH: the first time a player reaches the hub, before the pitch tutorial. client.js's
// tuMaybeAutoStart() asks HubTour.pending() first and hands over; when this finishes or is skipped it
// calls back, and level 1 יסודות starts then. Skippable — a kid who just wants to play is not trapped.
//
// NOTHING IT DOES IS SAVED. client.js's `tuHub` sandbox flag is raised for the duration (via
// window.__hubPrefs), so setSlotCard/swapSlots/saveLoadout/saveCosmetic all stop short of
// localStorage and of postPrefs() — which the app persists under the player's PHONE NUMBER. The
// loadout and the hero are snapshotted on the way in and put back on the way out.
//
// ONE RUN on the cloned lobby, in the order the user asked for — the screen explained first, then
// the cards. Nineteen steps, mixing two kinds:
//
//   READ  lit, named, explained, INERT, advanced by a tap anywhere. The thirteen home elements and
//         the three power slots. Inert on purpose: a tap on ⚙ or 👥 would open that screen and take
//         the tour with it.
//   DO    the real control, with the real drag handlers, gated on the real outcome.
//
//   1-13  the home legend            READ
//   14    the RARE card → the HERO   DO    (base → gold)
//   15-17 what each power slot does  READ
//   18    a card → a slot            DO
//   19    «הכי טוב» → all three      DO
//
// `?tour=home` and `?tour=cards` run either half alone, for working on one of them.
//
// Nothing reaches into client.js. Progress is read off the DOM the hub renders and off the writes
// the sandbox blocks (setSlotCard → 'pikme-loadout', setHeroSkinByRarity → 'pikme_cosmetic'), so no
// socket and no module-private state is needed.
//
// The coach FURNITURE is the shipped one — #tutorial, .tu-hand, .tu-caption, #tu-cap, #tu-nudge,
// #tu-pips, body.hub-tu-gate, .tu-live, #tu-hub-skip — including `.tutorial.nudging .tu-hand`,
// which is the hand growing when the kid goes quiet. Only the hand's directed PATH is new.

// client.js's seam: myLoadout / myCosmetic are module-private there, so the snapshot, the restore and
// the "what is the hero wearing right now" read all have to come from inside it.
const prefs = () => window.__hubPrefs || null;
// The lab page (_hub-tour.html) sets this: dummy album, blocked writes, frozen carousel. Absent in
// the shipped game.
const LAB = window.__lab || null;

// ---- first run ------------------------------------------------------------------------------
// Two keys, deliberately separate: FINISHED is not the same as "we offered and they said no". A kid
// who skips is not asked again on the next launch, but the tour still reads as unfinished if anything
// ever wants to offer it properly.
const DONE_KEY = 'fbHubTourDone';
const SKIP_KEY = 'fbHubTourSkipped';
const seen = (k) => { try { return localStorage.getItem(k) === '1'; } catch { return false; } };
const mark = (k) => { try { localStorage.setItem(k, '1'); } catch { /* private mode */ } };

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
// THE ORDER (user, 2026-07-28 13:04): "make the home tour first, then the cards pull, first pull a
// hero custom, then explain each slot, then pull a card to slot, then show the select best".
//
//   1-13  the HOME legend — what every corner of this screen is
//   14    pull the RARE card onto the HERO          (do it)
//   15-17 what each of the three POWER SLOTS does   (read)
//   18    pull a card into a slot                   (do it)
//   19    «הכי טוב» fills all three                 (do it)
//
// Read-then-do, twice over: the legend names the furniture before anything is asked of them, and the
// three slots are explained while they are still EMPTY — which is the only time each one shows its own
// ⚡/🏃/🛡️ glyph instead of a card. Explaining them after the drag would mean explaining a slot with a
// picture of a card sitting in it.
// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// The card lessons — do it, on the real controls
// ---------------------------------------------------------------------------------------------
// `src` is where the finger STARTS (the hand's origin), `dst` where it has to end up (the ring).
// Both are resolved fresh every frame: the hub is a scaled stage (fitHub) and the carousel re-lays
// out, so a rect captured once is a rect that will be wrong.
//
// Both drags start at the FRONT card, `.cf-card.cf-center` — the biggest and frontmost of the stack,
// the only one a seven-year-old can reliably grab. The rare holds the album's top worth, so the
// carousel's own ranking puts it there, and equipping never removes a card from the album
// (renderCarousel reads myCards(), not the loadout) — so the same card is still there for the second
// drag.
//
// FIRST of the card lessons, on the user's order: the hero. It is also the right one to open with —
// it changes the biggest thing on the screen, and it costs the kid nothing to undo.
const HERO_STEP = {
  id: 'hero', gesture: 'drag',
  cap: 'נדיר על הגיבור',
  sub: 'קלף נדיר = מראה מיוחד',
  nudge: 'גרור את הקלף הנדיר על הדמות',
  // THE CORRECTION, shown the moment they drop the wrong card rather than after nine idle seconds:
  // a common/epic/legendary on the hero re-skins to base/holo/sig, so the step's `done` stays false and
  // without this the kid is left dragging cards at a lesson that looks broken. Rare borders are blue
  // (.cf-card.rarity-rare, #4ea0ff), which is the one cue a child who cannot read can use.
  fix: 'זה לא הנדיר — קח את הקלף הכחול',
  // BRING THE RARE TO THE FRONT before asking for it. The front card is the only one a player really
  // grabs: it is 141px against the side cards' 90 and it sits on top of them. Measured on the real
  // page, the front card was whatever the auto-rotate had spun in — so the hand pointed at a rare
  // hiding behind a legendary, and the obvious drag taught nothing.
  // Done through the carousel's OWN behaviour: every .cf-card has a click handler that calls
  // setCarousel(i) and centres it (client.js renderCarousel). No new mechanism, no internals.
  onEnter: () => { const r = $('#home-carousel .cf-card.rarity-rare'); if (r && !r.classList.contains('cf-center')) r.click(); },
  src: () => $('#home-carousel .cf-card.rarity-rare') || $('#home-carousel .cf-card.cf-center'),
  dst: () => $('#pick-hero-btn'),
  // BOTH ENDS must be live. The drop is resolved with document.elementFromPoint, which skips
  // anything at `pointer-events: none` — so lighting only the carousel would let the kid lift a card
  // and then swallow every drop.
  live: ['.hub-cards', '#pick-hero-btn'],
  // The hero really changed tier, read off client.js's live myCosmetic. setHeroSkinByRarity maps
  // rarity → skin (common:'base', rare:'gold'), so asserting ':gold' rather than "the cosmetic
  // changed at all" is the difference between teaching this lesson and passing it by dropping a
  // COMMON on the hero — which re-writes 'striker:base' and changes nothing on screen.
  // NOT read off a localStorage write: during the tour nothing is written at all.
  done: () => String(prefs()?.cosmetic() || '').endsWith(':gold'),
};

// WHAT EACH SLOT DOES — read, not done. Explained while all three are still EMPTY, which is when each
// one is showing its own glyph rather than a card.
// The wording is the GAME'S OWN, shortened for a seven-year-old: SLOT_META in client.js says slot 0
// is ⚡בעיטה (charge faster), 1 is 🏃מהירות (run faster without the ball), 2 is 🛡️הגנה (shorter
// cooldowns — the bomb and the wall come back sooner). Invented copy here would be a second, drifting
// description of a real buff the server calculates.
const SLOT_STEPS = [
  { id: 'slot0', cap: '⚡ בעיטה',  sub: 'הבעיטה נטענת מהר יותר',      spot: '#power-slots .pslot[data-slot="0"]' },
  { id: 'slot1', cap: '🏃 מהירות', sub: 'רצים מהר יותר בלי הכדור',     spot: '#power-slots .pslot[data-slot="1"]' },
  { id: 'slot2', cap: '🛡️ הגנה',  sub: 'הפצצה והקיר חוזרים מהר',      spot: '#power-slots .pslot[data-slot="2"]' },
];

const SLOT_DRAG = {
  id: 'slot', gesture: 'drag',
  cap: 'גרור לכאן',
  sub: 'קלף במשבצת = כוח במשחק',
  nudge: 'הרם את הקלף למעלה — ואז למשבצת',
  src: () => $('#home-carousel .cf-card.cf-center') || $('#home-carousel .cf-card'),
  dst: () => $('#power-slots .pslot[data-slot="0"]'),
  live: ['.hub-cards', '#power-slots'],
  // The real slot really filled. Read off the class renderPowerSlots writes: `.pslot-empty` is
  // present exactly while a slot holds nothing.
  done: () => !!$('#power-slots .pslot:not(.pslot-empty)'),
};

// THE SHORTCUT, last: a kid who has just dragged one card in by hand understands what «הכי טוב» did
// for them. Taught earlier it would fill every slot before they knew what a slot was, and the drag
// lesson would have had nothing empty to drop into.
const BEST_STEP = {
  id: 'best', gesture: 'tap',
  cap: 'הכי טוב',
  sub: 'ממלא לבד את שלושת החזקים',
  nudge: 'הקש על ✨ הכי טוב',
  // HOLD 2s AFTER THE TAP (user: "should equip best and wait 2 seconds before exiting"). This is the
  // last step, so completing it ends the tour — and the tour's exit RESTORES the player's own loadout,
  // which means without a dwell the three cards appear and vanish in the same breath and the kid never
  // sees what the button did. Same reasoning as `minDwell` on the pitch levels: some lessons are only
  // learned in the seconds after the action.
  dwell: 2,
  done2: 'שלושת החזקים מצוידים!',
  src: () => $('#select-best-btn'),
  dst: () => $('#select-best-btn'),
  live: ['#select-best-btn'],
  // All three, not "some": the button's whole point is that it fills the lot in one tap.
  done: () => $$('#power-slots .pslot:not(.pslot-empty)').length === 3,
};

// ---------------------------------------------------------------------------------------------
// THE HOME LEGEND — what everything on this screen is. Runs FIRST.
// ---------------------------------------------------------------------------------------------
// The order is the user's, verbatim. Each step lights ONE element, names it, and says what it does.
// `read: true` = the lit element is visible but NOT tappable, so a tap on ⚙ or 👥 cannot navigate away
// and abandon the tour halfway down the list. Advancing is a tap anywhere on the dark, or «הבא ›».
const HOME_STEPS = [
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
];

// A READ step: lit, explained, inert, advanced by a tap anywhere. Shared by the home legend and the
// three slot explanations, so "something the kid only has to look at" is one behaviour, defined once.
const asRead = (s) => ({
  ...s, gesture: 'tap', read: true,
  src: () => $(s.spot), dst: () => $(s.spot),
  nudge: 'הקש להמשך',
  done: () => advanceReq,
});

const HOME = HOME_STEPS.map(asRead);
const CARDS = [HERO_STEP, ...SLOT_STEPS.map(asRead), SLOT_DRAG, BEST_STEP];

// `full` is what a kid gets: the screen explained, then the cards. `home` and `cards` exist so either
// half can be re-run on its own while working on it.
const TOURS = { full: [...HOME, ...CARDS], home: HOME, cards: CARDS };
const tourName = (() => {
  try {
    const t = new URLSearchParams(location.search).get('tour');
    return TOURS[t] ? t : 'full';
  } catch { return 'full'; }
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
// What client.js should do once the tour is out of the way — its own tuMaybeAutoStart(), so the pitch
// tutorial follows the lobby tour instead of racing it.
let resumeAfter = null;
// When the current step first completed, in ms — drives `dwell` (hold a finished step open so the kid
// sees what they just did). 0 = not yet.
let doneAt = 0;
// They dropped a card on the hero and it was NOT the rare: the step cannot complete, so say so at
// once rather than eight seconds later. Cleared on every step change.
let wrongDrop = false;

// ---------------------------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------------------------
// The hub renders asynchronously (card art preloads, fitHub runs on load), so the lesson waits for
// the things it points at to exist rather than for a guessed delay.
// The furniture EVERY step needs, and deliberately not a card: a player with an empty album has no
// `.cf-card` at all, and requiring one meant the tour silently never started for exactly the newcomer
// it exists for. (Found on the real page, not in the lab, because the lab always injects seven cards.)
function hubReady() {
  return !!($('#home') && !$('#home').classList.contains('hidden')
    && $('#hub-settings')
    && $('#power-slots .pslot[data-slot="0"]')
    && $('#pick-hero-btn'));
}
// …but the card half must not be dropped just because the carousel is a few frames behind. Once the
// furniture is up, the album gets a bounded grace period to render a card before "no cards" is taken
// as the truth: without it, a slow render would quietly downgrade a player who HAS cards to the
// legend-only tour, which is the same class of silent-wrong-path bug as the line above.
const CARD_GRACE_TICKS = 40;   // × 50ms = 2s

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
  if ($('.ht-scrim')) return;
  const hub = $('.hub');
  if (!hub) return;
  const el = document.createElement('div');
  el.className = 'ht-scrim';
  hub.appendChild(el);
}

function clearMarks() {
  $$('.tu-live, .ht-drop, .ht-show, .ht-dim, .ht-pick')
    .forEach((el) => el.classList.remove('tu-live', 'ht-drop', 'ht-show', 'ht-dim', 'ht-pick'));
}

// Light exactly ONE element while everything else stays dark, WITHOUT making it tappable.
//
// A CSS filter on a parent cannot be undone by a child, and the gate dims per `.hub > *` box — so
// lighting `#training-btn`, which lives inside `#play-strip`, means un-dimming the strip and then
// dimming its other children individually. That is the only way to get "just this one" out of a
// filter-based gate.
function showOnly(el) {
  const box = el.closest('.hub > *') || el;
  box.classList.add('ht-show');
  if (box !== el) {
    for (const kid of box.children) if (kid !== el && !kid.contains(el)) kid.classList.add('ht-dim');
  }
  el.classList.add('ht-pick');
}

function markLive() {
  clearMarks();
  const s = STEPS[step];
  if (!s) return;
  if (s.read) {
    // READ-ONLY: visible, never tappable. `.tu-live` would hand the element its pointer events back
    // and one tap would leave the hub.
    const el = s.src();
    if (el) showOnly(el); else console.warn('[hub-tour] element step lost its target:', s.spot);
    return;
  }
  for (const sel of s.live) {
    const el = $(sel);
    if (!el) { console.warn('[hub-tour] live target missing:', sel); continue; }
    el.classList.add('tu-live');
    // The gate dims and disables per direct child of .hub, so the ANCESTOR box has to be lit too or
    // it swallows the tap on its own child.
    const box = el.closest('.hub > *');
    if (box) box.classList.add('tu-live');
  }
  const dst = s.dst();
  if (dst) dst.classList.add('ht-drop');
}

// Everything that changes when the step changes. The tap-catcher is PER STEP, not per tour: the flow
// now mixes read steps and do steps in one run (the legend, then the hero drag, then the three slots,
// then two more drags), and a catcher left up over a drag step would eat the gesture.
function applyStep() {
  const read = !!STEPS[step]?.read;
  doneAt = 0; wrongDrop = false;
  // A step may need the screen arranged before it can be taught — the hero step centres the rare card,
  // because the front card is the only one anybody actually grabs.
  try { STEPS[step]?.onEnter?.(); } catch (e) { console.warn('[hub-tour] onEnter failed', e); }
  markLive();
  nextCatcher(read);
  // Read steps make the whole hub inert. Not just the lit element: `#power-slots .pslot-item` sets
  // its own `pointer-events: auto` (style.css:2298), so inheritance from the gated box is not enough
  // and a slot stayed tappable through a step that only asked to be read.
  document.body.classList.toggle('ht-inert', read);
}

// The lab says whose cards these are. The shipped tour has no badge: the album IS the player's, so
// there is nothing to disclaim, and a chip in the corner of a lesson is one more thing on screen.
function badge() {
  if (!LAB || $('.ht-badge')) return;
  const b = document.createElement('div');
  b.className = 'ht-badge';
  b.textContent = tour === 'home' ? 'סיור במסך · שיעור' : 'שיעור לובי · קלפים לדוגמה';
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
  if (!on) { catchEl?.remove(); catchEl = null; $('#ht-next')?.remove(); return; }
  if (catchEl) return;
  catchEl = document.createElement('div');
  catchEl.className = 'ht-catch';
  catchEl.addEventListener('pointerdown', () => { advanceReq = true; });
  document.body.appendChild(catchEl);
  const b = document.createElement('button');
  b.id = 'ht-next'; b.type = 'button'; b.textContent = 'הבא ›';
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
  if (!srcEl || !dstEl) { console.warn('[hub-tour] step', s.id, 'lost its target'); return; }
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

  // The correction jumps the queue: an idle hint can afford to wait, but an answer to something the kid
  // just DID has to arrive while they still connect the two. Same rule as the pitch levels' `fix`.
  const done = s.done();
  const correcting = !!(s.fix && wrongDrop && !done);
  const nudging = correcting || (stepT >= NUDGE_AFTER && !done);
  tuEl.classList.toggle('nudging', nudging);
  if (s.gesture === 'drag') aimHand(from, to, nudging); else tapHand();

  // A finished step that is being HELD (dwell) says what just happened instead of what to do.
  const cap = (done && s.done2 && doneAt) ? s.done2 : s.cap;
  if (capEl.textContent !== cap) capEl.textContent = cap;       // reassigning restarts the pop
  // On the element tour the second line is the EXPLANATION and is never replaced by a nudge — "what
  // this button does" is the entire content of the step, and swapping it for «הקש להמשך» after nine
  // seconds would delete the lesson from the screen of anyone who reads slowly.
  const second = correcting ? s.fix : ((nudging && !s.read) ? s.nudge : s.sub);
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
    if (!doneAt) doneAt = now;
    // `dwell` holds a COMPLETED step open. «הכי טוב» uses it so the three cards are actually SEEN
    // landing before the tour ends and hands the player their own loadout back.
    if (s.dwell && (now - doneAt) / 1000 < s.dwell) { render(); return; }
    step += 1; stepT = 0; handKey = ''; advanceReq = false;
    if (step >= STEPS.length) { finish(false); return; }
    applyStep();
  }
  render();
}

function finish(skipped) {
  running = false;
  // Put the loadout and the hero back exactly as they were, and lower the sandbox flag. Done FIRST,
  // before any of the visual teardown, so a throw further down cannot leave the player sandboxed with
  // a lesson's loadout in memory.
  prefs()?.end();
  prefs()?.thawCarousel();          // the lobby's own idle animation resumes
  // Skipping is not finishing. Both stop the auto-launch coming back tomorrow, but only one of them
  // means the kid was actually shown the screen.
  mark(skipped ? SKIP_KEY : DONE_KEY);
  document.body.classList.remove('hub-tu-gate', 'ht-inert');
  clearMarks();
  nextCatcher(false);
  $('.ht-scrim')?.remove();          // the lobby goes back to full brightness
  handAnim?.cancel(); handAnim = null;
  tuEl.classList.add('hidden');
  $('#tu-hub-skip')?.classList.add('hidden');
  // Hand the floor back: client.js resumes its own auto-start, which is where the pitch tutorial
  // begins. A skip gets the same call — a kid who waved the lobby away still gets taught to play.
  const resume = resumeAfter; resumeAfter = null;
  if (resume) setTimeout(resume, skipped ? 0 : 900);   // a beat to read «יפה מאוד!» first
  if (skipped) return;

  // No reward, no score, no payout — a bench. The card tour hands off to the screen tour, which is
  // the order they teach in: what the cards do first, then what the rest of the lobby is.
  // The full run has nothing left to chain into. `home` on its own offers the cards half next.
  const next = tour === 'home'
    ? '<button id="ht-cards" type="button">עכשיו הקלפים ›</button>'
    : '';
  if (!doneEl) {
    doneEl = document.createElement('div');
    doneEl.className = 'ht-done';
    document.body.appendChild(doneEl);
  }
  doneEl.innerHTML = (tour === 'home'
    ? '<b>עכשיו אתה מכיר את המסך</b><small>שלוש עשרה פינות — כולן שלך</small>'
    : '<b>יפה מאוד!</b><small>המראה על הגיבור · כוח בכל משבצת · הכי טוב במגע אחד</small>')
    + next + '<button id="ht-again" type="button">עוד פעם</button>';
  doneEl.querySelector('#ht-again').addEventListener('click', () => start(tour, true));
  doneEl.querySelector('#ht-cards')?.addEventListener('click', () => start('cards', true));
  doneEl.classList.remove('hidden');
}

function start(which, restart) {
  tour = TOURS[which] ? which : 'full';
  // NOTHING IS SAVED. This raises client.js's `tuHub` sandbox flag and snapshots the loadout + hero, so
  // setSlotCard / swapSlots / saveLoadout / saveCosmetic all stop short of localStorage and of
  // postPrefs() — which the app persists under the player's PHONE NUMBER. finish() puts both back.
  // MUST come before the first step is applied: the guard only helps for writes made after it.
  prefs()?.begin();
  // AN EMPTY ALBUM CANNOT BE TAUGHT THE CARDS. With no cards there is nothing to drag, and the hero
  // wardrobe is card-gated too (every 7 distinct cards unlocks one), so the whole card half would be
  // a hand pointing at things that cannot happen. Those steps are dropped and the kid gets the screen
  // legend, which is the part that still means something. Counted off the DOM — the carousel renders
  // one .cf-card per owned card and hides itself at zero — so no client.js internal is needed.
  const owned = $$('#home-carousel .cf-card').length;
  if (owned < 1 && tour === 'full') {
    tour = 'home';
    console.info('[hub-tour] empty album — running the screen legend only, the card lessons need cards');
  }
  // A step whose element is gone is dropped rather than allowed to stall the tour: this hub is
  // edited daily by other agents, and the console line names exactly what went missing.
  STEPS = TOURS[tour].filter((s) => {
    const ok = !!s.src();
    if (!ok) console.warn(`[hub-tour] dropping step '${s.id}' — no element for ${s.spot || '(dynamic)'}`);
    return ok;
  });
  if (!STEPS.length) { console.error('[hub-tour] no steps have targets on this screen'); return; }
  // THE CARD HALF NEEDS AN EMPTY SLOT TO EXIST. A player who has never arranged their powers has
  // `myLoadout === null`, which effectiveLoadout() reads as "auto-fill the album's top three" — so all
  // three slots arrive full, "drag a card into a slot" is already satisfied, and «הכי טוב» has nothing
  // left to do. Cleared in memory for the duration and restored by finish(), and only when this run
  // actually teaches the cards (?tour=home leaves the player's slots alone).
  // It is also what makes the three slot explanations legible: an empty slot is the only time each one
  // shows its own ⚡/🏃/🛡️ glyph instead of a card.
  if (STEPS.some((s) => s.id === 'slot' || s.id === 'best')) prefs()?.emptySlots();
  // HOLD THE CAROUSEL STILL. It auto-rotates every 2.6s, which slides the card out from under the
  // pointing hand and — measured on the real page — leaves whichever card spun in at the front as the
  // one the player actually grabs. The lab never saw this: its sandbox filters that interval out.
  if (STEPS.some((s) => s.gesture === 'drag')) prefs()?.freezeCarousel();

  doneEl?.classList.add('hidden');
  document.body.classList.add('ht-tour');
  document.body.classList.toggle('ht-lab', !!LAB);   // only the lab wears the «דוגמה» badge
  // Tightens the pip row. Keyed on how MANY pips there are, not on which tour: the full run is
  // nineteen of them on an 844px-wide landscape phone.
  document.body.classList.toggle('ht-read', TOURS[tour].length > 6);
  coachToBody();
  if (restart) $('.ht-badge')?.remove();
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
  applyStep();
  render();
  running = true; prevT = performance.now();
  const token = ++runToken;
  requestAnimationFrame((t) => tick(t, token));

  if (LAB && !LAB.carouselFrozen) {
    console.warn('[hub-tour] the carousel auto-rotate was NOT frozen — the 2600ms interval in '
      + 'startCarouselAuto() has changed. The card under the hand will drift. '
      + 'Fix CAROUSEL_MS in _hub-tour-sandbox.js.');
  }
}

// A test seam: the whole tour is module-local, so a browser check can otherwise only infer progress
// from side effects — which is how a stuck machine reads as a passing test.
// ---------------------------------------------------------------------------------------------
// The public face
// ---------------------------------------------------------------------------------------------
// A brand-new player, on the hub, who has neither finished nor waved this away. The lab page forces
// it on regardless, because that is the whole point of the lab.
function pending() {
  if (LAB) return true;
  return !seen(DONE_KEY) && !seen(SKIP_KEY);
}

// client.js hands over here and gets called back when the tour is out of the way, so the pitch
// tutorial follows it rather than racing it.
function begin(onDone) {
  if (running) return false;
  resumeAfter = typeof onDone === 'function' ? onDone : null;
  waitForHub(0);
  return true;
}

let waiting = false;
let readyAt = 0;        // tick the furniture first appeared, so the card grace is measured from there
function waitForHub(tries) {
  if (hubReady()) {
    if (!readyAt) readyAt = tries;
    // Wait a little longer for the carousel, but only a little — see CARD_GRACE_TICKS.
    if (!$('#home-carousel .cf-card') && (tries - readyAt) < CARD_GRACE_TICKS) {
      waiting = true;
      setTimeout(() => waitForHub(tries + 1), 50);
      return;
    }
    waiting = false; start(tourName, false); return;
  }
  if (tries > 200) {
    waiting = false;
    console.error('[hub-tour] hub never rendered — nothing to teach on');
    const resume = resumeAfter; resumeAfter = null; resume?.();
    return;
  }
  waiting = true;
  setTimeout(() => waitForHub(tries + 1), 50);
}

const state = () => ({
  running, waiting, tour, step, stepT: Math.round(stepT * 10) / 10,
  stepId: STEPS[step] ? STEPS[step].id : 'done',
  stepIds: STEPS.map((s) => s.id),
  cap: capEl.textContent, sub: nudgeEl.textContent,
  cosmetic: prefs()?.cosmetic() || null,
  done: STEPS.map((s) => { try { return !!s.done(); } catch { return false; } }),
  finished: seen(DONE_KEY), skipped: seen(SKIP_KEY),
  carouselFrozen: LAB ? !!LAB.carouselFrozen : null,
  writes: LAB ? LAB.writes.slice() : [],
  sends: LAB && LAB.sends ? LAB.sends.slice() : [],
});

window.HubTour = { pending, begin, start: (which) => start(which, true), state };

// A release over the HERO that did not turn him gold. The step's own `done` cannot tell the difference
// between "hasn't tried yet" and "tried with the wrong card", and those need different words on screen.
// Checked a beat after the release so setHeroSkinByRarity has run.
document.addEventListener('pointerup', (e) => {
  if (!running || STEPS[step]?.id !== 'hero') return;
  const overHero = !!(e.target?.closest?.('#pick-hero-btn')
    || document.elementFromPoint(e.clientX, e.clientY)?.closest?.('#pick-hero-btn'));
  if (!overHero) return;
  setTimeout(() => {
    if (running && STEPS[step]?.id === 'hero' && !STEPS[step].done()) wrongDrop = true;
  }, 250);
}, true);

// ---- the lobby's ? button --------------------------------------------------------------------
// Replayable forever, and it does NOT hand the floor back to the pitch tutorial the way the first-run
// launch does: a player who asked for the lesson wants to end up back on the lobby, not dropped into
// level 1. `resumeAfter` is only ever set by begin(), so simply not going through it is the whole
// difference. Bound here rather than in client.js — this button is the tour's, and one more line in
// that file is one more line three agents have to merge.
document.getElementById('hub-howto')?.addEventListener('click', (e) => {
  e.stopPropagation();
  if (running) return;                  // already in it
  // CLOSE THE SETTINGS PANEL FIRST. The ? lives inside that modal, and #settings is a fixed overlay at
  // z-index 20 with a blurred backdrop — a lesson started underneath it would point a hand at a hub
  // nobody can see or touch. «המשך» is the app's own close path (playSound + closeMatchInfo), so it is
  // clicked rather than reimplemented; closeSettings() itself is module-private to client.js.
  document.getElementById('resume')?.click();
  // A beat for the panel to go, so the first step measures the hub and not a covered one.
  setTimeout(() => { if (!running) start('full', true); }, 120);
});
// The lab's verifier drives it through these.
window.__labState = state;
window.__labStart = (which) => start(which, true);

// The LAB page starts itself — there is no client.js hand-off there to wait for. In the game,
// client.js calls HubTour.begin() from tuMaybeAutoStart().
if (LAB) begin(null);
