# Handoff — Friends button + Rank button (football-mock)

Agent: opus-4.8 · locked task · started 2026-07-23
Branch: feat/build-bomb-cancel · localhost only · commit everything

## User requests (verbatim log)
1. Work on the friends button. Make the friend button **search and add friends from the main app**.
2. Add a small button **under "new"** with rank — when the player clicks it, it shows his rank.

## Findings (pre-work state)
- Friends UI already exists: `public/index.html` #friends screen (search input `#friend-search`,
  results `#friend-search-results`, requests `#friend-requests`, list `#friend-list`).
- Client logic: `public/client.js` `loadFriends()`, `searchFriends()`, `friendRow()` (~L1523-1626).
- Backend already searches MAIN-APP users: `pikme-server/routes-pikme/friends.js`
  `GET /handle-friends/search?q=` → queries `UserInfo.nickName`. Add via `/handle-friends/request`.
- Auth: needs `window.PIKME_FOOTBALL_TOKEN` (or `?ftoken=`). Without it, MY_USER_ID null →
  search shows "log in through the app". PIKME_API → localhost:3001 in dev.
- Rank: `#hub-rank` hidden div exists at index.html:50. Leaderboard backend exists
  (see memory pikme-leaderboard-backend: /api/leaderboard + ranking migration).
- "new" button = `<button data-open-screen="news">📰 חדשות</button>` at index.html:53.

## Clarifications from user (2026-07-23)
- Task 1: **REBUILD/REDESIGN** the friends flow (existing version stays as reference; rework UX).
- Task 2 rank = **leaderboard POSITION** (numeric, `/handle-user/football/leaderboard` → `me.rank`).
- Placement: rank button goes **under the news (חדשות 📰) satellite button** in the hub rail.
- OPEN: leaderboard endpoint keys on `phone`; must confirm how football-mock knows the player's phone.

## Plan
- Task 1: verify search/add works on localhost; fix whatever is actually broken (likely
  dev-auth / visibility). Do NOT rebuild — feature exists.
- Task 2: add small rank button near the news button; on click fetch player's rank and show it.

## Progress — DONE (2026-07-23)
- [x] Task 1: friends screen rebuilt (tabs: my-friends/requests/add, req badge, decline).
      Element ids preserved → existing loadFriends/searchFriends/render* untouched.
      Files: public/index.html, public/client.js, public/style.css.
- [x] Task 2: `#rank-btn` added under news (CSS left:95 top:240); tap → GET /handle-friends/rank
      → toast "🏅 הדירוג שלך: #N מתוך M". Server route added in
      pikme-server/routes-pikme/friends.js (userId→phone→$rank by xp desc).
- [x] Committed: football-mock 3cca650 (branch feat/build-bomb-cancel) · pikme-server 7e16257.

## Verification status
- football-mock served on :3010 → 200; rank-btn + fr-tabs present in served HTML.
- `node --check` passed: public/client.js, routes-pikme/friends.js.
- NOT fully run against DB: local node is v26; pikme-server's old jsonwebtoken deps crash on
  boot under node 26 (SlowBuffer removed). Pre-existing env issue, not this code. The /rank
  aggregation is a copy of the already-live /handle-user/football/leaderboard query.
- TODO for next agent: boot pikme-server on node 18/20 + a valid football token and hit
  GET /handle-friends/rank to confirm the phone match returns the expected rank.
