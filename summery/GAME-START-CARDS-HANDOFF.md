# Game-Start Power Cards — Handoff Log

**Owner agent:** (this session) — locked task: 2v2 game-start power card display + countdown animation + bot card selection
**Date started:** 2026-07-23
**Repo:** football-mock (localhost only, commit everything)

## Locked task (verbatim from user)
> when a game 2v2 start it show the players power cards,
> 1. make sure the power cards are correct, the ones which the use picked in the power slots.
> 2. make sure the animation in the countdown lobby is correct with the cards.
> 3. when selecting cards randomly for bots they should be roughly the same rarity as the use cards, but should make more sense, for example there should always be at least a common card, unless the players have empty slots and highest card is also common

## Interpretation / requirements
1. On 2v2 game start, each player's displayed power cards must match what they picked in their power slots (no mismatch/placeholder).
2. Countdown lobby animation must correctly reflect those cards.
3. Bot card randomization: match user rarity distribution roughly, but "make sense" — always include >=1 common card, UNLESS players have empty slots AND highest card is also common.

## Scope boundary
- Separate from card-slots UI agent (see CARD-SLOTS-HANDOFF.md). I do NOT touch slot add/remove UI; I read the picked slots and show them at game start + bot generation.

## Status
- [x] Explore card/slot/countdown/bot code
- [x] Task 1&2: fix countdown showing wrong cards for humans
- [x] Task 3: bot empty-slot fill rule
- [x] Verify (logic scenarios)
- [x] Commit

## What was found + done
### Task 1 & 2 — humans showed WRONG cards during the countdown
- Root cause: lobby/countdown payload (`lobbyPayload`, server.js ~586) sent each human's `cards` (album) but NOT their equipped `loadout`. Client `introCardsFor()` (client.js:1685) prefers `p.loadout`, and with none present fell back to album top-3 — so during the VS/countdown humans showed their best 3 album cards, NOT what they picked in their power slots. Bots DID send loadout, so humans vs bots were rendered inconsistently. Only the final matchStart reveal (server.js ~427) showed humans' real loadout.
- Fix: include `loadout: sanitizeLoadout(m.loadout, m.cards)` in the member list in `lobbyPayload`. Now countdown == reveal == the user's actual power slots.
- Note: `setLoadout` WS handler already keeps `member.loadout` live (server.js:847), and client sends it on every slot change (setSlotCard, client.js:927), so changes made before quick-match are reflected.

### Task 3 — bots with "1 legendary + 2 empty" (user-reported)
- Rule implemented (per user clarification): a bot holding any real card must not be left with empty slots — fill every empty slot with a COMMON. Exception: if humans are minimal (some human has empty slots AND their highest equipped card is only common, or nobody has cards) → mirror the sparseness instead of over-filling.
- Files: `botLoadoutParamsFromHumans` now also returns `hasEmptySlots` + `highestRarity`; `randomBotLoadout` fills remaining empties with commons unless `humansMinimal`.
- Verified via scratchpad/bottest.mjs: strong+empty = 0/300 across all non-exception scenarios; exception cases still allow empties.

## Files touched
- server.js: `lobbyPayload` (+loadout), `botLoadoutParamsFromHumans` (+hasEmptySlots/highestRarity), `randomBotLoadout` (common-fill rule).

## NOT done / possible follow-ups
- Rarity "mirroring" is still probabilistic (E[total buff] == human avg). A single-legendary human often yields a bot whose visible cards are rare/common (legendary rarely re-rolled) — this is the pre-existing unbiased-buff design, NOT changed. Flag if the user wants bots to visually mirror the human's TOP rarity more strongly.
- Not yet run in a live browser 2v2 (logic-verified only; server boots clean).

## Request log
- 2026-07-23: initial 3-point task (above).
- 2026-07-23: clarified task 3 — "sometimes I see a bot with one legendary and two empty; if he has a legendary he must have at least 2 other commons to fill empty." → implemented empty-slot common-fill.
