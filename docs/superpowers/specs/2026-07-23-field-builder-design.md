# Field Builder — spec + plan (2026-07-23)

**Owner:** opus-build78. Lock: `football-mock:task-field-builder`. LOCAL + deploy to Render (CLI).
**User request:** "let the user create a field with common elements: bush, hard wall (can rotate), dry wall" → flow: **build → play a vs-bots match** on a **new in-game Field Builder screen**; **free-form placement + optional Mirror button**; **save one field to localStorage**. Then: "yes plan, build, test commit".

## Element model (reuses existing collision + render)
- **bush** — box `{type:'bush', x, y, w, h}`. Stealth, no physics (existing bush semantics).
- **hard wall** — indestructible **rotatable capsule** `{type:'hard', cx, cy, angle, hl, ht}` (+ derived AABB x/y/w/h for render/broadphase). Lives in the arena `walls[]`; never destroyed. Capsule collision already exists in arena.js (`angle != null`).
- **dry wall** — destructible capsule `{type:'dry', cx, cy, angle, hl, ht, hp, maxHp}`. Seeded into `state.builtWalls` at each kickoff so it respawns per point and reuses ALL built-wall mechanics (destruction, R2/R4 cover, R3 cannon). `hp = DRY_WALL_HP` (2).

## Field layout object (localStorage key `pikme-field-v1`)
```
{ version:1, bushes:[{x,y,w,h}], hardWalls:[{cx,cy,angle,hl,ht}], dryWalls:[{cx,cy,angle,hl,ht}] }
```

## Phases (build order)
- **A. Engine** (`shared/arena.js`, `shared/sim.js`, `shared/constants.js`):
  - arena `walls[]` may contain angled hard-wall capsules (indestructible). Verify segBlockedByWall / resolveWalls / nearestOnWall / wallCannonMul handle them (they branch on `angle`).
  - `state.fieldDryWalls[]`; seed copies into `state.builtWalls` on kickoff/reset (they currently clear on kickoff).
  - `buildArenaFromField(field)` → `{walls, bushes, trampolines:[]}`; helper to derive AABB from a capsule.
  - DRY_WALL_HP constant.
- **B. Bot AI** (`shared/bot-ai.js`): replace direct `ARENA.*` reads with the active arena (pass arena / use `arenaOf`), so bots path around custom walls.
- **C. Networking** (`server.js`, client): client sends `field` on room create; server builds arena + seeds dry walls; server sends the field layout to clients once (new `field` message or in the join ack) for rendering.
- **D. Builder UI** (`public/client.js`, `public/index.html`, `public/style.css`): hub entry "Field Builder"; palette (bush/hard/dry); tap-to-place, drag-move, rotate handle (snap to WALL_ANGLE_QUANT), delete; Mirror / Clear / Save / Play buttons; bounds clamp + block goal/spawn overlap; localStorage.
- **E. Render** (`public/client.js`): draw angled hard walls (reuse built-wall capsule render), bushes, dry walls.
- **F. Tests** (`test-field.mjs`): hard wall indestructible + rotated collision/cover; dry wall destructible + respawns on kickoff; buildArenaFromField + mirror correctness. Manual playtest on :3012.

## Deploy
Render `pikme-football` (srv-d9ebcvtaeets73ar91sg) via CLI (`render deploys create ... -o json --confirm`) after pushing main; GitHub webhook is dead. App build 78 loads it live (no rebuild).

## Notes / risks
- Arena is normally compiled-in and never wired; custom field is the first case that must travel over the wire — keep it to a single small layout message.
- Symmetry is opt-in (Mirror button mirrors across x=1000). No auto-fairness enforcement.
