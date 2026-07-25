# 15 — RANKED EVENT SPEC (מדורג) — the buildable ruling

> Chair spec, 2026-07-26. Merges seats [`12`](12-ranked-event-mode.md) (event mode) · [`13`](13-upset-curve-math.md) (curve) · [`14`](14-ranked-wire-feasibility.md) (wire).
> SPEC ONLY — no `.js` touched, no test touched, no commit. Settled by the user: **rank is earned ONLY in ranked events, humans only. Upsets pay much more.**
> `V` = verified in shipped code or a cited shipped game · `I` = inferred (my design, argue with it).

---

## 1. THE UPSET TABLE

`g = oppTeamTier − myTeamTier`, fractional tier index, clamped `[−4, +4]`. **Absolute rank points. This table IS the delta — the shipped per-tier `BANDS` is deleted.** (Seat 13, adopted verbatim.)

| g | Hebrew chip | **WIN** | **LOSS** | **DRAW** | ×vs even win | break-even WR |
|---|---|---|---|---|---|---|
| ≤ −4 | 4 דרגות מתחתיך | **+4** | −26 | −10 | 0.16x | 86.7% |
| −3 | 3 דרגות מתחתיך | +6 | −24 | −8 | 0.24x | 80.0% |
| −2 | 2 דרגות מתחתיך | +9 | −22 | −6 | 0.36x | 71.0% |
| −1 | דרגה מתחתיך | +15 | −21 | −3 | 0.60x | 58.3% |
| **0** | דרגה שווה | **+25** | **−20** | +2 | **1.00x** | 44.4% |
| +1 | דרגה מעליך | +45 | −16 | +8 | 1.80x | 26.2% |
| +2 | 2 דרגות מעליך | +65 | −11 | +14 | 2.60x | 14.5% |
| +3 | 3 דרגות מעליך | +85 | −7 | +19 | 3.40x | 7.6% |
| ≥ +4 | 4 דרגות מעליך | **+105** | **−5** | +24 | **4.20x** | 4.5% |

Win row `= 25 + 20g` for `g ≥ 0` (`I`) — the teachable rule is **כל דרגה מעליך = +20**. Loss row solved backwards from a target break-even ≈ `P(win) − 8pp`, so the break-even curve is one monotone line 86.7% → 4.5% at **every** tier. Elo cannot do this: `Δwin = K(1−E)` caps the upset ratio at exactly **2.00x** for every K and every D (`V`, proved). TrueSkill's `v(t) = φ(t)/Φ(t)` is unbounded and near-linear in the gap — a 3σ upset pays **4.12x** (`V`) — which is where "3–5x" is legitimate math. Shipped precedent for the magnitude: **Street Fighter 6**, floors +50/−40 with reported 250–300 LP on a big upset ≈ 5–6x (`V`, player-reported). Counter-example on record: **Tekken 8** pays the MOST at your own rank (`V`). **Team aggregate** (`I`): `T = mean(tierIdx) + 0.5·(max − mean)`, humans only — in 2v2 that equals `0.75·max + 0.25·min`, but do **not** ship the literal form: 3v3 is live and it deletes the middle player (`[bronze,bronze,legend]` reads 4.50 vs the correct 4.00). **Both teammates get the same delta.**

### The user's own case, worked out

| case | my T | opp T | g | table | **applied** | vs even |
|---|---|---|---|---|---|---|
| **ברונזה+ברונזה beat אגדה+אגדה** | 0.00 | 6.00 | +4 | **+105** | **+80** (rail 2) | **3.2x** |
| ברונזה+ברונזה beat ברונזה+ברונזה | 0.00 | 0.00 | 0 | **+25** | **+25** | 1.00x |
| אגדה+אגדה beat ברונזה+ברונזה | 6.00 | 0.00 | −4 | **+4** | +4 | 0.16x |
| 1v1: ברונזה beats אגדה | 0.00 | 6.00 | +4 | +105 | +80 | 3.2x |
| זהב+זהב beat אלוף+אלוף | 2.00 | 5.00 | +3 | +85 | +85 | 3.4x |

**"Level 1 beats two level 10s" = +80 applied. "Level 1 beats two level 1s" = +25. Ratio 3.2x applied (4.2x on the table).** Against the legends' own +4 for the reverse fixture the spread is **20x applied / 26x on the table.** Two such upsets = +160 = ברונזה → כסף in two matches; today the same two wins pay 60, a third of a tier.

- **Headcount does not multiply.** Beating one אגדה in 1v1 and two in 2v2 both pay +105 — the gap is tier distance, not opponent count. A headcount term would make 3v3 pay more than 2v2 for identical skill. Deliberate (`I`).
- **A carried ברונזה gets no bonus** (case 3 in seat 13: bronze+legend vs bronze+legend is `g = 0`, +25). Any "the weaker member gets more" rule is a paid boosting service. One protection kept: if my own side's internal spread ≥ 3 tiers, the **loss** uses `g = 0` (−20) so duoing down never costs more than a solo even loss.
- **Fractional `g`** (`I`, ~6 lines): integer buckets put a +20 (80%) payout cliff on a 1-rank-point difference (899 vs 900 gold/platinum); interpolation cuts that swing to 0.05 points. Display rounded.

### The two mandatory rails, and the order of operations

```
1. tierFrac both sides → aggregate → g (clamp ±4) → table lookup with interpolation
2. clamp |delta| to MAX_DELTA = 0.4 × width of MY CURRENT tier
      bronze 80 · silver 120 · gold 160 · platinum 200 · diamond 320 · champion 400
3. bonus = delta − delta(g=0); if bonus > 0, draw it from UPSET_BUDGET = 200 / player / EVENT
      (never cap a NEGATIVE bonus — the cheap loss at g>0 must survive an empty budget)
4. if rankPointsBefore < TIER_MIN[1] (200) → loss = 0     [replaces BANDS[0].loss = 0]
5. applyRankDelta() — sticky rankFloor unchanged
```

Rail 2 is not optional: uncapped, +105 on a ברונזה at 150 lands on 255 and the sticky floor makes כסף **permanent** (`V` against `applyRankDelta`). Rail 1 is not optional either: uncapped, a 14–20% win rate in a thin queue reaches **אגדה in ~290 matches**; with the budget that same grinder is parked at כסף 250 after 400 matches, while an honest זהב over 60 matches spends only **57–145 of 200** — the rail binds the exploit, not the player. `UPSET_BUDGET = 200` is exactly the sum of the four full win bonuses (20+40+60+80): *each rung you skip pays full price once per event*; a ברונזה max-upset win draws 55 (80 − 25), so ~3.6 per event.

Two gates cheaper than any cap (`I`): **ranked is matchmaker-assigned ONLY** — no challenges, no private rooms, no accepted invites on the rank track (queueing up is worth 2.5x gap-0 EV, which is a feature only when you cannot choose) — and `UPSET_MIN_MATCHES = 5`, no upset bonus in your first 5 ranked matches outside your placement event, or "make an alt, feed your main" is a +105/match pipe. **The post-match chip is part of the table, not decoration:** `2 דרגות מעליך · ×2.6` and `יריב חוזר · 60%`. A win paying anywhere from +4 to +105 with no explanation reads as randomness — the #1 complaint in [`05-psychology`](05-psychology-migration-fit.md). **Ship the chip or don't ship the table.**

---

## 2. THE RANKED EVENT

**WINDOWED, not always-on.** The user's ruling ("special event") settles this; the arithmetic agrees. DAU ≈ 15% of ~150 MAU × 25 min/day → **PCU ≈ 2–3 for the whole game**, of whom ~⅓ pick ranked → `C ≈ 1`: with `w = (N−1)p/(2C−N+1)`, `p = 3.0 min`, the 2v2 queue never fills and 1v1 barely does. A **75-minute** window at 25–40% attendance of ~150 MAU gives `C ≈ 24` — **3.6x the concurrency of a 3-hour window at identical attendance** (`I`, all figures).

| decision | value | basis |
|---|---|---|
| Format | **1v1** (`RANKED_TEAM = 1`) | 1v1 hits a 60s median at `C ≥ 2`; 2v2 needs `C ≥ 6`, or 12 once split into rank bands. 1v1 also removes the carry-attribution problem a 4x multiplier makes acute. **Cost named: the product is 2v2 football.** 2v2 ranked is slice 2, gated on a measured `C ≥ 12` in a real window. `spawnPos` already handles `k===1` (`V`, `shared/sim.js:171-184`); `1v1`/`teamSize:1` exists nowhere yet (`V`, grep) |
| Cadence | **2 windows/week**, 75 min | Thursday 20:30 + Saturday 21:00 Israel time — NOT Friday (`I`, unmeasured, see Q2) |
| Match budget | **10 ranked matches / player / event** | FUT Champions ships 15/5 (`V`). 10 × ~4 min ≈ 40 min inside a 75-min window; the budget is what keeps attendees resident, which is what *produces* the concurrency |
| Entry gate | **≥ 1,000 גביעים** + 3 placements | double anchor: literally `XP_TIER_MIN[1]` (`V`, `football-xp.js:55`) AND Brawl Stars' literal Ranked gate (`V`). ≈ 9–17 matches. **No card/hero gate** — Brawl Stars gates brawlers only because it has a ban/pick phase; we don't |
| Placements | **3**, unbudgeted | Badge hidden until 3 are played (Rocket League's rule, `V`). **No separate seeding formula** — the gap table *is* the placement system: an unranked player at 0 meets everyone at `g = +2…+4` and the gap auto-tapers. Legacy players simply continue from their `seedRankFromXp` value; nobody is reduced |
| Season / reset | **rankPoints NEVER reset** | 10–20 matches/month at perfect attendance; a reset would consume a player's entire month. Rocket League **Tournaments** model (`V`): fresh bracket, persistent rating. What resets is a per-event leaderboard (`לוח האירוע`). Inactivity = a `לא פעיל` label after 4 missed events, never a points loss |

### Queue behaviour when it starves — no bots on any path

| t | band | Hebrew |
|---|---|---|
| 0–20s | ±150 rank pts (≈¾ of ברונזה) | `מחפש יריב… 0:12` |
| 20–60s | +150 every 10s | `מרחיב חיפוש` |
| 60s+ | **uncapped — any rank** | `מחפש בכל הדרגות` |
| 120s | stop | `התור דליל כרגע` + `[ המשך לחכות ]` `[ משחק רגיל · גביעים בלבד ]` |

The band is deliberately loose: a tight matchmaker would *prevent* the upsets the user asked to reward. **The word `בוט` must never appear in the ranked flow.** A ranked leaver **forfeits** (loss at 100% of the band, opponent gets the win); AFK ≥ 10s is a forfeit too, not `isBot = true` (`V`, `checkAfk` server.js:679 — "queue up and put the phone down" is a live exploit). **Repeat-opponent decay replaces the `OPPONENT_DAILY_LIMIT = 3` cliff** (`I`): meeting 1/2/3/4+ pays **100% / 60% / 30% / 0%**. Mandatory, not cosmetic — at `C = 9` on a 10-match budget, `Binom(10, 1/8)` gives `P(X≥3) = 0.119` and **0.96 expected opponents met 3+ times per player per event**, so today's cliff would fire innocently on ~60% of players every event and read as a bug.

### The rescaled climb — at event volume, 65% win rate, 10 matches/event, 2 events/week

The gap table **is** the rescale. **Do NOT also apply seat 12's `BANDS` v2** — the two together are ~4x too fast (ברונזה would pay +70 at `g=0` and +294 uncapped at `g=+4`).

| tier | reached | week | rankPoints | typical `g` while there | today @65% (flat) |
|---|---|---|---|---|---|
| **כסף** 200 | **event 1** | 1 | ~360 | +2 | event 1 (10 matches) |
| **זהב** 500 | **event 2** | 1 | ~600 | +1 | event 3 (28) |
| **פלטינה** 900 | event 6 | 3 | ~970 | 0 | event 6 (58) |
| **יהלום** 1400 | event 24 | 12 | 1400 | −1 | event 12 (115) |
| **אלוף** 2200 | — | — | parked at 1400 | −2 | event 31 (308) |
| **אגדה** 3200 | — | — | — | −3 | event 98 (974) |

The `today` column reproduces seat 12's own 10/28/58/115/308/975 figures at 65% WR, so the model is calibrated against numbers the user already holds. **Shape: a player leaves their first ranked night with כסף and their second with זהב** (which is what seat 12 asked the rescale to buy), and **the top of the ladder is gated by population, not by the numbers.** `seedRankFromXp` roofs at 900 (`V`), so in season 1 the observable gap range is **−2.00…+2.00**: the `+3/+4` rows are dead code, and a 65% player at יהלום faces `g = −2` (net −18.5/event) and oscillates on the sticky floor at 1400. **אלוף and אגדה are unreachable until the population itself contains diamonds** — which is the correct shape for a 300-user base and means the scary numbers are unreachable until there is data to re-tune them with.

**This reverses seat 12's risk 4: do NOT soften the sticky floor** — in a top-heavy thin queue it is the only thing keeping the strongest players climbing at all. Let the **per-event leaderboard** carry the short-term competitive weight instead.

---

## 3. UNRANKED STATE + HEBREW UX

`unranked = (rankedMatches|0) === 0 && (rankPoints|0) === 0` (`V`) — `rankSeeded` is **not** the discriminator: `footballDefaults` (`user.js:1190`) sets `rankPoints:0, rankTier:'bronze', rankSeeded:true` on brand-new accounts too. A legacy account seeded to 640 shows **זהב** unmarked; a new account shows **לא מדורג**. Needs exactly one new field, `rankedMatches`. `footballPublicStats`' two `|| 'bronze'` fallbacks (`user.js:1148`) must learn `unranked` or the leaderboard mislabels every unranked player as ברונזה. **Badge** (`#hub-tier`, `public/hub-rank.js`): **not an 8th `TIER_MIN` entry** — that breaks the parity test and every `TIER_ART[idx]` lookup — but a separate render branch: dashed greyscale outline `c1 '#d4dae0' / c2 '#8a939c'`, a **dashed shield glyph** (not an emoji — `❔` reads as "mystery reward"), and a **dashed empty meter with NO fill** (`V`: `tierProgress(0)` returns 0, and a 0%-filled *solid* meter is pixel-identical to "ברונזה, no progress" — the exact confusion this removes). Label `לא מדורג`; sub-line `שחק 3 משחקי דירוג באירוע הבא כדי לקבל דרגה`; during placements `דירוג 2/3` with the tier hidden.

**Mode card — CLOSED** (dimmed, never hidden, or nobody learns the mode exists): `🏅 מדורג [ סגור ]` · `נפתח בעוד 1 ימים 04:12` · `חמישי 20:30 · שבת 21:00` · `[ 🔔 תזכיר לי ]`. Granularity `>24h` days+hh:mm · `<1h` mm:ss · `<5min` pulsing.
**Mode card — OPEN:** `🏅 מדורג ● פתוח נסגר 41:12` · `9 בתור · 3 משחקים כרגע` · `נשארו 7 מ-10 משחקים` · `[ שחק מדורג ]`. `9 בתור` is the single most important anti-death-spiral element — nobody queues because nobody is queueing. Cheap: the server already broadcasts `{type:'home', online}` to every lobby member (`V`, `server.js:871-873`), so `rankedQueue` is a field on an existing broadcast. **Never render a bare `0 בתור`** — at 0–1 show `1 בתור · הזמן חברים` + share.

**RTL bug class to pre-empt:** every timer, every `7 מ-10`, every rank delta needs `<span dir="ltr">` or `04:12` renders as `12:04`. **And at ~40 attendees of 300, ~87% of the base never touches rank** — show the existing free **trophy** tier badge in the hero slot for unranked players and swap in the rank badge only once placed, rather than burning the app's best pixels on a dead state.

---

## 4. HOW OPPONENT RANK REACHES THE DELTA

**Chosen: option 1 (signed rank CLAIMS in the football-token) for the READ + one game-signed match RECEIPT for the WRITE.** Zero new secrets, zero new outbound HTTP, zero new kickoff failure modes. Option 3 (pikme-server computes both deltas at record-match) is **dead, verified**: `opponentKey` is a per-player "who I faced" hash — A's key ≠ B's key in 1v1, and `test-opponent-key.mjs` asserts it out loud (`V`) — the report carries no opponent identity, and `matchId` is client-controlled. Option 2 (game fetches ranks live) is a later freshness optimisation only: `/handle-friends/rank` runs a full-collection `$setWindowFields` per call (`V`, `friends.js:51-63`), the 400 req/min/IP limiter caps it at ~100 ranked starts/min from one game IP, and it does not help the queue band at join time — which option 1 does, for free.

```
pikme-server mints football-token  +{ rankPoints, rankTier, rankedMatches }   (~4 lines, user.js:1026)
      ↓ 12h TTL (V) ≈ one WebView session
game `join` → member.rank → rankedQueue bands on it            [no HTTP anywhere]
      ↓
startMatch: game signs ONE receipt for the WHOLE match, HS256 with FOOTBALL_TOKEN_SECRET (V: game
  already holds it, server.js:80):  { v:1, ranked:true, matchId, eventId,
    parts:[{sub,tierFrac,team,result,score}], opponentKey, ticks, iat, exp:iat+600 }
      ↓ rides in matchStart, relayed by the client exactly as opponentKey already is (V)
EITHER client POSTs it:  POST /handle-user/football/record-ranked
  header football-auth: <PIKME_FOOTBALL_TOKEN>  → authFootball → req.userId
      ↓
pikme-server: verify sig → require req.userId ∈ receipt.parts → resolve every sub → phone
  (UserInfo.findById, friends.js:49 pattern) → each player's OWN rank read FRESH from the DB
  → opponent tiers from the receipt → computeMatchRank → applyRankDelta
  → idempotent on (matchId, sub)
```

**One receipt per MATCH, not per participant, and either side may submit it** (`I`, a change from seat 14). This is what closes the abandon hole: `postMatchResult` fires only on `phase === 'ended'` (`V`, `client.js:6057`), so today force-quitting a losing match reports nothing, and with 3–4x upset payouts quitting becomes the dominant strategy. A whole-match receipt means **the winner — who always wants to submit — settles both rows**, and a forfeit is reported by the surviving client. Seat 14's forfeit blocker ("needs an outbound POST from the game server") therefore dissolves; a game-server POST stays available as a later backstop for the case where *both* clients vanish.

**Trust boundary, stated:** the game client is inside a WebView in a public repo and is **fully owned by the attacker**. Therefore for ranked: identity comes from a verified JWT `sub` resolved server-side to a phone; `result`, `score`, `matchId`, `opponentKey` and every opponent tier come **only** from the game-signed receipt; the player's own rank base comes **only** from the DB (a stale base would corrupt the sticky floor); the opponent's tier may be stale-bounded because "the rank the match was actually played against" is exactly what the game saw. A client can then only **replay** (idempotent) or **withhold** (defeated by the counterparty's incentive). Freshness: the 12h token TTL bounds opponent drift at ~7,200 points in theory (288 matches × 25) — harmless where it lands, and it is why `g` keys on a coarse **tier index**, not exact points.

**🔴 Prerequisite, live today and unrelated to ranked:** `POST /handle-user/football/record-match` uses `authNonBlock` (never rejects) and takes `phone` from the body (`V`, `user.js:1237-1239`). At 400 req/min/IP that is **legend rank (3,200) in ~11 seconds** and legend trophies in ~2 minutes, plus grief-tanking any known phone. Fix is ~3 lines (`authNonBlock` → `auth`, resolve phone from `req.userId`) and needs **no app release** — the shipped app already sends the `auth` header (`V`, `services/http.js:44`). **Raising the value of a forged match before this lands is negligent.**

**Also fix in the same pass:** `matchId` uses a module-level `matchSeq` that resets on every process restart (`V`, `server.js:121-125,630`), so `pub-3-7` recurs after each Render deploy — it needs a boot id before becoming a signature payload and idempotency key. And `durationSec` is always the constant 120 (`V`), so the app's `>= 30` abandon guard has never worked; let the receipt carry the game's tick count.

---

## 5. WHAT GETS DELETED

| symbol | where | verdict |
|---|---|---|
| `BANDS` (all 7 rows) | `football-rank.js` | **DELETE** — replaced by §1. Not exported from `shared/rank.js` and **not asserted by `test-rank-parity.mjs`** (`V`: it checks only `RANK_TIERS`, `TIER_MIN`, `botCeiling(0..11)`, `TIER_HE`), so this is a one-repo change — but note that parity test exits green when the sibling checkout is absent, so "parity is safe" is conditional |
| `BOT_RATE` (0.4) + `BOT_DAILY_CAP` (150) | `football-rank.js:40-41,120-122,130` | **DEAD**, incl. the mixed-roster rate floor. ⚠️ `BOT_RATE` is **not** the same constant as `TROPHY_BOT_FLOOR` |
| `botCeiling` (60+80·L) | `football-rank.js:55` **and** `shared/rank.js:37` | **DEAD in both** — "raise the difficulty to keep climbing" is now a lie |
| `atBotCeiling` | `shared/rank.js:70` → `hub-rank.js:78,:98` | **DEAD** — the badge state becomes UNRANKED |
| `rollDailyCounters`, `botRankDate/botRankToday`, the `botLevel`+`botCeiling(botLevel)` response echo | `football-rank.js:153`, `footballstats.js:223-231`, `user.js:1300,1357-1358,1376` | **DEAD** — stop writing; drop columns in a later migration. The app keeps sending `botLevel` forever; ignore it |
| `winsVsBot` tier gate | `football-xp.js:72-73` | **DEAD** per the ruling. **Keep the columns** — shown in `footballPublicStats` |
| `computeMatchRank` params | `football-rank.js:93` | drops `isBotMatch`, `botLevel`, `xpFactor`, `botRankToday`; **gains `oppTiers`, `eventId`, `meetingIndex`** |
| `applyFarmGates` | `football-rank.js:183` | **KEEP — but only inside `seedRankFromXp` (`:204`)**; drop from `tierFromRank` (`:194`) and drop the export. ⚠️ degating the seed silently **promotes** bot-farmers (20k xp / 0 human wins: זהב 500 → יהלום 1400). "Nobody is reduced" ≠ "everyone is raised" |
| `TROPHY_BOT_FLOOR` (0.5) | `football-xp.js:22` | ✅ **DO NOT TOUCH** — trophies are now the solo player's entire ladder |
| `opponentKey`, `countMeetings`, `opponentsToday` | `football-rank.js:42,150,161` | ✅ **KEEP** — a thin pool + 4x upsets is the ideal win-trading environment. `OPPONENT_DAILY_LIMIT`'s 3rd-match cliff is replaced by the 100/60/30/0% decay |
| `applyRankDelta` / sticky `rankFloor` / `seedRankFromXp` | `football-rank.js:140,202` | ✅ **KEEP** — see §2, the floor is now load-bearing |
| `firstLossDate` / first-loss-free | `football-rank.js:103` | **decision needed** — in a ranked event this is a free daily re-roll. See Q3 |
| `fillBots` | `server.js:237` | **KEEP, gate it:** `if (room.noBots) return;` as line 1. Called from `startMatch:646`, `leaveCurrentRoom:576` (**backfills a bot into a LIVE match**), `startBotGame:510`, `startBuilderMatch:483` (`V`) |

**Test blast radius — inventory, do not edit ahead of the slice that breaks them:** `pikme-server/test-football-rank.mjs` ~40 assertions (≈half the file, incl. the whole JOURNEY block `:200-246`, whose premise is a solo player climbing against bots) · `test-football-xp.mjs` ~5 (GATE 1/2; `TROPHY_BOT_FLOOR :72` survives) · `football-mock/test-rank.mjs` ~10 · `test-hub-rank.mjs` ~8 · `test-rank-parity.mjs` 1 (botCeiling loop `:42-44`; tier parity survives and **must be extended** to the new table + UNRANKED) · `test-opponent-key.mjs` survives unchanged · `test-football-token.js` needs a new rank-claims assertion · **`test-modes-table.mjs` hard-fails the moment a MODES row is added** until `public/mode-art.js` SCENES gets a distinct scene (`:97`) — not optional. **≈64 assertions rewritten, 1 hard fail.** Live-server e2e that may need ranked cases: `test-mode-format.mjs`, `test-vs-consistency.mjs`, `test-3v3.mjs`, `test-party.mjs`, `test-challenge.mjs`.

**Collisions (`AGENT_REQUEST_LOG.md`, 2026-07-26):** `bot-fix` expects `server.js` + `public/client.js`; `session-open` just rewrote the FORMATS/`roomTeamSize` block for 3v3 — the same hunk a ranked FORMATS row lands in; `TASK-lobby-carousel` owns `#play-strip` ordering. Take the `football-mock:server.js` / `football-mock:public/client.js` locks or sequence behind them.

---

## 6. SHIP ORDER

| # | slice | verifiable by | app? |
|---|---|---|---|
| **S0** | **Harden `record-match`: `authNonBlock` → `auth`, phone from `req.userId`** | `curl` with no token → 401; app still records | ✅ no release (`auth` header already sent) |
| **S1** | Delete the bot-rank track (§5 rows 2–8); rank writes become no-ops for non-ranked matches | suite green after the ~64-assertion rewrite; a bot match returns `rankDelta: 0` | ✅ |
| **S2** | The gap table + rails as **pure functions**, with `g` forced to 0 (behaviourally a flat +25/−20/+2 ladder) | unit test every row, interpolation, `MAX_DELTA`, `UPSET_BUDGET`, the 2v2 and 3v3 aggregates | ✅ |
| **S3** | `rankedMatches` + UNRANKED in both repos + `footballPublicStats` fallbacks + the לא מדורג badge | legacy 640 → זהב; new account → לא מדורג; leaderboard shows neither as ברונזה | ✅ |
| **S4** | Rank claims in the football-token; game stores them on `member` at `join` | `test-football-token` assertion; game logs `member.rank` | ✅ |
| **S5** | `matchId` gains a boot id / UUID | two restarts produce no repeated id | ✅ |
| **S6** | `shared/ranked-receipt.js` sign/verify + `POST /football/record-ranked` (idempotent on `(matchId, sub)`) | forged sig rejected; replay writes once; both rows settle from one receipt | ✅ |
| **S7** | `shared/ranked-queue.js` (pure banding/pairing) + the 1v1 ranked room: `noBots` on all 5 `fillBots` paths, forfeit on leave + AFK | two-socket e2e: a `noBots` room never grows a bot; a leaver takes the loss and the opponent the win | ✅ |
| **S8** | Server-authoritative event window, agreed by BOTH repos (game gates the queue, pikme-server gates the rank write) + a manual admin open/close for event 1 | queue rejects outside the window; a receipt whose `iat` is outside it is rejected | ✅ |
| **S9** | UI: mode card open/closed + countdown + `N בתור`, the gap chip, `לוח האירוע`, **a new `mode-art.js` scene** | `test-modes-table.mjs` green; RTL check on every timer | ✅ |
| **S10** | Flip `g` from forced-0 to live; start logging `(g, result)` on match 1 | one real event, then re-solve the loss row from measured rates | ✅ |

**Nothing in S0–S10 is blocked on the iOS app** — the game client POSTs the ranked result with its own already-injected `window.PIKME_FOOTBALL_TOKEN`, prod CORS already whitelists the game origin, and `authFootball` reads the `football-auth` header (`V`). **⚠️ Blocked / degraded on the app we do not control:**
- **Post-match rank delta ANIMATION — degraded.** `bootJs` always sets `window.SALTIZ_RANK`, so the game's `fetchOwnRank()` returns early (`V`, `client.js:800`), and the app injects `rankDelta` from the *record-match* response, which will return 0. Workaround, game-side only: after the ranked POST the game writes `window.SALTIZ_RANK` itself and guards ~10s against an incoming `delta: 0` inject. Ugly, contained, no app dependency.
- **A native push/banner for the window — BLOCKED and load-bearing.** Push capability is **UNVERIFIED**; the whole windowed design depends on `תזכיר לי` delivering. Verify before locking a slot (see Q2). In-app countdown is not blocked.
- **Any NEW postMessage field — HARD BLOCKED.** The relay field list is hard-coded at `football.jsx:277-291` (`V`). Design around it; the receipt path already does. Same for a shorter token TTL per event — the app decides when it re-mints.

**Kill switch (`I`):** 3 consecutive events under 10 attendees → fold to one monthly event rather than let a dead queue teach everyone the mode is dead.

## 7. OPEN QUESTIONS (3)

1. **Format for the first ranked event: 1v1 (recommended) or 2v2?** 1v1 is the only format whose queue math works at this population (60s median at 2 concurrent vs 6 for 2v2), and the 1v1 path is needed anyway as the honest fallback for a starved 2v2 queue. The cost is real: the game people actually play is 2v2, and a 1v1 ladder measures a different game. **Recommendation: ship 1v1, add 2v2 once a real window measures `C ≥ 12`.**
2. **Lock Thursday 20:30 + Saturday 21:00 now (fast), or log `onlineCount()` hourly for two weeks first (recommended)?** The Shabbat/school-week logic is sound but the actual peak hour is unmeasured, the counter already exists, and the same two weeks are what it takes to confirm push notifications actually deliver — without push, a window nobody is told about may be worse than an always-on queue. **Recommendation: measure two weeks, run event 1 manually at a time you pick and attend personally.**
3. **Event budget: a hard 10 matches per player (recommended), or unlimited inside the 75-minute window?** A cap makes the per-event leaderboard a fair comparison, keeps attendees resident for the whole window (which is what produces the concurrency), and matches FUT Champions' shipped 15/5 format. Unlimited rewards whoever can stay up longest — which is the trophy track's job, not rank's. Bundled sub-decision: **drop the "first loss of the day is free" rule inside ranked** (it is a free daily re-roll in a 10-match event) while keeping it nowhere else.
