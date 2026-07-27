# Skill-based matchmaking and the search screen

**Date:** 2026-07-27
**Status:** approved design, not yet implemented
**Repo:** `football-mock` (game only — no `pikme-server` change)

## The problem

There is no matchmaking. `joinMatchmade` keeps exactly **one forming room per mode** and drops whoever
arrives into it, whatever their strength (`server.js`, `publicRooms` / `formingRoom`). Trophies are
never consulted; the `diffLevel` the client sends only sets *bot* difficulty.

The countdown screen is worse than absent — it is misleading. Preview bots are published under
**יריבים** from the first tick (`lobbyPayload`, `showBots`), labelled `Bot · רמה 5`. A player waiting
out the 5 seconds is watching a lineup that was decided before the wait began, so the wait reads as a
loading delay rather than a search.

Two pieces already work and are kept: the 5s countdown (`COUNTDOWN_TIME`) and starting early when the
room fills (`joinMatchmade`, `room.members.size >= roomMax(room)`).

## What we are building

Players who press play enter a **queue** and get a **ticket**. A pure matcher runs on the existing
server tick, groups tickets by trophy band, widens each ticket's accepted band as it waits, and only
when a group is decided creates the room. The screen shows a real search: how many others are
searching, which band is being searched, and empty opponent slots that fill in.

### Decisions taken (user, 2026-07-27)

| Question | Decision |
|---|---|
| Trophy source | **Client sends it, server trusts it.** No API call, works for guests. Spoofable; accepted. |
| Bot presentation | **Named opponents with a subtle 🤖 marker.** Reuse `shared/saltiz-bots.js`. |
| Empty pool | **Short-circuit to ~2s**, honestly ("אין שחקנים פנויים כרגע"), rather than fake-wait the full budget. |
| Two humans in a 2v2 | **Opposite teams.** The human contest decides the match. |

## 1. The band ladder

The band unit is `playerLevelFromXp(trophies)` from `shared/difficulty.js` — already shared by client
and server, and already what the hub bar shows. The game's גביעים number *is* its XP number, so
"by trophies only" needs no new metric.

Existing level steps become the bands: L1 = 0–99, L2 = 100–299, L3 = 300–599, L4 = 600–999,
L5 = 1000–1499, … L12 = 6600+.

### Widening schedule

Per ticket, as a fraction of its own budget:

| Elapsed | Accepts | Why |
|---|---|---|
| 0 – 40% of budget | exact level | "similarly leveled first" |
| 40 – 100% of budget | level ±1 | "one up one below" |
| past budget, and completable | ±2, plus 5s grace | "many players online → wait another 5s" |
| deadline | bots at the player's own level | never worse than a matched bot |

Two guards:

- **L12+ collapses into one band.** `playerLevelFromXp` is unbounded (30 000 XP = L25), so without
  this the highest-XP player can never match anyone. This is Brawl Stars' 1000-trophy single-pool rule
  applied to our ladder.
- **The floor is asymmetric.** An L1 ticket accepts L1–L2 only and is never pulled up to L3 by
  someone else's widened net. At the bottom of the ladder a one-level gap is a much larger skill gap
  than at the top.

### Budgets live on the ticket, not the format

`quick` is `teamSize: 2` — so "quick play" and "the 2v2 card" are the **same format**, and today the
**same message**: the yellow משחק מהיר button and the 2v2 picker card both send `quickMatch`
(`client.js`). The 5s-vs-10s split the user asked for is therefore by **entry point**:

| Entry point | Message | Budget |
|---|---|---|
| משחק מהיר button | `quickMatch` | **5s** |
| 2v2 picker card | `matchmade { format: 'quick' }` *(changed)* | **10s** |
| קרב על השער card | `goalBrawl` | **10s** |
| 3 נגד 3 card | `matchmade { format: '3v3' }` | **10s** |

Tickets with different budgets share one pool per format and can match each other; the budget only
governs when each ticket gives up.

**The short-circuit is re-evaluated every tick, not latched.** A ticket whose pool is empty gets an
effective deadline of `queuedAt + 2s`, but if any compatible ticket appears before that deadline the
ticket reverts to its full budget (5s or 10s) and the screen goes back to `searching`. Without this,
two players pressing play 1.5 seconds apart would both short-circuit into separate bot matches while
each was the other's match. The reverse never happens: once a ticket has passed 2s with company, it
keeps its full budget even if that company leaves — it just proceeds to `deadline` normally.

Live formats are `quick` (2v2), `brawl` (2v2) and `3v3` (6 players). **5v5 is out of scope** — it does
not fit the 8-slot snapshot mask (`server.js`, and `summery/TEAM_FORMATS_PLAN.md` §2.2).

## 2. The matcher

One structure holds every waiting player:

```js
tickets: Map<memberId, {
  memberId, mode, level, trophies, queuedAt, budgetMs, graceUsed
}>
```

The decision logic is a **pure function** in new `shared/matchmaker.js`:

```js
planMatches(tickets, now, { formats }) -> {
  groups:  [{ mode, memberIds, reason, level, bandLo, bandHi }],
  waiting: [{ memberId, phase, bandLo, bandHi, searchingCount, remainingMs }]
}
```

**`reason`** — why this group formed. Diagnostics and logging only:

| `reason` | Meaning |
|---|---|
| `full` | every slot taken by humans |
| `grace` | completed during the 5s grace |
| `deadline` | budget expired; bots fill whatever is left |
| `alone` | short-circuit: no compatible ticket ever existed |

**The screen state is chosen by human count, not by `reason`.** `memberIds.length >= 2` → FOUND;
otherwise → NO PLAYERS. Deriving it from `reason` was wrong: a `deadline` group can contain exactly
one human (nobody compatible turned up before the budget expired), and telling that player
"נמצאו יריבים!" over a lineup of four bots is the same dishonesty this redesign removes.

`alone` and a one-human `deadline` therefore show the same screen, and differ only in how fast they
got there — 2s versus the full budget.

**`phase`** — `searching` (exact band) → `widened` (±1) → `grace` (±2, extra 5s). There is no `alone`
phase: a short-circuiting ticket stays in `searching` until it resolves, because it may still revert
to the full budget.

**Units.** `level` and `bandLo/bandHi` are **player-level** numbers from `playerLevelFromXp` (1…12+,
what the UI prints as רמה). The room's bot difficulty is a *different* scale — `botLevelFromXp` gives
0…11 — and is derived once at formation as `botLevelFromXp(median human trophies)`. Never assign one
to the other without converting; the two ladders are off by one and clamp differently.

It touches no sockets and no rooms. `server.js` performs every side effect: create the room, move
members in, start the reveal. That split is what makes the policy testable headlessly, like the rest
of the suite.

### Per mode, per tick

1. **The oldest ticket seeds a group.** Seeding by newest lets a fresh arrival steal the partner
   someone has been waiting nine seconds for.
2. **Compatibility is mutual.** A candidate must be inside the seed's accepted band *and* the seed
   inside the candidate's. Without this an L1 who accepts only L1–L2 gets pulled into an L3's widened
   net — which the asymmetric floor rule exists to prevent.
3. **Group full → emit immediately**, `reason: 'full'`. This is "4 players for 2v2, don't wait out the
   10 seconds".
4. **Deadline reached → emit whoever is compatible plus bots**, `reason: 'deadline'`.

### "Many players online", defined

At the deadline, count same-mode tickets within ±2 levels, excluding self. If
`1 + that >= roomMax(mode)` the room is *theoretically completable*, so grant the 5-second grace —
**once per ticket, never twice** (`graceUsed`). Otherwise go straight to bots.

Deliberately not `onlineCount()`: someone idling in the shop must not cost a searching player five
seconds.

### Team assignment

Humans in the group sorted by trophies, alternated A / B, so the two closest-matched players are
opposed. Bots fill the remaining slots.

### Room level (fixes a live bug)

`room.diffLevel` is currently last-writer-wins from whoever joined most recently (`joinMatchmade`) —
in a shared public room the newest arrival sets bot difficulty for everyone already waiting. The
group's level is now computed **once at formation** from the **median** human trophy count, via
`botLevelFromXp`.

### Cancellation

Disconnect, `חזרה`, or joining anything else drops the ticket. During a search a ticket is the only
state that exists, so there is nothing else to unwind.

## 3. The search screen

Same `#team-intro` overlay, three states. The player's own side is populated from the first frame; the
opponent side starts genuinely **empty** — this is the honesty fix for preview bots appearing under
יריבים at tick 1.

```
SEARCHING                                          t = 0 → budget
┌─────────────────────────────────────────────────────────────┐
│        כדורגל · 2 נגד 2  ·  ראשון ל-3                       │
│     מחפש יריבים...        ● ○ ○ ○      רמה 5      ⏱ 7       │
│         3 שחקנים מחפשים כרגע                                │
│  ┌── הקבוצה שלי ──┐    נגד    ┌──── יריבים ────┐            │
│  │ Player  רמה 5  │           │ ┆ מחפש...    ┆ │            │
│  │ [][][]         │           │ ┆            ┆ │            │
│  │ ┆ מחפש...    ┆ │           │ ┆ מחפש...    ┆ │            │
│  └────────────────┘           └────────────────┘            │
│                        חזרה                                 │
└─────────────────────────────────────────────────────────────┘
      band chip widens visibly:  רמה 5  →  רמה 4–6

FOUND                                        2+ humans in the group
│     ✦ נמצאו יריבים!      ● ● ● ●      רמה 4–6                │
│  Player רמה 5 · פז 🤖 רמה 5   נגד   דני רמה 6 · נווה 🤖 רמה 5 │
      hold ~1.5s, kickoff

NO PLAYERS                          1 human — whether via `alone` or `deadline`
│   אין שחקנים פנויים כרגע — משחק מול רמה 5    ● ● ● ●          │
      hold ~1.5s, kickoff
```

Three deliberate choices:

- **The searching count is the feature.** `3 שחקנים מחפשים כרגע` is what makes this a search rather
  than a timer. It comes from the matcher's `waiting` list, not `onlineCount()`.
- **The widening is visible.** `רמה 5` → `רמה 4–6` tells the player why the wait continued. An
  unexplained countdown reads as lag; a widening net reads as effort.
- **Resolution always gets a fixed ~1.5s reveal**, however the group formed. Today a full room jumps
  straight to `startMatch` with no VS beat — fast but abrupt. Worst case becomes 10s + 1.5s; best case
  ~2s + 1.5s.

### Wire

One new server → client message, sent to ticket holders (who have no room yet, so `lobby` cannot
carry it):

```js
{ type: 'searching', mode, phase, bandLo, bandHi, searchingCount, remainingMs,
  slots: { filled, total } }
```

Once the room exists the existing `lobby` → `matchStart` path is unchanged.

### Not a bug — noted so nobody "fixes" it

Reading `#ti-mode`'s `textContent` yields `כדורגל · 2 נגד 2ראשון ל-3 · עד 2 דק׳`, which looks like a
missing separator. It isn't: `.ti-mode-name` and `.ti-mode-rule` are separate block spans and render
correctly on two lines. The run-together string is an artefact of concatenating a parent's text across
two children. Leave `showVsMode` alone.

## 4. Bot naming

`shared/saltiz-bots.js` provides four named bots at fixed display levels (אורי 5, פז 7, נווה 8,
שובל 11). A 3v3 can need five bots at an arbitrary level, so:

- Prefer a named bot whose level is within ±1 of the room's level.
- Otherwise use a generated-name pool, at the room's level.
- Every bot carries the 🤖 marker on the VS screen and in the match HUD.

Named bots keep their existing seeded loadout behaviour (`botLoadoutForLevel`), so what the VS screen
advertises is what the bot plays with.

## 5. Testing

The matcher takes `now` as a parameter, so tests drive time by passing timestamps — no sleeps, no
timers. The suite already has one hanging test (`test-bot-ladder.mjs`); this adds no second.

**`test-matchmaker.mjs`** (pure):
- exact-band grouping at every band, including L12+ collapse
- mutual compatibility — an L1 is never pulled into an L3's widened net
- asymmetric floor: L1 accepts L1–L2, never L3
- oldest-ticket-seeds fairness: a newcomer cannot steal a long-waiting ticket's partner
- grace granted only when `1 + nearby >= roomMax`, and at most once per ticket
- `reason` is correct for each exit: `full`, `grace`, `deadline`
- group level is the **median** human level, not the newest joiner's
- per-ticket budgets: a 5s and a 10s ticket in one pool match each other, and each gives up on its own
  clock
- the short-circuit is not latched: a ticket alone at t=1.5s that gains a compatible ticket at t=1.8s
  reverts to its full budget and is matched, instead of two players each starting a bot match
- `reason` is `alone` only via the short-circuit, never from a full budget expiring with one human
- a one-human `deadline` group reports the NO PLAYERS state, not FOUND — the screen is chosen by
  human count, never by `reason`
- a member never holds two tickets; queueing again replaces the first

**`test-matchmaking-live.mjs`** (boots a real server on its own port, drives 4–6 sockets):
- two same-band players are matched and land on **opposite** teams
- a lone player short-circuits to bots in ~2s
- a room that fills at t=3s kicks off without waiting out the budget
- cancelling mid-search removes the ticket, and the remaining player's `searchingCount` drops
- private rooms, parties, challenges and training still bypass matchmaking entirely

**Visual:** CDP screenshots of all three screen states at 844×390, as with the arena work.

## 6. Risks accepted

- **Client-reported trophies are spoofable.** The user's call; at this population the smurf is
  theoretical.
- **Most matches will still be bot matches.** This design makes that fast and honest rather than
  hidden behind a fake search.
- **Older clients that send no trophies must not default to L1** — that would feed veterans on stale
  builds into beginners' matches. Fall back to the `diffLevel` the client already sends, then to
  `DEFAULT_LEVEL`, and never grant an unknown ticket the grace extension.

## 7. Out of scope

No hidden MMR or rating separate from trophies. No cross-mode matching. No queueing as a party
(parties have their own room path and bypass this). No auto-requeue after a match. No latency or
region matching. No 5v5.

## 8. Files

| File | Change |
|---|---|
| `shared/matchmaker.js` | **new** — `planMatches`, band maths, widening schedule |
| `shared/constants.js` | budgets, grace, reveal hold, short-circuit threshold |
| `server.js` | ticket queue, matcher call in the tick, `searching` message; `joinMatchmade`'s forming-room logic replaced |
| `public/client.js` | search states, band chip, searching count, bot 🤖 marker; 2v2 card → `matchmade` |
| `public/index.html` | search-state markup inside `#team-intro` |
| `public/style.css` | search states, empty opponent slots, pips |
| `test-matchmaker.mjs` | **new** — pure policy tests |
| `test-matchmaking-live.mjs` | **new** — multi-socket integration |

## Reference

Brawl Stars, for the parts worth copying and the part worth avoiding:

- Trophy-banded matching, and a **single pool above a threshold** to stop high-end waits exploding —
  [Oct 2024 trophy overhaul](https://www.sportskeeda.com/mobile-games/brawl-stars-october-2024-update-trophy-system-overhauled-new-trophy-box)
- Bots by design for new players' first ~100 trophies —
  [Trophies wiki](https://brawlstars.fandom.com/wiki/Trophies)
- The failure mode to avoid: [a documented ~50-minute queue](https://brawlstars.fandom.com/wiki/User_blog:Niku1111/A_Brief_Experiment_on_Matchmaking)
  in a thin population, ending in bots anyway. Our short-circuit exists precisely because this game's
  population is thin by default.
