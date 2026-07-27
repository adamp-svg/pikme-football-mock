// Training ground — pure logic for the solo practice mode's penned "roaming
// target" dummy. Kept separate from server.js so it's unit-testable and shared
// with the client (the pen outline uses the same PEN box).
import { FIELD, VISION_RANGE, BUSH_REVEAL_DIST, PENALTY, GOAL } from './constants.js';
import { segBlockedByWall, buildArenaFromField } from './arena.js';

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
// Custom training field (from the builder): bushes + steel walls. The CRATES the player drew are
// NOT obstacles here — each becomes an ENEMY (see TRAIN_ENEMIES), so crates:[] in the arena.
export const TRAIN_FIELD = {
  version: 1,
  bushes: [
    { x: 250, y: 150, w: 350, h: 250 }, { x: 0, y: 850, w: 350, h: 250 },
    { x: 400, y: 950, w: 50, h: 50 }, { x: 400, y: 900, w: 50, h: 50 },
    { x: 450, y: 900, w: 50, h: 200 }, { x: 400, y: 1000, w: 50, h: 50 },
    { x: 400, y: 1050, w: 50, h: 50 }, { x: 350, y: 900, w: 50, h: 200 },
  ],
  hardWalls: [
    { cx: 175, cy: 275, angle: 0, hl: 175, ht: 16 },
    { cx: 175, cy: 825, angle: 0, hl: 175, ht: 16 },
    { cx: 525, cy: 950, angle: -1.5707963267948966, hl: 150, ht: 16 },
    { cx: 625, cy: 825, angle: 0, hl: 125, ht: 16 },
  ],
  dryWalls: [], crates: [],
};
export const TRAIN_ARENA = buildArenaFromField(TRAIN_FIELD);

// The 4 crates the player drew → 4 enemies (team B), each with its home spot + role:
//   sentry = stationary, aims + shoots, walks back home if knocked
//   still  = stationary, never shoots, walks back home if knocked
//   keeper = patrols the penalty box to block the goal, never shoots
export const TRAIN_ENEMIES = [
  { key: 'sentry', role: 'sentry', x: 75, y: 125 },                // top-left: shoots
  { key: 'stillB', role: 'still', x: 175, y: 975 },                // bottom-left: idle target
  { key: 'stillM', role: 'still', x: 975, y: 525, leash: false },  // middle: free — flies off when hit (no leash)
  { key: 'keeper', role: 'keeper', x: 1925, y: 525 },              // far goal: goalie
];
export const TRAIN_HOME_LEASH = 170; // how far a stationary enemy can be knocked before it's pinned

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
  // TUTORIAL tier — a sentry whose only job is to be VISIBLY SHOOTING while a seven-year-old is
  // told to build a wall. Not a difficulty step between easy and normal; a different purpose, which
  // is why it is its own entry instead of a tweak to `easy` (the training ground uses those).
  //   * NEVER CHARGES (powerChance 0). Two reasons, both measured. (1) A charge is
  //     `chargeHold` seconds of HOLDING and not firing — dead air in the one step that needs
  //     noise. (2) A charged hit is the only sentry output that can carry knockback above
  //     BUILD_INTERRUPT_KV (300), and that CANCELS the kid's wall windup (sim.js). A quick
  //     uncharged shot applies no push at all — just a slow stack — so this sentry can hammer
  //     away without ever making the lesson impossible to complete.
  //   * DUTY CYCLE, not difficulty. easy is silent 1.6-3.6s between 0.2-0.6s bursts — roughly 15%
  //     of the time firing, so a kid can easily spend the whole step being shot at zero times.
  //     1.2-2.0s of fire against 0.3-0.6s of quiet is ~75%. The rate INSIDE a burst is capped by
  //     the gun, not by this table: shootCooldown 0.2s x MAG_SIZE 3 then EMPTY_RELOAD 1.2s
  //     = ~1.9 shots/sec sustained, so `fire` held down is self-limiting and never a wall of lead.
  //   * aimSigma is left at easy's 0.16 — the tracers must fly past the kid, not through them.
  tutorial: { idle: [0.30, 0.60], burst: [1.20, 2.00], powerChance: 0, chargeHold: 0.75, aimSigma: 0.16, lead: 0.55, turn: 0.14, laneCheck: false },
};

// Re-arm a sentry's firing memory so it opens fire THIS TICK, already facing (atX,atY).
//
// createSentryMem() is right for a sentry that exists from the moment its room boots: it starts in
// a short idle hold and its aim points at -x. It is WRONG for a body that only BECOMES a sentry
// partway through a script (the tutorial's wall step re-roles the same foe it just used as a bomb
// target). Such a foe arrives holding whatever mem it was created with — an idle countdown plus an
// aim vector pointing nowhere in particular — so the step opens with the sentry standing there
// silently slewing its aim around, and the first shot lands after the moment it was meant to
// motivate. Call this when the ROLE flips, not when the body spawns.
//
// mode 'burst' means `fire` is held for `t` seconds straight; the gun's own cooldown/mag paces the
// shots inside it (see the tutorial tier above), so this is "start shooting now", not "spray".
export function armSentryFiring(mem, fromX, fromY, atX, atY, skill = 'normal') {
  if (!mem) return mem;
  const S = SENTRY_SKILL[skill] || SENTRY_SKILL.normal;
  const dx = atX - fromX, dy = atY - fromY, d = Math.hypot(dx, dy) || 1;
  mem.aimX = dx / d; mem.aimY = dy / d;   // already on target — no slew-in before the first shot
  mem.mode = 'burst';
  mem.t = S.burst[1];                     // a full-length opening burst
  return mem;
}

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
  const steps = 48; // dense enough to catch a thin (32px) wall
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
    if (x > b.x && x < b.x + b.w && y > b.y && y < b.y + b.h) return true;
  }
  return false;
}

// Leash the sentry to a midfield circle so knockback can't punt it away — it
// stays put in the middle ("doesn't move"). Call each tick AFTER step().
export function leashSentry(state, sentryId, home = CENTER, leash = SENTRY_LEASH) {
  const p = state.players[sentryId];
  if (!p) return;
  const dx = p.x - home.x, dy = p.y - home.y;
  const d = Math.hypot(dx, dy);
  if (d > leash) {
    p.x = home.x + (dx / d) * leash;
    p.y = home.y + (dy / d) * leash;
    p.kvx = 0; p.kvy = 0; p.vx = 0; p.vy = 0; // kill the fling at the leash edge
  }
}

// STILL enemy: never moves on its own, never shoots — just walks back to its home spot if knocked.
export function trainingStillInput(state, id, home) {
  const p = state.players[id]; if (!p) return null;
  const dx = home.x - p.x, dy = home.y - p.y, d = Math.hypot(dx, dy), dead = 12;
  return { seq: 0, moveX: d > dead ? dx / d : 0, moveY: d > dead ? dy / d : 0, aimX: 1, aimY: 0, hold: false, fire: false, special: false, build: false };
}

// KEEPER: patrols in front of the RIGHT goal, moving to sit on the ball→goal line so it blocks
// shots. Confined to the penalty box (keeperClamp), never shoots.
export function trainingKeeperInput(state, id) {
  const p = state.players[id]; if (!p) return null;
  const b = state.ball;
  const gx = FIELD.W, gy = FIELD.H / 2;                 // right-goal centre
  const keeperX = FIELD.W - 90;                          // hold a little off the line
  let ty = gy;
  const dx = gx - b.x;
  if (dx > 1) ty = b.y + (gy - b.y) * ((keeperX - b.x) / dx); // where the ball→goal line crosses keeperX
  ty = clampN(ty, (FIELD.H - GOAL.width) / 2 - 20, (FIELD.H + GOAL.width) / 2 + 20); // stay across the mouth
  const mvx = keeperX - p.x, mvy = ty - p.y, m = Math.hypot(mvx, mvy), dead = 10;
  const ax = b.x - p.x, ay = b.y - p.y, al = Math.hypot(ax, ay) || 1;
  return { seq: 0, moveX: m > dead ? mvx / m : 0, moveY: m > dead ? mvy / m : 0, aimX: ax / al, aimY: ay / al, hold: false, fire: false, special: false, build: false };
}

// Keep the keeper inside the RIGHT penalty box after physics (knockback can't punt it out).
export function keeperClamp(state, id) {
  const p = state.players[id]; if (!p) return;
  const x0 = FIELD.W - PENALTY.depth, x1 = FIELD.W - 18;
  const y0 = (FIELD.H - PENALTY.width) / 2, y1 = (FIELD.H + PENALTY.width) / 2;
  if (p.x < x0 || p.x > x1) { p.x = clampN(p.x, x0, x1); p.vx = 0; p.kvx = 0; }
  if (p.y < y0 || p.y > y1) { p.y = clampN(p.y, y0, y1); p.vy = 0; p.kvy = 0; }
}

const rand = (lo, hi) => lo + Math.random() * (hi - lo);

// Fog of war for the sentry: can it actually SEE `target`? Same rule as the match bots —
// out of view (> VISION_RANGE) or hidden in a (training-arena) bush is invisible, unless
// close, firing, or in the open. So hiding / breaking line of sight works here too.
function sentrySees(sentry, target, state) {
  if (!target) return false;
  const dist = Math.hypot(sentry.x - target.x, sentry.y - target.y);
  if (dist > VISION_RANGE) return false;                       // out of sight (too far)
  const walls = (state.arena && state.arena.walls) || [];
  if (walls.some((w) => segBlockedByWall(w, sentry.x, sentry.y, target.x, target.y, 0))) return false; // a wall breaks line of sight — hide behind the steel wall
  const bushes = (state.arena && state.arena.bushes) || [];
  const inBush = bushes.some((g) => target.x > g.x && target.x < g.x + g.w && target.y > g.y && target.y < g.y + g.h);
  if (!inBush) return true;                                     // in the open + in view
  if (target.firing) return true;                              // muzzle flash reveals
  if (dist < BUSH_REVEAL_DIST) return true;                    // close enough to spot
  return false;                                                // bushed + far = HIDDEN
}

// Center "sentry" enemy: holds midfield (returns to CENTER if shoved), leads its
// aim at the player, and alternates quick-shot bursts with CHARGED power shots —
// all scaled by difficulty (`skill`). Never plants, builds, or carries.
export function trainingSentryInput(state, sentryId, mem, dt, skill = 'normal', home = CENTER) {
  const p = state.players[sentryId];
  if (!p) return null;
  const S = SENTRY_SKILL[skill] || SENTRY_SKILL.normal;
  const target = Object.values(state.players).find((q) => q.team !== p.team);
  const tx = target ? target.x : home.x, ty = target ? target.y : home.y;
  const bulletSpeed = (state.settings && state.settings.bulletSpeed) || 700;
  const canSee = sentrySees(p, target, state); // FOG: only track/fire when we actually see them

  // --- Smart aim: lead the target, blend toward straight-at-now by `lead`, add
  //     difficulty-scaled noise, then slew the stored aim toward it by `turn`. ---
  // Only track while the target is VISIBLE; when it hides / leaves sight, HOLD the last
  // aim (the sentry keeps facing where it last saw them, it doesn't x-ray the bush).
  if (canSee) {
    const [lx, ly] = leadAim(p.x, p.y, tx, ty, (target?.vx || 0) * S.lead, (target?.vy || 0) * S.lead, bulletSpeed);
    const nowx = tx - p.x, nowy = ty - p.y, nl = Math.hypot(nowx, nowy) || 1;
    let dx = lx * S.lead + (nowx / nl) * (1 - S.lead);
    let dy = ly * S.lead + (nowy / nl) * (1 - S.lead);
    const ang = Math.atan2(dy, dx) + gauss() * S.aimSigma;          // aim jitter
    const desX = Math.cos(ang), desY = Math.sin(ang);
    mem.aimX += (desX - mem.aimX) * S.turn;                          // slew toward it
    mem.aimY += (desY - mem.aimY) * S.turn;
  }
  const am = Math.hypot(mem.aimX, mem.aimY) || 1;
  const aimX = mem.aimX / am, aimY = mem.aimY / am;

  // Steer back to the middle; hold still once basically there.
  const hx = home.x - p.x, hy = home.y - p.y, hl = Math.hypot(hx, hy);
  const dead = 12;
  const moveX = hl > dead ? hx / hl : 0;
  const moveY = hl > dead ? hy / hl : 0;

  // --- Fire cycle: idle → (quick burst | charged power shot) → idle. ---
  // Blind (can't see the target)? Relax to idle and HOLD FIRE — no shooting a hidden or
  // out-of-sight player. Re-engages the instant they step out / get close / fire.
  mem.t -= dt;
  let hold = false, fire = false;
  if (!canSee) {
    if (mem.mode !== 'idle') { mem.mode = 'idle'; mem.t = rand(S.idle[0], S.idle[1]); }
  } else if (mem.mode === 'idle') {
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
