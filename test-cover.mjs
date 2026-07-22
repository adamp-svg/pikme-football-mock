// Sim tests for WALL COVER (spec R1–R4, 2026-07-23):
//  R1) indestructible wall in the launch dir cancels your OWN bomb-jump; a wall between
//      bomb and any victim blocks the blast entirely.
//  R2) bomb behind a BUILT wall: full-HP lets ~25% through, ramping to 100% as HP->0.
//  R3) wall-cannon: a wall behind the bomb boosts the launch — static +20%, built +15%×HP.
//  R4) super-shot behind a BUILT wall: full-HP(3)=10%, hp2=30%, hp1=50%; static blocks.
// Run: node test-cover.mjs   (exits non-zero on any failure)
import { createState, addPlayer, step } from './shared/sim.js';
import { DT, FIELD, BOMB, BUILT_WALL } from './shared/constants.js';
import { ARENA } from './shared/arena.js';

let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fails++; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
function fresh(arena) {
  const s = createState(); s.resetTimer = 0; if (arena) s.arena = arena;
  addPlayer(s, 'p1', { name: 'A', char: 'player', team: 'A', slot: 0 });
  addPlayer(s, 'p2', { name: 'B', char: 'player', team: 'B', slot: 0 });
  return s;
}
function inp(o = {}) { return { seq: 1, moveX: 0, moveY: 0, aimX: 1, aimY: 0, hold: false, fire: false, special: false, build: false, buildHold: false, sax: 0, say: 0, ...o }; }
function builtWall(id, cx, cy, angle, hp) {
  const hl = BUILT_WALL.len / 2, ht = BUILT_WALL.thick / 2;
  const ca = Math.abs(Math.cos(angle)), sa = Math.abs(Math.sin(angle));
  const w = Math.round((ca * hl + sa * ht) * 2), h = Math.round((sa * hl + ca * ht) * 2);
  return { id, x: cx - w / 2, y: cy - h / 2, w, h, hp, maxHp: BUILT_WALL.hp, fragile: false, cx, cy, angle, hl, ht, team: 'A', ttl: 0 };
}
function bombKnock(bomb, tx, ty, walls) {
  const s = fresh();
  s.players.p1.x = 150; s.players.p1.y = 150;
  const t = s.players.p2; t.x = tx; t.y = ty;
  if (walls) s.builtWalls = walls;
  s.bombs.push({ id: s._nid++, owner: 'p1', team: 'A', x: bomb.x, y: bomb.y, fuse: DT });
  step(s, { p1: inp(), p2: inp() }, DT);
  return Math.hypot(t.kvx, t.kvy);
}

// R1 (blast) + baseline: static wall between bomb and target fully blocks.
{
  const kOpen = bombKnock({ x: 1000, y: 560 }, 1000, 690, null);
  const sw = ARENA.walls[0];
  const kStatic = bombKnock({ x: sw.x - 5, y: sw.y + sw.h / 2 }, sw.x + sw.w + 24, sw.y + sw.h / 2, null);
  ok(kOpen > 300, `open-field blast flings hard (|kv|=${kOpen.toFixed(0)})`);
  ok(kStatic < kOpen * 0.05, `R1: static wall fully blocks the blast (${kStatic.toFixed(0)} << ${kOpen.toFixed(0)})`);
}

// R2: bomb behind a BUILT wall — full-HP ~25%, hp1 ~75%, monotonic.
{
  const kOpen = bombKnock({ x: 1000, y: 560 }, 1000, 690, null);
  const bomb = { x: 1000, y: 560 };
  const mk = (hp) => [builtWall(1, 1000, 625, 0, hp)];
  const k3 = bombKnock(bomb, 1000, 690, mk(3));
  const k2 = bombKnock(bomb, 1000, 690, mk(2));
  const k1 = bombKnock(bomb, 1000, 690, mk(1));
  ok(near(k3 / kOpen, 0.25, 0.10), `R2: full-HP built wall lets ~25% through (${(k3 / kOpen * 100).toFixed(0)}%)`);
  ok(k1 > k2 && k2 > k3, `R2: weaker wall leaks more (hp1 ${k1.toFixed(0)} > hp2 ${k2.toFixed(0)} > hp3 ${k3.toFixed(0)})`);
  ok(k1 < kOpen, `R2: even hp1 leaks less than open field (${k1.toFixed(0)} < ${kOpen.toFixed(0)})`);
}

// R1 self-jump: your own bomb-jump is cancelled by a static wall in the launch direction,
// but still fires when you jump toward open space.
{
  const WALL = { x: 900, y: 500, w: 40, h: 240 };
  const MOCK = { walls: [WALL], bushes: [], trampolines: [] };
  function selfJump(aimX) {
    const s = fresh(MOCK);
    const p = s.players.p1; p.x = 1000; p.y = 620; p.aimX = aimX; p.aimY = 0; // clear RIGHT of the wall (no overlap)
    s.players.p2.x = 150; s.players.p2.y = 150;
    s.bombs.push({ id: s._nid++, owner: 'p1', team: 'A', x: p.x, y: p.y, fuse: DT });
    step(s, { p1: inp({ aimX, aimY: 0 }), p2: inp() }, DT);
    return Math.hypot(p.kvx, p.kvy);
  }
  const towardWall = selfJump(-1);  // launch LEFT into the stone -> cancelled
  const awayFromWall = selfJump(1); // launch RIGHT into open space -> normal jump
  ok(towardWall < 1, `R1: bomb-jump INTO a static wall is cancelled (|kv|=${towardWall.toFixed(0)})`);
  ok(awayFromWall > 300, `R1: bomb-jump toward open space still launches (|kv|=${awayFromWall.toFixed(0)})`);
}

// R3: wall-cannon — a static wall BEHIND the launch boosts it, capped ~+20% vs open.
{
  const WALL = { x: 900, y: 500, w: 40, h: 240 };
  const MOCK = { walls: [WALL], bushes: [], trampolines: [] };
  function selfJump(arena, px) {
    const s = fresh(arena); const p = s.players.p1; p.x = px; p.y = 620; p.aimX = 1; p.aimY = 0; // launch RIGHT
    s.players.p2.x = 150; s.players.p2.y = 150;
    s.bombs.push({ id: s._nid++, owner: 'p1', team: 'A', x: p.x, y: p.y, fuse: DT });
    step(s, { p1: inp({ aimX: 1, aimY: 0 }), p2: inp() }, DT);
    return Math.hypot(p.kvx, p.kvy);
  }
  const open = selfJump(null, 1000);   // no wall behind
  const cannon = selfJump(MOCK, 955);  // wall at x900-940 is just BEHIND a right-launch
  ok(cannon > open, `R3: static wall behind the launch cannons harder (${cannon.toFixed(0)} > open ${open.toFixed(0)})`);
  ok(cannon <= open * 1.25, `R3: static cannon capped ~+20% (+${(cannon / open * 100 - 100).toFixed(0)}%)`);
}

// R4: super (overcharge) shot behind a BUILT wall — 10% / 30% / 50% by HP.
function superShotKnock(hp) {
  const s = fresh();
  s.ball.x = 200; s.ball.y = 200;
  const from = { x: 880, y: 550 }, to = { x: 1120, y: 550 };
  s.players.p1.x = from.x; s.players.p1.y = from.y;
  const t = s.players.p2; t.x = to.x; t.y = to.y;
  if (hp != null) s.builtWalls = [builtWall(1, 1000, 550, Math.PI / 2, hp)];
  const dx = to.x - from.x, dy = to.y - from.y, l = Math.hypot(dx, dy);
  s.projectiles.push({ id: s._nid++, owner: 'p1', team: 'A', x: from.x + (dx / l) * 30, y: from.y, vx: (dx / l) * 720, vy: (dy / l) * 720, dist: 0, charge: 1, over: true, cmul: 1 });
  let maxKv = 0;
  for (let i = 0; i < 45; i++) { step(s, { p1: inp(), p2: inp() }, DT); maxKv = Math.max(maxKv, Math.hypot(t.kvx, t.kvy)); }
  return maxKv;
}
{
  const kNo = superShotKnock(null);
  const k3 = superShotKnock(3), k2 = superShotKnock(2), k1 = superShotKnock(1);
  ok(kNo > 300, `super shot with no wall hits full (|kv|=${kNo.toFixed(0)})`);
  ok(near(k3 / kNo, 0.10, 0.06), `R4: super behind full-HP built wall ~10% (${(k3 / kNo * 100).toFixed(0)}%)`);
  ok(near(k2 / kNo, 0.30, 0.09), `R4: super behind hp2 built wall ~30% (${(k2 / kNo * 100).toFixed(0)}%)`);
  ok(near(k1 / kNo, 0.50, 0.12), `R4: super behind hp1 built wall ~50% (${(k1 / kNo * 100).toFixed(0)}%)`);
  ok(k1 > k2 && k2 > k3, `R4: weaker wall lets more push (hp1 ${k1.toFixed(0)} > hp2 ${k2.toFixed(0)} > hp3 ${k3.toFixed(0)})`);
}

console.log(fails ? `\n❌ ${fails} FAIL` : '\n✅ ALL PASS');
process.exit(fails ? 1 : 0);
