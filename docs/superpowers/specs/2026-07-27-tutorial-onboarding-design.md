# Tutorial onboarding — design

**Date:** 2026-07-27
**Status:** approved, building

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
| Curriculum | **4 steps: move → shoot → goal → super.** 💣 and 🧱 hidden throughout |
| Coach voice | **Silent coach** — pointing hand + 1–2 Hebrew words. No character, no dialogue, no pause |
| Trigger | Auto on first launch, **no skip**. Replayable forever from `אימון` |
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

## The four steps

Each step enables exactly one new thing. No clock, no fail state, nothing can be lost.

```
STEP 1  ⊙ move only            STEP 2  + ⊙ aim
┌──────────────────────┐       ┌──────────────────────┐
│      ◎ ← glowing     │       │   🧍 dummy           │
│        spot          │       │    ▲                 │
│   🧍                 │       │   🧍 ──▶             │
│  ⊙👆   «זוז!»        │       │        ⊙👆 «ירה!»    │
└──────────────────────┘       └──────────────────────┘
 done: stand in the ring        done: land 1 hit on the dummy

STEP 3  + ⚽ ball, empty goal   STEP 4  + ⚡ super, keeper appears
┌──────────────────────┐       ┌──────────────────────┐
│                  ┃   │       │                 🧤┃  │
│  🧍⚽ ──────────▶┃   │       │  🧍⚽ ─────────▶ ┃  │
│      «גול!»          │       │  «בעיטת ענק!»        │
└──────────────────────┘       └──────────────────────┘
 done: score                    done: score → 🎉 «אתה מוכן!»
```

**Step 4 is the finale on purpose.** The goal now has a keeper in it, and the super kick
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
