// Fragile-wall mechanic: build in bush/penalty is allowed but fragile — any bullet
// breaks it, a power kick smashes through, a slow ball still bounces. + wire round-trip.
import { createState, addPlayer, step } from './shared/sim.js';
import { DT, FIELD, FRAGILE_HP } from './shared/constants.js';
import { ARENA } from './shared/arena.js';

let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };
const inp = (id, o) => ({ [id]: { seq: 1, moveX: 0, moveY: 0, aimX: 1, aimY: 0, hold: false, fire: false, special: false, build: false, ...o } });
// Sim-owned charge ramp: HOLD to build charge (~1s = full), then release (fire).
function fireAt(s, id, charge, aim = [1, 0]) {
  const n = Math.max(0, Math.round(charge * 60));
  for (let i = 0; i < n; i++) step(s, inp(id, { hold: true, aimX: aim[0], aimY: aim[1] }), DT);
  step(s, inp(id, { fire: true, aimX: aim[0], aimY: aim[1] }), DT);
}

function build(px, py, aimX, aimY) {
  const s = createState(); s.resetTimer = 0;
  addPlayer(s, 'P', { name: 'p', char: 'player', team: 'A', slot: 0, isBot: true });
  const p = s.players.P; p.x = px; p.y = py; p.aimX = aimX; p.aimY = aimY;
  step(s, inp('P', { build: true, aimX, aimY }), DT);
  return s;
}

// 1) build INTO the centre bush -> fragile, hp 1
{
  const g = ARENA.bushes[0]; // {850,430,300,240} centre ~ (1000,550)
  const s = build(g.x + g.w / 2 - 90, g.y + g.h / 2, 1, 0); // aim into the bush
  const w = s.builtWalls[0];
  ok(w && w.fragile === true && w.hp === FRAGILE_HP, `wall built inside a bush is FRAGILE hp${FRAGILE_HP} (${w ? w.fragile + '/' + w.hp : 'none'})`);
}
// 2) build in the OPEN field -> sturdy hp 3
{
  const s = build(700, 550, 1, 0); // midfield, clear of bush/box
  const w = s.builtWalls[0];
  ok(w && !w.fragile && w.hp === 3, `wall in the open is STURDY hp3 (${w ? w.fragile + '/' + w.hp : 'none'})`);
}
// 3) build inside our PENALTY box -> fragile
{
  const s = build(120, 550, -1, 0); // team A own box is x<360; aim toward own goal keeps it in-box
  const w = s.builtWalls[0];
  ok(w && w.fragile === true, `wall inside a penalty box is FRAGILE (${w ? w.fragile : 'none'})`);
}
// 4) a QUICK shot (one bullet) breaks a fragile wall
{
  const s = createState(); s.resetTimer = 0;
  addPlayer(s, 'A', { name: 'a', char: 'player', team: 'A', slot: 0, isBot: true });
  s.builtWalls = [{ id: 9, x: 900, y: 480, w: 32, h: 160, hp: 1, maxHp: 1, team: 'B', fragile: true }];
  const p = s.players.A; p.x = 780; p.y = 560; p.aimX = 1; p.aimY = 0; p.ammo = 3;
  fireAt(s, 'A', 0.2, [1, 0]); // a QUICK (low-charge) shot
  for (let t = 0; t < 30; t++) step(s, inp('A'), DT);
  ok(s.builtWalls.length === 0, `a quick shot shatters the fragile wall (${s.builtWalls.length} left)`);
}
// 5) a POWER kick passes THROUGH a fragile wall (ball not bounced, wall destroyed)
{
  const s = createState(); s.resetTimer = 0;
  s.ball.owner = null; s.ball.lastTouch = 'A';
  s.ball.x = 840; s.ball.y = 560; s.ball.vx = 1500; s.ball.vy = 0; // power kick (>900)
  s.builtWalls = [{ id: 9, x: 900, y: 480, w: 32, h: 160, hp: 1, maxHp: 1, team: 'B', fragile: true }];
  for (let t = 0; t < 15; t++) step(s, {}, DT);
  ok(s.builtWalls.length === 0 && s.ball.vx > 0 && s.ball.x > 950, `power kick smashes THROUGH the fragile wall (x=${s.ball.x.toFixed(0)}, vx=${s.ball.vx.toFixed(0)}, walls=${s.builtWalls.length})`);
}
// 6) a SLOW ball still BOUNCES off a fragile wall (weak cover still works)
{
  const s = createState(); s.resetTimer = 0;
  s.ball.owner = null; s.ball.lastTouch = 'A';
  s.ball.x = 855; s.ball.y = 560; s.ball.vx = 500; s.ball.vy = 0; // below the power threshold
  s.builtWalls = [{ id: 9, x: 900, y: 480, w: 32, h: 160, hp: 1, maxHp: 1, team: 'B', fragile: true }];
  for (let t = 0; t < 8; t++) step(s, {}, DT);
  ok(s.builtWalls.length === 1 && s.ball.x < 900, `a slow ball is BLOCKED by the fragile wall (x=${s.ball.x.toFixed(0)}<900, wall intact=${s.builtWalls.length === 1})`);
}
// (wire round-trip of the fragile bit is validated end-to-end in the headless client check)

console.log(`\n${fails === 0 ? '✅ ALL PASS' : '❌ ' + fails + ' FAILED'}`);
process.exit(fails === 0 ? 0 : 1);
