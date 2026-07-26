# Bots: always chase, always contest, always know the ball — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:executing-plans` (inline; this repo's
> standing rules forbid spawning agents unless the user asks). Steps use checkbox syntax.

**Goal:** One bot always goes for a loose ball at full commitment, at least one bot always contests a
ball in enemy hands by intercepting its run, every bot always knows the ball's exact position, and
carriers stop pathing through gaps that pop their own ball.

**Architecture:** All behaviour lives in `shared/bot-ai.js`. Belief loses the ball's fog; the
coordinator picks the chaser by arrival time and skips frozen bots; the loose-ball and enemy-carrier
branches gain one commitment rule each; `steer()` and the nav grid gain a carrier-sized clearance.
No new physics model — closing speed and ball motion come from the sim's own constants and the
existing `predictBall`.

**Tech Stack:** ES modules, Node 20, no test framework — each `test*.mjs` is a standalone script that
prints `PASS`/`FAIL` lines and exits non-zero on failure (see `test-bot-ai.mjs` for the house style).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-26-bot-chase-press-obstacles-design.md`.
- Lock `football-mock:shared/bot-ai.js` must be held; re-read the file after acquiring (three agents
  were in it at once earlier today).
- **Never abort an armed commitment** (`bm.bombHold` / `bm.buildHold` / `bm.cata` / `bm.fly`). Refuse
  to start one, or route around it. Aborting `ambushWall` wind-ups measured builds 1.75 → 0.38/match.
- **No new physics constants.** Speeds from `CHARACTERS[char].speed * state.settings.speedMul`
  (`carrySpeedMul` for a carrier), ball motion from `predictBall`, wall segments from
  `segBlockedByWall` in `shared/arena.js`.
- **Grading is deterministic**, never stochastic: a reaction time or a lead-quality scale, never a
  coin flip (`decisionHz` ×7 and `mistakeP` are on the refuted list).
- Every new behaviour sets a `bm.lastTrick` tag so `bot-skill-census.mjs` can see it.
- Every measurement excludes ticks where `state.resetTimer > 0` (checked BEFORE `step()`).
- `botCanSee` / `perceivedPos` / shot gating (`canShoot`, `seeC`, `lane`) must not change.

---

### Task 1: The ball is never hidden from a bot

**Files:**
- Modify: `shared/bot-ai.js` — `updateBelief`, lines 814-840
- Test: `test-bot-chase.mjs` (create)

**Interfaces:**
- Produces: `updateBelief` keeps its shape `{ x, y, vx, vy, visible, age }`; `visible` is now always
  `true` and `age` always 0 for the ball. Consumed by `assignRoles` (focus pick) and Task 3.

- [ ] **Step 1: Write the failing test**

```js
// test-bot-chase.mjs — case 1: a loose ball inside the DEFAULT arena's phantom bush box,
// on MAIN_FIELD, with every bot far away, is still known exactly.
import { createState, addPlayer, attachBall, step, setField } from './shared/sim.js';
import { MAIN_FIELD } from './shared/main-field.js';
import { computeBotInputs, createBotMemory, assignRoles } from './shared/bot-ai.js';
import { DT } from './shared/constants.js';

const s = createState(); s.resetTimer = 0; setField(s, MAIN_FIELD);
for (const [id, team, slot] of [['A0','A',0],['A1','A',1],['B0','B',0],['B1','B',1]])
  addPlayer(s, id, { name: id, char: 'player', team, slot, isBot: true });
s.ball.owner = null; s.ball.x = 1000; s.ball.y = 550; s.ball.vx = 0; s.ball.vy = 0; // the phantom box
for (const id of ['A0','A1','B0','B1']) { s.players[id].x = 300; s.players[id].y = 100 + 60 * (id.charCodeAt(1) - 48); }
const mem = createBotMemory('normal'); mem.teamSkill = { A: 0.93, B: 0.93 };
const role = assignRoles(s, 'A', mem, DT);
ok(role.belief.visible === true, 'belief.visible for a loose ball in a phantom bush');
ok(Math.hypot(role.belief.x - 1000, role.belief.y - 550) < 1, 'belief position is exact');
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node test-bot-chase.mjs`
Expected: FAIL on `belief.visible` — `pointInBush(1000, 550)` is true for the default arena's centre
box and no bot is within `BUSH_REVEAL_DIST`.

- [ ] **Step 3: Make the ball's position unconditional**

In `updateBelief`, replace the three-way `visible` computation with an always-true position track,
keeping the variable so callers reading `visible`/`age` still work:

```js
  // THE BALL IS NEVER HIDDEN FROM A BOT (2026-07-26, user's ask).
  // A PLAYER always knows where the ball is: the renderer never conceals it in a bush (bushes hide
  // PLAYERS), and client.js:5917 pins an off-screen arrow to it. The old rule made a bot BLINDER
  // than the human it plays against — and because pointInBush() reads the DEFAULT arena's boxes on
  // every layout, it hid the ball where there was no bush: measured 18.6% of loose ticks on the
  // shipped pitch, worst spell 20.9s, and 44.7% / 37.4s on a generated one.
  // Enemy BODIES are unchanged: botCanSee/perceivedPos still gate every shot, so this is not x-ray.
  const visible = true;
```

- [ ] **Step 4: Run it and watch it pass**

Run: `node test-bot-chase.mjs` → both case-1 assertions PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/bot-ai.js test-bot-chase.mjs
git commit -m "fix(bots): the ball is never hidden from a bot" -- shared/bot-ai.js test-bot-chase.mjs
```

---

### Task 2: One bot always goes for a loose ball, full force

**Files:**
- Modify: `shared/bot-ai.js` — `SKILL_KEYS`/anchors (lines 86-135, add `chaseReact`), `assignRoles`
  (847-887), the loose-ball branch (2601-2620), the fetch fallback (2699-2714)
- Test: `test-bot-chase.mjs`

**Interfaces:**
- Consumes: Task 1's always-exact belief.
- Produces: `role.chaser` (the id committed to the loose ball, `null` when the ball is held);
  `bm.looseSince` (when this bot first saw the ball go loose); tag `chaseCommit`.

- [ ] **Step 1: Write the failing tests**

```js
// case 2: the designated chaser does NOT start a wall wind-up while the ball is loose,
// and its walk target points at the ball.
const inp = computeBotInputs(s, mem, DT);
const chaser = mem.teams.A.onBall;
ok(!inp[chaser].buildHold, 'chaser does not wind up a wall while the ball is loose');
const p = s.players[chaser];
const dot = ((s.ball.x - p.x) * inp[chaser].moveX + (s.ball.y - p.y) * inp[chaser].moveY);
ok(dot > 0, 'chaser moves toward the loose ball');

// case 3: a bot frozen on a bomb fuse is not made the chaser when its mate is free.
s.players.A0.x = 980; s.players.A0.y = 560;          // nearest by distance
mem.bots.A0 = { ...(mem.bots.A0 || {}), bombHold: { until: 9e9 } };
s.players.A1.x = 1200; s.players.A1.y = 600;
ok(assignRoles(s, 'A', mem, DT).onBall === 'A1', 'a frozen bot does not own the chase');
```

- [ ] **Step 2: Run and watch them fail**

Run: `node test-bot-chase.mjs`
Expected: case 3 FAILs (today's pick is nearest-by-distance and ignores commitments); case 2 may pass
by luck on this fixture, so it is a regression guard.

- [ ] **Step 3: Add `chaseReact` to the skill vector**

Add the key to `SKILL_KEYS` and one value per anchor — `VERY_EASY` 0.35, easy 0.26, normal 0.16,
hard 0.06, extreme 0.00 (seconds), mirroring `react`'s shape so the ladder keeps a perception-style
axis after the ball's fog is gone.

- [ ] **Step 4: Pick the chaser by arrival time, skipping frozen bots**

In `assignRoles`, when `!state.ball.owner`, score each bot with
`hyp(predictBall(...) - pos) / ownSpeed + (frozen ? 1.0 : 0)` where `frozen` is
`bm.bombHold || bm.buildHold || bm.cata || bm.fly`, and keep the existing `SWITCH_MARGIN` /
`MIN_HOLD` hysteresis so role thrash does not return. Set `r.chaser = onBall` when the ball is loose.

- [ ] **Step 5: Make the chaser refuse to root itself**

In the loose-ball branch: while `isOnBall`, clear a stale `bm.trap`, skip the bush-lurk target, and
set a flag consumed where wall wind-ups are armed so no new `buildHold` starts. Tag `chaseCommit`
once per commitment. Gate the commitment on `mem.t - bm.looseSince >= sk.chaseReact`.

- [ ] **Step 6: Drop the fetch skill gate for the chaser**

At the fetch fallback, replace `nd < 300 + 900 * skT(sk)` with an unconditional pass when
`role.chaser === p.id`, keeping the graded radius for the other bot.

- [ ] **Step 7: Run the tests**

Run: `node test-bot-chase.mjs` → cases 1-3 PASS.

- [ ] **Step 8: Commit**

```bash
git commit -m "feat(bots): one bot always commits to a loose ball" -- shared/bot-ai.js test-bot-chase.mjs
```

---

### Task 3: Somebody always contests a ball in enemy hands

**Files:**
- Modify: `shared/bot-ai.js` — new `interceptPoint` helper beside `predictBall` (~line 905), the
  enemy-carrier press branch (2266-2280), the `MIN_SEP` block (2626-2631)
- Test: `test-bot-chase.mjs`

**Interfaces:**
- Consumes: `sk.leadGain`, `CHARACTERS`, `state.settings.speedMul` / `carrySpeedMul`.
- Produces: `interceptPoint(me, carrier, state, sk) -> {x, y}`; tags `pressIntercept`, `secondPress`.

- [ ] **Step 1: Write the failing tests**

```js
// case 4: an enemy carrier running perpendicular is INTERCEPTED, not trailed.
// carrier at (1000,300) moving +y at 300px/s, presser at (600,300):
// the walk target must be ahead of the carrier on its movement axis.
const t4 = interceptPointForTest(s, 'A0', 'B0');
ok(t4.y > 300 + 20, 'intercept leads the carrier down its run');

// case 5: with the on-ball bot frozen on a fuse, the support closes inside MIN_SEP 320.
ok(hyp(target.x - carrier.x, target.y - carrier.y) < 320, 'support waives MIN_SEP when nobody presses');
```

- [ ] **Step 2: Run and watch them fail** — `interceptPoint` does not exist yet; the press target is
the carrier's body, and `MIN_SEP` holds the support at 320 px.

- [ ] **Step 3: Add the helper**

```js
// Where to WALK to take the ball off a carrier: not at their body (that trails them forever), but
// at where they will BE when we arrive. No new physics: our own speed is the sim's
// (CHARACTERS.speed x speedMul), the carrier's is the sim's carry speed, and the lead is scaled by
// the tier's existing leadGain so a weak bot mis-leads instead of being handed a perfect solution.
function interceptPoint(me, carrier, state, sk) { /* tau = clamp(dist / mySpeed, 0, 0.9) */ }
```

- [ ] **Step 4: Use it in the press branch, tag `pressIntercept`.**

- [ ] **Step 5: Waive `MIN_SEP` when nobody presses**

In the `!isOnBall` carried-ball case: if no team-mate is within `PRESS_RANGE` of the carrier, or the
`onBall` bot is frozen, target `interceptPoint` instead of the 320 px shadow and tag `secondPress`.

- [ ] **Step 6: Run the tests** → cases 1-5 PASS.

- [ ] **Step 7: Commit**

```bash
git commit -m "feat(bots): intercept the carrier's run, and always have a presser" -- shared/bot-ai.js test-bot-chase.mjs
```

---

### Task 4: Obstacles — carrier-sized clearance and a tested bomb-jump path

**Files:**
- Modify: `shared/bot-ai.js` — `steer()`'s `clearAt`/ray test (620-655), `navEnsure`/`navField`
  (517-575), `mobilityJump` + `cannonPlant` fallback (1101-1160)
- Test: `test-bot-chase.mjs`

**Interfaces:**
- Produces: `steer()` uses `r + ballRadius` for ray blockage while carrying; `navEnsure` gains
  `occCarry`; `mobilityJump` refuses a blocked flight path.

**Deviation from the spec, deliberate:** the spec proposed a soft per-arena cost layer. Implemented
instead as (a) carrier-radius clearance inside `steer()`, which is where the ball actually pops, and
(b) a second nav occupancy grid at the carrier radius used only to VETO a waypoint a carrier cannot
use, falling back to the body waypoint. Same intent, and it can never make reachability worse — the
inflated grid already blocks ~17% of the pitch at the body radius.

- [ ] **Step 1: Write the failing tests**

```js
// case 6: a carrier facing a gap narrower than its ball diameter prefers the wider way round.
// two capsules leaving a 70px gap (body 52px fits, carrier's 58px glue spot does not).
ok(Math.abs(inp.A0.moveY) > 0.3, 'carrier steers around a ball-popping gap');

// case 7: a bomb jump whose flight path crosses a capsule is refused; without the wall it is taken.
ok(blockedJump === null, 'bomb jump into a wall is refused');
ok(clearJump !== null, 'the same jump with the wall gone is taken');
```

- [ ] **Step 2: Run and watch them fail.**

- [ ] **Step 3: Carrier clearance in `steer()`** — when `state.ball.owner === bot.id`, the ray-block
sample radius becomes `r + ballRadius(state)`; the graze term keeps the body radius so tight maps
stay walkable.

- [ ] **Step 4: Carrier nav veto** — build `occCarry` in `navEnsure` with `radOf(state) + ballR`; in
the waypoint step, if the bot is carrying and the body waypoint's cell is blocked in `occCarry`, take
the nearest free carrier cell instead, else keep the body waypoint.

- [ ] **Step 5: Bomb-jump path test** — in `mobilityJump`, refuse when `segBlockedByWall` reports the
plant→landing segment blocked over `arenaOf(state).walls.concat(state.builtWalls)`; screen
`cannonPlant`'s `return best || {…}` fallback with `launchCancelled`.

- [ ] **Step 6: Run the tests** → cases 1-7 PASS.

- [ ] **Step 7: Commit**

```bash
git commit -m "fix(bots): a gap a body fits is not a gap a carrier fits" -- shared/bot-ai.js test-bot-chase.mjs
```

---

### Task 5: Measure, then report honestly

**Files:** none modified (measurement only). Results go to
`summery/bots logic handoff/` and `AGENT_REQUEST_LOG.md`.

- [ ] **Step 1: Suite** — `for f in test*.mjs; do node $f; done`, listing pre-existing failures
  separately (`test-rank-parity.mjs` needs the sibling repo and passes in a real checkout).
- [ ] **Step 2: Felt metrics** — `node bot-feel.mjs` and `SKA=0.93 SKB=0.93 node bot-feel.mjs`:
  `notClosing%`, retreat-while-nearest, `reachS`, jam %, worst jam. A/B against HEAD minus my own
  hunks (`git apply -R`), never a frozen base.
- [ ] **Step 3: Census** — `MIRROR=1 node bot-skill-census.mjs`: blind time must be 0 on every arena,
  and the tag mix must not collapse.
- [ ] **Step 4: Ladder** — `SEEDS=6 ARENA=main node test-bot-ladder.mjs`. Report rho at the ends
  whatever it says; if it compressed, widen `chaseReact`'s span first and re-measure.
- [ ] **Step 5: Watch it** — rebuild `public/_arena-watch.html`, drive it over CDP, confirm no
  exceptions and that `chaseCommit` / `pressIntercept` / `secondPress` appear in the play log.
- [ ] **Step 6: Write it up + commit** — append a round to `summery/BOT_HANDOFF.md`, log the request
  in `AGENT_REQUEST_LOG.md`, release the lock.

## Self-review

- **Spec coverage:** ask 1 → Task 2; ask 2 → Task 3; ask 3 → Task 1; ask 4 → Task 4; the spec's
  testing section → Task 5. The spec's "enemy-body blocking only if it measures well" is folded into
  Task 5 Step 2 as a decision point, not a code step.
- **Placeholders:** the only prose-only step is Task 4 Step 3-5, where the exact expressions depend
  on the surrounding code being re-read under the lock; each names the function, the condition and
  the sim primitive to use.
- **Type consistency:** `interceptPoint(me, carrier, state, sk)` is used with that signature in
  Tasks 3 and 5; `role.chaser` is written in Task 2 and read in Tasks 2 and 3; `occCarry` is written
  and read only in Task 4.
