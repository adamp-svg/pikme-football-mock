# Research Agent 3 — Skill/Ability Progression Mechanisms (not XP → bot difficulty)

Scope: design patterns from live games for progressing *player ability*, separate from trophy/rank progression (that's agents 1/2/4/5's job). Ground truth read: `docs/MECHANICS.md`, `shared/constants.js`, `shared/difficulty.js`, `shared/training.js`, `docs/superpowers/specs/2026-07-21-card-powers-design.md`.

---

## 1. Brawl Stars — the maximalist vertical-power model

Power Level 1→11, unlocked via Power Points + coins spent per Brawler (grind or pay).

| Level | Unlock |
|---|---|
| 1–11 | +10%/level to HP and damage — **linear stat scaling**, level 11 = **+100%** over level 1 |
| 7 | first **Gadget** (situational active, limited uses/match) |
| 8 | first **Gear** (stat-boosting passive) |
| 9 | **Star Power** (always-on passive buff/rework, e.g. Colt's "Slick Boots" = +movement speed) |
| 10 | second Gear slot |
| 11 | **Hypercharge** — boosts all 3 stats further + juices the Ultimate |

So a maxed Brawler is **2x raw stats** plus 2 Gadgets + 2 Gears + a Star Power + a Hypercharge over a fresh copy of the same Brawler — a very large power delta, openly vertical (pay-accelerated: Hypercharges are sold).

**Fairness reconciliation:** none, structurally — Supercell's answer is trophy-based matchmaking (weak correlation with Power Level) plus, more recently, **gating Ranked behind "12 Brawlers at Power 11."** This drew heavy backlash: it punishes F2P/casual players for a grind/pay wall unrelated to skill, and community sentiment (Trustpilot, r/BrawlStars, zleague) is that matchmaking pits under-leveled players against P11 lineups, that Hypercharges are explicitly sold as pay-to-win, and that progression "feels punishing" without spend. This is the cautionary tail-end of vertical ability progression: it works as a monetization/retention engine but actively damages perceived fairness in a **skill-based competitive PvP** context — exactly our genre.

Sources: [How to upgrade your Brawl Stars characters](https://play.google.com/store/apps/editorial?id=mc_games__editorial_evergreen__postinstall__how_to_upgrade_your_characters__brawl_stars__fcp), [PlayAware power system guide](https://playaware.in/guides/brawl-stars-power-system), [zleague: 12 Brawlers at Level 11 ranked requirement](https://www.zleague.gg/theportal/brawl-stars-ranked-pass-12-level-11-brawler-requirement-ruffles-feathers/), [zleague: Is Brawl Stars Pay-to-Win?](https://www.zleague.gg/theportal/brawl-stars-the-controversial-pay-to-win-offers-and-community-reactions/), [Trustpilot reviews](https://www.trustpilot.com/review/brawlstars.com)

## 2. Rocket League — the deliberate zero-ability-progression counter-example

No character levels, no gear, no stat scaling — **car hitboxes are cosmetic shells, all identical physics.** Psyonix has stated they intentionally avoid "anything new to the game that will separate the audience or force them to pay" — monetization is cosmetics-only (paint, wheels, boosts, the Rocket Pass), and 100% of match-to-match variance is player mechanical skill (aerials, wall reads, flip resets).

**Argument for this in a competitive football game:**
- Trust: a loss always maps to "they outplayed me," never "they had a bigger number." That's the single biggest driver of Rocket League's esports legitimacy and long competitive tail (rank still meaningful 10 years in).
- No matchmaking-fairness problem to solve — MMR alone suffices, no power axis to reconcile.
- No power-creep tax on the dev team (no rebalancing an ever-growing roster of upgrades).

**What it costs them:** retention/dopamine-loop weakness — nothing to "grind toward" except cosmetics and rank, so new/casual players who aren't mechanically improving fast have a thinner hook than a Brawl-Stars-style number-go-up loop; Psyonix compensates entirely via content cadence (Rocket Pass seasons, cars, esports spectacle) rather than player-power drip-feed.

Sources: [Gamingbolt Psyonix interview](https://gamingbolt.com/an-interview-with-psyonix-the-makers-of-rocket-league-the-defining-indie-game-of-this-console-generation), [Rocket League Titles/Season Rewards](https://www.epicgames.com/help/c-202300000001622/c-202300000001682/what-are-rocket-league-titles-and-how-do-i-get-them-a202300000013269)

## 3. Fortnite — loadout-in-match, progression-out-of-match

Battle Royale: zero persistent ability progression. Every "loadout" (weapon rarity, shields, mats) resets to zero at the start of each match and is rebuilt from map loot — so skill expression is entirely about looting/positioning/building/aim *within* the match, and meta-progression is 100% cosmetic (skins, emotes) via the Battle Pass, which since 2024 unifies XP across BR/LEGO/Festival/OG passes so players can progress any pass by playing any mode.

**Contrast — LEGO Fortnite / Festival:** these ARE persistent-progression modes (crafting tiers, gear/tool upgrades in LEGO; instrument/song-mastery tracks in Festival) because they're survival-crafting / rhythm genres where gated unlocks are the genre-native reward loop, not a competitive-fairness risk. Fortnite's studio explicitly keeps that progression *out* of the competitive BR mode. This is the key transferable lesson: **whether ability progression belongs in a mode is a function of whether that mode is being judged as fair 1v1 competition or as a solo/co-op power fantasy.**

Sources: [Battle Pass — Fortnite Wiki](https://fortnite.fandom.com/wiki/Battle_Pass), [Progress your Fortnite passes at the same time](https://www.fortnite.com/news/coming-soon-progress-your-fortnite-passes-by-playing-any-experience?lang=en-US), [LEGO Fortnite Pass guide](https://www.zleague.gg/theportal/aid-lego-fortnite-battle-pass-and-new-cosmetics-revealed-in-latest-update/)

## 4. Mastery/proficiency tracks — sorted by what they actually grant

| System | Grants | Type |
|---|---|---|
| Brawl Stars Mastery (per-Brawler XP from play) | pins, sprays, profile flex; NOT power | **Status** |
| League of Legends Champion Mastery (M1–M7+) | loading-screen banner, crest, emote, chat bragging | **Status** (explicitly confirmed zero gameplay power) |
| CoD Mobile weapon level + Gunsmith | new attachment slots (optics, grips, barrels — 50+ mods, 5 equippable/loadout) | **Options** (attachments are trade-offs — recoil vs mobility — not flat upgrades, though a fully-decked gun does out-perform a stock one) |
| Rocket League Titles/rank rewards | text banner shown on scoreboard/goal replay | **Status** |
| NBA 2K Badges (Bronze→HoF, Tier 1/2) | flat stat/ability boosts on your MyPLAYER | **Power** (explicitly tiered — Tier 1 badges are "the most powerful... but more difficult to progress") |

Sources: [Champion Mastery — LoL Wiki](https://leagueoflegends.fandom.com/wiki/Champion_Mastery), [CoD Mobile Gunsmith — Activision blog](https://blog.activision.com/au/en/call-of-duty/2020-08/Call-of-Duty-Mobile-Gunsmith), [Dexerto: NBA 2K25 badges](https://www.dexerto.com/nba-2k/all-badges-in-nba-2k25-full-list-how-progression-works-2856379/), [Rocket League Title item](https://rocketleague.fandom.com/wiki/Title)

## 5. Skill-expression progression — new *moves*, not bigger numbers (the pattern most worth stealing)

- **FIFA/EA FC skill-moves star rating (1★–5★, fixed per real player, not earned):** a 1★ player can only nutmeg/juggle; a 5★ can pull off every trick in the game including Roulette, Heel Flick, Stutter Feint. This is a **horizontal unlock gated by identity/rarity, not grind** — the ceiling of technique is a character trait, and it reads as skill expression because pulling off a 5★ move still requires player input timing.
- **NBA 2K Badges:** same "new move unlocked" flavor but delivered as stat multipliers (Tier system above) — power-flavored, not pure-options.
- **Blade Ball (Roblox):** abilities acquired via a gacha "spin" wheel (32 purchasable + 28 limited abilities), each with **2 purchasable upgrade tiers**. This is unlock-via-gacha-luck/spend, closer to loot-box power-gating than skill mastery — flagged below as the anti-pattern to avoid.
- **Rocket League training packs:** community-authored shot/save/aerial drills, freeform navigable (no forced order since a UX overhaul), progress persists per-pack. This is a **pure practice loop** — it builds real mechanical skill (muscle memory) but pays out **nothing** in-game; the only reward is the player getting better, which the game doesn't track or credential.

Sources: [FC 26 skill moves guide](https://www.gamesradar.com/games/ea-sports-fc/fc-26-skill-moves-guide/), [FC24 skill moves star ratings](https://www.mmoexp.com/News/fc-24-skill-moves-star-ratings-explained.html), [Blade Ball Abilities Wiki](https://bladeball.fandom.com/wiki/Abilities), [Blade Ball ability tier list](https://progameguides.com/roblox/blade-ball-abilities-tier-list-all-skills-ranked/), [Custom Training — RL Wiki](https://rocketleague.fandom.com/wiki/Custom_Training), [RL Season 7 custom training changes](https://www.rocketleague.com/en/news/season-7-changes-coming-to-custom-training)

## 6. The pay-to-win trap + known mitigations

**What makes ability progression feel bad:**
- Power creep (each new tier obsoletes the last; Brawl Stars now has 6 layered systems: level, Gadget, Gear×2, Star Power, Hypercharge — compounding).
- Matchmaking mismatch — trophies/MMR don't track power level 1:1, so a low-power account can face a maxed one (the core Brawl Stars complaint).
- Gacha stat-gating — power tied to pull-luck (Blade Ball's ability wheel) rather than effort or skill, which reads as most unfair since money buys spins.
- Grind-gating competitive modes (Brawl Stars' Power-11-to-enter-Ranked rule) punishes new players for time/spend, not skill.

**Known mitigations:**
- **Power-based matchmaking as a separate axis from rank/trophies** — e.g. Golf Battle reportedly keeps matchmaking skill-based and independent of trophies so trophies stay a display/progression metric, not a fairness lever ([Trophy Road & Badges Player Guide](https://support.miniclip.com/hc/en-us/articles/38889529975825-Trophy-Road-Badges-Player-Guide)).
- **Level-normalized/"even" modes** — cap or ignore upgrade tiers in a ranked/normalized playlist (industry-standard workaround, e.g. Clash Royale "Classic/Ranked" decks with capped card levels — see [Clash Royale Trophy Road rework](https://www.sportskeeda.com/mobile-games/clash-royale-summer-update-2025-game-mode-switcher-trophy-road-rework)).
- **Horizontal-not-vertical unlocks (sidegrades)** — CoD Mobile attachments and FC skill-moves both gate *options*, not flat stat wins, so the design goal is trade-offs not upgrades. Caution from design commentary: true sidegrades are hard to keep balanced — "some are inarguably superior... the ultimate downfall of horizontal progression" ([Massively Overpowered: horizontal progression in MMOs](https://massivelyop.com/2025/04/03/vague-patch-notes-whats-so-hopeless-about-horizontal-progression-in-mmos/)) — i.e. horizontal systems still need constant balance passes, they don't remove the tuning burden, just the raw-number optics.
- **Status-only progression (LoL Mastery, RL Titles)** sidesteps pay-to-win entirely by paying out zero gameplay effect — the safest option when the core loop is already skill-pure (Rocket League's approach), but weaker as a retention hook.

## 7. Turning a practice/training mode into a progression system that pays out

Patterns observed: Rocket League training packs (pure practice, zero payout — the gap we should close), Brawl Stars in-app bot practice (no reward), Fortnite Creative aim/edit courses (community content, some have their own XP but disconnected from BR progression), CoD Mobile "use it to level it" (weapon XP accrues from live matches, not a dedicated drill mode).

**The gap across all of these:** nobody has cleanly closed the loop "practice mode drills → measurable skill token → new *option* unlocked" without it becoming a power/pay lever. That gap is exactly this game's opportunity, because **`shared/training.js` already has a structured, graded target set** (sentry with `easy/normal/hard` skill tiers, `keeper`, `still`, roaming dummy) that could be turned into scored **drills** (e.g. "land N full-charge shots past the keeper," "strip the sentry mid-charge," "land the ultimate bomb combo," "3-wall build in under X seconds") that pay out a *technique token*, not a stat.

---

## RECOMMENDATION FOR SALTIZ FOOTBALL

Ranked, with the winner first.

### 🥇 1. Technique Unlocks via Training Drills — "Moves," not stats (WINNER)
- **What it unlocks:** new *executable techniques* layered onto the existing charge/super/bomb system — e.g. a **feint-cancel** (cancel a charge windup into a quick tap with no tell), a **curved bullet** (aim assist bends a full-charge bullet around a wall corner), a **bomb-cook** (hold a planted bomb's fuse manually instead of the fixed 1.725s), a **wall-vault** (dash-jump a segmented wall while it's still below full HP). Each is a new *input pattern*, not a bigger number — mirrors the FIFA skill-move-star-rating pattern (§5) and CoD Gunsmith trade-off pattern (§4), the two patterns that best avoid Brawl-Stars-style backlash (§1, §6).
- **How it's earned:** graded drills built on the existing `shared/training.js` scaffolding (the `sentry`/`keeper`/`still` roles already have `easy/normal/hard` skill tiers). Add a scoring layer: e.g. "beat keeper 5x on `hard` sentry aim without missing" → bronze/silver/gold medal per drill, mirroring Rocket League's training-pack model (§5/§7) but — unlike Rocket League — **paying out** a technique unlock on gold.
- **Vertical or horizontal:** strictly **horizontal** — each technique is a new option/tool, not a stat multiplier. No `chargeRate`/`speedBuff`/`cdMul`-style scalar; it's a new branch in `sim.js`'s input handling gated by a per-player `unlockedTechniques` set.
- **Avoiding pay-to-win vs. cards:** cards (per `2026-07-21-card-powers-design.md`) already own the *vertical* axis (chargeRate/speedBuff/cdMul scaled by rarity). Keeping technique unlocks purely horizontal means they compose with cards without stacking two power axes — a legendary-card player and a common-card player can both use a feint-cancel equally well; only mechanical execution differs, same as FC's skill moves needing real timing.
- **Interaction with trophies:** technique unlocks are **not** gated by trophies/rank at all (avoids the Brawl-Stars Power-11-gates-Ranked backlash, §1/§6) — gate them purely by drill mastery, so a low-trophy grinder and a high-trophy natural can unlock the same moves at different paces without a fairness complaint either way.
- **Files that would change:** `shared/training.js` (add drill definitions + scoring/medal state), new `shared/techniques.js` (per-player unlock set + the new move logic, e.g. feint-cancel timing window), `shared/sim.js` (hook the new inputs — cancel-charge branch near the existing charge logic at ~sim.js:360, bomb-cook near the bomb plant path, wall-vault near the arena/wall collision code), `shared/wire.js` (serialize `unlockedTechniques`/technique-use bits if they need to cross the wire), client UI (`public/client.js` + `index.html` + `style.css`) for a drills tab + medal display, and a small addition to `docs/MECHANICS.md` documenting each new technique once implemented.

### 🥈 2. Super-Meter Mastery Track (small vertical, tightly capped)
- **What it unlocks:** a mastery ladder *per player account* (not per-card) that very slightly modifies the **existing** super system — e.g. mastery rank 3 shaves the `OVERCHARGE_TTL` decay slightly slower, mastery rank 5 grants a cosmetic-only super-aura recolor. Modeled on NBA 2K Badges (§4/§6) but capped hard (e.g. max +5% total, vs Brawl Stars' 100%) specifically to avoid the outrage pattern in §1.
- **How it's earned:** passive XP from *super mechanics executed correctly* (successful strips, full-charge overcharges landed) — a skill-tracking meta-layer on top of the already-existing `earnPower()`/`p.powerMeter` logic in `sim.js` (per MECHANICS.md §4).
- **Vertical or horizontal:** vertical, but deliberately tiny — a "mastery tax" capped low enough that a fresh player only ever faces a single-digit percentage disadvantage, unlike Brawl Stars' 2x.
- **Avoiding pay-to-win vs cards:** since cards already grant `chargeRate`/`cdMul` up to +25%/-20%, stacking even a small vertical mastery bonus risks compounding two power axes on top of each other — this is the real weakness of this option, and why it's ranked #2, not #1.
- **Interaction with trophies:** should NOT gate ranked play (learn from §1's backlash) — purely additive background progression.
- **Files:** `shared/sim.js` (earnPower hook), `shared/difficulty.js`-adjacent new `shared/mastery.js`, server-side persistence for mastery XP (wherever `member.loadout`/cards persist per the card-powers spec, likely server.js + a DB/store call).

### 🥉 3. Cosmetic-Only Skill Badges (status, safest, weakest hook)
- **What it unlocks:** pure status — a badge/frame/hero-emote shown pre-match (mirrors LoL Champion Mastery and RL Titles, §4/§6) for milestones like "100 strips," "50 wall-cannon kills," "keeper clean-sheet streak."
- **How it's earned:** counters on existing match events already computed by the sim (strips, bomb kills, saves) — cheapest to build, zero balance risk.
- **Vertical or horizontal:** neither — zero gameplay effect, pure status.
- **Avoiding pay-to-win:** trivially, since it grants nothing.
- **Interaction with trophies:** complements a trophy system well as a secondary flex axis, but doesn't answer the brief's "progress player skills" as directly as #1 or #2 — it rewards *volume of play*, not *actual skill growth*, so it's the weakest fit for "a mechanism to progress player skills" and is really a trophy/vanity-system idea (overlaps agents 1/2/4/5's territory) more than a skill-progression one.

**Winner: #1, Technique Unlocks via Training Drills.** It is the only option that (a) turns the already-built `shared/training.js` mode into a payout loop as flagged in §7's identified gap, (b) is strictly horizontal so it cannot compound with the existing card-power vertical axis into a Brawl-Stars-style fairness complaint, and (c) rewards genuine mechanical mastery (drill performance) rather than grind-time or spend, which is the single throughline across every "good" example found (FC skill moves, CoD attachments, Rocket League training) versus every "bad" example (Brawl Stars Power 11, Blade Ball gacha abilities).
