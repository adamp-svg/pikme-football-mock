// Sim tests for the FIELD BUILDER engine (Phase A/B):
//  - buildArenaFromField shape (hard walls = capsules, bushes pass through)
//  - a HARD wall is indestructible (a bomb does NOT remove it) and shields like static stone
//  - a DRY wall is destructible AND respawns on (re)seed / kickoff
// Run: node test-field.mjs
import { createState, addPlayer, step, setField, seedFieldWalls } from './shared/sim.js';
import { buildArenaFromField, capsuleAABB, dryWallSeeds } from './shared/arena.js';
import { DT, BUILT_WALL, DRY_WALL_HP } from './shared/constants.js';

let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fails++; };
const inp = () => ({ seq: 1, moveX: 0, moveY: 0, aimX: 1, aimY: 0, hold: false, fire: false, special: false, build: false, buildHold: false, sax: 0, say: 0 });
const HL = BUILT_WALL.len / 2, HT = BUILT_WALL.thick / 2;

// A field with one hard wall + one dry wall (both horizontal capsules at y=625) + a bush.
const field = () => ({
  version: 1,
  bushes: [{ x: 300, y: 300, w: 200, h: 150 }],
  hardWalls: [{ cx: 1000, cy: 625, angle: 0, hl: HL, ht: HT }],
  dryWalls: [{ cx: 600, cy: 625, angle: 0, hl: HL, ht: HT }],
});

// 1) buildArenaFromField shape.
{
  const a = buildArenaFromField(field());
  const hw = a.walls[0];
  ok(a.walls.length === 1 && hw.angle === 0 && hw.hl === HL && typeof hw.w === 'number', `hard wall built as a capsule with derived AABB (w=${hw.w},h=${hw.h})`);
  ok(a.bushes.length === 1 && a.bushes[0].w === 200, `bush passes through`);
  const seeds = dryWallSeeds(field());
  ok(seeds.length === 1 && seeds[0].field === true && seeds[0].hp === DRY_WALL_HP, `dry wall seed: field=true hp=${seeds[0].hp}`);
}

// bomb-knock harness on a custom field
function bombKnock(bomb, tx, ty, f) {
  const s = createState(); s.resetTimer = 0;
  addPlayer(s, 'p1', { name: 'A', char: 'player', team: 'A', slot: 0 });
  addPlayer(s, 'p2', { name: 'B', char: 'player', team: 'B', slot: 0 });
  if (f) setField(s, f);
  s.players.p1.x = 150; s.players.p1.y = 150;
  const t = s.players.p2; t.x = tx; t.y = ty;
  s.bombs.push({ id: s._nid++, owner: 'p1', team: 'A', x: bomb.x, y: bomb.y, fuse: DT });
  step(s, { p1: inp(), p2: inp() }, DT);
  return { push: Math.hypot(t.kvx, t.kvy), s };
}

// 2) HARD wall shields a blast AND is indestructible.
{
  const open = bombKnock({ x: 1000, y: 560 }, 1000, 690, null).push;   // no field
  const r = bombKnock({ x: 1000, y: 560 }, 1000, 690, field());        // hard wall at y625 between
  ok(r.push < open * 0.05, `hard wall fully shields the blast (${r.push.toFixed(0)} << open ${open.toFixed(0)})`);
  ok(r.s.arena.walls.length === 1, `hard wall NOT destroyed by the bomb (still ${r.s.arena.walls.length} in arena.walls)`);
}

// 3) DRY wall: seeded, destructible, respawns on reseed.
{
  const s = createState(); s.resetTimer = 0;
  addPlayer(s, 'p1', { name: 'A', char: 'player', team: 'A', slot: 0 });
  setField(s, field());
  const dry0 = s.builtWalls.filter((w) => w.field);
  ok(dry0.length === 1 && dry0[0].hp === DRY_WALL_HP, `dry wall seeded into builtWalls (hp ${dry0[0].hp})`);
  // detonate a bomb ON it -> destroyed
  s.players.p1.x = 150; s.players.p1.y = 150;
  s.bombs.push({ id: s._nid++, owner: 'p1', team: 'A', x: 600, y: 625, fuse: DT });
  step(s, { p1: inp() }, DT);
  ok(s.builtWalls.filter((w) => w.field).length === 0, `bomb destroys the dry wall`);
  // simulate kickoff reseed
  s.builtWalls = s.builtWalls.filter((w) => !w.field);
  seedFieldWalls(s);
  const dry1 = s.builtWalls.filter((w) => w.field);
  ok(dry1.length === 1 && dry1[0].hp === DRY_WALL_HP, `dry wall RESPAWNS full-HP on kickoff reseed`);
}

console.log(fails ? `\n❌ ${fails} FAIL` : '\n✅ ALL PASS');
process.exit(fails ? 1 : 0);
