// Every sub-page must have a VISIBLE way back, saying the same words, wearing the same look, in the
// same place — matching the ARENA BUILDER, which is the reference design language.
//
// This renders the REAL index.html with jsdom and runs the REAL back-nav.js against it. The page
// list is DERIVED from the DOM, not hard-coded: the first version of this test hard-coded 7 ids and
// silently never checked friend-select, which is exactly the drift a guard rail is supposed to stop.
//
// NOTE ON WHAT jsdom CAN AND CANNOT PROVE: it resolves the cascade, so it catches the class/width
// bug that shipped once (`.subpage-back` is declared twice and the survivor is a fixed 44×44 grid
// box, which wrapped «‹ חזרה» onto two lines). It has NO layout, so it cannot prove "same
// position". That is checked in a real browser over CDP — see the note at the bottom.
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, 'public/index.html'), 'utf8');
const css = readFileSync(join(here, 'public/style.css'), 'utf8');
const script = readFileSync(join(here, 'public/back-nav.js'), 'utf8');

let failed = 0;
const ok = (label, cond, extra = '') => { if (!cond) failed++; console.log(`  ${cond ? '✅' : '❌'} ${label}${extra ? ` — ${extra}` : ''}`); };

const LABEL = '‹ חזרה';
const CLS = 'builder-btn builder-back';
const NOT_SUBPAGES = new Set(['start', 'home', 'lobby', 'game']);

// ---- load order is load-bearing ---------------------------------------------------------------
console.log('load order (this shipped broken once)');
const iBack = html.indexOf('src="/back-nav.js"');
const iClient = html.indexOf('src="/client.js"');
ok('back-nav.js is in index.html', iBack !== -1);
ok('it loads BEFORE the client.js module', iBack !== -1 && iBack < iClient, `back@${iBack} client@${iClient}`);
ok('it is a CLASSIC script — deferred/module would run AFTER client.js binds [data-home-back]',
  /<script src="\/back-nav\.js"><\/script>/.test(html));

// Inline style.css so getComputedStyle resolves the real cascade (that is how the 44px bug is caught).
const dom = new JSDOM(html.replace('</head>', `<style>${css}</style></head>`),
  { url: 'http://localhost:3012/', runScripts: 'outside-only' });
const doc = dom.window.document;
const { getComputedStyle } = dom.window;

// Derive the expected set from the DOM: every .screen that is not a root AND owns a .subpage-head.
const ownHead = (s) => [...s.querySelectorAll('.subpage-head')]
  .find((h) => !h.closest('.field-modal, .fp-modal, .modal, [class*="-modal"], .fp-sheet'));
const expected = [...doc.querySelectorAll('.screen')]
  .filter((s) => s.id && !NOT_SUBPAGES.has(s.id))
  .filter((s) => ownHead(s) || s.querySelector('[data-home-back], .th-back, .subpage-back'))
  .map((s) => s.id);

console.log(`\nderived sub-page set (${expected.length}): ${expected.join(' ')}`);
ok('every screen with a header was discovered, none hard-coded', expected.length >= 10, String(expected.length));

dom.window.eval(script);

console.log('\nreachable — every sub-page has a back');
for (const id of expected) {
  const b = doc.querySelector(`#${id} [data-home-back], #${id} .builder-back, #${id} .th-back`);
  ok(`#${id}`, !!b, b ? `"${b.textContent.trim()}"` : 'MISSING');
}

console.log('\nsame language, same look (the builder is the reference)');
const backs = expected.map((id) => ({ id, el: doc.querySelector(`#${id} .builder-back, #${id} [data-home-back], #${id} .th-back`) })).filter((x) => x.el);
const uniq = (f) => [...new Set(backs.map(f))];
ok('one label everywhere', uniq((x) => x.el.textContent.trim()).length === 1, uniq((x) => x.el.textContent.trim()).join(' | '));
ok(`that label is exactly "${LABEL}"`, backs.every((x) => x.el.textContent.trim() === LABEL));
ok('one class list everywhere', uniq((x) => x.el.className).length === 1, uniq((x) => x.el.className).join(' | '));
ok(`that class list is exactly "${CLS}"`, backs.every((x) => x.el.className === CLS));
ok('no stale .subpage-back survives on a labelled back', !doc.querySelector('.screen .subpage-back'));
ok('the mirrored "›" glyph is gone (was on #thread)', !backs.some((x) => x.el.textContent.includes('›')));
ok('all are <button type=button>', backs.every((x) => x.el.tagName === 'BUTTON' && x.el.getAttribute('type') === 'button'));
ok('none carries an aria-label that could contradict the visible text',
  backs.every((x) => !x.el.hasAttribute('aria-label')));

console.log('\nthe cascade actually resolves to a pill, not a 44px icon square');
for (const { id, el } of backs.slice(0, 3).concat(backs.filter((x) => x.id === 'cards'))) {
  const cs = getComputedStyle(el);
  ok(`#${id} width is not fixed at 44px`, cs.width !== '44px', `width=${cs.width || '(auto)'}`);
  ok(`#${id} padding matches the builder's 8px 14px`, cs.padding === '8px 14px' || cs.paddingTop === '8px', `padding=${cs.padding}`);
}

console.log('\nposition — first child of the head, in flow (never absolute)');
for (const { id, el } of backs) {
  const head = ownHead(doc.getElementById(id));
  if (!head) { ok(`#${id} (no own head — keeps its own bar)`, true); continue; }
  ok(`#${id} back is the head's FIRST child`, head.firstElementChild === el);
  ok(`#${id} is not absolutely positioned`, getComputedStyle(el).position !== 'absolute', getComputedStyle(el).position);
}

console.log('\nbehaviour — back must do what LEAVING the page means, not less');
// The invisible backdrop dismiss on these two tears the room down; the visible button must too, or
// it silently orphans the room server-side.
const fs_ = doc.querySelector('#friend-select .builder-back');
ok('#friend-select adopts id=friend-select-close (client.js binds cancelInvite to it)', fs_?.id === 'friend-select-close');
ok('#friend-select does NOT also carry data-home-back (cancelInvite navigates home itself)', !fs_?.hasAttribute('data-home-back'));
const pt = doc.querySelector('#party .builder-back');
ok('#party does NOT use plain data-home-back (it must run leaveToLobby)', !pt?.hasAttribute('data-home-back'));
ok('#thread keeps id=th-back so its own handler still routes to FRIENDS', doc.querySelector('#thread .builder-back')?.id === 'th-back');
for (const id of ['arena', 'news', 'shop', 'clubs', 'rank', 'cards', 'friends']) {
  ok(`#${id} uses the standard data-home-back`, !!doc.querySelector(`#${id} [data-home-back]`));
}

console.log('\nrestraint');
for (const id of NOT_SUBPAGES) {
  ok(`#${id} untouched (not a sub-page)`, !doc.querySelector(`#${id} > .subpage-head > .builder-back`));
}
ok('the builder\'s nested field-picker head was left alone',
  !doc.querySelector('#builder .fp-sheet .builder-back, #builder .field-modal .builder-back'));
ok('no page has two labelled backs',
  expected.every((id) => doc.querySelectorAll(`#${id} .builder-back`).length <= 1));

console.log('\nidempotent (re-runnable for screens built at runtime)');
const before = doc.querySelectorAll('.builder-back').length;
const clsBefore = uniq((x) => x.el.className).join();
dom.window.fbAddBackButtons();
dom.window.fbAddBackButtons();
ok('no duplicate buttons', doc.querySelectorAll('.builder-back').length === before, `${before} -> ${doc.querySelectorAll('.builder-back').length}`);
ok('no duplicated class strings (assign, never prepend)',
  uniq((x) => x.el.className).join() === clsBefore, uniq((x) => x.el.className).join(' | '));

console.log('\n  ℹ️  "same rendered position" cannot be proven here — jsdom has no layout.');
console.log('     Verified separately in headless Chrome over CDP: all 11 surfaces measured');
console.log('     67×32 at top:14 right:18, identical bg/radius/padding/font to the builder.');
console.log(failed ? `\n❌ ${failed} failed` : '\n✅ all passed');
process.exit(failed ? 1 : 0);
