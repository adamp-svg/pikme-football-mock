# Skill-Based Matchmaking + Search Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single forming-room-per-mode with a trophy-banded ticket queue and a search screen that shows the player what is actually being searched for.

**Architecture:** Pressing play creates a *ticket*, not a room. A pure `planMatches(tickets, now, opts)` in `shared/matchmaker.js` runs on the existing server tick, groups tickets by level band, widens each ticket's accepted band on its own clock, and returns groups + per-ticket waiting status. `server.js` performs every side effect (create room, move members in, start reveal). Because the matcher is pure and takes `now` as a parameter, all policy is tested with no sockets and no timers.

**Tech Stack:** Node ESM (no build step, no TypeScript), `ws` for sockets, vanilla DOM client, `test-*.mjs` scripts run by `for f in test*.mjs; do node $f; done`. Hebrew RTL UI.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-27-matchmaking-countdown-design.md`. Read it before Task 1.
- **Repo rules:** `CLAUDE.md`. Several agents share this working tree. Run `git status` / `git diff` before every commit and **stage only your own files by path** — never `git add -A`. Log the work in `AGENT_REQUEST_LOG.md`.
- **Never push or deploy.** Commit locally only. The user pushes explicitly.
- **No `timeout(1)`** — not present on macOS. Long-running checks use the watchdog pattern in Task 9.
- **Band unit:** `playerLevelFromXp(trophies)` from `shared/difficulty.js`, values `1…∞`, displayed as רמה.
- **Bot difficulty is a DIFFERENT ladder:** `botLevelFromXp(trophies)` → `0…11`, clamped. Never assign one to the other without converting.
- **Live formats only:** `quick` (teamSize 2), `brawl` (teamSize 2), `3v3` (teamSize 3). No 5v5 — it does not fit the 8-slot snapshot mask.
- **Budgets (per ticket, not per format):** `quickMatch` → 5000 ms. `matchmade` / `goalBrawl` → 10000 ms.
- **Short-circuit:** 2000 ms, re-evaluated every tick, never latched.
- **Grace:** 5000 ms, granted at most once per ticket, only when `1 + nearbyCount >= roomMax`.
- **Reveal hold:** 1500 ms after a group resolves, on every path.
- **Widening:** `0–40%` of budget → exact level; `40–100%` → ±1; grace → ±2. L12+ is one band. An L1 ticket accepts L1–L2 only and is never pulled up to L3.
- **Screen state is chosen by human count** (`memberIds.length >= 2` → FOUND, else NO PLAYERS), never by `reason`.
- **Do not touch `showVsMode`.** The run-together mode label is an artefact of reading a parent's `textContent` across two block spans; it renders correctly.
- **Hebrew copy, exact strings:**
  - `מחפש יריבים...`
  - `${n} שחקנים מחפשים כרגע`
  - `נמצאו יריבים!`
  - `אין שחקנים פנויים כרגע`
  - `רמה ${lo}` when `lo === hi`, else `רמה ${lo}–${hi}`

---

### Task 1: Band maths and the widening schedule

Pure, no queue logic yet. Establishes the primitives every later task consumes.

**Files:**
- Create: `shared/matchmaker.js`
- Create: `test-matchmaker.mjs`
- Modify: `shared/constants.js` (append a matchmaking block near `MAX_PLAYERS`, line ~324)

**Interfaces:**
- Consumes: `playerLevelFromXp` from `shared/difficulty.js`.
- Produces:
  - `bandOf(trophies) -> number` — level `1…12`, everything `>= 12` collapsed to `12`.
  - `acceptedBand(level, widen) -> { lo, hi }` — `widen` is `0 | 1 | 2`.
  - `mutuallyCompatible(a, b) -> boolean` where `a`/`b` are `{ level, widen }`.
  - `widenFor(elapsedMs, budgetMs, graceActive) -> 0 | 1 | 2`
  - Constants from `shared/constants.js`: `MM_BUDGET_QUICK_MS`, `MM_BUDGET_MODE_MS`, `MM_ALONE_MS`, `MM_GRACE_MS`, `MM_REVEAL_MS`, `MM_BAND_TOP`.

- [ ] **Step 1: Add the constants**

Append to `shared/constants.js`:

```js
// --- MATCHMAKING (see docs/superpowers/specs/2026-07-27-matchmaking-countdown-design.md) ------
// Budgets live on the TICKET, not the format: the yellow משחק מהיר button and the 2v2 picker card
// resolve to the SAME format ('quick', teamSize 2), so the 5s/10s split can only be expressed per
// entry point. A 5s and a 10s ticket share one pool and can match each other; each gives up on its
// own clock.
export const MM_BUDGET_QUICK_MS = 5000;  // משחק מהיר button
export const MM_BUDGET_MODE_MS = 10000;  // a mode card from the picker (2v2 / brawl / 3v3)
// Empty pool -> resolve fast and say so, instead of running a search that cannot succeed. Thin
// population is this game's NORMAL case, so the short countdown is the common path.
// RE-EVALUATED EVERY TICK, NEVER LATCHED: two players pressing play 1.5s apart would otherwise both
// short-circuit into separate bot matches while each was the other's match.
export const MM_ALONE_MS = 2000;
// Extra wait granted ONCE when the room is theoretically completable (1 + nearby >= roomMax).
export const MM_GRACE_MS = 5000;
// Fixed reveal hold after a group resolves, on EVERY path — a room that fills at t=3s still gets a
// VS beat instead of jumping straight into play.
export const MM_REVEAL_MS = 1500;
// playerLevelFromXp is unbounded (30000 xp = L25), so without a ceiling the highest-XP player can
// never match anyone. Brawl Stars' single-pool-above-a-threshold rule, applied to our ladder.
export const MM_BAND_TOP = 12;
```

- [ ] **Step 2: Write the failing test**

Create `test-matchmaker.mjs`:

```js
// MATCHMAKING POLICY — pure, no sockets, no timers.
//
// `now` is a PARAMETER, so this drives time by passing timestamps. The suite already has one test
// that hangs (test-bot-ladder.mjs); do not add a second by sleeping.
import { bandOf, acceptedBand, mutuallyCompatible, widenFor } from './shared/matchmaker.js';
import { MM_BUDGET_QUICK_MS, MM_BAND_TOP } from './shared/constants.js';

let failed = 0;
const ok = (l, c, x = '') => { if (!c) failed++; console.log(`  ${c ? '✅' : '❌'} ${l}${x ? ` — ${x}` : ''}`); };

console.log('bands');
ok('0 trophies -> L1', bandOf(0) === 1, String(bandOf(0)));
ok('340 trophies -> L3', bandOf(340) === 3, String(bandOf(340)));
ok('1000 trophies -> L5', bandOf(1000) === 5, String(bandOf(1000)));
// playerLevelFromXp(30000) is 25; without the ceiling the top player matches nobody.
ok('30000 trophies collapses to the top band', bandOf(30000) === MM_BAND_TOP, String(bandOf(30000)));
ok('12000 trophies also collapses to the top band', bandOf(12000) === MM_BAND_TOP, String(bandOf(12000)));
ok('garbage is treated as the floor, not NaN', bandOf(undefined) === 1 && bandOf(-5) === 1);

console.log('\naccepted band');
ok('widen 0 is exact', JSON.stringify(acceptedBand(5, 0)) === '{"lo":5,"hi":5}');
ok('widen 1 is +/-1', JSON.stringify(acceptedBand(5, 1)) === '{"lo":4,"hi":6}');
ok('widen 2 is +/-2', JSON.stringify(acceptedBand(5, 2)) === '{"lo":3,"hi":7}');
// The floor is ASYMMETRIC: at the bottom of the ladder a one-level gap is a far bigger skill gap.
ok('L1 widened by 1 accepts L1-L2 only, never below', JSON.stringify(acceptedBand(1, 1)) === '{"lo":1,"hi":2}');
ok('L1 widened by 2 still stops at L2', JSON.stringify(acceptedBand(1, 2)) === '{"lo":1,"hi":2}');
ok('L2 widened by 2 stops at L1 below and L4 above', JSON.stringify(acceptedBand(2, 2)) === '{"lo":1,"hi":4}');
ok('the top band does not widen past itself', acceptedBand(MM_BAND_TOP, 2).hi === MM_BAND_TOP);

console.log('\nmutual compatibility');
ok('same level always matches', mutuallyCompatible({ level: 5, widen: 0 }, { level: 5, widen: 0 }));
ok('a widened L3 does NOT capture an unwidened L1',
  !mutuallyCompatible({ level: 3, widen: 2 }, { level: 1, widen: 0 }));
ok('...and still does not once L1 has widened, because L1 caps at L2',
  !mutuallyCompatible({ level: 3, widen: 2 }, { level: 1, widen: 2 }));
ok('L4 and L5 match only when at least one has widened',
  !mutuallyCompatible({ level: 4, widen: 0 }, { level: 5, widen: 0 })
  && mutuallyCompatible({ level: 4, widen: 1 }, { level: 5, widen: 1 }));
ok('compatibility is symmetric',
  mutuallyCompatible({ level: 4, widen: 1 }, { level: 5, widen: 1 })
  === mutuallyCompatible({ level: 5, widen: 1 }, { level: 4, widen: 1 }));

console.log('\nwiden schedule');
const B = MM_BUDGET_QUICK_MS; // 5000
ok('t=0 is exact', widenFor(0, B, false) === 0);
ok('t=39% is still exact', widenFor(B * 0.39, B, false) === 0);
ok('t=40% widens to +/-1', widenFor(B * 0.40, B, false) === 1);
ok('t=99% is still +/-1', widenFor(B * 0.99, B, false) === 1);
ok('grace widens to +/-2', widenFor(B * 1.2, B, true) === 2);
ok('past budget WITHOUT grace stays at +/-1 (it is about to resolve)', widenFor(B * 1.2, B, false) === 1);

console.log(failed ? `\n❌ ${failed} failed` : '\n✅ all passed');
process.exit(failed ? 1 : 0);
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `node test-matchmaker.mjs`
Expected: FAIL — `Cannot find module '.../shared/matchmaker.js'`

- [ ] **Step 4: Write the implementation**

Create `shared/matchmaker.js`:

```js
// MATCHMAKING POLICY — pure. No sockets, no rooms, no Date.now().
//
// Lives in shared/ and takes `now` as a parameter for one reason: the policy is the part that is
// worth testing, and testing it through a socket server means timers, flakes and (per
// boot-test-server.mjs) false greens from stale processes. server.js owns every side effect.
//
// The band unit is playerLevelFromXp — already shared with the client, and already what the hub bar
// prints as רמה. The game's גביעים number IS its XP number, so "match by trophies" needs no new
// metric.
import { playerLevelFromXp } from './difficulty.js';
import { MM_BAND_TOP } from './constants.js';

/** Trophies -> matchmaking band (1..MM_BAND_TOP). Everything at or above the top collapses. */
export function bandOf(trophies) {
  const lv = playerLevelFromXp(Math.max(0, Number(trophies) || 0));
  return Math.min(MM_BAND_TOP, Math.max(1, lv));
}

/**
 * Which bands a ticket at `level` will accept once widened by `widen` (0|1|2).
 * The FLOOR IS ASYMMETRIC: a level-1 player never accepts anything above L2, however long they wait.
 * At the bottom of the ladder one level is a much larger skill gap than at the top, and a beginner
 * fed to an L3 has a worse time than a beginner who waited.
 */
export function acceptedBand(level, widen) {
  const L = Math.min(MM_BAND_TOP, Math.max(1, level | 0));
  const w = Math.min(2, Math.max(0, widen | 0));
  const lo = Math.max(1, L - w);
  const hi = Math.min(MM_BAND_TOP, L === 1 ? Math.min(2, L + w) : L + w);
  return { lo, hi };
}

/**
 * Both tickets must accept each other. One-sided compatibility is how an L1 who accepts only L1-L2
 * gets dragged into an L3's widened net.
 */
export function mutuallyCompatible(a, b) {
  const A = acceptedBand(a.level, a.widen), B = acceptedBand(b.level, b.widen);
  return b.level >= A.lo && b.level <= A.hi && a.level >= B.lo && a.level <= B.hi;
}

/**
 * How wide a ticket searches, given how long it has waited.
 *   0-40% of its budget -> exact level      ("similarly leveled first")
 *   40-100%             -> +/-1             ("one up one below")
 *   in grace            -> +/-2             ("wait another 5 seconds")
 * Past the budget WITHOUT grace it stays at +/-1: it is resolving this tick, so widening would only
 * pull in a mismatch on the way out the door.
 */
export function widenFor(elapsedMs, budgetMs, graceActive) {
  if (graceActive) return 2;
  const frac = budgetMs > 0 ? elapsedMs / budgetMs : 1;
  return frac < 0.4 ? 0 : 1;
}
```

- [ ] **Step 5: Run the test**

Run: `node test-matchmaker.mjs`
Expected: PASS, `✅ all passed`

- [ ] **Step 6: Commit**

```bash
git add shared/matchmaker.js shared/constants.js test-matchmaker.mjs
git commit -m "feat(matchmaking): trophy bands and the widening schedule

Pure band maths, no queue yet. bandOf collapses L12+ into one pool so the
highest-XP player can match anyone; acceptedBand keeps the FLOOR asymmetric so an
L1 is never pulled up to L3 by someone else's widened net; mutuallyCompatible
requires both sides to accept, which is the only thing that makes that floor
hold.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `planMatches` — grouping, fairness, deadlines

**Files:**
- Modify: `shared/matchmaker.js` (append)
- Modify: `test-matchmaker.mjs` (append)

**Interfaces:**
- Consumes: `bandOf`, `acceptedBand`, `mutuallyCompatible`, `widenFor` from Task 1.
- Produces:

```js
planMatches(tickets, now, opts) -> {
  groups:  [{ mode, memberIds, reason, level, bandLo, bandHi }],
  waiting: [{ memberId, phase, bandLo, bandHi, searchingCount, remainingMs }]
}
```
  - `tickets`: iterable of `{ memberId, mode, level, trophies, queuedAt, budgetMs, graceUntil }`.
  - `opts`: `{ roomMaxFor: (mode) => number }`.
  - `reason`: `'full' | 'grace' | 'deadline' | 'alone'`.
  - `phase`: `'searching' | 'widened' | 'grace'`.
  - `graceUntil`: `number | null` — set by the CALLER when `planMatches` reports a grace grant, so the pure function stays free of hidden state. `planMatches` never mutates its input.
  - Also produces `grants: [{ memberId, graceUntil }]` so the caller knows which tickets to stamp.

- [ ] **Step 1: Write the failing test**

Append to `test-matchmaker.mjs`, before the final summary lines:

```js
console.log('\nplanMatches');
const OPTS = { roomMaxFor: (m) => (m === '3v3' ? 6 : 4) };
// Build a ticket. queuedAt is explicit so every case controls its own clock.
const T = (memberId, level, queuedAt, budgetMs = MM_BUDGET_QUICK_MS, mode = 'quick', graceUntil = null) =>
  ({ memberId, mode, level, trophies: 0, queuedAt, budgetMs, graceUntil });

{ // 4 same-band players -> one full group, immediately, without waiting out any budget
  const r = planMatches([T('a', 5, 0), T('b', 5, 0), T('c', 5, 0), T('d', 5, 0)], 100, OPTS);
  ok('4 compatible tickets form one group at t=100ms', r.groups.length === 1, JSON.stringify(r.groups.map((g) => g.memberIds)));
  ok('...with reason "full"', r.groups[0]?.reason === 'full', r.groups[0]?.reason);
  ok('...and nobody left waiting', r.waiting.length === 0, String(r.waiting.length));
}
{ // 3 of 4 -> nothing yet, all three reported as searching
  const r = planMatches([T('a', 5, 0), T('b', 5, 0), T('c', 5, 0)], 100, OPTS);
  ok('3 of 4 does NOT start early', r.groups.length === 0);
  ok('all three are waiting', r.waiting.length === 3);
  ok('each sees the other two searching', r.waiting.every((w) => w.searchingCount === 3), JSON.stringify(r.waiting.map((w) => w.searchingCount)));
  ok('phase is "searching" at t=100ms', r.waiting.every((w) => w.phase === 'searching'));
}
{ // 3v3 needs 6, not 4
  const six = ['a','b','c','d','e','f'].map((id) => T(id, 5, 0, MM_BUDGET_MODE_MS, '3v3'));
  ok('5 tickets do not fill a 3v3', planMatches(six.slice(0, 5), 100, OPTS).groups.length === 0);
  ok('6 tickets do', planMatches(six, 100, OPTS).groups.length === 1);
}
{ // modes never mix
  const r = planMatches([T('a', 5, 0), T('b', 5, 0), T('c', 5, 0, MM_BUDGET_MODE_MS, '3v3'), T('d', 5, 0, MM_BUDGET_MODE_MS, '3v3')], 100, OPTS);
  ok('a quick ticket is never grouped with a 3v3 ticket', r.groups.length === 0 && r.waiting.length === 4);
}
{ // FAIRNESS: the oldest ticket seeds. 'old' has waited 4s; two fresh L5s arrive.
  // Seeding by newest would let the pair form and leave 'old' still waiting.
  const r = planMatches([T('fresh1', 5, 3900), T('old', 5, 0), T('fresh2', 5, 3900), T('fresh3', 5, 3900)], 4000, OPTS);
  ok('the longest-waiting ticket is in the group', r.groups[0]?.memberIds.includes('old'), JSON.stringify(r.groups[0]?.memberIds));
}
{ // MUTUAL compatibility through the real planner, not just the predicate
  // L1 (widened, caps at L2) + three L3s at t=4s. The L3s have widened to +/-1 and would accept L2..L4.
  const r = planMatches([T('beginner', 1, 0), T('x', 3, 0), T('y', 3, 0), T('z', 3, 0)], 4000, OPTS);
  ok('an L1 is not absorbed into an L3 group', !(r.groups[0]?.memberIds || []).includes('beginner'), JSON.stringify(r.groups.map((g) => g.memberIds)));
}
{ // ALONE: one ticket, empty pool -> resolves at MM_ALONE_MS with reason 'alone'
  const solo = [T('a', 5, 0)];
  ok('a lone ticket does not resolve at t=1900ms', planMatches(solo, 1900, OPTS).groups.length === 0);
  const r = planMatches(solo, MM_ALONE_MS, OPTS);
  ok('...and does at t=MM_ALONE_MS', r.groups.length === 1, String(r.groups.length));
  ok('...with reason "alone"', r.groups[0]?.reason === 'alone', r.groups[0]?.reason);
  ok('...as a group of one human', r.groups[0]?.memberIds.length === 1);
}
{ // NOT LATCHED: alone at 1.5s, company at 1.8s -> both keep their FULL budget and get matched later.
  const two = [T('a', 5, 0), T('b', 5, 1800)];
  const r = planMatches(two, 1900, OPTS);
  ok('company before the 2s mark cancels the short-circuit', r.groups.length === 0, JSON.stringify(r.groups));
  ok('both are still searching', r.waiting.length === 2);
  // They are only 2 of 4, so they resolve on 'a's own budget, together, with bots for the rest.
  const r2 = planMatches(two, MM_BUDGET_QUICK_MS, OPTS);
  ok('at a\'s budget they resolve TOGETHER, not separately', r2.groups.length === 1 && r2.groups[0].memberIds.length === 2,
    JSON.stringify(r2.groups.map((g) => g.memberIds)));
  ok('...with reason "deadline", not "alone"', r2.groups[0]?.reason === 'deadline', r2.groups[0]?.reason);
}
{ // GRACE: granted only when the room is theoretically completable.
  // 2 humans, roomMax 4 -> 1 + 1 nearby = 2 < 4 -> NO grace, resolve at deadline.
  const r = planMatches([T('a', 5, 0), T('b', 5, 0)], MM_BUDGET_QUICK_MS, OPTS);
  ok('2 of 4 gets no grace — the room cannot be completed', (r.grants || []).length === 0 && r.groups.length === 1);
  // 4 humans but incompatible bands at deadline: a is L5, three are L8. 1 + 3 = 4 >= roomMax -> grace.
  const r2 = planMatches([T('a', 5, 0), T('p', 8, 0), T('q', 8, 0), T('r', 8, 0)], MM_BUDGET_QUICK_MS, OPTS);
  ok('a completable-but-mismatched pool grants grace', (r2.grants || []).length > 0, JSON.stringify(r2.grants));
}
{ // Grace is granted at most once: a ticket carrying an EXPIRED graceUntil resolves, never re-grants.
  const expired = [{ memberId: 'a', mode: 'quick', level: 5, trophies: 0, queuedAt: 0, budgetMs: MM_BUDGET_QUICK_MS, graceUntil: MM_BUDGET_QUICK_MS + MM_GRACE_MS }];
  const r = planMatches(expired, MM_BUDGET_QUICK_MS + MM_GRACE_MS, OPTS);
  ok('an expired grace resolves instead of extending again', r.groups.length === 1 && (r.grants || []).length === 0, JSON.stringify(r));
  ok('...with reason "grace"', r.groups[0]?.reason === 'grace', r.groups[0]?.reason);
}
{ // A ticket inside its grace reports phase 'grace' and a +/-2 band.
  const inGrace = [{ memberId: 'a', mode: 'quick', level: 5, trophies: 0, queuedAt: 0, budgetMs: MM_BUDGET_QUICK_MS, graceUntil: 9000 }];
  const w = planMatches(inGrace, 6000, OPTS).waiting[0];
  ok('phase is "grace" inside the grace window', w?.phase === 'grace', w?.phase);
  ok('...and the band is +/-2', w?.bandLo === 3 && w?.bandHi === 7, `${w?.bandLo}-${w?.bandHi}`);
}
{ // Band reported for display widens visibly at 40%.
  const w0 = planMatches([T('a', 5, 0), T('b', 9, 0)], 100, OPTS).waiting.find((x) => x.memberId === 'a');
  const w1 = planMatches([T('a', 5, 0), T('b', 9, 0)], MM_BUDGET_QUICK_MS * 0.5, OPTS).waiting.find((x) => x.memberId === 'a');
  ok('band starts exact', w0.bandLo === 5 && w0.bandHi === 5, `${w0.bandLo}-${w0.bandHi}`);
  ok('band widens to 4-6 at half budget', w1.bandLo === 4 && w1.bandHi === 6, `${w1.bandLo}-${w1.bandHi}`);
  ok('phase reports "widened" then', w1.phase === 'widened', w1.phase);
}
{ // remainingMs counts down and never goes negative.
  const w = planMatches([T('a', 5, 0), T('b', 9, 0)], 3000, OPTS).waiting.find((x) => x.memberId === 'a');
  ok('remainingMs is budget - elapsed', w.remainingMs === MM_BUDGET_QUICK_MS - 3000, String(w.remainingMs));
}
{ // The group's level is the MEDIAN, not the newest joiner's — the bug in joinMatchmade today.
  const r = planMatches([T('a', 4, 0), T('b', 5, 0), T('c', 6, 0), T('d', 5, 0)], MM_BUDGET_QUICK_MS, OPTS);
  ok('group level is the median of its humans', r.groups[0]?.level === 5, String(r.groups[0]?.level));
}
{ // planMatches must not mutate its input — the caller owns ticket state.
  const t = T('a', 5, 0);
  const before = JSON.stringify(t);
  planMatches([t], MM_ALONE_MS, OPTS);
  ok('input tickets are not mutated', JSON.stringify(t) === before);
}
```

Add these imports to the top of `test-matchmaker.mjs`:

```js
import { bandOf, acceptedBand, mutuallyCompatible, widenFor, planMatches } from './shared/matchmaker.js';
import { MM_BUDGET_QUICK_MS, MM_BUDGET_MODE_MS, MM_ALONE_MS, MM_GRACE_MS, MM_BAND_TOP } from './shared/constants.js';
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node test-matchmaker.mjs`
Expected: FAIL — `planMatches is not a function`

- [ ] **Step 3: Implement `planMatches`**

Append to `shared/matchmaker.js`:

```js
/** Median of a numeric array, rounded to an integer band. */
function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/**
 * Decide, for this instant, which waiting players become matches.
 *
 * PURE: no Date.now(), no mutation of `tickets`, no I/O. The caller stamps `graceUntil` from
 * `grants` and performs every side effect. That split is what lets the whole policy be tested
 * without a socket server — and per boot-test-server.mjs, socket tests in this repo have produced
 * false GREENS, so keeping policy out of them is not a stylistic preference.
 *
 * @param {Iterable} tickets  {memberId, mode, level, trophies, queuedAt, budgetMs, graceUntil}
 * @param {number} now        ms on the same clock as queuedAt
 * @param {{roomMaxFor:(mode:string)=>number}} opts
 */
export function planMatches(tickets, now, opts) {
  const all = [...tickets];
  const roomMaxFor = opts.roomMaxFor;
  const groups = [], waiting = [], grants = [];
  const taken = new Set();

  // Per mode: formats never mix. A first-to-3 player and a timed player are not playing the same
  // game, so pooling them would produce a match one of them did not choose.
  const byMode = new Map();
  for (const t of all) {
    if (!byMode.has(t.mode)) byMode.set(t.mode, []);
    byMode.get(t.mode).push(t);
  }

  for (const [mode, pool] of byMode) {
    const roomMax = Math.max(1, roomMaxFor(mode) | 0);
    // Cache each ticket's current search width once — it is read O(n) times below.
    const view = new Map();
    for (const t of pool) {
      const graceActive = !!t.graceUntil && now < t.graceUntil;
      const widen = widenFor(now - t.queuedAt, t.budgetMs, graceActive);
      view.set(t.memberId, { level: t.level, widen, graceActive });
    }

    // OLDEST FIRST. Seeding by newest lets a fresh arrival take the partner someone has been
    // waiting nine seconds for, and that player then waits again.
    const order = [...pool].sort((a, b) => a.queuedAt - b.queuedAt);

    for (const seed of order) {
      if (taken.has(seed.memberId)) continue;
      const sv = view.get(seed.memberId);
      const elapsed = now - seed.queuedAt;

      // Everyone still free who accepts the seed AND is accepted by it.
      const mates = order.filter((t) => t.memberId !== seed.memberId && !taken.has(t.memberId)
        && mutuallyCompatible(sv, view.get(t.memberId)));

      const emit = (members, reason) => {
        for (const m of members) taken.add(m.memberId);
        const levels = members.map((m) => m.level);
        const lo = Math.min(...levels), hi = Math.max(...levels);
        groups.push({ mode, memberIds: members.map((m) => m.memberId), reason, level: median(levels), bandLo: lo, bandHi: hi });
      };

      // 1. FULL — every slot human. Resolve now; do not wait out any budget. This is the user's
      //    "4 players for 2v2, no need to wait the full 10 seconds".
      if (1 + mates.length >= roomMax) { emit([seed, ...mates.slice(0, roomMax - 1)], 'full'); continue; }

      const graceUntil = seed.graceUntil || 0;
      const inGrace = graceUntil && now < graceUntil;
      const graceSpent = graceUntil > 0;

      // 2. ALONE — nobody compatible exists, so the search cannot succeed. Resolve fast and say so
      //    rather than running a countdown that is theatre. NOT LATCHED: this is recomputed every
      //    tick, so a ticket that gains company before MM_ALONE_MS keeps its full budget.
      if (!mates.length && !graceSpent && elapsed >= MM_ALONE_MS && elapsed < seed.budgetMs) {
        emit([seed], 'alone'); continue;
      }

      if (inGrace) { /* still extended — fall through to waiting */ }
      else if (elapsed >= seed.budgetMs) {
        // 3. GRACE — the pool is theoretically completable, so one extra window is worth it.
        //    Counted from same-mode tickets within +/-2 levels, NOT from onlineCount(): somebody
        //    idling in the shop must not cost a searching player five seconds.
        const nearby = pool.filter((t) => t.memberId !== seed.memberId && !taken.has(t.memberId)
          && Math.abs(t.level - seed.level) <= 2).length;
        if (!graceSpent && 1 + nearby >= roomMax) {
          grants.push({ memberId: seed.memberId, graceUntil: now + MM_GRACE_MS });
          continue; // reported as waiting below on the NEXT tick, once the caller has stamped it
        }
        // 4. DEADLINE — out of time. Take whoever is compatible; bots fill the rest.
        emit([seed, ...mates.slice(0, roomMax - 1)], graceSpent ? 'grace' : 'deadline');
        continue;
      }
    }

    // Anyone not grouped this tick is still searching. searchingCount is what the screen shows, and
    // it counts SEARCHERS in this mode — not onlineCount(), which includes people browsing the shop.
    const stillWaiting = pool.filter((t) => !taken.has(t.memberId));
    for (const t of stillWaiting) {
      const v = view.get(t.memberId);
      const band = acceptedBand(t.level, v.widen);
      const phase = v.graceActive ? 'grace' : v.widen > 0 ? 'widened' : 'searching';
      waiting.push({
        memberId: t.memberId, phase, bandLo: band.lo, bandHi: band.hi,
        searchingCount: stillWaiting.length,
        remainingMs: Math.max(0, (v.graceActive ? t.graceUntil - now : t.budgetMs - (now - t.queuedAt))),
      });
    }
  }
  return { groups, waiting, grants };
}
```

Add `MM_ALONE_MS, MM_GRACE_MS` to the `./constants.js` import at the top of `shared/matchmaker.js`:

```js
import { MM_BAND_TOP, MM_ALONE_MS, MM_GRACE_MS } from './constants.js';
```

- [ ] **Step 4: Run the test**

Run: `node test-matchmaker.mjs`
Expected: PASS. If the grace or fairness cases fail, fix the implementation — the assertions encode the spec and are not negotiable.

- [ ] **Step 5: Commit**

```bash
git add shared/matchmaker.js test-matchmaker.mjs
git commit -m "feat(matchmaking): planMatches — grouping, fairness and deadlines

Pure decision function: oldest ticket seeds (seeding by newest lets a fresh
arrival steal a long-waiting player's partner), compatibility is mutual so the
asymmetric floor actually holds, and a full group resolves immediately instead of
waiting out its budget.

Grace is granted from same-mode tickets within +/-2 levels rather than from
onlineCount(), so an idle player in the shop cannot cost a searcher five seconds,
and it is granted at most once via the caller-stamped graceUntil.

The group's level is the MEDIAN of its humans. joinMatchmade currently sets
room.diffLevel last-writer-wins, so today the newest arrival picks bot difficulty
for everyone already waiting.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The ticket queue on the server

Replaces `joinMatchmade`'s forming-room logic. After this task a match still starts, but through the queue — the client is untouched and still sees `roomJoined` + `lobby`, so nothing visibly regresses.

**Files:**
- Modify: `server.js` — `joinMatchmade` (~line 488), `tickAll` (~line 1070), the message handlers (~lines 1327–1330), and the disconnect path.

**Interfaces:**
- Consumes: `planMatches`, `bandOf` from Task 2; `MM_*` constants from Task 1.
- Produces:
  - `tickets: Map<memberId, ticket>` module-level.
  - `enqueue(member, mode, budgetMs, trophies) -> void`
  - `dequeue(memberId) -> void`
  - `runMatchmaker() -> void` — called once per tick from `tickAll`.
  - `formGroup(group) -> void` — creates the room, moves members, starts the reveal.

- [ ] **Step 1: Add the queue and the tick hook**

In `server.js`, after the `publicRooms` block (~line 155), add:

```js
// --- MATCHMAKING QUEUE -----------------------------------------------------------------------
// Waiting players hold a TICKET, not a room. The old model kept one forming room per mode and put
// whoever arrived into it, which is why trophies were never consulted: there was nowhere to consult
// them. It also made widening impossible — widening under that model means MERGING two half-full
// rooms that each hold members, a countdown and a botPlan, mid-tick.
//
// A ticket is the ONLY state a searching player has, so cancelling is a single delete.
const tickets = new Map(); // memberId -> { memberId, mode, level, trophies, queuedAt, budgetMs, graceUntil, member }

function enqueue(member, mode, budgetMs, trophies) {
  dequeue(member.id);                     // a member never holds two tickets
  leaveCurrentRoom(member);
  const t = Number.isFinite(+trophies) ? Math.max(0, +trophies) : null;
  member.trophies = t;
  tickets.set(member.id, {
    memberId: member.id, mode, budgetMs,
    trophies: t == null ? 0 : t,
    level: bandOf(t == null ? xpFallbackTrophies(member) : t),
    queuedAt: nowMs(), graceUntil: null, member,
  });
  send(member.ws, { type: 'searching', mode, phase: 'searching', bandLo: 0, bandHi: 0,
    searchingCount: 0, remainingMs: budgetMs, slots: { filled: 1, total: roomMaxForMode(mode) } });
}
function dequeue(memberId) { tickets.delete(memberId); }

// An OLDER CLIENT sends no trophies. Defaulting those to 0 would put a veteran on a stale build into
// L1 and feed them to beginners, so fall back to the diffLevel they already send (client-derived from
// the same XP), then to DEFAULT_LEVEL. Such a ticket is also never granted the grace extension.
function xpFallbackTrophies(member) {
  const lv = Number.isFinite(+member.diffLevel) ? clampLevel(+member.diffLevel) : DEFAULT_LEVEL;
  return xpForBotLevel(lv);
}
const roomMaxForMode = (mode) => ((FORMATS[mode] || FORMATS.quick).teamSize) * 2;
```

- [ ] **Step 2: Replace `joinMatchmade`**

Replace the whole body of `joinMatchmade` (server.js ~488–508) with:

```js
// Enter the matchmaking QUEUE. No room exists yet — planMatches decides when one should.
// `budgetMs` comes from the ENTRY POINT, not the format: the yellow משחק מהיר button and the 2v2
// picker card both resolve to format 'quick', so 5s-vs-10s can only be expressed per ticket.
function joinMatchmade(member, mode, diffLevel, trophies, budgetMs) {
  if (typeof diffLevel === 'number') member.diffLevel = clampLevel(diffLevel);
  enqueue(member, FORMATS[mode] ? mode : 'quick', budgetMs || MM_BUDGET_MODE_MS, trophies);
}
```

- [ ] **Step 3: Add `runMatchmaker` and `formGroup`**

Add after `joinMatchmade`:

```js
// One matcher pass. Called from tickAll, so it runs at TICK_RATE with the rest of the sim.
function runMatchmaker() {
  if (!tickets.size) return;
  const { groups, waiting, grants } = planMatches(tickets.values(), nowMs(), { roomMaxFor: roomMaxForMode });
  // Stamp the grants the pure function asked for. It never mutates its input, so this is the one
  // place graceUntil is written — which is also what makes "granted at most once" enforceable.
  for (const g of grants) {
    const t = tickets.get(g.memberId);
    // A ticket with unknown trophies never gets extended: we do not know its band well enough to
    // justify making it wait longer.
    if (t && t.member.trophies != null) t.graceUntil = g.graceUntil;
    else if (t) t.graceUntil = nowMs(); // mark spent so it resolves next tick instead of looping
  }
  for (const w of waiting) {
    const t = tickets.get(w.memberId);
    if (!t) continue;
    send(t.member.ws, { type: 'searching', mode: t.mode, phase: w.phase,
      bandLo: w.bandLo, bandHi: w.bandHi, searchingCount: w.searchingCount,
      remainingMs: Math.round(w.remainingMs), slots: { filled: 1, total: roomMaxForMode(t.mode) } });
  }
  for (const g of groups) formGroup(g);
}

// Turn a decided group into a real room. Every side effect lives here; planMatches has none.
function formGroup(group) {
  const fmt = FORMATS[group.mode] || FORMATS.quick;
  const room = makeRoom(`${fmt.prefix}-${++roomCounter}`, false);
  applyFormat(room, group.mode);
  rooms.set(room.id, room);
  // Bot difficulty from the group's MEDIAN human, computed ONCE. The old code set room.diffLevel from
  // whoever joined most recently, so in a shared public room the newest arrival picked the difficulty
  // for everyone already waiting.
  room.diffLevel = botLevelFromXp(xpForPlayerLevel(group.level));
  room.mmReason = group.reason;         // diagnostics + the client's screen hint
  room.mmBandLo = group.bandLo; room.mmBandHi = group.bandHi;
  // HUMANS ON OPPOSITE TEAMS: sorted by trophies and alternated, so the two closest-matched players
  // are the ones opposed and the human contest decides the match.
  const members = group.memberIds.map((id) => tickets.get(id)).filter(Boolean)
    .sort((a, b) => b.trophies - a.trophies).map((t) => t.member);
  members.forEach((m, i) => { m.team = i % 2 === 0 ? 'A' : 'B'; });
  for (const m of members) {
    dequeue(m.id);
    addToRoom(m, room);
    send(m.ws, { type: 'roomJoined', mode: group.mode, matchmade: true, code: null,
      mmReason: group.reason, humans: members.length });
  }
  // Fixed reveal on EVERY path, however the group formed. A full room used to call startMatch
  // directly — fast, but with no VS beat at all.
  room.phase = 'countdown';
  room.countdownT = MM_REVEAL_MS / 1000;
  broadcastLobby(room);
}
```

- [ ] **Step 4: Add the level→XP helper**

`botLevelFromXp` wants trophies, and the group carries a player LEVEL. Add next to `xpFallbackTrophies`:

```js
// Player level -> a representative trophy total for that level, matching the hub XP-bar curve
// (base = 50*p*(p-1), the same formula xpForBotLevel uses). Needed because a group carries a player
// LEVEL (1..12+) while botLevelFromXp wants trophies. The two ladders are off by one and clamp
// differently, so never assign across them without going through here.
const xpForPlayerLevel = (level) => 50 * Math.max(1, level | 0) * (Math.max(1, level | 0) - 1);
```

- [ ] **Step 5: Wire the tick and the message handlers**

In `tickAll` (~line 1070), add `runMatchmaker();` as the first statement of the function body.

Replace the three matchmaking handlers (~1327–1329) with:

```js
      if (msg.type === 'quickMatch') { joinMatchmade(member, 'quick', msg.diffLevel, msg.trophies, MM_BUDGET_QUICK_MS); return; }
      if (msg.type === 'goalBrawl') { joinMatchmade(member, 'brawl', msg.diffLevel, msg.trophies, MM_BUDGET_MODE_MS); return; }
      if (msg.type === 'matchmade') { joinMatchmade(member, FORMATS[msg.format] ? msg.format : 'quick', msg.diffLevel, msg.trophies, MM_BUDGET_MODE_MS); return; }
      if (msg.type === 'cancelSearch') { dequeue(member.id); send(member.ws, { type: 'toHome', online: onlineCount() }); return; }
```

- [ ] **Step 6: Drop the ticket on every exit path**

Add `dequeue(member.id);` to:
- the `close` handler, beside the existing `members.delete(ws)`
- `leaveCurrentRoom(member)`, as its first statement
- the `msg.type === 'leaveRoom'` handler

- [ ] **Step 7: Add the imports**

Extend the existing `shared/constants.js` import in `server.js` with:
`MM_BUDGET_QUICK_MS, MM_BUDGET_MODE_MS, MM_REVEAL_MS`

Add a new import:

```js
import { planMatches, bandOf } from './shared/matchmaker.js';
```

**`botLevelFromXp` is NOT currently imported in `server.js`** — verified, zero occurrences. Add it to
the existing `./shared/difficulty.js` import. `xpForBotLevel`, `clampLevel`, `DEFAULT_LEVEL` and
`displayLevelForBot` are already there.

- [ ] **Step 8: Syntax-check and boot**

```bash
node --check server.js
PORT=3051 node server.js & sleep 3; curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3051/; kill %1
```
Expected: `node --check` silent, `200`. `node --check` catches syntax only — a bad import throws at boot, which is why the curl matters.

- [ ] **Step 9: Confirm nothing else regressed**

```bash
for f in test-3v3.mjs test-mode-format.mjs test-vs-consistency.mjs test-party.mjs test-challenge.mjs test-ranked-mode.mjs; do printf '%-28s ' "$f"; node "$f" >/dev/null 2>&1 && echo PASS || echo FAIL; done
```
Expected: all PASS. These are the format / lobby / private-room tests most likely to notice the change. If one fails, read its output before changing it — a real regression is likelier than a stale assertion here.

- [ ] **Step 10: Commit**

```bash
git add server.js
git commit -m "feat(matchmaking): a ticket queue replaces the forming room

joinMatchmade used to keep ONE forming room per mode and drop whoever arrived
into it, so trophies had nowhere to be consulted. Waiting players now hold a
ticket and planMatches decides when a room should exist, which also means
widening never has to merge two half-full rooms mid-tick.

Three behaviour fixes ride along:
- room.diffLevel comes from the group's MEDIAN human, computed once, instead of
  last-writer-wins from the newest arrival
- humans are placed on OPPOSITE teams, sorted by trophies
- every resolution gets a fixed MM_REVEAL_MS beat; a full room used to jump
  straight into play with no VS screen

An older client that sends no trophies falls back to its diffLevel rather than to
0 — defaulting to L1 would feed veterans on stale builds into beginners' matches
— and such a ticket is never granted the grace extension.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Bot backfill at the matched level, with names

**Files:**
- Modify: `server.js` — `computeBotPlan` / `ensureBotPlan` (~line 1229–1270), `lobbyPayload` (~line 1015)
- Modify: `shared/saltiz-bots.js` — append a name pool + picker
- Create: `test-bot-names.mjs`

**Interfaces:**
- Consumes: `SALTIZ_BOTS`, `botLevelOf` from `shared/saltiz-bots.js`.
- Produces: `pickBotIdentities(count, botLevel, seed) -> [{ name, isSaltiz, level }]` from `shared/saltiz-bots.js`.

- [ ] **Step 1: Write the failing test**

Create `test-bot-names.mjs`:

```js
// BOT IDENTITIES for the VS screen. Bots stopped being "Bot" — they carry names, so the countdown
// reads like a lineup instead of a placeholder. Named saltiz bots are preferred when their level
// fits, because those already have cards, colours and a friend card the player may have seen.
import { pickBotIdentities, SALTIZ_BOTS } from './shared/saltiz-bots.js';

let failed = 0;
const ok = (l, c, x = '') => { if (!c) failed++; console.log(`  ${c ? '✅' : '❌'} ${l}${x ? ` — ${x}` : ''}`); };

console.log('count and shape');
for (const n of [1, 2, 3, 5]) {
  const got = pickBotIdentities(n, 4, 'room-1');
  ok(`${n} requested -> ${n} returned`, got.length === n, String(got.length));
  ok(`${n}: every one has a non-empty name`, got.every((b) => typeof b.name === 'string' && b.name.length > 0));
  ok(`${n}: names are unique`, new Set(got.map((b) => b.name)).size === n);
}

console.log('\nnamed saltiz bots are preferred when the level fits');
{
  // אורי is display level 5 -> botLevelOf 4. A room at botLevel 4 should reach for him first.
  const got = pickBotIdentities(1, 4, 'seed-a');
  ok('a level-4 room gets a saltiz bot', got[0].isSaltiz, JSON.stringify(got[0]));
  ok('...and it is the closest-level one (אורי)', got[0].name === 'אורי', got[0].name);
}
{
  // Nobody in the roster is near botLevel 0 (closest is אורי at 4), so fall back to generated names.
  const got = pickBotIdentities(2, 0, 'seed-b');
  ok('a level-0 room gets generated names, not a mis-levelled saltiz bot', got.every((b) => !b.isSaltiz), JSON.stringify(got.map((b) => b.name)));
  ok('...and no generated name collides with a saltiz name',
    got.every((b) => !SALTIZ_BOTS.some((s) => s.nickName === b.name)));
}

console.log('\nstability');
ok('the same seed gives the same identities',
  JSON.stringify(pickBotIdentities(3, 5, 'room-9')) === JSON.stringify(pickBotIdentities(3, 5, 'room-9')));
ok('a different seed gives a different set (usually)',
  JSON.stringify(pickBotIdentities(3, 5, 'room-9')) !== JSON.stringify(pickBotIdentities(3, 5, 'room-10')));

console.log('\nevery identity reports the room level, so the badge cannot disagree with the bot');
ok('level is the requested one', pickBotIdentities(3, 7, 's').every((b) => b.level === 7));

console.log(failed ? `\n❌ ${failed} failed` : '\n✅ all passed');
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node test-bot-names.mjs`
Expected: FAIL — `pickBotIdentities is not a function`

- [ ] **Step 3: Implement `pickBotIdentities`**

Append to `shared/saltiz-bots.js`:

```js
// Generated names for the slots the four named bots cannot cover. A 3v3 can need five bots at an
// arbitrary level, and reusing a named bot at the wrong level would contradict the friend card the
// player was shown.
const BOT_NAME_POOL = ['יואב', 'מאיה', 'איתי', 'רוני', 'גיא', 'תמר', 'עומר', 'ליאור', 'נועם', 'שירה', 'אלון', 'דנה'];

// Tiny string hash -> a stable per-room sequence. Seeded from the room id so the VS screen's preview
// and the bots that actually spawn are the same identities (the preview==match rule the countdown
// already relies on for cards).
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < String(str).length; i++) { h ^= String(str).charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/**
 * `count` bot identities for a room at difficulty `botLevel` (0..11), stable for `seed`.
 * A named saltiz bot is used when its own level is within 1 of the room's; otherwise a generated
 * name, so a level-0 room never fields שובל.
 */
export function pickBotIdentities(count, botLevel, seed) {
  const n = Math.max(0, count | 0);
  const out = [];
  const used = new Set();
  const fits = SALTIZ_BOTS
    .filter((b) => Math.abs(botLevelOf(b) - botLevel) <= 1)
    .sort((a, b) => Math.abs(botLevelOf(a) - botLevel) - Math.abs(botLevelOf(b) - botLevel));
  let h = hash(seed);
  const next = () => { h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0; return h; };
  for (let i = 0; i < n; i++) {
    const named = fits.find((b) => !used.has(b.nickName));
    if (named) { used.add(named.nickName); out.push({ name: named.nickName, isSaltiz: true, level: botLevel, botId: named.id }); continue; }
    let name = null;
    for (let tries = 0; tries < BOT_NAME_POOL.length && !name; tries++) {
      const cand = BOT_NAME_POOL[next() % BOT_NAME_POOL.length];
      if (!used.has(cand)) name = cand;
    }
    if (!name) name = `${BOT_NAME_POOL[0]} ${i + 1}`; // pool exhausted (needs >12 bots) — still unique
    used.add(name);
    out.push({ name, isSaltiz: false, level: botLevel, botId: null });
  }
  return out;
}
```

- [ ] **Step 4: Run the test**

Run: `node test-bot-names.mjs`
Expected: PASS

- [ ] **Step 5: Use the identities in the lobby preview**

In `server.js`'s `lobbyPayload`, replace the preview-bot mapping (~line 1019–1021):

```js
  const bots = (showBots && Array.isArray(room.botPlan))
    ? (() => {
        const ids = pickBotIdentities(room.botPlan.length, room.diffLevel, room.id);
        return room.botPlan.map((b, i) => ({
          id: `botprev-${room.id}-${i}`, name: ids[i].name, avatar: null, team: b.team, isBot: true,
          cards: b.cards, loadout: b.loadout,
          level: displayLevelForBot(room.diffLevel), xp: xpForBotLevel(room.diffLevel),
        }));
      })()
    : [];
```

Add `pickBotIdentities` to the `shared/saltiz-bots.js` import in `server.js`.

- [ ] **Step 6: Verify the preview names arrive**

```bash
node --check server.js && node test-vs-consistency.mjs 2>&1 | tail -5
```
Expected: `node --check` silent; `test-vs-consistency.mjs` passes. If it asserts on the literal name `Bot`, that assertion is now stale — rewrite it to assert a non-empty name plus `isBot: true`, and say so in the commit.

- [ ] **Step 7: Commit**

```bash
git add shared/saltiz-bots.js server.js test-bot-names.mjs
git commit -m "feat(matchmaking): bots get names matched to the room's level

The VS screen said 'Bot · רמה 5' four times over, which reads as a placeholder
rather than a lineup. Bots now carry names: a named saltiz bot when its own level
is within 1 of the room's (it already has cards, a colour and a friend card the
player may have seen), otherwise a generated Hebrew name — so a level-0 room
never fields שובל at level 11.

Identities are seeded from the room id, so the countdown preview and the bots
that actually spawn are the same, matching the preview==match rule the card
previews already depend on.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: The searching state on the client

**Files:**
- Modify: `public/index.html` — add search chrome inside `#team-intro` (~line 627–638)
- Modify: `public/client.js` — handle `searching`, send `trophies`, 2v2 card → `matchmade`
- Modify: `public/style.css` — search chrome styles

**Interfaces:**
- Consumes: the `searching` message from Task 3 (`{ type, mode, phase, bandLo, bandHi, searchingCount, remainingMs, slots }`); existing client helpers **`effectiveLoadout()`**, `myCards()`, `xpDiffLevel()`, `memberInitials()`, `fillIntroCol()`, `setTiCount()`, `myMemberId`.
- Produces: `showSearching(msg)`, `hideSearching()`, `renderSearchChrome(msg)`, `myTrophies()`, and module-level `myDisplayName` / `myAvatarUrl` in `client.js`.

> **Verified symbol names** — these were checked against the file, because three plausible-sounding
> alternatives do **not** exist: there is no `myName()`, no `myAvatar()` and no `equippedLoadout()`.
> The real ones are `myDisplayName`/`myAvatarUrl` (added in Step 3a) and `effectiveLoadout()`.

- [ ] **Step 1: Add the markup**

In `public/index.html`, inside `#team-intro`, immediately after the `#ti-count` div:

```html
    <!-- SEARCH CHROME. Shown while a ticket is live (no room exists yet), hidden once the group
         resolves. The band chip is load-bearing: an unexplained countdown reads as lag, whereas
         "רמה 5" widening to "רמה 4–6" reads as the server working. -->
    <div id="ti-search" class="ti-search hidden">
      <div class="ti-search-head">
        <span id="ti-search-title" class="ti-search-title">מחפש יריבים...</span>
        <span id="ti-search-pips" class="ti-search-pips"></span>
        <span id="ti-search-band" class="ti-search-band"></span>
      </div>
      <div id="ti-search-sub" class="ti-search-sub"></div>
    </div>
```

- [ ] **Step 2: Add the styles**

Append to `public/style.css`:

```css
/* MATCHMAKING SEARCH chrome (see docs/superpowers/specs/2026-07-27-matchmaking-countdown-design.md) */
.ti-search { position: absolute; top: 6px; left: 0; right: 0; display: grid; gap: 2px; justify-items: center; pointer-events: none; z-index: 4; }
.ti-search-head { display: flex; align-items: center; gap: 8px; }
.ti-search-title { font-size: 13px; font-weight: 800; color: #ffe9a8; }
.ti-search-sub { font-size: 11px; font-weight: 700; opacity: .75; }
.ti-search-band { font-size: 11px; font-weight: 800; padding: 1px 6px; border-radius: 8px; background: rgba(255, 255, 255, .12); }
.ti-search-pips { display: inline-flex; gap: 3px; }
.ti-search-pips i { width: 7px; height: 7px; border-radius: 50%; background: rgba(255, 255, 255, .22); }
.ti-search-pips i.on { background: #7fd48f; }
/* An opponent slot with nobody in it yet: dashed, so an empty slot reads as "still looking" rather
   than as a broken row. Preview bots used to occupy these from the first tick. */
.ti-row.ti-empty .ti-av { border: 1px dashed rgba(255, 255, 255, .3); background: transparent; }
.ti-row.ti-empty .ti-name { opacity: .5; }
```

- [ ] **Step 3a: Capture my own name and avatar at connect time**

`name` and `avatar` are **parameters of `connect(name, avatar)`** (~line 3739) and are not reachable
from the VS screen. During a search there is no `lobby` payload to read them from either, so capture
them once. Add beside `let myMemberId = null;` (~line 841):

```js
// My display identity, captured at connect. `connect(name, avatar)` takes these as parameters, and
// during a SEARCH there is no lobby payload echoing my member back, so the search screen has no other
// source for my own row.
let myDisplayName = 'שחקן', myAvatarUrl = null;
```

Add as the first two statements inside `connect(name, avatar)`:

```js
  myDisplayName = name || 'שחקן';
  myAvatarUrl = avatar || null;
```

- [ ] **Step 3b: Handle the message**

In `client.js`'s message switch, beside the `msg.type === 'lobby'` branch, add:

```js
    } else if (msg.type === 'searching') {
      showSearching(msg);
```

And add the functions near `updateVsCountdown`:

```js
// SEARCHING — a ticket is live and no room exists yet, so there is no `lobby` payload to ride on.
// My own row is rendered from local state; opponent rows are deliberately EMPTY. Preview bots used to
// fill them from the first tick, which made the wait look like a decided lineup.
let searchingLive = false;
function showSearching(msg) {
  if (!teamIntroEl) return;
  searchingLive = true;
  quickVs = true;
  const perTeam = Math.max(1, ((msg.slots && msg.slots.total) || 4) / 2);
  // No `loadout` needed: introCardsFor() already special-cases p.id === myMemberId and reads
  // effectiveLoadout() directly, so my row shows my LIVE slots rather than a snapshot.
  const mine = { id: myMemberId, name: myDisplayName, team: 'A', avatar: myAvatarUrl, cards: myCards() };
  const cols = teamIntroEl.querySelectorAll('.ti-col');
  fillIntroCol(cols[0], [mine], 'A', perTeam);
  fillIntroCol(cols[1], [], 'B', perTeam);
  renderSearchChrome(msg);
  setTiCount(Math.max(0, Math.ceil((msg.remainingMs || 0) / 1000)) || null);
  teamIntroEl.classList.remove('hidden');
  requestAnimationFrame(() => teamIntroEl.classList.add('show'));
  startLobbyMusic();
}
function renderSearchChrome(msg) {
  const box = document.getElementById('ti-search');
  if (!box) return;
  box.classList.remove('hidden');
  const total = (msg.slots && msg.slots.total) || 4;
  const filled = (msg.slots && msg.slots.filled) || 1;
  const pips = document.getElementById('ti-search-pips');
  pips.innerHTML = '';
  for (let i = 0; i < total; i++) { const d = document.createElement('i'); if (i < filled) d.className = 'on'; pips.appendChild(d); }
  const band = document.getElementById('ti-search-band');
  band.textContent = msg.bandLo && msg.bandHi
    ? (msg.bandLo === msg.bandHi ? `רמה ${msg.bandLo}` : `רמה ${msg.bandLo}–${msg.bandHi}`) : '';
  const n = +msg.searchingCount || 0;
  document.getElementById('ti-search-sub').textContent = n > 1 ? `${n} שחקנים מחפשים כרגע` : '';
  document.getElementById('ti-search-title').textContent = 'מחפש יריבים...';
}
function hideSearching() {
  searchingLive = false;
  document.getElementById('ti-search')?.classList.add('hidden');
}
```

- [ ] **Step 4: Mark empty opponent rows**

In `fillIntroCol` (~line 4126), inside the `for` loop, add an `else` for the no-player case. Find the `if (p) {` block and add after its closing brace:

```js
    else { row.classList.add('ti-empty'); av.textContent = '⌛'; nm.textContent = 'מחפש...'; }
```

If an `else` already exists there, add `row.classList.add('ti-empty');` to it rather than replacing its content.

- [ ] **Step 5: Send trophies, and split the two entry points**

The hub trophy count already lives in `window.SALTIZ_XP`. Add a helper near `xpDiffLevel`:

```js
// The number the hub bar prints as גביעים IS the XP number, so matchmaking needs no new metric.
// Sent with every queue request; the server bands on it.
const myTrophies = () => Math.max(0, +(window.SALTIZ_XP || 0) || 0);
```

Then:
- `quick-match-btn` handler (~line 2436): add `trophies: myTrophies()` to the `quickMatch` message.
- The `2v2` MODES row (~line 2253): change `launch` to
  `() => sendMsg({ type: 'matchmade', format: 'quick', diffLevel: xpDiffLevel(), trophies: myTrophies() })`
  so a deliberate mode pick carries the 10s budget while the yellow button keeps 5s.
- The `brawl` row (~line 2259) and the `3v3` row (~line 2268): add `trophies: myTrophies()`.

- [ ] **Step 6: Clear the chrome when the room arrives**

In the `roomJoined` branch, add `hideSearching();` as the first statement. In the `toHome` and `roomError` branches, add `hideSearching();` beside the existing `hideVs()`.

- [ ] **Step 7: Verify in a real browser**

```bash
PORT=3052 node server.js & sleep 3
```
Then drive it over CDP at 844×390: navigate, click `#quick-match-btn`, wait 1200 ms, and read:

```js
!document.getElementById('ti-search').classList.contains('hidden')   // true
document.getElementById('ti-search-band').textContent                 // "רמה 1" (or the account's band)
document.querySelectorAll('.ti-search-pips i').length                 // 4
document.querySelectorAll('.ti-away .ti-row.ti-empty').length         // 2
```
Capture a screenshot and **look at it**. Expected: title `מחפש יריבים...`, 4 pips with 1 lit, both opponent rows dashed with `מחפש...`, no bot names anywhere. Kill the server with `kill %1`.

- [ ] **Step 8: Commit**

```bash
git add public/index.html public/client.js public/style.css
git commit -m "feat(matchmaking): a search state that shows what is being searched for

The countdown published preview bots under יריבים from the first tick, so the
wait was a decided lineup wearing a timer. Opponent slots now start genuinely
empty (dashed, מחפש...) and the chrome states the search: how many others are
searching, and which band — 'רמה 5' widening visibly to 'רמה 4–6', because an
unexplained countdown reads as lag while a widening net reads as effort.

The 2v2 card now sends `matchmade { format: 'quick' }` instead of `quickMatch`.
Both resolved to the same message before, so the server had no way to tell 'quick
play' from 'chose 2v2' — which is exactly what the 5s/10s split needs.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: The resolution states — FOUND and NO PLAYERS

**Files:**
- Modify: `public/client.js` — `roomJoined` + `updateVsCountdown`
- Modify: `public/style.css`

**Interfaces:**
- Consumes: `roomJoined { mmReason, humans }` from Task 3; `hideSearching`, `renderSearchChrome` from Task 5.

- [ ] **Step 1: Show the resolution banner**

In `client.js`'s `roomJoined` branch, replace the `hideSearching();` added in Task 5 with:

```js
      // RESOLUTION. The banner is chosen by HUMAN COUNT, never by mmReason: a 'deadline' group can
      // contain exactly one human, and announcing "נמצאו יריבים!" over four bots is the dishonesty
      // this screen was rebuilt to remove.
      if (searchingLive) showResolution((msg.humans | 0) >= 2);
      else hideSearching();
```

Add near `hideSearching`:

```js
function showResolution(foundHumans) {
  const box = document.getElementById('ti-search');
  const title = document.getElementById('ti-search-title');
  const sub = document.getElementById('ti-search-sub');
  if (!box || !title) { hideSearching(); return; }
  searchingLive = false;
  box.classList.remove('hidden');
  box.classList.add(foundHumans ? 'found' : 'alone');
  title.textContent = foundHumans ? 'נמצאו יריבים!' : 'אין שחקנים פנויים כרגע';
  sub.textContent = '';
  document.getElementById('ti-search-pips')?.querySelectorAll('i').forEach((d) => d.classList.add('on'));
}
```

- [ ] **Step 2: Keep the banner through the reveal**

In `updateVsCountdown`, the search chrome must survive the `lobby` payloads that arrive during the reveal. Add as its first statement:

```js
  // Keep whatever resolution banner showResolution set; only a fresh search replaces it.
  const searchBox = document.getElementById('ti-search');
  const keepBanner = searchBox && !searchBox.classList.contains('hidden')
    && (searchBox.classList.contains('found') || searchBox.classList.contains('alone'));
```

And immediately before `teamIntroEl.classList.remove('hidden');` at the end:

```js
  if (!keepBanner) hideSearching();
```

- [ ] **Step 3: Reset the banner classes on a new search**

In `showSearching`, after `searchingLive = true;`:

```js
  const box0 = document.getElementById('ti-search');
  box0?.classList.remove('found', 'alone');   // a fresh search must not inherit the last one's banner
```

- [ ] **Step 4: Style the two banners**

Append to `public/style.css`:

```css
.ti-search.found .ti-search-title { color: #8ef2a3; }
.ti-search.alone .ti-search-title { color: #ffd06a; }
```

- [ ] **Step 5: Verify both states in a real browser**

Boot on 3053. **NO PLAYERS:** click `#quick-match-btn`, wait 4000 ms, read
`document.getElementById('ti-search-title').textContent` → `אין שחקנים פנויים כרגע`, and confirm
`document.querySelectorAll('.ti-away .ti-row').length === 2` with bot **names** (not `Bot`). Screenshot and look.

**FOUND:** open two CDP tabs against the same server, click quick-match in both within a second, wait
3000 ms, and read the title in each → `נמצאו יריבים!`, with `.ti-away` showing the other player's name
in at least one tab. Screenshot both and look.

- [ ] **Step 6: Commit**

```bash
git add public/client.js public/style.css
git commit -m "feat(matchmaking): FOUND and NO PLAYERS resolution states

Chosen by HUMAN COUNT, not by the group's reason. A 'deadline' group can hold
exactly one human, so keying the banner off reason would announce
'נמצאו יריבים!' over a lineup of four bots.

The banner survives the lobby payloads that arrive during the reveal hold, and a
fresh search clears it, so one search never inherits the previous one's outcome.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Cancelling a search

**Files:**
- Modify: `public/index.html` — a חזרה button inside `#ti-search`
- Modify: `public/client.js`
- Modify: `public/style.css`

**Interfaces:**
- Consumes: the `cancelSearch` handler from Task 3.

- [ ] **Step 1: Add the button**

Inside `#ti-search`, after `#ti-search-sub`:

```html
      <!-- Cancel. .ti-search is pointer-events:none so the VS art stays tappable-through; the button
           re-enables them for itself only. -->
      <button type="button" id="ti-search-cancel" class="builder-btn ti-search-cancel">‹ חזרה</button>
```

- [ ] **Step 2: Style it**

```css
.ti-search-cancel { pointer-events: auto; margin-top: 2px; font-size: 11px; padding: 2px 8px; }
.ti-search.found .ti-search-cancel, .ti-search.alone .ti-search-cancel { display: none; }
```

- [ ] **Step 3: Wire it**

Near the other home-action listeners:

```js
// Cancel a live search. Hidden once a group resolves — at that point a room exists and the match is
// about to start, so "cancel" would mean leaving a match, not a queue.
document.getElementById('ti-search-cancel')?.addEventListener('click', () => {
  if (!searchingLive) return;
  sendMsg({ type: 'cancelSearch' });
  hideSearching(); quickVs = false; hideVs(); showScreen('home');
});
```

- [ ] **Step 4: Verify**

Boot on 3054. Click quick-match, wait 800 ms, click `#ti-search-cancel`, wait 500 ms, then read:

```js
document.getElementById('team-intro').classList.contains('hidden')  // true
!document.getElementById('home').classList.contains('hidden')       // true
```
Then click quick-match again and confirm the search starts fresh (`ti-search-band` populated, no
`found`/`alone` class). Screenshot the hub after cancelling and look at it.

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/client.js public/style.css
git commit -m "feat(matchmaking): cancel a live search

חזרה drops the ticket server-side and returns to the hub. Hidden once a group has
resolved: a room exists by then, so cancelling would mean abandoning a match
rather than a queue.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: End-to-end socket test

**Files:**
- Create: `test-matchmaking-live.mjs`

**Interfaces:**
- Consumes: `bootServer` from `boot-test-server.mjs`; the `searching` / `roomJoined` / `matchStart` wire.

- [ ] **Step 1: Write the test**

Create `test-matchmaking-live.mjs`:

```js
// MATCHMAKING, end to end over real sockets.
//
// test-matchmaker.mjs owns the POLICY (pure, no timers). This owns the WIRING: that trophies reach
// the bands, that the searching message is actually sent, that humans land on opposite teams, and
// that a full room does not wait out its budget.
//
// Boots its own server (boot-test-server.mjs). Never point this at a long-running process: a stale
// server produced a FALSE GREEN in this repo before, which is worse than no server.
import { WebSocket } from 'ws';
import { bootServer } from './boot-test-server.mjs';
import { MM_ALONE_MS, MM_BUDGET_QUICK_MS, MM_REVEAL_MS } from './shared/constants.js';

const { url: URL } = await bootServer();
let failed = 0;
const ok = (l, c, x = '') => { if (!c) failed++; console.log(`  ${c ? '✅' : '❌'} ${l}${x ? ` — ${x}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(name) {
  const ws = new WebSocket(URL);
  const seen = [], waiters = [];
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (!m || !m.type) return;
    seen.push(m);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].type === m.type) { waiters[i].resolve(m); waiters.splice(i, 1); }
    }
  });
  return {
    name, seen,
    open: () => new Promise((res) => ws.once('open', res)),
    send: (o) => ws.send(JSON.stringify(o)),
    all: (type) => seen.filter((m) => m.type === type),
    last: (type) => [...seen].reverse().find((m) => m.type === type) || null,
    wait: (type, ms = 20000) => {
      const hit = seen.find((m) => m.type === type);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        waiters.push({ type, resolve });
        setTimeout(() => reject(new Error(`timeout waiting for ${type} (${name})`)), ms);
      });
    },
    close: () => ws.close(),
  };
}
// A joined client, ready to queue.
async function join(name, trophies) {
  const c = client(name);
  await c.open();
  c.send({ type: 'join', name, cards: [] });
  await c.wait('welcome').catch(() => null);   // some builds name it differently; presence is enough
  c.trophies = trophies;
  return c;
}

console.log('1) a lone player short-circuits to bots, fast');
{
  const a = await join('Solo', 1000);
  const t0 = Date.now();
  a.send({ type: 'quickMatch', trophies: 1000, diffLevel: 4 });
  const s = await a.wait('searching');
  ok('a searching message arrives before any room', !!s && !a.last('roomJoined'), JSON.stringify(s && s.phase));
  ok('...reporting my own band', s.slots && s.slots.total === 4, JSON.stringify(s.slots));
  const rj = await a.wait('roomJoined');
  const dt = Date.now() - t0;
  ok('resolves near MM_ALONE_MS, not the full budget', dt < MM_BUDGET_QUICK_MS, `${dt}ms`);
  ok('...as a single human', rj.humans === 1, String(rj.humans));
  const ms = await a.wait('matchStart');
  ok('the match starts after the reveal hold', Date.now() - t0 >= MM_ALONE_MS + MM_REVEAL_MS - 400, `${Date.now() - t0}ms`);
  ok('...with a full roster of 4', (ms.players || []).filter(Boolean).length === 4, String((ms.players || []).length));
  ok('...and every bot has a real name, not "Bot"',
    (ms.players || []).filter((p) => p && p.isBot).every((p) => p.name && p.name !== 'Bot'),
    JSON.stringify((ms.players || []).filter((p) => p && p.isBot).map((p) => p.name)));
  a.close();
}

console.log('\n2) two same-band players are matched, on OPPOSITE teams');
{
  const a = await join('Ay', 1000), b = await join('Bee', 1100);
  a.send({ type: 'quickMatch', trophies: 1000, diffLevel: 4 });
  await sleep(150);
  b.send({ type: 'quickMatch', trophies: 1100, diffLevel: 4 });
  const [ra, rb] = await Promise.all([a.wait('roomJoined'), b.wait('roomJoined')]);
  ok('both see 2 humans', ra.humans === 2 && rb.humans === 2, `${ra.humans}/${rb.humans}`);
  const ms = await a.wait('matchStart');
  const humans = (ms.players || []).filter((p) => p && !p.isBot);
  ok('two humans in the match', humans.length === 2, String(humans.length));
  ok('...on opposite teams', new Set(humans.map((p) => p.team)).size === 2, JSON.stringify(humans.map((p) => p.team)));
  a.close(); b.close();
}

console.log('\n3) far-apart bands are NOT matched together');
{
  // L1 (0 trophies) and L11 (5500) must never share a room, however long either waits.
  const a = await join('Rookie', 0), b = await join('Veteran', 5500);
  a.send({ type: 'quickMatch', trophies: 0, diffLevel: 0 });
  b.send({ type: 'quickMatch', trophies: 5500, diffLevel: 10 });
  const [ra, rb] = await Promise.all([a.wait('roomJoined'), b.wait('roomJoined')]);
  ok('each gets its OWN room', ra.humans === 1 && rb.humans === 1, `${ra.humans}/${rb.humans}`);
  const [ma, mb] = await Promise.all([a.wait('matchStart'), b.wait('matchStart')]);
  const lv = (m) => (m.players || []).find((p) => p && p.isBot)?.level;
  ok('the rookie faces low-level bots and the veteran high-level ones', lv(ma) < lv(mb), `${lv(ma)} vs ${lv(mb)}`);
  a.close(); b.close();
}

console.log('\n4) a full room kicks off without waiting out the budget');
{
  const cs = await Promise.all([join('P1', 1000), join('P2', 1000), join('P3', 1000), join('P4', 1000)]);
  const t0 = Date.now();
  for (const c of cs) c.send({ type: 'matchmade', format: 'quick', trophies: 1000, diffLevel: 4 });
  const rjs = await Promise.all(cs.map((c) => c.wait('roomJoined')));
  const dt = Date.now() - t0;
  ok('all four land in one room', rjs.every((r) => r.humans === 4), JSON.stringify(rjs.map((r) => r.humans)));
  // Budget for a mode card is 10s; a full room must not wait for it.
  ok('resolved well under the 10s budget', dt < 3000, `${dt}ms`);
  const ms = await cs[0].wait('matchStart');
  ok('no bots in a full human room', !(ms.players || []).some((p) => p && p.isBot), JSON.stringify((ms.players || []).map((p) => p && p.isBot)));
  ok('teams are 2-2', (ms.players || []).filter((p) => p && p.team === 'A').length === 2);
  for (const c of cs) c.close();
}

console.log('\n5) cancelling removes the ticket');
{
  const a = await join('Quitter', 1000), b = await join('Stayer', 1000);
  a.send({ type: 'quickMatch', trophies: 1000, diffLevel: 4 });
  b.send({ type: 'quickMatch', trophies: 1000, diffLevel: 4 });
  await b.wait('searching');
  await sleep(400);
  const before = b.last('searching');
  ok('with company, b sees 2 searching', before.searchingCount === 2, String(before.searchingCount));
  a.send({ type: 'cancelSearch' });
  await sleep(600);
  const after = b.last('searching');
  ok('after a cancels, b sees 1 searching', after.searchingCount === 1, String(after.searchingCount));
  ok('a is sent home', !!a.last('toHome'));
  a.close(); b.close();
}

console.log('\n6) the other room types still bypass matchmaking');
{
  const a = await join('Trainer', 1000);
  a.send({ type: 'training', diffLevel: 3 });
  const ms = await a.wait('matchStart');
  ok('training starts immediately, with no searching message', !a.last('searching'), JSON.stringify(a.all('searching').length));
  ok('...and is a real match', !!ms);
  a.close();
  const h = await join('Host', 1000);
  h.send({ type: 'createRoom' });
  const rj = await h.wait('roomJoined');
  ok('a private room is not matchmade', rj.matchmade !== true, JSON.stringify(rj.matchmade));
  ok('...and produced no searching message', !h.last('searching'));
  h.close();
}

console.log(failed ? `\n❌ ${failed} failed` : '\n✅ all passed');
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: Run it**

Run: `node test-matchmaking-live.mjs`
Expected: all pass. Two likely real failures to fix rather than paper over:
- If §1 shows `roomJoined` before `searching`, `enqueue` is not sending its opening `searching`.
- If §3 matches the rookie with the veteran, `roomMaxFor` or the band ceiling is wrong.

If `a.wait('welcome')` rejects because the server names its handshake differently, replace it with `await sleep(120)` — the join only needs to have landed.

- [ ] **Step 3: Commit**

```bash
git add test-matchmaking-live.mjs
git commit -m "test(matchmaking): end-to-end over real sockets

Covers the wiring the pure tests cannot: that trophies reach the bands, that the
searching message precedes any room, that two humans land on OPPOSITE teams, that
a full room ignores its budget, that cancelling drops the ticket and the remaining
player's count falls, and that training and private rooms still bypass
matchmaking.

Boots its own server — a stale process produced a false green in this repo before.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Full suite, screenshots, and the handoff log

**Files:**
- Modify: `AGENT_REQUEST_LOG.md`
- Modify: `docs/superpowers/specs/2026-07-27-matchmaking-countdown-design.md` (status line)

- [ ] **Step 1: Run the whole suite with a watchdog**

`timeout(1)` does not exist on macOS. Use:

```bash
cat > /tmp/mmsuite.sh <<'EOF'
#!/bin/zsh
cd /Users/adamleeperelman/Documents/pikeme/football-mock
P=0; F=0; H=0; FL=""; HL=""
for f in test*.mjs; do
  node "$f" > /tmp/mm_one.log 2>&1 & pid=$!
  n=0; while kill -0 $pid 2>/dev/null && [ $n -lt 100 ]; do sleep 1; n=$((n+1)); done
  if kill -0 $pid 2>/dev/null; then kill -9 $pid 2>/dev/null; wait $pid 2>/dev/null; H=$((H+1)); HL="$HL $f"
  else wait $pid; rc=$?; if [ $rc -eq 0 ]; then P=$((P+1)); else F=$((F+1)); FL="$FL $f"; fi; fi
done
echo "PASS=$P FAIL=$F HANG=$H"; echo "failed:$FL"; echo "hung:$HL"
EOF
chmod +x /tmp/mmsuite.sh && /tmp/mmsuite.sh
```

Expected: `test-bot-partner.mjs` FAILs and `test-bot-ladder.mjs` HANGs — both **pre-existing**, in the bot agent's area, unrelated to this work. Anything else must be fixed before committing. Do not "fix" a failure by weakening its assertion without reading why it fires.

- [ ] **Step 2: Capture the three screen states**

Boot on 3055 and capture at 844×390: SEARCHING (one client, t≈800 ms), NO PLAYERS (one client, t≈4000 ms), FOUND (two clients, t≈3000 ms). **Look at all three.** Check specifically: no text overflows its column at 3v3 row density, the band chip does not collide with the pip row, and Hebrew reads right-to-left throughout.

- [ ] **Step 3: Log the work**

Add to the top of `AGENT_REQUEST_LOG.md`'s `## 2026-07-27` section (create the section if today's is absent), following the existing entry style: the request in the user's words, the files taken, what changed, and — separately — the pre-existing failures so the next agent does not attribute them to this work.

- [ ] **Step 4: Mark the spec implemented**

Change the spec's `**Status:**` line to `implemented 2026-07-27, not yet pushed`.

- [ ] **Step 5: Commit**

```bash
git add AGENT_REQUEST_LOG.md docs/superpowers/specs/2026-07-27-matchmaking-countdown-design.md
git commit -m "docs(matchmaking): log the work and mark the spec implemented

Suite result recorded with the two pre-existing failures (test-bot-partner FAIL,
test-bot-ladder HANG) called out separately so they are not attributed here.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Self-review

**Spec coverage.** Band ladder + widening + L12 ceiling + asymmetric floor → Task 1. `planMatches`, fairness, mutual compatibility, grace definition, median level, cancellation → Tasks 2–3. Per-ticket budgets and the 2v2 entry-point split → Tasks 1, 3, 5. Short-circuit, not latched → Tasks 2, 8. Named bots → Task 4. All three screen states, searching count, visible widening, fixed reveal → Tasks 5–6. Cancel → Task 7. Both test files → Tasks 1–2, 8. Unknown-trophy fallback → Task 3 (`xpFallbackTrophies`, plus the no-grace rule in `runMatchmaker`). Private/party/training bypass → Task 8 §6.

**Known gap, deliberate.** The spec's "L12+ collapses into one band" is asserted in Task 1 but never exercised end-to-end, because reaching L12 needs 6600 trophies and the live test uses 5500 (L11) to keep §3's bot-level comparison meaningful. Pure coverage is the right level for a pure rule.

**Type consistency.** `bandOf`/`acceptedBand`/`mutuallyCompatible`/`widenFor`/`planMatches` are named identically in Tasks 1, 2, 3 and both tests. `pickBotIdentities(count, botLevel, seed)` matches between Task 4's test, its implementation and its `lobbyPayload` call. `searching` carries the same seven fields in `enqueue`, `runMatchmaker`, `renderSearchChrome` and Task 8. `roomJoined` gains `mmReason` + `humans` in Task 3 and both are read in Task 6 and Task 8. `graceUntil` is written only in `runMatchmaker` and only read in `planMatches`, matching the "pure function never mutates its input" contract from Task 2's final assertion.

**One thing an implementer must not skip.** Task 3 Step 8 boots the server after `node --check`. `node --check` validates syntax only — a bad import (the mistake that stopped this server booting once already, `require` in an ES module) throws at load and passes the check.
