// bot-noise.mjs — AN INSTRUMENT THAT MEASURES THE LADDER INSTRUMENT, not the bots.
//
// WHY THIS FILE EXISTS. `test-bot-ladder.mjs` asks "does the 0..1 skill axis RANK?" by playing 5
// anchors against a fixed t=0.50 reference and comparing GOAL DIFFERENTIAL. After round 7 it stopped
// being able to answer: rho 0.10, per-seed rho flipping sign (0.70 / 0.30 / 0.60 / -0.60 / -0.50 /
// 0.10) and — decisively — its own HARNESS ZERO-CHECK (the t=0.50 anchor against its own mirror,
// where the true answer is 0.00 by construction) reading 0.16-0.18 against a +-0.15 tolerance.
// A test whose null cell reads 0.16 cannot resolve a 0.1-0.2 goals/match effect. That is not a bot
// bug and it is not fixable by tuning bots; it is a SAMPLE SIZE / ESTIMATOR problem.
//
// So this file does three things and gates NOTHING:
//   1. NOISE FLOOR — plays the null configuration (t=0.50 vs t=0.50) many times and reports the
//      per-match SD, the standard error vs matches-per-anchor, and the wall-clock each costs.
//   2. CANDIDATE STATISTICS — records 13 per-match statistics (goals, territory, thirds, clear
//      shots on target, xG, ground gained, strips, ...) so the same matches can be scored by all of
//      them, and reports for each: per-seed-base Spearman rho across the anchors, the pooled rho,
//      the top-bottom spread, its reading in the NULL cell, and spread / SE (its signal-to-noise).
//   3. PAIRING — the current cell gives every match its own seed. Two cheap variance reductions are
//      measurable here: MIRRORED QUADS (`PAIR=quad`: one seed shared by all four side x kickoff
//      combinations, so a scenario's own luck cancels inside the quad) and COMMON RANDOM NUMBERS
//      across anchors (`CRN=1`: drop `Math.round(skill*100)` from the seed so every anchor faces the
//      SAME seed set instead of a private stream).
//
// It is a two-stage instrument on purpose: `collect` writes one JSON row per match, `analyze` reads
// rows back. A 60s match costs 0.27s serially (0.71s each when 24 processes share 16 cores), so
// nothing may require re-running matches to ask a second question, and long runs shard across cores
// by seed base. 9600 matches took 8 minutes wall on 24 processes.
//
// ============================ WHAT IT MEASURED (2026-07-26, 13,440 matches) ===================
// Against `git archive HEAD shared` at bot-ai `2d7e689` (round 7 + patience), default arena, 60s.
// VALIDATION: at bases 1000-6000 with the old per-anchor seed this file reproduces the recorded
// ladder run digit for digit — rho 0.10, spread 0.11, zero-check 0.16, per-base rho
// 0.70/0.30/0.60/-0.60/-0.50/0.10 — so it is measuring the real harness, not a lookalike.
//   * NOISE FLOOR: per-match goal differential SD 1.78; null cell +0.02 +-0.05 over 1536 matches, so
//     the harness is UNBIASED. Cell SE = 1.78/sqrt(n): 0.31 at SEEDS=1, 0.13 at SEEDS=6, 0.05 at
//     SEEDS=36. Resolving 0.10 goals/match at 2 sigma needs n=1248/anchor (SEEDS=39).
//   * The ladder's old `+-0.15` zero-check was a 1.2-SE tolerance — a ~24%-failure coin flip. Re-based
//     in test-bot-ladder.mjs to 3 SE, printed.
//   * At n=1152 the anchors read -0.48 / -0.49 / +0.06 / -0.49 / -0.29 (+-0.05): the axis is
//     NON-MONOTONE (t=0.82 is a trough at 7.5 sigma), replicated on 3 independent seed schemes. No
//     sample size fixes that; it is a bot question.
//   * Of 16 candidate statistics only strips (rho 1.00, 36/36 bases) and time-to-first-shot (1.00,
//     36/36) are stable — and both are near-direct readouts of a skill-vector key (toolSkill/react,
//     chargeRate), so they cannot fail for the reason anyone cares about. The best ATTACKING
//     companions are shots-on-goal (goals + saves forced; 6.0 sigma vs goals' 3.0) and xG (4.4);
//     the territory family (territory/thirds/danger zone/entries) is PRECISE and does not rank,
//     which is a result about the bots, not a failed candidate.
//   * PAIRING: common random numbers across anchors = x2.0 equivalent sample on every goal-family
//     statistic (gap SD 0.410 -> 0.287) and is now applied in test-bot-ladder.mjs. Antithetic
//     quadruples are WORSE (x0.5-0.6) and their exact 0.00 in the null cell is an arithmetic
//     identity that tests nothing. Full write-up: summery/BOT_HANDOFF.md §00000b.
// ==============================================================================================
//
//   node bot-noise.mjs collect > rows.jsonl          # env below
//   node bot-noise.mjs analyze rows.jsonl [more...]  # every table, from rows only
//
// collect env:
//   ANCHORS=0.05,0.25,0.50,0.82,1.00   which skills to play against the REF
//   REF=0.50   PER=32 (multiple of 4)  SECS=60
//   BASE0=1000 BASES=6 BSTEP=1000      seed bases (independent RNG streams)
//   PAIR=loose|quad                    loose = today's per-match seed; quad = mirrored quadruples
//   CRN=0|1                            0 = today's per-anchor seed; 1 = common random numbers
//   ARENA=default|main                 `main` = the arena the game ships (test-bot-ladder default is `default`)
//   TAG=name                           label carried on every row, so analyze can compare schemes
import { createState, addPlayer, attachBall, step, makeRng, setField } from './shared/sim.js';
import { MAIN_FIELD } from './shared/main-field.js';
import { ARENA, nearestOnWall } from './shared/arena.js';
import { DT, FIELD, GOAL, BALL_RADIUS, CHARACTERS } from './shared/constants.js';
import { computeBotInputs, createBotMemory } from './shared/bot-ai.js';

const MODE = process.argv[2] || 'analyze';

// ---------------------------------------------------------------- shared math
function spearman(xs, ys) {
  const rank = (a) => { const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = new Array(a.length); idx.forEach(([, i], k) => { r[i] = k; }); return r; };
  const rx = rank(xs), ry = rank(ys), n = xs.length;
  let d2 = 0; for (let i = 0; i < n; i++) d2 += (rx[i] - ry[i]) ** 2;
  return 1 - (6 * d2) / (n * (n * n - 1));
}
const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
function sd(a) { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); }

// ============================================================== COLLECT ======
const GOAL_TOP = (FIELD.H - GOAL.width) / 2;
const GOAL_BOTTOM = (FIELD.H + GOAL.width) / 2;
const PR = CHARACTERS.player.radius;
const THIRD = FIELD.W / 6;          // a third of the pitch measured from the centre line
const FIN = 450;                    // "finishing range" — inside this the shot is a chance, not a punt
                                    // (the penalty area is 360 deep; a FULL-power kick only rolls 647px)
const REAL_KICK = 300;              // px/s: above a dribble tap (155) and above the super quick kick
const ROLL_PER_SPEED = 0.468;       // px of roll per px/s of launch speed (BALL_FRICTION/BALL_MIN_SPEED)

// Does the straight segment a->b hit a wall or an enemy body? Deliberately implemented HERE and not
// imported from bot-ai.js: the instrument must not share geometry code with the thing it measures
// (and bot-ai.js is under other agents' edits).
function segHitsCircle(ax, ay, bx, by, cx, cy, r) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
  let t = ((cx - ax) * dx + (cy - ay) * dy) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const px = ax + dx * t, py = ay + dy * t;
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
}
function segHitsWall(w, ax, ay, bx, by, margin) {
  // sample the segment; walls here are 120px boxes / capsules, so a 24px step cannot skip one
  const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
  const steps = Math.max(2, Math.ceil(len / 24));
  for (let i = 0; i <= steps; i++) {
    const x = ax + dx * i / steps, y = ay + dy * i / steps;
    const np = nearestOnWall(w, x, y);
    if (Math.hypot(x - np.x, y - np.y) - (np.rad || 0) <= margin) return true;
  }
  return false;
}
function laneBlocked(s, ax, ay, bx, by, enemyTeam) {
  const walls = (s.arena ? s.arena.walls : ARENA.walls).concat(s.builtWalls || []);
  for (const w of walls) if (segHitsWall(w, ax, ay, bx, by, BALL_RADIUS)) return true;
  for (const id in s.players) {
    const p = s.players[id];
    if (p.team !== enemyTeam) continue;
    if (segHitsCircle(ax, ay, bx, by, p.x, p.y, PR + BALL_RADIUS)) return true;
  }
  return false;
}

// One match: `skill` on team `side`, REF on the other, `kickTo` says which of the two kicks off.
// The sim/bot setup is a byte-for-byte copy of test-bot-ladder.mjs's `match()` so the numbers here
// describe THAT harness. Everything after `step` is measurement only.
function playMatch(skill, ref, side, kickTo, seed, ticks, useMain) {
  const s = createState();
  s.resetTimer = 0;
  if (useMain) setField(s, MAIN_FIELD);
  s.rng = makeRng(seed);
  const other = side === 'A' ? 'B' : 'A';
  for (const [id, team, slot] of [['A0', 'A', 0], ['A1', 'A', 1], ['B0', 'B', 0], ['B1', 'B', 1]])
    addPlayer(s, id, { name: id, char: 'player', team, slot, isBot: true });
  attachBall(s, kickTo === 'skill' ? side : other);
  const mem = createBotMemory(ref);
  mem.teamSkill = { [side]: skill, [other]: ref };

  const dirM = side === 'A' ? 1 : -1;                 // measured team attacks +x when it is A
  const goalX = { M: dirM > 0 ? FIELD.W : 0, O: dirM > 0 ? 0 : FIELD.W };
  const teamOf = (id) => (s.players[id] && s.players[id].team === side ? 'M' : 'O');
  const Z = () => ({ M: 0, O: 0 });
  const live = { n: 0 }, terr = { sum: 0 }, third = Z(), poss = Z(), rel = Z(), sot = Z(), sotIn = Z();
  const xg = Z(), gain = Z(), gainN = Z(), ent = Z(), t2s = Z(), t2sN = Z(), radv = Z(), radvN = Z();
  const fire = Z(), miss = Z(), dz = Z();
  let looseTicks = 0;
  let owner = null, ownTeam = null, possStartAdv = 0, possStartTick = 0, possShot = false;
  let pendRel = null;                                  // a release whose settle we are still waiting for
  const adv = () => (s.ball.x - FIELD.W / 2) * dirM;   // + = ball is in the measured team's attacking half
  let prevAdv = adv();

  for (let t = 0; t < ticks; t++) {
    const inp = computeBotInputs(s, mem, DT);
    // count the ladder's own `shots/m` (fire TICKS, not shot events) so it stays comparable
    for (const id in inp) if (inp[id] && inp[id].fire) fire[teamOf(id)]++;
    // a RELEASE = the carrier fires. Snapshot before the step; classify from the post-step ball.
    let relBy = null;
    for (const id in inp) if (inp[id] && inp[id].fire && s.ball.owner === id) relBy = id;
    const relX = s.ball.x, relY = s.ball.y;

    step(s, inp, DT);

    if (relBy) {
      const tm = teamOf(relBy);
      const spd = Math.hypot(s.ball.vx, s.ball.vy);
      if (spd >= REAL_KICK) {                          // a real kick, not a dribble tap (155px/s)
        rel[tm]++;
        if (!possShot && ownTeam === tm) { t2s[tm] += (t - possStartTick) * DT; t2sN[tm]++; possShot = true; }
        const gx = goalX[tm];
        const vx = s.ball.vx, vy = s.ball.vy;
        const toGoal = (gx - relX);
        let counted = false;
        if (vx * toGoal > 0) {                         // aimed down the pitch at that goal at all
          const tt = toGoal / vx, yAt = relY + vy * tt;
          const d = Math.hypot(toGoal, (Math.min(Math.max(relY, GOAL_TOP), GOAL_BOTTOM)) - relY);
          const reach = ROLL_PER_SPEED * (spd - 18);   // friction: can this kick even get there? (full power = 647px)
          const onTarget = yAt > GOAL_TOP + 8 && yAt < GOAL_BOTTOM - 8;
          if (onTarget) {
            const clear = !laneBlocked(s, relX, relY, gx, yAt, tm === 'M' ? (side === 'A' ? 'B' : 'A') : side);
            // sot / sotIn are HARD events: on target, lane clear, and enough power to arrive.
            if (clear && d <= reach) { sot[tm]++; counted = true; if (d <= FIN) sotIn[tm]++; }
            // xg is the CONTINUOUS version of the same thing — it keeps the shots that fell short or
            // were half-blocked instead of throwing them away, which is the point of an xG model.
            xg[tm] += Math.exp(-d / 600) * (clear ? 1 : 0.2) * Math.min(1, reach / Math.max(1, d));
          }
        }
        if (!counted) miss[tm]++;
      }
      pendRel = { tm, x0: s.ball.x, at: t };
    }
    if (pendRel && (t - pendRel.at > 45 || s.ball.owner)) {   // where did that release leave the ball?
      const dir = pendRel.tm === 'M' ? dirM : -dirM;
      radv[pendRel.tm] += (s.ball.x - pendRel.x0) * dir; radvN[pendRel.tm]++;
      pendRel = null;
    }

    if (s.resetTimer > 0) { prevAdv = adv(); continue; }       // kickoff / goal freeze is not play
    live.n++;
    const a = adv();
    terr.sum += a;
    if (a > THIRD) third.M++; else if (a < -THIRD) third.O++;
    // DANGER ZONE: the ball inside finishing range of a goal mouth. Same family as territory but
    // measured where goals actually come from, and still one sample per tick.
    const by = Math.min(Math.max(s.ball.y, GOAL_TOP), GOAL_BOTTOM);
    if (Math.hypot(goalX.M - s.ball.x, by - s.ball.y) <= FIN) dz.M++;
    if (Math.hypot(goalX.O - s.ball.x, by - s.ball.y) <= FIN) dz.O++;
    if (s.ball.owner) {
      const tm = teamOf(s.ball.owner);
      poss[tm]++;
      // attacking-third ENTRY with the ball at your feet
      if (tm === 'M' && prevAdv <= THIRD && a > THIRD) ent.M++;
      if (tm === 'O' && prevAdv >= -THIRD && a < -THIRD) ent.O++;
    } else looseTicks++;
    // possession bookkeeping: a possession = one team holding, start to loss
    if (s.ball.owner !== owner) {
      if (ownTeam && (!s.ball.owner || teamOf(s.ball.owner) !== ownTeam)) {
        const dir = ownTeam === 'M' ? 1 : -1;
        gain[ownTeam] += (a - possStartAdv) * dir; gainN[ownTeam]++;
      }
      if (s.ball.owner) {
        const tm = teamOf(s.ball.owner);
        if (tm !== ownTeam) { possStartAdv = a; possStartTick = t; possShot = false; }
        ownTeam = tm;
      } else ownTeam = ownTeam && s.ball.owner ? ownTeam : null;
      owner = s.ball.owner;
      if (!owner) ownTeam = null;
    }
    prevAdv = a;
  }

  const strip = (tm) => Object.values(s.players)
    .filter((p) => (tm === 'M') === (p.team === side))
    .reduce((x, p) => x + ((p.stat && p.stat.strips) || 0), 0);
  const bull = (tm) => Object.values(s.players)
    .filter((p) => (tm === 'M') === (p.team === side))
    .reduce((x, p) => x + ((p.stat && p.stat.shots) || 0), 0);
  const save = (tm) => Object.values(s.players)
    .filter((p) => (tm === 'M') === (p.team === side))
    .reduce((x, p) => x + ((p.stat && p.stat.saves) || 0), 0);
  const per = (o, n, k) => (n[k] ? o[k] / n[k] : 0);
  return {
    gf: s.score[side], ga: s.score[other],
    terr: +(terr.sum / Math.max(1, live.n)).toFixed(1),
    a3: +(third.M * DT).toFixed(2), d3: +(third.O * DT).toFixed(2),
    zM: +(dz.M * DT).toFixed(2), zO: +(dz.O * DT).toFixed(2),
    kM: save('M'), kO: save('O'),
    pM: +(poss.M * DT).toFixed(2), pO: +(poss.O * DT).toFixed(2), loose: +(looseTicks * DT).toFixed(2),
    sM: strip('M'), sO: strip('O'), bM: bull('M'), bO: bull('O'),
    rM: rel.M, rO: rel.O, tM: sot.M, tO: sot.O, iM: sotIn.M, iO: sotIn.O,
    xM: +xg.M.toFixed(3), xO: +xg.O.toFixed(3),
    gM: +per(gain, gainN, 'M').toFixed(1), gO: +per(gain, gainN, 'O').toFixed(1),
    vM: +per(radv, radvN, 'M').toFixed(1), vO: +per(radv, radvN, 'O').toFixed(1),
    eM: ent.M, eO: ent.O,
    qM: +per(t2s, t2sN, 'M').toFixed(2), qO: +per(t2s, t2sN, 'O').toFixed(2),
    fM: fire.M, fO: fire.O, mM: miss.M, mO: miss.O,
  };
}

if (MODE === 'collect') {
  const ANCHORS = (process.env.ANCHORS || '0.05,0.25,0.50,0.82,1.00').split(',').map(Number);
  const REF = parseFloat(process.env.REF || '0.50');
  const PER = parseInt(process.env.PER || '32', 10);
  const SECS = parseInt(process.env.SECS || '60', 10);
  const BASE0 = parseInt(process.env.BASE0 || '1000', 10);
  const BASES = parseInt(process.env.BASES || '6', 10);
  const BSTEP = parseInt(process.env.BSTEP || '1000', 10);
  const PAIR = process.env.PAIR || 'loose';
  const CRN = process.env.CRN === '1';
  const useMain = process.env.ARENA === 'main';
  const TAG = process.env.TAG || `${PAIR}${CRN ? '+crn' : ''}${useMain ? '+main' : ''}`;
  if (PER % 4 !== 0) { console.error(`PER must be a multiple of 4 (got ${PER}) — side x kickoff balance`); process.exit(2); }
  const TICKS = Math.round(SECS / DT);
  for (let b = 0; b < BASES; b++) {
    const base = BASE0 + b * BSTEP;
    for (const t of ANCHORS) {
      for (let i = 0; i < PER; i++) {
        const side = i % 2 ? 'B' : 'A';
        const kickTo = (i >> 1) % 2 ? 'skill' : 'ref';
        // loose  = today's scheme: every match its own seed.
        // quad   = one seed per group of 4, so the same scenario is played in all four
        //          (side x kickoff) configurations — a mirrored/antithetic quadruple.
        const unit = PAIR === 'quad' ? (i >> 2) : i;
        const seed = base + unit * 17 + (CRN ? 0 : Math.round(t * 100));
        const t0 = process.hrtime.bigint();
        const r = playMatch(t, REF, side, kickTo, seed, TICKS, useMain);
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        process.stdout.write(JSON.stringify({ tag: TAG, t, base, i, q: i >> 2, side, kickTo, seed, secs: SECS, ms: +ms.toFixed(1), ...r }) + '\n');
      }
    }
  }
  process.exit(0);
}

// ============================================================== ANALYZE ======
// Every statistic is a per-match MEASURED-minus-REFERENCE differential, signed so that "more is a
// stronger attack". Statistics whose scale is per-match seconds/px are noted in the unit column.
const STATS = [
  ['goals    ', 'goals/match', (r) => r.gf - r.ga, 'TODAY\'S GATE: goal differential'],
  ['sonGoal  ', 'count', (r) => (r.gf + r.kO) - (r.ga + r.kM), 'goals PLUS keeper saves forced — every shot that arrived'],
  ['terr     ', 'px', (r) => r.terr, 'territory: mean ball position toward the enemy goal (zero-sum)'],
  ['third    ', 's', (r) => r.a3 - r.d3, 'ball-time in the attacking third minus the defensive third'],
  ['dangerZ  ', 's', (r) => r.zM - r.zO, 'ball-time within 450px of a goal mouth, theirs minus ours'],
  ['sot      ', 'shots', (r) => r.tM - r.tO, 'clear shots ON TARGET that could reach the goal'],
  ['sotIn    ', 'shots', (r) => r.iM - r.iO, 'the same, only from inside finishing range (700px)'],
  ['xg       ', 'xg', (r) => r.xM - r.xO, 'expected goals: on-target + lane clear, weighted exp(-d/600)'],
  ['shotAcc  ', 'frac', (r) => (r.tM / Math.max(1, r.tM + r.mM)) - (r.tO / Math.max(1, r.tO + r.mO)), 'fraction of real kicks that were clear shots on target'],
  ['gainPoss ', 'px', (r) => r.gM - r.gO, 'ground gained toward the enemy goal per possession'],
  ['advRel   ', 'px', (r) => r.vM - r.vO, 'ground the ball gains per RELEASE (bot-feel\'s advancePerRelease)'],
  ['entries  ', 'count', (r) => r.eM - r.eO, 'carries INTO the attacking third'],
  ['t2shot   ', 's', (r) => r.qO - r.qM, 'how much faster M shoots after winning the ball'],
  ['strips   ', 'strips', (r) => r.sM - r.sO, 'GATED TODAY as the secondary: strips'],
  ['poss     ', 's', (r) => r.pM - r.pO, 'possession time (known to rank BACKWARDS)'],
  ['fireTicks', 'ticks', (r) => r.fM - r.fO, 'the ladder\'s printed shots/m (inverted U by design)'],
];

if (MODE === 'analyze') {
  const files = process.argv.slice(3);
  if (!files.length) { console.error('usage: node bot-noise.mjs analyze rows.jsonl [more.jsonl ...]'); process.exit(2); }
  const fs = await import('node:fs');
  const rows = [];
  const MAXBASE = parseInt(process.env.MAXBASE || '0', 10);   // e.g. 6000 replays "what SEEDS=6 saw"
  for (const f of files) for (const line of fs.readFileSync(f, 'utf8').split('\n')) if (line.trim()) {
    const r = JSON.parse(line);
    if (!MAXBASE || r.base <= MAXBASE) rows.push(r);
  }
  const tags = [...new Set(rows.map((r) => r.tag))];
  const REF = 0.50;
  const secs = rows[0].secs, msPer = mean(rows.map((r) => r.ms));
  // ms/match as measured INSIDE this dataset is contention-inflated when the run was sharded across
  // cores. Pass SOLO_MS=<ms> (one process, measured) for the honest serial column.
  const soloMs = parseFloat(process.env.SOLO_MS || String(msPer));
  const pick = (tag, t, base) => rows.filter((r) => r.tag === tag && r.t === t && (base == null || r.base === base));
  // per-TAG anchor and base lists: several schemes with different base ranges are analysed together,
  // and a global list would silently score empty cells as 0.
  const anchorsOf = (tag) => [...new Set(rows.filter((r) => r.tag === tag).map((r) => r.t))].sort((a, b) => a - b);
  const basesOf = (tag) => [...new Set(rows.filter((r) => r.tag === tag).map((r) => r.base))].sort((a, b) => a - b);
  // a cell mean that is NULL (not 0) when the cell has no matches
  const cell = (tag, t, base, fn) => { const rs = pick(tag, t, base); return rs.length ? mean(rs.map(fn)) : null; };
  console.log(`=== bot-noise: ${rows.length} matches | ${secs}s each | ${(msPer / 1000).toFixed(2)}s/match measured ===`);
  for (const tag of tags) console.log(`    tag ${tag.padEnd(14)} anchors ${anchorsOf(tag).join(' ').padEnd(24)} ${basesOf(tag).length} seed bases x ${pick(tag, anchorsOf(tag)[0]).length / basesOf(tag).length} matches = ${pick(tag, anchorsOf(tag)[0]).length}/anchor`);
  console.log('');

  // ---- 0. HARNESS BIAS DECOMPOSITION, from the NULL cell ----------------------------------------
  // Which of the harness's own knobs actually move the reading? Whatever shows up here is a bias the
  // cell design has to CANCEL (it does: 16/16 on side and 16/16 on kickoff, exactly, inside every
  // cell) — and each cancelled component is variance the estimator no longer has to average away.
  for (const tag of tags) {
    const nul = pick(tag, REF);
    if (nul.length < 32) continue;
    const gd = (r) => r.gf - r.ga;
    const grp = (f) => { const g = nul.filter(f).map(gd); return `${(mean(g) >= 0 ? '+' : '') + mean(g).toFixed(3)} +-${(sd(g) / Math.sqrt(g.length)).toFixed(3)} (n=${g.length})`; };
    console.log(`--- 0. HARNESS BIAS [tag ${tag}] the null cell split by the harness's own knobs ---`);
    console.log(`    measured side = A : ${grp((r) => r.side === 'A')}        measured side = B : ${grp((r) => r.side === 'B')}`);
    console.log(`    kickoff to the measured team : ${grp((r) => r.kickTo === 'skill')}   to the reference : ${grp((r) => r.kickTo === 'ref')}`);
    console.log(`    (the KICKOFF split is the big one — whoever starts with the ball scores more. The cell balances it`);
    console.log(`     exactly, which is why this harness's remaining noise is scenario chaos, not a design bias.)\n`);
  }

  // ---- 1. NOISE FLOOR, from the NULL cell (t=REF vs t=REF: the true differential is 0) ----------
  for (const tag of tags) {
    const nul = pick(tag, REF);
    if (nul.length < 8) continue;
    const gd = nul.map((r) => r.gf - r.ga);
    const s1 = sd(gd), m1 = mean(gd);
    console.log(`--- 1. NOISE FLOOR  [tag ${tag}]  null cell t=${REF} vs t=${REF}, ${nul.length} matches, true value 0.00 ---`);
    console.log(`    per-match goal differential: mean ${m1 >= 0 ? '+' : ''}${m1.toFixed(3)}  SD ${s1.toFixed(3)}  (a 60s match ends 0-0..3-3, so one match carries almost no information)`);
    console.log(`    n/anchor   SE=SD/sqrt(n)   95% band      resolves 0.10 at   serial     16-way`);
    for (const n of [32, 64, 96, 192, 384, 768, 1536, 3072, 6144]) {
      const se = s1 / Math.sqrt(n);
      const sigma = 0.10 / se;
      const cells = 6;                              // 5 anchors + a null/control cell per run
      console.log(`    ${String(n).padStart(5)}      ${se.toFixed(3)}          +-${(1.96 * se).toFixed(2)}        ${sigma.toFixed(1)} sigma`.padEnd(75)
        + `${(n * cells * soloMs / 60000).toFixed(0).padStart(5)} min ${(n * cells * msPer / 60000 / 16).toFixed(0).padStart(6)} min`);
    }
    const need = (k) => Math.ceil((k * s1 / 0.10) ** 2 / 32) * 32;
    console.log(`    => to call a 0.10 goals/match effect at 2 sigma you need n = ${need(2)} matches/anchor; at 3 sigma, ${need(3)}.`);
    console.log(`       today's SEEDS=6 run is n = 192, i.e. SE ${(s1 / Math.sqrt(192)).toFixed(2)} — a 0.10 effect is ${(0.10 / (s1 / Math.sqrt(192))).toFixed(1)} sigma. That is the whole problem.`);
    // does the empirical spread of the base means match sigma/sqrt(n)? (are matches ~independent?)
    const perBase = basesOf(tag).map((b) => cell(tag, REF, b, (r) => r.gf - r.ga)).filter((v) => v != null);
    if (perBase.length > 2) {
      const nPerBase = nul.length / perBase.length;
      console.log(`       per-base null readings: ${perBase.map((v) => (v >= 0 ? '+' : '') + v.toFixed(2)).join(' ')}`);
      console.log(`       their SD ${sd(perBase).toFixed(3)} vs the predicted ${(s1 / Math.sqrt(nPerBase)).toFixed(3)} at ${nPerBase}/base -> matches are ${sd(perBase) > 1.25 * s1 / Math.sqrt(nPerBase) ? 'CORRELATED inside a base' : 'effectively independent'}`);
    }
    console.log('');
  }

  // ---- 2. CANDIDATE STATISTICS ------------------------------------------------------------------
  for (const tag of tags) {
    const anchors = anchorsOf(tag), bases = basesOf(tag);
    if (anchors.length < 4 || pick(tag, anchors[0]).length < 8) continue;
    const n = pick(tag, anchors[0]).length;
    console.log(`--- 2. CANDIDATE RANKING STATISTICS  [tag ${tag}]  ${anchors.length} anchors x ${n} matches, ${bases.length} seed bases ---`);
    console.log('    statistic  unit           per-anchor mean, t=' + anchors.map((t) => t.toFixed(2)).join('   t=') + '      rho   per-base rho min/med  spread    SEdiff  spread/SE  NULL   null/SE');
    for (const [name, unit, fn] of STATS) {
      const cells = anchors.map((t) => cell(tag, t, null, fn));
      const rho = spearman(anchors, cells);
      const baseRhos = bases.map((b) => {
        const cs = anchors.map((t) => cell(tag, t, b, fn));
        return cs.some((v) => v == null) ? null : spearman(anchors, cs);
      }).filter((v) => v != null);
      const sortedR = [...baseRhos].sort((a, b) => a - b);
      const nul = pick(tag, REF).map(fn);
      // SE of the TOP-minus-BOTTOM difference — that is the quantity the gate compares, and it is
      // sqrt(2)x the SE of one cell. Using one cell's SE would overstate the resolution.
      const seTop = sd(pick(tag, anchors[anchors.length - 1]).map(fn)) / Math.sqrt(n);
      const seBot = sd(pick(tag, anchors[0]).map(fn)) / Math.sqrt(n);
      const seD = Math.hypot(seTop, seBot);
      const seNull = sd(nul) / Math.sqrt(nul.length);
      const spread = cells[cells.length - 1] - cells[0];
      const nulm = mean(nul);
      const fmt = (v) => (v == null ? '   -  ' : Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));
      console.log(`    ${name}  ${unit.padEnd(11)} ${cells.map((v) => String(fmt(v)).padStart(7)).join(' ')}    ${rho >= 0 ? ' ' : ''}${rho.toFixed(2)}      ${sortedR.length ? `${sortedR[0].toFixed(2)} / ${sortedR[Math.floor(sortedR.length / 2)].toFixed(2)}` : '  -  '}      ${String(fmt(spread)).padStart(7)} ${String(fmt(seD)).padStart(7)}  ${(Math.abs(spread) / (seD || 1)).toFixed(1).padStart(7)}  ${String(fmt(nulm)).padStart(7)} ${(Math.abs(nulm) / (seNull || 1)).toFixed(1).padStart(5)}`);
    }
    // the per-base rho LIST for the shortlist — "the sign flips with the seed" is only visible here
    for (const [name, , fn] of STATS.filter((s) => ['goals    ', 'sonGoal  ', 'terr     ', 'dangerZ  ', 'xg       ', 't2shot   ', 'strips   '].includes(s[0]))) {
      const list = bases.map((b) => {
        const cs = anchors.map((t) => cell(tag, t, b, fn));
        return cs.some((v) => v == null) ? null : spearman(anchors, cs);
      }).filter((v) => v != null);
      console.log(`      per-base rho ${name} ${list.map((v) => (v >= 0 ? ' ' : '') + v.toFixed(2)).join(' ')}   (n=${n / bases.length}/base)`);
    }
    console.log(`    (rho over ${anchors.length} anchors: 1.00 = perfect order, 0.90 = one adjacent swap, 0.10 = noise. per-base rho is the honest one.`);
    console.log(`     spread/SEdiff decides gateability: it is how many sigma the top-vs-bottom gap is at n=${n}. Below ~4 the statistic cannot see the ladder.`);
    console.log(`     NULL is the statistic in the t=${REF} cell where the true answer is 0; null/SE is how many sigma off zero the INSTRUMENT reads.)\n`);
  }

  // ---- 3. PAIRING / ESTIMATOR COMPARISON --------------------------------------------------------
  // Same match COUNT, different seed scheme. What must fall is the run-to-run scatter of the thing
  // the gate reads: the per-base top-vs-bottom gap, and the per-base rho.
  if (tags.length > 1) {
    console.log('--- 3. PAIRING: does a tighter estimator cut the noise at the SAME match count? ---');
    console.log('    stat        tag              per-base SD of (top-bottom)   equivalent sample   per-base SD of rho   null |mean|');
    for (const [name, , fn] of STATS.filter((s) => ['goals    ', 'sonGoal  ', 'terr     ', 'third    ', 'xg       ', 'strips   ', 't2shot   '].includes(s[0]))) {
      let ref = null;
      for (const tag of tags) {
        const anchors = anchorsOf(tag), bases = basesOf(tag);
        if (anchors.length < 4) continue;
        const gaps = bases.map((b) => {
          const hi = cell(tag, anchors[anchors.length - 1], b, fn), lo = cell(tag, anchors[0], b, fn);
          return hi == null || lo == null ? null : hi - lo;
        }).filter((v) => v != null);
        const rhos = bases.map((b) => {
          const cs = anchors.map((t) => cell(tag, t, b, fn));
          return cs.some((v) => v == null) ? null : spearman(anchors, cs);
        }).filter((v) => v != null);
        const g = sd(gaps);
        if (ref == null) ref = g;
        const eq = ref && g ? (ref / g) ** 2 : 1;
        console.log(`    ${name}  ${tag.padEnd(15)}  ${g.toFixed(3).padStart(12)} (${gaps.length} bases)      x${eq.toFixed(2).padStart(5)}            ${sd(rhos).toFixed(2).padStart(6)}           ${Math.abs(mean(pick(tag, REF).map(fn))).toFixed(3).padStart(7)}`);
      }
    }
    console.log('    (equivalent sample is relative to the FIRST tag listed: x2 means that scheme reaches the same');
    console.log('     precision with half the matches. A quadruple sharing one seed is an ANTITHETIC set — the same');
    console.log('     scenario played with the measured team on each side and each kickoff, so its luck cancels.)\n');
  }

  // ---- 4. WITHIN-QUAD CANCELLATION (only meaningful for PAIR=quad rows) -------------------------
  for (const tag of tags) {
    const nul = pick(tag, REF);
    if (nul.length < 8 || !nul.some((r) => nul.filter((x) => x.base === r.base && x.seed === r.seed).length === 4)) continue;
    const byQuad = new Map();
    for (const r of nul) { const k = `${r.base}:${r.seed}`; (byQuad.get(k) || byQuad.set(k, []).get(k)).push(r); }
    const quads = [...byQuad.values()].filter((g) => g.length === 4);
    if (!quads.length) continue;
    console.log(`--- 4. WITHIN-QUAD CANCELLATION [tag ${tag}] ${quads.length} mirrored quadruples in the null cell ---`);
    let degenerate = 0;
    for (const [name, , fn] of STATS.filter((s) => ['goals    ', 'terr     ', 'xg       '].includes(s[0]))) {
      const single = sd(nul.map(fn));
      const qm = quads.map((g) => mean(g.map(fn)));
      const sq = sd(qm);
      if (sq < 1e-9) { degenerate++; console.log(`    ${name}  SD(single match) ${single.toFixed(3)}   SD(quad mean) EXACTLY 0`); continue; }
      const eff = ((single / 2) / sq) ** 2;                      // >1 => the quad beat 4 independent matches
      console.log(`    ${name}  SD(single match) ${single.toFixed(3)}   SD(quad mean) ${sq.toFixed(3)}   vs ${(single / 2).toFixed(3)} for 4 independent  ->  effective-sample x${eff.toFixed(2)}`);
    }
    if (degenerate) {
      console.log('    An EXACT zero is not variance reduction — it is an arithmetic identity, and it is a TRAP.');
      console.log('    In the null cell both teams have the same skill, so one seed played with the measured team on');
      console.log('    side A and on side B is the IDENTICAL simulation read from both ends: the two readings are +x');
      console.log('    and -x. The quad therefore cancels no matter how asymmetric the bots are (it would not even');
      console.log('    catch personas keyed on bot id, BOT_HANDOFF §4). Use it as a zero-check and you gate on nothing.');
    }
    console.log('');
  }
  process.exit(0);
}

console.error(`unknown mode "${MODE}" — use collect or analyze`);
process.exit(2);
