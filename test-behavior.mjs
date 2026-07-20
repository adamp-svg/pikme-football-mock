// Measures the two reported feels on the NEW bots (all 4 bots = new AI):
//  - pinnedRate: bot wants to move (|input|>0.3) but barely moves (<1.2px) while
//    touching a wall or the pitch edge  -> "stuck in the stadium walls"
//  - idleBallRate: the ball-carrier barely moves (<1.2px)                -> "idle with the ball"
// Run: node test-behavior.mjs [matches] [seconds]
import { createState, addPlayer, attachBall, step } from './shared/sim.js';
import { DT, FIELD } from './shared/constants.js';
import { computeBotInputs, createBotMemory } from './shared/bot-ai.js';
import { ARENA } from './shared/arena.js';

const MATCHES = parseInt(process.argv[2] || '12', 10);
const SECS = parseInt(process.argv[3] || '70', 10);
const TICKS = Math.round(SECS / DT);
const R = 27;
function nearWallOrEdge(p) {
  if (p.x < R + 12 || p.x > FIELD.W - R - 12 || p.y < R + 12 || p.y > FIELD.H - R - 12) return true;
  for (const w of ARENA.walls) { const nx = Math.max(w.x, Math.min(p.x, w.x + w.w)), ny = Math.max(w.y, Math.min(p.y, w.y + w.h)); if (Math.hypot(p.x - nx, p.y - ny) < R + 12) return true; }
  return false;
}

let movingTicks = 0, pinned = 0, carryTicks = 0, idleBall = 0, playTicks = 0, longestIdleRun = 0;
for (let mi = 0; mi < MATCHES; mi++) {
  const s = createState(); s.resetTimer = 0;
  for (const [id, team, slot] of [['A0', 'A', 0], ['A1', 'A', 1], ['B0', 'B', 0], ['B1', 'B', 1]])
    addPlayer(s, id, { name: id, char: 'player', team, slot, isBot: true });
  attachBall(s, Math.random() < 0.5 ? 'A' : 'B');
  const mem = createBotMemory('normal');
  let prev = {}; for (const id in s.players) prev[id] = { x: s.players[id].x, y: s.players[id].y };
  let idleRun = 0;
  for (let t = 0; t < TICKS; t++) {
    const inp = computeBotInputs(s, mem, DT);
    step(s, inp, DT);
    if (s.resetTimer > 0) { for (const id in s.players) prev[id] = { x: s.players[id].x, y: s.players[id].y }; continue; }
    playTicks++;
    for (const id in s.players) {
      const p = s.players[id], i = inp[id]; if (!i) continue;
      const disp = Math.hypot(p.x - prev[id].x, p.y - prev[id].y);
      const wantMove = Math.hypot(i.moveX, i.moveY) > 0.3;
      if (wantMove) { movingTicks++; if (disp < 1.2 && nearWallOrEdge(p)) pinned++; }
      if (s.ball.owner === id) { carryTicks++; if (disp < 1.2) { idleBall++; idleRun++; longestIdleRun = Math.max(longestIdleRun, idleRun); } else idleRun = 0; }
      prev[id] = { x: p.x, y: p.y };
    }
  }
}
const pinRate = (100 * pinned / Math.max(1, movingTicks)).toFixed(2);
const idleRate = (100 * idleBall / Math.max(1, carryTicks)).toFixed(2);
console.log(`pinned-against-wall: ${pinRate}% of wanting-to-move ticks (${pinned}/${movingTicks})`);
console.log(`idle-with-ball:      ${idleRate}% of carry ticks (${idleBall}/${carryTicks}), longest idle run ${(longestIdleRun * DT).toFixed(2)}s`);
// longest-idle allows the deliberate ~1.25s bomb rocket-jump hold (a play, not dithering)
const pass = parseFloat(pinRate) < 2.0 && parseFloat(idleRate) < 4.0 && (longestIdleRun * DT) < 1.45;
console.log(pass ? '✅ BEHAVIOR PASS (bots rarely pin on walls; carrier stays decisive)' : '❌ still pinning / idling');
process.exit(pass ? 0 : 1);
