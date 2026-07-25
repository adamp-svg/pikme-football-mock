# Research Agent 2 — Comparative Ladder Survey (Fortnite, Rocket League, Roblox, Clash Royale, Mobile Football)

Scope: every relevant ranked/trophy ladder OTHER than Brawl Stars (that's Agent 1's lens — see `01-brawlstars.md` if present). Goal: extract mechanics + numbers to inform a trophy system for Saltiz Football (2v2 arcade football, WebView minigame, small Israeli-teen playerbase, most matches bot-filled).

---

## 1. Fortnite Ranked (2024+) vs. old Arena/Hype

**Old Arena (pre-2023):** three Leagues — Open, Contender, Champion — gated by a confusing "Hype" points currency. Kills were heavily rewarded, which skewed play toward aggressive kill-farming rather than winning, and wide league bands meant mismatched skill levels shared lobbies, killing the incentive to grind. [Dot Esports arena guide](https://dotesports.com/fortnite/news/fortnite-ranked-arena-mode-guide), [EarlyGame Ranked vs Arena](https://earlygame.com/news/gaming/fortnite-ranked-vs-arena-which-game-mode-was-better)

**New Ranked (2023+):** 8 named ranks (Bronze → Unreal), each with 3 sub-tiers except top rank = 18 rungs total. Points come from a blend of **placement** (weighted heaviest) and **eliminations**, with late-match kills and kills against higher-ranked opponents worth more than early/low-rank kills. Progress fills a visible bar per tier; hitting 100% promotes you, hitting 0% demotes you. Exact point values are hidden/tuned per season by Epic (no public formula). [thespike.gg](https://www.thespike.gg/fortnite/ranking-system), [Fandom Ranked wiki](https://fortnite.fandom.com/wiki/Ranked)

**2025+ evolution:** Epic shifted further from pure-elimination scoring toward "holistic performance" — damage dealt, squad support in duos/trios, positioning — specifically to stop rewarding aggressive lone-wolf kill-farming over actually winning/surviving. [gametree.me ranks 2025](https://gametree.me/blog/fortnite-ranks/)

**What Epic changed and why (explicit):** replaced an opaque currency (Hype) + kill-race incentive with a transparent tiered bar that rewards placement over kills, and narrowed skill bands per lobby. The stated motivation was competition from Overwatch/CoD ranked modes that had cleaner, more legible ladders, and Arena's confusing math was suppressing engagement. **Takeaway for us: legibility of the ladder beats cleverness of the formula** — kids play what they can explain to a friend in one sentence.

---

## 2. Rocket League

**Structure:** 8 ranks (Bronze, Silver, Gold, Platinum, Diamond, Champion, Grand Champion, Supersonic Legend), each divided into 3 tiers (I/II/III, except top rank), each tier into 4 divisions (I-IV). MMR is a hidden Elo-like number; the rank badge is a human-readable summary of it. [strafe.com ranks](https://www.strafe.com/news/read/rocket-league-ranks-explained/), [boosteria guide](https://boosteria.org/guides/rocket-league-rank-system-mmr-divisions-climb)

**Per-playlist MMR:** 1v1, 2v2, 3v3 (and casual) each track **completely separate MMR** — a player can be Diamond in 2v2 and Gold in 3v3 simultaneously. Each requires its own 10 placement matches. [exitlag.com](https://www.exitlag.com/blog/rocket-league-mmr/)

**Win/loss delta:** standard ranked games move roughly **±9 MMR**; **placement matches swing ~±16 MMR** (nearly double) so the system converges on your true rank fast. Delta scales with the opponent's relative MMR (beat someone much higher-rated → bigger gain; beat someone lower-rated → smaller gain) — a classic Elo expected-score curve, not a flat number. [theglobalgaming.com soft reset](https://theglobalgaming.com/rocket-league/soft-hard-rank-reset-season)

**Season reset:** **soft reset** every 3-4 months. Your visible rank drops several tiers so you re-climb, but your underlying MMR is only pulled down partially (not wiped) — a Champion II doesn't get dumped to Silver from one bad placement run; the system caps how far pre-season MMR can fall. 10 new placement matches re-establish the visible tier. [trophi.ai MMR](https://www.trophi.ai/post/how-does-ranking-and-mmr-work-in-rocket-league)

**Team performance vs. individual contribution (critical for our 2v2 case):** Rocket League's MMR is **pure win/loss** — goals, saves, assists, shots, even MVP have **zero direct effect** on MMR. The whole team gains/loses the same delta regardless of who scored. This is a deliberate design choice to force teamplay (no solo stat-padding) rather than reward individual carries. [esportnow.gg](https://esportnow.gg/games/news/rocket-league-ranks)

**Bots / vs-AI progression:** Bots **cannot appear in ranked/competitive matchmaking at all** — Psyonix disallows them there specifically so rank stays a human-skill signal. Bots only fill empty seats in **casual/unranked** modes, which award **no MMR progress**. This is the opposite of our game's default (bot-filled by default). [Rocket League Fandom - Bot](https://rocketleague.fandom.com/wiki/Bot)

**Forfeits/leavers:** Leaving early (not via forfeit vote) always counts as a loss with an **extra MMR penalty on top of the loss** plus an escalating matchmaking ban (repeat leavers get longer bans). If a teammate leaves and you stick it out to a natural finish, your MMR is calculated normally; only actively forfeiting/leaving triggers the penalty layer. Casual mode gives one free leave per day before the same penalties kick in. [Steam / RL Support](https://x.com/rl_support/status/1132025675723018240)

---

## 3. Roblox competitive sports/PvP games

Roblox UGC games skew toward **very simple, transparent Elo-style ladders**, built by tiny teams, because that's what a solo/small dev can maintain and what a young playerbase can grok instantly.

**Rivals (1v1/2v2/3v3 sword-fighting arena, but structurally identical to what we'd want):**
- Pure ELO. Rank tiers: **Bronze 0-599, Silver 600-1199, Gold 1200-1799, Platinum 1800-2399, Diamond 2400-2999, Onyx 3000-3599, Nemesis 3600+**.
- Elo-standard expected-score scaling: beating a much-higher-rated opponent = big gain; losing to them = small loss.
- Gate to enter ranked at all: 10 duels won, account level 30, account 14 days old — a **legitimacy filter to keep smurfs/bots out**, not a progression mechanic.
- **One free "ELO Shield" per day** — absorbs one loss with zero ELO change. This is a soft anti-tilt/anti-frustration mechanic, similar in spirit to a demotion shield.
- Matchmaking party rule: squad members must be within 4 tiers (800 ELO) of each other so a high/low pair can't queue together and stomp.
[Roblox Rivals Fandom](https://robloxrivals.fandom.com/wiki/Ranked), [rbxrivals.com](https://rbxrivals.com/blog/roblox-rivals-ranks)

**Super League Soccer (Roblox football, closest genre match):** simpler still — **Bronze / Silver / Gold / Platinum / Champion**, five tiers, climbed via ranked matchmaking, reward is almost entirely **cosmetic** (celebrations, kit/character customization) rather than gameplay power, explicitly to stay skill-based rather than pay-to-win. Seasonal resets exist but exact numbers aren't published (small-team game, no public API/wiki depth). [Grokipedia](https://grokipedia.com/page/Super_League_Soccer), [earnaldo.com](https://earnaldo.com/blog/super-league-soccer-beginner-guide)

**Repeating pattern across Roblox competitive games:** (1) 5-7 named tiers, no more; (2) plain Elo/points win-loss, no fancy formulas; (3) a cheap anti-frustration valve (shield / grace match) rather than complex demotion protection; (4) rewards are **cosmetic**, not power, keeping the ladder purely a bragging-rights/skill signal; (5) a placement-match gate before your rank is even shown, so early noise doesn't pollute the ladder.

---

## 4. Clash Royale trophies (contrast case for Brawl Stars)

Two parallel systems today:

**Trophy Road (casual, F2P onboarding):** 0–14,000 trophies across 20+ Arenas. Win a battle → gain trophies; lose → lose trophies (asymmetric below ~2,000 trophies: winner gains more than loser loses, to speed up early progression for new players; above ~2,000 it becomes symmetric ±). **Never demoted below an Arena already unlocked** — Arenas are a floor, not a range. Beyond 14,000 there's a **Seasonal Trophy Road across 2 seasonal arenas that resets monthly**. [Clash Royale Fandom - Trophies](https://clashroyale.fandom.com/wiki/Trophies), [buyboosting.com arenas](https://buyboosting.com/clash-royale-boosting/guide/)

**Path of Legends / "Ranked Mode" (Oct 2022, renamed mid-2025), the actual competitive ladder replacing the old League system:** a **step-based path with Stone Steps and Golden Steps**. Stone steps break (send you back) on a loss; Golden Steps are permanent floors — once you cross one you can never fall below it in that Path run, no matter how badly you lose afterward. Crossing into a new League is itself a hard floor: **you cannot be relegated to a previous League by losing**. [apptrigger.com](https://apptrigger.com/2022/10/24/clash-royale-path-legends/), [immortalboost.com](https://immortalboost.com/blog/clash-royale/path-of-legends-guide/)

**Contrast with Brawl Stars trophies** (per Agent 1's lens, cross-checked here): Brawl Stars protects **every 1,000-trophy Prestige threshold** as a permanent floor per-Brawler; Clash Royale protects **Golden Steps + League boundaries** on its ranked path but still lets Trophy Road be a pure symmetric ladder above 2,000. Both games converge on the same idea from different angles: **casual/onboarding ladder = free-flowing points with a low floor; competitive/ranked ladder = harder floors, no demotion across just-crossed boundaries.** This split (a low-stakes "practice" trophy track + a separate high-stakes ranked track) is itself a pattern worth stealing.

---

## 5. Football-specific ladders: eFootball League, EA FC Mobile Division Rivals, Score! Match

**eFootball League (Konami):** 10 Divisions, Division 10 = entry, Division 1 = best in world. Runs in **4-week Phases**, resets divisions each Phase (rewards paid on peak division reached). Explicit **three-tier design that gets harder to game as you climb**:
- Div 10-7: pure points-over-10-match-"Phase" system, opponents include AI/beginners, **effectively no relegation** (a beginner safety zone).
- Div 6-4: strict point thresholds for promotion / hold / relegation — the "grind" zone.
- Div 3-1: switches to a **pure Elo/Rating system** (win points/lose points) instead of match-count thresholds — most competitive.
- **Safety floors at Div 9, 6, 3**: once crossed, you cannot be relegated below that floor for the rest of the Phase even after 10 straight losses.
[mumuplayer.com division guide](https://www.mumuplayer.com/blog/efootball-division-system-guide.html), [efootballlab.com FAQ](https://efootballlab.com/blog/how-do-divisions-work-in-efootball-league.html)

**EA FC Mobile — Division Rivals:** star-based promotion currency layered on top of a Division/Rank ladder. **Win = +1 star, loss = -1 star, draw = no change.** 3 stars = promotion to next sub-division (below FC Champion tier). At FC Champion (top), you can't be relegated below 0 stars in-season. **Between seasons, everyone is relegated 5 ranks** (soft reset), with a floor at Professional V so nobody falls to the very bottom. [easportsfcmobile Fandom](https://easportsfcmobile.fandom.com/wiki/Division_rivals), [Dexerto relegation](https://www.dexerto.com/ea-sports-fc/ea-fc-25-rivals-relegation-promotion-explained-2957998/)

**Score! Match (mobile football, small-scale comparator to our own game):** simpler arena/league ladder — climb through named Arenas via ranked 1v1 matches, seasonal resets and events; public documentation is thin (small studio, no deep wiki), consistent with the Roblox pattern of "small teams keep the ladder simple because that's all they can support."

**What football-specific ladders do differently from Brawl-Stars-style continuous trophies:** every one of them uses **discrete Divisions/Leagues with promotion & relegation**, not a single continuous number — because football *as a sport* already has a cultural schema for this (real leagues, relegation zones). All three also converge on the same anti-frustration device: **a floor a few rungs below the top of your reach**, so a bad losing streak costs you a division, not everything.

---

## 6. Promotion/relegation vs. continuous points — which fits Saltiz Football

**Continuous trophies (Brawl Stars style):** one running number, always visible, always moves the same visible amount per game (roughly). Pro: dead simple to implement and to explain; feels good every single match because the number always ticks somewhere. Con: with a small playerbase, variance in a single number can feel arbitrary/swingy match to match, and there's no natural "season" moment to create a reset/event hook — you have to bolt one on artificially (Brawl Stars does, via its own Trophy Season Pass structure, but that's Agent 1's territory).

**Divisions + promotion/relegation (football-specific ladders, eFootball/FC Mobile style):** discrete named tiers, points accumulate within a "phase"/season inside a division, crossing a threshold promotes, a bad phase can relegate you — but almost every implementation studied **adds a floor** so a single bad session doesn't nuke months of progress. Pro: maps directly onto the football metaphor players already understand (ליגה, עלייה/ירידה) which is on-theme for this game specifically, and phases/seasons give a natural cadence for pushing new content/rewards. Con: more states to design and test (per-division thresholds, floor rules, phase-reset math) than a single number.

**Small playerbase, bot-filled matches — the deciding factor:** every real ranked system that has an answer for bots (Rocket League) **excludes bots from ranked entirely** and gives them zero progression value. But Saltiz Football's whole design is bot-filled-by-default (empty slots always filled, scaled via `shared/difficulty.js` levels 0-11 tied to player level). We cannot copy the "no bots in ranked" rule wholesale without breaking the core loop — most matches for most players ARE against bots. The existing `football-xp.js` already encodes the right instinct: an `xpFactor` 0.2×...1.0× multiplier scaling reward by human-ness of the match, plus anti-farm gates (`winsVsHuman >= 25` to reach Platinum+, `winsVsHuman >= winsVsBot` to reach Champion+). That gating logic is exactly the kind of mechanism this comparative survey shows real ladders use (eFootball's Elo-only top tier, Rivals' account-level+win-count gate, RL's bots-excluded-from-ranked) — gate the **top** of the ladder behind human proof, but let bot matches feed the **bottom/middle** so a small playerbase doesn't stall out waiting for opponents.

---

## COMPARISON TABLE

| Game | Unit | Win Δ | Loss Δ | Demotion? | Reset? | Bot rewards? | Best idea to steal |
|---|---|---|---|---|---|---|---|
| **Fortnite Ranked** | Points (placement+elim, hidden formula) | Placement-weighted + late/high-rank kills | Low placement = ~0 gain | Yes, tier bar can empty | Seasonal | N/A (BR, no bot mode) | Ditch opaque currency (Hype) for a transparent fill-bar per tier; weight placement/objective over pure kills |
| **Rocket League** | Hidden MMR (Elo-like) | ~+9 (±16 in placements), scaled by opponent MMR | ~-9 (extra penalty if you leave/forfeit) | Yes, continuous, no floor within a playlist | Soft reset every 3-4 months (drop few hundred MMR, not full wipe); 10 placements | **None** — bots barred from ranked entirely, casual-with-bots earns no MMR | Per-mode(2v2 vs 1v1) separate ladders; pure team win/loss (no stat-padding); soft reset that doesn't nuke true skill |
| **Roblox Rivals** | ELO | Elo expected-score curve | Elo expected-score curve | Yes, continuous | Not clearly seasonal | Not applicable (PvP only) | Daily "ELO Shield" (one free no-loss game) as cheap anti-tilt device; account/win-count gate before ranked unlocks |
| **Super League Soccer (Roblox)** | Tier (Bronze-Champion, 5 tiers) | Win = climb | Loss = drop | Implied yes | Seasonal (undocumented specifics) | N/A | Keep tier count tiny (5); rewards purely cosmetic, not power |
| **Clash Royale Trophy Road** | Trophies | Asymmetric below 2000 (winner > loser's loss), symmetric above | Symmetric above 2000 | No, Arena floors are permanent | Seasonal reset only above 14,000 (Path of Legends is separate & phase-based) | Yes implicitly (bot/low-level matchmaking still pays trophies pre-2000) | Two-track design: free-flowing casual ladder (Trophy Road) + separate hard-floored ranked ladder (Path of Legends) |
| **Clash Royale Path of Legends** | Steps within Leagues | Advance a step (Golden Steps = permanent) | Fall a step (blocked by Golden Steps) | No demotion across a crossed League boundary | Per-season | No (PvP-only ranked path) | Golden Step = permanent partial floor, not just an all-or-nothing tier gate |
| **eFootball League** | Division (10→1) + points/Elo | Points (low div) or Elo (div 1-3) | Points loss or Elo loss | Yes below floors; no below Div 9/6/3 | Every 4-week Phase | **Yes** — Div 10-7 explicitly includes AI/beginner opponents, near-zero relegation risk there | Tiered floor system (safe zone → grind zone → pure-Elo elite zone) matches skill investment to system rigor |
| **EA FC Mobile Division Rivals** | Stars (+1/-1/0) within Division/Rank | +1 star | -1 star | Yes, but floored at FC Champion (0 stars min) and at Professional V (season floor) | Every season: -5 ranks for everyone, floored | Not documented (assume none at FC Champion tier) | Simple ±1 star per game is trivially legible; universal season pull-back keeps ladder from bloating forever |
| **Score! Match** | Arena/League rank | Win to climb | Loss to drop (documented lightly) | Some (arena-based) | Seasonal events | Likely yes (single-team small studio, casual-friendly) | Keep it small-team-buildable: arena ladder, no deep Elo math needed |
| **(current) Saltiz football-xp.js** | Cumulative XP, monotonic | +100 win / +50 draw / +30 loss, +10/goal, ×0.2-1.0 human factor | Never decreases | **No demotion at all** (pure monotonic XP) | None | Yes, but discounted ×0.2 | Anti-farm gates already exist (winsVsHuman thresholds) — reuse this exact mechanism to gate a NEW trophy ladder's top tiers |

---

## RECOMMENDATION FOR SALTIZ FOOTBALL

**Model: hybrid — continuous trophies as the primary unit, with football-flavored "League" labels overlaid as cosmetic tier names, PLUS a human-win gate at the top (reusing the existing anti-farm logic), NOT a full promotion/relegation system with separate phases.**

Why not pure divisions/promotion-relegation despite the on-theme football metaphor: every real division/relegation system studied (eFootball, FC Mobile) needs enough concurrent players **within each division** to keep matchmaking healthy, and needs a phase/season cadence to reset around. Saltiz Football has a **small, bot-filled playerbase** — segmenting players into discrete divisions with their own promotion thresholds risks emptying divisions and forcing bot-only "promotion" grinds, which defeats the purpose of a *social* ladder. Continuous trophies pool everyone into one visible number regardless of population size, which is exactly why Brawl Stars (also small-lobby-count, mobile, young audience) uses it, and why Roblox UGC games with tiny playerbases default to plain Elo/points rather than divisions.

Why not copy Rocket League's "bots don't count" rule: our core loop is bot-filled by default (`shared/difficulty.js`, levels 0-11 scaled to player level) — excluding bot matches from trophy progress would make the ladder stall for most players most of the time. Instead, discount bot-heavy match trophies (mirroring `xpFactor` 0.2-1.0) rather than zeroing them.

**Concrete numbers to use:**
- **Win: +25 trophies** (full value only when ≥1 real opponent human is on the pitch), **Draw: +8**, **Loss: -15** but **floor at 0 trophies for a match with humans on both sides**, wider swing if there's a large trophy gap (Elo-style: opponent trophies − your trophies, scaled ±10 trophies max adjustment) to speed convergence.
- **Bot-match multiplier**: reuse `xpFactor` 0.2 (all-bot) → 1.0 (all-human) applied to the win/draw amount; losses to bots should be capped much softer (e.g., -5, not -15) since bots are unwinnable-by-design at high difficulty — don't punish players for the game's own scaling.
- **5-7 named tiers** (not 20+): e.g. ברונזה/כסף/זהב/פלטינה/יהלום/אלוף — reuse the existing `TIERS` array from `football-xp.js` almost verbatim, just re-keyed to trophies instead of cumulative XP.
- **Per-tier trophy floor, no demotion below a reached tier's floor** (Brawl Stars / Clash Royale Arena pattern) — e.g. once you cross 1,000 trophies (Silver) you never fall below 1,000 regardless of losing streaks. This is the single most important anti-frustration mechanic across every system surveyed and costs almost nothing to implement (just a `max(floor, newTrophies)` clamp).
- **Reuse the existing anti-farm gate verbatim**: keep `winsVsHuman >= 25` required for Platinum+ and `winsVsHuman >= winsVsBot` for Champion+/legend-equivalent — this maps 1:1 onto eFootball's "pure-Elo elite division" and Roblox Rivals' "10 human wins to unlock ranked" gate: **let bots carry you through the bottom, but human wins gate the top**, exactly the pattern every mature ladder converges on.
- **Optional soft reset**: a light seasonal pull-back (EA FC Mobile style, e.g. -1 tier or -15% trophies at season boundary, floored) only if/when a seasonal content cadence is added later — not needed for v1.
