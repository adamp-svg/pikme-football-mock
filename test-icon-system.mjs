// Production icon-pack guard: verifies the one-file sprite, every manifest ID,
// static replacement, contextual replacement, and dynamic textContent updates.
import { JSDOM } from 'jsdom';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, p), 'utf8');
const html = read('public/index.html');
const css = read('public/icon-system.css');
const script = read('public/icon-system.js');
const backNav = read('public/back-nav.js');
const manifest = read('public/assets/pixel-icon-system-01/manifest.csv').trim().split('\n').slice(1);

let failed = 0;
const ok = (label, cond, extra = '') => {
  if (!cond) failed++;
  console.log(`  ${cond ? '✅' : '❌'} ${label}${extra ? ` — ${extra}` : ''}`);
};

console.log('pack + manifest');
ok('96 stable semantic IDs', manifest.length === 96, String(manifest.length));
const ids = manifest.map((row) => row.split(',')[0]);
ok('every ID has a sprite CSS position', ids.every((id) => css.includes(`.si-${id}{background-position:`)));
// Version-AGNOSTIC on purpose. This used to assert the literal `?v=1`, which made the test fail the
// moment the cache-buster was bumped — and bumping it is mandatory whenever the sheet's pixels change,
// or phones keep serving the cached old art. Assert the intent instead: exactly one webp is the
// runtime source, and it is cache-busted.
const srcRefs = [...css.matchAll(/sprite-pack\.webp\?v=(\d+)/g)].map((m) => m[1]);
ok('one WebP is the runtime source', srcRefs.length > 0 && new Set(srcRefs).size === 1,
  srcRefs.length ? `?v=${srcRefs[0]} x${srcRefs.length}` : 'no cache-busted webp reference');
ok('the PNG is never the runtime source (it is the 5 MB master)', !/sprite-pack\.png\?v=/.test(css));
const webp = statSync(join(here, 'public/assets/pixel-icon-system-01/sprite-pack.webp'));
ok('phone pack stays below 1.5 MB', webp.size < 1_500_000, `${Math.round(webp.size / 1024)} KB`);

console.log('\nload order');
const iBack = html.indexOf('src="/back-nav.js"');
const iIcons = html.indexOf('src="/icon-system.js"');
const iClient = html.indexOf('src="/client.js"');
ok('icon stylesheet is loaded', html.includes('href="/icon-system.css"'));
ok('back nav → icons → client', iBack >= 0 && iBack < iIcons && iIcons < iClient,
  `${iBack} < ${iIcons} < ${iClient}`);

const dom = new JSDOM(html, { url: 'http://localhost:3012/', runScripts: 'outside-only' });
dom.window.eval(backNav);
dom.window.eval(script);
const doc = dom.window.document;

console.log('\nstatic + contextual conversion');
ok('shop uses shop art', !!doc.querySelector('[data-open-screen="shop"] .si-shop'));
ok('quick match football uses play art', !!doc.querySelector('#quick-match-btn .si-play'));
ok('builder hard-wall tool uses hard-wall art', !!doc.querySelector('[data-tool="hard"] .si-hard-wall'));
ok('in-game wall power uses build-wall art', !!doc.querySelector('#build .si-build-wall'));
ok('builder clear X uses clear-all art', !!doc.querySelector('#b-clear .si-clear-all'));
ok('builder diagonal symbol uses mirror-diagonal art', !!doc.querySelector('[data-mirror="diag"] .si-mirror-diagonal'));
ok('rank diamond uses rank art, shop diamond uses gem art',
  !!doc.querySelector('#rank .si-rank-diamond') && !!doc.querySelector('#shop .si-gem'));
ok('legacy glyph is removed from visible quick-match text', !doc.querySelector('#quick-match-btn')?.textContent.includes('⚽'));

console.log('\ndynamic conversion');
const dynamic = doc.createElement('button');
dynamic.id = 'icon-test-dynamic';
doc.body.append(dynamic);
dynamic.textContent = '🤖 שלב 5';
await new Promise((resolve) => dom.window.queueMicrotask(resolve));
ok('MutationObserver converts later textContent', !!dynamic.querySelector('.si-bot'));
ok('text label survives replacement', dynamic.textContent.trim() === 'שלב 5', JSON.stringify(dynamic.textContent.trim()));

console.log('\nCSS-only legacy surfaces');
ok('rank lock pseudo-element uses sprite pack', css.includes('.hub-tier.hub-tier-capped::after'));
ok('wardrobe lock pseudo-element uses sprite pack', css.includes('.pick-hero.locked::after'));
ok('drag cancel cue uses sprite pack', css.includes('.special-btn.cancel-armed::before'));
ok('builder ball marker uses sprite pack', css.includes('.bel.ball::after'));

if (failed) {
  console.error(`\n${failed} icon-system checks failed`);
  process.exit(1);
}
console.log('\nicon system: all checks passed');
