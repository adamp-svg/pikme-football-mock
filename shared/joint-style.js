// Corner-joint STYLE for steel-wall junctions — pure, so the builder, the in-game canvas and any
// future tool read one rule instead of drifting into three. Unit-tested by test-joint-style.mjs.
//
// WHY THIS EXISTS. A joint's GEOMETRY was never a user decision: wallJoints()/jointPolygon() in
// public/client.js derive it from the walls that actually meet at the junction, so corners build
// themselves the moment two walls touch. What used to be a user decision was the LOOK — one
// localStorage flag (`pikme-joint-style`) flipped every corner in every field between a mitred square
// and a round disc at once. That is backwards on both counts: the author had to choose up front, for
// the whole field, for corners they had not drawn yet; and a field that wants a round corner HERE and
// a square one THERE could not say so. Style is a property of the corner, not of the session.
//
// So: the corner is always built automatically, AUTO picks its look from its own angle, and the
// author may override that single corner.
//
// THE AUTO RULE reuses jointPolygon's own miter limit rather than inventing a second threshold. A
// mitre apex sits ht/sin(θ/2) from the junction, so as the two arms close, the spike grows without
// bound — jointPolygon therefore refuses to emit an apex once 1/sin(θ/2) exceeds MITER_LIMIT, which
// leaves precisely those acute corners visibly chopped flat. A disc is the honest read for a corner
// whose mitre was refused, so AUTO rounds exactly there and squares everywhere else. One threshold,
// one place: change MITER_LIMIT and both the hull and this rule move together.
export const MITER_LIMIT = 3.0;

// 'auto' is not a third look — it is the ABSENCE of an override, and it resolves to square/round.
export const JOINT_STYLES = ['auto', 'square', 'round'];

/**
 * The look a corner takes when nobody has overridden it.
 * @param minAngle the SHARPEST angle (radians) between any two arms meeting at the junction, as
 *                 measured by jointPolygon; null/0/NaN for a junction with no arm pair to bevel.
 */
export function autoJointStyle(minAngle) {
  const th = Number(minAngle);
  // No pair of arms (a lone stub end, or a pure crossing) → nothing could spike, so square.
  if (!Number.isFinite(th) || th <= 0) return 'square';
  const sh = Math.sin(th / 2);
  if (!(sh > 0)) return 'square';
  return 1 / sh > MITER_LIMIT ? 'round' : 'square';
}

/**
 * Stable identity for a junction. Junctions are DERIVED (a wall intersection), not stored elements,
 * so an override cannot be an array index — it is keyed by position. Walls are cell-snapped and the
 * cluster centre is their exact intersection, so rounding to the pixel is stable across reloads while
 * still distinguishing neighbouring corners (the grid is 50 units apart).
 */
export function jointKey(x, y) {
  return `${Math.round(Number(x) || 0)}:${Math.round(Number(y) || 0)}`;
}

/** The override for this corner if the author set one, else the AUTO look. */
export function resolveJointStyle(overrides, key, minAngle) {
  const o = overrides && typeof overrides === 'object' ? overrides[key] : null;
  if (o === 'square' || o === 'round') return o;
  return autoJointStyle(minAngle);
}

/** What the author has explicitly said about this corner ('auto' = nothing). */
export function overrideOf(overrides, key) {
  const o = overrides && typeof overrides === 'object' ? overrides[key] : null;
  return o === 'square' || o === 'round' ? o : 'auto';
}

/** Tapping the corner control walks auto → square → round → auto, so AUTO is always reachable. */
export function cycleJointStyle(cur) {
  const i = JOINT_STYLES.indexOf(cur === 'square' || cur === 'round' ? cur : 'auto');
  return JOINT_STYLES[(i + 1) % JOINT_STYLES.length];
}

/**
 * Write one override into the map, or REMOVE it for 'auto' — an 'auto' corner must leave no trace, or
 * a field would slowly accumulate keys that all mean "do the default".
 */
export function setJointOverride(overrides, key, style) {
  const out = { ...(overrides && typeof overrides === 'object' ? overrides : {}) };
  if (style === 'square' || style === 'round') out[key] = style;
  else delete out[key];
  return out;
}

/**
 * Drop overrides whose junction no longer exists. Corners are derived, so deleting or moving a wall
 * silently orphans its override — without this, a field carries styling for corners that are gone and
 * a LATER edit that recreates a corner at the same spot would inherit a style the author never chose
 * for it. Call on save with the keys currently on screen.
 */
export function pruneJointOverrides(overrides, liveKeys) {
  const src = overrides && typeof overrides === 'object' ? overrides : {};
  const live = liveKeys instanceof Set ? liveKeys : new Set(liveKeys || []);
  const out = {};
  for (const k of Object.keys(src)) {
    if (live.has(k) && (src[k] === 'square' || src[k] === 'round')) out[k] = src[k];
  }
  return out;
}
