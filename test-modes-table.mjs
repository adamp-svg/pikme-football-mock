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

const scope = { document, MODES: null, renderModeList: null };
const run = new Function('document', `${modesSrc}; return { MODES, renderModeList };`);
Object.assign(scope, run(document));
const { MODES, renderModeList } = scope;

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
  const cards = [...el.querySelectorAll('.modecard')];
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

console.log('3) the drift bug cannot come back');
// goal-brawl is live on the server; it must render live on EVERY surface that offers it.
for (const el of lists) {
  const brawl = el.querySelector('.modecard[data-mode-id="brawl"]');
  ok(`[${el.dataset.modes}] goal-brawl present and live`, !!brawl && !brawl.classList.contains('lock'),
    brawl ? (brawl.classList.contains('lock') ? 'rendered LOCKED' : 'live') : 'missing');
}
// The party surface must only offer modes a private room can actually host.
const partyList = lists.find((el) => el.dataset.modes === 'party');
const partyLive = [...partyList.querySelectorAll('.modecard:not(.lock)')].map((c) => c.dataset.modeId);
ok('party surface offers only party-capable modes',
  partyLive.every((id) => MODES.find((m) => m.id === id).party === true), partyLive.join(', '));

console.log('4) launchers go through the table');
ok('no stale #arena-2v2-btn handler', !src.includes("getElementById('arena-2v2-btn')"));
ok('no stale #arena-brawl-btn handler', !src.includes("getElementById('arena-brawl-btn')"));
ok('no stale data-game / data-party-game readers',
  !src.includes('.modecard[data-game]') && !src.includes('.modecard[data-party-game]'));
ok('hub goal-brawl shortcut launches via the table', src.includes("launchMode('brawl')"));

console.log(failed ? `\n❌ ${failed} FAILED` : '\n✅ ALL PASS');
process.exit(failed ? 1 : 0);
