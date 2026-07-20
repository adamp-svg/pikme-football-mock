// Repro harness for "players stuck in walls". Drives a player into every stone
// wall from many angles (incl. knockback into a wall, and wedged between built
// walls), and flags: (a) center ending up INSIDE a wall box, (b) unable to escape
// when steering away. Run: node test-stuck.mjs
import { createState, addPlayer, step } from './shared/sim.js';
import { DT } from './shared/constants.js';
import { ARENA, pointInBox } from './shared/arena.js';

let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };

function fresh() {
  const s = createState(); s.resetTimer = 0;
  addPlayer(s, 'P', { name: 'p', char: 'player', team: 'A', slot: 0, isBot: true });
  return s;
}
function inAnyWall(p) { return ARENA.walls.some((w) => pointInBox(p.x, p.y, w)) || (Array.isArray(p._bw) && false); }
const inp = (mx, my) => ({ P: { seq: 1, moveX: mx, moveY: my, aimX: mx || 1, aimY: my, shoot: false, special: false, build: false, charge: 0 } });

// 1) Drive INTO each wall from 8 directions; player must never end up inside the box.
{
  let insideEver = false, maxInside = 0;
  for (const w of ARENA.walls) {
    const cx = w.x + w.w / 2, cy = w.y + w.h / 2;
    for (let a = 0; a < 8; a++) {
      const ang = a / 8 * Math.PI * 2;
      const s = fresh(); const p = s.players.P;
      p.x = cx - Math.cos(ang) * 260; p.y = cy - Math.sin(ang) * 260; // start outside, aim at centre
      for (let t = 0; t < 90; t++) { step(s, inp(Math.cos(ang), Math.sin(ang)), DT); if (pointInBox(p.x, p.y, w)) { insideEver = true; maxInside++; } }
    }
  }
  ok(!insideEver, `push into walls from all sides never lands the centre inside a wall (${maxInside} inside-ticks)`);
}

// 2) Knockback INTO a wall (simulate a bomb/tramp launch straight at a wall face).
{
  let insideEver = false;
  for (const w of ARENA.walls) {
    const cx = w.x + w.w / 2, cy = w.y + w.h / 2;
    for (const [kx, ky] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1]]) {
      const s = fresh(); const p = s.players.P;
      p.x = cx - kx * 220; p.y = cy - ky * 220;
      p.kvx = kx * 3400; p.kvy = ky * 3400; // big launch toward the wall
      for (let t = 0; t < 60; t++) { step(s, inp(0, 0), DT); if (pointInBox(p.x, p.y, w)) insideEver = true; }
    }
  }
  ok(!insideEver, 'a full-power knockback into a wall never leaves the player embedded inside it');
}

// 3) Escape: sit against a wall face, then steer AWAY — must actually get free.
{
  let stuck = 0;
  for (const w of ARENA.walls) {
    const cx = w.x + w.w / 2;
    const s = fresh(); const p = s.players.P;
    p.x = w.x - 10; p.y = w.y + w.h / 2; // just left of the wall, overlapping
    for (let t = 0; t < 20; t++) step(s, inp(1, 0), DT);   // press into it a bit
    const x0 = p.x;
    for (let t = 0; t < 40; t++) step(s, inp(-1, 0), DT);  // now flee left
    if (p.x > x0 - 55) stuck++; // free-speed gives ~95px over 40 ticks @60Hz; <55px = impeded
  }
  ok(stuck === 0, `player can always escape a wall when steering away (${stuck} stuck)`);
}

// 4) Wedge between two built walls with knockback — must not embed.
{
  const s = fresh(); const p = s.players.P;
  s.builtWalls = [
    { id: 1, x: 900, y: 500, w: 32, h: 180, hp: 3, maxHp: 3, team: 'B' },
    { id: 2, x: 1050, y: 500, w: 32, h: 180, hp: 3, maxHp: 3, team: 'B' },
  ];
  p.x = 990; p.y = 560;
  let inside = false;
  for (const [kx, ky] of [[1, 0], [-1, 0], [1, 1], [-1, 1]]) {
    p.kvx = kx * 3000; p.kvy = ky * 3000;
    for (let t = 0; t < 40; t++) { step(s, inp(kx, 0), DT); if (s.builtWalls.some((w) => pointInBox(p.x, p.y, w))) inside = true; }
  }
  ok(!inside, 'player never embeds between two built walls under knockback');
}

console.log(`\n${fails === 0 ? '✅ NO STUCK BUG REPRODUCED' : '❌ ' + fails + ' STUCK CASE(S)'}`);
process.exit(fails === 0 ? 0 : 1);
