# The bots — complete reference

**Every number here was read out of the code or measured today (2026-07-26, HEAD `e2b93b0`+).**
Where a figure is measured it says on what: arena, skill, sample. `docs/MECHANICS.md` is the *game's*
rules; this is the *bots'*. The per-round history is `summery/BOT_HANDOFF.md`; the research is
`summery/bots logic handoff/`.

Everything lives in one file: **`shared/bot-ai.js`** (~3.3k lines), imported by `server.js` for real
matches and by ~20 `test*.mjs` harnesses. It is deterministic — seeded, no `Math.random` in the
decision path — so any match can be replayed exactly and any A/B can be paired.

---

## 1. The 12 difficulty levels

A level sets **two** skill scalars: how strong the ENEMY bots are, and how good the human's PARTNER is.
Both climb, the enemy faster, so the net is monotonically harder. `shared/difficulty.js` owns this table
and both client and server read it.

| level | name | enemy | partner | XP shown | player sees |
|---|---|---|---|---|---|
| 0 | אימון | 0.05 | 0.10 | 0 | רמה 1 |
| 1 | שלב 1 | 0.13 | 0.18 | 100 | רמה 2 |
| 2 | שלב 2 | 0.22 | 0.26 | 300 | רמה 3 |
| 3 | שלב 3 | 0.31 | 0.34 | 600 | רמה 4 |
| 4 | שלב 4 | 0.40 | 0.42 | 1000 | רמה 5 |
| 5 | שלב 5 | 0.49 | 0.48 | 1500 | רמה 6 |
| 6 | שלב 6 | 0.58 | 0.50 | 2100 | רמה 7 |
| 7 | שלב 7 | 0.67 | 0.50 | 2800 | רמה 8 |
| 8 | שלב 8 | 0.76 | 0.48 | 3600 | רמה 9 |
| 9 | שלב 9 | 0.85 | 0.45 | 4500 | רמה 10 |
| 10 | שלב 10 | 0.93 | 0.42 | 5500 | רמה 11 |
| 11 | קטלני | 1.00 | 0.38 | 6600 | רמה 12 |

- **Default is level 5.** The level comes from the player's XP (`botLevelFromXp`), so bots climb with
  the player and cap at 11.
- **The partner ARCS** — it rises to a competent 0.50 by mid-ladder and then eases back. Both sides
  rising together measured almost flat (a better team-mate cancels a better enemy).
- ⚠️ **The LAN browser has no `window.SALTIZ_XP`, so `http://<host>:3012/` runs LEVEL 0.** Half the
  "the bots are dumb" reports in this repo's history are that. Judge bots with `?diff=9`, or
  `?watch=1&diff=N` to watch an all-bot match.

## 2. The skill vector — 17 knobs, interpolated on one 0..1 axis

`skillVec(t)` interpolates between five anchors (t = 0.00 / 0.25 / 0.50 / 0.82 / 1.00). Every knob is
*execution*: how well, how fast, how far — never "which plays do I know".

| key | what it controls | L0 | L5 | L10 |
|---|---|---|---|---|
| `react` | reaction latency, seconds | 0.45 | 0.16 | 0.06 |
| `aimSigma` | aim noise, radians | 0.15 | 0.04 | 0.02 |
| `aimTau` | aim smoothing time | 0.70 | 0.25 | 0.14 |
| `turnRate` | how fast the aim slews | 5.8 | 15.7 | 33.3 |
| `leadGain` | how well it leads a moving target | 0.73 | 0.99 | 1.11 |
| `toolSkill` | notices tool opportunities (**saturates by L5 — do not gate new behaviour on it**) | 0.37 | 0.84 | 0.99 |
| `evade` | dodges bullets/bombs | 0.50 | 0.91 | 0.99 |
| `aggro` | scales press/strip ranges and how soon it unloads | 0.65 | 1.01 | 1.20 |
| `chargeRate` | how fast the shot charge builds | 0.67 | 1.24 | 2.88 |
| `cdMul` | tool cooldown multiplier (lower = faster) | 1.38 | 0.86 | 0.42 |
| `visionMul` | scales the view box | 0.92 | 1.10 | 1.52 |
| `wallCommit` | seconds it commits to a detour | 0.45 | 0.50 | 0.82 |
| `detourRatio` | how much longer a detour may be | 2.36 | 1.19 | 1.08 |
| `flowAhead` | nav waypoint look-ahead, cells | 2.0 | 3.0 | 4.6 |
| `navLag` | how stale its path may be | 0.28 | 0.12 | 0.04 |
| `memoryS` | seconds it remembers an unseen enemy | 0.39 | 0.89 | 1.93 |
| `chaseReact` | delay before committing to a loose ball | 0.33 | 0.16 | 0.02 |

**Vision is a rectangle, not a radius:** `VIEW_BOX` 606 × 341 half-extents × `visionMul` — the client
camera's own shape (1212 × 682 world px at `CAM_ZOOM` 1.65). A circle used to give bots ~2× the
vertical awareness of the human they play against.

**No tier cheats except the top, and that is capped:** no x-ray at any level; the top tier's
pre-charge is probabilistic (`preChargeP`, ramping in from t=0.92) and its aim deliberately slips
(`cheatFlub`). `visionMul` 1.60 ≤ 1.65, i.e. never wider than the human camera.

## 3. What unlocks where — the behaviour gates

Gated on `t` (the raw scalar), **never** on `toolSkill`, which saturates at 0.85 by L5 and so cannot
rank anything above it.

| gate | behaviour | enemy levels | partner levels |
|---|---|---|---|
| `T_SUPER_HOLD` 0.50 | hold the overcharge for a finish instead of dumping it | L5–L11 | L2, L5, L7, L9, L10 |
| `T_KICK_FLY` 0.58 | kick the ball ahead, then bomb-jump after it | L6–L11 | — |
| `T_KEEPER` 0.68 | play a real goalkeeper | L7–L11 | L2, L10 |
| `T_CATAPULT` 0.74 | the team wall+bomb catapult | L8–L11 | — |
| `T_SUPER_BODY` 0.82 | spend the overcharge as a body strip | L9–L11 | — |
| `T_FAR_WALL` 0.82 | push the built wall out to 180px (players always could) | L9–L11 | — |
| `T_PINCER` 0.92 | break spacing and trap the carrier from two sides | L10–L11 | — |
| `TOOL_MOBILITY_MIN` 0.45 (`toolSkill`) | bomb-jump for mobility at all | L3+ | most |

### The "level 5 and above" ramp

Some abilities are not a switch but a frequency, per the product ask *"randomly from level 1 very few
times, to almost always level 5 and above"*. `levelChance()` ramps on `t` between **0.10 and 0.49**:

| level | 0 | 1 | 2 | 3 | 4 | 5 | 6+ |
|---|---|---|---|---|---|---|---|
| chance | never | ~7% | ~28% | ~50% | ~72% | ~94% | always |

Deterministic (`seededNoise` over bot hash + behaviour key + a ~1.1 Hz time bucket), so replays match.
It gates: the full-power ceiling, readiness charging, the goal-side press shift, the loose-ball bullet,
and how often bomb travel re-arms.

**This is not a handicap.** Stochastic handicaps are refuted here 8 times (`decisionHz` ×7, `mistakeP`):
those insert a coin flip *between deciding and acting*. A frequency ramp on an *ability* is the shape of
`toolNotice` and `preChargeP`, both of which ship and both of which rank.

## 4. Personalities

Four identities, drawn in **complementary pairs** per room so a team is never two of the same. Keyed on
SLOT and mirrored across teams — keying on bot id once handed one team a permanent edge and collapsed
the ladder from rho 1.00 to −0.10.

| | Enforcer | Fortress | Bodyguard | Ball Hawk |
|---|---|---|---|---|
| identity | "if I can see an enemy, I'm preparing to hit them" | "you don't get a clean route to our goal" | "the carrier gets a protected route" | "loose ball means my plan is cancelled" |
| `chase` | 0.50 | 0.40 | 0.25 | **1.00** |
| `escort` | 0.40 | 0.50 | **1.00** | 0.50 |
| `guardGoal` | 0.30 | **1.00** | 0.40 | 0.35 |
| `hunt` | **1.00** | 0.55 | 0.80 | 0.50 |
| `wall` / `bomb` | 0.70 / 1.15 | **1.25** / 0.85 | 0.90 / 0.90 | 0.80 / 1.00 |
| `maxCharge` | 1.00 | 0.85 | 1.00 | 0.75 |
| `ready` | 1.00 | 0.60 | 0.85 | 0.30 |

Room rotations: `enforcer+fortress` · `bodyguard+enforcer` · `ballhawk+fortress` · `enforcer+ballhawk`.

**Measured identities** (`test-bot-personas.mjs`, within one match so the opponent can't confound it):
Fortress own-box occupancy 27.1% vs Enforcer 21.7% · Ball Hawk owns the chase 57.7% vs Bodyguard 42.3% ·
Enforcer banked-charge time 94.7%.

Two axes stopped discriminating **by design**: charge (every persona is full-power from L5) and
goal-side positioning (every presser now shifts goal-side). Both are recorded in the test.

**Not measurable in play:** escort *stationing*. Mean possession is 0.68 s, so a Bodyguard that just
conceded a loose ball cannot cross 400 px to an escort point before the carry ends.

## 5. Every play the bots run

46 named plays, each tagged on `bm.lastTrick` so every instrument can count it. Episodes per match at
level 10, both sides 0.93, 7 arenas × 3 × 45 s:

**Charging / shooting** — `readyCharge` 224 (a held state, not an event) · `drive` 1.7 · `postFinish` 0.33 ·
`overFinish` 0.29 · `cornerFinish` 0.14 · `walkIn` 0.10 · `smashWall` 0.05 · `goalBank` **0** ·
`superHold` 0.76 · `superDump` 0 at this tier (it is the low-tier tell) · `watchdogRelease` **0**

**On the ball** — `zigzag` 11.3 · `workAngle` 6.8 · `clearForward` 3.3 · `passLatch` 7.1 ·
`outletPass` 4.9 · `giveGo` 2.0 · `passBank` ~0 · `kickAndFly` 4.0 · `kickFlyCannon` 0.10 ·
`catapultRide` 1.8

**Off the ball** — `chaseCommit` 53.8 · `fetchBall` 0.86 · `receivePass` 5.1 · `bodyScreen` 5.1 ·
`goalScreen` 0.76 · `screenWall` ~0 · `coopPush` 1.6 · `dodge` 9.4

**Defending** — `pressIntercept` 17.8 · `secondPress` 6.1 · `pincer` 3.4 · `superBodyStrip` 2.1 ·
`clearMarker` 0.43 · `pushAngle` 0.33 · `goalKeep` 1.3 · `blockDrive` 1.2 · `ambushWall` 1.1 ·
`ambushLurk` 2.6 · `ambushStrip` 1.5 · `bushSteal` 0.24 · `bombTackle` 0.86 · `doubleBomb` 0.29 ·
`deflectSetup` / `deflectShot` ~0

**Mobility / rescue** — `chaseJump` 4.1 · `catchUpJump` 0.33 · `wallCannonJump` 1.1 ·
`aimlessEscape` 4.7 · `cornerEscape` 0.14 · `stuckEscape` 0.05

**New this session** — `ballPush` 5.7 (shoot a contested loose ball clear) · `catapultSetup` 1.9 /
`catapultWall` 0.43 / `catapult` 0.14 (the combo is set up ~14× more often than it completes).

**Never fires anywhere: `goalBank` and `watchdogRelease`.** The bank solver finds 0 banks in 1103
positions because a wall reflection is `atan(tan i / 0.62)`, not a mirror.

## 6. The techniques, and whether a bot can actually do them

Sixteen tricks were measured in the real sim (`summery/bots logic handoff/SKILL_CATALOGUE.md`).

| technique | works? | do the bots use it? |
|---|---|---|
| Pass with a kick | ✅ | constantly (12/match) |
| Intercept the carrier's run | ✅ | 17.8/match |
| Anticipation wall (strip on the tick it appears) | ✅ | 2.3/match |
| Anticipation bomb / lob at a predicted spot | ✅ 100% inside a 95–350px band | 1.2/match |
| Bomb mobility (653px per fuse+glide, 869 with stone behind) | ✅ | 5.5/match |
| Kick-and-fly (release, then bomb after it) | ✅ | 4.0/match |
| Wall cannon (launch off stone, ×1.55) | ✅ | 1.1/match |
| Body screen (buys a carrier **+18.85s**) | ✅ | 5.1/match |
| Shoot them off the ball (343px of drift at full power) | ✅ | 0.43/match, and only `clearMarker` does it |
| Fragile-wall snipe (4 blocks for one tap) | ✅ | 1.2/match, layout-dependent |
| Bullet-ball (shoot a loose ball; a ball over the line scores) | ✅ | **now 5.7/match** — was 0% of 10–65 chances |
| Snooker deflection (45° off an 8.32px offset) | ✅ mechanic | incidental only; refuted **as a pass** (loses to walking, 2.95s vs 1.08s) |
| Catapult (mate's bomb flings the carrier, **ball attached**, +490px) | ✅ | set up 1.9, completes **0.14** |
| Cannon pass (mate's bomb flings the carrier goalward) | ✅ 763px | **~never** |
| Bank off the stone | partial | **never** (`goalBank` 0 of 1103 positions) |
| Quick tap / slow stacks / ⅓ super | ✅ for players | **impossible for bots** — `aimed: fire` makes every bot bullet an aimed shot |

## 7. Tools, as the bots understand them

- **Kick reach is the fact that governs shooting:** a full-charge kick rolls **647px** on a 2000px
  pitch (`roll = 0.468 × (v₀ − 18)`, `v₀ = shotPower 1400 × chargeMul`). `FINISH_RANGE` is derived from
  it. ⚠️ The release ladder still shoots at the mouth from `distGoal < 1150` (`bot-ai.js:2070`), so
  **4.52 of every 6.29 shots at goal — 72% — are fired from beyond what a kick can travel** (measured
  today, 7 arenas × 3 × 45 s, both sides 0.93). Biggest single leak in the file.
- **Bullets:** `FULL_CHARGE` 0.70 strips a carrier. From L5 the ceiling is **1.00** (343px of knockback
  instead of 250), rate-limited to ~1.4 new wind-ups/second. No range limit and no falloff — `ttl` and
  the point-blank constants are declared and never read.
- **Bombs:** fuse 1.725s, radius 168, and a **carrier can never plant**. On-centre gives a self-launch;
  a mate's bomb flings you *keeping the ball*. A bomb on a body's exact centre delivers **zero**
  knockback (a sim singularity — perfect aim is punished).
- **Walls:** `BUILD_WINDUP` 0.5s, 2 charges, ~15s each to trickle back. Bots push them out to 180px only
  from L9. A wall in a bush or a penalty box is fragile (hp 1) and a fast ball smashes through it.
- **Super:** earned by *hitting* things, never by firing. Overcharge = full charge + super, and it is the
  only kick a keeper cannot catch. Held for a finish from L5, spent as a body strip from L9.
- **The rule that shapes all carrying:** the ball is glued at `feet + aim × 58.25px` and pops loose the
  instant that spot touches a wall. **A gap a body fits through is not a gap a carrier fits through** —
  `steer()` now charges a carrier for that extra room.

## 8. Coordination

- **Roles per team, with hysteresis:** `onBall` (press/chase/carry) and `support` (outlet or cover).
  Ranked by reach in *ground*, and a bot on a bomb fuse or wall wind-up is charged the distance it
  cannot cover — a rooted incumbent loses the role outright.
- **`role.chaser`:** exactly one committed loose-ball chaser per team, always. Persona `chase` biases it
  by up to 320px of conceded ground, but inside 240px nobody may concede a ball at its feet.
- **Spacing:** the off-ball bot holds 200–340px from the carrier depending on persona `escort` — waived
  entirely when the enemy has the ball and nobody is inside `PRESS_RANGE` (160 + 300·aggro ≈ 400–505px).
- **Pass calls:** the carrier latches a receiver (`bm.passTo`) and publishes `mem.pass[team]`; the
  receiver comes to meet it with a capped 20px of ground given up. Passes reaching a mate went 22% → ~90%.
- **Belief:** the **ball's position is always exact** — bushes hide players, not the ball, and the
  client pins an off-screen arrow to it, so a bot that didn't know was blinder than the player.
  **Enemy bodies keep their fog** (`botCanSee` + dead-reckoned memory for `memoryS` seconds).

## 9. Navigation and obstacles

Flow-field nav (32px grid, BFS, LRU-cached per arena signature) plus 16-direction context steering that
weighs walls, bodies, live bombs and incoming bullets. Detour probes are **sampled along the ray** — a
single probe 120px out landed on the far side of every wall on the shipped arena and marched bots into
walls for up to 15.65s.

Current jam figures at level 10 (24 matches × 2 seed bases): wall-pinned while wanting to move
**0.6–1.0%**, worst single jam **0.9–2.0s**, and a bot that is going nowhere now **bombs itself loose**
(~2/match). Bomb jumps are refused when the flight path crosses stone.

## 10. Difficulty ladder — honest status

`SEEDS=6 ARENA=main node test-bot-ladder.mjs`, 192 matches per anchor against a fixed t=0.50 reference:

| tree | goals rho (gate 0.85) | felt spread (gate ~0.45) | top beats bottom |
|---|---|---|---|
| before this session | **−0.50** | −20% of scoring rate | **FAIL** |
| after the objective/press work | 0.70 | 48% | PASS |
| after the personalities | 0.70 | 48% | PASS |
| **shipped now** (+ the five L5 asks) | **0.70** | **8–10%** | PASS |

So the ladder was **inverted** and is now correctly ordered at the ends, while the *felt range* is
compressed. Cause: every new ability helps a weak bot more than a strong one (the t=0.05 anchor moved
−0.06 → +0.18 against the same reference). Refuted while chasing it: a skill-scaled bullet cadence
(cost 0.30 of rho to buy 2 points of spread) and ramping the persona policy in with skill (did nothing).
**The next move is the deferred 12-level re-cut, not another constant.**

## 11. Instruments

| tool | question |
|---|---|
| `node bot-feel.mjs` | the felt metrics: jam %, worst jam, wall-pops, possession, advance per release, retreat-while-nearest. `SKA=/SKB=`, `MATCHES=`, `SEEDBASE=` |
| `node press-probe.mjs` | dispossession: what share of carries end in a strip (bot-feel cannot see a press) |
| `node bot-skill-census.mjs` | does a skill ever fire, on 7 arenas including generated ones. `MIRROR=1`, `LEVEL=` |
| `node test-bot-ladder.mjs` | the only thing that can rank tiers. `SEEDS=6`, `ARENA=main` is the default |
| `node bot-aim.mjs` / `bot-passes.mjs` / `bot-idle.mjs` / `bot-support.mjs` | shots by class · pass completion · what is holding a bot still · why support moves away |
| `node bot-cost.mjs` | CPU: the whole brain is **0.31 µs per bot per tick**; `step()` costs 3.4× more |
| `/_bot-scope.html`, `/_arena-watch.html`, `?watch=1&diff=N` | watch it: bird's-eye with every play in words, a random-arena watcher, and an all-bot match in the real client |

**Measurement rules that have each cost this repo a day:** state the arena · seed everything ·
`MATCHES=24` on ≥2 seed bases before quoting anything · exclude goal-freeze ticks (the sim skips the
player loop while `resetTimer > 0` but the bots keep emitting inputs) · compare within one match when the
metric depends on where the ball is · A/B HEAD against HEAD-minus-your-own-hunks, never a frozen base.

## 12. Known open defects, worst first

1. **The release ladder ignores kick reach** (`bot-ai.js:2070`, `distGoal < 1150` vs 647px of roll) —
   4.52 of 6.29 shots at goal per match cannot arrive (72%). Three lines to gate it on
   `ballRollPx(state, 1)`.
2. **`pointInBush()` reads the default arena on every layout** — fixed for the *ball*, still live for
   **enemy visibility** and for every bush-lurk spot. A fixture that puts an enemy in
   (850..1150, 430..670) sees no enemy at all, on any map.
3. **Pass charge is sized by `dist/950`**, so the set of passes a bot can complete and the set it can
   deliver safely are disjoint. Size it from `chargeForRoll` with a floor at `FULL_CHARGE`.
4. **`clearMarker` has no angle term** — a shove at 0° to a chaser's heading makes them arrive **1.18s
   sooner**, so about half of those shots help the opponent.
5. **Bots cannot fire a quick tap** (`aimed: fire`), so slow stacks and the ⅓ super are player-only.
6. **`explode()` bullseye singularity** — a bomb on a body's exact centre gives zero knockback.
7. **The catapult and cannon-pass combos almost never complete** (0.14 and ~0 per match).
8. **`docs/MECHANICS.md` is stale in five places** (shotPower 1850 → 1400, FULL_CHARGE 0.85 → 0.70,
   the ultimate combo's range, the point-blank falloff that does not exist).

## 13. Where to read more

- `summery/BOT_HANDOFF.md` — per-round history, and §4's refuted list (read before proposing anything)
- `summery/bots logic handoff/` — the research: 9 live defects, 16 measured skills, the architecture
  review (a physics oracle and a plan object are the two missing abstractions), and the arena audit
- `summery/bots logic/BOT-PERSONALITIES-RESEARCH.md` — the personality design and its feedback section
- `docs/superpowers/specs/2026-07-26-bot-chase-press-obstacles-design.md` — the objective-chasing spec
