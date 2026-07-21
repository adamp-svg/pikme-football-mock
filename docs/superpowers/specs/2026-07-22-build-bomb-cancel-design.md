# Timed cancelable wall build + aimed cancelable bomb

**Date:** 2026-07-22
**Component:** `football-mock` (2v2 realtime football minigame)
**Status:** Design approved, ready for implementation plan

## Problem

Two player abilities feel unforgiving and lack counterplay:

- **Wall build** is instant. A misclick immediately spends a charge and drops a wall
  you didn't want, and enemies get zero warning.
- **Bomb (special)** is instant, un-aimed, and un-cancelable — it always plants at
  your own feet. There is no offensive placement and no way to abort a stray tap.

We want both to reuse the *shooting* interaction the game already ships (hold to
charge, drag to aim, release-on-self to cancel), so feel and code stay consistent.

## Guiding principle

Mirror the existing shooting state machine. Shooting today
([client.js:1418-1446](../../../public/client.js), sim charge ramp in
[sim.js](../../../shared/sim.js)) is:

- `hold` — an input **level**; the server ramps charge power while it's held.
- `fire` — a release **edge**; commits the shot in the pulled-out direction.
- **Spatial cancel** — `aimPulled()` compares the aim against a 12px deadzone
  (`AIM_DEADZONE_PX`). Release inside the deadzone (aim on yourself) = cancel:
  no shot, no sound, no ammo spent (`cancelCharge()`).

Both new mechanics adopt this shape.

## Non-goals

- No change to the ammo/reload economy: `BUILD_MAG=2`, `BUILD_RELOAD=30s`,
  `BUILD_COOLDOWN=0.4s`.
- No change to wall HP / fragile-zone rules, or to bomb fuse / blast / stacking /
  wall-cannon math.
- No change to collision code (`shared/arena.js`).
- No projectile arc for the lobbed bomb in v1 (a client-side visual arc is optional
  future polish; the sim places the bomb directly at the target coordinate).

---

## Component 1 — Wall build: 0.5s hold-to-confirm windup

### Behavior

1. Press-and-hold the build control. The player enters a **windup**: a 0.5s ring
   fills and a ghost wall previews at the exact angle/position it will occupy.
2. While winding up the player may **move, but at reduced speed** (`BUILD_WINDUP_SLOW`,
   50%). The wall does not exist yet and blocks nothing.
3. Drag to aim the wall orientation (already supported — `buildDrag`).
4. **Release:**
   - windup ≥ 100% **and** aim pulled past the deadzone → wall places at the
     current position/orientation. The build charge is consumed **here, at commit**.
   - released early (windup < 100%) **or** released on self (inside deadzone) →
     **cancel**: no wall, no charge spent.
5. **Interrupt = counterplay:** a knockback or full-power hit landing on the player
   while winding up resets the windup to 0 (cancel). Because the charge is only
   spent at commit, the charge is preserved automatically ("refund" is free).

### Server (`shared/sim.js`, `shared/constants.js`)

- New constants in `constants.js`:
  - `BUILD_WINDUP = 0.5` — seconds of hold required to commit.
  - `BUILD_WINDUP_SLOW = 0.5` — move-speed multiplier while winding up.
- New per-player state: `buildWindup` (0→1 progress), plus reacting to a new
  `buildHold` input **level** (analogous to shooting's `hold`).
- Per tick:
  - If `buildHold` is set, `buildAmmo ≥ 1`, and `buildCd ≤ 0`: ramp
    `buildWindup += dt / BUILD_WINDUP` (clamp to 1), and apply `BUILD_WINDUP_SLOW`
    to this player's movement this tick.
  - If `buildHold` clears without a commit (i.e. no `build` edge, or windup < 1),
    reset `buildWindup = 0`.
- On the `build` release **edge**: call `buildWall(...)` **only if**
  `buildWindup ≥ 1` and the aim indicates a real placement (not a deadzone cancel;
  the client won't send the edge on a cancel, but the server also guards on windup).
  `buildWall` continues to decrement `buildAmmo` and set `buildCd` exactly as today
  ([sim.js:603-604](../../../shared/sim.js)).
- On any knockback / full-power hit applied to the player, set `buildWindup = 0`.
- **Remove** the current instant-build path ([sim.js:435](../../../shared/sim.js)):
  `if (p._build && p.buildCd <= 0 && p.buildAmmo >= 1) buildWall(...)`.

### Wire (`shared/wire.js`) — zero extra downstream bytes

- Upstream input message gains a `buildHold` boolean level (alongside the existing
  `build` edge). Server input default/parse/edge-consume mirror `hold`/`fire`
  ([server.js:113,385,401,671-675](../../../server.js)).
- Downstream: use the free flags **bit 7 (128)** in `packFlags` as a "winding"
  flag, and **reuse the existing `buildFrac` byte** to carry windup progress when
  winding, reload progress otherwise. `decodeSnapshot` reads the winding bit to
  decide which meaning `buildFrac` has. No new bytes on the snapshot.

### Client (`public/client.js`)

- Build button `pointerdown` → `beginBuild()`: set a local `buildHolding=true`
  (sent as `buildHold:true` each frame from `sampleInput`), capture a local windup
  start timestamp for the HUD ring (mirrors `chargeStart`/`currentCharge`).
- `pointermove` → aim as today (`buildDrag`).
- `pointerup` → if aim pulled past `AIM_DEADZONE_PX` → `releaseBuild(aim)`
  (the `build` edge); else `cancelBuild()` (clear hold, no edge).
- Keyboard `Q` becomes hold-to-build: keydown begins the hold, keyup releases;
  a release before the windup completes is a natural cancel.
- Extend the **existing ghost preview** ([client.js:2705-2723](../../../public/client.js)):
  fill/brighten it as the local windup estimate climbs, snap fully solid at 100%.
  Reconcile the ring against the server's `buildFrac` when the winding flag is set.
- Pause/blur teardown must also clear `buildHolding` and the windup timestamp
  ([client.js:1694](../../../public/client.js)).

---

## Component 2 — Bomb: aimed short-lob + cancel (no windup)

### Behavior

- **Tap** the bomb button → instant plant at your feet = rocket-jump, exactly as
  today. Stays snappy; a stray tap plants at feet (low cost, not cancelable — this
  is the accepted tradeoff for keeping the rocket-jump instant).
- **Hold + drag** → aim mode: a ghost bomb marker slides along the aim direction up
  to `BOMB_LOB_RANGE`. **Release:**
  - past the deadzone → bomb lands at that spot (offensive lob; no self-launch,
    since the planter ends up outside `BOMB_CENTER_R`).
  - back inside the deadzone (on self/button) → **cancel**, no bomb, no cooldown.
- No 0.5s windup — bombs already self-telegraph via their fuse.

### Server (`shared/sim.js`, `shared/constants.js`)

- New constant `BOMB_LOB_RANGE ≈ 250` (px).
- `useSpecial(state, p, ch)` ([sim.js:553-560](../../../shared/sim.js)) takes the
  player's aim and places the bomb at
  `clamp(p.pos + aimDir × min(aimDist, BOMB_LOB_RANGE))` instead of always `p.x,p.y`.
  A feet plant (tap / near-zero aim) puts it within `BOMB_CENTER_R` of the planter,
  so the existing rocket-jump / wall-cannon / stacking logic
  ([sim.js:739-770](../../../shared/sim.js)) fires unchanged. A far lob lands
  outside `BOMB_CENTER_R`, so no self-launch — again, no change to that math.
- Bomb is created at the target coordinate immediately; fuse starts on placement.

### Client (`public/client.js`)

- Special button: distinguish tap vs hold+drag (reuse the `buildDrag`-style pointer
  bookkeeping). Tap → send `special` edge with no aim offset (feet plant). Drag →
  show a ghost bomb marker along the aim (clamped to range); on release send the
  `special` edge **with the aim offset**, or cancel if released inside the deadzone.
- Extend the input message so the `special` edge can carry the aim offset the server
  uses for placement (or reuse the existing per-frame `aimX/aimY`, captured at
  release like `aimHold`/`buildHold` do for shooting/build).

---

## Testing

Add unit tests in the existing `test-*.mjs` sim-driver style
(see `test-mechanics.mjs`, `test-power.mjs`):

- Wall: not placed until 0.5s of hold; released early cancels and refunds the charge;
  a hit during windup interrupts and refunds; movement is slowed while winding;
  a full-windup release places exactly one wall and spends one charge.
- Bomb: a tap plants at feet and the planter rocket-jumps; a drag past range lands
  the bomb at the clamped target and the planter does **not** self-launch; a drag
  released inside the deadzone plants nothing and spends no cooldown.

Then a smoke run (`_smoke-play.mjs` / `_smoke-hard.mjs`) to confirm no desync or
crash over a full match with bots exercising build + bomb.

## Files touched

- `shared/constants.js` — `BUILD_WINDUP`, `BUILD_WINDUP_SLOW`, `BOMB_LOB_RANGE`.
- `shared/sim.js` — windup ramp + slow, commit-on-release, hit-interrupt, remove
  instant build; aimed bomb placement in `useSpecial`.
- `shared/wire.js` — `buildHold` upstream; winding flag + `buildFrac` overload.
- `server.js` — input default/parse/edge-consume for `buildHold`.
- `public/client.js` — build hold/cancel + windup ring, ghost fill; bomb tap-vs-drag
  aim/cancel with ghost marker.
- `test-*.mjs` — new coverage listed above.
