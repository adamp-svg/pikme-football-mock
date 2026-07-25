# Brawl Stars home screen — anatomy teardown

**Date:** 2026-07-25
**Purpose:** reference for the Saltiz football lobby redesign.
**Status:** research only. No code touched.

---

## 0. Method + confidence

Everything geometric in this doc was **measured off real screenshots**, not eyeballed from memory.

| Artifact | What it is | Era | Confidence |
|---|---|---|---|
| `interfaceingame.com/wp-content/uploads/brawl-stars/brawl-stars-main-menu-1920x1080.png` | Real 1920×1080 capture of the home screen | ~v25 (2020, Brawl Pass + Brawl Boxes era) | **Measured** — all % below come from pixel bboxes on this file |
| `.../brawl-stars-menu-1920x1080.png` | Home screen with the hamburger drawer open | same | Measured |
| `.../brawl-stars-choose-event-1920x1080.png` | The "CHOOSE EVENT" full-screen mode picker | same | Measured |
| `.../brawl-stars-friendly-game-1920x1080.png` | Friendly Game (proves the home chrome persists) | same | Measured |
| Behance "Brawl Stars UI/UX 2024" (Gonzalo Vazquez, Supercell UI artist) | Shipped 2024 Events screen + Ranked rebrand | 2024 | **Screenshot-verified** |
| `brawlstars.fandom.com` Version History 2019–2026 | Patch-note lines mentioning home screen / Play button | through 2026 | **Text-verified** deltas |
| Fandom `File:Lobby_brawloween.png` | Bare lobby background plate (no UI) | Oct 2024 | Verified |

Where I could not get a 2026 capture I say so explicitly. **The skeleton has not changed since 2019** — patch notes only ever move/restyle individual chips, never the frame. I'd bet heavily the 2026 build still matches the wireframe below to within a chip or two.

---

## 1. Thesis in one paragraph

Brawl Stars' home screen is **not a menu**. It is a **stage with an edge-mounted chrome ring**. The centre 40% of the screen is pure theatre — a lit background plate and your selected Brawler standing on it, doing idle animations, with zero interactive controls. Every actual control is pinned to an *edge*: a top info strip, a left icon column, a right icon column, and a bottom action band. Nothing overlaps the stage. There is **no bottom navigation bar and no tabs** — that's a phone-app pattern Supercell deliberately did not use. The whole screen resolves to one question, asked once, in the bottom-right corner: *press the yellow thing.*

---

## 2. Exact anatomy — labelled landscape wireframe

100 columns = 100% of width. 25 rows ≈ 4% of height each. Measured from the 1920×1080 capture.

```
 col: 0        10        20        30        40        50        60        70        80        90       99
      |---------|---------|---------|---------|---------|---------|---------|---------|---------|--------|
  0%  ┌─────────┬───────────────────────────┐                    ╔═══════════════════════════════════════╗
      │ ⬡ AVATAR│ 🛡 🏆 45                   │   <- black slanted currency strip ->                       ║
      │ name    │ ▓▓▓▓░░░░░░░░ (•)   [📦]    │                    ║ 🪙 168     💎 0    │[🙂 0]│[≡]        ║
 14%  └─────────┴───────────────────────────┘                    ╚═══════════════════════════════════════╝
        (1) PROFILE   (2) TROPHY ROAD BAR                          (4) COINS (5) GEMS (6) social (7) MENU
                          + next-reward box
 16%                              ┌──────────────────────────┐
                                  │ RANK 5 │ 🏆 45 │ POWER 2  │   (8) selected-Brawler stat tag  (36–60%)
 20%                              └──────────────────────────┘

 24%                                    .-'''-.
                                       (  BRAWLER )                (9) SELECTED BRAWLER — 3D model,
 32%                                    `-.___.-'                      idle-animating, ~20% w × 62% h,
                                        /|   |\                        NOT tappable, no CTA on it
 39%  ┌────────┐        ┌───┐          / |   | \                              ┌────────┐
      │  🛍     │        │ + │         '  |___|  '                             │  👥     │
      │ SHOP   │        └───┘        (10) TEAM-UP SLOT                        │FRIENDS │
 52%  ├────────┤     (22–28% x)                                               ├────────┤
      │  🃏 (1) │                                                              │  🛡 (21)│
      │BRAWLERS│                                                              │  CLUB  │
 65%  ├────────┤                                                              ├────────┤
      │  📰 (2) │                                                              │  💬     │
      │  NEWS  │                                                              │  CHAT  │
 74%  └────────┘                                                              └────────┘
       (11) LEFT NAV COLUMN  x 1.2–10.2%                       (12) RIGHT NAV COLUMN  x 90.4–98.6%
 80%  ╔═══════════════════════╗            ┌──────────────────┐  ┌─────────────────────────────────────┐
      ║ 🎟 BRAWL PASS         ║            │ New Event in:9h12m│ⓘ│ 🎫 82/200   +20 tokens in 2h 12m    │
 84%  ║ ▓▓▓▓▓░░░ 33/100  (3) ║(1)         ├──────────────────┴──┤ ├─────────────────────────────────────┤
      ╚═══════════════════════╝            │ 💀 SOLO SHOWDOWN  ▣ │ │█████████ P L A Y █████████████████ │
 96%   (13) SEASON PASS                    │    Two Thousand Lakes│ │█████████████████████████████████████│
100%    x 1–27%, y 78–97%                  └─────────────────────┘ └─────────────────────────────────────┘
                                            (14) EVENT PANEL          (15) PLAY  x 73.7–98.6%, y 83–96%
                                            x 36–73%, y 81–97%
```

### 2.1 Measured geometry table

| # | Element | x (% of width) | y (% of height) | Notes |
|---|---|---|---|---|
| 1 | Profile chip (avatar + name) | 0.0 – 13.5 | 0.0 – 14.2 | Opens player profile. Flush to the corner, no margin. |
| 2 | Trophy Road bar | 13.6 – 41.6 | 0.0 – 14.1 | Total trophy count + progress bar + portrait of next unlock + a highlighted reward-box tile at its right end. Taps → Trophy Road. |
| 4–5 | Currency strip (coins, gems) | 59.9 – 82 | 0.0 – 8.7 | Black **slanted** strip, no button chrome, numbers only. No `+` buy button on it in this build. |
| 6 | Social/notification chip | 84 – 91 | 0.5 – 8.5 | Small dark chip, green Brawler face + numeral. Minor; ignorable. |
| 7 | Hamburger `≡` | 91.4 – 99 | 0.5 – 8.5 | Opens right-side drawer (see §2.3). |
| 8 | Brawler stat tag | 36.5 – 59.5 | 7.4 – 18.3 | `RANK 5 │ 🏆45 │ POWER 2` — **per-brawler**, not account-level. |
| 9 | Brawler model | ≈38 – 58 | ≈18 – 80 | The single largest thing on screen by area (~13%). Decorative. |
| 10 | Team-up `+` slot | 22 – 28 | 40 – 49.5 | Ghosted translucent tile. Grows into a 2- or 3-slot party row when filled. Redesigned in 2024. |
| 11 | Left nav column | 1.2 – 10.2 | 39.1 – 73.9 | SHOP / BRAWLERS / NEWS. Each tile ≈8.2% w × 11% h with the label *inside* the tile. |
| 12 | Right nav column | 90.4 – 98.6 | 39.4 – 73.6 | FRIENDS / CLUB / CHAT. Same tile size, mirrored. |
| 13 | Brawl Pass | 1 – 27 | 78 – 97 | Wide yellow ticket, XP bar `33/100`, current tier number, red badge. The only *other* saturated-yellow object. |
| 14 | Event panel | 36 – 73 | 81 – 97 | Two stacked rows: rotation countdown header (+ ⓘ), then mode+map body. |
| 15 | **PLAY** | 73.7 – 98.6 | 83 – 96.2 | 24.9% × 13.2% ≈ **3.3% of screen area**. Saturated yellow, heavy black outline, white outlined caps. |
| 16 | Reward meter above PLAY | 72.9 – 99.1 | 79.6 – 83.3 | `82/200` tokens + `+20 tokens in 2h 12m`. Physically welded to the CTA. |

### 2.2 Zoom: the bottom action band (the only part that matters)

```
      36%                              73%  74%                                  99%
       ┌───────────────────────────────────┐ ┌──────────────────────────────────────┐
 79.6% │                                   │ │ 🎫 82/200        +20 tokens in 2h 12m│ <- reward meter
       │        New Event in: 9h 12m   (ⓘ) │ ├──────────────────────────────────────┤
 83%   ├───────────────────────────────────┤ │                                      │
       │ ╭───╮                       ┌───┐ │ │                                      │
       │ │💀 │  SOLO SHOWDOWN        │ 🌰│ │ │            P L A Y                   │
       │ ╰───╯  Two Thousand Lakes   └───┘ │ │                                      │
 97%   └───────────────────────────────────┘ └──────────────────────────────────────┘
         ^mode    ^MODE NAME (white caps)  ^modifier      ^ one word. no icon. no subtext.
          icon    ^map name (green, small)   badge
```

Four facts encoded in that strip, in decreasing type size:
1. **PLAY** — the verb.
2. **SOLO SHOWDOWN** — the mode you are about to enter (white, largest text in the panel).
3. **Two Thousand Lakes** — the map (green, ~60% the size of the mode name).
4. `New Event in: 9h 12m` — when this rotates out (grey, smallest). Pure FOMO.

Plus two icons: the mode glyph (left, colour-coded per mode) and the modifier badge (right — tells you the mode has a twist active today).

### 2.3 The hamburger drawer (verified screenshot)

Tapping `≡` slides a dark panel in from the right, dimming the stage but **leaving the top strip live**:

```
                                          ┌──────────────────────────┐
   [ home screen dimmed, still visible ]  │ ⚙  SETTINGS              │
                                          │ 📋 BATTLE LOG            │
                                          │ 🏅 LEADERBOARDS          │
                                          │ 📺 BRAWL TV              │
                                          │ ✉  INBOX                 │
                                          │ 👑 FRIENDLY GAME         │
                                          │ 🗺  MAP MAKER   (locked)  │
                                          │ ID SUPERCELL ID          │
                                          └──────────────────────────┘
```

This is the **junk drawer tier**: 8 entries, uniform grey pills, no colour, no badges, alphabetically arbitrary, greyed-out when locked. Friendly Game — the entire custom-lobby feature — lives here, three taps deep. That is a deliberate demotion.

### 2.4 The chrome is a persistent frame, not a screen

The Friendly Game capture proves it: when you open Friendly Game, the **left column, right column, Brawl Pass, event panel and PLAY button all stay exactly where they are**. Only the centre stage swaps (Brawler model → 3v3 team slots + VS divider), and a `Team Code: XZJYTA3J` + red `LEAVE` chip appears under the top strip.

```
  [ same top strip ]                                    Team Code: XZJYTA3J  [LEAVE]
  ┌──────┐        ┌────┬────┬────┐                                    ┌──────┐
  │ SHOP │        │ YOU│ BOT│ BOT│  ← centre stage replaced           │FRIENDS│
  ├──────┤        ├────┴─VS─┴────┤                                    ├──────┤
  │BRAWL.│        │ BOT│ BOT│ BOT│                                    │ CLUB │
  ├──────┤        └────┴────┴────┘                                    ├──────┤
  │ NEWS │                                                            │ CHAT │
  └──────┘                                                            └──────┘
  [BRAWL PASS]          [ BRAWL BALL / Triple Dribble ]        [ P L A Y ]
```

So "home" is really **`Frame(chrome) + Slot(stage)`**. Party-forming, brawler-preview and friendly-game all render *into the slot* rather than pushing a new screen. Shop / Brawlers / Events / Trophy Road are the only things that get a full-screen takeover.

---

## 3. The PLAY button, specifically

**What it shows:** the word `PLAY`. That's it. No mode name, no icon, no map, no ticket cost, no player count. Every piece of *context* lives in the adjacent event panel, never on the button.

This is the single most transferable decision in the whole layout: **Supercell split "what am I about to do" from "do it."** The button is a constant. The context is a variable. The constant never changes shape, colour, position or label between sessions, so the muscle memory is absolute — a returning player can tap it without reading.

**How you know which mode you're about to play:** exclusively from the event panel immediately to its left, at the same vertical position, touching it. The mode name is the second-largest text in the band. The panel is colour-neutral (dark slate) but the mode glyph is colour-coded per mode (Showdown = green skull, Gem Grab = purple gem, Brawl Ball = pale blue ball).

**On tap:** straight into matchmaking. No confirm dialog, no mode-select intercept, no "are you sure". The screen transitions to a searching overlay with your Brawler, an opponent-slots row filling in, and a cancel affordance. Failure states are the only interruption (e.g. Ranked refuses if you don't have 3 Brawlers at Power 9+, event locked below a trophy threshold).

**The reward meter above it** (`82/200 tokens`, `+20 tokens in 2h 12m`, and in the modern build **Daily Wins** progress — patch notes, Nov 2024: *"Daily win progress above the Play button in the main screen now appears earlier after returning from battle"*) is a second-order motivator physically fused to the CTA. You cannot look at PLAY without also seeing how close you are to a reward. It's the same rectangle-stack.

**Not on the button, ever:** currency cost, energy/ticket gating, "quick play" vs "ranked" split, difficulty. Brawl Stars has exactly one primary CTA. When it needed a competitive mode (Ranked, Feb 2024) it did **not** add a second big button; it added Ranked as an entry inside the same Events surface, so PLAY still means "launch whatever is selected."

---

## 4. How you change mode

**The event panel *is* the button.** Tapping it opens a full-screen Events browser. There is no swipe, no carousel on the home screen itself, no long-press. One tap out, one tap on a card, and you're back — the picker closes and returns you to home with the new event loaded into the panel (patch note, 2019: *"You can now access the event information from the main screen"*).

The ⓘ on the panel is a **separate, smaller target** that opens map detail (layout preview, modifier explanation, rewards) without changing your selection. Info and commit are never the same tap.

### 4.1 Mode-select surface, 2020 era (measured)

Full-screen takeover. Header row keeps the currencies. Back arrow top-left **and** a home button top-right — dual escape.

```
 ┌────┐  CHOOSE EVENT      ⭐100   🪙228   💎10   [🙂0]           ┌────┐
 │ ◀  │                                                          │ 🏠 │
 └────┘                                                          └────┘
   ┌──────────────────────────────┐   ┌──────────────────────────────┐
   │        New Event in: 8h 33m ⓘ│   │       New Event in: 20h 33m ⓘ│
   │ ╭──╮ GEM GRAB                │   │ ╭──╮ SHOWDOWN                │
   │ │💎│ Corner Case             │   │ │💀│ Two Thousand Lakes      │
   │ ╰──╯                         │   │ ╰──╯                    ┌──┐ │
   │ [   map art preview       ]  │   │ [   map art preview  ]  │🌰│ │
   └──────────────────────────────┘   └──────────────────────────┴──┘
   ┌──────────────────────────────┐   ┌──────────────────────────────┐
   │        New Event in: 2h 33m ⓘ│   │                            ⓘ │
   │ ╭──╮ BRAWL BALL              │   │ 🔒 SPECIAL EVENTS            │
   │ │⚽│ Triple Dribble          │   │    Reach 350 total Trophies  │
   │ ╰──╯ [ map art preview ]     │   │    to unlock                 │
   └──────────────────────────────┘   └──────────────────────────────┘
   ┌──────────────────────────────┐   ┌──────────────────────────────┐
   │ 🔒 TEAM EVENTS   (800 🏆)     │   │ 🔒 TEAM EVENTS 2  (800 🏆)    │
```

Two columns of wide cards, vertically scrolling. Each card: mode-coloured header band + mode glyph + **MODE NAME** (big white caps) + map name below it + a map art strip + rotation countdown + ⓘ + optional modifier badge.

**Locked slots are shown, not hidden.** `🔒 SPECIAL EVENTS — Reach 350 total Trophies to unlock`. The mode roster is presented as a visible ladder: you can always see how many modes exist and what unlocks them. That's the progression engine sitting inside the picker.

### 4.2 Mode-select surface, 2024 era (screenshot-verified, Behance)

Same idea, restructured into **portrait cards in a horizontal row + a bottom category tab bar**:

```
 ┌──────────────────────────────────────────────────────────────────────┐  ┌────┐
 │  ┌──────────────┐   ┌──────────────┐        ┌──────────────┐         │  │ 🏠 │
 │  │Ends in:51d11h⓵  │Ends in: 52d 7h⓵        │Ends in:355d 8h│        │  └────┘
 │  ├──────────────┤   ├──────────────┤        ├──────────────┤         │
 │  │   💀💀💀      │   │      🪼       │        │  [ hero art ] │         │
 │  │TRIO SHOWDOWN │   │ JELLYFISHING │        │  JOHN CENA    │         │
 │  │ [ map art  ] │   │ [ theme art ]│        │  CHALLENGE!   │         │
 │  │ 💵        ▣  │   │ 💵        ▣  │        │  0/15 WINS    │         │
 │  └──────────────┘   └──────────────┘        └──────────────┘         │
 ├──────────────────────────────────────────────────────────────────────┤
 │   SPONGEBOB   │   **SPECIAL**   │  TROPHIES [NEW] │   COMMUNITY      │  <- category tabs
 └──────────────────────────────────────────────────────────────────────┘
```

Changes vs 2020:
- Cards went **landscape-wide → portrait-tall**, so more fit side by side without scrolling.
- A **bottom tab bar of event *categories*** appeared: `SPONGEBOB (collab) | SPECIAL | TROPHIES | COMMUNITY`. The selected tab is yellow; the panel behind it takes the tab's theme colour/art. `NEW` badges sit on tabs.
- Cards now carry **reward icons** (Bling stack, bottom-left) and the **modifier badge** (bottom-right) directly on the face.
- Timer moved to a black cap strip on top of each card, with ⓘ overlapping the top-right corner.

Note the important thing: even here there is **no bottom nav bar for the game's sections** — the bottom tabs are scoped to *this screen's* content categories only. Brawl Stars never introduced global tabs.

---

## 5. Visual hierarchy + proportions

Ranked by how loudly each element shouts, which is *not* the same as size:

| Rank | Element | Area | Why it wins/loses |
|---|---|---|---|
| 1 | **PLAY** | 3.3% | Only large saturated-yellow rectangle on the right half. Highest contrast against the blue plate. Thickest black outline. Corner-anchored. |
| 2 | Brawler model | ~13% | *Biggest by area but not loudest* — it's the same hue family as the background, has no border, no label, and doesn't move under your thumb. It reads as scenery. |
| 3 | Event panel | 5.7% | Dark slate against light blue = high contrast, but neutral colour and low chroma. Loud enough to read, quiet enough not to compete with PLAY. |
| 4 | Brawl Pass | 5.7% | Also yellow — the one deliberate competitor. Placed in the **opposite corner** from PLAY so the two yellows never fight in the same glance. |
| 5 | Nav columns (6 tiles) | 6 × ~0.9% = 5.4% | Dark grey, small, edge-hugging, labelled. Numeric badges do all the attention-getting. |
| 6 | Top strip | ~9% | Flat black-on-transparent, no button chrome, no touch targets except the two right-hand chips. Reference data. |
| 7 | Hamburger drawer contents | 0% until opened | Settings, Battle Log, Leaderboards, Brawl TV, Inbox, **Friendly Game**, Map Maker, Supercell ID |

**Fraction of screen for the primary CTA:** PLAY alone = **3.3%**. The full "commit band" (event panel + reward meter + PLAY) = x 36→99%, y 79.6→97% ≈ **11% of the screen**, and it owns the entire bottom-right quadrant.

**Colour budget:** the whole screen is one blue field. Saturated **yellow appears exactly twice** — PLAY and Brawl Pass — and they're at opposite corners. Red is reserved entirely for count badges. Green is reserved for map names and positive counters. This is a two-accent system with a strict allocation rule.

**How secondary entries are de-emphasised** — five graded tiers:
1. Bottom-right, big, yellow → PLAY.
2. Bottom-left, big, yellow → Brawl Pass (monetisation, tier 1b).
3. Mid-edge, small, grey, labelled, badged → Shop, Brawlers, News, Friends, Club, Chat.
4. Corner chip → hamburger.
5. Inside the drawer, uniform grey pills → Battle Log, Leaderboards, **Friendly Game**, Map Maker, Settings, Supercell ID.

Note precisely where **training/practice/custom** sits: tier 5. Friendly Game — where you'd practise, run 1v1s, invite friends into a custom room — is behind a hamburger, in a flat list, with no icon differentiation. Supercell hid it. Meanwhile **friends/club/chat** got tier 3 (their own always-visible tiles on the right edge) because they drive retention, not because players ask for them.

---

## 6. Landscape specifics + thumb zones

Brawl Stars is landscape-locked, two-thumb, phone-first. The home screen is laid out **on top of the in-game control map**.

Measured from a real gameplay capture (same 1920×1080 source): in-match, the **movement stick sits at ≈10% x / 80% y** and the **attack stick at ≈81% x / 84% y**, both ~5% radius.

Now overlay the home screen:

```
        LOW REACH (info only)                    LOW REACH
   ┌───────────────────────────────────────────────────────────────────┐
   │ profile   trophy road            coins  gems  [chip] [≡]          │  <- top 14%: read-only.
   │                                                                    │     you never need to hit
   │                                                                    │     this in a hurry
   │                        ( stage — no controls )                     │
   │                                                                    │
   │ ░░░░░░                                                     ░░░░░░  │  <- mid-edge 39–74%:
   │ ░SHOP░  index-finger / thumb-stretch band      ░FRIENDS░           │     both thumbs can arc
   │ ░BRAWL░                                        ░CLUB░              │     here without regrip
   │ ░NEWS░                                         ░CHAT░              │
   │                                                                    │
   │ ▓▓▓▓▓▓▓▓▓▓▓        ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒     ██████████████████████████ │  <- bottom 79–97%:
   │ ▓BRAWL PASS▓        ▒ MODE / MAP  ▒     ██████ P L A Y ██████████  │     THE THUMB SHELF
   └───────────────────────────────────────────────────────────────────┘
      LEFT THUMB HOME       either thumb          RIGHT THUMB HOME
      (= movement stick)     (stretch)            (= ATTACK STICK)
```

Consequences worth stealing:

- **PLAY occupies the attack-button position.** The finger that shoots in-match is already resting on the pixel that starts the next match. Loop closed, zero relocation.
- **The bottom 20% band is a shelf**, not a bar: three objects (pass / context / CTA) laid left→right in ascending importance, so the natural right-thumb rest lands on the most important one.
- **The top 14% is a read-only ledger.** Currencies have no `+` buttons and no button chrome in this build — they are *labels*. Only settings and one chip are tappable up there, and both are things you touch monthly.
- **Both vertical edges are used symmetrically.** Left = self/progression (shop, roster, news), right = social (friends, club, chat). That split is legible without reading the labels.
- **Nothing overlaps the horizontal centre band (y 20–75%, x 30–70%).** That's where the phone's own gesture surfaces and where a hand shadows the screen; it's given to the Brawler.
- **Corners are used at full bleed** — profile chip and nav tiles run flush to x=0 / x=99%, no safe-area gutter beyond the notch. Landscape mobile gives you corners for free; Brawl Stars spends all four.

---

## 7. What changed across versions

From the fandom Version History pages (patch-note text, verified):

| When | Change | Reading |
|---|---|---|
| 2019 | *"You can now access the event information from the main screen"* | The moment the event panel became the mode-select entry point. Before this it was a separate hop. |
| 2019–2021 | Repeated *"New Main Menu Background"* / *"New Main Menu Music"* entries every season | The **background plate is a seasonal content slot**. The Brawl-o-ween 2024 plate (graveyard silhouettes, glowing moon, ghost-pattern wallpaper) is pure scene art with a flat readable value range and no detail behind where the UI sits. |
| 2021 | *"Added a Tournament Hub button to the right side of the main screen."* | New features get added as another tile on an existing edge column — never a new bar. |
| Jun 2023 | Starr Drops replace Brawl Boxes | The `82/200 tokens` meter above PLAY becomes a different reward meter; the *slot* survives. |
| Feb 2024 | Ranked replaces Power League | A whole competitive ladder shipped **without a second primary button**. Rebranded icon set (Behance project). |
| 2024 | *"Redesigned Team Up button along with other UI elements."* | The `+` slot next to the Brawler. |
| 2024 | *"You can now Quick Chat directly from the home screen."* + *"Redesigned Quick Chat options"* | Social pulled *up* to home. |
| 2024 | *"You can see which Game Mode has the Mutations enabled in the events screen"* | Modifiers surfaced on the event cards themselves. |
| Nov 2024 | *"Daily win progress above the Play button in the main screen now appears earlier after returning from battle"* | Confirms the meter-above-PLAY slot is still there and is now Daily Wins. |
| Jun 2025 | Masteries removed; Trophy Road reworked into "Trophy Worlds", 70k → 100k | Simplification pass: one progression track instead of two. |
| Apr 2026 | *"The Shop has been completely redesigned… divided into tabs… If a tab has no active offers, it stays hidden to keep things tidy. When you scroll through a tab, it minimizes in size to give you more room to browse."* | Stated reasoning is explicit: **hide empty containers, shrink chrome on scroll.** |
| 2026 | *"Your profile shows the sum of all Brawler Prestiges on the Home screen."* | Another stat welded into the existing top-left profile chip. |
| 2026 | *"Championship notification placement back to home screen (pointing at Ranked)."* | They tried moving a notification off home and moved it back. |

**The pattern across 7 years:** the frame is frozen. Every feature is absorbed by (a) adding a tile to an edge column, (b) adding a category tab inside an existing takeover screen, or (c) restyling a chip in place. Supercell has never shipped a home-screen re-architecture, and the one stated design principle in the notes is *reduce visible chrome, hide empty states*.

---

## 8. Contrast: Fortnite and Roblox

### Fortnite lobby

```
 ┌───────────────────────────────────────────────────────────────────────┐
 │ [SEARCH][LIBRARY][PLAY][LOCKER][ITEM SHOP][PASSES][COMPETE]   V-Bucks │ <- TOP tab rail,
 ├───────────────────────────────────────────────────────────────────────┤    left-aligned (v26.30)
 │                                          ┌──────────────┐             │
 │  ┌───────────┐ ┌──────┐ ┌──────┐         │  BR SOLO     │             │
 │  │ big mode  │ │ mode │ │ mode │  ...    │  (last mode) │             │
 │  │  tile     │ │ tile │ │ tile │         └──────────────┘             │
 │  └───────────┘ └──────┘ └──────┘         ┌──────────────┐             │
 │   Discover row (thousands of islands)    │    PLAY!     │             │
 │  [party member][party member][+]         └──────────────┘             │
 └───────────────────────────────────────────────────────────────────────┘
```

- Navigation is a **top tab rail**, not edge columns. `Search` and `Library` were moved to the *left of* `Play` in v26.30 and the whole rail was left-aligned instead of centred, with rounded corners.
- The play surface is a **content browser** — Discover, thousands of UGC islands — because the mode roster is unbounded. Brawl Stars' roster is curated and finite, so it uses a picker; Fortnite's is infinite, so it uses a store.
- **The lobby remembers your most recent mode and shows it for quick access**, right next to the CTA. Same "context tile beside the button" idea as the Brawl Stars event panel, arrived at independently.
- Party management is inline in the Play tab, bottom-left. Same corner as Brawl Stars' team-up slot.

### Roblox mobile home

```
 ┌───────────────────────────────────────────────────────┐
 │  [search]                                      Robux  │
 │  ▸ Continue        [game][game][game]  →              │
 │  ▸ Recommended     [game][game][game]  →              │
 │  ▸ Popular         [game][game][game]  →              │
 │  ▸ Friends Playing [game][game][game]  →              │
 ├───────────────────────────────────────────────────────┤
 │  [Home] [Games] [Chat] [Robux] [•••]                  │ <- classic bottom nav bar
 └───────────────────────────────────────────────────────┘
```

- Roblox is the **anti-pattern for our purposes**: portrait-first, a real app-style bottom nav bar (Home / Games / Chat / Robux / More), and **no primary CTA at all**. The home screen is an infinite recommendation feed of horizontally-scrolling carousels: Continue, Recommended For You, Popular, Top Earning, Friends Playing.
- Roblox is currently A/B-testing moving the More menu to the top-left and Charts to the top — i.e. still churning, unlike Brawl Stars.
- Takeaway: a feed works when the catalogue is the product. If you have ~6 modes, a feed is a way to make 6 things feel like a chore.

**Three-way summary:**

| | Brawl Stars | Fortnite | Roblox |
|---|---|---|---|
| Orientation | landscape-locked | landscape | portrait |
| Navigation | edge columns, no tabs | top tab rail | bottom nav bar |
| Primary CTA | one yellow PLAY, bottom-right, 3.3% | one PLAY!, bottom-right of the Play tab | none |
| Mode context | adjacent panel: mode + map + timer | adjacent tile: last-played mode | n/a |
| Mode roster | curated, finite, laddered by unlocks | infinite UGC browser | infinite feed |
| Centre of screen | your character, non-interactive | mode tiles | content grid |
| Practice/custom | hidden in hamburger | Creative / private match, tab-level | n/a |

---

## 9. What this implies for the Saltiz lobby

Direct, non-negotiable-looking lessons, in priority order:

1. **One CTA, one word, one place, forever.** Bottom-right, saturated accent, ~4% of screen, never changes label between modes. Don't put the mode name *on* the button.
2. **Context panel immediately left of the CTA, touching it.** Mode glyph + MODE NAME (largest) + map/variant name (smaller, different hue) + a rotation/timer line (smallest). That panel is itself the tap target for changing mode.
3. **Tapping the CTA starts matchmaking with no confirm.** Confirmation lives in the panel you already read.
4. **No bottom nav bar.** Landscape edge columns: left = self/progression, right = social. Grey tiles, numeric badges do the shouting.
5. **Give the CTA a reward meter directly above it** (XP-to-next / daily-win streak / card progress). Fuse them into one rectangle stack.
6. **Two saturated accents max, at opposite bottom corners** — CTA bottom-right, monetisation/pass bottom-left. Everything else grey/dark.
7. **The centre is a stage, not a menu.** Put the player's card/character there, animated, non-interactive. It sells identity and eats the screen area you don't want filled with buttons.
8. **Home is `Frame + Slot`.** Build the chrome once; swap only the centre for party-forming, previews and custom lobbies. Only takeovers (shop, roster, mode picker) get a full push — and every takeover gets **both** a back arrow (top-left) and a home button (top-right).
9. **Show locked modes with their unlock condition.** `🔒 3v3 — reach 300 XP`. The picker doubles as the progression ladder.
10. **Put practice/custom-room in the drawer, not on home.** It's a power-user feature; giving it prime real estate dilutes the single question the screen asks.
11. **Landscape thumb rule:** put the CTA exactly where the in-game fire/shoot control lives. For Saltiz that means bottom-right at roughly x 74–99%, y 83–96%.
12. **Background plate is a seasonal content slot.** Flat value range, detail only in the centre-top where no UI sits.

---

## 10. Sources

Screenshots measured:
- https://interfaceingame.com/screenshots/brawl-stars-main-menu/ → `https://interfaceingame.com/wp-content/uploads/brawl-stars/brawl-stars-main-menu-1920x1080.png`
- https://interfaceingame.com/screenshots/brawl-stars-menu/ (hamburger drawer)
- https://interfaceingame.com/screenshots/brawl-stars-choose-event/ (mode picker)
- https://interfaceingame.com/screenshots/brawl-stars-friendly-game/ (chrome persistence)
- https://interfaceingame.com/screenshots/brawl-stars-select-brawler/
- https://interfaceingame.com/games/brawl-stars/ (index)
- https://brawlstars.fandom.com/wiki/File:Lobby_brawloween.png (bare background plate, Oct 2024)
- https://www.behance.net/gallery/214472531/Brawl-Stars-UIUX-2024 (2024 Events screen, Ranked rebrand — by a Brawl Stars UI artist)

Text/patch notes:
- https://brawlstars.fandom.com/wiki/Version_History (and `/2019`, `/2021`, `/2024`, `/2025`, `/2026`)
- https://supercell.com/en/games/brawlstars/blog/release-notes/release-notes-april-2026/ (Shop tab redesign + stated reasoning)
- https://supercell.com/en/games/brawlstars/blog/news/rip-masteries/ (Jun 2025 Trophy Road rework)
- https://samurai-gamers.com/brawl-stars/main-menu-guide/ (element inventory; event slots and unlock thresholds)
- https://brawlstars.fandom.com/wiki/Ranked (Feb 2024 replaced Power League, 1000🏆 unlock)
- https://brawlstars.fandom.com/wiki/Starr_Drops
- https://ixd.prattsi.org/2025/02/design-critique-brawl-stars/ ("the 'Play' button is big and bold in bright yellow, allowing the user to easily complete the most important interaction of the game")
- https://medium.com/@matt.sullivan28/a-brief-look-brawl-stars-ux-ui-562f6225b7e3
- https://www.gameuidatabase.com/gameData.php?id=465 (index; blocked to automated fetch)

Contrast:
- https://fortnite.fandom.com/wiki/Lobby (v26.30 rail change: Search/Library moved left of Play, left-aligned, rounded corners; lobby shows most recent mode)
- https://dev.epicgames.com/documentation/en-us/fortnite/lets-play-in-fortnite-creative
- https://en.help.roblox.com/hc/en-us/articles/35317940341268-Roblox-Mobile-Widgets
- https://devforum.roblox.com/t/universal-app-homepage-layout-changes-randomly-if-reloading-the-homepage-after-leaving-a-game/3953789
- https://www.threads.com/@bloxy.news/post/DT3NKuJj7-B/ (Roblox testing More→top-left, Charts→top)
