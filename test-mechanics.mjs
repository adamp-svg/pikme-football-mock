// Sim unit tests for the arena mechanics (walls, bushes, trampolines, build).
// Run: node test-mechanics.mjs   (exits non-zero on any failure)
import { createState, addPlayer, attachBall, step } from './shared/sim.js';
import { DT, BUILD_MAG, BUILD_RELOAD, BUILT_WALL } from './shared/constants.js';
import { ARENA, pointInBush } from './shared/arena.js';

let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fails++; };
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;

// Fresh state with the kickoff freeze skipped and one player of each team.
function fresh() {
  const s = createState();
  s.resetTimer = 0;
  addPlayer(s, 'p1', { name: 'A', char: 'player', team: 'A', slot: 0 });
  addPlayer(s, 'p2', { name: 'B', char: 'player', team: 'B', slot: 0 });
  return s;
}
function inp(o = {}) { return { seq: 1, moveX: 0, moveY: 0, aimX: 1, aimY: 0, shoot: false, special: false, build: false, charge: 0, ...o }; }
const wall = ARENA.walls[0]; // {x:560,y:250,w:120,h:120}

// 1) A player cannot walk through a stone wall (slides / is blocked).
{
  const s = fresh();
  const p = s.players.p1;
  p.x = wall.x - 40; p.y = wall.y + 60; // just left of the wall, within its height
  for (let i = 0; i < 40; i++) step(s, { p1: inp({ moveX: 1 }), p2: inp() }, DT);
  ok(p.x <= wall.x + 0.5, `player blocked by wall (x=${p.x.toFixed(1)} <= ${wall.x})`);
}

// 2) A loose ball bounces off a wall (x-velocity reverses sign).
{
  const s = fresh();
  s.ball.owner = null; s.ball.lastTouch = 'A';
  s.ball.x = wall.x - 20; s.ball.y = wall.y + 60; s.ball.vx = 700; s.ball.vy = 0;
  step(s, { p1: inp({ moveX: 0 }), p2: inp() }, DT);
  ok(s.ball.vx < 0, `ball ricochets off wall (vx=${s.ball.vx.toFixed(0)} < 0)`);
  ok(s.ball.x < wall.x, `ball pushed out of wall (x=${s.ball.x.toFixed(1)} < ${wall.x})`);
}

// 3) A bullet is consumed at a wall (does not pass through).
{
  const s = fresh();
  const p = s.players.p1;
  p.x = wall.x - 60; p.y = wall.y + 60; p.aimX = 1; p.aimY = 0; p.ammo = 3;
  step(s, { p1: inp({ shoot: true, charge: 1 }), p2: inp() }, DT); // fire toward wall
  for (let i = 0; i < 30; i++) step(s, { p1: inp({ moveX: 0 }), p2: inp() }, DT);
  const past = s.projectiles.some((pr) => pr.x > wall.x + wall.w);
  ok(!past, `bullet stopped by wall (none passed through; ${s.projectiles.length} live)`);
}

// (4 & 5) Trampolines removed — see arena.js `TRAMPOLINES = []`. Tests dropped.

// 6) Build spawns a destructible wall ahead, costs one charge, respects cooldown.
{
  const s = fresh();
  const p = s.players.p1;
  p.x = 1000; p.y = 550; p.aimX = 1; p.aimY = 0;
  step(s, { p1: inp({ build: true }), p2: inp() }, DT);
  ok(s.builtWalls.length === 1, `build placed a wall (${s.builtWalls.length})`);
  ok(p.buildAmmo === BUILD_MAG - 1, `one build charge spent (${p.buildAmmo}/${BUILD_MAG})`);
  const w = s.builtWalls[0];
  ok(w.x > p.x, `wall placed in front (aim +x): wall.x=${w.x.toFixed(0)} > ${p.x}`);
  ok(w.hp === BUILT_WALL.hp, `wall has full HP (${w.hp})`);
  // immediate second build blocked by cooldown
  step(s, { p1: inp({ build: true }), p2: inp() }, DT);
  ok(s.builtWalls.length === 1, `build cooldown blocks instant re-build (${s.builtWalls.length})`);
}

// 7) Build charges reload one every BUILD_RELOAD seconds.
{
  const s = fresh();
  const p = s.players.p1;
  p.buildAmmo = 1; p.buildAmmoT = BUILD_RELOAD; // one tick will top it up
  step(s, { p1: inp(), p2: inp() }, DT);
  ok(p.buildAmmo === 2, `build charge regenerated after ${BUILD_RELOAD}s (${p.buildAmmo})`);
}

// 8) A bomb blast destroys a built wall outright, even at full HP.
{
  const s = fresh();
  s.builtWalls.push({ id: 99, x: 990, y: 520, w: 60, h: 60, hp: BUILT_WALL.hp, maxHp: BUILT_WALL.hp, team: 'A' });
  s.bombs.push({ id: 98, owner: 'p2', team: 'B', x: 1010, y: 550, fuse: 0.001 });
  step(s, { p1: inp(), p2: inp() }, DT); // fuse expires -> explode -> wall destroyed
  ok(s.builtWalls.length === 0, `bomb destroyed a full-HP built wall (${s.builtWalls.length} left)`);
}

// 10) A full-power shot destroys a fresh built wall in a single hit.
{
  const s = fresh();
  const p = s.players.p1;
  p.x = 900; p.y = 550; p.aimX = 1; p.aimY = 0; p.ammo = 3;
  s.builtWalls.push({ id: 5, x: 958, y: 520, w: 40, h: 60, hp: BUILT_WALL.hp, maxHp: BUILT_WALL.hp, team: 'A' });
  step(s, { p1: inp({ shoot: true, charge: 1 }), p2: inp() }, DT);
  for (let i = 0; i < 40 && s.builtWalls.length; i++) step(s, { p1: inp(), p2: inp() }, DT);
  ok(s.builtWalls.length === 0, `full-power shot destroys a fresh wall in one hit`);
}

// 11) A minimum-charge shot only chips the wall by 1 (needs 3 to break it).
{
  const s = fresh();
  const p = s.players.p1;
  p.x = 900; p.y = 550; p.aimX = 1; p.aimY = 0; p.ammo = 3;
  s.builtWalls.push({ id: 6, x: 958, y: 520, w: 40, h: 60, hp: BUILT_WALL.hp, maxHp: BUILT_WALL.hp, team: 'A' });
  step(s, { p1: inp({ shoot: true, charge: 0 }), p2: inp() }, DT);
  for (let i = 0; i < 40 && s.builtWalls.length && s.builtWalls[0].hp === BUILT_WALL.hp; i++) step(s, { p1: inp(), p2: inp() }, DT);
  ok(s.builtWalls.length === 1 && s.builtWalls[0].hp === BUILT_WALL.hp - 1, `min-power shot chips wall by 1 (hp=${s.builtWalls[0]?.hp})`);
}

// 9) Bush geometry helper agrees with the layout.
{
  const g = ARENA.bushes[0];
  ok(pointInBush(g.x + g.w / 2, g.y + g.h / 2), 'centre of a bush reads as in-bush');
  ok(!pointInBush(5, 5), 'a corner of the pitch is not in a bush');
}

console.log(`\n${fails === 0 ? '✅ ALL PASS' : '❌ ' + fails + ' FAILED'}`);
process.exit(fails === 0 ? 0 : 1);
