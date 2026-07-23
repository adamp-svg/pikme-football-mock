# Play With Friends — party flow (invite → roster → groups → play)

Date: 2026-07-23 · Author: opus-football · Branch: feat/build-bomb-cancel

## Goal

Replace the current "pick friends → pick game → lobby" party path with a clearer
3-screen flow, built **incrementally** on the server primitives that already exist
(presence, invite/accept handshake, private rooms, team-pick, countdown, matchStart).

## Screens

### 1. Invite (rework existing `#friend-select`)
- Opening "שחק עם חברים" ensures the host has a **private party room** (`createRoom`).
- Three groups, all derived from the friends list ∩ presence:
  - **online friends** — each with an ➕ invite action → `inviteFriend {toUserId}`.
  - **invited / pending** — friends invited this session, awaiting accept.
  - **in party / accepted** — members already in the room (from the `lobby` payload).
- Keep "join a friend's room by code" (`joinRoom`).
- Continue (`#friend-select-go`) → the party roster screen.

### 2. Party roster + games (NEW `#party` screen)
Styled like the clubs/news sub-pages (full-bleed stadium, translucent blocky cards,
header top-right, leave by tapping empty background — consistent with req 1/3/4).
- **YOU centered, big**: hero canvas/art in the middle; a small rank+xp chip **above**;
  the 3 equipped power cards **small below**.
- **Party members** (up to 3 others) rendered **smaller** alongside: hero + name +
  mini rank + mini cards.
- **Game list** below: ⚽ Football 2v2 (**live**) · 🏆 Tournament · 🥅 Goal-brawl (both «בקרוב», locked).
- Host taps ⚽ 2v2 → groups screen. Non-host sees a "waiting for host to pick a game" hint.

### 3. Groups / teams (reuse + restyle existing `#lobby`)
- Party members as **small hero chips** (hero + name) in Team 1 / Team 2 columns.
- Each member picks a team (`setTeam`), auto-balanced (existing).
- **Play Now** (host) → 5s countdown → `matchStart` (all existing).

## Reused as-is (no server change for v1)
Presence (`friendsPresence`/`home.online`), invite/accept (`inviteFriend`, and the
`challenge`/`challengeReceived`/`challengeRespond` handshake), private room
create/join, `setTeam`, `play-now`, countdown, `matchStart`, the `lobby` member payload.

## New / changed
- `index.html`: new `#party` screen; game list moved out of `#game-select` into `#party`.
- `style.css`: `#party` roster layout (hero-center + satellites + game list) matching the
  sub-page card graphics; small-hero restyle of the lobby team members.
- `client.js`: `openFriendSelect` gains the online/pending/accepted sections; a
  `renderParty()` that draws the roster from the room's `lobby` members; game-pick in
  `#party` (2v2 → groups); host/non-host gating.

## Data sourcing (rank + xp per member)
The `lobby` member payload has id/name/avatar/cosmetic/cards/team/ready but **not**
rank/xp. For v1, no server change:
- **Party members** are the host's friends → reuse rank/xp already loaded by
  `loadFriends()` (friend-card meta), matched by userId.
- **Self** → the injected `window.SALTIZ_XP` / hub rank if present.
- If rank/xp is unknown for a member, **hide the chip** (graceful).
(A later slice can add rank/xp to the member payload server-side.)

## Build order (incremental slices, each verified + committed)
- **A. `#party` roster screen** — the core new UI + wiring invite→roster→(game pick)→groups. Ships first.
- **B. Invite rework** — online/pending/accepted sections on `#friend-select`.
- **C. Groups restyle** — small heroes in the lobby team columns.

## Verification
Headless-Chrome CDP screenshots of each screen (drive the real buttons; bot friends
populate the party in dev). No app rebuild — game-side only, reaches TestFlight via Render.

## Coordination
`#lobby`/`client.js`/`index.html`/`style.css` are co-edited by other agents. Take advisory
locks per file before editing; keep lobby changes to restyle + small additive hooks.

## Out of scope (v1)
Tournament/goal-brawl gameplay; adding rank/xp to the server member payload; 3v3;
cross-device invite push while the app is backgrounded.
