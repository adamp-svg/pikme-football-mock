// The match-start "my team" reveal (playPromo → «הקבוצה שלך») must show ONE hero column per
// teammate for the match's actual team size.
//
// The bug: the loop was `for (let i = 0; i < 2; i++)`, hardcoded. At 3v3 that rendered two columns
// and silently dropped the third teammate — no error, just a missing player. The VS/teams page was
// already team-size driven, so the two screens disagreed with each other.
//
// Runs the REAL playPromo out of client.js against the REAL #promo markup under jsdom, with its
// collaborators stubbed. No live server needed.
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'public/client.js'), 'utf8');
const html = readFileSync(join(here, 'public/index.html'), 'utf8');
const css = readFileSync(join(here, 'public/style.css'), 'utf8');

let failed = 0;
const ok = (label, cond, extra = '') => { if (!cond) failed++; console.log(`  ${cond ? '✅' : '❌'} ${label}${extra ? ` — ${extra}` : ''}`); };

// Pull just playPromo's source out of client.js (the module as a whole can't be imported — it opens
// a WebSocket and touches canvas on load).
const start = src.indexOf('function playPromo(');
const end = src.indexOf('\n}\n', src.indexOf('promoEl.classList.add(\'hidden\')', start)) + 3;
const promoSrc = src.slice(start, end);
ok('found playPromo in client.js', promoSrc.startsWith('function playPromo(') && promoSrc.includes('promo-heroes'));

// Render the promo for a given team size and count the hero columns.
function runPromo(teamSize, mates) {
  const dom = new JSDOM(html, { pretendToBeVisual: true });
  const { document, requestAnimationFrame } = dom.window;
  const promoEl = document.getElementById('promo');
  const deps = {
    promoEl,
    document,
    requestAnimationFrame: (f) => f(),
    setTimeout: () => 0,          // skip the card-meteor timeline entirely
    matchRoster: mates,
    matchTeamSize: teamSize,
    me: { team: 'A' },
    myMemberId: 'me',
    DEFAULT_COSMETIC: 'striker:default',
    promoHeroCanvas: () => { const c = document.createElement('canvas'); c.className = 'promo-hero-cv'; return c; },
    effectiveLoadout: () => [{ r: 'rare', n: 1 }],
    myCards: () => [],
    rankCards: () => [],
    preloadCards: () => {},
    meteorCard: () => {},
  };
  const names = Object.keys(deps);
  const body = `let promoActive = false, promoBoosters = [];
    ${promoSrc}
    playPromo(4600);
    return { active: promoActive, boosters: promoBoosters };`;
  new Function(...names, body)(...names.map((n) => deps[n]));
  return { document, promoEl, cols: [...promoEl.querySelectorAll('.promo-hero')] };
}

const roster = (n) => Array.from({ length: n }, (_, i) => ({
  id: i === 0 ? 'me' : `mate${i}`, name: i === 0 ? 'אני' : `חבר ${i}`, team: 'A',
  cards: [], cosmetic: 'striker:default', loadout: [{ r: 'rare', n: 2 }], isBot: i > 0,
}));

console.log('1) one hero column per teammate');
for (const n of [2, 3]) {
  const { promoEl, cols } = runPromo(n, roster(n));
  ok(`  ${n}v${n}: ${n} hero columns`, cols.length === n, `${cols.length} columns`);
  ok(`  ${n}v${n}: every column has a hero canvas`, cols.every((c) => c.querySelector('canvas.promo-hero-cv')));
  ok(`  ${n}v${n}: every column has a card zone`, cols.every((c) => c.querySelector('.promo-hero-cards')));
  ok(`  ${n}v${n}: promo tagged data-size=${n}`, promoEl.dataset.size === String(n), `got ${promoEl.dataset.size}`);
  // Every real teammate must be NAMED — the missing third player was the whole bug.
  const names = cols.map((c) => c.querySelector('.promo-hero-name')?.textContent || '');
  ok(`  ${n}v${n}: all ${n} teammates named`, names.every((t) => t.length > 0) && new Set(names).size === n, names.join(' | '));
}

console.log('2) a short roster still fills the columns with bot placeholders');
{
  // 3v3 where only 2 teammates came through: still 3 columns, the last a 'בוט' placeholder,
  // rather than a hole in the line-up.
  const { cols } = runPromo(3, roster(2));
  ok('3 columns from a 2-player roster', cols.length === 3, `${cols.length}`);
  ok('the empty slot reads בוט', (cols[2].querySelector('.promo-hero-name')?.textContent || '').includes('בוט'));
}

console.log('3) the CSS can actually fit three columns');
{
  ok('a data-size="3" rule exists', css.includes('.promo[data-size="3"]'));
  ok('...and it tightens the gap', /\.promo\[data-size="3"\]\s*\.promo-heroes\s*\{[^}]*gap:/.test(css));
  ok('the third column gets its own reveal delay', css.includes('.promo-hero:nth-child(3)'));
  ok('.promo-heroes is width-capped so it cannot overflow', /\.promo-heroes\s*\{[^}]*max-width:/.test(css));
}

console.log('4) team size reaches the client from the server');
{
  ok('enterMatch reads matchStart.teamSize', /matchTeamSize = .*msg\.teamSize/.test(src));
  ok('playPromo loops to that, not a literal 2', promoSrc.includes('i < perTeam') && !promoSrc.includes('i < 2'));
  ok('the VS/teams page is driven the same way', src.includes('+msg.teamSize'));
}

console.log(failed ? `\n❌ ${failed} FAILED` : '\n✅ ALL PASS');
process.exit(failed ? 1 : 0);
