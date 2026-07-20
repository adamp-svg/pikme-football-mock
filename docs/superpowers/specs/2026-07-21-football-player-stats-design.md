# Football Player Stats + XP / Level / Rank — Design Spec

**Status:** Approved design (decisions locked 2026-07-21). Not yet implemented.
**Scope:** v1 — wins/losses/draws, vs-human vs vs-bot split, XP → level → rank tier, leaderboard + profile UI.

## Locked decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | Backend / owner | **Mongo `pikme-server`** — new phone-keyed `footballstats` collection |
| 2 | Do bot wins count | **Yes, XP × 0.2**, and **capped out of top tiers** (Platinum+ gated) |
| 3 | Progression depth | **XP-only** — level and tier are pure functions of XP (no separate trophy/MMR ledger in v1) |
| 4 | Seasons | **No for v1** — XP + tiers permanent |
| 5 | `matchId` idempotency | **Game emits `roomId + match-start tick`** as the stable key |

## Repos involved (absolute paths)

- **Game:** `/Users/adamleeperelman/Documents/pikeme/football-mock`
- **App (live):** `/Users/adamleeperelman/Documents/pikeme/pikmeTV-tf` — `pikmeTV-app` has no `football.jsx`
- **Backend:** `/Users/adamleeperelman/Documents/pikeme/pikme-server`
- (Not used: `saltiz-cards` Postgres — only its leaderboard *response contract* is mirrored.)

## Architecture — one line

The game stays 100% PII-free and emits a `matchResult` postMessage at match end; the app (which holds the phone) turns it into a phone-keyed write to Mongo `footballstats`, cloned from the existing `PlayerCardStats` / `bank-points` pattern. **XP is the single source of truth; level and tier are pure functions of XP; bot wins pay 0.2× and can't reach the top tiers.**

---

## 1. Outcome + reporting (zero PII in the game)

**Match-end trigger:** authoritative server sim flips `phase → 'ended'` at `MATCH_DURATION` (120s) — `football-mock/shared/sim.js:233-239`, `shared/constants.js:51`. The server never computes a winner; the client derives it for the banner at `football-mock/public/client.js:1762`. The game has no phone/token by design (`pikmeTV-tf/app/pages/football.jsx:90` passes only `name` + `avatar`) → **the game reports, the app attributes.**

### Payload emitted by the game (game → app)

```js
{
  t: 'matchResult',
  matchId: 'r17-4820',              // roomId + match-start tick — stable idempotency key
  result: 'win' | 'loss' | 'draw',  // from MY perspective
  myTeam: 'A' | 'B',
  myScore: 3,                       // latest.score[myTeam]
  opScore: 1,                       // latest.score[opTeam]
  durationSec: 120,                 // MATCH_DURATION (abandonment guard: <30 ⇒ app drops it)
  humanOpponents: 1,                // opponents.filter(!isBot).length
  vsHuman: true                     // humanOpponents > 0 — drives winsVsHuman/winsVsBot split
}
```

### client.js emit hook (no server/protocol change)

Everything needed is already present at `ended`: `latest.players` (frozen snapshot) and `matchRoster` (humans captured at match start, `client.js:507`, declared `:526`). A snapshot player is **human iff its id is in `matchRoster`**, else bot.

1. Module-level one-shot flag near `me` (`client.js:26`): `let matchResultSent = false;`
2. Reset inside `enterMatch()` beside the `matchRoster` reset (`client.js:507`): `matchResultSent = false;`
3. In the ended branch (`client.js:1762`), after setting the banner:
   ```js
   if (!matchResultSent) { matchResultSent = true; postMatchResult(myT, opT, myScore, opScore); }
   ```
   `postMatchResult()` reuses the one-way bridge (`window.ReactNativeWebView.postMessage`, same as `haptic()` at `client.js:129-131`), deriving `vsHuman` from `matchRoster` and `matchId` from room id + match-start tick.

**Known v1 limitation:** an AFK human flipped to bot mid-match still reads as "human" via roster. Acceptable for v1; server-authoritative `isBot` costs a wire bit — defer.

### App onMessage → backend write (`pikmeTV-tf/app/pages/football.jsx`)

The app already parses the bridge and holds identity: `phone` at `:105`, E.164 `identifier = normalizeIdentifier(phone)` at `:106`. Extend the existing handler (`:144-147`):

```js
onMessage={(e) => {
  const d = JSON.parse(e.nativeEvent.data)
  if (d?.t === 'haptic') fireHaptic(d.kind)
  else if (d?.t === 'matchResult' && identifier && d.durationSec >= 30) {
    saltizFootball.recordMatch(identifier, {
      matchId: d.matchId, result: d.result,
      goalsFor: d.myScore, goalsAgainst: d.opScore,
      vsHuman: d.vsHuman,
    }).catch(() => {})   // fire-and-forget; server idempotent on matchId
  }
}}
```

New service method `saltizFootball.recordMatch()` follows `pikmeTV-tf/services/saltizCards.js:60,86,96`.

---

## 2. Data model + ownership — Mongo `pikme-server`

### Model — new `pikme-server/data/footballstats.js` (clone of `data/playercardstats.js`)

| Field | Type | Notes |
|---|---|---|
| `phone` | String, unique, index | **the key** — E.164 |
| `userId` | ObjectId, optional | recorded if JWT present, NOT the key |
| `wins` / `losses` / `draws` | Number, default 0 | |
| `winsVsHuman` / `winsVsBot` | Number, default 0 | split on payload `vsHuman` |
| `goalsFor` / `goalsAgainst` | Number, default 0 | |
| `matchesPlayed` | Number, default 0 | |
| `streak` | Number, default 0 | signed: + win streak, − loss streak |
| `bestStreak` | Number, default 0 | max positive streak reached |
| `xp` | Number, default 0, **index** | **source of truth**; leaderboard sort key |
| `level` | Number, default 1 | denormalized `f(xp)`, recomputed each write |
| `tier` | String, default 'bronze' | denormalized `f(xp)` — named rank ladder |
| `rank` | Number, optional | **best-effort snapshot only** — live rank is `countDocuments({xp:{$gt:myXp}})+1` |
| `recordedMatchIds` | [String], default [] | idempotency guard (same role as `bankedTokens`) |
| `firstWinDate` | String (YYYY-MM-DD) | first-win-of-day gate |
| `updatedAt` | Date | manual, + `syncIndexes()` on connect |

Two invariants from the codebase's own lessons: `rank` is **never authoritative as a column** (goes stale the instant anyone else plays); `level`/`tier` are pure functions of `xp` stored denormalized for cheap reads, with `xp` authoritative.

### Endpoints — add to `pikme-server/routes-pikme/user.js` (mounted `/handle-user`)

Reuse `normalizeBankPhone` (`:938`) + `authNonBlock` (`:16`).

1. **`GET /handle-user/football/stats?phone=+972…`** (`authNonBlock`) — read-or-lazy-create via `findOneAndUpdate({phone},{$setOnInsert:…},{upsert:true,new:true})`. Clone of `/card-stats` (`user.js:995-1010`).
2. **`POST /handle-user/football/record-match`** (`authNonBlock`) — body `{phone, matchId, result, goalsFor, goalsAgainst, vsHuman}`. Atomic **guarded** write keyed on `recordedMatchIds:{$ne:matchId}` — exact shape of `/bank-points` (`user.js:1014-1052`): one `findOneAndUpdate` with `$inc` (win/loss/draw, winsVsHuman|Bot, goalsFor/Against, matchesPlayed, xp), `$push` matchId, `$set` recomputed streak/bestStreak/level/tier/updatedAt (+`userId` if `req.userId`). **XP delta computed server-side** from trusted fields — never trust a client-sent xp (see §3). Return `recorded:!!updated`.
3. **`GET /handle-user/football/leaderboard?phone=+972…`** (`authNonBlock`) — the one genuinely new piece. Mongo aggregation: `$setWindowFields:{sortBy:{xp:-1},output:{rank:{$rank:{}}}}`, `$lookup` to `usersinfos` for `nickName`/`image`, slice top-3 + caller ±3.

**Leaderboard reuse:** mirror the `saltiz-cards` **response contract** `{top, aroundMe, me:{rank,points}, totalPlayers}` so the app's `LeaderboardList` renders byte-identical for cards and football. No `/internal/nicknames-by-phone` hop and no album-token needed — Mongo already owns the nickname locally.

---

## 3. XP + Level + Rank (numbers)

Single-currency: XP is permanent and never resets; **level and rank tier are both pure functions of cumulative XP.**

### XP per match (computed server-side in `record-match`)

```
base    = win 100 | draw 50 | loss 30            // losers/drawers always paid (anti-rage-quit)
matchXP = (base + 10 * goalsFor)
matchXP *= opponentFactor                        // vsHuman 1.0 | vsBot 0.2
if (result==='win' && vsHuman && firstWinToday) matchXP += 200   // human win only; sets firstWinDate
streakBonus = win streak? +10 per consecutive HUMAN win from the 2nd, cap +50 : 0
matchXP += streakBonus
```

Worked examples: human win + 3 goals = **130** (+200 first-of-day = 330); human loss + 1 goal = **40**; human draw + 2 goals = **70**; **bot win + 3 goals = 26**.

### Level curve (triangular)

```
XP for level L → L+1 = 100 * L
Cumulative to reach L = 50 * L * (L-1)
Level from XP         = floor((1 + sqrt(1 + XP/12.5)) / 2)
```

`L10 = 4,500 XP`, `L20 = 19,000 XP`, `L30 = 43,500 XP`. At ~130 XP/human win ⇒ **~35 human wins to L10**, ~145 to L20.

### Rank tier ladder (from cumulative XP)

| Tier | Cumulative XP | ≈ Level |
|---|---|---|
| Bronze | 0 – 999 | 1–4 |
| Silver | 1,000 – 3,999 | 5–9 |
| Gold | 4,000 – 9,999 | 10–14 |
| Platinum | 10,000 – 19,999 | 15–20 |
| Diamond | 20,000 – 39,999 | 21–28 |
| Champion | 40,000 – 79,999 | 29–40 |
| Legend | 80,000+ | 40+ |

**Top-tier gate (locked in — decision #2 "capped from top tiers"):** Platinum+ requires `winsVsHuman ≥ 25`; Champion+ requires `winsVsHuman ≥ winsVsBot`. Checked cheaply on each write when deriving tier.

### Why this resists bot-farming

A bot win (26 XP) is **~1/5** of a human win (130); bot wins never trigger first-win-of-day (+200) or the streak bonus (both human-only); reaching Champion (40k) purely on bots ≈ **50 hours** of grinding, and the gate forecloses it entirely. Mirrors LoL / Marvel Rivals reduced-AI-XP consensus.

---

## 4. UI surfaces (reuse existing app screens)

- **Football leaderboard on Home** — `pikmeTV-tf/app/index.jsx` already renders the card `<LeaderboardList data={leaderboard} />` at `:197`. Add a sibling `useQuery` to `/handle-user/football/leaderboard` and a **Cards | Football toggle** feeding a second `<LeaderboardList>` — identical response contract ⇒ component unchanged (`app/components/home/LeaderboardList.jsx` verbatim).
- **Rank badge on the home character screen** — `tier` + `level` as a small badge next to the player's avatar/character (data from `/football/stats`). Always-visible progress hook.
- **Profile / stats screen** — read-only panel modeled on `app/pages/player-album.jsx`: tier badge, level + XP-to-next bar, W/L/D, win rate; a greyed "Practice (vs bots)" block for `winsVsBot`; goals for/against + goal diff; current/best streak. Tapping a leaderboard row opens it (same drill-down; names/images already local in Mongo).

---

## Key verified refs

- End trigger `football-mock/shared/sim.js:233-239`, `shared/constants.js:51`
- Emit hook `football-mock/public/client.js:1762` (+ `:26`, `:129-131`, `:507`, `:526`)
- App bridge + identity `pikmeTV-tf/app/pages/football.jsx:144-147`, `:105-106`, `:90-97`
- Write precedent `pikme-server/routes-pikme/user.js:938` (normalize), `:995-1010` (card-stats read), `:1014-1052` (bank-points guarded write)
- Model precedent `pikme-server/data/playercardstats.js`
- Leaderboard contract `saltiz-cards/web/app/api/leaderboard/route.ts`
- UI hub `pikmeTV-tf/app/index.jsx:64,81,197`, `app/components/home/LeaderboardList.jsx`, `app/pages/player-album.jsx`
- Service pattern `pikmeTV-tf/services/saltizCards.js:60,86,96`

---

## Build order (for the implementation plan)

1. **Backend** — `data/footballstats.js` model + 3 endpoints in `user.js` (clone bank-points guarded write; XP/level/tier helpers server-side). Unit-test the XP + tier-gate math.
2. **Game** — `matchResult` postMessage in `client.js` (one-shot flag, `matchId` from roomId+tick, `vsHuman` from roster). Deploy to Render.
3. **App** — `saltizFootball.recordMatch()` service + onMessage hook in `football.jsx`; Cards|Football leaderboard toggle; rank badge; profile screen. TestFlight build.
