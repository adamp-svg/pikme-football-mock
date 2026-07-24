// Training-ground invariants (pure sim + shared/training.js), no server/network.
// New model: custom field (crates → enemies) + 3 enemy roles:
//   noClock never ends · STILL never fires + returns home · KEEPER stays in the box + never fires
//   · SENTRY aims at the player, fires in bursts, home-leashed.
// Run: node test-training.mjs
import { createState, addPlayer, attachBall, step } from './shared/sim.js';
import { DT, FIELD, MATCH_DURATION, PENALTY } from './shared/constants.js';
import {
  TRAIN_ARENA, TRAIN_ENEMIES, TRAIN_HOME_LEASH,
  createSentryMem, trainingSentryInput, trainingStillInput, trainingKeeperInput, leashSentry, keeperClamp,
} from './shared/training.js';

let failures = 0;
const check = (cond, msg) => { console.log((cond ? '  ✅ ' : '  ❌ ') + msg); if (!cond) failures++; };
const home = (k) => { const e = TRAIN_ENEMIES.find((e) => e.key === k); return { x: e.x, y: e.y }; };

function makeTraining() {
  const s = createState(); s.noClock = true; s.resetTimer = 0; s.arena = TRAIN_ARENA;
  addPlayer(s, 'me', { name: 'me', char: 'player', team: 'A', slot: 0, isBot: false });
  TRAIN_ENEMIES.forEach((e, i) => { addPlayer(s, e.key, { name: e.role, char: 'player', team: 'B', slot: i, isBot: true }); const p = s.players[e.key]; p.x = e.x; p.y = e.y; });
  attachBall(s, 'A'); return s;
}
// One training tick the server-way: role inputs → step → clamps. Returns the inputs used.
function driveTick(s, mem, meInput = {}) {
  const inputs = { me: { seq: 0, moveX: 0, moveY: 0, aimX: 1, aimY: 0, hold: false, fire: false, special: false, build: false, buildHold: false, sax: 0, say: 0, ...meInput } };
  inputs.sentry = trainingSentryInput(s, 'sentry', mem, DT, 'normal', home('sentry'));
  inputs.keeper = trainingKeeperInput(s, 'keeper');
  inputs.stillB = trainingStillInput(s, 'stillB', home('stillB'));
  inputs.stillM = trainingStillInput(s, 'stillM', home('stillM'));
  step(s, inputs, DT);
  keeperClamp(s, 'keeper');
  leashSentry(s, 'sentry', home('sentry'), TRAIN_HOME_LEASH);
  leashSentry(s, 'stillB', home('stillB'), TRAIN_HOME_LEASH);
  leashSentry(s, 'stillM', home('stillM'), TRAIN_HOME_LEASH);
  return inputs;
}

console.log('1) no clock — never ends past MATCH_DURATION');
{
  const s = makeTraining(); const mem = createSentryMem();
  const ticks = Math.round((MATCH_DURATION + 20) / DT);
  let ended = false;
  for (let t = 0; t < ticks; t++) { driveTick(s, mem); if (s.phase === 'ended') ended = true; }
  check(!ended && s.phase !== 'ended', `phase stayed '${s.phase}' after ${Math.round(ticks * DT)}s`);
}

console.log('2) arena — custom field (8 bushes + 4 steel walls), crates are NOT obstacles');
{
  const bushes = TRAIN_ARENA.bushes.length;
  const steel = TRAIN_ARENA.walls.filter((w) => w.angle != null).length;
  const crates = TRAIN_ARENA.walls.filter((w) => w.crate).length;
  check(bushes === 8 && steel === 4 && crates === 0, `arena: ${bushes} bushes, ${steel} steel walls, ${crates} crates`);
}

console.log('3) STILL enemy — never fires, returns to its home after knockback');
{
  const s = makeTraining(); const mem = createSentryMem();
  s.players.stillB.kvx = 4200; s.players.stillB.kvy = 3200; // punt it
  let acted = 0;
  for (let t = 0; t < Math.round(6 / DT); t++) { const i = driveTick(s, mem); if (i.stillB.fire || i.stillB.hold || i.stillB.special || i.stillB.build) acted++; }
  const d = Math.hypot(s.players.stillB.x - home('stillB').x, s.players.stillB.y - home('stillB').y);
  check(acted === 0, `still never fired/built over 6s`);
  check(d < 30, `still walked back home after knockback (${Math.round(d)}px away)`);
}

console.log('4) KEEPER — never fires, stays inside the penalty box even when shoved');
{
  const s = makeTraining(); const mem = createSentryMem();
  const x0 = FIELD.W - PENALTY.depth, x1 = FIELD.W, y0 = (FIELD.H - PENALTY.width) / 2, y1 = (FIELD.H + PENALTY.width) / 2;
  let acted = 0, out = 0, moved = 0; const startY = s.players.keeper.y;
  for (let t = 0; t < Math.round(8 / DT); t++) {
    if (t % 45 === 0) { s.players.keeper.kvx = -5200; s.players.keeper.kvy = 4200; } // try to punt it out
    s.ball.x = 1400; s.ball.y = 300 + Math.sin(t / 18) * 220;                        // ball weaves → keeper tracks
    const i = driveTick(s, mem);
    if (i.keeper.fire || i.keeper.hold) acted++;
    const k = s.players.keeper; if (k.x < x0 - 2 || k.x > x1 + 2 || k.y < y0 - 2 || k.y > y1 + 2) out++;
    if (Math.abs(k.y - startY) > 40) moved = 1;
  }
  check(acted === 0, `keeper never fired`);
  check(out === 0, `keeper stayed in the penalty box (out ${out})`);
  check(moved === 1, `keeper moved to track the ball`);
}

console.log('5) SENTRY — aims at the player, fires in bursts, home-leashed when shoved');
{
  const s = makeTraining(); const mem = createSentryMem();
  const px = 150, py = 200; // close to the sentry home (75,125), clear of walls/bushes
  let fire = 0, idle = 0, misaim = 0, maxd = 0, ticks = 0;
  for (let t = 0; t < Math.round(30 / DT); t++) {
    const M = s.players.me; M.x = px; M.y = py; M.vx = M.vy = M.kvx = M.kvy = 0; // pin target in view
    if (t % 90 === 0) { s.players.sentry.kvx = 4200; s.players.sentry.kvy = -3200; } // shove the sentry
    const i = driveTick(s, mem);
    if (s.resetTimer > 0) continue;
    ticks++;
    const p = s.players.sentry;
    maxd = Math.max(maxd, Math.hypot(p.x - home('sentry').x, p.y - home('sentry').y));
    const tx = px - p.x, ty = py - p.y, tl = Math.hypot(tx, ty) || 1;
    if (i.sentry.aimX * (tx / tl) + i.sentry.aimY * (ty / tl) < 0.85) misaim++;
    if (i.sentry.fire) fire++; else idle++;
  }
  check(maxd <= TRAIN_HOME_LEASH + 2, `sentry home-leashed (max ${Math.round(maxd)}px ≤ ${TRAIN_HOME_LEASH})`);
  check(misaim < ticks * 0.1, `sentry aimed at the player ${ticks - misaim}/${ticks} ticks (slew-lag after shoves allowed)`);
  check(fire > 10 && idle > 0, `bursty fire: ${fire} firing + ${idle} idle ticks`);
}

console.log(failures === 0 ? '\n✅ ALL PASS' : `\n❌ ${failures} FAILED`);
process.exit(failures ? 1 : 0);
