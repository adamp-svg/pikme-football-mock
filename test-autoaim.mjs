// Sim tests: AUTO-AIM REMOVED (per request) — EVERY shot honours the player's manual aim.
//  - quick BULLET fires along manual aim even when an enemy sits elsewhere (no snap)
//  - quick BULLET with an enemy behind a wall also honours manual aim (unchanged)
//  - quick SHOT (carrying) drives the ball along manual aim, NOT toward the enemy goal
//  - a FULL charged shot honours manual aim (unchanged)
// Run: node test-autoaim.mjs
import { createState, addPlayer, attachBall, step } from './shared/sim.js';
import { DT, FIELD, GOAL } from './shared/constants.js';
import { ARENA } from './shared/arena.js';

let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fails++; };
function inp(o = {}) { return { seq: 1, moveX: 0, moveY: 0, aimX: 1, aimY: 0, hold: false, fire: false, special: false, build: false, buildHold: false, sax: 0, say: 0, ...o }; }
function fresh() {
  const s = createState(); s.resetTimer = 0;
  addPlayer(s, 'p1', { name: 'A', char: 'player', team: 'A', slot: 0 });
  addPlayer(s, 'p2', { name: 'B', char: 'player', team: 'B', slot: 0 });
  s.ball.x = -900; s.ball.y = -900; // park the ball away unless attached
  return s;
}
const newestProj = (s) => s.projectiles[s.projectiles.length - 1];

// 1) QUICK bullet honours MANUAL aim even with an enemy straight up (no auto-snap).
{
  const s = fresh();
  const a = s.players.p1; a.x = 1000; a.y = 550;
  s.players.p2.x = 1000; s.players.p2.y = 300;            // enemy straight UP
  step(s, { p1: inp({ fire: true, aimX: 1, aimY: 0 }), p2: inp() }, DT); // manual aim RIGHT, quick fire
  const pr = newestProj(s);
  ok(pr && pr.vx > 100 && Math.abs(pr.vy) < 100, `quick bullet goes RIGHT (manual), NOT up to the enemy (v=${pr ? pr.vx.toFixed(0) + ',' + pr.vy.toFixed(0) : 'none'})`);
}

// 2) Enemy behind a wall: still just the manual aim (unchanged).
{
  const s = fresh();
  const w = ARENA.walls[0]; // {560,250,120,120}
  const a = s.players.p1; a.x = w.x + w.w / 2; a.y = w.y - 40;
  s.players.p2.x = w.x + w.w / 2; s.players.p2.y = w.y + w.h + 40;
  step(s, { p1: inp({ fire: true, aimX: 1, aimY: 0 }), p2: inp() }, DT); // manual aim RIGHT
  const pr = newestProj(s);
  ok(pr && pr.vx > 100 && Math.abs(pr.vy) < 100, `quick bullet keeps manual aim RIGHT (v=${pr ? pr.vx.toFixed(0) + ',' + pr.vy.toFixed(0) : 'none'})`);
}

// 3) QUICK shot while carrying drives the ball along MANUAL aim, not toward the goal.
{
  const s = fresh();
  attachBall(s, 'A');
  const a = s.players.p1; a.x = 1000; a.y = 300; s.ball.x = a.x; s.ball.y = a.y;
  step(s, { p1: inp({ fire: true, aimX: 0, aimY: 1 }), p2: inp() }, DT); // manual aim DOWN, quick fire
  ok(s.ball.owner == null && s.ball.vy > 100 && Math.abs(s.ball.vx) < 150, `quick carrier shot drives the ball DOWN (manual), not toward the goal (v=${s.ball.vx.toFixed(0)},${s.ball.vy.toFixed(0)})`);
}

// 4) FULL charged shot honours the MANUAL aim (unchanged).
{
  const s = fresh();
  attachBall(s, 'A');
  const a = s.players.p1; a.x = 1000; a.y = 550; s.ball.x = a.x; s.ball.y = a.y;
  for (let i = 0; i < 100; i++) step(s, { p1: inp({ hold: true, aimX: 0, aimY: -1 }), p2: inp() }, DT); // charge to FULL, aim UP
  step(s, { p1: inp({ fire: true, aimX: 0, aimY: -1 }), p2: inp() }, DT);
  ok(s.ball.owner == null && s.ball.vy < -100 && Math.abs(s.ball.vx) < 150, `FULL shot honours manual aim UP (v=${s.ball.vx.toFixed(0)},${s.ball.vy.toFixed(0)})`);
}

console.log(fails ? `\n❌ ${fails} FAIL` : '\n✅ ALL PASS');
process.exit(fails ? 1 : 0);
