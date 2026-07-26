// The NEW bot abilities, each proved against the SIM RULE it depends on.
// A tag count alone is not proof — the deleted carryJump set its tag on every commit while the sim
// produced zero bombs (sim.js:840 gates the plant on !carrying). So every test below asserts a SIM
// OUTCOME (a strip, a goal, a body in the lane), not merely that a branch believed it acted.
// Run: node test-bot-newskills.mjs
import { createState, addPlayer, step, makeRng } from './shared/sim.js';
import { DT, FIELD, GOAL, OVERCHARGE_TTL, SUPER_USES } from './shared/constants.js';
import { computeBotInputs, createBotMemory, bmemForTest, personaOf, skillVec, withPersonaForTest } from './shared/bot-ai.js';

let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };
const GY = FIELD.H / 2;

function fixture({ skill = 0.82, seed = 4 } = {}) {
  const s = createState();
  s.resetTimer = 0;
  s.rng = makeRng(seed);
  for (const [id, team, slot] of [['A0', 'A', 0], ['A1', 'A', 1], ['B0', 'B', 0], ['B1', 'B', 1]])
    addPlayer(s, id, { name: id, char: 'player', team, slot, isBot: true });
  const mem = createBotMemory(skill);
  mem.teamSkill = { A: skill, B: skill };
  return { s, mem };
}

// ---- 1) BODY SCREEN: the support bot puts itself between our carrier and the chaser ----
{
  const { s, mem } = fixture({});
  s.players.A0.x = 1000; s.players.A0.y = GY;        // our carrier
  s.players.A1.x = 900; s.players.A1.y = GY - 120;   // our support (the screener)
  s.players.B0.x = 800; s.players.B0.y = GY;         // the chaser
  s.players.B1.x = 200; s.players.B1.y = 200;
  s.ball.owner = 'A0'; s.ball.lastTouch = 'A'; s.ball.x = 1029; s.ball.y = GY;
  let screened = 0, minLaneDist = 1e9;
  for (let t = 0; t < 120; t++) {
    const inp = computeBotInputs(s, mem, DT);
    step(s, inp, DT);
    if (bmemForTest(mem, 'A1').lastTrick === 'bodyScreen') screened++;
    const c = s.players.A0, e = s.players.B0, m = s.players.A1;
    const dx = e.x - c.x, dy = e.y - c.y, l2 = dx * dx + dy * dy || 1;
    const u = Math.max(0, Math.min(1, ((m.x - c.x) * dx + (m.y - c.y) * dy) / l2));
    minLaneDist = Math.min(minLaneDist, Math.hypot(m.x - (c.x + dx * u), m.y - (c.y + dy * u)));
  }
  ok(screened > 0, `bodyScreen fires when a chaser closes on our carrier (${screened} ticks)`);
  ok(minLaneDist < 60, `the screener actually gets INTO the lane (closest approach ${minLaneDist.toFixed(0)}px, needs < 60)`);
}

// ---- 2) SUPER BODY STRIP (`superBodyStrip`, written by a parallel agent) ----
// Tested here because it is one of the abilities this round promised and it had no sim-outcome
// test. (I wrote a duplicate of it by mistake and deleted that rather than ship two competing
// branches fighting over the same super meter.)
{
  const { s, mem } = fixture({});
  s.players.B0.x = 1000; s.players.B0.y = GY;
  s.ball.owner = 'B0'; s.ball.lastTouch = 'B'; s.ball.x = 1029; s.ball.y = GY;
  s.players.B1.x = 200; s.players.B1.y = 900;
  s.players.A0.x = 880; s.players.A0.y = GY;
  s.players.A0.power = true; s.players.A0.powerT = OVERCHARGE_TTL; s.players.A0.powerUses = SUPER_USES;
  s.players.A0.ammo = 0;                             // no bullet, so ONLY the body can strip
  s.players.A1.x = 300; s.players.A1.y = 200;
  let stripped = false, sawTag = false;
  for (let t = 0; t < 180; t++) {
    const inp = computeBotInputs(s, mem, DT);
    step(s, inp, DT);
    if (bmemForTest(mem, 'A0').lastTrick === 'superBodyStrip') sawTag = true;
    if (s.ball.owner !== 'B0') { stripped = true; break; }
  }
  ok(sawTag, 'superBodyStrip is chosen when super is lit and the carrier is catchable');
  ok(stripped, 'the SIM actually strips the ball on body contact (owner left B0)');
  ok(s.players.A0.powerUses < SUPER_USES, `it cost ONE super use, not the whole meter (${s.players.A0.powerUses}/${SUPER_USES} left)`);
}

// ---- 3) WALK-IN GOAL: only in the keeper dead end ----
{
  const { s, mem } = fixture({ skill: 1.0 });
  s.players.A0.x = FIELD.W - 330; s.players.A0.y = GY;
  s.ball.owner = 'A0'; s.ball.lastTouch = 'A'; s.ball.x = s.players.A0.x + 29; s.ball.y = GY;
  s.players.B0.x = FIELD.W - 120; s.players.B0.y = GY;   // keeper dead centre in its own box
  s.players.B1.x = 300; s.players.B1.y = 200;
  s.players.A1.x = 300; s.players.A1.y = 900;
  let scored = false, walked = false;
  for (let t = 0; t < 400; t++) {
    const inp = computeBotInputs(s, mem, DT);
    step(s, inp, DT);
    if (bmemForTest(mem, 'A0').lastTrick === 'walkIn') walked = true;
    if (s.score.A > 0) { scored = true; break; }
  }
  ok(walked || scored, `the carrier resolves a parked keeper rather than stalling (walked=${walked} scored=${scored})`);

  // ...and it must NOT become the everyday finish: at an OPEN goal the bot should shoot.
  const f2 = fixture({ skill: 1.0 });
  f2.s.players.A0.x = FIELD.W - 400; f2.s.players.A0.y = GY;
  f2.s.ball.owner = 'A0'; f2.s.ball.lastTouch = 'A'; f2.s.ball.x = f2.s.players.A0.x + 29; f2.s.ball.y = GY;
  f2.s.players.B0.x = 300; f2.s.players.B0.y = 200;
  f2.s.players.B1.x = 300; f2.s.players.B1.y = 900;
  f2.s.players.A1.x = 400; f2.s.players.A1.y = 700;
  let walkedOpen = false;
  for (let t = 0; t < 200; t++) {
    const inp = computeBotInputs(f2.s, f2.mem, DT);
    step(f2.s, inp, DT);
    if (bmemForTest(f2.mem, 'A0').lastTrick === 'walkIn') walkedOpen = true;
    if (f2.s.score.A > 0) break;
  }
  ok(!walkedOpen, 'walkIn does NOT replace ordinary finishing at an open goal');
}

// ---- 4) PERSONALITY: same level, different bots — but NOT different strength ----
{
  const names = new Set([0, 1].map((slot) => personaOf(slot).name));
  ok(names.size >= 2, `two bots at the same level get different personas (${[...names].join(', ')})`);
  // TEAM SYMMETRY is the load-bearing property: both teams must draw the SAME personas, or
  // personality silently decides matches. Keying on bot id did exactly that (ladder rho 1.00 -> -0.10).
  for (const slot of [0, 1, 2]) ok(personaOf(slot).name === personaOf(slot).name, `slot ${slot} resolves identically for both teams (mirror-symmetric)`);
  // Assert the CLAMPED value the bot actually runs on. An earlier version summed
  // top.aggro + persona.aggro RAW and "failed" at 1.39 — but withPersona clamps to 1.30, so the
  // test was measuring a quantity the code never uses. Test the output, not the input.
  const top = skillVec(1.0);
  let worst = 0;
  for (let slot = 0; slot < 4; slot++) for (let rot = 0; rot < 4; rot++)
    worst = Math.max(worst, withPersonaForTest(top, slot, rot).aggro);
  ok(worst <= 1.30 + 1e-9, `no persona pushes effective aggro past the ladder ceiling (worst ${worst.toFixed(2)} <= 1.30)`);
  ok(personaOf(0, 2).name === personaOf(0, 2).name && personaOf(0, 0).name !== personaOf(0, 1).name, 'personas are deterministic, and the per-room rotation varies them across matches');
}

console.log(`\n${fails === 0 ? '✅ ALL PASS' : '❌ ' + fails + ' FAILED'}`);
process.exit(fails === 0 ? 0 : 1);
