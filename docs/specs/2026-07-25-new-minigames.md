# New minigame modes — concepts, feasibility, and a build order

> Agent `new-minigames`, 2026-07-25. **Design doc only — no code was changed.**
> Sibling specs from the same pass: `-lobby-game-picker.md`, `-3v3-mode.md`, `-mode-polish.md`,
> `-mode-roster-research.md`.
>
> Everything below is measured against the code as of `12deeea`. Where I say "free" I mean
> *no change to `shared/sim.js`*. That distinction is the whole point of this document.

---

## 0. TL;DR

- The engine is a **football-rules machine with an unusually rich combat toybox** (charge tiers,
  a 3-use super, bombs with stacking + wall-cannon + self-launch, a 4-block destructible wall
  builder, bush stealth, snooker deflection, a field builder). Almost all of it is already
  per-room configurable.
- There are **three tiers of "new mode" cost**, and the difference between tier A and tier C is
  a factor of ~20 in effort. Most good ideas fit in tier A/B.
- **Top 3 to build next:** גנב הכדור (Ball Hog), מצור על השער (Goal Siege), פנדלים (Penalties).
  Plus בלגן פצצות (Bomb Storm) as a ~1-day freebie that needs literally no new rules code.
- **Do not add new public matchmaking pools.** `goal-brawl` already forked the queue
  (`publicRoom` / `publicRoomBrawl`). Every mode below should be an **instant bot-filled room**
  (like `botgame`/`training`) or a **friend/private room**, never a third queue.

---

## 1. TOYBOX INVENTORY — what the engine actually supports

Verified by reading `shared/sim.js` (1483 lines), `shared/constants.js`, `shared/arena.js`,
`shared/training.js`, `shared/field-presets.js`, `shared/difficulty.js`, `shared/bot-ai.js`,
`shared/wire.js`, `server.js`, `docs/MECHANICS.md`.

### 1.1 Confirmed (the brief was right)

| System | Where | Notes |
|---|---|---|
| **Charged shot, aimed vs quick** | `sim.js:711+`, `MECHANICS.md §1-3` | `SHOOT_CHARGE_TIME 2.0s`; tiers `QUICK_CHARGE .25` / `FULL_CHARGE .70`. **Aimed vs quick is the real axis**, not just charge: a *quick* (no aim-pull) shot does **zero knockback**, only a stacking slow. |
| **3-use super meter** | `SUPER_USES = 3`, `earnPower()` | Earned **only by hitting enemies** (full hit = 1.0, quick hit = 1/3). Ready super lasts `OVERCHARGE_TTL 4s`, gives 2× charge rate, +50% bullets / +25% kicks, body-strip, push bias. Small actions cost 1 of 3; an overcharge shot spends the lot. Latches to a shot loaded during super. |
| **Bombs — lob, stack, self-launch** | `useSpecial()`, `explode()` | Tap = plant at feet, drag = lob ≤ `BOMB_LOB_RANGE 250`. Fuse 1.725s, radius 168. Up to **2 bombs combine** (×1.9). **Wall cannon**: a wall collinear behind the blast boosts it (steel ×1.55). Self rocket-jump, capped `BOMB_LAUNCH_MAX 5200`. Ultimate combo measured at **1842px ≈ 92% of the pitch**. |
| **Wall builder, per-block fragility, shared HP** | `buildWall()`, `WALL_BLOCKS = 4` | One build = **4 capsule blocks sharing one `wallId` and one HP pool**. `BUILD_MAG 2`, `BUILD_RELOAD 15s` trickle, `BUILD_WINDUP 0.5s` hold-to-confirm (interruptible by ≥300 kv), placement distance driven by aim-stick push (`BUILD_DIST_MAX 120`). Walls in a **bush or penalty area are FRAGILE (hp 1)**. Global cap `MAX_BUILT_WALLS = 8`. |
| **Crates** | `buildArenaFromField()` | Field-builder AABB boxes, **indestructible** (same physics as steel), rendered as wood. Not lootable, not breakable. |
| **Carry / dribble / strip** | `sim.js:790+` | Ball glues to a carrier; quick tap = 155px dribble touch; full aimed bullet strips; super body-contact strips. **Hands full: you cannot build or bomb while carrying** (inputs dropped, nothing consumed). |
| **Body knockback** | `KNOCKBACK_DECAY`, `FLY_HIT_SPEED 460` | Any body flying above 460 body-checks an enemy; a bomb-launched planter gets a 1800-kv tackle for 0.5s. |
| **Penalty areas** | `PENALTY 620×360`, `PENALTY_KNOCKBACK_MUL 0.3` | An attacker inside the enemy box takes 30% knockback. |
| **Snooker ball physics** | `snookerPush()`, `capDeflect()`, `MAX_DEFLECT 18°` | Impact-offset deflection, `WALL_BOUNCE 0.62`, `WALL_RESTITUTION 0.72`, goal-post bounces (`bouncePost`). |
| **XP-scaled bots** | `difficulty.js` | 12-level ladder (0-11) with **separate enemy and partner skill**; `botLevelFromXp()` derives it from the player's account XP. |
| **Field builder + saved fields** | `field-presets.js`, `main-field.js`, builder UI | Shape `{version, bushes, hardWalls, dryWalls, crates}`; `setField(state, field)` applies it per room. 3 presets (ראשי / קלאסי / ריק). Saved to localStorage `pikme-fields`. |
| **Hero skins / cards** | `cosmetics.js` | 9 heroes × 4 skins = 36 combos, **purely visual**. Card buffs are separate and *do* touch physics: `cardShot` (charge rate), `speedBuff` (move), `cardUtil` (bomb + wall cooldowns). |
| **Training mode** | `training.js`, `startTraining()` | Solo room, endless clock, custom asymmetric field, 4 scripted enemies: **sentry** (leads aim, 3 skill tiers, fog-aware, won't shoot through walls), 2 **still** targets, and a **keeper** that tracks the ball→goal line inside the box. |

### 1.2 Corrections to the brief

- **"Bushes the ball hides in" — no.** Bushes hide **players only** (`canSeePlayer` in `client.js`,
  `BUSH_REVEAL_DIST 110`, `SHOT_REVEAL_TIME 0.45`, plus a "spotted!" pop). The ball is **always
  visible**. Bushes also have a second, non-obvious role: **a wall built inside a bush is fragile**.
- **"Fog" — no true fog of war.** What exists is (a) bush stealth for humans, (b) bot perception
  gating: `VISION_RANGE 620` for off-ball enemies, `BALL_VISION 950` for the carrier. There is no
  vision cone, no map-wide fog, no reveal pings.
- **"Keepers" — emergent, not a role.** In a real match there is **no keeper entity**. Any defender
  standing in their **own** penalty box automatically catches/blocks a kicked ball below overcharge
  (`inOwnPenalty` + `KEEPER_BREAK_ROLL 0.45`); an overcharge kick breaks through. A **scripted**
  keeper exists only in training (`trainingKeeperInput` + `keeperClamp`) — and it is directly
  reusable by any new mode.

### 1.3 Toys the brief missed (all free to reuse)

- **Ammo/mag:** `MAG_SIZE 3`, 1 round/s trickle, `EMPTY_RELOAD 1.2s` lockout on a dry mag.
- **Cumulative slow:** quick hits stack −12% speed each, cap 3, shed 1 per 0.6s (no refresh-on-hit).
- **Cover system:** LOS-based. A steel wall fully blocks a blast and a bullet; a built wall softens
  a blast by HP (`BLAST_WALL_PASS_MIN 0.25`) and eats one shot *tier* per remaining HP.
- **No own goals — by design.** The goal line is a **solid wall** for the non-attacking team
  (`handleBallBounds`). Any mode premised on own goals is dead on arrival.
- **Net pockets are walkable.** Players and a carried ball can enter the goal mouth; a dribble-in
  detaches and rolls into the net.
- **Dry walls** (`DRY_WALL_HP 2`) — field-authored **destructible** walls, reseeded every kickoff.
  These are the engine's only destructible-target primitive, and they're already on the wire.
- **Trampolines** — fully implemented in the sim (`TRAMPOLINE.power 3200`) but **disabled**
  (`ARENA.trampolines = []`, and `buildArenaFromField` hardcodes `trampolines: []`). A finished
  toy sitting in a drawer.
- **Per-match per-player stats** already tracked: `goals, assists, strips, saves, shots, bombs,
  walls, touches, possSec, distPx`. This is a ready-made scoring substrate for challenge modes.
- **11 live-tunable settings** per room: `speedMul, sizeMul, carrySpeedMul, ballSizeMul, shotPower,
  bulletSpeed, bulletKnockback, bombPower, bombReloadSpeed, wallReloadSpeed`. **This is the single
  cheapest fun lever in the codebase** — a Fortnite-style LTM is a settings preset.
- **Per-player buffs** at spawn (`addPlayer({buffs})`) — `cardShot / speedBuff / cardUtil`. Lets you
  build **asymmetric teams with zero sim changes**. Caveat: `cardUtil` is one knob for *both* bomb
  and wall cooldowns (`sim.js:662, 952, 1046`); splitting them is a ~3-line change.
- **Room-level rule switches already proven:** `room.goalsToWin` (0 = timed), `state.noClock`
  (endless), `room.introT` (freeze the sim while a cinematic plays), `setField()`.
- **Social plumbing exists:** private rooms with 3-digit codes, party invites, friend challenges
  (`startChallengeMatch`), and 3 always-online bot friends.

### 1.4 Hard limits — read this before designing

| Limit | Where | Consequence |
|---|---|---|
| `FIELD` is a module constant 2000×1100 | `constants.js:6` | Per-mode pitch size is the `mode-3v3` agent's problem, not free. |
| `MAX_PLAYERS = 4`; wire slot mask is a **u8 → 8 slots** | `constants.js:311`, `wire.js` | 6-player modes fit the wire; 9+ do not. |
| Exactly **two teams**, `A` and `B` | `TEAM`, and `lastTouch === 'A'` in goal logic | **True FFA needs a new scoring axis** — goals are team-keyed at the physics level. |
| **One ball** — `state.ball` is a single object | ~40 call sites + the wire | Multi-ball is a real refactor, not a gag. |
| `elapsed` is a **u8** on the wire | `wire.js` | **Any mode longer than 255s (4:15) breaks the clock.** |
| `score.A/B` are **u8** each | `wire.js` | Fine for 0-100 progress bars; nothing per-player. |
| **No health, no damage, no elimination, no respawn** | — | Knockout/Showdown formats need an entire new subsystem. |
| Players are **hard-clamped inside the pitch** | `clampToArea`, `sim.js:621` | No ring-outs without gutting a function everything depends on. |
| **No pickup/collectible entity type** | wire has players/ball/bullets/bombs/walls/blasts/impacts | Real Gem Grab / power cubes need a new wire entity. |
| **Bots only understand football** | `bot-ai.js` roles: onBall/support, goal targeting, keeper avoidance, lane walls, bomb-the-carrier | **A mode that changes the objective makes bots play the wrong game.** Modes that keep "fight for the ball, score in that goal" get competent bots for free. This is the single biggest design constraint on this list. |
| XP is awarded only in `quick` | `client.js:2832` `xpModes = msg.mode === 'quick'` | Every new mode awards nothing until it's added there. |

### 1.5 The three cost tiers

- **Tier A — rule flags only.** `mode` string + `goalsToWin` / `noClock` / `settings` preset /
  `setField()` / per-player `buffs`, plus a hub button. **Zero sim changes.** `goal-brawl` is the
  proof: it's ~14 lines. *Cost: hours.*
- **Tier B — server post-step hook.** A `updateXxx(room)` called right after `step()` in
  `tickRoom()`, exactly where training already calls `keeperClamp` / `leashSentry`, plus
  synthesized NPC inputs. Mode logic lives **entirely in `server.js`**; `sim.js` untouched;
  HUD rides on the existing `score` bytes or a JSON side-channel like `matchStats`.
  *Cost: half a day to two days.*
- **Tier C — sim rules, new entities, or new wire fields.** Coordinate with everyone.
  *Cost: days, and it blocks other agents.*

---

## 2. What I'm borrowing, and why it fits

**Brawl Stars** ([Brawlify mode list](https://brawlify.com/gamemodes), [Innovation & Tech Today](https://innotechtoday.com/every-brawl-stars-game-mode-explained-and-how-to-win-each-one/), [Brawl Stars Wiki](https://brawlstarswiki.miraheze.org/wiki/Game_modes))
is the right north star: same camera, same arena proportions (our `FIELD` comment literally says
"matches a Brawl Stars map"), same 3-minute sessions, same audience. The roster lesson isn't any
one mode — it's that **five modes over one combat core** beats one mode with five maps, because
each mode re-weights the *same* verbs. Specifically borrowed:
- **Gem Grab** ("collect ten and hold them through a countdown") → **Ball Hog**. The hold-and-survive
  countdown is the perfect fit for a game that already has carrying, stripping, and a
  possession timer. Crucially it keeps the ball as the objective, so **bots stay competent**.
- **Heist** ("break the enemy safe") → **Goal Siege**. Our "safe" is a goal mouth that defenders
  can physically wall shut and attackers must blow open. This is the mode our wall+bomb systems
  were secretly built for.
- **Hot Zone** ("hold the circle") → **Hot Zone**, but re-pointed at the *ball* rather than bodies,
  so bots don't need new brains.
- **Basket Brawl / Volley Brawl** (2026 roster) → rejected; both need a goal geometry we don't have.
- **Showdown / Duo Showdown** → rejected as too expensive (§6), but its *lesson* is kept: the
  2026 **Loaded Showdown** variant (mystery boxes with bowling balls and bumper cars) shows
  Supercell itself now ships **item-chaos reskins of an existing mode** rather than new modes.
  That's exactly our Bomb Storm strategy.

**Fortnite LTMs** ([TheGamer](https://www.thegamer.com/fortnite-best-limited-time-modes/), [GameRant](https://gamerant.com/best-fortnite-ltms/)):
**High Explosives** — "the map contains nothing but explosives" — is the most-returned LTM in the
game's history, and it required *no new systems at all*, only loot-table numbers. Our equivalent is
a `settings` preset. For a small team, this is the highest fun-per-line-of-code ratio available.
**One Shot** (low gravity + snipers only) teaches the same thing: one exaggerated number is a mode.

**Roblox** ([300mind](https://300mind.studio/blog/roblox-game-ideas/), [game-ace](https://game-ace.com/blog/roblox-game-ideas-that-actually-work/), [Obby wiki](https://roblox.fandom.com/wiki/Obby)):
two formats matter for us. **Bomb Tag** (a ticking bomb passed by tagging; holder at zero
explodes) maps onto our ball + fuse + carrier almost 1:1 → **Hot Ball**. And **Obby** (a solo
timed obstacle course) is the format that solves our real problem: Roblox's own guidance is that a
working game needs *a sub-five-minute loop and something to do without a second player*. Our
signature bomb-jump combo is an obby waiting to happen.

**Rocket League** ([Eloking mode guide](https://eloking.com/blog/every-mode-in-rocket-league), [Dignitas](https://dignitas.gg/articles/the-benefits-of-playing-extra-modes-in-rocket-league)):
the purest example of **many modes over one physics core** — Rumble, Dropshot, Hoops, Snow Day,
Heatseeker, Beach Ball all reuse the same car and the same ball. Two things to steal:
(1) **Beach Ball** = "make the ball enormous", which for us is literally `ballSizeMul: 4`;
(2) each variant is explicitly designed to *train one skill* (Hoops→precision, Snow Day→control).
Our variants should each foreground exactly one verb: possession, walls, bombs, or aim.

**On queue fragmentation** ([ESO Battlegrounds thread](https://forums.elderscrollsonline.com/en/discussion/666660/splitting-the-queue-via-solo-group-queues-will-kill-the-battlegrounds-population/p3)):
splitting a thin queue kills all halves. Our playerbase is small and most matches are already
bot-filled, so the *correct* architecture for every mode below is `startBotGame`'s pattern —
**instant entry, bots backfill, invite a friend if you have one** — not a new `publicRoomX`.

---

## 3. The concepts

Format per concept: hook · players · length · win condition · reuses · genuinely new code · why it's fun.

---

### 1. מצור על השער — **Goal Siege** *(Heist)*
- **Hook:** one team must break into a goal the other team is allowed to physically brick up.
- **Players:** 2v2 (works 1v1; bot-fillable). **Length:** two 60s halves + role swap.
- **Win:** fastest breach time wins. Nobody scores → draw → 30s sudden death.
- **Reuses:** wall builder + shared HP + fragile-in-box rule, bombs (stacking, wall cannon, cover),
  the LOS cover system, `goalsToWin = 1`, `setField()` for a bespoke siege pitch, per-player
  `buffs` for asymmetry, and **defender bots that already build lane walls** (`bot-ai.js:940-990`)
  and attacker bots that already shoot at goal.
- **New code:** *Tier B.* A `room.siege` half/role/timer hook after `step()`; role swap and
  half restart; breach-time bookkeeping. Two known snags: (a) `MAX_BUILT_WALLS = 8` is too low
  for a two-defender fort — needs to become `state.maxBuiltWalls` (default 8); (b) `cardUtil`
  is a single knob for bomb+wall, so "fast walls for defenders, fast bombs for attackers" wants
  it split into `cardWall`/`cardBomb` (~3 lines in `sim.js`).
- **Why it's fun:** it turns the two most distinctive systems into a direct argument. Defenders
  read the lane and spend their 2 charges; attackers stack two bombs against the wall's own
  backing to cannon it open. Every ingredient of the "ultimate combo" already documented in
  `MECHANICS.md §6` becomes a *tactic* instead of a stunt.

### 2. מלחמת מבצרים — **Fort Wars** *(wall-builder showcase)*
- **Hook:** 20 seconds to build your half of the pitch, then football inside what you built.
- **Players:** 2v2. **Length:** 20s build + 100s match (fits the 255s clock byte).
- **Win:** most goals at the whistle.
- **Reuses:** wall builder; the **ריק (empty) field preset** so player walls are the *only* cover;
  the `room.introT` mechanism, which already freezes the sim and zeroes inputs — the build phase
  is the same trick with `build` left enabled.
- **New code:** *Tier B.* A `buildPhaseT` that zeroes `fire`/`special` but not `build`, grants a
  temporary wall magazine, and confines each team to its own half. Same `MAX_BUILT_WALLS` snag.
- **Why it's fun:** it makes players *authors* for 20 seconds and then makes them live in it.
  Also the cheapest possible way to find out whether the field builder's ideas are actually good.

### 3. פצצה חמה — **Hot Ball** *(Roblox Bomb Tag)*
- **Hook:** the ball is a live bomb. Hold it too long and it blows up in your hands.
- **Players:** 2-4. **Length:** 120s. **Win:** fewest detonations (a goal defuses and resets the fuse).
- **Reuses:** carrying/stripping, the entire bomb entity **including its client-side fuse ring**,
  blast knockback, super body-strip (now the best defusal tool in the game).
- **New code:** *Tier B, with one trick.* Each tick the hook keeps a bomb entity glued to the
  carrier's position with a rolling fuse, so **the client renders it with zero client changes**.
  On detonation: the normal blast fires, the holder's team takes a point, the ball resets.
- **Why it's fun:** it inverts the game's core desire. Everyone spends every other mode wanting the
  ball; here you're desperate to pass it, and a *strip* becomes an act of aggression against a
  teammate-shaped victim. Reads instantly on a phone because the fuse ring is already legible art.

### 4. בלגן פצצות — **Bomb Storm** *(Fortnite High Explosives)*
- **Hook:** bombs reload almost instantly and hit twice as hard. That's it. That's the mode.
- **Players:** 2-4. **Length:** 120s. **Win:** most goals.
- **Reuses:** everything. `settings = { bombPower: 4000, bombReloadSpeed: 4, wallReloadSpeed: 3,
  shotPower: 900, ballSizeMul: 2.5 }` + the ריק field.
- **New code:** *Tier A.* A settings preset, a `mode` string, a hub button. **No rules code at all.**
- **Why it's fun:** the numbers are already tuned to be entertaining at the edges — the codebase
  measured a 1842px launch. Ship it in a day, watch the retention, and it costs nothing if it flops.

### 5. גנב הכדור — **Ball Hog** *(Gem Grab)*
- **Hook:** don't score — *keep* it. Hold the ball 20 seconds total and you win.
- **Players:** 2v2 (bot-filled). **Length:** ≤120s. **Win:** first team to 20s of possession;
  a goal is worth a bonus +3s. Timeout → most possession wins.
- **Reuses:** carrying, all four strip mechanics (full aimed bullet, super quick, super body,
  ball-into-defender), `possSec` accounting that already exists, and — decisively — **bots need
  no changes**, because "fight for the ball and protect the carrier" is what they already do.
- **New code:** *Tier B, small.* A hook accumulating per-team hold with a ~1s loose-ball grace,
  writing progress into the existing `score.A/B` bytes as 0-100 so the HUD is a free progress bar.
- **Why it's fun:** it promotes the game's most satisfying and most under-used mechanic — the
  strip — from an interruption to *the entire objective*. It also fixes the timid-play problem:
  there is no parking the bus when the clock only runs while you're brave.

### 6. אזור חם — **Hot Zone** *(Brawl Stars Hot Zone)*
- **Hook:** keep the ball inside the centre circle. Standing in it does nothing; the *ball* is the flag.
- **Players:** 2v2. **Length:** 120s. **Win:** first to 100% zone-seconds.
- **Reuses:** the centre bush already sits on the centre circle (a stealth fight over the zone,
  free); `score` bytes as a 0-100 bar; unchanged bots (the ball is still the objective).
- **New code:** *Tier B, small.* A per-tick "is the ball in the circle, and who touched it last"
  accumulator.
- **Why it's fun:** it forces play into the middle third, where the bushes and the cover walls are,
  and it makes a hard cross-pitch clearance a *defensive* act. Weakest concept-fit on this list
  though — see the score table.

### 7. פנדלים — **Penalty Shootout**
- **Hook:** five shots, one keeper. Earn super mid-shootout and your penalty becomes unsaveable.
- **Players:** solo (vs bot keeper) **or** 1v1 via the existing challenge flow. **Length:** ~90s.
- **Win:** best of 5, then sudden death.
- **Reuses:** `trainingKeeperInput` + `keeperClamp` **verbatim** (already written and tested); the
  `inOwnPenalty` keeper-catch rule where a keeper saves everything below overcharge but an
  **overcharge kick breaks through** (`KEEPER_BREAK_ROLL`); the charge system; `score` bytes.
- **New code:** *Tier B.* A `place → aim (5s shot clock) → live (3s) → result → next` state machine,
  ball placement on the spot, freezing the non-shooter (same trick as `introT`), and a JSON
  `penaltyState` side-channel for the 5-dot scoreboard (modelled on `matchStats`).
- **Why it's fun:** it's the one mode whose rules need no explanation anywhere in Israel, it's the
  best 1v1 challenge content we could give the friends system, **and it works with nobody online.**
  The emergent skill ceiling is delightful: `earnPower()` only fills from hitting enemies, so a
  clever player *shoots the keeper* between penalties to bank a super, then buries an unsaveable one.

### 8. דו-קרב — **Duel** *(Knockout)*
- **Hook:** 1v1, first goal wins the round, best of three.
- **Players:** 2. **Length:** 3 × ≤45s. **Win:** 2 rounds.
- **Reuses:** `goalsToWin = 1`, the whole challenge/private-room lifecycle, the existing
  post-goal→kickoff reset path.
- **New code:** *Tier A/B.* Round bookkeeping in the room; restart between rounds; a
  "round 2 of 3" banner.
- **Why it's fun:** short, high-stakes, and it's the natural payload for the friends-challenge
  feature that already exists but currently just drops you into a normal 2v2.

### 9. מסלול הפצצות — **Bomb Obby** *(Roblox obby, solo time trial)*
- **Hook:** you can barely walk. Cross the pitch by blowing yourself across it.
- **Players:** 1. **Length:** 60-120s per attempt. **Win:** best time to the far goal; medals at
  tiered thresholds.
- **Reuses:** self rocket-jump, wall cannon, bomb stacking, `settings.speedMul` (clamps to 0.1 —
  effectively immobile), `bombReloadSpeed` for generous re-arming, the field builder for the
  course, dry walls as breakable gates, and `state.noClock`.
- **New code:** *Tier B.* A hand-authored course field, a start/finish/checkpoint hook, a timer,
  and best-time persistence (the prefs bag already syncs to the account — but note the 200KB
  `PREF_MAX_BYTES` gotcha logged by the `social` agent).
- **Why it's fun:** the engine's most spectacular measured behaviour — the 1842px combo launch — is
  currently a footnote in a mechanics doc. This makes it the entire game. And it is completely
  immune to "nobody's online". Lowest *football*-fit on the list; highest *engine*-fit.

### 10. ניפוץ — **Demolition** *(solo skill / time trial)*
- **Hook:** twelve dry walls, one clock. Fastest clear wins.
- **Players:** 1 (leaderboard-able). **Length:** 30-90s. **Win:** best clear time.
- **Reuses:** dry walls as destructible targets (already on the wire, already rendered with
  crack states), the tier-based wall-damage rule (a full shot = 1 HP, a bomb = instant), the field
  builder, `noClock`.
- **New code:** *Tier B, small.* A hook counting `state.builtWalls.filter(w => w.field)` and
  stopping a timer at zero. Three courses ⇒ three difficulty tiers.
- **Why it's fun:** it's the only mode that *teaches* — the wall/bullet tier table is genuinely
  opaque right now, and this makes "full shot beats three taps" something you feel in ten seconds.
  Perfect first-session content and a natural tutorial follow-on from training.

### 11. הישרדות — **Wave Survival** *(co-op vs bots)*
- **Hook:** two of you against a bot team that gets a difficulty level meaner every wave.
- **Players:** 1-2 humans (+1-2 partner bots). **Length:** as long as you last, capped ≤240s.
- **Win:** waves survived. A wave = 30s; concede 3 total and it's over.
- **Reuses:** the **entire 12-level difficulty ladder** (`DIFFICULTY_LEVELS`, separate enemy and
  partner skill — it was practically designed for this), bot backfill, goal detection, `noClock`.
- **New code:** *Tier B.* A wave scheduler bumping `room.diffLevel` and re-rolling the enemy bots
  between waves, plus a lives counter.
- **Why it's fun:** it's the only **co-op** entry, it gives the difficulty ladder a purpose beyond
  a settings dropdown, and it converts "bot-filled match" from an apology into the point. It also
  gives a friend duo something to do when the queue is empty — which is most of the time.

### 12. אפלה — **Blackout** *(stealth LTM)*
- **Hook:** the whole pitch is bush. You cannot see anyone until they're on top of you.
- **Players:** 2-4. **Length:** 120s. **Win:** most goals.
- **Reuses:** bush stealth exactly as-is (`BUSH_REVEAL_DIST 110`, firing reveals you for 0.45s,
  the "spotted!" pop), bot vision gating (bots go genuinely blind too), and the **fragile-wall-in-a-bush**
  rule, which as a side effect means every wall built in this mode is one-hit — a real tactical shift
  for free.
- **New code:** *Tier A.* One field preset made of big overlapping bushes. Zero rules code.
- **Why it's fun:** the same pitch feels like a different genre, and the ball being permanently
  visible (§1.2) turns out to be a *feature* — it's the only light in the room.

### 13. כדור ענק — **Mega Ball** *(Rocket League Beach Ball)*
- **Hook:** the ball is enormous, bouncy, and shoves people over.
- **Players:** 2-4. **Length:** 120s. **Win:** most goals.
- **Reuses:** `settings = { ballSizeMul: 4, shotPower: 2200, speedMul: 1.1 }`. The
  `BALL_BUMP_SPEED 300` rule means a big fast ball already flattens defenders; snooker deflection
  gets much more dramatic at a bigger radius.
- **New code:** *Tier A.* A settings preset.
- **Why it's fun:** the cheapest possible novelty, and it's a *visual* joke — it sells itself on the
  mode-select screen in a way none of the rules-based modes can.

### 14. הכל בכל — **Free-For-All** *(Showdown)* — included for completeness, **not recommended yet**
- **Hook:** four players, no teams, one ball, most goals wins.
- **Reuses:** movement, combat, the arena.
- **New code:** *Tier C, and it's a big C.* `TEAM` is hard-coded to A/B and goal scoring is
  team-keyed at the physics level (`lastTouch === 'A'`); there is no per-player score anywhere on
  the wire; separation/knockback logic reads `team`; and **bot-ai's entire coordinator is built
  around two-sided roles**, so bots would be useless — which is fatal for a mode in a game where
  most matches are bot-filled.
- **A cheap 80% substitute exists:** run a normal 2v2 and crown an **MVP** from the per-player
  `stat` block that's already collected. You get the individual-glory feeling for ~20 lines,
  without touching teams. Recommend that instead, and hand it to the `mode-polish` agent as a
  results-screen feature.

---

## 4. Scores

Fun 1-5 (5 = would be talked about). **Effort 1-5 (1 = hours, 3 = ~2 days, 5 = weeks).**
Reuse 1-5 (5 = nothing new in the sim). Fits 1-5 (5 = feels like this game).

| # | Mode | Fun | Effort | Reuse | Fits | Tier | Notes |
|---|---|:--:|:--:|:--:|:--:|:--:|---|
| 5 | **גנב הכדור / Ball Hog** | 4 | **2** | 5 | 5 | B | Best ratio on the board. Bots free. |
| 1 | **מצור על השער / Goal Siege** | **5** | 3 | 5 | 5 | B | The flagship. Needs `MAX_BUILT_WALLS` + `cardUtil` split. |
| 7 | **פנדלים / Penalties** | 4 | 3 | 4 | 5 | B | Solo *and* duel. Reuses the training keeper whole. |
| 4 | **בלגן פצצות / Bomb Storm** | 4 | **1** | 5 | 4 | A | Free. Ship it alongside anything. |
| 3 | **פצצה חמה / Hot Ball** | **5** | 3 | 4 | 4 | B | Highest ceiling, slight risk it reads as confusing. |
| 9 | **מסלול הפצצות / Bomb Obby** | **5** | 3 | 4 | 3 | B | Best solo content; least "football". |
| 2 | **מלחמת מבצרים / Fort Wars** | 4 | 3 | 5 | 5 | B | Depends entirely on the wall cap fix. |
| 11 | **הישרדות / Wave Survival** | 4 | 3 | 5 | 4 | B | Only co-op entry; gives the difficulty ladder a job. |
| 8 | **דו-קרב / Duel** | 4 | 2 | 5 | 4 | A/B | The right payload for friend challenges. |
| 13 | **כדור ענק / Mega Ball** | 3 | **1** | 5 | 4 | A | Free novelty; sells itself on the picker. |
| 12 | **אפלה / Blackout** | 3 | **1** | 5 | 3 | A | Free; one field preset. |
| 10 | **ניפוץ / Demolition** | 3 | 2 | 5 | 3 | B | Best *teaching* mode; modest fun. |
| 6 | **אזור חם / Hot Zone** | 3 | 2 | 5 | 3 | B | Fine, but Ball Hog does the same job better. |
| 14 | **הכל בכל / FFA** | 4 | **5** | 2 | 2 | C | Don't. Ship MVP-of-the-match instead. |

**Freebie bundle:** #4, #12, #13 are all Tier A — three modes for roughly one day of work,
shipped as a rotating "מצב השבוע" slot rather than three permanent picker entries.

---

## 5. Top 3 — build plans

### 🥇 גנב הכדור / Ball Hog — *build this first*

Best value per hour on the list, and the only top pick that requires **zero** new bot work.

**Server (`server.js`)**
1. `startBallHog(member, diffLevel)` — copy `startBotGame` (server.js:436). Instant entry,
   `makeRoom(..., 'ballhog')`, `setField(state, MAIN_FIELD_CLEAN)`, `fillBots`, `attachBall`.
   **No new public pool** — bots fill; a friend joins through the existing party path.
2. `room.state.goalsToWin = 0` (the win comes from the hook, not goals); leave the 120s clock on.
3. `room.hold = { A: 0, B: 0, loose: 0 }`.
4. New `updateBallHog(room)` called immediately after `step()` in `tickRoom()` — the same slot
   training's `keeperClamp` uses (server.js:655):
   ```
   owner = state.ball.owner ? state.players[state.ball.owner] : null
   if (owner) { hold[owner.team] += DT; loose = 0 }
   else if ((loose += DT) > LOOSE_GRACE) { /* nothing accrues */ }
   if (state.lastGoal && !creditedThisGoal) hold[state.lastGoal] += GOAL_BONUS   // +3s
   state.score.A = min(100, round(100*hold.A/HOLD_TO_WIN))    // free HUD via the u8 bytes
   state.score.B = ...
   if (hold.A >= HOLD_TO_WIN || hold.B >= HOLD_TO_WIN) state.phase = 'ended'
   ```
   Setting `phase = 'ended'` hands off to the existing stats → `ENDED_HOLD` → `endRoom` path.
   Timeout is already handled: `MATCH_DURATION` ends the match and the higher score wins.
5. Constants: `HOLD_TO_WIN = 20`, `LOOSE_GRACE = 1.0`, `GOAL_BONUS = 3` — keep them in
   `server.js` for now, not `constants.js`, to avoid a shared-file lock.

**Sim (`shared/sim.js`)** — **no changes.** This is the whole point.

**Client (`public/client.js`, `index.html`)**
- Hub button in `#play-strip` next to `goal-brawl-btn`; `ws.send({type:'ballHog', diffLevel})`.
- When `roomMode === 'ballhog'`, render the score pill as two 0-100 bars (the bytes already are
  percentages) plus a "20 שניות בכדור" subtitle, and a kickoff rules banner.
- Add `'ballhog'` to the `xpModes` check (client.js:2832) if this should award XP.

**Bots** — unchanged.
**Tests** — `test-ballhog.mjs`: hold accrues while owned; resets to no-accrual after the grace on a
strip; goal bonus applied once; `phase === 'ended'` at threshold; score bytes stay 0-255.
**Files touched:** `server.js`, `public/client.js`, `public/index.html`, `public/style.css`, one new test.
**Risk:** low. Take the `football-mock:server.js` lock — it's the hottest file in the repo.

---

### 🥈 מצור על השער / Goal Siege — *the flagship*

The mode this engine has secretly been building toward. Two prerequisites first.

**Prerequisites (small, shared-file, coordinate)**
- `MAX_BUILT_WALLS = 8` → `state.maxBuiltWalls` (default `MAX_BUILT_WALLS`), read in `buildWall`.
  A two-defender fort needs ~16.
- Split `cardUtil` into `cardWall` and `cardBomb` at `sim.js:662`, `sim.js:952`, `sim.js:1046`,
  defaulting both to `cardUtil` so nothing existing changes. This buys per-role asymmetry
  **without any per-team settings system**.

**Server**
1. `startSiege(member, opts)` → `makeRoom(..., 'siege')`, `state.noClock = true` (the hook owns
   the clock), `goalsToWin = 1`.
2. New siege field preset in `shared/field-presets.js`: open midfield so attackers can wind up,
   two steel anchors flanking the defended mouth (bomb-cannon backing — this is the *good* kind of
   ingredient), and no bushes near the box so defenders' walls aren't auto-fragile.
3. Spawn with role buffs: defenders `{ cardWall: 0.33 }` (5s per charge), attackers
   `{ cardBomb: 0.4 }` (~1s bombs). Both from `addPlayer({buffs})` — already supported.
4. `room.siege = { half: 0, attackTeam: 'A', t: HALF_LEN, times: {} }`; hook after `step()`:
   on `state.lastGoal === attackTeam` record `HALF_LEN - t`, end the half. On `t <= 0` record
   `Infinity`. Then swap `attackTeam`, rebuild the room state (`createState` + `setField` +
   re-add players with swapped buffs) and run half 2. Compare times → winner, or sudden death.
5. Broadcast a JSON `siegeState { half, attackTeam, t, times }` at ~4Hz (same pattern as
   `matchStats`) — do **not** widen the binary wire for this.

**Client** — an ATTACK/DEFEND role badge, the half clock, and the two breach times side by side at
the end. Big legible Hebrew: «פרוץ תוך 0:23» / «החזק 60 שניות».

**Bots** — no new AI. Defender bots already build lane walls (`bot-ai.js:940-990`); attacker bots
already run the shoot/bank/bomb-the-keeper logic. Verify at diff levels 3, 5 and 8 that a defender
bot with `cardWall 0.33` doesn't spam itself into the wall cap.

**Tests** — `test-siege.mjs`: role buffs land on the right players; half swap preserves cosmetics
and slots; a breach ends the half at the right time; wall cap is per-state and respected.
**Files:** `shared/sim.js` (3 small lines — **coordinate, it's hot**), `shared/constants.js`,
`shared/field-presets.js`, `server.js`, client + CSS.
**Risk:** medium — the only top pick that touches `sim.js`. Do it *after* Ball Hog ships, when the
in-flight sim work (stats, wall shared-HP) has settled.

---

### 🥉 פנדלים / Penalty Shootout — *the solo/duel filler*

Solves the dead-queue problem with content that needs no explanation.

**Server**
1. `startPenalties(member, { vs: 'bot' | memberId })` → `makeRoom(..., 'penalty')`,
   `state.noClock = true`, `setField` to a bare half-pitch field.
2. Keeper: for the solo variant, spawn one bot on team B and drive it every tick with
   `trainingKeeperInput(state, id)` + `keeperClamp(state, id)` — **imported unchanged from
   `shared/training.js`**. For the 1v1 variant the opponent *is* the keeper, clamped by
   `keeperClamp` while it's their turn to defend.
3. `room.pk = { round: 0, turn: 'A', phase: 'place', t: 0, hits: { A: [], B: [] } }`, hook after
   `step()`:
   - `place` → position the ball at `{ x: FIELD.W - PENALTY.depth, y: FIELD.H/2 }` via a small
     helper modelled on `attachBall`, teleport the shooter behind it, zero everyone's inputs
     (the `introT` trick at server.js:642), 1s hold.
   - `aim` → shooter's inputs live, keeper's inputs live, 5s shot clock.
   - `live` → ends on a goal, a keeper catch, the ball leaving the box, or 3s.
   - `result` → push to `hits`, mirror totals into `state.score`, 1.5s hold, next round.
   - After 5 each → sudden death; then `state.phase = 'ended'`.
4. JSON `pkState { round, turn, hits, t }` at ~5Hz for the dot row.

**Sim** — no changes. The keeper-catch rule (`inOwnPenalty`, `KEEPER_BREAK_ROLL`) is already
exactly the ruleset this mode wants.

**Client** — a 5-dot scoreboard per side, a shot-clock ring on the shooter, «תור שלך» / «תור היריב»,
and a camera locked to the penalty box during `aim`.

**Design note worth preserving:** because `earnPower()` fills only from hitting enemies, a player
who plinks the keeper between rounds can bank a super and take an **unsaveable** overcharge penalty.
Don't patch this out — surface it. It's a real skill expression that emerged from existing rules.

**Tests** — `test-penalty.mjs`: state machine advances on each terminal condition; keeper saves
below overcharge and concedes to it; sudden death triggers at 5-5; scores mirror into the bytes.
**Files:** `server.js`, client + CSS + `index.html`. **Risk:** low; the state machine is the only
real work.

---

## 6. Killed darlings

| Idea | Why it dies |
|---|---|
| **FFA / Showdown / battle royale** | Two-team assumption is baked into scoring, separation, knockback and the *entire bot coordinator*. No health, no elimination, no respawn, no per-player wire score, no shrinking arena. It's a new game, not a mode. Ship **MVP-of-the-match** off the existing `stat` block instead. |
| **Knockout / sumo ring-out** | `clampToArea` hard-clamps every player inside the pitch and is called from the hot path that everything depends on. Removing it for one mode means a death/spectate/respawn subsystem that doesn't exist. |
| **Multi-ball chaos** | `state.ball` is a single object referenced at ~40 sites plus the wire codec. Weeks of regression risk for one gag. |
| **Own-goal mayhem** | Impossible by design: `handleBallBounds` makes the goal line a **solid wall** for the non-attacking team. Reversing that would break every existing mode. |
| **Basket Brawl / Hoops** | Goal detection is an x-axis line crossing with post capsules. A hoop needs new geometry and, honestly, a vertical fiction the game doesn't have. |
| **Volley / Dropshot / Snow Day** | All need a net, floor tiles, or a z axis. There is no z. |
| **Payload / escort** | Needs a moving entity with team-occupancy physics — a new entity type *and* a new wire field. Tier C for a mode nobody asked for. |
| **Real Gem Grab (collectibles)** | No pickup entity exists on the wire. Ball Hog gets 90% of the feeling with 5% of the work. |
| **Any mode longer than 4:15** | `elapsed` is a u8 on the binary wire. Hard ceiling at 255s. |
| **Multiplayer racing / 4-player obby** | Per-player progress on the wire, four cameras, four spawn lanes. Prove the *solo* obby is fun first; it's 1/5 the work. |
| **A third public matchmaking pool** | `goal-brawl` already forked a thin queue. Every mode here should be instant + bot-filled, or private/challenge. Adding pools to a small playerbase makes all of them empty. |
| **Trampoline mode** | Tempting (the system is finished and disabled), but it's a *map element*, not a mode. Re-enable it inside Bomb Obby and the field builder instead. |
| **Tournament bracket** | Already a "בקרוב" pill in the hub. It's a meta-system over modes, not a mode — belongs with the lobby/rank lane, not here. |

---

## 7. Notes for the other agents

- **`lobby-picker`:** the freebie bundle (Bomb Storm / Blackout / Mega Ball) argues for **one
  rotating "מצב השבוע" slot** in the picker rather than N permanent cards. Permanent slots should
  go to Ball Hog, Goal Siege and Penalties, and Penalties should also appear as a **challenge type**
  in the friends flow.
- **`mode-3v3`:** nothing here needs a bigger pitch, but Goal Siege and Fort Wars would both be
  better at 3v3 — worth checking that your per-match `FIELD` work leaves `setField()` usable
  per-room. Also note the wire's 8-slot mask is your real ceiling.
- **`modes-polish`:** three of these modes end via `state.phase = 'ended'` set from a *server hook*
  rather than by clock or goal count. Whatever overtime/results work you do should treat "ended"
  as mode-agnostic. Also: **MVP-of-the-match** (§ concept 14) is yours if you want it — the
  `stat` block is already collected and already sent.
- **Everyone:** `MAX_BUILT_WALLS` and the `cardUtil` split are the only two shared-file changes
  this document asks for. If someone else is already in `sim.js`, Ball Hog and Penalties need
  none of it and can ship first.
