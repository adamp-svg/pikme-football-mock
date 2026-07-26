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
//
// ---- THE NOISE FLOOR IS NOW MEASURED, AND TWO GATES WERE RE-BASED ON IT (2026-07-26, `bot-noise`)
// `bot-noise.mjs` played this exact configuration 1152 times per anchor (36 independent seed bases,
// committed round-7 bots, default arena, 60s): the per-MATCH goal differential has SD **1.77**, and
// the null cell (t=0.50 vs its own mirror) reads +0.06 +-0.05, i.e. the instrument is UNBIASED.
// So the cell mean's standard error is 1.77/sqrt(n):
//     n=192 (SEEDS=6) -> SE 0.13     n=384 -> 0.09     n=1152 -> 0.052     n=3072 -> 0.032
// Two consequences, both now built in below:
//   * the old `HARNESS ZERO-CHECK ... within +-0.15` was a tolerance of 1.2 SE at SEEDS=6. A perfect,
//     unbiased instrument fails it ~24% of the time, so the 0.16-0.18 readings recorded for round 7
//     were NOT evidence of a biased harness. The tolerance is now 3 SE, computed from the run's own
//     SD and printed. (At SEEDS=6 that is +-0.38; the 2026-07-25 kickoff-parity confound this check
//     exists to catch was worth 0.65-1.31 goals/match, so it is still caught with room to spare.)
//   * a 0.10 goals/match effect needs n = 1248 matches/anchor to reach 2 sigma (SEEDS=39) — you
//     cannot resolve one tier-to-tier step at SEEDS=6, and no amount of re-tuning changes that.
// What SEEDS=6 CAN do is resolve a round-6-sized ladder: measured on a revision whose real spread was
// 1.15 goals/match, the per-seed-base rho read 0.90/0.90/0.90/0.80/0.90/0.70 — stable. When per-base
// rho flips sign it is the ladder that is flat, not the instrument that is blind.
// Seeds are also now COMMON across anchors (see `cell`), which halves the variance of the
// top-vs-bottom gap. Run `node bot-noise.mjs analyze` for the full noise/candidate-statistic table.
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
  const sum = (team, k) => Object.values(s.players).filter((p) => p.team === team).reduce((a, p) => a + ((p.stat && p.stat[k]) || 0), 0);
  for (let t = 0; t < TICKS; t++) {
    const inp = computeBotInputs(s, mem, DT);
    for (const id in inp) if (s.players[id] && s.players[id].team === side && inp[id].fire) shots++;
    step(s, inp, DT);
    const o = s.ball.owner && s.players[s.ball.owner];
    if (o) poss += (o.team === side ? 1 : -1);
  }
  // SAVES are the cheap half of an attacking statistic: `p.stat.saves` counts a defender INSIDE ITS
  // OWN PENALTY AREA catching a kick (sim.js:986), i.e. a shot that arrived and had to be stopped.
  // goals + saves-forced ("shots on goal") therefore counts ~2x the events goal differential does,
  // at no extra sim cost. Measured at 1152 matches/anchor it separates the anchors at 6.0 sigma where
  // bare goals manage 3.0 — it is PRINTED as the attacking companion, never gated (see the bottom).
  return {
    gf: s.score[side], ga: s.score[other], shots, poss: poss * DT, strips: sum(side, 'strips'),
    sogF: s.score[side] + sum(other, 'saves'), sogA: s.score[other] + sum(side, 'saves'),
  };
}

// Run one anchor cell: PER matches, sides AND kickoff balanced, at seed base `base`.
// COMMON RANDOM NUMBERS: the seed is `base + i*17` and NO LONGER carries `Math.round(skill*100)`, so
// every anchor plays the SAME PER scenarios instead of a private stream. Measured over 36 seed bases
// (bot-noise.mjs, `loose` vs `looseCRN`), the SD of the per-base top-vs-bottom gap falls
//   goals 0.410 -> 0.287 · shots-on-goal 0.454 -> 0.314 · xG 0.295 -> 0.210 · territory 76.3 -> 53.3
// i.e. x2.0 equivalent sample size on every goal-family statistic, for free. (It does nothing for
// strips/possession, which are already precise, and it is NOT variance reduction on the rank itself —
// per-base rho barely moved, because rho is limited by how flat the truth is, not by precision.)
// Kickoff and side stay balanced EXACTLY inside the cell, which is what makes the cell mean unbiased:
// measured, kicking off is worth +0.72 vs -0.59 goals/match and being team A +0.16 vs -0.03, so an
// unbalanced cell is the single largest error this harness can make.
// REFUTED, do not re-try: making the four (side x kickoff) combinations share ONE seed (antithetic
// quadruples) is WORSE — 0.410 -> 0.386/0.446 SD, i.e. x0.5-0.6 equivalent sample, because at a
// non-null anchor the four runs are positively correlated rather than mirror-images. It only "helps"
// in the t=0.50 cell, where it forces an EXACT 0.00: with equal skills the same seed on side A and on
// side B is the identical simulation read from both ends, so the quad cancels by arithmetic and tests
// nothing at all.
function cell(skill, base) {
  const acc = { gf: 0, ga: 0, shots: 0, poss: 0, strips: 0, sogF: 0, sogA: 0, kickedOff: 0, onA: 0, d: [] };
  for (let i = 0; i < PER; i++) {
    const side = i % 2 ? 'B' : 'A';
    const kickTo = (i >> 1) % 2 ? 'skill' : 'ref';   // independent of `side` — that is the whole point
    if (kickTo === 'skill') acc.kickedOff++;
    if (side === 'A') acc.onA++;
    const r = match(skill, side, kickTo, base + i * 17);
    acc.gf += r.gf; acc.ga += r.ga; acc.shots += r.shots; acc.poss += r.poss; acc.strips += r.strips;
    acc.sogF += r.sogF; acc.sogA += r.sogA;
    acc.d.push(r.gf - r.ga);   // per-MATCH differentials: the run measures its own noise floor
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

const tot = ANCHORS.map(() => ({ gf: 0, ga: 0, shots: 0, poss: 0, strips: 0, sogF: 0, sogA: 0, kickedOff: 0, onA: 0, d: [] }));
const perBaseRho = [];
for (let s = 0; s < SEEDS; s++) {
  const base = 1000 + s * 1000;
  const d = [];
  ANCHORS.forEach((skill, ai) => {
    const c = cell(skill, base);
    for (const k of Object.keys(c)) { if (k === 'd') tot[ai].d.push(...c.d); else tot[ai][k] += c[k]; }
    d.push((c.gf - c.ga) / PER);
  });
  perBaseRho.push(spearman(ANCHORS, d));
}
// Printed UNCONDITIONALLY: if these disagree wildly, the pooled number is not meaningful either.
// AND READ THE HEADER BEFORE INTERPRETING THEM: at PER=32 a base is 32 matches, i.e. SE 0.31
// goals/match, so these swing hard on a flat ladder and are stable on a real one.
console.log(`per-seed-base rho: ${perBaseRho.map((r) => r.toFixed(2)).join(' / ')}\n`);

const sd = (a) => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const diffs = [], shotD = [], stripD = [], sogD = [], cellSE = [];
ANCHORS.forEach((skill, ai) => {
  const c = tot[ai];
  diffs.push((c.gf - c.ga) / N);
  shotD.push(c.shots / N);
  stripD.push(c.strips / N);
  sogD.push((c.sogF - c.sogA) / N);
  cellSE.push(sd(c.d) / Math.sqrt(N));
  console.log(`  t=${skill.toFixed(2)}  goals ${String(c.gf).padStart(3)} - ${String(c.ga).padStart(3)}  diff/match ${(c.gf - c.ga) / N >= 0 ? '+' : ''}${((c.gf - c.ga) / N).toFixed(2)} +-${(sd(c.d) / Math.sqrt(N)).toFixed(2)}   onGoal/m ${((c.sogF - c.sogA) / N >= 0 ? '+' : '') + ((c.sogF - c.sogA) / N).toFixed(2)}  shots/m ${(c.shots / N).toFixed(1)}  strips/m ${(c.strips / N).toFixed(2)}  poss/m ${(c.poss / N).toFixed(1)}s  kickedOff ${c.kickedOff}/${N}`);
});

// ---- THIS RUN'S OWN NOISE FLOOR ---------------------------------------------------------------
// The t=0.50 anchor IS the self-play control — it plays the t=0.50 reference, so its true value is
// 0.00 by construction. (The old code ran that cell a SECOND time under the name CONTROL with the
// identical seeds and printed the identical number; removing the duplicate is 1/6 of the run, which
// pays for SEEDS=7 at the wall clock SEEDS=6 used to cost.) The floor is not that cell's reading
// though — one reading cannot measure its own error. It is the per-MATCH SD, which every cell reports.
const seNull = cellSE[2];
const seDiff = Math.hypot(cellSE[cellSE.length - 1], cellSE[0]);   // SE of the top-MINUS-bottom gap
console.log(`\n  CONTROL (t=0.50 vs t=0.50, true value 0.00): ${diffs[2] >= 0 ? '+' : ''}${diffs[2].toFixed(2)} goals/match`);
console.log(`  NOISE FLOOR: per-match SD ${sd(tot[2].d).toFixed(2)} goals => cell SE ${seNull.toFixed(3)} at n=${N}; the top-vs-bottom gap carries +-${(1.96 * seDiff).toFixed(2)} (95%).`);
console.log(`      smallest gap this run can call at 3 sigma: ${(3 * seDiff).toFixed(2)} goals/match.  For 0.10 you would need n = ${Math.ceil((2 * sd(tot[2].d) / 0.10) ** 2 / PER) * PER} (SEEDS=${Math.ceil((2 * sd(tot[2].d) / 0.10) ** 2 / PER)}).`);

// HARNESS ZERO-CHECK, deliberately the first gate: the t=0.50 ANCHOR is playing the t=0.50 REFERENCE,
// so its differential must be ~0. RE-BASED 2026-07-26 from a hardcoded +-0.15 to 3 SE, and here is the
// arithmetic rather than a hunch. The per-match SD is ~1.77 goals, so at SEEDS=6 (n=192) the cell's own
// SE is 0.13 and +-0.15 was a 1.2-sigma tolerance: an unbiased instrument fails it about a quarter of
// the time, which is exactly the "red/green light driven by the RNG" §3 of BOT_HANDOFF.md warns about.
// Measured over 1152 matches/anchor the null cell reads +0.06 +-0.05, i.e. NO bias — so the round-7
// readings of 0.16-0.18 were noise, not a broken harness. 3 SE still catches what this gate was built
// for: the 2026-07-25 kickoff-parity confound was worth 0.65-1.31 goals/match (measured: kicking off
// is +0.72 vs -0.59), i.e. 5-10 SE at SEEDS=6. Structural balance is ALSO gated directly below, with
// no noise at all, which is the stronger form of the same check.
ok(Math.abs(diffs[2]) <= 3 * seNull, `HARNESS ZERO-CHECK: the t=0.50 anchor vs its own reference reads ${diffs[2].toFixed(2)}, tolerance 3 SE = +-${(3 * seNull).toFixed(2)} at n=${N} (measures the instrument, not the bots)`);
// STRUCTURAL BALANCE — deterministic, zero-variance, and it is what actually broke in 2026-07-25's
// confound: kickoff parity became a function of the ANCHOR (30/30, 30/30, 0/30, 0/30, 0/30). Gating
// the counts catches that on the first run instead of hoping a noisy mean notices.
{
  const kOk = tot.every((c) => c.kickedOff === N / 2), sOk = tot.every((c) => c.onA === N / 2);
  ok(kOk && sOk, `BALANCE: every anchor kicks off exactly ${N / 2}/${N} and is team A exactly ${N / 2}/${N} (got kickoff ${tot.map((c) => c.kickedOff).join('/')}, sideA ${tot.map((c) => c.onA).join('/')})`);
}

const rho = spearman(ANCHORS, diffs);
ok(rho >= 0.85, `ladder RANKS on goals: pooled Spearman rho = ${rho.toFixed(2)} over ${N} matches/anchor (need >= 0.85)`);
ok(diffs[diffs.length - 1] > diffs[0], `top beats bottom: t=1.00 ${diffs[diffs.length - 1].toFixed(2)} > t=0.05 ${diffs[0].toFixed(2)}`);
// The 0.60 gate is the DESIGN requirement ("the range must be felt") and is unchanged. The 3-SE term
// is a POWER requirement added on top: it can only make this gate stricter, never weaker, and it stops
// a small run from claiming a spread it had no power to measure (at SEEDS=1, 3 SE is ~0.94).
{
  const need = Math.max(0.60, 3 * seDiff);
  const spread = diffs[diffs.length - 1] - diffs[0];
  ok(spread >= need, `the range is FELT: top-vs-bottom spread ${spread.toFixed(2)} goals/match (need >= ${need.toFixed(2)} = max(0.60 design, 3 SE = ${(3 * seDiff).toFixed(2)} statistical))`);
}

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

// ATTACKING COMPANION — SHOTS ON GOAL (goals + saves forced), PRINTED, NEVER GATED. -------------
// The ladder's problem after round 7 is specifically an ATTACKING one: strips rank at rho 1.00 while
// goal differential goes flat, so "the axis is intact" and "the strong tiers can no longer convert"
// are both true. Strips cannot see that; this can, and it counts ~2x the events goals do, so at
// n=1152 it separates the anchors at 6.0 sigma against bare goals' 3.0 (measured -0.86 / -0.52 /
// +0.05 / -0.51 / -0.42, rho 0.70).
// It is NOT gated, and that is a measured decision, not caution: per-seed-base rho over 36 bases ran
// -0.30 to +0.90 (median 0.50). A gate needs a statistic that is stable base to base, and only strips
// (0.90-1.00 in 36/36) and time-to-first-shot (0.80-1.00 in 36/36) are. `bot-noise.mjs` holds the full
// table for 16 candidates — territory, thirds, danger-zone time, xG, entries, ground gained per
// possession — and NONE of the attacking ones is gateable on the current bots, because the attacking
// edge itself is what is missing. Print it, watch its shape, and gate it only when it is stable.
console.log(`      (not gated: shots-on-goal rho ${spearman(ANCHORS, sogD).toFixed(2)} = ${sogD.map((v) => v.toFixed(2)).join(' / ')} — the ATTACKING companion; see bot-noise.mjs)`);

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
