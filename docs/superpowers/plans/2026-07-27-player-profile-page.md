# Player Profile Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tapping your own avatar in the game hub opens a scrollable profile screen showing every stat the game and backend know — hero, top cards, W/L, career counters, highest bot level, arenas built.

**Architecture:** All derivations live in a new pure module `shared/profile-stats.js` (no DOM, no I/O, unit-tested). All pixels live in a new self-contained `public/profile.js` that injects its own markup and `<style>`, following the `net-hud.js` precedent — so `index.html`/`style.css`, which several agents edit concurrently, take almost no diff. `public/client.js` gets ~6 lines of hooks.

**Tech Stack:** Vanilla ES modules served from `public/` + `shared/`, no build step. Tests are plain `node test-*.mjs` scripts; DOM tests use the repo's existing `jsdom` devDependency.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-27-player-profile-page-design.md`. Read it first.
- **No emoji as structural icons.** Use the repo's pixel set: `public/assets/pixel-icon-system-01/transparent/<id>.png`, ids from `ASSET_REGISTRY.json` (96 live). Relevant ids: `rank`, `rank-bronze|silver|gold|platinum|diamond|champion|legend`, `cards`, `friends`, `bot`, `arena`, `field-library`, `goal-net`, `hero-outfit`, `skin`, `power`, `speed`, `defense`, `bomb`, `build-wall`, `timer`, `stadium`, `season-star`, `training`.
- **Hebrew, RTL.** Every user-facing string is Hebrew. Containers set `dir="rtl"`.
- **Landscape.** Target 844×390 and 667×375 phone viewports (~333px usable height headless). No horizontal scroll at any width. One scroll region only — never nest scrollers.
- **Touch targets ≥44px.** Tabular figures for stat columns. `prefers-reduced-motion` respected. Never convey meaning by colour alone.
- **Degrade, don't blank:** if the API returns nothing, still render every client-side section.
- **Two new localStorage keys:** `fbHeroPlays`, `fbBestBotLevel`. Both MUST be added to `PREF_KEYS` in `public/client.js` so the existing mirror syncs them cross-device.
- **Multi-agent repo:** take orchestration locks (`football-mock:<path>`) before editing `public/client.js` or `public/index.html`; `git status` before every commit; commit ONLY your own files; never push.
- Keep the suite green: `for f in test*.mjs; do node $f; done`. `test-bot-ladder.mjs` and `test-bot-partner.mjs` are known pre-existing fails (verified identical on a clean HEAD worktree 2026-07-26) — report them separately, do not "fix" them.

---

## File Structure

| File | Responsibility |
|---|---|
| `shared/profile-stats.js` | **new, pure.** Derivations + section assembly. No DOM, no fetch, no localStorage. |
| `test-profile-stats.mjs` | **new.** Unit tests for the above, including every empty-data path. |
| `public/profile.js` | **new.** Builds the `#profile` screen's DOM, injects its own CSS, exposes `renderProfile(model)`. |
| `test-profile-page.mjs` | **new.** jsdom render test: all sections present; renders with a null API response. |
| `public/index.html` | **modify.** One line: `<div id="profile" class="screen hidden"></div>`. |
| `public/client.js` | **modify,** ~6 lines: PREF_KEYS entries · avatar click · screen registration · counter bump at match end · the data fetch. |
| `pikme-server/routes-pikme/friends.js` | **modify.** `/handle-friends/rank` also returns the career/W-L block (Task 5). |
| `pikme-server/test-football-profile-rank.mjs` | **new.** Asserts the added fields are present and additive. |

---

### Task 1: `shared/profile-stats.js` — the pure derivations

**Files:**
- Create: `shared/profile-stats.js`
- Test: `test-profile-stats.mjs`

**Interfaces:**
- Consumes: `clampLevel` from `./difficulty.js` (already exists, clamps to 0..11).
- Produces, all named exports:
  - `winRate(wins, matches) -> number` (integer percent, 0 when matches is 0)
  - `goalDiff(goalsFor, goalsAgainst) -> number`
  - `bumpHeroPlays(playsMap, heroKey) -> object` (new map, never mutates input)
  - `bestHero(playsMap) -> { key, plays } | null` (null when the map is empty; ties break by highest key order stability — first-seen wins)
  - `bumpBestBotLevel(prev, botLevel) -> number` (clamped 0..11, never decreases, ignores non-finite)
  - `fmtDuration(seconds) -> string` (`m:ss`, `0:00` for 0/invalid)
  - `heroKeyOf(cosmetic) -> string` (`'striker'` from `'striker:gold'`; `''` for junk)
  - `buildProfileModel(input) -> model` — the single function `public/profile.js` renders. Input:
    `{ stats, xpState, rank, cards, heroPlays, bestBotLevel, arenaCount, friendCount, cosmetic, unlockedHeroes, loadout }`.
    Every field optional; missing input becomes an explicit empty section, never a thrown error or a fake zero.
    Model shape: `{ hero:{key,plays,cosmetic,unlocked,hasData}, kpis:[{id,label,value,icon}], record:{wins,losses,draws,matches,rate,vsHuman,vsBot,hasData}, goals:{for,against,diff,hasData}, career:[{id,label,value,icon}], bots:{peak,current,hasData}, album:{top,worth,owned,distinct,loadout}, social:{friends,arenas} }`

- [ ] **Step 1: Write the failing test**

Create `test-profile-stats.mjs`:

```js
// Pure derivations behind the profile page. The point of this file: every number the page shows
// must survive the two states the page will really meet — a brand-new player (all zeros, no
// counters) and a mid-season player — without inventing data or throwing.
import assert from 'node:assert';
import {
  winRate, goalDiff, bumpHeroPlays, bestHero, bumpBestBotLevel, fmtDuration, heroKeyOf,
  buildProfileModel,
} from './shared/profile-stats.js';

let pass = 0;
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); pass++; };
const ok = (c, m) => { assert.ok(c, m); pass++; };

// winRate — integer percent, and 0 matches must not be NaN/Infinity.
eq(winRate(18, 42), 43, 'winRate rounds to an integer percent');
eq(winRate(0, 0), 0, 'winRate of a new player is 0, not NaN');
eq(winRate(3, 3), 100, 'winRate can reach 100');
eq(winRate(5, 0), 0, 'winRate ignores impossible input');

eq(goalDiff(88, 60), 28, 'goalDiff subtracts');
eq(goalDiff(0, 0), 0, 'goalDiff of nothing is 0');
eq(goalDiff(2, 9), -7, 'goalDiff can be negative');

// heroKeyOf — cosmetic is "hero:skin".
eq(heroKeyOf('striker:gold'), 'striker', 'heroKeyOf takes the part before the colon');
eq(heroKeyOf('alien'), 'alien', 'heroKeyOf accepts a bare hero');
eq(heroKeyOf(''), '', 'heroKeyOf of empty is empty');
eq(heroKeyOf(null), '', 'heroKeyOf of null is empty');

// bumpHeroPlays — immutable, counts up.
const p0 = {};
const p1 = bumpHeroPlays(p0, 'striker');
eq(JSON.stringify(p0), '{}', 'bumpHeroPlays does not mutate its input');
eq(p1.striker, 1, 'first play counts 1');
eq(bumpHeroPlays(p1, 'striker').striker, 2, 'second play counts 2');
eq(bumpHeroPlays(p1, 'alien').striker, 1, 'a different hero leaves the first alone');
eq(JSON.stringify(bumpHeroPlays(p1, '')), JSON.stringify(p1), 'an empty hero key is ignored');

// bestHero — the "best hero" answer, and its empty state.
eq(bestHero({}), null, 'no plays yet -> null, which the page renders as an empty state');
eq(bestHero(null), null, 'null map -> null');
eq(bestHero({ striker: 3, alien: 9, dwarf: 1 }).key, 'alien', 'bestHero picks the most played');
eq(bestHero({ striker: 3, alien: 9 }).plays, 9, 'bestHero reports the count');
eq(bestHero({ striker: 4, alien: 4 }).key, 'striker', 'a tie keeps the first-seen hero (stable)');

// bumpBestBotLevel — monotone and clamped.
eq(bumpBestBotLevel(0, 7), 7, 'a higher level raises the peak');
eq(bumpBestBotLevel(9, 4), 9, 'a lower level does NOT lower the peak');
eq(bumpBestBotLevel(undefined, 3), 3, 'no previous peak starts at the new level');
eq(bumpBestBotLevel(5, 99), 11, 'above the ladder clamps to 11');
eq(bumpBestBotLevel(5, -3), 5, 'below the ladder is ignored');
eq(bumpBestBotLevel(5, null), 5, 'a missing level is ignored');

// fmtDuration
eq(fmtDuration(0), '0:00', 'zero possession reads 0:00');
eq(fmtDuration(65), '1:05', 'seconds pad to two digits');
eq(fmtDuration(3599), '59:59', 'just under an hour');
eq(fmtDuration(null), '0:00', 'invalid input is 0:00, not NaN:NaN');

// buildProfileModel — the empty case FIRST, because that is a brand-new player's real experience.
const empty = buildProfileModel({});
ok(empty && empty.kpis.length > 0, 'an empty model still has KPI tiles');
eq(empty.record.hasData, false, 'no matches -> record section flags no data');
eq(empty.bots.hasData, false, 'no bot level yet -> bots section flags no data');
eq(empty.hero.hasData, false, 'no hero plays yet -> hero section flags no data');
eq(empty.album.top.length, 0, 'no cards -> no top cards');
eq(empty.social.arenas, 0, 'no arenas -> 0');
ok(empty.kpis.every((t) => t.value !== undefined && t.label), 'every KPI tile has a label and a value');

// buildProfileModel — a populated player.
const full = buildProfileModel({
  stats: {
    matchesPlayed: 42, wins: 18, losses: 17, draws: 7, winsVsHuman: 15, winsVsBot: 3,
    goalsFor: 88, goalsAgainst: 60, streak: 2, bestStreak: 6,
    careerGoals: 31, assists: 12, strips: 40, saves: 9, shotsFired: 220,
    bombsPlanted: 55, wallsBuilt: 77, touches: 900, possSeconds: 605, distanceM: 4210,
  },
  xpState: { xp: 3970, level: 9 },
  rank: { rank: 3, totalPlayers: 27, rankPoints: 454, rankTier: 'silver' },
  cards: [
    { r: 'legendary', n: 5, c: 2, w: 90000 }, { r: 'epic', n: 7, c: 1, w: 40000 },
    { r: 'rare', n: 22, c: 3, w: 7000 }, { r: 'common', n: 8, c: 5, w: 500 },
  ],
  heroPlays: { striker: 12, alien: 30 },
  bestBotLevel: 10,
  arenaCount: 4,
  friendCount: 6,
  cosmetic: 'alien:neon',
  unlockedHeroes: 5,
  loadout: [{ r: 'legendary', n: 5 }, null, { r: 'rare', n: 22 }],
});
eq(full.record.rate, 43, 'model carries the win rate');
eq(full.record.hasData, true, 'a played player has record data');
eq(full.goals.diff, 28, 'model carries the goal difference');
eq(full.hero.key, 'alien', 'model names the most-played hero');
eq(full.hero.plays, 30, 'model carries its play count');
eq(full.bots.peak, 10, 'model carries the peak bot level');
eq(full.album.owned, 11, 'album owned = total copies');
eq(full.album.distinct, 4, 'album distinct = unique cards');
eq(full.album.worth, 137500, 'album worth = sum of worth');
ok(full.album.top.length && full.album.top[0].r === 'legendary', 'top cards are best-first');
eq(full.career.length, 10, 'all ten career counters are present');
ok(full.career.every((c) => c.label && c.icon), 'every career row has a label and an icon id');
ok(full.career.some((c) => c.id === 'possSeconds' && c.value === '10:05'), 'possession is formatted as time');
eq(full.social.friends, 6, 'model carries the friend count');
eq(full.social.arenas, 4, 'model carries the arena count');

// A partially-deployed backend (rank route without the career block) must not break the page.
const partial = buildProfileModel({ stats: { xp: 500, level: 4 }, xpState: { xp: 500, level: 4 } });
eq(partial.career.length, 10, 'career rows still render (as zeros) when the backend omits them');
eq(partial.record.hasData, false, 'but the record section honestly says it has no data');

console.log(`✅ test-profile-stats: ${pass} assertions passed`);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test-profile-stats.mjs`
Expected: FAIL — `Cannot find module './shared/profile-stats.js'`.

- [ ] **Step 3: Write the module**

Create `shared/profile-stats.js`. Every export named in the Interfaces block above, with these rules baked in:
- `winRate`: `matches > 0 ? Math.round(wins / matches * 100) : 0`, both coerced with `Number()` and guarded by `Number.isFinite`.
- `bumpHeroPlays`: returns `{ ...map, [key]: (map[key] || 0) + 1 }`, and returns the input untouched for a falsy key.
- `bestHero`: single pass with `>` (not `>=`) so a tie keeps the first-seen key — that is what makes it stable across renders.
- `bumpBestBotLevel`: `Math.max(prevSafe, clampLevel(level))` but only when `Number.isFinite(level) && level >= 0`, else `prevSafe`.
- `buildProfileModel`: reads every input through a `num()` helper, and sets each section's `hasData` from a real signal (`matchesPlayed > 0`, `bestBotLevel != null`, `bestHero() != null`) rather than from truthiness of a derived number — a real 0 must be distinguishable from "not measured".
- The KPI tile list, the career row list, and their Hebrew labels + pixel icon ids live HERE (data), not in the renderer (pixels).
  Career rows in order: `careerGoals` שערים · `assists` בישולים · `strips` חטיפות · `saves` הצלות · `shotsFired` בעיטות · `bombsPlanted` פצצות · `wallsBuilt` קירות · `touches` נגיעות · `possSeconds` זמן עם הכדור · `distanceM` מרחק.

- [ ] **Step 4: Run test to verify it passes**

Run: `node test-profile-stats.mjs`
Expected: PASS, ~60 assertions.

- [ ] **Step 5: Commit**

```bash
git add shared/profile-stats.js test-profile-stats.mjs
git commit -m "feat(profile): pure stat derivations for the player profile page"
```

---

### Task 2: the two new counters, written at match end

**Files:**
- Modify: `public/client.js` — `PREF_KEYS` (~line 132) and `postMatchResult` (~line 569)
- Test: `test-profile-stats.mjs` (extend — the logic is already pure from Task 1)

**Interfaces:**
- Consumes: `bumpHeroPlays`, `bumpBestBotLevel`, `heroKeyOf` from `shared/profile-stats.js`.
- Produces: `localStorage.fbHeroPlays` (JSON object) and `localStorage.fbBestBotLevel` (integer string), both in `PREF_KEYS`.

- [ ] **Step 1: Extend the test with the storage round-trip**

Append to `test-profile-stats.mjs` a test of the read/write helpers as PURE functions — `readCounters(getItem)` and `writeCounters(setItem, patch)` style, injected accessors, so no localStorage is needed in node:

```js
// The counter round-trip, with storage injected — a corrupt or absent value must never throw
// on the hub's hot path.
import { readHeroPlays, readBestBotLevel } from './shared/profile-stats.js';
eq(JSON.stringify(readHeroPlays(() => null)), '{}', 'absent hero plays read as {}');
eq(JSON.stringify(readHeroPlays(() => 'not json')), '{}', 'corrupt hero plays read as {}');
eq(JSON.stringify(readHeroPlays(() => '{"striker":3}')), '{"striker":3}', 'valid hero plays parse');
eq(JSON.stringify(readHeroPlays(() => '[1,2]')), '{}', 'an array is not a plays map');
eq(readBestBotLevel(() => null), null, 'absent peak reads null (= no data), NOT 0');
eq(readBestBotLevel(() => '7'), 7, 'stored peak parses');
eq(readBestBotLevel(() => 'x'), null, 'corrupt peak reads null');
eq(readBestBotLevel(() => '99'), 11, 'stored peak is clamped on read too');
```

Note the load-bearing distinction: an absent peak is `null` ("never measured"), not `0` ("beat level 0").

- [ ] **Step 2: Run test to verify it fails**

Run: `node test-profile-stats.mjs`
Expected: FAIL — `readHeroPlays is not a function`.

- [ ] **Step 3: Implement the readers in the pure module, then the 3-line hook in client.js**

In `shared/profile-stats.js` add `readHeroPlays(getItem)` and `readBestBotLevel(getItem)` per the test.

In `public/client.js`:
1. Add to `PREF_KEYS`: `'fbHeroPlays', 'fbBestBotLevel',` with the comment `// profile page: most-played hero + peak bot level`.
2. Add the import to the existing `shared/` import block.
3. In `postMatchResult`, immediately after `payload` is built (so it runs for every finished match, app or browser):

```js
    // Profile counters. Local, but PREF_KEYS-mirrored, so they follow the account to a new device.
    // Written here rather than in the app because the app never learns which hero was worn.
    try {
      const hk = heroKeyOf(MY_COSMETIC || DEFAULT_COSMETIC);
      const plays = bumpHeroPlays(readHeroPlays((k) => localStorage.getItem(k)), hk);
      localStorage.setItem('fbHeroPlays', JSON.stringify(plays));
      const peak = bumpBestBotLevel(readBestBotLevel((k) => localStorage.getItem(k)), matchDiffFloor);
      localStorage.setItem('fbBestBotLevel', String(peak));
    } catch { /* private mode: the profile page just shows its empty state */ }
```

Use whatever the file's actual variable for the worn cosmetic is (grep `MY_COSMETIC`/`myCosmetic` first) — do not invent a name.

- [ ] **Step 4: Verify**

Run: `node test-profile-stats.mjs` → PASS.
Then confirm the hook is reachable and syntactically live in a browser: `PORT=3915 node server.js`, load the page in headless Chrome, and evaluate `typeof window.localStorage.getItem('fbHeroPlays')` plus check `Runtime.exceptionThrown` is silent. A parse error in client.js kills the whole hub, so this check is not optional.

- [ ] **Step 5: Commit**

```bash
git status --short          # confirm no foreign diff is being swept up
git add shared/profile-stats.js test-profile-stats.mjs public/client.js
git commit -m "feat(profile): count hero plays + peak bot level at match end"
```

---

### Task 3: `public/profile.js` — the page

**Files:**
- Create: `public/profile.js`
- Test: `test-profile-page.mjs`

**Interfaces:**
- Consumes: `buildProfileModel` from `../shared/profile-stats.js` (relative path, so jsdom can import it), `drawHero` from `./heroes.js` for the hero canvas.
- Produces: `export function renderProfile(root, model)` — idempotent: calling it twice replaces the content, never duplicates it. `export const PROFILE_SECTIONS` — the ordered section ids, so the test can assert coverage without hardcoding a second list.

- [ ] **Step 1: Write the failing jsdom test**

Create `test-profile-page.mjs`, modelled on `test-net-hud.mjs`:

```js
// DOM-level test for the profile page, driven through jsdom. The maths is covered by
// test-profile-stats.mjs; this checks the page PAINTS every section, survives an empty model,
// and does not nest a second scroll region (the one layout rule the design doc calls load-bearing).
import { JSDOM } from 'jsdom';
import { buildProfileModel } from './shared/profile-stats.js';

let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + '  ' + m); if (!c) fails++; };

const dom = new JSDOM('<!doctype html><html><body><div id="profile" class="screen hidden"></div></body></html>',
  { url: 'http://localhost:3012/' });
global.window = dom.window; global.document = dom.window.document; global.location = dom.window.location;
// The hero canvas: jsdom has no 2d context, so the page must tolerate getContext() returning null.
dom.window.HTMLCanvasElement.prototype.getContext = () => null;

const { renderProfile, PROFILE_SECTIONS } = await import('./public/profile.js');
const root = document.getElementById('profile');

// 1. A brand-new player: every section still renders, with empty states, and nothing throws.
renderProfile(root, buildProfileModel({}));
for (const id of PROFILE_SECTIONS) ok(!!root.querySelector(`[data-section="${id}"]`), `empty model renders section ${id}`);
ok(root.querySelectorAll('.pf-empty').length >= 3, 'empty model shows explicit empty states');
ok(!/undefined|NaN|null/.test(root.textContent), 'no undefined/NaN/null leaks into the copy');

// 2. A populated player.
const model = buildProfileModel({
  stats: { matchesPlayed: 42, wins: 18, losses: 17, draws: 7, winsVsHuman: 15, winsVsBot: 3,
    goalsFor: 88, goalsAgainst: 60, bestStreak: 6, careerGoals: 31, assists: 12, strips: 40,
    saves: 9, shotsFired: 220, bombsPlanted: 55, wallsBuilt: 77, touches: 900, possSeconds: 605, distanceM: 4210 },
  xpState: { xp: 3970, level: 9 }, rank: { rank: 3, totalPlayers: 27, rankPoints: 454, rankTier: 'silver' },
  cards: [{ r: 'legendary', n: 5, c: 2, w: 90000 }, { r: 'epic', n: 7, c: 1, w: 40000 }],
  heroPlays: { alien: 30 }, bestBotLevel: 10, arenaCount: 4, friendCount: 6,
  cosmetic: 'alien:neon', unlockedHeroes: 5, loadout: [{ r: 'legendary', n: 5 }, null, null],
});
renderProfile(root, model);
for (const id of PROFILE_SECTIONS) ok(!!root.querySelector(`[data-section="${id}"]`), `full model renders section ${id}`);
ok(root.textContent.includes('43'), 'the win rate is on the page');
ok(root.textContent.includes('10:05'), 'possession time is formatted on the page');
ok(root.querySelectorAll('[data-section="album"] img').length > 0, 'top cards render art');

// 3. Idempotent: rendering twice must not duplicate the page.
const before = root.querySelectorAll('[data-section]').length;
renderProfile(root, model);
ok(root.querySelectorAll('[data-section]').length === before, 'rendering twice does not duplicate sections');

// 4. No emoji as structural icons, and exactly one scroll region.
ok(!/[\u{1F300}-\u{1FAFF}]/u.test(root.innerHTML.replace(/<!--[\s\S]*?-->/g, '')), 'no emoji used as icons');
const scrollers = [...root.querySelectorAll('*')].filter((el) => /auto|scroll/.test(el.getAttribute('style') || ''));
ok(scrollers.length <= 1, `at most one inline scroll region (found ${scrollers.length})`);

console.log(fails ? `❌ test-profile-page: ${fails} FAILED` : '✅ test-profile-page passed');
process.exit(fails ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test-profile-page.mjs`
Expected: FAIL — cannot resolve `./public/profile.js`.

- [ ] **Step 3: Write the page module**

Create `public/profile.js`:
- A module-scope `CSS` template string injected once via a `<style>` element on first render (net-hud.js pattern). Class prefix `pf-`. Scroll only on `.pf-body` (`overflow-y:auto`); the fixed pane is `.pf-hero`. Grid: `display:flex` with the hero pane `flex:0 0 190px` and the body `flex:1`.
- `renderProfile(root, model)`: clears `root`, builds head (back button + `הפרופיל שלי`), the fixed hero pane, then each section from `PROFILE_SECTIONS` via a small `section(id, title, iconId)` helper that returns the wrapper with `data-section=<id>`.
- Icons via `<img class="pf-ic" src="/assets/pixel-icon-system-01/transparent/<id>.png" alt="">` — decorative, so `alt=""`, and the label beside it carries the meaning.
- Card art reuses the existing base URL: `https://pxsjmychuxwufcvqixgu.supabase.co/storage/v1/object/public/cards/<r>/<n>.webp`, each `<img loading="lazy">` with an `onerror` that drops the src (same guard as `paintFriendSlots`).
- Hero canvas: `getContext('2d')` may be null (jsdom, or a lost context) — guard it and skip drawing rather than throwing.
- Every `hasData:false` section renders `<div class="pf-empty">אין נתונים עדיין — שחקו משחק</div>` instead of zeros.
- W/L/D bar: three flex children sized by percentage, each printing its own number, plus a text summary `18 נצחונות · 17 הפסדים · 7 תיקו` so the meaning never depends on colour.
- `@media (prefers-reduced-motion: reduce)` block that zeroes the stagger animation.

- [ ] **Step 4: Run test to verify it passes**

Run: `node test-profile-page.mjs`
Expected: PASS on every line.

- [ ] **Step 5: Commit**

```bash
git add public/profile.js test-profile-page.mjs
git commit -m "feat(profile): the profile page renderer (self-contained module)"
```

---

### Task 4: wire it into the hub

**Files:**
- Modify: `public/index.html` — add `<div id="profile" class="screen hidden"></div>` beside the other sub-page screens
- Modify: `public/client.js` — screen registration, avatar click, data fetch
- Test: CDP browser pass (no new test file)

**Interfaces:**
- Consumes: `renderProfile` from `/profile.js`, `buildProfileModel` from `/shared/profile-stats.js`.
- Produces: `openProfile()` in client.js, bound to `#home-face`.

- [ ] **Step 1: Take the locks and add the markup**

```
lock_acquire football-mock:public/index.html
lock_acquire football-mock:public/client.js
```
Then add the one div to `index.html` next to `#friends`.

- [ ] **Step 2: Register the screen and bind the avatar**

In `public/client.js`:
1. Add `profile: document.getElementById('profile')` to the `screens` map (~line 741) — nothing else drives open/close.
2. Add `'profile'` to the tap-outside-to-dismiss registration list (~line 2329) so it closes like every other sub-page.
3. Bind the avatar:

```js
// Tap your own avatar -> the profile page. #home-face had no handler at all before this.
homeFaceEl?.addEventListener('click', () => { unlockAudio(); openProfile(); });
homeFaceEl?.setAttribute('role', 'button');
homeFaceEl?.setAttribute('aria-label', 'הפרופיל שלי');
```

4. `openProfile()`: show the screen immediately with a client-only model (so it never blanks), then fetch and re-render:

```js
async function openProfile() {
  showScreen('profile');
  const base = () => ({
    xpState: currentXpState(), rank: window.SALTIZ_RANK || null,
    cards: myCards(), cosmetic: MY_COSMETIC || DEFAULT_COSMETIC,
    unlockedHeroes: unlockedHeroCount(), loadout: rankForLoadout(myCards()).slice(0, 3),
    heroPlays: readHeroPlays((k) => localStorage.getItem(k)),
    bestBotLevel: readBestBotLevel((k) => localStorage.getItem(k)),
    arenaCount: profileArenaCount(), friendCount: FRIENDS.length,
  });
  renderProfile(document.getElementById('profile'), buildProfileModel(base()));
  const stats = await fetchOwnStats();
  if (stats) renderProfile(document.getElementById('profile'), buildProfileModel({ ...base(), stats }));
}
// Arenas built = the saved-field library. Same key the builder writes (FP_SAVES_KEY).
function profileArenaCount() {
  try { const a = JSON.parse(localStorage.getItem('pikme-fields') || '[]'); return Array.isArray(a) ? a.length : 0; }
  catch { return 0; }
}
```

5. `fetchOwnStats()` — the full career doc. It must follow the SAME routing rule as `fetchOwnProgress`, or it will be silently CORS-blocked on the LAN surface:

```js
// The career block. On a dev/LAN host this MUST go through the game server's /dev/progress
// passthrough — pikme-server's CORS allowlist excludes localhost and private IPs, so a direct
// call is discarded by the browser no matter what the API answers. In the app, /handle-friends/rank
// is the only token-authed route that can resolve us server-side (see Task 5).
async function fetchOwnStats() {
  const phone = (() => { try { return _params.get('phone'); } catch { return null; } })();
  if (DEV_HOST) return phone ? await apiGet(`/dev/progress?phone=${encodeURIComponent(phone)}`, true)
                            : await apiGet('/dev/progress', true);
  if (FOOTBALL_TOKEN) return await apiGet('/handle-friends/rank');
  return phone ? await apiGet(`/handle-user/football/stats?phone=${encodeURIComponent(phone)}`) : null;
}
```

- [ ] **Step 3: Verify in a real browser over CDP**

```bash
PORT=3915 node server.js &
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu \
  --hide-scrollbars --window-size=844,420 --remote-debugging-port=9315 --user-data-dir=<scratch> about:blank &
```
Drive it (pattern: the `cdp-bot-friends.mjs` script in the session scratchpad): click `#home-face`, then assert
- the `#profile` screen is visible and `#home` is hidden,
- every `[data-section]` from `PROFILE_SECTIONS` exists,
- `document.documentElement.scrollWidth <= innerWidth` (no horizontal scroll),
- the `.pf-body` scrolls (`scrollHeight > clientHeight`) while the page body does not,
- the fixed pane's `getBoundingClientRect()` sits inside the viewport at 844×390 **and** 667×375,
- `Runtime.exceptionThrown` and console errors are silent,
- take a screenshot and LOOK at it.

- [ ] **Step 4: Full suite**

Run: `for f in test*.mjs; do node $f; done`
Expected: green except `test-bot-ladder.mjs` / `test-bot-partner.mjs` (known pre-existing).

- [ ] **Step 5: Commit and release the locks**

```bash
git status --short          # if client.js/index.html carry a foreign diff, commit ONLY your hunks
                            # (git diff -U0 | filter | git apply --cached --unidiff-zero), never -a
git add public/index.html public/client.js
git commit -m "feat(profile): open the profile page from the hub avatar"
```
Then `lock_release` both files.

---

### Task 5: `pikme-server` — let the token-authed route return the career block

**Files:**
- Modify: `pikme-server/routes-pikme/friends.js` — the `/rank` handler (~line 47-72)
- Test: `pikme-server/test-football-profile-rank.mjs`

**Interfaces:**
- Consumes: `footballPublicStats`-equivalent field list. `friends.js` already computes `phone` and already reads the stats doc for `rankPoints/rankTier/rankPeak` — extend that `.select()`.
- Produces: the same JSON as before **plus** `matchesPlayed, wins, losses, draws, winsVsHuman, winsVsBot, goalsFor, goalsAgainst, streak, bestStreak, careerGoals, assists, strips, saves, shotsFired, bombsPlanted, wallsBuilt, touches, possSeconds, distanceM`. Purely additive — every existing consumer keeps working.

- [ ] **Step 1: Write the failing test**

Extract the projection into an exported pure function so it is testable without Mongo — that extraction IS the task's design work. Create `pikme-server/test-football-profile-rank.mjs`:

```js
// /handle-friends/rank is the ONLY token-authed route that can resolve "me" server-side, so it is
// what the in-app profile page reads. This pins that the career block it now returns is complete and
// that the additive change did not disturb a single existing key (the app maps rankTier onto badge art).
const assert = require('assert')
const { rankPayload } = require('./routes-pikme/friends')

let pass = 0
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); pass++ }

const st = {
  rankPoints: 454, rankTier: 'silver', rankPeak: 460,
  matchesPlayed: 42, wins: 18, losses: 17, draws: 7, winsVsHuman: 15, winsVsBot: 3,
  goalsFor: 88, goalsAgainst: 60, streak: 2, bestStreak: 6,
  careerGoals: 31, assists: 12, strips: 40, saves: 9, shotsFired: 220,
  bombsPlanted: 55, wallsBuilt: 77, touches: 900, possSeconds: 605, distanceM: 4210,
}
const out = rankPayload({ rank: 3, xp: 3970, level: 9, tier: 'silver' }, st, 27)

// The keys that existed BEFORE this change must be byte-identical in meaning.
eq(out.rank, 3, 'rank preserved'); eq(out.totalPlayers, 27, 'totalPlayers preserved')
eq(out.xp, 3970, 'xp preserved'); eq(out.level, 9, 'level preserved'); eq(out.tier, 'silver', 'tier preserved')
eq(out.rankPoints, 454, 'rankPoints preserved'); eq(out.rankTier, 'silver', 'rankTier is still a tier NAME')
eq(out.rankPeak, 460, 'rankPeak preserved')

// The career block the profile page needs.
for (const k of ['matchesPlayed','wins','losses','draws','winsVsHuman','winsVsBot','goalsFor','goalsAgainst',
  'streak','bestStreak','careerGoals','assists','strips','saves','shotsFired','bombsPlanted','wallsBuilt',
  'touches','possSeconds','distanceM']) eq(out[k], st[k], `career field ${k} returned`)

// A player with no stats doc at all: every career field must be 0, never undefined — the page prints them.
const none = rankPayload({ rank: 1, xp: 0, level: 1, tier: 'bronze' }, null, 1)
for (const k of ['matchesPlayed','wins','careerGoals','possSeconds','distanceM'])
  eq(none[k], 0, `missing doc yields 0 for ${k}, not undefined`)

console.log(`✅ test-football-profile-rank: ${pass} assertions passed`)
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd pikme-server && node test-football-profile-rank.mjs`
Expected: FAIL — `rankPayload is not exported`.

- [ ] **Step 3: Implement**

Extract `rankPayload()` in `routes-pikme/friends.js`, widen the `.select(...)` to include the career fields, and return them. Keep `rankTier` a tier NAME (never the string `'unranked'`) — the app maps it onto badge art and a surprise value paints nothing.

- [ ] **Step 4: Verify**

Run: `node test-football-profile-rank.mjs` → PASS. Then the football tests that touch this route: `node test-football-rank.mjs && node test-friends.js` (the latter needs Node 20: `npx node@20.11.1 test-friends.js`, because jsonwebtoken breaks on Node 26).

- [ ] **Step 5: Commit — and do NOT push**

```bash
git -C ../pikme-server add routes-pikme/friends.js test-football-profile-rank.mjs
git -C ../pikme-server commit -m "feat(football): /handle-friends/rank returns the career block for the profile page"
```
⚠️ `pikme-server`'s Render service has autoDeploy on — **pushing this IS a production deploy.** Leave it local and tell the user it is waiting.

---

## Final steps

- [ ] Log the request + what changed + how it was verified in `AGENT_REQUEST_LOG.md` under a `## 2026-07-27` heading, naming the files taken and any foreign diffs left alone.
- [ ] Report to the user: what is verified on the dev surface, what needs the pikme-server deploy, and the fact that the two new counters start empty by design.
