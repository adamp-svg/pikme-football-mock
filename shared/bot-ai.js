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
  FIELD, GOAL, PENALTY, BOMB, BOMB_CENTER_R, BOMB_COMBINE_RADIUS, BOMB_LOB_RANGE, BUILT_WALL, BUSH_REVEAL_DIST, VISION_RANGE, BALL_VISION,
  BALL_RADIUS, WALL_BOUNCE, WALL_RESTITUTION, FULL_CHARGE, QUICK_CHARGE, OVERCHARGE_TTL, BUILD_WINDUP,
  CHARACTERS, DEFAULT_CHAR, clamp,
} from './constants.js';
import { ARENA, pointInBox, pointInBush } from './arena.js';

const GY = FIELD.H / 2;
const PEN_TOP = (FIELD.H - PENALTY.width) / 2;
const PEN_BOT = (FIELD.H + PENALTY.width) / 2;

const enemyGoalX = (team) => (team === 'A' ? FIELD.W : 0);
const ownGoalX = (team) => (team === 'A' ? 0 : FIELD.W);

// Anti-omniscience memory (task #4): after a NON-EXTREME bot loses sight of an enemy it was
// tracking, it keeps aiming at that enemy's dead-reckoned last-seen spot for this long, then
// just holds on the stale spot (searches) — it never re-locks onto the live, unseen position.
const LOST_SIGHT_MEMORY = 0.9; // seconds of last-seen aim memory before a bot "gives up" and searches

// ---- difficulty skill vectors ----
// easy/normal/hard have HUMAN-like attributes (reaction latency + noisy aim stay in
// a human band — no superhuman reflexes, no wallhack). Difficulty scales reaction/
// aim/aggression + MECHANICAL power (`chargeRate` reach full power sooner, `cdMul`
// bomb/build back faster, `visionMul` track an open carrier further). Harder =
// sharper + stronger, not just twitchier.
//
// `aggro` scales press/shoot ranges + how soon a held ball is unloaded (wired in
// decideBot via the AGG scalar). `visionMul` widens open-carrier tracking so a bot
// doesn't lose the ball to fog mid-chase (bushed enemies stay hidden regardless).
//
// EXTREME is the sanctioned CHEAT tier (a boss fight, brutal-but-beatable): x-ray
// vision of OPEN enemies (`cheat`), instant pre-charged shots (`preCharge`), fast
// tools (cdMul), speed + overcharge (server buff + top-up). Its aim + charge are
// deliberately STOCHASTIC (see `cheatFlub`/`preCharge` gating in finalize) so it is
// NOT a robotic aimbot — it usually punishes you but occasionally slips, giving a
// skilled player a window. Bushed enemies stay hidden even to EXTREME.
export const BOT_SKILL = {
  // Buffed 2026-07-22 (bots "not strong enough"): faster reaction, tighter aim, higher charge-rate
  // (reach fire charge sooner -> shoot more, dribble less), more aggression + quicker tools + turn.
  // Kept fair: non-extreme still no wallhack (visionMul is open-carrier tracking only); only extreme cheats.
  easy:    { react: 0.26, aimSigma: 0.09,  aimTau: 0.50, turnRate: 9.0,  leadGain: 0.85, decisionHz: 10, toolSkill: 0.58, evade: 0.68, aggro: 0.86, chargeRate: 0.95, cdMul: 1.10, visionMul: 1.00 },
  normal:  { react: 0.16, aimSigma: 0.04,  aimTau: 0.24, turnRate: 16.0, leadGain: 1.00, decisionHz: 16, toolSkill: 0.85, evade: 0.92, aggro: 1.02, chargeRate: 1.25, cdMul: 0.85, visionMul: 1.10 },
  hard:    { react: 0.08, aimSigma: 0.018, aimTau: 0.16, turnRate: 26.0, leadGain: 1.05, decisionHz: 26, toolSkill: 0.97, evade: 1.00, aggro: 1.12, chargeRate: 2.05, cdMul: 0.55, visionMul: 1.90 },
  extreme: { react: 0.04, aimSigma: 0.016, aimTau: 0.13, turnRate: 38.0, leadGain: 1.15, decisionHz: 34, toolSkill: 1.00, evade: 1.00, aggro: 1.25, chargeRate: 3.40, cdMul: 0.34, visionMul: 2.20, cheat: true, preCharge: true, cheatFlub: 0.16 },
};
export const DEFAULT_SKILL = 'normal';

// ---- FLUENT skill: a 0..1 scalar interpolated across the tiers above -------------------
// t = 0 tutorial-weak, ~0.25 easy, 0.5 normal, ~0.82 hard, 1.0 extreme. Lets each SIDE of a
// match carry its own continuous difficulty (see computeBotInputs' per-team skill), so enemy
// and partner can be tuned independently and matched to game progression.
const VERY_EASY = { react: 0.5, aimSigma: 0.17, aimTau: 0.75, turnRate: 5.0, leadGain: 0.7, decisionHz: 6, toolSkill: 0.32, evade: 0.45, aggro: 0.6, chargeRate: 0.6, cdMul: 1.45, visionMul: 0.9 };
const SKILL_ANCHORS = [
  { t: 0.00, v: VERY_EASY },
  { t: 0.25, v: BOT_SKILL.easy },
  { t: 0.50, v: BOT_SKILL.normal },
  { t: 0.82, v: BOT_SKILL.hard },
  { t: 1.00, v: BOT_SKILL.extreme },
];
const SKILL_KEYS = ['react', 'aimSigma', 'aimTau', 'turnRate', 'leadGain', 'decisionHz', 'toolSkill', 'evade', 'aggro', 'chargeRate', 'cdMul', 'visionMul'];
export function skillVec(t) {
  t = Math.max(0, Math.min(1, t));
  let a = SKILL_ANCHORS[0], b = SKILL_ANCHORS[SKILL_ANCHORS.length - 1];
  for (let i = 0; i < SKILL_ANCHORS.length - 1; i++) { if (t >= SKILL_ANCHORS[i].t && t <= SKILL_ANCHORS[i + 1].t) { a = SKILL_ANCHORS[i]; b = SKILL_ANCHORS[i + 1]; break; } }
  const f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
  const out = {};
  for (const k of SKILL_KEYS) out[k] = a.v[k] + (b.v[k] - a.v[k]) * f;
  if (t >= 0.95) { out.cheat = true; out.preCharge = true; out.cheatFlub = BOT_SKILL.extreme.cheatFlub; } // top of the ladder gets the cheat tier
  return out;
}
// Resolve the skill vector a TEAM's bots should use. Priority: per-team numeric scalar
// (mem.teamSkill[team]) → whole-mem numeric scalar (mem.skill) → legacy string tier.
function memSkillVec(mem, team) {
  if (mem.teamSkill && typeof mem.teamSkill[team] === 'number') return skillVec(mem.teamSkill[team]);
  if (typeof mem.skill === 'number') return skillVec(mem.skill);
  return BOT_SKILL[mem.skill] || BOT_SKILL[DEFAULT_SKILL];
}

export function createBotMemory(skill = DEFAULT_SKILL) {
  // teamSkill (set by the server per match) overrides `skill` when present: { A: 0..1, B: 0..1 }.
  return { skill, teamSkill: null, t: 0, teams: { A: null, B: null }, bots: {} };
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

// TACTIC 5 — PREDICT where the target is going and aim there. Scales the target's velocity by
// the tier's leadGain (was a DEAD knob): easy 0.80 under-leads (misses a fast human), normal
// 0.95, hard 1.00 true intercept, extreme 1.10 slight over-lead. leadGain IS the difficulty gate
// (aim vector only — never changes the shoot/charge decision, so low tiers stay beatable).
function leadAim(sx, sy, tx, ty, tvx, tvy, ps, sk) {
  const g = (sk && sk.leadGain != null) ? sk.leadGain : 1;
  return quadraticIntercept(sx, sy, tx, ty, (tvx || 0) * g, (tvy || 0) * g, ps);
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

// ---- INDESTRUCTIBLE line-of-sight (task #5): does a STATIC stone wall block the straight
// segment (x0,y0)->(x1,y1)? Used to VETO a shot/tackle aimed AT an enemy sitting behind stone —
// a bullet or rocket-jump can't reach through an indestructible wall. Player-BUILT (destructible)
// walls are intentionally IGNORED here: the sim lets shots chip/kill those, so they must NOT
// suppress the attempt (that stays "per existing behavior", handled by laneClear elsewhere).
// Step count scales with length so a ~120px wall is never stepped over on a long line. ----
function indestructibleBlocks(x0, y0, x1, y1) {
  const steps = Math.max(6, Math.ceil(hyp(x1 - x0, y1 - y0) / 40));
  for (let i = 1; i <= steps; i++) {
    const x = x0 + (x1 - x0) * i / steps, y = y0 + (y1 - y0) * i / steps;
    for (const w of ARENA.walls) if (pointInBox(x, y, w)) return true;
  }
  return false;
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
export function botCanSee(viewer, target, state, sk) {
  if (viewer.team === target.team) return true;          // teammates always
  const dist = hyp(viewer.x - target.x, viewer.y - target.y);
  const inBush = pointInBush(target.x, target.y);
  // EXTREME CHEAT (x-ray): an OPEN enemy is seen anywhere on the pitch, ignoring fog.
  // CRITICAL: a BUSHED enemy stays hidden even to EXTREME — cover still works.
  if (sk && sk.cheat && !inBush) return true;
  const vMul = (sk && sk.visionMul) || 1;
  // The ball-carrier is the tracked objective — seen at a longer (tier-scaled) range so
  // bots keep pressing instead of losing it to fog mid-chase. BUT a carrier hiding IN A
  // BUSH stays concealed (falls to the bush rules below) — carrying in a bush is safe.
  if (state.ball.owner === target.id && !inBush && dist <= BALL_VISION * vMul) return true;
  if (dist > VISION_RANGE * vMul) return false;          // an OFF-ball enemy out of view — no seeing across the field
  if (!inBush) return true;                              // in the open (and in view) = seen
  if (target.firing) return true;                        // muzzle flash reveals
  if (dist < BUSH_REVEAL_DIST) return true;              // close enough to spot in the bush
  return false;                                          // off-ball, bushed, not close, not firing = HIDDEN
}

// ---- PER-BOT PERCEPTION MEMORY (task #4): where may THIS bot AIM at an enemy it is tracking? ----
// A NON-EXTREME bot must not perceive a player it can't see. While the enemy is in sight
// (`canSee`, which already bakes in tier VISION_RANGE/BALL_VISION), track it live and remember
// {pos, vel, when}. After sight is lost, dead-reckon that last-seen point forward for
// LOST_SIGHT_MEMORY seconds, then FREEZE on the spot (the bot searches where it vanished) — it
// never snaps back onto the live position. Returns null if this bot has no memory of the target
// at all (callers then simply don't aim at it). EXTREME (`sk.cheat`) always tracks live, exactly
// as before — its sanctioned x-ray of OPEN enemies is left intact (bushed foes still fail
// `canSee`, so the SHOT gate keeps them safe from EXTREME too).
function perceivedPos(bm, tgt, canSee, sk, mem) {
  if (canSee || (sk && sk.cheat)) {
    bm.seen = { id: tgt.id, x: tgt.x, y: tgt.y, vx: tgt.vx || 0, vy: tgt.vy || 0, t: mem.t };
    return { x: tgt.x, y: tgt.y, vx: tgt.vx || 0, vy: tgt.vy || 0, live: true };
  }
  const s = bm.seen;
  if (!s || s.id !== tgt.id) return null;                 // no memory of THIS enemy — don't reveal it
  const adv = clamp(mem.t - s.t, 0, LOST_SIGHT_MEMORY);   // dead-reckon during the window, then freeze
  return { x: s.x + s.vx * adv, y: s.y + s.vy * adv, vx: s.vx, vy: s.vy, live: false };
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
  const sk = memSkillVec(mem, team);
  const bots = Object.values(state.players).filter((p) => p.team === team && p.isBot);
  let visible;
  if (b.owner) {
    const owner = state.players[b.owner];
    if (!owner || owner.team === team) visible = true;                 // we hold it (or stale owner)
    else visible = bots.some((bt) => botCanSee(bt, owner, state, sk));  // enemy carrier — only if in sight (tier vision)
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
    reactUntil: 0, sitHash: '', decideAt: 0, action: null, bombHold: null, buildHold: null,
  });
}
// Read-only accessor for the measurement harness / tests (never creates state).
export function bmemForTest(mem, id) { return (mem.bots && mem.bots[id]) || {}; }

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
  const out = {};
  const teams = opts.onlyTeam ? [opts.onlyTeam] : ['A', 'B'];
  for (const team of teams) assignRoles(state, team, mem, dt);

  for (const team of teams) {
    const role = mem.teams[team];
    if (!role) continue;
    const sk = memSkillVec(mem, team); // per-team difficulty (enemy vs partner may differ)
    for (const p of Object.values(state.players)) {
      if (p.team !== team || !p.isBot) continue;
      // difficulty as mechanical power: harder bots charge full sooner + cool down faster
      p.chargeRate = sk.chargeRate != null ? sk.chargeRate : 1;
      p.cdMul = sk.cdMul != null ? sk.cdMul : 1;
      // EXTREME cheat: keep overcharge topped up so it can break a keeper / blast a lane at
      // will (a steady cheat — the STOCHASTIC part is its aim + charge, not this).
      if (sk.cheat && !p.power) { p.power = true; p.powerT = OVERCHARGE_TTL; }
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
  bm.lastTrick = null; // reset each tick — it's a per-tick behaviour tag, not sticky state
                       // (histogramming a sticky tag over-counted ~9x and hid the real behaviour)
  const b = state.ball;
  const team = p.team, egX = enemyGoalX(team), ogX = ownGoalX(team);
  const isOnBall = role.onBall === p.id;
  const mate = state.players[isOnBall ? role.support : role.onBall];
  const enemies = Object.values(state.players).filter((q) => q.team !== team);
  const visibleEnemies = enemies.filter((e) => botCanSee(p, e, state, sk)); // sk => tier vision / x-ray
  const canShoot = p.ammo > 0 && (p.reloadLock || 0) <= 0 && (p.shootCd || 0) <= 0;
  const bombReady = (p.specialCd || 0) <= 0;
  const buildReady = p.buildAmmo >= 1 && (p.buildCd || 0) <= 0;
  const settings = state.settings;
  const bulletSpeed = settings.bulletSpeed || 720;

  // AGGRESSION scalar (was a DEAD knob — this is a big part of "hard used to be harder").
  // Higher aggro = press sooner + shoot from further + unload a held ball quicker. Base +
  // coefficient are calibrated so easy/normal land NEAR the old fixed 430/320/780 gates and
  // the ladder stays monotonic (easy least aggressive → extreme most).
  const AGG = sk.aggro != null ? sk.aggro : 0.9;
  const PRESS_RANGE  = 160 + 300 * AGG; // enemy-carrier strip range (easy~400 / normal~436 / hard 460 / extreme~505)
  const COVER_STRIP  = 120 + 200 * AGG; // plain-cover strip range   (easy~280 / normal~304 / hard 320 / extreme~350)
  const FINISH_RANGE = 560 + 220 * AGG; // carrier shot-on-goal range (easy~736 / normal~762 / hard 780 / extreme~813)
  const LINEUP_PAD   = 180 + 100 * AGG; // how far off-axis a carrier still tries the drive-finish
  const CARRY_IDLE   = 0.9 - 0.5 * AGG; // seconds holding before the anti-idle blast — lower = finish sooner, dribble less (buffed 2026-07-22: hard ~0.34 / normal ~0.39 / easy ~0.47)

  // target point to move toward, plus button intents (decided at decisionHz)
  let tgt = { x: p.x, y: p.y };
  let aim = { x: p.aimX, y: p.aimY };
  let shoot = false, charge = 0, special = false, build = false, closeShot = false;

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
    // ANTI-FREEZE: a whiffed tackle used to freeze the bot ON the plant for the whole ~1.25s
    // fuse (measured ~9k frozen ticks/match, nearly all with a carrier within 430px). If the
    // target has driven OUT of blast reach, abort the hold and go re-press (the bomb still
    // detonates on its own). Otherwise EDGE toward the target — a moving planter still
    // rocket-jump-tackles as long as it stays within BOMB_CENTER_R of the plant.
    if (tp && hyp(tp.x - bm.bombHold.x, tp.y - bm.bombHold.y) > BOMB_CENTER_R + BOMB.radius + 120) {
      bm.bombHold = null; // fall through to a fresh decision below
    } else {
      bm.charging = null;
      const [ex, ey] = unit(gx - bm.bombHold.x, gy - bm.bombHold.y);
      const holdTgt = { x: bm.bombHold.x + ex * BOMB_CENTER_R * 0.55, y: bm.bombHold.y + ey * BOMB_CENTER_R * 0.55 };
      return finalize(p, holdTgt, aim, { shoot: false, charge: 0, special: false, build: false }, state, mem, bm, sk, dt);
    }
  } else if (bm.bombHold) bm.bombHold = null;

  const carrier = b.owner ? state.players[b.owner] : null;
  if (b.owner !== p.id) bm.carryT = 0; // reset carry stall timer when not holding

  // --- FOG OF WAR: if the team can't SEE the ball/carrier (enemy hid in a bush or slipped
  // out of view), converge on the LAST-SEEN spot and search — never laser-track a hidden
  // or off-screen enemy. We re-acquire the instant a bot gets eyes on them again. ---
  const belief = role.belief || { x: b.x, y: b.y, visible: true };
  if (!belief.visible && b.owner !== p.id) {
    // FLICKER GRACE: only abandon a committed wind-up after a REAL loss (>0.35s), not a
    // one-frame view clip (a defender jittering through a bush / carrier at the view edge).
    bm.blindT = (bm.blindT || 0) + dt;
    if (bm.blindT > 0.35) bm.charging = null;
    // ACTIVE SEARCH — never park. When the loss is FRESH (<0.7s) the dead-reckoned point is
    // still accurate, so SPRINT STRAIGHT AT IT (the diagnosis found ~25-28% of search ticks
    // were orbiting a point that was only ~370px off — pure wasted "roam"). Only once truly
    // blind (>=0.7s) fall back to a TIGHT probe-sweep (shrunk by aggro), never a lazy circle.
    let tgt;
    if (isOnBall) {
      // The belief dead-reckons the carrier's run forward up to age 1.2s, so DRIVING STRAIGHT
      // at that point is productive for the whole window — only once it's stale (>=1.2s) do we
      // fall back to a TIGHT probe-sweep (shrunk by aggro). This is what stops the "wait and
      // roam around a bit" orbit while the point is still a good guess.
      if (bm.blindT < 1.2) {
        tgt = { x: belief.x, y: belief.y };
      } else {
        const sweepR = clamp(bm.blindT - 1.2, 0, 1.5) / 1.5 * (280 - 150 * AGG);
        const th = mem.t * 2.2 + idHash(p.id) * 0.01;
        tgt = { x: belief.x + Math.cos(th) * sweepR, y: belief.y + Math.sin(th) * sweepR };
      }
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

  // TACTIC 11 — CORNER-PINNED BOMB ESCAPE (all tiers; harder bots trigger sooner). When we're
  // wedged in a corner scrapping for the ball with an enemy right on us, plant a bomb at our feet
  // and rocket-jump loose (a carried ball stays attached; the point-blank enemy gets flung too).
  {
    const stuckLim = sk.toolSkill >= 0.9 ? 5 : 9;
    const nearCorner = (p.x < 300 || p.x > FIELD.W - 300) && (p.y < 260 || p.y > FIELD.H - 260);
    let foeNear = 1e9; for (const e of visibleEnemies) foeNear = Math.min(foeNear, hyp(e.x - p.x, e.y - p.y));
    if ((bm.stuck || 0) > stuckLim && nearCorner && foeNear < 170 && hyp(b.x - p.x, b.y - p.y) < 220
        && (p.specialCd || 0) <= 0 && mem.t > (bm.nextBombAt || 0)) {
      const [ex, ey] = unit(FIELD.W / 2 - p.x, GY - p.y);   // rocket toward the open pitch centre
      bm.bombHold = { x: p.x, y: p.y, until: mem.t + BOMB.fuse + 0.1, aimX: p.x + ex * 400, aimY: p.y + ey * 400 };
      bm.nextBombAt = mem.t + 3.0 * (sk.cdMul || 1); bm.stuck = 0; bm.lastTrick = 'cornerEscape';
      return finalize(p, { x: p.x, y: p.y }, { x: ex, y: ey }, { shoot: false, charge: 0, special: true, build: false }, state, mem, bm, sk, dt);
    }
  }

  if (b.owner === p.id) {
    // ===== I CARRY: attack =====
    bm.carryT = (bm.carryT || 0) + dt;
    const distGoal = hyp(egX - p.x, GY - p.y);
    let nearFoe = null, nfd = 1e9;
    for (const e of visibleEnemies) { const d = hyp(e.x - p.x, e.y - p.y); if (d < nfd) { nfd = d; nearFoe = e; } }
    const linedUp = Math.abs(p.y - GY) < GOAL.width / 2 + LINEUP_PAD;
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

    // TACTIC 2 (shooter side) — if a mate has set up a DEFLECT wall (mem.setPiece) and we have a
    // clear lane to it, shoot FULL at the wall so the ball banks off it into the net.
    const sp = mem.setPiece && mem.setPiece[team];
    if (!shoot && sp && sp.by !== p.id && mem.t < sp.until
        && laneClear(p.x, p.y, sp.x, sp.y, state, team, { enemies: false })) {
      aim = { x: sp.x - p.x, y: sp.y - p.y }; shoot = true; charge = 1; bm.lastTrick = 'deflectShot';
      mem.setPiece[team] = null;
    }

    // 1) FINISH — a FULL kick now DRIVES THROUGH any field defender (monotonic), so just
    //    shoot on a walls-clear lane. Only a KEEPER-in-box catches it: then spend OVERCHARGE
    //    to break through (if ready), else BANK around them, else fall through to pass/drive.
    if (!shoot && distGoal < FINISH_RANGE && linedUp && laneWalls && !keeper) {
      aim = { x: egX - p.x, y: GY - p.y }; shoot = true; charge = 1; bm.lastTrick = 'drive';
      if (distGoal < 260) closeShot = true;
    } else if (distGoal < FINISH_RANGE + 40 && linedUp && keeper) {
      if (p.power) { aim = { x: egX - p.x, y: GY - p.y }; shoot = true; charge = 1; bm.lastTrick = 'overFinish'; } // overcharge beats the save
      else {
        // No overcharge: don't dither (the diagnosis found a carrier vs an in-box keeper stalled
        // 100% of the time — goalBank returned null 100% too). Aim the FULL drive at the OPEN
        // goal-mouth corner AWAY from the keeper — the sim only SAVES a kick that hits the
        // keeper body, so a corner past a stationary keeper scores. TACTIC 5b: PREDICT the
        // keeper's slide (lead its vy) and pick the corner it is moving AWAY from.
        const leadT = clamp(distGoal / ((settings.shotPower || 1850) * 0.9), 0, 0.6);
        const kyFut = keeper.y + (keeper.vy || 0) * leadT * (sk.leadGain || 1);
        const cornerY = kyFut > GY ? GY - GOAL.width * 0.30 : GY + GOAL.width * 0.30;
        if (Math.abs(kyFut - cornerY) > radOf(state) + ballR + 12) {
          aim = { x: egX - p.x, y: cornerY - p.y }; shoot = true; charge = 1; bm.lastTrick = 'cornerFinish';
          if (distGoal < 300) closeShot = true;
        } else if (trick >= 0.7) { // corner covered → try a bank as a last resort
          const bk = bankAim(b.x, b.y, egX, clamp(GY + (keeper.y < GY ? 90 : -90), 420, 680), state, team, { goal: true, maxPath: 560 + 300 * trick, viewer: p });
          if (bk) { aim = { x: bk.aimX, y: bk.aimY }; shoot = true; charge = 1; bm.lastTrick = 'goalBank'; }
        }
      }
    }

    // 2) marked & not shooting -> PASS to a better mate (direct, or BANK around a blocker); sets give-and-go
    if (!shoot && mate && nfd < 260) {
      const mateBetter = hyp(egX - mate.x, GY - mate.y) < distGoal - 30;
      if (mateBetter) {
        const full = settings.shotPower || 1850;
        if (laneClear(p.x, p.y, mate.x, mate.y, state, team, { margin: 4, viewer: p })) {
          charge = clamp(hyp(mate.x - p.x, mate.y - p.y) / 950, 0.4, 0.85);
          const [pax, pay] = leadAim(p.x, p.y, mate.x, mate.y, mate.vx || 0, mate.vy || 0, full * clamp(charge, 0.33, 1), sk);
          aim = { x: pax, y: pay }; shoot = true; bm.giveGo = { until: mem.t + 1.0 };
        } else if (trick > 0.6) {
          const bk = bankAim(b.x, b.y, mate.x + (mate.vx || 0) * 0.25, mate.y + (mate.vy || 0) * 0.25, state, team, { goal: false, maxPath: 560 + 260 * trick, viewer: p });
          if (bk) { aim = { x: bk.aimX, y: bk.aimY }; shoot = true; charge = 1; bm.lastTrick = 'passBank'; bm.giveGo = { until: mem.t + 1.0 }; }
        }
      }
    }

    // (The old "cornered bomb-finish" was removed: it scored 0-for-~30 — the reduced carry
    // launch can't put the ball in the net — while burning a bomb charge worth far more on a
    // ~97% off-centre tackle-steal. TACTIC 4 below reuses the bomb for MOBILITY instead.)

    // TACTIC 4 — CARRY ROCKET-JUMP for MOBILITY (hard/extreme). Far from goal with a clear lane
    // and no enemy near, plant a bomb at our feet aimed at goal and rocket-jump forward: the ball
    // stays attached and we cover ground fast (bombs now launch further). nfd>520 + laneWalls keep
    // the fuse-hold safe so the reduced carry-launch still buys real distance.
    if (!shoot && !special && sk.toolSkill >= 0.9 && bombReady && distGoal > FINISH_RANGE + 220
        && laneWalls && nfd > 520 && mateSafe && mem.t > (bm.nextBombAt || 0)) {
      special = true; aim = { x: egX - p.x, y: GY - p.y };
      bm.bombHold = { x: p.x, y: p.y, until: mem.t + BOMB.fuse + 0.1, aimX: egX, aimY: GY };
      bm.nextBombAt = mem.t + 3.0 * (sk.cdMul || 1); bm.lastTrick = 'carryJump';
    }

    // Anti-idle: blast goalward if we've dithered (delay scales with aggro). A full kick drives
    // through a FIELD defender; if a KEEPER is parked, aim at the open corner past them rather
    // than feeding the save — either way the carrier RELEASES instead of running in circles.
    if (!shoot && !special && bm.carryT > CARRY_IDLE && laneWalls && distGoal < 1150) {
      const ay = keeper ? (keeper.y > GY ? GY - GOAL.width * 0.30 : GY + GOAL.width * 0.30) : GY;
      aim = { x: egX - p.x, y: ay - p.y }; shoot = true; charge = 1; bm.carryT = 0;
      if (distGoal < 300) closeShot = true;
    }
    // Drive at goal; if marked, ZIGZAG (TACTIC 6): weave a serpentine path around the goalward
    // vector to shake a chaser, instead of a readable straight line or one fixed juke. Amplitude
    // scales with skill, flip-rate with aggro. Still always ADVANCES toward goal.
    tgt = { x: egX, y: GY };
    if (nearFoe && nfd < 300) {
      const [gx, gy] = unit(egX - p.x, GY - p.y);
      let perpx = -gy, perpy = gx;
      // start the weave toward the MORE-OPEN side (away from the marker), then oscillate
      if ((nearFoe.x - p.x) * perpx + (nearFoe.y - p.y) * perpy > 0) { perpx = -perpx; perpy = -perpy; }
      const ZIG_PERIOD = 0.45 - 0.15 * AGG;                 // hard flips faster
      if (bm.zigSign == null || mem.t - (bm.zigAt || 0) > ZIG_PERIOD) { bm.zigSign = (bm.zigSign || 1) * -1; bm.zigAt = mem.t; }
      const amp = 140 + 200 * sk.toolSkill;                 // hard weaves wider
      tgt = { x: p.x + gx * 240 + perpx * amp * bm.zigSign, y: p.y + gy * 240 + perpy * amp * bm.zigSign };
      bm.lastTrick = 'zigzag';
    }
    if (!shoot && !special) aim = { x: egX - p.x, y: GY - p.y };

  } else if (carrier && carrier.team === team) {
    // ===== TEAMMATE CARRIES: I support (open a passing lane / trail for rebound) =====
    const ahead = egX - (team === 'A' ? 300 : -300);
    // TACTIC 9 — OFF-BALL CATCH-UP ROCKET-JUMP (hard/extreme): if we're lagging far behind the
    // play with a clear lane and no enemy on us, plant a bomb and rocket-jump toward the play so
    // the teammate isn't left alone (directly counters "the bot lags/hides instead of helping").
    if (!isOnBall && sk.toolSkill >= 0.9 && bombReady && mem.t > (bm.nextBombAt || 0)) {
      const dPlay = hyp(carrier.x - p.x, carrier.y - p.y);
      const foeNear = visibleEnemies.reduce((m, e) => Math.min(m, hyp(e.x - p.x, e.y - p.y)), 1e9);
      if (dPlay > 760 && foeNear > 300 && laneClear(p.x, p.y, carrier.x, carrier.y, state, team, { enemies: false })) {
        const [ex, ey] = unit(carrier.x - p.x, carrier.y - p.y);
        bm.bombHold = { x: p.x, y: p.y, until: mem.t + BOMB.fuse + 0.1, aimX: p.x + ex * 500, aimY: p.y + ey * 500 };
        bm.nextBombAt = mem.t + 3.0 * (sk.cdMul || 1); bm.lastTrick = 'catchUpJump';
        return finalize(p, { x: p.x, y: p.y }, { x: ex, y: ey }, { shoot: false, charge: 0, special: true, build: false }, state, mem, bm, sk, dt);
      }
    }
    // TACTIC 2 — COORDINATED DEFLECT SET-PIECE (hard/extreme). When our carrier is near the
    // enemy goal but a DIRECT finish is blocked, the support bot builds an ANGLED wall just
    // outside the enemy box, angled as a MIRROR so a shot from the carrier BANKS off it into the
    // net, then signals the carrier (mem.setPiece) to shoot at the wall. Mirror normal bisects
    // (wall->carrier) and (wall->goal): n = unit( unit(G-W) - unit(W-C) ). Built OUTSIDE the box
    // + bushes so it's a solid hp3 wall the shot can bank off.
    const spLive = mem.setPiece && mem.setPiece[team];
    if (!isOnBall && sk.toolSkill >= 0.8 && buildReady && !bm.buildHold && !spLive && mem.t > (bm.nextBuildAt || 0)) {
      const distCG = hyp(egX - carrier.x, GY - carrier.y);
      const blocked = visibleEnemies.some((e) => Math.abs(e.x - egX) < PENALTY.depth + 40 && Math.abs(e.y - GY) < GOAL.width / 2 + 60);
      if (distCG < 760 && distCG > 240 && blocked) {
        const dirToGoal = egX > FIELD.W / 2 ? 1 : -1;
        const Wx = egX - dirToGoal * (PENALTY.depth + 34);
        const Wy = clamp(GY + (carrier.y > GY ? 150 : -150), 160, FIELD.H - 160);
        const [inx, iny] = unit(Wx - carrier.x, Wy - carrier.y); // incoming travel dir C->W
        const [gx2, gy2] = unit(egX - Wx, GY - Wy);              // desired out dir W->goal
        const [nx, ny] = unit(gx2 - inx, gy2 - iny);             // mirror normal (face normal = build aim)
        const standX = Wx - nx * BUILT_WALL.offset, standY = Wy - ny * BUILT_WALL.offset;
        if (!pointInBush(Wx, Wy) && Math.abs(Wx - egX) > PENALTY.depth + 8) {
          if (hyp(p.x - standX, p.y - standY) < 46) {
            if (!bm.buildHold) bm.buildHold = { x: nx, y: ny, until: mem.t + BUILD_WINDUP + 0.1 };
            aim = { x: nx, y: ny };
            bm.nextBuildAt = mem.t + 8.0 * (sk.cdMul || 1); bm.lastTrick = 'deflectSetup';
            (mem.setPiece || (mem.setPiece = {}))[team] = { x: Wx, y: Wy, by: p.id, until: mem.t + 3.0 };
            return finalize(p, { x: standX, y: standY }, aim, { shoot: false, charge: 0, special: false, build: false }, state, mem, bm, sk, dt);
          }
          tgt = { x: standX, y: standY };                        // walk onto the build spot first
          aim = { x: nx, y: ny };
          return finalize(p, tgt, aim, { shoot: false, charge: 0, special: false, build: false }, state, mem, bm, sk, dt);
        }
      }
    }
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
      // TACTIC 10 — COOPERATIVE PUSH (hard/extreme): rocket-jump into the open attacking outlet so
      // the carrier can hit a fast one-two (the pass arrives via the pass-to-mate logic below). We
      // signal mem.push so the carrier prioritises the pass. A bomb-jump into space, no enemy near.
      if (sk.toolSkill >= 0.85 && bombReady && mem.t > (bm.nextBombAt || 0)) {
        const dOut = hyp(ahead - p.x, bestY - p.y);
        const foeNear = visibleEnemies.reduce((m, e) => Math.min(m, hyp(ahead - e.x, bestY - e.y)), 1e9);
        if (dOut > 620 && foeNear > 260 && laneClear(p.x, p.y, ahead, bestY, state, team, { enemies: false })) {
          const [ex, ey] = unit(ahead - p.x, bestY - p.y);
          bm.bombHold = { x: p.x, y: p.y, until: mem.t + BOMB.fuse + 0.1, aimX: p.x + ex * 500, aimY: p.y + ey * 500 };
          bm.nextBombAt = mem.t + 3.0 * (sk.cdMul || 1); bm.lastTrick = 'coopPush';
          (mem.push || (mem.push = {}))[team] = { x: ahead, y: bestY, by: p.id, until: mem.t + 2.4 };
          return finalize(p, { x: p.x, y: p.y }, { x: ex, y: ey }, { shoot: false, charge: 0, special: true, build: false }, state, mem, bm, sk, dt);
        }
      }
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
        const [ax, ay] = leadAim(p.x, p.y, mark.x, mark.y, mark.vx || 0, mark.vy || 0, bulletSpeed, sk);
        aim = { x: ax, y: ay }; shoot = true; charge = 0.8; bm.lastTrick = 'clearMarker'; bm.nextMarkAt = mem.t + 0.7 * (sk.cdMul || 1); if (md < 160) closeShot = true;
      }
    }

  } else if (carrier) {
    // ===== ENEMY CARRIES: press (onBall) or cover (support) =====
    const c = carrier, distC = hyp(c.x - p.x, c.y - p.y);
    const seeC = botCanSee(p, c, state, sk);
    // Anti-omniscience (non-EXTREME): only AIM at the carrier while THIS bot can actually see it;
    // after losing sight, aim at its dead-reckoned last-seen spot briefly, then search there —
    // never swing the reticle onto a live position it can't see. `tgt` still chases the ball (the
    // shared objective / belief) exactly as before. EXTREME keeps its live x-ray aim.
    const pc = perceivedPos(bm, c, seeC, sk, mem);
    const lane = laneClear(p.x, p.y, c.x, c.y, state, team, { enemies: false });
    if (isOnBall) {
      tgt = { x: c.x, y: c.y };
      if (pc) {
        const [ax, ay] = leadAim(p.x, p.y, pc.x, pc.y, pc.vx, pc.vy, bulletSpeed, sk);
        aim = { x: ax, y: ay };
      }
      // a FULL-charge bullet strips the ball even INSIDE the box (only knockback is cut there)
      if (canShoot && seeC && lane && distC < PRESS_RANGE) { shoot = true; charge = 1; if (distC < 260) closeShot = true; }
      // bomb tackle-steal: only if the blast will actually REACH the carrier at detonation
      // (predict them forward by the fuse), no teammate is caught, and the carrier isn't
      // deep in its box (reduced knockback blunts the tackle there).
      const carrierDeepInBox = inEnemyBox({ team: c.team, x: c.x, y: c.y });
      const pcx = c.x + (c.vx || 0) * BOMB.fuse, pcy = c.y + (c.vy || 0) * BOMB.fuse;
      const willReach = hyp(pcx - p.x, pcy - p.y) < BOMB_CENTER_R + BOMB.radius * 0.6;
      const mateSafe = !mate || hyp(mate.x - p.x, mate.y - p.y) > BOMB.radius + radOf(state);
      // TACKLE-STEAL = plant at our FEET (off-centre) so the blast strips the carrier and we
      // scramble onto the loose ball (~97% success). The old "wall-cannon nudge" relocated the
      // plant onto a wall-backed ON-CENTRE spot, which rocket-jumped the planter AWAY from the
      // loose ball (0% steal on hard) — that was the direct cause of hard playing no better than
      // normal. Removed. A bullet strip is still PREFERRED when available (never override a live
      // strip or abort an in-progress wind-up — that froze the bot on the plant).
      if (!shoot && !bm.charging && bombReady && seeC && distC > BOMB_CENTER_R && willReach && mateSafe
          && !indestructibleBlocks(p.x, p.y, c.x, c.y) && mem.t > (bm.nextBombAt || 0)) {
        special = true; shoot = false; aim = { x: c.x - p.x, y: c.y - p.y };
        bm.bombHold = { x: p.x, y: p.y, until: mem.t + BOMB.fuse + 0.1, targetId: c.id, aimX: c.x, aimY: c.y };
        bm.nextBombAt = mem.t + 3.0 * (sk.cdMul || 1); bm.lastTrick = 'bombTackle';
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
          bm.lastTrick = 'doubleBomb'; bm.nextBombAt = mem.t + 3.0 * (sk.cdMul || 1);
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
        if (pc) aim = { x: pc.x - p.x, y: pc.y - p.y }; bm.lastTrick = 'ambushLurk';
      } else if ((ambush || (seeC && sk.toolSkill > 0.55)) && !bm.trap && distC > 130 && distC <= 380
                 && Math.abs(p.x - ogX) < Math.abs(c.x - ogX)             // goal-side of the carrier
                 && (ogX - c.x) * (c.vx || (ogX - c.x)) >= 0              // carrier driving at our goal
                 && buildReady && mem.t > (bm.nextBuildAt || 0)) {
        // TACTIC 3 — WALL to STOP a driving carrier (works with OR without a bush ambush). Build
        // a capsule ACROSS the carrier's lane to OUR goal (aim ALONG the lane => capsule spans it),
        // then burst out and strip. Stand on the lane, goal-side of the carrier.
        const [lux, luy] = unit(ogX - c.x, GY - c.y);
        // Windup model: HOLD buildHold for BUILD_WINDUP before the build edge actually
        // commits a wall (a bare build:true edge is now a no-op — see sim.js buildWindup).
        // Only ARM the deadline once — this branch keeps re-selecting itself every tick
        // while the trap is still live, and re-stamping `until` from `mem.t` each time
        // would perpetually push completion out of reach.
        if (!bm.buildHold) bm.buildHold = { x: lux, y: luy, until: mem.t + BUILD_WINDUP + 0.1 };
        aim = { x: lux, y: luy };
        tgt = { x: c.x + lux * 150, y: c.y + luy * 150 };
        bm.trap = { until: mem.t + 1.4 }; bm.nextBuildAt = mem.t + 4.0 * (sk.cdMul || 1); bm.lastTrick = ambush ? 'ambushWall' : 'blockDrive';
      } else if (bm.trap) {
        // STRIP/STEAL (TACTIC 8): burst out and full-charge strip the wall-blocked carrier;
        // if no bullet is available, plant a bomb-tackle to STEAL instead (the bush hid us — now
        // we strike). Prefer the bullet (never override a live strip with a bomb).
        tgt = { x: c.x, y: c.y };
        if (pc) {
          const [ax, ay] = leadAim(p.x, p.y, pc.x, pc.y, pc.vx, pc.vy, bulletSpeed, sk);
          aim = { x: ax, y: ay };
        }
        if (canShoot && seeC && lane && distC < PRESS_RANGE) { shoot = true; charge = 1; bm.lastTrick = 'ambushStrip'; if (distC < 260) closeShot = true; }
        else if (!shoot && !bm.charging && bombReady && seeC && distC > BOMB_CENTER_R
                 && (!mate || hyp(mate.x - p.x, mate.y - p.y) > BOMB.radius + radOf(state))
                 && distC < BOMB_CENTER_R + BOMB.radius && mem.t > (bm.nextBombAt || 0)) {
          special = true; aim = { x: c.x - p.x, y: c.y - p.y };
          bm.bombHold = { x: p.x, y: p.y, until: mem.t + BOMB.fuse + 0.1, targetId: c.id, aimX: c.x, aimY: c.y };
          bm.nextBombAt = mem.t + 3.0 * (sk.cdMul || 1); bm.lastTrick = 'bushSteal';
        }
      } else {
        // plain cover fallback: shadow / mark the 2nd enemy + opportunistic screen-wall or strip
        if (other && botCanSee(p, other, state, sk)) tgt = { x: (other.x + ogX) / 2, y: (other.y + GY) / 2 };
        else { const bush = nearestBushCenter(shadowX, shadowY, 300); tgt = bush || { x: shadowX, y: shadowY }; }
        if (pc) aim = { x: pc.x - p.x, y: pc.y - p.y };
        const liningUp = Math.abs(c.y - GY) < GOAL.width / 2 + 240 && Math.abs(c.x - ogX) < FIELD.W * 0.4;
        const goalSide = Math.abs(p.x - ogX) < Math.abs(c.x - ogX);
        // TACTIC 1 — DEFENSIVE GOAL-SCREEN: build a VERTICAL wall across our goal mouth, just
        // OUTSIDE the box (so it's a solid hp3 wall, never a fragile in-box one). Aim horizontal
        // => capsule spans vertically across the mouth. Move onto the plane first, then build.
        const sign = ogX === 0 ? 1 : -1;
        const planeX = ogX + sign * (PENALTY.depth + 20);
        const screenY = clamp(GY + (c.y - GY) * 0.45, GY - GOAL.width / 2, GY + GOAL.width / 2);
        const screenSpot = { x: planeX - sign * BUILT_WALL.offset, y: screenY };
        const noScreenYet = !state.builtWalls.some((w) => Math.abs((w.cx != null ? w.cx : w.x) - planeX) < 130 && Math.abs((w.cy != null ? w.cy : w.y) - GY) < GOAL.width / 2 + 50);
        if (sk.toolSkill > 0.6 && buildReady && liningUp && goalSide && noScreenYet && mem.t > (bm.nextBuildAt || 0)) {
          tgt = screenSpot;
          if (hyp(p.x - screenSpot.x, p.y - screenSpot.y) < 85) { // near the plane -> raise the screen
            if (!bm.buildHold) bm.buildHold = { x: sign, y: 0, until: mem.t + BUILD_WINDUP + 0.1 };
            aim = { x: sign, y: 0 }; shoot = false; special = false;
            bm.nextBuildAt = mem.t + 8.0 * (sk.cdMul || 1); bm.lastTrick = 'goalScreen';
          }
        } else if (buildReady && liningUp && goalSide && wallWouldPlace(p, w2cx, w2cy) && distC > 140 && mem.t > (bm.nextBuildAt || 0)) {
          // fallback: opportunistic screen wall at our current position (aim toward the carrier)
          if (!bm.buildHold) bm.buildHold = { x: w2cx, y: w2cy, until: mem.t + BUILD_WINDUP + 0.1 };
          aim = { x: w2cx, y: w2cy }; shoot = false; special = false; bm.nextBuildAt = mem.t + 4.0 * (sk.cdMul || 1);
        } else if (canShoot && seeC && lane && distC < COVER_STRIP) { shoot = true; charge = 1; if (distC < 260) closeShot = true; }
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
      // LOOSE ball. PRESENCE: the off-ball bot should mostly CONTEST, not hide (it used to lurk
      // in a bush 2:1 over contesting — the main reason hard "felt absent"). Contest radius scales
      // with aggro (easy ~600, hard ~640 — a MODERATE widen; going wider pulled bots out of
      // shape and spiked fog-roam); lurk only when the ball is genuinely far and not breaking home.
      const [bx, by] = predictBall(b, clamp(hyp(b.x - p.x, b.y - p.y) / 900, 0.05, 0.4));
      const myD = hyp(bx - p.x, by - p.y);
      const fastBreak = hyp(b.vx, b.vy) > 260 && (ogX - b.x) * b.vx > 0 && Math.abs(b.x - ogX) < FIELD.W * 0.5;
      if (fastBreak) tgt = { x: (b.x + ogX * 1.2) / 2.2, y: (b.y + GY) / 2 };  // stay home on a break
      else if (sk.cheat || myD < 440 + 200 * AGG) tgt = { x: bx, y: by };      // CONTEST the 50/50 (aggro-scaled)
      else { const bush = nearestBushCenter(tgt.x, tgt.y); if (bush) tgt = bush; } // lurk/ambush when genuinely far
    }
  }

  // TACTIC 7 — ACTIVE BULLET DODGE (hard/extreme). Steering already leans away from bullets
  // passively; this commits a decisive perpendicular SIDESTEP when a bullet is genuinely
  // incoming and we're free to react (not mid-shot/plant/build). A short commit window keeps the
  // sidestep from stuttering. Leaves aim/shoot untouched (never aborts a wind-up).
  if (sk.evade >= 0.9 && !bm.charging && !bm.bombHold && !bm.buildHold && !shoot && !special && !build) {
    if (bm.dodgeUntil && mem.t < bm.dodgeUntil && bm.dodgeTgt) {
      tgt = bm.dodgeTgt;
    } else if (mem.t > (bm.nextDodgeAt || 0)) {
      for (const pr of state.projectiles) {
        if (pr.team === p.team) continue;
        const rel = hyp(pr.x - p.x, pr.y - p.y);
        if (rel < 130 || rel > 340) continue;
        const [bvx, bvy] = unit(pr.vx || 0, pr.vy || 0);
        const toMe = unit(p.x - pr.x, p.y - pr.y);
        if (bvx * toMe[0] + bvy * toMe[1] < 0.9) continue; // not aimed at us
        // sidestep perpendicular to the bullet, toward the more open side / where we already lean
        let px = -bvy, py = bvx;
        if ((tgt.x - p.x) * px + (tgt.y - p.y) * py < 0) { px = -px; py = -py; }
        bm.dodgeTgt = { x: clamp(p.x + px * 240, 60, FIELD.W - 60), y: clamp(p.y + py * 240, 60, FIELD.H - 60) };
        bm.dodgeUntil = mem.t + 0.28; bm.nextDodgeAt = mem.t + 0.6 * (sk.cdMul || 1);
        tgt = bm.dodgeTgt; bm.lastTrick = 'dodge';
        break;
      }
    }
  }

  return finalize(p, tgt, aim, { shoot, charge, special, build, closeShot }, state, mem, bm, sk, dt);
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
  // reaction latency: only start slewing toward a NEW desired aim after `react` — but do NOT
  // re-arm the stutter while a shot is already COMMITTED (bm.charging). A close, juking target
  // keeps |dTheta| high every tick, which used to keep pushing reactUntil forward → the aim
  // pinned at the 0.25x slew → it never converged → the wind-up timed out and CANCELLED with
  // no shot. That was the core "if they're close to me they DON'T SHOOT". First acquisition of
  // a NEW target still pays the latency (bm.charging is null then).
  const dTheta = Math.atan2(Math.sin(desired - bm.aimTheta), Math.cos(desired - bm.aimTheta));
  const dThetaAbs = Math.abs(dTheta);
  if (dThetaAbs > 0.9 && mem.t > (bm.reactUntil || 0) && !bm.charging) bm.reactUntil = mem.t + sk.react;
  const slew = (mem.t >= (bm.reactUntil || 0)) ? sk.turnRate * dt : sk.turnRate * dt * 0.25;
  bm.aimTheta += clamp(dTheta, -slew, slew);
  // smoothed aim noise that shrinks the longer the aim is settled (time-on-target)
  bm.onTgt = dThetaAbs < 0.12 ? (bm.onTgt || 0) + dt : 0;
  let noise = sk.aimSigma * Math.exp(-(bm.onTgt || 0) / sk.aimTau) * seededNoise(mem.t * 9.3 + idHash(p.id) * 0.017);
  // EXTREME cheat is STOCHASTIC, not a robotic aimbot: usually pinpoint, but ~cheatFlub of the
  // time a real (un-damped) slip is injected so a skilled player gets a beatable window.
  if (sk.cheat && sk.cheatFlub) {
    const slip = seededNoise(Math.floor(mem.t * 1.7) + idHash(p.id) * 0.013); // ~uniform [-1,1], changes a few times/sec
    if (slip > 1 - sk.cheatFlub * 2) noise += 0.16 * seededNoise(mem.t * 5.1 + idHash(p.id) * 0.023);
  }
  const th = bm.aimTheta + noise;
  const ax = Math.cos(th), ay = Math.sin(th);

  let { shoot, charge, special, build, closeShot } = btn;
  if (opts.hold) bm.charging = null; // standing on a bomb plant — never charge a shot
  const isBallRelease = state.ball.owner === p.id;

  // Bomb aim offset: useSpecial() throws along the (sax,say) VECTOR direction, distance =
  // min(hypot(sax,say),1) × BOMB_LOB_RANGE. We build (sax,say) along the bot's aim, so for a
  // bot the lob direction equals its aim. Every bomb this bot plants today (cornered-finish rocket-jump, tackle-steal,
  // double-bomb join) is a FEET plant: bm.bombHold.x/y (the intended plant anchor) is set to
  // the bomber's OWN position at commit time, so the offset is naturally 0 — exactly the
  // "feet/rocket-jump bomb stays 0,0" rule. The one case where the anchor differs from the
  // bomber's feet is the wall-cannon nudge (a wall-backed spot a short hop away): there this
  // becomes a genuine aimed offset toward that spot, capped at BOMB_LOB_RANGE.
  let sax = 0, say = 0;
  if (special && bm.bombHold) {
    const dist = hyp(bm.bombHold.x - p.x, bm.bombHold.y - p.y);
    if (dist > 1) {
      const frac = Math.min(1, dist / BOMB_LOB_RANGE);
      const [ux, uy] = unit(aimVec.x, aimVec.y);
      sax = ux * frac; say = uy * frac;
    }
  }

  // ---- SIM-OWNED CHARGE RAMP: the bot HOLDS the trigger to build power like a human, then
  // RELEASES (fire) once charge reaches `fireAt` AND aim is within `tol`. A FULL-power request
  // releases at FULL_CHARGE (enough to strip a carrier / drive through a defender) instead of
  // waiting for ~0.98 — cutting the vulnerable wind-up. Close shots (closeShot) release on a
  // looser aim since a near, fast, large ball connects anyway. Lost ball / dry mag / 2.2s
  // timeout still cancels (a real cancel, no shot). ----
  let hold = false, fire = false;
  const wantCharge = clamp(charge || 1, 0, 1);
  if (shoot && !bm.charging) {
    if (isBallRelease || p.ammo > 0) { // don't start a BULLET wind-up we can't finish
      const fireAt = wantCharge >= FULL_CHARGE ? FULL_CHARGE + 0.01 : Math.max(0.02, wantCharge - 0.02);
      bm.charging = { target: wantCharge, fireAt, tol: closeShot ? 0.85 : 0.45, ball: isBallRelease, until: mem.t + 2.2 };
    }
  } else if (shoot && bm.charging) {
    bm.charging.target = wantCharge; // keep the freshest target while winding up
    if (closeShot) bm.charging.tol = 0.85;
  }
  if (bm.charging) {
    const c = bm.charging;
    const lostBall = c.ball && state.ball.owner !== p.id;
    const dryBullet = !c.ball && p.ammo <= 0;
    if (lostBall || dryBullet || mem.t > c.until) {
      bm.charging = null; // cancel: release trigger without firing
    } else if ((p._charge || 0) >= c.fireAt && dThetaAbs <= c.tol) {
      fire = true; bm.charging = null; // wound up enough + on target -> release
    } else {
      hold = true; // keep charging
    }
  }

  // EXTREME PRE-CHARGE (stochastic): bank power continuously while approaching so the shot is
  // already wound up the instant the gate opens (kills the visible wind-up) — but only ~70% of
  // the time, so occasionally EXTREME still has a beatable wind-up. Never overrides bomb/special/build.
  if (sk.preCharge && !opts.hold && !fire && !special && !build && (state.ball.owner === p.id || p.ammo > 0)) {
    if (seededNoise(Math.floor(mem.t * 0.9) + idHash(p.id) * 0.019) > -0.45) hold = true;
  }

  // Resolve a pending build-hold: hold the buildHold control until the windup completes,
  // then emit the build edge once (this tick only) and clear the intent. Mirrors the
  // bombHold hold-then-commit pattern above. The branch that armed bm.buildHold keeps
  // re-selecting itself each tick (buildReady stays true until the wall actually commits)
  // and re-supplies the same aim vector via aimVec, so the wall's orientation stays
  // consistent for the whole hold without needing to be forced here.
  let buildHold = false;
  if (bm.buildHold) {
    if (mem.t >= bm.buildHold.until) { build = true; bm.buildHold = null; }
    else { buildHold = true; build = false; }
  }

  return {
    seq: (bm.seq = (bm.seq || 0) + 1),
    moveX: mvx, moveY: mvy, aimX: ax, aimY: ay,
    hold, fire, special, build, buildHold,
    sax, say,
  };
}
