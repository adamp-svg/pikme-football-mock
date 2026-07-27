# Team-first party flow: invite, vote, force, spectate

**Date:** 2026-07-27
**Status:** design, awaiting approval
**Repo:** `football-mock` (game only — no `pikme-server` change)

## The request (user, 2026-07-27)

Seven items, verbatim intent:

2. Team-page chat becomes a **vertical rail on the right**, about a quarter of the screen, instead of
   sitting at the bottom.
3. **Each player picks the game they want**, and their choice **glows in their own colour** so everyone
   can see who wants what.
4. The **team leader can force a game** of their choice, and **kick** players.
5. **«שחק עם חברים» opens the team page first**, with a **pixel-art `+`** that opens the friends page to
   invite — and he can invite **many** friends.
6. Invited friends **pour into the team**, where they chat and choose a game.
7. If there are **more players than the format seats** (5 people, 2v2), the extras become
   **viewers**, watching the match **from the perspective of whoever invited them**.
8. **Room codes are not needed** — this is invite-only. (Decision: **hide behind a flag, don't delete**.)

Item 1 (friend chat «השליחה נכשלה») was not a code bug: the game half shipped without
`pikme-server` `5448f17`. Fixed by deploying the API; not part of this design.

## What already exists

A large part of items 3–4 is already built and server-enforced. This design wires UI to it rather than
re-implementing it.

| Capability | State | Where |
|---|---|---|
| Host-only **kick**, server-enforced, can't kick self, handles `lbot-` reservations | **done** | `server.js` `msg.type === 'kick'` |
| Host-only **game pick** (`partyGame`), applied immediately, **refuses a shrink that would strand players** | **done** | `server.js` `msg.type === 'partyGame'` |
| Party **chat** (presets + 40-char free text, party rooms only) | **done** | `#party-chat`, `renderPartyChat()` |
| Party **roster** with per-member blocks and chat bubbles | **done** | `#party-roster`, `renderParty()` |
| `spectate` message | **exists but wrong for this** | `startSpectate()` builds its own *bot-game demo* room; it does not attach you to someone else's match |

So the real new work is: the layout change (2), per-player votes (3), the entry-order inversion (5–6),
overflow spectating (7), and a flag (8).

## 1. Entry order (items 5, 6)

Today `#play-friends-btn` calls `openFriendSelect()` — friends first, party second, with
`partyStage = 'invite' | 'roster'` tracking which. Inverted:

- `#play-friends-btn` → **create the party room and show `#party` immediately** (`partyStage = 'roster'`).
- The roster's first tile is an **invite tile**: a pixel-art `+` (from the icon pack, matching
  `.build-icon` treatment) labelled «הזמן חבר».
- Tapping it opens `#friend-select` **as a modal over the party**, not as a replacement screen. Picking
  friends sends invites; the sheet stays open so **many** friends can be invited in one visit; closing
  it returns to the team page.
- `partyStage = 'invite'` is retired. There is one stage — the team page — and the friends sheet is a
  modal on top of it. That removes the class of bug where the two stages disagreed about whether a
  room existed (`leaveToLobby` currently has to drop "the orphan party room" for exactly that reason).

**Empty state matters here.** A solo party is now the *first* thing you see, so it must not look
broken: the roster shows you, the `+` tile, and a line saying you can start alone with bots.

## 2. Chat as a right-hand rail (item 2)

`#party-chat` moves from below the roster into a vertical rail occupying **~25% of the width on the
right** (the user wrote "1.4", read as **1/4** — flagged as an assumption).

- The rail is a column: message list on top (scrolls, newest at the bottom), composer pinned at its
  base.
- Roster + game list take the remaining ~75%, to the left of it.
- **Safe areas:** the game is landscape, so the rail must inset with
  `max(<fallback>, env(safe-area-inset-right))` — a rail flush to `right: 0` sits under the notch on a
  rotated phone. Same convention as `53e594c`.
- Bubbles continue to render on each member's roster block as they do now; the rail is the *history*,
  not a replacement for the bubbles.

## 3. Per-player game votes (item 3)

New per-member field, `vote` — the MODES card id that member wants.

- Wire: new `partyVote { game }` message. Any member may vote (unlike `partyGame`, which is host-only).
  Server validates the id against `CARD_TO_FORMAT` and stores it on the member; it rides the existing
  lobby broadcast as `member.vote`, so **no new packet type and no new broadcast**.
- A vote **changes nothing about the room** — not `teamSize`, not the format. It is an expression of
  preference. Only the host's `partyGame` alters the room.
- **Colour:** each member gets a stable colour derived from their member id (the palette already used
  for saltiz bots in `shared/saltiz-bots.js` extends naturally). A voted mode card glows in the
  colours of everyone who voted for it — multiple voters mean multiple colour marks on one card, not
  one colour overwriting another.
- The host's own vote is visually distinct from the host's *decision*: a vote is a glow, the decision
  is the card becoming selected. Conflating them would make it impossible to tell "the host wants
  this" from "we are playing this".

## 4. Leader controls (item 4)

Both halves already exist server-side; this is UI plus one guard.

- **Force play:** the host's game pick already applies immediately and ignores votes. Surface it
  honestly — the host's mode list gets a «שחק» affordance, and members see «המארח בחר» when it lands.
  Nothing about the existing shrink-refusal changes: with 6 in the room and 2v2 picked, the server
  still refuses rather than stranding two people — **except** that item 7 changes what "stranded"
  means (see below).
- **Kick:** already server-enforced host-only. The roster gains a kick affordance on each member
  block, host-only, with a confirm — matching the existing friend-removal pattern.

## 5. Overflow spectators (item 7) — the only genuinely new capability

Today a party larger than the format's capacity is **impossible**: `partyGame` refuses the shrink. The
request is that the overflow becomes viewers instead.

Design:

- The room keeps its full member list. At `startMatch`, the first `teamSize × 2` members by join order
  are **players**; the rest are **spectators** (`member.inMatch = false`, `member.spectating = true`).
- Snapshots already broadcast to the whole room, so a spectator receives the match stream without a
  new channel. What they must NOT have: an input slot, a player id in the sim, or a place in the
  roster's team columns.
- **"As the player who invited him"** — a spectator's camera follows their **inviter**. `invitedBy` is
  recorded when an invite is accepted; the spectator's client centres on that member's player. If the
  inviter is themselves a spectator or has left, fall back to following the ball.
- The shrink-refusal in `partyGame` **relaxes**: picking a smaller format is now legal, because the
  overflow has somewhere to go. The refusal is replaced by a **confirmation** naming who will watch
  rather than play — silently demoting two friends to spectators would be worse than the old error.
- Spectators must be visibly spectators **before** kickoff, on the team page and the VS screen. Finding
  out at kickoff that you are not playing is the same class of dishonesty the matchmaking redesign
  removed.

**This item is materially larger than the other six.** It touches the sim's roster construction, the
snapshot path, the camera, and the team page. It is the one I would ship as its own slice if any part
of this has to be cut.

## 6. Room codes behind a flag (item 8)

`ROOM_CODES_ENABLED = false` in `shared/constants.js`.

- Hides: «צור חדר», «הצטרף לחדר», and the code-entry field.
- Keeps: every server handler (`createRoom`, `joinRoom`, `joinDecision`), because **challenges and
  party invites ride the same room machinery** — the private room *is* the party. Only the
  code-as-an-entry-point disappears.
- One flag flip restores it.

## Testing

- `test-party-votes.mjs` — votes are per-member, any member may vote, a vote never changes
  `teamSize`/format, an invalid id is rejected, votes survive a lobby broadcast, two voters on one card
  both appear.
- `test-party-spectators.mjs` — a 5-member party at 2v2 seats 4 and marks 1 spectator; the spectator
  gets snapshots but no input slot and no sim player; `invitedBy` drives the follow target; a
  spectator whose inviter left falls back to the ball; the shrink path confirms rather than refuses.
- `test-party-flow.mjs` — `#play-friends-btn` lands on `#party` with a room already created; the
  friends sheet opens as a modal and closes back to the party; multiple invites in one visit; the flag
  hides code entry while `createRoom` still works server-side.
- Existing `test-party.mjs` and `test-party-3v3-chat.mjs` must keep passing — they cover the party
  lifecycle and the chat this rearranges.
- CDP screenshots at 844×390 **and** under a simulated 44px notch: the team page solo (empty state),
  with 5 members and a spectator, and with two members voting different games.

## Out of scope

No public-matchmaking change (that shipped today and is untouched). No spectating of *matchmade*
matches — invite-only, per item 8. No vote-based auto-start: the host decides, always. No spectator
chat restrictions beyond what party chat already enforces.

## Assumptions flagged

1. **"1.4 of the screen"** read as **one quarter** of the width. If it meant something else, the rail's
   width is one CSS value.
2. **Join order decides who plays** when a party overflows. The alternative — the host picks the
   starters — is more control but more taps; join order is predictable and needs no UI.
