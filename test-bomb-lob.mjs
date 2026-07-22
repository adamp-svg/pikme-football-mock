// Sim unit tests for the aimable bomb lob (tap = feet, drag = short throw).
// Run: node test-bomb-lob.mjs   (exits non-zero on any failure)
import { createState, addPlayer, step } from './shared/sim.js';
import { DT, BOMB_LOB_RANGE } from './shared/constants.js';

let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fails++; };
const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;

function fresh() {
  const s = createState();
  s.resetTimer = 0;
  addPlayer(s, 'p1', { name: 'A', char: 'player', team: 'A', slot: 0 });
  addPlayer(s, 'p2', { name: 'B', char: 'player', team: 'B', slot: 0 });
  s.players.p1.x = 1000; s.players.p1.y = 550; s.players.p1.aimX = 1; s.players.p1.aimY = 0;
  return s;
}
function inp(o = {}) { return { seq: 1, moveX: 0, moveY: 0, aimX: 1, aimY: 0, hold: false, fire: false, special: false, build: false, buildHold: false, sax: 0, say: 0, ...o }; }

// 1) A tap (zero offset) plants the bomb at the planter's feet.
{
  const s = fresh();
  step(s, { p1: inp({ special: true, sax: 0, say: 0 }), p2: inp() }, DT);
  ok(s.bombs.length === 1, `bomb planted (n=${s.bombs.length})`);
  ok(near(s.bombs[0].x, 1000) && near(s.bombs[0].y, 550), `tap plants at feet (${s.bombs[0].x.toFixed(0)},${s.bombs[0].y.toFixed(0)})`);
}

// 2) A full drag (offset magnitude 1) lobs the bomb BOMB_LOB_RANGE along the aim.
{
  const s = fresh();
  step(s, { p1: inp({ special: true, aimX: 1, aimY: 0, sax: 1, say: 0 }), p2: inp() }, DT);
  ok(near(s.bombs[0].x, 1000 + BOMB_LOB_RANGE, 3), `full drag lobs to range (x=${s.bombs[0].x.toFixed(0)})`);
}

// 3) An over-magnitude offset is clamped to BOMB_LOB_RANGE.
{
  const s = fresh();
  step(s, { p1: inp({ special: true, aimX: 1, aimY: 0, sax: 5, say: 0 }), p2: inp() }, DT);
  ok(near(s.bombs[0].x, 1000 + BOMB_LOB_RANGE, 3), `offset clamped to range (x=${s.bombs[0].x.toFixed(0)})`);
}

// 4) Direction comes from the (sax,say) drag vector, NOT from aim: aiming +x but
//    dragging +y must lob the bomb along +y (matching the client's ghost), not +x.
{
  const s = fresh();
  step(s, { p1: inp({ special: true, aimX: 1, aimY: 0, sax: 0, say: 1 }), p2: inp() }, DT);
  ok(near(s.bombs[0].x, 1000), `perpendicular drag: x stays put (x=${s.bombs[0].x.toFixed(0)})`);
  ok(near(s.bombs[0].y, 550 + BOMB_LOB_RANGE, 3), `perpendicular drag: lobs along drag +y, not aim +x (y=${s.bombs[0].y.toFixed(0)})`);
}

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
