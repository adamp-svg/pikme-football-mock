// Tutorial onboarding — the scripted first match for new (young) players.
// Design: docs/superpowers/specs/2026-07-27-tutorial-onboarding-design.md
//
// Two halves, because the feature has two halves:
//   A) the PURE step machine (shared/tutorial.js) — the rules, with no server and no DOM;
//   B) the LIVE room, over a real socket, decoding real binary snapshots — because the half the
//      client cannot fake is the pitch: where the ball is, who the keeper is, whether super is on.
//
// BOOTS ITS OWN SERVER (boot-test-server.mjs). Set PORT= to aim at a running one on purpose.
// Run: node test-tutorial.mjs
import { WebSocket } from 'ws';
import { decodeSnapshot } from './shared/wire.js';
import { FIELD } from './shared/constants.js';
import {
  TU_STEPS, TU_COUNT, TU_DONE, TU_RING, TU_BALL_PARK, TU_ENEMIES, TU_SPAWN, TU_SHOT_SPOT,
  stepAt, advance, isStepDone, showNudge, tuHasControl, isTutorialOver,
} from './shared/tutorial.js';
import { bootServer } from './boot-test-server.mjs';

let failures = 0;
const check = (cond, msg) => { console.log((cond ? '  ✅ ' : '  ❌ ') + msg); if (!cond) failures++; };

// ===========================================================================
console.log('A1) the step table is the four steps, in order, and teaches no bomb/fence');
{
  check(TU_COUNT === 4, `four steps (${TU_COUNT})`);
  check(TU_STEPS.map((s) => s.id).join(',') === 'move,shoot,goal,super',
    `order: ${TU_STEPS.map((s) => s.id).join(' -> ')}`);
  const anyBombOrWall = TU_STEPS.some((s) => s.controls.some((c) => c === 'bomb' || c === 'wall'));
  check(!anyBombOrWall, 'no step ever enables 💣 or 🧱');
  // Epic's rule: one or two sentences at most. A caption here is 1-2 WORDS.
  const longest = Math.max(...TU_STEPS.map((s) => s.cap.length));
  check(longest <= 14, `captions stay tiny (longest ${longest} chars)`);
  check(TU_STEPS.every((s) => s.nudge && s.nudgeAfter >= 5), 'every step has a stuck-nudge, none earlier than 5s');
}

console.log('A2) controls unlock one at a time and never re-lock');
{
  check(tuHasControl(0, 'move') && !tuHasControl(0, 'aim'), 'step 1: move only');
  check(tuHasControl(1, 'move') && tuHasControl(1, 'aim'), 'step 2: move + aim');
  const everLocked = TU_STEPS.some((s, i) => i > 0 && TU_STEPS[i - 1].controls.some((c) => !s.controls.includes(c)));
  check(!everLocked, 'a control, once taught, is never taken away again');
  check(!tuHasControl(TU_DONE, 'move'), 'past the last step nothing is live (the celebration)');
}

console.log('A3) step 1 completes by standing in the ring, and only there');
{
  check(!isStepDone(0, { px: TU_SPAWN.x, py: TU_SPAWN.y }), 'not done at the spawn spot');
  check(isStepDone(0, { px: TU_RING.x, py: TU_RING.y }), 'done at the ring centre');
  check(isStepDone(0, { px: TU_RING.x + TU_RING.r - 2, py: TU_RING.y }), 'done just inside the edge');
  check(!isStepDone(0, { px: TU_RING.x + TU_RING.r + 20, py: TU_RING.y }), 'not done just outside');
  // The ring must be a straight, obstacle-free walk from the pinned spawn — the whole reason the
  // spawn is pinned rather than taken from the formation.
  check(Math.abs(TU_RING.y - TU_SPAWN.y) < 1 && TU_RING.x > TU_SPAWN.x, 'ring is dead ahead of the spawn');
}

console.log('A4) the other three steps complete on their own event, and nothing else');
{
  check(isStepDone(1, { hitDummy: true }) && !isStepDone(1, { scored: true }), 'step 2 needs a hit, not a goal');
  check(isStepDone(2, { scored: true }) && !isStepDone(2, { hitDummy: true }), 'step 3 needs a goal, not a hit');
  check(isStepDone(3, { scored: true }), 'step 4 needs a goal');
  check(!isStepDone(2, {}) && !isStepDone(3, {}), 'an empty context completes nothing');
}

console.log('A5) advance() walks 0→1→2→3→DONE and then stops');
{
  let n = 0;
  n = advance(n, { px: TU_RING.x, py: TU_RING.y }); check(n === 1, `move -> ${n}`);
  n = advance(n, { hitDummy: true }); check(n === 2, `shoot -> ${n}`);
  n = advance(n, { scored: true }); check(n === 3, `goal -> ${n}`);
  n = advance(n, { scored: true }); check(n === TU_DONE, `super -> DONE (${n})`);
  check(isTutorialOver(n), 'isTutorialOver at DONE');
  check(advance(n, { scored: true }) === TU_DONE, 'DONE is a terminal state — it cannot run on');
  // A step must not advance on nothing. This is the whole no-fail-state guarantee: a kid who does
  // not act simply stays put.
  check(advance(0, { px: TU_SPAWN.x, py: TU_SPAWN.y, stepElapsed: 600 }) === 0, 'ten idle minutes still does not skip a step');
}

console.log('A6) the stuck-nudge fires only when stuck');
{
  const at = stepAt(0).nudgeAfter;
  check(!showNudge(0, { px: TU_SPAWN.x, py: TU_SPAWN.y, stepElapsed: at - 1 }), 'silent before the threshold');
  check(showNudge(0, { px: TU_SPAWN.x, py: TU_SPAWN.y, stepElapsed: at + 1 }), 'nudges after it');
  check(!showNudge(0, { px: TU_RING.x, py: TU_RING.y, stepElapsed: at + 99 }), 'never nudges someone who already finished the step');
}

// ===========================================================================
// B) The live room. Everything above is rules; this is the pitch.
// ===========================================================================
const { url: URL } = await bootServer();

function client(name) {
  const ws = new WebSocket(URL);
  const seen = [];
  const waiters = [];
  let roster = null;
  let snap = null;
  ws.on('message', (raw) => {
    if (Buffer.isBuffer(raw) && raw.length && raw[0] === 0x01) {          // binary snapshot
      if (!roster) return;
      const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      const s = decodeSnapshot(dv, roster.slots.map((r) => r.id), roster.slots.map((r) => r.team), roster.v);
      if (s) snap = s;
      return;
    }
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (!m || !m.type) return;
    if (m.type === 'roster') roster = m;
    seen.push(m);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].type === m.type) { waiters[i].resolve(m); waiters.splice(i, 1); }
    }
  });
  return {
    ws, name,
    open: () => new Promise((res) => ws.once('open', res)),
    send: (o) => ws.send(JSON.stringify(o)),
    wait: (type, ms = 12000) => {
      const hit = seen.find((m) => m.type === type);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        waiters.push({ type, resolve });
        setTimeout(() => reject(new Error(`timeout waiting for ${type} (${name})`)), ms);
      });
    },
    // Wait for a snapshot that satisfies `pred` — the server applies a stage on its own tick, so
    // polling for the CONDITION beats sleeping a guessed number of milliseconds.
    until: async (pred, label, ms = 4000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (snap && pred(snap)) return snap;
        await new Promise((r) => setTimeout(r, 25));
      }
      return null;
    },
    snap: () => snap,
    close: () => ws.close(),
  };
}

const c = client('kid');
await c.open();
c.send({ type: 'join', name: 'kid' });
await c.wait('welcome');
c.send({ type: 'tutorial' });
const start = await c.wait('matchStart');
const myId = start.playerId;

console.log('B1) the room is a tutorial room on an empty, endless pitch');
{
  check(start.mode === 'tutorial', `matchStart.mode = ${start.mode}`);
  check((start.goalsToWin | 0) === 0, 'goalsToWin 0 — no goal count can end it');
  const a = start.arena || {};
  const clutter = (a.bushes || []).length + (a.hardWalls || []).length + (a.dryWalls || []).length + (a.crates || []).length;
  check(clutter === 0, `arena is empty: ${clutter} obstacles`);
  check((start.players || []).length === 1, 'one human on the roster');
}

console.log('B2) both enemies exist from the start — no roster churn mid-tutorial');
{
  const s = await c.until((x) => x.players.length >= 1 + TU_ENEMIES.length, 'roster');
  check(!!s, `snapshot carries ${1 + TU_ENEMIES.length} bodies (me + ${TU_ENEMIES.length} enemies)`);
  const mine = s && s.players.find((p) => p.id === myId);
  check(!!mine && Math.hypot(mine.x - TU_SPAWN.x, mine.y - TU_SPAWN.y) < 60,
    `spawned at the pinned start spot (${mine ? `${Math.round(mine.x)},${Math.round(mine.y)}` : 'missing'})`);
}

console.log('B3) steps 1-2: the ball is inert scenery in the far corner');
{
  const s = await c.until((x) => x.ball.owner == null && Math.hypot(x.ball.x - TU_BALL_PARK.x, x.ball.y - TU_BALL_PARK.y) < 12, 'ball parked');
  check(!!s, 'ball parked in the corner, unowned, at step 1');
  c.send({ type: 'tuStage', n: 1 });
  await new Promise((r) => setTimeout(r, 250));
  const s2 = c.snap();
  check(s2 && s2.ball.owner == null && Math.hypot(s2.ball.x - TU_BALL_PARK.x, s2.ball.y - TU_BALL_PARK.y) < 12,
    'still parked at step 2 (the shooting step must not hand them the ball)');
}

console.log('B4) an out-of-sequence stage is refused');
{
  c.send({ type: 'tuStage', n: 3 });            // skipping step 3 — must be ignored
  await new Promise((r) => setTimeout(r, 250));
  const s = c.snap();
  check(s && s.ball.owner == null, 'jumping 2 -> 4 did not hand over the ball');
  const mine = s && s.players.find((p) => p.id === myId);
  check(!!mine && !mine.power, 'jumping 2 -> 4 did not grant super');
}

console.log('B5) step 3 puts the kid on the shooting spot with the ball at their feet');
{
  c.send({ type: 'tuStage', n: 2 });
  const s = await c.until((x) => x.ball.owner === myId, 'ball at my feet');
  check(!!s, 'ball is mine at step 3');
  const mine = s && s.players.find((p) => p.id === myId);
  check(!!mine && Math.hypot(mine.x - TU_SHOT_SPOT.x, mine.y - TU_SHOT_SPOT.y) < 40,
    `moved to the shooting spot (${mine ? `${Math.round(mine.x)},${Math.round(mine.y)}` : 'missing'})`);
  // The spot has to be inside kicking range or the step is a dribble, not a lesson.
  check(FIELD.W - TU_SHOT_SPOT.x < 700, `goal is within one full kick (${FIELD.W - TU_SHOT_SPOT.x}px of ~700)`);
}

console.log('B6) scoring at step 3 does not hand the ball to the enemy');
{
  // The only bug in this feature the pure tests cannot see. Scoring makes team B the CONCEDING
  // side, and the sim's kickoff gives the restart to whoever conceded — so without the reclaim
  // rule in tutorialPost, the reward for the step-3 goal is the dummy walking off with the ball
  // and a kid with nothing to kick. Reproduced the only honest way: actually score.
  let seq = 0;
  const input = (o) => c.send({ type: 'input', seq: ++seq, moveX: 0, moveY: 0, aimX: 1, aimY: 0, hold: false, fire: false, aimed: false, special: false, build: false, ...o });
  const drive = async (o, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { input(o); await new Promise((r) => setTimeout(r, 33)); } };

  await drive({ hold: true }, 2200);            // wind up a full-power kick (SHOOT_CHARGE_TIME 2.0s)
  input({ fire: true, aimed: true });           // ...and let go, straight at the goal
  const scored = await c.until((x) => x.score.A >= 1, 'goal', 6000);
  check(!!scored, `scored at step 3 (score ${scored ? scored.score.A : c.snap()?.score.A})`);
  if (scored) {
    // Ride out the kickoff reset (GOAL_RESET 5s) and see who is holding it on the other side.
    const back = await c.until((x) => x.resetTimer === 0 && x.ball.owner === myId, 'ball reclaimed', 9000);
    const s = back || c.snap();
    const holder = s && s.ball.owner && s.players.find((p) => p.id === s.ball.owner);
    check(!!back, `after the kickoff the ball is MINE again, not team B's (holder: ${holder ? holder.team : 'loose'})`);
  }
}

console.log('B7) step 4 grants super and calls the keeper into the goal');
{
  const before = c.snap();
  const keeperBefore = before && before.players.filter((p) => p.id !== myId).sort((a, b) => b.x - a.x)[0];
  c.send({ type: 'tuStage', n: 3 });
  const s = await c.until((x) => { const m = x.players.find((p) => p.id === myId); return !!m && m.power; }, 'super granted');
  check(!!s, 'super is on at step 4 (granted, not earned)');
  // ...and it must STAY on: OVERCHARGE_TTL is 4s, far less than a kid needs to work out the stick.
  await new Promise((r) => setTimeout(r, 4600));
  const later = c.snap();
  const mineLater = later && later.players.find((p) => p.id === myId);
  check(!!mineLater && mineLater.power, 'super survives past OVERCHARGE_TTL (4s) — it is re-granted every tick');
  const keeperNow = later && later.players.filter((p) => p.id !== myId).sort((a, b) => b.x - a.x)[0];
  const movedIn = keeperBefore && keeperNow && Math.abs(keeperNow.y - FIELD.H / 2) < Math.abs(keeperBefore.y - FIELD.H / 2) - 50;
  check(!!movedIn, `keeper left the touchline for the goal mouth (y ${keeperBefore ? Math.round(keeperBefore.y) : '?'} -> ${keeperNow ? Math.round(keeperNow.y) : '?'})`);
  check(!!mineLater && mineLater.id === myId, 'still holding a live player');
}

console.log('B8) the tutorial never ends on its own — no clock, no way to lose');
{
  const s = c.snap();
  check(!!s && s.phase !== 'ended', `phase is '${s ? s.phase : 'none'}' after the whole run`);
}

c.close();
console.log(failures === 0 ? '\n✅ ALL PASS' : `\n❌ ${failures} FAILED`);
process.exit(failures ? 1 : 0);
