# The lobby tour — a kid's first ninety seconds on the hub

Date: 2026-07-28 · Status: **SHIPPED** (auto-launches on first run) · Lab retained as the bench

> Started as a localhost lab (`_hub-tour.html`). It is now the shipped `public/hub-tour.js`, and the
> lab loads that same file rather than a copy of it — the only way the two cannot drift. Everything
> below about the lobby, the gestures and the faults still holds; the integration is at the end.

## What the user asked for

> "you should clone the lobby exactly as it is, put 7 dummy cards in the carousel, show with hand
> gestures how to pull a card from the carousel and put it in the power slot, also show how to pull a
> card and put in the hero. the hero is the basic one, the cards the user sees first are 3 random
> common and one rare. show how to put a rare on the hero for custom. let do only that in a separate
> localhost"

Deck composition, confirmed in a follow-up: **6 common + 1 rare** (7 cards). Card order is left to
the carousel's own mechanism — no hand-forced layout.

Two lessons, nothing else. No trophies step, no friends step, no ⚽ finale, no 🎓 picker entry, no
auto-launch. This is a bench where the two hardest gestures in the hub get taught and proven before
any of it is folded back into level 4 «מרכז».

## Why a clone at all, and why THIS kind of clone

Level 4 shipped teaching on `#tu-mock` — a lobby the tutorial draws itself ([client.js:7967]).
That retreat was taken for good reasons (the live hub auto-fills slots, auto-rotates the carousel,
and three agents edit it daily) but it produced a lesson that does not look like the thing it
teaches. The user's objection is fidelity: clone it **exactly**.

So the lab does not redraw anything. `scripts/make-hub-tour.mjs` reads the real `public/index.html`,
injects two script tags, and writes `public/_hub-tour.html`. The result loads the real markup, the
real `style.css`, the real `client.js`, and — the part that matters — **the real drag handlers**.
Nothing is reimplemented, so nothing can drift out of sync with the hub except by regenerating.

A generated file rather than a runtime `srcdoc`/`blob:` iframe: those documents report
`about:srcdoc` for `location`, and `client.js` reads `location.hostname` (`DEV_LOCAL`) and builds its
WebSocket URL from `location` — a fabricated document URL breaks both. A real file served from a
real port keeps every one of those reads honest.

## The two gestures, as the code actually implements them

Read from the shipped hub before designing the lesson:

* **carousel → power slot.** A grab is a *lift*: `dy < -16` and mostly vertical counts as a drag,
  sideways counts as a carousel swipe ([client.js:1596]). Release over a `.pslot` calls
  `setSlotCard` ([client.js:1620]). The hand mime must therefore travel **up and over**, not flat
  sideways.
* **carousel → hero.** Release over `#pick-hero-btn` calls `setHeroSkinByRarity(card.r)`
  ([client.js:1629]) — the card **stays where it was**, only the look changes.
  `RARITY_SKIN = { common: 'base', rare: 'gold', … }` ([client.js:1028]) and the hero starts
  `striker:base`, so **dropping a common on the hero changes nothing on screen** (`base → base`).
  Only the rare produces a visible result. That is why the deck needs its one rare, and why the
  hero must be the basic one — the lesson has no payoff otherwise.

## The sandbox (`public/_hub-tour-sandbox.js`)

A classic script injected as the first thing in `<body>`, so it runs before the `client.js` module.
Everything it does, it does through inputs the app already owns — no client internals are touched:

| what | how |
|---|---|
| 7 dummy cards | `window.SALTIZ_CARDS` (wins over `DEV_SAMPLE_CARDS` on every host) |
| slots start EMPTY | `window.SALTIZ_LOADOUT = [null,null,null]` — without this `effectiveLoadout()` auto-fills the top three and lesson 1 is already done on arrival |
| hero starts basic | `window.SALTIZ_COSMETIC = 'striker:base'` |
| nothing persists | `Storage.prototype.setItem` **records and drops**. `postPrefs()` reaches the app under the player's phone number, so this is the guard that matters |
| nothing reaches the server | `WebSocket.prototype.send` drops `setLoadout` / `setCosmetic`, passes everything else |
| no tutorial ambushes the lesson | the done-set keys are seeded (before the write block goes up) so neither the first-run tutorial nor the «מרכז» auto-launch fires |
| the carousel holds still | the 2.6s auto-rotate ([client.js:1558]) is dropped by a `setInterval` filter. It moves the card the hand is pointing at, and it is what completed a step with no input in the last attempt |

**The recorded writes are the completion signal, not just an assertion.** `setSlotCard` → `saveLoadout`
attempts `pikme-loadout`; `setHeroSkinByRarity` → `saveCosmetic` attempts `pikme_cosmetic`. Latching
on the blocked write means the lesson needs no socket and no access to module-private state, and the
same record proves the invariant: nothing left the page.

## The coach (`public/_hub-tour.js`)

Reuses the shipped overlay wholesale — `#tutorial`, `.tu-veil`, `.tu-hand`, `#tu-cap`, `#tu-nudge`,
`body.hub-tu-gate`, `.tu-live`, `#tu-hub-skip` all exist in `style.css` already, including
`.tutorial.nudging .tu-hand { scale: 1.28 }`, which is the "hand grows when they go quiet" behaviour.
`#tutorial` lives inside `#game` (`display:none` on the hub) so it is re-homed onto `<body>` for the
lesson, exactly as `tuCoachToBody()` does.

One thing the shipped coach cannot express: a **directed** drag. Every existing mime is a CSS
keyframe with a fixed shape, and these two lessons point from a specific card to a specific target.
So the hand is animated with Web Animations along the real source→target vector (lift first, then
across), recomputed when either rect moves. `translate` is driven by the animation and `scale` stays
on the CSS class, so the nudge growth still works.

**Both ends of a drag must be `.tu-live`, not just the source.** `slotUnder()` resolves the drop with
`document.elementFromPoint`, and that ignores anything with `pointer-events: none` — so a gate that
lights only the carousel would let the kid lift a card and silently swallow every drop.

## The order (user, 13:04)

> "make the home tour first, then the cards pull, first pull a hero custom, then explain each slot,
> then pull a card to slot, then show the select best"

One run of **nineteen** steps, mixing two kinds — **READ** (lit, named, explained, inert, advanced by
a tap anywhere) and **DO** (the real control, gated on the real outcome):

| steps | what | kind |
|---|---|---|
| 1–13 | the home legend — every corner of the screen | READ |
| 14 | the **rare** card → the **hero** (`base → gold`) | DO |
| 15–17 | what each of the three power slots does | READ |
| 18 | a card → a slot | DO |
| 19 | «הכי טוב» → all three slots | DO |

Read-then-do, twice: the legend names the furniture before anything is asked, and **the three slots
are explained while they are still empty** — the only time each one shows its own ⚡/🏃/🛡️ glyph
instead of a card. Explaining them after the drag would mean explaining a slot with a picture of a
card sitting in it. «הכי טוב» is last for the same reason it always was: taught earlier it fills
every slot before the kid knows what a slot is, and step 18 would have nothing empty to drop into.

`?tour=home` and `?tour=cards` run either half alone, for working on one of them.

| DO step | source | target | done when |
|---|---|---|---|
| 14 | the **rare** card | `#pick-hero-btn` | a blocked `pikme_cosmetic` write of `striker:gold` |
| 18 | the front carousel card | `.pslot[data-slot="0"]` | a real slot is no longer `.pslot-empty` |
| 19 | `#select-best-btn` (tap) | — | **all three** slots non-empty |

**The tap-catcher is per STEP, not per tour.** One run now mixes read and do steps, and a catcher left
up over a drag step eats the gesture.

**A read step makes the whole hub inert, and that takes `!important`.** The gate's
`pointer-events: none` lands on the `.hub > *` box and children inherit it — except
`#power-slots .pslot-item { pointer-events: auto }` (`style.css:2298`), which being an ID rule
outranks any class chain. So a "read-only" slot step was still tappable and a tap would have opened
the cards room and walked the kid off the tour. Found by assertion, not by eye.

The hand's mime is per-gesture: a **drag** step gets the directed pull-up-then-swipe path below; a
**tap** step reuses the shipped `.gest-tap` press and sits just *outside* the target — the hand is
54px and most targets are smaller, so centring it hides the thing being pointed at.

Idle ~9s → `.nudging`: hand grows, second short line. No clock, no fail state, no reward. A «דוגמה»
chip marks the album as examples. `דלג ✕` exits.

## Tour 2 — the element legend (`?tour=elements`)

Thirteen things on this screen, in the user's order, one at a time: each lit while everything else
stays dark, with its name and one line saying what it does. Reached with `?tour=elements`, or from
the «סיור במסך ›» button on the card tour's finale.

`settings · connected · friends · clubs · store · news · rank · quick play · choose game · play with
friends · training · arena builder · profile`

**Nothing here navigates.** Every lit element is left **inert** — a tap on ⚙ or 👥 would open that
screen and abandon the tour on step one. Advancing is a tap anywhere (a transparent catcher at
z-index 39, under `#tutorial` and the exit) or the «הבא ›» button. That inertness is the one design
rule this tour has, so the verifier asserts `pointer-events: none` on all thirteen and re-checks that
`#home` is still the visible screen at the end.

**Lighting one element out of a filter-based gate takes two classes, not one.** A CSS filter on a
parent cannot be undone by a child, and the shipped gate dims per `.hub > *` box — so lighting
`#training-btn`, which lives inside `#play-strip`, means un-dimming the strip (`.lab-show`) and then
dimming its other children individually (`.lab-dim`).

The second line on this tour is never replaced by the idle nudge: "what this button does" *is* the
step, and swapping it for «הקש להמשך» after nine seconds would delete the lesson from the screen of
anyone who reads slowly.

**The hand-off needs a run token.** `finish()` is called from inside a tick that has already queued
its successor, so starting the second tour immediately left the first tour's loop alive — two loops
on the same globals, double `stepT`, and a real chance of both taking the same step and skipping one.
Every tick now carries the token it was started with and retires itself when a new tour begins. The
first screenshot of the second tour showed a fully bright lobby; the verifier now asserts the gate,
the scrim, a dimmed non-target, and that 1.0s of wall clock advances `stepT` by ~1.0s.

## Files

| file | role |
|---|---|
| `scripts/make-hub-tour.mjs` | generator: real `index.html` → `public/_hub-tour.html` |
| `public/_hub-tour-sandbox.js` | the sandbox, first script in `<body>` |
| `public/_hub-tour.js` | the two-step coach |
| `public/_hub-tour.css` | only what the shipped CSS lacks: drop-target ring, «דוגמה» chip |
| `_hub-tour-verify.mjs` | real Chrome over CDP, real touch, screenshot per step |
| `public/_hub-tour.html` | **generated** — banner says so |

**No shipped file is edited.** Not `index.html`, not `client.js`, not `style.css`, not `server.js`,
not `shared/`. Zero collision surface with the other agents working this repo.

Served at `PORT=3013 node server.js` → `http://10.100.102.36:3013/_hub-tour.html`
(`:3010` main dev, `:3011` another agent, `:3012` the user's phone surface, `:3014` the level-4
verifier — all left alone).

## Verification

`node _hub-tour-verify.mjs` drives real Chrome over CDP with real touch events:
performs both drags, asserts the slot really filled and the hero really went gold, asserts **zero**
`localStorage` writes and **zero** `setCosmetic`/`setLoadout` reaching the socket, captures console
errors, and screenshots every step. Screenshots get **looked at** — the last round proved that text
assertions pass while the screen is blank.

[client.js:1028]: ../../../public/client.js
[client.js:1558]: ../../../public/client.js
[client.js:1596]: ../../../public/client.js
[client.js:1620]: ../../../public/client.js
[client.js:1629]: ../../../public/client.js
[client.js:7967]: ../../../public/client.js

---

## Shipping it: first run (user, 13:30)

> "now lets make this appear when user enter game first time"

**Order — the lobby first, the pitch second.** `tuMaybeAutoStart()` asks `HubTour.pending()` before
anything else and hands over; the tour calls back when it finishes *or* is skipped, and level 1
יסודות starts then. Before this, a brand-new player was taken straight onto a pitch on the server's
`welcome` and never saw the lobby at all.

**Nothing it does is saved.** `window.__hubPrefs` (in client.js, because `myLoadout` / `myCosmetic` /
`tuHub` are module-private there) gives the tour three things: `begin()` raises the existing `tuHub`
sandbox flag and snapshots the loadout + hero; `end()` puts both back, lowers the flag and re-tells
the server the truth; `cosmetic()` reads the live hero, which is how the hero step knows the rare
landed. `saveLoadout` gained the `tuHub` guard `saveCosmetic` already had — without it one tap of
«הכי טוב» would have written the lesson's loadout to localStorage *and* `postPrefs()`-ed it to the
app, which persists under the player's **phone number**.

**`emptySlots()`, and why the tour cannot work without it.** `myLoadout` is `null` for anyone who has
never arranged their powers, and `effectiveLoadout()` reads that as "auto-fill the album's top three".
Measured on the real page: all three slots arrive full, "drag a card into a slot" is already satisfied,
«הכי טוב» has nothing to do, and the card half ran itself out in about a second. The tour clears the
slots in memory for its duration (restored by `end()`), which is also what makes the three slot
explanations legible — an empty slot is the only time each shows its own ⚡/🏃/🛡️ glyph.

**An empty album gets the legend only.** With no cards there is nothing to drag, and the wardrobe is
card-gated (7 distinct cards per hero), so the card half would be a hand pointing at things that
cannot happen. Counted off the DOM: the carousel renders one `.cf-card` per owned card.

**Two first-run keys.** `fbHubTourDone` and `fbHubTourSkipped` — both stop the auto-launch coming
back, but only one means the kid was actually shown the screen. Level 4 «מרכז» stays parked
(`offered: false`, another agent's `19fb0f0`); this tour does not go through the level table at all.

### Faults found only on the real page

* **`hubReady()` waited for a `.cf-card`** — so for the empty-album newcomer the tour exists for, it
  silently never started. The lab always injects seven cards, so the lab could not see it. It now
  waits for hub furniture, plus a bounded 2s grace for the carousel so a slow render cannot quietly
  downgrade a player who *has* cards to the legend-only tour.
* **«דלג ✕» sat on top of the ⚙ it was pointing at** (both want the top-inline-end corner, and ⚙ is
  step 1). Moved to the opposite corner, which is clear.
* **A weak assertion of my own**: `.hub-tu-gate .hub > *` has `transition: filter .18s`, so measuring
  the instant the tour starts catches `grayscale(0) brightness(1)` — a no-op filter that is not the
  string `'none'`, so a `!== 'none'` check PASSED on an undimmed lobby. Dimming is now asserted
  numerically, after the transition.

### Verification

`_hub-firstrun-verify.mjs` — the acceptance test, on `/` with a **fresh Chrome profile** and no
sandbox. Two hosts because they are two surfaces: the LAN IP (`DEV_LOCAL` false → genuinely empty
album → 13-step legend) and localhost (`DEV_SAMPLE_CARDS` → the full 19). It asserts the auto-launch,
that level 1 is held back, that skipping *and* finishing both hand the floor to the pitch tutorial,
that a second load does not ask again, that the real `localStorage` prefs are **byte-identical before
and after**, and that the loadout and hero are restored.
