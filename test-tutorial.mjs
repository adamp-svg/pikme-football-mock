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
import { FIELD, BOMB, BOMB_LOB_RANGE, VISION_RANGE, PROJECTILE, BUSH_REVEAL_DIST, BOMB_WALL_DIST, GOAL_RESET } from './shared/constants.js';
import {
  TU_LEVELS, TU_LEVEL_COUNT, TU_RING, TU_BALL_PARK, TU_SPAWN, TU_SHOT_SPOT, TU_DUMMY,
  TU2_SHOOT, TU2_BOMB, TU2_WALL, TU2_STRIP,
  tuLevel, stepsIn, stepAt, stageAt, doneStage, foeKeys,
  advance, isStepDone, showNudge, nudgeFor, captionFor, tuHasControl, isTutorialOver,
  bombHit, tuUnlocked, nextLevel, fieldFor, subFor, markersFor, TU3_FIND, TU3_FLY, TU3_BUSH,
  TU_HUB_LEVEL, tuIsHub, tuIsMockStep, introducesFor, TU_GOAL_HOLD,
} from './shared/tutorial.js';
import { bootServer } from './boot-test-server.mjs';
// Every match control a step could claim — a HUB step must claim none of them.
const L4_CTLS = ['move', 'aim', 'bomb', 'wall'];

let failures = 0;
const check = (cond, msg) => { console.log((cond ? '  ✅ ' : '  ❌ ') + msg); if (!cond) failures++; };
const L1 = 0, L2 = 1, L3 = 2;

// ===========================================================================
// A) The rules
// ===========================================================================
console.log('A1) three levels, in the taught order');
{
  check(TU_LEVEL_COUNT === 4, `four levels (${TU_LEVEL_COUNT})`);
  check(TU_LEVELS.map((L) => L.id).join(',') === 'basics,combat,tricks,mercaz', `ids: ${TU_LEVELS.map((L) => L.id).join(', ')}`);
  // FULL SHOT (`charge`) BEFORE the three quick taps (`shoot`) — the user's order, after playing it
  // on a phone. The ids kept their meaning (each is still named for the gesture it teaches), only
  // their places changed.
  check(TU_LEVELS[L1].steps.map((s) => s.id).join(',') === 'move,charge,shoot,goal,super',
    `level 1: ${TU_LEVELS[L1].steps.map((s) => s.id).join(' -> ')}`);
  check(TU_LEVELS[L2].steps.map((s) => s.id).join(',') === 'ballshot,bomb,wall,strip',
    `level 2: ${TU_LEVELS[L2].steps.map((s) => s.id).join(' -> ')}`);
  check(TU_LEVELS[L3].steps.map((s) => s.id).join(',') === 'find,fly',
    `level 3: ${TU_LEVELS[L3].steps.map((s) => s.id).join(' -> ')}`);
  // Every PITCH level needs one stage per step. A hub level has no pitch at all, so the rule is
  // "stages iff not a hub level" — checked both ways so a missing `where` can't smuggle a stageless
  // pitch level past this.
  for (const L of TU_LEVELS) {
    if (L.where === 'hub') { check(!L.stages, `${L.id}: a hub level carries no stages`); continue; }
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

console.log('A2b) introducesFor(): exactly four steps in the whole tutorial introduce a new button');
{
  // This is what the coach's DIMMING VEIL hangs off, and the reason it exists is a phone report: the
  // veil used to be up on every step of every level, so a kid who already knew how to walk played
  // half the tutorial through a dark screen. The rule is FIRST APPEARANCE ACROSS THE CURRICULUM, so
  // the assertions below are about the whole table at once, not about one level.
  const CTLS = ['move', 'aim', 'bomb', 'wall'];
  const introducers = [];
  for (const [l, L] of TU_LEVELS.entries()) {
    for (const [n, s] of L.steps.entries()) {
      const got = introducesFor(l, n);
      check(got.every((c) => CTLS.includes(c) && s.controls.includes(c)),
        `${L.id}/${s.id}: only ever names match controls the step actually enables`);
      if (got.length) introducers.push(`${L.id}/${s.id}:${got.join('+')}`);
    }
  }
  // Level 1 teaches the two sticks, level 2 the two buttons. Written as a full expected LIST rather
  // than four separate lookups: the point of the rule is that nothing ELSE dims the screen, and only
  // the whole list can say that.
  const firstAim = TU_LEVELS[L1].steps.findIndex((s) => s.controls.includes('aim'));
  const bombStep = TU_LEVELS[L2].steps.findIndex((s) => s.controls.includes('bomb'));
  const wallStep = TU_LEVELS[L2].steps.findIndex((s) => s.controls.includes('wall'));
  const want = [
    `basics/${TU_LEVELS[L1].steps[0].id}:move`,
    `basics/${TU_LEVELS[L1].steps[firstAim].id}:aim`,
    `combat/${TU_LEVELS[L2].steps[bombStep].id}:bomb`,
    `combat/${TU_LEVELS[L2].steps[wallStep].id}:wall`,
  ];
  check(introducers.join(' | ') === want.join(' | '), `the four veiled steps: ${introducers.join(' | ')}`);
  check(introducesFor(L1, 0).join(',') === 'move', 'level 1 step 1 introduces the move stick');
  check(introducesFor(L1, firstAim).join(',') === 'aim', "level 1's first shooting step introduces the aim stick");
  // The case the veil bug WAS: level 2 opens with move+aim listed, both taught a whole level earlier.
  check(introducesFor(L2, 0).length === 0, 'level 2 step 1 introduces NOTHING (move/aim came a level ago)');
  // Same argument, one level further on: level 3's fly step lists 💣, taught in level 2. This is why
  // the rule is first-appearance-across-the-curriculum and not a diff against the previous step.
  check(TU_LEVELS.every((L, l) => l < L2 + 1 || L.steps.every((_, n) => introducesFor(l, n).length === 0)),
    'no step after level 2 introduces anything — every button is old by then');
  // A HUB level points at DOM furniture and enables no match control at all, so it can never veil.
  check(TU_LEVELS[TU_HUB_LEVEL].steps.every((_, n) => introducesFor(TU_HUB_LEVEL, n).length === 0),
    'the hub level introduces nothing on any step');
  check(introducesFor(L1, 99).length === 0 && introducesFor(99, 0).length === 0, 'out of range introduces nothing');
}

console.log('A2c) a tutorial goal holds for ONE BEAT, not the match\'s five seconds');
{
  // The kid used to be frozen for the full GOAL_RESET after scoring, with the coach sitting the whole
  // of it out — five dead seconds. The room clamps it to TU_GOAL_HOLD (updateTutorial in server.js).
  // It must stay ABOVE ZERO: the client's `scored` latch is the resetTimer 0 -> positive edge, so a
  // cancelled freeze would delete the event that completes the goal steps. B6 proves the live timing.
  check(TU_GOAL_HOLD > 0, `the freeze still happens, so the goal still registers (${TU_GOAL_HOLD}s)`);
  check(TU_GOAL_HOLD <= 1.5 && TU_GOAL_HOLD < GOAL_RESET, `and it is one beat, not GOAL_RESET (${TU_GOAL_HOLD}s vs ${GOAL_RESET}s)`);
}

console.log('A3) captions stay tiny and every step has a stuck-nudge');
{
  const all = TU_LEVELS.flatMap((L) => L.steps);
  const longest = Math.max(...all.map((s) => s.cap.length));
  check(longest <= 14, `longest caption ${longest} chars`);
  // The tap step's caption carries its own progress counter («הקש! {k}/{t}»), so the raw template is
  // no longer what a kid reads. Check what actually reaches the screen, at every point in the count.
  const rendered = [0, 1, 2, 3, 99].flatMap((k) => TU_LEVELS.flatMap((L, l) => L.steps.map((_, n) => captionFor(l, n, { quickShots: k }))));
  const longestRendered = Math.max(...rendered.map((c) => c.length));
  check(longestRendered <= 14, `longest RENDERED caption ${longestRendered} chars`);
  check(!rendered.some((c) => /[{}]/.test(c)), 'no caption ever reaches the screen with an unfilled {token}');
  const tokened = all.filter((s) => /\{[kt]\}/.test(s.cap) || /\{[kt]\}/.test(s.sub || '') || /\{[kt]\}/.test(s.cap2 || ''));
  check(tokened.every((s) => s.needs > 1), 'only a COUNT step writes a {k}/{t} token — nothing else could fill one in');
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
  const flags = ['hitEnemy', 'quickHit', 'quickShots', 'overHeld', 'underHeld', 'chargedShot', 'chargedHit',
    'scored', 'bombHitFoe', 'wallBuilt', 'stripped', 'foundFoe', 'flew'];
  const cases = [
    [L1, 1, 'chargedHit'], [L1, 2, 'quickShots'], [L1, 3, 'scored'], [L1, 4, 'scored'],
    [L2, 0, 'scored'], [L2, 1, 'bombHitFoe'], [L2, 2, 'wallBuilt'], [L2, 3, 'stripped'],
    [L3, 0, 'foundFoe'], [L3, 1, 'flew'],
  ];
  // ...but a minDwell step will not ADVANCE on its flag alone, so give the predicate check the
  // dwell it needs (isStepDone is the flag; advance() is the flag plus the dwell — see A12).
  // A COUNT step cannot be probed with `true`: its predicate compares a TALLY against `needs`, and
  // `{ quickShots: true }` is one tap's worth of nothing. So each step is probed with the value it
  // actually asks for — `needs` for a count step, `true` for the boolean latches — and the rule
  // being asserted is unchanged: exactly one name in the list completes the step.
  for (const [l, n, flag] of cases) {
    const want = stepAt(l, n).needs || true;
    const only = flags.every((f) => isStepDone(l, n, { [f]: want }) === (f === flag));
    check(only, `${TU_LEVELS[l].id}/${stepAt(l, n).id} completes on ${flag} alone`);
  }
  // And a count step is not satisfied by a PARTIAL count, which is the one way this shape could go
  // wrong quietly (a truthiness test would pass on tap one).
  for (const [l, n] of cases) {
    const s = stepAt(l, n);
    if (s.needs) check(!isStepDone(l, n, { [s.done]: s.needs - 1 }), `${s.id}: ${s.needs - 1} of ${s.needs} is not done`);
  }
  check(TU_LEVELS.every((L, l) => L.steps.every((_, n) => !isStepDone(l, n, {}))), 'an empty context completes nothing');
}

console.log('A6) advance() walks each level to its end and then stops');
{
  for (const [l, L] of TU_LEVELS.entries()) {
    let n = 0;
    // Every completion flag in the game, true at once — the walker asserts a level CAN be finished,
    // not how. The second line is level 4's, latched on the tutorial's own mock lobby.
    // `quickShots: 9` rather than `true`: level 1's tap step wants a COUNT, and a walker that fed it
    // a boolean would report a level that cannot be finished.
    const ctx = { px: TU_RING.x, py: TU_RING.y, hitEnemy: true, quickHit: true, quickShots: 9, chargedShot: true, chargedHit: true, scored: true, bombHitFoe: true, wallBuilt: true, stripped: true, foundFoe: true, flew: true, sinceDone: 99,
      sawTrophies: true, deckMoved: true, slotFilled: true, heroTapped: true, friendsTapped: true, played: true };
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

console.log('A8) knocking the ball loose IS the strip lesson — no goal tacked on');
{
  check(captionFor(L2, 3, {}) === 'חטוף!', 'says «חטוף!» while they still have it');
  check(captionFor(L2, 3, { stripped: true }) === 'הכדור שוחרר!', 'and says so out loud the moment it comes loose');
  check(captionFor(L2, 1, { stripped: true }) === 'פצצה!', 'the flag does not leak into other steps');
  check(isStepDone(L2, 3, { stripped: true }), 'the strip alone completes it');
  check(!isStepDone(L2, 3, { scored: true }), 'and scoring without stripping does not');
  check(stepAt(L2, 3).minDwell === 2, 'it then holds 2s so the kid sees what they did');
  check(advance(L2, 3, { stripped: true, sinceDone: 0 }) === 3, '...not advancing instantly');
  check(advance(L2, 3, { stripped: true, sinceDone: 2.5 }) === 4, '...and moving on after the beat');
}

console.log('A8b) the gesture mimes match the gestures being taught');
{
  const g = (l, n) => stepAt(l, n).gesture;
  check(g(L1, 1) === 'hold', 'the FULL-shot step (taught first) mimes a hold');
  check(g(L1, 2) === 'tap', 'the three-quick-taps step (second) mimes a tap');
  check(g(L1, 3) === 'hold', 'the hold-and-release kick mimes a hold');
  check(g(L2, 0) === 'hold', 'so does shooting the ball');
  check(g(L2, 1) === 'lob' && g(L2, 2) === 'lob', '💣 and 🧱 mime the slow carry-it-outward lob');
  check(stepAt(L1, 1).minDwell === 1 && stepAt(L1, 2).minDwell === 1, 'both new L1 steps hold a beat before moving on');
}

console.log('A8c) the FULL shot comes first and must LAND; the three quick taps need no hit at all');
{
  // Both halves of this are the user's, reported after playing it on his phone: "in train 1, make
  // the first do a full shoot, which must hits the enemy. then the quick shoot which dosnt need to
  // hit the enemy (just 3 taps on the shoot)".
  const full = stepAt(L1, 1), tap = stepAt(L1, 2);
  check(full.id === 'charge' && tap.id === 'shoot', `full shot first (${full.id}), taps second (${tap.id})`);

  // --- THE FULL SHOT: the hold AND the hit -------------------------------------------------
  // `chargedShot` — a release at full charge — was the old predicate and it never asked where the
  // bullet went, so «ירייה חזקה!» could congratulate a shot that sailed into the touchline.
  check(full.done === 'chargedHit', `it completes on chargedHit, not on the release alone (${full.done})`);
  check(isStepDone(L1, 1, { chargedHit: true }), 'a full-charge shot that LANDS finishes it');
  check(!isStepDone(L1, 1, { chargedShot: true }), '...a full release that hit nothing does not');
  check(!isStepDone(L1, 1, { hitEnemy: true }), '...nor a hit that was not a full shot');
  check(!isStepDone(L1, 1, { quickHit: true }), '...including a tap that landed — this step is the hold');
  check(captionFor(L1, 1, { chargedShot: true }) === full.cap, 'the payoff caption waits for the hit...');
  check(captionFor(L1, 1, { chargedHit: true }) === 'ירייה חזקה!', '...and then names what they just did');
  // Its correction is the MIRROR of the tap step's: here the mistake is letting go too early, and it
  // is answered on the release rather than after nudgeAfter seconds of a kid who thinks they did it.
  check(full.fixWhen === 'underHeld', `its correction watches underHeld (${full.fixWhen})`);
  check(nudgeFor(L1, 1, {}) === full.nudge, 'no mistake yet -> the escalated line is the ordinary stuck-hint');
  check(nudgeFor(L1, 1, { underHeld: true }) === full.fix, `let go early -> «${full.fix}»`);
  check(nudgeFor(L1, 1, { underHeld: true, stepElapsed: 600 }) === full.fix, '...and the correction still wins once the stuck-hint is also due');
  check(showNudge(L1, 1, { stepElapsed: 1, underHeld: true }), 'answered AT ONCE, not after nudgeAfter seconds');
  check(!showNudge(L1, 1, { stepElapsed: 1, underHeld: true, chargedHit: true }), '...and gone the moment the full shot lands');
  // NO WAY TO GET STUCK: the mistake flag is inert everywhere except the line it prints.
  check(advance(L1, 1, { underHeld: true, stepElapsed: 600, sinceDone: 99 }) === 1, 'ten minutes of short shots neither passes nor fails the step');
  check(advance(L1, 1, { underHeld: true, chargedHit: true, sinceDone: 2 }) === 2, '...and the kid passes the instant one full shot lands, mistake and all');

  // --- THE THREE TAPS: a COUNT, and nothing about a hit ------------------------------------
  check(tap.done === 'quickShots' && tap.needs === 3, `it counts to ${tap.needs} quick releases (${tap.done})`);
  check(!isStepDone(L1, 2, { quickShots: 1 }), 'one tap is not three');
  check(!isStepDone(L1, 2, { quickShots: 2 }), 'two taps is not three');
  check(isStepDone(L1, 2, { quickShots: 3 }), 'three taps finishes it');
  check(isStepDone(L1, 2, { quickShots: 9 }), '...and so does nine — a count is a floor, not an exact score');
  // THE POINT OF THE STEP: three taps into empty grass is a PASS. The aim was taught by the step
  // before it; what this one teaches is the gesture and the rate.
  check(isStepDone(L1, 2, { quickShots: 3, hitEnemy: false, quickHit: false }), 'three taps that hit NOTHING is a pass, by design');
  check(!isStepDone(L1, 2, { quickHit: true, hitEnemy: true, chargedHit: true }), 'and landing shots is not what it asks for');
  // Visible progress, carried by the caption that is already on screen — no new overlay element.
  check(captionFor(L1, 2, {}) === 'הקש! 0/3', `it opens on «${captionFor(L1, 2, {})}»`);
  check(captionFor(L1, 2, { quickShots: 2 }) === 'הקש! 2/3', 'a kid who has tapped twice can see that they have');
  check(captionFor(L1, 2, { quickShots: 3 }) === '3 מהירות!', 'the third tap swaps in the payoff');
  check(captionFor(L1, 2, { quickShots: 1 }) !== tap.cap2, '...which does NOT fire on tap one: the COUNT latches it, not truthiness');
  check(captionFor(L1, 2, { quickShots: 9 }) === '3 מהירות!', 'and an over-eager kid never sees «הקש! 9/3»');
  check(subFor(L1, 2, { quickShots: 1 }) === tap.sub, 'the second line keeps explaining the gesture while they work');
  // The over-hold correction STAYED with this step — it is still the one that wants a short tap, and
  // a hold adds nothing to the tally, so without the line a kid who holds watches a counter refuse
  // to move.
  check(tap.fix === 'הקש קצר — בלי להחזיק' && tap.fixWhen === 'overHeld', `the tap step keeps the over-hold correction: «${tap.fix}»`);
  check(nudgeFor(L1, 2, { overHeld: true }) === tap.fix, 'held too long -> it becomes the correction');
  check(showNudge(L1, 2, { stepElapsed: 1, overHeld: true }), '...answered at once');
  check(!showNudge(L1, 2, { stepElapsed: 1, overHeld: true, quickShots: 3 }), '...and gone once the three taps are in');
  check(showNudge(L1, 2, { stepElapsed: 1, overHeld: true, quickShots: 2 }), '...but still up at two of three: a part-count is not a finished step');
  check(advance(L1, 2, { overHeld: true, quickShots: 3, sinceDone: 2 }) === 3, 'and a kid who held once still passes on their three taps, mistake and all');

  // Neither correction can leak into the other step.
  check(nudgeFor(L1, 1, { overHeld: true }) === full.nudge, 'over-holding cannot re-word the step whose whole lesson IS the hold');
  check(!showNudge(L1, 1, { stepElapsed: 1, overHeld: true }), '...nor make it shout at a kid doing it right');
  check(nudgeFor(L1, 2, { underHeld: true }) === tap.nudge, 'and letting go early cannot re-word the step that WANTS a short release');
  check(!showNudge(L1, 2, { stepElapsed: 1, underHeld: true }), '...same both ways round');
  check(TU_LEVELS.flatMap((L) => L.steps).every((st) => !st.fix === !st.fixWhen), 'every correction names the flag that triggers it, and vice versa');
  check(TU_LEVELS.flatMap((L) => L.steps).every((st) => st.fixWhen !== st.done), 'and no step is ever corrected for the thing that completes it');

  // --- GEOMETRY: why the swap is safe on this pitch ----------------------------------------
  // Neither shooting stage pins `me`, so the kid shoots from wherever inside TU_RING (r 80) the walk
  // step left them. MEASURED bullet ranges: ~936px fully charged, ~410px on a tap.
  const fullRange = 720 * PROJECTILE.ttl, quickRange = 720 * 0.4375 * PROJECTILE.ttl;
  const far = Math.hypot(TU_DUMMY.x - (TU_RING.x - TU_RING.r), TU_DUMMY.y - TU_RING.y);
  const near = Math.hypot(TU_DUMMY.x - (TU_RING.x + TU_RING.r), TU_DUMMY.y - TU_RING.y);
  check(far < fullRange, `worst case in the ring is ${Math.round(far)}px from the dummy < full-charge ${Math.round(fullRange)}px — the full shot always reaches`);
  check(far > quickRange, `...and ${Math.round(far)}px is BEYOND a tap's ${Math.round(quickRange)}px, which is exactly why the tap step must not require a hit`);
  check(near < fullRange, `best case ${Math.round(near)}px, also in range`);
  check(!stageAt(L1, 1).me && !stageAt(L1, 2).me, 'and neither shooting stage teleports the kid: the ring is where they shoot from');
}

console.log('A8d) the ball-shot step points at BOTH the ball and the goal');
{
  // «שוט לכדור!» is two facts, and it used to show one: the ball had a chevron and the goal — off
  // to the right of a landscape phone — had nothing on the grass naming it, so the step said shove
  // the ball and never said where.
  // The fix was the goal ARROW at first, and the user rejected it on sight — "i want a gohst thin
  // line stight". So the second fact is now carried by `aimline`, a thin dashed ray from the kid
  // through the ball to the pitch edge, and the arrow is not on this step at all.
  const cues = markersFor(stepAt(L2, 0));
  check(cues.includes('ball'), 'the ball is still marked — the kid has to know what to hit');
  check(cues.includes('aimline'), '...and a thin ghost line says where to point, so they know where it ends up');
  check(!cues.includes('goal'), 'and NOT the fat goal arrow — it was tried here and rejected');
  check(cues.indexOf('aimline') < cues.indexOf('ball'), 'line first: it draws under the chevron, not over it');
  check(markersFor(stepAt(L1, 3)).join() === 'goal', 'the arrow itself is untouched, and still level 1 goal step\'s cue');
  // ...but only that ONE step's. The level-1 finale drops it: the kid has already scored from that
  // exact spot with the arrow up, so a second one competes with the super meter for the screen.
  check(markersFor(stepAt(L1, 4)).length === 0, 'the super finale shows no world cue at all');
  // One name or several, the renderer only ever sees a list (tuDrawCue is called per cue).
  check(markersFor(stepAt(L1, 0)).join() === 'ring', 'a single-cue step still resolves to a one-item list');
  check(markersFor(null).length === 0 && markersFor({}).length === 0, 'and no step / no marker is an empty one');
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
  // The pitch ladder is no longer the whole tutorial: with the hub tour added, finishing טריקים
  // leaves מרכז to offer. Nothing is left only once all FOUR are done.
  check(nextLevel(all) === TU_HUB_LEVEL, 'levels 1-3 done -> offer the hub tour');
  check(nextLevel(new Set([...all, 'mercaz'])) === null, 'all four done -> nothing left to offer');
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
    if (!L.stages) continue;                       // a hub level stages nothing and spawns nothing
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
  // ...which is only true if the shooting STARTS with the wall already standing in the way. The
  // stage says so declaratively: its sentry holds its fire until the kid builds, so the dwell above
  // is the window the fire arrives in, not the leftovers of a burst that began before the wall did.
  const wallFoe = (stageAt(L2, 2).foes || [])[0];
  check(wallFoe.role === 'sentry' && wallFoe.armOn === 'wallBuilt',
    `the wall stage's sentry is armed by the build itself (armOn: '${wallFoe.armOn}')`);
  // `.filter(L => L.stages)`: a HUB level has no pitch to stage, so flatMapping every level's
  // stages walks off the end of the list.
  check(!TU_LEVELS.filter((L) => L.stages).flatMap((L) => L.stages).some((st) => (st.foes || []).some((f) => f.armOn && f.role !== 'sentry')),
    'and armOn is only ever put on a foe that has a gun to hold');
  for (const [l, n] of [[L3, 0], [L3, 1]]) {
    const st = stepAt(l, n);
    check(st.minDwell > 0, `${TU_LEVELS[l].id}/${st.id} dwells too (${st.minDwell}s)`);
  }
}

console.log('A13) level 3 is the only level with scenery: a bush to find someone in, a wall to fly off');
{
  check(fieldFor(L1).bushes.length === 0 && fieldFor(L2).bushes.length === 0, 'levels 1-2 play on a bare pitch');
  check(fieldFor(L1).hardWalls.length === 0 && fieldFor(L2).hardWalls.length === 0, '...and no steel either');
  check(fieldFor(L3).bushes.length === 1, 'level 3 has exactly one bush — you cannot teach stealth without it');
  check(fieldFor(L3).hardWalls.length === 1, '...and exactly one steel wall, for the rocket-jump to cannon off');
  // THE WATCHER IS IN THE BUSH. That is the step: it is invisible until you are almost on top of it
  // (BUSH_REVEAL_DIST = 110), so finding it is what teaches that a bush hides a whole player.
  const b = fieldFor(L3).bushes[0];
  const inBush = TU3_FIND.foe.x > b.x && TU3_FIND.foe.x < b.x + b.w && TU3_FIND.foe.y > b.y && TU3_FIND.foe.y < b.y + b.h;
  check(inBush, 'the watcher stands INSIDE the bush, not beside it');
  const d = Math.hypot(TU3_FIND.foe.x - TU3_FIND.me.x, TU3_FIND.foe.y - TU3_FIND.me.y);
  check(d > BUSH_REVEAL_DIST * 2, `and starts ${Math.round(d)}px away — genuinely invisible, so there is something to find`);
  check(d < VISION_RANGE + 120, '...but within a screen, so the bush is on frame one and the hunt is bounded');
  // THE FLY STEP'S WALL: behind the kid, inside the cannon's reach, not close enough to stand in.
  const w = fieldFor(L3).hardWalls[0];
  check(w.cx < TU3_FLY.me.x, 'the steel is BEHIND the kid (they fly right, into the open pitch)');
  const gap = TU3_FLY.me.x - (w.cx + w.ht);
  check(gap > 40 && gap < BOMB_WALL_DIST, `and ${Math.round(gap)}px back: inside BOMB_WALL_DIST (${BOMB_WALL_DIST}), clear of the stone`);
  check(Math.abs(w.cy - TU3_FLY.me.y) < w.hl, 'and tall enough to actually be behind them');
}

console.log('A13b) the find step teaches its lesson AFTER the discovery, not before');
{
  const f = stepAt(L3, 0);
  // Asked through markersFor, not `!f.marker`: the step writes its intent as `marker: 'none'`, which
  // is a truthy string, so the old form failed on a step that is in fact correct. What matters is
  // that the step resolves to NO cues, whatever it wrote to say so.
  check(f.done === 'foundFoe' && markersFor(f).length === 0, 'no world cue points at the bush — that would answer the question');
  check(!f.controls.includes('bomb') && !f.controls.includes('wall'), 'and nothing to press: it is a walk and a look');
  // The payoff line is «גם אתה יכול להתחבא שם», and it must NOT be on screen before they find him.
  check(subFor(L3, 0, {}) === f.sub, 'before the sighting the second line is the search hint');
  check(subFor(L3, 0, { foundFoe: true }) === f.sub2, '...and swaps to the "you can hide there too" payoff after it');
  check(captionFor(L3, 0, { foundFoe: true }) === 'הוא היה בשיח!', 'the caption names where he was');
  check(advance(L3, 0, { foundFoe: true, sinceDone: 0 }) === 0, 'and the step holds open so both lines get read');
  check(advance(L3, 0, { foundFoe: true, sinceDone: 3 }) === 1, '...then moves on to the fly step');
  // The fly step: one tap, and the wall is already there — 🧱 is level 2's lesson, not this one.
  const fly = stepAt(L3, 1);
  check(fly.gesture === 'tap' && fly.spotlight === 'bomb', 'the fly step mimes a TAP on 💣');
  check(!fly.controls.includes('wall'), 'and never asks the kid to build the ramp themselves');
  check(/כוון/.test(fly.sub), `it says to aim first: «${fly.sub}»`);
  check(/קיר/.test(fly.nudge), `and the stuck-hint is about the wall, not the button: «${fly.nudge}»`);
}

console.log('A14) both bomb inputs are explained, not just the one the step needs');
{
  const bomb = stepAt(L2, 1), wall = stepAt(L2, 2);
  check(/הקשה/.test(bomb.sub) && /גרירה/.test(bomb.sub), `the bomb step spells out tap vs drag: «${bomb.sub}»`);
  check(/הקשה/.test(wall.sub) && /גרירה/.test(wall.sub), `so does the wall step: «${wall.sub}»`);
}

console.log('A15) LEVEL 4 (מרכז) is a HUB level: six steps, no pitch, no room');
{
  const L = tuLevel(TU_HUB_LEVEL);
  check(L.id === 'mercaz', `level 4 is mercaz (${L.id})`);
  check(tuIsHub(TU_HUB_LEVEL) === true, 'level 4 runs in the hub');
  check([0, 1, 2].every((l) => !tuIsHub(l)), 'levels 1-3 do not');
  check(L.stages === undefined, 'a hub level has no pitch stages');
  check(stepsIn(TU_HUB_LEVEL) === 6, `six steps (${stepsIn(TU_HUB_LEVEL)})`);
  check(L.steps.map((s) => s.id).join(',') === 'trophies,deck,slots,hero,friends,play',
    `collect-then-play: ${L.steps.map((s) => s.id).join(' -> ')}`);
  // A stageless level must not throw its way through the helpers the server uses.
  check(stageAt(TU_HUB_LEVEL, 0) === null, 'stageAt on a hub level is null, not a crash');
  check(foeKeys(TU_HUB_LEVEL).length === 0, 'a hub level has no cast to spawn');
  check(!!fieldFor(TU_HUB_LEVEL), 'fieldFor falls back rather than returning undefined');
}

console.log('A16) level 4 completes on TAPS, and isStepDone needs no special-casing to read them');
{
  const H = TU_HUB_LEVEL;
  check(stepAt(H, 0).done === 'sawTrophies' && stepAt(H, 0).minDwell >= 2,
    'the trophy step is a dwell — the bar cannot be tapped, so the lesson is watching it');
  check(isStepDone(H, 1, {}) === false, 'deck step incomplete with no gesture');
  check(isStepDone(H, 1, { deckMoved: true }) === true, 'deck step completes when the carousel moves');
  check(isStepDone(H, 2, { slotFilled: true }) === true, 'slots step completes when a slot fills');
  check(isStepDone(H, 5, { played: true }) === true, 'play step completes on the tap');
  check(isStepDone(H, 3, {}) === false, 'hero step incomplete until tapped');
  check(isStepDone(H, 3, { heroTapped: true }) === true, 'hero step completes on the tap');
  check(isStepDone(H, 4, {}) === false, 'friends step incomplete until tapped');
  check(isStepDone(H, 4, { friendsTapped: true }) === true, 'friends step completes on the tap');
  // Unfailable, like every other level: the nudge escalates and that is all it does.
  check(showNudge(H, 1, { stepElapsed: 999 }) === true, 'a stuck kid gets the nudge');
  check(showNudge(H, 1, { stepElapsed: 999, deckMoved: true }) === false, 'no nudge once done');
  check(advance(H, 5, { played: true }) === doneStage(H), 'the last step ends the level');
  // No control is ever claimed by a hub step — the sticks and buttons are not on this screen.
  check(L4_CTLS.every((c) => !tuHasControl(H, 0, c)), 'a hub step claims no match controls');
  // The MOCK/REAL split: the lesson happens on a lobby the tutorial draws, and only the finale
  // touches the live hub. If a teaching step ever loses its `mock` flag it starts driving the real
  // hub again, which is the whole class of bug the mock was adopted to remove.
  check([0, 1, 2, 3, 4].every((n) => tuIsMockStep(H, n)), 'the five teaching steps run on the mock');
  check(tuIsMockStep(H, 5) === false, 'the finale runs on the REAL hub — the tour ends in a real match');
  check(stepAt(H, 5).spotlight === 'hubPlay', 'and it points at the real quick-match button');
  check([0, 1, 2, 3, 4].every((n) => /^mock/.test(stepAt(H, n).spotlight)), 'every teaching step points at a mock target');
}

console.log('A17) the hub tour is EXEMPT from the sequential chain (it auto-launches after level 1)');
{
  const H = TU_HUB_LEVEL;
  check(tuUnlocked(H, new Set()) === false, 'locked before level 1');
  check(tuUnlocked(H, new Set(['basics'])) === true, 'open on level 1 alone — not gated on קרב/טריקים');
  check(tuUnlocked(H, new Set(['basics', 'mercaz'])) === true, 'and stays open, so it can be replayed');
  // The exemption must not leak into the pitch ladder.
  check(tuUnlocked(2, new Set(['basics'])) === false, 'טריקים still waits for קרב');
  check(tuUnlocked(2, new Set(['basics', 'combat'])) === true, 'and opens once קרב is done');
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
  c.send({ type: 'tuStage', n: 2 });   // the three-taps step (same pitch as the full-shot step)
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
    // ...and the freeze that follows is ONE BEAT, not the match's GOAL_RESET. The room clamps it to
    // TU_GOAL_HOLD, and the coach cannot advance until the sim thaws (tuTick waits for resetTimer to
    // reach 0), so this number IS how long the kid waits between scoring and the next lesson. It was
    // five seconds of a frozen body and a frozen coach; the budget below would fail on that.
    const t0 = Date.now();
    const thawed = await c.until((x) => x.resetTimer === 0, 'freeze over', 4000);
    const held = Date.now() - t0;
    check(!!thawed && held < 2500, `the post-goal freeze is one beat, not GOAL_RESET (${held}ms)`);
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

console.log('C4) the wall step turns that same foe into a sentry that HOLDS ITS FIRE');
{
  c.send({ type: 'tuStage', n: 2 });
  await c.until((x) => {
    const f = x.players.find((p) => p.id !== myId2);
    return !!f && Math.hypot(f.x - TU2_WALL.foe.x, f.y - TU2_WALL.foe.y) < 60;
  }, 'sentry placed', 5000);
  const placed = c.snap();
  const foe = placed && placed.players.find((p) => p.id !== myId2);
  check(!!foe && Math.abs(foe.x - TU2_WALL.foe.x) < 80, 'foe re-homed to the sentry spot — same body, new job (no roster churn)');
  // This assertion used to be the opposite one ("opened fire within 9s"), and a phone report killed
  // it: a seven-year-old was being shot at while still working out what 🧱 does, and every shot
  // landed BEFORE the wall existed, so the wall was never seen stopping anything. The sentry now
  // waits for the build (armOn), so silence here is the feature. 5s is a third of the time a kid
  // spends on this step and ~3x the sentry's longest quiet window if it were live at all.
  const d = driver(c);
  const t0 = Date.now();
  let sawShot = false;
  while (Date.now() - t0 < 5000 && !sawShot) {
    d.input({});                                  // stand still, build nothing
    const s = c.snap();
    if (s && (s.projectiles || []).length) sawShot = true;
    await sleep(60);
  }
  check(!sawShot, 'nothing was fired in 5s of standing there with no wall up');
}

console.log('C5) building a wall works on that step — and THAT is what opens fire');
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
  // The other half of the lesson: the wall is up, so the shooting starts, and it starts inside the
  // step's ~3s dwell — the kid is looking at the wall when the tracers reach it. The sentry is armed
  // on the tick after the build and its opening burst is immediate, so 4s is generous.
  const t0 = Date.now();
  let sawShot = false;
  while (Date.now() - t0 < 4000 && !sawShot) {
    d.input({});                                  // hands off — watch the wall do its job
    const x = c.snap();
    if (x && (x.projectiles || []).length) sawShot = true;
    await sleep(60);
  }
  check(sawShot, 'the sentry opened fire once the wall was standing — «הקיר עוצר יריות!» has something to stop');
  // And it STAYS armed: the wall it is shooting at is 4 blocks of hp3 and will be rubble soon, and a
  // sentry that fell silent when the wall broke would teach that the wall works by not being shot at.
  const dead = await c.until((x) => !(x.walls || []).length, 'wall smashed', 12000);
  if (dead) {
    let stillShooting = false;
    const t1 = Date.now();
    while (Date.now() - t1 < 4000 && !stillShooting) {
      d.input({});
      const x = c.snap();
      if (x && (x.projectiles || []).length) stillShooting = true;
      await sleep(60);
    }
    check(stillShooting, 'and it keeps firing after that wall is gone — the arming is a one-way latch');
  } else {
    console.log('  · the wall outlived the 12s watch; the stays-armed half is untested this run');
  }
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
