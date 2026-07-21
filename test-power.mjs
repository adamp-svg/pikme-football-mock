// Power tiers (mechanics v2). Charge is SIM-OWNED: hold the trigger to build it.
//   FULL (>= FULL_CHARGE) is hold-based and UNGATED — anyone reaching full strips a
//     carrier, and a full KICK into an enemy STOPS the ball dead (keeper-diminish in
//     the defender's own box only deflects it).
//   OVERCHARGE (p.power) is EARNED by a FORCEFUL hit (>= QUICK_CHARGE / bomb), DECAYS
//     if unused, is SPENT on an overcharge kick, and makes that kick ROLL THROUGH an
//     enemy. A quick poke never earns it, and an overcharge kick can't self-farm it.
// Run: node test-power.mjs
import { createState, addPlayer, step } from './shared/sim.js';
import { DT, FULL_CHARGE, OVERCHARGE_TTL } from './shared/constants.js';

let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };
const inp = (o = {}) => ({ seq: 1, moveX: 0, moveY: 0, aimX: 1, aimY: 0, hold: false, fire: false, special: false, build: false, ...o });
const ticks = (sec) => Math.round(sec / DT);

function duel() {
  const s = createState(); s.resetTimer = 0;
  addPlayer(s, 'A', { name: 'a', char: 'player', team: 'A', slot: 0, isBot: true });
  addPlayer(s, 'B', { name: 'b', char: 'player', team: 'B', slot: 0, isBot: true });
  s.players.A.ammo = 3;
  return s;
}
// HOLD to build charge (~1s = full), then release (fire). `others` = co-players' idle inputs.
function shoot(s, id, charge, aim = [1, 0], others = {}) {
  const n = Math.max(0, Math.round(charge * 60));
  for (let i = 0; i < n; i++) step(s, { [id]: inp({ hold: true, aimX: aim[0], aimY: aim[1] }), ...others }, DT);
  step(s, { [id]: inp({ fire: true, aimX: aim[0], aimY: aim[1] }), ...others }, DT);
}

// 1) FULL is UNGATED: a full bullet strips a carrier with NO meter, and landing the hit
//    (forceful) EARNS overcharge.
{
  const s = duel(); const A = s.players.A, B = s.players.B;
  A.x = 900; A.y = 550; A.aimX = 1; A.aimY = 0;
  B.x = 1120; B.y = 550; s.ball.owner = 'B'; s.ball.x = 1150; s.ball.y = 550; s.ball.lastTouch = 'B';
  ok(A.power === false, 'players start with NO overcharge');
  shoot(s, 'A', 1, [1, 0], { B: inp() });
  let stripped = false;
  for (let t = 0; t < 25; t++) { if (s.ball.owner === 'B') { B.x = 1120; s.ball.x = 1150; } step(s, { A: inp(), B: inp() }, DT); if (s.ball.owner !== 'B') { stripped = true; break; } }
  ok(stripped, 'an UNGATED full shot strips the carrier (no meter needed)');
  ok(A.power === true, 'landing that forceful bullet EARNED overcharge');
}

// 2) a QUICK poke does NOT earn overcharge (only forceful hits do).
{
  const s = duel(); const A = s.players.A, B = s.players.B;
  A.x = 800; A.y = 550; A.aimX = 1; A.aimY = 0; B.x = 1000; B.y = 550;
  shoot(s, 'A', 0.1, [1, 0], { B: inp() }); // < QUICK_CHARGE
  for (let t = 0; t < 20; t++) step(s, { A: inp(), B: inp() }, DT);
  ok(A.power === false, 'a quick poke does NOT earn overcharge');
}

// 3) overcharge DECAYS if unused.
{
  const s = duel(); const A = s.players.A;
  A.power = true; A.powerT = OVERCHARGE_TTL;
  for (let t = 0; t < ticks(OVERCHARGE_TTL + 0.5); t++) step(s, { A: inp() }, DT);
  ok(A.power === false, 'overcharge decays to empty after its TTL');
}

// 4) a FULL kick into an enemy STOPS the ball (no attach); an OVERCHARGE kick ROLLS it
//    through AND spends the meter.
function kickInto(overcharged) {
  const s = duel(); const A = s.players.A, B = s.players.B;
  A.x = 1000; A.y = 550; A.aimX = 1; A.aimY = 0;
  if (overcharged) { A.power = true; A.powerT = OVERCHARGE_TTL; }
  s.ball.owner = 'A'; s.ball.x = 1030; s.ball.y = 550; s.ball.lastTouch = 'A';
  B.x = 1160; B.y = 550; // open field (B's box is x>1640)
  shoot(s, 'A', 1, [1, 0], { B: inp() });
  let ballAtBump = null;
  for (let t = 0; t < 40; t++) { step(s, { A: inp(), B: inp() }, DT); if (s.players.B.kvx > 30 && ballAtBump === null) ballAtBump = Math.hypot(s.ball.vx, s.ball.vy); }
  return { ballAtBump: ballAtBump == null ? Math.hypot(s.ball.vx, s.ball.vy) : ballAtBump, spent: !s.players.A.power };
}
{
  const full = kickInto(false);
  ok(full.ballAtBump < 30, `a FULL kick STOPS on an enemy (ball speed ~${full.ballAtBump.toFixed(0)})`);
  const over = kickInto(true);
  ok(over.ballAtBump > 60, `an OVERCHARGE kick ROLLS the ball through (ball speed ~${over.ballAtBump.toFixed(0)})`);
  ok(over.spent, 'an overcharge kick SPENDS the meter');
}

// 5) the charged KICK is stronger than a weak one (hold = more power).
function kickSpeed(charge) {
  const s = duel(); const C = s.players.A;
  C.x = 1000; C.y = 550; C.aimX = 1; C.aimY = 0;
  s.ball.owner = 'A'; s.ball.x = 1050; s.ball.y = 550;
  shoot(s, 'A', charge, [1, 0], { B: inp() });
  return Math.hypot(s.ball.vx, s.ball.vy);
}
{
  const hi = kickSpeed(1), lo = kickSpeed(0.1);
  ok(hi > lo + 50, `a full-charge kick is stronger than a weak one (${hi.toFixed(0)} > ${lo.toFixed(0)})`);
}

// 5b) REGRESSION (review #1): a fast ball from a NON-kick origin (bullet-pushed) that
//     bumps an enemy must NOT earn overcharge for a stale earlier kicker.
{
  const s = duel(); const A = s.players.A, B = s.players.B;
  A.x = 400; A.y = 200; A.power = false; A.powerT = 0; // the stale kicker, far away & uninvolved
  s.ball.owner = null; s.ball.x = 1000; s.ball.y = 550; s.ball.vx = 0; s.ball.vy = 0;
  s.ball.lastTouch = 'A'; s.ball.lastKicker = 'A'; s.ball.kickTier = 0; s.ball.overSpent = false;
  addPlayer(s, 'A2', { name: 'a2', char: 'player', team: 'A', slot: 1, isBot: true });
  const A2 = s.players.A2; A2.x = 850; A2.y = 550; A2.aimX = 1; A2.aimY = 0; A2.ammo = 3;
  B.x = 1120; B.y = 550;
  shoot(s, 'A2', 1, [1, 0], { A: inp(), B: inp() }); // full bullet pushes the loose ball into B
  for (let t = 0; t < 40; t++) step(s, { A: inp(), B: inp() }, DT);
  ok(A.power === false, 'a non-kick (bullet-pushed) ball bumping an enemy does NOT earn a stale kicker overcharge');
}

// 6) a bomb that catches an enemy earns the bomber overcharge.
{
  const s = duel(); const A = s.players.A, B = s.players.B;
  A.x = 1000; A.y = 550; B.x = 1080; B.y = 550; A.specialCd = 0;
  step(s, { A: inp({ special: true }), B: inp() }, DT);
  for (let t = 0; t < 90 && !A.power; t++) step(s, { A: inp(), B: inp() }, DT); // wait out the fuse
  ok(A.power === true, 'a bomb catching an enemy earns the bomber overcharge');
}

console.log(`\n${fails === 0 ? '✅ ALL PASS' : '❌ ' + fails + ' FAILED'}`);
process.exit(fails === 0 ? 0 : 1);
