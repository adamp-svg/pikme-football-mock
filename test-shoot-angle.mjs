// Snooker deflection for SHOTS (bullets): a charged shot that strikes an enemy OFF-CENTRE
// shoves them along the line of centres (impact point -> their centre), so they squirt off at
// an angle instead of straight down-range. A centred hit still pushes straight.
// Run: node test-shoot-angle.mjs
import { createState, addPlayer, step } from './shared/sim.js';
import { DT, FIELD } from './shared/constants.js';

let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };
const inp = (o = {}) => ({ seq: 1, moveX: 0, moveY: 0, aimX: 1, aimY: 0, hold: false, fire: false, special: false, build: false, buildHold: false, sax: 0, say: 0, ...o });

// Full-charge shot down +x from A; enemy B sits ahead, `off` px off the bullet line in y.
// Returns B's knockback the tick it's hit.
function shoot(off) {
  const s = createState(); s.resetTimer = 0;
  addPlayer(s, 'p1', { name: 'A', char: 'player', team: 'A', slot: 0 });
  addPlayer(s, 'p2', { name: 'B', char: 'player', team: 'B', slot: 0 });
  s.ball.owner = null; s.ball.x = 200; s.ball.y = 200; // ball well clear
  const a = s.players.p1, b = s.players.p2;
  a.x = 800; a.y = 550; a.aimX = 1; a.aimY = 0;
  b.x = 1000; b.y = 550 + off;
  for (let i = 0; i < 100; i++) step(s, { p1: inp({ hold: true, aimX: 1, aimY: 0 }), p2: inp() }, DT); // charge to FULL
  step(s, { p1: inp({ fire: true, aimX: 1, aimY: 0 }), p2: inp() }, DT);
  for (let i = 0; i < 30; i++) {
    b.x = 1000; b.y = 550 + off; b.kvx = 0; b.kvy = 0; // pin B so we read one clean impulse
    step(s, { p1: inp(), p2: inp() }, DT);
    if (Math.abs(b.kvx) + Math.abs(b.kvy) > 0.01) return { kvx: b.kvx, kvy: b.kvy };
  }
  return { kvx: 0, kvy: 0, missed: true };
}
const ang = (r) => Math.round(Math.atan2(r.kvy, r.kvx) * 180 / Math.PI);

{
  const r = shoot(15); // enemy BELOW the line -> shoved down-forward
  ok(!r.missed, 'below-line shot connected');
  ok(r.kvx > 5, `enemy driven forward (kvx=${r.kvx.toFixed(0)})`);
  ok(r.kvy > 5, `enemy squirts DOWN off a below-centre hit (kvy=${r.kvy.toFixed(0)})`);
  ok(Math.abs(r.kvy) > 0.3 * r.kvx, `PERCEPTIBLE angle (${ang(r)}°)`);
}
{
  const r = shoot(-15); // enemy ABOVE the line -> shoved up-forward
  ok(!r.missed, 'above-line shot connected');
  ok(r.kvy < -5, `enemy squirts UP off an above-centre hit (kvy=${r.kvy.toFixed(0)})`);
  ok(Math.abs(r.kvy) > 0.3 * r.kvx, `PERCEPTIBLE angle (${ang(r)}°)`);
}
{
  const r = shoot(0); // dead centre
  ok(!r.missed, 'centre shot connected');
  ok(r.kvx > 5, `centred shot drives straight (kvx=${r.kvx.toFixed(0)})`);
  ok(Math.abs(r.kvy) < 5, `centred shot has ~no sideways component (kvy=${r.kvy.toFixed(0)})`);
}

console.log(fails ? `\n❌ ${fails} FAIL` : '\n✅ ALL PASS');
process.exit(fails ? 1 : 0);
