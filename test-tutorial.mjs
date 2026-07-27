// Tutorial onboarding — the scripted tutorial LEVELS.
// Design: docs/superpowers/specs/2026-07-27-tutorial-onboarding-design.md
//
// Two halves, because the feature has two halves:
//   A) the PURE level table + step machine (shared/tutorial.js) — no server, no DOM;
//   B) the LIVE rooms, over a real socket, decoding real binary snapshots — because the half the
//      client cannot fake is the pitch: where the ball is, what each foe is doing, whether super
//      is on, whether the sentry actually shoots.
//
// BOOTS ITS OWN SERVER (boot-test-server.mjs). Set PORT= to aim at a running one on purpose.
// Run: node test-tutorial.mjs
import { WebSocket } from 'ws';
import { decodeSnapshot } from './shared/wire.js';
import { FIELD, BOMB, BOMB_LOB_RANGE, VISION_RANGE, PROJECTILE } from './shared/constants.js';
import {
  TU_LEVELS, TU_LEVEL_COUNT, TU_RING, TU_BALL_PARK, TU_SPAWN, TU_SHOT_SPOT,
  TU2_SHOOT, TU2_BOMB, TU2_WALL, TU2_STRIP,
  tuLevel, stepsIn, stepAt, stageAt, doneStage, foeKeys,
  advance, isStepDone, showNudge, captionFor, tuHasControl, isTutorialOver,
  bombHit, tuUnlocked, nextLevel, fieldFor, TU3_HIDE, TU3_BUSH,
} from './shared/tutorial.js';
import { bootServer } from './boot-test-server.mjs';

let failures = 0;
const check = (cond, msg) => { console.log((cond ? '  ✅ ' : '  ❌ ') + msg); if (!cond) failures++; };
const L1 = 0, L2 = 1, L3 = 2;

// ===========================================================================
// A) The rules
// ===========================================================================
console.log('A1) three levels, in the taught order');
{
  check(TU_LEVEL_COUNT === 3, `three levels (${TU_LEVEL_COUNT})`);
  check(TU_LEVELS.map((L) => L.id).join(',') === 'basics,combat,tricks', `ids: ${TU_LEVELS.map((L) => L.id).join(', ')}`);
  check(TU_LEVELS[L1].steps.map((s) => s.id).join(',') === 'move,shoot,charge,goal,super',
    `level 1: ${TU_LEVELS[L1].steps.map((s) => s.id).join(' -> ')}`);
  check(TU_LEVELS[L2].steps.map((s) => s.id).join(',') === 'ballshot,bomb,wall,strip',
    `level 2: ${TU_LEVELS[L2].steps.map((s) => s.id).join(' -> ')}`);
  check(TU_LEVELS[L3].steps.map((s) => s.id).join(',') === 'hide,fly',
    `level 3: ${TU_LEVELS[L3].steps.map((s) => s.id).join(' -> ')}`);
  for (const L of TU_LEVELS) {
    check(L.steps.length === L.stages.length, `${L.id}: one pitch stage per step (${L.steps.length}/${L.stages.length})`);
  }
}

console.log('A2) 💣 and 🧱 are absent from level 1 and arrive one at a time in level 2');
{
  const l1Has = TU_LEVELS[L1].steps.some((s) => s.controls.includes('bomb') || s.controls.includes('wall'));
  check(!l1Has, 'level 1 never enables 💣 or 🧱');
  check(!tuHasControl(L2, 0, 'bomb') && !tuHasControl(L2, 0, 'wall'), 'level 2 step 1: still neither');
  check(tuHasControl(L2, 1, 'bomb') && !tuHasControl(L2, 1, 'wall'), 'level 2 step 2: 💣 only');
  check(tuHasControl(L2, 2, 'wall'), 'level 2 step 3: 🧱 arrives');
  check(tuHasControl(L2, 3, 'bomb') && tuHasControl(L2, 3, 'wall'), 'level 2 step 4: everything is live');
  // A control, once taught, is never taken away inside a level.
  for (const [li, L] of TU_LEVELS.entries()) {
    const bad = L.steps.some((s, i) => i > 0 && L.steps[i - 1].controls.some((c) => !s.controls.includes(c)));
    check(!bad, `${L.id}: nothing that was taught is ever re-locked`);
    void li;
  }
}

console.log('A3) captions stay tiny and every step has a stuck-nudge');
{
  const all = TU_LEVELS.flatMap((L) => L.steps);
  const longest = Math.max(...all.map((s) => s.cap.length));
  check(longest <= 14, `longest caption ${longest} chars`);
  check(all.every((s) => s.nudge && s.nudgeAfter >= 5), 'every step nudges, none earlier than 5s');
  check(all.every((s) => s.spotlight && s.gesture), 'every step points a hand at something');
}

console.log('A4) level 1 step 1 completes by standing in the ring, and only there');
{
  check(!isStepDone(L1, 0, { px: TU_SPAWN.x, py: TU_SPAWN.y }), 'not done at the spawn spot');
  check(isStepDone(L1, 0, { px: TU_RING.x, py: TU_RING.y }), 'done at the ring centre');
  check(isStepDone(L1, 0, { px: TU_RING.x + TU_RING.r - 2, py: TU_RING.y }), 'done just inside the edge');
  check(!isStepDone(L1, 0, { px: TU_RING.x + TU_RING.r + 20, py: TU_RING.y }), 'not done just outside');
  check(Math.abs(TU_RING.y - TU_SPAWN.y) < 1 && TU_RING.x > TU_SPAWN.x, 'ring is dead ahead of the spawn');
}

console.log('A5) every other step completes on its OWN event and nothing else');
{
  const flags = ['hitEnemy', 'chargedShot', 'scored', 'bombHitFoe', 'wallBuilt', 'stripped', 'hidden', 'flew'];
  const cases = [
    [L1, 1, 'hitEnemy'], [L1, 2, 'chargedShot'], [L1, 3, 'scored'], [L1, 4, 'scored'],
    [L2, 0, 'scored'], [L2, 1, 'bombHitFoe'], [L2, 2, 'wallBuilt'], [L2, 3, 'scored'],
    [L3, 0, 'hidden'], [L3, 1, 'flew'],
  ];
  // ...but a minDwell step will not ADVANCE on its flag alone, so give the predicate check the
  // dwell it needs (isStepDone is the flag; advance() is the flag plus the dwell — see A12).
  for (const [l, n, flag] of cases) {
    const only = flags.every((f) => isStepDone(l, n, { [f]: true }) === (f === flag));
    check(only, `${TU_LEVELS[l].id}/${stepAt(l, n).id} completes on ${flag} alone`);
  }
  check(TU_LEVELS.every((L, l) => L.steps.every((_, n) => !isStepDone(l, n, {}))), 'an empty context completes nothing');
}

console.log('A6) advance() walks each level to its end and then stops');
{
  for (const [l, L] of TU_LEVELS.entries()) {
    let n = 0;
    const ctx = { px: TU_RING.x, py: TU_RING.y, hitEnemy: true, chargedShot: true, scored: true, bombHitFoe: true, wallBuilt: true, stripped: true, hidden: true, flew: true, sinceDone: 99 };
    for (let i = 0; i < L.steps.length; i++) n = advance(l, n, ctx);
    check(n === doneStage(l) && isTutorialOver(l, n), `${L.id}: 0 -> DONE (${n} of ${L.steps.length})`);
    check(advance(l, n, ctx) === doneStage(l), `${L.id}: DONE is terminal`);
    // A step must not advance on nothing — the whole no-fail-state guarantee.
    check(advance(l, 0, { px: 0, py: 0, stepElapsed: 600, sinceDone: 99 }) === 0, `${L.id}: ten idle minutes does not skip a step`);
  }
}

console.log('A7) the stuck-nudge fires only when stuck');
{
  const at = stepAt(L1, 0).nudgeAfter;
  check(!showNudge(L1, 0, { px: TU_SPAWN.x, py: TU_SPAWN.y, stepElapsed: at - 1 }), 'silent before the threshold');
  check(showNudge(L1, 0, { px: TU_SPAWN.x, py: TU_SPAWN.y, stepElapsed: at + 1 }), 'nudges after it');
  check(!showNudge(L1, 0, { px: TU_RING.x, py: TU_RING.y, stepElapsed: at + 99 }), 'never nudges someone who already finished');
}

console.log('A8) the strip step is one lesson with two captions');
{
  check(captionFor(L2, 3, {}) === 'חטוף!', 'says «חטוף!» while they still have it');
  check(captionFor(L2, 3, { stripped: true }) === 'גול!', 'flips to «גול!» the moment it comes loose');
  check(captionFor(L2, 1, { stripped: true }) === 'פצצה!', 'the flag does not leak into other steps');
  check(!isStepDone(L2, 3, { stripped: true }), 'stripping alone does NOT finish it — you still have to score');
}

console.log('A9) the bomb step is generous about where the blast lands');
{
  const f = TU2_BOMB.foe;
  check(bombHit(f.x, f.y, f.x, f.y), 'dead on counts');
  check(bombHit(f.x + BOMB.radius, f.y, f.x, f.y), 'one blast-radius short still counts');
  check(!bombHit(f.x + BOMB.radius * 3, f.y, f.x, f.y), 'a lob into empty grass does not');
}

console.log('A10) unlocking: level 1 is always open, level 2 waits for it');
{
  const none = new Set(), one = new Set(['basics']), both = new Set(['basics', 'combat']);
  const all = new Set(['basics', 'combat', 'tricks']);
  check(tuUnlocked(0, none) && tuUnlocked(0, both), 'level 1 always unlocked');
  check(!tuUnlocked(1, none), 'level 2 locked until level 1 is finished');
  check(tuUnlocked(1, one), 'level 2 unlocks when level 1 is done');
  check(!tuUnlocked(TU_LEVEL_COUNT, all), 'a level past the end is never unlocked');
  check(!tuUnlocked(2, one) && tuUnlocked(2, both), 'level 3 waits for level 2');
  check(nextLevel(none) === 0, 'nothing done -> offer level 1');
  check(nextLevel(one) === 1, 'level 1 done -> offer level 2');
  check(nextLevel(both) === 2, 'levels 1-2 done -> offer level 3');
  check(nextLevel(all) === null, 'all done -> nothing left to offer');
}

console.log('A11) every level-2 distance sits inside a MEASURED range');
{
  // A quick-tap bullet is bulletSpeed(720) x chargeMul(0.4375) for PROJECTILE.ttl — anything
  // further away simply cannot be hit and a kid would fire into empty grass.
  const quickRange = 720 * 0.4375 * PROJECTILE.ttl;
  const fullRange = 720 * PROJECTILE.ttl;
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  check(d(TU2_SHOOT.me, TU2_SHOOT.ball) < quickRange, `shoot-the-ball ${Math.round(d(TU2_SHOOT.me, TU2_SHOOT.ball))}px < quick-tap range ${Math.round(quickRange)}px`);
  check(FIELD.W - TU2_SHOOT.ball.x < 300, `and the ball is ${FIELD.W - TU2_SHOOT.ball.x}px from the goal line — one shove in`);
  check(d(TU2_BOMB.me, TU2_BOMB.foe) < BOMB_LOB_RANGE, `bomb target ${Math.round(d(TU2_BOMB.me, TU2_BOMB.foe))}px < lob range ${BOMB_LOB_RANGE}px`);
  check(d(TU2_WALL.me, TU2_WALL.foe) < VISION_RANGE, `sentry ${Math.round(d(TU2_WALL.me, TU2_WALL.foe))}px < its vision ${VISION_RANGE}px — it really does shoot at you`);
  check(d(TU2_STRIP.me, TU2_STRIP.foe) < fullRange, `strip target ${Math.round(d(TU2_STRIP.me, TU2_STRIP.foe))}px < full-charge range ${Math.round(fullRange)}px`);
  check(FIELD.W - TU2_STRIP.foe.x < 260, `the carrier stands in its OWN goalmouth (${FIELD.W - TU2_STRIP.foe.x}px out), so the loose ball is already there`);
  // Every foe a stage mentions must be one the room actually spawns.
  for (const [l, L] of TU_LEVELS.entries()) {
    const keys = foeKeys(l);
    const missing = L.stages.flatMap((st) => (st.foes || []).map((f) => f.key)).filter((k) => !keys.includes(k));
    check(missing.length === 0, `${L.id}: every staged foe is spawned (${keys.join(', ')})`);
  }
}

console.log('A12) minDwell holds a finished step open so the lesson lands');
{
  // The wall step is DONE the instant the wall pops up — but advancing then would skip the part
  // that teaches: the wall standing there taking the sentry's fire. Same for the bush and the
  // launch. isStepDone says "achieved"; advance() says "achieved AND seen".
  const w = stepAt(L2, 2);
  check(w.minDwell >= 2, `the wall step dwells ${w.minDwell}s after the build`);
  check(isStepDone(L2, 2, { wallBuilt: true }), 'the wall step counts as done the moment it is built');
  check(advance(L2, 2, { wallBuilt: true, sinceDone: 0 }) === 2, '...but does NOT advance straight away');
  check(advance(L2, 2, { wallBuilt: true, sinceDone: 1 }) === 2, '...still holding a second later');
  check(advance(L2, 2, { wallBuilt: true, sinceDone: 3 }) === 3, '...and moves on once the kid has watched it');
  check(captionFor(L2, 2, { wallBuilt: true }) === 'הקיר עוצר יריות!', 'and it says what the wall is DOING during the dwell');
  for (const [l, n] of [[L3, 0], [L3, 1]]) {
    const st = stepAt(l, n);
    check(st.minDwell > 0, `${TU_LEVELS[l].id}/${st.id} dwells too (${st.minDwell}s)`);
  }
}

console.log('A13) level 3 is the only level with scenery, and it is one bush');
{
  check(fieldFor(L1).bushes.length === 0 && fieldFor(L2).bushes.length === 0, 'levels 1-2 play on a bare pitch');
  check(fieldFor(L3).bushes.length === 1, 'level 3 has exactly one bush — you cannot teach hiding without it');
  const b = fieldFor(L3).bushes[0];
  const d = Math.hypot((b.x + b.w / 2) - TU3_HIDE.me.x, (b.y + b.h / 2) - TU3_HIDE.me.y);
  check(d < 420, `and it sits ${Math.round(d)}px from the start — a short walk, not a hunt`);
  check(Math.hypot(TU3_HIDE.foe.x - TU3_HIDE.me.x, TU3_HIDE.foe.y - TU3_HIDE.me.y) < VISION_RANGE,
    'the watcher genuinely has eyes on the kid before they duck in');
}

console.log('A14) both bomb inputs are explained, not just the one the step needs');
{
  const bomb = stepAt(L2, 1), wall = stepAt(L2, 2);
  check(/הקשה/.test(bomb.sub) && /גרירה/.test(bomb.sub), `the bomb step spells out tap vs drag: «${bomb.sub}»`);
  check(/הקשה/.test(wall.sub) && /גרירה/.test(wall.sub), `so does the wall step: «${wall.sub}»`);
}

// ===========================================================================
// B/C) The live rooms. Everything above is rules; this is the pitch.
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
    forget: (type) => { for (let i = seen.length - 1; i >= 0; i--) if (seen[i].type === type) seen.splice(i, 1); },
    wait: (type, ms = 12000) => {
      const hit = seen.find((m) => m.type === type);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        waiters.push({ type, resolve });
        setTimeout(() => reject(new Error(`timeout waiting for ${type} (${name})`)), ms);
      });
    },
    // Poll for a CONDITION rather than sleeping a guessed number of ms — the server applies a
    // stage on its own tick.
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Drive real inputs for `ms`, the way the client does.
function driver(c) {
  let seq = 0;
  const input = (o) => c.send({ type: 'input', seq: ++seq, moveX: 0, moveY: 0, aimX: 1, aimY: 0, hold: false, fire: false, aimed: false, special: false, build: false, buildHold: false, buildDist: 0, sax: 0, say: 0, ...o });
  return {
    input,
    drive: async (o, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { input(o); await sleep(33); } },
  };
}

// --------------------------------------------------------------------------
const c = client('kid');
await c.open();
c.send({ type: 'join', name: 'kid' });
await c.wait('welcome');
c.send({ type: 'tutorial', level: L1 });
const start = await c.wait('matchStart');
const myId = start.playerId;

console.log('B1) level 1 is a tutorial room on an empty, endless pitch');
{
  check(start.mode === 'tutorial', `matchStart.mode = ${start.mode}`);
  check((start.tuLevel | 0) === L1, `matchStart.tuLevel = ${start.tuLevel | 0}`);
  check((start.goalsToWin | 0) === 0, 'goalsToWin 0 — no goal count can end it');
  const a = start.arena || {};
  const clutter = (a.bushes || []).length + (a.hardWalls || []).length + (a.dryWalls || []).length + (a.crates || []).length;
  check(clutter === 0, `arena is empty: ${clutter} obstacles`);
}

console.log('B2) every foe exists from the start — no roster churn mid-level');
{
  const want = 1 + foeKeys(L1).length;
  const s = await c.until((x) => x.players.length >= want, 'roster');
  check(!!s, `snapshot carries ${want} bodies (me + ${foeKeys(L1).length} foes)`);
  const mine = s && s.players.find((p) => p.id === myId);
  check(!!mine && Math.hypot(mine.x - TU_SPAWN.x, mine.y - TU_SPAWN.y) < 60, 'spawned at the pinned start spot');
}

console.log('B3) level 1 steps 1-2: the ball is inert scenery in the far corner');
{
  const s = await c.until((x) => x.ball.owner == null && Math.hypot(x.ball.x - TU_BALL_PARK.x, x.ball.y - TU_BALL_PARK.y) < 12, 'parked');
  check(!!s, 'ball parked in the corner, unowned');
  c.send({ type: 'tuStage', n: 1 });
  await sleep(250);
  const s2 = c.snap();
  check(s2 && s2.ball.owner == null, 'still parked at the shooting step');
}

console.log('B4) an out-of-sequence stage is refused');
{
  c.send({ type: 'tuStage', n: 3 });            // skipping a step — must be ignored
  await sleep(250);
  const s = c.snap();
  check(s && s.ball.owner == null, 'jumping 2 -> 4 did not hand over the ball');
  const mine = s && s.players.find((p) => p.id === myId);
  check(!!mine && !mine.power, 'jumping 2 -> 4 did not grant super');
}

console.log('B5) level 1\'s goal step puts the kid on the shooting spot with the ball');
{
  c.send({ type: 'tuStage', n: 2 });   // charge step (same pitch as the shoot step)
  await sleep(200);
  c.send({ type: 'tuStage', n: 3 });   // goal step
  const s = await c.until((x) => x.ball.owner === myId, 'ball at my feet');
  check(!!s, 'ball is mine');
  const mine = s && s.players.find((p) => p.id === myId);
  check(!!mine && Math.hypot(mine.x - TU_SHOT_SPOT.x, mine.y - TU_SHOT_SPOT.y) < 40, 'moved to the shooting spot');
  check(FIELD.W - TU_SHOT_SPOT.x < 700, `goal within one full kick (${FIELD.W - TU_SHOT_SPOT.x}px)`);
}

console.log('B6) scoring does not hand the ball to the enemy');
{
  // The only bug here the pure tests cannot see. Scoring makes team B the CONCEDING side and the
  // sim's kickoff gives the restart to whoever conceded — so without the reclaim rule, the reward
  // for the goal step is the dummy walking off with the ball. Reproduced by actually scoring.
  const d = driver(c);
  await d.drive({ hold: true }, 2200);          // full-power wind-up (SHOOT_CHARGE_TIME 2.0s)
  d.input({ fire: true, aimed: true });
  const scored = await c.until((x) => x.score.A >= 1, 'goal', 6000);
  check(!!scored, 'scored at the goal step');
  if (scored) {
    const back = await c.until((x) => x.resetTimer === 0 && x.ball.owner === myId, 'reclaimed', 9000);
    check(!!back, 'after the kickoff the ball is MINE again, not team B\'s');
  }
}

console.log('B7) level 1\'s super step grants super and calls the keeper into the goal');
{
  const before = c.snap();
  const kBefore = before && before.players.filter((p) => p.id !== myId).sort((a, b) => b.x - a.x)[0];
  c.send({ type: 'tuStage', n: 4 });
  const s = await c.until((x) => { const m = x.players.find((p) => p.id === myId); return !!m && m.power; }, 'super');
  check(!!s, 'super is on (granted, not earned)');
  await sleep(4600);   // OVERCHARGE_TTL is 4s — far less than a kid needs to find the stick
  const later = c.snap();
  const mineLater = later && later.players.find((p) => p.id === myId);
  check(!!mineLater && mineLater.power, 'super survives past OVERCHARGE_TTL — re-granted every tick');
  const kNow = later && later.players.filter((p) => p.id !== myId).sort((a, b) => b.x - a.x)[0];
  check(kBefore && kNow && Math.abs(kNow.y - FIELD.H / 2) < Math.abs(kBefore.y - FIELD.H / 2) - 50,
    `keeper left the touchline for the goal mouth (y ${kBefore ? Math.round(kBefore.y) : '?'} -> ${kNow ? Math.round(kNow.y) : '?'})`);
}

// --------------------------------------------------------------------------
console.log('C1) LEVEL 2 opens with a loose ball in front of the goal');
c.forget('matchStart');
c.send({ type: 'tutorial', level: L2 });
const start2 = await c.wait('matchStart');
const myId2 = start2.playerId;
{
  check((start2.tuLevel | 0) === L2, `matchStart.tuLevel = ${start2.tuLevel | 0}`);
  const s = await c.until((x) => x.ball.owner == null && Math.hypot(x.ball.x - TU2_SHOOT.ball.x, x.ball.y - TU2_SHOOT.ball.y) < 20, 'ball placed');
  check(!!s, 'ball is loose in front of the goal, not parked and not carried');
  const mine = s && s.players.find((p) => p.id === myId2);
  check(!!mine && Math.hypot(mine.x - TU2_SHOOT.me.x, mine.y - TU2_SHOOT.me.y) < 40, 'kid is in bullet range of it');
  check((s.players || []).length === 1 + foeKeys(L2).length, `${foeKeys(L2).length} foe on the pitch, not level 1's two`);
}

console.log('C2) that ball CANNOT be picked up — the lesson can\'t be sidestepped');
{
  // "Shoot the ball in" has an obvious cheat: walk over, carry it in. Walk straight into it.
  const d = driver(c);
  await d.drive({ moveX: 1 }, 4000);
  const s = c.snap();
  const mine = s && s.players.find((p) => p.id === myId2);
  const gap = mine ? Math.hypot(mine.x - s.ball.x, mine.y - s.ball.y) : 999;
  check(gap < 140, `walked right up to the ball (${Math.round(gap)}px away)`);
  check(s && s.ball.owner == null, 'and it still refuses to be carried');
}

console.log('C3) the bomb step puts a target inside lob range');
{
  c.send({ type: 'tuStage', n: 1 });
  const s = await c.until((x) => {
    const f = x.players.find((p) => p.id !== myId2);
    return !!f && Math.hypot(f.x - TU2_BOMB.foe.x, f.y - TU2_BOMB.foe.y) < 40;
  }, 'foe placed');
  check(!!s, 'foe moved to the bomb-target spot');
  const mine = s && s.players.find((p) => p.id === myId2);
  const foe = s && s.players.find((p) => p.id !== myId2);
  const gap = mine && foe ? Math.hypot(mine.x - foe.x, mine.y - foe.y) : 999;
  check(gap < BOMB_LOB_RANGE, `target ${Math.round(gap)}px away — inside the ${BOMB_LOB_RANGE}px lob`);
  check(s.ball.owner == null && Math.hypot(s.ball.x - TU_BALL_PARK.x, s.ball.y - TU_BALL_PARK.y) < 12, 'ball parked out of the way');
}

console.log('C4) the wall step turns that same foe into a sentry that really shoots');
{
  c.send({ type: 'tuStage', n: 2 });
  await c.until((x) => {
    const f = x.players.find((p) => p.id !== myId2);
    return !!f && Math.hypot(f.x - TU2_WALL.foe.x, f.y - TU2_WALL.foe.y) < 60;
  }, 'sentry placed', 5000);
  const placed = c.snap();
  const foe = placed && placed.players.find((p) => p.id !== myId2);
  check(!!foe && Math.abs(foe.x - TU2_WALL.foe.x) < 80, 'foe re-homed to the sentry spot — same body, new job (no roster churn)');
  // It must actually open fire, or "build a wall to hide behind" is a lesson about nothing.
  const d = driver(c);
  const t0 = Date.now();
  let sawShot = false;
  while (Date.now() - t0 < 9000 && !sawShot) {
    d.input({});                                  // stand still and be shot at
    const s = c.snap();
    if (s && (s.projectiles || []).length) sawShot = true;
    await sleep(60);
  }
  check(sawShot, 'the sentry opened fire within 9s');
}

console.log('C5) building a wall works on that step');
{
  // A wall is NOT one button press: buildHold has to be held for BUILD_WINDUP (0.5s) until
  // buildWindup >= 0.9, and only then does the build edge place it (sim.js:901). Drive it the way
  // a thumb does, or this "wall" test proves nothing.
  const d = driver(c);
  const before = (c.snap().walls || []).length;
  await d.drive({ buildHold: true, aimX: 1, aimY: 0, buildDist: 0.5 }, 900);
  d.input({ buildHold: true, build: true, aimX: 1, aimY: 0, buildDist: 0.5 });
  const s = await c.until((x) => (x.walls || []).length > before, 'wall up', 4000);
  check(!!s, `a wall went up (${before} -> ${s ? s.walls.length : '?'})`);
}

console.log('C6) the strip step hands the ball to the foe, in its own goalmouth');
{
  c.send({ type: 'tuStage', n: 3 });
  const s = await c.until((x) => {
    const f = x.players.find((p) => p.id !== myId2);
    return !!f && x.ball.owner === f.id;
  }, 'foe carrying', 5000);
  check(!!s, 'the foe is carrying the ball');
  const foe = s && s.players.find((p) => p.id !== myId2);
  check(!!foe && FIELD.W - foe.x < 260, `and stands ${foe ? Math.round(FIELD.W - foe.x) : '?'}px from its own goal line`);
  const mine = s && s.players.find((p) => p.id === myId2);
  const gap = mine && foe ? Math.hypot(mine.x - foe.x, mine.y - foe.y) : 999;
  check(gap < 720 * PROJECTILE.ttl, `${Math.round(gap)}px away — a full-charge bullet reaches`);
}

console.log('C7) a full-charge bullet knocks the ball off the carrier');
{
  const d = driver(c);
  const foeId = c.snap().players.find((p) => p.id !== myId2)?.id;
  await d.drive({ hold: true }, 2200);            // full charge — a quick tap does NOT strip
  d.input({ fire: true, aimed: true });
  const loose = await c.until((x) => x.ball.owner !== foeId, 'stripped', 6000);
  check(!!loose, `the ball came off them (owner now ${loose ? (loose.ball.owner || 'loose') : 'still theirs'})`);
}

console.log('C8) neither level ever ends on its own — no clock, no way to lose');
{
  const s = c.snap();
  check(!!s && s.phase !== 'ended', `phase is '${s ? s.phase : 'none'}' after the whole run`);
}

c.close();
console.log(failures === 0 ? '\n✅ ALL PASS' : `\n❌ ${failures} FAILED`);
process.exit(failures ? 1 : 0);
