# TASK: remove auto-aim from the football game

**Owner:** opus-build78. Locks: `football-mock:task-remove-autoaim` + `shared/sim.js`. LOCAL + deploy to Render.
**User request (verbatim):** "ok let remove the autoaim" → then "commit push" → "deploy".
**Status:** DONE — committed, pushed, deployed to Render.

## What changed
- `shared/sim.js`:
  - Carrier QUICK shot no longer snaps to the enemy goal — uses `p.aimX/p.aimY` (manual).
  - QUICK bullet no longer snaps to nearest visible enemy — uses manual aim.
  - (Helper fns `nearestGoalPoint` / `nearestVisibleEnemy` now unused but left in place; harmless.)
- `public/client.js`: `currentAim()` no longer shows the quick-shot auto-target guide — the aim indicator is always the manual aim.
- `test-autoaim.mjs`: rewritten to assert the INVERSE (every shot honours manual aim). 4/4 PASS.

## Verification
- test-autoaim 4/4, test-cover green, all other sim suites green EXCEPT test-power (see below). client.js `node --check` OK.

## ⚠️ Pre-existing failure (NOT this task)
- `test-power.mjs` fails 2 medium-hit overcharge-meter assertions AT HEAD without my changes — introduced by user commit `a260fb1` ("charge overcharge meter only on enemy hits, not on firing"). The test wasn't updated to the new meter behavior. Flagged to user; not fixed here (needs a product call on intended meter values).

## Deploy
- Render `pikme-football` (srv-d9ebcvtaeets73ar91sg) deploys `main`, but the GitHub webhook is dead → deploy via CLI:
  `render deploys create srv-d9ebcvtaeets73ar91sg -o json --confirm` (after pushing main).
- App build 78 (TestFlight) loads the Render URL live via WebView — no app rebuild.
