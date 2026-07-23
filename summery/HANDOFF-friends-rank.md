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

## Progress
- [ ] Task 1
- [ ] Task 2
- [ ] verified on localhost + committed
