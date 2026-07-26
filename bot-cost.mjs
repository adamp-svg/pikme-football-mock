// What does bot THINKING actually cost, and can we afford to think AHEAD?
//
// Written 2026-07-26 for the architecture review in
// `summery/bots logic handoff/ARCHITECTURE-REVIEW-2026-07-26.md`. Every "should the bots plan /
// look ahead / run rollouts?" argument in this repo has been made without a number. This is the
// number.
//
//   node bot-cost.mjs
//   SKILL=0.93 MATCHES=8 SECS=60 node bot-cost.mjs
//   ARENA=default node bot-cost.mjs        # bare 4-wall arena instead of MAIN_FIELD
//   JSON=cost.json node bot-cost.mjs
//
// Reports:
//   full tick        computeBotInputs + step, measured in BLOCKS (one timer pair per block)
//   bots / step      the split, measured per-segment and CALIBRATED for timer overhead
//   clone            structuredClone + JSON round-trip of a live state — the real cost of a
//                    rollout branch, which is NOT the sim
//   rollout table    ms/tick and % of a 60Hz tick for K candidates x 4 bots at several replan rates
//
// ---- THREE TRAPS THIS FILE IS BUILT AROUND (read before quoting it) ----------------------------
// 1. A FINISHED MATCH IS FREE. `step()` early-returns once the match is over (and skips the player
//    loop entirely while `resetTimer > 0`, sim.js:646 — the same trap that invented a fake
//    "171 releases" bug in bot-skill-census). The first version of this bench ran 20k ticks on a
//    dead state and reported step() at 0.0 us. Every tick counted here is a LIVE tick of a FRESH
//    match, and the goal-celebration freeze is counted separately, not silently averaged in.
// 2. THE TIMER IS NOT FREE. At ~1us per call, two `process.hrtime.bigint()` calls are a real
//    fraction of what is being measured. `timerOverhead` below measures the clock against itself
//    and the per-segment splits are reported net of it. The BLOCK measurement of the full tick
//    is the authoritative total; the split is the attribution.
// 3. THIS IS ONE ROOM ON THIS MACHINE. Render's CPU is slower and a box runs many rooms at once:
//    the real budget is (tick cost x concurrent rooms), and the rollout table must be divided by
//    the number of rooms a box holds. Do not quote the % column as a production headroom figure.
import { createState, addPlayer, attachBall, step, setField } from './shared/sim.js';
import { MAIN_FIELD } from './shared/main-field.js';
import { DT, TICK_RATE } from './shared/constants.js';
import { computeBotInputs, createBotMemory } from './shared/bot-ai.js';

const SKILL = parseFloat(process.env.SKILL || '0.82');
const MATCHES = parseInt(process.env.MATCHES || '6', 10);
const SECS = parseInt(process.env.SECS || '60', 10);
const SEEDBASE = parseInt(process.env.SEEDBASE || '20260726', 10);
const USE_MAIN = process.env.ARENA !== 'default';
const BLOCK = 600;                       // ticks per block for the authoritative total
const TICKS = Math.round(SECS / DT);
const TICK_US = 1e6 / TICK_RATE;         // 16666.7us at 60Hz

// ---- seeded RNG over Math.random, like every other instrument here ----
let _s = 1;
const lcg = () => { _s = (_s * 1664525 + 1013904223) >>> 0; return _s / 4294967296; };
Math.random = lcg;

function mkMatch(seed) {
  _s = seed >>> 0 || 1;
  const s = createState();
  if (USE_MAIN) setField(s, MAIN_FIELD);
  addPlayer(s, 'A0', 'A', true); addPlayer(s, 'A1', 'A', true);
  addPlayer(s, 'B0', 'B', true); addPlayer(s, 'B1', 'B', true);
  attachBall(s);
  const mem = createBotMemory();
  mem.skill = SKILL;
  return { s, mem };
}

const now = () => process.hrtime.bigint();
const us = (ns, n) => Number(ns) / n / 1000;

// ---- trap 2: how much does asking the time cost? ----
let cal = 0n;
for (let r = 0; r < 5; r++) {
  const N = 20000, t0 = now();
  for (let i = 0; i < N; i++) now();
  const c = now() - t0;
  if (r === 0 || c < cal) cal = c;                 // best of 5, least polluted
}
const timerUs = Number(cal) / 20000 / 1000;

// ---- warm the nav-grid / arena caches so block 1 isn't a cold-start outlier ----
{
  const { s, mem } = mkMatch(SEEDBASE - 1);
  for (let i = 0; i < 300; i++) step(s, computeBotInputs(s, mem, DT), DT);
}

let nBlocks = 0, tBlocks = 0n;
let nSeg = 0, tBots = 0n, tStep = 0n;
let frozenTicks = 0, liveTicks = 0;
const perMatch = [];

for (let m = 0; m < MATCHES; m++) {
  const { s, mem } = mkMatch(SEEDBASE + m * 7919);
  let mBlocks = 0n, mN = 0;
  for (let i = 0; i < TICKS; i += BLOCK) {
    const n = Math.min(BLOCK, TICKS - i);
    // trap 1: a celebration freeze is a CHEAP tick. Count them, don't average them in.
    let frozenHere = 0;
    const t0 = now();
    for (let k = 0; k < n; k++) {
      if (s.resetTimer > 0) frozenHere++;
      step(s, computeBotInputs(s, mem, DT), DT);
    }
    const dt = now() - t0;
    frozenTicks += frozenHere; liveTicks += n - frozenHere;
    if (frozenHere === 0) { tBlocks += dt; nBlocks += n; mBlocks += dt; mN += n; }
  }
  if (mN) perMatch.push(us(mBlocks, mN));
}

// ---- the split (per-segment timers, net of timer overhead) ----
{
  const { s, mem } = mkMatch(SEEDBASE + 104729);
  for (let i = 0; i < 300; i++) step(s, computeBotInputs(s, mem, DT), DT);
  for (let i = 0; i < TICKS; i++) {
    if (s.resetTimer > 0) { step(s, computeBotInputs(s, mem, DT), DT); continue; }
    const a = now(); const inp = computeBotInputs(s, mem, DT);
    const b = now(); step(s, inp, DT);
    const c = now();
    tBots += b - a; tStep += c - b; nSeg++;
  }
}

const full = us(tBlocks, nBlocks);
const bots = Math.max(0, us(tBots, nSeg) - timerUs);
const stepC = Math.max(0, us(tStep, nSeg) - timerUs);

// ---- the cost of a rollout BRANCH: copying the state, not stepping it ----
const { s: cs } = mkMatch(SEEDBASE + 7);
for (let i = 0; i < 900; i++) step(cs, computeBotInputs(cs, createBotMemory(), DT), DT);  // populate projectiles/walls
function timeIt(fn, n) { const t0 = now(); for (let i = 0; i < n; i++) fn(); return us(now() - t0, n); }
const cloneSc = timeIt(() => structuredClone(cs), 2000);
const cloneJs = timeIt(() => JSON.parse(JSON.stringify(cs)), 2000);
const clone = Math.min(cloneSc, cloneJs);

const spread = perMatch.length ? `${Math.min(...perMatch).toFixed(2)}-${Math.max(...perMatch).toFixed(2)}` : 'n/a';
console.log(`bot-cost  arena=${USE_MAIN ? 'main' : 'default'} skill=${SKILL} ${MATCHES}x${SECS}s seed=${SEEDBASE}`);
console.log(`  live ticks measured   ${nBlocks} (in ${BLOCK}-tick blocks)  |  celebration-freeze ticks excluded: ${frozenTicks}`);
console.log(`  timer overhead        ${timerUs.toFixed(3)} us per hrtime call (splits are net of this)`);
console.log('');
console.log(`  FULL TICK             ${full.toFixed(2)} us   = ${(full / TICK_US * 100).toFixed(3)}% of a ${TICK_RATE}Hz tick   [per-match ${spread}]`);
console.log(`    computeBotInputs    ${bots.toFixed(2)} us   (4 bots -> ${(bots / 4).toFixed(2)} us per bot)`);
console.log(`    step()              ${stepC.toFixed(2)} us   (${(stepC / Math.max(bots, 1e-9)).toFixed(1)}x the thinking)`);
console.log('');
console.log(`  state copy            structuredClone ${cloneSc.toFixed(1)} us  |  JSON round-trip ${cloneJs.toFixed(1)} us`);
console.log(`                        -> a rollout BRANCH costs ${clone.toFixed(1)} us before it simulates anything.`);
console.log(`                           A slim hand-rolled snapshot (players/ball/projectiles only) is the`);
console.log(`                           optimisation that matters; the sim is already nearly free.`);

// ---- CAN WE THINK AHEAD? K candidate actions, rolled forward, per planning bot ----
const HORIZON = 0.5, COARSE = 1 / 20, STEPS = Math.round(HORIZON / COARSE);
console.log('');
console.log(`  ROLLOUT FEASIBILITY   ${HORIZON}s horizon at ${(1 / COARSE).toFixed(0)}Hz = ${STEPS} coarse steps per candidate, 4 bots planning`);
console.log(`                        (a coarse step is charged here at full step() cost, i.e. pessimistic)`);
console.log(`     K   replan 60Hz        replan 20Hz        replan 10Hz        replan 5Hz`);
const rows = [];
for (const K of [4, 8, 16, 32]) {
  const per = clone + STEPS * stepC;                  // one candidate, one bot
  const tick = 4 * K * per;                           // us, if it replanned every tick
  const cells = [60, 20, 10, 5].map((hz) => {
    const share = tick * (hz / TICK_RATE);
    return `${(share / 1000).toFixed(2)}ms ${(share / TICK_US * 100).toFixed(0)}%`.padEnd(18);
  });
  console.log(`    ${String(K).padStart(2)}   ${cells.join(' ')}`);
  rows.push({ K, perCandidateUs: per, tickUs: tick });
}
console.log('');
console.log(`  ONE ROOM ON THIS MACHINE. Divide every % by the rooms a box holds, and re-measure on`);
console.log(`  Render before believing any of it (trap 3 in the header).`);

if (process.env.JSON) {
  const fs = await import('node:fs');
  fs.writeFileSync(process.env.JSON, JSON.stringify({
    arena: USE_MAIN ? 'main' : 'default', skill: SKILL, matches: MATCHES, secs: SECS, seed: SEEDBASE,
    ticks: nBlocks, frozenTicks, timerUs, fullUs: full, botsUs: bots, perBotUs: bots / 4, stepUs: stepC,
    perMatchUs: perMatch, cloneStructuredUs: cloneSc, cloneJsonUs: cloneJs,
    rollout: { horizonS: HORIZON, coarseHz: 1 / COARSE, steps: STEPS, rows },
  }, null, 2));
  console.log(`  wrote ${process.env.JSON}`);
}
