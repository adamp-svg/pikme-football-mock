# Bot AI — full handoff

**Written 2026-07-26 by agent `bot-fix`, at the end of a ~10h session.**
Audience: the next agent(s) picking up bot work. Read §00 and §0 before touching anything.

---

## 0000000. ROUND 9 (2026-07-26 15:0x-17:3x, agent `pass-direction`) — THE RECEIVER WAS ON A CARROT AND A STICK

Requested, from a tracked L10 run: *"the friend sometimes goes the other way"* (22.1% of support ticks
running away from the goal its own team is attacking) and *"the enemy shoots the other way"* (19.4% of
shots, the biggest slice `[passLatch]` releases aimed **91-109 degrees** off the enemy goal).

### New instrument: `bot-support.mjs`

Measures the DECISION, tagged by the branch (`bm.lastTrick`) that made it, so a percentage points at
code. Defaults to the real L10 pair from `shared/difficulty.js` (partner 0.42 vs enemy 0.93) and
reports both teams. Two things in it are worth reusing:

* **`awayNoDetour%` — always read this one, not the raw `away%`.** `bm.wp` is set only while the flow
  field has overridden the straight line, so it separates "the branch chose a backward target" from
  "the bot is walking round a capsule". **87-91% of the raw number is the second thing.**
* per-team numbers are useless at this sample size. The sim diverges chaotically, so which team ends
  up doing the passing flips between builds; the tracker prints a BOTH TEAMS aggregate for that reason.

### The `[none]` slice is NOT a bug — measured, and it is the answer to "which support logic is wrong"

Of the untagged (plain support / outlet / cover) away-ticks: **navDetour 91% at skill 0.42 and 87% at
0.93**, `behindCarrier(shape)` 7-12%, MIN_SEP 1-2%, `pastOutletLine` ~0%. That is arithmetic, not
opinion: the support target is `ahead = egX -/+ 300`, i.e. 300px from the ENEMY goal, so it is
maximally forward by construction, and MIN_SEP can only relocate it backwards when the carrier is
deeper than that line — which is the ~0% case. The loose-ball `fastBreak` "stay home" branch and the
3v3 cover lane cannot appear here at all (one needs a loose ball, the other needs a third bot).
**Nothing in that slice was changed. There is nothing there to fix.**

### The real bug was one line, and it was not the 90px

`receivePass` computed `want` from the receiver's **LIVE** position every tick: 90px behind wherever it
had just got to, re-issued ~50x a second for the whole 1.4s call. A carrot on a stick. The receiver
did not check back 90px, it **RETREATED CONTINUOUSLY** — up to ~210px at walking pace — and the latch,
which re-aims at the receiver's led position each tick, followed it backwards. Both reported symptoms
are that one bug seen from the two ends. Confirmed before touching anything: the receiver was already
AHEAD of the carrier on **88%** of those ticks.

Fixed by choosing the rendezvous ONCE per call and holding it as an **absolute** spot (`bm.recvSpot`),
which may never lose ground toward the enemy goal; if the clamp eats the whole run (receiver directly
in front of the carrier) it shows sideways rather than freezing. Plus a latch abort on the pass
**BEARING** (`PASS_BACK_COS`, ~100deg) that hands the carrier a fresh decision.

| L10, 12 x 60s, 3 seed bases | before | after |
|---|---|---|
| support running away from the attack | 28.7 / 18.9 / 20.1% | **22.1 / 19.2 / 20.3%** |
| ...excluding flow-field wall detours | 7.4 / 4.6 / 6.6% | **5.0 / 3.9 / 5.9%** |
| `receivePass` share of that | 60% | **21%** |
| of >90deg latch releases: mate was BEHIND me on the attacking axis | 44 / 50 / 13% | **0 / 0 / 0%** |
| ...and their mean receiver bearing | 118 / 123 / 97deg | **87 / 88 / 89deg** |
| pass completion (`bot-passes`, 60 matches) 0.42 / 0.93 / 0.50 | 86 / 90 / 94% | **95 / 92 / 93%** |

The bearing column is the useful one: what is left past 90deg is a SQUARE ball pushed over the line by
`leadAim` + the aim slew, not a backward pass. Square balls are ~58% of every release in this game and
were deliberately left alone.

### THREE THINGS MEASURED AND REFUTED — do not re-propose

1. **A DISTANCE-based abort** ("drop the latch once the receiver is further from the enemy goal than I
   am, plus a small tolerance"). This is the obvious reading of the bug and it **cost 81% of all
   passes** — latched releases 197 -> 37 per 12 matches at skill 0.42, total releases 270 -> 104.
   The common case is not a receiver drifting back, it is **the CARRIER DRIVING FORWARD past its own
   outlet during the wind-up**, which trips a distance test every time while the pass is still a good
   square ball. Note the geometry that makes the bearing test safe instead: `passWorthIt`'s radial gate
   is provably under 90deg at the call (if `|R-G| < |P-G|` then `(R-P)·(G-P) > |R-P|^2/2 > 0`), so a
   called pass never starts out aborted and the two gates cannot fight.
2. **The never-backwards clamp WITHOUT latching the spot first.** As a two-line clamp on the old
   per-tick target it reproduced in full: **86% -> 72% of passes reaching a team-mate at 0.93, and 37%
   of all pass releases gone.** Mechanism, and it generalises to anything that moves a bot the carrier
   is aiming at: **closing straight along the pass line is ANGULARLY STATIONARY from the carrier's
   point of view**, so its slewing aim converges and `fire` passes its `|dTheta| <= tol` gate. Clamp
   one axis of a target that is re-derived every tick and the receiver sweeps sideways forever, the aim
   never settles, and the wind-up times out on `windupBudget`. Latch the spot first and the same clamp
   is nearly free. **A bounded run is what a human does; an unbounded one is what broke the aim.**
3. **A tier-scaled "pick the OPEN lateral lane" for the receiver** (openness vs visible enemies +
   `laneClear`, gated `skT >= 0.55`, committed per call). Built specifically to give §00000 its tier
   differentiator, and it measured **EXACTLY neutral** — 84%/90% completion and identical release
   counts with it and without. Deleted rather than kept as dead complexity. The old per-bot latched
   side (`bm.recvSide`) is still there and still right: "a committed side, so it doesn't dither".

### The interaction that wrecked a match, and the two lines that fix it

The abort and the receiver fix were each harmless alone (abort alone at skill 0.42: touches 17.9, ball
loose 69.7% — indistinguishable from before) and **together they destroyed the game**: touches 18 -> 9,
shots 41 -> 13, ball loose 69% -> 85% of the match and **320px** from the nearest player, reproduced on
three seed bases. Cause: `bm.carryT` had been running for the whole wind-up, so `carryT > CARRY_IDLE`
was already true, and `bm.charging` still held the pass's low `fireAt` — so the abort did not "fall
through to the forward options", it fell through to the LAST rung and fired a forward CLEARANCE on the
very next tick, every time. `bm.carryT = 0; bm.charging = null` on abort is the whole fix. **A bad pass
should cost nothing: a player who looks up, sees it is not on and keeps dribbling has not lost a thing.**

### Honest cost, and the ladder warning

The carrier now clears forward where it used to square it to a mate who had fallen behind:
`advancePerRelease` 68 -> 119px (a round-7 goal) but `backwardReleasePct` 8.5 -> 17.5% (a round-7
anti-goal) and shots/match 37.9 -> 28.6 at L10. Measured separately, **that is the RECEIVER fix, not
the abort**. `touchesPerMatch`, `loosePct` and `ballGapPx` are flat. Caveat on that metric: in the
UNCHANGED build `backwardReleasePct` at skill 0.93 ranges **9.8% to 39.8%** across five seed bases, so
its noise floor is enormous — do not read a single run of it.

**BOTH CHANGES ARE SKILL-INDEPENDENT. No tier scaling ships** (see refuted item 3 for the one that was
tried). §00000 is explicit that this is what flattened the ladder twice, so the ladder wants a look
before this is trusted at the top tiers.

### Suite

69 pass. `test-bot-ladder.mjs`, `test-bot-partner.mjs` and `test-rank-parity.mjs` fail — **all three
also fail on pristine HEAD**, verified in a separate `git archive` checkout, so zero new failures.
`test-rank-parity.mjs` is new to this list and is nothing to do with bots.

---
## 000000. ROUND 8 (2026-07-26 15:0x-, agent `wall-windup`) — THE L10 "IDLE" WAS THE THRESHOLD, NOT THE BOTS

Requested: *"there are still idle moments"* at difficulty 10, with round 7's attribution pointing at the
wall wind-up (67% of stationary episodes) and an untagged "blocked" slice (28%).

### READ THIS BEFORE YOU CHASE BOT IDLE AGAIN. THE NUMBER WAS AN ARTEFACT.

`bot-idle.mjs` counted a bot as **stationary below 1.2 px/tick**. Do the arithmetic the file never did:

| | |
|---|---|
| full-speed walk | `CHARACTERS.player.speed 158 × settings.speedMul 0.9 = 142.2 px/s`, `MOVE_ACCEL 1` (velocity snaps) → **2.37 px/tick** at DT 1/60 |
| wall wind-up | `BUILD_WINDUP_SLOW 0.5` (`sim.js:715`) → **1.185 px/tick** |
| the old "stationary" cut | **1.2 px/tick** — 0.015px above the wind-up crawl |

Measured, L10 (partner 0.42 / enemy 0.93), 8 × 60s, MAIN_FIELD: while `buildHold` the displacement is
**1.18 / 1.19 / 1.19 px/tick at p10 / p50 / p90** and `mean|move| = 1.00` — a *perfectly flat walk at
half speed with full move intent*, not a stall. Threshold sweep, episodes ≥0.3s per match:

| cut | total | buildHold | blocked | bombHold |
|---|---|---|---|---|
| 1.5px | 4.63 | 2.38 | 2.13 | 0.13 |
| **1.2px (old)** | **3.25** | **2.25** | 0.88 | 0.13 |
| 1.0px | 0.38 | 0.00 | 0.25 | 0.13 |
| **0.8px** | **0.00** | **0.00** | **0.00** | **0.00** |

**No bot at L10 is stationary for 0.3 s.** And the slow is not a bot handicap — `sim.js:715` is
player-agnostic, so a human winding up a wall crawls at exactly the same 1.185 px/tick. The only
levers on it are `BUILD_WINDUP` / `BUILD_WINDUP_SLOW`, which change the rule for human players too:
that is a design decision for the user, not a bot fix.

`bot-idle.mjs` now defaults to `STOP_PX 0.8` (sweepable), carries the arithmetic in its header, and
prints a separate **SLOWED but walking** report so the crawl can never be mistaken for a stall again:
carrying the ball **15.9 s/match** · rubbing along geometry/bodies **11.5 s/match** · wall wind-up
**1.5 s/match**. STOPPED is 0.89% of bot-ticks, longest stopped run **0.28 s**.

**The 28% "blocked, no tag" slice, re-measured under 1.0 px/tick:** 1.90 s/match total —
**51.6% knockback fighting the move** (the bot is being blasted; correct behaviour), 33.5% enemy
body, 10.9% mate body, 1.1% unexplained — and only **0.38 episodes/match ≥0.3 s, all knockback**.
Round 6 took mate-body blocking from 28.6% of stuck ticks to a tenth of a second per match. There is
nothing left in that slice.

### The real bug that was hiding under the phantom: THE WALL'S AIM NEVER LATCHED

`bm.buildHold` stored a `dist` and nothing else — `bm.buildHold.x/y` was written by five branches and
**read by no one**. The wall is placed by `wallPlacement(p.x, p.y, p.aimX, p.aimY, p.aimMag)` at the
COMMIT tick, and by then a *different* branch owns the aim: `blockDrive` arms `bm.buildHold` and
`bm.trap` on the same tick, so from the next tick the bot is in the `else if (bm.trap)` burst-and-strip
branch, aiming at the carrier. Per-tick tags over one wind-up: **blockDrive 10 ticks, ambushStrip 260**.

| at commit | aim drift | placement error |
|---|---|---|
| `blockDrive` | **38°** median | 43px median, **152px** max |
| `ambushWall` | 17° | 23px |
| `catapultWall` | **116°** | 115px |
| `deflectSetup` | 2° | 29px |

So the branches that returned `finalize(p, {x: p.x, y: p.y}, ...)` — pinning themselves to their own
feet *"so the wall doesn't move"* — were paying `BUILD_WINDUP_SLOW` for nothing. The wall moved.

**Fix, all in `finalize()` plus the five arming sites:** latch `wx`/`wy` (the wall's world centre) and
the normal; re-derive `buildDist` from the LIVE position every tick, exactly as the client's drag
ghost does; let the latched normal own the emitted aim for the wind-up and the commit; never commit a
wall on a tick the bot also fires (`p.aimX` is one field serving both the bullet/kick and
`wallPlacement`) with a 0.25 s cap so the deferral can't hang; drop the wind-up the instant this bot
owns the ball (same invariant as `bombHold` — a carrier can never build, and the aim latch would
otherwise point a *carrier* along a stale wall normal); and LEASH the steering target into the window
where the wall still lands, for the tiers whose `wallReach` has push distance to give.

**Outcome — the metric that matters is the ANGLE, because these walls exist to SPAN a lane** (24
matches × 60s, L10):

| | HEAD | after |
|---|---|---|
| walls raised vs an enemy carrier | 11 (of 52 builds) | **32 (of 94)** |
| miss from perpendicular-to-the-lane | **22° median, 63° p90** | **4° median, 5° p90** |
| within 30° of spanning the lane | **64%** | **100%** |
| commit aim drift | 38° / 116° | **0°** |
| wall builds per match | 2.2 | **3.9** (UP — this is not idle removed by never building) |

`bot-feel`, paired seeds against a pristine `git archive HEAD` copy, 3 seed bases × 12 × 60s, at skill
**0.93**: worst jam 0.68 → 0.59 s · jams>0.5 s 0.14 → 0.11 · reach-timeouts 4.00 → 3.61 ·
**backward releases 24.7% → 17.9%** (round 7's open item 3) · touches 21.6 → 22.3 · goals 1.86 → 1.78.
At skill 0.50 every delta sits inside the band `CLAUDE.md` records for this instrument (identical code
has reported pinning 0.27–0.51%).

### MEASURED AND REFUTED THIS ROUND — do not re-propose

- **ABORT a wind-up whose wall is no longer wanted.** Obvious, free (the charge is spent inside
  `buildWall`), and it destroyed the play: **every** `ambushWall` hold aborted (0.88 arms/match, 0.88
  aborts, **0 commits**) and wall builds fell **1.75 → 0.38/match**. Cause: the trap strips the ball it
  was walling against, our team then owns it, and `wallSpotOk`'s own-lane test flips — *the trigger
  destroys its own precondition*, the same shape as `doubleBomb` in §4.
- **GATE the arm on already standing on the build ray** ("walk to the spot, wind up on arrival").
  `blockDrive` went **1.25 → 0.13 arms/match**: its stand spot is recomputed from the carrier's LIVE
  position every tick, so the bot chases a target that moves. That is the walk-to-a-pad autopsy from
  §0000 for the **third** time in this file. A LEASH works where a gate does not: nothing to miss,
  nothing to cancel.
- **LEASH every tier.** Below `T_FAR_WALL` (0.82) `wallReach == BUILT_WALL.offset`, so the along-window
  collapses to a single distance and the leash is a 60px arc — a freeze in all but name. Skill 0.50:
  worst jam 0.97 → 1.61 s, pinned 0.37 → 0.49%, idle-with-ball 1.12 → 1.51%. Gated on the freedom
  existing, skill 0.50 movement is unchanged and only the orientation is fixed.

### A THIRD instrument is now past its noise floor: `test-bot-cannon`'s agreement gate

The suite came back `68 pass / 4 fail` and one of them, `test-bot-cannon`, passed on pristine HEAD and
failed with this round's change — so I chased it instead of shipping it. `measureLevel` takes a 4th
`seedBase` argument, so the gate can be swept. On an **unmodified `git archive HEAD` tree**, same
10 matches × 3 levels × 2 sides, eight seed bases:

`88% (14/16) · 71% (5/7) · 88% (7/8) · 88% (7/8) · 80% (4/5) · 63% (5/8) · 76% (13/17) · 86% (6/7)`

**HEAD fails its own `agreement >= 75%` gate at 2 of 8 seed bases.** `cannonChance` fires only 5-17
times across 30 match-halves, so one missed chance moves the ratio 6-14 points. Pooled: HEAD
**61/76 = 80%**, this round's build **61/83 = 74%** — a 6.8pp difference against a ~4.7pp binomial SE
at n≈80, i.e. **inside one standard error**. The threshold was NOT lowered; (i) is now a PRINTED
TRIPWIRE with that spread quoted next to it, which is the same call §3 records for `test-bot-ladder`'s
shot count and possession and the same call round 6 made for this test's own *absolute* rate. The
gates that actually carry the cannon fix — the five sim fixtures, the fixture that proves a boosted
launch, and "boosts are DECIDED, not accidental" — are untouched and still pass.

That makes **three** instruments in this repo now known to be at or past their resolution limit:
`test-bot-levels` (§3), `test-bot-ladder`'s axis rho (§00000), and `test-bot-cannon`'s agreement. The
pattern is always the same — a rare event divided by a small denominator — and the answer is always
the same: sweep the seed and pool, or print it instead of gating it.

**Wall builds were checked against exactly the "did you fix idle by never building?" trap**, using
`p.stat.walls` (incremented inside `buildWall`, so it is exact — my group-diff counter undercounts
because `MAX_BUILT_WALLS` evicts groups). Four seed bases, 12 × 60s at L10:
HEAD 2.42 / 3.92 / 3.67 / 3.33 → mean **3.34**/match; after 3.08 / 3.92 / 3.08 / 4.50 → mean
**3.65**/match. **+9%.** The bots build as often as before and every wall now spans what it was aimed at.

### Open after round 8

1. **The defensive wall plays place their wall AFTER the situation has ended.** Of 52 builds at HEAD
   only 11 went up while an enemy still carried the ball (94 → 32 after the fix, so it improved, but
   it is still a third). The 0.6 s wind-up outlives a possession whose median length is ~0.87 s. Worth
   a look: arm earlier off a *predicted* drive, or accept that the wall is a delaying line rather than
   a tackle.
2. `idleBallPct` reads consistently higher after this round (0.78 → 1.05% at 0.93, 1.12 → 1.79% at
   0.50) across all seeds. The one mechanism I could name — a stale wind-up surviving a pickup — is
   now closed and the number did not move, so this looks like chaotic re-rolling rather than a code
   path. It is ~1% of a match; worth confirming with more seeds before anyone spends time on it.
3. Round 7's open items 2 and 3 are unchanged and are the honest remaining answer to "the bots look
   idle at L10": at skill 0.93 the ball is loose ~71% of the match, `notClosingPct` is ~45% and there
   are ~3.6 "nobody reached it in 4 s" events per match. **A bot walking away from a loose ball looks
   exactly like a bot standing still, from the player's chair — and that one is real.** It is not a
   wall problem and it is not measurable with `bot-idle.mjs`.

---
## 00000. ROUND 7 (2026-07-26 14:1x-, agent `bot-review`) — REWARD SHAPING: move the ball forward, and fetch it

Requested: *"prioritize and reward behaviour which pushes the ball further towards the enemy goal...
reward their own movement, so a stuck bot, or a bot which travels further from the ball when the ball
is nearest to it, should be less rewarded (unless doing a trick, hiding in bushes or something).
Usually if the player is near the ball he should either go fetch it or try to shoot it to make it go
closer to the enemy goal."*

### Both behaviours were measured first, and both were as bad as he thought

Two new metrics in `bot-feel.mjs`:

| | skill 0.50 | skill 0.93 |
|---|---|---|
| `advancePerRelease` — ground the ball gains toward their goal, per release | **4px** | **10px** |
| `backwardReleasePct` — releases that end up BEHIND where they started | 8.0% | 15.4% |
| `retreatWhileNearestPct` — nearest player to a loose ball, walking AWAY | **23.2%** | **26.2%** |

4px per release is "the kick moved the ball nowhere". The bots were optimising for possession they
could not use, because holding-and-sliding scored better than putting the ball up the pitch.

### Three rules, and the result

1. **`clearForward`** — a new rung in the release ladder. No shot, no smashable blocker, no forward
   mate => pick the most goalward direction whose BALL LANE is clear **for the whole roll** (not for a
   nominal reach — that bug let the ball sail into a wall just past the checked segment), refuse any
   landing spot within 200px of an opponent, and put it up the pitch.
2. **No backward outlet.** The ladder's outlet pass asked ONLY for a clear lane, so it played the ball
   to a mate standing behind. That was the biggest single source of backward releases. The receiver
   must now be no further from the enemy goal than the carrier — lateral yes, losing ground no.
3. **`fetchBall`** — after every branch has picked a target, a bot that is the CLOSEST player to a
   loose ball and whose target points away from it gets the ball as its target instead. The user's
   exemption is explicit in code (`FETCH_EXEMPT`): bomb fuse, wall wind-up, catapult, kick-and-fly,
   bush ambush/trap, called pass, active dodge and the committed wall plays may all walk away.

**16 matches x 60s, paired seeds:** advance per release **4 -> 29px** (0.50) and **10 -> 176px**
(0.93) · backward releases **8.0% -> 3.7%** (0.50) · retreat-while-nearest **23.2% -> 15.1%** (0.50),
26.2% -> 25.4% (0.93) · jam/idle held (pinned 0.26%, worst jam 1.03s, idle-with-ball 0.76%).

### Refuted, recorded here so it is not re-proposed

**Gating the forward clearance on "only under pressure"** (an enemy within 300px or the carry clock
running out). It looks obviously safer — a clearance is a last resort, surely — and it measured WORSE
at everything the request was about: advance per release stayed at 4px, retreat-while-nearest got
worse (23% -> 29%), touches fell 27% and the ball was loose 8 points more of the match. The ladder
POSITION is already the gate: that rung only runs after ~0.4s of holding with nothing on.

### THE LADDER COLLAPSED, AND THE FIX IS THE FILE'S OLDEST LESSON

Round 7 as first written shipped `clearForward` and `fetchBall` with **one quality for every tier**,
and the ladder came back:

| | round 6 | round 7 (ungraded) | gate |
|---|---|---|---|
| rho (goals) | 0.80 | **0.10** | >= 0.85 |
| top-vs-bottom spread | 1.10 | **-0.04** | >= 0.60 |
| top beats bottom | yes | **NO** (-0.41 vs -0.37) | — |
| strips rho | 1.00 | **1.00** | — |
| harness zero-check | -0.01 | **0.18 (out of tolerance)** | +-0.15 |

Per-seed rho went 0.50 / 0.30 / 0.60 / 0.00 / -0.30 / -0.50 — goal differential had become almost
random across tiers, while STRIPS still ranked perfectly (1.00 -> 6.39). So the strong bots were still
strong defensively; what vanished was their attacking edge.

**Cause, and it is the same one as the pass latch in §5.2:** "hoof it up the pitch" and "always go and
get the ball" are **skill-INDEPENDENT** actions. Handing them to every tier gave the bottom the ground
the top used to have to earn with possession play. *Making a useful action equally reliable for
everyone deletes a differentiator the ladder was leaning on.*

**Fix — same verb, tier-scaled EXECUTION** (the model this file already prefers):
* the clearance's "don't hoof it onto a defender" veto scales `60 + 200*t` px, so a weak bot really
  does clear it to an opponent's feet while a strong one only accepts space;
* the fetch override only fires inside `300 + 900*t` px, so a weak bot simply does not notice a ball
  it is nearest to across the pitch.

Measured after: retreat-while-nearest now **45.6% at t=0.05 · 16% at 0.50 · 25% at 0.93**, i.e. the
behaviour itself became a ladder, and skill 0.50 keeps the round-7 wins (advance/release 27px,
backward releases 3.6%).

### PATIENCE ABOVE t=0.62, and an honest correction about what proves a ladder

The graded version STILL measured rho 0.10 / spread -0.03, and the run said something specific:
**strips ranked perfectly (1.01 -> 6.50) while every tier's goal differential was negative.** Strong
bots were winning the ball and then hoofing away possession they could convert. So above **t = 0.62**
the forward clearance became what it is for a good player — something you do under PRESSURE or against
the carry clock, not your first idea. Below that gate it is unchanged: a weak bot boots it forward
instead of dithering, which is the requested behaviour and the reason it exists.

Measured, symmetric matches, 12 x 60s: at skill 0.93 the top tier's ball-loose time fell **78.3% ->
68.3%**, touches 21.8 -> 24, worst jam 2.67s -> 0.73s, reach-time 1.15s -> 0.86s. The ladder test's
**"top beats bottom" gate flipped to PASS** (-0.28 vs -0.40) and the spread moved -0.03 -> 0.11.

**CORRECTION, and it matters for anyone reading numbers out of `bot-feel.mjs`:** its `goalsPerMatch`
is the **combined** score of BOTH teams in a symmetric match. So the 0.17 / 1.00 / 2.08 progression
across skill 0.05 / 0.50 / 0.93 is the SCORING RATE of the match (high-skill games are more open), not
a difficulty differential — a symmetric match cannot show one by construction. Only
`test-bot-ladder.mjs`, which plays each anchor against a fixed reference, can. Do not quote
`goalsPerMatch` as evidence that a tier is stronger; this session did, once, and it was wrong.

### THE LADDER INSTRUMENT IS NOW AT ITS RESOLUTION LIMIT — this is the open decision

Three runs at `SEEDS=6` (192 matches/anchor) across rounds 6-7:

| | rho (goals) | spread | top>bottom | strips rho | zero-check |
|---|---|---|---|---|---|
| round 6 (gates spread) | 0.80 | 1.10 | PASS | 1.00 | -0.01 |
| round 7 ungraded | 0.10 | -0.04 | FAIL | 1.00 | **0.18** |
| round 7 graded | 0.10 | -0.03 | FAIL | 1.00 | **0.16** |
| round 7 + patience | 0.10 | 0.11 | **PASS** | 1.00 | **0.16** |

Per-seed rho on the last run: 0.70 / 0.30 / 0.60 / -0.60 / -0.50 / 0.10 — the sign flips with the seed
base. And the **HARNESS ZERO-CHECK has been out of tolerance (0.16-0.18 vs +-0.15) ever since round 7
landed**: that gate measures the t=0.50 anchor against its own mirror, where the true answer is 0.00,
so the instrument is telling us its own noise floor is exceeded. §3 already recorded this exact limit
for `test-bot-levels.mjs` ("gating them is a red/green light driven by the RNG, and chasing it produced
two bad re-cuts before I stopped"); the new behaviours have now pushed the AXIS test into the same
regime, because a forward clearance turns a possession into a scramble and scrambles are high-variance.

**STRIPS still rank 1.00 at every single run**, which is the low-variance evidence that the skill axis
itself is intact. What cannot currently be resolved is goal differential.

So the next agent has three honest options, and it is the user's call, not a tuning problem:
1. **Raise the sample** — the axis test needs far more than 192 matches/anchor to resolve ~0.1-0.2
   goals/match against a 0.3-0.4 noise floor. Cheapest correct answer; costs wall-clock, not design.
2. **Re-cut the 12 levels** against the new bots (pending since round 5 anyway).
3. **Revert the reward rules** — they do exactly what was asked on their own metrics (advance per
   release 4 -> 27px, backward releases 8% -> 3.6%, retreat-while-nearest 23% -> 16% at skill 0.50)
   and they are the thing that pushed the instrument past its floor.

> ⚠️ **Option 1 was measured and it is WRONG — see §00000b immediately below.** The instrument is not
> blind and more matches do not bring the ladder back: at 1152 matches/anchor the ordering is
> *resolvably* non-monotone. Read §00000b before acting on the three options above.

---
## 00000b. THE INSTRUMENT, MEASURED (2026-07-26 15:0x-15:4x, agent `bot-noise`) — it is NOT at its resolution limit

The section above concluded "the instrument is telling us its noise floor is exceeded". Half of that
is right and the important half is wrong, and both halves are now measured rather than argued.
New instrument: **`bot-noise.mjs`** (`collect` writes one JSON row per match, `analyze` reads them
back), which replays `test-bot-ladder.mjs`'s configuration EXACTLY — verified by replication: on the
committed round-7 bots at bases 1000-6000 it reproduces the recorded run digit for digit (goals rho
**0.10**, spread **0.11**, top-beats-bottom -0.28 vs -0.40, zero-check **0.16**, per-seed-base rho
**0.70 / 0.30 / 0.60 / -0.60 / -0.50 / 0.10**). Everything below is 9600+3840 matches on the
**committed** `shared/` (HEAD `68a1161`, `bot-ai.js` unchanged since `2d7e689`), default arena, 60s.

### 1. The noise floor, and the sample size it implies

Null configuration (t=0.50 vs t=0.50, true value 0.00), 1536 matches: **per-match SD 1.78 goals**,
mean +0.02 +-0.05. Cell SE is 1.78/sqrt(n):

| n/anchor | SEEDS at PER=32 | SE | 95% band | 0.10 goals/match is | serial | 16-way sharded |
|---|---|---|---|---|---|---|
| 32 | 1 | 0.31 | +-0.61 | 0.3 sigma | 1 min | — |
| 192 | 6 | **0.13** | +-0.25 | **0.8 sigma** | 5 min | 1 min |
| 384 | 12 | 0.09 | +-0.18 | 1.1 sigma | 10 min | 2 min |
| 1152 | 36 | 0.052 | +-0.10 | 1.9 sigma | 31 min | 5 min |
| 1248 | 39 | 0.050 | +-0.10 | **2.0 sigma** | 34 min | 5 min |
| 2816 | 88 | 0.033 | +-0.07 | 3.0 sigma | 77 min | 12 min |

**A match costs 0.27s serially** (measured, 60s match, one process). The "a SEEDS=6 run takes ~20
minutes" figure in circulation is a CONTENDED number — with 24 of these processes on 16 cores a match
costs 0.71s. Sharding `bot-noise.mjs collect` by seed base is near-linear: 9600 matches took 8 minutes
wall on 24 processes.

### 2. The HARNESS ZERO-CHECK gate was a coin flip, and its round-7 "failures" were noise

`+-0.15` at SEEDS=6 is a **1.2-sigma** tolerance (SE 0.13). An unbiased instrument fails it ~24% of
runs. And the instrument IS unbiased: 1536 null matches read **+0.02 +-0.05**. So 0.16 and 0.18 were
ordinary draws, not a broken harness — this was the §3 mistake ("a red/green light driven by the RNG")
repeating itself in a different file. Re-based **with the arithmetic**, in the style of
`test-bot-cannon`'s round-6 re-base: tolerance is now **3 SE computed from the run's own per-match SD**
(+-0.38 at SEEDS=6) and it is printed. It still catches what it exists for: the 2026-07-25 kickoff
confound is worth 0.65-1.31 goals/match — kicking off measures **+0.72** vs **-0.59** and being team A
**+0.16** vs **-0.03** — i.e. 5-10 SE. Better still, the harness now gates the **BALANCE COUNTS**
themselves (`kickedOff == N/2` and `sideA == N/2` for every anchor), which is the same check with
**zero** variance.

### 3. What IS resolvable at 1152/anchor: the ladder is genuinely NON-MONOTONE

| anchor | t=0.05 | t=0.25 | t=0.50 | t=0.82 | t=1.00 |
|---|---|---|---|---|---|
| goal diff vs the t=0.50 reference (+-0.05) | -0.48 | -0.49 | **+0.06** | **-0.49** | -0.29 |

Every anchor LOSES to the t=0.50 reference and **t=0.82 is a trough**: 0.50 vs 0.82 is 0.55 +-0.07
(**7.5 sigma**), 0.82 vs 1.00 is 0.20 +-0.07 (2.7 sigma). Replicated on three independent seed schemes
(anchor-private seeds, common random numbers, mirrored quads) — same shape every time.
**So no sample size will make `rho >= 0.85` pass.** The rho gate is not broken; it is correctly
reporting a truth that is not monotone. Raising the sample only pins down a residual nobody feels.
The suspect is in this round's own notes: the two anchors that sit ABOVE the new patience gate
(`t > 0.62`, §00000) are the two worst cells. That is a bot question, not a harness question.

### 4. Positive control: the same instrument, same n, on a ladder that is NOT flat

While measuring, another agent's *uncommitted* `bot-ai.js` was in the tree (a pass-back abort latch, a
bullet-target latch, an arena shoot-spot plan). Measured on it at the SAME n=192 and the SAME 6 seed
bases: goals rho **0.90**, per-seed-base rho **0.90 / 0.90 / 0.90 / 0.80 / 0.90 / 0.70**, spread
**1.15** (6.4 sigma), xG rho 1.00. Not a claim about that code — it is the control that settles the
instrument question: **when the ladder is real, SEEDS=6 sees it in every base. Per-seed-base sign
flips mean the ladder is FLAT, not that the instrument is blind.**

### 5. Candidate ranking statistics — 16 of them, and no ATTACKING one is gateable

Per-match differentials (measured team minus reference), 1152 matches/anchor, 36 seed bases.
`spread/SE` = how many sigma the top-vs-bottom gap is; `per-base rho` is the honest column.

| statistic | pooled rho | per-base rho min / med | spread | spread/SE | null reading |
|---|---|---|---|---|---|
| **strips** (gated today) | 1.00 | **0.90 / 1.00** | 10.5 | 67 | -0.02 |
| **time-to-first-shot** after winning the ball | 1.00 | **0.80 / 1.00** | 0.76s | 41 | -0.01 |
| possession seconds | -1.00 | -1.00 / -1.00 | -7.2s | 36 | -0.10 |
| ground gained per possession | -0.30 | -1.00 / -0.40 | -39px | 18 | +1.1 |
| ball advance per release | 0.80 | -0.20 / 0.60 | 58px | 8.6 | +6.6 |
| clear shots on target | 0.70 | -0.40 / 0.50 | 0.49 | 7.4 | +0.03 |
| **shots on goal = goals + saves forced** | 0.70 | -0.30 / 0.50 | 0.45 | **6.0** | +0.05 |
| xG (on target x lane clear x exp(-d/600)) | 0.70 | -0.50 / 0.20 | 0.21 | 4.4 | +0.02 |
| attacking-third minus defensive-third time | -0.10 | -0.70 / -0.10 | -3.6s | 3.5 | +1.2 |
| **goals (today's gate)** | 0.10 | **-0.70 / 0.20** | 0.19 | 3.0 | +0.06 |
| shots on target from inside 450px | -0.70 | -0.80 / -0.30 | -0.11 | 1.9 | +0.02 |
| attacking-third entries | -0.60 | -1.00 / -0.30 | -0.13 | 1.9 | -0.02 |
| territory (mean ball position) | -0.10 | -0.60 / 0.10 | -4px | 0.3 | +14 |
| danger-zone time (ball within 450px of a mouth) | 0.30 | -0.70 / 0.10 | +0.09s | 0.1 | +0.4 |

Read it in this order:

* **The territory family fails on its own terms.** Territory, thirds, danger-zone time and entries all
  have thousands of samples per match, so they are precise — and they still do not rank. That is a
  RESULT, not a failed candidate: the strong tiers are not spending more time near the enemy goal.
* **The shot family (shots on target, shots-on-goal, xG) ranks about as well as goals, with 2-4x the
  SNR** — better instruments for the same question, and they confirm the same non-monotone shape.
  `shots on goal` (goals + `p.stat.saves` forced) is now **printed** by `test-bot-ladder.mjs`: it is
  free (one stat sum), counts ~2x the events, and reads 6.0 sigma where bare goals read 3.0.
* **Only two statistics are stable base-to-base, and both are near-direct readouts of a skill key** —
  strips (toolSkill/react/aggro) and time-to-first-shot (`chargeRate`). They rank 1.00 in 36/36 bases
  because we SET them monotonically. Keep strips gated (it is the "axis is wired up" tripwire) but do
  not add more of that kind and call it an outcome test: **a gate that cannot fail for the reason you
  care about is not protecting anything.**

### 6. Pairing: one free 2x, one refuted idea, one deleted duplicate

* **Common random numbers ADOPTED.** The seed was `base + i*17 + Math.round(skill*100)`, so every
  anchor played a private RNG stream. Dropping the anchor term makes all anchors play the same PER
  scenarios. Measured over 36 seed bases, SD of the per-base top-vs-bottom gap:
  goals **0.410 -> 0.287**, shots-on-goal 0.454 -> 0.314, xG 0.295 -> 0.210, territory 76.3 -> 53.3 —
  **x2.0 equivalent sample size, for free.** (It does not stabilise *rho*: 0.41 -> 0.38. rho is limited
  by how flat the truth is, not by precision. It does nothing for strips, already at 67 sigma.)
* **Antithetic quadruples REFUTED — do not re-propose.** Giving all four (side x kickoff) combinations
  ONE seed makes it worse: gap SD 0.410 -> 0.386 (quads) and -> 0.446 (quads+CRN), i.e. **x0.5-0.6**
  equivalent sample, because at a non-null anchor the four runs are positively correlated, not
  mirror-images. In the t=0.50 cell they force an EXACT 0.000000 — and that is a trap, not a win:
  with equal skills the same seed on side A and on side B is the *identical simulation read from both
  ends*, so the quad cancels by arithmetic and tests nothing (it would not even catch the persona-keyed
  -on-id bug of §4).
* **The CONTROL cell was a byte-identical recomputation of the t=0.50 anchor** (same seeds, same
  skills) — 1/6 of every run spent printing a number the harness already had. Deleted; the control line
  now prints `diffs[2]` and the run reports its own noise floor from the per-match SD instead. The
  freed budget pays for SEEDS=7 at the old SEEDS=6 wall clock.
* The existing side/kickoff balance is the estimator's biggest win and it was already there: kickoff is
  worth +-0.66 goals/match and the cell cancels it exactly.

### 7. So what should the ladder GATE from now on?

Gated (all deterministic or >= 25 sigma): the **balance counts**, the **zero-check at 3 SE**, **strips
rho >= 0.85**, **spread >= max(0.60 design, 3 SE statistical)** — the 3-SE term can only make that gate
stricter, never weaker — plus goals `rho >= 0.85` and `top > bottom`, which are LEFT FAILING on purpose
because they are reporting a real regression, and the fairness ceilings.
Printed, never gated: goal differential per anchor **with its SE**, shots-on-goal, shots/match,
possession, per-seed-base rho, and the run's resolvable-gap arithmetic.
Full 16-statistic table and the noise-floor tables: `node bot-noise.mjs analyze <rows.jsonl>`.

### Open after round 7

1. **The skill-axis ladder — see the section above.** Round 6 read rho 0.80 (0.05 short) Round 6 read rho 0.80 (0.05 short)
   with spread 1.10. If it is still flat, the honest options are a level re-cut (the user's call, and
   already pending from round 5) or accepting a wider-but-noisier ladder.
2. `retreatWhileNearestPct` is still ~25% at skill 0.93 and the ball is loose ~79% of that match.
   Strong bots shoot long and the off-ball bot holds MIN_SEP; §0000's open item 1 is the same thing.
3. `backwardReleasePct` stays ~15% at 0.93 against 3.7% at 0.50. It is not the opponent's counter-kick
   (re-measured with a 0.75s settle window: unchanged), so there is one more backward-release path at
   the top of the ladder that has not been found yet.

---
## 0000. ROUND 6 (2026-07-26 13:2x-, agent `bot-review`) — 6 requested features, and the L10 "idle"

Requests: better obstacle awareness + wall planning · bots that COMMUNICATE to pass · a left-behind
bot should bomb-propel instead of walking · kick the ball ahead then bomb-fly after it · a team
wall+bomb catapult that flings the carrier WITH the ball · and (mid-round) **rectangular,
screen-shaped vision instead of a circle**.

### The two feels, diagnosed before touching anything

*"The walls are throwing them off"* — after round 5's probe fix, they are not. Of every L10 tick where
a bot WANTED to move and barely did: **team-mate body 28.6% · enemy body 16.3% · pitch edge 2.3% ·
WALL 1.0%**, rest = the legit build/carry slow. The obstacle was each OTHER: `steer()` reacted to a
player only when it was bomb-launched or >700px/s, and `separatePlayers` is a hard symmetric shove.
Body avoidance took team-mate blocking to **~1%**.

*"They sometimes get idle waiting for something"* at L10 — and this round's own new bomb plays made it
worse before it was measured: **14.3% of every bot-tick standing on a bomb fuse, 7.3s per bot per
match over 14.2 plants**, because `nextBombAt` is `3.0 * cdMul` and cdMul at the top is ~0.4, so four
branches could re-plant every ~1.2s. Fixed with `mobilityGap(sk)` — **8.1s at the bottom easing to
5.5s at the top, deliberately NOT cdMul** (a stronger bot should use the bomb BETTER, not MORE):
**14.3% → 5.1%** at skill 0.93, 4.2% at 0.50, 0.4% at 0.05. It was FLAT at first, which fixed the
idle but removed one of the few honest mechanical edges the top of the ladder has — part of why the
re-measured ladder ranked 0.80 rather than 0.90 — so a mild tier tilt was restored. Build-windup freeze also fell 3.5s → 2.0s
per match once `wallSpotOk()` stopped bots walling their own partner.

### Vision is a RECTANGLE now (and the circle was a real advantage)

`botCanSee` tested a 620px RADIUS. The client camera is `scale = CAM_ZOOM * canvasW / FIELD.W`,
CAM_ZOOM 1.65, so the visible world is 1212px wide by ~682 tall: **half-extents 606 x 341**. The
circle gave bots nearly **2x the vertical awareness of the human they play against**. Vision is now a
screen-shaped box (`VIEW_BOX`, exported for tests/overlays) and BALL_VISION became a SCALE on that box
rather than a second circle. A phone in landscape is tighter still (~560 tall), so 341 is generous.

### Measured, per feature

| | |
|---|---|
| rocket-jump vs walking (one fuse + glide, 2.92s) | walk **400px** · jump **653px** · jump + stone behind **869px** |
| the catapult (fixture) | carrier **+490px AND KEEPS THE BALL** (+595 with stone), mate +539/+649 |
| passes reaching a team-mate | **90%** (32.7 releases/match) — was 22% before the latch |
| pass GAIN sweep (the counter-intuitive one) | GAIN 100px → 53% complete · **GAIN 40px → 90%**: a longer pass is easier to cut out |
| team-mate body blocking | 28.6% → **~1%** of stuck ticks |
| bomb-fuse time at skill 0.93 | 14.3% → **5.1%** of bot-ticks |
| skill 0.50, 12 matches | pinned 0.52% · worst jam 0.82s · idle-with-ball 1.21% · shots 51.8 · loose 62.3% |

The catapult works because of ONE line in `explode()`: the ball is only knocked loose
`if (bd < radius && !(bomberOnCenter && b.owner))`. A team-mate standing on its own bomb is the only
blast in the game that can move a carrier without taking the ball off them. Geometry is
**wall → bomb → carrier** (a built wall BETWEEN bomb and carrier soaks 75% of the blast), the bomb
leads the carrier by its own speed × `BOMB.fuse`, and `mem.cata` asks the carrier to hold that heading
so the prediction lands — that call is why it is a communication feature and not two bots guessing.

### Two "test failures" that were real bugs

- **`cornerFinish` was shooting at the keeper it had gone around.** It picked its corner as a FRACTION
  OF THE MOUTH (0.30 → 90px) and re-picked it every tick. With a keeper parked on GY, `kyFut` flips
  sign constantly, so the aim flip-flopped between both corners for the whole wind-up; and 90px at the
  GOAL LINE is only ~42px of clearance at the KEEPER, who stands far closer to the shooter and slides
  ~22px during the ball's 0.16s flight. Now the required miss is computed AT the keeper
  (body + ball + slide), projected out to the line, LATCHED for 1.2s, and if the woodwork cannot fit
  it the corner is genuinely covered — so the bank / walk-in dead-end ladder finally gets its turn.
  That is what `test-bot-newskills` was reporting.
- **A one-tick window let a CARRIER hold a bomb plant** — the deleted `carryJump` in another costume.
  `finalize()` now enforces the sim's own rule (`sim.js:840`, a carrier cannot plant) at the funnel,
  so no future play can reintroduce it.

### Gates are SPREAD, not stacked — measured the hard way

Both new plays first landed on t >= 0.50 together. The ladder said: spread **0.50 → 1.04** (the
features are real and they fixed round 5's spread loss) but Spearman rho **0.90 → 0.40** — two
powerful plays arriving at the same anchor scramble the middle order. Re-placed in the free slots:
**kick-and-fly 0.58, catapult 0.74**, so the climb now reads 0.50 super-hold → 0.58 kick-and-fly →
0.68 keeper → 0.74 catapult → 0.82 super-body/far-wall → 0.92 pincer. Re-measured after that.

### Still open after round 6

1. **Strong bots leave the ball loose.** At symmetric skill 0.93: loose 78% of the match, 5.5
   "nobody reached it in 4s" events per match, ball-gap 143px — against 62% / 2.2 / 125px at 0.50.
   They take more long shots and the off-ball bot sits at MIN_SEP. Not caused by this round (the same
   shape is in the round-5 numbers) but it is the next thing a player would notice at L10+.
2. `test-bot-cannon`'s absolute "8% of self-launches are wall-boosted" gate was **re-based with the
   arithmetic**: the two new open-space mobility plays moved the denominator (265 self-launches over
   10 matches × 3 levels; the bot's own mirror now sees a chance on 4% of launches vs 11% when the gate
   was written), so 8% is above the ceiling. The gate that carries the fix — `agree >= 75`, "when a
   chance existed the boost landed" — still passes at 80%, and the absolute rate is printed instead.
3. The carry-aim deflection and the catapult both dodge/aim LOCALLY; neither biases toward the
   movement direction yet.

---
## 000. ROUND 5 (2026-07-26 12:4x-13:2x, agent `bot-review`) — §00 WAS RIGHT, AND HERE ARE THE TWO BUGS

§00 said "fix pinning on MAIN_FIELD, prime suspects the nav grid's `r+2` inflation / `detourRatio` /
the locked-tangent fallback". Measured: **the nav grid is fine** (18.9% of cells blocked, free space is
ONE connected component, so the flow field always has a route) and `detourRatio` is not the problem.
It was the third suspect, and one nobody had listed.

### The regression has a commit. `3ca355f`.

`bot-feel.mjs` (new, in the repo root) is API-minimal on purpose, so the SAME file runs inside a
`git archive <rev> shared` checkout of any old revision and the whole day can be bisected with paired
seeds. On MAIN_FIELD at skill 0.50, 6 matches x 60s:

| | `e5f97e7` 07-24 | `3d08e27` 01:53 | **`3ca355f` 02:18** | HEAD (before this round) | **fixed** |
|---|---|---|---|---|---|
| worst single wall-jam | 3.33s | 0.78s | **39.97s** | 15.65s | **0.73s** |
| pinned % of move ticks | 1.75 | 1.27 | **7.63** | 3.25 | **0.58** |
| loose-ball gap | 76px | 65px | **164px** | 124px | 166px* |
| ball loose % of match | 66.5 | 63.6 | **77.2** | 74.8 | 62.7 |
| "nobody reached the loose ball in 4s" /match | 0.17 | 0.17 | **4.67** | 4.33 | 2.33 |

\* the gap is LARGER after the fix for a good reason: the ball is now HELD 37% of the time, so when it
is loose it is because someone just kicked it a long way.

**The user's memory was exact**: the last build that felt right is `e5f97e7` (07-24 19:05), and every
bot commit after 02:18 on 07-26 is downstream of the break.

### Bug 1 — the wall-detour guard TUNNELS THROUGH WALLS (`steer()`)

The committed-tangent fallback validated its chosen direction with clearance at **one point, `LOOK`
(120px) along the tangent**. Every wall on MAIN_FIELD is thinner than that probe — `hardWalls` are
`ht:16` capsules (32px thick) and `crates` are 50px boxes — so a probe pointed at a wall 40px away
lands on the **far side of it**, in free space, reads **+41px of clearance**, and the guard passes. The
"detour" then IS a march into the wall face, and it is re-committed every `wallCommit` seconds because
the geometry never changes.

Traced, not guessed: bot `A1` at (927,133), 26px off the `cap(1000,175,hl150)` capsule, waypoint at
(784,176) (i.e. "go LEFT round the end"), emitting **move = (0.05, 1.00) — straight down into the
wall — for 8.5s**, `pressTicks` climbing to 509. Plug the numbers into the tangent formula and you get
exactly (0.05, 1.03): the bot is obeying the guard.

**Fix**: sample the same `SAMP` fractions the interest loop already uses (`rayMin`). One line of real
change. **This is why the whole session missed it — the default arena's walls are 120px boxes, thick
enough to swallow the probe.** §00's finding, with a name.

### Bug 2 — bots kick their own ball off walls (nothing in this file knew `sim.js:919`)

`sim.js:919-925`: the held ball sits at feet + aim x (radius + ballR) and pops **LOOSE** the instant
that spot touches any wall, static or built, with a `RELEASE_PICKUP_CD` lockout so the carrier cannot
even pick it back up. A bot carrier aims **at the enemy goal** while it dribbles.

| | MAIN_FIELD | default arena |
|---|---|---|
| carrier wall-pops per match | **28.3** | 1.2 |

Median possession across every revision measured was **ONE TICK (0.02s)**, and only 18% of possessions
ended in a kick — the rest were the carrier losing the ball to a wall it was facing. **That is the "they
don't go for the ball" report**: the ball is loose 75% of the match, so all four bots are permanently in
the loose-ball branch, and the "bots" the user watches are four sprites converging on a rolling ball.

**Fix**: `finalize()` rotates the **emitted** aim to the nearest direction whose glue spot is clear.
Never `bm.aimTheta` (so the slew still converges on the real target) and **dropped on the fire tick**
(so the shot direction is exactly what the tactic chose). A human does this with their thumb.

### After both fixes (paired seeds, MAIN_FIELD, skill 0.50, 6x60s; second seed base agrees)

worst jam **15.65s -> 0.73s** · pinned **3.25% -> 0.58%** · wall-pops **28.3 -> 3.2** · median
possession **0.02s -> 0.87s** · kick-ended possessions **18% -> 60%** · shots **27.7 -> 39.8** ·
goals **0.33 -> 1.50** · idle-with-ball **4.09% -> 2.37%**.

### New instruments

- **`bot-feel.mjs`** — the paired-seed feel meter above. Runs on old revisions. Not gated; it is an A/B.
- **`public/_bot-scope.html`** — a bird's-eye 2v2 scope that imports the LIVE `shared/` modules, so it
  shows the code you just edited (restart the server). All 12 levels, partner-vs-enemy or mirrored,
  steering targets, flow-field waypoints, nav occupancy, tactic tags, vision, **the ball's glue spot**
  (green = safe, red = about to pop), per-bot jam timers, and jam%/worst-jam/wall-pop counters.
  Generated from `scripts/bot-scope.template.html` by `scripts/build-bot-scope.mjs` — **edit the
  template, not the generated page**. `--standalone <path>` emits a single-file build with a
  **Patched / Pre-fix** switch (that build was shared with the user). Pre-fix, 56s: jam 19.6%, worst
  jam 41.7s, 23 pops, **0 shots**. Patched, 44s: 0.72%, 0.42s, 1 pop, 42 shots, 1 goal.

### Two traps found in the instruments themselves

1. **`test-behavior.mjs` tests pinning against the WRONG WALLS.** Its `nearWallOrEdge()` reads the
   global `ARENA` even under `ARENA=main`, so on MAIN_FIELD it counts pins near four boxes that are not
   there and MISSES every pin on the real capsules and crates. The 14.36% in §00 is measuring phantom
   geometry. `bot-feel.mjs` uses `state.arena` + `builtWalls` with exact capsule geometry.
2. **The browser is level 0.** `http://10.100.102.36:3012/` has no `window.SALTIZ_XP`, so it runs the
   weakest tier in the game — enemy skill **0.05** after the 07-26 re-cut (it was 0.25). Any "the bots
   are dumb" report from the LAN browser is a report about L0 unless it says `?diff=9`.

### Still open after this round

1. **`test-bot-ladder.mjs` — MEASURED, both ways, `SEEDS=6` (192 matches/anchor) on the same machine:**

   | | rho (goals) | spread | strips rho |
   |---|---|---|---|
   | pre-fix | 0.90 | **0.60** (exactly on the gate) | 1.00 |
   | **shipped fix** | **0.90** | **0.50** ❌ | 1.00 |
   | fix + a skill-gated deflection (below) | **0.70** ❌ | **0.47** ❌ | 1.00 |

   So the fix costs 0.10 goals/match of felt spread while the RANKING survives intact (goals 0.90,
   strips 1.00, top still beats bottom 0.13 vs −0.38). §5.4 already recorded that this gate has zero
   headroom. The remaining path is a **level re-cut** measured at `SEEDS=6` — a ladder change that needs
   the user's sign-off, not a lowered gate and not a bot handicap. `test-bot-partner.mjs` is the
   previously-logged level-table conflict.

   **MEASURED AND REFUTED — do not re-propose: "make weak bots dribble the ball into walls."** It is the
   obvious way to buy the spread back, it looked like the *characterfully dumb bottom tier* §4 says has
   no working lever, and it FAILED THE SAME WAY the seven `decisionHz` variants did. Gating the
   carry-aim deflection on a skill-scaled notice probability (`care = 0.25 + 0.85·t`, deterministic
   `seededNoise` on a ~2.2Hz bucket) left skill 0.50 unchanged (median possession 0.87s, jam 0.58%) and
   visibly clumsy at 0.05 (loose ball 68%, gap 295px) — and still **collapsed the ladder to rho 0.70**.
   Same root cause as the `decisionHz` autopsy: a stochastic handicap adds variance faster than it adds
   ranking, and the high tiers pay for it too.
2. The carry-aim deflection is a **local** dodge (nearest clear glue direction). The better version
   biases toward the movement direction so the ball is nudged the way the bot is already going.
3. `sim.js:919` itself deserves a look: popping the ball because the AIM grazes a wall punishes a human
   dribbling along a wall too. This round deliberately fixed the BOT, not the rule.

---
## 00. THE BIGGEST FINDING — every bot test ran on an arena the game does not use

**Priority 1. This invalidates most of the numbers elsewhere in this document, including mine.**

The user reported, testing the CURRENT code on `http://10.100.102.36:3012/`:
*"I see bots stuck behind walls, or not going for the ball."* He is right, and the tests said
otherwise because **they all call `createState()` with no field**, so `state.arena` is undefined and
`arenaOf()` falls back to the bare default arena.

| | default ARENA (every test) | **MAIN_FIELD (the game)** |
|---|---|---|
| walls / bushes | 4 / 3 | **16 / 14** |
| pinned while wanting to move | 1.38% | **14.36%**  (10×) |
| idle with the ball | 1.01% | **20.42%**  (20×) |

`server.js` starts real matches with `MAIN_FIELD_CLEAN` (`:582`) or `roomField(room)` (`:720`).
The default arena is used by **nothing that ships**.

So: the flow field, the steering rewrite, the stall detectors, the release ladder and the whole
difficulty ladder were all validated against 4 walls and then shipped into 16. The nav grid and the
ray-cast steering are almost certainly still *directionally* right — but they are untuned for the real
geometry, and 14% pinned is a broken-feeling bot.

**Reproduce in 30s:**
```bash
ARENA=main node test-behavior.mjs      # vs: node test-behavior.mjs
ARENA=main SEEDS=3 node test-bot-ladder.mjs
```
`test-behavior.mjs` and `test-bot-ladder.mjs` now take `ARENA=main`. **`test-bot-stall.mjs`,
`test-bot-tricks-fire.mjs`, `test-bot-newskills.mjs` and `test-bot-levels.mjs` still do NOT — porting
them is step one**, and expect gates to fail when you do. That is the point.

**What I would do first, in order:**
1. Make `ARENA=main` the DEFAULT in every harness; keep the bare arena as the opt-out. Re-baseline
   everything and expect several gates to go red.
2. Fix pinning on MAIN_FIELD. Prime suspects, in order: the nav grid's `r+2` inflation closes real gaps
   when walls are dense (a 60px gap has only a ~7.5px passable band, and MAIN_FIELD has 4× the walls);
   the `detourRatio` engage threshold was tuned on an arena where the direct line was almost always
   free; and the locked-tangent fallback has no escape when two walls form a pocket.
3. Only then revisit the ladder — its spread was measured on the wrong arena too.

---
## 0. START HERE — the bots on your phone are NOT the bots in this repo

The user's doubt — *"I'm not sure if the bot logic fails or it doesn't load correctly to the game"* —
is **the second one, and it is confirmed by measurement, not by guesswork.**

Probed against `https://pikme-football.onrender.com/shared/bot-ai.js` on 2026-07-26 12:3x:

| marker | prod | local | what it is |
|---|---|---|---|
| `navBfs`, `outsidePlayArea`, `windupBudget` | ✅ | ✅ | the FIRST batch (routing, goal mouth, charge fix) |
| `personaOf`, `bodyScreen`, `walkIn` | ❌ 0 | ✅ | personality + the two new abilities |
| `cannonPlant`, `wallPush` | ❌ 0 | ✅ | wall-cannon + `buildDist` (bots aiming their walls) |
| `superBodyStrip` | ❌ 0 | ✅ | the super body-check strip |
| `decisionHz` | ⚠️ 10 hits | 2 (comments) | prod still has the DEAD knob I removed |

`shared/bot-ai.js` — **prod 114,850 bytes vs local 159,759**. Prod is ~45KB / roughly half a session behind.
`shared/difficulty.js` — prod still serves the **OLD level table** (`enemy: T.veryEasy` …), not the re-cut `LEVEL_PAIRS`.
`client.js` — prod has **no `DIFF_PIN`/`DEV_HOST`**, so the `?diff=` override is not live either.

**Consequences you must internalise:**
- The phone (TestFlight → `PROD_GAME_URL`, `pikmeTV-saltiz/app/pages/football.jsx:48`) runs a **half-old build**. Any "the bots are dumb / too strong" report from the phone is about code that is partly 10 hours stale.
- **29 commits are unpushed.**
- **Pushing the game does NOT deploy it.** The game service's GitHub webhook is dead. After an approved push:
  `render deploys create srv-d9ebcvtaeets73ar91sg --confirm` (game) / `srv-chgb1k67avjbbju8aoig` (api — this one DOES autodeploy, so pushing `pikme-server` IS a production deploy).

**How to re-check this in 20 seconds** (do it before believing any phone report):
```bash
curl -s https://pikme-football.onrender.com/shared/bot-ai.js | grep -c bodyScreen   # 0 = prod is stale
curl -s http://10.100.102.36:3012/shared/bot-ai.js        | grep -c bodyScreen      # 1 = local is current
```

There is no bundler. `server.js` serves `shared/` verbatim and imports the AI directly
(`server.js:32` → `computeBotInputs`, called at `server.js:338`), so **local = what you edited**, with
one caveat: **Node does not hot-reload — restart `PORT=3012 node server.js` after any `shared/` edit.**

---

## 1. The five traps that cost this session the most time

Every one of these was discovered by measurement after wasting effort. Do not re-learn them.

1. **`bot-eval.mjs` counted `inputs[id].shoot`, a key `computeBotInputs` has NEVER emitted.** Shots read
   `0` in every run ever done. It is `fire`. If a metric reads exactly zero, suspect the metric.
2. **A trick tag is INTENT, not behaviour.** The deleted `carryJump` set its tag on every commit while
   the sim produced zero bombs (`sim.js:840` gates the plant on `!carrying`). And an **untagged** play is
   invisible: `screenWall` reported 0 for weeks purely because it never set `bm.lastTrick`.
3. **Unseeded harnesses cannot measure anything here.** Identical code reported wall-pinning from
   0.27% to 0.51%. `shared/sim.js` now has `makeRng(seed)` + `state.rng` (null ⇒ `Math.random`, so
   production is unchanged). **Always seed.**
4. **My own ladder test was seed-lucky and I quoted it as fact.** It reported rho 0.90; at other seed
   bases the same code gave 0.70/0.60/0.60/0.70. It also had a confound: kickoff correlated with the
   anchor (30/30, 30/30, 0/30, 0/30, 0/30). Rebuilt — see §3.
5. **Cheap-and-always-available pre-empts rare-and-valuable.** My `bodyScreen` returned early at the top
   of a branch and starved the deflect set-piece on **47 of 47** available ticks. Any new early-returning
   behaviour must be placed by VALUE, not by convenience.

---

## 2. What changed, by area

Commits are local and unpushed. `9b97526` is a **parallel agent's** work that I committed with
attribution so it would not be lost; everything else in this list is mine unless noted.

### 2.1 Navigation / "stuck in front of a steel wall" — `3ca355f`
Three compounding defects:
- `steer()` clamped to each wall's **AABB**. `capsuleAABB` of a 600×120 wall at 45° is 509×509, so 8px
  inside that corner a bot read 0px clearance where the truth is ~289px — a phantom obstacle on every
  angled/field-builder wall. Now exact `nearestOnWall` capsule geometry.
- Danger was proximity-based, so sliding **along** a wall scored *worse* than driving into it
  (toward −1.2, tangent −1.36, retreat −1.0 ⇒ retreat wins ⇒ oscillation). Now a 3-sample **ray-cast**,
  and each ray is judged **relative to `c0`**, the clearance where the bot already stands. That gate is
  the crux: when wedged, `c0 ≈ 0` makes tangents look blocked too, which is what inverted the ranking.
- Exact clearance then made the two tangents perfectly symmetric → the 0.55 low-pass averaged them to
  zero → deadlock. Added a **committed detour side** (`wallCommit`).

Local steering still could not solve a big obstacle (it rounded a 600px wall then orbited the corner
forever), so there is now a **32px occupancy grid + 8-connected BFS flow field** (SPFA re-push — a
visit-once FIFO with 10/14 costs yields a non-monotonic field), cached per arena, LRU 16, **engaged only
when the field says the direct line is a detour**, so open play is unchanged.
**Cost: 0.49ms/tick at 10 bots + 24 walls** (2.9% of a 60Hz frame). The grid rebuilds once per arena;
3.6ms only on the tick a wall is actually built. *Follow-up: incremental re-stamp ≈20µs.*

### 2.2 "Stands with the ball in front of the goal" — `3ca355f`
The anti-idle release was gated on `laneWalls`, so a wall across the goal lane left **no release path at
all** and the carrier held the ball for the rest of the match. Now an ordered ladder that always
terminates: 3 aim points (centre + both posts — only the CENTRE was ever tested) → smash a **fragile**
wall → outlet pass → work the angle across the blocker's face. Plus a watchdog.
**The watchdog widens the AIM TOLERANCE**, because `fire` needs charge ≥ `fireAt` *and* aim within `tol`,
and `tol` was the thing that stalled — `shoot = true` alone does not release the ball.

Also: `sim.js:842` implements a **dribble-in goal** — walking the ball over the line scores, bypassing the
kick/save path entirely, i.e. unsaveable. `bot-ai.js`'s header used to claim the opposite. The boundary
danger repelled carriers at x>1945 while the walk-in needs x>1971, so the steering physically prevented
the best finish in the game. Boundary is now measured against a mirror of `clampBallCarryXY`
(**not** `clampXYToArea` — opening the pocket to every bot raised wall-pinning 0.29%→0.40%, because a
pocket is a 300×70 dead end; only the attacking carrier gets it).

### 2.3 `laneClear` was lying in both directions — `00794e9`
Fixed 10-step sampling = a 100px stride on a 1000px lane, so a 32px built wall fell between samples ~2/3
of the time. Now **exact segment-vs-AABB (slab)** — which is also *cheaper* than 10 samples — and it
reports `out.wall` so callers can tell a destructible built wall from indestructible stone.

### 2.4 The INVERTED ladder — `64e0218`
At 30 matches/anchor the **dumbest tier had the best goal differential** (Spearman **−0.90**).
Cause: a ball release fired at charge 0.71 (`fireAt` clamped every request to `FULL_CHARGE`), which rolls
**499px** — but `FINISH_RANGE` was `560+220*AGG`, up to **835px**. Bots shot from ~300px beyond the
ball's reach, died short and gifted possession; and since the range scales with **aggro**, the *more
aggressive* (higher) tiers wasted more. Three fixes: a ball release fires at the charge it asked for;
`FINISH_RANGE` derives from `ballRollPx()` (roll is linear in release speed, `0.468*(v0−18)`); each shot's
charge is sized to the distance. **Result: rho −0.90 → +0.90.**

### 2.5 De-cheating the top tier — `64e0218`
Strong by DECISIONS, not by cheating (Brawl Stars' model):
- **x-ray DELETED** (it saw every open enemy anywhere — information the player cannot have).
- **Permanent super DELETED** (it re-granted `p.power` *and* `powerUses` every tick they were false, so the
  one kick a keeper cannot catch was always available).
- **Card/skill double-dip broken.** `RARITY_BY_LEVEL` hands a bot its best cards at exactly the levels
  where the skill vector spikes and the sim multiplied both, so difficulty grew ~quadratically while the
  player's power grows only with their album. Cards are now divided out at the write site.
- **Fairness ceiling**: effective charge rate capped at 2.50 ⇒ fastest full charge **0.57s (0.28s worst
  case with 3 legendaries + super) vs 0.15s before** — a readable wind-up.
- The `t ≥ 0.95` **cliff is now a ramp from 0.92**, so L9 keeps zero of it; `preCharge` is probabilistic and
  capped at `_charge < 0.35` so a telegraph survives; `visionMul` made monotone (hard was 1.90 > the new top).

### 2.6 New abilities — `7bb3567`, `92c98ce`, `9b97526` (parallel agent)
- **BODY SCREEN** — the team-mate steps in front of the defender chasing your carrier. Works because
  `steer()` has **no body avoidance at all** (it reacts to players only when bomb-launched or >700px/s, and
  the nav grid is walls-only) while `separatePlayers` (`sim.js:354`) is a hard symmetric push.
  Measured time-to-press **1.68s → 6.67s**. Costs nothing. Armed once, 1.1s hold, 2.6s cooldown.
  ⚠️ Deliberately **no `bm.screening` flag** — the spec had one, it was never cleared, and a bot lost
  `MIN_SEP` permanently after its first screen.
- **WALK-IN GOAL** — only in the keeper dead end (keeper parked **and** the corner covered **and** `bankAim`
  null). Unsaveable via `detachIntoNet` (`sim.js:863`), because a keeper catches every kick below
  overcharge (`sim.js:915`). Zeroes `carryT` while walking, aborts after 2.2s or if a defender closes
  inside 150px. Beatable by one full bullet in 0.13s.
- **PERSONALITY** — 4 personas (presser/poacher/tinkerer/anchor) tilting aggro/toolSkill/wallCommit/bushLove.
  ⚠️ **Keyed on SLOT, not bot id** — see §4.
- (parallel agent) **wall-cannon** `cannonPlant` with a lob/rotation search, `toolNotice` gating, `wallPush`/
  **`buildDist`** so bots finally use the 60→180px wall reach, and the `goalScreen` latch fix.

### 2.7 Deflect set-piece revived — `bf69b4f`
Two root causes, neither a threshold:
1. **The trigger asked for a keeper.** It tested "an enemy is standing in their own box" as a proxy for
   "the carrier's direct finish is blocked". Of 7463 support ticks the range condition held on 914, the
   proxy on **29**, and the play armed **0** times — because **no bot in this game plays keeper**. Replaced
   with one exact `laneClear` from carrier to goal. Opportunity 29 → 1862, conjunction 0 → 47.
2. **My own body screen pre-empted it on 47/47 ticks.** Moved below the set-piece.

**Result: `deflectSetup` 0 → 1 per 6 matches AND `deflectShot` 1** — the two-bot combo completes end to end.

### 2.8 Levels re-cut — `0204b66`
The old table's **L2 was the EASIEST LEVEL IN THE GAME** (+0.75 goals/match for the player vs L0's +0.22),
because partner 0.68 vs enemy 0.25 meant the helper outweighed the opposition. L1 was harder than L3/L4;
L9 easier than L8. The enemy column being sorted proved nothing — a level sets **two** scalars.
New table: enemy strictly 0.05→1.00, partner **arcs** to 0.50 mid-ladder then eases to 0.38 so the
opposition out-grows your team-mate. **Hints are GENERATED from the scalars** (they had already drifted).
Only L11 is now above `EXTREME_SKILL` 0.95 (L10 was too — part of why 10 and 11 felt identical).
Added `mem.botSkill` (per-bot skill override) so a mixed team can be modelled.

### 2.9 Browser difficulty override — `1d7ed8f`
`http://10.100.102.36:3012/?diff=9` pins any level 0–11. Previously the LAN browser was **always level 0**
— the weakest tier in the game, on both sides — because difficulty comes from `window.SALTIZ_XP`, which
only the app injects. `DEV_LOCAL` is deliberately **not** widened (it also drives `DEV_SAMPLE_CARDS`, three
fake-XP fallbacks and the dev reveal panels); `DEV_HOST` is a separate predicate. URL-only, never
persisted, ignored on a public host. **The phone's XP path is untouched. NOT YET DEPLOYED.**

---

## 3. How to test (the instruments, and what each can actually prove)

```bash
for f in test*.mjs; do node $f; done          # whole suite
PORT=3012 node server.js                      # then http://10.100.102.36:3012/?diff=9
```

| harness | what it proves | notes |
|---|---|---|
| `test-bot-ladder.mjs` | does the 0..1 skill AXIS rank? | **`SEEDS=6` before quoting any number.** Its noise floor is now measured — see the bullets below and §00000b |
| `bot-noise.mjs` | **measures the ladder harness itself**: noise floor vs sample size, 16 candidate ranking statistics, and estimator/pairing variants | `collect` writes one JSON row per match, `analyze` reads them. Shard by seed base across cores; 0.27s/match serial |
| `test-bot-levels.mjs` | do the 12 LEVELS get harder for the *player*? | models `[human-proxy + partner] vs [2×enemy]`. **Cannot resolve adjacent levels** — see below |
| `test-bot-stall.mjs` | the two reported symptoms, as capability fixtures with deadlines | 8 fixtures |
| `test-bot-tricks-fire.mjs` | per-tier trick histogram; fails if a named trick is silently dead | counts tag *transitions* |
| `test-bot-newskills.mjs` | the new abilities, by **sim outcome** (a strip, a goal, a body in the lane) | not by tag |
| `test-behavior.mjs` | pinned-on-wall % and idle-with-ball % | `SEED=` for reproducibility |
| `bot-eval.mjs` | behaviour audit read out of `p.stat`, not intent tags | rewritten by a parallel agent |

**Statistical honesty — the two limits I hit, both now written into the tests themselves:**
- **`test-bot-ladder.mjs`**: the *shot count* is an inverted U (8.4/11.1/15.3/14.4/10.9) because the top tier
  takes **fewer, better** shots. Gating it would punish selective shooting. Possession ranks **backwards**.
  Both are printed as tripwires, never gated. **Strips** rank at rho 1.00 and are the sensitive metric.
- **`test-bot-levels.mjs`**: adjacent levels differ by ~0.09 enemy skill ≈ 0.05 goals/match, against a noise
  floor of **0.3–0.4 even at 96 matches/level**. Changing *only* L0's partner by 0.05 moved its measurement
  from +0.22 to −0.25. So per-level Spearman, bands and endpoints are **printed, not gated** — gating them
  is a red/green light driven by the RNG, and chasing it produced two bad re-cuts before I stopped.
  Gated instead: enemy strictly rising; no partner dwarfing its enemy (>2.0× — old L2 was 2.7×); enemy
  out-growing partner overall.

**Statistical honesty, part 2 — the ladder's own floor, MEASURED (2026-07-26, agent `bot-noise`; full
tables in §00000b).** Same rule as above, now with numbers instead of a hunch, and it EXTENDS the rule
rather than replacing it:

- **The number to remember: the per-match goal differential has SD 1.78.** So the cell mean's SE is
  1.78/√n — **0.31 at SEEDS=1, 0.13 at SEEDS=6, 0.05 at SEEDS=36.** To call a **0.10 goals/match**
  difference at 2σ you need **n = 1248/anchor = SEEDS=39** (~34 min serial at 0.27s/match, ~5 min
  sharded 16-way through `bot-noise.mjs`). *Nothing at SEEDS=6 can resolve one tier-to-tier step.*
- **THE RULE, stated for the next agent.** *May be GATED:* things that are structural
  (`kickedOff == N/2`, `sideA == N/2`, enemy skill strictly rising), things whose signal is ≥ 25σ at the
  run's own sample size (strips, possession direction), a self-calibrating tolerance expressed in the
  run's own SE (the zero-check at 3 SE; `spread >= max(0.60, 3 SE)`), and the fairness ceilings, which
  are arithmetic. *Must only be PRINTED:* every per-anchor goal number, shots-on-goal, xG, territory,
  thirds, entries, per-seed-base rho, and anything whose per-base rho crosses zero across seed bases.
- **Two new failure modes, both now written into the test file:**
  1. **A tolerance smaller than the SE is a coin flip.** The zero-check's `+-0.15` was 1.2 SE at
     SEEDS=6 — an unbiased harness fails it ~24% of runs, and that is exactly what round 7's "0.16-0.18
     out of tolerance" was. Re-based to 3 SE **with the arithmetic printed**, the way
     `test-bot-cannon`'s 8% gate was re-based in round 6. Never hardcode a tolerance again: express it
     in SE and print it.
  2. **Do not gate a statistic that is a near-direct readout of a skill-vector key.** Strips
     (toolSkill/react) and time-to-first-shot (`chargeRate`) rank 1.00 in 36/36 seed bases because we
     SET them monotone. They are excellent tripwires that the axis is wired up, and they can never fail
     for the reason anyone cares about. Keep exactly one of them gated; measure OUTCOMES for the rest.
- **A flat per-seed-base rho list is a RESULT, not a broken instrument.** Control measurement: on a
  revision whose real spread was 1.15 goals/match, SEEDS=6 read per-base rho 0.90/0.90/0.90/0.80/0.90/
  0.70 — stable. When the same harness reads 0.70/0.30/0.60/−0.60/−0.50/0.10, the ladder is flat.
- **Free 2x, already applied:** the ladder's seeds are now COMMON across anchors (the seed no longer
  carries `Math.round(skill*100)`), which halves the variance of the top-vs-bottom gap. Antithetic
  quadruples were tried and are WORSE — see §00000b before proposing any estimator change.

---

## 4. Measured and REFUTED — do not re-propose

- **`decisionHz` is deleted, deliberately.** It is the obvious "make the bottom feel dumb" lever and it
  does not work. **Seven** implementations across two councils: plan cache (rho +0.70→+0.20, shots −56%),
  unit-aim replay (+0.20), movement-only cache (−0.50, the HIGH tiers hurt most), output/aim-stale/
  uniform-Hz (indistinguishable from none), and **`mistakeP`** — the Brawl Stars handicap — which an
  adversarial challenger **built line-for-line** and which failed by the same number it was written to fix.
  Root cause is structural: `carryT`/`blindT`/the progress ratchet are **integrators that must advance every
  tick**, and eight branches early-return into `finalize()` with a hand-built aim. Staling anything removes
  reactivity — which is exactly where the high tiers' advantage lives.
  **There is currently no working lever to make the bottom tier *characterfully* dumb.** It is clearly the
  weakest; it just isn't funny about it.
- **`doubleBomb` cannot be fixed by widening gates** (tried 3×: 273→462px, then the window, then walk→lob).
  Instrumented: 890 bot-ticks inside the live window, conjunction satisfied on 27 — and on **22 of those 27
  the ball was already loose**, because the tackle bomb that raises the signal has usually already stripped
  the carrier, putting the support bot in the loose-ball branch where the code does not exist.
  **The play chases a situation its own trigger destroys.**
- **`carryJump` was deleted — a carrier can never plant** (`sim.js:840` gates on `!carrying`). It froze the
  carrier on a fuse for a bomb that never spawned, ~50s/match at the top tiers.
- **A kicked ball does NOT chip a wall.** `damageWall` is called only from the bullet path (`sim.js:1170`)
  and the bomb blast; a ball ricochets (`sim.js:895`). Only a **fragile** (hp1) wall smashes, above
  `FRAGILE_PASS_SPEED`. Clearing a solid wall is the support bot's job with a bullet. *(I got this wrong
  first and had a carrier kicking solid walls for nothing.)*
- **Personality must be keyed on SLOT, not bot id.** Keyed on id, the fixed ids A0/A1/B0/B1 gave team A
  `anchor+presser` (+0.02 aggro) and team B `tinkerer+anchor` (−0.16) — a constant asymmetry unrelated to
  skill that **collapsed the ladder from rho 1.00 to −0.10**. Slot-keying mirrors the personas across teams.
- **`screenWall` is not broken.** It fires once at t=0.50 and is otherwise correctly *starved* by
  higher-value wall plays. One charge per ~15s — that is the budget working.

---

## 5. What is still open, in priority order

1. **DEPLOY, or stop trusting phone reports.** 29 commits unpushed; prod is ~half a session stale. Needs
   the user's explicit go-ahead, then `render deploys create srv-d9ebcvtaeets73ar91sg --confirm`.
2. **PASSING.** Root-caused and a working fix exists — **and was reverted on purpose.** 98 pass intents
   produce 49 releases; only **22% reach a team-mate**, 16% reach an **enemy**. Cause: a pass sets shoot+aim
   for one tick, the branch is not re-selected, `shoot` goes false, but `bm.charging` survives with the
   pass's `fireAt` while the aim is re-derived as "drive at goal" — **the pass is silently converted into a
   shot at goal.** Passing is the only committed action that does not latch. The latch works (completed
   passes 11→31) but **flattened the ladder** (rho 0.90→0.30, bottom tier's goals 40→82); gating it on
   `toolSkill` did not rescue it. **Delivering a pass under pressure is one of the biggest difficulty levers
   in the game** — so it must ship *together* with a level retune, measured at `SEEDS=6`. See `38eecbd`.
3. **`test-bot-partner.mjs` fails** — another agent's test; it samples "levels whose partner is
   veryEasy/easy" and my re-cut leaves only 2 (L0, L1). Needs re-basing on the new table. I did not edit it
   because they were live in the repo.
4. **The ladder spread sits exactly ON its 0.60 gate.** Personality cost ~0.6 goals/match of headroom
   (1.28 → 0.60). Any further variance-adding feature will push it under.
5. **Server does not validate client `diffLevel`** — it is client-authored, unvalidated, last-write-wins.
   `server.js` was under another agent's edits all session so I stayed off it.
6. **3v3 is essentially unmeasured.** Every number here is 2v2.
7. Nice-to-have: incremental nav-grid re-stamp (~20µs vs the 3.6ms rebuild on the tick a wall is built).

---

## 6. Working alongside the other agents (this repo is busy)

- 3–4 agents were live in `client.js`, `server.js`, `sim.js` throughout. **Take an orchestration lock**
  (`football-mock:<path>`) and check `git status` before editing.
- **One agent leaves work STAGED.** 1284 insertions across 14 files were sitting in the index; any
  `git commit` by anyone sweeps them up. **Run `git diff --cached --stat` before every commit.**
- **Commit per feature, not per session.** I held four features uncommitted while running long suites and
  an agent wiped the working tree; I had to rebuild them from scratch. That is the repo's own rule and I
  broke it.
- If you find another agent's uncommitted work, **commit it with attribution** rather than burying or
  losing it (that is what `9b97526` is).
- Two of the items I listed as "still open" in an earlier handoff had **already been fixed** by a parallel
  agent. **Verify by measurement before believing any status — including mine.**
