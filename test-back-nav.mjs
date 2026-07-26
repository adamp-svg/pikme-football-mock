// Every sub-page must have a VISIBLE way back, in the SAME place, on every page.
//
// Before back-nav.js only builder/cards/thread had one; arena · news · shop · clubs · rank ·
// friends · party had nothing but the invisible tap-the-background dismiss. This renders the REAL
// index.html with jsdom, runs the REAL back-nav.js against it, and asserts the result — so a page
// added later without a back button fails here instead of shipping.
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, 'public/index.html'), 'utf8');
const script = readFileSync(join(here, 'public/back-nav.js'), 'utf8');

let failed = 0;
const ok = (label, cond, extra = '') => { if (!cond) failed++; console.log(`  ${cond ? '✅' : '❌'} ${label}${extra ? ` — ${extra}` : ''}`); };

// `runScripts: 'outside-only'` gives window.eval the window's own globals (document, etc.) without
// executing index.html's real <script> tags — we want back-nav.js run in isolation, not client.js
// booting a WebSocket and a canvas.
const dom = new JSDOM(html, { url: 'http://localhost:3012/', runScripts: 'outside-only' });
const doc = dom.window.document;

// ---- load order is load-bearing -------------------------------------------------------------
// Modules are deferred; a classic script is not. back-nav.js must come FIRST or client.js will
// have finished binding [data-home-back] before the buttons exist.
console.log('load order');
const iBack = html.indexOf('src="/back-nav.js"');
const iClient = html.indexOf('src="/client.js"');
ok('back-nav.js is present in index.html', iBack !== -1);
ok('client.js is present', iClient !== -1);
ok('back-nav.js loads BEFORE the client.js module', iBack !== -1 && iBack < iClient, `back@${iBack} client@${iClient}`);
ok('back-nav.js is a CLASSIC script (not type=module, not defer)',
  /<script src="\/back-nav\.js"><\/script>/.test(html));

// ---- run the real thing ----------------------------------------------------------------------
const SUBPAGES = ['arena', 'news', 'shop', 'clubs', 'rank', 'friends', 'party'];
const ALREADY = ['builder', 'cards', 'thread'];
const NOT_SUBPAGES = ['start', 'home', 'lobby', 'game'];

console.log('\nbefore: the gap this exists to close');
const missingBefore = SUBPAGES.filter((id) => !doc.querySelector(`#${id} [data-home-back], #${id} .th-back`));
ok('the 7 target sub-pages start with no back button', missingBefore.length === 7, `${missingBefore.length}/7`);

dom.window.eval(script);

console.log('\nafter: every sub-page is reachable');
for (const id of [...SUBPAGES, ...ALREADY]) {
  const screen = doc.getElementById(id);
  const back = screen?.querySelector('[data-home-back], .th-back, #game-select-close');
  ok(`#${id} has a visible back`, !!back, back ? `<${back.tagName.toLowerCase()} class="${back.className}">` : 'MISSING');
}

console.log('\nconsistency');
for (const id of SUBPAGES) {
  const head = doc.querySelector(`#${id} .subpage-head`);
  const btn = head?.firstElementChild;
  ok(`#${id}: back is the FIRST child of .subpage-head (same spot on every page)`,
    !!btn && btn.hasAttribute('data-home-back'), btn ? btn.tagName.toLowerCase() + '.' + btn.className : 'no head');
}
const labels = new Set(SUBPAGES.map((id) => doc.querySelector(`#${id} [data-home-back]`)?.textContent));
ok('all injected buttons share ONE label', labels.size === 1, [...labels].join(' | '));
const classes = new Set(SUBPAGES.map((id) => doc.querySelector(`#${id} [data-home-back]`)?.className));
ok('all injected buttons share ONE class', classes.size === 1, [...classes].join(' | '));
ok('that class is the existing .subpage-back pill (so it needs no new CSS)',
  [...classes][0] === 'subpage-back', [...classes][0]);
ok('every injected button is a real <button type=button>',
  SUBPAGES.every((id) => { const b = doc.querySelector(`#${id} [data-home-back]`); return b?.tagName === 'BUTTON' && b.getAttribute('type') === 'button'; }));
ok('every injected button has an aria-label',
  SUBPAGES.every((id) => doc.querySelector(`#${id} [data-home-back]`)?.getAttribute('aria-label') === 'חזרה'));

console.log('\nrestraint — what it must NOT touch');
for (const id of NOT_SUBPAGES) {
  ok(`#${id} got no back pill (not a sub-page)`, !doc.querySelector(`#${id} > .subpage-head > [data-home-back]`));
}
// thread's ‹ goes back to FRIENDS, not home. Injecting data-home-back there would silently
// reroute the chat's back button to the hub.
ok('#thread keeps its own ‹ and gains no data-home-back',
  !!doc.querySelector('#thread .th-back') && !doc.querySelector('#thread [data-home-back]'));
// The builder's back lives in its top bar; the head inside it belongs to the FIELD PICKER modal.
ok('the builder\'s nested field-picker head was left alone',
  !doc.querySelector('#builder .field-modal [data-home-back], #builder .subpage-head [data-home-back]'));
ok('#cards was not given a second back button',
  doc.querySelectorAll('#cards [data-home-back]').length === 1,
  String(doc.querySelectorAll('#cards [data-home-back]').length));

console.log('\nidempotent');
const before = doc.querySelectorAll('[data-home-back]').length;
dom.window.fbAddBackButtons();
dom.window.fbAddBackButtons();
ok('running it again adds nothing (safe to re-run for runtime screens)',
  doc.querySelectorAll('[data-home-back]').length === before, `${before} -> ${doc.querySelectorAll('[data-home-back]').length}`);

console.log(failed ? `\n❌ ${failed} failed` : '\n✅ all passed');
process.exit(failed ? 1 : 0);
