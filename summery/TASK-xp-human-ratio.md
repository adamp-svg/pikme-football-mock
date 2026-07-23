# TASK: XP scales with how HUMAN the match is (agent: arena/difficulty)

## Request
- All-human match gains XP much faster than a bot-filled one.
- A match where I'm the only human (rest bots) is worth 20% of a full-human match.

## Done (game side) — client.js postMatchResult
- Added to the `matchResult` postMessage payload:
  - `humanCount` (humans incl. me), `totalPlayers` (filled slots), `xpFactor`.
  - `xpFactor = 0.2 + 0.8 * (otherHumans / otherSlots)`, clamped 0.2..1.0.
  - all-bot (1 human/4) => 0.20 ; 2/4 => 0.47 ; 3/4 => 0.73 ; all-human => 1.00 ; 1v1 solo => 0.20.

## ACTION REQUIRED — backend / experience agent (OUTSIDE this repo)
The game only REPORTS the multiplier. The app/backend that awards XP from `matchResult`
MUST multiply its base match XP by `xpFactor`. Without that, XP won't change.
Contract: `window.ReactNativeWebView.postMessage({ t:'matchResult', ..., xpFactor })`.
(See the existing SALTIZ_XP contract note in client.js ~L746.)

## Not in scope
Bot DIFFICULTY level does NOT affect xpFactor (per the clarified spec it's about human
presence, not bot strength). Easy to add later if desired (e.g. multiply by a diff bonus).
