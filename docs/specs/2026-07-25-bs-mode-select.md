# Brawl Stars — Game-Mode Selection Screen: Teardown

**Date:** 2026-07-25
**Author:** research agent (`bs-mode-select`)
**Status:** research only — no code touched.
**Purpose:** feed the redesign of the Saltiz football game's mode picker (`public/client.js` → `MODES` / `renderModeList`).

> **Read the last section first if you're short on time.** §8 ("What survives at 2–4 modes") is the
> part that matters for us. Everything before it is evidence.

---

## 0. Evidence base

Brawl Stars is a moving target — the mode picker has been rebuilt at least three times. This doc is
built from **actual screenshots read pixel-by-pixel**, not from memory. Sources, oldest → newest:

| # | What it shows | Era | URL |
|---|---|---|---|
| S1 | **Events screen, 2×2 grid of event cards** — the canonical card anatomy | ~2019–2021 | `https://gamerempire.net/wp-content/uploads/2019/03/Brawl-Stars-all-game-modes-list.png` |
| S2 | **Home screen** with selected-event pill + PLAY | ~2020–21 | `https://interfaceingame.com/wp-content/uploads/brawl-stars/brawl-stars-main-menu.png` |
| S3 | **Team lobby (FR)** — pill with yellow "NOUVEAUX ÉVÉNEMENTS !" CTA chip | ~2021 | `https://interfaceingame.com/wp-content/uploads/brawl-stars/brawl-stars-lobby.png` |
| S4 | **Home screen** (Ranked selected), Feb 2025 design critique | 2025-02 | `https://ixd.prattsi.org/wp-content/uploads/2025/02/1-1-1.png` |
| S5 | **Mode-select screen, 2-row horizontal scroll + bottom tab bar** (`ARCADE / TROPHIES / RANKED / COMMUNITY`) | 2025-01 | `https://static0.gamerantimages.com/wordpress/wp-content/uploads/wm/2025/01/brawl-stars-best-buzz-lightyear-modes-5.jpg` |
| S6 | **CURRENT mode-select** (2340×1080) with Rush panel, tall hero card, tabs `TROPHIES / RANKED / FREE PLAY / COMMUNITY` | 2026-03 | `https://static.wikia.nocookie.net/brawlstars/images/a/ac/Trophy_Rush_Pic_2.png` |
| S7 | Same screen with Rush **active** (gold tint, ×2 chips on every card) | 2026-03 | `https://static.wikia.nocookie.net/brawlstars/images/e/e7/Trophy_Rush_Pic_3.png` |
| S8 | Fan concept "Event Selection UI Rework" (**not shipped** — useful only as a negative) | 2020 | `https://i.redd.it/6ko96lfznaw41.jpg` |

Text sources:

- Beginner's Guide (slot count, rotation, tap-for-XP): `https://brawlstars.fandom.com/wiki/Beginner's_Guide`
  → *"Up to 7 different events can be active at any one time. The time before the next rotation for an Event Slot is displayed in that slot. When that time is reached, a new Event begins and 5 free XP can be claimed by simply tapping the Event slot."*
- Trophy Road unlock table: `https://brawlstars.fandom.com/wiki/Trophies` + `/Trophies/Trophy Road`
- Rush Events (a screen-level button, not a card): `https://brawlstars.fandom.com/wiki/Rush_Events`
  → *"Rush Events can be activated once per day in the game mode selection screen…"*
- Slot-sharing rules, 2025 rotation rework: `https://brawlstars.fandom.com/wiki/Version_History/2025`
- Events overview / 7 slots: `https://houseofbrawlers.com/wiki/brawl-stars/en/events/overview/`
- "who remembers the *vertical* event selection screen?" (confirms the vertical list was abandoned):
  `https://medium.com/@matt.sullivan28/a-brief-look-brawl-stars-ux-ui-562f6225b7e3`
- Design critique (home-screen featuritis): `https://ixd.prattsi.org/2025/02/design-critique-brawl-stars/`
- Supercell UI/UX 2025 portfolio (Gonzalo Vazquez): `https://www.behance.net/gallery/239453593/Brawl-Stars-UIUX-2025`

> Note on fandom: `brawlstars.fandom.com` HTML returns 402/403 to fetchers. The **MediaWiki API**
> (`/api.php?action=parse&page=X&prop=wikitext&format=json`) works fine with a normal UA. Useful trick.

---

## 1. The mode-select surface: what shape is it?

**It is not a vertical list. It is not a grid of square tiles. It is a horizontally-scrolling,
two-row strip of wide landscape cards, with a persistent bottom tab bar that partitions the strip
into named sections.**

The evolution is worth knowing because each step was a deliberate rejection of the previous one:

| Era | Layout | Why it changed |
|---|---|---|
| 2017 beta | **Vertical list** of full-width rows | Abandoned — wastes a landscape screen; only ~3 rows fit |
| ~2019–2021 (S1) | **2×2 static grid** of wide cards, page fits exactly 4–6 | Ran out of room once modes/slots grew past ~7 |
| 2025 (S5) | **2 rows × N columns, horizontal scroll**, bottom tab bar `ARCADE·TROPHIES·RANKED·COMMUNITY` | Scales to unlimited slots; tabs = jump index |
| 2026 (S6/S7) | Same, **plus a pinned full-height hero column on the left** and a screen-level Rush module | Adds emphasis + a daily-action hook |

### 1.1 Current layout (2026) — landscape wireframe

Measured off S6 (2340 × 1080). Percentages are of screen width (W) / height (H).

```
 ┌──────────────────────────────────────────────────────────────────────────────────────┐
 │ ┌────┐                              ┌────┐                                   ┌────┐  │  ← 0%H
 │ │ ‹  │  BACK                        │ 🏆 │ season/inbox                      │ 🏠 │  │
 │ └────┘                              └────┘                                   └────┘  │  ← 9%H
 │                                                                                      │
 │  ╔═══ RUSH MODULE ════╗ ┌╌╌╌ HORIZONTAL SCROLL VIEWPORT (clips right) ╌╌╌╌╌╌╌╌╌╌╌╌╌╌┐│  ← 14%H
 │  ║  "TROPHY RUSH"     ║ │┌──────────┐ ┌──────────────┐ ┌──────────────┐ ┌───────────┼┤
 │  ║    ╭────────╮  (i) ║ ││          │ │ BRAWL BALL   │ │ KNOCKOUT     │ │ WIPEOUT   ││
 │  ║    │  ×2    │      ║ ││ SHOWDOWN │ │ Goalies      │ │ Pinned Down  │ │ 5v5       ││
 │  ║    ╰────────╯      ║ ││ HERO     │ └──────────────┘ └──────────────┘ └───────────┼┤
 │  ║  Get Double        ║ ││ (tall,   │ ┌──────────────┐ ┌──────────────┐ ┌───────────┼┤
 │  ║  Trophies for 20m! ║ ││  2 rows  │ │ GEM GRAB     │ │ HOT ZONE     │ │ BOUNTY    ││
 │  ║      Ready!        ║ ││  high)   │ │ Satomi Spr.  │ │ Parallel Pl. │ │ Hideout   ││
 │  ╚════════════════════╝ │└──────────┘ └──────────────┘ └──────────────┘ └───────────┼┤  ← 93%H
 │  ←───── ~30%W ─────→    └╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┘│
 │                                                                                      │
 │      TROPHIES          RANKED           FREE PLAY          COMMUNITY                 │  ← tab bar
 │      ▔▔▔▔▔▔▔▔ (active, white/bold; inactive are grey)                                │    ~9%H
 └──────────────────────────────────────────────────────────────────────────────────────┘  ← 100%H
```

**Visible at once:** 1 hero + 4 full landscape cards + 2 half-clipped = **7 slots on screen, 5 fully
legible.** The right-hand clip is deliberate: it is the only scroll affordance (there is no arrow,
no dots — just a card sliced by the viewport edge).

### 1.2 2025 layout (S5) — uniform, no hero

```
 ┌──────────────────────────────────────────────────────────────────────────────────┐
 │ ┌──┐                                                                      ┌────┐ │
 │ │‹ │                        TROPHY EVENTS            ← section header     │ 🏠 │ │
 │ └──┘                                                                      └────┘ │
 │  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌───────────┐                   │
 │  │ SHOWDOWN   │  │ GEM GRAB   │  │ HOT ZONE   │  │ KNOCKOU ▌ │  ← clipped        │
 │  │ Marksman's │  │ Open Space │  │ Ring of F. │  │ Overgro ▌ │                   │
 │  └────────────┘  └────────────┘  └────────────┘  └───────────┘                   │
 │  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌───────────┐                   │
 │  │ BRAWL BALL │  │ WIPEOUT5v5 │  │ BOUNTY     │  │  …      ▌ │                   │
 │  │ Super Beach│  │ Slippery r.│  │ Hideout    │  │         ▌ │                   │
 │  └────────────┘  └────────────┘  └────────────┘  └───────────┘                   │
 │                                                                                  │
 │    ARCADE            TROPHIES           RANKED          COMMUNITY                │
 │    ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬────────────────────────  ← scroll-position bar     │
 └──────────────────────────────────────────────────────────────────────────────────┘
```

Note the **thin scrollbar rail directly under the tab labels**. The tabs double as a
position index: the labels are laid along the same axis as the scroll, and the rail shows where in
the whole strip you currently are. Tapping a label jumps to that section; the section's name is also
printed as a centred header above the cards (`TROPHY EVENTS`). It is one continuous surface, not
four separate pages.

---

## 2. Anatomy of one mode card

### 2.1 The standard landscape card, fully labelled

Measured off S6/S5. Card ≈ **24.7 % W × 31.7 % H**, aspect **≈ 1.68 : 1**.

```
                                                     ┌ (i) INFO BUTTON
        ┌ QUEST / TOKEN BADGE                        │  blue circle, ~6.5%H diameter,
        │  white clipboard-with-✓,                   │  CENTRED ON THE TOP-RIGHT CORNER
        │  rotated ~-15°, overhangs                  │  (overhangs both edges by ~50%)
        │  the TOP-LEFT corner                       │  → opens the mode's rules popup.
        │  → "there's a quest on this mode"          │    Separate hit target from the card.
        ▼                                            ▼
      ╔═╤══════════════════════════════════════════╤═╗
   ┌──╫─┴──────────────────────────────────────────┴─╫──┐  ─┐
   │ ▓▓                       New map in: 18h 14m   (i)  │   │ ① TIMER STRIP
   │  pure black, right-aligned grey/white bold text     │   │   13% of card height
   ├─────────────────────────────────────────────────────┤  ─┤
   │                                                     │   │
   │   ⬢⬢⬢    BRAWL BALL          ← mode name            │   │ ② TITLE BAND
   │   ⬢⬢⬢    ═══════════           heavy caps, white,   │   │   38% of card height
   │   MODE     Goalies             thick black outline  │   │   BACKGROUND = THE MODE'S
   │   ICON     ▔▔▔▔▔▔▔           ← map name            │   │   PERMANENT BRAND COLOUR
   │   ~0.9× band-height          smaller, bold, white   │   │
   │   flush left, slight overhang                       │   │
   ├─────────────────────────────────────────────────────┤  ─┤
   │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │   │
   │ ░░  MAP / EVENT KEY ART  ░░░░░░░░░░░░░░░░░░░░░░░░░░ │   │ ③ ART PANEL
   │ ░░  painted wide scene, NOT a minimap  ░░░░  ┌────┐ │   │   49% of card height
   │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│ SUB│ │   │
   │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░└────┘ │   │  ← SUB-MODE BADGE
   └─────────────────────────────────────────────────────┘  ─┘    white rounded square,
                                                                  bottom-right of art.
                                                                  e.g. Solo/Duo Showdown
```

Plus two inline variants seen in the wild:

- **Team-size chip inside the icon slot** — `WIPEOUT 5V5` renders a small `5v5` plate tucked under
  the mode glyph, inside the title band (S5). Format is treated as part of the *identity*, not as
  metadata below.
- **Rush overlay** (S7) — when a Rush is active the black timer strip is replaced by a scrolling gold
  marquee `TROPHY RUSH! TROPHY RUSH!` and a gold `×2` trophy chip is stamped on the art panel of
  **every** card. The whole screen tints gold. One state change, applied uniformly, reads instantly.

### 2.2 The hero / tall card (2026 only)

Same three bands, **restacked to portrait and centre-aligned**:

```
  ┌──────────────────────┐  ─┐
  │ New map in: 6h 14m(i)│   │  timer strip (same)
  ├──────────────────────┤  ─┤
  │                      │   │
  │         ⬤⬤⬤          │   │  ICON ON TOP, CENTRED
  │         ⬤⬤⬤          │   │  (not flush-left)
  │                      │   │
  │      SHOWDOWN        │   │  name CENTRED
  │     Safety Center    │   │  map name CENTRED
  │                      │   │  ← title band + art panel BLEED
  │  ░░░░ full-bleed ░░░ │   │    into each other; the colour
  │  ░░░ mode art ░░░░░░ │   │    gradient runs straight into
  │  ░░░░░░░░░░░░░░░░░░░ │   │    the artwork (no hard rule)
  └──────────────────────┘  ─┘
      ≈ 19.8%W × 66.5%H
      aspect ≈ 0.64 : 1 (portrait)
```

It is exactly **2 stacked landscape cards tall**, so it slots into the same 2-row grid with zero
special-case layout maths. That's the trick: the hero is not a different component, it's the same
component with `rowspan: 2` and a centred variant of the header.

### 2.3 Essential vs decorative

| Element | Verdict | Why |
|---|---|---|
| **Mode brand colour** | **ESSENTIAL** | The single strongest recognition cue. See §6. |
| **Mode icon** | **ESSENTIAL** | Fixed glyph, never changes per map. Recognised faster than the word. |
| **Mode name** | **ESSENTIAL** | Confirms the colour+icon. |
| **Map name** | Important, not essential | It's the *variety* signal — "this isn't the same match as yesterday". Only meaningful if you actually have named maps. |
| **Map / event art** | Important | Half the card. It's what makes the screen feel alive; also the only per-rotation visual change. |
| **Rotation timer** | Important **only if you rotate** | Pure FOMO instrument. Meaningless without real rotation. |
| **(i) info button** | Important for onboarding | Keeps rules out of the card while keeping them one tap away. |
| **Sub-mode badge** (Solo/Duo) | Situational | Only for modes with a real variant fork. |
| **Quest / token badge** | Decorative-ish | A reward-routing nudge. Skip unless you have quests. |
| **Team-size chip** (`5v5`) | Situational | Only when two formats of the same mode co-exist. |
| **NEW badge** | Decorative | Brawl Stars uses it sparingly — a green `NEW!` flag on a featured card, not on every card. |
| **Ticket cost** | **GONE** | Tickets were removed 2020-05-13. No entry cost anywhere in the modern picker. |
| **Rewards preview on the card** | **NOT PRESENT** | Rewards are *never* itemised per card. The one exception is the global Rush `×2` overlay. This is a strong signal: Supercell decided per-card reward lists were noise. |
| **Modifier name** | Folded into the map name | Modifiers ride with the map, not shown as separate metadata. |
| **Explicit PLAY / SELECT button on the card** | **NOT PRESENT** | The whole card is the button. The fan concept (S8) added `SELECT` buttons to every card — it was never shipped, and it looks visibly busier. |

---

## 3. Slots and rotation

### 3.1 How many

**Up to 7 concurrent event slots** (Beginner's Guide; House of Brawlers). In practice the modern
picker shows more than that because Ranked / Free Play / Community live in their own tabs.

### 3.2 Slot structure — permanent vs rotating

This is the key structural idea, and it has an exact 2025 patch-note definition
(`Version History/2025`, "Permanent game modes rotation changes"):

```
  PERMANENT (one mode owns the slot outright — always visible, only the MAP rotates)
    ├─ Brawl Ball
    ├─ Knockout
    ├─ Air Hockey
    ├─ Knockout 5v5
    ├─ Gem Grab
    └─ Brawl Arena

  SHARED (three modes take turns in one slot — the MODE itself rotates)
    ├─ slot: Heist  ⇄  Hot Zone  ⇄  Token Run
    ├─ slot: Dodgeball  ⇄  Volley Brawl  ⇄  Basket Brawl
    └─ slot: Wipeout  ⇄  Bounty  ⇄  Duels

  SPECIAL
    ├─ Community slot   (community/Map-Maker maps, voted)
    ├─ Free Play slot   (2026: rotating mode, random matchmaking, NO trophy gain/loss)
    └─ Weekend slot     (historically Big Game / Boss Fight / Robo Rumble)
```

Historical precedent for slot sharing goes back to 2019: *"Bounty and Heist now share event slot 3"*,
*"Brawl Ball and 'Showdown with event mods' now share event slot 4"*.

**The design principle:** the *number of slots on screen is constant*. What changes is which mode is
sitting in a shared slot and which map that mode is on. The player's mental map of the screen never
has to re-form.

### 3.3 How the rotation timer is displayed

- **Per card**, in the black strip at the top, right-aligned:
  - `New Event in: 3h 15m` — used when the **mode** in that slot is about to change (2025 wording)
  - `New map in: 6h 14m` — used when only the **map** changes (2026 wording, on permanent-mode slots)
- The distinction is real and useful: the same UI slot tells you *what kind* of change is coming.
- **Never a progress bar. Never a date.** Always relative, always `Xh Ym`, always in the same corner.
- **Also on the home screen**, above the selected-event pill: `New Event in: 9h 12m` — so you get the
  FOMO cue without opening the picker.
- Slot cadence is typically 24 h; the featured slot cycles faster (~2 h).
- Historically, tapping a slot that had just rotated paid **+5 XP** — the timer hitting zero created a
  free, cheap reason to open the screen.

### 3.4 Locked / not-yet-unlocked entries

**Brawl Stars does not gate modes inside the picker. It gates them on the Trophy Road.** New modes
arrive as *rewards*, and until you earn them their card simply is not in the list.

Exact unlock milestones (`Trophies/Trophy Road`):

| Trophies | Unlocks |
|---|---|
| 0 | Solo Showdown (default) |
| 1 | Menu buttons |
| **20** | **Brawl Ball** |
| **100** | **Gem Grab** |
| **200** | **Team Events** (the 3v3 rotating slot group) |
| **300** | **Special Events** |
| 325 | Seasonal Events, Community Event rewards |
| 800 | Challenges |
| **1000** | **Ranked**, Map Maker |
| 1600 | (2019) an additional event slot |

Consequences for the picker's UX:

1. A new player's picker is genuinely short — one or two cards — and that's fine, because it grows
   visibly as a reward.
2. The "locked" state that the player actually sees lives on the **Trophy Road screen**, where the
   upcoming mode is a reward node on a path with your progress bar running toward it. That is a much
   better motivator than a greyed card saying "coming soon".
3. Where a padlock *is* shown in Brawl Stars (e.g. Brawl Pass rewards, S-batch screenshots), the
   pattern is: dimmed art + a padlock glyph + a one-line requirement string. It is **never a dead
   tap** — it always explains itself.

> Our current `renderModeList` already does the good half of this: `state:'dev'` cards render with
> `.lock` and a `בקרוב` chip and stay tappable (toast on tap). That matches Supercell's "never a dead
> pixel" rule. What it *doesn't* do is turn the lock into a goal. See §8.

---

## 4. Selection mechanics

```
   HOME / LOBBY                              MODE-SELECT                       MATCH
  ┌──────────────┐   tap the pill          ┌──────────────┐   tap a card    ┌────────┐
  │  [pill] PLAY │ ──────────────────────► │  card grid   │ ──────────────► │ back   │
  │              │ ◄────────────────────── │  + tabs      │   (selects)     │ to     │
  └──────────────┘        back / ‹         └──────────────┘                 │ HOME   │
         │                                        │                         └────────┘
         │ tap PLAY                                └─ tap (i)  → rules popup, stays put
         ▼                                         └─ tap sub-badge → Solo/Duo fork
    matchmaking
```

- **Two-step, not one-step.** The picker *selects*; a separate, always-visible **PLAY** button on the
  home screen *launches*. The card carries no play button of its own.
- **The selection is remembered.** The home screen permanently displays the last-chosen event. It
  persists across sessions. This is the single most load-bearing decision in the whole design: a
  returning player who wants the same mode as yesterday never opens the picker at all — they open
  the app and hit one big yellow button.
- **The pill is the door.** The selected-event pill *is* the entry point to the picker. There is no
  separate "modes" nav item competing for space.
- **There is no favourite / pin.** The remembered last-selection does the job a pin would do, with
  zero extra UI. This is worth copying.
- **Rotation nags you through the pill, not through a badge.** When a new rotation lands, the pill
  grows a yellow CTA plate at its right end reading `NEW EVENTS!` / `NOUVEAUX ÉVÉNEMENTS !` (S3).
  It's inside the pill, sharing its silhouette, so it reads as "this thing has news" rather than as a
  new control.
- **The (i) is a genuinely separate hit target** and it overhangs the card corner so it never eats
  card real-estate. Tapping it opens the rules; it does not select.

### 4.1 The home-screen pill, wireframed

Measured off S2/S3/S4 (1920 × 1080):

```
                                                        ┌ (i) overhangs the strip's top-right
                                                        ▼
        ┌───────────────────────────────────────────────╥─┐ ┌──────────────────────────┐
        │              New Event in: 9h 12m            (i)│ │ ☠82/200  +20 in 2h 12m   │ ← token strip
        ├─────────────────────────────────────┬──────────┬┤ ├──────────────────────────┤
        │  ☠   SOLO SHOWDOWN                  │  ┌────┐  ││ │                          │
        │      Two Thousand Lakes             │  │SUB │  ││ │         P L A Y          │
        │      ▲ map name, in the MODE'S      │  └────┘  ││ │      (big, yellow)       │
        │        ACCENT COLOUR (green here,   │  solo/duo││ │                          │
        │        magenta for Gem Grab)        │  badge   ││ └──────────────────────────┘
        └─────────────────────────────────────┴──────────┴┘
        ←──────────────── ~37% W ──────────────────────→   ←────────── ~26% W ─────────→
                          ~13% H (body) / ~17% H with strip           ~13% H
```

When a rotation is fresh, a yellow `NEW EVENTS!` plate is appended to the pill's right end (S3),
squeezing the sub-badge.

---

## 5. Tabs — how the picker is partitioned

| Tab | Era | Contents |
|---|---|---|
| `ARCADE` | 2025 | Limited/fun/special modes, Mega Pig, Club Games |
| `TROPHIES` | both | The 7-slot trophy rotation — the default, the main event |
| `RANKED` | both | Competitive, one featured mode + 2 maps per season |
| `FREE PLAY` | 2026 (new) | Rotating mode, random matchmaking, **no trophy gain/loss** — the "just mess around" lane |
| `COMMUNITY` | both | Community / Map-Maker maps, "Candidates of the Day" voting slot |

The taxonomy is **by stakes**, not by genre: *does this cost me rating?* (`TROPHIES` / `RANKED` = yes,
`FREE PLAY` / `COMMUNITY` = no). That's a much sharper axis than "3v3 vs solo", which is what the
2020 fan concept used (`POWER PLAY / 3V3 / SHOWDOWN / WEEKEND EVENT`) and which aged badly the moment
5v5 arrived.

Also living on this screen, outside the card grid: the **Rush module** — a once-a-day activatable
buff (`Trophy Rush`, `Power Rush`, `Coin Rush`, `Starr Drop Rush`) occupying a fixed pinned panel on
the left, ~30 % of the width. It's a daily-return hook placed exactly where the player already has to
go to start a match.

---

## 6. Why the screen is scannable

Ranked by contribution:

1. **A permanent, unique brand colour per mode.** Not a palette — a *dictionary*. Every appearance of
   that mode anywhere in the game uses that colour.

   | Mode | Colour |
   |---|---|
   | Gem Grab | violet / purple |
   | Showdown | lime green |
   | Brawl Ball | pale periwinkle (light lavender-grey) |
   | Bounty | cyan / sky |
   | Knockout | orange |
   | Hot Zone | crimson red |
   | Heist | magenta-pink |
   | Wipeout | hot pink |
   | Siege | red-orange |

   In a 2-row strip you identify a mode by **hue at 20 px**, before any glyph or word resolves.

2. **A single, fixed icon slot in a single, fixed position.** The glyph never varies by map, never by
   season. Icon position never moves (flush-left in landscape cards; centred-top in the hero card —
   and *that consistent difference* is itself the signal "this one is special").

3. **Rigid three-band anatomy.** Timer strip → title band → art. Every card, every time. Your eye
   learns "timers live on the top-right black bar" once and never re-learns it.

4. **The art panel is the only thing allowed to be chaotic.** Colour band, name, timer and badges are
   all in fixed slots with high-contrast white-on-colour and heavy black outlines; the illustration
   absorbs all the visual noise. This is why the screen can be extremely loud and still readable.

5. **Size = importance.** One tall card among short ones. No borders, no glow, no "FEATURED" ribbon
   needed — 2× the area does the whole job.

6. **State changes are applied globally, not per-card.** Rush active → the whole screen goes gold and
   every card gets the same `×2` chip. You never have to compare cards to find the special one.

7. **Deliberate clipping at the viewport edge** replaces scroll indicators.

---

## 7. Sizing summary

| Thing | Fraction of screen |
|---|---|
| Standard landscape card | **24.7 % W × 31.7 % H**, aspect ≈ **1.68 : 1** |
| Hero / tall card | **19.8 % W × 66.5 % H**, aspect ≈ **0.64 : 1** (= exactly 2 rows) |
| Card timer strip | 13 % of card height |
| Card title band | 38 % of card height |
| Card art panel | 49 % of card height |
| Mode icon | ≈ 0.9 × title-band height |
| (i) button | ≈ 6.5 % H diameter, centred on the card's top-right corner |
| Column gap | ≈ 1.2 % W |
| Row gap | ≈ 3 % H |
| Scroll viewport | ≈ 79 % H (top chrome ~9 % H, tab bar ~9 % H) |
| Rush / hero side panel | ≈ 30 % W |
| Home pill | ≈ 37 % W × 13 % H (17 % with timer strip) |
| Home PLAY button | ≈ 26 % W × 13 % H |
| Cards fully visible | **5** (plus 1 hero + 2 clipped = 7 slots on screen) |
| Scrollable? | **Yes, horizontally only.** Never vertically. |
| Featured entry bigger? | **Yes** — one 2-row-tall hero card, pinned leftmost |

---

## 8. What survives at 2–4 modes (and what would look absurd)

We have **4 modes: `2v2` (live), `brawl` (live), `3v3` (dev), `cup` (dev)** — i.e. 2 playable.
Brawl Stars is solving a 7–20 entry problem. Most of its machinery is scale machinery. Here's the
honest split.

### 8.1 COPY — these work at any count, including 2

| Pattern | Why it survives | How it lands for us |
|---|---|---|
| **Selected-mode pill + big separate PLAY** | Value is inversely proportional to mode count. With 2 modes, the picker should be a thing you *rarely* open. One tap to replay yesterday's mode. | Home shows `⚽ כדורגל 2 נגד 2` + a big gold `שחק`. Tapping the pill opens the picker. |
| **Persisted last selection, no pin/favourite** | A pin is redundant when the last choice is remembered — and at 2 modes a pin UI would be comical. | `localStorage` the last `modeId`; render it in the pill on boot. |
| **One brand colour + one glyph per mode, used everywhere** | Costs nothing and pays off hardest when there are *few* things, because you can afford genuinely distinct hues. | 2v2 = green pitch, brawl = orange/red goal-mouth, 3v3 = blue, cup = gold. Reuse those colours in the HUD, results screen, trophy chips. |
| **The whole card is the button** — no `SELECT` sub-button | The fan concept that added SELECT buttons was never shipped and looks cluttered even at 6 cards; at 3 it would be absurd. | Keep `.modecard` as the single hit target. |
| **Rigid three-band card anatomy** | Consistency is cheap and makes 3 cards look like a *system* rather than 3 one-offs. | strip (timer/status) → colour band (icon + name + sub) → art panel. |
| **Separate (i) hit target for rules** | Lets the card stay clean while onboarding stays one tap away. Especially valuable for us — our modes need explaining more than Gem Grab does. | Small circle on the card's top-right corner, opens the rules sheet. |
| **Locked cards stay tappable and explain themselves** | Already how `renderModeList` behaves. Keep it. | ✅ already correct. |
| **Size = importance** | The cheapest possible emphasis mechanism. | See 8.3. |
| **Deliberate clipping instead of scroll arrows** | Only if we ever exceed the viewport. | Probably N/A at 4. |

### 8.2 DON'T COPY — these need scale, or they look empty/fake

| Pattern | Why it breaks at 2–4 |
|---|---|
| **Bottom tab bar (`TROPHIES / RANKED / FREE PLAY / COMMUNITY`)** | Four tabs over four cards is pure chrome. It would advertise emptiness. **Only add tabs when a single tab overflows.** |
| **Horizontal scroll with 2 rows** | Needs ≥ 8 entries to justify the scroll gesture. With 4 you get a strip that doesn't move — a scroll affordance that never scrolls reads as broken. **Use a single row that fits.** |
| **`New Event in: Xh Ym` timers** | A rotation timer with nothing to rotate to is a lie. Do **not** put a countdown on a card whose content never changes. If we ever add a rotating map pool, it earns its timer then. |
| **Named maps as the card subtitle** | Only if the maps are genuinely named, distinct and rotating. Right now our subtitle should carry *format and length* (`2 נגד 2 · עד 2 דק׳ · ראשון ל-3`) — which is what it already does, and which is more useful than a fake map name. |
| **Slot sharing (3 modes taking turns in one slot)** | You need surplus modes to hide. We have a deficit. Show everything, always. |
| **Trophy-gated mode unlocks** | Tempting, but gating 1 of 2 playable modes behind trophies halves the game for new players. Gate *cosmetics* and *3v3/cup* if anything — never the core loop. |
| **Per-card reward previews / ticket costs** | Brawl Stars itself removed these. Don't add what they deleted. |
| **A quest/token badge on every card** | Needs a quest system. Without one it's decoration pretending to be information. |
| **Rush module (a 30 %-wide pinned side panel)** | It's a daily-return hook that only makes sense with a large card grid to sit beside. On a 4-card screen it would dominate. |
| **A `NEW` flag on everything** | Brawl Stars uses it on *one* card at a time. Ours should too — reserve it for a genuinely new mode's first week. |

### 8.3 Recommended shape for a 4-mode picker (landscape)

The right adaptation isn't "Brawl Stars with fewer cards" — it's **Brawl Stars' card anatomy at
Brawl Stars' hero-card scale, because with 4 entries every card can be a hero.** The screen should
feel *full*, and 4 big cards fill a landscape screen exactly.

```
 RTL layout (Hebrew) — mirror everything; icons sit on the RIGHT of the title band
 ┌──────────────────────────────────────────────────────────────────────────────────────┐
 │  ┌────┐                                                                     ┌────┐   │
 │  │ 🏠 │                        בחר משחק                                     │  › │   │
 │  └────┘                                                                     └────┘   │
 │                                                                                      │
 │  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐      │
 │  │            (i) │  │            (i) │  │            (i) │  │      🔒        │      │
 │  ├────────────────┤  ├────────────────┤  ├────────────────┤  ├────────────────┤      │
 │  │ ⚽  2 נגד 2    │  │ 🥅 קרב על השער │  │ ⚽  3 נגד 3    │  │ 🏆  טורניר      │      │
 │  │   עד 2 דק׳     │  │   2 דק׳ · גולים │  │   מגרש גדול    │  │   עונתי         │     │
 │  │  ── GREEN ──   │  │  ── ORANGE ──  │  │  ── BLUE ────  │  │  ─ GOLD (dim) ─ │     │
 │  ├────────────────┤  ├────────────────┤  ├────────────────┤  ├────────────────┤      │
 │  │░░ pitch art ░░ │  │░░ goal art ░░░ │  │░ big pitch ░░░ │  │░ trophy art ░░░│      │
 │  │░░░░░░░░░░░░░░░ │  │░░░░░░░░░░░░░░░ │  │░░░░░░░░░░░░░░░ │  │  ▒ 60% dim ▒   │      │
 │  │░░░░░░░░ [חדש] │  │░░░░░░░░░░░░░░░ │  │░░░░░░░ [בקרוב] │  │░░░░░░░ [בקרוב] │      │
 │  └────────────────┘  └────────────────┘  └────────────────┘  └────────────────┘      │
 │       ~22%W              ~22%W               ~22%W               ~22%W               │
 │       ~62%H              ~62%H               ~62%H               ~62%H               │
 └──────────────────────────────────────────────────────────────────────────────────────┘
   no tabs · no scroll · no rotation timers · locked cards dimmed but tappable
```

Four portrait cards at ~22 % W × ~62 % H each, gaps ~2 % W, fills a 16:9 landscape screen with no
scroll and no dead space. If a 5th mode ever lands, that's the moment to introduce horizontal scroll
with a clipped 5th card — **not before**.

Two smaller notes for our build:

- **RTL.** Brawl Stars is LTR: icon left, timer right, back-button left, home right. Mirror all of it.
  The icon should hug the **right** edge of the title band, the (i) sits on the **top-left** corner.
- **Locked cards.** Follow the Trophy Road lesson: don't just say `בקרוב`. Give the lock a *reason and
  a target* — `נפתח ברמה 5` with a progress hint beats a bare "coming soon", and it converts the
  empty half of our roster from a liability into a goal. If there's no real gate yet, `בקרוב` with a
  toast (current behaviour) is the honest fallback.

---

## 9. One-paragraph verdict

Brawl Stars' picker is a **horizontally-scrolling 2-row strip of wide, three-band, brand-coloured
cards**, partitioned by a bottom tab bar, with one 2-row-tall hero card for emphasis and a daily Rush
buff pinned beside it — but the part worth stealing is upstream of all of that: **the mode you last
picked is remembered and shown on the home screen next to a huge PLAY button, so the picker is a
place you visit rarely and leave in one tap.** At our scale (4 modes, 2 live) we should take the card
anatomy, the per-mode colour+glyph dictionary, the whole-card-is-the-button rule, the separate (i),
and the persisted-selection home pill — and skip the tabs, the scroll, the rotation timers, the
slot-sharing and the reward chrome, all of which exist only to manage a catalogue we don't have.
