// Power meter: a FULL shot/kick needs a charged meter (earned by landing ANY hit on an
// opponent). Uncharged full attempts are capped to a medium. Using a full action spends
// the meter; a hit that lands recharges it. Run: node test-power.mjs
import { createState, addPlayer, attachBall, step } from './shared/sim.js';
import { DT, FIELD, FULL_CHARGE } from './shared/constants.js';

let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };
const inp = (o = {}) => ({ seq: 1, moveX: 0, moveY: 0, aimX: 1, aimY: 0, shoot: false, special: false, build: false, charge: 0, ...o });

function duel() {
  const s = createState(); s.resetTimer = 0;
  addPlayer(s, 'A', { name: 'a', char: 'player', team: 'A', slot: 0, isBot: true });
  addPlayer(s, 'B', { name: 'b', char: 'player', team: 'B', slot: 0, isBot: true });
  s.players.A.ammo = 3;
  return s;
}

// 1) starts uncharged; a FULL bullet at a carrier while UNCHARGED can't strip (capped),
//    but landing the hit CHARGES the shooter.
{
  const s = duel(); const A = s.players.A, B = s.players.B;
  A.x = 900; A.y = 550; A.aimX = 1; A.aimY = 0;
  B.x = 1130; B.y = 550; s.ball.owner = 'B'; s.ball.x = 1160; s.ball.y = 550; s.ball.lastTouch = 'B';
  ok(A.power === false, 'players start UNCHARGED');
  step(s, { A: inp({ shoot: true, charge: 1 }) }, DT);
  for (let t = 0; t < 25; t++) { s.ball.owner === 'B' && (s.ball.x = B.x + 30); step(s, { A: inp() }, DT); if (s.ball.owner !== 'B') break; }
  ok(s.ball.owner === 'B', 'an UNCHARGED full shot cannot strip a carrier (capped to medium)');
  ok(A.power === true, 'landing that bullet on the carrier CHARGED the shooter');
}

// 2) CHARGED full bullet strips a carrier.
{
  const s = duel(); const A = s.players.A, B = s.players.B;
  A.x = 900; A.y = 550; A.aimX = 1; A.aimY = 0; A.power = true;
  B.x = 1120; B.y = 550; s.ball.owner = 'B'; s.ball.x = 1150; s.ball.y = 550; s.ball.lastTouch = 'B';
  step(s, { A: inp({ shoot: true, charge: 1 }) }, DT);
  let stripped = false;
  for (let t = 0; t < 25; t++) { if (s.ball.owner === 'B') { B.x = 1120; s.ball.x = 1150; } step(s, { A: inp() }, DT); if (s.ball.owner !== 'B') { stripped = true; break; } }
  ok(stripped, 'a CHARGED full shot strips the carrier');
}

// 3) a power shot that MISSES spends the meter (no refill without a hit).
{
  const s = duel(); const A = s.players.A;
  A.x = 1000; A.y = 550; A.aimX = 0; A.aimY = -1; A.power = true; // fire up into empty space
  step(s, { A: inp({ shoot: true, charge: 1, aimX: 0, aimY: -1 }) }, DT);
  for (let t = 0; t < 30; t++) step(s, { A: inp({ aimX: 0, aimY: -1 }) }, DT);
  ok(A.power === false, 'a full shot that misses leaves the meter EXHAUSTED');
}

// 4) the meter makes the KICK stronger: charged full kick faster than an uncharged (capped) kick.
function kickSpeed(powered) {
  const s = duel(); const C = s.players.A;
  C.x = 1000; C.y = 550; C.aimX = 1; C.aimY = 0; C.power = powered;
  s.ball.owner = 'A'; s.ball.x = 1050; s.ball.y = 550;
  step(s, { A: inp({ shoot: true, charge: 1 }) }, DT);
  return Math.hypot(s.ball.vx, s.ball.vy);
}
{
  const hi = kickSpeed(true), lo = kickSpeed(false);
  ok(hi > lo + 50, `charged power kick is stronger than an uncharged one (${hi.toFixed(0)} > ${lo.toFixed(0)})`);
}

// 5) a bomb that catches an enemy charges the bomber.
{
  const s = duel(); const A = s.players.A, B = s.players.B;
  A.x = 1000; A.y = 550; B.x = 1080; B.y = 550; A.specialCd = 0;
  step(s, { A: inp({ special: true }) }, DT);
  for (let t = 0; t < 90 && !A.power; t++) step(s, { A: inp(), B: inp() }, DT); // wait out the fuse
  ok(A.power === true, 'a bomb catching an enemy charges the bomber');
}

console.log(`\n${fails === 0 ? '✅ ALL PASS' : '❌ ' + fails + ' FAILED'}`);
process.exit(fails === 0 ? 0 : 1);
