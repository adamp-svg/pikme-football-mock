// Named arena SIZES — the single source of truth for "how big is this pitch".
//
// WHY THIS FILE EXISTS
// Until now the pitch was one module constant (`FIELD` in constants.js, 2000x1100) that the
// builder, the server's field sanitizer, the sim and the renderer all read directly. That made a
// bigger stadium impossible to author: the builder canvas was hardcoded (FB_W/FB_H), three CSS
// rules pinned `aspect-ratio: 2000 / 1100`, and `sanitizeField` clamped every coordinate to
// FIELD.W/H — so a wider field silently COLLAPSED to 2000 with no error. Sizes live here instead,
// and a saved field carries its size id, so a layout can never be reinterpreted at the wrong size.
//
// THE INVARIANTS (asserted in test-field-sizes.mjs — do not "fix" a size without re-running it)
//  1. W and H are whole multiples of GRID (50), so every builder snap lands on the pitch.
//  2. Both cell counts are EVEN. That is what makes the halfway line a grid JUNCTION and keeps
//     the builder's mirror mapping junctions->junctions and cell centres->cell centres exactly.
//     An odd count (e.g. 2450 -> 49 cells) puts the centre at 1225, which fbSnap cannot express.
//  3. Every size stays inside the binary wire's coordinate range. shared/wire.js packs positions
//     as i16 tenths => +/-3276.7 world px, and the largest coordinate a match encodes is
//     W + goal.depth (the ball inside the net). WIRE_MAX_COORD below is the hard ceiling.
//  4. `s2v2` reproduces the SHIPPED constants exactly (2000x1100, goal 300/70, penalty 620x360).
//     2v2 AND 3v3 both play on s2v2 — the 2026-07-26 ruling kept 3v3 on the shipped pitch, with
//     crowding solved by LAYOUT (shared/field-3v3.js's open central channel) rather than by area.
//     So this row must never drift: if it changes, live 2v2 and 3v3 change with it.
//
// GOAL/PENALTY scale with the pitch so markings stay proportionate: goal ~27% of the end line,
// penalty ~56% of it and ~18% of the length — the shipped s2v2 ratios. `goal.depth` does NOT
// scale; it is net depth, set by ball/keeper scale rather than by pitch size.

// Builder grid cell, in world px. The builder's FB_GRID must equal this.
export const GRID = 50;

// Hard wire ceiling: shared/wire.js `P = (v) => i16(round(v * 10))` => +/-32767 tenths.
export const WIRE_MAX_COORD = 3276.7;

// Reference width the camera zoom is pinned to. `scale = CAM_ZOOM * canvasW / REF_W` instead of
// `/ FIELD.W`, so a BIGGER pitch pans further rather than zooming out and shrinking every sprite.
// Equal to s2v2.W, which makes the change a literal no-op for both live formats.
export const REF_W = 2000;

export const FIELD_SIZES = {
  // The shipped pitch. 2v2 and 3v3 both live here. 40 x 22 cells.
  s2v2: {
    id: 's2v2', name: 'רגיל', sub: '2 נגד 2 · 3 נגד 3',
    W: 2000, H: 1100,
    goal: { width: 300, depth: 70 },
    penalty: { width: 620, depth: 360 },
    maxTeam: 3,      // players per team this pitch is sized for
    playable: true,
  },
  // A genuinely bigger stadium, authorable AND playable today: 4 per team is 8 players, which is
  // exactly the capacity of the wire's u8 player mask (shared/wire.js:51 `for (k = 0; k < 8; k++)`),
  // so nothing about the wire format has to change to play a match on it. 52 x 30 cells.
  sBig: {
    id: 'sBig', name: 'גדול', sub: 'עד 4 נגד 4',
    W: 2600, H: 1500,
    goal: { width: 400, depth: 70 },
    penalty: { width: 850, depth: 450 },
    maxTeam: 4,
    playable: true,
  },
  // 5v5 groundwork. Authorable now so layouts can be built ahead of time, but NOT playable: 10
  // players overflow the 8-slot u8 mask, and widening it is a wire-format change (both encoder and
  // decoder, plus the mask type). Flip `playable` once that lands — nothing else here changes.
  sHuge: {
    id: 'sHuge', name: 'ענק', sub: 'עד 5 נגד 5 · בקרוב',
    W: 2900, H: 1700,
    goal: { width: 450, depth: 70 },
    penalty: { width: 950, depth: 500 },
    maxTeam: 5,
    playable: false,
  },
};

// Every size-less save is this one, forever. A field authored before sizes existed was drawn on
// 2000x1100, so that is what it IS — never rescale it, never reinterpret it.
export const DEFAULT_SIZE = 's2v2';

// Sizes a MATCH can currently be hosted on, as opposed to sizes the builder can AUTHOR.
//
// These differ because the pitch is still one module constant at runtime: `FIELD` in constants.js
// is read from 123 places (33 sim.js, 25 bot-ai.js, 49 client.js, 11 training.js, 3 server.js, 2
// arena.js), and several are precomputed at module load. Until those read per-match geometry off
// the state — the `state.arena`/`arenaOf(state)` idiom already in sim.js and bot-ai.js — a match
// played on a non-base size would use the WRONG goal lines, penalty boxes, spawns and wall bounds
// while merely LOOKING bigger. Authoring is safe (it is just data); playing is not.
//
// So the builder lets you draw any size and refuses to launch one it cannot host honestly.
// When per-match geometry lands, add the id here — that is the whole switch.
export const RUNTIME_SIZES = ['s2v2'];

// Can a match actually be played on this size today?
export const canHost = (id) => RUNTIME_SIZES.includes(sizeOf(id).id);

// Resolve a size id to its record. Unknown / missing / malformed always falls back to the default
// rather than throwing: a corrupt localStorage value must not brick the builder.
export function sizeOf(id) {
  return (id && FIELD_SIZES[id]) || FIELD_SIZES[DEFAULT_SIZE];
}

// The size a saved field object was drawn on. Reads the field's own `size`, defaulting to s2v2.
export function sizeOfField(field) {
  return sizeOf(field && field.size);
}

// Builder grid dimensions for a size.
export function cellsOf(size) {
  return { cols: Math.round(size.W / GRID), rows: Math.round(size.H / GRID) };
}

// Ids in display order for the builder's size picker.
export const SIZE_IDS = ['s2v2', 'sBig', 'sHuge'];
