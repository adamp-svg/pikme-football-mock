// Snooker deflection: a kicked ball shoves an enemy ALONG the line of centres, so WHERE it
// strikes them decides the angle. Ball below the enemy -> enemy shoved down + ball glances up;
// ball above -> mirror; dead-centre -> straight push, no sideways component.
// Run: node test-snooker.mjs
import { createState, addPlayer, step } from './shared/sim.js';
import { DT } from './shared/constants.js';

let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };
const inp = (o = {}) => ({ seq: 1, moveX: 0, moveY: 0, aimX: 1, aimY: 0, hold: false, fire: false, special: false, build: false, buildHold: false, sax: 0, say: 0, ...o });

// Fire a stationary full-tier ball at an enemy planted at (ex,ey); the ball starts left of it
// at y = ey + dy. Returns the enemy's knockback + the ball velocity right after the bump.
function strike(dy) {
  const s = createState(); s.resetTimer = 0;
  addPlayer(s, 'p1', { name: 'A', char: 'player', team: 'A', slot: 0 });
  addPlayer(s, 'p2', { name: 'B', char: 'player', team: 'B', slot: 0 });
  const e = s.players.p2; e.x = 1000; e.y = 550; e.vx = e.vy = e.kvx = e.kvy = 0;
  const b = s.ball; b.owner = null; b.lastTouch = 'A'; b.lastKicker = 'p1'; b.kickTier = 1;
  b.x = 930; b.y = 550 + dy; b.vx = 800; b.vy = 0;
  for (let i = 0; i < 20; i++) {
    e.x = 1000; e.y = 550; e.kvx = 0; e.kvy = 0; // keep the "cushion" fixed so we read a clean impulse
    step(s, { p1: inp(), p2: inp() }, DT);
    if (b.kickTier === 0) return { kvx: s.players.p2.kvx, kvy: s.players.p2.kvy, bvx: b.vx, bvy: b.vy };
  }
  return { kvx: e.kvx, kvy: e.kvy, bvx: b.vx, bvy: b.vy, missed: true };
}

const ang = (r) => Math.round(Math.atan2(r.kvy, r.kvx) * 180 / Math.PI); // push direction, degrees
const mag = (r) => Math.hypot(r.kvx, r.kvy);
const centre = strike(0);
const CENTRE_MAG = mag(centre);

// Ball ABOVE the enemy centre (smaller y): line of centres points down -> enemy driven DOWN,
// cue ball deflects UP (the snooker 90°-ish glance).
{
  const r = strike(-24); // ball above enemy (smaller y)
  ok(!r.missed, 'above-centre hit connected');
  ok(r.kvy > 5, `enemy shoved DOWN when hit from above (kvy=${r.kvy.toFixed(0)})`);
  ok(r.kvx > 5, `enemy still driven forward (kvx=${r.kvx.toFixed(0)})`);
  ok(Math.abs(r.kvy) > 0.35 * r.kvx, `PERCEPTIBLE angle, not near-straight (push ${ang(r)}°)`);
  ok(mag(r) > 0.6 * CENTRE_MAG, `off-centre push keeps real punch (${mag(r).toFixed(0)} vs centre ${CENTRE_MAG.toFixed(0)})`);
  ok(r.bvy < -5, `ball glances UP off the top of the enemy (bvy=${r.bvy.toFixed(0)})`);
}
{
  const r = strike(24); // ball below enemy (larger y)
  ok(!r.missed, 'below-centre hit connected');
  ok(r.kvy < -5, `enemy shoved UP when hit from below (kvy=${r.kvy.toFixed(0)})`);
  ok(Math.abs(r.kvy) > 0.35 * r.kvx, `PERCEPTIBLE angle, not near-straight (push ${ang(r)}°)`);
  ok(mag(r) > 0.6 * CENTRE_MAG, `off-centre push keeps real punch (${mag(r).toFixed(0)} vs centre ${CENTRE_MAG.toFixed(0)})`);
  ok(r.bvy > 5, `ball glances DOWN off the bottom of the enemy (bvy=${r.bvy.toFixed(0)})`);
}
{
  const r = centre; // dead centre
  ok(!r.missed, 'centre hit connected');
  ok(Math.abs(r.kvy) < 5, `centred hit pushes straight, ~no sideways shove (kvy=${r.kvy.toFixed(0)})`);
  ok(r.kvx > 5, `centred hit drives the enemy forward (kvx=${r.kvx.toFixed(0)})`);
}

console.log(fails ? `\n❌ ${fails} FAIL` : '\n✅ ALL PASS');
process.exit(fails ? 1 : 0);
