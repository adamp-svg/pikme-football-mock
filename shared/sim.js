// Authoritative football simulation. Pure logic, no rendering, no networking.
// Runs on the SERVER as the source of truth, and on the CLIENT for local
// prediction of the player's own movement. Same rules everywhere = no desync.

import {
  FIELD, GOAL, POST_R, BALL_RADIUS, BALL_FRICTION, BALL_MIN_SPEED, WALL_RESTITUTION,
  RELEASE_PICKUP_CD, MATCH_DURATION, KICKOFF_FREEZE,
  CHARACTERS, DEFAULT_CHAR, PROJECTILE, BOMB, KNOCKBACK_DECAY, KNOCKBACK_MIN, MOVE_ACCEL,
  QUICK_CHARGE, FULL_CHARGE, DETACH_SIDE, CARRIER_KNOCKBACK_MUL, SLOW_TIME, SLOW_MUL,
  defaultSettings, chargeMul, clamp,
} from './constants.js';

const GOAL_TOP = (FIELD.H - GOAL.width) / 2;
const GOAL_BOTTOM = (FIELD.H + GOAL.width) / 2;

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
    blasts: [], // short-lived explosion visuals
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
    shootCd: 0, // bullet cooldown
    specialCd: 0, // bomb cooldown
    slowTimer: 0, // seconds of quick-shot slow remaining
    firing: false, // fired/released this tick (flash)
    lastSeq: 0, // last input seq applied (for client reconciliation)
    _shoot: false, _special: false,
  };
  state.players[id] = p;
  return p;
}

export function removePlayer(state, id) {
  delete state.players[id];
}

// Reset to kickoff. `ballTeam` (if given) starts with the ball attached.
function resetPositions(state, ballTeam) {
  for (const id in state.players) {
    const p = state.players[id];
    const s = spawnPos(p.team, p.slot);
    p.x = s.x; p.y = s.y; p.vx = 0; p.vy = 0; p.kvx = 0; p.kvy = 0;
    p.aimX = p.team === 'A' ? 1 : -1; p.aimY = 0;
  }
  state.ball = { x: FIELD.W / 2, y: FIELD.H / 2, vx: 0, vy: 0, owner: null, pickupCd: 0, lastTouch: null };
  state.projectiles = [];
  state.bombs = [];
  if (ballTeam) attachBall(state, ballTeam);
  state.resetTimer = KICKOFF_FREEZE;
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
  // The team that CONCEDED restarts with the ball.
  const conceding = team === 'A' ? 'B' : 'A';
  resetPositions(state, conceding);
  return team;
}

// One authoritative step. `inputs` is a map: playerId -> input.
// input = { seq, moveX, moveY, aimX, aimY, kick }
export function step(state, inputs, dt) {
  // Endless match — just tally elapsed time; it never ends.
  state.elapsed += dt;

  // Kickoff freeze: bodies are still, but we still record last input seq so
  // client reconciliation stays consistent.
  if (state.resetTimer > 0) {
    state.resetTimer -= dt;
    for (const id in state.players) {
      const inp = inputs[id];
      if (inp) state.players[id].lastSeq = inp.seq;
    }
    if (state.resetTimer <= 0) { state.resetTimer = 0; state.lastGoal = null; }
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
    const tvx = mx * spd, tvy = my * spd;
    p.vx += (tvx - p.vx) * MOVE_ACCEL;
    p.vy += (tvy - p.vy) * MOVE_ACCEL;
    // Position = movement + decaying knockback.
    const rad = radiusOf(p, state);
    p.x = clamp(p.x + (p.vx + p.kvx) * dt, rad, FIELD.W - rad);
    p.y = clamp(p.y + (p.vy + p.kvy) * dt, rad, FIELD.H - rad);
    p.kvx *= KNOCKBACK_DECAY; p.kvy *= KNOCKBACK_DECAY;
    if (Math.hypot(p.kvx, p.kvy) < KNOCKBACK_MIN) { p.kvx = 0; p.kvy = 0; }

    // Aim follows the aim stick, else the movement direction.
    const alen = Math.hypot(inp.aimX || 0, inp.aimY || 0);
    if (alen > 0.15) { p.aimX = inp.aimX / alen; p.aimY = inp.aimY / alen; }
    else if (mlen > 0.15) { p.aimX = mx / (mlen || 1); p.aimY = my / (mlen || 1); }

    p.shootCd = Math.max(0, p.shootCd - dt);
    p.specialCd = Math.max(0, p.specialCd - dt);
    p.firing = false;
    p._shoot = !!inp.shoot;
    p._special = !!inp.special;
    p._charge = inp.charge != null ? inp.charge : 0; // 0..1 hold power
    p.lastSeq = inp.seq != null ? inp.seq : p.lastSeq;
  }

  separatePlayers(state);

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
      } else if (p.shootCd <= 0) {
        fireBullet(state, p, ch, p._charge);
      }
    }
    if (p._special && p.specialCd <= 0) useSpecial(state, p, ch);
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
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.vx *= BALL_FRICTION;
    b.vy *= BALL_FRICTION;
    if (Math.hypot(b.vx, b.vy) < BALL_MIN_SPEED) { b.vx = 0; b.vy = 0; }
    if (b.pickupCd > 0) b.pickupCd -= dt;
    else {
      // First player to touch a loose ball grabs it.
      for (const id in state.players) {
        const p = state.players[id];
        if (Math.hypot(b.x - p.x, b.y - p.y) < radiusOf(p, state) + ballRadius(state)) {
          b.owner = p.id; b.lastTouch = p.team; b.vx = 0; b.vy = 0; break;
        }
      }
    }
  }

  updateProjectiles(state, dt);
  updateBombs(state, dt);
  updateBlasts(state, dt);

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

function updateProjectiles(state, dt) {
  const b = state.ball;
  const keep = [];
  const ballR = ballRadius(state);
  for (const pr of state.projectiles) {
    pr.x += pr.vx * dt;
    pr.y += pr.vy * dt;
    // Fly on until it leaves the field (hits a wall) — no lifetime expiry.
    if (pr.x < 0 || pr.x > FIELD.W || pr.y < 0 || pr.y > FIELD.H) continue;

    // A LOOSE ball is nudged by any bullet. A HELD ball is transparent here —
    // only a full-power hit on the CARRIER (below) can knock it loose.
    if (!b.owner) {
      const bdx = b.x - pr.x, bdy = b.y - pr.y;
      if (Math.hypot(bdx, bdy) < PROJECTILE.radius + ballR) {
        const l = Math.hypot(pr.vx, pr.vy) || 1;
        b.lastTouch = pr.team; b.pickupCd = RELEASE_PICKUP_CD;
        b.vx = (pr.vx / l) * PROJECTILE.ballPush * pr.cmul;
        b.vy = (pr.vy / l) * PROJECTILE.ballPush * pr.cmul;
        continue; // consume the bullet
      }
    }

    // Hit an enemy player.
    let consumed = false;
    for (const id in state.players) {
      const t = state.players[id];
      if (t.id === pr.owner || t.team === pr.team) continue;
      const rad = radiusOf(t, state);
      if (Math.hypot(t.x - pr.x, t.y - pr.y) < PROJECTILE.radius + rad) {
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
    const kb = state.settings.bulletKnockback * pr.charge * CARRIER_KNOCKBACK_MUL;
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
  t.kvx += nx * state.settings.bulletKnockback * pr.charge;
  t.kvy += ny * state.settings.bulletKnockback * pr.charge;
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
  // Push ALL players away from center; strength falls off to 0 at the edge.
  for (const id in state.players) {
    const t = state.players[id];
    const dx = t.x - bomb.x, dy = t.y - bomb.y;
    const d = Math.hypot(dx, dy) || 0.0001;
    if (d < BOMB.radius) {
      const falloff = 1 - d / BOMB.radius; // 1 at center, 0 at edge
      const power = state.settings.bombPower * falloff;
      t.kvx += (dx / d) * power;
      t.kvy += (dy / d) * power;
    }
  }
  // Push the ball too — and knock it loose if someone was carrying it.
  const b = state.ball;
  const bx = b.x - bomb.x, by = b.y - bomb.y;
  const bd = Math.hypot(bx, by) || 0.0001;
  if (bd < BOMB.radius) {
    if (b.owner) { b.owner = null; b.pickupCd = RELEASE_PICKUP_CD; }
    b.lastTouch = bomb.team;
    const power = state.settings.bombPower * (1 - bd / BOMB.radius) * BOMB.ballPush;
    b.vx += (bx / bd) * power;
    b.vy += (by / bd) * power;
  }
  state.blasts.push({ id: state._nid++, x: bomb.x, y: bomb.y, radius: BOMB.radius, life: BOMB.blastLife, maxLife: BOMB.blastLife });
}

function updateBlasts(state, dt) {
  for (const bl of state.blasts) bl.life -= dt;
  state.blasts = state.blasts.filter((bl) => bl.life > 0);
}
