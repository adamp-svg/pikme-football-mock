# Football Stadium & Drill-Down Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put a pedestal stadium on all six tabs of the football rank board, and make entity rows open that entity's players.

**Architecture:** Two repos. `football-mock/public/clubs.js` gains one `renderPodium()` used by both the group and personal paths — possible because `/handle-clubs/board` deliberately ships the same `value` key for group rows and player rows. `pikme-server` gains a `key` parameter on `/handle-clubs/board` that returns player rows filtered to one entity, reusing the existing personal-board machinery.

**Tech Stack:** Vanilla ES modules + hand-rolled DOM (`el()` helper), no framework, no build step. Node ≥18. Express + Mongoose on the server. Verification is headless Chrome over CDP via `_rank-*.mjs` scripts — there is no jest in `football-mock`.

## Global Constraints

- **This is a DARK theme.** `public/clubs.css` is olive/near-black: rows `#262f1c`, score text `#cfe6c8`, muted `#7f9179`, gold accent `#ffd447`, top-1 `#ffe98a`. **Do NOT import the app's cream palette** (`#FFF7EC`) — that belongs to the native card app.
- Medal colours, shared with the app for cross-surface consistency: gold `#F5C400`, silver `#B9C2CC`, bronze `#CD7F32`.
- Hebrew is RTL and the game UI is already RTL — never interpolate a raw id into visible text.
- `el(tag, cls, html)` builds elements; `esc()` escapes user text; `num()` formats numbers; `METRIC_UNIT[key]` gives the Hebrew unit word. All already exist in `clubs.js`.
- **Branch on what the server echoed, never on `state`.** `?scope=me` is answered as `personal` and `?metric=xp` as `trophies`; the two disagree for the frame between a tap and the response.
- **`await dirReady` before rendering any board** or city/school ids print raw instead of Hebrew names.
- Group rows: `{ rank, scopeId, value, members, label?, emblem? }`. Personal rows: `{ rank, userId?, nickName, image, club, emblem, value, isMe }`. Body carries `{ metric, scope, k: null, totalRanked, mineScopeId, rows }`.
- Commit locally. **Do not push** without the owner asking — pushing this repo deploys to Render.

---

### Task 1: The podium renderer, on the personal board

**Files:**
- Modify: `public/clubs.css` (append a `/* ── podium ── */` block at the end)
- Modify: `public/clubs.js` — add `renderPodium()` near `renderPersonal()` (~line 610); call it from `renderPersonal()`
- Test: `_rank-podium.mjs` (create)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `renderPodium(rows, host, unit)` → appends one `.scope-podium` element built from the three lowest-`rank` entries of `rows`, and **returns a `Set` of the ids it rendered** (`String(r.userId ?? r.scopeId)`). Task 2 and Task 4 both call it. Row label comes from `r.nickName ?? r.label`.

- [ ] **Step 1: Write the failing test**

Create `_rank-podium.mjs`. It stubs the clubs API in-page so no token, no Mongo and no live server are needed — copy the stub/bootstrap preamble verbatim from `_rank-personal.mjs` (same two gates apply: `/me` must answer with a `me` key or `#scope-wrap` stays hidden, and the rank screen opens from `#rank-btn`, not a `[data-open-screen]`).

```js
// After opening the rank screen on the אני tab, with 6 stubbed players ranked 1..6:
const r = await send('Runtime.evaluate', { expression: `(() => {
  const pod = document.querySelector('.scope-podium')
  if (!pod) return JSON.stringify({ ok: false, why: 'no .scope-podium' })
  const places = [...pod.querySelectorAll('.pod-place')]
  const rows = [...document.querySelectorAll('.scope-row')]
  return JSON.stringify({
    ok: true,
    places: places.length,
    order: places.map(p => p.querySelector('.pod-disc').textContent),
    names: places.map(p => p.querySelector('.pod-name').textContent),
    values: places.map(p => p.querySelector('.pod-val').textContent),
    firstIsCentre: places[1].classList.contains('first'),
    // the three on the podium must NOT repeat in the list below it
    listRanks: rows.map(x => x.querySelector('.pos').textContent),
  })
})()`, returnByValue: true })
const got = JSON.parse(r.result.value)
console.log(got)
if (!got.ok) throw new Error('FAIL: ' + got.why)
if (got.places !== 3) throw new Error(`FAIL: expected 3 places, got ${got.places}`)
// visual order is 2 · 1 · 3 so #1 sits centre and tallest
if (got.order.join(',') !== '2,1,3') throw new Error(`FAIL: order was ${got.order}`)
if (!got.firstIsCentre) throw new Error('FAIL: #1 is not the centre column')
if (got.listRanks.some(x => ['1','2','3'].includes(x))) throw new Error('FAIL: podium ranks repeated in the list')
console.log('PASS')
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node _rank-podium.mjs` (needs a local server; start one on a port no other agent is using, e.g. `PORT=3016 node server.js`)
Expected: `FAIL: no .scope-podium`

- [ ] **Step 3: Add the podium CSS**

Append to `public/clubs.css`:

```css
/* ── podium (stadium) — the top 3 of whatever the active tab ranks ──────────────────────────────
   Dark-theme sibling of the card app's LeaderboardPodium: same medal triad and the same 2·1·3
   column order, on this screen's olive ground rather than the app's cream. */
.scope-podium {
  background: #1d2417; border: 1px solid #2f3a26; border-radius: 16px;
  padding: 12px 8px 0; margin: 0 auto 10px; max-width: 520px;
  display: grid; grid-template-columns: 1fr 1.14fr 1fr; align-items: end; gap: 5px;
}
.pod-place { display: flex; flex-direction: column; align-items: center; text-align: center; min-width: 0; }
.pod-crown { font-size: 19px; line-height: 1; margin-bottom: 1px; }
.pod-disc {
  width: 38px; height: 38px; border-radius: 999px; display: grid; place-items: center;
  font: 900 16px Arial, sans-serif; color: #1a1205;
  border: 2px solid rgba(255,255,255,.75); margin-bottom: 6px;
}
.pod-place.first .pod-disc { width: 48px; height: 48px; font-size: 20px; box-shadow: 0 0 12px 1px rgba(245,196,0,.55); }
.pod-name {
  font: 800 12px Arial, sans-serif; color: #e7f0e2; margin-bottom: 7px; line-height: 1.2;
  max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.pod-ped { width: 100%; border-radius: 12px 12px 0 0; padding: 7px 3px 12px; }
.pod-place.first  .pod-ped { height: 74px; }
.pod-place.second .pod-ped { height: 52px; }
.pod-place.third  .pod-ped { height: 40px; }
.pod-val { display: block; font: 900 15px "Arial Black", sans-serif; color: #1a1205; }
.pod-place.first .pod-val { font-size: 17px; }
.pod-unit { display: block; font: 700 9px Arial, sans-serif; color: rgba(26,18,5,.66); letter-spacing: .5px; }
```

- [ ] **Step 4: Add `renderPodium()` to `clubs.js`**

Insert immediately above `function renderPersonal(`:

```js
// ── the PODIUM ────────────────────────────────────────────────────────────────────────────────────
// ONE renderer for all six tabs. It works on group rows AND player rows because /handle-clubs/board
// deliberately ships the same `value` key for both ("what lets the client render both with one row
// component"). Label falls back scopeId-side: a player row has nickName, a group row has label.
//
// ⚠️ Picks the three BY POSITION after sorting on rank, never by testing `rank === 1|2|3`. Ranks are
// dense and tie: several rows legitimately share rank 1, and a value test would render the same slot
// three times and leave two empty placeholders. Returns the ids it drew so the caller can exclude
// them from the list below BY IDENTITY — a `rank > 3` filter deletes a 4th row tied at 3.
const MEDAL = { 1: { disc: '#F5C400', face: '#F7E39B' }, 2: { disc: '#B9C2CC', face: '#DDE3E9' }, 3: { disc: '#CD7F32', face: '#EBC49B' } }

function podiumId(r) { return String(r.userId != null ? r.userId : r.scopeId) }

function renderPodium(rows, host, unit) {
  const ranked = (rows || [])
    .filter((r) => r && Number.isFinite(Number(r.rank)) && Number(r.rank) >= 1)
    .slice()
    .sort((a, b) => Number(a.rank) - Number(b.rank))
    .slice(0, 3)
  if (!ranked.length) return new Set()
  const pod = el('div', 'scope-podium')
  // 2 · 1 · 3 so #1 is centre and tallest. A missing place renders nothing rather than a placeholder.
  const slots = [[ranked[1], 'second'], [ranked[0], 'first'], [ranked[2], 'third']]
  slots.forEach(([r, cls]) => {
    if (!r) { pod.append(el('div', 'pod-place ' + cls)); return }
    const place = Number(cls === 'first' ? 1 : cls === 'second' ? 2 : 3)
    const m = MEDAL[place]
    const name = r.nickName != null ? r.nickName : (r.label != null ? r.label : '—')
    // The disc prints the row's OWN dense rank, not the slot number, or a tie invents places the board
    // does not have.
    pod.append(el('div', 'pod-place ' + cls,
      `${cls === 'first' ? '<div class="pod-crown">👑</div>' : ''}
       <div class="pod-disc" style="background:${m.disc}">${Number(r.rank)}</div>
       <div class="pod-name">${esc(String(name))}</div>
       <div class="pod-ped" style="background:${m.face}">
         <span class="pod-val">${num(r.value)}</span><span class="pod-unit">${esc(unit || '')}</span>
       </div>`))
  })
  host.append(pod)
  return new Set(ranked.map(podiumId))
}
```

Then in `renderPersonal()`, right after the `if (!rows.length) { … return }` guard, replace the start of the row loop so the podium draws first and its three are skipped:

```js
    const unit = METRIC_UNIT[data.metric] || METRIC_UNIT[state.metric] || ''
    const onPodium = renderPodium(rows, list, unit)
    let prev = null
    rows.forEach((r) => {
      if (onPodium.has(podiumId(r))) return   // already on the podium — never draw a row twice
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `node _rank-podium.mjs`
Expected: `PASS`, and the logged `order` is `2,1,3`.

- [ ] **Step 6: Eyeball it, then commit**

The harness writes a screenshot; open it and confirm the pedestals step down 1 > 2 > 3, the crown sits on the centre column, and nothing clips at 844×390.

```bash
git add public/clubs.css public/clubs.js _rank-podium.mjs
git commit -m "feat(rank): a pedestal podium on the אני board"
```

---

### Task 2: The podium on the five group tabs

**Files:**
- Modify: `public/clubs.js` — the group branch of `renderBoard()` (~line 548-600)
- Test: `_rank-podium.mjs` (extend)

**Interfaces:**
- Consumes: `renderPodium(rows, host, unit)` and `podiumId(r)` from Task 1.
- Produces: nothing new.

- [ ] **Step 1: Extend the test to the עיר tab**

Append to `_rank-podium.mjs` — stub `/board?scope=city` with 5 group rows (`{rank, scopeId, value, members}`), click the עיר tab, then assert:

```js
const g = JSON.parse((await send('Runtime.evaluate', { expression: `(() => {
  const pod = document.querySelector('.scope-podium')
  const places = pod ? [...pod.querySelectorAll('.pod-place')] : []
  return JSON.stringify({
    hasPodium: !!pod,
    names: places.map(p => (p.querySelector('.pod-name')||{}).textContent || ''),
    // a group podium must show resolved Hebrew names, never a raw numeric id
    rawIds: places.some(p => /^\\d{6,}$/.test(((p.querySelector('.pod-name')||{}).textContent||'').trim())),
    listCount: document.querySelectorAll('.scope-row').length,
  })
})()`, returnByValue: true })).result.value)
if (!g.hasPodium) throw new Error('FAIL: no podium on the city tab')
if (g.rawIds) throw new Error('FAIL: podium printed a raw scopeId instead of a Hebrew name')
console.log('PASS city podium', g)
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node _rank-podium.mjs`
Expected: `FAIL: no podium on the city tab`

- [ ] **Step 3: Draw the podium in the group branch**

In `renderBoard()`, the group path already resolves `r.label` for city/school/grade/class before rendering rows. **The podium must be drawn AFTER that loop assigns labels** — otherwise it renders raw ids. So: keep the existing `data.rows.slice(0, 20).forEach(...)` label-resolution, but move row *appending* to run after a `renderPodium` call, like this:

The group branch **already** resolves labels inside its `data.rows.slice(0, 20).forEach(...)` loop
(`clubs.js` ~line 556-577), using `cityName()`, `schoolName()`, and inline `GRADE_HE` lookups — there
is no `gradeClassLabel()` helper and you must not invent one. The change is to **split that one loop in
two**: resolve first, then draw the podium, then draw the rows.

Replace the single loop's head so the label/emblem assignment runs over a named array, and keep its
body EXACTLY as it is today (`cityName` / `schoolName` / the two `GRADE_HE` branches / the
`r.label = r.label || String(r.scopeId)` fallback / the emblem defaults) — only the two `state.scope`
reads change to `data.scope`:

```js
    const unit = METRIC_UNIT[data.metric] || METRIC_UNIT[state.metric] || ''
    const shown = data.rows.slice(0, 20)
    // PASS 1 — resolve labels. The podium prints NAMES, so it must run after this or it shows «1953726605».
    shown.forEach((r) => {
      if (!r.label) {
        if (data.scope === 'city') r.label = cityName(r.scopeId)
        else if (data.scope === 'school') r.label = schoolName(r.scopeId)
        else if (data.scope === 'grade') { const [, g] = String(r.scopeId).split('|'); r.label = `שכבת ${GRADE_HE[g] || g}` }
        else if (data.scope === 'class') { const [, g, c] = String(r.scopeId).split('|'); r.label = `${GRADE_HE[g] || g}${c}` }
      }
      r.label = r.label || String(r.scopeId)
      r.emblem = r.emblem || ({ city: '🏙️', school: '🏫', grade: '📚', class: '🎒', club: '🏰' }[data.scope])
    })
    // PASS 2 — the podium, then the rows it did not take.
    const onPodium = renderPodium(shown, list, unit)
    shown.forEach((r) => {
      if (onPodium.has(podiumId(r))) return
      // …the existing row-building body, unchanged…
    })
```

⚠️ `data.scope`, not `state.scope`. The server echoes the canonical scope and the two disagree for the
frame between a tap and the response — the same class of bug the metric/unit mismatch note in this file
already documents. The existing code reads `state.scope` in these branches; correcting it is part of
this task.

- [ ] **Step 4: Run the test and watch it pass**

Run: `node _rank-podium.mjs`
Expected: both `PASS` lines.

- [ ] **Step 5: Screenshot all six tabs, then commit**

Extend the harness to click each of the six tabs and capture one screenshot each; confirm every tab has a podium and that שכבה/כיתה still show their empty note when stubbed with zero rows.

```bash
git add public/clubs.js _rank-podium.mjs
git commit -m "feat(rank): the podium on every scope tab, not just אני"
```

---

### Task 3: `key` on `/handle-clubs/board` — one entity's players

**Files:**
- Modify: `/Users/adamleeperelman/Documents/pikeme/pikme-server/routes-pikme/clubs.js` — the `/board` handler (~line 570)
- Test: Create `/Users/adamleeperelman/Documents/pikeme/pikme-server/routes-pikme/clubs.drilldown.test.js`

**Interfaces:**
- Consumes: `scopeOf(kind)` and the personal-board machinery already in `clubs.js`.
- Produces: `GET /handle-clubs/board?metric=<m>&scope=<kind>&key=<scopeId>` → the personal-board body shape (`{ metric, scope: 'personal', drill: { kind, key }, totalRanked, rows: [player rows], me }`) restricted to members of that entity. `rows` use the same player shape as the personal board, so Task 4 renders them with the existing row code.

- [ ] **Step 1: Write the failing test**

`clubs.drilldown.test.js`, following the sibling convention in `clubs.personal.test.js`:

```js
const { entityFilter } = require('./clubs')   // export it in step 3
describe('entityFilter — which players belong to one entity', () => {
  const p = (o) => Object.assign({ scopeCityId: null, scopeSchoolSemel: null, scopeGrade: null, scopeClassNumber: null, scopeGroupId: null }, o)
  test('city matches on cityId as a STRING (ids arrive numeric-looking)', () => {
    expect(entityFilter('city', '99032825')(p({ scopeCityId: 99032825 }))).toBe(true)
    expect(entityFilter('city', '99032825')(p({ scopeCityId: '1' }))).toBe(false)
  })
  test('grade needs BOTH semel and grade — grade 6 exists in every school', () => {
    const f = entityFilter('grade', '312082|6')
    expect(f(p({ scopeSchoolSemel: '312082', scopeGrade: 6 }))).toBe(true)
    expect(f(p({ scopeSchoolSemel: '999999', scopeGrade: 6 }))).toBe(false)
  })
  test('class needs all three', () => {
    const f = entityFilter('class', '312082|6|2')
    expect(f(p({ scopeSchoolSemel: '312082', scopeGrade: 6, scopeClassNumber: 2 }))).toBe(true)
    expect(f(p({ scopeSchoolSemel: '312082', scopeGrade: 6, scopeClassNumber: 3 }))).toBe(false)
  })
  test('an unknown or malformed key matches NOBODY — it must never throw or match all', () => {
    expect(entityFilter('city', '')(p({ scopeCityId: '1' }))).toBe(false)
    expect(entityFilter('grade', '312082')(p({ scopeSchoolSemel: '312082', scopeGrade: 6 }))).toBe(false)
    expect(entityFilter('nope', '1')(p({ scopeCityId: '1' }))).toBe(false)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd /Users/adamleeperelman/Documents/pikeme/pikme-server && npx jest routes-pikme/clubs.drilldown.test.js`
Expected: FAIL — `entityFilter is not a function`

- [ ] **Step 3: Implement `entityFilter` and wire the `key` branch**

In `clubs.js`, add near `scopeOf` and export it (`module.exports.entityFilter = entityFilter` alongside the existing exports):

```js
// Which players belong to ONE entity. The key spelling is the same one the group rows emit and the same
// one groups.js documents: '<cityId>' | '<semel>' | '<semel>|<grade>' | '<semel>|<grade>|<class>' | '<clubId>'.
// ⚠️ Compare as STRINGS — city ids and semels are numeric-looking and arrive as either type.
// ⚠️ A malformed key must match NOBODY. Matching everybody would silently turn a drill-down into the
// national board, which reads as working.
const KEY_ARITY = { city: 1, school: 1, grade: 2, class: 3, club: 1 }
function entityFilter(kind, key) {
  const arity = KEY_ARITY[kind]
  const parts = String(key == null ? '' : key).split('|')
  if (!arity || parts.length !== arity || parts.some((x) => x === '')) return () => false
  const [a, b, c] = parts
  if (kind === 'city') return (s) => String(s.scopeCityId) === a
  if (kind === 'school') return (s) => String(s.scopeSchoolSemel) === a
  if (kind === 'club') return (s) => String(s.scopeGroupId) === a
  if (kind === 'grade') return (s) => String(s.scopeSchoolSemel) === a && String(s.scopeGrade) === b
  return (s) => String(s.scopeSchoolSemel) === a && String(s.scopeGrade) === b && String(s.scopeClassNumber) === c
}
```

In the `/board` handler, **before** the `if (kind === PERSONAL)` branch:

```js
        // DRILL-DOWN: ?scope=city&key=<id> ranks the PLAYERS of that one entity, so a row on the group
        // board can be opened. It reuses personalBoard() with a membership predicate rather than growing a
        // second ranking path. Echoes scope 'personal' because the ROWS are players — the client renders
        // them with the player row component — plus `drill` so it can show a back affordance and a title.
        const drillKey = req.query.key == null ? null : String(req.query.key)
        if (drillKey && kind !== PERSONAL) {
            const body = await personalBoard(
                { PlayerCardStats, FootballStats, UserInfo, Club },
                { metricKey, mePhone: normalizeBankPhone(me.phone), top: PERSONAL_FULL_TOP, around: 0,
                  memberOf: entityFilter(kind, drillKey) },
            )
            return res.json(Object.assign(body, { scope: 'personal', drill: { kind, key: drillKey } }))
        }
```

Then in `personalBoard()`, accept and apply `memberOf`: immediately after it loads its player list, add

```js
    // Optional membership predicate (the drill-down). Absent → the national board, unchanged.
    const pool = typeof memberOf === 'function' ? players.filter((p) => memberOf(p.s || p)) : players
```

and use `pool` wherever it previously used `players`. **Do not change the population/suppression rules** — the drill-down must inherit exactly the same excluded/test handling the personal board already applies.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx jest routes-pikme/clubs.drilldown.test.js routes-pikme/clubs.personal.test.js`
Expected: all PASS — including the existing personal-board suite, proving `memberOf`-absent is a no-op.

- [ ] **Step 5: Prove the suppression rule is load-bearing**

Temporarily delete the `isTest`/excluded clause inside `personalBoard`, re-run the personal suite, and confirm a test **fails**. Restore it. If nothing fails, add an assertion that a test-flagged player is absent from an organic caller's drill-down before moving on. Record what you observed in the commit body.

- [ ] **Step 6: Commit**

```bash
cd /Users/adamleeperelman/Documents/pikeme/pikme-server
git add routes-pikme/clubs.js routes-pikme/clubs.drilldown.test.js
git commit -m "feat(clubs): ?key= opens one entity's players on the board"
```

---

### Task 4: Entity rows open the drill-down

**Files:**
- Modify: `football-mock/public/clubs.js` — group row construction + `state`
- Modify: `football-mock/public/clubs.css` — a `.scope-back` affordance
- Test: `_rank-podium.mjs` (extend)

**Interfaces:**
- Consumes: `renderPodium`/`podiumId` (Task 1), the `?key=` endpoint (Task 3).
- Produces: nothing new.

- [ ] **Step 1: Extend the test**

Stub `/board?scope=city&key=99032825` with 4 player rows. Click the first group row, then assert a back button exists, the rows are players, and the title names the entity:

```js
await send('Runtime.evaluate', { expression: `document.querySelector('.scope-row').click()` })
await sleep(400)
const d = JSON.parse((await send('Runtime.evaluate', { expression: `JSON.stringify({
  asked: window.__asked.filter(u => u.includes('key=')),
  back: !!document.querySelector('.scope-back'),
  podium: !!document.querySelector('.scope-podium'),
  rows: document.querySelectorAll('.scope-row').length,
})`, returnByValue: true })).result.value)
if (!d.asked.length) throw new Error('FAIL: no request carried key=')
if (!d.back) throw new Error('FAIL: no back affordance')
if (!d.podium) throw new Error('FAIL: drill-down has no podium')
console.log('PASS drilldown', d)
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node _rank-podium.mjs`
Expected: `FAIL: no request carried key=`

- [ ] **Step 3: Implement**

Add `drill: null` to `state`. In `renderBoard()`, include the key in the request and clear the drill when tab or metric changes:

```js
  const drillQ = state.drill ? `&key=${encodeURIComponent(state.drill.key)}` : ''
  const data = await api(`/board?metric=${state.metric}&scope=${state.scope}${state.full ? '&full=1' : ''}${drillQ}`)
```

In the metric-pill and tab handlers, set `state.drill = null` alongside the existing `state.full = false`.

Make each group row clickable (inside the group row loop, after the row element is built):

```js
      // Group rows open that entity's players. Cursor + role so it reads as interactive, and the label
      // is carried through so the drilled view can name it without re-resolving the directory.
      row.style.cursor = 'pointer'
      row.setAttribute('role', 'button')
      row.tabIndex = 0
      const open = () => { state.drill = { kind: data.scope, key: String(r.scopeId), label: r.label || '' }; state.full = false; renderBoard() }
      row.onclick = open
      row.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open() } }
```

In `renderPersonal()`, when `data.drill` is present, prepend a titled back affordance:

```js
    if (data.drill) {
      const back = el('button', 'scope-back', `‹ חזרה · ${esc(state.drill && state.drill.label ? state.drill.label : scopeWord(data.drill.kind))}`)
      back.onclick = () => { state.drill = null; renderBoard() }
      list.append(back)
    }
```

CSS:

```css
.scope-back {
  display: block; margin: 0 auto 8px; padding: 7px 14px; border: 0; border-radius: 999px;
  background: #2f3a26; color: #cfe6c8; font: 800 13px Arial, sans-serif; cursor: pointer;
}
.scope-back:active { transform: translateY(1px); }
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `node _rank-podium.mjs`
Expected: every `PASS` line, including `PASS drilldown`.

- [ ] **Step 5: Verify against the real server, not a stub**

With a token and the live prod API, open the עיר tab and tap the top city. Confirm real Hebrew names, real players, and that a tab change clears the drill.

- [ ] **Step 6: Commit**

```bash
cd /Users/adamleeperelman/Documents/pikeme/football-mock
git add public/clubs.js public/clubs.css _rank-podium.mjs
git commit -m "feat(rank): tapping a city/school/class opens its players"
```

---

## Self-review

**Spec coverage.** Spec §Football (`renderBoard` podium on all scopes, clickable entity rows, back affordance, `state.drill`) → Tasks 1, 2, 4. Spec §Contract 1 for football's own metrics → Task 3. Spec §Contract 3 → deleted in the spec, correctly absent here. Spec §Contracts 1–2 for the **cards** board, and all §App work, are **not in this plan** — they are slices 2 and 3, and each gets its own plan.

**Placeholders.** None: every code step carries the actual code, and `entityFilter`, `renderPodium`, `podiumId`, `MEDAL`, `KEY_ARITY` and `memberOf` are all defined here.

**Type consistency.** `renderPodium(rows, host, unit)` and `podiumId(r)` are used with those exact signatures in Tasks 1, 2 and 4. `entityFilter(kind, key)` returns a predicate over a stats doc, and Task 3 applies it as `memberOf(p.s || p)` — matching how `personalBoard` shapes its pool. Rows use `value` throughout, never `score` (the field was renamed in `7594afa`).

**Known gap, stated rather than hidden.** `personalBoard()`'s internals are read second-hand here; the `pool` edit in Task 3 Step 3 names the change but the implementer must confirm the local variable is called `players` and thread `pool` through every use. If it is shaped differently, keep the predicate at the same seam and say so in the commit.
