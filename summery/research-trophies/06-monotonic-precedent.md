# 06 — Shipped precedent for an UP-ONLY ladder
> Seat: monotonic-precedent. Date 2026-07-26. Owner of this file only.
> Reads: `00-DECISION.md` §7/§8, `01-brawl-stars.md`, `02-other-games.md`, `pikme-server/data/football-xp.js`, `football-rank.js`.
> **V** = verified against a shipped game (source at bottom). **I** = my proposal, not shipped anywhere.

---

## CONCLUSION (read this, skip the rest if you're in a hurry)

1. **Up-only headline numbers are the industry norm, not the exception.** Halo Infinite Career Rank (272 ranks, "will not reset with Seasons"), Rocket League player level, Fortnite BP/Accolade XP, CoD Mobile player level, Roblox Rivals level, Brawl Stars Records — all monotonic, all sit *next to* a losable rating. **V** Our shipped `xp`/level track is already exactly this. Rule #1 needs **confirmation, not construction**.
2. **The clean per-match precedent for ask #2 is EA FC Mobile's dual currency**: every Rivals match pays **1 Star (losable: win +1 / draw 0 / loss −1) AND Bonus Points (monotonic: win +3 / draw +2 / loss +1)**. **V** That is our two-track model with real shipped numbers, from a football game, including a nonzero draw and a nonzero loss. It is the single best citation in this whole council.
3. **Ask #5 has essentially NO shipped precedent.** I could not find one live PvP game that scales a *monotonic* per-match currency by *opponent* strength. Every game puts opponent-strength on the **losable** rating (Elo expected-score) and scales the monotonic track by **your own effort** instead: time in match (Rocket League 3 XP/sec), personal score (Halo Career Rank), or your own tier (Brawl Stars Mastery). **And Supercell deleted even the own-tier version in June 2025** — Records explicitly makes "all wins worth the same amount of progress, regardless of the Brawler's Trophy count." **V** That is a finding, not a gap: the industry tried opponent/self-strength scaling on a monotonic track and walked it back.
4. **So: do NOT multiply trophies by opponent strength. Ship it as a capped additive win-only bonus.** That *is* the shipped shape — Brawl Stars **Underdog**: gated on a **150**-point gap, pays **+4 on a win where a win is +8 (a +50% win bonus)**, **draw pays 4**, **a loss costs 0**, and the whole system is **switched off above 1000 trophies**. **V** Port that shape, not a multiplier.
5. **Key it to RANK, never to TROPHIES.** Trophies are monotonic volume — a 2-year-old account with 40,000 trophies is *old*, not *good*. Every shipped opponent-strength bonus keys on the skill rating. (Brawl Stars keys on trophies only because in Brawl Stars trophies *are* the skill rating; in our system `rankPoints` is.) **V/I**
6. **My one high-value code recommendation:** replace `clamp(0.2 + 0.8*ratio, 0.5, 1)` with **`0.5 + 0.5*ratio`**. Same two endpoints as today (0.50 all-bot, 1.00 all-human), but the middle stops collapsing — today a 3-bot and a 2-bot match pay **identically**, which silently ignores ask #3. One-line change, and **no value goes down for any roster**. **I**

---

## THE 7 ASKS

### #1 — "Trophies can only go up"
**Already true and already shipped.** `computeMatchXp` has no negative branch: base is `win 100 / draw 50 / loss 30`, `+10*goalsFor`, multiplied by a factor floored at `TROPHY_BOT_FLOOR = 0.5`, plus `+200` first win of day. Minimum possible payout today = `30 * 0.5 = 15`. Nothing can return ≤ 0.

Guards to keep it true:
- The multiplier must stay **floored above 0**, never allowed to reach 0. A 0 multiplier is a silent decrease in disguise (player played, number didn't move → reads as "broken", the #1 complaint in every migration case in `05`).
- The abandoned-match path must pay something, not nothing (see #2).
- **My proposal contains exactly ONE payout reduction: capping the goal term at +60/match.** Called out honestly in Risks. It does not make the total go down; it makes one component stop growing.

### #2 — Different numbers for WIN / LOSE / TIE / PLAYED
**Decision: PLAYED is the floor all three outcomes are built on, AND the standalone payout for a match that produced no result. It is not a 4th bonus stacked on a win.**

Why: if PLAYED stacks on top of a win, three of the four categories inflate ~20-30% for nothing. If PLAYED == LOSS, there is no reward for fighting a lost game to the whistle and a 0-5 player is better off idling. So **PLAYED < LOSS**, strictly.

```
matchTrophies = (PLAYED + outcomeBonus + goalTerm) * rosterFactor + dailyBonuses
PLAYED = 20 · +WIN 80 · +TIE 30 · +LOSS 10 · no-result 0
```
→ pre-goal totals **100 / 50 / 30**, *identical to what ships today*. Ask #2 is satisfied structurally with zero grind-curve change.

**What "PLAYED alone" means concretely:** the match ended with no W/L/D — host dropped at 1-1 before the whistle, opponent left, server abandoned it. You get **20 × rosterFactor** if you were in for **≥60s**. Under 60s / rage-quit = **0**.
**V** Halo Infinite pays Career Rank for "every **completed** matchmaking game" via Personal Score, outcome-irrelevant. Rocket League pays base XP as **3 XP/sec of match time** — a pure participation term independent of result — and withholds only the win bonus on a loss.

Shipped ratio bracket for win : tie : loss on a monotonic track (**V**):
| Game | Win | Tie | Loss | tie/win | loss/win |
|---|---|---|---|---|---|
| EA FC Mobile — Bonus Points | 3 | 2 | 1 | 67% | 33% |
| Overwatch 2 — Competitive Progression bar | 3 | 1 | 1 | 33% | 33% |
| Overwatch 2 — Competitive Points | 10 | 5 | 0 | 50% | 0% |
| eFootball League — division points | 3 | 1 | 0 | 33% | 0% |
| **ours (today, and proposed)** | **100** | **50** | **30** | **50%** | **30%** |
Our current numbers are already inside the shipped range on both ratios. **No change needed.**

### #3 — Different trophies for humans vs bots, graded by NUMBER of bots
**Broken today.** `xpFactor` grades correctly (0.20/0.47/0.73/1.00) but `computeMatchXp` clamps at 0.5, so **3-bot and 2-bot matches pay exactly the same**. Ask #3 is currently unimplemented.

Fix: `rosterFactor = 0.5 + 0.5 * (otherHumans / otherSlots)`.

| Other humans | Bots | Today | **Proposed** | Δ |
|---|---|---|---|---|
| 0 | 3 | 0.50 | **0.50** | — |
| 1 | 2 | 0.50 | **0.67** | +33% |
| 2 | 1 | 0.73 | **0.83** | +14% |
| 3 | 0 | 1.00 | **1.00** | — |

**Every value is ≥ today. No player's payout drops.** **I** (gradation) / **V** (the *shape* — Rocket League's monotonic XP scales by how many real humans are in your party, 15%→30%).

⚠️ `xpFactor` does not distinguish "the human is my teammate" from "the human is my opponent." For **trophies** that's fine (it's a volume/sociality signal — Rocket League's party bonus is also teammate-only). For **the underdog bonus in #5 it is fatal**, because that needs the opponent roster specifically. New wire fields required: `oppHumans`, `oppAvgRank`.

### #4 — Should bots pay LESS?
**Yes, and they already do — 0.50×.** Keep the floor at exactly 0.50; do not lower it.

Reality check on the size of the gap: our human:bot spread is **2.00×**. The widest shipped spread on a monotonic per-match currency I could verify is Rocket League's party bonus at **1.30×** (1.00 vs 0.77). **V** Brawl Stars Mastery's own-tier scaling ran ~2× across the whole trophy range (5 pts at 0-49 trophies → 10 pts at 100-149) **V** — and Supercell **removed it** in June 2025. So **2.00× is at or beyond the outer edge of shipped precedent.** It is defensible for us (bot matches are the majority path and are trivially farmable), but if a solo player ever complains the grind is dead, **0.50 → 0.60 is the lever**, not the base values.

Brawl Stars does pay full trophies in bot-filled matches below ~100 trophies. **V** Nobody pays *zero* on a monotonic track for a bot match.

### #5 — Trophies for a higher-RANK / higher-TROPHY opponent
**Answer: RANK, never trophies. And as a small capped ADDITIVE bonus, never a multiplier.**

**No multiplier**, because (a) no shipped game does it on a monotonic currency — see Conclusion #3 — and (b) a multiplier on the base would break the "trophies = volume, rank = skill" line by making the volume track a second skill track.

**Ported Brawl Stars Underdog, with our numbers** (**I** values / **V** shape):
| Field | Value | Source of the shape |
|---|---|---|
| Gate | `oppAvgRankPoints − myRankPoints ≥ 150` | BS Underdog triggers at a **150**-point gap **V** |
| Gate | ≥1 **human** opponent (all-bot ⇒ never fires) | bots are scaled to you by `botLevelFromXp`; "higher rank" is meaningless |
| Win | **+25** trophies (a +25% win bonus) | BS pays +4 on a +8 win = **+50%** **V**; halved because we also have a rank track that already scales by opponent |
| Tie | **+10** | BS underdog draw pays **4** **V** |
| Loss | **0** (never negative) | BS underdog loss costs **0** **V** |
| Daily cap | **+50/day** (2 wins' worth) | BS disables underdog entirely above 1000 trophies **V**; a cap is the same idea, softer **I** |
| Reverse case (opponent ≥150 **below** you) | **no penalty, no bonus** | monotonic track must never punish **I** |

Answer to the literal "or higher TROPHIES?" — **no.** Scaling by opponent trophies rewards beating *old accounts*, and it creates a direct farm: find the oldest account in the friend list, beat it forever.

### #6 — RANK between ONLY humans
**Directionally right; the literal version ships a dead wall.** If bot matches pay 0 rank, a player with no friends online has **no rank progression, ever** — and `BOT_RATE = 0.4`, `BOT_DAILY_CAP = 150` and most of `botCeiling` become dead code. This directly contradicts locked §7.1.

**Precedent cuts both ways, and the football game is the tiebreak:**
- Rocket League excludes bots from ranked entirely; Brawl Stars Ranked never contains bots. **V**
- **eFootball League Divisions 10-7 explicitly include AI/beginner opponents** with near-zero relegation risk; the pure-skill zone starts at Div 3. **V** — the actual football-genre answer is *bots at the bottom of the ladder, humans above*.

**Recommendation: keep #6, implement it as "human-only above כסף."** Lower the bot ceiling so bots can carry you through the two entry tiers and no further:

`botCeiling(L) = min(500, 60 + 40*L)` → L0 = 60 … L11 = **500** = the גולד entry line.

| | today | proposed |
|---|---|---|
| botCeiling max | 940 (inside platinum) | **500** (top of silver) |
| Tiers bots can reach | bronze, silver, gold, **platinum** | bronze, **silver** |
| Tiers that are human-only | diamond+ | **gold+** |
| `BOT_RATE` | 0.4 | **0.4** (unchanged) |
| `BOT_DAILY_CAP` | 150 | **60** (scaled to the new ceiling) |

Everything a player would call "a rank" (זהב and up) is then human-earned — that is ask #6 honoured in substance — and a solo player still has ~500 points of real ladder to climb, plus a difficulty picker that makes climbing it a skill gate. **I**

If the user insists on **literal zero rank from bots**: pay rank on the **first 10 lifetime matches only** (a placement allowance, Roblox-pattern **V**), then 0, and show `דרגה נעולה — נצח בני אדם כדי לפתוח`. Expect a measurable retention hit on solo players; the trophy track is then their *only* progression, which is exactly the load the trophy track was designed for.

### #7 — Should rank XP be by opponent rank, opponent trophies, or both?
**Opponent RANK only. Not trophies. Not both.** Mixing in trophies imports volume into a skill rating — a grinder outranks a better player who plays less, which is the exact failure mode `03` documents.

Keep the per-tier BANDS as the base, apply a **gap modifier capped at ±50%** (**V** shape — Roblox Rivals: "the amount gained or lost depend[s] on the gap between your ELO and your opponent's"; this is plain Elo expected-score. **I** buckets):

| gap = oppAvgRank − myRank | Win | Loss | Tie |
|---|---|---|---|
| ≤ −300 | ×0.50 | ×1.50 | ×0.0 |
| −299 … −100 | ×0.75 | ×1.25 | ×0.5 |
| −99 … +99 | ×1.00 | ×1.00 | ×1.00 |
| +100 … +299 | ×1.25 | ×0.75 | ×1.5 |
| ≥ +300 | ×1.50 | ×0.50 | ×2.0 |

Rules: round half away from zero · a win never pays **< +2** · a loss never becomes a gain · the modifier applies **only when ≥1 human opponent** (bots use `botLevel`, which already is their strength) · sticky `rankFloor` still clamps last · `OPPONENT_DAILY_LIMIT = 3` still applies before the modifier.

Worked example, gold band (25 / −8 / 8): beating a diamond player (+300 gap) = **+38**; losing to them = **−4**; drawing = **+16**. Beating a bronze player (−300) = **+13**; losing to them = **−12**.

---

## NUMBER TABLES — what to ship

### Trophy track (גביעים, monotonic) — final per-match formula
```
played      = 20
outcome     = win 80 | tie 30 | loss 10 | no-result 0
goals       = min(60, 10 * goalsFor)   // 0 when no-result: the scoreline never became final
roster      = 0.5 + 0.5 * (otherHumans / otherSlots)     // 0.50 / 0.67 / 0.83 / 1.00
subtotal    = (played + outcome + goals) * roster
firstWin    = +200, once/day, any win incl. bots         // unchanged
underdog    = +25 win / +10 tie / 0 loss, gap>=150 rank, human opp, max +50/day
repeatOpp   = subtotal * 0.5 on the 3rd+ match vs the same opponent today
total       = round(subtotal * repeatOppFactor) + firstWin + underdog     // always >= 0
```

| Row | Value | Modelled on | V/I |
|---|---|---|---|
| PLAYED | **20** | Rocket League base XP = 3 XP/sec, outcome-independent; Halo "every completed match carries you forward" | V shape / I value |
| + WIN | **+80** (total 100) | EA FC Mobile Bonus Points win = 3 (top of a 3/2/1 ladder) | V ratio / I value |
| + TIE | **+30** (total 50) | Overwatch 2 CP: draw = 5 vs win = 10 → exactly 50% | V |
| + LOSS | **+10** (total 30) | EA FC Mobile loss = +1 BP; OW2 progression loss = +1 — a loss on a monotonic track is *never* zero | V |
| NO RESULT | **20 × roster** | Rocket League pays match-time XP on an abandoned match | V shape |
| leaver / <60s | **0** | Rocket League leaver penalty + escalating ban; Halo pays only *completed* matches | V |
| per goal | **+10, capped +60** | RL "10% of your score" performance term | V shape / **I cap** |
| roster factor | **0.50 / 0.67 / 0.83 / 1.00** | RL party bonus scales monotonic XP by human party size (15→30%) | V shape / I values |
| first win of day | **+200** (unchanged) | RL pays a daily bonus on the **first 3 wins** (2000 XP each) — we pay 1, so we are conservative | V |
| underdog | **+25 / +10 / 0**, cap +50/day | Brawl Stars Underdog: 150 gap, +4 on a +8 win, draw 4, loss 0, off above 1000 | V shape / I values |
| repeat opponent | **×0.5 on 3rd+/day** | rank already has `OPPONENT_DAILY_LIMIT=3`; halving (not zeroing) preserves rule #1 | I |
| season reset | **NONE, ever** | Halo Career Rank "will not reset with Seasons"; Brawl Stars resets only **above 1000** and never below | V |

### Resulting totals (2 goals scored, no daily bonus, no underdog)

`subtotal = (20 + outcome + 20) * roster` → pre-factor 120 win / 70 tie / 50 loss. No-result pays PLAYED only (goals aren't final).

| Roster | Win | Tie | Loss | No result |
|---|---|---|---|---|
| solo, **3 bots** (×0.50) | **60** (today 60) | **35** (35) | **25** (25) | **10** (today: nothing) |
| **2 bots** + 1 human (×0.67) | **80** (today 60) | **47** (35) | **34** (25) | **13** (nothing) |
| **1 bot** + 2 humans (×0.83) | **100** (today 88) | **58** (51) | **42** (37) | **17** (nothing) |
| **0 bots**, 3 humans (×1.00) | **120** (today 120) | **70** (70) | **50** (50) | **20** (nothing) |

**Read this table carefully — it is the point of the whole proposal.** The PLAYED restructure is **payout-neutral at both endpoints** (all-bot and all-human are byte-identical to what ships today). It buys three things without inflating anything: (1) the no-result payout, which does not exist today; (2) separately tunable loss/tie floors; (3) ask #2 satisfied. **The only per-match number that actually moves is the two middle rows — because today they are wrong** (the 0.5 clamp pays a 2-bot match the same as a 3-bot match). Every cell is ≥ today.

### Anti-staleness — how up-only numbers stay meaningful (ask (c))

| Device | Our number | Modelled on | V/I |
|---|---|---|---|
| Milestone titles/badges on the level ladder | levels **5 / 10 / 20 / 50 / 100** | Rocket League grants titles every **20** levels to 100, then every **100** | V shape / I levels |
| A named terminal rank to chase | level **12** = "the bot ceiling is maxed" already exists — name it and badge it | Halo Career Rank = **272** ranks ending at **Hero**, never resets | V |
| Overflow converts instead of capping | if the number ever needs a lid, convert the surplus to an app currency — **do not clip the number** | Brawl Stars caps the pure number at **1000**, routes 1000+ into a Trophy Box (5 levels); pre-2024 clipped trophies refunded **1:1** as Star Points | V |
| Hard floors per tier so a tier is a permanent achievement | already shipped as `rankFloor` | Clash Royale Trophy Road arena floors ("once you reach a new Arena you will not be able to return to the previous one"); Path of Legends **Golden Steps** never break | V |
| Rewards are cosmetic, not power | keep it — cards are the power axis | Roblox Super League Soccer rewards are near-entirely cosmetic, explicitly to stay non-pay-to-win | V |
| Quest/objective layer when the raw number goes stale | not yet needed at our size | Brawl Stars replaced Mastery with **Records** (objective completions → Record Points → Record Level), June 2025 | V |
| Seasons | **none at launch** — reconfirming §3 | a monthly reset needs a population we don't have; Brawl Stars resets only above 1000 and **not at all** below | V |

---

## RISKS (most serious first)

1. **Ask #6 taken literally = solo players have zero rank forever.** With `BOT_RATE` set to 0, `BOT_DAILY_CAP` and `botCeiling` are dead code, and the majority path (bot-filled matches) moves *nothing* on the badge over the hero. The mitigated version (ceiling 500 / human-only above כסף) is the only reading I'd ship.
2. **The goal cap is the one place my proposal reduces a payout.** `min(60, 10*goals)` bites on ≥7-goal matches, which are almost exclusively L0-L3 bot blowouts. Uncapped today a 12-0 bot win pays 120 goal-trophies — **more than the win itself** — which is a live farm. Softer alternative if the user won't accept any reduction: `+10` for the first 4 goals then `+5` each, no hard cap. Do NOT leave it uncapped.
3. **Underdog is farmable without the daily cap.** Two friends with a wide rank gap, low-rank one wins repeatedly: +25/win, unbounded. `+50/day` cap is not optional. It also needs `oppAvgRank` on the wire, which does not exist yet — shipping it against `xpFactor` (which counts teammates too) would pay the bonus for having a strong *teammate*.
4. **Raising the roster factor speeds bot difficulty.** trophies → `levelFromXp` → `botLevelFromXp` → bot difficulty → `botCeiling`. Mixed lobbies level ~15-33% faster under my table, so those players meet harder bots sooner and their solo win rate drops. Second-order, real, and it lands on the exact players we're trying to reward.
5. **PLAYED will get implemented wrong.** If anyone reads ask #2 as "a 4th payout stacked on the other three," win/tie/loss all inflate 20-40%. The spec is `played + outcomeBonus`, not `played, then separately outcome`.
6. **Two opponent-strength systems on two tracks = double counting.** Underdog (+25 trophies) and the rank gap modifier (×1.5) both fire on the same match. That's why underdog is 25 and not the literal Brawl Stars-equivalent 50.
7. **Our human:bot spread (2.00×) exceeds every shipped precedent I could verify** (RL 1.30×). Not wrong, but it is the number a complaining solo player will be complaining about.
8. **Source risk on Clash Royale.** Two 2025-2026 guides say Trophy Road ends at 7,500 with hard arena floors and no seasonal reset; Supercell's own June 2025 notes say it extends to **10,000** and that Seasonal Arenas (10,000-15,000) lose **150 per loss** with a partial reset. I trust Supercell. Read my Clash Royale citations as "arena floors make it effectively up-only for the mass of players; the elite end above 10,000 is losable and does reset."
9. **Brawl Stars Mastery is gone (June 24 2025).** `01-brawl-stars.md` §5 describes it as live and cites its trophy-scaled points as precedent. It was replaced by **Records**, and Records deliberately flattened the scaling. Any argument in this council that leans on "Brawl Stars scales its monotonic track by strength" is citing a **removed** system.

---

## DISAGREEMENTS

- **vs shipped code:** `computeMatchXp` clamps `xpFactor` to `[0.5, 1.0]`, which makes 3-bot and 2-bot matches pay identically. That is ask #3 silently unimplemented. Replace the clamp with `0.5 + 0.5*ratio`.
- **vs shipped code:** the goal term is uncapped. I want it capped at +60. This is the only reduction I propose anywhere.
- **vs locked §7.1:** it locks `botCeiling(L) = 60 + 80*L` (max 940, inside platinum) with bots paying 40%. Ask #6 contradicts it outright. I contradict **both** — keep the 40%, cut the ceiling to **500**.
- **vs ask #5 as literally worded:** the user asked "how many trophies for a higher-rank opponent," which reads like a multiplier. I decline the multiplier (no shipped precedent on a monotonic currency; it collapses the volume/skill split) and give a capped additive bonus instead.
- **vs ask #5's second half:** "or higher TROPHIES?" — I say no. Trophies are age, not strength.
- **vs ask #7's "or both":** no. Rank only.
- **vs another plausible reading of ask #2:** PLAYED could reasonably be read as a 4th stacked payout. I read it as the floor + the no-result payout. My reading keeps the shipped grind curve exactly; the other reading inflates everything ~25% and removes the incentive to finish a losing match.
- **vs `01-brawl-stars.md` §5:** Mastery is not live. Records replaced it and removed the strength scaling.
- **vs §8's "revisit rank if anyone approaches diamond":** under ask #6 + a 500 ceiling, nobody reaches diamond without a real human population. The rank ladder above גולד becomes aspirational-only at current headcount. That is the honest consequence of #6 and it should be said out loud before shipping.

---

## SOURCES

**Monotonic ladders (a)**
- Halo Infinite Career Rank — "Career Rank will not reset with Seasons… every completed matchmaking game carries you forward"; Personal-Score driven; 272 ranks over Bronze→Onyx, terminal rank **Hero**. [halowaypoint.com/news/career-rank-overview-season-4](https://www.halowaypoint.com/news/career-rank-overview-season-4) · [halopedia.org/Rank_(Halo_Infinite)](https://www.halopedia.org/Rank_(Halo_Infinite)) **V**
- Rocket League levels — 3 XP/sec of match time, +10% of score, party bonus 15-30%, Rocket Pass 50-80%, MVP +50, first **3** wins of the day +2000 each; titles every 20 levels to 100 then every 100. [epicgames.com/help — How does XP and Levels work](https://www.epicgames.com/help/c-202300000001622/c-202300000001682/how-does-xp-and-levels-work-in-rocket-league-a202300000012382) · [rocketleague.fandom.com/wiki/Leveling_System](https://rocketleague.fandom.com/wiki/Leveling_System) · [op.market level borders](https://op.market/blog/rocket-league-level-borders) **V**
- Brawl Stars **Records** (June 24 2025, replaced Mastery) — objective-based, "all wins are worth the same amount of progress, regardless of the Brawler's Trophy count"; unlocks at 350 trophies. [brawlstars.fandom.com/wiki/Records](https://brawlstars.fandom.com/wiki/Records) · [supercell release notes June 2025](https://supercell.com/en/games/brawlstars/blog/game-updates/release-notes-june-2025/) · [sportskeeda](https://www.sportskeeda.com/mobile-games/new-records-system-brawl-stars-explained) **V**
- Brawl Stars **Mastery** (removed) — points multiplied by your own brawler trophies / rank: 5 pts at 0-49 trophies, 7 at 50-99, 10 at 100-149; +20% Star Player; paid on losses. [1v9.gg mastery points](https://1v9.gg/blog/brawl-stars-how-to-get-mastery-points) · [mobilematters mastery](https://mobilematters.gg/brawl-stars/mastery-ranks-points-rewards-brawl-stars) **V (but the system is retired)**
- Brawl Stars Trophy Road / seasons — pure number capped at 1000, 1000+ becomes Trophy Box (5 levels), reset only above 1000, nothing below 1000 resets; pre-2024 clipped trophies refunded 1:1 as Star Points. [Supercell Trophy Season Rework](https://supercell.com/en/games/brawlstars/blog/news/trophy-season-rework-is-coming/) **V**
- Fortnite — BP XP from Accolades + Quests, awarded in-match for placement/actions, not for winning. [fortnite.fandom.com/wiki/XP](https://fortnite.fandom.com/wiki/XP) · [dexerto accolades](https://www.dexerto.com/fortnite/what-are-accolades-in-fortnite-how-to-acquire-them-2156894/) **V**
- CoD Mobile — player level separate from Ranked; Ranked demotes 2 ranks every 2-month Ranked Series, with a 150-RP "Protection" buffer before demotion. [dexerto rank guide](https://www.dexerto.com/call-of-duty/call-of-duty-mobile-rank-guide-1765144/) · [callofduty.fandom.com/wiki/Ranked_Mode](https://callofduty.fandom.com/wiki/Ranked_Mode) **V**
- Roblox Rivals — Levels (EXP from playing/eliminations, rising cost per level) separate from Ranked ELO, where "the amount gained or lost depend[s] on the gap between your ELO and your opponent's." [robloxrivals.fandom.com/wiki/Levels](https://robloxrivals.fandom.com/wiki/Levels) · [robloxrivals.fandom.com/wiki/Ranked](https://robloxrivals.fandom.com/wiki/Ranked) **V**
- Clash Royale — Trophy Road extends to 10,000 (June 2025), arena floors ("once you reach a new Arena you will not be able to return to the previous one"), Seasonal Arenas 10,000-15,000 pay/cost 150 per match and partially reset; Path of Legends Golden Steps never break. [Supercell June 2025 notes](https://supercell.com/en/games/clashroyale/blog/release-notes/june-update-2025/) · [mobilematters Trophy Road rework](https://mobilematters.gg/clash-royale/clash-royale-trophy-road-rework-level-gates-trophy-floors-champions) **V, with the conflict noted in Risk 8**

**Opponent-strength scaling (b)**
- Brawl Stars **Underdog** — 3v3 only, below 1000 trophies; triggers on a **150** trophy-per-player gap; win pays **+4 or more** extra, draw pays **4**, a loss costs **0** and does not break the win streak; sized off your own rank; removed entirely at 1000+. [topuplive underdog](https://www.topuplive.com/news/understaning-the-underdog-system-in-brawl-stars.html) · [sportskeeda underdog](https://www.sportskeeda.com/esports/what-underdog-status-brawl-stars) **V — but on a LOSABLE currency**
- World of Tanks — "0.1× bonus Credits per Tier difference of the enemy"; level difference also factors into XP. Monotonic currency, opponent-strength scaled — **but "opponent strength" is a vehicle tier, not a player rating.** [wargaming.net/support/…/18956](https://wargaming.net/support/en/products/wot/article/18956/) · [WoT Console XP](https://modernarmor.worldoftanks.com/support/en/products/wotx/article/313/) **V, weak analogue**
- Kenshi — skill XP multiplier x0.1 (22.5 levels above the opponent) to **x6.0** (50 levels below). Genuinely monotonic and genuinely opponent-scaled — **and it is single-player PvE skill training, not a ladder.** [kenshi.fandom.com/wiki/Stronger_Opponent_Logic](https://kenshi.fandom.com/wiki/Stronger_Opponent_Logic) **V, wrong genre**
- I found **no** live PvP game scaling a monotonic per-match progression currency by opponent rating. Party/teammate bonuses (Rocket League 15-30%, Overwatch 2 party XP) are frequently mis-described online as opponent-skill bonuses; they are teammate-count bonuses. One boosting blog claims Valorant pays bonus XP for higher-skilled *friends* — I could not verify it against Riot and I am not citing it as fact. **NOT VERIFIED**

**Draws (d)**
- EA FC Mobile Division Rivals — "Win: 1 Star + 3 Bonus Points · Draw: No Star + 2 Bonus Points · Loss: −1 Star + 1 Bonus Point"; 6 BP = 1 Star (Amateur→Professional), 8 BP (Professional→Legendary); season relegation −5 ranks, floored at Professional V. [ea.com — Division Rivals Deep Dive](https://www.ea.com/en/games/ea-sports-fc/fc-mobile/news/rivals-update-division-rivals) · [easportsfcmobile.fandom.com/wiki/Division_rivals](https://easportsfcmobile.fandom.com/wiki/Division_rivals) **V — best single citation in this doc**
- EA FC 26 console Rivals — weekly points win +3 / draw +1 / loss 0. [dexerto FC 26 Rivals](https://www.dexerto.com/wikis/ea-fc-26-guides-walkthrough-tips/ea-fc-26-rivals-format/) **V**
- eFootball League — win 3 / draw 1 / loss 0 in Divisions 6-4; Divisions 10-7 explicitly include AI/beginner opponents with near-zero relegation risk. [efootballlab.com FAQ](https://efootballlab.com/en/blog/how-do-divisions-work-in-efootball-league.html) **V**
- Overwatch 2 — Competitive Points: win **10**, draw **5**, loss 0. Competitive Progression bar: win **3**, draw **1**, loss **1**; 30 → 100 CP, bar resets. [overwatch.fandom.com/wiki/Competitive_Points](https://overwatch.fandom.com/wiki/Competitive_Points) · [dotesports](https://dotesports.com/overwatch/news/how-to-get-competitive-points-in-overwatch-2) **V**
- Head Ball 2 (mobile 1v1 football — closest genre comparator) — win **+3**, draw **+1**, loss **−2**. Losable, and the loss costs more than a draw pays. [levelwinner Head Ball 2 guide](https://www.levelwinner.com/head-ball-2-guide-2020-update-14-tips-tricks-strategies-to-win-more-matches/) **V, older source (2020 guide)**
- Football Strike — consecutive-win trophy streak with escalating bonuses. Mini Football — weekly league promotion. Neither publishes per-match numbers. [Football Strike (Play Store)](https://play.google.com/store/apps/details?id=com.miniclip.footballstrike) **V existence only, no numbers**
- Roblox Super League Soccer / Blue Lock: Rivals — football-genre Roblox ladders; both losable-Elo with 5-7 named tiers and cosmetic-only rewards; neither publishes numbers. [bluelockrivals-roblox.fandom.com/wiki/Ranked](https://bluelockrivals-roblox.fandom.com/wiki/Ranked) **V shape only**

**In-repo (verified by reading the code)**
`pikme-server/data/football-xp.js` · `pikme-server/data/football-rank.js` · `football-mock/public/client.js` ~L527 · `summery/research-trophies/00-DECISION.md` §7-§8 · `01-brawl-stars.md` · `02-other-games.md`
