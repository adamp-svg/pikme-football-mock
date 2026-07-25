// Anti-stall FIXTURES — the user-visible symptoms, each as a hard number.
//   "sometimes they stand with the ball in front of the goal"
//   "if they are in front of an obstacle like a steel wall they just get stuck"
// Every case below puts a bot in the exact situation and asserts it RESOLVES within a
// deadline. These are capability tests, not aggregate rates: the behaviour harness
// (test-behavior.mjs) measures how OFTEN a stall happens across random play, which is too
// noisy to prove a specific mechanism. Run: node test-bot-stall.mjs
import { createState, addPlayer, step, makeRng } from './shared/sim.js';
import { DT, FIELD, GOAL, BUILT_WALL } from './shared/constants.js';
import { computeBotInputs, createBotMemory } from './shared/bot-ai.js';
import { ARENA } from './shared/arena.js';

let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };
const GY = FIELD.H / 2;

// Build a 1v0-style fixture: `skill` bots on A, optional enemies on B, ball given to A0.
function fixture({ skill = 0.5, ax, ay, aim = [1, 0], enemies = [], walls = [], carry = true, seed = 5 }) {
  const s = createState();
  s.resetTimer = 0;
  s.rng = makeRng(seed);
  addPlayer(s, 'A0', { name: 'A0', char: 'player', team: 'A', slot: 0, isBot: true });
  addPlayer(s, 'A1', { name: 'A1', char: 'player', team: 'A', slot: 1, isBot: true });
  s.players.A0.x = ax; s.players.A0.y = ay;
  s.players.A0.aimX = aim[0]; s.players.A0.aimY = aim[1];
  s.players.A1.x = 300; s.players.A1.y = 300;           // mate parked far away, out of the way
  enemies.forEach((e, i) => {
    const id = `B${i}`;
    addPlayer(s, id, { name: id, char: 'player', team: 'B', slot: i, isBot: true });
    s.players[id].x = e.x; s.players[id].y = e.y;
  });
  for (const w of walls) {
    s.builtWalls.push({
      id: s._nid++, wallId: 900 + s.builtWalls.length, x: w.x, y: w.y, w: w.w, h: w.h,
      hp: w.hp ?? BUILT_WALL.hp, maxHp: w.hp ?? BUILT_WALL.hp, fragile: false,
      cx: w.x + w.w / 2, cy: w.y + w.h / 2, angle: Math.PI / 2, hl: w.h / 2, ht: w.w / 2,
      team: 'B', ttl: 0,
    });
  }
  if (carry) { s.ball.owner = 'A0'; s.ball.lastTouch = 'A'; s.ball.x = ax + 29; s.ball.y = ay; }
  const mem = createBotMemory(skill);
  mem.teamSkill = { A: skill, B: skill };
  return { s, mem };
}

// Run until `done(s)` or the deadline. Returns seconds taken (Infinity = never).
function runUntil({ s, mem }, done, maxSecs) {
  const ticks = Math.round(maxSecs / DT);
  for (let t = 0; t < ticks; t++) {
    const inp = computeBotInputs(s, mem, DT);
    step(s, inp, DT);
    if (done(s)) return t * DT;
  }
  return Infinity;
}

// ---- 1) THE HEADLINE SYMPTOM: a carrier in front of an OPEN goal must resolve fast ----
// It may score by kicking OR by walking the ball in (sim.js #9 dribble-in). Either way it
// must not stand there. The budget is generous — the point is "not forever".
{
  for (const [name, skill, budget] of [['bottom t=0.05', 0.05, 5.0], ['normal t=0.50', 0.50, 3.0], ['top t=1.00', 1.00, 2.0]]) {
    const f = fixture({ skill, ax: FIELD.W - 260, ay: GY });
    const took = runUntil(f, (s) => s.score.A > 0, budget);
    ok(took <= budget, `carrier 260px out, open goal, ${name}: SCORES in ${took === Infinity ? 'never' : took.toFixed(2) + 's'} (budget ${budget}s)`);
  }
}

// ---- 2) A carrier must never HOLD the ball indefinitely (the watchdog) ----
// Blocked lane: a solid built wall spans the goal mouth just outside the box. The carrier
// cannot shoot through it, so it must do SOMETHING (break it, go round it, walk it in, pass)
// — the failure mode is holding the ball and driving into the wall forever.
{
  const wallX = FIELD.W - 420;
  const f = fixture({
    skill: 0.82, ax: FIELD.W - 700, ay: GY,
    walls: [{ x: wallX, y: GY - 150, w: BUILT_WALL.thick, h: 300 }],
  });
  const startBall = f.s.ball.owner;
  // resolved = the ball left this carrier (kicked/passed/walled) OR a goal happened
  const took = runUntil(f, (s) => s.score.A > 0 || s.ball.owner !== startBall, 6.0);
  ok(took <= 6.0, `blocked goal lane, hard tier: carrier RELEASES the ball in ${took === Infinity ? 'never (STALL)' : took.toFixed(2) + 's'} (budget 6s)`);
}

// ---- 3) STEEL WALL: a bot whose objective sits directly behind static stone must get round it ----
// The loose ball is placed on the far side of a stone block from the bot. Local steering with
// no wall-following oscillates in front of it; the assertion is that the bot actually ARRIVES.
{
  const w = ARENA.walls[0]; // {x:560,y:250,w:120,h:120}
  const f = fixture({ skill: 0.82, ax: w.x - 90, ay: w.y + 60, carry: false });
  f.s.ball.owner = null;
  f.s.ball.x = w.x + w.w + 90; f.s.ball.y = w.y + 60; // directly behind the stone
  f.s.ball.vx = 0; f.s.ball.vy = 0;
  const took = runUntil(f, (s) => s.ball.owner === 'A0' || Math.hypot(s.players.A0.x - s.ball.x, s.players.A0.y - s.ball.y) < 45, 6.0);
  ok(took <= 6.0, `ball behind a 120px stone wall: bot reaches it in ${took === Infinity ? 'never (STUCK)' : took.toFixed(2) + 's'} (budget 6s)`);
}

// ---- 4) A LONG builder-style wall — the case local steering cannot solve by luck ----
// A 600px wall with the objective behind its middle. Going round requires committing to one
// direction for ~300px; an oscillating bot never gets there.
{
  const f = fixture({ skill: 0.82, ax: 700, ay: GY, carry: false });
  f.s.builtWalls.push({
    id: 1, wallId: 901, x: 900, y: GY - 300, w: BUILT_WALL.thick, h: 600,
    hp: 3, maxHp: 3, fragile: false, cx: 900 + 16, cy: GY, angle: Math.PI / 2, hl: 300, ht: 16, team: 'B', ttl: 0,
  });
  f.s.ball.owner = null; f.s.ball.x = 1150; f.s.ball.y = GY; f.s.ball.vx = 0; f.s.ball.vy = 0;
  const took = runUntil(f, (s) => s.ball.owner === 'A0' || Math.hypot(s.players.A0.x - s.ball.x, s.players.A0.y - s.ball.y) < 45, 8.0);
  ok(took <= 8.0, `ball behind a 600px wall: bot routes around it in ${took === Infinity ? 'never (STUCK)' : took.toFixed(2) + 's'} (budget 8s)`);
}

// ---- 5) MECHANISM: the goal mouth must not read as boundary danger ----
// This is deliberately a mechanism test, not a behaviour one. Asserting "the carrier walks the
// ball in" would measure a CHOICE (it usually kicks instead, and that is fine), so it proves
// nothing about the steering. What must be true is narrower: a carrier standing INSIDE the mouth
// band past the old danger threshold (FIELD.W - 55 = 1945) still wants to move FORWARD, toward
// the line, rather than being pushed back out. The pocket is only open to the carrier, so the
// same position off-ball SHOULD still be repelled — both directions are asserted.
{
  const f = fixture({ skill: 1.0, ax: FIELD.W - 40, ay: GY }); // x=1960, inside the mouth band
  const inp = computeBotInputs(f.s, f.mem, DT);
  ok(inp.A0.moveX > 0, `mouth not repellent: a CARRIER at x=${FIELD.W - 40} still drives forward (moveX=${inp.A0.moveX.toFixed(2)}; the old boundary danger drove it back)`);

  // ...and an OFF-BALL bot at the same spot must still be pushed out of the dead-end pocket.
  const g = fixture({ skill: 1.0, ax: FIELD.W - 40, ay: GY, carry: false });
  g.s.ball.owner = null; g.s.ball.x = 1000; g.s.ball.y = GY; // ball elsewhere, so no reason to be here
  const inp2 = computeBotInputs(g.s, g.mem, DT);
  ok(inp2.A0.moveX < 0, `pocket still solid off-ball: a non-carrier at x=${FIELD.W - 40} leaves the dead end (moveX=${inp2.A0.moveX.toFixed(2)})`);
}

console.log(`\n${fails === 0 ? '✅ ALL PASS' : '❌ ' + fails + ' FAILED'}`);
process.exit(fails === 0 ? 0 : 1);
