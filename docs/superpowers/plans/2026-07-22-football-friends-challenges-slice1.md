# Football Friends & Challenges — Slice 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a logged-in Pikme user add friends by nickname and challenge an
online friend into a live 2v2 football match, end-to-end.

**Architecture:** Persistent social graph (friend requests + friends map) lives in
`pikme-server`/Mongo. Realtime presence + the challenge handshake live in the
football server (`football-mock`), which learns each connection's Pikme `userId`
from a signed **football-token**. That same token authenticates the friends REST
calls the football client makes to pikme-server, so the master auth key never
leaves pikme-server.

**Tech Stack:** Node ≥18, Express + Mongoose + `jsonwebtoken` (pikme-server);
`ws` + `jsonwebtoken` (football-mock, ESM). No new frameworks.

## Global Constraints

- **Single credential:** a JWT signed with `process.env.FOOTBALL_TOKEN_SECRET`,
  payload `{ id, nickName, image }`, `expiresIn: '12h'`. The same env var value MUST
  be set in BOTH pikme-server and football-mock.
- **Fail closed, play open:** if `FOOTBALL_TOKEN_SECRET` is unset or a token is
  invalid, the football server MUST NOT authenticate the connection (it stays a
  guest, `userId = null`) but MUST still allow guest play (Quick Match/training).
- **nickName is 3–12 chars** (per `UserInfo` schema `minlength: 3`) and **not
  unique** — search returns up to 10 matches; the UI disambiguates by image/userId.
- **CommonJS in pikme-server, ESM in football-mock.** Match each repo's module style.
- **UI copy is Hebrew / RTL** (matches the existing football client).
- **Reuse existing patterns:** Mongoose models in `data/`, routers in `routes-pikme/`,
  auth middlewares in `middlewares/auth.js`, football rooms via `makeRoom`/`addToRoom`/
  `startCountdown`.
- Repo paths below are relative to each repo root: `pikme-server/` and
  `football-mock/` (siblings under `/Users/adamleeperelman/Documents/pikeme/`).

---

## File Structure

**pikme-server (social graph + token issuance):**
- Create `data/friendrequest.js` — `FriendRequest` Mongoose model.
- Modify `data/userinfo.js` — add `friends` map field.
- Modify `middlewares/auth.js` — add `authFootball` middleware.
- Modify `routes-pikme/user.js` — add `GET /handle-user/football-token`.
- Create `routes-pikme/friends.js` — friends REST router.
- Modify `app.js` — mount `/handle-friends`, allow the football origin in CORS.
- Create `test-friends.js` — integration test (seeds two temp users, runs flow).

**football-mock (identity + presence + challenge):**
- Modify `package.json` — add `jsonwebtoken` dependency.
- Create `shared/football-auth.js` — `verifyFootballToken(token, secret)`.
- Modify `server.js` — authenticate `join`; `onlineByUser`; `setFriends`/
  `friendsPresence`; `challenge`/`challengeRespond` → private room + countdown.
- Modify `public/index.html`, `public/client.js`, `public/style.css` — Friends panel
  (search, requests, list w/ online dots, Challenge button, incoming-challenge modal).
- Create `test-football-auth.mjs` — unit test for token verify.
- Create `test-challenge.mjs` — WS integration test (presence + challenge flow).

---

## Task 1: Football-token issuance + verification (pikme-server)

**Files:**
- Modify: `pikme-server/middlewares/auth.js`
- Modify: `pikme-server/routes-pikme/user.js` (add one route + ensure `auth` import)
- Test: `pikme-server/test-football-token.js`

**Interfaces:**
- Produces: `authFootball(req,res,next)` — verifies `req.headers['football-auth']`
  with `FOOTBALL_TOKEN_SECRET`, sets `req.userId = decoded.id` and
  `req.footballUser = decoded`. Exported from `middlewares/auth.js`.
- Produces: `GET /handle-user/football-token` (behind existing `auth`) →
  `{ token }` where token payload is `{ id, nickName, image }`.

- [ ] **Step 1: Write the failing test** — `pikme-server/test-football-token.js`

```js
// Pure sign→verify roundtrip for the football-token, exercised through the same
// jwt secret the middleware uses. No DB / no server needed.
const assert = require('assert')
const jwt = require('jsonwebtoken')
process.env.FOOTBALL_TOKEN_SECRET = 'test-secret-123'

// The middleware reads process.env at call time.
const { authFootball } = require('./middlewares/auth')

function run(headerToken) {
  return new Promise((resolve) => {
    const req = { headers: headerToken ? { 'football-auth': headerToken } : {}, body: {} }
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this }, json() { resolve({ code: this.statusCode, req }) }, send() { resolve({ code: this.statusCode, req }) } }
    authFootball(req, res, () => resolve({ code: 200, req }))
  })
}

;(async () => {
  const good = jwt.sign({ id: 'u1', nickName: 'Adam', image: 'x.jpg' }, 'test-secret-123', { expiresIn: '12h' })
  let r = await run(good)
  assert.strictEqual(r.code, 200, 'valid token passes')
  assert.strictEqual(r.req.userId, 'u1', 'sets req.userId')
  assert.strictEqual(r.req.footballUser.nickName, 'Adam', 'sets footballUser')

  r = await run('garbage.token.here')
  assert.strictEqual(r.code, 403, 'invalid token → 403')

  r = await run(undefined)
  assert.strictEqual(r.code, 401, 'missing token → 401')

  console.log('✅ football-token middleware PASS')
})().catch((e) => { console.error('❌', e.message); process.exit(1) })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pikme-server && node test-football-token.js`
Expected: FAIL — `authFootball is not a function` (not yet exported).

- [ ] **Step 3: Add `authFootball` to `middlewares/auth.js`**

Insert after `authNonBlock` (keep the existing `const jwt = require('jsonwebtoken')` at top):

```js
function authFootball(req, res, next) {
    const token = req.headers['football-auth'] || req.body.footballAuth
    if (!token) return res.status(401).json({ message: 'No football token' })
    jwt.verify(token, process.env.FOOTBALL_TOKEN_SECRET, (err, decoded) => {
        if (err) return res.status(403).json({ message: 'Invalid football token' })
        req.userId = decoded.id
        req.footballUser = decoded
        next()
    })
}
```

Add `authFootball` to `module.exports`:

```js
module.exports = {
    auth,
    authCreator,
    authNonBlock,
    authFootball,
    requireAdmin
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pikme-server && node test-football-token.js`
Expected: PASS — `✅ football-token middleware PASS`

- [ ] **Step 5: Add the token-issuance route to `routes-pikme/user.js`**

At the top of `routes-pikme/user.js`, ensure `auth` is imported (the file already
requires from `../middlewares/auth`; add `auth` to that destructure if missing):

```js
const { auth, authNonBlock } = require('../middlewares/auth')
```

Add this route (near the other `/handle-user` GETs, e.g. after `card-stats`):

```js
// Mint a short-lived football-token the app injects into the game WebView.
// Behind the normal auth cookie — only the logged-in user can mint their own.
router.get('/football-token', auth, async (req, res) => {
    try {
        if (!process.env.FOOTBALL_TOKEN_SECRET) return res.status(500).send('football disabled')
        const user = await UserInfo.findById(req.userId).select('nickName image').lean()
        if (!user) return res.status(404).send('no user')
        const token = jwt.sign(
            { id: String(req.userId), nickName: user.nickName, image: user.image },
            process.env.FOOTBALL_TOKEN_SECRET,
            { expiresIn: '12h' }
        )
        return res.json({ token })
    } catch (e) { return res.status(500).send('error') }
})
```

(`jwt` and `UserInfo` are already required in `user.js`. If `jwt` is not, add
`const jwt = require('jsonwebtoken')` at the top.)

- [ ] **Step 6: Manually verify the route wiring compiles**

Run: `cd pikme-server && node -e "require('./routes-pikme/user.js'); console.log('user.js loads OK')"`
Expected: `user.js loads OK` (no throw).

- [ ] **Step 7: Commit**

```bash
cd pikme-server
git add middlewares/auth.js routes-pikme/user.js test-football-token.js
git commit -m "feat(football): football-token issuance + authFootball middleware"
```

---

## Task 2: FriendRequest model + UserInfo.friends field (pikme-server)

**Files:**
- Create: `pikme-server/data/friendrequest.js`
- Modify: `pikme-server/data/userinfo.js`
- Test: `pikme-server/test-friendrequest-model.js`

**Interfaces:**
- Produces: `FriendRequest` model with `{ fromUserId, toUserId, status, channel,
  createdAt }` and a unique compound index on `(fromUserId, toUserId)`.
- Produces: `UserInfo.friends` — an Object map `{ [friendUserId]: true }`, default `{}`.

- [ ] **Step 1: Write the failing test** — `pikme-server/test-friendrequest-model.js`

```js
// Model-shape test: no DB connection, just the schema/paths/index definition.
const assert = require('assert')
const FriendRequest = require('./data/friendrequest')
const UserInfo = require('./data/userinfo')

const paths = FriendRequest.schema.paths
assert.ok(paths.fromUserId && paths.toUserId && paths.status && paths.channel && paths.createdAt, 'FriendRequest has all fields')
assert.strictEqual(paths.status.enumValues.includes('pending'), true, 'status enum has pending')

const idx = FriendRequest.schema.indexes().find(([keys]) => keys.fromUserId === 1 && keys.toUserId === 1)
assert.ok(idx && idx[1] && idx[1].unique === true, 'unique (fromUserId,toUserId) index exists')

assert.ok(UserInfo.schema.paths.friends, 'UserInfo has friends path')
console.log('✅ friend models PASS')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pikme-server && node test-friendrequest-model.js`
Expected: FAIL — `Cannot find module './data/friendrequest'`.

- [ ] **Step 3: Create `pikme-server/data/friendrequest.js`**

```js
const mongoose = require('mongoose')
const Schema = mongoose.Schema

const FriendRequestSchema = new Schema({
    fromUserId: { type: String, required: true, index: true },
    toUserId: { type: String, required: true, index: true },
    status: { type: String, required: true, enum: ['pending', 'accepted', 'declined'], default: 'pending' },
    channel: { type: String, required: true, default: 'nickname' },
    createdAt: { type: Date, required: true, default: Date.now },
})

// One live request per direction; upserts are idempotent against this.
FriendRequestSchema.index({ fromUserId: 1, toUserId: 1 }, { unique: true })

module.exports = mongoose.model('FriendRequest', FriendRequestSchema)
```

- [ ] **Step 4: Add `friends` to `pikme-server/data/userinfo.js`**

Insert next to the existing `blockList` field (mirrors its shape):

```js
    friends: {
        type: Object,
        required: true,
        default: {}
    },
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd pikme-server && node test-friendrequest-model.js`
Expected: PASS — `✅ friend models PASS`

- [ ] **Step 6: Commit**

```bash
cd pikme-server
git add data/friendrequest.js data/userinfo.js test-friendrequest-model.js
git commit -m "feat(football): FriendRequest model + UserInfo.friends map"
```

---

## Task 3: Friends REST router + CORS (pikme-server)

**Files:**
- Create: `pikme-server/routes-pikme/friends.js`
- Modify: `pikme-server/app.js`
- Test: `pikme-server/test-friends.js` (integration; requires the dev Mongo the
  server already connects to)

**Interfaces:**
- Consumes: `authFootball` (Task 1), `FriendRequest` + `UserInfo.friends` (Task 2).
- Produces (all behind `authFootball`, mounted at `/handle-friends`):
  - `GET /search?q=` → `[{ userId, nickName, image }]`
  - `POST /request { toUserId }` → `{ ok: true }`
  - `GET /requests` → `[{ requestId, fromUserId, nickName, image }]`
  - `POST /respond { requestId, action: 'accept'|'decline' }` → `{ ok: true }`
  - `GET /` → `[{ userId, nickName, image }]`
  - `DELETE /:userId` → `{ ok: true }`

- [ ] **Step 1: Create `pikme-server/routes-pikme/friends.js`**

```js
const express = require('express')
const router = express.Router()
const mongoose = require('mongoose')
const UserInfo = require('../data/userinfo')
const FriendRequest = require('../data/friendrequest')
const { authFootball } = require('../middlewares/auth')

router.use(authFootball)

// GET /handle-friends/search?q=<nickname>
router.get('/search', async (req, res) => {
    try {
        const q = (req.query.q || '').toString().trim()
        if (q.length < 2) return res.json([])
        const me = await UserInfo.findById(req.userId).select('blockList friends').lean()
        const exclude = new Set([String(req.userId), ...Object.keys(me?.blockList || {}), ...Object.keys(me?.friends || {})])
        const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
        const users = await UserInfo.find({ nickName: rx, banned: { $ne: true } }).select('nickName image').limit(20).lean()
        return res.json(users
            .filter((u) => !exclude.has(String(u._id)))
            .slice(0, 10)
            .map((u) => ({ userId: String(u._id), nickName: u.nickName, image: u.image })))
    } catch (e) { return res.status(500).send('error') }
})

// POST /handle-friends/request { toUserId }
router.post('/request', async (req, res) => {
    try {
        const toUserId = (req.body.toUserId || '').toString()
        if (!mongoose.isValidObjectId(toUserId) || toUserId === String(req.userId)) return res.status(400).send('bad target')
        const [me, them] = await Promise.all([
            UserInfo.findById(req.userId).select('friends blockList').lean(),
            UserInfo.findById(toUserId).select('blockList').lean(),
        ])
        if (!them) return res.status(404).send('no user')
        if (me?.friends?.[toUserId]) return res.status(409).send('already friends')
        if (me?.blockList?.[toUserId] || them?.blockList?.[String(req.userId)]) return res.status(403).send('blocked')
        await FriendRequest.updateOne(
            { fromUserId: String(req.userId), toUserId },
            { $setOnInsert: { fromUserId: String(req.userId), toUserId, status: 'pending', channel: 'nickname', createdAt: new Date() } },
            { upsert: true }
        )
        return res.json({ ok: true })
    } catch (e) { return res.status(500).send('error') }
})

// GET /handle-friends/requests — incoming pending
router.get('/requests', async (req, res) => {
    try {
        const reqs = await FriendRequest.find({ toUserId: String(req.userId), status: 'pending' }).lean()
        const users = await UserInfo.find({ _id: { $in: reqs.map((r) => r.fromUserId) } }).select('nickName image').lean()
        const byId = Object.fromEntries(users.map((u) => [String(u._id), u]))
        return res.json(reqs.map((r) => ({ requestId: String(r._id), fromUserId: r.fromUserId, nickName: byId[r.fromUserId]?.nickName || '?', image: byId[r.fromUserId]?.image || null })))
    } catch (e) { return res.status(500).send('error') }
})

// POST /handle-friends/respond { requestId, action }
router.post('/respond', async (req, res) => {
    try {
        const { requestId, action } = req.body
        if (!['accept', 'decline'].includes(action)) return res.status(400).send('bad action')
        if (!mongoose.isValidObjectId(requestId)) return res.status(400).send('bad id')
        const fr = await FriendRequest.findById(requestId)
        if (!fr || fr.toUserId !== String(req.userId) || fr.status !== 'pending') return res.status(404).send('no request')
        if (action === 'decline') { fr.status = 'declined'; await fr.save(); return res.json({ ok: true }) }
        fr.status = 'accepted'; await fr.save()
        await Promise.all([
            UserInfo.updateOne({ _id: fr.fromUserId }, { $set: { [`friends.${fr.toUserId}`]: true } }),
            UserInfo.updateOne({ _id: fr.toUserId }, { $set: { [`friends.${fr.fromUserId}`]: true } }),
        ])
        return res.json({ ok: true })
    } catch (e) { return res.status(500).send('error') }
})

// GET /handle-friends — my friends
router.get('/', async (req, res) => {
    try {
        const me = await UserInfo.findById(req.userId).select('friends').lean()
        const users = await UserInfo.find({ _id: { $in: Object.keys(me?.friends || {}) } }).select('nickName image').lean()
        return res.json(users.map((u) => ({ userId: String(u._id), nickName: u.nickName, image: u.image })))
    } catch (e) { return res.status(500).send('error') }
})

// DELETE /handle-friends/:userId — remove both sides
router.delete('/:userId', async (req, res) => {
    try {
        const other = req.params.userId
        await Promise.all([
            UserInfo.updateOne({ _id: String(req.userId) }, { $unset: { [`friends.${other}`]: '' } }),
            UserInfo.updateOne({ _id: other }, { $unset: { [`friends.${String(req.userId)}`]: '' } }),
        ])
        return res.json({ ok: true })
    } catch (e) { return res.status(500).send('error') }
})

module.exports = router
```

- [ ] **Step 2: Mount the router + allow the football origin in `app.js`**

Add near the other `require('./routes-pikme/...')` lines:

```js
const handleFriends = require('./routes-pikme/friends.js')
```

Add near the other `app.use('/handle-...', ...)` mounts:

```js
app.use('/handle-friends', handleFriends)
```

Extend the CORS `origin` arrays (both branches) to include the football origins.
In the production array add `'https://football-mock.onrender.com'` (replace with the
real deployed football URL); in the dev array add `'http://localhost:3010'`:

```js
app.use(cors({
  origin: process.env.NODE_ENV === 'production' ?
    ["https://pikme.tv", 'https://create.pikme.tv', 'https://quiz.pikme.tv', 'https://career-h072.onrender.com', 'https://saltiz.store', 'https://policies.thesaltiz.com', 'https://thesaltiz.com', 'https://football-mock.onrender.com'] :
    ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:8081', 'http://localhost:8082', 'http://10.0.2.2:8081', 'http://127.0.0.1:8081', 'http://192.168.1.29', 'http://localhost:3010'],
  credentials: true
}))
```

- [ ] **Step 3: Verify wiring compiles**

Run: `cd pikme-server && node -e "require('./routes-pikme/friends.js'); require('./app.js') && 0; " 2>&1 | head -5 || node -e "require('./routes-pikme/friends.js'); console.log('friends router loads OK')"`
Expected: `friends router loads OK` (app.js may try to listen; the router-only check is the assertion).

- [ ] **Step 4: Write the integration test** — `pikme-server/test-friends.js`

```js
// End-to-end friends flow against the running server + its Mongo. Seeds two temp
// users, mints their football-tokens, drives the REST flow, then deletes them.
// PRECONDITION: the server is running locally (npm start / node server.js) with
// FOOTBALL_TOKEN_SECRET set, and MONGO connection configured as usual.
const assert = require('assert')
const jwt = require('jsonwebtoken')
const mongoose = require('mongoose')

const BASE = process.env.BASE || 'http://localhost:3001' // adjust to the server's port
const SECRET = process.env.FOOTBALL_TOKEN_SECRET
assert.ok(SECRET, 'set FOOTBALL_TOKEN_SECRET to match the running server')

async function main() {
    require('dotenv').config?.()
    const UserInfo = require('./data/userinfo')
    const FriendRequest = require('./data/friendrequest')
    await mongoose.connect(process.env.MONGO || process.env.MONGODB_URI)

    const a = await UserInfo.create({ nickName: 'TstA' + Math.floor(Math.random() * 999), image: 'a.jpg', phone: '+000000001', otp: '0' })
    const b = await UserInfo.create({ nickName: 'TstB' + Math.floor(Math.random() * 999), image: 'b.jpg', phone: '+000000002', otp: '0' })
    const tok = (u) => jwt.sign({ id: String(u._id), nickName: u.nickName, image: u.image }, SECRET, { expiresIn: '1h' })
    const H = (u) => ({ 'content-type': 'application/json', 'football-auth': tok(u) })

    try {
        // A searches for B by nickname
        let r = await fetch(`${BASE}/handle-friends/search?q=${encodeURIComponent(b.nickName)}`, { headers: H(a) })
        let list = await r.json()
        assert.ok(list.find((x) => x.userId === String(b._id)), 'search finds B')

        // A requests B
        r = await fetch(`${BASE}/handle-friends/request`, { method: 'POST', headers: H(a), body: JSON.stringify({ toUserId: String(b._id) }) })
        assert.strictEqual(r.status, 200, 'request ok')

        // B sees the incoming request
        r = await fetch(`${BASE}/handle-friends/requests`, { headers: H(b) })
        const reqs = await r.json()
        const inc = reqs.find((x) => x.fromUserId === String(a._id))
        assert.ok(inc, 'B sees A request')

        // B accepts
        r = await fetch(`${BASE}/handle-friends/respond`, { method: 'POST', headers: H(b), body: JSON.stringify({ requestId: inc.requestId, action: 'accept' }) })
        assert.strictEqual(r.status, 200, 'accept ok')

        // Both now list each other
        const aFriends = await (await fetch(`${BASE}/handle-friends`, { headers: H(a) })).json()
        const bFriends = await (await fetch(`${BASE}/handle-friends`, { headers: H(b) })).json()
        assert.ok(aFriends.find((x) => x.userId === String(b._id)), 'A has B')
        assert.ok(bFriends.find((x) => x.userId === String(a._id)), 'B has A')

        // Self-request rejected
        r = await fetch(`${BASE}/handle-friends/request`, { method: 'POST', headers: H(a), body: JSON.stringify({ toUserId: String(a._id) }) })
        assert.strictEqual(r.status, 400, 'self-request rejected')

        console.log('✅ friends REST flow PASS')
    } finally {
        await FriendRequest.deleteMany({ $or: [{ fromUserId: String(a._id) }, { toUserId: String(a._id) }] })
        await UserInfo.deleteMany({ _id: { $in: [a._id, b._id] } })
        await mongoose.disconnect()
    }
}
main().catch((e) => { console.error('❌', e); process.exit(1) })
```

- [ ] **Step 5: Run the integration test**

Run (server must be running with `FOOTBALL_TOKEN_SECRET` set; use the server's real
port for `BASE` and the repo's Mongo env var name):
`cd pikme-server && FOOTBALL_TOKEN_SECRET=<same-as-server> BASE=http://localhost:<port> node test-friends.js`
Expected: PASS — `✅ friends REST flow PASS`. If the Mongo env var differs, set
`MONGO`/`MONGODB_URI` to match `server.js`.

- [ ] **Step 6: Commit**

```bash
cd pikme-server
git add routes-pikme/friends.js app.js test-friends.js
git commit -m "feat(football): friends REST router (search/request/respond/list/remove) + CORS"
```

---

## Task 4: Football-token verify + authenticated join (football-mock)

**Files:**
- Modify: `football-mock/package.json`
- Create: `football-mock/shared/football-auth.js`
- Modify: `football-mock/server.js`
- Test: `football-mock/test-football-auth.mjs`

**Interfaces:**
- Produces: `verifyFootballToken(token, secret) -> { userId, nickName, image } | null`.
- Produces: `member.userId` (string | null), and a module-level
  `onlineByUser: Map<userId, member>` maintained on join/disconnect.

- [ ] **Step 1: Add the dependency**

Run: `cd football-mock && npm install jsonwebtoken@^9.0.2`
Expected: `jsonwebtoken` appears in `package.json` dependencies.

- [ ] **Step 2: Write the failing test** — `football-mock/test-football-auth.mjs`

```js
import assert from 'assert';
import jwt from 'jsonwebtoken';
import { verifyFootballToken } from './shared/football-auth.js';

const SECRET = 'test-secret-123';
const good = jwt.sign({ id: 'u1', nickName: 'Adam', image: 'x.jpg' }, SECRET, { expiresIn: '12h' });

const ok = verifyFootballToken(good, SECRET);
assert.ok(ok && ok.userId === 'u1' && ok.nickName === 'Adam' && ok.image === 'x.jpg', 'valid token → identity');
assert.strictEqual(verifyFootballToken(good, 'wrong-secret'), null, 'wrong secret → null');
assert.strictEqual(verifyFootballToken('garbage', SECRET), null, 'garbage → null');
assert.strictEqual(verifyFootballToken(null, SECRET), null, 'no token → null');
assert.strictEqual(verifyFootballToken(good, undefined), null, 'no secret → null');
const expired = jwt.sign({ id: 'u1' }, SECRET, { expiresIn: -10 });
assert.strictEqual(verifyFootballToken(expired, SECRET), null, 'expired → null');
console.log('✅ verifyFootballToken PASS');
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd football-mock && node test-football-auth.mjs`
Expected: FAIL — `Cannot find module './shared/football-auth.js'`.

- [ ] **Step 4: Create `football-mock/shared/football-auth.js`**

```js
// Verify the short-lived football-token the app injects. pikme-server signs it with
// the SAME FOOTBALL_TOKEN_SECRET. Returns null on any failure (fail closed).
import jwt from 'jsonwebtoken';

export function verifyFootballToken(token, secret) {
  if (!token || !secret) return null;
  try {
    const d = jwt.verify(token, secret);
    if (!d || !d.id) return null;
    return { userId: String(d.id), nickName: d.nickName || 'Player', image: d.image || null };
  } catch {
    return null;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd football-mock && node test-football-auth.mjs`
Expected: PASS — `✅ verifyFootballToken PASS`

- [ ] **Step 6: Wire identity into `server.js`**

At the top imports of `server.js`, add:

```js
import { verifyFootballToken } from './shared/football-auth.js';
```

Near the other module-level maps (`const members = new Map();`), add:

```js
const FOOTBALL_TOKEN_SECRET = process.env.FOOTBALL_TOKEN_SECRET || null;
const onlineByUser = new Map(); // userId -> member (authenticated connections only)
```

In the `join` handler (currently building `member = { id, ws, name, ... }`), verify
the token BEFORE constructing the member, and override name/avatar from the token
when present. Replace the block that computes `name`/`avatar` and creates `member`:

```js
      if (msg.type === 'join') {
        if (member) return;
        const id = `m-${++memberCounter}`;
        const ident = verifyFootballToken(msg.authToken, FOOTBALL_TOKEN_SECRET);
        // Authenticated → use Pikme identity; guest → typed name, no userId.
        let name = (ident?.nickName || msg.name || 'Player').toString().slice(0, 16);
        let avatar = (ident?.image || msg.avatar || '').toString().slice(0, 400) || null;
        if (avatar && avatar.startsWith('http://')) avatar = 'https://' + avatar.slice(7);
        const cards = sanitizeCards(msg.cards);
        member = { id, ws, userId: ident?.userId || null, name, avatar, cards, loadout: sanitizeLoadout(msg.loadout, cards), cosmetic: normalizeCosmetic(msg.cosmetic), team: 'A', inMatch: false, afk: false, lastInputAt: nowMs(), room: null, friends: [] };
        members.set(ws, member);
        if (member.userId) { onlineByUser.set(member.userId, member); notifyFriendsOfPresence(member.userId); }
        send(ws, { type: 'welcome', id, field: FIELD, chars: CHARACTERS, userId: member.userId });
        send(ws, { type: 'home', online: onlineCount() });
        return;
      }
```

In the `ws.on('close', ...)` handler, remove the user from presence and notify
their friends. Replace the close handler body:

```js
  ws.on('close', () => {
    if (!member) return;
    members.delete(ws);
    if (member.userId && onlineByUser.get(member.userId) === member) {
      onlineByUser.delete(member.userId);
      notifyFriendsOfPresence(member.userId);
    }
    leaveCurrentRoom(member);
  });
```

Add these helpers near `broadcastLobby` (Task 5 uses `sendPresenceTo`; define both now):

```js
// Presence: which of THIS member's friends are currently connected.
function sendPresenceTo(member) {
  if (!member) return;
  const online = (member.friends || []).filter((uid) => onlineByUser.has(uid));
  send(member.ws, { type: 'friendsPresence', online });
}
// When user `userId` connects/disconnects, refresh presence for everyone who has
// them as a friend.
function notifyFriendsOfPresence(userId) {
  for (const m of members.values()) {
    if (m.userId && Array.isArray(m.friends) && m.friends.includes(userId)) sendPresenceTo(m);
  }
}
```

- [ ] **Step 7: Verify the server still boots**

Run: `cd football-mock && FOOTBALL_TOKEN_SECRET=test node -e "import('./server.js').then(()=>{console.log('boots');setTimeout(()=>process.exit(0),300)})"`
Expected: prints the running banner + `boots` with no throw.

- [ ] **Step 8: Commit**

```bash
cd football-mock
git add package.json package-lock.json shared/football-auth.js server.js test-football-auth.mjs
git commit -m "feat(football): authenticate WS join via football-token + presence maps"
```

---

## Task 5: Friends presence over WS (football-mock)

**Files:**
- Modify: `football-mock/server.js` (add `setFriends` handler)
- Test: `football-mock/test-challenge.mjs` (presence section; created here, extended in Task 6)

**Interfaces:**
- Consumes: `onlineByUser`, `sendPresenceTo`, `notifyFriendsOfPresence` (Task 4).
- Produces: client→server `{ type:'setFriends', friends:[userId,...] }`;
  server→client `{ type:'friendsPresence', online:[userId,...] }`.

- [ ] **Step 1: Add the `setFriends` handler in `server.js`**

Inside `ws.on('message')`, after the `createRoom`/`joinRoom` handlers, add:

```js
      if (msg.type === 'setFriends') {
        const list = Array.isArray(msg.friends) ? msg.friends.filter((x) => typeof x === 'string').slice(0, 500) : [];
        member.friends = list;
        sendPresenceTo(member);
        return;
      }
```

- [ ] **Step 2: Write the failing test** — `football-mock/test-challenge.mjs`

```js
// Spawns the football server with a known secret, connects two authenticated
// clients, and asserts presence + (Task 6) the challenge handshake.
import assert from 'assert';
import { spawn } from 'child_process';
import WebSocket from 'ws';
import jwt from 'jsonwebtoken';

const SECRET = 'test-secret-123';
const PORT = 3999;
const tok = (id, nick) => jwt.sign({ id, nickName: nick, image: null }, SECRET, { expiresIn: '1h' });

function connect(id, nick, friends) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    const inbox = [];
    const waiters = [];
    const pump = () => { for (let i = waiters.length - 1; i >= 0; i--) { const w = waiters[i]; const hit = inbox.find(w.pred); if (hit) { waiters.splice(i, 1); w.resolve(hit); } } };
    ws.on('message', (d, isBin) => { if (isBin) return; inbox.push(JSON.parse(d.toString())); pump(); });
    ws.on('open', () => ws.send(JSON.stringify({ type: 'join', authToken: tok(id, nick), cards: [] })));
    const api = {
      ws,
      send: (o) => ws.send(JSON.stringify(o)),
      waitFor: (pred, ms = 3000) => new Promise((res, rej) => { const w = { pred, resolve: res }; waiters.push(w); pump(); setTimeout(() => rej(new Error('timeout waiting for ' + pred)), ms); }),
      close: () => ws.close(),
    };
    api.waitFor((m) => m.type === 'home').then(() => { if (friends) api.send({ type: 'setFriends', friends }); resolve(api); });
  });
}

const srv = spawn('node', ['server.js'], { cwd: process.cwd(), env: { ...process.env, PORT: String(PORT), FOOTBALL_TOKEN_SECRET: SECRET }, stdio: ['ignore', 'pipe', 'inherit'] });

async function ready() { return new Promise((res) => { srv.stdout.on('data', (b) => { if (b.toString().includes('running')) res(); }); }); }

async function main() {
  await ready();
  await new Promise((r) => setTimeout(r, 200));

  // A and B are friends of each other.
  const A = await connect('A', 'Alice', ['B']);
  const B = await connect('B', 'Bob', ['A']);

  // A already got a friendsPresence when it set friends; after B connects, A gets an
  // updated one showing B online.
  const p = await A.waitFor((m) => m.type === 'friendsPresence' && m.online.includes('B'));
  assert.ok(p.online.includes('B'), 'A sees B online');
  console.log('✅ presence PASS');

  // (Task 6 challenge assertions get appended here.)
  A.close(); B.close(); srv.kill(); process.exit(0);
}
main().catch((e) => { console.error('❌', e.message); srv.kill(); process.exit(1); });
```

- [ ] **Step 3: Run test to verify presence passes**

Run: `cd football-mock && node test-challenge.mjs`
Expected: PASS — `✅ presence PASS` (process exits 0). If it hangs, the `setFriends`
handler or `notifyFriendsOfPresence` wiring is wrong.

- [ ] **Step 4: Commit**

```bash
cd football-mock
git add server.js test-challenge.mjs
git commit -m "feat(football): setFriends + friendsPresence over WS"
```

---

## Task 6: Challenge handshake → private match (football-mock)

**Files:**
- Modify: `football-mock/server.js` (challenge handlers + helper)
- Test: `football-mock/test-challenge.mjs` (append challenge assertions)

**Interfaces:**
- Consumes: `onlineByUser`, `member.friends`, `makeRoom`, `genCode`, `addToRoom`,
  `startCountdown`, `broadcastLobby`, `rooms`, `MAX_PLAYERS`.
- Produces:
  - client→server `{ type:'challenge', toUserId }`
  - server→target `{ type:'challengeReceived', challengeId, fromUserId, fromName }`
  - client→server `{ type:'challengeRespond', challengeId, accept:true|false }`
  - server→challenger on decline `{ type:'challengeDeclined', byUserId }`
  - on accept: both get the existing `{ type:'roomJoined', mode:'private', code }`
    then the normal lobby→countdown→`matchStart`.

- [ ] **Step 1: Add the challenge state + helper in `server.js`**

Near the module-level maps add:

```js
const challenges = new Map(); // challengeId -> { fromUserId, toUserId }
let challengeCounter = 0;
```

Add the helper near `createPrivateRoom`:

```js
// A challenge accept drops both players into a fresh private room on opposite teams
// and starts the normal countdown → match. Reuses the private-room lifecycle.
function startChallengeMatch(a, b) {
  leaveCurrentRoom(a);
  leaveCurrentRoom(b);
  const room = makeRoom(genCode(), true);
  rooms.set(room.id, room);
  addToRoom(a, room);
  addToRoom(b, room);
  a.team = 'A';
  b.team = 'B';
  send(a.ws, { type: 'roomJoined', mode: 'private', code: room.id });
  send(b.ws, { type: 'roomJoined', mode: 'private', code: room.id });
  startCountdown(room);
  broadcastLobby(room);
}
```

- [ ] **Step 2: Add the challenge message handlers**

Inside `ws.on('message')`, after the `setFriends` handler, add:

```js
      if (msg.type === 'challenge') {
        const toUserId = (msg.toUserId || '').toString();
        if (!member.userId) { send(ws, { type: 'challengeError', msg: 'לא מחובר' }); return; }
        if (!member.friends.includes(toUserId)) { send(ws, { type: 'challengeError', msg: 'לא חבר' }); return; }
        const target = onlineByUser.get(toUserId);
        if (!target) { send(ws, { type: 'challengeError', msg: 'לא מחובר כרגע' }); return; }
        const challengeId = `c-${++challengeCounter}`;
        challenges.set(challengeId, { fromUserId: member.userId, toUserId });
        send(target.ws, { type: 'challengeReceived', challengeId, fromUserId: member.userId, fromName: member.name });
        send(ws, { type: 'challengeSent', toUserId });
        return;
      }
      if (msg.type === 'challengeRespond') {
        const c = challenges.get((msg.challengeId || '').toString());
        if (!c || c.toUserId !== member.userId) return;
        challenges.delete(msg.challengeId);
        const challenger = onlineByUser.get(c.fromUserId);
        if (!msg.accept) { if (challenger) send(challenger.ws, { type: 'challengeDeclined', byUserId: member.userId }); return; }
        if (!challenger) { send(ws, { type: 'challengeError', msg: 'היריב התנתק' }); return; }
        startChallengeMatch(challenger, member);
        return;
      }
```

- [ ] **Step 3: Append challenge assertions to `test-challenge.mjs`**

Replace the `// (Task 6 challenge assertions get appended here.)` line with:

```js
  // A challenges B; B receives it.
  A.send({ type: 'challenge', toUserId: 'B' });
  const recv = await B.waitFor((m) => m.type === 'challengeReceived' && m.fromUserId === 'A');
  assert.ok(recv.challengeId, 'B receives challenge from A');

  // B accepts → both get roomJoined (private) then matchStart.
  B.send({ type: 'challengeRespond', challengeId: recv.challengeId, accept: true });
  const [ja, jb] = await Promise.all([
    A.waitFor((m) => m.type === 'roomJoined' && m.mode === 'private'),
    B.waitFor((m) => m.type === 'roomJoined' && m.mode === 'private'),
  ]);
  assert.strictEqual(ja.code, jb.code, 'both joined the same room code');
  const [ma, mb] = await Promise.all([
    A.waitFor((m) => m.type === 'matchStart', 9000),
    B.waitFor((m) => m.type === 'matchStart', 9000),
  ]);
  assert.strictEqual(ma.matchId, mb.matchId, 'both entered the same match');
  console.log('✅ challenge PASS');

  // Non-friend challenge is rejected.
  const C = await connect('C', 'Carol', []); // C has no friends
  C.send({ type: 'challenge', toUserId: 'A' });
  const err = await C.waitFor((m) => m.type === 'challengeError');
  assert.ok(err, 'challenge to non-friend rejected');
  console.log('✅ challenge-guard PASS');
  C.close();
```

- [ ] **Step 4: Run the full challenge test**

Run: `cd football-mock && node test-challenge.mjs`
Expected: PASS — `✅ presence PASS`, `✅ challenge PASS`, `✅ challenge-guard PASS`,
exit 0. (The `matchStart` waits allow up to 9s for the 5s countdown.)

- [ ] **Step 5: Commit**

```bash
cd football-mock
git add server.js test-challenge.mjs
git commit -m "feat(football): challenge handshake → private match"
```

---

## Task 7: Friends panel UI in the football hub (football-mock client)

**Files:**
- Modify: `football-mock/public/index.html` (extend the `#friends` screen)
- Modify: `football-mock/public/client.js` (token inject, REST calls, presence/challenge UI)
- Modify: `football-mock/public/style.css` (friends list + online dot + challenge modal)

**Interfaces:**
- Consumes: `sendMsg(o)` (client.js:541), the WS messages from Tasks 4–6, and the
  pikme-server friends REST from Task 3.
- Produces: injected identity contract — the app sets `window.PIKME_FOOTBALL_TOKEN`
  (like `window.SALTIZ_XP`) and optionally `window.PIKME_API` (REST base). Dev
  fallback: `?ftoken=` query param; default API base `http://localhost:3001`.

> No automated UI test framework exists in this repo; this task is verified manually
> against two running browser sessions (checklist in Step 6). The message/REST
> contracts it depends on are already covered by Tasks 3–6.

- [ ] **Step 1: Send the token on connect (client.js)**

At the top of `client.js` (near other config), add:

```js
const FOOTBALL_TOKEN = (() => { try { return window.PIKME_FOOTBALL_TOKEN || new URLSearchParams(location.search).get('ftoken') || null; } catch { return null; } })();
const PIKME_API = (window.PIKME_API || (location.hostname === 'localhost' ? 'http://localhost:3001' : 'https://pikme-server.onrender.com')).replace(/\/$/, '');
let MY_USER_ID = null; // filled from the welcome message
```

In `connect()` (client.js:1023), add `authToken` to the join payload:

```js
    ws.send(JSON.stringify({ type: 'join', authToken: FOOTBALL_TOKEN, name, avatar, cards: myCards(), cosmetic: myCosmetic, loadout: effectiveLoadout() }));
```

In the `welcome` message handler, capture the id and (if authenticated) load friends:

```js
    if (m.type === 'welcome') { MY_USER_ID = m.userId || null; /* existing welcome handling */ if (MY_USER_ID) loadFriends(); }
```

- [ ] **Step 2: Add the friends REST helpers (client.js)**

```js
function apiHeaders() { return { 'content-type': 'application/json', 'football-auth': FOOTBALL_TOKEN || '' }; }
async function apiGet(path) { const r = await fetch(`${PIKME_API}${path}`, { headers: apiHeaders() }); return r.ok ? r.json() : []; }
async function apiPost(path, body) { const r = await fetch(`${PIKME_API}${path}`, { method: 'POST', headers: apiHeaders(), body: JSON.stringify(body) }); return r.ok; }

let FRIENDS = [];          // [{userId, nickName, image}]
let ONLINE = new Set();    // userIds currently online (from friendsPresence)

async function loadFriends() {
  FRIENDS = await apiGet('/handle-friends');
  sendMsg({ type: 'setFriends', friends: FRIENDS.map((f) => f.userId) });
  renderFriends();
  loadRequests();
}
async function loadRequests() {
  const reqs = await apiGet('/handle-friends/requests');
  renderRequests(reqs);
}
async function searchFriends(q) {
  if (!q || q.length < 2) { renderSearch([]); return; }
  renderSearch(await apiGet(`/handle-friends/search?q=${encodeURIComponent(q)}`));
}
```

- [ ] **Step 2b: Handle presence + challenge WS messages (client.js)**

In the main message switch, add:

```js
    if (m.type === 'friendsPresence') { ONLINE = new Set(m.online || []); renderFriends(); return; }
    if (m.type === 'challengeReceived') { showChallengePrompt(m.challengeId, m.fromName); return; }
    if (m.type === 'challengeDeclined') { toast('היריב דחה את האתגר'); return; }
    if (m.type === 'challengeError') { toast(m.msg || 'האתגר נכשל'); return; }
    if (m.type === 'challengeSent') { toast('אתגר נשלח'); return; }
```

(If a `toast(msg)` helper does not exist, add a minimal one that shows `#room-error`
text for 2s, or `alert(msg)` as a fallback.)

- [ ] **Step 3: Extend the `#friends` screen (index.html)**

Inside `<div id="friends" class="screen hidden">`, above the existing create/join
room block, add (RTL Hebrew):

```html
      <div id="friends-panel">
        <input id="friend-search" class="friend-input" placeholder="חיפוש חבר לפי כינוי…" />
        <div id="friend-search-results" class="friend-list"></div>
        <div id="friend-requests" class="friend-list"></div>
        <h4 class="friends-h">החברים שלי</h4>
        <div id="friend-list" class="friend-list"></div>
      </div>
```

- [ ] **Step 4: Render + wire the panel (client.js)**

```js
function friendRow(f, opts = {}) {
  const online = ONLINE.has(f.userId);
  const div = document.createElement('div');
  div.className = 'friend-row' + (online ? ' online' : '');
  div.innerHTML = `<span class="friend-dot"></span><img class="friend-pfp" src="${f.image || ''}"/><span class="friend-name">${f.nickName}</span>`;
  const btn = document.createElement('button');
  btn.className = 'friend-act';
  if (opts.kind === 'search') { btn.textContent = 'הוסף'; btn.onclick = async () => { if (await apiPost('/handle-friends/request', { toUserId: f.userId })) { btn.textContent = 'נשלח'; btn.disabled = true; } }; }
  else if (opts.kind === 'request') { btn.textContent = 'אישור'; btn.onclick = async () => { if (await apiPost('/handle-friends/respond', { requestId: f.requestId, action: 'accept' })) { loadFriends(); } }; }
  else { btn.textContent = 'אתגר'; btn.disabled = !online; btn.onclick = () => sendMsg({ type: 'challenge', toUserId: f.userId }); }
  div.appendChild(btn);
  return div;
}
function renderList(id, items, opts) { const el = document.getElementById(id); if (!el) return; el.innerHTML = ''; items.forEach((f) => el.appendChild(friendRow(f, opts))); }
function renderFriends() { renderList('friend-list', FRIENDS, { kind: 'friend' }); }
function renderSearch(items) { renderList('friend-search-results', items, { kind: 'search' }); }
function renderRequests(items) { renderList('friend-requests', items, { kind: 'request' }); }

function showChallengePrompt(challengeId, fromName) {
  if (!confirm(`${fromName} מזמין אותך למשחק. לקבל?`)) { sendMsg({ type: 'challengeRespond', challengeId, accept: false }); return; }
  sendMsg({ type: 'challengeRespond', challengeId, accept: true });
}

document.getElementById('friend-search')?.addEventListener('input', (e) => searchFriends(e.target.value.trim()));
```

(For Slice 1 a `confirm()` prompt is acceptable; a styled modal can replace it later.)

- [ ] **Step 5: Minimal styles (style.css)**

```css
#friends-panel { display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; }
.friend-input { width: 100%; padding: 10px; border-radius: 10px; border: 1px solid #333; background: #1b1b1f; color: #fff; text-align: right; }
.friend-list { display: flex; flex-direction: column; gap: 6px; }
.friend-row { display: flex; align-items: center; gap: 8px; padding: 6px 8px; background: #17171b; border-radius: 10px; }
.friend-dot { width: 9px; height: 9px; border-radius: 50%; background: #555; flex: 0 0 auto; }
.friend-row.online .friend-dot { background: #35d06a; box-shadow: 0 0 6px #35d06a; }
.friend-pfp { width: 28px; height: 28px; border-radius: 50%; object-fit: cover; background: #333; }
.friend-name { flex: 1; text-align: right; color: #fff; }
.friend-act { padding: 6px 12px; border-radius: 8px; border: 0; background: #35d06a; color: #04240f; font-weight: 700; }
.friend-act:disabled { background: #333; color: #888; }
.friends-h { color: #aaa; margin: 8px 0 0; text-align: right; }
```

- [ ] **Step 6: Manual end-to-end verification**

1. Start pikme-server locally with `FOOTBALL_TOKEN_SECRET` set. Mint two tokens for
   two real dev users: `GET /handle-user/football-token` with each user's `auth`
   cookie (or via `jwt.sign` with the two users' ids for a quick test).
2. Start football-mock: `cd football-mock && FOOTBALL_TOKEN_SECRET=<same> npm start`.
3. Open two browsers: `http://localhost:3010/?ftoken=<tokenA>` and `?ftoken=<tokenB>`.
4. In A: open the Friends screen, search B's nickname, tap הוסף. In B: reload the
   Friends screen, accept the request. Confirm each now sees the other in "החברים שלי"
   with a **green** dot.
5. In A: tap אתגר on B. Confirm B gets the prompt; accept. Confirm **both** browsers
   enter the same 2v2 match.
6. Close B's tab; confirm A's dot for B goes grey and אתגר disables.

Expected: all six checks pass. Note any failure and fix before committing.

- [ ] **Step 7: Commit**

```bash
cd football-mock
git add public/index.html public/client.js public/style.css
git commit -m "feat(football): friends panel UI (search/requests/list/presence/challenge) in hub"
```

---

## Deployment / config checklist (do before shipping Slice 1)

- [ ] Set `FOOTBALL_TOKEN_SECRET` to the **same** value in pikme-server and
  football-mock Render envs.
- [ ] Confirm the real deployed football origin is in pikme-server's CORS
  production array (Task 3, Step 2 — replace the `football-mock.onrender.com`
  placeholder with the actual URL).
- [ ] Confirm `PIKME_API` in the client points at the real pikme-server URL in
  production (Task 7, Step 1 — replace the `pikme-server.onrender.com` placeholder).

## Out of scope (later slices — do NOT build here)
- Push-reach to friends not in the game; invite-link deep-links (Slice 2).
- Phone-typed and contacts add-channels (Slice 3).
- Native in-app Friends screen; removing the typed room-code UI.
