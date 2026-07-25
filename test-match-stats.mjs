// Per-player match stats: goal credit (shot AND dribble-in), assist credit on a pass,
// touches, possession seconds and distance. See player.stat in shared/sim.js.
// Run: node test-match-stats.mjs
import { createState, addPlayer, step, attachBall } from './shared/sim.js';
import { DT, FIELD, GOAL } from './shared/constants.js';

let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };
const inp = (o = {}) => ({ seq: 1, moveX: 0, moveY: 0, aimX: 1, aimY: 0, hold: false, fire: false, aimed: false, special: false, build: false, ...o });

function game() {
  const s = createState(); s.resetTimer = 0;
  addPlayer(s, 'A1', { name: 'a1', char: 'player', team: 'A', slot: 0, isBot: true });
  addPlayer(s, 'A2', { name: 'a2', char: 'player', team: 'A', slot: 1, isBot: true });
  addPlayer(s, 'B1', { name: 'b1', char: 'player', team: 'B', slot: 0, isBot: true });
  return s;
}
const idle = (s) => Object.fromEntries(Object.keys(s.players).map((k) => [k, inp()]));

// 1) Every player starts with a zeroed stat block.
{
  const s = game();
  const st = s.players.A1.stat;
  ok(st && st.goals === 0 && st.assists === 0 && st.touches === 0, 'players start with a zeroed stat block');
}

// 2) DRIBBLE-IN goal is credited (clearKick nulls lastKicker → falls back to the touch chain).
{
  const s = game(); const A1 = s.players.A1;
  A1.x = FIELD.W - 90; A1.y = FIELD.H / 2; A1.aimX = 1; A1.aimY = 0;
  s.ball.owner = 'A1'; s.ball.lastPlayer = 'A1'; s.ball.lastTouch = 'A';
  s.ball.x = A1.x + 40; s.ball.y = A1.y;
  let scored = false;
  for (let t = 0; t < 240 && !scored; t++) {
    step(s, { ...idle(s), A1: inp({ moveX: 1, aimX: 1 }) }, DT);
    if (s.score.A > 0) scored = true;
  }
  ok(scored, 'a carrier dribbles the ball into the net → goal');
  ok(A1.stat.goals === 1, `dribble-in goal is CREDITED to the carrier (goals=${A1.stat.goals})`);
}

// 3) ASSIST: A2 holds, A1 takes over and scores → A2 gets the assist, A1 the goal.
{
  const s = game(); const A1 = s.players.A1, A2 = s.players.A2;
  const b = s.ball;
  b.lastPlayer = 'A2'; b.prevPlayer = null;          // A2 had it...
  A1.x = FIELD.W - 90; A1.y = FIELD.H / 2; A1.aimX = 1; A1.aimY = 0;
  b.owner = null; b.pickupCd = 0; b.x = A1.x + 20; b.y = A1.y; b.vx = 0; b.vy = 0;
  let scored = false;
  for (let t = 0; t < 240 && !scored; t++) {          // ...A1 picks it up (chain: prev=A2, last=A1) and walks it in
    step(s, { ...idle(s), A1: inp({ moveX: 1, aimX: 1 }) }, DT);
    if (s.score.A > 0) scored = true;
  }
  ok(scored, 'pass → team-mate scores');
  ok(A1.stat.goals === 1, `scorer credited (A1 goals=${A1.stat.goals})`);
  ok(A2.stat.assists === 1, `previous holder credited with the ASSIST (A2 assists=${A2.stat.assists})`);
  ok(A1.stat.assists === 0, 'the scorer does not also get the assist');
}

// 4) Touches + possession + distance accumulate for a carrier.
{
  const s = game(); const A1 = s.players.A1;
  A1.x = 600; A1.y = 550; A1.aimX = 1; A1.aimY = 0;
  s.ball.owner = null; s.ball.pickupCd = 0; s.ball.x = 620; s.ball.y = 550;
  for (let t = 0; t < 60; t++) step(s, { ...idle(s), A1: inp({ moveY: 1 }) }, DT);
  ok(A1.stat.touches >= 1, `picking the ball up counts a TOUCH (touches=${A1.stat.touches})`);
  ok(A1.stat.possSec > 0.5, `possession seconds accumulate while carrying (possSec=${A1.stat.possSec.toFixed(2)})`);
  ok(A1.stat.distPx > 50, `distance accumulates while moving (distPx=${Math.round(A1.stat.distPx)})`);
}

// 5) A kickoff attach resets the touch chain (no assist leaks across a goal).
{
  const s = game();
  s.ball.lastPlayer = 'B1'; s.ball.prevPlayer = 'A2';
  attachBall(s, 'A');
  ok(s.ball.prevPlayer === null, 'kickoff clears prevPlayer (no stale assist)');
  ok(s.ball.lastPlayer === s.ball.owner, 'kickoff sets the touch chain to the new holder');
}

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
