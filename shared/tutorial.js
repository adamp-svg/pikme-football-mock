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
//   LEVEL 1 · יסודות — move -> full shot (must land) -> 3 quick taps -> goal -> super
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

// How long the post-goal freeze lasts IN A TUTORIAL, in seconds. A match holds GOAL_RESET (5s) so
// both sides watch the replay and take a kickoff; a tutorial has neither, so those five seconds are
// the kid frozen in place watching nothing while the coach waits them out. One second is the badge
// and then the next lesson. Read by the room (updateTutorial in server.js), which clamps the sim's
// own timer rather than cancelling it — see the long note there for why the edge must survive.
export const TU_GOAL_HOLD = 1.0;

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
//               'wallspot' | 'aimline' | 'bush' | 'none'. An ARRAY when one cue cannot say the
//               whole instruction — see markersFor.
//   cap       — 1-2 Hebrew words. Epic's rule taken literally: a kid who cannot read still finishes.
//   sub       — the standing second line: what the control DOES. Always visible, calm.
//   cap2/when — an optional SECOND caption, swapped in once `when` (a ctx flag) latches. Used by
//               the strip step, which is one continuous action with two halves. On a COUNT step
//               (see `needs`) whose `when` is its own tally, it swaps on the FULL count — see
//               whenLatched, without which «3 מהירות!» would appear on tap one.
//   sub2      — the same swap for the second line (see subFor). The find step's payoff lives here.
//   nudge     — the escalated line, shown only after `nudgeAfter` idle seconds. Replaces `sub`.
//   fix/fixWhen — a CORRECTION: `fix` is the line to print the moment the ctx flag `fixWhen`
//               latches, because the kid did the wrong GESTURE rather than nothing at all. It
//               rides the same escalated slot as `nudge` (see nudgeFor/showNudge) and jumps the
//               `nudgeAfter` queue: waiting 8 idle seconds to answer a mistake we can already see
//               is how a seven-year-old decides the game is broken. A correction never fails the
//               step and never resets anything — it just says what to do instead.
//   done      — the ctx flag (or predicate) that completes the step.
//   needs     — HOW MANY of `done` the step wants, when `done` names a TALLY rather than a boolean
//               latch (level 1's tap step: three quick releases). Absent = the ordinary one-way
//               boolean, which is what every other step is. A caption or second line may print the
//               progress with `{k}` (landed so far) and `{t}` (the target) — see captionFor.
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
const TU_ALL_LEVELS = [
  {
    id: 'basics', name: 'יסודות', sub: 'לזוז · לירות · גול · סופר', ic: '⚽',
    steps: [
      { id: 'move', controls: ['move'], spotlight: 'move', gesture: 'circle',
        marker: 'ring', cap: 'זוז!', nudge: 'הזז את העיגול', nudgeAfter: 8, done: 'inRing' },
      // HOLD first, TAP second — two separate steps for two separate gestures, each with its own
      // hand mime, and each holding a beat after it lands so the kid connects what they did to
      // what happened.
      //
      // That order is the user's, after playing it on a phone: "make the first do a full shoot,
      // which must hits the enemy. then the quick shoot which dosnt need to hit the enemy (just 3
      // taps on the shoot)". It was tap-then-hold before. The hold going first is also the honest
      // teaching order: hold-to-power is the single most important thing in this game's combat
      // (MECHANICS §1: 2s to full, and the charge scales the ball kick, the bullet, the knockback
      // and the strip), and it is the step that carries the AIMING lesson — so the tap step after
      // it can ask for the gesture alone without ever having taught aiming.
      //
      // `chargedHit`, not `chargedShot`: the old predicate was the RELEASE at full charge and it
      // ignored where the bullet went, so «ירייה חזקה!» could fire over a shot that sailed into
      // the touchline, and the kid would be congratulated for missing. The hit has to be part of
      // it. Assembled from two moments in the client, exactly like `quickHit` was: releaseShot
      // stamps the full release, the projectile impact latches the pair.
      { id: 'charge', controls: ['move', 'aim'], spotlight: 'aim', gesture: 'hold',
        marker: 'foe', markerKey: 'dummy', cap: 'כוון והחזק!', sub: 'החזק עד שמתמלא — ופגע בו',
        cap2: 'ירייה חזקה!', when: 'chargedHit', minDwell: 1,
        // The MIRROR of the tap step's correction below. Here the mistake is letting go too early:
        // a short shot may even hit, and a kid who saw the dummy get shoved has every reason to
        // think they did it. So it is answered on the release, not after nudgeAfter seconds of
        // confusion. Nothing is failed and nothing resets — the ring just wasn't full yet.
        fix: 'החזק יותר — עד שהטבעת מלאה', fixWhen: 'underHeld',
        nudge: 'כוון אליו, החזק, ואז שחרר', nudgeAfter: 8, done: 'chargedHit' },
      // THEN the quick tap — and this one asks for THREE of them and NOTHING else. No hit: a kid
      // who fires three taps into empty grass finishes it, by design. What is being taught here is
      // the gesture and the RATE (a tap is a whole shot on its own, and they come back to back),
      // and the aim was just taught by the step before it — so requiring a hit as well would
      // re-test the previous lesson and add the one way this step could strand a seven-year-old.
      //
      // Which is why the predicate is a COUNT, not a latch: `needs: 3` against the `quickShots`
      // TALLY the client bumps on every release under QUICK_CHARGE (see isStepDone).
      // The reasoning that put `quickHit` here originally still holds for the step it was written
      // for — back when this was FIRST, a bare tap would have ticked the step over while the kid
      // fired into the grass and its «פגעת!» would have been a lie. Nothing here claims a hit any
      // more, so nothing here needs one.
      //
      // `{k}/{t}` in the caption is the whole progress display: a kid who has tapped twice can see
      // «הקש! 2/3» in the biggest text on screen (captionFor fills it in), so three taps cost no
      // new overlay element. The caption is also reassigned on each tap, which re-runs its pop —
      // one small beat per tap, for free.
      //
      // The over-hold correction STAYS with this step, because this is still the step that wants a
      // short tap: a hold adds nothing to the tally, so without the line a kid who holds just
      // watches a counter refuse to move.
      { id: 'shoot', controls: ['move', 'aim'], spotlight: 'aim', gesture: 'tap',
        marker: 'foe', markerKey: 'dummy', cap: 'הקש! {k}/{t}', sub: 'הקשה קצרה = ירייה מהירה',
        cap2: '3 מהירות!', when: 'quickShots', needs: 3, minDwell: 1,
        fix: 'הקש קצר — בלי להחזיק', fixWhen: 'overHeld',
        nudge: 'שלוש הקשות קצרות — שחרר מיד', nudgeAfter: 8, done: 'quickShots' },
      { id: 'goal', controls: ['move', 'aim'], spotlight: 'aim', gesture: 'hold',
        marker: 'goal', cap: 'החזק ושחרר!', sub: 'ככה בועטים רחוק — לשער',
        nudge: 'כוון לשער והחזק', nudgeAfter: 10, done: 'scored' },
      // NO CUE on the finale, deliberately. By this step the kid has already scored once from this
      // exact spot with the arrow up, so a second arrow says nothing they don't know and steals the
      // screen from the one new thing — the super meter that just lit up. Nothing on the grass; the
      // spotlight on the aim stick carries it.
      { id: 'super', controls: ['move', 'aim'], spotlight: 'aim', gesture: 'pull',
        marker: 'none', cap: 'בעיטת ענק!', nudge: 'הכדור חזק פי שניים', nudgeAfter: 12, done: 'scored' },
    ],
    stages: [
      { me: TU_SPAWN, ball: 'park', foes: [{ key: 'dummy', role: 'still', ...TU_DUMMY }, { key: 'keeper', role: 'still', ...TU_KEEPER_IDLE }] },
      // The two shooting stages are IDENTICAL — same parked ball, same dummy, same loitering keeper,
      // and neither pins `me` — so swapping the steps above needed no swap here. Written down rather
      // than left to be rediscovered: the stage list is index-matched to the steps, so if these two
      // ever stop being identical they have to move together with them.
      // Neither pins `me` on purpose: the kid stays where the ring step left them, i.e. inside
      // TU_RING (r 80), which is 383-515px from TU_DUMMY depending on which side of the ring they
      // stopped. That range is the reason the FULL shot can go first — a fully-charged bullet
      // carries ~936px (720px/s x PROJECTILE.ttl 1.3s), so the dummy is comfortably reachable from
      // anywhere in the ring. A quick tap only carries ~410px, which is why the tap step must NOT
      // require a hit from here: from the far side of the ring it could not land one without walking
      // first, and walking is not what that step is teaching. Teleporting the kid to a closer spot
      // was the alternative and it is worse — a body that jumps the instant the ring is reached
      // reads as a bug.
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
      // «שוט לכדור!» with only the ball marked says what to hit and never says where it has to end
      // up, and the goal is off the right of a landscape phone with nothing naming it. The fix is
      // `aimline`: ONE thin dashed ghost from the kid, through the ball, to the goal mouth. It is the
      // whole instruction in a single line — where to point, what it passes through, where it ends.
      // NOT the 'goal' arrow. That was tried on this step first and the user rejected it on sight
      // ("the arrow which is not what ive asked... i want a gohst thin line stight"): a fat wedge
      // lying on the grass is a diagram of the answer, and it is also the one shape on this pitch
      // that a seven-year-old could mistake for a thing they have to get around. 'goal' itself is
      // untouched and still right for level 1's two goal steps, where the ball is already at the
      // kid's feet — a line from the kid THROUGH the ball is degenerate there, which is the same
      // reason `aimline` is on this step only.
      // The ball chevron stays and is listed SECOND, so it bobs over the line rather than under it.
      { id: 'ballshot', controls: ['move', 'aim'], spotlight: 'aim', gesture: 'hold',
        marker: ['aimline', 'ball'], cap: 'שוט לכדור!', sub: 'החזק ושחרר — ירי דוחף את הכדור',
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
  // LEVEL 4 · מרכז — the HUB, not a pitch. Design: docs/superpowers/specs/2026-07-27-hub-tour-level4-design.md
  //
  // Levels 1-3 teach a kid to play a MATCH. Nothing taught the screen they land on BETWEEN matches:
  // a trophy bar, an album carousel, three power slots, a hero button and a friends rail, none of it
  // explained. `where: 'hub'` is what makes the client run this level against the DOM and skip the
  // socket entirely — no room, no stages, no server involvement at all.
  //
  // Order is COLLECT-THEN-PLAY. Play is last on purpose: taught first, its tap would launch
  // matchmaking and abandon the tour halfway through. Ending on the real ⚽ button is also the
  // Brawl Stars payoff — the lesson puts you back into a game.
  {
    id: 'mercaz', name: 'מרכז', sub: 'גביעים · קלפים · כוחות · גיבור', ic: '🏠',
    where: 'hub',
    // NOT OFFERED. The user's call, after playing the training levels: "remove the continue to center
    // (the lobby toturial) and leave just the training toturial there". The tutorial a kid is shown is
    // the three TRAINING levels — this one is neither auto-launched, nor listed in «איך משחקים?», nor
    // reachable from the «המשך ל…» button on a finale.
    // It is switched OFF rather than deleted, and it stays in TU_LEVELS rather than being filtered out
    // of it: this is a finished feature (its own design doc, a mock lobby, a real-⚽ finale, ~40 test
    // assertions), and a product call about what a kid is SHOWN should not cost the ability to change
    // our minds. Left in the array, every helper still addresses it by index and every one of those
    // tests still runs; taken out, they would all have had to be rewritten or deleted. Delete this one
    // line to put it back in the flow.
    offered: false,
    // No `stages` and no `field`: there is no pitch to set up. stageAt/foeKeys/fieldFor all tolerate
    // a stageless level rather than each caller having to remember to check.
    //
    // Steps 1-5 run on a MOCK lobby the tutorial draws itself; only the last one touches the real
    // hub. That split was not the first design — the tour originally ran on the live hub, and a
    // browser found four bugs in a row that all came from the same root: the real hub is a moving
    // target. The wardrobe is an overlay rather than a screen swap, the carousel auto-rotates and
    // completed a step with no input, effectiveLoadout() pre-filled the slots so the drag step was
    // already done on arrival, and localhost quietly injects a sample album that hid the
    // empty-album path completely. On top of that, three agents change this hub daily.
    //
    // A mock cannot drift out from under the lesson, and it removes the risk that mattered: with
    // no real setSlotCard in the loop, a demo card can never reach a kid's actual cross-device
    // loadout. The last step still points at the REAL ⚽, so the tour keeps its payoff — it ends
    // by putting the kid in an actual match, not on a picture of one.
    steps: [
      // The trophy bar cannot be tapped, so there is no gesture to teach — the lesson is "this
      // number is yours and it goes up when you win". minDwell holds it open long enough to read;
      // 686a72f added minDwell for exactly this class of lesson, one that is watched, not done.
      // `mock: true` = this step runs on the tutorial's own lobby. The one step without it is the
      // finale, which points at the real thing.
      { id: 'trophies', mock: true, controls: [], spotlight: 'mockTrophies', gesture: 'none',
        cap: 'גביעים', sub: 'נצחון = עוד גביעים', minDwell: 2.5,
        nudge: 'זה שלך — הוא עולה כשמנצחים', nudgeAfter: 6, done: 'sawTrophies' },
      { id: 'deck', mock: true, controls: [], spotlight: 'mockDeck', gesture: 'tap',
        cap: 'הקלפים שלך', sub: 'הקש קלף לבחירה',
        nudge: 'הקש על אחד הקלפים', nudgeAfter: 8, done: 'deckMoved' },
      { id: 'slots', mock: true, controls: [], spotlight: 'mockSlots', gesture: 'pull',
        cap: 'גרור לכאן', sub: 'שלושה כוחות למשחק',
        nudge: 'גרור קלף לתוך משבצת', nudgeAfter: 10, done: 'slotFilled' },
      { id: 'hero', mock: true, controls: [], spotlight: 'mockHero', gesture: 'tap',
        cap: 'החלף מראה', sub: 'בחר איך תיראה',
        nudge: 'הקש על הדמות', nudgeAfter: 10, done: 'heroTapped' },
      { id: 'friends', mock: true, controls: [], spotlight: 'mockFriends', gesture: 'tap',
        cap: 'שחק עם חבר', sub: 'הזמן חברים למשחק',
        nudge: 'הקש על חברים', nudgeAfter: 10, done: 'friendsTapped' },
      // THE REAL BUTTON. The mock is dismissed first, so the last thing the lesson teaches is the
      // actual control, and the tap that ends the tutorial is the one that starts a real match.
      { id: 'play', controls: [], spotlight: 'hubPlay', gesture: 'tap',
        cap: 'קדימה!', sub: 'הכי מהר להתחיל לשחק',
        nudge: 'הקש כדי לשחק', nudgeAfter: 10, done: 'played' },
    ],
  },
];

export const TU_LEVELS = TU_ALL_LEVELS;

export const TU_LEVEL_COUNT = TU_LEVELS.length;
export const tuLevel = (l) => TU_LEVELS[l] || null;
export const tuLevelIndex = (id) => TU_LEVELS.findIndex((L) => L.id === id);
export const stepsIn = (l) => (tuLevel(l) ? tuLevel(l).steps.length : 0);
export const stepAt = (l, n) => { const L = tuLevel(l); return L ? (L.steps[n] || null) : null; };
// A HUB level has no `stages` — there is no pitch to set up. Tolerated here rather than at every
// call site, so a stageless level can never throw its way through the server or the tests.
export const stageAt = (l, n) => { const L = tuLevel(l); return (L && L.stages) ? (L.stages[n] || null) : null; };
// Does this level run in the HUB instead of on a pitch? A hub level has no room, no stages and no
// server involvement at all — the client runs it against the DOM.
// Declared HERE, above tuUnlocked, because tuUnlocked calls it and a `const` arrow below it would
// hit a temporal-dead-zone at module evaluation.
export const tuIsHub = (l) => { const L = tuLevel(l); return !!L && L.where === 'hub'; };
// Does this step run on the tutorial's own mock lobby, or on the real hub?
export const tuIsMockStep = (l, n) => { const s = stepAt(l, n); return !!s && !!s.mock; };
export const TU_HUB_LEVEL = TU_LEVELS.findIndex((L) => L.where === 'hub');
// Stage index that means "finished": one past the last step. The client shows the celebration and
// records the level as done on seeing it.
export const doneStage = (l) => stepsIn(l);
export const isTutorialOver = (l, n) => n >= stepsIn(l);

// Every foe key this level ever uses — the server spawns them all once, at room creation, and
// then only changes their ROLE per stage. No roster churn mid-level.
export function foeKeys(l) {
  const L = tuLevel(l);
  if (!L || !L.stages) return [];   // a HUB level has no stages, so it has no cast to spawn
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
// Which controls a step INTRODUCES — the one fact the coach's dimming veil hangs off
// ---------------------------------------------------------------------------
// Reported from a phone: the veil (the dark screen with a soft hole over the live control) was up on
// EVERY step of EVERY level, so a kid who already knows how to walk plays half the tutorial through
// a dimmed screen. The user's rule is one line — "dark screen should only be when introducing new
// buttons, like walk, shoot, bomb, wall" — and "new button" is a fact about this table, so it is
// derived here rather than guessed at in the client.
//
// A step introduces a control if it is the FIRST step IN THE WHOLE CURRICULUM to enable it. Which
// yields exactly the user's four: level 1's move step (move), level 1's first shooting step (aim),
// level 2's bomb step (bomb), level 2's wall step (wall). Four veils in the entire tutorial.
//
// FIRST APPEARANCE ACROSS the levels, deliberately — NOT "new since the previous step in this
// level". The within-a-level diff is the obvious reading and it re-creates the reported bug in two
// places: level 2 step 1 lists move+aim, taught a whole level earlier, and level 3's fly step lists
// bomb, taught in level 2 — dimming the screen to introduce a button the kid has already been using
// for a level is the exact complaint. Levels only unlock in order (tuUnlocked), so "an earlier level
// taught it" is a fact here and not an assumption. The cost of the global rule is that it depends on
// TU_LEVELS' order; the order is the curriculum, so that dependency is honest.
//
// A HUB level introduces nothing, ever: its steps enable no match controls at all (`controls: []`)
// and its spotlight points at DOM furniture, so there is no button for a hole to be punched over.
// Guarded explicitly anyway, so a future hub step that listed a control could not dim the lobby.
const TU_FIRST_TAUGHT = (() => {
  const at = new Map();   // control -> `${l}:${n}` of the step that first enables it
  for (let l = 0; l < TU_LEVELS.length; l++) {
    if (tuIsHub(l)) continue;
    const steps = (TU_LEVELS[l].steps || []);
    for (let n = 0; n < steps.length; n++) {
      for (const c of (steps[n].controls || [])) if (!at.has(c)) at.set(c, `${l}:${n}`);
    }
  }
  return at;
})();
// The controls this step is the first to hand over, in the order the step lists them. Empty for
// every step that only re-uses what the kid already has — i.e. for most of the tutorial.
export function introducesFor(l, n) {
  const s = stepAt(l, n);
  if (!s || tuIsHub(l)) return [];
  return (s.controls || []).filter((c) => TU_FIRST_TAUGHT.get(c) === `${l}:${n}`);
}

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------
// ctx is built from the snapshot the client already receives:
//   { px, py }   my position
//   hitEnemy     a bullet of mine hit an enemy since this step began
//   quickHit     ...and the shot that landed was released BELOW QUICK_CHARGE. No step completes on
//                it any more — the tap step counts taps instead (quickShots) and asks for no hit —
//                but it is still the honest name for "a tap that landed" and the client still
//                latches it, because the pair-of-moments assembly is what chargedHit copies.
//   quickShots   HOW MANY shots I have released below QUICK_CHARGE this step. A TALLY, not a latch:
//                the tap step wants three of them and does not care where they went, so `needs: 3`
//                compares against this number (isStepDone).
//   overHeld     I held past QUICK_CHARGE on a step that asked for a tap — the mistake behind the
//                `fix` line. A correction flag, not a completion one: nothing reads it as `done`.
//   underHeld    the mirror: I let go BELOW FULL_CHARGE on a step that asked for a full shot. Also
//                a correction only. Sampled at the release, where the client knows its own charge.
//   chargedShot  I released a shot at FULL charge. Like quickHit, no longer any step's `done` —
//                releasing at full says nothing about whether the bullet found anything.
//   chargedHit   ...and that full-charge shot LANDED on an enemy — the hold-and-aim lesson. Same
//                two-moments assembly as quickHit: the client stamps the full RELEASE and only
//                latches this if an enemy impact follows inside the bullet's lifetime.
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
// predicate, evaluated here rather than latched. A step with `needs` is the one other shape: its
// `done` names a MONOTONIC TALLY instead of a boolean, and a tally is just as dropped-frame-proof —
// it only ever goes up, and it is reset with the rest of the flags when the step advances.
export function isStepDone(l, n, ctx = {}) {
  const s = stepAt(l, n);
  if (!s) return false;
  if (s.done === 'inRing') {
    const dx = (ctx.px ?? 0) - TU_RING.x, dy = (ctx.py ?? 0) - TU_RING.y;
    return Math.hypot(dx, dy) <= TU_RING.r;
  }
  // A COUNT step: three quick taps, not one flag. `|| 0` so a context that has never heard of the
  // tally behaves exactly like a context whose tally is zero — the eight boolean flags below are
  // untouched by this branch, since a step without `needs` never enters it.
  if (s.needs) return (ctx[s.done] || 0) >= s.needs;
  return !!ctx[s.done];
}

// Has a step's `when` fired? Truthiness, for the boolean latches — EXCEPT on a count step whose
// `when` is its own tally, where the answer is the full count. Without that exception «3 מהירות!»
// would replace the «הקש! {k}/{t}» counter on tap one, i.e. the payoff line would arrive two taps
// before the payoff.
export function whenLatched(s, ctx = {}) {
  if (!s || !s.when) return false;
  if (s.needs && s.when === s.done) return (ctx[s.when] || 0) >= s.needs;
  return !!ctx[s.when];
}

// `{k}` (how many have landed) and `{t}` (how many are wanted) in a caption or second line, for a
// COUNT step. This is the whole of "three taps deserve visible progress": the counter rides text
// that is already on screen and styled, instead of a fourth element in the coach overlay that only
// one step in the game would ever use. A step without `needs` gets its line back untouched.
function fillCount(line, s, ctx) {
  if (!line || !s || !s.needs) return line || '';
  const k = Math.min(s.needs, ctx[s.done] || 0);
  return line.replace(/\{k\}/g, String(k)).replace(/\{t\}/g, String(s.needs));
}

// Which caption to show. A step with `cap2` swaps to it once its `when` flag latches — the strip
// step says «חטוף!» until the ball is loose and «גול!» after, which is one lesson, not two.
export function captionFor(l, n, ctx = {}) {
  const s = stepAt(l, n);
  if (!s) return '';
  return fillCount((s.cap2 && whenLatched(s, ctx)) ? s.cap2 : s.cap, s, ctx);
}

// The second line, with the same swap rule as the caption above: `sub` explains the control while
// the kid is working, and `sub2` replaces it the instant `when` latches. That swap is the whole
// teaching device of the find step — «גם אתה יכול להתחבא שם» is worth nothing said in advance and
// worth the entire lesson said one second after a bush ate a player in front of them.
export function subFor(l, n, ctx = {}) {
  const s = stepAt(l, n);
  if (!s) return '';
  return fillCount((s.sub2 && whenLatched(s, ctx)) ? s.sub2 : (s.sub || ''), s, ctx);
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
  // A HUB level is EXEMPT from the sequential chain and gates on level 1 alone. It has to be: it
  // auto-launches on the first hub visit, which happens right after level 1, so chaining it behind
  // קרב and טריקים would make its own entry condition unreachable. It is also honest — the combat
  // ladder is a skill progression where each level assumes the last, and reading a trophy bar does
  // not depend on knowing how to rocket-jump.
  if (tuIsHub(l)) return !!done && done.has(TU_LEVELS[0].id);
  for (let i = 0; i < l; i++) if (!done || !done.has(TU_LEVELS[i].id)) return false;
  return true;
}
// Is this level part of what a kid is shown? Everything is offered unless it says otherwise, so a new
// level is live by default and only an explicit `offered: false` (the parked hub tour) opts out. The
// ONE gate for all three ways a level can be reached — the auto-launch, the «איך משחקים?» picker and
// the finale's «המשך ל…» button — so a level cannot be half-hidden.
export const tuOffered = (l) => { const L = tuLevel(l); return !!L && L.offered !== false; };

// The level to offer next: the first unlocked one that isn't finished, else null (all done).
// A level that is not offered is skipped rather than stopping the walk — otherwise parking one in the
// middle of the list would hide every level after it.
export function nextLevel(done) {
  for (let i = 0; i < TU_LEVEL_COUNT; i++) {
    if (!tuOffered(i)) continue;
    if (!done || !done.has(TU_LEVELS[i].id)) return tuUnlocked(i, done) ? i : null;
  }
  return null;
}
