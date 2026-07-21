// Unit + integration tests for shared/bot-ai.js. Run: node test-bot-ai.mjs
import { createState, addPlayer, attachBall, step } from './shared/sim.js';
import { DT, FIELD } from './shared/constants.js';
import {
  computeBotInputs, createBotMemory, quadraticIntercept, assignRoles, botCanSee, laneClear, inEnemyBox,
} from './shared/bot-ai.js';
import { ARENA } from './shared/arena.js';

let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };

// 1) quadratic intercept — leads a moving target, aims straight at a still one.
{
  const still = quadraticIntercept(0, 0, 300, 0, 0, 0, 720);
  ok(still[0] > 0.98 && Math.abs(still[1]) < 0.02, `intercept: still target -> straight aim (${still.map((v) => v.toFixed(2))})`);
  const moving = quadraticIntercept(0, 0, 300, 0, 0, 220, 720);
  ok(moving[1] > 0.05, `intercept: crossing target -> aim leads ahead (y=${moving[1].toFixed(2)})`);
}

// 2) role assignment — exclusive, nearest is on-ball, hysteresis holds it.
{
  const s = createState(); s.resetTimer = 0;
  addPlayer(s, 'A0', { name: 'a', char: 'player', team: 'A', slot: 0, isBot: true });
  addPlayer(s, 'A1', { name: 'b', char: 'player', team: 'A', slot: 1, isBot: true });
  s.players.A0.x = 350; s.players.A0.y = 300; s.players.A1.x = 1100; s.players.A1.y = 300;
  s.ball.owner = null; s.ball.x = 380; s.ball.y = 300;
  const mem = createBotMemory();
  const r = assignRoles(s, 'A', mem, DT);
  ok(r.onBall === 'A0' && r.support === 'A1', `roles: nearest is on-ball, other supports (${r.onBall}/${r.support})`);
  ok(r.onBall !== r.support, 'roles: exclusive (never both on-ball)');
  // nudge A1 slightly closer but within the switch margin -> A0 keeps the role
  s.players.A1.x = 420; mem.t += 0.1;
  const r2 = assignRoles(s, 'A', mem, DT);
  ok(r2.onBall === 'A0', 'roles: hysteresis keeps on-ball within switch margin');
}

// 3) fog of war — enemy hidden in a bush unless close / firing / carrying.
{
  const s = createState();
  addPlayer(s, 'A0', { name: 'a', char: 'player', team: 'A', slot: 0, isBot: true });
  addPlayer(s, 'B0', { name: 'b', char: 'player', team: 'B', slot: 0, isBot: true });
  const viewer = s.players.A0, target = s.players.B0;
  const bush = ARENA.bushes[0]; target.x = bush.x + bush.w / 2; target.y = bush.y + bush.h / 2; // central bush (1000,550)
  viewer.x = 600; viewer.y = 550; // ~400px away — WITHIN the bot's view range, but > BUSH_REVEAL_DIST
  target.firing = false; s.ball.owner = null;
  ok(!botCanSee(viewer, target, s), 'fog: in-view idle enemy hidden in a bush is unseen');
  target.firing = true;
  ok(botCanSee(viewer, target, s), 'fog: an in-view firing enemy in a bush is revealed');
  target.firing = false; s.ball.owner = target.id;
  ok(botCanSee(viewer, target, s), 'fog: an in-view ball-carrier in a bush is revealed');
  // OUT OF VIEW: a bot can't perceive an enemy across the pitch even if firing/carrying.
  viewer.x = 100; viewer.y = 100; // >VISION_RANGE from the bush
  ok(!botCanSee(viewer, target, s), 'fog: an out-of-view carrier is unseen (limited vision)');
  s.ball.owner = null; target.firing = true;
  ok(!botCanSee(viewer, target, s), 'fog: an out-of-view firing enemy is unseen (limited vision)');
  target.firing = false; s.players.B0.team = 'A';
  ok(botCanSee(viewer, target, s), 'fog: teammates are always visible');
}

// 4) lane clear — blocked by a wall and by an enemy body.
{
  const s = createState();
  addPlayer(s, 'A0', { name: 'a', char: 'player', team: 'A', slot: 0, isBot: true });
  addPlayer(s, 'B0', { name: 'b', char: 'player', team: 'B', slot: 0, isBot: true });
  s.players.B0.x = -999; s.players.B0.y = -999; // enemy far away by default
  const w = ARENA.walls[0]; // {x:560,y:250,w:120,h:120}
  ok(!laneClear(500, w.y + 60, 760, w.y + 60, s, 'A', { enemies: false }), 'lane: blocked by a stone wall');
  ok(laneClear(500, 950, 760, 950, s, 'A', { enemies: false }), 'lane: open lane is clear');
  s.players.B0.x = 630; s.players.B0.y = 950; // stand an enemy in the open lane
  ok(!laneClear(500, 950, 760, 950, s, 'A', { enemies: true }), 'lane: blocked by an enemy body');
}

// 5) penalty-box detector.
{
  ok(inEnemyBox({ team: 'A', x: FIELD.W - 90, y: FIELD.H / 2 }), 'box: A attacker deep in the right box');
  ok(!inEnemyBox({ team: 'A', x: FIELD.W / 2, y: FIELD.H / 2 }), 'box: midfield is not in the box');
}

// 6) integration — a full 2v2 runs stably; inputs are valid; the two defenders
//    coordinate (distinct headings, not both charging the carrier).
{
  const s = createState(); s.resetTimer = 0;
  addPlayer(s, 'A0', { name: 'a', char: 'player', team: 'A', slot: 0, isBot: true });
  addPlayer(s, 'A1', { name: 'b', char: 'player', team: 'A', slot: 1, isBot: true });
  addPlayer(s, 'B0', { name: 'c', char: 'player', team: 'B', slot: 0, isBot: true });
  addPlayer(s, 'B1', { name: 'd', char: 'player', team: 'B', slot: 1, isBot: true });
  attachBall(s, 'B'); // enemy of A carries -> A must defend
  const mem = createBotMemory();
  let bad = 0, threw = false;
  try {
    for (let t = 0; t < 120; t++) {
      const inp = computeBotInputs(s, mem, DT);
      for (const id in inp) {
        const i = inp[id];
        if (!isFinite(i.moveX) || !isFinite(i.moveY) || !isFinite(i.aimX) || !isFinite(i.aimY)) bad++;
        if (Math.hypot(i.moveX, i.moveY) > 1.02) bad++;
        if (Math.abs(Math.hypot(i.aimX, i.aimY) - 1) > 0.05) bad++;
      }
      step(s, inp, DT);
    }
  } catch (e) { threw = true; console.error('threw:', e.message); }
  ok(!threw, 'integration: 120 ticks of 2v2 run without throwing');
  ok(bad === 0, `integration: all bot inputs valid (normalized) — ${bad} bad`);

  // coordination snapshot: enemy carrier present -> A's two bots don't both sit on it
  s.players.B0.x = 1000; s.players.B0.y = 550; s.ball.owner = 'B0'; s.ball.x = 1000; s.ball.y = 550;
  s.players.A0.x = 900; s.players.A0.y = 550; s.players.A1.x = 1100; s.players.A1.y = 560;
  const m2 = createBotMemory();
  computeBotInputs(s, m2, DT);
  const role = m2.teams.A;
  ok(role && role.onBall !== role.support && role.support != null, `coordination: distinct press/cover roles assigned (${role && role.onBall}/${role && role.support})`);
}

console.log(`\n${fails === 0 ? '✅ ALL PASS' : '❌ ' + fails + ' FAILED'}`);
process.exit(fails === 0 ? 0 : 1);
