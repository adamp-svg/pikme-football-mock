# Bot skills — three options, one recommendation

**Status:** awaiting user approval. **No code has been written.** This doc exists so the choice can be
made before anyone touches `sim.js`.

**Request:** "add new skills for the bots." That is ambiguous three ways, and the three readings differ
by roughly 10× in cost. Options below; recommendation in the next paragraph.

---

## TL;DR — the recommendation

**Do option (b): 4 new bot-only *behaviours*, all inside `shared/bot-ai.js`, no `sim.js`, no wire change,
no desync risk.** Three reasons, each measured or cited rather than asserted:

1. **Option (a) is not what it looks like.** The 6 "existing player techniques" in `shared/techniques.js`
   are **not in the game at all** — for players either. The module is imported by exactly one file, its
   own unit test (evidence §2.1). So "let the bots use the techniques players already have" secretly
   *is* option (c): you must build the mechanic in `sim.js` first. That single fact should decide this.
2. **The industry answer is "better execution, not distinct abilities."** Brawl Stars, Fortnite and Roblox
   PvP bots all get the *same or a smaller* verb set than players and are differentiated by execution
   quality (§3). No shipped game in the reference set gives bots exclusive abilities. Option (b) is the
   only option that matches this, because a pincer or a goalkeeper is not a new ability — it is better
   use of `move`/`aim`/`fire` that a human could also do by hand.
3. **The difficulty ladder is currently flat above L5 and that is the actual bug behind the request.**
   Measured: L5 and L8 bots run the *identical* behaviour repertoire (§2.2). A player genuinely cannot
   tell them apart in *what* they do. New skills spread across L5–L11 fix that; new *mechanics* do not.

Cost: ~1 file, ~4 tests, zero desync surface. Option (c) is 4–6 files including `sim.js` + `wire.js` +
client prediction, and it is the only option that can desync the match.

---

## 1. What I read

`shared/bot-ai.js` (1727 lines, overhauled tonight in `3ca355f`/`64e0218`), `shared/techniques.js`,
`shared/difficulty.js`, `shared/sim.js` (input + keeper paths), `shared/wire.js`, `shared/constants.js`,
`docs/MECHANICS.md`, `bot-eval.mjs`, `test-bot-tricks-fire.mjs`. Numbers below are executed output, not
estimates.

### 1.1 What a bot can already do (28 behaviours)

`bm.lastTrick` tags the behaviour committed each tick. The full universe is **28 tags** (it was 29 when
this doc was first written; the bot lane deleted `cannonSetup` — the unreachable walk-to-a-cannon-pad —
later the same session):

```
ambushLurk ambushStrip ambushWall blockDrive bombTackle bushSteal catchUpJump clearMarker
coopPush cornerEscape cornerFinish deflectSetup deflectShot dodge doubleBomb drive giveGo
goalBank goalScreen outletPass overFinish passBank postFinish smashWall wallCannonJump
watchdogRelease workAngle zigzag
```

Bots already: pass and give-and-go, zigzag away from a marker, bomb-tackle to strip, stack two bombs,
hide in bushes and ambush, build wall-traps and goal screens, bank shots off walls, rocket-jump to catch
up, sidestep bullets, run a coordinated deflect set-piece, and escape a corner with a bomb. **The bots
are not short of tricks.** Any proposal here has to clear that bar, not re-invent it.

### 1.2 What the difficulty ladder already varies

`shared/difficulty.js` has 12 levels (L0–L11), each setting an **enemy** and a **partner** 0..1 scalar
independently. `skillVec(t)` interpolates 17 knobs across 5 anchors: `react`, `aimSigma`, `aimTau`,
`turnRate`, `leadGain`, `decisionHz`, `toolSkill`, `evade`, `aggro`, `chargeRate`, `cdMul`, `visionMul`,
`wallCommit`, `detourRatio`, `flowAhead`, `navLag`, `memoryS`, plus `preChargeP`/`cheatFlub`/`flubMag`
ramping in above t=0.92.

**A new "skill" that duplicates one of those 17 knobs is waste.** In particular: reaction speed, aim
noise, aggression, tool cooldowns, vision range, pathing quality and charge rate are all *already*
difficulty-scaled. Do not propose them again.

---

## 2. The three facts that change the decision

### 2.1 VERIFIED — the 6 techniques do not exist in the game

`shared/techniques.js` defines `feint` (cancel-charge), `banana` (curve-kick), `cook` (hold-fuse),
`vault` (hop-own-wall), `precise-strip` (strip-window), `chain-super` (carry-super-use). Searching the
whole repo for importers and for the `effect` strings:

```
$ grep -rn "techniques" . --include="*.js" --include="*.mjs" | grep -v node_modules
test-techniques.mjs:14:} from './shared/techniques.js';        ← the ONLY importer
shared/techniques.js:...                                        ← its own comments

$ grep -rn "cancel-charge|curve-kick|hold-fuse|hop-own-wall|strip-window|carry-super-use|activeEffects" \
    . --include="*.js" --include="*.mjs" | grep -v techniques.js
(no matches)
```

Zero references in `sim.js`, `server.js`, `client.js`, `bot-ai.js`, `training.js`. The drills that unlock
them are not wired into the training ground either. **It is a data module with passing unit tests and no
gameplay.** (This matches `OPEN_ITEMS.md`, which already lists it — I am confirming it, not discovering it.)

Consequence: **option (a) cannot be done without doing option (c) first.** Any "bots use the banana shot"
task is really "implement curved shots in the sim, for players, with client prediction — then teach bots."

### 2.2 VERIFIED — the ladder is behaviourally flat above L5

Every "fancy trick" in `bot-ai.js` is gated on `sk.toolSkill`. But `toolSkill` **saturates**: it climbs
0.372 → 0.850 over L0–L5 and only 0.850 → 1.000 over L5–L11. Executed:

| L | name | enemy t | partner t | enemy toolSkill | partner toolSkill | enemy aggro | enemy react |
|---|---|---|---|---|---|---|---|
| 0 | אימון | 0.050 | 0.050 | 0.372 | 0.372 | 0.652 | 0.452 |
| 1 | שלב 1 | 0.050 | 0.250 | 0.372 | 0.580 | 0.652 | 0.452 |
| 2 | שלב 2 | 0.250 | 0.680 | 0.580 | 0.917 | 0.860 | 0.260 |
| 3 | שלב 3 | 0.250 | 0.250 | 0.580 | 0.580 | 0.860 | 0.260 |
| 4 | שלב 4 | 0.250 | 0.050 | 0.580 | 0.372 | 0.860 | 0.260 |
| 5 | שלב 5 | 0.500 | 0.500 | 0.850 | 0.850 | 1.020 | 0.160 |
| 6 | שלב 6 | 0.500 | 0.250 | 0.850 | 0.580 | 1.020 | 0.160 |
| 7 | שלב 7 | 0.680 | 0.500 | 0.917 | 0.850 | 1.076 | 0.115 |
| 8 | שלב 8 | 0.820 | 0.250 | 0.970 | 0.580 | 1.120 | 0.080 |
| 9 | שלב 9 | 0.920 | 0.500 | 0.987 | 0.850 | 1.192 | 0.058 |
| 10 | שלב 10 | 1.000 | 0.820 | 1.000 | 0.970 | 1.250 | 0.040 |
| 11 | קטלני | 1.000 | 0.250 | 1.000 | 0.580 | 1.250 | 0.040 |

> ⚠️ **RE-CUT 2026-07-26 04:30.** The first version of this section tabulated gates `0.55 / 0.60 / 0.70 /
> 0.72 / 0.75 / 0.80`. That was exact when written and stale within the hour: the bot lane landed in
> `shared/bot-ai.js` during the same session and **the 0.72 cliff and the 0.80 wall-cannon pad no longer
> exist.** The 0.72 gate became `TOOL_MOBILITY_MIN = 0.45` + `toolNotice()` (a skill-scaled chance of
> spotting the chance), and the walk-to-a-pad was deleted outright and replaced by a lob-back. The table
> below is re-measured against the live file. **The conclusion did not change** — see the fresh histogram.

Live gates, read off `grep -n 'toolSkill >' shared/bot-ai.js`: **0.45 (×2) / 0.55 / 0.60 (×3) / 0.70 /
0.75 / 0.90**. Coverage on the enemy side (computed from `DIFFICULTY_LEVELS` × `skillVec`):

| gate | behaviour | enemy levels that clear it |
|---|---|---|
| 0.45 `TOOL_MOBILITY_MIN` | catchUpJump, coopPush (+`toolNotice` rate) | L2–L11 |
| 0.55 | wall-trap | L2–L11 |
| 0.60 | ambush, goal-screen, clearMarker | **L5–L11** |
| 0.70 | build/deflect set-piece | **L5–L11** |
| 0.75 | doubleBomb | **L5–L11** |
| 0.90 | tighter stuck limit | L7–L11 |

**The core defect survives the bot lane's fix: four gates, one identical unlock step at L4→L5, then
nothing changes for seven levels.** Lowering one cliff to 0.45 moved *one* pair of behaviours down; it did
not create a ladder. Confirmed by re-running the behaviour histogram on the current tree
(`node test-bot-tricks-fire.mjs 4 45`, 4 matches × 45 s per tier):

```
t=0.05: outletPass 35, zigzag 19, bombTackle 2, drive 2, workAngle 1                      (5 behaviours)
t=0.50: outletPass 76, coopPush 33, zigzag 32, ambushLurk 29, dodge 16, clearMarker 7,
        giveGo 5, ambushWall 4, ambushStrip 4, wallCannonJump 3, drive 3, catchUpJump 3,
        bombTackle 2, blockDrive 1                                                       (14 behaviours)
t=0.82: outletPass 59, zigzag 43, coopPush 25, ambushLurk 20, bombTackle 8, ambushStrip 7,
        catchUpJump 6, blockDrive 4, wallCannonJump 4, ambushWall 3, dodge 3, drive 2,
        clearMarker 1, giveGo 1                                                          (14 behaviours)
t=1.00: outletPass 61, coopPush 31, dodge 30, zigzag 30, ambushLurk 11, ambushStrip 10,
        blockDrive 7, clearMarker 6, drive 6, bombTackle 5, workAngle 4, wallCannonJump 3,
        ambushWall 2, catchUpJump 2, bushSteal 1                                         (15 behaviours)
```

t=0.50 (L5) and t=0.82 (L8) still have the **same repertoire — 14 tags each, and the same 14.** So the
honest answer to "how does a player tell an L8 bot from an L5 bot?" is: *today, they can't.* The
difference is entirely `react` 0.160 → 0.080 s and `aggro` 1.02 → 1.12, which reads as "slightly
twitchier", not as "smarter". This conclusion also does not depend on the sampling: the gate-coverage
table above is arithmetic, not a measurement.

*(Changed vs the first run, both from the bot lane's work: `cannonSetup` is gone from the tag universe,
and `wallCannonJump` — previously in the dead list — now fires 3–4× per tier.)*

**This is why the request is worth doing** — but it also means the deliverable is *ladder spread*, not
raw new power.

### 2.3 VERIFIED — 12 of the 28 existing behaviours never fired once

Tag universe **28**, re-counted on the live file (21 plain `bm.lastTrick = '…'` assignments + 7 that only
appear inside a ternary). It was 29 before the bot lane deleted `cannonSetup`.

Union of the four histograms above = **16** tags. Never observed at any tier: `cornerEscape`,
`cornerFinish`, `deflectSetup`, `deflectShot`, `doubleBomb`, `goalBank`, `goalScreen`, `overFinish`,
`passBank`, `postFinish`, `smashWall`, `watchdogRelease`.

> **Corrected:** the first version of this list included `wallCannonJump`. It fires now (3–4 per tier) —
> the bot lane's lob-back replaced the unreachable walk-to-a-pad, which is exactly the "revive a dead
> showpiece" work §6 recommends, already done for one of them. Going the other way, `cornerEscape`
> fired once at t=1.00 in the first run and not at all in this one. **Both are at the sampling floor at
> 4 matches × 45 s** — treat any tag with a count of 1–2 as "essentially never", not as a clean binary,
> and re-measure with a bigger *n* before building on the exact membership of this list.

Some are intentionally rare (`watchdogRelease` is a backstop; not firing is *good*). But `goalScreen`,
`deflectSetup`/`deflectShot` and `doubleBomb` are showpieces built on purpose that a player will never
see. **YAGNI warning: adding a 29th behaviour to a system where 12 of 28 are invisible is a worse
investment than making 3 of the existing 12 fire.** I flag this as a cheaper alternative in §6.

---

## 3. Research — what shipped games actually do

The question that decides the recommendation: **do real games give bots *distinct abilities*, or only
*better execution of the same abilities*?**

**Answer: better execution — and bots usually get a *smaller* verb set than players, never an exclusive
one.** All four references agree. This makes the feature smaller than "add new skills" sounds, and I am
reporting it that way on purpose.

| Game | What the bots get | Verdict |
|---|---|---|
| **Brawl Stars** | Bots are capped below Power 7, so they **never have Gadgets or Star Powers** — a strict *subset* of the player kit. They do use the base Super. Their documented tells are execution failures: they **auto-aim at the target's current position and never lead**, don't dodge shots, either spam three shots or barely shoot, and **fire the Super right after respawn**. Also capped to Super-Rare-or-below brawlers. | Subset + worse execution. *(Community wiki; Supercell does not publish bot specs — see caveat below.)* |
| **Fortnite** | Epic's stated intent: bots "behave similarly to normal players and will help provide a better path for players to grow in skill." Same weapons and items; but they **cannot build complex structures or edit**, and their "reactions are slower and less adaptive than those of humans." Bot count scales down as your skill tier rises. | Subset + worse execution. |
| **EA FC / FIFA** | Difficulty changes **reaction speed, anticipation, marking/pressure and pass precision**; Ultimate is described as "max AI stats". No CPU-exclusive moves. Legendary's most-criticised trait is the AI "reacting to button presses before the player's character executes the command." | Execution knobs only. Plus a **cautionary anti-pattern**. |
| **Roblox PvP** | The common third-party bot systems spawn bots that **wield the same item kits as players**, with tunable difficulty tiers ("relaxed sparring" → "intense showdowns"). | Same kit + tuned difficulty. |

**Fun-over-difficulty principle (cited, not invented).** Mick West, *Game Developer*, 2009 — "Intelligent
Mistakes: How to Incorporate Stupidity Into Your AI Code": **"Playing against a perfect opponent is no
fun. But playing against a crippled opponent is no fun either."** The techniques he prescribes are
probabilistic (not consistent) errors, deliberate suboptimal play, artificial inaccuracy, and *not*
exploiting perfect information. The canonical source is Lars Lidén, "Artificial Stupidity: The Art of
Intentional Mistakes" (*AI Game Programming Wisdom 2*, 2003): tune the AI so the player can win **without
the AI looking unintelligent**.

**Readability principle (cited).** *The Level Design Book*, "Enemy design": enemies should be
"predictable, with clear patterns for the player to recognize and exploit," with "design details and
animations that **telegraph** enemy state, intent, and strengths / weaknesses."

Note the codebase already follows this — the EXTREME tier's aim and pre-charge are deliberately
stochastic (`cheatFlub`, `preChargeP`) precisely so it "occasionally slips, giving a skilled player a
window", and a recent fix *bounded* pre-charge to 0.35 charge so "a telegraph survives". **Any new skill
must keep a telegraph. That is house style already.**

**Sourcing caveat, stated plainly:** the Brawl Stars bot details are from community wikis, not a Supercell
publication — Supercell does not document bot internals. The *direction* (bots below Power 7 → no
Gadgets/Star Powers) is corroborated across multiple community sources and by the observable fact that
bot matches run to ~100 trophies for a new brawler, but treat the exact numbers as community-VERIFIED,
not first-party.

---

## 4. The three options

### Gating fix that all three need (1 line)

Because `toolSkill` is saturated (§2.2), **gate new skills on the raw team scalar `t`, not on `toolSkill`.**
`skillVec(t)` currently drops `t` on the floor. Add it:

```js
// in skillVec(), before `return out`:
out.t = t;   // the RAW difficulty scalar. toolSkill saturates at 0.85 by L5 and cannot spread a ladder.
```

`memSkillVec`'s legacy-string path needs a fallback `t` (easy 0.25 / normal 0.50 / hard 0.82 /
extreme 1.00 — the existing `SKILL_ANCHORS` stops). Without this, every new skill lands on L5 alongside
everything else and the feature is invisible. **This is a change to `bot-ai.js`, which another agent is
actively in; it must be sequenced, not raced.**

---

### Option (a) — bots use the 6 player techniques

**Do not pick this as written.** Per §2.1 the techniques do not exist for players, so this is option (c)
with extra steps. What *does* legitimately fit the label "a technique players have and bots do not":

**A1 — Wall-push placement (`buildDist`).** The sim reads `p.aimMag = clamp(inp.buildDist, 0, 1)` and
places the wall at `BUILT_WALL.offset(60) + buildDist × BUILD_DIST_MAX(120)`, i.e. up to 180 px out.
`finalize()` never emits `buildDist`, so **every bot wall in the game lands at 60 px — at the bot's own
feet.** Players can push theirs to 180. This is the *only* real player-vs-bot capability gap that is
actually implemented, and it needs zero sim work.

That is one skill, not six. It is carried into option (b) as **B3** rather than being its own option.

### Option (b) — 4 new bot-only behaviours ← RECOMMENDED

No new mechanics. Existing verbs only (`moveX/moveY`, `aimX/aimY`, `hold`, `fire`, `aimed`, `special`,
`build`, `buildHold`, `buildDist`, `sax/say`). Every skill below is something a human could do by hand
today.

---

**B1 — משמעת סופר · Super discipline** — gate `t ≥ 0.50`, second tier at `t ≥ 0.82`

Today a bot spends overcharge only via `overFinish`, which **never fires** (§2.3), so super is effectively
wasted at random. Ladder it, using the documented Brawl Stars bot tell as the low end:

- `t < 0.50` — dump it on the next available shot (the Brawl-Stars "presses Super right after respawn" tell).
- `t ≥ 0.50` — hold super for a shot at a **keeper**, because MECHANICS §4 makes overcharge the only kick a keeper cannot catch (`sim.js:939`, `KEEPER_BREAK_ROLL`).
- `t ≥ 0.82` — additionally hold super to **body-strip** a carrier on contact (MECHANICS §5 `resolveSuperBodyStrip`).

**Readable tell — already on screen, zero client work.** `p.power` is on the wire (`wire.js` `packFlags`
bit 64) and `client.js:5623` draws the pulsing red overcharge ring for **every** player, not just the
local hero. So a bot walking at you with the ring still lit is literally announcing "I am going to
body-strip you."
**Counter:** don't dribble into it — pass, shoot it first (a hit spends nothing but breaks the approach),
or wall it off. The ring also has a 4 s TTL (`OVERCHARGE_TTL`), so waiting it out is a real option.

---

**B2 — שוער · Goalkeeper** — gate `t ≥ 0.68`

The sim **already has a keeper rule** and no bot ever plays it deliberately: `sim.js:936` dead-stops the
ball and increments `stat.saves` when a defender in the box catches a weak-or-full kick. Bots only ever
*shadow* and *mark*; `goalScreen` never fires. So: when the enemy carrier enters our half and no bot is
goal-side, the support bot commits to a keeper arc — patrol at ~`PENALTY.depth` from the line, tracking
the ball's y, clamped inside `PEN_TOP..PEN_BOT`, instead of chasing.

**Readable tell:** the bot visibly **stops chasing and stands on its line**, sliding side to side. That
is a completely different silhouette of movement from every other bot behaviour.
**Counter — already implemented and symmetric:** the bot's own `cornerFinish` logic predicts a keeper's
slide and shoots the corner it is moving away from; the player does the same, or breaks it with
overcharge (`KEEPER_BREAK_ROLL`), or draws it out with a pass. Nothing new to learn — it teaches an
existing mechanic.

---

**B3 — קיר רחוק · Distant wall** — gate `t ≥ 0.82`  *(the salvaged half of option (a))*

Emit `buildDist` from `finalize()`, scaled by `t`. Low tiers keep the current at-your-feet wall (60 px);
high tiers push to 180 px, which lets a bot cut the lane **in front of you** rather than beside itself —
turning the existing `blockDrive`/`goalScreen` traps from "wall I can walk around" into "wall across my
run."

**Readable tell:** the wall appears a clear body-length **in front of** the bot instead of at its feet,
after the same `BUILD_WINDUP` ghost telegraph players already see.
**Counter:** a built wall is hp3 and a **full-charge shot destroys it in one hit** (MECHANICS §6); or go
around; or note that `BUILD_RELOAD` is 15 s per charge so a spent wall is 15 s of free lane.

---

**B4 — מלקחיים · Pincer** — gate `t ≥ 0.92` (top three levels only)

`assignRoles` deliberately holds the off-ball bot at `MIN_SEP = 320` px from the carrier so both bots
never crowd the ball — correct as a default. At `t ≥ 0.92` only, and only in **our own half**, allow the
support bot to break `MIN_SEP` and close from the side **opposite the carrier's heading**, cutting the
escape lane while `onBall` presses.

**Readable tell:** the two bots visibly **split and converge from two sides** — the one bot-behaviour
that is obvious from a glance at the minimap-scale picture.
**Counter:** release early. A pincer beats dribbling and loses to a first-touch pass, which is exactly
the skill we want teens to learn. **This is the one skill that can feel unfair** — hard rate-limit it
(cooldown via `sk.cdMul`), own-half only, and it must abort the moment the carrier passes.

---

**Resulting ladder — the spread this buys** (from the measured scalars in §2.2):

| skill | gate | enemy side (levels) | partner side (levels) |
|---|---|---|---|
| B1 super discipline (hold-for-finish) | t ≥ 0.50 | L5–L11 | L2, L5, L7, L9, L10 |
| B2 goalkeeper | t ≥ 0.68 | L7–L11 | L2, L10 |
| B3 distant wall | t ≥ 0.82 | L8–L11 | L10 |
| B1 super discipline (body-strip) | t ≥ 0.82 | L8–L11 | L10 |
| B4 pincer | t ≥ 0.92 | L9–L11 | — |

A player climbing the ladder now meets a **new, nameable behaviour at L5, L7, L8 and L9** instead of
seven levels of "slightly faster reactions". That is the whole point of the feature.

*Note the partner column is not monotonic — that is the existing ladder's design (L2 pairs a weak enemy
with a strong partner), not a bug I am introducing. It does mean an L2 player sees a keeper on their own
team; that is a help, not a threat, so it is fine.*

---

### Option (c) — new mechanics for players and bots

Honestly the expensive one. Three candidates, cheapest first; all touch `sim.js`, and all three are
already *specified* in `techniques.js`, so this is "implement the technique backlog", not new design.

- **C1 — `cook` / bomb fuse hold.** Hold the special to shorten the fuse. Needs: a hold-duration input
  field, `sim.js` fuse logic, and the remaining fuse on the wire so the client's bomb timer matches.
  **Medium.** Lowest desync risk of the three (bombs are already server-driven).
- **C2 — `banana` / curved shot.** Lateral acceleration on a kicked ball. Needs: ball spin state in
  `sim.js`, a spin field in `wire.js`, and matching client prediction. **High desync risk** — the client
  predicts ball flight, so any divergence in the spin integrator is visible as the ball teleporting.
- **C3 — `vault` / hop over your own wall.** **Verified blocker:** the sim has **no vertical axis at all**
  (`grep -n "airborne|\.z =|hop|height" shared/sim.js` → no matches; the bomb rocket-jump is a planar
  impulse, not a jump). This means inventing a new physics axis plus a wire bit plus client prediction
  plus collision exceptions. **Do not start here.**

If option (c) is wanted, do **C1 only**, ship it for players first, and only then teach bots to use it —
which at that point is a small option-(b)-shaped addition.

---

## 5. Cost table

| | (a) as written | (a) salvaged = B3 | **(b) RECOMMENDED** | (c) C1 only | (c) all three |
|---|---|---|---|---|---|
| Files touched | ≥6 | 1 (`bot-ai.js`) | **1 (`bot-ai.js`)** | 4–5 | 6+ |
| `sim.js` involved | **yes** | no | **no** | **yes** | **yes** |
| `wire.js` / format change | **yes** | no | **no** | **yes** | **yes** |
| Client prediction work | **yes** | no | **no** | some | **lots** |
| Desync risk | med–high | **none** | **none** | low–med | **high** |
| New tests | 4–6 | 1 | **~4** | 3–4 | 8+ |
| Blocked on other agents | `client.js` (in flight) | `bot-ai.js` | `bot-ai.js` | `client.js` + `sim.js` | everything |
| Player-visible ladder spread | none | L8 | **L5 / L7 / L8 / L9** | none by itself | none by itself |

**Why (b) has zero desync risk — verified, not assumed.** `bot-ai.js` is imported by `server.js` and by
test harnesses only; `grep -rn "bot-ai" public/` returns **nothing**, so the client never runs bot AI.
`computeBotInputs` returns exactly the struct a human client sends —
`{ seq, moveX, moveY, aimX, aimY, hold, fire, aimed, special, build, buildHold, sax, say }` — and the
server feeds it into the same sim path at `server.js:302`. Bots are pure server-side input producers.
Changing how they *decide* cannot desync anything, and `buildDist` (B3) is a field the sim already
consumes (`sim.js:739`).

**Test burden for (b)** — house style, standalone `node test-*.mjs`, `ALL PASS`/`N FAILURE(S)`:

1. `test-bot-skill-ladder.mjs` — each new skill fires at/above its gate and **never below it**, on both
   the enemy and partner scalar. This is the test that would have caught the §2.2 saturation bug.
2. Extend the existing behaviour histogram to assert the 4 new tags are non-zero at their tiers (reuse
   `test-bot-tricks-fire.mjs`'s pattern; **do not edit that file** — the bot-lane agent owns it).
3. `test-bot-keeper.mjs` — a keeper bot actually registers `stat.saves`, and overcharge still beats it
   (guards the counter, i.e. guards *beatability*).
4. `test-bot-pincer.mjs` — pincer aborts on a pass, respects its cooldown, and never triggers in the
   attacking half.

Plus the whole suite stays green: `for f in test*.mjs; do node $f; done`.

---

## 6. The cheaper alternative, stated for honesty

If the real complaint is "high-level bots feel the same as mid-level bots" (which §2.2 says is literally
true), then **fixing the gating axis (§4, one line) and making `goalScreen` / `deflectSetup` /
`doubleBomb` actually fire is a smaller change with a similar payoff** than adding four new behaviours.
12 of 28 existing behaviours are invisible to players (§2.3), and the bot lane has since revived a 13th
(`wallCannonJump`) this way, which is evidence for this route rather than against it. Option (b) and this
are not exclusive — but
if only one is approved tonight, the gating fix is the highest value per line.

---

## 7. What I need from the user

1. **(a) / (b) / (c)** — recommendation is **(b)**, with A1 folded in as B3.
2. **All four B-skills, or fewer?** B4 (pincer) is the one most likely to feel unfair to a teen; B1/B2/B3
   are safe. Dropping B4 costs nothing structurally.
3. **Also do the §6 gating fix + revive dead behaviours?** (cheap, high value, independent)
4. **Sequencing:** `bot-ai.js` has another agent in it as of tonight. This work must wait for that lane
   or take the `football-mock:shared/bot-ai.js` lock.

---

## Appendix — labels

- **VERIFIED:** §2.1 (technique module unwired), §2.2 (toolSkill saturation + flat repertoire, executed),
  §2.3 (12 dead behaviours, executed), the keeper rule at `sim.js:936/939`, `p.power` on the wire and
  drawn for all players (`client.js:5623`), `buildDist` consumed but never emitted, no vertical axis in
  the sim, bot-AI absent from the client. All from reading the code or running it.
- **VERIFIED (external, cited):** §3 — Brawl Stars / Fortnite / EA FC / Roblox bot behaviour; Mick West
  2009; Lidén 2003; Level Design Book enemy design. Brawl Stars specifics are community-sourced (caveat
  stated in §3).
- **INFERRED (my proposals, not shipped by anyone):** every B-skill and C-candidate, their gate values,
  and the ladder table in §4. The *shape* follows the cited industry pattern (better execution of the
  same verbs); the specific gates are mine and are tunable.

### Sources

- [Fortnite bots — Epic's stated intent and bot behaviour](https://computercity.com/software/gaming/does-fortnite-have-bots)
- [Fortnite bots and skill tiers](https://screenrant.com/fortnite-bots-skill-rank-epic-games-casual-play/)
- [Fortnite ranked bot-density adjustments](https://bestgameboost.com/news/fortnite-targets-bot-accounts-in-ranked-br/)
- [Brawl Stars — how to tell a bot (no Gadgets/Star Powers, auto-aim, no dodging, Super after respawn)](https://brawlstarsconception.fandom.com/wiki/How_to_tell_if_a_player_is_controlled_by_a_bot)
- [Brawl Stars — bot matches up to ~100 trophies on a new brawler](https://www.speedrun.com/brawl_stars/forums/yye6t)
- [Brawl Stars matchmaking and bots at low trophies](https://www.zleague.gg/theportal/understanding-matchmaking-in-brawl-stars-level-discrepancies-and-trophy-dynamics-explored/)
- [EA FC / FIFA difficulty levels](https://www.fifplay.com/fc-26-difficulty-levels/) · [FC 26 difficulty explained](https://fifauteam.com/fc-26-difficulty-levels-explained/) · [Legendary AI criticism (EA Forums)](https://forums.ea.com/discussions/fc-26-general-discussion-en/legendary-mode-is-developers-complete-failure/13284251)
- [Roblox PvP bots — same item kits, tunable difficulty tiers](https://builtbybit.com/resources/pvpbots-fight-human-like-ai.51152/)
- [Mick West, "Intelligent Mistakes: How to Incorporate Stupidity Into Your AI Code", Game Developer, 2009](https://www.gamedeveloper.com/programming/intelligent-mistakes-how-to-incorporate-stupidity-into-your-ai-code)
- [Lars Lidén, "Artificial Stupidity: The Art of Intentional Mistakes", AI Game Programming Wisdom 2, 2003 (PDF)](http://www.liden.cc/lars/WEB/Resume/Papers/2003_AIWisdom.pdf)
- [The Level Design Book — Enemy design (telegraphing, predictable patterns)](https://book.leveldesignbook.com/process/combat/enemy)
