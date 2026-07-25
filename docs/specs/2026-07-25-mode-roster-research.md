# Mode Roster & Meta Layer — Reference Research + Decisions

> **Date:** 2026-07-25 · **Agent:** `meta-research` · **Status:** research/decision doc, nothing implemented.
> **Scope:** how many modes should be LIVE at once, how the rest rotate, and what meta layer wraps them.
> **Sibling specs (same design pass):** `2026-07-25-lobby-game-picker.md`, `2026-07-25-3v3-mode.md`,
> `2026-07-25-mode-polish.md`, `2026-07-25-new-minigames.md`.
> **Do not duplicate:** trophy math, ladder tiers, season resets and bot-match payout are already
> researched in depth in `summery/research-trophies/01..05`. This doc **defers to those** and only
> covers the parts they don't: the *roster*, the *rotation*, and the *matchmaking consequences*.

---

## 0. Where we actually are (verified against the repo, not assumed)

| Thing | Reality in `main` @ `8cf089e` |
|---|---|
| Public matchmade modes | **2** — quick match (`quickMatch()`, `server.js:302`, pool `publicRoom`) and goal brawl (`goalBrawl()`, `server.js:324`, **separate pool** `publicRoomBrawl`) |
| Non-matchmade surfaces | training (`server.js:344`), vs-bots (`435`), field-builder playtest (`407`), party/private (`createRoom`/`joinRoom`, `1170-1215`), friend challenge (`461`) |
| Queue / MMR / playlist | **None.** Zero `queue`/`ranked`/`casual`/`playlist` identifiers in the codebase |
| Matchmaking window | `COUNTDOWN_TIME = 5` (`server.js:71`). That is the *entire* window. Bots fill everything else at `startMatch` via `fillBots` (`server.js:190`) |
| Team size | `MAX_PLAYERS = 4` (`shared/constants.js:311`), plus hardcoded `teamSlots = {A:[0,1], B:[0,1]}` at `server.js:556` and `server.js:1019`. No `TEAM_SIZE` constant exists |
| Dead UI | 3 locked `בקרוב` mode cards in `#arena`, 2 in `#party`, 2 in `#game-select`, 1 in hub strip; shop + clubs are **100% stub** (wallet literally `<b>0</b> 🪙`); news is static HTML; `עונה 1` is a hardcoded string |
| Currency | **None exists** |
| Daily quests / missions / streaks | **None exist.** Only a cosmetic midnight countdown in `#shop` |
| Seasons | **None exist** |
| Consistency bug | Goal brawl is **live** from the hub strip but shown **locked** in `#arena` and `#party`. Two pickers disagree → hand to `lobby-picker` |

**The one number that matters:** our matchmaking window is **5 seconds**. Everything below follows from that.

---

## 1. Brawl Stars — the roster model

### What they actually do

Brawl Stars does **not** run all modes in parallel. It runs a fixed number of **event slots**, and modes
compete for slots. As of the September 2025 release notes the structure is explicit:

- **Permanent, non-rotating slots:** *"Brawl Ball, Knockout, Air Hockey, Knockout 5v5, Gem Grab and Brawl Arena will no longer be rotating with other game modes."*
- **Rotating, three shared slots:** *"Heist, Hot Zone and Token Run will rotate in 1 slot"*, *"Dodgeball, Volley Brawl and Basket Brawl will rotate in 1 slot"*, *"Wipeout, Bounty and Duels will rotate in 1 slot"*
  ([Supercell release notes, Sept 2025](https://supercell.com/en/games/brawlstars/blog/release-notes/release-notes-september-2025/))

So: ~20 designed modes → **~9-10 slots open at any moment**, and the marginal modes share a slot on a
rotation that flips on a **fixed daily clock** (per-slot update times of 05:00 / 11:00 / 17:00 / 23:00,
with a 2-hourly "featured" slot) ([Brawlify event rotation](https://brawlify.com/maps),
[Brawl Time event rotation](https://brawltime.com/events)).

### Gating

Modes are gated on **Trophy Road**, the account-wide total-trophy track
([Brawl Stars Wiki — Trophies](https://brawlstars.fandom.com/wiki/Trophies),
[Trophy Road explained](https://mobilematters.gg/guides/brawl-stars/trophy-road-explained)).
The gates are *very* early — Showdown is available immediately, Gem Grab unlocks at **30 trophies**
([Prima Games](https://primagames.com/tips/how-unlock-new-modes-brawl-stars)) — with only the
competitive layer held back: **Ranked unlocks at 1,000 trophies**
([Ranked details](https://www.sportskeeda.com/esports/all-brawl-stars-ranked-mode-details)).
Note the shape: *content* gates are near-zero, only the *serious ladder* is gated.

### Why rotate at all

Supercell has never published a design rationale, but the mechanism is visible: rotation (a) keeps the
mode list short enough to be legible on a phone, (b) manufactures a daily reason to reopen the app —
the standard live-ops "rotating content + urgency + routine" pattern
([LiveOps playbook](https://gamegrowthadvisor.com/blog/2026-03-31-liveops-strategy-mobile-games-guide/)),
and (c) **concentrates the population**. Supercell has ~tens of millions of DAU and *still* refuses to
run 20 parallel queues. That's the tell.

> **→ for Saltiz:** copy the *structure*, shrink the *numbers*. Adopt the slot model literally:
> **permanent slots + one shared rotating slot.** Do NOT copy the trophy gating — see §6. Concretely:
> a `MODE_SLOTS` config (`{permanent: [...], rotating: [[...]]}`) resolved server-side on a fixed clock,
> so the roster is **data, not UI**. And copy the fixed-hour flip: **17:00 Asia/Jerusalem** (after
> school for this audience), not midnight.

---

## 2. Fortnite — LTMs as cheap idea-testing

Epic's stated use of Limited Time Modes is experimentation, not content: *"Epic Games uses LTMs to
experiment with new game mechanics and features, and the feedback gathered from these modes helps shape
the future of Fortnite"* — including using LTMs to test new shooting models, and spinning up *"a dozen
or so LTMs, some of these may be more straightforward (e.g. along the lines of Sniper Shootout, Sneaky
Silencer)"* ([Fortnite Wiki — LTMs](https://fortnite.fandom.com/wiki/Limited_Time_Modes),
[Pro Game Guides LTM list](https://progameguides.com/fortnite/fortnite-ltm-list-guide/)).
The pattern that matters: **cheap LTMs are one-parameter variants of the same core** (snipers only,
silencers only, 50v50). Playground → Battle Lab is the canonical case of an LTM graduating to permanent
([PC Gamer on LTMs](https://www.pcgamer.com/the-best-and-worst-fortnite-limited-time-modes/)).

Discover is a *vertical list of horizontally-scrolling rows* of modes, and — the load-bearing detail —
v24.10 **added live concurrent player counts to every mode tile**
([Fortnite Wiki — Discover](https://fortnite.fandom.com/wiki/Discover)). Epic shows population *because*
Epic has population. Rocket League, which doesn't in every playlist, **deleted** its population
indicator from the Casual/Competitive/Extra Modes menus
([Patch Notes v2.26](https://www.rocketleague.com/en/news/patch-notes-v2-26)).

> **→ for Saltiz:** two decisions.
> 1. **Every new minigame ships first as a 3-day LTM in the rotating slot**, never as a new permanent
>    card. Promotion criterion decided *before* launch (see §5 rotation contract). This is how
>    `new-minigames.md`'s top-3 should ship — three consecutive LTM windows, not three new buttons.
> 2. **Never show player counts or "X players online" in the picker.** With our population that number
>    is a de-motivator. Rocket League removed theirs; we should never add one. Show *"מתחיל עכשיו"* /
>    a filling VS-preview instead — the countdown screen already renders a bot-accurate roster preview
>    (`computeBotPlan`, `server.js:1017`), which is exactly the right lie-free way to say "this is full".

---

## 3. Roblox — session continuity beats matchmaking

Roblox's own matchmaking is a cautionary tale: developers repeatedly report the platform *"sending every
single new player into their own server, only filling servers up to 1 player"* even with "fill each
server as full as possible" enabled
([devforum](https://devforum.roblox.com/t/roblox-will-sometimes-fail-matchmaking-sending-every-single-new-player-into-their-own-server-only-filling-servers-up-to-1-player/3981356),
[devforum](https://devforum.roblox.com/t/empty-servers-despite-the-option-for-roblox-to-fill-them-as-much-as-possible-toggled/1862917)).

The *successful* Roblox pattern is the opposite of matchmaking: **one persistent lobby that cycles
minigames**. Epic Minigames (138 minigames, 1B+ visits) never re-matchmakes: *"After each round players
will respawn in the lobby, where a new minigame is chosen after 10 seconds"*, rounds are
*"usually around 30 to 90 seconds"*, and winners earn points spendable in a shop
([Roblox Wiki — Epic Minigames](https://roblox.fandom.com/wiki/Player:TypicalType/Epic_Minigames),
[NamuWiki](https://en.namu.wiki/w/Epic%20Minigames)).

This is mathematically important, not just cosy: a persistent lobby converts a **Poisson arrival
problem** (everyone must show up in the same 5-second window) into an **accumulation problem** (humans
pile up and stay). It is the single cheapest way to raise humans-per-match without raising DAU.

Roblox's cross-fill matchmaking guidance is the standard widening band: *"the matchmaker first searches
for opponents within a tight rating window, then relaxes that window every few seconds a player waits"*
([Roblox matchmaking systems](https://simplified.media/guides/roblox-matchmaking)).

> **→ for Saltiz:** **build the persistent room before building any new mode.** On match end, do not
> dissolve the room: keep the human members, show a 10-second "הסיבוב הבא" screen, rotate the mode/field,
> restart. Bots get re-rolled; humans stay. `modes-polish.md` owns the results screen — this needs to be
> in it. Concretely: `startMatch` currently drops the room to `phase` end; add a `phase: 'intermission'`
> that keeps `room.members` and re-runs `fillBots`. **This is the highest-leverage item in this doc.**

---

## 4. Rocket League — one physics core, many rule-sets

Rocket League is the closest structural analogue: identical car+ball physics, ~8 rule-sets on top
(Duel, Doubles, Standard, Rumble, Dropshot, Hoops, Snow Day, Heatseeker). Two things it did are directly
instructive, and both are **consolidations**:

1. **Extra Modes were folded into the Competitive card** rather than kept as a parallel queue axis, and
   the seasonal competitive Extra Mode **alternates**: *"Rocket League alternates between Competitive
   Snow Day and Dropshot each Season"* — the one not currently competitive falls back into the Arcade
   rotation ([First Look: Play Menu Changes](https://www.rocketleague.com/news/first-look-play-menu-changes-coming-to-rocket-league)).
2. **Casual got two rotating Arcade playlists** rather than a permanent card per mode: they *"rotate
   weekly through Extra Modes like Heatseeker, Spike Rush, Rocket Labs modes"*, updating each Wednesday,
   with the more-played of the two **kept for a second week** and the less-played cycled out
   ([Dueling Arcade Playlists](https://www.rocketleague.com/news/keep-a-favorite-extra-mode-in-rotation-with-rocket-leagues-dueling-arcade-playlists)).

Community pressure ran the same direction: *"low player counts in certain playlists make for absurdly
long matchmaking times, especially at higher ranks, with 10+ minute queues"* — the argument for killing
Solo Standard ([Forbes, 2020](https://www.forbes.com/sites/maxthielmeyer/2020/01/23/is-it-time-for-psyonix-to-kill-rocket-leagues-solo-standard-playlist/)).
Rocket League has millions of players and still cannot afford 8 healthy competitive queues.

> **→ for Saltiz:** three decisions.
> 1. **Modes are rule-sets over one sim, and must be expressed as data.** Today `goalsToWin`, `noClock`,
>    field, roster shape are scattered across five bespoke `start*()` functions in `server.js`. Refactor
>    to a single `MODE_DEFS` table (`{id, teamSize, field, goalsToWin, duration, flags}`) that
>    `startMatch` consumes. Without this, every new mode is a new code path and the LTM strategy in §2
>    is unaffordable.
> 2. **Never split casual vs competitive.** That's a 2× population split for zero content. One public
>    pool; trophies apply to it, discounted for bot-heavy matches per `research-trophies/04`.
> 3. **Steal the "winner stays" rotation rule verbatim** — the more-played of the rotating candidates
>    survives another window. It is a free, honest promotion criterion that needs one counter.

---

## 5. The small-player-base problem (the important section)

### 5.1 Reframe: our failure mode is not a dead queue, it's an *invisible* dead queue

Because `fillBots` guarantees a full match in ≤5s, **we will never show a long queue**. We will instead
silently serve all-bot matches. That is strictly worse than a visible wait, because the player can't
diagnose it and the social loop never forms. **The metric to optimise is not queue time. It is
`P(≥1 other human in your match)`.**

### 5.2 The math

Poisson arrivals into a pool at λ human match-starts/minute, gathering window W seconds, M parallel
modes splitting the pool. `P(≥1 other human) ≈ 1 − e^(−(λ/M)·W/60)`.

| λ (humans starting/min) | modes M | W = 5s (today) | W = 30s | W = 30s + persistent lobby¹ |
|---|---|---|---|---|
| 0.5 | 1 | **4%** | 22% | ~40% |
| 2 | 1 | **15%** | 63% | ~85% |
| 2 | 2 | **8%** | 39% | ~65% |
| 2 | 4 | **4%** | 22% | ~40% |
| 6 | 1 | **39%** | 95% | ~99% |
| 6 | 4 | 12% | 63% | ~85% |

¹ persistent-lobby column is an order-of-magnitude estimate: humans persist across rounds, so the
effective window is the *session*, not the round.

Read the first column. **At our scale, a 5-second window means almost every match is all-bot regardless
of how many modes we run.** Mode count is the second-order problem; the window is the first-order one.
Adding modes then multiplies the damage: λ/M is the fragmentation term, and it is exactly the mechanism
described by the standard matchmaking account — *"each factor that the matchmaker uses to determine
whether the players are eligible for the game reduces the size of the player pool to choose from"*, and
with two map options *"the maximum waiting players doubles from three to six"*
([askagamedev](https://www.tumblr.com/askagamedev/655342898820349952/why-in-some-cases-in-multiplayer-games-queue-in)).

The generally-accepted resolution is to trade match quality for fill: *"a player would rather play a
game that isn't ideal than wait a long time for one that is"* (ibid.), implemented as a widening band —
Apex's Continuous Window Matchmaking *"widens the skill levels that are allowed into a match"* as
population shrinks ([EA matchmaking update](https://www.ea.com/en/games/apex-legends/apex-legends/news/matchmaking-update-0924)).
We have no skill band to widen — **so our widening dimension is the mode itself.**

### 5.3 Techniques, ranked by value for us

| Technique | Verdict | Why |
|---|---|---|
| **Persistent lobby / auto-rematch** (§3) | **DO — first** | Turns arrivals into accumulation. Costs one `phase` value. Biggest win available |
| **Adaptive gathering window** | **DO — second** | 5s only when ≥2 humans present; otherwise hold ~25-30s with a live-filling VS preview and a **"התחל עכשיו"** skip button. Never a spinner |
| **Single pool, mode chosen inside it** | **DO** | Humans pool first, mode second. This is the Epic Minigames inversion and the §2 widening dimension |
| **Bot backfill** | **already have — keep, but grade it** | Universal for small games (*"if there are not enough players in a room, bots (AI) will automatically join the vacant spots"*, [itch.io devlog](https://itch.io/devlog/623308/version-005-update-bots-added.amp)). Well-known failure mode is bots that *never get replaced* ([EA forums](https://forums.ea.com/idea/battlefield-6-bug-reports-en/day-two-asking-to-fix-the-bot-backfill-that-are-never-replace/13229469)) — so: **allow late-joining humans to displace bots mid-match**, don't lock the roster at kickoff |
| **Prime-time window** | **DO — free** | Small communities survive on scheduled concurrency: *"the most reliable games are organized in advance, with players agreeing on a time, a version, a mode"* ([Descent community](https://descent.us/descent-multiplayer-in-2026-active-modes-community-servers-and-how-to-join-games)). Announce a nightly **19:00–21:00 "שעת שיא"** with a reward multiplier — it multiplies λ with zero netcode work |
| **Queue-while-you-browse** | **DO — cheap** | Shift from passive to active waiting by letting the user keep interacting ([LogRocket](https://blog.logrocket.com/ux-design/ui-patterns-for-async-workflows-background-jobs-and-data-pipelines/)). Let the gathering window run while the player is in `#cards`/`#hero-picker`, with a persistent bottom strip |
| **Per-mode MMR / skill bands** | **DON'T** | We have neither the population nor a rating. `research-trophies/05 §4` already concluded skill-matchmaking is impossible at this scale |
| **Parallel per-mode queues** | **DON'T** | This is the λ/M term. Goal brawl's separate `publicRoomBrawl` pool is already this mistake, at M=2 |

### 5.4 THE DECISION — how many modes live at once

**Two public matchmade modes. One permanent, one rotating. Everything else is not a queue.**

```
PUBLIC POOL  (consumes the shared human population — keep at 2)
  ├─ ⚽ משחק מהיר   2v2, first-to-3, 120s      PERMANENT. Always the default, biggest button.
  └─ ⭐ מצב היום    ROTATING SLOT, flips daily 17:00 Asia/Jerusalem
        pool: [ קרב על השער (timed 2min) · 3v3 מגרש ארוך · LTM slot for new minigames ]

NOT A QUEUE  (4 humans arrive together or none needed — unlimited, costs nothing)
  ├─ 👥 משחק עם חברים  party/private, room code — ALL modes selectable here, always
  ├─ ⚔️  אתגר חבר       direct challenge
  ├─ 🎯 אימון           solo
  └─ 🛠️  בונה מגרשים    solo playtest
```

Rationale, in one line each:
- **1 permanent** because λ must not be divided at all for the mode that has to work.
- **+1 rotating** because it costs the same population as a second permanent mode but buys a daily
  return reason and an LTM test-bed, and can be *retired without deleting a button*.
- **3v3 goes in the rotating slot, not as a third permanent card.** It needs 6 humans, which at our λ is
  ~0 — as a permanent queue it would be a bot-only room with a bigger pitch. In the rotating slot plus
  the party picker it gets played by groups, which is who it's actually for. (`mode-3v3.md` should note
  this: 3v3 is a *party-first* mode.)
- **Everything private is unlimited** because a 4-person party brings its own population.

### 5.5 The rotation contract (write this down before shipping any mode)

- **Slot flips daily at 17:00 Asia/Jerusalem.** Pool of 3-4 candidates ⇒ each returns every 3-4 days.
  Not weekly (too slow to learn), not hourly (illegible).
- **New minigames enter as a 3-day LTM**, badged `חדש`. Promotion criterion fixed in advance: it
  survives if it beats the pool median on *matches started per active player* over its window
  (Rocket League's "winner stays"). Otherwise it drops out silently — no announcement, no dead card.
- **Only ONE `בקרוב` card allowed in the whole UI, ever.** Today there are 8 across `#arena`, `#party`,
  `#game-select` and the hub strip. On a roster this small, locked cards read as an abandoned game, not
  a roadmap. Delete them; the rotating slot *is* the roadmap.
- **Fix the picker disagreement**: goal brawl is playable from the hub strip and locked in `#arena` and
  `#party`. One source of truth — the server's resolved slot config, sent in the hello/roomJoined
  payload, not baked into HTML. → `lobby-picker`.

---

## 6. The meta layer — sized honestly

`summery/research-trophies/01..05` already decided the ladder (**global continuous trophies + tier
floors, no hard season reset, XP stays untouched as the monotonic second track**). This section only
covers meta that touches the *mode roster*, and aligns with those conclusions.

### 6.1 Global trophies, never per-mode

Rocket League runs separate MMR per playlist because it can afford a healthy population in each.
We cannot; `research-trophies/02` reached the same conclusion for divisions
(*"segmenting players into discrete divisions ... risks emptying divisions and forcing bot-only
promotion grinds"*).

> **→ for Saltiz:** **one global trophy number across all public modes.** No per-mode rating, no
> per-mode leaderboard, no per-mode rank badge. The rotating slot pays the same trophies as the
> permanent mode (subject to the existing bot discount) — otherwise the rotation itself becomes a
> reward-efficiency puzzle and players will refuse to try new modes.

### 6.2 Gating — invert Brawl Stars

Brawl Stars gates because it has 20 modes and 60+ brawlers to reveal over months. We have 2 public modes
and hundreds of users. Every gate we add subtracts from λ.

> **→ for Saltiz:** **gate nothing behind level.** The only gate: the first 2 matches show *only*
> משחק מהיר (choice-paralysis control), then the full rail. Delete the concept of locked modes.
> If we ever add a ranked layer, gate *that* (Brawl Stars' one real gate is Ranked at 1,000 trophies) —
> not content.

### 6.3 Daily quests — yes, 3, and mode-agnostic

Daily/weekly touchpoints are the classic low-cost retention lever: *"daily login rewards, weekly
challenges, and rotating free content require minimal development effort but have an outsized effect on
D7 retention"* ([LiveOps playbook](https://gamegrowthadvisor.com/blog/2026-03-31-liveops-strategy-mobile-games-guide/)).
But there is a trap specific to us: **a quest that names a mode fragments the pool.**

> **→ for Saltiz:** 3 daily quests, resetting at the same 17:00 flip. **Hard rule: a quest may only
> name a mode if that mode is the current rotating slot** (in which case it's a *concentrator*, which is
> what we want). Everything else is mode-agnostic: "כבוש 5 שערים", "נצח 2 משחקים", "שחק עם חבר".
> Add one quest that only completes with a human opponent — it's the cheapest lever on λ we have.
> Reuse the existing `#shop-daily-timer` midnight countdown component, re-pointed at 17:00.

### 6.4 Seasons — a label, not a reset

`research-trophies/05 §4` is unambiguous: hard resets at hundreds of users risk an empty top-of-ladder
for weeks. Season lengths in the wild are ~1 month (mobile) to ~3 months (AAA), but those are population
statements, not calendar ones.

> **→ for Saltiz:** keep `עונה 1` as a **content label** on the rotating slot + news screen (a monthly
> theme: which modes are in the pool, which field skins, which quest set). **No ladder reset in v1.**
> When population justifies it, soft compression toward the median, per `research-trophies/05`.

### 6.5 Rewards & currency

The shop is a stub with a hardcoded `0 🪙 / 0 💎` wallet and 16+ `soon-pill`s.

> **→ for Saltiz:** either ship **exactly one** currency (מטבעות) earned from matches and quests and
> spendable on card packs / hero skins — reusing the existing rarity + album systems rather than a new
> economy — **or delete the wallet chips and the shop tab entirely** until it's real. A visible `0/0`
> wallet is worse than no shop. **Never two currencies** at this scale.

### 6.6 What NOT to build

| Don't build | Why |
|---|---|
| **Clubs** (currently a stub tab) | Needs population density we don't have. An empty club list is a stronger negative signal than a missing tab. **Delete the tab**, revisit at 4-figure DAU |
| **Tournaments** | Same. Needs N simultaneous humans at a scheduled instant — the hardest thing on this list |
| **Per-mode leaderboards / per-mode MMR / per-mode trophies** | §6.1. Multiplies fragmentation by content |
| **Casual vs competitive split** | §4. 2× population split for zero content |
| **A second currency / battle pass** | §6.5 |
| **Hard season resets** | `research-trophies/05 §4` |
| **Player-count indicators in the picker** | §2. Rocket League removed theirs |
| **More `בקרוב` cards** | §5.5 |
| **A third permanent public queue** | §5.4. This is the decision this doc exists to make |

---

## 7. Build order (what this implies for the other four specs)

1. **Persistent lobby / auto-rematch** (`modes-polish`) — biggest λ multiplier, smallest change.
2. **Adaptive gathering window** 5s→~30s when <2 humans, with skip button (`modes-polish` + `server.js:71`).
3. **`MODE_DEFS` data table** replacing the five bespoke `start*()` paths (`server.js:302-461`) —
   prerequisite for everything else. Also removes the `teamSlots = {A:[0,1],B:[0,1]}` hardcode that
   blocks 3v3 (`server.js:556`, `1019`).
4. **Slot config + single source of truth for the picker** (`lobby-picker`) — kill the 8 dead cards,
   fix the goal-brawl disagreement, merge `publicRoomBrawl` into the slot system.
5. **3v3 as a party-first / rotating-slot mode** (`mode-3v3`), not a permanent queue.
6. **New minigames as 3-day LTMs** in the rotating slot (`new-minigames`).
7. Meta: 3 daily quests → one currency → season *label*. In that order. Trophies per `research-trophies`.

---

## Sources

- [Brawl Stars release notes, Sept 2025 — permanent vs rotating slots](https://supercell.com/en/games/brawlstars/blog/release-notes/release-notes-september-2025/)
- [Brawlify — map/mode rotation](https://brawlify.com/maps) · [Brawl Time — event rotation](https://brawltime.com/events)
- [Brawl Stars Wiki — Trophies](https://brawlstars.fandom.com/wiki/Trophies) · [MobileMatters — Trophy Road explained](https://mobilematters.gg/guides/brawl-stars/trophy-road-explained)
- [Prima Games — how to unlock new modes](https://primagames.com/tips/how-unlock-new-modes-brawl-stars) · [Sportskeeda — Ranked details](https://www.sportskeeda.com/esports/all-brawl-stars-ranked-mode-details)
- [Fortnite Wiki — Limited Time Modes](https://fortnite.fandom.com/wiki/Limited_Time_Modes) · [Pro Game Guides — LTM list](https://progameguides.com/fortnite/fortnite-ltm-list-guide/) · [PC Gamer — best and worst LTMs](https://www.pcgamer.com/the-best-and-worst-fortnite-limited-time-modes/)
- [Fortnite Wiki — Discover](https://fortnite.fandom.com/wiki/Discover)
- [Roblox Wiki — Epic Minigames](https://roblox.fandom.com/wiki/Player:TypicalType/Epic_Minigames) · [NamuWiki — Epic Minigames](https://en.namu.wiki/w/Epic%20Minigames)
- [Roblox devforum — matchmaking failing to fill servers](https://devforum.roblox.com/t/roblox-will-sometimes-fail-matchmaking-sending-every-single-new-player-into-their-own-server-only-filling-servers-up-to-1-player/3981356) · [devforum — empty servers despite fill setting](https://devforum.roblox.com/t/empty-servers-despite-the-option-for-roblox-to-fill-them-as-much-as-possible-toggled/1862917) · [Roblox matchmaking systems — widening skill band](https://simplified.media/guides/roblox-matchmaking)
- [Rocket League — First Look: Play Menu Changes](https://www.rocketleague.com/news/first-look-play-menu-changes-coming-to-rocket-league) · [Dueling Arcade Playlists](https://www.rocketleague.com/news/keep-a-favorite-extra-mode-in-rotation-with-rocket-leagues-dueling-arcade-playlists) · [Patch Notes v2.26 — population indicator removed](https://www.rocketleague.com/en/news/patch-notes-v2-26) · [Forbes — kill Solo Standard?](https://www.forbes.com/sites/maxthielmeyer/2020/01/23/is-it-time-for-psyonix-to-kill-rocket-leagues-solo-standard-playlist/)
- [askagamedev — why matchmaking queues take long / pool fragmentation](https://www.tumblr.com/askagamedev/655342898820349952/why-in-some-cases-in-multiplayer-games-queue-in)
- [Apex Legends — Matchmaking Update 2024 (Continuous Window Matchmaking)](https://www.ea.com/en/games/apex-legends/apex-legends/news/matchmaking-update-0924) · [Blizzard — Meet Your Matchmaker](https://overwatch.blizzard.com/en-us/news/24224365/weekly-recall-meet-your-matchmaker/)
- [KitGuru — Battlefield 6 AI bot backfill](https://www.kitguru.net/gaming/mustafa-mahmoud/battlefield-6-will-use-ai-bots-to-backfill-lobbies-when-necessary/) · [EA forums — bots never replaced by joining humans](https://forums.ea.com/idea/battlefield-6-bug-reports-en/day-two-asking-to-fix-the-bot-backfill-that-are-never-replace/13229469) · [itch.io devlog — indie bot fill](https://itch.io/devlog/623308/version-005-update-bots-added.amp) · [NerdBurglars — why games fill lobbies with bots](https://nerdburglars.net/why-games-fill-lobbies-with-bots-and-how-to-avoid-them/)
- [Descent community — scheduled play windows keep small communities playable](https://descent.us/descent-multiplayer-in-2026-active-modes-community-servers-and-how-to-join-games)
- [LogRocket — UI patterns for async/background work ("active waiting")](https://blog.logrocket.com/ux-design/ui-patterns-for-async-workflows-background-jobs-and-data-pipelines/)
- [Game Growth Advisor — LiveOps strategy playbook (cadence, daily/weekly touchpoints)](https://gamegrowthadvisor.com/blog/2026-03-31-liveops-strategy-mobile-games-guide/) · [Galaxy4Games — building daily challenges and live events](https://galaxy4games.com/en/knowledgebase/blog/how-do-we-build-daily-challenges-or-live-events-into-games)
- Internal: `summery/research-trophies/01-brawl-stars.md`, `02-other-games.md`, `03-skill-progression.md`, `04-economy-bots-math.md`, `05-psychology-migration-fit.md`
