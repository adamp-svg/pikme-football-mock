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
export const TRAIN_WALLS = [{ x: 1280, y: 720, w: 320, h: 250 }];  // bottom-right steel wall
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
  return { t: 0.8, firing: false }; // brief hold before the first burst
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

// Center "sentry" enemy: holds midfield (returns to CENTER if shoved), ALWAYS
// faces the player, and fires in random bursts — sometimes a flurry, sometimes
// nothing at all. Never plants, builds, or carries. Returns an input object.
export function trainingSentryInput(state, sentryId, mem, dt) {
  const p = state.players[sentryId];
  if (!p) return null;
  // Always look at the (human) opponent; aim at CENTER if somehow none exists.
  const target = Object.values(state.players).find((q) => q.team !== p.team);
  const tx = target ? target.x : CENTER.x, ty = target ? target.y : CENTER.y;
  const ax = tx - p.x, ay = ty - p.y, al = Math.hypot(ax, ay) || 1;

  // Steer back to the middle; hold still once basically there.
  const hx = CENTER.x - p.x, hy = CENTER.y - p.y, hl = Math.hypot(hx, hy);
  const dead = 12;
  const moveX = hl > dead ? hx / hl : 0;
  const moveY = hl > dead ? hy / hl : 0;

  // Bursty fire: flip between a firing window (sprays as fast as the gun allows)
  // and an idle window (sometimes long — that's the "sometimes none").
  mem.t -= dt;
  if (mem.t <= 0) {
    if (mem.firing) { mem.firing = false; mem.t = Math.random() < 0.35 ? rand(1.8, 3.8) : rand(0.5, 1.6); }
    else { mem.firing = true; mem.t = rand(0.25, 1.3); }
  }

  return {
    seq: 0, moveX, moveY, aimX: ax / al, aimY: ay / al,
    hold: false, fire: mem.firing, special: false, build: false, // quick shots (no charge)
  };
}
