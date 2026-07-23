// Ball rolls to the BACK of the scoring net (not stuck at the line):
//  - a FULL shot that scores in the enemy net ends deep in the net pocket
//  - a DRIBBLE-IN goal DETACHES the ball from the carrier and it rolls to the back
// Run: node test-net-roll.mjs
import { createState, addPlayer, attachBall, step } from './shared/sim.js';
import { DT, FIELD, GOAL, BALL_RADIUS } from './shared/constants.js';

let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };
const MIDY = FIELD.H / 2;
const R = BALL_RADIUS;
const RIGHT_BACK = FIELD.W + GOAL.depth - R; // deepest a ball can sit in the right net

function fresh() {
  const s = createState(); s.resetTimer = 0;
  addPlayer(s, 'p1', { name: 'A', char: 'player', team: 'A', slot: 0 }); // A attacks RIGHT
  addPlayer(s, 'p2', { name: 'B', char: 'player', team: 'B', slot: 0 });
  return s;
}
const inp = (o = {}) => ({ seq: 1, moveX: 0, moveY: 0, aimX: 1, aimY: 0, hold: false, fire: false, special: false, build: false, buildHold: false, sax: 0, say: 0, ...o });

// 1) SHOT into the right net → settles at the back
{
  const s = fresh();
  attachBall(s, 'A');
  const a = s.players.p1; a.x = FIELD.W - 320; a.y = MIDY; s.ball.x = a.x; s.ball.y = a.y;
  s.players.p2.x = 200; s.players.p2.y = 200; // keeper out of the way
  for (let i = 0; i < 66; i++) step(s, { p1: inp({ hold: true }), p2: inp() }, DT);
  step(s, { p1: inp({ fire: true }), p2: inp() }, DT);
  for (let i = 0; i < 200 && s.score.A === 0; i++) step(s, { p1: inp(), p2: inp() }, DT); // fly to goal
  ok(s.score.A === 1, `shot scored for A (A=${s.score.A})`);
  for (let i = 0; i < 60; i++) step(s, { p1: inp(), p2: inp() }, DT); // roll during the freeze hold
  ok(s.ball.x > FIELD.W + GOAL.depth * 0.5, `ball rolled deep into the net (x=${s.ball.x.toFixed(1)} > ${(FIELD.W + GOAL.depth*0.5).toFixed(1)})`);
  ok(s.ball.x <= RIGHT_BACK + 0.5, `ball stopped at/before the back netting (x=${s.ball.x.toFixed(1)} <= ${RIGHT_BACK.toFixed(1)})`);
}

// 2) DRIBBLE-IN into the right net → ball detaches from carrier and rolls to the back
{
  const s = fresh();
  attachBall(s, 'A');
  const a = s.players.p1; a.isBot = true; a.x = FIELD.W - 120; a.y = MIDY; s.ball.x = a.x; s.ball.y = a.y;
  s.players.p2.x = 200; s.players.p2.y = 200;
  let detached = false;
  for (let i = 0; i < 120 && s.score.A === 0; i++) {
    step(s, { p1: inp({ moveX: 1, aimX: 1, aimY: 0 }), p2: inp() }, DT);
    if (s.ball.owner == null) detached = true;
  }
  ok(s.score.A === 1, `dribble-in scored for A (A=${s.score.A})`);
  ok(detached && s.ball.owner == null, `ball detached from the carrier on the walk-in goal`);
  for (let i = 0; i < 60; i++) step(s, { p1: inp(), p2: inp() }, DT); // roll during the freeze hold
  ok(s.ball.x > FIELD.W + GOAL.depth * 0.5, `dribbled ball rolled deep into the net (x=${s.ball.x.toFixed(1)})`);
  ok(s.ball.x <= RIGHT_BACK + 0.5, `dribbled ball stopped at/before the back netting (x=${s.ball.x.toFixed(1)})`);
}

console.log(fails ? `\n❌ ${fails} FAIL` : '\n✅ ALL PASS');
process.exit(fails ? 1 : 0);
