# 10 — Integration reality + risk (the seat that says what BREAKS)

> Seat: integration + risk. No new game research — this is an audit of **our** code against the user's
> 7 rules. Written 2026-07-26. Companion seats: `06`–`09`; decision lands in `11-DECISION-v2-progression.md`.
> Baseline verified green before writing: `test-football-rank.mjs`, `test-football-xp.mjs`,
> `test-rank.mjs`, `test-rank-parity.mjs`, `test-hub-rank.mjs`, `test-opponent-key.mjs`,
> `test-aim-curve-and-api.mjs` — **all pass**.

---

## CONCLUSION (read this and stop if you read nothing else)

**1. The bot/human split is DEAD IN PRODUCTION. Rules #3 and #4 are not "new features" — they are a
one-line bug fix.** I booted the real game server and ran the client's own `postMatchResult` logic
against a real `matchStart`. A solo-player-vs-3-bots match reports:

```
matchStart.players = [{"id":"m-1","team":"A","isBot":false},
                      {"id":"bot-bots-1-1","team":"B","isBot":true},
                      {"id":"bot-bots-1-2","team":"A","isBot":true},
                      {"id":"bot-bots-1-3","team":"B","isBot":true}]
=> humanOpponents = 2 | vsHuman = true | humanCount = 4 | xpFactor = 1
```

Cause: `server.js:238` (`fillBots`) pushes bots into the same `roster` array that is sent as
`matchStart.players` (Task 18, so the intro could show bot cards). `client.js:3403` then does
`matchRoster = msg.players` — bots included — and `client.js:522` builds `rosterIds` from **all** of it.
The comment on `client.js:3470` still says "(humans)". The binary wire does **not** carry `isBot`
(`shared/wire.js:53-62`), so `matchRoster` is the client's only bot signal and it is being ignored.

Blast radius, today, for every player: `vsHuman` is always `true` → `user.js:1296`
`isBotMatch = !vsHuman` is always `false` → **`BOT_RATE`, `botCeiling`, `BOT_DAILY_CAP` and the
`TROPHY_BOT_FLOOR` clamp have never once fired.** A solo bot win pays the full human `+30` rank and the
full `100` trophy base. `winsVsBot` never increments, so the `champion+ requires winsVsHuman >= winsVsBot`
gate is trivially satisfied and 25 bot wins unlock platinum. Nothing tests this path — that is why it shipped.

**2. `stats` is a free, already-shipped side channel; `opponentKey` is a free *trusted* one.** The app
(`pikmeTV-saltiz/app/pages/football.jsx:277-291`) cherry-picks a fixed field list, so any *new* top-level
`matchResult` field is silently dropped and cannot ship on our schedule. But `stats: d.stats` is forwarded
**verbatim as an object**, and `opponentKey` is forwarded verbatim as a string that pikme-server slices to
40 chars (`user.js:1310`) while the game server *authors* it (`server.js:597`). 32 chars are used; **8 are
free**. So roster composition and a signed opponent band can reach pikme-server with **zero app change**.

**3. Opponent rank (#5/#7) is the only ask that needs net-new plumbing** — nobody in the pipeline knows
anybody's rank at match time. It is solvable without the app (mint a signed `rp` claim into the existing
football-token JWT), but it is a 5-file, 2-repo, parity-touching change. **Defer it.**

**4. Ask #6 taken literally deletes the locked §7.1 decision and walls off every solo player.**
Recommend the compromise below (BOT_RATE 0.4→0.25, ceiling capped at 500) rather than 0.

**Ship first: the bot-detection fix (#3/#4 prerequisite). Defer: opponent-strength scaling (#5/#7).**

---

## (a) Every file that must change, with line numbers

### `pikme-server/data/football-xp.js` — the TROPHY math
| Line | What | #Ask | Additive or breaking |
|---|---|---|---|
| `35-48` `computeMatchXp` | signature + body: split base into PLAYED + result; replace the single floor-clamp with a bot-**opponent** table | #2 #3 #4 | **additive** if new args are optional and defaults reproduce today's totals; **breaking to tests** otherwise |
| `37` `base = win 100 / draw 50 / 30` | this `30` **is** today's implicit "played" floor | #2 | re-expression = additive; a *new* additive term = breaking (see grind-curve risk) |
| `42-45` `Math.min(1, Math.max(TROPHY_BOT_FLOOR, f))` | **the line that makes 3-bot and 2-bot pay identically** (0.47 → clamped 0.5) | #3 #4 | breaking to `test-football-xp.mjs:76` |
| `22` `TROPHY_BOT_FLOOR = 0.5` | keep as the fallback when roster detail is absent | #3 | additive |
| `46` `+200 firstWinToday` | unchanged | — | — |
| `55` `XP_TIER_MIN` | **DO NOT TOUCH.** `football-rank.js:207-208` (`seedRankFromXp`) reads it, and the level ladder drives `botLevelFromXp` → bot difficulty → **rank ceiling**. Changing trophy payout speed silently re-times rank ceilings (§8's interlock) | all | breaking, invisibly, across both tracks |

### `pikme-server/data/football-rank.js` — the RANK math
| Line | What | #Ask | Additive or breaking |
|---|---|---|---|
| `40` `BOT_RATE = 0.4` | → 0.25, or 0 for a literal #6 | #6 | **breaking** to `test-football-rank.mjs:36,91,95-104,107-110,221-236`. Not parity-locked |
| `41` `BOT_DAILY_CAP = 150` | **dead code** if bots pay 0 rank | #6 | dead, not breaking |
| `55-58` `botCeiling()` | → `min(60+80*L, 500)`, or delete | #6 | **breaking + PARITY-LOCKED** (see (b)) |
| `93-135` `computeMatchRank` | insert the opponent-strength modifier **after** `124 scale(base, rate)` and **before** `125` streak | #5 | additive if the new arg absent ⇒ ×1.0 |
| `98` `base = win/loss/draw` | rank pays **0** for "played" — do not add a 4th arm | #2 | — |
| `108-116` bot branch | rewritten under #6 | #6 | breaking |
| `183-190` `applyFarmGates` | keep — under #6 it still gates the **badge** | #6 | unchanged |
| `202-216` `seedRankFromXp` | untouched code, **changed meaning**: under #6 the migration seed becomes the only way most players ever get out of bronze | #6 #e | semantic break |

### `pikme-server/data/footballstats.js` — the model
| Line | What | #Ask |
|---|---|---|
| `48-58` `winsVsHuman` / `winsVsBot` | semantics change the moment the bot bug is fixed; **forward-only**, existing totals are unrecoverable (see (e)) | #3 #4 |
| `221-231` `botRankDate` / `botRankToday` | dead under a literal #6 | #6 |
| `239-247` `opponentsDate` / `opponentsToday` | still needed; but see the `opponentKey` packing trap | #5 |
| — | **no new fields required** for #1/#2/#3/#4 with the channels in (c). #5 needs new fields only if you choose the match-ledger option in (d) | #5 |

### `pikme-server/routes-pikme/user.js` — record-match + stats
| Line | What | #Ask |
|---|---|---|
| `1241` `const vsHuman = !!req.body.vsHuman` | the single point where the bug's blast radius lands | #3 #4 |
| `1260` `firstWinToday` | unchanged | — |
| `1267-1268` `newWinsVsHuman` / `newWinsVsBot` | start behaving correctly after the fix | #3 |
| `1270` `xpFactor` read | must also parse the roster counts from the chosen channel | #3 #4 |
| `1272` `computeMatchXp(...)` call | new args | #2 #3 #4 |
| `1274-1287` `statInc` / `clampStat` | if you use the `stats` side channel, parse the new keys **here** and keep them out of `statInc` — they are not career tallies | #3 |
| `1296` `isBotMatch = !vsHuman` | → derive from bot-**opponent** count, not a boolean | #3 #4 #6 |
| `1300` `botLevel ?? 5` default | training (`server.js:382`) and builder (`433`) send no `diffLevel`, so `botLevel` is absent there | #6 |
| `1308-1311` `countMeetings` + `opponentKey.slice(0,40)` | **if you pack anything into `opponentKey`, split it off BEFORE this call** or the win-trading key fragments per roster shape and the cap stops firing | #5 |
| `1312-1317` `computeMatchRank(...)` call | new args | #5 |
| `1324` `botRankGain` | dead under literal #6 | #6 |
| `1374-1377` response `{xpDelta, rankDelta, botCeiling}` | any **new** response field is invisible to the game — the app only relays `res.stats.xp` and `res.rankDelta` (`football.jsx:294-301`) | #2 (f) |
| `1140-1157` `footballPublicStats` | nothing required | — |
| `1439-1470` + `1507` leaderboard `sortBy: { xp: -1 }` | **if #6 means "the leaderboard is human-only rank", the sort key changes from `xp` to `rankPoints` and every visible position moves.** Flagging as a distinct reading of #6 | #6 |
| `1019-1032` `/football-token` (12h TTL at `1029`) | where a signed `rp`/`tr` claim would be minted for #5 | #5 |

### `pikme-server/routes-pikme/friends.js`
| Line | What | #Ask |
|---|---|---|
| `11` `router.use(authFootball)` | the **app-independent** auth path — the whole escape hatch in (c) lives here | all |
| `47-72` `GET /rank` | already returns `rankPoints/rankTier/rankPeak`; the natural home for a new "last match breakdown" read | (f) |
| `51-54` aggregate `sortBy: { xp: -1 }` | same sort-key question as above | #6 |
| `171` friends select `xp level tier wins` | under #6, friend rows arguably should show `rankTier`; today they don't | #6 |

### `football-mock/shared/rank.js` (game mirror)
| Line | What |
|---|---|
| `18-19` `RANK_TIERS` / `TIER_MIN`, `21` `TIER_HE`, `35-38` `botCeiling` | **all four are parity-locked** — see (b) |
| `69-71` `atBotCeiling` | under #6 "at ceiling" collapses into "bots never pay"; drives the copy at `hub-rank.js:98-102` |

### `football-mock/public/hub-rank.js`
| Line | What |
|---|---|
| `78` `hub-tier-capped` toggle | under #6 a bot player is permanently capped — the badge's visual dead end |
| `86-88` paint label | already LTR-isolates the number (correct) |
| `94-105` `tooltip()` | copy must change: "העלה את רמת הקושי" is meaningless if no difficulty pays |
| `136-158` `playRankReveal` | handles the down case already |
| `161-168` `flash()` | uses U+2212 inside `dir="ltr"` — **already correct**, pinned by `test-hub-rank.mjs:114` |
| `162` `if (!amount) return` | **under literal #6 every bot match is amount 0 → the badge says nothing, forever.** Needs an explicit "bot match — no rank" state or players report it as broken |

### `football-mock/public/client.js`
| Line | What |
|---|---|
| **`522`** `rosterIds = new Set(matchRoster.map(p => p.id))` | **THE BUG.** Fix: `matchRoster.filter(p => !p.isBot)` |
| `529-533` `xpFactor` derivation | already the graded per-bot-count signal #3 needs; **does not distinguish teammate from opponent** |
| `538-554` payload | `humanOpponents` / `humanCount` / `totalPlayers` are already sent and **dropped by the app** |
| `545` `durationSec: MATCH_DURATION` | a **constant 120**, not the real length — so the app's `>= 30` gate always passes |
| `3403` `matchRoster = msg.players` | source of the bug; `3470` comment says "(humans)" and is wrong |
| `766-788` `fetchOwnRank()` | the app-independent read path; the template for every new server→game field |
| `973`, `979-996` `renderHubXp` | shows `into / span` **within the level** — the player never sees a cumulative גביעים total anywhere |
| `1012-1024` `setXpBar`, `1093-1112` `fillWithLevels` | reveal internals |
| `1114-1124` `playXpReveal` | `1115` `if (_xpRevealing \|\| toXp <= fromXp) return` — the hard down-guard; `1120` hardcodes `'+'`, there is **no minus path at all** |
| `1863-1881` hub poll | calls `fetchOwnRank()`, `pollRank()` **and** `playXpReveal()` in the same 700 ms tick with **no mutual exclusion** — the trophy confetti and the rank drop can overlap |
| `4214-4218` `xpDiffLevel` → `botLevelFromXp` | the interlock: trophy level → bot difficulty → rank ceiling |

### `football-mock/server.js`
| Line | What |
|---|---|
| **`382` / `433` / `461` / `597`** | **FOUR `matchStart` senders** (training / builder / botgame / matchmade). Any new match-level field must be added to at least `597` **and** `461`. `461` already omits `opponentKey` and `intro`; `382`/`433` omit `diffLevel`. CLAUDE.md's own warning: "Two near-identical copies is exactly how goal-brawl drifted off the VS page" |
| `238` `rosterOut.push({..., isBot: true})` | the source the client must start respecting |
| `596-597` `opponentKeyFor(...)` | where a packed roster/opponent-band token would be authored |
| `1083-1092` `verifyFootballToken` → `member.userId` | where a signed `rp` claim would be read for #5 |

### Tests
| File | Lines | Effect |
|---|---|---|
| `pikme-server/test-football-xp.mjs` | `72-87` | every payout assertion rewrites under #2/#3/#4 |
| `pikme-server/test-football-rank.mjs` | `36-38`, `94-104`, `106-111`, `203-241` (JOURNEY) | constants + the whole bot-ceiling journey rewrite under #6 |
| `football-mock/test-rank-parity.mjs` | `34-49` | **the two-repo gate** — see (b) |
| `football-mock/test-hub-rank.mjs` | `71-95` (ceiling/capped), `97-121` (reveals) | copy + capped semantics under #6 |
| `football-mock/test-rank.mjs` | whole file | ladder display |
| `football-mock/test-opponent-key.mjs` | `27` `length === 32` | **breaks if you pack anything into the key** |
| **NEW, missing today** | — | **nothing tests `postMatchResult`'s human detection.** That is exactly why the bug shipped. This test is the deliverable, not an extra |

---

## (b) The parity trap — what must move in LOCKSTEP

`test-rank-parity.mjs` compares only these four things, and it **SKIPs** (exit 0) if the sibling
`../pikme-server` checkout is missing (`:20-23`) — so a CI box without both repos gives a false green.

| Constant | Server | Game | Asserted at |
|---|---|---|---|
| `RANK_TIERS` (7 names) | `football-rank.js:20` | `shared/rank.js:18` | parity `:34` |
| `TIER_MIN` `[0,200,500,900,1400,2200,3200]` | `football-rank.js:25` | `shared/rank.js:19` | parity `:36` |
| `botCeiling(L) = 60 + 80*L`, L0..L11 | `football-rank.js:55-58` | `shared/rank.js:35-38` | parity `:41-44` (**every** level, not the ends) |
| `TIER_HE` length + non-empty | — | `shared/rank.js:21` | parity `:47-49` |

**NOT parity-locked** (server-only, safe to change in one repo): `BANDS`, `BOT_RATE`, `BOT_DAILY_CAP`,
`OPPONENT_DAILY_LIMIT`, `STREAK_STEP/MAX`, `TROPHY_BOT_FLOOR`, `XP_TIER_MIN`, the whole `computeMatchXp`.

**Consequence for the 7 rules:** only #6 forces a two-repo change, and only through `botCeiling`. If you
adopt `min(60+80*L, 500)` you must edit **both** files in the same change and re-run parity. If instead you
express #6 as `BOT_RATE = 0` and leave `botCeiling` alone, **#6 becomes a single-repo change** — the game's
copy stays truthful (a ceiling nobody can reach is still the same formula). That is a real argument for
expressing #6 as a rate, not a ceiling.

`BOT_LEVEL_MAX = 11` is duplicated (`football-rank.js:45`, `shared/rank.js:26`) and is **not** asserted
directly — only implied by the parity loop's `L <= 11`. Silent drift risk.

---

## (c) The injection trap — what can ship without the app

The parent Saltiz app is another dev's (log 2026-07-25) and was dropped from the release train. Train is
now `pikme-server` → `football-mock`. So:

**What the app blocks (cannot ship on our schedule):**
- Any **new top-level `matchResult` field**. `football.jsx:277-291` destructures a fixed list
  (`matchId, result, myScore, opScore, vsHuman, xpFactor, stats, botLevel, opponentKey`). `humanOpponents`,
  `humanCount`, `totalPlayers` are *already being sent by the game and thrown away*.
- Any **new record-match response field**. The app only relays `res.stats.xp/level` and `res.rankDelta`
  (`football.jsx:294-301`).
- Any **new `window.SALTIZ_*` global** injected pre-load (`football.jsx:172-180`).
- The per-match `delta` for the rank reveal — only the app has it.

**What ships WITHOUT the app — four channels, ranked by trust:**

| # | Channel | Trust | Capacity | Precedent |
|---|---|---|---|---|
| 1 | **Game-side derivation** — filter `isBot` out of `matchRoster` (`client.js:522`) | same as today | full | none needed; the data is already on the client |
| 2 | **Packed `opponentKey`** — game *server* authors `"<32-hash>.<digits>"`, pikme-server splits on `.` before `countMeetings` | **game-server-authored, unforgeable by the player** | 8 chars (40-char slice at `user.js:1310`, 32 used) | `server.js:597` already authors it |
| 3 | **`stats` object side channel** — `stats: d.stats` is forwarded **verbatim**; `user.js:1274` reads named keys and ignores unknown ones | client-reported (same trust as today's `vsHuman`/`xpFactor`) | ~unbounded JSON | the whole per-player tally block |
| 4 | **Game pulls from pikme-server directly** with the football token — `client.js:768-788` `fetchOwnRank()` → `/handle-friends/rank` | server-authoritative read | full | built 2026-07-25 for exactly this reason |

**Verdict per ask:**
- **#1 confirm-only** — no channel needed.
- **#2 played/win/lose/tie** — pure server. Zero channels. **Ships today.**
- **#3 / #4 bot count** — channel 1 (fix the filter) is mandatory. Then, without *any* new channel, the
  server can already derive bot-opponent count from `xpFactor` + `vsHuman` for 3 of the 4 rosters (table
  below); channel 2 or 3 closes the 4th. **Ships today.**
- **#5 / #7 opponent rank** — needs a signed `rp` claim in the football-token JWT (mint at
  `user.js:1029`, read at `server.js:1083`, publish per-recipient at `server.js:597` via channel 2,
  unpack at `user.js:1310`). Zero app change, but **5 files across 2 repos + parity + 3 test files.**
- **(f) breakdown UI** — the response cannot reach the game through the app. Needs channel 4:
  a new `GET /handle-friends/last-match` on `friends.js` (already `authFootball`) returning the last
  recorded breakdown. **~25 lines, ships today.**

**Blunt version:** nothing in the user's 7 rules is unshippable because of the app. #5/#7 is unshippable
*on a short schedule* because of its own size, not because of the app.

---

## (d) Where does the game learn the OPPONENT'S rank? — nowhere, today

Trace, end to end:
1. **pikme-server** is the only holder of `rankPoints` (`footballstats.js:187`). It is keyed by **phone**;
   `userId` is explicitly "Optional… NOT the key" (`footballstats.js:19-23`).
2. **game server** knows each member's `userId` from the football token (`server.js:1083-1089`) — that is
   the joinable identity — but makes **zero outbound calls to pikme-server** (grepped: no `fetch`, no
   `PIKME_API`, no internal key). It does not know anyone's rank or trophies.
3. **game client** knows its **own** rank via `fetchOwnRank()`. It knows nothing about opponents'.
4. **record-match payload** carries, about the others: `vsHuman` (boolean), `xpFactor` (roster grade),
   `opponentKey` (an opaque **hash** — deliberately non-reversible, `shared/opponent-key.js:12-13`), and
   nothing else. No phone, no userId, nothing joinable to a stats doc.

**So opponent-strength scaling is impossible with today's payload.** Two minimal versions:

**Option A — signed claim in the football-token JWT (recommended).**
`GET /football-token` (`user.js:1021-1032`) already mints a JWT the app fetches and injects blind; the app
never inspects it. Add claims `rp` (rankPoints) and `tr` (xp) at mint. The game server already verifies the
token (`shared/football-auth.js`) → it learns every member's rank **without a network call and without the
app**. At `server.js:597` it packs the *per-recipient* opponent band into the spare `opponentKey` bytes
(channel 2). pikme-server unpacks at `user.js:1310`.
- Chain is fully server-authored → unforgeable.
- **Staleness: token TTL is 12h (`user.js:1029`).** Mitigate by shipping a coarse **tier index 0-6**, not
  exact points — a tier boundary is rarely crossed inside 12h. Optionally shorten TTL to 2h.
- Guests have no token → no claim → **modifier defaults to ×1.0**. Never guess.
- Cost: 5 files, 2 repos, `test-opponent-key.mjs:27` breaks, parity untouched.

**Option B — server-side match ledger (rejected as first pass).**
pikme-server stores a `{matchId, phone, rankPoints, team, result}` row per player; the *second* poster can
see the first's rank. Fatal flaw: the **first** poster cannot, so the payout must be two-phase, and the
`rankDelta` the app already injected into the reveal becomes wrong. New collection, new idempotency
surface, ordering-dependent payouts. Don't.

---

## (e) Live-user migration — the player sitting at 800 rank, earned from bots

Hard constraint from §migration: **nobody is reset or reduced.** What actually happens:

- **Their 800 is safe.** `applyRankDelta` (`football-rank.js:140-146`) only ever clamps from **below**
  (`Math.max(TIER_MIN[floorIdx], …)`). Nothing in any proposal here writes a lower number. `rankPeak`
  (`footballstats.js:193`) is `Math.max`-only at `user.js:1353`.
- **Their floor is safe.** 800 ⇒ `rankFloor = 2` (gold, `TIER_MIN[2] = 500`). They can never fall below 500.
- **Their badge does not change.** `winsVsHuman < 25` already caps them at gold (`applyFarmGates:187`), and
  800 is gold anyway. Zero visible change on day one. **This is the good news and it is real.**
- **What becomes unearnable is the NEXT tier.** 800 → 900 (platinum) is 100 points.
  - Today: L11 bots pay `round(25 × 0.4) = 10`/win → **10 bot wins**.
  - Literal #6: bots pay 0 → **impossible** without a human opponent, forever.
  - My compromise (BOT_RATE 0.25, ceiling 500): they are **already at/above the 500 ceiling** → bots pay 0
    → also impossible. Honest framing: the compromise protects *new* solo players (0→500 stays reachable);
    it does **not** re-open the path for someone already past 500.
- **The corruption you cannot undo.** Because of the bot bug, this player's `winsVsHuman` is inflated with
  bot wins and their `winsVsBot` is 0. There is no per-match history to recount from (`recordedMatchIds` is
  just ids). So after the fix, **the entire existing playerbase is grandfathered past the platinum gate**
  and the `winsVsHuman >= winsVsBot` champion gate can never trip for them. Options: (i) accept it and
  record a `humanStatsFrom` date for honesty; (ii) add a fresh counter pair and gate on those from the fix
  date. I recommend **(i)** — (ii) means an existing player suddenly needs 25 *more* human wins for a tier
  they can already see, which reads as a reduction even though no number moved.
- **`seedRankFromXp` changes meaning silently.** It maps a legacy **xp** standing (volume, much of it bots)
  onto the rank ladder. Under #6 that seed becomes the *only* route out of bronze for most players, i.e. a
  one-time gift of a human-only currency for bot volume. Not wrong — but say it out loud before shipping,
  because it is the single biggest unearned grant in the system.

**The dead wall, stated plainly:** under a literal #6, a player with no friends online has **no rank
progression, ever** — and the UI makes it worse than it sounds, because `hub-rank.js:162`
`if (!amount) return` means the badge shows **nothing at all** after every bot match. Silence, forever,
with no explanation. If #6 ships literally, that line must ship an explicit state with it.

---

## (f) UI truth — what the post-match screen can actually show

**There is no post-match screen.** The reveal happens on the **hub**, after `toHome`
(`client.js:3313-3317` arms it; `1863-1881` fires it). The two surfaces are a `50×42 px` badge and a thin
bar. 4 categories × 2 tracks is not renderable there.

**What must show (recommended):** one line, two chips, totals only.
- `+120 גביעים` — gold, confetti, counts up (`playXpReveal`).
- `+25 דרגה` / `−8 דרגה` / **nothing** — muted on a drop (`playRankReveal`, `flash`).
- Under literal #6, a bot match must add a third state: an explicit *"אין דרגה מול בוטים"* chip. Silence is
  read as a bug.
- **The 4-category breakdown belongs in the existing tooltip** (`hub-rank.js:94-105` already establishes
  "detail lives in the tooltip, the badge stays minimal"), or as one extra line in the canvas comic
  celebration (`triggerCelebration`) — e.g. `השתתפות 20 · ניצחון 80 · שערים 30`. Never four rows on the hub.

**Three concrete traps:**
1. **`playXpReveal:1115` — `if (_xpRevealing || toXp <= fromXp) return`.** A "played" payout means every
   match pays > 0, so this guard never blocks again and the **full golden confetti reveal fires on every
   loss.** Then the muted rank drop plays. Both are triggered from the same 700 ms poll tick
   (`1869-1879`) with **no mutual exclusion**. Serialize them — rank after xp — or a loss shows celebration
   and punishment simultaneously.
2. **RTL minus.** `hub-rank.js:165` already uses U+2212 inside `dir="ltr"` and `test-hub-rank.mjs:114`
   pins it. But `client.js:1120` `xpBigNum('+' + …)` **hardcodes the plus and has no minus path at all.**
   Fine while rule #1 holds — and it is a tripwire the instant anyone proposes a trophy decrease.
3. **No total is ever shown.** `renderHubXp` (`979-996`) renders `into / span` *within the level*. A player
   given four different per-category numbers still has no cumulative גביעים figure to check them against.
   If #2 ships, show the total.

---

## (g) The 7 asks ranked by value ÷ implementation risk

| Rank | Ask | Value | Risk | Repos | Verdict |
|---|---|---|---|---|---|
| **1** | **#3 + #4 bots vs humans, by bot count** | **highest — it is currently 100% broken, not merely coarse** | **lowest — one line at `client.js:522`, no parity, no app, no schema** | 1 (game) | **SHIP FIRST** |
| 2 | **#2 win / lose / tie / played** | high — answers the ask, enables an honest breakdown | low **if totals are preserved** (see numbers) | 1 (server) | ship with #1 |
| 3 | **#1 trophies only go up** | already true — confirm + pin it | ~zero (one new assertion) | 1 (server) | ship as a test |
| 4 | (f) **breakdown read endpoint** | medium — makes #2 visible without the app | low (~25 lines on `friends.js`) | 1 (server) | ship after #2 |
| 5 | **#6 rank between humans only** | high **as a product statement**, negative as literal code (kills solo progression, deletes locked §7.1) | **medium** — 2 repos if via `botCeiling`, 1 repo if via `BOT_RATE`; rewrites the whole `test-football-rank.mjs` JOURNEY | 1-2 | ship as `BOT_RATE 0.25` + the badge's bot state, **not** as 0 |
| 6 | **#5 opponent strength** | medium — matters at a playerbase we don't have (nobody is near diamond, §8) | **highest** — needs the JWT-claim chain, breaks `test-opponent-key.mjs:27`, 12h staleness | 2 | **DEFER** |
| 7 | **#7 rank XP by opponent rank vs trophies** | low — and half of it is wrong | medium | 2 | **DEFER + reject the trophy half** |

**Ship first: #3 + #4.** Repo reality, not theory: the fix is `matchRoster.filter(p => !p.isBot)` at
`client.js:522`. It touches one file in one repo, needs no parity run, no app build, no schema migration, no
new constant — and it turns on `BOT_RATE`, `botCeiling`, `BOT_DAILY_CAP`, `TROPHY_BOT_FLOOR` and the
`winsVsBot` gate, **all five of which are already written, already unit-tested, and have never executed.**
Everything else the council proposes is tuning a system that isn't running yet.

**Defer #5/#7.** Not because the math is hard — because it is the only ask that requires a new
identity-bearing claim in a JWT minted by one repo, verified by a second, packed into a hashed field by the
second, and unpacked by the first, with a 12-hour staleness window and a parity-adjacent test to rewrite.
And §8 already records that "rank's numbers have never been played, only simulated" and the top tiers are
"deliberately near-mythical at this playerbase". Opponent-strength scaling is a **diamond-and-above
problem** and, per `test-football-rank.mjs:230`, no bot-fed account can even reach diamond. Fix the thing
that is broken for 100% of matches before tuning the thing that matters for 0% of them.

---

## Numbers I propose

### N1 — Bot-opponent count the server can derive **TODAY**, with zero new fields
`otherHumans = round(((xpFactor − 0.2) / 0.8) × 3)` in a 4-slot match, cross-checked against `vsHuman`:

| `xpFactor` | other humans | `vsHuman` | Roster (2v2, from my seat) | Derivable today? |
|---|---|---|---|---|
| 0.20 | 0 | false | 2 bot opponents + 1 bot teammate | **yes, exactly** |
| 0.47 | 1 | **false** | 2 bot opponents + 1 **human** teammate | **yes, exactly** |
| 0.47 | 1 | **true** | 1 human + 1 bot opponent + 1 bot teammate | **yes, exactly** |
| 0.73 | 2 | true | **AMBIGUOUS**: (2 human opps + bot mate) vs (1 human + 1 bot opp + human mate) | **no** — needs channel 2 or 3 |
| 1.00 | 3 | true | 2 human opponents + 1 human teammate | **yes, exactly** |

3 of 4 rosters resolve with **zero** plumbing. Only 0.73 needs one extra digit.
⚠️ **Forward-compat:** these values are `otherSlots = 3`. The in-flight 3v3 mode makes `otherSlots = 5`
(0.36 / 0.52 / 0.68 / 0.84 / 1.00) and 1v1 makes it 1. **Never key a table on literal `xpFactor` values** —
always invert to a count, and carry `totalPlayers` if you can (channel 3).

### N2 — Trophy factor by bot-OPPONENT count (#3, #4). Every value ≥ today, so nobody is nerfed.
| Opponents faced | Factor today | **Proposed** | Change |
|---|---|---|---|
| 2 humans | 0.73 (mate is a bot) / 1.00 | **1.00** | up or same |
| 1 human + 1 bot | 0.47 → clamped **0.50** | **0.75** | **+50%** |
| 2 bots | 0.20 → clamped **0.50** | **0.55** | +10% |
| bot **teammates** | folded into `xpFactor` | **no effect** | a bot mate does not make the match easier |

This is what #3 actually asks for: 3-bot and 2-bot stop paying identically. Cost: replace `football-xp.js:42-45`.

### N3 — Win / lose / tie / played (#2), re-expressed at **identical totals**
| Term | Value | Today's equivalent |
|---|---|---|
| **PLAYED** (every recorded match) | **+20** | part of the loss base |
| + WIN | **+80** | → 100 ✅ same |
| + TIE | **+30** | → 50 ✅ same |
| + LOSS | **+10** | → 30 ✅ same |
| + per goal | **+10** (unchanged) | unchanged |
| + first win of day | **+200** (unchanged) | unchanged |

**Why identical totals matter and are not a cop-out:** the trophy curve is load-bearing.
`XP_TIER_MIN` → `levelFromXp` → `botLevelFromXp` → `botCeiling(L)` → **rank ceiling**. Inflating the played
term by even +10/match re-times every player's bot difficulty and therefore their rank ceiling — the §8
interlock, silently. Answer #2 as *presentation* first; re-tune the magnitudes as a separate, measured change.

Rank pays **0** for "played". Non-negotiable — otherwise a losable ladder pays for attendance.

### N4 — The #6 compromise (if the user wants "rank between humans only" without the dead wall)
| Constant | Today | Literal #6 | **Proposed** |
|---|---|---|---|
| `BOT_RATE` (`football-rank.js:40`) | 0.40 | 0 | **0.25** |
| `botCeiling` effective max | 940 (platinum) | n/a | **500 (gold entry)** — expressed as `BOT_RATE = 0` above 500, **not** as a formula change, to stay single-repo |
| Bronze bot win pays | `round(30×0.4)` = 12 | 0 | `round(30×0.25)` = **8** |
| Gold bot win at 499 | 10 | 0 | **6** |
| Anything at/above 500 vs bots | up to 940 | 0 | **0** |
| `BOT_DAILY_CAP` | 150 | dead | **60** (matches the lower rate) |
| Platinum+ / champion+ | human-gated | human-only | **unchanged — still human-gated** |

Result: a solo player can reach **gold** and no further. Platinum, diamond, champion, legend are
human-only — which is what #6 is really asking for — and nobody stares at a badge that has said nothing
for a month. **Note honestly: this reduces bot rank payouts (12 → 8), the only place in this whole document
where a number goes DOWN. It cannot reduce anyone's stored rank (`applyRankDelta` clamps from below only),
but a player who watches the numbers will notice.**

### N5 — Opponent-strength modifier, **if and when** #5/#7 ships
Applied to the **rank** delta only (preserves "trophies = volume, rank = skill"), inserted at
`football-rank.js:124`, before the streak bonus. Input is the **coarse tier index gap**
`g = clamp(oppTierIdx − myTierIdx, −2, +2)` — coarse because the JWT claim can be up to 12h stale.

| `g` | Win × | Loss × | Draw × | Played |
|---|---|---|---|---|
| +2 (two tiers above me) | **1.30** | **0.70** | 1.20 | 0 |
| +1 | 1.15 | 0.85 | 1.10 | 0 |
| 0 | 1.00 | 1.00 | 1.00 | 0 |
| −1 | 0.85 | 1.15 | 0.90 | 0 |
| −2 | **0.70** | **1.30** | 0.80 | 0 |
| unknown (guest / no claim) | **1.00** | **1.00** | **1.00** | 0 |

Worked example, gold player (`+25 / −8`): beating a diamond = `round(25×1.30)` = **+33**; losing to them =
`round(−8×0.70)` = **−6**. Beating a silver = **+21**; losing to them = **−10**. Uses the existing
`scale()` helper (`:73-75`) so it rounds away from zero.

**On #7 explicitly: use opponent RANK, never opponent TROPHIES.** Trophies are monotonic volume — an
80,000-trophy account that has only ever played bots is not strong, and after the bug fix that describes a
large share of the existing playerbase. Scaling a skill ladder by a volume counter would reward
grinding twice and is the exact duplication §8 removed.

---

## Risks, most serious first

1. **The bot bug means every shipped bot-farm defense has never run.** `BOT_RATE`, `botCeiling`,
   `BOT_DAILY_CAP`, `TROPHY_BOT_FLOOR`, `winsVsBot` — five mechanisms, fully unit-tested, zero executions.
   Every number this council tunes is being tuned against a system that isn't on. **Verified empirically.**
2. **The fix cannot be retroactive, so the anti-farm gates are permanently bypassed for existing accounts.**
   `winsVsHuman` is inflated with bot wins and there is no history to recount. The current playerbase is
   grandfathered past the platinum gate forever.
3. **Turning the bot rate ON is itself a live nerf.** After the fix, a solo bot win drops from `+30` rank
   and `100` trophies to `+12`/`~55`. No stored number decreases, but every future payout does. This is a
   perceived nerf on the majority path and needs to be announced, exactly as §migration warns.
4. **A literal #6 gives solo players zero rank progression AND a silent badge** (`hub-rank.js:162`). The
   worst combination: no progress and no explanation.
5. **`test-rank-parity.mjs` SKIPs when the sibling checkout is absent** (`:20-23`). A CI box with only the
   game repo reports green on a drifted ladder. The guard the council is relying on is conditional.
6. **Four `matchStart` senders** (`server.js:382/433/461/597`) with already-divergent field sets. Any new
   match-level field will ship to some modes and not others — and CLAUDE.md documents this exact failure
   mode from goal-brawl.
7. **Packing anything into `opponentKey` fragments the win-trading cap** unless the split happens before
   `countMeetings` (`user.js:1308-1311`). A subtle security regression from a UX feature.
8. **Changing trophy magnitudes silently re-times rank ceilings** via `XP_TIER_MIN` → `levelFromXp` →
   `botLevelFromXp` → `botCeiling`. The two tracks are not independent (§8 says so, approvingly).
9. **A "played" payout un-blocks `playXpReveal`'s down-guard on every match**, so losses now get the full
   golden confetti — overlapping the muted rank drop, with no mutual exclusion at `client.js:1863-1881`.
10. **The leaver hole widens under #6.** `postMatchResult` only fires on `latest.phase === 'ended'`
    (`client.js:6006`), from the leaving player's own client. Quit early and you never take the loss. Under
    human-only rank, dodging a losing human match becomes the single highest-value exploit in the game, and
    `OPPONENT_DAILY_LIMIT` doesn't touch it.
11. **12-hour JWT staleness** if #5 ships via Option A. Mitigated by shipping a tier index, not points.
12. **`durationSec` is the constant `120`** (`client.js:545`), so the app's `>= 30` abandonment gate
    (`football.jsx:276`) is dead code. Whatever "played" means, it is not gated on real duration.
13. **The player can never see their trophy total** (`renderHubXp` shows within-level progress only). Four
    new per-category numbers with no total to reconcile against.
14. **Concurrency:** `client.js`, `server.js`, `index.html`, `style.css` are frequently mid-edit by other
    agents (log, 2026-07-26). The one-line fix at `client.js:522` lands in the most-contended file in the
    repo. Take the lock `football-mock:public/client.js`.

---

## Sources — VERIFIED vs INFERRED

**VERIFIED — read in the shipped code, line-cited above**
- `pikme-server/data/football-rank.js`, `football-xp.js`, `footballstats.js`
- `pikme-server/routes-pikme/user.js` (record-match `1237-1383`, stats `1200-1232`, leaderboard `1433-1512`,
  `/football-token` `1021-1032`), `routes-pikme/friends.js`, `middlewares/auth.js:43-52`
- `football-mock/shared/rank.js`, `shared/opponent-key.js`, `shared/wire.js:40-72`, `shared/sim.js:223-226`
- `football-mock/public/hub-rank.js`, `public/client.js` (`519-557`, `730-790`, `960-1170`, `1856-1887`,
  `3395-3420`, `5995-6020`)
- `football-mock/server.js` (`205-239` `fillBots`, `382/433/461/597` the four `matchStart` senders,
  `1075-1092` join/auth, `1113` botGame)
- `pikmeTV-saltiz/app/pages/football.jsx:265-305`, `services/saltizFootball.js:16-38` — **the app's exact
  field list, which is what makes new fields unshippable**
- Tests read and run green: `test-football-rank.mjs`, `test-football-xp.mjs`, `test-rank.mjs`,
  `test-rank-parity.mjs`, `test-hub-rank.mjs`, `test-opponent-key.mjs`, `test-aim-curve-and-api.mjs`
- Prior council: `00-DECISION.md` §7 (locked) + §8 (swap + revision); `AGENT_REQUEST_LOG.md` 2026-07-25
  (app dropped from the train) and 2026-07-26 (this council's brief)

**VERIFIED BY EXECUTION — I booted the real game server (`PORT=3099`), joined over WebSocket, requested a
solo bot game, and ran `client.js`'s own `postMatchResult` logic against the real `matchStart`:**
```
matchStart.players = [{"id":"m-1","team":"A","isBot":false},{"id":"bot-bots-1-1","team":"B","isBot":true},
                      {"id":"bot-bots-1-2","team":"A","isBot":true},{"id":"bot-bots-1-3","team":"B","isBot":true}]
=> humanOpponents = 2 | vsHuman = true | humanCount = 4 | xpFactor = 1 | opponentKey = undefined
```
A solo-vs-3-bots match reports itself as a **full human match**. Not inferred. Reproducible.

**INFERRED — my design proposals, not observed anywhere**
- N1's derivation table (the arithmetic is verified; using it as the bot-count source is my proposal)
- N2 factors 1.00 / 0.75 / 0.55 and "bot teammates have no effect"
- N3's 20 / 80 / 30 / 10 split (the *totals* are verified as today's; the split is mine)
- N4's `BOT_RATE 0.25`, the 500 ceiling, `BOT_DAILY_CAP 60`
- N5's ±0.15-per-tier-gap modifier table
- Option A (the signed `rp`/`tr` JWT claim + packed `opponentKey`) — every *mechanism* it uses is verified
  shipped code; wiring them into this chain is my proposal
- The `GET /handle-friends/last-match` breakdown endpoint
- The ranking in (g)

**NO web research in this seat** — by design. Game precedent belongs to seats `06`–`09`; nothing here
claims another game does anything.
