# 11 — DECISION v2: TROPHIES + RANK PROGRESSION (chair ruling, rev 2)

> **2026-07-26 · Chair of the 6-seat council · seat docs `06`–`10` hold the detail. DECIDED, NOT BUILT.**
> **rev 2** — survived three adversarial critics (exploitability / brief-audit / build-safety); see §8. Every number below was re-derived by executing
> the shipped modules. **Citations are grep-able excerpts, not line numbers** — `public/client.js` drifted 29 lines during the review.

## 0. Two headlines that reframe all 7 asks

### (a) Every multiplier below is currently applied to UNAUTHENTICATED client JSON

`router.post('/football/record-match', authNonBlock, …)` — and `authNonBlock` never rejects. Identity is `req.body.phone`; `result`, `goalsFor`,
`vsHuman`, `xpFactor`, `botLevel`, `opponentKey` and `matchId` are trusted as sent, and the limiter is global-per-IP (`rateLimit({ windowMs: 60*1000,
max: 400 })`), not per-route. So the roster grade, the 0.50 floor, the goal cap, `BOT_RATE`, `BOT_DAILY_CAP` and the farm gates are **knobs on fields
the farmer types himself.** 400 forged wins/min ≈ 52,000 trophies/min; 119 forged `vsHuman:true` wins with `opponentKey` omitted reach `rankPoints
3204` = LEGEND with a sticky `rankFloor`, in ~18s. `$push: { recordedMatchIds: matchId }` is unbounded, so sustained forged POSTs at a known phone
eventually hit Mongo's 16MB doc cap and brick that account's writes. **This is slice 0 and it blocks slices 1–4,** at zero iOS cost: the app already
passes the login JWT (`recordMatch(…, token)`) and an `authFootball` middleware already exists in `middlewares/auth.js`. *(Exploitability critic;
conceded in full — the most important finding in either revision of this doc.)*

### (b) The bot/human split has never executed in production

```
SHIPPED  (rosterIds = new Set(matchRoster.map(p => p.id)) — bots INCLUDED):
  { humanOpponents: 2, vsHuman: true,  humanCount: 4, xpFactor: 1.00 }   ← solo vs 3 BOTS
FIXED    (… matchRoster.filter(p => !p.isBot) …):
  { humanOpponents: 0, vsHuman: false, humanCount: 1, xpFactor: 0.20 }
```

`fillBots` appends bot entries (each `isBot: true`) into the same `roster` sent as `matchStart.players`; the client folds all of it into `rosterIds`.
So `BOT_RATE`, `botCeiling`, `BOT_DAILY_CAP`, `TROPHY_BOT_FLOOR` and the `winsVsBot` gate **have never run on a matchmade or vs-bots match.** Three
consequences: **(1)** asks #3/#4 are a bug fix, not a feature — the graded signal is built and wired end to end; **(2)** the fix **NERFS the majority
path** — a solo bot win falls **130 → 65** trophies (quick *and* vs-bots are first-to-3, so the modal win has `goalsFor: 3`) and **+30…+40 → +8** rank, so
seat `06`'s "every value is ≥ today" is true of the *code path* and false of production; **(3)** it arms a rule-#1 violation on **both**
badges — `winsVsBot` is pinned at 0 so `wh < wb` cannot fire, and executed, `tierFromStats({xp:40000, wh:100, wb:99})` → **champion** / `wb:101` →
**diamond**, and `tierFromRank({rankPoints:2200, wh:100, wb:99})` → **champion** / `wb:101` → **diamond**. The sticky floor does *not* protect the
rank badge: `applyRankDelta` floors the POINTS (`{rankPoints:2200, delta:-500, rankFloor:5}` → `{2200, 5}`) while `tierFromRank` gates the INDEX
afterwards, so both badge fixes ship in the roster-fix commit. **And the fix is not one line — rev 1's line was at the wrong site:** `matchRoster` is the
FULL roster and four features need the bots in it (§3 row 1a), so the correct site is `rosterIds` — and two exploits survive even that, so the count moves
server-side (1b). *(Build-safety critic; rev 1 would have shipped four regressions.)*

---

## 1. THE DECISION IN ONE TABLE

### Track A — גביעים / trophies (`xp`, MONOTONIC, never drops)

`total = round((20 + outcome + 10 × min(goalsFor,5)) × roster × meetTaper × botTaper) + 200 first win/day`, where `outcome` = **WIN 80 · TIE 30 · LOSS
10** and the `20` is **PLAYED**.

| Result | 3 bots ×0.50 | 2 bots+1H ×0.65 | 1 bot+2H ×0.80 | 3 humans ×1.00 | Today (all shapes) |
|---|---|---|---|---|---|
| **Win, 3 goals** (modal, first-to-3) | **65** | **85** | **104** | **130** | 130 |
| **Win, 5+ goals** (brawl, at the cap) | **75** | **98** | **120** | **150** | 150 *(uncapped today: to **1100**)* |
| **Tie, 1 goal** | **30** | **39** | **48** | **60** | 60 |
| **Loss, 0 goals** | **15** | **20** | **24** | **30** | 30 |
| Opponent-strength × | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| `meetTaper` — Nth match vs the same `opponentKey` today (1st–2nd / 3rd / 4th+) | **× 1.00 / 0.50 / 0.25** | ← | ← | ← | *(no defense today)* |
| `botTaper` — bot matches already played today (≤10 / >10, `TROPHY_BOT_DAILY_FULL = 10`) | **× 1.00 / 0.50** | n/a | n/a | n/a | *(none)* |

**Pre-roster totals are 100 / 50 / 30 — byte-identical to shipped**, because `20+80`, `20+30` and `20+10` reproduce today's bases exactly, so ask #2
adds four *visible line items* without moving a total. Both tapers are multiplicative on `roster` and **never zero**, so the track stays monotonic.
`meetTaper` closes a real gap: `computeMatchXp` takes **no** meetings parameter, so `OPPONENT_DAILY_LIMIT` is rank-only and **the monotonic track has
zero win-trading defense today**; `botTaper` is what makes ask #4 true per MINUTE (§2 #4). Both need `met.meetings` plus one new daily int `botXpToday`.

**There is no standalone "played only" payout.** `user.js` rejects any `result` outside `win|loss|draw`, `postMatchResult` has one callsite gated on
`latest.phase === 'ended'`, and quitting never reaches that phase — so no code path can produce a result-less match. Paying one needs a
server-declared `abandon` (3 files, 2 repos — Q5) and would be the best tr/min play in the game (open → bot room → quit ≈ 8s). *(Both critics.)*

### Track B — דרגה / rank (`rankPoints`, LOSABLE)

**Both tracks use the SAME roster grade** — one answer to "how human was this match." Rev 1 shipped 0.65/0.80 on trophies and 0.47/0.73 on rank from
one wire field; fixed. *(Both critics.)*

| My tier | Shape | TODAY (production) | + roster fix, `BOT_RATE 0.40` | + ask #6, `BOT_RATE 0.25` |
|---|---|---|---|---|
| **bronze** (rp 100) | 3 bots | **+30…+40** / 0 / +10 | +12 / 0 / +4 | **+8 / 0 / +3** |
| | 2 bots+1H | +30…+40 / 0 / +10 | +20 / 0 / +7 | **+20 / 0 / +7** |
| | 1 bot+2H | +30…+40 / 0 / +10 | +24 / 0 / +8 | **+24 / 0 / +8** |
| | 3 humans | +30…+40 / 0 / +10 | +30 / 0 / +10 | **+30 / 0 / +10** |
| **gold** (rp 600) | 3 bots | **+25…+35** / −8 / +8 | +10 / −3 / +3 | **+6 / −2 / +2** |
| | 2 bots+1H | +25…+35 / −8 / +8 | +16 / −5 / +5 | **+16 / −5 / +5** |
| | 1 bot+2H | +25…+35 / −8 / +8 | +20 / −6 / +6 | **+20 / −6 / +6** |
| | 3 humans | +25…+35 / −8 / +8 | +25 / −8 / +8 | **+25 / −8 / +8** |

Cells are `win / loss / draw`, all executed. **Bot rows assume `botLevel 11` (ceiling 940).** At the route's documented default `botLevel 5` (ceiling
460) the whole gold bot row is **0 / 0 / 0**; so is `botLevel 4`; it first pays at `botLevel 7` (ceiling 620). Near the ceiling the last points
truncate to `botCeiling − rankPoints`. *Today* is a range because the roster bug pins `bot=false`, so the human streak bonus (+2/win, max +10) leaks
onto bot matches. Mixed columns are unchanged by ask #6 because `rate = min(1, max(BOT_RATE, roster))` and every grade ≥ 0.50 > 0.25. **Rank pays 0
for "played". Non-negotiable** — a losable ladder must never pay for attendance. Bands, `TIER_MIN`, streak, first-loss-free, `OPPONENT_DAILY_LIMIT 3`,
`botCeiling` and `rankFloor` are unchanged.

### Opponent-strength multiplier — RANK ONLY, **DEFERRED** (Q3) · `g = clamp(oppTierIdx − myTierIdx, −2, +2)`, coarse tier index 0–6, never points

| g | −2 | −1 | 0 | +1 | +2 | unknown/guest | **played** |
|---|---|---|---|---|---|---|---|
| Win × | 0.70 | 0.85 | **1.00** | 1.15 | **1.30** | 1.00 | — |
| Loss × | 1.30 | 1.15 | **1.00** | 0.85 | **0.70** | 1.00 | — |
| Draw × | 0.80 | 0.90 | **1.00** | 1.10 | 1.20 | 1.00 | *n/a — rank pays 0 for attendance* |
| *Gold player (+25/−8)* | *beat a silver **+21**, lose to them **−10*** | ← | — | → | *beat a diamond **+33**, lose to them **−6*** | | |

---

## 2. THE 7 ASKS

**#1 — Trophies can only go up.** True of the number: no negative term, and the route writes `$inc {xp}`. Worst case with both tapers is `round(30 ×
0.50 × 0.25 × 0.50) = 2` — positive. The **badges** are what lie, on both tracks (§0b). Rev 1 proposed a new `xpTierFloor` field; **rev 2 needs no
field**: delete `applyFarmGates` from `tierFromStats`. The trophy tier is a *volume* medal and `rawTierIndexFromXp` is monotone in `xp`, which only
ever `$inc`s upward — monotonicity becomes a property of the ladder, not a stored floor. The gates belong on the RANK tier, where they need
`rankFloor` as a lower bound: `Math.max(rankFloor, applyFarmGates(…))`. Four assertions: `computeMatchXp >= 0`; the route never writes `xp < doc.xp`;
`tierFromStats` monotone in `xp`; `tierFromRank` after ≥ before. **The trade is explicit:** a farmer can now reach trophy-legend (80,000 xp ≈ 2,400
tapered bot matches ≈ 30h) — a volume medal working as designed, while the badge over the hero stays human-gated. **Verdict: CONFIRMED for the number;
both badges are broken, both fixes mandatory in slice 1; no new field.**

**#2 — Different numbers for win / lose / tie / played.** `PLAYED 20 + WIN 80 / TIE 30 / LOSS 10`, additive, summing to today's exact 100/50/30 —
**not** a fourth bonus stacked on a win (that reading inflates every category ~25% and is the likeliest implementation bug). Four numbers on screen
(`+20 שיחקת · +80 ניצחת · +10 גול`), all four reachable. Seat `08` feared a free bot farm; the refutation is **not** rev 1's "own goals impossible /
brawl has no early end" — quick and 3v3 are first-to-3 (`GOALS_TO_WIN = 3`), so you throw by idling and the match ends *early*. The real refutation is
that PLAYED never pays standalone: a thrown bot match pays `30 × 0.50 = 15` in ~37s = **24.5 tr/min** against **106** for winning it — dominated
**4.3×**. Rev 1's `TROPHY_PLAYED_MAX` and "break-even 66" are deleted as moot. **Verdict: ADDITIVE 20/80/30/10, totals unchanged, no standalone row.**

**#3 — Different trophies per number of bots.** Grade **0.50 / 0.65 / 0.80 / 1.00**. Rev 1 said "derive from the human COUNT, never from literal
`xpFactor`" — but the app forwards only the float, which made slice 2 depend on an iOS build; and a table keyed on bot *count* leaves live 3v3
(`otherSlots = 5`, 0–5 bots) with two undefined shapes and pays a 3-bot/3-human 3v3 the all-bot grade. **Both are fixed by inverting the shipped
formula instead of tabulating it.** The game sends `xpFactor = 0.2 + 0.8 × humanFrac`, so:

```
humanFrac = clamp((xpFactor − 0.20) / 0.80, 0, 1)
roster    = humanFrac <= 0 ? 0.50 : humanFrac < 0.50 ? 0.65 : humanFrac < 1.00 ? 0.80 : 1.00
```

Executed: 2v2 → **0.50 / 0.65 / 0.80 / 1.00** (the published grade, exactly); 3v3 → 0.50 / 0.65 / 0.65 / 0.80 / 0.80 / 1.00 (**solo 3v3 = 0.50**); 1v1
→ 0.50 / 1.00. Every mode covered, monotone, no gaps, no new wire field, **server-only.** Pin it with a round-trip test. The teammate-vs-opponent
split is still a real gap (a bot *teammate* does not make the match easier) and still needs iOS. **Verdict: SHIP the 4-stop grade on the inverted humanFrac; DEFER the teammate/opponent split to slice 5.** *(Both critics; conceded and re-engineered.)*

**#4 — Bots give less than humans.** Keep `TROPHY_BOT_FLOOR = 0.50` per match. **But rev 1 measured value per MATCH and never divided by cycle time.**
vs-bots is instant entry (`startBotGame` sets `room.phase = 'match'` directly — no `countdownT`, no `introT`):

| Path | Value | Cycle | tr/min |
|---|---|---|---|
| vs-bots win, 3 goals (certain) | 65 | **36.7s** = 0.7 `KICKOFF_FREEZE` + 3×6s + 2×5 `GOAL_RESET` + 6 `ENDED_HOLD` + 2s tap | **106.3** |
| honest all-human quick, EV @50% | 85 | **~105s** = 5 `COUNTDOWN_TIME` + 4.6 `INTRO_PROMO` + ~87s play/resets + 6 + 2, **queue excluded** | **48.6** |
| ⇒ bots ahead | | | **2.19×** |

Two fixes, and the payout floor is not one of them: (a) give vs-bots the same 5s countdown + 4.6s intro the queue pays → cycle **46.3s**; (b)
`botTaper` 0.50 after 10 bot matches/day. Result: the first 10 bot matches pay **84.2 tr/min** (1.73× — the intended "always available" premium),
match 11+ pays **42.8 tr/min = 0.88×**, and an hour of pure bot spam pays **2,820** against **2,915** for an hour of honest quick = **0.97×.** Keep
`+200` first-win roster-blind — the come-back-tomorrow hook must fire on the majority path. **Verdict: 0.50 per-match floor, roster-blind +200, plus
botTaper and the vs-bots ceremony — per-match spread 2×, per-session spread 0.97×.**

**#5 — Trophies for higher-RANK / higher-TROPHY opponents.** All five seats refused it on the trophy track; no critic attacked that. On a monotonic
track the modifier can only be a bonus, which becomes "queue to farm trophies" and destroys the one property trophies must keep: a payout you can
predict before you press play. The second half is a harder no — **opponent trophies measure account AGE, not strength** (after the roster fix most
existing totals are bot-earned) — and the input does not exist: `opponentKey` is an irreversible SHA-256, `matchStart` carries no ranks, and the game
server makes zero outbound calls to pikme-server. **Verdict: NO on trophies, ever. RANK only, DEFERRED until the wire exists.**

**#6 — Rank between only humans.** Directionally right; the literal version ships a dead wall — and so does rev 1's recommendation, for most of the
existing playerbase. Executed: `seedRankFromXp({xp:4000,…})` → `rankPoints 500`; `xp 6000` → 633; `xp ≥ 10000` → **900** (frac clamps). So rev 1's
"0.25 up to **500**, then 0 forever" is a **no-op wall already crossed** by every bot-only account with ≥4,000 trophies (~30 matches at today's buggy
rate). The migration seed did the carrying; ask #6 does not create that wall. **Honest conclusion: no version of #6 gives an existing bot-only account
a moving RANK number.** So: **(i) drop the 500 stop** — `botCeiling` already IS the wall, it is parity-locked and mirrored in `shared/rank.js`, and a
server-only 500 constant passes `test-rank-parity.mjs` while the hub renders *'עוד 300 לדרגה הבאה'* and the server pays 0. Ship #6 as **`BOT_RATE 0.40
→ 0.25` + `BOT_DAILY_CAP 150 → 60`** — single-repo, no divergence; any tighter wall must move `botCeiling` in **both** repos with a new parity
assertion. **(ii) The solo ladder is not a tier badge.** Rev 1 said "surface the trophy tier badge — already farm-gated at gold." Executed:
`tierFromStats({xp:1000000, wh:0, wb:999})` → **gold**; post-fix `winsVsHuman` can never grow for a solo player, so it freezes at gold at *any* total
— the same wall at the same tier. Under #1 the gates come off, and the number that always moved is the **trophy COUNT + LEVEL**: unbounded, pays every
match, drives `botLevelFromXp` → bot difficulty. **Verdict: BOT_RATE 0.25 + BOT_DAILY_CAP 60, no new stop, botCeiling untouched; solo ladder = trophy
count + level, not a badge.** *(Brief-audit critic; conceded on all three points.)*

**#7 — Rank XP by opponent rank, trophies, or both?** Unanimous across five seats, unattacked by all three critics: **rank only.** "Both" is provably
double-counting — `seedRankFromXp` already maps a legacy trophy standing onto the rank ladder, so rank *already contains* the trophy signal. Trophies
keep influencing rank indirectly (`levelFromXp → botLevelFromXp → botCeiling →` the rank **roof**), never the payout. Use the coarse **tier index
0–6**: the only untampered channel is a signed JWT claim up to 12h stale, and a tier boundary is rarely crossed inside 12h. **Verdict: opponent RANK
only, coarse tier index, rank delta only.**

---

## 3. WHAT THIS CHANGES VS SHIPPED

| # | Change | Type | Where |
|---|---|---|---|
| **0a** | `record-match`: `authNonBlock` → `auth`; verify `req.body.phone` belongs to `req.userId` | **BREAKING · BLOCKS 1–4** | `pikme-server/routes-pikme/user.js` |
| **0b** | `recordedMatchIds` capped via `{ $each:[matchId], $slice: -500 }` + per-route limiter (20/min/user) | **BREAKING** | same file, `app.js` |
| 1a | `rosterIds = new Set(matchRoster.filter(p => !p.isBot)…)` — the one line, at the right site. **Not** at the `matchRoster` assignment: four shipped features need the bots in it — `matchBots` (settings dossier), `preloadCards` (bot card art, the mid-match pop-in its comment exists to prevent), `mates` in `playPromo` (Task 18's preview==match guarantee), the stadium crowd | **BREAKING** (arms the bot defenses; nerfs the majority path) | `football-mock/public/client.js` |
| 1b | Server ships `humansAtEnd` in `matchStats` = players where `!p.isBot` **and** the member has a `userId`; client derives `humanCount`/`humanOpponents`/`vsHuman`/`xpFactor` from it. `isBot` is absent from `shared/wire.js`, so the client cannot see it on the live snapshot and 1a alone cannot close these | **BREAKING** — closes AFK-to-bot **and** guest tabs | `football-mock/server.js` + `public/client.js` |
| 1c | `opponentKeyFor`: drop no-`userId` (guest) opponents; key on **all** other humans in the match, not just the opposing team — teams are a lobby button, so flipping them currently mints a fresh key | **BREAKING** (`test-opponent-key.mjs`) | `shared/opponent-key.js` |
| 1d | `tierFromRank` bounded below by `rankFloor`; `applyFarmGates` **removed** from `tierFromStats` | **BREAKING** (both badges) | `data/football-xp.js`, `data/football-rank.js` |
| 1e | `botLevel` null → 5, not 0: today `Number(null) === 0` passes `Number.isFinite`, giving ceiling **60** instead of the documented 460 | fix | `routes-pikme/user.js` |
| 1f | Matchmade `matchStart` gains `mode:'quick'`; `settings.diffLevel` ignored when `room.phase === 'match'` and from non-hosts. Today `xpModes = msg.mode === 'quick'` is **always false** for matchmade rooms, so the client overrides difficulty from localStorage while reporting `matchDiffLevel` from `matchStart` — a level-40 account can face skill-0.05 bots and report `botLevel 11` | **BREAKING** | `football-mock/server.js`, `public/client.js` |
| 2a–c | `20/80/30/10` decomposition · goal term capped at 5 goals · `roster` from the inverted `humanFrac`. Goal exposure today is **1100** (`goalsFor` clamps to 100), and the clock **stops** during `GOAL_RESET` (the freeze branch returns before `state.elapsed += dt`), so every goal buys free wall-clock in timed brawl | 2a ADDITIVE; 2b/2c **BREAKING** | `data/football-xp.js` |
| 2d | `meetTaper` (pass `met.meetings` into `computeMatchXp`) + `botTaper` (`botXpToday`) | **BREAKING** (one new daily int) | `data/football-xp.js`, `data/footballstats.js` |
| 2e | 4 monotonicity assertions + a `humanFrac` round-trip test + a regression test that an `addBot`-filled room grades **0.50** | ADDITIVE | `test-football-xp.mjs` |
| 3a | vs-bots gains `COUNTDOWN_TIME 5` + `INTRO_PROMO 4.6` | **BREAKING** (feel) | `server.js` (`startBotGame`) |
| 3b | Bot-match rank state (`אין דרגה מול בוטים`) at `pollRank`'s `if (st.rankPoints === shown) return;` — a 0-delta match never reaches `flash`, so rev 1's `if (!amount) return` is unreachable **and** `pendingReveal` leaks to the next change. Also make `paint()` prefer `st.rankTier`: `rankState()` never reads it, so at `rp 940, wh 20, wb 500` the server says **gold** and the hub draws 🛡️ **platinum** | ADDITIVE, **required** if #4 ships | `public/hub-rank.js` |
| 3c | Serialize `pollRank()` after `playXpReveal` (it runs 7 lines earlier in the same 700ms tick) | ADDITIVE, **independent** | `public/client.js` |
| 4 | `BOT_RATE` 0.40 → 0.25, `BOT_DAILY_CAP` 150 → 60. **No 500 stop; `botCeiling` untouched.** | **BREAKING** (needs Q1) | `data/football-rank.js` |
| 5 | iOS: forward `humansAtEnd`/`humanFrac`/`totalPlayers`; add `tier` to `injectXp`; settle **ארד** (`app/components/home/football-progression.js`) vs **ברונזה** (`shared/rank.js`) — a visible mismatch the moment both are on screen, and the parity test never compares that file | ADDITIVE, **needs iOS** | `services/saltizFootball.js`, `app/pages/football.jsx` |
| 6 · 7 | Opponent-strength multiplier · `abandon` result | **DEFERRED** (Q3 / Q5) | 3 repos |

**Test cost, executed not estimated.** Baseline: all six suites PASS. Slice 2 breaks **exactly two** assertions in `test-football-xp.mjs` — **:76**
(got 65, want 50) and **:77** (got 80, want 73); 66–69, 72–75, 78, 81–83 and 86–88 all still pass, because `20+80 / 20+30 / 20+10` reproduce today's
bases byte-for-byte (keep `TROPHY_BOT_FLOOR = 0.5` exported, or :72 fails with `undefined`). Slice 4 breaks **13** in `test-football-rank.mjs`: **36, 37,
78, 91, 95, 96, 97, 101, 103, 107, 108, 110, 236** — and **222, 224, 229, 231 SURVIVE**, since the L5 ceiling 460 and the L11 climb to 940 are untouched.

**Migration cannot be undone:** the roster fix is not retroactive — `winsVsHuman` is inflated with bot wins, `winsVsBot` is 0, and `recordedMatchIds`
holds only ids. The playerbase is **permanently grandfathered past the platinum rank gate** (`winsVsHuman >= 25`); accept it plus a `humanStatsFrom`
date, and do **not** re-seed or claw back — that is a decrease, forbidden by #1.

---

## 4. WHERE THE SEATS DISAGREED AND HOW I RULED

| Conflict | Ruling |
|---|---|
| Is the bot split live? `10` (dead, by execution) vs `06`/`08`/`09` (tuned to the code path) | **`10` — reproduced.** Every "vs today" number in `06`/`08`/`09` is wrong: production pays 1.00, not 0.50. |
| Roster values: `06` 0.50/0.67/0.83 · `09` 0.50/0.65/0.80 · `08` six shapes · `10` opponents-only | **`09`'s values, `06`'s mechanism** — 15-point steps a player can feel, delivered by thresholds on the inverted `humanFrac` so every mode is covered. |
| "Played": additive (`06`/`09`/`10`) vs rename-only (`08`) · goal cap `06` min(60,10×g) vs `09` min(g,5) | **Additive floor only** (`08` was right that a *standalone* payout is a farm; the critics proved it is also unreachable) · **`09` — cap 5 (+50)**, reachable in timed brawl because the clock stops during resets; exposure today is 1100. |
| Opponent strength: `07` logistic/14 constants · `06` 5-bucket ±50% · `10` ±0.15/tier | **`10`.** `07` built the best math then proved it unshippable; 14 constants × 2 repos also breaks parity CI. |
| Ask #6: `08` `practicePoints` · `06` ceiling→500 · `10` rate+500 stop · `09` trophy badge | **`10`'s rate only.** The 500 stop is dropped (parity divergence + already-crossed wall); `09`'s badge is disproved (frozen at gold). `08`'s `practicePoints` is now the strongest fallback (Q1-B). |
| Bot-difficulty bonus `08` `4 × max(0, L−5)` · duration gate on "played" `09` ≥45s / `06` ≥60s | **Both REJECTED.** The reported `botLevel` is not the difficulty played (1f) — two desyncs, two taps, no tools; and `durationSec` is the constant `MATCH_DURATION`, so the app's `>= 30` gate is already dead code (moot now that PLAYED never pays standalone). |

---

## 5. WHAT CONTRADICTS THE LOCKED §7 DECISIONS — USER MUST UNLOCK

| Locked | How rev 2 contradicts it |
|---|---|
| **§7.1** bots pay 40% below `botCeiling`, 0 above | Contradicted **once, not twice**: #4 overrides the **rate** (0.40 → 0.25) and the **daily cap** (150 → 60), but `botCeiling` is now left alone, so the ceiling half stands. §7.1 was also never *tested* in production — the roster bug pinned `isBotMatch` false, so it is proved in unit tests only. |
| **§8** "revisit rank if anyone approaches diamond" | **Can never fire** without a real human population: `botCeiling(11) = 940` sits inside platinum and `seedRankFromXp` already parked bot-only accounts at 900. |
| **§6** "every change is additive" | **No longer holds** — 0a, 0b, 1a–1f, 2b–2d, 3a and 4 are breaking. |
| **§7.3** "XP bar stays a thin secondary bar" | In tension with ask #2 and §2 #6 — trophy count + level is now the solo player's whole ladder, so it cannot stay thin. Supercell killed Masteries on 2025-06-24 at **11.8%** engagement; that is a hidden volume medal in 18 months. |
| **2026-07-25** anti-farm gates on `tierFromStats` | **They move tracks** — off `tierFromStats` (volume), plus a `rankFloor` bound on `tierFromRank` (skill). A reinterpretation of the split rather than a reversal, but still a change to signed-off behaviour: a farmer can now reach trophy-legend. |

---

## 6. OPEN QUESTIONS ONLY THE USER CAN ANSWER

| Q | A — *recommended* | B | Why A |
|---|---|---|---|
| **Q1** Ask #6: what moves for a solo player? | Bots pay rank at **0.25**, capped **60/day**, up to `botCeiling`; the solo ladder is **trophy count + level** | Add seat `08`'s `practicePoints` — a third, explicitly-solo number | One repo, no new player-facing concept. B is the only way to give a solo account a moving BADGE, at the cost of a schema field. **Either way: no version of #6 gives an existing bot-only account a moving rank** — the seed already parked them at 900 of a 940 ceiling. |
| **Q2** Soften the nerf? | Ship at the numbers above (solo bot win **130 → 65** trophies, **+30…+40 → +8** rank) and **announce it** as a bug fix with a one-off goodwill grant | Raise `TROPHY_BOT_FLOOR` 0.50 → 0.60, so the cut is 130 → **78** | A is the honest number the whole design assumes. Under either, **no stored number decreases** — only future payouts. |
| **Q3** Opponent strength (#5/#7) | **Defer.** Ship nothing now | Fund it at the ±0.15/tier table in §1 | It needs signed rank claims in the football-token JWT, digits packed into `opponentKey`'s spare bytes, and a split before `countMeetings` fragments: 5 files, 2 repos, breaks `test-opponent-key.mjs`. It matters for ~0% of matches while the auth hole and the roster bug affect 100%. |
| **Q4** Four numbers on the post-match screen? | Show all four lines and give the trophy total real space | Thin bar, total only | A losing screen showing three earned things is the entire reason the monotonic track exists. **Correction to rev 1:** golden confetti on a loss is **already shipped** — a loss already pays 15–30, so `playXpReveal`'s `toXp <= fromXp` guard already clears and `xpBigNum('+' …)` already fires, and `pollRank()` already runs 7 lines earlier in the same tick. Item 3c is an independent bug fix. |
| **Q5** Standalone PLAYED | **Never** — PLAYED stays the additive floor | `server.js` emits `{result:'abandon'}` with its own `matchId` + a real elapsed field after `ENDED_HOLD`; route whitelists it with its own `$inc` bucket and a **streak-preserving** branch (today a 4th kind would `$inc {draws:1}` and zero a live win streak, which also zeroes the rank streak bonus) | Under B, quit-spam at ~8s per cycle is **150 tr/min** until the server owns the declaration. |
| **Q6** Data this seat cannot pull | — | — | How many live accounts have `xp >= 4000` (already at/above rev 1's proposed 500 stop), and how many have `winsVsHuman >= 25` (grandfathered past the platinum gate)? Both change how loud Q2's announcement must be. |

---

## 7. SHIP ORDER

| # | Slice | Repos | Why here |
|---|---|---|---|
| **0** | **Authenticate `record-match` (0a) + cap `recordedMatchIds` + per-route limiter (0b)** | **server only** | Every multiplier in 1–4 is a knob on a client-typed field. **Nothing below is enforceable until this lands.** Zero iOS work. |
| **1** | 1a roster fix + 1b server-authoritative human count + 1c opponentKey + 1d both badge floors + 1e botLevel default + 1f difficulty desync — one commit per repo | game + server | The roster fix arms the demotion bug on two badges; inseparable. 1b is what makes 1a true for AFK players and guest tabs. Take the lock on `public/client.js`. |
| **2** | Trophy math: 20/80/30/10, goal cap 5, inverted-`humanFrac` grade, `meetTaper`, `botTaper` | **server only** | Genuinely server-only now — the grade derives from the `xpFactor` float the app already forwards. Cost: 2 assertions. |
| **3** | 3a vs-bots ceremony + 3b hub bot-state/`rankTier` + 3c reveal serialization | game only | 3a is half of ask #4's per-minute answer, and payout tuning cannot replace it. 3b/3c make 1–2 legible. |
| **4** | Ask #6: `BOT_RATE` 0.25 + `BOT_DAILY_CAP` 60 | server only | Needs Q1. Single-repo and parity-safe **only** because the 500 stop was dropped. Cost: 13 assertions. |
| **5** | iOS: `humansAtEnd`/`humanFrac`/`totalPlayers`, `tier` in `injectXp`, ארד/ברונזה | **needs iOS** | Unlocks the teammate/opponent split and retires the float inversion. Off our release train. |
| **6 · 7** | Opponent strength · `abandon` | 3 repos | **DEFER** per Q3 / Q5. |

**Slices 0–4 need no iOS build** — verified: the app already forwards `xpFactor`, `vsHuman`, `botLevel`, `opponentKey` **and the login token**; only 5–6
do. **Before slice 1, fix the CI hole:** `test-rank-parity.mjs` `process.exit(0)`s with `SKIP` when the sibling `../pikme-server` checkout is
absent — the guard this council relies on is conditional. It also asserts only `RANK_TIERS`, `TIER_MIN`, `botCeiling(0..11)` and `TIER_HE`, so it
would **not** have caught a server-only 500 stop. That is why #4 has none.

---

## 8. Attacked and survived

Three critics — **exploitability**, **brief-audit**, **build-safety** — all returned *needs-revision*. Every code claim re-verified against the real files.

**Conceded, blockers.** ① `record-match` is unauthenticated → **slice 0**, blocks everything; the finding that most changes the plan. ② Guest browser
tabs mint a 100%-human room and ③ an AFK friend keeps his id while becoming a bot — both closed by one change, **1b**. ④ Rev 1's "one-line fix" was at
the wrong site and would have broken `matchBots`, `preloadCards`, `playPromo` and the crowd → moved to `rosterIds`. ⑤ Standalone **PLAYED** is
unreachable → row **deleted**, deferred to Q5. ⑥ Rev 1's 500 rank stop is a wall the seeded playerbase already crossed **and** a one-repo constant the
parity test cannot see → **dropped.** ⑦ The trophy tier badge freezes at **gold** at any total → the solo ladder becomes trophy count + level, gates
move off `tierFromStats`, retiring rev 1's `xpTierFloor` field.

**Conceded, majors.** The rank badge shares the demotion bug and `rankFloor` does not protect it (1d). Slice 2 could not be "server only" and a
bot-**count** table left 3v3 undefined — both solved by inverting `xpFactor` to `humanFrac`. Two different grades from one wire field → now one. Track
B needed three columns and a `botLevel 11` footnote. The trophy track had **no** win-trading defense → `meetTaper`. Bot spam beat human play
**2.19×/min** → vs-bots ceremony + `botTaper`, landing at 0.97×/session. #9's "zero cost" was right for the wrong reason (the badge already ships in
`RankBadge.jsx`); #10's fix site is `pollRank`, not `flash`; #8 would have lied in the hub tooltip. Smaller: `botLevel` null → 0 not 5; goal
exposure **1100** not 500; the modal win is **3 goals / 130**, not 2 / 120; *today*'s rank row is +30…+40 because the streak bonus leaks onto bot
matches; reported `botLevel` ≠ difficulty played (1f); the reveal collision and loss confetti are pre-existing; every line number became a grep-able excerpt.

**Rejected.** ① *"Drop the roster floor to ≤0.24"* (exploitability). No — 0.20 was deliberately raised to 0.50 on 2026-07-25 precisely because it
punished the majority path twice, and 130 → 31 is an unshippable launch. That critic's own sentence, *"payout tuning cannot fix a time-denominator
gap"*, is why I fixed the denominator instead; the session taper reaches better parity (0.97×) than 0.24 would per match. ② *"The 'activates 5 dormant
systems' claim is false"* (exploitability). Narrowed, not withdrawn: false for AFK players and guests — which is why 1b exists — and true for the
100%-of-matches case the claim was about, bots in the `matchStart` roster. ③ *"Ask #2 ships zero new player-visible behaviour"* (brief-audit). No:
byte-identical totals are the *point* (no regression), and four line items on the post-match screen are exactly what the ask asked for. I conceded the
standalone row, not the decomposition. ④ *"Publish the count of accounts with xp ≥ 4000"* (brief-audit). Needed, but this seat has no DB access →
**Q6**. ⑤ Kept untouched because unattacked: no opponent strength on trophies (#5), rank pays 0 for played, the coarse tier index (#7), and the
deferral of opponent strength.

**Left standing by the critics** (recorded so nobody "fixes" it into an exploit): throwing is dominated 4.3×; own goals are unaimable (`handleBallBounds`
+ `bouncePost` make the goal line the field edge, with no own-goal credit path); an instant quit pays exactly 0; `resetBall` is correctly gated to
training; and **`addBot` is safe** — `startMatch` clears `r.lobbyBots` and `fillBots` recreates them with `isBot: true`. 2e tests that last one: promoting
`lobbyBots` into the `matchStart` roster is the one refactor that would turn a safe feature into the guest-room exploit.
