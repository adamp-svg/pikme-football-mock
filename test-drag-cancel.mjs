// The shared drag-cancel state machine (shared/drag-cancel.js), used by BOTH the wall-build and
// the bomb button.
//
// THE BUG THIS PINS: the old machine armed CANCEL the moment the drag dropped below CANCEL_IN_PX
// and only disarmed again past CANCEL_ARM_PX. Re-aiming by sweeping the thumb ACROSS the button
// centre therefore passed through the cancel zone and, released anywhere in the 18..34 px band on
// the far side, silently cancelled — the wall never built and it read as "it just didn't work".
// The rule is now positional: releasing INSIDE the zone cancels, releasing outside it commits.
// Run: node test-drag-cancel.mjs   (exits non-zero on any failure)
import {
  newDragCancel, updateDragCancel, releaseCancels,
  CANCEL_ARM_PX, CANCEL_IN_PX, CANCEL_OUT_PX, CANCEL_DWELL_MS,
} from './shared/drag-cancel.js';

let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fails++; };

// Drive the machine along a path of distances (px from the button centre), `stepMs` apart.
// Returns the drag state plus the haptic edges emitted.
function drive(path, stepMs = 16) {
  const drag = { dx: 0, dy: 0, ...newDragCancel() };
  const edges = [];
  let t = 1000;
  for (const d of path) {
    drag.dx = d; drag.dy = 0;
    const e = updateDragCancel(drag, t);
    if (e) edges.push(e);
    t += stepMs;
  }
  return { drag, edges, releases: releaseCancels(drag) };
}
// A sweep from `from` to `to` at `pxPerSec`, sampled every 16ms.
function sweep(from, to, pxPerSec) {
  const dist = Math.abs(to - from);
  const steps = Math.max(1, Math.round(dist / (pxPerSec * 0.016)));
  return Array.from({ length: steps + 1 }, (_, i) => from + (to - from) * (i / steps));
}

// 1) THE REGRESSION: aim out, sweep back THROUGH the centre to re-aim the other way, release.
//    Every release point outside the cancel zone must COMMIT.
{
  const bad = [];
  for (const speed of [150, 300, 600, 1200]) {
    for (const releaseAt of [19, 22, 26, 30, 33, 40, 60]) {
      const path = [...sweep(60, 5, speed), ...sweep(5, releaseAt, speed)];
      const r = drive(path);
      if (r.releases) bad.push(`${speed}px/s→${releaseAt}px`);
    }
  }
  ok(bad.length === 0, `sweeping through the centre and releasing outside the zone always builds (${bad.length ? 'EATEN: ' + bad.join(', ') : '28/28 commit'})`);
}

// 2) A deliberate abort still cancels: aim out, come back to the middle, let go there.
{
  const r = drive([...sweep(60, 6, 200), ...Array(12).fill(6)]); // settle in the middle
  ok(r.releases, 'aim out then release in the middle = CANCEL');
  ok(r.drag.cancelArmed, '...and the ✕ is showing by then (finger settled past the dwell)');
  ok(r.edges[0] === 'cancel', `...and it buzzed once on arming (edges: ${r.edges.join(',') || 'none'})`);
}

// 3) A quick flick back to the centre and release, faster than the dwell, must still cancel —
//    the ✕ just hasn't had time to appear (client.js buzzes for this case).
{
  const path = [...sweep(60, 4, 1500)];
  const r = drive(path);
  const dwellElapsed = path.length * 16 >= CANCEL_DWELL_MS;
  ok(r.releases, 'a fast flick back to centre still cancels on release');
  ok(!r.drag.cancelArmed && !dwellElapsed, '...before the ✕ armed (that is the buzz-on-release case)');
}

// 4) No aim, no cancel affordance: a small wobble inside the zone that never pulled out.
{
  const r = drive([0, 4, 8, 12, 8, 3]);
  ok(!r.releases, 'a tap/wobble that never aimed does not count as a cancel');
  ok(!r.drag.aimed && !r.drag.cancelArmed, '...and never latches aimed/armed');
}

// 5) Armed, then pulled back out past CANCEL_OUT_PX: the ✕ clears and release commits.
{
  const r = drive([...sweep(60, 5, 200), ...Array(12).fill(5), ...sweep(5, 45, 200)]);
  ok(!r.drag.cancelArmed, 'pulling back out past CANCEL_OUT_PX clears the ✕');
  ok(!r.releases, '...and releasing out there builds');
  ok(r.edges.includes('rearm'), `...and it ticked on re-arm (edges: ${r.edges.join(',')})`);
}

// 6) The invariant the whole fix rests on: after a real aim, release cancels IFF the finger is
//    inside the cancel zone. No path, speed or dwell may change that.
{
  const bad = [];
  for (const speed of [150, 400, 900]) {
    for (let d = 0; d <= 60; d += 2) {
      const r = drive([...sweep(60, 5, speed), ...sweep(5, d, speed)]);
      if (r.releases !== (d < CANCEL_IN_PX)) bad.push(`${speed}px/s@${d}px`);
    }
  }
  ok(bad.length === 0, `release cancels IFF inside ${CANCEL_IN_PX}px, on every path (${bad.length ? 'VIOLATIONS: ' + bad.slice(0, 6).join(', ') : '93/93'})`);
}

// 7) Edges are one-shot: parked in the zone, it buzzes once, not once per sample.
{
  const r = drive([...sweep(60, 5, 200), ...Array(40).fill(5)]);
  ok(r.edges.filter((e) => e === 'cancel').length === 1, `parked in the zone buzzes exactly once (${r.edges.length} edges)`);
}

// 8) Sanity on the constants themselves.
{
  ok(CANCEL_IN_PX < CANCEL_OUT_PX && CANCEL_OUT_PX < CANCEL_ARM_PX, `zone ordering ${CANCEL_IN_PX} < ${CANCEL_OUT_PX} < ${CANCEL_ARM_PX}`);
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
