# Profile panel scroll · friend rank · unfriend confirm · three new arenas

**Date:** 2026-08-02 · **Status:** approved by Adam · **Ships:** game-side only (Render), no app build.

> ✅ **SHIPPED 2026-08-03.** The hold is over: 3.3.3 went READY_FOR_SALE on the App Store and Adam
> gave the word, so this is pushed and live on Render. (It was deliberately held while 3.3.3 was in
> review, because the reviewer opens the LIVE game — that reasoning stands for the next time.)

## Why these are safe to ship without review

Release builds hardcode `PROD_GAME_URL` and load the game in a WebView with `?v=<launch>` plus
`no-store`, so game changes reach every installed build on the next launch. None of this adds a
feature Apple has not seen — a scroll fix, a confirmation dialog, a rank readout and extra field
presets.

## 1. The profile side panel is unreachable on iPhone

**Reported:** "in the my profile ... the right panel the hero and user stats the clubs etc are
clipped. i see the clubs clipped and the trophies and ranked not visible (which they are in the ipad)".

**Cause (read in the code, not guessed):** `public/profile.js` sets `.pf-side { overflow: hidden }` on
a fixed 176px column, while the main column `.pf-body` already has `overflow-y: auto`. The game is
landscape-locked, so an iPhone gives ~390px of height against an iPad's ~834px. `clubs.js` appends its
club + `.pc-ranks` block into `.pf-side` from the outside, which pushes trophies/ranked past the
bottom edge — visible on iPad, unreachable on iPhone.

**Fix:** `.pf-side` becomes `overflow-y: auto; overflow-x: hidden; min-height: 0;` with touch
momentum. One panel, one rule; nothing else about the layout changes.

## 2. A friend's rank is not shown

**Reported:** "when i click a friend profile it dosnt show me his rank".

`clubs.js#injectInto` already builds `.pc-ranks` (גביעים #place, דירוג #place) from
`/handle-clubs/player/:id` and injects it into `#friend-profile-modal`. So the block either never
arrives (the call fails and `if (p.error) return` swallows it) or it lands below the fold — the same
short-viewport problem as §1. Both get fixed:

- the friend modal body scrolls, like §1;
- **rank also goes into the always-visible header line.** `#fp-stats` reads `XP · שווי · קלפים`
  today; it gains the rank so it cannot hide below a scroll at any height.

## 3. Unfriending is too easy

**Reported:** "i want to make a are you sure, when removeing friends. currently it too easy".

Both paths (`client.js#removeFriend`, `clubs.js` `.pc-remove`) already call `window.confirm()`. That
they still feel instant means **the WebView is not presenting the native JS dialog** — note a
suppressed `confirm()` returns `false`, which would block removal rather than allow it, so the exact
host behaviour needs confirming on device.

**Fix:** stop depending on the host. An in-game confirmation — game styling, Hebrew, בטל / הסר —
used by both call sites, so the guard is the game's own DOM and is testable in a harness.

## 4. Three new arenas

An "arena" here is a **field preset**: an obstacle layout in the field-builder save shape
`{ version, bushes, hardWalls, dryWalls, crates }`, listed in `shared/field-presets.js`
(today ראשי / שלושות / קלאסי / ריק). Pure data — no art, no engine change; the server loads it
through the same `setField()` path.

**Constraints every new layout must satisfy** (the pitch is `FIELD 2000×1100`):
- mirror-symmetric about **both** x=1000 and y=550, so neither team gets the better half;
- the 2v2 spawn spots stay clear — `formationSlot` puts them at x≈300 / 1700, y≈396 / 704;
- both goal mouths stay clear — `GOAL` is 300 wide, 70 deep, so y 400–700 at each end;
- the centre must remain walkable enough that four bodies do not deadlock (the lesson recorded in
  `field-3v3.js`, where a dense middle became a scrum).

**The three:**
- **מסדרונות** — two long lane dividers split the pitch into three channels; a passing and
  positioning field where cutting inside costs time.
- **טבעת** — a ring of crates around the centre circle with four gaps; whoever holds the ring holds
  the ball, and the gaps stop it becoming a wall.
- **מבצר** — cover packed near each goal, midfield left open; rewards long shots and committed pushes
  rather than centre scrums.

## Verification

- `_panel-clip.mjs` — measures, at **844×390 (iPhone landscape)** and **1194×834 (iPad)**, whether the
  clubs and rank blocks are in the DOM, whether they are fully visible, and whether their container
  can scroll. ⚠️ It must open the profile by clicking the **avatar** (`.friend-pfp`): the friend row
  itself is tap-to-chat, which is why the first version of this harness measured nothing.
- A harness for the unfriend confirm: the remove button must not call `DELETE` until the in-game
  confirm is accepted, and must call it exactly once when it is.
- New arenas: a unit test asserting each preset is mirror-symmetric on both axes and leaves the spawn
  spots and goal mouths clear — so a future hand-authored field cannot quietly break fairness.
- Keep the suite green: `for f in test*.mjs; do node $f; done`.
