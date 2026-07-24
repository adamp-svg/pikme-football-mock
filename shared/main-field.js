// The MAIN arena — a saved field-builder layout used for normal (lobby 2v2) and bot-game
// matches. Loaded server-side via setField() and sent to the client in matchStart (arena:...),
// exactly like a "play my field" builder match. Also the picker's "ראשי" preset. Training/builder
// override it with their own field. Source of truth mirror: fields/my-field.json (keep in sync).
export const MAIN_FIELD = {
  version: 1,
  bushes: [
    { x: 600, y: 400, w: 150, h: 300 },
    { x: 700, y: 250, w: 150, h: 150 },
    { x: 850, y: 200, w: 150, h: 150 },
    { x: 700, y: 700, w: 150, h: 150 },
    { x: 850, y: 750, w: 150, h: 150 },
    { x: 1250, y: 400, w: 150, h: 300 },
    { x: 1150, y: 250, w: 150, h: 150 },
    { x: 1000, y: 200, w: 150, h: 150 },
    { x: 1150, y: 700, w: 150, h: 150 },
    { x: 1000, y: 750, w: 150, h: 150 },
    { x: 0, y: 0, w: 100, h: 250 },
    { x: 1900, y: 850, w: 100, h: 250 },
    { x: 1900, y: 0, w: 100, h: 250 },
    { x: 0, y: 850, w: 100, h: 250 },
  ],
  hardWalls: [
    { cx: 375, cy: 550, angle: 1.5707963267948966, hl: 150, ht: 16 },
    { cx: 1625, cy: 550, angle: -1.5707963267948966, hl: 150, ht: 16 },
    { cx: 1000, cy: 175, angle: 0, hl: 150, ht: 16 },
    { cx: 1000, cy: 925, angle: 0, hl: 150, ht: 16 },
  ],
  dryWalls: [
    { cx: 50, cy: 225, angle: 3.141592653589793, hl: 50, ht: 16 },
    { cx: 1950, cy: 875, angle: 3.141592653589793, hl: 50, ht: 16 },
    { cx: 1950, cy: 225, angle: -3.141592653589793, hl: 50, ht: 16 },
    { cx: 50, cy: 875, angle: -3.141592653589793, hl: 50, ht: 16 },
  ],
  crates: [
    { x: 950, y: 1050, w: 50, h: 50 },
    { x: 1000, y: 1050, w: 50, h: 50 },
    { x: 950, y: 0, w: 50, h: 50 },
    { x: 1000, y: 0, w: 50, h: 50 },
    { x: 950, y: 350, w: 50, h: 50 },
    { x: 1000, y: 350, w: 50, h: 50 },
    { x: 950, y: 700, w: 50, h: 50 },
    { x: 1000, y: 700, w: 50, h: 50 },
    { x: 900, y: 350, w: 50, h: 50 },
    { x: 900, y: 700, w: 50, h: 50 },
    { x: 1050, y: 350, w: 50, h: 50 },
    { x: 1050, y: 700, w: 50, h: 50 },
  ],
};
