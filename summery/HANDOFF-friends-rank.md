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

## Request 3 (2026-07-23): "play with friends" party flow
Verbatim: play-with-friends should show friends ONLINE, allow them to be GROUPED, then SELECT a game.
Decisions: invite online friends into a party lobby (reuse room system, keep code create/join
fallback on the 👥 friends screen); after grouping show a game picker (2v2 active, rest coming-soon).

Design (built on existing room/lobby infra):
- "שחק עם חברים" (play-friends-btn) → sendMsg createRoom → host lands in #lobby.
- #lobby gains a host-only "invite online friends" panel (#party-invite): FRIENDS ∩ ONLINE, each "הזמן".
- WS: inviteFriend{toUserId} → target gets partyInvite{code,fromName} → partyRespond{code,accept}
  → server AUTO-admits invited userIds (no host-approval step) → target joins same lobby.
- Host CTA becomes "בחר משחק" (#pick-game-btn) → #game-select overlay (2v2 active) → sends `ready`
  → existing countdown → match. Non-host waits.
- Server: room.invited Set added to makeRoom; handlers inviteFriend/partyRespond in server.js.

## Verification status
- football-mock served on :3010 → 200; rank-btn + fr-tabs present in served HTML.
- `node --check` passed: public/client.js, routes-pikme/friends.js.
- NOT fully run against DB: local node is v26; pikme-server's old jsonwebtoken deps crash on
  boot under node 26 (SlowBuffer removed). Pre-existing env issue, not this code. The /rank
  aggregation is a copy of the already-live /handle-user/football/leaderboard query.
- TODO for next agent: boot pikme-server on node 18/20 + a valid football token and hit
  GET /handle-friends/rank to confirm the phone match returns the expected rank.

## Request 3 status — DONE (2026-07-23)
- [x] Server handlers (server.js): room.invited Set + inviteFriend/partyRespond. NOTE: these
      landed inside another agent's commit 8814e3f (shared working tree) — verified present in HEAD.
- [x] Client (client.js): play-friends → party lobby; renderPartyInvite(); showPartyInvite();
      game-select overlay wiring; updateLobbyUI shows invite panel + pick-game (host), hides play-now.
- [x] HTML (index.html): #party-invite panel, #pick-game-btn, #game-select overlay.
- [x] CSS (style.css): party-invite/pi-* + game-select overlay (reuses .modecard/.subpage-back).
- [x] E2E test test-party.mjs: PASS (invite→auto-join→lobby(2)→matchStart; uninvited rejected).
      Run: `FOOTBALL_TOKEN_SECRET=testsecret PORT=3010 node server.js` then
      `FOOTBALL_TOKEN_SECRET=testsecret node test-party.mjs`.
- Behaviour: 👥 friends button still opens the tabbed friends screen (code create/join fallback);
  «שחק עם חברים» now goes straight to the party lobby.

## Request 4 + 5 (2026-07-23): split friends vs play-with-friends
- (4) 👥 friends screen is now FRIENDS-ONLY (look/add/remove). Removed create-room + join-by-code
  controls from #friends (index.html) and their handlers (client.js). Room errors now toast.
- (5) «שחק עם חברים» opens a start sheet (#party-start): «צור משחק והזמן חברים» (create → lobby:
  invite online friends + pick game) OR join-by-code (moved here from the friends screen). The host's
  room code shows in the lobby («שתפו עם חברים») so outsiders can join via code (host-approval flow).
- test-party.mjs extended: now also verifies the code-join path (pending→host approve→joined). 11/11 PASS.

## Request 6 (2026-07-23): friends search by phone number
- pikme-server/routes-pikme/friends.js /search now matches nickName OR (when q looks like a phone,
  5+ digits) the EXACT phone across stored variants (+972…/972…/0…). Added phoneVariants() helper.
- EXACT-match only (not prefix) by design — a "know-the-number" lookup, not an enumeration oracle
  (repo treats phone→identity as sensitive; see internal nicknames-by-phone). Client placeholder
  now reads "חיפוש לפי כינוי או מספר טלפון…".
- Logic unit-verified (phone detection + variant generation). NOT DB-verified — pikme-server still
  can't boot on node 26 (old jsonwebtoken/SlowBuffer). Next agent: confirm live against Mongo.

## Request 7 (2026-07-23): add 3 bots as friends
- Client (client.js): BOT_FRIENDS = 3 always-online bot entries (רובי/טיטאן/זיפ, isBot). Merged into
  FRIENDS (also shown when not app-authed). friendRow shows a 🤖 tag (no challenge) for bots;
  renderPartyInvite lists them (always) with «הזמן» → sendMsg addBot (bots aren't WS peers).
- Server (server.js): room.lobbyBots[] + `addBot` handler (host-only, capped at MAX_PLAYERS) → bot
  shows as an isBot member in the lobby; kick of an 'lbot-' id removes it; trimLobbyBots on human
  admit; lobbyBots cleared at startMatch (fillBots creates the real match bots). balancedTeam counts bots.
- test-party.mjs: added addBot lobby check. Full suite 12/12 PASS.
