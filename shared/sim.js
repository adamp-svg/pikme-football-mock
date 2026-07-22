// Authoritative football simulation. Pure logic, no rendering, no networking.
// Runs on the SERVER as the source of truth, and on the CLIENT for local
// prediction of the player's own movement. Same rules everywhere = no desync.

import {
  FIELD, GOAL, POST_R, BALL_RADIUS, BALL_FRICTION, BALL_MIN_SPEED, WALL_RESTITUTION,
  RELEASE_PICKUP_CD, MATCH_DURATION, KICKOFF_FREEZE, GOAL_RESET, GOAL_FREEZE_HOLD,
  PENALTY, PENALTY_KNOCKBACK_MUL, BALL_BUMP_SPEED, BALL_BUMP_SCALE,
  OVERCHARGE_TTL, OVERCHARGE_MUL, OVERCHARGE_ROLL, KICK_BLOCK_REBOUND, FULL_DRIVE_ROLL, KEEPER_BREAK_ROLL,
  OVERCHARGE_FULL_GAIN, OVERCHARGE_PARTIAL_GAIN, FULL_BUMP_MUL, OVERCHARGE_BULLET_MUL, BALL_WALL_POP_SPEED, BOMB_LAUNCH_MAX, BOMB_STACK_MAX,
  BOMB_CENTER_R, BOMB_ENEMY_MUL, BOMB_LAUNCH_TTL, BOMB_TACKLE_KB,
  BOMB_CENTER_LAUNCH_MUL, BOMB_CARRY_LAUNCH_MUL, BOMB_WALL_CANNON_MUL, BOMB_WALL_DIST, BOMB_WALL_COS,
  BOMB_COMBINE_RADIUS, BOMB_STACK_PER, BOMB_STACK_RADIUS, FLY_HIT_SPEED, FLY_HIT_SCALE,
  CHARACTERS, DEFAULT_CHAR, PROJECTILE, BOMB, KNOCKBACK_DECAY, KNOCKBACK_MIN, BOMB_LAUNCH_DECAY, BOMB_LAUNCH_GLIDE, MOVE_ACCEL,
  QUICK_CHARGE, FULL_CHARGE, DETACH_SIDE, CARRIER_KNOCKBACK_MUL, SLOW_TIME, SLOW_MUL,
  MAG_SIZE, AMMO_REGEN, EMPTY_RELOAD,
  WALL_BOUNCE, TRAMPOLINE, BUILT_WALL, BUILD_MAG, BUILD_RELOAD, BUILD_COOLDOWN, MAX_BUILT_WALLS, FRAGILE_HP, FRAGILE_PASS_SPEED,
  SHOOT_CHARGE_TIME,
  defaultSettings, chargeMul, clamp,
} from './constants.js';
import { ARENA, resolveWalls, resolveCircleBox, pointInBox, circleHitsBox, nearestOnWall } from './arena.js';

// Built walls can be built at an ANGLE. Their orientation is quantized to WALL_ANGLE_STEPS
// steps over a half-turn (a wall is 180°-symmetric) so it round-trips the wire exactly.
const WALL_ANGLE_STEPS = 16;
const WALL_ANGLE_QUANT = Math.PI / WALL_ANGLE_STEPS;

// Obstacle layout for this state — training rooms override it with a custom
// arena (state.arena); everything else uses the global mirror-symmetric ARENA.
const arenaOf = (state) => state.arena || ARENA;

const GOAL_TOP = (FIELD.H - GOAL.width) / 2;
const GOAL_BOTTOM = (FIELD.H + GOAL.width) / 2;
const PENALTY_TOP = (FIELD.H - PENALTY.width) / 2;
const PENALTY_BOTTOM = (FIELD.H + PENALTY.width) / 2;

// Is player `t` inside the penalty area they are ATTACKING (the enemy's box)?
function inEnemyPenalty(t) {
  if (t.y < PENALTY_TOP || t.y > PENALTY_BOTTOM) return false;
  return t.team === 'A' ? t.x > FIELD.W - PENALTY.depth : t.x < PENALTY.depth;
}
// Knockback multiplier for a hit on `t` — attackers in the enemy box resist it.
function knockMul(t) {
  return inEnemyPenalty(t) ? PENALTY_KNOCKBACK_MUL : 1;
}
// Is player `t` inside the penalty area they DEFEND (their own box)? Used for the
// keeper-diminish: a full kick only deflects (not dead-stops) off a defender here.
function inOwnPenalty(t) {
  if (t.y < PENALTY_TOP || t.y > PENALTY_BOTTOM) return false;
  return t.team === 'A' ? t.x < PENALTY.depth : t.x > FIELD.W - PENALTY.depth;
}
// Reset a ball's "kick identity" — call wherever the ball becomes free via a NON-kick
// event (pickup, kickoff, bullet-push, strip, bomb-pop). Otherwise a stale lastKicker
// would earn overcharge off a fast ball they never actually kicked.
function clearKick(b) { b.kickTier = 0; b.overSpent = false; b.lastKicker = null; }

// OVERCHARGE is a consumable meter (p.powerMeter 0..1). A FORCEFUL hit adds `amt` —
// a full-power hit/strip/bomb fills it (1.0), a lower-power hit fills half (0.5), so it
// takes ONE full hit OR TWO partials. When it fills, the player is READY (p.power) for
// exactly ONE overcharge shot/kick, which spends it. Never stacks past ready.
function earnPower(p, amt) {
  if (!p || p.power) return;
  p.powerMeter = (p.powerMeter || 0) + amt;
  if (p.powerMeter >= 1) { p.power = true; p.powerT = OVERCHARGE_TTL; p.powerMeter = 0; }
}

// Spawn spots — each team near its OWN goal (A defends left, B defends right).
function spawnPos(team, slot) {
  const y = slot === 0 ? FIELD.H * 0.36 : FIELD.H * 0.64;
  const x = team === 'A' ? FIELD.W * 0.15 : FIELD.W * 0.85;
  return { x, y };
}

export function createState() {
  return {
    phase: 'playing', // endless — never 'ended'
    tick: 0,
    elapsed: 0, // seconds played (counts up)
    resetTimer: KICKOFF_FREEZE, // >0 => kickoff freeze
    players: {}, // id -> player
    ball: { x: FIELD.W / 2, y: FIELD.H / 2, vx: 0, vy: 0, owner: null, pickupCd: 0, lastTouch: null, kickTier: 0 },
    score: { A: 0, B: 0 },
    lastGoal: null, // team key that just scored (for a flash), cleared after freeze
    projectiles: [], // bullets
    bombs: [], // planted bombs (fusing)
    builtWalls: [], // player-built destructible walls { id, x, y, w, h, hp, maxHp, team, ttl }
    blasts: [], // short-lived explosion visuals
    impacts: [], // short-lived bullet collision events for synchronized VFX
    pendingReset: false, // goal scored — snap to kickoff once the "show" hold ends
    pendingBallTeam: null, // team that gets the ball at the delayed kickoff
    settings: defaultSettings(), // live-tunable from the pause menu
    _nid: 1, // entity id counter
  };
}

// Effective (settings-adjusted) radii.
function radiusOf(p, state) {
  return CHARACTERS[p.char].radius * state.settings.sizeMul;
}
function ballRadius(state) {
  return BALL_RADIUS * state.settings.ballSizeMul;
}

// Attach the ball to a player of `team` (kickoff possession). Positions it in
// front of that player.
export function attachBall(state, team) {
  const holder = Object.values(state.players).find((p) => p.team === team);
  state.ball.pickupCd = 0;
  state.ball.lastTouch = team;
  if (!holder) { state.ball.owner = null; return; }
  state.ball.owner = holder.id;
  const off = radiusOf(holder, state) + ballRadius(state);
  state.ball.x = holder.x + holder.aimX * off;
  state.ball.y = holder.y + holder.aimY * off;
  state.ball.vx = 0; state.ball.vy = 0; clearKick(state.ball);
}

export function addPlayer(state, id, { name, char, team, slot, isBot, cosmetic, buffs }) {
  const c = CHARACTERS[char] ? char : DEFAULT_CHAR;
  const p = {
    id, name, char: c, team, slot, isBot: !!isBot,
    cosmetic: cosmetic || null, // "hero:skin" visual id; never read by physics

    ...spawnPos(team, slot),
    vx: 0, vy: 0,
    kvx: 0, kvy: 0, // knockback velocity (decays), added on top of movement
    aimX: team === 'A' ? 1 : -1, aimY: 0,
    shootCd: 0, // bullet cooldown (per-shot pacing within a mag)
    ammo: MAG_SIZE, // rounds loaded
    ammoT: 0,       // seconds accumulated toward the next trickle-regen round
    reloadLock: 0,  // >0 while a fully-emptied mag is reloading (can't fire)
    specialCd: 0, // bomb cooldown
    slowTimer: 0, // seconds of quick-shot slow remaining
    bombLaunch: 0, // >0 => rocket-jumping off own bomb; can tackle an enemy
    launchGlide: 0, // >0 => recently bomb-launched; knockback decays gently (smooth arc)
    trampCd: 0, // >0 => recently launched by a trampoline (no re-launch)
    power: false, // OVERCHARGE READY: earned by filling the meter; enables ONE overcharge shot/kick
    powerT: 0,    // seconds the READY overcharge lasts if unused (decays)
    powerMeter: 0, // 0..1 progress toward overcharge (1 full hit or 2 partial hits fills it)
    buildAmmo: BUILD_MAG, // wall charges available
    buildAmmoT: 0,        // seconds accumulated toward the next wall charge
    buildCd: 0,           // min pacing between wall placements
    // DIFFICULTY multipliers (bots only): bot-ai rewrites chargeRate/cdMul from the skill preset
    // every tick; humans keep 1. CARD buffs live in the separate card* fields so they stack ON TOP
    // of difficulty for bots and apply cleanly for humans without bot-ai ever clobbering them.
    chargeRate: 1,
    cdMul: 1,
    // Card-power multipliers (BOTH humans AND bots): Shot slot -> faster charge (cardShot), Speed slot
    // -> faster move (speedBuff), Utility slot -> shorter bomb/wall cooldowns (cardUtil). Default 1.
    cardShot: (buffs && buffs.cardShot) || 1,
    speedBuff: (buffs && buffs.speedBuff) || 1,
    cardUtil: (buffs && buffs.cardUtil) || 1,
    firing: false, // fired/released this tick (flash)
    lastSeq: 0, // last input seq applied (for client reconciliation)
    _fire: false, _special: false, _build: false, _charge: 0,
  };
  state.players[id] = p;
  return p;
}

export function removePlayer(state, id) {
  delete state.players[id];
}

// Snap everyone to their kickoff spots + reset the ball. `ballTeam` (if given)
// starts with the ball attached. Does NOT touch the reset countdown.
function repositionKickoff(state, ballTeam) {
  for (const id in state.players) {
    const p = state.players[id];
    const s = spawnPos(p.team, p.slot);
    p.x = s.x; p.y = s.y; p.vx = 0; p.vy = 0; p.kvx = 0; p.kvy = 0; p.power = false; p.powerT = 0; p.powerMeter = 0; p.launchGlide = 0;
    p.aimX = p.team === 'A' ? 1 : -1; p.aimY = 0;
  }
  state.ball = { x: FIELD.W / 2, y: FIELD.H / 2, vx: 0, vy: 0, owner: null, pickupCd: 0, lastTouch: null, kickTier: 0 };
  state.projectiles = [];
  state.bombs = [];
  state.builtWalls = []; // built defences don't survive a kickoff
  state.impacts = [];
  if (ballTeam) attachBall(state, ballTeam);
}

function separatePlayers(state) {
  const arr = Object.values(state.players);
  // Iterate a few times so clustered players fully resolve (no clipping/overlap).
  for (let pass = 0; pass < 4; pass++) {
    let moved = false;
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const a = arr[i], b = arr[j];
        const ra = radiusOf(a, state), rb = radiusOf(b, state);
        let dx = b.x - a.x, dy = b.y - a.y;
        let d = Math.hypot(dx, dy) || 0.0001;
        const min = ra + rb;
        if (d < min) {
          const push = (min - d) / 2;
          const nx = dx / d, ny = dy / d;
          a.x -= nx * push; a.y -= ny * push;
          b.x += nx * push; b.y += ny * push;
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
  // Keep everyone inside the pitch after separation.
  for (const p of arr) {
    const r = radiusOf(p, state);
    p.x = clamp(p.x, r, FIELD.W - r);
    p.y = clamp(p.y, r, FIELD.H - r);
  }
}

// Bounce the (free) ball off a circular goal post at (px,py).
function bouncePost(b, px, py, R) {
  const dx = b.x - px, dy = b.y - py;
  const d = Math.hypot(dx, dy) || 0.0001;
  const min = R + POST_R;
  if (d < min) {
    const nx = dx / d, ny = dy / d;
    b.x = px + nx * min; b.y = py + ny * min; // push out of the post
    const vn = b.vx * nx + b.vy * ny;
    if (vn < 0) { // moving into the post -> reflect
      b.vx -= (1 + WALL_RESTITUTION) * vn * nx;
      b.vy -= (1 + WALL_RESTITUTION) * vn * ny;
    }
  }
}

function handleBallBounds(state) {
  const b = state.ball;
  const R = ballRadius(state);
  // top / bottom walls
  if (b.y < R) { b.y = R; b.vy = Math.abs(b.vy) * WALL_RESTITUTION; }
  if (b.y > FIELD.H - R) { b.y = FIELD.H - R; b.vy = -Math.abs(b.vy) * WALL_RESTITUTION; }

  // Goal line is AT the field edge (x=0 / x=FIELD.W); the net sits BEHIND it.
  // POSTS at the mouth ends — the ball bounces off the woodwork.
  bouncePost(b, 0, GOAL_TOP, R);
  bouncePost(b, 0, GOAL_BOTTOM, R);
  bouncePost(b, FIELD.W, GOAL_TOP, R);
  bouncePost(b, FIELD.W, GOAL_BOTTOM, R);

  const inMouth = b.y > GOAL_TOP && b.y < GOAL_BOTTOM;

  if (inMouth) {
    // In the mouth the ball can cross the line into the net (behind the pitch).
    // A goal counts ONLY from the FRONT: crossing the line while moving inward,
    // between the posts, last touched by the ATTACKING team (no own goals).
    if (b.x < 0) {                                   // left net — B attacks
      if (b.lastTouch === 'B' && b.vx < 0) return goal(state, 'B');
      b.x = R; b.vx = Math.abs(b.vx) * WALL_RESTITUTION; return; // no goal
    }
    if (b.x > FIELD.W) {                             // right net — A attacks
      if (b.lastTouch === 'A' && b.vx > 0) return goal(state, 'A');
      b.x = FIELD.W - R; b.vx = -Math.abs(b.vx) * WALL_RESTITUTION; return;
    }
    return; // inside the mouth, not yet at the line — let it fly
  }

  // Solid end walls outside the goal mouth.
  if (b.x < R) { b.x = R; b.vx = Math.abs(b.vx) * WALL_RESTITUTION; }
  if (b.x > FIELD.W - R) { b.x = FIELD.W - R; b.vx = -Math.abs(b.vx) * WALL_RESTITUTION; }
}

function goal(state, team) {
  state.score[team]++;
  state.lastGoal = team;
  // Freeze in the scoring positions (ball stays in the net) for GOAL_FREEZE_HOLD
  // seconds so players see it, THEN snap to kickoff (see the reset branch in step).
  state.resetTimer = GOAL_RESET;
  state.pendingReset = true;
  state.pendingBallTeam = team === 'A' ? 'B' : 'A'; // conceding team restarts with the ball
  return team;
}

// One authoritative step. `inputs` is a map: playerId -> input.
// input = { seq, moveX, moveY, aimX, aimY, kick }
export function step(state, inputs, dt) {
  state.elapsed += dt;

  // Match clock: at MATCH_DURATION the match ends. Play freezes; the room
  // returns to the lobby after a short hold (handled by the server).
  // Training rooms set state.noClock — they run endlessly, never 'ended'.
  if (!state.noClock && state.phase === 'playing' && state.elapsed >= MATCH_DURATION) {
    state.phase = 'ended';
  }
  if (state.phase === 'ended') {
    state.tick++;
    return; // frozen final state, kept broadcasting for the end screen
  }

  // Kickoff freeze: bodies are still, but we still record last input seq so
  // client reconciliation stays consistent.
  if (state.resetTimer > 0) {
    state.resetTimer -= dt;
    // After a goal: hold in the scoring positions, then snap to kickoff spots.
    if (state.pendingReset && state.resetTimer <= GOAL_RESET - GOAL_FREEZE_HOLD) {
      repositionKickoff(state, state.pendingBallTeam);
      state.pendingReset = false;
    }
    for (const id in state.players) {
      const inp = inputs[id];
      if (inp) state.players[id].lastSeq = inp.seq;
    }
    if (state.resetTimer <= 0) { state.resetTimer = 0; state.lastGoal = null; state.pendingReset = false; }
    state.tick++;
    return;
  }

  // --- Players ---
  for (const id in state.players) {
    const p = state.players[id];
    const ch = CHARACTERS[p.char];
    const inp = inputs[id] || { moveX: 0, moveY: 0, aimX: 0, aimY: 0, shoot: false, special: false, seq: p.lastSeq };

    let mx = inp.moveX || 0, my = inp.moveY || 0;
    const mlen = Math.hypot(mx, my);
    if (mlen > 1) { mx /= mlen; my /= mlen; }

    // Ease velocity toward the target (smoothing) instead of snapping.
    let spd = ch.speed * state.settings.speedMul * (p.speedBuff || 1); // Speed-slot card buff (human), 1 otherwise
    if (state.ball.owner === p.id) spd *= state.settings.carrySpeedMul; // slower while carrying
    if (p.slowTimer > 0) { spd *= SLOW_MUL; p.slowTimer -= dt; } // hit by a quick shot
    if (p.bombLaunch > 0) p.bombLaunch -= dt; // rocket-jump tackle window
    const tvx = mx * spd, tvy = my * spd;
    p.vx += (tvx - p.vx) * MOVE_ACCEL;
    p.vy += (tvy - p.vy) * MOVE_ACCEL;
    // Position = movement + decaying knockback. Substep the move + wall-resolve so a
    // fast (knockback) player can't tunnel through a thin wall in a single tick.
    const rad = radiusOf(p, state);
    const pSteps = Math.max(1, Math.ceil(Math.hypot((p.vx + p.kvx) * dt, (p.vy + p.kvy) * dt) / (BUILT_WALL.thick * 0.5)));
    for (let s = 0; s < pSteps; s++) {
      p.x = clamp(p.x + (p.vx + p.kvx) * dt / pSteps, rad, FIELD.W - rad);
      p.y = clamp(p.y + (p.vy + p.kvy) * dt / pSteps, rad, FIELD.H - rad);
      resolveWalls(p, rad, state.builtWalls, undefined, arenaOf(state).walls); // slide along static + built walls each substep
    }
    const kdec = p.launchGlide > 0 ? BOMB_LAUNCH_DECAY : KNOCKBACK_DECAY; // gentle glide while launched → smooth arc
    p.kvx *= kdec; p.kvy *= kdec;
    if (p.launchGlide > 0) p.launchGlide = Math.max(0, p.launchGlide - dt);
    if (Math.hypot(p.kvx, p.kvy) < KNOCKBACK_MIN) { p.kvx = 0; p.kvy = 0; p.launchGlide = 0; }
    // Trampolines fling you the way you're moving (or aim, if standing still).
    p.trampCd = Math.max(0, p.trampCd - dt);
    if (p.trampCd <= 0) {
      for (const t of arenaOf(state).trampolines) {
        if (Math.hypot(p.x - t.x, p.y - t.y) < t.r + rad * 0.4) {
          const sp = Math.hypot(p.vx, p.vy);
          let dx, dy;
          if (sp > TRAMPOLINE.minMove) { dx = p.vx / sp; dy = p.vy / sp; }
          else { const al = Math.hypot(p.aimX, p.aimY) || 1; dx = p.aimX / al; dy = p.aimY / al; }
          p.kvx += dx * TRAMPOLINE.power; p.kvy += dy * TRAMPOLINE.power;
          p.trampCd = TRAMPOLINE.cooldown;
          state.impacts.push({ id: state._nid++, type: 'tramp', target: null, x: t.x, y: t.y, dx, dy, team: p.team, life: 0.3, maxLife: 0.3 });
          break;
        }
      }
    }

    // Aim follows the aim stick, else the movement direction.
    const alen = Math.hypot(inp.aimX || 0, inp.aimY || 0);
    if (alen > 0.15) { p.aimX = inp.aimX / alen; p.aimY = inp.aimY / alen; }
    else if (mlen > 0.15) { p.aimX = mx / (mlen || 1); p.aimY = my / (mlen || 1); }

    p.shootCd = Math.max(0, p.shootCd - dt);
    p.specialCd = Math.max(0, p.specialCd - dt);
    // Wall-build charges trickle back one every BUILD_RELOAD seconds (up to BUILD_MAG).
    p.buildCd = Math.max(0, p.buildCd - dt);
    if (p.buildAmmo < BUILD_MAG) {
      p.buildAmmoT += dt;
      const buildReload = BUILD_RELOAD * (p.cdMul || 1) * (p.cardUtil || 1);
      if (p.buildAmmoT >= buildReload) { p.buildAmmo = Math.min(BUILD_MAG, p.buildAmmo + 1); p.buildAmmoT -= buildReload; }
    }
    // Ammo: a fully-emptied mag reloads all at once after EMPTY_RELOAD; otherwise
    // rounds trickle back one per AMMO_REGEN seconds.
    if (p.reloadLock > 0) {
      p.reloadLock -= dt;
      if (p.reloadLock <= 0) { p.reloadLock = 0; p.ammo = MAG_SIZE; p.ammoT = 0; }
    } else if (p.ammo < MAG_SIZE) {
      p.ammoT += dt;
      if (p.ammoT >= AMMO_REGEN) { p.ammo = Math.min(MAG_SIZE, p.ammo + 1); p.ammoT -= AMMO_REGEN; }
    }
    p.firing = false;
    p._fire = !!inp.fire;
    p._special = !!inp.special;
    p._build = !!inp.build;
    // Sim-owned charge ramp: charge builds while the fire trigger is HELD, so bots
    // pay the same ~1s wind-up as humans (chargeRate lets harder bots reach full
    // sooner). A release (fire) consumes it; letting go WITHOUT firing (cancel)
    // resets it. Overcharge meter decays if unused.
    if (inp.hold) p._charge = Math.min(1, p._charge + dt / SHOOT_CHARGE_TIME * (p.chargeRate || 1) * (p.cardShot || 1));
    else if (!p._fire) p._charge = 0;
    if (p.powerT > 0) { p.powerT -= dt; if (p.powerT <= 0) { p.powerT = 0; p.power = false; } }
    p.lastSeq = inp.seq != null ? inp.seq : p.lastSeq;
  }

  resolveFlyingHits(state); // any fast-flying player body-checks an enemy; a bomb-launch tackle can steal
  separatePlayers(state);
  // Separation can nudge a body into a wall — push everyone back out once more.
  for (const id in state.players) { const p = state.players[id]; resolveWalls(p, radiusOf(p, state), state.builtWalls, undefined, arenaOf(state).walls); }

  // --- Per-player actions ---
  //   Holding the ball + SHOOT  -> release it in the aim direction (shot/pass)
  //   Not holding      + SHOOT  -> fire a bullet
  //   SPECIAL                   -> plant a bomb
  const b = state.ball;
  for (const id in state.players) {
    const p = state.players[id];
    const ch = CHARACTERS[p.char];
    if (p._fire) {
      const eff = p._charge;            // sim-accumulated hold power (0..1)
      const isFull = eff >= FULL_CHARGE;   // hold-based full — anyone can reach it
      const isOver = isFull && p.power;    // OVERCHARGE = full + earned meter
      if (b.owner === p.id) {
        const cm = chargeMul(eff); // charged shot = further/faster
        b.owner = null;
        b.lastTouch = p.team;
        b.lastKicker = p.id; // who launched it — refills power if this kick bumps an enemy
        b.kickTier = isOver ? 2 : isFull ? 1 : 0; // how it behaves hitting an enemy (see the bump handler)
        b.overSpent = isOver; // an overcharge kick's ball can't re-farm the meter (any later bump)
        b.vx = p.aimX * state.settings.shotPower * cm;
        b.vy = p.aimY * state.settings.shotPower * cm;
        b.pickupCd = RELEASE_PICKUP_CD;
        p.firing = true;
        if (isOver) { p.power = false; p.powerT = 0; p.powerMeter = 0; } // an OVERCHARGE kick spends the meter
      } else if (p.shootCd <= 0 && p.reloadLock <= 0 && p.ammo >= 1) {
        // A FULL bullet strips a carrier; an OVERCHARGE bullet (isOver) strips AND pushes
        // harder — and spends the meter, same as an overcharge kick.
        fireBullet(state, p, ch, eff, isOver);
        p.ammo -= 1;
        if (p.ammo <= 0) { p.ammo = 0; p.reloadLock = EMPTY_RELOAD; p.ammoT = 0; }
        if (isOver) { p.power = false; p.powerT = 0; p.powerMeter = 0; }
      }
      p._charge = 0; // consume the wind-up on release
    }
    if (p._special && p.specialCd <= 0) useSpecial(state, p, ch);
    if (p._build && p.buildCd <= 0 && p.buildAmmo >= 1) buildWall(state, p);
  }

  // --- Ball: glued to a holder, or free physics + pickup ---
  if (b.owner && state.players[b.owner]) {
    const h = state.players[b.owner];
    const ballR = ballRadius(state);
    const off = radiusOf(h, state) + ballR;
    // where the ball WANTS to glue (in front) — kept inside the pitch so a carrier at the
    // line can't park the ball past the goal line (a free release would then tap in).
    const gx = clamp(h.x + h.aimX * off, ballR, FIELD.W - ballR);
    const gy = clamp(h.y + h.aimY * off, ballR, FIELD.H - ballR);
    // If that spot is inside a wall (you walked the ball INTO cover), it can't stay there
    // — pop it loose off the holder so it rolls forward into the wall and bounces back.
    const walls = arenaOf(state).walls.concat(state.builtWalls || []);
    const blocked = walls.some((w) => circleHitsBox(gx, gy, ballR * 0.6, w));
    if (blocked) {
      b.owner = null; b.lastTouch = h.team; clearKick(b); b.pickupCd = RELEASE_PICKUP_CD;
      b.x = h.x; b.y = h.y; // holder centre is wall-resolved (safe), so the ball never spawns inside the wall
      b.vx = h.aimX * BALL_WALL_POP_SPEED; b.vy = h.aimY * BALL_WALL_POP_SPEED;
    } else {
      b.x = gx; b.y = gy; b.vx = 0; b.vy = 0;
    }
  } else {
    b.owner = null;
    const ballR = ballRadius(state);
    // Substep so a fast ball can't tunnel through a thin wall in one tick.
    const bSteps = Math.max(1, Math.ceil(Math.hypot(b.vx * dt, b.vy * dt) / (BUILT_WALL.thick * 0.5)));
    for (let s = 0; s < bSteps; s++) {
      b.x += b.vx * dt / bSteps;
      b.y += b.vy * dt / bSteps;
      for (const w of arenaOf(state).walls) resolveCircleBox(b, w, ballR, { bounce: WALL_BOUNCE });     // ricochet off static
      for (const w of state.builtWalls) {
        // A POWER kick (fast ball) smashes THROUGH a fragile wall — destroy it, no bounce —
        // so a hard shot beats a bush/box wall; otherwise the ball ricochets off normally.
        if (w.fragile && (b.vx * b.vx + b.vy * b.vy) > FRAGILE_PASS_SPEED * FRAGILE_PASS_SPEED) {
          if (circleHitsBox(b.x, b.y, ballR, w)) w.hp = 0;
        } else resolveCircleBox(b, w, ballR, { bounce: WALL_BOUNCE });
      }
    }
    if (state.builtWalls.some((w) => w.hp <= 0)) state.builtWalls = state.builtWalls.filter((w) => w.hp > 0); // clear smashed walls
    b.vx *= BALL_FRICTION;
    b.vy *= BALL_FRICTION;
    const bspeed = Math.hypot(b.vx, b.vy);
    if (bspeed < BALL_MIN_SPEED) { b.vx = 0; b.vy = 0; }
    if (b.pickupCd > 0) b.pickupCd -= dt;
    for (const id in state.players) {
      const p = state.players[id];
      if (Math.hypot(b.x - p.x, b.y - p.y) >= radiusOf(p, state) + ballR) continue;
      const enemyOfBall = b.lastTouch && p.team !== b.lastTouch;
      // Only a genuinely KICKED ball (b.lastKicker set) plows through / bumps an enemy.
      // A bomb-flung / stripped / wall-popped ball (clearKick -> lastKicker null) falls
      // through to the pickup below, so TOUCHING it attaches it (reliable pickup).
      if (bspeed > BALL_BUMP_SPEED && enemyOfBall && b.lastKicker) {
        // MONOTONIC penetration — harder kick = more roll-through:
        //   0 (weak/medium): BLOCKED — rebounds back off the defender
        //   1 (FULL): DRIVES THROUGH with good pace
        //   2 (OVERCHARGE): breaks through HARDEST
        // A keeper in their OWN box makes the SAVE — catches a weak/full kick dead; only an
        // OVERCHARGE kick still gets through them (reduced).
        const nx = b.vx / bspeed, ny = b.vy / bspeed;
        const tier = b.kickTier || 0;
        const mul = tier === 2 ? OVERCHARGE_MUL : tier === 1 ? FULL_BUMP_MUL : 1; // push: weak < full < overcharge
        const kb = bspeed * BALL_BUMP_SCALE * mul * knockMul(p);
        p.kvx += nx * kb; p.kvy += ny * kb;
        if (inOwnPenalty(p) && tier < 2) {
          b.vx = 0; b.vy = 0; b.pickupCd = RELEASE_PICKUP_CD;         // keeper catches it (a real save)
        } else if (tier === 2) {
          const roll = inOwnPenalty(p) ? KEEPER_BREAK_ROLL : OVERCHARGE_ROLL; // overcharge beats a keeper, reduced
          b.vx *= roll; b.vy *= roll; b.pickupCd = Math.max(b.pickupCd, RELEASE_PICKUP_CD * 0.5);
        } else if (tier === 1) {
          b.vx *= FULL_DRIVE_ROLL; b.vy *= FULL_DRIVE_ROLL;           // drives through with pace
        } else {
          b.vx *= -KICK_BLOCK_REBOUND; b.vy *= -KICK_BLOCK_REBOUND;   // weak kick rebounds off the defender
          b.pickupCd = Math.max(b.pickupCd, RELEASE_PICKUP_CD * 0.5);
        }
        b.kickTier = 0; // consumed — never re-bumps a second enemy on the same tier
        // A FULL+ kick that bumps an enemy earns overcharge (forceful connect); a weak kick
        // does not farm it, and an overcharge kick's ball can't self-refill (b.overSpent).
        if (tier >= 1 && !b.overSpent && b.lastKicker && state.players[b.lastKicker]) earnPower(state.players[b.lastKicker], OVERCHARGE_FULL_GAIN);
        // keep lastTouch as the shooter's (goal credit unchanged)
        continue; // keep checking other players
      }
      if (b.pickupCd <= 0) { b.owner = p.id; b.lastTouch = p.team; b.vx = 0; b.vy = 0; clearKick(b); break; }
    }
  }

  updateProjectiles(state, dt);
  updateBombs(state, dt);
  updateBlasts(state, dt);
  updateImpacts(state, dt);

  // Goals only count for a free (unheld) ball.
  const scored = state.ball.owner ? undefined : handleBallBounds(state);
  state.tick++;
  return scored;
}

// --- Weapons -------------------------------------------------------------

// PRIMARY attack — fire a bullet in the aim direction, scaled by charge.
function fireBullet(state, p, ch, charge, over = false) {
  p.shootCd = ch.shootCooldown;
  p.firing = true;
  const cm = chargeMul(charge);
  const off = radiusOf(p, state) + PROJECTILE.radius + 2;
  const spd = state.settings.bulletSpeed * cm;
  state.projectiles.push({
    id: state._nid++, owner: p.id, team: p.team,
    x: p.x + p.aimX * off, y: p.y + p.aimY * off,
    vx: p.aimX * spd, vy: p.aimY * spd,
    dist: 0,            // travelled distance -> proximity knockback
    charge: charge || 0, // 0..1 (a full charge ignores the point-blank rule)
    over: !!over,       // OVERCHARGE bullet — strips/pushes harder (see hitEnemy)
    cmul: cm,           // power multiplier
  });
}

// SPECIAL skill — plant a bomb (both characters).
function useSpecial(state, p, ch) {
  p.specialCd = ch.specialCooldown * (p.cdMul || 1) * (p.cardUtil || 1);
  state.bombs.push({
    id: state._nid++, owner: p.id, team: p.team,
    x: p.x, y: p.y, fuse: BOMB.fuse,
  });
}

// BUILD skill — spawn a small destructible wall in front of the player, oriented
// perpendicular to their aim (so it shields the direction they're facing). Costs
// one build charge (regenerates one every BUILD_RELOAD seconds).
function boxOverlap(ax, ay, aw, ah, bx, by, bw, bh) {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}
function boxInBush(state, x, y, w, h) {
  for (const g of arenaOf(state).bushes) if (boxOverlap(x, y, w, h, g.x, g.y, g.w, g.h)) return true;
  return false;
}
function boxInPenalty(x, y, w, h) {
  const d = PENALTY.depth;
  return boxOverlap(x, y, w, h, 0, PENALTY_TOP, d, PENALTY.width) ||
         boxOverlap(x, y, w, h, FIELD.W - d, PENALTY_TOP, d, PENALTY.width);
}
function buildWall(state, p) {
  const al = Math.hypot(p.aimX, p.aimY) || 1;
  const ax = p.aimX / al, ay = p.aimY / al;
  // The wall spans PERPENDICULAR to the aim (shields the facing direction), at ANY
  // angle — quantized to the wire's 16 steps so server & client agree exactly.
  const hl = BUILT_WALL.len / 2, ht = BUILT_WALL.thick / 2;
  let angle = Math.atan2(ay, ax) + Math.PI / 2;
  angle = Math.round(angle / WALL_ANGLE_QUANT) * WALL_ANGLE_QUANT;
  // Axis-aligned bounding box of the rotated capsule (for the wire w/h bytes, the
  // fragile-zone test, and the in-field clamp).
  const ca = Math.abs(Math.cos(angle)), sa = Math.abs(Math.sin(angle));
  const halfW = ca * hl + sa * ht, halfH = sa * hl + ca * ht;
  let cx = clamp(p.x + ax * BUILT_WALL.offset, halfW + 2, FIELD.W - halfW - 2);
  let cy = clamp(p.y + ay * BUILT_WALL.offset, halfH + 2, FIELD.H - halfH - 2);
  const w = Math.round(halfW * 2), h = Math.round(halfH * 2);
  const x = cx - w / 2, y = cy - h / 2;
  // Building inside a bush or penalty area is allowed, but the wall is FRAGILE (hp 1):
  // any bullet breaks it and a power kick smashes through (see the ball/bullet handling).
  const fragile = boxInBush(state, x, y, w, h) || boxInPenalty(x, y, w, h);
  const hp = fragile ? FRAGILE_HP : BUILT_WALL.hp;
  state.builtWalls.push({
    id: state._nid++, x, y, w, h, hp, maxHp: hp, fragile,
    cx, cy, angle, hl, ht, // capsule (thick segment) — the authoritative collision shape
    team: p.team, ttl: BUILT_WALL.ttl,
  });
  if (state.builtWalls.length > MAX_BUILT_WALLS) state.builtWalls.shift(); // drop oldest
  p.buildAmmo -= 1;
  p.buildCd = BUILD_COOLDOWN * (p.cdMul || 1) * (p.cardUtil || 1);
  p.firing = true;
}

// Chip a built wall's HP; drop it if destroyed. Returns true if a wall absorbed the hit.
function damageBuiltWallAt(state, x, y, dmg) {
  for (const w of state.builtWalls) {
    if (pointInBox(x, y, w)) { w.hp -= dmg; if (w.hp <= 0) state.builtWalls = state.builtWalls.filter((q) => q.hp > 0); return true; }
  }
  return false;
}

function updateProjectiles(state, dt) {
  const b = state.ball;
  const keep = [];
  const ballR = ballRadius(state);
  for (const pr of state.projectiles) {
    pr.x += pr.vx * dt;
    pr.y += pr.vy * dt;
    // Fly on until it leaves the field. Emit an authoritative wall impact so
    // every client sees the same collision instead of guessing from despawn.
    if (pr.x < 0 || pr.x > FIELD.W || pr.y < 0 || pr.y > FIELD.H) {
      addImpact(state, pr, 'wall', clamp(pr.x, 0, FIELD.W), clamp(pr.y, 0, FIELD.H));
      continue;
    }

    // Walls stop bullets. Static stone is immune; a built wall takes charge-scaled
    // damage — full-power = destroy (hp), mid = ~half (2 shots), tap = 1 (3 shots).
    let hitWall = false;
    for (const w of arenaOf(state).walls) { if (pointInBox(pr.x, pr.y, w)) { hitWall = true; break; } }
    const wallDmg = pr.charge >= FULL_CHARGE ? BUILT_WALL.hp : pr.charge >= QUICK_CHARGE ? BUILT_WALL.hp / 2 : 1;
    if (!hitWall && damageBuiltWallAt(state, pr.x, pr.y, wallDmg)) hitWall = true;
    if (hitWall) { addImpact(state, pr, 'wall', pr.x, pr.y); continue; }

    // A LOOSE ball is nudged by any bullet.
    if (!b.owner) {
      const bdx = b.x - pr.x, bdy = b.y - pr.y;
      if (Math.hypot(bdx, bdy) < PROJECTILE.radius + ballR) {
        const l = Math.hypot(pr.vx, pr.vy) || 1;
        b.lastTouch = pr.team; b.pickupCd = RELEASE_PICKUP_CD; clearKick(b); // bullet-pushed, not a kick
        b.vx = (pr.vx / l) * PROJECTILE.ballPush * pr.cmul;
        b.vy = (pr.vy / l) * PROJECTILE.ballPush * pr.cmul;
        addImpact(state, pr, 'ball', b.x, b.y);
        continue; // consume the bullet
      }
    } else {
      // A HELD ball: a FULL-power bullet hitting the ball head-on strips an ENEMY carrier
      // (shoves them, ball drops loose in place). An OVERCHARGE bullet shoves harder.
      const bdx = b.x - pr.x, bdy = b.y - pr.y;
      const carrier = state.players[b.owner];
      const enemyCarrier = carrier && carrier.team !== pr.team;
      if (pr.charge >= FULL_CHARGE && enemyCarrier && Math.hypot(bdx, bdy) < PROJECTILE.radius + ballR) {
        const l = Math.hypot(pr.vx, pr.vy) || 1, nx = pr.vx / l, ny = pr.vy / l;
        b.owner = null; b.pickupCd = RELEASE_PICKUP_CD; b.lastTouch = pr.team;
        b.vx = 0; b.vy = 0; clearKick(b); // ball stays in place
        const overMul = pr.over ? OVERCHARGE_BULLET_MUL : 1; // MAX strip pushes more than FULL
        const kb = state.settings.bulletKnockback * pr.charge * CARRIER_KNOCKBACK_MUL * overMul * knockMul(carrier);
        carrier.kvx += nx * kb; carrier.kvy += ny * kb;
        if (!pr.over) earnPower(state.players[pr.owner], OVERCHARGE_FULL_GAIN); // a full strip earns; an overcharge strip can't self-refill
        addImpact(state, pr, 'ball', b.x, b.y);
        continue; // consume the bullet
      }
      // Non-full bullets (or a teammate's held ball) pass through to the carrier behind.
    }

    // Hit an enemy player.
    let consumed = false;
    for (const id in state.players) {
      const t = state.players[id];
      if (t.id === pr.owner || t.team === pr.team) continue;
      const rad = radiusOf(t, state);
      if (Math.hypot(t.x - pr.x, t.y - pr.y) < PROJECTILE.radius + rad) {
        addImpact(state, pr, 'player', pr.x, pr.y, t.id);
        hitEnemy(state, t, pr);
        consumed = true;
        break;
      }
    }
    if (!consumed) keep.push(pr);
  }
  // Safety cap so bullets can never pile up unbounded.
  state.projectiles = keep.length > 50 ? keep.slice(keep.length - 50) : keep;
}

function addImpact(state, pr, type, x, y, target = null) {
  const speed = Math.hypot(pr.vx, pr.vy) || 1;
  const life = type === 'player' ? 0.34 : 0.28;
  state.impacts.push({
    id: state._nid++, type, target, x, y,
    dx: pr.vx / speed, dy: pr.vy / speed,
    team: pr.team, life, maxLife: life,
  });
  if (state.impacts.length > 30) state.impacts.splice(0, state.impacts.length - 30);
}

// A bullet hits enemy `t`. Effect depends on the shot's charge:
//   quick (< QUICK_CHARGE): NO knockback — just a brief slow (SLOW_MUL).
//   medium: knockback in the bullet's direction, scaled by charge. No detach.
//   full (>= FULL_CHARGE): full knockback AND, if `t` is carrying the ball,
//     knocks it loose with a random sideways deflection.
function hitEnemy(state, t, pr) {
  const l = Math.hypot(pr.vx, pr.vy) || 1;
  const nx = pr.vx / l, ny = pr.vy / l;
  const shooter = state.players[pr.owner];
  const overMul = pr.over ? OVERCHARGE_BULLET_MUL : 1; // OVERCHARGE bullet pushes/strips harder

  // A ball-carrier is protected: only a FULL-power shot (or a bomb, elsewhere) can
  // affect them. Both FULL and OVERCHARGE strip the ball; OVERCHARGE pushes more.
  if (state.ball.owner === t.id) {
    if (pr.charge < FULL_CHARGE) return; // medium/quick absorbed — no effect, no earn
    const kb = state.settings.bulletKnockback * pr.charge * CARRIER_KNOCKBACK_MUL * overMul * knockMul(t);
    t.kvx += nx * kb;
    t.kvy += ny * kb;
    // knock the ball loose off this carrier, with a sideways kick
    const b = state.ball;
    b.owner = null; b.pickupCd = RELEASE_PICKUP_CD; b.lastTouch = pr.team; clearKick(b); // a strip, not a kick
    const side = (Math.random() * 2 - 1) * DETACH_SIDE; // random left/right
    b.vx = nx * PROJECTILE.ballPush + (-ny) * side;
    b.vy = ny * PROJECTILE.ballPush + (nx) * side;
    if (!pr.over) earnPower(shooter, OVERCHARGE_FULL_GAIN); // a full strip earns overcharge; an overcharge strip can't self-refill
    return;
  }

  if (pr.charge < QUICK_CHARGE) {
    t.slowTimer = SLOW_TIME; // quick shot: slow, don't push, doesn't earn
    return;
  }
  // medium & full: push the enemy along the bullet's travel direction (OVERCHARGE = more)
  const kb = state.settings.bulletKnockback * pr.charge * overMul * knockMul(t);
  t.kvx += nx * kb;
  t.kvy += ny * kb;
  // A forceful body hit earns overcharge: a full hit fills it, a medium fills half.
  if (!pr.over) earnPower(shooter, pr.charge >= FULL_CHARGE ? OVERCHARGE_FULL_GAIN : OVERCHARGE_PARTIAL_GAIN);
}

function updateBombs(state, dt) {
  for (const bomb of state.bombs) bomb.fuse -= dt;
  // Bombs that blow this tick COMBINE with any live bomb nearby (chain-detonate) into
  // one bigger blast — two players bombing the same spot flings much harder.
  const detonated = new Set();
  for (const bomb of state.bombs) {
    if (bomb.fuse > 0 || detonated.has(bomb.id)) continue;
    let stack = 1;
    for (const other of state.bombs) {
      if (stack >= BOMB_STACK_MAX) break; // cap how many combine into one blast
      if (other.id === bomb.id || detonated.has(other.id)) continue;
      if (Math.hypot(other.x - bomb.x, other.y - bomb.y) <= BOMB_COMBINE_RADIUS) { stack++; detonated.add(other.id); }
    }
    detonated.add(bomb.id);
    explode(state, bomb, stack);
  }
  state.bombs = state.bombs.filter((b) => b.fuse > 0 && !detonated.has(b.id));
}

// Wall cannon: how much does a STATIC-STONE wall collinear BEHIND the bomb boosts a
// launch in (dx,dy)? Returns 1..BOMB_WALL_CANNON_MUL scaled by proximity. Only static
// stone qualifies — NOT your own built walls (else it's a build-your-own launchpad).
function wallCannonMul(state, bx, by, dx, dy) {
  let mul = 1;
  const walls = arenaOf(state).walls; // static stone only — built walls don't cannon
  for (const w of walls) {
    const np = nearestOnWall(w, bx, by);
    const vx = np.x - bx, vy = np.y - by, d = Math.hypot(vx, vy);
    if (d < 1 || d > BOMB_WALL_DIST) continue;
    if ((vx / d) * (-dx) + (vy / d) * (-dy) > BOMB_WALL_COS) {
      const m = 1 + (1 - d / BOMB_WALL_DIST) * (BOMB_WALL_CANNON_MUL - 1); // closer wall = stronger cannon
      if (m > mul) mul = m;
    }
  }
  return mul;
}

function explode(state, bomb, stack = 1) {
  const bomber = state.players[bomb.owner];
  const bomberOnCenter = bomber && Math.hypot(bomber.x - bomb.x, bomber.y - bomb.y) < BOMB_CENTER_R;
  // Stacked bombs (detonating together) make a bigger, farther-reaching blast.
  const P = state.settings.bombPower * (1 + (stack - 1) * BOMB_STACK_PER);
  const radius = BOMB.radius * (1 + (stack - 1) * BOMB_STACK_RADIUS);

  // The planter near their own bomb gets the stronger "rocket-jump" launch, but it
  // fires AWAY FROM THE BOMB (radially), like everyone else — only when standing
  // essentially ON the bomb (no radial direction to use) does it fall back to the
  // look direction. On centre you fly FURTHER (reduced if carrying the ball), and a
  // wall behind you cannons you even harder. Short window to tackle an enemy (see
  // resolveBombTackles).
  if (bomberOnCenter) {
    const rdx = bomber.x - bomb.x, rdy = bomber.y - bomb.y, rd = Math.hypot(rdx, rdy);
    let dx, dy;
    if (rd > 6) { dx = rdx / rd; dy = rdy / rd; }            // fly away from the bomb
    else { const al = Math.hypot(bomber.aimX, bomber.aimY) || 1; dx = bomber.aimX / al; dy = bomber.aimY / al; } // dead-centre: use the look dir
    let launch = P * BOMB_CENTER_LAUNCH_MUL;
    if (state.ball.owner === bomber.id) launch *= BOMB_CARRY_LAUNCH_MUL; // heavier with the ball
    launch *= wallCannonMul(state, bomb.x, bomb.y, dx, dy); // wall behind you cannons harder the closer it is
    launch = Math.min(launch, BOMB_LAUNCH_MAX); // hard cap so wall/stack combos can't fling across the pitch
    bomber.kvx += dx * launch;
    bomber.kvy += dy * launch;
    bomber.bombLaunch = BOMB_LAUNCH_TTL;
    bomber.launchGlide = BOMB_LAUNCH_GLIDE; // gentle decay → smooth launch arc
  }

  // Everyone else in the blast is flung away from the center (the BLAST direction,
  // never their aim); the closer to the center, the farther. Enemies fly a bit
  // harder, and a wall behind the blast (relative to that flee direction) cannons them.
  for (const id in state.players) {
    if (id === bomb.owner && bomberOnCenter) continue; // planter got the aim launch
    const t = state.players[id];
    const dx = t.x - bomb.x, dy = t.y - bomb.y;
    const d = Math.hypot(dx, dy) || 0.0001;
    if (d < radius) {
      const ux = dx / d, uy = dy / d;
      const enemyMul = bomber && t.team !== bomber.team ? BOMB_ENEMY_MUL : 1;
      let power = P * (1 - d / radius) * enemyMul * knockMul(t);
      power *= wallCannonMul(state, bomb.x, bomb.y, ux, uy);
      power = Math.min(power, BOMB_LAUNCH_MAX); // same cap as the self-launch — stack+wall can't screen-clear
      t.kvx += ux * power;
      t.kvy += uy * power;
      t.launchGlide = BOMB_LAUNCH_GLIDE * 0.75; // caught in the blast → smooth arc too (matches the fly anim)
      if (bomber && t.team !== bomber.team) earnPower(bomber, OVERCHARGE_FULL_GAIN); // catching an enemy in the blast is a full earn
    }
  }

  // A bomb blast destroys any built wall it reaches outright.
  for (const w of state.builtWalls) {
    const np = nearestOnWall(w, bomb.x, bomb.y);
    if (Math.hypot(bomb.x - np.x, bomb.y - np.y) < radius + np.rad) w.hp = 0;
  }
  state.builtWalls = state.builtWalls.filter((w) => w.hp > 0);

  // Ball in the blast. If the planter is rocket-jumping, LEAVE a carried ball on
  // the enemy so the flying tackle can steal it (see resolveBombTackles). Any
  // other case: knock it loose and shove it out of the blast.
  const b = state.ball;
  const bx = b.x - bomb.x, by = b.y - bomb.y;
  const bd = Math.hypot(bx, by) || 0.0001;
  if (bd < radius && !(bomberOnCenter && b.owner)) {
    const wasCarried = !!b.owner;
    if (b.owner) { b.owner = null; b.pickupCd = RELEASE_PICKUP_CD * 0.5; } // short lockout so a scramble grab is snappy
    b.lastTouch = bomb.team; clearKick(b); // bomb-flung, not a kick — clearKick nulls lastKicker so TOUCHING it attaches
    if (wasCarried) {
      // A carried ball knocked loose by a bomb pops off in a slightly RANDOM
      // direction (roughly away from the blast) and only travels a little.
      const ang = Math.atan2(by, bx) + (Math.random() - 0.5) * 2.2; // away ± ~1.1 rad
      const speed = 240 + Math.random() * 170;
      b.vx = Math.cos(ang) * speed;
      b.vy = Math.sin(ang) * speed;
    } else {
      const power = P * (1 - bd / radius) * BOMB.ballPush;
      b.vx += (bx / bd) * power;
      b.vy += (by / bd) * power;
    }
  }
  state.blasts.push({ id: state._nid++, x: bomb.x, y: bomb.y, radius, life: BOMB.blastLife, maxLife: BOMB.blastLife });
}

// A FLYING player (rocket-jumping off a bomb, OR flung fast by any blast/knockback)
// body-checks the first enemy in its path: shoves them along its travel. A deliberate
// bomb-launch tackle hits harder (BOMB_TACKLE_KB) and can STEAL the ball; a plain fast
// fling shoves proportional to its speed. The flyer loses momentum on impact.
function resolveFlyingHits(state) {
  const b = state.ball;
  for (const id in state.players) {
    const p = state.players[id];
    const speed = Math.hypot(p.kvx, p.kvy);
    const launched = p.bombLaunch > 0;
    if (!launched && speed < FLY_HIT_SPEED) continue; // only a genuinely flying body checks
    if (speed < 120) { if (launched) p.bombLaunch = 0; continue; }
    const dirx = p.kvx / speed, diry = p.kvy / speed;
    for (const oid in state.players) {
      if (oid === id) continue;
      const t = state.players[oid];
      if (t.team === p.team) continue; // only hit enemies
      const reach = radiusOf(p, state) + radiusOf(t, state) + 12;
      if (Math.hypot(t.x - p.x, t.y - p.y) < reach) {
        const kb = (launched ? BOMB_TACKLE_KB : speed * FLY_HIT_SCALE) * knockMul(t);
        t.kvx += dirx * kb; t.kvy += diry * kb;
        p.kvx *= 0.5; p.kvy *= 0.5; // the flyer loses momentum on the hit
        if (launched && b.owner === t.id) { // a bomb-launch tackle steals the ball
          b.owner = p.id; b.lastTouch = p.team; b.vx = 0; b.vy = 0; b.pickupCd = 0; clearKick(b);
        }
        if (launched) p.bombLaunch = 0; // one tackle per jump
        break;
      }
    }
  }
}

function updateBlasts(state, dt) {
  for (const bl of state.blasts) bl.life -= dt;
  state.blasts = state.blasts.filter((bl) => bl.life > 0);
}

function updateImpacts(state, dt) {
  for (const impact of state.impacts) impact.life -= dt;
  state.impacts = state.impacts.filter((impact) => impact.life > 0);
}
