# Agent Request Log (football-mock)

Purpose: log every user request so another agent can pick up if this one fails.
Owner agent session: 420620d1 (Opus 4.8)
Working dir: /Users/adamleeperelman/Documents/pikeme/football-mock
Branch at start: feat/build-bomb-cancel
Protocol: localhost only · commit everything · lock task via agent-orchestration · short-bullet answers

---

## Request 1 — 2026-07-23
**User:** Start working on the football game. Other agents active → lock my task. All changes localhost, commit everything. Log every request for handoff. Answers = short bullets.
**Status:** Acknowledged. Awaiting concrete task. Uncommitted at start: `public/client.js`, `public/index.html` (M), `summery/TASK-field-builder.md` (untracked).
**Next:** Receive task → acquire lock → work → commit.

## Request 2 — 2026-07-23
**User:** Build a cool dancing animation for the main lobby hero. Research Fortnite dances + Brawl Stars movement + Roblox first. Show 20 examples in an artifact to choose from.
**Lock:** `lobby-hero-dance-animation` (agent dance-hero).
**Findings (rig):**
- Lobby hero = `<canvas id="home-char">` in `#pick-hero-btn` (index.html:63-64), animated by `renderHomeCharacter()` / home-dance loop (client.js:1232-1260) via `drawHero()` from `public/heroes.js`.
- `drawHero(ctx, ox, feetY, sf, dir, walkPhase, moving, firing, cosmeticId, kit, t, anim)`.
- Poses are pure fns of `time` returning `{bob,rot,dx,dy,swing,shScale, pt:{Lf,Rf,Lh,Rh,Lk?,Rk?}}` in sprite units. Rest: feet `±2.5,27`, hands `±6.5,17`, hips `±3,18`, shoulders `±6,10`, head `y0-9`.
- Existing anim actions in `resolvePose` (heroes.js:232) incl. `celebrate`(shufflePose), `idle`, `run`, `concede`. New dances = add `case`s here + pose fns.
**Plan:** research → build 20 dance pose fns → self-contained artifact previewing them with the REAL renderer inlined (striker/red kit) → user picks → wire chosen ones into heroes.js + home-dance loop.
**Deliverable:** `summery/dance-hero-previews.html` — self-contained artifact, 20 looping emotes rendered with the REAL `drawHero` (inlined verbatim + optional `sx/sy` body-scale for squash&stretch). Hero/kit/speed/play controls + source filters + shortlist tray w/ "Copy list".
**Artifact URL:** https://claude.ai/code/artifact/cc996bde-a46e-47c7-9783-18e530c1c729
**The 20 (key · source):** floss·FN, orange·FN, takel·FN, default·FN, shuffle·FN, pony·FN, hype·FN, bounce·BRAWL, victory·BRAWL, taunt·BRAWL, stomp·BRAWL, rbx-dance·RBX, rbx-disco·RBX, rbx-cheer·RBX, rbx-wave·RBX, juggle·FOOTBALL, siu·FOOTBALL, slide·FOOTBALL, robot·STYLE, noodle·STYLE.
**Verified:** node syntax-check + stubbed-DOM runtime + 8s sweep across all 20 (9420 draws, 0 non-finite coords).
**Status:** DONE — awaiting user's pick(s).
**HANDOFF (if I fail) — wiring a chosen dance into the game:**
1. Copy its pose fn from the artifact's `DANCES` array into `public/heroes.js` (units already match: feet ±2.5,27 · hands ±6.5,17 · lower y=higher).
2. If the pose uses `sx`/`sy` (squash&stretch: hype/victory/bounce/stomp/siu), add the 1-line scale-about-feet block to `drawHero` (see artifact's `drawHeroPose`, the `A.sx/A.sy` translate+scale) — real heroes.js doesn't have it yet.
3. Add a `case` in `resolvePose` (heroes.js:232) OR drive it from the home-dance loop in `client.js:1232-1260` (`renderHomeCharacter`) by passing an `anim:{action:'<key>'}` / calling the pose directly.
4. Home hero canvas = `#home-char` in `#pick-hero-btn` (index.html:63-64).
**Not touched:** heroes.js / client.js / index.html (no game-code edits until user picks).

## Request 3 — 2026-07-23
**User pick / verdict on the 20:** Fortnite = all good · Brawl = drop all · Roblox = keep only Cheer + Wave · Football = all good · Style = keep only Noodle Wobble. → "add them to the game anime, all speed ×1.5". Main lobby hero: keep current walking + all Fortnite EXCEPT hype + noodle, start random & re-roll after each costume/hero change. Wardrobe (hero-change page): walking only.
**Locks:** public/heroes.js, public/client.js, lobby-hero-dance-animation (agent dance-hero).
**Implemented:**
- `public/heroes.js`: added `S/C/abs` aliases; `DANCE_SPEED=1.5`; exported `LOBBY_DANCES=['walk','floss','orange','takel','default','shuffle','pony','noodle']`; 13 pose fns (flossPose, orangePose, takeLPose, defaultDancePose, electroPose['shuffle'], ponyPose, hypePose, cheerPose, wavePose, jugglePose, siuPose, slidePose, noodlePose); 13 `resolvePose` cases (fed `time*DANCE_SPEED`); `sx/sy` squash-&-stretch scale-about-feet in `drawHero` + `sx:1,sy:1` in resolvePose base. (Brawl bounce/victory/taunt/stomp, roblox dance/disco, robot = intentionally NOT added.)
- `public/client.js`: import `LOBBY_DANCES`; module-scope `homeDanceAction` + `rerollHomeDance()` (random on load); `drawDancer` branches walk (moving .7) vs emote (`anim:{action}`); `saveAndClose()` calls `rerollHomeDance()`. Wardrobe preview (client.js ~1348 loop) + thumbnails UNCHANGED = walk/static only.
**Library emotes added but NOT in lobby pool:** hype, cheer, wave, juggle, siu, slide (available via `anim:{action}` anywhere, e.g. match celebrations).
**Verified:** node --check both modules; headless drive of REAL drawHero across walk+all 13 (5614 draws, 0 non-finite); sx/sy engaged for hype/siu; unknown action → base; server serves /,/client.js,/heroes.js = 200 with exports wired.
**Status:** DONE — committed. Locks to release.

## Request 4 — 2026-07-23
**User:** Remove the Fortnite "Dance Moves" (OG default) entirely.
**Done (heroes.js only):** dropped `'default'` from `LOBBY_DANCES`; removed `defaultDancePose` fn + its `resolvePose` case. Pool now = `['walk','floss','orange','takel','shuffle','pony','noodle']`. Verified: 0 residual refs, node --check OK.
**Status:** DONE — committed.

## Request 5 — 2026-07-23
**User:** Lobby hero should start a dance, then after a couple seconds do a random dance move, then return to walking.
**Done (client.js only):** replaced the static single-pick (`homeDanceAction`/`rerollHomeDance`) with a timed routine `advanceHomeRoutine(nowMs)` driven off `performance.now()`. Cycle = `[randomEmote 2.6s] → [other randomEmote 2.6s] → [walk 3.4s]`, looping with fresh randoms; 2nd emote avoids repeating the 1st. `LOBBY_EMOTES = LOBBY_DANCES − 'walk'`. Starts on a dance on load; `saveAndClose` now calls `restartHomeRoutine()` (clears queue → next frame starts fresh dance). Wardrobe preview still walk-only.
**Verified:** node --check OK; timeline sim → `0.0 shuffle | 2.6 orange | 5.2 walk | 8.6 … (loops, fresh randoms)`, first action always a dance.
**Status:** DONE — committed.
