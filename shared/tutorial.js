// Tutorial onboarding — the scripted tutorial LEVELS for new (young) players.
//
// Design: docs/superpowers/specs/2026-07-27-tutorial-onboarding-design.md
//
// PURE LOGIC ONLY — no DOM, no sockets, no timers. Same rule as shared/training.js: the level
// table, its steps and their completion predicates live here so they can be unit-tested
// (test-tutorial.mjs) and so the client and the server read ONE definition of what a step is.
// The client DRIVES the step machine (it owns the coach overlay and already has the snapshot);
// the server only applies each stage's pitch setup, which it reads from the same table.
//
//   LEVEL 1 · יסודות — move -> shoot -> goal -> super
//   LEVEL 2 · קרב    — shoot the ball -> bomb -> wall -> strip the carrier
//
// Level 1 hides 💣 and 🧱 entirely; level 2 is where they arrive. No level has a clock, a fail
// state, or any way to lose.
import { FIELD, GOAL, BOMB } from './constants.js';
import { buildArenaFromField } from './arena.js';

// A deliberately EMPTY pitch, shared by every level. TRAIN_ARENA's bushes and steel walls are
// right for practice and wrong for a first 90 seconds — every obstacle is one more thing to
// explain. Level 2 builds its own cover, which is the entire point of its wall step.
export const TU_FIELD = { version: 1, bushes: [], hardWalls: [], dryWalls: [], crates: [] };
export const TU_ARENA = buildArenaFromField(TU_FIELD);

// LEVEL 3 needs one piece of scenery — you cannot teach hiding on a bare pitch. Exactly one bush,
// big enough to be unmissable and sitting square on the walk between the kid and the watcher.
export const TU3_BUSH = { x: 1040, y: 400, w: 340, h: 300 };
export const TU3_FIELD = { version: 1, bushes: [TU3_BUSH], hardWalls: [], dryWalls: [], crates: [] };
// A level's pitch. Everything but the tricks level plays on the empty one.
export const fieldFor = (l) => (tuLevel(l) && tuLevel(l).field) || TU_FIELD;

// Where a ball that is not in play this stage goes: inert scenery in the far corner.
export const TU_BALL_PARK = { x: 120, y: 140 };
export const TU_GOAL = { x: FIELD.W, y: FIELD.H / 2, w: GOAL.width };  // the goal every level attacks
const MID = FIELD.H / 2;

// --- LEVEL 1 geometry ------------------------------------------------------------------
export const TU_SPAWN = { x: 420, y: MID };
export const TU_RING = { x: 780, y: MID, r: 80 };   // step 1 target: a 360px walk. Pulled in from
                                                    // 880 after a screenshot — at 880 the ring is
                                                    // half off the right edge of a landscape phone
                                                    // on frame one, so the kid is told to walk to
                                                    // something they cannot see.
export const TU_DUMMY = { x: 1150, y: 300 };        // step 2 target — OFF the y=550 shot lane, so
                                                    // it can never block the step-3 goal
export const TU_KEEPER_IDLE = { x: 1920, y: 1010 }; // the keeper loiters here until step 4
// Where the goal steps put the kid, ball at their feet. MEASURED, not guessed: a full kick
// (shotPower 1400) carries ~650px, so from the step-1 spawn the goal is simply out of range and
// the "lesson" becomes a 12-second dribble up an empty pitch. From here one good kick scores.
export const TU_SHOT_SPOT = { x: 1420, y: MID };

// --- LEVEL 2 geometry ------------------------------------------------------------------
// Every distance here is set by two MEASURED ranges, not by eye:
//   * a bullet is `bulletSpeed 720 x chargeMul` for `PROJECTILE.ttl 1.3s` — so ~410px on a quick
//     tap and ~936px fully charged. Anything further away simply cannot be hit, and a kid would
//     stand there firing into empty grass.
//   * a lobbed bomb lands at most BOMB_LOB_RANGE (250px) from the planter.
export const TU2_SHOOT = { me: { x: 1400, y: MID }, ball: { x: 1792, y: MID } }; // 392px: quick-tap range,
                                                                                 // ball nudged one full
                                                                                 // sprite (32px) nearer
                                                                                 // the line so one shove
                                                                                 // is enough
export const TU2_BOMB = { me: { x: 900, y: MID }, foe: { x: 1080, y: MID } };    // 180px: inside lob range
// `spot` is where the dashed ghost is drawn — square between the kid and the sentry, so "build it
// THERE" is shown rather than described. BUILT_WALL.offset (60) is how far in front of you a wall
// lands, so standing put and building forward puts it right on the mark.
export const TU2_WALL = { me: { x: 700, y: MID }, foe: { x: 1150, y: MID }, spot: { x: 760, y: MID } }; // 450px: inside the
                                                                                 // sentry's VISION_RANGE
                                                                                 // (620), so it really
                                                                                 // does shoot at you
export const TU2_STRIP = { me: { x: 1400, y: MID }, foe: { x: 1800, y: MID } };  // 400px: full-charge
                                                                                 // range, and the foe
                                                                                 // stands in its OWN
                                                                                 // goalmouth, so the
                                                                                 // ball you knock loose
                                                                                 // is already there
export const TU2_PARK = { x: 120, y: 1000 };  // where level 2's foe waits out the steps it isn't in

// --- LEVEL 3 geometry ------------------------------------------------------------------
// HIDE: the watcher stands inside VISION_RANGE (620) of the start, so it genuinely has eyes on
// the kid — walking into the bush is what breaks the line, and the 🌿 cue is the proof.
export const TU3_HIDE = { me: { x: 900, y: MID }, foe: { x: 1450, y: MID } };
// FLY: room to the right to be launched into, and the foe well out of the way — this step is
// about the kid and their own bomb, nobody else.
export const TU3_FLY = { me: { x: 520, y: MID }, foe: { x: 1900, y: 1020 } };

// ---------------------------------------------------------------------------
// The levels
// ---------------------------------------------------------------------------
// Each step:
//   controls  — which touch controls EXIST. Anything absent is hidden and its input dropped, so a
//               kid cannot press a button that has not been explained.
//   spotlight — the control the pointing hand animates over ('move' | 'aim' | 'bomb' | 'wall').
//   gesture   — 'circle' (walk the stick around) | 'pull' (hold, drag, let go) | 'tap'.
//   marker    — the one world cue on the pitch: 'ring' | 'goal' | 'ball' | 'foe' (+ markerKey).
//   cap       — 1-2 Hebrew words. Epic's rule taken literally: a kid who cannot read still finishes.
//   cap2/when — an optional SECOND caption, swapped in once `when` (a ctx flag) latches. Used by
//               the strip step, which is one continuous action with two halves.
//   nudge     — the escalated line, shown only after `nudgeAfter` idle seconds.
//   done      — the ctx flag (or predicate) that completes the step.
//
// Each stage (one per step, same index) is the PITCH SETUP the server applies:
//   me/ball/foes/super — declarative, so the server interprets one table instead of hand-writing
//   a branch per level. See applyTuStage in server.js.
export const TU_LEVELS = [
  {
    id: 'basics', name: 'יסודות', sub: 'לזוז · לירות · גול · סופר', ic: '⚽',
    steps: [
      { id: 'move', controls: ['move'], spotlight: 'move', gesture: 'circle',
        marker: 'ring', cap: 'זוז!', nudge: 'הזז את העיגול', nudgeAfter: 8, done: 'inRing' },
      // TAP first, HOLD second — two separate steps for two separate gestures, each with its own
      // hand mime, and each holding a beat after it lands so the kid connects what they did to
      // what happened.
      { id: 'shoot', controls: ['move', 'aim'], spotlight: 'aim', gesture: 'tap',
        marker: 'foe', markerKey: 'dummy', cap: 'כוון והקש!', sub: 'הקשה קצרה = ירייה מהירה',
        cap2: 'פגעת!', when: 'hitEnemy', minDwell: 1,
        nudge: 'משוך לכיוון שלו ותשחרר', nudgeAfter: 8, done: 'hitEnemy' },
      // CHARGE gets a step of its own. It used to be a footnote — the shoot step completed on any
      // hit, so a kid could finish the whole tutorial having only ever tapped, and the one line
      // that mentioned holding only appeared if they got stuck. Hold-to-power is the single most
      // important thing in this game's combat (MECHANICS §1: 2s to full, and it scales the ball
      // kick, the bullet, the knockback and the strip), so it is taught deliberately, not hinted.
      { id: 'charge', controls: ['move', 'aim'], spotlight: 'aim', gesture: 'hold',
        marker: 'foe', markerKey: 'dummy', cap: 'כוון והחזק!', sub: 'כמה שיותר זמן — יותר חזק',
        cap2: 'זו ירייה חזקה!', when: 'chargedShot', minDwell: 1,
        nudge: 'אל תשחרר — עד שהטבעת מלאה', nudgeAfter: 8, done: 'chargedShot' },
      { id: 'goal', controls: ['move', 'aim'], spotlight: 'aim', gesture: 'hold',
        marker: 'goal', cap: 'החזק ושחרר!', sub: 'ככה בועטים רחוק — לשער',
        nudge: 'כוון לשער והחזק', nudgeAfter: 10, done: 'scored' },
      { id: 'super', controls: ['move', 'aim'], spotlight: 'aim', gesture: 'pull',
        marker: 'goal', cap: 'בעיטת ענק!', nudge: 'הכדור חזק פי שניים', nudgeAfter: 12, done: 'scored' },
    ],
    stages: [
      { me: TU_SPAWN, ball: 'park', foes: [{ key: 'dummy', role: 'still', ...TU_DUMMY }, { key: 'keeper', role: 'still', ...TU_KEEPER_IDLE }] },
      { ball: 'park', foes: [{ key: 'dummy', role: 'still', ...TU_DUMMY }, { key: 'keeper', role: 'still', ...TU_KEEPER_IDLE }] },
      { ball: 'park', foes: [{ key: 'dummy', role: 'still', ...TU_DUMMY }, { key: 'keeper', role: 'still', ...TU_KEEPER_IDLE }] },
      { me: TU_SHOT_SPOT, ball: 'toMe', foes: [{ key: 'dummy', role: 'still', ...TU_DUMMY }, { key: 'keeper', role: 'still', ...TU_KEEPER_IDLE }] },
      // The keeper stops loitering and takes the goal — the "now it gets harder" beat — and super
      // is GRANTED, because earning it needs a full charged hit or three quick ones (MECHANICS §4),
      // a whole extra lesson.
      { me: TU_SHOT_SPOT, ball: 'toMe', super: true, foes: [{ key: 'dummy', role: 'still', ...TU_DUMMY }, { key: 'keeper', role: 'keeper' }] },
    ],
  },
  {
    id: 'combat', name: 'קרב', sub: 'כדור · פצצה · קיר · חטיפה', ic: '💥',
    steps: [
      // Opens with the thing closest to what level 1 already taught — you know how to shoot; now
      // learn that bullets move the BALL. The ball is pickup-locked this stage, so "just walk over
      // and carry it in" is not available and the lesson cannot be sidestepped.
      { id: 'ballshot', controls: ['move', 'aim'], spotlight: 'aim', gesture: 'hold',
        marker: 'ball', cap: 'שוט לכדור!', sub: 'החזק ושחרר — ירי דוחף את הכדור',
        nudge: 'כוון לכדור, החזק, שחרר', nudgeAfter: 10, done: 'scored' },
      // Both bomb inputs, in the two lines a kid will actually read: TAP drops it at your feet,
      // DRAG throws it where you point. The nudge is the one they need if the lob isn't landing.
      { id: 'bomb', controls: ['move', 'aim', 'bomb'], spotlight: 'bomb', gesture: 'lob',
        marker: 'foe', markerKey: 'foe', cap: 'פצצה!', sub: 'הקשה = מתחתיך · גרירה = לאן שתכוון',
        nudge: 'גרור את הפצצה אליו', nudgeAfter: 10, done: 'bombHitFoe' },
      // 💣 STAYS on this step. It was dropped here at first, and the "nothing taught is ever
      // re-locked" invariant in test-tutorial.mjs caught it: taking a button back the step after
      // introducing it is exactly the kind of thing that makes a seven-year-old think they broke
      // something. Focus comes from the spotlight and the completion flag, not from confiscation.
      // minDwell: the step does NOT end the instant the wall pops up. It holds for 2.2s so the kid
      // actually WATCHES it stand there and take the sentry's fire — the wall doing its job is the
      // lesson, and advancing on the build itself skips straight past it.
      { id: 'wall', controls: ['move', 'aim', 'bomb', 'wall'], spotlight: 'wall', gesture: 'lob',
        marker: 'wallspot', cap: 'בנה קיר!', sub: 'הקשה = לפניך · גרירה = לאן שתכוון',
        cap2: 'הקיר עוצר יריות!', when: 'wallBuilt', minDwell: 3,
        nudge: 'החזק את 🧱 ואז שחרר', nudgeAfter: 10, done: 'wallBuilt' },
      // One continuous action with two halves, so it gets two captions rather than two steps:
      // knock the ball off them, then put it away.
      // Knocking it loose IS the lesson. Making them score afterwards tacked a second objective
      // onto a step that had already taught its thing.
      { id: 'strip', controls: ['move', 'aim', 'bomb', 'wall'], spotlight: 'aim', gesture: 'hold',
        marker: 'foe', markerKey: 'foe', cap: 'חטוף!', sub: 'ירייה מלאה מפילה לו את הכדור',
        cap2: 'הכדור שוחרר!', when: 'stripped', minDwell: 2,
        nudge: 'החזק ירי מלא', nudgeAfter: 12, done: 'stripped' },
    ],
    stages: [
      { me: TU2_SHOOT.me, ball: TU2_SHOOT.ball, ballLocked: true, foes: [{ key: 'foe', role: 'still', ...TU2_PARK }] },
      { me: TU2_BOMB.me, ball: 'park', foes: [{ key: 'foe', role: 'still', ...TU2_BOMB.foe }] },
      { me: TU2_WALL.me, ball: 'park', foes: [{ key: 'foe', role: 'sentry', skill: 'easy', ...TU2_WALL.foe }] },
      { me: TU2_STRIP.me, ball: 'toFoe', foes: [{ key: 'foe', role: 'still', ...TU2_STRIP.foe }] },
    ],
  },
  {
    id: 'tricks', name: 'טריקים', sub: 'להתחבא · לעוף', ic: '🌿',
    field: TU3_FIELD,   // the ONLY level with scenery — you cannot teach hiding on a bare pitch
    steps: [
      // Stealth. The watcher is deliberately motionless and harmless: the lesson is the bush and
      // the 🌿 cue, and a bot that chases would turn it into a panic instead of a discovery.
      // minDwell holds the step 2s after they vanish so they SEE the cue and connect it to the act.
      { id: 'hide', controls: ['move', 'aim'], spotlight: 'move', gesture: 'circle',
        marker: 'bush', cap: 'תתחבא!', sub: 'בתוך השיח אף אחד לא רואה אותך',
        cap2: 'הוא לא רואה אותך!', when: 'hidden', minDwell: 2,
        nudge: 'תיכנס לתוך הירוק', nudgeAfter: 10, done: 'hidden' },
      // The combo the whole game is built around (MECHANICS §6: 2 bombs + a wall behind + standing
      // on top flings a player ~92% of the pitch). Taught with the simple version — one bomb, one
      // wall — because the point is that you can ride your own blast, not the world record.
      { id: 'fly', controls: ['move', 'aim', 'bomb', 'wall'], spotlight: 'bomb', gesture: 'tap',
        marker: 'none', cap: 'תעוף!', sub: 'קיר מאחוריך · פצצה מתחתיך · תעמוד עליה',
        cap2: 'איזה עף!', when: 'flew', minDwell: 1.5,
        nudge: 'בנה קיר, הקש 💣 מתחתיך, אל תזוז', nudgeAfter: 14, done: 'flew' },
    ],
    stages: [
      { me: TU3_HIDE.me, ball: 'park', foes: [{ key: 'watcher', role: 'still', ...TU3_HIDE.foe }] },
      { me: TU3_FLY.me, ball: 'park', foes: [{ key: 'watcher', role: 'still', ...TU3_FLY.foe }] },
    ],
  },
];

export const TU_LEVEL_COUNT = TU_LEVELS.length;
export const tuLevel = (l) => TU_LEVELS[l] || null;
export const tuLevelIndex = (id) => TU_LEVELS.findIndex((L) => L.id === id);
export const stepsIn = (l) => (tuLevel(l) ? tuLevel(l).steps.length : 0);
export const stepAt = (l, n) => { const L = tuLevel(l); return L ? (L.steps[n] || null) : null; };
export const stageAt = (l, n) => { const L = tuLevel(l); return L ? (L.stages[n] || null) : null; };
// Stage index that means "finished": one past the last step. The client shows the celebration and
// records the level as done on seeing it.
export const doneStage = (l) => stepsIn(l);
export const isTutorialOver = (l, n) => n >= stepsIn(l);

// Every foe key this level ever uses — the server spawns them all once, at room creation, and
// then only changes their ROLE per stage. No roster churn mid-level.
export function foeKeys(l) {
  const L = tuLevel(l);
  if (!L) return [];
  const keys = [];
  for (const st of L.stages) for (const f of (st.foes || [])) if (!keys.includes(f.key)) keys.push(f.key);
  return keys;
}

// Does a control exist at this stage? Everything not listed is hidden AND its input dropped.
// Out of range (the celebration) => nothing is live.
export function tuHasControl(l, n, ctl) {
  const s = stepAt(l, n);
  return !!s && s.controls.includes(ctl);
}

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------
// ctx is built from the snapshot the client already receives:
//   { px, py }   my position
//   hitEnemy     a bullet of mine hit an enemy since this step began
//   chargedShot  I released a shot at FULL charge — the hold-to-power lesson
//   scored       my side's score went up since this step began
//   bombHitFoe   one of my blasts went off on top of the marked foe
//   wallBuilt    a wall of mine appeared
//   stripped     the ball came loose off an enemy carrier
//   hidden       I am standing in a bush
//   flew         my own bomb launched me across the pitch
//   stepElapsed  seconds since this step began
//   sinceDone    seconds since this step first completed (drives minDwell)
//
// Every flag is a ONE-WAY LATCH on an event the client has already observed, so a dropped frame
// costs nothing: the flag stays set until the step advances. `inRing` is the one positional
// predicate, evaluated here rather than latched.
export function isStepDone(l, n, ctx = {}) {
  const s = stepAt(l, n);
  if (!s) return false;
  if (s.done === 'inRing') {
    const dx = (ctx.px ?? 0) - TU_RING.x, dy = (ctx.py ?? 0) - TU_RING.y;
    return Math.hypot(dx, dy) <= TU_RING.r;
  }
  return !!ctx[s.done];
}

// Which caption to show. A step with `cap2` swaps to it once its `when` flag latches — the strip
// step says «חטוף!» until the ball is loose and «גול!» after, which is one lesson, not two.
export function captionFor(l, n, ctx = {}) {
  const s = stepAt(l, n);
  if (!s) return '';
  return (s.cap2 && s.when && ctx[s.when]) ? s.cap2 : s.cap;
}

// The escalated hint: shown once a step has gone `nudgeAfter` seconds with no completion.
export function showNudge(l, n, ctx = {}) {
  const s = stepAt(l, n);
  if (!s) return false;
  return (ctx.stepElapsed || 0) >= s.nudgeAfter && !isStepDone(l, n, ctx);
}

// Advance if the step is complete, else stay. Returns the stage the level should now be in;
// doneStage(l) means the last step just finished.
//
// `minDwell` holds a COMPLETED step open for that many more seconds. Some lessons are only
// learned in the seconds AFTER the action: the wall has to stand there and take a shot, the bush
// has to keep you hidden, the launch has to actually carry you. Advancing on the instant of
// success skips the part that teaches. ctx.sinceDone is seconds since the step first completed.
export function advance(l, n, ctx = {}) {
  if (isTutorialOver(l, n)) return doneStage(l);
  if (!isStepDone(l, n, ctx)) return n;
  const s = stepAt(l, n);
  if (s.minDwell && (ctx.sinceDone || 0) < s.minDwell) return n;
  return n + 1;
}

// Did a blast at (bx,by) land on the foe at (fx,fy)? Generous on purpose — BOMB.radius is where
// the push reaches zero, and a kid whose lob lands a sprite short has understood the lesson.
export const BOMB_HIT_SLACK = 1.5;
export const bombHit = (bx, by, fx, fy) => Math.hypot(bx - fx, by - fy) <= BOMB.radius * BOMB_HIT_SLACK;

// ---------------------------------------------------------------------------
// Progress / unlocking
// ---------------------------------------------------------------------------
// `done` is the set of COMPLETED level ids. A level is unlocked once every level before it is
// done — level 1 always is. Kept here, pure, so the picker, the auto-start and the tests all
// agree on one rule.
export function tuUnlocked(l, done) {
  if (l <= 0) return true;
  if (l >= TU_LEVEL_COUNT) return false;
  for (let i = 0; i < l; i++) if (!done || !done.has(TU_LEVELS[i].id)) return false;
  return true;
}
// The level to offer next: the first unlocked one that isn't finished, else null (all done).
export function nextLevel(done) {
  for (let i = 0; i < TU_LEVEL_COUNT; i++) {
    if (!done || !done.has(TU_LEVELS[i].id)) return tuUnlocked(i, done) ? i : null;
  }
  return null;
}
