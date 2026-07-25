# Arena sizes — what shipped, and what stage 2 needs

> Written 2026-07-26 by agent `3v3-arena`. Request: *"you work on a new 3v3 game, should allow 3v3
> players, and make the stadium bigger… do research and use the council… also add option in the
> arena builder to build a bigger stadium for 3v3 (and maybe 5v5 in the future)."*

## The sizing decision (settled — do not re-open without the user)

**3v3 plays on 2000×1100, unchanged.** The user was asked twice and chose this both times, the
second time *after* being shown a correction that argued the other way. So this is a decision, not
an oversight: crowding at 3v3 is solved by **layout** (`shared/field-3v3.js` — open central channel,
cover pushed onto the three spawn lanes), not by area.

A 12-agent council (`football-3v3-arena-council`) produced the evidence. What survived scrutiny:

- **Brawl Stars does not scale arena size with mode.** One 21×33-tile canvas serves every 3v3 mode
  across 400+ maps and 16 modes; 60×60 serves every 10-player mode. Size is a function of player
  *count*, never of mode. Measured from four independent decompiled `maps.csv` dumps that agree.
- **Across player counts it grows superlinearly**: 3v3 → 5v5 Brawl Ball in-bounds area ×2.62
  (area ≈ N^1.9). Real football agrees in direction — the FA's own 3v3 and 5v5 pitches are both
  exactly 100 m² per player.
- **Rocket League is the counter-example** (one arena for 1v1 through 4v4) and it does not transfer:
  its cars cross the arena in 4.5–7.3s; our players need **14.06s** (2000 px ÷ `158 × speedMul 0.9`).
- **The ruling wanted 2000×1300** — freeze W, grow H 18.2% — because visible world width is
  `FIELD.W / CAM_ZOOM` = **1212 px on every device**, so *widening* the pitch cancels the encounter
  density the third player was added to create. Expected on-screen opponents: 2v2 0.617 → 3v3@1100
  **0.926** → 3v3@1300 0.783 → 2450×1350 **0.616** (erases the third player exactly). The user
  declined the H growth; recorded here because the camera-coupling argument is worth keeping.

**Two arithmetic corrections the council itself got wrong** — if you re-run this analysis, start here:

1. Density figures must use the **effective** radii. `defaultSettings()` ships `sizeMul: 1.25` and
   `ballSizeMul: 2`, so bodies are **52.5 px** and the ball is **64 px** — not 42 and 32. Two council
   agents disagreed on this and the wrong one reached the user first. Correct values:
   2v2 = 199.6 D²/player (1.32× Brawl Ball), 3v3@1100 = **133 D²/player (0.88×, i.e. tighter than
   Brawl Stars ships)**, 3v3@1300 = 157 (1.04×).
2. The ruling's "**the 3v3 goal is sealed by three defenders**" is **not established**. Its per-body
   denial (116.5 px = `2 × (26.25 + 32)`) is real, but applying the same method to 2v2 gives 233 px
   against a 218 px usable centre corridor — i.e. it predicts 2v2 is sealed too, and 2v2 scores fine.
   It compared a centre-corridor denial against the full mouth width, mixing frames. Goal width at
   3v3 is a **playtest** question. `GOAL` is untouched.

## Stage 1 — shipped

- **`shared/field-sizes.js`** — named size records, the single source of truth. `s2v2` 2000×1100
  (40×22 cells) reproduces the shipped constants to the pixel; `sBig` 2600×1500 (52×30); `sHuge`
  2900×1700 (58×34). Invariants asserted in `test-field-sizes.mjs`: whole *and even* cell counts on
  both axes (so the centre line is a grid junction and the builder mirror is exact), and every size
  inside the wire's ±3276.7 coordinate range.
- **Save format v2** — the size id lives **inside** the field object. `fbNorm()` is now the single
  place a field object is constructed, because the bug it replaces was three separate
  `{ version: 1, … }` literals (`fbLoad`, `fbRestore`, `#b-clear`) plus `fpNormField` that each
  silently dropped the size. **A field with no `size` is `s2v2` forever and is never rescaled.**
- **`sanitizeField` clamps to the field's own size**, not the global `FIELD`. It used to collapse a
  2600-wide layout's entire right-hand side onto the touchline with no error.
- **Builder** — `📐 גודל` cycler in the actions rail; `FB_W`/`FB_H` follow the active size; the three
  `aspect-ratio: 2000 / 1100` CSS rules now read `var(--fb-aspect)`. **Shrinking is refused** while
  any element sits outside the smaller pitch — authored coordinates are never rewritten silently.
- **`RUNTIME_SIZES = ['s2v2']`** — sizes a *match* can be hosted on, as opposed to sizes the builder
  can *author*. ▶ שחק refuses a non-hostable size, and `startBuilderMatch` refuses it again
  server-side (`test-builder-size.mjs` proves the client gate is not trusted).

## Stage 2 — per-match geometry (not done, and why)

Authoring a bigger pitch is safe because it is only data. **Playing** one is not: the pitch is still
one module constant, read from **123 places** — 33 `shared/sim.js`, 25 `shared/bot-ai.js`, 49
`public/client.js`, 11 `shared/training.js`, 3 `server.js`, 2 `shared/arena.js`. A match on a bigger
size would *look* bigger while the sim used 2000×1100 goal lines, penalty boxes, spawns and wall
bounds — wrong in a way that reads as a physics bug.

**Blocked on:** `bot-ai.js` holds 25 of those sites and is being rewritten right now by the bot
overhaul (`ac25b6f`, "single-writer plan, locks"). Editing it would stomp that agent's work.

When it lands, in this order:

1. **`state.geo`** — put the size record on the state and read it via a `geoOf(state)` helper. Follow
   the `state.arena` / `arenaOf(state)` idiom that `sim.js` and `bot-ai.js` already use; `setField`
   is the natural place to set it, and `sanitizeField` already resolves and echoes the id.
2. **The 11 module-scope derived consts** — the only genuinely dangerous sites, because they are
   computed at import time: `sim.js:37-40` (`GOAL_TOP/BOTTOM`, `PENALTY_TOP/BOTTOM`),
   `bot-ai.js:31-33` (`GY`, `PEN_TOP/BOT`), `client.js:38-39,44-45` (same four). Turn each into a
   function of the geo. Everything else already has `state` in scope.
3. **Client camera** — `scale = CAM_ZOOM * wbW / FIELD.W` (`client.js` ~4842) becomes `/ REF_W`
   (already exported = 2000), so a bigger pitch **pans** instead of zooming out and shrinking every
   sprite. A literal no-op at 2000, which is why it is safe to land early.
4. **Client `FIELD` mirror** — the client hosts one match at a time, so `matchStart.field` (already
   sent) can drive a mutable client-side geo; that covers most of the 49 sites without threading.
5. **Flip `RUNTIME_SIZES`** to include `sBig`. That is the whole switch — both gates read it.
6. **5v5 / `sHuge`** additionally needs a **wire change**: `shared/wire.js:51,100` loop `k < 8`
   against a u8 player mask, so 10 players do not fit. 4v4 (8 players) is exactly the capacity and
   needs nothing. Widening the mask touches encoder *and* decoder together.

## Latent bug found on the way (unrelated to sizes, still open)

`shared/wire.js:69` packs wall AABBs as `u8(w.w); u8(w.h)` while the `u8` writer masks with `& 255`
**without clamping** — the `hl`/`ht` bytes beside it *are* `Math.min(255, …)`-clamped. A vertical dry
wall with `hl 115` has AABB h = 262 → `262 & 255` = 6, and the decoder's `cx = x + w/2` renders it
**256 px away from where it collides**. Reproduce with a tall dry wall in the builder.
