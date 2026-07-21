# Timed Cancelable Wall Build + Aimed Cancelable Bomb — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give wall build a 0.5s hold-to-confirm windup (with move-slow, hit-interrupt, and cancel) and make the bomb aimable into a short lob (with tap = feet rocket-jump and drag-back = cancel), reusing the existing shooting state machine.

**Architecture:** The football sim (`shared/sim.js`) is authoritative and runs on both server (source of truth) and client (prediction). Input flows client → server as a JSON `input` message with level signals (`hold`) and edges (`fire`/`special`/`build`). We add a `buildHold` level + keep the `build` edge for walls, add a `sax/say` special-aim offset for bombs, ramp a server-owned `buildWindup`, and commit the wall only on release at full windup. The bomb's placement point moves from the planter's feet to `feet + aim×offset` (clamped), leaving all rocket-jump / blast math untouched.

**Tech Stack:** Node.js (ESM, `type: module`), `ws` WebSockets, plain-canvas client, hand-rolled `.mjs` sim unit tests run with `node`.

## Global Constraints

- Node `>=18`. ESM only (`import`/`export`), no TypeScript.
- The sim is shared and must stay deterministic and identical server/client — no `Date.now()`/`Math.random()` in new sim code paths that affect state.
- Downstream binary snapshot (`shared/wire.js`) must not grow: reuse the free flags bit 7 (128) and the existing `buildFrac` byte. The upstream `input` message is JSON and may gain fields freely.
- Do not change the ammo/reload economy: `BUILD_MAG=2`, `BUILD_RELOAD=30`, `BUILD_COOLDOWN=0.4`.
- Do not change bomb fuse/blast/stacking/wall-cannon math, or `shared/arena.js` collision code.
- Follow existing code style: terse, comment-dense, existing helper names (`clamp`, `step`, `inp`).
- Tests exit non-zero on any failure (`node test-*.mjs`). Commit after each green task.

---

### Task 1: Add tuning constants

**Files:**
- Modify: `shared/constants.js`

**Interfaces:**
- Produces: `BUILD_WINDUP = 0.5`, `BUILD_WINDUP_SLOW = 0.5`, `BUILD_INTERRUPT_KV = 300`, `BOMB_LOB_RANGE = 250` (all exported `const`).

- [ ] **Step 1: Add the constants**

In `shared/constants.js`, immediately after the existing build block (the lines defining `BUILD_MAG`, `BUILD_RELOAD`, `BUILD_COOLDOWN`, `MAX_BUILT_WALLS` near line 215-218), add:

```js
// Wall build is now a HOLD-TO-CONFIRM windup (mirrors the shot charge): you hold the
// build control for BUILD_WINDUP seconds while a ghost previews, then release to place.
// Releasing early — or aiming on yourself — cancels (no charge spent). Moving while
// winding up is slowed. A knockback/full-power hit above BUILD_INTERRUPT_KV cancels it.
export const BUILD_WINDUP = 0.5;        // seconds of hold to commit a wall
export const BUILD_WINDUP_SLOW = 0.5;   // move-speed multiplier while winding up
export const BUILD_INTERRUPT_KV = 300;  // incoming knockback speed that cancels a windup
```

Then, immediately after the bomb block (near `BOMB_STACK_RADIUS`, line 182), add:

```js
// Bomb can be LOBBED: a tap plants at your feet (rocket-jump preserved), a drag aims a
// short throw up to BOMB_LOB_RANGE px (offensive plant, no self-launch). See useSpecial.
export const BOMB_LOB_RANGE = 250;      // max distance a lobbed bomb can be placed from the planter
```

- [ ] **Step 2: Verify it imports**

Run: `node -e "import('./shared/constants.js').then(m=>console.log(m.BUILD_WINDUP, m.BUILD_WINDUP_SLOW, m.BUILD_INTERRUPT_KV, m.BOMB_LOB_RANGE))"`
Expected: `0.5 0.5 300 250`

- [ ] **Step 3: Commit**

```bash
git add shared/constants.js
git commit -m "feat(sim): add build-windup + bomb-lob tuning constants"
```

---

### Task 2: Wall build windup in the sim (server-authoritative)

**Files:**
- Modify: `shared/sim.js` (player loop ~311-393; per-player actions ~434-435)
- Test: `test-build-windup.mjs` (create)

**Interfaces:**
- Consumes: input fields `buildHold` (bool level) and `build` (bool edge) on the per-player input object; constants from Task 1.
- Produces: per-player `p.buildWindup` (0→1). Wall placement happens only via `buildWall` on a `build` edge at `buildWindup >= 1`. `buildWall` signature unchanged.

- [ ] **Step 1: Write the failing test**

Create `test-build-windup.mjs`:

```js
// Sim unit tests for the wall-build hold-to-confirm windup.
// Run: node test-build-windup.mjs   (exits non-zero on any failure)
import { createState, addPlayer, step } from './shared/sim.js';
import { DT, BUILD_WINDUP, BUILD_INTERRUPT_KV } from './shared/constants.js';

let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fails++; };

function fresh() {
  const s = createState();
  s.resetTimer = 0;
  addPlayer(s, 'p1', { name: 'A', char: 'player', team: 'A', slot: 0 });
  addPlayer(s, 'p2', { name: 'B', char: 'player', team: 'B', slot: 0 });
  s.players.p1.x = 500; s.players.p1.y = 500;
  return s;
}
function inp(o = {}) { return { seq: 1, moveX: 0, moveY: 0, aimX: 1, aimY: 0, hold: false, fire: false, special: false, build: false, buildHold: false, sax: 0, say: 0, ...o }; }
// Hold buildHold for `secs`, then optionally release with a build edge.
function holdBuild(s, secs, { release = true } = {}) {
  const n = Math.max(0, Math.round(secs / DT));
  for (let i = 0; i < n; i++) step(s, { p1: inp({ buildHold: true }), p2: inp() }, DT);
  if (release) step(s, { p1: inp({ buildHold: false, build: true }), p2: inp() }, DT);
}

// 1) Releasing at full windup places exactly one wall and spends one charge.
{
  const s = fresh();
  const before = s.players.p1.buildAmmo;
  holdBuild(s, BUILD_WINDUP + 0.05);
  ok(s.builtWalls.length === 1, `full windup places a wall (n=${s.builtWalls.length})`);
  ok(s.players.p1.buildAmmo === before - 1, `full windup spends one charge (${s.players.p1.buildAmmo} === ${before - 1})`);
}

// 2) Releasing BEFORE full windup places nothing and spends no charge (cancel).
{
  const s = fresh();
  const before = s.players.p1.buildAmmo;
  holdBuild(s, BUILD_WINDUP * 0.5);
  ok(s.builtWalls.length === 0, `early release places no wall (n=${s.builtWalls.length})`);
  ok(s.players.p1.buildAmmo === before, `early release refunds charge (${s.players.p1.buildAmmo} === ${before})`);
}

// 3) A knockback during windup cancels it (no wall even if you keep holding to full).
{
  const s = fresh();
  const half = Math.round((BUILD_WINDUP * 0.5) / DT);
  for (let i = 0; i < half; i++) step(s, { p1: inp({ buildHold: true }), p2: inp() }, DT);
  s.players.p1.kvx = BUILD_INTERRUPT_KV + 200; // simulate a hit
  step(s, { p1: inp({ buildHold: true }), p2: inp() }, DT); // interrupt tick
  ok(s.players.p1.buildWindup === 0, `hit resets windup (${s.players.p1.buildWindup})`);
  const rest = Math.round(BUILD_WINDUP / DT) + 2;
  for (let i = 0; i < rest; i++) step(s, { p1: inp({ buildHold: true }), p2: inp() }, DT);
  step(s, { p1: inp({ buildHold: false, build: true }), p2: inp() }, DT);
  ok(s.builtWalls.length === 1, `windup recovers after the hit decays (n=${s.builtWalls.length})`);
}

// 4) A bare build edge with no prior hold places nothing (no instant build).
{
  const s = fresh();
  step(s, { p1: inp({ build: true }), p2: inp() }, DT);
  ok(s.builtWalls.length === 0, `bare build edge is a no-op (n=${s.builtWalls.length})`);
}

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test-build-windup.mjs`
Expected: FAIL — test 1 fails (no wall placed) and test 4 may pass; `buildWindup` is `undefined`.

- [ ] **Step 3: Add `buildWindup` to player state**

In `shared/sim.js`, in the player-factory object (near the other build fields `buildAmmo`, `buildAmmoT`, `buildCd` around line 140-142), add:

```js
    buildWindup: 0, // 0..1 hold-to-confirm progress for the current wall build
```

Also add it to the reset in `resetPositions`/kickoff if such a reset touches per-player action state (search for where `p.buildAmmoT` or `p.powerMeter` is reset near line 171; if build fields are reset there, add `p.buildWindup = 0;`).

- [ ] **Step 4: Ramp the windup + slow movement + interrupt**

In `shared/sim.js`, in the movement speed block (lines 321-323), after the `slowTimer` line add:

```js
    if (inp.buildHold && p.buildAmmo >= 1 && p.buildCd <= 0) spd *= BUILD_WINDUP_SLOW; // slowed while winding up a wall
```

In the per-player loop where edges are captured (after line 384 `p._build = !!inp.build;`), add the windup ramp (mirrors the charge ramp just below it):

```js
    // Wall-build windup: ramp while buildHold is held and a charge is available; a real
    // hit (knockback above BUILD_INTERRUPT_KV) cancels it; releasing without a commit
    // (no build edge, windup not full) resets it. Charge is spent only at commit.
    if (Math.hypot(p.kvx, p.kvy) > BUILD_INTERRUPT_KV) p.buildWindup = 0;
    else if (inp.buildHold && p.buildAmmo >= 1 && p.buildCd <= 0) {
      p.buildWindup = Math.min(1, p.buildWindup + dt / BUILD_WINDUP);
    } else if (!p._build) {
      p.buildWindup = 0;
    }
```

Add the imports at the top of `shared/sim.js` (extend the existing constants import): `BUILD_WINDUP, BUILD_WINDUP_SLOW, BUILD_INTERRUPT_KV`.

- [ ] **Step 5: Commit the wall only at full windup**

In `shared/sim.js`, replace the instant-build line (435):

```js
    if (p._build && p.buildCd <= 0 && p.buildAmmo >= 1) buildWall(state, p);
```

with:

```js
    if (p._build && p.buildCd <= 0 && p.buildAmmo >= 1 && p.buildWindup >= 1) { buildWall(state, p); p.buildWindup = 0; }
```

- [ ] **Step 6: Run test to verify it passes**

Run: `node test-build-windup.mjs`
Expected: `ALL PASS`

- [ ] **Step 7: Run the existing mechanics test to confirm no regression**

Run: `node test-mechanics.mjs`
Expected: existing build assertions may now fail *if* they used the old instant build — if so, that is expected and handled in Task 8 (bot/test updates). Note any failures; do not fix here unless they are non-build assertions.

- [ ] **Step 8: Commit**

```bash
git add shared/sim.js test-build-windup.mjs
git commit -m "feat(sim): wall build is a 0.5s hold-to-confirm windup with hit-interrupt"
```

---

### Task 3: Aimed bomb lob in the sim

**Files:**
- Modify: `shared/sim.js` (`useSpecial` ~553-560; its call site ~434)
- Test: `test-bomb-lob.mjs` (create)

**Interfaces:**
- Consumes: input fields `sax`, `say` (special-aim offset as a fraction 0..1 of `BOMB_LOB_RANGE`, in world direction) on the per-player input object.
- Produces: `useSpecial(state, p, ch, sax, say)` places the bomb at `clamp(feet + dir×len, field)` where `len = min(hypot(sax,say),1) × BOMB_LOB_RANGE`. A zero offset plants at feet (unchanged rocket-jump).

- [ ] **Step 1: Write the failing test**

Create `test-bomb-lob.mjs`:

```js
// Sim unit tests for the aimable bomb lob (tap = feet, drag = short throw).
// Run: node test-bomb-lob.mjs   (exits non-zero on any failure)
import { createState, addPlayer, step } from './shared/sim.js';
import { DT, BOMB_LOB_RANGE } from './shared/constants.js';

let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fails++; };
const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;

function fresh() {
  const s = createState();
  s.resetTimer = 0;
  addPlayer(s, 'p1', { name: 'A', char: 'player', team: 'A', slot: 0 });
  addPlayer(s, 'p2', { name: 'B', char: 'player', team: 'B', slot: 0 });
  s.players.p1.x = 1000; s.players.p1.y = 550; s.players.p1.aimX = 1; s.players.p1.aimY = 0;
  return s;
}
function inp(o = {}) { return { seq: 1, moveX: 0, moveY: 0, aimX: 1, aimY: 0, hold: false, fire: false, special: false, build: false, buildHold: false, sax: 0, say: 0, ...o }; }

// 1) A tap (zero offset) plants the bomb at the planter's feet.
{
  const s = fresh();
  step(s, { p1: inp({ special: true, sax: 0, say: 0 }), p2: inp() }, DT);
  ok(s.bombs.length === 1, `bomb planted (n=${s.bombs.length})`);
  ok(near(s.bombs[0].x, 1000) && near(s.bombs[0].y, 550), `tap plants at feet (${s.bombs[0].x.toFixed(0)},${s.bombs[0].y.toFixed(0)})`);
}

// 2) A full drag (offset magnitude 1) lobs the bomb BOMB_LOB_RANGE along the aim.
{
  const s = fresh();
  step(s, { p1: inp({ special: true, aimX: 1, aimY: 0, sax: 1, say: 0 }), p2: inp() }, DT);
  ok(near(s.bombs[0].x, 1000 + BOMB_LOB_RANGE, 3), `full drag lobs to range (x=${s.bombs[0].x.toFixed(0)})`);
}

// 3) An over-magnitude offset is clamped to BOMB_LOB_RANGE.
{
  const s = fresh();
  step(s, { p1: inp({ special: true, aimX: 1, aimY: 0, sax: 5, say: 0 }), p2: inp() }, DT);
  ok(near(s.bombs[0].x, 1000 + BOMB_LOB_RANGE, 3), `offset clamped to range (x=${s.bombs[0].x.toFixed(0)})`);
}

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test-bomb-lob.mjs`
Expected: FAIL on tests 2 and 3 (bomb always at feet today).

- [ ] **Step 3: Make `useSpecial` place at an aimed, clamped offset**

In `shared/sim.js`, replace `useSpecial` (553-560):

```js
// SPECIAL skill — plant a bomb. A tap (zero aim offset) plants at the planter's feet
// (rocket-jump). A drag aims a short LOB up to BOMB_LOB_RANGE along the aim direction —
// (sax,say) is a 0..1 fraction of that range in world direction, clamped here.
function useSpecial(state, p, ch, sax = 0, say = 0) {
  p.specialCd = ch.specialCooldown * (p.cdMul || 1) * (p.cardUtil || 1);
  const mag = Math.min(1, Math.hypot(sax, say));
  const al = Math.hypot(p.aimX, p.aimY) || 1;
  const len = mag * BOMB_LOB_RANGE;
  const bx = clamp(p.x + (p.aimX / al) * len, 0, FIELD.W);
  const by = clamp(p.y + (p.aimY / al) * len, 0, FIELD.H);
  state.bombs.push({
    id: state._nid++, owner: p.id, team: p.team,
    x: bx, y: by, fuse: BOMB.fuse,
  });
}
```

Update its call site (line 434):

```js
    if (p._special && p.specialCd <= 0) useSpecial(state, p, ch, inp.sax || 0, inp.say || 0);
```

Add `BOMB_LOB_RANGE` to the constants import at the top of `shared/sim.js` (and confirm `FIELD`, `clamp` are already imported — they are).

- [ ] **Step 4: Run test to verify it passes**

Run: `node test-bomb-lob.mjs`
Expected: `ALL PASS`

- [ ] **Step 5: Run bomb-related existing tests**

Run: `node test-power.mjs && node test-mechanics.mjs`
Expected: bomb/rocket-jump assertions still pass (feet plant preserved). Note any failures for Task 8.

- [ ] **Step 6: Commit**

```bash
git add shared/sim.js test-bomb-lob.mjs
git commit -m "feat(sim): bomb can be lobbed to an aimed spot; tap still plants at feet"
```

---

### Task 4: Wire the new input fields through the server

**Files:**
- Modify: `server.js` (default input ~113; edge-consume ~385, ~401; input parse ~659, ~675-681)

**Interfaces:**
- Consumes: client `input` messages carrying `buildHold` (level), `build` (edge), `sax`, `say` (numbers).
- Produces: `room.inputs` entries where `buildHold`, `sax`, `say` are present; `build`/`special`/`fire` remain sticky edges consumed each tick; `buildHold` persists as a level (not reset by the edge-consume).

- [ ] **Step 1: Extend the default input object**

In `server.js` line 113, change the returned default to include the new fields:

```js
  return { seq: 0, moveX: 0, moveY: 0, aimX: 0, aimY: 0, hold: false, fire: false, special: false, build: false, buildHold: false, sax: 0, say: 0 };
```

- [ ] **Step 2: Parse the new fields (buildHold as level, sax/say as numbers)**

In `server.js`, in the `input` message handler (lines 675-681), extend the object stored in `room.inputs`:

```js
        room.inputs.set(member.id, {
          seq: msg.seq, moveX: msg.moveX || 0, moveY: msg.moveY || 0, aimX: msg.aimX || 0, aimY: msg.aimY || 0,
          // hold/buildHold = level signals; fire/special/build = EDGES, latched sticky
          // until the next tick consumes them so an edge between ticks isn't lost.
          hold: !!msg.hold, fire: prev.fire || !!msg.fire,
          special: prev.special || !!msg.special, build: prev.build || !!msg.build,
          buildHold: !!msg.buildHold, sax: msg.sax || 0, say: msg.say || 0,
        });
```

Also extend the `active` check on line 659 so holding build keeps a human non-AFK:

```js
        const active = (Math.abs(msg.moveX || 0) + Math.abs(msg.moveY || 0) > 0.1) || !!msg.hold || !!msg.fire || !!msg.special || !!msg.build || !!msg.buildHold;
```

- [ ] **Step 3: Confirm the edge-consume leaves `buildHold` alone**

In `server.js` lines 385 and 401, the loops reset `inp.fire`, `inp.special`, `inp.build`. Leave them as-is — **do not** reset `buildHold`, `sax`, or `say` (they are levels/params, refreshed each input message). Verify by reading both lines; no change needed.

- [ ] **Step 4: Smoke-check the server boots and a bot match runs**

Run: `node _smoke-play.mjs`
Expected: completes without throwing (a full simulated match). Note the exit line.

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat(net): plumb buildHold + bomb aim-offset through server input"
```

---

### Task 5: Downstream wire — carry windup progress to the HUD (zero extra bytes)

**Files:**
- Modify: `shared/wire.js` (`packFlags` ~21; encode buildFrac ~54; decode flags/buildFrac ~94-100)
- Modify: `server.js` (snapshot buildFrac field ~432-433) — only if server builds the JSON snapshot separately; otherwise skip
- Test: `test-wire.mjs` (extend)

**Interfaces:**
- Consumes: `p.buildWindup`, `p.buildAmmo`, `p.buildAmmoT`.
- Produces: decoded player has `winding` (bool) and `buildFrac` meaning windup progress when `winding`, else reload progress.

- [ ] **Step 1: Write the failing test**

In `test-wire.mjs`, add a case after the existing round-trip checks (match the file's existing `ok`/encode/decode helpers — read the top of the file first to reuse them):

```js
// Windup progress rides the free flag bit + the buildFrac byte.
{
  const s = makeSnapshotState(); // reuse whatever the file uses to build a state; else inline createState + addPlayer
  const p = s.players[Object.keys(s.players)[0]];
  p.buildWindup = 0.5; p.buildAmmo = 2; // winding, mag full so reloadFrac path is idle
  const dec = roundTrip(s); // reuse the file's encode->decode helper
  const dp = dec.players[0];
  ok(dp.winding === true, `winding flag survives the wire (${dp.winding})`);
  ok(Math.abs(dp.buildFrac - 0.5) <= 0.02, `windup progress survives (${dp.buildFrac})`);
}
```

If `test-wire.mjs` has no reusable `roundTrip`/`makeSnapshotState`, inline them using `encodeKeyframe`/`decodeSnapshot` following the file's existing pattern.

- [ ] **Step 2: Run test to verify it fails**

Run: `node test-wire.mjs`
Expected: FAIL — `dp.winding` is `undefined`.

- [ ] **Step 3: Encode the winding flag + overload buildFrac**

In `shared/wire.js`, change `packFlags` (line 21) to set bit 7 when winding:

```js
const packFlags = (p) => (p.firing ? 1 : 0) | (p.reloading ? 2 : 0) | ((p.ammo & 3) << 2) | ((p.buildAmmo & 3) << 4) | (p.power ? 64 : 0) | ((p.buildWindup > 0) ? 128 : 0);
```

In `encodeKeyframe`, change the `buildFrac` byte (line 54) to send windup progress when winding, else the existing reload fraction. Replace:

```js
    u8(Math.round(p.reloadFrac * 100)); u8(Math.round(p.buildFrac * 100));
```

with:

```js
    u8(Math.round(p.reloadFrac * 100));
    // buildFrac byte is overloaded: WINDUP progress when winding (flag bit 7), else the
    // usual next-charge reload fraction. The client picks meaning off the winding flag.
    u8(Math.round((p.buildWindup > 0 ? p.buildWindup : p.buildFrac) * 100));
```

Note: `p.buildFrac` is set by the server before encode (see `server.js` ~433, `buildAmmoT / BUILD_RELOAD`). Confirm the server sets `p.buildFrac` and `p.buildWindup` on the objects passed to `encodeKeyframe`; `buildWindup` lives on the sim player so it is already present.

- [ ] **Step 4: Decode the winding flag**

In `shared/wire.js` `decodeSnapshot`, in the player push (lines 95-100), add `winding` and keep `buildFrac` as the raw fraction:

```js
      firing: !!(flags & 1), reloading: !!(flags & 2), ammo: (flags >> 2) & 3, buildAmmo: (flags >> 4) & 3, power: !!(flags & 64),
      winding: !!(flags & 128),
      reloadFrac, buildFrac,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node test-wire.mjs`
Expected: `ALL PASS`

- [ ] **Step 6: Commit**

```bash
git add shared/wire.js test-wire.mjs
git commit -m "feat(net): carry wall-windup progress on the free flag bit + buildFrac"
```

---

### Task 6: Client — wall build hold/cancel + windup ghost fill

**Files:**
- Modify: `public/client.js` (input state ~1374-1408; keyboard ~1411-1420; build button ~1446-1468; `sampleInput` ~1690-1728; pause teardown ~1694; ghost render ~2705-2723)

**Interfaces:**
- Consumes: `AIM_DEADZONE_PX`, `buildDrag`, `BUILD_WINDUP` (import), server `winding`/`buildFrac`.
- Produces: input `buildHold` (level) + `build` (edge, only on a real placement). A local windup ring on the ghost preview.

- [ ] **Step 1: Add build-hold local state**

In `public/client.js`, near the shooting charge state (after line 1381, `AIM_DEADZONE_PX`), add:

```js
let buildHolding = false;  // build control currently HELD (windup ramps server-side)
let buildStart = null;     // timestamp the build hold began — LOCAL windup estimate for the HUD
const BUILD_MS = BUILD_WINDUP * 1000;
function beginBuild() { if (!buildHolding) { buildHolding = true; buildStart = performance.now(); } }
function currentWindup() { return buildStart === null ? 0 : Math.min(1, (performance.now() - buildStart) / BUILD_MS); }
function cancelBuild() { buildHolding = false; buildStart = null; buildHold = null; }
```

Add `BUILD_WINDUP` to the constants import at the top of `public/client.js` (the `import { ... } from '../shared/constants.js'` list near line 5-8).

- [ ] **Step 2: Route the build button through hold → release/cancel**

In `public/client.js`, in the build-button handlers (1446-1468), call `beginBuild()` on pointerdown and gate the release on the deadzone. Replace the `if (buildBtn) { ... }` block body:

```js
  buildBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { buildBtn.setPointerCapture(e.pointerId); } catch { /* older webview */ }
    buildDrag = { active: true, id: e.pointerId, cx: e.clientX, cy: e.clientY, dx: 0, dy: 0 };
    beginBuild();
  });
  buildBtn.addEventListener('pointermove', (e) => {
    if (!buildDrag.active || e.pointerId !== buildDrag.id) return;
    buildDrag.dx = e.clientX - buildDrag.cx; buildDrag.dy = e.clientY - buildDrag.cy;
  });
  const endBuildDrag = (e) => {
    if (!buildDrag.active || e.pointerId !== buildDrag.id) return;
    // Release only COMMITS if the windup is full AND the aim is pulled out of the deadzone;
    // otherwise it cancels (no wall, no charge). The server also gates on windup.
    const pulled = Math.hypot(buildDrag.dx, buildDrag.dy) > AIM_DEADZONE_PX;
    if (pulled && currentWindup() >= 1) releaseBuild({ x: buildDrag.dx, y: buildDrag.dy });
    else cancelBuild();
    buildDrag.active = false; buildDrag.id = null; buildDrag.dx = 0; buildDrag.dy = 0;
    buildHolding = false; buildStart = null;
  };
  buildBtn.addEventListener('pointerup', endBuildDrag);
  buildBtn.addEventListener('pointercancel', endBuildDrag);
```

Note: `releaseBuild` already sets `buildQueued = true` and captures `buildHold` aim (line 1384). Leave `releaseBuild` as-is. A plain tap now sets `pulled=false` (no drag) → cancel, which is correct: a wall needs an aim + full windup. To allow a facing-direction build with no drag, hold in place until the ring fills and the release still cancels because `pulled` is false — so for keyboard/no-drag, use Step 3's facing path.

- [ ] **Step 3: Keyboard Q becomes hold-to-build (facing direction)**

In `public/client.js`, in the keydown/keyup handlers (1411-1420), replace the `q` handling:

keydown — replace `if (e.key.toLowerCase() === 'q' && !e.repeat) releaseBuild();` with:

```js
  if (e.key.toLowerCase() === 'q' && !e.repeat) beginBuild(); // hold Q to wind up a wall
```

keyup — add, alongside the space handling:

```js
  if (e.key.toLowerCase() === 'q') { if (currentWindup() >= 1) releaseBuild(); else cancelBuild(); } // release builds in facing dir; early = cancel
```

(No `buildHold` aim passed → `sampleInput` uses the player's facing aim, matching the ghost's no-drag branch.)

- [ ] **Step 4: Send buildHold each frame; keep the build edge on release**

In `public/client.js` `sampleInput` (1690-1728), where the return object is assembled (line 1727), change the return to include `buildHold` and default `sax/say` (bomb fills these in Task 7):

```js
  return { moveX, moveY, aimX, aimY, hold: holding, fire, special, build, buildHold: buildHolding, sax: 0, say: 0 };
```

In the pause/blur teardown (line 1694), also clear the build hold:

```js
    holding = false; chargeStart = null; fireQueued = false; specialQueued = false; buildQueued = false; aimHold = null; buildHold = null;
    buildHolding = false; buildStart = null;
```

- [ ] **Step 5: Fill the ghost as the windup climbs**

In `public/client.js`, in `drawObstacles` ghost block (2705-2723), drive alpha off the windup so the preview visibly fills. Replace the alpha/fill lines:

```js
    ctx.save();
    const wind = currentWindup(); // 0..1 local estimate
    ctx.globalAlpha = 0.25 + 0.6 * wind; // faint at start, near-solid at full
    ctx.translate(wx(cx), wy(cy)); ctx.rotate(ang);
    ctx.fillStyle = wind >= 1 ? '#ffd27a' : '#ffb347';
    ctx.fillRect(-L / 2, -T / 2, L, T);
    // a thin progress bar under the ghost so the 0.5s read is unambiguous
    if (wind < 1) { ctx.globalAlpha = 0.9; ctx.fillStyle = '#fff'; ctx.fillRect(-L / 2, T / 2 + 3, L * wind, 3); }
    ctx.globalAlpha = 1; ctx.restore();
```

- [ ] **Step 6: Manual verification (browser)**

Run: `npm start`, open `http://localhost:3010`, play solo.
Verify: holding the build button shows a filling ghost + progress bar; releasing before it fills places nothing; releasing when full places the wall; you move slower while holding. Confirm no console errors.

- [ ] **Step 7: Commit**

```bash
git add public/client.js
git commit -m "feat(client): wall build hold-to-confirm with windup ghost + cancel"
```

---

### Task 7: Client — bomb tap-vs-drag aim/cancel with ghost marker

**Files:**
- Modify: `public/client.js` (special button ~1432-1444; `sampleInput` return ~1727; ghost render in `drawObstacles` ~2705)

**Interfaces:**
- Consumes: `AIM_DEADZONE_PX`, `BOMB_LOB_RANGE` (import), `scale`/`wx`/`wy`/`ws_` render helpers, `rendered`, `flipView()`.
- Produces: input `sax`,`say` (0..1 offset fraction, world direction) sent with the `special` edge. Tap → 0,0 (feet). Drag → fraction of `BOMB_LOB_RANGE`.

- [ ] **Step 1: Add bomb-aim local state**

In `public/client.js`, near the special/build input state (after Task 6's build state ~1382), add:

```js
let specialAim = { x: 0, y: 0 };   // captured lob offset (0..1 of BOMB_LOB_RANGE, screen dir) for the next special edge
let bombDrag = { active: false, id: null, cx: 0, cy: 0, dx: 0, dy: 0 };
const MAX_LOB_DRAG_PX = 90;        // screen drag that maps to a full-range lob
```

Add `BOMB_LOB_RANGE` to the constants import in `public/client.js`.

- [ ] **Step 2: Replace the special button with tap-vs-drag pointer handling**

In `public/client.js`, replace the special-button wiring (1432-1444, the `triggerSpecial` + its `touchstart`/`mousedown` listeners) with pointer-based drag aiming. Keep right-click = special edge with no offset.

```js
const specialBtn = document.getElementById('special');
const pauseBtn = document.getElementById('pause-btn');
const soundBtn = document.getElementById('sound-btn');
const settingsPanel = document.getElementById('settings');

// Bomb: a TAP plants at your feet (rocket-jump). A press-and-DRAG aims a short lob;
// release past the deadzone throws it, release back on the button cancels.
if (specialBtn) {
  specialBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { specialBtn.setPointerCapture(e.pointerId); } catch { /* older webview */ }
    bombDrag = { active: true, id: e.pointerId, cx: e.clientX, cy: e.clientY, dx: 0, dy: 0 };
  });
  specialBtn.addEventListener('pointermove', (e) => {
    if (!bombDrag.active || e.pointerId !== bombDrag.id) return;
    bombDrag.dx = e.clientX - bombDrag.cx; bombDrag.dy = e.clientY - bombDrag.cy;
  });
  const endBombDrag = (e) => {
    if (!bombDrag.active || e.pointerId !== bombDrag.id) return;
    const len = Math.hypot(bombDrag.dx, bombDrag.dy);
    if (len <= AIM_DEADZONE_PX) {
      // No meaningful drag = a tap = feet plant (rocket-jump). Snappy, like before.
      specialAim = { x: 0, y: 0 };
      specialQueued = true; playSound('hit', 0.5, 0.82); flashSpecialCooldown();
    } else {
      // A real drag = aimed lob. Map drag magnitude to a 0..1 fraction of the range.
      const frac = Math.min(1, len / MAX_LOB_DRAG_PX);
      let dx = bombDrag.dx / len, dy = bombDrag.dy / len;
      if (flipView()) dx = -dx; // screen -> true-world for team B's mirrored view
      specialAim = { x: dx * frac, y: dy * frac };
      specialQueued = true; playSound('hit', 0.5, 0.82); flashSpecialCooldown();
    }
    bombDrag.active = false; bombDrag.id = null; bombDrag.dx = 0; bombDrag.dy = 0;
  };
  specialBtn.addEventListener('pointerup', endBombDrag);
  specialBtn.addEventListener('pointercancel', endBombDrag);
}
```

Note: the previous code called `specialQueued` from a shared `triggerSpecial`. The right-click path (`mousedown` button 2 in the canvas handler, line 1426) still sets `specialQueued = true`; ensure it also resets the offset — in that canvas `mousedown` handler add `specialAim = { x: 0, y: 0 };` on the right-click branch so a right-click stays a feet plant.

- [ ] **Step 3: Send sax/say with the special edge**

In `public/client.js` `sampleInput` return (updated in Task 6 Step 4), replace the `sax: 0, say: 0` with the captured aim, consumed on send:

```js
  const special = specialQueued; specialQueued = false;
  const sax = special ? specialAim.x : 0, say = special ? specialAim.y : 0;
  if (special) specialAim = { x: 0, y: 0 };
```

and return `...build, buildHold: buildHolding, sax, say`. (Adjust the existing `const special = specialQueued; specialQueued = false;` line so it is not declared twice — move the offset capture next to it.)

Also clear `bombDrag`/`specialAim` in the pause teardown (line 1694 block):

```js
    bombDrag.active = false; specialAim = { x: 0, y: 0 };
```

- [ ] **Step 4: Draw the bomb ghost marker while dragging**

In `public/client.js` `drawObstacles`, after the build-ghost block (after line 2723), add a bomb-lob ghost:

```js
  // Ghost marker while aiming a bomb lob.
  if (bombDrag.active && rendered) {
    const len = Math.hypot(bombDrag.dx, bombDrag.dy);
    if (len > AIM_DEADZONE_PX) {
      const frac = Math.min(1, len / MAX_LOB_DRAG_PX);
      let dx = bombDrag.dx / len, dy = bombDrag.dy / len;
      if (flipView()) dx = -dx;
      const tx = rendered.x + dx * frac * BOMB_LOB_RANGE;
      const ty = rendered.y + dy * frac * BOMB_LOB_RANGE;
      ctx.save(); ctx.globalAlpha = 0.5;
      ctx.fillStyle = '#ff5a4d';
      ctx.beginPath(); ctx.arc(wx(tx), wy(ty), ws_(26), 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1; ctx.restore();
    }
  }
```

- [ ] **Step 5: Manual verification (browser)**

Run: `npm start`, open `http://localhost:3010`.
Verify: tapping the bomb button plants at your feet and rocket-jumps you; press-drag shows a red ghost marker that lobs the bomb to that spot on release (no self-launch); dragging then releasing back on the button cancels. No console errors.

- [ ] **Step 6: Commit**

```bash
git add public/client.js
git commit -m "feat(client): bomb tap=feet, drag=aimed lob with ghost + cancel"
```

---

### Task 8: Update bots + existing tests for the windup model

**Files:**
- Modify: `shared/bot-ai.js` (build decision ~744-765; bomb decision ~608-612, ~701-702; `finalize` return ~840-885)
- Modify: `test-mechanics.mjs` (any build assertion using the old instant path)

**Interfaces:**
- Consumes: `BUILD_WINDUP`, `BOMB_LOB_RANGE` (import into bot-ai).
- Produces: bot inputs that hold `buildHold` for ~`BUILD_WINDUP`+margin then emit `build`; bot `special` inputs carry `sax/say`.

- [ ] **Step 1: Give the bot a build-hold intent**

In `shared/bot-ai.js`, add a `buildHold` memory analogous to `bombHold` (near line 390 where `bombHold: null` is initialized): add `buildHold: null,`.

Where the bot currently sets `build = true` (lines 748 and 765), instead of committing instantly, set a hold intent (keep the same aim and cooldown bookkeeping). At line 748 replace `build = true; aim = { x: lux, y: luy };` with:

```js
        bm.buildHold = { x: lux, y: luy, until: mem.t + BUILD_WINDUP + 0.1 };
        aim = { x: lux, y: luy };
```

At line 765 replace `build = true; aim = { x: w2cx, y: w2cy }; shoot = false; special = false; ...` with:

```js
        bm.buildHold = { x: w2cx, y: w2cy, until: mem.t + BUILD_WINDUP + 0.1 };
        aim = { x: w2cx, y: w2cy }; shoot = false; special = false; bm.nextBuildAt = mem.t + 4.0 * (sk.cdMul || 1);
```

- [ ] **Step 2: Drive the hold and release in `finalize`**

In `shared/bot-ai.js` `finalize` (840-885), before assembling the return, resolve the build-hold intent into a `buildHold` level + a `build` edge on completion:

```js
  // Resolve a pending build-hold: hold the control until the windup completes, then
  // emit the build edge once and clear the intent.
  let buildHold = false;
  if (bm.buildHold) {
    aim = { x: bm.buildHold.x, y: bm.buildHold.y };
    if (mem.t >= bm.buildHold.until) { build = true; bm.buildHold = null; }
    else { buildHold = true; build = false; }
  }
```

Then include `buildHold` in the returned object (line 881-884):

```js
  return {
    ...,
    hold, fire, special, build, buildHold,
    sax, say,
  };
```

- [ ] **Step 3: Give the bot's bomb an aim offset**

In `shared/bot-ai.js` `finalize`, compute `sax/say` from the bot's aim when it plants a bomb offensively. Near the top of `finalize` where `aim` is known, add:

```js
  // Bomb aim offset: an offensive lob aims at the target within range; a feet plant is 0.
  let sax = 0, say = 0;
  if (special && bm.bombHold && (bm.bombHold.targetId || bm.bombHold.aimX != null)) {
    const al = Math.hypot(aim.x, aim.y) || 1;
    const dist = Math.hypot((bm.bombHold.aimX ?? p.x) - p.x, (bm.bombHold.aimY ?? p.y) - p.y);
    const frac = Math.min(1, dist / BOMB_LOB_RANGE);
    sax = (aim.x / al) * frac; say = (aim.y / al) * frac;
  }
```

(If the existing `bombHold` fields differ, adapt to whatever carries the intended target — the goal is: offensive bomb → nonzero offset toward the target, capped at range; corner/feet bomb → 0.)

Add the imports at the top of `shared/bot-ai.js`: `BUILD_WINDUP, BOMB_LOB_RANGE` (and `BOMB` is already imported).

- [ ] **Step 4: Update any existing test that relied on instant build**

Run: `node test-mechanics.mjs`. For each failing build assertion, update its driver to hold `buildHold` for the windup then release, mirroring `test-build-windup.mjs`'s `holdBuild` helper. Example transform — replace a single `step(s, { p1: inp({ build: true }) ... })` with a windup loop:

```js
for (let i = 0; i < Math.round(BUILD_WINDUP / DT) + 1; i++) step(s, { p1: inp({ buildHold: true }), p2: inp() }, DT);
step(s, { p1: inp({ buildHold: false, build: true }), p2: inp() }, DT);
```

Add `buildHold: false` (and `sax:0, say:0`) to the `inp()` helper's defaults in any test file that builds walls or plants bombs (`test-mechanics.mjs`, `test-power.mjs`, `test-fragile.mjs` if applicable), and import `BUILD_WINDUP` there.

- [ ] **Step 5: Run the full sim test suite**

Run: `node test-build-windup.mjs && node test-bomb-lob.mjs && node test-wire.mjs && node test-mechanics.mjs && node test-power.mjs && node test-fragile.mjs && node test-bot-ai.mjs`
Expected: every file prints `ALL PASS` and exits 0.

- [ ] **Step 6: Commit**

```bash
git add shared/bot-ai.js test-mechanics.mjs test-power.mjs test-fragile.mjs
git commit -m "feat(bot): bots wind up walls + aim bomb lobs; update sim tests"
```

---

### Task 9: Full smoke test

**Files:**
- None (verification only)

- [ ] **Step 1: Run the hard smoke test**

Run: `node _smoke-hard.mjs`
Expected: a full match with bots exercising build + bomb, no throw, no desync warning.

- [ ] **Step 2: Run the play smoke test**

Run: `node _smoke-play.mjs`
Expected: completes cleanly.

- [ ] **Step 3: Manual end-to-end in the browser**

Run: `npm start`, open `http://localhost:3010`, play a solo match against bots.
Verify all acceptance behaviors: wall windup + cancel + move-slow + hit-interrupt; bomb tap-feet-rocketjump + drag-lob + drag-back-cancel; bots visibly build and bomb. No console errors over a full match.

- [ ] **Step 4: Final commit (if any test-tuning changes were needed)**

```bash
git add -A
git commit -m "test: full smoke verification for build windup + bomb lob"
```

---

## Self-Review Notes

- **Spec coverage:** windup 0.5s (T1,T2), move-slow (T2), hit-interrupt+refund (T2), release/on-self cancel (T2 sim + T6 client), commit-only-charge-spend (T2), remove instant build (T2), bomb tap-feet vs drag-lob vs cancel (T3 sim + T7 client), rocket-jump preserved (T3), zero-extra-byte wire + HUD ring (T5), bots (T8), tests + smoke (T2,T3,T5,T8,T9). All spec sections map to a task.
- **Type consistency:** `buildHold`/`sax`/`say` input fields defined in T4 default, produced by client T6/T7 and bot T8, consumed by sim T2/T3. `useSpecial(state,p,ch,sax,say)` signature set in T3, called in T3. `winding`/`buildFrac` set in T5 encode, read in T5 decode + T6 client.
- **Client tasks** are canvas/DOM and are verified manually (Steps marked "Manual verification") plus the smoke tests — the `.mjs` harness only drives the headless sim.
