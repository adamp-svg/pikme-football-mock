// Shared game constants — imported by BOTH the server (authoritative sim)
// and the browser client (prediction + rendering). Single source of truth.

export const FIELD = { W: 2000, H: 600 }; // long pitch — camera follows the player

// Goal net: sits `depth` IN from each end wall (moved to the front). `width` is
// the mouth height. The ball scores when it crosses the goal line into the net.
export const GOAL = { width: 210, depth: 70 };
export const POST_R = 9; // goal-post collision radius — the ball bounces off the posts

// 30Hz network rate (rendering stays smooth via rAF + interpolation; 60Hz
// overloaded the mobile WebView). Physics are per-SECOND, converted with DT,
// so feel is identical at any TICK_RATE.
export const TICK_RATE = 30;
export const DT = 1 / TICK_RATE;

export const SNAPSHOT_RATE = 30; // server -> client state broadcasts per second

export const BALL_RADIUS = 16;
// "fraction of speed kept per second" -> per-tick factor (frame-independent).
export const BALL_FRICTION = Math.pow(0.1134, DT); // ~"quick then slows down"
export const BALL_MIN_SPEED = 18; // below this the ball stops
export const WALL_RESTITUTION = 0.72;

export const RELEASE_PICKUP_CD = 0.35; // seconds a just-released ball can't be re-grabbed

// Charged shot: hold the aim to build power. Tap = weak/slow, ≥ CHARGE_TIME = full.
// Full power is 3× a tap (ratio 3:1). A fully-charged bullet also ignores the
// point-blank rule and pushes even up close.
export const SHOOT_CHARGE_TIME = 1.0; // seconds of hold to reach full power
export const CHARGE_MIN_MUL = 1 / 3;  // tap power as a fraction of full (=> 3:1)
export function chargeMul(frac) {
  const f = frac < 0 ? 0 : frac > 1 ? 1 : frac;
  return CHARGE_MIN_MUL + (1 - CHARGE_MIN_MUL) * f;
}

// Bullet knockback ramps with how far the bullet has travelled:
//   < MIN distance  -> no push (point-blank does nothing)
//   >= FULL distance -> full push
export const BULLET_MIN_DIST = 50;
export const BULLET_FULL_DIST = 300;

export const MATCH_DURATION = 120; // seconds (unused — endless match)
export const KICKOFF_FREEZE = 0.7; // brief reset pause after a goal / at start
export const ENDED_HOLD = 8; // unused (endless match)

// One player type. `speed`/`radius` are live-tunable via settings multipliers.
//   Holding the ball: it sticks to you; SHOOT releases/passes it.
//   Not holding:      SHOOT fires a bullet. SPECIAL always plants a Bomb.
export const CHARACTERS = {
  player: {
    key: 'player', name: 'Player', speed: 158, radius: 21, emoji: '',
    shootCooldown: 0.28, special: 'bomb', specialCooldown: 2.4,
  },
};
export const DEFAULT_CHAR = 'player';

// Movement is STRICT — velocity snaps to the target each tick (no gliding).
export const MOVE_ACCEL = 1;

// Bullet fired by the right-stick shoot (both characters).
export const PROJECTILE = {
  speed: 336,      // px/s (~30% slower)
  ttl: 1.3,        // seconds before it fizzles (longer, since it flies slower)
  radius: 8,
  knockback: 200,  // impulse on an enemy hit ≈ one sprite-length of pushback
  ballPush: 476,   // impulse added to the ball it hits
};

// Tank bomb.
export const BOMB = {
  fuse: 1.15,      // seconds from plant to blast
  radius: 168,     // blast reaches this far
  power: 820,      // max impulse at the very center (falls off to 0 at edge)
  ballPush: 1.0,   // multiplier for how hard the blast shoves the ball
  blastLife: 0.45, // seconds the visual blast ring lives
};

// Knockback velocity decays toward zero (players can still move). Per-second
// retention -> per-tick, so it feels the same at any TICK_RATE.
export const KNOCKBACK_DECAY = Math.pow(0.0108, DT);
export const KNOCKBACK_MIN = 4;

// Live-tunable settings (adjustable from the in-game pause menu). These override
// the base numbers above at runtime. speedMul/sizeMul are multipliers on each
// character's base speed/radius; the rest are absolute.
export function defaultSettings() {
  return {
    speedMul: 1.25,
    sizeMul: 1.25,
    carrySpeedMul: 0.9,   // speed multiplier while carrying the ball
    ballSizeMul: 2,
    shotPower: 1200,      // released-ball speed
    bulletSpeed: 900,
    bulletKnockback: 800, // full-power bullet knockback
    bombPower: 2000,
  };
}

// Charge tiers for a bullet hitting an enemy:
//   < QUICK_CHARGE  -> quick shot: no knockback, brief slow (SLOW_MUL) instead
//   >= FULL_CHARGE  -> full power: full knockback + can knock the ball loose
//   in between      -> medium: knockback (scaled), cannot detach the ball
export const QUICK_CHARGE = 0.25;
export const FULL_CHARGE = 0.85;
export const DETACH_SIDE = 170; // random sideways ball speed when knocked off a carrier
export const SLOW_TIME = 1.5;   // seconds a quick-shot slow lasts
export const SLOW_MUL = 0.9;    // speed multiplier while slowed

export const TEAM = {
  A: { key: 'A', name: 'Blue', color: '#3b82f6', attacksRight: true },
  B: { key: 'B', name: 'Red', color: '#ef4444', attacksRight: false },
};

export const MAX_PLAYERS = 4; // 2 per team

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
