// Tutorial onboarding — the scripted first match for new (young) players.
//
// Design: docs/superpowers/specs/2026-07-27-tutorial-onboarding-design.md
//
// PURE LOGIC ONLY — no DOM, no sockets, no timers. Same rule as shared/training.js: the
// step table and its completion predicates live here so they can be unit-tested
// (test-tutorial.mjs) and so the client and the server read ONE definition of what a step
// is. The client drives it (it owns the coach overlay and reads the snapshot); the server
// only applies the pitch setup each stage needs (see applyTuStage in server.js).
//
// Four steps, one new mechanic each, in the order the reference games use:
//   0 move -> 1 shoot -> 2 goal -> 3 super
// The bomb and fence buttons are hidden for the WHOLE tutorial; they are taught later.
// There is no clock, no fail state and no way to lose.
import { FIELD, GOAL } from './constants.js';
import { buildArenaFromField } from './arena.js';

// A deliberately EMPTY pitch. TRAIN_ARENA's bushes and steel walls are right for practice
// and wrong for a first 90 seconds — every obstacle is one more thing to explain.
export const TU_FIELD = { version: 1, bushes: [], hardWalls: [], dryWalls: [], crates: [] };
export const TU_ARENA = buildArenaFromField(TU_FIELD);

// Fixed world spots. The player is pinned at TU_SPAWN rather than taking the formation slot,
// so every step's geometry (the ring is a straight walk right; the goal is a straight shot
// right) holds no matter what the spawn formula does later.
export const TU_SPAWN = { x: 420, y: FIELD.H / 2 };            // 420, 550
export const TU_RING = { x: 780, y: FIELD.H / 2, r: 80 };      // step 1 target: a 360px walk.
                                                               // Pulled in from 880 after a
                                                               // screenshot: at 880 the ring is
                                                               // half off the right edge of a
                                                               // landscape phone on frame one, so
                                                               // the kid is told to walk to
                                                               // something they cannot see.
export const TU_DUMMY = { x: 1150, y: 300 };                   // step 2 target — OFF the y=550
                                                               // shot lane, so it can never
                                                               // block the step-3 goal
export const TU_KEEPER_IDLE = { x: 1920, y: 1010 };            // where the keeper loiters until
                                                               // step 4 calls it into the goal
// Where steps 3-4 put the kid, ball at their feet. MEASURED, not guessed: a full-power kick
// (shotPower 1850) travels ~700px before ball drag stops it, so from the step-1 spawn the goal is
// simply out of range and the "lesson" becomes a 12-second dribble up an empty pitch. From here
// one good kick scores, which is the thing being taught.
export const TU_SHOT_SPOT = { x: 1420, y: FIELD.H / 2 };
export const TU_BALL_PARK = { x: 120, y: 140 };                // steps 1-2: the ball is inert
                                                               // scenery in the far corner
export const TU_GOAL = { x: FIELD.W, y: FIELD.H / 2, w: GOAL.width }; // the goal they attack

// The two enemies. BOTH are spawned once at room creation and never added or removed again —
// no roster churn mid-tutorial. The keeper simply changes ROLE at step 4 and jogs into the
// goal, which doubles as the "now it gets harder" beat.
export const TU_ENEMIES = [
  { key: 'dummy', role: 'still', x: TU_DUMMY.x, y: TU_DUMMY.y },
  { key: 'keeper', role: 'still', x: TU_KEEPER_IDLE.x, y: TU_KEEPER_IDLE.y },
];

// ---------------------------------------------------------------------------
// The step table
// ---------------------------------------------------------------------------
// controls  — which touch controls EXIST this step. Anything absent is hidden and its input
//             dropped, so a kid cannot press a button that has not been explained.
// spotlight — the control the pointing hand animates over ('move' | 'aim' | null).
// gesture   — how the hand moves: 'circle' (walk the stick around) | 'pull' (hold, drag, let go).
// marker    — the one world-space cue drawn on the pitch this step.
// cap       — 1-2 Hebrew words. Epic's rule, taken literally: a kid who cannot read still finishes.
// nudge     — the second line, shown only after `nudgeAfter` seconds of no progress.
export const TU_STEPS = [
  {
    id: 'move', controls: ['move'], spotlight: 'move', gesture: 'circle',
    marker: 'ring', cap: 'זוז!', nudge: 'הזז את העיגול', nudgeAfter: 8,
  },
  {
    id: 'shoot', controls: ['move', 'aim'], spotlight: 'aim', gesture: 'pull',
    marker: 'dummy', cap: 'ירה!', nudge: 'החזק חזק יותר', nudgeAfter: 8,
  },
  {
    id: 'goal', controls: ['move', 'aim'], spotlight: 'aim', gesture: 'pull',
    marker: 'goal', cap: 'גול!', nudge: 'בעט לשער', nudgeAfter: 10,
  },
  {
    id: 'super', controls: ['move', 'aim'], spotlight: 'aim', gesture: 'pull',
    marker: 'goal', cap: 'בעיטת ענק!', nudge: 'הכדור חזק פי שניים', nudgeAfter: 12,
  },
];

export const TU_COUNT = TU_STEPS.length;
// Stage index that means "finished". advance() returns it once the last step completes; the
// client shows the celebration and writes the done flag on seeing it.
export const TU_DONE = TU_COUNT;

export const stepAt = (n) => TU_STEPS[n] || null;
export const isTutorialOver = (n) => n >= TU_COUNT;

// Does a control exist at this stage? Everything not listed is hidden AND its input dropped.
// Out of range (the celebration) => nothing is live.
export function tuHasControl(n, ctl) {
  const s = stepAt(n);
  return !!s && s.controls.includes(ctl);
}

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------
// ctx is built from the snapshot the client already receives:
//   { px, py }      my position
//   hitDummy        an enemy took a bullet impact since this step began
//   scored          my side's score went up since this step began
//   stepElapsed     seconds since this step began
//
// Every predicate is a one-way latch on an event the client has already observed, so a
// dropped frame costs nothing: the flag stays set until the step advances.
export function isStepDone(n, ctx = {}) {
  const s = stepAt(n);
  if (!s) return false;
  switch (s.id) {
    case 'move': {
      const dx = (ctx.px ?? 0) - TU_RING.x, dy = (ctx.py ?? 0) - TU_RING.y;
      return Math.hypot(dx, dy) <= TU_RING.r;
    }
    // Any enemy hit counts, not just the dummy. During this step nothing shoots back and the
    // only bodies on the pitch are the two enemies, so a player-impact IS the kid landing a
    // shot — and a kid who plinks the loitering keeper instead has earned the step just as
    // much. Deliberately forgiving; deliberately NOT requiring a charged shot (see the spec).
    case 'shoot': return !!ctx.hitDummy;
    case 'goal': return !!ctx.scored;
    case 'super': return !!ctx.scored;
    default: return false;
  }
}

// The escalated hint: shown once a step has gone `nudgeAfter` seconds with no completion.
export function showNudge(n, ctx = {}) {
  const s = stepAt(n);
  if (!s) return false;
  return (ctx.stepElapsed || 0) >= s.nudgeAfter && !isStepDone(n, ctx);
}

// Advance if the step is complete, else stay. Returns the stage the tutorial should now be in;
// TU_DONE means the last step just finished.
export function advance(n, ctx = {}) {
  if (isTutorialOver(n)) return TU_DONE;
  return isStepDone(n, ctx) ? n + 1 : n;
}
