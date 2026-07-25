// Tests for the named ARENA SIZES (shared/field-sizes.js) — the records the builder, the server's
// field sanitizer and the renderer read instead of assuming one hardcoded 2000x1100 pitch.
//
// These are INVARIANT tests, not behaviour tests: they exist so a future agent cannot add or retune
// a size that looks fine in the builder but breaks the grid, the mirror, the wire, or live 2v2/3v3.
// Run: node test-field-sizes.mjs
import { FIELD_SIZES, SIZE_IDS, DEFAULT_SIZE, GRID, REF_W, WIRE_MAX_COORD, sizeOf, sizeOfField, cellsOf } from './shared/field-sizes.js';
import { FIELD, GOAL, PENALTY } from './shared/constants.js';

let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fails++; };

// 1) s2v2 IS the shipped pitch, to the pixel. 2v2 and 3v3 both play on it (2026-07-26 ruling:
// 3v3 stays on 2000x1100, crowding solved by layout). If this drifts, both live formats change.
{
  const s = FIELD_SIZES.s2v2;
  ok(s.W === FIELD.W && s.H === FIELD.H, `s2v2 matches shipped FIELD ${FIELD.W}x${FIELD.H} (got ${s.W}x${s.H})`);
  ok(s.goal.width === GOAL.width && s.goal.depth === GOAL.depth, `s2v2 goal matches shipped GOAL ${GOAL.width}/${GOAL.depth}`);
  ok(s.penalty.width === PENALTY.width && s.penalty.depth === PENALTY.depth, `s2v2 penalty matches shipped PENALTY ${PENALTY.width}x${PENALTY.depth}`);
  ok(s.maxTeam >= 3, `s2v2 is sized for up to 3 per team (2v2 + 3v3 both live here), got ${s.maxTeam}`);
  ok(DEFAULT_SIZE === 's2v2', `the default size is s2v2 — every size-less save loads as the shipped pitch`);
  ok(REF_W === FIELD_SIZES.s2v2.W, `camera REF_W (${REF_W}) equals s2v2.W, so pinning the zoom is a no-op for both live formats`);
}

// 2) Grid invariants, for EVERY size: whole cells, and an EVEN count on both axes so the halfway
// line is a grid junction and the builder's mirror is exact.
for (const id of SIZE_IDS) {
  const s = FIELD_SIZES[id];
  const { cols, rows } = cellsOf(s);
  ok(s.W % GRID === 0 && s.H % GRID === 0, `${id}: ${s.W}x${s.H} is a whole number of ${GRID}px cells (${cols}x${rows})`);
  ok(cols % 2 === 0 && rows % 2 === 0, `${id}: cell counts BOTH even (${cols}x${rows}) — centre line lands on a junction`);
  ok(s.W / 2 % GRID === 0 && s.H / 2 % GRID === 0, `${id}: centre (${s.W / 2},${s.H / 2}) is a grid junction`);
}

// 3) Wire safety, for EVERY size. shared/wire.js packs positions as i16 tenths (+/-3276.7). The
// largest coordinate a match encodes is the ball inside the far net: W + goal.depth.
for (const id of SIZE_IDS) {
  const s = FIELD_SIZES[id];
  const maxCoord = s.W + s.goal.depth;
  ok(maxCoord < WIRE_MAX_COORD, `${id}: max encoded coord ${maxCoord} < wire ceiling ${WIRE_MAX_COORD} (${(100 * maxCoord / WIRE_MAX_COORD).toFixed(0)}% of range)`);
}

// 4) Markings stay proportionate and physically sane at every size.
for (const id of SIZE_IDS) {
  const s = FIELD_SIZES[id];
  const goalFrac = s.goal.width / s.H;
  ok(goalFrac > 0.24 && goalFrac < 0.32, `${id}: goal is ${(goalFrac * 100).toFixed(1)}% of the end line (shipped 2v2 is 27.3%)`);
  ok(s.penalty.width > s.goal.width, `${id}: penalty box (${s.penalty.width}) is wider than the goal mouth (${s.goal.width})`);
  ok(s.penalty.width < s.H && s.penalty.depth < s.W / 2, `${id}: penalty box fits inside its own half`);
  ok(s.goal.depth > 0 && s.goal.depth < s.penalty.depth, `${id}: net depth ${s.goal.depth} sits inside the box depth ${s.penalty.depth}`);
}

// 5) Bigger sizes really are bigger, and the ladder is monotonic in both axes and in team size.
{
  const ladder = SIZE_IDS.map((id) => FIELD_SIZES[id]);
  let monoW = true, monoH = true, monoTeam = true;
  for (let i = 1; i < ladder.length; i++) {
    if (ladder[i].W <= ladder[i - 1].W) monoW = false;
    if (ladder[i].H <= ladder[i - 1].H) monoH = false;
    if (ladder[i].maxTeam <= ladder[i - 1].maxTeam) monoTeam = false;
  }
  ok(monoW && monoH, `the ladder grows on both axes: ${ladder.map((s) => `${s.W}x${s.H}`).join(' -> ')}`);
  ok(monoTeam, `the ladder grows in team size: ${ladder.map((s) => s.maxTeam).join(' -> ')}`);
}

// 6) Playability tracks the wire's 8-slot player mask, not the pitch size. 4 per team = 8 players
// = exactly the mask capacity; 5 per team = 10 players needs a wire change first.
for (const id of SIZE_IDS) {
  const s = FIELD_SIZES[id];
  const players = s.maxTeam * 2;
  ok(s.playable === (players <= 8), `${id}: playable=${s.playable} for ${players} players (wire mask holds 8)`);
}

// 7) sizeOf / sizeOfField never throw and always land on the shipped pitch when in doubt — a
// corrupt localStorage value must not brick the builder.
{
  ok(sizeOf('s2v2').id === 's2v2', `sizeOf resolves a known id`);
  ok(sizeOf('nope').id === DEFAULT_SIZE, `sizeOf('nope') falls back to ${DEFAULT_SIZE}`);
  ok(sizeOf(undefined).id === DEFAULT_SIZE, `sizeOf(undefined) falls back to ${DEFAULT_SIZE}`);
  ok(sizeOf(null).id === DEFAULT_SIZE, `sizeOf(null) falls back to ${DEFAULT_SIZE}`);
  ok(sizeOf(42).id === DEFAULT_SIZE, `sizeOf(42) falls back to ${DEFAULT_SIZE}`);
  ok(sizeOfField({ version: 1, bushes: [] }).id === DEFAULT_SIZE, `a legacy v1 save (no size) IS the shipped pitch — never rescaled`);
  ok(sizeOfField({ version: 2, size: 'sBig' }).id === 'sBig', `a v2 save carries its own size`);
  ok(sizeOfField(null).id === DEFAULT_SIZE, `sizeOfField(null) falls back to ${DEFAULT_SIZE}`);
}

console.log(fails ? `\n${fails} FAILED` : '\nAll field-size invariants hold');
process.exit(fails ? 1 : 0);
