# TASK: bomb still pushes a player behind an INDESTRUCTIBLE wall

**Owner:** opus-build78 (orchestration id 08470aa8…). Lock: `football-mock:task-bomb-wall-push` + `football-mock:shared/sim.js`.
**Repo/branch:** football-mock @ `feat/build-bomb-cancel`. All work LOCAL (localhost:3012). opus-game parked (user's instruction).
**Status:** IMPLEMENTED + tested (2026-07-23). Awaiting user live-verify on :3012.

## IMPLEMENTED (spec R1–R4, from user)
- **R1** — static wall in the launch line cancels your OWN bomb-jump (directional cone check, `wallCannonMul`-style, in `explode` bomberOnCenter). Blast vs other players already blocked. Jumping toward open space still launches.
- **R2** — bomb behind BUILT wall: `BLAST_WALL_PASS_MIN 0.0→0.25` → full-HP=25% leak, ramping to 100% at 0 HP.
- **R3** — split `wallCannonMul`: static peak `BOMB_WALL_CANNON_STATIC=1.20` (+20%), built `BOMB_WALL_CANNON_BUILT=1.15` scaled ×(hp/maxHp).
- **R4** — super (overcharge) shot behind BUILT wall punches through with `pr.coverMul` = {hp3:0.10, hp2:0.30, hp1:0.50}; static stone still blocks shots dead. Non-super shots keep tier-absorb.
- Files: `shared/constants.js`, `shared/sim.js`. Tests: `test-cover.mjs` rewritten (R1–R4) — 14/14 PASS; all 6 other sim suites PASS.
- DEBUG_COVER instrumentation removed.

## Superseded earlier note
opus-game's `e859ef0` had full-HP built wall = 0% leak; user changed to 25% (R2). Kept COVER_PAD=28.

---
(historical investigation below)

## ROOT CAUSE (confirmed via live :3012 capture)
Connected repro logged exactly ONE bomb event:
- `[EXPLODE] bomb(789,1002) owner=m-2 bomberOnCenter=true training=true`
- `[SELF-LAUNCH] m-2 launched by own bomb: launch=1600 dir=(-1.00,0.06)`
- COVER=0, FLY-HIT=0 (no enemy blast victim, no tackle).

The "push behind the wall" is the player's **own bomb-jump self-launch** (`explode` bomberOnCenter branch, sim.js ~987). launch 1600 = bombPower 2000 × BOMB_CENTER_LAUNCH_MUL 0.80; wallCannonMul = 1.0 (NO amplification), under BOMB_LAUNCH_MAX 3000. It's a NORMAL bomb-jump.
- Self-launch has **NO wall cover by design** (movement mechanic off your own bomb).
- The ENEMY-blast cover path (`[COVER]`, sim.js ~1014) works correctly — verified in mocks + never fired here.
- Likely the user tested SOLO by dropping their own bomb → always self-launches regardless of walls. Enemy bombs behind the wall ARE shielded.

## DECISION NEEDED
Should an indestructible wall the player is tucked behind suppress/reduce their OWN bomb-jump launch? Options:
- A) Leave as-is (self bomb-jump is intended; cover only vs enemy bombs).
- B) Zero/greatly reduce self-launch when a static wall sits between the bomber and their launch direction (or adjacent).
- C) Let the wall collision simply stop the launched body (may already partly happen via resolveWalls).

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
