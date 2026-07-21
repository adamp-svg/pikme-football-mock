// Training-ground invariants (pure sim + shared/training.js), no server/network:
//  1. noClock: an endless room never transitions to 'ended', even past MATCH_DURATION.
//  2. penned: the dummy stays inside PEN — even when a bomb blast punts it.
//  3. passive: the dummy never shoots / plants / builds / carries the ball.
//  4. sentry: holds midfield (returns when shoved), always faces the player, bursty fire.
//  5. custom field: the steel wall blocks the player; the top-left bush makes builds fragile.
// Run: node test-training.mjs
import { createState, addPlayer, attachBall, step } from './shared/sim.js';
import { DT, FIELD, MATCH_DURATION, FULL_CHARGE } from './shared/constants.js';
import {
  PEN, CENTER, SENTRY_LEASH, TRAIN_ARENA, TRAIN_WALLS, TRAIN_BUSHES,
  penDummy, trainingDummyInput, createSentryMem, trainingSentryInput, leashSentry,
} from './shared/training.js';

let failures = 0;
const check = (cond, msg) => { if (!cond) { console.log('  ❌ ' + msg); failures++; } else { console.log('  ✅ ' + msg); } };

// Build a training match: you (A) + a penned dummy + a midfield sentry (both B),
// noClock, on the custom training field.
function makeTraining() {
  const s = createState();
  s.noClock = true;
  s.resetTimer = 0;
  s.arena = TRAIN_ARENA;
  addPlayer(s, 'me', { name: 'me', char: 'striker', team: 'A', slot: 0, isBot: false });
  addPlayer(s, 'dummy', { name: 'Target', char: 'striker', team: 'B', slot: 0, isBot: true });
  addPlayer(s, 'sentry', { name: 'Sentry', char: 'striker', team: 'B', slot: 1, isBot: true });
  const d = s.players.dummy;
  d.x = (PEN.x0 + PEN.x1) / 2; d.y = FIELD.H / 2;
  const sen = s.players.sentry;
  sen.x = CENTER.x; sen.y = CENTER.y;
  attachBall(s, 'A');
  return s;
}

// Advance one training tick the way the server does: bot inputs -> step -> clamps.
function tick(s, meInput = {}, mem) {
  const inputs = {
    me: { seq: 0, moveX: 0, moveY: 0, aimX: 1, aimY: 0, hold: false, fire: false, special: false, build: false, ...meInput },
    dummy: trainingDummyInput(s, 'dummy'),
    sentry: trainingSentryInput(s, 'sentry', mem || (s._mem ||= createSentryMem()), DT),
  };
  step(s, inputs, DT);
  penDummy(s, 'dummy');
  leashSentry(s, 'sentry');
  return inputs.dummy;
}

const insideBox = (x, y, b) => x > b.x && x < b.x + b.w && y > b.y && y < b.y + b.h;

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
    if (di.fire || di.hold || di.special || di.build) acted++;
    if (s.ball.owner === 'dummy') acted++; // must never end up carrying
  }
  check(acted === 0, `dummy issued 0 fire/hold/plant/build/carry over 60s`);
}

console.log('4) sentry — holds midfield, faces player, fires in bursts');
{
  const s = makeTraining();
  s.players.me.x = 400; s.players.me.y = 400; // off to the left → clear "facing" direction
  const mem = createSentryMem();
  let maxDist = 0, misaimed = 0, fireTicks = 0, idleTicks = 0, ticks = 0;
  for (let t = 0; t < Math.round(45 / DT); t++) {
    if (t % 90 === 0) { const p = s.players.sentry; p.kvx = 3500; p.kvy = -2200; }
    const inp = trainingSentryInput(s, 'sentry', mem, DT);
    step(s, { me: s._me || (s._me = { seq: 0, moveX: 0, moveY: 0, aimX: 1, aimY: 0 }), dummy: trainingDummyInput(s, 'dummy'), sentry: inp }, DT);
    penDummy(s, 'dummy');
    leashSentry(s, 'sentry');
    if (s.resetTimer > 0) continue;
    ticks++;
    const p = s.players.sentry;
    maxDist = Math.max(maxDist, Math.hypot(p.x - CENTER.x, p.y - CENTER.y));
    const tx = s.players.me.x - p.x, ty = s.players.me.y - p.y, tl = Math.hypot(tx, ty) || 1;
    const dot = inp.aimX * (tx / tl) + inp.aimY * (ty / tl);
    if (dot < 0.9) misaimed++;
    if (inp.fire) fireTicks++; else idleTicks++;
  }
  check(maxDist <= SENTRY_LEASH + 1, `sentry stayed near midfield (max ${Math.round(maxDist)}px ≤ leash ${SENTRY_LEASH}px, even when shoved)`);
  check(misaimed === 0, `sentry aimed at the player on all ${ticks} ticks (misaimed ${misaimed})`);
  check(fireTicks > 0 && idleTicks > 0, `bursty fire: ${fireTicks} firing ticks + ${idleTicks} idle ticks (both non-zero)`);
  check(fireTicks > 20, `sentry actually shot over the run (${fireTicks} firing ticks)`);
}

console.log('5) custom field — steel wall blocks the player, bush makes builds fragile');
{
  const wall = TRAIN_WALLS[0], bush = TRAIN_BUSHES[0];
  // (a) drive the player straight into the steel wall from the left; it must not enter.
  {
    const s = makeTraining();
    const p = s.players.me;
    p.x = wall.x - 60; p.y = wall.y + wall.h / 2; // just left of the wall, mid-height
    let breached = 0;
    for (let t = 0; t < Math.round(2 / DT); t++) { tick(s, { moveX: 1, moveY: 0, aimX: 1 }); if (insideBox(p.x, p.y, wall)) breached++; }
    check(breached === 0, `player never entered the steel wall (${breached} breach ticks); stopped at x=${Math.round(p.x)} (wall @ ${wall.x})`);
  }
  // (b) building while standing in the top-left bush yields a FRAGILE wall.
  {
    const s = makeTraining();
    const p = s.players.me;
    p.x = bush.x + bush.w / 2; p.y = bush.y + bush.h / 2; p.aimX = 0; p.aimY = -1;
    tick(s, { build: true, aimX: 0, aimY: -1 });
    const built = s.builtWalls[0];
    check(!!built && built.fragile === true, `wall built in the bush is fragile (${built ? 'fragile=' + built.fragile : 'no wall built'})`);
  }
  // (c) the custom arena persists (it is never the global one).
  {
    const s = makeTraining();
    for (let t = 0; t < Math.round(5 / DT); t++) tick(s);
    check(s.arena === TRAIN_ARENA && s.arena.walls.length === 1 && s.arena.bushes.length === 1,
      `training arena stayed custom (${s.arena.walls.length} wall, ${s.arena.bushes.length} bush)`);
  }
}

console.log('6) difficulty — hard is faster, leads, and lands full-power shots; easy is gentle');
{
  // Run the sentry vs a target that strafes up/down (so lead-aim matters). Returns stats.
  function run(skill) {
    const s = makeTraining();
    const me = s.players.me; me.x = 500; me.y = 550; // to the left, in clear line (no wall)
    const mem = createSentryMem();
    let fire = 0, hold = 0, maxCharge = 0;
    for (let t = 0; t < Math.round(30 / DT); t++) {
      me.vy = Math.sin(t / 12) * 180; me.y += me.vy * DT; me.y = Math.max(120, Math.min(980, me.y)); // strafe
      const inp = trainingSentryInput(s, 'sentry', mem, DT, skill);
      step(s, { me: { seq: 0, moveX: 0, moveY: 0, aimX: 1, aimY: 0 }, dummy: trainingDummyInput(s, 'dummy'), sentry: inp }, DT);
      penDummy(s, 'dummy'); leashSentry(s, 'sentry');
      if (s.resetTimer > 0) continue;
      if (inp.fire) fire++;
      if (inp.hold) hold++;
      for (const pr of s.projectiles) maxCharge = Math.max(maxCharge, pr.charge || 0);
    }
    return { fire, hold, maxCharge };
  }
  const easy = run('easy'), hard = run('hard');
  console.log(`   easy: fire=${easy.fire} hold=${easy.hold} maxCharge=${easy.maxCharge.toFixed(2)}`);
  console.log(`   hard: fire=${hard.fire} hold=${hard.hold} maxCharge=${hard.maxCharge.toFixed(2)}`);
  check(hard.fire > easy.fire, `hard fires more than easy (${hard.fire} > ${easy.fire})`);
  check(hard.hold > 0, `hard winds up charged power shots (${hard.hold} charge ticks)`);
  check(hard.maxCharge >= FULL_CHARGE - 0.01, `hard lands a FULL-power shot (maxCharge ${hard.maxCharge.toFixed(2)} ≥ ${FULL_CHARGE})`);
  check(easy.maxCharge < FULL_CHARGE, `easy never reaches full power (maxCharge ${easy.maxCharge.toFixed(2)} < ${FULL_CHARGE})`);

  // Fire discipline: with the player taking cover BEHIND the wall (below it, away
  // from the centre sentry), hard holds fire.
  {
    const s = makeTraining();
    const wall = s.arena.walls[0];
    const me = s.players.me; me.x = wall.x + wall.w / 2; me.y = wall.y + wall.h + 60; // directly below the wall
    const mem = createSentryMem();
    let fired = 0;
    for (let t = 0; t < Math.round(6 / DT); t++) {
      const inp = trainingSentryInput(s, 'sentry', mem, DT, 'hard');
      step(s, { me: { seq: 0, moveX: 0, moveY: 0, aimX: 1, aimY: 0 }, dummy: trainingDummyInput(s, 'dummy'), sentry: inp }, DT);
      penDummy(s, 'dummy'); leashSentry(s, 'sentry');
      if (inp.fire) fired++;
    }
    check(fired === 0, `hard holds fire when the steel wall blocks the shot (${fired} shots)`);
  }
}

console.log(failures === 0 ? '\n✅ TRAINING PASS' : `\n❌ ${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
