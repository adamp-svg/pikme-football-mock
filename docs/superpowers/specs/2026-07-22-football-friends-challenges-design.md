# Football Friends & Challenges — Design

**Date:** 2026-07-22
**Status:** Approved design; first implementation = Slice 1 (below).
**Repos touched:** `football-mock` (game client + server), `pikme-server` (social graph + identity token), `pikmeTV-app` (identity injection; richer UI in later slices).

## Problem

The football game's only ways to play with a specific person are a public Quick Match
and a **typed 4-char private room code** (`createRoom`/`joinRoom` in
[football-mock/server.js](../../../server.js)). Connections are anonymous (`m-1`,
`m-2`…) with only a typed display name — there is no persistent identity and no
concept of friends. We want players to **add friends** (by nickname, phone, contacts,
or invite link) and **challenge a friend to a match**, reaching them anywhere in the app
via push. Typed codes are replaced by shareable invite links.

## Existing facts this design builds on

- **Pikme identity is in Mongo** (`UserInfo`): `_id` (userId), `phone`, `nickName`
  (2–12 chars), `image`, `blockList` (a `{ blockedId: true }` map). OTP→token auth;
  `req.userId` comes from an auth middleware (cookie `auth`). See
  `pikme-server/routes-pikme/user.js`.
- **Phone→identity is deliberately private.** The bulk phone→nickName endpoint is
  gated by an internal key with the comment *"NEVER expose publicly — it would be a
  phone→identity oracle."* Any phone-based add-flow must respect this.
- **Nickname search already exists** for creators (`CreatorInfo.find({ nickName: regex })`).
  We add the equivalent for `UserInfo`.
- **Push already exists** (`pikme-server/notifications/notifications.js`): FCM (Android)
  + APNs (`apn.p8`), with a **`route` param used as a deep-link** (e.g.
  `chat-reply/${messageId}`). A challenge push reuses this with a football route.
- **The app already injects data into the football WebView** (`window.SALTIZ_XP`, cards).
  Identity injection follows the same pattern. The football game is **not embedded in
  the app yet** — it runs standalone today — so this design also unblocks the embed.

## Approach (chosen)

Split the system by the nature of the data:

- **Persistent social graph → `pikme-server` / Mongo**, alongside identity, `blockList`,
  and push (which already live there).
- **Realtime layer (presence + challenge handshake) → the football server**, where the
  live WebSocket connections already are.

Rejected alternatives: (A) everything in the football server with its own DB/auth —
duplicates identity Pikme already owns, and football-mock is an in-memory prototype;
(B) everything in pikme-server with polling for presence/challenges — laggy and wasteful
when football already holds live sockets.

## Full vision (all slices)

### 1. Identity foundation
- `pikme-server` mints a **short-lived HMAC-signed football token** = `{ userId,
  nickName, image, exp }`, signed with a shared secret (`FOOTBALL_TOKEN_SECRET`). The
  app fetches it (it holds the auth cookie) and injects it into the football `join`
  message — same pattern as `window.SALTIZ_XP`.
- The football server **verifies the HMAC locally** (no per-connection round-trip) and
  stamps `member.userId`, `member.name = nickName`, `member.avatar = image`.
  Standalone/dev with no token falls back to a typed handle and `userId = null`.

### 2. Social graph (pikme-server / Mongo, REST)
- `FriendRequest` collection: `{ fromUserId, toUserId?, toPhone?, status:
  pending|accepted|declined, channel: nickname|phone|contacts|link, createdAt }`,
  unique index on `(fromUserId, toUserId)`.
- Accepted request writes a symmetric `friends` map on each `UserInfo` (mirrors the
  `blockList` style). Blocking reuses `blockList`.
- **Add channels:**
  - **Nickname search** (primary) — `UserInfo` nickName regex search → send request.
  - **Exact phone (typed)** — **fire-and-forget**: store a pending request keyed by
    phone; never reveal whether that number is a user. When that phone is/becomes a
    user, they see the request. Avoids the phone→identity oracle entirely.
  - **Contacts match** — authed, **rate-limited** endpoint; app sends numbers you
    already own (hashed); server returns matches only among *your* numbers
    (nickName + userId). You only ever learn about numbers you already hold.
  - **Invite link** — a personal signed deep-link; whoever opens it in the app sends
    you a request. No lookup at all.

### 3. Realtime presence + challenge (football server)
- On connect, football registers `onlineByUser[userId]`. Given a member's friend list,
  it computes **friends-online** and pushes presence updates (the "green dot").
- **Challenge an online friend** → `challenge` WS msg → target gets accept/decline
  prompt → on accept, football **auto-creates a private room and joins both** (reusing
  the existing private-room machinery — a challenge is automated `createRoom` +
  `joinRoom`).
- **Challenge a friend elsewhere in the app** → push via existing `sendPush`, route
  `football-challenge/<code>`; the app deep-links into the football WebView with
  `?invite=<code>` and auto-joins. Codes expire (short TTL).

### 4. Invite links replace typed codes
The 4-char code mechanism stays under the hood but is surfaced as a **deep-link**
(`pikme://football/invite/<code>`) instead of a typed field. A friend-add link
additionally sends a friend request to the inviter.

---

## Scope — Slice 1 (this implementation)

**Goal:** the smallest end-to-end version that is real — identity + nickname-add friends
+ in-game challenge of currently-online friends. No push, deep-links, phone, or contacts
(those are Slices 2–3). To stay self-contained, the **friends UI lives inside the
football hub** (`public/client.js`), calling pikme-server REST directly with the injected
token; the app's only job in Slice 1 is injecting identity.

### In scope

**A. Identity (pikme-server + football-mock)**
- pikme-server: `GET /handle-user/football-token` (authed) → HMAC-signed
  `{ userId, nickName, image, exp }`, secret `FOOTBALL_TOKEN_SECRET`.
- football-mock `server.js`: `join` accepts optional `authToken`; verify HMAC with the
  same secret; set `member.userId/name/avatar`. No/invalid token → guest fallback
  (`userId = null`, typed name) so standalone dev still works.

**B. Social graph — nickname only (pikme-server)**
- `FriendRequest` Mongoose model + `UserInfo.friends` map.
- Endpoints (all authed via `req.userId`, rate-limited where noted):
  - `GET  /friends/search?q=` — nickName regex on `UserInfo`; exclude self, blocked,
    and existing friends; return `[{ userId, nickName, image }]`, limited.
  - `POST /friends/request { toUserId }` — create pending request (guards: not self, not
    blocked either direction, not already friends, no duplicate).
  - `GET  /friends/requests` — incoming pending requests.
  - `POST /friends/respond { requestId, action }` — accept writes symmetric `friends`;
    decline marks declined.
  - `GET  /friends` — friends list `[{ userId, nickName, image }]`.
  - `DELETE /friends/:userId` — remove friendship both sides.
- **CORS:** allow the football origin to call these endpoints (football client is a
  cross-origin WebView).

**C. Presence + in-game challenge (football-mock server + client)**
- Server tracks `onlineByUser: Map<userId, member>` on join/close.
- Client sends its friend userIds (`setFriends` msg, fetched from pikme-server); server
  replies with `friendsPresence` (which friends are online now) and pushes updates as
  friends connect/disconnect.
- `challenge { toUserId }` → validate friend + online → `challengeReceived { challengeId,
  fromUserId, fromName }` to target.
- `challengeRespond { challengeId, accept }` → accept: create a private room, join both,
  start the normal lobby→countdown→match; decline: notify challenger. Reuses the
  existing private-room lifecycle.

**D. Client UI (football hub)**
- A "Friends" panel: search by nickname, send/accept/decline requests, friends list with
  online dots, and a **Challenge** button on online friends + an incoming-challenge
  prompt.

### Out of scope (later slices)
- Push-reach to friends not in the game; invite-link deep-links (Slice 2).
- Phone-typed and contacts add-channels (Slice 3).
- Native in-app Friends screen (Slice 1 renders friends inside the football hub).
- Replacing/removing the existing typed room-code UI (kept as-is until Slice 2 links).

## Data flow (Slice 1 challenge, happy path)
1. App fetches football token from pikme-server, opens football WebView, injects token.
2. Football client `join` → server verifies token → `member.userId` set.
3. Client fetches `/friends` from pikme-server → sends `setFriends` → server returns
   `friendsPresence`.
4. User taps Challenge on an online friend → `challenge {toUserId}`.
5. Server sends `challengeReceived` to target → target accepts.
6. Server creates a private room, joins both, broadcasts lobby, runs countdown → match.

## Testing (Slice 1)
- **pikme-server:** unit/integration for friends endpoints (request/accept/decline/list/
  remove, guards: self, blocked, dup, non-friend); football-token sign+verify roundtrip.
- **football-mock:** extend the existing `test-wire.mjs`-style WS tests — token verify +
  guest fallback; presence updates on connect/disconnect; challenge accept creates a
  shared room and both members enter match; decline notifies challenger; challenge to a
  non-friend or offline user is rejected.

## Risks / notes
- **Shared secret** must be set in both pikme-server and football-mock envs; football
  rejects tokens if unset (fails closed) but still allows guest connections.
- **CORS** on pikme-server for the football origin.
- **Presence source of truth** is the football server; the in-app Friends screen (later)
  reads it via a bridge/endpoint. Slice 1 sidesteps this by rendering friends in-game.
- Nickname is not unique in `UserInfo`; search returns multiple — the UI must disambiguate
  by `image`/userId (acceptable for Slice 1).
