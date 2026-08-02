/* EVERY BUILT-IN ARENA MUST BE FAIR AND PLAYABLE.
 *
 * These fields are authored by hand as coordinate lists, which is exactly the kind of data where a
 * typo is invisible in review and decides matches: one crate 40px off centre and team B is defending
 * a narrower goal for the rest of the season. Team B renders a horizontally-MIRRORED view, so the
 * pitch has to be symmetric about both axes or one side genuinely has the better half.
 *
 * Checks, for every preset in FIELD_PRESETS:
 *   1. mirror-symmetric about x=1000 AND y=550
 *   2. the 2v2 spawn spots are not inside solid cover
 *   3. both goal mouths are clear
 *   4. the kickoff centre is clear
 *
 *   node test-arena-fairness.mjs
 */
import { FIELD_PRESETS } from './shared/field-presets.js';
import { FIELD, GOAL } from './shared/constants.js';
import { formationSlot } from './shared/field-spawns.js';

const CX = FIELD.W / 2, CY = FIELD.H / 2;
let failures = 0;
const ok = (cond, label, detail) => {
  if (!cond) failures++;
  console.log(`  ${cond ? '✅' : '❌'} ${label}${detail !== undefined && !cond ? '  — ' + detail : ''}`);
};

// ── geometry ────────────────────────────────────────────────────────────────────────────────────
const boxKey = (b) => `${Math.round(b.x)},${Math.round(b.y)},${Math.round(b.w)},${Math.round(b.h)}`;
// A box mirrored across both axes: x -> W - (x + w), y -> H - (y + h).
const mirrorBox = (b) => ({ x: FIELD.W - (b.x + b.w), y: FIELD.H - (b.y + b.h), w: b.w, h: b.h });
// A wall is a centre + angle; mirroring both axes maps the centre through the middle and negates the
// angle twice (i.e. leaves the line's orientation), so only the centre moves.
const wallKey = (w) => `${Math.round(w.cx)},${Math.round(w.cy)},${Math.round(w.hl)},${Math.round(w.ht)},${((Math.abs(w.angle) % Math.PI)).toFixed(3)}`;
const mirrorWall = (w) => ({ cx: FIELD.W - w.cx, cy: FIELD.H - w.cy, hl: w.hl, ht: w.ht, angle: w.angle });

function symmetric(list, keyOf, mirrorOf) {
  const have = new Set((list || []).map(keyOf));
  const missing = (list || []).filter((it) => !have.has(keyOf(mirrorOf(it))));
  return { pass: missing.length === 0, missing };
}

const inBox = (x, y, b, pad = 0) => x > b.x - pad && x < b.x + b.w + pad && y > b.y - pad && y < b.y + b.h + pad;
// Axis-aligned walls only (every authored one is 0 or ±π/2), treated as their bounding box.
function wallBox(w) {
  const horizontal = Math.abs(Math.sin(w.angle)) < 0.5;
  const halfW = horizontal ? w.hl : w.ht;
  const halfH = horizontal ? w.ht : w.hl;
  return { x: w.cx - halfW, y: w.cy - halfH, w: halfW * 2, h: halfH * 2 };
}
const solids = (f) => [...(f.crates || []), ...(f.hardWalls || []).map(wallBox), ...(f.dryWalls || []).map(wallBox)];

console.log('ARENA FAIRNESS — every built-in preset\n');
for (const preset of FIELD_PRESETS) {
  const f = preset.field;
  console.log(`${preset.name}  (${preset.id})`);
  if (!(f.crates || []).length && !(f.hardWalls || []).length && !(f.dryWalls || []).length && !(f.bushes || []).length) {
    console.log('  (empty canvas — nothing to check)\n');
    continue;
  }

  // 1. symmetry
  for (const [name, list, keyOf, mirrorOf] of [
    ['bushes', f.bushes, boxKey, mirrorBox],
    ['crates', f.crates, boxKey, mirrorBox],
    ['hardWalls', f.hardWalls, wallKey, mirrorWall],
    ['dryWalls', f.dryWalls, wallKey, mirrorWall],
  ]) {
    if (!(list || []).length) continue;
    const { pass, missing } = symmetric(list, keyOf, mirrorOf);
    ok(pass, `${name} mirror-symmetric about x=${CX} and y=${CY}`, `${missing.length} without a partner, first: ${JSON.stringify(missing[0])}`);
  }

  // 2. spawns clear (2v2 — the format these fields are played in)
  const sol = solids(f);
  for (const team of ['A', 'B']) {
    for (let slot = 0; slot < 2; slot++) {
      const p = formationSlot(team, slot, 2, FIELD);
      const hit = sol.find((b) => inBox(p.x, p.y, b, 30));   // 30px ≈ a player's half-width
      ok(!hit, `spawn ${team}${slot} (${Math.round(p.x)},${Math.round(p.y)}) is not inside cover`, `blocked by ${JSON.stringify(hit)}`);
    }
  }

  // 3. goal mouths clear — GOAL.width tall, GOAL.depth deep, at both ends
  const mouthTop = CY - GOAL.width / 2, mouthBot = CY + GOAL.width / 2;
  for (const [label, x0, x1] of [['left', 0, GOAL.depth], ['right', FIELD.W - GOAL.depth, FIELD.W]]) {
    const hit = sol.find((b) => b.x < x1 && b.x + b.w > x0 && b.y < mouthBot && b.y + b.h > mouthTop);
    ok(!hit, `${label} goal mouth is clear`, `blocked by ${JSON.stringify(hit)}`);
  }

  // 4. kickoff spot clear
  const centreHit = sol.find((b) => inBox(CX, CY, b, 40));
  ok(!centreHit, 'kickoff centre is clear', `blocked by ${JSON.stringify(centreHit)}`);
  console.log('');
}

console.log(failures === 0 ? '✅ every arena is fair and playable' : `❌ ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
