// Built-in ("in-game") field presets the player can clone into the builder from the field picker.
// Each `field` is in the field-builder save shape { version, bushes, hardWalls, dryWalls, crates }.
import { MAIN_FIELD } from './main-field.js';
import { FIELD_3V3 } from './field-3v3.js';
import { FIELD_CORRIDORS, FIELD_RING, FIELD_FORTRESS } from './field-arenas.js';

// "Classic" = the original mirror-symmetric default arena (4 stone covers + 3 bushes), expressed
// in field-builder shape (stone covers → solid boxes; centre + wing bushes).
const CLASSIC = {
  version: 1,
  bushes: [
    { x: 850, y: 430, w: 300, h: 240 },
    { x: 250, y: 470, w: 180, h: 160 },
    { x: 1570, y: 470, w: 180, h: 160 },
  ],
  hardWalls: [],
  dryWalls: [],
  crates: [
    { x: 560, y: 250, w: 120, h: 120 },
    { x: 1320, y: 250, w: 120, h: 120 },
    { x: 560, y: 730, w: 120, h: 120 },
    { x: 1320, y: 730, w: 120, h: 120 },
  ],
};

const EMPTY = { version: 1, bushes: [], hardWalls: [], dryWalls: [], crates: [] };

// Order shown in the picker. `id` is stable; `name` is the Hebrew label.
export const FIELD_PRESETS = [
  { id: 'main', name: 'ראשי', field: MAIN_FIELD },
  { id: 'threes', name: 'שלושות', field: FIELD_3V3 }, // the 3v3 arena — open centre, cover on the wings
  { id: 'classic', name: 'קלאסי', field: CLASSIC },
  // 2026-08-02 — three new arenas (shared/field-arenas.js). Each has ONE tactical idea, so picking
  // one changes how the match is played rather than just how it looks:
  { id: 'corridors', name: 'מסדרונות', field: FIELD_CORRIDORS }, // three lanes — passing over dribbling
  { id: 'ring', name: 'טבעת', field: FIELD_RING },               // hold the centre ring, four ways in
  { id: 'fortress', name: 'מבצר', field: FIELD_FORTRESS },       // open midfield, cover at the goals
  { id: 'empty', name: 'ריק', field: EMPTY },                    // stays LAST: it is the blank canvas
];
