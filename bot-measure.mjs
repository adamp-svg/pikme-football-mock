// Bot behaviour measurement harness — the "step-by-step tuning" tool.
//
// Runs headless bot-vs-bot matches and reports, PER DIFFICULTY, the probes that map to the
// live-play complaints, plus a goals LADDER, then a PASS/FAIL banner vs acceptance targets:
//   - CLOSE-FIRE%   : within 430px of an enemy carrier, how often the bot actually FIRES
//                     ("if they're close to me they DON'T SHOOT")
//   - FINISH-FIRE%  : carrying, in shot range on goal, how often it releases
//   - PRESS/ROAM/IDLE% : ROAM = in fog active-search ("wait and roam around")
//   - FROZEN-ON-PLANT  : ticks standing still on a bomb plant with a carrier within 430px
//   - SHOTS/POSSESSION, TRICKS histogram, GOALS
//
// Run: node bot-measure.mjs           (default N matches/pairing)
//      node bot-measure.mjs 20        (override N)
import { createState, addPlayer, attachBall, step } from './shared/sim.js';
import { DT, GOAL, FIELD } from './shared/constants.js';
import { computeBotInputs, createBotMemory, bmemForTest } from './shared/bot-ai.js';

const GY = FIELD.H / 2;
const SECS = 70, TICKS = Math.round(SECS / DT);
const N = Number(process.argv[2]) || 14;
const hyp = Math.hypot;

// One match; `probeTeam` = which team's bots we instrument in detail ('A').
function match(skA, skB, seedBall, probe) {
  const s = createState(); s.resetTimer = 0;
  for (const [id, team, slot] of [['A0', 'A', 0], ['A1', 'A', 1], ['B0', 'B', 0], ['B1', 'B', 1]])
    addPlayer(s, id, { name: id, char: 'player', team, slot, isBot: true });
  attachBall(s, seedBall);
  const memA = createBotMemory(skA), memB = createBotMemory(skB);
  let gA = 0, gB = 0, err = 0;
  // probes (team A only)
  const P = { closeEp: 0, closeEpFire: 0, finishEp: 0, finishEpFire: 0, press: 0, chase: 0, orbit: 0, idle: 0,
    frozenPlant: 0, ticks: 0, fires: 0, poss: 0, tricks: {}, stuckCharge: 0 };
  const bots = ['A0', 'A1'];
  const holdRun = { A0: 0, A1: 0 };
  // episode trackers: are we currently within 430 of the carrier / in finish range, and have we fired this episode
  const closeIn = { A0: false, A1: false }, closeFired = { A0: false, A1: false };
  const finIn = { A0: false, A1: false }, finFired = { A0: false, A1: false };
  let lastOwner = s.ball.owner;
  for (let t = 0; t < TICKS; t++) {
    let inputs = {};
    try {
      const ia = computeBotInputs(s, memA, DT, { onlyTeam: 'A' });
      const ib = computeBotInputs(s, memB, DT, { onlyTeam: 'B' });
      inputs = { ...ia, ...ib };
    } catch (e) { err++; if (err <= 2) console.error('AI', e.message); }
    // possession changes
    if (s.ball.owner && s.ball.owner !== lastOwner) P.poss++;
    lastOwner = s.ball.owner;
    if (probe) {
      const carrier = s.ball.owner ? s.players[s.ball.owner] : null;
      for (const id of bots) {
        const p = s.players[id]; const inp = inputs[id]; if (!p || !inp) continue;
        const bm = bmemForTest(memA, id);
        const mv = hyp(inp.moveX || 0, inp.moveY || 0);
        P.ticks++;
        if (inp.fire) P.fires++;
        // classify press / chase (fresh fog-pursuit, productive) / orbit (stale sweep) / idle
        if ((bm.blindT || 0) > 0) { if (bm.blindT < 1.2) P.chase++; else P.orbit++; }
        else if (mv < 0.1 && !bm.bombHold) P.idle++;
        else P.press++;
        // frozen on a bomb plant with a carrier bearing down (the regression we killed)
        if (bm.bombHold && mv < 0.1) {
          const ec = ['B0', 'B1'].map((e) => s.players[e]).filter(Boolean);
          if (ec.some((e) => s.ball.owner === e.id && hyp(e.x - p.x, e.y - p.y) < 430)) P.frozenPlant++;
        }
        // hold-run that ends without a fire = a wasted wind-up (extreme pre-charges, so it holds a lot by design)
        if (inp.hold && !inp.fire) holdRun[id]++;
        else { if (holdRun[id] >= 30 && !inp.fire) P.stuckCharge++; holdRun[id] = 0; }
        // CLOSE-EPISODE: a continuous stretch within 430 of an ENEMY carrier — did we get a shot off?
        // "engaged" = fired a strip OR committed a bomb-tackle steal (special) at the close carrier
        const closeNow = carrier && carrier.team !== 'A' && hyp(carrier.x - p.x, carrier.y - p.y) < 430;
        if (closeNow) { if (!closeIn[id]) { closeIn[id] = true; closeFired[id] = false; P.closeEp++; } if ((inp.fire || inp.special) && !closeFired[id]) { closeFired[id] = true; P.closeEpFire++; } }
        else closeIn[id] = false;
        // FINISH-EPISODE: a stretch carrying in shot range on goal — did we release?
        const distGoal = s.ball.owner === id ? hyp(FIELD.W - p.x, GY - p.y) : 1e9; // team A attacks +x
        const finNow = s.ball.owner === id && distGoal < 800 && Math.abs(p.y - GY) < GOAL.width / 2 + 280;
        if (finNow) { if (!finIn[id]) { finIn[id] = true; finFired[id] = false; P.finishEp++; } if (inp.fire && !finFired[id]) { finFired[id] = true; P.finishEpFire++; } }
        else finIn[id] = false;
        if (bm.lastTrick) P.tricks[bm.lastTrick] = (P.tricks[bm.lastTrick] || 0) + 1;
      }
    }
    const bA = s.score.A, bB = s.score.B;
    try { step(s, inputs, DT); } catch (e) { err++; if (err <= 2) console.error('SIM', e.message); break; }
    if (s.score.A > bA) gA++; if (s.score.B > bB) gB++;
  }
  return { gA, gB, err, P };
}

function series(skA, skB, n, probe) {
  let A = 0, B = 0, err = 0;
  const acc = { closeEp: 0, closeEpFire: 0, finishEp: 0, finishEpFire: 0, press: 0, chase: 0, orbit: 0, idle: 0, frozenPlant: 0, ticks: 0, fires: 0, poss: 0, stuckCharge: 0, tricks: {} };
  for (let i = 0; i < n; i++) {
    const r = match(skA, skB, i % 2 ? 'A' : 'B', probe); A += r.gA; B += r.gB; err += r.err;
    if (probe) for (const k in acc) { if (k === 'tricks') { for (const tk in r.P.tricks) acc.tricks[tk] = (acc.tricks[tk] || 0) + r.P.tricks[tk]; } else acc[k] += r.P[k]; }
  }
  return { A, B, err, acc };
}

const pct = (a, b) => b ? (100 * a / b).toFixed(1) + '%' : 'n/a';
console.log(`=== BOT MEASURE (${N} matches x ${SECS}s) ===\n`);

// Per-tier mirror probes
const tiers = ['easy', 'normal', 'hard', 'extreme'];
const mirror = {};
for (const tier of tiers) {
  const r = series(tier, tier, N, true); const a = r.acc;
  mirror[tier] = a;
  const tot = a.press + a.chase + a.orbit + a.idle;
  console.log(`--- ${tier.toUpperCase()} (mirror) ---`);
  console.log(`  CLOSE-EPISODE shot%  ${pct(a.closeEpFire, a.closeEp)}   FINISH-EPISODE shot% ${pct(a.finishEpFire, a.finishEp)}   shots/poss ${(a.fires / Math.max(1, a.poss)).toFixed(2)}`);
  console.log(`  PRESS ${pct(a.press, tot)}  CHASE ${pct(a.chase, tot)}  ORBIT ${pct(a.orbit, tot)}  IDLE ${pct(a.idle, tot)}   frozen-on-plant ${a.frozenPlant}   crashes ${r.err}`);
  const tr = Object.entries(a.tricks).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k}:${v}`).join(' ');
  console.log(`  tricks: ${tr || '(none)'}\n`);
}

// Ladder (goals). Alternating kickoff already handled in series().
function ladder(hi, lo) { const r = series(hi, lo, N, false); const r2 = series(lo, hi, N, false); return { hi: r.A + r2.B, lo: r.B + r2.A, err: r.err + r2.err }; }
console.log('--- LADDER (aggregate goals, sides swapped) ---');
const eh = ladder('extreme', 'hard'); console.log(`  extreme ${eh.hi} vs hard ${eh.lo}`);
const hn = ladder('hard', 'normal'); console.log(`  hard ${hn.hi} vs normal ${hn.lo}`);
const ne = ladder('normal', 'easy'); console.log(`  normal ${ne.hi} vs easy ${ne.lo}`);

// ---- PASS/FAIL vs acceptance targets ----
console.log('\n=== ACCEPTANCE ===');
const chk = (name, ok, detail) => console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}  ${detail}`);
const epPct = (a) => 100 * a.closeEpFire / Math.max(1, a.closeEp);
const finPct = (a) => 100 * a.finishEpFire / Math.max(1, a.finishEp);
const orbitPct = (a) => 100 * a.orbit / Math.max(1, (a.press + a.chase + a.orbit + a.idle));
const hCE = epPct(mirror.hard), hFE = finPct(mirror.hard), hOrbit = orbitPct(mirror.hard);
const xCE = epPct(mirror.extreme), xOrbit = orbitPct(mirror.extreme);
// per-EPISODE (not per-tick): when a bot gets close / lines up, does it eventually shoot?
chk('hard CLOSE-EPISODE shot% >= 60%', hCE >= 60, `= ${hCE.toFixed(1)}%`);
chk('hard FINISH-EPISODE shot% >= 55%', hFE >= 55, `= ${hFE.toFixed(1)}%`);
chk('hard ORBIT% (stale aimless roam) <= 15%', hOrbit <= 15, `= ${hOrbit.toFixed(1)}%`);
chk('extreme CLOSE-EPISODE engage% >= 58%', xCE >= 58, `= ${xCE.toFixed(1)}%`);
chk('extreme ORBIT% <= 6%', xOrbit <= 6, `= ${xOrbit.toFixed(1)}%`);
chk('frozen-on-plant ~0 (regression killed)', mirror.hard.frozenPlant + mirror.extreme.frozenPlant + mirror.normal.frozenPlant === 0, `hard ${mirror.hard.frozenPlant} / normal ${mirror.normal.frozenPlant} / extreme ${mirror.extreme.frozenPlant}`);
chk('hard beats normal (>=1.5:1)', hn.hi >= hn.lo * 1.5, `${hn.hi} vs ${hn.lo}`);
chk('extreme dominates hard (>=3:1)', eh.hi >= eh.lo * 3, `${eh.hi} vs ${eh.lo}`);
chk('ladder monotonic (extreme>hard>normal>easy)', eh.hi > eh.lo && hn.hi > hn.lo && ne.hi > ne.lo, `${eh.hi}/${eh.lo}, ${hn.hi}/${hn.lo}, ${ne.hi}/${ne.lo}`);
const totalErr = eh.err + hn.err + ne.err;
chk('0 crashes', totalErr === 0, `= ${totalErr}`);
