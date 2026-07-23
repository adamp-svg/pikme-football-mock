# Friends & Hub Upgrades — Design

Date: 2026-07-23
Repos: `football-mock` (WebSocket game client/server), `pikme-server` (external REST API, deployed on Render)

## Goal

Five improvements to the football game's hub and friends experience:

1. Fix the missing power-slot text under the cards in the main menu on phone/TestFlight.
2. Show a green "bulb" on the friends button when any friend is currently connected.
3. Add a "Connected" tab to the friends page (online friends only).
4. In the friends list, show each friend's real stats + power cards (top cards in slots like "select best"); when a friend has no data, show zeros / empty slots.
5. Clicking a friend opens a compact profile modal with their hero avatar, top power cards, and rank/experience.

## Key constraints discovered

- `football-mock/server.js` is **WebSocket-only** — it tracks friend **presence** (online userIds) but holds no friend cards/stats. Friend data comes from the external `pikme-server` REST API (`PIKME_API`, prod `https://pikme-server.onrender.com`).
- `GET /handle-friends` today returns only `{ userId, nickName, image }` per friend (`pikme-server/routes-pikme/friends.js:134-139`). No stats, no cards.
- `FootballStats` (keyed by phone) holds the cheap stats: `xp, level, tier, wins, losses, draws` (`pikme-server/data/footballstats.js`). Resolvable per friend via userId→phone.
- `PlayerCardStats` (keyed by phone) holds only **aggregates**: `totalPoints`, `totalCards` (`pikme-server/data/playercardstats.js`). It does **not** store the individual card list.
- The individual cards (rarity `r`, number `n`, copies `c`, worth `w`) live in the **cards system** at `https://cards.aleph-infinity.com/api/claims` (phone-based, edge-cached; may return null `current_views`/`card_worth`). pikme-server does not currently call it.
- Presence already works: `server.js` maintains `onlineByUser`, pushes `friendsPresence { online: [userId] }`; the client stores it in `ONLINE` (`client.js:1825, 2340-2343`).

Implication: friend **stats** are a cheap local DB join; friend **card art** requires a per-friend fetch to the cards system (so it is cached and fetched on demand, not for the whole list synchronously).

## Feature 1 — Power-slot text on phone (football-mock, CSS only)

Root cause: `public/style.css:1198`

```css
@media (max-height: 400px) { .pslot-cap { display: none; } ... }
```

Intended for very short iPhone-SE landscape, but the game runs landscape and virtually every iPhone WebView is < 400px tall, so it also hides the hub's power-slot captions.

Fix: keep the caption visible for the hub's absolutely-positioned slot overlay while leaving the in-match loadout column suppression intact.

```css
@media (max-height: 400px) { #power-slots .pslot-cap { display: block; } }
```

Placed after the existing rule so it wins by specificity + order. **Must be verified on a real device / TestFlight** (the iOS Simulator viewport height differs from a physical phone).

## Backend enrichment (pikme-server, `routes-pikme/friends.js`)

### Enrich `GET /handle-friends` (cheap, local DB only)

For the caller's friends, batch-resolve their phones (from `UserInfo`), then batch-query `FootballStats` and `PlayerCardStats` by those phones. Return, per friend:

```
{ userId, nickName, image, xp, level, tier, wins, worth, owned }
```

- `worth` ← `PlayerCardStats.totalPoints` (0 if absent)
- `owned` ← `PlayerCardStats.totalCards` (0 if absent)
- `xp/level/tier/wins` ← `FootballStats` (0 / default if absent)
- No external calls; list stays fast. Missing docs → zeros.

### New `GET /handle-friends/:userId/cards` (on demand, cached)

- **Authorize:** confirm `:userId` is actually in the caller's `friends` map (403 otherwise) — no arbitrary user scraping.
- Resolve `:userId` → phone (`UserInfo`).
- Fetch `https://cards.aleph-infinity.com/api/claims?phone=<phone>` (confirm exact param/token during implementation; claims flow is phone-based, no JWT).
- Parse owned cards into compact `[{ r, n, c, w }]`, rank by **rarity → copies → worth** (mirrors client `rankForLoadout`), return the top N (N = 6 is enough for a 3-slot display with headroom).
- **Server-side cache keyed by phone, TTL ~5 min** (claims is edge-cached anyway) to bound external cost.
- On upstream failure, return `{ cards: [] }` (empty slots), never a 500 that breaks the UI.

## Feature 2 — Green bulb on friends button (football-mock)

- Load friends + presence **on boot** (once the WS is connected and identity is ready) so `ONLINE` is populated without opening the panel. Reuse existing `loadFriends()` (which sends `setFriends` → server replies `friendsPresence`).
- Add a `.hub-sat-dot` element inside `#friends-btn` (`index.html`), hidden by default.
- Toggle it visible whenever `ONLINE.size > 0`; update on every `friendsPresence` message and after `loadFriends()`.
- Styling: small green dot, positioned top-right of the button.

## Feature 3 — "Connected" tab (football-mock)

- Add a 4th tab button `data-tab="online"` (label `מחוברים`) to `.fr-tabs` and a pane `#friend-online` (`index.html`).
- `setFriendsTab('online')` renders only friends whose `userId ∈ ONLINE`, reusing `friendCardEl`.
- Empty-state text when no friends are online.

## Feature 4 — Friend stats + power cards in the list (football-mock, `friendCardEl`)

Each friend card renders:

- A **stats row** built from the enriched list data: level/tier badge, XP, worth, owned — showing `0` / empty when absent.
- **3 power slots**, always present. Empty = dashed placeholder (reuse `.pslot-empty` styling). When the friend's cards are available, fill the slots with the **top-3** (client runs `rankForLoadout` over the `/cards` response — identical to "select best").
- Card art is **lazy-loaded** per friend via `GET /handle-friends/:userId/cards` (server + client cached), so the list render itself makes no synchronous external calls; slots fill in as responses arrive.

## Feature 5 — Compact friend profile modal (football-mock)

- New `#friend-profile-modal` — a compact popup (not a full screen), reachable by clicking a friend card.
- Contents: friend hero avatar (`image`) + name + online dot; top-3 power cards in slots; rank tier + level + XP bar; worth / owned.
- Reuses the enriched stats already loaded for the list, plus the same `/cards` fetch (shared cache with #4).
- Read-only (no editing the friend's loadout). Closes on backdrop tap or an ✕ button.

## Rollout & verification

- **pikme-server**: implement both endpoint changes, then **deploy to Render** (`pikme-server.onrender.com`). This is live/shared — confirm before deploying. Verify with a real football token against the deployed API.
- **football-mock**: implement on a feature branch, review, merge to `main` (Render auto-deploys), as in the prior cycle.
- **Feature 1** specifically must be checked on a physical device / TestFlight because the Simulator's viewport height does not match a real iPhone.
- Presence-driven features (#2, #3) verified live with a second connected account.

## Out of scope

- Global leaderboard rank number per friend (the `$rank` aggregation ranks all players — too heavy per friend; friends show level/tier/XP instead).
- Editing a friend's loadout from their profile.
- Any change to how the local player's own cards are injected (`SALTIZ_CARDS`).
