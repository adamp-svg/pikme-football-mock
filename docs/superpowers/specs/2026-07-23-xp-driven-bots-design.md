# XP-Driven Bots + Level-Based Cards + Lobby Level Badge

Date: 2026-07-23
Status: approved

## Goal

Bots the player faces should reflect the player's XP, and each bot's cards should
reflect that bot's strength. Show the bot's level + XP in the countdown lobby.

1. Bot level comes from player XP (starts at level 0), replacing the manual picker.
2. Bot cards reflect the bot's own level, not the humans' cards.
   Level 1 rarely pulls a legendary; level 10 (and 11) always show 3 legendaries.
3. Countdown lobby shows each bot's level + XP.

All numeric mappings are tunable constants — endpoints are fixed, the curve is adjustable.

## Current state (verified)

- Bot AI skill = manual `diffLevel` (0–11), stored in `localStorage`, sent to server
  in `botGame` / `settings` messages. Maps to `shared/difficulty.js` `DIFFICULTY_LEVELS`.
- Bot cards currently **mirror the humans' average** card power via
  `botLoadoutParamsFromHumans` / `humanBuffTarget` → `randomBotLoadout`.
  Only `sideScalar >= 0.95` (levels 10–11) forces 3 legendaries (`extremeBotLoadout`).
- Card generation funnels through a single generator `randomBotLoadout`; gameplay buffs
  derive from the loadout via `buffsFromLoadout`, so **display == gameplay** already holds.
- Player XP: `window.SALTIZ_XP = { xp }`; player level = `floor((1+sqrt(1+xp/12.5))/2)`.
- Countdown bot preview built at `server.js` ~line 694 from `room.botPlan`.

## Design

### 1. Bot level from player XP (client)

- Add `botLevelFromXP(xp)` (tunable) to `shared/difficulty.js`:
  `botLevel = clamp(playerLevel(xp) - 1, 0, 11)` → xp=0 ⇒ level 0; caps at 11.
- `public/client.js`: derive `diffLevel` from `window.SALTIZ_XP` instead of the slider.
  Continue sending it as `diffLevel` — **server AI-skill mapping unchanged**.
- Hide the manual difficulty slider for vs-bots + quick-match.
  **Training ground keeps its manual slider** (practice tool).

### 2. Cards reflect bot level (server)

- Add `RARITY_BY_LEVEL[0..11]` constant (smooth ramp), replacing the human-mirroring
  source for bot cards:
  - L0–1: mostly common, ~2% legendary, slots may be empty
  - L2–4: rare/epic mix, occasional legendary
  - L5–7: epic-heavy, ~1 legendary
  - L8–9: 1–2 guaranteed legendary
  - L10–11: 3 guaranteed legendaries (reuse `extremeBotLoadout`)
- `randomBotLoadout` is driven by `room.diffLevel` (the bot level), not human params.
  `botLoadoutParamsFromHumans` / `humanBuffTarget` no longer drive bot cards.
- Gameplay buffs unchanged: `buffsFromLoadout` reads the new loadout, so
  cards == strength automatically. `computeBotPlan` (preview) and `fillBots` (match)
  both keep consuming the same plan → preview == match.

### 3. Lobby shows bot level + XP

- Add `xpForBotLevel(L)` to `shared/difficulty.js` (inverse of the level formula):
  representative XP at the start of that level.
- Server bot-preview payload (`server.js` ~694) gains `level` + `xp` per bot,
  derived from `room.diffLevel`.
- `public/client.js` renders a `רמה N · X XP` badge per bot in the countdown,
  matching the player hub XP-bar style.

## Files touched

- `shared/difficulty.js` — `botLevelFromXP`, `xpForBotLevel`, `RARITY_BY_LEVEL`
  (or keep the rarity table in server.js if it depends on server-only card helpers).
- `server.js` — level-based card generator, preview payload gains level+xp.
- `public/client.js` — bot level from XP, hide slider for vs-bots/quick-match,
  render bot level+XP badge.

## Non-goals

- No change to how the player's own XP is earned (`xpFactor` stays).
- No change to AI skill scalars in `DIFFICULTY_LEVELS`.
- Training-ground manual difficulty is retained.

## Coordination

Other agents work this repo concurrently. Acquire a lock on each file
(`server.js`, `public/client.js`, `shared/difficulty.js`) before editing.
