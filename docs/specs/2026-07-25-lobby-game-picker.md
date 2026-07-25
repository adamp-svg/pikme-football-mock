# Lobby + Game-Picker Redesign

> Spec — design only, nothing implemented. Agent `lobby-picker`, 2026-07-25.
> Sibling specs from the same pass: `2026-07-25-3v3-mode.md`, `-mode-polish.md`,
> `-new-minigames.md`, `-mode-roster-research.md`.
> Scope: `#home` (the hub) and `#arena` (the picker). Everything below is verified
> against the code as of `7906647` on `main`.

---

## 0. TL;DR

The game has **five** places where you choose what to play, **three of them lie**, and the
only genuinely new mode you shipped (`קרב על השער`) is simultaneously **live in one of them
and «בקרוב» in three others**. The fix is not a prettier picker — it is *one* picker, driven
by *one* data structure, with the hub reduced to a single Play control that remembers what
you last played.

Second decision, and the one I'd defend hardest: **do not put per-mode player counts on the
tiles.** Roblox A/B-tested exactly this and removed counts from its home tiles because they
suppress discovery of less-popular content (+6.79% unique-experience discovery after removal
— [devforum](https://devforum.roblox.com/t/player-count-changes-on-experience-tiles/2914339)).
With `MAX_PLAYERS = 4` and a handful of concurrent users, "3 משחקים" is a churn button. Sell
**time-to-match** (which bot backfill lets you actually promise) instead of population.

---

## 1. Audit — what exists today

### 1.1 The five surfaces

| # | Surface | File / lines | Contents | Truthful? |
|---|---|---|---|---|
| 1 | `#play-strip` mode rail | `index.html:102-129` | arena-link · play-friends · training · builder · tournament(dead) · **goal-brawl (live)** | partly |
| 2 | `#quick-match-btn` | `index.html:81-85` | 2v2 first-to-3 | yes |
| 3 | `#arena` «בחר מגרש» | `index.html:232-261` | 2v2 live + 3v3/tournament/**goal-brawl** locked | **no** |
| 4 | `#party .party-games` | `index.html:500-517` | 2v2 + tournament/**goal-brawl** locked | **no** |
| 5 | `#game-select` modal | `index.html:560-582` | 2v2 + tournament/**goal-brawl** locked | **no** |
| (+) | `#train-choose` modal | `index.html:715-724` | training-ground vs vs-bots | yes |

Four hand-written copies of the same list. They have already drifted.

### 1.2 Named problems

**P1 — goal-brawl is live and labelled «בקרוב» in three places.**
`server.js:324 goalBrawl()` is real: its own pool (`publicRoomBrawl`), `goalsToWin = 0`
(timed, most goals), wired from `client.js:1969`. But `#arena`, `#party` and `#game-select`
all render it as `div.modecard.lock` with `cursor:not-allowed` and no handler. A player who
opens the picker is told the newest mode does not exist. This is a correctness bug, not taste.

**P2 — the picker's title is wrong.** `#arena` is headed «בחר מגרש» (choose a *pitch*) and
contains zero pitch choices. The hub button that opens it promises «אצטדיון הבלוקים · **החלף
מגרש**» (`index.html:105`) — it does not swap the pitch. Real pitch selection lives elsewhere
entirely, in the builder's `#field-picker` (`index.html:197`).

**P3 — the picker's only live row duplicates the button above it, worse.**
`#arena-2v2-btn` → `sendMsg({type:'quickMatch'})` (`client.js:1968`). `#quick-match-btn` →
`sendMsg({type:'quickMatch', diffLevel: xpDiffLevel()})` (`client.js:1990`). Same action, but
**the arena path omits `diffLevel`**, so bots do not scale to the player's XP
(`server.js:312`). Entering 2v2 through the picker silently gives you a different (default-level)
opponent than entering it through the gold button.

**P4 — three dead ends.** 3v3 / tournament / goal-brawl-as-locked are `<div>`s with no
listener. Tapping does *nothing at all* — no toast, no teaser, no date, no unlock condition.
Research is unambiguous here: a visible lock with a **legible condition** ("unlocks at 150
trophies") is a goal and drives motivation (goal-gradient /
[milestone unlocks](https://yukaichou.com/advanced-gamification/the-power-of-milestone-unlocks-in-gamification-design/));
"בקרוב" with no date is **not** a goal — the player cannot act on it, and it decays into a
broken promise. Three of four tiles being dead means the picker mostly advertises what the
game isn't.

**P5 — the rail mixes four different semantics at one visual weight.** In `#play-strip`:
a *navigation link* (arena), a *multi-step flow* (friends), a *modal opener* (training), a
*tool screen* (builder), a *dead pill* (tournament), and a *live match launcher* (goal-brawl).
Nothing distinguishes them, and the match launcher is **last**.

**P6 — the rail's overflow is invisible and gets reset.** `#play-strip` is 685 logical px
(`style.css:1781`) holding six items, `overflow-x:auto`, scrollbar suppressed
(`style.css:1789`), no gradient/peek/arrow affordance. And `showScreen('home')` sets
`strip.scrollLeft = 0` on **every** return home (`client.js:686`). So after every match you
are put back at the start and must re-discover goal-brawl by blind swiping. Effective
discoverability of the newest mode ≈ 0.

**P7 — no signal of whether anything is populated.** One global number, `«N מחוברים»`, in
9px type at stage (757, 60) (`style.css:1723`). It is global, not per-mode, and it cannot
tell you whether picking a mode means a real match or three bots. The server already knows
the answer per pool (`publicRoom` / `publicRoomBrawl` sizes) and never sends it.

**P8 — no mode metadata.** Every card is `name + one flavour line`. The *only* difference
between the two live modes is the win condition (first-to-3 + 2-min cap vs pure 2-min timed —
`shared/constants.js:57-58`), and the picker never states it. `#arena`'s 2v2 card says
«הקלאסי · אצטדיון הבלוקים», which is atmosphere, not information. Players (2v2), length
(2 min), win condition, and whether it counts for rank are all missing everywhere.

**P9 — zero memory.** No last-played, no re-queue, no "again". `toHome` (`client.js:2746`)
drops you on the hub with the rail reset. Rocket League's Play menu and Fortnite's Homebar
both default to your last selection; you default to nothing.

**P10 — three different back models, one of them invisible.** `#builder` uses
`[data-home-back]` (`client.js:1931`). `#lobby` has `#lobby-leave` («‹ יציאה»). `#arena`,
`#news`, `#shop`, `#clubs`, `#party`, `#friend-select` have **no back button at all** — you
escape by tapping "empty structural whitespace", and `isDismissBackdrop` only accepts
`.subpage, .subpage-body, .subpage-head, h2` (`client.js:1953`). On a full-bleed page whose
body is a list of cards, that target can be a sliver. A `.subpage-back` class exists and is
fully styled (`style.css:1033`) — the picker just doesn't use it. Glyph direction is also
inconsistent: `#game-select-close` uses `›`, `#lobby-leave` uses `‹`.

**P11 — the party game pick is theatre.** `selectedGame` is captured at `client.js:2567` /
`2673` and **never transmitted**. `server.js` has no per-room mode concept beyond
`room.goalsToWin`. A party "choosing" a game always plays standard 2v2.

**P12 — the locked cards have no ordering rule**, so as the roster grows (the 3v3 spec plus
10–14 minigame concepts from `-new-minigames.md`) the picker degrades into a grey wall.

**P13 — solo/creation tools sit inside the competitive rail**, and `#training-btn` opens a
*fifth* picker (`#train-choose`) with two more choices.

---

## 2. Research — what the good ones actually do

Sourcing note: several primary pages are fetch-blocked (rocketleague.com 403, Fortnite
Fandom 402, brawlify 403); items below marked ⚠️ are single-source and should be eyeballed
against a screenshot before being quoted outward.

### Brawl Stars — slots, not a grid
- The Events screen is a **vertical list of persistent numbered slots**; the *slot* is the
  stable unit and its *contents* rotate on a timer. Featured slot cycles every 2 h across six
  modes; two daily slots never change. ⚠️ ([brawlify.com/events](https://brawlify.com/events))
- Card = mode icon + mode name + map name + **map thumbnail** + **countdown to rotation**
  (+ modifier/reward badge on special slots).
- **One big yellow Play button dominates the home screen** — "big and bold in bright yellow…
  easily complete the most important interaction of the game"
  ([Pratt design critique](https://ixd.prattsi.org/2025/02/design-critique-brawl-stars/)).
- Locked modes stay **visible in the list with their unlock threshold shown** (Brawl Ball @30
  trophies, Gem Grab @150). ⚠️
- Same critique flags the cost of the bespoke-artwork-per-event approach: the home page gets
  "increasingly cluttered and complicated" for new players.
- A separate blocking matchmaking screen with a disabled exit button is criticised; the
  recommendation is an **overlay queue** you can browse behind
  ([Sullivan](https://medium.com/@matt.sullivan28/a-brief-look-brawl-stars-ux-ui-562f6225b7e3)).

### Fortnite — bounded rows, and one tile per mode
- Discover's top element is the **Homebar**: your currently selected experience, defaulting
  to the **last played island**
  ([Epic docs](https://dev.epicgames.com/documentation/fortnite/exploring-discover-in-fortnite-creative)).
- v32.00 changed Discover sections **from horizontally-scrolling lists to bounded 6-tile
  rows** ⚠️ — Epic moved *away* from infinite horizontal scroll.
- v24.10 **added concurrent player counts per gamemode** — Fortnite shows the number because
  the number is a flex (hundreds of thousands).
- **Sub-modes for BR / Reload / Blitz / OG were merged into a single tile each** ⚠️ —
  Solo/Duos/Squads are a choice *inside* the mode, not four sibling tiles.

### Roblox — the finding that decides our player-count question
- **8 Apr 2024: concurrent player count removed from the large home-page experience tiles.**
  Kept only on detail pages and on the small tiles in **Continue** and **Favorites**.
- Stated rationale, verbatim: *"displaying player counts on experience tiles discourages
  users from trying new or less-popular experiences, favoring only the popular ones."*
- Published A/B result: **+6.79%** users discovering unique experiences; **+8.24%** engagement
  from recommendations; "significant increase in engagement for new and emerging experiences."
- What replaced the number on the tile: bigger thumbnail, **Friend Presence**, and
  **Experience Rating** — *social proof and quality instead of raw volume*.
  ([devforum](https://devforum.roblox.com/t/player-count-changes-on-experience-tiles/2914339))

### Rocket League — closest analog (≈6 modes, mid-size playerbase)
- The Play-menu overhaul (v2.34) collapsed everything into **four cards**: Casual,
  Competitive, Play Offline, Private Match
  ([insider-gaming](https://insider-gaming.com/rocket-league-updating-play-menu-adding-arcade-playlists/)).
- **"Extra Modes" was deleted as a top-level destination** and folded into Competitive —
  direct evidence against building a modes-ghetto submenu.
- **Multi-select queueing: up to six competitive playlists at once.** The canonical
  small-playerbase fix — it turns "each mode has 3 players" into "the game has 12".
- **Rotating Arcade slots** in Casual: whichever of Dropshot/Snow Day is *not* in the
  competitive rotation lives there instead — a mode is never absent, it changes lane.
- Offline was promoted to a **peer card**, not a consolation.
- Could **not** confirm any live population or ETA display on the playlist rows.

### Small-playerbase practice
- **Bot backfill is the standard mitigation** — fill the slots so the match starts rather than
  surfacing the shortfall ([Open Match](https://open-match.dev/site/docs/guides/backfill/),
  [GameLift FlexMatch](https://docs.aws.amazon.com/gameliftservers/latest/apireference/API_MatchmakingConfiguration.html)).
  Battlefield's reception is the caution: players dislike bots *and* dislike empty servers, so
  bots must be **unremarked upon**, never labelled.
- **Relax matchmaking silently over time** rather than showing a queue — FlexMatch widens
  criteria past a threshold; CoD widens skill spread after ~60 s
  ([CoD matchmaking post](https://www.callofduty.com/blog/2024/01/call-of-duty-update-an-Inside-look-at-matchmaking)).
- Indie guidance: ship a bot mode; "make the game engaging with only one player, basically a
  single-player game where other people can join"
  ([Game Developer](https://www.gamedeveloper.com/design/what-i-ve-learned-about-designing-multiplayer-games-so-far)).
- Locked content: a **visible lock with a real condition** is a goal (goal-gradient effect);
  a dateless "coming soon" is not. Gating behind grind when the real reason is "it isn't
  built" is decoded instantly by players.

### Do NOT cargo-cult
1. **Per-mode live player counts** — Fortnite shows them because the number flatters. Roblox
   measured the harm and removed them. *We are the less-popular content.*
2. **A Discover/Browse screen with rails** (Continue / Trending / For You) — that solves a
   *catalogue* problem of millions of items. Over four modes it reads as an empty store.
3. **Search, filters, favourites, library** — same reason.
4. **Three dateless "בקרוב" tiles** — the current state; the single worst thing on the screen.
5. **A separate "Extra Modes" submenu** — Rocket League deliberately deleted theirs.
6. **Bespoke artwork per event** — even Supercell pays for it in clutter.
7. **Estimated queue time** — for us it is either a lie or a discouragement.
8. **Trophy-Road-scale gating** — no grind curve exists to hang it on.
9. **Tabs over four items.**
10. **Team-size variants as sibling tiles** — see §3.3; this constrains the 3v3 spec.

---

## 3. The redesign — one canonical surface

### 3.0 The five principles

1. **One list, one renderer.** A single `MODES` array in `client.js` feeds the hub, the play
   sheet, the party picker and the lobby game-select. Delete all four hand-written copies.
2. **One play control on the hub.** A big gold `שחק` that launches the **selected** mode, and
   a small chip above it that names the selection and opens the sheet. (Brawl's yellow Play +
   the event card sitting above it; Fortnite's Homebar defaulting to last played.)
3. **Sell time-to-match, never population.** Bots start you in ≤5 s — that's a real promise.
   Counts are the one thing a tiny game must not print.
4. **Every locked tile is tappable and says a true thing.** Either a real condition, or a
   dated teaser with one action. Never a silent `not-allowed` div.
5. **Bounded, no scroll.** The whole roster fits one landscape screen. When it stops fitting,
   collapse the in-dev tail into one strip — do not add scroll or tabs.

### 3.1 Entry flow

```
#home ──[gold שחק]────────────────────────────► launches selectedMode (queue overlay)
      ──[mode chip 🔁]──► #arena (play sheet) ──[שחק]──► launches, returns to #home
                                              ──[👥 עם חברים]──► #friend-select → #party
      ──[🎯 אימון]────► #train-choose (unchanged)
      ──[🏗️ בונה מגרש]► #builder (unchanged)
```

The hub has **one** competitive entry point. Training and the builder stay on the hub as
peers (Rocket League promoted Offline to a peer card — same instinct) but they are visually a
separate *utility* rail, not mode tiles.

### 3.2 Mode card anatomy

Five fields, in this order, RTL:

```
[icon 40]  שם המצב                                    [status pill]
           2 נגד 2 · עד 2 דק' · ראשון ל-3          ← format facts (the differentiator)
           🟢 מתמלא עכשיו · 2 שחקנים                ← activity line (conditional, see 3.4)
                                                       XP ×1 · נספר לדירוג   ← reward line
```

- **icon** — emoji now; a pixel sprite later. One template for all modes (no bespoke art).
- **name** — the mode, not the pitch.
- **format facts** — `players · duration · win condition`. Non-negotiable: it is the only
  thing that lets a player choose between quick match and goal-brawl today.
- **status pill** — exactly one of: `חדש` (first 7 days live) · `★ מצב השבוע` (featured) ·
  `נפתח ברמה N` (XP-gated) · `בפיתוח · עונה 1` (in development). Live-and-ordinary gets none.
- **reward line** — XP multiplier + whether it counts for rank. Training must say
  `לא נספר לדירוג` so it reads as practice, not a lesser match.

### 3.3 Team-size variants are NOT separate tiles

Fortnite merged Solo/Duos/Squads into one tile per mode ⚠️. Apply it: when 3v3 lands it is a
**segmented control inside the כדורגל card** (`2v2 | 3v3`), not a fifth tile. This keeps the
roster at ~4 tiles indefinitely and it means the 3v3 work needs a per-room team-size
parameter anyway. **Flagged for the `mode-3v3` spec.**

### 3.4 "Live now" — the decision

**Do not print a per-mode player count. Ever.** Instead, a three-state signal derived from
data the server already has:

| State | Condition (server) | Shown |
|---|---|---|
| 🟢 forming | `pool.members.size > 0 && pool.phase !== 'match'` | `מתמלא עכשיו · 2 שחקנים` |
| 🟡 instant | pool empty | `מתחיל מיד` |
| — | (never) | any number below 10 |

Rationale:
- 🟢 is **presence, not volume** — the Roblox substitution. It is only ever shown when the
  number is *good news* (someone is waiting for you right now), so it can never discourage.
  It is also the single most actionable thing you can tell a player.
- 🟡 is the honest framing of a small playerbase: **the promise is time-to-match, not
  population**, and bot backfill makes it true. Note what it does *not* say — per the
  Battlefield lesson, never write "בוטים ימלאו"; bots are unremarked upon.
- The global `N מחוברים` count stays, once, in the sheet header, and **only renders at N ≥ 10**
  (below that, hide it — an accurate small number is worse than no number). It is already in
  the hub corner; leave it there too.

### 3.5 Locked / coming-soon without dead-ending

Rules:
- **Always tappable.** Tap fills the preview panel with the teaser — what the mode is, plus
  its format facts, so the player learns something.
- **Exactly one action, always.**
  - in development → `עדכנו אותי` — writes `localStorage['pikme-mode-notify']`, and when the
    mode flips to live the hub chip carries a `חדש` dot until opened. Zero backend.
  - XP-gated → `שחק משחק מהיר כדי להתקדם` — closes the sheet with `quick` selected. A gate
    only if a real one exists; **never invent grind to disguise "not built"**.
- **Ordering is fixed, never interleaved**: (1) featured, (2) live sorted by last-played,
  (3) XP-gated nearest-unlock-first, (4) in development.
- **Cap the in-dev tail at 2 tiles.** The rest collapse into one `עוד בדרך ›` strip that opens
  `#news` (which already has the roadmap feed, `index.html:281-282`). One dead element, not
  three.

### 3.6 Featured / rotating slot

Build the **slot**, not the rotation. A `featured: true` flag on one `MODES` entry promotes it
to the top and gives it a `★ מצב השבוע` pill and (later) an XP bonus. Flipping it is a
one-line config edit.

**Do not build rotation logic in v1.** Brawl's 2-hour featured cycle works because the content
genuinely changes across six modes; a rotator over two live modes is theatre, and a countdown
next to a static lineup is a lie. Revisit when live modes ≥ 4.

### 3.7 Where friends / party / training / builder live

- **Party is a modifier of the pick, not a mode.** The play sheet's preview panel gets a
  secondary `👥 שחק עם חברים` button under the primary `שחק`: same mode, private room. It
  reuses `openFriendSelect()` and carries `selectedModeId` through, so the party picker
  (§P11) can finally mean something once the server takes a per-room mode.
- The hub keeps `👥 שחק עם חברים` in the utility rail as a shortcut (social action, and it
  sits near `#friends-btn`) — but it now sets no mode; the mode is whatever is selected.
- **Training + builder stay on the hub** as a visually distinct utility rail. They are peers,
  not lesser (Rocket League's Offline card), but they are not competitive tiles.
- `#train-choose` stays as-is for now. Folding its two options into `MODES` as
  `group:'practice'` entries is optional cleanup, not required.

### 3.8 Queue behaviour

Keep the existing overlay approach (`quickVs` shows the VS overlay *over* `#home`,
`client.js:2742`) — that is already the pattern Brawl Stars gets criticised for lacking. Add
one thing: **a visible cancel** on the overlay. Do not add an ETA (§2, do-not-copy #7).

### 3.9 Back / nav model

One rule, applied everywhere: **every full-screen sub-page has a visible back control in
`.subpage-head`, at the RIGHT (the RTL start edge), glyph `›`.** Backdrop-dismiss stays as a
bonus. `.subpage-back` already exists and is styled (`style.css:1033`) — it is simply unused
on these pages.

Add a two-function nav stack so hardware/host back can share it, without touching
`showScreen`'s signature (every existing caller keeps working):

```js
let curScreen = 'home'; const navStack = [];
function openScreen(n) { navStack.push(curScreen); showScreen(n); }   // for [data-open-screen]
function goBack() { showScreen(navStack.pop() || 'home'); }           // for [data-back] + host back
```

---

## 4. Wireframes — landscape mobile, RTL, 900×415 logical stage

The hub is authored on a fixed 900×415 stage scaled by `fitHub()` (`client.js:1900`), with
every control absolutely positioned in `style.css`'s **BAKED LOBBY LAYOUT** section
(1693-1814). Coordinates below are logical stage px. RTL: the *start* edge is the RIGHT.

### 4.1 `#home` — after

```
 x=0                                                                              x=900
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ [pfp]     [copies][worth][cards]   ▓▓▓▓▓▓▓░░░░ XP ▓▓▓▓▓            עונה 1      [⚙]  │ y=10
│  שחקן          [🏅 collector]                                     🔵 24 מחוברים      │ y=60
│                                                                                       │
│ [🛒]                                        ┌───────┐              [👥•]              │ y=110
│              ╔══════════════╗    ┌────┐     │       │                                 │
│ [📰]         ║   CARDS      ║    │pwr2│     │ HERO  │              [🏰]              │ y=175
│              ║   carousel   ║    ├────┤     │       │                                 │
│ [🏅]         ║   (front     ║    │pwr0│     │       │      ┌───────────────────┐      │ y=240
│              ║    card big) ║    ├────┤     │  🥉2  │      │ 🔁 קרב על השער   │ ◄──── mode chip
│              ╚══════════════╝    │pwr1│     └───────┘      └───────────────────┘      │ y=246
│                                  └────┘                    ╔═══════════════════╗      │
│  ┌──────────┬──────────┬──────────────┐                    ║       ▶  שחק      ║ ◄──── gold PLAY
│  │🎯 אימון  │🏗️ בונה   │👥 עם חברים   │                    ║  2 דק' · הכי גולים ║      │ y=290
│  └──────────┴──────────┴──────────────┘                    ╚═══════════════════╝      │
│   utility rail (3 items, NO scroll)  x=12..420                       x=720..852        │ y=394
└──────────────────────────────────────────────────────────────────────────────────────┘
```

Changes vs today: the mode chip replaces `#select-best-btn` at (720, 246); `#select-best-btn`
moves down beside the power-slot column (it is a loadout action and belongs there); the rail
drops from six mixed items to three utilities and no longer scrolls; the gold button's
sub-label now reflects the **selected** mode.

Right thumb owns PLAY and the chip; left thumb owns the utility rail. Both bottom corners,
which is correct for landscape.

### 4.2 `#arena` — the play sheet (list right, preview left)

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│                                                     מה משחקים?    🔵 24 מחוברים  [›] │  ‹ back at RTL start
├───────────────────────────────────────────┬──────────────────────────────────────────┤
│  PREVIEW (left · commit)                  │  MODE LIST (right · browse, scrolls)     │
│                                           │  ┌────────────────────────────────────┐  │
│         ⚽                                │  │ ⚽  כדורגל · 2 נגד 2   ★ מצב השבוע │  │ ← selected
│    כדורגל · 2 נגד 2                       │  │     2v2 · עד 2 דק' · ראשון ל-3     │  │   (gold border)
│                                           │  │     🟢 מתמלא עכשיו · 2 שחקנים      │  │
│    ראשון ל-3 גולים, ועד 2 דקות.           │  └────────────────────────────────────┘  │
│    מקומות פנויים מתמלאים אוטומטית.        │  ┌────────────────────────────────────┐  │
│                                           │  │ 🥅  קרב על השער            חדש     │  │
│    XP ×1  ·  נספר לדירוג                  │  │     2v2 · 2 דק' · הכי הרבה גולים   │  │
│                                           │  │     🟡 מתחיל מיד                   │  │
│    ╔═══════════════════════════╗          │  └────────────────────────────────────┘  │
│    ║        ▶   שחק            ║          │  ┌────────────────────────────────────┐  │
│    ╚═══════════════════════════╝          │  │ ⚽  כדורגל · 3 נגד 3  בפיתוח·עונה1 │  │ ← tappable
│    ┌───────────────────────────┐          │  │     3v3 · מגרש ארוך · ראשון ל-5    │  │
│    │   👥  שחק עם חברים        │          │  └────────────────────────────────────┘  │
│    └───────────────────────────┘          │  ┌────────────────────────────────────┐  │
│                                           │  │ 🏆  טורניר            בפיתוח        │  │
│                                           │  └────────────────────────────────────┘  │
│                                           │   עוד מצבים בדרך ›   (→ #news)           │
└───────────────────────────────────────────┴──────────────────────────────────────────┘
```

Browse with the right thumb, commit with the left. Selecting a row swaps the preview and
persists `selectedModeId`; it does **not** launch. `שחק` launches and returns to `#home`
with the queue overlay.

### 4.3 A locked tile, selected

```
│  PREVIEW                                  │  ┌────────────────────────────────────┐  │
│         ⚽                                │  │ ⚽  כדורגל · 3 נגד 3  בפיתוח·עונה1 │◄─┤ selected
│    כדורגל · 3 נגד 3                       │  │     3v3 · מגרש ארוך · ראשון ל-5    │  │
│    מגרש ארוך יותר, 6 שחקנים,              │  └────────────────────────────────────┘  │
│    יותר מקום לרוץ ולבנות.                 │                                          │
│                                           │   ← teaser is real content, not a blank  │
│    🔒 בפיתוח · מתוכנן לעונה 1              │                                          │
│    ┌───────────────────────────┐          │                                          │
│    │      🔔 עדכנו אותי         │  ← ONE action, always                              │
│    └───────────────────────────┘          │                                          │
```

---

## 5. Implementation plan — against the real files

### 5.1 `public/client.js` — the data model (new block near line 1907)

The "Lobby-redesign sub-screens" block at `client.js:1907-1933` is already the home of this
wiring; put the new code there.

```js
// ONE source of truth for every mode surface (hub chip, #arena sheet, party, game-select).
const MODES = [
  { id:'quick', ic:'⚽', name:'כדורגל · 2 נגד 2', fmt:'2v2 · עד 2 דק\' · ראשון ל-3',
    desc:'…', xp:1, ranked:true, state:'live', pool:'quick', party:true, featured:true,
    launch:() => sendMsg({ type:'quickMatch', diffLevel: xpDiffLevel() }) },
  { id:'brawl', ic:'🥅', name:'קרב על השער',   fmt:'2v2 · 2 דק\' · הכי הרבה גולים',
    desc:'…', xp:1, ranked:true, state:'live', pool:'brawl', party:true, badge:'new',
    launch:() => sendMsg({ type:'goalBrawl',  diffLevel: xpDiffLevel() }) },
  { id:'3v3', ic:'⚽', name:'כדורגל · 3 נגד 3', fmt:'3v3 · מגרש ארוך', state:'dev', eta:'עונה 1' },
  { id:'cup', ic:'🏆', name:'טורניר',           fmt:'עונתי · סוללת משחקים', state:'dev' },
];
let selectedModeId = localStorage.getItem('pikme-mode') || 'quick';
function selectedMode()          { return MODES.find((m) => m.id === selectedModeId) || MODES[0]; }
function setSelectedMode(id)     { selectedModeId = id; localStorage.setItem('pikme-mode', id); renderPlayBtn(); renderModePreview(); }
function renderModeList(el, opt) { /* live→gated→dev, capped dev tail, activity from modeInfo */ }
function renderModePreview()     { /* left panel + primary/secondary CTA */ }
function renderPlayBtn()         { /* gold button label + #mode-chip label from selectedMode() */ }
let modeInfo = {};               // from the `home` message; drives the 🟢/🟡 line only
```

### 5.2 `public/index.html`

1. **`#arena` (232-261)** — **keep `id="arena"`.** Changing it would break the screen
   registration list (`client.js:1909`), the CSS selector list (`style.css:988`), the
   dismiss list (`client.js:1955`) and `data-open-screen="arena"` in the markup. Change only:
   - `<h2>בחר מגרש</h2>` → `<h2>מה משחקים?</h2>` + add `<button class="subpage-back" data-back>›</button>` + the global-online chip.
   - replace the four hand-written `.modecard`s with
     `<div id="mode-preview" class="mode-preview"></div><div id="mode-list" class="mode-list"></div>`.
2. **`#home`** — add `<button id="mode-chip" class="hub-modechip" data-open-screen="arena">`
   at the `#select-best-btn` slot; leave `#quick-match-btn`'s markup but let `renderPlayBtn()`
   own its `.hub-mtx` text.
3. **`#play-strip` (102-129)** — delete `.hub-arena`, `#tournament-btn`, `#goal-brawl-btn`.
   Keep `#play-friends-btn`, `#training-btn`, `#field-builder-btn`.
4. **`#party .party-games` (500-517)** and **`#game-select` (566-581)** — replace the
   hand-written cards with one empty `<div class="mode-list" data-modes="party">`.
5. Add `<button class="subpage-back" data-back>›</button>` to the heads of `#news`, `#shop`,
   `#clubs`, `#party`, `#friend-select` too (§3.9).

### 5.3 `public/client.js` — the wiring edits

| Line | Today | Change |
|---|---|---|
| 676-691 `showScreen` | `strip.scrollLeft = 0` on home | drop it (no scroller left); add `renderPlayBtn()` |
| 1928-1933 | `[data-open-screen]` / `[data-home-back]` | add the nav stack + a `[data-back]` handler |
| 1968 `#arena-2v2-btn` | `quickMatch` **without `diffLevel`** | **delete** — subsumed by `MODES.quick.launch` |
| 1969 `#goal-brawl-btn` | `goalBrawl` | **delete** — subsumed by `MODES.brawl.launch` |
| 1990 `#quick-match-btn` | hard-coded `quickMatch` | `selectedMode().launch()` |
| 2563-2571 `#game-select` | reads `data-game` | render from `MODES`; keep `selectedGame` until §5.5 lands |
| 2673 party card | `data-partyGame` | same |
| 2735-2736 `home` msg | sets the count only | also `modeInfo = msg.modes || {}` → re-render the activity lines |
| 1953 `isDismissBackdrop` | matches `.subpage/.subpage-body/.subpage-head/h2` | no change needed — `.mode-list`/`.mode-preview` are content and correctly keep the page open |

### 5.4 `public/style.css`

- **New section after `.modecard` (1041-1054)** — keep `.modecard` (other screens use it) and
  add: `.mode-list` (right column, `flex:1`, `overflow-y:auto`), `.mode-row` (icon/text/status
  grid, `direction:rtl`), `.mode-row.sel` (gold border, reuse the `--gold` token),
  `.mode-row.dev` (dimmed **but `cursor:pointer`** — the whole point of §3.5),
  `.mode-stat` (🟢/🟡 dot + label), `.mode-preview` (left column), `.mode-play` (reuse the
  `.hub-mode.quick` gold treatment at 973-984).
- **`#arena .subpage-body`** is currently `flex-direction: column; align-items: center`
  (`style.css:1040`) — override to `row` + `align-items: stretch` + `gap: 14px` for the
  two-column sheet. Scope it to `#arena` so news/shop/clubs are untouched.
- **BAKED LOBBY LAYOUT (1693-1814)** — add `.hub > #mode-chip { left:720px; top:246px;
  width:132px; height:36px; z-index:6 }`; move `.hub > #select-best-btn` to ~`left:420px;
  top:352px`; `#play-strip` may keep its 685px box (three items simply don't overflow) — or
  narrow it to ~420px for balance. Add `#mode-chip` to the anchor selector list at 1703-1717.

### 5.5 `server.js`

**Small (do this first).** `broadcastPresence()` (800-809) already runs at 5 Hz and already
targets exactly the roomless clients who are staring at the hub. Extend its payload:

```js
const poolInfo = (r) => ({ n: (r && r.phase !== 'match') ? r.members.size : 0 });
// inside broadcastPresence():
const modes = { quick: poolInfo(publicRoom), brawl: poolInfo(publicRoomBrawl) };
for (const m of members.values()) if (!m.room) send(m.ws, { type: 'home', online, modes });
```

~6 lines. No new message type, no new interval, ~60 extra bytes at 5 Hz to roomless clients
only. Build `modes` **once per tick**, outside the loop. The client turns `n > 0` into 🟢 and
`n === 0` into 🟡 — the raw `n` is only ever rendered when it is good news (§3.4).

**Bigger (unblocks the party picker, §P11).** Give a room a mode: accept
`createRoom({ mode })` / a `setRoomMode` message, store `room.mode`, and let it drive
`room.goalsToWin` (`server.js:550`) — the same knob `goalBrawl()` already uses at line 328.
Until this exists, gate the party list to `party:true && state==='live' && id==='quick'` and
say so, rather than shipping another fake picker.

### 5.6 `public/_layout-edit.js`

Add `{ key:'modeChip', label:'Mode chip', sel:'#mode-chip' }` to the descriptors (43-64).
Note the list has **already drifted** — `#rank-btn` and `#hub-tier` are positioned in the
baked CSS but absent from the editor. Worth fixing in the same pass.

---

## 6. Ranking

### Tier 0 — ~1 hour total, no server change, no layout change

These are corrections, not redesign. Ship them even if the rest never happens.

| # | Fix | Where | ~ |
|---|---|---|---|
| 1 | **Un-lock goal-brawl** in the three lists that call a live mode «בקרוב» | `index.html:254-258, 512-516, 576-580` | 10 m |
| 2 | **Add `diffLevel: xpDiffLevel()`** to the arena 2v2 handler — bots currently don't scale on that path | `client.js:1968` | 2 m |
| 3 | Retitle «בחר מגרש» → «מה משחקים?» and drop the false «החלף מגרש» subtitle | `index.html:236, 105` | 5 m |
| 4 | Put **format facts** (players · duration · win condition) in every card's `small` | `index.html` ×4 lists | 15 m |
| 5 | Visible `›` back buttons on arena/news/shop/clubs | `index.html` + `client.js:1931` | 15 m |
| 6 | Make locked cards **tappable → toast with a one-line teaser** instead of nothing | `client.js` | 10 m |

### Tier 1 — half a day: kill the duplication

`MODES` + `renderModeList()` driving all four lists · `selectedModeId` persisted · gold button
reflects it · `#mode-chip` added · rail trimmed to three utilities. **This is the change that
stops the bug in Tier-0 #1 from recurring**, so it is the highest-value non-trivial work.

### Tier 2 — one day: the sheet

`#arena` rebuilt as the two-column play sheet · preview panel · featured slot (flag only) ·
notify-me · nav stack + consistent back.

### Tier 3 — one day, server: the activity signal

`modes` in the `home` broadcast (§5.5 small) + the 🟢/🟡 line. Then per-room mode (§5.5
bigger) so the party picker becomes real.

### Explicitly NOT now

- **Rotation logic** — until live modes ≥ 4 (§3.6).
- **Multi-select queueing** (the Rocket League fix) — it solves queue starvation, and bot
  backfill already starts a match in ≤5 s, so we don't have that problem. Revisit only if a
  human-minimum is ever enforced.
- **Per-mode counts, ETAs, search, filters, favourites, tabs, rails** — §2, do-not-copy.
- **XP gating on modes** — invent no grind to disguise "not built" (§3.5).

---

## 7. Open questions for the other agents in this pass

- **`mode-3v3`** — §3.3 says 3v3 should be a **segmented control inside the football card**,
  not a fifth tile (Fortnite's sub-mode merge). That implies a per-room team-size parameter
  rather than a separate matchmaking entry point. Please reconcile.
- **`new-minigames`** — the sheet caps the in-dev tail at **2 tiles** plus an `עוד בדרך ›`
  strip. A roster of 10–14 concepts must land in `#news`, not the picker.
- **`mode-polish`** — the format-facts line (`players · duration · win condition`) needs to
  stay true if overtime / sudden-death changes the win condition. Keep the strings in `MODES`.
- **`social` (lane owner)** — §3.7 routes party creation through the play sheet carrying
  `selectedModeId`. That touches `openFriendSelect()` / the party flow, which is your lane.
