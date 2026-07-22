// Sim tests for WALL COVER:
//  1) a bomb blast is fully BLOCKED by a static (indestructible) wall
//  2) a bomb blast is SOFTENED by a built wall — strong wall = minor push, weak = more
//  3) shots are blocked/downgraded by a built wall's HP (super -> full -> half -> blocked)
// Run: node test-cover.mjs   (exits non-zero on any failure)
import { createState, addPlayer, step } from './shared/sim.js';
import { DT, FIELD, BOMB, BUILT_WALL } from './shared/constants.js';
import { ARENA } from './shared/arena.js';

let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fails++; };
function fresh() {
  const s = createState(); s.resetTimer = 0;
  addPlayer(s, 'p1', { name: 'A', char: 'player', team: 'A', slot: 0 }); // bomber / shooter
  addPlayer(s, 'p2', { name: 'B', char: 'player', team: 'B', slot: 0 }); // target
  return s;
}
function inp(o = {}) { return { seq: 1, moveX: 0, moveY: 0, aimX: 1, aimY: 0, hold: false, fire: false, special: false, build: false, buildHold: false, sax: 0, say: 0, ...o }; }
// A built-wall capsule centred at (cx,cy), oriented by `angle`, with `hp` (maxHp 3).
function builtWall(id, cx, cy, angle, hp) {
  const hl = BUILT_WALL.len / 2, ht = BUILT_WALL.thick / 2;
  const ca = Math.abs(Math.cos(angle)), sa = Math.abs(Math.sin(angle));
  const w = Math.round((ca * hl + sa * ht) * 2), h = Math.round((sa * hl + ca * ht) * 2);
  return { id, x: cx - w / 2, y: cy - h / 2, w, h, hp, maxHp: BUILT_WALL.hp, fragile: false, cx, cy, angle, hl, ht, team: 'A', ttl: 0 };
}

// --- Bomb blast: measure the target's raw knockback impulse (read right after detonation) ---
function bombKnock(bomb, tx, ty, walls) {
  const s = fresh();
  s.players.p1.x = 150; s.players.p1.y = 150;         // bomber far (no self-launch, not the target)
  const t = s.players.p2; t.x = tx; t.y = ty;
  if (walls) s.builtWalls = walls;
  s.bombs.push({ id: s._nid++, owner: 'p1', team: 'A', x: bomb.x, y: bomb.y, fuse: DT });
  step(s, { p1: inp(), p2: inp() }, DT);              // one step detonates and sets kv
  return Math.hypot(t.kvx, t.kvy);
}

// 1) Open field baseline vs a STATIC wall directly between bomb and target.
{
  const kOpen = bombKnock({ x: 1000, y: 560 }, 1000, 690, null); // clear centre, ~130 apart
  // static wall {560,250,120,120}: bomb left of it, target right, line crosses the wall
  const sw = ARENA.walls[0];
  const kStatic = bombKnock({ x: sw.x - 5, y: sw.y + sw.h / 2 }, sw.x + sw.w + 24, sw.y + sw.h / 2, null);
  ok(kOpen > 300, `open-field blast flings the target hard (|kv|=${kOpen.toFixed(0)})`);
  ok(kStatic < kOpen * 0.05, `static wall BLOCKS the blast (|kv|=${kStatic.toFixed(0)} << open ${kOpen.toFixed(0)})`);
}

// 2) Built wall between bomb and target: strong (hp3) softens more than weak (hp1).
{
  const kOpen = bombKnock({ x: 1000, y: 560 }, 1000, 690, null);
  const bomb = { x: 1000, y: 560 };
  const mkWall = (hp) => [builtWall(1, 1000, 625, 0, hp)]; // horizontal capsule between bomb (y560) and target (y690)
  const kStrong = bombKnock(bomb, 1000, 690, mkWall(3));
  const kWeak = bombKnock(bomb, 1000, 690, mkWall(1));
  ok(kStrong > 0 && kStrong < kOpen * 0.35, `STRONG built wall = minor pushback (|kv|=${kStrong.toFixed(0)}, open ${kOpen.toFixed(0)})`);
  ok(kWeak > kStrong * 1.4, `WEAK built wall pushes back harder than a strong one (weak ${kWeak.toFixed(0)} > strong ${kStrong.toFixed(0)})`);
  ok(kWeak < kOpen, `...but still less than no wall (weak ${kWeak.toFixed(0)} < open ${kOpen.toFixed(0)})`);
}

// --- Shots: a SUPER (overcharge) bullet through a built wall, by wall HP ---
function superShotKnock(hp) {
  const s = fresh();
  s.ball.x = 200; s.ball.y = 200; // move the kickoff ball out of the bullet's path
  const from = { x: 880, y: 550 }, to = { x: 1120, y: 550 };
  s.players.p1.x = from.x; s.players.p1.y = from.y;
  const t = s.players.p2; t.x = to.x; t.y = to.y;
  if (hp != null) s.builtWalls = [builtWall(1, 1000, 550, Math.PI / 2, hp)]; // vertical capsule blocks the horizontal shot
  const dx = to.x - from.x, dy = to.y - from.y, l = Math.hypot(dx, dy);
  s.projectiles.push({ id: s._nid++, owner: 'p1', team: 'A', x: from.x + (dx / l) * 30, y: from.y, vx: (dx / l) * 720, vy: (dy / l) * 720, dist: 0, charge: 1, over: true, cmul: 1 });
  let maxKv = 0;
  for (let i = 0; i < 45; i++) { step(s, { p1: inp(), p2: inp() }, DT); maxKv = Math.max(maxKv, Math.hypot(t.kvx, t.kvy)); }
  return maxKv;
}
{
  const kNoWall = superShotKnock(null); // super shot, no wall -> full hit
  const kHp3 = superShotKnock(3);       // strong wall: super DESTROYS it, a LITTLE push leaks through
  const kHp2 = superShotKnock(2);       // -1 hp -> passes as a downgraded (half) shot
  const kHp1 = superShotKnock(1);       // -2 hp -> passes as a stronger (full) shot
  ok(kNoWall > 300, `super shot with NO wall hits full force (|kv|=${kNoWall.toFixed(0)})`);
  ok(kHp3 > 1 && kHp3 < kNoWall, `STRONG wall (hp3): a SUPER shot destroys it and leaks a LITTLE push through (|kv|=${kHp3.toFixed(0)} vs full ${kNoWall.toFixed(0)})`);
  ok(kHp2 > 1, `weakened wall (hp2) lets a downgraded shot through (|kv|=${kHp2.toFixed(0)})`);
  ok(kHp1 > kHp2, `weaker wall (hp1) lets MORE power through than hp2 (${kHp1.toFixed(0)} > ${kHp2.toFixed(0)})`);
  ok(kHp1 <= kNoWall + 1, `...never more than the unobstructed shot (${kHp1.toFixed(0)} <= ${kNoWall.toFixed(0)})`);
}

console.log(fails ? `\n❌ ${fails} FAIL` : '\n✅ ALL PASS');
process.exit(fails ? 1 : 0);
