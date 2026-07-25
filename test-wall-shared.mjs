// Sim unit tests for the SHARED-ZONE health of a player-built wall.
// A build is 4 blocks sharing a wallId, split into two zones: SOLID (open ground, hp3) and
// WEAK (in a bush/penalty, hp1). Each zone acts as ONE unit — damage to any block drains every
// same-zone block of that group together. So half a wall in a bush keeps the solid half at full
// health while the weak half breaks off first. Verified end-to-end via real shots.
// Run: node test-wall-shared.mjs   (exits non-zero on any failure)
import { createState, addPlayer, step, setField, WALL_BLOCKS } from './shared/sim.js';
import { DT, BUILD_WINDUP, BUILT_WALL, FIELD, SHOOT_CHARGE_TIME } from './shared/constants.js';

let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };
const inp = (o = {}) => ({ seq: 1, moveX: 0, moveY: 0, aimX: 1, aimY: 0, hold: false, fire: false, special: false, build: false, buildHold: false, sax: 0, say: 0, ...o });

function fresh(field) {
  const s = createState(); s.resetTimer = 0;
  addPlayer(s, 'p1', { name: 'A', char: 'player', team: 'A', slot: 0 });
  addPlayer(s, 'p2', { name: 'B', char: 'player', team: 'B', slot: 0 });
  if (field) setField(s, field);
  return s;
}
// Build a vertical wall (aim +x) ahead of p1 at (px,py); returns the player-built blocks.
function build(s, px, py) {
  s.ball.owner = null; s.ball.x = 100; s.ball.y = 100; s.ball.vx = 0; s.ball.vy = 0; // park the ball (no auto-grab -> windup won't reset)
  const p = s.players.p1;
  p.x = px; p.y = py; p.aimX = 1; p.aimY = 0; p.buildCd = 0; p.buildAmmo = 9;
  const k = Math.round(BUILD_WINDUP / DT) + 1;
  for (let i = 0; i < k; i++) step(s, { p1: inp({ buildHold: true }), p2: inp() }, DT);
  step(s, { p1: inp({ buildHold: false, build: true }), p2: inp() }, DT);
  return s.builtWalls.filter((w) => !w.field);
}
// Fire ONE shot from p1 straight through `block` (aim +x). A quick/tap shot is slow, so stand
// CLOSE to the block's near edge (like test-mechanics does). charge 0 = tap (chips 1 HP);
// charge 1 = full (destroys a full-HP zone in one hit). Park the ball so p1 isn't carrying.
function shootAt(s, block, charge) {
  s.ball.owner = null; s.ball.x = 100; s.ball.y = 100;
  const p = s.players.p1;
  p.x = block.x - 70; p.y = block.cy; p.aimX = 1; p.aimY = 0; p.ammo = 5; p.kvx = 0; p.kvy = 0;
  p.shootCd = 0; p.reloadLock = 0; // clear per-shot pacing so this test's back-to-back shots all fire
  const n = Math.max(0, Math.round(charge * SHOOT_CHARGE_TIME * 60));
  for (let i = 0; i < n; i++) step(s, { p1: inp({ hold: true, moveX: 0 }), p2: inp() }, DT);
  step(s, { p1: inp({ fire: true }), p2: inp() }, DT);
  for (let i = 0; i < 90 && s.projectiles.length; i++) step(s, { p1: inp(), p2: inp() }, DT);
}
const solids = (bs) => bs.filter((b) => !b.fragile);
const weaks = (bs) => bs.filter((b) => b.fragile);
const hps = (bs) => bs.map((b) => b.hp).join(',');

// Build a half-bush wall and confirm the split, then learn a solid + a weak block to aim at.
function halfBushState() {
  // Open build first to learn where the vertical wall lands.
  const probe = fresh(null); const pb = build(probe, 1000, 550);
  const cx = pb[0].cx, midY = pb.reduce((a, b) => a + b.cy, 0) / pb.length;
  // Bush covering only y < midY (the wall's upper half) → upper blocks weak, lower blocks solid.
  const field = { version: 1, bushes: [{ x: cx - 200, y: 0, w: 400, h: midY }], hardWalls: [], dryWalls: [], crates: [] };
  const s = fresh(field); const bs = build(s, 1000, 550);
  return { s, bs };
}

// ---- 0) Sanity: a half-bush wall splits into a SOLID zone + a WEAK zone. ----
{
  const { bs } = halfBushState();
  ok(bs.length === WALL_BLOCKS, `wall is ${WALL_BLOCKS} blocks (${bs.length})`);
  ok(solids(bs).length >= 1 && weaks(bs).length >= 1, `split into solid + weak zones (solid=${solids(bs).length}, weak=${weaks(bs).length})`);
  ok(solids(bs).every((b) => b.hp === BUILT_WALL.hp) && weaks(bs).every((b) => b.hp === 1), `solid=hp${BUILT_WALL.hp}, weak=hp1 (${hps(bs)})`);
}

// ---- 1) A TAP on the SOLID zone drains ALL solid blocks by 1 (shared) — weak zone untouched. ----
{
  const { s, bs } = halfBushState();
  const solidBefore = solids(bs).length, weakBefore = weaks(bs).length;
  shootAt(s, solids(bs)[0], 0); // tap the solid part
  const now = s.builtWalls.filter((w) => !w.field);
  const s2 = solids(now);
  ok(s2.length === solidBefore, `solid zone still standing after one tap (${s2.length}/${solidBefore})`);
  ok(s2.every((b) => b.hp === BUILT_WALL.hp - 1), `ALL solid blocks share the hit: hp ${BUILT_WALL.hp}->${BUILT_WALL.hp - 1} (${s2.map((b) => b.hp).join(',')})`);
  ok(weaks(now).length === weakBefore && weaks(now).every((b) => b.hp === 1), `weak zone untouched by a solid hit (${weaks(now).length}/${weakBefore})`);
}

// ---- 2) The SOLID zone falls as ONE unit after BUILT_WALL.hp taps (not block-by-block). ----
{
  const { s, bs } = halfBushState();
  const weakBefore = weaks(bs).length;
  for (let t = 0; t < BUILT_WALL.hp; t++) {
    const now = s.builtWalls.filter((w) => !w.field);
    if (solids(now).length) shootAt(s, solids(now)[0], 0);
  }
  const now = s.builtWalls.filter((w) => !w.field);
  ok(solids(now).length === 0, `whole solid zone gone together after ${BUILT_WALL.hp} taps (${solids(now).length} left)`);
  ok(weaks(now).length === weakBefore, `weak zone still there — solid falling did NOT take it (${weaks(now).length}/${weakBefore})`);
}

// ---- 3) A hit on the WEAK zone breaks it independently — SOLID zone keeps FULL health. ----
{
  const { s, bs } = halfBushState();
  const solidBefore = solids(bs).length;
  shootAt(s, weaks(bs)[0], 0); // tap the penalty/bush part
  const now = s.builtWalls.filter((w) => !w.field);
  ok(weaks(now).length === 0, `weak zone breaks off (hp1) on one hit (${weaks(now).length} left)`);
  ok(solids(now).length === solidBefore && solids(now).every((b) => b.hp === BUILT_WALL.hp), `SOLID zone stays at FULL health (${solids(now).map((b) => b.hp).join(',')})`);
}

// ---- 4) A FULL-power shot destroys the whole solid zone in ONE hit (unit, not one block). ----
{
  const { s, bs } = halfBushState();
  const weakBefore = weaks(bs).length;
  shootAt(s, solids(bs)[0], 1); // full charge
  const now = s.builtWalls.filter((w) => !w.field);
  ok(solids(now).length === 0, `full shot drops the entire solid zone at once (${solids(now).length} left)`);
  ok(weaks(now).length === weakBefore, `weak zone unaffected by the full shot on the solid zone (${weaks(now).length}/${weakBefore})`);
}

// ---- 5) An all-open wall (no restricted zone) is ONE solid unit: a tap chips ALL blocks by 1. ----
{
  const emptyField = { version: 1, bushes: [], hardWalls: [], dryWalls: [], crates: [] };
  const s = fresh(emptyField); const bs = build(s, 1000, 550); // centre x=1000 → clear of both penalty boxes
  ok(solids(bs).length === WALL_BLOCKS, `open wall is all solid (${solids(bs).length})`);
  shootAt(s, bs[0], 0);
  const now = s.builtWalls.filter((w) => !w.field);
  ok(now.length === WALL_BLOCKS && now.every((b) => b.hp === BUILT_WALL.hp - 1), `one tap drains the whole solid unit by 1 (${now.map((b) => b.hp).join(',')})`);
}

console.log(`\n${fails === 0 ? '✅ ALL PASS' : '❌ ' + fails + ' FAILED'}`);
process.exit(fails ? 1 : 0);
