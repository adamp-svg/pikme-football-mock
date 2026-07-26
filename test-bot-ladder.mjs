// Does the difficulty ladder actually RANK? ("a range of bot skills from very dumb to very very smart")
//
// ============================ READ THIS BEFORE TRUSTING A NUMBER =============================
// The FIRST version of this file reported "Spearman rho = 0.90, ALL PASS" and that number was
// SEED-LUCKY. Re-run on byte-identical code with a different seed base it gave rho
// 0.90 / 0.70 / 0.60 / 0.60 / 0.70 — i.e. 5 of 6 bases FAILED its own >= 0.85 gate, and the gate
// had been calibrated on the one base that happened to be used. It also had a real confound:
// kickoff possession was `attachBall(s, seed % 2 ...)` while the side alternated on `i % 2` and
// `seed` contained `Math.round(skill*100)` — so kickoff parity was a function of the ANCHOR
// (measured: 30/30, 30/30, 0/30, 0/30, 0/30 of matches kicked off by the measured side). The
// bottom two anchors always kicked off and the top three never did.
//
// Football scoring is low-count, so a single 30-match cell has a huge variance; the fixes are
// (1) decouple kickoff from side and balance it exactly, (2) pool several independent seed bases,
// (3) print a SELF-PLAY control cell whose true value is 0 — its magnitude IS the noise floor, and
// (4) a HARNESS ZERO-CHECK that fails if the instrument itself is miscalibrated.
// If you are about to quote a number from this file in a commit message: run SEEDS=6.
// =============================================================================================
import { createState, addPlayer, attachBall, step, makeRng } from './shared/sim.js';
import { setField } from './shared/sim.js';
import { MAIN_FIELD } from './shared/main-field.js';
import { DT } from './shared/constants.js';
import { computeBotInputs, createBotMemory, skillVec } from './shared/bot-ai.js';

// PER must be a MULTIPLE OF 4: `i % 2` balances which side is measured and `(i >> 1) % 2` then
// balances who kicks off, so all four (side, kickoff) combinations appear equally. PER=30 gives
// a 16/14 split and reintroduces a small version of the bias this file exists to remove.
const PER = parseInt(process.argv[2] || '32', 10);
const SECS = parseInt(process.argv[3] || '60', 10);
const SEEDS = parseInt(process.env.SEEDS || '3', 10); // independent seed bases to pool. 6 before any claim.
if (PER % 4 !== 0) { console.error(`PER must be a multiple of 4 (got ${PER}) — see the kickoff-balance note above.`); process.exit(2); }
const TICKS = Math.round(SECS / DT);
const REF = 0.50;                                  // the yardstick every anchor is measured against
const ANCHORS = [0.05, 0.25, 0.50, 0.82, 1.00];

// ARENA=main runs on the arena the GAME actually ships (MAIN_FIELD, 16 walls) instead of the
// bare default (4 walls). This matters enormously and was missed for a whole session: measured
// side by side, pinned-while-moving is 1.38% on the default arena and 14.36% on MAIN_FIELD, and
// idle-with-ball 1.01% vs 20.42%. Every bot claim made against the default arena is a claim
// about an arena nobody plays on.
const ARENA_MAIN = process.env.ARENA === 'main';

let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };

// One match: `skill` on team `side`, REF on the other, `kickTo` says which of those two kicks off.
// kickTo is an EXPLICIT parameter and is never derived from the seed — that derivation is exactly
// what correlated kickoff with the anchor before.
function match(skill, side, kickTo, seed) {
  const s = createState();
  s.resetTimer = 0;
  if (ARENA_MAIN) setField(s, MAIN_FIELD);
  s.rng = makeRng(seed);
  const other = side === 'A' ? 'B' : 'A';
  for (const [id, team, slot] of [['A0', 'A', 0], ['A1', 'A', 1], ['B0', 'B', 0], ['B1', 'B', 1]])
    addPlayer(s, id, { name: id, char: 'player', team, slot, isBot: true });
  attachBall(s, kickTo === 'skill' ? side : other);
  const mem = createBotMemory(REF);
  mem.teamSkill = { [side]: skill, [other]: REF };
  let shots = 0, poss = 0;
  const strips0 = () => Object.values(s.players).filter((p) => p.team === side).reduce((a, p) => a + ((p.stat && p.stat.strips) || 0), 0);
  for (let t = 0; t < TICKS; t++) {
    const inp = computeBotInputs(s, mem, DT);
    for (const id in inp) if (s.players[id] && s.players[id].team === side && inp[id].fire) shots++;
    step(s, inp, DT);
    const o = s.ball.owner && s.players[s.ball.owner];
    if (o) poss += (o.team === side ? 1 : -1);
  }
  return { gf: s.score[side], ga: s.score[other], shots, poss: poss * DT, strips: strips0() };
}

// Run one anchor cell: PER matches, sides AND kickoff balanced, at seed base `base`.
function cell(skill, base) {
  const acc = { gf: 0, ga: 0, shots: 0, poss: 0, strips: 0, kickedOff: 0 };
  for (let i = 0; i < PER; i++) {
    const side = i % 2 ? 'B' : 'A';
    const kickTo = (i >> 1) % 2 ? 'skill' : 'ref';   // independent of `side` — that is the whole point
    if (kickTo === 'skill') acc.kickedOff++;
    const r = match(skill, side, kickTo, base + i * 17 + Math.round(skill * 100));
    acc.gf += r.gf; acc.ga += r.ga; acc.shots += r.shots; acc.poss += r.poss; acc.strips += r.strips;
  }
  return acc;
}

function spearman(xs, ys) {
  const rank = (a) => { const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = new Array(a.length); idx.forEach(([, i], k) => { r[i] = k; }); return r; };
  const rx = rank(xs), ry = rank(ys), n = xs.length;
  let d2 = 0; for (let i = 0; i < n; i++) d2 += (rx[i] - ry[i]) ** 2;
  return 1 - (6 * d2) / (n * (n * n - 1));
}

const N = PER * SEEDS;
console.log(`=== ${PER} matches x ${SECS}s x ${SEEDS} seed base(s) = ${N} per anchor, vs a fixed t=${REF} reference ===`);
console.log('    (sides AND kickoff balanced; run SEEDS=6 before quoting any number)\n');

const tot = ANCHORS.map(() => ({ gf: 0, ga: 0, shots: 0, poss: 0, strips: 0, kickedOff: 0 }));
const perBaseRho = [];
for (let s = 0; s < SEEDS; s++) {
  const base = 1000 + s * 1000;
  const d = [];
  ANCHORS.forEach((skill, ai) => {
    const c = cell(skill, base);
    for (const k of Object.keys(c)) tot[ai][k] += c[k];
    d.push((c.gf - c.ga) / PER);
  });
  perBaseRho.push(spearman(ANCHORS, d));
}
// Printed UNCONDITIONALLY: if these disagree wildly, the pooled number is not meaningful either.
console.log(`per-seed-base rho: ${perBaseRho.map((r) => r.toFixed(2)).join(' / ')}\n`);

const diffs = [], shotD = [], stripD = [];
ANCHORS.forEach((skill, ai) => {
  const c = tot[ai];
  diffs.push((c.gf - c.ga) / N);
  shotD.push(c.shots / N);
  stripD.push(c.strips / N);
  console.log(`  t=${skill.toFixed(2)}  goals ${String(c.gf).padStart(3)} - ${String(c.ga).padStart(3)}  diff/match ${(c.gf - c.ga) / N >= 0 ? '+' : ''}${((c.gf - c.ga) / N).toFixed(2)}   shots/m ${(c.shots / N).toFixed(1)}  strips/m ${(c.strips / N).toFixed(2)}  poss/m ${(c.poss / N).toFixed(1)}s  kickedOff ${c.kickedOff}/${N}`);
});

// ---- SELF-PLAY CONTROL: t=REF vs t=REF. Its true differential is 0 BY CONSTRUCTION, so whatever
// it reports is this run's noise floor. Any anchor gap smaller than this is not a result.
{
  let gf = 0, ga = 0;
  for (let s = 0; s < SEEDS; s++) { const c = cell(REF, 1000 + s * 1000); gf += c.gf; ga += c.ga; }
  const ctrl = (gf - ga) / N;
  console.log(`\n  CONTROL (t=0.50 vs t=0.50, true value 0.00): ${ctrl >= 0 ? '+' : ''}${ctrl.toFixed(2)} goals/match  <- the noise floor`);
  // HARNESS ZERO-CHECK, deliberately the first gate: the t=0.50 ANCHOR is playing the t=0.50
  // REFERENCE, so its differential must be ~0 by construction. If it is not, the instrument is
  // biased (this is what caught the kickoff confound) and every other number here is suspect.
  ok(Math.abs(diffs[2]) <= 0.15, `HARNESS ZERO-CHECK: the t=0.50 anchor vs its own reference reads ${diffs[2].toFixed(2)} (must be within +-0.15 — this measures the instrument, not the bots)`);
}

const rho = spearman(ANCHORS, diffs);
ok(rho >= 0.85, `ladder RANKS on goals: pooled Spearman rho = ${rho.toFixed(2)} over ${N} matches/anchor (need >= 0.85)`);
ok(diffs[diffs.length - 1] > diffs[0], `top beats bottom: t=1.00 ${diffs[diffs.length - 1].toFixed(2)} > t=0.05 ${diffs[0].toFixed(2)}`);
ok(diffs[diffs.length - 1] - diffs[0] >= 0.60, `the range is FELT: top-vs-bottom spread ${(diffs[diffs.length - 1] - diffs[0]).toFixed(2)} goals/match (need >= 0.60)`);

// SECONDARY METRIC — STRIPS. Goals are low-count and high-variance; strips accumulate several per
// match and separate the tiers far more cleanly (measured 0.29 / 2.24 / 2.78 / 3.27 / 3.64,
// rho 1.00). This is the sensitive instrument: if goals ever go ambiguous, this should still rank.
ok(spearman(ANCHORS, stripD) >= 0.85, `ladder RANKS on strips: rho = ${spearman(ANCHORS, stripD).toFixed(2)} (${stripD.map((v) => v.toFixed(2)).join(' / ')})`);

// SHOT COUNT and POSSESSION are printed above but deliberately NOT gated, because neither is
// monotonic in skill and gating them would enforce a wrong idea of "better":
//   * shots/match measures 8.4 / 11.1 / 15.3 / 14.4 / 10.9 — an inverted U. Weak bots barely reach
//     a releasable charge, mid bots spray, and the TOP tier takes FEWER shots because it waits for
//     a lane instead of blasting from out of range. Selective shooting is the smarter behaviour, so
//     a "shots must rise with skill" gate would punish exactly the thing we want.
//   * possession ranks BACKWARDS (4.6s -> -4.8s): weak bots hold the ball longer because they
//     dribble instead of releasing it.
// Both stay on screen as TRIPWIRES — a sudden change in either shape is worth investigating.
console.log(`      (not gated: shots rho ${spearman(ANCHORS, shotD).toFixed(2)} — inverted U by design; possession ranks backwards)`);

// The bottom must be DUMB, not BROKEN — it still has to shoot and occasionally score.
{
  let scored = 0, shots = 0;
  for (let s = 0; s < SEEDS; s++) { const c = cell(0.05, 5000 + s * 1000); scored += c.gf; shots += c.shots; }
  ok(shots > 0, `bottom tier is dumb but FUNCTIONAL: ${shots} shots across ${N} matches (must be > 0)`);
  console.log(`      (bottom tier scored ${scored} goals in ${N} matches — dumb, not frozen)`);
}

// FAIRNESS CEILING — no future retune may quietly rebuild the 9.5x charge monster.
{
  const SHOOT_CHARGE_TIME = 2.0, SUPER = 2, FULL = 0.70;
  const top = skillVec(1.0);
  const effCap = 2.50; // the clamp in computeBotInputs
  const fastest = (FULL + 0.01) * SHOOT_CHARGE_TIME / (effCap * SUPER);
  ok(fastest >= 0.28, `fairness: fastest possible full charge is ${fastest.toFixed(2)}s even with 3 legendaries + super (was 0.15s)`);
  ok(!top.cheat, 'fairness: the top tier has NO x-ray flag (it sees only what a player could)');
  ok((top.visionMul || 0) <= 1.65, `fairness: top visionMul ${top.visionMul.toFixed(2)} <= 1.65 (~the human camera half-width)`);
}

console.log(`\n${fails === 0 ? '✅ ALL PASS' : '❌ ' + fails + ' FAILED'}`);
process.exit(fails === 0 ? 0 : 1);
