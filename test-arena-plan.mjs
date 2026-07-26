// test-arena-plan.mjs — the PER-ARENA PLAN (shared/arena-plan.js).
//
// The plan copies its lane geometry rather than importing it (no cycle with bot-ai.js), so the
// whole point of this file is that NOTHING here trusts the plan's own arithmetic. Every claim is
// re-checked against the authority that owns the rule:
//   * a claimed SHOOT SPOT is re-tested with bot-ai's real exported `laneClear`, and the ball's
//     reach is re-tested against the sim by actually kicking a ball from the spot and stepping it;
//   * the CANNON claim (§2 of the module header — a refutation, not a feature) is re-checked
//     against sim.js's own `wallCannonMul` by exploding a real bomb and measuring the launch;
//   * the CACHE is proven to rebuild when a wall is built, and to be free otherwise.
//
// BOT_HANDOFF §1 trap 3: unseeded harnesses here cannot measure anything, so every sim run seeds.
import { createState, addPlayer, attachBall, step, setField, makeRng } from './shared/sim.js';
import { MAIN_FIELD } from './shared/main-field.js';
import { FIELD, GOAL, DT, BOMB, BOMB_WALL_DIST, BALL_MIN_SPEED } from './shared/constants.js';
import { laneClear, computeBotInputs, createBotMemory } from './shared/bot-ai.js';
import { planEnsure, planSig, planForTest, nearestShootSpot, spotNoticePx, shootSpotsFor, spotOutletBonus, PLAN_DIMS } from './shared/arena-plan.js';

let pass = 0, fail = 0;
const ok = (c, m, extra = '') => { if (c) { pass++; console.log(`  ok   ${m}`); } else { fail++; console.log(`  FAIL ${m}${extra ? ' — ' + extra : ''}`); } };
const GY = FIELD.H / 2, GOAL_TOP = (FIELD.H - GOAL.width) / 2, GOAL_BOT = (FIELD.H + GOAL.width) / 2;
const hyp = Math.hypot;

function fresh(field = MAIN_FIELD, seed = 7) {
  const s = createState(); s.resetTimer = 0; s.rng = makeRng(seed);
  if (field) setField(s, field);
  return s;
}

// =============================================================================================
console.log('\n1. the plan builds, on both arenas, and is a SMALL set');
// =============================================================================================
for (const [name, field] of [['MAIN_FIELD', MAIN_FIELD], ['default arena', null]]) {
  const s = fresh(field);
  const mem = {};
  const pl = planEnsure(mem, s);
  const nA = pl.shootSpots.A.length, nB = pl.shootSpots.B.length;
  ok(nA > 0 && nB > 0, `${name}: both sides have shoot spots (A=${nA} B=${nB})`);
  ok(nA <= PLAN_DIMS.MAX && nB <= PLAN_DIMS.MAX, `${name}: capped at SPOT_MAX=${PLAN_DIMS.MAX}`, `A=${nA} B=${nB}`);
  // non-maximum suppression really spread them out
  let minSep = 1e9;
  for (const side of ['A', 'B']) {
    const sp = pl.shootSpots[side];
    for (let i = 0; i < sp.length; i++) for (let j = i + 1; j < sp.length; j++) minSep = Math.min(minSep, hyp(sp[i].x - sp[j].x, sp[i].y - sp[j].y));
  }
  ok(minSep >= PLAN_DIMS.SEP - 1e-6, `${name}: no two spots closer than SPOT_SEP=${PLAN_DIMS.SEP}`, `min ${minSep.toFixed(0)}px`);
}

// =============================================================================================
console.log('\n2. every claimed shoot spot really HAS a clear lane — checked with bot-ai laneClear');
// =============================================================================================
{
  const s = fresh();
  const mem = {};
  const pl = planEnsure(mem, s);
  const postIn = pl.postIn;
  const aims = [GY, GOAL_TOP + postIn, GOAL_BOT - postIn];
  let bad = 0, checked = 0, openMismatch = 0, unexplainedDrop = 0;
  for (const [side, egX] of [['A', FIELD.W], ['B', 0]]) {
    for (const sp of pl.shootSpots[side]) {
      checked++;
      // `enemies:false` == the plan's static-only question, and it is EXACTLY the test the release
      // ladder's rung (a) uses to decide whether a shot exists.
      // every aim point the plan CLAIMS must pass the real laneClear...
      let good = 0;
      for (const ay of sp.ays) if (laneClear(sp.x, sp.y, egX, ay, s, side, { enemies: false })) good++;
      if (!good) bad++;
      if (good !== sp.open || sp.ays.length !== sp.open) openMismatch++;
      // ...and the plan must not have SILENTLY DROPPED an aim that laneClear says is open for a
      // reason other than the two it is allowed to use (reach limit, or the woodwork).
      for (const ay of aims) {
        if (sp.ays.includes(ay)) continue;
        if (!laneClear(sp.x, sp.y, egX, ay, s, side, { enemies: false })) continue;
        const far = hyp(egX - sp.x, ay - sp.y) > pl.reach - 40;
        const post = Math.min(...[GOAL_TOP, GOAL_BOT].map((py) => {
          const dx = egX - sp.x, dy = ay - sp.y, l2 = dx * dx + dy * dy || 1;
          const t2 = Math.max(0, Math.min(1, ((egX - sp.x) * dx + (py - sp.y) * dy) / l2));
          return hyp(egX - (sp.x + dx * t2), py - (sp.y + dy * t2));
        })) < 41;
        if (!far && !post) unexplainedDrop++;   // then it was the ball-radius pad — informational
      }
    }
  }
  ok(bad === 0, `all ${checked} spots pass the real laneClear`, `${bad} had no open aim point`);
  ok(openMismatch === 0, `the recorded open-aim COUNT matches laneClear exactly`, `${openMismatch} mismatched`);
  // The plan is deliberately a STRICT SUBSET of laneClear's open set (reach margin, the posts, and
  // the ball-radius pad all remove aims laneClear would allow), so a drop is not a defect — the
  // subset direction above is the safety property. Printed so a future change that starts dropping
  // far MORE aims is visible.
  console.log(`     aims laneClear allows but the plan conservatively drops: ${unexplainedDrop} (ball-radius pad)`);
}

// =============================================================================================
console.log('\n3. the SIM agrees: a ball kicked from a shoot spot reaches the goal line');
// =============================================================================================
// The plan claims `reach` from an analytic roll model. Prove it against the sim by rolling a real
// ball from each spot toward its best aim point and checking it crosses the line (or scores).
// AIM AT THE AIM POINT THE PLAN CLAIMS, not at the goal centre. The first version of this test
// kicked every ball at (egX, GY) and "failed" 8 of 26 spots — including one 116px out — because a
// spot whose only OPEN aim point is a POST is not claiming the centre is on, and a ball fired at
// the centre from beside the mouth hits the end line outside GOAL_TOP..GOAL_BOT, where sim.js:495
// makes the line a solid wall. The plan's claim is per-aim-point, so the test must be too.
{
  const pl0 = planEnsure({}, fresh());
  let crossed = 0, tried = 0, worst = 1e9;
  for (const [side, egX] of [['A', FIELD.W], ['B', 0]]) {
    for (const sp of pl0.shootSpots[side]) {
      const s = fresh();
      // fire at the aim point the plan ITSELF claims (nearest of them). Re-deriving this from
      // laneClear alone disagreed with the plan about which post was open and produced a phantom
      // failure — the plan records `ays` precisely so the test does not have to guess.
      let ay = null, ad = 1e9;
      for (const cand of sp.ays) { const d = hyp(egX - sp.x, cand - sp.y); if (d < ad) { ad = d; ay = cand; } }
      if (ay == null) { tried++; continue; }
      // no players at all: an unobstructed roll, so this measures the BALL model, not the bots.
      // `lastTouch` IS LOAD-BEARING: sim.js scores a goal only for the ATTACKING team, and for a
      // NEUTRAL ball the goal line is a solid wall that bounces it back (sim.js:495) — leaving it
      // unset made all 26 spots "fail" while the model was fine.
      s.ball.owner = null; s.ball.x = sp.x; s.ball.y = sp.y; s.ball.lastTouch = side;
      const [ux, uy] = (() => { const d = hyp(egX - sp.x, ay - sp.y); return [(egX - sp.x) / d, (ay - sp.y) / d]; })();
      const v0 = s.settings.shotPower || 1400;
      s.ball.vx = ux * v0; s.ball.vy = uy * v0;
      tried++;
      let reached = false;
      for (let i = 0; i < 300; i++) {
        step(s, {}, DT);
        if (s.score.A || s.score.B || s.resetTimer > 0) { reached = true; break; }        // scored
        const past = egX === FIELD.W ? s.ball.x >= FIELD.W - 8 : s.ball.x <= 8;
        if (past) { reached = true; break; }
        if (hyp(s.ball.vx, s.ball.vy) < BALL_MIN_SPEED + 1) break;                        // died short
      }
      if (reached) crossed++; else worst = Math.min(worst, sp.d);
    }
  }
  ok(crossed === tried, `${crossed}/${tried} spots: a full-charge roll actually reaches the goal line`,
    worst < 1e9 ? `shortest failing spot was ${worst}px out of a claimed reach ${pl0.reach.toFixed(0)}px` : '');
}

// =============================================================================================
console.log('\n4. the plan NEVER claims a spot the sim would not let a player stand in');
// =============================================================================================
{
  const s = fresh();
  const pl = planEnsure({}, s);
  let moved = 0, tried = 0;
  for (const [side, egX] of [['A', FIELD.W], ['B', 0]]) {
    for (const sp of pl.shootSpots[side]) {
      const t = fresh();
      addPlayer(t, 'P', { name: 'P', char: 'player', team: side, slot: 0, isBot: false });
      const p = t.players.P; p.x = sp.x; p.y = sp.y; p.vx = 0; p.vy = 0;
      step(t, { P: { moveX: 0, moveY: 0, aimX: 1, aimY: 0 } }, DT);
      tried++;
      // if the spot were inside a wall/edge, resolveWalls would shove the body out
      if (hyp(p.x - sp.x, p.y - sp.y) > 1.0) moved++;
    }
  }
  ok(moved === 0, `${tried} spots are all legally standable (sim did not push the body out)`, `${moved} were shoved`);
}

// =============================================================================================
console.log('\n5. the CACHE: free on a hit, rebuilt when a wall is BUILT, LRU-bounded');
// =============================================================================================
{
  const s = fresh();
  const mem = {};
  const p1 = planEnsure(mem, s);
  const p2 = planEnsure(mem, s);
  ok(p1 === p2, 'a second call with unchanged walls returns the SAME object (no rebuild)');
  ok(planForTest(mem).builds === 1, 'exactly one build so far', `builds=${planForTest(mem).builds}`);

  const sig0 = planSig(s);
  // build a wall ACROSS one of team A's shoot lanes and prove the signature and the plan move
  const spot = p1.shootSpots.A[0];
  const wx = (spot.x + FIELD.W) / 2;
  s.builtWalls.push({ x: wx - 16, y: spot.y - 90, w: 32, h: 180, cx: wx, cy: spot.y, angle: Math.PI / 2, hl: 90, ht: 16, hp: 3, maxHp: 3, id: 9001, team: 'B', ttl: 0 });
  ok(planSig(s) !== sig0, 'planSig changes when a wall is built');
  const p3 = planEnsure(mem, s);
  ok(p3 !== p1, 'the plan REBUILDS after a build', `builds=${planForTest(mem).builds}`);
  ok(planForTest(mem).builds === 2, 'and only rebuilt once', `builds=${planForTest(mem).builds}`);

  // the new wall must actually have removed/changed something the plan claims
  const sameSpotStillClaimed = p3.shootSpots.A.some((q) => q.x === spot.x && q.y === spot.y && q.open === spot.open);
  ok(!sameSpotStillClaimed, 'the spot behind the new wall is no longer claimed with the same open count');
  // and the survivors are still honest under the real laneClear
  const aims = [GY, GOAL_TOP + p3.postIn, GOAL_BOT - p3.postIn];
  let bad = 0;
  for (const sp of p3.shootSpots.A) {
    let open = 0;
    for (const ay of aims) if (hyp(FIELD.W - sp.x, ay - sp.y) <= p3.reach && laneClear(sp.x, sp.y, FIELD.W, ay, s, 'A', { enemies: false })) open++;
    if (open !== sp.open) bad++;
  }
  ok(bad === 0, 'post-build spots still agree with laneClear', `${bad} mismatched`);

  // removing the wall again returns the ORIGINAL cached object (that is what the LRU buys)
  s.builtWalls.pop();
  const p4 = planEnsure(mem, s);
  ok(p4 === p1, 'wall removed -> the LRU returns the original plan without rebuilding');
  ok(planForTest(mem).builds === 2, 'still 2 builds', `builds=${planForTest(mem).builds}`);

  // LRU is bounded
  for (let i = 0; i < PLAN_DIMS.LRU + 5; i++) {
    s.builtWalls.push({ x: 900, y: 500, w: 10, h: 10, hp: 3, maxHp: 3, id: 20000 + i, team: 'B', ttl: 0 });
    planEnsure(mem, s);
  }
  ok(planForTest(mem).map.size <= PLAN_DIMS.LRU, `LRU bounded at ${PLAN_DIMS.LRU}`, `size=${planForTest(mem).map.size}`);
  // a NEW arena object drops the whole container
  const s2 = fresh(MAIN_FIELD);
  planEnsure(mem, s2);
  ok(planForTest(mem).arenaRef === s2.arena, 'a different arena resets the container');
}

// =============================================================================================
console.log('\n6. the TIER LADDER is a notice RADIUS and it is monotone (never a coin flip)');
// =============================================================================================
{
  const s = fresh();
  const mem = {};
  ok(spotNoticePx(0) < spotNoticePx(0.5) && spotNoticePx(0.5) < spotNoticePx(1), `notice radius rises with t (${spotNoticePx(0)} < ${spotNoticePx(0.5)} < ${spotNoticePx(1)})`);
  // determinism: the same query twice must give the identical answer (no RNG anywhere)
  const q1 = nearestShootSpot(mem, s, 1400, 550, 'A', hyp(FIELD.W - 1400, 0), 0.93);
  const q2 = nearestShootSpot(mem, s, 1400, 550, 'A', hyp(FIELD.W - 1400, 0), 0.93);
  ok(q1 && q2 && q1.x === q2.x && q1.y === q2.y, 'the query is deterministic');
  // a weak tier must find STRICTLY FEWER answers than a strong one over the same positions
  const counts = [];
  for (const t of [0.05, 0.5, 0.93]) {
    let n = 0;
    for (let y = 100; y < FIELD.H - 100; y += 50) for (let x = 100; x < FIELD.W - 100; x += 50) {
      const dg = hyp(FIELD.W - x, GY - y);
      if (dg > 1150) continue;
      if (nearestShootSpot(mem, s, x, y, 'A', dg, t)) n++;
    }
    counts.push(n);
  }
  ok(counts[0] < counts[1] && counts[1] < counts[2], `answers found rise strictly with tier (${counts.join(' < ')})`);
  // and never route BACKWARDS: the spot must not be further from the goal than the carrier
  let backward = 0, tested = 0;
  for (let y = 100; y < FIELD.H - 100; y += 40) for (let x = 100; x < FIELD.W - 100; x += 40) {
    const dg = hyp(FIELD.W - x, GY - y);
    const r = nearestShootSpot(mem, s, x, y, 'A', dg, 1.0);
    if (!r) continue;
    tested++;
    if (hyp(FIELD.W - r.x, GY - r.y) > dg + 40) backward++;
  }
  ok(backward === 0, `no spot loses ground toward the goal (${tested} routes tested)`, `${backward} backward`);
}

// =============================================================================================
console.log('\n7. the CANNON refutation (module header §2) is re-checked against sim.js itself');
// =============================================================================================
// The plan does NOT ship cannon spots, on the measured grounds that the boost is already common
// (65% of positions can boost some direction) so a precomputed map adds nothing to the runtime
// search. That claim rests on sim.js's own wallCannonMul, so verify the mechanism really is there
// by launching a real bomb with and without stone behind it.
// FIXTURE GEOMETRY IS THE WHOLE TEST HERE. The first version stood the player under MAIN_FIELD's
// horizontal capsule and launched DOWNWARD — and measured 0px in BOTH arms, because MAIN_FIELD's
// crates at y=350 sit 115px below in the launch cone and explode()'s `jumpBlocked` cancels the jump
// outright when any static wall lies AHEAD of it. So the arena must be empty except the one wall
// under test, and the launch must point into genuinely open ground.
{
  const bare = { version: 1, bushes: [], hardWalls: [], dryWalls: [], crates: [] };
  const behind = { ...bare, hardWalls: [{ cx: 330, cy: 550, angle: Math.PI / 2, hl: 150, ht: 16 }] };
  const dists = [];
  for (const field of [bare, behind]) {
    const s = fresh(field);
    s.ball.x = 1000; s.ball.y = 100;                 // keep the ball away: a CARRIER cannot plant
    addPlayer(s, 'P', { name: 'P', char: 'player', team: 'A', slot: 0, isBot: false });
    const p = s.players.P;
    p.x = 400; p.y = 550; p.vx = 0; p.vy = 0;        // wall (if any) 70px to the LEFT, launch RIGHT
    p.specialCd = 0;
    const x0 = p.x, y0 = p.y;
    let maxD = 0;
    for (let i = 0; i < 300; i++) {
      step(s, { P: { moveX: 0, moveY: 0, aimX: 1, aimY: 0, special: i < 3 } }, DT);
      maxD = Math.max(maxD, hyp(p.x - x0, p.y - y0));
    }
    dists.push(maxD);
  }
  ok(dists[0] > 100, `the bare rocket-jump launches at all (${dists[0].toFixed(0)}px) — else the fixture is broken, not the sim`);
  ok(dists[1] > dists[0] * 1.15, `stone behind the bomb really cannons the launch (${dists[0].toFixed(0)}px -> ${dists[1].toFixed(0)}px)`);
  ok(BOMB_WALL_DIST === 150 && BOMB.fuse > 0, `the rule the refutation quotes is still BOMB_WALL_DIST=${BOMB_WALL_DIST}`);
}

// =============================================================================================
console.log('\n8. COST: built once per arena, and the per-tick consult is free');
// =============================================================================================
{
  const s = fresh();
  // build cost, warm
  const N = 100, mem = {};
  planEnsure(mem, s);                                  // warm the JIT
  const t0 = performance.now();
  for (let i = 0; i < N; i++) { mem.plans = null; planEnsure(mem, s); }
  const buildMs = (performance.now() - t0) / N;
  ok(buildMs < 3.0, `plan build ${buildMs.toFixed(3)}ms (nav grid rebuild is ~1ms; budget 3ms)`);

  // per-tick cost inside a REAL match: the plan must not rebuild per tick or per bot
  const m = fresh();
  for (const [id, team, slot] of [['A0', 'A', 0], ['A1', 'A', 1], ['B0', 'B', 0], ['B1', 'B', 1]])
    addPlayer(m, id, { name: id, char: 'player', team, slot, isBot: true });
  attachBall(m, 'A');
  const bmem = createBotMemory('normal');
  bmem.teamSkill = { A: 0.93, B: 0.93 };
  for (let i = 0; i < 120; i++) { step(m, computeBotInputs(m, bmem, DT), DT); }   // warm
  const buildsAfterWarm = bmem.plans ? bmem.plans.builds : 0;
  const TICKS = 1800;
  const t1 = performance.now();
  for (let i = 0; i < TICKS; i++) step(m, computeBotInputs(m, bmem, DT), DT);
  const perTick = (performance.now() - t1) / TICKS;
  const builds = (bmem.plans ? bmem.plans.builds : 0) - buildsAfterWarm;
  console.log(`     ${TICKS} ticks of a live 2v2: ${perTick.toFixed(3)}ms/tick total sim+AI`);
  // The module is UNWIRED, so a live match never touches it on its own (`bmem.plans` stays absent —
  // asserting otherwise is what this test used to do, and it correctly went red the moment the last
  // consumer was reverted). So drive the cache over the SAME match to price what a consumer WOULD
  // pay: one lookup per bot per tick, on a state whose builtWalls really do change.
  const pmem = {};
  const t2 = performance.now();
  let looks = 0;
  for (let i = 0; i < TICKS; i++) {
    step(m, computeBotInputs(m, bmem, DT), DT);
    for (const id in m.players) { nearestShootSpot(pmem, m, m.players[id].x, m.players[id].y, m.players[id].team, 900, 0.93); looks++; }
  }
  const withPlan = (performance.now() - t2) / TICKS;
  const rebuilds = pmem.plans ? pmem.plans.builds : 0;
  console.log(`     with ${looks} plan lookups (${(looks / TICKS).toFixed(0)}/tick): ${withPlan.toFixed(3)}ms/tick, ${rebuilds} rebuilds over ${TICKS} ticks`);
  ok(rebuilds <= 20, `the plan rebuilds per WALL CHANGE, not per tick or per bot (${rebuilds} in ${TICKS} ticks x ${(looks / TICKS).toFixed(0)} bots)`);
  ok(pmem.plans && pmem.plans.arenaRef === m.arena, 'the cache is keyed on the live arena object');
}

// =============================================================================================
console.log('\n9. the two REVERTED consumers — the contracts they relied on, kept measurable');
// =============================================================================================
// The module is UNWIRED (see its header): both consumers measured worse and were reverted. What is
// still worth testing is that the two query surfaces a future consumer would use are correct and
// tier-scaled, and that the arena facts the refutations rest on have not silently changed — because
// if MAIN_FIELD is ever re-cut, the refutations may no longer hold and the idea deserves a re-run.
{
  const s = fresh();
  const mem = {};
  // (a) the off-ball outlet surface: candidates exist, and the goal-line guard was load-bearing.
  let cands = 0, onLine = 0;
  for (const [team, egX] of [['A', FIELD.W], ['B', 0]]) {
    const ahead = egX - (team === 'A' ? 300 : -300);
    for (const sp of shootSpotsFor(mem, s, team)) {
      if (Math.abs(sp.x - ahead) > 420) continue;
      if (Math.abs(sp.x - egX) < 200) { onLine++; continue; }
      cands++;
    }
  }
  ok(cands > 0, `the off-ball outlet surface has candidates on both sides (${cands})`);
  ok(onLine > 0, `spots DO sit on the goal line (${onLine}) — the guard that cost a 16.58s jam was needed`);
  ok(spotOutletBonus(0.2) === 0 && spotOutletBonus(1) > 100, `the outlet bonus is a ramp: 0 below t=0.35, ${spotOutletBonus(1).toFixed(0)} at the top`);

  // (b) THE ARENA FACT THE WHOLE MODULE RESTS ON. If this stops being true, re-open the idea.
  const walls = s.arena.walls.concat(s.builtWalls || []);
  const aims = [GY, GOAL_TOP + planEnsure(mem, s).postIn, GOAL_BOT - planEnsure(mem, s).postIn];
  let tot = 0, blocked = 0;
  for (let y = 60; y <= FIELD.H - 60; y += 25) for (let x = 60; x <= FIELD.W - 60; x += 25) {
    tot++;
    let open = false;
    for (const ay of aims) if (laneClear(x, y, FIELD.W, ay, s, 'A', { enemies: false })) { open = true; break; }
    if (!open) blocked++;
  }
  const pct = 100 * blocked / tot;
  console.log(`     MAIN_FIELD: ${pct.toFixed(1)}% of the pitch has no static lane to any mouth aim point (was 54.8% when the refutations were measured)`);
  ok(pct > 30, `the shot-shadow problem the plan was built for is still real (${pct.toFixed(1)}%)`);
  ok(walls.length >= 16, `arena still has its 16+ walls (${walls.length})`);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
