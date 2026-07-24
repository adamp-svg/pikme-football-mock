// Built-in ("in-game") field presets the player can clone into the builder from the field picker.
// Each `field` is in the field-builder save shape { version, bushes, hardWalls, dryWalls, crates }.
import { MAIN_FIELD } from './main-field.js';

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
  { id: 'classic', name: 'קלאסי', field: CLASSIC },
  { id: 'empty', name: 'ריק', field: EMPTY },
];
