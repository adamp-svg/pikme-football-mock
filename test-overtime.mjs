// Golden-goal overtime: a match level at the time cap used to fall through to a flat
// תיקו. It now plays on until someone scores — bounded, because `elapsed` is packed as
// a u8 on the wire (shared/wire.js) and must never exceed 255s.
import { createState, addPlayer, step } from './shared/sim.js';
import { DT, MATCH_DURATION, OVERTIME_DURATION, GOALS_TO_WIN, KICKOFF_FREEZE, FIELD } from './shared/constants.js';

let failed = 0;
const ok = (label, cond, extra = '') => { if (!cond) failed++; console.log(`  ${cond ? '✅' : '❌'} ${label}${extra ? ` — ${extra}` : ''}`); };
const idle = {};

function fresh(goalsToWin) {
  const s = createState();
  s.goalsToWin = goalsToWin;
  addPlayer(s, 'p1', { name: 'a', char: 0, team: 'A', slot: 0 });
  addPlayer(s, 'p2', { name: 'b', char: 0, team: 'B', slot: 0 });
  for (let i = 0; i < Math.round(KICKOFF_FREEZE / DT) + 2; i++) step(s, idle, DT);
  return s;
}
// Force a goal for `team` by driving the ball over their attacking line.
function scoreFor(s, team) {
  const b = s.ball;
  b.owner = null; b.lastTouch = team; b.y = FIELD.H / 2; b.vy = 0;
  if (team === 'A') { b.x = FIELD.W - 40; b.vx = 900; } else { b.x = 40; b.vx = -900; }
  for (let i = 0; i < 20 && s.resetTimer <= 0; i++) step(s, idle, DT);
}
// Run live play until `pred` or a tick budget runs out. Freezes don't advance the clock,
// so budget on TICKS, not seconds.
function runUntil(s, pred, maxTicks = Math.round((MATCH_DURATION + OVERTIME_DURATION + 40) / DT)) {
  let t = 0;
  while (!pred(s) && t < maxTicks) { step(s, idle, DT); t++; }
  return t;
}

console.log('1) level at the cap → overtime, not a draw');
{
  const s = fresh(GOALS_TO_WIN);
  runUntil(s, (x) => x.overtime || x.phase === 'ended');
  ok('entered overtime', s.overtime === true, `phase=${s.phase} score ${s.score.A}-${s.score.B}`);
  ok('did NOT end at the cap', s.phase === 'playing');
  ok('clock is past MATCH_DURATION', s.elapsed >= MATCH_DURATION, `elapsed=${s.elapsed.toFixed(2)}`);
}

console.log('2) the next goal in overtime wins immediately');
{
  const s = fresh(GOALS_TO_WIN);
  runUntil(s, (x) => x.overtime);
  scoreFor(s, 'B');
  ok('B scored', s.score.B === 1, `score ${s.score.A}-${s.score.B}`);
  runUntil(s, (x) => x.phase === 'ended');
  ok('match ended on the golden goal', s.phase === 'ended');
  ok('winner is B, not a draw', s.score.B > s.score.A);
}

console.log('3) overtime is BOUNDED — a scoreless overtime still ends');
{
  const s = fresh(GOALS_TO_WIN);
  const ticks = runUntil(s, (x) => x.phase === 'ended');
  ok('ended', s.phase === 'ended', `after ${(ticks * DT).toFixed(1)}s of ticks`);
  ok('ended as a level draw', s.score.A === s.score.B);
  ok('ended at cap+overtime', Math.abs(s.elapsed - (MATCH_DURATION + OVERTIME_DURATION)) < 0.1, `elapsed=${s.elapsed.toFixed(2)}`);
  ok('elapsed fits the u8 wire field', s.elapsed < 255, `${s.elapsed.toFixed(0)} < 255`);
}

console.log('4) a LEAD at the cap still ends the match — no needless overtime');
{
  const s = fresh(GOALS_TO_WIN);
  scoreFor(s, 'A');
  runUntil(s, (x) => x.phase === 'ended');
  ok('ended', s.phase === 'ended');
  ok('never entered overtime', s.overtime === false);
  ok('A won 1-0', s.score.A === 1 && s.score.B === 0);
}

console.log('5) timed mode (goalsToWin 0) gets overtime too');
{
  const s = fresh(0);
  runUntil(s, (x) => x.overtime || x.phase === 'ended');
  ok('level brawl goes to overtime', s.overtime === true, `phase=${s.phase}`);
}

console.log('6) first-to-N still wins before the cap');
{
  const s = fresh(GOALS_TO_WIN);
  for (let g = 0; g < GOALS_TO_WIN; g++) { scoreFor(s, 'A'); runUntil(s, (x) => x.resetTimer <= 0 || x.phase === 'ended'); }
  ok(`A reached ${GOALS_TO_WIN}`, s.score.A === GOALS_TO_WIN, `score ${s.score.A}-${s.score.B}`);
  ok('match ended', s.phase === 'ended');
  ok('ended well before the cap', s.elapsed < MATCH_DURATION, `elapsed=${s.elapsed.toFixed(1)}`);
  ok('no overtime', s.overtime === false);
}

console.log(failed ? `\n❌ ${failed} FAILED` : '\n✅ ALL PASS');
process.exit(failed ? 1 : 0);
