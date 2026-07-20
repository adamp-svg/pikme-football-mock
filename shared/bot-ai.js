// Bot AI — a coordinated, tool-aware controller for the 2v2 football brawler.
//
// Design (see docs/superpowers research): a per-team COORDINATOR assigns each of
// the two bots a role with hysteresis (never both chase the ball), a per-bot
// UTILITY layer scores the tactical action for that role, CONTEXT STEERING moves
// the body around walls / away from bombs & bullets, and a SKILL model (reaction
// latency + smoothed noisy aim) keeps bots human-like and beatable.
//
// Pure + framework-free: `computeBotInputs(state, mem, dt)` returns { botId: input }
// for every bot in `state`. The server just copies those into its input map.
// Everything is grounded in the AUTHORITATIVE sim rules, notably:
//   - a ball-carrier is only stripped by a FULL-charge (>=FULL_CHARGE) bullet, and
//     knockback near the enemy goal is cut to PENALTY_KNOCKBACK_MUL,
//   - you cannot dribble a goal — a free ball must cross the line, so bots RELEASE,
//   - a bomb only rocket-jumps/tackles if the planter stays within BOMB_CENTER_R of
//     the plant for the whole BOMB.fuse, so bots HOLD after planting,
//   - live tuning (bulletSpeed/bombPower/shotPower) comes from state.settings.

import {
  FIELD, GOAL, PENALTY, PENALTY_KNOCKBACK_MUL, BOMB, PROJECTILE, MAG_SIZE, FULL_CHARGE,
  BOMB_CENTER_R, BUILT_WALL, RELEASE_PICKUP_CD, CHARACTERS, DEFAULT_CHAR, clamp,
} from './constants.js';
import { ARENA, pointInBox, pointInBush } from './arena.js';

const GY = FIELD.H / 2;
const GOAL_TOP = (FIELD.H - GOAL.width) / 2;
const GOAL_BOTTOM = (FIELD.H + GOAL.width) / 2;
const PEN_TOP = (FIELD.H - PENALTY.width) / 2;
const PEN_BOT = (FIELD.H + PENALTY.width) / 2;
const BOT_R = (CHARACTERS[DEFAULT_CHAR].radius) * 1.25; // matches default sizeMul; refined per-state below

const enemyGoalX = (team) => (team === 'A' ? FIELD.W : 0);
const ownGoalX = (team) => (team === 'A' ? 0 : FIELD.W);

// ---- difficulty skill vectors (Normal ships; presets wired for later scaling) ----
export const BOT_SKILL = {
  easy:   { react: 0.30, aimSigma: 0.17, aimTau: 0.60, turnRate: 6.0,  leadGain: 0.70, decisionHz: 7,  toolSkill: 0.45, evade: 0.55, aggro: 0.75 },
  normal: { react: 0.09, aimSigma: 0.05, aimTau: 0.30, turnRate: 15.0, leadGain: 0.96, decisionHz: 15, toolSkill: 0.85, evade: 0.85, aggro: 0.95 },
  hard:   { react: 0.06, aimSigma: 0.028, aimTau: 0.26, turnRate: 14.0, leadGain: 1.0, decisionHz: 20, toolSkill: 0.96, evade: 0.96, aggro: 1.0 },
};
export const DEFAULT_SKILL = 'normal';

export function createBotMemory(skill = DEFAULT_SKILL) {
  return { skill, t: 0, teams: { A: null, B: null }, bots: {} };
}

// ---- tiny vector helpers ----
const hyp = Math.hypot;
function unit(x, y) { const l = hyp(x, y) || 1; return [x / l, y / l]; }
function len(x, y) { return hyp(x, y); }
function seededNoise(seed) { const n = Math.sin(seed * 127.1) * 43758.5453; return (n - Math.floor(n)) * 2 - 1; } // [-1,1], deterministic

// A player's effective radius given live settings.
function radOf(state) { return CHARACTERS[DEFAULT_CHAR].radius * (state.settings.sizeMul || 1); }
function ballRad(state) { return 16 * (state.settings.ballSizeMul || 1); }

// Is `p` inside the penalty box it is ATTACKING (knockback cut to 0.3× there)?
export function inEnemyBox(p) {
  if (p.y < PEN_TOP || p.y > PEN_BOT) return false;
  return p.team === 'A' ? p.x > FIELD.W - PENALTY.depth : p.x < PENALTY.depth;
}

// ---- exact intercept: aim so a projectile of speed `ps` hits a mover ----
// Returns a unit aim vector. Falls back to a lead estimate then straight aim.
export function quadraticIntercept(sx, sy, tx, ty, tvx, tvy, ps) {
  const rx = tx - sx, ry = ty - sy;
  const a = tvx * tvx + tvy * tvy - ps * ps;
  const b = 2 * (rx * tvx + ry * tvy);
  const c = rx * rx + ry * ry;
  let tHit = 0;
  if (Math.abs(a) < 1e-3) {
    if (Math.abs(b) > 1e-6) tHit = -c / b;
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const s = Math.sqrt(disc);
      const t1 = (-b - s) / (2 * a), t2 = (-b + s) / (2 * a);
      tHit = Math.min(t1 > 0 ? t1 : Infinity, t2 > 0 ? t2 : Infinity);
      if (!isFinite(tHit)) tHit = 0;
    }
  }
  if (tHit > 0 && tHit < 3) return unit(rx + tvx * tHit, ry + tvy * tHit);
  return unit(rx, ry);
}

// ---- line-of-fire clear? samples static+built walls AND enemy bodies ----
export function laneClear(x0, y0, x1, y1, state, forTeam, { enemies = true, margin = 0 } = {}) {
  const steps = 10;
  const foes = enemies ? Object.values(state.players).filter((q) => q.team !== forTeam) : [];
  const er = radOf(state) + 10 + margin;
  for (let i = 1; i <= steps; i++) {
    const x = x0 + (x1 - x0) * i / steps, y = y0 + (y1 - y0) * i / steps;
    for (const w of ARENA.walls) if (pointInBox(x, y, w)) return false;
    for (const w of state.builtWalls) if (pointInBox(x, y, w)) return false;
    for (const f of foes) if (hyp(f.x - x, f.y - y) < er) return false;
  }
  return true;
}

// ---- fog of war: can `viewer` (a bot) actually see `target`? mirrors client stealth ----
export function botCanSee(viewer, target, state) {
  if (viewer.team === target.team) return true;
  if (!pointInBush(target.x, target.y)) return true;
  if (state.ball.owner === target.id) return true;      // carrying reveals
  if (target.firing) return true;                        // muzzle reveals
  if (hyp(viewer.x - target.x, viewer.y - target.y) < 200) return true; // BUSH_REVEAL_DIST-ish
  return false;
}

// ---- CONTEXT STEERING: pick a movement dir toward `tgt`, avoiding walls/bombs/bullets ----
// 16 candidate directions; each gets interest (dot toward target) minus danger
// (proximity to walls, live bombs, incoming bullets, optionally enemies).
const DIRS = (() => { const a = []; for (let i = 0; i < 16; i++) { const th = i / 16 * Math.PI * 2; a.push([Math.cos(th), Math.sin(th)]); } return a; })();

function steer(bot, tgtx, tgty, state, bmem, sk) {
  const r = radOf(state);
  const [tox, toy] = unit(tgtx - bot.x, tgty - bot.y);
  // gather dangers: walls (static+built), live bombs, incoming enemy bullets.
  const walls = ARENA.walls.concat(state.builtWalls);
  const look = 110;
  let best = null, bestScore = -1e9;
  for (const [dx, dy] of DIRS) {
    const interest = dx * tox + dy * toy;            // -1..1
    let danger = 0;
    const px = bot.x + dx * look, py = bot.y + dy * look;
    for (const w of walls) {
      const nx = clamp(px, w.x, w.x + w.w), ny = clamp(py, w.y, w.y + w.h);
      const d = hyp(px - nx, py - ny);
      if (d < r + 46) danger = Math.max(danger, (r + 46 - d) / (r + 46));
    }
    // live bombs: flee the blast (weight by how soon it blows)
    for (const b of state.bombs) {
      const d = hyp(px - b.x, py - b.y);
      if (d < BOMB.radius + 40) { const soon = clamp(1 - b.fuse / BOMB.fuse, 0, 1); danger = Math.max(danger, (1 - d / (BOMB.radius + 40)) * (0.4 + 0.6 * soon) * sk.evade); }
    }
    // incoming enemy bullets heading roughly at us: sidestep
    for (const pr of state.projectiles) {
      if (pr.team === bot.team) continue;
      const rel = hyp(pr.x - bot.x, pr.y - bot.y);
      if (rel > 340) continue;
      const [bvx, bvy] = unit(pr.vx || (bot.x - pr.x), pr.vy || (bot.y - pr.y));
      const toMe = unit(bot.x - pr.x, bot.y - pr.y);
      if (bvx * toMe[0] + bvy * toMe[1] < 0.9) continue; // not aimed at us
      // danger for candidate dirs aligned with the bullet's travel (don't run along it)
      const align = Math.abs(dx * bvx + dy * bvy);
      danger = Math.max(danger, align * (1 - rel / 340) * sk.evade * 0.9);
    }
    const score = interest - danger * 2.2;
    if (score > bestScore) { bestScore = score; best = [dx, dy]; }
  }
  // stuck detection: barely moved while wanting to move -> nudge tangentially (wall-follow)
  const moved = hyp(bot.x - (bmem.lastX ?? bot.x), bot.y - (bmem.lastY ?? bot.y));
  bmem.lastX = bot.x; bmem.lastY = bot.y;
  if (moved < 2.2 && (bmem.wantMove || 0) > 0.5) {
    bmem.stuck = (bmem.stuck || 0) + 1;
    if (bmem.stuck > 4) { const h = bmem.stuckSign || (bmem.stuckSign = seededNoise(bot.id.length + 1) > 0 ? 1 : -1); best = [ -best[1] * h, best[0] * h ]; }
  } else bmem.stuck = 0;
  // low-pass so movement doesn't twitch (sim MOVE_ACCEL snaps velocity).
  const px = bmem.mvx ?? best[0], py = bmem.mvy ?? best[1];
  bmem.mvx = px + (best[0] - px) * 0.35;
  bmem.mvy = py + (best[1] - py) * 0.35;
  return unit(bmem.mvx, bmem.mvy);
}

// ---- COORDINATOR: assign roles to a team's two bots, with hysteresis ----
// Roles: 'onBall' (press the carrier / chase the loose ball / carry) and
// 'support' (attack outlet when we attack, cover shadow when we defend).
const SWITCH_MARGIN = 120, MIN_HOLD = 0.5;
export function assignRoles(state, team, mem, dt) {
  const bots = Object.values(state.players).filter((p) => p.team === team);
  const prev = mem.teams[team];
  if (bots.length === 0) { mem.teams[team] = null; return null; }
  if (bots.length === 1) { const r = { onBall: bots[0].id, support: null, mode: ballMode(state, team) }; mem.teams[team] = r; return r; }

  const b = state.ball;
  const focus = b.owner && state.players[b.owner] ? state.players[b.owner] : b;
  const d0 = hyp(focus.x - bots[0].x, focus.y - bots[0].y);
  const d1 = hyp(focus.x - bots[1].x, focus.y - bots[1].y);
  // candidate: nearest to focus is onBall (deterministic slot tie-break).
  let onBall = d0 <= d1 ? bots[0].id : bots[1].id;
  // hysteresis: keep the previous onBall unless the other is clearly closer for a moment.
  const hold = prev && (mem.t - (prev.since || 0)) < MIN_HOLD;
  if (prev && prev.onBall && state.players[prev.onBall]) {
    const cur = state.players[prev.onBall];
    const other = bots.find((p) => p.id !== prev.onBall);
    const dCur = hyp(focus.x - cur.x, focus.y - cur.y);
    const dOther = other ? hyp(focus.x - other.x, focus.y - other.y) : 1e9;
    if (hold || dOther > dCur - SWITCH_MARGIN) onBall = prev.onBall;
    else onBall = other.id;
  }
  const support = bots.find((p) => p.id !== onBall)?.id || null;
  const since = (prev && prev.onBall === onBall) ? (prev.since || mem.t) : mem.t;
  const r = { onBall, support, mode: ballMode(state, team), since };
  mem.teams[team] = r;
  return r;
}
function ballMode(state, team) {
  const b = state.ball;
  if (!b.owner) return 'loose';
  return state.players[b.owner]?.team === team ? 'attack' : 'defense';
}

// ---- per-bot memory (lazy) ----
function bmemOf(mem, id) {
  return mem.bots[id] || (mem.bots[id] = {
    aimTheta: 0, mvx: 0, mvy: 0, wantMove: 1, stuck: 0,
    reactUntil: 0, sitHash: '', decideAt: 0, action: null, bombHold: null,
  });
}

// intercept a loose ball accounting for its friction decay (approx exp decay).
function predictBall(b, tau) {
  const k = 2.15; // ~ -ln(BALL_FRICTION)/DT per second
  const f = (1 - Math.exp(-k * tau)) / k;
  return [b.x + b.vx * f, b.y + b.vy * f];
}

// ---- main entry ----
// opts.onlyTeam limits output to one team (used by the bot-vs-bot eval harness).
export function computeBotInputs(state, mem, dt, opts = {}) {
  mem.t += dt;
  const sk = BOT_SKILL[mem.skill] || BOT_SKILL[DEFAULT_SKILL];
  const out = {};
  const teams = opts.onlyTeam ? [opts.onlyTeam] : ['A', 'B'];
  for (const team of teams) assignRoles(state, team, mem, dt);

  for (const team of teams) {
    const role = mem.teams[team];
    if (!role) continue;
    for (const p of Object.values(state.players)) {
      if (p.team !== team || !p.isBot) continue;
      out[p.id] = decideBot(p, role, state, mem, sk, dt);
    }
  }
  return out;
}

// Decide one bot's input: role tactics -> desired {move target, aim, buttons},
// then apply steering + skill (reaction latency, aim slew + noise).
function decideBot(p, role, state, mem, sk, dt) {
  const bm = bmemOf(mem, p.id);
  const b = state.ball;
  const team = p.team, egX = enemyGoalX(team), ogX = ownGoalX(team);
  const isOnBall = role.onBall === p.id;
  const mate = state.players[isOnBall ? role.support : role.onBall];
  const enemies = Object.values(state.players).filter((q) => q.team !== team);
  const visibleEnemies = enemies.filter((e) => botCanSee(p, e, state));
  const canShoot = p.ammo > 0 && (p.reloadLock || 0) <= 0;
  const bombReady = (p.specialCd || 0) <= 0;
  const buildReady = p.buildAmmo >= 1 && (p.buildCd || 0) <= 0;
  const settings = state.settings;
  const bulletSpeed = settings.bulletSpeed || 720;

  // target point to move toward, plus button intents (decided at decisionHz)
  let tgt = { x: p.x, y: p.y };
  let aim = { x: p.aimX, y: p.aimY };
  let shoot = false, charge = 0, special = false, build = false;

  // --- If mid bomb-hold, freeze on the plant spot until the fuse blows ---
  if (bm.bombHold && mem.t < bm.bombHold.until) {
    tgt = { x: bm.bombHold.x, y: bm.bombHold.y };
    const tp = bm.bombHold.target;
    aim = { x: (tp ? tp.x : p.x + p.aimX) - p.x, y: (tp ? tp.y : p.y + p.aimY) - p.y };
    bm.wantMove = 0.2;
    return finalize(p, tgt, aim, { shoot: false, charge: 0, special: false, build: false }, state, mem, bm, sk, dt);
  } else if (bm.bombHold) bm.bombHold = null;

  const carrier = b.owner ? state.players[b.owner] : null;

  if (b.owner === p.id) {
    // ===== I CARRY: attack =====
    const distGoal = hyp(egX - p.x, GY - p.y);
    let nearFoe = null, nfd = 1e9;
    for (const e of visibleEnemies) { const d = hyp(e.x - p.x, e.y - p.y); if (d < nfd) { nfd = d; nearFoe = e; } }
    const linedUp = Math.abs(p.y - GY) < GOAL.width / 2 + 220;
    const shotLane = laneClear(p.x, p.y, egX, GY, state, team, { enemies: false }); // power shot plows through a defender
    // 1) open shot on goal -> RELEASE full power (can't dribble a goal in)
    if (distGoal < 820 && linedUp && shotLane) {
      aim = { x: egX - p.x, y: GY - p.y }; shoot = true; charge = 1;
    } else if (mate && nfd < 260) {
      // 2) marked -> pass to a better-placed, open mate
      const mateBetter = hyp(egX - mate.x, GY - mate.y) < distGoal - 30;
      if (mateBetter && laneClear(p.x, p.y, mate.x, mate.y, state, team, { margin: 4 })) {
        aim = { x: mate.x - p.x, y: mate.y - p.y }; shoot = true; charge = clamp(hyp(mate.x - p.x, mate.y - p.y) / 950, 0.4, 0.85);
      }
    }
    // 3) cornered breakaway: bomb rocket-jump toward goal (HOLD after planting)
    if (!shoot && bombReady && nfd < 150 && distGoal < 900 && shotLane && Math.random() < sk.aggro) {
      special = true; aim = { x: egX - p.x, y: GY - p.y };
      bm.bombHold = { x: p.x, y: p.y, until: mem.t + BOMB.fuse + 0.1, target: { x: egX, y: GY } };
    }
    // dribble toward goal, veering off the nearest defender
    tgt = { x: egX, y: GY };
    if (nearFoe && nfd < 230) { tgt = { x: p.x + (p.x - nearFoe.x) * 1.2 + (egX - p.x) * 0.6, y: p.y + (p.y - nearFoe.y) * 1.2 + (GY - p.y) * 0.4 }; }
    if (!shoot && !special) aim = { x: egX - p.x, y: GY - p.y };

  } else if (carrier && carrier.team === team) {
    // ===== TEAMMATE CARRIES: I support (open a passing lane / trail for rebound) =====
    if (isOnBall) {
      // (rare) I'm nominally onBall but mate has it -> become a close outlet
      tgt = { x: carrier.x + (egX - carrier.x) * 0.35, y: GY + (p.slot === 0 ? -170 : 170) };
    } else {
      // move ahead to an OPEN outlet with a clear lane from the carrier
      const ahead = egX - (team === 'A' ? 300 : -300);
      let bestY = GY + (p.slot === 0 ? -220 : 220), bestScore = -1e9;
      for (const oy of [GY - 300, GY - 150, GY, GY + 150, GY + 300]) {
        if (laneClear(carrier.x, carrier.y, ahead, oy, state, team, { margin: 2 })) {
          const openness = visibleEnemies.reduce((m, e) => Math.min(m, hyp(ahead - e.x, oy - e.y)), 1e9);
          const sc = openness - Math.abs(oy - p.y) * 0.2;
          if (sc > bestScore) { bestScore = sc; bestY = oy; }
        }
      }
      tgt = { x: ahead, y: bestY };
    }
    aim = { x: egX - p.x, y: GY - p.y };

  } else if (carrier) {
    // ===== ENEMY CARRIES: press (onBall) or cover (support) =====
    const c = carrier, distC = hyp(c.x - p.x, c.y - p.y);
    const seeC = botCanSee(p, c, state);
    const lane = laneClear(p.x, p.y, c.x, c.y, state, team, { enemies: false });
    if (isOnBall) {
      tgt = { x: c.x, y: c.y };
      const [ax, ay] = quadraticIntercept(p.x, p.y, c.x, c.y, c.vx || 0, c.vy || 0, bulletSpeed);
      aim = { x: ax, y: ay };
      // strip only works with a FULL charge, and only OUTSIDE the enemy's box.
      const cInBox = inEnemyBox({ team: c.team, x: c.x, y: c.y }); // carrier attacking its target box
      const carrierProtected = c.team === 'A' ? c.x > FIELD.W - PENALTY.depth && Math.abs(c.y - GY) < PENALTY.width / 2
                                              : c.x < PENALTY.depth && Math.abs(c.y - GY) < PENALTY.width / 2;
      if (canShoot && seeC && lane && distC < 430 && !carrierProtected) { shoot = true; charge = 1; }
      // bomb tackle-steal: get close, plant, HOLD within center for the fuse
      if (bombReady && seeC && distC > BOMB_CENTER_R && distC < 300 && Math.random() < sk.aggro * 0.6) {
        special = true; shoot = false; aim = { x: c.x - p.x, y: c.y - p.y };
        bm.bombHold = { x: p.x, y: p.y, until: mem.t + BOMB.fuse + 0.1, target: { x: c.x, y: c.y } };
      }
    } else {
      // cover: sit on the carrier->own-goal shadow, mark the SECOND enemy if any
      const other = enemies.find((e) => e.id !== c.id);
      const shadowX = c.x + (ogX - c.x) * 0.58, shadowY = c.y + (GY - c.y) * 0.58;
      if (other && botCanSee(p, other, state)) {
        // mark: stand goal-side of the second enemy
        tgt = { x: (other.x + ogX) / 2, y: (other.y + GY) / 2 };
      } else {
        tgt = { x: shadowX, y: shadowY };
      }
      aim = { x: c.x - p.x, y: c.y - p.y };
      // build a wall to block the shot lane to our goal when we're goal-side & threatened
      const carrierLiningUp = Math.abs(c.y - GY) < GOAL.width / 2 + 160 && Math.abs(c.x - ogX) < FIELD.W * 0.42;
      const goalSide = Math.abs(p.x - ogX) < Math.abs(c.x - ogX);
      if (buildReady && carrierLiningUp && goalSide && Math.random() < sk.toolSkill * 0.5) {
        build = true; aim = { x: ogX - p.x, y: GY - p.y }; shoot = false; special = false;
      } else if (canShoot && seeC && lane && distC < 320) {
        shoot = true; charge = 1; // opportunistic strip if a clean full-charge is there
      }
    }

  } else {
    // ===== LOOSE BALL =====
    if (isOnBall) {
      const [bx, by] = predictBall(b, clamp(len(b.x - p.x, b.y - p.y) / 900, 0.05, 0.5));
      tgt = { x: bx, y: by };
      aim = { x: egX - p.x, y: GY - p.y };
    } else {
      // hold a supporting spot between the ball and our goal (slightly toward a bush for ambush)
      const holdX = (b.x + ogX) / 2, holdY = (b.y + GY) / 2;
      tgt = { x: holdX, y: holdY };
      aim = { x: b.x - p.x, y: b.y - p.y };
    }
  }

  return finalize(p, tgt, aim, { shoot, charge, special, build }, state, mem, bm, sk, dt);
}

// Apply steering + skill (reaction latency + smoothed noisy aim), emit the input.
function finalize(p, tgt, aimVec, btn, state, mem, bm, sk, dt) {
  bm.wantMove = 1;
  const [mvx, mvy] = steer(p, tgt.x, tgt.y, state, bm, sk);

  // desired aim angle
  const [dax, day] = unit(aimVec.x, aimVec.y);
  const desired = Math.atan2(day, dax);
  // reaction latency: only start slewing toward a NEW desired aim after `react`
  const dTheta = Math.atan2(Math.sin(desired - bm.aimTheta), Math.cos(desired - bm.aimTheta));
  if (Math.abs(dTheta) > 0.9 && mem.t > (bm.reactUntil || 0)) bm.reactUntil = mem.t + sk.react;
  const slew = (mem.t >= (bm.reactUntil || 0)) ? sk.turnRate * dt : sk.turnRate * dt * 0.25;
  bm.aimTheta += clamp(dTheta, -slew, slew);
  // smoothed aim noise that shrinks the longer the aim is settled (time-on-target)
  bm.onTgt = Math.abs(dTheta) < 0.12 ? (bm.onTgt || 0) + dt : 0;
  const noise = sk.aimSigma * Math.exp(-(bm.onTgt || 0) / sk.aimTau) * seededNoise(mem.t * 9.3 + p.id.length);
  const th = bm.aimTheta + noise;
  const ax = Math.cos(th), ay = Math.sin(th);

  // don't fire before the aim has roughly converged (prevents wild misses / ammo dump)
  let { shoot, charge, special, build } = btn;
  if (shoot && Math.abs(dTheta) > 0.45) { shoot = false; }
  // ammo discipline: never try to shoot bullets with an empty/reloading mag
  if (shoot && charge < 0.99 && p.ammo <= 0) shoot = false;

  return {
    seq: (bm.seq = (bm.seq || 0) + 1),
    moveX: mvx, moveY: mvy, aimX: ax, aimY: ay,
    shoot, special, build, charge,
  };
}
