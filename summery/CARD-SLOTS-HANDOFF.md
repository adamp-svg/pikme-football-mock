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

## Iteration 2 — fanned "cards on a table" album (commit after 8903144)
Request: "in my cards for the slots, cards spread on the table over each other, touching reveals more; each tier can be ~50 cards." Decision (asked): reveal-then-drag-to-slot.
- Room deck is no longer a grid. Each tier = a horizontally-scrollable OVERLAPPING FAN
  (`.cards-fan` > `.fan-track` > absolute `.fan-card` at `left=idx*FAN_PEEK`, z=idx). FAN_PEEK=26, card=66w — ~50/tier scroll sideways.
- `bindFanDrag()` IIFE (client.js, before bindSlotDrag), delegated on `#cards-deck`:
  - TAP a card -> reveal (lift+enlarge, one at a time).
  - DRAG UP (or drag a revealed card any dir) -> ghost -> drop on a `#cards-slots` `.pslot` = equip.
  - DRAG SIDEWAYS -> browse fan (native pan-x on touch; manual scrollLeft for mouse).
- CSS: `.cards-fan/.fan-track/.fan-card(.revealed/.equipped)/.fan-card-tag` in style.css.
- Hint text updated in index.html.
- KNOWN TRADEOFF: `touch-action:pan-x` on fans means a downward finger-drag started on a fan card won't scroll the page vertically; scroll via header/gaps. Revisit if it annoys.
- Files: public/client.js, public/style.css, public/index.html (only my `cards-hint` line). Left other agents' server.js + GAME-START-CARDS-HANDOFF.md untouched.

## Iteration 3 — fix "legendary shown under Epic header"
Report: after a swap, a legendary card appeared to belong to the Epic tier. Root cause: NOT the
grouping logic (`c.r===rar` is correct) — it was LAYOUT. The fan's 26px top padding (lift-room)
pushed each tier's cards down, away from their own header and next to the tier header below.
Fix (client.js + style.css only):
- Each tier now wrapped in its own `.cards-tier` box with a rarity-colored left border +
  subtle bg — cards are visually enclosed with their header, can't read as the neighbour's.
- Header gap tightened (fan padding-top 26->12); reveal changed from translateY(-24) lift to
  `transform-origin:bottom center; scale(1.12)` so it grows up from its base within the small gap.
- Also fixed a self-introduced bug: `sec` box was built but never appended (header would vanish);
  now `sec.appendChild(fan); deckEl.appendChild(sec)`.
NOTE: swap confirmed CORRECT / kept as-is (user chose "keep swap").
COMMIT HYGIENE: client.js & style.css also hold ANOTHER agent's uncommitted friends-tabs + rank
work. Committed ONLY my hunks via `git apply --cached` (their work left intact in the tree).

## Iteration 4 — power-slot room: info popup, "equip best", hide equipped from album
Requests: (1) tapping a slot (or its card) shows the power info + explanation; (2) add an
"equip best" button in the room; (3) a card equipped from a tier is removed from the album.
- (1) room slot tap now calls the existing `showSlotInfo(i)` popup (was: select slot). Popup's
  remove button now also `renderCardsPage()` so the freed card returns to the album.
- (2) `#cards-best-btn` (index.html, in #cards subpage) -> handler after bindFanDrag: same as
  home #select-best-btn (rankForLoadout top-3) + refreshes room & lobby. CSS `.cards-best` (gold).
- (3) album groups now `filter(... && !isEquipped(c))` — equipped cards leave the album; the
  fan-card `.equipped` outline is now dead (removed). Drag-equip already re-renders (removes it);
  remove-from-slot re-adds it.
- NOTE: other agent committed their friends+rank work (3cca650), so my files no longer collide;
  staged normally this round (verified diff is 100% mine before commit).

## Request log
- 2026-07-23: initial 3-point task (above).
- 2026-07-23: iteration 2 — fanned overlapping album, tap-reveal + drag-to-slot equip.
- 2026-07-23: iteration 3 — fix legendary-under-Epic (enclosed tier boxes; layout, not grouping).
- 2026-07-23: iteration 4 — room slot-info popup + "equip best" button + hide equipped from album.
