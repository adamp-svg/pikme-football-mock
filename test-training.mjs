// Training-ground invariants (pure sim + shared/training.js), no server/network:
//  1. noClock: an endless room never transitions to 'ended', even past MATCH_DURATION.
//  2. penned: the dummy stays inside PEN — even when a bomb blast punts it.
//  3. passive: the dummy never shoots / plants / builds / carries the ball.
// Run: node test-training.mjs
import { createState, addPlayer, attachBall, step } from './shared/sim.js';
import { DT, FIELD, MATCH_DURATION } from './shared/constants.js';
import { PEN, penDummy, trainingDummyInput } from './shared/training.js';

let failures = 0;
const check = (cond, msg) => { if (!cond) { console.log('  ❌ ' + msg); failures++; } else { console.log('  ✅ ' + msg); } };

// Build a training match: you (A) + one penned dummy (B), noClock.
function makeTraining() {
  const s = createState();
  s.noClock = true;
  s.resetTimer = 0;
  addPlayer(s, 'me', { name: 'me', char: 'striker', team: 'A', slot: 0, isBot: false });
  addPlayer(s, 'dummy', { name: 'Target', char: 'striker', team: 'B', slot: 0, isBot: true });
  const d = s.players.dummy;
  d.x = (PEN.x0 + PEN.x1) / 2; d.y = FIELD.H / 2;
  attachBall(s, 'A');
  return s;
}

// Advance one training tick the way the server does: dummy input -> step -> pen clamp.
function tick(s, meInput = {}) {
  const inputs = {
    me: { seq: 0, moveX: 0, moveY: 0, aimX: 1, aimY: 0, shoot: false, special: false, build: false, charge: 0, ...meInput },
    dummy: trainingDummyInput(s, 'dummy'),
  };
  step(s, inputs, DT);
  penDummy(s, 'dummy');
  return inputs.dummy;
}

console.log('1) no clock — never ends past MATCH_DURATION');
{
  const s = makeTraining();
  const ticks = Math.round((MATCH_DURATION + 30) / DT); // run 30s past normal full time
  let everEnded = false;
  for (let t = 0; t < ticks; t++) { tick(s); if (s.phase === 'ended') everEnded = true; }
  check(!everEnded && s.phase !== 'ended', `phase stayed '${s.phase}' after ${Math.round(ticks * DT)}s (> ${MATCH_DURATION}s)`);
}

console.log('2) penned — dummy stays in its zone, even under bomb knockback');
{
  const s = makeTraining();
  let out = 0, samples = 0;
  const eps = 0.5;
  for (let t = 0; t < Math.round(60 / DT); t++) {
    // Slam the dummy with a big fake knockback every so often to try to eject it.
    if (t % 30 === 0) { const d = s.players.dummy; d.kvx = 4000; d.kvy = 2500; }
    tick(s);
    const d = s.players.dummy; samples++;
    if (d.x < PEN.x0 - eps || d.x > PEN.x1 + eps || d.y < PEN.y0 - eps || d.y > PEN.y1 + eps) out++;
  }
  check(out === 0, `dummy inside pen on all ${samples} ticks (out ${out})`);
}

console.log('3) passive — dummy never shoots / plants / builds / carries');
{
  const s = makeTraining();
  let acted = 0;
  for (let t = 0; t < Math.round(60 / DT); t++) {
    const di = tick(s);
    if (di.shoot || di.special || di.build || (di.charge || 0) > 0) acted++;
    if (s.ball.owner === 'dummy') acted++; // must never end up carrying
  }
  check(acted === 0, `dummy issued 0 shoot/plant/build/carry over 60s`);
}

console.log(failures === 0 ? '\n✅ TRAINING PASS' : `\n❌ ${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
