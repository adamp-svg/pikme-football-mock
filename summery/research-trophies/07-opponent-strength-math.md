# 07 — Opponent-strength math (asks #5 + #7)

> Seat: the formula. Owner of this file only. Date 2026-07-26. Nothing here is code — no `.js` touched.
> Reads on: `pikme-server/data/football-rank.js`, `data/football-xp.js`, `routes-pikme/user.js` L1237,
> `football-mock/public/client.js` L519, `server.js` L595, `shared/opponent-key.js`, `00-DECISION.md` §7/§8.

---

## CONCLUSION (the whole seat in 9 bullets)

1. **Opponent strength scales RANK only, using opponent `rankPoints`. The trophy (`xp`) track gets NO opponent scaling.** Trophies = volume; putting a skill price on a volume currency is the one thing that breaks the §8 split.
2. **Not trophies-as-input, ever.** Trophies measure hours. `seedRankFromXp` already folded every legacy player's trophy standing into their rank — so **rank already contains the trophy information**, and feeding trophies in again is literally double-counting the same number.
3. **The multiplier depends on the GAP only**, never on absolute rating. The BANDS already price *my own* standing; Elo's other half (the *opponent's* standing) is the only thing missing. Gap-only = no double count.
4. **Elo shape, our own scale: `E = 1/(1+10^(gap/800))`.** D=800, not 400 — our 0..3200 ladder is not probability-calibrated, and D=400 saturates by a 500-point gap, which would make "beat a diamond" and "beat a legend" pay identically.
5. **Multiplier = `1 ± slope · (1−2E)`, four slopes, six clamps.** Win **0.60x .. 1.50x**, loss **0.60x .. 1.25x**, draw **0.50x .. 1.50x**. Practical extremes are 1.49 / 0.61 (asymptotes); the clamps are safety rails, not the working range.
6. **Team aggregate = `mean + 0.5·(max − mean)`, humans only** — in 2v2 that is exactly **`0.75·max + 0.25·min`**. Neither pure mean (under-prices a carry) nor pure max (over-prices a duo of near-equals). This is the *cited* Rocket League rule ("average weighted more towards the highest-ranked player") and the Apex rule ("matchmaking on the highest-ranked squad member") met in the middle.
7. **The gap is measured team-vs-team, not me-vs-opponents.** That single choice kills the carry farm: a bronze duoing with a legend goes from **+39** (if we priced only my own rank) to **+18** per win.
8. **Cold start: fail neutral.** If either side has `< 10` recorded matches, or the field is missing/unsigned, multiplier = **1.00**. No Glicko-2 RD, no TrueSkill sigma — see §7f for why, with numbers.
9. **Bounded:** the worst sustainable case compresses the 197-win climb to legend to **139 wins (−29%)**, and requires a **100% win rate against opponents ≥1000 rank above you for the entire ladder** — opponents who do not exist at this population. With the optional `UPSET_DAILY_CAP = 60` the bound is hard.

**The one thing I need from another seat:** the server **cannot see opponent rank today**. `opponentKey` is a SHA-256 hash (irreversible, by design). This whole feature needs one new signed field on the wire — §8 spells out the minimum, and the security bound if you ship it unsigned.

---

## THE FORMULA

```js
// ── OPPONENT STRENGTH — rank only. Add to data/football-rank.js AND mirror the constants into
//    football-mock/shared/rank.js or test-rank-parity.mjs fails the build. ───────────────────────
const ELO_D                 = 800   // rank points per 10x odds shift. NOT 400 — see §7b.
const PARTY_TILT            = 0.50  // team rating = mean + TILT*(max-mean); 2v2 => 0.75*max + 0.25*min
const WIN_UPSET_SLOPE       = 0.50  // gap > 0: I beat someone above me            -> pays MORE
const WIN_FAVOURITE_SLOPE   = 0.40  // gap < 0: I beat someone below me            -> pays LESS
const LOSS_DISCOUNT_SLOPE   = 0.40  // gap > 0: I lost to someone above me         -> costs LESS
const LOSS_SURCHARGE_SLOPE  = 0.25  // gap < 0: I lost to someone below me         -> costs MORE
const DRAW_SLOPE            = 0.50  // symmetric; draw base is always positive so this can't flip sign
const WIN_MULT_MIN  = 0.60, WIN_MULT_MAX  = 1.50
const LOSS_MULT_MIN = 0.60, LOSS_MULT_MAX = 1.25   // deliberately gentler than the win range (anti-tilt)
const DRAW_MULT_MIN = 0.50, DRAW_MULT_MAX = 1.50
const PROVISIONAL_MATCHES   = 10    // < 10 recorded matches on EITHER side => multiplier is 1.00
const PARTY_SPREAD_MAX      = 600   // my party wider than this => loss surcharge switched off (§7e)
const UPSET_DAILY_CAP       = 60    // rank/day from the ABOVE-BASELINE part of the multiplier (optional)

// Rating of one side. HUMANS ONLY — bots are excluded from both aggregates because the mixed-roster
// discount is ALREADY applied by `rate` (xpFactor 0.47 / 0.73). Don't double-dip the same signal.
// Returns null when the side has no rated humans.
function teamRating(ranks) {                       // ranks: number[] of rankPoints, humans only
  const rs = (ranks || []).map((r) => Math.max(0, Number(r) || 0))
  if (!rs.length) return null
  const mean = rs.reduce((a, x) => a + x, 0) / rs.length
  return Math.round(mean + PARTY_TILT * (Math.max(...rs) - mean))
}

// (1 - 2E) in (-1, +1). Positive = the opponent side is stronger than mine (I am the underdog).
function surprise(gap) {
  const E = 1 / (1 + Math.pow(10, gap / ELO_D))    // E = my modelled win probability
  return 1 - 2 * E
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

// The multiplier. ALWAYS returns exactly 1 when we don't trust the inputs — never 0, never a guess.
function opponentMultiplier({
  result,          // 'win' | 'loss' | 'draw'
  myTeamRank,      // teamRating() of my side, humans only (includes me)  — null => neutral
  oppTeamRank,     // teamRating() of the other side, humans only         — null => neutral
  isBotMatch,      // no human opponent
  provisional,     // true if EITHER side has a player under PROVISIONAL_MATCHES matches
  widePartyMine,   // true if my side's human rank spread > PARTY_SPREAD_MAX
} = {}) {
  if (isBotMatch) return 1                          // see §7-6 OPTION B for the bot-rating variant
  if (provisional) return 1
  if (myTeamRank == null || oppTeamRank == null) return 1
  const s = surprise(oppTeamRank - myTeamRank)
  if (result === 'win') {
    return clamp(1 + (s >= 0 ? WIN_UPSET_SLOPE : WIN_FAVOURITE_SLOPE) * s, WIN_MULT_MIN, WIN_MULT_MAX)
  }
  if (result === 'loss') {
    // Duoing with a much weaker friend must never cost MORE than a solo loss (§7e).
    const hi = widePartyMine ? 1 : LOSS_MULT_MAX
    return clamp(1 - (s >= 0 ? LOSS_DISCOUNT_SLOPE : LOSS_SURCHARGE_SLOPE) * s, LOSS_MULT_MIN, hi)
  }
  return clamp(1 + DRAW_SLOPE * s, DRAW_MULT_MIN, DRAW_MULT_MAX)
}
```

### Where it plugs into the shipped `computeMatchRank`

```js
// ... unchanged: band = bandFor(rankPoints); base = band[result]; firstLossToday -> 0;
//     bot-ceiling gate; OPPONENT_DAILY_LIMIT gate; rate = bot ? BOT_RATE : clamp(xpFactor, 0.4, 1)

const oppMult = opponentMultiplier({ result, myTeamRank, oppTeamRank, isBotMatch, provisional, widePartyMine })

// ONE rounding step. Do NOT scale(scale(base, rate), oppMult) — double rounding drifts
// (25 -> round(12.5)=13 -> round(13*1.31)=17, vs the correct round(25*0.655)=16).
let delta = scale(base, rate * oppMult)

if (delta > 0 && result === 'win' && !bot) delta += streakBonus(streakAfter)   // flat, NEVER scaled

// Optional hard rail on the whole feature (recommended ON at ship; 2 new stored fields
// upsetRankDate / upsetRankToday, mirroring botRankDate / botRankToday).
if (delta > 0 && oppMult > 1) {
  const baseline = scale(base, rate)
  const bonus    = Math.max(0, delta - baseline)
  const left     = Math.max(0, UPSET_DAILY_CAP - Math.max(0, num(upsetRankToday)))
  delta = baseline + Math.min(bonus, left)
}
// ... unchanged: bot daily-cap / to-ceiling clamps; applyRankDelta sticky floor
```

Signature is **additive with defaults** → an old app build that sends nothing gets `oppMult = 1` and the exact numbers shipped today. No migration.

---

## THE 7 ASKS

### 1. Trophies can only go up — CONFIRMED, and my proposal adds nothing that can decrease them

Verified in code: `computeMatchXp` returns `base(30|50|100) + 10*goals`, multiplied by a factor clamped to `[0.5, 1.0]`, plus `+200`. Minimum possible payout = `round(30 * 0.5) = 15`. There is no negative term and no subtraction anywhere in the function, and `routes-pikme/user.js` writes it with `$inc: { xp: xpDelta }`. **Nothing to reinvent.**
My proposal touches only `rankPoints`. If the user takes the §7-5 fallback (`TROPHY_UPSET_BONUS`) it is **additive only** (`+25`, never subtracted), so rule #1 survives.

### 2. Different numbers for WIN / LOSE / TIE / PLAYED

Shipped already: win/loss/draw differ per tier. My seat's call on **PLAYED**:

- **Rank pays 0 for "played". Do not add a participation term to rank.** Rank is the skill number; paying for showing up is what the trophy track is for, and any positive per-match term compounds: **+1/match at a 50% win rate over the 197-win climb = +394 free rank ≈ two whole tiers.** That is not a rounding error.
- **"Played" is already covered on rank, twice, and better:** a bronze **loss costs 0** (`BANDS[0].loss = 0`), and every **draw is positive at every tier** (+10 … +2). So the participation floor exists — it just isn't an extra line item.
- If the user insists on a visible "played" number on rank: `RANK_PLAYED = +1`, **human matches only, completed only, not the 3rd+ meeting of the day, with `PLAYED_DAILY_CAP = 5`** → ≤ +5/day, ≤ 2.5% of a tier. That is the only shape I can bound.
- **"Played" as a function of opponent strength: NO.** It would pay you for *queueing* against strong players regardless of outcome — the purest farm in the whole design space. If `RANK_PLAYED` ships, it is a flat +1 with `oppMult` forced to 1.

### 3–4. Bots / bot count — my seat's contribution only

Owned by another seat; two facts from this seat:
- The graded `xpFactor` (0.20 / 0.47 / 0.73 / 1.00) already *is* the bot-count signal and it already feeds `rate` in `computeMatchRank`. **`oppMult` must exclude bots from both team aggregates**, or the same signal gets priced twice (once as `rate`, once as a fake low opponent rating).
- On the trophy track the `[0.5, 1.0]` clamp means **3 bots and 2 bots pay identically** (both clamp to 0.5). If that seat wants them separated, the fix is lowering `TROPHY_BOT_FLOOR` to `0.40` so 0.47 clears the floor — not adding opponent strength.

### 5. Trophies for higher-RANK / higher-TROPHY opponents, per result

**Input = opponent `rankPoints`. Never trophies. Rank track only.**

Why rank and not trophies:

| | what it measures | a grinder | a sharp newcomer |
|---|---|---|---|
| trophies (`xp`) | hours × matches. Monotonic, pays for bots, +200/day just for logging in | 40,000 (level 29) | 900 (level 5) |
| rank (`rankPoints`) | wins against humans, ceiling'd, gap-priced | 620 (gold) | 1,450 (diamond) |

- Price the match on **trophies** and beating the grinder pays ~1.45x while beating the newcomer pays ~0.6x — **exactly backwards.** You'd be paid for beating the weaker player.
- Price it on **rank** and it's dimensionally coherent: the delta is drawn from the rank band, in rank points, to settle a rank question.
- **"Both" is double-counting, provably:** `seedRankFromXp` maps a legacy player's *gated trophy tier* onto the rank ladder. Rank already carries the trophy signal for every pre-existing account. Adding trophies as a second input re-prices the same hours.
- Correlation is real but weak *by construction* — the bot ceiling (940) caps rank while trophies keep climbing forever, so any player past ~110 bot matches has a high-trophy / capped-rank profile. Trophies are the *worst* available skill proxy in our system, not a redundant one.

**Trophy track: no opponent scaling at all.** Three reasons: (i) it is the anti-rage-quit floor and must be predictable — the post-match reveal has to be legible; (ii) monotonic means the modifier could only ever be a *bonus*, which turns into "queue up to farm trophies" — a matchmaking distortion on the volume currency; (iii) §8's split line.
**Fallback if the user overrules me:** `TROPHY_UPSET_BONUS = +25`, flat, once per match, only on `win && vsHuman && gap >= +200 && !provisional`. Additive, monotonic-safe, ~20% of a human win (120–140), deliberately far below the `+200` daily bonus so it can't become the main loop.

### 6. Rank between humans only — what my formula does either way

- **If bots pay 0 rank** (the user's literal ask): `oppMult` is moot for bots, and the solo dead-wall the brief warns about is real — a friendless player never moves rank again, ever.
- **OPTION B (my recommendation to whichever seat owns #6): a bot team's rating is `botCeiling(botLevel) = 60 + 80·L`, and the same gap formula runs.** This is the principled version of "rank is skill": a bot of *known fixed* skill is a legitimate rating anchor with RD ≈ 0 (`04-economy-bots-math.md`, verified against chess-engine Elo cross-calibration). The shipped ceiling rule then falls out of the math instead of sitting on top of it: the further below the ceiling you are, the bigger the gap and the better a bot win pays; **as you approach the ceiling the gap → 0, the multiplier → 1.00, and the existing `>= ceiling → 0` rule takes over.** Bot rank stops being a flat 40% grind and becomes a proper taper.
- Inflation check: **`BOT_DAILY_CAP = 150` binds, not the multiplier.** The multiplier changes how many bot wins it takes to *hit* the cap (13 → 9), not the cap. Days-to-940 on bots alone is unchanged at ~7. Table in §Numbers.

### 7. Ranking XP — by opponent rank, opponent trophies, or both?

**By opponent RANK. One input. See §5.** Concretely:
- `oppTeamRank = teamRating(human opponents' rankPoints)`, `myTeamRank = teamRating(my side's human rankPoints incl. me)`, `gap = oppTeamRank − myTeamRank`.
- Opponent **trophies are not read at all** by the rank math. They keep their two existing jobs (`levelFromXp` → `botLevelFromXp` → bot difficulty → `botCeiling` → rank roof). That interlock, which §8 calls out as worth preserving, is *how* trophies influence rank — indirectly, through the roof, never through the payout.

---

## NUMBERS

### Multiplier by gap (tier-independent — this is the whole formula in one table)

| gap (opp − me) | E = my modelled win prob | **win ×** | **loss ×** | **draw ×** |
|---|---|---|---|---|
| −1600 | 0.990 | 0.61 | 1.25 | 0.51 |
| −1000 | 0.947 | 0.64 | 1.22 | 0.55 |
| −500 | 0.808 | 0.75 | 1.15 | 0.69 |
| −200 | 0.640 | 0.89 | 1.07 | 0.86 |
| **0** | 0.500 | **1.00** | **1.00** | **1.00** |
| +200 | 0.360 | 1.14 | 0.89 | 1.14 |
| +500 | 0.192 | 1.31 | 0.75 | 1.31 |
| +1000 | 0.053 | 1.45 | 0.64 | 1.45 |
| +1600 | 0.010 | 1.49 | 0.61 | 1.49 |

### Resulting deltas, all 7 tiers, `rate = 1.0`, no streak (format `win / loss / draw`)

| gap | bronze | silver | gold | platinum | diamond | champion | legend |
|---|---|---|---|---|---|---|---|
| **shipped today (=gap 0)** | 30 / 0 / 10 | 28 / −4 / 8 | 25 / −8 / 8 | 20 / −12 / 5 | 15 / −16 / 4 | 12 / −18 / 3 | 10 / −20 / 2 |
| +200 | 34 / 0 / 11 | 32 / −4 / 9 | 29 / −7 / 9 | 23 / −11 / 6 | 17 / −14 / 5 | 14 / −16 / 3 | 11 / −18 / 2 |
| +500 | 39 / 0 / 13 | 37 / −3 / 10 | 33 / −6 / 10 | 26 / −9 / 7 | 20 / −12 / 5 | 16 / −14 / 4 | 13 / −15 / 3 |
| +1000 | 43 / 0 / 14 | 41 / −3 / 12 | 36 / −5 / 12 | 29 / −8 / 7 | 22 / −10 / 6 | 17 / −12 / 4 | 14 / −13 / 3 |
| −200 | 27 / 0 / 9 | 25 / −4 / 7 | 22 / −9 / 7 | 18 / −13 / 4 | 13 / −17 / 3 | 11 / −19 / 3 | 9 / −21 / 2 |
| −500 | 23 / 0 / 7 | 21 / −5 / 6 | 19 / −9 / 6 | 15 / −14 / 3 | 11 / −18 / 3 | 9 / −21 / 2 | 8 / −23 / 1 |
| −1000 | 19 / 0 / 6 | 18 / −5 / 4 | 16 / −10 / 4 | 13 / −15 / 3 | 10 / −20 / 2 | 8 / −22 / 2 | 6 / −24 / 1 |

Every win stays ≥ +6. Every draw stays ≥ +1. Bronze losses stay exactly 0. **Worst single loss in the system: −25** (legend at gap −1600); today's worst is −20.

### The bound (ask (c)): wins to climb each tier at a *sustained* gap

| sustained gap | bronze | silver | gold | plat | diamond | champion | **total to legend** | vs §8 |
|---|---|---|---|---|---|---|---|---|
| −1000 | 11 | 17 | 25 | 39 | 80 | 125 | **297** | +51% |
| −500 | 9 | 15 | 22 | 34 | 73 | 112 | **265** | +35% |
| **0 (§8 baseline)** | 7 | 11 | 16 | 25 | 54 | 84 | **197** | — |
| +200 | 6 | 10 | 14 | 22 | 48 | 72 | **172** | −13% |
| +500 | 6 | 9 | 13 | 20 | 40 | 63 | **151** | −23% |
| +1000 | 5 | 8 | 12 | 18 | 37 | 59 | **139** | −29% |
| +1600 (asymptote) | 5 | 8 | 11 | 17 | 37 | 56 | **134** | −32% |

**Proof the curve survives:** the multiplier is bounded above by `WIN_MULT_MAX = 1.50` by clamp and by 1.49 by asymptote, so no tier can ever be crossed in fewer than `ceil(width / (band.win · 1.5))` wins — the +1600 row. The absolute floor is **134 wins** vs 197, i.e. the ladder cannot be compressed by more than **32%**, and only by a player who wins **100% of matches against opponents 1000–1600 rank above them, from bronze to legend**. Those opponents must exist: to sustain gap +1000 out of bronze you need a live 1100+ population, and to sustain it in diamond you need live 2400+ players — §8 already calls the top two tiers "near-mythical at this playerbase". **With `UPSET_DAILY_CAP = 60` the bound becomes hard and time-based**: at most +60 rank/day of bonus, i.e. the fastest *possible* extra progress is ~1.7 bronze tiers/day of bonus regardless of matchmaking luck.

Sign safety: `win × ≥ 0.60 > 0` and `loss × ≥ 0` → the multiplier can never flip a win negative or a loss positive. `scale()`'s round-away-from-zero means no win or draw ever rounds to `+0` (the smallest is legend draw `2 × 0.51 = 1.02 → 1`).

### (d) Asymmetry, side by side

| | beat someone **+500** above | lose to someone **+500** above | beat someone **−500** below | lose to someone **−500** below |
|---|---|---|---|---|
| multiplier | **1.31×** | **0.75×** | 0.75× | 1.15× |
| gold (25 / −8) | **+33** | **−6** | +19 | −9 |
| diamond (15 / −16) | **+20** | **−12** | +11 | −18 |

The win side is steeper than the loss side on purpose: `WIN_UPSET_SLOPE 0.50` vs `LOSS_SURCHARGE_SLOPE 0.25`, and `LOSS_MULT_MAX 1.25` vs `WIN_MULT_MAX 1.50`. Rationale: the shipped design already spends its anti-anxiety budget on the loss side (`firstLossToday → 0`, bronze losses 0, sticky tier floor) — the multiplier keeps that posture.

**Side benefit worth noting:** today a legend farming golds earns `+10 / −20` at a 90% win rate = **+7 rank per match**, while playing an equal legend earns **−5** (the crossover bands make even matches negative-EV at the top). So the current design *pays top players to hunt weak humans*. With the multiplier that becomes `+6 / −25` = **+2.9/match** — a 2.4× reduction. It does not fully remove the pathology (that needs a band change, not my seat), but it is the only thing in the design that pushes back on it.

### Anti-farm EV check — gold band (25 / −8), rank per match

| gap | win / loss | EV @10% | @25% | @50% | @75% | @90% |
|---|---|---|---|---|---|---|
| 0 | 25 / −8 | −4.7 | +0.3 | **+8.5** | +16.8 | +21.7 |
| +500 | 33 / −6 | −2.1 | +3.8 | +13.5 | +23.3 | +29.1 |
| +1000 | 36 / −5 | −0.9 | +5.3 | +15.5 | +25.8 | +31.9 |
| −500 | 19 / −9 | −6.2 | −2.0 | +5.0 | +12.0 | +16.2 |
| −1000 | 16 / −10 | −7.4 | −3.5 | +3.0 | +9.5 | +13.4 |

Read the diagonal, which is what actually happens: if the ladder is *even roughly* calibrated, a +1000 gap means a ~5–25% win rate → EV **−0.9 to +5.3**, *worse* than the +8.5 of an even match. **Queueing up is not the fast path.** The exposure is total miscalibration: if you truly win 50% against opponents 1000 above you, gap-chasing pays +15.5 vs +8.5 — **1.8× faster**. That is the one number to watch after real play (see Risks).

### (e) 2v2 cases — `teamRating = 0.75·max + 0.25·min`, humans only

| case | my team R | opp team R | gap | win | loss | draw |
|---|---|---|---|---|---|---|
| A. solo 600 + bot vs two solos 600, 600 | 600 | 600 | 0 | +25 | −8 | +8 |
| B. solo 600 + bot vs two solos 400, 800 | 600 | 700 | +100 | +27 | −8 | +9 |
| C. duo 600+700 vs duo 600+650 — *the 600 seat* | 675 | 638 | −37 | +24 | −8 | +8 |
| D. same match — *the 700 seat* | 675 | 638 | −37 | +24 | −8 | +8 |
| **E. CARRY duo 100+3200 vs 600, 600 — the carried bronze** | 2425 | 600 | −1825 | **+18** | **0** | +5 |
| **F. same match — the carrying legend** | 2425 | 600 | −1825 | **+6** | −20¹ | +1 |
| G. solo 600 vs that carry duo | 600 | 2425 | +1825 | **+37** | −5 | +12 |
| H. duo 400+1400 vs 900, 900 — the 400 seat | 1150 | 900 | −250 | +24 | −4¹ | +7 |
| I. same match — the 1400 seat | 1150 | 900 | −250 | +13 | −16¹ | +3 |

¹ Unmultiplied (−20 / −4 / −16 = the raw band), not −25 / −4 / −17: my side's human spread exceeds `PARTY_SPREAD_MAX = 600`, so the loss surcharge is switched off. Duoing with a much weaker friend never costs *more* than a solo loss.

- **Does the carried weak teammate get the same delta as the carrier? No — and that's the point.** They get a bigger number (+18 vs +6) because their own BAND is bigger (bronze 30 vs legend 10), but they get the same *gap* and therefore the same *multiplier* (0.60×). **Priced by team, banded by self.**
- **Duo vs two solos:** case A/B vs C/D — a coordinated duo of equals is *not* charged a party tax here, because at spread ≤ 600 `0.75·max + 0.25·min` ≈ the mean. Voice-comms advantage is real but unmeasurable at our size; I am deliberately not inventing a number for it.
- **Why not pure mean:** case E would price my side at 1650 → gap −1050 → +19, and if we'd priced *only my own rank* (100) it would be gap **+500 → +39**, i.e. a legend friend would be a rank printer for a bronze account. Team-vs-team is the fix; the party tilt is the polish.
- **Why not pure max:** case C/D would price both sides by their stronger player, which for near-equal duos throws away half the information and makes a 650-vs-700 match read as a 50-point gap it isn't.

### (f) Cold start

**Rule: `< PROVISIONAL_MATCHES (10)` recorded matches on *either* side → multiplier exactly 1.00. Missing/unverifiable field → 1.00.**

- A brand-new opponent at rank 0 is *unrated*, not *weak*. Treating 0 as a rating would (i) pay a veteran 0.60× for meeting a newcomer — punishing the exact match we want to encourage, and (ii) hand the newcomer 1.45× on every win, which is a two-account smurf on-ramp.
- Neutral-during-placement is the shipped-game answer, verified: **CS2 Premier hides your rating until you have won 10 Premier matches**; **FIDE uses K=40 for a player's first 30 rated games**. Both say the same thing — don't let an uncertain rating price anything.
- It also matches this repo's existing failure posture: a missing `opponentKey` makes the win-trading cap "simply never fire" (`countMeetings` comment). Same convention, no new concept.
- **I do NOT recommend Glicko-2 RD or TrueSkill sigma.** Justification, concretely: (i) a few hundred players — Glicko's RD earns its keep in a pool where you never meet the same opponent twice, and ours is small enough that `OPPONENT_DAILY_LIMIT = 3` exists *because* people meet repeatedly; (ii) our ladder is **not a rating** and cannot be made into one — the sticky `rankFloor`, no relegation, and `botCeiling` all deliberately break the zero-sum invariant a Bayesian rating needs, so RD would be modelling a quantity we then override; (iii) cost: 2 new stored numbers per player, a volatility update step, a re-derivation of every number in §8's tier curve, and a second parity test — against a benefit that a 10-match neutral window captures ~90% of. Revisit at ~2000 active players *and* only if we ever want real skill-based matchmaking, which is the thing RD is actually for.

### Bot-rating variant (§7-6 OPTION B) — what bot matches would pay

`rate = BOT_RATE (0.4)` × `oppMult(gap = botCeiling(L) − myRank)`:

| my rank | bot L | bot rating (=ceiling) | gap | win TODAY | win with gap mult | bot wins to hit the 150/day cap |
|---|---|---|---|---|---|---|
| 0 | 5 | 460 | +460 | 12 | **15** | 13 → 10 |
| 100 | 11 | 940 | +840 | 12 | **17** | 13 → 9 |
| 300 | 11 | 940 | +640 | 11 | **15** | 14 → 10 |
| 500 | 11 | 940 | +440 | 10 | **13** | 15 → 12 |
| 700 | 11 | 940 | +240 | 10 | **12** | 15 → 13 |
| 900 | 11 | 940 | +40 | 8 | **8** | 19 → 19 |
| 450 | 5 | 460 | +10 | 11 | **11** | 14 → 14 |

The taper is automatic and the daily cap is untouched — **days to reach 940 on bots alone stays ~7**. Fewer matches for the same daily allowance is a pure UX win.

---

## RISKS (most serious first)

1. **The input does not exist. The server cannot see opponent rank today, at all.** `opponentKey` is `sha256(sorted userIds).slice(0,32)` — irreversible by design, and `matchStart` carries no ranks because the game server never learns them (`join` has no rank field; the game server has no HTTP client). **Without §8's wire change this entire seat is unshippable**, and a naive "just send it from the client" version is spoofable. Nothing else on this list matters until this is decided.
2. **Calibration exposure.** Our ladder is an accumulation counter with a sticky floor, not a probability-calibrated rating, so `E` is a *model*, not a measurement. If real win rates against +1000 opponents are ~50% rather than the modelled 5%, gap-chasing pays 1.8× an even match (EV table). Mitigation, in order: `UPSET_DAILY_CAP = 60`; then drop `WIN_MULT_MAX` to 1.35; then raise `ELO_D` to 1200 (flatter). All three are one-constant changes. **Log `gap` and `result` on every recorded match from day one** so this is measurable in two weeks instead of guessable.
3. **Worst-case loss grows 25%** (−20 → −25 at legend, −18 → −22 at champion). Sticky `rankFloor` prevents tier loss, and `firstLossToday` still zeroes the first one, but the post-match reveal will show a bigger red number than anything shipped. If that reads as too harsh, `LOSS_MULT_MAX = 1.10` caps it at −22/−20.
4. **Social cost of duoing down.** Case F: a strong player who invites a much weaker friend earns +6 instead of +10 per win. The `PARTY_SPREAD_MAX` surcharge-off softens the loss side but not the win side. This is the correct *math* and a bad *feeling* — and friends/challenges is the feature this repo just shipped. Options: exempt private-room/challenge matches from `oppMult` entirely (they're the social mode, not the ladder), or accept it. **I'd exempt private rooms**, which also removes the entire hand-picked-opponent attack surface in one line.
5. **Two more files must move in lockstep or CI breaks.** `football-mock/shared/rank.js` mirrors the constants and `test-rank-parity.mjs` **fails the build** on drift. Nine new constants × 2 files. The game must still never compute a delta.
6. **Legibility.** Right now the player can learn one number per tier ("gold wins pay 25"). After this, the same win pays 19–33 depending on who they played. Without UI that *shows* the gap (a "+31% אתגר" chip on the reveal), this reads as randomness — and unexplained ranked randomness is the #1 complaint in the `05-psychology` research. **Ship the chip or don't ship the feature.**
7. **Two new stored fields** if `UPSET_DAILY_CAP` is taken (`upsetRankDate`, `upsetRankToday`) — trivial, but it's a schema change in `data/footballstats.js`, which other seats are editing.

---

## §8 — THE WIRE (what has to be built, and the security bound)

Minimum path, all additive, all gated on the field existing (→ old builds keep today's numbers):

1. **`pikme-server`** `/football/stats` + `/handle-friends/rank` also return `rankAttest = b64url({u,r,m,exp}) + "." + HMAC-SHA256(FOOTBALL_TOKEN_SECRET)`, TTL 6h. `r` = rankPoints, `m` = matchesPlayed.
2. **App** injects it as `window.SALTIZ_RANK.attest`; **client** sends it in `join`.
3. **Game server** verifies it with the secret it already holds (`shared/football-auth.js` pattern), stores `member.rank` / `member.rankMatches`, and on `matchStart` sends **per recipient** a `strengthTicket = b64url({mid, mg, og, prov, wide}) + "." + HMAC` — plus the plain numbers for the UI chip. `mg`/`og` are the two `teamRating()` values, humans only.
4. **Client** echoes `strengthTicket` in `matchResult`; **app** forwards it; **`pikme-server`** verifies the HMAC and that `mid === matchId`, else `oppMult = 1`.

**If shipped unsigned (Phase 1, client-reported ranks relayed by the game server):** a player cannot alter *their opponents'* claimed rank — only the opponent's own client reports itself, and the game server relays it. So the only exploit is a **colluding pair / alt account claiming rank 3200**. Bound: max win multiplier 1.45 → at bronze that is **+13 extra per win**; `OPPONENT_DAILY_LIMIT = 3` caps them at **2 paying meetings/day** → **≤ +26/day**, and `UPSET_DAILY_CAP = 60` caps it globally. That is ~0.9 bronze tiers/week of theft — small enough to ship unsigned and add the HMAC in the same release as the next TestFlight build. Signed is still the right end state.

---

## SOURCES — verified vs inferred

**VERIFIED (shipped games / published rules):**
- **Clash Royale** — the closest live analogue to ask #5, and it is exactly the asymmetry requested: "the higher your opponent is compared to you, the more trophies you gain if you win and the less you lose if you lose." Anchors: even match ±30; opponent 100 below → **+20 / −40**; 160 below → **+17 / −43**. Note its invariant `gain + |loss| ≈ 60` (zero-sum) — our BANDS deliberately break that (they cross over), which is why I do **not** copy CR's linear scale. [Trophies — Clash Royale Wiki](https://clashroyale.fandom.com/wiki/Trophies) · [In-depth trophy guide](https://clashroyale.wiki/depth-guide-trophies/)
- **Rocket League** — party matchmaking: "the average for players in Champion Rank and higher is weighted more towards the highest-ranked player"; undersized 3v3 parties must be within **3 ranks**; lobby difficulty set by the **highest-ranked** player. This is the direct citation for `PARTY_TILT` (mean tilted toward max) rather than a pure mean. [Epic — How does matchmaking and rank work](https://www.epicgames.com/help/c-202300000001622/c-202300000001682/how-does-the-matchmaking-and-rank-system-work-in-rocket-league-a202300000014019) (403 to direct fetch; retrieved via search snippet) · [Immortalboost RL ranks 2026](https://immortalboost.com/blog/rocket-league/ranks-ranking-system/)
- **Apex Legends** — premade party matchmaking is based on the **highest-ranked squad member**, members must be within 3 tiers. Supports max-weighting a party. [Ranked Leagues — Apex Wiki](https://apexlegends.fandom.com/wiki/Ranked_Leagues) · [EA Help — How Ranked works](https://help.ea.com/en/articles/apex-legends/ranked/)
- **Brawl Stars Ranked (2025–26)** — you cannot party with a large rank difference; **Masters+ is solo-queue only**. Precedent for restricting rather than pricing extreme party spreads. [Ranked — Brawl Stars Wiki](https://brawlstars.fandom.com/wiki/Ranked)
- **CS2 Premier** — Glicko-2 based; **rating hidden until 10 Premier wins**; placement swings 300–500 vs 50–150 once established. Direct precedent for `PROVISIONAL_MATCHES = 10` and for *not* pricing an uncertain rating. [What is the Glicko system behind CS2 Premier](https://cs.money/blog/esports/what-is-glicko-rating-secrets-of-mm-rating/) · [Dexerto — CS2 ranks explained](https://www.dexerto.com/counter-strike-2/cs2-ratings-explained-premier-ranks-cs-rating-in-counter-strike-2-2279328/)
- **Elo / FIDE** — `E = 1/(1+10^((Ro−Rp)/400))`; K=40 for the first 30 rated games, 20 below 2400, 10 above. Source of the shape, and of the provisional-window idea. Carried from [`04-economy-bots-math.md`](04-economy-bots-math.md) §3.
- **Fixed-skill bots are a legitimate rating anchor (RD ≈ 0)** — chess-engine Elo is how human pools have been cross-calibrated for decades. Carried from [`04-economy-bots-math.md`](04-economy-bots-math.md) §3. Basis for OPTION B.
- **Our own shipped code** — every current number in this doc (`BANDS`, `TIER_MIN`, `BOT_RATE`, `BOT_DAILY_CAP`, `OPPONENT_DAILY_LIMIT`, `botCeiling`, `xpFactor`, `TROPHY_BOT_FLOOR`, `computeMatchXp`) read directly from `pikme-server/data/football-rank.js`, `data/football-xp.js`, `routes-pikme/user.js`, `football-mock/public/client.js`, `server.js`, `shared/opponent-key.js`.

**INFERRED (my design; no game ships these exact numbers):**
- `ELO_D = 800` and the whole choice of a logistic on the *gap* over a linear one.
- All four slopes (0.50 / 0.40 / 0.40 / 0.25) and all six clamps.
- `teamRating = mean + 0.5·(max − mean)` = `0.75·max + 0.25·min`, and the humans-only exclusion.
- `PARTY_SPREAD_MAX = 600` and the wide-party loss-surcharge-off rule.
- `UPSET_DAILY_CAP = 60`, `RANK_PLAYED = +1 / PLAYED_DAILY_CAP = 5`, `TROPHY_UPSET_BONUS = +25`.
- The bot-rating-equals-`botCeiling` variant (OPTION B). The *anchor principle* is verified; using the ceiling as the number is mine.
- The `rankAttest` / `strengthTicket` HMAC wire design and its abuse bound (+26/day).
- Every delta and wins-per-tier figure in the tables: computed by me from the formula + the shipped BANDS, not observed in play. **Rank's numbers have never been played** (§8) — these are simulations on top of simulations.
