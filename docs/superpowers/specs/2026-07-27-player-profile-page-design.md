# Player profile page — design

**Date:** 2026-07-27
**Status:** approved by the user (brainstormed 2026-07-26 22:37 → approved 2026-07-27 08:55)
**Request:** "when user clicks his profile image I want a page with all the stats, his best hero, his top
cards, games/wins/losses, highest bot level, number of arenas built — everything. Should be scrollable
and nicely built."

## 1. Scope

A new in-game screen, `#profile`, opened by tapping your own avatar in the hub (`#home-face`, which has
no handler today). It shows every number the game and the backend already know about the player, plus
two counters that do not exist yet (best hero, highest bot level).

**Surface decision (user):** the GAME hub, not the app. An app-side profile already exists
(`pikmeTV-saltiz/app/pages/football-profile.jsx`, 245 lines, with a `הקריירה שלי` section) but it cannot
show hero art, card art or arenas-built — those live in the game and in localStorage — and every change
there needs a TestFlight build. The game page is visible at `:3012` immediately.

**Out of scope:** app-side numbers (card views, bank score). That inject is still parked — see
`AGENT_REQUEST_LOG.md`. Fold them in when it lands. Also out of scope: per-card usage / per-card win
rate, which nothing records.

## 2. Data inventory — where every number comes from

Nothing on this page is invented. Three sources:

### 2.1 Server, already built
`GET /handle-user/football/stats?phone=…` → `footballPublicStats()` in `pikme-server/routes-pikme/user.js`,
and `GET /handle-friends/rank` for the live leaderboard position.

| Shown | Field |
|---|---|
| Matches, W / L / D, win % | `matchesPlayed`, `wins`, `losses`, `draws` |
| vs humans / vs bots split | `winsVsHuman`, `winsVsBot` |
| Goals for / against / difference | `goalsFor`, `goalsAgainst` |
| Current + best streak | `streak`, `bestStreak` |
| Trophies, level, tier | `xp`, `level`, `tier` |
| Rank ladder | `rankPoints`, `rankTier`, `rankPeak`, `rankedMatches`, `unranked` |
| Leaderboard position | `/handle-friends/rank` → `rank`, `totalPlayers` |
| Career counters | `careerGoals`, `assists`, `strips`, `saves`, `shotsFired`, `bombsPlanted`, `wallsBuilt`, `touches`, `possSeconds`, `distanceM` |

### 2.2 Client, already available
- **Top cards + album totals** — `myCards()` (from the app's `window.SALTIZ_CARDS`) through the existing
  `rankCards`; worth / owned / distinct are the same numbers the hub chips show.
- **Equipped powers** — the current 3-slot loadout.
- **Hero + skin, heroes unlocked** — existing hero state (`unlockedHeroCount()`).
- **Arenas built** — the saved-fields library in localStorage (`pikme-fields`).
- **Friends count** — `/handle-friends` length + the Saltiz bot friends the player added
  (`saltizBotFriends`, see `shared/saltiz-bots.js`).

### 2.3 New — two local counters
Neither exists in any store today.

| Counter | Key | Written | Read as |
|---|---|---|---|
| Hero plays | `fbHeroPlays` — JSON `{heroKey: matches}` | +1 for the equipped hero at match end | **best hero** = the max |
| Peak bot level | `fbBestBotLevel` — integer | `max(current, botLevel of the match)` at match end | **highest bot level** |

Both are added to `PREF_KEYS` in `public/client.js`, so the existing localStorage→prefs mirror carries
them to the server's `prefs` bag and back on a new device. **No `pikme-server` change, nothing to
deploy** (the API auto-deploys on push, so avoiding it is deliberate).

Counting starts now, so both render an explicit `אין נתונים עדיין` empty state until a match is
recorded. That is honest and preferred over back-filling a number we never measured.

**Why not derive peak bot level from XP:** `botLevelFromXp` is monotonic (trophies only go up), so the
current XP-derived level would be a valid *floor* — but a player can select a HIGHER manual difficulty in
training / private / builder, and that is exactly the number "highest bot level" means. The page shows
both: the peak actually played, and the current XP-derived level.

## 3. Layout — sticky hero + scrolling stats

The hub is landscape: 844×390 on the user's phone, ~333px of usable height. A single scrolling column
would push the hero off-screen instantly and waste half the width, so the page is two panes.

```
┌─ הפרופיל שלי ────────────────────────────────┐
│  ░░ scrolls ░░              │    ████        │ fixed
│ ┌────┐┌────┐┌────┐          │    ████        │
│ │ 42 ││ 18 ││ 43%│          │   שחקן         │
│ │משחק││נצח ││אחוז│          │  🏅 כסף 3      │
│ └────┘└────┘└────┘          │  🏆 3,970      │
│ ▸ הקלפים החזקים שלי         │   רמה 9        │
│ [░][░][░]                   │  [░][░][░]     │
│ ▸ קריירה · שערים 88 · …     │                │
│ ▾                           │                │
└──────────────────────────────────────────────┘
```

**Fixed pane (RTL start side):** hero canvas with the equipped skin (the hub's own `drawHero`), name +
avatar, rank badge from the pixel `rank-<tier>` art, trophies, level, leaderboard position, and the 3
equipped power slots.

**Scrolling body — ONE scroll region, never nested:**

1. **KPI tiles** — משחקים · ניצחונות · אחוז ניצחון · שערים · רצף שיא · מגרשים
2. **הגיבור שלי** — most-played hero with its art + play count · equipped skin · heroes unlocked N/total
3. **הקלפים החזקים שלי** — top 6 by worth with real card art · album worth / owned / distinct · the
   equipped 3 marked
4. **מאזן** — a stacked W/L/D bar **with the numbers printed on it**, never colour alone
5. **קריירה** — the ten career counters; possession as `m:ss`, distance in pitch metres
6. **בוטים** — highest bot level reached + the current XP-derived level
7. **חברים ומגרשים** — friends count · arenas built

## 4. Behaviour

- **Entry / exit:** tap `#home-face` → `showScreen('profile')`. Back button plus the existing
  tap-outside-to-leave behaviour every other sub-page has.
- **Loading:** one API call on open, with a skeleton while it is in flight. If the API is unreachable the
  page still renders every client-side number (cards, hero, arenas, equipped powers) instead of going
  blank — the same "degrade, don't blank" rule the friends panel follows.
- **Empty states:** every section that can have no data says so in words.
- **Icons:** from the repo's own pixel set (`rank-*`, `cards`, `friends`, `bot`, `arena`,
  `field-library`, `goal-net`, `hero-outfit`, `power`, `speed`, `defense`, `bomb`, `build-wall`,
  `timer`). **No emoji as structural icons** — the UI skill's top style rule, and the repo already has
  96 live icons, so there is no reason to reach for emoji.
- **Numbers:** tabular figures so columns do not jitter; `fmtCompact` for large values.
- **Motion:** section entrance staggered ~40ms; `prefers-reduced-motion` respected.
- **Touch:** every target ≥44px; no horizontal scroll at any width.

## 5. Files and boundaries

| File | Role |
|---|---|
| `shared/profile-stats.js` | **new, pure.** Every derivation: win rate, best hero from the plays map, peak bot level, possession/distance formatting, section assembly. No DOM, no I/O → unit-testable. |
| `public/profile.js` | **new.** The renderer plus its own injected `<style>`. Follows the `net-hud.js` precedent, which kept a whole feature out of `index.html`/`style.css` while other agents held those files. |
| `public/client.js` | ~5 lines: the avatar click, screen registration, and the two counters at match end. |
| `public/index.html` | one empty `<div id="profile" class="screen hidden">`. |
| `test-profile-stats.mjs` | unit tests for the pure module. |
| `test-profile-page.mjs` | jsdom render test (precedent: `test-net-hud.mjs`). |

Keeping the derivations in a pure shared module and the DOM in a self-contained page module is what makes
this reviewable: the maths can be tested without a browser, and the page can be restyled without
touching the maths.

## 6. Verification

1. `node test-profile-stats.mjs` — derivations, including the empty-data paths.
2. `node test-profile-page.mjs` — jsdom: the page renders every section, and renders with the API
   returning nothing at all.
3. Full suite (`for f in test*.mjs; do node $f; done`); `test-bot-ladder.mjs` + `test-bot-partner.mjs`
   are known pre-existing fails, verified identical on a clean HEAD worktree on 2026-07-26.
4. CDP browser pass at 844×390 and 667×375: the body scrolls, nothing overflows horizontally, the fixed
   pane does not clip, and there are zero console exceptions.

## 7. Risks

- **Multi-agent file contention.** `public/client.js` and `public/index.html` are edited constantly by
  other agents; on 2026-07-26 one of them committed another agent's in-progress work. Mitigation: the
  footprint in shared files is ~6 lines, everything else is new files, and orchestration locks are taken.
- **`window.SALTIZ_CARDS` is app-injected**, so in a plain browser the album section shows the dev sample
  cards. Expected, and the same as the hub carousel today.
- **The two new counters start empty.** Accepted by the user in preference to a fabricated history.
