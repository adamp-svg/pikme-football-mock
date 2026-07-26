// "They sometimes get idle waiting for something." Attribute every near-stationary tick to the
// state that is holding the bot there, at the level the user is actually running (L10).
import { createState, addPlayer, attachBall, step, setField, makeRng } from './shared/sim.js';
import { MAIN_FIELD } from './shared/main-field.js';
import { DT } from './shared/constants.js';
import { computeBotInputs, createBotMemory, bmemForTest } from './shared/bot-ai.js';
import { DIFFICULTY_LEVELS } from './shared/difficulty.js';
const L = DIFFICULTY_LEVELS[+(process.env.LVL || 10)];
const M = +(process.env.MATCHES || 6), SECS = +(process.env.SECS || 60);
const cause = {}, runs = {}; let idleTicks = 0, ticks = 0, worst = { s: 0 };
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
      if (disp >= 1.2) { if (run[id] * DT > worst.s) worst = { s: run[id] * DT, id, why: run[id + 'why'] }; run[id] = 0; continue; }
      idleTicks++; run[id]++;
      const bm = bmemForTest(mem, id);
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
console.log(`L${process.env.LVL || 10}  idle ticks ${(100 * idleTicks / (ticks * 4)).toFixed(1)}% of all bot-ticks; longest stationary run ${worst.s.toFixed(2)}s (${worst.id} — ${worst.why})`);
for (const [k, v] of Object.entries(cause).sort((a, b) => b[1] - a[1]).slice(0, 12))
  console.log(`   ${(100 * v / idleTicks).toFixed(1).padStart(5)}%  ${(v * DT / M).toFixed(1).padStart(5)}s/match  ${k}`);
