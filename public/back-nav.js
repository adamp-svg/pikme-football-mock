// ONE back affordance, on every sub-page, in the same place, speaking the same language.
//
// The reference is the ARENA BUILDER: glyph + space + Hebrew word on a #33413a pill —
// «‹ חזרה», «▶ שחק», «💾 שמור», «✕ נקה הכל». Everything below exists to make the other pages
// say and look exactly that.
//
// WHAT WAS WRONG BEFORE THIS FILE: only 3 of 10 sub-pages had a visible way back. arena · news ·
// shop · clubs · rank · friends · party · friend-select had NOTHING and relied on
// isDismissBackdrop() — invisible, and unreachable on pages whose content fills the viewport.
//
// WHAT WAS WRONG IN THE FIRST VERSION OF THIS FILE (all three measured in a real browser, not
// guessed — see test-back-nav.mjs and the CDP screenshots):
//   1. It used `.subpage-back`, believing it was "the #33413a pill". It is not. `.subpage-back` is
//      declared TWICE in style.css; the second rule overrides colour/padding but never resets the
//      first's `width:44px; height:44px; display:grid`, so the 5-glyph label WRAPPED ONTO TWO LINES
//      inside a 44px square. It rendered visibly broken. `.builder-btn` + `.builder-back` is the
//      only rule pair in the codebase sized for a glyph+word label (auto width, padding 8px 14px).
//   2. Its own comment claimed first-child == the builder's position. It is the MIRROR of it:
//      <html lang="he"> has no dir attribute and no CSS sets `direction`, so `.builder-top` is an
//      LTR row and the builder's back sits physically LEFT, while every `.subpage` sets dir="rtl"
//      so first-child sits physically RIGHT.
//   3. On `party` and `friend-select` it called plain showScreen('home'), skipping the room
//      teardown that the invisible backdrop-dismiss performs — so the obvious control did LESS
//      than the hidden one, orphaning the room server-side. See EXITS below.
//
// WHY A GENERATOR AND NOT MARKUP: the ask is consistency. Hand-copied surfaces drift; this repo
// already lost that fight when four hand-written mode lists disagreed until the MODES table
// replaced them. One generator cannot drift, and a page added later gets the button for free.
//
// LOAD ORDER IS LOAD-BEARING: this is a CLASSIC script tag placed ABOVE
// `<script type="module" src="/client.js">`. Module scripts are deferred, so this runs first and
// the buttons exist before client.js binds [data-home-back]. Do NOT move it below client.js and do
// NOT add defer/type=module — the buttons would render and do nothing.
(function backNav() {
  // Not sub-pages: start/home are roots, `lobby` already has «‹ יציאה» (leaving is "leave room",
  // not "go home"), `game` is the pitch and has its own HUD controls.
  const NOT_SUBPAGES = new Set(['start', 'home', 'lobby', 'game']);

  // The builder's exact label and classes. `.builder-btn` gives auto width + padding 8px 14px +
  // radius 10px + 800/14px + #fff; `.builder-back` gives the #33413a background.
  const LABEL = '‹ חזרה';                       // U+2039, one space, חזרה — never '›', never bare
  const CLS = 'builder-btn builder-back';

  // Back must do whatever LEAVING this page actually means, or the visible control silently does
  // less teardown than the invisible backdrop dismiss it replaces.
  //   friend-select: client.js binds cancelInvite() to #friend-select-close — an id that exists
  //                  NOWHERE in the markup. Adopting the id wires the correct teardown with no
  //                  change to client.js. No data-home-back: cancelInvite() navigates home itself.
  //   party:         no spare id, so delegate to #lobby-leave, which client.js binds to
  //                  leaveToLobby() (sends leaveRoom + resets party/VS/overlay state + stopMusic).
  const EXITS = {
    'friend-select': { id: 'friend-select-close' },
    party: { delegateTo: 'lobby-leave' },
    // The WARDROBE. Same trick as friend-select: client.js's setupHeroPicker binds close() to this
    // id, so adopting it wires the real teardown (stops the hero-fx canvas and cancels the preview
    // rAF) instead of just hiding the overlay and leaking two loops.
    'hero-picker': { id: 'hero-picker-close' },
  };

  // A tiny owned stylesheet. Deliberately NOT edited into style.css: two other agents hold that
  // file, and these three rules exist only to serve this component.
  //   1. #cards centres its head (style.css) and used to absolutely position its back — now that
  //      the button is a normal flow child, the head must align to the start like every other page.
  //   2. nowrap is the guard against the exact regression this file already shipped once: a label
  //      breaking onto two lines because something constrained the box.
  //   3. .builder-btn ships without cursor/active feedback; adding it here keeps the pill feeling
  //      like a button without changing the builder's own stylesheet.
  function injectCss() {
    if (document.getElementById('fb-back-nav-css')) return;
    const s = document.createElement('style');
    s.id = 'fb-back-nav-css';
    s.textContent = `
      /* The wardrobe is a .picker overlay, not a .screen with a head — there is no flow position to
         drop a pill into, so this is the one page where the button is positioned. Top-inline-start of
         the panel, which is the same visual corner the flow position produces everywhere else. */
      #hero-picker { position: relative; }
      #hero-picker > .builder-back {
        position: absolute; z-index: 3;
        top: max(10px, env(safe-area-inset-top));
        inset-inline-start: max(10px, env(safe-area-inset-left));
      }
      #cards .subpage-head { justify-content: flex-start; }
      .subpage-head > .builder-back { white-space: nowrap; flex: none; cursor: pointer; }
      .subpage-head > .builder-back:active { transform: translateY(2px); }
    `;
    (document.head || document.documentElement).appendChild(s);
  }

  function ownHead(screen) {
    // A screen can hold a nested `.subpage-head` belonging to a MODAL inside it (the builder holds
    // the field-picker's). Only the screen's own head may be touched.
    for (const head of screen.querySelectorAll('.subpage-head')) {
      if (head.closest('.field-modal, .fp-modal, .modal, [class*="-modal"], .fp-sheet')) continue;
      return head;
    }
    return null;
  }

  // Bring an EXISTING back button into the shared language instead of leaving a third look on the
  // page. Only touches presentation — never the element's id or its handler, so `thread` keeps
  // going back to FRIENDS and `cards` keeps its own binding.
  function normalise(btn) {
    if (!btn || btn.dataset.fbNormalised) return;
    btn.dataset.fbNormalised = '1';
    // ASSIGN, never prepend. Prepending is not idempotent — a second pass produced
    // "builder-btn builder-back builder-btn builder-back". Handlers here are bound by id
    // (#th-back) or by attribute ([data-home-back]), never by these classes, so replacing the
    // class list outright is safe and leaves exactly one look.
    btn.className = CLS;
    btn.textContent = LABEL;                    // kills the mirrored '›' on #thread
    btn.removeAttribute('aria-label');          // the visible text IS the accessible name
    if (!btn.getAttribute('type')) btn.type = 'button';
  }

  // Pages that are NOT `.screen` and would otherwise be skipped entirely. The wardrobe
  // (#hero-picker) is a `.picker` overlay, which is exactly why it was the last page in the game with
  // NO visible way out — «outside-click closes (no ✕, no save)», the same invisible affordance this
  // file exists to replace. Listed rather than loosening the `.screen` selector: `.picker` also
  // matches modals that legitimately dismiss by backdrop.
  const EXTRA_PAGES = ['hero-picker'];

  function addBacks() {
    injectCss();
    let added = 0;
    const pages = [...document.querySelectorAll('.screen')];
    for (const id of EXTRA_PAGES) { const el = document.getElementById(id); if (el && !pages.includes(el)) pages.push(el); }
    for (const screen of pages) {
      const id = screen.id;
      if (!id || NOT_SUBPAGES.has(id)) continue;

      const head = ownHead(screen);

      // Already has one? Adopt it into the shared look/label rather than adding a second.
      // The selector MUST include the canonical markers (.builder-back / [data-fb-normalised]):
      // normalise() replaces the class list and some pages (party, friend-select) never carry
      // data-home-back at all, so a guard that only knew the OLD markers re-injected on every
      // re-run — 12 buttons became 17. Modal buttons are excluded because the field-picker's
      // «ביטול» also wears builder-btn builder-back and must not be mistaken for a page back.
      const existing = [...screen.querySelectorAll(
        '[data-home-back], .th-back, .subpage-back, .builder-back, [data-fb-normalised]',
      )].find((el) => !el.closest('.field-modal, .fp-modal, .modal, [class*="-modal"], .fp-sheet'));
      if (existing && (!head || head.contains(existing) || existing.closest('.builder-top'))) {
        normalise(existing);
        continue;
      }
      // No head? Normally that means leave the page alone. The listed EXTRA_PAGES are the exception:
      // they have no head by design and the CSS above positions the pill on the overlay instead.
      const isExtra = EXTRA_PAGES.includes(id);
      if (!head && !isExtra) continue;            // nothing to hang it on; leave the page alone

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = CLS;
      btn.textContent = LABEL;
      const exit = EXITS[id];
      if (exit && exit.id) btn.id = exit.id;                     // existing handler adopts it
      else if (exit && exit.delegateTo) {
        btn.addEventListener('click', () => document.getElementById(exit.delegateTo)?.click());
      } else {
        btn.setAttribute('data-home-back', '');                  // client.js -> showScreen('home')
      }
      // First child of the head, in normal flow — the head is flex, so this is the start edge and
      // therefore the identical spot on every page. Never position:absolute.
      btn.dataset.fbNormalised = '1';            // already in the canonical form; keep re-runs no-ops
      if (head) head.insertBefore(btn, head.firstChild);
      else screen.appendChild(btn);              // EXTRA_PAGES: positioned by this file's own CSS
      added++;
    }
    return added;
  }

  // Run SYNCHRONOUSLY. Do NOT wait for DOMContentLoaded: deferred scripts — which includes every
  // type="module" — run BEFORE that event, so client.js would already have bound [data-home-back]
  // and every button would render dead. (This shipped broken once; test-back-nav.mjs now asserts
  // the ordering, not just presence.) Safe because this tag sits at the END of <body>.
  addBacks();
  // Only reachable if someone moves this tag into <head>, where nothing is parsed yet. addBacks()
  // is idempotent, so in the normal case this never fires and would be a no-op anyway.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', addBacks, { once: true });
  }

  // Exposed for test-back-nav.mjs and for any screen built at runtime.
  window.fbAddBackButtons = addBacks;
})();
