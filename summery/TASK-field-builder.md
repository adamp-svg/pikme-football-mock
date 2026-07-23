# TASK: Field Builder (place bush / rotatable hard wall / dry wall → play vs bots)

**Owner:** opus-build78. Lock: `football-mock:task-field-builder`. Spec: `docs/superpowers/specs/2026-07-23-field-builder-design.md`.
**Status:** DONE — fully implemented + committed (engine, server, client render, UI). Awaiting visual test on :3012 + finalization push.

_(historical de-confliction note below)_

**(was) PAUSED for de-confliction** — another agent (friends-party) has uncommitted edits in the SAME files (server.js, index.html, client.js). User decision: **opus-game commits first, then me.** Waiting for a clean tree.

## DONE (committed 8e61c93, pushed)
- Engine (arena.js/sim.js/constants.js): hardWall capsule (indestructible), dry wall (destructible, `DRY_WALL_HP=2`), `buildArenaFromField`, `dryWallSeeds`, `setField`, `seedFieldWalls` (reseed each kickoff), MAX_BUILT cap protects field walls.
- bot-ai.js: `arenaOf(state)` — bots use the custom arena.
- test-field.mjs (8/8). All sim suites green (test-power pre-existing fail unrelated).

## IN-FLIGHT (uncommitted in shared tree, mixed with friends-party work)
- server.js: added `sanitizeField()` + `startBuilderMatch(member, field)` (training-style, endless, `setField` + `fillBots` backfill, sends `matchStart {mode:'builder', arena: clean}`). Backup patch: scratchpad/field-builder-server-additions.patch.
- **NOT yet added** (blocked by collision): the `if (msg.type === 'builderMatch') { startBuilderMatch(member, msg.field); return; }` handler in the ws message switch (near the `quickMatch`/`training` handlers).

## REMAINING (after tree is clean)
- server.js: add the `builderMatch` message handler (above).
- client.js (Phase C+E): import `buildArenaFromField`; on matchStart store `customArena = msg.arena ? buildArenaFromField(msg.arena) : null`; `fieldArena()` returns `customArena || (training?TRAIN_ARENA:ARENA)`; `drawWallBlock(w)` render angled capsule (reuse `wallSlab`/`drawBuiltWall` slab, stone palette) when `w.angle != null`. Dry walls render via existing `drawBuiltWall` (they ride the snapshot as builtWalls).
- client.js + index.html + style.css (Phase D): "Field Builder" hub entry → builder screen reusing the game canvas; palette (bush/hard/dry); tap-place, drag-move, rotate handle (snap `Math.PI/16`), delete; Mirror (across x=1000) / Clear / Save (localStorage `pikme-field-v1`) / Play (`sendMsg({type:'builderMatch', field})`) / Back.
- Test on :3012, commit, deploy via Render CLI (`render deploys create srv-d9ebcvtaeets73ar91sg -o json --confirm` after pushing main).
