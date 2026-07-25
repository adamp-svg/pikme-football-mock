// shared/bot-buffs.js — the ONE rarity->buff table, now read by both the server (which applies
// the buffs) and the settings panel (which displays them). These tests exist mostly to stop the
// two ends drifting apart again, so a good half of them are parity assertions against the OTHER
// files' source rather than pure maths.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  RARITY_BUFF_PCT, RARITY_LABEL_HE, pctOf, buffsFromLoadout, loadoutTotalPct,
  buffPercents, totalBoostPct, botSideScalar, EXTREME_SKILL, EXTREME_BOT_BUFFS,
} from './shared/bot-buffs.js';
import { levelAt, skillWord, T, DIFFICULTY_LEVELS } from './shared/difficulty.js';

const here = dirname(fileURLToPath(import.meta.url));
let failed = 0;
const ok = (label, cond, extra = '') => { if (!cond) failed++; console.log(`  ${cond ? '✅' : '❌'} ${label}${extra ? ` — ${extra}` : ''}`); };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

const LEG = { r: 'legendary', n: 1 }, EPI = { r: 'epic', n: 2 }, RAR = { r: 'rare', n: 3 }, COM = { r: 'common', n: 4 };

console.log('--- rarity table ---');
ok('the four rarities keep their documented percentages',
  RARITY_BUFF_PCT.legendary === 0.20 && RARITY_BUFF_PCT.epic === 0.12
  && RARITY_BUFF_PCT.rare === 0.07 && RARITY_BUFF_PCT.common === 0.03);
ok('an empty slot is neutral, not a penalty', pctOf(null) === 0 && pctOf(undefined) === 0);
ok('an unknown rarity reads as 0 rather than NaN', pctOf({ r: 'mythic' }) === 0);

console.log('\n--- buffsFromLoadout: the multipliers the sim consumes ---');
{
  const b = buffsFromLoadout([LEG, LEG, LEG]);
  ok('3 legendaries -> cardShot 1.25', near(b.cardShot, 1.25));
  ok('3 legendaries -> speedBuff 1.20', near(b.speedBuff, 1.20));
  ok('3 legendaries -> cardUtil 0.80', near(b.cardUtil, 0.80));
}
{
  const b = buffsFromLoadout([]);
  ok('no cards -> a fully neutral 1/1/1', b.cardShot === 1 && b.speedBuff === 1 && b.cardUtil === 1);
}
{
  const b = buffsFromLoadout([null, EPI, null]);
  ok('a card only in the SPEED slot moves only speedBuff',
    b.cardShot === 1 && near(b.speedBuff, 1.12) && b.cardUtil === 1);
}
ok('loadoutTotalPct sums the three slots', near(loadoutTotalPct([LEG, EPI, RAR]), 0.39));
ok('loadoutTotalPct of an empty loadout is 0', loadoutTotalPct([null, null, null]) === 0);

console.log('\n--- buffPercents: the display inverse ---');
// This is the load-bearing property: the panel must be able to recover the real percentages from
// the multipliers alone, because that is all the wire carries.
for (const lo of [[LEG, LEG, LEG], [COM, RAR, EPI], [null, null, LEG], [], [EPI, null, COM]]) {
  const p = buffPercents(buffsFromLoadout(lo));
  const want = [pctOf(lo[0]), pctOf(lo[1]), pctOf(lo[2])];
  ok(`round-trips ${JSON.stringify(lo.map((s) => (s ? s.r : null)))}`,
    near(p.shot, want[0], 1e-12) && near(p.speed, want[1], 1e-12) && near(p.util, want[2], 1e-12),
    `${JSON.stringify(p)}`);
}
ok('a missing buffs object reads as all-zero, not NaN', (() => {
  const p = buffPercents(undefined);
  return p.shot === 0 && p.speed === 0 && p.util === 0;
})());
ok('totalBoostPct of 3 legendaries is 60%', near(totalBoostPct(buffsFromLoadout([LEG, LEG, LEG])), 0.60, 1e-12));

console.log('\n--- the EXTREME cheat tier is STRONGER than its own cards ---');
{
  // The whole reason the roster carries `buffs` instead of letting the client re-derive them from
  // `loadout`: an extreme bot's boosts are flat and exceed three legendaries. A client that read
  // the cards would under-report it, and the settings panel would lie about the hardest opponent.
  const p = buffPercents(EXTREME_BOT_BUFFS);
  ok('cheat shot boost ~28.6% (> the 20% a legendary gives)', near(p.shot, 1 - 1 / 1.4, 1e-12) && p.shot > 0.20);
  ok('cheat speed boost 30% (> 20%)', near(p.speed, 0.30, 1e-12) && p.speed > 0.20);
  ok('cheat utility boost 35% (> 20%)', near(p.util, 0.35, 1e-12) && p.util > 0.20);
  const total = totalBoostPct(EXTREME_BOT_BUFFS);
  ok('cheat total beats a 3-legendary loadout, so the panel can flag it',
    total > loadoutTotalPct([LEG, LEG, LEG]) + 1e-6, `${(total * 100).toFixed(1)}% vs 60.0%`);
}

console.log('\n--- botSideScalar picks the right side of the ladder ---');
{
  const L = levelAt(8); // enemy 0.82 / partner 0.25
  ok('a bot on a team WITH a human plays at the partner scalar', botSideScalar(L, true) === L.partner);
  ok('an all-bot team plays at the enemy scalar', botSideScalar(L, false) === L.enemy);
  ok('a missing level is 0, not NaN', botSideScalar(null, true) === 0);
}
{
  // The cheat tier must be reachable, and only at the top — otherwise either nobody ever sees it
  // or level 5 bots silently cheat.
  const cheating = DIFFICULTY_LEVELS.filter((L) => L.enemy >= EXTREME_SKILL || L.partner >= EXTREME_SKILL);
  ok('some level reaches the cheat tier', cheating.length > 0);
  ok('only levels 10-11 reach it', cheating.every((L) => L.id >= 10), cheating.map((L) => L.id).join(','));
}

console.log('\n--- skillWord labels track the T stops ---');
ok('T.normal reads רגיל', skillWord(T.normal) === 'רגיל');
ok('T.extreme reads קטלני', skillWord(T.extreme) === 'קטלני');
ok('T.veryEasy reads חלש מאוד', skillWord(T.veryEasy) === 'חלש מאוד');
ok('every ladder level gets a non-empty word for both sides',
  DIFFICULTY_LEVELS.every((L) => skillWord(L.enemy) && skillWord(L.partner)));
ok('out-of-range input is clamped, not blank', skillWord(-5) === 'חלש מאוד' && skillWord(99) === 'קטלני');
ok('a non-number is treated as 0 rather than throwing', skillWord('x') === 'חלש מאוד');

console.log('\n--- PARITY: no second copy of the table anywhere ---');
{
  const server = readFileSync(join(here, 'server.js'), 'utf8');
  ok('server.js imports the shared table', /from '\.\/shared\/bot-buffs\.js'/.test(server));
  ok('server.js no longer defines its own RARITY_BUFF_PCT',
    !/const RARITY_BUFF_PCT\s*=/.test(server));
  ok('server.js no longer defines its own buffsFromLoadout',
    !/function buffsFromLoadout/.test(server));
  ok('the extreme cheat buffs are not re-typed as a literal in server.js',
    !/cardShot:\s*1\.4\s*,\s*speedBuff:\s*1\.30/.test(server));

  const client = readFileSync(join(here, 'public/client.js'), 'utf8');
  const m = client.match(/const HEB_RAR = \{([^}]*)\}/);
  ok('found client.js HEB_RAR to compare against', !!m);
  if (m) {
    // client.js keeps its own album-UI label map; it must agree with the one the panel uses, or
    // the same card reads "אדיר" in the album and something else in the bot readout.
    const heb = {};
    for (const part of m[1].split(',')) {
      const kv = part.match(/(\w+)\s*:\s*'([^']+)'/);
      if (kv) heb[kv[1]] = kv[2];
    }
    ok('the Hebrew rarity labels match client.js exactly',
      Object.keys(RARITY_LABEL_HE).every((k) => heb[k] === RARITY_LABEL_HE[k]),
      JSON.stringify(heb));
  }
}

console.log(failed ? `\n${failed} FAILED` : '\nall bot-buff checks passed');
process.exit(failed ? 1 : 0);
