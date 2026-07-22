# TASK: bomb still pushes a player behind an INDESTRUCTIBLE wall

**Owner:** opus-build78 (orchestration id 08470aa8…). Lock: `football-mock:task-bomb-wall-push` + `football-mock:shared/sim.js`.
**Repo/branch:** football-mock @ `feat/build-bomb-cancel`. All work LOCAL (localhost:3012). opus-game parked (user's instruction).
**Status:** INVESTIGATING — root cause not yet confirmed.

## User requests (verbatim log, for handoff)
1. "the bomb still pushes back behind wall lets focus on fixing only that"
2. clarification: "im talking about indestructable wall bomb push" (STATIC/arena wall, not built)
3. "in 3012 bomb behind wall still pushes back"
4. scenario answer: **"Bomb straight in front, still pushed"** (bomb on the far side of the wall, victim still knocked)
5. "still push"
6. "if you are having difficulties build a mock arena to test"
7. "you start working on the football game... lock yourself the task... all changes in local host, commit everything. log my every request so other agent can pick up if you fail."

## Findings so far
- Cover code lives in `shared/sim.js`:
  - blast/`explode` target loop ~line 1014: `arenaOf(state).walls.some(w => segBlockedByWall(w, bomb, t, COVER_PAD)) → continue` (static = full immunity).
  - built-wall softening ~1016 (coverPass by hp).
  - bomb-fly tackle `resolveFlyingHits` ~1088: has a static-wall check with **pad 0** (not COVER_PAD).
- opus-game already committed `e859ef0`: `BLAST_WALL_PASS_MIN 0.15→0.0`, `COVER_PAD 8→28`. `test-cover.mjs` passes 14/14.
- Server-side sim SHIELDS CORRECTLY in every mock I built (default arena, training L-wall, mock pillar). It even OVER-shields: a victim on the SAME side as the bomb, within 28px of a wall, gets 0 push (bomb sits in COVER_PAD zone).
- **Could NOT reproduce a push behind a static wall server-side.**
- Instrumented `:3012` with `DEBUG_COVER=1` (uncommitted debug log in explode loop). During the user's "still push" test it captured **0 COVER events** → the client that showed the push was NOT hitting this server.

## Leading hypothesis
- **Client-side prediction / stale client**, NOT server sim. Client runs shared/sim.js locally; if its arena/walls aren't loaded (training flag, or stale tab) it predicts a push the server never applies → user SEES a push that snaps back. That's `public/client.js`, not `sim.js`.

## Next steps
1. Get a CONNECTED repro on :3012 (hard reload) → read `[COVER]` logs to confirm server path.
2. If server logs show `staticBlocked=true` but client shows push → confirm client-prediction bug in `public/client.js` (check client arena/wall setup + how it applies bomb knockback in prediction).
3. Candidate real fix (server, minor): `resolveFlyingHits` uses pad 0 — bomb-jump tackle can leak near wall edges; align to COVER_PAD if that's the vector.
4. Remove the `DEBUG_COVER` instrumentation before final.

## Debug tooling
- Server: `DEBUG_COVER=1 PORT=3012 node server.js` → logs every blast/target cover decision.
