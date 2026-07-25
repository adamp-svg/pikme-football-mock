# Lobby Adaptation — mapping a Brawl-Stars home screen onto the Saltiz football hub

> Design doc. **Nothing implemented; no `.js` / `.html` / `.css` touched, no commit.**
> Agent `lobby-adapt`, 2026-07-25. Verified against `public/index.html`, `public/style.css`,
> `public/client.js`, `public/trophies.css`, `public/_layout-edit.js` as they stand today.
>
> Sibling specs from this pass: `2026-07-25-lobby-game-picker.md` (the audit + the `MODES`
> refactor this doc builds on), `-3v3-mode.md`, `-mode-polish.md`, `-new-minigames.md`,
> `-mode-roster-research.md`. Two more agents (`bs-home`, `bs-modepick`) are documenting
> Brawl Stars' actual screens; this doc is the **adaptation and the constraints**, and it
> deliberately does not re-derive their research.

---

## 0. TL;DR

- **The user's 6 entries are the lobby's *play menu*, not the lobby's whole content.** Brawl
  Stars' home screen is also "one PLAY button + an event chip + four nav buttons" *and* a
  brawler portrait, a trophy counter, coin/gem chips and a friends button. The rule that makes
  "exactly six and nothing else" honest is: **nothing outside the six may look like it starts
  or picks a game.** Everything else on the hub is identity, progression, or loadout.
- **Three current hub controls violate that rule and must leave the lobby**: the `.hub-arena`
  "כדורגל · 2 נגד 2 / החלף מגרש" link (a 7th play entry whose subtitle is also false),
  `#goal-brawl-btn` (an 8th — it becomes a row in Pick Game, where it already lives in `MODES`),
  and `#select-best-btn` (not a play entry — it is a loadout action wearing a play button's
  clothes; it moves into the album-chip cluster).
- **The baked 900×415 absolute stage stays.** Every concept below is expressed as new
  `left/top/width/height` values in the `BAKED LOBBY LAYOUT` block. Going to flow layout would
  mean re-deriving 22 hand-tuned boxes, breaking `?edit=1`, and breaking `fitHub()`'s "one
  canvas" scaling promise. The one flow exception already exists and is the right pattern:
  `#play-strip` is **one baked box** whose children flow inside it.
- **Quick Play plays the last-selected mode (default 2v2), and Pick Game changes the
  selection.** That is Brawl Stars exactly, and it is only legitimate because the selection is
  printed on a chip 8 px above the gold button. Justification and the rejected alternatives are
  in §3.
- **Recommended concept: A′ — "Brawl-faithful + fixed quad rail"** (§4.1). It is the most
  BS-like, it is the *smallest* diff to the baked layout (the gold button does not move at all),
  and it kills the invisible-scroll bug (P6 in the sibling audit) by making the utility rail a
  fixed 4-up row instead of a 6-item scroller.
- **The 6-entry lobby is only stable long-term because Pick Game absorbs growth.** With
  `new-minigames` proposing 10–14 concepts and `mode-3v3` adding another, any design that puts
  modes on the hub is a design that breaks in one sprint. Pick Game is the growth valve; that
  is the strongest structural argument for the user's own decision.

---

## 1. The constraints, stated precisely

### 1.1 The baked stage — the single biggest constraint

`#home .hub` is a **fixed 900 × 415 logical stage** (`style.css:792`), `transform:
translate(-50%,-50%)` plus a `scale()` appended by `fitHub()` (`client.js:1935-1943`):

```js
const HUB_W = 900, HUB_H = 415;
const s = Math.min(window.innerWidth / HUB_W, window.innerHeight / HUB_H);
hubStageEl.style.transform = 'translate(-50%,-50%) scale(' + s + ')';
```

Every control is a **direct child of `.hub`**, anchored by the selector list at
`style.css:1730-1744` (`position:absolute; right:auto; bottom:auto; margin:0`) and then given
explicit `left/top/(width/height)` in logical stage px at `style.css:1746-1823`. `hub-trwrap`
is the same pattern but lives in `trophies.css:10-20` because the trophy feature was kept out
of `style.css` to avoid a collision with the lobby redesign.

Consequences any redesign must honour:

| # | Consequence |
|---|---|
| C1 | A new element is **invisible/misplaced until it is added to the anchor selector list** at `style.css:1730-1744` *and* given a baked `left/top` rule. Two edits, not one. |
| C2 | Sizes are **logical px, not responsive**. A 12 px font is 12 px at 900-wide and scales with the stage. There is no breakpoint, no `%`, no `vw`. Design at 900×415 or don't design. |
| C3 | The stage fills the viewport width on any phone wider than 900/415 = 2.169:1... and every modern landscape phone is *narrower* than that (19.5:9 = 2.167:1 — essentially exactly at the limit). In practice **scale is width-bound and the stage's x=0 sits at the viewport's left edge**, i.e. **under the landscape notch**. Anything at x < ~48 or x > ~852 is at risk. Today `#play-strip` starts at x=12. |
| C4 | `_layout-edit.js` `applySaved()` runs on **every** load and re-applies `localStorage['pikme-lobby-layout']` as **inline styles**, which beat the baked CSS. **Any developer who has ever opened `?edit=1` and saved will keep seeing the OLD layout after the redesign ships.** → Bump `LS_KEY` to `pikme-lobby-layout-v2` in the same commit. This is the #1 "it works for me" trap in this change. |
| C5 | New boxes need a `descriptors()` entry in `_layout-edit.js:41-66` or they are un-editable. That list has **already drifted**: `#rank-btn`, `#hub-tier` and `.hub-trwrap` are baked in CSS but absent from the editor. |
| C6 | `#power-slots` is a **full-stage transparent overlay** (0,0,900,415, `pointer-events:none`) whose three `.pslot-item` children are positioned individually by `:nth-child`. `renderPowerSlots()` wipes and rebuilds them, which is why `window.__lobbyApplyLayout` exists. Do not convert the slots to flow. |
| C7 | Overlap is normal and z-managed, not forbidden: the hero (`z4`) deliberately paints over `#hub-tier` (`z3`); the gold button already overlaps the hero's right 20 px. New boxes near the hero need an explicit `z-index`. |

**Verdict for every concept below: keep the baked absolute stage.** The only sanctioned flow
container is the one that already exists — a single baked box (`#play-strip`) with flowing
children. Concepts that need a row of equal buttons reuse that pattern rather than inventing
per-button baked coordinates, because per-button coordinates are what makes the row impossible
to re-balance later.

### 1.2 The rest

- **RTL Hebrew.** `.hub` is `dir="rtl"`. The **start edge is the RIGHT**. The primary action
  belongs at the right; a "‹/›" chevron points *left* for "forward".
- **Landscape phone in a WebView** inside the Saltiz RN app. Thumbs own the two bottom corners;
  the top 100 px and the horizontal centre are look-only zones. `window.prompt` is a no-op here
  (see `#field-name-modal`) — never plan a native dialog.
- **`MODES` is already the single source of truth** (`client.js:1956-1969`) with
  `renderModeList()` (1984), `renderAllModeLists()` (2001) and one delegated
  `.modecard[data-mode-id]` click handler (2005-2024) serving `#arena`, `#party` and
  `#game-select`. **Build on it. Do not add a second list.**

---

## 2. Reconciliation — where every survivor goes

### 2.1 The rule that makes "exactly six" true

> **A lobby control may exist outside the six if and only if it neither starts a match nor
> chooses what match to start.** Identity, progression, loadout and meta-navigation are not
> entries.

This is not a loophole; it is the same line Brawl Stars draws. Their home screen carries a
brawler portrait, trophy/coin/gem counters, a profile button, a friends button and a 5-tab
bottom nav — and still reads as "one PLAY button", because only PLAY and the event chip start
or choose a game.

To keep that legible, the redesign gives the hub **three visual languages that never mix**:

1. **Play language** — the six entries. Gold for the primary, dark-green bevelled `.hub-mode`
   pills for the rest. Nothing else on the hub may use these.
2. **Meta language** — the 52×52 `.hub-sat` icon squares (news / rank / shop / friends / clubs).
   This is the bottom-nav equivalent. It stays on the left/right edges, off the play band.
3. **Status language** — chips, bars and badges. Never bevelled, never gold, never tappable
   except where they already are.

### 2.2 Survivor table — every box on the hub today, with a verdict

| Element | Today (baked) | Verdict | Where it goes |
|---|---|---|---|
| `#home-face` (`.hub-pfp`) | 95,15 55×55 | **KEEP** | Unchanged. Identity, top-left. |
| `#home-name` (`.hub-name`) | 95,80 | **KEEP** | Unchanged, under the pfp. |
| `#home-online` (`.hub-online`) | 757,60 | **KEEP** | Unchanged, top-right. Status language. Sibling spec's "hide below N=10" rule is a good future tweak, not required here. |
| `#hub-trophies` / `.hub-trwrap` | 410,10 325 wide (`trophies.css`) | **KEEP** | Unchanged — it is the headline progression number and it already owns the top-centre slot. |
| `#hub-xp` / `.hub-xpbar` | 410,10 → 410,74 when `.has-trophies` | **KEEP** | Unchanged. Secondary track under trophies. |
| `#chip-copies` / `#chip-worth` / `#chip-cards` | 210/278/346, 15, 60 wide | **KEEP** | Unchanged. Album cluster, top-left band. |
| `#hub-rank` (collector badge) | 283,58 50×42 | **KEEP** | Unchanged — anchored under the worth chip, part of the album cluster. |
| `#hub-tier` (rank badge over hero) | 590,58 50×42 | **KEEP, nudge** | Add `.hub.has-trophies > #hub-tier { top: 78px }`. Today it collides with the bottom 10 px of `.hub-trwrap` when trophies are on. |
| `#pick-hero-btn` + `#home-char` | 490,75, char 250 wide | **KEEP** | Unchanged. The hero *is* the screen's centrepiece — it is Brawl Stars' brawler portrait and the wardrobe entry. Never a play entry. |
| `#power-slots` (3 `.pslot-item`) | overlay; x455 w55 h86, tops 65/160/255 | **KEEP** | Unchanged column beside the hero. Loadout language. |
| `#home-carousel` / `.hub-cards` | 185,75 265×276 | **KEEP, shave** | Height 276 → 264 so it clears the new fixed play row (today it already overhangs `#play-strip` by 8 px). |
| `.hub-sat` news / shop / clubs | 95,175 · 95,110 · 795,175 | **KEEP** | Unchanged. Meta language. |
| `#rank-btn` | 95,240 | **KEEP** | Unchanged. |
| `#friends-btn` (+ dot / unread) | 795,110 | **KEEP** | Unchanged. **Note it is *not* entry #3** — this is the friends *list/social* screen; entry #3 (`#play-friends-btn`) is the party-match flow. Two different things that must keep two different labels. |
| `#hub-settings` | 809,15 38×38 | **KEEP** | Chrome, not an entry. |
| `.hub-season` ("עונה 1") | 743,13 | **CUT, folded** | It is a floating label with no home. Fold the text into entry #6's sub-line (`טורניר · עונה 1`), which gives the season a real destination and de-clutters the top-right. Reversible in one line if the user disagrees. |
| `#quick-match-btn` | 720,290 132×104 | **KEEP = entry #1** | Does not move. Its handler changes (§3). |
| `#select-best-btn` ("הכי טוב") | 745,245 110×32 | **KEEP, RELOCATE** | **Not a play entry** — it equips the album's top-3. It currently sits in the play corner wearing a `.hub-mode` class, which is exactly the confusion the 6-entry rule exists to kill. Move it into the album-chip row at **152,15 54×40** as a chip-button (`✨ / הכי טוב`), next to copies/worth/cards where its meaning is obvious. Its 720,245 slot is where the mode chip goes. |
| `.hub-arena` ("כדורגל · 2 נגד 2 · אצטדיון הבלוקים · החלף מגרש") | in `#play-strip` | **CUT** | A 7th play entry, duplicating both Quick Play and Pick Game, whose "החלף מגרש" subtitle is **false** (pitch selection lives in the builder's `#field-picker`). Its `data-open-screen="arena"` role is inherited by the mode chip. |
| `#goal-brawl-btn` | in `#play-strip` | **CUT from the hub** | An 8th play entry. `brawl` is already a live row in `MODES`; it belongs in Pick Game. Keep the id nowhere — delete the element and the `client.js:2092` shortcut with it. |
| `#tournament-btn` | in `#play-strip`, `<div aria-disabled>` | **PROMOTE = entry #6** | Becomes a real `<button>` in the fixed rail with the season sub-line, tappable → teaser (never a dead div). |
| `#play-friends-btn` | in `#play-strip` | **KEEP = entry #3** | Moves into the fixed rail. |
| `#training-btn` | in `#play-strip` | **KEEP = entry #4** | Moves into the fixed rail. Still opens `#train-choose`. |
| `#field-builder-btn` | in `#play-strip` | **KEEP = entry #5** | Moves into the fixed rail. |
| `#play-strip` (the scroller) | 12,343 685×52, `overflow-x:auto` | **REPLACE** | Becomes `#play-row`: same "one baked box, flowing children" pattern, but **fixed 4-up, no scroll**. Drop `scroll-snap`, `overflow-x`, and the `strip.scrollLeft = 0` reset in `showScreen()` (`client.js:696-698`). |
| — | — | **NEW** | `#mode-chip` = entry #2 (בחר משחק), at the vacated 720,245 slot. |

**Nothing is silently dropped.** Two elements are cut (`.hub-arena`, `#goal-brawl-btn`), both
because they are duplicate play entries; one label is folded (`.hub-season`); one is relocated
(`#select-best-btn`); one is promoted from a dead div to a real entry (`#tournament-btn`).

### 2.3 The entry ↔ destination map

| # | Entry | Element | Action |
|---|---|---|---|
| 1 | משחק מהיר | `#quick-match-btn` (gold) | `launchMode(selectedModeId)` → queue/VS overlay |
| 2 | בחר משחק | `#mode-chip` (new) | `showScreen('arena')` — the picker |
| 3 | שחק עם חברים | `#play-friends-btn` | `openFriendSelect()` → `#party`, carrying `selectedModeId` |
| 4 | אימון | `#training-btn` | `#train-choose` (ground / vs-bots) — unchanged |
| 5 | בונה מגרש | `#field-builder-btn` | `showScreen('builder')` — unchanged |
| 6 | טורניר | `#tournament-btn` | Teaser panel (or `#news`) — never silent |

---

## 3. The crux: Quick Play vs Pick Game

### 3.1 The problem

Brawl Stars has **one** control: a giant yellow PLAY that plays whatever event card is
currently shown above it. The user wants **two** controls: a "Quick Play" *and* a separate
"Pick Game". If both are launchers, the hub has two competing primaries and the player must
learn which is which. If Quick Play is hardcoded to 2v2, then Pick Game's selection is
throwaway state and the newest mode is permanently one tap further from the player than the
oldest one.

### 3.2 The three candidate resolutions

| | R1 — Quick Play is always 2v2 | R2 — Quick Play plays the selection (**recommended**) | R3 — both launch; Pick Game rows launch immediately |
|---|---|---|---|
| Gold button | hardcoded `quickMatch` | `launchMode(selectedModeId)`, default `2v2` | same as R2 |
| Picker rows | launch immediately | **select only**; a docked gold `שחק` in the picker launches | launch immediately **and** set the selection |
| Taps to replay a non-default mode | 3, every single time | 1 | 1 |
| Can you change the default without playing? | n/a (no default state) | yes | **no** |
| Brawl-Stars fidelity | low — BS's PLAY is never mode-locked | **exact** | medium |
| Failure mode | goal-brawl and every future mode are permanently second-class; the newest content is the hardest to reach (the sibling audit's P6/P9 in a new costume) | sticky state can surprise a returning player | you cannot browse without committing; a curious tap starts a match |

### 3.3 Recommendation — R2, with four guards

**Quick Play plays the last-selected live mode; it defaults to 2v2; Pick Game changes the
selection.** This is the Brawl Stars contract and the Fortnite Homebar contract (Discover
defaults to your last played island) at the same time.

R2's only real risk is *hidden state* — the player presses a button whose behaviour changed
while they weren't looking. Four guards remove it, and the first one is load-bearing:

1. **The selection is never hidden.** `#mode-chip` sits 8 px above the gold button and always
   names the selected mode. This is precisely why BS gets away with a mode-agnostic PLAY: the
   event card is right there. **If the chip is ever cut, R2 must be downgraded to R1.**
2. **The gold button's own copy stays truthful.** Big label = `משחק מהיר` (the user's word, and
   true for every mode — the promise is *time-to-match*, not a specific ruleset). Sub-label =
   the selected mode's format facts, live: `2 נגד 2 · עד 2 דק׳ · ראשון ל-3` vs
   `2 נגד 2 · 2 דק׳ · הכי הרבה גולים`. The mode *name* appears once (chip), the *rules* once
   (button). No redundancy, no lie.
3. **Only live modes can become the selection.** Tapping a `state:'dev'` row shows the teaser
   and leaves the selection alone. On boot, validate the persisted id against `MODES` and fall
   back to `2v2` if it is unknown or no longer live — so removing a mode can never brick the
   gold button.
4. **Every launcher writes the selection.** Launching from `#party` / `#game-select` / anywhere
   sets `selectedModeId` too, so the lobby always describes what will actually happen.

Persist as `localStorage['pikme-mode']` (the key the sibling spec already reserves).

### 3.4 What "very similar to how Brawl Stars does game pick" then means concretely

- One dominant gold button; nothing else on the screen is gold.
- The current pick is a **chip directly above it**, not a menu you have to remember opening.
- The picker itself is a **vertical list of full-width mode slots**, not a grid of tiles — the
  slot is stable, its contents change. Card anatomy per the sibling spec §3.2:
  `icon · name · format facts · status pill`.
- **Locked rows stay visible and tappable** and say a true thing (BS shows the unlock trophy
  count; we show `בפיתוח · עונה 1` plus a teaser, since we have no grind curve to gate on).
- Selecting closes the picker and returns to the hub with the chip updated and the gold button
  pulsing once — the "your pick landed" feedback BS gives with its event-card swap.

---

## 4. Four layout concepts

> **On the wireframes:** boxes are labelled in English with a Hebrew legend under each frame.
> Mixing RTL Hebrew into ASCII art makes the bidi algorithm reorder the box-drawing characters
> and the diagram stops being readable in half the editors people will open this in. **The
> layouts themselves are RTL: the start edge is the RIGHT, and the primary action is always in
> the bottom-right corner.** All coordinates are logical stage px (900 × 415).

### 4.1 Concept A′ — "Brawl-faithful + fixed quad rail" ★ RECOMMENDED

**Thesis:** one gold PLAY in the RTL-start thumb corner with the selected-mode chip stacked on
top of it, and the four non-matchmaking entries as a fixed, non-scrolling 4-up rail in the
opposite thumb corner — Brawl Stars' PLAY + event card, with BS's bottom nav rotated into the
space we actually have.

```
 x=0                                                                                x=900
  ┌──────────────────────────────────────────────────────────────────────────────────┐
  │ [pfp ]  [★][cp][wo][cd]   ┌ TROPHIES 410..735 ────────────┐              [ ⚙ ]  │ y=15
  │  name         [rank]      └ XP bar (drops to y=74) ───────┘        ● 24 online   │ y=60
  │                                                                                   │
  │ [shop]                        ┌ pwr2 ┐   ┌───────────┐                [friends]  │ y=110
  │              ╔════════════╗   └──────┘   │           │                            │
  │ [news]       ║   CARD     ║   ┌ pwr0 ┐   │   HERO    │                 [clubs]   │ y=175
  │              ║  CAROUSEL  ║   └──────┘   │  (tap →   │                            │
  │ [rank]       ║  185..450  ║   ┌ pwr1 ┐   │ wardrobe) │                            │ y=240
  │              ║            ║   └──────┘   │   [tier]  │      ┌──────────────────┐  │
  │              ╚════════════╝              │           │      │ ⟳  PICK GAME  ▸ │  │ y=238
  │                                          └───────────┘      │  «Goal Brawl»    │  │
  │                                                             ╔══════════════════╗  │
  │  ┌──────────┐┌──────────┐┌──────────┐┌──────────┐           ║   ▶  QUICK PLAY  ║  │ y=290
  │  │ TOURNMNT ││ BUILDER  ││ TRAINING ││ FRIENDS  │           ║ 2v2 · 2m · most  ║  │
  │  └──────────┘└──────────┘└──────────┘└──────────┘           ╚══════════════════╝  │ y=391
  │   x=48 ─── fixed 4-up, NO scroll ─── x=688                   x=716 ──── x=856     │
  └──────────────────────────────────────────────────────────────────────────────────┘
       ◄──────────────────────────── RTL: start edge is the RIGHT ────────────────────
```

Legend — ⚽ QUICK PLAY = משחק מהיר · ⟳ PICK GAME = בחר משחק (chip shows the selected mode) ·
FRIENDS = שחק עם חברים · TRAINING = אימון · BUILDER = בונה מגרש · TOURNMNT = טורניר ·
★ = הכי טוב (relocated `#select-best-btn`).

**Pick Game screen (`#arena`, retitled «בחר משחק»):** full-screen `.subpage`, two columns —
mode list on the **right** (browse with the right thumb), preview + docked gold `שחק` on the
**left** (commit with the left thumb). Exactly the sibling spec's §4.2 sheet. Rows are
select-only; the gold bar launches; closing keeps the selection.

**Trade-offs**
- ✅ Most Brawl-Stars-like of the four; the gold button **does not move at all** (720,290 stays).
- ✅ Smallest diff: 1 new box, 1 relocated box, 2 deletions, 1 container retune.
- ✅ Kills the invisible-scroll bug — 4 fixed items, nothing hidden, no `scrollLeft` reset.
- ✅ Correct thumb ergonomics for landscape: right thumb = play, left thumb = utilities.
- ⚠️ The six do not read as *one* menu — 2 in the right corner, 4 in the left. Mitigated by
  hierarchy being genuinely different (competitive vs utility), which is also what BS does.
- ⚠️ 151 px per rail button is tight for «שחק עם חברים» at 12 px Arial Black (~92 px of glyphs
  + a 26 px icon + padding). Verify on device; the fallback is a 22 px icon at 11 px type.

### 4.2 Concept B — "Play column"

**Thesis:** all six entries in one full-height column pinned to the RTL start edge, ordered by
importance, Quick Play tallest at the bottom — the menu reads as a menu, and the whole column
sits under the right thumb.

```
 x=0                                                                                x=900
  ┌──────────────────────────────────────────────────────────────────────────────────┐
  │ [pfp]  [★][cp][wo][cd]    ┌ TROPHIES / XP ───────────┐   ● 24    [⚙]             │ y=15
  │  name        [rank]       └──────────────────────────┘                            │ y=60
  │                                                        ┌────────────────────────┐ │
  │ [shop][news][rank][friends][clubs]  ← meta rail moved  │  ⟳ PICK GAME  «Brawl» │ │ y=88
  │        to a single top-left icon row                   ├────────────────────────┤ │
  │                                                        │  👥 FRIENDS            │ │ y=132
  │        ╔════════════╗   ┌pwr┐  ┌──────────┐            ├────────────────────────┤ │
  │        ║  CAROUSEL  ║   └───┘  │   HERO   │            │  🎯 TRAINING           │ │ y=176
  │        ║  150..415  ║   ┌pwr┐  │          │            ├────────────────────────┤ │
  │        ║            ║   └───┘  │  [tier]  │            │  🏗 BUILDER            │ │ y=220
  │        ║            ║   ┌pwr┐  │          │            ├────────────────────────┤ │
  │        ╚════════════╝   └───┘  └──────────┘            │  🏆 TOURNAMENT  s.1    │ │ y=264
  │                                                        ╞════════════════════════╡ │
  │                                                        ║   ▶  QUICK PLAY        ║ │ y=308
  │                                                        ║   2v2 · 2m · first-to-3║ │
  │                                                        ╚════════════════════════╝ │ y=400
  │                                                         x=642 ──────────── x=884  │
  └──────────────────────────────────────────────────────────────────────────────────┘
```

**Pick Game screen:** a **right-edge sheet** that slides over the column it was launched from
(spatial continuity — the list appears where the button was), 340 px wide, hero and carousel
stay visible dimmed behind it. Nice touch, but it is a bespoke overlay, not the shared
`.subpage` pattern, so it costs new CSS that nothing else reuses.

**Trade-offs**
- ✅ The six read unambiguously as one menu, in a fixed priority order.
- ✅ Everything is under the right thumb; the left thumb does nothing (fine in landscape).
- ❌ Eats 240 px of the 900 px stage permanently. Hero must shrink or shift left, carousel
  must shrink, and both are the *emotional* content of the screen. This is a real loss.
- ❌ The five satellites lose their symmetric left/right rails and must be re-homed as a
  cramped icon row — a bigger diff to elements the user asked to preserve.
- ❌ Least Brawl-Stars-like: BS never stacks its modes on the home screen.

### 4.3 Concept C — "Bottom bar"

**Thesis:** a Fortnite-style homebar — one full-width band across the bottom holding all six,
Quick Play widest at the RTL start; the whole upper stage becomes an uncluttered diorama.

```
 x=0                                                                                x=900
  ┌──────────────────────────────────────────────────────────────────────────────────┐
  │ [pfp ]  [★][cp][wo][cd]    ┌ TROPHIES / XP ────────┐        ● 24 online   [⚙]   │ y=15
  │  name          [rank]      └───────────────────────┘                             │ y=60
  │                                                                                   │
  │ [shop]                                   ┌───────────┐                 [friends] │ y=100
  │            ╔════════════╗   ┌pwr┐        │           │                            │
  │ [news]     ║  CAROUSEL  ║   └───┘        │   HERO    │                  [clubs]  │ y=160
  │            ║            ║   ┌pwr┐        │           │                            │
  │ [rank]     ║            ║   └───┘        │  [tier]   │                            │ y=220
  │            ╚════════════╝   ┌pwr┐        │           │                            │
  │                             └───┘        └───────────┘                            │
  │ ┌───────┬────────┬─────────┬──────────┬──────────────┬────────────────────────┐  │ y=330
  │ │ TOURN │BUILDER │TRAINING │ FRIENDS  │ ⟳ PICK GAME  ║   ▶  QUICK PLAY        ║  │
  │ │       │        │         │          │   «Brawl»    ║  2v2 · 2m · first-to-3 ║  │
  │ └───────┴────────┴─────────┴──────────┴──────────────╚════════════════════════╝  │ y=400
  │  x=48 ──────────────────── one continuous bar ───────────────────────── x=852     │
  └──────────────────────────────────────────────────────────────────────────────────┘
```

**Pick Game screen:** a **bottom sheet** that grows upward out of the bar to ~300 px, list
scrolling inside it, hero still visible above. Feels modern and keeps context, but a bottom
sheet in a 415 px-tall stage leaves ~115 px of context — barely worth the complexity.

**Trade-offs**
- ✅ All six in one band with one visual grammar; obviously "the menu".
- ✅ Clean, uncluttered upper stage — the hero and cards get the whole diorama.
- ❌ Everything sits in a 70 px strip; Quick Play cannot be *big*, only *wide*. The single
  most important interaction loses its physical dominance, which is the one thing every
  critique of BS's home screen singles out as correct.
- ❌ Four of six entries land in the horizontal centre — the worst place for a thumb in
  landscape.
- ❌ Adds up to 6 new baked boxes (or one wide flex box whose children can't be tuned
  individually) and collides with the hero's feet at y≈337.

### 4.4 Concept D — "Play deck" (2 × 3 grid)

**Thesis:** the six live in one compact card-deck block in the bottom-right quadrant — Quick
Play spanning the full top row of the deck — leaving the entire left half untouched for hero,
carousel and power slots.

```
 x=0                                                                                x=900
  ┌──────────────────────────────────────────────────────────────────────────────────┐
  │ [pfp ]  [★][cp][wo][cd]   ┌ TROPHIES / XP ─────────┐          ● 24     [⚙]      │ y=15
  │  name         [rank]      └────────────────────────┘                             │ y=60
  │                                                                                   │
  │ [shop]                                ┌──────────┐                     [friends] │ y=110
  │           ╔════════════╗  ┌pwr┐       │          │                                │
  │ [news]    ║  CAROUSEL  ║  └───┘       │   HERO   │                      [clubs]  │ y=175
  │           ║            ║  ┌pwr┐       │  [tier]  │                                │
  │ [rank]    ║            ║  └───┘       │          │  ╔══════════════════════════╗ │ y=214
  │           ║            ║  ┌pwr┐       │          │  ║   ▶  QUICK PLAY          ║ │
  │           ╚════════════╝  └───┘       └──────────┘  ║  2v2 · 2m · first-to-3   ║ │ y=272
  │                                                     ╠═════════════╤════════════╣ │
  │                                                     │ ⟳ PICK GAME │ 👥 FRIENDS │ │ y=274
  │                                                     ├─────────────┼────────────┤ │ y=330
  │                                                     │ 🎯 TRAINING │ 🏗 BUILDER │ │
  │                                                     ├─────────────┴────────────┤ │ y=386
  │                                                     │ 🏆 TOURNAMENT · season 1 │ │
  │                                                     └──────────────────────────┘ │ y=400
  │                                                      x=600 ─────────────── x=884 │
  └──────────────────────────────────────────────────────────────────────────────────┘
```

**Pick Game screen:** the deck **expands in place** — the 2×3 grid animates into a full-screen
two-column sheet anchored at the deck's corner. The most satisfying transition of the four and
the strongest "this menu opened out of that button" signal, but it needs a real FLIP animation
against a scaled stage, which is fiddly (the `.hub` `scale()` composes with any child
transform, so measure in logical px only).

**Trade-offs**
- ✅ Genuinely reads as one menu, and Quick Play still gets to be big and gold.
- ✅ Left half of the stage is completely untouched — zero risk to hero/carousel/power slots.
- ❌ A 284 × 190 block in the bottom-right corner **lands on top of the friends/clubs
  satellites** (795,110 / 795,175) — they have to move, and the left/right rail symmetry the
  current layout was hand-tuned for is lost.
- ❌ Six equal-ish rectangles in a grid is a **settings menu**, not a game lobby. The 2×3 grid
  is the least "toy-like" of the four and the furthest from BS's language.
- ❌ Most new baked boxes (6) plus a container.

---

## 5. Implementation notes per concept

Common to all four (the parts that don't depend on layout):

**`client.js`** — extend the existing `MODES` block at 1956, don't duplicate it:

```js
// --- MODES gains two fields ------------------------------------------------
// pick:  false  -> never rendered in the Pick Game list (it is a hub entry instead)
// fmt:   the format-facts line the gold button prints (players · duration · win condition)
{ id:'2v2', …, fmt:'2 נגד 2 · עד 2 דק׳ · ראשון ל-3' },
{ id:'brawl', …, fmt:'2 נגד 2 · 2 דק׳ · הכי הרבה גולים' },
{ id:'3v3', …, state:'dev' },
{ id:'cup', …, state:'dev', pick:false },   // טורניר is lobby entry #6, not a picker row

// --- selection -------------------------------------------------------------
let selectedModeId = localStorage.getItem('pikme-mode') || '2v2';
function selectedMode() {
  const m = modeById(selectedModeId);
  return (m && m.state === 'live') ? m : modeById('2v2');   // guard 3, §3.3
}
function setSelectedMode(id) {
  const m = modeById(id);
  if (!m || m.state !== 'live') return;
  selectedModeId = id; localStorage.setItem('pikme-mode', id); renderPlayBtn();
}
function renderPlayBtn() {                                   // chip + gold sub-label
  const m = selectedMode();
  qs('#mode-chip .hub-mtx b').textContent = m.name;
  qs('#quick-match-btn .hub-mtx small').textContent = m.fmt;
}
```

Then:

| Where | Change |
|---|---|
| `client.js:696-698` (`showScreen`) | delete `strip.scrollLeft = 0` (no scroller left); call `renderPlayBtn()` on `name === 'home'` |
| `client.js:1984` `renderModeList` | for `kind === 'launch'`, filter out `m.pick === false`; add a third kind `'pick'` (select-only rows) |
| `client.js:2005` delegated handler | new branch: `kind === 'pick'` → `setSelectedMode(id)`, update the preview, do **not** launch. `launchMode()` also calls `setSelectedMode()` (guard 4) |
| `client.js:2092` `#goal-brawl-btn` | **delete** — the element is gone |
| `client.js:2113` `#quick-match-btn` | `launchMode(selectedModeId)` instead of a hardcoded `quickMatch` |
| `client.js` (new) | `#mode-chip` → `showScreen('arena')`; `#tournament-btn` → teaser toast / `#news` |
| `_layout-edit.js:28` | **bump `LS_KEY` → `'pikme-lobby-layout-v2'`** (C4 — mandatory, same commit) |
| `_layout-edit.js:41-66` | add `modeChip`; rename `playStrip` → `playRow`; while there, add the drifted `rankBtn`, `hubTier`, `trophies` descriptors (C5) |

**`index.html`** — one block: `#home .hub` lines 86-135. Delete `.hub-arena` (109-113) and
`#goal-brawl-btn` (131-134); move `#select-best-btn` (94-97) out of the play cluster; add
`#mode-chip` where it was; rename `#play-strip` → `#play-row` and reorder its four children
RTL-first (friends · training · builder · tournament); turn `#tournament-btn` from a
`div[aria-disabled]` into a `<button>`. `#arena`'s `<h2>` (241) → «בחר משחק».
**Do not rename `id="arena"`** — it is load-bearing in the screen registry
(`client.js:2030`), the sub-page CSS selector list (`style.css:1008`), the dismiss list
(`client.js:2076`) and `data-open-screen="arena"`.

**`style.css`** — three sections: (1) `BAKED LOBBY LAYOUT` 1746-1823, per the table in §6;
(2) the anchor selector list 1730-1744 must gain `.hub > #mode-chip` and `.hub > #play-row`;
(3) `.hub-cs` (1833-1841) is retired as a "coming soon" *style* — tournament becomes a live
`.hub-mode` with a `.hub-soon` badge, because a `cursor:not-allowed` div was the whole problem.
Add `.hub.has-trophies > #hub-tier { top: 78px }`.

Concept-specific deltas:

| | A′ | B | C | D |
|---|---|---|---|---|
| `.hub` stays a baked stage | yes | yes | yes | yes |
| New baked boxes | **2** (`#mode-chip`, `#play-row`) | 2 (`#play-col`, `#mode-chip` inside it) | 1 wide (`#play-bar`) | 2 (`#quick`, `#play-deck`) |
| Boxes that must MOVE | 1 (`#select-best-btn`) + carousel height | hero, carousel, all 5 satellites, chips | hero (up), carousel, `#play-strip` | friends + clubs satellites |
| New CSS beyond the baked block | ~20 lines (`.hub-modechip`) | ~60 (column + right-edge sheet) | ~50 (bar + bottom sheet) | ~70 (deck grid + FLIP) |
| Picker surface | shared `.subpage` | bespoke edge sheet | bespoke bottom sheet | shared `.subpage` + FLIP |
| Editor descriptor churn | 2 | 7+ | 2 | 4 |
| Risk to preserved elements | **low** | high | medium | medium |

---

## 6. Sizing table — Concept A′, logical stage px (900 × 415)

Everything marked *unchanged* keeps its current baked value; the point of A′ is how few rows
are not marked that way.

### Status / identity band

| Element | left | top | width | height | z | Note |
|---|---|---|---|---|---|---|
| `#hub-settings` | 809 | 15 | 38 | 38 | 6 | unchanged |
| `.hub-season` | — | — | — | — | — | **removed** (folded into #6's sub-line) |
| `.hub-online` | 757 | 60 | ~90 | ~20 | 6 | unchanged |
| `#home-face` `.hub-pfp` | 95 | 15 | 55 | 55 | 6 | unchanged |
| `#home-name` `.hub-name` | 95 | 80 | auto | ~16 | 6 | unchanged |
| `#select-best-btn` | **152** | **15** | **54** | **40** | 5 | **moved** from 745,245; restyle as `.hub-chip`-like button |
| `#chip-copies` | 210 | 15 | 60 | ~34 | 5 | unchanged |
| `#chip-worth` | 278 | 15 | 60 | ~34 | 5 | unchanged |
| `#chip-cards` | 346 | 15 | 60 | ~34 | 5 | unchanged |
| `#hub-rank` | 283 | 58 | 50 | 42 | 5 | unchanged |
| `.hub-trwrap` | 410 | 10 | 325 | ~58 | 5 | unchanged (`trophies.css`) |
| `.hub-xpbar` | 410 | 10 / **74** w/ `.has-trophies` | 325 | ~34 | 5 | unchanged |
| `#hub-tier` | 590 | 58 / **78** w/ `.has-trophies` | 50 | 42 | 3 | **nudge added** |

### Meta rail (unchanged, all 52 × 52, z6)

| Element | left | top |
|---|---|---|
| `.hub-sat[data-open-screen="shop"]` | 95 | 110 |
| `.hub-sat[data-open-screen="news"]` | 95 | 175 |
| `#rank-btn` | 95 | 240 |
| `#friends-btn` | 795 | 110 |
| `.hub-sat[data-open-screen="clubs"]` | 795 | 175 |

### Diorama

| Element | left | top | width | height | z | Note |
|---|---|---|---|---|---|---|
| `.hub-cards` (carousel box) | 185 | 75 | 265 | **264** | 2 | height 276 → 264 so it clears the play row at y=345 |
| `.hub-cards .cf-card` | — | — | 150 | 205 | — | unchanged (`--cfw/--cfh`) |
| `#pick-hero-btn` `.hub-hero` | 490 | 75 | 250 | ~262 | 4 | unchanged; `.hub-char` width 250 |
| `#power-slots` overlay | 0 | 0 | 900 | 415 | — | unchanged, `pointer-events:none` |
| `.pslot-item:nth-child(3)` slot2 | 455 | 65 | 55 | 86 | — | unchanged |
| `.pslot-item:nth-child(1)` slot0 | 455 | 160 | 55 | 86 | — | unchanged |
| `.pslot-item:nth-child(2)` slot1 | 455 | 255 | 55 | 86 | — | unchanged |

### The six entries

| # | Element | left | top | width | height | z | Note |
|---|---|---|---|---|---|---|---|
| 2 | `#mode-chip` | **716** | **238** | **140** | **44** | **6** | NEW. Centre x = 786, same as the gold button. z6 so it paints over the hero's right edge (x716-740). |
| 1 | `#quick-match-btn` | 720 | 290 | 132 | 104 | **6** | unchanged position; add explicit `z-index:6` |
| — | `#play-row` (container) | **48** | **345** | **640** | **46** | 5 | replaces `#play-strip`; `display:flex; gap:12px; direction:rtl; overflow:visible` |
| 3 | `#play-friends-btn` | 537→688 | 345 | **151** | 46 | — | flex child 1 (rightmost = RTL start) |
| 4 | `#training-btn` | 374→525 | 345 | **151** | 46 | — | flex child 2 |
| 5 | `#field-builder-btn` | 211→362 | 345 | **151** | 46 | — | flex child 3 |
| 6 | `#tournament-btn` | 48→199 | 345 | **151** | 46 | — | flex child 4; `<button>`, sub-line «עונה 1», `.hub-soon` badge |

Flex maths: `4 × 151 + 3 × 12 = 640` ✓ (children `flex:1 1 0`, so re-balancing is a
container-width edit, never four coordinate edits).

### Clearance checks (all verified against the numbers above)

| Pair | Result |
|---|---|
| `#play-row` right edge 688 ↔ `#quick-match-btn` left 720 | 32 px gutter ✓ |
| `#play-row` top 345 ↔ carousel bottom (75+264=339) | 6 px ✓ (was an 8 px *overlap*) |
| `#play-row` bottom 391 ↔ stage bottom 415 | 24 px ✓ |
| `#play-row` left 48 ↔ notch (C3) | 48 × 0.938 ≈ 45 css px on a 844-wide landscape viewport ✓ |
| `#mode-chip` top 238 ↔ clubs satellite bottom (175+52=227) | 11 px ✓ |
| `#mode-chip` bottom 282 ↔ gold top 290 | 8 px ✓ (deliberately tight — chip reads as part of the button, per §3.3 guard 1) |
| `#mode-chip` / gold ↔ hero right edge 740 | 20-24 px overlap, resolved by z6 > hero z4 — same as today's gold button ✓ |
| `#select-best-btn` 152..206 ↔ pfp right 150, chip-copies left 210 | 2 / 4 px ✓ |
| Right edge of gold 852 ↔ stage 900 | 48 logical px ≈ 45 css px ✓ notch-safe |

### The Pick Game screen has no sizing table — on purpose

`#arena` is **not** on the baked stage. It is a `.screen` + `.subpage` with flow layout and a
full-bleed stadium background (`style.css:1008`). It therefore gets normal responsive CSS, and
adding a second baked stage would be the wrong call: the picker's content grows with the mode
roster and a fixed-px stage is exactly what you don't want for a list. One override is needed —
`#arena .subpage-body` is currently `flex-direction:column; align-items:center`; scope a `row` +
`align-items:stretch` + `gap:14px` override **to `#arena` only** so news/shop/clubs are
untouched.

---

## 7. Risks and gotchas

1. **Stale `localStorage` layout (C4).** Highest-probability failure. `applySaved()` writes
   inline `left/top` + a `transform:scale()` that beats every new CSS rule. Anyone who used
   `?edit=1` will see `#select-best-btn` snap back to 745,245 and swear the change didn't land.
   **Bump `LS_KEY` in the same commit.**
2. **Two "friends" entries.** `#friends-btn` (satellite → friend list/chat) and
   `#play-friends-btn` (entry #3 → party match flow) will sit on the same screen with similar
   labels. Keep the satellite's label «חברים» and the entry's «שחק עם חברים», and keep them in
   different visual languages (§2.1). Do not merge them: one is social, one is matchmaking.
3. **Tournament is a promise.** Promoting a dead `בקרוב` div to a full-weight lobby entry raises
   its perceived readiness. It must open something real on tap — a teaser panel that says what
   it will be, or `#news`. Never a silent no-op, never a bare `בקרוב` toast.
4. **`#play-row`'s children were tuned for a scroller.** `#play-strip > *` currently forces
   `position:static; flex:0 0 auto; height:44px`. The new row wants `flex:1 1 0; height:46px`.
   Also drop `scroll-snap-type` / `overflow-x:auto` / `::-webkit-scrollbar` and the
   `client.js:696` `scrollLeft` reset together — leaving any one of them behind produces a row
   that silently clips a button on a narrow device instead of shrinking it.
5. **RTL child order.** `#play-row` is `dir="rtl"`, so **DOM order runs right → left**. The DOM
   must read friends · training · builder · tournament for the rail to render as the wireframe
   shows. Getting this backwards is the single most common bug in this codebase's RTL flex rows.
6. **`renderPowerSlots()` wipes `#power-slots`.** Unchanged by this design, but if any concept
   ever moves the slots, remember `window.__lobbyApplyLayout` exists precisely to re-pin them.
7. **`selectedModeId` and the party flow.** `selectedGame` (`client.js:2016`) already exists for
   private rooms and is currently **never transmitted** (sibling audit P11). Do not conflate the
   two variables in this change; `selectedModeId` is the *public queue* selection. Unifying them
   requires the server-side per-room mode work, which is out of scope here.

---

## 8. Recommendation

**Build Concept A′ with resolution R2.**

Reasoning, shortest form: it is the only concept that gives Brawl Stars' actual home-screen
grammar (one dominant gold PLAY + a selected-mode chip directly above it + a quiet nav rail)
*while* leaving every element the user asked to preserve exactly where it is. It moves one box,
adds one box, deletes two duplicate play entries, and retunes one container. B, C and D each
buy "the six read as one menu" by relocating the hero, the carousel or the satellites — paying
in the parts of the screen the user explicitly wanted kept, to fix a problem (menu cohesion)
that Brawl Stars itself does not solve either.

Build order:

| Step | Work | Ships value alone? |
|---|---|---|
| 1 | `MODES` gains `fmt` + `pick`; `selectedModeId` + `selectedMode()` + `setSelectedMode()` + `renderPlayBtn()`; gold button calls `launchMode(selectedModeId)` | yes — the gold button starts telling the truth |
| 2 | Add `#mode-chip` (markup + anchor list + baked rule + editor descriptor); bump `LS_KEY` | yes — this is the whole R2 contract |
| 3 | Delete `.hub-arena` + `#goal-brawl-btn`; relocate `#select-best-btn`; promote `#tournament-btn`; `#play-strip` → fixed `#play-row`; drop the `scrollLeft` reset | yes — the lobby becomes exactly six |
| 4 | `#arena` → «בחר משחק» two-column sheet with select-only rows + docked gold `שחק` (sibling spec §4.2) | yes |
| 5 | Carousel height 264, `#hub-tier` nudge, editor descriptor drift fixes | polish |

Steps 1-3 are the user's decision, implemented. Step 4 is what makes it "very similar to Brawl
Stars". Step 5 is cleanup.

---

## 9. For the other agents

- **`bs-home` / `bs-modepick`** — §3.4 and §4.1 are my read of BS's grammar from the sibling
  audit's sources, not from screenshots. If your research contradicts either (especially:
  whether tapping an event card in BS *selects* or *immediately launches*), §3.2's R2-vs-R3
  table is the thing to re-decide, and it is a one-branch change in the delegated handler.
- **`lobby-picker`** — this doc adopts your `MODES`/`renderModeList` refactor wholesale and your
  §4.2 sheet as the Pick Game screen. The one place we differ: you reduce the hub to *one* play
  control; the user has fixed it at six, so `#tournament-btn`, `#training-btn`,
  `#field-builder-btn` and `#play-friends-btn` stay on the hub as first-class entries rather
  than a "utility rail". Your `#mode-chip` at 720,246 becomes 716,238 140×44 (§6).
- **`mode-3v3`** — if 3v3 becomes a segmented control inside the football card rather than its
  own `MODES` row, `selectedModeId` needs a companion `selectedTeamSize`, and `renderPlayBtn()`
  must print it in the gold button's `fmt` line. Flagging early because it changes the
  persistence key's shape.
- **`new-minigames`** — the 6-entry lobby is only sustainable because **every new mode lands in
  Pick Game, never on the hub.** Please treat "does not need a hub button" as a hard acceptance
  criterion for new modes.
- **`modes-polish`** — the gold button now prints `fmt` (players · duration · win condition)
  live. If overtime/sudden-death changes a win condition, `fmt` in `MODES` is the string that
  must change with it.
