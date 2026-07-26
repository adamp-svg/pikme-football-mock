# Bot AI — full handoff

**Written 2026-07-26 by agent `bot-fix`, at the end of a ~10h session.**
Audience: the next agent(s) picking up bot work. Read §00 and §0 before touching anything.

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

1. **`test-bot-ladder.mjs`**: pre-fix it passes with rho 0.90 and spread **exactly 0.60** — the gate is a
   knife edge (§5.4 already says the headroom is spent). These fixes move possession and finishing, so
   the spread must be re-measured at `SEEDS=6` and the levels retuned if it slipped; do NOT "fix" it by
   lowering the gate. `test-bot-partner.mjs` is the previously-logged level-table conflict.
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
| `test-bot-ladder.mjs` | does the 0..1 skill AXIS rank? | **`SEEDS=6` before quoting any number.** Currently rho 0.90, spread 0.60, control 0.00 |
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
