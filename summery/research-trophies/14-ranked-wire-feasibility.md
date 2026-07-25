# 14 — Can we actually BUILD it: the queue, the wire, the trust boundary

> Seat: buildability. **No game research — this is an audit of our own code.**
> Every claim tagged **VERIFIED** was read out of the repo this session (file:line given).
> **INFERRED** = my design proposal, not shipped anywhere.
> Written 2026-07-26. Companion seats: `12` (ranked-event mode), `13` (upset curve), spec → `15-RANKED-EVENT-SPEC.md`.

---

## 0. VERDICT — read this and nothing else

1. **Option 3 (pikme-server computes both deltas at record-match) is DEAD.** Not "expensive" — impossible. `opponentKey` is a **per-player view of "who I faced"**, not a shared pairing id: in a 1v1 Alice's key ≠ Bob's key. Nothing else in the report identifies the opponent, and there is no way back from a sha256 to a phone. VERIFIED, §2.
2. **Recommended path: rank CLAIMS in the football-token (option 1) for the READ + a game-signed match RECEIPT for the WRITE.** Zero new secrets (`FOOTBALL_TOKEN_SECRET` is already deployed in both services and football-mock already imports `jsonwebtoken`), zero new outbound HTTP, zero new failure modes at kickoff. §3.
3. **🚨 SHIP-BLOCKER THAT ALREADY EXISTS: `POST /handle-user/football/record-match` is completely unauthenticated and takes `phone` from the request body.** `authNonBlock` never rejects (`middlewares/auth.js:14-22`), and the route reads `normalizeBankPhone(req.body.phone)` (`user.js:1239`). Anyone with curl can write wins/losses to **any phone number they know**. Rate limiter = 400 req/min/IP → **~11 seconds to forge legend rank, ~2 minutes to forge legend trophies.** Adding a 3–5× upset multiplier on top of this endpoint is negligent. §4.
4. **The fix for #3 costs 3 lines and breaks nothing**: swap `authNonBlock` → `auth` and resolve the phone from `req.userId`. The **current shipped app already sends the `auth` header** on this call (`pikmeTV-saltiz/services/http.js:44`), so no app release is needed. VERIFIED.
5. **Ranked IS shippable game-side + server-side with the app the other dev already shipped.** The game client holds `window.PIKME_FOOTBALL_TOKEN`, CORS already whitelists `https://pikme-football.onrender.com`, and the game can POST its own ranked result straight to pikme-server — the app is never in the loop. The only thing blocked on the app is the **post-match rank-reveal animation's `delta`**, and even that has a game-side workaround. §6.
6. **2v2 ranked will essentially never fill at a few-hundred-user base. Ranked v1 must be 1v1.** §5.
7. **Delete-list is real but the test blast radius is ~50 assertions across 5 files**, roughly **half of `pikme-server/test-football-rank.mjs`** including its entire JOURNEY block. §7.

---

## 1. What the wire carries today (VERIFIED)

```
GAME SERVER (football-mock)            CLIENT (WebView)         APP (RN)              PIKME-SERVER
─────────────────────────────────────────────────────────────────────────────────────────────────
join{authToken}  ──verify──► member.userId
                                                                        GET /football-token
                                                                        {id,nickName,image} 12h
matchStart{matchId, opponentKey, ...} ─────► postMessage ──► onMessage ──► POST record-match
                                              matchResult                 {phone, matchId, result,
                                                                           vsHuman, xpFactor,
                                                                           botLevel, opponentKey,
                                                                           stats}
                                                                                  │
                                          window.SALTIZ_RANK ◄── injectRank ◄──────┘ {rankDelta, stats}
```

| Fact | Value | Source |
|---|---|---|
| football-token claims | `{ id, nickName, image }` — **no rank, no phone** | `pikme-server/routes-pikme/user.js:1026-1030` |
| football-token TTL | **12h** (`expiresIn: '12h'`) | `user.js:1029` |
| Token is re-minted | per WebView mount (`useQuery` keyed on identifier) → effective staleness ≈ one session; **worst case still 12h** | `pikmeTV-saltiz/app/pages/football.jsx:134-137` |
| Game→pikme outbound calls | **ZERO.** `grep fetch\|axios\|https\.` in `server.js` → nothing | `football-mock/server.js` |
| Game deps | `jsonwebtoken@^9.0.3`, `ws@^8.18.0`. `engines: node>=18` ⇒ global `fetch` available, **no new dep for option 2** | `football-mock/package.json` |
| Game holds the shared secret | `FOOTBALL_TOKEN_SECRET` at `server.js:80` — so it can **verify AND SIGN** | `server.js:80`, `shared/football-auth.js` |
| `matchStart` fields | `diffLevel, matchId, playerId, team, field, chars, settings, players, intro, arena, teamSize, goalsToWin, opponentKey` — **no ranks** | `server.js:652` |
| `matchId` | `` `${room.id}-${++matchSeq}` `` — **identical string for every participant** | `server.js:630` |
| `matchSeq` scope | module-level, **resets on process restart**; `roomCounter` too ⇒ matchIds recur after a Render deploy and collide across instances | `server.js:121-125` |
| rankPoints key | **PHONE.** `userId` is explicitly "Optional… NOT the key" | `pikme-server/data/footballstats.js:13-23` |
| record-match auth | **`authNonBlock`** — never rejects | `user.js:1237` + `middlewares/auth.js:14-22` |
| record-match identity | `normalizeBankPhone(req.body.phone)` — client-asserted | `user.js:1239` |
| Global rate limit | `windowMs 60_000, max 400` per IP | `pikme-server/app.js:13` |
| CORS prod whitelist | includes **`https://pikme-football.onrender.com`** | `app.js:57` |
| Service-secret precedent | `x-internal-key` + `process.env.INTERNAL_NICKNAME_KEY` | `user.js:967-970` |

---

## 2. (b) Option 3 checked properly — **it cannot identify the opponent. This is the finding.**

pikme-server gets **one report from one player**. Can it join the two sides?

### Can `opponentKey` join them? **NO — VERIFIED, and there is a test that says so out loud.**

`opponentKeyFor(assigned, me, myTeam)` filters `entry[0] !== me && entry[1] !== myTeam` — i.e. **my human opponents only** (`shared/opponent-key.js`).

- 1v1 Alice vs Bob: Alice's key = `H(["user-bob"])`, Bob's key = `H(["user-alice"])`. **Different strings.**
- 2v2 A+B vs C+D: A's key = `H([C,D])`, C's key = `H([A,B])`. **Different.** A and B share a key (teammates), C and D share a key.
- `test-opponent-key.mjs`: *"Alice and Bob get DIFFERENT keys — each hashes the other, not the pairing"* and *"the account id is NOT recoverable from the key"*.

⇒ `opponentKey` is a **teammate-set grouping key**, not a match id. It is exactly the wrong shape.

### Can `matchId` join them? **Mechanically yes, securely no.**

`matchId` IS the same string on both sides (`server.js:630`) — so a new `{matchId, phone, result}` collection could join two rows. Four problems, all fatal for v1:

1. **`matchId` is 100% client-controlled by the time it reaches pikme-server.** It is a plain string in the POST body of an unauthenticated endpoint. An attacker posts **two** rows with the same self-chosen matchId — one "win" for their own phone, one "loss" for a victim's phone — and manufactures a fake 3–5× upset *and* grief-tanks the victim, in one request pair.
2. **`matchId` is not globally unique.** `matchSeq` and `roomCounter` are module-level and reset on process restart (`server.js:121-125`). `pub-3-7` recurs after every Render deploy, and would collide across instances if the game ever scales past one dyno. A cross-player join table on a colliding key silently marries unrelated matches.
3. **No arrival guarantee and no ordering.** Each app posts fire-and-forget, independently (`football.jsx:277`, `.catch(() => {})`). The **first** report cannot know the opponent's rank, so record-match becomes a two-phase settle (defer, or apply-provisional-then-correct) — the exact complexity option 3 was supposed to avoid.
4. **An abandoner never reports at all.** `postMatchResult` only fires when the client observes `latest.phase === 'ended'` (`client.js:6057`). Rage-quit → app killed → no row → the winner's report waits forever for a partner that will never arrive.

### Does it know the other participants' phones? **No.**

The report contains only the **reporter's** phone. No opponent phone, no opponent userId, and `opponentKey` is a truncated sha256 by design. pikme-server *could* resolve a userId→phone (`UserInfo.findById(...).select('phone')`, the pattern at `friends.js:49`) — **but it is never given an opponent userId to resolve.**

> **Finding, stated plainly: at record-match time pikme-server cannot identify who the reporter played. Option 3 requires new information on the wire regardless — at which point it is no longer "the cheap option".**

---

## 3. (a) The three options, costed — and the recommendation

### Option 1 — signed rank CLAIMS in the football-token at issue time

Add `rankPoints`/`rankTier`/`rankedMatches` to the JWT at mint (`user.js:1026`). The game reads them at `join` (`server.js:1126`) into `member.rank`.

| | |
|---|---|
| **pikme-server change** | ~4 lines: one `FootballStats.findOne` at mint + 3 claims |
| **game change** | pass the claims through `verifyFootballToken` (`shared/football-auth.js`) + store on `member` |
| **new secret** | none |
| **new outbound HTTP** | none |
| **new failure mode** | none at kickoff. A missing claim = old app build = **not ranked-eligible** (fails closed) |
| **staleness** | **≤ 12h (43,200s)** = the token TTL. Practically ≈ one WebView session |
| **staleness, quantified** | at ~25 pts/win and ~2.5 min/match cycle, 12h of continuous play = **288 matches ≈ 7,200 rank points of drift** — more than the entire 0→3,200 ladder |
| **PII** | safe. Each token carries only **its own holder's** rank, and the holder can already read their own rank via `/handle-friends/rank` |
| **bonus** | the **queue gets rank for free at join time** — which options 2 and 3 do not give you, and the queue needs it to band-match |

### Option 2 — one outbound call from football-mock per ranked match start

| | |
|---|---|
| **new dep** | **none** — Node ≥18 global `fetch` |
| **new secret** | **none needed.** football-mock holds `FOOTBALL_TOKEN_SECRET`, so it can *mint* a valid football-token for any userId and call `GET /handle-friends/rank` as that user. (Cleaner: a new `x-internal-key` route, mirroring `user.js:967`.) |
| **cost per call** | `/handle-friends/rank` runs a **full-collection `$setWindowFields` aggregate** over all FootballStats + one `findOne` (`friends.js:51-63`). Fine at ~300 docs; wasteful by construction |
| **hard ceiling** | rate limiter is **400 req/min/IP** and the game server is **one IP** → at 4 fetches/match that is **100 ranked match starts/min** before pikme-server 429s the game |
| **new failure mode** | the real cost. pikme-server unreachable/slow at kickoff → does the ranked match start? Options: block kickoff (bad UX), start unranked (silently steals a ranked match), or fall back to the token claim (⇒ you needed option 1 anyway) |
| **staleness** | ~0 (fresh) |
| **queue** | **does not help the queue** — banding happens while players wait, so you'd need a fetch at queue-join too, i.e. a fetch per queue entry |

### Option 3 — pikme-server computes both deltas at record-match

**Dead. §2.** Cost if forced: a new `rankedmatches` collection, a two-phase settle with a timeout sweeper, a globally-unique matchId (game-side change), and an authenticated report (game-side change) — strictly more work than options 1+2 combined, for worse security.

### ✅ RECOMMENDATION (INFERRED)

**Option 1 for the READ + a game-signed RECEIPT for the WRITE.** Option 2 is a later freshness optimisation, not v1.

```
member.rank  ← token claim (option 1)                      [game knows every rank in the room]
     ↓
ranked queue bands on it                                    [no HTTP anywhere]
     ↓
startMatch: game signs ONE receipt per participant
  HS256(FOOTBALL_TOKEN_SECRET, {
     v:1, ranked:true, matchId, mySub:<my userId>,
     result:'win'|'loss'|'draw', myScore, opScore,
     oppRanks:[Number,…],        // ranks the GAME saw — never identities
     teamRanks:[Number,…],
     iat, exp: iat+600           // 10-minute window
  })                                                        [~250–320 bytes base64]
     ↓  rides in matchStart, opaque to the client
game client POSTs it itself:
  POST /handle-user/football/record-ranked
  header  football-auth: <PIKME_FOOTBALL_TOKEN>   → authFootball → req.userId
  body    { receipt }
     ↓
pikme-server: verify receipt sig → require receipt.mySub === req.userId
              → resolve userId → phone (UserInfo.findById, friends.js:49 pattern)
              → SELF rank read FRESH from the DB (never from the receipt)
              → OPPONENT ranks from the receipt (stale-bounded, signed)
              → computeMatchRank(...) → applyRankDelta(...) → idempotent on receipt.matchId
```

**Why this exact split:** the reporter's own rank must be **fresh** (it's the base the delta is applied to, and a stale base would corrupt the sticky floor); the opponent's rank only needs to be **the rank the match was actually played against**, which is precisely what the game saw. Staleness therefore lands only where it is harmless.

**Why the receipt and not just a hardened record-match:** hardening the endpoint fixes *who* is writing. It does not fix *what* they claim. Only a server-signed blob makes `result`, `oppRanks` and `matchId` unforgeable.

---

## 4. (c) Trust boundary — public repo, WebView, client fully owned by the attacker

### Must be server-DERIVED (never accepted from a client), for ranked

| Field | Today | Required |
|---|---|---|
| identity (phone / userId) | `req.body.phone`, unauthenticated ⚠️ | from a verified JWT `sub`, resolved server-side to phone |
| `result` / `myScore` / `opScore` | client-computed (`client.js:548`) | game-signed |
| `matchId` | game-minted but **relayed unsigned** through the client | game-signed **and** globally unique (add `process boot id` or a UUID) |
| opponent rank | **does not exist** | game-signed, or DB-resolved from a signed opponent identity |
| `vsHuman` | client-computed from `matchRoster` (`client.js:574`) | game-signed. Ranked = humans-only by construction, so this becomes redundant |
| `xpFactor` | **client-computed** (`client.js:560`) | irrelevant to ranked; **keep for trophies** but understand it is asserted |
| `botLevel` | relayed from `matchStart` by the client | dead on the rank track (§7) |
| `opponentKey` | game-minted, relayed unsigned | game-signed (it drives the win-trading cap, so a client that blanks it un-caps itself) |
| `stats` (goals/assists/…) | client-reported, clamped | fine — never gate rank on it (already true) |
| rank delta itself | server-computed in `football-rank.js`; the game only renders `SALTIZ_RANK` | **keep exactly as is.** `shared/rank.js` is display-only and says so |

### What a malicious client can claim, per option

**Today, before any ranked work — this is live:**
- `curl -X POST .../football/record-match -d '{"phone":"+9725…","matchId":"x1","result":"win","goalsFor":9}'` → succeeds. No token. Any phone.
- 400/min/IP × bronze `+30` win = **12,000 rankPoints/min ⇒ legend (3,200) in ~11 s**.
- 400/min × (100 base + 200 first-win) ≈ **40,000 xp/min ⇒ legend trophies (80,000 xp) in ~2 min** — and the xp leaderboard is live (`/football/leaderboard`).
- **Griefing:** post `result:'loss'` against a victim's phone repeatedly. rankPoints falls (floored by `rankFloor`). xp is monotonic so trophies can't be reduced — rank can.
- **Any phone the attacker knows is a target.** `/handle-friends/search` matches an exact phone (`friends.js:87-89`), and Israeli mobile numbers are a 8-digit space behind `+9725`.

**Option 1 (claims) alone:** attacker cannot forge a *claim* (it's inside a signed JWT they cannot re-sign), but they can still forge the whole **report** — so the upset multiplier is farmable by asserting a fake match against a fake high `oppRank`. **Insufficient alone.**

**Option 2 (game fetches) alone:** the game holds true ranks, but nothing carries them to the delta computation in a way the client cannot rewrite. Same hole. **Insufficient alone.**

**Option 3:** worst case. It makes `matchId` a *security-relevant* join key while leaving it client-chosen ⇒ the attacker mints both halves of a fake upset. **Actively dangerous.**

**Option 1 + receipt (recommended):** the client can only *replay* (idempotent on `matchId`) or *withhold* (see the abandon risk, §8). It cannot forge a match, cannot pick its opponent's rank, cannot write to another player's phone.

### Two more real holes worth fixing in the same pass

- **`durationSec` is a constant, so the app's abandon guard is a no-op.** `client.js:572` sends `durationSec: MATCH_DURATION`, and `MATCH_DURATION = 120` (`shared/constants.js:57`). The app gates on `d.durationSec >= 30` (`football.jsx:276`) — it is **always 120**, so a 3-second match records identically to a full one. Fix: send real elapsed, or (better) let the receipt carry the game's own tick count.
- **AFK humans still count as human.** `checkAfk` flips `p.isBot = true` after `AFK_SECONDS = 10` (`server.js:679-687`) but the member stays in `matchRoster`, and `vsHuman`/`xpFactor` are computed from `matchRoster` captured at match start (`client.js:549`). In ranked this is "queue up, put the phone down, get carried". Must be a forfeit.

---

## 5. (d) The minimal ranked queue in `server.js`

### Why the existing matchmaker cannot be reused (VERIFIED)

`joinMatchmade` (`server.js:374`) is not a queue. It puts the first joiner in a room, calls `startCountdown` with `COUNTDOWN_TIME = 5` (`server.js:75`), and `tickRoom` fires `startMatch` at t≤0 (`server.js:698-701`) — which calls `fillBots` **unconditionally** (`server.js:646`). `fillBots` (`server.js:237`) loops `while (players < roomMax(room))` and **pushes bots into the roster the client receives** — the live bug that makes bot matches report `vsHuman: true`. There is no waiting state, no rank band, no timeout. **A ranked queue must not touch `joinMatchmade` and must never call `fillBots`.**

### 🔴 Design call the spec has to make: **v1 ranked is 1v1**

Population is "a few hundred Hebrew-speaking users, mostly teens; the normal case at any given hour is that almost nobody else is online." 2v2 ranked needs **4 rank-adjacent humans simultaneously**. 1v1 needs 2. Also: 1v1 makes the upset multiplier legible ("I beat one legend"), removes the "carried by a partner" attribution problem that a 3–5× multiplier makes acute, and removes the party-vs-solo fairness question entirely. **Ship 1v1; add 2v2 only if the event actually fills.**

### The queue (INFERRED)

```js
// A REAL waiting queue — separate from publicRooms/formingRoom, which form rooms instantly.
const rankedQueue = [];   // [{ member, rank, size, partyId, joinedAt }]
const RANKED_TEAM     = 1;      // v1: 1v1
const BAND0           = 150;    // rank points, ± , at t=0  ≈ ¾ of a bronze tier
const BAND_STEP       = 150;    // widen every…
const BAND_EVERY_MS   = 10_000; // …10s
const BAND_UNCAPPED_AT= 60_000; // 60s → match ANY rank (the user WANTS upsets; see §8)
const RANKED_TIMEOUT  = 120_000;// 120s → give up, NEVER backfill bots
```

- **band(waitMs)** = `BAND0 + BAND_STEP * floor(waitMs / BAND_EVERY_MS)`, i.e. ±150 → ±300 → … → unbounded at 60s. Deliberately loose: a tight matchmaker would *prevent* the upsets the user asked to reward.
- **Pairing**: sort by rank; anchor on the longest-waiting entry; take the nearest entry inside its band. Both sides must be inside *each other's* band (use the wider one).
- **Timeout**: send `{ type: 'rankedTimeout' }`, drop from queue, return to hub, offer quick match. **No bots, ever.**
- **Party of 2 vs 2 solos** (only relevant if 2v2 ships): a party is **one entry with `size: 2`** and `partyRank = MAX(member ranks)` — max, not mean, is the anti-smurf choice (a legend + a bronze must be matched as a legend). Pairing becomes a bin-pack over sizes {1,2} to fill 2+2, and party members must land on the **same team**. Two solos = two `size:1` entries placed on one team.
- **Eligibility, all server-side**: `member.userId != null` (no guests — a guest has no rank and no account to lose), `member.rankClaim != null` (old app build ⇒ excluded, fails closed), event window open.

### Every function that needs touching

| # | Location | Change |
|---|---|---|
| 1 | `FORMATS` `server.js:90` | new row `ranked: { prefix:'rnk', teamSize:1, goalsToWin:3, noBots:true, ranked:true }` |
| 2 | `applyFormat` `server.js:109` | carry `noBots` / `ranked` onto the room |
| 3 | `CARD_TO_FORMAT` `server.js:105` | map the new picker card id |
| 4 | **`fillBots` `server.js:237`** | **`if (room.noBots) return;` as the first line.** Highest-risk single edit — it is called from `startMatch:646`, `leaveCurrentRoom:576` (mid-match backfill), `startBotGame:510`, `startBuilderMatch:483` |
| 5 | `leaveCurrentRoom` `server.js:566` | ranked forfeit: leaver takes the loss, remaining human wins, end the match — **not** bot-backfill, **not** continue 1v0 |
| 6 | `startMatch` `server.js:602` | mint + attach the per-participant receipt; skip `fillBots`; add `oppRanks` to `matchStart` |
| 7 | `checkAfk` `server.js:679` | in ranked, AFK = forfeit, not `isBot = true` |
| 8 | `startCountdown` / `tickRoom` `server.js:594/698` | reuse; ranked rooms are already full when formed, so a shorter countdown is fine |
| 9 | `lobbyPayload` `server.js:815` | `showBots` (`:826`) must also exclude `room.noBots` — otherwise the ranked VS page previews bots that will never spawn |
| 10 | `join` handler `server.js:1123-1137` | store `ident.rankPoints` / `rankTier` / `rankedMatches` on `member` |
| 11 | `ws.on('close')` `server.js:1338` | drop the ranked queue entry (`leaveCurrentRoom` knows nothing about the queue) |
| 12 | `leaveRoom` handler `server.js:1276` | same |
| 13 | NEW `joinRanked()` / `tryFormRankedMatch()` / `dropFromRankedQueue()` | + a 1Hz driver (or piggyback the existing 5Hz `broadcastPresence` interval) |
| 14 | NEW msg types | in `{type:'ranked'}`, `{type:'rankedLeave'}`; out `rankedQueued{waiting,elapsed,band}`, `rankedTimeout`, `rankedIneligible{reason}` |
| 15 | `shared/football-auth.js` | pass the new claims through `verifyFootballToken` |
| 16 | NEW `shared/ranked-receipt.js` | pure sign/verify — unit-testable without a server |
| 17 | NEW `shared/ranked-queue.js` | pure banding + pairing math — unit-testable without a server |
| 18 | `shared/opponent-key.js` | add `opponentRanksFor(assigned, me, myTeam)` next to `opponentKeyFor` (keep `opponentKeyFor` — see §7) |
| 19 | `shared/rank.js` | `UNRANKED` state (`לא מדורג`); today `tierIndexFromRank(0)` = bronze, which is now a lie |
| 20 | `public/hub-rank.js` | render UNRANKED; drop `atBotCeiling` / `hub-tier-capped` (`:78`, `:98`) |
| 21 | `public/client.js` `MODES` `:2057` | new ranked row + launcher |
| 22 | `public/mode-art.js` `SCENES` `:65` | **a distinct scene is mandatory** — `test-modes-table.mjs` asserts every mode's art differs |
| 23 | `public/client.js` | the ranked POST + the reveal + the SALTIZ_RANK guard (§6) |
| 24 | pikme-server | rank claims at mint (`user.js:1026`); NEW `POST /football/record-ranked`; harden record-match auth |

### ⚠️ Collisions with in-flight work (from `AGENT_REQUEST_LOG.md`, 2026-07-26)

- **`bot-fix` (in progress) holds `shared/bot-ai.js` + `shared/difficulty.js` and says it "expects to also take `server.js`, `public/client.js`, `shared/bot-buffs.js`."** Direct collision on the **two biggest files ranked needs**. Take the orchestration lock (`football-mock:server.js`) or sequence behind them.
- **`session-open` just rewrote the FORMATS/`roomTeamSize`/`roomMax` block for 3v3** and touched `server.js`, `shared/sim.js`. A new FORMATS row lands in the exact same hunk.
- **`TASK-lobby-carousel.md`** owns `#play-strip` ordering + the `showScreen()` scroll reset in `public/client.js`. A new ranked card changes strip order and re-opens their "2v2 must be flush at the start edge" decision.
- **Pre-existing test fail:** `test-mode-format.mjs` fails when `:3013` is squatted by a live dev server (logged 2026-07-26). Don't attribute it to ranked work.
- **Not a blocker but adjacent:** 5v5 is hard-blocked by the u8 presence mask (`shared/wire.js:51`). Ranked at 1v1/2v2/3v3 is unaffected.

---

## 6. (e) The iOS app is owned by another dev — what ships without them

The current build injects (`football.jsx:172-175`, `bootJs`): `window.PIKME_FOOTBALL_TOKEN`, `window.PIKME_API`, `window.SALTIZ_XP`, `window.SALTIZ_RANK`, `window.SALTIZ_CARDS`. Post-match it relays a **fixed field list** to record-match (`football.jsx:277-291`) and injects the response via `injectXp` / `injectRank`.

### ✅ Works with the CURRENT build — no app release

| Piece | Why |
|---|---|
| Ranked queue, banding, timeout, humans-only rooms | 100% game-server side |
| Rank claims in the token | pikme-server mints it; the app just forwards whatever string it's given |
| Ranked eligibility, forfeit, AFK rules | game-server side |
| The signed receipt | game-server side; opaque to everyone else |
| **Submitting the ranked result** | **the game client can POST it itself.** `window.PIKME_FOOTBALL_TOKEN` is already injected; `apiGet`/`PIKME_API` already exist (`client.js:771-776`); prod CORS already whitelists `https://pikme-football.onrender.com` (`app.js:57`); `authFootball` reads the `football-auth` header (`middlewares/auth.js:44`). **The app is not in the loop at all.** |
| Hardening record-match to `auth` + server-resolved phone | the shipped app **already sends** the `auth` header (`services/http.js:44`) |
| UNRANKED badge, ranked mode card, ranked VS page, post-match ranked screen | all inside the WebView |
| Trophies continuing to pay every match | unchanged — the app's existing record-match call keeps doing exactly what it does |

### ⚠️ Degraded / needs a game-side workaround

**The post-match rank **delta** animation.** `bootJs` always sets `window.SALTIZ_RANK` at load, and `fetchOwnRank()` returns early when it's set (`client.js:800`) — so the game's self-fetch never runs in-app. After a match the app calls `injectRank(res.stats, res.rankDelta, d.botLevel)` from the **record-match** response, which (once rank is event-only) returns `rankDelta: 0`. Result: correct-ish number, **no reveal animation**, and a race between the app's inject and the game's own ranked POST.

**Workaround (game-side only):** after the ranked POST returns, the game **writes `window.SALTIZ_RANK` itself** — it owns the rendering of that global — and adds a short guard (`_rankedRevealAt`) that ignores an incoming app inject carrying `delta: 0` within ~10s. Ugly, contained, no app dependency. `SALTIZ_RANK.botLevel` will keep arriving from the app forever; `hub-rank.js` simply stops reading it.

### ❌ Genuinely blocked on the other dev (all cosmetic)

- A native ranked-event push/banner outside the WebView.
- Anything needing a **new** postMessage field relayed by the app (the field list is hard-coded).
- A shorter football-token TTL on a per-event basis (the app decides when it re-mints).

> **Answer: YES — a ranked mode is shippable game-side + server-side only.** The only casualty is the delta animation, and it has a game-side workaround.

---

## 7. (f) Deletions, and the test blast radius

### Verdict per symbol

| Symbol | Where | Verdict |
|---|---|---|
| `BOT_RATE` (0.4) | `football-rank.js:40` | **DEAD.** Also the floor of the mixed-roster rate (`:120-122`); with ranked humans-only the whole `rate` term goes. ⚠️ **Not** the same constant as `TROPHY_BOT_FLOOR` |
| `BOT_DAILY_CAP` (150) | `football-rank.js:41` | **DEAD** (`:130`) |
| `botCeiling` | `football-rank.js:55` **and** `shared/rank.js:37` | **DEAD in both.** With rank event-only the "raise the difficulty to keep climbing" nudge is a lie — bots pay 0 rank at every difficulty |
| `atBotCeiling` | `shared/rank.js:70` | **DEAD.** Consumers: `public/hub-rank.js:78` (`hub-tier-capped`) + `:98` (nudge copy). Replace the badge state with UNRANKED |
| `applyFarmGates` | `football-rank.js:183` | **STILL NEEDED — but only inside `seedRankFromXp` (`:204`)**, which is the grandfathering migration. Drop it from `tierFromRank` (`:194`) and drop the export. ⚠️ Degating the *seed* would silently **promote** bot-farmed accounts (20k xp / 0 human wins: gold 500 → diamond 1400). "Nobody is reduced" ≠ "everyone is raised" — keep the gate in the seed |
| `tierFromRank(...)` signature | `football-rank.js:193` | shrinks to `tierFromRank(rankPoints)`. Caller: `user.js:1321` |
| `winsVsBot` tier gate | `football-xp.js:72-73` | **DEAD** per the ruling. Keep the `winsVsHuman`/`winsVsBot` **columns** (shown in `footballPublicStats`, `user.js:1143`) |
| `TROPHY_BOT_FLOOR` (0.5) | `football-xp.js:22` | ✅ **STILL NEEDED — do not touch.** Trophies still pay bot matches at 50%; this is the single biggest lever on solo progression, and trophies are now the solo player's entire ladder |
| `xpFactor` | `client.js:560` → `user.js:1270` | **STILL NEEDED for trophies.** Dead on rank. Note it is client-computed |
| `rollDailyCounters` | `football-rank.js:153` | **DEAD** — it only rolls `botRankToday` |
| `botRankDate` / `botRankToday` cols | `footballstats.js:223-231` | dead data. Stop writing them (`user.js:1357-1358`); leave in the schema or drop in a later migration |
| `firstLossDate` / first-loss-free | `footballstats.js:233`, `football-rank.js:103` | **decision needed, not automatic.** "First loss of the day is free" in a ranked event = one free re-roll per day. See §8 |
| `opponentKey`, `countMeetings`, `OPPONENT_DAILY_LIMIT`, `opponentsToday`, `OPPONENTS_MAX` | `football-rank.js:42,150,161` | ✅ **STILL NEEDED, and more so.** A thin ranked pool + a 3–5× upset multiplier is the ideal win-trading environment |
| `applyRankDelta` / sticky `rankFloor` | `football-rank.js:140` | ✅ **STILL NEEDED** |
| `seedRankFromXp` | `football-rank.js:202` | ✅ **STILL NEEDED** (grandfathering). Needs a `rankedMatches` counter alongside it so UNRANKED is distinguishable — today `footballDefaults` gives a brand-new account `rankPoints: 0, rankTier:'bronze', rankSeeded: true` (`user.js:1190`), i.e. new players already read as bronze |
| `botLevel` + `botCeiling(botLevel)` in the response | `user.js:1300, 1376` | **DEAD in the response.** The chain `botLevel → SALTIZ_RANK.botLevel → atBotCeiling` dies together. The app will keep sending/injecting it; ignore it |
| `computeMatchRank` params | `football-rank.js:93` | drops `isBotMatch`, `botLevel`, `xpFactor`, `botRankToday`; **gains `oppRanks`** |

### Test blast radius — **do not edit these; this is the inventory**

| File | What dies | ≈ assertions |
|---|---|---|
| `pikme-server/test-football-rank.mjs` (248 lines) | constants `:36-37`; `botCeiling` block `:42-49`; mixed-roster/xpFactor `:75-80`; **BOT CEILING** `:94-105`; daily bot cap `:106-112`; `tierFromRank` gates `:129-132`; `rollDailyCounters` `:144-151`; seed-gate `:190-192`; **the entire JOURNEY block `:200-246`** (its premise is "a solo player climbing against bots") | **~40 — roughly half the file** |
| `pikme-server/test-football-xp.mjs` | GATE 1 `:50-52`, GATE 2 `:54-57`. ✅ `TROPHY_BOT_FLOOR` `:72` **survives** | ~5 |
| `football-mock/test-rank.mjs` | `botCeiling` `:64-68`, `atBotCeiling` `:70-75` | ~10 |
| `football-mock/test-rank-parity.mjs` | the `botCeiling` parity loop `:42-44`. ✅ `RANK_TIERS`/`TIER_MIN` parity **survives and must be extended** to the new upset table + `UNRANKED` | ~1 + new |
| `football-mock/test-hub-rank.mjs` | the capped-badge block `:72-95` incl. "botLevel absence must not read as difficulty 0" | ~8 |
| `football-mock/test-opponent-key.mjs` | ✅ **survives unchanged** | 0 |
| `pikme-server/test-football-token.js` | needs a **new** rank-claims assertion | +new |
| Live-server e2e likely to need a ranked case or to move on `lobbyPayload`: `test-mode-format.mjs` (:3013), `test-vs-consistency.mjs` (:3014), `test-3v3.mjs` (:3015), `test-party.mjs`, `test-challenge.mjs` | | |
| `football-mock/test-modes-table.mjs` | **fails the moment a MODES row is added** until `mode-art.js` gets a distinct scene (`:97` "every mode has a DISTINCT scene") | 1 hard fail |

---

## 8. Risks, ranked by how much they can hurt

1. **🔴 record-match is an open write endpoint, today.** ~11 s to forge legend rank, ~2 min to forge legend trophies, and any known phone can be grief-tanked. Fix before shipping *anything* that raises the value of a forged match.
2. **🔴 Ranked abandon is free.** `postMatchResult` only fires on `phase === 'ended'` (`client.js:6057`), so force-quitting mid-loss reports nothing. With a 3–5× upset payout the dominant strategy is "quit any match I'm losing". A server-side forfeit write is mandatory — which the recommended architecture supports (the game server knows who left), but **only if the game submits the result rather than the client.** ⚠️ This partially contradicts §6's "the game client POSTs it": the *forfeit* case needs a game-**server** POST (option 2's outbound call, for that one case). Budget for it.
3. **🟠 The 12h token TTL bounds opponent-rank staleness at a full ladder** (~7,200 points of theoretical drift). Mitigated by taking self-rank fresh from the DB and only opponent-rank from the receipt — but a player who climbs mid-session pays out as their session-start rank.
4. **🟠 `matchId` is not globally unique** (`matchSeq` resets on restart). It is already the idempotency key for record-match; making it security-relevant without fixing it invites cross-match collisions. Add a boot id.
5. **🟠 A 1v1 ranked queue at this population may simply never pair.** If the honest answer is "3 players queued in an hour", the event is a ghost town and the loose band means every match is a max-multiplier upset. Instrument queue depth **before** tuning the curve.
6. **🟠 Loose bands + big upset multipliers = rank inflation.** The user's own tension, flagged in the log: a deliberately loose matchmaker makes upsets the *normal* case, not the rare one. A per-event cap on upset payouts is likely required. (Curve is seat `13`'s call, not mine.)
7. **🟡 "First loss of the day is free"** becomes a free daily re-roll in a ranked event. Decide explicitly; don't inherit it.
8. **🟡 `fillBots` has 4 call sites**; missing the `leaveCurrentRoom:576` one silently backfills a bot into a ranked match mid-game. Add a test that a `noBots` room never grows a bot.
9. **🟡 AFK-as-bot counts as human** (`server.js:685` + `client.js:549`) — "queue and put the phone down" is a live exploit surface in ranked.
10. **🟡 File collisions with `bot-fix`** on `server.js` + `public/client.js`. Sequence or lock.
11. **🟡 `durationSec` is always 120** — the abandon guard has never worked.

---

## Sources (all read this session)

**football-mock:** `server.js` (`:75-125` counters/COUNTDOWN, `:90-120` FORMATS/publicRooms, `:237-285` fillBots, `:374-394` joinMatchmade, `:566-582` leaveCurrentRoom, `:594-661` startCountdown/startMatch, `:679-687` checkAfk, `:697-746` tickRoom, `:815-853` lobbyPayload, `:1114-1347` WS handlers) · `shared/football-auth.js` · `shared/opponent-key.js` · `shared/rank.js` · `shared/constants.js:57` · `public/client.js` (`:540-584` postMatchResult, `:765-819` token/PIKME_API/fetchOwnRank, `:2057-2087` MODES, `:6057+` result trigger) · `public/hub-rank.js` · `public/mode-art.js` · `package.json` · `test-opponent-key.mjs` · `test-rank.mjs` · `test-rank-parity.mjs` · `test-hub-rank.mjs` · `test-modes-table.mjs` · `test-mode-format.mjs` · `test-vs-consistency.mjs` · `test-football-auth.mjs` · `AGENT_REQUEST_LOG.md` (2026-07-26) · `summery/TASK-lobby-carousel.md`

**pikme-server:** `app.js:12-75` · `middlewares/auth.js` · `routes-pikme/user.js` (`:945-996` phone helpers + internal-key, `:1019-1033` football-token, `:1115-1232` football stats/seed, `:1237-1383` record-match, `:1433+` leaderboard) · `routes-pikme/friends.js` (`:11-72`) · `data/footballstats.js` · `data/football-rank.js` · `data/football-xp.js` · `test-football-rank.mjs` · `test-football-xp.mjs` · `test-football-token.js`

**app:** `pikmeTV-saltiz/app/pages/football.jsx` (`:116-214` injects, `:255-310` onMessage) · `pikmeTV-saltiz/services/saltizFootball.js:32-38` · `pikmeTV-saltiz/services/http.js:36-54`
