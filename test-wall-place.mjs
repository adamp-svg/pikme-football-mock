// The built wall must land EXACTLY where the drag-to-aim ghost showed it.
// Two independent things have to hold for that:
//   1. the server's input COALESCER must keep the build's aim vector + push distance (the packet
//      that carries the build EDGE owns them — a later packet in the same tick must not clobber
//      them), and
//   2. the client ghost and the sim must compute the SAME placement — including the sim's
//      in-field clamp, which slides a wall built near a line back inside the pitch.
// Run: node test-wall-place.mjs   (exits non-zero on any failure)
import { coalesceInput, consumeEdges } from './shared/input-merge.js';
import { wallPlacement } from './shared/arena.js';
import { createState, addPlayer, step, WALL_BLOCKS } from './shared/sim.js';
import { DT, BUILD_WINDUP, BUILT_WALL, BUILD_DIST_MAX, FIELD } from './shared/constants.js';

let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fails++; };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ---------------------------------------------------------------------------
// 1) Coalescer: the BUILD edge owns its aim + push distance
// ---------------------------------------------------------------------------
// This is the real packet pair the client emits: releaseBuild() edge-flushes P1 with the drag
// vector, then endBuildDrag zeroes the drag so the next scheduled packet P2 carries the idle
// stick and buildDist 0. On a jittery connection both land in the same tick.
const P1 = { seq: 10, moveX: 0, moveY: 1, aimX: -0.7, aimY: -0.71, build: true, buildHold: true, buildDist: 0.8 };
const P2 = { seq: 11, moveX: 0, moveY: 1, aimX: 0, aimY: 1, build: false, buildHold: false, buildDist: 0 };
{
  const merged = coalesceInput(coalesceInput({}, P1), P2);
  ok(merged.build === true, 'build edge stays latched across the follow-up packet');
  ok(near(merged.aimX, P1.aimX) && near(merged.aimY, P1.aimY),
    `build keeps ITS aim (${merged.aimX},${merged.aimY} === ${P1.aimX},${P1.aimY})`);
  ok(near(merged.buildDist, 0.8), `build keeps ITS push distance (${merged.buildDist} === 0.8)`);
}

// A pending FIRE must never lose its aim to a build packet merging in behind it (this is the
// bug the fire-edge latch exists to prevent — the fix must not trade one for the other).
{
  const fireP = { seq: 1, aimX: 0.02, aimY: 1, fire: true, aimed: true };
  const buildP = { seq: 2, aimX: -0.69, aimY: -0.72, build: true, buildDist: 0.5 };
  const merged = coalesceInput(coalesceInput({}, fireP), buildP);
  ok(merged.fire === true && merged.build === true, 'both edges survive the merge');
  ok(near(merged.aimX, 0.02) && near(merged.aimY, 1),
    `a pending shot keeps its aim (${merged.aimX},${merged.aimY} === 0.02,1)`);
}

// Ordinary traffic (no edge pending) still takes the newest aim — the fix must be a strict
// superset of today's behaviour, not a change of feel.
{
  const merged = coalesceInput(coalesceInput({}, { aimX: 1, aimY: 0 }), { aimX: 0, aimY: -1 });
  ok(near(merged.aimX, 0) && near(merged.aimY, -1), 'with no edge pending the latest aim wins');
}

// Consuming the edge must also consume its payload, or the NEXT wall (a plain tap, no drag)
// inherits the previous build's reach.
{
  const inp = coalesceInput({}, P1);
  consumeEdges(inp);
  ok(inp.build === false && inp.fire === false, 'consumeEdges clears the action edges');
  ok(inp.buildDist === 0, `consumeEdges clears the build reach (${inp.buildDist} === 0)`);
}

// ---------------------------------------------------------------------------
// 2) Ghost === sim, everywhere on the pitch
// ---------------------------------------------------------------------------
// wallPlacement() is the ONE placement formula. Sweep player positions (including right up
// against the lines, where the sim's clamp bites) × aim directions and require the helper to
// agree with what buildWall() actually produced, to the pixel.
function buildAt(px, py, ax, ay, mag) {
  const s = createState();
  s.resetTimer = 0;
  addPlayer(s, 'p1', { name: 'A', char: 'player', team: 'A', slot: 0 });
  addPlayer(s, 'p2', { name: 'B', char: 'player', team: 'B', slot: 0 });
  // Park the ball in a corner: a CARRIER can't build (hands full), and the sweep deliberately
  // stands the player at midfield where the ball starts.
  s.ball.x = 40; s.ball.y = FIELD.H - 40; s.ball.vx = 0; s.ball.vy = 0;
  const p = s.players.p1;
  const inp = (o = {}) => ({ seq: 1, moveX: 0, moveY: 0, aimX: ax, aimY: ay, hold: false, fire: false, special: false, build: false, buildHold: false, buildDist: mag, sax: 0, say: 0, ...o });
  const n = Math.round((BUILD_WINDUP + 0.05) / DT);
  for (let i = 0; i < n; i++) { p.x = px; p.y = py; p.vx = 0; p.vy = 0; step(s, { p1: inp({ buildHold: true }), p2: inp() }, DT); }
  p.x = px; p.y = py; p.vx = 0; p.vy = 0;
  step(s, { p1: inp({ build: true }), p2: inp() }, DT);
  const blocks = s.builtWalls.filter((w) => !w.field);
  if (blocks.length !== WALL_BLOCKS) return null;
  // The wall's centre = the midpoint of the tiled blocks.
  const cx = blocks.reduce((a, w) => a + w.cx, 0) / blocks.length;
  const cy = blocks.reduce((a, w) => a + w.cy, 0) / blocks.length;
  return { cx, cy, angle: blocks[0].angle };
}

{
  const spots = [
    [1000, 550, 'midfield'],
    [1000, 60, 'against the top touchline'],
    [1000, FIELD.H - 60, 'against the bottom touchline'],
    [60, 550, 'against the left goal line'],
    [FIELD.W - 60, 550, 'against the right goal line'],
    [70, 70, 'in the top-left corner'],
  ];
  const dirs = [[1, 0], [0, 1], [0, -1], [-1, 0], [0.7071, 0.7071], [-0.7071, 0.7071], [0.26, -0.97]];
  let worst = 0, worstAt = '';
  for (const [px, py, label] of spots) {
    for (const [ax, ay] of dirs) {
      for (const mag of [0, 0.5, 1]) {
        const real = buildAt(px, py, ax, ay, mag);
        if (!real) { ok(false, `sim placed no wall at ${label} aim(${ax},${ay}) mag ${mag}`); continue; }
        const g = wallPlacement(px, py, ax, ay, mag);
        const d = Math.hypot(g.cx - real.cx, g.cy - real.cy);
        if (d > worst) { worst = d; worstAt = `${label} aim(${ax},${ay}) mag ${mag}`; }
        if (!near(g.angle, real.angle, 1e-9)) ok(false, `angle mismatch at ${label} aim(${ax},${ay})`);
      }
    }
  }
  ok(worst < 1e-6, `ghost === sim placement over ${spots.length * dirs.length * 3} cases (worst ${worst.toFixed(3)}px${worst > 0 ? ' at ' + worstAt : ''})`);
}

// The clamp is the part the ghost used to miss — prove it actually moves the wall, so the test
// above is not passing vacuously.
{
  const ax = 0, ay = -1;                       // aiming at the top line => a horizontal slab
  const p = wallPlacement(1000, 60, ax, ay, 1);
  const unclamped = { cx: 1000 + ax * (BUILT_WALL.offset + BUILD_DIST_MAX), cy: 60 + ay * (BUILT_WALL.offset + BUILD_DIST_MAX) };
  const slide = Math.hypot(p.cx - unclamped.cx, p.cy - unclamped.cy);
  ok(slide > 40, `near a line the clamp slides the wall a visible distance (${slide.toFixed(1)}px) — the ghost must show that`);
}

// ---------------------------------------------------------------------------
// 3) End to end: the coalesced packet pair builds the wall the player aimed at
// ---------------------------------------------------------------------------
{
  const px = 1000, py = 550;
  const merged = coalesceInput(coalesceInput({}, P1), P2);
  const real = buildAt(px, py, merged.aimX, merged.aimY, merged.buildDist);
  const want = wallPlacement(px, py, P1.aimX, P1.aimY, P1.buildDist); // where the ghost promised
  const d = real ? Math.hypot(real.cx - want.cx, real.cy - want.cy) : Infinity;
  ok(d < 1e-6, `a coalesced release builds where the ghost showed (off by ${d.toFixed(1)}px)`);
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
