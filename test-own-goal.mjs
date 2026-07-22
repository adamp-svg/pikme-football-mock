// Sim tests for goal/wall containment:
//  - the ball can NEVER enter a team's OWN goal (shot or dribble) — the line is a wall
//  - the ball can NEVER leave the field; a carried ball popped loose off a wall stays in
//  - the ENEMY goal still concedes a dribble-in (regression guard)
// Run: node test-own-goal.mjs   (exits non-zero on any failure)
import { createState, addPlayer, attachBall, step } from './shared/sim.js';
import { DT, FIELD, GOAL, BALL_RADIUS } from './shared/constants.js';

let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fails++; };
const GOAL_TOP = (FIELD.H - GOAL.width) / 2, GOAL_BOTTOM = (FIELD.H + GOAL.width) / 2, MIDY = FIELD.H / 2;

function fresh() {
  const s = createState();
  s.resetTimer = 0;
  addPlayer(s, 'p1', { name: 'A', char: 'player', team: 'A', slot: 0 }); // A attacks RIGHT, defends LEFT
  addPlayer(s, 'p2', { name: 'B', char: 'player', team: 'B', slot: 0 }); // B attacks LEFT,  defends RIGHT
  return s;
}
function inp(o = {}) { return { seq: 1, moveX: 0, moveY: 0, aimX: 1, aimY: 0, hold: false, fire: false, special: false, build: false, buildHold: false, sax: 0, say: 0, ...o }; }

// 1) OWN-GOAL SHOT: A holds the ball near its own (left) goal and blasts a FULL shot at it.
//    (Full charge honours aim; a partial would auto-aim at the enemy goal instead.)
{
  const s = fresh();
  attachBall(s, 'A');
  const a = s.players.p1; a.x = 280; a.y = MIDY; s.ball.x = a.x; s.ball.y = a.y;
  const aim = [-1, 0];
  // charge ~1.1s of hold, then fire toward the own goal
  for (let i = 0; i < 66; i++) step(s, { p1: inp({ hold: true, aimX: aim[0], aimY: aim[1] }), p2: inp() }, DT);
  step(s, { p1: inp({ fire: true, aimX: aim[0], aimY: aim[1] }), p2: inp() }, DT);
  let minX = Infinity, bounced = false;
  for (let i = 0; i < 240; i++) {
    step(s, { p1: inp({ moveX: 1 }), p2: inp() }, DT); // A runs away so it can't just re-grab
    minX = Math.min(minX, s.ball.x);
    if (s.ball.vx > 5) bounced = true;
  }
  ok(s.score.A === 0 && s.score.B === 0, `own-goal shot did not score (A=${s.score.A} B=${s.score.B})`);
  ok(minX >= 0, `ball never crossed the own goal line (minX=${minX.toFixed(1)} >= 0)`);
  ok(bounced, `ball bounced back off the goal-line wall (vx went positive)`);
}

// 2) OWN-GOAL DRIBBLE: A walks the ball straight into its own (left) goal mouth.
{
  const s = fresh();
  attachBall(s, 'A');
  const a = s.players.p1; a.isBot = true; // bot carrier: auto-aim is human-only, so its manual aim drives the ball at the own goal
  a.x = 300; a.y = MIDY; s.ball.x = a.x - 30; s.ball.y = a.y;
  let minX = Infinity, detached = false;
  for (let i = 0; i < 300; i++) {
    step(s, { p1: inp({ moveX: -1, aimX: -1, aimY: 0 }), p2: inp() }, DT);
    minX = Math.min(minX, s.ball.x);
    if (s.ball.owner == null) detached = true;
  }
  ok(s.score.A === 0 && s.score.B === 0, `own-goal dribble did not score (A=${s.score.A} B=${s.score.B})`);
  ok(minX >= 0, `dribbled ball never entered the own net (minX=${minX.toFixed(1)} >= 0)`);
  ok(detached, `ball detached from the carrier at the own-goal line (rolls like a wall)`);
}

// 3) ENEMY-GOAL DRIBBLE still concedes (regression): A walks the ball into the RIGHT net.
{
  const s = fresh();
  attachBall(s, 'A');
  const a = s.players.p1; a.x = FIELD.W - 200; a.y = MIDY; s.ball.x = a.x + 30; s.ball.y = a.y;
  s.players.p2.x = 200; s.players.p2.y = 200; // keep B far away
  for (let i = 0; i < 240 && s.score.A === 0; i++) step(s, { p1: inp({ moveX: 1, aimX: 1, aimY: 0 }), p2: inp() }, DT);
  ok(s.score.A === 1, `dribble into the ENEMY goal still scores (A=${s.score.A})`);
}

// 4) TOUCHLINE: A walks the ball straight up into the top wall — it must stay in the field
//    and pop loose off the carrier (the ball can never leave the pitch).
{
  const s = fresh();
  attachBall(s, 'A');
  const a = s.players.p1; a.isBot = true; // bot carrier so manual aim drives it into the wall (auto-aim is human-only)
  a.x = FIELD.W / 2; a.y = 200; s.ball.x = a.x; s.ball.y = a.y - 30;
  let minY = Infinity, detached = false;
  for (let i = 0; i < 300; i++) {
    step(s, { p1: inp({ moveX: 0, moveY: -1, aimX: 0, aimY: -1 }), p2: inp() }, DT);
    minY = Math.min(minY, s.ball.y);
    if (s.ball.owner == null) detached = true;
  }
  ok(minY >= BALL_RADIUS - 0.5, `ball never left the top touchline (minY=${minY.toFixed(1)} >= ${BALL_RADIUS})`);
  ok(detached, `carried ball popped loose against the touchline wall`);
}

// 5) HARD SHOT AT THE CORNER never escapes the pitch (free-ball containment sanity).
{
  const s = fresh();
  attachBall(s, 'A');
  const a = s.players.p1; a.x = FIELD.W / 2; a.y = MIDY; s.ball.x = a.x; s.ball.y = a.y;
  const aim = [0.9, -0.6];
  for (let i = 0; i < 66; i++) step(s, { p1: inp({ hold: true, aimX: aim[0], aimY: aim[1] }), p2: inp() }, DT);
  step(s, { p1: inp({ fire: true, aimX: aim[0], aimY: aim[1] }), p2: inp() }, DT);
  let inBounds = true;
  for (let i = 0; i < 300; i++) {
    step(s, { p1: inp(), p2: inp() }, DT);
    const b = s.ball;
    const inMouthX = b.y > GOAL_TOP && b.y < GOAL_BOTTOM;
    if (b.y < -1 || b.y > FIELD.H + 1) inBounds = false;
    if (!inMouthX && (b.x < -1 || b.x > FIELD.W + 1)) inBounds = false; // outside the mouth, ends are solid
  }
  ok(inBounds, `a hard free shot stayed inside the pitch (never left the field)`);
}

console.log(fails ? `\n❌ ${fails} FAIL` : '\n✅ ALL PASS');
process.exit(fails ? 1 : 0);
