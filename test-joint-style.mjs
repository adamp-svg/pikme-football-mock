// The corner-joint style rule (shared/joint-style.js).
//
// The point of this file: a corner must never need the author's help to EXIST, must pick a sane look
// on its own, must honour an override for that one corner only, and must not hoard styling for
// corners that no longer exist. Every case below is one of those four claims.
//
// Reported by the project owner (2026-07-27): the builder's ⬛/⬤ פינה button set the style for the
// WHOLE field up front. Corners are now auto-styled, and the choice moved onto the selected corner.
import assert from 'node:assert';
import {
  MITER_LIMIT, JOINT_STYLES, autoJointStyle, jointKey, resolveJointStyle, overrideOf,
  cycleJointStyle, setJointOverride, pruneJointOverrides,
} from './shared/joint-style.js';

let pass = 0;
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); pass++; };
const ok = (c, m) => { assert.ok(c, m); pass++; };
const deep = (a, b, m) => { assert.deepStrictEqual(a, b, `${m} (got ${JSON.stringify(a)})`); pass++; };

const D = (deg) => (deg * Math.PI) / 180;
// The rule's own boundary: 1/sin(θ/2) > MITER_LIMIT  ⇔  θ < 2·asin(1/MITER_LIMIT) ≈ 38.94°.
const CUT = 2 * Math.asin(1 / MITER_LIMIT);

// ── autoJointStyle — square by default, round exactly where the mitre would have been refused ────
eq(autoJointStyle(D(90)), 'square', 'a right-angle corner mitres cleanly → square');
eq(autoJointStyle(D(120)), 'square', 'an obtuse corner is square');
eq(autoJointStyle(D(60)), 'square', 'a 60° corner still mitres inside the limit → square');
eq(autoJointStyle(D(20)), 'round', 'a sharply acute corner would spike → round');
eq(autoJointStyle(D(5)), 'round', 'a near-collinear corner is round');
eq(autoJointStyle(CUT - 1e-6), 'round', 'just inside the miter limit → round');
eq(autoJointStyle(CUT + 1e-6), 'square', 'just outside the miter limit → square');
ok(CUT > D(38) && CUT < D(40), 'the boundary is ~38.9°, i.e. jointPolygon\'s own limit');

// A corner with nothing to bevel must not become a mystery disc.
eq(autoJointStyle(null), 'square', 'no arm pair → square');
eq(autoJointStyle(0), 'square', 'zero angle → square');
eq(autoJointStyle(NaN), 'square', 'NaN → square');
eq(autoJointStyle(undefined), 'square', 'undefined → square');

// ── jointKey — stable identity for a DERIVED corner ─────────────────────────────────────────────
eq(jointKey(300, 450), '300:450', 'key is the rounded position');
eq(jointKey(300.4, 449.6), '300:450', 'sub-pixel jitter resolves to the same corner');
ok(jointKey(300, 450) !== jointKey(350, 450), 'adjacent grid junctions are different corners');
eq(jointKey(-0.2, 0), '0:0', 'negative zero does not produce "-0"');

// ── resolveJointStyle — the override wins, and only for its own corner ──────────────────────────
const overrides = { '300:450': 'round' };
eq(resolveJointStyle(overrides, '300:450', D(90)), 'round', 'an override beats AUTO');
eq(resolveJointStyle(overrides, '350:450', D(90)), 'square', 'a neighbour keeps its own AUTO look');
eq(resolveJointStyle({ '300:450': 'square' }, '300:450', D(10)), 'square', 'AUTO round can be overridden to square');
eq(resolveJointStyle(null, '300:450', D(10)), 'round', 'no overrides at all still resolves');
eq(resolveJointStyle({ '300:450': 'banana' }, '300:450', D(90)), 'square', 'a junk value falls back to AUTO, never renders as junk');

eq(overrideOf(overrides, '300:450'), 'round', 'overrideOf reports what the author set');
eq(overrideOf(overrides, '350:450'), 'auto', 'an untouched corner reads as auto');
eq(overrideOf({ '1:1': 'banana' }, '1:1'), 'auto', 'a junk value reads as auto');

// ── cycleJointStyle — AUTO must always be reachable again ───────────────────────────────────────
eq(cycleJointStyle('auto'), 'square', 'auto → square');
eq(cycleJointStyle('square'), 'round', 'square → round');
eq(cycleJointStyle('round'), 'auto', 'round → auto (the author can always give it back)');
eq(cycleJointStyle(undefined), 'square', 'an unset corner starts at auto');
deep(JOINT_STYLES, ['auto', 'square', 'round'], 'the cycle order is stable');

// ── setJointOverride — 'auto' leaves NO trace ───────────────────────────────────────────────────
deep(setJointOverride({}, '300:450', 'round'), { '300:450': 'round' }, 'sets an override');
deep(setJointOverride({ '300:450': 'round' }, '300:450', 'auto'), {}, 'auto REMOVES the key, never stores "auto"');
deep(setJointOverride(null, '1:1', 'square'), { '1:1': 'square' }, 'works from nothing');
const before = { '1:1': 'round' };
setJointOverride(before, '2:2', 'square');
deep(before, { '1:1': 'round' }, 'the input map is not mutated (undo snapshots share it)');

// ── pruneJointOverrides — a deleted corner must not leave styling behind ────────────────────────
deep(
  pruneJointOverrides({ '300:450': 'round', '900:900': 'square' }, new Set(['300:450'])),
  { '300:450': 'round' },
  'an orphaned corner\'s override is dropped',
);
deep(pruneJointOverrides({ '1:1': 'round' }, ['1:1']), { '1:1': 'round' }, 'accepts an array of live keys');
deep(pruneJointOverrides({ '1:1': 'banana' }, ['1:1']), {}, 'junk is pruned even when the corner is live');
deep(pruneJointOverrides(null, []), {}, 'no overrides prunes to an empty map');

console.log(`✅ joint-style: ${pass} assertions passed`);
