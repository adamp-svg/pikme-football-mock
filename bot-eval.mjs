// Bot measurement harness — two modes.
//
//   node bot-eval.mjs                    -> BEHAVIOUR AUDIT (default): per-difficulty-level counts of
//   node bot-eval.mjs behave [m] [secs]     what the bots ACTUALLY DID inside the sim.
//   node bot-eval.mjs ab [m] [secs]      -> the old A/B: team NEW (shared/bot-ai.js) vs team LEGACY
//   node bot-eval.mjs 30 70                 (bot-legacy.mjs), sides swapped. (bare numbers = ab, back-compat)
//
// WHY THE AUDIT MODE EXISTS
// The tag histogram in test-bot-tricks-fire.mjs counts INTENT (`bm.lastTrick`, set by the branch that
// decided to do the thing). Intent is not behaviour: the deleted `carryJump` set its intent tag on
// every commit while the sim produced ZERO bombs, because sim.js:840 gates the plant on `!carrying`.
// So a tag count can read healthy while the trick is physically impossible. Everything below is read
// out of the SIM instead — p.stat (which sim.js increments at the actual event sites), ball-ownership
// transitions, bomb detonations and bush occupancy — so a count of 0 here means the behaviour did not
// happen, no matter what any branch believed it was doing.
import { createState, addPlayer, attachBall, step, makeRng } from './shared/sim.js';
import {
  DT, FIELD, MATCH_DURATION, BOMB, BOMB_CENTER_R, BOMB_WALL_DIST, BOMB_WALL_COS,
  BOMB_CENTER_LAUNCH_MUL, BOMB_STACK_PER, BOMB_COMBINE_RADIUS, BOMB_WALL_CANNON_STATIC,
} from './shared/constants.js';
import { computeBotInputs, createBotMemory, bmemForTest } from './shared/bot-ai.js';
import { pointInBush, nearestOnWall, ARENA } from './shared/arena.js';
import { DIFFICULTY_LEVELS, levelAt } from './shared/difficulty.js';

// ======================= BEHAVIOUR AUDIT =============================================
// One counter set per SIDE of a match. `partner` is the side a human would share (the level's
// `partner` skill), `enemy` is the all-bot opposition (`enemy` skill) — they are different skills at
// most levels, and the user's complaint has always been about both halves ("the enemy is dumb" /
// "my team-mate does nothing"), so they are never averaged together.
const zero = () => ({
  bullets: 0, kicks: 0, strips: 0, walls: 0, bombs: 0,
  bombsNearWall: 0, wallBackedLaunch: 0, cannonChance: 0, cannonTaken: 0, rocketJumps: 0,
  passes: 0, turnovers: 0, bushEnters: 0, bushTicks: 0, ambushTicks: 0,
  goals: 0, ticks: 0,
});

// Mirror of sim.js wallCannonMul's GEOMETRIC test (not its multiplier): is a wall close enough
// BEHIND the launch to boost it? Duplicated on purpose — the harness must be able to say "the sim
// would have cannoned this launch" without the sim exporting anything, and if the rule in sim.js
// ever changes this copy failing to agree is exactly the signal we want.
function wallBacks(state, bx, by, dx, dy) {
  const walls = ARENA.walls.concat(state.builtWalls || []);
  for (const w of walls) {
    const np = nearestOnWall(w, bx, by);
    const vx = np.x - bx, vy = np.y - by, d = Math.hypot(vx, vy);
    if (d < 1 || d > BOMB_WALL_DIST) continue;
    if ((vx / d) * (-dx) + (vy / d) * (-dy) > BOMB_WALL_COS) return true;
  }
  return false;
}
// COULD this launch have been cannoned at all? The absolute wall-boost rate is capped by arena
// geometry (measured: only 6.3% of bot positions have a wall behind a feet plant, 10.4% allowing a
// lob-back, 16.2% allowing +-20deg of flight rotation), so "X% of launches were boosted" cannot be
// pushed arbitrarily high. The honest question is the CONVERSION: when a wall was usable, did the bot
// use it? This mirrors the levers bot-ai's cannonPlant actually has.
// Mirrors bot-ai's cannonPlant candidate set AND its acceptance rule — including the ROT_MIN_MUL
// clause, so a "chance" the bot deliberately declines (twisting its flight line 20deg for a 1.05x
// nothing) is not scored against it. Without that clause the conversion metric punishes correct policy.
const LOBS = [0, 35, 60, 85], ROTS = [0, 0.175, -0.175, 0.349, -0.349], ROT_MIN_MUL = 1.15;
function cannonWasAvailable(state, px, py, dx, dy) {
  for (const rot of ROTS) {
    const cs = Math.cos(rot), sn = Math.sin(rot);
    const ax = dx * cs - dy * sn, ay = dx * sn + dy * cs;
    for (const L of LOBS) {
      const bx = px - ax * L, by = py - ay * L;
      if (bx < 24 || bx > FIELD.W - 24 || by < 24 || by > FIELD.H - 24) continue;
      if (!wallBacks(state, bx, by, ax, ay)) continue;
      if (rot !== 0 && cannonMulOf(state, bx, by, ax, ay) < ROT_MIN_MUL) continue;
      return true;
    }
  }
  return false;
}
// Mirror of sim.js wallCannonMul's VALUE for static stone (peak BOMB_WALL_CANNON_STATIC).
function cannonMulOf(state, bx, by, dx, dy) {
  let mul = 1;
  for (const w of ARENA.walls) {
    const np = nearestOnWall(w, bx, by);
    const vx = np.x - bx, vy = np.y - by, d = Math.hypot(vx, vy);
    if (d < 1 || d > BOMB_WALL_DIST) continue;
    if ((vx / d) * -dx + (vy / d) * -dy > BOMB_WALL_COS) {
      const m = 1 + (1 - d / BOMB_WALL_DIST) * (BOMB_WALL_CANNON_STATIC - 1);
      if (m > mul) mul = m;
    }
  }
  return mul;
}
function nearestWallDist(state, x, y) {
  let best = 1e9;
  for (const w of ARENA.walls.concat(state.builtWalls || [])) {
    const np = nearestOnWall(w, x, y);
    const d = Math.hypot(x - np.x, y - np.y) - (np.rad || 0);
    if (d < best) best = d;
  }
  return best;
}

// Run ONE match with `skA` on team A and `skB` on team B, both all-bot, and return the two
// counter sets keyed by team. Seeded through state.rng so a re-measurement is comparable.
export function measureMatch(skA, skB, secs, seed, startTeam = 'A') {
  const TICKS = Math.round(Math.min(secs, MATCH_DURATION - 5) / DT);
  const state = createState();
  state.resetTimer = 0;
  state.rng = makeRng(seed);
  for (const [id, team, slot] of [['A0', 'A', 0], ['A1', 'A', 1], ['B0', 'B', 0], ['B1', 'B', 1]])
    addPlayer(state, id, { name: id, char: 'player', team, slot, isBot: true });
  // Kickoff possession is an EXPLICIT parameter, never derived from the seed. Deriving it from
  // `seed % 2` while the caller also alternated sides on the same index silently correlated the two,
  // so one measured side always kicked off: at L0 (identical skills on both sides) that alone
  // produced 1.04 goals/match vs 0.13 and 1.58 walls/match vs 0.13.
  attachBall(state, startTeam);
  const mem = createBotMemory(0.5);
  mem.teamSkill = { A: skA, B: skB };

  const ids = ['A0', 'A1', 'B0', 'B1'];
  const out = { A: zero(), B: zero() };
  const inBush = {};                          // per-bot bush occupancy, for enter EDGES
  for (const id of ids) inBush[id] = pointInBush(state.players[id].x, state.players[id].y);
  let seenBombs = new Set();
  const plants = new Map();                   // bombId -> the DECISION recorded at plant time
  let prevOwner = state.ball.owner;
  let pendingKicker = null;                   // who last VOLUNTARILY released the ball
  let errs = 0;

  for (let t = 0; t < TICKS; t++) {
    // ---- pre-step: which bombs detonate THIS tick, and would the sim cannon their launch? ----
    // updateBombs (sim.js:966) runs after the movement loop, so the launch is applied to the
    // POST-move position; pre-step is within a few px of it, which only matters inside the 6px
    // dead-centre fallback that a 52px bombHold offset never reaches.
    const fusing = [];
    for (const bomb of state.bombs) {
      if (bomb.fuse - DT > 0) continue;
      const o = state.players[bomb.owner];
      if (!o) continue;
      const rd = Math.hypot(o.x - bomb.x, o.y - bomb.y);
      if (rd >= BOMB_CENTER_R) continue;                      // not an on-centre self-launch at all
      const [dx, dy] = rd > 6 ? [(o.x - bomb.x) / rd, (o.y - bomb.y) / rd]
                              : [o.aimX, o.aimY];             // sim.js explode(): dead-centre uses the look dir
      let stack = 1;
      for (const q of state.bombs) if (q.id !== bomb.id && Math.hypot(q.x - bomb.x, q.y - bomb.y) <= BOMB_COMBINE_RADIUS) stack++;
      fusing.push({
        owner: bomb.owner, id: bomb.id,
        kvx: o.kvx || 0, kvy: o.kvy || 0,
        base: state.settings.bombPower * (1 + (stack - 1) * BOMB_STACK_PER) * BOMB_CENTER_LAUNCH_MUL,
      });
    }

    let inputs = {};
    try { inputs = computeBotInputs(state, mem, DT); }
    catch (e) { errs++; if (errs <= 2) console.error('AI ERROR:', e.message); }
    try { step(state, inputs, DT); }
    catch (e) { errs++; console.error('SIM ERROR:', e.message); break; }

    // ---- post-step: did the launch actually happen, and was it boosted? ----
    for (const f of fusing) {
      const o = state.players[f.owner];
      if (!o) continue;
      const d = Math.hypot((o.kvx || 0) - f.kvx, (o.kvy || 0) - f.kvy);
      if (d < 60) continue;                                   // jumpBlocked, or no launch
      out[o.team].rocketJumps++;
      const pl = plants.get(f.id);
      // "flew further" is the OUTCOME, so it is measured off the impulse, not off the intent:
      // > 3% above the un-cannoned base means a wall (or a stack) actually boosted this jump.
      const boosted = d > f.base * 1.03;
      if (boosted) out[o.team].wallBackedLaunch++;
      // THREE counters, because the obvious two do not form a ratio and a challenger caught this
      // reading >100% (a row printed 2 boosted of 1 "chance"). wallBackedLaunch counts a boost on ANY
      // plant — including a tackle-steal, which cannonChance deliberately never considers — so it is
      // NOT a subset of cannonChance and `boosted / chance` is not a rate. cannonTaken is the
      // numerator that IS inside the denominator, so cannonTaken/cannonChance is bounded [0,1] by
      // construction. Read them as two different questions:
      //   cannonTaken / cannonChance  = of the chances the bot's OWN mirror saw, how many paid off.
      //     This is an AGREEMENT rate between cannonWasAvailable and the sim, not "did the bot try":
      //     a feet plant with a wall already behind it scores here without the bot deciding anything,
      //     which is why HEAD (no lob-back at all) still reads 50% on it. It cannot carry the fix.
      //   wallBackedLaunch / rocketJumps = the absolute rate, i.e. what a player actually sees.
      //     This is the load-bearing number: 5% at HEAD -> 13% now, against a 6.3% do-nothing floor.
      if (pl && pl.mobility && pl.avail) {
        out[o.team].cannonChance++;
        if (boosted) out[o.team].cannonTaken++;
      }
    }

    // ---- new bombs: record the DECISION, judged at the moment it was made ----
    // Availability has to be evaluated HERE, not at detonation: the planter edges ~50-80px along its
    // flight line during the 1.725s fuse, so scoring the counterfactual from the detonation-time
    // position asks a different question than the one the bot answered.
    for (const bomb of state.bombs) {
      if (seenBombs.has(bomb.id)) continue;
      seenBombs.add(bomb.id);
      const o = state.players[bomb.owner];
      if (!o) continue;
      if (nearestWallDist(state, bomb.x, bomb.y) <= BOMB_WALL_DIST) out[o.team].bombsNearWall++;
      // bm.bombHold.aimX/aimY is the point the planter will edge toward, i.e. its intended FLIGHT
      // line; targetId marks a tackle-steal, where the plant position is dictated by the victim and
      // the wall-cannon is deliberately NOT wanted (relocating a tackle plant measured 0% steals).
      const bh = bmemForTest(mem, bomb.owner).bombHold;
      let avail = false, mobility = false;
      if (bh) {
        mobility = !bh.targetId;
        const fx = bh.aimX - o.x, fy = bh.aimY - o.y, fl = Math.hypot(fx, fy);
        if (mobility && fl > 1) avail = cannonWasAvailable(state, o.x, o.y, fx / fl, fy / fl);
      }
      plants.set(bomb.id, { mobility, avail });
    }

    // ---- ball-ownership transitions: a kick whose next owner is a TEAM-MATE is a completed pass ----
    const b = state.ball;
    if (prevOwner && !b.owner) {
      // b.lastKicker is set ONLY by the voluntary-release path (sim.js:797); every involuntary loss
      // (bullet strip, bomb blast, walked-into-a-wall pop, dribble-in) runs clearKick first, which
      // nulls it. So this is the exact discriminator between "the bot let go" and "the bot lost it".
      pendingKicker = b.lastKicker;
      if (pendingKicker && state.players[pendingKicker]) out[state.players[pendingKicker].team].kicks++;
    } else if (!b.owner && b.lastKicker) pendingKicker = b.lastKicker;
    if (!prevOwner && b.owner && pendingKicker) {
      const from = state.players[pendingKicker], to = state.players[b.owner];
      if (from && to && from.id !== to.id) (from.team === to.team ? out[from.team].passes++ : out[from.team].turnovers++);
      pendingKicker = null;
    }
    prevOwner = b.owner;

    // ---- bushes: entry EDGES, dwell, and dwell that is actually an AMBUSH (hidden, off-ball,
    //      with an enemy carrier live) rather than a bot merely walking across the centre bush ----
    if (state.resetTimer <= 0) {
      const carrier = b.owner ? state.players[b.owner] : null;
      for (const id of ids) {
        const p = state.players[id];
        const now = pointInBush(p.x, p.y);
        const s = out[p.team];
        s.ticks++;
        if (now && !inBush[id]) s.bushEnters++;
        if (now) { s.bushTicks++; if (carrier && carrier.team !== p.team && b.owner !== id) s.ambushTicks++; }
        inBush[id] = now;
      }
    }
  }

  // p.stat is incremented by sim.js at the real event sites (fireBullet / useSpecial / buildWall /
  // bulletStripCarrier / resolveSuperBodyStrip), so these are events, never intents.
  for (const id of ids) {
    const p = state.players[id], s = out[p.team];
    s.bullets += p.stat.shots; s.bombs += p.stat.bombs; s.walls += p.stat.walls; s.strips += p.stat.strips;
    s.goals += p.stat.goals;
  }
  out.errs = errs;
  return out;
}

const add = (dst, src) => { for (const k in src) if (typeof src[k] === 'number') dst[k] = (dst[k] || 0) + src[k]; };

// Measure one DIFFICULTY LEVEL: team A carries the level's `partner` skill (the side a human
// shares) and team B its `enemy` skill. Returns { partner, enemy } counter sets.
// SIDES ARE SWAPPED every other match. Team A attacks +x and B attacks -x, and the two are NOT
// interchangeable in practice (kickoff spawns, slot-based outlet offsets, which team the seed hands
// the ball to), so a fixed assignment leaks a side bias into every counter: measured at L0, where
// both sides carry the identical 0.05 skill, a fixed A=partner run reported 0.88 goals/match for the
// partner side and 0.00 for the enemy side. Alternating cancels it.
export function measureLevel(levelId, matches = 8, secs = 70, seedBase = 4100) {
  const L = levelAt(levelId);
  const partner = zero(), enemy = zero();
  let errs = 0;
  for (let i = 0; i < matches; i++) {
    const flip = i % 2 === 1;                                 // which TEAM carries the partner skill
    const pTeam = flip ? 'B' : 'A';
    const start = (Math.floor(i / 2) % 2 === 0) ? pTeam : (pTeam === 'A' ? 'B' : 'A'); // who KICKS OFF — varied independently
    const r = measureMatch(flip ? L.enemy : L.partner, flip ? L.partner : L.enemy, secs, seedBase + levelId * 977 + i * 31, start);
    add(partner, flip ? r.B : r.A); add(enemy, flip ? r.A : r.B); errs += r.errs;
  }
  return { level: L, matches, secs, partner, enemy, errs };
}

// The five tricks the user actually named, each mapped to the SIM-OBSERVED counter that proves it.
const TRICKS = [
  ['bomb correctly',              (s) => s.bombs],
  ['hide in bushes',              (s) => s.ambushTicks],
  ['pass to each other',          (s) => s.passes],
  ['build walls',                 (s) => s.walls],
  ['bomb near a wall (fly far)',  (s) => s.wallBackedLaunch],
];

const COLS = [
  ['bullets', 'shots'], ['kicks', 'kicks'], ['strips', 'strips'], ['walls', 'walls'],
  ['bombs', 'bombs'], ['bombsNearWall', 'bmb@wall'], ['wallBackedLaunch', 'cannon'],
  ['cannonChance', 'chance'], ['cannonTaken', 'took'], ['rocketJumps', 'rockets'], ['passes', 'pass✓'], ['turnovers', 'lost'],
  ['bushEnters', 'bushIn'], ['ambushTicks', 'ambushTk'], ['goals', 'goals'],
];

function behaveMode(matches, secs, levels) {
  console.log(`\n=== BEHAVIOUR AUDIT — ${matches} matches x ${secs}s per level, per-match averages ===`);
  console.log('(SIM-OBSERVED events, not intent tags. "kicks" = voluntary ball releases; "pass✓" = a kick a');
  console.log(' team-mate collected; "cannon" = a rocket-jump the sim actually boosted off a wall behind it.)\n');
  const head = ['lvl', 'side', 'skill', ...COLS.map(([, h]) => h)];
  const rows = [head];
  const all = {};
  for (const id of levels) {
    const r = measureLevel(id, matches, secs);
    all[id] = r;
    for (const [side, key] of [['partner', 'partner'], ['enemy', 'enemy']]) {
      const s = r[side];
      rows.push([`L${id}`, side, r.level[key].toFixed(2),
        ...COLS.map(([k]) => (s[k] / matches).toFixed(k === 'ambushTicks' || k === 'bushTicks' ? 0 : 2))]);
    }
  }
  const w = head.map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  for (const r of rows) console.log('  ' + r.map((c, i) => String(c).padStart(w[i])).join(' '));

  console.log('\n--- the five user-named tricks: does the behaviour EXIST in the sim? ---');
  let dead = 0;
  for (const [name, get] of TRICKS) {
    const per = levels.map((id) => `L${id} ${get(all[id].partner)}/${get(all[id].enemy)}`).join('  ');
    const total = levels.reduce((a, id) => a + get(all[id].partner) + get(all[id].enemy), 0);
    if (total === 0) dead++;
    console.log(`  ${total === 0 ? 'DEAD ' : 'live '} ${name.padEnd(28)} (partner/enemy)  ${per}`);
  }
  const errs = levels.reduce((a, id) => a + all[id].errs, 0);
  console.log(`\n  ai/sim errors: ${errs}`);
  console.log(dead === 0 && errs === 0 ? '\n✅ every named trick fires somewhere' : `\n❌ ${dead} DEAD behaviour(s)${errs ? ` + ${errs} errors` : ''}`);
  return dead === 0 && errs === 0;
}

// ======================= A/B: NEW vs LEGACY (unchanged behaviour) =====================
async function abMode(MATCHES, SECS) {
  const { legacyInputs } = await import('./bot-legacy.mjs');
  const TICKS = Math.round(SECS / DT);
  function runMatch(newTeam) {
    const legacyTeam = newTeam === 'A' ? 'B' : 'A';
    const state = createState();
    state.resetTimer = 0;
    for (const [id, team, slot] of [['A0', 'A', 0], ['A1', 'A', 1], ['B0', 'B', 0], ['B1', 'B', 1]])
      addPlayer(state, id, { name: id, char: 'player', team, slot, isBot: true });
    attachBall(state, Math.random() < 0.5 ? 'A' : 'B');
    const memNew = createBotMemory('normal');
    const memLeg = {};
    const m = { newGoals: 0, legGoals: 0, poss: { new: 0, leg: 0 }, bothChaseNew: 0, bothChaseLeg: 0,
      playTicks: 0, shots: 0, bombs: 0, builds: 0, err: 0, moved: { A0: 0, A1: 0, B0: 0, B1: 0 } };
    const prev = {}; for (const id of ['A0', 'A1', 'B0', 'B1']) prev[id] = { x: state.players[id].x, y: state.players[id].y };
    for (let t = 0; t < TICKS; t++) {
      let inputs = {};
      try {
        const ai = computeBotInputs(state, memNew, DT, { onlyTeam: newTeam });
        const lg = legacyInputs(state, memLeg);
        for (const id in ai) inputs[id] = ai[id];
        for (const id in lg) if (state.players[id] && state.players[id].team === legacyTeam) inputs[id] = lg[id];
      } catch (e) { m.err++; if (m.err <= 2) console.error('AI ERROR:', e.message); }
      // computeBotInputs emits { hold, fire, ... } — there has never been a `shoot` key, so this
      // counter silently read 0 for every run the harness did before 2026-07-26. `fire` is the RELEASE.
      for (const id in inputs) {
        if (state.players[id] && state.players[id].team === newTeam) {
          if (inputs[id].fire) m.shots++; if (inputs[id].special) m.bombs++; if (inputs[id].build) m.builds++;
        }
      }
      const before = { A: state.score.A, B: state.score.B };
      try { step(state, inputs, DT); } catch (e) { m.err++; if (m.err <= 2) console.error('SIM ERROR:', e.message); break; }
      if (state.score.A > before.A) (newTeam === 'A' ? m.newGoals++ : m.legGoals++);
      if (state.score.B > before.B) (newTeam === 'B' ? m.newGoals++ : m.legGoals++);
      if (state.resetTimer <= 0) {
        m.playTicks++;
        const b = state.ball;
        const focus = b.owner && state.players[b.owner] ? state.players[b.owner] : b;
        if (b.owner) { const o = state.players[b.owner]; if (o) (o.team === newTeam ? m.poss.new++ : m.poss.leg++); }
        for (const team of ['A', 'B']) {
          const bots = Object.values(state.players).filter((p) => p.team === team);
          if (bots.length === 2 && bots.every((p) => Math.hypot(focus.x - p.x, focus.y - p.y) < 260)) {
            (team === newTeam ? m.bothChaseNew++ : m.bothChaseLeg++);
          }
        }
        for (const id of ['A0', 'A1', 'B0', 'B1']) { const p = state.players[id]; m.moved[id] += Math.hypot(p.x - prev[id].x, p.y - prev[id].y); prev[id] = { x: p.x, y: p.y }; }
      }
    }
    return m;
  }
  const agg = { newGoals: 0, legGoals: 0, possNew: 0, possLeg: 0, bothNew: 0, bothLeg: 0, playTicks: 0, shots: 0, bombs: 0, builds: 0, err: 0, stuck: 0, wins: 0, losses: 0, draws: 0 };
  for (let i = 0; i < MATCHES; i++) {
    const newTeam = i % 2 === 0 ? 'A' : 'B';
    const m = runMatch(newTeam);
    agg.newGoals += m.newGoals; agg.legGoals += m.legGoals;
    agg.possNew += m.poss.new; agg.possLeg += m.poss.leg;
    agg.bothNew += m.bothChaseNew; agg.bothLeg += m.bothChaseLeg;
    agg.playTicks += m.playTicks; agg.shots += m.shots; agg.bombs += m.bombs; agg.builds += m.builds; agg.err += m.err;
    if (m.newGoals > m.legGoals) agg.wins++; else if (m.newGoals < m.legGoals) agg.losses++; else agg.draws++;
    const newIds = newTeam === 'A' ? ['A0', 'A1'] : ['B0', 'B1'];
    for (const id of newIds) if (m.moved[id] < 4000) agg.stuck++;
  }
  const pctPoss = agg.possNew + agg.possLeg > 0 ? (100 * agg.possNew / (agg.possNew + agg.possLeg)).toFixed(0) : '0';
  console.log(`\n=== ${MATCHES} matches × ${SECS}s (NEW vs LEGACY, sides swapped) ===`);
  console.log(`GOALS      NEW ${agg.newGoals}  —  ${agg.legGoals} LEGACY`);
  console.log(`MATCHES    NEW win ${agg.wins} / draw ${agg.draws} / loss ${agg.losses}`);
  console.log(`POSSESSION NEW ${pctPoss}%`);
  console.log(`BOTH-CHASE (lower=better coordination)  NEW ${(100 * agg.bothNew / (agg.playTicks || 1)).toFixed(1)}%  vs  LEGACY ${(100 * agg.bothLeg / (agg.playTicks || 1)).toFixed(1)}%`);
  console.log(`NEW tools  shots ${agg.shots}  bombs ${agg.bombs}  builds ${agg.builds}`);
  console.log(`ROBUST     ai/sim errors ${agg.err}  stuck-bot-matches ${agg.stuck}`);
  const pass = agg.err === 0 && agg.stuck === 0 && agg.newGoals >= agg.legGoals && agg.wins >= agg.losses && agg.bombs > 0 && agg.builds > 0;
  console.log(pass ? '\n✅ EVAL PASS (new ≥ legacy, coordinated, uses tools, robust)' : '\n❌ EVAL NEEDS WORK');
  return pass;
}

// ---- CLI (only when run directly; the tests import measureLevel/measureMatch) ----
if (process.argv[1] && /bot-eval\.mjs$/.test(process.argv[1])) {
  const a2 = process.argv[2] || 'behave';
  const isAb = a2 === 'ab' || /^\d+$/.test(a2);
  const nums = process.argv.slice(/^\d+$/.test(a2) ? 2 : 3).filter((s) => /^\d+$/.test(s)).map(Number);
  let pass;
  if (isAb) pass = await abMode(nums[0] || 30, Math.min(nums[1] || 70, MATCH_DURATION - 5));
  else {
    const levels = process.argv.includes('--all') ? DIFFICULTY_LEVELS.map((l) => l.id) : [0, 5, 8, 11];
    pass = behaveMode(nums[0] || 8, nums[1] || 70, levels);
  }
  process.exit(pass ? 0 : 1);
}
