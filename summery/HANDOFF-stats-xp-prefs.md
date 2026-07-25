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

- **Slice D — stat depth** (2026-07-25): the ball carries a two-deep TOUCH CHAIN (`lastPlayer`/`prevPlayer`),
  so `goal()` credits the last kicker and falls back to the last holder — **dribble-in goals are now
  credited** — and the previous team-mate holder gets an **assist**. Added `assists`, `touches`,
  `possSec`, `distPx` to `player.stat`; match-end rounds them (`possSec`, `distM = px/100`). Backend
  `$inc`s `assists`/`touches`/`possSeconds`/`distanceM`. Covered by `test-match-stats.mjs` (12/12).
- **Slice E — ALL prefs follow the account** (2026-07-25): `PREF_KEYS` bag (audio, difficulty, touch-control
  layout, aim feel, builder style + saved fields) restores from app-injected `window.SALTIZ_PREFS` at boot
  (before any module reads those keys); a single `localStorage.setItem` hook (installed after the restore →
  no echo loop) schedules a debounced `{t:'prefs'}` push. Backend stores it as an opaque `prefs` bag on
  `footballstats` (string values, ≤40 keys, ~300KB).
- **Slice F — mid-session prefs**: `window.__pikmeApplyPrefs(p)` — the app can push prefs any time after
  load; hero + loadout apply LIVE, the extras bag lands in storage.

Live commits: game `75b7c1c`, backend `0d131ce`, app `d1b411a` (needs a new TestFlight build for the app side).

## ▢ TODO — remaining work

- [ ] **New TestFlight build** from `feat/football-store` (`d1b411a`) — the app side (stats-forward, XP
      inject, prefs inject/save) only ships in a fresh build. Game + backend are already live on Render.
- [ ] **Set `FOOTBALL_TOKEN_SECRET`** identical on BOTH Render services (pikme-football + pikmeTV-server)
      — required for Friends/Challenges only (NOT for stats/XP/prefs, which use the app's main auth token).
- [ ] **Decide `DEV_UNLOCK_ALL`** in `public/client.js` (currently `true` → all heroes unlocked). Flip to
      `false` for real 7-cards-per-hero gating; the hero-demote reconcile is a no-op until then.
- [ ] **App: call `__pikmeApplyPrefs` when prefs change mid-session** — the game hook exists and is live,
      but nothing calls it yet. In `football.jsx`, on a prefs/stats query change after mount, do
      `webRef.current?.injectJavaScript('window.__pikmeApplyPrefs(' + JSON.stringify(payload) + '); true;')`.
      Low priority (prefs rarely change while the game is open).
- [ ] **Surface the stats in the app** — nothing renders the new career fields yet
      (`careerGoals`, `assists`, `strips`, `saves`, `shotsFired`, `bombsPlanted`, `wallsBuilt`, `touches`,
      `possSeconds`, `distanceM`). They're returned by `GET /handle-user/football/stats`. A player
      profile / post-match summary screen is the obvious next feature.
- [ ] **Optional stat polish**: an assist only counts the immediately-previous holder (a two-pass move
      credits just the last passer); own goals aren't attributed; keeper `saves` counts a catch in the
      own box only. Extend the chain in `shared/sim.js` (`touchBall`) if you want deeper attribution.

## Key files (for whoever picks this up)
- Game: `public/client.js` (`renderHubXp`/`playXpReveal`, `reconcileOnCardChange`, `PREF_KEYS`/`readExtraPrefs`/`applyExtraPrefs`/`postPrefs`/`__pikmeApplyPrefs`, `loadCosmetic`/`loadLoadout`, `postMatchResult`, `myMatchStats`); `server.js` (`setCards` handler, match-end `matchStats` broadcast); `shared/sim.js` (`player.stat` + counters, `touchBall`, `goal()` credit). Tests: `test-match-stats.mjs`.
- App: `app/pages/football.jsx` (inject `SALTIZ_XP`/`SALTIZ_COSMETIC`/`SALTIZ_LOADOUT`, `onMessage` for `matchResult`/`prefs`); `services/saltizFootball.js` (`recordMatch`, `saveFootballPrefs`, `getFootballStats`).
- Backend: `data/footballstats.js` (schema); `data/football-xp.js` (`computeMatchXp`); `routes-pikme/user.js` (`/football/record-match`, `/football/stats`, `/football/prefs`).
