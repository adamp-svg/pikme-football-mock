// Three hand-authored arenas added 2026-08-02, in the same field-builder save shape as MAIN_FIELD
// and FIELD_3V3 ({ version, bushes, hardWalls, dryWalls, crates }), so they load through the very
// same setField() path and can be opened in the builder.
//
// THE RULES EVERY ARENA HERE OBEYS — test-arena-fairness.mjs enforces all of them, so a future
// hand-authored field cannot quietly break the game:
//   1. Mirror-symmetric about BOTH x=1000 and y=550. Team B renders a horizontally-mirrored view, so
//      an asymmetric field hands one side a better half.
//   2. The 2v2 spawn spots stay clear — formationSlot() puts them at x≈300/1700, y≈396/704.
//   3. Both goal mouths stay clear — GOAL is 300 wide and 70 deep, i.e. y 400..700 at each end.
//   4. The centre stays walkable. field-3v3.js records why: pack the middle and the match becomes a
//      scrum, because every extra body funnels into the same contested spot.
//
// Coordinates: the pitch is FIELD 2000x1100. Boxes are {x,y,w,h} from the top-left; walls are
// {cx,cy,angle,hl,ht} (centre, radians, half-length, half-thickness).

const V = Math.PI / 2;   // vertical wall
const H = 0;             // horizontal wall

// ── מסדרונות (Corridors) ────────────────────────────────────────────────────────────────────────
// Two long dividers cut the pitch into three channels. You can still cross, but crossing costs time
// and shows you to whoever is watching the gap — so it rewards passing and picking a lane over
// dribbling straight up the middle. The dividers stop well short of both ends: the goal mouths and
// the spawn columns stay open, and a defender can always circle back.
export const FIELD_CORRIDORS = {
  version: 1,
  bushes: [
    // Ambush pockets at the mouth of each corridor, off the spawn spots.
    { x: 620, y: 60, w: 200, h: 130 },
    { x: 1180, y: 60, w: 200, h: 130 },
    { x: 620, y: 910, w: 200, h: 130 },
    { x: 1180, y: 910, w: 200, h: 130 },
  ],
  hardWalls: [
    // The two dividers, at y=340 and y=760, mirrored about y=550. hl=300 → they span x 700..1300,
    // leaving 700px of open pitch at each end for the spawn lanes and the goals.
    { cx: 1000, cy: 340, angle: H, hl: 300, ht: 16 },
    { cx: 1000, cy: 760, angle: H, hl: 300, ht: 16 },
  ],
  dryWalls: [
    // Breakable stubs guarding the lane entrances — shoot through to open a shortcut.
    { cx: 700, cy: 550, angle: V, hl: 70, ht: 16 },
    { cx: 1300, cy: 550, angle: V, hl: 70, ht: 16 },
  ],
  crates: [
    { x: 440, y: 490, w: 120, h: 120 },
    { x: 1440, y: 490, w: 120, h: 120 },
  ],
};

// ── טבעת (Ring) ─────────────────────────────────────────────────────────────────────────────────
// A ring of crates around the centre with four gaps — one on each side. Whoever holds the ring holds
// the ball, but the gaps mean it is a position to be taken rather than a wall to hide behind, and
// the centre itself stays empty so the kickoff is never blocked.
export const FIELD_RING = {
  version: 1,
  bushes: [
    // Approach cover on the diagonals, so you can reach the ring without crossing open ground.
    { x: 470, y: 230, w: 180, h: 150 },
    { x: 1350, y: 230, w: 180, h: 150 },
    { x: 470, y: 720, w: 180, h: 150 },
    { x: 1350, y: 720, w: 180, h: 150 },
  ],
  hardWalls: [],
  dryWalls: [],
  crates: [
    // Eight crates on a 340x240 ring around (1000,550); the four gaps sit on the axes.
    { x: 760, y: 310, w: 110, h: 110 },
    { x: 1130, y: 310, w: 110, h: 110 },
    { x: 760, y: 680, w: 110, h: 110 },
    { x: 1130, y: 680, w: 110, h: 110 },
    { x: 640, y: 495, w: 110, h: 110 },
    { x: 1250, y: 495, w: 110, h: 110 },
    { x: 945, y: 190, w: 110, h: 110 },
    { x: 945, y: 800, w: 110, h: 110 },
  ],
};

// ── מבצר (Fortress) ─────────────────────────────────────────────────────────────────────────────
// Cover packed around each goal, midfield left wide open. The inverse of the other two: crossing is
// cheap, finishing is hard, so it rewards long shots, rebounds and a committed push rather than a
// centre scrum. The goal mouths themselves stay clear — the cover flanks them, it never blocks them.
export const FIELD_FORTRESS = {
  version: 1,
  bushes: [
    { x: 210, y: 170, w: 200, h: 160 },
    { x: 1590, y: 170, w: 200, h: 160 },
    { x: 210, y: 770, w: 200, h: 160 },
    { x: 1590, y: 770, w: 200, h: 160 },
  ],
  hardWalls: [
    // Short shields either side of each goal mouth (mouth is y 400..700, so these sit outside it).
    // ⚠️ cy is 200/900, NOT 330/770: at 330 these spanned y 260..400 on the goal column x=300 —
    // which is exactly where the 2v2 spawns land (300,396) and (1700,704). test-arena-fairness.mjs
    // caught it; a player would have spawned inside a wall. Keep them clear of y 396 and y 704.
    { cx: 300, cy: 200, angle: V, hl: 70, ht: 16 },
    { cx: 1700, cy: 200, angle: V, hl: 70, ht: 16 },
    { cx: 300, cy: 900, angle: V, hl: 70, ht: 16 },
    { cx: 1700, cy: 900, angle: V, hl: 70, ht: 16 },
  ],
  dryWalls: [
    // Breakable screens in front of each goal — cover that a good shot removes.
    { cx: 500, cy: 430, angle: H, hl: 90, ht: 16 },
    { cx: 1500, cy: 430, angle: H, hl: 90, ht: 16 },
    { cx: 500, cy: 670, angle: H, hl: 90, ht: 16 },
    { cx: 1500, cy: 670, angle: H, hl: 90, ht: 16 },
  ],
  crates: [
    // A lone centre pair to break the sightline without closing the middle.
    { x: 945, y: 330, w: 110, h: 110 },
    { x: 945, y: 660, w: 110, h: 110 },
  ],
};
