// "They sometimes get idle waiting for something." Attribute every near-stationary tick to the
// state that is holding the bot there, at the level the user is actually running (L10).
//
// ⚠️ READ THE THRESHOLD ARITHMETIC BEFORE QUOTING THIS FILE. It cost a whole round.
// A bot walks `CHARACTERS.player.speed 158 × settings.speedMul 0.9 = 142.2 px/s`, and MOVE_ACCEL is
// 1 (velocity snaps), so a FULL-SPEED walk is exactly **2.37 px/tick** at DT 1/60.
// Two sanctioned states halve or reduce that WITHOUT the bot stopping:
//   * a wall wind-up — `BUILD_WINDUP_SLOW 0.5` (sim.js:715) → **1.185 px/tick**, and a human pays
//     the identical slow while winding up their own wall;
//   * carrying the ball — `carrySpeedMul 0.9` → 2.13 px/tick.
// This file's original cut was `disp < 1.2`, i.e. **0.015px above the half-speed walk**, so every
// wall wind-up was reported as "stationary". MEASURED (L10, 8 matches × 60s, MAIN_FIELD): while
// `buildHold` the displacement is 1.18 / 1.19 / 1.19 px/tick at p10 / p50 / p90 — a flat walk, not
// a stall — and a threshold sweep gives 3.25 episodes/match at 1.2px, 0.38 at 1.0px and **0.00 at
// 0.8px**. No bot at L10 is stationary for 0.3s. `SLOWED` below is the honest name for that state.
// So: STOPPED (< STOP_PX) is a stall worth fixing. SLOWED is the game's own wind-up/carry rule
// working. Do not "fix the idle" by attacking a SLOWED number — the only lever on it is
// BUILD_WINDUP / BUILD_WINDUP_SLOW, which changes the rule for human players too.
import { createState, addPlayer, attachBall, step, setField, makeRng } from './shared/sim.js';
import { MAIN_FIELD } from './shared/main-field.js';
import { DT } from './shared/constants.js';
import { computeBotInputs, createBotMemory, bmemForTest } from './shared/bot-ai.js';
import { DIFFICULTY_LEVELS } from './shared/difficulty.js';
const L = DIFFICULTY_LEVELS[+(process.env.LVL || 10)];
const M = +(process.env.MATCHES || 6), SECS = +(process.env.SECS || 60);
// 0.8px/tick = 48px/s = a third of a walk and well under the 1.185 half-speed wind-up crawl, so
// nothing that is genuinely WALKING can be counted as stopped. Override with STOP_PX= to sweep.
const STOP_PX = +(process.env.STOP_PX || 0.8);
const WALK_PX = 2.37; // full-speed walk, for the SLOWED report
const cause = {}, runs = {}; let idleTicks = 0, ticks = 0, worst = { s: 0 };
let slowTicks = 0; const slowCause = {};
for (let mi = 0; mi < M; mi++) {
  const s = createState(); s.resetTimer = 0; setField(s, MAIN_FIELD); s.rng = makeRng(1234 * 7919 + mi * 104729);
  for (const [id, team, slot] of [['A0','A',0],['A1','A',1],['B0','B',0],['B1','B',1]]) addPlayer(s, id, { name: id, char: 'player', team, slot, isBot: true });
  attachBall(s, s.rng() < 0.5 ? 'A' : 'B');
  const mem = createBotMemory('normal'); mem.teamSkill = { A: L.partner, B: L.enemy };
  const prev = {}, run = {};
  for (const id in s.players) { prev[id] = { x: s.players[id].x, y: s.players[id].y }; run[id] = 0; }
  for (let t = 0; t < Math.round(SECS / DT); t++) {
    const inp = computeBotInputs(s, mem, DT); step(s, inp, DT);
    if (s.resetTimer > 0) { for (const id in s.players) { prev[id] = { x: s.players[id].x, y: s.players[id].y }; run[id] = 0; } continue; }
    ticks++;
    for (const id in s.players) {
      const p = s.players[id], i = inp[id]; if (!i) continue;
      const disp = Math.hypot(p.x - prev[id].x, p.y - prev[id].y);
      prev[id] = { x: p.x, y: p.y };
      const bm = bmemForTest(mem, id);
      // SLOWED, not stopped: still walking, just not at full speed. Reported separately so it can
      // never be mistaken for a stall again (see the header).
      if (disp >= STOP_PX) {
        if (disp < WALK_PX - 0.15 && Math.hypot(i.moveX, i.moveY) > 0.3) {
          slowTicks++;
          const k = i.buildHold ? 'wall wind-up (BUILD_WINDUP_SLOW, humans pay it too)'
                  : s.ball.owner === id ? 'carrying the ball (carrySpeedMul)'
                  : 'rubbing along geometry / another body';
          slowCause[k] = (slowCause[k] || 0) + 1;
        }
        if (run[id] * DT > worst.s) worst = { s: run[id] * DT, id, why: run[id + 'why'] };
        run[id] = 0; continue;
      }
      idleTicks++; run[id]++;
      const want = Math.hypot(i.moveX, i.moveY) > 0.3;
      let why;
      if (bm.bombHold) why = 'bombHold (standing on the plant for the 1.725s fuse)';
      else if (bm.buildHold) why = 'buildHold (wall wind-up)';
      else if (!want) why = 'no move intent at all' + (bm.lastTrick ? ' [' + bm.lastTrick + ']' : '');
      else why = 'wants to move but blocked' + (bm.lastTrick ? ' [' + bm.lastTrick + ']' : '');
      run[id + 'why'] = why;
      cause[why] = (cause[why] || 0) + 1;
    }
  }
}
console.log(`L${process.env.LVL || 10}  STOPPED (< ${STOP_PX}px/tick) ${(100 * idleTicks / (ticks * 4)).toFixed(2)}% of all bot-ticks; longest stopped run ${worst.s.toFixed(2)}s (${worst.id} — ${worst.why})`);
for (const [k, v] of Object.entries(cause).sort((a, b) => b[1] - a[1]).slice(0, 12))
  console.log(`   ${(100 * v / idleTicks).toFixed(1).padStart(5)}%  ${(v * DT / M).toFixed(1).padStart(5)}s/match  ${k}`);
if (!idleTicks) console.log('   (nothing — no bot was stopped for a single tick)');
console.log(`SLOWED but walking ${(100 * slowTicks / (ticks * 4)).toFixed(2)}% of all bot-ticks — NOT idle, see the header:`);
for (const [k, v] of Object.entries(slowCause).sort((a, b) => b[1] - a[1]))
  console.log(`   ${(100 * v / slowTicks).toFixed(1).padStart(5)}%  ${(v * DT / M).toFixed(1).padStart(5)}s/match  ${k}`);
