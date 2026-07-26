// CONSISTENT BACK BUTTON on every sub-page.
//
// The problem this fixes: only 3 of 10 sub-pages had a visible way back. `builder` had its
// «‹ חזרה» in the top bar, `cards` had the canonical `.subpage-back` pill, `thread` had its own
// ‹ arrow — and arena · news · shop · clubs · rank · friends · party had NOTHING. They relied
// entirely on tap-the-background-to-dismiss (isDismissBackdrop in client.js), which is invisible
// (nothing tells you it is there) and unreachable on the pages whose content fills the viewport,
// so there was no way out but the app's own back gesture.
//
// WHY A SCRIPT AND NOT 7 BUTTONS IN index.html: the user asked for it to be *consistent* and
// *always in the same place*. Seven hand-copied markup blocks drift — this repo has already been
// burned by exactly that (four hand-copied mode lists disagreed until the MODES table replaced
// them, see test-modes-table.mjs). One generator cannot drift, and any sub-page added later gets
// the button for free with no one having to remember.
//
// LOAD ORDER MATTERS: this is a CLASSIC script tag placed BEFORE `<script type="module"
// src="/client.js">`. Module scripts are deferred, so this runs first, the buttons exist before
// client.js binds `[data-home-back]`, and they are wired by the EXISTING handler — which routes
// through showScreen('home') and so keeps the music + joystick side effects. No navigation logic
// is duplicated here. Move this tag after client.js and the buttons render but do nothing.
(function backNav() {
  // Not sub-pages: `start`/`home` are the roots, `lobby` is the pre-match countdown (leaving is
  // «leave room», not «go home» — a back pill there would send the wrong message to the server),
  // and `game` is the pitch (it has its own in-match controls).
  const NOT_SUBPAGES = new Set(['start', 'home', 'lobby', 'game']);

  // Match `cards` exactly — it is the canonical pattern:
  //   <div class="subpage-head"><button data-home-back class="subpage-back">‹ חזרה</button><h2>…
  // `.subpage-back` is already defined in style.css (the #33413a pill, same colour as
  // .builder-back), so this needs no CSS of its own.
  const LABEL = '‹ חזרה';

  function ownHead(screen) {
    // A screen can contain a nested `.subpage-head` belonging to a MODAL that lives inside it —
    // the builder holds the field-picker's head. Only the screen's own head may be touched.
    for (const head of screen.querySelectorAll('.subpage-head')) {
      if (head.closest('.field-modal, .fp-modal, .modal, [class*="-modal"]')) continue;
      return head;
    }
    return null;
  }

  function addBacks() {
    let added = 0;
    for (const screen of document.querySelectorAll('.screen')) {
      const id = screen.id;
      if (!id || NOT_SUBPAGES.has(id)) continue;

      // Already reachable? Respect whatever the page already has, including `thread`'s own ‹
      // arrow (which goes back to FRIENDS, not home — overwriting that would break the flow) and
      // the builder's top-bar button.
      if (screen.querySelector('[data-home-back], .th-back, #game-select-close')) continue;

      const head = ownHead(screen);
      if (!head) continue;                       // no header to hang it on; leave the page alone

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'subpage-back';
      btn.setAttribute('data-home-back', '');    // client.js binds this -> showScreen('home')
      btn.setAttribute('aria-label', 'חזרה');
      btn.textContent = LABEL;
      // FIRST child of the head. The head is `display:flex` and the page is RTL, so first == the
      // start edge == top-right on every page. That is what makes the position identical
      // everywhere, and it is where `cards` and the builder already put theirs.
      head.insertBefore(btn, head.firstChild);
      added++;
    }
    return added;
  }

  // Run SYNCHRONOUSLY, right now. Do NOT wait for DOMContentLoaded: deferred scripts — which
  // includes every `type="module"` — run AFTER parsing but BEFORE DOMContentLoaded. So a
  // DOMContentLoaded handler would fire after client.js had already bound [data-home-back], and
  // every button would render but do nothing. (Caught by test-back-nav.mjs, which is why that test
  // asserts load order and not just presence.)
  //
  // Running now is safe because this tag sits at the END of <body>, below all the sub-page markup.
  addBacks();
  // Belt and braces for the one case the line above cannot cover: if someone moves this tag into
  // <head>, nothing is parsed yet and addBacks() finds no screens. Re-running on DOMContentLoaded
  // then still beats nothing, and the function is idempotent so in the normal case this is a no-op.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', addBacks, { once: true });
  }

  // Exposed for the jsdom test (test-back-nav.mjs) and for any screen added at runtime.
  window.fbAddBackButtons = addBacks;
})();
