# Hub tour LAB — two drag lessons on an exact clone of the lobby

Date: 2026-07-28 · Status: approved, building · Scope: **localhost lab only, nothing shipped**

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

| # | source | target | done when |
|---|---|---|---|
| 1 | the front carousel card | `.pslot[data-slot="0"]` | a real slot is no longer `.pslot-empty` |
| 2 | the **rare** card | `#pick-hero-btn` | a blocked `pikme_cosmetic` write of `striker:gold` |

Idle ~9s → `.nudging`: hand grows, second short line. No clock, no fail state, no reward. A «דוגמה»
chip marks the album as examples. `דלג ✕` exits.

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
