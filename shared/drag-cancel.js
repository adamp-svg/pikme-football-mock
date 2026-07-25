// The Brawl-Stars-style "drag back to the centre = cancel" state machine, shared by the
// WALL-BUILD button and the BOMB button. Pure math + a clock, no DOM — so it is unit-testable
// (test-drag-cancel.mjs) and the two buttons can never drift apart.
//
// THE BUG IT FIXES: the old machine armed cancel the instant the drag dropped below CANCEL_IN_PX
// and only disarmed again past CANCEL_ARM_PX. A player who RE-AIMS by sweeping the thumb across
// the button centre passed straight through the cancel zone, armed it, and then released in the
// 18..34 px band on the far side — a perfectly good aim, silently cancelled. It read as "the wall
// just didn't build".
//
// The rule is now POSITIONAL and states it in one line: releasing inside the cancel zone cancels,
// releasing outside it commits. Nothing latched, nothing time-dependent, nothing the player can't
// see — which is what makes it predictable under the thumb.
//
// The dwell below is therefore NOT the correctness mechanism; it only decides when the red ✕ and
// the cancel buzz APPEAR, so a finger sweeping through the middle doesn't strobe them. Because
// releaseCancels() reads position alone, the preview always agrees with what release actually does.

export const CANCEL_ARM_PX = 34;    // pull past this = a real, cancellable aim (latches `aimed`)
export const CANCEL_IN_PX = 18;     // inside this = the cancel zone
export const CANCEL_OUT_PX = 26;    // back out past this = the ✕ clears (anti-jitter margin)
export const CANCEL_DWELL_MS = 120; // sit inside the zone this long before the ✕ shows

// The cancel half of a drag's state. Spread into the button's drag object at pointerdown / reset.
export function newDragCancel() {
  return { aimed: false, cancelArmed: false, wasCancel: false, inSince: null };
}

// Advance the machine from the drag's current dx/dy at time `now` (ms, performance.now()).
// Call from pointermove AND once per frame — a finger that stops dead inside the zone emits no
// further pointermove events, and the dwell still has to elapse for the ✕ to appear.
// Returns the haptic edge to fire: 'cancel' | 'rearm' | null. Edge-triggered, so a stream of
// samples inside the zone buzzes exactly once.
export function updateDragCancel(drag, now) {
  const m = Math.hypot(drag.dx, drag.dy);
  if (m > CANCEL_ARM_PX) drag.aimed = true;              // latch: a deliberate aim happened
  if (!drag.aimed) {
    drag.inSince = null;                                 // no cancel affordance before a real aim
  } else if (m < CANCEL_IN_PX) {
    if (drag.inSince == null) drag.inSince = now;        // entered the zone → start the dwell clock
    if (now - drag.inSince >= CANCEL_DWELL_MS) drag.cancelArmed = true; // settled → show the ✕
  } else {
    drag.inSince = null;                                 // left the zone → re-entry restarts the dwell
    if (m > CANCEL_OUT_PX) drag.cancelArmed = false;
  }
  const nowCancel = !!drag.cancelArmed;
  let edge = null;
  if (nowCancel && !drag.wasCancel) edge = 'cancel';                    // crossed INTO cancel → buzz
  else if (!nowCancel && drag.wasCancel && drag.aimed) edge = 'rearm';  // pulled back out → light tick
  drag.wasCancel = nowCancel;
  return edge;
}

// Does releasing RIGHT NOW cancel? Position only: the finger is inside the cancel zone after a
// real aim. You cannot aim an 18 px drag, so lifting there is unambiguously an abort — and a
// release OUTSIDE the zone always commits, which is exactly the band where the old machine ate
// builds. Deliberately does NOT consult cancelArmed: that would re-create a latched band
// (18..26 px) where the release disagrees with the finger's position.
export function releaseCancels(drag) {
  return !!drag.aimed && Math.hypot(drag.dx, drag.dy) < CANCEL_IN_PX;
}
