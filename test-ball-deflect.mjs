// Shooting the BALL deflects it by the impact angle (snooker): a bullet that strikes the loose
// ball off-centre sends it off at an angle, capped to a reduced effect; a centred hit sends it
// straight down-range.
// Run: node test-ball-deflect.mjs
import { createState, addPlayer, step } from './shared/sim.js';
import { DT } from './shared/constants.js';

let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };
const inp = (o = {}) => ({ seq: 1, moveX: 0, moveY: 0, aimX: 1, aimY: 0, hold: false, fire: false, special: false, build: false, buildHold: false, sax: 0, say: 0, ...o });
const ang = (vx, vy) => Math.round(Math.atan2(vy, vx) * 180 / Math.PI);

// Fire a full bullet +x from A at a LOOSE ball parked `off` px off the bullet line. Return the
// ball's velocity the tick it's struck.
function shootBall(off) {
  const s = createState(); s.resetTimer = 0;
  addPlayer(s, 'p1', { name: 'A', char: 'player', team: 'A', slot: 0 });
  addPlayer(s, 'p2', { name: 'B', char: 'player', team: 'B', slot: 0 });
  const a = s.players.p1; a.x = 700; a.y = 550; a.aimX = 1; a.aimY = 0;
  s.players.p2.x = 200; s.players.p2.y = 200;      // enemy well clear of the shot line
  s.ball.owner = null; s.ball.x = 1000; s.ball.y = 550 + off;
  for (let i = 0; i < 70; i++) step(s, { p1: inp({ hold: true, aimX: 1, aimY: 0 }), p2: inp() }, DT); // charge
  step(s, { p1: inp({ fire: true, aimX: 1, aimY: 0 }), p2: inp() }, DT);
  for (let i = 0; i < 30; i++) {
    s.ball.x = 1000; s.ball.y = 550 + off;         // hold the ball still until the bullet arrives
    step(s, { p1: inp(), p2: inp() }, DT);
    if (Math.hypot(s.ball.vx, s.ball.vy) > 1) return { vx: s.ball.vx, vy: s.ball.vy };
  }
  return { vx: 0, vy: 0, missed: true };
}

{
  const r = shootBall(12); // ball below the line -> deflects down-forward
  ok(!r.missed, 'below-line ball shot connected');
  ok(r.vx > 5, `ball still travels forward (vx=${r.vx.toFixed(0)})`);
  ok(r.vy > 3, `ball deflects DOWN off a below-centre shot (vy=${r.vy.toFixed(0)}, ${ang(r.vx, r.vy)}°)`);
  ok(Math.abs(ang(r.vx, r.vy)) <= 22, `deflection is a REDUCED effect, not sideways (${ang(r.vx, r.vy)}° <= 22°)`);
}
{
  const r = shootBall(-12); // ball above the line -> deflects up-forward
  ok(!r.missed, 'above-line ball shot connected');
  ok(r.vy < -3, `ball deflects UP off an above-centre shot (vy=${r.vy.toFixed(0)}, ${ang(r.vx, r.vy)}°)`);
  ok(Math.abs(ang(r.vx, r.vy)) <= 22, `reduced effect, not sideways (${ang(r.vx, r.vy)}°)`);
}
{
  const r = shootBall(22); // near-edge graze — capped, never ~70-80°
  ok(!r.missed, 'edge-graze ball shot connected');
  ok(Math.abs(ang(r.vx, r.vy)) <= 22 && Math.abs(ang(r.vx, r.vy)) > 5, `edge graze capped, still forward (${ang(r.vx, r.vy)}°)`);
}
{
  const r = shootBall(0); // dead centre -> straight
  ok(!r.missed, 'centre ball shot connected');
  ok(Math.abs(r.vy) < 4, `centred shot drives the ball straight (vy=${r.vy.toFixed(0)})`);
}

console.log(fails ? `\n❌ ${fails} FAIL` : '\n✅ ALL PASS');
process.exit(fails ? 1 : 0);
