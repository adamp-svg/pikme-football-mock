// Authoritative football simulation. Pure logic, no rendering, no networking.
// Runs on the SERVER as the source of truth, and on the CLIENT for local
// prediction of the player's own movement. Same rules everywhere = no desync.

import {
  FIELD, GOAL, POST_R, BALL_RADIUS, BALL_FRICTION, BALL_MIN_SPEED, WALL_RESTITUTION,
  RELEASE_PICKUP_CD, MATCH_DURATION, KICKOFF_FREEZE, GOAL_RESET, GOAL_FREEZE_HOLD,
  PENALTY, PENALTY_KNOCKBACK_MUL, BALL_BUMP_SPEED, BALL_BUMP_SCALE,
  BOMB_CENTER_R, BOMB_ENEMY_MUL, BOMB_LAUNCH_TTL, BOMB_TACKLE_KB,
  CHARACTERS, DEFAULT_CHAR, PROJECTILE, BOMB, KNOCKBACK_DECAY, KNOCKBACK_MIN, MOVE_ACCEL,
  QUICK_CHARGE, FULL_CHARGE, DETACH_SIDE, CARRIER_KNOCKBACK_MUL, SLOW_TIME, SLOW_MUL,
  MAG_SIZE, AMMO_REGEN, EMPTY_RELOAD,
  WALL_BOUNCE, TRAMPOLINE, BUILT_WALL, BUILD_MAG, BUILD_RELOAD, BUILD_COOLDOWN, MAX_BUILT_WALLS,
  defaultSettings, chargeMul, clamp,
} from './constants.js';
import { ARENA, resolveWalls, resolveCircleBox, pointInBox } from './arena.js';

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
    ball: { x: FIELD.W / 2, y: FIELD.H / 2, vx: 0, vy: 0, owner: null, pickupCd: 0, lastTouch: null },
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
  state.ball.vx = 0; state.ball.vy = 0;
}

export function addPlayer(state, id, { name, char, team, slot, isBot }) {
  const c = CHARACTERS[char] ? char : DEFAULT_CHAR;
  const p = {
    id, name, char: c, team, slot, isBot: !!isBot,
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
    trampCd: 0, // >0 => recently launched by a trampoline (no re-launch)
    buildAmmo: BUILD_MAG, // wall charges available
    buildAmmoT: 0,        // seconds accumulated toward the next wall charge
    buildCd: 0,           // min pacing between wall placements
    firing: false, // fired/released this tick (flash)
    lastSeq: 0, // last input seq applied (for client reconciliation)
    _shoot: false, _special: false, _build: false, _charge: 0,
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
    p.x = s.x; p.y = s.y; p.vx = 0; p.vy = 0; p.kvx = 0; p.kvy = 0;
    p.aimX = p.team === 'A' ? 1 : -1; p.aimY = 0;
  }
  state.ball = { x: FIELD.W / 2, y: FIELD.H / 2, vx: 0, vy: 0, owner: null, pickupCd: 0, lastTouch: null };
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
  if (state.phase === 'playing' && state.elapsed >= MATCH_DURATION) {
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
    let spd = ch.speed * state.settings.speedMul;
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
      resolveWalls(p, rad, state.builtWalls); // slide along static + built walls each substep
    }
    p.kvx *= KNOCKBACK_DECAY; p.kvy *= KNOCKBACK_DECAY;
    if (Math.hypot(p.kvx, p.kvy) < KNOCKBACK_MIN) { p.kvx = 0; p.kvy = 0; }
    // Trampolines fling you the way you're moving (or aim, if standing still).
    p.trampCd = Math.max(0, p.trampCd - dt);
    if (p.trampCd <= 0) {
      for (const t of ARENA.trampolines) {
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
      if (p.buildAmmoT >= BUILD_RELOAD) { p.buildAmmo = Math.min(BUILD_MAG, p.buildAmmo + 1); p.buildAmmoT -= BUILD_RELOAD; }
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
    p._shoot = !!inp.shoot;
    p._special = !!inp.special;
    p._build = !!inp.build;
    p._charge = inp.charge != null ? inp.charge : 0; // 0..1 hold power
    p.lastSeq = inp.seq != null ? inp.seq : p.lastSeq;
  }

  resolveBombTackles(state); // flying planter plows into / steals from an enemy
  separatePlayers(state);
  // Separation can nudge a body into a wall — push everyone back out once more.
  for (const id in state.players) { const p = state.players[id]; resolveWalls(p, radiusOf(p, state), state.builtWalls); }

  // --- Per-player actions ---
  //   Holding the ball + SHOOT  -> release it in the aim direction (shot/pass)
  //   Not holding      + SHOOT  -> fire a bullet
  //   SPECIAL                   -> plant a bomb
  const b = state.ball;
  for (const id in state.players) {
    const p = state.players[id];
    const ch = CHARACTERS[p.char];
    if (p._shoot) {
      if (b.owner === p.id) {
        const cm = chargeMul(p._charge); // charged shot = further/faster
        b.owner = null;
        b.lastTouch = p.team;
        b.vx = p.aimX * state.settings.shotPower * cm;
        b.vy = p.aimY * state.settings.shotPower * cm;
        b.pickupCd = RELEASE_PICKUP_CD;
        p.firing = true;
      } else if (p.shootCd <= 0 && p.reloadLock <= 0 && p.ammo >= 1) {
        fireBullet(state, p, ch, p._charge);
        p.ammo -= 1;
        if (p.ammo <= 0) { p.ammo = 0; p.reloadLock = EMPTY_RELOAD; p.ammoT = 0; }
      }
    }
    if (p._special && p.specialCd <= 0) useSpecial(state, p, ch);
    if (p._build && p.buildCd <= 0 && p.buildAmmo >= 1) buildWall(state, p);
  }

  // --- Ball: glued to a holder, or free physics + pickup ---
  if (b.owner && state.players[b.owner]) {
    const h = state.players[b.owner];
    const off = radiusOf(h, state) + ballRadius(state);
    b.x = h.x + h.aimX * off;
    b.y = h.y + h.aimY * off;
    b.vx = 0; b.vy = 0;
  } else {
    b.owner = null;
    const ballR = ballRadius(state);
    // Substep so a fast ball can't tunnel through a thin wall in one tick.
    const bSteps = Math.max(1, Math.ceil(Math.hypot(b.vx * dt, b.vy * dt) / (BUILT_WALL.thick * 0.5)));
    for (let s = 0; s < bSteps; s++) {
      b.x += b.vx * dt / bSteps;
      b.y += b.vy * dt / bSteps;
      for (const w of ARENA.walls) resolveCircleBox(b, w, ballR, { bounce: WALL_BOUNCE });     // ricochet off static
      for (const w of state.builtWalls) resolveCircleBox(b, w, ballR, { bounce: WALL_BOUNCE }); // and built walls
    }
    b.vx *= BALL_FRICTION;
    b.vy *= BALL_FRICTION;
    const bspeed = Math.hypot(b.vx, b.vy);
    if (bspeed < BALL_MIN_SPEED) { b.vx = 0; b.vy = 0; }
    if (b.pickupCd > 0) b.pickupCd -= dt;
    for (const id in state.players) {
      const p = state.players[id];
      if (Math.hypot(b.x - p.x, b.y - p.y) >= radiusOf(p, state) + ballR) continue;
      const enemyOfBall = b.lastTouch && p.team !== b.lastTouch;
      if (bspeed > BALL_BUMP_SPEED && enemyOfBall) {
        // A fast ball shoves the opponent it runs into, then only trickles a bit
        // further forward (it loses most of its pace on the hit).
        const nx = b.vx / bspeed, ny = b.vy / bspeed;
        const kb = bspeed * BALL_BUMP_SCALE * knockMul(p);
        p.kvx += nx * kb; p.kvy += ny * kb;
        b.vx *= 0.35; b.vy *= 0.35; // comes forward only a bit after the hit
        // keep lastTouch as the shooter's (goal credit unchanged)
        continue; // keep checking other players
      }
      if (b.pickupCd <= 0) { b.owner = p.id; b.lastTouch = p.team; b.vx = 0; b.vy = 0; break; }
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
function fireBullet(state, p, ch, charge) {
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
    cmul: cm,           // power multiplier
  });
}

// SPECIAL skill — plant a bomb (both characters).
function useSpecial(state, p, ch) {
  p.specialCd = ch.specialCooldown;
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
function boxInBush(x, y, w, h) {
  for (const g of ARENA.bushes) if (boxOverlap(x, y, w, h, g.x, g.y, g.w, g.h)) return true;
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
  const horizAim = Math.abs(ax) >= Math.abs(ay);
  const w = horizAim ? BUILT_WALL.thick : BUILT_WALL.len;
  const h = horizAim ? BUILT_WALL.len : BUILT_WALL.thick;
  let cx = p.x + ax * BUILT_WALL.offset;
  let cy = p.y + ay * BUILT_WALL.offset;
  let x = clamp(cx - w / 2, 2, FIELD.W - w - 2);
  let y = clamp(cy - h / 2, 2, FIELD.H - h - 2);
  // No building inside a bush or a penalty area — reject without spending a charge.
  if (boxInBush(x, y, w, h) || boxInPenalty(x, y, w, h)) return;
  state.builtWalls.push({
    id: state._nid++, x, y, w, h, hp: BUILT_WALL.hp, maxHp: BUILT_WALL.hp,
    team: p.team, ttl: BUILT_WALL.ttl,
  });
  if (state.builtWalls.length > MAX_BUILT_WALLS) state.builtWalls.shift(); // drop oldest
  p.buildAmmo -= 1;
  p.buildCd = BUILD_COOLDOWN;
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
    for (const w of ARENA.walls) { if (pointInBox(pr.x, pr.y, w)) { hitWall = true; break; } }
    const wallDmg = pr.charge >= FULL_CHARGE ? BUILT_WALL.hp : pr.charge >= QUICK_CHARGE ? BUILT_WALL.hp / 2 : 1;
    if (!hitWall && damageBuiltWallAt(state, pr.x, pr.y, wallDmg)) hitWall = true;
    if (hitWall) { addImpact(state, pr, 'wall', pr.x, pr.y); continue; }

    // A LOOSE ball is nudged by any bullet.
    if (!b.owner) {
      const bdx = b.x - pr.x, bdy = b.y - pr.y;
      if (Math.hypot(bdx, bdy) < PROJECTILE.radius + ballR) {
        const l = Math.hypot(pr.vx, pr.vy) || 1;
        b.lastTouch = pr.team; b.pickupCd = RELEASE_PICKUP_CD;
        b.vx = (pr.vx / l) * PROJECTILE.ballPush * pr.cmul;
        b.vy = (pr.vy / l) * PROJECTILE.ballPush * pr.cmul;
        addImpact(state, pr, 'ball', b.x, b.y);
        continue; // consume the bullet
      }
    } else {
      // A HELD ball: only a FULL-power bullet hitting the ball head-on affects it
      // — it shoves the CARRIER back, and the ball drops loose where it was (it
      // does NOT fly forward).
      const bdx = b.x - pr.x, bdy = b.y - pr.y;
      if (pr.charge >= FULL_CHARGE && Math.hypot(bdx, bdy) < PROJECTILE.radius + ballR) {
        const l = Math.hypot(pr.vx, pr.vy) || 1, nx = pr.vx / l, ny = pr.vy / l;
        const carrier = state.players[b.owner];
        b.owner = null; b.pickupCd = RELEASE_PICKUP_CD; b.lastTouch = pr.team;
        b.vx = 0; b.vy = 0; // ball stays in place
        if (carrier) {
          const kb = state.settings.bulletKnockback * pr.charge * CARRIER_KNOCKBACK_MUL * knockMul(carrier);
          carrier.kvx += nx * kb; carrier.kvy += ny * kb;
        }
        addImpact(state, pr, 'ball', b.x, b.y);
        continue; // consume the bullet
      }
      // Non-full bullets pass through the held ball (transparent) to the carrier.
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

  // A ball-carrier is protected: only a FULL-power shot (or a bomb, elsewhere)
  // can affect them. Medium/quick bullets are absorbed with no effect.
  if (state.ball.owner === t.id) {
    if (pr.charge < FULL_CHARGE) return;
    const kb = state.settings.bulletKnockback * pr.charge * CARRIER_KNOCKBACK_MUL * knockMul(t);
    t.kvx += nx * kb;
    t.kvy += ny * kb;
    // knock the ball loose off this carrier, with a sideways kick
    const b = state.ball;
    b.owner = null; b.pickupCd = RELEASE_PICKUP_CD; b.lastTouch = pr.team;
    const side = (Math.random() * 2 - 1) * DETACH_SIDE; // random left/right
    b.vx = nx * PROJECTILE.ballPush + (-ny) * side;
    b.vy = ny * PROJECTILE.ballPush + (nx) * side;
    return;
  }

  if (pr.charge < QUICK_CHARGE) {
    t.slowTimer = SLOW_TIME; // quick shot: slow, don't push
    return;
  }
  // medium & full: push the enemy along the bullet's travel direction
  const kb = state.settings.bulletKnockback * pr.charge * knockMul(t);
  t.kvx += nx * kb;
  t.kvy += ny * kb;
}

function updateBombs(state, dt) {
  const keep = [];
  for (const bomb of state.bombs) {
    bomb.fuse -= dt;
    if (bomb.fuse > 0) { keep.push(bomb); continue; }
    explode(state, bomb);
  }
  state.bombs = keep;
}

function explode(state, bomb) {
  const bomber = state.players[bomb.owner];
  const bomberOnCenter = bomber && Math.hypot(bomber.x - bomb.x, bomber.y - bomb.y) < BOMB_CENTER_R;
  const P = state.settings.bombPower;

  // The planter, if standing on their own bomb, is LAUNCHED in the direction they
  // are facing (a "rocket jump", ~full-shot strength) rather than flung away — and
  // for a short window can tackle an enemy in their path (see resolveBombTackles).
  if (bomberOnCenter) {
    const al = Math.hypot(bomber.aimX, bomber.aimY) || 1;
    bomber.kvx += (bomber.aimX / al) * P;
    bomber.kvy += (bomber.aimY / al) * P;
    bomber.bombLaunch = BOMB_LAUNCH_TTL;
  }

  // Everyone else in the blast is flung away from the center; the closer to the
  // center, the farther. Enemies of the bomber fly a bit harder.
  for (const id in state.players) {
    if (id === bomb.owner && bomberOnCenter) continue; // planter got the aim launch
    const t = state.players[id];
    const dx = t.x - bomb.x, dy = t.y - bomb.y;
    const d = Math.hypot(dx, dy) || 0.0001;
    if (d < BOMB.radius) {
      const enemyMul = bomber && t.team !== bomber.team ? BOMB_ENEMY_MUL : 1;
      const power = P * (1 - d / BOMB.radius) * enemyMul * knockMul(t);
      t.kvx += (dx / d) * power;
      t.kvy += (dy / d) * power;
    }
  }

  // A bomb blast destroys any built wall it reaches outright.
  for (const w of state.builtWalls) {
    const nx = clamp(bomb.x, w.x, w.x + w.w), ny = clamp(bomb.y, w.y, w.y + w.h);
    if (Math.hypot(bomb.x - nx, bomb.y - ny) < BOMB.radius) w.hp = 0;
  }
  state.builtWalls = state.builtWalls.filter((w) => w.hp > 0);

  // Ball in the blast. If the planter is rocket-jumping, LEAVE a carried ball on
  // the enemy so the flying tackle can steal it (see resolveBombTackles). Any
  // other case: knock it loose and shove it out of the blast.
  const b = state.ball;
  const bx = b.x - bomb.x, by = b.y - bomb.y;
  const bd = Math.hypot(bx, by) || 0.0001;
  if (bd < BOMB.radius && !(bomberOnCenter && b.owner)) {
    const wasCarried = !!b.owner;
    if (b.owner) { b.owner = null; b.pickupCd = RELEASE_PICKUP_CD; }
    b.lastTouch = bomb.team;
    if (wasCarried) {
      // A carried ball knocked loose by a bomb pops off in a slightly RANDOM
      // direction (roughly away from the blast) and only travels a little.
      const ang = Math.atan2(by, bx) + (Math.random() - 0.5) * 2.2; // away ± ~1.1 rad
      const speed = 240 + Math.random() * 170;
      b.vx = Math.cos(ang) * speed;
      b.vy = Math.sin(ang) * speed;
    } else {
      const power = P * (1 - bd / BOMB.radius) * BOMB.ballPush;
      b.vx += (bx / bd) * power;
      b.vy += (by / bd) * power;
    }
  }
  state.blasts.push({ id: state._nid++, x: bomb.x, y: bomb.y, radius: BOMB.radius, life: BOMB.blastLife, maxLife: BOMB.blastLife });
}

// A planter rocket-jumping off their own bomb plows into the first enemy in their
// path: shoves them back, and if that enemy had the ball, steals it.
function resolveBombTackles(state) {
  const b = state.ball;
  for (const id in state.players) {
    const p = state.players[id];
    if (!p.bombLaunch || p.bombLaunch <= 0) continue;
    const speed = Math.hypot(p.kvx, p.kvy);
    if (speed < 200) { p.bombLaunch = 0; continue; } // launch spent
    const dirx = p.kvx / speed, diry = p.kvy / speed;
    for (const oid in state.players) {
      if (oid === id) continue;
      const t = state.players[oid];
      if (t.team === p.team) continue; // only tackle enemies
      const reach = radiusOf(p, state) + radiusOf(t, state) + 16;
      if (Math.hypot(t.x - p.x, t.y - p.y) < reach) {
        t.kvx += dirx * BOMB_TACKLE_KB * knockMul(t);
        t.kvy += diry * BOMB_TACKLE_KB * knockMul(t);
        if (b.owner === t.id) { // steal the ball onto the flying planter
          b.owner = p.id; b.lastTouch = p.team; b.vx = 0; b.vy = 0; b.pickupCd = 0;
        }
        p.bombLaunch = 0; // one tackle per jump
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
