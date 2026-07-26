# Do the bots behave like the handoffs say — and can they use the skills on ANY pitch?

**Written 2026-07-26 ~18:00 by the agent the user asked to read this folder.** Nothing in `shared/`
was touched. What was added: `bot-skill-census.mjs` (a new instrument), `scripts/build-arena-watch.mjs`
+ `scripts/arena-watch.template.html` → `public/_arena-watch.html` (a watchable all-bot page), and
this document.

The two handoffs beside this file measured skills in **fixtures**. This is the complementary test:
**whole matches, at level 10, on seven different layouts**, counting what the bots actually reach for.

```
node bot-skill-census.mjs                    # level 10 as shipped (partner 0.42 v enemy 0.93)
MIRROR=1 node bot-skill-census.mjs           # both sides 0.93 — the fair bot-vs-bot show match
MATCHES=8 SECS=90 JSON=out.json node bot-skill-census.mjs
```
Arenas: `main` (ships) · `threes` (the 3v3 layout) · `classic` (old default) · `empty` · three
**generated** mirror-symmetric layouts. Every number below is 4 matches × 60 s per arena, seeded
(`SEEDBASE=20260726`), i.e. 28 matches per column set.

---

## 0. A trap this harness fell into first — read before writing another one

My first run reported one match with **171 releases** (vs ~12 elsewhere) and a bot "kicking weakly in
a loop". It was the **goal-celebration freeze**: `sim.js:646` returns before the player loop while
`resetTimer > 0`, but `computeBotInputs` keeps running and a live charging latch emits `fire` on
**every tick of the freeze** (~164 ticks ≈ 2.7 s). Counting inputs there invented the bug.

`bot-skill-census.mjs` now computes `frozen = s.resetTimer > 0` **before** `step()` (after it, the
timer has already been decremented for that tick) and skips all accounting. This is §3 of
`LOGIC-HANDOFF-session.md` again, in a new costume: *a metric that cannot answer the question*.
Anything counting bot INPUTS rather than sim EFFECTS needs the same guard — including any future
"idle"/"spam" metric.

---

## 1. The handoffs' code claims: all confirmed live on HEAD (`582cb2e`)

Line numbers in the research handoff have drifted (`bot-fix` has been editing all day); the defects
have not.

| Claim | On HEAD | Where |
|---|---|---|
| `pointInBush()` ignores `state.arena` | **TRUE** | `arena.js:37`, called from `bot-ai.js:439`, `:823`, `:1959` — none passes state |
| Release ladder shoots from `distGoal < 1150` while a kick rolls 647 px | **TRUE** | `bot-ai.js:1727` and `:1732` |
| Pass charge is `dist / 950`, windows disjoint | **TRUE** | `bot-ai.js:1640`, `:1699`, `:1750` |
| Every bot bullet clamps to `FULL_CHARGE + 0.01` = 0.71 | **TRUE** | `bot-ai.js:3023` |
| No bot can fire a quick tap (`aimed: fire`) | **TRUE** | `bot-ai.js:3124` |
| `botCanSee` has no wall line-of-sight test | **TRUE** | `bot-ai.js:434-457`; `sim.js:136-137` does call `segBlockedByWall`, `bot-ai.js` never does |
| Aim-point ladder is walls-only, so a body never opens the corners | **TRUE** | `bot-ai.js:1437-1441` (`enemies: false`) |
| `settings.shotPower \|\| 1850` stale fallback (it is 1400) | **TRUE**, 7 occurrences | `bot-ai.js` |

**Already fixed since the research was written** (so don't re-report): the ball-release charge clamp
(`:3021-3022` now fires at the charge asked for, with the reasoning in the comment), `FINISH_RANGE`
derived from `ballRollPx` (`:1297`), the screen-shaped `VIEW_BOX`, and the wall-aim latch.

---

## 2. What the bots actually DO, measured — level 10, seven arenas

### The single biggest live defect: shots that cannot arrive
Classified by the release's **own aim** (the `<1150` rung sets no `lastTrick`, so a tag histogram
cannot see it): a release within 25° of the goal direction is a shot at goal.

| | as shipped (0.42 v 0.93) | mirrored (0.93 both) |
|---|---|---|
| shots at goal / match | 7.50 | 4.75 |
| …fired from **beyond** `ballRollPx(1)` = 647 px | **5.75 (77%)** | **3.21 (68%)** |

Every arena, every seed. `FINISH_RANGE` was rebuilt on the roll model; the release ladder never was.

### Kicks a defender simply catches
`80%` of releases (10.21 of 12.75/match) leave **below `FULL_CHARGE` 0.70**, and a below-full kick is
caught outright by any field defender in the lane. Zero releases land under `QUICK_CHARGE`, so the
float-sum tap trap is not firing in play.

### The pitch changes and the bots do not notice
`pointInBush()` reads the default arena's three rectangles on every layout, so "the ball is hidden"
is decided by geometry that is not there. A loose ball believed hidden with nobody inside
`BUSH_REVEAL_DIST` 110 px is invisible to **both teams**:

| | main | threes | classic | empty | rand#1 | rand#2 | rand#3 |
|---|---|---|---|---|---|---|---|
| loose-ball ticks in a **phantom** bush | 20.8% | 3.8% | 0% | 4.0% | 4.1% | 7.9% | **46.9%** |
| **blind to the ball**, % of loose ticks | 18.6% | 1.1% | **31.3%** | 1.7% | 1.5% | 4.7% | **44.7%** |
| blind seconds / match | 7.8 | 0.5 | 13.4 | 0.7 | 0.6 | 1.5 | **18.6** |
| **worst single blind spell** | **20.9 s** | 0.5 s | **48.5 s** | 0.6 s | 0.5 s | 1.1 s | **37.4 s** |
| loose ball in a **real** bush of THIS pitch | 9.3% | 8.6% | 33.0% | 0% | 17.7% | 25.5% | 11.1% |

(mirrored run; the shipped pairing gives the same shape — main 10.4% blind, worst 8.2 s.) Two
independent facts here: the blindness is **arena-dependent and can exceed half a minute**, and real
cover is ignored, so "hide in a bush" does nothing against bots while it works against a player.

Layout also silently deletes whole skills: **no fragile-wall snipes and no walls shot down at all**
on `threes` and two of the three generated layouts, because a fragile wall only exists where one can
be built over a bush. Nothing in `bot-ai` knows the difference.

### The skill catalogue, scored in real matches
Episodes per match, mirrored 0.93 (28 matches). Full table in the census output.

| Reaches for it constantly | per match | | Barely or never | per match |
|---|---|---|---|---|
| pass + outlet | 14.68 | | fragile-wall snipe | 1.18 |
| meet the pass / give-and-go | 7.82 | | wall cannon | 0.93 |
| body / goal screen | 7.43 | | bullet at a loose ball | 0.68 |
| rocket mobility (bomb jump) | 6.29 | | snooker deflection | 0.54 |
| pincer trap | 5.96 | | post / corner finish | 0.57 |
| super body strip | 5.07 | | bank off the stone | 0.36 |
| clear it forward | 3.68 | | bomb a loose ball clear | 0.21 |
| bush ambush | 3.50 | | smash a fragile wall | 0.14 |
| kick-and-fly | 3.21 | | walk it in | 0.07 |
| bomb the carrier | 2.57 | | **catapult (full combo)** | **0.07** |
| anticipation wall | 2.25 | | **cannon pass (ball kept)** | **0.00** |
| keeper on the line | 1.96 | | **quick tap / slow stacks** | **impossible** |

**Never fired in 28 matches, on any arena: `goalBank`, `watchdogRelease`** (and `superDump`, which is
a low-tier tag and correctly absent at 0.93). `goalBank` matches the research finding of 0 banks in
1103 positions — the reflection is `atan(tan i / 0.62)`, not a mirror, so the solver never finds one.

The **catapult** is the sharpest gap: `catapultSetup` fires 2.61/match and `catapultRide` 2.61, but
the tag for the actual bomb plant (`catapult`) fires **0.07** — the combo is set up ~37× more often
than it completes. `cannonPass` (a mate's bomb flinging the carrier with the ball attached, T1 in the
catalogue) happened **zero** times mirrored and once in 28 shipped-pairing matches.

So: **most of the repertoire is genuinely in use** — the handoffs' "nothing is implemented" applies
to the *research* skills, not to the 46 tagged plays, 43 of which fire. What is missing is the last
step of two combos, the bank shot, and everything gated behind a quick tap.

---

## 3. Watch it: `public/_arena-watch.html`

Bird's-eye 2v2 at level 10 with a **new random seed and a newly generated layout every match**, the
real `sim.js` + `bot-ai.js`, every named play announced in words, and overlays for the 647 px kick
range and the blind-ball radius. `node scripts/build-arena-watch.mjs out.html --dev` writes both the
standalone file and the in-repo dev page (live `/shared` imports — restart the server after editing
`shared/`). A published standalone copy is with the user.

Verified by driving it in headless Chrome over CDP (per `pikme-football-verify-with-chrome`): clock
advances, 18 of 27 catalogue skills appeared inside three matches, arena switching and re-seeding
work, zero exceptions.

---

## 4. If you are fixing something next, this is the order the measurements argue for

1. **Gate the release ladder on reach** (`bot-ai.js:1727/:1732`): `distGoal <= ballRollPx(state, 1) * 0.95`, else fall to the outlet. 77% of shots at goal currently cannot arrive; it is the largest single leak and it is three lines.
2. **Thread `state` into `pointInBush(x, y, state)`** with the module const as fallback (`client.js:6558` already works around this). Expect it to move every ambush/lurk number — measure the ladder after.
3. **Size the pass from `chargeForRoll`** with a floor at `FULL_CHARGE`, so a pass that completes is also one a defender cannot catch.
4. **Split the bullet `fireAt`**: strip needs 0.71, knockback wants 1.0 (250 px of drift vs 343).
5. Then the catapult's missing plant edge, and `botCanSee`'s wall LOS.
