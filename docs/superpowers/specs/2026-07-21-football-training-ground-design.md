# Football Training Ground — Design Spec

**Date:** 2026-07-21
**Component:** `football-mock`
**Status:** Approved, building on localhost first.

## Goal

A Brawl-Stars-style practice cave: a dedicated solo field where the player can
freely practice every mechanic — shooting, charging, planting bombs, building
walls, and dribbling the ball — with one **penned dummy bot** near the far goal
that roams as a live target but never leaves its zone.

## Approach

Add a new server **room mode** `'training'`. This reuses the entire existing
render / network / snapshot / sim pipeline, so training looks and feels
identical to a real match with zero renderer rewrite. (Rejected: fully
client-side sim — the client has no sim-driven renderer today; and hacking the
quick-match path — muddies matchmaking with training special-cases.)

## Design

### 1. Server: `training` room mode
- `makeRoom(id, isPrivate, mode)` gains `mode` (`'match'` default | `'training'`).
- `startTraining(member)`:
  - `leaveCurrentRoom`, make a `mode:'training'` room, add the human to **team A**.
  - Add exactly **one bot on team B** (`isBot`, `isTrainingDummy: true`); the other
    slots stay empty (skip `fillBots` for training).
  - `state.noClock = true`, `attachBall(state, 'A')`, `phase = 'match'`, send
    `matchStart` immediately — no countdown, no team-intro.
- `step()` guard: skip the `elapsed >= MATCH_DURATION → 'ended'` transition when
  `state.noClock`. Goals still tally and kickoff-reset endlessly.
- `tickRoom` for training uses `trainingBotInputs` instead of `computeBotInputs`,
  and skips the "0 humans → endRoom" only insofar as normal (leaving still ends it).

### 1b. Midfield "sentry" enemy (added)
A second team-B bot (`sentry`) spawned at `CENTER` (2nd team-B slot):
- **Holds midfield**: steers back to `CENTER` whenever shoved; otherwise still.
  Not penned/clamped — the return-to-centre steering is the confinement.
- **Always faces the player**: `aim` tracks the human every tick.
- **Random-burst fire**: flips between a firing window (sprays as fast as the gun
  allows, capped by `shootCd`/ammo/reload) and an idle window that is sometimes
  long — "sometimes many, sometimes none". Never plants, builds, or carries.

### 2. Penned dummy bot ("roaming target")
`trainingBotInputs(room)`:
- **Pen zone**: rectangle in front of team B's (far) goal. Bot's target position
  is clamped inside it; its actual `x/y` is hard-clamped in the tick after
  `step()` so knockback can never punt it out ("does not go past").
- **Roam**: ball far → pace side-to-side across the zone (slow, smooth).
- **Block**: ball near the zone → sit between the ball and the goal centre.
- **Passive**: never shoots, plants, builds, steals, or carries. Pure target.

### 3. Client
- **Entry**: an **אימון** card in the home modes row → sends `{type:'training'}` →
  routes the resulting `matchStart` straight into `#game`, skipping the VS /
  team-intro overlay (instant entry).
- **HUD**: reuse game HUD; hide the match clock (there is none). Show a small
  **אימון** label, a small live score counter, and a **reset ball ↺** button that
  recenters the ball at kickoff on demand.
- **Leave**: existing leave control → `toHome`, same as a normal match.
- **Pen marker**: faint zone outline drawn on the pitch showing the dummy's box.

### 4. Testing
- `test-training.mjs`: assert 1 human + 1 bot + `noClock`; run 60s of ticks and
  assert `phase` never becomes `'ended'`; drive a bomb/knockback at the bot and
  assert it stays inside the pen; assert the bot never fires/builds/plants.
- Smoke on `localhost:3010`: instant entry + penned roaming + reset ball.

### 1c. Custom training field (added)
Training swaps the global mirror-symmetric arena for a deliberately asymmetric one
(fairness doesn't apply to solo practice), via a per-room override `state.arena`:
- **Large bush, top-left** — cover for stealth / bush-fire practice.
- **Large indestructible steel wall, bottom-right** — a fixed barrier that blocks
  players and ricochets the ball; can't be destroyed.
- Only these two (plus goals/pen/sentry) — the default stone blocks + bushes are
  cleared in training.

Implementation: `shared/training.js` exports `TRAIN_ARENA` (`TRAIN_WALLS` +
`TRAIN_BUSHES`). The sim reads `arenaOf(state) = state.arena || ARENA` at every
obstacle site (`resolveWalls` gained a `staticWalls` param; `boxInBush` takes
`state`). The client swaps to `TRAIN_ARENA` via `fieldArena()`/`inBushAt()` when
the `training` flag is on. Neither is sent over the wire — both sides derive it.

## Out of scope
- No new pitch geometry beyond the training obstacle swap (FIELD dimensions unchanged).
- No difficulty tiers for the dummy, no scoring drills/targets, no persistence.
