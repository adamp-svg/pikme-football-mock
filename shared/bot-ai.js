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
  FIELD, GOAL, PENALTY, BOMB, BOMB_CENTER_R, BOMB_COMBINE_RADIUS, BOMB_LOB_RANGE,
  BOMB_WALL_DIST, BOMB_WALL_COS, BOMB_WALL_CANNON_STATIC, BUILT_WALL, BUILD_DIST_MAX, BUSH_REVEAL_DIST, VISION_RANGE, BALL_VISION,
  BALL_RADIUS, WALL_BOUNCE, WALL_RESTITUTION, FULL_CHARGE, QUICK_CHARGE, OVERCHARGE_TTL, SUPER_USES, BUILD_WINDUP,
  SHOOT_CHARGE_TIME, SUPER_CHARGE_RATE, FRAGILE_PASS_SPEED, CHARGE_MIN_MUL, BALL_MIN_SPEED,
  CHARACTERS, DEFAULT_CHAR, clamp,
} from './constants.js';
import { ARENA, pointInBox, pointInBush, nearestOnWall } from './arena.js';

// Active arena for this state — a custom FIELD-BUILDER arena (state.arena) or the default.
// Bots must path/aim against the SAME geometry the sim collides with. Falls back to the
// global ARENA when no state is threaded (safe default).
const arenaOf = (state) => (state && state.arena) || ARENA;

// ---- HOW FAR DOES A KICK ACTUALLY GO? -------------------------------------------------------
// Tuned against BALL_FRICTION / BALL_MIN_SPEED, the ball's roll is linear in its release speed:
// roll ≈ 0.468 * (v0 - BALL_MIN_SPEED)  (constants.js records the same relation for BALL_TAP_SPEED,
// and it is confirmed by simulation: 613px/s→278px, 875→401, 1085→499, 1400→647).
// Bots used to shoot with no model of this at all, from up to 835px with a kick that travels 504px.
const ROLL_K = 0.468;
const chargeMul = (c) => CHARGE_MIN_MUL + (1 - CHARGE_MIN_MUL) * clamp(c, 0, 1);
function ballRollPx(state, charge) {
  const v0 = (state.settings.shotPower || 1400) * chargeMul(charge);
  return Math.max(0, ROLL_K * (v0 - BALL_MIN_SPEED));
}
// The charge needed to roll `px`, or >1 when it simply cannot be done.
function chargeForRoll(state, px) {
  const v0 = px / ROLL_K + BALL_MIN_SPEED;
  const mul = v0 / (state.settings.shotPower || 1400);
  return (mul - CHARGE_MIN_MUL) / (1 - CHARGE_MIN_MUL);
}

const GY = FIELD.H / 2;
const PEN_TOP = (FIELD.H - PENALTY.width) / 2;
const PEN_BOT = (FIELD.H + PENALTY.width) / 2;
const GOAL_TOP = (FIELD.H - GOAL.width) / 2;
const GOAL_BOT = (FIELD.H + GOAL.width) / 2;

// ---- WALKABLE AREA — an exact mirror of sim.js clampXYToArea ----------------------------
// The legal area is the pitch UNION the two net pockets, reachable THROUGH the goal mouths.
// The bot MUST agree with the sim here. It previously did not: steer() treated the end line as
// plain "stadium wall" danger, so a carrier bounced ~55px short of the goal line and could never
// reach it — while sim.js #9 (DRIBBLE-IN GOAL, sim.js:842) lets a carrier WALK THE BALL INTO THE
// NET for a goal that skips the kick path entirely and so cannot be saved. The old bot-ai header
// claim "you cannot dribble a goal" is stale; the walk-in is the highest-value finish in the game.
// `openGoalX` = the goal line whose net pocket is a legal destination (the ATTACKING mouth of a
// ball-CARRIER), or null for "pitch only". Mirrors sim.js clampBallCarryXY, deliberately NOT
// clampXYToArea: the sim lets any player stand in either pocket, but a pocket is a 300x70 DEAD
// END. Opening it to every bot measurably raised wall-pinning (0.29% -> 0.40% of move ticks) as
// off-ball bots wandered in and wedged. Only the attacking carrier has a reason to be there — the
// unsaveable dribble-in (sim.js #9) — so only the carrier gets it.
function outsidePlayArea(x, y, r, openGoalX) {
  const x1 = clamp(x, r, FIELD.W - r), y1 = clamp(y, r, FIELD.H - r);          // the pitch
  let bx = x1, by = y1;
  if (openGoalX != null) {
    const lo = openGoalX === 0 ? r - GOAL.depth : r;                            // only the ONE attacking pocket
    const hi = openGoalX === 0 ? FIELD.W - r : FIELD.W - r + GOAL.depth;
    const x2 = clamp(x, lo, hi), y2 = clamp(y, GOAL_TOP + r, GOAL_BOT - r);     // mouth band into that pocket
    if ((x - x2) * (x - x2) + (y - y2) * (y - y2) < (x - x1) * (x - x1) + (y - y1) * (y - y1)) { bx = x2; by = y2; }
  }
  return hyp(x - bx, y - by);
}

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
  // `t` is the tier's own position on the RAW 0..1 difficulty axis, and it is here so the LEGACY
  // string path (memSkillVec's `BOT_SKILL[mem.skill]` fallback, used by a stale client that still
  // sends { botDifficulty }) carries the same gating scalar skillVec() now exposes. Without it
  // every t-gated behaviour below would read `undefined` on that path and silently never fire.
  // The values mirror SKILL_ANCHORS' own stops, so the two paths agree by construction.
  easy:    { t: 0.25, react: 0.26, aimSigma: 0.09,  aimTau: 0.50, turnRate: 9.0,  leadGain: 0.85, toolSkill: 0.58, evade: 0.68, aggro: 0.86, chargeRate: 0.95, cdMul: 1.10, visionMul: 1.00, wallCommit: 0.45, detourRatio: 1.40, flowAhead: 2, navLag: 0.20, memoryS: 0.55, chaseReact: 0.26 },
  normal:  { t: 0.50, react: 0.16, aimSigma: 0.04,  aimTau: 0.24, turnRate: 16.0, leadGain: 1.00, toolSkill: 0.85, evade: 0.92, aggro: 1.02, chargeRate: 1.25, cdMul: 0.85, visionMul: 1.10, wallCommit: 0.50, detourRatio: 1.18, flowAhead: 3, navLag: 0.12, memoryS: 0.90, chaseReact: 0.16 },
  hard:    { t: 0.82, react: 0.08, aimSigma: 0.018, aimTau: 0.16, turnRate: 26.0, leadGain: 1.05, toolSkill: 0.97, evade: 1.00, aggro: 1.12, chargeRate: 2.05, cdMul: 0.55, visionMul: 1.40, wallCommit: 0.70, detourRatio: 1.10, flowAhead: 4, navLag: 0.05, memoryS: 1.50, chaseReact: 0.06 },
  extreme: { t: 1.00, react: 0.04, aimSigma: 0.016, aimTau: 0.13, turnRate: 38.0, leadGain: 1.15, toolSkill: 1.00, evade: 1.00, aggro: 1.25, chargeRate: 3.40, cdMul: 0.34, visionMul: 1.60, wallCommit: 0.90, detourRatio: 1.06, flowAhead: 5, navLag: 0.03, memoryS: 2.20, chaseReact: 0.00, preChargeP: 0.55, cheatFlub: 0.34, flubMag: 0.10 },
};
export const DEFAULT_SKILL = 'normal';

// ---- FLUENT skill: a 0..1 scalar interpolated across the tiers above -------------------
// t = 0 tutorial-weak, ~0.25 easy, 0.5 normal, ~0.82 hard, 1.0 extreme. Lets each SIDE of a
// match carry its own continuous difficulty (see computeBotInputs' per-team skill), so enemy
// and partner can be tuned independently and matched to game progression.
const VERY_EASY = { t: 0.00, react: 0.5, aimSigma: 0.17, aimTau: 0.75, turnRate: 5.0, leadGain: 0.7, toolSkill: 0.32, evade: 0.45, aggro: 0.6, chargeRate: 0.6, cdMul: 1.45, visionMul: 0.9, wallCommit: 0.45, detourRatio: 2.60, flowAhead: 2, navLag: 0.30, memoryS: 0.35, chaseReact: 0.35 };
const SKILL_ANCHORS = [
  { t: 0.00, v: VERY_EASY },
  { t: 0.25, v: BOT_SKILL.easy },
  { t: 0.50, v: BOT_SKILL.normal },
  { t: 0.82, v: BOT_SKILL.hard },
  { t: 1.00, v: BOT_SKILL.extreme },
];
const SKILL_KEYS = ['react', 'aimSigma', 'aimTau', 'turnRate', 'leadGain', 'toolSkill', 'evade', 'aggro', 'chargeRate', 'cdMul', 'visionMul', 'wallCommit', 'detourRatio', 'flowAhead', 'navLag', 'memoryS', 'chaseReact'];
export function skillVec(t) {
  t = Math.max(0, Math.min(1, t));
  let a = SKILL_ANCHORS[0], b = SKILL_ANCHORS[SKILL_ANCHORS.length - 1];
  for (let i = 0; i < SKILL_ANCHORS.length - 1; i++) { if (t >= SKILL_ANCHORS[i].t && t <= SKILL_ANCHORS[i + 1].t) { a = SKILL_ANCHORS[i]; b = SKILL_ANCHORS[i + 1]; break; } }
  const f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
  const out = {};
  for (const k of SKILL_KEYS) out[k] = a.v[k] + (b.v[k] - a.v[k]) * f;
  // ---- THE GATING AXIS (design §4) --------------------------------------------------------
  // The RAW scalar, which skillVec used to drop on the floor. EVERY behaviour gate used to read
  // `toolSkill`, and toolSkill SATURATES: measured 0.372 -> 0.850 across L0-L5, then only
  // 0.850 -> 1.000 across the remaining SIX levels (L5..L11 spread 0.150; L5->L8 just 0.120).
  // That is why an L5 and an L8 bot ran the *identical* 14-tag repertoire — a player genuinely
  // could not tell them apart. `t` over the same L5..L11 window spreads 0.500, 3.3x wider, so a
  // new behaviour gated on it can actually land on one level and not the one below.
  // Do NOT re-gate anything on toolSkill; that axis is full.
  out.t = t;
  // The remaining bounded advantages RAMP IN from t=0.92 instead of snapping on at 0.95. The old
  // discrete snap is why level 9 -> 10 read as a cliff: one step and the bot gained x-ray, permanent
  // super and a pre-charged shot all at once. The knee stays above 0.92 so level 9 (T.veryHard) keeps
  // ZERO of it and only ids 10/11 are inside the ramp (preserving bot-buffs' EXTREME_SKILL 0.95 gate).
  const cf = clamp((t - 0.92) / 0.08, 0, 1);
  if (cf > 0) {                                   // below the knee a tier gets NONE of this
    out.preChargeP = 0.55 * cf;                   // 0 at L9, 0.55 at the very top
    out.cheatFlub = 0.34 - 0.16 * cf;             // slips OFTEN at the knee, less at the peak
    out.flubMag = 0.10 + 0.22 * (1 - cf);         // ...but each slip is BIGGER lower down (18deg -> 6deg)
  }
  return out;
}
// Resolve the skill vector a TEAM's bots should use. Priority: per-team numeric scalar
// (mem.teamSkill[team]) → whole-mem numeric scalar (mem.skill) → legacy string tier.
// `id` (optional) allows a PER-BOT override. The real game only ever needs per-team skill (a
// human's team contains exactly one bot — the partner), but measuring PLAYER-FELT difficulty needs
// a mixed team: a human-proxy at a fixed skill alongside the level's partner. Without this the
// level table can only be judged on enemy strength, which is not what the player experiences.
function memSkillVec(mem, team, id) {
  if (id && mem.botSkill && typeof mem.botSkill[id] === 'number') return skillVec(mem.botSkill[id]);
  if (mem.teamSkill && typeof mem.teamSkill[team] === 'number') return skillVec(mem.teamSkill[team]);
  if (typeof mem.skill === 'number') return skillVec(mem.skill);
  return BOT_SKILL[mem.skill] || BOT_SKILL[DEFAULT_SKILL];
}

// ---- PERSONALITY: two bots at the SAME level should not feel like the same bot ---------------
// Every bot on a side shares one skill vector, so a 2v2 is one behaviour played twice and a rematch
// at the same level is the same match. This tilts a few knobs per bot, keyed to a stable hash of
// its id, so one presses and one hangs back, one loves its tools and one hoards them.
// Deliberately NOT a difficulty change: the tilts are small and OPPOSED (more aggression is paid
// for with less patience), and they are CLAMPED to the ladder's own ceiling, so a persona can never
// make a bot simply stronger — test-bot-ladder.mjs would catch that as a ranking change.
// Brawl Stars varies its bots by BRAWLER; we have one character, so the axis has to be temperament.
// Deterministic (idHash, no Math.random), so replaying a match gives the identical result.
// ---- POLICY FIELDS, NOT SCALAR TILTS (summery/bots logic/BOT-PERSONALITIES-RESEARCH.md) --------
// The four old personas were +-0.14 offsets on aggro/toolSkill/wallCommit/bushLove. That made bots
// STATISTICALLY different and not VISIBLY different, which is the research doc's central complaint:
// "three personalities a player recognises immediately are worth more than eight that differ only in
// telemetry". So a persona now carries explicit POLICY: what it wants, where it stands, how much it
// spends, and how it charges. Skill still decides how WELL it does those things — a weak Enforcer and
// a strong Enforcer want the same things, and only one of them lands them.
//
// The fields are deliberately shaped like weights rather than behaviours, because
// ARCHITECTURE-REVIEW §3's A2 plan object is the right home for a real scorer and it does not exist
// yet. Building a persona-specific selection engine now would be the ninth hand-rolled instance of
// that missing abstraction; instead these values BIAS gates the named plays already read, so when A2
// lands they become its weights unchanged and nothing here has to be unpicked.
//
//   chase        how much this persona wants to be the loose-ball chaser (role tie-break only —
//                it can never refuse the assignment, see design rule 3 / role.chaser)
//   escort       how strongly it holds an escort station beside its own carrier
//   guardGoal    how strongly it stays goal-side and plays last defender
//   hunt         appetite for shooting a visible ENEMY (the Enforcer axis)
//   wall/bomb    tool budgets: >1 spends earlier, <1 hoards
//   maxCharge    the charge a BULLET is allowed to bank (see readyCharge below). 0.71 is the old
//                clamp = FULL_CHARGE + 0.01, i.e. strip power with the WEAKEST legal knockback;
//                1.0 is true maximum power (343px of drift instead of 250px, measured).
//   ready        probability-free readiness: how far into a "charge before I have a target" hold
//                this persona goes, scaled by skill in readyChargeWant()
const PERSONAS = [
  // Enforcer — "if I can see an enemy, I am preparing to hit them."
  { name: 'enforcer',  chase: 0.5, escort: 0.4, guardGoal: 0.3, hunt: 1.00, wall: 0.7, bomb: 1.15, maxCharge: 1.00, ready: 1.00,
    aggro: +0.14, toolSkill: +0.00, bushLove: -0.25, wallCommit: -0.08 },
  // Fortress — "you do not get a clean route to our goal."
  { name: 'fortress',  chase: 0.4, escort: 0.5, guardGoal: 1.00, hunt: 0.55, wall: 1.25, bomb: 0.85, maxCharge: 0.85, ready: 0.60,
    aggro: -0.12, toolSkill: +0.06, bushLove: -0.05, wallCommit: +0.12 },
  // Bodyguard — "the carrier gets a protected route; I do not compete with them for the ball."
  { name: 'bodyguard', chase: 0.25, escort: 1.00, guardGoal: 0.4, hunt: 0.80, wall: 0.9, bomb: 0.9, maxCharge: 1.00, ready: 0.85,
    aggro: -0.04, toolSkill: +0.04, bushLove: +0.05, wallCommit: +0.04 },
  // Ball Hawk — "loose ball means my current plan is cancelled and I get there first."
  { name: 'ballhawk',  chase: 1.00, escort: 0.5, guardGoal: 0.35, hunt: 0.50, wall: 0.8, bomb: 1.00, maxCharge: 0.75, ready: 0.30,
    aggro: -0.02, toolSkill: -0.02, bushLove: -0.10, wallCommit: -0.04 },
];
// COMPLEMENTARY PAIRS, not two independent draws (research doc §"Team composition"): two Bodyguards
// both wait for a carrier, two Ball Hawks both fetch, two Enforcers can both abandon the ball. Slot 0
// and slot 1 of every team therefore draw from one PAIR, and `rot` selects which pair the room uses —
// so a room is "pressure + safety" or "escort + hunt", never "two of the same".
// Still keyed on SLOT and mirrored across teams: keying on bot id once handed team A a permanent
// +0.02 aggro edge and collapsed the ladder from rho 1.00 to -0.10.
const PERSONA_PAIRS = [
  ['enforcer', 'fortress'],   // pressure + defensive safety
  ['bodyguard', 'enforcer'],  // escort + hunt
  ['ballhawk', 'fortress'],   // reliable possession + territory
  ['enforcer', 'ballhawk'],   // high pressure with an objective guarantee
];
const personaByName = (n) => PERSONAS.find((p) => p.name === n) || PERSONAS[0];
// KEYED ON SLOT, NOT ON BOT ID. Keying on the id looked more varied and was measurably WRONG: with
// the fixed ids A0/A1/B0/B1 it handed team A (anchor+presser, +0.02 aggro) a permanent edge over
// team B (tinkerer+anchor, -0.16), a constant asymmetry unrelated to skill. Measured: it collapsed
// the difficulty ladder from Spearman rho 1.00 to -0.10 and the top-vs-bottom spread from
// +1.27 to -0.31 goals/match — personality was quietly deciding matches. Keying on SLOT mirrors the
// personas across the two teams, so both sides always get the same multiset and the only thing
// separating them is skill. `rot` (set per ROOM by the server, default 0) rotates which persona
// each slot draws, so matches still vary without ever making a match unfair.
export function personaOf(slot, rot = 0) {
  const pair = PERSONA_PAIRS[(((rot | 0) % PERSONA_PAIRS.length) + PERSONA_PAIRS.length) % PERSONA_PAIRS.length];
  // Slots beyond 1 (3v3+) walk the pair and then the full list, so a third bot is never a duplicate
  // of slot 0 — the doc's "avoid two of the same" rule, extended past 2v2.
  const s = (slot | 0) % Math.max(1, PERSONAS.length);
  return s < pair.length ? personaByName(pair[s]) : PERSONAS[(s + (rot | 0)) % PERSONAS.length];
}
export function withPersonaForTest(sk, slot, rot = 0, forced = null) { return withPersona(sk, slot, rot, forced); }
function withPersona(sk, slot, rot, forced) {
  const pr = forced ? personaByName(forced) : personaOf(slot, rot);
  // MEASURED AND REVERTED — ramping the persona policy in with skill (blend toward neutral below
  // t=0.60, on the theory that a skill-independent ability flattens the ladder). It did not do its
  // job: the t=0.05 anchor moved +0.03 -> +0.06 (nothing), goals rho stayed 0.70, and it COST the
  // felt spread (0.50 -> 0.46) and the strip ranking (rho 0.90 -> 0.80), while making the identities
  // invisible at 5 of the 12 levels. Kept as a note rather than as code: the bottom-tier inversion is
  // NOT the personas' doing — the BASELINE ladder is inverted (rho -0.50), see BOT_HANDOFF round 10.
  const out = { ...sk, persona: pr.name, pp: pr };
  out.aggro = clamp((sk.aggro || 0.9) + pr.aggro, 0.5, 1.30);
  out.toolSkill = clamp((sk.toolSkill || 0.5) + pr.toolSkill, 0.20, 1.00);
  out.wallCommit = clamp((sk.wallCommit || 0.6) + pr.wallCommit, 0.30, 1.10);
  out.bushLove = clamp(0.5 + pr.bushLove, 0, 1); // consumed by the off-ball lurk-vs-contest choice
  // MAXIMUM POWER IS NOT THE FULL-EFFECT THRESHOLD. sim.js strips a carrier at FULL_CHARGE 0.70, and
  // `finalize` used to clamp EVERY bullet to 0.71 — so no bot at any level could produce more than
  // the weakest legal strip: 250px of knockback drift where 1.0 gives 343px, and a 50/50 break-even
  // head start of 220px instead of 320px. A persona's `maxCharge` is now the ceiling it may bank, and
  // it is gated on SKILL as well: at the bottom of the ladder nobody banks past the strip threshold,
  // so this cannot hand low tiers a new weapon.
  // THE USER'S ASK #1: "in level 5 and above, the enemy to always try to have a full power shot."
  // So the CEILING is the level's, not the persona's: it ramps 0.71 -> 1.00 across L1..L5 and stays at
  // true maximum power above it, for every persona. The persona's own `maxCharge` survives only as a
  // tilt BELOW the top of the ramp (an Enforcer gets there first, a Ball Hawk last), because that is
  // where identity is still affordable — at L5+ everybody hits as hard as the game allows.
  const lr = levelRamp(sk);
  const personaTilt = 0.85 + 0.15 * (pr.maxCharge != null ? pr.maxCharge : 1);   // 0.96..1.00
  out.maxCharge = clamp(FULL_CHARGE + 0.01 + (1 - FULL_CHARGE - 0.01) * lr * personaTilt, FULL_CHARGE + 0.01, 1);
  return out;
}
// ---- readyCharge: bank power BEFORE a target exists (research doc §"Smart-bot full-power readiness")
// The doc's ask is "smart bots power up before finding an enemy". The existing `preChargeP` does a
// stochastic version of this above t=0.92 only; this is the deterministic, persona-shaped version:
// how much of a wind-up this bot is willing to hold with no victim selected, as a fraction of its
// maxCharge. Deterministic on purpose — a coin flip is the refuted `mistakeP` pattern.
// It returns 0 below the skill gate, so the bottom of the ladder never pre-charges and the tell (a
// visibly charged bot walking at you) is preserved where it matters.
// TOOL BUDGET: a persona's own gap between uses of a tool. >1 hoards, <1 spends early. Bounded to
// +-25% so a persona can never out-tool a whole difficulty tier (the ladder owns cdMul).
function toolGap(sk, kind) {
  const pr = sk.pp;
  const want = pr && pr[kind] != null ? pr[kind] : 1;
  return clamp(1 / clamp(want, 0.75, 1.25), 0.8, 1.34);
}
// "ALWAYS TRY TO HAVE a full power shot" is the readiness half of ask #1: how full a wind-up this bot
// keeps banked with no victim selected. On the L5 ramp, so it is rare at L1 and permanent from L5.
// The persona still shades WHO bothers most (Enforcer 1.0 ... Ball Hawk 0.30) but at L5+ even the
// laziest keeps most of a charge, which is what the user asked for.
function readyChargeWant(sk) {
  const pr = sk.pp;
  const want = pr && pr.ready != null ? pr.ready : 0.5;
  // BANK PART OF IT, NOT ALL OF IT. Banking the whole wind-up turned every opened gate into an
  // instant shot: bullets/match 74 -> 232, ball advance per release 29-41px -> 6-12px, and the felt
  // ladder range 48% -> 18%. Measured, the ask survives at ~half a wind-up: the SHOT is still full
  // power (maxCharge 1.0 does that), the bot is still visibly charged, and it still needs ~0.4s of
  // top-up — which is also the "preserve a visible tell" safeguard the research doc asked for.
  return levelRamp(sk) * (0.34 + 0.26 * want);   // L5+: 0.42 (hawk) .. 0.60 (enforcer)
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
function nearestBushCenter(x, y, maxD = 520, state = null) {
  let best = null, bd = maxD;
  for (const g of arenaOf(state).bushes) { const cx = g.x + g.w / 2, cy = g.y + g.h / 2, d = hyp(cx - x, cy - y); if (d < bd) { bd = d; best = { x: cx, y: cy }; } }
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

// ---- EXACT segment-vs-AABB test (slab clipping). Replaces point-sampling a lane: sampling
// with a FIXED step count strode OVER thin obstacles — a 32px built wall on a 1000px lane was
// missed ~2 times out of 3 (stride 100px), so "is my shot blocked?" answered wrong in BOTH
// directions. This is exact AND cheaper than 10 samples (O(1) per box, no allocation).
// `pad` fattens the box by the projectile/ball radius so a graze counts as a block. ----
function segHitsBox(x0, y0, x1, y1, b, pad = 0) {
  const lox = b.x - pad, hix = b.x + b.w + pad, loy = b.y - pad, hiy = b.y + b.h + pad;
  const dx = x1 - x0, dy = y1 - y0;
  let t0 = 0, t1 = 1;
  if (Math.abs(dx) < 1e-9) { if (x0 < lox || x0 > hix) return false; }
  else {
    let ta = (lox - x0) / dx, tb = (hix - x0) / dx;
    if (ta > tb) { const s = ta; ta = tb; tb = s; }
    if (ta > t0) t0 = ta; if (tb < t1) t1 = tb;
    if (t0 > t1) return false;
  }
  if (Math.abs(dy) < 1e-9) { if (y0 < loy || y0 > hiy) return false; }
  else {
    let ta = (loy - y0) / dy, tb = (hiy - y0) / dy;
    if (ta > tb) { const s = ta; ta = tb; tb = s; }
    if (ta > t0) t0 = ta; if (tb < t1) t1 = tb;
    if (t0 > t1) return false;
  }
  return true;
}

// ---- line-of-fire clear? EXACT against static+built walls AND enemy bodies ----
// `viewer` (a bot): if given, an enemy HIDDEN in a bush (unseen by this viewer) is NOT
// counted as blocking — the bot can't plan around a body it can't see (bush stealth).
// The segment starts LANE_SKIP px along so a wall the shooter is already touching doesn't veto
// every lane (the old sampling skipped the first 10% for the same reason, just accidentally).
// `out` (optional): receives the first blocking wall as out.wall — the release ladder needs to
// know WHETHER it can shoot the blocker down (built = destructible, static stone = never).
const LANE_SKIP = 14;
export function laneClear(x0, y0, x1, y1, state, forTeam, { enemies = true, margin = 0, viewer = null, out = null } = {}) {
  if (out) { out.wall = null; out.foe = null; }
  const L = hyp(x1 - x0, y1 - y0);
  if (L > LANE_SKIP * 2) { const f = LANE_SKIP / L; x0 += (x1 - x0) * f; y0 += (y1 - y0) * f; }
  for (const w of arenaOf(state).walls) if (segHitsBox(x0, y0, x1, y1, w)) { if (out) out.wall = w; return false; }
  for (const w of state.builtWalls) if (segHitsBox(x0, y0, x1, y1, w)) { if (out) out.wall = w; return false; }
  if (enemies) {
    const er = radOf(state) + 10 + margin;
    for (const q of Object.values(state.players)) {
      if (q.team === forTeam) continue;
      if (viewer && !botCanSee(viewer, q, state)) continue;
      if (pointSegDist(q.x, q.y, x0, y0, x1, y1) < er) { if (out) out.foe = q; return false; }
    }
  }
  return true;
}

// ---- INDESTRUCTIBLE line-of-sight (task #5): does a STATIC stone wall block the straight
// segment (x0,y0)->(x1,y1)? Used to VETO a shot/tackle aimed AT an enemy sitting behind stone —
// a bullet or rocket-jump can't reach through an indestructible wall. Player-BUILT (destructible)
// walls are intentionally IGNORED here: the sim lets shots chip/kill those, so they must NOT
// suppress the attempt (that stays "per existing behavior", handled by laneClear elsewhere).
// Now EXACT (segHitsBox) instead of step-sampled — a stride could skip a thin crate. ----
function indestructibleBlocks(x0, y0, x1, y1, state = null) {
  for (const w of arenaOf(state).walls) if (segHitsBox(x0, y0, x1, y1, w)) return true;
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
function chooseAmbushBush(c, ogX, state = null) {
  let best = null, bestScore = -1e9;
  for (const g of arenaOf(state).bushes) {
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
  for (const w of arenaOf(state).walls) {
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
// ---- THE VIEW IS A RECTANGLE, NOT A CIRCLE -------------------------------------------------
// A circular VISION_RANGE gave bots ~620px of awareness in EVERY direction, but the player's
// awareness is their SCREEN, and the screen is wide and short. The client's camera is
// `scale = CAM_ZOOM * canvasW / FIELD.W` with CAM_ZOOM 1.65 (client.js:4935/4983), so the visible
// world is FIELD.W / 1.65 = 1212px wide — half-width 606, which is where the old 620 radius came
// from — and 1212 / (16:9) = 682px tall, half-height 341. A phone in landscape (844x390) is
// TIGHTER still vertically (~560 tall), so 341 is the generous end of what a player can actually
// see. The circle was handing bots nearly 2x the vertical awareness of the human they play against.
// Team B renders mirrored horizontally; the box is symmetric, so it needs no mirroring.
const VIEW_HALF_W = 606, VIEW_HALF_H = 341;
// The ball-carrier is the tracked objective and is seen further (BALL_VISION 950 vs VISION_RANGE
// 620). Keep that as a SCALE on the same screen-shaped box rather than a second circle, so the
// concession stays "a wider screen", not "a rounder one".
const CARRIER_VIEW_K = BALL_VISION / VISION_RANGE;
function inView(dx, dy, mul, k = 1) {
  return Math.abs(dx) <= VIEW_HALF_W * mul * k && Math.abs(dy) <= VIEW_HALF_H * mul * k;
}
export const VIEW_BOX = { halfW: VIEW_HALF_W, halfH: VIEW_HALF_H, carrierK: CARRIER_VIEW_K }; // for tests/overlays

export function botCanSee(viewer, target, state, sk) {
  if (viewer.team === target.team) return true;          // teammates always
  const dist = hyp(viewer.x - target.x, viewer.y - target.y);
  const vdx = target.x - viewer.x, vdy = target.y - viewer.y;
  const inBush = pointInBush(target.x, target.y);
  // EXTREME CHEAT (x-ray): an OPEN enemy is seen anywhere on the pitch, ignoring fog.
  // CRITICAL: a BUSHED enemy stays hidden even to EXTREME — cover still works.
  // X-RAY DELETED. The top tier used to see every OPEN enemy anywhere on the pitch — information
  // the player provably cannot have, and the single most "unfair rather than hard" thing in the
  // file. Brawl Stars' bots never cheat; Fortnite's are navmesh + a reaction budget. The top tier
  // is now strong through DECISIONS (see memoryS/leadGain/react), with vision merely wide.

  const vMul = (sk && sk.visionMul) || 1;
  // The ball-carrier is the tracked objective — seen at a longer (tier-scaled) range so
  // bots keep pressing instead of losing it to fog mid-chase. BUT a carrier hiding IN A
  // BUSH stays concealed (falls to the bush rules below) — carrying in a bush is safe.
  if (state.ball.owner === target.id && !inBush && inView(vdx, vdy, vMul, CARRIER_VIEW_K)) return true;
  if (!inView(vdx, vdy, vMul)) return false;             // an OFF-ball enemy off-SCREEN — no seeing across the field
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
  if (canSee) {
    bm.seen = { id: tgt.id, x: tgt.x, y: tgt.y, vx: tgt.vx || 0, vy: tgt.vy || 0, t: mem.t };
    return { x: tgt.x, y: tgt.y, vx: tgt.vx || 0, vy: tgt.vy || 0, live: true };
  }
  const s = bm.seen;
  if (!s || s.id !== tgt.id) return null;                 // no memory of THIS enemy — don't reveal it
  const adv = clamp(mem.t - s.t, 0, (sk && sk.memoryS) || LOST_SIGHT_MEMORY); // tier-scaled: a smart bot remembers a vanished target longer
  return { x: s.x + s.vx * adv, y: s.y + s.vy * adv, vx: s.vx, vy: s.vy, live: false };
}

// ============================ NAV GRID + FLOW FIELD ==================================
// Local steering alone CANNOT route around a big obstacle, no matter how the danger terms are
// weighted: past the end of a wall the direct line to the target clips the corner, the bot turns
// back, and it orbits the corner forever (measured: it reached y=895 past a 600px wall at t=5.3s,
// then oscillated between (861,845) and (915,895) indefinitely). That is a LOCAL MINIMUM, and the
// standard fix is a global distance field — Roblox's PathfindingService and Fortnite's navmesh
// exist for exactly this, and Brawl Stars pathfinds on its tile grid. Ours is the cheap version:
// a coarse occupancy grid + BFS distance field, CACHED per arena, consulted only when the direct
// line is actually a detour. Bushes are never obstacles (they are walk-through cover).
const NAV_CELL = 32;
const NAV_GW = Math.ceil(FIELD.W / NAV_CELL), NAV_GH = Math.ceil(FIELD.H / NAV_CELL); // 63 x 35 = 2205
const NAV_INF = 0x3fffffff;
const NAV_DX = [1, -1, 0, 0, 1, 1, -1, -1], NAV_DY = [0, 0, 1, -1, 1, -1, 1, -1];
const navCellAt = (x, y) => clamp(Math.floor(y / NAV_CELL), 0, NAV_GH - 1) * NAV_GW + clamp(Math.floor(x / NAV_CELL), 0, NAV_GW - 1);
const navCX = (c) => (c % NAV_GW) * NAV_CELL + NAV_CELL / 2;
const navCY = (c) => ((c / NAV_GW) | 0) * NAV_CELL + NAV_CELL / 2;

// Built walls change rarely (one build per ~15s per player), so a cheap signature is enough to
// know when the grid is stale — far simpler than incremental re-stamping, and the rebuild is ~1ms.
function navSig(state) {
  let h = (state.builtWalls.length * 2654435761) >>> 0;
  for (const w of state.builtWalls) h = (h ^ Math.imul(w.id | 0, 2246822519) ^ (Math.round(w.hp) * 97)) >>> 0;
  return h;
}
function navBuildOcc(state, r) {
  const occ = new Uint8Array(NAV_GW * NAV_GH);
  const walls = arenaOf(state).walls.concat(state.builtWalls);
  for (let gy = 0; gy < NAV_GH; gy++) {
    for (let gx = 0; gx < NAV_GW; gx++) {
      const x = gx * NAV_CELL + NAV_CELL / 2, y = gy * NAV_CELL + NAV_CELL / 2;
      let blocked = outsidePlayArea(x, y, r, null) > 0;
      if (!blocked) for (const w of walls) { const np = nearestOnWall(w, x, y); if (hyp(x - np.x, y - np.y) - (np.rad || 0) < r + 2) { blocked = true; break; } }
      occ[gy * NAV_GW + gx] = blocked ? 1 : 0;
    }
  }
  return occ;
}
function navEnsure(mem, state) {
  const arena = arenaOf(state), sig = navSig(state);
  let nav = mem.nav;
  if (!nav || nav.arenaRef !== arena || nav.sig !== sig) {
    nav = mem.nav = { arenaRef: arena, sig, occ: navBuildOcc(state, radOf(state)), fields: new Map(), lru: [], builds: (mem.nav ? mem.nav.builds : 0) + 1 };
  }
  return nav;
}
// The r+2 inflation makes the whole 64px band along every wall (and all four corners) blocked, so
// a bot standing legally can still be IN a blocked cell — every lookup must snap to a free one or
// the field reports "unreachable" for 17% of the pitch.
function navNearestFree(occ, cell) {
  if (cell >= 0 && !occ[cell]) return cell;
  const cx = cell % NAV_GW, cy = (cell / NAV_GW) | 0;
  for (let rad = 1; rad <= 3; rad++) {
    for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= NAV_GW || ny >= NAV_GH) continue;
      const c = ny * NAV_GW + nx;
      if (!occ[c]) return c;
    }
  }
  return -1;
}
// 8-connected BFS with 10/14 costs. MUST re-push on improvement (SPFA): a visit-once FIFO with
// non-uniform weights produces wrong distances and a non-monotonic field, which shows up as a
// bot jittering between two cells that each think the other is downhill.
function navBfs(occ, start) {
  const d = new Int32Array(NAV_GW * NAV_GH).fill(NAV_INF);
  if (start < 0) return d;
  d[start] = 0;
  const q = [start];
  for (let head = 0; head < q.length; head++) {
    const c = q[head], cx = c % NAV_GW, cy = (c / NAV_GW) | 0, dc = d[c];
    for (let k = 0; k < 8; k++) {
      const nx = cx + NAV_DX[k], ny = cy + NAV_DY[k];
      if (nx < 0 || ny < 0 || nx >= NAV_GW || ny >= NAV_GH) continue;
      const n = ny * NAV_GW + nx;
      if (occ[n]) continue;
      if (NAV_DX[k] && NAV_DY[k] && (occ[cy * NAV_GW + nx] || occ[ny * NAV_GW + cx])) continue; // no corner cutting
      const nd = dc + (NAV_DX[k] && NAV_DY[k] ? 14 : 10);
      if (nd < d[n]) { d[n] = nd; q.push(n); }
    }
  }
  return d;
}
// Fields are keyed by the target cell snapped to 64px, so several bots chasing one ball share one
// field. Capped + LRU-evicted so a match cannot grow unbounded memory.
const NAV_MAX_FIELDS = 16;
function navField(mem, state, tx, ty) {
  const nav = navEnsure(mem, state);
  const cell = navNearestFree(nav.occ, navCellAt(tx, ty));
  if (cell < 0) return null;
  const key = ((cell % NAV_GW) >> 1) * 1000 + (((cell / NAV_GW) | 0) >> 1);
  let f = nav.fields.get(key);
  if (!f) {
    f = navBfs(nav.occ, cell);
    nav.fields.set(key, f); nav.lru.push(key);
    while (nav.lru.length > NAV_MAX_FIELDS) nav.fields.delete(nav.lru.shift());
  }
  return f;
}
// Walk `ahead` cells downhill and return that cell's centre as the steering waypoint. Local
// steering still does the last ~100px, so the waypoint only has to break the local minimum.
function navWaypoint(fld, occ, x, y, ahead) {
  let c = navNearestFree(occ, navCellAt(x, y));
  if (c < 0 || fld[c] >= NAV_INF) return null;
  for (let i = 0; i < ahead; i++) {
    const cx = c % NAV_GW, cy = (c / NAV_GW) | 0;
    let bn = c, bd = fld[c];
    for (let k = 0; k < 8; k++) {
      const nx = cx + NAV_DX[k], ny = cy + NAV_DY[k];
      if (nx < 0 || ny < 0 || nx >= NAV_GW || ny >= NAV_GH) continue;
      const n = ny * NAV_GW + nx;
      if (occ[n] || fld[n] >= NAV_INF) continue;
      if (fld[n] < bd) { bd = fld[n]; bn = n; }
    }
    if (bn === c) break;
    c = bn;
  }
  return { x: navCX(c), y: navCY(c) };
}
// Read-only accessors for the tests (never mutate, never allocate a field).
export function navForTest(mem) { return mem.nav || null; }
export const NAV_DIMS = { CELL: NAV_CELL, GW: NAV_GW, GH: NAV_GH };

// ---- CONTEXT STEERING: pick a movement dir toward `tgt`, avoiding walls/bombs/bullets ----
// 16 candidate directions; each gets interest (dot toward target) minus danger
// (proximity to walls, live bombs, incoming bullets, optionally enemies).
const DIRS = (() => { const a = []; for (let i = 0; i < 16; i++) { const th = i / 16 * Math.PI * 2; a.push([Math.cos(th), Math.sin(th)]); } return a; })();

function steer(bot, tgtx, tgty, state, bmem, sk, now = 0) {
  const r = radOf(state);
  // Only the ball-CARRIER may treat its ATTACKING net pocket as walkable (the dribble-in goal).
  const mouthX = state.ball.owner === bot.id ? (bot.team === 'A' ? FIELD.W : 0) : null;
  const [tox, toy] = unit(tgtx - bot.x, tgty - bot.y);
  // gather dangers: walls (static+built), live bombs, incoming enemy bullets.
  const walls = arenaOf(state).walls.concat(state.builtWalls);
  const look = 110;
  // ---- CLEARANCE FIELD: how much room is there at (x,y)? Negative = overlapping. ----
  // nearestOnWall is EXACT capsule geometry. The old code clamped to each wall's AABB, which for
  // an ANGLED wall invents a phantom obstacle: capsuleAABB of a 600x120 wall at 45° is 509x509,
  // so 8px inside that AABB corner a bot read 0px clearance where the true clearance is ~289px.
  // Field-builder arenas are full of angled walls, so this mattered most exactly there.
  const m = r + 34;
  const clearAt = (x, y) => {
    let c = 1e9;
    for (const w of walls) { const np = nearestOnWall(w, x, y); const d = hyp(x - np.x, y - np.y) - (np.rad || 0) - r; if (d < c) c = d; }
    // BOUNDARY — measured against the sim's own walkable area (pitch ∪ net pockets), so the GOAL
    // MOUTH is not an obstacle. The old per-axis test treated the end line as uniformly solid,
    // which repelled a carrier at x > FIELD.W - 55 (=1945) while the dribble-in goal needs
    // x > ~1971: the steering itself made the unsaveable walk-in unreachable (F6a).
    return Math.min(c, m - outsidePlayArea(x, y, r, mouthX));
  };
  // CRITICAL — the clearance where we ALREADY STAND. When a bot is wedged the sim cancels the
  // into-wall velocity component and parks it at clearance ~0. A naive "is this ray blocked" test
  // then flags the TANGENTIAL rays as blocked too (they sit at ~0 clearance as well), so the
  // least-blocked direction becomes straight backwards: the bot retreats, interest pulls it back,
  // and it oscillates forever — the reported "stuck in front of a steel wall". Judging every ray
  // RELATIVE to c0 is what breaks that: measured on a real 4-block build, toward -1.10 /
  // tangent -0.35 (wins) / away -1.00, where before tangent scored DEAD LAST.
  const c0 = clearAt(bot.x, bot.y);
  const LOOK = 120, SAMP = [0.34, 0.67, 1.0], HIT_PAD = 2, GRAZE_R = 22, W_BLOCK = 2.2, W_GRAZE = 0.6, W_HITFRAC = 0.6;
  const BODY_LOOK = 96, W_BODY = 1.1;
  // Carrying: how much MORE room the glued ball needs than the body, and what that costs a
  // direction. W_CARRY sits below W_BLOCK (2.2) on purpose — popping the ball is worse than a graze
  // (0.6) and better than walking into stone, so a carrier detours but never freezes.
  const carrying = state.ball.owner === bot.id;
  const ballGlueExtra = BALL_RADIUS * (state.settings.ballSizeMul || 1);
  const W_CARRY = 1.4;
  let best = null, bestScore = -1e9, safest = null, safeD = 1e9;
  for (const [dx, dy] of DIRS) {
    const interest = dx * tox + dy * toy;            // -1..1
    const px = bot.x + dx * look, py = bot.y + dy * look;
    // RAY-CAST blockage: sample ALONG the ray and only count a sample as blocked when it is worse
    // than where we already are. hitFrac records how far along the block begins, so an obstacle
    // 120px away is far less discouraging than one at our toes.
    let hitFrac = -1, cMin = 1e9;
    for (const s of SAMP) {
      const c = clearAt(bot.x + dx * LOOK * s, bot.y + dy * LOOK * s);
      if (c < cMin) cMin = c;
      if (hitFrac < 0 && c < Math.min(HIT_PAD, c0 - 4)) hitFrac = s;
    }
    const dBlock = hitFrac < 0 ? 0 : 1 - W_HITFRAC * hitFrac;
    const graze = clamp((GRAZE_R - (cMin - Math.min(0, c0))) / GRAZE_R, 0, 1);
    let danger = W_BLOCK * dBlock + W_GRAZE * graze;
    // ---- A GAP A BODY FITS THROUGH IS NOT A GAP A CARRIER FITS THROUGH ------------------------
    // The ball is glued at feet + aim x (radius + ballR) and sim.js:919 pops it LOOSE the instant
    // that spot touches stone, with a lockout so the carrier cannot re-collect. Every clearance test
    // above is sized to the BODY (r), so a dribbler happily threads a 70px gap and arrives without
    // the ball — measured at 7.7% of the legs the nav grid calls walkable. This adds a soft cost for
    // the extra ballR of room the carried ball needs, so a carrier prefers the wider way round while
    // a body still uses every gap it fits. Soft on purpose: a hard block would strand a carrier in
    // MAIN_FIELD's crate corridors, and finalize() already rotates the aim as the reactive backstop.
    if (carrying) {
      let cCarryMin = 1e9;
      for (const s of SAMP) {
        const c = clearAt(bot.x + dx * LOOK * s, bot.y + dy * LOOK * s) - ballGlueExtra;
        if (c < cCarryMin) cCarryMin = c;
      }
      danger += W_CARRY * clamp((ballGlueExtra - cCarryMin) / ballGlueExtra, 0, 1);
    }
    // dynamic threats accumulate separately and are added at their own weight, so "a wall is
    // that way" and "a bomb is about to go off" are no longer indistinguishable.
    let dyn = 0;
    // live bombs: flee the blast (weight by how soon it blows) — but NOT my own planted
    // bomb, which I'm deliberately standing on to trigger the rocket-jump.
    for (const b of state.bombs) {
      if (b.owner === bot.id) continue;
      const d = hyp(px - b.x, py - b.y);
      if (d < BOMB.radius + 40) { const soon = clamp(1 - b.fuse / BOMB.fuse, 0, 1); dyn = Math.max(dyn, (1 - d / (BOMB.radius + 40)) * (0.4 + 0.6 * soon) * sk.evade); }
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
      dyn = Math.max(dyn, align * (1 - rel / 340) * sk.evade * 0.9);
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
      dyn = Math.max(dyn, along * (1 - rel / 300) * sk.evade);
    }
    // ---- BODIES ARE OBSTACLES TOO -----------------------------------------------------------
    // MEASURED at L10 on MAIN_FIELD, over every tick where a bot WANTED to move and barely did:
    //   team-mate body 28.6% · enemy body 16.3% · pitch edge 2.3% · WALL 1.0% · rest = the legit
    //   build-windup / carry slow.
    // So once the wall-probe was fixed, "the walls are throwing the bots off" is mostly bots
    // SHOVING EACH OTHER: steer() reacted to another player only when it was bomb-launched or
    // moving >700px/s, and separatePlayers (sim.js:354) is a hard symmetric push with no
    // pass-through, so a parked body is a real obstacle the steering could not see.
    // Weight sits BELOW W_BLOCK (a wall still dominates) and ABOVE W_GRAZE, so a body BENDS the
    // path — it can never make a bot refuse to advance.
    // Skipped entirely when this bot WANTS contact (pressing a carrier, super body-strip, body
    // screen, pincer, ambush strip): those are contact plays, and BODY SCREEN in particular is
    // built on the shove — see its comment. A team-mate costs more than an enemy: there is
    // nothing to win by walking into your own partner.
    let bodyD = 0;
    {
      for (const q of Object.values(state.players)) {
        if (q.id === bot.id) continue;
        const rel = hyp(q.x - bot.x, q.y - bot.y);
        if (rel > r * 2 + BODY_LOOK) continue;
        // seekContact suppresses the ENEMY term only — a contact play is about walking into an
        // OPPONENT, and there is never a reason to walk into your own partner.
        if (q.team !== bot.team && (bmem.seekContact || !botCanSee(bot, q, state))) continue;
        const [qx, qy] = unit(q.x - bot.x, q.y - bot.y);
        const align = dx * qx + dy * qy;
        if (align <= 0.15) continue;                                    // only dirs pointing INTO them
        const close = clamp(1 - (rel - r * 2) / BODY_LOOK, 0, 1);
        const cost = align * close * (q.team === bot.team ? 1 : 0.7);
        if (cost > bodyD) bodyD = cost;
      }
    }
    danger += W_BODY * bodyD;
    danger += 2.2 * dyn;                 // the 2.2 stays explicit, on the DYNAMIC term only
    const score = interest - danger;
    if (score > bestScore) { bestScore = score; best = [dx, dy]; }
    if (danger < safeD) { safeD = danger; safest = [dx, dy]; } // most-open dir (escape route)
  }
  // ---- WALL DETOUR with a COMMITTED SIDE -------------------------------------------------
  // With exact clearance the two tangential directions around an obstacle are almost perfectly
  // SYMMETRIC (both score ~0), so the 0.55 low-pass averages them to nearly zero and the bot
  // deadlocks in front of the wall. (The old fuzzy proximity danger broke that tie by accident.)
  // A wall-follower needs to CHOOSE a side and STAY on it, so: when the straight line to the
  // target is blocked, pick the side whose way round is shorter — measured to the blocking
  // wall's nearer END, which is the actual thing we have to get past — and hold it for
  // `wallCommit` seconds. Brawl Stars/Fortnite get this from a navmesh; this is the cheap
  // equivalent for one convex obstacle and it is deterministic (no RNG, no per-bot mirroring).
  const moved = hyp(bot.x - (bmem.lastX ?? bot.x), bot.y - (bmem.lastY ?? bot.y));
  bmem.lastX = bot.x; bmem.lastY = bot.y; bmem.movedLast = moved;
  // (a) HARD PRESS — a genuine wedge is ~0px/tick (the sim cancels the into-wall component).
  //     The slowest LEGAL movement is a build wind-up under slow stacks (~0.8px/tick), so 0.6 is safe.
  if (moved < 0.6 && (bmem.wantMove || 0) > 0.5) bmem.pressTicks = (bmem.pressTicks || 0) + 1;
  else bmem.pressTicks = 0;
  // (b) NO-PROGRESS RATCHET — computed in finalize() against the FINAL target (and against PATH
  //     length when the flow field knows it), not here. Measuring it against steer's own target
  //     was wrong once the flow field started supplying waypoints: the waypoint moves every
  //     navLag seconds, so the ratchet reset constantly, cried "stalled" and forced a sideways
  //     detour that fought the field — the bot crawled the last stretch at 85px/s of 158.
  const dTgt = hyp(tgtx - bot.x, tgty - bot.y);
  const stalled = !!bmem.stalledFlag;
  bmem.stuck = bmem.pressTicks || 0; // kept for TACTIC 11's corner-escape gate

  // Is the straight line to the target actually blocked? (cheap: reuse the clearance field)
  const [ux, uy] = [tox, toy];
  let straightBlocked = false;
  for (const s of SAMP) { if (clearAt(bot.x + ux * LOOK * s, bot.y + uy * LOOK * s) < Math.min(HIT_PAD, c0 - 4)) { straightBlocked = true; break; } }

  if ((straightBlocked || stalled || (bmem.pressTicks || 0) >= 12) && dTgt > 46) {
    const commit = sk.wallCommit != null ? sk.wallCommit : 0.6;
    if (!bmem.detourUntil || (now) > bmem.detourUntil) {
      // choose the side: which perpendicular gets us past the blocker's nearer end sooner?
      let bw = null, bd = 1e9;
      for (const w of walls) { const np = nearestOnWall(w, bot.x, bot.y); const d = hyp(bot.x - np.x, bot.y - np.y); if (d < bd) { bd = d; bw = w; } }
      let sgn = (idHash(bot.id) & 1) ? 1 : -1; // deterministic fallback
      if (bw) {
        // the blocker's two extreme points along OUR perpendicular; head for the closer one
        const pxn = -uy, pyn = ux;
        const ex = bw.angle != null ? Math.cos(bw.angle) * bw.hl : bw.w / 2;
        const ey = bw.angle != null ? Math.sin(bw.angle) * bw.hl : bw.h / 2;
        const cx = bw.cx != null ? bw.cx : bw.x + bw.w / 2, cy = bw.cy != null ? bw.cy : bw.y + bw.h / 2;
        const e1 = (cx + ex - bot.x) * pxn + (cy + ey - bot.y) * pyn;
        const e2 = (cx - ex - bot.x) * pxn + (cy - ey - bot.y) * pyn;
        sgn = Math.abs(e1) <= Math.abs(e2) ? Math.sign(e1) || 1 : Math.sign(e2) || 1;
      }
      bmem.detourSide = sgn; bmem.detourUntil = (now) + commit;
    }
    const sgn = bmem.detourSide || 1;
    // slide ALONG the obstacle (perpendicular to the target line) with a little forward lean,
    // so the bot makes lateral progress instead of grinding into the face.
    const wx = -uy * sgn + ux * 0.25, wy = ux * sgn + uy * 0.25;
    // ...but never into something even more solid: keep it only if it is genuinely clearer.
    // ...but never into something even more solid, and THIS TEST MUST BE A RAY, NOT A POINT.
    // THE BUG THAT PUT BOTS INSIDE WALLS FOR 40 SECONDS. It used to sample clearance at the
    // single point LOOK (120px) along the tangent. Every wall on MAIN_FIELD is THINNER than
    // that probe — the hardWalls are ht=16 capsules (32px thick) and the crates are 50px boxes —
    // so a probe aimed straight at a wall 40px away lands on the FAR SIDE, in free space, reads
    // +41px of clearance and the guard passes. The bot then commits to a "detour" that is a
    // direct march into the wall face, re-commits every wallCommit seconds because the geometry
    // never changes, and grinds there until the ball comes to it.
    // MEASURED on MAIN_FIELD at skill 0.50, 6 matches x 60s, paired seeds: longest single pinned
    // run 15.65s -> 0.73s, pinned-while-wanting-to-move 3.25% -> 0.58%. The reason a whole
    // session of tests missed it is §00 of BOT_HANDOFF: the DEFAULT arena's walls are 120px
    // boxes, thick enough to swallow the probe, so the bug is invisible there.
    // Sampling the same SAMP fractions as the interest loop keeps one geometry rule in the file.
    const rayMin = (dx, dy) => { let c = 1e9; for (const s of SAMP) { const v = clearAt(bot.x + dx * LOOK * s, bot.y + dy * LOOK * s); if (v < c) c = v; } return c; };
    if (rayMin(wx, wy) > Math.min(HIT_PAD, c0 - 4)) best = unit(wx, wy);
    else if (safest) best = safest;
  } else if (bmem.detourUntil && (now) > bmem.detourUntil) bmem.detourUntil = 0;
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
  // ---- THE BALL IS NEVER HIDDEN FROM A BOT (2026-07-26, the user's ask, and it is a FAIRNESS FIX) --
  // A PLAYER always knows where the ball is: bushes conceal PLAYERS, never the ball (the renderer
  // draws it unconditionally), and when it leaves the screen `client.js:5917` pins an arrow to the
  // nearest edge pointing at it. The old rule made a BOT blinder than the human it plays against.
  //
  // It was also blind on the wrong geometry. The loose-ball test called `pointInBush(x, y)`, which
  // takes no state and reads the DEFAULT arena's three rectangles on EVERY layout (shared/arena.js:37
  // — still true, still worth fixing for the ambush spots that also read it). So the ball was hidden
  // where no bush exists and revealed inside the ones that do. Measured over 28 matches, 7 layouts
  // (`bot-skill-census.mjs`): both teams blind to a loose ball for 18.6% of loose ticks on the pitch
  // that ships — worst single spell 20.9s — 31.3% / 48.5s on the classic layout, 44.7% / 37.4s on a
  // generated one. A team that does not know where the ball is cannot go and get it, which is the
  // "they struggle to get the objective" report.
  //
  // THIS IS NOT X-RAY. Enemy BODIES keep their fog: `botCanSee` (screen-shaped VIEW_BOX + bush
  // concealment) and `perceivedPos` are untouched, so every SHOT still needs sight and a bot can
  // neither snipe out of fog nor track a bushed enemy. Only the BALL — the thing the player's own
  // HUD never hides — is always known. `visible`/`age` are kept in the return shape (callers read
  // them) and are now constant: nothing dead-reckons the ball any more.
  const visible = true;
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
// Seconds a bot with an armed commitment (bomb fuse / wall wind-up / catapult / kick-and-fly) should
// be assumed unable to move. BOMB.fuse is 1.725s and BUILD_WINDUP 0.5s; 1.2s is between them, so the
// role goes to the free bot in both cases without over-punishing a wind-up that is nearly done.
const FROZEN_ROOT_S = 1.2;
// How much ground a persona will concede (or claim) on a loose ball, and the radius inside which no
// persona may concede at all. 320px is one MIN_SEP — enough to beat the positional advantage an
// escort persona gets for free, small enough that it never overrides a real distance gap.
const CHASE_BIAS_PX = 320, CHASE_EMERGENCY_PX = 240;
export function assignRoles(state, team, mem, dt) {
  const belief = updateBelief(state, team, mem);
  const bots = Object.values(state.players).filter((p) => p.team === team);
  const prev = mem.teams[team];
  if (bots.length === 0) { mem.teams[team] = null; return null; }
  if (bots.length === 1) { const r = { onBall: bots[0].id, support: null, mode: ballMode(state, team), belief }; mem.teams[team] = r; return r; }

  const b = state.ball;
  // Assign roles around what we can SEE. The BALL is always known now (see updateBelief), so this
  // is the live ball/carrier; `belief` is kept as the single source so any future fog change has one
  // place to change.
  const focus = belief.visible ? (b.owner && state.players[b.owner] ? state.players[b.owner] : b) : belief;
  // WHO GOES FOR IT: reach measured in GROUND, with a rooted bot charged the ground it cannot cover.
  // A bot standing on a live bomb fuse or holding a wall wind-up physically cannot move for up to
  // BOMB.fuse (1.725s), yet it still won the role whenever it was the nearest body — and the other
  // bot then held its shape, so NOBODY arrived. That is a large part of "they struggle to get the
  // objective". The penalty is expressed as `speed x FROZEN_ROOT_S` so it stays in the same px unit
  // as SWITCH_MARGIN below, and it is derived from the sim's own speed rather than a magic number.
  // NOTE the deliberate non-fix: we do NOT cancel the commitment. The charge is already spent, and
  // aborting wind-ups was measured at builds 1.75 -> 0.38/match (BOT_HANDOFF, refuted list). Route
  // the job to the bot that can actually do it instead.
  const isRooted = (p) => {
    const bm = (mem.bots && mem.bots[p.id]) || {};
    return !!(bm.bombHold || bm.buildHold || bm.cata || bm.fly);
  };
  const reach = (p) => {
    const spd = Math.max(1, (CHARACTERS[p.char] || CHARACTERS[DEFAULT_CHAR]).speed * (state.settings.speedMul || 1));
    // PERSONA `chase`: how much this bot WANTS the loose ball, as ground it is willing to concede.
    // A multiplicative 10% tie-break was measured useless — a Bodyguard's own escort station keeps it
    // near the play, so geometry beat the bias and the Bodyguard took 72.9% of the chases against a
    // Ball Hawk's 27.1%. As an additive px bias it expresses the doc's actual rule ("Bodyguard rarely
    // fetches; only if the team has no valid chaser or the ball is within an emergency radius"):
    // a Bodyguard concedes up to CHASE_BIAS_PX of ground, a Ball Hawk claims it.
    // AND THE EMERGENCY EXEMPTION IS ABSOLUTE: inside CHASE_EMERGENCY_PX no persona may concede a
    // ball at its feet, which is what keeps design rule 3 ("both bots must never refuse") true even
    // for the persona that wants it least.
    const pr = (mem.personaFor && mem.personaFor[p.id]) ? personaByName(mem.personaFor[p.id]) : personaOf(p.slot, mem.personaRot || 0);
    const raw = hyp(focus.x - p.x, focus.y - p.y);
    const want = state.ball.owner ? 0.5 : (pr.chase != null ? pr.chase : 0.5);
    const bias = raw < CHASE_EMERGENCY_PX ? 0 : (0.5 - want) * CHASE_BIAS_PX;
    return raw + bias + (isRooted(p) ? spd * FROZEN_ROOT_S : 0);
  };
  const d0 = reach(bots[0]), d1 = reach(bots[1]);
  // candidate: best reach to the focus is onBall (deterministic slot tie-break).
  let onBall = d0 <= d1 ? bots[0].id : bots[1].id;
  // hysteresis: keep the previous onBall unless the other is clearly closer for a moment.
  const hold = prev && (mem.t - (prev.since || 0)) < MIN_HOLD;
  if (prev && prev.onBall && state.players[prev.onBall]) {
    const cur = state.players[prev.onBall];
    const other = bots.find((p) => p.id !== prev.onBall);
    const dCur = reach(cur);
    const dOther = other ? reach(other) : 1e9;
    // A ROOTED INCUMBENT LOSES THE ROLE OUTRIGHT — the hysteresis does not protect it. Both the
    // 120px margin and the 0.5s hold exist to stop role THRASH, and a bot on a bomb fuse cannot
    // thrash: it is committed for ~1.7s either way, so handing the job to the free bot is stable by
    // construction. Without this the incumbent kept the chase whenever the reach penalty (speed x
    // 1.2s) landed inside the switch margin, which is exactly the "nobody went for it" case.
    if (other && isRooted(cur) && !isRooted(other)) onBall = other.id;
    else if (hold || dOther > dCur - SWITCH_MARGIN) onBall = prev.onBall;
    else onBall = other.id;
  }
  // SUPPORT = the off-ball bot nearest the focus, i.e. the best pass outlet. With one off-ball bot
  // (2v2) that is the same pick `bots.find(...)` made, so 2v2 behaviour is unchanged.
  const off = bots.filter((p) => p.id !== onBall);
  let support = null, bestD = Infinity;
  for (const q of off) { const d = hyp(focus.x - q.x, focus.y - q.y); if (d < bestD) { bestD = d; support = q.id; } }
  // COVER = everyone else (only exists at 3v3+). They get a LANE index so they hold distinct
  // defensive spots instead of stacking on the support spot. Ordered by SLOT, not by distance, so
  // a lane doesn't flip every tick as players move.
  const cover = off.filter((q) => q.id !== support).sort((a, b) => (a.slot | 0) - (b.slot | 0));
  const lane = {};
  cover.forEach((q, i) => { lane[q.id] = i; });
  const since = (prev && prev.onBall === onBall) ? (prev.since || mem.t) : mem.t;
  // `chaser` = the ONE bot this team has committed to a loose ball. Null while anybody holds it, so
  // "am I the chaser?" is a single question the whole file can ask instead of re-deriving "am I
  // nearest?" in three places. The commitment itself (and its reaction delay) lives in decideBot.
  const chaser = b.owner ? null : onBall;
  const r = { onBall, support, chaser, mode: ballMode(state, team), since, belief, lane, lanes: cover.length };
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

// ---- WHERE TO WALK TO TAKE THE BALL OFF SOMEBODY (the user's ask #2) ------------------------
// Walking at a carrier's BODY is a tail chase: you arrive where they were. This returns where they
// will BE when you get there, so the presser cuts the run instead of following it — and it biases
// the point slightly toward the goal the carrier is attacking, because that is the side the ball has
// to come through and the side a strip is worth most.
//
// NO NEW PHYSICS MODEL (ARCHITECTURE-REVIEW §2.1: seven of the nine live defects are bot-ai
// re-deriving what sim.js already owns). Both speeds are the sim's own: `CHARACTERS[char].speed x
// settings.speedMul`, with `carrySpeedMul` applied to the carrier exactly as sim.js does it. The
// only free parameters are the two clamps, and `sk.leadGain` scales the lead so a weak bot mis-leads
// — the same graded-execution knob the aim already uses, rather than a coin flip.
function speedOf(pl, state, carrying) {
  const base = (CHARACTERS[pl.char] || CHARACTERS[DEFAULT_CHAR]).speed * (state.settings.speedMul || 1);
  return Math.max(1, base * (carrying ? (state.settings.carrySpeedMul || 1) : 1));
}
export function interceptPoint(me, carrier, state, sk) {
  const mySpd = speedOf(me, state, state.ball.owner === me.id);
  const dist = hyp(carrier.x - me.x, carrier.y - me.y);
  // How long until I get there. Capped at 0.9s: past that the carrier's current heading is a guess,
  // and over-leading walks the presser into space (the "recomputed target treadmill" family).
  const tau = clamp(dist / mySpd, 0, 0.9) * (sk && sk.leadGain != null ? sk.leadGain : 1);
  const cvx = carrier.vx || 0, cvy = carrier.vy || 0;
  const x = carrier.x + cvx * tau, y = carrier.y + cvy * tau;
  // MEASURED AND REMOVED — "shade the point 15% toward the goal the carrier is attacking, to cut the
  // lane". It reads well and it is wrong whenever the presser is ALREADY goal-side: the shading then
  // points AWAY from the carrier, so the bot backs off instead of closing. Caught by
  // test-bot-newskills.mjs's super-body-strip fixture, which passed on the baseline and failed with
  // the shading in: a super bot 115px from a standing carrier hovered at 115-133px, never made body
  // contact, and the "strip" the test saw was the carrier simply kicking the ball away 1.6s later.
  // The velocity lead is the part with evidence behind it; a lane-cut term needs its own measurement
  // before it goes back in, and it would have to be perpendicular to the approach, not along it.
  return { x: clamp(x, 20, FIELD.W - 20), y: clamp(y, 20, FIELD.H - 20) };
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
    for (const p of Object.values(state.players)) {
      if (p.team !== team || !p.isBot) continue;
      // PERSONALITY: same level, different temperament, keyed to the SLOT so the two teams mirror.
      // `mem.personaFor[id]` forces a persona for one bot. Used by test-bot-personas.mjs to measure a
      // single identity in isolation, and it is the hook the research doc's "partner reacts to the
      // human's style" idea would use — pick it at match start, never mid-match.
      const forced = mem.personaFor && mem.personaFor[p.id];
      const sk = withPersona(memSkillVec(mem, team, p.id), p.slot, mem.personaRot || 0, forced);
      // difficulty as mechanical power: harder bots charge full sooner + cool down faster
      // BREAK THE CARD/SKILL DOUBLE-DIP. RARITY_BY_LEVEL (shared/bot-buffs.js — it lived in server.js
      // until the CARD_POWER_BAND change moved it beside the rarity->buff table) hands a bot its best CARDS at
      // exactly the levels where this skill vector also spikes, and the sim multiplies the two:
      // a L9 bot ran chargeRate 2.05 x cardShot 1.25 = 2.56x and cdMul 0.55 x cardUtil 0.80 = 0.44,
      // so difficulty grew ~quadratically while the player's own power grows only with their album.
      // sk.chargeRate/sk.cdMul are now read as the FINAL INTENDED multiplier and the cards are
      // divided back out here, so the cards still drive the badge/dossier and speedBuff but no
      // longer secretly re-multiply the difficulty.
      p.chargeRate = clamp((sk.chargeRate != null ? sk.chargeRate : 1) / (p.cardShot || 1), 0.35, 6);
      p.cdMul = clamp((sk.cdMul != null ? sk.cdMul : 1) / (p.cardUtil || 1), 0.30, 2.0);
      // FAIRNESS CEILING on the effective charge ramp, so no future retune can quietly rebuild the
      // 9.5x monster: cap what the SIM will actually compute (chargeRate x cardShot x super).
      // 2.50 effective => FULL_CHARGE in 1.42/2.50 = 0.57s, a wind-up the player can still read.
      p.chargeRate = Math.min(p.chargeRate, 2.50 / ((p.cardShot || 1) * (p.power ? SUPER_CHARGE_RATE : 1)));
      // EXTREME cheat: keep overcharge topped up so it can break a keeper / blast a lane at
      // will (a steady cheat — the STOCHASTIC part is its aim + charge, not this).
      // PERMANENT SUPER DELETED. This re-granted p.power (and powerUses) on EVERY tick they were
      // false, so the top tier always had overcharge available: the only kick a keeper cannot
      // catch, on tap, forever. Combined with chargeRate 3.40 x cardShot 1.40 x SUPER_CHARGE_RATE 2
      // it reached FULL_CHARGE in 0.15s. A bot now EARNS overcharge off real hits, exactly like a
      // player. See the fairness clamp below for the charge-rate ceiling.
      out[p.id] = decideBot(p, role, state, mem, sk, dt);
    }
  }
  return out;
}

// ==================== WALL-BOMB CANNON: "put a bomb near a wall to FLY FURTHER" ==============
// The sim's ACTUAL rule (sim.js wallCannonMul + explode):
//   * a wall boosts the launch only if it lies within BOMB_WALL_DIST (150px) of the BOMB and inside
//     a ±35° cone (BOMB_WALL_COS 0.82) OPPOSITE the launch — i.e. the wall is BEHIND the bomb,
//   * closer wall = stronger: mul = 1 + (1 - d/150) * (peak - 1); steel peaks at 1.55×,
//   * a static wall AHEAD in the launch cone CANCELS the jump outright (explode's jumpBlocked),
//   * the planter only gets the self-launch at all while it is within BOMB_CENTER_R (95px) of the
//     bomb — and useSpecial LOBS the bomb up to BOMB_LOB_RANGE along the (sax,say) drag.
//
// WHY THIS IS NOT A "WALK TO A PAD" ANY MORE. The previous version computed a stand-pad 52px off a
// wall face and walked there. Measured over 12 matches at skill 0.82: 449 bot-ticks reached "a pad
// exists" and ZERO ever reached "I am standing on it" — 17 walk episodes made a MEDIAN OF 9px of
// progress toward a pad 87px away over 26 ticks, when a 158px/s bot should cover 68px. It cannot
// work: steer() judges a direction blocked when a clearance ray (LOOK 120px) drops under 2px, so a
// target 52px off a wall face reads as inside an obstacle, the wall-detour branch commits to a
// tangent, and the bot orbits. 65% of the abandoned episodes then ended on `bombCooldown` because
// coopPush (a feet plant with nothing behind it) had spent the charge — tag counts coopPush 118-150
// vs cannonSetup 9-14. Net effect: 5% of self-launches were wall-boosted, i.e. exactly the ~7%
// chance rate. Every wall-cannon in the game was an accident.
//
// So: DON'T MOVE THE BOT — MOVE THE BOMB. Lob it BACKWARDS into the gap between us and the wall
// (wall → bomb → bot, flying away from the wall). Costs no extra bomb charge and no walking, and
// it also EXTENDS reach: a wall up to 150+85 = 235px away can still be turned into a cannon.
// Candidates are all < BOMB_CENTER_R so the planter keeps its on-centre self-launch.
// MEASURED OPPORTUNITY (8 matches, 11200 sampled bot positions, flight dir toward the ball) — this
// is the ceiling any wall-cannon rate has to live under, and it is why the two levers below exist:
//   a wall would cannon a plain FEET plant:            6.3% of positions
//   ...allowing a <= 85px LOB BACK:                   10.4%
//   ...also allowing +-20deg of FLIGHT ROTATION:      16.2%   (+-30deg buys only 18.4%)
// The pre-fix game measured 5-7% of self-launches boosted, i.e. exactly the feet-plant chance rate.
const CANNON_LOB = [0, 35, 60, 85]; // 0 = the plain feet plant, i.e. the baseline each lob must beat
// Angling the jump is the second lever: a rocket-jump that flies 20deg off still covers the ground it
// was meant to cover. Capped at 20deg (~137px of lateral error over a 400px launch) and only taken
// when it EARNS the deviation — otherwise the bot would twist its flight line for a 1.02x nothing.
const CANNON_ROT = [0, 0.175, -0.175, 0.349, -0.349]; // rad: 0, +-10deg, +-20deg
const CANNON_ROT_MIN_MUL = 1.15;
// How far along the flight line to check for stone before committing a launch. Measured glide is
// 653px on open ground and 869px with a wall backing the bomb (BOT_HANDOFF round 6, feature 4), so
// 660 is the honest "a plain jump goes about this far" number rather than a new invented constant.
const CANNON_FLIGHT_PROBE = 660;

// ---- TOOL USE IS A RATE, NOT A CLIFF (see test-bot-partner.mjs for the measurement) -------------
// Both bomb-for-MOBILITY plays used to be gated on `sk.toolSkill >= 0.72`. skillVec interpolates
// toolSkill as 0.32 at t=0, 0.58 at t=0.25 (`easy`), 0.85 at t=0.50 (`normal`), so that gate opens
// only above t~0.38 and EXCLUDES `easy`. DIFFICULTY_LEVELS gives the human's PARTNER veryEasy or easy
// on SEVEN of the twelve levels (0,1,3,4,6,8,11), so on most of the ladder the bot standing next to
// the player never planted a bomb at all: measured 0.21-0.29 plants and 0.04-0.13 rocket-jumps per
// match at partner skill 0.25, against 5.42 and 4.00 at 0.50. A 20x cliff on one threshold.
// (The branch comment recorded this gate being lowered 0.9 -> 0.72 for exactly this reason; 0.72 was
// still one tier too high.) A weak bot should use its tools RARELY AND BADLY, not never — so the gate
// now admits `easy` and the RE-ARM INTERVAL carries the difficulty. veryEasy (0.32) stays out on
// purpose: level 0 is אימון, tutorial fodder.
const TOOL_MOBILITY_MIN = 0.45;
// A weak bot NOTICES the opportunity only some of the time — that is what carries the difficulty now
// the cliff is gone. Probability ramps from 0 at TOOL_MOBILITY_MIN to 1 at 0.95, so `easy` (0.58)
// takes ~26% of the chances it gets and `hard`/`extreme` (0.97/1.00) take all of them, exactly as
// before. Deterministic — seededNoise over a per-bot hash and a ~1.3Hz time bucket, no RNG in the
// sim path — so replays stay reproducible.
// A SKILL-SCALED RE-ARM was tried first and rejected on measurement: stretching the interval to 7.5s
// at easy still produced 5.92 bombs/match vs `normal`'s 6.67, because these branches are limited by
// how often their preconditions line up, not by the timer. It flattened the ladder instead of ranking it.
function toolNotice(sk, p, mem) {
  const pr = clamp(((sk.toolSkill || 0) - TOOL_MOBILITY_MIN) / 0.50, 0, 1);
  if (pr >= 1) return true;
  return seededNoise(Math.floor(mem.t * 1.3) + idHash(p.id) * 0.011) < pr * 2 - 1;
}


// ---- ASK #2: "aim the shot at the enemy more, pushing him back further" ----------------------
// The sim pushes a hit body along the BULLET'S TRAVEL DIRECTION (sim.js:1382 `t.kvx += bnx * kb`), so
// a bot cannot choose the push direction independently of where it is standing — the only lever is
// WHEN to fire. That makes this a timing rule, and the measured stakes are large:
//   * a full hit is 343px of drift at charge 1.0 vs 250px at the old 0.71 clamp (ask #1 buys that);
//   * pushing a chaser at 0deg to their heading makes them arrive 1.18s SOONER; 90deg is neutral;
//     only 150-180deg buys time (+1.60/+1.93s). Roughly half of `clearMarker`'s shots were gifts.
// So `pushValue` scores the push a shot from HERE would deliver, and at L5+ a bot waits (briefly) for
// a shot worth taking instead of firing into its own interest. Never a hard veto: a strip is worth
// having even at a bad angle, and the watchdog/charging path still owns the release.
//   +1  the push moves them away from the ball (or the goal they are attacking)
//   -1  it shoves them toward it
function pushValue(shooter, target, state, aimAtBall) {
  const [ux, uy] = unit(target.x - shooter.x, target.y - shooter.y);   // = the bullet's travel dir
  const b = state.ball;
  const ref = aimAtBall !== false ? { x: b.x, y: b.y } : { x: enemyGoalX(target.team), y: GY };
  const [rx, ry] = unit(ref.x - target.x, ref.y - target.y);           // target -> the thing they want
  const toward = ux * rx + uy * ry;             // +1 = we push them straight at what they want
  const head = hyp(target.vx || 0, target.vy || 0) > 60 ? unit(target.vx, target.vy) : null;
  const withRun = head ? ux * head[0] + uy * head[1] : 0;              // +1 = we push them along their run
  return -0.65 * toward - 0.35 * withRun;       // high = a push they do not want
}

// ---- "LEVEL 5 AND ABOVE", THE USER'S OWN DEFINITION -----------------------------------------
// He was explicit about what it means: *"randomly from level 1 very few times, to almost always
// level 5 and above."* So it is a RAMP, not a switch. Enemy skill by level (difficulty.js):
//   L0 0.05 · L1 0.13 · L2 0.22 · L3 0.31 · L4 0.40 · L5 0.49 · … · L11 1.00
// which gives, through `levelChance` below:
//   L0 never · L1 ~7% · L2 ~28% · L3 ~50% · L4 ~72% · L5 ~94% · L6+ ~always
//
// WHY A PROBABILITY IS ALLOWED HERE, when `decisionHz`/`mistakeP` are on the refuted list: those
// were stochastic HANDICAPS — a bot that randomly fails to act on what it already decided. This is a
// frequency ramp on an ABILITY, the same shape as `toolNotice` and `preChargeP`, both of which ship
// and both of which rank. A weak bot uses the trick rarely and a strong one uses it always; nobody
// gets a coin flip inserted between deciding and acting.
//
// Deterministic: seededNoise over a per-bot hash, a per-behaviour key and a ~1.1Hz time bucket, so a
// replay of the same match makes the same choices and A/Bs stay paired. NEVER Math.random here.
const L5_LO = 0.10, L5_HI = 0.49;
function levelRamp(sk) { return clamp(((sk.t || 0) - L5_LO) / (L5_HI - L5_LO), 0, 1); }
function levelChance(sk, p, mem, key, hz = 1.1) {
  const pr = levelRamp(sk) * 0.94 + (levelRamp(sk) >= 1 ? 0.06 : 0);   // ~94% at L5, ~100% above it
  if (pr <= 0) return false;
  if (pr >= 1) return true;
  return seededNoise(Math.floor(mem.t * hz) + idHash(p.id) * 0.011 + idHash(key) * 0.007) < pr * 2 - 1;
}

// ============================ THE FOUR NEW BEHAVIOUR GATES ==================================
// All on `sk.t`, the RAW difficulty scalar skillVec now exposes — NEVER on toolSkill, which
// saturates at 0.85 by L5 and therefore cannot rank anything above it (see skillVec's comment
// and the design doc §2.2/§4). Enemy-side coverage, arithmetic from DIFFICULTY_LEVELS:
//
//   gate   behaviour                          enemy levels        partner levels
//   0.50   B1a super discipline (hold)        L5–L11              L2, L5, L7, L9, L10
//   0.68   B2  goalkeeper                     L7–L11              L2, L10
//   0.82   B1b super body-strip / B3 far wall L8–L11              L10
//   0.92   B4  pincer                         L9–L11              —
//
// so a player climbing the ladder meets a new, NAMEABLE behaviour at L5, L7, L8 and L9 instead
// of seven levels of "slightly faster reactions". That spread IS the feature.
const T_SUPER_HOLD = 0.50;  // B1a — protect the overcharge for the one kick a keeper can't catch
const T_KEEPER     = 0.68;  // B2  — play a real goalkeeper instead of chasing
const T_SUPER_BODY = 0.82;  // B1b — spend the overcharge as a body-strip on contact
const T_FAR_WALL   = 0.82;  // B3  — push the built wall out with buildDist
const T_PINCER     = 0.92;  // B4  — break MIN_SEP and trap the carrier from two sides
// round 6 additions, placed in the gaps: 0.58 kick-and-fly, 0.74 catapult (see their constants)
// SPREAD ACROSS THE LADDER, not stacked. The design rule this file already follows (§4 / the gate
// table above) is that each new nameable behaviour should arrive at a DIFFERENT level, so a player
// climbing meets something new instead of one step where everything switches on. Both of these first
// landed on 0.50 together and the ladder measured spread 1.04 (up from 0.50 — the features are real)
// but Spearman rho 0.40: two powerful plays arriving at the same anchor scrambled the middle order.
// Placed in the two free slots between the existing 0.50 / 0.68 / 0.82 / 0.92 gates.
const T_KICK_FLY   = 0.58;  // C1  — kick the ball ahead, then bomb-jump after it (requested)
const T_CATAPULT   = 0.74;  // C2  — the team wall+bomb catapult (requested)
// C1 sizing: the launch covers ~650px of open ground (measured), so the ball is kicked a little
// SHORTER than that — landing past the ball is fine (we run back a step), landing short of it is
// not, because an opponent gets there first.
const FLY_DIST = 560;
// C2 geometry: how far BEHIND the carrier's predicted position the bomb goes. Inside BOMB.radius
// (168) so the carrier is pushed, and inside BOMB_CENTER_R (95)... of the PLANTER, who stands on it.
const CATA_BACK = 110;
const CATA_WINDOW = 3.4;    // seconds the whole play may take before it gives up
// Default 0 (not 0.5): an unknown/legacy skill object must get NO new behaviour rather than
// silently landing in the middle of the ladder. Every real path supplies `t` (skillVec sets it;
// BOT_SKILL's tiers carry their own).
const skT = (sk) => (sk && typeof sk.t === 'number' ? sk.t : 0);

// Plays that are ALLOWED to walk away from a loose ball the bot is nearest to — the user's own
// "unless doing a trick, hiding in bushes or something". Everything else must go and get it.
const FETCH_EXEMPT = new Set([
  'ambushLurk', 'bushSteal', 'ambushWall', 'ambushStrip', 'receivePass', 'catapultSetup',
  'catapultWall', 'catapult', 'goalScreen', 'screenWall', 'blockDrive', 'bodyScreen', 'goalKeep',
  'dodge', 'cornerEscape', 'chaseJump', 'catchUpJump', 'coopPush', 'wallCannonJump',
]);

// ---- B1b — how close a super bot will walk in for a BODY STRIP instead of shooting ----------
// A bot moves ~142px/s (CHARACTERS.player.speed 158 x settings.speedMul 0.9), so 220px is ~1.5s
// of closing — comfortably inside OVERCHARGE_TTL (4s), which is what stops this from being a
// commitment the bot cannot honour before its ring expires.
const SUPER_BODY_CLOSE = 220;

// ---- B3 — DISTANT WALL: turn "where the wall should be" into the sim's buildDist ------------
// The sim reads `p.aimMag = clamp(inp.buildDist, 0, 1)` and places the wall at
// BUILT_WALL.offset(60) + buildDist * BUILD_DIST_MAX(120), i.e. up to 180px out. finalize() never
// emitted buildDist, so EVERY bot wall in the game landed at 60px — inside the bot's own body —
// while a player can push theirs to 180. It is the only implemented player-vs-bot capability gap
// and it costs zero sim work (design §4 A1 / B3).
// TELL: the wall appears a clear body-length IN FRONT of the bot instead of at its feet, after
// the same BUILD_WINDUP ghost telegraph players already see.
// COUNTER: a built wall is hp3 and one full-charge shot destroys it; or walk round it; and
// BUILD_RELOAD is 15s per charge, so a spent wall is 15s of free lane.
// ---- WALL PLANNING: would this wall get in OUR OWN way? --------------------------------------
// Requested ("better obstacle awareness and wall planning"). A built wall lives for BUILT_WALL.ttl
// and the bots had no notion of their own team's lines at all, so a defensive screen could land on
// top of a team-mate (who then has to walk round it — and body/wall blocking is 45%/1% of the
// stuck ticks, so we were manufacturing our own obstacles) or straight across the lane our own
// carrier was about to run. Two cheap exact tests, applied at every DEFENSIVE build site.
// The deflect set-piece is deliberately exempt: its whole purpose is a wall in the attacking lane
// to bank a shot off.
function wallSpotOk(state, p, team, cx, cy) {
  for (const q of Object.values(state.players)) {
    if (q.team !== team || q.id === p.id) continue;
    if (hyp(q.x - cx, q.y - cy) < 90) return false;              // don't wall in your own partner
  }
  const owner = state.ball.owner ? state.players[state.ball.owner] : null;
  if (owner && owner.team === team && pointSegDist(cx, cy, owner.x, owner.y, enemyGoalX(team), GY) < 80) return false;
  return true;                                                    // ...or our own lane to their goal
}

function wallReach(sk) { return skT(sk) >= T_FAR_WALL ? BUILT_WALL.offset + BUILD_DIST_MAX : BUILT_WALL.offset; }
// How far a bot may drift during a wall wind-up before the wall stops landing where the play asked
// (see the latch at the top of finalize, which LEASHES the steering target to this window). The
// wall is BUILT_WALL.len 176px long and .thick 32px, so 46px of LATERAL slide still spans the lane
// it was built across; the along-axis needs no separate slack because `wallPush` already clamps the
// drag into [offset, reach].
const BUILD_LAT_TOL = 46;
// The buildDist that puts the wall on (wx,wy) when building along the unit aim (nx,ny). Clamped
// into the tier's reach, so below the gate this is exactly 0 — today's at-your-feet wall.
function wallPush(p, wx, wy, nx, ny, sk) {
  const along = (wx - p.x) * nx + (wy - p.y) * ny;
  return clamp((clamp(along, BUILT_WALL.offset, wallReach(sk)) - BUILT_WALL.offset) / BUILD_DIST_MAX, 0, 1);
}

// Mirrors sim.js wallCannonMul for STATIC stone (the strong peak, 1.55×). Built walls also cannon,
// weakly and only while intact, and are deliberately ignored: a bot must not plan a launch around a
// wall an opponent can shoot down between the plant and the blast.
function cannonMulAt(state, bx, by, dx, dy) {
  let mul = 1;
  for (const w of arenaOf(state).walls) {
    const np = nearestOnWall(w, bx, by);
    const vx = np.x - bx, vy = np.y - by, d = hyp(vx, vy);
    if (d < 1 || d > BOMB_WALL_DIST) continue;
    if ((vx / d) * -dx + (vy / d) * -dy > BOMB_WALL_COS) {
      const m = 1 + (1 - d / BOMB_WALL_DIST) * (BOMB_WALL_CANNON_STATIC - 1);
      if (m > mul) mul = m;
    }
  }
  return mul;
}
// Mirrors explode()'s jumpBlocked: a static wall AHEAD in the launch cone kills the jump entirely,
// so a candidate that trips it is strictly worse than not lobbing at all.
function launchCancelled(state, bx, by, dx, dy) {
  for (const w of arenaOf(state).walls) {
    const np = nearestOnWall(w, bx, by);
    const vx = np.x - bx, vy = np.y - by, wd = hyp(vx, vy);
    if (wd < 1) return true;                       // bomb inside the wall — no jump
    if (wd > BOMB_WALL_DIST) continue;
    if ((vx / wd) * dx + (vy / wd) * dy > BOMB_WALL_COS) return true;
  }
  return false;
}
// Where should a bot at `p` planting for a rocket-jump along (dx,dy) put the bomb, and which way
// should it actually fly? Returns { x, y, dx, dy, mul }: the plant anchor (its own feet when no wall
// helps), the flight direction to commit to, and the multiplier the sim will give it.
// Will a launch along (dx,dy) from (x,y) actually FLY, or does it end against stone? The flight is
// a body travelling `dist` px, so the test is the sim's own wall geometry over that segment — walls
// only (`enemies: false`): a body in the way is a tackle, not a blocked jump.
// WHY IT MATTERS HERE and not at the call site: cannonPlant may ROTATE the flight line (CANNON_ROT)
// to find a wall to cannon off, so the direction the bot ends up flying is not the direction the
// caller lane-tested. A rotated launch straight into a capsule spends a bomb charge and 1.725s of
// standing still to travel nothing.
function launchPathClear(state, x, y, dx, dy, dist, team) {
  const L = clamp(dist, 60, CANNON_FLIGHT_PROBE);
  return laneClear(x, y, x + dx * L, y + dy * L, state, team, { enemies: false });
}
function cannonPlant(p, dx, dy, state, wantDist) {
  let best = null;
  const probe = wantDist != null ? wantDist : CANNON_FLIGHT_PROBE;
  for (const rot of CANNON_ROT) {
    const cs = Math.cos(rot), sn = Math.sin(rot);
    const ax = dx * cs - dy * sn, ay = dx * sn + dy * cs;
    for (const L of CANNON_LOB) {
      const bx = p.x - ax * L, by = p.y - ay * L;  // lob BACKWARDS, opposite the flight
      // useSpecial clamps the lob into the field; a clamped lob would land somewhere we did not
      // model, so only consider anchors that are comfortably in-bounds.
      if (bx < 24 || bx > FIELD.W - 24 || by < 24 || by > FIELD.H - 24) continue;
      if (launchCancelled(state, bx, by, ax, ay)) continue;
      if (!launchPathClear(state, p.x, p.y, ax, ay, probe, p.team)) continue; // don't fly into stone
      const mul = cannonMulAt(state, bx, by, ax, ay);
      if (rot !== 0 && mul < CANNON_ROT_MIN_MUL) continue; // never twist the flight line for nothing
      if (!best || mul > best.mul + 1e-6) best = { x: bx, y: by, dx: ax, dy: ay, mul, back: L };
    }
  }
  // THE FALLBACK IS SCREENED TOO. It used to be returned unconditionally, so when every candidate
  // was rejected the caller planted a launch the sim refuses (or one that flies into a wall) — the
  // one code path in this function that was not asking the geometry any questions. `null` now means
  // "there is no launch here", and every caller already treats a missing plant as "just walk".
  if (best) return best;
  if (launchCancelled(state, p.x, p.y, dx, dy)) return null;
  if (!launchPathClear(state, p.x, p.y, dx, dy, probe, p.team)) return null;
  return { x: p.x, y: p.y, dx, dy, mul: 1, back: 0 };
}

// ==================== MOBILITY: IS A ROCKET-JUMP ACTUALLY FASTER THAN WALKING? ================
// Requested: "if a bot is left behind he can use the bomb to propel forward instead of walking."
// It only pays if it BEATS walking, and the bot is frozen on its plant for BOMB.fuse (1.725s)
// first, so this had to be measured rather than assumed. In the sim, over one fuse + glide (2.92s),
// launching across open ground:
//     walking .......................... 400px
//     rocket-jump ...................... 653px   (+63%)
//     rocket-jump, STONE behind the bomb 869px   (+117%)
// So a plain feet-plant wins from ~430px out, and a wall-cannoned one wins from much closer. Below
// that the honest answer is "just run", which is why the two existing mobility jumps (catchUpJump,
// coopPush) asked for 620px: that was conservative rather than wrong. This helper is the shared
// decision so every branch can use it — being "left behind" is not something that only happens
// while your team-mate carries the ball, which is the only branch that had it.
const JUMP_MIN_D = 430;          // ≈ the walking distance over one fuse+glide
const JUMP_NO_CANNON_D = 620;    // without a wall boost, insist on a trip long enough to be sure
// A FLAT FLOOR BETWEEN MOBILITY BOMBS, DELIBERATELY NOT SCALED BY cdMul. Measured after this round's
// three new bomb plays landed: at skill 0.93 the bots spent **14.3% of every tick standing on a bomb
// fuse — 7.3 seconds per bot per match over 14.2 plants** — because nextBombAt is `3.0 * cdMul` and
// cdMul at the top of the ladder is ~0.4, so a strong bot could re-plant every ~1.2s while four
// separate branches competed for the charge. That is exactly the "they sometimes get idle waiting for
// something" the user reported at level 10: a bot standing on a fuse is committed for 1.725s and
// looks like it is doing nothing. A stronger bot should use the bomb BETTER, not MORE, so the gap
// between MOBILITY bombs is a constant. The tackle bomb and the corner escape keep their own
// cdMul-scaled cooldown — those are reactions, not travel.
// MILDLY tier-scaled, not flat and not cdMul. The first version was FLAT, which fixed the idle
// (14.3% -> 5.1% of bot-ticks on a fuse at skill 0.93) but ALSO took a genuine advantage away from
// the top of the ladder — cdMul is one of the few honest mechanical edges a strong bot has, and
// removing it entirely is part of why the re-measured ladder ranked at rho 0.80 instead of 0.90.
// This keeps ~90% of the idle fix (t=1.00 waits 5.5s between travel bombs, not the 1.2s that caused
// the complaint) while leaving the top tier a readable edge over the bottom's 8.1s.
// THE USER'S ASK #5: "in higher level bot, 5 and above, the bot prefer to move using the bomb trick
// more." The re-arm interval is what limits how often it happens, so the L5 ramp shortens it — 8.1s at
// the bottom, 3.5s from L5 up. MOBILITY_GAP was deliberately kept flat-ish once (a skill-scaled
// interval measured as flattening the ladder), so this is a change to a decision that was previously
// argued: it is now level-ramped ON PURPOSE and the ladder is re-measured for it.
const mobilityGap = (sk) => 6.5 * (1.25 - 0.4 * skT(sk)) * (1 - 0.46 * levelRamp(sk));
function mobilityJump(p, bm, mem, state, sk, tgt, visibleEnemies, bombReady, tag) {
  if (!bombReady || (sk.toolSkill || 0) < TOOL_MOBILITY_MIN) return null;
  if (mem.t <= (bm.nextBombAt || 0) || mem.t <= (bm.nextMobilityAt || 0) || !toolNotice(sk, p, mem)) return null;
  // (the gap itself is stamped below, once the jump is actually taken)
  const d = hyp(tgt.x - p.x, tgt.y - p.y);
  // ASK #5, AND THE PART OF IT THAT MUST NOT MOVE: the distance gates encode "a jump only pays if it
  // BEATS WALKING" — over one fuse+glide (2.92s) walking covers 400px, an on-centre launch 653px.
  // Lowering JUMP_MIN_D to 300 and JUMP_NO_CANNON_D to 430 to make bombs commoner made a bot take a
  // 450px trip by bomb instead of walking round a 600px wall, and it never arrived inside the budget
  // (test-bot-stall.mjs case 4: 5.90s -> never). The frequency comes from the RE-ARM interval instead,
  // which is what actually limited how often this fires.
  if (d < JUMP_MIN_D) return null;
  // Freezing for 1.725s next to an opponent is how you get stripped, and freezing while somebody
  // else is closer to the destination is how you arrive second.
  for (const e of visibleEnemies) {
    if (hyp(e.x - p.x, e.y - p.y) < 300) return null;
    if (hyp(e.x - tgt.x, e.y - tgt.y) < 420) return null;
  }
  if (!laneClear(p.x, p.y, tgt.x, tgt.y, state, p.team, { enemies: false })) return null;
  const [ex, ey] = unit(tgt.x - p.x, tgt.y - p.y);
  const cp = cannonPlant(p, ex, ey, state, d);
  if (!cp) return null;                                     // every launch from here ends on stone
  if (cp.mul < 1.05 && d < JUMP_NO_CANNON_D) return null;   // no boost and not far enough: walk
  bm.bombHold = { x: cp.x, y: cp.y, until: mem.t + BOMB.fuse + 0.1, aimX: p.x + cp.dx * 500, aimY: p.y + cp.dy * 500 };
  bm.nextBombAt = mem.t + 3.0 * (sk.cdMul || 1) * toolGap(sk, 'bomb');
  bm.nextMobilityAt = mem.t + mobilityGap(sk);
  bm.lastTrick = cp.mul > 1.05 ? 'wallCannonJump' : tag;
  return { x: cp.dx, y: cp.dy };
}

// ---- THE PASS CALL: bots telling each other what they are about to do -----------------------
// Requested: "let them communicate so they can decide to pass the ball from one another."
// Two halves, and the file was missing BOTH:
//  * the carrier LATCHES its pass (see the autopsy at the pass sites) so the ball actually goes to
//    the receiver instead of being silently re-aimed at the goal on the next tick;
//  * the receiver READS the call and comes to meet it, instead of holding an outlet spot chosen
//    for a pass that was never coming.
// mem.pass[team] is the channel. It is a CALL, not a contract: it expires, and either bot can be
// pulled off it by anything higher-value.
function callPass(p, mate, bm, mem, team) {
  bm.passTo = { id: mate.id, until: mem.t + 1.1 };
  bm.giveGo = { until: mem.t + 1.0 };
  bm.nextPassAt = mem.t + PASS_COOLDOWN;
  (mem.pass || (mem.pass = {}))[team] = { from: p.id, to: mate.id, until: mem.t + 1.4 };
}
// Is a pass to `mate` worth making? THIS HAD TO BE RETUNED THE MOMENT THE LATCH WORKED. The old
// gate ("mate is 30px closer to goal") was written when 78% of pass intents were silently converted
// into shots at goal, so it was effectively a no-op; with the latch honouring every call the bots
// immediately started ping-ponging — MEASURED 33.7 completed pass releases per match, one every
// 1.8s, which is not football, it is hot potato. A pass now has to actually GAIN ground and arrive
// somewhere safe, and there is a per-bot cooldown so the receiver cannot instantly pass it back.
// SWEPT, 12 matches x 60s per cell, on the real arena. The gain requirement is the interesting one:
// asking for MORE ground per pass makes the receiver further away, which makes the pass longer and
// easier to cut out — GAIN 100 completed 53%, GAIN 40 completes 90%. So the bots keep possession by
// playing the short one that is on, which is also what the player sees as teamwork.
const PASS_COOLDOWN = 1.0;   // seconds before this bot may call another pass (stops hot-potato)
const PASS_GAIN = 40;        // px closer to the enemy goal the receiver must be
const PASS_MARK = 130;       // don't pass to a mate with a defender this close
// ...and the LATCH aborts once the ball would travel BACKWARDS: cos of the pass bearing measured
// off the direction to the enemy goal. -0.17 ~= 100deg, i.e. square balls (the normal outlet, and
// ~58% of every release in this game) are fine and only a genuinely backward kick is refused.
// A DISTANCE version of this gate cost 81% of all passes — see the abort site for that autopsy.
const PASS_BACK_COS = -0.17;
// How much ground a called receiver may give up while showing for the ball, over the WHOLE call.
// 20px is a step, not a run. SWEPT on the combined HEAD (bot-passes, 60 matches, skill 0.93 — 86%
// before): budget 90px -> 87% · 45px -> 87% · 20px -> 89%, and the tighter the budget the less the
// receiver is seen running the wrong way. Zero is NOT better: see the receiver branch for the two
// rewrites that stopped the close entirely and cost 72-81%.
const RECV_GIVE_MAX = 20;
function passWorthIt(p, mate, bm, mem, team, state, egX, visibleEnemies) {
  if (mem.t <= (bm.nextPassAt || 0)) return false;
  if (hyp(egX - mate.x, GY - mate.y) > hyp(egX - p.x, GY - p.y) - PASS_GAIN) return false;
  for (const e of visibleEnemies) if (hyp(e.x - mate.x, e.y - mate.y) < PASS_MARK) return false; // don't pass into a marker
  return true;
}

// Decide one bot's input: role tactics -> desired {move target, aim, buttons},
// then apply steering + skill (reaction latency, aim slew + noise).
function decideBot(p, role, state, mem, sk, dt) {
  const bm = bmemOf(mem, p.id);
  bm.lastTrick = null; // reset each tick — it's a per-tick behaviour tag, not sticky state
                       // (histogramming a sticky tag over-counted ~9x and hid the real behaviour)
  if (state.ball.owner) bm.looseSince = null; // re-arm the chase reaction for the NEXT loose ball
  bm.slideAngle = false; // ditto: "the release ladder fell through to (d)" is a per-tick fact
  bm.seekContact = false; // per-tick: "I am deliberately walking INTO a body" — steer()'s body
                          // avoidance reads it, and a contact play must re-assert it every tick
                          // (the bm.screening flag that was never cleared is why this is per-tick)
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
  // PERSONA `hunt` DELIBERATELY DOES NOT SCALE THE STRIP RANGES. Scaling them +-18% measured as part
  // of the round's pinning regression (wall-pinned 0.56% -> 0.86%, worst jam 0.85s -> 1.65s on its
  // own): a wider press range means more ticks inside `seekContact`, which suppresses body avoidance
  // on purpose. The Enforcer identity lives in its CHARGE (maxCharge 1.0 + readyCharge) and its
  // positioning, both of which measure clean. `hunt` is still read by the persona table for future
  // use and by the tests; it must not come back here without its own n=24 x 2 measurement.
  const HUNT = 1;
  const PRESS_RANGE  = (160 + 300 * AGG) * HUNT; // enemy-carrier strip range (easy~400 / normal~436 / hard 460 / extreme~505)
  const COVER_STRIP  = (120 + 200 * AGG) * HUNT; // plain-cover strip range   (easy~280 / normal~304 / hard 320 / extreme~350)
  // FINISH_RANGE is now derived from what a kick CAN DO, not from a hand-picked constant. Max reach
  // is the roll at full charge (~647px on default settings); we shoot inside a safety margin of it,
  // and aggro only decides how close to the edge a tier is willing to try. Previously this said
  // 560+220*AGG = up to 835px, i.e. bots routinely shot from beyond the ball's reach.
  const MAX_REACH = ballRollPx(state, 1);
  const FINISH_RANGE = MAX_REACH * (0.72 + 0.16 * clamp(AGG, 0, 1.3)); // ~0.83..0.93 of reach
  const LINEUP_PAD   = 180 + 100 * AGG; // how far off-axis a carrier still tries the drive-finish
  const CARRY_IDLE   = 0.9 - 0.5 * AGG; // seconds holding before the anti-idle blast — lower = finish sooner, dribble less (buffed 2026-07-22: hard ~0.34 / normal ~0.39 / easy ~0.47)
  // HARD CEILING on holding the ball. The release ladder above should always fire long before
  // this, so the watchdog is a backstop against any future branch that forgets to release — the
  // symptom it prevents ("stands with the ball") was invisible in aggregate stats and obvious to
  // the player. It must be > the tier's wind-up budget or it would cancel its own shot forever:
  // the bottom tier needs 2.12s to reach FULL_CHARGE, hence the 2.6s floor.
  const CARRY_HOLD_MAX = Math.max(2.6, 4.2 - 2.4 * AGG); // t=0: 2.76s → normal ~2.6s → top ~2.6s

  // target point to move toward, plus button intents (re-decided every tick — see the decisionHz autopsy in finalize)
  let tgt = { x: p.x, y: p.y };
  let aim = { x: p.aimX, y: p.aimY };
  let shoot = false, charge = 0, special = false, build = false, closeShot = false, forceRelease = false;
  // WHICH ENEMY this tick's BULLET is for. Every branch that asks for a bullet names its target so
  // finalize() can LATCH the wind-up to it — measured, the wind-up outliving its branch was the
  // whole of the ">45deg off every enemy" bullet population. Null for a ball release (that is the
  // pass latch's job) and null when no bullet is wanted.
  let shootTgt = null;

  // --- If mid bomb-hold, STAND on the plant until the fuse blows (staying within
  // BOMB_CENTER_R is what makes the rocket-jump/tackle actually fire). Aim tracks the
  // live target so the launch/tackle vector points at where it is now. ---
  // Abort a tackle-steal hold the moment its target has already lost the ball — don't
  // sit frozen (a sitting duck) chasing a stale premise; the bomb still blasts normally.
  if (bm.bombHold && bm.bombHold.targetId && state.ball.owner !== bm.bombHold.targetId) bm.bombHold = null;
  // Gained the ball mid-fuse? A carrier cannot plant (sim.js:840), so holding the spot buys
  // nothing and just freezes us with the ball — exactly the "stands still" complaint.
  if (bm.bombHold && state.ball.owner === p.id) bm.bombHold = null;
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

  // TACTIC 11 — BOMB YOURSELF LOOSE (all tiers; harder bots trigger sooner).
  // ASK #4: "when the bots are stuck or moving with no purpose, make them place a bomb at their feet
  // to get loose." This used to require a CORNER, an enemy within 170px AND the ball within 220px —
  // three conditions that almost never coincide, which is why `cornerEscape` fired 0.11-0.18 times a
  // match while the felt symptom (a bot grinding on a wall face) kept getting reported. Now the
  // trigger is the thing the user actually described: I want to move, I am not moving, and it has gone
  // on long enough to be embarrassing. The corner case survives as the FAST path (it triggers sooner
  // there, because a corner is where a body genuinely cannot slide out).
  // WHY IT IS SAFE TO WIDEN: `bm.stuck` counts consecutive ticks of wanting to move and not moving, so
  // it cannot fire on a bot that is standing still ON PURPOSE (a wall wind-up sets its own hold, a
  // bomb plant returns early). The launch path is wall-tested by cannonPlant, the bomb is on its own
  // cooldown, and a CARRIER cannot plant at all (sim.js:889 gates on !carrying) — so the worst case is
  // one wasted charge, against a measured 15.65s of a bot standing in a wall before this existed.
  {
    const nearCorner = (p.x < 300 || p.x > FIELD.W - 300) && (p.y < 260 || p.y > FIELD.H - 260);
    let foeNear = 1e9; for (const e of visibleEnemies) foeNear = Math.min(foeNear, hyp(e.x - p.x, e.y - p.y));
    // ~0.5s wedged in a corner (or with someone on top of us), ~1.1s anywhere else. Weak bots wait
    // longer before resorting to it, which keeps this off the bottom of the ladder as a free ability.
    const fast = nearCorner || foeNear < 170;
    // MEASURED THEN SET: with the ray-sampled detour in place the WORST jam in 24 matches is ~1.0s,
    // so a 1.1s gate could never fire — `stuckEscape` was 0 per match. The gate now sits UNDER the
    // observed tail: ~0.4s wedged in a corner or under pressure, ~0.65s anywhere else.
    const stuckLim = (fast ? 24 : 40) * (sk.toolSkill >= 0.9 ? 0.7 : 1) * (1.3 - 0.3 * levelRamp(sk));
    // Either signal fires it: a hard wedge (bm.stuck ticks) or going nowhere while moving
    // (bm.noProgressT seconds). The second one is what the user described as "moving with no purpose",
    // and it needs a longer fuse because a bot legitimately loses progress for a moment when the ball
    // changes hands — 1.5s at the top of the ramp, 2.2s at the bottom.
    // 1.5s of no progress fired this 7.2 times a match, which is a habit rather than a rescue: each
    // plant parks the bot on a 1.725s fuse, and the repo's own note (README §2) records that a bot
    // standing on a plant still reports wantMove=1 and therefore lands in `pinnedPct`. So the fuse is
    // longer and there is a per-bot re-arm: ~2 escapes a match, used when nothing else worked.
    const noPurposeLim = 2.3 * (1.4 - 0.4 * levelRamp(sk));
    const wedged = (bm.stuck || 0) > stuckLim;
    const aimless = (bm.noProgressT || 0) > noPurposeLim;
    if ((wedged || aimless) && (p.specialCd || 0) <= 0 && mem.t > (bm.nextBombAt || 0) && mem.t > (bm.nextEscapeAt || 0)) {
      // Fly toward open space: the pitch centre is the safest bet from a corner, and away from the
      // nearest wall face otherwise. cannonPlant screens the flight path, so if the only launch
      // available would fly into stone this returns null and we simply keep steering.
      const [ex, ey] = unit(FIELD.W / 2 - p.x, GY - p.y);
      const cp = cannonPlant(p, ex, ey, state, 420);
      if (cp) {
        bm.bombHold = { x: cp.x, y: cp.y, until: mem.t + BOMB.fuse + 0.1, aimX: p.x + cp.dx * 400, aimY: p.y + cp.dy * 400 };
        bm.nextBombAt = mem.t + 3.0 * (sk.cdMul || 1) * toolGap(sk, 'bomb');
        bm.nextEscapeAt = mem.t + 9.0;                 // a rescue, not a movement style
        bm.stuck = 0; bm.noProgressT = 0;
        bm.lastTrick = nearCorner ? 'cornerEscape' : (wedged ? 'stuckEscape' : 'aimlessEscape');
        return finalize(p, { x: p.x, y: p.y }, { x: cp.dx, y: cp.dy }, { shoot: false, charge: 0, special: true, build: false }, state, mem, bm, sk, dt);
      }
    }
  }

  // ===== KICK-AND-FLY, phase 2: the ball is away, now plant and fly after it ==================
  // Phase 1 (in the carry branch) kicked the ball ahead and armed bm.fly. A carrier can never plant
  // (sim.js:840 gates the bomb on !carrying), so the plant has to wait for the release to land —
  // hence two phases. The window is short on purpose: if the release did NOT happen (a wind-up can
  // cancel), the play is abandoned instead of leaving the bot planting a bomb for no reason.
  if (bm.fly && mem.t - bm.fly.at > 0.7) bm.fly = null;
  if (bm.fly && b.owner !== p.id && !bm.bombHold && (p.specialCd || 0) <= 0) {
    const cp = cannonPlant(p, bm.fly.x, bm.fly.y, state);
    if (cp) {
      bm.bombHold = { x: cp.x, y: cp.y, until: mem.t + BOMB.fuse + 0.1, aimX: p.x + cp.dx * 500, aimY: p.y + cp.dy * 500 };
      bm.nextBombAt = mem.t + 3.0 * (sk.cdMul || 1) * toolGap(sk, 'bomb');
      bm.lastTrick = cp.mul > 1.05 ? 'kickFlyCannon' : 'kickAndFly';
      bm.fly = null;
      return finalize(p, { x: p.x, y: p.y }, { x: cp.dx, y: cp.dy }, { shoot: false, charge: 0, special: true, build: false }, state, mem, bm, sk, dt);
    }
    bm.fly = null;   // no launch available from here — drop the play rather than stand on a fuse
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
    // AIM-POINT LADDER: the goal is a 300px-wide mouth, but every shot decision used to test the
    // CENTRE alone. A wall or keeper covering the middle therefore read as "no shot exists" even
    // when both corners were wide open. Try centre first (best angle), then each post.
    // NB: computed from BALL_RADIUS directly, not from the `ballR` const declared a few lines
    // below — reading that here is a temporal-dead-zone crash (`let`/`const` are not hoisted).
    const postIn = BALL_RADIUS * (settings.ballSizeMul || 1) + 26; // keep the target inside the woodwork
    const aimPoints = [GY, GOAL_TOP + postIn, GOAL_BOT - postIn];
    let goalAimY = null, goalBlock = null;
    for (const ay of aimPoints) {
      const probe = {};
      if (laneClear(p.x, p.y, egX, ay, state, team, { enemies: false, out: probe })) { goalAimY = ay; break; }
      if (!goalBlock) goalBlock = probe.wall; // remember what stopped the BEST (centre-most) lane
    }
    // Can the CARRIER clear the thing in its way by kicking the ball at it? Mostly NO, and it is
    // worth being precise because getting this wrong means kicking possession away for nothing:
    //   * static stone (wallId == null)  -> indestructible, never.
    //   * SOLID built wall (hp > 1)      -> the ball just RICOCHETS (sim.js:895 resolveCircleBox).
    //                                       damageWall is only ever called from the BULLET path
    //                                       (sim.js:1170) and the bomb blast — a kicked ball does
    //                                       NOT chip a wall. A carrier cannot fire a bullet either
    //                                       (shooting IS the ball release), so it simply cannot
    //                                       break this: it must pass or work an angle. Clearing it
    //                                       is the SUPPORT bot's job with a full-charge bullet.
    //   * FRAGILE built wall (hp 1, built in a bush/penalty) -> a fast ball SMASHES THROUGH
    //     (sim.js:893) once speed > FRAGILE_PASS_SPEED 900; a full kick leaves at shotPower 1850. ✔
    const blockIsSmashable = !!goalBlock && goalBlock.wallId != null
      && (goalBlock.fragile || (goalBlock.maxHp || goalBlock.hp || 3) <= 1)
      && (settings.shotPower || 1850) > FRAGILE_PASS_SPEED;
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

    // ===== B1a — SUPER DISCIPLINE, the carrier half (gate t >= 0.50) ========================
    // Overcharge is the ONLY kick a keeper cannot catch (KEEPER_BREAK_ROLL) and it dies on a 4s
    // TTL, so WHEN you spend it is a real skill — a human learns it, a bot should too. Below the
    // gate the bot just dumps it on the next full shot: the documented Brawl Stars bot tell
    // ("fires the Super right after respawn"), tagged `superDump` in finalize so the bottom of
    // the ladder is measurable too. At or above the gate the carrier stops throwing the meter
    // away on a PASS while a finish is still plausibly in reach.
    // BOUNDED, so this can never become the "stands with the ball" bug: only inside super-finish
    // reach, only while the ring is actually lit, and the carry watchdog (CARRY_HOLD_MAX) still
    // force-releases over the top of it.
    // TELL: the pulsing red overcharge ring — p.power is on the wire (wire.js packFlags bit 64)
    // and the client draws the ring for EVERY player — stays lit as the bot drives at goal.
    // COUNTER: shoot it first (a hit costs it nothing but breaks the approach), wall the lane,
    // or simply wait: OVERCHARGE_TTL is 4s.
    const superKeep = !!p.power && skT(sk) >= T_SUPER_HOLD && distGoal < FINISH_RANGE + 260;

    // ===== RIDING THE CATAPULT — my mate has a wall+bomb set for me (mem.cata) =================
    // The carrier's half of the requested combo. It has exactly one job: HOLD THE HEADING, so the
    // mate's prediction of where I will be when the fuse ends is still true. That is why this is a
    // communication channel and not two bots guessing — the zigzag alone would put me 200px off.
    // It deliberately does NOT stop me shooting: if a finish appears, take the finish.
    const cataCall = mem.cata && mem.cata[team];
    const riding = !!cataCall && mem.t < cataCall.until && cataCall.by !== p.id;

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
    // The charge is SIZED TO THE DISTANCE (plus a margin so it still crosses the line with pace),
    // instead of always asking for max: a nearer shot stays quicker to release and less telegraphed.
    const goalCharge = clamp(chargeForRoll(state, distGoal + 90), 0.45, 1);
    if (!shoot && distGoal < FINISH_RANGE && linedUp && goalAimY != null && !keeper) {
      aim = { x: egX - p.x, y: goalAimY - p.y }; shoot = true; charge = goalCharge;
      bm.lastTrick = goalAimY === GY ? 'drive' : 'postFinish'; // a corner shot is a real, distinct finish
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
        // THE CORNER IS MEASURED AT THE KEEPER, NOT AT THE GOAL LINE, AND IT IS LATCHED.
        // Two defects, both traced on the walk-in fixture rather than reasoned about:
        //  (1) the corner was a FRACTION OF THE MOUTH (0.30 => 90px off centre). The keeper stands
        //      far closer to the shooter than the goal line does, so 90px at the line is only ~42px
        //      of clearance where it actually matters — and the keeper SLIDES ~22px during the
        //      ball's 0.16s flight, eating it. Measured: the "corner" finish was caught by a keeper
        //      it had supposedly gone around. Now the required miss distance is computed AT the
        //      keeper (body + ball + how far it can slide in the flight time) and projected out to
        //      the goal line — and if the woodwork cannot fit that, the corner is genuinely COVERED
        //      and we fall through to the bank / walk-in dead-end ladder, which is what those
        //      branches exist for.
        //  (2) it was re-chosen every tick. With a keeper parked ON GY, kyFut flips sign constantly,
        //      so the aim flip-flopped between both corners for the whole wind-up and the shot
        //      released wherever it happened to be pointing. Latched for 1.2s: commit, then honour
        //      it — the same rule as every other committed action in this file.
        const flightT = distGoal / Math.max(1, (settings.shotPower || 1850));
        const kSlide = (CHARACTERS[keeper.char] || CHARACTERS[DEFAULT_CHAR]).speed * (settings.speedMul || 1) * flightT;
        const needMiss = radOf(state) + ballR + kSlide + 14;
        const spread = needMiss * Math.abs(egX - p.x) / Math.max(1, Math.abs(keeper.x - p.x));
        if (!bm.cornerLatch || mem.t > bm.cornerLatch.until) {
          const want = kyFut > GY ? kyFut - spread : kyFut + spread;
          const y = clamp(want, GOAL_TOP + postIn, GOAL_BOT - postIn);
          bm.cornerLatch = { y, open: Math.abs(y - want) < 1, until: mem.t + 1.2 };
        }
        const cornerY = bm.cornerLatch.y;
        if (bm.cornerLatch.open) {
          aim = { x: egX - p.x, y: cornerY - p.y }; shoot = true; charge = 1; bm.lastTrick = 'cornerFinish';
          if (distGoal < 300) closeShot = true;
        } else if (trick >= 0.7) { // corner covered → try a bank as a last resort
          const bk = bankAim(b.x, b.y, egX, clamp(GY + (keeper.y < GY ? 90 : -90), 420, 680), state, team, { goal: true, maxPath: 560 + 300 * trick, viewer: p });
          if (bk) { aim = { x: bk.aimX, y: bk.aimY }; shoot = true; charge = 1; bm.lastTrick = 'goalBank'; }
          // ---- NEW SKILL: WALK-IN GOAL — carry it over the line instead of shooting -----------
          // Deliberately ONLY here, in the genuine dead end: a keeper is parked, the open corner is
          // covered AND the bank returned null. Every other path already has a shot, and putting
          // this above the finish gate would replace ordinary finishing with walking.
          // A keeper below overcharge SAVES everything (sim.js:915 catches tier < 2), so kicking
          // here is pointless — but detachIntoNet (sim.js:863) bypasses the kick/save path
          // entirely, making the walk-in UNSAVEABLE. Dribble-in goals measure 1/1/0/1 per tier
          // against 11-18 kicked today, i.e. ~4% and all accidental.
          // Geometry: the ball glues radiusOf + ballR = 58.25px ahead, so the BODY needs x > 1941.75
          // inside the mouth band; clampBallCarryXY permits up to 2038.
          // FAIRNESS: beatable by a counter the human already has and the bots already fire — a full
          // bullet strips the walking carrier in 0.13s (bulletStripCarrier detaches BEFORE
          // knockback, so the penalty-box knockback cut does not protect it).
          else if (trick >= 0.70 && Math.abs(p.y - GY) < GOAL.width / 2 - 20) {
            if (!bm.walkUntil || mem.t >= bm.walkUntil) bm.walkUntil = mem.t + 2.2; // WALK_MAX
            if (mem.t < bm.walkUntil && nfd > 150) {
              bm.carryT = 0;              // do not let CARRY_HOLD_MAX force-release us mid-walk
              shoot = false; charge = 0;
              bm.lastTrick = 'walkIn';
              return finalize(p, { x: egX + (team === 'A' ? 40 : -40), y: clamp(p.y, GOAL_TOP + postIn, GOAL_BOT - postIn) },
                { x: egX - p.x, y: 0 }, { shoot: false, charge: 0, special: false, build: false }, state, mem, bm, sk, dt);
            }
          }
        }
      }
    }

    // ===== THE PASS LATCH — a committed pass now stays a pass =================================
    // Requested: "let them communicate so they can decide to pass the ball from one another."
    // This is the missing half of that: without it the CALL below is a lie, because the pass was
    // silently converted into a shot at goal one tick later (autopsy immediately below). The latch
    // re-derives the aim at the receiver's LED position EVERY tick until the ball actually leaves,
    // exactly like bombHold / buildHold / screenUntil / walkUntil — passing was the only committed
    // action in the file that did not latch. `closeShot` widens the aim tolerance so the release
    // can actually happen: `fire` needs charge >= fireAt AND |dTheta| <= tol, and it was the
    // TOLERANCE that stalled passes at close range.
    // It sits BELOW the finish block on purpose: a real shot at goal outranks a pass, always.
    if (bm.passTo && (mem.t > bm.passTo.until || !state.players[bm.passTo.id])) bm.passTo = null;
    // ---- ABORT A PASS THAT HAS TURNED BACKWARDS ------------------------------------------------
    // The latch is deliberately a LIVE aim: it re-derives at the receiver's led position every
    // tick. That is what made passes complete, and it is also how a forward pass rots into a
    // backward one — `passWorthIt` checks the geometry ONCE, at the call, and the receiver keeps
    // moving for the ~0.3-1.1s of wind-up that follows. MEASURED at the reported level 10 (partner
    // 0.42 vs enemy 0.93, 12 x 60s): 208 of 281 releases were [passLatch] at a mean **76 degrees
    // off the enemy goal**, and on the ones past 90deg the receiver was geometrically behind the
    // carrier 56% of the time — the ball being kicked backwards is the "shoots the other way"
    // report. So the gate is re-checked EVERY tick and the latch drops when the pass has become a
    // backward one, falling through to the finish / outlet / forward-clearance ladder below.
    //
    // THE TEST IS THE PASS BEARING, AND THAT CHOICE IS MEASURED. The obvious version — "abort once
    // the receiver is further from the enemy goal than I am" — was written first and it DESTROYED
    // PASSING: latched pass releases fell 197 -> 37 per 12 matches at skill 0.42 (-81%) and total
    // releases 270 -> 104, because the common case is not a receiver drifting back, it is the
    // CARRIER DRIVING FORWARD past its own outlet during the wind-up. That trips a distance test
    // every time while the pass itself is still a perfectly good square ball.
    // The bearing test cannot make that mistake: it asks only "would this ball travel backwards",
    // which is exactly what the player is complaining about, and it is scale-free. It also cannot
    // fight `passWorthIt`, whose radial gate is provably < 90deg at the call (if |R-G| < |P-G| then
    // (R-P)·(G-P) > |R-P|^2/2 > 0), so a called pass NEVER starts out aborted.
    if (bm.passTo) {
      const rx0 = state.players[bm.passTo.id];
      const [gux, guy] = unit(egX - p.x, GY - p.y);
      const [rux, ruy] = unit(rx0.x - p.x, rx0.y - p.y);
      if (rux * gux + ruy * guy < PASS_BACK_COS) {
        bm.passTo = null;
        // and cancel the CALL, so the receiver stops running to meet a ball that is not coming
        if (mem.pass && mem.pass[team] && mem.pass[team].from === p.id) mem.pass[team] = null;
        // ...AND HAND THE CARRIER A FRESH DECISION, WHICH IS THE WHOLE DIFFERENCE BETWEEN THIS
        // WORKING AND WRECKING THE MATCH. Without these two lines the abort does not "fall through
        // to the forward options", it falls through to the LAST rung: `bm.carryT` has been running
        // for the whole wind-up so `carryT > CARRY_IDLE` is already true, and `bm.charging` still
        // holds the pass's low `fireAt`, so the release ladder fires a FORWARD CLEARANCE on the very
        // next tick. MEASURED at skill 0.42, 12 x 60s x 3 seed bases: advance/release 76 -> ~200px,
        // touches 18 -> 9, the ball loose 69% -> 85% of the match and 320px from the nearest player.
        // Neither half of this change did that alone (the abort on its own: touches 17.9, loose
        // 69.7%). It was the interaction, and it is what a bad pass SHOULD cost: nothing. A player
        // who looks up, sees the pass is not on and keeps dribbling has not lost a thing.
        bm.carryT = 0;
        bm.charging = null;
      }
    }
    if (bm.passTo && !shoot) {
      const rx = state.players[bm.passTo.id];
      const full = settings.shotPower || 1850;
      charge = clamp(hyp(rx.x - p.x, rx.y - p.y) / 950, 0.4, 0.85);
      const [pax, pay] = leadAim(p.x, p.y, rx.x, rx.y, rx.vx || 0, rx.vy || 0, full * clamp(charge, 0.33, 1), sk);
      aim = { x: pax, y: pay }; shoot = true; closeShot = true;
      bm.lastTrick = 'passLatch';
    }

    // ===== KICK-AND-FLY, phase 1 (requested) ==================================================
    // "make the bot also quick shot to detach ball and then place bomb and aim to fly and pick it up"
    // Measured, one fuse + glide (2.92s), open ground: walking 400px, rocket-jump 653px, and 869px
    // with a stone wall behind the bomb. So this genuinely covers ground a dribble cannot — it is
    // the bot version of knocking the ball past a defender and sprinting.
    // It insists on SPACE, because the ball is loose for the whole fuse: nobody within 420px of me,
    // nobody within 520px of where the ball will stop, a wall-clear lane, and a real trip left to
    // make. The charge is sized from ballRollPx's inverse so the ball stops a little SHORT of where
    // the launch drops me — landing past the ball costs a step, landing short of it costs the ball.
    if (!shoot && !special && !riding && skT(sk) >= T_KICK_FLY && bombReady && distGoal > 700
        && mem.t > (bm.nextFlyAt || 0) && mem.t > (bm.nextBombAt || 0) && mem.t > (bm.nextMobilityAt || 0)
        && toolNotice(sk, p, mem)) {
      const [fx, fy] = unit(egX - p.x, GY - p.y);
      const land = { x: clamp(p.x + fx * FLY_DIST, 70, FIELD.W - 70), y: clamp(p.y + fy * FLY_DIST, 70, FIELD.H - 70) };
      let space = true;
      for (const e of visibleEnemies) if (hyp(e.x - p.x, e.y - p.y) < 420 || hyp(e.x - land.x, e.y - land.y) < 520) space = false;
      if (space && laneClear(p.x, p.y, land.x, land.y, state, team, { enemies: false })) {
        aim = { x: fx, y: fy };
        charge = clamp(chargeForRoll(state, FLY_DIST * 0.8), 0.30, 0.85);
        shoot = true; closeShot = true; bm.carryT = 0;
        bm.fly = { x: fx, y: fy, at: mem.t };
        bm.nextFlyAt = mem.t + 9.0; bm.nextMobilityAt = mem.t + mobilityGap(sk);   // see mobilityGap
        bm.lastTrick = 'kickAndFly';
      }
    }

    // ---- WHY PASSING WAS WEAK, MEASURED — AND WHY THE FIRST FIX WAS REVERTED ----------------
    // Instrumented over 8 matches at t=0.82: 98 pass INTENTS produced only 49 ball releases in
    // total, and just 22% of releases reached a team-mate (16% reached an ENEMY, 41% nobody).
    // ROOT CAUSE: a pass sets shoot+aim for ONE tick and finalize opens a wind-up, but on the next
    // tick the branch is usually not re-selected, so `shoot` goes false. bm.charging survives with
    // the pass's fireAt while the AIM is re-derived by whatever branch runs instead — normally
    // "drive at goal". The wind-up then completes and fires the ball AT THE GOAL. The pass is not
    // cancelled, it is silently converted into a long shot. Every other committed action here
    // latches (bombHold, buildHold, screenUntil, walkUntil); passing is the one that does not.
    // THE FIX WORKS AND WAS STILL REVERTED. A pass latch (re-aim at the receiver's led position
    // each tick until release) raised completed passes 11 -> 31 and releases 49 -> 235. But it
    // MEASURABLY FLATTENED THE LADDER: Spearman rho 0.90 -> 0.30, and the BOTTOM tier's goals
    // doubled (40 -> 82). Gating the latch on toolSkill so only strong tiers get it did not rescue
    // it either (rho 0.30, and the harness zero-check went out of tolerance at 0.25).
    // The lesson is the useful part: DELIVERING A PASS UNDER PRESSURE IS ONE OF THE LARGEST
    // DIFFICULTY LEVERS IN THE GAME. Making it reliable for everyone removes a differentiator the
    // ladder was leaning on. Whoever fixes this properly must re-cut the 12 levels in the same
    // change and re-measure with SEEDS=6 — it is a ladder change, not a passing change.
    // 2) marked & not shooting -> PASS to a better mate (direct, or BANK around a blocker); sets give-and-go
    if (!shoot && riding) {
      bm.lastTrick = bm.lastTrick || 'catapultRide';   // hold it: the ride is worth more than the pass
    } else if (!shoot && superKeep && mate && nfd < 260) {
      bm.lastTrick = 'superHold'; // B1a: keep the overcharge, take it to the goal yourself
    } else if (!shoot && mate && nfd < 260) {
      if (passWorthIt(p, mate, bm, mem, team, state, egX, visibleEnemies)) {
        const full = settings.shotPower || 1850;
        if (laneClear(p.x, p.y, mate.x, mate.y, state, team, { margin: 4, viewer: p })) {
          charge = clamp(hyp(mate.x - p.x, mate.y - p.y) / 950, 0.4, 0.85);
          const [pax, pay] = leadAim(p.x, p.y, mate.x, mate.y, mate.vx || 0, mate.vy || 0, full * clamp(charge, 0.33, 1), sk);
          aim = { x: pax, y: pay }; shoot = true; callPass(p, mate, bm, mem, team);
        } else if (trick > 0.6) {
          const bk = bankAim(b.x, b.y, mate.x + (mate.vx || 0) * 0.25, mate.y + (mate.vy || 0) * 0.25, state, team, { goal: false, maxPath: 560 + 260 * trick, viewer: p });
          if (bk) { aim = { x: bk.aimX, y: bk.aimY }; shoot = true; charge = 1; bm.lastTrick = 'passBank'; callPass(p, mate, bm, mem, team); }
        }
      }
    }

    // (The old "cornered bomb-finish" was removed: it scored 0-for-~30 — the reduced carry
    // launch can't put the ball in the net — while burning a bomb charge worth far more on a
    // ~97% off-centre tackle-steal. TACTIC 4 below reuses the bomb for MOBILITY instead.)

    // TACTIC 4 (carryJump) DELETED — it was PHYSICALLY IMPOSSIBLE and pure damage.
    // sim.js:840 gates the bomb on `!carrying`: `if (p._special && p.specialCd <= 0 && !carrying)`.
    // A ball-carrier can never plant. So this branch set bm.bombHold and stood the carrier still
    // for the whole BOMB.fuse + 0.1 = 1.825s waiting to ride a bomb that never spawned, then did it
    // again on the next cooldown. Measured by the council: ~28 commits and ~50 SECONDS of frozen
    // carrier per match at the top tiers, and ZERO bombs produced — a large part of why the high
    // tiers measured WEAKER than the middle. A carrier that wants to cover ground just runs.

    // ===== RELEASE LADDER (F6b) — a carrier ALWAYS has a next move =====
    // This branch used to be gated on `laneWalls`, so a wall across the goal lane left the
    // carrier with NO release path at all: it fell through to "drive at goal", walked into the
    // wall, and held the ball for the rest of the match. That is the reported "stands with the
    // ball in front of the goal". The ladder below is ordered by value and always terminates.
    if (!shoot && !special && bm.carryT > CARRY_IDLE) {
      if (goalAimY != null && distGoal < 1150) {
        // (a) some part of the mouth IS open — take it (keeper still wants the far corner)
        const ay = keeper ? (keeper.y > GY ? GOAL_TOP + postIn : GOAL_BOT - postIn) : goalAimY;
        aim = { x: egX - p.x, y: ay - p.y }; shoot = true; charge = goalCharge; bm.carryT = 0;
        if (distGoal < 300) closeShot = true;
      } else if (blockIsSmashable && distGoal < 1150) {
        // (b) the blocker is a FRAGILE wall → smash straight through it with a full kick.
        const gx = clamp(p.x, goalBlock.x, goalBlock.x + goalBlock.w);
        const gy = clamp(p.y, goalBlock.y, goalBlock.y + goalBlock.h);
        aim = { x: gx - p.x, y: gy - p.y }; shoot = true; charge = 1; bm.carryT = 0;
        closeShot = true; bm.lastTrick = 'smashWall';
      } else if (mate && !superKeep && mem.t > (bm.nextPassAt || 0)
                 // NEVER A BACKWARD OUTLET. This branch only asked for a clear lane to the mate, so
                 // it happily played the ball to someone standing behind us — measured as 35% of
                 // releases at skill 0.93 ending up BEHIND where they started, which is the exact
                 // opposite of "push the ball further towards the enemy goal". Lateral is fine
                 // (that is a genuine outlet); losing ground is not, and the forward clearance
                 // below is a better answer when the only mate is behind.
                 && hyp(egX - mate.x, GY - mate.y) <= distGoal + 20
                 && laneClear(p.x, p.y, mate.x, mate.y, state, team, { margin: 4, viewer: p })) {
        // (c) can't shoot at all (indestructible stone, or out of range) → give it to the mate
        //     ...unless B1a is protecting an overcharge that is still inside finishing reach.
        const full = settings.shotPower || 1850;
        charge = clamp(hyp(mate.x - p.x, mate.y - p.y) / 950, 0.4, 0.85);
        const [pax, pay] = leadAim(p.x, p.y, mate.x, mate.y, mate.vx || 0, mate.vy || 0, full * clamp(charge, 0.33, 1), sk);
        aim = { x: pax, y: pay }; shoot = true; bm.carryT = 0;
        callPass(p, mate, bm, mem, team); bm.lastTrick = 'outletPass';
      } else {
        // (c2) CLEAR IT FORWARD — requested: "usually if the player is near the ball he should
        // either go fetch it or try to shoot it to make it go closer to the enemy goal", and
        // "prioritise behaviour which pushes the ball further towards the enemy goal".
        // MEASURED BEFORE THIS EXISTED: the average release advanced the ball **4px** toward the
        // enemy goal at skill 0.50 (10px at 0.93) and **8-15% of releases went BACKWARDS**. With no
        // shot and no mate, the best thing on offer was to hold the ball and slide sideways — so
        // the bots were optimising for possession they could not use. A clearance up the pitch is
        // what a real player does, and it is worth more than a tidy dribble that goes nowhere.
        // Search a fan around the goalward line, keep the directions whose BALL LANE is clear for
        // the roll, and score them by ground gained MINUS how close the landing spot is to an
        // enemy — so it is a clearance into space, not a gift.
        // WHEN. Note where this sits: inside the release ladder, which only runs once the ball has
        // been held for CARRY_IDLE with no shot, no smashable blocker and no mate lane. So "clear
        // it" already means "I have had the ball for ~0.4s and there is nothing on" — that is the
        // moment a real player puts it up the pitch. Two versions were measured at skill 0.50:
        //   ungated (this one)        advance/release 4 -> 9px · retreat-while-nearest 23% -> 20.5%
        //   gated on pressure only    advance stayed 4px · retreat got WORSE (29%) · touches -27%
        // The narrower gate looked safer and was worse at everything the user asked for, so the
        // ladder position IS the gate. What survives from that experiment is the `foe < 200` veto
        // below (never clear it onto an opponent) and the shorter 420px reach.
        const gdir = Math.atan2(GY - p.y, egX - p.x);
        // CHECK THE LANE OUT TO THE ACTUAL ROLL, not to a nominal reach. The charge is clamped up to
        // a 0.45 floor, so a "420px" clearance really travels ballRollPx(0.45) — and testing the
        // shorter segment let the ball sail on into a wall JUST past it and rebound: measured 35% of
        // clearances at skill 0.93 ended up BEHIND where they started. The lane must cover the whole
        // distance the ball will actually cover.
        const gsign = egX > FIELD.W / 2 ? 1 : -1;
        const clearCharge = clamp(chargeForRoll(state, 420), 0.45, 1);
        const CLEAR_REACH = Math.max(420, ballRollPx(state, clearCharge));
        let bestA = null, bestScore = -1e9;
        for (const off of [0, 0.26, -0.26, 0.52, -0.52, 0.79, -0.79, 1.05, -1.05]) {
          const th = gdir + off, cx = Math.cos(th), cy = Math.sin(th);
          const lx = p.x + cx * CLEAR_REACH, ly = p.y + cy * CLEAR_REACH;
          if (lx < 70 || lx > FIELD.W - 70 || ly < 70 || ly > FIELD.H - 70) continue;
          if (!laneClear(p.x, p.y, lx, ly, state, team, { enemies: false })) continue;
          let foe = 1e9;
          for (const e of visibleEnemies) foe = Math.min(foe, hyp(e.x - lx, e.y - ly));
          // TIER-SCALED EXECUTION, not tier-gated availability. Round 7 shipped this clearance with
          // ONE quality for every tier and it FLATTENED THE LADDER: Spearman rho 0.80 -> 0.10 and the
          // top-vs-bottom spread 1.10 -> -0.04, because "hoof it up the pitch" is a skill-INDEPENDENT
          // action, so it handed the bottom tier the ground the top tier used to have to earn with
          // possession play. Same lesson as the pass latch (§5.2) — making a useful action equally
          // reliable for everyone deletes a differentiator the ladder was leaning on.
          // So: everyone still clears it forward (the requested behaviour), but a weak bot clears it
          // CARELESSLY — it will happily hoof the ball to a defender's feet — while a strong bot only
          // accepts a clearance into real space. 60px at t=0 (basically no care) to 260px at the top.
          if (foe < 60 + 200 * skT(sk)) continue;
          const adv = gsign * cx * CLEAR_REACH;                 // ground gained toward their goal
          const sc = adv + Math.min(foe, 520) * 0.5;
          if (sc > bestScore) { bestScore = sc; bestA = { cx, cy }; }
        }
        // PATIENCE IS THE SKILL. Two ladder runs said the same thing: with the clearance available to
        // everyone, STRIPS ranked perfectly (1.01 -> 6.50 across the tiers) while EVERY tier's goal
        // differential went negative and the top tier stopped beating the bottom. Strong bots were
        // winning the ball and then hoofing away possession they could have converted.
        // So the clearance stays exactly as requested for the tiers that need it — a weak bot boots
        // it forward rather than dithering, which is the whole point — and above t=0.62 it becomes
        // what it is for a good player: something you do UNDER PRESSURE or against the carry clock,
        // not your first idea. That difference is nameable ("patience with the ball") and it is the
        // kind of differentiator this file's §4 asks for: same verb, better judgement.
        const clearNow = skT(sk) < 0.62 || nfd < 300 || bm.carryT > CARRY_HOLD_MAX * 0.6;
        if (clearNow && bestA && gsign * bestA.cx > 0.2 && mem.t > (bm.nextClearAt || 0)) {
          aim = { x: bestA.cx, y: bestA.cy };
          charge = clearCharge;
          shoot = true; closeShot = true; bm.carryT = 0;
          bm.nextClearAt = mem.t + 2.0; bm.lastTrick = 'clearForward';
        } else {
          // (d) genuinely nothing on — STOP grinding into the blocker and work an angle instead.
          // Slide along the wall toward whichever post is more open; the ladder re-tests every
          // tick, so as soon as a lane appears (a) fires. Never a dead end.
          //
          // MEASURED AND REFUTED — DO NOT RE-PROPOSE: "route the carrier to a precomputed SHOOT
          // SPOT instead of sliding". This rung looks like the perfect consumer for a per-arena
          // plan, because it is reached exactly when no part of the mouth is open and 54.8% of
          // MAIN_FIELD has no lane to any of the three aim points. The plan (shared/arena-plan.js)
          // answers correctly — over every no-shot cell inside 1150px it names a reachable spot for
          // 21-31% of them at t=0.05, 71-81% at 0.50 and 98-100% at 0.93, mean walk 124-302px.
          // It still measured NEGATIVE, on 4 paired seed bases x 12 matches x 60s, isolated to this
          // one line (skill 0.93): goals/match 1.77 -> 0.98 (4/4 seeds down), ball loose 68.8% ->
          // 73.0% (4/4), worst jam 1.23s -> 2.37s (4/4), touches 23.3 -> 21.7 (4/4). It bought only
          // backward releases 24.8% -> 13.6%. At skill 0.50 every delta was inside noise.
          // THE CAUSE, and it is the same one as §4's wall-cannon pad (which reached its computed
          // spot 0 times out of 449): A CARRIER HAS NO TIME. Instrumented over 6 matches, routing
          // episodes lasted 0.28s and closed 303px -> 283px — 0% of them ever arrived. Possession
          // in this game is under a second, so any plan that asks the BALL-CARRIER to walk
          // somewhere is spending possession it does not have, and the walk replaces both driving
          // at the goal and releasing. test-arena-plan.mjs §9 keeps measuring the arrival rate so a
          // future version of this idea has to clear that bar first.
          // The plan is consulted where a bot DOES have time instead: the off-ball outlet chooser
          // in the support branch below. Same data, a consumer with a clock that allows it.
          bm.workAngle = bm.workAngle || (p.y < GY ? 1 : -1);
          if (mem.t > (bm.workFlip || 0)) { bm.workFlip = mem.t + 1.2; bm.workAngle *= -1; }
          // Same movement either way — but name it for what it IS, so the histogram can tell
          // "I have nothing on" apart from "I am carrying an overcharge to the goal".
          bm.slideAngle = true;
          bm.lastTrick = superKeep ? 'superHold' : 'workAngle';
        }
      }
    }
    // WATCHDOG — the last line of defence, and no branch above can defeat it. If the ball has
    // been glued to this bot for longer than the tier's patience, it goes NOW: at the mouth if
    // any part is open, else at the blocker, else square to the mate. Deliberately dumb.
    if (bm.carryT > CARRY_HOLD_MAX) {
      const ay = goalAimY != null ? goalAimY : GY;
      aim = { x: egX - p.x, y: ay - p.y };
      shoot = true; charge = 1; special = false; build = false;
      forceRelease = true; // see finalize: drops the AIM TOLERANCE, which is what actually stalls
      bm.lastTrick = 'watchdogRelease';
    }
    // Drive at goal; if marked, ZIGZAG (TACTIC 6): weave a serpentine path around the goalward
    // vector to shake a chaser, instead of a readable straight line or one fixed juke. Amplitude
    // scales with skill, flip-rate with aggro. Still always ADVANCES toward goal.
    // The goalward target is the nearest point of the MOUTH (not the centre), so a carrier out
    // by the post walks in at the near post instead of cutting across the face of the goal.
    tgt = { x: egX, y: clamp(p.y, GOAL_TOP + postIn, GOAL_BOT - postIn) };
    if (bm.slideAngle) { // (d): slide across the blocker's face, not into it
      tgt = { x: p.x + (egX - p.x) * 0.12, y: clamp(p.y + bm.workAngle * 260, 120, FIELD.H - 120) };
    }
    if (riding) {
      // straight along the launch line — no weave, no angle-working: the blast is coming
      tgt = { x: clamp(p.x + cataCall.dx * 320, 90, FIELD.W - 90), y: clamp(p.y + cataCall.dy * 320, 90, FIELD.H - 90) };
      if (!bm.lastTrick) bm.lastTrick = 'catapultRide';
    } else if (nearFoe && nfd < 300) {
      const [gx, gy] = unit(egX - p.x, GY - p.y);
      let perpx = -gy, perpy = gx;
      // start the weave toward the MORE-OPEN side (away from the marker), then oscillate
      if ((nearFoe.x - p.x) * perpx + (nearFoe.y - p.y) * perpy > 0) { perpx = -perpx; perpy = -perpy; }
      const ZIG_PERIOD = 0.45 - 0.15 * AGG;                 // hard flips faster
      if (bm.zigSign == null || mem.t - (bm.zigAt || 0) > ZIG_PERIOD) { bm.zigSign = (bm.zigSign || 1) * -1; bm.zigAt = mem.t; }
      const amp = 140 + 200 * sk.toolSkill;                 // hard weaves wider
      tgt = { x: p.x + gx * 240 + perpx * amp * bm.zigSign, y: p.y + gy * 240 + perpy * amp * bm.zigSign };
      // MEASUREMENT FIX — and it is why a chunk of the "12 dead behaviours" looked dead.
      // zigzag is a MOVEMENT decision that used to OVERWRITE whatever the SHOT decision above
      // had already tagged, and it fires whenever a foe is within 300px — which is exactly the
      // situation of every keeper/blocker finish. So overFinish / cornerFinish / goalBank /
      // postFinish / smashWall / watchdogRelease were relabelled 'zigzag' on the very ticks they
      // fired. Verified on a scripted super-carrier vs an in-box keeper: `zigzag 42, overFinish 0`
      // before this line changed, `overFinish 42` after. The weave still happens — the tag is now
      // a FALLBACK so it reports the play instead of erasing it.
      if (!bm.lastTrick) bm.lastTrick = 'zigzag';
    }
    if (!shoot && !special) aim = { x: egX - p.x, y: GY - p.y };

  } else if (carrier && carrier.team === team) {
    // ===== TEAMMATE CARRIES: I support (open a passing lane / trail for rebound) =====
    const ahead = egX - (team === 'A' ? 300 : -300);

    // TACTIC 9 — OFF-BALL CATCH-UP ROCKET-JUMP (hard/extreme): if we're lagging far behind the
    // play with a clear lane and no enemy on us, plant a bomb and rocket-jump toward the play so
    // the teammate isn't left alone (directly counters "the bot lags/hides instead of helping").
    // Gated on TOOL_MOBILITY_MIN + toolNotice (a skill-scaled chance of spotting the opportunity)
    // rather than a hard toolSkill cliff — see the comment on those two: the previous 0.72 cliff
    // muted the human's PARTNER on 7 of the 12 difficulty levels.
    if (!isOnBall) {
      // "PUT A BOMB NEAR A WALL TO FLY FURTHER" (explicitly requested) lives inside mobilityJump ->
      // cannonPlant: the bomb is lobbed BACKWARDS into the gap between us and a stone wall so the
      // sim's wallCannonMul boosts the launch. A MOBILITY play only, never the tackle-steal:
      // relocating the plant on a tackle rocket-jumps the planter AWAY from the loose ball
      // (measured 0% steal on hard), which is why that nudge was deleted and must stay deleted.
      const j = mobilityJump(p, bm, mem, state, sk, carrier, visibleEnemies, bombReady, 'catchUpJump');
      if (j) return finalize(p, { x: p.x, y: p.y }, j, { shoot: false, charge: 0, special: true, build: false }, state, mem, bm, sk, dt);
    }
    // TACTIC 2 — COORDINATED DEFLECT SET-PIECE (hard/extreme). When our carrier is near the
    // enemy goal but a DIRECT finish is blocked, the support bot builds an ANGLED wall just
    // outside the enemy box, angled as a MIRROR so a shot from the carrier BANKS off it into the
    // net, then signals the carrier (mem.setPiece) to shoot at the wall. Mirror normal bisects
    // (wall->carrier) and (wall->goal): n = unit( unit(G-W) - unit(W-C) ). Built OUTSIDE the box
    // + bushes so it's a solid hp3 wall the shot can bank off.
    const spLive = mem.setPiece && mem.setPiece[team];
    // 0.70, not 0.80: most levels put the human's PARTNER at skill 0.25-0.50 => toolSkill
    // 0.58-0.85, so the showpiece set-piece never fired on the player's own team.
    //
    // WHY IT NEVER FIRED — measured, not guessed. Instrumenting every conjunct over 6 matches x
    // 60s x 3 tiers: the preconditions HELD on 49 / 32 / 81 ticks (range + a foe parked in their
    // box), the bot started walking on all of them, and it reached the 46px stand tolerance
    // ZERO times at every tier. Two compounding causes, both the same shape as the deleted
    // walk-to-a-cannon-pad: (1) the stand spot was recomputed from the carrier's LIVE position
    // every tick — `Wy` flips to the other side of GY the instant the carrier crosses the
    // centre line, so the target teleported mid-walk; (2) a 46px bullseye at ~142px/s inside a
    // window that closes as soon as `distCG` leaves 240..760.
    // Fixes, in order of how much they matter: LATCH the chosen wall point for 2.5s so it stops
    // moving; commit from anywhere on the build ray inside `wallReach` (B3 — the sim always
    // allowed a 180px drag, bots just never sent one) with a real lateral tolerance instead of
    // a point; and give the walk a deadline so it can never loop forever.
    if (bm.deflect && (mem.t > bm.deflect.until || isOnBall)) bm.deflect = null;
    if (!isOnBall && sk.toolSkill >= 0.70 && buildReady && !bm.buildHold && !spLive && mem.t > (bm.nextBuildAt || 0)) {
      const distCG = hyp(egX - carrier.x, GY - carrier.y);
      // WHY THIS PREDICATE CHANGED — measured over 8 matches at t=0.82. The old test was
      // "an enemy is standing in their own box near the goal", a PROXY for "our carrier's direct
      // finish is blocked". Of 7463 support-with-mate-carrying ticks, the range condition held on
      // 914 but the proxy held on 29, and the play ARMED 0 times. The proxy is really asking for a
      // KEEPER — and no bot in this game ever plays keeper, so the trigger could not occur.
      // Test the actual intent instead: is the carrier's lane to the goal genuinely shut? That is
      // one exact segment test (laneClear is segment-vs-AABB, not sampled) and it is true exactly
      // when banking a shot off a wall is worth setting up. The wall BUDGET still limits how often
      // this can spend a charge (nextBuildAt 8s, and goalScreen/blockDrive/ambushWall outrank it).
      const blocked = !laneClear(carrier.x, carrier.y, egX, GY, state, team, { enemies: true, viewer: p });
      if (!bm.deflect && distCG < 760 && distCG > 240 && blocked) {
        const dirToGoal = egX > FIELD.W / 2 ? 1 : -1;
        const Wx = egX - dirToGoal * (PENALTY.depth + 34);
        const Wy = clamp(GY + (carrier.y > GY ? 150 : -150), 160, FIELD.H - 160);
        const [inx, iny] = unit(Wx - carrier.x, Wy - carrier.y); // incoming travel dir C->W
        const [gx2, gy2] = unit(egX - Wx, GY - Wy);              // desired out dir W->goal
        const [nx, ny] = unit(gx2 - inx, gy2 - iny);             // mirror normal (face normal = build aim)
        if (!pointInBush(Wx, Wy) && Math.abs(Wx - egX) > PENALTY.depth + 8) {
          bm.deflect = { x: Wx, y: Wy, nx, ny, until: mem.t + 2.5 }; // LATCH: it stops moving now
        }
      }
      if (bm.deflect) {
        const { x: Wx, y: Wy, nx, ny } = bm.deflect;
        const reach = wallReach(sk);
        const along = (Wx - p.x) * nx + (Wy - p.y) * ny;          // how far up the build ray the wall sits
        const lat = Math.abs((Wx - p.x) * -ny + (Wy - p.y) * nx); // how far OFF the ray we are
        aim = { x: nx, y: ny };
        if (along >= BUILT_WALL.offset - 22 && along <= reach + 8 && lat < 52) {
          const dist = wallPush(p, Wx, Wy, nx, ny, sk);
          // wx/wy LATCH the wall's world centre, so finalize() re-derives the drag from wherever
          // this bot ends up standing.
          if (!bm.buildHold) bm.buildHold = { x: nx, y: ny, wx: Wx, wy: Wy, dist, until: mem.t + BUILD_WINDUP + 0.1 };
          else bm.buildHold.dist = dist;
          bm.nextBuildAt = mem.t + 8.0 * (sk.cdMul || 1) * toolGap(sk, 'wall'); bm.lastTrick = 'deflectSetup'; bm.deflect = null;
          (mem.setPiece || (mem.setPiece = {}))[team] = { x: Wx, y: Wy, by: p.id, until: mem.t + 3.0 };
          // Was `{x: p.x, y: p.y}` — pinned to its own feet for the whole wind-up so the wall
          // would not move. The latch above is what keeps the wall still now, so hold the build
          // RAY instead: the ray-frame clamp in finalize() keeps this legal and the bot walking.
          return finalize(p, { x: Wx - nx * reach, y: Wy - ny * reach }, aim, { shoot: false, charge: 0, special: false, build: false }, state, mem, bm, sk, dt);
        }
        // walk onto the build ray, standing back by the tier's full reach
        return finalize(p, { x: Wx - nx * reach, y: Wy - ny * reach }, aim, { shoot: false, charge: 0, special: false, build: false }, state, mem, bm, sk, dt);
      }
    }
    // ===== THE CATAPULT (requested) — wall + bomb behind the carrier, who flies WITH the ball ===
    // "give them a skill where one has the ball and the friend puts a wall and a bomb behind it so
    //  it would propel with the ball" — and it works because of ONE line in explode():
    //     if (bd < radius && !(bomberOnCenter && b.owner)) { ...knock the ball loose... }
    // When the PLANTER is standing on its own bomb and somebody owns the ball, the ball is NOT
    // stripped. So a team-mate's on-centre bomb is the only blast in the game that can move a
    // carrier without taking the ball off them.
    // MEASURED with a scripted fixture: mate plants on-centre 110px behind the carrier -> carrier
    // +490px and KEEPS THE BALL, mate +539px. With a stone wall behind the bomb: +595 / +649. A
    // carrier walking the same 2.92s covers 400px, and less while carrying.
    // GEOMETRY — wall -> bomb -> carrier, all on the carrier's run, and every part matters:
    //   * the wall must be BEHIND the bomb: wallCannonMul only boosts a wall in the cone OPPOSITE
    //     the push (built wall peak 1.15, scaled by HP);
    //   * it must NOT be between bomb and carrier, where a full-HP built wall soaks 75% of the
    //     blast (BLAST_WALL_PASS_MIN 0.25);
    //   * the bomb must be behind the carrier AT DETONATION, not now. The carrier keeps running, so
    //     the plant spot leads it by its own speed x BOMB.fuse and the DIRECTION is latched while
    //     the point is re-derived — the point translates smoothly along a fixed line, which is what
    //     makes re-deriving safe here and fatal in the old walk-to-a-pad code (there the point
    //     flipped SIDES mid-walk). mem.cata asks the carrier to hold that heading.
    if (bm.cata && (mem.t > bm.cata.until || state.ball.owner !== carrier.id || isOnBall)) bm.cata = null;
    if (!isOnBall && !bm.cata && skT(sk) >= T_CATAPULT && bombReady
        && mem.t > (bm.nextCataAt || 0) && mem.t > (bm.nextBombAt || 0) && toolNotice(sk, p, mem)) {
      const cSpd = hyp(carrier.vx || 0, carrier.vy || 0);
      const [cdx, cdy] = cSpd > 40 ? unit(carrier.vx, carrier.vy) : unit(egX - carrier.x, GY - carrier.y);
      const towardGoal = (egX - carrier.x) * cdx + (GY - carrier.y) * cdy > 0;   // never launch them backwards
      const lead = Math.max(90, cSpd) * BOMB.fuse - CATA_BACK;
      const spot = { x: clamp(carrier.x + cdx * lead, 120, FIELD.W - 120), y: clamp(carrier.y + cdy * lead, 120, FIELD.H - 120) };
      const chSpeed = (CHARACTERS[p.char] || CHARACTERS[DEFAULT_CHAR]).speed * (settings.speedMul || 1);
      const reachable = hyp(spot.x - p.x, spot.y - p.y) / Math.max(1, chSpeed) < CATA_WINDOW - BOMB.fuse - BUILD_WINDUP;
      let ok = towardGoal && reachable
        && laneClear(carrier.x, carrier.y, carrier.x + cdx * 420, carrier.y + cdy * 420, state, team, { enemies: false })
        && laneClear(p.x, p.y, spot.x, spot.y, state, team, { enemies: false });
      for (const e of visibleEnemies) if (hyp(e.x - carrier.x, e.y - carrier.y) < 220) ok = false; // they'd strip it first
      if (ok) {
        bm.cata = { dx: cdx, dy: cdy, phase: 'walk', until: mem.t + CATA_WINDOW };
        bm.nextCataAt = mem.t + 14.0;   // flat, for the same reason as MOBILITY_GAP
        (mem.cata || (mem.cata = {}))[team] = { dx: cdx, dy: cdy, by: p.id, until: mem.t + CATA_WINDOW };
      }
    }
    if (bm.cata) {
      const q = bm.cata;
      const cSpd = hyp(carrier.vx || 0, carrier.vy || 0);
      const lead = Math.max(90, cSpd) * BOMB.fuse - CATA_BACK;
      const spot = { x: clamp(carrier.x + q.dx * lead, 120, FIELD.W - 120), y: clamp(carrier.y + q.dy * lead, 120, FIELD.H - 120) };
      if (q.phase === 'walk') {
        if (hyp(spot.x - p.x, spot.y - p.y) > 46) {
          bm.lastTrick = 'catapultSetup';
          return finalize(p, spot, { x: q.dx, y: q.dy }, { shoot: false, charge: 0, special: false, build: false }, state, mem, bm, sk, dt);
        }
        if (buildReady && !bm.buildHold && mem.t > (bm.nextBuildAt || 0)) {
          // aim BACKWARDS so the capsule lands behind the plant spot — that is the cannon side.
          // The wall's spot is latched in WORLD space (wx/wy): measured without it, the catapult
          // wall committed with 116deg of aim drift and 115px of error, because from the next tick
          // the aim came from whatever ran then — and this play's whole value is the wall being
          // BEHIND the bomb, in the cone opposite the push.
          const wcx = p.x - q.dx * 70, wcy = p.y - q.dy * 70;
          const dist = wallPush(p, wcx, wcy, -q.dx, -q.dy, sk);
          bm.buildHold = { x: -q.dx, y: -q.dy, wx: wcx, wy: wcy, dist, until: mem.t + BUILD_WINDUP + 0.1 };
          bm.nextBuildAt = mem.t + 8.0 * (sk.cdMul || 1) * toolGap(sk, 'wall');
          q.phase = 'build'; bm.lastTrick = 'catapultWall';
          return finalize(p, { x: p.x, y: p.y }, { x: -q.dx, y: -q.dy }, { shoot: false, charge: 0, special: false, build: false }, state, mem, bm, sk, dt);
        }
        q.phase = 'plant';                                   // no wall charge: the bomb alone still flings them
      }
      if (q.phase === 'build') {
        if (bm.buildHold) {
          bm.lastTrick = 'catapultWall';
          return finalize(p, { x: p.x, y: p.y }, { x: -q.dx, y: -q.dy }, { shoot: false, charge: 0, special: false, build: false }, state, mem, bm, sk, dt);
        }
        q.phase = 'plant';
      }
      if (q.phase === 'plant') {
        bm.cata = null;
        if ((p.specialCd || 0) <= 0 && !bm.bombHold) {
          // plant at our FEET and stand on it: bomberOnCenter is what saves the carrier's ball
          bm.bombHold = { x: p.x, y: p.y, until: mem.t + BOMB.fuse + 0.1, aimX: p.x + q.dx * 500, aimY: p.y + q.dy * 500 };
          bm.nextBombAt = mem.t + 3.0 * (sk.cdMul || 1) * toolGap(sk, 'bomb');
          bm.lastTrick = 'catapult';
          return finalize(p, { x: p.x, y: p.y }, { x: q.dx, y: q.dy }, { shoot: false, charge: 0, special: true, build: false }, state, mem, bm, sk, dt);
        }
      }
    }

    // ---- RECEIVE THE CALL: my mate has committed a pass to ME --------------------------------
    // The other half of the communication. Measured before the latch existed: of 49 releases only
    // 22% reached a team-mate and 16% reached an ENEMY — the receiver was standing on an outlet spot
    // it had chosen for its own reasons, sometimes with a defender in the lane.
    // So: if the lane from the carrier to me is dirty, slide PERPENDICULAR until it is clean (a
    // committed side, so it doesn't dither); otherwise close a little toward the carrier to shorten
    // the pass. Above the body screen, because a screen while the ball is on its way to me is the
    // wrong job; below the deflect set-piece, which is rarer and worth more.
    // "THE FRIEND SOMETIMES GOES THE OTHER WAY" — MEASURED, AND THIS BRANCH OWNED A THIRD OF IT.
    // At the reported level 10 (partner 0.42 vs enemy 0.93, 12 x 60s x 3 seed bases, bot-support.mjs):
    // 22-29% of the partner's support move-ticks were spent actively running AWAY from the goal its own
    // team was attacking, and [receivePass] was ~60% of the ticks the flow field was NOT merely routing
    // round a wall — with the receiver ALREADY AHEAD OF THE CARRIER on 88% of them.
    //
    // The cause is not the 90px. It is that the 90px target was recomputed from the receiver's LIVE
    // position EVERY TICK: 90px behind wherever it had just got to, re-issued ~50x a second for the
    // whole 1.4s call. A carrot on a stick. So the receiver did not check back 90px, it RETREATED
    // CONTINUOUSLY — up to ~210px at walking pace — and the latch above, which re-aims at the
    // receiver's led position, FOLLOWED IT BACKWARDS. Both reported symptoms are one bug, two ends.
    //
    // THE FIX IS A GROUND BUDGET, AND THE SHAPE OF IT IS MEASURED, NOT CHOSEN. `RECV_GIVE_MAX` caps
    // the ground a receiver may give up over a whole call; under the cap the per-tick close is left
    // EXACTLY as it was, and that is deliberate:
    //   * closing straight along the pass line is ANGULARLY STATIONARY from the carrier's point of
    //     view, so the carrier's slewing aim converges and `fire` passes its |dTheta| <= tol gate.
    //     It is why the latch completes ~90% of passes at all.
    //   * TWO tidier-looking rewrites were built and both broke that, ON THE COMBINED HEAD, measured
    //     with bot-passes.mjs at 60 matches, skill 0.93 (86% before):
    //       - a per-tick clamp ("never emit a backward step")     -> 72%, and -37% of pass releases
    //       - latching an absolute rendezvous SPOT for the call   -> 81% (72% with the clamp too)
    //     A receiver that stops closing is a receiver the pass has to be threaded to.
    //   * the budget keeps 89% (better than the 86% it started at) because the close still happens —
    //     it just cannot run away for a fifth of the pitch.
    // NB the SPOT-LATCH version shipped briefly in d01d3b8 and was replaced here for exactly that
    // reason: it measured fine (90 -> 92%) against the older base it was developed on, and cost
    // 86 -> 70% once the other agents' bullet/wall latches were in the tree. Measure on HEAD.
    const call = mem.pass && mem.pass[team];
    if (call && call.to === p.id && mem.t < call.until && state.players[call.from] && !bm.bombHold && !bm.buildHold) {
      const from = state.players[call.from];
      const [lx, ly] = unit(p.x - from.x, p.y - from.y);
      const fwd = egX >= ogX ? 1 : -1;                                       // +x for A, -x for B
      let want = { x: p.x - lx * 90, y: p.y - ly * 90 };                     // check back for it
      if (!laneClear(from.x, from.y, p.x, p.y, state, team, { margin: 6, viewer: p })) {
        // the side stays LATCHED PER BOT, as it always was ("a committed side, so it doesn't dither").
        // Re-deciding it per tick, scored on which lane is more open — the kind of thing that usually
        // scales with tier — measured EXACTLY NEUTRAL, so it is not worth the code or the dither risk.
        const side = (bm.recvSide = bm.recvSide || ((idHash(p.id) & 1) ? 1 : -1));
        want = { x: clamp(p.x - ly * 190 * side, 80, FIELD.W - 80), y: clamp(p.y + lx * 190 * side, 80, FIELD.H - 80) };
      }
      // THE BUDGET. Anchor where the receiver stood when the call arrived, and once it has given up
      // RECV_GIVE_MAX of ground, stop giving up any more: keep the lateral part of the run, drop the
      // backward part. Lateral is a real way to show for a ball; retreating past your own carrier is not.
      if (!bm.recvAnchor || bm.recvAnchor.until !== call.until) bm.recvAnchor = { x: p.x, until: call.until };
      if ((bm.recvAnchor.x - p.x) * fwd >= RECV_GIVE_MAX && (want.x - p.x) * fwd < 0) want = { x: p.x, y: want.y };
      bm.lastTrick = 'receivePass';
      bm.nextPassAt = mem.t + PASS_COOLDOWN * 0.75;   // take a touch before you give it back
      // early return ON PURPOSE: the MIN_SEP floor below exists to stop both bots crowding the
      // ball, and it would drag the receiver away from the pass it was just called for.
      return finalize(p, want, { x: from.x - p.x, y: from.y - p.y }, { shoot: false, charge: 0, special: false, build: false }, state, mem, bm, sk, dt);
    }

    // PRECEDENCE: the BODY SCREEN sits here, BELOW the deflect set-piece, and that order is
    // load-bearing. It was originally first, and it starved the set-piece completely: measured,
    // on 47 of 47 ticks where the deflect was available the screen latch was already active and
    // returned early. A screen is a delaying tactic that costs nothing and there is always
    // another chance at one; the set-piece is rare (0.6% of support ticks), spends a scarce wall
    // charge and creates a goal chance. Cheap-and-always-available must not pre-empt
    // rare-and-valuable — the same rule the wall plays already follow among themselves.
    // ---- NEW SKILL: BODY SCREEN — wall off the defender chasing our carrier ------------------
    // The player sees their team-mate stop running for a pass and instead step IN FRONT of the
    // defender hunting them. It works because steer() has NO body avoidance at all: it reacts to
    // other players only when they are bomb-launched or moving > 700px/s, and the nav occupancy
    // grid is built from WALLS only. So a parked body is a genuine obstacle — separatePlayers
    // (sim.js:354) is a hard symmetric push with no pass-through rule.
    // Measured: time-to-press 1.68s unscreened vs 6.67s screened; one fixture recorded NO CONTACT
    // IN 10s. Costs no ammo, no bomb, no wall charge — it is the cheapest teamwork in the game.
    // FAIRNESS: pure movement, nothing a human could not do, and legible — you see the body coming
    // and can side-step it. NB sim.js:370 biases the shove 65/35 (SUPER_BODY_PUSH) toward whichever
    // side is in super, so a screener without super loses the duel to a super chaser.
    if (!isOnBall && sk.toolSkill >= 0.70 && !bm.bombHold && !bm.buildHold) {
      let chaser = null, cd = 1e9;
      for (const e of visibleEnemies) { const d = hyp(e.x - carrier.x, e.y - carrier.y); if (d < cd) { cd = d; chaser = e; } }
      // ARM ONCE on entry (the `if (!bm.buildHold)` pattern). Re-arming every tick while a chaser
      // stayed in range would make the hold a dead variable and the screen effectively permanent.
      if (chaser && cd < 300 && mem.t > (bm.screenUntil || 0) && mem.t > (bm.nextScreenAt || 0)) {
        bm.screenUntil = mem.t + 1.1; bm.nextScreenAt = mem.t + 2.6;
      }
      if (chaser && mem.t < (bm.screenUntil || 0)) {
        const [sx, sy] = unit(chaser.x - carrier.x, chaser.y - carrier.y);
        const standOff = radOf(state) * 2 + 8; // just in front of the carrier, in the chaser's path
        // NB no bm.screening flag: the spec had one, and a challenger showed it was set and never
        // cleared, so after its first screen a bot permanently lost the MIN_SEP 320 spacing rule.
        // Returning early here already bypasses MIN_SEP for exactly the screening ticks.
        bm.lastTrick = 'bodyScreen'; bm.seekContact = true;  // stepping INTO the chaser's path is the point
        return finalize(p, { x: carrier.x + sx * standOff, y: carrier.y + sy * standOff },
          { x: chaser.x - p.x, y: chaser.y - p.y },
          { shoot: false, charge: 0, special: false, build: false }, state, mem, bm, sk, dt);
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
      // MEASURED AND REFUTED — DO NOT RE-PROPOSE: "prefer an outlet the PER-ARENA PLAN says you
      // could SHOOT from" (shared/arena-plan.js `shootSpotsFor`). The gap is real — this chooser
      // scores an outlet on openness and a clean PASS LANE and never asks whether the receiver
      // could shoot, and 54.8% of MAIN_FIELD has no lane to any part of the mouth — and unlike the
      // carrier version (see the release ladder's (d) rung) an off-ball bot HAS the time to get
      // there. It still lost, on HEAD + this change only, 4-6 paired seed bases x 12 matches x 60s:
      //   skill 0.93 (48 matches/arm): goals/match 1.90 -> 1.54 (**4 of 4 seeds DOWN**),
      //     wall-pinning 0.27% -> 0.51%, worst single jam 0.68s -> 2.16s (one seed 6.87s)
      //   skill 0.50 (60 matches/arm): goals 0.93 -> 0.83, pinning 0.41% -> 0.70% (4/5 worse),
      //     worst jam 1.71s -> 3.76s (seeds with 7.4s and 9.1s)
      // It DID buy exactly what round 7 wanted — advance/release +15px (4/4) and backward releases
      // 27.6% -> 17.7% (4/4) at the top — but `clearForward` already delivers that, and the price is
      // the symptom the user personally reported and round 5 spent a whole session fixing (worst jam
      // 15.65s -> 0.73s). A named POINT target near the attacking geometry wedges bots; the x=ahead
      // vertical line does not. Guarding the goal line (|sp.x - egX| < 200, added after a 16.58s jam)
      // reduced but did not remove it.
      // The plan module and its tests are kept, deliberately UNWIRED — see its header.
      // TACTIC 10 — COOPERATIVE PUSH (hard/extreme): rocket-jump into the open attacking outlet so
      // the carrier can hit a fast one-two (the pass arrives via the pass-to-mate logic below). We
      // signal mem.push so the carrier prioritises the pass. A bomb-jump into space, no enemy near.
      // Same measured decision as the catch-up jump — this is the OTHER mobility jump, and it is
      // the one that was quietly winning the race for the bomb charge (118-150 commits vs the
      // cannon's 9-14) while planting at its feet with nothing behind it.
      {
        const j = mobilityJump(p, bm, mem, state, sk, { x: ahead, y: bestY }, visibleEnemies, bombReady, 'coopPush');
        if (j) {
          (mem.push || (mem.push = {}))[team] = { x: ahead, y: bestY, by: p.id, until: mem.t + 2.4 };
          return finalize(p, { x: p.x, y: p.y }, j, { shoot: false, charge: 0, special: true, build: false }, state, mem, bm, sk, dt);
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
        // ASK #2 + the measured defect: `clearMarker` had NO angle term, so ~half its shots pushed the
        // chaser along their own run and made them arrive 1.18s SOONER. From L5 up it only fires when
        // the push is actually unhelpful to the marker, and it asks for full power (ask #1) rather than
        // the old 0.8 — the whole point of the play is displacement.
        const pvM = pushValue(p, mark, state, true);
        if (levelChance(sk, p, mem, 'mark') && pvM < 0) {
          bm.nextMarkAt = mem.t + 0.25;                 // re-look soon: this was a bad angle, not a bad idea
          if (!bm.lastTrick) bm.lastTrick = 'pushAngle';
        } else {
          aim = { x: ax, y: ay }; shoot = true; shootTgt = mark.id; charge = 1; bm.lastTrick = 'clearMarker'; bm.nextMarkAt = mem.t + 0.7 * (sk.cdMul || 1); if (md < 160) closeShot = true;
        }
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

    // ===== B1b — SUPER BODY-STRIP (gate t >= 0.82) ==========================================
    // MECHANICS §5: while in super, body contact with an enemy BALL-CARRIER knocks the ball
    // loose (resolveSuperBodyStrip — carrier shoved SUPER_BODY_STRIP_KB, ball pops loose). A
    // skilled bot therefore does NOT burn the whole meter on an overcharge bullet when the
    // carrier is already close enough to run down: it walks through them. That costs ONE of
    // SUPER_USES instead of the entire meter, and it works with the bullet lane blocked.
    // This is "better execution of the same verbs" (move at a body), not a new ability — a
    // human with a lit ring does exactly this.
    // TELL: a bot with the red overcharge ring walking straight at you is announcing the strip.
    // COUNTER: don't dribble into it — pass, or shoot it first (a hit breaks the approach), or
    // wall it off; and the ring expires on OVERCHARGE_TTL (4s), so waiting it out is real.
    // Self-limiting: only while the ring is lit, only on a carrier this bot can actually SEE,
    // only inside SUPER_BODY_CLOSE (a ~1.5s run, well under the 4s TTL), and never through
    // indestructible stone (a wall the bot cannot walk through is not a path).
    if (p.power && skT(sk) >= T_SUPER_BODY && seeC && distC < SUPER_BODY_CLOSE
        && !indestructibleBlocks(p.x, p.y, c.x, c.y, state)) {
      const lead = clamp(distC / 400, 0, 0.35);           // run at where they WILL be, not where they are
      bm.lastTrick = 'superBodyStrip'; bm.seekContact = true;   // the whole play IS the body contact
      return finalize(p, { x: c.x + (c.vx || 0) * lead, y: c.y + (c.vy || 0) * lead },
        { x: c.x - p.x, y: c.y - p.y }, { shoot: false, charge: 0, special: false, build: false }, state, mem, bm, sk, dt);
    }

    if (isOnBall) {
      // INTERCEPT, DON'T TRAIL (the user's ask #2: "at least one bot ... go after the ball in enemy
      // hands, or at least intercept where the enemy is going"). Walking at `c.x, c.y` is a tail
      // chase that never closes on a carrier running away at the same speed; interceptPoint walks at
      // where they will be, shaded onto the goal side so the press cuts the lane.
      tgt = interceptPoint(p, c, state, sk);
      // ASK #2, the half that actually fires: the push travels along the BULLET's line, so where you
      // STAND decides which way the carrier flies. Standing goal-side (between the carrier and the
      // goal they are attacking) means every strip shoves them back up the pitch instead of forward.
      // A bounded shift, so it biases the approach without abandoning the intercept: at most 130px.
      if (levelChance(sk, p, mem, 'press')) {
        const [gx2, gy2] = unit(egX - c.x, GY - c.y);            // carrier -> the goal they attack
        // Scaled by the persona's own appetite for depth, because a flat shift made EVERY presser
        // goal-side and collapsed the Fortress/Enforcer distinction that test-bot-personas.mjs
        // measures (Fortress 50.4% vs Enforcer 57.6% — backwards). A Fortress now shifts ~1.3x, an
        // Enforcer ~0.9x, so both the ask and the identity survive.
        const ggShift = 0.70 + 0.60 * ((sk.pp && sk.pp.guardGoal != null) ? sk.pp.guardGoal : 0.5);
        const shift = Math.min(130, 0.20 * distC) * ggShift;
        tgt = { x: clamp(tgt.x + gx2 * shift, 20, FIELD.W - 20), y: clamp(tgt.y + gy2 * shift, 20, FIELD.H - 20) };
      }
      if (hyp((c.vx || 0), (c.vy || 0)) > 40 && !bm.lastTrick) bm.lastTrick = 'pressIntercept';
      // Only CLOSE contact counts as wanted: a strip is a BULLET at up to PRESS_RANGE (~436px), so a
      // presser has no reason to grind into the carrier's body — measured, keeping the whole press
      // range as "seek contact" tripled enemy-body blocking. Inside 140px the shove is the point.
      bm.seekContact = distC < 140;
      if (pc) {
        const [ax, ay] = leadAim(p.x, p.y, pc.x, pc.y, pc.vx, pc.vy, bulletSpeed, sk);
        aim = { x: ax, y: ay };
      }
      // a FULL-charge bullet strips the ball even INSIDE the box (only knockback is cut there)
      if (canShoot && seeC && lane && distC < PRESS_RANGE) {
        // ASK #2: from L5 up, hold a beat when the shot would shove the carrier TOWARD the ball or
        // along their own run — unless they are close enough that the strip itself is the point, or
        // we have already waited (bounded by pushWaitUntil so this can never become a stall).
        const pv = pushValue(p, c, state, true);
        const wantAngle = levelChance(sk, p, mem, 'push') && distC > 200 && pv < -0.15;
        if (wantAngle && !(bm.pushWaitUntil && mem.t > bm.pushWaitUntil)) {
          if (!bm.pushWaitUntil) bm.pushWaitUntil = mem.t + 0.45;   // at most ~0.45s of repositioning
          if (!bm.lastTrick) bm.lastTrick = 'pushAngle';
        } else {
          bm.pushWaitUntil = 0;
          shoot = true; shootTgt = c.id; charge = 1; if (distC < 260) closeShot = true;
        }
      }
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
          && !indestructibleBlocks(p.x, p.y, c.x, c.y, state) && mem.t > (bm.nextBombAt || 0)) {
        special = true; shoot = false; aim = { x: c.x - p.x, y: c.y - p.y };
        bm.bombHold = { x: p.x, y: p.y, until: mem.t + BOMB.fuse + 0.1, targetId: c.id, aimX: c.x, aimY: c.y };
        bm.nextBombAt = mem.t + 3.0 * (sk.cdMul || 1) * toolGap(sk, 'bomb'); bm.lastTrick = 'bombTackle';
        // Signal a TWO-BOMB stack: tell a NEARBY support bot to drop a second bomb on the same
        // spot so the blasts COMBINE (bigger strip/knockback on the carrier).
        // WINDOW: the PHYSICAL deadline is the first bomb's detonation — a second bomb only
        // combines if it already exists when the first blows. The old BOMB.fuse * 0.7 (1.21s)
        // was an arbitrary fraction UNDER that deadline and it is a large part of why doubleBomb
        // never once fired (measured: 0 plants, 243 wasted approach ticks over 18 matches).
        // BOMB.fuse - 0.25 keeps a safety margin for the plant tick and buys back 0.28s.
        (mem.stack || (mem.stack = {}))[team] = { x: pcx, y: pcy, by: p.id, until: mem.t + BOMB.fuse - 0.25 };
      }
    } else {
      // TWO-BOMB JOIN: the presser just committed a tackle bomb — rush in and plant a SECOND
      // within the combine radius so they detonate together (a deliberate set-piece; bypasses
      // the usual mate-safety spacing). Skilled bots only.
      // Only a support bot ALREADY near the stack joins — no cross-map sprint that abandons
      // cover (that starved the ambush/mark plays). Occasional, opportunistic set-piece.
      // WHY IT NEVER FIRED (measured, 6 matches x 60s x 3 tiers, instrumented predicates):
      // the join REACHED the branch often (21 / 202 / 30 eligible ticks) and planted ZERO times.
      // Every single one went down the "walk to the stack first" leg. The arithmetic: the window
      // was BOMB.fuse * 0.7 = 1.21s, the mean distance at signal time was 550px, and a bot moves
      // ~142px/s (CHARACTERS.player.speed 158 x speedMul 0.9) — ~3.9s of walking for a 1.2s
      // window, and the plant tolerance was BOMB_COMBINE_RADIUS * 0.6 = 126px when the sim's
      // combine test is the FULL 210px radius. `bombReady` was never the blocker (0 ticks lost
      // to cooldown). Three root-cause fixes: the window now runs to the real deadline (above),
      // the plant fires anywhere genuinely INSIDE the combine radius, and the bot only commits
      // to an approach it can actually finish — instead of burning 243 ticks walking at a bomb
      // that blew up before it arrived.
      // DON'T WALK — LOB. The join was still 0-for-everything after the window fix: measured
      // again, the branch was ADMITTED on 20 ticks at t=1.00 and 0 at t=0.50/0.82, and all 20
      // went down the walk leg. The reason is structural and no threshold can fix it — the
      // off-ball SEPARATION floor below holds a support bot at >= MIN_SEP (320px) from the
      // carrier, the stack point IS the carrier's predicted spot, and 1.475s of window buys
      // ~157px of walking. The bot can never be standing there. But it does not have to be:
      // useSpecial LOBS a bomb up to BOMB_LOB_RANGE (250px) along the (sax,say) drag, and
      // finalize already turns `bm.bombHold.x/y` into exactly that lob vector — it is the same
      // mechanism the wall-cannon uses. So the support THROWS the second bomb onto the stack
      // from where it already stands. A lobbed bomb gives no self-launch, which is correct here:
      // this play is about combining the blasts on the carrier, not about flying.
      const stk = mem.stack && mem.stack[team];
      const JOIN_PLANT_R = BOMB_COMBINE_RADIUS * 0.9;      // anywhere inside the radius combines; 0.6 was a needless bullseye
      if (stk && stk.by !== p.id && mem.t < stk.until && bombReady && sk.toolSkill >= 0.75 && !bm.bombHold
          // Reach = how far the LOB carries plus how far off-centre the bomb may still land and
          // combine. No walking, so no "can I get there in time" question to get wrong.
          && hyp(stk.x - p.x, stk.y - p.y) < BOMB_LOB_RANGE + JOIN_PLANT_R) {
        // Anchor the throw ON the stack; finalize clamps the drag to BOMB_LOB_RANGE, so an
        // anchor further out simply becomes a max-length lob along the same line. Deliberately
        // NO bm.bombHold: that is the "stand on your plant for the fuse" state, which exists to
        // earn the rocket-jump. Here it would walk the support bot into its own blast.
        // MEASURED OUTCOME OF THE LOB REWRITE ABOVE: still ~0 fires, and the remaining reason is
        // NOT a threshold — it is branch reachability. Instrumented over 8 matches at t=0.82:
        // 5 tackle signals, 890 bot-ticks inside the live window, and the full conjunction is
        // satisfied on 27 of them. But at those 27 moments the ball was LOOSE on 22 and held by
        // an enemy on only 5. The tackle bomb that RAISES the signal has usually already stripped
        // the carrier by the time a mate could join, and with no carrier the support bot is in the
        // loose-ball branch, where this code does not exist. The play is chasing a situation its
        // own trigger destroys, so it fires only in the ~0.08s where a carrier survives the tackle.
        // Left in place because it is correct and free when it does hit; do NOT "fix" it by
        // widening gates again (that has now been tried three times). The salvageable idea is the
        // LOB ITSELF, decoupled from the tackle signal: a lobbed bomb strips a carrier on its own
        // (verified: off-centre blast strips at 1.72s, feet plant 1.78s via the flying tackle,
        // sim.js:1516 only suppresses the ball-pop when the bomber stands ON its own bomb). That is
        // a new ability and needs sign-off, not a silent widening of this gate.
        bm.lastTrick = 'doubleBomb'; bm.nextBombAt = mem.t + 3.0 * (sk.cdMul || 1) * toolGap(sk, 'bomb');
        return finalize(p, { x: p.x, y: p.y }, { x: stk.x - p.x, y: stk.y - p.y },
          { shoot: false, charge: 0, special: true, build: false, lob: { x: stk.x, y: stk.y } }, state, mem, bm, sk, dt);
      }
      // The two off-ball defensive commitments below (B4 pincer, B2 keeper) both want THIS bot,
      // and so does the wall game. Precedence, and the reason for it:
      //   1. a WALL I can actually raise right now  — a wall is worth more than a body, and both
      //      of the revived showpieces (blockDrive/ambushWall, goalScreen) live below;
      //   2. B4 PINCER — only when our presser is already tight, i.e. the trap is really on;
      //   3. B2 KEEPER — the fallback when the carrier is a threat and nothing else is on.
      const ogSign = ogX === 0 ? 1 : -1;
      const screenPlaneX = ogX + ogSign * (PENALTY.depth + 20); // solid hp3 ground just OUTSIDE our box
      const iGoalSide = Math.abs(p.x - ogX) < Math.abs(c.x - ogX);
      const buildNow = buildReady && mem.t > (bm.nextBuildAt || 0);
      // "I could put a wall somewhere useful THIS SECOND" — the wall-trap stand band, or near
      // enough to the goal-screen plane to raise it. Anything looser and the keeper would eat
      // the two build plays it is supposed to coexist with.
      // The screen clause is a TIME test, not a distance one, because that is the actual
      // question: can I raise a wall BEFORE the carrier gets here? A wall costs the walk onto
      // the plane plus BUILD_WINDUP; the carrier needs its remaining distance at carry speed.
      // Distance thresholds could not express this and the two plays starved each other —
      // measured with a plain "am I near the plane" test, goalScreen went from 7 fires at
      // t=0.50 (the tier with no keeper) to 0 at t=0.82 and t=1.00, with `liningUp` holding on
      // 1 of 826 fallback ticks because the keeper had already returned on all the others.
      const chSpeed = (CHARACTERS[p.char] || CHARACTERS[DEFAULT_CHAR]).speed * (settings.speedMul || 1);
      const carrySpeed = chSpeed * (settings.carrySpeedMul || 1);
      const screenY0 = clamp(GY + (c.y - GY) * 0.45, GY - GOAL.width / 2, GY + GOAL.width / 2);
      const screenStand = { x: screenPlaneX - ogSign * wallReach(sk), y: screenY0 };
      const tArrive = Math.abs(c.x - ogX) / Math.max(1, carrySpeed);
      const tBuild = hyp(p.x - screenStand.x, p.y - screenStand.y) / Math.max(1, chSpeed) + BUILD_WINDUP;
      const wallPlayOn = buildNow && ((iGoalSide && distC > 130 && distC <= 380)
        || (tArrive > tBuild + 0.3 && Math.abs(p.y - GY) < GOAL.width / 2 + 200));

      // ===== B4 — PINCER (gate t >= 0.92, OUR OWN HALF ONLY) ==================================
      // assignRoles deliberately holds the off-ball bot at MIN_SEP = 320px from the carrier so
      // both bots never crowd the ball — correct as a default, and it stays the default. At the
      // top three levels only, in our own half only, and only while our presser is ALREADY tight
      // on the carrier, the support bot breaks that floor and closes the ESCAPE LANE: ahead of
      // the carrier along its heading, on the flank the presser is NOT on, so the two visibly
      // converge from two sides instead of stacking on one.
      // TELL: the two bots split and converge — the one bot behaviour that is obvious at a
      // glance, even at minimap scale.
      // COUNTER: release early. A pincer beats dribbling and loses to a first-touch pass, which
      // is exactly the skill we want teens to learn.
      // HARD-LIMITED, because this is the one skill that can feel unfair (design §4 B4): own
      // half only, a SEEN carrier only, a 2.0s engagement, a cdMul-scaled 6s cooldown between
      // attempts (so at most ~25% duty cycle), and it ABORTS the instant the carrier stops
      // being the carrier — which is what makes "pass it" a real counter and not a slogan.
      const pressTight = !!mate && hyp(mate.x - c.x, mate.y - c.y) < 260;
      const ownHalf = Math.abs(c.x - ogX) < FIELD.W * 0.5;
      if (skT(sk) >= T_PINCER && seeC && ownHalf && pressTight && !bm.pincer && mem.t > (bm.nextPincerAt || 0)) {
        // LATCH the whole play at engagement: the victim, the escape lane, and which flank is
        // ours. Two reasons, both found by tracing rather than reasoning:
        //  * the VICTIM, because `c` is re-read from the live carrier every tick — abort on
        //    "the carrier changed" alone and the trap silently re-targets the RECEIVER the
        //    instant the trapped player passes, so "release early" stops being a counter at all;
        //  * the LANE, because a carrier's instantaneous velocity is not a heading. Traced on a
        //    pinned carrier it swung between (+64,-111) and (-112,-61) at ~128px/s, flipping the
        //    chosen flank every few ticks: the bot jittered for 3s and closed nothing. A pincer
        //    is a commitment to one side; committing is also what makes it READABLE.
        // Below 40px/s there is no heading to read, so the honest guess is "at our goal".
        const cSpd = hyp(c.vx || 0, c.vy || 0);
        const [hx, hy] = cSpd > 40 ? unit(c.vx, c.vy) : unit(ogX - c.x, GY - c.y);
        let perpX = -hy, perpY = hx;
        if (mate && ((mate.x - c.x) * perpX + (mate.y - c.y) * perpY) > 0) { perpX = -perpX; perpY = -perpY; } // take the OTHER flank
        bm.pincer = { id: c.id, until: mem.t + 2.0, hx, hy, px: perpX, py: perpY };
        bm.nextPincerAt = mem.t + 6.0 * (sk.cdMul || 1);
      }
      if (bm.pincer && (mem.t > bm.pincer.until || b.owner !== bm.pincer.id || !seeC)) bm.pincer = null;
      if (bm.pincer) {
        const q = bm.pincer; // the lane is latched; the POINT still tracks the carrier's live spot
        tgt = { x: clamp(c.x + q.hx * 150 + q.px * 120, 60, FIELD.W - 60), y: clamp(c.y + q.hy * 150 + q.py * 120, 60, FIELD.H - 60) };
        if (pc) aim = { x: pc.x - p.x, y: pc.y - p.y };
        bm.lastTrick = 'pincer'; bm.seekContact = true;      // closing the trap means closing the gap
        // returns early ON PURPOSE — this is the one behaviour allowed past the MIN_SEP floor
        return finalize(p, tgt, aim, { shoot: false, charge: 0, special: false, build: false }, state, mem, bm, sk, dt);
      }

      // ===== B2 — GOALKEEPER (gate t >= 0.68) =================================================
      // sim.js already HAS a keeper rule and no bot has ever played it deliberately: a defender
      // inside its OWN penalty box CATCHES a weak-or-full kick (test-power.mjs pins both halves
      // of it — a full kick at a defender in its own box is a save, and only an overcharge kick
      // breaks through, KEEPER_BREAK_ROLL 0.45). Bots only shadow and mark. So when the enemy
      // carrier is bearing down on our goal and none of ours is goal-side, the support bot stops
      // chasing and takes the line: it stands ON the carrier's shot line, deep enough inside the
      // box for the save rule to apply, and slides with them.
      // TELL: it stops chasing and stands on its line, sliding side to side — a completely
      // different silhouette of movement from every other bot behaviour.
      // COUNTER: already implemented and symmetric. The bot's own cornerFinish predicts a
      // keeper's slide and shoots the corner it is moving away from; a player does the same, or
      // breaks it with overcharge, or drags it off its line with a pass. Nothing new to learn —
      // it teaches an existing mechanic.
      const keepThreat = Math.abs(c.x - ogX) < FIELD.W * 0.42;                       // a real threat, not midfield
      const mateGoalSide = !!mate && Math.abs(mate.x - ogX) < Math.abs(c.x - ogX) - 60;
      if (skT(sk) >= T_KEEPER && seeC && keepThreat && !mateGoalSide && !wallPlayOn) bm.keepUntil = mem.t + 0.8;
      if ((bm.keepUntil || 0) > mem.t && b.owner === c.id && !wallPlayOn) {
        // Stand where the carrier's shot must pass: intersect (carrier -> goal centre) with the
        // keeper plane, then clamp into the mouth and the box. 0.45 * PENALTY.depth is WELL
        // inside the box, so the sim's catch actually applies rather than being a near miss.
        const lineX = ogX + ogSign * PENALTY.depth * 0.45;
        const f = Math.abs(lineX - ogX) / Math.max(1, Math.abs(c.x - ogX));
        const lineY = clamp(GY + (c.y - GY) * (1 - f), GOAL_TOP + 12, GOAL_BOT - 12);
        tgt = { x: lineX, y: clamp(lineY, PEN_TOP + 30, PEN_BOT - 30) };
        if (pc) aim = { x: pc.x - p.x, y: pc.y - p.y };
        // A keeper is not a statue: if the carrier walks right onto it, it still strips. Kept
        // narrow (0.6 x the plain-cover range) so the behaviour still READS as "holding the
        // line" rather than "chasing", which is the whole point of the tell.
        let kShoot = false;
        if (canShoot && seeC && lane && distC < COVER_STRIP * 0.6) { kShoot = true; }
        bm.lastTrick = 'goalKeep';
        return finalize(p, tgt, aim, { shoot: kShoot, tgtId: kShoot ? c.id : null, charge: 1, special: false, build: false, closeShot: distC < 260 }, state, mem, bm, sk, dt);
      }

      // ===== SUPPORT cover — skilled bots run a BUSH-AMBUSH + WALL-TRAP (lurk->wall->strip) =====
      const other = enemies.find((e) => e.id !== c.id);
      const shadowX = c.x + (ogX - c.x) * 0.58, shadowY = c.y + (GY - c.y) * 0.58;
      const [w2cx, w2cy] = unit(c.x - p.x, c.y - p.y);
      // ambush only in our half AND not when the carrier is already bearing down on goal
      // (then we must cover the goal, not lurk) — prevents leaving the net open on a break.
      const defendHalf = Math.abs(c.x - ogX) < FIELD.W * 0.55 && Math.abs(c.x - ogX) > FIELD.W * 0.28;
      const ambush = (sk.toolSkill > 0.6 && defendHalf) ? chooseAmbushBush(c, ogX, state) : null;
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
        // B3 — DISTANT WALL. The stand spot is UNCHANGED (c + lane*150) at every tier; what the
        // reach buys is WHERE the capsule lands along that same aim: 60px out below the gate
        // (inside the bot's own body, which is every bot wall in the game today) and 180px out
        // at t >= 0.82, i.e. a clear body-length further down the carrier's lane. Same verb,
        // better execution — a player has always been able to drag their wall out this far.
        const reach = wallReach(sk);
        const wallPt = { x: c.x + lux * (150 + reach), y: c.y + luy * (150 + reach) };
        // Windup model: HOLD buildHold for BUILD_WINDUP before the build edge actually
        // commits a wall (a bare build:true edge is now a no-op — see sim.js buildWindup).
        // Only ARM the deadline once — this branch keeps re-selecting itself every tick
        // while the trap is still live, and re-stamping `until` from `mem.t` each time
        // would perpetually push completion out of reach. `dist` DOES refresh each tick: the
        // bot is still walking, and the drag it commits should match where it actually stands.
        // THIS IS THE PLAY THAT MOTIVATED THE LATCH. It arms and sets `bm.trap` on the SAME tick,
        // so from the very next tick the bot is in the `else if (bm.trap)` burst-and-strip branch
        // (measured per-tick tags over one wind-up: blockDrive 10 ticks, ambushStrip 260) — which
        // aims at the CARRIER. The wall therefore committed a median 43px / 38deg off the lane it
        // was supposed to span, max 152px. wx/wy latch the lane point so the capsule goes up
        // ACROSS that lane whatever the strip run does to this bot's aim in the meantime.
        const trapDist = wallPush(p, wallPt.x, wallPt.y, lux, luy, sk);
        aim = { x: lux, y: luy };
        tgt = { x: c.x + lux * 150, y: c.y + luy * 150 };
        if (wallSpotOk(state, p, team, wallPt.x, wallPt.y)) {
          if (!bm.buildHold) bm.buildHold = { x: lux, y: luy, wx: wallPt.x, wy: wallPt.y, dist: trapDist, until: mem.t + BUILD_WINDUP + 0.1 };
          else bm.buildHold.dist = trapDist;
          bm.trap = { until: mem.t + 1.4 }; bm.nextBuildAt = mem.t + 4.0 * (sk.cdMul || 1) * toolGap(sk, 'wall'); bm.lastTrick = ambush ? 'ambushWall' : 'blockDrive';
        }
      } else if (bm.trap) {
        bm.seekContact = true;                              // bursting out of the bush AT the carrier
        // STRIP/STEAL (TACTIC 8): burst out and full-charge strip the wall-blocked carrier;
        // if no bullet is available, plant a bomb-tackle to STEAL instead (the bush hid us — now
        // we strike). Prefer the bullet (never override a live strip with a bomb).
        tgt = { x: c.x, y: c.y };
        if (pc) {
          const [ax, ay] = leadAim(p.x, p.y, pc.x, pc.y, pc.vx, pc.vy, bulletSpeed, sk);
          aim = { x: ax, y: ay };
        }
        if (canShoot && seeC && lane && distC < PRESS_RANGE) { shoot = true; shootTgt = c.id; charge = 1; bm.lastTrick = 'ambushStrip'; if (distC < 260) closeShot = true; }
        else if (!shoot && !bm.charging && bombReady && seeC && distC > BOMB_CENTER_R
                 && (!mate || hyp(mate.x - p.x, mate.y - p.y) > BOMB.radius + radOf(state))
                 && distC < BOMB_CENTER_R + BOMB.radius && mem.t > (bm.nextBombAt || 0)) {
          special = true; aim = { x: c.x - p.x, y: c.y - p.y };
          bm.bombHold = { x: p.x, y: p.y, until: mem.t + BOMB.fuse + 0.1, targetId: c.id, aimX: c.x, aimY: c.y };
          bm.nextBombAt = mem.t + 3.0 * (sk.cdMul || 1) * toolGap(sk, 'bomb'); bm.lastTrick = 'bushSteal';
        }
      } else {
        // plain cover fallback: shadow / mark the 2nd enemy + opportunistic screen-wall or strip
        if (other && botCanSee(p, other, state, sk)) tgt = { x: (other.x + ogX) / 2, y: (other.y + GY) / 2 };
        else { const bush = nearestBushCenter(shadowX, shadowY, 300, state); tgt = bush || { x: shadowX, y: shadowY }; }
        if (pc) aim = { x: pc.x - p.x, y: pc.y - p.y };
        const liningUp = Math.abs(c.y - GY) < GOAL.width / 2 + 240 && Math.abs(c.x - ogX) < FIELD.W * 0.4;
        // TACTIC 1 — DEFENSIVE GOAL-SCREEN: build a VERTICAL wall across our goal mouth, just
        // OUTSIDE the box (so it's a solid hp3 wall, never a fragile in-box one). Aim horizontal
        // => capsule spans vertically across the mouth. Move onto the plane first, then build.
        //
        // WHY IT NEVER FIRED — measured, not guessed (6 matches x 60s x 3 tiers, with every
        // conjunct instrumented). `liningUp` and the old `goalSide` are ANTI-CORRELATED: the
        // first wants the carrier bearing down on our goal, the second wanted THIS bot to be
        // ALREADY between them and the goal — and the support bot is behind the play at exactly
        // that moment. Individually they held on 716/1729, 347/1977 and 180/3112 cover ticks;
        // together, 0 / 0 / 4. And on the 4 the bot was a mean 241px off the build plane against
        // an 85px tolerance, with the preconditions flipping again the next tick, so it never
        // walked there either. Total fires across the whole ladder: zero.
        // Two root-cause fixes, no threshold-lowering:
        //   (a) `goalSide` becomes "there is ROOM to get goal-side". Getting between the carrier
        //       and the goal is the JOB of this play; requiring it up front was circular.
        //   (b) the play LATCHES for 2.4s once chosen, so the bot commits to the walk instead of
        //       re-deciding 60 times a second — the same fault that killed the old walk-to-a-pad
        //       wall-cannon, which the bot lane fixed the same way.
        // B3 also pays off here: at t >= 0.82 the wall can be raised from `wallReach` back, so
        // the bot has ~120px less ground to cover before it can commit.
        const screenRoom = Math.abs(c.x - ogX) > PENALTY.depth + 120; // still time to get in front
        const screenY = screenY0;
        // B3 pays off twice here. The wall still lands on screenPlaneX — OUTSIDE the box, so it
        // is a solid hp3 wall and not a fragile in-box one — but at t >= 0.82 the BUILDER may
        // stand a full 180px back, which at this plane means standing INSIDE its own box while
        // the wall goes up outside it. That is ~120px less ground to cover before it can commit,
        // and it is the difference between a play that reaches its build and one that does not.
        const screenSpot = screenStand;
        const noScreenYet = !state.builtWalls.some((w) => Math.abs((w.cx != null ? w.cx : w.x) - screenPlaneX) < 130 && Math.abs((w.cy != null ? w.cy : w.y) - GY) < GOAL.width / 2 + 50);
        if (bm.screenUntil && (mem.t > bm.screenUntil || !noScreenYet)) bm.screenUntil = 0;
        if (sk.toolSkill > 0.6 && buildReady && liningUp && screenRoom && noScreenYet && mem.t > (bm.nextBuildAt || 0)) bm.screenUntil = mem.t + 2.4;
        if (bm.screenUntil && buildReady) {
          tgt = screenSpot;
          bm.lastTrick = 'goalScreen'; // tagged for the WALK too: this is a committed play now
          if (hyp(p.x - screenSpot.x, p.y - screenSpot.y) < 85 && wallSpotOk(state, p, team, screenPlaneX, screenY)) { // on the plane -> raise the screen
            const dist = wallPush(p, screenPlaneX, screenY, ogSign, 0, sk);
            // The screen plane is already a WORLD point, so latching it is exact: the wall goes up
            // outside the box (solid hp3, never a fragile in-box one) no matter where the walk ends.
            if (!bm.buildHold) bm.buildHold = { x: ogSign, y: 0, wx: screenPlaneX, wy: screenY, dist, until: mem.t + BUILD_WINDUP + 0.1 };
            else bm.buildHold.dist = dist;
            aim = { x: ogSign, y: 0 }; shoot = false; special = false;
            bm.nextBuildAt = mem.t + 8.0 * (sk.cdMul || 1) * toolGap(sk, 'wall'); bm.screenUntil = 0;
          }
        } else if (buildReady && liningUp && iGoalSide && wallWouldPlace(p, w2cx, w2cy) && distC > 140 && mem.t > (bm.nextBuildAt || 0)
                   && wallSpotOk(state, p, team, p.x + w2cx * BUILT_WALL.offset, p.y + w2cy * BUILT_WALL.offset)) {
          // fallback: opportunistic screen wall at our current position (aim toward the carrier).
          // `dist: 0` means "at BUILT_WALL.offset along the aim" — freeze that as a WORLD point at
          // arm time (the same spot wallSpotOk was just checked against) so the wall still lands
          // between us and the carrier if this bot drifts during the wind-up.
          if (!bm.buildHold) bm.buildHold = { x: w2cx, y: w2cy, wx: p.x + w2cx * BUILT_WALL.offset, wy: p.y + w2cy * BUILT_WALL.offset, dist: 0, until: mem.t + BUILD_WINDUP + 0.1 };
          aim = { x: w2cx, y: w2cy }; shoot = false; special = false; bm.nextBuildAt = mem.t + 4.0 * (sk.cdMul || 1) * toolGap(sk, 'wall');
          bm.lastTrick = 'screenWall'; // was UNTAGGED, so every trick histogram reported it as dead
                                       // when it may simply have been invisible. Measure, then judge.
        } else if (canShoot && seeC && lane && distC < COVER_STRIP) { shoot = true; shootTgt = c.id; charge = 1; if (distC < 260) closeShot = true; }
      }
    }

  } else {
    // ===== ASK #3: I CANNOT WIN THE RACE, SO MOVE THE BALL WITH A BULLET =========================
    // "if the enemy is closer to the ball than him then he should shoot the ball to deflect it,
    // preferably in the direction of the goal or its team mate."
    // The mechanic is fully implemented in the sim and was measured NEVER used: a bullet sets a loose
    // ball's velocity to PROJECTILE.ballPush(476) x chargeMul (~214px of roll at full), which is why
    // `bulletBall` shows 10-65 chances a match at 0% taken (SKILL_CATALOGUE T4). The push travels along
    // the BULLET's line, so the useful shot is the one where the line from me through the ball already
    // points somewhere I want it: the enemy goal, or my mate. That is a geometry test, not a solver.
    // Gated on the L5 ramp, on actually LOSING the race (their arrival beats mine by a real margin),
    // and on a clear lane — and it deliberately does not fire when the ball is already rolling fast,
    // because then the roll is doing the work and a bullet would just as likely stop it.
    // FOUR GATES, ALL FROM MEASUREMENT. Ungated (margin 0.22s, no cooldown, any distance) this fired
    // 28.7 times a match and turned pickups into scrambles: shots/match 74 -> 163, touches 22.6 -> 18.5,
    // wall-pinning 0.56% -> 1.05%. It is a PLAY, not a reflex, so: lose the race by a real margin, be
    // far enough away that walking is genuinely not the answer, keep a round in reserve, and re-arm
    // slowly enough that a scramble cannot become a shooting gallery.
    if (!b.owner && p.ammo >= 2 && !bm.charging && !bm.bombHold && !bm.buildHold
        && mem.t > (bm.nextBallPushAt || 0) && levelChance(sk, p, mem, 'ballpush')) {
      const mySpd = speedOf(p, state, false);
      const myDist = hyp(b.x - p.x, b.y - p.y);
      const myArrive = myDist / mySpd;
      let foeArrive = 1e9;
      for (const e of visibleEnemies) foeArrive = Math.min(foeArrive, hyp(b.x - e.x, b.y - e.y) / speedOf(e, state, false));
      const losingRace = foeArrive < myArrive - 0.55 && myDist > 240;       // they clearly win it, and it is not at my feet
      // WHERE it is worth doing. Measured on the ladder: allowing this anywhere made both teams knock
      // the ball back and forth all match — ball advance per carrier release collapsed from 29-41px to
      // 6-12px and the felt difficulty range fell from 48% to 18% of the arena's scoring rate. The
      // research's own valuable case is the DEFENSIVE one ("clear a loose ball away from an enemy in
      // your own box", SKILL_CATALOGUE T4/T5), so that is what ships: our own half, or a genuine pass
      // to a mate. In the attacking half a lost race is better answered by keeping the shape.
      const inOwnHalf = Math.abs(b.x - ogX) < FIELD.W * 0.55;
      const ballSlow = hyp(b.vx || 0, b.vy || 0) < 240;
      if (losingRace && ballSlow) {
        const [dx, dy] = unit(b.x - p.x, b.y - p.y);                       // the direction a hit would send it
        const dGoal = unit(egX - b.x, GY - b.y);
        const towardGoal = dx * dGoal[0] + dy * dGoal[1];
        const mateDir = mate ? unit(mate.x - b.x, mate.y - b.y) : null;
        const towardMate = mateDir ? dx * mateDir[0] + dy * mateDir[1] : -1;
        // 0.62 ~ 52deg of tolerance: the ball only has to end up meaningfully goalward (or at the mate),
        // not perfectly. Also never nudge it INTO our own half's danger zone: goalward wins ties.
        // 0.75 (~41deg) rather than 0.62 (~52deg): a marginal nudge just hands the ball over in
        // midfield, which is where the ladder damage came from. Mate passes need a real gap too.
        const useful = (inOwnHalf && towardGoal > 0.70) || (towardMate > 0.85 && hyp(mate.x - b.x, mate.y - b.y) > 200);
        const clearLane = laneClear(p.x, p.y, b.x, b.y, state, team, { enemies: false });
        if (useful && clearLane) {
          bm.nextBallPushAt = mem.t + 3.4 * (sk.cdMul || 1);
          bm.lastTrick = 'ballPush';
          return finalize(p, tgt, { x: b.x - p.x, y: b.y - p.y },
            { shoot: true, charge: 1, special: false, build: false, closeShot: hyp(b.x - p.x, b.y - p.y) < 260 },
            state, mem, bm, sk, dt);
        }
      }
    }

    // ===== LOOSE BALL =====
    if (isOnBall) {
      const [bx, by] = predictBall(b, clamp(len(b.x - p.x, b.y - p.y) / 900, 0.05, 0.5));
      tgt = { x: bx, y: by };
      aim = { x: egX - p.x, y: GY - p.y };
      // FULL-FORCE CHASE (2026-07-26, the user's ask #1: "one bot always goes after the ball, full
      // force, if it is not in enemy hands"). Being the designated chaser now OUTRANKS shape, and
      // the two things that used to quietly stop it are dropped here:
      //   * `bm.trap` — armed by blockDrive against a CARRIER. Once the ball is loose that premise
      //     is dead, but the flag lived on and it is in FETCH_EXEMPT, so it silently vetoed the
      //     fetch fallback for the rest of its life.
      //   * a stale detour commitment, which could hold a bot on a bearing chosen for a target it
      //     is no longer walking to.
      // NOT dropped: bm.bombHold / bm.buildHold / bm.cata / bm.fly. Those are paid-for commitments
      // and aborting them is on the refuted list — assignRoles' reach penalty hands the chase to the
      // other bot instead, which is the same outcome without throwing a charge away.
      // GRADED EXECUTION, not a gate: every tier chases, but a weak bot takes `chaseReact` seconds to
      // register the ball coming loose (0.33s at t=0.05, 0.02s at L10). A reaction time is the axis
      // Brawl Stars and Fortnite actually ship; a coin flip (mistakeP/decisionHz) is refuted 8x here.
      if (bm.looseSince == null) bm.looseSince = mem.t;
      if (mem.t - bm.looseSince >= (sk.chaseReact || 0)) {
        if (bm.trap) bm.trap = null;
        if (bm.detourUntil && bm.detourUntil < mem.t + 0.01) bm.detourUntil = 0;
        if (!bm.lastTrick) bm.lastTrick = 'chaseCommit';
      }
      // LEFT BEHIND ON A LOOSE BALL — the case the two old jumps could not cover, because both
      // lived in the "my team-mate is carrying" branch. mobilityJump refuses when an enemy is
      // within 420px of the ball (they would simply arrive first while we stood on a fuse), so
      // this only fires on a genuinely uncontested long chase.
      {
        const j = mobilityJump(p, bm, mem, state, sk, tgt, visibleEnemies, bombReady, 'chaseJump');
        if (j) return finalize(p, { x: p.x, y: p.y }, j, { shoot: false, charge: 0, special: true, build: false }, state, mem, bm, sk, dt);
      }
    } else {
      // hold a supporting spot between the ball and our goal (slightly toward a bush for ambush).
      // PERSONA `guardGoal` sets HOW deep: a Fortress sits most of the way home and covers the lane,
      // an Enforcer holds much closer to the ball and looks for a body to hit.
      const gg = (sk.pp && sk.pp.guardGoal != null) ? sk.pp.guardGoal : 0.5;
      const homeW = clamp(0.30 + 0.45 * gg, 0.30, 0.75);   // 0.44 enforcer .. 0.75 fortress
      const holdX = b.x + (ogX - b.x) * homeW, holdY = b.y + (GY - b.y) * homeW;
      tgt = { x: holdX, y: holdY };
      aim = { x: b.x - p.x, y: b.y - p.y };
    }
  }

  // SEPARATION: the off-ball bot never crowds the play — keep >= MIN_SEP from the
  // focus (carrier/ball), preserving its bearing (ahead when attacking, back when
  // defending). This is what actually kills the "both bots chase the ball".
  if (!isOnBall) {
    if (carrier) {
      // NOBODY IS PRESSING -> THIS BOT PRESSES (the user's ask #2, the "at least one" half).
      // MIN_SEP exists so both bots don't crowd one carrier, and it is right almost always. But it
      // also held the support at 320px while the on-ball bot was rooted on a bomb fuse or simply too
      // far to strip — so an enemy could carry unopposed with two defenders "in shape". The waiver is
      // conditional on the ENEMY holding the ball and nobody of ours being in strip range of them, so
      // it cannot become "both bots chase". `pincer` already does this at t >= 0.92; this is the same
      // mechanism made available to every tier, which is what "always" requires.
      const enemyHolds = carrier.team !== team;
      let pressed = false;
      if (enemyHolds) {
        for (const q of Object.values(state.players)) {
          if (q.team !== team || q.id === p.id) continue;
          const qbm = (mem.bots && mem.bots[q.id]) || {};
          const rooted = !!(qbm.bombHold || qbm.buildHold || qbm.cata || qbm.fly);
          if (!rooted && hyp(q.x - carrier.x, q.y - carrier.y) < PRESS_RANGE) pressed = true;
        }
      }
      if (enemyHolds && !pressed) {
        tgt = interceptPoint(p, carrier, state, sk);
        if (!bm.lastTrick) bm.lastTrick = 'secondPress';
      } else if (enemyHolds && false) {
        // MEASURED AND REMOVED — a "Fortress drops onto the carrier-to-goal lane" shape. It read well
        // and it was the worst regression of the round: wall-pinned-while-moving 0.55% -> 1.52%,
        // WORST JAM 0.85s -> 6.55s, carrier-idle 1.0% -> 3.9% (n=24, two seed bases). The spot is
        // computed from carrier+goal geometry and is never validated against the arena, so on a
        // crate-heavy map it lands inside stone and the bot grinds at it — the fifth instance of this
        // repo's "walking to a computed spot" failure (LOGIC-HANDOFF §5). A Fortress gets its depth
        // from the LOOSE-BALL hold spot instead, which measures clean.
        // Kept as dead code with the numbers attached so it is not re-proposed from scratch.
      } else {
        // CARRIED ball: keep real spacing so we don't both crowd the carrier. PERSONA `escort` sets
        // how close: a Bodyguard stations itself at ~220px (the doc's 100-220px escort band) where a
        // Fortress or Ball Hawk holds the full 320px and stays available instead of protective.
        const esc = (sk.pp && sk.pp.escort != null) ? sk.pp.escort : 0.5;
        const dx = tgt.x - carrier.x, dy = tgt.y - carrier.y, d = hyp(dx, dy);
        const MIN_SEP = carrier.team === team ? clamp(340 - 130 * esc, 200, 340) : 320;
        if (d < MIN_SEP) { const [ux, uy] = unit(dx || (ogX - carrier.x), dy || (GY - carrier.y)); tgt = { x: carrier.x + ux * MIN_SEP, y: carrier.y + uy * MIN_SEP }; }
      }
    } else {
      // LOOSE ball. PRESENCE: the off-ball bot should mostly CONTEST, not hide (it used to lurk
      // in a bush 2:1 over contesting — the main reason hard "felt absent"). Contest radius scales
      // with aggro (easy ~600, hard ~640 — a MODERATE widen; going wider pulled bots out of
      // shape and spiked fog-roam); lurk only when the ball is genuinely far and not breaking home.
      const [bx, by] = predictBall(b, clamp(hyp(b.x - p.x, b.y - p.y) / 900, 0.05, 0.4));
      const myD = hyp(bx - p.x, by - p.y);
      const fastBreak = hyp(b.vx, b.vy) > 260 && (ogX - b.x) * b.vx > 0 && Math.abs(b.x - ogX) < FIELD.W * 0.5;
      if (fastBreak) tgt = { x: (b.x + ogX * 1.2) / 2.2, y: (b.y + GY) / 2 };  // stay home on a break
      else if (myD < 360 + 340 * AGG) tgt = { x: bx, y: by };                  // CONTEST the 50/50 (monotone in aggro; the old `sk.cheat ||` made the top contest EVERYTHING)
      else { const bush = nearestBushCenter(tgt.x, tgt.y, 520, state); if (bush) tgt = bush; } // lurk/ambush when genuinely far
    }
  }

  // COVER LANE (3v3+ only — at 2v2 there is no cover bot, so this whole block is dead there).
  // The onBall bot chases and the support bot works the outlet; every FURTHER bot would otherwise
  // run the identical support tactics and stack on the same spot. Instead each holds a distinct
  // vertical lane, goal-side of the ball, tracking play without joining the scrum. It still
  // contests anything that comes into its own zone — a cover bot that ignored a loose ball at its
  // feet would read as broken, which is worse than crowding.
  const laneIdx = role.lane ? role.lane[p.id] : undefined;
  if (laneIdx != null && !isOnBall) {
    const near = hyp(b.x - p.x, b.y - p.y) < 340; // ball is at my feet — keep whatever I already decided
    if (!near) {
      const lanes = Math.max(1, role.lanes | 0);
      const laneY = FIELD.H * ((laneIdx + 1) / (lanes + 1));
      // Blend the lane toward the ball's height so cover shifts across with play, and sit goal-side.
      tgt = { x: (b.x + ogX * 1.5) / 2.5, y: laneY * 0.58 + b.y * 0.42 };
      aim = { x: b.x - p.x, y: b.y - p.y };
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

  // ===== "IF YOU ARE NEAREST THE BALL, GO AND GET IT" (requested) ==============================
  // MEASURED BEFORE THIS EXISTED: on 23% of ticks (26% at skill 0.93) where a bot was the CLOSEST
  // player to a LOOSE ball and wanted to move, it was walking AWAY from it. That is the most
  // "what is he doing?" thing a spectator can see, and no single branch owned it: the off-ball
  // lurk/hold spot, the cover lane and the outlet spots are all chosen for SHAPE, and any of them
  // can point backwards while the ball sits at the bot's feet.
  // Deliberately narrow, and it honours the user's own exemption ("unless doing a trick, hiding in
  // bushes or something"): only a LOOSE ball, only the player actually nearest to it, and only when
  // nothing sanctioned is in progress — a bomb fuse, a wall wind-up, a catapult, a kick-and-fly, a
  // bush ambush/trap, a called pass, an active bullet dodge, or a committed wall play.
  if (!b.owner && !bm.bombHold && !bm.buildHold && !bm.cata && !bm.fly && !bm.trap
      && !(bm.dodgeUntil && mem.t < bm.dodgeUntil) && !FETCH_EXEMPT.has(bm.lastTrick)) {
    let nearest = null, nd = 1e9;
    for (const q of Object.values(state.players)) { const d = hyp(q.x - b.x, q.y - b.y); if (d < nd) { nd = d; nearest = q; } }
    // ...and a WEAK bot only notices at close range. Same reason as the clearance above: an
    // unconditional "always go and get it" is skill-independent and helped the bottom tier most.
    // 345px of attention at t=0.05, the whole pitch by the top of the ladder.
    // EXCEPT for the team's DESIGNATED CHASER, whose whole job this is: it notices at any range,
    // because "one bot always goes after the ball" has to be true on the far side of the pitch too.
    // The graded axis moved to `chaseReact` (how fast it reacts) rather than a blind spot, and the
    // radius still applies to the OTHER bot, so a weak team still does not double-chase perfectly.
    // MEASURED: shrinking the chaser's radius to 700 + 1500*skT to "grade" this made the ladder
    // WORSE, not better (goals rho stayed 0.70 and the felt spread FELL from 0.50 to 0.34), because it
    // took more away from the t=0.50 REFERENCE tier than from the bottom. The bottom tier's advantage
    // was never the radius — it was the persona policy being skill-independent, which is fixed in
    // withPersona instead. So the chaser notices the ball anywhere, exactly as the user asked.
    const noticeR = role.chaser === p.id ? Infinity : 300 + 900 * skT(sk);
    if (nearest && nearest.id === p.id && nd < noticeR) {
      const [bx2, by2] = predictBall(b, clamp(nd / 900, 0.05, 0.4));
      const [tx, ty] = unit(tgt.x - p.x, tgt.y - p.y);
      const [gx2, gy2] = unit(bx2 - p.x, by2 - p.y);
      if (tx * gx2 + ty * gy2 < 0.25) {            // the chosen target points away from the ball
        tgt = { x: bx2, y: by2 };
        if (!bm.lastTrick) bm.lastTrick = 'fetchBall';
      }
    }
  }

  return finalize(p, tgt, aim, { shoot, tgtId: shootTgt, charge, special, build, closeShot, forceRelease }, state, mem, bm, sk, dt);
}

// ---- F2 FIX: how long may a wind-up run before we give up on it? ----
// This used to be a FLAT 2.2s. The sim's ramp is
//   d(charge)/dt = chargeRate * cardShot * (power ? SUPER_CHARGE_RATE : 1) / SHOOT_CHARGE_TIME,
// so reaching FULL_CHARGE (0.70) takes 1.42/chargeRate seconds — which at the BOTTOM of the ladder
// (chargeRate ~0.67) is 2.12s, i.e. ~80ms inside the old 2.2s deadline. Any aim disturbance in those
// last 5 ticks cancelled the shot, sim.js reset _charge to 0, the branch re-armed, and the bot stood
// there holding the ball FOREVER without ever releasing. That is the "stands in front of the goal"
// bug. The budget is now derived from the bot's OWN ramp (including its cards + super, and whatever
// charge it has already banked), so it is impossible for a tier to be given less time than the shot
// physically needs. Budgets: t=0.05 -> 3.53s, easy 2.58s, normal 2.06s, hard 1.39s, top ~0.80s.
function windupBudget(p, fireAt) {
  const rate = Math.max(0.05, (p.chargeRate || 1) * (p.cardShot || 1) * (p.power ? SUPER_CHARGE_RATE : 1) / SHOOT_CHARGE_TIME);
  const needed = Math.max(0, fireAt - (p._charge || 0)) / rate;
  return Math.max(0.8, needed * 1.5 + 0.35); // 50% headroom for aim convergence + a couple of decision ticks
}

// Apply steering + skill (reaction latency + smoothed noisy aim), emit the input.
function finalize(p, tgt, aimVec, btn, state, mem, bm, sk, dt, opts = {}) {
  // ---- AUTOPSY: THERE IS NO WORKING "MAKE THE BOTTOM DUMBER" LEVER. STOP LOOKING. -----------
  // decisionHz has been REMOVED from the tier tables and SKILL_KEYS (it sat there for months,
  // interpolated by skillVec, read by nothing). Two councils tried to revive it. SEVEN distinct
  // implementations were built and MEASURED with test-bot-ladder.mjs; every one was neutral or worse:
  //   * plan cache (tgt + aim as a world point)   -> ladder rho +0.70 => +0.20, shots/match -56%
  //   * ditto, replaying unit aims verbatim       -> rho +0.20, still ~-40% shots
  //   * movement-target cache only                -> rho -0.50 (the HIGH tiers hurt MOST)
  //   * output cache / aim-stale / uniform-Hz     -> best safe config indistinguishable from none
  //   * mistakeP (the Brawl Stars handicap: hold a stale plan and make it cost something) was built
  //     line-for-line by an adversarial challenger and FAILED BY THE SAME NUMBER it was written to
  //     fix — within +-0.03 goals/match of an ungated reference.
  // ROOT CAUSE, structural rather than a tuning problem: the tactical body is not a pure function of
  // a cached plan. carryT / blindT / the progress ratchet are INTEGRATORS that must advance EVERY
  // tick (inside a 4Hz gate carryT advances 1dt per 15 ticks, so the anti-idle release never fires
  // at all), and EIGHT branches early-return straight into finalize() with a hand-built aim. Staling
  // any of it removes reactivity, and reactivity is exactly where the HIGH tiers' advantage lives —
  // which is why every variant compressed the ladder from the top.
  // The bottom tier is already clearly weakest (-0.41 vs +0.23 goals/match, strips 0.76 vs 5.84).
  // It is not CHARACTERFULLY dumb, and that is still unsolved — but not by rate-limiting decisions.
  // If you try an eighth version, measure it with SEEDS=6 first.
  // INVARIANT, enforced at the funnel: a ball-CARRIER can never plant (sim.js:840 gates the bomb on
  // !carrying), so a carrier sitting on a bomb-hold is the deleted carryJump bug in another costume
  // — it froze the carrier for a 1.725s fuse waiting for a bomb that never spawned (~50s/match at
  // the top tiers). decideBot clears it at the top of the next tick; this closes the arming tick
  // too, so no new play can reintroduce it by accident. test-bot-tricks-fire gates on exactly this.
  if (state.ball.owner === p.id && bm.bombHold) { bm.bombHold = null; btn = { ...btn, special: false }; }
  // ---- WALL WIND-UP: LATCH THE WALL TO A WORLD POINT, NOT TO STANDING STILL -------------------
  // MEASURED before this existed (L10 = partner 0.42 / enemy 0.93, 8 matches x 60s, MAIN_FIELD):
  // 2.4 wind-ups/match, and the wall landed a median 43px — max 152px — and 38deg away from what
  // the arming branch asked for on the dominant play (`blockDrive`). Cause: `bm.buildHold` only
  // ever carried a `dist`; the AIM on the commit tick was whatever branch happened to run THEN,
  // and after the arming tick that is a DIFFERENT branch — `blockDrive` arms, sets `bm.trap`, and
  // from the next tick the bot is `ambushStrip` bursting at the carrier (per-tick tags measured:
  // blockDrive 10 ticks vs ambushStrip 260). So the branches that pinned themselves to their own
  // feet "so the wall doesn't move" were paying BUILD_WINDUP_SLOW for nothing: the wall moved.
  // Latching the target POINT plus the wall's normal makes placement independent of where the bot
  // walks — `wallPush` re-derives the drag from the LIVE position every tick, exactly as the
  // client's drag ghost does. Three things follow, in order of how much they matter:
  //   1. the wall lands where the play asked (placement error -> ~0, orientation exact);
  //   2. no branch needs to target its own feet, so the bot keeps PLAYING through the wind-up,
  //      inside the box where the wall still lands right (steering target clamped in the ray frame);
  // MEASURED OUTCOME (L10, 24 matches x 60s, MAIN_FIELD) — the wall's job is to SPAN the carrier's
  // lane, so the angle is what matters: walls raised against an enemy carrier used to miss
  // perpendicular-to-the-lane by a median 22deg (p90 63deg) and only 64% were within 30deg of
  // spanning it; now it is a median 4deg (p90 5deg) and 100%. Wall builds went UP, 2.2 -> 3.9/match,
  // so this is not "idle removed by never building".
  // NB below T_FAR_WALL `wallReach` == BUILT_WALL.offset, so those tiers get the orientation fix
  // only and move exactly as before; the far-wall tiers (t >= 0.82, which is L10's enemy) get both.
  // SAME INVARIANT AS bombHold, one line above, and for the same reason: a ball CARRIER can never
  // build (sim.js gates buildWall on `!carrying`), so a wind-up that survives a pickup is dead
  // state — and with the aim latch below it is worse than dead, because it would point a CARRIER
  // along a stale wall normal, which is the ball's glue direction AND its kick direction. MEASURED
  // before this line existed: idle-with-ball 1.12 -> 1.77% at skill 0.50 and 0.78 -> 1.05% at 0.93.
  if (state.ball.owner === p.id && bm.buildHold) bm.buildHold = null;
  let bhDist = null, bhAim = null;
  if (bm.buildHold && bm.buildHold.wx != null && !opts.hold) {
    const h = bm.buildHold;
    const reach = wallReach(sk);
    bhDist = wallPush(p, h.wx, h.wy, h.x, h.y, sk);
    bhAim = { x: h.x, y: h.y };
    // LEASH, not a freeze and not an abort. Re-express the branch's OWN target in the ray frame,
    // clamp the two components into the window where the wall still lands on (wx,wy), and steer at
    // that. The bot keeps walking the way it wanted to (at BUILD_WINDUP_SLOW — the same half speed
    // a human pays for a wind-up, sim.js:715) and it is pulled back onto the ray if it strays,
    // instead of being pinned to its own feet. perp = (-h.y, h.x); q = W - along*n - lat*perp.
    // MEASURED AND REJECTED — do not re-propose either of these without new evidence:
    //   * CANCELLING the wind-up once the bot leaves the window (task idea 3) — every `ambushWall`
    //     hold aborted (0.88 arms/match, 0.88 aborts, 0 commits) and wall builds fell
    //     1.75 -> 0.38/match at L10. The play strips the ball it was walling against, our team then
    //     owns it, and `wallSpotOk`'s own-lane test flips: the trigger destroys its own precondition,
    //     the same shape as `doubleBomb` in §4.
    //   * GATING the arm on already standing in the window (task idea 1, `onBuildRay`) — `blockDrive`
    //     went 1.25 -> 0.13 arms/match, because its stand spot is recomputed from the carrier's LIVE
    //     position every tick, so the bot chases a target that moves (§0000's walk-to-a-pad autopsy,
    //     third time in this file). A leash is what works here: no gate to miss, nothing to cancel.
    // ...and ONLY for tiers whose wall has push distance to give. Below T_FAR_WALL `wallReach` IS
    // `BUILT_WALL.offset`, so the along-window collapses to a single distance and the leash becomes
    // a 60px arc — a freeze in all but name. MEASURED with the leash applied to every tier
    // (3 seed bases x 12 matches x 60s): at skill 0.50 worst jam 0.97 -> 1.61s, pinned 0.37 ->
    // 0.49%, idle-with-ball 1.12 -> 1.51%, while skill 0.93 (which HAS the 120px window) came out
    // neutral-to-better — worst jam 0.68 -> 0.59s, reach-timeouts 4.00 -> 3.61/match. So the leash
    // is gated on the freedom existing. Below the gate the movement is byte-identical to before and
    // only the wall's ORIENTATION is fixed, which is the part that was actually broken.
    if (reach > BUILT_WALL.offset) {
      const ta = clamp((h.wx - tgt.x) * h.x + (h.wy - tgt.y) * h.y, BUILT_WALL.offset, reach);
      const tl = clamp((h.wx - tgt.x) * -h.y + (h.wy - tgt.y) * h.x, -BUILD_LAT_TOL, BUILD_LAT_TOL);
      tgt = { x: h.wx - h.x * ta + h.y * tl, y: h.wy - h.y * ta - h.x * tl };
    }
  }
  bm.wantMove = opts.hold ? 0 : 1;
  let mvx = 0, mvy = 0;
  if (opts.hold) { bm.mvx = 0; bm.mvy = 0; bm.lastX = p.x; bm.lastY = p.y; bm.stuck = 0; } // stand ON the bomb plant
  else {
    // ---- FLOW-FIELD ENGAGE ----------------------------------------------------------------
    // Only swap the steering target for a flow waypoint when the field says the direct line is
    // genuinely a DETOUR (path length vs straight line), or when the stall detectors have fired.
    // In open play the direct line IS the path, so this is inert and bots keep their old feel.
    // `detourRatio` is the ladder knob: a dumb bot needs the path to be 2.6x longer before it
    // believes it must go round (so it bonks into walls, which reads as dumb but not broken);
    // the top tier acts on a 6% detour and routes cleanly.
    let navTgt = tgt;
    const straight = hyp(tgt.x - p.x, tgt.y - p.y);
    if (straight > 120 && !bm.bombHold && !bm.buildHold) {
      const fld = navField(mem, state, tgt.x, tgt.y);
      const nav = mem.nav;
      const cell = nav ? navNearestFree(nav.occ, navCellAt(p.x, p.y)) : -1;
      const pc = (fld && cell >= 0) ? fld[cell] : NAV_INF;
      bm.navPathPx = pc < NAV_INF ? pc * (NAV_CELL / 10) : -1;
      const forced = (bm.pressTicks || 0) >= 12 || mem.t < (bm.detourUntil || 0);
      const ratio = sk.detourRatio != null ? sk.detourRatio : 1.2;
      if (pc < NAV_INF && (forced || bm.navPathPx > straight * ratio + 26)) {
        const lag = sk.navLag != null ? sk.navLag : 0.12;
        if (!bm.wp || mem.t - (bm.wpAt || -9) >= lag) {
          bm.wp = navWaypoint(fld, nav.occ, p.x, p.y, Math.round(sk.flowAhead != null ? sk.flowAhead : 3));
          bm.wpAt = mem.t;
        }
        if (bm.wp) navTgt = bm.wp;
      } else bm.wp = null;
    }
    // NO-PROGRESS RATCHET, measured against the FINAL target — remaining PATH length when the
    // field knows it, else the straight line. Remember the best ever achieved and complain only
    // if it stops improving for 0.6s: a per-tick displacement test (the old `moved < 2.0`) is
    // blind to an oscillation, because a bot circling at full speed moves 2.37px every tick.
    const progress = bm.navPathPx > 0 ? bm.navPathPx : straight;
    if (!bm.pg || hyp(tgt.x - bm.pg.tx, tgt.y - bm.pg.ty) > 200) bm.pg = { best: progress, bestAt: mem.t, tx: tgt.x, ty: tgt.y };
    bm.pg.tx = tgt.x; bm.pg.ty = tgt.y;
    if (progress < bm.pg.best - 8) { bm.pg.best = progress; bm.pg.bestAt = mem.t; }
    bm.stalledFlag = straight > 46 && (mem.t - bm.pg.bestAt) > 0.6;
    // "MOVING WITH NO PURPOSE" (ask #4's second half) as a DURATION, not a flag. bm.stuck only counts
    // a hard wedge (<0.6px/tick) and the ray-sampled detour made those rare — worst 24-match jam ~1.0s
    // — so the bomb escape could never see the case the user actually described: a bot that IS moving
    // and is getting nowhere (circling a capsule, oscillating between two waypoints). The ratchet
    // already detects it; this integrates it so a threshold can be set against it.
    bm.noProgressT = bm.stalledFlag ? (bm.noProgressT || 0) + dt : 0;
    const s = steer(p, navTgt.x, navTgt.y, state, bm, sk, mem.t); mvx = s[0]; mvy = s[1];
  }

  // ---- BULLET WIND-UP TARGET LATCH — "the enemy shoots the other way" ----------------------
  // MEASURED FIRST (`bot-aim.mjs`, MAIN_FIELD, 16 matches x 60s, the reported level-10 pair
  // partner 0.42 vs enemy 0.93, three seed bases): 6.3 / 8.7 / 9.2 % of every BULLET fired left
  // the barrel more than 45deg off EVERY enemy on the pitch. All of them were ONE fault:
  //   * 14/16, 17/17 and 22/23 had a DIFFERENT ball owner at FIRE time than at ARM time;
  //   * every single one fired on a tick when NO enemy carried the ball (loose 14-21, our own team
  //     2, enemy-held ZERO) — and all five bullet branches in this file live under "an enemy
  //     carries" (press strip / cover strip / keeper strip / ambush strip), the sixth being
  //     `clearMarker` under "my MATE carries", so on those ticks NO branch could have asked for a
  //     shot at all;
  //   * outcome: 0 of them hit a player, 87% hit a wall.
  // `bm.charging` outlives the branch that opened it, the branch is not re-selected, `shoot` goes
  // false — and the aim is then re-derived by whatever branch DOES run. The loose-ball branch aims
  // at the ENEMY GOAL, so a full-charge strip bullet gets fired down the pitch. That is exactly the
  // pass-latch bug of §5.2 in the other weapon: the bullet was the other committed action that did
  // not latch its target.
  // FIX: while a bullet wind-up is live and no branch re-asked for it this tick, the aim keeps
  // tracking the enemy it was ARMED at — lead-aimed while visible, dead-reckoned off `bm.seen`
  // while not — and the wind-up is CANCELLED when that target is gone. It is a LATCH, NOT a wider
  // tolerance: `fire` still needs the aim inside `tol`, so the shot is not released until it has
  // converged on the latched target. §000's failure mode is untouched — nothing here re-arms
  // `bm.reactUntil` (that still requires `!bm.charging`) and nothing tightens `tol`, so a close
  // juking target cannot be pushed back into "never shoots".
  // perceivedPos()'s anti-omniscience GHOST is deliberately preserved: firing at a last-seen spot
  // is correct behaviour, so the memory branch below dead-reckons it exactly the way perceivedPos
  // does instead of cancelling. (The audit found 0 ghost bullets in 255 anyway — every wide bullet
  // was the stale wind-up, not the fog.)
  let latchDead = false;
  {
    const bc = bm.charging;
    if (bc && !bc.ball && bc.tgtId && !btn.shoot) {
      const q = state.players[bc.tgtId];
      if (!q || q.team === p.team) latchDead = true;         // left the match / somehow ours
      else if (botCanSee(p, q, state, sk)) {
        const [lx, ly] = leadAim(p.x, p.y, q.x, q.y, q.vx || 0, q.vy || 0, state.settings.bulletSpeed || 720, sk);
        aimVec = { x: lx, y: ly };
      } else {
        const sn = bm.seen, memS = (sk && sk.memoryS) || LOST_SIGHT_MEMORY;
        if (sn && sn.id === bc.tgtId && mem.t - sn.t <= memS) {
          const adv = clamp(mem.t - sn.t, 0, memS);          // same dead-reckoning as perceivedPos
          aimVec = { x: sn.x + sn.vx * adv - p.x, y: sn.y + sn.vy * adv - p.y };
        } else latchDead = true;                             // no sight and no memory -> can't land
      }
    }
  }

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
  if (sk.cheatFlub) {
    const slip = seededNoise(Math.floor(mem.t * 1.7) + idHash(p.id) * 0.013); // ~uniform [-1,1], changes a few times/sec
    // MAGNITUDE ramps with the tier as well as the rate: a flat 0.16rad (~9deg) slip is nothing at
    // close range, so it could never be the thing that keeps a boss beatable.
    const mag = sk.flubMag != null ? sk.flubMag : 0.16;
    if (slip > 1 - sk.cheatFlub * 2) noise += mag * seededNoise(mem.t * 5.1 + idHash(p.id) * 0.023);
  }
  const th = bm.aimTheta + noise;
  let ax = Math.cos(th), ay = Math.sin(th);

  // ---- CARRY-AIM DEFLECTION: stop kicking our own ball off a wall -------------------------
  // sim.js:919-925 pops the held ball LOOSE the instant its GLUE SPOT — feet + aim x (radius +
  // ballR) — intersects any wall, static or built ("walks it into a solid edge"), with a
  // RELEASE_PICKUP_CD lockout so the carrier cannot even pick it back up. Nothing in this file
  // knew that rule, and a carrier aims AT THE ENEMY GOAL while it dribbles, so on the arena the
  // game actually ships the ball is ripped off it by the geometry, not by an opponent.
  // MEASURED, MAIN_FIELD, 6 matches x 60s, skill 0.50: 28.3 wall-pops per match (the bare default
  // arena: 1.2 — a 24x difference, which is why no test ever saw this either). MEDIAN POSSESSION
  // WAS ONE TICK (0.02s) and only 18% of possessions ended in a kick; the rest were the carrier
  // losing the ball to a wall it was facing. That is the "they don't go for the ball" report: the
  // ball is loose 75% of the match, so every bot is permanently in the loose-ball branch.
  // With this: pops 28.3 -> 3.2, median possession 0.02s -> 0.87s, 60% of possessions now end in
  // a KICK, shots/match 27.7 -> 39.8, goals/match 0.33 -> 1.50.
  // It rotates only the EMITTED aim, never bm.aimTheta, so the slew keeps converging on the real
  // target — and it is DROPPED on the fire tick below, so the shot itself is untouched. Fairness:
  // a human dribbling round a wall does exactly this with their thumb.
  if (state.ball.owner === p.id) {
    const ballR = BALL_RADIUS * (state.settings.ballSizeMul || 1);
    const off = radOf(state) + ballR;
    const gr = ballR * 0.6;                       // the sim's own probe radius at sim.js:919
    const walls = arenaOf(state).walls.concat(state.builtWalls || []);
    const glueClear = (cx, cy) => {
      for (const w of walls) { const np = nearestOnWall(w, cx, cy); if (hyp(cx - np.x, cy - np.y) - (np.rad || 0) < gr) return false; }
      return true;
    };
    if (!glueClear(p.x + ax * off, p.y + ay * off)) {
      // nearest clear direction, alternating sides so the ball is nudged the short way round
      for (const d of [0.35, -0.35, 0.7, -0.7, 1.05, -1.05, 1.4, -1.4, 1.75, -1.75, 2.1, -2.1, 2.6, -2.6, Math.PI]) {
        const t2 = th + d, cx = Math.cos(t2), cy = Math.sin(t2);
        if (glueClear(p.x + cx * off, p.y + cy * off)) { ax = cx; ay = cy; break; }
      }
    }
  }

  let { shoot, charge, special, build, closeShot, forceRelease } = btn;
  if (opts.hold) bm.charging = null; // standing on a bomb plant — never charge a shot
  const isBallRelease = state.ball.owner === p.id;

  // Bomb lob offset: useSpecial() throws the bomb along the (sax,say) VECTOR, distance =
  // min(hypot(sax,say),1) × BOMB_LOB_RANGE. bm.bombHold.x/y IS the intended plant anchor, so the
  // offset is simply (anchor - feet): zero for a feet plant (tackle-steal, double-bomb join), and a
  // real backwards lob for the wall-cannon.
  // FIXED: this used to take the DISTANCE from the anchor but the DIRECTION from `aimVec`, so any
  // branch that asked for a lob would have thrown the bomb along its AIM instead of at the anchor —
  // i.e. the wall-cannon would have lobbed FORWARD, away from the wall it was trying to use. It was
  // latent only because every branch then set the anchor to the bomber's own feet (distance 0).
  // `btn.lob` is the SAME payload without the stand-on-it commitment: a pure throw, used by the
  // two-bomb join, which wants the bomb over there and the bot right here.
  const lobAt = bm.bombHold || (btn.lob || null);
  let sax = 0, say = 0;
  if (special && lobAt) {
    const ox = lobAt.x - p.x, oy = lobAt.y - p.y;
    const dist = hyp(ox, oy);
    if (dist > 1) {
      const frac = Math.min(1, dist / BOMB_LOB_RANGE);
      const [ux, uy] = unit(ox, oy);
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
  // BULLET CADENCE. Ask #1 ("always try to have a full power shot") banks the charge, and the side
  // effect measured on the ladder was a shooting gallery: bullets/match 74 -> 232 at the top tiers,
  // ball advance per release 29-41px -> 7-11px, felt ladder spread 48% -> 18%. A wound-up bot used to
  // LOSE most gates before the charge arrived; now it takes them all. The ask is about being READY,
  // not about firing more often, so a bot may not open a new BULLET wind-up more than ~1.4/s. Ball
  // RELEASES are exempt — a kick is the carrier's whole move, and the release ladder already gates it.
  const bulletCadenceOk = isBallRelease || mem.t > (bm.nextBulletAt || 0);
  if (shoot && !bm.charging && !bulletCadenceOk) shoot = false;
  if (shoot && !bm.charging) {
    if (!isBallRelease) bm.nextBulletAt = mem.t + 0.70;
    if (isBallRelease || p.ammo > 0) { // don't start a BULLET wind-up we can't finish
      // A KICK's power IS its reach, so a ball release must fire at the charge it ASKED for.
      // This used to clamp every request to FULL_CHARGE + 0.01 = 0.71 "to cut the vulnerable
      // wind-up", which capped every bot kick at 1095px/s => a 504px roll, while FINISH_RANGE let
      // bots shoot from up to 835px. Those shots died ~300px short and simply handed over
      // possession — and since the range scales with aggro, the MORE aggressive (higher) tiers
      // wasted more, which is why the measured ladder came out INVERTED.
      // A BULLET is different: FULL_CHARGE is the strip threshold, so more is pointless there.
      // A BULLET's ceiling is now the PERSONA's maxCharge, not a flat FULL_CHARGE + 0.01.
      // 0.71 is the weakest charge that still strips, and it was applied to every bullet in the game:
      // measured 250px of knockback drift where true maximum power gives 343px, and a 50/50
      // break-even head start of 220px instead of 320px. An Enforcer that cannot hit harder than a
      // Ball Hawk is not a personality (research doc §"Smart-bot full-power readiness"), so the
      // ceiling is per-persona AND skill-scaled in withPersona — the bottom of the ladder still
      // releases at the strip threshold and gains nothing here.
      const bulletCeil = clamp(sk.maxCharge != null ? sk.maxCharge : FULL_CHARGE + 0.01, FULL_CHARGE + 0.01, 1);
      const fireAt = isBallRelease
        ? clamp(wantCharge, 0.02, 1) - 0.01
        : (wantCharge >= FULL_CHARGE ? Math.min(clamp(wantCharge, 0, 1), bulletCeil) : Math.max(0.02, wantCharge - 0.02));
      // `tgtId` is the LATCH (see the bullet latch above): the enemy this bullet is for. Ball
      // releases never carry one — the release path is the pass latch's, not this one's.
      bm.charging = { target: wantCharge, fireAt, tol: closeShot ? 0.85 : 0.45, ball: isBallRelease, until: mem.t + windupBudget(p, fireAt), tgtId: isBallRelease ? null : (btn.tgtId || null) };
    }
  } else if (shoot && bm.charging) {
    bm.charging.target = wantCharge; // keep the freshest target while winding up
    if (closeShot) bm.charging.tol = 0.85;
    if (!bm.charging.ball && btn.tgtId) bm.charging.tgtId = btn.tgtId; // re-target: the branch changed its mind
  }
  // WATCHDOG FORCE-RELEASE. Setting shoot=true alone does NOT get the ball out: `fire` needs both
  // p._charge >= fireAt AND the aim inside c.tol, and it was the TOLERANCE that stalled — a close,
  // juking target keeps |dTheta| above tol, so the shot never released and the ball stayed glued.
  // So the watchdog widens tol past π (always satisfiable) and extends the deadline: the release
  // then happens at the earliest instant the charge ramp physically allows, aimed wherever we are
  // pointing. A slightly wild full-power clearance is strictly better than holding the ball for
  // the rest of the match — and note a below-FULL kick would be CAUGHT by a field defender
  // (sim.js:894), which is why this still insists on a FULL charge rather than dumping it instantly.
  if (forceRelease && isBallRelease) {
    const fa = FULL_CHARGE + 0.01;
    if (!bm.charging) bm.charging = { target: 1, fireAt: fa, tol: 4, ball: true, until: mem.t + windupBudget(p, fa) + 1.0 };
    else { bm.charging.tol = 4; bm.charging.fireAt = Math.min(bm.charging.fireAt, fa); bm.charging.until = Math.max(bm.charging.until, mem.t + 0.5); }
  }
  if (bm.charging) {
    const c = bm.charging;
    const lostBall = c.ball && state.ball.owner !== p.id;
    // MEASURED AND REJECTED — the mirror of `lostBall`. A BULLET wind-up still live when this bot
    // PICKS THE BALL UP is no longer a bullet (`fire` while carrying is a KICK), so cancelling it
    // looks like the same bug from the ball's end. It is not this agent's to cancel: 3 seed bases x
    // 16 matches said it removes 12.7 RELEASES per match at the reported level 10 (rel/match 21.6 ->
    // 10.8) — a third of every shot in the match — because the release it kills is a real kick with
    // the carry branch's own aim, and the bot then has to re-charge from zero. Releases belong to the
    // pass latch's owner; if that path is genuinely mis-aimed the fix is to CONVERT the charge to a
    // release (re-derive fireAt/tol), not to throw the shot away. Do not re-add it here.
    const dryBullet = !c.ball && p.ammo <= 0;
    if (lostBall || dryBullet || latchDead || mem.t > c.until) {
      bm.charging = null; // cancel: release trigger without firing
    } else if ((p._charge || 0) >= c.fireAt && dThetaAbs <= c.tol) {
      fire = true;
      // B1 — the LOW end of super discipline, named so it is measurable. Below T_SUPER_HOLD
      // nothing protects the meter, so the first full shot spends it: that is the documented
      // Brawl Stars bot tell ("fires the Super right after respawn"), kept on purpose as the
      // bottom rung of the ladder. This TAGS the behaviour, it does not cause it.
      if (p.power && c.fireAt >= FULL_CHARGE && skT(sk) < T_SUPER_HOLD) bm.lastTrick = 'superDump';
      bm.charging = null; // wound up enough + on target -> release
    } else {
      hold = true; // keep charging
    }
  }

  // EXTREME PRE-CHARGE (stochastic): bank power continuously while approaching so the shot is
  // already wound up the instant the gate opens (kills the visible wind-up) — but only ~70% of
  // the time, so occasionally EXTREME still has a beatable wind-up. Never overrides bomb/special/build.
  // Kept, but BOUNDED so a telegraph survives: banking is allowed only until _charge reaches 0.35
  // (at most half the wind-up), and the probability RAMPS in from t=0.92 rather than snapping on at
  // 0.95. Before, ~70% of the time the shot was already wound up when the gate opened, so there was
  // no visible wind-up at all and therefore nothing for the player to react to.
  const pcp = sk.preChargeP != null ? sk.preChargeP : (sk.preCharge ? 0.55 : 0);
  if (pcp > 0 && !fire && !special && !build && (p._charge || 0) < 0.35 && (state.ball.owner === p.id || p.ammo > 0)) {
    if (seededNoise(Math.floor(mem.t * 0.9) + idHash(p.id) * 0.019) > 1 - pcp * 2) hold = true;
  }
  // ---- readyCharge: BANK POWER BEFORE THERE IS A TARGET (research doc's headline ask) ----------
  // "A smart bot may enter a persistent readiness plan... it does not need a currently selected victim
  // to start charging." Deterministic (no coin flip), persona-shaped, and skill-gated at t >= 0.55 so
  // the low ladder never gets it. The four safeguards from the doc, in order:
  //   * it must not freeze movement — `hold` only drives the trigger; mvx/mvy are untouched;
  //   * a banked charge must not become a KICK on pickup — hence `!carrying`, and finalize's own
  //     lostBall/latch logic still owns any wind-up that was armed by a branch;
  //   * it must not fire just because an enemy exists — this only HOLDS. Every release still goes
  //     through the branch gates (seeC / lane / range), which are untouched;
  //   * the tell survives — it stops at the persona's own ceiling rather than sitting at 1.0 forever,
  //     and a charged bot is visibly charged (the client draws the ring for every player).
  if (!fire && !special && !build && !bm.charging && state.ball.owner !== p.id && p.ammo > 0) {
    const want = readyChargeWant(sk);
    if (want > 0) {
      const ceil = clamp(sk.maxCharge != null ? sk.maxCharge : FULL_CHARGE + 0.01, FULL_CHARGE + 0.01, 1);
      if ((p._charge || 0) < ceil * want) { hold = true; if (!bm.lastTrick) bm.lastTrick = 'readyCharge'; }
    }
  }

  // Resolve a pending build-hold: hold the buildHold control until the windup completes,
  // then emit the build edge once (this tick only) and clear the intent. Mirrors the
  // bombHold hold-then-commit pattern above. The geometry comes from the LATCH resolved at the
  // top of this function (bhDist/bhAim) — it must NOT come from whichever branch happens to run
  // on the commit tick, which is what used to misplace the wall by a median 43px / 38deg.
  let buildHold = false, buildDist = 0;
  if (bm.buildHold) {
    // B3 — the wall's push distance. Read BEFORE the hold is cleared, because the build EDGE
    // and the payload are the same tick: the sim does `p.aimMag = clamp(inp.buildDist, 0, 1)`
    // and places the capsule at BUILT_WALL.offset + aimMag * BUILD_DIST_MAX. finalize() never
    // emitted this field, so every bot wall in the game landed at the 60px minimum while
    // players drag theirs to 180. Below T_FAR_WALL every branch supplies 0, i.e. exactly the
    // old behaviour, so this cannot change what the low tiers do.
    buildDist = bhDist != null ? bhDist : clamp(bm.buildHold.dist || 0, 0, 1);
    // NEVER commit a wall on a tick this bot also FIRES: the sim reads ONE aim
    // (`p.aimX/p.aimY`, set from `inp.aimX/aimY`) for both the bullet/kick direction AND
    // `buildWall`'s wallPlacement, so a wall committed on a shooting tick is placed along the
    // shot. `until` already carries +0.1s of slack and `p.buildWindup` is clamped at 1, so
    // deferring the commit by a tick is free. HARD CAP so the deferral can never become a hang:
    // a bot that fires every tick would otherwise hold the wind-up (and BUILD_WINDUP_SLOW with it)
    // forever — exactly the shape of the deleted `carryJump` freeze.
    const past = mem.t >= bm.buildHold.until;
    if (past && (!fire || mem.t >= bm.buildHold.until + 0.25)) { build = true; bm.buildHold = null; }
    else { buildHold = true; build = false; }
  }
  // The latched wall normal owns the emitted aim for the whole wind-up (so the client's `winding`
  // ghost telegraphs the wall that is actually coming) and, critically, on the commit tick. A
  // FIRE tick still wins — and the commit is deferred off it above, so both jobs get a true aim.
  // bm.aimTheta is untouched, so the tactical slew keeps converging underneath.
  const bhOut = (bhAim && (buildHold || build) && !fire) ? bhAim : null;

  return {
    seq: (bm.seq = (bm.seq || 0) + 1),
    moveX: mvx, moveY: mvy,
    // On the FIRE tick the aim IS the kick/shot direction, so the carry deflection above is
    // dropped there: the ball leaves along the aim the tactic actually chose.
    aimX: bhOut ? bhOut.x : (fire ? Math.cos(th) : ax), aimY: bhOut ? bhOut.y : (fire ? Math.sin(th) : ay),
    // Bots always shoot deliberately AT a target (goal/enemy/mate), so a bot shot is an AIMED
    // shot — it must push/strip. Without this, every bot bullet degrades to a no-push quick shot.
    hold, fire, aimed: fire, special, build, buildHold, buildDist,
    sax, say,
  };
}
