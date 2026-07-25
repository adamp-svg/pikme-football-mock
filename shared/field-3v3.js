// The 3v3 arena — "מגרש שלושות".
//
// Why a separate field instead of reusing MAIN_FIELD: 3v3 puts SIX bodies on the same
// 2000x1100 pitch, and MAIN_FIELD's centre is dense (two bush blocks plus a 12-crate column
// straddling x=1000). With four players that reads as cover; with six it reads as a scrum,
// because every extra body funnels into the same contested middle.
//
// So this layout inverts the priority: an OPEN central channel for the extra traffic, and the
// cover pushed out to the three spawn lanes. Spawns for teamSize 3 land at y ≈ 198 / 550 / 902
// (see spawnPos in sim.js), so the flank bushes sit on the outer two lanes and the midfield
// dividers stop all six players collapsing onto the ball at once.
//
// Same field-builder save shape as MAIN_FIELD ({ version, bushes, hardWalls, dryWalls, crates }),
// so it loads through the identical setField() path and can be opened in the builder.
// Mirror-symmetric about BOTH axes (x=1000, y=550) — neither side gets a better half.
const V = Math.PI / 2; // vertical wall

export const FIELD_3V3 = {
  version: 1,
  bushes: [
    // Outer-lane cover, on the wing spawn lanes (y≈198 / y≈902) — ambush spots that do not
    // block the middle.
    { x: 500, y: 110, w: 210, h: 170 },
    { x: 1290, y: 110, w: 210, h: 170 },
    { x: 500, y: 820, w: 210, h: 170 },
    { x: 1290, y: 820, w: 210, h: 170 },
    // Two mid pockets held OFF the centre line so the central channel stays walkable.
    { x: 870, y: 285, w: 260, h: 145 },
    { x: 870, y: 670, w: 260, h: 145 },
    // Corner scrub, as on the main field — keeps the corners from being dead space.
    { x: 0, y: 0, w: 100, h: 210 },
    { x: 1900, y: 0, w: 100, h: 210 },
    { x: 0, y: 890, w: 100, h: 210 },
    { x: 1900, y: 890, w: 100, h: 210 },
  ],
  hardWalls: [
    // Goal-approach shields, same idea as MAIN_FIELD's — a shot has to be angled, not just
    // hammered down the middle from range.
    { cx: 360, cy: 550, angle: V, hl: 140, ht: 16 },
    { cx: 1640, cy: 550, angle: -V, hl: 140, ht: 16 },
    // Midfield lane dividers, top and bottom. These are what stop 6 players collapsing into
    // one ball-scrum: the wings have to commit to a lane to cross.
    { cx: 1000, cy: 205, angle: V, hl: 115, ht: 16 },
    { cx: 1000, cy: 895, angle: V, hl: 115, ht: 16 },
  ],
  dryWalls: [
    // Destructible corner cover — breaks under fire, so corners aren't permanent camp spots.
    { cx: 50, cy: 190, angle: Math.PI, hl: 50, ht: 16 },
    { cx: 1950, cy: 190, angle: -Math.PI, hl: 50, ht: 16 },
    { cx: 50, cy: 910, angle: Math.PI, hl: 50, ht: 16 },
    { cx: 1950, cy: 910, angle: -Math.PI, hl: 50, ht: 16 },
  ],
  crates: [
    // Two breakable screens flanking the centre circle (x=760 and its mirror x=1180). They give
    // the extra bodies something to fight over without walling the middle off.
    { x: 760, y: 455, w: 60, h: 60 },
    { x: 760, y: 520, w: 60, h: 60 },
    { x: 760, y: 585, w: 60, h: 60 },
    { x: 1180, y: 455, w: 60, h: 60 },
    { x: 1180, y: 520, w: 60, h: 60 },
    { x: 1180, y: 585, w: 60, h: 60 },
    // A pair in front of each penalty area — cover for the deepest player in the formation.
    { x: 430, y: 330, w: 60, h: 60 },
    { x: 430, y: 710, w: 60, h: 60 },
    { x: 1510, y: 330, w: 60, h: 60 },
    { x: 1510, y: 710, w: 60, h: 60 },
  ],
};
