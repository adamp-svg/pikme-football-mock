// The five "level 5 and above" asks (2026-07-26). Run: node test-bot-level5.mjs
//
// The user's definition of "level 5 and above" is a RAMP, in his words: "randomly from level 1 very
// few times, to almost always level 5 and above." So every test here checks BOTH ends — the ability
// exists at L5+, and it is rare or absent at L0/L1. A test that only proves the top of the ramp would
// pass on a switch, which is not what was asked for.
//
// Asks:
//   1. L5+: always try to have a FULL POWER shot           -> maxCharge 1.0 + readyCharge
//   2. L5+: aim the shot to push the enemy back further    -> goal-side press positioning
//   3. enemy nearer the ball -> shoot the BALL goalward     -> ballPush
//   4. stuck / moving with no purpose -> bomb at your feet  -> stuckEscape / aimlessEscape
//   5. L5+: prefer moving by bomb more                     -> rocketJump frequency
import { createState, addPlayer, attachBall, step, setField } from './shared/sim.js';
import { MAIN_FIELD } from './shared/main-field.js';
import {
  computeBotInputs, createBotMemory, bmemForTest, withPersonaForTest, skillVec,
} from './shared/bot-ai.js';
import { DT, FIELD, FULL_CHARGE } from './shared/constants.js';

let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };
const hyp = Math.hypot;
const GY = FIELD.H / 2;
// enemy skill per difficulty level (difficulty.js LEVEL_PAIRS), so the tests speak in LEVELS
const T_OF_LEVEL = { 0: 0.05, 1: 0.13, 2: 0.22, 3: 0.31, 4: 0.40, 5: 0.49, 8: 0.76, 10: 0.93 };

function fixture(skill, opts = {}) {
  const s = createState(); s.resetTimer = 0; s.goalsToWin = 0;
  setField(s, opts.field || MAIN_FIELD);
  let seed = opts.seed || 20260726;
  s.rng = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (const [id, team, slot] of [['A0', 'A', 0], ['A1', 'A', 1], ['B0', 'B', 0], ['B1', 'B', 1]])
    addPlayer(s, id, { name: id, char: 'player', team, slot, isBot: true });
  const mem = createBotMemory('normal');
  mem.teamSkill = { A: skill, B: skill };
  return { s, mem };
}
const put = (s, id, x, y, vx = 0, vy = 0) => { const p = s.players[id]; p.x = x; p.y = y; p.vx = vx; p.vy = vy; };

// ---------------------------------------------------- 1. full power from L5 up
{
  const mc = (lvl) => withPersonaForTest(skillVec(T_OF_LEVEL[lvl]), 0, 0).maxCharge;
  ok(Math.abs(mc(0) - (FULL_CHARGE + 0.01)) < 1e-6, `L0 still releases at the strip threshold (${mc(0).toFixed(2)})`);
  ok(mc(1) < 0.80, `L1 is barely above it (${mc(1).toFixed(2)})`);
  ok(mc(3) > 0.82 && mc(3) < 0.97, `L3 is on the way up (${mc(3).toFixed(2)})`);
  ok(mc(5) > 0.985, `L5 banks TRUE MAXIMUM power (${mc(5).toFixed(2)})`);
  ok(mc(10) > 0.985, `L10 too (${mc(10).toFixed(2)})`);
  // and it is a real fire ceiling, not just a field: run a match and look at what bullets leave at
  const seen = { 1: 0, 10: 0 };
  for (const lvl of [1, 10]) {
    const { s, mem } = fixture(T_OF_LEVEL[lvl]);
    let maxSeen = 0;
    for (let t = 0; t < 2400; t++) {
      const inp = computeBotInputs(s, mem, DT);
      for (const id of ['A0', 'A1', 'B0', 'B1']) {
        if (inp[id] && inp[id].fire && s.ball.owner !== id) maxSeen = Math.max(maxSeen, s.players[id]._charge || 0);
      }
      step(s, inp, DT);
    }
    seen[lvl] = maxSeen;
  }
  ok(seen[10] > 0.95, `a level-10 bullet actually leaves at full power (max charge seen ${seen[10].toFixed(2)})`);
  ok(seen[1] < 0.95, `a level-1 bullet never does (max charge seen ${seen[1].toFixed(2)})`);
}

// ---------------------------------------------------- 2. push the enemy the way that costs them
{
  // The push travels along the BULLET's line, so where the presser STANDS decides which way the
  // carrier flies. From L5 up the press target is shifted toward the goal the carrier is attacking, so
  // a strip shoves them back up the pitch instead of forward.
  // MEASURED IN WHOLE MATCHES, not in a fixture. Three fixtures failed to isolate this and each failed
  // for its own reason worth recording: (1) a moving carrier just measures the speed limit — 260px/s
  // cannot be overtaken at 142px/s; (2) with a bomb available an L10 bot tackles from 240px and stands
  // on the fuse, so it never walks; (3) teleporting the carrier back each tick makes separatePlayers
  // eject the presser. The behaviour is a positioning TENDENCY, so the honest instrument is occupancy
  // over real play.
  const goalSidePct = (skill) => {
    let onSide = 0, ticks = 0;
    for (let m = 0; m < 2; m++) {
      const { s, mem } = fixture(skill, { seed: 4242 + m * 7717 });
      attachBall(s, m % 2 ? 'A' : 'B');
      for (let t = 0; t < 2700; t++) {                       // 45s
        const inp = computeBotInputs(s, mem, DT);
        const carrier = s.ball.owner ? s.players[s.ball.owner] : null;
        if (s.resetTimer <= 0 && carrier) {
          // for each team defending against a carrier, is its PRESSER between that carrier and the
          // goal the carrier is attacking?
          for (const team of ['A', 'B']) {
            if (carrier.team === team) continue;
            const r = mem.teams[team];
            const presser = r && r.onBall ? s.players[r.onBall] : null;
            if (!presser) continue;
            const egX = carrier.team === 'A' ? FIELD.W : 0;   // the goal the CARRIER attacks
            ticks++;
            if (Math.abs(presser.x - egX) < Math.abs(carrier.x - egX)) onSide++;
          }
        }
        step(s, inp, DT);
      }
    }
    return 100 * onSide / Math.max(1, ticks);
  };
  const hi = goalSidePct(T_OF_LEVEL[10]), lo = goalSidePct(T_OF_LEVEL[1]);
  ok(hi > lo, `a level-10 presser is goal-side of the carrier more often than a level-1 one (${hi.toFixed(1)}% vs ${lo.toFixed(1)}%)`);
}

// ---------------------------------------------------- 3. shoot the loose ball when you cannot win it
{
  // A0 is 700px from a loose ball; B0 is 200px from it. A0 attacks x=2000, and the ball is between
  // A0 and that goal — so a bullet along A0->ball sends the ball goalward.
  // The ball sits in A's OWN half on purpose: shipping this play everywhere made both teams knock the
  // ball back and forth (advance per release 29-41px -> 6-12px, felt ladder range 48% -> 18%), so it
  // is restricted to clearing danger out of our own half, which is the case the research measured as
  // valuable (SKILL_CATALOGUE T4/T5).
  const fired = (skill) => {
    const { s, mem } = fixture(skill, { field: { version: 1, bushes: [], crates: [], dryWalls: [], hardWalls: [] } });
    // y = 250, NOT the centre line: (850..1150, 430..670) is the DEFAULT arena's "centre contest
    // bush", and `pointInBush` reads that box on every layout — so an enemy standing there is hidden
    // from botCanSee even on an empty field, and `visibleEnemies` comes back empty. The BALL's fog was
    // removed this session; ENEMY visibility still reads the phantom geometry (recorded in
    // summery/bots logic handoff/ARENA-AUDIT). A fixture has to stay out of that box.
    s.ball.owner = null; s.ball.x = 700; s.ball.y = 250; s.ball.vx = 0; s.ball.vy = 0;   // A's own half
    put(s, 'A0', 200, 250); put(s, 'A1', 300, 900); put(s, 'B0', 900, 250); put(s, 'B1', 1700, 700);
    let shotAtBall = false, ballGoalward = 0;
    for (let t = 0; t < 150; t++) {
      const inp = computeBotInputs(s, mem, DT);
      const tag = bmemForTest(mem, 'A0').lastTrick;
      const vx0 = s.ball.vx;
      step(s, { A0: inp.A0 }, DT);              // isolate: nobody else moves or shoots
      if (tag === 'ballPush') shotAtBall = true;
      if (s.ball.vx > vx0 + 100) ballGoalward++;   // the ball gained speed toward x=2000 (A attacks right)
    }
    return { shotAtBall, ballGoalward };
  };
  const hi = fired(T_OF_LEVEL[10]);
  ok(hi.shotAtBall, 'level 10: a bot that cannot win the race shoots the ball instead');
  ok(hi.ballGoalward > 0, `...and the ball is pushed toward the goal it attacks (${hi.ballGoalward} accelerating ticks)`);
  const lo = fired(T_OF_LEVEL[0]);
  ok(!lo.shotAtBall, 'level 0 never does it (the ramp starts above L0)');
}

// ---------------------------------------------------- 4. bomb yourself loose
{
  // TWO-LEVEL TEST, as the research doc's measurement rule asks for.
  // (a) THE MECHANISM: drive the trigger directly. Manufacturing a real jam in a fixture is
  //     unreliable *because* the anti-jam work landed — the worst jam in 24 measured matches is ~1s —
  //     and a fully enclosed pocket is the one case a bomb cannot solve anyway (a launched body still
  //     collides, so cannonPlant's flight-path test correctly refuses it).
  const { s, mem } = fixture(T_OF_LEVEL[10], { field: { version: 1, bushes: [], crates: [], dryWalls: [], hardWalls: [] } });
  put(s, 'A0', 500, GY); put(s, 'A1', 1500, 300); put(s, 'B0', 1700, 400); put(s, 'B1', 1750, 800);
  s.ball.owner = null; s.ball.x = 1500; s.ball.y = GY;
  computeBotInputs(s, mem, DT);                              // create the bot memory
  mem.bots.A0.noProgressT = 9;                               // "I have been going nowhere for ages"
  let planted = false;
  for (let t = 0; t < 30 && !planted; t++) {
    const inp = computeBotInputs(s, mem, DT);
    if (inp.A0 && inp.A0.special) planted = true;
    step(s, inp, DT);
  }
  ok(planted, 'the no-progress trigger plants a bomb at the bot\'s feet');
  ok(bmemForTest(mem, 'A0').lastTrick === 'aimlessEscape' || bmemForTest(mem, 'A0').lastTrick === 'cornerEscape',
    `...and it is tagged so it can be measured (${bmemForTest(mem, 'A0').lastTrick})`);

  // (b) IN REAL PLAY: it must actually happen in whole matches, not just in a fixture. 4 x 45s.
  let escapes = 0;
  for (let m = 0; m < 4; m++) {
    const f = fixture(T_OF_LEVEL[10], { seed: 991 + m * 7717 });
    attachBall(f.s, m % 2 ? 'A' : 'B');
    for (let t = 0; t < 2700; t++) {
      const inp = computeBotInputs(f.s, f.mem, DT);
      if (f.s.resetTimer <= 0) {
        for (const id of ['A0', 'A1', 'B0', 'B1']) {
          const tg = bmemForTest(f.mem, id).lastTrick;
          if (inp[id] && inp[id].special && (tg === 'aimlessEscape' || tg === 'stuckEscape' || tg === 'cornerEscape')) escapes++;
        }
      }
      step(f.s, inp, DT);
    }
  }
  ok(escapes > 0, `bots bomb themselves loose in real matches too (${escapes} plants over 4 x 45s)`);
}

// ---------------------------------------------------- 5. more bomb-trick movement from L5 up
{
  const jumpsPerMatch = (skill) => {
    const { s, mem } = fixture(skill);
    attachBall(s, 'A');
    let jumps = 0;
    for (let t = 0; t < 3600; t++) {                          // 60s
      const inp = computeBotInputs(s, mem, DT);
      for (const id of ['A0', 'A1', 'B0', 'B1']) {
        const tag = bmemForTest(mem, id).lastTrick;
        if (inp[id] && inp[id].special && (tag === 'chaseJump' || tag === 'catchUpJump' || tag === 'wallCannonJump' || tag === 'coopPush')) jumps++;
      }
      step(s, inp, DT);
    }
    return jumps;
  };
  const l1 = jumpsPerMatch(T_OF_LEVEL[1]), l5 = jumpsPerMatch(T_OF_LEVEL[5]);
  ok(l5 > l1, `bomb-trick movement is commoner from level 5 up (${l5} vs ${l1} jump-ticks in 60s)`);
}

console.log(`\n${fails === 0 ? '✅ ALL PASS' : '❌ ' + fails + ' FAILED'}`);
process.exit(fails === 0 ? 0 : 1);
