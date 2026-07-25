// Sim unit tests for the wall-build hold-to-confirm windup.
// Run: node test-build-windup.mjs   (exits non-zero on any failure)
import { createState, addPlayer, step, WALL_BLOCKS } from './shared/sim.js';
import { DT, BUILD_WINDUP, BUILD_INTERRUPT_KV, BUILD_COOLDOWN } from './shared/constants.js';

let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fails++; };

function fresh() {
  const s = createState();
  s.resetTimer = 0;
  addPlayer(s, 'p1', { name: 'A', char: 'player', team: 'A', slot: 0 });
  addPlayer(s, 'p2', { name: 'B', char: 'player', team: 'B', slot: 0 });
  s.players.p1.x = 500; s.players.p1.y = 500;
  return s;
}
function inp(o = {}) { return { seq: 1, moveX: 0, moveY: 0, aimX: 1, aimY: 0, hold: false, fire: false, special: false, build: false, buildHold: false, sax: 0, say: 0, ...o }; }
// Hold buildHold for `secs`, then optionally release with a build edge.
function holdBuild(s, secs, { release = true } = {}) {
  const n = Math.max(0, Math.round(secs / DT));
  for (let i = 0; i < n; i++) step(s, { p1: inp({ buildHold: true }), p2: inp() }, DT);
  if (release) step(s, { p1: inp({ buildHold: false, build: true }), p2: inp() }, DT);
}

// 1) Releasing at full windup places exactly one wall and spends one charge.
{
  const s = fresh();
  const before = s.players.p1.buildAmmo;
  holdBuild(s, BUILD_WINDUP + 0.05);
  ok(s.builtWalls.length === WALL_BLOCKS, `full windup places a wall of ${WALL_BLOCKS} blocks (n=${s.builtWalls.length})`);
  ok(new Set(s.builtWalls.map((q) => q.wallId)).size === 1, `the blocks share one wallId (one wall)`);
  ok(s.players.p1.buildAmmo === before - 1, `full windup spends one charge (${s.players.p1.buildAmmo} === ${before - 1})`);
}

// 2) Releasing BEFORE full windup places nothing and spends no charge (cancel).
{
  const s = fresh();
  const before = s.players.p1.buildAmmo;
  holdBuild(s, BUILD_WINDUP * 0.5);
  ok(s.builtWalls.length === 0, `early release places no wall (n=${s.builtWalls.length})`);
  ok(s.players.p1.buildAmmo === before, `early release refunds charge (${s.players.p1.buildAmmo} === ${before})`);
}

// 3) A knockback during windup cancels it (no wall even if you keep holding to full).
{
  const s = fresh();
  const half = Math.round((BUILD_WINDUP * 0.5) / DT);
  for (let i = 0; i < half; i++) step(s, { p1: inp({ buildHold: true }), p2: inp() }, DT);
  s.players.p1.kvx = BUILD_INTERRUPT_KV + 200; // simulate a hit
  step(s, { p1: inp({ buildHold: true }), p2: inp() }, DT); // interrupt tick
  ok(s.players.p1.buildWindup === 0, `hit resets windup (${s.players.p1.buildWindup})`);
  // The interrupt kv (BUILD_INTERRUPT_KV + 200) needs several ticks to decay back below
  // the threshold before the ramp can resume; wait that out before timing the recovery ramp.
  while (Math.hypot(s.players.p1.kvx, s.players.p1.kvy) > BUILD_INTERRUPT_KV) {
    step(s, { p1: inp({ buildHold: true }), p2: inp() }, DT);
  }
  const rest = Math.round(BUILD_WINDUP / DT) + 2;
  for (let i = 0; i < rest; i++) step(s, { p1: inp({ buildHold: true }), p2: inp() }, DT);
  step(s, { p1: inp({ buildHold: false, build: true }), p2: inp() }, DT);
  ok(s.builtWalls.length === WALL_BLOCKS, `windup recovers after the hit decays (n=${s.builtWalls.length})`);
}

// 4) A bare build edge with no prior hold places nothing (no instant build).
{
  const s = fresh();
  step(s, { p1: inp({ build: true }), p2: inp() }, DT);
  ok(s.builtWalls.length === 0, `bare build edge is a no-op (n=${s.builtWalls.length})`);
}


// 5) The placement COOLDOWN is invisible on the wire unless the client keys off `winding`:
//    for BUILD_COOLDOWN seconds after a wall goes up, holding build must NOT accumulate windup
//    and must NOT place a second wall — even though the player still has a charge. The client's
//    ring reads `p.buildWindup`/the `winding` flag precisely because of this window (a purely
//    local wall-clock ring filled up here and promised a wall the server then refused).
{
  const s = fresh();
  s.players.p1.buildAmmo = 2;
  holdBuild(s, BUILD_WINDUP + 0.05);                       // first wall
  const afterFirst = s.builtWalls.length;
  ok(afterFirst === WALL_BLOCKS, `first wall placed (n=${afterFirst})`);
  ok(s.players.p1.buildCd > 0, `a placement starts the cooldown (${s.players.p1.buildCd.toFixed(2)}s)`);
  ok(s.players.p1.buildAmmo >= 1, `a charge is still in the mag (${s.players.p1.buildAmmo})`);

  // Hold through the cooldown window: windup must stay pinned at 0 the whole time.
  let maxWindup = 0;
  const cdTicks = Math.round((BUILD_COOLDOWN * 0.9) / DT);
  for (let i = 0; i < cdTicks; i++) {
    step(s, { p1: inp({ buildHold: true }), p2: inp() }, DT);
    maxWindup = Math.max(maxWindup, s.players.p1.buildWindup);
  }
  ok(maxWindup === 0, `no windup accumulates during the cooldown (max ${maxWindup})`);
  step(s, { p1: inp({ buildHold: false, build: true }), p2: inp() }, DT);
  ok(s.builtWalls.length === afterFirst, `releasing inside the cooldown places nothing (n=${s.builtWalls.length})`);

  // Past the cooldown the same hold works again — the block is temporary, not a dead button.
  while (s.players.p1.buildCd > 0) step(s, { p1: inp(), p2: inp() }, DT);
  holdBuild(s, BUILD_WINDUP + 0.05);
  ok(s.builtWalls.length === afterFirst + WALL_BLOCKS, `after the cooldown the wall builds (n=${s.builtWalls.length})`);
}

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
