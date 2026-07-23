// Behavioral test for tap-outside-to-leave (request 1, opus-football).
// Loads the REAL index.html DOM and evals the REAL code block from client.js
// (isDismissBackdrop + wiring) so the test verifies shipped logic, not a copy.
// Rule under test: on a lobby sub-page, tapping the page's EMPTY structural whitespace
// (screen margin / .subpage / .subpage-body / .subpage-head / bare h2) returns to the hub;
// tapping any control OR visible content tile keeps the page open; on friends only the
// stadium around the centred panel dismisses.
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./public/index.html', import.meta.url), 'utf8');
const src = readFileSync(new URL('./public/client.js', import.meta.url), 'utf8');

const start = src.indexOf('function isDismissBackdrop');
if (start < 0) throw new Error('isDismissBackdrop not found');
const after = src.indexOf("for (const id of ['arena'", start);
const loopEnd = src.indexOf('\n}', after);
const block = src.slice(start, loopEnd + 2);

const dom = new JSDOM(html, { runScripts: 'outside-only' });
const { window } = dom;
const { document } = window;
globalThis.window = window; globalThis.document = document;

const calls = [];
function showScreen(name) { calls.push(name); }
const screens = {};
for (const id of ['arena', 'news', 'shop', 'clubs', 'rank', 'cards', 'friends']) screens[id] = document.getElementById(id);

// Inject the dynamic cards-page controls renderCardsPage() would create at runtime.
const deck = document.getElementById('cards-deck');
const fan = document.createElement('div'); fan.className = 'fan-card'; fan.dataset.r = 'rare'; fan.dataset.n = '5';
const fanChild = document.createElement('img'); fan.appendChild(fanChild); deck.appendChild(fan);
const slots = document.getElementById('cards-slots');
const pslot = document.createElement('div'); pslot.className = 'pslot pslot-item'; pslot.dataset.slot = '0'; slots.appendChild(pslot);

new Function('screens', 'showScreen', 'document', 'window', block)(screens, showScreen, document, window);

function tap(el) { el.dispatchEvent(new window.Event('pointerdown', { bubbles: true })); el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); }
function drag(downEl, upEl) { downEl.dispatchEvent(new window.Event('pointerdown', { bubbles: true })); upEl.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); }
const q = (sel, root = document) => { const el = root.querySelector(sel); if (!el) throw new Error('selector not found: ' + sel); return el; };

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.log('FAIL  ' + name); } };
const expectClose = (name, fn) => { const n = calls.length; fn(); check(name, calls.length > n && calls[calls.length - 1] === 'home'); };
const expectStay = (name, fn) => { const n = calls.length; fn(); check(name, calls.length === n); };

// --- empty whitespace on full-bleed pages closes ---------------------------
expectClose('shop: tap subpage-body whitespace → home', () => tap(q('#shop .subpage-body')));
expectClose('shop: tap subpage whitespace → home', () => tap(q('#shop .subpage')));
expectClose('shop: tap header whitespace → home', () => tap(q('#shop .subpage-head')));
expectClose('shop: tap h2 → home', () => tap(q('#shop h2')));
expectClose('shop: tap screen root → home', () => tap(screens.shop));
expectClose('news: tap subpage-body whitespace → home', () => tap(q('#news .subpage-body')));
expectClose('clubs: tap subpage-body whitespace → home', () => tap(q('#clubs .subpage-body')));
expectClose('rank: tap subpage-body whitespace → home', () => tap(q('#rank .subpage-body')));
expectClose('arena: tap subpage-body whitespace → home', () => tap(q('#arena .subpage-body')));
expectClose('cards: tap subpage-body whitespace → home', () => tap(q('#cards .subpage-body')));

// --- controls keep the page open -------------------------------------------
expectStay('arena: tap 2v2 button stays', () => tap(q('#arena-2v2-btn')));
expectStay('arena: tap back button stays', () => tap(q('#arena .subpage-back')));
expectStay('cards: tap deck card (.fan-card) stays', () => tap(fan));
expectStay('cards: tap inside card (img) stays', () => tap(fanChild));
expectStay('cards: tap power slot (.pslot-item) stays', () => tap(pslot));
expectStay('cards: tap best-btn stays', () => tap(q('#cards-best-btn')));
expectStay('clubs: tap create-club CTA button stays', () => tap(q('#clubs .club-cta')));

// --- visible content tiles are "main area": keep the page open --------------
expectStay('shop: tap a shop item tile stays', () => tap(q('#shop .shop-item')));
expectStay('news: tap a news item stays', () => tap(q('#news .news-item')));
expectStay('clubs: tap a club feature tile stays', () => tap(q('#clubs .club-feat')));
expectStay('arena: tap a locked mode card stays', () => tap(q('#arena .modecard.lock')));

// --- drag guard: down on a card, click on backdrop → must NOT close ----------
expectStay('cards: drag from card ending on body does NOT close', () => drag(fan, q('#cards .subpage-body')));

// --- friends: stadium closes, panel interior stays --------------------------
expectClose('friends: tap screen root (stadium) → home', () => tap(screens.friends));
expectStay('friends: tap inside panel (.home-wrap) stays', () => tap(q('#friends .home-wrap')));
expectStay('friends: tap a tab stays', () => tap(q('#friends .fr-tab')));
expectStay('friends: tap search input stays', () => tap(q('#friend-search')));
expectStay('friends: tap friends-back stays', () => tap(q('#friends-back')));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
