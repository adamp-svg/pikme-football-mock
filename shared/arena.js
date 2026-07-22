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

// Nearest point on a wall to (px,py). An ANGLED built wall is a CAPSULE (thick line
// segment): nearest point on its centre segment, plus `rad` = the capsule's thickness
// radius. A plain AABB wall clamps into the box (rad 0). One primitive backs every query.
export function nearestOnWall(w, px, py) {
  if (w.angle != null) {
    const ca = Math.cos(w.angle), sa = Math.sin(w.angle);
    const ax = w.cx - ca * w.hl, ay = w.cy - sa * w.hl;
    const bx = w.cx + ca * w.hl, by = w.cy + sa * w.hl;
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
    const t = clamp(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1);
    return { x: ax + dx * t, y: ay + dy * t, rad: w.ht };
  }
  return { x: clamp(px, w.x, w.x + w.w), y: clamp(py, w.y, w.y + w.h), rad: 0 };
}

// Resolve a moving circle out of an ANGLED (capsule) wall — nearest-point-on-segment +
// push out along the world-space normal. No interior special case (unlike the box).
function resolveCircleCapsule(e, w, r, opts = {}) {
  const bounce = opts.bounce || 0;
  const np = nearestOnWall(w, e.x, e.y);
  let dx = e.x - np.x, dy = e.y - np.y;
  let d = Math.hypot(dx, dy);
  const min = r + np.rad;
  if (d >= min) return false;
  let ux, uy;
  if (d > 0.0001) { ux = dx / d; uy = dy / d; }
  else { ux = -Math.sin(w.angle); uy = Math.cos(w.angle); } // centre on the axis: push perpendicular
  const push = min - d;
  e.x += ux * push; e.y += uy * push;
  const vn = (e.vx || 0) * ux + (e.vy || 0) * uy;
  if (vn < 0) { const k = bounce ? (1 + bounce) : 1; e.vx -= k * vn * ux; e.vy -= k * vn * uy; }
  if (e.kvx !== undefined) { const kn = e.kvx * ux + e.kvy * uy; if (kn < 0) { e.kvx -= kn * ux; e.kvy -= kn * uy; } }
  return true;
}

// Resolve a moving circle (player/ball) out of one wall. Angled built walls dispatch to
// the capsule resolver; static/axis-aligned walls use the box path below.
// `opts.bounce` (0..1) reflects velocity for the ball; players just slide.
// Mutates e.{x,y,vx,vy} (and e.kvx/e.kvy if present). Returns true on contact.
export function resolveCircleBox(e, box, r, opts = {}) {
  if (box.angle != null) return resolveCircleCapsule(e, box, r, opts);
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
// `staticWalls` defaults to the global arena but can be overridden (training uses
// its own custom wall set).
export function resolveWalls(e, r, built, opts, staticWalls = ARENA.walls) {
  for (const w of staticWalls) resolveCircleBox(e, w, r, opts);
  if (built) for (const w of built) resolveCircleBox(e, w, r, opts);
}

// Point-in-wall (bullets are treated as points for wall hits). Angled walls test the
// point against the capsule (within its thickness); boxes use the plain inside test.
export function pointInBox(x, y, box) {
  if (box.angle != null) {
    const np = nearestOnWall(box, x, y);
    const dx = x - np.x, dy = y - np.y;
    return dx * dx + dy * dy < np.rad * np.rad;
  }
  return x > box.x && x < box.x + box.w && y > box.y && y < box.y + box.h;
}

// Does a circle (cx,cy,r) overlap a wall? (no mutation — used to detect a power kick
// smashing a fragile wall without bouncing it.) Angled walls use the capsule test.
export function circleHitsBox(cx, cy, r, box) {
  if (box.angle != null) {
    const np = nearestOnWall(box, cx, cy);
    const dx = cx - np.x, dy = cy - np.y, rr = r + np.rad;
    return dx * dx + dy * dy < rr * rr;
  }
  const nx = clamp(cx, box.x, box.x + box.w), ny = clamp(cy, box.y, box.y + box.h);
  return (cx - nx) * (cx - nx) + (cy - ny) * (cy - ny) < r * r;
}

// --- Line-of-sight: does wall `w` block the straight segment A->B? --------------
// Used for blast / shot COVER (a body behind a wall is shielded). `pad` inflates the
// wall by a body radius so a target hugging directly behind it still counts as covered.
// Handles both the AABB (static stone) and the capsule (angled built) wall shapes.
export function segBlockedByWall(w, ax, ay, bx, by, pad = 0) {
  if (w.angle != null) {
    const ca = Math.cos(w.angle), sa = Math.sin(w.angle);
    const c0x = w.cx - ca * w.hl, c0y = w.cy - sa * w.hl;
    const c1x = w.cx + ca * w.hl, c1y = w.cy + sa * w.hl;
    return segSegDist(ax, ay, bx, by, c0x, c0y, c1x, c1y) < (w.ht + pad);
  }
  return segHitsAabb(ax, ay, bx, by, w.x - pad, w.y - pad, w.x + w.w + pad, w.y + w.h + pad);
}

// Segment (ax,ay)->(bx,by) vs AABB [minx,miny]-[maxx,maxy] (Liang–Barsky slab clip).
function segHitsAabb(ax, ay, bx, by, minx, miny, maxx, maxy) {
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dy = by - ay;
  const clip = (p, q) => {
    if (p === 0) return q >= 0;            // parallel to this slab — inside iff q>=0
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
    else { if (r < t0) return false; if (r < t1) t1 = r; }
    return true;
  };
  if (clip(-dx, ax - minx) && clip(dx, maxx - ax) && clip(-dy, ay - miny) && clip(dy, maxy - ay)) return t0 <= t1;
  return false;
}

// Shortest distance between segments (ax,ay)-(bx,by) and (cx,cy)-(ex,ey).
function segSegDist(ax, ay, bx, by, cx, cy, ex, ey) {
  const ux = bx - ax, uy = by - ay, vx = ex - cx, vy = ey - cy, wx = ax - cx, wy = ay - cy;
  const a = ux * ux + uy * uy, b = ux * vx + uy * vy, c = vx * vx + vy * vy;
  const d = ux * wx + uy * wy, e = vx * wx + vy * wy, D = a * c - b * b;
  let sN, sD = D, tN, tD = D;
  if (D < 1e-9) { sN = 0; sD = 1; tN = e; tD = c; }               // near-parallel
  else {
    sN = b * e - c * d; tN = a * e - b * d;
    if (sN < 0) { sN = 0; tN = e; tD = c; }
    else if (sN > sD) { sN = sD; tN = e + b; tD = c; }
  }
  if (tN < 0) { tN = 0; if (-d < 0) sN = 0; else if (-d > a) sN = sD; else { sN = -d; sD = a; } }
  else if (tN > tD) { tN = tD; if ((-d + b) < 0) sN = 0; else if ((-d + b) > a) sN = sD; else { sN = -d + b; sD = a; } }
  const sc = Math.abs(sN) < 1e-9 ? 0 : sN / sD;
  const tc = Math.abs(tN) < 1e-9 ? 0 : tN / tD;
  const px = wx + sc * ux - tc * vx, py = wy + sc * uy - tc * vy;
  return Math.hypot(px, py);
}
