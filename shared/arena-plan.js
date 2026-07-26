// ============================== PER-ARENA PLAN ==============================================
// Requested: *"maybe each map should have a preplanned optimized set of rules, so that the bot
// will kinda know where they want to go, shoot, use the bombs etc.?"*
//
// The premise is right about one thing in particular: the arena is FIXED for a whole match
// (`state.arena`, built once by buildArenaFromField), so anything that is a property of the
// GEOMETRY rather than of the moment can be computed ONCE and cached — exactly like the nav grid
// (`navSig`/`navEnsure` in bot-ai.js, LRU, rebuilt only when `builtWalls` change). This module is
// that cache. It follows the nav grid's shape deliberately: one container per arena, invalidated
// by a cheap signature, an LRU of built results inside it.
//
// STATUS: BUILT, TESTED, AND DELIBERATELY **UNWIRED**. Nothing imports this module. Two different
// consumers were wired and measured, and BOTH LOST — the numbers and the causes are recorded in
// bot-ai.js at the two call sites that used to exist (the release ladder's (d) rung, and the
// off-ball outlet chooser). It is kept because the DATA and the measurements are reusable and cost
// nothing while unimported, and because the next person to have this idea should start from the
// evidence rather than from scratch. Read the verdict below before wiring anything.
//
// THE VERDICT, in one line: the arena facts are real and cheap to compute, but on this game's clocks
// no bot can act on them — a carrier holds the ball under a second (0% arrival), and an off-ball bot
// sent to a named POINT near attacking geometry wedges on it (multi-second jams), whereas the
// existing code's vertical line at x=ahead does not. The runtime searches this was meant to replace
// (`cannonPlant`, `chooseAmbushBush`, the openness outlet scan) were already the right queries.
//
// WHAT IS IN HERE, AND WHY ONLY THIS -----------------------------------------------------------
// Four things were candidates. Each was MEASURED on MAIN_FIELD before any of it was written, and
// only ONE survived. The other three measurements are recorded here so nobody re-derives them.
//
// 1. SHOOT SPOTS — BUILT (the only one). Sampled MAIN_FIELD at 25px: **54.8% of the pitch has NO clear static ball
//    lane to ANY of the three mouth aim points** (centre + both posts), and **36.0%** of the area
//    within 1150px of the goal has none either. That is not a rounding error, and it has an obvious
//    cause: the two hard capsules at x=375 / x=1625 are 300px tall and sit dead across the mouth's
//    y-band, 375px in front of each goal, so each one casts a wide shot shadow. A carrier standing
//    in one of those shadows currently has no rung of the release ladder that says "the shot is two
//    steps to your left" — it slides laterally on a 1.2s coin-flip (`workAngle`) instead. So the
//    plan's job is to name the places a shot actually exists.
//
// 2. CANNON SPOTS — REFUTED, and the number is the opposite of what the idea assumes. It is not
//    that cannon spots are rare: **65.2% of sampled positions can boost SOME of 16 launch
//    directions and 48.7% can reach mul >= 1.25** (peak is 1.55). Aimed at the enemy goal from
//    beyond JUMP_MIN_D, a boost is already available at **20.7%** of positions. `cannonPlant()`
//    finds a chance on only ~4% of launches not because the geometry is scarce but because
//    (a) `steer()` actively repels bots FROM walls (that is its whole clearance term) while the
//    cannon needs stone within 235px BEHIND the launch, and (b) `mobilityJump` fires rarely at all.
//    Converting a launch would therefore mean travelling to a boosted spot — mean detour **169px**
//    — and BOT_HANDOFF §4 already records that the old wall-cannon walked to a computed pad and
//    ARRIVED 0 TIMES OUT OF 449. The runtime `(lob x rotation)` search at the bot's CURRENT
//    position is the correct query, and a precomputed map adds nothing to it. Not built.
//
// 3. CHOKES — REFUTED on this map. Only **9.8% of free cells sit in a vertical gap under 260px**,
//    i.e. narrow enough for one built wall (hl ~75) to actually plug; the modal gap is 600-900px.
//    A choke map on MAIN_FIELD would tell a bot "there are no chokes here", which changes no
//    decision. Worth re-measuring if a future field-builder layout is tight.
//
// 4. AMBUSH BUSHES — REFUTED as a plan item. `chooseAmbushBush()` already scans all 14 bushes at
//    runtime, and **61% of defending-half carrier positions have >= 1 eligible bush with a mean of
//    1.13 candidates**. With ~1 candidate there is nothing to choose between, so a precomputed
//    per-arena table cannot pick better than the runtime scan. Left alone.
//
// GEOMETRY RULE: the lane test below is the same exact segment-vs-AABB slab clip that bot-ai's
// `laneClear` uses, with the same LANE_SKIP, run against static walls + builtWalls and NO enemies
// (a body is not a property of the arena). `test-arena-plan.mjs` asserts that agreement against the
// real `laneClear` rather than trusting it.
// ONE RULE IS ADDED, and only because the sim has it and `laneClear` does not: THE POSTS. Rolling a
// real ball from all 26 claimed spots showed 6 of them dying on the woodwork (see `postGrazes`), so
// a plan that only asked laneClear was over-claiming. Plus a REACH_SAFETY margin for the two that
// sat at the very limit of the roll. Both were found by test §3, not by reasoning.
import { FIELD, GOAL, POST_R, BALL_RADIUS, BALL_MIN_SPEED, CHARACTERS, DEFAULT_CHAR, clamp } from './constants.js';
import { ARENA, nearestOnWall } from './arena.js';

const hyp = Math.hypot;
const GY = FIELD.H / 2;
const GOAL_TOP = (FIELD.H - GOAL.width) / 2;
const GOAL_BOT = (FIELD.H + GOAL.width) / 2;
const arenaOf = (state) => (state && state.arena) || ARENA;

// Same relation bot-ai uses (roll is linear in release speed): roll ~ 0.468 * (v0 - BALL_MIN_SPEED).
// At charge 1 the charge multiplier is exactly 1, so this is the ball's MAX reach (~627px on
// default settings) — the honest ceiling on "a shot from here can cross the line".
const ROLL_K = 0.468;
function fullRollPx(state) {
  const v0 = ((state.settings && state.settings.shotPower) || 1400);
  return Math.max(0, ROLL_K * (v0 - BALL_MIN_SPEED));
}

// ---- EXACT segment-vs-AABB (slab). Copied, not imported, so this module has no cycle with
// bot-ai.js; test-arena-plan.mjs asserts it agrees with the real laneClear on every spot. ----
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
// ---- THE WOODWORK. Caught by test §3 rolling a real ball from every claimed spot: 6 of 26 spots
// "had a clear lane" and then died on the POST. sim.js:487-490 bounces the ball off a post disc at
// each mouth end (POST_R 9), and a spot OUTSIDE the mouth's y-band aiming at the near post has to
// cross the goal line right where that post is. Measured: every spot whose closest approach to a
// post was under ball+post radius (24-30px) failed; every one at or above it crossed. `laneClear`
// does not know about posts — it only tests walls — so the plan must, or it over-claims.
function postGrazes(x, y, egX, ay, ballR) {
  const need = ballR + POST_R;
  for (const py of [GOAL_TOP, GOAL_BOT]) {
    const dx = egX - x, dy = ay - y, l2 = dx * dx + dy * dy || 1;
    const t = clamp(((egX - x) * dx + (py - y) * dy) / l2, 0, 1);
    if (hyp(egX - (x + dx * t), py - (y + dy * t)) < need) return true;
  }
  return false;
}
// The analytic roll is ~2% optimistic at its very limit (a ball arriving at BALL_MIN_SPEED does not
// reliably cross), so keep a margin: test §3 had exactly the two spots at d=633/644 of a 647px
// reach die short, and nothing below 570 failed.
const REACH_SAFETY = 40;

const LANE_SKIP = 14; // must match bot-ai.js laneClear
// THE BALL IS 32px OF RADIUS, NOT A POINT. `laneClear` tests the lane as a zero-width segment
// (segHitsBox with pad 0), which is right for a bullet and wrong for the ball: test §3 rolled a real
// ball from spot B(160,160) at the goal centre and it bounced off the dry wall at (50,225) that the
// unpadded lane "cleared" by under a ball radius. Padding every wall by `pad` makes the plan's open
// set a strict SUBSET of laneClear's, i.e. the plan is deliberately more conservative than bot-ai's
// own rung (a) — which is the correct direction for something that promises a shot exists.
function staticLaneClear(x0, y0, x1, y1, walls, pad = 0) {
  const L = hyp(x1 - x0, y1 - y0);
  if (L > LANE_SKIP * 2) { const f = LANE_SKIP / L; x0 += (x1 - x0) * f; y0 += (y1 - y0) * f; }
  for (const w of walls) if (segHitsBox(x0, y0, x1, y1, w, pad)) return false;
  return true;
}

// ---- BUILD -----------------------------------------------------------------------------------
// SPOT_CELL is coarse on purpose. A shoot spot is a REGION ("stand roughly here and the near post
// is open"), not a pixel, and the sampling cost is quadratic in resolution. 64px is half a nav
// cell's worth of accuracy in the only dimension that matters (does the lane clear the wall edge),
// and the consumer's steering does the last ~100px anyway.
const SPOT_CELL = 64;
const SPOT_SEP = 190;     // minimum spacing between kept spots (non-maximum suppression)
const SPOT_MAX = 14;      // per attacking side — "a small set", and it bounds the per-query cost
const PLAN_LRU = 8;

function buildSide(state, egX, walls, reach, postIn, r, ballR) {
  const aims = [GY, GOAL_TOP + postIn, GOAL_BOT - postIn];
  const cands = [];
  let sampled = 0, walkable = 0, inBand = 0;
  for (let y = SPOT_CELL / 2; y < FIELD.H; y += SPOT_CELL) {
    for (let x = SPOT_CELL / 2; x < FIELD.W; x += SPOT_CELL) {
      sampled++;
      // in the reach band? (measured to the goal CENTRE first — the cheap reject)
      if (hyp(egX - x, GY - y) > reach + GOAL.width / 2) continue;
      inBand++;
      // walkable: the sim must let a player stand here. Same clearance rule the nav grid uses,
      // without its r+2 inflation (a shoot spot is a destination, not a path cell).
      if (x < r + 8 || x > FIELD.W - r - 8 || y < r + 8 || y > FIELD.H - r - 8) continue;
      let blocked = false;
      for (const w of walls) { const np = nearestOnWall(w, x, y); if (hyp(x - np.x, y - np.y) - (np.rad || 0) < r + 4) { blocked = true; break; } }
      if (blocked) continue;
      walkable++;
      // how many mouth aim points are open from here, and can the kick actually REACH them?
      let bestD = 1e9;
      const ays = [];                 // the aim points this spot CLAIMS — recorded, so a test can
                                      // fire at exactly the claim instead of re-deriving it (the
                                      // first version of test §3 re-derived and disagreed with the
                                      // plan about which post was open)
      for (const ay of aims) {
        const d = hyp(egX - x, ay - y);
        if (d > reach - REACH_SAFETY) continue;                    // the ball would die short
        if (postGrazes(x, y, egX, ay, ballR)) continue;            // the woodwork is in the way
        if (!staticLaneClear(x, y, egX, ay, walls, ballR)) continue;
        ays.push(ay); if (d < bestD) bestD = d;
      }
      const open = ays.length;
      if (!open) continue;
      // Score: an open mouth is worth far more than a short walk, and a closer spot is a better
      // shot (less roll spent, less time for a defender to arrive). Deterministic — no RNG here,
      // because BOT_HANDOFF §4's autopsy is that stochastic behaviour adds variance faster than
      // it adds ranking.
      // TWO distances, and conflating them was a real bug caught by test §6: `d` is to the nearest
      // OPEN aim point (a post, usually) and drives the score/reach, but "am I losing ground?" is
      // only meaningful against the goal CENTRE — the same measure the carrier's own `distGoal`
      // uses. Filtering the query on `d` let 56 of 657 routes point away from the goal.
      cands.push({ x, y, open, ays, d: bestD, dc: hyp(egX - x, GY - y), score: open * 900 - bestD });
    }
  }
  // non-maximum suppression -> a small, spread set
  cands.sort((a, b) => b.score - a.score);
  const spots = [];
  for (const c of cands) {
    let near = false;
    for (const s of spots) if (hyp(s.x - c.x, s.y - c.y) < SPOT_SEP) { near = true; break; }
    if (near) continue;
    spots.push({ x: c.x, y: c.y, open: c.open, ays: c.ays, d: Math.round(c.d), dc: Math.round(c.dc) });
    if (spots.length >= SPOT_MAX) break;
  }
  return { spots, stats: { sampled, inBand, walkable, candidates: cands.length, kept: spots.length } };
}

function buildPlan(state) {
  const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  const arena = arenaOf(state);
  const walls = arena.walls.concat(state.builtWalls || []);
  const reach = fullRollPx(state);
  const postIn = BALL_RADIUS * ((state.settings && state.settings.ballSizeMul) || 1) + 26; // matches bot-ai's aimPoints
  const r = CHARACTERS[DEFAULT_CHAR].radius * ((state.settings && state.settings.sizeMul) || 1); // mirrors bot-ai radOf
  // Team A attacks x = FIELD.W, team B attacks x = 0 (bot-ai's enemyGoalX).
  const ballR = BALL_RADIUS * ((state.settings && state.settings.ballSizeMul) || 1);
  const A = buildSide(state, FIELD.W, walls, reach, postIn, r, ballR);
  const B = buildSide(state, 0, walls, reach, postIn, r, ballR);
  const t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  return {
    shootSpots: { A: A.spots, B: B.spots },
    reach, postIn, radius: r,
    stats: { A: A.stats, B: B.stats, buildMs: +(t1 - t0).toFixed(3) },
  };
}

// ---- CACHE -----------------------------------------------------------------------------------
// Identical shape to navEnsure: a container tied to the arena OBJECT, invalidated by a cheap
// signature over builtWalls (they change ~once per 15s per player, so a hash beats incremental
// re-stamping), plus the two live-tunable settings the geometry depends on. An LRU inside means a
// wall being built and then blown up does not pay for a rebuild twice.
export function planSig(state) {
  let h = ((state.builtWalls || []).length * 2654435761) >>> 0;
  for (const w of (state.builtWalls || [])) h = (h ^ Math.imul(w.id | 0, 2246822519) ^ (Math.round(w.hp) * 97)) >>> 0;
  const s = state.settings || {};
  h = (h ^ Math.imul(Math.round((s.shotPower || 1400)), 374761393)) >>> 0;
  h = (h ^ Math.imul(Math.round((s.ballSizeMul || 1) * 100), 668265263)) >>> 0;
  h = (h ^ Math.imul(Math.round((s.sizeMul || 1) * 100), 2246822519)) >>> 0; // player radius = walkability
  return h;
}

export function planEnsure(mem, state) {
  const arena = arenaOf(state), sig = planSig(state);
  let box = mem.plans;
  if (!box || box.arenaRef !== arena) box = mem.plans = { arenaRef: arena, map: new Map(), lru: [], builds: 0 };
  let pl = box.map.get(sig);
  if (!pl) {
    pl = buildPlan(state);
    box.map.set(sig, pl); box.lru.push(sig); box.builds++;
    while (box.lru.length > PLAN_LRU) box.map.delete(box.lru.shift());
  }
  return pl;
}

// ---- THE QUERY -------------------------------------------------------------------------------
// (Kept for the record; its consumer was reverted.) TIER SCALING LIVES HERE, and it is a RADIUS,
// not a probability. BOT_HANDOFF §00000 records the
// same mistake twice in one day: a behaviour made equally reliable for every tier FLATTENS the
// difficulty ladder, because a skill-independent action hands the bottom tier ground the top tier
// used to have to earn. And §4's autopsy of the seven `decisionHz` variants + `mistakeP` records
// the other half: a STOCHASTIC handicap adds variance faster than it adds ranking. So the scaling
// is the file's existing pattern — a deterministic notice radius, exactly like the fetch
// override's `300 + 900*t` and the forward clearance's `60 + 200*t` veto:
//     t=0.00  ->  150px   a weak bot only sees a shot spot it is practically standing on
//     t=0.50  ->  400px
//     t=1.00  ->  650px   the top tier will walk two seconds to find the angle
// 650px is also about the honest ceiling: measured carrier speed is ~154-168px/s and
// CARRY_HOLD_MAX caps a hold at ~2.6s before the watchdog forces the ball out, so a spot much
// further than that could never be reached with the ball and the plan would be selling a promise
// the sim cancels.
export const spotNoticePx = (t) => 150 + 500 * clamp(t, 0, 1);

// The nearest shoot spot worth walking to, or null. `distGoal` is the carrier's own distance to
// the enemy goal centre: a spot must not LOSE ground (round 7's whole point — no backward
// releases, and by the same argument no backward routing), and must be inside the tier's notice.
export function nearestShootSpot(mem, state, x, y, team, distGoal, t) {
  const pl = planEnsure(mem, state);
  const spots = pl.shootSpots[team === 'A' ? 'A' : 'B'];
  if (!spots || !spots.length) return null;
  const notice = spotNoticePx(t);
  let best = null, bestD = 1e9;
  for (const s of spots) {
    const d = hyp(s.x - x, s.y - y);
    if (d > notice || d < 60) continue;            // already there = nothing to route to
    if (s.dc > distGoal + 40) continue;            // never route AWAY from the goal (CENTRE distance —
                                                   // see the two-distance comment in buildSide)
    if (d < bestD) { bestD = d; best = s; }
  }
  return best ? { x: best.x, y: best.y, d: bestD, open: best.open } : null;
}

// The raw spot list for one attacking side. This was the off-ball outlet chooser's entry point
// before that wiring was reverted for measuring worse — see bot-ai.js. Do not mutate the result.
export function shootSpotsFor(mem, state, team) {
  return planEnsure(mem, state).shootSpots[team === 'A' ? 'A' : 'B'];
}

// How much is "I could shoot from this outlet" worth to THIS tier? A RAMP, not a cliff and not a
// probability: worth nothing below t=0.35 (the bot keeps the old openness-only outlet), rising to
// ~200 score-px per open aim point at the top. Same reasoning as spotNoticePx — §00000 records the
// ladder collapsing when a useful behaviour is handed to every tier equally, and §4 records that a
// stochastic gate adds variance faster than ranking.
export const spotOutletBonus = (t) => 200 * clamp((clamp(t, 0, 1) - 0.35) / 0.65, 0, 1);

// Read-only accessors for the tests (never mutate, never build).
export function planForTest(mem) { return mem.plans || null; }
export const PLAN_DIMS = { CELL: SPOT_CELL, SEP: SPOT_SEP, MAX: SPOT_MAX, LRU: PLAN_LRU };
