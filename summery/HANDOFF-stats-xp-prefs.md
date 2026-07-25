# HANDOFF — Football stats / XP / prefs pipeline (2026-07-25)

Cross-repo feature spanning **football-mock** (game), **pikmeTV-saltiz** (RN app shell, branch
`feat/football-store`), and **pikme-server** (Mongo backend, `server.pikme.tv`).

## ✅ Already SHIPPED & LIVE — do NOT redo

- **XP return-wire.** Game reads `window.SALTIZ_XP={xp,level}` → animated XP bar + post-match reveal
  (meteor + confetti + level-up). App now injects it on load and after `record-match`; backend applies
  the graded `xpFactor` (`computeMatchXp`). Live on Render.
- **Slice A — card/hero reconciliation** (football-mock): `setCards` WS msg unfreezes the join-time album;
  eager loadout clean; hero un-dangle; deep `cardsOnlySig()`. Commit `08192b4`.
- **Slice B — per-player stats**: sim `player.stat {goals,strips,saves,shots,bombs,walls}` counters →
  server sends `matchStats` at match end → client folds into `matchResult.stats` → app forwards →
  backend `record-match` `$inc`s career fields on `footballstats`. Commits `b7ce345` (game),
  `5df8f94` (server), `7022af9` (app).
- **Slice C — cross-device prefs**: `cosmetic`+`loadout` persist under phone via `POST /football/prefs`;
  `/football/stats` returns them; app injects `window.SALTIZ_COSMETIC`/`SALTIZ_LOADOUT`; game prefers
  them over localStorage and posts `{t:'prefs'}` on change. Commit `0c5de79` (game), `5df8f94`,`7022af9`.

Live commits: game `0c5de79`, backend `5df8f94`, app `7022af9` (needs a new TestFlight build to ship the app side).

## ▢ TODO — remaining / deferred work

- [ ] **New TestFlight build** from `feat/football-store` (`7022af9`) — app side (stats-forward, XP inject,
      prefs inject/save) only ships in a fresh build. Game + backend already live.
- [ ] **Set `FOOTBALL_TOKEN_SECRET`** identical on BOTH Render services (pikme-football + pikmeTV-server)
      — required for Friends/Challenges only (NOT for stats/XP/prefs, which use the app's main auth token).
- [ ] **Decide `DEV_UNLOCK_ALL`** in `public/client.js` (currently `true` → all heroes unlocked). Flip to
      `false` for real 7-cards-per-hero gating; Slice A's hero-demote is a no-op until then.
- [ ] **Stat depth — attribution gaps**:
      - Goals credit `ball.lastKicker` only (`shared/sim.js` `goal()`); a **dribble-in goal** (ball detaches,
        `lastKicker` nulled) is uncredited. Add a `lastScorer` at the dribble-in detach if you want it counted.
      - **Assists** not tracked — `ball.lastTouch` is single-slot; needs a prior-touch history.
      - **Possession time / distance / touches** not tracked (player `vx/vy` exist; no accumulator).
      - To log any of these: add counters to `player.stat` (init at `addPlayer`), increment at the hook,
        extend `matchResult.stats` (client), the app forward (`services/saltizFootball.js recordMatch`),
        and the backend schema + `record-match` `$inc` (`pikme-server data/footballstats.js` + `routes-pikme/user.js`).
- [ ] **Prefs mid-session edge case**: prefs apply at game LOAD (WebView mount is gated on the stats fetch,
      so normally present). A prefs change pushed by the app AFTER load is not re-applied — would need a
      `window.__applyPrefs()` hook + late injection, or a relaunch. Low priority (prefs rarely change mid-session).
- [ ] **Other local-only prefs still not server-persisted** (lost on reinstall/new device): control layout
      (`fbControls`), audio/difficulty (`pikme-sound`/`pikme-music`/`pikme-musicvol`/`pikme-soundvol`/`pikme-diff-level`),
      builder fields (`pikme-field-v1`/`pikme-fields`/`pikme-field-name`), `pikme-joint-style`. Same pattern as
      Slice C (extend `/football/prefs` + inject + read) if you want them to follow the account.

## Key files (for whoever picks this up)
- Game: `public/client.js` (`renderHubXp`/`playXpReveal`, `reconcileOnCardChange`, `postPrefs`, `loadCosmetic`/`loadLoadout`, `postMatchResult`, `myMatchStats`); `server.js` (`setCards` handler, match-end `matchStats` broadcast); `shared/sim.js` (`player.stat` + counters).
- App: `app/pages/football.jsx` (inject `SALTIZ_XP`/`SALTIZ_COSMETIC`/`SALTIZ_LOADOUT`, `onMessage` for `matchResult`/`prefs`); `services/saltizFootball.js` (`recordMatch`, `saveFootballPrefs`, `getFootballStats`).
- Backend: `data/footballstats.js` (schema); `data/football-xp.js` (`computeMatchXp`); `routes-pikme/user.js` (`/football/record-match`, `/football/stats`, `/football/prefs`).
