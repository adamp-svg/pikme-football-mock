// Training ground — pure logic for the solo practice mode's penned "roaming
// target" dummy. Kept separate from server.js so it's unit-testable and shared
// with the client (the pen outline uses the same PEN box).
import { FIELD } from './constants.js';

// The box the dummy is confined to: in front of team B's (right) goal.
export const PEN = {
  x0: FIELD.W * 0.80, x1: FIELD.W - 40,   // 1600 .. 1960 (never inside the net)
  y0: FIELD.H * 0.22, y1: FIELD.H * 0.78, //  242 .. 858
};

// Home spot for the center "sentry" enemy — it holds midfield and returns here.
export const CENTER = { x: FIELD.W / 2, y: FIELD.H / 2 };
export const SENTRY_LEASH = 240; // it can be nudged this far from CENTER, no further

// Custom, deliberately ASYMMETRIC training field (solo, so fairness doesn't apply):
// a large bush for cover in the top-left, and a large indestructible steel wall in
// the opposite (bottom-right) corner. Used ONLY in training — real matches keep the
// global mirror-symmetric ARENA. The server sets state.arena = TRAIN_ARENA; the
// client swaps to it whenever the `training` flag is on. Neither is sent over the wire.
export const TRAIN_BUSHES = [{ x: 160, y: 120, w: 400, h: 260 }];  // top-left cover
// Steel wall: a long, flat horizontal barrier across the bottom-half CENTRE,
// directly below the midfield sentry — so standing behind it (toward the bottom
// edge) shields you from its fire.
export const TRAIN_WALLS = [{ x: 590, y: 780, w: 820, h: 80 }];
export const TRAIN_ARENA = { walls: TRAIN_WALLS, bushes: TRAIN_BUSHES, trampolines: [] };

const clampN = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Keep the dummy physically inside its pen after physics — knockback from
// shots/bombs can never punt it out ("does not go past"). Call each tick
// AFTER step().
export function penDummy(state, dummyId) {
  const p = state.players[dummyId];
  if (!p) return;
  if (p.x < PEN.x0 || p.x > PEN.x1) { p.x = clampN(p.x, PEN.x0, PEN.x1); p.vx = 0; p.kvx = 0; }
  if (p.y < PEN.y0 || p.y > PEN.y1) { p.y = clampN(p.y, PEN.y0, PEN.y1); p.vy = 0; p.kvy = 0; }
}

// Passive roaming target input for the dummy: paces its zone; steps onto the
// line between the ball and the goal when the ball threatens. Never shoots,
// plants, builds, or carries. Returns an input object (or null if no dummy).
export function trainingDummyInput(state, dummyId) {
  const p = state.players[dummyId];
  if (!p) return null;
  const ball = state.ball;
  const gx = FIELD.W, gy = FIELD.H / 2;         // centre of the goal it guards
  const threat = ball.x > FIELD.W * 0.6;        // ball in the dummy's half → cover the goal

  let tx, ty;
  if (threat) {
    const dx = ball.x - gx, dy = ball.y - gy;
    const d = Math.hypot(dx, dy) || 1;
    const standoff = 220;
    tx = gx + (dx / d) * standoff;
    ty = gy + (dy / d) * standoff;
  } else {
    tx = (PEN.x0 + PEN.x1) / 2;
    ty = gy + Math.sin(state.elapsed * 0.9) * (FIELD.H * 0.22);
  }
  tx = clampN(tx, PEN.x0, PEN.x1);
  ty = clampN(ty, PEN.y0, PEN.y1);

  const mvx = tx - p.x, mvy = ty - p.y;
  const m = Math.hypot(mvx, mvy);
  const dead = 14; // don't jitter once basically on target
  const moveX = m > dead ? mvx / m : 0;
  const moveY = m > dead ? mvy / m : 0;
  const ax = ball.x - p.x, ay = ball.y - p.y, al = Math.hypot(ax, ay) || 1;
  return {
    seq: 0, moveX, moveY, aimX: ax / al, aimY: ay / al,
    hold: false, fire: false, special: false, build: false,
  };
}

// Per-sentry firing state (server-side only; not part of the deterministic sim).
export function createSentryMem() {
  return { mode: 'idle', t: 0.8, aimX: -1, aimY: 0 }; // brief hold before the first action
}

// Difficulty tiers for the sentry — deliberately WIDE: easy = gentle target
// practice, hard = genuinely threatening. Mirrors the game's easy/normal/hard.
//  idle/burst  = [min,max] seconds of that window
//  powerChance = chance an action is a CHARGED power shot vs a quick burst
//  chargeHold  = seconds it holds to charge (≈ charge level; ≥0.85 = full power)
//  aimSigma    = aim noise (radians std) — higher = sloppier
//  lead        = how much it leads your movement (0 = aim at now, 1 = full intercept)
//  turn        = aim slew per tick (higher = snappier tracking)
//  laneCheck   = won't fire when the steel wall blocks the shot
export const SENTRY_SKILL = {
  easy:   { idle: [1.6, 3.6], burst: [0.20, 0.60], powerChance: 0.12, chargeHold: 0.75, aimSigma: 0.16,  lead: 0.65, turn: 0.12, laneCheck: false },
  normal: { idle: [0.8, 2.0], burst: [0.40, 1.00], powerChance: 0.38, chargeHold: 1.00, aimSigma: 0.06,  lead: 0.90, turn: 0.30, laneCheck: true },
  hard:   { idle: [0.35, 1.0], burst: [0.60, 1.40], powerChance: 0.60, chargeHold: 1.20, aimSigma: 0.025, lead: 1.00, turn: 0.60, laneCheck: true },
};

// Solve the intercept aim: where to point so a bullet of speed `ps` meets a target
// at (tx,ty) moving (tvx,tvy). Returns a unit [x,y]; falls back to straight-at-now.
function leadAim(sx, sy, tx, ty, tvx, tvy, ps) {
  const rx = tx - sx, ry = ty - sy;
  const a = tvx * tvx + tvy * tvy - ps * ps;
  const b = 2 * (rx * tvx + ry * tvy);
  const c = rx * rx + ry * ry;
  let tHit = 0;
  if (Math.abs(a) < 1e-6) { if (Math.abs(b) > 1e-6) tHit = -c / b; }
  else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      const t1 = (-b - sq) / (2 * a), t2 = (-b + sq) / (2 * a);
      const cands = [t1, t2].filter((t) => t > 0);
      if (cands.length) tHit = Math.min(...cands);
    }
  }
  const ix = tx + tvx * tHit, iy = ty + tvy * tHit;
  const dx = ix - sx, dy = iy - sy, d = Math.hypot(dx, dy) || 1;
  return [dx / d, dy / d];
}

// ~N(0, 0.33) — average of 3 uniforms; scaled by aimSigma for aim jitter.
function gauss() { return (Math.random() + Math.random() + Math.random() - 1.5) / 1.5; }

// Segment (x0,y0)->(x1,y1) vs axis-aligned box (sampled) — is the shot blocked?
function segHitsBox(x0, y0, x1, y1, b) {
  const steps = 24;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
    if (x > b.x && x < b.x + b.w && y > b.y && y < b.y + b.h) return true;
  }
  return false;
}

// Leash the sentry to a midfield circle so knockback can't punt it away — it
// stays put in the middle ("doesn't move"). Call each tick AFTER step().
export function leashSentry(state, sentryId) {
  const p = state.players[sentryId];
  if (!p) return;
  const dx = p.x - CENTER.x, dy = p.y - CENTER.y;
  const d = Math.hypot(dx, dy);
  if (d > SENTRY_LEASH) {
    p.x = CENTER.x + (dx / d) * SENTRY_LEASH;
    p.y = CENTER.y + (dy / d) * SENTRY_LEASH;
    p.kvx = 0; p.kvy = 0; p.vx = 0; p.vy = 0; // kill the fling at the leash edge
  }
}

const rand = (lo, hi) => lo + Math.random() * (hi - lo);

// Center "sentry" enemy: holds midfield (returns to CENTER if shoved), leads its
// aim at the player, and alternates quick-shot bursts with CHARGED power shots —
// all scaled by difficulty (`skill`). Never plants, builds, or carries.
export function trainingSentryInput(state, sentryId, mem, dt, skill = 'normal') {
  const p = state.players[sentryId];
  if (!p) return null;
  const S = SENTRY_SKILL[skill] || SENTRY_SKILL.normal;
  const target = Object.values(state.players).find((q) => q.team !== p.team);
  const tx = target ? target.x : CENTER.x, ty = target ? target.y : CENTER.y;
  const bulletSpeed = (state.settings && state.settings.bulletSpeed) || 700;

  // --- Smart aim: lead the target, blend toward straight-at-now by `lead`, add
  //     difficulty-scaled noise, then slew the stored aim toward it by `turn`. ---
  const [lx, ly] = leadAim(p.x, p.y, tx, ty, (target?.vx || 0) * S.lead, (target?.vy || 0) * S.lead, bulletSpeed);
  const nowx = tx - p.x, nowy = ty - p.y, nl = Math.hypot(nowx, nowy) || 1;
  let dx = lx * S.lead + (nowx / nl) * (1 - S.lead);
  let dy = ly * S.lead + (nowy / nl) * (1 - S.lead);
  const ang = Math.atan2(dy, dx) + gauss() * S.aimSigma;          // aim jitter
  const desX = Math.cos(ang), desY = Math.sin(ang);
  mem.aimX += (desX - mem.aimX) * S.turn;                          // slew toward it
  mem.aimY += (desY - mem.aimY) * S.turn;
  const am = Math.hypot(mem.aimX, mem.aimY) || 1;
  const aimX = mem.aimX / am, aimY = mem.aimY / am;

  // Steer back to the middle; hold still once basically there.
  const hx = CENTER.x - p.x, hy = CENTER.y - p.y, hl = Math.hypot(hx, hy);
  const dead = 12;
  const moveX = hl > dead ? hx / hl : 0;
  const moveY = hl > dead ? hy / hl : 0;

  // --- Fire cycle: idle → (quick burst | charged power shot) → idle. ---
  mem.t -= dt;
  let hold = false, fire = false;
  if (mem.mode === 'idle') {
    if (mem.t <= 0) {
      if (Math.random() < S.powerChance) { mem.mode = 'charge'; mem.t = S.chargeHold; }
      else { mem.mode = 'burst'; mem.t = rand(S.burst[0], S.burst[1]); }
    }
  } else if (mem.mode === 'burst') {
    fire = true;                                                  // spray quick shots (gun paces them)
    if (mem.t <= 0) { mem.mode = 'idle'; mem.t = rand(S.idle[0], S.idle[1]); }
  } else if (mem.mode === 'charge') {
    if (mem.t > 0) hold = true;                                   // wind up a power shot
    else { fire = true; mem.mode = 'idle'; mem.t = rand(S.idle[0], S.idle[1]); } // release it
  }

  // Fire discipline: don't shoot into the steel wall (smarter tiers only). Hold
  // fire until the lane to the player is clear.
  if ((fire || hold) && S.laneCheck && state.arena && state.arena.walls) {
    for (const w of state.arena.walls) {
      if (segHitsBox(p.x, p.y, tx, ty, w)) { fire = false; hold = false; break; }
    }
  }

  return { seq: 0, moveX, moveY, aimX, aimY, hold, fire, special: false, build: false };
}
