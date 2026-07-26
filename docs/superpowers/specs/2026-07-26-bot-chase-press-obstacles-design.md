# Bots: always chase, always contest, always know where the ball is — design

**2026-07-26 · agent `chase-press` · HEAD `27cd6e8` · approved by the user before implementation.**

The user's report: *"they still sometimes struggle to get the objective."* Four asks, verbatim:

1. one bot always goes after the ball, full force, if it is not in enemy hands;
2. at least one bot tries to detach and go after a ball **in enemy hands**, or at least intercept
   where the enemy is going;
3. they must **always** know where the ball is — "ball is visible in a bush and also off screen there
   is an arrow for the player, so bots ALWAYS know the ball's exact location";
4. improve obstacles.

Two decisions the user made when asked:

- **Universal verb, graded execution.** Every difficulty level always chases and always contests; weak
  bots execute it worse. Not "identical at every level" — `LOGIC-HANDOFF-session.md` §2 measured that
  making a behaviour equally *reliable* for all tiers collapsed the ladder (spread 1.10 → −0.04).
- **Ball position always exact; shooting still needs sight.** No x-ray on the enemy *body*:
  `botCanSee` / `perceivedPos` are untouched, so bots cannot fire out of fog. Removing the ball's fog
  is a **fairness correction**, verified in the client: `client.js:5917` pins an off-screen arrow to
  the ball and the renderer never hides the ball in a bush, so a player always knows where it is and
  a bot currently does not.

## What the four prior handoffs constrain

`summery/bots logic handoff/` — all four read before writing this.

| constraint | source | effect on this design |
|---|---|---|
| Seven of nine live defects are ONE defect: `bot-ai.js` re-derives physics `sim.js` owns | `ARCHITECTURE-REVIEW` §2.1 | the intercept adds **no new physics model**: closing speed comes from `CHARACTERS[char].speed × settings.speedMul`, ball motion from the existing `predictBall`, wall tests from `arena.js segBlockedByWall`. One small helper, oracle-ready (§3 A1). |
| A commitment is not owned by the branch that armed it | `LOGIC-HANDOFF` §1 / `ARCHITECTURE-REVIEW` §2.2 | the chaser **never aborts** an armed commitment. It refuses to *start* one while the ball is loose, and the role picker routes the chase to a bot that is not frozen. |
| "Aborting a wind-up whose premise moved" — builds 1.75 → 0.38/match | `LOGIC-HANDOFF` §5 | same rule as above, stated as a hard no. |
| Stochastic handicaps failed 8× (`decisionHz` ×7, `mistakeP`) | `BOT_HANDOFF` §4 | grading is a **reaction time**, never a coin flip. |
| Difficulty lives in perception + accuracy, not degraded planning | `ARCHITECTURE-REVIEW` §4 (Supercell, Epic's Guard Spawner) | removing ball fog spends one perception lever; the surviving axes are named in "Ladder accounting" below and must be measured. |
| Freeze ticks fool harnesses (3 instances this session) | `ARENA-AUDIT` §0 | every measurement excludes `resetTimer > 0` ticks. |
| Named plays + determinism are the repo's biggest asset | `ARCHITECTURE-REVIEW` §2.4 | every new behaviour gets a `bm.lastTrick` tag; no `Math.random`. |
| Bot brain costs 0.31 µs/bot/tick; `step()` is 3.4× more | `ARCHITECTURE-REVIEW` §1 | the obstacle fix can afford a real per-arena clearance layer. |

## The four changes

All in `shared/bot-ai.js` unless stated. Lock `football-mock:shared/bot-ai.js` held.

### A · Ball knowledge becomes exact (ask 3)
`updateBelief` keeps its signature and return shape, but the ball's position is always the live one:
the `visible` branch that consults `pointInBush` + `BUSH_REVEAL_DIST` for a loose ball, and
`botCanSee` for an enemy carrier, no longer gates the **position**. Dead-reckoning (`age`, the
1.2 s clamp) becomes unreachable for the ball and is kept only so callers reading `age`/`visible`
still work; `visible` reports `true`.

Consequences by design: `assignRoles`'s focus is always the true ball/carrier, `fetchBall`'s
nearest-player test was already on the true ball, and the arena-blind `pointInBush` stops mattering
for ball knowledge (it still skews `ambushLurk` / `chooseAmbushBush` spots — out of scope, still
recorded in `ARENA-AUDIT`).

### B · One bot always goes for a loose ball, full force (ask 1)
1. **Role pick by arrival time, not distance.** In `assignRoles`, when the ball is loose, rank the two
   bots by `dist / ownSpeed` against `predictBall`, and **de-prioritise a frozen bot** (`bm.bombHold`,
   `bm.buildHold`, `bm.cata`, `bm.fly`). Existing `SWITCH_MARGIN` / `MIN_HOLD` hysteresis is kept —
   role thrash is on the refuted list (7–9 switches/60 s is fine).
2. **The designated chaser refuses to root itself.** While the ball is loose and this bot is `onBall`:
   do not *start* a wall wind-up, do not enter a bush lurk, and clear a stale `bm.trap`. Armed
   commitments are left alone (see the constraint table).
3. **The fetch fallback loses its skill gate for the chaser.** `bot-ai.js:2706`'s
   `nd < 300 + 900 * skT(sk)` notice radius stays for the *other* bot and becomes unconditional for
   the designated chaser.
4. **Graded execution — `chaseReact`.** A new skill-vector key: seconds between the ball going loose
   and the chase commitment (≈0.35 s at `t=0`, 0 s at `t=1`), held on `bm.looseSince`. Deterministic,
   monotone in `t`, and it is a reaction time — the axis Epic and Supercell actually ship.
5. Tag: the chase keeps `fetchBall`; the pre-emption path tags `chaseCommit` so it is measurable.

### C · Somebody always contests a ball in enemy hands (ask 2)
1. **Intercept, don't trail.** The presser's walk target becomes
   `interceptPoint(me, carrier, state)`: carrier position advanced by its own velocity over the
   closing time `tau = clamp(dist / mySpeed, 0, 0.9)`, then biased toward the carrier's goal side so
   the bot cuts the run. `tau` uses the sim's own speed (`CHARACTERS[char].speed × settings.speedMul`,
   and `carrySpeedMul` for the carrier), and the lead is scaled by the existing `sk.leadGain`, so weak
   bots mis-lead. One helper, no new constants beyond the two clamps.
2. **The guarantee.** When the ball is in enemy hands and no team-mate is inside `PRESS_RANGE` of the
   carrier (or the `onBall` bot is frozen), the support bot's `MIN_SEP = 320` shadow is **waived** and
   it presses too — the mechanism `pincer` already uses at `t ≥ 0.92`, generalised to every tier and
   gated on *nobody is pressing* so it cannot become "both bots crowd the carrier".
3. Shot gating (`canShoot`, `seeC`, `lane`) is untouched: no shooting out of fog.
4. Tag: `pressIntercept` for the led approach, `secondPress` for the waiver.

### D · Obstacles (ask 4)
1. **Carrier-aware pathing.** The nav grid inflates by the body radius (26.25 px) while a carrier's
   ball rides at `radius + ballR` ≈ 58.25 px and pops on any wall — 7.7% of legs the grid calls
   walkable pop the ball (`README` §4.2). Add a per-arena **wall-proximity byte layer**, built once
   beside the cached grid and keyed on the same `navSig`, and charge a carrier extra cost for cells
   inside the glue radius. A soft cost, not an occupancy bit, so tight maps stay passable. The
   reactive half already exists in `finalize()` (it rotates the emitted aim); the joint (path, aim)
   predicate the research asks for stays out of scope and is noted as follow-up.
2. **Bomb-jump path clearance.** `mobilityJump` / `kickAndFly` / `cannonPlant` clamp the landing point
   to the pitch but never test the flight path, so a jump into a capsule wastes the charge. Test the
   plant→landing segment with `segBlockedByWall` over `arenaOf(state).walls` + `state.builtWalls` and
   refuse the jump if blocked; also screen `cannonPlant`'s fallback return with `launchCancelled`,
   which today returns an unscreened default.
3. **Enemy-body blocking** (~2% of move ticks at L10) — only if the measurement shows the avoidance
   weight helps. Skipped otherwise, and the negative result recorded.

## Ladder accounting (the risk the user accepted)

Perception levers **removed**: ball fog (all tiers). Levers **kept**: enemy vision box + `visionMul`,
`aimSigma`, `leadGain`, `react`, `toolSkill`, `aggro`, `memoryS`, `cdMul`, patience above `t = 0.62`.
Levers **added**: `chaseReact`, and the intercept lead quality (via `leadGain`).

Gate: `SEEDS=6 ARENA=main node test-bot-ladder.mjs` must still rank at the ends (goals / strips /
shots-on-goal rho ≈ 0.9 today). If it compresses, the honest report is the compression, not a
retuned gate — and `chaseReact`'s span is the first knob to widen.

## Testing

New `test-bot-chase.mjs`, six cases, each a hand-built fixture in the real sim:

1. a loose ball inside the default arena's phantom bush box, on `MAIN_FIELD`, with both bots 600 px
   away → `updateBelief` returns the exact position and `visible === true`;
2. a bot with a pending wall wind-up while the ball goes loose nearby → no new `buildHold` is armed
   and the walk target points at the ball;
3. an enemy carrier moving perpendicular at speed → the presser's target leads the carrier (ahead of
   its body on the movement axis, on the goal side);
4. an enemy carrier with the `onBall` bot frozen on a bomb fuse → the support closes inside
   `MIN_SEP`;
5. a carrier whose straight path threads a gap narrower than the glue diameter → the chosen leg costs
   more than the wider detour (carrier layer active), and the same test with no ball → unchanged;
6. a bomb jump whose flight path crosses a capsule → refused; the same jump with the wall removed →
   taken.

Then, in order: full `test*.mjs` suite (pre-existing failures listed separately) ·
`node bot-feel.mjs` (jam %, worst jam, `notClosing%`, retreat-while-nearest, reach-s) ·
`node bot-skill-census.mjs` (blind time → 0; the skill mix must not collapse) ·
`SEEDS=6 ARENA=main node test-bot-ladder.mjs`. A/B by reverse-applying my own hunks against HEAD
(`git apply -R`), never a frozen base (`BOT_HANDOFF` §3.5), and never counting freeze ticks.

## Out of scope, deliberately

The A1 physics oracle and A2 plan-object refactors (`ARCHITECTURE-REVIEW` §3) — this change is
written so as not to add new instances of either problem, but it does not perform the refactors.
The release-ladder range gate (`bot-ai.js:1727`, 77% of shots cannot arrive) is the biggest single
leak in the file and is **not** part of this spec: it is a shooting defect, not an objective-chasing
one, and it deserves its own measurement.
