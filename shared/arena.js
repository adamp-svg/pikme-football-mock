// Arena obstacles — static geometry authored here, shared by BOTH the server
// (authoritative collision) and the client (prediction + rendering). Because the
// static layout lives in one module imported everywhere, it never has to be sent
// over the wire and can never desync. Only *built* walls (spawned by players at
// runtime) are dynamic and travel in the snapshot.
//
// The layout is mirror-symmetric about BOTH the vertical (x=1000) and horizontal
// (y=550) centre lines, so neither team is advantaged — important because team B
// renders a horizontally-mirrored view.

import { FIELD, clamp } from './constants.js';

// Static, indestructible stone walls (axis-aligned boxes).
const WALLS = [
  { x: 560, y: 250, w: 120, h: 120 },   // top-left cover
  { x: 1320, y: 250, w: 120, h: 120 },  // top-right cover
  { x: 560, y: 730, w: 120, h: 120 },   // bottom-left cover
  { x: 1320, y: 730, w: 120, h: 120 },  // bottom-right cover
];

// Bushes — stealth cover. No physics; players walk through freely. An enemy
// standing inside is hidden from you (client-side visibility rule in canSee()).
const BUSHES = [
  { x: 850, y: 430, w: 300, h: 240 },   // centre contest bush (covers the centre circle)
  { x: 250, y: 470, w: 180, h: 160 },   // left wing
  { x: 1570, y: 470, w: 180, h: 160 },  // right wing
];

// Trampolines — DISABLED (hidden) for now. Empty layout => no launch pads spawn,
// the sim's trampoline loop is a no-op, and nothing renders. Restore entries here
// to bring them back.
const TRAMPOLINES = [];

export const ARENA = { walls: WALLS, bushes: BUSHES, trampolines: TRAMPOLINES };

// Is world point (x,y) inside any bush?
export function pointInBush(x, y) {
  for (const g of BUSHES) {
    if (x > g.x && x < g.x + g.w && y > g.y && y < g.y + g.h) return true;
  }
  return false;
}

// Resolve a moving circle (player/ball) out of one axis-aligned box.
// `opts.bounce` (0..1) reflects velocity for the ball; players just slide.
// Mutates e.{x,y,vx,vy} (and e.kvx/e.kvy if present). Returns true on contact.
export function resolveCircleBox(e, box, r, opts = {}) {
  const bounce = opts.bounce || 0;
  const nx = clamp(e.x, box.x, box.x + box.w);
  const ny = clamp(e.y, box.y, box.y + box.h);
  let dx = e.x - nx, dy = e.y - ny;
  let d = Math.hypot(dx, dy);
  if (d >= r) return false;

  if (d > 0.0001) {
    const ux = dx / d, uy = dy / d, push = r - d;
    e.x += ux * push; e.y += uy * push;
    // Cancel (or bounce) the velocity component heading into the wall.
    const vn = (e.vx || 0) * ux + (e.vy || 0) * uy;
    if (vn < 0) {
      const k = bounce ? (1 + bounce) : 1;
      e.vx -= k * vn * ux; e.vy -= k * vn * uy;
    }
    if (e.kvx !== undefined) {
      const kn = e.kvx * ux + e.kvy * uy;
      if (kn < 0) { e.kvx -= kn * ux; e.kvy -= kn * uy; }
    }
  } else {
    // Centre is inside the box — eject along the axis of least penetration.
    const left = e.x - box.x, right = box.x + box.w - e.x;
    const top = e.y - box.y, bottom = box.y + box.h - e.y;
    const m = Math.min(left, right, top, bottom);
    if (m === left) { e.x = box.x - r; if (e.vx > 0) e.vx = bounce ? -e.vx * bounce : 0; }
    else if (m === right) { e.x = box.x + box.w + r; if (e.vx < 0) e.vx = bounce ? -e.vx * bounce : 0; }
    else if (m === top) { e.y = box.y - r; if (e.vy > 0) e.vy = bounce ? -e.vy * bounce : 0; }
    else { e.y = box.y + box.h + r; if (e.vy < 0) e.vy = bounce ? -e.vy * bounce : 0; }
  }
  return true;
}

// Resolve a circle against every wall (static + built). `built` is optional.
export function resolveWalls(e, r, built, opts) {
  for (const w of ARENA.walls) resolveCircleBox(e, w, r, opts);
  if (built) for (const w of built) resolveCircleBox(e, w, r, opts);
}

// Point-in-box (bullets are treated as points for wall hits).
export function pointInBox(x, y, box) {
  return x > box.x && x < box.x + box.w && y > box.y && y < box.y + box.h;
}

// Does a circle (cx,cy,r) overlap an axis-aligned box? (no mutation — used to detect a
// power kick smashing a fragile wall without bouncing it.)
export function circleHitsBox(cx, cy, r, box) {
  const nx = clamp(cx, box.x, box.x + box.w), ny = clamp(cy, box.y, box.y + box.h);
  return (cx - nx) * (cx - nx) + (cy - ny) * (cy - ny) < r * r;
}
