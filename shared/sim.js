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
  BOMB_COMBINE_RADIUS, BOMB_STACK_PER, BOMB_STACK_RADIUS, FLY_HIT_SPEED, FLY_HIT_SCALE, BOMB_LOB_RANGE,
  CHARACTERS, DEFAULT_CHAR, PROJECTILE, BOMB, KNOCKBACK_DECAY, KNOCKBACK_MIN, BOMB_LAUNCH_DECAY, BOMB_LAUNCH_GLIDE, MOVE_ACCEL,
  QUICK_CHARGE, FULL_CHARGE, DETACH_SIDE, CARRIER_KNOCKBACK_MUL, SLOW_TIME, SLOW_MUL,
  MAG_SIZE, AMMO_REGEN, EMPTY_RELOAD,
  WALL_BOUNCE, TRAMPOLINE, BUILT_WALL, BUILD_MAG, BUILD_RELOAD, BUILD_COOLDOWN, MAX_BUILT_WALLS, FRAGILE_HP, FRAGILE_PASS_SPEED,
  BUILD_WINDUP, BUILD_WINDUP_SLOW, BUILD_INTERRUPT_KV,
  SHOOT_CHARGE_TIME, BLAST_WALL_PASS_MIN, COVER_PAD, VISION_RANGE, BUSH_REVEAL_DIST,
  defaultSettings, chargeMul, clamp,
} from './constants.js';
import { ARENA, resolveWalls, resolveCircleBox, pointInBox, circleHitsBox, nearestOnWall, segBlockedByWall } from './arena.js';

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

// --- Walkable area: the pitch PLUS the two goal-net pockets ------------------
// The pitch is [0,W]x[0,H]. Each goal adds a NET POCKET GOAL.depth deep behind its line,
// spanning the mouth (GOAL_TOP..GOAL_BOTTOM). Players (#8) and the CARRIED ball (#10) may
// move INTO a pocket THROUGH the mouth, but the net's back + sides — and the whole rest of
// the boundary — stay solid. Modelled as: project the circle centre to the nearest point in
// (pitch-rect UNION mouth-band-rect-extended-into-both-pockets). The nearest point in a
// union of two rects is the closer of the two per-rect clamps — continuous, so there is no
// teleport at the concave mouth corners that a naive per-axis clamp would produce.
function clampXYToArea(x, y, r) {
  const x1 = clamp(x, r, FIELD.W - r), y1 = clamp(y, r, FIELD.H - r);                                         // R1: the pitch
  const x2 = clamp(x, r - GOAL.depth, FIELD.W - r + GOAL.depth), y2 = clamp(y, GOAL_TOP + r, GOAL_BOTTOM - r); // R2: mouth band, into both pockets
  const d1 = (x - x1) * (x - x1) + (y - y1) * (y - y1);
  const d2 = (x - x2) * (x - x2) + (y - y2) * (y - y2);
  return d1 <= d2 ? { x: x1, y: y1 } : { x: x2, y: y2 };
}
function clampToArea(e, r) { const c = clampXYToArea(e.x, e.y, r); e.x = c.x; e.y = c.y; }
// Like clampXYToArea, but for a CARRIED ball: only the holder's ATTACKING net pocket is
// open (a dribble-in can score there). The OWN goal line stays SOLID — no own goals — as do
// all four field walls. A push into any solid edge is detected by the caller and pops the
// ball loose (rolls forward into the wall, bounces back). A attacks RIGHT, B attacks LEFT.
function clampBallCarryXY(x, y, r, team) {
  const x1 = clamp(x, r, FIELD.W - r), y1 = clamp(y, r, FIELD.H - r);                    // R1: the pitch
  const lo = team === 'B' ? r - GOAL.depth : r;                                          // open left pocket only for B
  const hi = team === 'A' ? FIELD.W - r + GOAL.depth : FIELD.W - r;                      // open right pocket only for A
  const x2 = clamp(x, lo, hi), y2 = clamp(y, GOAL_TOP + r, GOAL_BOTTOM - r);             // R2: mouth band, into the ENEMY pocket
  const d1 = (x - x1) * (x - x1) + (y - y1) * (y - y1);
  const d2 = (x - x2) * (x - x2) + (y - y2) * (y - y2);
  return d1 <= d2 ? { x: x1, y: y1 } : { x: x2, y: y2 };
}

// --- Quick-shot auto-aim targets (#6, server-authoritative) -----------------
// Nearest enemy player to `p` — the auto-aim target for a quick BULLET. null if none.
function nearestEnemy(state, p) {
  let best = null, bestD = Infinity;
  for (const id in state.players) {
    const t = state.players[id];
    if (t.team === p.team) continue;
    const d = (t.x - p.x) * (t.x - p.x) + (t.y - p.y) * (t.y - p.y);
    if (d < bestD) { bestD = d; best = t; }
  }
  return best;
}
// Auto-aim target inside the ENEMY goal for a quick SHOT (carrier): a point on the goal
// line — the open corner AWAY from the nearest defender guarding that line, else dead centre.
function enemyGoalTarget(state, p) {
  const goalX = p.team === 'A' ? FIELD.W : 0;   // A attacks right, B attacks left
  const m = ballRadius(state) + POST_R + 4;     // keep the aim point off the posts
  const mid = (GOAL_TOP + GOAL_BOTTOM) / 2;
  let keeperY = null, near = Infinity;
  for (const id in state.players) {
    const t = state.players[id];
    if (t.team === p.team) continue;
    const dx = Math.abs(t.x - goalX);
    if (dx < near) { near = dx; keeperY = t.y; }
  }
  // A defender within the penalty depth of the line is the de-facto keeper → shoot the far
  // corner; otherwise go centre.
  const ty = (keeperY != null && near < PENALTY.depth) ? (keeperY > mid ? GOAL_TOP + m : GOAL_BOTTOM - m) : mid;
  return { x: goalX, y: ty };
}

// --- Auto-aim (server-authoritative) ----------------------------------------
// The nearest point on the ENEMY goal mouth to `p` — where a CARRIER auto-aims.
function nearestGoalPoint(state, p) {
  const goalX = p.team === 'A' ? FIELD.W : 0;      // A attacks right, B attacks left
  const m = ballRadius(state) + POST_R;            // keep the target inside the posts
  return { x: goalX, y: clamp(p.y, GOAL_TOP + m, GOAL_BOTTOM - m) };
}
// Can `viewer` actually SEE enemy `t`? In range, no wall on the sight line, and not
// hidden in a bush (unless close or firing). Mirrors the fog rule + adds wall LOS.
function canSeeEnemy(state, viewer, t) {
  const dx = t.x - viewer.x, dy = t.y - viewer.y, dist2 = dx * dx + dy * dy;
  if (dist2 > VISION_RANGE * VISION_RANGE) return false;
  for (const w of arenaOf(state).walls) if (segBlockedByWall(w, viewer.x, viewer.y, t.x, t.y, 0)) return false;
  for (const w of state.builtWalls) if (segBlockedByWall(w, viewer.x, viewer.y, t.x, t.y, 0)) return false;
  const bushes = arenaOf(state).bushes || [];
  const inBush = bushes.some((g) => t.x > g.x && t.x < g.x + g.w && t.y > g.y && t.y < g.y + g.h);
  if (inBush && !t.firing && dist2 >= BUSH_REVEAL_DIST * BUSH_REVEAL_DIST) return false;
  return true;
}
// Nearest enemy `p` currently has in line of sight — the auto-aim target when NOT carrying.
function nearestVisibleEnemy(state, p) {
  let best = null, bestD = Infinity;
  for (const id in state.players) {
    const t = state.players[id];
    if (t.team === p.team) continue;
    if (!canSeeEnemy(state, p, t)) continue;
    const d = (t.x - p.x) * (t.x - p.x) + (t.y - p.y) * (t.y - p.y);
    if (d < bestD) { bestD = d; best = t; }
  }
  return best;
}

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
    buildWindup: 0, // 0..1 hold-to-confirm progress for the current wall build
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
    p.x = s.x; p.y = s.y; p.vx = 0; p.vy = 0; p.kvx = 0; p.kvy = 0; p.power = false; p.powerT = 0; p.powerMeter = 0; p.launchGlide = 0; p.buildWindup = 0;
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
  // Keep everyone inside the walkable area (pitch + goal-net pockets) after separation.
  for (const p of arr) clampToArea(p, radiusOf(p, state));
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
    // A goal counts ONLY for the ATTACKING team (no own goals): B scores in the LEFT net,
    // A in the RIGHT net. For anyone else the goal line is a SOLID WALL — the ball bounces
    // off it AT the line and never enters, so an own-goal shot is impossible.
    if (b.vx < 0 && b.x < R) {                       // approaching / crossing the left line
      if (b.lastTouch === 'B') { if (b.x < 0) return goal(state, 'B'); }      // B attacks left — may cross & score
      else { b.x = R; b.vx = Math.abs(b.vx) * WALL_RESTITUTION; return; }     // A / neutral — solid wall at the line
    }
    if (b.vx > 0 && b.x > FIELD.W - R) {             // approaching / crossing the right line
      if (b.lastTouch === 'A') { if (b.x > FIELD.W) return goal(state, 'A'); } // A attacks right — may cross & score
      else { b.x = FIELD.W - R; b.vx = -Math.abs(b.vx) * WALL_RESTITUTION; return; }
    }
    return; // inside the mouth, not yet at a line — let it fly
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
    if (inp.buildHold && p.buildAmmo >= 1 && p.buildCd <= 0) spd *= BUILD_WINDUP_SLOW; // slowed while winding up a wall
    if (p.bombLaunch > 0) p.bombLaunch -= dt; // rocket-jump tackle window
    const tvx = mx * spd, tvy = my * spd;
    p.vx += (tvx - p.vx) * MOVE_ACCEL;
    p.vy += (tvy - p.vy) * MOVE_ACCEL;
    // Position = movement + decaying knockback. Substep the move + wall-resolve so a
    // fast (knockback) player can't tunnel through a thin wall in a single tick.
    const rad = radiusOf(p, state);
    const pSteps = Math.max(1, Math.ceil(Math.hypot((p.vx + p.kvx) * dt, (p.vy + p.kvy) * dt) / (BUILT_WALL.thick * 0.5)));
    for (let s = 0; s < pSteps; s++) {
      p.x += (p.vx + p.kvx) * dt / pSteps;
      p.y += (p.vy + p.kvy) * dt / pSteps;
      clampToArea(p, rad); // pitch + goal-net pockets (#8): the mouth is a legal opening; the rest of the boundary is solid
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
    p._sax = inp.sax || 0; p._say = inp.say || 0; // special-aim offset, consumed by useSpecial below
    p._build = !!inp.build;
    // Wall-build windup: ramp while buildHold is held and a charge is available; a real
    // hit (knockback above BUILD_INTERRUPT_KV) cancels it; releasing without a commit
    // (no build edge, windup not full) resets it. Charge is spent only at commit.
    if (Math.hypot(p.kvx, p.kvy) > BUILD_INTERRUPT_KV) p.buildWindup = 0;
    else if (inp.buildHold && p.buildAmmo >= 1 && p.buildCd <= 0) {
      p.buildWindup = Math.min(1, p.buildWindup + dt / BUILD_WINDUP);
    } else if (!p._build) {
      p.buildWindup = 0;
    }
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
        // #11 SNOOKER STRIKE + #6 AUTO-AIM: pick a target, then strike the ball cleanly ALONG
        // the vector from the BALL's centre to it — no offset/tangential skew, so the ball's
        // velocity direction == the intended aim exactly. A QUICK shot (anything short of a full
        // aimed charge) auto-aims at the nearest point on the enemy goal; a FULL aimed shot
        // honours the player's aim.
        let dx = p.aimX, dy = p.aimY;
        if (!isFull) {
          const tgt = nearestGoalPoint(state, p);
          dx = tgt.x - b.x; dy = tgt.y - b.y;
          const dl = Math.hypot(dx, dy) || 1; dx /= dl; dy /= dl;
        }
        b.owner = null;
        b.lastTouch = p.team;
        b.lastKicker = p.id; // who launched it — refills power if this kick bumps an enemy
        b.kickTier = isOver ? 2 : isFull ? 1 : 0; // how it behaves hitting an enemy (see the bump handler)
        b.overSpent = isOver; // an overcharge kick's ball can't re-farm the meter (any later bump)
        b.vx = dx * state.settings.shotPower * cm;
        b.vy = dy * state.settings.shotPower * cm;
        b.pickupCd = RELEASE_PICKUP_CD;
        p.firing = true;
        if (isOver) { p.power = false; p.powerT = 0; p.powerMeter = 0; } // an OVERCHARGE kick spends the meter
      } else if (p.shootCd <= 0 && p.reloadLock <= 0 && p.ammo >= 1) {
        // A FULL bullet strips a carrier; an OVERCHARGE bullet (isOver) strips AND pushes
        // harder — and spends the meter, same as an overcharge kick.
        // #6: a QUICK bullet (not a full aimed shot) auto-aims at the nearest enemy IN LINE OF
        // SIGHT (no wall / bush between); if none is visible it honours the manual aim.
        let ax = p.aimX, ay = p.aimY;
        if (!isFull) {
          const foe = nearestVisibleEnemy(state, p);
          if (foe) { const ex = foe.x - p.x, ey = foe.y - p.y, el = Math.hypot(ex, ey) || 1; ax = ex / el; ay = ey / el; }
        }
        fireBullet(state, p, ch, eff, isOver, ax, ay);
        p.ammo -= 1;
        if (p.ammo <= 0) { p.ammo = 0; p.reloadLock = EMPTY_RELOAD; p.ammoT = 0; }
        if (isOver) { p.power = false; p.powerT = 0; p.powerMeter = 0; }
      }
      p._charge = 0; // consume the wind-up on release
    }
    if (p._special && p.specialCd <= 0) useSpecial(state, p, ch, p._sax || 0, p._say || 0);
    if (p._build && p.buildCd <= 0 && p.buildAmmo >= 1 && p.buildWindup >= 1) { buildWall(state, p); p.buildWindup = 0; }
  }

  // --- Ball: glued to a holder, or free physics + pickup ---
  let walkInScored; // #9: set to the scoring team if a carrier dribbles the ball into the net this tick
  if (b.owner && state.players[b.owner]) {
    const h = state.players[b.owner];
    const ballR = ballRadius(state);
    const off = radiusOf(h, state) + ballR;
    // Desired glue spot (in front of the holder, UNCLAMPED) and where it can legally sit:
    // the pitch + the holder's ATTACKING pocket only. The own goal line + all field walls
    // are SOLID (#10), so the desired spot gets pulled back off any of them.
    const dx = h.x + h.aimX * off, dy = h.y + h.aimY * off;
    const glued = clampBallCarryXY(dx, dy, ballR, h.team);
    const gx = glued.x, gy = glued.y;
    const inMouthY = gy > GOAL_TOP && gy < GOAL_BOTTOM;
    // #9 DRIBBLE-IN GOAL: the carrier walked the ball across the ENEMY line into the net.
    // clampBallCarryXY only opens the attacking pocket, so this can never be an own goal. The
    // ball stays owned (frozen in the net through the hold); handleBallBounds is skipped.
    if (inMouthY && gx > FIELD.W && h.team === 'A') { b.x = gx; b.y = gy; b.vx = 0; b.vy = 0; walkInScored = goal(state, 'A'); }
    else if (inMouthY && gx < 0 && h.team === 'B') { b.x = gx; b.y = gy; b.vx = 0; b.vy = 0; walkInScored = goal(state, 'B'); }
    else {
      // Pop the ball LOOSE when the holder walks it into a solid edge — a built/static wall,
      // the OWN goal line, or a field wall — so it rolls forward into the wall and bounces
      // back (like a wall) instead of sticking. Entering the enemy mouth is NOT solid.
      const walls = arenaOf(state).walls.concat(state.builtWalls || []);
      const blockedByWall = walls.some((w) => circleHitsBox(gx, gy, ballR * 0.6, w));
      const towardEnemyMouth = inMouthY && ((h.team === 'A' && dx > FIELD.W - ballR) || (h.team === 'B' && dx < ballR));
      const pushedIntoWall = !towardEnemyMouth && Math.hypot(gx - dx, gy - dy) > ballR * 0.4; // clamp pulled it off a solid edge
      if (blockedByWall || pushedIntoWall) {
        b.owner = null; b.lastTouch = h.team; clearKick(b); b.pickupCd = RELEASE_PICKUP_CD;
        b.x = h.x; b.y = h.y; // holder centre is inside the legal area (safe)
        b.vx = h.aimX * BALL_WALL_POP_SPEED; b.vy = h.aimY * BALL_WALL_POP_SPEED;
      } else {
        b.x = gx; b.y = gy; b.vx = 0; b.vy = 0;
      }
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

  // Goals: a dribble-in by a carrier (#9, detected above while the ball is still owned), OR a
  // free (unheld) ball crossing the line (handleBallBounds). Owned ball => handleBallBounds skipped.
  const scored = walkInScored || (state.ball.owner ? undefined : handleBallBounds(state));
  state.tick++;
  return scored;
}

// --- Weapons -------------------------------------------------------------

// PRIMARY attack — fire a bullet along `aimX,aimY` (defaults to the player's aim; a quick
// shot passes an auto-aim direction toward the nearest enemy, see #6), scaled by charge.
function fireBullet(state, p, ch, charge, over = false, aimX = p.aimX, aimY = p.aimY) {
  p.shootCd = ch.shootCooldown;
  p.firing = true;
  const cm = chargeMul(charge);
  const off = radiusOf(p, state) + PROJECTILE.radius + 2;
  const spd = state.settings.bulletSpeed * cm;
  state.projectiles.push({
    id: state._nid++, owner: p.id, team: p.team,
    x: p.x + aimX * off, y: p.y + aimY * off,
    vx: aimX * spd, vy: aimY * spd,
    dist: 0,            // travelled distance -> proximity knockback
    charge: charge || 0, // 0..1 (a full charge ignores the point-blank rule)
    over: !!over,       // OVERCHARGE bullet — strips/pushes harder (see hitEnemy)
    cmul: cm,           // power multiplier
  });
}

// SPECIAL skill — plant a bomb. A tap (zero aim offset) plants at the planter's feet
// (rocket-jump). A drag aims a short LOB up to BOMB_LOB_RANGE along the DRAG direction —
// (sax,say) is the drag vector itself (not the player's aim/movement), capped to unit
// length here. This must match the client's ghost marker, which is drawn along the same
// (sax,say) drag vector — using p.aimX/p.aimY here would desync the lob from the ghost
// whenever the player's aim differs from their drag direction.
function useSpecial(state, p, ch, sax = 0, say = 0) {
  p.specialCd = ch.specialCooldown * (p.cdMul || 1) * (p.cardUtil || 1);
  const mag = Math.hypot(sax, say);
  let bx, by;
  if (mag <= 0) {
    bx = p.x; by = p.y; // tap -> feet plant (rocket-jump)
  } else {
    const k = Math.min(1, mag) / mag; // cap the drag vector to unit length
    bx = clamp(p.x + sax * k * BOMB_LOB_RANGE, 0, FIELD.W);
    by = clamp(p.y + say * k * BOMB_LOB_RANGE, 0, FIELD.H);
  }
  state.bombs.push({
    id: state._nid++, owner: p.id, team: p.team,
    x: bx, y: by, fuse: BOMB.fuse,
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
// First built wall containing (x,y) that this bullet hasn't already pierced.
function builtWallAt(state, x, y, pierced) {
  for (const w of state.builtWalls) {
    if (pierced && pierced.has(w.id)) continue;
    if (pointInBox(x, y, w)) return w;
  }
  return null;
}
// A shot's power TIER: 0 quick, 1 half/medium, 2 full, 3 super (overcharge).
function shotTier(pr) { return pr.over ? 3 : pr.charge >= FULL_CHARGE ? 2 : pr.charge >= QUICK_CHARGE ? 1 : 0; }
// Rewrite a bullet to the given (lower) tier after a wall chips its power.
function applyShotTier(pr, tier) {
  if (tier >= 3) { pr.over = true; pr.charge = Math.max(pr.charge, 1); }
  else if (tier === 2) { pr.over = false; pr.charge = FULL_CHARGE; }
  else if (tier === 1) { pr.over = false; pr.charge = QUICK_CHARGE; }
  else { pr.over = false; pr.charge = 0; }
  pr.cmul = chargeMul(pr.charge);
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

    // Static stone fully blocks any shot (indestructible cover).
    let blockedStatic = false;
    for (const w of arenaOf(state).walls) { if (pointInBox(pr.x, pr.y, w)) { blockedStatic = true; break; } }
    if (blockedStatic) { addImpact(state, pr, 'wall', pr.x, pr.y); continue; }
    // A BUILT wall CHIPS the shot as it passes through: it absorbs ~one shot tier per
    // remaining HP. A strong (full-HP) wall stops a super shot; a weakened wall lets a
    // downgraded shot (super -> full -> half) reach whoever is behind it. Either way the
    // wall takes the usual charge-scaled damage (full = destroy, mid = half, tap = 1).
    const bw = builtWallAt(state, pr.x, pr.y, pr.pierced);
    if (bw) {
      (pr.pierced || (pr.pierced = new Set())).add(bw.id);
      const absorb = Math.round(bw.hp); // remaining HP tiers this wall soaks up
      const wallDmg = pr.charge >= FULL_CHARGE ? BUILT_WALL.hp : pr.charge >= QUICK_CHARGE ? BUILT_WALL.hp / 2 : 1;
      bw.hp -= wallDmg;
      if (bw.hp <= 0) state.builtWalls = state.builtWalls.filter((q) => q.hp > 0);
      addImpact(state, pr, 'wall', pr.x, pr.y);
      const passed = shotTier(pr) - absorb;
      if (passed < 1) continue;      // fully absorbed — the bullet dies at the wall
      applyShotTier(pr, passed);     // downgrade the bullet; it flies on to the target behind
    }

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
      // COVER: a STATIC wall between the blast and this player blocks the push entirely;
      // a BUILT wall softens it by its remaining HP (strong wall = minor push, weak =
      // most of the push). Behind an indestructible wall you feel nothing.
      if (arenaOf(state).walls.some((w) => segBlockedByWall(w, bomb.x, bomb.y, t.x, t.y, COVER_PAD))) continue;
      let coverPass = 1;
      for (const w of state.builtWalls) {
        if (segBlockedByWall(w, bomb.x, bomb.y, t.x, t.y, COVER_PAD)) {
          const pass = BLAST_WALL_PASS_MIN + (1 - BLAST_WALL_PASS_MIN) * (1 - w.hp / w.maxHp);
          if (pass < coverPass) coverPass = pass; // the strongest blocker wins
        }
      }
      const ux = dx / d, uy = dy / d;
      const enemyMul = bomber && t.team !== bomber.team ? BOMB_ENEMY_MUL : 1;
      let power = P * (1 - d / radius) * enemyMul * knockMul(t) * coverPass;
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
