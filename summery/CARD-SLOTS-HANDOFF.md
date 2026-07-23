# Card Slots Feature — Handoff Log

**Owner agent:** (this session) — locked task: football card slots UI
**Date started:** 2026-07-23
**Repo:** football-mock (localhost only, commit everything)

## Locked task (verbatim from user)
> you work on the cards slots,
> 1. i want to be able to add and remove cards from the slots in the main lobby.
> 2. when clicking on the slots, a new room should open with the select slots in a better way
> 3. in the power slots room research best way to select cards for slots. maybe like an album starting with the higher tier and the user can swipe back.

## Interpretation / requirements
1. Lobby slots: add + remove cards directly.
2. Clicking a slot opens a dedicated "power slots room" (new screen/modal) with a better selection UX.
3. In that room: research best card-selection pattern — likely an album/carousel sorted highest-tier-first, swipe to browse.

## Status
- [x] Explore current slot/card system
- [x] Brainstorm design + get approval (see decisions below)
- [x] Implement (client-only)
- [x] Boot-verify on :3012 + confirm edits served
- [ ] User manual test on :3012 (gestures — pending)

## Approved decisions
- Room scope: ALL 3 slots in one room (redesigned existing `#cards` screen).
- Album style: TIER-GROUPED grid, highest tier first (not swipe carousel).
- Lobby remove: drag a slot's card OUTSIDE any slot = remove; drag slot->slot = SWAP.

## What was implemented (all in public/, client-only, no server changes)
- `swapSlots(a,b)` — client.js (after `setSlotCard`): pure exchange of two slots' cards; no dedupe needed (moving existing entries can't duplicate).
- `bindSlotDrag()` IIFE — client.js (before `showSlotInfo`): delegated pointer handler on `#power-slots`.
  - TAP a slot -> opens room targeting that slot (`cardsSelSlot=i; showScreen('cards')`).
  - DRAG filled slot -> another slot = swap; DRAG filled slot -> outside = remove (`setSlotCard(src,null)`).
  - 10px move threshold disambiguates tap vs drag; empty slots only tap.
  - Removed the old per-slot `click` handler in `renderPowerSlots` (tap now via this).
- `renderCardsPage` deck -> tier-grouped album: `['legendary','epic','rare','common']`, worth-desc within tier, full-width `.cards-tier-head` rows. Tap-to-equip + equipped highlight + copies badge unchanged.
- CSS (style.css): `.cards-tier-head` + rarity variants; `.pslot-ghost-remove` (red ghost + ✕ = "release to remove").

## How to run / test
- `PORT=3012 node server.js` (a node instance is already listening on 3012 — it serves the edited files from disk).
- Test: lobby -> drag a slot card onto another (swap), drag one out (remove), tap a slot (opens tier-grouped room), pick a tier target slot + tap a card to equip.

## Notes for a picking-up agent
- Follow superpowers brainstorming: design approval BEFORE code.
- Frontend: public/client.js, public/index.html, public/style.css. Backend: server.js, shared/sim.js.

## Request log
- 2026-07-23: initial 3-point task (above).
