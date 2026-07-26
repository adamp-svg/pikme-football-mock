# Wiring the 6 techniques into the sim — hook points, risks, and what should NOT ship

**Date:** 2026-07-26 · **Status:** design + acceptance tests landed; **no sim change made**
**Files:** `shared/techniques.js` (effect helpers, green) · `test-technique-effects.mjs` (acceptance suite)
**Read-only inputs:** `shared/sim.js`, `shared/wire.js`, `shared/input-merge.js`, `public/client.js`, `shared/bot-ai.js`

## State of play

`shared/techniques.js` has defined 6 techniques since 2026-07-25. They are unit-tested
(`test-techniques.mjs`, ALL PASS) and **none of them does anything in a match**: nothing in the repo
imports the module. Verified:

```
$ grep -rn "techniques\|activeEffects" server.js shared/*.js public/*.js
shared/techniques.js:...   # only itself
```

`shared/sim.js` is the highest-regression file in the repo — the server's authority and the reference
for every client — so this pass deliberately does **not** wire anything. It does three things instead:

1. names the exact hook point for each of the 6 effects (below);
2. lands the **pure helpers** each hook needs, so the sim change is a one-line call to a tested
   function rather than new logic inside `sim.js` (`shared/techniques.js`, 98 assertions green);
3. lands the **acceptance criteria** as executable, behaviour-level tests
   (`test-technique-effects.mjs` — 9 criteria, all PENDING, exit 0 so the suite stays green).

## The single gate

Every effect reads one field and nothing else:

```js
// shared/sim.js addPlayer() — ONE line, next to `buffs` (~line 258-308)
effects: Array.isArray(effects) ? effects.slice() : [],   // technique effect ids, see techniques.js
```

`hasEffect(p.effects, EFFECT.X)` is false for `undefined`, so **until a caller passes `effects`, wiring
any hook is a no-op**. That is why all 9 acceptance criteria currently print PENDING instead of
crashing, and it is the safety property that makes this shippable in pieces.

**Pass the array form, not the Set.** `activeEffects()` returns a `Set`; a `Set` JSON-serialises to
`{}`, so anything that crosses a roster message must use the new `effectList(state)`. `hasEffect`
accepts either, but only the array survives the trip.

## THE HOOK TABLE

| # | technique | effect id | exact hook in `shared/sim.js` | reads | writes | wire change | risk |
|---|-----------|-----------|-------------------------------|-------|--------|-------------|------|
| 1 | `feint` פיינט | `cancel-charge` | **`:757`** the charge-cancel branch `} else if (!p._fire) {` inside the player loop — **not** the action loop; plus `:732-739` input latch, `:712` cooldown tick | `p.effects`, `p._charge`, `p.feintCd` | `p._charge`, `p._superLatched`, `p.firing`, `p.feintCd` | **none** (`firing` is already flags bit 0, `wire.js:23`) | **LOW** |
| 2 | `banana` בננה | `curve-kick` | `:808-809` set `b.spin` at kick; **`:886-897`** free-ball substep loop applies it; `clearKick` `:60` must zero it | `b.spin`, `b.vx`, `b.vy` | `b.vx`, `b.vy`, `b.spin` | none for rendering (ball velocity is not on the wire) — but **breaks `bot-ai.js predictBall()`** | **HIGH** |
| 3 | `cook` בישול פצצה | `hold-fuse` | `:744-749` a `p.cookT` accumulator mirroring `buildWindup`; **`useSpecial` `:1021`** `fuse: BOMB.fuse` → `cookedFuse(...)`; call site `:840` | `p.effects`, `p.cookT` | `bomb.fuse`, `bomb.x/y`, `p.cookT` | **none** — per-bomb fuse is already a wire byte (`wire.js:70`) | **MED** |
| 4 | `vault` דילוג קיר | `hop-own-wall` | **`:679`** `resolveWalls(p, rad, state.builtWalls, …)` in the movement substep **and `:766`** the post-separation re-resolve — both or neither | `p.effects`, `p.team`, `w.team`, `w.field` | nothing (removes a constraint) | none, but **a lockstep `client.js` change is mandatory** (`stepPrediction` mirrors wall collision) | **MED-HIGH** |
| 5 | `precise-strip` חטיפה מדויקת | `strip-window` | **`:1299`** `const side = (rnd(state) * 2 - 1) * DETACH_SIDE;` in `bulletStripCarrier` | `shooter.effects` | `b.vx`, `b.vy` (already written there) | **none** | **LOW** |
| 6 | `chain-super` שרשור סופר | `carry-super-use` | **`:758`** the TTL-lapse branch banks; **`earnPower` `:162`** `p.powerUses = SUPER_USES` spends the bank; `repositionKickoff` `:320` clears it | `p.effects`, `p.powerUses` | `p.superBank`, `p.powerUses` | none for correctness; **`powerUses` is not on the wire at all**, so the ability is invisible | **LOW / invisible** |

Line numbers are from `sim.js` at 1530 lines (2026-07-26 01:50). Function names + the quoted anchor
line are given so the reference survives drift.

---

## 1. `feint` — the ability IS the broadcast tell

**What already exists:** releasing `hold` without `fire` already drops the charge for free
(`sim.js:757`). It is *silent* — nothing reaches the other clients — so today there is nothing to sell.

**So the effect is:** raise the same `firing` flag a real kick raises, without releasing the ball.
That flag is already on the wire (`packFlags`, `wire.js:23`, bit 0) and every client already draws a
kick animation from it. **Zero wire change, zero new physics.** This is the cheapest of the six by a
wide margin.

**The ordering trap — read this before wiring.** The charge ramp/cancel lives in the **player loop**
(`:754-757`), which runs *before* the action loop (`:773`). A feint hook placed in the action loop next
to `if (p._fire)` would always observe `p._charge === 0`, because `:757` already zeroed it, and could
never validate that a real windup happened. **The hook must be at `:757`:**

```js
} else if (!p._fire) {
  const fp = p._feint ? feintPatch({ effects: p.effects, charge: p._charge, cd: p.feintCd }) : null;
  if (fp) Object.assign(p, fp);            // sells the fake: tell out, ball kept
  p._charge = 0; p._superLatched = false;
}
```

`p.firing = false` is set at `:731`, earlier in the same iteration, so assigning `firing: true` at
`:757` survives to the snapshot. `feintPatch` returns a 4-key whitelist and the test asserts the key
set exactly, so this hook cannot quietly grow.

**Not my files, required:**
- `shared/input-merge.js` — `feint` is an **EDGE**: latch it sticky in `coalesceInput` and clear it in
  `consumeEdges`, exactly like `fire`/`special`/`build`. Without this a feint pressed between two
  server ticks is lost.
- `server.js` input coalescer — must **forward** the field. This is the `buildDist` gotcha again
  (see `pikme-football-netcode-aim` memory): a field the coalescer does not copy silently vanishes.
- `public/client.js` — a button/gesture that emits `feint`.

**Proof:** `test-technique-effects.mjs` → *"feint: a charged carrier fakes the kick — ball KEPT, windup
spent, the fire tell goes out on the wire, and a second feint inside FEINT_CD raises no tell"*.
Discriminating clause: `A.firing === true`. Guarded by a hard assertion that a player **without** the
technique still cancels *silently* — if wiring this makes every cancelled charge broadcast a tell,
every player in the match twitches.

**Verdict: SHIP FIRST.**

---

## 2. `banana` — do not ship

**Hook:** `b.spin` set at the kick (`:808-809`), integrated in the free-ball substep loop
(`:886-897`) via `curveStep`, cleared in `clearKick` (`:60`). The helper is landed and tested: a curve
**rotates** velocity and conserves speed exactly (`hypot` unchanged to 1e-9 after a full second), so it
cannot smuggle in extra shot power. Total bend at full spin ≈ 0.5 rad (~29°).

**Why not:**

1. **There is no input channel for spin.** Every other action's payload rides an existing field
   (`aimX/aimY`, `sax/say`, `buildDist`). Curve needs a new axis *and* a new client gesture — a swipe
   arc — which is `public/client.js` work in the control layer, the most contested file in the repo.
2. **It silently invalidates the bots.** `shared/bot-ai.js`, `predictBall()`:
   ```js
   function predictBall(b, tau) { const k = 2.15; const f = (1 - Math.exp(-k * tau)) / k;
                                  return [b.x + b.vx * f, b.y + b.vy * f]; }   // straight line
   ```
   called from the two interception branches (`grep -n 'predictBall(' shared/bot-ai.js`). A curving ball
   makes every bot chase the wrong point, with no error message — it just looks like the bots got worse.
   *Cited by symbol, not line: this doc first said `:783` / `:1435` / `:1459`, which was exact when
   written and stale within the hour because another lane grew the same file by ~216 lines. Every
   `sim.js` line number in this doc is still exact (that file is untouched); treat every `bot-ai.js`
   line number anywhere as needing a `grep` first.*
3. **The reference games don't do it.** VERIFIED: Brawl Stars' wall-interaction brawlers *bounce*
   (Rico) or *pierce* (Pierce); the curving projectiles that exist (Meeple's homing shot, Nani's orbs)
   curve **toward a target**, not around cover. Nothing shipped bends a shot around a wall.

**If it must exist**, the cheap honest version is Meeple-shaped and needs no new input at all: a
kick by an unlocked player homes *slightly* toward the goal mouth. Same helper (`curveStep`), spin
derived server-side from the geometry the sim already has (`nearestGoalPoint`, `:125`). That is a
different technique from the one specced ("עקם את הכדור סביב מגן או קיר") and should be re-specced,
not smuggled in.

**Verdict: DON'T SHIP.** The helper stays green so the option is cheap later.

---

## 3. `cook` — ship second; the fuse is already on the wire

**Design (VERIFIED, Call of Duty MW3):** cooking = hold after pulling the pin so it lands with a
burnt-down fuse and *cannot be thrown back or dodged*; hold too long and **it blows up in your hand
and kills you**. That risk is the entire reason cooking is fair, and it maps onto this sim exactly:
an overdone bomb plants at the planter's feet with fuse 0, `bomberOnCenter` (`:1382`) is true, so you
eat your own blast and get launched. `cookOverdone()` exists for precisely that branch.

**The trap that would have shipped as a bug:** aiming a lob today is *already* a press-drag-release,
i.e. already a hold (`drag-cancel.js`). If cook burned from t=0, unlocking it would silently cook
every bomb you merely aimed, and eventually detonate one in your hand *for aiming carefully*. Hence
`COOK_GRACE = 0.35s`, asserted: *"the grace covers a normal aim-drag so unlocking cook cannot cook
your aiming"*, plus a hard regression test that a player **without** the technique gets the stock fuse
after a 1.35s hold.

**`COOK_MIN_FUSE = 0.12s`, and the reason is the wire, not balance.** Fuse is `u8(fuse*100)`
(`wire.js:70`) and `SNAPSHOT_RATE` is 60 Hz. Below ~2 snapshots the bomb never renders on the enemy's
screen at all — which reads as a desync, not as skill. 0.12 s ≈ 7 frames: visible, and still far under
human reaction time, which is what cooking is *for*. Both bounds are asserted.

**Wire: no change, and the visuals are already correct.** `client.js:5900`:
```js
const t = bomb.fuse / BOMB.fuse;
const blink = t < 0.35 ? (Math.floor(bomb.fuse * 12) % 2 === 0) : true;
```
A cooked bomb arrives with `fuse < BOMB.fuse`, so it renders *already blinking urgently* the moment it
lands. Free, correct feedback.

**The one honest gap: the cook METER.** `packFlags` (`wire.js:23`) uses all 8 bits — 0 firing,
1 reloading, 2-3 ammo, 4-5 buildAmmo, 6 power, 7 winding — and both frac bytes are taken (`buildFrac`
is already overloaded two ways). A server-authoritative cook meter needs a **new byte per player**.
It does not need one: the client owns the finger and can run the meter on its local clock, exactly as
`chargeStart` already does for the charge ring. The caveat is the same jitter that forced the wall's
`buildWindup >= 0.9` tolerance (`:844`): if the client thinks 1.7 s and the server has 1.6 s, the
client shows "about to blow in hand" while the server plants a live bomb. Mitigation: the client
clamps its display to `BOMB.fuse - COOK_GRACE` and treats the server's `cookOverdone` as authoritative.

**Accumulate server-side, don't trust a payload.** Mirror `buildWindup` (`:744-749`) with `p.cookT`,
gated on `hasEffect`. A client-sent `cookT` byte would be cheaper but is cheatable (always send max)
and the wall already established the server-accumulator pattern. Reset `p.cookT` after `useSpecial`
and in `repositionKickoff` (`:320`), next to `buildWindup`.

**Proof:** *"a cooked bomb blows sooner … and still lands where you aimed it"* and *"held past the whole
fuse it detonates IN YOUR HAND — at your feet, and it flings you"*.

**Verdict: SHIP.** Best gameplay value per unit of risk of the six.

---

## 4. `vault` — correct, but only if the client changes in the same release

**Design (VERIFIED, Fortnite):** Chapter 4's **hurdle** — sprint into a fence/hedge/low obstacle and
you automatically leap it, *keeping your momentum* (unlike mantling, which kills it). Modelled the
same way: as an **absence of collision**, not as an airborne state. Two reasons:

- a timed "in the air" window is exactly what produces players ejected *inside* geometry — when the
  window ends mid-wall, `resolveCircleBox` pushes the body out of the nearest face, which can be
  through the wall, into a goal pocket, or out of bounds;
- a **stateless** rule is one the client can reproduce exactly, with no new wire field and no timer to
  keep in sync.

**Hook, both sites or neither:** `:679` inside the movement substep loop, and `:766` the
post-separation re-resolve. Wire only one and the player walks into their own wall and is immediately
ejected from it. Hoist the call out of the substep loop — it is loop-invariant:

```js
const myWalls = passableWalls(p.effects, p, state.builtWalls);   // same array unless vaulting
for (let s = 0; s < pSteps; s++) { …; resolveWalls(p, rad, myWalls, undefined, arenaOf(state).walls); }
```

`passableWalls` returns the **identical array** when nothing is vaultable (asserted) so the hot path —
every player, every substep, every tick — allocates nothing. Static stone
(`arenaOf(state).walls`) is never vaultable: you hurdle a fence, not a cliff.

**Why the client must change in lockstep.** `public/client.js` `stepPrediction` mirrors wall
collision for the local player:

```js
resolveWalls(e, r, latest && latest.walls, undefined, fieldArena().walls);
```

If the server exempts a wall the client does not, the local hero **rubber-bands at their own wall every
single time**. The server is authoritative so it is not a desync in the netcode sense; it is a
prediction divergence, which is precisely what a player experiences as lag. The client *can*
reproduce the rule with no new wire field: wall team is on the wire (`teamBit`, `wire.js:69`), and
"is this a field dry wall" is derivable from `maxHp` (dry field walls are maxHp 2, built walls 3 —
see the comment at `wire.js:8-9`).

**That derivation is fragile and should be recorded as debt:** if `BUILT_WALL.hp` or the dry-wall
`maxHp` ever change, the client's vault rule silently diverges from the server's `w.field` check. A
dedicated flag bit would be correct, but the wall flags byte is also full (bit 0 team, 1-2 hp,
3 fragile, 4-7 angle).

**Also decided:** vault is a **body** exemption. The ball still collides, so carrying it into your own
wall pops it loose exactly as today (`:870-876`) — you hop the wall, the ball does not. Asserted.

**Proof:** *"vault: you run straight over your OWN wall"*, plus two hard guards — an **enemy** wall
still blocks a vaulter (if this leaks, the whole build mechanic dies) and no-technique players are
still blocked by their own wall.

**Verdict: HOLD until the `client.js` line lands in the same release.** Server-only = guaranteed
rubber-band. This is a coordinated two-file change, not a solo one.

---

## 5. `precise-strip` — the spec is a stat buff; here is the horizontal re-cut

**The problem with the spec.** "אותה חטיפה, תזמון סלחני יותר" means lowering the strip threshold at
`:1292` (`if (pr.charge < FULL_CHARGE) return false;`). A player who strips carriers at a charge their
opponent cannot **is numerically stronger**. That violates the rule stated at the top of
`techniques.js` ("never makes you numerically stronger") — and `test-techniques.mjs` cannot catch it,
because it only checks catalogue *metadata* (`kind:'ability'`, no `mul` field), never the effect. The
metadata gate is passable by any stat buff that keeps its magnitude out of the object literal.

**Re-cut (INFERRED, mine).** A precise strip is *cleaner*, not stronger. Today a stripped ball squirts
off to a random side — the sim's only strip randomness:

```js
const side = (rnd(state) * 2 - 1) * DETACH_SIDE;   // sim.js:1299
```

With the technique the ball comes off **straight down the line you shot**, at the same power, so the
strip is a play you can follow up instead of a coin flip. Same threshold, same knockback, same
`PROJECTILE.ballPush` — only the scatter goes away. One line:

```js
const side = stripDetachSide(shooter && shooter.effects, rnd(state));
```

**Call `rnd(state)` unconditionally.** Pass the draw in and let the helper ignore it. If the call is
skipped for technique-holders, the seeded RNG *stream* diverges and every later random in that tick
(the bomb-pop angle and speed, `:1474-1475`) shifts — which would silently break the paired A/B
harness that `state.rng` exists for (`:186-203`).

**Proof:** hard assertion that without the technique the value is bit-identical to today's formula for
101 rolls; hard assertion that today's detach really is seed-dependent; acceptance criterion that with
it the ball detaches down the shot line **at the same power**, identically on every seed.

**Verdict: SHIP.** It is the only one of the six that *reduces* nondeterminism, which makes it the
safest thing in this document. Do not build the specced version.

---

## 6. `chain-super` — mechanically trivial, and invisible

**Hook.** Bank on the **TTL-lapse path only**:

```js
if (p.powerT > 0) { p.powerT -= dt;
  if (p.powerT <= 0) { p.superBank = bankSuperUses(p.effects, p.powerUses); spendSuper(p); } }   // :758
```

Do **not** put the bank inside `spendSuper` (`:1270`). It has **five** call sites, and the fifth is the
one that matters most here — an earlier draft of this table listed only four and missed it:

| site | what it is | may it bank? |
|---|---|---|
| `:758` | TTL lapsed — the super timed out unused | **YES — this is the only one** |
| `:813` | overcharge kick | no: deliberately spends the whole meter |
| `:833` | overcharge bullet | no: same |
| `:1302` | overcharge strip | no: same |
| `:1273` | inside `useSuperCharge()` — `powerUses` hit 0, i.e. the player **spent every use** | **no** |

The four `no` rows would refund part of an overcharge if they banked. `:1273` is the subtle one: it is
the exhaustion path, so it is exactly the case chain-super must NOT reward — the whole point of the
technique is *"you didn't get to use it, so carry it"*, and a player who used all `SUPER_USES` did get
to use it. Banking there turns chain-super from a compensation into a permanent +1 use per super.
**Decision (INFERRED, mine): a banked use survives only a TTL lapse, never a `powerUses` exhaustion.**

Spend the bank where a fresh super is granted — `earnPower` `:162`:

```js
p.powerUses = superUsesOnFill(p.effects, p.superBank); p.superBank = 0;
```

And clear it in `repositionKickoff` (`:320`) next to `p.powerUses = 0`, or the bank becomes a
match-long stockpile across goals (asserted as an acceptance criterion).

**Cap = 1 (`SUPER_BANK_MAX`), and this is a deliberate design position.** VERIFIED: Supercell moved
Brawl Stars **Gadgets off banked per-match uses onto a cooldown system** (Feb 2025) — the reference
game deleted exactly the resource-hoarding pattern this technique proposes. Capping at 1 keeps it
"don't waste this cycle" (conservation — you can never exceed what you earned) instead of a stockpile.

**The honest problem: nobody can see it.** `power` is one wire bit (flags bit 6); `powerUses` is **not
on the wire at all**, so no client can show 3 pips today, let alone 4. There is no desync risk — the
server is authoritative — but there is no feedback either, and an ability with no feedback reads as a
bug ("my technique does nothing"). Making it perceptible needs a new byte per player, because
`packFlags` is out of bits.

**Verdict: SHIP LAST, or hold.** Correct and cheap, but ship it *with* a uses indicator, not before.

---

## Consolidated wire-format findings

**The most important netcode fact for this work: the client does not run `sim.js`.** `public/client.js`
imports `arena.js`, `constants.js`, `training.js`, `wire.js` — **not** `shared/sim.js`. It renders
authoritative snapshots and predicts only its own *movement* (`stepPrediction`, ~`:3893`). The header
comment in `sim.js` ("Runs on the SERVER … and on the CLIENT for local prediction") is stale.

That changes the desync analysis completely: an effect that only alters things the wire already carries
cannot desync — it is simply *rendered*. The real divergence surface is the handful of places where
the client **re-derives** a sim rule locally:

| what the client re-derives | technique affected | consequence |
|---|---|---|
| wall collision for the local player (`stepPrediction` → `resolveWalls`) | **vault** | rubber-band at your own wall unless the client mirrors the rule |
| the charge ring off a local `chargeStart` clock | feint, cook | HUD/server drift under jitter (the same problem `buildWindup >= 0.9` solves at `:844`) |
| the bomb-lob ghost + landing circle (`client.js:6409`) | cook | unchanged — cook does not move the landing spot |
| `bot-ai.js predictBall` straight-line extrapolation | **banana** | bots chase the wrong point, silently |

**No technique in this document requires a wire-format change to be correct.** Two require one to be
*perceptible*:

- `chain-super` — `powerUses` is not on the wire (needs a new byte; `packFlags` is full).
- `cook`'s hold meter — solvable client-side on the local clock (precedent: `chargeStart`).

**Bytes available: none.** `packFlags` uses all 8 bits (0 firing, 1 reloading, 2-3 ammo,
4-5 buildAmmo, 6 power, 7 winding). The wall flags byte uses all 8 (0 team, 1-2 hp, 3 fragile,
4-7 angle). `buildFrac` is already overloaded two ways. Anything new is a new byte.

## Ship / don't ship

| technique | verdict | one-line reason |
|---|---|---|
| `feint` | **SHIP FIRST** | its whole payload is a flag the wire already carries; no new physics |
| `cook` | **SHIP** | fuse is already a per-bomb wire byte and the client already blinks it correctly |
| `precise-strip` (re-cut) | **SHIP** | one line, and it *removes* the sim's strip RNG — the safest change here |
| `chain-super` | **SHIP LAST** | correct and cheap, but invisible until a uses byte exists |
| `vault` | **HOLD** | correct only if the `client.js` prediction line changes in the same release |
| `banana` | **DON'T SHIP** | no input channel for spin, needs new client gestures, and it silently breaks `bot-ai` ball interception |

**Two specs must not be built as written:** `precise-strip`'s lower strip threshold (a stat buff — see
§5) and any "cooked bomb has a bigger blast radius" framing of `cook` (same problem: `explode()` grows
the radius only for *stacking*, `:1385`; growing it for a technique makes the ability a damage upgrade,
which is exactly what the horizontal-only rule forbids). Cook changes **timing**, not power.

## Research: VERIFIED vs INFERRED

- **VERIFIED — Fortnite (Chapter 4)** ships mantling *and* hurdling: sprint into a fence/hedge and you
  automatically leap it keeping your momentum, unlike mantling which kills it. → basis for `vault`
  being automatic, momentum-preserving, and stateless.
  [gamerjournalist](https://gamerjournalist.com/how-to-mantle-in-fortnite-chapter-4-season-1/) ·
  [sportskeeda](https://sportskeeda.com/fortnite/news-fortnite-chapter-4-adds-new-movement-mechanic)
- **VERIFIED — Brawl Stars** moved Gadgets from a fixed number of banked uses per match onto a
  **cooldown** system (Feb 2025 update). → argument against banking more than one super use.
  [Brawl Stars Wiki: Gadgets](https://brawlstars.fandom.com/wiki/Gears) ·
  [Supercell release notes](https://supercell.com/en/games/brawlstars/blog/release-notes/release-notes-february-2026/)
- **VERIFIED — Brawl Stars** has no brawler that bends a shot *around* cover: Rico's shots bounce off
  walls, Pierce's pass through them, and the curving projectiles that exist (Meeple's homing shot,
  Nani's orbs) curve toward a **target**. → argument against `banana` as specced, and the shape of the
  cheap alternative. [Brawl Stars characters](https://en.wikipedia.org/wiki/List_of_Brawl_Stars_characters) ·
  [Pierce guide](https://pinkcrow.net/brawl-stars/pierce-brawler/)
- **VERIFIED — Call of Duty (MW3)** grenade cooking: hold after pulling the pin to shorten the fuse so
  it cannot be thrown back or dodged, and **if you hold too long it blows up in your hand and kills
  you**. Only some lethals can be cooked; stuns/flashes have a fixed fuse. → basis for `cook`,
  including `cookOverdone` as the fairness mechanism rather than a balance number.
  [dotesports](https://dotesports.com/call-of-duty/news/what-is-a-cooked-grenade-in-mw3-answered) ·
  [oneesports](https://www.oneesports.gg/call-of-duty/what-are-cooked-grenades-mw3-wz/)
- **INFERRED (mine):** the `precise-strip` re-cut (clean detach instead of a lower threshold), the
  `COOK_GRACE` window, `COOK_MIN_FUSE` from `SNAPSHOT_RATE`, `FEINT_CD`, `CURVE_RATE`/`CURVE_DECAY`,
  and `SUPER_BANK_MAX = 1`. Every one of them is a constant in `shared/techniques.js` with the reason
  in a comment beside it and a test asserting the bound.

## Out of scope, still open

- **Drills pay 0 trophies** — deliberate (`techniques.js` header) so drills can't be farmed for rank,
  but `OPEN_ITEMS` lists it as a gap. That is a server/progression decision, not a sim one.
- **Nothing awards a technique yet.** `recordDrillResult` has no caller: the training ground
  (`shared/training.js`) does not score the 6 drills, and no endpoint persists drill state. Wiring the
  sim effects without that means a player can never unlock one. **Sequencing matters: the drill →
  unlock → roster → `addPlayer({effects})` path must land before, or alongside, the first sim hook.**
- **Bots cannot use techniques.** `fillBots` would pass `effects: []`. Harmless, but if the bot ladder
  ever grants them, `bot-ai.js` needs to know how to *use* an ability, not just own it.
- **`shared/wire.js` wall-AABB `u8` overflow** (pre-existing, reported, unfixed) is untouched here but
  sits in the same wall path `vault` reads: `u8(w.w); u8(w.h)` masks `& 255` without clamping, so a
  tall dry wall renders 256 px from where it collides.
