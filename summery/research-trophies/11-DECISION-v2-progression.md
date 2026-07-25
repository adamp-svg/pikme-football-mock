# 11 — DECISION v2: TROPHIES + RANK PROGRESSION (chair ruling)

> **Date 2026-07-26 · Chair of the 6-seat council · Seat docs `06`–`10` hold the detail.**
> Status: **DECIDED, NOT BUILT.** No code was edited to produce this doc.

## 0. The headline that reframes all 7 asks

**The bot/human split has never executed in production.** I verified this myself, independently of
the seat that reported it (seat `10`), by re-running the shipped `postMatchResult` arithmetic against
the real `matchStart` payload:

```
SHIPPED  (client.js:3409 — matchRoster = msg.players, bots INCLUDED):
  { humanOpponents: 2, vsHuman: true,  humanCount: 4, xpFactor: 1.00 }   ← solo vs 3 BOTS
FIXED    (matchRoster = msg.players.filter(p => !p.isBot)):
  { humanOpponents: 0, vsHuman: false, humanCount: 1, xpFactor: 0.20 }
```

`server.js:261` appends bot entries (each carrying `isBot: true`) into the same `roster` sent as
`matchStart.players` (`server.js:627`); `client.js:3409` assigns all of it to `matchRoster`, whose own
comment at L3479 says *"(humans)"*. So every bot defense — `BOT_RATE` 0.4, `botCeiling`, `BOT_DAILY_CAP`,
`TROPHY_BOT_FLOOR` 0.5, and the `winsVsBot` tier gate — **has never run once.** `isBot` is already on
`matchStart`, so the fix is one `.filter()`, not a wire change (`client.js:3412` already uses it).

1. **Asks #3 and #4 are a one-line bug fix, not a feature.** The graded signal is built and wired.
2. **The fix is a NERF on the majority path, not a raise.** Trophies for a solo bot win fall **120 → 60**
   and rank **+30 → +12**. Seat `06`'s claim that "every value is ≥ today so no player's payout drops"
   is true of the *code path* and **false of production**. This must be announced, not shipped quietly.
3. **Fixing the bot bug ACTIVATES a rule-#1 violation.** `winsVsBot` is always `0` today (it increments
   only when `!vsHuman`, `user.js:1268`), so the champion gate `wh < wb` cannot fire. Fix the roster and
   it goes live. Verified by executing the shipped module:
   `tierFromStats({xp:40000, wh:100, wb:99})` → **champion**; `wb:101` → **diamond**. Two bot wins demote
   a champion. **So the sticky tier floor must ship in the SAME commit as the roster fix.** No seat
   connected these two; it is the single most important finding in this doc.

---

## 1. THE DECISION IN ONE TABLE

### Track A — גביעים / trophies (`xp`, MONOTONIC, never drops)

`total = round((PLAYED + outcome + 10 × min(goalsFor, 5)) × roster) + 200 first win of day`

| Result | 3 bots (×0.50) | 2 bots+1H (×0.65) | 1 bot+2H (×0.80) | 3 humans (×1.00) | Today (all shapes) |
|---|---|---|---|---|---|
| **Win** (2 goals) | **60** | **78** | **96** | **120** | 120 |
| **Tie** (1 goal) | **30** | **39** | **48** | **60** | 60 |
| **Loss** (0 goals) | **15** | **20** | **24** | **30** | 30 |
| **Played** only (no result) | **10** | **13** | **16** | **20** | *(unpaid)* |
| Opponent-strength multiplier | **1.00** | **1.00** | **1.00** | **1.00** | 1.00 |

Terms: `PLAYED 20` · `+WIN 80` · `+TIE 30` · `+LOSS 10` · `+10/goal capped at 5 goals` · `+200` first
win/day (roster-blind) · `TROPHY_PLAYED_MAX 30` (break-even is 66) · **opponent strength never scales
trophies.** Pre-roster totals are **100/50/30 — byte-identical to shipped**, so ask #2 costs nothing.

### Track B — דרגה / rank (`rankPoints`, LOSABLE) — computed with the shipped `scale()`

| My tier | Shape | Win | Loss | Draw |
|---|---|---|---|---|
| **bronze** (rp 100) | 3 bots | **+12** | **0** | **+4** |
| | 2 bots+1H | **+14** | **0** | **+5** |
| | 1 bot+2H | **+22** | **0** | **+7** |
| | 3 humans | **+30** | **0** | **+10** |
| **gold** (rp 600) | 3 bots | **+10** | **−3** | **+3** |
| | 2 bots+1H | **+12** | **−4** | **+4** |
| | 1 bot+2H | **+18** | **−6** | **+6** |
| | 3 humans | **+25** | **−8** | **+8** |
| *today, production* | *all four* | *+30 / +25* | *0 / −8* | *+10 / +8* |

**Rank pays 0 for "played". Non-negotiable** — a losable ladder must never pay for attendance.
Bands, `TIER_MIN`, streak (+2/win, max +10, human wins only), first-loss-free, `OPPONENT_DAILY_LIMIT 3`
and the sticky `rankFloor` are all **unchanged**.

### Opponent-strength multiplier — RANK ONLY, and **DEFERRED** (see §6 Q3)

`g = clamp(oppTierIdx − myTierIdx, −2, +2)`, coarse tier index 0–6, never exact points:

| g | −2 | −1 | 0 | +1 | +2 | unknown / guest |
|---|---|---|---|---|---|---|
| Win × | 0.70 | 0.85 | **1.00** | 1.15 | **1.30** | 1.00 |
| Loss × | 1.30 | 1.15 | **1.00** | 0.85 | **0.70** | 1.00 |
| Draw × | 0.80 | 0.90 | **1.00** | 1.10 | 1.20 | 1.00 |

Gold player (+25/−8): beat a diamond **+33**, lose to them **−6**; beat a silver **+21**, lose **−10**.

---

## 2. THE 7 ASKS

**#1 — Trophies can only go up.** Already true of the number: `computeMatchXp` has no negative term and
the route writes `$inc {xp}`, so the floor is `round(30 × 0.5) = 15` (verified by execution). But the
**badge lies**: `tierFromStats`' champion gate demotes on bot wins (champion → diamond, verified), and it
is dormant today *only* because the roster bug pins `winsVsBot` at 0. Fix one and you arm the other.
Ship a monotone `xpTierFloor` — literally the `rankFloor` `Math.max` pattern already live in
`applyRankDelta` — in the same commit, plus three assertions (`computeMatchXp >= 0`; route never writes
`xp < doc.xp`; `xpTierFloor` after ≥ before). One trap: `client.js:1120` `xpBigNum('+' + …)` hardcodes the
plus and has no minus path. **Verdict: CONFIRMED for the number; the BADGE is broken and the fix is mandatory in slice 1.**

**#2 — Different numbers for win / lose / tie / played.** `PLAYED 20 + WIN 80 / TIE 30 / LOSS 10`, additive,
summing to today's exact 100/50/30. "Played" is the floor the three outcomes are built **on**, plus the
standalone payout for a no-result match — **not** a fourth bonus stacked on a win (that reading inflates
every category ~25% and is the single most likely implementation bug). Seat `08` feared an always-on term
is a free bot farm; seat `09` disproved it from the sim: own goals are **physically impossible**
(`sim.js:410-421` makes the goal line a solid wall for the non-attacking team), so you cannot force a fast
loss, and throwing pays 12.7 tr/min against 23.6–83.0 for winning — dominated 6.5×. Keep `PLAYED` strictly
below a loss (20 < 30) so a 0-5 player is never better off idling. **Verdict: ADDITIVE 20/80/30/10, totals unchanged, hard ceiling 30 with the break-even 66 written into the code comment.**

**#3 — Different trophies per number of bots.** The graded signal exists, is wired end to end, and is
**dead**. Grade it: **0.50 / 0.65 / 0.80 / 1.00** for 3 / 2 / 1 / 0 bots. Derive it from the human COUNT,
never from literal `xpFactor` values — seat `10`'s forward-compat catch is real: the in-flight 3v3 mode
makes `otherSlots = 5` (0.36/0.52/0.68/0.84/1.00) and 1v1 makes it 1, so a table keyed on `0.47` silently
breaks. The teammate-vs-opponent distinction is a genuine gap (a bot *teammate* does not make the match
easier — arguably harder) but it needs fields the shipped app drops. **Verdict: SHIP the 4-value grade keyed on derived human count; DEFER the teammate/opponent split to the next iOS build.**

**#4 — Bots give less than humans.** Yes, and the intent is already coded — it just never ran. Keep
`TROPHY_BOT_FLOOR = 0.50`; do **not** lower it, because turning it on is already a 50% cut on the majority
path. The honest ratio is **0.68, not 0.50**: the roster-blind `+200` first-win-of-day is worth 28% of a bot
match but only 19% of a human one, so effective value is ~71.9 vs ~106.5 (seat `09`). Keep it roster-blind —
the come-back-tomorrow hook must fire on the path most players are on.
**Verdict: 0.50 floor, roster-blind +200, and the real spread is 1.48×, not 2×.**

**#5 — Trophies for higher-RANK / higher-TROPHY opponents.** All five seats independently refused this on the
trophy track; that unanimity decides it. On a monotonic track the modifier can only be a bonus — which
becomes "queue up to farm trophies" and destroys the one property trophies must keep: you can predict the
payout before you press play. The second half is a harder no: **opponent trophies measure account AGE, not
strength** — after the roster fix, most existing trophy totals are bot-earned, so keying on them pays you
for beating the oldest account in your friend list. And the input does not exist: `opponentKey` is an
irreversible SHA-256, `matchStart` carries no ranks, and the game server makes zero outbound calls to
pikme-server (seat `07`'s blocker). **Verdict: NO on trophies, ever. RANK only, and DEFERRED until the wire exists.**

**#6 — Rank between only humans.** Directionally right; the literal version ships a dead wall. All five
seats agree. Taken literally it deletes locked §7.1, makes `BOT_DAILY_CAP` and `botRankToday` dead code,
and — worst — `hub-rank.js:162` (`if (!amount) return`) draws **nothing** after a bot match: no progress and
no explanation, forever, on the majority path. Implement it as **"rank is human-only above gold"** using a
**rate**, not a `botCeiling` edit: `botCeiling` is parity-locked (`test-rank-parity.mjs` checks all 12
levels, and it **SKIPs green** when the sibling checkout is absent), `BOT_RATE` is not — so the rate version
is a one-repo change. Separately, seat `09` found the solo answer for free: the trophy track **already has
its own 7-tier badge** (`tierFromStats`/`XP_TIER_MIN`), already farm-gated at **gold** for a bot-only
account. Surface it and a solo player has a real, honest, unfarmable ladder at zero cost — but only after
`xpTierFloor`, since that badge is the one that can demote. **Verdict: human-only ABOVE GOLD via BOT_RATE; surface the existing trophy badge as the solo ladder; exact rate is Q1 for the user.**

**#7 — Rank XP by opponent rank, trophies, or both?** Unanimous across all five seats: **rank only.**
"Both" is provably double-counting — `seedRankFromXp` already maps a legacy trophy standing onto the rank
ladder, so rank *already contains* the trophy signal. Trophies keep influencing rank the way §8 intends:
indirectly, through `levelFromXp → botLevelFromXp → botCeiling →` the rank **roof**, never through the
payout. Use the coarse **tier index 0–6**, not exact points: the only untampered channel is a signed JWT
claim that can be up to 12h stale, and a tier boundary is rarely crossed inside 12h.
**Verdict: opponent RANK only, as a coarse tier index, applied to the rank delta only.**

---

## 3. WHERE THE SEATS DISAGREED AND HOW I RULED

| Conflict | Seats | Ruling |
|---|---|---|
| Is the bot split live? | `10` says dead (by execution) vs `06`/`08`/`09` tuned against the code path | **`10` wins — I reproduced it.** Every "vs today" number in `06`/`08`/`09` is wrong: production pays 1.00, not 0.50. |
| Roster values | `06` 0.50/0.67/0.83/1.00 · `09` 0.50/0.65/0.80/1.00 · `08` six shapes · `10` 0.55/0.75/1.00 on opponents only | **`09`.** 15-point steps a player can feel and Hebrew copy can name; 0.67/0.83 are artifacts of a linear formula. `08`/`10`'s seat-aware versions need an iOS build → slice 3. |
| "Played" additive or renamed? | `06`/`09`/`10` additive 20/80/30/10 (independent convergence) vs `08` rename-only | **Additive.** `08`'s farm fear is refuted by `09`'s own sim reading: own goals impossible, throwing dominated 6.5×. |
| Goal cap | `06` min(60, 10×goals) vs `09` min(goalsFor, 5) | **`09` — cap 5 (+50).** `09` verified brawl is timed with no early end, so 40 goals is reachable: uncapped that is **500** trophies from one bot match. This is the real leak and the only payout I cut. |
| Opponent-strength formula | `07` logistic, ELO_D 800, 14 constants vs `06` 5-bucket ±50% vs `10` ±0.15/tier, clamp ±2 | **`10`.** `07` built the best math then proved it unshippable: exact points need a channel we lack, and its own 12h staleness note argues for a coarse index. 14 constants × 2 repos also breaks parity CI. |
| Ask #6 mechanism | `08` `practicePoints` (new field) · `06` ceiling→500 · `10` `BOT_RATE` 0.25 + 500 stop · `09` surface the trophy badge | **`10`'s rate + `09`'s free badge.** Rate = one repo, no parity break. `08`'s `practicePoints` is elegant but adds a schema field and a second number to explain; hold it as fallback. |
| Bot-difficulty bonus | `08` proposes `4 × max(0, L−5)` (+24 at L11) | **REJECTED for now.** `08`'s own risk note kills it: `client.js:2221` sends the raw manual `diffLevel`, so an L1 player picks קטלני and — trophies being monotonic — farms +24 risk-free. Revisit only with the `effLevel` cap. |
| Duration gate on "played" | `09` ≥45s · `06` ≥60s | **NEITHER — unimplementable.** `durationSec` is the constant `MATCH_DURATION = 120` (`client.js:546`), so the app's own `>= 30` gate is already dead code. Needs a real field + iOS build. Not urgent: the exploit it guards is physically blocked. |

---

## 4. WHAT THIS CHANGES VS SHIPPED

| # | Change | Type | File |
|---|---|---|---|
| 1 | `matchRoster` excludes bots (`.filter(p => !p.isBot)`) | **BREAKING** (activates 5 dormant systems; nerfs the majority path) | `football-mock/public/client.js:3409` |
| 2 | `xpTierFloor` — sticky monotone trophy tier | **BREAKING** (new field; must land with #1) | `pikme-server/data/football-xp.js`, `data/footballstats.js` |
| 3 | `PLAYED 20 / WIN 80 / TIE 30 / LOSS 10` decomposition | ADDITIVE (totals identical) | `pikme-server/data/football-xp.js` |
| 4 | Goal term capped at 5 goals | **BREAKING** — the one payout cut (40-goal brawl 500 → 150) | `pikme-server/data/football-xp.js` |
| 5 | Roster grade 0.50/0.65/0.80/1.00 replaces the `[0.5,1.0]` clamp | **BREAKING** | `pikme-server/data/football-xp.js:42-45` |
| 6 | Payout for a no-result match (`played` only) | ADDITIVE | `pikme-server/routes-pikme/user.js` |
| 7 | 3 monotonicity assertions | ADDITIVE | `pikme-server/test-football-xp.mjs` |
| 8 | `BOT_RATE` 0.40 → 0.25, bots pay 0 at/above 500, `BOT_DAILY_CAP` 150 → 60 | **BREAKING** (needs Q1) | `pikme-server/data/football-rank.js:40-41` |
| 9 | Surface the existing trophy tier badge as the solo ladder | ADDITIVE | `football-mock/public/client.js` (hub) |
| 10 | Bot-match state for the rank badge (`אין דרגה מול בוטים`) | ADDITIVE, **required** if #8 ships | `football-mock/public/hub-rank.js:162` |
| 11 | Opponent-strength tier multiplier | ADDITIVE, **DEFERRED** | `data/football-rank.js:124` + JWT claim + `opponentKey` packing |
| 12 | Teammate/opponent roster split | ADDITIVE, **needs iOS** | `pikmeTV-saltiz/services/saltizFootball.js:32,35` |

**Migration cannot be undone:** the roster fix is not retroactive. `winsVsHuman` is inflated with bot wins,
`winsVsBot` is 0, and `recordedMatchIds` holds only ids — no history to recount from. The current playerbase
is **permanently grandfathered past the platinum gate** (`winsVsHuman >= 25`). Accept it plus a
`humanStatsFrom` date. Do **not** re-seed or claw back: that is a decrease, forbidden by ask #1.

---

## 5. WHAT CONTRADICTS THE LOCKED §7 DECISIONS — USER MUST UNLOCK

1. **§7.1 is contradicted twice.** It locks `botCeiling(L) = 60 + 80L`, bots paying **40% below it and 0
   above**, carrying a solo player to ~940 (inside platinum), only champion/legend human-only. Ask #6 cannot
   coexist with that. Item #8 (`BOT_RATE` 0.25, hard stop 500) is a **deliberate partial override of a
   signed-off decision.** Separately: §7.1 was never *tested* in production — the roster bug pinned
   `isBotMatch` to `false`, so `test-football-rank.mjs:203-236` proves it in unit tests only.
2. **§8's "revisit rank if anyone approaches diamond" can never fire** under ask #6 plus a 500 stop without
   a real human population. The ladder above gold is aspirational-only at current headcount.
3. **§6's "every change is additive" no longer holds** — items 1, 2, 4, 5, 8 are breaking, and
   `test-football-xp.mjs:72-87` plus `test-football-rank.mjs:36-38, 94-111, 203-241` rewrite.
4. **§7.3's "XP bar stays a thin secondary bar" is in tension with ask #2.** Supercell killed Masteries on
   2025-06-24 because only **11.8%** of players engaged — a hidden volume medal gets ignored.

---

## 6. OPEN QUESTIONS ONLY THE USER CAN ANSWER

**Q1 — Ask #6: how hard a wall for the solo player?** *Recommend A.*
**(A)** Bots pay rank at **0.25** up to **500** (gold entry), then 0 forever — a solo player reaches gold,
platinum+ is genuinely human-only, and the existing trophy badge (bronze→gold, already farm-gated) is
surfaced as their real ladder. **(B)** Bots pay **0 rank, ever** — literal #6, and a badge that never moves
for most of your players. *A honours the intent of #6 ("a rank means you beat humans") without a dead wall.
B is cleaner to explain and worse to live with. Either way this overrides locked §7.1.*

**Q2 — The nerf is unavoidable; do we soften the landing?** *Recommend A.*
**(A)** Ship the roster fix at the numbers above (solo bot win 120 → 60 trophies, +30 → +12 rank) and
**announce it** as a bug fix with a one-off goodwill grant. **(B)** Ship the fix but raise
`TROPHY_BOT_FLOOR` 0.50 → 0.60 so the solo cut is 120 → 72 instead of 60. *A is the honest number and the
one the whole design assumes; B buys quiet at the cost of the bot/human gap you asked for in #4. Note that
under either, no stored number decreases — only future payouts.*

**Q3 — Opponent strength (#5/#7): defer or fund the plumbing?** *Recommend A.*
**(A)** **Defer.** Ship nothing now: it needs signed rank claims in the football-token JWT, digits packed
into `opponentKey`'s 8 spare bytes, and a split before `countMeetings` or the win-trading cap fragments —
5 files, 2 repos, and it breaks `test-opponent-key.mjs:27`. It matters for ~0% of current matches while the
roster bug affects 100%. **(B)** Fund it now at the ±0.15/tier table in §1. *A. Fix what is broken before
adding what is subtle.*

**Q4 — Ask #2: four numbers on the post-match screen, or keep it quiet?** *Recommend A.*
**(A)** Show all four lines (`+20 שיחקת · +10 הפסדת · +10 גול`) and give the trophy total real space,
accepting that §7.3 said the XP bar stays thin. **(B)** Keep the thin bar and show only the total.
*A — a losing screen showing three earned things is the entire reason the monotonic track exists, and the
Masteries post-mortem (11.8% engagement) is what B looks like in 18 months.* Note: a "played" payout means
every match now clears `playXpReveal`'s down-guard, so **losses get the golden confetti** — and the muted
rank drop fires from the same 700ms tick. Serialize rank after xp or a loss celebrates and punishes at once.

---

## 7. SHIP ORDER

| # | Slice | Repos | Why here |
|---|---|---|---|
| **1** | **Roster fix + `xpTierFloor` + 3 monotonicity assertions, ONE commit** | game + server | The fix arms the demotion bug; they cannot be split. Take the lock on `public/client.js` — it is the most contended file in the repo. |
| **2** | Trophy math: `PLAYED/WIN/TIE/LOSS` 20/80/30/10, goal cap 5, roster grade 0.50/0.65/0.80/1.00 | server only | Pure math, fully unit-testable, no UI, no app. Totals unchanged except the two intended cuts. |
| **3** | Hub: surface the trophy tier badge; rank badge bot-state; serialize the two reveals | game only | Makes slice 1 legible and answers Q1's solo half at zero backend cost. |
| **4** | Ask #6: `BOT_RATE` 0.25 + 500 stop + `BOT_DAILY_CAP` 60 | server only (as a **rate**, not a ceiling) | Needs Q1. As a rate it stays single-repo and cannot break `test-rank-parity.mjs`. |
| **5** | Teammate/opponent roster split (`humanOpponents`, `humanCount`, `totalPlayers`) | **needs iOS** | Fields are ALREADY sent by the game and dropped at `saltizFootball.js:32,35`. Off our release train. |
| **6** | Opponent-strength multiplier | game + server + app | **DEFER** per Q3. |

**Backend-pure-math first is possible because the shipped app already forwards `xpFactor` and `vsHuman`**
(verified in `saltizFootball.js`) — so slices 1–4 need **no iOS build**. Only slices 5–6 do.

**Before slice 1, fix the CI hole:** `test-rank-parity.mjs` exits **0 (green)** when the sibling
`../pikme-server` checkout is absent. The guard this council is relying on is conditional.
