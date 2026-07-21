# Mechanics v2 — charge tiers, aim, bomb & fairness redesign

Date: 2026-07-21 · Supersedes the power-meter shipped in `44e3088`.

Reframes the 11 requested mechanic changes into a coherent system and folds in the
fixes from a full fairness audit. Four design forks were decided by the user:

| Fork | Decision |
|---|---|
| Point 10 (max kick stops) | **Keeper-diminish**: full kick stops dead in open play; deflects (~30% speed) when the bumped enemy is inside their **own** penalty box, so on-line camping isn't a free save. |
| Overcharge scarcity | **Scarce + decaying**: only forceful hits grant it, it fades after ~4s if unused, spent on use, refilled by a power hit. |
| Charge ramp | **Sim-owned**: the server accumulates charge from a held-trigger; bots pay the same ~1s wind-up as humans. |
| Bomb launchpad | **Allowed fully**: point 9 literal — own/static/enemy walls all boost, no distance cap, no tackle-window scaling. |

---

## 1. Core model: two power tiers + a shared charge ramp

- **CHARGE** builds 0→1 over `SHOOT_CHARGE_TIME` (1s) while the trigger is held. Longer hold = more power (`chargeMul`, unchanged).
- **FULL** = charge ≥ `FULL_CHARGE` (0.85). Hold-based, **ungated, available to anyone**. A full bullet strips a carrier (existing path). This restores the defensive stripping that the shipped meter over-nerfed.
- **OVERCHARGE** = a bonus tier that only exists **on top of** a full charge, gated by the earned meter `p.power`. Overcharge modifies kick-vs-enemy behaviour (point 11) and reddens the aim line (point 5).

`p.power` keeps its wire/field name (no wire.js/client rename churn); only its **meaning** changes from "gates full" to "overcharge available".

### 1a. Sim-owned charge ramp (Fork 3)

Today the client ramps `charge` locally and sends a scalar on release; bots emit `charge=1`
instantly. Move the ramp server-side so bots pay the same wind-up and point-2 cancel is symmetric.

**Input protocol change (client→server JSON inputs; does NOT touch wire.js snapshots):**
- Replace `{ shoot: bool, charge: 0..1 }` with `{ hold: bool, fire: bool }`.
  - `hold` = trigger currently pulled out beyond the deadzone (charging).
  - `fire` = release-and-commit this frame (a real pulled-out release).
  - **Cancel** (point 2) = `hold` drops to false with `fire` never set — client owns this decision (the sim can't see stick magnitude).
- **Sim** (`sim.js`, replaces the `p._charge = inp.charge` line):
  - `if (inp.hold) p._charge = min(1, p._charge + DT / SHOOT_CHARGE_TIME)`
  - `else if (!inp.fire) p._charge = 0` (idle or cancel resets)
  - Fire on `inp.fire` using the **sim-accumulated** `p._charge`, then reset to 0.
- **Bots** (`bot-ai.js finalize`): emit `{ hold, fire }`. A bot that wants to fire at target charge `c` enters a per-bot charging state: sets `hold=true` for `ceil(c * SHOOT_CHARGE_TIME / DT)` ticks (tracked in `bmem`), then emits `fire=true`. This makes the bot's strip/finish pay a real ~1s wind-up (kills the superhuman instant-strip).

---

## 2. Charge tiers & kick-vs-enemy (points 2, 3, 4, 5, 10, 11)

### Keystone reframe (point 4) — do first
In the shoot/kick resolution (`sim.js` ~356):
```
const eff = Math.max(0, Math.min(1, p._charge));   // ungate: no more meter cap
const isFull = eff >= FULL_CHARGE;
const isOver = isFull && p.power;                   // overcharge only on top of full
```
- Delete the old `wasFull`/cap line.
- Spend sites (kick + bullet): change `if (wasFull) p.power=false` → `if (isOver) { p.power=false; p.powerT=0; }`. Plain full no longer spends; only an overcharged action does.
- Tag outgoing action tier:
  - kick branch: `b.kickTier = isOver ? 2 : isFull ? 1 : 0`
  - bullet: `fireBullet(state, p, ch, eff, isOver)`, store `pr.over = !!over` alongside `pr.charge`.

### Overcharge earn/decay (Fork 2)
- Add `p.powerT` (seconds remaining). `OVERCHARGE_TTL = 4`. Reset `p.power=false; p.powerT=0` on kickoff (`repositionKickoff`).
- Each tick: `if (p.powerT > 0) { p.powerT -= DT; if (p.powerT <= 0) p.power = false; }`.
- **Grant only on forceful hits** (set `p.power=true; p.powerT=OVERCHARGE_TTL`):
  - `hitEnemy` (~606): gate behind `pr.charge >= QUICK_CHARGE` (a harmless slow poke does NOT grant).
  - `explode` (~671): keep (bomb blast is forceful).
  - ball-bump (~420): keep (already gated by `>BALL_BUMP_SPEED`), **but** skip the grant when the bumping ball carried `kickTier===2` (kills the overcharge→bump→re-grant self-farm chain).
- A carrier can't earn overcharge while carrying (can't fire bullets). Accepted: overcharge is earned before the drive, or via a forceful pass/clearance that connects (fold this in — a full kick that bumps an enemy with `charge>=QUICK_CHARGE` may grant, so an attacker can build the punch-through).

### Ball-hits-enemy model (points 10 & 11, Fork 1) — one monotonic curve
Tag the ball at release with `b.kickTier`. Clear it (`=0`) at every non-kick origin: `attachBall`, `repositionKickoff`, the pickup, the strip/detach, and the bullet loose-ball push — so only genuine kicks carry a tier. In the bump handler (`sim.js` ~413-423) branch on `b.kickTier`:

| Tier | Enemy push | Ball after | Notes |
|---|---|---|---|
| 0 (quick/medium) | current (`bspeed·BALL_BUMP_SCALE·knockMul`) | keeps 0.35 (roll on) | unchanged |
| 1 (FULL) | bigger push | **stops** (`vx=vy=0`), refresh `pickupCd=RELEASE_PICKUP_CD` | **Keeper-diminish:** if the bumped enemy is inside their **own** penalty box → deflect instead (ball keeps `KEEPER_DEFLECT=0.30`), so line-camping isn't a free save |
| 2 (OVERCHARGE) | `·OVERCHARGE_MUL` (1.5) | continues `OVERCHARGE_ROLL=0.30` | can strip; clear `kickTier=0` after first bump (no chain) |

Monotonicity guard: full push > medium push; overcharge push > full push. Retained speed ordering is deliberate (medium 0.35 roll-past a weak touch, full = hard block/dead, overcharge = sanctioned breakthrough). "Own penalty box" reuses the existing box test that drives `PENALTY_KNOCKBACK_MUL`.

### Aim cancel (point 2) — client-owned
While the aim stick is beyond `AIM_DEADZONE` (0.15, promote to a named const), send `hold=true`. On release: if the last sampled magnitude was ≥ deadzone → `fire=true` for one frame; if it was dragged back into the deadzone → cancel (`hold=false`, no fire), reset predicted charge, no shot sound. Latch on the **last out-of-deadzone frame** and fire on the release transition — never "reached centre" (a self-centring stick trips that on every release). Mouse/keyboard: same guard via cursor-distance-from-player. `openSettings` must null `chargeStart` too. Removes the touch quick-tap-to-shoot; quick shots reachable via short-hold-then-release.

### Aim line colour (point 5)
Client reads the local player's `p.power`: grey `rgb(176,176,176)` when not overcharged, red `rgb(255,64,64)` when overcharged. Alpha ramps with charge `0.35 + 0.4·charge`; hue is purely `p.power`. Re-theme the stick-knob charge tint off red so red means only "overcharge".

---

## 3. Bomb (points 6, 7, 8, 9 — Fork 4: allow fully)

Points 6 & 7 are **already satisfied** by current `explode()` (away-from-centre fling is position-based; aim-dir launch already gated behind `bomberOnCenter`). Only comment clarity + refactor to reuse the unit vector.

- **Point 8** — on-centre launch scaling:
  `let launch = P * BOMB_CENTER_LAUNCH_MUL; if (state.ball.owner === bomber.id) launch *= BOMB_CARRY_LAUNCH_MUL; if (wallCannonBoost(...)) launch *= BOMB_WALL_CANNON_MUL;`
  - `BOMB_CENTER_LAUNCH_MUL = 1.35`, `BOMB_CARRY_LAUNCH_MUL = 0.6` (reduced only when the bomber **owns** the ball).
- **Point 9** — wall-cannon (all walls qualify, including own built walls):
  ```
  function wallCannonBoost(state, bx, by, dx, dy) {   // dx,dy = launch unit dir
    for (const w of ARENA.walls.concat(state.builtWalls || [])) {
      const nx = clamp(bx, w.x, w.x+w.w), ny = clamp(by, w.y, w.y+w.h);
      const vx = nx-bx, vy = ny-by, d = Math.hypot(vx,vy);
      if (d < 1 || d > BOMB_WALL_DIST) continue;
      if ((vx/d)*(-dx) + (vy/d)*(-dy) > BOMB_WALL_COS) return true;   // wall opposite the launch
    }
    return false;
  }
  ```
  `BOMB_WALL_CANNON_MUL = 1.5`, `BOMB_WALL_DIST = 140`, `BOMB_WALL_COS = 0.82` (~35° cone). Apply the boost in **both** the on-centre branch and the away-fling loop. Compute `wallCannonBoost` **before** the wall-destroy loop so a backing built wall reads valid before it shatters.
- No distance cap, no `BOMB_LAUNCH_TTL` scaling (user chose full power). The launchpad combo (build wall → bomb → rocket-jump) is intentionally allowed.

---

## 4. Client aim line (point 1)

Rewrite `drawAimIndicator` into a raycast to the first obstacle:
- Ray from player along unit aim; min positive `t` over FIELD-edge slabs + a 2-slab ray/AABB test against `[...ARENA.walls, ...(latest.walls||[])]`. Guard `ax===0`/`ay===0`.
- Draw one continuous pale dashed `ctx` stroke (reuse the bomb-ring dash idiom) from player to endpoint; keep the crosshair at the endpoint.
- **Charge no longer drives length** (line is always full-length) — re-route power feedback to alpha/thickness.
- **Owner-only** (already local-only at call site) and **stops on walls/field edges only, never player bodies** — else it outs bushed enemies. Keep it inside the mirrored-world transform (raycast in true-world coords).

---

## 5. Bots (fairness finding ⑤) — update before ship

Bots are stale against every new rule. Required updates in `bot-ai.js`:
1. **Charge state machine** (from §1a): hold for N ticks then fire, per `bmem`.
2. **Overcharge bookkeeping**: read `p.power`; gate carry-through finishers (`boxFinish` ~410-414, anti-idle blast ~454-455) on having overcharge; recompute the retained-speed coefficient per tier (0 for full, small for overcharge) — the hard-coded `0.35` assumption is now wrong for full kicks.
3. **Defensive steering**: add fast-incoming-enemy / `bombLaunch>0` player as a high-weight `steer()` danger so bots juke rocket-jump tackle-steals (currently enemy bodies are never a danger). Add a last-defender "sit on the line" block behaviour.
4. **`bombTravel`** (~447-449): disable for carriers (point 8 reduces carry launch → it becomes a frozen short-hop sitting-duck).
5. **Normal difficulty**: raise `react` from 0.06 → ~0.18-0.22 and widen `aimSigma` so the human's hold-to-strip is competitive; reserve instant/near-perfect execution for Hard.
6. Re-run `bot-eval.mjs` A/B (NEW vs frozen legacy) + `test-behavior`/`test-tricks`/`test-stuck` and retune until green.

---

## 6. New / changed constants (`shared/constants.js`)

```
AIM_DEADZONE = 0.15          // shared stick deadzone (sim + client)
OVERCHARGE_MUL = 1.5         // overcharge kick enemy-push multiplier
OVERCHARGE_ROLL = 0.30       // ball retained speed after an overcharge bump
OVERCHARGE_TTL = 4           // seconds the meter lasts if unused
KEEPER_DEFLECT = 0.30        // ball retained speed when a full kick hits a defender in their own box
BOMB_CENTER_LAUNCH_MUL = 1.35
BOMB_CARRY_LAUNCH_MUL = 0.6
BOMB_WALL_CANNON_MUL = 1.5
BOMB_WALL_DIST = 140
BOMB_WALL_COS = 0.82
```

## 7. Implementation order (dependency-safe)

1. **Sim-owned charge ramp** (§1a): input protocol + sim accumulation + bot charge state machine. Verify existing suites still fire shots.
2. **Power/overcharge tiers** (§2): keystone reframe, decay, `b.kickTier` ball model + keeper-diminish. Wire flag already carries `power`.
3. **Bomb** (§3): explode() refactor + wall-cannon.
4. **Client aim** (§4 + point 2 cancel + point 5 colour).
5. **Bots** (§5) + re-run A/B eval.
6. Full verify (7 suites + A/B + headless Chrome), commit, deploy to Render, curl-verify live `/shared/*.js`.

## 8. Test additions
- `test-charge-ramp.mjs`: sim accumulates charge over ticks; full only after ~1s of hold; cancel (hold→false, no fire) fires nothing.
- Extend `test-power.mjs`: full ungated strips without meter; overcharge decays after TTL; forceful-hit-only grant; no self-farm chain.
- Extend `test-mechanics.mjs`: kickTier — full kick stops dead vs deflects in own box; overcharge rolls on.
- `test-bomb-cannon.mjs`: on-centre-further, carry-reduced, wall-cannon boost, blast-direction fling for off-centre bomber.
- Aim raycast: unit-test the ray/AABB `t` against a known wall.
```
