# Football minigame — combat & shot mechanics

Reference for the shooting / kicking / bomb / super systems. **Authoritative sim is
[`shared/sim.js`](../shared/sim.js); all tunables live in [`shared/constants.js`](../shared/constants.js).**
The client ([`public/client.js`](../public/client.js)) runs the same shared modules for prediction
and only *mirrors* these rules for visuals — it is never the source of truth. When you change a
rule here, change the constant + sim, then update this doc.

Units: positions in world px. One **ball-length** = ball diameter = `2 × BALL_RADIUS` = **32px**.
Field is `2000 × 1100`. Sim runs at 60 Hz (`DT = 1/60`).

---

## 1. Charge system (hold-to-power)

Charge builds while the fire trigger is HELD (`p._charge`, 0..1), server-authoritative:

```
_charge += dt / SHOOT_CHARGE_TIME × chargeRate × cardShot × (super ? SUPER_CHARGE_RATE : 1)
```

- `SHOOT_CHARGE_TIME = 2.0s` — time to reach full power.
- Tiers (fractions of full): `QUICK_CHARGE = 0.25`, `FULL_CHARGE = 0.85`.
- In **super**, charge fills `SUPER_CHARGE_RATE = 2×` faster → full in ~1s.
- `chargeMul(f) = CHARGE_MIN_MUL + (1 − CHARGE_MIN_MUL)·f`, `CHARGE_MIN_MUL = 1/4` (bullets).

Releasing below `QUICK_CHARGE` = a **quick tap**; at/above = a charged shot; `≥ FULL_CHARGE` = full.

---

## 2. Ball carrier — kick / pass (holding the ball)

Ball launch speed `= shotPower(1850) × chargeMul(eff) × superMul`, except a quick tap.
Enemy push if the ball bumps a defender `= ballSpeed × BALL_BUMP_SCALE(0.5) × tierMul`, and only
if `ballSpeed > BALL_BUMP_SPEED(300)`. Tier from the hold: quick ×1, full `FULL_BUMP_MUL=1.3`,
overcharge `OVERCHARGE_MUL=2.0`.

| Action | Ball speed | Notes |
|---|---|---|
| **Quick tap** (no super) | `BALL_TAP_SPEED = 155` | light **dribble touch**, rolls ~2 ball-lengths, decelerates to a stop. Below the bump gate → no push. |
| **Quick tap IN super** | `SUPER_QUICK_KICK_SPEED = 440` | above the bump gate → shoves a defender ~1.5 ball-lengths. No powerless dribble while super. |
| **Full** (held ~2s) | ~1850 | tier full (×1.3 push). |
| **Super** (full + super) | ~2775 (+50%) | overcharge kick — tier ×2.0, spends the meter. |

**Hands full:** while carrying the ball you **cannot build walls or plant bombs** — both the build
windup and the bomb special are ignored server-side (`state.ball.owner === p.id`), and the client
hides their ghosts/windup and drops the inputs. The bomb & fence buttons are **fully LOCKED** while
carrying: pressing them does nothing and **does not exhaust** the bomb cooldown / build charge (no
press sound, no cooldown flash) — nothing is consumed because `useSpecial`/`buildWall` never run.

---

## 3. Bullets (shooting — not holding the ball)

Bullet speed `= bulletSpeed(720) × chargeMul(charge)`. Enemy knockback:

```
kb = bulletKnockback(1500) × charge × overMul     (medium & full)
```

- **Quick** (`charge < QUICK_CHARGE`): **no push, slow only** (`SLOW_TIME`/`SLOW_MUL`) — *unless in super*.
- **Quick IN super**: a small fixed nudge `SUPER_QUICK_KB = 220` (~1.5 ball-lengths) + slow.
- **Full** (`≥ FULL_CHARGE`): full knockback; strips an enemy **carrier** (ball pops loose).
- **Overcharge** (full + super): `OVERCHARGE_BULLET_MUL = 1.6×`, spends the meter.
- A built wall chips a bullet down one tier per remaining HP; a super bullet punches through (reduced).

---

## 4. SUPER (overcharge) mode

**Earning** — `p.power` becomes true when the overcharge meter (`p.powerMeter`, 0..1) fills, via
`earnPower()`: a full enemy hit/strip/bomb-catch fills it (`OVERCHARGE_FULL_GAIN = 1.0`); a quick
hit fills `OVERCHARGE_PARTIAL_GAIN = 1/3` (three quick hits = one super). **Firing never fills it.**
Once ready it lasts `OVERCHARGE_TTL = 4s` if unused (`p.powerT` decays).

**While super (`p.power`):**
- Charge fills 2× (§1).
- **All shots +50%** (`SUPER_SHOT_MUL = 1.5`): ball kicks, bullets.
- A **quick** shot still pushes ~1.5 ball-lengths instead of nothing (§2/§3).
- A **full** shot = **overcharge** (the ceiling): ball ×2.0 push, bullet ×1.6. Spends the meter.
- **Body strength** (§5).

**Latch (`p._superLatched`)** — set whenever you hold/charge while super; cleared on cancel or after
firing. A shot **loaded** during super stays a super shot (keeps the +50% AND overcharge) **even if
the super timer expires mid-charge**. Client mirrors this with `mySuperLatched`: the **red aim line +
red overcharge ring stay** until the shot is fired.

---

## 5. SUPER body strength (contact)

A player in super is physically stronger on contact (`resolveSuperBodyStrip` + separation bias):

- **Push bias** — when only one side is super, the non-super player absorbs `SUPER_BODY_PUSH = 0.65`
  of a body overlap (super only 35%) → the super player holds their ground and shoves others more.
- **Body strip** — body contact with an **enemy ball-carrier** knocks the ball loose:
  carrier shoved `SUPER_BODY_STRIP_KB = 520`, ball pops away `SUPER_BODY_BALL_POP = 300`.
  Enemy-only, self-limiting (once stripped the ball is free).

---

## 6. Bombs (💣 special)

Not affected by charge or super. Plant at feet (tap) or lob (drag, up to `BOMB_LOB_RANGE`).
Fuse `BOMB.fuse = 1.725s`, blast radius `BOMB.radius = 168`.

Launch impulse `P = bombPower(2000) × (1 + (stack−1)·BOMB_STACK_PER)`:
- **Self rocket-jump** (on centre, `BOMB_CENTER_R`): `P × BOMB_CENTER_LAUNCH_MUL(0.80) × wallCannon`, capped `BOMB_LAUNCH_MAX = 5200`.
- **Enemy in blast**: `P × (1 − d/radius) × BOMB_ENEMY_MUL(1.25) × wallCannon × cover`, same cap.
- **Stacking** — up to `BOMB_STACK_MAX = 2` bombs within `BOMB_COMBINE_RADIUS(210)` combine; each extra adds `BOMB_STACK_PER = 0.9` (2 bombs = ×1.9).
- **Wall cannon** — a wall collinear BEHIND the launch boosts it, ramped by proximity: steel/indestructible peaks `BOMB_WALL_CANNON_STATIC = 1.55`, built wall `BOMB_WALL_CANNON_BUILT = 1.15 × HP`.
- **Cover** — a static wall between blast & target blocks the push entirely; a built wall softens by HP.
- Can't rocket-jump *into* a static wall (jump cancelled if the wall is ahead in the launch cone).

**Fence (wall build):** `BUILD_MAG = 2` slots. Reload is a **per-charge trickle** — each charge
regenerates every `BUILD_RELOAD = 15s`. Use both and the first returns at ~15s, the second at ~30s
(avg 1 per 15s / 2 per 30s; you can never dump 3 in a row). `BUILD_COOLDOWN = 0.4s` min between
placements. A full windup takes `BUILD_WINDUP`; releasing early refunds the charge.

**Ultimate combo** — 2 stacked bombs + steel wall behind + standing on top = flings a player
**~92% of the field** (measured 1842px). Each ingredient matters (2 bombs no wall ≈ 63%, 1 bomb + wall ≈ 49%).

Launch decay is gentle for `BOMB_LAUNCH_GLIDE = 0.9s` (`BOMB_LAUNCH_DECAY`) for a smooth arc, then normal.

---

## 7. Knockback decay (how kb → distance)

Player knockback `kv` is added to `kvx/kvy`, decays each tick (`KNOCKBACK_DECAY`), stops below
`KNOCKBACK_MIN = 4`. Rough drift distance `≈ 0.23 × (kv − 4)` px (normal decay). So `kv ≈ 74` ⇒ ½
ball-length, `kv ≈ 220` ⇒ ~1.5 ball-lengths. Bomb launches use the gentler glide decay (`≈ 0.415 × v`).

---

## Key constants (quick index — all in `shared/constants.js`)

| Constant | Value | Meaning |
|---|---|---|
| `SHOOT_CHARGE_TIME` | 2.0 | full-charge time |
| `CHARGE_MIN_MUL` | 1/4 | bullet tap power fraction |
| `QUICK_CHARGE` / `FULL_CHARGE` | 0.25 / 0.85 | tier thresholds |
| `BALL_TAP_SPEED` | 155 | carrier dribble touch (~2 ball-lengths) |
| `SUPER_CHARGE_RATE` | 2 | super charge speed-up |
| `SUPER_SHOT_MUL` | 1.5 | super +50% on all shots |
| `SUPER_QUICK_KB` | 220 | quick-super bullet nudge (~1.5 lengths) |
| `SUPER_QUICK_KICK_SPEED` | 440 | quick-super kick speed (bumps a defender) |
| `SUPER_BODY_PUSH` | 0.65 | non-super's share of a body overlap |
| `SUPER_BODY_STRIP_KB` | 520 | shove when a super body-strips a carrier |
| `SUPER_BODY_BALL_POP` | 300 | stripped ball pop speed |
| `OVERCHARGE_MUL` / `FULL_BUMP_MUL` | 2.0 / 1.3 | ball-kick tier push muls |
| `OVERCHARGE_BULLET_MUL` | 1.6 | overcharge bullet mul |
| `OVERCHARGE_TTL` | 4 | super duration if unused |
| `bombPower` | 2000 | base bomb launch |
| `BOMB_STACK_PER` / `BOMB_STACK_MAX` | 0.9 / 2 | stacking |
| `BOMB_WALL_CANNON_STATIC` | 1.55 | steel-wall cannon peak |
| `BOMB_LAUNCH_MAX` | 5200 | launch cap |

---

## Tests

Sim mechanics are covered by `test-power.mjs`, `test-mechanics.mjs`, `test-shoot-angle.mjs`,
`test-cover.mjs`, `test-snooker.mjs`, `test-bomb-lob.mjs`, `test-fragile.mjs`, `test-net-roll.mjs`.
Run `node test-<name>.mjs`. **Known pre-existing:** `test-power` has 2 medium-hit meter-gain fails
(0.33 vs >0.4) unrelated to recent shot/super/bomb work. Test `shoot()` helpers hold
`charge × SHOOT_CHARGE_TIME × 60` ticks — keep that if you retune charge time.
