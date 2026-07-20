// Training ground — pure logic for the solo practice mode's penned "roaming
// target" dummy. Kept separate from server.js so it's unit-testable and shared
// with the client (the pen outline uses the same PEN box).
import { FIELD } from './constants.js';

// The box the dummy is confined to: in front of team B's (right) goal.
export const PEN = {
  x0: FIELD.W * 0.80, x1: FIELD.W - 40,   // 1600 .. 1960 (never inside the net)
  y0: FIELD.H * 0.22, y1: FIELD.H * 0.78, //  242 .. 858
};

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
    shoot: false, special: false, build: false, charge: 0,
  };
}
