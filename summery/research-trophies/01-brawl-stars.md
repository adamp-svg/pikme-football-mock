# Research Agent 1: Brawl Stars Trophy System (Deep Dive)

Goal: extract hard numbers from Supercell's trophy system to inform a trophy-replaces-XP redesign
for Saltiz Football (2v2 arcade soccer, small playerbase, bot-heavy matchmaking).

---

## 1. Trophy Road / classic trophies — exact deltas

Brawl Stars has run **two different trophy curves**: the original (2017–Oct 2024) and the
**October 2024 "Trophy Season Rework"** (current, as of writing). Both share the core shape:
**the higher you climb, the less you gain on a win and the more you lose on a loss** ("rubber-banding").

### Pre-rework (original system, live 2017 → Oct 29 2024)

Exact tables (per-mode, since Brawl Stars trophies are tracked **per-brawler** and vary by game mode
— Showdown/Duels are "placement" modes, 3v3 modes like Gem Grab are win/loss):

**Solo Showdown** (10-player battle royale placement payout):

| Trophy range | 1st | 2nd | 3rd | 4th | 5th | 6th | 7th | 8th | 9th | 10th |
|---|---|---|---|---|---|---|---|---|---|---|
| 0–49 | +10 | +8 | +7 | +6 | +4 | +2 | +2 | +1 | 0 | 0 |
| 50–199 | +10 | +8 | +7 | +6 | +4 | +2 | +2 | +1 | 0 | –1 |
| 300–399 | +10 | +8 | +7 | +6 | +3 | +2 | +2 | 0 | –1 | –2 |
| 500–599 | +10 | +8 | +6 | +5 | +3 | +1 | 0 | –2 | –3 | –3 |
| 1000–1099 | +10 | +8 | +6 | +4 | +1 | –2 | –2 | –5 | –7 | –8 |
| 2000+ | +3 | 0 | –10 | –20 | –30 | –40 | –50 | –60 | –70 | –80 |

**Duels** (1v1 best-of-N):

| Trophy range | Victory | Defeat |
|---|---|---|
| 0–49 | +9 | –1 |
| 50–599 | +9 | –3 |
| 600–899 | +9 | –6 |
| 900–1099 | +9 | –9 |
| 2000+ | +3 | –51 |

**3v3 team modes (Gem Grab, Brawl Ball, etc.)** — this is the closest analogue to Saltiz's 2v2 —
followed the same asymmetric-curve principle; community-maintained trophy tables (e.g.
brawlinsights.com's Trophy Change tool) show wins starting around **+8** at low trophies, tapering
toward **+2–3** near 1000+, while losses start near **–2** and climb to **–8/–9** by 900-1099, matching
the Duels numbers above (source access for the exact live table was blocked — 403 — but the shape is
independently confirmed by multiple guides: "up to +8 per win... losses cut deeper as trophies climb,
eventually matching or exceeding what a win gives you").

Source: [Trophies | Brawl Stars Wiki](https://brawlstars.fandom.com/wiki/Trophies), [theriagames.com trophy guide](https://theriagames.com/guide/brawl-stars-trophies/), [Brawl Stars Trophy Ranks Explained (brawl.tube)](https://brawl.tube/brawl-stars-trophy-ranks-explained-bronze-to-masters/)

### Post-rework (current system, since Oct 29 2024)

- 50 total tiers; a new tier roughly every **20 trophies**.
- Below **1100 trophies**: curve is deliberately flattened/"more forgiving" — win gain still exceeds loss.
- At **1100 trophies**: gain and loss cross over — this is the stated crossover point ("you'll only
  start losing more trophies than you win after 1100 trophies").
- 3v3/5v5 modes: **up to +8 per win** below ~1099, dropping to **+7 per win** at 1100+; losses climb
  to match/exceed wins beyond that point.
- Max tier is fixed at exactly **1000 trophies**; trophies earned 1000+ become "Season Trophies" that
  fill a **Trophy Box** (5 levels: Small → Big → Mega → Omega → Ultra) instead of pure number-go-up.
- **Win Streaks**: after 2 consecutive wins on one brawler, streak bonus adds up to **+5** extra
  trophies per win; a loss resets the streak. Disabled above 2000 trophies.
- **Underdog System** (3v3 only, below 1000 trophies): if matched against opponents with much higher
  trophies, wins grant a bonus (**up to +4** extra), and **losses cost zero trophies and do not reset
  the win streak**. Removed entirely at 1000+ where matchmaking becomes one flat pool.

Sources: [Supercell: Trophy Season Rework is Coming!](https://supercell.com/en/games/brawlstars/blog/news/trophy-season-rework-is-coming/), [Brawl Stars October 2024 update (Sportskeeda)](https://www.sportskeeda.com/mobile-games/brawl-stars-october-2024-update-trophy-system-overhauled-new-trophy-box), [Brawl Stars ranks explained (ExitLag)](https://www.exitlag.com/blog/brawl-stars-ranks/)

---

## 2. Loss protection

| Rule | Detail |
|---|---|
| Hard floor | A player **cannot drop below 1000 trophies** from a loss once they're at/above 1000 — a loss at exactly 1000 does nothing further; you can only fall below 1000 by literally starting there, never get pushed under it by a defeat once past it. |
| Low-trophy forgiveness | Below ~1100, wins always net more than losses cost — no explicit "zero-loss" floor at low ranges other than Underdog (below). |
| Underdog "first-loss"-style forgiveness | When facing stronger opponents pre-1000 trophies, a loss costs **0 trophies** and does not break your win streak. This is the closest thing to "forgiveness," and it's conditional on being outmatched, not a blanket new-player grace period. |
| Bot/tutorial ranges | Matches below 100 trophies are overwhelmingly bot-filled (see §6) — de facto protection since bots are easy wins. |

Source: [Disable Trophy Loss meaning (onlyfarms.gg)](https://onlyfarms.gg/wiki/brawl-stars/disable-trophy-loss-meaning), [Trophy Season Rework (Supercell)](https://supercell.com/en/games/brawlstars/blog/news/trophy-season-rework-is-coming/), [What is Underdog Status (Sportskeeda)](https://www.sportskeeda.com/esports/what-underdog-status-brawl-stars)

---

## 3. Trophy reset / seasons

### Old system (pre-Oct 2024)
- Monthly reset tied to the "Trophy Season."
- Threshold: **550 trophies**. Anything above 550 got clipped: you lost **25 trophies for every
  increment above the 550 threshold** (the classic formula was roughly losing trophies down toward
  550 in steps, refunded as currency — sources agree on the shape, exact step formula varies by
  brawler count/version).
- Compensation: lost trophies converted 1:1 into **Star Points**, a currency spent in the Star Shop
  on cosmetics/pins — so trophy loss was never "wasted," just converted to a different currency.

### Current system (since Oct 2024 rework)
- Reset threshold moved way up: **anyone above 1000 trophies resets to exactly 1000** at each monthly
  season boundary (aligned with the Brawl Pass season cadence).
- **No reset at all below 1000 trophies** — casual/low-trophy accounts are entirely unaffected.
- Trophies earned 1000+ within a season fill the **Trophy Box** (cosmetic/reward container, 5 tiers)
  which is what actually gets "banked" — the season-end reset only touches the raw trophy number, not
  the box rewards already claimed.
- Stated reasons (Supercell's own words): the old system was "unnecessarily complex and not fun,"
  gave poor rewards for high-trophy grinding, discouraged players from using their favorite brawler
  once it got hard to push, and caused excessive matchmaking wait times at the high end.

Sources: [Trophy Season Rework is Coming! (Supercell)](https://supercell.com/en/games/brawlstars/blog/news/trophy-season-rework-is-coming/), [Brawl Stars Season End Trophy Reset (Mobile Mode Gaming)](https://mobilemodegaming.com/2020/08/07/brawl-stars-season-end-trophy-reset-system-explained/), [Brawl Stars new Trophy System explained (Sportskeeda)](https://sportskeeda.com/mobile-games/brawl-stars-new-trophy-system-explained)

---

## 4. Ranked (formerly Power League)

Renamed **Ranked** in the Feb 2024 update, replacing Power League. Runs as a **fully separate ladder
from Trophies**, own seasonal reset, own rewards.

| Aspect | Detail |
|---|---|
| Tiers | 8 named tiers (Bronze, Silver, Gold, Diamond, Mythic, Legendary, Masters, **Pro**), most split into I/II/III (~22 total ranks) |
| Points needed per tier | Bronze/Silver/Gold: **250 RP** per sub-tier. Legendary: **750 RP**. Masters: **1000 RP** per sub-tier. Pro starts at **~11,250+ RP** and represents the top slice of the ladder. |
| Points per win/loss | **Not fixed** — Elo-style: gain/loss size scales with the strength differential between your team and the opponent (beat a stronger team → bigger gain & smaller loss-risk next time; "Underdog Win" scenarios grant outsized RP). Community guides could not surface a flat "+20/–20" number because Supercell intentionally made it dynamic/hidden-MMR based. |
| Format gating | Bronze→Gold: single game, no drafting/bans. Diamond+: best-of-3, pick/ban drafting phase. Roster gates scale up (3 Brawlers @ Power 9 for Bronze–Gold, up to 12 @ Power 11 for Mythic+). |
| Season reset | Resets every season (aligned to Brawl Pass cadence, ~monthly); players are pushed back toward a rank tied to their prior peak (soft reset with placement-style matches), not a full wipe. |
| Why two ladders | Trophies = long-run **progression/collection** metric, farmable via volume of play (grinding, casual wins, bot-adjacent low ranks) and tied to cosmetic/box rewards. Ranked = a **skill-rating** ladder meant to reflect actual competitive standing, with strict anti-boosting gates (roster/power requirements, draft/bans) that Trophies never had. Supercell keeps them separate so casual grinders can feel constant number-go-up progress on Trophies while competitive players have a "real" ladder that isn't diluted by bot-stomping or one-trick-brawler farming. |

Sources: [Ranked | Brawl Stars Wiki](https://brawlstars.fandom.com/wiki/Ranked), [Brawl Stars Ranking System Explained (1v9.gg)](https://1v9.gg/blog/brawl-stars-ranking-system-explained-complete-guide), [Brawl Stars ranks explained (ExitLag)](https://www.exitlag.com/blog/brawl-stars-ranks/)

---

## 5. Mastery (per-brawler track)

- Added on top of Trophies as a **per-brawler**, **never-decreasing** mastery score — separate from
  trophies, meant to reward *time invested in one brawler* regardless of trophy pushing success.
- Earned from: playing Trophy matches and Ranked matches with that brawler; **Star Player** bonus
  (+20% Mastery Points that match); higher trophy count / rank tier increases points-per-match (Master
  rank = ceiling); event multipliers (monthly special events give 50%–200% boosts); some modes
  (Mega Pig, Trophy Events, Ranked) grant extra.
- **Does it pay on a loss?** Yes — unlike trophies, Mastery is a participation/investment metric, not
  a win/loss delta system, so playing (even losing) still accrues *some* mastery points, just less
  than a win. This is the key structural difference from Trophies: Mastery is monotonic (XP-like),
  Trophies are a zero-sum ladder.
- Rewards: Coins, Power Points, Credits, cosmetic pins/icons, Titles — cosmetic/currency, not raw
  power.
- **Why it exists alongside trophies**: trophies alone created "sunk cost" pain (can't touch your
  favorite brawler once pushed high, losing feels bad, no reward for grinding a brawler you're not
  good enough to push). Mastery gives players a **safe, monotonic, never-goes-down** channel that
  still rewards playing a brawler a lot, in parallel with the volatile trophy ladder. Notably this is
  structurally identical to what a monotonic XP system already gives — Supercell run trophies AND an
  XP-like system side by side, not instead of one another.
- **Deprecation note**: Masteries were removed on **June 24, 2025** and replaced by a system called
  "Records" — reinforcing that even Supercell iterates hard on the non-competitive-progression layer;
  the trophy ladder itself has been comparatively stable in *concept* (though not in exact numbers).

Sources: [Mastery | Brawl Stars Wiki](https://brawlstars.fandom.com/wiki/Mastery), [How To Get Mastery Points (1v9.gg)](https://1v9.gg/blog/brawl-stars-how-to-get-mastery-points), [Mastery Points explained (onlyfarms.gg)](https://onlyfarms.gg/wiki/brawl-stars/mastery-points-explained)

---

## 6. Bots

- **Yes, trophies ARE awarded/lost against bots** — bots are not walled off from the trophy economy;
  they're simply the default opponent at very low trophy counts.
- Roughly **0–100 trophies**: matches are "mostly bots," explicitly designed as a stress-free onboarding
  ramp for a new/low-power brawler.
- **After "Prestige 2" (2000 trophies)**: bot matches are disabled outright — high trophies are
  presumed to mean a real, skilled human, so bots no longer fill lobbies.
- Players have found (community-documented, not officially sanctioned) that bots can be re-triggered
  at higher trophies via specific loss-streak sequences in other modes (e.g., 3 straight Free-Play
  losses) — treated as an exploit/grey area, not an intended late-game mechanic, and it does NOT work
  in Ranked.
- **Ranked** never contains bots — the roster/power gates plus draft phase are explicitly there to
  keep bot-proxying and smurfing out of the skill ladder, reinforcing the "Trophies = progression
  (bots ok), Ranked = skill (bots never)" split.

Sources: [Trophies | Brawl Stars Wiki](https://brawlstars.fandom.com/wiki/Trophies), [Vortex Gaming: trending overseas tips below 2000 trophies](https://vortexgaming.io/en/postdetail/687931), community forum threads on brawlstars.fandom.com.

---

## 7. Why it works — retention psychology & criticisms

**Mechanisms (community/behavioral-analysis writeups, not an official Supercell GDC talk — none found
specifically on Brawl Stars trophies; Supercell's public GDC talks are about Clash of Clans/Clash
Royale monetization & live-ops, cited below for the same design family):**

- **Loss aversion / sunk-cost re-engagement**: after a trophy loss, players feel an itch to "win it
  back" — the exact number they just lost becomes a mini-goal, which is a stronger pull than an
  abstract "get more XP" ask. ([A Brawl for the Mind — Medium/UCSD Cognitive NeuroEconomics](https://medium.com/cognitive-neuroeconomics/a-brawl-for-the-mind-how-brawl-stars-entraps-you-7062f069ca57))
- **Variable-ratio reward schedule**: match outcomes (and their trophy deltas) are not perfectly
  predictable session to session, which is the schedule most resistant to extinction in operant
  conditioning terms — this is what keeps a "just one more match" loop going, distinct from monotonic
  XP where every session is guaranteed forward progress and thus less urgent to repeat.
- **Rubber-banding as the tension engine**: Clash Royale's own postmortems (same studio, same design
  lineage as Brawl Stars trophies) describe the arena/trophy system explicitly creating a
  "rubber-band" where competition scales up until the player is forced to lose trophies again — this
  flattening of net progress is what times a player's frustration to peak right when a monetized
  "catch-up" purchase is most tempting. ([Deconstructing Clash Royale — Game Developer](https://www.gamedeveloper.com/business/deconstructing-clash-royale))
- **Why loss isn't perceived as purely punishing**: because the *asymmetry favors the player* at
  low-mid trophies (win > lose in magnitude) and because Underdog/streak/bot-onboarding softens the
  early game, most players' lived experience is "trophies go up over time with occasional setbacks,"
  not "a ladder that actively fights me" — the felt experience is closer to XP-with-static, i.e. you
  rarely feel like you're truly regressing until deep into high-skill brackets where players
  self-select into wanting a harder ladder (that's Ranked's whole audience).

**Documented criticisms:**
- **Trophy inflation / grind**: at the high end, trophy counts on top accounts have crept absurdly
  high over the years (community discussion of trophy inflation across the game's lifetime), making
  "trophies" a weaker signal of skill than raw account age/time invested — part of why Supercell
  ultimately capped Trophy Road at 1000 and moved skill-signaling to the separate Ranked ladder.
- **Brawler-count / roster grind**: because trophies are tracked per-brawler and pushing a brawler
  gets harder as trophies rise, whales who own/upgrade more brawlers have a structural progression
  advantage — a common community complaint that the ladder rewards account investment (pay/grind for
  more brawlers) as much as skill. ([NamuWiki: Brawl Stars Problems and Criticism](https://en.namu.wiki/w/%EB%B8%8C%EB%A1%A4%EC%8A%A4%ED%83%80%EC%A6%88/%EB%AC%B8%EC%A0%9C%EC%A0%90%20%EB%B0%8F%20%EB%B9%84%ED%8C%90))
- **Supercell's own admitted problems** (their words, from the rework announcement): the pre-2024
  system was "unnecessarily complex and not fun," gave bad rewards, discouraged using favorite
  brawlers once pushed high, and created long matchmaking waits at the top — i.e., even Supercell
  concluded raw win/loss trophy ladders eventually become a retention *liability* without a reward
  and reset layer wrapped around them.

Sources: [A Brawl for the Mind (Medium)](https://medium.com/cognitive-neuroeconomics/a-brawl-for-the-mind-how-brawl-stars-entraps-you-7062f069ca57), [Deconstructing Clash Royale (Game Developer)](https://www.gamedeveloper.com/business/deconstructing-clash-royale), [Trophy Season Rework is Coming! (Supercell)](https://supercell.com/en/games/brawlstars/blog/news/trophy-season-rework-is-coming/), [NamuWiki criticism page](https://en.namu.wiki/w/%EB%B8%8C%EB%A1%A4%EC%8A%A4%ED%83%80%EC%A6%88/%EB%AC%B8%EC%A0%9C%EC%A0%90%20%EB%B0%8F%20%EB%B9%84%ED%8C%90)

---

## RECOMMENDATION FOR SALTIZ FOOTBALL

Context constraints that should override a literal Brawl Stars copy: **hundreds of players, not
millions**, and (per `football-xp.js`) **bots fill most matches** (xpFactor 0.2 for all-bot up to 1.0
all-human) with 2v2/1v1/training formats and existing anti-bot-farm gates (winsVsHuman ≥ 25 for
Platinum+, winsVsHuman ≥ winsVsBot for Champion+). A literal Elo-with-deep-loss-penalty system would be
too volatile and too punishing for a small, casual, teen audience where most matches are against bots
by construction (empty slots always get filled) — losing trophies to a bot-heavy match would feel
arbitrary and unfair. The design below keeps Brawl Stars' proven psychological hooks (loss aversion,
rubber-banding, protected low ranks) while dialing severity down for the smaller/younger/bot-heavy
population, and reuses the existing `xpFactor`/tier-gate plumbing instead of inventing new axes.

### 1. Trophy delta per result, per rank band (replaces the flat 100/50/30 XP)

| Rank band (trophies) | Win (vs human) | Win (vs bot only) | Draw | Loss (vs human) | Loss (vs bot only) |
|---|---|---|---|---|---|
| 0–199 (Bronze, onboarding) | +8 | +5 | +3 | 0 | 0 |
| 200–499 (Silver) | +7 | +3 | +2 | –1 | 0 |
| 500–899 (Gold) | +6 | +2 | +1 | –3 | 0 |
| 900–1199 (Platinum) | +5 | +1 | +1 | –4 | –1 |
| 1200–1599 (Diamond) | +4 | +1 | 0 | –5 | –2 |
| 1600–1999 (Champion) | +3 | 0 | 0 | –5 | –2 |
| 2000+ (Legend) | +2 | 0 | 0 | –6 | –3 |

- Bot-only wins pay a small but non-zero amount only below Platinum (mirrors Brawl Stars 0–100
  onboarding-by-bots) — this reuses `xpFactor` directly: `trophyDelta = round(bandWinDelta * max(0.2, xpFactor))`
  for wins, keep loss deltas independent of xpFactor (a loss shouldn't get "cheaper" just because bots
  were involved beyond the caps in the table).
- +10 per goal scored (kept from the current XP formula) stays as a small flat trophy kicker on wins
  only, capped at +10 total (2 goals worth) to avoid blowout-farming trophies in a first-to-3 format.
- Keep the existing `+200 first human win of day` and streak bonus (≤50) as **a separate currency**
  (coins/gems, not trophies) — Brawl Stars' own Mastery precedent shows monotonic "investment" rewards
  work best *alongside* a volatile trophy ladder, not blended into it. This also preserves the
  daily-return hook without adding trophy volatility.

### 2. Loss protection floors

- **Hard floor at 0** — never go negative (obviously).
- **No loss below 200 trophies** — full protection in the onboarding band, exactly like Brawl Stars'
  low-trophy asymmetry but made absolute given how small/young this audience is; a brand-new player
  should never see trophies go down in their first sessions.
- **Underdog rule**: if the human's team is bot-heavy (2+ bots) and the opposing team has a materially
  higher average trophy count, a loss costs 0 trophies and a win pays the full human-win rate — directly
  ports Brawl Stars' Underdog mechanic to make bot-fill losses feel fair instead of arbitrary.
- **First loss of the day forgiveness**: the first loss each calendar day costs 0 trophies (regardless
  of band) — a small addition beyond Brawl Stars, justified because a small playerbase can't
  absorb reduced retention from an unlucky first match of the session the way a millions-strong
  playerbase can.

### 3. Bot-only match payout — how much and why

- Bot-only matches (all 4 slots bot, i.e., training/solo vs AI) should pay **trophies only below
  Platinum (900)**, at roughly 40-60% of the human-win rate per band (see table), then **zero above
  900** — this matches Brawl Stars' "bots disabled at 2000/high trophy" philosophy scaled down to this
  game's much smaller trophy range, and it protects the tier gates already in `football-xp.js`
  (`winsVsHuman >= 25` for Platinum+, `winsVsHuman >= winsVsBot` for Champion+) from being trivially
  gamed by all-bot farming — keep those exact anti-farm gates, they already do the job Ranked's
  roster/draft gates do in Brawl Stars, just cheaper to build.
- Because bot matches are the **majority of play** here (unlike Brawl Stars where bots are a tiny
  onboarding sliver), do NOT make bot matches worth zero trophies everywhere — that would make trophies
  feel disconnected from most of what players actually do, and tank retention for the bulk of the
  playerbase who mostly play solo/bot-filled matches. Non-zero-but-shrinking bot payout up to Gold/Platinum
  is the balance point.

### 4. Season resets — lighter-touch than Brawl Stars

- Do a **season reset only above 900 trophies (Platinum+)**, resetting down to 900, not a low
  threshold like Brawl Stars' 1000-trophy cutoff relative to a max realistic range — with hundreds of
  players, most of the base will simply never cross into reset territory, which is fine and intentional:
  the reset mechanic should only matter to the small core of engaged repeat players, not create
  season-anxiety for the casual majority.
- Cadence: **quarterly, not monthly** — a small playerbase doesn't generate enough fresh competitive
  tension every 4 weeks to justify a Brawl-Stars-style monthly reset cadence; over-resetting a small
  population risks feeling like punishment with no corresponding sense of a "fresh competitive season."
- Compensation for reset trophies lost: convert 1:1 into a cosmetic/coin currency (mirrors Star
  Points) — reuse whatever soft-currency the app already has (coins/gems) rather than inventing a new
  one.
- **Do not build a separate Ranked/Elo ladder** at this player count — Brawl Stars only sustains two
  ladders because it has enough matches/hour to fill separate MMR pools; with hundreds of players and
  bot-filled lobbies as the norm, a second competitive ladder would either be empty or would fragment
  the tiny human-vs-human matchmaking pool further. Keep ONE trophy ladder; use the existing
  `winsVsHuman`/`winsVsBot` split purely as tier-gates (as today), not as two separate scores.
