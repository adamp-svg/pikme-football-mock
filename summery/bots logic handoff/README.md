# Bot logic — research handoff from the `bot-brain-research` worktree

**Written 2026-07-26 17:4x by agent `bot-brain`, working in
`.claude/worktrees/bot-brain-research` (branch of the same name).**
Audience: whoever is holding `shared/bot-ai.js`. Right now that is agent `bot-fix`, who is on round 9b
of the passing work — your handoff (`summery/BOT_HANDOFF.md`) is what I read first and this document is
written to complement it, not to duplicate it.

**Nothing here has been committed to `main`.** No bot code was changed, no test was changed. This is
measurement, plus one file: this document.

---

## 0. The one rule for reading this

**My worktree is 27 commits behind `main`.** It forked at `7c74822`; `main` is at `debda06`. So every
finding below was *measured* on the older tree and then *re-verified against current `main` by hand
before being written down*. That check already caught two of my own reports as stale:

| I would have told you | Actually |
|---|---|
| `blockDrive` builds its wall pointing backwards | **You already fixed it.** `finalize()` latches `bhAim = {x: h.x, y: h.y}` off `buildHold.wx/wy`. Your own comment says "only the wall's ORIENTATION is fixed, which is the part that was actually broken" — same conclusion I reached independently. |
| `botCanSee` is a circle, so bots have 2× the vertical awareness of a player | **You already fixed it.** `VIEW_HALF_W 606 × VIEW_HALF_H 341`. My worktree has zero occurrences of it; `main` has three. |

Everything that follows I have re-grepped or re-run against `main` today. Where I could not verify
something on `main`, I say so.

Evidence lives in the worktree under `research/`: 8 `probe-S*.mjs`, 6 `rule-R*.mjs`, 14
`scene-*.mjs`, `corridors.mjs`, the `refute-*` adversarial re-runs, and `SKILL_CATALOGUE.md`
(copied into this directory). Everything is seeded and reproducible.

---

## 1. READ THIS FIRST — `pointInBush()` ignores `state.arena`, and it blinds the bots to the ball

**This is live on `main` right now and I think it is the most valuable thing in this document.**

```js
// shared/arena.js:37
export function pointInBush(x, y) {
  for (const g of BUSHES) { ... }        // <- the MODULE-LEVEL default-arena const
}
```

It takes no `state` and never reads `arenaOf(state).bushes`. `shared/bot-ai.js` calls it in three
places — `botCanSee` (:439), `updateBelief` (:823), and the deflect set-piece's wall placement
(:1959). So the entire bot-side bush model runs on **the default arena's three rectangles**, on every
map, forever.

On `MAIN_FIELD`, measured (6 matches × 60s, both sides skill 0.50, seeded):

| | |
|---|---|
| loose-ball ticks | 70.3% of play |
| …**inside a PHANTOM bush** (a default-arena rectangle that is not there) | **10.1%** of loose ticks |
| …and no bot within `BUSH_REVEAL_DIST` 110px ⇒ **the whole team is blind to the ball** | **8.9%** of loose ticks, **3.49s per match** |
| **longest single blind run** | **16.32 s** |
| …inside a **REAL** `MAIN_FIELD` bush, which *should* hide it and never does | **30.6%** of loose ticks |
| `MAIN_FIELD` bush centres `pointInBush()` recognises | **0 of 14** |

The phantom "centre contest bush" is `{x:850, y:430, w:300, h:240}` — it **covers the kickoff spot
(1000, 550)**. `updateBelief` then does:

```js
} else if (!pointInBush(b.x, b.y)) { visible = true; }        // loose ball in the open = known
else { visible = bots.some((bt) => hyp(...) < BUSH_REVEAL_DIST); }
```

…so a loose ball that comes to rest anywhere in a 300×240 box over the centre circle is **invisible to
both teams** unless somebody is already within 110px. Sixteen seconds of a team not knowing where the
ball is.

**I believe this is a large part of the user's own two complaints** — *"not going for the ball"* and
*"they get idle waiting for something"*. It is a completely different root cause from the wall-pop
that round 5 of your handoff fixed, and the two are additive.

And the stealth mechanic is **inverted**, not merely broken: the ball is hidden where there is no
bush, and revealed in the 30.6% of loose ticks where it is in a real one. Every bush behaviour in the
file — `ambushLurk`, `chooseAmbushBush`, `bushLove` — is reading phantom geometry.

**The fix pattern already exists twice in this codebase**, which is why I am confident about it:
`sim.js wallInBush(state, …)` and `sim.js canSeeEnemy` both use `arenaOf(state).bushes`. And
`public/client.js:6558` carries the comment *"Bush test against the active layout (pointInBush only
knows the global one)"* — **the client already works around this.** Only `bot-ai.js` does not.

Thread `state` through: `pointInBush(x, y, state)` falling back to the module const when `state` is
absent, so `client.js`'s existing call keeps working. Three call sites in `bot-ai.js`.

⚠️ **Expect this to move numbers.** Turning 14 real bushes on will change every ambush/lurk
measurement in your handoff, and it makes carrier concealment real for the first time. It is a
behaviour change, not just a bug fix — measure the ladder.

---

## 2. The other live defects, re-verified on `main` today

Ordered by what I would fix first. All line numbers are `main` as of `debda06`.

### P0 · `bot-ai.js:1380` — the release ladder fires shots that cannot arrive
`if (goalAimY != null && distGoal < 1150)` against `MAX_REACH = ballRollPx(state, 1) = 647px`. Between
647 and 1150 the bot asks for a charge it already knows is insufficient.

Measured two ways: **97% of all bot ball-releases die short** (12 matches, MAIN_FIELD); and over
24 × 90s × 4 tiers, **153 of 222 goal-directed releases (69%) had a ZERO scoring window, and 100% of
those were out of roll range** — not off-angle, just too far. `FINISH_RANGE` was rebuilt on the roll
model in `64e0218` precisely to kill this class of bug; the release ladder never got the update.
`1150` is a survivor.

Fix: gate rungs (a)/(b) on `distGoal <= MAX_REACH * 0.95`, fall through to the outlet. The watchdog
should keep force-releasing but aim at the mate or the touchline, not a goal it cannot reach.

### P0 · `bot-ai.js:1352 / :1395` — the two pass windows are disjoint
`charge = clamp(dist/950, 0.4, 0.85)` reaches `FULL_CHARGE 0.70` only at **665px**, but that same
formula's kick stops physically reaching the receiver past **558px** (566px on a second grid). A kick
below `FULL_CHARGE` is **caught outright** by any field defender within 58.25px of the lane.

**So the set of passes a bot can complete and the set it can deliver safely have no members in
common.** I know you have done a lot of work on the *receiver* side; this is the *charge* axis and I
think it is orthogonal to it. Three more defects in the same two lines:

- `leadAim` is passed `full * clamp(charge, 0.33, 1)` as the projectile speed. The real launch speed is `shotPower × (0.25 + 0.75c)` and it then decays by `BALL_FRICTION` every tick, so the lead is systematically **short**.
- It is solved from `p.x, p.y`, but the sim launches the ball from the glue spot **58.25px in front** (`sim.js:905`). Measured cross-error 14px at 300px, 13px at 400, 9px at 600.
- `laneClear(..., {margin: 4})` uses an enemy radius of `radOf + 10 + margin = 40.25px`, but the sim intercepts at `radiusOf + ballRadius = 58.25px`. The lane test is 18px more optimistic than the physics.
- `clamp(charge, 0.33, 1)` is dead — `charge` is already floored at 0.4 on the line above.
- `settings.shotPower || 1850` — the 1850 fallback is the stale pre-retune number (it is 1400).

The file already has `ballRollPx()` and `chargeForRoll()` at `:40-49`. Sizing the pass from them, with
a floor at the interception threshold, is the whole fix.

### P0 · `bot-ai.js:2255-2257` — no bot can fire a bullet above charge 0.71
`fireAt = (wantCharge >= FULL_CHARGE ? FULL_CHARGE + 0.01 : wantCharge - 0.02)`. `FULL_CHARGE` is
0.70, so **every** branch asking for `charge = 1` releases at 0.71. That is fine for a strip (0.71 ≥
0.70) and wrong for a knockback, where `pushCurve` scales all the way to 1.0: measured **250px of
drift instead of 343px**, and the break-even head start in a 50/50 falls from 320px to 220px.

The ball-release path has the mirror problem: `fireAt = wantCharge - 0.01`, so a bot asking for
exactly 0.70 arms at 0.69 and releases at **tier 0** — which pushes the pass disjointness above
slightly *further* apart. Split the strip case from the knockback case.

### P0 · `bot-ai.js:3124` — bots cannot fire a quick shot at all
`return { hold, fire, aimed: fire, … }`. Every bot bullet is an aimed shot, by construction. The
comment explains why, and for a strip it is right. But it means an entire family of mechanics is
**player-only and unreachable by any bot**:

- **slow stacks** (`SLOW_PER_STACK 0.12` × 3 = −33% speed) — `addSlowStack` is only reachable from the `!pr.aimed` branch;
- the **⅓ super partial** — bots can only ever earn super from a full hit;
- consequently **the whole "quick-tap to load super" idea is unimplementable today** (this is why rule R3 below was refuted).

Not necessarily a bug — but it is an undocumented capability gap between bot and player, in the
player's favour, and it should be a deliberate choice rather than a side effect of one line.

### P1 · The wind-up is not owned by the branch that armed it
`finalize()` releases on `(p._charge >= c.fireAt && dThetaAbs <= c.tol)`. Your new `latchDead` checks
*target validity* (left the match, became ours, no sight and no memory) — good, and it covers part of
this. What it does **not** check is the tactical premise:

- **~70% of strip releases land on a target that no longer holds the ball** (68% at `normal`, 86% at `hard` in the first pass; an adversarial re-run with a live ball put it at 70% on both tiers). Robust and worth fixing.
  **But do not fix it by cancelling.** That was my first spec and its verifier killed it: the "wasted" shots carry **15–45% of every strip the rule actually delivers** (6/14 at normal, 13/29 at hard with a live ball), **1.5 enemy body hits per match at `OVERCHARGE_FULL_GAIN` 1.0 each** (cancelling measured **−1.25 to −1.46 supers earned per match**), 17–31 loose-ball nudges per 18 match-minutes, and 1.8 of 2.05 enemy built-wall kills per match. My claim that it "loses zero strips by construction" was **wrong** — the ownership test runs on the bullet's *arrival* tick, not the release tick.
  **Re-target instead.** At the release edge, if the latched victim no longer owns the ball, re-point at the new carrier, else the enemy nearest the loose ball, else any enemy on a clear lane — and only cancel when there is nothing to shoot at. The wind-up is already paid for.
- **17% of `normal` releases (41/247) go into a lane a wall has since blocked**, and 60 of 273 wind-ups had a wall **built during** them. That is the same defect as a bot shooting down its own team's fresh wall (measured wall lifetime **0.18s**, for a 15-second `BUILD_RELOAD` charge).
- `laneClear` is called with the target's **current** position while the shot is fired at the `leadAim` point — at **three** call sites (`:1631` clearMarker, `:1646` consumed by the press strip at `:1677`, and the same `lane` consumed by the cover strip at `:1982`). The lane test is answering a different question from the one the shot asks.

### P1 · `bot-ai.js` `botCanSee` has no wall line-of-sight test
`sim.js canSeeEnemy` calls `segBlockedByWall` twice; `botCanSee` does not call it at all. **Bots see
enemies straight through stone**, so "hide behind a wall" is worth nothing against them while it works
against a player. The screen-box fix landed; this half did not.

### P1 · `bot-ai.js:1210-1216` — the aim-point ladder is walls-only
`aimPoints = [centre, near post, far post]` filtered by `laneClear(..., {enemies: false})`. A **body**
never de-selects the centre, so `goalAimY` collapses to `GY` on every wall-clear lane and
`postFinish` can only fire when a *wall* blocks the middle.

Related, `:1292`: `cornerFinish` picks its corner from the keeper's `y` alone and never from the
shooter's side. Measured at 450px with a keeper at (1900,550): **near post 71-100%, far post 0-65%**,
and a keeper within 2px of the centre line flips the choice — 0% vs 88% on opposite sides of a 2px
boundary.

### P1 · `sim.js:1476` `explode()` — bullseye singularity
`const d = Math.hypot(dx, dy) || 0.0001;` then `ux = dx / d`. A blast landing on a body's exact
centre gives `ux = uy = 0`, so `t.kvx += ux * power` adds **nothing**: maximum power, zero knockback.
Measured — dead centre 0px of displacement, 0.5px off-centre 499px. **Perfect aim is punished.**

### P1 · `sim.js:1245` — a bullet-ball goal can never be credited
`clearKick(b)` nulls `b.lastKicker` on every bullet-vs-loose-ball strike, and `goal()` resolves the
scorer as `players[b.lastKicker]` falling back to `b.lastPlayer`. The goal counts on the scoreboard;
`stat.goals` goes to the wrong player or nobody. Only matters once bots take that shot — which they
never do today.

### P1 · `bot-ai.js:1625-1634` — `clearMarker` rests on a number that changed, and has no angle term
The comment says *"charge < FULL_CHARGE(0.85) can NOT detach our own held ball"* and then fires at
0.8. `FULL_CHARGE` is **0.70**, so 0.8 is a full shot and the stated invariant is false. No live harm
— the same-team skip in `updateProjectiles` is what protects the mate — but the safety argument is
not the thing providing the safety.

Worse, it has no angle term. Measured: the same bullet landing at **0° to the chaser's heading makes
them arrive 1.18s SOONER** (you pushed them where they were going); 90° is neutral (+0.10s); only
150–180° buys time (+1.60/+1.93s). The branch fires from wherever the support happens to stand, so
roughly half its shots are a gift.

### P2 · Smaller, all confirmed on `main`
- `bm.screenUntil` is **shared by two unrelated behaviours** — the body screen (mate-carrying branch) and the goal screen (enemy-carrying branch). Seven uses, no `bodyScreenUntil`/`goalScreenUntil` split. Possession flips several times a second, so a body screen leaks into a goal-screen walk and mis-tags it.
- `mem.push` is **written and never read** (2 occurrences: the comment and the write). `coopPush` spends a bomb charge rocket-jumping into space for a pass that will never be called — 2.5–5.3 times a match.
- `bushLove` is computed for every persona and **never read**. The `poacher` is just a low-aggro bot.
- `MIN_SEP` (320px, `:2629`) is **exactly** `COVER_STRIP` at the hard tier (`120 + 200×1.0 = 320`, `:1292`). The separation floor parks the shadowing support bot precisely on the boundary of its own strip gate.
- `cannonPlant` ends `return best || {…}` — every candidate inside the loop is screened by `launchCancelled()` but **the fallback is not**, so when all candidates are cancelled the caller plants a launch the sim will refuse.
- `opts.hold` in `finalize()` is dead at all call sites, so a bot parked on a bomb plant still reports `wantMove = 1` — which contaminates the pinned% metric the whole wall-jam hunt was judged on.
- `role.mode` (`:799`/`:831`) written every tick for both teams, read nowhere. `sitHash`/`decideAt`/`action` are `decisionHz` leftovers.
- `sim.js:834` `isTap = eff < QUICK_CHARGE` on a float-summed charge: 30 additions give `0.24999999999999997`, so asking for exactly 0.25 silently drops to the 64px dribble touch. *(The same trap does **not** exist at `FULL_CHARGE` — I checked.)*
- **`MAIN_FIELD` may be mis-authored:** the hard wall at `(1625, 550)` is a capsule from `(1625,400)` to `(1625,700)` — **exactly the 300px goal mouth**, 375px in front of the line. Measured, it blocks all 59 straight shots at the mouth from a representative spot; 50 of 59 score once a keeper is removed *and the wall is gone*. That is a level-design call, not a code bug, but no bot knows about it.

---

## 3. Corrections to my own earlier work

I got two things wrong and both are worth stating because they were in documents you may have read.

**Bullets have no range limit.** `PROJECTILE.ttl = 1.3s` is declared in `constants.js` and **never
read anywhere in `sim.js`** — a bullet is culled only when it leaves the pitch. Measured: a
zero-charge quick tap travelled **1836px over 10 seconds**. My earlier claim that "a quick tap flies
234px, a full bullet 936px" was inferred from the constants rather than measured, and it is wrong.
`BULLET_MIN_DIST` / `BULLET_FULL_DIST` are the same story: declared, imported nowhere — **there is no
point-blank rule**, despite `docs/MECHANICS.md` §3 describing one.

**`docs/MECHANICS.md` is stale in five places:** `shotPower 1850` (is 1400), `FULL_CHARGE 0.85` (is
0.70), `OVERCHARGE_BULLET_MUL 1.6` (is 1.4), the ultimate combo at "1842px / 92% of the field"
(re-measures at **1344px / 67%**), and §3's point-blank falloff.

---

## 4. The three facts that govern almost everything

If you take nothing else from this document, take these.

**1. A full-charge kick rolls 647px** on a 2000px pitch. `roll = 0.468 × (v₀ − 18)`,
`v₀ = shotPower(1400) × chargeMul`. Every "shoot at goal" decision is really a range decision, and
this is what makes §2's release-ladder bug the biggest single leak in the file.

**2. A carrier pops its own ball on any wall.** The ball is glued at `feet + aim × 58.25px` and
`sim.js:919` releases it the instant that spot touches a wall, with a lockout. **A gap a body fits
through is not a gap a carrier fits through.** You fixed the reactive half of this in `finalize()`'s
carry-aim deflection; the planning half is untouched — the nav grid inflates by the *body* radius
26.25, and **7.7% of the legs it calls walkable pop the carrier's ball** on MAIN_FIELD.

An adversarial re-run sharpened this into something important: **the ball is popped by the carrier's
AIM, not by its path**, and `bot-ai.js:1450` pins a dribbler's aim at the goal centre. So the right
predicate is over *(path, aim) jointly* — a per-leg geometric test is the wrong object.

**3. Bullets are unlimited-range with no falloff.** See §3. Among other things this means
`PRESS_RANGE` (160 + 300·AGG ≈ 400–505px) is leaving free strips on the table for no mechanical
reason.

---

## 5. Sixteen skills, measured

Full detail in `SKILL_CATALOGUE.md` beside this file, including every rule citation and counter-play.
Each was scripted in the real sim; the eight round-2 entries were then re-run by a second
investigator, and **three headlines did not survive** — the corrected numbers are the ones recorded.

| Skill | Verdict | The number |
|---|---|---|
| Cannon pass — mate's bomb flings the carrier, **ball attached** | ✅ | 582px bare → **763px** with stone 50px behind |
| Build-then-bomb — your own cannon wall | ✅ | 664 → **717px** |
| Long ball + rocket chase | ✅ | Beat a defender starting **560px closer** |
| Bullet-ball — shoot a loose ball in | ✅ | Scored from 130px; **0% of 10–65 chances/match taken** |
| Bomb clearance — lob beside a loose ball | ✅ | **199px** (99px if you plant at your feet) |
| Fragile-wall snipe | ✅ | 4 blocks gone for the cheapest shot in the game |
| Wide-angle finish | PARTIAL | Window **28.5°** dead-on at 500px, **16.5°** at 45°; the 51.6° release cone binds on only 4.2% of live releases |
| Passing with a kick | ✅ | **Every completable pass is a catchable one** |
| Snooker pass — hit the ball off-centre | ✅ mechanic, ❌ application | **45.0°** from an 8.32px offset — but **loses to walking**, 2.95s vs 1.08s, and reverses sign on a rolling ball |
| Anticipation wall | ✅ | Strips **on the tick it appears**; denial cut from 79% → **17–20%** vs a carrier who steers once |
| Anticipation lob | ✅ | **120/120** inside a 95–350px window; **13%** against a 45°/s arcing dribble |
| Bank off the stone | PARTIAL | **`atan(tan i / 0.62)`**, not a mirror. `goalBank` finds **0 in 1103** positions |
| Shoot them off the ball | ✅ | 343px of drift; **250px / 220px break-even** for a bot; ~**107px** on the real arena |
| Shield the carrier | ✅ | A **body** buys **+18.85s free**; the bullet +4.55s for 1.42s; three quick taps **0.00s** |

---

## 6. The user's six new rules — what survived being attacked

Six specs, then six adversarial re-runs. **All six were refuted *as specified*** — every one of them
works in principle and not one survived its own constants. The primitives are sound;
the gating was not. Detail in `research/rules3.json`.

| Rule | Spec said | Verifier said |
|---|---|---|
| **R1** Contest the ball, shoot the approacher | Ungated it is worth **+0.7%** (nothing) with a −326px worst case; gated it fires on 13% and is **+366 possessions, zero losses** | **Fixable, not dead.** The release-clock frontier held across seeds, ±20% distances, grid shifts and rotations. 100% of the ungated rule's losses are one failure: **the bullet ate the loose ball** |
| **R2** Full shot to strip | **68%/86%** of strip shots land on a target that no longer has the ball; cancelling cuts 247→58 releases and lifts the hit rate 46%→69% | **Keep the bug report, do not ship the rule.** The defect is real (70% on both tiers with a live ball) but **cancel is the wrong repair** — those shots carry 15–45% of the strips, 1.5 body hits/match of super earnings, and most of the enemy wall kills. **Re-target, never cancel.** |
| **R3** Quick-tap to load super, then spend it | The "closer enemy" clause is unnecessary — tap the **carrier itself**; battery-then-**body-strip** is ~1.2s faster than the direct strip at every distance | **Refuted — unimplementable today.** `aimed: fire` means no bot can fire a quick shot at all. Salvage one part, heavily re-gated |
| **R4** Bomb-travel when the ball is far | Beats walking to a **seen** target from 500px; at a believed-but-unseen target the belief is a mean **365px** wrong by landing, wiping the gain | **The DEAD half is right and strengthened.** The ship half needs different constants; `D*` proved insensitive to the control knob they worried about |
| **R5** Precomputed attack corridors | **7.7%** of body-walkable legs pop the carrier's ball; corridor reaches goal in **12.43s** vs nav 14.23s vs straight line **0 goals in 17** | **Recall 100% survives** on seeds 991/4242 and on ±20%-deformed arenas. But the predicate is the wrong *object* — it must be over (path, **aim**) jointly |
| **R6** Defend the best corridor | One 64px cell covers **88–100%** of the enemy's scored lane weight; bottleneck+keeper took 22 possessions from 6/22 turnovers to **12/22** at identical goals conceded | **Do not ship as a bot rule** — 74% of its "bottleneck" assignments fell through to a hardcoded spot and the target was exempt from `MIN_SEP`. **But the geometry survives as a level-design finding** |

**Three things from R6 worth keeping even though the rule is withdrawn:**
1. **`MAIN_FIELD` lane weight is pathologically concentrated.** 17.40 of team A's 25.35 total lane weight (**69%**) funnels into the single terminus `(1456, 208)`; team B's into `(1120, 288)`. That is a map fact nothing in `bot-ai` knows.
2. **A defender's coverage radius is its STRIP range, not its body.** Body-only delay is ≤ +0.48s at any offset from 0 to 520px. Any future defensive positioning should score *"cells I can shoot the lane from with line of sight"*.
3. **A clean negative — believe this one:** a wall at a tight bottleneck denies **57%** vs **56%** in the open. **Do NOT gate the wall plays on a bottleneck map.** I expected the opposite and was wrong.

---

## 7. Measured and refuted — please do not re-propose

To add to your §4:

- **Slowing a chaser with quick taps.** +0.00s at starting gaps of 160/260/400/560px, for the whole mag. `SLOW_STACK_DECAY` runs on a clock a new hit does not refresh. *(And bots cannot fire quick shots anyway — see §2.)*
- **The snooker pass as a pass.** Loses to the receiver simply walking to the ball, 2.95s vs 1.08s, and reverses sign on a rolling ball.
- **"The 26° release tolerance is why bots miss."** It binds on 4.2% of 591 live releases and on 1 of 69 makeable shots. The range gate is the real cause. *(This was my hypothesis and it was wrong.)*
- **Ammo starvation.** 0% of press chances lost to an empty mag, at both skills measured.
- **Role thrash.** 7–9 `onBall` switches per 60s match; the hysteresis works.
- **Gating wall plays on bottlenecks.** 57% vs 56%. No effect.

---

## 8. The instruments, if any are useful to you

All in the worktree's `research/`, all seeded:

| File | What it answers |
|---|---|
| `decision-audit.mjs` | **When a good play was available, did the bot take it?** Opportunity counters — a big number is a missing capability, not a threshold to nudge. |
| `trick-lab.mjs` | Does this skill work? Scripted with hand-authored inputs of exactly the shape `finalize()` emits. |
| `record-plays-2.mjs` / `-3.mjs` + `scene-*.mjs` | Per-tick recordings of each play, one scene per file — which is what let eight investigations run in parallel without touching one file. |
| `corridors.mjs` + `corridors-README.md` | Carrier-aware corridor scoring. Read §6's R5 row before trusting the per-leg predicate. |
| `probe-S*.mjs` / `rule-R*.mjs` / `refute-*.mjs` | One measurement rig per finding, plus the adversarial re-run of each. |

Two artifact pages are published from the recordings (round 1 and round 2), plus a third for the
rules; the user has the links.

---

## 9. What I did not do, and where I was wrong

- **Nothing is implemented.** No bug in §1 or §2 is fixed, no skill in §5 is built, no rule in §6 is coded. I stayed out of `shared/` entirely because you were live in it all session.
- **I did not re-measure any of this on `main`.** The *code claims* in §1 and §2 are re-verified against `main`; the *magnitudes* were measured on my 27-commit-old fork. Anything you act on should be re-measured on HEAD — your own round-9b autopsy (86% → 70% once the other agents' work landed) is the reason, and it is the sharpest process lesson in either handoff.
- **My worktree predates your vision and wall-aim fixes**, so two of my agents' reports about them were stale. I caught both by hand; there may be others I did not think to check.
- **I got the bullet range wrong** by reading constants instead of measuring, and it propagated into two documents before a subagent caught it.
- **All six rules were attacked, and all six were refuted as specified.** Not one survived its own constants. The primitives are sound; every set of thresholds needed re-deriving. If there is a single lesson in round 3 it is that: the rule was never the hard part, the gate always was.
- **The ladder is untouched.** Every item in §6, and the pass fix in §2, changes how often a bot wins the ball, so every one moves the difficulty ladder. `SEEDS=6` on `test-bot-ladder.mjs` before believing any of it — and your handoff already records that its spread gate has no headroom left.
