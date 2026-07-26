// Wall-AABB overflow + wire-field range audit.
//
// The snapshot codec packs a wall's AABB extents through `u8`, which masks `& 255` with no
// clamp. A wall's AABB is NOT a small number: it is derived by capsuleAABB() from (angle, hl,
// ht), and sanitizeField() in server.js admits hl up to 300 / ht up to 60 — so a vertical dry
// wall's AABB h reaches 2*300 = 600. 600 & 255 = 88.
//
// Why that is visible: decodeSnapshot rebuilds the wall's CENTRE as `cy = y + h/2`, and the
// client draws (wallSlab) and predicts collision (nearestOnWall) from cx/cy. A wrapped h moves
// the drawn+predicted wall (600-88)/2 = 256px away from where the server collides.
//
// The geometry ranges below are read off the real producers, not invented:
//   hl, ht      server.js sanitizeField(): num(w.hl, 20, 300, 88), num(w.ht, 8, 60, 16)
//   angle       16 quantized steps over a half turn (shared/arena.js WALL_ANGLE_STEPS)
//   w, h        shared/arena.js capsuleAABB() -> 2*(|cos|*hl + |sin|*ht), 2*(|sin|*hl + |cos|*ht)
// This file also pins the other range hazards the same audit turned up (section counts,
// rosterVersion, score, fractional wall HP) so they cannot silently come back.
import { encodeKeyframe, decodeSnapshot } from './shared/wire.js';
import { capsuleAABB, WALL_ANGLE_STEPS, WALL_ANGLE_QUANT } from './shared/arena.js';
import { BOMB, BUILT_WALL, DRY_WALL_HP } from './shared/constants.js';

let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + '  ' + m); if (!c) fails++; };
const near = (a, b, t = 1e-9) => Math.abs(a - b) <= t;

const slotId = ['m-1'], slotTeam = ['A'];
const mkP = () => ({ id: 'm-1', char: 'player', team: 'A', x: 900, y: 400, vx: 0, vy: 0, aimX: 1, aimY: 0, firing: false, reloading: false, ammo: 3, buildAmmo: 2, reloadFrac: 0, buildFrac: 0, lastSeq: 1 });
const base = (over = {}) => ({
  type: 'snapshot', phase: 'match', elapsed: 10, resetTimer: 0, lastGoal: null, score: { A: 0, B: 0 },
  ball: { x: 1000, y: 550, owner: null }, players: [mkP()],
  projectiles: [], walls: [], bombs: [], blasts: [], impacts: [], ...over,
});
// A field dry wall exactly as shared/arena.js dryWallSeeds() builds it, then exactly as
// server.js snapshot() reshapes it for the wire.
// `cx`/`cy` are carried on the object for the test's own bookkeeping only — server.js's
// snapshot() does NOT put them on the wire object, the decoder derives them from x + w/2.
const dryWall = (cx, cy, angle, hl, ht, id = 21) => ({
  id, ...capsuleAABB(cx, cy, angle, hl, ht), hp: DRY_WALL_HP, maxHp: DRY_WALL_HP,
  team: null, fragile: false, angle, hl, ht, cx, cy,
});
const roundTripWall = (w) => {
  const buf = encodeKeyframe(base({ walls: [w] }), slotId, 7);
  return decodeSnapshot(new DataView(buf), slotId, slotTeam, 7).walls[0];
};

console.log('--- 1. the reported repro: a long vertical dry wall ---');
{
  // hl 300 / ht 60 is the largest capsule sanitizeField() will pass through.
  const w = dryWall(1000, 550, Math.PI / 2, 300, 60);
  ok(w.h === 600, `producer really makes h=600 (capsuleAABB) — got ${w.h}`);
  const d = roundTripWall(w);
  ok(d.h === w.h, `AABB h survives the wire (sent ${w.h}, got ${d.h})`);
  ok(d.w === w.w, `AABB w survives the wire (sent ${w.w}, got ${d.w})`);
  ok(near(d.cy, 550, 0.5), `wall centre cy reconstructs (want 550, got ${d.cy}) — this is what the client draws AND collides against`);
  ok(d.hl === 300, `hl survives the wire (sent 300, got ${d.hl})`);
}

console.log('\n--- 2. an ORDINARY builder wall, not just the extreme ---');
{
  // The builder makes a wall by dragging cell to cell: hl = round((dist + FB_GRID)/2) with
  // FB_GRID 50 (public/client.js fbDrawUpdate). A 5-cell vertical drag = dist 250 -> hl 150.
  const w = dryWall(1000, 550, Math.PI / 2, 150, 16);
  ok(w.h === 300, `5-cell vertical drag really makes h=300 — got ${w.h}`);
  const d = roundTripWall(w);
  ok(d.h === 300, `h survives (got ${d.h})`);
  ok(near(d.cy, 550, 0.5), `cy reconstructs (want 550, got ${d.cy})`);
  // hl 127 is the last vertical wall that fits: 2*127 = 254.
  const okw = dryWall(1000, 550, Math.PI / 2, 127, 16);
  const dok = roundTripWall(okw);
  ok(dok.h === okw.h && near(dok.cy, 550, 0.5), `hl 127 (h ${okw.h}) was always fine — the break starts at hl 128`);
}

console.log('\n--- 3. exhaustive sweep of the sanitize-legal capsule domain ---');
{
  let bad = 0, worst = 0, worstDesc = '';
  for (let hl = 20; hl <= 300; hl += 4) {
    for (const ht of [8, 16, 32, 60]) {
      for (let s = 0; s < WALL_ANGLE_STEPS; s++) {
        const angle = s * WALL_ANGLE_QUANT;
        const w = dryWall(1000, 550, angle, hl, ht);
        const d = roundTripWall(w);
        const err = Math.max(Math.abs(d.w - w.w), Math.abs(d.h - w.h), Math.abs(d.hl - w.hl));
        // The centre is what the client DRAWS and COLLIDES with, so measure the error there.
        const off = Math.max(Math.abs(d.cx - 1000), Math.abs(d.cy - 550));
        if (err > 0 || off > 0.5) {
          bad++;
          if (off > worst) { worst = off; worstDesc = `hl ${hl} ht ${ht} step ${s}: sent w${w.w}/h${w.h}/hl${w.hl} got w${d.w}/h${d.h}/hl${d.hl} -> centre off ${off.toFixed(1)}px`; }
        }
      }
    }
  }
  if (bad) console.log('    worst:', worstDesc);
  ok(bad === 0, `every legal capsule round-trips exactly (${bad} of the swept cases corrupt, worst centre error ${worst.toFixed(1)}px)`);
}

console.log('\n--- 4. player-built walls must not regress (hl 22 blocks) ---');
{
  const hl = BUILT_WALL.len / 2 / 4, ht = BUILT_WALL.thick / 2; // WALL_BLOCKS = 4
  const w = { id: 30, ...capsuleAABB(1000, 550, Math.PI / 2, hl, ht), hp: 1.0, maxHp: BUILT_WALL.hp, team: 'B', fragile: false, angle: Math.PI / 2, hl, ht };
  const d = roundTripWall(w);
  ok(d.w === w.w && d.h === w.h && d.hl === hl && d.ht === ht, `built block exact (w${d.w} h${d.h} hl${d.hl} ht${d.ht})`);
  ok(d.team === 'B' && d.hp === 1 && d.maxHp === BUILT_WALL.hp, 'built block team/hp/maxHp exact');
}

console.log('\n--- 5. a HALF-damaged wall must not read a whole HP tier low ---');
{
  // sim.js: a mid-charge shot does BUILT_WALL.hp/2 = 1.5 damage, so hp 1.5 is an everyday
  // value; `Math.min(hp,3) << 1` TRUNCATES it to 1, so the client draws the wall one crack
  // stage nearer death than it is. sim.js's own display tier is Math.round(hp).
  const w = { id: 31, ...capsuleAABB(1000, 550, 0, 22, 16), hp: 1.5, maxHp: BUILT_WALL.hp, team: 'A', fragile: false, angle: 0, hl: 22, ht: 16 };
  ok(roundTripWall(w).hp === 2, `hp 1.5 rounds to 2 like the sim does (got ${roundTripWall(w).hp})`);
}

console.log('\n--- 6. a long-lived room must not freeze on rosterVersion wrap ---');
{
  // server.js keeps `room.rosterVersion++` as a plain int and sends it BOTH raw (the JSON
  // roster msg, which is what the client holds) and through u8 here. At 256 the byte says 0
  // while the client holds 256, so the seam guard rejects EVERY frame from then on.
  const buf = encodeKeyframe(base(), slotId, 256);
  ok(decodeSnapshot(new DataView(buf), slotId, slotTeam, 256) !== null, 'rv 256 frame is accepted by a client holding 256');
  const buf2 = encodeKeyframe(base(), slotId, 300);
  ok(decodeSnapshot(new DataView(buf2), slotId, slotTeam, 299) === null, 'rv 300 frame is still REJECTED by a client holding 299');
}

console.log('\n--- 7. a >255-entry section must not desync the whole frame ---');
{
  // The section header is `u8(arr.length & 255)` but the loop then writes EVERY element, so a
  // 300-entry list declares 44 and emits 300 -> the reader is 256 records adrift and parses
  // walls/bombs/blasts out of projectile bytes. sim.js caps projectiles at 50 and impacts at
  // 30 today, so this is latent; a codec must not depend on a cap in another file.
  const projectiles = [];
  for (let i = 0; i < 300; i++) projectiles.push({ id: 1000 + i, x: 100, y: 100, team: 'A' });
  const wall = dryWall(1000, 550, 0, 50, 16, 77);
  const buf = encodeKeyframe(base({ projectiles, walls: [wall] }), slotId, 7);
  const d = decodeSnapshot(new DataView(buf), slotId, slotTeam, 7);
  ok(d.projectiles.length === 255, `projectile section truncates to 255 (got ${d.projectiles.length})`);
  ok(d.walls.length === 1 && d.walls[0].id === 77, `the wall AFTER the huge section still parses (got ${JSON.stringify(d.walls.map((w) => w.id))})`);
}

console.log('\n--- 8. score must saturate, not wrap ---');
{
  const d = decodeSnapshot(new DataView(encodeKeyframe(base({ score: { A: 300, B: 4 } }), slotId, 7)), slotId, slotTeam, 7);
  ok(d.score.A === 255, `score 300 saturates to 255, not 44 (got ${d.score.A})`);
  ok(d.score.B === 4, 'the byte after score.A is unaffected');
}

console.log('\n--- 9. entity ids must WRAP, not saturate ---');
{
  // state._nid is an unbounded ++ shared by every projectile/impact/blast/bomb/wall, and an
  // endless training/builder match crosses 65535. Wrapping aliases an id with one 65536 spawns
  // older (long dead); saturating would give EVERY later entity the same id and collapse the
  // client's per-id interpolation and per-bullet pierce sets.
  const projectiles = [{ id: 65536, x: 1, y: 1, team: 'A' }, { id: 65537, x: 2, y: 2, team: 'A' }];
  const d = decodeSnapshot(new DataView(encodeKeyframe(base({ projectiles }), slotId, 7)), slotId, slotTeam, 7);
  ok(d.projectiles[0].id !== d.projectiles[1].id, `ids past 65535 stay DISTINCT (got ${d.projectiles[0].id} and ${d.projectiles[1].id})`);
  ok(d.projectiles[0].id === 0 && d.projectiles[1].id === 1, 'ids wrap mod 65536');
}

console.log('\n--- 10. wall record width (so a future field addition is a deliberate act) ---');
{
  const n0 = encodeKeyframe(base(), slotId, 7).byteLength;
  const n1 = encodeKeyframe(base({ walls: [dryWall(1000, 550, 0, 50, 16)] }), slotId, 7).byteLength;
  ok(n1 - n0 === 15, `one wall costs 15 B: id2 x2 y2 w2 h2 flags1 maxHp1 hl2 ht1 (got ${n1 - n0})`);
}

console.log('\n--- 11. frame size (the codec exists to be small — watch the cost) ---');
{
  const walls = [];
  for (let i = 0; i < 12; i++) walls.push(dryWall(400 + i * 30, 550, 0, 22, 16, 40 + i)); // 4 dry + 8 built blocks
  const snap = base({
    walls,
    projectiles: [{ id: 1, x: 1, y: 1, team: 'A' }, { id: 2, x: 2, y: 2, team: 'B' }],
    bombs: [{ id: 3, x: 1, y: 1, team: 'A', fuse: BOMB.fuse, owner: 'm-1' }],
  });
  const n = encodeKeyframe(snap, slotId, 7).byteLength;
  console.log(`    1 player + 12 walls + 2 shots + 1 bomb = ${n} B (vs ${JSON.stringify(snap).length} B JSON)`);
  ok(n < 300, `frame stays well under the JSON it replaced (${n} B)`);
}

console.log('\n' + (fails === 0 ? '✅ ALL PASS' : '❌ ' + fails + ' FAILURE(S)'));
process.exit(fails ? 1 : 0);
