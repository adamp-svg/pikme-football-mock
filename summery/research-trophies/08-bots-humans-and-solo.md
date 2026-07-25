# 08 — Bots vs humans, bot COUNT, and the solo-player consequence

> Seat: asks **#3** (per-bot-count), **#4** (bots pay less), **#6** (rank = humans only), plus the bot
> half of #5/#7. Date 2026-07-26. Builds on `00-DECISION.md` §7/§8 — does not redo `01`–`05`.
> Every number below is labelled **VERIFIED** (a shipped game does this, cited) or **INFERRED** (my proposal).

---

## 0. Conclusion — four things, in priority order

1. **Ask #6 does not need to delete the bot-rank machinery. Re-point it.**
   Keep `computeMatchRank` byte-for-byte — `BOT_RATE 0.4`, `BOT_DAILY_CAP 150`, `botCeiling(L)=60+80L`,
   all of it — but when `isBotMatch` is true, write the delta to a **new field `practicePoints`**
   instead of `rankPoints`. `practicePoints` is never called דרגה, never on the leaderboard, never in
   the badge over the hero. Ask #6 is then literally true ("דרגה is between humans only") and **zero
   constants are deleted, zero tests are rewritten** — the bot-ceiling suite just moves to asserting on
   the practice field. This is the single highest-leverage answer in this doc.
   Precedent: **Rocket League Casual has a real MMR that is never displayed and never touches Competitive rank** (VERIFIED).

2. **If you instead do the naive version (bot match → rank delta 0, nothing added), price this:**
   a solo player's rank is **0 forever** — not slow, zero. And it silently kills `botCeiling`,
   `BOT_DAILY_CAP`, the `botRankToday`/`botRankDate` columns, `rollDailyCounters`, farm-gate #1, and
   makes the shipped hub nudge *"העלה את רמת הקושי כדי להמשיך לעלות"* a **lie** (raising difficulty no
   longer helps anything). ~40 assertions across 4 test files stop testing anything; `test-rank-parity.mjs`
   **hard-fails the build**. Full enumeration in §5.

3. **Ask #3 needs NO new game-client field.** `public/client.js` `postMatchResult` (~L525-552) already
   computes and sends `humanOpponents`, `humanCount`, `totalPlayers`. The **app throws them away**:
   `pikmeTV-saltiz/services/saltizFootball.js` L32/L35 and `app/pages/football.jsx` L277-291 forward only
   `{matchId,result,goalsFor,goalsAgainst,vsHuman,xpFactor,stats,botLevel,opponentKey}`. Wiring the
   bot-TEAMMATE-vs-bot-OPPONENT distinction = adding **three existing field names** to two app files +
   one TestFlight build. No game deploy, no wire-format change, no `sim.js`.

4. **Trophy roster multiplier** (ask #4): replace the `min(1, max(0.5, xpFactor))` clamp with
   `m = 0.50 + 0.50 × (0.8·oppFrac + 0.2·mateFrac)` → six concrete values **0.50 / 0.60 / 0.70 / 0.80 / 0.90 / 1.00**.
   Bot **difficulty** pays a separate **additive, win-only** bonus (`+4 × max(0, L−5)`, max **+24**), never a
   rate — and it **must** be capped at `botLevelFromXp(xp)+2`, because the manual difficulty picker is
   *not* XP-clamped in `botGame` mode (`client.js` L2221 sends the raw `diffLevel`), so an L1 player can
   already select קטלני today.

---

## 1. Answers to the 7 asks (from this seat)

**#1 — trophies can only go up.** Already true and my proposal keeps it true. `computeMatchXp` returns
`base(30/50/100) + 10·goals`, times `m ∈ [0.50, 1.00]`, plus `+200` — every term is ≥ 0, and the route
writes xp with `$inc`, so a decrease is structurally impossible. My changes are: a *larger* floor set
(min stays 0.50) and a *purely additive* difficulty bonus. **Nothing I propose can produce a negative.**
The one place a "down" can still leak in is `rankPoints`, which is a different field and is *supposed* to drop.

**#2 — different numbers for WIN / LOSE / TIE / PLAYED.** From this seat: keep **three** bases, not four.
`played` should be the **loss base renamed in the UI**, not a fourth additive term. Reason specific to my
seat: a separate always-on `played` term is the one thing a bot-grinder can farm with zero skill and zero
risk (bot matches are unlimited, monotonic, and the difficulty is a setting). Adding e.g. `+15 played` on
top of the existing bases would raise the all-bot loss payout from 30·0.5=15 to 22 and cut matches-to-L12
by ~25% for a player who never wins. If the user wants "played" visible, show the loss/draw payout
**labelled** `+15 על השתתפות` — same number, better copy, no new farm surface. (Ask #2's grind-curve math
proper belongs to the trophy-curve seat; this is only the bot-farm objection.)

**#3 — bot count, and where the bot sits.** Six real 2v2 shapes, not four. Table in §3. The distinction is
worth wiring: it is the difference between *"I carried a bot against two humans"* (hardest match in the
game) and *"me and my friend beat two bots"* (easiest), and today both pay the same 0.73/0.50. Cost is one
app change, not a game change (§0.3). Flat human-count grade is the fallback if you don't want a TestFlight
build — numbers for both given in §3.

**#4 — how much less should bots pay.** All-bot stays at **0.50** (do not lower it — see §4 grind table:
0.20 was 275 matches to L12, 0.50 is 110, and the population is hundreds). What changes is that the
*middle* of the range opens up: today 3-bot and 2-bot matches are **identical** because 0.47 clamps to 0.50.
Proposal spreads them 0.50 → 0.60/0.70 → 0.80/0.90 → 1.00, i.e. **a human opponent is worth +0.20, a human
teammate +0.10**. Matches-to-L12 per shape in §4.

**#5 — opponent strength.** From this seat, only the bot half: **bot DIFFICULTY should pay trophies, bot
RANK/TROPHY count should not** (bots have no trophy count). Recommendation: additive `+4 × max(0, L−5)` on
a **win only**, max **+24** at L11, capped at `botLevelFromXp(xp)+2`. Do **not** key the trophy *rate* off
difficulty — see §6(e) for why (it punishes L0-L2 players on losses and creates a 6×12 cell matrix).
Human opponent-strength scaling is another seat's; I flag only that it must not double-count with the
roster factor (both would be reading "how hard was this match").

**#6 — rank between only humans.** Workable reading, and it is **already half-shipped**: `vsHuman` in
`client.js` L547 is `humanOpponents > 0`, and the route sets `isBotMatch = !vsHuman`, so a match with a
**bot teammate and human opponents already counts as a human match on rank today**. The strict reading
("all 4 slots human") would make rank pay in roughly **zero** matches at our population — reject it.
Recommended implementation: rank pays iff `humanOpponents ≥ 1`, at rate `max(0.5, humanOpponents/oppSlots)`,
and bot matches pay **`practicePoints`** instead (§0.1). Consequence chain in §5.

**#7 — how should ranking XP be.** From this seat: **trophies must NOT scale off opponent rank or opponent
trophies at all.** Two reasons. (a) A bot has neither, so every scaling rule needs a bot fallback constant,
and that constant instantly becomes the farm target. (b) It re-imports "skill" into the volume track,
which is the split §8 of `00-DECISION.md` just paid for. The trophy track's only strength signals should
be the **roster factor** (how human was this) and the **bot difficulty bonus** (how hard was the AI) — both
of which are *server-trusted room settings*, not opponent-supplied numbers. Opponent rank/trophies belong
on `rankPoints` only.

---

## 2. Where the bot signal actually is today (so nobody re-derives it)

| Signal | Computed | Sent by game | Forwarded by app | Read by server |
|---|---|---|---|---|
| `xpFactor` 0.20/0.47/0.73/1.00 | client.js L531-533 | ✅ | ✅ | ✅ (clamped to ≥0.5 on trophies, ≥0.4 on rank) |
| `humanOpponents` | client.js L525 | ✅ | ❌ **dropped** | ❌ |
| `humanCount` (incl. me) | client.js L530 | ✅ | ❌ **dropped** | ❌ |
| `totalPlayers` | client.js L529 | ✅ | ❌ **dropped** | ❌ |
| `vsHuman` = `humanOpponents>0` | client.js L547 | ✅ | ✅ | ✅ (`isBotMatch = !vsHuman`) |
| `botLevel` = room `diffLevel` 0..11 | client.js L551 | ✅ | ✅ | ✅ (bot ceiling only) |

`humanTeammates` is **derivable**, no new field needed: `humanTeammates = humanCount − 1 − humanOpponents`.
Verified against all six 2v2 shapes. If the user prefers one explicit field over three, name it
`humanTeammates` (int 0..1 in 2v2) — but forwarding the three that already exist is strictly better,
because `totalPlayers` is also needed to normalise 1v1 / 3v3 later.

---

## 3. Ask #3 — the six roster shapes (2v2, my point of view)

`oppSlots = totalPlayers/2 = 2` · `mateSlots = totalPlayers/2 − 1 = 1`

| # | Roster (my POV) | humanOpp | humanMate | Difficulty for me | `xpFactor` today | **Effective today** | **Proposed `m`** |
|---|---|---|---|---|---|---|---|
| **A** | bot mate + 2 bot opps (**solo**) | 0 | 0 | baseline | 0.20 | 0.50 | **0.50** |
| **B** | bot mate + 1 human opp + 1 bot opp | 1 | 0 | harder (weak partner) | 0.47 | 0.50 | **0.70** |
| **C** | human mate + 2 bot opps | 0 | 1 | **easiest** | 0.47 | 0.50 | **0.60** |
| **D** | bot mate + 2 human opps | 2 | 0 | **hardest** | 0.73 | 0.73 | **0.90** |
| **E** | human mate + 1 human opp + 1 bot opp | 1 | 1 | medium | 0.73 | 0.73 | **0.80** |
| **F** | human mate + 2 human opps | 2 | 1 | real match | 1.00 | 1.00 | **1.00** |

**The bug this fixes:** rows A/B/C all pay **exactly the same** today (0.47 clamps up to the 0.50 floor),
so a 3-bot solo grind and a real 1-human match are worth identical trophies. Rows D and E also collide at
0.73. Six distinct shapes currently produce **three** distinct payouts (0.50, 0.73, 1.00).

**Formula (INFERRED, format-general):**
```
oppFrac   = humanOpponents / oppSlots
mateFrac  = mateSlots > 0 ? humanTeammates / mateSlots : null
humanness = mateFrac === null ? oppFrac : 0.8*oppFrac + 0.2*mateFrac   // 0 .. 1
m         = TROPHY_BOT_FLOOR + (1 - TROPHY_BOT_FLOOR) * humanness      // 0.50 .. 1.00
```
Two tunables only: `TROPHY_BOT_FLOOR = 0.50` (unchanged from shipped) and `OPP_WEIGHT = 0.8`.
In 2v2 it reduces to **`m = 0.50 + 0.20·humanOpponents + 0.10·humanTeammates`**, which hits exactly 1.00 at
full human. In 1v1 (`mateSlots = 0`) it gives 0.50 vs bot / 1.00 vs human. Monotonic in total humans, so
adding a human can never reduce a payout (ask #1 safe).

**Fallback if you will not ship an app build** (flat human-count grade, INFERRED):
`m = 0.50 + 0.50 × (humanCount−1)/3` → **A 0.50 · B/C 0.67 · D/E 0.83 · F 1.00**. Keeps the 3-vs-2-bot
distinction that is currently lost, loses the seat distinction. Requires **server only** — it can be
derived from the already-forwarded `xpFactor` (`humanCount−1 = round((xpFactor−0.2)/0.8·3)`), so it ships
with no app or game change at all. **This is the cheap win; take it even if you defer the seat split.**

**Should the seat distinction be wired?** Yes, but as phase 2. Argument for: shape **D** (me + a bot
against two humans) is the single hardest match in the game and currently pays *less* than F, which is the
easiest 4-human match. Argument against, and it is real: paying more for a worse teammate creates an
incentive to **deliberately queue with a bot partner** — which is why I priced D at 0.90, still *below*
F's 1.00. Do not invert that ordering.

---

## 4. Ask #4 — how much less, and what the grind costs

Grind model is the **same one the shipped comment in `football-xp.js` L17-21 used**, so the numbers are
directly comparable: every match a win with 2 goals (base 120), no daily bonus, L12 = `50·12·11` = **6600 xp**.

| Shape | `m` | xp / match | **Matches to L12** | vs today |
|---|---|---|---|---|
| A · 3 bots | 0.50 | 60 | **110** | 110 (unchanged) |
| C · human mate + 2 bot opps | 0.60 | 72 | **92** | was 110 |
| B · bot mate + 1 human opp | 0.70 | 84 | **79** | was 110 |
| E · 2 humans, human mate | 0.80 | 96 | **69** | was 76 |
| D · 2 human opps, bot mate | 0.90 | 108 | **62** | was 76 |
| F · 3 humans | 1.00 | 120 | **55** | 55 (unchanged) |
| *(reference)* old floor | 0.20 | 24 | 275 | — |
| A + L11 difficulty bonus (+24) | 0.50 | 84 | **79** | — |

Realistic mix (55% win / 15% draw / 30% loss, 6 matches/day so the `+200` first-win amortises to +33):
all-bot 0.50 → **86 matches to L12**; all-human 1.00 → **55**. The spread narrows because the daily bonus
is roster-independent — that is deliberate and I would not change it.

**Recommendation on the floor itself: leave `TROPHY_BOT_FLOOR` at 0.50.** Do not go to 0.4 or below.
The lever is well-documented as the biggest one on solo speed (275 → 110), the playerbase is hundreds of
Hebrew speakers, and after ask #6 lands the trophy track is the **only** progression a solo player has
(§5) — halving it would leave them with nothing that moves. If anything the honest move after #6 is to
raise it to 0.55 (100 matches), and I would rather buy solo goodwill with the **difficulty bonus** than
with a higher floor, because the bonus requires actually beating a hard bot.

---

## 5. Ask #6 — the full consequence chain in OUR code

### 5a. If bot matches pay 0 rank (naive reading)

**Becomes dead / deletable in `pikme-server/data/football-rank.js`:**

| Thing | Line | Status | Note |
|---|---|---|---|
| `BOT_RATE = 0.4` | L40 | **half-dead** | The `bot ? BOT_RATE` branch dies, but L122 still uses it as the *mixed-roster floor* `max(BOT_RATE, xpFactor)`. Don't grep-and-delete. Rename to `RANK_MIXED_FLOOR` and re-key it to `humanOpponents/oppSlots`. |
| `BOT_DAILY_CAP = 150` | L41 | **dead** | Only reachable inside `if (delta > 0 && bot)`. |
| `botCeiling()` | L52-58 | **dead in the delta**, alive elsewhere | Only call sites in the delta are L111/L131-132. Still exported and consumed by the route's JSON response, `shared/rank.js`, `hub-rank.js`, and 3 test files. Deleting it **breaks `test-rank-parity.mjs`**, which fails the build. |
| `BOT_LEVEL_MAX = 11` | L45 | dead here | Only used by `botCeiling`. Mirror in `shared/rank.js` stays. |
| the `if (bot)` block | L108-116 | dead | |
| `if (delta > 0 && bot)` cap block | L127-133 | dead | |
| `rollDailyCounters()` | L153-156 | **dead** | Its only job is the bot allowance. |
| `botLevel` param of `computeMatchRank` | L94 | unused | The route still needs it for the response's `botCeiling`. |
| **`applyFarmGates` gate 1** (`i>=3 && wh<25 → gold`) | L187 | **UNREACHABLE** | Proved: with human-only rank, reaching platinum (900) takes **34 human wins** minimum (7+11+16 at bands 30/28/25, zero losses) — always > 25. The gate can never fire. |
| **`applyFarmGates` gate 2** (`i>=5 && wh<wb → diamond`) | L188 | **alive but now unfair** | Champion (2200) takes **112 human wins**. A solo-heavy player with 112 human wins and 200 bot wins gets capped at diamond — punished for *practising*, when bot wins now contribute 0 rank. **Recommend deleting gate 2 under ask #6.** |
| `seedRankFromXp` | L202-216 | **contradicts #6** | It maps legacy `xp` (which was bot-fed) onto rank, i.e. hands out rank bots earned. It is one-off and `rankSeeded` is already true for live accounts. **Do not re-seed and do not claw back** — that is a decrease, which is exactly the erasure anger `00-DECISION.md` §6 warns about. Leave it; document that it is a grandfathered inconsistency. |

**Schema (`data/footballstats.js`) — keep, do not drop:** `botRankToday` (L227), `botRankDate` (L221-227)
become vestigial. Keeping them makes a rollback a one-line change; dropping them makes it a migration.

**Route (`routes-pikme/user.js`) becomes dead:** L1304-1306 `rollDailyCounters` call, L1316
`botRankToday` arg, L1324 `botRankGain`, L1358 `botRankToday` write. L1298 `botLevel` fallback comment
("assume DEFAULT_LEVEL 5 … so a missing field doesn't silently strangle bot payouts") becomes moot.

**UI becomes wrong, not just stale:**
- `public/hub-rank.js` L98-101 tooltip: *"העלה את רמת הקושי כדי להמשיך לעלות"* — **false**. Raising bot
  difficulty no longer affects rank at all. Must become the L11 string it already has:
  *"שחקנים אמיתיים"* / "only real players raise your דרגה".
- `hub-tier-capped` class (L78) would need to mean "capped because no humans", i.e. always-on for a solo
  player — which reads as permanently broken. Recommend the class stops keying off `botLevel`.
- `atBotCeiling()` in `shared/rank.js` L69-71 loses its consumer.

**The shipped interlock loses its second half.** Today: trophy level → `botLevelFromXp` → bot difficulty →
`botCeiling` → rank roof. After #6 the chain stops at "bot difficulty", which then affects nothing except
how hard the match feels. `00-DECISION.md` §8's closing claim ("collecting trophies raises the roof on
rank without ever handing rank out for free") becomes **untrue** and should be struck. Under my §0.1
recommendation the interlock survives intact, pointed at `practicePoints`.

### 5b. Test assertions that must change (read, not edited)

`pikme-server/test-football-rank.mjs`
- L33 the `BOTS` fixture itself — every test using it changes meaning.
- L36 `'bot matches pay 40%'` · L37 `'bot rankPoints capped at 150/day'` — constants gone/renamed.
- L42-49 the whole `botCeiling(L)` block: `'L0 (אימון) ceiling 60'`, `'L5 (normal) ceiling 460'`,
  `'L8 ceiling 700'`, `'L11 (קטלני) ceiling 940 — the hard bot cap'`, `'clamped to the ladder (L11)'`,
  `'clamped to L0'`, `'bots can reach platinum but NEVER diamond+'`.
- L78 `'a bot-heavy mixed match floors at the 0.40 bot rate = 10'` → new floor rule.
- L84 `'protection applies to bot matches too'` → still returns 0, but **vacuously**; it stops testing
  first-loss protection at all.
- L91 `'bot win gets NO streak bonus (30*0.4)'` expects 12 → 0.
- L94-104 the entire `BOT CEILING` section, 10 assertions, incl. `'AT the L11 ceiling: bot win pays 0'`,
  `'at the ceiling a bot loss also costs 0'`, `'L0 bots (ceiling 60) pay nothing to a 200-trophy player'`,
  `'L0 bots still pay below 60'`, `'a bot win cannot push you PAST the ceiling'`,
  `'below the L5 ceiling (460) it pays normally'`, `'at the L5 ceiling you must raise the difficulty to climb'`.
- L106-111 the `daily bot cap` section, 5 assertions: `'fresh day = full 12'`, `'only 6 of the cap left'`,
  `'cap reached = 0'`, `'the cap limits GAINS only, losses still apply'` → all 0.
  `'the bot cap never limits a human match'` survives.
- L129-130 gate-1 assertions (`'platinum+ needs 25 human wins, else gold'`, `'25 human wins unlocks platinum'`)
  → become tests of unreachable code.
- L131-132 gate-2 assertions → delete if gate 2 goes.
- L144-150 the three `rollDailyCounters` assertions → the function is dead.
- L190-192 `seedRankFromXp` bot-farm assertions (`'a bot-FARMED account … is gated to gold'`, `'its floor is gold too'`).
- **JOURNEY L203-236 — the largest casualty.** `l5` (`'L5 bots carry a player to exactly the 460 ceiling'`,
  `'they stall before match 200'`, `'the badge is still capped at silver'`), `l11`
  (`'raising the difficulty to L11 unlocks the climb up to 940'`, `'bots can NEVER reach diamond'`,
  `'at 940 with human wins they wear platinum'`), `grind`
  (`'grinding bots all day tops out at the 150/day cap'`). All collapse to `rankPoints: 0, played: 1`.
  This block is the *proof of the headline design claim* in §7.1 of `00-DECISION.md`; ask #6 deletes the claim.
- L239-241 `humans` journey and L244-245 `collapse` (sticky floor) — **survive unchanged**.

`football-mock/test-rank-parity.mjs` — **this is the one that fails the build**
- L41-47 `'botCeiling matches at every difficulty level 0..11'` — fails the moment the server drops
  `botCeiling` while `shared/rank.js` keeps it. `RANK_TIERS` / `TIER_MIN` / `TIER_HE` assertions unaffected.

`football-mock/test-rank.mjs`
- `'botCeiling (same formula as the server: 60 + 80*L)'` block — 4 assertions (L0/L5/L11/clamped).
- the whole `atBotCeiling — drives the "raise the difficulty" nudge` block — 5 assertions incl.
  `'at the L5 ceiling → nudge'`, `'at the top bot ceiling → nudge (only humans pay now)'`.

`football-mock/test-hub-rank.mjs`
- `--- BOT CEILING: the meter reads LOCKED, not merely stalled ---` — 5 assertions incl.
  `'at the L5 ceiling the badge is marked capped'`, `'and the tooltip says to raise the difficulty'`,
  `'one point below the ceiling it is not capped'`.
- `--- botLevel absence must not read as difficulty 0 ---` — 4 assertions; the whole guard becomes moot.

`pikme-server/test-football-xp.mjs` — unaffected by #6, but my §3 proposal changes:
- L76 `'a mixed roster above the floor is honoured (0.47 -> clamped to 0.5)'` → 0.60 or 0.70 by shape.
- L77 `'a 3-human roster pays its graded 0.73'` → 0.80 or 0.90 by shape.
- L73-75 all-bot assertions (65 / 60 / 20) **survive** — the 0.50 floor is unchanged.

### 5c. The recommended shape: `practicePoints` (INFERRED, built from VERIFIED precedents)

| | Value |
|---|---|
| New field | `practicePoints` (int, monotonic-optional), `practicePeak`, reuse `botRankToday`/`botRankDate` verbatim |
| Math | **`computeMatchRank` unchanged** — same bands, same `BOT_RATE 0.4`, same `botCeiling(L)=60+80L`, same `BOT_DAILY_CAP 150` |
| Written when | `isBotMatch === true` (i.e. `humanOpponents === 0`) |
| `rankPoints` when bots | **0 delta, always** — ask #6 satisfied literally |
| Shown as | a small secondary meter, PvE-framed copy, **never** the דרגה badge, **never** on the leaderboard |
| Hebrew | **אימון** / *"דירוג אימון"* — deliberately not דרגה. `RANK_HE`/`TROPHIES_HE` in `shared/rank.js` get a third sibling `PRACTICE_HE`. |
| Ceiling nudge | keeps working, and is now **true**: at `practicePoints ≥ botCeiling(L)` → *"העלה את רמת הקושי"* |
| Farm risk | **zero** — the field has no ladder placement, so there is nothing to farm toward |
| Tests | the bot-ceiling / daily-cap / JOURNEY blocks move to `practicePoints` and keep asserting the same integers |

**Where the solo player's progression actually comes from, after #6:**
1. **Trophies** (`xp`) — 110 bot matches to L12, plus my §3 roster spread and the §6(e) difficulty bonus. This is the main answer.
2. **`practicePoints`** — a real, ceiling-gated number that moves, framed as PvE.
3. **Bot difficulty ladder** — `botLevelFromXp` still climbs with trophies; the difficulty picker is still a visible achievement.
4. **`rankPoints`** — 0 until they meet a human. Accept it, and be explicit in the UI: the badge should
   read *"שחק מול שחקן אמיתי כדי לפתוח דרגה"*, i.e. **locked, not broken**. A locked state a player
   understands is survivable; a stuck number they don't understand is not.

**Alternative if the user rejects a second field: bots pay rank only below a low floor.**
Set `RANK_BOT_FLOOR = 200` (silver entry). Bots pay the normal 40% up to 200, then 0 forever; ceiling and
daily cap keep working below it. **17 bot wins** gets a solo player to 200 (bronze band 30 × 0.4 = 12/win),
≈ 2 sessions given the 150/day cap. This is the closest match to what Brawl Stars actually ships
(bot-filled lobbies pay full trophies **only below ~100 trophies**, VERIFIED) and it is one constant, not a
new field. Its weakness: after 17 wins the solo player is back at zero progression, so it buys ~2 days.
`RANK_BOT_FLOOR = 500` (gold, **44 bot wins**) buys ~a week. My order of preference: `practicePoints`
> `RANK_BOT_FLOOR = 200` > naive zero.

---

## 6. Ask #4/#5(e) — bot DIFFICULTY as a separate axis

**Yes, beating an L11 bot should pay more trophies than an L2 bot. No, not via the rate.**

| Option | Verdict |
|---|---|
| Scale the trophy **rate** by difficulty (e.g. `m × (0.85 + 0.025·L)`) | **Reject.** It also shrinks the *loss* and *draw* payout at low L, so it takes trophies away from exactly the new/young players who chose אימון. It also multiplies with the 6-row roster table into a 72-cell matrix nobody can reason about or explain in Hebrew copy. |
| **Additive, win-only bonus** | **Recommend.** `botDiffBonus = 4 × max(0, botLevel − 5)` — L5 +0 · L8 **+12** · L10 **+20** · L11 **+24**. Pure upside (ask #1 safe), legible as one line on the post-match screen (`+24 גביעים · קטלני`), independent of the roster table. |

Effect: an all-bot L11 win goes from 60 to **84 xp/match**, i.e. **110 → 79 matches to L12** — it makes the
hardest solo setting worth ~40% more without touching the floor. `DEFAULT_LEVEL = 5` is the correct
zero-point because it is the ladder's stated "normal".

**⚠️ Exploit that must be closed with it.** `client.js` L2221: the *play-with-bots* entry sends the raw
manual `diffLevel`, **not** `xpDiffLevel()`. Only `quickMatch` (L2033/L2210) and `goalBrawl` (L2039) are
XP-clamped. So an L1 player can select **קטלני** today, and trophies are monotonic, so losing costs
nothing — an unguarded difficulty bonus is a free +24/match farm.
Fix (server-side, INFERRED): `effLevel = min(botLevel, botLevelFromXp(xp) + 2)` before computing the bonus.
The `+2` headroom lets a genuinely strong player be rewarded for punching above their level; the cap makes
the L1→L11 jump worthless. `botLevelFromXp` already exists in `shared/difficulty.js` and its formula is
already duplicated in `football-xp.js` (`levelFromXp`), so this is arithmetic the server can do with no
new input.

**Should bot difficulty also feed `xpFactor` / the roster factor?** No. `TASK-xp-human-ratio.md`'s original
boundary is right and `04-economy-bots-math.md` §"bot difficulty" agrees: the roster factor answers *"how
human was this match"*, the difficulty bonus answers *"how hard was the AI"*. Two questions, two terms.

---

## 7. Risks, worst first

1. **Ask #6 leaves the solo player with a permanently locked badge.** Our queue is empty by default —
   hundreds of Hebrew-speaking users, so 00:30 with nobody online is the *normal* case. A דרגה badge that
   never moves for the majority of players is a worse hub element than the XP bar it replaced. Mitigations,
   in order: `practicePoints`, `RANK_BOT_FLOOR = 200`, explicit "locked" copy. Do not ship #6 with the
   current tooltip strings.
2. **`test-rank-parity.mjs` fails the build the moment the server and `shared/rank.js` disagree on
   `botCeiling`.** Any #6 implementation that deletes server-side `botCeiling` must land in the same commit
   as the game-side deletion, or CI is red for whoever pushes second. Multiple agents are in this repo.
3. **Farm gate #2 becomes a punishment for practising** (§5a). 112 human wins + 200 bot wins = capped at
   diamond, even though the bot wins contributed zero rank. This will read as a bug to the one player who
   hits it.
4. **`seedRankFromXp` is now inconsistent with the rule.** Live accounts already hold rank that bot xp
   paid for. Re-seeding or clawing back is a *decrease* — forbidden by ask #1's spirit and by
   `00-DECISION.md` §6. Accept the grandfathered inconsistency and write it down.
5. **The difficulty bonus is farmable via `botGame`** until `effLevel` is capped (§6). This is the one
   number in this doc that can be exploited on day one.
6. **The seat distinction needs a TestFlight build.** Everything else in §3/§4/§6 is server-only. If the
   app build slips, ship the §3 fallback grade (server-derivable from `xpFactor`) so the 3-bot/2-bot
   collision is fixed regardless.
7. **`m = 0.90` for shape D (bot teammate vs 2 humans) rewards a worse roster.** Deliberately kept below
   F's 1.00 so it can't be gamed by queueing solo, but if anyone finds an in-game way to *force* a bot
   partner in a human lobby, re-price D to 0.80 = E.
8. **Six roster values is more copy than the hub currently has room for.** The post-match screen must
   explain *why* two matches paid differently or it reads as random. One line, Hebrew, naming the shape.

---

## 8. Sources — VERIFIED vs INFERRED

**VERIFIED — a shipped game does this**
- **Brawl Stars**: bot-filled lobbies below ~100 trophies pay **full trophies**, same field as a human win; still true in 2026 (community-documented; Supercell does not publish the cutoff). Ranked/Power League never contains bots. → the "bots pay the ladder only in an onboarding band" pattern. [Trophies — Brawl Stars Wiki](https://brawlstars.fandom.com/wiki/Trophies) · [speedrun.com forum, 2026: "push brawlers up to 100 trophies … the rest will only be bot games"](https://www.speedrun.com/brawl_stars/forums/yye6t) · [Oct-2024 trophy overhaul](https://www.sportskeeda.com/mobile-games/brawl-stars-october-2024-update-trophy-system-overhauled-new-trophy-box)
- **Rocket League**: Casual has a **real MMR that is never displayed** and does not touch Competitive rank; all casual playlists share one hidden pool. AI in Competitive is treated as a bug, not policy. → the direct precedent for `practicePoints`. [Casual — Rocket League Wiki](https://rocketleague.fandom.com/wiki/Casual) · [MMR guide 2026](https://electronmagazine.com/mmr-in-rocket-league-the-complete-2026-guide-to-understanding-and-improving-your-rank/)
- **EA SPORTS FC Ultimate Team — Squad Battles**: a full **PvE ladder vs AI squads** with its own Battle
  Points, its own leaderboard/ranks, its own weekly reward drop (Sunday) — **separate from Division
  Rivals** (Thursday), whose Division/star ladder is the skill track. Matches beyond the weekly
  competitive allowance don't affect the ranking. → PvE gets a real ladder, just not *the* ladder.
  [EA Help — Squad Battles](https://help.ea.com/en/articles/ea-sports-fc/squad-battles/) · [EA Help — Rivals](https://help.ea.com/en/articles/ea-sports-fc/ultimate-team-rivals/) · [Squad Battles rewards breakdown](https://timesaver.gg/blog/ea-fc-26-squad-battles-rewards) · [reward timings, Rivals Thu / SB Sun](https://gamerant.com/ea-fc-26-ultimate-team-rivals-champs-squad-battles-rewards-release-times/)
- **EA FC Mobile Division Rivals**: ±1 star per win/loss, 0 on a draw, floored at Professional V on the
  seasonal pull-back. (Already in `02-other-games.md`; cited here for the "PvP ladder has its own
  currency" half.) [Division Rivals — FC Mobile Wiki](https://easportsfcmobile.fandom.com/wiki/Division_rivals)
- **Fortnite**: bots ship in casual BR and scale inversely with skill ("better skill means fewer bots"),
  Epic does **not** publish counts; Epic has actively **banned bot-lobby exploitation in Ranked**, i.e.
  bots are treated as a casual-only tool and Ranked integrity is defended. What Fortnite pays for bot
  kills is **XP / Battle Pass**, never a skill rating — so it is *not* evidence for paying rank from bots.
  [Bot lobbies guide, updated 2026-07-14](https://alviran.net/blog/fortnite-bots-bot-lobbies-guide-2026/) · [Epic bans bot lobbies in Ranked](https://vpesports.com/fortnite-eliminates-bot-lobbies-from-ranked-play)
- **CoD Mobile**: AI bots appear for **new / low-rank** accounts and thin out as rank rises; ranked starts
  everyone at Rookie I. Note the caveat from `04-economy-bots-math.md`: in the CoD franchise "bot lobby"
  usually means *weak humans via SBMM*, not literal AI — the opacity is the cautionary tale here, not the
  mechanic. [Bots in COD Mobile](https://sportskeeda.com/esports/bots-cod-mobile-all-need-know) · [CoDM rank guide](https://www.sportskeeda.com/call-of-duty-game/call-duty-mobile-rank-guide-rank-division-point-breakdown-rewards-explained)
- **chess.com**: games against bot personalities or the engine are **always unrated** — the rating never
  moves — while the bots themselves carry fixed, hand-set ratings that never change. → the cleanest
  statement of "a fixed-skill AI can be a *benchmark* without being a *rating input*". [chess.com Help — playing bots](https://support.chess.com/en/articles/8614091-how-can-i-play-against-the-chess-com-bots) · [why my rating didn't change](https://support.chess.com/en/articles/8614310-the-game-ended-and-my-rating-didn-t-change-at-all-why)

**VERIFIED in our own code** (read this session, file+line cited inline): the six roster shapes and that
`humanOpponents`/`humanCount`/`totalPlayers` are already computed and sent (`client.js` L525-552) but
dropped by the app (`saltizFootball.js` L32/L35, `football.jsx` L277-291) · `isBotMatch = !vsHuman =
humanOpponents === 0` (`user.js` L1296) · farm gate #1 is unreachable under human-only rank (34 > 25
human wins to platinum) · `botGame` sends the un-clamped manual `diffLevel` (`client.js` L2221) · every
assertion named in §5b · matches-to-L12 arithmetic reproduced against the `football-xp.js` L17-21 comment
(0.20 → 275, 0.50 → 110 — exact match, so the model is the same one).

**INFERRED — my proposal, no game ships exactly this**: the `practicePoints` field and its Hebrew framing ·
the `m = 0.50 + 0.50(0.8·oppFrac + 0.2·mateFrac)` formula and all six values · the +0.20-per-human-opponent
/ +0.10-per-human-teammate weighting · `botDiffBonus = 4 × max(0, L−5)` capped +24 · the
`effLevel = min(botLevel, botLevelFromXp+2)` guard · `RANK_BOT_FLOOR = 200` · deleting farm gate #2 ·
treating "played" as renamed copy rather than a fourth term.
