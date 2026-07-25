# Research 4: Economy + Rating Math + the Bot Problem

Scope: how live games price PvE/bot matches into ladder currencies, what rating math fits a
small, bot-heavy 2v2 playerbase, loss/draw/forfeit handling, and observed farm exploits.
Ground truth for Saltiz Football read directly from repo (not guessed):
- `/Users/adamleeperelman/Documents/pikeme/pikme-server/data/football-xp.js` (`computeMatchXp`, `tierFromStats`)
- `/Users/adamleeperelman/Documents/pikeme/pikme-server/data/footballstats.js` (schema: no trophies field exists yet — only `xp`, `level`, `tier`, `winsVsHuman`, `winsVsBot`)
- `/Users/adamleeperelman/Documents/pikeme/pikme-server/routes-pikme/user.js` (`POST /football/record-match`, line ~1194)
- `/Users/adamleeperelman/Documents/pikeme/football-mock/public/client.js` (`postMatchResult`, line 510: computes and reports `xpFactor`)
- `/Users/adamleeperelman/Documents/pikeme/football-mock/shared/difficulty.js` (12 bot levels, `botLevelFromXp`)

**Important finding before anything else**: Saltiz Football currently has **no trophy/rank
number at all**. There is only one ladder currency (`xp` → `level`/`tier`), and it is already
PvE-eligible, graded by `xpFactor = 0.2 + 0.8*(otherHumans/otherSlots)`. This changes the shape
of the recommendation below — the industry pattern isn't "convert an existing trophy system,"
it's "decide whether to ADD a second, PvP-only currency on top of the XP that already exists."

---

## 1. How live games award ladder progression from PvE/bot matches — the rule each one follows

| Game | PvE/bot context | Does it pay the PRIMARY ladder currency (trophies/rank/MMR)? | What it DOES pay | Rule |
|---|---|---|---|---|
| **Brawl Stars** | Backfills 3v3/5v5/Showdown lobbies with bots up to roughly 100–400 trophies (community consensus; Supercell doesn't publish the exact cutoff) [Brawl Stars Wiki](https://brawlstars.fandom.com/wiki/Trophies), [Fandom forum](https://brawlstars.fandom.com/f/p/4400000000000118258) | **Yes** — a win vs. a bot-filled lobby pays full Trophies, same field as a human win, at low trophy ranges | Trophies + normal match rewards | Bots are a *matchmaking filler*, not a separate mode — the currency doesn't know it played bots. Bots disappear as a mechanism once your trophy count is high enough that real opponents are available (reported: bot matches disabled by Prestige 2 / ~2000 trophies) |
| **Clash Royale** | **Training Camp** — separate mode, AI trainer | **No** — explicitly: "no Trophies are gained or lost," no chests, no Masteries progress | Nothing ladder-relevant; pure practice | Training Camp is walled off as its own mode entirely, not blended into ranked ladder play [Training Camp — Fandom](https://clashroyale.fandom.com/wiki/Training_Camp) |
| **Clash Royale** (live ladder, human) | For calibration: real ladder swings ~±30 trophies/match depending on trophy gap | Yes (PvP only) | Trophies, chests, crowns | [Clash Royale Trophies — Fandom](https://clashroyale.fandom.com/wiki/Trophies) |
| **Fortnite** | Epic openly backfills low-skill / bot-lobby-eligible matches with AI bots (Bots have shipped since Ch2S2 as a stated design tool to soften new-player lobbies) | **Yes for XP**, cosmetic/Battle-Pass progress — eliminations and XP count even in bot-heavy lobbies | Match XP, Battle Pass XP | Fortnite has **no PvP rank ladder** in core BR (Arena Hype/Divisions is the closest, and bots are excluded from Arena's competitive hype pool by design) — so "bots count" is true only because the thing being paid (XP) was never a skill-rating in the first place [Bot Lobbies Guide 2026](https://alviran.net/blog/fortnite-bots-bot-lobbies-guide-2026/) |
| **Rocket League** | Casual/Extra Modes can seed AI opponents in low pop; Ranked (Competitive) matchmaking is intended to be human-only, occasional AI-bot leaks are treated as a bug/complaint, not policy | Casual has a hidden MMR too but it's not exposed and softer; Ranked MMR is meant to be humans-only | Casual XP / level, cosmetic drops | Community treats AI-in-ranked as a bug, evidence it's **not** an intentional PvE-pays-rank design [Steam discussion — "Ran into machine learning bots in ranked"](https://steamcommunity.com/app/252950/discussions/0/600768831220161519/) |
| **Apex Legends** | Ranked (RP) backfills incomplete squads with humans of similar rank, not bots; Loss Forgiveness kicks in specifically when a matched-in teammate abandons | RP (ranked ladder currency) is PvP-only by design | Unranked/casual has separate XP | Apex's leaver/forgiveness system (below) is the clean real-world case of "protect the ladder number from a broken lobby, pay a separate currency for participation" [Liquipedia Ranked Leagues](https://liquipedia.net/apexlegends/Ranked_Leagues) |
| **Overwatch 2** | Ranked has no bots; but its point system is a strong template regardless | 10 Competitive Points per win, 5 per draw, **0 per loss** | Competitive Points ≠ the rank/division number itself | Confirms the two-currency instinct even inside ONE mode: rank movement (division/tier) is driven by Win/Loss/Streak/opponent-strength "modifiers," while a *separate* cosmetic-shop currency (Comp Points) is paid asymmetrically per result [Dot Esports](https://dotesports.com/overwatch/news/how-to-get-competitive-points-in-overwatch-2), [Competitive Points — Fandom](https://overwatch.fandom.com/wiki/Competitive_Points) |
| **CoD (Warzone/BO6/mobile)** | "Bot lobbies" community term mostly means EOMM/SBMM giving you weak humans, not literal bots — no credible leaked doc confirms literal AI bots feeding rank in core modes | SBMM/EOMM keeps performance in a band; no confirmed PvE-pays-rank exploit at the system level | N/A | Included because it's the cautionary tale: opaque matchmaking breeds constant player suspicion of manipulation — worth avoiding opacity in Saltiz's own bot system [BotLobbies.com](https://botlobbies.com/blog/cod-bot-lobbies) |

**Extracted rule**: every game that has a real skill ladder (trophies/RP/rank/division)
either (a) walls PvE off into a mode that pays **zero** ladder currency (Clash Royale Training
Camp), or (b) treats bots as pure matchmaking filler that is invisible to the ladder math
because at that trophy range the "real" ladder hasn't started mattering yet (Brawl Stars low
ranges) — but **no shipped game found in this research pays full competitive rank/MMR for a
confirmed, disclosed bot opponent at meaningful skill tiers.** Fortnite and Rocket League "bots
count" cases are both explained by the currency in question not being a skill rating at all
(BR mission XP, casual level).

---

## 2. The two-currency pattern — validated

Evidence collected supports this as the industry answer, though it's more often **de facto**
than a single named principle:

- Clash Royale: Trophies (PvP ladder) vs. Chests/Crowns/Masteries (progression) — Training
  Camp pays neither, cleanly proving the split exists as two orthogonal systems that can be
  independently gated.
- Overwatch 2: rank progress (division/tier, PvP-only) vs. Competitive Points (a spendable
  currency, paid on win/draw, zero on loss) — literally two numbers computed from the same
  match, on different rules.
- Apex Legends: RP (ranked ladder) vs. account/Battle Pass XP — Loss Forgiveness protects RP
  specifically, XP is untouched by forgiveness logic because it was never symmetric with rank.
- Fortnite: no PvP ladder in core modes at all, only XP — the absence of a rank ladder is why
  bots-pay-XP is uncontroversial there; it's not evidence FOR paying rank from bots.

**Verdict: the two-currency pattern is real and is the correct model for Saltiz.** Saltiz
already effectively discovered currency #1 (XP, PvE-eligible, graded by `xpFactor`). The gap is
that Saltiz has never introduced currency #2 (a PvP-only rank/trophy number). That absence is
worth flagging explicitly to the other research agents: much of the "how much should winning
vs losing vs bots pay" question only has a clean answer once you add a second currency —
trying to make ONE currency (xp/tier) serve both the "am I progressing" role and the "am I
good at PvP" role is exactly the tension the industry two-currency split exists to resolve.

---

## 3. Rating math for a 2v2 game with a small, bot-heavy playerbase

| System | Mechanism | Fit for hundreds-of-users, bot-heavy 2v2? |
|---|---|---|
| **Elo** | `E = 1/(1+10^((R_opp-R_self)/400))`; `R' = R + K(S-E)`. Single scalar rating, fixed K by experience tier (FIDE: K=40 <30 games, K=20 <2400, K=10 ≥2400) [GeeksforGeeks](https://www.geeksforgeeks.org/dsa/elo-rating-algorithm/), [Elo calc](https://wismuth.com/elo/calculator.html) | Designed for 1v1, no native team-contribution split, no built-in uncertainty tracking — for a team game you'd need an ad hoc "average team Elo" hack. Workable but crude. |
| **Glicko-2** | Adds RD (rating deviation, a confidence interval) and volatility σ. Rating change shrinks when your RD is already low OR the opponent's RD is high (their true skill is unknown, so a result against them teaches little) [gpluscb gist](https://gist.github.com/gpluscb/302d6b71a8d0fe9f4350d45bc828f802), [Glickman PDF](https://www.glicko.net/glicko/glicko2.pdf) | **Directly solves the small-playerbase, irregular-play problem**: a player who plays twice a month has a wide RD and their rating moves fast to find its level, then stabilizes; a bot of *known, fixed skill* can be assigned RD≈0 (maximally confident), which correctly makes it a **strong anchor** — beating a low-RD bot moves YOUR rating a lot because the system trusts the opponent's rating completely. This is the best-fit off-the-shelf math here. |
| **TrueSkill / TrueSkill2** | Bayesian factor graph; team skill ≈ sum of member skills; TrueSkill2 additionally regresses individual stats (K/D-equivalent) into the per-player skill estimate, not just win/loss, and models squad/duo bonus. 68% match-outcome prediction accuracy vs. 52% for TrueSkill1 (Microsoft/Halo data) [Microsoft Research](https://www.microsoft.com/en-us/research/publication/trueskill-2-improved-bayesian-skill-rating-system/) | Built exactly for "team game, want each player's individual rating from a team result" — the closest fit to 2v2 with mixed human/bot rosters, since it factors goals/strips/saves the way TrueSkill2 factors kills/deaths. Overkill in implementation cost for a hundreds-of-users game; needs a proper solver (Infer.NET-style message passing), not a spreadsheet formula. |
| **OpenSkill** | Open-source, dependency-free reimplementation of the Bayesian family (Plackett-Luce / Thurstone models), no patent/licensing baggage of TrueSkill, simpler math, still team-aware and supports partial-credit-per-player | A pragmatic middle ground if a Bayesian system is wanted without a Microsoft research team behind it — but still meaningfully more code/testing than flat deltas. |

**Key insight, chased and confirmed**: chess engines' Elo IS literally how human Elo pools have
been cross-calibrated for decades — engines rated far above any human (Stockfish ~3600+) serve
as **fixed, known-strength anchors** that let independent rating pools (FIDE, Lichess,
Chess.com) be compared and validated against each other, precisely because an engine's rating
doesn't drift the way a human pool's internal average can. The June-2026 LLM benchmarking work
formalizes this exact idea for a totally different domain: "anchor models... fixed and never
updated, ... calibrated across the whole pool," with an explicit **calibration-error metric**
defined as: a perfectly-calibrated engine should win ~50% of games against a human at the
Elo the engine claims to represent [Methodology — LLM Chess Benchmark](https://chessbenchllm.onrender.com/methodology), [Human-aligned Chess with a Bit of Search (arXiv 2410.03893)](https://arxiv.org/pdf/2410.03893).

**Direct implication for Saltiz**: `shared/difficulty.js` already assigns each bot level (0–11)
a `T.*` skill scalar (0.05 → 1.00) AND a player-equivalent XP/level via `xpForBotLevel` — i.e.
Saltiz **already has fixed, known bot ratings**, it just doesn't feed them into any Elo/Glicko
math yet. A bot at level L could legitimately be assigned a Glicko-style rating **with RD = 0**
(perfectly known skill) sitting at a fixed point on the human ladder, calibrated once (e.g. bot
level 5 ≈ human rating X, from observed human win-rates against it) and then never re-estimated
— exactly the chess-engine-anchor pattern. Beating a level-11 bot would then mean something
mathematically real (like beating a ~2400 opponent), not just "you get some fixed amount."

**But**: this is a genuinely nontrivial system to build and tune correctly for a
hundreds-of-users game, and mis-calibrated bot anchors (bot is "supposed" to play at skill X
but the bot AI actually plays weaker/stronger due to implementation quirks) would inject
systematic bias into every human's rating. See Recommendation section for why flat deltas likely
win here anyway.

---

## 4. Loss deltas, rage-quit, forfeits/leavers/AFK

| Game | What a LOSS pays | Forfeit/leaver handling |
|---|---|---|
| Overwatch 2 | **0** Competitive Points on loss (10 win / 5 draw); but rank/division still moves (down) — the *cosmetic currency* is zero-on-loss, rank progress is not "zero," it's negative | n/a in these results |
| Football-mock (current) | `computeMatchXp`: `base = win?100:draw?50:loss?30` — losers/drawers still paid, explicit "anti-rage-quit" comment in the code | none yet — no leaver penalty exists in `record-match` |
| Apex Legends Ranked | Losses cost RP as normal | **Loss Forgiveness**: if a matchmade (non-partied) teammate abandons, or your squad starts short, the system pays you enough RP to zero out the loss. Separately, each player gets **1 forgiven unexpected quit per 24h**, capped at 3 for the season before forgiveness is revoked entirely [Liquipedia](https://liquipedia.net/apexlegends/Ranked_Leagues), [Dexerto](https://www.dexerto.com/apex-legends/punishment-details-apex-legends-ranked-mode-quitters-revealed-768935/) |
| General design literature | "Rage Quit Remedy" pattern: paying SOME reward for a loss (not zero) and making quitting mid-match earn literally nothing (vs. losing normally) is the standard anti-rage-quit lever — the loss must still feel more rewarding than abandoning | [Wayline — Rage Quit Remedy](https://www.wayline.io/blog/rage-quit-remedy-designing-games-that-keep-players-hooked), [TV Tropes — Anti-Rage-Quitting](https://tvtropes.org/pmwiki/pmwiki.php/Main/AntiRageQuitting) |

**Rule extracted**: pay losers something non-zero in the PROGRESSION currency (retention lever,
Saltiz already does this via the 30-base XP-on-loss), but the PvP RANK currency can legitimately
go to zero or negative on loss — that's what makes it mean something. Forfeits/leavers should
be handled by (a) making an abandoned match not count as a normal loss for the abandoned-on
player (Apex's model) and (b) capping how many times a player can benefit from that forgiveness
before it's assumed to be exploited.

## 5. Draw handling

Standard Elo treatment: a draw scores **S = 0.5** in the same `R' = R + K(S-E)` formula used for
win(1.0)/loss(0.0) — i.e. draws aren't a separate rule, they're the midpoint of the same formula
[GeeksforGeeks Elo](https://www.geeksforgeeks.org/dsa/elo-rating-algorithm/). Overwatch 2 diverges
practically: **draws don't move rank progress at all** (only Comp Points, 5/match) — a simpler,
"draw is a non-event for the ladder" rule that's easier to reason about for players. Football's
`computeMatchXp` already does something in between: draw pays 50 XP (half of win's 100 base),
which is the Elo-midpoint philosophy applied to the XP currency.

## 6. Farm exploits actually observed in the wild + defenses

| Exploit | Evidence | Defense used |
|---|---|---|
| **Win-trading** (two accounts alternate wins to inflate both, or boost a specific account) | Valve banned 65,594 Dota 2 accounts for smurfing/win-trading in one wave [GosuGamers](https://www.gosugamers.net/dota2/news/74033-dota-2-bans-over-65-000-accounts-for-smurfing-and-win-trading); Valorant's anti-boosting/win-trading detection can revert MMR and rank rewards on confirmed cases [PlayValorant](https://playvalorant.com/en-us/news/announcements/playing-fair-anti-boosting-and-other-smurfing-countermeasures/) | Behavioral pattern detection (same-pair repeat matchups, suspiciously consistent alternation) → ban waves + rank/MMR rollback, not just a numeric cap |
| **Smurfing** | Same Valorant source: smurf accounts had their MMR automatically adjusted based on detected true skill, reducing "stomp" matches | MMR correction rather than a ban, when skill mismatch (not manipulation) is the driver |
| **Bot/PvE farming for ladder currency** | No shipped game found that pays full rank for a disclosed bot win at meaningful skill tiers (see Section 1) — the industry's actual defense is architectural: **don't let bots touch the PvP currency at all**, rather than detecting after the fact | Architectural exclusion > detection |
| **Repeated-opponent farming** (generic pattern, not Saltiz-specific) | Not confirmed as an explicit chess.com/Lichess mechanic in this research — no evidence of a same-opponent diminishing-returns rule in mainstream Elo/Glicko implementations | Absence of evidence here is itself useful: most big ladder systems do NOT bother with per-opponent caps, they rely on K-factor/RD naturally shrinking gains against a repeatedly-beaten low-rated opponent (an Elo/Glicko opponent you've already beaten many times has a LOW expected-score gap, so `S-E` shrinks toward 0 naturally) |

**Relevant to Saltiz specifically**: the brief flags "a friend and I could 1v1 and trade wins."
Since Saltiz is 2v2 with bot backfill, the analogous exploit is two friends going 1v1 (or 2v2
with throwaway/alt phones) and alternating results, or one strong player repeatedly farming
a weak/known bot roster. The clean architectural defense (per Section 1/2) is: **make bot wins
pay zero PvP-rank currency by construction**, and for human-only win-trading, use a **distinct-
opponent requirement or a per-opponent-pair daily cap** on the PvP currency (a numeric,
implementable version of what Valorant/Dota do only after-the-fact via ban waves) — appropriate
for a hundreds-of-users game where full anti-cheat infrastructure isn't proportionate.

## 7. Concrete published per-match numbers

| System | Win | Loss | Draw | Notes |
|---|---|---|---|---|
| Clash Royale (ladder) | ~+30 (varies by trophy gap) | ~-30 symmetric-ish at mid-ladder | n/a (no draws in CR 1v1) | [Clash Royale Trophies wiki](https://clashroyale.fandom.com/wiki/Trophies) |
| Clash Royale (Training Camp) | 0 | 0 | 0 | explicit zero, separate mode |
| Brawl Stars (<1100 trophies) | gain > loss (forgiving) | smaller than gain | n/a | [Sportskeeda Oct-2024 update](https://www.sportskeeda.com/mobile-games/brawl-stars-october-2024-update-trophy-system-overhauled-new-trophy-box) |
| Brawl Stars (≥1100 trophies) | gain < loss (asymmetric, harder) | loss > gain | n/a | same source — flips direction as rank rises, opposite of a naive symmetric Elo |
| Overwatch 2 Comp Points | +10 | +0 | +5 | rank/division itself uses a separate opaque "modifier" system (win/loss/streak/match-difficulty), not flat points [Dot Esports](https://dotesports.com/overwatch/news/how-to-get-competitive-points-in-overwatch-2) |
| League of Legends LP (mid MMR) | +20 to +24 | −16 to −19 | n/a (no draws) | [Boosting Market](https://boostingmarket.com/blogs/lol-lp-system-explained/) |
| League of Legends LP (high MMR — system thinks you belong higher) | +25 to +30+ | −10 to −15 | — | system deliberately asymmetric to rush you toward "true" rank |
| League of Legends LP (low MMR — system thinks you belong lower) | +10 to +15 | −22 to −28 | — | asymmetric the other way — a MMR-hidden-layer trick to converge rank faster than flat Elo would |
| FIDE Elo K-factor | K=40 (<30 games played) / K=20 (<2400) / K=10 (≥2400) | same K, sign flips | draw = 0.5 score in same formula | [GeeksforGeeks](https://www.geeksforgeeks.org/dsa/elo-rating-algorithm/) |
| Saltiz (current, XP only — no trophies yet) | 100 base + 10/goal, ×xpFactor(0.2–1.0), +200 first-human-win-of-day, +streak≤50 | 30 base ×xpFactor | 50 base ×xpFactor | `data/football-xp.js` |

**Is loss:gain symmetric?** No single ratio holds across the industry. Symmetric-ish at
mid-ladder (Clash Royale, FIDE low-K), asymmetric FORGIVING at low rank in almost every game
(new players lose less than they gain — Brawl Stars <1100, LoL low-MMR), and asymmetric
PUNISHING at high rank in some (Brawl Stars ≥1100 trophies: lose more than you gain). The
universal pattern is **"forgiving at the bottom, tightening (or reversing) at the top"** — never
flat 1:1 across the whole ladder in games designed for broad populations.

---

## RECOMMENDATION FOR SALTIZ FOOTBALL

**Premise**: introduce a second, PvP-only currency — call it **Trophies** — alongside the
existing PvE-eligible `xp`/`level`/`tier`. Do NOT try to make one number serve both jobs; that's
the core two-currency finding from Section 2, and it's the only way to let bot-heavy solo/training
play still feel rewarding (via XP) while keeping a real competitive signal (via Trophies) that
bots can't inflate.

### Exact deltas (flat, Brawl-Stars-style — not a real rating system; see "why" below)

Trophy bands, loosely modeled on the Brawl Stars forgiving-then-tightening curve, sized down for
hundreds-of-users volume:

| Trophy band | Win | Loss | Draw |
|---|---|---|---|
| 0–299 (new player) | +8 | −2 | +3 |
| 300–999 | +6 | −4 | +2 |
| 1000–1999 | +5 | −5 | +2 |
| 2000+ ("legend") | +4 | −6 | +1 |

Rationale: forgiving at the bottom (new players climb fast, losses barely hurt — protects
retention for exactly the population most likely to face tough bots or humans), converges to
symmetric in the middle, flips to loss-punishing at the top (Brawl Stars' ≥1100-trophy behavior)
so the top of the ladder means something and can't be padded by volume alone.

### Bots-only match: what it pays

- **Trophies: 0, always, regardless of bot difficulty level or match result.** Defend this
  hard — Section 1 found no shipped game that pays a real skill-rank for a disclosed bot win at
  meaningful stakes; Clash Royale's Training Camp is the cleanest precedent (literally 0
  trophies). Any nonzero trophy value for a bot match is a farmable line the moment the
  playerbase realizes bot difficulty is capped by their own XP (`botLevelFromXp`) — i.e. a
  player could deliberately keep XP low to keep bots weak and farm Trophies risk-free. Zero
  closes that off completely and costs nothing in complexity.
- **XP: already correctly handled** by the existing `xpFactor` (0.2 floor for all-bot matches) —
  no change needed here. This is good, working anti-farm design already in the repo.

### Bot difficulty (0–11) as a factor — where it SHOULD apply

Per `TASK-xp-human-ratio.md`, bot difficulty deliberately does NOT affect `xpFactor` today (it's
about human presence, not bot strength) — keep that boundary. But since Trophies pay 0 for bot
matches anyway, bot difficulty has nothing to modulate on the Trophy side either. The one place
bot difficulty SHOULD matter: a **secondary, small XP bonus** for beating a harder bot in
solo/training, e.g. `+2 XP per bot level above 5` on a win only, capped at +12 (level 11) — this
gives solo players who face harder bots (because their own XP scaled the bot up) a modest reward
for genuine difficulty without touching the anti-farm floor. Purely additive, purely optional.

### Folding in `xpFactor` (human-ratio grading)

Keep `xpFactor` exactly as-is for XP. Extend the same signal to gate Trophies: only award
Trophy deltas when `xpFactor === 1.0` (i.e., `vsHuman` with EVERY other slot human) — a 3-human-
1-bot match should pay Trophies at 0, same as bots-only, because a single bot on the roster still
means the "opponent" isn't fully known/adversarial-symmetric. This is a strict rule (all-human-or-
nothing) chosen deliberately over a graded Trophy multiplier, because a graded Trophy value
reopens exactly the same farmable partial-credit surface the flat-zero rule was meant to close.

### Anti-farm caps (sized for hundreds of users)

- **Daily Trophy cap**: no more than **±10 net Trophy matches per day** count toward the ladder
  (e.g. cap at the 10th all-human match of the day — further matches still play normally and
  still pay XP, just no more Trophy movement that day). Bounds any single day's ladder movement
  regardless of grind.
- **Per-opponent-pair daily cap**: Trophies from repeat matches against the **same specific
  opponent** (or opponent pair, in 2v2) decay after the 2nd match same-day — 3rd+ meeting that
  day pays **0 Trophies** (still full XP). This is the direct, numeric defense against the
  "two friends alternate wins" scenario named in the brief — cheaper to implement than Valorant/
  Dota's after-the-fact ban-wave detection, and appropriate for a playerbase too small to run
  real anti-cheat ML on.
- **Distinct-opponent requirement for tier gates**: extend the existing `winsVsHuman >= 25`
  platinum-gate and `winsVsHuman >= winsVsBot` champion-gate (already in `tierFromStats`) with a
  **distinct-phone-count** requirement once Trophies exist — e.g. platinum+ requires wins against
  ≥8 distinct human phones, not just 25 wins that could all be one farmed friend. Needs a
  small additive schema field (a capped recent-opponent-phone-hash list), not a redesign.

### Math choice: flat deltas, not a real rating system — and why

Despite the genuinely elegant Glicko-2/bot-as-known-anchor idea (Section 3) — which IS
theoretically the "correct" answer, and chess engines prove the anchor concept works in
practice — **recommend flat Brawl-Stars-style deltas over Elo/Glicko/TrueSkill for Saltiz
specifically because**:
1. Hundreds of users means the statistical assumptions behind RD/volatility convergence
   (Glicko-2) or Bayesian team-skill inference (TrueSkill2) don't have enough match volume per
   player to ever stabilize — you'd spend months in a noisy, unconverged state that plays worse
   than a flat table.
2. The existing codebase has zero rating-math infrastructure; `computeMatchXp`/`tierFromStats`
   are simple, pure, testable functions (this is a real strength — see the file's own docstring
   "NO Mongo, NO I/O"). A flat delta table preserves that simplicity and testability; Glicko/
   TrueSkill would require persisting RD/volatility per player, migration of the schema, and a
   materially larger surface to get right for a small team.
3. The bot-as-anchor idea remains available as a LATER upgrade path if Trophies ever start
   feeling wrong at scale — nothing here forecloses it, since bots already carry the
   `T.*` skill scalars needed to seed such a system. But it's not proportionate to build now.

### Files/functions that would change

- **`/Users/adamleeperelman/Documents/pikeme/pikme-server/data/football-xp.js`**: add
  `computeMatchTrophies({ result, trophiesBefore, xpFactor, isRepeatOpponent })` alongside
  `computeMatchXp` — pure function, same style, returns the flat delta from the band table above,
  zeroed when `xpFactor < 1.0` or repeat-opponent cap tripped.
- **`/Users/adamleeperelman/Documents/pikeme/pikme-server/data/footballstats.js`**: schema needs
  a new `trophies` field (default 0) plus a small capped structure for recent-opponent tracking
  (e.g. `recentOpponents: [{ phoneHash, date, count }]`, pruned) to support the per-pair cap and
  the distinct-opponent tier gate.
- **`/Users/adamleeperelman/Documents/pikeme/pikme-server/routes-pikme/user.js`** (`POST
  /football/record-match`, ~line 1194): call `computeMatchTrophies` alongside the existing
  `computeMatchXp` call, apply the daily-cap and per-opponent-cap checks before `$inc`-ing
  `trophies`.
- **`/Users/adamleeperelman/Documents/pikeme/football-mock/public/client.js`** (`postMatchResult`,
  line 510): no change needed to what the game reports — `xpFactor`, `vsHuman`, `result` already
  carry everything the new Trophy math needs; the game stays unaware of Trophies entirely (server-
  side-only concept, matches the existing "game never trusts/computes XP" boundary).
- **`shared/difficulty.js`**: no change required for Trophies (bots pay 0 regardless of level);
  optional small addition if the bot-difficulty XP bonus above is implemented (`botLevelFromXp`
  already exposed, just needs a lookup at match-record time — but level isn't currently in the
  `matchResult` payload, so this ALSO requires adding `botLevel`/`diffLevel` to `postMatchResult`'s
  payload in `client.js` if pursued).

---

## SUMMARY (~500 words)

Saltiz Football currently has **no PvP trophy/rank currency** — only one ladder number, `xp`
(→`level`→`tier`), which is already PvE-eligible and graded 0.2×–1.0× by `xpFactor` based on how
many match slots are human (`public/client.js` `postMatchResult`, `pikme-server/data/football-xp.js`
`computeMatchXp`). This is good, working anti-farm design already in the repo. The gap is that
there's no second currency that means "I am actually good at PvP," which is exactly the industry
pattern the research validates: Clash Royale walls PvE (Training Camp) off from Trophies
entirely (0 gained/lost); Overwatch 2 runs two systems off one match (rank progress vs. 10/5/0
Competitive Points); Apex keeps RP (ranked, PvP-only) separate from account XP. No shipped game
found pays a real skill-rank for a disclosed bot win at meaningful stakes — bots either sit in a
zero-stakes mode (Clash Royale) or are pure matchmaking filler at trophy ranges too low to matter
(Brawl Stars, community-estimated cutoff ~100–400 trophies, Supercell doesn't publish it) or the
"currency" in question (Fortnite BR XP, Rocket League casual level) was never a skill rating in
the first place.

On rating math: Elo, Glicko-2, TrueSkill/TrueSkill2, and OpenSkill were compared with formulas.
Glicko-2's rating deviation (RD) is the theoretically best fit for small, irregular playerbases —
and its mechanics reveal something genuinely useful: a bot of known, fixed skill is a perfect
calibration anchor (RD≈0), exactly the role chess engines have played in cross-calibrating human
Elo pools for decades (confirmed via current LLM-benchmarking methodology that explicitly names
"fixed anchor models... calibrated across the whole pool," with a formal calibration-error
metric). Saltiz's `shared/difficulty.js` already has the ingredients for this — 12 bot levels
each with fixed skill scalars and player-equivalent XP — but the recommendation is to NOT build
the anchor system now: hundreds of users won't generate enough match volume to converge a
Bayesian rating, and it would add real schema/infra weight to a codebase whose existing XP math
is deliberately kept pure-function-testable. Flat deltas (Brawl Stars-style, forgiving at the
bottom, tightening/reversing at the top) are recommended instead, with the bot-anchor idea
flagged as a viable future upgrade only if flat deltas prove insufficient at scale.

Loss/draw handling: pay losers something non-zero in the PvE-eligible currency (Saltiz already
does — 30 base XP on loss vs. 100 on win, explicit anti-rage-quit design) but let the new PvP
Trophy currency go negative on loss, as Overwatch/Clash Royale/LoL all do. Concrete spec:
banded win/loss/draw Trophy deltas (+8/−2/+3 new players down to +4/−6/+1 at 2000+ Trophies);
bots-only matches pay **zero Trophies always**, defended against the exact farm risk that
`botLevelFromXp` scales bot strength to the player's own XP (a player could stay low-XP to farm
weak, zero-risk bots); Trophies gate strictly on `xpFactor === 1.0` (fully human roster), not
graded, to avoid reopening a partial-credit farm surface. Anti-farm caps sized for a
hundreds-of-users game: a daily cap of 10 Trophy-eligible matches, and a same-opponent-pair
decay (3rd+ meeting same day pays 0 Trophies) as the direct, numeric defense against the
named win-trading-with-a-friend scenario. Named files to change: `data/football-xp.js` (new
`computeMatchTrophies`), `data/footballstats.js` (new `trophies` field + recent-opponent
tracking), `routes-pikme/user.js` `/football/record-match` (~line 1194), no changes needed to
the game client's report contract.

Sources cited inline throughout the file at
`/Users/adamleeperelman/Documents/pikeme/football-mock/summery/research-trophies/04-economy-bots-math.md`.
