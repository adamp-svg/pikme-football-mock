// The client's OWN-PLAYER prediction must apply the same build-windup slow the sim does.
// shared/sim.js halves your speed while you hold the build control with a charge ready; if
// public/client.js's ownSpeed()/stepPrediction() don't, the predicted body — and the build ghost
// anchored to it — runs AHEAD of the authoritative one for the whole hold and then rubber-bands
// mid-aim, so the wall lands off by that drift.
//
// public/client.js is browser code, so instead of re-implementing it here (a replica would just
// test itself) this slices the REAL contiguous prediction block out of the file and evaluates it
// against the same shared modules the browser gives it, then races it tick-for-tick with the real
// sim. Adapted from the council's wt-windup-predict harness.
// Run: node test-build-windup-predict.mjs   (exits non-zero on any failure)
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createState, addPlayer, step } from './shared/sim.js';
import { DT, BUILD_WINDUP, BUILD_WINDUP_SLOW } from './shared/constants.js';

let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fails++; };

// ---- load the client's real prediction block -------------------------------------------
const SRC = readFileSync(new URL('./public/client.js', import.meta.url), 'utf8');
const HEAD = SRC.indexOf('// Prediction + reconciliation (own player, movement only)');
const A = HEAD < 0 ? -1 : SRC.indexOf('\n', SRC.indexOf('---', HEAD)) + 1;
const B = SRC.indexOf('// Reconcile the prediction against the authoritative snapshot');
if (A <= 0 || B <= A) { console.log('FAIL  could not locate the prediction block in public/client.js'); process.exit(1); }
const BLOCK = SRC.slice(A, B);
for (const needle of ['function ownSpeed(', 'function stepPrediction(', 'function ownBuildSlowing(']) {
  if (!BLOCK.includes(needle)) { console.log(`FAIL  extracted block is missing ${needle}`); process.exit(1); }
}

const sharedURL = new URL('./shared/', import.meta.url).href;
// The globals public/client.js has in scope around that block. `buildHolding` and
// currentWindup() live elsewhere in the file — stub them so the test can drive the exact
// states they represent.
const HARNESS = `
import * as C from '${sharedURL}constants.js';
import * as ARN from '${sharedURL}arena.js';
const { CHARACTERS, MOVE_ACCEL, clamp, FIELD, GOAL, BUILD_WINDUP_SLOW } = C;
const { ARENA, resolveWalls } = ARN;
const GOAL_TOP = (FIELD.H - GOAL.width) / 2;
const GOAL_BOTTOM = (FIELD.H + GOAL.width) / 2;
let me = { playerId: 'p1', char: 'player' };
let settings = { speedMul: 1, sizeMul: 1, carrySpeedMul: 0.9 };
let holdingBall = false;
let latest = null;
let predicted = { x: 0, y: 0 };
let predVel = { x: 0, y: 0 };
let buildHolding = false;
let __windup = 0;
function currentWindup() { return __windup; }
const fieldArena = () => ARENA;

${BLOCK}

export function setup(o) {
  settings = { ...settings, ...(o.settings || {}) };
  holdingBall = !!o.holdingBall;
  latest = o.latest || null;
  predicted = { x: o.x, y: o.y };
  predVel = { x: o.vx || 0, y: o.vy || 0 };
}
export function setBuild(holding, windup) { buildHolding = holding; __windup = windup; }
export const slowingNow = () => ownBuildSlowing();
export const pred = () => ({ x: predicted.x, y: predicted.y, vx: predVel.x, vy: predVel.y });
export const stepPred = (mx, my, dt, slowing) => stepPrediction(mx, my, dt, slowing);
`;
const harnessFile = join(mkdtempSync(join(tmpdir(), 'fb-predict-')), 'client-predict.mjs');
writeFileSync(harnessFile, HARNESS);
const client = await import(pathToFileURL(harnessFile).href);

// ---- the sim side -----------------------------------------------------------------------
const inp = (o = {}) => ({ seq: 1, moveX: 0, moveY: 0, aimX: 1, aimY: 0, hold: false, fire: false, special: false, build: false, buildHold: false, buildDist: 0, sax: 0, say: 0, ...o });

function freshSim(x, y) {
  const s = createState();
  s.resetTimer = 0;
  addPlayer(s, 'p1', { name: 'A', char: 'player', team: 'A', slot: 0 });
  addPlayer(s, 'p2', { name: 'B', char: 'player', team: 'B', slot: 0 });
  s.players.p1.x = x; s.players.p1.y = y;
  s.players.p2.x = 200; s.players.p2.y = 200;
  s.ball.owner = null; s.ball.x = 120; s.ball.y = 120; s.ball.vx = 0; s.ball.vy = 0; // park it far away
  return s;
}

// Walk +x for `secs` on BOTH sides and report the gap between the two bodies.
// `slowing` is what the CLIENT believes (its ownBuildSlowing() result); `buildHold` is what the
// player is actually sending. They differ exactly when the server refuses to wind (cooldown).
function race({ buildHold, slowing, secs, replay = false, buildCd = 0 }) {
  const X0 = 700, Y0 = 550;
  const s = freshSim(X0, Y0);
  const p = s.players.p1;
  if (buildCd) p.buildCd = buildCd;
  const cfg = { x: X0, y: Y0, settings: { speedMul: s.settings.speedMul, sizeMul: s.settings.sizeMul, carrySpeedMul: s.settings.carrySpeedMul }, latest: { players: [{ id: 'p1', buildAmmo: p.buildAmmo }], walls: [] } };
  client.setup(cfg);
  const n = Math.round(secs / DT);
  const sent = [];
  for (let i = 0; i < n; i++) {
    step(s, { p1: inp({ moveX: 1, buildHold }), p2: inp() }, DT);
    client.stepPred(1, 0, DT, slowing);
    sent.push({ moveX: 1, moveY: 0, dt: DT, slowing });
  }
  if (replay) {
    // Mirror reconcile(): hard-reset to the server body, then re-apply the unacked inputs. With
    // every input unacked, replaying from the ORIGINAL base must land exactly where the live
    // steps did — otherwise replay fights the live prediction.
    client.setup(cfg);
    for (const q of sent) client.stepPred(q.moveX, q.moveY, q.dt, q.slowing);
  }
  const c = client.pred();
  return { drift: Math.hypot(c.x - p.x, c.y - p.y), sim: p.x - X0, cli: c.x - X0 };
}

// 1) Baseline: not building — prediction already matched the sim, and must still.
{
  const r = race({ buildHold: false, slowing: false, secs: BUILD_WINDUP });
  ok(r.drift < 0.01, `not building: prediction matches sim (drift ${r.drift.toFixed(2)}px over ${r.sim.toFixed(1)}px)`);
}

// 2) THE BUG: walking while holding build. The sim halves the speed; an unslowed prediction
//    ends up ~2x further along.
{
  const r = race({ buildHold: true, slowing: true, secs: BUILD_WINDUP });
  ok(r.drift < 1, `winding ${BUILD_WINDUP}s: prediction matches sim (drift ${r.drift.toFixed(2)}px; sim ${r.sim.toFixed(1)}px, client ${r.cli.toFixed(1)}px)`);
  const unslowed = race({ buildHold: true, slowing: false, secs: BUILD_WINDUP });
  ok(unslowed.drift > 20, `...and NOT applying the slow drifts badly (${unslowed.drift.toFixed(1)}px) — proves this test can fail`);
}

// 3) A long hold (lining a wall up) must not accumulate drift.
{
  const r = race({ buildHold: true, slowing: true, secs: 1.5 });
  ok(r.drift < 1, `winding 1.5s: no accumulated drift (drift ${r.drift.toFixed(2)}px)`);
}

// 4) Replay consistency: the replayed steps must use the speed each step really had.
{
  const r = race({ buildHold: true, slowing: true, secs: BUILD_WINDUP, replay: true });
  ok(r.drift < 1, `replayed inputs use the same speed rule (drift ${r.drift.toFixed(2)}px)`);
}

// 5) THE REVERSE DRIFT: during the post-build cooldown the sim does NOT slow you even though
//    the button is still held. The client must not slow either — which is why the slow follows
//    the server's `winding` flag instead of a client-side copy of BUILD_COOLDOWN (that copy
//    would also be wrong for anyone whose cdMul/cardUtil scales the real cooldown).
{
  const cd = 0.3;
  const held = race({ buildHold: true, slowing: false, secs: cd, buildCd: cd });
  ok(held.drift < 1, `held through the build cooldown: no reverse drift (drift ${held.drift.toFixed(2)}px)`);
  const wrong = race({ buildHold: true, slowing: true, secs: cd, buildCd: cd });
  ok(wrong.drift > 20, `...and slowing anyway would drift ${wrong.drift.toFixed(1)}px — the case a client-side cooldown mirror gets wrong`);
}

// 6) ownBuildSlowing() itself: only slow when the button is held AND the server is winding.
{
  client.setBuild(false, 0); ok(client.slowingNow() === false, 'not holding => not slowing');
  client.setBuild(true, 0.4); ok(client.slowingNow() === true, 'holding + server winding => slowing');
  client.setBuild(true, 0); ok(client.slowingNow() === false, 'holding but server NOT winding (cooldown/empty mag) => not slowing');
}

console.log(fails ? `\n${fails} FAILED` : `\nall passed (slow factor ${BUILD_WINDUP_SLOW})`);
process.exit(fails ? 1 : 0);
