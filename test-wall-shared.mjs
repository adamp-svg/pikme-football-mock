// Sim unit tests for the SINGLE-SHARED-POOL health of a player-built wall.
// A build is 4 blocks sharing a wallId, tagged by zone: SOLID (open ground, base hp3) or WEAK
// (bush/penalty, base hp1). Damage to ANY block drains EVERY block of the group equally (one
// shared pool). Because weak starts at 1 and solid at 3 and they drain together:
//   - the WEAK part always breaks FIRST (gone after the first hit of any size);
//   - a hit on the solid end also drains the weak part, and vice versa;
//   - when the SOLID part reaches 0 the WHOLE wall is removed as one unit;
//   - a full-power shot / bomb anywhere deletes the whole wall in one hit;
//   - an all-weak wall is a one-hit wall.
// Verified end-to-end via real shots. Run: node test-wall-shared.mjs
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
  s.ball.owner = null; s.ball.x = 100; s.ball.y = 100; s.ball.vx = 0; s.ball.vy = 0; // park the ball
  const p = s.players.p1;
  p.x = px; p.y = py; p.aimX = 1; p.aimY = 0; p.buildCd = 0; p.buildAmmo = 9;
  const k = Math.round(BUILD_WINDUP / DT) + 1;
  for (let i = 0; i < k; i++) step(s, { p1: inp({ buildHold: true }), p2: inp() }, DT);
  step(s, { p1: inp({ buildHold: false, build: true }), p2: inp() }, DT);
  return s.builtWalls.filter((w) => !w.field);
}
// Fire ONE shot from p1 through `block` (aim +x). A tap is slow, so stand CLOSE. charge 0 = tap
// (1 dmg); charge 1 = full (BUILT_WALL.hp dmg). Clears per-shot pacing so back-to-back shots fire.
function shootAt(s, block, charge) {
  s.ball.owner = null; s.ball.x = 100; s.ball.y = 100;
  const p = s.players.p1;
  p.x = block.x - 70; p.y = block.cy; p.aimX = 1; p.aimY = 0; p.ammo = 5; p.kvx = 0; p.kvy = 0;
  p.shootCd = 0; p.reloadLock = 0;
  const n = Math.max(0, Math.round(charge * SHOOT_CHARGE_TIME * 60));
  for (let i = 0; i < n; i++) step(s, { p1: inp({ hold: true, moveX: 0 }), p2: inp() }, DT);
  step(s, { p1: inp({ fire: true }), p2: inp() }, DT);
  for (let i = 0; i < 90 && s.projectiles.length; i++) step(s, { p1: inp(), p2: inp() }, DT);
}
const live = (s) => s.builtWalls.filter((w) => !w.field);
const solids = (bs) => bs.filter((b) => !b.fragile);
const weaks = (bs) => bs.filter((b) => b.fragile);

// A half-bush wall: bush covers the wall's upper half → upper blocks WEAK, lower blocks SOLID.
function halfBushState() {
  const probe = fresh(null); const pb = build(probe, 1000, 550);
  const cx = pb[0].cx, midY = pb.reduce((a, b) => a + b.cy, 0) / pb.length;
  const field = { version: 1, bushes: [{ x: cx - 200, y: 0, w: 400, h: midY }], hardWalls: [], dryWalls: [], crates: [] };
  const s = fresh(field); const bs = build(s, 1000, 550);
  return { s, bs };
}

// ---- 0) Sanity: a half-bush wall splits into a SOLID zone (hp3) + a WEAK zone (hp1). ----
{
  const { bs } = halfBushState();
  ok(bs.length === WALL_BLOCKS, `wall is ${WALL_BLOCKS} blocks (${bs.length})`);
  ok(solids(bs).length >= 1 && weaks(bs).length >= 1, `split into solid + weak (solid=${solids(bs).length}, weak=${weaks(bs).length})`);
  ok(solids(bs).every((b) => b.hp === BUILT_WALL.hp) && weaks(bs).every((b) => b.hp === 1), `solid base hp${BUILT_WALL.hp}, weak base hp1`);
}

// ---- 1) A tap on the SOLID end drains the WEAK part too → WEAK breaks FIRST; solid at hp2. ----
{
  const { s, bs } = halfBushState();
  const solidBefore = solids(bs).length;
  shootAt(s, solids(bs)[0], 0); // hit the SOLID end
  const now = live(s);
  ok(weaks(now).length === 0, `weak part broke FIRST from a hit on the solid end (${weaks(now).length} weak left)`);
  ok(solids(now).length === solidBefore && solids(now).every((b) => b.hp === BUILT_WALL.hp - 1), `solid drained to hp${BUILT_WALL.hp - 1}, still standing (${solids(now).map((b) => b.hp).join(',')})`);
}

// ---- 2) A tap on the WEAK end drains the SOLID part too (vice versa): solid NOT left at full. ----
{
  const { s, bs } = halfBushState();
  shootAt(s, weaks(bs)[0], 0); // hit the WEAK end
  const now = live(s);
  ok(weaks(now).length === 0, `weak part gone (${weaks(now).length} left)`);
  ok(solids(now).length >= 1 && solids(now).every((b) => b.hp === BUILT_WALL.hp - 1), `a hit on the weak end ALSO drained the solid part to hp${BUILT_WALL.hp - 1} (${solids(now).map((b) => b.hp).join(',')})`);
}

// ---- 3) Single unit: when the SOLID part reaches 0 the WHOLE wall is removed at once. ----
{
  const { s } = halfBushState();
  for (let t = 0; t < BUILT_WALL.hp; t++) {
    const now = live(s);
    if (solids(now).length) shootAt(s, solids(now)[0], 0);
  }
  ok(live(s).length === 0, `whole wall gone after ${BUILT_WALL.hp} taps — solid breaking took everything (${live(s).length} left)`);
}

// ---- 4) A FULL-power shot ANYWHERE deletes the whole wall in one hit (3 dmg = whole pool). ----
{
  const a = halfBushState(); shootAt(a.s, solids(a.bs)[0], 1); // full shot on the solid end
  ok(live(a.s).length === 0, `full shot on the solid end one-shots the whole wall (${live(a.s).length} left)`);
  const b = halfBushState(); shootAt(b.s, weaks(b.bs)[0], 1);  // full shot on the weak end
  ok(live(b.s).length === 0, `full shot on the weak end one-shots the whole wall too (${live(b.s).length} left)`);
}

// ---- 5) An all-open wall is ONE solid unit: a tap chips all blocks by 1; 3 taps destroys it. ----
{
  const emptyField = { version: 1, bushes: [], hardWalls: [], dryWalls: [], crates: [] };
  const s = fresh(emptyField); const bs = build(s, 1000, 550); // centre x → clear of both penalty boxes
  ok(solids(bs).length === WALL_BLOCKS, `open wall is all solid (${solids(bs).length})`);
  shootAt(s, bs[0], 0);
  ok(live(s).length === WALL_BLOCKS && live(s).every((b) => b.hp === BUILT_WALL.hp - 1), `one tap drains the whole solid unit by 1 (${live(s).map((b) => b.hp).join(',')})`);
  for (let t = 0; t < BUILT_WALL.hp - 1; t++) { const n = live(s); if (n.length) shootAt(s, n[0], 0); }
  ok(live(s).length === 0, `open wall gone after ${BUILT_WALL.hp} taps total (${live(s).length} left)`);
}

// ---- 6) An ALL-WEAK wall (fully inside a bush) is a ONE-HIT wall. ----
{
  const probe = fresh(null); const pb = build(probe, 1000, 550);
  const cx = pb[0].cx;
  const field = { version: 1, bushes: [{ x: cx - 300, y: 0, w: 600, h: FIELD.H }], hardWalls: [], dryWalls: [], crates: [] };
  const s = fresh(field); const bs = build(s, 1000, 550);
  ok(weaks(bs).length === WALL_BLOCKS, `wall fully in a bush is all weak (${weaks(bs).length})`);
  shootAt(s, bs[0], 0);
  ok(live(s).length === 0, `all-weak wall dies to one hit (${live(s).length} left)`);
}

console.log(`\n${fails === 0 ? '✅ ALL PASS' : '❌ ' + fails + ' FAILED'}`);
process.exit(fails ? 1 : 0);
