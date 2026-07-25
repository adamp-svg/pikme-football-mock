# 09 — Economy math of an up-only track with four distinct payouts

> **Seat:** the monotonic (גביעים / `xp`) track. Asks **#1** (up-only) and **#2** (win/lose/tie/played).
> Date 2026-07-26. Read `00-DECISION.md` §8 first for the terminology swap.
> Scope note: I answer all 7 asks, but only #1/#2 are my seat's decision. #3–#7 are my seat's *constraint*
> on the other seats — I say what each costs the trophy curve, in numbers.

---

## CONCLUSION (read only this if you read nothing else)

1. **Ask #2 is free.** The four-number shape the user wants is a pure **re-decomposition** of the numbers
   already shipped. `played 20 + win 80 / draw 30 / loss 10 + 10/goal` sums to **100 / 50 / 30** — byte-identical
   totals to `computeMatchXp` today. Ship the additive shape, change **zero** economy. It only changes the UI
   from one line to four lines. **Recommend: ADDITIVE, played = 20.**
2. **Ask #1 is already true of the number — and already BROKEN for the badge.** `xp` and `levelFromXp` are
   monotone. But `tierFromStats`'s champion gate (`winsVsHuman < winsVsBot`) **can demote a player**: a
   champion at wh=100/wb=100 who wins two bot matches drops to diamond. That violates rule #1 today.
   **Fix: a sticky `xpTierFloor`, exactly like the shipped `rankFloor`.** One field, one `Math.max`.
3. **Inflating "played" is the one way to break the economy, and the break-even is 66.** Fast-losing becomes
   the best trophies/minute play once `played ≥ 66`. At 20 there is a **1.9× margin**; at 40 it falls to 1.3×.
   **Hard ceiling: played ≤ 30. Do not go past it.**
4. **Throwing, AFK and instant-quit are all already dominated — verified in code, not assumed.**
   Own goals are physically impossible (`shared/sim.js:410-421` makes the goal line a solid wall for the
   non-attacking team), the client only posts a result on `phase === 'ended'` (`public/client.js:6026`), bot
   difficulty is *forced* by XP with no manual override in quick/brawl, and a 0-0 stall gets *extended* by the
   45s golden goal. The optimal strategy is **winning fast**, which is what you want.
5. **The one live leak is the per-goal term in goal-brawl.** `goalsToWin = 0` is timed — no early end, no goal
   cap — and the server clamps `goalsFor` at **100**, so one bot match can pay **+1000 trophies**. 40 goals =
   42.9 tr/min vs 23.6 for an honest full-clock win. **Fix: `10 × min(goalsFor, 5)`.** Costs an honest player
   nothing (normal 2v2 is first-to-3).
6. **The real hazard is not farming, it is the interlock.** `botLevelFromXp` puts a brand-new player against
   `T.normal` enemies (bot L5) after **~26 minutes of play**, and quick-match/goal-brawl give **no manual
   difficulty override**. A teen outruns their own skill inside one session. This is live today, my proposal
   does not cause it, and **it is the most serious thing in this doc.**
   **Fix: `effectiveBotLevel = min(botLevelFromXp(xp), botLevelBeaten + 1)`** where `botLevelBeaten` = highest
   difficulty with ≥2 wins. Same mechanism serves the farm defense *and* the skill protection.
7. **Daily soft cap: yes, but not as an anti-farm measure.** Up-only + volume medal doesn't need one. It is a
   **bot-difficulty rate limiter** and a fairness floor vs the 4-hour/day outlier.
   **Full rate to 1,200/day · ×0.5 to 2,400 · ×0.25 beyond · hard stop 3,600.** 1,200 ≈ 40 min of bot play or
   30 min of human play — **invisible to a normal session**, cuts a 4h/day grinder 7,400 → 2,100.

---

## 1. THE SEVEN ASKS

### #1 — "Trophies can only go up." → **CONFIRMED for the number, BROKEN for the badge. One fix.**

- `xp` is monotone: every term in `computeMatchXp` is non-negative and `levelFromXp` is monotone increasing.
- Nothing in my proposal introduces a decrease. Every new term is additive and ≥ 0.
- **But `tierFromStats` can regress.** The champion gate is `raw >= 5 && winsVsHuman < winsVsBot → cap diamond`.
  `winsVsBot` only grows, so this gate can **re-engage after it released**:

  | state | wh | wb | shown tier at 40,000 xp |
  |---|---|---|---|
  | before | 100 | 99 | **champion** |
  | +1 bot win | 100 | 100 | champion (`100 < 100` false) |
  | +2 bot wins | 100 | 101 | **diamond ← DEMOTED** |

  (The platinum gate `wh < 25` is safe — `winsVsHuman` only grows.)
- **Fix (inferred, mirrors shipped code):** store `xpTierFloor` (monotone index), and
  `visibleTier = TIERS[max(xpTierFloor, gatedIdx)]`. This is *literally* the `rankFloor` pattern already
  live in `applyRankDelta`. Cost: one schema field, ~4 lines.
- **Three invariants to assert in the test suite** (they are cheap and they permanently close ask #1):
  1. `computeMatchXp(...) >= 0` for every input.
  2. the record-match route never writes `xp < doc.xp`.
  3. `xpTierFloor` after ≥ `xpTierFloor` before.
- **Watch out:** if the daily soft cap (§4) is implemented as a *post-hoc adjustment of the stored total* it
  breaks #1. It must clamp **the delta** to `[0, remaining]` and never touch the stored number.

### #2 — Four distinct payouts for WIN / LOSE / TIE / PLAYED → **ADDITIVE, played = 20.**

Full working in §2. Recommended numbers:

| term | value | pays on |
|---|---|---|
| **שיחקת** played | **+20** | every *completed* match (`phase === 'ended'`), any result |
| **ניצחת** win | **+80** | on top of played |
| **תיקו** draw | **+30** | on top of played |
| **הפסדת** loss | **+10** | on top of played |
| **גולים** goals | **+10 × min(goalsFor, 5)** | capped — see #f |
| **ניצחון ראשון היום** | **+200** | once/day, any win |

→ win 100 · draw 50 · loss 30 **before** the roster factor. **Identical to shipped.**

### #3 — Different trophies per NUMBER of bots → **the signal exists but the 0.5 floor destroys half of it.**

Verified: `public/client.js:534` grades `xpFactor = 0.2 + 0.8·(otherHumans/otherSlots)` → **0.20 / 0.47 / 0.73 / 1.00**
in 2v2. Then `computeMatchXp` clamps to `[0.5, 1.0]`, so **0.20 and 0.47 both become 0.50** — a 3-bot and a
2-bot match pay **exactly the same trophies today.** Ask #3 is currently unsatisfied.

**Recommendation (inferred): replace the linear factor with an explicit 4-row table on the trophy track.**

| roster (2v2, my 3 other slots) | xpFactor today | **paid rate today** | **proposed rate** | win 3g today → proposed |
|---|---|---|---|---|
| 3 bots (solo) | 0.20 | 0.50 | **0.50** | 65 → **65** (no change) |
| 2 bots + 1 human | 0.47 | 0.50 | **0.65** | 65 → **84** |
| 1 bot + 2 humans | 0.73 | 0.73 | **0.80** | 95 → **104** |
| 3 humans | 1.00 | 1.00 | **1.00** | 130 → **130** |

- Monotone, visibly spaced (15pt steps a player can feel), **and nothing goes down for anybody** — so it is
  compatible with ask #1 even at the design level.
- Cost to the curve: **2-bot matches +21%/match, 1-bot +7%, solo and all-human unchanged.** Mixed rosters are
  our rarest case (needs 1–2 friends online), so the aggregate curve moves <5%. It also correctly rewards the
  growth loop (bring a friend), which the flat 0.5 clamp currently taxes.
- **Flagged, not solved:** `xpFactor` counts humans anywhere in the lobby — it cannot tell "the human is my
  teammate" from "the human is my opponent". For the TROPHY track that is fine (volume medal, any human raises
  the quality of the match). For **rank** it is wrong and the rank seat must not reuse this field.

### #4 — Should bots pay LESS? → **Yes, they already do: exactly 2×. But the real ratio is 1.48×, not 2×.**

- Raw: bot win 65 vs human win 130 = **0.50**. Correct and I would not change it.
- **But `+200` first-win-of-day is roster-blind** (changed deliberately in §8 so it fires for the majority path).
  Amortised over a 10-match day it is +20/match, which is **28% of a bot match's total value** and only 19% of a
  human match's. Effective ratio: **71.9 / 106.5 = 0.68**, i.e. a bot day pays 68% of a human day, not 50%.
- **Decision: keep it roster-blind.** The come-back-tomorrow hook must fire for the majority path or it barely
  fires at all. But **state the 0.68 honestly** — don't tell the user bots pay half when they pay two thirds.
- If the user *wants* the visible 0.50: make it **+120 on a bot first win / +200 on a human first win** →
  effective ratio 0.62. That is the only lever here worth touching.

### #5 — Trophies for a higher-RANK / higher-TROPHY opponent, per result → **NO, with one capped exception.**

- **Loss / draw / played vs a stronger opponent: +0.** Paying more for *losing* to strong players on an up-only
  track makes "queue into the best players and lose" a legitimate farm with no downside. Refuse.
- **Win: one flat, capped underdog bonus.** `+25 trophies` for beating a **human** whose `rankTier` is ≥1 above
  yours, **max 3/day (+75/day)**. That is one extra match's worth per day — a garnish, not an economy. It stays
  up-only, it cannot be farmed (tier gap requires a real human above you, and the cap binds), and it is legible
  in Hebrew: `+25 ניצחת שחקן בדרגה גבוהה`.
- **Why no general scaling:** it duplicates rank's entire job, and it makes the trophy number unexplainable —
  two players with the same match history end up with different totals for reasons neither can see. Trophies
  must stay a number you can predict before you press play.

### #6 — RANK only between humans → **doesn't hurt trophies, but it makes §4's cap MORE necessary, and the solo dead wall already has a free fix.**

Not my seat's decision. My seat's constraints, in numbers:

- If bot matches pay **0 rank**, `BOT_RATE = 0.4`, `BOT_DAILY_CAP = 150` and most of `botCeiling` become dead
  code, and **the interlock is severed** — "trophy level raises your rank ceiling" was the single best
  justification for the fast `botLevelFromXp` ramp (§6). Losing it means the ramp is pure hazard.
- Then trophies become the **only** progression a solo player has → the volume-medal hazard (§4) gets worse and
  the daily soft cap goes from optional to required.
- **The dead wall already has a free fix and nobody has noticed it:** the trophy track has its *own* 7-tier
  badge (`tierFromStats`, `XP_TIER_MIN`), and it is **already farm-gated at GOLD** for a bot-only account
  (`raw >= 3 && winsVsHuman < 25 → cap gold`). So a solo player *already* has a real ladder: **bronze → gold on
  the trophy tier**, earned entirely against bots, capped so it can never impersonate a human ladder.
  → **Rank can go 100% human-only with no dead wall, at zero implementation cost.** Surface the trophy tier
  badge next to the trophy count and the solo player has somewhere to climb.
- If the user prefers to keep *some* bot rank instead: `BOT_RATE = 0.15`, `BOT_DAILY_CAP = 60`, `botCeiling`
  unchanged → a solo player can reach **silver (200)** but not gold. 5 of the 7 tiers stay human-only, which is
  "rank is between humans" in spirit without a wall.

### #7 — Rank XP input: opponent rank, opponent trophies, or both? → **RANK POINTS only. Never both. Never trophies.**

- **Never both.** They are correlated *by construction* — `seedRankFromXp` literally maps the trophy standing
  onto the rank ladder. Feeding both in double-counts the same signal.
- **Never trophies.** Trophies measure *time played*. A 200-hour player with a 40% win rate would be treated as
  a strong opponent. That is the exact failure the two-track split exists to prevent.
- **Rank POINTS, not rank TIER.** Tier is a 7-bucket step function: a 199-point and a 200-point opponent would
  pay differently for a 1-point difference. Use the continuous number:
  `mult = clamp(1 + (opponentRank − myRank) / 400, 0.60, 1.50)`
  → ±400 points = 1.50× / 0.60×. Bounded above so it cannot be farmed, bounded below so a match against a
  weaker player never pays zero. **Applies to rank only. Trophies take no opponent-strength input** beyond the
  capped +25 in #5.

---

## 2. (a) THE SHAPE — additive vs floor, with real numbers

**Formulation A — ADDITIVE** *(recommended)*: `played + result bonus + goals`, then × roster rate.

| result | played | bonus | goals (3) | total | × 0.50 (solo) | × 1.00 (all human) |
|---|---|---|---|---|---|---|
| win | 20 | +80 | +30 | **130** | 65 | 130 |
| draw | 20 | +30 | +20 | **70** | 35 | 70 |
| loss | 20 | +10 | +10 | **40** | 20 | 40 |
| loss, 0 goals | 20 | +10 | 0 | **30** | 15 | 30 |

**Formulation B — FLOOR (rename)**: keep `base = 100/50/30` and declare "played" to *be* the loss base of 30.

| result | what the UI can show |
|---|---|
| win | `+130 גביעים` — cannot decompose without inventing the split, i.e. without becoming Formulation A |
| loss | `+30 שיחקת` |

**Verdict: A, and it is not close.**
- **A costs nothing.** `20 + 80 = 100`, `20 + 30 = 50`, `20 + 10 = 30`. Same numbers, same curve, same
  everything. It is a *presentation* change with a `+0` economy delta. Confirmed by model: propA and current
  produce identical per-match values for all four archetypes (§3 table).
- **A is the only one that satisfies the literal ask.** The user asked for four numbers. B has three.
- **A's UI is genuinely better for a losing screen**, which is the whole reason the monotonic track exists:
  `+20 שיחקת` `+10 הפסדת` `+10 גול` reads as three earned things instead of one consolation number.
- **A's risk is inflation pressure**, and it is real — "played is only 20, let's make it 50" is a very easy
  next conversation. §5 gives the arithmetic that makes 20 defensible and 66 fatal. Write the ceiling into
  the code comment.
- **A must pay only on a COMPLETED match.** `played` on an abandoned match is the one genuinely new exploit
  the additive shape creates. Today the client only posts on `phase === 'ended'`, so this is currently safe by
  accident — make it safe on purpose (§5).

---

## 3. (b) THE CURVE — matches to each milestone

**Model assumptions** (stated so they can be argued with): W/L/D = 70/27/3 vs bots, 55/40/5 mixed, 50/45/5
all-human. Goals: 3 on a win (first-to-3 ends the match), 1 on a loss, 2 on a draw. 10 matches/day, so the
`+200` daily bonus amortises to +20/match. `MATCH_DURATION = 120`, `GOALS_TO_WIN = 3`, `OVERTIME_DURATION = 45`.

### 3.1 Per-match expected trophies

| archetype | xpFactor | **current (shipped)** | **propA (played 20)** | propB (played 40) |
|---|---|---|---|---|
| bot-only solo (3 bots) | 0.20→0.50 | **71.9** | **71.9** | 82.0 |
| mixed, 2 bots + 1 human | 0.47→0.50 | **65.5** | **65.5** | 75.5 |
| mixed, 1 bot + 2 humans | 0.73 | **86.4** | **86.4** | 101.0 |
| all-human | 1.00 | **106.5** | **106.5** | 126.5 |

**propA == current, exactly, everywhere.** That is the headline of this seat.
propB (played 40) inflates 14–19% and eats most of the anti-throw margin (§5) — rejected.

### 3.2 Matches to each trophy TIER (`XP_TIER_MIN`)

| tier | xp | bot-only | mixed (1 bot) | all-human |
|---|---|---|---|---|
| silver | 1,000 | 14 | 12 | 10 |
| gold | 4,000 | 56 | 47 | 38 |
| platinum | 10,000 | 140 | 116 | 94 |
| diamond | 20,000 | 279 | 232 | 188 |
| champion | 40,000 | 557 | 463 | 376 |
| legend | 80,000 | **1,113** | 926 | 752 |

Identical under current and propA. (propB would cut legend to 976 / 793 / 633.)

Reminder: bot-only accounts are **hard-capped at GOLD** on this badge by the shipped farm gate, so rows below
gold in the bot column are number-only, not badge.

### 3.3 Days to each tier at 10 matches/day

| tier | bot-only | mixed | all-human |
|---|---|---|---|
| silver | 1 | 1 | 1 |
| gold | 6 | 5 | 4 |
| platinum | 14 | 12 | 9 |
| diamond | 28 | 23 | 19 |
| champion | 56 | 46 | 38 |
| legend | **111** | 93 | 75 |

### 3.4 Matches to each forced BOT LEVEL (`botLevelFromXp`) — bot-only path

| bot L | player lvl | xp needed | bot matches | minutes of play (at the real decaying rate) |
|---|---|---|---|---|
| 0 | 1 | 0 | 0 | 0 |
| 1 | 2 | 100 | **2** | **2** |
| 2 | 3 | 300 | 5 | 4 |
| 3 | 4 | 600 | 9 | 8 |
| 4 | 5 | 1,000 | 14 | 12 |
| **5 (T.normal enemy)** | 6 | 1,500 | **21** | **19** |
| 6 | 7 | 2,100 | 30 | 26 |
| 7 | 8 | 2,800 | 39 | — |
| 8 | 9 | 3,600 | 51 | — |
| 9 | 10 | 4,500 | 63 | — |
| 10 | 11 | 5,500 | 77 | — |
| **11 (T.extreme)** | 12 | 6,600 | **92** | — |

**Read the top of this table, not the bottom.** The triangular level curve (`50·L·(L−1)`) is *fastest at the
bottom*: the first five bot difficulty levels are crossed in **1,000 xp ≈ 14 matches ≈ 12 minutes**. See §6.

### 3.5 Am I speeding up or slowing down progression?

**Neither. propA is exactly neutral.** The only curve changes I propose are:
- **#3's roster table:** 2-bot mixed **+21%**, 1-bot mixed **+7%**, solo **0%**, all-human **0%**.
- **#f's goal cap (min 5):** **0%** in normal 2v2 (first-to-3 caps goals at 3). Only clips goal-brawl.
- **§4's daily cap:** **0%** below 1,200/day. Only binds above ~40 min/day of play.
- **§6's `botLevelBeaten` gate:** **0%** on trophies. Changes only *who you play*.

Net effect on a typical player: **under +5%.**

---

## 4. (c) THE MONOTONIC HAZARD — and what stops the number being meaningless

**Say it out loud, in the UI:** גביעים are a **volume medal**. The label under the number should be honest —
"how much you've played", not "how good you are". דרגה is the skill claim. If both numbers claim skill, the
losable one loses (players optimise the one that can't hurt them).

**Quantified: how much time does the top of the ladder cost?** (continuous bot play, at the realistic rate that
*decays* as forced bot difficulty rises: 83 tr/min at L0 → 23 at L11)

| tier | xp | hours of continuous bot play |
|---|---|---|
| silver | 1,000 | 0.3 |
| gold | 4,000 | 1.8 |
| platinum | 10,000 | 6.0 |
| diamond | 20,000 | 13.3 |
| champion | 40,000 | 27.8 |
| **legend** | 80,000 | **56.8** |

57 hours is a real wall — but it is a *time* wall, so it will eventually be crossed by whoever plays most.
Three things already stop the number being meaningless, and one is missing:

1. **✅ SHIPPED — the badge is gated even though the number isn't.** `tierFromStats` caps a bot-only account at
   **GOLD** (needs 25 human wins for platinum) and at **DIAMOND** without `winsVsHuman ≥ winsVsBot`. So the
   57-hour bot grinder ends up with a huge number and a **gold** badge. *This is the single most important
   defense and it already works.* Protect it (and give it a sticky floor — §1).
2. **✅ SHIPPED — the rate self-decays.** Forced bot difficulty rises with trophies, so tr/min falls 83 → 23
   along the ladder. A monotonic track with a *decaying* rate is a soft cap in disguise.
3. **✅ SHIPPED — there is a second, losable number next to it.** דרגה carries the skill claim, so trophies do
   not have to.
4. **❌ MISSING — a daily soft cap.** Recommended, but *not* as anti-farm:

### The daily soft cap — a bot-difficulty rate limiter, not an anti-farm rule

| trophies earned today | rate |
|---|---|
| 0 – 1,200 | **×1.00** |
| 1,200 – 2,400 | **×0.50** |
| 2,400 + | **×0.25** |
| hard stop | **3,600/day** |

| play time/day | uncapped | after cap |
|---|---|---|
| 20 min | 800–1,000 | **unchanged** |
| 40 min | 1,400–1,800 | 1,400 → 1,300ish |
| 60 min | 2,000–2,600 | ~1,600 |
| 120 min | 3,800–5,000 | ~1,900 |
| 240 min | 7,400–9,800 | **2,100 (−72%)** |

- **1,200 ≈ 40 min of bot play or 30 min of human play** — a normal teen session never sees the cap.
- Its real job: it halves the speed at which a grinder's *bot difficulty* climbs (§6), and it compresses the
  outlier from 7× a normal player to 2×.
- **The alternative shape** (per-match, easier UI): matches 1–10 ×1.0, 11–20 ×0.5, 21+ ×0.25 →
  marginal trophies for match #11 / #21 / #41 = **43 / 21 / 22** (human) or **26 / 12 / 13** (bot). Same effect,
  but the trophy-total form is better because it doesn't punish a player whose matches are short.
- **Hebrew copy for the reduced state:** `שיחקת הרבה היום — הגביעים מצטברים לאט יותר` + a small `×½` chip.
  It must never say "you got nothing", and it must never show a negative delta.

**The argument for doing NOTHING instead** (worth stating, because it is not stupid): at a few hundred players
there are no leaderboard-integrity stakes; the badge gate already handles honesty; and a cap is the mechanic
players most reliably resent (Fortnite's Creative diminishing returns are its most-complained-about
progression rule). If the user wants the simplest possible track: **ship propA with no cap, and add the cap
the first time someone posts a screenshot of an absurd number.** That is a defensible call.

**Real-game evidence — and the most important one has been discontinued:**
- **VERIFIED — Brawl Stars Mastery had a 6,000 points/day cap** (scaled during Mastery Madness events), and
  **Masteries were REMOVED on 2025-06-24**, replaced by an extended Trophy Road (to 100k trophies) plus
  "Records", an achievement system. Supercell's stated reason: it became *"a niche feature where only a few
  very active players engage"* — **only 11.8% of players ever earned a Brawler Title in 2+ years.**
  → **This is a correction to `00-DECISION.md`, which cites Mastery as the monotonic-track precedent.** The
  lesson is not "cap the volume medal", it is **"a hidden volume medal is ignored"** — which is a strong
  argument for the four-line post-match breakdown (#2) and against burying it in a thin secondary bar.
- **VERIFIED — CoD Mobile** gives bonus XP on the **first 3 matches of each day**, resetting on a 24h timer.
  That is the same shape as our `+200` first-win-of-day, only spread over three matches instead of one.
  → If the user wants a stronger daily hook: **+120 / +80 / +40 on the first three wins of the day (total +240)**
  instead of one +200 spike. Three hits beat one, and it is a smaller per-event number so it distorts less.
- **VERIFIED — Fortnite** runs **per-mode daily XP caps** (Chapter 6: LEGO 570k, Reload 600k, Festival 100k,
  Creative 60k, Battle Royale playtime 0) and **diminishing returns in Creative that reset weekly**, while
  quest XP is uncapped. → Precedent for "cap the grindable source, never cap the skill-expressing source":
  for us, cap the **bot** path and leave the **human** path uncapped.
- **PARTIALLY VERIFIED — Rocket League** awards XP "based primarily on match length" rather than score, per its
  own progression rework. I could not fetch the primary post (403) so treat the exact per-minute numbers as
  unverified — but the *shape* (time-in-match, not goals) is the strongest external support for a `played`
  term and against an uncapped per-goal term.
- **NOT VERIFIED — EA FC Mobile daily caps.** I could not find a citable number for a per-day objective or
  stamina cap in 2025–26 sources. **I am not going to invent one.** Treat the brief's reference to it as
  unconfirmed.

---

## 5. (d) FARM EXPLOITS SPECIFIC TO UP-ONLY + A "PLAYED" TERM

### 5.1 Trophies per MINUTE — the arithmetic the brief asked for

Wall clock = `live seconds + 5 × total goals` (GOAL_RESET is real time but is **not** billed to the 120s match
clock) `+ 20s` overhead (intro, celebration, hub round trip). Bot roster, f → 0.50.

| strategy | wall min | trophies | **tr/min** | verdict |
|---|---|---|---|---|
| **NORMAL 3-0 blowout vs L0-L2 bots** | 0.78 | 65 | **83.0** | ← the actual optimum |
| NORMAL 3-1 win vs L3-L5 bots | 1.67 | 65 | 39.0 | |
| NORMAL 3-2 win, full clock | 2.75 | 65 | 23.6 | |
| NORMAL 2-3 real loss | 2.25 | 25 | 11.1 | |
| **THROW: passive 0-3 vs hard bots** | 1.18 | 15 | **12.7** | **dominated 6.5× — not exploitable** |
| **AFK: 0-0 draw + golden goal** | 3.08 | 25 | **8.1** | **worst strategy in the game** |
| BRAWL 10 goals (timed) | 3.33 | 100 | 30.0 | |
| BRAWL 20 goals (timed) | 4.17 | 150 | 36.0 | |
| **BRAWL 40 goals (physical max)** | 5.83 | **250** | **42.9** | ← the one live leak |

**Answer to the brief's specific question: NO, a 30-second loss is not the optimal trophies/minute strategy.**
It pays 12.7/min against 23.6–83.0 for winning. Winning dominates at every point on the curve.

**Why throwing/AFK are structurally dead — four verified code facts, not assumptions:**

| defense | where | effect |
|---|---|---|
| **Own goals are impossible** | `shared/sim.js:410-421` — the goal line is a **solid wall** for the non-attacking team, explicitly commented | you cannot force a fast loss; you must wait for bots to score 3 |
| **Bot difficulty is forced, no override** | `client.js:2034, 2211, 3401` — quick-match and goal-brawl both use `xpDiffLevel()`; the manual slider is training/private/builder only | to lose fast you need HARD bots, which is the low-payout end |
| **A 0-0 stall gets EXTENDED** | `sim.js:600` — tied at 120s → 45s golden goal | AFK costs 3.08 min for 25 trophies |
| **No result is posted unless the match ENDS** | `client.js:6026` — `postMatchResult` only fires on `phase === 'ended'` | instant-quit farming of the `played` term pays **0** today |

### 5.2 The break-even played term — the number that bounds the whole design

Solve `(played + 10)/t_throw = (played + 80 + 30)/t_win`:

| compared against | duration ratio | **throwing wins once played ≥** |
|---|---|---|
| a fast 3-1 win (1.67 min) | 1.41× | **235** |
| a full-clock 3-2 win (2.75 min) | 2.32× | **66** |

| played | throw tr/min | full-clock win tr/min | margin |
|---|---|---|---|
| **20 (recommended)** | 12.7 | 23.6 | **1.86×** ✅ |
| 30 (ceiling) | 17.0 | 25.9 | 1.52× ✅ |
| 40 | 21.1 | 27.3 | 1.29× ⚠️ marginal |
| 66 | 32.2 | 32.2 | **1.00× ❌ break-even** |

→ **`played = 20`. Hard ceiling 30. Put the number 66 in the code comment** so the next person to "just bump
played a bit" sees where the wall is.

### 5.3 The one live leak: unbounded per-goal in goal-brawl

- `goalsToWin = 0` (`server.js:90`) = **timed** mode: it always runs the full 120s of live play and **cannot be
  ended early**. There is no goal cap in the mode and no goal cap in the payout.
- The server clamps `goalsFor` at **100** (`routes-pikme/user.js:1246`) → **one bot match can pay +1000 trophies.**
- Physical maximum with walk-in goals (`sim.js:828`) at 3s of live play per goal: **40 goals**, 250 trophies,
  **42.9 tr/min** — 1.8× an honest full-clock win.
- It is not the *global* optimum (the fast blowout is), but it **rewards stat-padding over winning**, which is
  precisely the Rocket League lesson already in `02-other-games.md`.
- **Fix: `+10 × min(goalsFor, 5)`.** Best achievable brawl rate drops 42.9 → 12.9 tr/min. Costs an honest player
  **nothing** in normal 2v2 (first-to-3 caps goals at 3). Cheapest high-value change in this doc.

### 5.4 The defenses, as concrete rules

| # | rule | number | why this number | cost to honest players |
|---|---|---|---|---|
| D1 | `played` pays only on a **completed** match | `phase === 'ended'` | already how the client behaves; make it a server check | 0 |
| D2 | **Minimum billed duration** for the `played` term | **`durationSec ≥ 45`** | a real 3-0 blowout runs ~45s of clock; a 0-3 throw vs hard bots runs ~36s; a 1-goal rush-and-quit runs ~5s. 45 blocks the last two, passes the first. **60 would block legitimate blowouts — do not use 60.** | ~0 |
| D3 | **Minimum engagement** | **`touches ≥ 3`** OR `possSeconds ≥ 5` | both fields are already reported and clamped (`user.js:1284`); an AFK player touches the ball 0-1 times | 0 |
| D4 | **Goal-term cap** | **`min(goalsFor, 5)`** | §5.3 | 0 in first-to-3 |
| D5 | **Per-opponent daily limit on the trophy track** | **6/day** (vs rank's `OPPONENT_DAILY_LIMIT = 3`) | rank pays 0 on the 3rd meeting; trophies are a volume medal so 3 is too tight for two friends who just want to play. 6 stops "rematch forever" while letting a real session happen. Beyond 6, pay **played only (20)** — never 0, so it stays up-only | ~0 |
| D6 | **Daily soft cap** | **1,200 / ×0.5 / ×0.25 / hard 3,600** | §4 | 0 below 40 min/day |
| D7 | **Forfeit/leaver** | pays **0** on the trophy track (no `played`) | already true by D1; state it so nobody "helpfully" adds an abandon payout | 0 |

**⚠️ `durationSec` is reported by the client and completely IGNORED by the server today.** `client.js:546` sends
it; nothing in `routes-pikme/user.js` reads it. D2 is a one-line read of a field that already arrives. (It is
client-asserted, so it is a farm speed-bump, not a security control — same trust level as `stats.goals`.)

---

## 6. (e) THE INTERLOCK — trophy rate → bot difficulty → can a player outrun their own skill?

**Yes, and it is the most serious problem in this doc. It is live today.**

`levelFromXp` is triangular (`cumulative = 50·L·(L−1)`), so **level-ups are fastest at the bottom** —
and `botLevelFromXp = clampLevel(playerLevel − 1)` maps every one of them straight onto bot difficulty:

| after… | trophies | forced bot level | enemy skill (`shared/difficulty.js`) |
|---|---|---|---|
| 2 matches | 100 | L1 | `veryEasy` 0.05 |
| 5 matches | 300 | L2 | `easy` 0.25 |
| 14 matches (~12 min) | 1,000 | L4 | `easy` 0.25 |
| **21 matches (~19 min)** | 1,500 | **L5** | **`normal` 0.50** |
| 30 matches (~26 min) | 2,100 | L6 | `normal` 0.50 |
| 92 matches | 6,600 | **L11** | **`extreme` 1.00** |

- **A brand-new player is facing `T.normal` enemies inside their first or second session** (~20 minutes).
- **And they cannot turn it down.** Verified: `quickMatch` (`client.js:2034, 2211`) and `goalBrawl`
  (`client.js:2040`) both send `xpDiffLevel()`; `client.js:3401` `const xpModes = msg.mode === 'quick'` confirms
  the manual `diffLevel` slider only applies to training / private / builder rooms. **There is no escape hatch
  in the two modes a solo player actually plays.**
- For a teen audience this is the classic churn shape: 20 good minutes, then a wall they didn't choose and
  can't lower, with no signal explaining why the game suddenly got hard.

**Effect of MY numbers on this curve: none.** propA is rate-neutral, so the ramp is unchanged. The #3 roster
table speeds it 7–21% *for mixed rosters only* (where the player has friends, i.e. the least dangerous case),
and the §4 daily cap **slows** it for grinders. Net: neutral-to-slightly-better. **But I am not fixing it, and
it needs fixing.**

### The fix — one rule, serves the farm defense AND the skill protection

```
effectiveBotLevel = min( botLevelFromXp(xp), botLevelBeaten + 1 )
```
where `botLevelBeaten` = the highest difficulty level at which the player has **≥ 2 wins** (new monotone stat
field, ~6 lines: one field, one `Math.max` on a win, one `min` at room creation).

| player | `botLevelFromXp` | `botLevelBeaten` | plays at | outcome |
|---|---|---|---|---|
| blowout farmer | 6 | 5 (2+ wins at every level) | **6** | farm defense fully intact — difficulty still chases them |
| struggling teen | 6 | 2 (never won at 3+) | **3** | stalls at their real skill, one level of stretch |
| returning player | 9 | 9 | 9 | unchanged |

**Why this is the right shape:** the two goals look opposed (fast ramp = anti-farm; slow ramp = don't outrun
skill) but they are the *same* rule seen from two sides — *difficulty should track demonstrated wins, not
elapsed trophies.* A farmer demonstrates wins, so they get promoted; a struggler doesn't, so they don't.

**Fallback if a new stat field is unacceptable:** remap `botLevelFromXp` to `clampLevel(round((playerLevel−1) × 0.8))`.

| bot L | xp under current `L−1` | xp under `×0.8` | xp under `×0.6` |
|---|---|---|---|
| 5 | 1,500 | 2,100 | 4,500 |
| 8 | 3,600 | 5,500 | 10,500 |
| 11 | 6,600 | **10,500** | 19,000 |

**⚠️ Interlock cost of the fallback:** `botCeiling(L) = 60 + 80·L`, so bot L11 (ceiling 940) is what lets a solo
player climb rank at all. `×0.8` pushes L11 from 92 to 147 bot matches; `×0.6` to 265. **`×0.6` strangles solo
rank progression — do not use it.** The `botLevelBeaten` gate has no such cost, because a player who is winning
gets promoted immediately. **That is why it is the recommendation.**

---

## 7. (f) GOALS — does per-goal survive the four-category scheme?

**TROPHY track: YES, keep +10/goal — but CAP it at 5.**
- Trophies are a volume/effort medal; goals *are* effort, and they are the thing the game is about. Removing
  the per-goal term would make a 3-0 win and a 3-2 win pay identically, which reads wrong.
- It also does real work in the four-line UI: `+20 שיחקת · +80 ניצחת · +30 גולים` gives the player three
  earned things to look at instead of one number.
- **But uncapped it is the only live leak in the economy** (§5.3) — `min(goalsFor, 5)` = +50 max. First-to-3
  caps a normal match at 3 anyway, so the cap is invisible to 95%+ of matches and only clips goal-brawl.
- **Rejected alternative:** a tapered term (10 for goals 1-3, 5 for 4-6, 0 beyond). Same effect as the flat cap
  but three numbers to explain instead of one. Not worth it.

**RANK track: NO per-goal, and it is already correct.** `computeMatchRank` pays the tier band only.
Rocket League's lesson (rating on team result, or players stat-pad) applies here and nowhere else, because rank
is the number that claims skill. Keep it clean. **The two tracks should differ on exactly this axis** — it is
the crispest possible expression of "trophies reward volume, rank rewards skill":

| | trophies | rank |
|---|---|---|
| per-goal | **+10, capped at 5** | **0** |
| played term | **+20** | 0 (participation is not skill) |
| opponent strength | **only a capped +25 underdog win bonus** | **the primary modifier** |
| streak | 0 (already removed) | +2/win, max +10 |
| can it drop | **never** | yes |

---

## 8. CONSOLIDATED NUMBERS TO SHIP

```
// trophy payout (additive; totals identical to today's 100/50/30)
TROPHY_PLAYED      = 20   // completed match only; durationSec>=45; touches>=3
TROPHY_WIN         = 80
TROPHY_DRAW        = 30
TROPHY_LOSS        = 10
TROPHY_PER_GOAL    = 10
TROPHY_GOAL_CAP    = 5    // <-- the one real fix. was unbounded (goalsFor clamped 100 => +1000/match)
TROPHY_FIRST_WIN   = 200  // once/day, any win, roster-blind (effective bot:human ratio => 0.68, not 0.50)
TROPHY_PLAYED_MAX  = 30   // HARD CEILING. throwing beats winning at played>=66. Do not exceed 30.

// roster rate by BOT COUNT (2v2) — replaces the clamp that collapsed 0.20 and 0.47 to 0.50
TROPHY_ROSTER_RATE = { 3: 0.50, 2: 0.65, 1: 0.80, 0: 1.00 }   // key = number of bots in my 3 other slots

// underdog win bonus (the ONLY opponent-strength term on this track)
TROPHY_UNDERDOG        = 25   // beating a HUMAN >=1 rankTier above me
TROPHY_UNDERDOG_CAP    = 3    // per day => +75/day max

// anti-farm
TROPHY_MIN_DURATION_SEC   = 45     // durationSec is already sent by the client and IGNORED by the server
TROPHY_MIN_TOUCHES        = 3      // stats.touches already reported and clamped
TROPHY_OPPONENT_DAY_LIMIT = 6      // beyond: pay `played` only (20), never 0
TROPHY_DAY_FULL           = 1200   // then x0.5
TROPHY_DAY_HALF           = 2400   // then x0.25
TROPHY_DAY_HARD           = 3600

// ask #1 — the monotonic guarantee
xpTierFloor  // NEW monotone field. tierFromStats' champion gate can currently DEMOTE. Mirror rankFloor.
```

**Ship order (all additive, all rate-neutral except where noted):**
1. `xpTierFloor` + the 3 monotonicity assertions — **closes ask #1 properly.** No economy change.
2. Additive decomposition + `TROPHY_GOAL_CAP = 5` — **closes ask #2.** No economy change except the brawl clip.
3. `TROPHY_ROSTER_RATE` table — **closes ask #3/#4.** +21%/+7% on mixed rosters only.
4. D2/D3 duration+touches gates — reads two fields that already arrive.
5. `botLevelBeaten` — **the churn fix.** Not a trophy change; needs a game-side room-creation change too.
6. Daily soft cap — last, and only if the user wants it. Defensible to skip at this playerbase.

---

## 9. RISKS, most serious first

1. **The forced difficulty ramp churns new teen players in ~20 minutes** and there is no manual override in
   quick-match or goal-brawl. This is live, my numbers don't cause it, and it will outweigh every payout tuning
   decision in this doc. Fix with `botLevelBeaten` before shipping any trophy change.
2. **Rule #1 is violated today** by `tierFromStats`' champion gate — a champion who wins two bot matches is
   demoted to diamond. If the user tests exactly that, the whole "trophies only go up" promise fails in front
   of them.
3. **"played" will get inflated later.** It is the most obviously tunable number in the system and it is the one
   with a hard mathematical wall at 66. If nobody writes 66 into the code, someone sets played to 100 and
   makes throwing optimal.
4. **Asks #5 and #7 both push opponent-strength scaling onto the trophy track.** I am refusing it (beyond a
   capped +25). If the user overrules that, the trophy number stops being predictable, and "trophies reward
   volume · rank rewards skill" — the line that resolved the streak-duplication in §8 — collapses back into
   two numbers doing one job.
5. **Ask #6 severs the interlock.** "Trophy level raises your rank ceiling" is the best argument for the fast
   difficulty ramp. If bot matches pay 0 rank, the ramp has no upside left and risk #1 gets worse.
6. **The daily cap is the mechanic players resent most.** Fortnite's Creative diminishing returns are its most
   complained-about progression rule. At 1,200/day it is invisible to a normal session, but the first player it
   touches will screenshot it.
7. **`durationSec`, `touches` and `goalsFor` are all client-asserted.** D2/D3/D4 are farm speed-bumps for
   ordinary players, not defenses against a modified client. Same existing trust level as `stats.goals`. Don't
   oversell them.
8. **My W/L/D and goal assumptions are modelled, not measured.** Nobody has played these numbers. Every
   "matches to X" figure moves ±30% with a real win-rate distribution. Instrument first, retune after.
9. **`xpFactor` cannot tell teammate from opponent.** Fine for a volume medal, wrong for anything that claims
   skill. If a later seat reuses this field for opponent strength, it will be measuring the wrong thing.
10. **The brawl goal cap is a nerf someone will notice.** A player who enjoys goal-brawl loses up to 175
    trophies from a 40-goal match. Small population, but it is the only line item in this doc that takes
    something away — announce it rather than letting it be discovered.

---

## 10. SOURCES — verified vs inferred

### VERIFIED from our own shipped code (file:line, read this session)
- `pikme-server/data/football-xp.js:35-48` — `computeMatchXp`: base 100/50/30, `+10·goalsFor`,
  `× clamp(xpFactor, 0.5, 1.0)`, `+200` first win of day. All terms ≥ 0 → monotone.
- `football-xp.js:7-11` — `levelFromXp` is triangular: cumulative to L = `50·L·(L−1)`. **`XP_TIER_MIN` is the
  TIER ladder, a different ladder from the LEVEL curve** — the brief conflates them; both are tabled in §3.
- `football-xp.js:67-75` — `tierFromStats` champion gate `winsVsHuman < winsVsBot` **can regress** (§1).
- `pikme-server/routes-pikme/user.js:1246` — `goalsFor` clamped to **100** → `+1000` trophies possible.
- `routes-pikme/user.js` — **`durationSec` is never read.** The client sends it (`client.js:546`); the server
  ignores it. `stats.touches` and `possSec` ARE read and clamped (`user.js:1284`).
- `football-mock/shared/sim.js:410-421` — **own goals are impossible**; the goal line is a solid wall for the
  non-attacking team, with an explicit comment saying so.
- `shared/sim.js:597-608` — 120s cap, tied → **45s golden goal** (so an AFK 0-0 is *extended*, not shortened).
- `shared/constants.js:57,63-66` — `MATCH_DURATION 120`, `OVERTIME_DURATION 45`, `GOAL_RESET 5`.
  Freezes are **not** billed to the match clock (`sim.js:556-558`).
- `football-mock/server.js:89-90` — `quick` = first-to-3; `brawl` = `goalsToWin: 0` = **timed, no early end**.
- `public/client.js:534` — `xpFactor = 0.2 + 0.8·(otherHumans/otherSlots)`, 2dp → **0.20 / 0.47 / 0.73 / 1.00**.
- `public/client.js:2034, 2040, 2211, 3401, 4225-4227` — quick-match and goal-brawl force `xpDiffLevel()`;
  the manual difficulty slider is **training/private/builder only**. **No override in the solo modes.**
- `public/client.js:6026-6039` — `postMatchResult` fires only on `phase === 'ended'` → quitting pays nothing.
- `shared/difficulty.js:20-33, 61-63` — bot L5 enemy = `T.normal` 0.50; `botLevelFromXp = playerLevel − 1`.
- `pikme-server/data/football-rank.js:40-45, 55-58` — `BOT_RATE 0.4`, `BOT_DAILY_CAP 150`,
  `OPPONENT_DAILY_LIMIT 3`, `botCeiling(L) = 60 + 80L`; `applyRankDelta:140-146` = the sticky-floor pattern
  §1 recommends copying.

### VERIFIED external (2025–26 sources)
- **Brawl Stars Mastery: 6,000 points/day cap** (scaled during Mastery Madness). — Brawl Stars Wiki / mobilematters.gg
- **Brawl Stars REMOVED Masteries 2025-06-24**, replaced by Trophy Road to 100k + "Records". Stated reason:
  *"a niche feature where only a few very active players engage"* — **only 11.8% of players earned a Brawler
  Title in 2+ years.** — <https://supercell.com/en/games/brawlstars/blog/news/rip-masteries/>
  **→ correction to `00-DECISION.md`, which cites Mastery as the live monotonic-track precedent.**
- **CoD Mobile: bonus XP on the first 3 matches of each day**, resets on a 24h timer. — Activision CoDM Help
  Center, "How do bonuses work?" (direct fetch 403; content read via search index)
- **Fortnite Chapter 6: per-mode daily XP caps** (LEGO 570k / Reload 600k / Festival 100k / Creative 60k /
  BR playtime 0) and **Creative diminishing returns resetting weekly**; quest XP uncapped. — Fortnite News,
  sportskeeda "Fortnite XP Cap, Reset times explained"
- **Brawl Stars: leaving a Power League match can cost progression and ban you from the mode.** —
  <https://supercell.com/en/games/brawlstars/blog/news/note-about-power-league-penalties/>

### PARTIALLY VERIFIED
- **Rocket League awards XP "based primarily on match length" rather than score** — Rocket League Wiki /
  PC Gamer coverage of the progression rework. Primary Psyonix post returned 403 and the wiki 402, so the
  **exact per-minute numbers are unverified**. The *shape* is the point: it supports a `played`/time term and
  argues against an uncapped per-goal term.

### NOT VERIFIED — do not cite
- **EA FC Mobile daily objective / stamina caps.** No citable 2025–26 number found. The brief asks for it; I am
  not inventing one. Treat as unconfirmed.
- **Brawl Stars AFK-detection specifics for 2025.** Only the Power League leaver penalty above is sourced.

### INFERRED — my design proposals, nobody ships these
The additive 20/80/30/10 split · `TROPHY_GOAL_CAP = 5` · the 4-row `TROPHY_ROSTER_RATE` table
(0.50/0.65/0.80/1.00) · the +25/3-per-day underdog bonus · `TROPHY_MIN_DURATION_SEC 45` ·
`TROPHY_MIN_TOUCHES 3` · `TROPHY_OPPONENT_DAY_LIMIT 6` · the 1,200/2,400/3,600 daily soft cap ·
`xpTierFloor` · `botLevelBeaten + 1` · the `clamp(1 + Δrank/400, 0.6, 1.5)` rank multiplier ·
the `BOT_RATE 0.15 / BOT_DAILY_CAP 60` fallback for ask #6 · the break-even played = 66 · every
"matches to X" and "tr/min" figure (modelled from the shipped constants, never measured in real play).

### Model reproducibility
Three scripts, scratchpad only (not committed):
`econ.mjs` (curves + tiers + daily totals) · `econ2.mjs` (first pass at goal-brawl, **wrong** — it assumed the
brawl match ends when you stop scoring) · `econ3.mjs` (corrected wall-clock model; the §5.1 table). All read the
real `50·L·(L−1)`, `XP_TIER_MIN`, `MATCH_DURATION`, `GOAL_RESET`, `OVERTIME_DURATION` values.
