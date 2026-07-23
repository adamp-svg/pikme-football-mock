# HANDOFF — work needed OUTSIDE this repo (football-mock)

Things the game now depends on that must be built in the app / backend (pikmeTV-app /
pikme-server / experience backend). The game side is done + pushed; these are the open items.

## [ ] 1. Consume `xpFactor` when awarding match XP  (experience / backend agent)
- Source: `client.js` postMatchResult → `window.ReactNativeWebView.postMessage`.
- Payload now includes: `xpFactor` (0.20..1.00), `humanCount`, `totalPlayers`.
- REQUIRED: the code that grants XP from `matchResult` must multiply its base match XP by
  `xpFactor`. Without this the human-vs-bot XP scaling has NO effect.
- Semantics: 0.20 = I'm the only human (bot-filled lobby); 1.00 = every slot human; linear.
- Ref: `summery/TASK-xp-human-ratio.md`.

## [ ] 2. (Optional, future) Match difficulty level to game progression
- `shared/difficulty.js` exposes an ordered `DIFFICULTY_LEVELS` ladder (index = `diffLevel`).
- Hook idea: derive a player's default `diffLevel` from their level/rank, then have the client
  send it (client already persists + sends `{ diffLevel }`).
- No game-side change needed to start; this is a progression-design decision.

## Notes
- The bot difficulty engine itself (fluent per-side skill + ladder) is fully in this repo — no
  external work required for it.
