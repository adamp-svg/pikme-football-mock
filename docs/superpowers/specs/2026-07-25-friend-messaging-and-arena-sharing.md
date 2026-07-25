# Friend messaging + arena sharing — design

> Agent lane: `social` (friends & shareable artifacts). Decided with the user 2026-07-25, question-by-question.
> Repos touched: **football-mock** (game/client) + **pikme-server** (store/API). NOT the app repos.

## What the user chose

| Question | Decision |
|---|---|
| First slice | **Both — messaging first.** A shared arena is just a kind of message in the thread. |
| Transport / storage | **Persisted in pikme-server** (Mongo + REST behind `football-auth`). Reaches offline friends; a shared arena survives both players leaving. |
| Message content | **Preset quick-messages only** — no free text. Plus attachments (arena). Zero moderation surface. |
| UI surface | **Tap a friend row → thread.** Unread dot on the row, badge on the friends button. No new hub screen. |
| Notify reach | **In-game badges now**; pikme-server emits the event through a single hook so an app push slice can land later without redesign. |
| Phrases | **Grouped phrase set + emoji reactions** on individual messages. |

## Why this shape

Two things made it cheap:

- **Playing a shared arena needs no new game code.** `builderMatch` (server.js:1098) already takes a raw field, runs it through `sanitizeField` (server.js:384) and starts a vs-bots match via `startBuilderMatch`. A received arena reuses that path verbatim.
- **Saved arenas already have a stable shape** — `{version, bushes, hardWalls, dryWalls, crates}` — the same one `FIELD_PRESETS`, `arenaFromLayout()` and the builder library (`pikme-fields`) all speak.

So the real new work is the message store and the thread UI.

## Data model (pikme-server)

New `data/message.js`:

```
{ threadKey, fromUserId, toUserId,
  kind: 'preset' | 'arena',
  presetId?,                       // opaque id, e.g. 'praise_goal'
  arena?: { name, field },         // field = the builder save shape
  reactions: [{ userId, emoji }],
  createdAt, readAt }
```

`threadKey` = the two userIds sorted and joined, so both directions are one thread.

**Presets are stored as an opaque id, never as text.** The Hebrew wording lives only in the game
(`shared/quick-messages.js`), so phrases can be added or reworded with a game deploy and no backend
deploy. Server validates `/^[a-z0-9_]{1,24}$/`; the client skips ids it doesn't know.

### Endpoints — `routes-pikme/messages.js`, all behind `authFootball`

- `GET  /handle-messages/threads` — per-friend last message + unread count (drives the dots/badge)
- `GET  /handle-messages/thread?withUserId=` — last N messages, marks them read
- `POST /handle-messages/send` — `{ toUserId, kind, presetId | arena }`
- `POST /handle-messages/react` — `{ messageId, emoji }`, toggles

Guards on send: sender and recipient must be **actual friends** (`UserInfo.friends`), per-sender rate
limit, emoji must be in the allowed set, and the arena payload is size- and shape-capped before it
ever reaches Mongo.

### Push hook

A single `notifyMessage(toUserId, msg)` in the messages route, no-op for this slice.
`routes-pikme/notifications.js` already exists, so the later app-push slice fills in that one
function instead of touching the message flow.

## Client (football-mock)

- `shared/quick-messages.js` — grouped `QUICK_PHRASES` (greetings · game · praise · reactions) +
  `REACTION_EMOJI` + `phraseById()`.
- Friend row gets a tap handler → opens the thread. The existing **אתגר** button must
  `stopPropagation` so challenging a friend still works.
- Thread view: phrase composer (grouped tabs), 🏟️ share-arena button that picks from the saved-field
  library, long-press a message → reaction bar.
- A received arena card offers **שחק** (`builderMatch` with that field) and **שמור** (append to the
  `pikme-fields` library).
- Polling: threads on friends-screen open, plus a slow poll while in the hub.

## Gotcha to respect

`public/client.js:84` silently drops the whole `pikme-fields` library from the account-sync bag once
the prefs bag passes `PREF_MAX_BYTES` (200 KB). **Arena sharing must not be built on that sync** — a
shared arena travels as its own message payload, and saving a received arena only writes localStorage.
Heavy builder users' libraries already don't reach the account; that's a separate bug, not this
feature's job to carry.

## Build order

1. `shared/quick-messages.js` (pure data — nothing depends on the backend)
2. pikme-server: model + `/handle-messages` routes + guards + tests
3. Client: thread UI, composer, unread badges
4. Arena share: send from the library, receive card with שחק / שמור
5. Reactions
