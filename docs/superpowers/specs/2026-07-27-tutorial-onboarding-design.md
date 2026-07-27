# Tutorial onboarding — design

**Date:** 2026-07-27
**Status:** levels 1-3 shipped. Hub tour designed, not built (see the open question at the end).

> **Update log.** The original spec covered a single 4-step first match. It has since grown into
> three levels plus a planned hub tour, and this document has been kept current rather than left
> to rot. What follows describes what is actually in the repo.

A scripted first-match tutorial for the football minigame. Audience is **kids**, so the bar is
that a child who cannot read Hebrew fluently still finishes it.

---

## Why

A new player today lands on the hub and taps «משחק מהיר» straight into a live 2v2 holding
**six unexplained mechanics**: two floating-anchored sticks, hold-to-charge shooting, a ball you
carry, a super meter, a 💣 pull-button and a 🧱 pull-button. Nothing in `public/` or `server.js`
teaches any of it — there is no tutorial, no first-run path, no coach-mark. The closest thing is
`אימון → מגרש אימון`, a sandbox with a dummy, a sentry and a keeper: no goals, no sequence, no
feedback.

### Reference games

Per the standing rule (CLAUDE.md: "open design question → research the big games"):

- **Brawl Stars** — a *mandatory playable first match*, not a slideshow. One brawler, deliberately
  weak bots, learn move → attack → super inside a real match you are going to win. Advanced
  material arrives later, graded by trophy count.
- **Fortnite / Epic** — three stages (describe before · rules in the lobby · hints during play) and
  hard rules: one or two sentences maximum, ~150 characters, *"don't expect them to take the time
  to read about the game's rules after the game starts"*, *"don't assume that all players will know
  how to play your game"*.

Both converge on: **teach by doing, one mechanic at a time, somewhere you cannot lose.**

Sources: [Epic onboarding docs](https://dev.epicgames.com/documentation/en-us/fortnite/onboarding-players-in-fortnite-creative),
[Epic mobile design](https://dev.epicgames.com/documentation/fortnite/designing-for-mobile-in-fortnite?lang=en-US),
[Brawl Stars UX teardown](https://medium.com/@VladArtym/analyzing-the-user-experience-of-brawl-stars-7599c99c47ed),
[Brawl Stars beginner flow](https://theriagames.com/guide/brawl-stars-beginner-guide/).

---

## Decisions

| Question | Decision |
|---|---|
| Shape | Scripted first match (Brawl Stars model) — playable, not a slideshow |
| Curriculum | **Three levels.** L1 יסודות: move → shoot(tap) → charge(hold) → goal → super. L2 קרב: shoot-the-ball → bomb → wall → strip. L3 טריקים: hide → fly. 💣/🧱 hidden for the whole of L1 |
| Coach voice | **Silent coach** — pointing hand + 1–2 Hebrew words. No character, no dialogue, no pause |
| Trigger | **Level 1 only** auto-launches on first run, no skip. Every level is replayable forever from `אימון → 🎓 איך משחקים?`; later levels are offered, never forced |
| Levels | A level is **data** — a `steps` table plus a matching declarative `stages` table the server interprets. Adding a level is a data change, not a server change |
| Unlocking | Level N unlocks when every level before it is done. The picker shows ⭐ done / ▶ open / 🔒 locked, and the finale offers «המשך ל…» |
| Reward | **Celebration only.** No XP, no trophies, no cards — `c86fa82` "practice pays nothing" stands with zero exceptions |
| Architecture | Thin server room + **pure step machine in `shared/tutorial.js`**, driven by the client |

### Why this architecture

Two facts from the code decided it:

- **The client has no local sim.** It imports `arena.js` / `constants.js` / `wire.js` but *not*
  `sim.js`; it only predicts its own x/y (`client.js:4818`) on top of server snapshots. A fully
  offline tutorial would need a whole parallel runtime — the largest option, and a second way the
  game can run that would drift from the server.
- **The sticks are always visible at fixed anchors** (`client.js:5362`), not floating-to-touch. So
  a pointing hand has a stable target. This is what makes the silent coach possible at all.

A fully server-side step machine was rejected: it puts one RTT of latency in front of every hint —
on a bad connection the hand points *after* the kid already did the thing — and it grows an
already-111k `server.js`.

---

## The levels

Each step enables exactly one new thing. No clock, no fail state, nothing can be lost.

```
LEVEL 1 · יסודות                LEVEL 2 · קרב              LEVEL 3 · טריקים
 1 ⊙  «זוז!»          ring       1 ⚽ «שוט לכדור!»           1 🌿 «איפה הוא?»
 2 ⊙  «כוון והקש!»    tap        2 💣 «פצצה!»                2 💥 «תעוף!»
 3 ⊙  «כוון והחזק!»   hold       3 🧱 «בנה קיר!»
 4 ⚽ «החזק ושחרר!»   kick       4 🥅 «חטוף!»
 5 ⚡ «בעיטת ענק!»    super
```

**Level 3 step 1 teaches stealth from the far side of the bush** (reworked by `tu-coach-css`,
`ed0f9cf`): the watcher is planted *inside* the bush and the kid is sent to find it. A child who
has just failed to see somebody works out on their own that the same bush will hide *them*. Being
told to go stand in the green teaches only that the coach knows a rule. There is deliberately no
marker — a cue pointing at the bush would answer the question the step is asking.

Each step turns on exactly one new control, and **a control once taught is never taken away** —
an invariant pinned by a test, which caught level 2 silently confiscating 💣 the step after
introducing it.

**Level 1's last step is the finale on purpose.** The goal now has a keeper in it, and the super kick
(×1.5, overcharge ×2.0 — `docs/MECHANICS.md` §4) is what blasts past them. The kid is not told what
super is; they are shown *why they want it*.

The super meter is **granted by the server** at the start of step 4. Earning it legitimately needs
a full charged hit or three quick ones (`earnPower()`, MECHANICS §4) — a whole extra lesson.

**Pitch:** a clean empty field — no bushes, no steel walls, no crates. `TRAIN_ARENA`'s obstacles are
right for practice and wrong for a first 90 seconds.

### Step table

| # | id | Live controls | World setup | Caption | Completion |
|---|---|---|---|---|---|
| 1 | `move` | move stick | glowing ring ~500px away; no ball, no enemies | «זוז!» | player inside the ring |
| 2 | `shoot` | + aim stick | one `still` dummy ahead; no ball | «ירה!» | 1 bullet hit on the dummy |
| 3 | `goal` | + ball | ball at the player's feet; goal open, no keeper | «גול!» | goal scored |
| 4 | `super` | + ⚡ granted | ball at feet; keeper in the far goal | «בעיטת ענק!» | goal scored |

**Step 2 completes on any hit, not a charged hit.** Simpler and faster, but a kid can finish having
only ever tapped. The escalation hint («החזק חזק יותר») covers the gap.

### Stuck handling

Every step is unfailable. After ~8s with no progress the hand grows and speeds up and a second short
line appears. In steps 3–4 the ball respawns at the player's feet if it goes dead for 4s. There is
no restart, no timer, no way to lose.

---

## The coach layer

No character, no sentences. Per step:

- everything dims except the one live control (spotlight);
- a pulsing hand animates **the actual gesture** over it — circling for the move stick, a
  hold-drag-release arc for the aim stick;
- 1–2 Hebrew words in the pixel comic style `drawCelebration` already uses;
- one world-space marker: the glowing ring, a ping over the dummy, a fat arrow into the goal.

The game never pauses.

---

## Entry and replay

```
app opens ──▶ localStorage['fbTutorialDone'] ?
                 │ no                    │ yes
                 ▼                       ▼
            TUTORIAL (no skip)          hub
                 │ 🎉 → flag set
                 ▼
                hub, «משחק מהיר» pulsing

אימון  (always, forever)
  ├ 🎓 איך משחקים?     ← replays it, ignores the flag
  ├ 🎯 מגרש אימון
  └ 🤖 משחק מול בוטים
```

`localStorage`, not a server flag — simplest, and a reinstall replaying the tutorial is a fine
outcome. **The replay button is unconditional**: the flag gates only the auto-launch, never access.
Replay works whether the flag is set, missing or corrupted.

---

## Code shape

| File | Change |
|---|---|
| `shared/tutorial.js` | **new.** Step table + pure `advance(stepId, ctx)` + the stage's arena/enemy spec. No DOM, no sockets — the `shared/training.js` pattern, so it unit-tests. |
| `server.js` | `startTutorial()` (a stripped `startTraining`), `msg.type === 'tutorial'`, and `applyTuStage(room, n)` — the three things only the sim can do: spawn/remove the ball, spawn/remove the dummy and keeper, grant `power`. Holds one integer, `room.tuStage`. |
| `public/client.js` | Builds `ctx` from the snapshot it already receives, runs `advance()`, gates which controls exist, draws the coach layer, wires entry + replay. |
| `public/index.html` | `#tutorial-coach` overlay; `🎓 איך משחקים?` in `#train-choose`. |
| `public/style.css` | Hand, spotlight dim, caption. |
| `test-tutorial.mjs` | **new.** Step predicates, plus a socket test that the room spawns clean and each stage applies. |

`ctx` is built from the snapshot the client already has:
`{ inRing, hitDummy, holdsBall, superReady, scored, stepElapsed }`.

### Known trade-off

**The client tells the server which stage to set up** (`{type:'tuStage', n}`). Trivially spoofable,
and in a solo tutorial with no rewards that costs nothing — but it is client-driven state, against
the grain of the rest of this codebase. Accepted deliberately for simplicity; the server still
validates `n` is the next stage in sequence and that the room is a tutorial room.

---

## Verification

- `node test-tutorial.mjs` — step predicates + room/stage behaviour over a real socket.
- Full suite green: `for f in test*.mjs; do node $f; done`.
- Visuals proven with Chrome/CDP screenshots against `http://10.100.102.36:3012/`, per
  `pikme-football-verify-with-chrome` — layout claims get screenshotted, not asserted.
- Manual: fresh `localStorage` auto-launches it; finishing returns to the hub; `אימון → 🎓 איך
  משחקים?` replays it with the flag already set.

---

## Open: the hub tour (designed, not built)

The pitch levels teach the pitch. Everything a kid meets *around* it is still unexplained: quick
play, picking a mode, friends, playing with friends, trophies and rank, the fact that beating a
human is worth more than beating a bot, where their stats live (the profile), the card deck, the
three power slots and what each gives, dragging a card into a slot, «הכי טוב», and changing a
hero's suit from a card.

That is a **guided tour of menus**, not a match — a different engine from levels 1–3. What carries
over for free: the coach layer already positions its spotlight from any CSS selector
(`tuSpotRect`), so it can point at `#quick-match-btn` or a power slot exactly as it points at a
joystick; and the picker, unlocking, progress and finale hand-off all pick new levels up with no
UI work. What is new is a level `kind: 'tour'` that runs with **no match room at all**, whose
steps complete on DOM events instead of sim events.

**Two decisions block it, both with the user:**

1. **How to split ~12 topics.** Recommended: two levels — «לשחק» (quick play, pick a mode, friends,
   playing together, trophies + rank, humans-beat-bots, profile stats) and «קלפים» (deck, the three
   slots, what each gives, dragging a card in, «הכי טוב», hero suits). Twelve topics in one sitting
   is 3–4 minutes of menus with no win in the middle, which is where onboarding loses kids.

2. **Whether the kid presses the real buttons.** Recommended: **hybrid**. Real taps for anything
   harmless and reversible (open בחר משחק, open friends, drag a card into a slot, tap «הכי טוב»,
   change a suit); show-and-tell for the two with real side effects — **sending a friend request
   messages an actual person**, and **משחק מהיר drops the kid into a live 2v2 mid-lesson**. A
   tutorial must not do either.
