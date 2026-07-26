# Bot skill catalogue — every trick, measured

**The permanent record.** Sixteen skills across two research rounds, each one scripted inside the
real `shared/sim.js` before it was written down here. Where a second investigator re-ran a result
and cut it down, **the corrected number is the one in this table** and the original is noted.

Reproduce any of it:

```bash
node research/trick-lab.mjs          # round 1, T1-T8
node research/probe-S1.mjs           # …S8, one file per skill (probe-S*.mjs)
node research/record-plays-2.mjs > research/plays2.json   # re-record every scene
```

Nothing here is implemented in the game. Every entry says what `shared/bot-ai.js` does about it
today, which is usually nothing.

---

## The three facts that govern almost everything

Learn these and most of the table below becomes predictable.

**1. A full-charge kick rolls 647px.** `roll = 0.468 × (v₀ − 18)`, `v₀ = shotPower(1400) ×
chargeMul`. The pitch is 2000 wide. So a kick reaches barely a third of it, and every "shoot at the
goal" decision is really a range decision.

**2. A carrier pops its own ball on any wall.** The ball is glued at `feet + aim × 58.25px`, and
`sim.js` releases it the instant that spot touches a wall — with a lockout so the carrier cannot
re-collect. A gap a *body* fits through is not a gap a *carrier* fits through. This single rule
explains the round-1 possession collapse, makes the anticipation wall a strip, and is the reason
corridor planning has to model the carrier and not the body.

**3. Bullets have no range limit and no falloff.** `PROJECTILE.ttl` is declared and never read;
`BULLET_MIN_DIST` / `BULLET_FULL_DIST` are imported nowhere. A zero-charge tap crossed 1836px over
10 seconds, and a full hit delivers the same 1500 knockback at 70px as at 1200px. *(I got this wrong
in round 1 by reading the constants instead of measuring. `docs/MECHANICS.md` §3 still describes the
falloff that does not exist.)*

---

## Round 1 — bombs, walls and the ball

| # | Skill | Verdict | The number |
|---|---|---|---|
| **T1** | **Cannon pass** — a mate's on-centre bomb flings the carrier goalward, **ball still attached** | ✅ | 582px bare, **763px** with stone 50px behind the bomb (+31%). Ball retained in every case. |
| **T2** | **Build-then-bomb** — raise your own cannon wall, then launch off it | ✅ | 664 → **717px**. Costs 0.5s of windup and 1 of 2 wall charges. |
| **T3** | **Long ball + rocket chase** — release, plant, ride the blast after it | ✅ | Beat a defender starting **560px closer** to the landing spot and re-collected. |
| **T4** | **Bullet-ball** — shoot a loose ball over the line | ✅ | **Scored** from 130px out. 10–65 chances a match, **0% taken**. |
| **T5** | **Bomb clearance** — lob a bomb beside a loose ball in your own box | ✅ | **199px** of clearance lobbed; only 99px if you plant at your feet 120px away. |
| **T6** | **Fragile-wall snipe** — one quick tap deletes a wall built over a bush | ✅ | All **4 blocks** gone for the cheapest shot in the game. |
| **T7** | **Launch ceiling** — 2 stacked bombs + stone | ⚠️ | **1344px (67%)**, not the **1842px (92%)** `docs/MECHANICS.md` claims. |
| **T8** | **Range truth** — what a full kick reaches | ⚠️ | Goal at 400 and 647px; **195px short** from 900; 395px short from 1100. |

### T1 · Cannon pass *(your ask: "one bot builds a wall then places a bomb to fly further")*
The support plants at its own feet and **stands on the plant**. `explode()` skips the ball-detach
whenever `bomberOnCenter && b.owner` — and the carrier is a *different* player, so it takes the
ordinary blast push and keeps the ball. A team-mate also escapes `BOMB_CARRY_LAUNCH_MUL`, which only
applies to the bomber's own self-launch.

Geometry must be **wall → bomb → carrier**. A wall *between* the bomb and the carrier is cover and
cuts the push to 25% (`BLAST_WALL_PASS_MIN`). The cannon is a proximity ramp — a wall 120px behind
is worth 5%, 50px behind is worth 31%.
**Counter:** stand between the bomb and the carrier, or strip the carrier mid-flight.
**Bot gap:** nothing. `cannonPlant()` exists but is only ever used for a bot's *own* mobility.

### T2 · Build-then-bomb
`sim.js` `wallCannonMul()` counts **built** walls at peak `BOMB_WALL_CANNON_BUILT 1.15 × hp/maxHp`.
`bot-ai.js` `cannonMulAt()` deliberately ignores them — sound for a *planned* launch (an opponent
could shoot it down), wrong when the bot **builds it itself 0.5s before planting**: `BUILD_WINDUP`
0.5s against `BOMB.fuse` 1.725s is a 2.2s window, and the wall is hp3.
**Change:** count a built wall when `w.team === p.team && age < 3s`.

### T3 · Long ball + rocket chase *(your ask: "quick-shot to detach the ball, then bomb to catch up")*
A carrier can never plant — the sim gates the bomb on `!carrying`. So: **release, plant on the next
tick, ride the blast.** The windows line up almost exactly: a full kick rolls 647px, an on-centre
launch glides 664px. Refinement: aim the release at a **wall** so it rebounds (`WALL_BOUNCE 0.62`)
into the space the jump lands in.

### T4 · Bullet-ball
A bullet sets a loose ball's velocity to `PROJECTILE.ballPush(476) × chargeMul` — about 214px of
roll at full charge, a quarter of that on a tap. A loose ball over the line is a goal. Two uses:
finish inside ~214px of the line, and — far more often — **clear** a loose ball away from an enemy
in your own box.
**Known defect:** `clearKick()` nulls `b.lastKicker` on every bullet-ball strike, so the goal counts
on the scoreboard but **can never be credited to the shooter**.

---

## Round 2 — angles, passing, anticipation, deflection

Every one of these was re-run by a second investigator whose job was to break it. Three did not
survive intact.

| # | Skill | Verdict | The number |
|---|---|---|---|
| **S1** | **Wide-angle finish** — the real scoring window vs the bot's trigger | PARTIAL ✔ | Window **28.5°** dead-on at 500px, **16.5°** from 45° at 566px, vs a **51.6°** release cone. But the cone binds on only **4.2%** of 591 live releases. |
| **S2** | **Passing with a kick** | ✅ ✔ | **Every pass a bot can complete is a catchable one.** Completes out to 558px; safe only past 665px. |
| **S3** | **Snooker pass** — hit the ball off-centre to send it sideways | ✅ ✔ **but the application is dead** | **45.0°** off the flight line from an 8.32px offset. As a pass it **loses to walking**: 2.95s vs 1.08s. |
| **S4** | **Anticipation wall** — build in the carrier's path | ✅ ✂ | Strips **on the tick the wall appears**. Denial cut from 79% → **17–20%** against a carrier who steers once. |
| **S5** | **Anticipation lob** — bomb their predicted position | ✅ ✔ | **120/120** dispossessed inside a 95–350px aim window. But an arcing 45°/s dribble drops it to **13%**. |
| **S6** | **Bank off the stone** | PARTIAL ✂ | Reflection is **`atan(tan i / 0.62)`**, not a mirror. `goalBank` finds **0 banks in 1103 positions**; hand-found banks win **12%** of defender positions outright. |
| **S7** | **Shoot them off the ball** | ✅ ✔ | 1500 kv = **343px** of drift, and the wind-up costs a sprinter **zero** speed. Cut to **250px / 220px break-even** for a bot, ~**107px** on the real arena. |
| **S8** | **Shield the carrier** | ✅ (no second pass) | A **body** buys **+18.85s free**; the bullet **+4.55s** for 1.42s. Three quick taps buy **0.00s**. A shot from behind makes the chaser arrive **1.18s sooner**. |

### S1 · Wide-angle finish *(your ask: "shooting balls at an angle")*
A kick carries no lateral force, so the set of scoring aims is a pure angular window. Two things
close it: the posts reserve `ballR 32 + POST_R 9` at each end, leaving a **218px band** of the 300px
mouth; and the 647px roll limit means **no angle scores from 800px**. Post bounces make the measured
window **11–18% wider** than pure geometry — clipping the woodwork goes in as often as out.

My hypothesis that the bot's 26° release tolerance was costing goals was **wrong**: across 591 live
releases the aim converges long before the charge gate opens, and the tolerance bound on just 4.2%.
What *does* bite: **the aim-point ladder tests walls only** (`laneClear(enemies:false)`), so a body
never de-selects the centre and `postFinish` can only fire when a *wall* blocks the middle.

Against a keeper, the near post scores **71–100%** and the far post **0–65%** — and `cornerFinish`
picks its corner from the keeper's `y` alone, so a keeper within 2px of the centre line flips the
choice arbitrarily.

### S2 · Passing with a kick — the disjoint-window bug
`charge = clamp(dist/950, 0.4, 0.85)` reaches `FULL_CHARGE 0.70` only at **665px**, but that same
formula's kick stops physically reaching the receiver past **558px**. A kick below `FULL_CHARGE` is
**caught outright** by any field defender within 58px of the lane. The two windows have no members
in common. That is the mechanical cause of round 1's measurement that **42% of bot releases are
collected by an opponent**.

Three more defects in the same two lines: `leadAim` is fed `shotPower × charge` when the real launch
speed is `shotPower × (0.25 + 0.75c)` *and then decays*; it is solved from the player's centre when
the ball launches 58.25px in front; and `laneClear(margin:4)` uses a 40.25px enemy radius when the
sim intercepts at 58.25px.

### S3 · Snooker pass *(your ask: "passing by shooting at the ball at an angle")*
`snookerPush` with `BALL_SHOT_DEFLECT 45°` and `gain 3.4` — aiming **8.32px** off the ball's centre
sends it a measured **45.0° off the bullet's flight line**. Completely implemented, never used.

**But as a pass it loses.** The receiver walks to the ball in 1.08s; the pass delivers in 2.95s,
because it pays a charge wind-up plus bullet flight before the ball moves at all, and by
construction the receiver is inside the 214px roll budget. Worse, on a **rolling** ball the
deflection *reverses sign* — 60px/s of drift flips −38.7° to +45.0°, and a perfect analytic
intercept does not rescue it. And the aim band is **5.5° wide at 360px**, narrowing to 1.5° at
1200px — smaller than `aimSigma` below "normal", so it is a coin flip for weak bots.

**Keep the deflection as a shooting/redirect tool. Do not build it as a pass.**

### S4 · Anticipation wall *(your ask: "building tactical walls")*
A wall committed **85px** in front of a driving carrier pops the ball on the very tick it appears,
51px before their body reaches the stone. Confirmed general: 13/13 across rotated lanes, ±24%
geometry, three seeds, `buildDist` 0/0.5/1, and lanes hugging either touchline.

**What the verifier cut:** the "79% of advance denied" headline. 109px of advance is simply where a
body stops against stone — identical with the carrier aiming sideways and never stripped, and
identical **with no ball on the pitch at all**. Against a carrier that peels perpendicular for 1.0s
— even a full second *after* the stone appears — advance is **312–427px of the 512px control**, so
**17–20% denied**, not 79%. And within ~150px of the goal line the builder's stand spot is off the
pitch, so the play cannot be run in the final third.

### S5 · Anticipation lob *(your ask: "put a bomb ahead while predicting enemy movement")*
Lob at `A = C + v_c × 1.7333s`. Dispossession is **100% inside a 95–350px aim-point window** and
~2% beyond 418px. Below `BOMB_CENTER_R` 95px it drops to 42% — the on-centre trap. So it is a
**band, not a monotone envelope**, and the band is computable before committing.

The gate opens on only **~49%** of situations, and a **continuous arcing dribble beats it**: 53–70%
dispossession at 0–30°/s of turn, collapsing to **13% at 45°/s**. Against the existing `bombTackle`
feet-plant, the lob converts **56% vs 24%**.

### S6 · Banking *(your ask: "use the field obstacle to deflect the ball")*
```
angle_out = atan( tan(angle_in) / 0.62 )      speed kept = √(0.62²cos²i + sin²i)
```
Measured to 0.1° at every incidence, because `resolveCircleBox` reflects **only the normal
component**. Every bank comes off *flatter* than a mirror predicts — which is very likely why
`bankAim` produces nothing.

`goalBank` returns a bank from **0 of 1103** shooter positions on MAIN_FIELD. A hand-found bank off
the **rounded end** of the (1625,550) stone beats a defender at **12% of 136 swept positions where
no straight shot exists at all** *(the probe claimed 100% of blocked positions; the verifier's
correct denominator gives 89% of the 18 spots where straight fails, i.e. 12% of all spots)*.

### S7 · Shoot them off the ball *(your ask: "shoot an enemy to deflect it from the ball")*
1500 kv = **343px** of drift on a standing target, and holding the trigger costs a sprinting player
**zero** speed — 427px covered in 3.0s whether holding or not. So the wind-up is free.

**Cut by the verifier:** a bot cannot fire above **charge 0.71** (`finalize()` clamps every bullet to
`FULL_CHARGE + 0.01`), giving **250px of drift** and a **220px break-even head start**, not 343/320.
And on MAIN_FIELD with a same-arena control the shot is worth a mean of **107px** over 15 spots —
worth nothing at 6/15 because static stone eats the bullet, and **−380px** at one spot where it
clipped the loose ball and handed possession away. The claimed counter (a dodge) does **not** work:
a defender running bot-ai's own `TACTIC 7` sidestep still gets hit at every distance tested.

### S8 · Shield the carrier *(your ask: "keep the friend baller safe")*
⚠️ *This one has no adversarial second pass — its agent died on a connection error and I measured it
myself.*

| intervention | delay bought | shooter time | delay/s |
|---|---|---|---|
| do nothing | +0.00s | — | — |
| **body screen** | **+18.85s** | **0.00s** | **free** |
| full aimed bullet, charge 1.00 | +5.93s | 2.00s | 2.97 |
| bot-reachable bullet, 0.71 | +4.55s | 1.42s | 3.20 |
| three quick taps (slow stacks) | **+0.00s** | 0.60s | **0.00** |

**The angle inverts the play.** Shoving a chaser at **0°** to their heading makes them arrive
**1.18s sooner** — you pushed them where they were going. 90° is neutral (+0.10s). Only **150–180°**
buys time (+1.60 / +1.93s). `clearMarker` has no angle term and fires from wherever the support
happens to stand, so roughly half its shots are a gift to the opponent.

**Refuted:** slowing a chaser with quick taps. +0.00s at gaps of 160, 260, 400 and 560px, for the
whole mag. `SLOW_STACK_DECAY` runs on a clock a new hit does not refresh.

---

## Every defect found, by file

### `shared/sim.js`
| Where | Defect |
|---|---|
| `updateProjectiles` | `PROJECTILE.ttl` never read — bullets are unlimited-range. `pr.dist` never incremented, so `BULLET_MIN_DIST`/`BULLET_FULL_DIST` are dead and there is no point-blank rule. |
| `:1245` | `clearKick()` on a bullet-ball strike nulls `lastKicker`, so a bullet-ball goal can never be credited to the shooter. |
| `:1476` `explode` | **Bullseye singularity**: a bomb on a body's exact centre gives `ux = uy = 0` — maximum power, **zero** knockback. 0.5px off-centre gives 499px. Perfect aim is punished. |
| `:1516` | The ball-detach ignores cover that the player-push respects: stone across the blast LOS drops the player push to 0 but still strips the ball. |
| `:834` | `isTap = eff < QUICK_CHARGE` on a float-summed charge: 30 additions give 0.24999999999999997, so asking for exactly 0.25 silently drops to a 64px dribble touch. *(The same trap does **not** exist at `FULL_CHARGE` — verified.)* |

### `shared/bot-ai.js`
| Where | Defect |
|---|---|
| `:1380` | The release ladder shoots at the mouth from `distGoal < 1150` while `MAX_REACH` is 647. **97% of releases die short**; 153 of 222 live goal-directed releases had a zero scoring window and *all* of those were out of range. |
| `:1352 / :1395` | The pass charge formula's completion window [196..558] and its non-catchable window [665..] are **disjoint**. |
| `:1353 / :1396` | `leadAim` given launch speed for a decelerating ball, solved from the wrong origin (player centre, not the 58.25px glue spot). |
| `:2255-2257` | Every bot bullet clamps to `fireAt 0.71`; the ball-release path arms at `wantCharge − 0.01`, so asking for 0.70 releases at tier 0. |
| `:2283` | The charging latch never re-tests the lane — a bot **shoots down its own team's fresh wall** (measured wall lifetime 0.18s). |
| `:1885 / :1907 / :1911` | `blockDrive` sets `bm.trap` on the same tick it arms `bm.buildHold`, and its own `!bm.trap` guard gates the branch out — so another branch owns the aim at the build edge. **The wall is built pointing backwards** (armed `(1,0)`, emitted `(−1,0)`). |
| `:1210-1216` | The aim-point ladder is walls-only, so a body never opens the corners. |
| `:1292` | `cornerFinish` picks its corner from the keeper's `y` alone — arbitrary within ~50px of the centre line, and measured 0% vs 88% on the wrong side. |
| `:1625-1634` | `clearMarker` cites `FULL_CHARGE(0.85)` — it is 0.70 — and has **no angle term**. |
| `:1568-1571` / `:1964-1974` | `bm.screenUntil` is shared by the body screen and the goal screen, two branches in opposite possession states. |
| `:1652` | `mem.push` is written and never read — the one-two does not exist. |
| `:208` | `bushLove` is computed for every persona and never read; the `poacher` is just a low-aggro bot. |
| `:2141` | `finalize()`'s `opts.hold` is dead at all 12 call sites, so a bot parked on a bomb plant still reports "wants to move" — contaminating the pinned% metric. |
| `:799 / :831` | `role.mode` is written every tick for both teams and read nowhere. |
| `:876` | `sitHash`, `decideAt`, `action` are `decisionHz` leftovers. |

### `docs/MECHANICS.md`
Stale: `shotPower 1850` (is 1400), `FULL_CHARGE 0.85` (is 0.70), `OVERCHARGE_BULLET_MUL 1.6` (is
1.4), the ultimate combo "1842px / 92%" (is 1344px / 67%), and §3's point-blank falloff, which does
not exist in the code at all.

---

## Measured and refuted — do not re-propose

Alongside the ones already in `summery/BOT_HANDOFF.md` §4:

- **Slowing a chaser with quick taps.** +0.00s at every gap tested, for the whole mag.
- **The snooker pass as a *pass*.** Loses to the receiver walking, 2.95s vs 1.08s, and reverses sign on a rolling ball.
- **"The bot's 26° release tolerance is why it misses."** It binds on 4.2% of releases and on 1 of 69 makeable shots. The range gate is the real cause.
- **Ammo starvation.** 0% of press chances lost to an empty mag, at both skill levels measured.
- **Role thrash.** 7–9 `onBall` switches per 60s match; the hysteresis works.
