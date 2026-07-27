# Hub Tour — Tutorial Level 4 «מרכז» Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fourth tutorial level that teaches the hub — trophies, cards, power slots, hero, friends, and the button that starts a game — running in the hub itself with no server room.

**Architecture:** Levels gain a `where` field. `where: 'hub'` makes `startTutorial()` skip the socket entirely and run the existing pure step machine (`shared/tutorial.js`) against the DOM, driven by its own `requestAnimationFrame` loop instead of the match render loop. Completion flags come from one-way tap latches instead of snapshot events. An empty album is filled with three sandboxed demo cards for the duration of the lesson.

**Tech Stack:** Vanilla ES modules, no framework. Node's built-in test style used by the repo's `test*.mjs` files (plain asserts + a pass/fail counter, run as `node test-tutorial.mjs`). Chrome via CDP for visual/interaction verification.

**Spec:** [`docs/superpowers/specs/2026-07-27-hub-tour-level4-design.md`](../specs/2026-07-27-hub-tour-level4-design.md) — read it first.

## Global Constraints

- **`server.js` MUST NOT be modified.** No new room mode, no new message type, no new room state. If a task seems to need one, the design is wrong — stop and re-read the spec.
- **`public/index.html` MUST NOT be modified.** The picker renders from `TU_LEVELS` and the coach overlay already exists.
- **No reward, ever.** No XP, no trophies, no cards. `c86fa82` "practice pays nothing" stands with zero exceptions.
- **Captions are 1–2 Hebrew words.** Epic's rule taken literally: a kid who cannot read Hebrew fluently still finishes. Second lines (`sub`/`nudge`) may be one short sentence.
- **Every step is unfailable.** No clock, no fail state, no way to lose. The exit stays live for the whole level.
- **Latches are one-way.** A flag set by a tap stays set until the step advances, so a re-render or a dropped frame cannot lose the tap that completed a step. Match `tuEv`'s existing pattern.
- **The demo album must never persist.** No `localStorage` write, no `postPrefs()`/`ReactNativeWebView` message, no `setLoadout`/`setCosmetic` socket frame while a hub level runs.
- **This work happens in the worktree** `.claude/worktrees/hub-tour` on branch `feat/hub-tour`. Another agent (`tutorial-coach`) has uncommitted edits to `shared/tutorial.js`, `public/client.js`, `public/style.css` and `test-tutorial.mjs` in the main checkout. Never edit the main checkout.
- **Test server:** `PORT=3014 node server.js` from the worktree, reached at **http://10.100.102.36:3014/**. `:3010`/`:3012` belong to other agents. Node does NOT hot-reload — restart after `server.js`/`shared/` changes.
- **Run the suite before claiming done:** `for f in test*.mjs; do node $f; done`. `test-bot-ladder` and `test-bot-partner` fail on pre-tutorial code too (seed-sensitive) — report them separately, never as new.

---

## File Structure

| File | Responsibility |
|---|---|
| `shared/tutorial.js` | **Modify.** Append the `mercaz` level; add `where` to the level shape; add the hub exemption to `tuUnlocked`; export `tuIsHub`, `TU_HUB_STEPS_SEL`. Stays pure — no DOM, no sockets, no timers. |
| `public/client.js` | **Modify.** `where`-aware `startTutorial`; `tuHubEnter`/`tuHubExit`/`tuHubLoop`; the six spotlight selectors; `tuHubEv` tap latches; the hub gate; the demo album + its three guards. |
| `public/style.css` | **Modify.** `.hub-tu-gate` (dim + `pointer-events`) and `.cf-demo`/`.pslot-demo` («דוגמה» mark). |
| `test-tutorial.mjs` | **Modify.** Level 4's rules, the unlock exemption, captions, dwell. Pure — no socket. |
| `_tu-verify.mjs` | **Modify.** Drive the real hub in Chrome: six steps, real touch, the sandbox proof, the gate proof, a screenshot per step. |

---

### Task 1: Level 4 data + the hub unlock exemption

Pure logic only. No DOM, no client changes — this task ends with `node test-tutorial.mjs` green and the new level invisible to the running game.

**Files:**
- Modify: `shared/tutorial.js` (append to `TU_LEVELS`, extend `tuUnlocked`)
- Test: `test-tutorial.mjs`

**Interfaces:**
- Consumes: existing `TU_LEVELS`, `stepAt`, `stepsIn`, `isStepDone`, `captionFor`, `showNudge`, `advance`, `tuUnlocked`, `nextLevel`, `tuLevel`, `tuLevelIndex`, `TU_LEVEL_COUNT`.
- Produces:
  - `TU_LEVELS[3]` — `{ id: 'mercaz', name: 'מרכז', sub: 'גביעים · קלפים · כוחות · גיבור', ic: '🏠', where: 'hub', steps: [...] }`, no `stages` key.
  - `tuIsHub(l)` → `boolean` — true when level `l` runs in the hub.
  - `TU_HUB_LEVEL` → `3`, the index, so the client and tests never hardcode it.

- [ ] **Step 1: Write the failing tests**

Append to `test-tutorial.mjs`, following the file's existing assert/counter style:

```js
// ---- LEVEL 4 · מרכז (the hub tour) -------------------------------------------------
{
  const L = tuLevel(TU_HUB_LEVEL);
  eq(L.id, 'mercaz', 'level 4 is mercaz');
  eq(tuIsHub(TU_HUB_LEVEL), true, 'level 4 runs in the hub');
  eq(tuIsHub(0), false, 'level 1 does not run in the hub');
  eq(L.stages, undefined, 'a hub level has no pitch stages');
  eq(stepsIn(TU_HUB_LEVEL), 6, 'six steps');
  eq(L.steps.map((s) => s.id).join(','), 'trophies,deck,slots,hero,friends,play', 'step order is collect-then-play');

  // Every step must have a target, a caption and a completion flag, or a kid gets a hand
  // pointing at nothing.
  for (const s of L.steps) {
    ok(!!s.spotlight, `${s.id} has a spotlight target`);
    ok(!!s.cap && s.cap.length <= 12, `${s.id} caption is 1-2 words`);
    ok(!!s.done, `${s.id} has a completion flag`);
    ok(s.nudgeAfter > 0, `${s.id} has a stuck-nudge`);
  }

  // The trophy bar cannot be tapped, so step 1 is a dwell, not an action.
  eq(L.steps[0].done, 'sawTrophies', 'step 1 completes on a dwell');
  ok(L.steps[0].minDwell >= 2, 'step 1 holds long enough to read');

  // Completion flags come from taps, and isStepDone needs no special-casing to read them.
  eq(isStepDone(TU_HUB_LEVEL, 1, {}), false, 'deck step incomplete with no tap');
  eq(isStepDone(TU_HUB_LEVEL, 1, { deckMoved: true }), true, 'deck step completes on a carousel move');
  eq(isStepDone(TU_HUB_LEVEL, 2, { slotFilled: true }), true, 'slots step completes when a slot fills');
  eq(isStepDone(TU_HUB_LEVEL, 5, { played: true }), true, 'play step completes on the tap');

  // Steps 4 and 5 leave the hub: opening the screen is not enough, the kid has to come back,
  // or the next step's hand would point at a button hidden behind the wardrobe.
  eq(isStepDone(TU_HUB_LEVEL, 3, { heroOpened: true }), false, 'hero step waits for the return');
  eq(isStepDone(TU_HUB_LEVEL, 3, { heroOpened: true, backOnHub: true }), true, 'hero step completes back on the hub');
  eq(isStepDone(TU_HUB_LEVEL, 4, { friendsOpened: true }), false, 'friends step waits for the return');
  eq(isStepDone(TU_HUB_LEVEL, 4, { friendsOpened: true, backOnHub: true }), true, 'friends step completes back on the hub');

  // The nudge escalates but never fails the step.
  eq(showNudge(TU_HUB_LEVEL, 1, { stepElapsed: 999 }), true, 'a stuck kid gets the nudge');
  eq(showNudge(TU_HUB_LEVEL, 1, { stepElapsed: 999, deckMoved: true }), false, 'no nudge once done');

  // THE UNLOCK EXEMPTION: auto-launch happens on the first hub visit, which is right after
  // level 1 — so the hub level cannot be gated on the combat ladder.
  eq(tuUnlocked(TU_HUB_LEVEL, new Set(['basics'])), true, 'hub level opens on level 1 alone');
  eq(tuUnlocked(TU_HUB_LEVEL, new Set()), false, 'hub level is locked before level 1');
  eq(tuUnlocked(2, new Set(['basics'])), false, 'the combat ladder still chains sequentially');
  eq(tuUnlocked(2, new Set(['basics', 'combat'])), true, 'tricks opens after combat');
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node test-tutorial.mjs`
Expected: FAIL — `tuIsHub is not defined` / `TU_HUB_LEVEL is not defined` (they are not exported yet). Import them at the top of the test file alongside the existing imports.

- [ ] **Step 3: Implement the level and the exemption**

In `shared/tutorial.js`, append a fourth entry to `TU_LEVELS`. Note there is **no `stages` key** — a hub level has no pitch:

```js
  // LEVEL 4 · מרכז — the HUB, not the pitch. Levels 1-3 teach a kid to play a match; this is the
  // screen they land on between matches, which nothing taught. `where: 'hub'` is what makes the
  // client run it against the DOM and skip the socket entirely (no room, no server change).
  //
  // Order is collect-then-play. Play LAST on purpose: taught first, its tap would launch
  // matchmaking and abandon the tour halfway through. Ending on the real ⚽ button is also the
  // Brawl Stars payoff — the lesson puts you back in a game.
  {
    id: 'mercaz', name: 'מרכז', sub: 'גביעים · קלפים · כוחות · גיבור', ic: '🏠',
    where: 'hub',
    steps: [
      // The trophy bar cannot be tapped, so there is no gesture to teach: the lesson is "this
      // number is yours and it goes up when you win". minDwell holds it open long enough to read.
      { id: 'trophies', controls: [], spotlight: 'hubTrophies', gesture: 'none',
        cap: 'גביעים', sub: 'נצחון = עוד גביעים', nudge: 'זה שלך — הוא עולה כשמנצחים',
        nudgeAfter: 6, minDwell: 2.5, done: 'sawTrophies' },
      { id: 'deck', controls: [], spotlight: 'hubDeck', gesture: 'pull',
        cap: 'הקלפים שלך', sub: 'החלק לראות עוד', nudge: 'החלק את הקלפים',
        nudgeAfter: 8, done: 'deckMoved' },
      { id: 'slots', controls: [], spotlight: 'hubSlots', gesture: 'pull',
        cap: 'גרור לכאן', sub: 'שלושה כוחות למשחק', nudge: 'גרור קלף לתוך משבצת',
        nudgeAfter: 10, done: 'slotFilled' },
      { id: 'hero', controls: [], spotlight: 'hubHero', gesture: 'tap',
        cap: 'החלף מראה', sub: 'בחר איך תיראה', nudge: 'הקש על הדמות',
        nudgeAfter: 10, done: 'heroDone' },
      { id: 'friends', controls: [], spotlight: 'hubFriends', gesture: 'tap',
        cap: 'שחק עם חבר', sub: 'הזמן חברים למשחק', nudge: 'הקש על חברים',
        nudgeAfter: 10, done: 'friendsDone' },
      { id: 'play', controls: [], spotlight: 'hubPlay', gesture: 'tap',
        cap: 'קדימה!', sub: 'הכי מהיר להתחיל לשחק', nudge: 'הקש כדי לשחק',
        nudgeAfter: 10, done: 'played' },
    ],
  },
```

Steps 4 and 5 need BOTH the open and the return, and `isStepDone` reads a single flag — so derive the composite in the ctx builder rather than special-casing `isStepDone`. Add these two derived flags in the client's ctx (Task 2): `heroDone = heroOpened && backOnHub`, `friendsDone = friendsOpened && backOnHub`. **Update the two tests above to use `heroDone`/`friendsDone` inputs**:

```js
  eq(isStepDone(TU_HUB_LEVEL, 3, { heroOpened: true }), false, 'hero step waits for the return');
  eq(isStepDone(TU_HUB_LEVEL, 3, { heroDone: true }), true, 'hero step completes back on the hub');
  eq(isStepDone(TU_HUB_LEVEL, 4, { friendsOpened: true }), false, 'friends step waits for the return');
  eq(isStepDone(TU_HUB_LEVEL, 4, { friendsDone: true }), true, 'friends step completes back on the hub');
```

Then the exports and the exemption:

```js
export const TU_HUB_LEVEL = tuLevelIndex('mercaz');
// Does this level run in the hub instead of on a pitch? A hub level has no room, no stages and no
// server involvement at all.
export const tuIsHub = (l) => (tuLevel(l)?.where === 'hub');
```

Replace the body of `tuUnlocked` with:

```js
export function tuUnlocked(l, done) {
  if (l === 0) return true;
  // A HUB level is exempt from the sequential chain and gates on level 1 alone. It has to be:
  // it auto-launches on the first hub visit, which happens right after level 1, so chaining it
  // behind קרב and טריקים would make its own entry condition unreachable. It is also honest —
  // the combat ladder is a skill progression where each level assumes the last, and reading a
  // trophy bar does not depend on knowing how to rocket-jump.
  if (tuIsHub(l)) return !!done && done.has(TU_LEVELS[0].id);
  for (let i = 0; i < l; i++) if (!done || !done.has(TU_LEVELS[i].id)) return false;
  return true;
}
```

⚠️ `tuIsHub` is used by `tuUnlocked` and defined with `const`, so it must be declared **above** `tuUnlocked` in the file or the call hits a TDZ. Put both exports immediately after `TU_LEVELS`.

Also check `nextLevel()`: it walks levels in order returning the first unlocked-and-unfinished one. With the exemption a kid who has finished only `basics` now gets `mercaz` offered by «המשך ל…» ahead of `combat`, because `combat` is unlocked too and comes first — verify the existing behaviour still offers `combat` first (index order wins), and add:

```js
  eq(nextLevel(new Set(['basics'])), 1, 'after level 1 the next offer is still combat, not the hub');
  eq(nextLevel(new Set(['basics', 'combat', 'tricks'])), TU_HUB_LEVEL, 'the hub is what is left at the end');
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node test-tutorial.mjs`
Expected: PASS, with the level-4 assertions added to the count. Then `node --check shared/tutorial.js` and the full suite: `for f in test*.mjs; do node $f; done` — nothing else should move, because no other file changed yet.

- [ ] **Step 5: Commit**

```bash
git add shared/tutorial.js test-tutorial.mjs
git commit -m "feat(tutorial): level 4 «מרכז» as data, and the hub unlock exemption"
```

---

### Task 2: The hub coach runner

Make the level actually run: its own rAF loop, DOM spotlight targets, tap latches, and the gate that stops a kid tapping out of the lesson. Demo cards are NOT part of this task — with a real album (`?dev` / the app) all six steps already have targets, which is how this task gets tested on its own.

**Files:**
- Modify: `public/client.js`
- Modify: `public/style.css`

**Interfaces:**
- Consumes: `TU_HUB_LEVEL`, `tuIsHub` (Task 1); existing `tuSpotRect`, `tuRenderOverlay`, `advance`, `isStepDone`, `showNudge`, `captionFor`, `stepAt`, `stepsIn`, `doneStage`, `isTutorialOver`, `tuMarkDone`, `tuFinish`, `showScreen`, `homeEl`, `cfIndex`, `effectiveLoadout`.
- Produces:
  - `tuHubEnter(level, replay)` / `tuHubExit()` — mirror `tuEnter`/`tuExit` for the hub.
  - `tuHubEv` — the latch bag: `{ sawTrophies, deckMoved, slotFilled, heroOpened, friendsOpened, played }`.
  - `tuHubCtx()` → the ctx object, including the derived `heroDone` / `friendsDone` / `backOnHub` / `stepElapsed` / `sinceDone`.
  - `tuHubRunning()` → `boolean` — Task 3's guards call this.

- [ ] **Step 1: Add the six spotlight selectors**

`tuSpotRect()` already resolves a DOM element by selector via `getBoundingClientRect()`, so this is a table extension and the pointing hand needs no new code. Extend `TU_SPOT_SEL`:

```js
const TU_SPOT_SEL = {
  bomb: '#special', wall: '#build',
  // LEVEL 4 (hub). tuSpotRect already resolves any selector, so the hand costs nothing here.
  hubTrophies: '.hub-xpbar', hubDeck: '#home-carousel', hubSlots: '#power-slots',
  hubHero: '#pick-hero-btn', hubFriends: '#friends-btn', hubPlay: '#quick-match-btn',
};
```

Target `.hub-xpbar` rather than `#hub-xp`: the bar is the box that holds a stable position, and `#hub-xp` has its innerHTML rebuilt by `renderHubXp()` on every poll.

- [ ] **Step 2: Write the gate CSS**

In `public/style.css`, near the existing `.tu-off` rules:

```css
/* LEVEL 4 (hub tour): everything on the hub goes quiet and UNTAPPABLE except the one live target.
   .tu-off alone is not enough here — it dims a control but leaves it clickable, and a kid who taps
   🛒 חנות mid-lesson walks out of the tutorial. This repo already paid for a pointer-events
   assumption once (76686d6: corners were untappable until the next repaint because pointer-events
   was set at render time only), so the gate is a CLASS on the container, applied once, with the
   live target whitelisted — no per-render bookkeeping to get wrong. */
.hub-tu-gate .hub > *,
.hub-tu-gate .hub .hub-sat,
.hub-tu-gate .hub .hub-mode,
.hub-tu-gate .hub .hub-arena,
.hub-tu-gate .hub .hub-cs { pointer-events: none; filter: grayscale(0.7) brightness(0.55); transition: filter 0.18s ease; }
.hub-tu-gate .hub .tu-live,
.hub-tu-gate .hub .tu-live * { pointer-events: auto; filter: none; }
.hub-tu-gate .hub .tu-live { position: relative; z-index: 3; }
```

- [ ] **Step 3: Write the runner**

Add beside `tuEnter`/`tuExit`. The key difference from the match levels: **its own rAF loop**, because `tuTick` is driven from the match render loop, which does not run on the hub.

```js
// ---- LEVEL 4: the hub tour ------------------------------------------------------------
// The match levels are ticked by the game's render loop; the hub has none, so this level drives
// itself. Everything else — the step table, advance(), the hand, the captions, the nudge — is the
// same machinery the pitch levels use.
let tuHub = false;             // a hub level is running
let tuHubRAF = 0;
let tuHubEv = null;            // one-way tap latches, same contract as tuEv
let tuHubPrev = 0;
const tuHubBlankEv = () => ({ sawTrophies: false, deckMoved: false, slotFilled: false,
  heroOpened: false, friendsOpened: false, played: false });
function tuHubRunning() { return tuHub; }

// The live target gets .tu-live so the gate CSS lets it through. Re-applied every frame is wrong
// (that is the corner-tap bug); applied on every STEP CHANGE is right.
function tuHubMarkLive() {
  document.querySelectorAll('.hub .tu-live').forEach((el) => el.classList.remove('tu-live'));
  const s = stepAt(tuLvl, tuStage);
  const sel = s && TU_SPOT_SEL[s.spotlight];
  if (!sel) return;
  const el = document.querySelector(sel);
  // Whitelist the tappable ANCESTOR that the gate dimmed, not just the inner element: #home-carousel
  // and #power-slots are children of boxes the gate covers.
  if (el) (el.closest('.hub > *') || el).classList.add('tu-live');
  if (el) el.classList.add('tu-live');
}

function tuHubCtx() {
  const onHub = !!homeEl && !homeEl.classList.contains('hidden');
  return {
    ...tuHubEv,
    backOnHub: onHub,
    // Steps 4 and 5 open a screen of their own. Each needs BOTH halves: the screen opened AND the
    // kid came back — otherwise the next step's hand would point at a hub button currently hidden
    // behind the wardrobe.
    heroDone: tuHubEv.heroOpened && onHub,
    friendsDone: tuHubEv.friendsOpened && onHub,
    stepElapsed: tuStepT,
    sinceDone: tuDoneAt ? (performance.now() - tuDoneAt) / 1000 : 0,
  };
}

function tuHubEnter(level, replay) {
  tuLvl = level; tuStage = 0; tuStepT = 0; tuDoneAt = 0; tuFinishAt = 0;
  tuHub = true; tutorial = true; tuReplay = !!replay;
  tuHubEv = tuHubBlankEv();
  tuDemoEnter();                                  // Task 3; a no-op until then
  document.body.classList.add('hub-tu-gate');
  tuEl?.classList.remove('hidden');
  tuDoneEl?.classList.add('hidden');
  const pips = stepsIn(tuLvl);
  if (tuPipsEl && tuPipsEl.childElementCount !== pips) {
    tuPipsEl.innerHTML = Array.from({ length: pips }, () => '<i></i>').join('');
  }
  tuHubMarkLive();
  tuRenderOverlay();
  tuHubPrev = performance.now();
  if (!tuHubRAF) tuHubRAF = requestAnimationFrame(tuHubLoop);
}

function tuHubExit() {
  tuHub = false; tutorial = false;
  if (tuHubRAF) { cancelAnimationFrame(tuHubRAF); tuHubRAF = 0; }
  document.body.classList.remove('hub-tu-gate');
  document.querySelectorAll('.hub .tu-live').forEach((el) => el.classList.remove('tu-live'));
  tuEl?.classList.add('hidden');
  tuDemoExit();                                   // Task 3; restores the real album
}

function tuHubLoop(now) {
  if (!tuHub) { tuHubRAF = 0; return; }
  tuHubRAF = requestAnimationFrame(tuHubLoop);
  const dt = Math.min(0.25, Math.max(0, (now - tuHubPrev) / 1000));
  tuHubPrev = now;
  if (tuFinishAt) { if (now >= tuFinishAt) { tuFinishAt = 0; tuHubFinish(); } return; }
  if (isTutorialOver(tuLvl, tuStage)) return;
  // Steps 4-5 send the kid to another screen. Freeze the step clock while they are away, or a kid
  // browsing the wardrobe banks idle seconds and gets nudged the instant they come back.
  const onHub = !!homeEl && !homeEl.classList.contains('hidden');
  if (onHub) tuStepT += dt;
  const ctx = tuHubCtx();
  if (!tuDoneAt && isStepDone(tuLvl, tuStage, ctx)) tuDoneAt = performance.now();
  const last = stepsIn(tuLvl) - 1;
  if (tuStage === last && isStepDone(tuLvl, tuStage, ctx)) {
    tuStage = doneStage(tuLvl); tuFinishAt = now + 400;
    tuRenderOverlay();
    return;
  }
  const next = advance(tuLvl, tuStage, ctx);
  if (next !== tuStage) {
    tuStage = next; tuStepT = 0; tuDoneAt = 0;
    tuHubMarkLive();
    playSound('pickup', 0.5, 1.25);
    haptic('goal');
  }
  // The hand tracks live rects: the hub is a scaled stage (fitHub) and the strip scrolls, so a
  // target's position is not static.
  tuRenderOverlay();
}

// The last step's tap really starts a match, so the demo must be gone BEFORE matchmaking begins.
function tuHubFinish() {
  const L = tuLevel(tuLvl);
  if (L) tuMarkDone(L.id);
  const play = tuHubEv.played;
  tuHubExit();                                    // tears the demo down and restores the album
  if (play) { quickMatch(); return; }             // straight into a real game — the payoff
  tuDoneEl?.classList.remove('hidden');
  confettiBurst(120);
}
```

⚠️ `quickMatch()` is whatever function `#quick-match-btn`'s own handler calls — read that handler and call the same thing. Do **not** synthesise a click on the button: the gate may still be settling, and a synthetic click would re-enter the latch.

- [ ] **Step 4: Latch the taps**

One capture-phase listener on the hub, so it sees the tap before the element's own handler and cannot be lost to a re-render. Latches are one-way, matching `tuEv`.

```js
// Capture phase: the latch must not depend on the target's own handler running, or on the element
// surviving the re-render that handler triggers.
document.querySelector('.hub')?.addEventListener('pointerdown', (e) => {
  if (!tuHub || !tuHubEv) return;
  const hit = (sel) => !!(e.target.closest && e.target.closest(sel));
  if (hit('#pick-hero-btn')) tuHubEv.heroOpened = true;
  if (hit('#friends-btn')) tuHubEv.friendsOpened = true;
  if (hit('#quick-match-btn')) tuHubEv.played = true;
}, true);
```

`sawTrophies` needs no tap — the step's `minDwell` completes it, so latch it as soon as the step is on screen:

```js
// In tuHubLoop, right after the onHub check:
if (onHub && stepAt(tuLvl, tuStage)?.done === 'sawTrophies') tuHubEv.sawTrophies = true;
```

`deckMoved` and `slotFilled` are observed, not tapped, because both are the *result* of a gesture:

```js
// deckMoved: the carousel index changed. setCarousel() and the swipe handler both move cfIndex.
// Sampled in the loop rather than hooked into the carousel's internals.
if (tuHub && stepAt(tuLvl, tuStage)?.done === 'deckMoved') {
  if (tuHubDeckStart == null) tuHubDeckStart = cfIndex;
  else if (cfIndex !== tuHubDeckStart) tuHubEv.deckMoved = true;
}
// slotFilled: a slot that was empty now holds a card. The demo pins an empty loadout (Task 3), so
// on arrival all three are empty and any successful drag completes the step.
if (tuHub && stepAt(tuLvl, tuStage)?.done === 'slotFilled') {
  if (effectiveLoadout().some(Boolean)) tuHubEv.slotFilled = true;
}
```

Declare `let tuHubDeckStart = null;` beside the other hub state and reset it in `tuHubEnter`.

- [ ] **Step 5: Route entry through `where`**

```js
function startTutorial(level, replay) {
  tuReplay = !!replay;
  unlockAudio();
  // A HUB level has no room: no pitch to set up, nothing for the sim to own, and no server change
  // at all. It runs against the DOM right here.
  if (tuIsHub(level)) { tuHubEnter(level | 0, replay); return; }
  sendMsg({ type: 'tutorial', level: level | 0 });
}
```

Import `tuIsHub`, `TU_HUB_LEVEL` from `shared/tutorial.js` alongside the existing imports.

The picker needs no change — it renders from `TU_LEVELS` and calls `startTutorial(i, true)`.

- [ ] **Step 6: Verify by hand in Chrome**

```bash
PORT=3014 node server.js
```

Open `http://10.100.102.36:3014/?dev` (so the album is populated and the demo is not yet needed), run `אימון → 🎓 → 🏠 מרכז`, and confirm: the hand lands on the trophy bar, the hub is dimmed, 🛒 חנות does nothing when tapped, each step advances on the real gesture, steps 4–5 wait for the return, and the final tap starts a match.

- [ ] **Step 7: Commit**

```bash
git add public/client.js public/style.css
git commit -m "feat(tutorial): run level 4 in the hub — no room, its own loop, a real gate"
```

---

### Task 3: The demo album, sandboxed

The lesson has to work for a kid with an empty album — which is every new player on the LAN browser and a fresh Saltiz account. **This is the task with the real risk in it: unsandboxed, it writes cards a kid does not own into their real cross-device loadout.**

**Files:**
- Modify: `public/client.js`
- Modify: `public/style.css`

**Interfaces:**
- Consumes: `tuHubRunning()` (Task 2); existing `myCards`, `unlockedHeroCount`, `setSlotCard`, `swapSlots`, `saveCosmetic`, `myLoadout`, `myCosmetic`, `renderHubStats`, `renderCarousel`, `renderPowerSlots`, `renderHomeCharacter`.
- Produces: `tuDemoEnter()` / `tuDemoExit()` (called by Task 2's enter/exit), `tuDemoOn()` → `boolean`.

- [ ] **Step 1: Understand the leak before writing anything**

Read `setSlotCard`, `saveLoadout` and `saveCosmetic`. The chain is:

```
setSlotCard() → myLoadout = eff → saveLoadout() → localStorage + postPrefs()
                                → sendMsg({type:'setLoadout'})
postPrefs() → window.ReactNativeWebView.postMessage({t:'prefs', ...})
            → the APP persists the loadout under the player's PHONE NUMBER
```

So the leak is not local. Unsandboxed, a demo card reaches the player's real server-side, cross-device loadout. Three guard points cover every path: `setSlotCard`, `swapSlots`, `saveCosmetic`.

- [ ] **Step 2: Write the demo album and the guards**

```js
// ---- LEVEL 4's demo album -------------------------------------------------------------
// With an empty album the hub has nothing to teach ON: renderCarousel() ADDS `hidden` when there
// are no cards, so the deck is not even on screen, and unlockedHeroCount() returns 1, so the
// wardrobe has nothing to switch to. Three demo cards for the duration of the lesson (project
// owner's decision, spec §"The demo album").
//
// ⚠️ NOTHING HERE MAY PERSIST. saveLoadout/saveCosmetic both call postPrefs(), which posts to
// ReactNativeWebView, and the APP saves those prefs under the player's phone number — so an
// unsandboxed demo would write cards the kid does not own into their real cross-device loadout.
const TU_DEMO_CARDS = [
  { r: 'rare', n: 12, w: 120000, c: 1, demo: true },
  { r: 'common', n: 44, w: 8000, c: 2, demo: true },
  { r: 'epic', n: 7, w: 640000, c: 1, demo: true },
];
let tuDemo = false;
let tuDemoSaved = null;
function tuDemoOn() { return tuDemo; }

function tuDemoEnter() {
  if (tuDemo) return;
  // Only fake what is missing. A kid who already owns cards learns on their OWN album — always
  // better than a demo, and it means the common case carries no sandbox risk at all.
  if (myCards().length >= 3) return;
  tuDemo = true;
  tuDemoSaved = { loadout: myLoadout, cosmetic: myCosmetic };
  // The slots must arrive EMPTY or step 3 teaches nothing: effectiveLoadout() auto-fills the best
  // three whenever myLoadout is null, which is exactly a new player's state — so three demo cards
  // would fill all three slots before the step began and 'slotFilled' would be true on arrival.
  // An explicit empty loadout is also the honest picture of a new account: cards owned, none equipped.
  myLoadout = [null, null, null];
  renderHubStats(); renderCarousel(); renderPowerSlots(); renderHomeCharacter();
}

function tuDemoExit() {
  if (!tuDemo) return;
  tuDemo = false;
  myLoadout = tuDemoSaved.loadout;
  myCosmetic = tuDemoSaved.cosmetic;
  tuDemoSaved = null;
  // Restore the hub to its true state. No save, no postPrefs, no socket frame — the real values
  // were never overwritten anywhere, so putting the variables back is the whole restore.
  renderHubStats(); renderCarousel(); renderPowerSlots(); renderHomeCharacter();
}
```

Then the override inside `myCards()` — the single source for the carousel, the chips, the slots, hero unlocks and the album pushed to the server:

```js
function myCards() {
  if (tuDemo) return TU_DEMO_CARDS;               // level 4's sandboxed lesson album
  const raw = Array.isArray(window.SALTIZ_CARDS) ? window.SALTIZ_CARDS.slice(0, 256)
    : (DEV_LOCAL ? DEV_SAMPLE_CARDS : []);
  ...
}
```

and in `unlockedHeroCount()` — three cards alone still yields `floor(3/7)+1 = 1` hero, so step 4 would have nothing to change to:

```js
function unlockedHeroCount() {
  if (tuDemo) return Math.min(3, HERO_KEYS.length);   // step 4 needs something to switch TO
  return DEV_UNLOCK_ALL ? HERO_KEYS.length : Math.max(1, Math.min(HERO_KEYS.length, Math.floor(distinctOwnedCount() / 7) + 1));
}
```

The three guards. Each keeps the lesson responsive while writing nothing:

```js
function setSlotCard(slotIdx, card) {
  const eff = effectiveLoadout();
  if (card) for (let i = 0; i < 3; i++) if (eff[i] && eff[i].r === card.r && +eff[i].n === +card.n) eff[i] = null;
  eff[slotIdx] = card ? { r: card.r, n: +card.n } : null;
  // LEVEL 4 demo: equip in memory so the slot fills and the step completes, but write NOTHING —
  // no localStorage, no postPrefs (the app would save it under the player's phone), no socket.
  if (tuDemo) { myLoadout = eff; renderPowerSlots(); return; }
  myLoadout = eff; saveLoadout(myLoadout);
  renderPowerSlots();
  sendMsg({ type: 'setLoadout', loadout: myLoadout });
}
```

Apply the same early-return shape to `swapSlots`, and to `saveCosmetic`:

```js
function saveCosmetic(c) {
  if (tuDemo) return;                              // LEVEL 4 demo: the look is a lesson, not a choice
  try { localStorage.setItem('pikme_cosmetic', c); } catch { /* private mode */ }
  postPrefs();
}
```

- [ ] **Step 3: Mark the demo cards «דוגמה»**

A seven-year-old should not be shown three cards and left thinking they own them. In `renderCarousel`, after the rarity class:

```js
    if (c.demo) el.classList.add('cf-demo');
```

and in `public/style.css`:

```css
/* LEVEL 4's demo cards are a LESSON, not a collection. Say so on the card — a kid should never be
   shown three cards they don't own and left to work out later that they were props. */
.cf-card.cf-demo::after { content: 'דוגמה'; position: absolute; inset-inline-start: 4px; top: 4px;
  font: 700 9px/1 var(--pixel, monospace); color: #1b1b1b; background: #ffd06a;
  padding: 2px 4px; border-radius: 3px; letter-spacing: 0.5px; z-index: 2; }
```

- [ ] **Step 4: Verify the sandbox holds, in a real browser**

This is the assertion that makes the demo trustworthy — do it before moving on.

```bash
PORT=3014 node server.js
```

In Chrome at `http://10.100.102.36:3014/` with a **genuinely empty** `localStorage` (fresh profile, no `?dev`):
1. Read and record `localStorage['pikme-loadout']` and `localStorage['pikme_cosmetic']`.
2. Stub `window.ReactNativeWebView = { postMessage: (m) => (window.__leaks ||= []).push(m) }`.
3. Run level 4 end to end: drag a demo card into a slot, open the wardrobe and change hero, come back, finish.
4. Assert both `localStorage` values are **byte-identical** to step 1, and `window.__leaks` is empty.

- [ ] **Step 5: Commit**

```bash
git add public/client.js public/style.css
git commit -m "feat(tutorial): a sandboxed demo album so an empty hub can still teach"
```

---

### Task 4: Auto-launch on the first hub visit

**Files:**
- Modify: `public/client.js`
- Test: `test-tutorial.mjs`

**Interfaces:**
- Consumes: `TU_HUB_LEVEL`, `tuUnlocked`, `tuDoneSet`, `startTutorial`, `homeEl`, existing `tuMaybeAutoStart`.
- Produces: nothing new — extends `tuMaybeAutoStart`.

- [ ] **Step 1: Extend the auto-start**

The existing function only ever auto-launches level 1. Level 4 is the second and last exception, and unlike level 1 it is **skippable** — a kid standing on the hub already has somewhere to be.

```js
function tuMaybeAutoStart() {
  if (tutorial) return;
  if (!homeEl || homeEl.classList.contains('hidden')) return;   // only from a cold start on the hub
  const done = tuDoneSet();
  // LEVEL 1: the app opens into it, and there is no skip.
  if (!done.has(TU_LEVELS[0].id)) { startTutorial(0, false); return; }
  // LEVEL 4 (the hub tour): the FIRST time a kid actually reaches the hub. Skippable — level 1 has
  // no exit because a new player has nothing else to do yet, but a kid on the hub does.
  const hub = TU_LEVELS[TU_HUB_LEVEL];
  if (hub && !done.has(hub.id) && tuUnlocked(TU_HUB_LEVEL, done)) { startTutorial(TU_HUB_LEVEL, true); }
}
```

Passing `replay: true` is what keeps the exit button live. It is not a lie about provenance — `tuReplay` means "a way out exists", which is exactly what is wanted.

- [ ] **Step 2: Add the rule tests**

```js
// Auto-launch: level 1 is forced, the hub tour is offered once, everything else never auto-runs.
eq(tuUnlocked(TU_HUB_LEVEL, new Set(['basics'])), true, 'hub tour is reachable straight after level 1');
eq(tuUnlocked(TU_HUB_LEVEL, new Set(['basics', 'mercaz'])), true, 'and stays reachable for replay');
```

- [ ] **Step 3: Run the tests**

Run: `node test-tutorial.mjs` → PASS. Then `node --check public/client.js`.

- [ ] **Step 4: Verify in Chrome**

With `localStorage` holding `fbTuDone=basics`, load the hub: the tour launches itself once, and the exit works. Reload: it does not launch again (the id is now in the done-set).

- [ ] **Step 5: Commit**

```bash
git add public/client.js test-tutorial.mjs
git commit -m "feat(tutorial): the hub tour launches itself on the first hub visit"
```

---

### Task 5: Chrome verification end to end

Assertions, not assumptions — per `pikme-football-verify-with-chrome`. Layout and interaction claims get proven in a real browser or they do not get made.

**Files:**
- Modify: `_tu-verify.mjs`

- [ ] **Step 1: Add a level-4 pass to the verifier**

Follow the file's existing CDP driver shape (it already walks levels 1–3 with real touch and screenshots each step). Add, against `http://10.100.102.36:3014/`:

1. **Empty-album entry.** Fresh profile, `localStorage.fbTuDone='basics'`, load the hub → assert the tour auto-launched and `#tutorial` is visible.
2. **The hand lands on the target, per step.** For each of the six, read `--tu-x`/`--tu-y` off `#tutorial` and the target's `getBoundingClientRect()`, and assert the point is **inside** the target rect. This is the check that catches the class of bug `4baab4d` fixed (the hand rendering 110px short because `transform: translate` was being scaled).
3. **The gate.** Tap `#hub-settings` and the 🛒 חנות `.hub-sat` mid-tour with real `Input.dispatchTouchEvent`, and assert the screen did not change and no overlay opened. Then assert the live target IS tappable.
4. **The demo album.** Assert `#home-carousel` is NOT `hidden` despite an empty album, that it holds 3 `.cf-demo` cards, and that all three `.pslot` are `pslot-empty` on arrival (the `effectiveLoadout()` trap).
5. **The gestures.** Real drag from a `.cf-card` onto `.pslot[data-slot="0"]` → assert the slot fills and the step advances. Real taps for hero/friends → assert the step waits until `#home` is visible again.
6. **The sandbox proof.** As Task 3 step 4, asserted in the script: `pikme-loadout` and `pikme_cosmetic` byte-identical before/after, and zero `ReactNativeWebView.postMessage` calls captured.
7. **Screenshot per step**, written next to the existing ones.

- [ ] **Step 2: Run it**

Run: `node _tu-verify.mjs`
Expected: every level-4 check passes, screenshots written. Inspect the screenshots — do not just trust the pass count.

- [ ] **Step 3: Run the full suite**

Run: `for f in test*.mjs; do node $f; done`
Expected: everything green except `test-bot-ladder` / `test-bot-partner`, which fail identically on pre-tutorial code (seed-sensitive). Report those separately, never as new.

- [ ] **Step 4: Commit**

```bash
git add _tu-verify.mjs
git commit -m "test(tutorial): drive the hub tour in Chrome, and prove the demo cannot leak"
```

---

## Task 6: Merge back

- [ ] **Step 1:** `cd` to the main checkout and check whether `tutorial-coach` has committed since. `git log --oneline -5`.
- [ ] **Step 2:** Rebase the branch onto current `main`: `git rebase main` from the worktree. Expect conflicts in `shared/tutorial.js` (the `TU_LEVELS` append) and `test-tutorial.mjs` — resolve by keeping BOTH sides; these are additive.
- [ ] **Step 3:** Re-run `node test-tutorial.mjs` and `node _tu-verify.mjs` after the rebase. A clean rebase is not evidence the merged code works.
- [ ] **Step 4:** Fast-forward `main`, then remove the worktree.
- [ ] **Step 5:** Update `AGENT_REQUEST_LOG.md` — status, what was verified, what is still open. Do NOT push; the user asks for pushes explicitly.

---

## Self-Review

**Spec coverage:** every section maps to a task — the level/`where`/exemption → Task 1; the coach layer, selectors and the `pointer-events` gate → Task 2; the demo album, three guards, the `effectiveLoadout` trap and teardown-before-matchmaking → Task 3; auto-launch → Task 4; the verification list including both proofs → Task 5; the coordination note → Task 6.

**Naming consistency:** `TU_HUB_LEVEL`, `tuIsHub`, `tuHubEv`, `tuHubRunning()`, `tuDemoOn()`, `tuDemoEnter()`/`tuDemoExit()`, `tuHubEnter()`/`tuHubExit()` are used identically wherever they appear. Step ids `trophies,deck,slots,hero,friends,play` and flags `sawTrophies,deckMoved,slotFilled,heroDone,friendsDone,played` match between the level table, the ctx builder and the tests.

**Known ordering hazard:** `tuIsHub` is a `const` arrow used by `tuUnlocked`, so it must be declared above it (flagged inline in Task 1).

**Open risk carried into implementation:** `quickMatch()` in Task 2's `tuHubFinish` is a placeholder for whatever `#quick-match-btn`'s handler actually calls — Task 2 step 3 says to read that handler and call the same thing rather than synthesising a click.
