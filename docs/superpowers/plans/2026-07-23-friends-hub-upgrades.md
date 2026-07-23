# Friends & Hub Upgrades Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the hub power-slot labels on phone, surface friend presence + a Connected tab, and show each friend's real stats + top power cards in the list and a compact profile modal — backed by an enriched `pikme-server` friends API.

**Architecture:** `pikme-server` (CommonJS REST) enriches `GET /handle-friends` with cheap stats from local Mongo and adds `GET /handle-friends/:userId/cards` that fetches a friend's cards from the phone-keyed cards system (`cards.aleph-infinity.com/api/claims`), cached ~5 min. `football-mock` (ESM browser client + WS server) consumes these: a boot-time presence load drives a green bulb, a Connected tab filters online friends, `friendCardEl` always renders a stats row + 3 power slots (lazy-filled), and clicking a friend opens a compact modal. Pure card-ranking logic lives in `football-mock/shared/friend-cards.js` (client) and `pikme-server/routes-pikme/friend-cards.js` (server), each unit-tested.

**Tech Stack:** Node ≥18 (global `fetch`), Express, Mongoose, `ws`, vanilla ESM browser JS, node `assert` test scripts.

## Global Constraints

- Two repos: `pikme-server` (CommonJS, `require`) and `football-mock` (ESM, `import`; `package.json` `"type":"module"`). Do not mix module systems within a repo.
- pikme-server friend routes are all behind `authFootball` (`routes-pikme/friends.js:8`); `req.userId` is the caller's pikme userId (a Mongo ObjectId string).
- Cards API contract (verified in `saltiz-cards/web/app/api/claims/route.ts`): `GET https://cards.aleph-infinity.com/api/claims?identifier=<phone>&limit=<1-100>` → `{ recent: [{ rarity, card_number, card_worth, current_views, token }] }`. Phone-keyed, **no auth token**, edge-cached ~15s. `card_worth` is a numeric string or null.
- Rarity order (strongest→weakest): `legendary > epic > rare > common` (lowercase).
- Phone spellings vary in `UserInfo.phone` (`+972…`, `972…`, `0…`); use the existing `toE164()` / `phoneVariants()` helpers in `friends.js:12-26` when matching stats.
- Hebrew, RTL UI copy.
- Verification: pikme-server pure logic → `node test-*.js`; endpoints → extend `test-friends.js` (e2e, needs a running server + Mongo + `FOOTBALL_TOKEN_SECRET`). football-mock pure logic → `node test-*.mjs`; DOM/CSS → `node --check public/client.js` + a stated live/device check (the iOS Simulator viewport differs from a real phone).
- **Never push or deploy without explicit user confirmation.** Commits are local until then. pikme-server deploys to Render (`pikme-server.onrender.com`); football-mock deploys via `main` → Render.

---

## Phase A — pikme-server backend

### Task A1: Card parse + rank helper module

**Files:**
- Create: `pikme-server/routes-pikme/friend-cards.js`
- Test: `pikme-server/test-friend-cards.js`

**Interfaces:**
- Produces:
  - `parseClaims(claims) -> [{ r:string, n:number, c:number, w:number }]` — groups `claims.recent[]` by rarity+number, `c` = copy count, `w` = max finite `card_worth` (0 if none).
  - `rankTopCards(cards, n=3) -> [{ r:string, n:number }]` — sorts by rarity→copies→worth, returns top `n` (shape `{r,n}` only).
  - `fetchFriendCards(phone, {now, fetchImpl}={}) -> Promise<[{r,n,c,w}]>` — cached (5-min TTL) claims fetch; returns `[]` on any failure, never throws.
  - `RARITY_ORDER` — `{ legendary:3, epic:2, rare:1, common:0 }`.

- [ ] **Step 1: Write the failing test**

```javascript
// pikme-server/test-friend-cards.js
// Pure unit test — no server/Mongo. Run: node test-friend-cards.js
const assert = require('assert')
const { parseClaims, rankTopCards, fetchFriendCards } = require('./routes-pikme/friend-cards')

function run() {
  // parseClaims: groups copies, takes MAX finite worth, drops malformed rows
  const parsed = parseClaims({ recent: [
    { rarity: 'rare', card_number: 5, card_worth: '10' },
    { rarity: 'rare', card_number: 5, card_worth: '25' },
    { rarity: 'legendary', card_number: 1, card_worth: null },
    { rarity: null, card_number: 9, card_worth: '3' },
  ]})
  const rare5 = parsed.find((c) => c.r === 'rare' && c.n === 5)
  assert.strictEqual(parsed.length, 2, 'two valid slots')
  assert.strictEqual(rare5.c, 2, 'copies counted')
  assert.strictEqual(rare5.w, 25, 'max worth')

  // rankTopCards: rarity beats copies; shape is {r,n} only; caps at n
  const top = rankTopCards([{ r:'epic', n:1, c:9 }, { r:'legendary', n:2, c:1 }], 1)
  assert.strictEqual(top.length, 1)
  assert.deepStrictEqual(top[0], { r:'legendary', n:2 })

  // copies tie-break within a rarity, then worth
  assert.strictEqual(rankTopCards([{ r:'rare', n:1, c:1, w:5 }, { r:'rare', n:2, c:3, w:1 }], 1)[0].n, 2)
  assert.strictEqual(rankTopCards([{ r:'rare', n:1, c:2, w:5 }, { r:'rare', n:2, c:2, w:9 }], 1)[0].n, 2)
  assert.strictEqual(rankTopCards(null).length, 0, 'null-safe')

  // fetchFriendCards: caches within TTL, and swallows upstream failure → []
  let calls = 0
  const fakeFetch = async () => { calls++; return { ok: true, json: async () => ({ recent: [{ rarity:'common', card_number:3, card_worth:'1' }] }) } }
  return (async () => {
    const a = await fetchFriendCards('+972500000001', { fetchImpl: fakeFetch })
    await fetchFriendCards('+972500000001', { fetchImpl: fakeFetch })
    assert.strictEqual(calls, 1, 'second call served from cache')
    assert.strictEqual(a.length, 1)
    const c = await fetchFriendCards('+972500000009', { fetchImpl: async () => { throw new Error('down') } })
    assert.deepStrictEqual(c, [], 'failure → empty, no throw')
    console.log('PASS test-friend-cards')
  })()
}
run().catch((e) => { console.error('FAIL', e); process.exit(1) })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pikme-server && node test-friend-cards.js`
Expected: FAIL — `Cannot find module './routes-pikme/friend-cards'`.

- [ ] **Step 3: Write the implementation**

```javascript
// pikme-server/routes-pikme/friend-cards.js
// Parse a cards-system /api/claims response into compact per-slot cards, and rank a player's
// top cards the same way the game hub's "select best" does (rarity → copies → worth).
const RARITY_ORDER = { legendary: 3, epic: 2, rare: 1, common: 0 }

// claims.recent[] → [{ r, n, c, w }] (one row per owned rarity+number slot).
function parseClaims(claims) {
  const recent = Array.isArray(claims && claims.recent) ? claims.recent : []
  const bySlot = new Map()
  for (const cl of recent) {
    const r = cl && cl.rarity
    const n = cl && cl.card_number
    if (!r || n == null) continue
    const key = r + '_' + n
    const w = Number(cl.card_worth)
    const prev = bySlot.get(key) || { r, n: Number(n), c: 0, w: 0 }
    prev.c += 1
    if (Number.isFinite(w) && w > prev.w) prev.w = w
    bySlot.set(key, prev)
  }
  return [...bySlot.values()]
}

function rankTopCards(cards, n = 3) {
  const arr = Array.isArray(cards) ? cards.slice() : []
  arr.sort((a, b) =>
    ((RARITY_ORDER[b.r] ?? -1) - (RARITY_ORDER[a.r] ?? -1)) ||
    ((b.c || 0) - (a.c || 0)) ||
    ((b.w || 0) - (a.w || 0)),
  )
  return arr.slice(0, n).map((c) => ({ r: c.r, n: Number(c.n) }))
}

const CARDS_BASE = (process.env.SALTIZ_CARDS_BASE || 'https://cards.aleph-infinity.com').replace(/\/$/, '')
const TTL_MS = 5 * 60 * 1000
const _cache = new Map() // phone -> { at, cards }

// Fetch + cache a phone's cards from the cards system. Never throws; returns [] on any failure.
async function fetchFriendCards(phone, { now = Date.now, fetchImpl = fetch } = {}) {
  if (!phone) return []
  const hit = _cache.get(phone)
  if (hit && now() - hit.at < TTL_MS) return hit.cards
  let cards = []
  try {
    const res = await fetchImpl(`${CARDS_BASE}/api/claims?identifier=${encodeURIComponent(phone)}&limit=100`)
    if (res && res.ok) cards = parseClaims(await res.json())
  } catch (e) { console.log('[friend-cards] claims fetch failed:', e && e.message) }
  _cache.set(phone, { at: now(), cards })
  return cards
}

module.exports = { RARITY_ORDER, parseClaims, rankTopCards, fetchFriendCards }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pikme-server && node test-friend-cards.js`
Expected: `PASS test-friend-cards`, exit 0.

- [ ] **Step 5: Commit**

```bash
cd pikme-server
git add routes-pikme/friend-cards.js test-friend-cards.js
git commit -m "feat(friends): card parse + rank helper (parseClaims, rankTopCards, cached fetchFriendCards)"
```

---

### Task A2: Enrich `GET /handle-friends` with stats

**Files:**
- Modify: `pikme-server/routes-pikme/friends.js` (imports near `:1-7`; the `router.get('/', …)` handler at `:134-139`)
- Test: `pikme-server/test-friends.js` (extend the existing e2e flow)

**Interfaces:**
- Consumes: `toE164`, `phoneVariants` (`friends.js:12-26`), `FootballStats` (already imported `:6`).
- Produces: `GET /handle-friends` returns per friend `{ userId, nickName, image, xp, level, tier, wins, worth, owned }` (missing docs → `0`).

- [ ] **Step 1: Add the failing assertions to the e2e test**

In `pikme-server/test-friends.js`, inside `main()` after the two temp users `a` and `b` are created and made mutual friends (locate the existing friendship-establishing block), seed stats for `b` and assert the enriched shape. Add:

```javascript
  // --- A2: enrich GET /handle-friends ---
  const FootballStats = require('./data/footballstats')
  const PlayerCardStats = require('./data/playercardstats')
  await FootballStats.updateOne({ phone: b.phone },
    { $set: { phone: b.phone, xp: 4200, level: 7, tier: 2, wins: 5 } }, { upsert: true })
  await PlayerCardStats.updateOne({ phone: b.phone },
    { $set: { phone: b.phone, totalPoints: 1234, totalCards: 9 } }, { upsert: true })

  const friendsList = await (await fetch(`${BASE}/handle-friends`, { headers: { Authorization: `Bearer ${tokenA}` } })).json()
  const bRow = friendsList.find((f) => f.userId === String(b._id))
  assert.ok(bRow, 'B appears in A\'s friends')
  assert.strictEqual(bRow.xp, 4200, 'xp enriched')
  assert.strictEqual(bRow.level, 7, 'level enriched')
  assert.strictEqual(bRow.worth, 1234, 'worth from totalPoints')
  assert.strictEqual(bRow.owned, 9, 'owned from totalCards')
  console.log('PASS A2 enrich /handle-friends')
```

(Use the token variable name already established in the file for user A — shown here as `tokenA`. If the file names it differently, match it.)

- [ ] **Step 2: Run to verify it fails**

Precondition: server running locally (`node server.js`) with `FOOTBALL_TOKEN_SECRET` + Mongo.
Run: `cd pikme-server && node test-friends.js`
Expected: FAIL at `assert.strictEqual(bRow.xp, 4200)` — `bRow.xp` is `undefined` (endpoint not enriched yet).

- [ ] **Step 3: Add imports + `indexByE164` helper**

In `friends.js`, after line `:6` (`const FootballStats = …`) add:

```javascript
const PlayerCardStats = require('../data/playercardstats')
```

After the `phoneVariants` helper (`:26`) add:

```javascript
// Map stats docs (whose phone may be any stored spelling) back to canonical E.164 for lookup.
function indexByE164(docs) {
  const m = new Map()
  for (const d of docs) { const e = toE164(d.phone); if (e && !m.has(e)) m.set(e, d) }
  return m
}
```

- [ ] **Step 4: Replace the `GET /` handler**

Replace `friends.js:134-139` (the `router.get('/', …)` block) with:

```javascript
// GET /handle-friends — the caller's friends, enriched with cheap football + card stats
// (batched local lookups; NO external calls here — card art comes from /:userId/cards).
router.get('/', async (req, res) => {
  try {
    const me = await UserInfo.findById(req.userId).select('friends').lean()
    const ids = Object.keys(me?.friends || {})
    const users = await UserInfo.find({ _id: { $in: ids } }).select('nickName image phone').lean()
    const variants = []
    for (const u of users) for (const v of phoneVariants(toE164(u.phone))) variants.push(v)
    const [fstats, cstats] = await Promise.all([
      FootballStats.find({ phone: { $in: variants } }).select('phone xp level tier wins').lean(),
      PlayerCardStats.find({ phone: { $in: variants } }).select('phone totalPoints totalCards').lean(),
    ])
    const fBy = indexByE164(fstats)
    const cBy = indexByE164(cstats)
    return res.json(users.map((u) => {
      const e = toE164(u.phone)
      const f = fBy.get(e) || {}
      const c = cBy.get(e) || {}
      return {
        userId: String(u._id), nickName: u.nickName, image: u.image,
        xp: f.xp || 0, level: f.level || 0, tier: f.tier || 0, wins: f.wins || 0,
        worth: c.totalPoints || 0, owned: c.totalCards || 0,
      }
    }))
  } catch (err) {
    console.log(err)
    return res.status(500).send('Something went wrong')
  }
})
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd pikme-server && node test-friends.js`
Expected: `PASS A2 enrich /handle-friends` and the pre-existing assertions still pass.

- [ ] **Step 6: Commit**

```bash
cd pikme-server
git add routes-pikme/friends.js test-friends.js
git commit -m "feat(friends): enrich GET /handle-friends with xp/level/tier/wins/worth/owned"
```

---

### Task A3: `GET /handle-friends/:userId/cards`

**Files:**
- Modify: `pikme-server/routes-pikme/friends.js` (add route before `module.exports` at `:155`)
- Test: `pikme-server/test-friends.js` (extend)

**Interfaces:**
- Consumes: `rankTopCards`, `fetchFriendCards` (Task A1); `toE164` (`:12`).
- Produces: `GET /handle-friends/:userId/cards` → `{ cards: [{ r, n }] }` (top 6). `403` if `:userId` is not the caller's friend; `400` on a malformed id.

- [ ] **Step 1: Add failing assertions to the e2e test**

Append inside `main()` (after A2's block):

```javascript
  // --- A3: GET /handle-friends/:userId/cards ---
  const cardsRes = await fetch(`${BASE}/handle-friends/${b._id}/cards`, { headers: { Authorization: `Bearer ${tokenA}` } })
  assert.strictEqual(cardsRes.status, 200, 'friend cards 200')
  const cardsBody = await cardsRes.json()
  assert.ok(Array.isArray(cardsBody.cards), 'cards is an array')

  // A stranger (not a friend) is refused.
  const stranger = await UserInfo.create({ nickName: 'Str' + Math.floor(Math.random() * 999), image: 's.jpg', phone: '+000000003', otp: '0' })
  const strRes = await fetch(`${BASE}/handle-friends/${stranger._id}/cards`, { headers: { Authorization: `Bearer ${tokenA}` } })
  assert.strictEqual(strRes.status, 403, 'non-friend refused')
  await UserInfo.deleteOne({ _id: stranger._id })
  console.log('PASS A3 friend cards endpoint')
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd pikme-server && node test-friends.js`
Expected: FAIL — `cardsRes.status` is `404` (route missing).

- [ ] **Step 3: Add the imports + route**

After the `FootballStats`/`PlayerCardStats` imports at the top of `friends.js` add:

```javascript
const { rankTopCards, fetchFriendCards } = require('./friend-cards')
```

Immediately before `module.exports = router` (`friends.js:155`) add:

```javascript
// GET /handle-friends/:userId/cards — a friend's TOP cards for the list slots + profile modal.
// Friend-gated (no arbitrary user scraping); resolved by phone against the cards system and
// cached ~5 min in fetchFriendCards. Degrades to { cards: [] } if the cards system is unreachable.
router.get('/:userId/cards', async (req, res) => {
  try {
    const other = req.params.userId
    if (!mongoose.isValidObjectId(other)) return res.status(400).send('bad id')
    const me = await UserInfo.findById(req.userId).select('friends').lean()
    if (!me?.friends?.[other]) return res.status(403).send('not a friend')
    const u = await UserInfo.findById(other).select('phone').lean()
    const cards = await fetchFriendCards(toE164(u?.phone))
    return res.json({ cards: rankTopCards(cards, 6) })
  } catch (err) {
    console.log(err)
    return res.status(500).send('Something went wrong')
  }
})
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd pikme-server && node test-friends.js`
Expected: `PASS A3 friend cards endpoint` plus all earlier assertions pass.

- [ ] **Step 5: Commit**

```bash
cd pikme-server
git add routes-pikme/friends.js test-friends.js
git commit -m "feat(friends): add friend-gated GET /handle-friends/:userId/cards"
```

---

## Phase B — football-mock client

> All Phase B commits happen on a football-mock feature branch. Create it first:
> `cd football-mock && git checkout feat/friends-hub-upgrades` (the branch already exists from the design commit; if not, `git checkout -b feat/friends-hub-upgrades`).

### Task B1: Fix hub power-slot label on phone (#1)

**Files:**
- Modify: `football-mock/public/style.css` (after the `@media (max-height: 400px)` block ending near `:1202`)

**Interfaces:** none (CSS only).

- [ ] **Step 1: Add the override rule**

Immediately after the closing `}` of the `@media (max-height: 400px) { … }` block (the one containing `.pslot-cap { display: none; }`, ends ~`:1202`), add:

```css
/* The short-landscape rule above blanks .pslot-cap, but the game runs LANDSCAPE and a real
   phone's WebView is < 400px tall — which wrongly hid the hub's power-slot labels. Keep them
   for the hub's absolutely-positioned slot overlay (#power-slots); the in-match loadout column
   stays label-less as intended. */
@media (max-height: 400px) { #power-slots .pslot-cap { display: block; } }
```

- [ ] **Step 2: Verify the rule is present and well-formed**

Run: `cd football-mock && grep -n "#power-slots .pslot-cap { display: block" public/style.css`
Expected: one match. Confirm no unbalanced braces: `node -e "const c=require('fs').readFileSync('public/style.css','utf8');const o=(c.match(/{/g)||[]).length,cl=(c.match(/}/g)||[]).length;console.log(o===cl?'braces balanced':'MISMATCH '+o+'/'+cl)"` → `braces balanced`.

- [ ] **Step 3: Commit**

```bash
cd football-mock
git add public/style.css
git commit -m "fix(hub): keep power-slot labels visible on landscape phones (#power-slots .pslot-cap)"
```

- [ ] **Step 4: Live/device verification (record result, do not skip)**

Deferred to the shared Phase-B verification at the end (needs a device/TestFlight because the Simulator viewport differs). Note in the task tracker that B1 is **pending device confirmation**: the hub must show בעיטה / מהירות / הגנה under the three power slots on a physical iPhone.

---

### Task B2: Green presence bulb on the friends button (#2)

**Files:**
- Modify: `football-mock/public/index.html` (`#friends-btn` at `:56`)
- Modify: `football-mock/public/style.css` (near `.hub-sat` rules)
- Modify: `football-mock/public/client.js` (`ws.onopen` `:2256`; `friendsPresence` handler `:2352-2353`)

**Interfaces:**
- Consumes: `ONLINE` set (`client.js:1825`), `loadFriends()` (`:1841`).
- Produces: `updateFriendsDot()` — toggles `#friends-dot` hidden by `ONLINE.size`.

- [ ] **Step 1: Add the dot element**

In `index.html:56`, change `#friends-btn` to include a dot span:

```html
<button id="friends-btn" class="hub-sat"><span class="hub-sat-ic">👥</span><b>חברים</b><i id="friends-dot" class="hub-sat-dot hidden"></i></button>
```

- [ ] **Step 2: Style the dot**

In `style.css`, find the `.hub-sat {` rule and ensure it is a positioning context, then add the dot styles. Add near the other `.hub-sat` rules:

```css
.hub-sat { position: relative; }
.hub-sat-dot { position: absolute; top: 5px; right: 5px; width: 10px; height: 10px; border-radius: 50%; background: #25e06a; box-shadow: 0 0 6px #25e06a, 0 0 0 2px #0b120d; }
.hub-sat-dot.hidden { display: none; }
```

(If `.hub-sat` already declares `position`, keep the existing one and drop the first line here.)

- [ ] **Step 3: Add `updateFriendsDot()` and wire it into presence + boot**

In `client.js`, add the helper next to `loadFriends` (after `:1857`):

```javascript
// Green bulb on the hub friends button whenever at least one friend is online.
function updateFriendsDot() {
  const d = document.getElementById('friends-dot');
  if (d) d.classList.toggle('hidden', ONLINE.size === 0);
}
```

In the `friendsPresence` handler at `:2352-2353`, after `ONLINE = new Set(msg.online || []);` add:

```javascript
      updateFriendsDot();
```

In `ws.onopen` (`:2256`), after the existing open-time setup, add a one-time friends/presence load so the bulb works without opening the panel:

```javascript
    loadFriends(); // register friends → server replies friendsPresence → bulb reflects online friends
```

- [ ] **Step 4: Syntax check**

Run: `cd football-mock && node --check public/client.js`
Expected: no output (exit 0).

- [ ] **Step 5: Commit**

```bash
cd football-mock
git add public/index.html public/style.css public/client.js
git commit -m "feat(hub): green presence bulb on friends button; load presence on boot"
```

---

### Task B3: "Connected" tab in the friends page (#3)

**Files:**
- Modify: `football-mock/public/index.html` (`.fr-tabs` `:371-375`; panes `:377-386`)
- Modify: `football-mock/public/client.js` (`setFriendsTab` `:1665-1669`; add `renderOnlineFriends`)

**Interfaces:**
- Consumes: `FRIENDS`, `ONLINE`, `friendCardEl` (`:1912`), `listMsg`.
- Produces: `renderOnlineFriends()` — fills `#friend-online` with online friends only.

- [ ] **Step 1: Add the tab button + pane**

In `index.html`, add a tab button after the `list` tab (`:372`):

```html
          <button class="fr-tab" data-tab="online">מחוברים<span id="fr-online-badge" class="fr-badge hidden">0</span></button>
```

Add a matching pane alongside the other `.fr-pane`s (after `#friend-list`'s pane, near `:378`). Match the existing pane wrapper markup — each pane is a `.fr-pane[data-pane=…]`. Add:

```html
        <div class="fr-pane hidden" data-pane="online"><div id="friend-online" class="friend-list"></div></div>
```

(Confirm the exact wrapper by looking at the `list` pane; mirror its classes/attributes, only changing `data-pane` to `online` and the inner id to `friend-online`.)

- [ ] **Step 2: Render online friends + badge on tab switch**

In `client.js`, add after `renderFriends` (`:1948`):

```javascript
// Connected tab: only friends currently online (bots count as always-online, matching friendCardEl).
function renderOnlineFriends() {
  const el = document.getElementById('friend-online');
  if (!el) return;
  const online = FRIENDS.filter((f) => ONLINE.has(f.userId) || f.isBot);
  const badge = document.getElementById('fr-online-badge');
  if (badge) { badge.textContent = String(online.length); badge.classList.toggle('hidden', online.length === 0); }
  if (!online.length) { listMsg('friend-online', 'אף חבר לא מחובר כרגע'); return; }
  el.innerHTML = '';
  online.forEach((f) => el.appendChild(friendCardEl(f)));
}
```

In `setFriendsTab` (`:1665-1669`), before the closing `}` add:

```javascript
  if (tab === 'online') renderOnlineFriends();
```

Also refresh the badge live: in the `friendsPresence` handler (right after the `updateFriendsDot();` added in B2) add:

```javascript
      if (!document.getElementById('friends')?.classList.contains('hidden')) renderOnlineFriends();
```

- [ ] **Step 3: Syntax check**

Run: `cd football-mock && node --check public/client.js`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
cd football-mock
git add public/index.html public/client.js
git commit -m "feat(friends): add Connected tab (online friends only) with live count badge"
```

---

### Task B4: Friend stats row + power slots in the list (#4)

**Files:**
- Create: `football-mock/shared/friend-cards.js`
- Test: `football-mock/test-friend-util.mjs`
- Modify: `football-mock/public/client.js` (`import` block near `:9-14`; `friendCardEl` `:1912-1940`)
- Modify: `football-mock/public/style.css` (friend-card slot styles)

**Interfaces:**
- Produces (shared module): `rankTopCards(cards, n=3) -> [{r,n}]`, `RARITY_ORDER`.
- Consumes: `CARD_ART_BASE` (`client.js`, used at `:1935`), `fmtCompact`, `ONLINE`, `apiGet`.
- Produces (client): `fillFriendSlots(container, userId, inlineCards)` — lazy-loads + renders 3 slots; `friendCardsCache` Map.

- [ ] **Step 1: Write the failing shared-logic test**

```javascript
// football-mock/test-friend-util.mjs — run: node test-friend-util.mjs
import { rankTopCards, RARITY_ORDER } from './shared/friend-cards.js';

let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };

ok(RARITY_ORDER.legendary > RARITY_ORDER.epic, 'rarity order');
ok(rankTopCards([{ r:'epic', n:1, c:9 }, { r:'legendary', n:2, c:1 }], 1)[0].n === 2, 'rarity beats copies');
ok(rankTopCards([{ r:'rare', n:1, c:1, w:5 }, { r:'rare', n:2, c:3, w:1 }], 1)[0].n === 2, 'copies tie-break');
ok(rankTopCards([{ r:'rare', n:1, c:2, w:5 }, { r:'rare', n:2, c:2, w:9 }], 1)[0].n === 2, 'worth tie-break');
ok(rankTopCards([{ r:'common', n:1 }, { r:'common', n:2 }, { r:'common', n:3 }, { r:'common', n:4 }], 3).length === 3, 'caps at n');
ok(JSON.stringify(rankTopCards([{ r:'rare', n:'7', c:1 }], 1)[0]) === JSON.stringify({ r:'rare', n:7 }), 'shape {r,n} numeric n');
ok(rankTopCards(null).length === 0, 'null-safe');

process.exit(fails ? 1 : 0);
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd football-mock && node test-friend-util.mjs`
Expected: FAIL — `Cannot find module './shared/friend-cards.js'`.

- [ ] **Step 3: Create the shared module**

```javascript
// football-mock/shared/friend-cards.js
// Rank a friend's owned cards exactly like the hub "select best" (rarity → copies → worth).
// Pure + DOM-free so it is unit-testable and shared by the client's friend UI.
export const RARITY_ORDER = { legendary: 3, epic: 2, rare: 1, common: 0 };

export function rankTopCards(cards, n = 3) {
  const arr = Array.isArray(cards) ? cards.filter((c) => c && c.r != null && c.n != null) : [];
  arr.sort((a, b) =>
    ((RARITY_ORDER[b.r] ?? -1) - (RARITY_ORDER[a.r] ?? -1)) ||
    ((b.c || 0) - (a.c || 0)) ||
    ((b.w || 0) - (a.w || 0)),
  );
  return arr.slice(0, n).map((c) => ({ r: c.r, n: +c.n }));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd football-mock && node test-friend-util.mjs`
Expected: all `PASS`, exit 0.

- [ ] **Step 5: Import the helper + add lazy slot filler in client.js**

Add to the client's import block (after `:11`, alongside the other `/shared/*` imports):

```javascript
import { rankTopCards as rankFriendTop } from '/shared/friend-cards.js';
```

Add near `friendCardEl` (before it, ~`:1911`):

```javascript
const friendCardsCache = new Map(); // userId -> [{r,n}] top cards (lazy, per session)

// Render 3 power slots into `container`: filled with top-3 art, empty = dashed placeholder.
function paintFriendSlots(container, cards) {
  container.innerHTML = '';
  const top = rankFriendTop(cards, 3);
  for (let i = 0; i < 3; i++) {
    const c = top[i];
    const slot = document.createElement('div');
    slot.className = 'fc-slot' + (c ? ' rarity-' + c.r : ' fc-slot-empty');
    if (c) {
      const im = document.createElement('img'); im.className = 'fc-slot-art'; im.loading = 'lazy'; im.alt = '';
      im.onerror = () => im.removeAttribute('src'); im.src = `${CARD_ART_BASE}/${c.r}/${c.n}.webp`;
      slot.appendChild(im);
    }
    container.appendChild(slot);
  }
}

// Fill a friend's slots: bots/inline cards render immediately; real friends lazy-fetch (cached).
function fillFriendSlots(container, f) {
  const inline = Array.isArray(f.cards) ? f.cards : null;
  if (inline) { paintFriendSlots(container, inline); return; }
  const cached = friendCardsCache.get(f.userId);
  if (cached) { paintFriendSlots(container, cached); return; }
  paintFriendSlots(container, []); // placeholders while loading
  if (!f.userId || !FOOTBALL_TOKEN) return;
  apiGet(`/handle-friends/${f.userId}/cards`).then((res) => {
    const cards = res && Array.isArray(res.cards) ? res.cards : [];
    friendCardsCache.set(f.userId, cards);
    if (container.isConnected) paintFriendSlots(container, cards);
  });
}
```

- [ ] **Step 6: Rewrite `friendCardEl` to always show stats + slots**

Replace `friendCardEl` (`:1912-1940`) with:

```javascript
// Rich friend card: profile pic, name, presence, always-present stats row + 3 power slots.
function friendCardEl(f) {
  const online = ONLINE.has(f.userId) || !!f.isBot;
  const div = document.createElement('div');
  div.className = 'friend-card' + (online ? ' online' : '') + (f.isBot ? ' is-bot' : '');
  const pfp = document.createElement('div'); pfp.className = 'fc-pfp';
  const img = (f.image || '').toString();
  if (/^https?:\/\//i.test(img)) { const im = document.createElement('img'); im.src = img; im.alt = ''; pfp.appendChild(im); }
  else { pfp.textContent = memberInitials(f.nickName); if (f.color) pfp.style.background = f.color; }
  const main = document.createElement('div'); main.className = 'fc-main';
  const top = document.createElement('div'); top.className = 'fc-top';
  const dot = document.createElement('span'); dot.className = 'friend-dot';
  const nm = document.createElement('span'); nm.className = 'fc-name'; nm.textContent = f.nickName || '';
  top.append(dot, nm);
  if (f.isBot) { const t = document.createElement('span'); t.className = 'friend-bot-tag'; t.textContent = '🤖'; top.appendChild(t); }
  main.appendChild(top);
  // Stats row — always shown, zeros when unknown.
  const meta = document.createElement('div'); meta.className = 'fc-meta';
  meta.textContent = ['דרגה ' + (f.level || 0), 'XP ' + fmtCompact(f.xp || 0), 'שווי ' + fmtCompact(f.worth || 0), 'קלפים ' + (f.owned || 0)].join(' · ');
  main.appendChild(meta);
  // Power slots — always 3; filled with top cards (inline for bots, lazy-fetched for real friends).
  const slots = document.createElement('div'); slots.className = 'fc-slots';
  main.appendChild(slots);
  fillFriendSlots(slots, f);
  div.append(pfp, main);
  div.addEventListener('click', () => openFriendProfile(f)); // #5
  return div;
}
```

- [ ] **Step 7: Add friend-card slot styles**

In `style.css`, near the existing `.fc-cards`/`.fc-card` rules, add:

```css
.fc-slots { display: flex; gap: 6px; margin-top: 6px; }
.fc-slot { position: relative; width: 40px; height: 52px; border-radius: 7px; border: 2px solid #4a5a4c; background: #16211a; overflow: hidden; }
.fc-slot-empty { border-style: dashed; opacity: .8; }
.fc-slot-art { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; image-rendering: pixelated; }
.fc-slot.rarity-legendary { border-color: #ffb800; }
.fc-slot.rarity-epic { border-color: #b46bff; }
.fc-slot.rarity-rare { border-color: #4ea0ff; }
.fc-slot.rarity-common { border-color: #9ab0c5; }
```

- [ ] **Step 8: Syntax check (note: `openFriendProfile` is defined in Task B5)**

Run: `cd football-mock && node --check public/client.js`
Expected: exit 0 (a reference to the not-yet-defined `openFriendProfile` is fine — it is resolved at call time, and B5 lands before any live test).

- [ ] **Step 9: Commit**

```bash
cd football-mock
git add shared/friend-cards.js test-friend-util.mjs public/client.js public/style.css
git commit -m "feat(friends): always-on stats row + lazy top-card power slots in friend list"
```

---

### Task B5: Compact friend profile modal (#5)

**Files:**
- Modify: `football-mock/public/index.html` (add the modal near the other overlays, e.g. after the friends screen `:391`)
- Modify: `football-mock/public/client.js` (add `openFriendProfile` / `closeFriendProfile`)
- Modify: `football-mock/public/style.css` (modal styles)

**Interfaces:**
- Consumes: `friendCardsCache`, `paintFriendSlots`, `fillFriendSlots`, `fmtCompact`, `rankTierFromLevel`, `ONLINE`, `memberInitials`.
- Produces: `openFriendProfile(f)`, `closeFriendProfile()`.

- [ ] **Step 1: Add the modal markup**

In `index.html`, after the `#friends` screen block (`:391`), add:

```html
  <div id="friend-profile-modal" class="fp-modal hidden">
    <div class="fp-card">
      <button id="fp-close" class="fp-close" aria-label="close">✕</button>
      <div class="fp-hero"><div id="fp-pfp" class="fp-pfp"></div><div id="fp-online" class="fp-online hidden">מחובר</div></div>
      <div id="fp-name" class="fp-name"></div>
      <div id="fp-div" class="fp-div"></div>
      <div id="fp-slots" class="fc-slots fp-slots"></div>
      <div id="fp-stats" class="fp-stats"></div>
    </div>
  </div>
```

- [ ] **Step 2: Add open/close logic**

In `client.js`, add near `friendCardEl` (after Task B4's helpers):

```javascript
// Compact friend profile modal (#5): hero avatar, top power cards, division + XP/worth/owned.
function openFriendProfile(f) {
  const modal = document.getElementById('friend-profile-modal'); if (!modal) return;
  const pfp = document.getElementById('fp-pfp'); pfp.innerHTML = ''; pfp.style.background = '';
  const img = (f.image || '').toString();
  if (/^https?:\/\//i.test(img)) { const im = document.createElement('img'); im.src = img; im.alt = ''; pfp.appendChild(im); }
  else { pfp.textContent = memberInitials(f.nickName); if (f.color) pfp.style.background = f.color; }
  document.getElementById('fp-online').classList.toggle('hidden', !(ONLINE.has(f.userId) || f.isBot));
  document.getElementById('fp-name').textContent = f.nickName || '';
  const { tier, sub } = rankTierFromLevel(f.level || 0);
  document.getElementById('fp-div').textContent = `${tier.ic} ${tier.label} ${sub}`;
  document.getElementById('fp-stats').textContent = ['XP ' + fmtCompact(f.xp || 0), 'שווי ' + fmtCompact(f.worth || 0), 'קלפים ' + (f.owned || 0)].join(' · ');
  fillFriendSlots(document.getElementById('fp-slots'), f); // reuses the shared cache from B4
  modal.classList.remove('hidden');
}
function closeFriendProfile() { document.getElementById('friend-profile-modal')?.classList.add('hidden'); }
document.getElementById('fp-close')?.addEventListener('click', closeFriendProfile);
document.getElementById('friend-profile-modal')?.addEventListener('click', (e) => { if (e.target.id === 'friend-profile-modal') closeFriendProfile(); });
```

- [ ] **Step 3: Add modal styles**

In `style.css` add:

```css
.fp-modal { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center; background: rgba(3,6,4,.72); }
.fp-modal.hidden { display: none; }
.fp-card { position: relative; width: min(88vw, 340px); background: #16211a; border: 3px solid #3a4a3c; border-radius: 14px; padding: 18px 16px; text-align: center; box-shadow: 0 10px 30px rgba(0,0,0,.5); }
.fp-close { position: absolute; top: 8px; left: 8px; width: 30px; height: 30px; border-radius: 50%; background: #2c3a2e; color: #e7dcae; border: 2px solid #4a5a4c; font-weight: 900; cursor: pointer; }
.fp-hero { display: flex; flex-direction: column; align-items: center; gap: 6px; }
.fp-pfp { width: 72px; height: 72px; border-radius: 50%; overflow: hidden; background: #2c3a2e; display: flex; align-items: center; justify-content: center; font: 900 26px "Arial Black", sans-serif; color: #e7dcae; }
.fp-pfp img { width: 100%; height: 100%; object-fit: cover; }
.fp-online { font: 900 10px "Arial Black", sans-serif; color: #25e06a; }
.fp-name { font: 900 18px "Arial Black", sans-serif; color: #f2ecd0; margin-top: 8px; }
.fp-div { font: 900 12px "Arial Black", sans-serif; color: #b9c7ab; margin-top: 2px; }
.fp-slots { justify-content: center; margin: 12px 0; }
.fp-stats { font: 900 11px "Arial Black", sans-serif; color: #9fb0a2; }
```

- [ ] **Step 4: Syntax check**

Run: `cd football-mock && node --check public/client.js`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
cd football-mock
git add public/index.html public/client.js public/style.css
git commit -m "feat(friends): compact friend profile modal (hero, top cards, division, stats)"
```

---

## Final verification (Phase B live + rollout)

- [ ] **Local live check (football-mock):** `cd football-mock && node server.js`, open `http://localhost:3011` (or the configured port) in a browser. On the hub, confirm three power-slot labels render. Open Friends → tabs `החברים שלי / מחוברים / בקשות / הוסף` all switch. Each friend card shows a stats row + 3 slots. Click a friend → modal opens with avatar, division, slots, stats; ✕ and backdrop close it.
- [ ] **Presence check:** connect a second client (second browser/account that is a mutual friend); confirm the green bulb appears on the friends button and the Connected tab lists that friend, and both clear when it disconnects.
- [ ] **Backend integration check:** point the running football-mock at a pikme-server with the enriched endpoints (or run pikme-server locally) and confirm a real friend shows non-zero stats and, if they own cards, art fills the slots.
- [ ] **#1 device confirmation (required):** build to TestFlight/device and confirm the hub power-slot labels are visible on a physical iPhone (the Simulator viewport differs).
- [ ] **Rollout (only after user confirmation):** deploy pikme-server to Render; merge football-mock `feat/friends-hub-upgrades` → `main` for the football Render deploy. Confirm with the user before each deploy.

---

## Self-review notes

- **Spec coverage:** #1 → B1; #2 → B2; #3 → B3; #4 → A1/A2/A3 + B4; #5 → B5 (+ shared A-phase data). Backend enrichment (spec "Backend enrichment") → A2 (stats) + A3 (cards). Empty/zero states → B4 stats defaults + `fc-slot-empty`. "top cards like select best" → `rankTopCards` (rarity→copies→worth), matching hub `rankForLoadout`.
- **Type consistency:** `rankTopCards(cards, n)` returns `{r,n}` in both repos; friend list rows carry `{userId,nickName,image,xp,level,tier,wins,worth,owned}`; `/cards` returns `{cards:[{r,n}]}`. `friendCardsCache`, `paintFriendSlots`, `fillFriendSlots`, `openFriendProfile` names are used consistently across B4/B5.
- **Cross-repo duplication:** the tiny ranking function is intentionally duplicated (CommonJS server vs ESM client, separate repos) — each is unit-tested.
