// The MODES table is the single source of truth for every mode-pick surface.
// Four hand-copied lists had already drifted (goal-brawl live on the server but
// «בקרוב» in three pickers). This renders the REAL index.html with jsdom and asserts
// every surface agrees, so a future drift fails here instead of shipping.
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, 'public/index.html'), 'utf8');
const src = readFileSync(join(here, 'public/client.js'), 'utf8');

let failed = 0;
const ok = (label, cond, extra = '') => { if (!cond) failed++; console.log(`  ${cond ? '✅' : '❌'} ${label}${extra ? ` — ${extra}` : ''}`); };

// Pull the MODES literal + the renderer out of client.js and run them against the real
// markup. (client.js as a whole can't be imported here — it's a browser module that
// opens a WebSocket and touches canvas on load.)
const modesSrc = src.slice(src.indexOf('const MODES = ['), src.indexOf('function renderAllModeLists'));
ok('found the MODES block in client.js', modesSrc.length > 0 && modesSrc.includes('renderModeList'));

const dom = new JSDOM(html);
const { document } = dom.window;
global.document = document;

// drawModeArt lives in its own module (public/mode-art.js) and is a real dependency of the
// renderer, so inject the real one rather than a stub — that way the art code is exercised too.
const { drawModeArt } = await import('./public/mode-art.js');
const run = new Function('document', 'drawModeArt', `${modesSrc}; return { MODES, renderModeList };`);
const { MODES, renderModeList } = run(document, drawModeArt);

console.log('1) the table itself');
ok('has entries', Array.isArray(MODES) && MODES.length >= 2, `${MODES.length} modes`);
ok('every mode has id/ic/name/sub/state', MODES.every((m) => m.id && m.ic && m.name && m.sub && m.state));
ok('every LIVE mode can be launched', MODES.filter((m) => m.state === 'live').every((m) => typeof m.launch === 'function'));
ok('no duplicate ids', new Set(MODES.map((m) => m.id)).size === MODES.length);

console.log('2) every surface renders from the table');
const lists = [...document.querySelectorAll('.mode-list')];
ok('markup has mode-list containers', lists.length >= 3, `${lists.length} found (#arena, #party, #game-select)`);
ok('no hand-written mode cards left in the markup',
  document.querySelectorAll('.modecard').length === 0,
  `${document.querySelectorAll('.modecard').length} static cards`);

for (const el of lists) renderModeList(el);
for (const el of lists) {
  const cards = [...el.querySelectorAll('[data-mode-id]')];
  const kind = el.dataset.modes;
  ok(`[${kind}] rendered cards`, cards.length > 0, `${cards.length}`);
  ok(`[${kind}] every card carries a mode id`, cards.every((c) => c.dataset.modeId));
  ok(`[${kind}] ids all resolve to the table`, cards.every((c) => MODES.some((m) => m.id === c.dataset.modeId)));
  ok(`[${kind}] live modes are NOT locked`,
    cards.filter((c) => MODES.find((m) => m.id === c.dataset.modeId).state === 'live')
      .every((c) => !c.classList.contains('lock')));
  ok(`[${kind}] dev modes ARE locked`,
    cards.filter((c) => MODES.find((m) => m.id === c.dataset.modeId).state !== 'live')
      .every((c) => c.classList.contains('lock')));
}

console.log('3) the picker renders portrait pixel-art cards');
{
  const picker = lists.find((el) => el.dataset.modes === 'launch');
  const cards = [...picker.querySelectorAll('.pcard')];
  ok('one portrait card per mode', cards.length === MODES.length, `${cards.length} of ${MODES.length}`);
  ok('every card has a pixel-art canvas', cards.every((c) => c.querySelector('canvas.pc-cv')));
  ok('every card has a coloured band', cards.every((c) => c.style.getPropertyValue('--band-hi')));
  ok('band colours are all distinct',
    new Set(cards.map((c) => c.style.getPropertyValue('--band-hi'))).size === cards.length);
  ok('live cards show rule text, not a lock strip',
    cards.filter((c) => !c.classList.contains('lock')).every((c) => c.querySelector('.pc-meta') && !c.querySelector('.pc-soon')));
  ok('locked cards name a TARGET instead of a bare בקרוב',
    cards.filter((c) => c.classList.contains('lock')).every((c) => c.querySelector('.pc-soon')?.textContent.trim().length > 0));
  // The party surface must stay a compact row list — portrait cards would not fit there.
  const party = lists.find((el) => el.dataset.modes === 'party');
  ok('party surface keeps row cards (no portrait cards)', party.querySelectorAll('.pcard').length === 0);
}

console.log('4) the pixel art itself');
{
  const { ART_W, ART_H } = await import('./public/mode-art.js');
  ok('art is drawn at a tiny internal resolution', ART_W <= 96 && ART_H <= 96, `${ART_W}x${ART_H}`);
  // Every mode must get a DISTINCT scene — a shared fallback would make the picker unreadable.
  const sigs = new Map();
  for (const m of MODES) {
    const cv = document.createElement('canvas');
    let calls = 0;
    cv.getContext = () => ({
      set imageSmoothingEnabled(v) {}, set fillStyle(v) { calls++; this._c = v; },
      get fillStyle() { return this._c; },
      fillRect(x, y, w, h) { calls += (x + y + w + h) | 0; },
    });
    drawModeArt(cv, m.id);
    ok(`  ${m.id} draws something`, calls > 0, `${calls} ops`);
    sigs.set(m.id, calls);
  }
  ok('every mode has a DISTINCT scene', new Set(sigs.values()).size === MODES.length);
}

console.log('5) the drift bug cannot come back');
// goal-brawl is live on the server; it must render live on EVERY surface that offers it.
for (const el of lists) {
  const brawl = el.querySelector('[data-mode-id="brawl"]'); // .modecard OR .pcard
  ok(`[${el.dataset.modes}] goal-brawl present and live`, !!brawl && !brawl.classList.contains('lock'),
    brawl ? (brawl.classList.contains('lock') ? 'rendered LOCKED' : 'live') : 'missing');
}
// The party surface must only offer modes a private room can actually host.
const partyList = lists.find((el) => el.dataset.modes === 'party');
const partyLive = [...partyList.querySelectorAll('[data-mode-id]:not(.lock)')].map((c) => c.dataset.modeId);
ok('party surface offers only party-capable modes',
  partyLive.every((id) => MODES.find((m) => m.id === id).party === true), partyLive.join(', '));

console.log('6) launchers go through the table');
ok('no stale #arena-2v2-btn handler', !src.includes("getElementById('arena-2v2-btn')"));
ok('no stale #arena-brawl-btn handler', !src.includes("getElementById('arena-brawl-btn')"));
ok('no stale data-game / data-party-game readers',
  !src.includes('.modecard[data-game]') && !src.includes('.modecard[data-party-game]'));
ok('hub goal-brawl shortcut launches via the table', src.includes("launchMode('brawl')"));

console.log(failed ? `\n❌ ${failed} FAILED` : '\n✅ ALL PASS');
process.exit(failed ? 1 : 0);
