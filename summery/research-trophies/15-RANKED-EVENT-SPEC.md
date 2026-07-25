# 15 — RANKED EVENT SPEC (מדורג) — the buildable ruling · **rev 2**

> Chair spec, 2026-07-26. Merges seats [`12`](12-ranked-event-mode.md) · [`13`](13-upset-curve-math.md) · [`14`](14-ranked-wire-feasibility.md). SPEC ONLY — no `.js`, no test, no commit. Settled by the user: **rank is earned ONLY in ranked events, humans only. Upsets pay much more.**
> **rev 2** answers two attacks (farm lens · build lens). Every citation re-run against HEAD `pikme-server 566996b` / `football-mock 226fe5f`, **2026-07-26 ~02:30**. Both repos are under concurrent edit — treat every line number as a **hint** and re-grep at implementation time.
> `V` = verified in shipped code or a cited shipped game · `I` = inferred (my design, argue with it).

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

Win row `= 25 + 20g` for `g ≥ 0` (`I`) — the teachable rule is **כל דרגה מעליך = +20**. Loss row solved backwards from break-even ≈ `P(win) − 8pp`, so the break-even curve is one monotone line 86.7% → 4.5% at **every** tier. Elo cannot do this: `Δwin = K(1−E)` caps the upset ratio at exactly **2.00x** for every K and every D (`V`, proved). TrueSkill's `v(t) = φ(t)/Φ(t)` is unbounded — a 3σ upset pays **4.12x** (`V`) — which is where "3–5x" is legitimate math. Magnitude precedent: **Street Fighter 6** floors +50/−40 with reported 250–300 LP on a big upset ≈ 5–6x (`V`, player-reported). Counter-example on record: **Tekken 8** pays the MOST at your own rank (`V`). **Team aggregate** (`I`): `T = mean(tierIdx) + 0.5·(max − mean)`, humans only — in 2v2 that equals `0.75·max + 0.25·min`, but do **not** ship the literal 2v2 form: 3v3 is live and it deletes the middle player (`[bronze,bronze,legend]` reads 4.50 vs the correct 4.00). **Both teammates get the same delta.**

### The user's own case, worked out

| case | my T | opp T | g | table | **applied** | vs even |
|---|---|---|---|---|---|---|
| **ברונזה+ברונזה beat אגדה+אגדה** | 0.00 | 6.00 | +4 | **+105** | **+80** (rail 2) | **3.2x** |
| ברונזה+ברונזה beat ברונזה+ברונזה | 0.00 | 0.00 | 0 | **+25** | **+25** | 1.00x |
| אגדה+אגדה beat ברונזה+ברונזה | 6.00 | 0.00 | −4 | **+4** | +4 (cap 400, no bind) | 0.16x |
| 1v1: ברונזה beats אגדה | 0.00 | 6.00 | +4 | +105 | +80 | 3.2x |
| זהב+זהב beat אלוף+אלוף | 2.00 | 5.00 | +3 | +85 | +85 | 3.4x |

**"Level 1 beats two level 10s" = +80 applied. "Level 1 beats two level 1s" = +25. Ratio 3.2x applied (4.2x on the table).** Against the legends' own +4 for the reverse fixture the spread is **20x applied / 26x on the table.** Two such upsets = +160 = ברונזה → כסף in two matches; today the same two wins pay 60, a third of a tier.

- **Headcount does not multiply.** Beating one אגדה in 1v1 and two in 2v2 both pay +105 — the gap is tier distance, not opponent count. A headcount term would make 3v3 pay more than 2v2 for identical skill. Deliberate (`I`).
- **A carried ברונזה gets no bonus** (bronze+legend vs bronze+legend is `g = 0`, +25) — any "the weaker member gets more" rule is a paid boosting service. One protection kept: if my own side's internal spread ≥ 3 tiers, the **loss** uses `g = 0` (−20) so duoing down never costs more than a solo even loss. **Fractional `g`** (`I`, ~6 lines): integer buckets put a +20 (80%) cliff on a 1-point difference (899 vs 900); interpolation cuts that swing to 0.05 points. Display rounded.

### Order of operations — every step is a rail, none is optional

```
1. myFrac  = my HIGH-WATER fractional tier, read FRESH from the DB at write time (never from a token)
   oppFrac = each opponent's tierFrac from the signed receipt ("the rank the match was played against")
   an opponent with < UPSET_MIN_MATCHES lifetime ranked matches contributes myFrac  → g = 0 both ways
2. aggregate both sides → g (clamp ±4) → table lookup with interpolation
3. clamp |delta| to MAX_DELTA = 0.4 × width of MY HIGH-WATER tier
      bronze 80 · silver 120 · gold 160 · platinum 200 · diamond 320 · champion 400 · legend 400 (FLAT)
4. bonus = delta − delta(g=0); if bonus > 0, draw it from UPSET_BUDGET = 200 / player / EVENT
      (never cap a NEGATIVE bonus — the cheap loss at g>0 must survive an empty budget)
5. delta ×= meeting multiplier (100 / 60 / 30 / 0%)  — GAINS AND LOSSES ALIKE, after step 4
6. if rankPointsRaw < TIER_MIN[1] (200) → loss = 0            [replaces BANDS[0].loss = 0]
7. rankPointsRaw += delta        ← THE LEDGER. Unfloored. Every delta lands here in full.
8. rankPoints (displayed) = max(rankPointsRaw, TIER_MIN[rankFloor])
9. rankFloor advances to tier i only after 3 ranked matches FINISHED with rankPoints ≥ TIER_MIN[i]
```

**Legend `MAX_DELTA` is 400 flat, not `0.4 × width`.** `TIER_MIN` has 7 entries (`V`, `football-rank.js:33`) so `TIER_MIN[7]` is `undefined`; executed, `0.4 × (undefined − 3200)` is `NaN`, and `applyRankDelta({rankPoints:3200, delta:NaN, rankFloor:6})` returns `3200` unchanged because `num()` maps `NaN` to its default of 0 (`V`, `:63-66`, executed). A legend would silently earn **nothing, forever, with no error**. S2 must assert `MAX_DELTA` is finite for all 7 indices.

**Rail 2 alone does not stop a bought tier** — it binds only in bronze (80 < the +105 table max); above bronze the clamp is a no-op, and `499+105 = 604`, `899+105 = 1004`, `1399+105 = 1504`, `2199+105 = 2304` each buy a **permanent** badge through the sticky floor. That is what **step 9** (promotion confirmation, 3 matches at or above the entry) is for — standard in Rocket League and Brawl Stars (`V`). One bought upset now lifts your points but not your badge. **Rail 1 is not optional either:** uncapped, a 14–20% win rate in a thin queue reaches **אגדה in ~290 matches**; with the budget that grinder parks at כסף 250 after 400 matches, while an honest זהב over 60 matches spends only **57–145 of 200**. `UPSET_BUDGET = 200` is exactly the sum of the four full win bonuses (20+40+60+80): *each rung you skip pays full price once per event*; a ברונזה max-upset win draws 55 (80 − 25), so ~3.6 per event.

Three gates cheaper than any cap (`I`): **ranked is matchmaker-assigned ONLY** — no challenges, no private rooms, no accepted invites on the rank track; **`UPSET_MIN_MATCHES = 5`, applied SYMMETRICALLY** (step 1) so a fresh alt can neither collect nor **confer** a gap bonus — gating only the receiving side leaves "make an alt, feed your main" wide open, because in that pipe the alt is the *loser*; and the pairing rules in §3. **The post-match chip is part of the table, not decoration:** `2 דרגות מעליך · ×2.6` and `יריב חוזר · 60%`. A win paying anywhere from +4 to +105 with no explanation reads as randomness — the #1 complaint in [`05-psychology`](05-psychology-migration-fit.md). **Ship the chip or don't ship the table.**

## 2. THE LEDGER — sticky **BADGE**, honest **POINTS**

rev 1 kept `applyRankDelta`'s floor as shipped and called the consequence cosmetic. That was the single largest hole in the spec. Executed: `applyRankDelta({rankPoints:1400, delta:−26, rankFloor:4})` → `1400`. Cost of a thrown loss at any tier entry: **exactly 0** (same at 900/floor 3, 2200/floor 5, 3200/floor 6). So every player parked at a tier entry is a **free loss sink**, and §3's own climb model predicts the whole top cohort parks there. Priced out: an AFK forfeit is 10 seconds of work (`checkAfk`, `server.js:694`) and pays the winner the **full** band; with the 100/60/30/0% decay ≈ 1.9 full-value meetings per opponent per event, 5 feeders deliver **238 pts/event at zero cost** and 1400 → 3200 is **8 events ≈ 4 weeks**, against "never" for the honest route. The ratio is not 3x, it is unbounded.

**The fix, ~4 lines, and it preserves "no relegation" exactly:** split the ledger from the display. `rankPointsRaw` is unfloored and takes every delta (step 7); `rankPoints` — the number the badge, the leaderboard and `g` all read — is `max(rankPointsRaw, TIER_MIN[rankFloor])` (step 8). **The badge still never drops.** But 20 thrown losses now cost 400 raw points the feeder must re-earn before its badge moves again, so the pump rate falls from 25 pts/delivered-match (free) to **5** — the pair's own net injection at `g = 0`. 1800 pts then costs **36 events ≈ 18 weeks**, every match of which must survive the matchmaker. It also removes the zero-stakes-at-the-ceiling degeneracy rev 1 accepted: an honest יהלום can now both gain and lose.

**`myFrac` is a HIGH-WATER fractional mark** (`I`, one new stored float): `max(live tierFrac, highest ever reached)`. Monotone, so **tanking is worth exactly 0** for every purpose — for `g` (dumping זהב 899 → 500 would otherwise raise your `g` against the same pool by a full +1.00 = +20/win = 1.80x on a leaderboard scored by points gained), for `MAX_DELTA`, and for the leaderboard. It keeps the fractional interpolation §1 defends. **`לוח האירוע` is scored on wins, tiebroken by mean `g` faced** (`I`) — skill-shaped and untankable. Not "points gained": that is the one payoff that makes a cross-event tank profitable, since the tank is paid for out of an event you were not going to win anyway.

**Settlement is order-independent, by construction and by check.** An unfloored ledger makes `raw + Σdelta` commutative, killing the "submit all my losses first, then my wins" laundering the floored version allowed (simulated at 5.0x unbounded / 1.8x inside a 600s window). Belt-and-braces, both cheap: `exp = iat + 180` (a legitimate POST fires seconds after `phase === 'ended'`, `V` `client.js:6092`), and per `(sub, eventId)` store the newest applied `iat` and reject anything older. S2 asserts that a **shuffled** receipt sequence yields the same final `rankPointsRaw`.

**Meeting decay scales the FINAL delta, gains and losses alike** (step 5). The rule it replaces did the opposite — `football-rank.js:133` gates on `... && base > 0` with the comment *"a loss still costs (below) — farming must never be risk-free"*. Inheriting that would let one rank-0 alt absorb unlimited tank-losses at the full −26 (זהב 899 → 500 is 16 losses to the same alt, decay never firing). Symmetric decay is a partial free pass on repeat opponents — say so in the code comment — and the unfloored ledger keeps the residual non-zero. S2 tests the loss case explicitly.

## 3. THE RANKED EVENT

**WINDOWED, not always-on.** DAU ≈ 15% of ~150 MAU × 25 min/day → **PCU ≈ 2–3 for the whole game**, of whom ~⅓ pick ranked → `C ≈ 1`: with `w = (N−1)p/(2C−N+1)`, `p = 3.0 min`, the 2v2 queue never fills. A **75-minute** window at 25–40% attendance gives `C ≈ 24` — **3.6x the concurrency of a 3-hour window at identical attendance** (`I`, all figures).

| decision | value | basis |
|---|---|---|
| Format | **1v1** (`RANKED_TEAM = 1`) | 1v1 hits a 60s median at `C ≥ 2`; 2v2 needs `C ≥ 6`, or 12 once split into bands. 1v1 also removes the carry-attribution problem a 4x multiplier makes acute. **Cost named: the product is 2v2 football.** `spawnPos` already handles `k === 1` (`V`, `shared/sim.js:175`); `teamSize:1` exists nowhere yet (`V`, grep) |
| Cadence | **2 windows/week**, 75 min | Thursday 20:30 + Saturday 21:00 Israel — NOT Friday (`I`, unmeasured, see Q2) |
| Match budget | **10 ranked matches / player / event** | FUT Champions ships 15/5 (`V`). 10 × ~4 min ≈ 40 min inside 75; the budget is what keeps attendees resident, which is what *produces* the concurrency |
| Entry gate | **≥ 1,000 גביעים** + 3 placements | literally `XP_TIER_MIN[1]` (`V`, `football-xp.js:130`) AND Brawl Stars' own Ranked gate (`V`). ≈ 9–17 matches. **No card/hero gate** |
| Placements | **3**, unbudgeted | badge hidden until 3 are played (Rocket League, `V`). **No separate seeding formula** — the gap table *is* the placement system. Legacy players continue from `seedRankFromXp`; nobody is reduced |
| Season / reset | **rankPoints NEVER reset** | 10–20 matches/month at perfect attendance; a reset would consume a player's whole month. Rocket League **Tournaments** model (`V`). What resets is `לוח האירוע`. Inactivity = a `לא פעיל` label after 4 missed events, never a points loss |

### Queue behaviour when it starves — no bots on any path

| t | band | Hebrew |
|---|---|---|
| 0–20s | ±150 rank pts (≈¾ of ברונזה) | `מחפש יריב… 0:12` |
| 20–60s | +150 every 10s | `מרחיב חיפוש` |
| 60s+ | **uncapped — any rank** | `מחפש בכל הדרגות` |
| 120s | stop | `התור דליל כרגע` + `[ המשך לחכות ]` `[ משחק רגיל · גביעים בלבד ]` |

The band is deliberately loose: a tight matchmaker would *prevent* the upsets the user asked to reward. But loose bands plus an isolated rank make two colluders each other's **only** legal opponent — a pair that pushes past 1050 is >150 from every honest player, so `P(paired) = 1.00` with no timing coordination at all, versus `1/8 = 0.125` under random pairing at `C = 9`. **Three pairing rules, in `shared/ranked-queue.js`** (`I`): (1) **never pair when the in-band candidate set has size 1 AND the two have already met this event** — widen the band and take the globally nearest rank instead, which pairs them with honest players at `g < 0`; (2) a **randomised 5–15s hold** before committing a pair, so simultaneous entry is not deterministic; (3) the queue is displayed as a **bucket**, never an integer (see §4).

**The word `בוט` must never appear in the ranked flow.** A ranked leaver **forfeits** (loss at 100% of the band, opponent gets the win); AFK ≥ 10s is a forfeit too, not `isBot = true` (`V`, `checkAfk` `server.js:694` — "queue up and put the phone down" is a live exploit). **Repeat-opponent decay replaces the `OPPONENT_DAILY_LIMIT = 3` cliff** (`V`, `:58`): meeting 1/2/3/4+ pays **100 / 60 / 30 / 0%**. Mandatory: at `C = 9` on a 10-match budget, `Binom(10, 1/8)` gives `P(X≥3) = 0.119` and **0.96 expected opponents met 3+ times per player per event**, so today's cliff would fire innocently on ~60% of players every event and read as a bug.

### The rescaled climb — 65% win rate, 10 matches/event, 2 events/week. The gap table **is** the rescale: do **NOT** also apply seat 12's `BANDS` v2, together they are ~4x too fast.

| tier | reached | week | rankPointsRaw | typical `g` | today @65% (flat) |
|---|---|---|---|---|---|
| **כסף** 200 | **event 1** | 1 | ~324 | +2 | event 1 (10 matches) |
| **זהב** 500 | **event 2** | 1 | ~561 | +1 | event 3 (28) |
| **פלטינה** 900 | event 4 | 2 | ~958 | +1 → 0 | event 6 (58) |
| **יהלום** 1400 | event 9 | 5 | ~1423 | 0 | event 12 (115) |
| **אלוף** 2200 | ~event 42 | 21 | 2200 | −1 | event 31 (308) |
| **אגדה** 3200 | population-gated | — | — | −2 | event 98 (974) |

Per-match EV at 65% WR: `g=+2` +38.4 (→ +324/event once `UPSET_BUDGET` binds at 5 bonused wins) · `+1` +23.65 · `0` +9.25 · `−1` +2.4 · `−2` −1.85. The `today` column reproduces seat 12's own 10/28/58/115/308/975 figures, so the model is calibrated against numbers the user already holds. **Shape preserved: a player leaves their first ranked night with כסף and their second with זהב.** This reverses seat 12's risk 4 in the only way that survives §2 — **keep the badge sticky, not the points** — with short-term competitive weight on `לוח האירוע`.

**Correction to rev 1: `seedRankFromXp` does NOT roof at 900.** It roofs at 900 only for accounts under the `winsVsHuman < 25` gate (`V`, `applyFarmGates:197`). Executed: `seedRankFromXp({xp:80000, winsVsHuman:200, winsVsBot:0})` → `{rankPoints:3200, rankFloor:6, rankTier:'legend'}`, and `test-football-rank.mjs` already asserts "legend entry seeds at 3200". So **the `+3/+4` rows are live in season 1, not dead code**, אלוף/אגדה seeds exist from day one, and the observable gap range is the full **−4…+4**. That is *why* the climb above is faster than rev 1's (a pool containing high seeds keeps a climber's `g` positive for four events instead of two) and why אלוף is reachable at ~event 42 rather than never. **אגדה stays population-gated** — the scary numbers stay unreachable by climbing until there is data to re-tune them with.

## 4. UNRANKED STATE + HEBREW UX

`unranked = (rankedMatches|0) === 0 && (rankPoints|0) === 0` (`V`) — `rankSeeded` is **not** the discriminator: `footballDefaults` (`user.js:1190`) sets `rankPoints:0, rankTier:'bronze', rankSeeded:true` on brand-new accounts too. A legacy account seeded to 640 shows **זהב** unmarked; a new account shows **לא מדורג**. Needs exactly one new field, `rankedMatches` (plus `rankPointsRaw` and the high-water frac from §2). `footballPublicStats` has **one** `|| 'bronze'` fallback, not two (`V`, `user.js:1148` — verified by grep across `routes-pikme/` and `data/`); it must learn `unranked`. The **leaderboard route needs no change**: `user.js:1504-1516` projects the *trophy* `tier`, never `rankTier`, so it cannot mislabel an unranked player on the rank track (rev 1 got the mechanism wrong here).

**Badge** (`#hub-tier`, `public/hub-rank.js`): **not an 8th `TIER_MIN` entry** — that breaks parity and every `TIER_ART[idx]` lookup — but a separate render branch: dashed greyscale outline `c1 '#d4dae0' / c2 '#8a939c'`, a **dashed shield glyph** (not an emoji — `❔` reads as "mystery reward"), and a **dashed empty meter with NO fill** (`V`: `tierProgress(0)` returns 0, and a 0%-filled *solid* meter is pixel-identical to "ברונזה, no progress"). Label `לא מדורג`; sub-line `שחק 3 משחקי דירוג באירוע הבא כדי לקבל דרגה`; during placements `דירוג 2/3`, tier hidden. **RTL bug class to pre-empt:** every timer, every `7 מ-10`, every rank delta needs `<span dir="ltr">` or `04:12` renders as `12:04`. **And at ~40 attendees of 300, ~87% of the base never touches rank** — show the existing free **trophy** tier badge in the hero slot for unranked players and swap in the rank badge only once placed.

**🔴 Pre-ranked regression to fix in the same slice: the padlock is on for everybody, right now.** `atBotCeiling` is not merely dead — as of `e78bc6d` it is `return true` unconditionally (`V`, `shared/rank.js:76`), because `botCeiling` now returns 0 and the body was reduced to a constant. `hub-rank.js:78` toggles `hub-tier-capped` whenever `botLevel != null`, and the app always injects a `botLevel` (`football.jsx:299`), so `rank.css:34-43` paints a hatched bar and a `🔒` on every player's badge. Delete `atBotCeiling` and both consumers (`hub-rank.js:78, :101`) and confirm `rank.css:34-43` has no remaining reference **before** the dashed UNRANKED state lands in the same 50×42px box.

**Mode card — CLOSED** (dimmed, never hidden, or nobody learns the mode exists): `🏅 מדורג [ סגור ]` · `נפתח בעוד 1 ימים 04:12` · `חמישי 20:30 · שבת 21:00` · `[ 🔔 תזכיר לי ]`. Granularity `>24h` days+hh:mm · `<1h` mm:ss · `<5min` pulsing.
**Mode card — OPEN:** `🏅 מדורג ● פתוח נסגר 41:12` · **`הרבה בתור · 3 משחקים כרגע`** · `נשארו 7 מ-10 משחקים` · `[ שחק מדורג ]`. The queue signal is the single most important anti-death-spiral element — nobody queues because nobody is queueing — but an **exact integer is a sniping oracle** (`2 בתור` tells a pair "my friend is the only other person here"), so ship **buckets**: `מעט בתור` (1–2) · `כמה בתור` (3–6) · `הרבה בתור` (7+). **Never render a bare `0`** — at 0 show `מעט בתור · הזמן חברים` + share. Cheap either way: the server already broadcasts `{type:'home', online}` to every lobby member (`V`, `server.js:886-888`, `onlineCount():135`), so the bucket is a field on an existing broadcast.

## 5. HOW OPPONENT RANK REACHES THE DELTA

**Chosen: signed rank CLAIMS in the football-token for the READ + one game-signed match RECEIPT for the WRITE, POSTed by the GAME SERVER.** Option 3 (pikme-server computes both deltas at record-match) is **dead, verified**: `opponentKeyFor` hashes only the opponents of `me` (`V`, `shared/opponent-key.js:32-37`), so A's key ≠ B's key in 1v1 and the report carries no opponent identity. Option 2 (game fetches ranks live) is a later freshness optimisation only: `/handle-friends/rank` runs a full-collection `$setWindowFields` per call (`V`, `friends.js:47-63`) and does not help the queue band at join time.

```
pikme-server mints football-token  +{ rankPoints, rankTier, rankedMatches, tierFrac, rankKnown }
      ↓ 12h TTL (V, user.js:1021-1033) ≈ one WebView session
game `join` → verifyFootballToken → member.rank → rankedQueue bands on it      [no HTTP]
      ↓
MATCH END (not startMatch): game signs ONE receipt, HS256 with FOOTBALL_TOKEN_SECRET (V, server.js:81)
  { v:1, ranked:true, matchId, eventId, ticks, iat, exp: iat+180,
    parts:[ { sub, team, result, score, tierFrac, opponentKey } ] }        ← opponentKey PER PART
      ↓ the GAME SERVER POSTs it:  POST /handle-user/football/record-ranked   (client = fallback)
      ↓
pikme-server: verify sig → resolve every `sub` → phone server-side (UserInfo.findById, then
  normalizeBankPhone + phoneVariants) → per row: MY tierFrac + rank base FRESH from the DB,
  opponents' tierFrac from the receipt, opponentKey from parts[i] → computeMatchRank
  → steps 3–9 of §1 → idempotent on (matchId, sub) → echo { rankPoints, rankTier, rankDelta }
```

Four corrections rev 1 got wrong, all verified:

- **The receipt cannot ride in `matchStart`.** `matchStart` is sent at `server.js:667`, five lines *before* `attachBall` and `room.phase = 'match'` (`:672-676`) — `result`, `score` and `ticks` do not exist yet. It also could not ride the client relay even if it did: `football.jsx:277-291` is a fixed literal field list and any new `postMessage` field is HARD BLOCKED. Sign at match end and push on a **new WS `matchReceipt` message** (or a field on the existing `matchStats` push).
- **`opponentKey` is per-recipient, so it belongs in `parts[]`, not at the top level.** One key per receipt with either side submitting splits the meeting counter into two buckets — alternating submitters would collect `100/100/60/60/30/30` instead of `100/60/30/0`, roughly double the intended payout, in exactly the thin-queue-plus-4x-upsets environment §6 calls ideal for win-trading.
- **My own `tierFrac` never comes from the token.** The 12h TTL means a bronze at 195 who wins three even matches into silver keeps minting `tierFrac 0.98` for the rest of the day, overpaying its own upset bonus by **44–80%** on every subsequent match. Step 1 recomputes `myFrac` from the fresh DB read; `parts[i].tierFrac` is authoritative only for rows other than the one being settled.
- **The game server POSTs, not the client.** This trades away "zero new outbound HTTP" (~10 calls/min at `C = 24`, against a 400 req/min/IP limiter — `V`, `app.js:13`) and buys back: the abandon hole closes completely (`postMatchResult` fires only on `phase === 'ended'`, `V` `client.js:6092`, so today force-quitting reports nothing — and with 3–4x payouts quitting becomes dominant), the submission-ordering game disappears, and **`record-ranked` needs no auth header at all — the signature IS the authority**, with identity from `parts[].sub`. A surviving client POST stays as the fallback when the game process dies mid-settle.

**Trust boundary, stated:** the game client is inside a WebView in a public repo and is **fully owned by the attacker**. So `result`, `score`, `matchId`, `ticks`, `opponentKey` and every opponent tier come **only** from the game-signed receipt; identity comes from a verified `sub` resolved server-side to a phone — **never a phone from the body** (`footballstats` is phone-keyed while tokens carry a userId; `record-match` needed a separate `phoneMatchesToken` guard for exactly this, `V` `user.js:1254-1258`, `middlewares/auth.js:91-95`). A client can then only **replay** (idempotent) or **withhold** (defeated by the game-server path). `g` keys on a coarse **tier index**, not exact points, which is what makes stale opponent tiers harmless.

**`FOOTBALL_TOKEN_SECRET` is verified as code, not as prod config:** `server.js:81` is `process.env.FOOTBALL_TOKEN_SECRET || null` and `football-mock/render.yaml` has no `envVars` block, so the value is set by hand in the Render dashboard. Today a null secret is benign (every player is a guest); under the receipt design the game cannot sign and **every ranked match silently produces an unsubmittable result**. Read the Render env before S6 and make the signer **throw at boot** when the secret is null and ranked is on. **Also still real in that pass** (the `record-match` auth hole is already closed — see §6): `matchId` is `${room.id}-${++matchSeq}` off a module-level counter that resets on every process restart (`V`, `server.js:126, 645`), so `pub-3-7` recurs after each Render deploy — it needs a boot id before becoming a signature payload and idempotency key. And `durationSec` is always the constant 120 (`V`), so the app's `>= 30` abandon guard has never worked; the receipt's tick count replaces it.

## 6. WHAT GETS DELETED — re-derived against HEAD

rev 1's table was written against a tree that no longer exists: `566996b` (pikme-server) and `e78bc6d` (football-mock) zeroed the bot-rank track within the same hour, so **anyone who greps for `0.4` / `150` / `60+80·L` will not find them and will either re-introduce them or stall.** Current state:

| symbol | where | verdict |
|---|---|---|
| `BANDS` (all 7 rows) | `football-rank.js:38`, `bandFor:87` | **DELETE** — replaced by §1. Not exported from `shared/rank.js` and not asserted by `test-rank-parity.mjs` (`V`: it checks `RANK_TIERS`, `TIER_MIN`, `botCeiling(0..11)`, `TIER_HE` — 5 assertions), so it is a one-repo change. Note the parity test exits green when the sibling checkout is absent |
| `BOT_RATE`, `BOT_DAILY_CAP` | `football-rank.js:56-57` | **already 0** — delete the now-unused constants. The mixed-roster rate floor is gone too, replaced by `rosterRate(num(xpFactor,1))` at `:142`. ⚠️ `BOT_RATE` is **not** `TROPHY_BOT_FLOOR` |
| `botCeiling` | `football-rank.js:68` **and** `shared/rank.js:38` | **already returns 0 in both** — delete the name from both repos in ONE commit (parity asserts it at all 12 levels) |
| `atBotCeiling` | `shared/rank.js:76` → `hub-rank.js:78, :101` → `rank.css:34-43` | **DELETE NOW — it returns `true` unconditionally and padlocks every badge in the app. See §4.** Real work, not a nicety |
| `rollDailyCounters`, `botRankDate/botRankToday`, the `botLevel`+ceiling response echo | `football-rank.js:167`, `footballstats.js:221-231`, `user.js:1300+` | **DEAD** — stop writing; drop columns in a later migration. The app keeps sending `botLevel` forever; ignore it |
| `winsVsBot` trophy gate · `applyFarmGates` in `tierFromRank` | — | **both already gone**: `tierFromStats({ xp })` takes only xp (`V`, `football-xp.js:156-158`) and `tierFromRank:219-221` calls nothing (`d12ac9d`). Nothing to do |
| `applyFarmGates` inside `seedRankFromXp` | `football-rank.js:197`, called `:230` | ✅ **KEEP + drop the export.** ⚠️ degating the seed silently **promotes** bot-farmers (20k xp / 0 human wins: זהב 900 → יהלום). "Nobody is reduced" ≠ "everyone is raised" |
| `computeMatchRank` params | `football-rank.js:112` | drops `isBotMatch`, `botLevel`, `xpFactor`, `botRankToday`; **gains `oppTiers`, `eventId`, `meetingIndex`, `myFrac`** |
| `TROPHY_BOT_FLOOR` (0.5) | `football-xp.js:22` | ✅ **DO NOT TOUCH** — trophies are the solo player's entire ladder |
| `opponentKey`, `countMeetings`, `opponentsToday` | `football-rank.js:175`, `footballstats.js:255` | ✅ **KEEP** — a thin pool + 4x upsets is the ideal win-trading environment. The `OPPONENT_DAILY_LIMIT` cliff at `:133` is replaced by the symmetric 100/60/30/0% decay (§2) |
| `applyRankDelta` / `rankFloor` / `seedRankFromXp` | `football-rank.js:154, 228` | ✅ **KEEP, amended** — §1 steps 7–9: unfloored `rankPointsRaw`, display clamp, ratcheted floor |
| `firstLossDate` / first-loss-free | `football-rank.js:123` | **drop inside ranked** — a free daily re-roll in a 10-match event. Keep it nowhere else. See Q3 |
| `fillBots` | `server.js:238` | **KEEP, gate it:** `if (room.noBots) return;` as line 1. **Four** call sites, not five: `startBuilderMatch:498`, `startBotGame:525`, `leaveCurrentRoom:591` (**backfills a bot into a LIVE match**), `startMatch:661` (`V`) |

**🔴 "Bots pay zero rank" is FALSE on a device today, and a unit test cannot see it.** `fillBots(room, roster)` at `server.js:661` mutates the same array `matchStart` ships at `:667`, pushing `{ ..., isBot:true }` into it. The client stores it unfiltered (`matchRoster`, `client.js:3448`) and `postMatchResult` builds `rosterIds` from that same list (`:557`), so `humanOpponents` counts bots, `vsHuman` is `true` (`:582`), `xpFactor` computes to 1.00 (`:566`), and `user.js` takes the human path at `rosterRate(1.0) = 1.0`. **Fix first, before S1: one filter at `client.js:557`** — `matchBots` is already computed two lines below `matchRoster` (`:3451`).

**Test baseline, measured 2026-07-26 ~02:30:** pikme-server **green** (`test-football-rank.mjs` 107 assertions ALL PASS · `test-football-rank-humans.mjs` 23 · `test-football-xp.mjs` 46 · `test-football-badges.mjs` 23 · `test-football-record-auth.mjs` ALL PASS). football-mock **green except `test-bot-stall.mjs`** — pre-existing, `FAIL ball behind a 600px wall: bot routes around it in never (STUCK)`, the bot-fix agent's area. **Blast radius:** `test-football-rank.mjs` **29 of 107** assertions are bot/band/ceiling-coupled and get rewritten · `test-rank.mjs` 35 total, 4 bot-coupled · `test-hub-rank.mjs` 38, of which **4 explicit `hub-tier-capped` assertions die with `atBotCeiling`** (`:74, :78, :81, :97`) · `test-rank-parity.mjs` 1 of 5 (the `botCeiling` loop) and it **must be extended** to the new table + UNRANKED · `test-opponent-key.mjs` survives · `shared/football-auth.js` + `test-football-auth.mjs` are a **fourth** test file to touch (below) · `test-modes-table.mjs` **hard-fails on three assertions** the moment a MODES row is added: `:65` one portrait card per mode, `:69` all `--band-hi` distinct (needs a new `hue[0]` distinct from `#7fd48f / #ffd06a / #8fb6ef / #e0a2f0`, `client.js:2068-2088`), `:97` every mode has a DISTINCT scene (`mode-art.js` falls back to a shared pitch, so the fillRect signature collides). **≈ 34 rewritten, 4 deleted, 3 hard fails.** ⚠️ **And `pikme-server/test-football-token.js` cannot run on this machine.** Executed: pikme-server pins `jsonwebtoken ^9.0.2`, whose `buffer-equal-constant-time` reads `SlowBuffer.prototype` — removed in Node ≥ 24 — so `require('jsonwebtoken')` throws `TypeError` on the local Node v26. The game's `^9.0.3` loads fine. S4's acceptance criterion needs either a `jsonwebtoken` bump or an older Node, decided **before** the slice starts.

**Collisions (`AGENT_REQUEST_LOG.md`):** `bot-fix` expects `server.js` + `public/client.js`; `session-open` rewrote the `FORMATS`/`roomTeamSize` block for 3v3 (`server.js:91-103`) — the same hunk a ranked row lands in; `TASK-lobby-carousel` owns `#play-strip`. Take the `football-mock:server.js` / `football-mock:public/client.js` locks or sequence behind them. For a 1v1 `FORMATS` row: `roomTeamSize:100` already handles `teamSize:1`, but **`roomField:103` reads `.cleanField`, not `.field`** — declare `cleanField` or the 1v1 silently plays on `MAIN_FIELD_CLEAN`.

## 7. SHIP ORDER

| # | slice | verifiable by | app? |
|---|---|---|---|
| **S0** | ~~Harden `record-match`~~ **already shipped in `85619ee`** — `authFootballStrict` + `phoneMatchesToken` (`V`, `user.js:1248, :1254-1258`), `test-football-record-auth.mjs` ALL PASS. **Verify only, do not re-derive phone from `req.userId`** | re-run the test | — |
| **S0b** | **Filter bots out of `rosterIds` (`client.js:557`)** — the live "bots pay full rank" bug | e2e on `:3012`: a bot match's `record-match` body carries `vsHuman:false` | ✅ |
| **S1** | Delete the bot-rank track (§6) + `atBotCeiling` and its badge consumers | 29-assertion rewrite green; the app badge shows **no `🔒`** | ✅ |
| **S2** | §1 steps 1–9 as **pure functions**, `g` forced to 0 (behaviourally flat +25/−20/+2) | every row, interpolation, finite `MAX_DELTA` ×7, `UPSET_BUDGET`, 2v2+3v3 aggregates, **shuffled-receipt order-independence**, **decayed LOSS**, high-water frac, ratcheted floor | ✅ |
| **S3** | `rankedMatches` + `rankPointsRaw` + high-water frac + UNRANKED in both repos + the `user.js:1148` fallback + the לא מדורג badge | legacy 640 → זהב; new account → לא מדורג | ✅ |
| **S4** | Rank claims in `/football-token` **and passed through `shared/football-auth.js`** | `test-football-auth.mjs` + `test-football-token.js` assertions; game logs `member.rank` | ✅ |
| **S5** | `matchId` gains a boot id / UUID | two restarts produce no repeated id | ✅ |
| **S6** | `shared/ranked-receipt.js` sign/verify + game-server POST + `POST /football/record-ranked` (idempotent on `(matchId, sub)`, monotone `iat`) + `apiPostJson` | forged sig rejected; replay writes once; both rows settle from one receipt; boot throws on a null secret | ✅ |
| **S7** | `shared/ranked-queue.js` (banding + the three pairing rules) + the 1v1 ranked room: `noBots` on all **4** `fillBots` paths, forfeit on leave + AFK | two-socket e2e: a `noBots` room never grows a bot; a leaver takes the loss; an isolated pair that has met is not re-paired | ✅ |
| **S8** | Server-authoritative event window, agreed by BOTH repos + a manual admin open/close for event 1 | queue rejects outside the window; a receipt whose `iat` is outside it is rejected | ✅ |
| **S9** | UI: mode card open/closed + countdown + the queue **bucket**, the gap chip, `לוח האירוע` (wins, tiebreak mean `g`), **a new `mode-art.js` scene + a distinct `hue[0]`** | `test-modes-table.mjs` green on all three assertions; RTL check on every timer | ✅ |
| **S10** | Flip `g` from forced-0 to live; log `(g, result)` **and total points injected per event** | one real event, then re-solve the loss row from measured rates | ✅ |

**S4 is bigger than "~4 lines".** `/football-token` does `UserInfo.findById(req.userId).select('nickName image')` — **no phone** (`V`, `user.js:1021-1033`) — while `FootballStats` is keyed on phone. Rank claims therefore need `select('… phone')` + `normalizeBankPhone` + `phoneVariants` + a `FootballStats.findOne`, all inside a `try` that **falls back to omitting the claims** rather than the route's current `res.status(500).send('error')` — otherwise a Mongo blip means no token and no game boot. And the lazy seed `footballRankSeed` (`:1164`) fires only on `/football/stats:1219` and `record-match:1270`; `friends.js:59-60` explicitly refuses to seed. **Decision: the mint route does NOT seed** (one seed owner), and emits `rankKnown:false` when no stats doc exists; the queue puts `rankKnown:false` in the widest band and `record-ranked` treats such an opponent as `g = 0`. Otherwise an un-migrated veteran mints `rankPoints:0`, reads as לא מדורג, and hands the other side `g = +2…+4` against what is really a זהב. `verifyFootballToken` also **strips every claim it does not name** (`V`, `shared/football-auth.js:8-13` returns a fixed `{userId, nickName, image}`), so minting claims without widening it leaves `member.rank` undefined and the queue degrades to random pairing — the one failure a band exists to prevent.

**Nothing in S0–S10 is blocked on the iOS app** — the game server POSTs the ranked result, prod CORS already whitelists `https://pikme-football.onrender.com` (`V`, `app.js:57`). **⚠️ Blocked / degraded on the app we do not control:**
- **Post-match rank delta ANIMATION — degraded.** `bootJs` always sets `window.SALTIZ_RANK`, so `fetchOwnRank()` returns early (`V`, `client.js:807-808`), and the app injects `rankDelta` from the *record-match* response, which returns 0. Workaround, game-side only: after the ranked settle the game writes `window.SALTIZ_RANK` itself and guards ~10s against an incoming `delta:0` inject. This needs the numbers back, and `apiPost` throws the body away (`V`, `client.js:2427-2432` returns a bare boolean) — hence `apiPostJson` in S6 and the `{rankPoints, rankTier, rankDelta}` echo.
- **A native push/banner for the window — BLOCKED and load-bearing.** Push capability is **UNVERIFIED**; the whole windowed design depends on `תזכיר לי` delivering. Verify before locking a slot (Q2). In-app countdown is not blocked.
- **Any NEW `postMessage` field — HARD BLOCKED** (`V`, `football.jsx:277-291` is a fixed literal list). Same for a per-event token TTL — the app decides when it re-mints. **Kill switch (`I`):** 3 consecutive events under 10 attendees → fold to one monthly event rather than let a dead queue teach everyone the mode is dead.

## 8. ATTACKED AND SURVIVED

Held under both lenses, unchanged: **the table itself** (both critics attacked its plumbing, neither attacked a number); **headcount does not multiply**; **fractional `g`**; **`UPSET_BUDGET = 200`** (the farm critic's own arithmetic used it and it bound where intended); **windowed 1v1**; **matchmaker-assigned only**; **the unranked discriminator** — `rankSeeded` confirmed unusable (`footballDefaults:1190` sets it `true` on new accounts); **option 3 is dead** (the per-recipient `opponentKey` was confirmed, then used to break rev 1's own receipt shape); **`TROPHY_BOT_FLOOR` untouched**; **the `test-modes-table.mjs` hard fail is real** and grew from one assertion to three.

Rebutted, verified against the files: **(a) "make the table zero-sum" — rejected**: at `g = +4` the *loser* is the strong side (own `g = −4`), so a constant pair-sum means a **−105 single loss to a bronze**, contradicting the table's cheap-loss row. The `g=0` pair sum is `+5` = `+25/player/event` of inflation at 200 matches/event — **logged and tuned in S10**, not designed away; the 10-match budget caps per-player damage. **(b) "two `|| 'bronze'` fallbacks"** — one (`V`, grep across `routes-pikme/` + `data/`), and the leaderboard needs no change at all: it projects the trophy `tier` (`user.js:1504-1516`), never `rankTier`. **(c) "five `fillBots` paths"** — four (`:498, :525, :591, :661`). **(d) "`roomField` hands a 1v1 `MAIN_FIELD_CLEAN` unless the row declares `field`"** — it reads **`.cleanField`** (`server.js:103`), so declaring `field`, as `FORMATS['3v3']` does, achieves nothing. **(e)** `postMatchResult`'s ended-phase guard is `client.js:6092`, not `:6057` — rev 1 was stale and both critics inherited the stale number.

## 9. OPEN QUESTIONS (3)

1. **Format for event 1: 1v1 (recommended) or 2v2?** 1v1 is the only format whose queue math works at this population (60s median at `C ≥ 2` vs 6 for 2v2), and the 1v1 path is needed anyway as the honest fallback for a starved 2v2 queue. Real cost: the game people play is 2v2, and a 1v1 ladder measures a different game. **Ship 1v1, add 2v2 once a real window measures `C ≥ 12`.**
2. **Lock Thursday 20:30 + Saturday 21:00 now, or log `onlineCount()` hourly for two weeks first (recommended)?** The Shabbat/school-week logic is sound but the peak hour is unmeasured, the counter already exists (`server.js:135`), and the same two weeks are what it takes to confirm push delivers — without push, a window nobody is told about may be worse than an always-on queue. **Measure two weeks; run event 1 manually at a time you pick and attend personally.**
3. **Event budget: a hard 10 matches per player (recommended), or unlimited inside the 75 minutes?** A cap makes `לוח האירוע` a fair comparison, keeps attendees resident (which is what produces the concurrency), and matches FUT Champions' 15/5. Unlimited rewards whoever stays up longest — the trophy track's job, not rank's. Bundled: **drop "first loss of the day is free" inside ranked** (`football-rank.js:123`), keep it everywhere else.
