// Do the bots ACTUALLY use their tricks? ("make sure the bot know how to use the tricks and skills")
//
// The tactics all EXISTED before this test; several simply never fired, and nothing noticed:
//   * carryJump was physically impossible (a carrier cannot plant — sim.js:840 gates on !carrying),
//     so it only froze the carrier for a 1.8s fuse, ~50s per match.
//   * doubleBomb needed the support bot within 273px while the off-ball separation floor held it
//     at >= 320px — geometrically impossible.
//   * several plays were gated on toolSkill >= 0.9, which the PARTNER side of the ladder
//     (skill 0.05-0.82 => toolSkill 0.39-0.97) essentially never reaches.
// So this counts each behaviour tag over real matches and FAILS when one is silently dead.
// Run: node test-bot-tricks-fire.mjs [matches] [secs]
import { createState, addPlayer, attachBall, step, makeRng } from './shared/sim.js';
import { DT } from './shared/constants.js';
import { computeBotInputs, createBotMemory, bmemForTest } from './shared/bot-ai.js';

const MATCHES = parseInt(process.argv[2] || '10', 10);
const SECS = parseInt(process.argv[3] || '70', 10);
const TICKS = Math.round(SECS / DT);
const IDS = ['A0', 'A1', 'B0', 'B1'];

let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };

// Count EVENT tags (a trick committed this tick) at a given skill for both teams.
function run(skill, matches) {
  const tally = {};
  let carrierFrozenTicks = 0, bombHoldWhileCarrying = 0;
  for (let mi = 0; mi < matches; mi++) {
    const s = createState();
    s.resetTimer = 0;
    s.rng = makeRng(9000 + mi * 31);
    for (const [id, team, slot] of [['A0', 'A', 0], ['A1', 'A', 1], ['B0', 'B', 0], ['B1', 'B', 1]])
      addPlayer(s, id, { name: id, char: 'player', team, slot, isBot: true });
    attachBall(s, mi % 2 ? 'A' : 'B');
    const mem = createBotMemory(skill);
    mem.teamSkill = { A: skill, B: skill };
    const last = {};
    for (let t = 0; t < TICKS; t++) {
      const inp = computeBotInputs(s, mem, DT);
      for (const id of IDS) {
        const bm = bmemForTest(mem, id);
        const tag = bm.lastTrick;
        // count each COMMIT once: only when the tag changes, so a sticky state tag cannot
        // inflate the count (a past bug over-counted by ~9x this way)
        if (tag && tag !== last[id]) tally[tag] = (tally[tag] || 0) + 1;
        last[id] = tag || null;
        // the carryJump pathology: sitting on a bomb fuse while holding the ball
        if (bm.bombHold && s.ball.owner === id) bombHoldWhileCarrying++;
      }
      step(s, inp, DT);
    }
  }
  return { tally, bombHoldWhileCarrying };
}

const SKILLS = [0.05, 0.50, 0.82, 1.00];
const results = {};
for (const sk of SKILLS) {
  results[sk] = run(sk, MATCHES);
  const t = results[sk].tally;
  const top = Object.entries(t).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ');
  console.log(`t=${sk.toFixed(2)}: ${top || '(NOTHING — every trick is dead)'}`);
}

// ---- the tricks the USER named, each must fire somewhere on the ladder ----
const anyOf = (names) => SKILLS.reduce((sum, sk) => sum + names.reduce((a, n) => a + (results[sk].tally[n] || 0), 0), 0);

ok(anyOf(['bombTackle', 'bushSteal']) > 0, `BOMB used to steal: ${anyOf(['bombTackle', 'bushSteal'])} commits`);
ok(anyOf(['ambushLurk', 'ambushWall', 'bushSteal']) > 0, `HIDING IN BUSHES (ambush): ${anyOf(['ambushLurk', 'ambushWall', 'bushSteal'])} commits`);
ok(anyOf(['pass', 'outletPass', 'passBank', 'giveGo']) > 0, `PASSING to each other: ${anyOf(['pass', 'outletPass', 'passBank', 'giveGo'])} commits`);
ok(anyOf(['goalScreen', 'blockDrive', 'ambushWall', 'deflectSetup', 'screenWall']) > 0, `BUILDING WALLS in strategic places: ${anyOf(['goalScreen', 'blockDrive', 'ambushWall', 'deflectSetup', 'screenWall'])} commits`);
ok(anyOf(['drive', 'postFinish', 'cornerFinish', 'overFinish']) > 0, `FINISHING at goal: ${anyOf(['drive', 'postFinish', 'cornerFinish', 'overFinish'])} commits`);

// ---- the impossible ones must be GONE, not merely rare ----
ok(anyOf(['carryJump']) === 0, 'carryJump is GONE (a carrier can never plant — it only froze the bot)');
{
  const frozen = SKILLS.reduce((a, sk) => a + results[sk].bombHoldWhileCarrying, 0);
  ok(frozen === 0, `no bot ever sits on a bomb fuse while CARRYING (ticks: ${frozen}; this was ~50s/match)`);
}

// ---- the ladder should use MORE tools as it gets smarter ----
{
  const total = (sk) => Object.values(results[sk].tally).reduce((a, b) => a + b, 0);
  const lo = total(0.05), hi = total(1.00);
  ok(hi > lo, `smarter bots use more tricks: t=1.00 ran ${hi} commits vs t=0.05's ${lo}`);
}

console.log(`\n${fails === 0 ? '✅ ALL PASS' : '❌ ' + fails + ' FAILED'}`);
process.exit(fails === 0 ? 0 : 1);
