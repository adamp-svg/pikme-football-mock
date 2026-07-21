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
  FIELD, GOAL, PENALTY, BOMB, BOMB_CENTER_R, BOMB_COMBINE_RADIUS, BUILT_WALL, BUSH_REVEAL_DIST, VISION_RANGE, BALL_VISION,
  BALL_RADIUS, WALL_BOUNCE, WALL_RESTITUTION,
  CHARACTERS, DEFAULT_CHAR, clamp,
} from './constants.js';
import { ARENA, pointInBox, pointInBush } from './arena.js';

const GY = FIELD.H / 2;
const PEN_TOP = (FIELD.H - PENALTY.width) / 2;
const PEN_BOT = (FIELD.H + PENALTY.width) / 2;

const enemyGoalX = (team) => (team === 'A' ? FIELD.W : 0);
const ownGoalX = (team) => (team === 'A' ? 0 : FIELD.W);

// ---- difficulty skill vectors ----
// Bots have HUMAN-like attributes across all tiers (reaction latency + noisy aim
// stay in a human band — no superhuman reflexes). Difficulty scales MECHANICAL
// power instead: `chargeRate` (reach full power sooner) and `cdMul` (bomb/build
// come back faster). Harder = stronger, not twitchier.
export const BOT_SKILL = {
  easy:   { react: 0.30, aimSigma: 0.11,  aimTau: 0.55, turnRate: 8.0,  leadGain: 0.80, decisionHz: 8,  toolSkill: 0.50, evade: 0.60, aggro: 0.80, chargeRate: 0.88, cdMul: 1.20 },
  normal: { react: 0.22, aimSigma: 0.05,  aimTau: 0.30, turnRate: 13.0, leadGain: 0.95, decisionHz: 12, toolSkill: 0.75, evade: 0.85, aggro: 0.92, chargeRate: 1.00, cdMul: 1.00 },
  hard:   { react: 0.16, aimSigma: 0.03,  aimTau: 0.24, turnRate: 18.0, leadGain: 1.00, decisionHz: 18, toolSkill: 0.90, evade: 0.95, aggro: 1.00, chargeRate: 1.25, cdMul: 0.80 },
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
function idHash(id) { let h = 0; for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0; return h; } // stable per-id seed (decorrelates bots)
// Nearest bush centre to (x,y) within maxD — off-ball bots lurk here to ambush.
function nearestBushCenter(x, y, maxD = 520) {
  let best = null, bd = maxD;
  for (const g of ARENA.bushes) { const cx = g.x + g.w / 2, cy = g.y + g.h / 2, d = hyp(cx - x, cy - y); if (d < bd) { bd = d; best = { x: cx, y: cy }; } }
  return best;
}

// A player's effective radius given live settings.
function radOf(state) { return CHARACTERS[DEFAULT_CHAR].radius * (state.settings.sizeMul || 1); }

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
// `viewer` (a bot): if given, an enemy HIDDEN in a bush (unseen by this viewer) is NOT
// counted as blocking — the bot can't plan around a body it can't see (bush stealth).
export function laneClear(x0, y0, x1, y1, state, forTeam, { enemies = true, margin = 0, viewer = null } = {}) {
  const steps = 10;
  const foes = enemies ? Object.values(state.players).filter((q) => q.team !== forTeam && (!viewer || botCanSee(viewer, q, state))) : [];
  const er = radOf(state) + 10 + margin;
  for (let i = 1; i <= steps; i++) {
    const x = x0 + (x1 - x0) * i / steps, y = y0 + (y1 - y0) * i / steps;
    for (const w of ARENA.walls) if (pointInBox(x, y, w)) return false;
    for (const w of state.builtWalls) if (pointInBox(x, y, w)) return false;
    for (const f of foes) if (hyp(f.x - x, f.y - y) < er) return false;
  }
  return true;
}

// ---- distance from point (px,py) to segment (ax,ay)-(bx,by) ----
function pointSegDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1);
  return hyp(px - (ax + dx * t), py - (ay + dy * t));
}

// ---- would a built wall placed by `p` aiming (ax,ay) actually spawn? The sim ALWAYS
// places one now (a build inside a bush/penalty is allowed — it's just FRAGILE, hp1),
// so a build never fails. Kept as a hook in case future rules reject a placement. ----
function wallWouldPlace(p, ax, ay) {
  return true; // sim.buildWall always places (fragile in bush/penalty) — the bush-ambush wall trap works there
}

// ---- pick the bush that best straddles the carrier -> our-goal lane (ambush spot) ----
function chooseAmbushBush(c, ogX) {
  let best = null, bestScore = -1e9;
  for (const g of ARENA.bushes) {
    const bx = g.x + g.w / 2, by = g.y + g.h / 2;
    if (Math.abs(bx - ogX) > Math.abs(c.x - ogX) + 120) continue; // must be goal-side of the carrier
    const d = pointSegDist(bx, by, c.x, c.y, ogX, GY);
    if (d > 260) continue;
    const score = -d - 0.15 * Math.abs(by - GY);
    if (score > bestScore) { bestScore = score; best = { x: bx, y: by, hw: g.w / 2, hh: g.h / 2 }; }
  }
  return best;
}

// ---- BANK / RICOCHET aim: shoot the ball off a wall/touchline so it curves around a
// blocker to target (tx,ty). Restitution-corrected mirror (image = T - dT*(1+1/e)*n)
// so the bounce arrives on target; validated by an energy model (friction + bounce
// loss) so we never bank a ball that dies short. Returns {aimX,aimY,charge,vT} or null. ----
function bankAim(sx, sy, tx, ty, state, team, { goal = false, maxPath = 780, viewer = null } = {}) {
  const R = BALL_RADIUS * (state.settings.ballSizeMul || 1);
  const K = 2.1768;                       // -ln(BALL_FRICTION per second)
  const v0 = state.settings.shotPower || 1850; // full-charge release speed
  const VMIN = goal ? 300 : 120;
  const refl = [
    { nx: 0, ny: 1, py: R, e: WALL_RESTITUTION, lo: R, hi: FIELD.W - R },              // top touchline
    { nx: 0, ny: -1, py: FIELD.H - R, e: WALL_RESTITUTION, lo: R, hi: FIELD.W - R },    // bottom touchline
  ];
  for (const w of ARENA.walls) {
    refl.push({ nx: 0, ny: -1, py: w.y - R, e: WALL_BOUNCE, lo: w.x, hi: w.x + w.w });          // wall top face
    refl.push({ nx: 0, ny: 1, py: w.y + w.h + R, e: WALL_BOUNCE, lo: w.x, hi: w.x + w.w });     // wall bottom face
    if (!goal) { // vertical faces flip vx -> only for passes, never goal banks
      refl.push({ nx: -1, ny: 0, px: w.x - R, e: WALL_BOUNCE, loY: w.y, hiY: w.y + w.h });
      refl.push({ nx: 1, ny: 0, px: w.x + w.w + R, e: WALL_BOUNCE, loY: w.y, hiY: w.y + w.h });
    }
  }
  let best = null, bestV = -1e9;
  for (const rf of refl) {
    const P0x = rf.nx !== 0 ? rf.px : sx, P0y = rf.ny !== 0 ? rf.py : sy;
    const dS = (sx - P0x) * rf.nx + (sy - P0y) * rf.ny;
    const dT = (tx - P0x) * rf.nx + (ty - P0y) * rf.ny;
    if (dS <= 0 || dT <= 0) continue;
    const Ix = tx - dT * (1 + 1 / rf.e) * rf.nx, Iy = ty - dT * (1 + 1 / rf.e) * rf.ny;
    const adx = Ix - sx, ady = Iy - sy;
    const dImg = (Ix - P0x) * rf.nx + (Iy - P0y) * rf.ny;
    const denom = dS - dImg; if (Math.abs(denom) < 1e-6) continue;
    const t = dS / denom; if (t <= 0.04 || t >= 0.96) continue;
    const Bx = sx + adx * t, By = sy + ady * t;
    const span = rf.nx !== 0 ? By : Bx, lo = rf.nx !== 0 ? rf.loY : rf.lo, hi = rf.nx !== 0 ? rf.hiY : rf.hi;
    if (span < lo + R || span > hi - R) continue;               // keep off the corners
    const [udx, udy] = unit(adx, ady);
    if (udx * rf.nx + udy * rf.ny >= 0) continue;               // must head into the plane
    if (!laneClear(sx, sy, Bx, By, state, team, { enemies: true, viewer })) continue;
    if (!laneClear(Bx, By, tx, ty, state, team, { enemies: true, margin: goal ? 0 : 4, viewer })) continue;
    const L1 = hyp(Bx - sx, By - sy), L2 = hyp(tx - Bx, ty - By);
    if (L1 + L2 > maxPath) continue;
    const vB = v0 - K * L1; if (vB <= 0) continue;
    const cosI = Math.abs(udx * rf.nx + udy * rf.ny);
    const retain = Math.sqrt(rf.e * rf.e * cosI * cosI + (1 - cosI * cosI));
    const vT = vB * retain - K * L2;
    if (vT < VMIN) continue;
    if (vT > bestV) { bestV = vT; best = { aimX: udx, aimY: udy, charge: 1, vT }; }
  }
  return best;
}

// ---- fog of war: can `viewer` (a bot) actually see `target`? mirrors client stealth ----
// A bot only perceives an enemy within its VIEW (~on-screen); it can't track a foe
// across the whole pitch. Within view, bush stealth then applies. (The BALL itself is
// always known — the shared objective — this gates enemy-PLAYER awareness only.)
export function botCanSee(viewer, target, state) {
  if (viewer.team === target.team) return true;          // teammates always
  const dist = hyp(viewer.x - target.x, viewer.y - target.y);
  // The ball-carrier is the tracked objective — seen at a longer range so bots keep
  // pressing instead of idling. BUT a carrier hiding IN A BUSH stays concealed (falls to
  // the bush rules below) — carrying the ball in a bush does NOT give you away.
  if (state.ball.owner === target.id && !pointInBush(target.x, target.y) && dist <= BALL_VISION) return true;
  if (dist > VISION_RANGE) return false;                 // an OFF-ball enemy out of view — no seeing across the field
  if (!pointInBush(target.x, target.y)) return true;     // in the open (and in view) = seen
  if (target.firing) return true;                        // muzzle flash reveals
  if (dist < BUSH_REVEAL_DIST) return true;              // close enough to spot in the bush
  return false;                                          // off-ball, bushed, not close, not firing = HIDDEN
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
  let best = null, bestScore = -1e9, safest = null, safeD = 1e9;
  for (const [dx, dy] of DIRS) {
    const interest = dx * tox + dy * toy;            // -1..1
    let danger = 0;
    const px = bot.x + dx * look, py = bot.y + dy * look;
    for (const w of walls) {
      const nx = clamp(px, w.x, w.x + w.w), ny = clamp(py, w.y, w.y + w.h);
      const d = hyp(px - nx, py - ny);
      if (d < r + 46) danger = Math.max(danger, (r + 46 - d) / (r + 46));
    }
    // field boundary (the "stadium wall") — don't steer into the pitch edge and pin there
    const m = r + 34;
    if (px < m) danger = Math.max(danger, (m - px) / m);
    else if (px > FIELD.W - m) danger = Math.max(danger, (px - (FIELD.W - m)) / m);
    if (py < m) danger = Math.max(danger, (m - py) / m);
    else if (py > FIELD.H - m) danger = Math.max(danger, (py - (FIELD.H - m)) / m);
    // live bombs: flee the blast (weight by how soon it blows) — but NOT my own planted
    // bomb, which I'm deliberately standing on to trigger the rocket-jump.
    for (const b of state.bombs) {
      if (b.owner === bot.id) continue;
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
    // incoming LUNGING enemy (rocket-jump tackle / fast knockback body): sidestep out of
    // its path so a bomb-launched or wall-cannoned opponent can't flying-tackle-steal us.
    for (const e of Object.values(state.players)) {
      if (e.team === bot.team) continue;
      if (!botCanSee(bot, e, state)) continue; // a hidden (bushed) enemy is invisible — don't react to it
      const espd = hyp(e.kvx || 0, e.kvy || 0);
      const lunging = (e.bombLaunch || 0) > 0 || espd > 700;
      if (!lunging) continue;
      const rel = hyp(e.x - bot.x, e.y - bot.y);
      if (rel > 300) continue;
      const [evx, evy] = unit((e.kvx || 0) || (bot.x - e.x), (e.kvy || 0) || (bot.y - e.y));
      const toMe = unit(bot.x - e.x, bot.y - e.y);
      if (evx * toMe[0] + evy * toMe[1] < 0.6) continue; // not lunging at us
      const along = Math.abs(dx * evx + dy * evy);        // flee perpendicular, not along its line
      danger = Math.max(danger, along * (1 - rel / 300) * sk.evade);
    }
    const score = interest - danger * 2.2;
    if (score > bestScore) { bestScore = score; best = [dx, dy]; }
    if (danger < safeD) { safeD = danger; safest = [dx, dy]; } // most-open dir (escape route)
  }
  // stuck detection: barely moved while wanting to move -> break toward the most-open
  // direction (reliably escapes a wall/edge pin, unlike a fixed rotate that can re-pin).
  const moved = hyp(bot.x - (bmem.lastX ?? bot.x), bot.y - (bmem.lastY ?? bot.y));
  bmem.lastX = bot.x; bmem.lastY = bot.y;
  if (moved < 2.0 && (bmem.wantMove || 0) > 0.5) {
    bmem.stuck = (bmem.stuck || 0) + 1;
    if (bmem.stuck > 3 && safest) {
      const h = bmem.stuckSign || (bmem.stuckSign = (idHash(bot.id) & 1) ? 1 : -1);
      // bias the escape sideways (deterministic per bot) so two stuck bots don't mirror
      best = [safest[0] - safest[1] * 0.4 * h, safest[1] + safest[0] * 0.4 * h];
    }
  } else bmem.stuck = 0;
  // low-pass so movement doesn't twitch (sim MOVE_ACCEL snaps velocity).
  const px = bmem.mvx ?? best[0], py = bmem.mvy ?? best[1];
  bmem.mvx = px + (best[0] - px) * 0.55; // snappy enough to chase a bouncing ball
  bmem.mvy = py + (best[1] - py) * 0.55;
  return unit(bmem.mvx, bmem.mvy);
}

// ---- FOG-OF-WAR BELIEF: where does `team` THINK the ball is, and can it see it now? ----
// Bots must not omnisciently track a hidden/out-of-view enemy. The ball itself (a big,
// central objective) is "known" while loose in the open, but a CARRIED ball is only known
// while the carrier is actually visible (in view + not bushed). When the team can't see it,
// the belief position stays at where it was last seen — bots search there, they don't laser
// onto the hidden player. Persisted on mem.belief[team].
function updateBelief(state, team, mem) {
  const b = state.ball;
  const bots = Object.values(state.players).filter((p) => p.team === team && p.isBot);
  let visible;
  if (b.owner) {
    const owner = state.players[b.owner];
    if (!owner || owner.team === team) visible = true;             // we hold it (or stale owner)
    else visible = bots.some((bt) => botCanSee(bt, owner, state));  // enemy carrier — only if in sight
  } else if (!pointInBush(b.x, b.y)) {
    visible = true;                                                 // loose ball in the open = known
  } else {
    visible = bots.some((bt) => hyp(bt.x - b.x, bt.y - b.y) < BUSH_REVEAL_DIST); // bushed loose ball — only up close
  }
  const store = mem.belief || (mem.belief = {});
  const cur = store[team] || (store[team] = { x: b.x, y: b.y, vx: 0, vy: 0, tSeen: mem.t });
  if (visible) {
    cur.x = b.x; cur.y = b.y; cur.tSeen = mem.t;
    const carrier = b.owner ? state.players[b.owner] : null;
    cur.vx = carrier ? (carrier.vx || 0) : (b.vx || 0); // remember heading so we chase where it's GOING
    cur.vy = carrier ? (carrier.vy || 0) : (b.vy || 0);
  }
  // When blind, DEAD-RECKON forward along the last-seen heading (bots chase the run, not the stale spot).
  const age = clamp(mem.t - (cur.tSeen || 0), 0, 1.2);
  const px = clamp(cur.x + cur.vx * age, 20, FIELD.W - 20);
  const py = clamp(cur.y + cur.vy * age, 20, FIELD.H - 20);
  return { x: px, y: py, vx: cur.vx, vy: cur.vy, visible, age };
}

// ---- COORDINATOR: assign roles to a team's two bots, with hysteresis ----
// Roles: 'onBall' (press the carrier / chase the loose ball / carry) and
// 'support' (attack outlet when we attack, cover shadow when we defend).
const SWITCH_MARGIN = 120, MIN_HOLD = 0.5;
export function assignRoles(state, team, mem, dt) {
  const belief = updateBelief(state, team, mem);
  const bots = Object.values(state.players).filter((p) => p.team === team);
  const prev = mem.teams[team];
  if (bots.length === 0) { mem.teams[team] = null; return null; }
  if (bots.length === 1) { const r = { onBall: bots[0].id, support: null, mode: ballMode(state, team), belief }; mem.teams[team] = r; return r; }

  const b = state.ball;
  // Assign roles around what we can SEE — the real carrier/ball if visible, else the
  // last-seen point (so bots don't pick roles off a hidden ball's true position).
  const focus = belief.visible ? (b.owner && state.players[b.owner] ? state.players[b.owner] : b) : belief;
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
  const r = { onBall, support, mode: ballMode(state, team), since, belief };
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
  for (const id in mem.bots) if (!state.players[id]) delete mem.bots[id]; // prune departed bots
  const sk = BOT_SKILL[mem.skill] || BOT_SKILL[DEFAULT_SKILL];
  const out = {};
  const teams = opts.onlyTeam ? [opts.onlyTeam] : ['A', 'B'];
  for (const team of teams) assignRoles(state, team, mem, dt);

  for (const team of teams) {
    const role = mem.teams[team];
    if (!role) continue;
    for (const p of Object.values(state.players)) {
      if (p.team !== team || !p.isBot) continue;
      // difficulty as mechanical power: harder bots charge full sooner + cool down faster
      p.chargeRate = sk.chargeRate != null ? sk.chargeRate : 1;
      p.cdMul = sk.cdMul != null ? sk.cdMul : 1;
      out[p.id] = decideBot(p, role, state, mem, sk, dt);
    }
  }
  return out;
}

// WALL-BOMB CANNON spot: a plant point a SHORT step from `(px,py)` where a static stone
// wall sits ~130px BEHIND a launch aimed along `dir` (opposite it), so a rocket-jump there
// gets the wall-cannon boost (sim wallCannonMul, static stone only). null if none nearby.
function staticCannonSpot(px, py, dirx, diry) {
  let best = null, bd = 1e9;
  for (const w of ARENA.walls) {
    const cx = w.x + w.w / 2, cy = w.y + w.h / 2;
    const sx = cx + dirx * 130, sy = cy + diry * 130; // stand on the LAUNCH side of the wall
    const d = hyp(sx - px, sy - py);
    if (d < bd && d < 210) { bd = d; best = { x: sx, y: sy }; } // only a short hop — never detour far
  }
  return best;
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
  const canShoot = p.ammo > 0 && (p.reloadLock || 0) <= 0 && (p.shootCd || 0) <= 0;
  const bombReady = (p.specialCd || 0) <= 0;
  const buildReady = p.buildAmmo >= 1 && (p.buildCd || 0) <= 0;
  const settings = state.settings;
  const bulletSpeed = settings.bulletSpeed || 720;

  // target point to move toward, plus button intents (decided at decisionHz)
  let tgt = { x: p.x, y: p.y };
  let aim = { x: p.aimX, y: p.aimY };
  let shoot = false, charge = 0, special = false, build = false;

  // --- If mid bomb-hold, STAND on the plant until the fuse blows (staying within
  // BOMB_CENTER_R is what makes the rocket-jump/tackle actually fire). Aim tracks the
  // live target so the launch/tackle vector points at where it is now. ---
  // Abort a tackle-steal hold the moment its target has already lost the ball — don't
  // sit frozen (a sitting duck) chasing a stale premise; the bomb still blasts normally.
  if (bm.bombHold && bm.bombHold.targetId && state.ball.owner !== bm.bombHold.targetId) bm.bombHold = null;
  if (bm.bombHold && mem.t < bm.bombHold.until) {
    const tp = bm.bombHold.targetId ? state.players[bm.bombHold.targetId] : null;
    const gx = tp ? tp.x : bm.bombHold.aimX, gy = tp ? tp.y : bm.bombHold.aimY;
    aim = { x: gx - p.x, y: gy - p.y };
    return finalize(p, { x: bm.bombHold.x, y: bm.bombHold.y }, aim, { shoot: false, charge: 0, special: false, build: false }, state, mem, bm, sk, dt, { hold: true });
  } else if (bm.bombHold) bm.bombHold = null;

  const carrier = b.owner ? state.players[b.owner] : null;
  if (b.owner !== p.id) bm.carryT = 0; // reset carry stall timer when not holding

  // --- FOG OF WAR: if the team can't SEE the ball/carrier (enemy hid in a bush or slipped
  // out of view), converge on the LAST-SEEN spot and search — never laser-track a hidden
  // or off-screen enemy. We re-acquire the instant a bot gets eyes on them again. ---
  const belief = role.belief || { x: b.x, y: b.y, visible: true };
  if (!belief.visible && b.owner !== p.id) {
    bm.charging = null; // lost sight — abandon any pending shot wind-up
    // ACTIVE SEARCH — never park. onBall sweeps a widening arc around the dead-reckoned
    // last-seen point (chasing the likely run); support fans to the OTHER channel and
    // sits goal-side so a blind team still defends. Both always keep moving.
    bm.blindT = (bm.blindT || 0) + dt;
    let tgt;
    if (isOnBall) {
      const sweepR = clamp(bm.blindT, 0, 1.5) / 1.5 * 300;
      const th = mem.t * 2.2 + idHash(p.id) * 0.01;
      tgt = { x: belief.x + Math.cos(th) * sweepR, y: belief.y + Math.sin(th) * sweepR };
    } else {
      // cover the lane between the last-seen ball and our goal, offset to the far channel
      const side = p.slot === 0 ? -1 : 1;
      tgt = { x: (belief.x + ogX) / 2, y: clamp(GY + side * 260, 140, FIELD.H - 140) };
    }
    tgt.x = clamp(tgt.x, 60, FIELD.W - 60); tgt.y = clamp(tgt.y, 60, FIELD.H - 60);
    const aim = { x: belief.x - p.x, y: belief.y - p.y };
    return finalize(p, tgt, aim, { shoot: false, charge: 0, special: false, build: false }, state, mem, bm, sk, dt);
  }
  bm.blindT = 0;

  if (b.owner === p.id) {
    // ===== I CARRY: attack =====
    bm.carryT = (bm.carryT || 0) + dt;
    const distGoal = hyp(egX - p.x, GY - p.y);
    let nearFoe = null, nfd = 1e9;
    for (const e of visibleEnemies) { const d = hyp(e.x - p.x, e.y - p.y); if (d < nfd) { nfd = d; nearFoe = e; } }
    const linedUp = Math.abs(p.y - GY) < GOAL.width / 2 + 280;
    const laneWalls = laneClear(p.x, p.y, egX, GY, state, team, { enemies: false }); // walls only (a power shot plows a defender)
    const laneOpen = laneClear(p.x, p.y, egX, GY, state, team, { enemies: true, viewer: p });   // truly unobstructed (ignores hidden foes)
    const trick = sk.toolSkill;                                                       // fancy tricks scale with difficulty
    const ballR = BALL_RADIUS * (settings.ballSizeMul || 1);
    const mateSafe = !mate || hyp(mate.x - p.x, mate.y - p.y) > BOMB.radius + radOf(state);
    // A defender sitting IN the goal lane (the "blocker") — enables bump-through / bank.
    let blocker = null, blockerDL = 1e9;
    for (const e of visibleEnemies) {
      const denom = egX - p.x; if (Math.abs(denom) < 1) continue;
      const t = (e.x - p.x) / denom; if (t <= 0.05 || t >= 1) continue;
      const lineY = p.y + (GY - p.y) * t;
      if (Math.abs(e.y - lineY) < radOf(state) + ballR + 20) { const dl = Math.abs(egX - e.x); if (dl < blockerDL) { blockerDL = dl; blocker = e; } }
    }

    // A KEEPER = a defender parked in the box in front of the goal — they CATCH a full kick.
    const keeper = blocker && Math.abs(egX - blocker.x) < PENALTY.depth && blocker.y > PEN_TOP && blocker.y < PEN_BOT ? blocker : null;

    // 1) FINISH — a FULL kick now DRIVES THROUGH any field defender (monotonic), so just
    //    shoot on a walls-clear lane. Only a KEEPER-in-box catches it: then spend OVERCHARGE
    //    to break through (if ready), else BANK around them, else fall through to pass/drive.
    if (distGoal < 780 && linedUp && laneWalls && !keeper) {
      aim = { x: egX - p.x, y: GY - p.y }; shoot = true; charge = 1; bm.lastTrick = 'drive';
    } else if (distGoal < 800 && linedUp && keeper) {
      if (p.power) { aim = { x: egX - p.x, y: GY - p.y }; shoot = true; charge = 1; bm.lastTrick = 'overFinish'; } // overcharge beats the save
      else if (trick >= 0.7) {
        const bk = bankAim(b.x, b.y, egX, clamp(GY + (keeper.y < GY ? 90 : -90), 420, 680), state, team, { goal: true, maxPath: 560 + 300 * trick, viewer: p });
        if (bk) { aim = { x: bk.aimX, y: bk.aimY }; shoot = true; charge = 1; bm.lastTrick = 'goalBank'; }
      }
    }

    // 2) marked & not shooting -> PASS to a better mate (direct, or BANK around a blocker); sets give-and-go
    if (!shoot && mate && nfd < 260) {
      const mateBetter = hyp(egX - mate.x, GY - mate.y) < distGoal - 30;
      if (mateBetter) {
        const full = settings.shotPower || 1850;
        if (laneClear(p.x, p.y, mate.x, mate.y, state, team, { margin: 4, viewer: p })) {
          charge = clamp(hyp(mate.x - p.x, mate.y - p.y) / 950, 0.4, 0.85);
          const [pax, pay] = quadraticIntercept(p.x, p.y, mate.x, mate.y, mate.vx || 0, mate.vy || 0, full * clamp(charge, 0.33, 1));
          aim = { x: pax, y: pay }; shoot = true; bm.giveGo = { until: mem.t + 1.0 };
        } else if (trick > 0.6) {
          const bk = bankAim(b.x, b.y, mate.x + (mate.vx || 0) * 0.25, mate.y + (mate.vy || 0) * 0.25, state, team, { goal: false, maxPath: 560 + 260 * trick, viewer: p });
          if (bk) { aim = { x: bk.aimX, y: bk.aimY }; shoot = true; charge = 1; bm.lastTrick = 'passBank'; bm.giveGo = { until: mem.t + 1.0 }; }
        }
      }
    }

    // 3) BOMB: cornered finish only — plant + HOLD. (A carry-TRAVERSAL is no longer worth it:
    // point 8 REDUCES the on-centre launch while carrying, so it'd be a frozen short-hop that
    // just gets the carrier stripped.)
    if (!shoot && !special && bombReady && mateSafe && distGoal < 1200 && laneWalls) {
      const cornered = nfd < 150 && distGoal < 560;
      if (cornered && mem.t > (bm.nextBombAt || 0)) { // commit (specialCd already paces it) — no dice roll
        special = true; aim = { x: egX - p.x, y: GY - p.y };
        bm.bombHold = { x: p.x, y: p.y, until: mem.t + BOMB.fuse + 0.1, aimX: egX, aimY: GY }; bm.lastTrick = 'bombFinish';
        bm.nextBombAt = mem.t + 3.0;
      }
    }

    // Anti-idle: blast goalward if we've dithered. A full kick drives through a FIELD
    // defender, so blast whenever the lane is walls-clear and it's not a keeper we'd feed.
    if (!shoot && !special && bm.carryT > 0.8 && laneWalls && distGoal < 1150 && !keeper) {
      aim = { x: egX - p.x, y: GY - p.y }; shoot = true; charge = 1; bm.carryT = 0;
    }
    // Drive at goal; if marked, JUKE decisively to the more-open side.
    tgt = { x: egX, y: GY };
    if (nearFoe && nfd < 300) {
      const [gx, gy] = unit(egX - p.x, GY - p.y);
      let perpx = -gy, perpy = gx;
      if ((nearFoe.x - p.x) * perpx + (nearFoe.y - p.y) * perpy > 0) { perpx = -perpx; perpy = -perpy; }
      tgt = { x: p.x + gx * 240 + perpx * 320, y: p.y + gy * 240 + perpy * 320 };
    }
    if (!shoot && !special) aim = { x: egX - p.x, y: GY - p.y };

  } else if (carrier && carrier.team === team) {
    // ===== TEAMMATE CARRIES: I support (open a passing lane / trail for rebound) =====
    const ahead = egX - (team === 'A' ? 300 : -300);
    if (bm.giveGo && mem.t < bm.giveGo.until) {
      // GIVE-AND-GO: I just gave the ball — break goal-side into space for the return,
      // but stay balanced (a modest run ahead of the carrier, not abandoning shape).
      tgt = { x: clamp(carrier.x + (egX - carrier.x) * 0.5, 120, FIELD.W - 120), y: clamp(carrier.y + (carrier.y < GY ? 180 : -180), 120, FIELD.H - 120) };
      bm.lastTrick = 'giveGo';
    } else if (isOnBall) {
      tgt = { x: carrier.x + (egX - carrier.x) * 0.35, y: GY + (p.slot === 0 ? -170 : 170) }; // close outlet
    } else {
      // move ahead to an OPEN outlet with a clear lane from the carrier
      let bestY = GY + (p.slot === 0 ? -220 : 220), bestScore = -1e9;
      for (const oy of [GY - 300, GY - 150, GY, GY + 150, GY + 300]) {
        if (laneClear(carrier.x, carrier.y, ahead, oy, state, team, { margin: 2, viewer: p })) {
          const openness = visibleEnemies.reduce((m, e) => Math.min(m, hyp(ahead - e.x, oy - e.y)), 1e9);
          const sc = openness - Math.abs(oy - p.y) * 0.2;
          if (sc > bestScore) { bestScore = sc; bestY = oy; }
        }
      }
      tgt = { x: ahead, y: bestY };
    }
    aim = { x: egX - p.x, y: GY - p.y };
    // CLEAR THE MARKER: shove a TIGHT defender off our carrier with a MEDIUM bullet.
    // charge < FULL_CHARGE(0.85) can NOT detach our own held ball, and the sim already
    // makes bullets skip teammates — so a 0.8 shot is safe friendly-fire-wise while still
    // delivering strong knockback. Attacking half only, sparingly, difficulty-gated.
    if (canShoot && sk.toolSkill > 0.6 && Math.abs(carrier.x - egX) < FIELD.W * 0.5) {
      let mark = null, md = 1e9;
      for (const e of visibleEnemies) { const d = hyp(e.x - carrier.x, e.y - carrier.y); if (d < 130 && d < md) { md = d; mark = e; } }
      if (mark && laneClear(p.x, p.y, mark.x, mark.y, state, team, { enemies: false }) && mem.t > (bm.nextMarkAt || 0)) {
        const [ax, ay] = quadraticIntercept(p.x, p.y, mark.x, mark.y, mark.vx || 0, mark.vy || 0, bulletSpeed);
        aim = { x: ax, y: ay }; shoot = true; charge = 0.8; bm.lastTrick = 'clearMarker'; bm.nextMarkAt = mem.t + 0.7;
      }
    }

  } else if (carrier) {
    // ===== ENEMY CARRIES: press (onBall) or cover (support) =====
    const c = carrier, distC = hyp(c.x - p.x, c.y - p.y);
    const seeC = botCanSee(p, c, state);
    const lane = laneClear(p.x, p.y, c.x, c.y, state, team, { enemies: false });
    if (isOnBall) {
      tgt = { x: c.x, y: c.y };
      const [ax, ay] = quadraticIntercept(p.x, p.y, c.x, c.y, c.vx || 0, c.vy || 0, bulletSpeed);
      aim = { x: ax, y: ay };
      // a FULL-charge bullet strips the ball even INSIDE the box (only knockback is cut there)
      if (canShoot && seeC && lane && distC < 430) { shoot = true; charge = 1; }
      // bomb tackle-steal: only if the blast will actually REACH the carrier at detonation
      // (predict them forward by the fuse), no teammate is caught, and the carrier isn't
      // deep in its box (reduced knockback blunts the tackle there).
      const carrierDeepInBox = inEnemyBox({ team: c.team, x: c.x, y: c.y });
      const pcx = c.x + (c.vx || 0) * BOMB.fuse, pcy = c.y + (c.vy || 0) * BOMB.fuse;
      const willReach = hyp(pcx - p.x, pcy - p.y) < BOMB_CENTER_R + BOMB.radius * 0.6;
      const mateSafe = !mate || hyp(mate.x - p.x, mate.y - p.y) > BOMB.radius + radOf(state);
      // WALL-BOMB CANNON is OPPORTUNISTIC: if a tackle plant already has a static wall behind
      // it, the sim boosts the launch automatically (wallCannonMul) — no need to obsessively
      // seek walls (that made bots abandon the press). A short nudge onto a wall-backed spot
      // is taken only when one is right beside us and we're already committing the tackle.
      if (bombReady && seeC && distC > BOMB_CENTER_R && willReach && mateSafe && mem.t > (bm.nextBombAt || 0)) {
        const [cdx, cdy] = unit(c.x - p.x, c.y - p.y);
        const cannon = sk.toolSkill >= 0.85 ? staticCannonSpot(p.x, p.y, cdx, cdy) : null; // wall-backed plant right beside us?
        const plantX = cannon ? cannon.x : p.x, plantY = cannon ? cannon.y : p.y;
        special = true; shoot = false; aim = { x: c.x - p.x, y: c.y - p.y };
        bm.bombHold = { x: plantX, y: plantY, until: mem.t + BOMB.fuse + 0.1, targetId: c.id, aimX: c.x, aimY: c.y };
        bm.nextBombAt = mem.t + 3.0; if (cannon) bm.lastTrick = 'wallCannon';
        // Signal a TWO-BOMB stack: tell a NEARBY support bot to drop a second bomb on the same
        // spot so the blasts COMBINE (bigger strip/knockback on the carrier).
        (mem.stack || (mem.stack = {}))[team] = { x: pcx, y: pcy, by: p.id, until: mem.t + BOMB.fuse * 0.7 };
      }
    } else {
      // TWO-BOMB JOIN: the presser just committed a tackle bomb — rush in and plant a SECOND
      // within the combine radius so they detonate together (a deliberate set-piece; bypasses
      // the usual mate-safety spacing). Skilled bots only.
      // Only a support bot ALREADY near the stack joins — no cross-map sprint that abandons
      // cover (that starved the ambush/mark plays). Occasional, opportunistic set-piece.
      const stk = mem.stack && mem.stack[team];
      if (stk && stk.by !== p.id && mem.t < stk.until && bombReady && sk.toolSkill >= 0.75 && !bm.bombHold
          && hyp(stk.x - p.x, stk.y - p.y) < BOMB_COMBINE_RADIUS * 1.3) {
        const dS = hyp(stk.x - p.x, stk.y - p.y);
        {
          if (dS > BOMB_COMBINE_RADIUS * 0.6) {
            return finalize(p, { x: stk.x, y: stk.y }, { x: stk.x - p.x, y: stk.y - p.y }, { shoot: false, charge: 0, special: false, build: false }, state, mem, bm, sk, dt);
          }
          bm.lastTrick = 'doubleBomb'; bm.nextBombAt = mem.t + 3.0;
          return finalize(p, { x: p.x, y: p.y }, { x: stk.x - p.x, y: stk.y - p.y }, { shoot: false, charge: 0, special: true, build: false }, state, mem, bm, sk, dt);
        }
      }
      // ===== SUPPORT cover — skilled bots run a BUSH-AMBUSH + WALL-TRAP (lurk->wall->strip) =====
      const other = enemies.find((e) => e.id !== c.id);
      const shadowX = c.x + (ogX - c.x) * 0.58, shadowY = c.y + (GY - c.y) * 0.58;
      const [w2cx, w2cy] = unit(c.x - p.x, c.y - p.y);
      // ambush only in our half AND not when the carrier is already bearing down on goal
      // (then we must cover the goal, not lurk) — prevents leaving the net open on a break.
      const defendHalf = Math.abs(c.x - ogX) < FIELD.W * 0.55 && Math.abs(c.x - ogX) > FIELD.W * 0.28;
      const ambush = (sk.toolSkill > 0.6 && defendHalf) ? chooseAmbushBush(c, ogX) : null;
      if (bm.trap && mem.t > bm.trap.until) bm.trap = null;

      if (ambush && !bm.trap && distC > 340) {
        // LURK: wait at the bush edge (hidden) facing the carrier's approach
        const [dx, dy] = unit(c.x - ambush.x, c.y - ambush.y);
        tgt = { x: ambush.x + dx * (ambush.hw - 25), y: ambush.y + dy * (ambush.hh - 25) };
        aim = { x: c.x - p.x, y: c.y - p.y }; bm.lastTrick = 'ambushLurk';
      } else if (ambush && !bm.trap && distC > 130 && distC <= 340
                 && Math.abs(p.x - ogX) < Math.abs(c.x - ogX)             // goal-side of the carrier
                 && (ogX - c.x) * (c.vx || (ogX - c.x)) >= 0              // carrier driving at our goal
                 && buildReady && mem.t > (bm.nextBuildAt || 0)) {
        // WALL across the carrier's lane to OUR goal (aim ALONG the lane => capsule spans across
        // it), then commit to the strip. Stand on the lane, goal-side of the carrier.
        const [lux, luy] = unit(ogX - c.x, GY - c.y);
        build = true; aim = { x: lux, y: luy };
        tgt = { x: c.x + lux * 150, y: c.y + luy * 150 };
        bm.trap = { until: mem.t + 1.4 }; bm.nextBuildAt = mem.t + 4.0; bm.lastTrick = 'ambushWall';
      } else if (bm.trap) {
        // STRIP: burst out and full-charge strip the wall-blocked carrier
        tgt = { x: c.x, y: c.y };
        const [ax, ay] = quadraticIntercept(p.x, p.y, c.x, c.y, c.vx || 0, c.vy || 0, bulletSpeed);
        aim = { x: ax, y: ay };
        if (canShoot && seeC && lane && distC < 430) { shoot = true; charge = 1; bm.lastTrick = 'ambushStrip'; }
      } else {
        // plain cover fallback: shadow / mark the 2nd enemy + opportunistic screen-wall or strip
        if (other && botCanSee(p, other, state)) tgt = { x: (other.x + ogX) / 2, y: (other.y + GY) / 2 };
        else { const bush = nearestBushCenter(shadowX, shadowY, 300); tgt = bush || { x: shadowX, y: shadowY }; }
        aim = { x: c.x - p.x, y: c.y - p.y };
        const liningUp = Math.abs(c.y - GY) < GOAL.width / 2 + 240 && Math.abs(c.x - ogX) < FIELD.W * 0.4;
        const goalSide = Math.abs(p.x - ogX) < Math.abs(c.x - ogX);
        if (buildReady && liningUp && goalSide && wallWouldPlace(p, w2cx, w2cy) && distC > 140 && Math.random() < 0.14) {
          build = true; aim = { x: w2cx, y: w2cy }; shoot = false; special = false;
        } else if (canShoot && seeC && lane && distC < 320) { shoot = true; charge = 1; }
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

  // SEPARATION: the off-ball bot never crowds the play — keep >= MIN_SEP from the
  // focus (carrier/ball), preserving its bearing (ahead when attacking, back when
  // defending). This is what actually kills the "both bots chase the ball".
  if (!isOnBall) {
    if (carrier) {
      // CARRIED ball: keep real spacing so we don't both crowd the carrier.
      const dx = tgt.x - carrier.x, dy = tgt.y - carrier.y, d = hyp(dx, dy), MIN_SEP = 320;
      if (d < MIN_SEP) { const [ux, uy] = unit(dx || (ogX - carrier.x), dy || (GY - carrier.y)); tgt = { x: carrier.x + ux * MIN_SEP, y: carrier.y + uy * MIN_SEP }; }
    } else {
      // LOOSE ball. Contest a 50/50 when close — UNLESS the ball is breaking fast toward
      // our goal (then stay home and defend, don't both chase). Otherwise lurk in a bush.
      const [bx, by] = predictBall(b, clamp(hyp(b.x - p.x, b.y - p.y) / 900, 0.05, 0.4));
      const myD = hyp(bx - p.x, by - p.y);
      const fastBreak = hyp(b.vx, b.vy) > 260 && (ogX - b.x) * b.vx > 0 && Math.abs(b.x - ogX) < FIELD.W * 0.5;
      if (fastBreak) tgt = { x: (b.x + ogX * 1.2) / 2.2, y: (b.y + GY) / 2 };  // stay home on a break
      else if (myD < 440) tgt = { x: bx, y: by };                              // contest the 50/50
      else { const bush = nearestBushCenter(tgt.x, tgt.y); if (bush) tgt = bush; } // lurk/ambush
    }
  }

  return finalize(p, tgt, aim, { shoot, charge, special, build }, state, mem, bm, sk, dt);
}

// Apply steering + skill (reaction latency + smoothed noisy aim), emit the input.
function finalize(p, tgt, aimVec, btn, state, mem, bm, sk, dt, opts = {}) {
  bm.wantMove = opts.hold ? 0 : 1;
  let mvx = 0, mvy = 0;
  if (opts.hold) { bm.mvx = 0; bm.mvy = 0; bm.lastX = p.x; bm.lastY = p.y; bm.stuck = 0; } // stand ON the bomb plant
  else { const s = steer(p, tgt.x, tgt.y, state, bm, sk); mvx = s[0]; mvy = s[1]; }

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
  const noise = sk.aimSigma * Math.exp(-(bm.onTgt || 0) / sk.aimTau) * seededNoise(mem.t * 9.3 + idHash(p.id) * 0.017);
  const th = bm.aimTheta + noise;
  const ax = Math.cos(th), ay = Math.sin(th);

  let { shoot, charge, special, build } = btn;
  if (opts.hold) bm.charging = null; // standing on a bomb plant — never charge a shot
  const aimConverged = Math.abs(dTheta) <= 0.45; // aim has roughly settled
  const isBallRelease = state.ball.owner === p.id;

  // ---- SIM-OWNED CHARGE RAMP: the bot must HOLD the trigger to build power,
  // exactly like a human. It commits to a wind-up when it wants to shoot, keeps
  // aiming while charging, and RELEASES (fire) once the sim-accumulated charge
  // reaches the target AND the aim has converged. Losing the ball / running the
  // mag dry / timing out cancels the wind-up (a real cancel, no shot). ----
  let hold = false, fire = false;
  if (shoot && !bm.charging) {
    // don't start a BULLET wind-up we can't finish (empty mag, not carrying)
    if (isBallRelease || p.ammo > 0) {
      bm.charging = { target: clamp(charge || 1, 0, 1), ball: isBallRelease, until: mem.t + 2.2 };
    }
  } else if (shoot && bm.charging) {
    bm.charging.target = clamp(charge || 1, 0, 1); // keep the freshest target while winding up
  }
  if (bm.charging) {
    const c = bm.charging;
    const lostBall = c.ball && state.ball.owner !== p.id;
    const dryBullet = !c.ball && p.ammo <= 0;
    if (lostBall || dryBullet || mem.t > c.until) {
      bm.charging = null; // cancel: release trigger without firing
    } else if ((p._charge || 0) >= Math.min(c.target, 1) - 0.02 && aimConverged) {
      fire = true; bm.charging = null; // wound up + on target -> release
    } else {
      hold = true; // keep charging
    }
  }

  return {
    seq: (bm.seq = (bm.seq || 0) + 1),
    moveX: mvx, moveY: mvy, aimX: ax, aimY: ay,
    hold, fire, special, build,
  };
}
