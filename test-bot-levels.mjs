// Do the 12 DIFFICULTY LEVELS get harder FOR THE PLAYER, level by level?
//
// test-bot-ladder.mjs measures the 0..1 skill AXIS. That is not the same question. What a player
// meets is a LEVEL, which sets TWO scalars: how strong the enemy team is AND how good their own
// team-mate is. A level can raise the enemy and simultaneously hand the player a better partner
// and come out EASIER. The shipped table does exactly that — partner swings 0.05 -> 0.68 -> 0.05
// while enemy rises monotonically — so the enemy column being sorted proves nothing.
//
// So this models the real thing: side A = a HUMAN-PROXY (a bot held at a fixed skill, standing in
// for the player) + the level's PARTNER bot. Side B = two ENEMY bots at the level's enemy skill.
// A's goal differential is then a direct measure of player-felt difficulty, and it must FALL as
// the level rises. Needs the per-bot skill override in bot-ai (mem.botSkill), because the two
// bots on side A are deliberately different.
//
// Run: node test-bot-levels.mjs [matchesPerLevel] [secs]   (SEEDS=6 before quoting a number)
import { createState, addPlayer, attachBall, step, makeRng } from './shared/sim.js';
import { DT } from './shared/constants.js';
import { computeBotInputs, createBotMemory } from './shared/bot-ai.js';
import { DIFFICULTY_LEVELS } from './shared/difficulty.js';

const PER = parseInt(process.argv[2] || '16', 10);   // multiple of 4: balances side AND kickoff
const SECS = parseInt(process.argv[3] || '60', 10);
const SEEDS = parseInt(process.env.SEEDS || '2', 10);
if (PER % 4 !== 0) { console.error(`PER must be a multiple of 4 (got ${PER})`); process.exit(2); }
const TICKS = Math.round(SECS / DT);
const HUMAN = 0.55;   // the stand-in for the player: a fixed, decent-but-not-elite opponent

let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };

// One match at `level`. `side` is the player's team; `kickTo` decides who kicks off (independent).
function match(level, side, kickTo, seed) {
  const s = createState();
  s.resetTimer = 0;
  s.rng = makeRng(seed);
  const other = side === 'A' ? 'B' : 'A';
  for (const [id, team, slot] of [['A0', 'A', 0], ['A1', 'A', 1], ['B0', 'B', 0], ['B1', 'B', 1]])
    addPlayer(s, id, { name: id, char: 'player', team, slot, isBot: true });
  attachBall(s, kickTo === 'player' ? side : other);
  const mem = createBotMemory(0.5);
  mem.teamSkill = { [side]: level.partner, [other]: level.enemy };
  // slot 0 on the player's side IS the human-proxy; slot 1 is the partner at the level's skill.
  mem.botSkill = { [`${side}0`]: HUMAN };
  for (let t = 0; t < TICKS; t++) step(s, computeBotInputs(s, mem, DT), DT);
  return s.score[side] - s.score[other];
}

function cell(level, base) {
  let d = 0;
  for (let i = 0; i < PER; i++) {
    d += match(level, i % 2 ? 'B' : 'A', (i >> 1) % 2 ? 'player' : 'enemy', base + i * 17 + level.id * 101);
  }
  return d / PER;
}

const N = PER * SEEDS;
console.log(`=== player-felt difficulty: [human@${HUMAN} + partner] vs [2x enemy], ${N} matches x ${SECS}s per level ===\n`);
const felt = [];
for (const lv of DIFFICULTY_LEVELS) {
  let sum = 0;
  for (let s = 0; s < SEEDS; s++) sum += cell(lv, 1000 + s * 1000);
  const f = sum / SEEDS;
  felt.push(f);
  const bar = f >= 0 ? '+'.repeat(Math.min(20, Math.round(f * 8))) : '-'.repeat(Math.min(20, Math.round(-f * 8)));
  console.log(`  L${String(lv.id).padStart(2)}  enemy ${lv.enemy.toFixed(2)}  partner ${lv.partner.toFixed(2)}   player diff/match ${f >= 0 ? '+' : ''}${f.toFixed(2)}  ${bar}`);
}

// Spearman between level id and felt difficulty. It must be strongly NEGATIVE: higher level =>
// the player does worse.
function spearman(xs, ys) {
  const rank = (a) => { const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = new Array(a.length); idx.forEach(([, i], k) => { r[i] = k; }); return r; };
  const rx = rank(xs), ry = rank(ys), n = xs.length;
  let d2 = 0; for (let i = 0; i < n; i++) d2 += (rx[i] - ry[i]) ** 2;
  return 1 - (6 * d2) / (n * (n * n - 1));
}
const rho = spearman(DIFFICULTY_LEVELS.map((l) => l.id), felt);
console.log(`\n  per-level Spearman(level, felt) = ${rho.toFixed(2)}  (printed, NOT gated — see below)`);

// ---- WHAT THIS TEST CAN AND CANNOT PROVE ---------------------------------------------------
// It CANNOT resolve adjacent levels, and pretending otherwise produced two bad re-cuts.
// Adjacent levels differ by ~0.09 of enemy skill, worth roughly 0.05 goals/match. The noise floor
// here is 0.3-0.4 goals/match even at 96 matches/level (measured: identical code gave L0 = +0.22,
// then -0.29 on a re-run after a 0.05 partner change). So a per-level Spearman gate was demanding
// a signal an order of magnitude below the noise, and "fixing" it just chased randomness — the
// same mistake the ladder harness made before it was rebuilt.
// It CAN resolve: the structural invariants, the endpoints, and 3-level BANDS (3x the sample, and
// closer to what a player notices — early game vs late game, not level 6 vs level 7).
// If you want per-level resolution you need a fundamentally cheaper signal than goals; strips
// separated the skill axis at rho 1.00 in test-bot-ladder.mjs and would be the place to start.

// (1) STRUCTURE — cheap, exact, and it is what actually broke last time. The old table's L2 had
// partner 0.68 against enemy 0.25: the helper was 2.7x the opposition, which made L2 the EASIEST
// LEVEL IN THE GAME (+0.75 vs L0's +0.22). That defect is gross enough to be measurable, so it is
// worth a hard gate that no future retune can trip over.
{
  const e = DIFFICULTY_LEVELS.map((l) => l.enemy), pa = DIFFICULTY_LEVELS.map((l) => l.partner);
  ok(e.every((v, i) => i === 0 || v > e[i - 1]), `enemy skill STRICTLY rises every level (${e[0]} -> ${e[e.length - 1]})`);
  let maxRatio = 0, at = -1;
  for (let i = 0; i < e.length; i++) { const r = pa[i] / Math.max(0.01, e[i]); if (r > maxRatio) { maxRatio = r; at = i; } }
  ok(maxRatio <= 2.0, `no level hands the player a partner that dwarfs the enemy: worst is L${at} at ${maxRatio.toFixed(1)}x (allow <= 2.0; the old L2 was 2.7x and was the easiest level in the game)`);
  // the partner must never out-climb the enemy across the table, or difficulty cancels itself out
  ok(pa[pa.length - 1] - pa[0] < e[e.length - 1] - e[0], `the enemy out-grows the partner overall (enemy +${(e[e.length - 1] - e[0]).toFixed(2)} vs partner +${(pa[pa.length - 1] - pa[0]).toFixed(2)})`);
}

// (2) BANDS — 3 levels pooled, which is 3x the sample and the comparison a player actually feels.
{
  const band = (a, b) => felt.slice(a, b).reduce((x, y) => x + y, 0) / (b - a);
  const early = band(0, 4), mid = band(4, 8), late = band(8, 12);
  console.log(`  bands: early(L0-3) ${early >= 0 ? '+' : ''}${early.toFixed(2)}   mid(L4-7) ${mid >= 0 ? '+' : ''}${mid.toFixed(2)}   late(L8-11) ${late >= 0 ? '+' : ''}${late.toFixed(2)}`);
  // PRINTED, NOT GATED — and this is a deliberate admission, not a convenience. Even pooled 4
  // levels deep the bands land inside the noise (measured early -0.21 vs late -0.20). Gating on
  // that would mean a red/green light driven by the RNG, and I would have spent the next hour
  // "fixing" the table until the dice agreed. The structural gates above are the real protection.
  console.log(`         (bands are printed, NOT gated: the spread between them is smaller than this harness's own noise floor)`);
}

// (3) ENDPOINTS — the widest comparison available, and still only a tripwire. L0 vs L11 is a
// 0.95 gap in enemy skill, but a re-run after changing ONLY L0's partner by 0.05 moved L0 from
// +0.22 to -0.25, so even this is not reliably resolvable at any sample size I can afford here.
console.log(`  endpoints: L0 ${felt[0] >= 0 ? '+' : ''}${felt[0].toFixed(2)}  vs  L11 ${felt[felt.length - 1] >= 0 ? '+' : ''}${felt[felt.length - 1].toFixed(2)}  ${felt[0] > felt[felt.length - 1] ? '(ordered correctly)' : '(NOT ordered — investigate if this persists across seeds)'}`);

console.log(`\n${fails === 0 ? '✅ ALL PASS' : '❌ ' + fails + ' FAILED'}`);
process.exit(fails === 0 ? 0 : 1);
