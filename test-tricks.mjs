// Regression guard: across hard-vs-hard bot matches, every advanced "trick" must
// still fire (observed via bm.lastTrick). Guards the tricks against silent breakage.
// Run: node test-tricks.mjs
import { createState, addPlayer, attachBall, step } from './shared/sim.js';
import { DT } from './shared/constants.js';
import { computeBotInputs, createBotMemory } from './shared/bot-ai.js';

const seen = {};
for (let mi = 0; mi < 16; mi++) {
  const s = createState(); s.resetTimer = 0;
  for (const [id, tm, sl] of [['A0', 'A', 0], ['A1', 'A', 1], ['B0', 'B', 0], ['B1', 'B', 1]]) addPlayer(s, id, { name: id, char: 'player', team: tm, slot: sl, isBot: true });
  attachBall(s, mi % 2 ? 'A' : 'B');
  const mem = createBotMemory('hard'); const last = {};
  for (let t = 0; t < Math.round(70 / DT); t++) {
    const inp = computeBotInputs(s, mem, DT); step(s, inp, DT);
    for (const id in mem.bots) { const lt = mem.bots[id].lastTrick; if (lt && lt !== last[id]) seen[lt] = (seen[lt] || 0) + 1; last[id] = lt; }
  }
}

let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };
console.log('trick firings:', JSON.stringify(seen), '\n');
ok((seen.ambushWall || 0) > 0, 'bush ambush drops a trap WALL');
ok((seen.ambushStrip || 0) > 0, 'ambush follows through with a STRIP');
ok((seen.ambushLurk || 0) > 0, 'bots LURK hidden in a bush');
ok((seen.clearMarker || 0) > 0, 'support fires to CLEAR a marker off the carrier');
ok((seen.giveGo || 0) > 0, 'GIVE-AND-GO (pass then break for the return)');
ok((seen.bombTravel || 0) + (seen.bombFinish || 0) > 0, 'BOMB rocket-jump (travel/finish) used');
ok((seen.boxFinish || 0) + (seen.passBank || 0) + (seen.goalBank || 0) > 0, 'ball-as-weapon: bump-through finish and/or wall bank');

console.log(`\n${fails === 0 ? '✅ ALL TRICKS FIRE' : '❌ ' + fails + ' trick(s) missing'}`);
process.exit(fails === 0 ? 0 : 1);
