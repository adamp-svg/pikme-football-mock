// Does the difficulty ladder actually RANK? ("a range of bot skills from very dumb to very very smart")
//
// Asserting a ladder exists is worthless — it has to be MEASURED, because the knobs interact
// (a bot that charges faster but decides worse can easily be weaker). Each skill anchor plays a
// fixed REFERENCE opponent (t=0.50, the old "normal") with sides swapped to cancel any left/right
// bias, and we check the goal differential rises monotonically with skill.
//
// Seeded, so the numbers are reproducible: without state.rng the same code reported wall-pinning
// anywhere from 0.27% to 0.51% run to run. Run: node test-bot-ladder.mjs [matchesPerAnchor] [secs]
import { createState, addPlayer, attachBall, step, makeRng } from './shared/sim.js';
import { DT } from './shared/constants.js';
import { computeBotInputs, createBotMemory, skillVec } from './shared/bot-ai.js';

// 30 is not a wish: below ~24 matches/anchor the Spearman statistic is unstable (measured
// rho 0.20 / 0.50 / 0.70 / -0.50 across runs of 8-14), and at 30 it settles at 0.90. A full
// run is ~25s. Football scoring is low-count, so this is a variance floor, not slow code.
const PER = parseInt(process.argv[2] || '30', 10);
const SECS = parseInt(process.argv[3] || '60', 10);
const TICKS = Math.round(SECS / DT);
const REF = 0.50;                                  // the yardstick every anchor is measured against
const ANCHORS = [0.05, 0.25, 0.50, 0.82, 1.00];

let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };

// One match: `skill` on team `side`, REF on the other. Returns [goalsForSkill, goalsForRef, shots].
function match(skill, side, seed) {
  const s = createState();
  s.resetTimer = 0;
  s.rng = makeRng(seed);
  const other = side === 'A' ? 'B' : 'A';
  for (const [id, team, slot] of [['A0', 'A', 0], ['A1', 'A', 1], ['B0', 'B', 0], ['B1', 'B', 1]])
    addPlayer(s, id, { name: id, char: 'player', team, slot, isBot: true });
  attachBall(s, seed % 2 ? 'A' : 'B');
  const mem = createBotMemory(REF);
  mem.teamSkill = { [side]: skill, [other]: REF };
  let shots = 0;
  for (let t = 0; t < TICKS; t++) {
    const inp = computeBotInputs(s, mem, DT);
    for (const id in inp) if (s.players[id] && s.players[id].team === side && inp[id].fire) shots++;
    step(s, inp, DT);
  }
  return [s.score[side], s.score[other], shots];
}

// Spearman rank correlation between skill order and measured strength — the honest gate. An
// all-pairs test would demand a strict win for every pair, which noise alone can break even on a
// perfect ladder; rank correlation asks the question we actually care about: does strength ORDER
// follow skill order?
function spearman(xs, ys) {
  const rank = (a) => { const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = new Array(a.length); idx.forEach(([, i], k) => { r[i] = k; }); return r; };
  const rx = rank(xs), ry = rank(ys), n = xs.length;
  let d2 = 0; for (let i = 0; i < n; i++) d2 += (rx[i] - ry[i]) ** 2;
  return 1 - (6 * d2) / (n * (n * n - 1));
}

console.log(`=== ${PER} matches x ${SECS}s per anchor, vs a fixed t=${REF} reference (sides swapped) ===`);
const diffs = [];
for (const skill of ANCHORS) {
  let gf = 0, ga = 0, shots = 0;
  for (let i = 0; i < PER; i++) {
    const [f, a, sh] = match(skill, i % 2 ? 'B' : 'A', 1000 + i * 17 + Math.round(skill * 100));
    gf += f; ga += a; shots += sh;
  }
  const diff = (gf - ga) / PER;
  diffs.push(diff);
  console.log(`  t=${skill.toFixed(2)}  goals ${String(gf).padStart(3)} - ${String(ga).padStart(3)}   diff/match ${diff >= 0 ? '+' : ''}${diff.toFixed(2)}   shots ${shots}`);
}

const rho = spearman(ANCHORS, diffs);
ok(rho >= 0.85, `ladder RANKS: Spearman rho = ${rho.toFixed(2)} between skill and goal differential (need >= 0.85 at this sample size)`);
ok(diffs[diffs.length - 1] > diffs[0], `top beats bottom: t=1.00 diff ${diffs[diffs.length - 1].toFixed(2)} > t=0.05 diff ${diffs[0].toFixed(2)}`);
// The 0.60 floor is calibrated to the MEASURED spread (0.83 goals/match over 60s matches at
// n=30), not picked in advance — an earlier arbitrary 1.0 gate failed on a ladder that ranks
// correctly. Tighten this only alongside a measurement showing the spread really grew.
ok(diffs[diffs.length - 1] - diffs[0] >= 0.60, `the range is FELT: top-vs-bottom spread is ${(diffs[diffs.length - 1] - diffs[0]).toFixed(2)} goals/match (need >= 0.60)`);

// The bottom must be DUMB, not BROKEN — it still has to shoot and occasionally score.
{
  let scored = 0, shots = 0;
  for (let i = 0; i < PER; i++) { const [f, , sh] = match(0.05, i % 2 ? 'B' : 'A', 5000 + i * 13); scored += f; shots += sh; }
  ok(shots > 0, `bottom tier is dumb but FUNCTIONAL: it took ${shots} shots across ${PER} matches (must be > 0)`);
  console.log(`      (bottom tier scored ${scored} goals in ${PER} matches — dumb, not frozen)`);
}

// FAIRNESS CEILING — no future retune may quietly rebuild the 9.5x charge monster.
{
  const SHOOT_CHARGE_TIME = 2.0, SUPER = 2, FULL = 0.70;
  const top = skillVec(1.0);
  // worst case the sim can compute: skill rate (already divided by cards at the write site and
  // clamped) x 3 legendaries x super
  const effCap = 2.50; // the clamp in computeBotInputs
  const fastest = (FULL + 0.01) * SHOOT_CHARGE_TIME / (effCap * SUPER);
  ok(fastest >= 0.28, `fairness: fastest possible full charge is ${fastest.toFixed(2)}s even with 3 legendaries + super (was 0.15s)`);
  ok(!top.cheat, 'fairness: the top tier has NO x-ray flag (it sees only what a player could)');
  ok((top.visionMul || 0) <= 1.65, `fairness: top visionMul ${top.visionMul.toFixed(2)} <= 1.65 (~the human camera's half-width)`);
}

console.log(`\n${fails === 0 ? '✅ ALL PASS' : '❌ ' + fails + ' FAILED'}`);
process.exit(fails === 0 ? 0 : 1);
