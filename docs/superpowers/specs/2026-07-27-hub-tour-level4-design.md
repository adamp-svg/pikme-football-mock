# Hub tour — tutorial level 4 «מרכז»

**Date:** 2026-07-27
**Status:** approved, ready to plan
**Agent:** `hub-tour`
**Builds on:** [`2026-07-27-tutorial-onboarding-design.md`](2026-07-27-tutorial-onboarding-design.md) — read that first for the
Brawl Stars / Epic research and the coach-layer rules this level inherits unchanged.

A fourth tutorial level that teaches the **hub** — the six things a kid has to understand to run
their own account: trophies, cards, powers, hero, friends, and the button that starts a game.

---

## Why

Levels 1–3 (`basics` · `combat` · `tricks`) teach a kid to play a match. Nothing teaches the screen
they land on *between* matches. A new player returns from their scripted first match to a hub
holding a trophy bar, an album carousel, three power slots, a hero button, a friends rail and five
mode buttons — and, exactly as before the tutorial existed, no explanation of any of it.

The same standing rule applies (CLAUDE.md: "open design question → research the big games"), and the
reference is the same one the first design settled on: **Brawl Stars' progressive hub reveal** —
one pointer at a time, on real UI, ending by putting the player back into a game.

---

## Decisions

| Question | Decision |
|---|---|
| Shape | A **level in the existing picker**, not a separate tour system — «מרכז» beside יסודות/קרב/טריקים |
| Level number | **4** (`TU_LEVELS` index 3). `tricks` took index 2 in `686a72f` |
| Empty album | **Demo cards for the duration of the lesson** (project owner's call) — see the sandbox section |
| Launch | **Auto-launch on the first hub visit**, plus the 🎓 picker forever |
| Slots step | **Drag a card into a slot** — the real gesture, not the menu route |
| Reward | Celebration only. `c86fa82` "practice pays nothing" stands, no exceptions |
| Runs in | **The hub itself — no server room.** See below |

### No room, and what that buys

Every level so far runs inside a real match room: `startTutorial()` sends `{type:'tutorial'}`, the
server builds a room and answers `matchStart`, and `tuEnter()` is called from `enterMatch`. A hub
level must not do that — there is no pitch to set up and nothing for the sim to own.

So levels gain a **`where`** field. `where: 'hub'` makes `startTutorial()` skip the socket entirely
and run the step machine against the DOM.

The payoff is worth stating: **level 4 does not touch `server.js` at all.** No new room mode, no new
message type, no new room state, and one less file contested with the other agents working this
repo. It also removes the client-drives-server trade-off the first design accepted (`tuStage`
spoofability) — for this level there is no server to tell anything.

### The unlock exemption that auto-launch forces

`tuUnlocked(l, done)` gates a level on **every** level before it being finished. Left alone, level 4
would be 🔒 until a kid had finished קרב and טריקים — which makes "auto-launch on the first hub
visit" impossible, because the first hub visit happens right after level 1.

So `where: 'hub'` levels are exempt from the sequential chain and unlock on **level 1 alone**. This
is honest rather than a hack: the combat ladder is a skill progression where each level assumes the
last, and the hub is orthogonal to it — knowing how to read a trophy bar does not depend on knowing
how to rocket-jump.

`tuUnlocked` stays pure and stays in `shared/tutorial.js`, so the picker, the auto-start and the
tests all keep reading one rule.

### Auto-launch conditions

Fires once, and only when all of these hold:

- level 1 (`basics`) is in the done-set, and level 4 (`mercaz`) is not;
- `#home` is the visible screen (the existing `tuMaybeAutoStart` guard — never mid-match, never
  mid-matchmaking);
- no tutorial is already running.

Unlike level 1 it is **skippable**: a first-run tutorial with no exit is defensible because the kid
has nothing else to do yet, but a kid standing on the hub already has somewhere to be. The exit
button stays.

---

## The six steps

Order is **collect first, play last**. Ending on the real ⚽ button is the Brawl Stars payoff, and it
resolves an ordering trap: quick-play taught first would launch matchmaking and abandon its own
tour halfway through.

```
1  🏆 גביעים      #hub-xp            «גביעים»       watch (~2.5s dwell)
2  🃏 קלפים       #home-carousel     «הקלפים שלך»    swipe the carousel
3  ⚡ 3 כוחות     #power-slots       «גרור לכאן»     DRAG a card into a slot
4  🦸 גיבור       #pick-hero-btn     «החלף מראה»     tap → wardrobe → back
5  👥 חברים       #friends-btn       «שחק עם חבר»    tap → friends → back
6  ⚽ משחק מהיר   #quick-match-btn   «קדימה!»        the tap really starts a match
```

| # | id | Target | Caption | Completion |
|---|---|---|---|---|
| 1 | `trophies` | `#hub-xp` | «גביעים» | dwell — nothing to tap, so the step is a beat, not an action |
| 2 | `deck` | `#home-carousel` | «הקלפים שלך» | the carousel index changed (a real swipe or a card tap) |
| 3 | `slots` | `#power-slots` | «גרור לכאן» | a card is sitting in a slot that was empty |
| 4 | `hero` | `#pick-hero-btn` | «החלף מראה» | the wardrobe opened and the hub is visible again |
| 5 | `friends` | `#friends-btn` | «שחק עם חבר» | the friends screen opened and the hub is visible again |
| 6 | `play` | `#quick-match-btn` | «קדימה!» | tapped — the level is marked done at the tap, then the match starts |

**Step 1 is the only dwell step.** The trophy bar cannot be tapped, so there is no gesture to teach;
the lesson is "this number is yours and it goes up when you win". `686a72f` already added a per-step
dwell for exactly this class of lesson — steps that need watching, not doing.

**Steps 4 and 5 leave the hub.** Each completes on the tap that opens its screen, and the coach then
waits for `#home` to be visible again before drawing the next step. It does not follow the kid into
the wardrobe or the friends list — those screens are their own thing, and a hand pointing inside
them would be a second lesson nobody asked for.

**Step 6 tears the demo down BEFORE it starts the match.** Non-negotiable — see below.

### Stuck handling

Inherited unchanged from the existing coach: every step is unfailable, and after `nudgeAfter` idle
seconds the hand escalates and the second line swaps from `sub` to `nudge`. No clock, no fail state,
no way to lose. The 🎓 picker's exit stays live throughout.

---

## The coach layer on the hub

Reused as-is, because it already works this way:

- **`tuSpotRect()` already resolves a DOM element by selector** and returns its centre + size from
  `getBoundingClientRect()`. Level 4 adds six entries to `TU_SPOT_SEL`. **The hand needs no new
  code.**
- `#tutorial`, `.tu-hand`, `.tu-cap`, `.tu-nudge`, `.tu-pips` are DOM in viewport coordinates, so
  they render over the hub exactly as they render over the pitch.
- Gestures come from the existing set: `tap` (added in `790420a`), `pull` for the drag, and the
  dwell step points without animating a gesture at all.

⚠️ One thing the hub needs that the match did not. `tu-off` dims an untaught control, but on the hub
a dimmed button is **still tappable** — and a kid tapping 🛒 חנות mid-tour walks out of the lesson.
So the hub gate must also kill `pointer-events`, with only the live target whitelisted.

**This repo has already paid for getting that wrong once:** the corner-tap bug (`76686d6`) set
`pointer-events` at render time only, so a corner drawn with the wall tool stayed untappable until
the next repaint, and no unit test caught it — only a real browser did. So the gate goes on the
`.hub` container as a class, with the live element whitelisted by selector, and it is verified in
Chrome with real taps on the buttons that are supposed to be inert.

---

## The demo album, and why the sandbox is the real work

With an empty album the hub has nothing to point at:

| | With 0 cards |
|---|---|
| `#home-carousel` | `renderCarousel()` **adds `hidden`** (`client.js:1474`) — not on screen at all |
| `#pick-hero-btn` | `unlockedHeroCount()` = `floor(0/7)+1` = **1** — striker only, nothing to change to |
| `#hub-rank` | rendered only `if (cards.length)` |
| `#power-slots` | renders, as three empty glyph placeholders |
| `#hub-xp` | **fine** — `renderHubXp()` always ends `classList.remove('hidden')`, so it shows רמה 1 · 0/100 |

`myCards()` is the single source for the carousel, the chips, the slots, hero unlocks *and* the
album pushed to the server. So the demo is one override inside `myCards()` (three fixed cards) plus
one inside `unlockedHeroCount()` (step 4 needs something to switch to — three cards alone still
yields one hero).

### ⚠️ The leak is not local

Equipping goes through **one chokepoint**, `setSlotCard()`:

```js
myLoadout = eff; saveLoadout(myLoadout);
renderPowerSlots();
sendMsg({ type: 'setLoadout', loadout: myLoadout });
```

and `saveLoadout()` / `saveCosmetic()` both call `postPrefs()`, which posts to
`window.ReactNativeWebView` — **the app then persists those prefs under the player's phone number.**

So an unsandboxed demo would not merely dirty `localStorage`. It would write cards the kid does not
own into their real, server-side, cross-device loadout. That is the reason this level's risk lives in
the sandbox and not in the coach.

### The sandbox

- **Three guard points**, all narrow: `setSlotCard()`, `swapSlots()`, `saveCosmetic()`. While a hub
  tutorial is running they mutate in-memory state for the lesson and write nothing — no
  `localStorage`, no `postPrefs`, no `setLoadout`/`setCosmetic` over the socket.
- **The slots must start EMPTY, or step 3 teaches nothing.** `effectiveLoadout()` auto-fills the
  best three cards whenever `myLoadout` is `null`, which is exactly the state a new player is in — so
  handing them three demo cards would fill all three slots before the step began, and
  "a card is sitting in a slot that was empty" would be true on arrival. The demo therefore pins
  `myLoadout` to an explicit `[null, null, null]` for the lesson, so the three slots render as empty
  glyph placeholders and the drag has a purpose. (This is also the more honest picture of a real new
  account: cards owned, nothing equipped yet.)
- Real `myLoadout` / `myCosmetic` are snapshotted on entry and restored on exit, followed by one
  re-render, so the hub returns to its true state.
- **Teardown happens before step 6 starts matchmaking.** The match join sends
  `cards: myCards()` (`client.js:4059`), so a demo card must never be live when a kid enters a real
  game — it would reach the server's loadout validation and the bot-buff maths.
- Demo cards carry a visible «דוגמה» mark. A seven-year-old should not be shown three cards and
  left thinking they own them.
- The finale points at **where real cards come from** rather than letting the hub silently empty out.
  That is both honest and the actual next action.

### Accepted trade-off

The hub visibly changes when the lesson ends: three cards and a filled slot become an empty
carousel again. Called out and accepted (project owner's decision) — the alternatives were locking
the level behind card ownership, which a kid on the LAN browser or a fresh Saltiz account could
never open, or skipping the empty steps, which teaches less. The «דוגמה» mark and the
where-cards-come-from finale are what keep it from reading as a card that got taken away.

---

## Code shape

| File | Change |
|---|---|
| `shared/tutorial.js` | Append the `mercaz` level (`where: 'hub'`, six steps, no `stages` — there is no pitch). `tuUnlocked` gains the hub exemption. Still pure, still unit-tested. |
| `public/client.js` | `where`-aware `startTutorial`; a hub entry/exit pair beside `tuEnter`/`tuExit`; `TU_SPOT_SEL` + six selectors; `tuHubEv` tap latches; the hub gate; the demo override + three guards. |
| `public/style.css` | The hub gate class (dim + `pointer-events`), and the «דוגמה» mark. |
| `public/index.html` | Nothing. The picker renders from `TU_LEVELS` and the coach overlay already exists. |
| `test-tutorial.mjs` | Level 4 rules, the unlock exemption, and the caption/dwell table. **Pure — no socket**, because there is no room. |
| `_tu-verify.mjs` | Drive the real hub in Chrome: all six steps, real touch, screenshot per step. |
| `server.js` | **Nothing.** |

`ctx` for a hub step is built from tap latches rather than snapshots:
`{ tappedTrophies, deckMoved, slotFilled, heroOpened, friendsOpened, played, backOnHub, stepElapsed }`.
`isStepDone` needs no change — it already resolves `!!ctx[s.done]` generically.

Latches are **one-way**, matching `tuEv`: a flag set by a tap stays set until the step advances, so a
re-render or a dropped frame cannot lose the tap that completed a step.

---

## Verification

The bar is the one the first three levels set, and it is not negotiable downward.

- `node test-tutorial.mjs` — level 4's rules, the unlock exemption, every caption and the dwell.
  Runs with no server at all.
- `node _tu-verify.mjs` — real Chrome over CDP against **http://10.100.102.36:3012/**, per
  `pikme-football-verify-with-chrome`: walks all six steps with real touch events, asserts the
  hand's rect actually lands on each target (not merely that a step advanced), and screenshots each
  step.
- **The sandbox proof, the assertion that makes the demo trustworthy:** `localStorage`
  `pikme-loadout` + `pikme_cosmetic` are captured before the level and asserted **byte-identical**
  after it — including after equipping a demo card and changing hero mid-lesson. Plus: no
  `ReactNativeWebView.postMessage` and no `setLoadout`/`setCosmetic` socket frame is emitted during
  the lesson (both stubbed and counted).
- **The gate proof:** tap 🛒 חנות and 📰 חדשות mid-tour and assert the screen did not change —
  the check the corner-tap bug proves a unit test cannot make.
- Full suite: `for f in test*.mjs; do node $f; done`. Pre-existing fails (`test-bot-ladder`,
  `test-bot-partner` — seed-sensitive, failing identically on pre-tutorial code) reported separately.
- Manual: a fresh `localStorage` with only `basics` done auto-launches it on the hub; finishing marks
  ⭐ in the picker; 🎓 → «מרכז» replays it with the flag already set.

---

## Coordination

Another agent (`tutorial-coach`) is committing into `shared/tutorial.js`, `public/client.js` and
`test-tutorial.mjs` roughly every twenty minutes — it shipped levels 2 and 3 while this design was
being written. It is not using the orchestration lock registry, so the protection is file
discipline, per CLAUDE.md: `git status` / `git diff` before every commit, commit only my own hunks,
never revert or stomp work I did not write, and rebase onto its commits often.

The level being **data** helps: the new level is an append to `TU_LEVELS`, which is the cheapest
possible shape to merge.
