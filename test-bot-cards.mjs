// shared/bot-buffs.js — the LEVEL → BOT CARDS model, and the promise the difficulty ladder makes
// about it. Run: node test-bot-cards.mjs
//
// WHY THIS TEST EXISTS. OPEN_ITEMS P1 #4 was filed as "bot rarity mirroring is probabilistic — a
// single-legendary human often faces a bot showing rare/common". That framing is obsolete: bot cards
// stopped being derived from the human's album when the XP-driven ladder landed, and the mirroring
// path (`botLoadoutParamsFromHumans`/`randomBotLoadout`) is now dead code. The REAL defect underneath
// the complaint is that per-slot independent sampling gave each level an UNBOUNDED card-power range,
// so the ladder lied. Measured on the pre-fix model (200k rolls/level):
//
//   • a level-8 bot rolled the full 3-legendary loadout 15.9% of the time, a level-7 bot 2.8%,
//     a level-5 bot 0.2% — the top-of-ladder visual, at the middle of the ladder
//   • a level-2 bot out-carded a level-5 bot 11.4% of the time (worst L-vs-L+3 pair)
//   • a level-2 bot's total ranged 0.03 … 0.600 — the same ceiling as "קטלני" at L10
//
// So: a per-level BAND on total card power, and the ladder's promise asserted here.
import assert from 'node:assert';
import {
  RARITY_BUFF_PCT, RARITY_BY_LEVEL, CARD_POWER_BAND, RARITY_LADDER,
  botLoadoutForLevel, loadoutTotalPct, maxRarityForLevel,
} from './shared/bot-buffs.js';
import { DIFFICULTY_LEVELS, clampLevel } from './shared/difficulty.js';

let fails = 0;
const ok = (name, cond, detail) => {
  if (cond) console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`);
  else { console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); fails++; }
};
// Card pcts are 2-decimal constants (0.03/0.07/0.12/0.20); summing three of them in binary floats
// gives 0.09999999999999999. Every comparison here is in integer basis points instead.
const bp = (x) => Math.round(x * 100);
const totalBp = (loadout) => bp(loadoutTotalPct(loadout));
const topRarityIdx = (loadout) =>
  loadout.reduce((m, s) => (s ? Math.max(m, RARITY_LADDER.indexOf(s.r)) : m), -1);

// Deterministic RNG so a red here is reproducible (same trick as bot-eval.mjs's seeded mode, 228935f).
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

console.log('── §1 the module shape ───────────────────────────────────────────────────────');
ok('RARITY_LADDER is weakest→strongest and covers every buffed rarity',
  RARITY_LADDER.length === 4 && RARITY_LADDER.every((r, i) =>
    i === 0 || RARITY_BUFF_PCT[r] > RARITY_BUFF_PCT[RARITY_LADDER[i - 1]]),
  RARITY_LADDER.join('<'));
ok('...and it holds exactly the keys of RARITY_BUFF_PCT — a new rarity cannot be added to one only',
  [...RARITY_LADDER].sort().join() === Object.keys(RARITY_BUFF_PCT).sort().join());
ok('there is one RARITY_BY_LEVEL row per difficulty level',
  RARITY_BY_LEVEL.length === DIFFICULTY_LEVELS.length, `${RARITY_BY_LEVEL.length} rows / ${DIFFICULTY_LEVELS.length} levels`);
ok('there is one CARD_POWER_BAND row per difficulty level',
  CARD_POWER_BAND.length === DIFFICULTY_LEVELS.length, `${CARD_POWER_BAND.length} rows`);
ok('server.js no longer keeps its own copy of the level→rarity table',
  !/^const RARITY_BY_LEVEL = \[/m.test(await (await import('node:fs/promises')).readFile('./server.js', 'utf8')),
  'two hand-copied tables is exactly what shared/bot-buffs.js exists to prevent');

console.log('\n── §2 the BANDS are a well-formed ladder ─────────────────────────────────────');
// A band whose top is below an earlier level's top would BUILD an inversion instead of removing one.
let monoHi = true, monoLo = true;
for (let L = 1; L < CARD_POWER_BAND.length; L++) {
  if (bp(CARD_POWER_BAND[L][1]) < bp(CARD_POWER_BAND[L - 1][1])) monoHi = false;
  if (bp(CARD_POWER_BAND[L][0]) < bp(CARD_POWER_BAND[L - 1][0])) monoLo = false;
}
ok('band CEILINGS never go down as the level goes up', monoHi,
  CARD_POWER_BAND.map((b) => b[1].toFixed(2)).join(' '));
ok('band FLOORS never go down as the level goes up', monoLo,
  CARD_POWER_BAND.map((b) => b[0].toFixed(2)).join(' '));
ok('every band is lo <= hi', CARD_POWER_BAND.every(([lo, hi]) => bp(lo) <= bp(hi)));

// The repair loop walks one rarity step at a time. If a band were NARROWER than the widest single
// step (legendary→epic = 8bp) a repair could jump clean over the band and never land inside it.
const WIDEST_STEP_BP = Math.max(...RARITY_LADDER.slice(1).map((r, i) =>
  bp(RARITY_BUFF_PCT[r]) - bp(RARITY_BUFF_PCT[RARITY_LADDER[i]])));
ok(`the widest single rarity step is ${WIDEST_STEP_BP}bp (legendary→epic)`, WIDEST_STEP_BP === 8);
const narrow = CARD_POWER_BAND
  .map((b, L) => ({ L, w: bp(b[1]) - bp(b[0]), fixed: RARITY_BY_LEVEL[L].leg >= 3 }))
  .filter((x) => x.w < WIDEST_STEP_BP && !x.fixed);
ok('no band is narrower than one rarity step (except the fixed 3-legendary top levels)',
  narrow.length === 0, narrow.map((x) => `L${x.L} w=${x.w}bp`).join(' ') || 'all wide enough');

console.log('\n── §3 THE LADDER\'S PROMISE — every roll lands inside its level\'s band ────────');
const N = 20000;
const stats = [];
for (let L = 0; L < DIFFICULTY_LEVELS.length; L++) {
  const rng = mulberry32(0xC0FFEE + L);
  let outside = 0, sum = 0, min = 999, max = -1, threeLeg = 0, worst = null;
  const shapes = new Set();
  for (let i = 0; i < N; i++) {
    const lo = botLoadoutForLevel(L, rng);
    const t = totalBp(lo);
    if (t < bp(CARD_POWER_BAND[L][0]) || t > bp(CARD_POWER_BAND[L][1])) { outside++; if (!worst) worst = lo; }
    sum += t; min = Math.min(min, t); max = Math.max(max, t);
    if (t === 60) threeLeg++;
    shapes.add(lo.map((s) => (s ? s.r[0] : '-')).sort().join(''));
  }
  stats.push({ L, mean: sum / N / 100, min: min / 100, max: max / 100, threeLeg, shapes: shapes.size });
  ok(`L${L}: all ${N} rolls inside [${CARD_POWER_BAND[L][0].toFixed(2)}, ${CARD_POWER_BAND[L][1].toFixed(2)}]`,
    outside === 0, outside ? `${outside} outside, e.g. ${JSON.stringify(worst)}` : `observed ${(min / 100).toFixed(2)}…${(max / 100).toFixed(2)}`);
}

console.log('\n── §4 no impostors: the 3-legendary loadout is reserved for the top ──────────');
// 0.60 total == three legendaries == what the EXTREME cheat tier shows. Below L9 that visual is a
// lie about the level, and it is the loudest form of it because the VS/countdown screen draws the cards.
for (const s of stats) {
  if (RARITY_BY_LEVEL[s.L].leg >= 2) {
    ok(`L${s.L} MAY show 3 legendaries (leg=${RARITY_BY_LEVEL[s.L].leg} guarantees ≥2)`, s.threeLeg > 0,
      `${((s.threeLeg / N) * 100).toFixed(1)}% of rolls`);
  } else {
    ok(`L${s.L} never shows 3 legendaries`, s.threeLeg === 0,
      s.threeLeg ? `${((s.threeLeg / N) * 100).toFixed(2)}% of rolls did` : 'none in 20k');
  }
}

console.log('\n── §5 the band TRIMS TAILS, it does not retune bot power ─────────────────────');
// Pre-fix means, measured at HEAD over 200k rolls/level (scratch harness, model copied verbatim from
// server.js:1039-1080). The band must not move the middle of the distribution — if it does, it has
// silently made bots stronger or weaker, which is a balance change and needs the user, not a bug fix.
const HEAD_MEAN = [0.040, 0.072, 0.121, 0.184, 0.224, 0.261, 0.341, 0.386, 0.490, 0.560, 0.600, 0.600];
let drifted = [];
for (const s of stats) {
  const d = Math.abs(s.mean - HEAD_MEAN[s.L]);
  if (d > 0.02) drifted.push(`L${s.L} ${HEAD_MEAN[s.L].toFixed(3)}→${s.mean.toFixed(3)}`);
}
ok('mean card power per level is within 0.02 of the pre-fix model at every level',
  drifted.length === 0, drifted.join(' ') || stats.map((s) => s.mean.toFixed(3)).join(' '));

console.log('\n── §6 variety survives — a bot is close-but-different, not a clone ───────────');
// The whole reason this is a BAND and not a fixed loadout per level: two bots at the same level must
// not be identical, or the countdown reveal stops being worth looking at.
for (const L of [2, 5, 7]) {
  ok(`L${L} still produces many distinct rarity shapes`, stats[L].shapes >= 5,
    `${stats[L].shapes} shapes in ${N} rolls`);
}
ok('a bot loadout is NOT a copy of the human\'s — the model never reads a human album',
  botLoadoutForLevel.length <= 2, `botLoadoutForLevel(level, rng) takes ${botLoadoutForLevel.length} args, no roster`);

console.log('\n── §7 invariants the sim and the UI already rely on ──────────────────────────');
let shape = true, nums = true, fillRule = true, legKept = true;
for (let L = 0; L < DIFFICULTY_LEVELS.length; L++) {
  const rng = mulberry32(1234 + L);
  for (let i = 0; i < 5000; i++) {
    const lo = botLoadoutForLevel(L, rng);
    if (!Array.isArray(lo) || lo.length !== 3) { shape = false; break; }
    for (const s of lo) {
      if (s === null) continue;
      if (!RARITY_LADDER.includes(s.r)) shape = false;
      if (!Number.isInteger(s.n) || s.n < 1 || s.n > 50) nums = false;
    }
    // "make sense" rule: you cannot hold better than rare AND have an empty slot.
    if (topRarityIdx(lo) > RARITY_LADDER.indexOf('rare') && lo.some((s) => !s)) fillRule = false;
    // A level that GUARANTEES legendaries must still show them — repair must never eat a guarantee.
    const legs = lo.filter((s) => s && s.r === 'legendary').length;
    if (legs < RARITY_BY_LEVEL[L].leg) legKept = false;
  }
}
ok('always a 3-slot array of {r,n}|null with a known rarity', shape);
ok('card numbers stay in the real album range 1..50', nums);
ok('no empty slot while holding better than rare', fillRule);
ok('a level\'s guaranteed legendaries are never demoted away by the band repair', legKept);
ok('maxRarityForLevel never exceeds legendary and never undershoots a guarantee',
  DIFFICULTY_LEVELS.every((_, L) => {
    const cap = maxRarityForLevel(L);
    return cap >= 0 && cap <= 3 && (RARITY_BY_LEVEL[L].leg === 0 || cap === 3);
  }),
  DIFFICULTY_LEVELS.map((_, L) => RARITY_LADDER[maxRarityForLevel(L)][0]).join(''));

console.log('\n── §8 determinism + defensive inputs ─────────────────────────────────────────');
const a = [], b = [];
{ const r = mulberry32(99); for (let i = 0; i < 40; i++) a.push(JSON.stringify(botLoadoutForLevel(5, r))); }
{ const r = mulberry32(99); for (let i = 0; i < 40; i++) b.push(JSON.stringify(botLoadoutForLevel(5, r))); }
ok('same seed → byte-identical sequence (so a red here is reproducible)', a.join() === b.join());
ok('a different seed → a different sequence (the rng is actually consumed)',
  a.join() !== (() => { const r = mulberry32(7); return Array.from({ length: 40 }, () => JSON.stringify(botLoadoutForLevel(5, r))).join(); })());
ok('an out-of-range level clamps instead of throwing',
  totalBp(botLoadoutForLevel(-5)) === totalBp(botLoadoutForLevel(0)) ||
  bp(CARD_POWER_BAND[0][0]) <= totalBp(botLoadoutForLevel(-5)));
ok('a junk level clamps to the default rather than crashing',
  Array.isArray(botLoadoutForLevel('nonsense')) && botLoadoutForLevel(undefined).length === 3);
ok('level 99 clamps to the top of the ladder (3 legendaries)',
  botLoadoutForLevel(99).every((s) => s && s.r === 'legendary'));
ok('no rng argument still works (defaults to Math.random)',
  botLoadoutForLevel(clampLevel(6)).length === 3);

console.log('\n── measured board ───────────────────────────────────────────────────────────');
console.log('  L   band         mean    observed      shapes  3-leg%');
for (const s of stats) {
  console.log(`  ${String(s.L).padEnd(2)}  [${CARD_POWER_BAND[s.L][0].toFixed(2)},${CARD_POWER_BAND[s.L][1].toFixed(2)}]  ` +
    `${s.mean.toFixed(3)}   ${s.min.toFixed(2)}…${s.max.toFixed(2)}     ${String(s.shapes).padStart(2)}     ${((s.threeLeg / N) * 100).toFixed(1)}`);
}

console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL PASS — bot cards');
assert.equal(fails, 0);
process.exit(fails ? 1 : 0);
