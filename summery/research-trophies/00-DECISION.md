# 🏆 TROPHIES + SKILL PROGRESSION — synthesis & proposed spec

> **Read this file first.** `01`–`05` are the raw research (5 parallel agents, ~1200 lines, sourced).
> Status: **RESEARCH + PROPOSAL ONLY — nothing implemented yet.** Needs the user's sign-off on the
> numbers before any code changes. Date: 2026-07-25.
>
> User's ask: *"I want trophies instead [of XP]. New mechanism to progress player skills. How much
> from losing, from winning, from bots-only game etc. Do full research."*

---

## 1. What the research says in one line

**Every** game we looked at that has a losable ladder ALSO runs a monotonic track next to it —
Brawl Stars (Trophies + Mastery), Rocket League (MMR + Season Level), Fortnite (Ranked + Pass XP),
Overwatch 2 (Rank + Competitive Points), Clash Royale (Trophy Road + Path of Legends).
Nobody ships losable-only. The two tracks do different jobs:

| Track | Job | Can go down? |
|---|---|---|
| Trophies | tension, status, "am I good" | **yes** |
| XP / mastery | guaranteed progress, anti-rage-quit, unlocks | no |

**So: trophies become the headline number the player sees and talks about; XP survives underneath**
as the quiet track that pays out every single match. That is "trophies instead" for everything the
player looks at, without throwing away the shipped `computeMatchXp` pipeline or the anti-rage-quit
payout for losers. All 5 agents converged here independently.

## 2. Where the agents DISAGREED — the one real decision

**Do bot matches pay trophies?** This is the whole ballgame for us, because in this game **most
matches are bot-filled** (solo + bots, training, half-full 2v2).

- Agent 4 (economy): **zero trophies from bots, ever.** No shipped game pays a real skill rank for a
  disclosed bot win. Extra risk here: `botLevelFromXp` scales bots to your level, so a farm loop is trivial.
- Agents 1 & 2 (Brawl Stars / other games): **reduced but non-zero** — Brawl Stars does pay trophies
  in bot-filled matches below ~100 trophies and disables bots above 2000.

Zero-from-bots is correct for a big game. Here it would mean **most of our players never move the
headline number at all** — the new system would feel more dead than the XP bar it replaced.

### → Proposed resolution: the **BOT CEILING** (bots carry you up to a level, then stop)

A bot of known fixed skill is a legitimate rating anchor (agent 4's chess-engine-Elo finding). We
already have 12 fixed bot skill levels in [`shared/difficulty.js`](../../shared/difficulty.js). So:

- Every bot difficulty level **L** (0–11) has a trophy **ceiling**: `ceiling(L) = 60 + 80 * L`
  → L0 = 60 · L5 = 460 · L8 = 700 · L11 = **940**.
- **Below your bot's ceiling**: a bot match pays trophies at **40%** rate (win and loss both softened).
- **At/above the ceiling**: bot matches pay **0 trophies** (they still pay full XP + stats).
  UI says *"העלה את רמת הקושי כדי להמשיך לעלות"* — raise the difficulty to keep climbing.
- **Hard cap: bots can never take you past 940.** The last stretch (Champion/Legend) is humans only —
  consistent with the anti-farm gates already live (`platinum+ needs 25 human wins`,
  `champion+ needs winsVsHuman >= winsVsBot` in `football-xp.js`).

Why this is the right answer for us: solo players get a real ladder, the *difficulty picker becomes
the progression* (you must beat harder bots to climb — that's a skill gate, not a grind gate), farming
is self-limiting because the ceiling is fixed per difficulty, and the top of the ladder still means
"beat humans."

## 3. Proposed trophy numbers

**Human matches** (all-human roster = full rate; mixed roster scales by the existing `xpFactor`
0.2–1.0 already computed in `public/client.js` `postMatchResult` ~L489):

| Trophies | Win | Loss | Draw |
|---|---|---|---|
| 0–199 | **+30** | **0** (protected) | +10 |
| 200–499 | +28 | −4 | +8 |
| 500–999 | +25 | −8 | +8 |
| 1000–1499 | +20 | −12 | +5 |
| 1500–2499 | +15 | −16 | +4 |
| 2500+ | +10 | −20 | +2 |

- **Crossover ≈1200 trophies** (above it you lose more than you gain) — mirrors Brawl Stars' 1100,
  which is what stops runaway inflation.
- **Bot matches**: the same table × **0.40**, and 0 above the bot ceiling (§2). A win over an L11 bot
  pays real trophies; a win over an L0 bot pays almost nothing and stops paying at 60.
- **No per-goal trophies.** Rocket League's lesson: rating on team result only, or players stat-pad
  instead of playing as a team. Goals keep paying **XP** (`+10/goal` stays) and career stats.
- **Streak**: +2 per consecutive win, max +10. Human wins only.
- **First loss of the day costs 0** (Roblox *Rivals*' "ELO Shield" + Brawl Stars underdog). Cheap,
  removes most of the ranked-anxiety complaints for a teen audience.
- **Tier floors, no relegation out of a tier you reached** (Clash Royale model) — once you hit
  זהב you can never fall below זהב. This is the single biggest anti-anxiety lever.
- **Draw** pays small-positive, never negative.
- **Leaver/AFK**: forfeit = full loss delta, no first-loss protection. (Not urgent at our scale.)

**Anti-farm caps** (sized for hundreds of users):
- Bot-match trophies capped at **+150/day**.
- **Same opponent pair, 3rd+ meeting in a day pays 0 trophies** — the direct defense against two
  friends win-trading on alt accounts. (Agent 4; this is our most likely real exploit.)
- Trophies are computed **server-side only** from trusted fields, exactly like XP is today. Never trust
  a client-sent trophy number.

**Seasons**: a monthly reset needs a population we don't have. Proposal: **no seasons at launch.**
Revisit at ~1000 active players; if added, quarterly and only above 900 trophies (Brawl Stars' post-2024
"reset to the crossover" shape), converting the clipped amount into an app currency.

## 4. Proposed skill-progression mechanism (the "new mechanism")

The clear research winner (agent 3) is **horizontal** progression — unlock *new techniques*, never
higher stats. Vertical stat progression (Brawl Stars Power 1–11 = +100% HP/damage at max) is exactly
what gets called pay-to-win, and we already have a vertical axis in the **card powers** from the
parent Saltiz app. Stacking a second one would be a mess.

### → **מסלול אימון — the Training Path** (recommended)

Turn the existing training mode ([`shared/training.js`](../../shared/training.js), keeper + 4 enemies)
into graded **drills** with bronze/silver/gold medals. Medals unlock **techniques** — new things you
*can do*, all requiring real input skill to actually pull off, none of them a stat buff:

| Technique | What it adds | Drill that teaches it |
|---|---|---|
| **פיינט** feint-cancel | release a charged kick without firing → sell a shot | charge/cancel timing drill |
| **בננה** curved shot | curve the ball around a defender/wall | bend-around-the-wall drill |
| **בישול פצצה** bomb-cook | hold the bomb longer for a bigger blast radius | timed-detonation drill |
| **דילוג קיר** wall-vault | hop your own wall instead of going around | wall-course drill |
| **חטיפה מדויקת** precise strip | wider strip timing window on a perfect read | 1v1 strip drill |

Why it fits: earned by **execution**, not by grinding or paying · horizontal (options, not power) so it
can't pay-to-win against the card system · gives the training mode a reason to exist · it's the only
mechanism that literally makes the *player* better rather than the avatar · pays XP but **0 trophies**
(so it's not a trophy farm).

Runner-up: per-hero **Mastery** (monotonic, pays on losses, status-only pins/badges) — cheap to ship,
good for retention, zero balance risk. Rejected: any stat-scaling "power level" system.

## 5. Naming + UX (Hebrew / RTL)

- **גביעים** = trophies (headline number, trophy icon) · **דרגה** = tier · reuse the existing
  bronze→legend ladder (`TIERS` in `football-xp.js`) with Hebrew names, same icon+word convention as
  the card rarities already in `client.js` (`HUB_RANKS` ~L841).
- **A losing post-match screen must never be all-negative.** Show `−8 גביעים` next to the still-positive
  `+30 XP` and the drill/mastery progress. The existing `playXpReveal` animation hard-guards against
  downward deltas — it needs a new "trophies drop" state (count down, dimmed, no confetti).
- Note the RTL trap: a `−` sign on a number in an RTL run renders on the wrong side unless the number
  is wrapped in an LTR isolate.

## 6. What would change (3 repos, all additive)

Every change is **additive and gated on the new field existing**, so an old TestFlight build silently
keeps showing XP-only and nothing breaks.

- **`pikme-server`** — `data/football-xp.js`: new `computeMatchTrophies({result, trophies, xpFactor, botLevel, isBotMatch, streak, firstLossToday, opponentMeetings})`; `data/footballstats.js`: `trophies`, `trophiesPeak`, `tierFloor`, daily counters, recent-opponent list; `routes-pikme/user.js` `/football/record-match` + `/football/stats`.
- **`football-mock`** — `public/client.js`: read `window.SALTIZ_TROPHIES`, trophy bar + tier badge in the hub, post-match trophy reveal (incl. the down state), the "raise difficulty" nudge at the bot ceiling; `shared/difficulty.js`: the `ceiling(L)` table; new `shared/techniques.js` + `shared/training.js` drills + `shared/sim.js` hook points + `shared/wire.js` + `docs/MECHANICS.md`.
- **`pikmeTV-saltiz`** — inject `window.SALTIZ_TROPHIES`, forward the new `matchResult` fields. Ships only in a new TestFlight build.

**Migration for live users**: never zero anyone. Seed `trophies` from current XP/tier so people log in
already holding roughly the rank they earned, set `tierFloor` to that tier, and give Diamond+ players a
one-off founding badge. Announce it — the loudest backlash in every case we found (Overwatch 1→2 SR
removal, Fortnite Arena→Ranked) was about a silent swap that felt like erasure, not about the new math.

## 7. Open questions for the user

1. **Bot ceiling numbers** — is `940` the right "bots can't take you past here" line, and is 40% the right bot rate?
2. **Tier floors**: never relegate out of a reached tier (forgiving, recommended) vs. real demotion (sharper)?
3. Keep the XP bar **visible** as a second bar, or hide it and surface only trophies + the training path?
4. Ship trophies and the training path **together**, or trophies first?

---

### Sources
`01-brawl-stars.md` · `02-other-games.md` (Fortnite, Rocket League, Roblox, Clash Royale, eFootball/FC Mobile)
· `03-skill-progression.md` · `04-economy-bots-math.md` (Elo/Glicko-2/TrueSkill, bot-anchor, farm exploits)
· `05-psychology-migration-fit.md` (loss aversion, ranked anxiety, migration cases, RTL UX)
