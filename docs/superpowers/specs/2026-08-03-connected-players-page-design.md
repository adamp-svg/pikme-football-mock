# Connected players page — design

**Date:** 2026-08-03
**Asked for:** "if a player presses the connect button it opens a page with all connected player,
the user can then send a frenid invite or invite to play. lets work on the muck local first then push"
**Approved:** everyone connected (not friends-only); nickname + hero + level per row; actions are
**friend request** and **invite to my party**.

## What exists today

- The hub's connected control is a **non-interactive `<span>`** — `public/index.html:46`:
  `<span class="hub-online"><i></i><span id="home-online">0</span> מחוברים</span>`.
  It only ever printed a count, pushed by the 5Hz `home` broadcast (`onlineCount()` = `members.size`).
- The friends screen has a `מחוברים` tab, but it lists **FRIENDS ∩ ONLINE** only, off `friendsPresence`.
- The server keeps `members` (ws → member) and `onlineByUser` (userId → member) but exposes **no roster**.
  `sendPresenceTo()` deliberately narrows to the member's own friends:
  `(member.friends || []).filter((uid) => onlineByUser.has(uid))`.
- **`inviteFriend` requires friendship** (`server.js:1958`): `if (!member.friends.includes(toUserId))`
  → `partyError 'לא חבר'`. So a global roster alone would produce rows whose invite button always fails.
- A member's `trophies` is only set at `enqueue()` — a player sitting on the hub has **no level on
  the server**, so level has to come from the client.

## Design

### 1. Server: a roster on request

New client→server `whoOnline`; server replies `onlineList`:

```
{ type: 'onlineList', players: [ { userId, name, avatar, cosmetic, level, inMatch } ] }
```

Built from `onlineByUser` (so guests with no `userId` are excluded, as are bots — bots are never
members), minus the caller. Field choice is the privacy boundary: nickname, avatar, hero cosmetic,
level and `inMatch` only. **No phone, no club, no school, no scopes** — nicknames and levels are
already public on the leaderboard, the rest is not.

Level reaches the server two ways, because `join` fires before `SALTIZ_XP` may have landed:
- `join` accepts optional `msg.trophies` / `msg.level`.
- New `setStats` message updates them later; the client sends it (de-duped) when the hub paints trophies.

Refresh model: the client asks on open and re-asks every 5s while `#online` is the visible screen.
No new broadcast plumbing, no push on every connect/disconnect. A 5s stale row costs nothing here.

### 2. Server: invites to non-friends

`inviteFriend`'s friend check is dropped — the roster is public, so the invite target list is public
too. Everything else in that handler is unchanged: the target must be online, the inviter's room must
not be mid-match, and it must have room. A **1.5s per-inviter cooldown** replaces the friend check as
the anti-spam guard, since a stranger's invite pops a modal in their game.

### 3. Client: the `#online` screen

- The hub chip becomes a real `<button id="hub-online-btn">` (same look, ≥44px hit target) that opens
  `#online`. `#home-online` keeps its id and its meaning, so the 5Hz count keeps working untouched.
- Rows reuse `.friend-row` so this page matches the friends screen: dot, avatar, nickname, then a tag
  reading `HERO_NAMES[hero] · רמה N`, and `במשחק` when `inMatch`.
- Two actions per row:
  - **➕ חבר** → `POST /handle-friends/request`. States: `✓ חבר` (disabled) if already in `FRIENDS`,
    `נשלחה` (disabled) if a pending sent request exists, else live.
  - **👥 הזמן** → `sendMsg({ type: 'inviteFriend', toUserId })`, flipping to `הוזמן` on
    `partyInviteSent`. In-match players stay invitable (explicit ruling).
- Empty state: `אף אחד אחר לא מחובר כרגע`. No-identity (web/dev, no token) state: the roster still
  renders, but ➕ is disabled with a hint, exactly as friend search already behaves.

### Known consequence, accepted

Tapping 👥 puts the inviter in a **party lobby** — the server auto-creates a private room for them.
That is the pre-existing `inviteFriend` flow, not something added here.

## Testing

- `test-online-roster.mjs` (ws, pattern copied from `test-challenge.mjs`): roster excludes self and
  guests without a `userId`; includes name/level/cosmetic; `inMatch` reflects reality; a **non-friend**
  invite is delivered (the relaxation) and the cooldown refuses a second immediate invite.
- `_online-page.mjs` (headless browser): the chip opens the screen, rows render from a stubbed
  `onlineList`, ➕ posts exactly one request and flips to `נשלחה`, 👥 sends `inviteFriend` with the
  right userId and flips to `הוזמן`, already-friends render `✓ חבר`, empty state renders.
- Local run on `:3016`, screenshots at 844×390 (phone) and iPad, shown before any push.

## Out of scope

Push-on-connect roster updates, pagination, blocking/reporting, and search within the roster.
