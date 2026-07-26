// Tests for the 2026-07-26 "always chase, always contest, always know the ball" work.
// Run: node test-bot-chase.mjs      (spec: docs/superpowers/specs/2026-07-26-bot-chase-press-obstacles-design.md)
//
// Every case is a hand-built fixture in the REAL sim on the REAL shipped arena, because the whole
// point of the change is behaviour the bots get wrong on a layout they were not tuned against.
import { createState, addPlayer, step, setField } from './shared/sim.js';
import { MAIN_FIELD } from './shared/main-field.js';
import {
  computeBotInputs, createBotMemory, assignRoles, bmemForTest, interceptPoint,
} from './shared/bot-ai.js';
import { DT, FIELD, BOMB, CHARACTERS } from './shared/constants.js';
import { pointInBush } from './shared/arena.js';

let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };
const hyp = Math.hypot;

// A 2v2 on MAIN_FIELD with everyone parked where the test wants them.
function fixture(opts = {}) {
  const s = createState(); s.resetTimer = 0; s.goalsToWin = 0;
  if (opts.field !== null) setField(s, opts.field || MAIN_FIELD);
  for (const [id, team, slot] of [['A0', 'A', 0], ['A1', 'A', 1], ['B0', 'B', 0], ['B1', 'B', 1]])
    addPlayer(s, id, { name: id, char: 'player', team, slot, isBot: true });
  const mem = createBotMemory('normal');
  mem.teamSkill = { A: opts.skill ?? 0.93, B: opts.skill ?? 0.93 };
  return { s, mem };
}
const put = (s, id, x, y, vx = 0, vy = 0) => { const p = s.players[id]; p.x = x; p.y = y; p.vx = vx; p.vy = vy; };
const loose = (s, x, y, vx = 0, vy = 0) => { s.ball.owner = null; s.ball.x = x; s.ball.y = y; s.ball.vx = vx; s.ball.vy = vy; };

// ---------------------------------------------------------------- 1. the ball is never hidden
{
  const { s, mem } = fixture();
  // (1000,550) is the kickoff spot and it sits inside the DEFAULT arena's "centre contest bush"
  // {x:850,y:430,w:300,h:240} — a box MAIN_FIELD does not have. pointInBush() reads that box on
  // every layout, which is exactly the defect.
  ok(pointInBush(1000, 550) === true, 'premise: (1000,550) is inside the DEFAULT arena bush box');
  loose(s, 1000, 550);
  put(s, 'A0', 300, 200); put(s, 'A1', 340, 900); put(s, 'B0', 1700, 200); put(s, 'B1', 1740, 900);
  const role = assignRoles(s, 'A', mem, DT);
  ok(role.belief.visible === true, 'a loose ball in a phantom bush is still KNOWN');
  ok(hyp(role.belief.x - 1000, role.belief.y - 550) < 1, `belief position is exact (${role.belief.x.toFixed(0)},${role.belief.y.toFixed(0)})`);

  // ...and a CARRIED ball far outside anyone's view box is known too (the off-screen arrow).
  const f2 = fixture();
  put(f2.s, 'B0', 1900, 1000); f2.s.ball.owner = 'B0'; f2.s.ball.x = 1900; f2.s.ball.y = 1000;
  put(f2.s, 'A0', 100, 100); put(f2.s, 'A1', 140, 200); put(f2.s, 'B1', 1700, 900);
  const r2 = assignRoles(f2.s, 'A', f2.mem, DT);
  ok(r2.belief.visible === true && hyp(r2.belief.x - 1900, r2.belief.y - 1000) < 1,
    'a carried ball across the pitch is known (no fog on the BALL)');
}

// ---------------------------------------------------------------- 2. the chaser commits, full force
{
  const { s, mem } = fixture();
  loose(s, 1000, 550);
  put(s, 'A0', 700, 550); put(s, 'A1', 300, 900); put(s, 'B0', 1700, 200); put(s, 'B1', 1740, 900);
  const chaser0 = (() => { const r = assignRoles(s, 'A', mem, DT); return r.onBall; })();
  const d0 = hyp(s.ball.x - s.players[chaser0].x, s.ball.y - s.players[chaser0].y);
  let got = false, sawCommit = false, builtWhileLoose = false;
  for (let t = 0; t < 90 && !got; t++) {                 // 1.5s of REAL ticks (step, not just decide)
    const inp = computeBotInputs(s, mem, DT);
    const ch = mem.teams.A.chaser;
    if (ch && bmemForTest(mem, ch).lastTrick === 'chaseCommit') sawCommit = true;
    if (ch && (inp[ch].buildHold || inp[ch].build)) builtWhileLoose = true;
    step(s, inp, DT);
    if (s.ball.owner && s.players[s.ball.owner].team === 'A') got = true;
  }
  ok(sawCommit, 'the chase is a tagged commitment (chaseCommit fires)');
  ok(!builtWhileLoose, 'the chaser never winds up a wall while the ball is loose');
  const chaser = mem.teams.A.chaser || chaser0;
  const d1 = hyp(s.ball.x - s.players[chaser].x, s.ball.y - s.players[chaser].y);
  ok(got || d1 < d0 - 120, `the chaser closes on the loose ball (${d0.toFixed(0)}px -> ${got ? 'COLLECTED' : d1.toFixed(0) + 'px'})`);
}

// ---------------------------------------------------------------- 3. a frozen bot does not own the chase
{
  const { s, mem } = fixture();
  loose(s, 1000, 550);
  put(s, 'A0', 980, 560);   // nearest by distance...
  put(s, 'A1', 1240, 620);  // ...but A0 is standing on a live bomb fuse
  assignRoles(s, 'A', mem, DT);
  // bot memories are created lazily inside decideBot, so plant the commitment directly
  mem.bots.A0 = { ...(mem.bots.A0 || {}), bombHold: { x: 980, y: 560, until: mem.t + 2, aimX: 1480, aimY: 560 } };
  mem.t += 1; mem.teams.A.since = 0;       // clear the hysteresis hold
  const role = assignRoles(s, 'A', mem, DT);
  ok(role.onBall === 'A1', `a bot frozen on a fuse does not own the chase (got ${role.onBall})`);
}

// ---------------------------------------------------------------- 4. intercept the carrier's run
{
  const { s, mem } = fixture();
  // B0 carries and runs straight down the pitch; A0 is 400px behind it on the x axis.
  put(s, 'B0', 1000, 300, 0, 300);
  s.ball.owner = 'B0'; s.ball.x = 1000; s.ball.y = 300;
  put(s, 'A0', 600, 300); put(s, 'A1', 500, 800); put(s, 'B1', 1500, 800);
  const ip = interceptPoint(s.players.A0, s.players.B0, s, { leadGain: 1 });
  ok(ip.y > 300 + 40, `intercept leads the carrier down its run (y ${ip.y.toFixed(0)} vs carrier 300)`);
  const ipNoLead = interceptPoint(s.players.A0, { ...s.players.B0, vx: 0, vy: 0 }, s, { leadGain: 1 });
  ok(Math.abs(ipNoLead.y - 300) < 25, 'a standing carrier is approached directly, not led');
}

// ---------------------------------------------------------------- 5. somebody always presses
{
  const { s, mem } = fixture();
  put(s, 'B0', 1000, 550, 0, 0);
  s.ball.owner = 'B0'; s.ball.x = 1000; s.ball.y = 550;
  put(s, 'A0', 980, 900);    // on-ball, but about to be frozen on a fuse
  put(s, 'A1', 700, 200);    // support, held at MIN_SEP today
  put(s, 'B1', 1600, 550);
  assignRoles(s, 'A', mem, DT);
  const onBall = mem.teams.A.onBall, sup = mem.teams.A.support;
  const op = s.players[onBall];
  mem.bots[onBall] = { ...(mem.bots[onBall] || {}), bombHold: { x: op.x, y: op.y, until: mem.t + 2.5, aimX: op.x + 500, aimY: op.y } };
  let d = 1e9;
  for (let i = 0; i < 150; i++) {                   // 2.5s of real ticks
    const inp = computeBotInputs(s, mem, DT);
    // apply only team A: team B holds still so the test measures OUR closing, not their running
    step(s, { A0: inp.A0, A1: inp.A1 }, DT);
    s.ball.owner = 'B0'; s.ball.x = s.players.B0.x + 58; s.ball.y = s.players.B0.y;
    d = Math.min(d, hyp(s.players[sup].x - s.players.B0.x, s.players[sup].y - s.players.B0.y));
  }
  ok(bmemForTest(mem, sup).lastTrick === 'secondPress' || d < 320,
    `the support closes on the carrier when nobody else presses (min gap ${d.toFixed(0)}px)`);
}

// ---------------------------------------------------------------- 6. a carrier avoids a ball-popping gap
{
  // Two capsules leaving a 74px gap: a 42px-diameter BODY fits, a carrier's glue spot (58.25px in
  // front of its centre) does not — sim.js:919 pops the ball the instant that spot touches stone.
  const field = {
    version: 1, bushes: [], crates: [], dryWalls: [],
    hardWalls: [
      { cx: 1000, cy: 400, angle: 0, hl: 200, ht: 16 },
      { cx: 1000, cy: 700, angle: 0, hl: 200, ht: 16 },
    ],
  };
  const { s, mem } = fixture({ field });
  put(s, 'A0', 700, 550); put(s, 'A1', 300, 300); put(s, 'B0', 1700, 300); put(s, 'B1', 1700, 800);
  s.ball.owner = 'A0'; s.ball.x = 758; s.ball.y = 550;   // glued in front, pointing at the gap
  s.players.A0.aimX = 1; s.players.A0.aimY = 0;
  let popped = 0;
  for (let t = 0; t < 240; t++) {                         // 4s: enough to cross or go round
    const inp = computeBotInputs(s, mem, DT);
    const had = s.ball.owner === 'A0';
    step(s, inp, DT);
    if (had && s.ball.owner !== 'A0' && !inp.A0.fire) popped++;   // lost it WITHOUT kicking = wall pop
  }
  ok(popped === 0, `the carrier crossed without popping its ball on the gap (pops ${popped})`);
}

// ---------------------------------------------------------------- 7. a bomb jump into a wall is refused
{
  const field = {
    version: 1, bushes: [], crates: [], dryWalls: [],
    hardWalls: [{ cx: 1000, cy: 550, angle: Math.PI / 2, hl: 260, ht: 16 }],  // vertical wall mid-pitch
  };
  const { s, mem } = fixture({ field });
  // A0 far from a loose ball on the OTHER side of the wall: the chase jump would fly into stone.
  loose(s, 1500, 550);
  put(s, 'A0', 400, 550); put(s, 'A1', 300, 900); put(s, 'B0', 1800, 200); put(s, 'B1', 1750, 900);
  let jumpedIntoWall = false;
  for (let t = 0; t < 120; t++) {
    const inp = computeBotInputs(s, mem, DT);
    if (inp.A0 && inp.A0.special) jumpedIntoWall = true;
    step(s, inp, DT);
  }
  const clear = fixture({ field: { version: 1, bushes: [], crates: [], dryWalls: [], hardWalls: [] } });
  loose(clear.s, 1500, 550);
  put(clear.s, 'A0', 400, 550); put(clear.s, 'A1', 300, 900); put(clear.s, 'B0', 1800, 200); put(clear.s, 'B1', 1750, 900);
  let jumpedClear = false;
  for (let t = 0; t < 120; t++) {
    const inp = computeBotInputs(clear.s, clear.mem, DT);
    if (inp.A0 && inp.A0.special) jumpedClear = true;
    step(clear.s, inp, DT);
  }
  ok(!jumpedIntoWall, 'a chase jump whose flight path crosses a wall is refused');
  ok(jumpedClear, 'the same chase jump on an open pitch is taken (the test can actually fire)');
}

console.log(`\n${fails === 0 ? '✅ ALL PASS' : '❌ ' + fails + ' FAILED'}`);
process.exit(fails === 0 ? 0 : 1);
