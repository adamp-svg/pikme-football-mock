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

// Level 3's pitch (the bush + the rocket-jump wall) is declared with the rest of its geometry,
// further down — see the TDZ note there.
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
// How far in front of the kid the dashed ghost sits — i.e. where they are being TOLD to put the
// wall. MEASURED against the placement formula, and the ceiling on it is hard:
//   * wallPlacement() (shared/arena.js) puts the wall centre at
//     BUILT_WALL.offset (60) + drag(0..1) x BUILD_DIST_MAX (120)  ->  60..180px in front;
//   * but the CLIENT scales a full drag to `wallMaxPx`, which DEFAULTS to BUILT_WALL.offset + 32
//     = 92 (loadAimNum('fbWallMax', ...) in client.js). BUILD_DIST_MAX is only the sim's ceiling.
//   => a kid on DEFAULT settings can place a wall at 60..92px in front of themselves and NOWHERE
//      ELSE. A ghost drawn past 92 is an instruction that cannot be obeyed.
// 88 leaves 4px of headroom under that 92px ceiling and needs ~88% of a full drag — firm, but not
// pixel-perfect. It was 60 (dead on BUILT_WALL.offset): with ht 16 the wall's near face landed
// 44px from a 21px-radius body, i.e. on top of the kid, which both looks wrong and lets the
// placement shove them. DO NOT raise this above (BUILT_WALL.offset + 32) without also raising the
// default wallMaxPx — test-tutorial.mjs A11 asserts the range.
export const TU2_WALL_GAP = 88;
// `spot` is where the dashed ghost is drawn — out in front of the kid, on the line to the sentry,
// so "build it THERE" is shown rather than described.
export const TU2_WALL = { me: { x: 700, y: MID }, foe: { x: 1150, y: MID }, spot: { x: 700 + TU2_WALL_GAP, y: MID } }; // 450px: inside the
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
// The SCENERY comes first here, and the spawn spots are derived FROM it below. Both lessons are
// about a specific object — hide inside THAT bush, cannon off THAT wall — so a spawn spot written as
// its own literal is a second copy of the same fact, and the two drift the first time either moves.
// (Declared below MID, never above it: a module-level const that reads another one from inside an
// object initializer is a TDZ crash waiting for the next reorder, and this repo has already lost a
// whole client.js to exactly that.)
//   * the BUSH the watcher hides in;
//   * one STEEL WALL for the rocket-jump to cannon off (MECHANICS §6: a static wall behind the
//     launch peaks at BOMB_WALL_CANNON_STATIC = 1.55, ramped by proximity). The kid does NOT build
//     it. Building is level 2's lesson, and charging it as rent on level 3's turns "you can ride
//     your own bomb" into a two-part errand.
export const TU3_BUSH = { x: 1040, y: 400, w: 340, h: 300 };
export const TU3_WALL = { cx: 540, cy: MID, angle: Math.PI / 2, hl: 200, ht: 16 };
export const TU3_FIELD = { version: 1, bushes: [TU3_BUSH], hardWalls: [TU3_WALL], dryWalls: [], crates: [] };
// Dead centre of the bush, computed, not typed. The watcher standing anywhere near an EDGE is the
// one way this step fails outright: the fade-in starts at BUSH_REVEAL_DIST (110) from the sprite, so
// a foe near the rim is already half-visible from outside the leaves and there is nothing to find.
export const TU3_BUSH_MID = { x: TU3_BUSH.x + TU3_BUSH.w / 2, y: TU3_BUSH.y + TU3_BUSH.h / 2 };
// How far in front of the steel the kid stands for the launch. BOMB_WALL_DIST is 150, so this is
// inside the cannon's reach (×1.24 here) and still clear of the stone.
export const TU3_FLY_GAP = 84;
// FIND: the lesson is taught from the OTHER SIDE of the bush. The watcher is planted INSIDE it, so
// it is genuinely invisible, and the kid is sent to look for it. Discovering that a bush ate a whole
// player is what teaches that a bush will do the same for them; being told to stand in a bush
// teaches only that the coach said so. The walk is ~610px, one screen, so the bush is on frame one.
export const TU3_FIND = { me: { x: 600, y: MID }, foe: TU3_BUSH_MID };
// FLY: the steel wall is BEHIND the kid and the whole pitch is in front. applyTuStage points every
// stage's aim at +x, so a kid who taps 💣 without touching the aim stick flies RIGHT, into the open,
// first try. The foe sits in the far corner — this step is the kid and their own bomb, nobody else.
export const TU3_FLY = { me: { x: TU3_WALL.cx + TU3_WALL.ht + TU3_FLY_GAP, y: MID }, foe: { x: 1900, y: 1020 } };

// ---------------------------------------------------------------------------
// The levels
// ---------------------------------------------------------------------------
// Each step:
//   controls  — which touch controls EXIST. Anything absent is hidden and its input dropped, so a
//               kid cannot press a button that has not been explained.
//   spotlight — the control the pointing hand animates over ('move' | 'aim' | 'bomb' | 'wall').
//   gesture   — 'circle' (walk the stick around) | 'pull' (hold, drag, let go) | 'tap'.
//   marker    — the world cue on the pitch: 'ring' | 'goal' | 'ball' | 'foe' (+ markerKey) |
//               'wallspot' | 'bush' | 'none'. An ARRAY when one cue cannot say the whole
//               instruction — see markersFor.
//   cap       — 1-2 Hebrew words. Epic's rule taken literally: a kid who cannot read still finishes.
//   sub       — the standing second line: what the control DOES. Always visible, calm.
//   cap2/when — an optional SECOND caption, swapped in once `when` (a ctx flag) latches. Used by
//               the strip step, which is one continuous action with two halves.
//   sub2      — the same swap for the second line (see subFor). The find step's payoff lives here.
//   nudge     — the escalated line, shown only after `nudgeAfter` idle seconds. Replaces `sub`.
//   fix/fixWhen — a CORRECTION: `fix` is the line to print the moment the ctx flag `fixWhen`
//               latches, because the kid did the wrong GESTURE rather than nothing at all. It
//               rides the same escalated slot as `nudge` (see nudgeFor/showNudge) and jumps the
//               `nudgeAfter` queue: waiting 8 idle seconds to answer a mistake we can already see
//               is how a seven-year-old decides the game is broken. A correction never fails the
//               step and never resets anything — it just says what to do instead.
//   done      — the ctx flag (or predicate) that completes the step.
//
// Each stage (one per step, same index) is the PITCH SETUP the server applies:
//   me/ball/foes/super — declarative, so the server interprets one table instead of hand-writing
//   a branch per level. See applyTuStage in server.js.
// A foe entry is { key, role, skill?, x?, y?, armOn? }, and `armOn` is the one part of it that is
// about TIME rather than placement: it names the thing the kid has to DO before that foe is allowed
// to shoot at all. Until then the body just stands there. The server reads the condition off the
// SIM (see tuArmFoes in server.js), never off the client's step flags — the client only ever names
// the stage it reached, and a foe that opened fire on a spoofable message would be a foe that never
// held its fire. Once the condition latches the foe stays armed for the rest of the step. The only
// value is 'wallBuilt' = a wall of the kid's own team is standing.
export const TU_LEVELS = [
  {
    id: 'basics', name: 'יסודות', sub: 'לזוז · לירות · גול · סופר', ic: '⚽',
    steps: [
      { id: 'move', controls: ['move'], spotlight: 'move', gesture: 'circle',
        marker: 'ring', cap: 'זוז!', nudge: 'הזז את העיגול', nudgeAfter: 8, done: 'inRing' },
      // TAP first, HOLD second — two separate steps for two separate gestures, each with its own
      // hand mime, and each holding a beat after it lands so the kid connects what they did to
      // what happened.
      // Which is only true if the TAP step insists on a tap. It used to complete on `hitEnemy` —
      // ANY hit — so a kid who held finished «כוון והקש!» without ever tapping, and the very next
      // step then asked them to do the thing they had just done. `quickHit` is the honest
      // predicate: a shot RELEASED below QUICK_CHARGE that also LANDS. It needs the hit as well as
      // the tap because a tap alone would tick the step over while the kid fires into empty grass,
      // and «פגעת!» would be a lie.
      // `fix` is the other half: hold too long and you are told at once, in the nudge slot, to tap
      // short instead. Nothing is failed, nothing resets — the charge just wasn't the gesture, and
      // they can try again the same second. The HOLD they were reaching for is the next step
      // anyway, so the correction is a "not yet", never a "no".
      { id: 'shoot', controls: ['move', 'aim'], spotlight: 'aim', gesture: 'tap',
        marker: 'foe', markerKey: 'dummy', cap: 'כוון והקש!', sub: 'הקשה קצרה = ירייה מהירה',
        cap2: 'פגעת!', when: 'quickHit', minDwell: 1,
        fix: 'הקש קצר — בלי להחזיק', fixWhen: 'overHeld',
        nudge: 'משוך לכיוון שלו ותשחרר', nudgeAfter: 8, done: 'quickHit' },
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
      // TWO cues, because one cue is half an instruction. «שוט לכדור!» with only the ball marked
      // tells the kid what to hit and nothing about where it has to end up — and the goal is off
      // to the right of a landscape phone with nothing on the grass naming it, so the step read as
      // "shove the ball, somewhere". The goal arrow is level 1's own cue, reused as-is; the ball
      // chevron stays and is listed SECOND so it draws on top of the arrow's tail.
      { id: 'ballshot', controls: ['move', 'aim'], spotlight: 'aim', gesture: 'hold',
        marker: ['goal', 'ball'], cap: 'שוט לכדור!', sub: 'החזק ושחרר — ירי דוחף את הכדור',
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
      // `armOn: 'wallBuilt'` — the sentry is standing there from the first frame of the step and
      // does not shoot until the kid's wall is up. THE BUILD IS WHAT ARMS IT. Reported from a phone:
      // firing from the top of the step means a seven-year-old is under fire while working out a
      // brand-new button, and every shot lands in the seconds BEFORE the wall exists — so the wall
      // is never seen stopping anything and «הקיר עוצר יריות!» is a claim about something that
      // didn't happen on screen. Armed on the build instead, the step's ~3s minDwell IS the window
      // in which the fire arrives and breaks on the new wall, which is the lesson.
      // `tutorial` tier, not `easy`, for exactly that window: easy is silent 1.6-3.6s at a stretch,
      // long enough for the whole dwell to pass with nothing fired. The tutorial tier fires ~75% of
      // the time and NEVER charges, so it can never knock a build windup out (see SENTRY_SKILL in
      // shared/training.js) — which still matters after the arming, because a kid who wants a second
      // wall must be able to get one.
      { me: TU2_WALL.me, ball: 'park', foes: [{ key: 'foe', role: 'sentry', skill: 'tutorial', armOn: 'wallBuilt', ...TU2_WALL.foe }] },
      { me: TU2_STRIP.me, ball: 'toFoe', foes: [{ key: 'foe', role: 'still', ...TU2_STRIP.foe }] },
    ],
  },
  {
    id: 'tricks', name: 'טריקים', sub: 'למצוא · לעוף', ic: '🌿',
    field: TU3_FIELD,   // the ONLY level with scenery — a bush to find someone in, a wall to fly off
    steps: [
      // Stealth, taught as a HUNT rather than an instruction. The watcher is planted inside the
      // bush and is therefore invisible, and the kid is told to go find it. What they discover is
      // that a bush swallowed a whole player — and a kid who has just failed to see somebody works
      // out on their own that the same bush will hide THEM. Telling them to go stand in the green
      // teaches the opposite: that the coach knows a rule, not that the rule is worth having.
      // The watcher is motionless and harmless on purpose — a bot that chased would turn a
      // discovery into a chase. minDwell holds the step open 2.5s after the sighting so the
      // «גם אתה יכול להתחבא שם» line is read while the kid is still looking at the proof.
      // `findKey` names the foe to be found — no `marker`, because a cue pointing at the bush would
      // answer the question the step is asking.
      { id: 'find', controls: ['move', 'aim'], spotlight: 'move', gesture: 'circle', findKey: 'watcher',
        marker: 'none', cap: 'איפה הוא?', sub: 'מישהו מתחבא כאן — לך תמצא אותו',
        cap2: 'הוא היה בשיח!', sub2: 'גם אתה יכול להתחבא שם', when: 'foundFoe', minDwell: 2.5,
        nudge: 'תחפש בתוך הירוק', nudgeAfter: 8, done: 'foundFoe' },
      // The combo the whole game is built around (MECHANICS §6: 2 bombs + a wall behind + standing
      // on top flings a player ~92% of the pitch). Taught with ONE bomb and a wall that is already
      // standing: 🧱 is not in this step's controls at all. The point is that you can ride your own
      // blast, and making them build the ramp first re-tests level 2 before letting them try it.
      // Tap-plant leaves the bomb dead under your feet, and a blast you are standing dead-centre on
      // has no radial direction to throw you in — so the sim uses your AIM (see explode(), the
      // `rd > 6` branch). "Point where you want to go, then tap" is therefore literally the
      // mechanic, not a simplification of it.
      { id: 'fly', controls: ['move', 'aim', 'bomb'], spotlight: 'bomb', gesture: 'tap',
        marker: 'none', cap: 'תעוף!', sub: 'כוון לאן שתרצה לעוף · הקש 💣 · ואל תזוז',
        cap2: 'איזה עף!', when: 'flew', minDwell: 1.5,
        // The one way to get nothing at all: aim INTO the steel. A launch with a static wall ahead
        // of it is cancelled outright (explode(), `jumpBlocked`), so the stuck-hint is about
        // direction, not about the button.
        nudge: 'כוון לצד הפתוח — לא לקיר', nudgeAfter: 12, done: 'flew' },
    ],
    stages: [
      { me: TU3_FIND.me, ball: 'park', foes: [{ key: 'watcher', role: 'still', ...TU3_FIND.foe }] },
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

// A step's world cues, always as a LIST, so the renderer never has to care whether the step wrote
// one name or several. Most steps name one; a step naming two is drawing two halves of a single
// instruction (level 2's opener: this ball, that goal), and the list order is the DRAW order.
// 'none' is a step declaring on purpose that it has no cue — the bush hunt, where pointing at the
// answer would delete the question — and it resolves to an empty list here so that intent is
// written where the step is, not inferred from a missing field.
export const markersFor = (s) => {
  if (!s || !s.marker) return [];
  return (Array.isArray(s.marker) ? s.marker : [s.marker]).filter((m) => m && m !== 'none');
};

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
//   quickHit     ...and the shot that landed was released BELOW QUICK_CHARGE — the tap lesson.
//                Strictly stronger than hitEnemy: the client stamps the quick RELEASE and only
//                latches this if an enemy impact follows, because the tap and the hit are two
//                different moments and only the pair of them is «כוון והקש!».
//   overHeld     I held past QUICK_CHARGE on a step that asked for a tap — the mistake behind the
//                `fix` line. A correction flag, not a completion one: nothing reads it as `done`.
//   chargedShot  I released a shot at FULL charge — the hold-to-power lesson
//   scored       my side's score went up since this step began
//   bombHitFoe   one of my blasts went off on top of the marked foe
//   wallBuilt    a wall of mine appeared
//   stripped     the ball came loose off an enemy carrier
//   foundFoe     I got close enough to SEE the foe that was hiding in the bush
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

// The second line, with the same swap rule as the caption above: `sub` explains the control while
// the kid is working, and `sub2` replaces it the instant `when` latches. That swap is the whole
// teaching device of the find step — «גם אתה יכול להתחבא שם» is worth nothing said in advance and
// worth the entire lesson said one second after a bush ate a player in front of them.
export function subFor(l, n, ctx = {}) {
  const s = stepAt(l, n);
  if (!s) return '';
  return (s.sub2 && s.when && ctx[s.when]) ? s.sub2 : (s.sub || '');
}

// Is the escalated second line up? Two different things raise it, and they are on purpose the
// SAME slot rather than two competing lines on screen:
//   * the stuck-hint — `nudgeAfter` seconds have gone by with nothing achieved;
//   * a CORRECTION — `fixWhen` latched, i.e. the kid is doing something, just not the gesture the
//     step is teaching. That one is immediate. A hint answers silence and can afford to wait; a
//     correction answers an ACTION, and an answer that arrives eight seconds after the action is
//     no longer attached to it in a child's head.
// Either way it goes quiet the moment the step is satisfied — nobody is corrected for a mistake
// they have already fixed.
export function showNudge(l, n, ctx = {}) {
  const s = stepAt(l, n);
  if (!s) return false;
  if (isStepDone(l, n, ctx)) return false;
  if (s.fix && s.fixWhen && ctx[s.fixWhen]) return true;
  return (ctx.stepElapsed || 0) >= s.nudgeAfter;
}

// WHICH escalated line to print. The correction wins over the stuck-hint whenever both are up:
// «הקש קצר — בלי להחזיק» names the exact thing that just went wrong, and a generic "you seem
// stuck" on top of that is noise. Steps with no `fix` never notice this function exists.
export function nudgeFor(l, n, ctx = {}) {
  const s = stepAt(l, n);
  if (!s) return '';
  return (s.fix && s.fixWhen && ctx[s.fixWhen]) ? s.fix : (s.nudge || '');
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
