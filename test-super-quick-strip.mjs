// SUPER vs a ball-carrier. The model:
//  - Landing ANY bullet on an enemy carrier (body or its held ball) EARNS super (quick→1/3).
//  - IN super, EVERY shot type detaches the ball: a quick jostles it ~½ a ball-length, a
//    medium/full strips it fully.
//  - Outside super, a quick/medium shot is absorbed (carrier protected) but still earns.
// Run: node test-super-quick-strip.mjs
import { createState, addPlayer, step } from './shared/sim.js';
import { DT, QUICK_CHARGE, FULL_CHARGE, OVERCHARGE_TTL, OVERCHARGE_PARTIAL_GAIN, BALL_RADIUS, SHOOT_CHARGE_TIME, BALL_FRICTION, BALL_MIN_SPEED } from './shared/constants.js';

let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };
const inp = (o = {}) => ({ seq: 1, moveX: 0, moveY: 0, aimX: 1, aimY: 0, hold: false, fire: false, special: false, build: false, ...o });
const rollDist = (v0) => { let v = v0, d = 0; while (v >= BALL_MIN_SPEED) { d += v * DT; v *= BALL_FRICTION; } return d; };

function duel() {
  const s = createState(); s.resetTimer = 0;
  addPlayer(s, 'A', { name: 'a', char: 'player', team: 'A', slot: 0, isBot: true });
  addPlayer(s, 'B', { name: 'b', char: 'player', team: 'B', slot: 0, isBot: true });
  s.players.A.ammo = 9;
  return s;
}
function setup(inSuper) {
  const s = duel(); const A = s.players.A, B = s.players.B;
  A.x = 900; A.y = 550; A.aimX = 1; A.aimY = 0;
  if (inSuper) { A.power = true; A.powerT = OVERCHARGE_TTL; }
  B.x = 1000; B.y = 550; s.ball.owner = 'B'; s.ball.x = 1010; s.ball.y = 550; s.ball.lastTouch = 'B';
  return s;
}
// Fire a shot of target `charge` from A at B, then run the bullet out.
function shootAt(s, charge, keepB = true) {
  const n = Math.max(0, Math.round(charge * SHOOT_CHARGE_TIME * 60));
  for (let i = 0; i < n; i++) step(s, { A: inp({ hold: true }), B: inp() }, DT);
  step(s, { A: inp({ fire: true }), B: inp() }, DT);
  const B = s.players.B;
  for (let t = 0; t < 20; t++) {
    if (keepB && s.ball.owner === 'B') { B.x = 1000; B.vx = 0; s.ball.x = 1010; s.ball.y = 550; }
    step(s, { A: inp(), B: inp() }, DT);
    if (s.ball.owner !== 'B') return { detached: true, pop: Math.hypot(s.ball.vx, s.ball.vy) };
  }
  return { detached: false, pop: 0 };
}

// 1) OUTSIDE super, a QUICK shot at the carrier EARNS super (refills the meter), ball NOT stripped.
{
  const s = setup(false); const A = s.players.A;
  const before = A.powerMeter;
  const r = shootAt(s, 0.1); // quick
  ok(!r.detached, 'outside super: a quick shot does NOT strip the carrier (protected)');
  ok(A.powerMeter > before + 0.2, `quick shot REFILLS super (meter ${before}->${A.powerMeter.toFixed(2)})`);
}
// 2) IN super, a QUICK shot detaches + pushes ~½ a ball-length.
{
  const s = setup(true);
  const r = shootAt(s, 0.1);
  ok(r.detached, 'in super: a quick shot detaches the ball');
  const roll = rollDist(r.pop);
  ok(roll > BALL_RADIUS * 0.4 && roll < BALL_RADIUS * 1.8, `quick pushes ~½ a ball-length (roll≈${roll.toFixed(0)}px)`);
}
// 3) IN super, a MEDIUM shot detaches (full strip, bigger pop).
{
  const s = setup(true);
  const r = shootAt(s, 0.4); // medium (>=QUICK, <FULL)
  ok(r.detached, 'in super: a medium shot also detaches the ball');
  ok(rollDist(r.pop) > BALL_RADIUS * 1.8, 'medium strips harder than the quick jostle');
}
// 4) OUTSIDE super, a MEDIUM shot is absorbed (protected) but earns.
{
  const s = setup(false); const A = s.players.A;
  const before = A.powerMeter;
  const r = shootAt(s, 0.4);
  ok(!r.detached, 'outside super: a medium shot does NOT strip the carrier');
  ok(A.powerMeter > before + 0.2, 'medium shot also refills super');
}
// 5) UNGATED full shot still strips outside super.
{
  const s = setup(false);
  const r = shootAt(s, 1);
  ok(r.detached, 'a FULL shot strips the carrier even without super (ungated)');
}

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
