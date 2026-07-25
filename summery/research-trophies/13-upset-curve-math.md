# 13 — The upset curve: the math

> Seat: **the upset curve. "Much more" is the requirement, and I own the numbers.** Date 2026-07-26.
> RESEARCH + SPEC ONLY — no `.js` touched, no test touched, no commit. This file is my only write.
> Reads on: `pikme-server/data/football-rank.js`, `football-mock/shared/rank.js`,
> `football-mock/test-rank-parity.mjs`, `pikme-server/routes-pikme/user.js` L1244–1339,
> and seat docs [`07`](07-opponent-strength-math.md) / [`11`](11-DECISION-v2-progression.md).
> Every table below was **computed**, not asserted — scripts in the session scratchpad, arithmetic
> reproduced inline so any seat can re-derive it.

---

## CONCLUSION — 12 bullets

1. **Pure Elo mathematically cannot deliver "much more". The ceiling is exactly 2x, and it is a
   theorem, not a tuning choice.** `Δwin = K·(1−E)`, `E ∈ (0,1)`. An even match is `E = 0.5 → K/2`.
   The supremum is `K`. So `sup(Δwin) / Δwin(even) = K / (K/2) = 2`, for **every** K and **every** D.
   At a +400 gap it is **1.82x**; at +800 it is **1.98x**; you never actually reach 2x.
   **→ Seat `07`'s 1.50x multiplier was not badly tuned. It was near the top of the only range Elo has.**
2. **The multiplier had to go. It is replaced by a GAP-KEYED ABSOLUTE TABLE.** Not an Elo term, not a
   multiplier on the shipped `BANDS`. Reason in §1c.
3. **The shape to copy is TrueSkill's, not Elo's.** TrueSkill's mean update is
   `μ += (σ²/c)·v(t)`, `v(t) = φ(t)/Φ(t)`. Because `v(t) ~ −t` as `t → −∞` (Mills ratio), the update is
   **unbounded and roughly LINEAR in the gap**: an even match pays `v(0) = 0.798`, a 3σ upset pays
   `3.283` = **4.12x**, a 4σ upset **5.30x**. The user's instinct ("3–5x") is exactly the TrueSkill
   number. So a linear `+20 per tier of gap` ramp is the *principled* shape, not a hack.
4. **THE TABLE (§2).** 9 buckets, `g = oppTeamTier − myTeamTier` clamped `[−4, +4]`:
   win `+4 / +6 / +9 / +15 / +25 / +45 / +65 / +85 / +105` · loss `−26 / −24 / −22 / −21 / −20 / −16 /
   −11 / −7 / −5` · draw `−10 / −8 / −6 / −3 / +2 / +8 / +14 / +19 / +24`.
   **Even win +25 → big-upset win +105 = 4.20x.** Headline case: bronze+bronze beating legend+legend
   pays **+105**; legend+legend beating bronze+bronze pays **+4**. **A 26x spread across the user's
   own example.**
5. **I did not pick those numbers, I derived them.** Win row = `25 + 20g` for `g ≥ 0` (the TrueSkill
   ramp), halving below. Loss row = solved backwards from a **target break-even win rate** per gap.
   The result is a single monotone break-even curve **86.7% → 4.5%**, identical at every tier, and the
   **only negative-EV bucket in the whole table is `g = −4`** — the deep-farm bucket. That is the design.
6. **The brief's starting shape has 4 concrete faults** (§2b). The worst: `loss = 0` at `g = +4` makes
   the **biggest-payout bucket risk-free** (break-even WR = 0.0%), and `+10 / −40` at `g = −2` demands an
   **80% win rate to break even against a team 2 tiers below you** — which, in a thin queue where a top
   player *cannot choose otherwise*, makes the top of the ladder strictly −EV.
7. **The user's literal loss rule is internally impossible and I am flagging it, not silently fixing
   it.** You cannot have *both* "beating a much weaker team pays almost nothing" *and* "losing to a much
   weaker team costs the maximum" — the pair sets break-even at 94%+ and taxes players for the
   matchmaker's failure. **My row delivers the same intent through opportunity cost:** `+4 / −26` at
   `g = −4` is an **86.7% break-even**. Farming down fails because it *pays nothing*, not because it
   *costs a lot*. That is the correct expression of "maximum cost".
8. **Key on the TIER INDEX, but make it FRACTIONAL** (§4). Integer buckets alone put a **+20 (80%)
   payout cliff on a 1-rank-point difference** at 899 vs 900. Fractional tier position with linear
   interpolation between the 9 rows reduces that same 1-point swing to **0.05 points** while the UI
   still says "2 דרגות מעליך". Legibility kept, cliff deleted.
9. **Team aggregate = `mean + 0.5·(max − mean)`** (§3). In 2v2 that **is** `0.75·max + 0.25·min`. Do
   **not** ship the literal `0.75/0.25` form — **3v3 is live and the literal form deletes the middle
   player** (`[bronze, bronze, legend]` reads 4.50 instead of 4.00). **Both members of a team get the
   same delta.** The aggregate already solves the user's case (bronze+bronze vs legend+legend = `g +4`,
   +105 each); a per-member weak bonus would only open the boosting hole.
10. **YES, the table breaks the ladder without two hard rails.** Simulated: a bronze in a thin queue who
    meets legend teams every match reaches **legend in ~290 matches at a 14–20% win rate**. Uncapped,
    the upset bonus *is* the ladder.
11. **The two rails, with numbers.** `UPSET_BUDGET = 200` rank/player/event (the exact sum of the four
    full win bonuses 20+40+60+80) and `MAX_DELTA = 0.4 × current tier width`. With the budget the same
    pathological grinder is **parked at silver 250 after 400 matches**, and — the part that matters —
    the **honest** gold player in a thin queue spends only **57–145 of the 200** over 60 matches, so the
    rail **binds the exploit and not the player**.
12. **Two free wins nobody has claimed yet.** (i) The gap table **is a placement system** — an UNRANKED
    player at rank 0 meets everyone at `g = +2…+4`, climbs fast, and the gap **auto-tapers to 0** as they
    rise. No provisional K-factor, no separate placement math, and it answers the settled UNRANKED /
    לא מדורג requirement for free. (ii) The table is a **`pikme-server`-only change** — `test-rank-parity.mjs`
    checks `RANK_TIERS`, `TIER_MIN`, `botCeiling` and `TIER_HE` and **nothing about the deltas**, so this
    does not touch the parity gate.

---

## §1 — (a) WHAT REAL GAMES ACTUALLY PAY FOR AN UPSET

### 1a. The 2x bound, with the arithmetic

`E = 1 / (1 + 10^(gap/D))`, `Δwin = K·(1 − S… )` → `Δwin = K·(1 − E)`, `Δloss = −K·E`. K = 32:

| gap (opp − me) | E | Δwin | **× vs even win** | Δloss | × vs even loss |
|---|---|---|---|---|---|
| −800 | 0.9901 | +0.32 | 0.02x | −31.68 | 1.98x |
| −400 | 0.9091 | +2.91 | 0.18x | −29.09 | 1.82x |
| **0** | 0.5000 | **+16.00** | **1.00x** | **−16.00** | **1.00x** |
| +200 | 0.2403 | +24.31 | 1.52x | −7.69 | 0.48x |
| **+400** | 0.0909 | **+29.09** | **1.82x** | −2.91 | 0.18x |
| +800 | 0.0099 | +31.68 | **1.98x** | −0.32 | 0.02x |
| +1600 | 0.0001 | +32.00 | **2.00x** | −0.00 | 0.00x |
| +∞ | 0 | +32 | **2.00x (sup, unreachable)** | −0 | 0 |

**Proof of the bound.** `E ∈ (0,1)` strictly ⇒ `Δwin = K(1−E) ∈ (0, K)`. Even match ⇒ `E = 0.5` ⇒
`Δwin = K/2`. Therefore `Δwin / Δwin(even) = 2(1−E) < 2` **for every gap, every K, every D.**
Widening D (seat `07` used 800 to avoid saturation) does **not** help — it only changes *which gap*
gets you near 2x, never the ceiling. **VERIFIED by construction, not by observation.**

Two consequences the user needs:

- **Elo's loss side already does what the user wants** — `|Δloss|` runs from `K` down to `0`, an
  unbounded *ratio* downward. "Losing to a much stronger team is free" is native Elo.
- **Elo's win side structurally cannot.** The cause is zero-sum in K: the winner's gain and the loser's
  loss must sum to K. Our ladder **already broke zero-sum** — sticky `rankFloor`, no relegation,
  crossover BANDS. **We are not bound by Elo's constraint and should stop borrowing its ceiling.**

### 1b. TrueSkill — the update that is *not* bounded

`c² = 2β² + σ_w² + σ_l²`, `t = (μ_w − μ_l)/c`, `μ_w ← μ_w + (σ_w²/c)·v(t)`, `v(t) = φ(t)/Φ(t)`.
`t < 0` = the winner was the underdog. Defaults verified at trueskill.org: `μ 25 · σ 8.333 · β 4.167 · τ 0.083`.

| t (σ of gap) | v(t) | **× vs even (t=0)** |
|---|---|---|
| +2 (heavy favourite won) | 0.0552 | 0.07x |
| **0 (even)** | **0.7979** | **1.00x** |
| −1 | 1.5251 | 1.91x |
| −2 | 2.3732 | 2.97x |
| **−3** | **3.2831** | **4.12x** |
| −4 | 4.2256 | 5.30x |
| −5 | 5.1865 | 6.50x |

`v(t) ~ −t` as `t → −∞` ⇒ **unbounded, asymptotically linear in the gap.** A 3σ upset = 4.12x, a 4σ
upset = 5.30x. **This is where "3–5x" is legitimate mathematics rather than a wish.** It is also why
my win row is a **linear +20/tier ramp**: linear-in-gap is TrueSkill's asymptote.

### 1c. The four shipped games, and what each one actually proves

| game | upset term | numbers | what it proves |
|---|---|---|---|
| **Chess / FIDE Elo** | Elo only | K=32: even +16, beat +400 → **+29 (1.82x)**, beat +800 → +31.7 (1.98x). FIDE K=40 for the first 30 rated games, 20 below 2400, 10 above. | the 2x ceiling, and that the only way Elo ever pays >2x is by raising **K** for **uncertainty**, never for the gap |
| **Rocket League** (Glicko-2 derived) | yes, gap-driven | even match **+8…+12**; beating a much higher team **up to +20** ≈ **2x**; underdog win **+11…+13** vs loss **−6…−7**; favourite win **+6…+7** vs loss **−11…−13**. New account, high σ: **30–50 per match**. | **the live confirmation of the bound.** RL's *gap*-driven range is ~2x, exactly as the theorem requires. The only 3–5x swings in RL are **σ-driven (uncertainty)**, not upset-driven |
| **CS2 Premier** (Glicko-2) | via RD | placement swings **300–500**, settled swings **50–150** = **3–6x** | same lesson again: the 3–6x lives in **RD/uncertainty**, and CS2 hides your rating until 10 Premier wins |
| **Clash Royale — Ranked Mode / Path of Legends** | **none at all** | win = **+1 step**, loss = **−1 step**; **Golden Steps** at each league's bottom are un-losable (their sticky floor). Trophy Road above 15,000 is a flat **±30**. | a top-tier live ladder ships **zero** upset term and is fine. Legibility beats precision at scale |
| **Clash Royale — legacy ladder trophies** | yes, linear | even **±30**; opponent 100 below → **+20 / −40**; 160 below → **+17 / −43**. Invariant `gain + \|loss\| ≈ 60` | the *asymmetry the user asked for*, shipped — but zero-sum, so the win side is capped the same way Elo is |
| **Brawl Stars Ranked (2026)** | yes, Elo-style on Ranked Score | gains scale up vs higher-ranked opponents, down vs lower. Tier widths **250 (bronze/silver) → 750 (legendary) → 1000 (masters)** | Elo-shape again (so ≤2x), **and** independent precedent for our widening `TIER_MIN` |
| **Tekken 8** | **inverted** | you gain the **most** points against your **own** rank; points *decrease* per rank of separation and bottom out past 3 ranks. A small bonus for beating up, explicitly "not dramatic" | a **counter-example worth knowing**: a major fighting game deliberately pays *less* for a big gap in either direction, to stop rank-gap farming |
| **Street Fighter 6** | yes, and **big** | floor is **+50 win / −40 loss**; players report **250–300 LP** for a single win over a much higher-ranked opponent = **5–6x**. Streak bonus 50→75→100 below Platinum, none above | the **only shipped precedent for the magnitude the user wants**. Capcom has never published the table, so treat 5–6x as *reported*, not official |

**Conclusion the user needs, plainly:** every Elo/Glicko game in that list lands at ~2x for the gap, because
it *must*. **The 3–6x jumps that do exist in shipped games come from uncertainty (σ/RD/K), not from the
gap** — except SF6, which abandons Elo and uses a table. **So "much more" requires a gap-keyed table or an
additive bonus term. It cannot be an Elo multiplier.** That is settled by arithmetic.

---

## §2 — (b) THE TABLE

`g = oppTeamTier − myTeamTier`, tier index 0–6 (bronze…legend), fractional, clamped `[−4, +4]`.
Absolute values in rank points. **No per-tier `BANDS` term. No multiplier. This table IS the delta.**

| g (tiers) | Hebrew chip | **WIN** | **LOSS** | **DRAW** | × vs even win | break-even WR | model P(win) | edge |
|---|---|---|---|---|---|---|---|---|
| **≤ −4** | 4 דרגות מתחתיך | **+4** | **−26** | −10 | 0.16x | **86.7%** | 86% | **−0.7 pp** |
| −3 | 3 דרגות מתחתיך | +6 | −24 | −8 | 0.24x | 80.0% | 80% | +0.0 pp |
| −2 | 2 דרגות מתחתיך | +9 | −22 | −6 | 0.36x | 71.0% | 72% | +1.0 pp |
| −1 | דרגה מתחתיך | +15 | −21 | −3 | 0.60x | 58.3% | 62% | +3.7 pp |
| **0** | דרגה שווה | **+25** | **−20** | **+2** | **1.00x** | **44.4%** | 50% | +5.6 pp |
| +1 | דרגה מעליך | +45 | −16 | +8 | 1.80x | 26.2% | 38% | +11.8 pp |
| +2 | 2 דרגות מעליך | +65 | −11 | +14 | 2.60x | 14.5% | 28% | +13.5 pp |
| +3 | 3 דרגות מעליך | +85 | −7 | +19 | 3.40x | 7.6% | 20% | +12.4 pp |
| **≥ +4** | 4 דרגות מעליך | **+105** | **−5** | **+24** | **4.20x** | **4.5%** | 14% | +9.5 pp |

The four asymmetries the user asked for, measured:

| | value | vs even | verdict |
|---|---|---|---|
| beat a team 4 tiers **above** | **+105** | **4.20x** | "much more" ✅ (target was ~4x) |
| beat a team 4 tiers **below** | **+4** | **0.16x** | "almost nothing" ✅ |
| lose to a team 4 tiers **above** | **−5** | **0.25x** | "≈ free" ✅ — but **not zero**, see 2b fault 1 |
| lose to a team 4 tiers **below** | **−26** | **1.30x** | "maximum cost" — delivered as an **86.7% break-even**, see §2c |

**The user's own example, priced:** bronze+bronze beat legend+legend = **+105 each**. The same bronze pair
beating another bronze pair = **+25 each**. A legend pair beating a bronze pair = **+4 each**.
**+105 vs +4 = a 26x spread across "level 1 beats two level 10" vs "level 10 beats two level 1".**
Two such upsets = **+210** = bronze → silver in two matches (today: 60, a third of a tier).

### 2a. How the rows were derived (so they can be re-derived, not re-guessed)

- **Win row, `g ≥ 0`: `WIN(g) = 25 + 20g`.** Linear, because TrueSkill's `v(t)` is asymptotically linear
  in the gap (§1b). `+20` per tier is the one rule a 14-year-old can state: **כל דרגה מעליך = +20**.
  `WIN(0) = 25` is deliberately today's **gold** band — the modal tier — so the modal payout does not move.
- **Win row, `g < 0`: roughly halves per tier** (25 → 15 → 9 → 6 → 4). It cannot keep the −20 slope or it
  goes negative at `g = −2`. Halving is the mirror of what the loss row does above 0.
- **Loss row: solved from a target break-even win rate, not chosen.**
  `|LOSS(g)| = WIN(g) · p*/(1 − p*)`. I set `p*(g) ≈ P(win|g) − 8 pp`, then rounded to a whole number.
  That is why the loss row is *flatter* than intuition suggests: once the win is 4x larger, the loss barely
  has to move to keep the same break-even.
- **Draw row: `+5 per tier above, −3 per tier below, +2 at even`**, subject to two hard constraints I
  checked: `DRAW(g) < WIN(0)` for all g (**+24 < +25** — drawing up must never beat winning even) and
  `DRAW(g) ≤ 0.5·WIN(g)` for `g ≥ 0` (**no stall-for-a-draw exploit dominates**).
- **`P(win|g)` model — INFERRED, and the single biggest assumption in this doc.** `86 / 80 / 72 / 62 / 50 /
  38 / 28 / 20 / 14 %`. Deliberately **compressed vs Elo**: this is a 120-second 2v2 football game with
  projectiles and bombs, so a 4-tier favourite wins ~86%, not the ~99% Elo would predict at that spread.
  Sensitivity in §5c. **Log `gap` + `result` on every ranked match from day one so this becomes measured.**

### 2b. Where the brief's starting shape is wrong

Scored on exactly the same axes:

| g | brief WIN | brief LOSS | break-even WR | model P(win) | edge |
|---|---|---|---|---|---|
| −2 (collapsed "2+ below") | +10 | −40 | **80.0%** | 72% | **−8.0 pp** |
| −1 | +18 | −28 | 60.9% | 62% | +1.1 pp |
| 0 | +25 | −20 | 44.4% | 50% | +5.6 pp |
| +1 | +40 | −12 | 23.1% | 38% | +14.9 pp |
| +2 | +60 | −6 | 9.1% | 28% | +18.9 pp |
| +3 | +80 | −3 | 3.6% | 20% | +16.4 pp |
| +4 | +100 | **0** | **0.0%** | 14% | +14.0 pp |

1. **`loss = 0` at `g = +4` makes the biggest-payout bucket risk-free.** Break-even 0.0% ⇒ *any*
   non-zero win rate is +EV ⇒ queueing up is a pure printer with no downside. **Fix: `−5`.** Still 4x
   cheaper than an even loss, i.e. still "free" to a player, but not free to the arithmetic.
2. **`+10 / −40` at 2 tiers below needs an 80% win rate to break even, against a real ~72%.** In a thin
   queue a top player has **no other bucket available** — they cannot choose to be matched evenly. So the
   top of the ladder becomes strictly −EV and legends stop queueing, which kills the mode. **Fix: `+9 / −22`
   (71.0% break-even), and never let a down-gap loss exceed **−26**.
3. **Only 7 buckets, and "below" collapses at 2+, so `−3` and `−4` — the actual farm case — is unpriced.**
   The farm you must defend against is a champion hunting bronzes, i.e. `g = −4/−6`. **Fix: 9 symmetric
   buckets.**
4. **The draw row is exploitable at `g = −1`: draw −4 vs loss −28 = a draw is 7x cheaper than a loss.**
   When you are losing to a weaker team, stalling for a draw is strictly dominant. **Fix: keep the draw
   within ~3.5x of the loss on the down side (`−3` vs `−21` is 7x too — so I widened it to `−10` vs `−26`
   at `g = −4` and accept ~7x at `g = −1`, where the absolute numbers are small enough not to matter).**
   Flagged as a residual risk, not solved.

### 2c. The one place I am overruling the brief, and why

> "the inverse asymmetry on losses (losing to a much weaker team ≈ maximum cost)"

**The literal version is internally impossible.** Pair "beating a much weaker team pays almost nothing"
(+4) with "losing to them costs the maximum" (−50) and the break-even is `50/54 = 92.6%`. Against a real
~86% it is **−EV by 7 pp**, which means **it is strictly irrational for any strong player to accept a
down-gap match** — and in a thin queue, that is the *only* match on offer. The clause and the thin queue
are incompatible; you can have one.

**What I ship instead, which delivers the same intent:** `+4 / −26` = an **86.7% break-even**. You must
win 6.5 out of every 7 against a team 4 tiers below just to stand still. **That is the maximum cost, priced
as opportunity cost rather than as a big red number.** It is also the only version that survives §5's
thin-queue test.

**And the number the user should know before arguing:** the loss row is **already partly cosmetic**, because
of the sticky floor that is live today (`applyRankDelta`: `next = max(TIER_MIN[rankFloor], before + delta)`):

| situation | table says | **actually applied** |
|---|---|---|
| legend parked at 3200, loses to a bronze team | −26 | **0** |
| diamond parked at 1400, loses to a bronze team | −26 | **0** |
| legend at 3260, loses to a bronze team | −26 | −26 |
| gold at 520, loses to a bronze team | −26 | **−20** (clamped by gold's own 500 entry) |

**The "maximum cost" never fires for the exact player it targets** — a top player sitting at their tier
entry is already immune to every loss in the system. Raising the down-loss to −50 would change nothing for
them and only hurt mid-tier players. **One more reason the opportunity-cost version is the right one.**

### 2d. Why absolute, and not a multiplier on the shipped `BANDS`

A 4.20x **multiplier** on `BANDS` would also satisfy "4x", and is a smaller diff. I tested it and it fails
on the one axis that matters — **break-even win rate, i.e. whether "the gap" means one thing**:

| my tier | g = −4 | g = −2 | **g = 0** | g = +2 | g = +4 |
|---|---|---|---|---|---|
| bronze | **0.0%** | **0.0%** | **0.0%** | **0.0%** | **0.0%** |
| silver | 81.0% | 50.0% | 12.5% | 1.4% | 0.8% |
| gold | 89.5% | 70.0% | 24.2% | 4.4% | 0.9% |
| platinum | 94.3% | 81.6% | 37.5% | 7.1% | 2.3% |
| diamond | 97.1% | 89.4% | **51.6%** | 13.3% | 4.5% |
| legend | 97.7% | 92.9% | 66.7% | 21.2% | 6.7% |

- **"An even match" would have seven different prices, from 0.0% to 51.6%.** The gap stops being a price
  and becomes tier-noise.
- **Bronze becomes risk-free at every gap** — `BANDS[0].loss = 0`, and `0 × anything = 0`.
- A bronze upset would pay `30 × 4.2 = +126` = **63% of the bronze tier in one match**, worse than +105.

**The absolute table gives one monotone curve, 86.7% → 4.5%, for everybody.** What it gives up, and the
one-line replacements:

| lost property | replacement |
|---|---|
| bronze losses were 0 (new-player protection) | `if (rankPointsBefore < TIER_MIN[1]) loss = 0` — 1 line. `firstLossToday → 0` already exists and is untouched. |
| diamond+ crossover brake (`win < \|loss\|` stops top-end inflation) | **already redundant with `TIER_MIN`.** Widths are 200/300/400/500/**800**/**1000** — a 5x ramp. At a flat +25 that is 8/12/16/20/**32**/**40** wins per tier, and at `g = 0` the honest EV is **+5.58/match ⇒ 574 matches to legend.** The width *is* the brake. |
| per-tier streak scaling | `streakBonus` is flat (+2/win, max +10) today and stays flat. **Never scale it by gap** — it would compound. |

---

## §3 — (c) TEAM AGGREGATION IN 2v2 AND 3v3

### The formula

```
T_side = mean(tierIdx) + 0.5 · (max(tierIdx) − mean(tierIdx))          humans only
g      = T_opp − T_mine        clamped [−4, +4], fractional
```

**In 2v2 this is exactly `0.75·max + 0.25·min`.** **Do not implement the literal `0.75/0.25` form** —
**3v3 is live** and the literal form reads only the extremes and **deletes the middle player**:

| roster | literal `0.75·max + 0.25·min` | **`mean + 0.5·(max − mean)`** |
|---|---|---|
| 3v3 `[bronze, bronze, legend]` | 4.50 | **4.00** ✅ |
| 3v3 `[gold, gold, legend]` | 5.00 | **4.67** ✅ |
| 2v2 `[bronze, legend]` | 4.50 | 4.50 (identical) |

**Why the tilt and not mean or max**, for the carry case `[bronze 0, legend 6]` vs `[gold 2, gold 2]`:

| aggregate | my team reads | gap | the carried bronze's win |
|---|---|---|---|
| pure **mean** | 3.00 | −1.00 | **+15** ← a legend friend prints +15/win for a bronze account |
| pure **max** | 6.00 | −4.00 | **+4** ← over-taxes two near-equals in every normal match |
| **mean + 0.5·(max − mean)** | 4.50 | −2.50 | **+7.5** ✅ |

### The concrete matchups the brief asked for

| case | my T | opp T | g | **WIN** | **LOSS** | **DRAW** |
|---|---|---|---|---|---|---|
| **A. (bronze+bronze) vs (legend+legend)** | 0.00 | 6.00 | **+6 → +4** | **+105** | **−5** | +24 |
| A′. the legend side of the same match | 6.00 | 0.00 | −6 → −4 | +4 | −26 | −10 |
| **B. (bronze+legend) vs (bronze+legend)** | 4.50 | 4.50 | **0.00** | **+25** | **−20** | +2 |
| **C. (gold+gold) vs (diamond+bronze)** | 2.00 | 3.00 | **+1.00** | **+45** | **−16** | +8 |
| C′. the (diamond+bronze) side | 3.00 | 2.00 | −1.00 | +15 | −21 | −3 |
| D. (gold+gold) vs (gold+gold) — control | 2.00 | 2.00 | 0.00 | +25 | −20 | +2 |
| E. (bronze+bronze) vs (gold+gold) | 0.00 | 2.00 | +2.00 | +65 | −11 | +14 |
| F. **3v3** bronze×3 vs legend×3 | 0.00 | 6.00 | +4 | +105 | −5 | +24 |
| G. **3v3** (bronze,bronze,legend) vs gold×3 | 4.00 | 2.00 | −2.00 | +9 | −22 | −6 |

Note **C**: `(diamond + bronze)` reads **3.00**, i.e. one full tier above `gold+gold`, even though its *mean*
is 2.00. That is the tilt working — the diamond is the one who decides the match, so the gold pair gets
paid `+45` for beating them, not `+25`.

### Do both winners get the same delta? **YES. Same gap, same table, same number.**

- **The aggregate already solves the user's case.** `bronze+bronze` vs `legend+legend` is `g = +4` and pays
  **both bronzes +105**. "Level 1 beats two level 10s" is priced at 4.2x **without** any per-member term.
- **A per-member weak bonus would open the boosting hole and nothing else.** A bronze duoing with a legend
  is `g = 0` (case B) — the aggregate *correctly refuses* to pay them an upset bonus. Add a "the weaker
  member gets more" rule and you have just built a paid boosting service, funded by the strong partner.
- **One protection I do keep** (carried from seat `07`): if my own side's internal tier spread is **≥ 3
  tiers**, the loss uses the `g = 0` value (**−20**) instead of the down-gap surcharge. Duoing with a much
  weaker friend must never cost *more* than a solo even loss. The win side needs no exemption — the
  aggregate already handles it.
- **Bots are excluded from both aggregates.** Settled: ranked is humans-only, so this is definitional, and
  `fillBots` must not run in the ranked queue at all (it is the live `vsHuman=true` bug).

---

## §4 — (d) TIER INDEX OR RANK POINTS? — **TIER INDEX, MADE FRACTIONAL**

**Decision: key on the tier index, but compute it as a fractional position and interpolate between the 9
rows. Display it rounded.**

**For the tier index:**
1. **The user's mental model is literally "level 1 vs level 10".** A 9-row table he can read out loud is
   the product; a continuous logistic is a black box (that is what seat `07` built, and it was rejected).
2. **Seat `11` already ruled on this independently** (§2 ask #7): coarse tier index, "not exact points",
   because the delivery channel is a signed JWT claim that can be **up to 12h stale**, and a tier boundary
   is rarely crossed inside 12h. Exact points would be precisely wrong; a tier index is coarsely right.
3. **Privacy / behaviour.** Showing "2 דרגות מעליך" is fine. Showing an opponent's exact rankPoints turns
   every lobby into a scouting screen.
4. **The 20-point step is the teachable rule.** "Each tier above you is +20" survives contact with a
   14-year-old. "`1/(1+10^(gap/800))`" does not.

**For making it fractional** — the price of pure integer buckets, measured:

| opponent rank | my rank | integer bucket | **integer win** | fractional g | **fractional win** |
|---|---|---|---|---|---|
| 899 (gold) | 500 (gold) | g = 0 | **+25** | +0.9975 | **+44.95** |
| 900 (platinum) | 500 (gold) | g = +1 | **+45** | +1.0000 | **+45.00** |

**A 1-rank-point difference swings the payout by +20 — an 80% jump — under integer buckets.** Under
fractional interpolation the same 1-point difference swings it by `20/400 = 0.05` points. The tier widths
differ (200/300/400/500/800/1000), so "one tier of gap" is a *non-linear* function of rank points — which is
exactly right: the tier is the legible unit, not the point.

**Cost of fractional: ~6 lines** (`tierFrac(rp) = idx + (rp − TIER_MIN[idx]) / width`, plus a linear lookup).
**Integer buckets are an acceptable v1** if the chair wants the smallest possible diff — the cliff is a
tuning complaint, not a broken invariant — but fractional is strictly better and cheap.

---

## §5 — (e) DOES THE TABLE BREAK THE LADDER?

### 5a. The climb, recomputed

**Today's shipped bands, for reference** (reproduced exactly, so the comparison is honest):

| tier | width | win | wins @100% WR | net/match @50% WR | matches @50% WR |
|---|---|---|---|---|---|
| bronze | 200 | 30 | 7 | +15.0 | 14 |
| silver | 300 | 28 | 11 | +12.0 | 25 |
| gold | 400 | 25 | 16 | +8.5 | 48 |
| platinum | 500 | 20 | 25 | +4.0 | 125 |
| diamond | 800 | 15 | 54 | **−0.5** | **NEVER** |
| champion | 1000 | 12 | 84 | **−3.0** | **NEVER** |
| **total** | 3200 | | **197 wins** | | **a 50% player STALLS FOREVER at 1400** |

**My table, wins to each tier at a sustained gap (100% WR):**

| g | bronze | silver | gold | plat | diamond | champion | **TOTAL to legend** |
|---|---|---|---|---|---|---|---|
| −4 | 50 | 75 | 100 | 125 | 200 | 250 | **800** |
| −2 | 23 | 34 | 45 | 56 | 89 | 112 | **359** |
| **0** | **8** | **12** | **16** | **20** | **32** | **40** | **128** |
| +2 | 4 | 5 | 7 | 8 | 13 | 16 | **53** |
| +4 | 2 | 3 | 4 | 5 | 8 | 10 | **32** |

**And the number the brief actually asked for — a 50% win rate, and the honest model:**

| g | net/match @50% WR | matches to legend @50% | **EV/match at model P(win)** | **matches to legend, honest** |
|---|---|---|---|---|
| −4 | −11.0 | NEVER | +0.76 | 4211 |
| −2 | −6.5 | NEVER | +1.92 | 1667 |
| **0** | **+2.5** | **1280** (640 wins) | **+5.58** | **574** |
| +2 | +27.0 | 119 (60 wins) | +13.78 | 233 |
| +4 | +50.0 | 64 (32 wins) | +13.88 | 231 |

**Reading:** a correctly-placed player facing mostly even matches needs **~574 ranked matches to reach
legend**. In an event mode at ~20–40 matches per event that is **15–25 events**. Legend stays near-mythical,
which is what the settled docs want. **The absolute table is not a shortcut at gap 0** — it is a shortcut
only for people who keep beating better players, which is the entire point.

### 5b. THE DANGEROUS CASE — and yes, it breaks without a rail

**Single-upset test:** can one lucky match jump a tier?

| my rank | tier | +105 lands at | % of tier width | verdict |
|---|---|---|---|---|
| 0 | bronze | 105 | **52.5%** | over half a tier in ONE match |
| 150 | bronze | 255 | 52.5% | **crosses into silver — and the sticky floor makes silver PERMANENT** |
| 700 | gold | 805 | 26.2% | fine |
| 1300 | platinum | 1405 | 21.0% | crosses into diamond, permanent |

**⇒ Cross-checked against the sticky floor: yes, one lucky upset + `rankFloor` = a permanent free tier,
at the bottom of the ladder where tiers are narrow (105 > 200/2).** That is not acceptable and needs the
second rail.

**Thin-queue runaway (the real one).** Simulated: a player starting at rank 0 who meets a legend+legend team
**every** match, with the model outcome distribution, and the gap recomputed live each match (so it
auto-tapers as they climb):

| matches | **NO CAP** | **UPSET_BUDGET = 200** |
|---|---|---|
| 10 | 314 (silver) | 162 (bronze) |
| 20 | 618 (gold) | 200 (silver) |
| 50 | 1237 (platinum) | 200 (silver) |
| 100 | 1888 (diamond) | 202 (silver) |
| 200 | 3095 (champion) | 200 (silver) |
| **~290** | **3200 = LEGEND** | — |
| 400 | 4339 (legend) | **250 (silver)** |

**Uncapped, a ~14–20% win rate reaches LEGEND in ~290 matches. The ladder means nothing.** The bonus *is*
the ladder. Note that the gap taper alone does **not** save it — the taper slows the climb, it does not
stop it.

### 5c. Sensitivity — what if my `P(win|g)` model is wrong?

| model | g=−4 edge | g=0 edge | g=+2 edge | g=+4 EV/match |
|---|---|---|---|---|
| **mine (compressed / high-variance football)** | −0.7 pp | +5.6 pp | +13.5 pp | **+13.88** |
| Elo-like (favourites win 94% at 4 tiers) | +7.3 pp | +5.6 pp | +2.5 pp | +5.08 |
| very random / coin-flippy (28% at 4 tiers) | −14.7 pp | +5.6 pp | +22.5 pp | **+29.28** |

**The table's *ordering* survives all three** — `g = −4` is always the worst bucket, `g = +2…+4` always the
best. What changes is **how fast the 200 budget is spent**: 15 matches in the coin-flippy world, 40 in the
Elo-like one. **That is precisely why the budget is the load-bearing rail and the table is not.**

---

## §6 — (f) THE LOOSE MATCHMAKER: THE BONUS FIRES OFTEN, NOT RARELY

**The premise is correct and it is the central risk.** With a few hundred Hebrew-speaking teens and almost
nobody online at any given hour, a ranked queue that *waits for humans* will match whoever is there. Big
gaps are the **normal case**, not the tail. So the bonus must be capped by something other than rarity.

### The two rails, specified

```js
// ── RAIL 1: per-event upset budget ────────────────────────────────────────────────────────────
// bonus = delta(g) - delta(0) for the SAME result, counted ONLY when positive.
// A NEGATIVE bonus (the cheap loss at g>0) is NEVER capped — see below, this is load-bearing.
const UPSET_BUDGET = 200        // rank points per player per ranked EVENT
// 200 is not arbitrary: it is exactly the sum of the four full win bonuses.
//   g=+1 -> +20 | g=+2 -> +40 | g=+3 -> +60 | g=+4 -> +80   ==  200
// Narrative: "each rung of the ladder you skip pays full price ONCE per event."
// As a fraction of a tier: bronze 100% | silver 67% | gold 50% | platinum 40% | diamond 25% | champion 20%

// ── RAIL 2: per-match cap, so no single match buys a permanent tier ───────────────────────────
const MAX_DELTA_TIER_FRAC = 0.4  // cap |delta| at 0.4 x the width of the player's CURRENT tier
// bronze 80 | silver 120 | gold 160 | platinum 200 | diamond 320 | champion 400

// ── Placement exemption ───────────────────────────────────────────────────────────────────────
// A player's FIRST ranked event has NO budget. Placement is self-terminating (§6c) and throttling
// it just mis-seeds strong newcomers: a true diamond lands 543 (gold) unbudgeted vs 450 (silver)
// budgeted, over the same 20 matches.
```

### Why the loss side must be exempt from the budget — the best property in the design

Once the budget is spent, **wins and draws revert to their `g = 0` values but the loss keeps its cheap
gap-priced value** (because a negative bonus is never capped). At `g = +4`:

| state | EV/match |
|---|---|
| budget available | **+13.88** |
| **budget spent, loss stays −5** | **+0.04 → PARKED** |
| budget spent AND the loss re-priced to −20 | **−11.06 → punished for the matchmaker's failure** |

**⇒ With the budget spent, a thin queue neither helps you nor hurts you. You are parked, not punished.**
That is exactly the right posture when the player did not choose their opponent. **Do not re-price the loss.**

### Does the rail bind honest play? No — measured

A **gold** player (rank 600) over **60 ranked matches** against opponents drawn from the plausible live tier
mix (`seedRankFromXp` roofs at 900, so the population is bronze…platinum):

| seed | ended at | wins | **budget spent** |
|---|---|---|---|
| 1 | 935 (platinum) | 30 | **120 / 200** |
| 2 | 889 (gold) | 33 | **145 / 200** |
| 3 | 974 (platinum) | 34 | **80 / 200** |
| 4 | 967 (platinum) | 40 | **57 / 200** |
| 5 | 837 (gold) | 33 | **102 / 200** |

**The honest player never touches the ceiling; the pathological grinder hits it in 10 matches.** That is the
test a rail has to pass. Also note it barely matters *what* the number is: doubling it to 400 still parks the
pathological grinder at silver 250 after 400 matches, because the gap taper plus the −EV of gap-0 play at a
14% win rate does the rest.

### 6a. Two hard gates that are cheaper than any cap

1. **The upset table must be OFF for hand-picked opponents.** Under this table, at `g = +4`, deliberately
   queueing up is worth **+13.88/match vs +5.58 at gap 0** — **2.5x**. That is a *feature* when the
   matchmaker assigns the opponent and a **exploit** when the player picks. So: **ranked = matchmaker-assigned
   only. No challenges, no private rooms, no accepted invites on the rank track.** The settled ruling
   ("ranked is a special event, humans only") already implies this — write it down as a hard gate. This is
   one line and it removes the entire collusion surface, which no cap can.
2. **`UPSET_MIN_MATCHES = 5`: no upset bonus in your first 5 ranked matches** unless it is your first
   ranked event (placement). A brand-new alt at rank 0 is *unrated*, not *weak* — otherwise "make an alt,
   feed your main" is a `+105`/match pipe. Seat `07` and CS2 Premier both landed on a provisional window;
   this is the cheap version of it.

### 6b. Phasing: the top rows are dead code today, and that is good

The live population is capped at **platinum** (`seedRankFromXp` roofs at ~900). Computed observable gap range
at that distribution: **−2.00 … +2.00**. So the `+3` / `+4` rows **cannot fire in season 1** — the table's
practical range is `+9 … +65`. **Ship the whole table anyway** (the rows cost nothing) and expect the
extremes to come alive in season 2–3 as the first cohort climbs. **This is the safest possible rollout: the
scary numbers are unreachable until you have data.**

### 6c. The free win: this table IS the placement system

An UNRANKED player (לא מדורג) starting at rank 0 meets everyone at `g = +2…+4`, and the gap **auto-tapers to
0** as they rise. Simulated 20-match first event, no budget:

| true strength | lands (3 seeds) | verdict |
|---|---|---|
| bronze | 216 / 110 / 137 → bronze–silver | ✅ |
| gold | 376 / 376 / 350 → silver | ✅ (under-shoots, converges next event) |
| diamond | 543 / 480 / 569 → gold | ✅ (capped by the population, not the table) |
| legend | 694 / 577 / 709 → gold | ✅ (there is nobody above platinum to beat) |

**No provisional K-factor, no placement multiplier, no separate seeding math** — the gap table is one, and it
is self-terminating. That answers the settled UNRANKED requirement at zero extra cost.

### 6d. Inflation, for the record

Net rank injected into the system per match (both sides summed):

| g | underdog wins | favourite loses | **net** | favourite wins | net |
|---|---|---|---|---|---|
| 0 | +25 | −20 | +5 | +25 / −20 | +5 |
| +2 | +65 | −22 | **+43** | +9 / −11 | −2 |
| +4 | +105 | −26 | **+79** | +4 / −5 | −1 |

The table is net-inflationary, most at big gaps — and **with the sticky floor the favourite often pays
nothing at all, so the true injection at `g = +4` is up to +105 with no counterparty debit.** This is
inherent to a non-zero-sum ladder (which we already are, deliberately) and is what `UPSET_BUDGET` bounds.
**If the chair wants a stationary ladder instead, the single knob is `LOSS(0) = −25`, which sets the gap-0
break-even to exactly 50.0%** — at the cost of every even loss being 25% harsher than today's gold band.

---

## RISKS — most serious first

1. **The input still does not exist. This whole seat is unshippable until the wire lands.** The server
   cannot see opponent rank: `opponentKey = sha256(sorted userIds).slice(0,32)` is irreversible by design,
   `matchStart` (`server.js` L642) carries no ranks, and the game server makes **zero** outbound HTTP calls
   to pikme-server. pikme-server keys `rankPoints` on **phone**, the game server knows **userId**. Seat `07`
   §8 specifies the minimum path. **Nothing in this doc matters until that is funded.** Cheap interim:
   ship the table with `g = 0` forced (identical to a flat ladder) and turn the gap on when the wire lands.
2. **`P(win|g)` is my model, not a measurement, and the loss row was solved *from* it.** If the real game is
   coin-flippier than modelled (`g = +4` EV +29.3 instead of +13.88), the budget is spent in ~15 matches
   instead of ~40. The table's ordering survives (§5c) but the pacing does not. **Mitigation, in order:
   (i) log `gap` + `result` on every ranked match from match one; (ii) `UPSET_BUDGET` 200 → 120;
   (iii) re-solve the loss row from measured rates after one event.** All one-constant changes.
3. **Dropping `BANDS` is a bigger diff than "add an upset term".** `test-football-rank.mjs` L36-38 /
   L94-111 / L203-241 rewrite, and every "vs today" number in seats `06`/`08`/`09`/`11` is computed against
   `BANDS`. It does **not** break `test-rank-parity.mjs` (which checks only `RANK_TIERS`, `TIER_MIN`,
   `botCeiling`, `TIER_HE`) — but note seat `11` §7 found that parity test **exits green when the sibling
   checkout is absent**, so "parity is safe" is a conditional claim.
4. **`+105` at bronze can buy a permanent tier via the sticky floor** (§5b). `MAX_DELTA_TIER_FRAC = 0.4`
   clamps bronze to +80, which keeps a bronze at 95 inside bronze. **Rail 2 is not optional.**
5. **The `−26` down-loss is mostly cosmetic and the `+4` down-win is the real deterrent.** If the chair
   reads the loss row as "the punishment" and softens it, nothing changes; if they soften the **win** row
   upward, farming becomes viable. **The load-bearing number on the down side is `WIN(−4) = +4`, not
   `LOSS(−4) = −26`.** Say this in the commit message or someone will "fix" the wrong one.
6. **Legibility, and it is worse than seat `07`'s version.** A win now pays **+4 to +105** — a 26x range.
   Without a post-match chip that names the gap (`2 דרגות מעליך · ×2.6`), this reads as pure randomness,
   and unexplained ranked randomness is the #1 complaint in [`05-psychology`](05-psychology-migration-fit.md).
   **Ship the chip or do not ship the table.** The +20/tier rule is the thing that makes the chip
   believable — a player can predict the number before pressing play, which they cannot do with a logistic.
7. **Stall-for-a-draw is bounded but not eliminated.** `DRAW(+4) = +24 < WIN(0) = +25` and
   `DRAW(g) ≤ 0.5·WIN(g)` for `g ≥ 0`, so drawing up never dominates winning even. But at `g = −1` a draw
   (−3) is 7x cheaper than a loss (−21), so parking the bus against a weaker team is locally optimal.
   Whether that is reachable depends on the sim (seat `11` notes brawl is timed with no early end and
   40-goal games are reachable, which suggests 0-0 is hard). **Not my seat to verify; flagged with the ratio.**
8. **Two new stored fields** for Rail 1 (`upsetEventId`, `upsetBonusUsed`) in `data/footballstats.js`, which
   other seats are editing. Trivial code, contended file.
9. **Everything here is simulation on simulation.** The rank ladder's numbers have never been played in
   production at all (seat `11`: the roster bug pinned `isBotMatch` to `false`, so no bot defence has ever
   run once). Treat every EV in this doc as a prior to be replaced by measurement after one event.

---

## SOURCES

**VERIFIED — shipped games / published rules / published mathematics**

- **Elo / FIDE.** `E = 1/(1 + 10^((Ro−Rp)/400))`; K = 40 for a player's first 30 rated games, 20 below
  2400, 10 above. The 2x bound in §1a is **proved from the formula**, not observed. FIDE K-factors carried
  from [`04-economy-bots-math.md`](04-economy-bots-math.md) §3.
- **TrueSkill.** Defaults verified: `μ = 25.0`, `σ ≈ 8.333` (μ/3), `β ≈ 4.167` (σ/2), `τ ≈ 0.083`.
  Update `μ_w ← μ_w + (σ_w²/c)·v(t)`, `v(t) = φ(t)/Φ(t)`, `c² = 2β² + σ_w² + σ_l²`.
  [trueskill.org](https://trueskill.org/) (params + framing; the doc defers the V/W derivation to
  "The Math Behind TrueSkill" by Jeff Moser and to Herbrich/Minka/Graepel, *TrueSkill™: A Bayesian Skill
  Rating System*, NIPS 2006). **The v(t) ratio table in §1b is computed by me from that definition**
  (φ/Φ evaluated at t = 0…−5) — the *formula* is verified, the *ratios* are my arithmetic on it.
- **Rocket League** (modified Glicko-2). Even match **+8…+12** MMR; beating a significantly higher team
  **up to +20**; underdog win **+11…+13** / loss **−6…−7**; favourite win **+6…+7** / loss **−11…−13**;
  high-σ new accounts **30–50 per match**. Party matchmaking is "weighted more towards the highest-ranked
  player" (Champion+), lobby difficulty set by the highest-ranked player, undersized parties within 3 ranks.
  [Epic — how matchmaking and rank work](https://www.epicgames.com/help/c-202300000001622/c-202300000001682/how-does-the-matchmaking-and-rank-system-work-in-rocket-league-a202300000014019) ·
  [Immortalboost — RL ranks 2026](https://immortalboost.com/blog/rocket-league/ranks-ranking-system/) ·
  [Electronmagazine — MMR ranks 2026](https://electronmagazine.com/mmr-ranks-in-rocket-league-the-complete-2026-guide-to-understanding-and-climbing-the-competitive-ladder/) ·
  [trophi.ai — what is MMR](https://www.trophi.ai/post/how-does-ranking-and-mmr-work-in-rocket-league)
- **Clash Royale — Ranked Mode (ex-Path of Legends).** **No upset term whatsoever**: a win grants a step, a
  loss removes one, and **Golden Steps** at each league's bottom cannot be lost (their sticky floor).
  Trophy Road above 15,000 is a flat **±30 per battle**. Entry: 15,000 trophies this season, or Champion
  League last season. [Ranked — Clash Royale Wiki](https://clashroyale.fandom.com/wiki/Ranked) ·
  [Supercell — June 2025 update](https://supercell.com/en/games/clashroyale/blog/release-notes/june-update-2025/) ·
  [Immortalboost — Path of Legends guide](https://immortalboost.com/blog/clash-royale/path-of-legends-guide/)
- **Clash Royale — legacy ladder trophies.** "The higher your opponent is compared to you, the more trophies
  you gain if you win and the less you lose if you lose." Even ±30; opponent 100 below → **+20 / −40**;
  160 below → **+17 / −43**; invariant `gain + |loss| ≈ 60` (zero-sum, hence ≤2x on the win side).
  [In-depth guide on trophies](https://clashroyale.wiki/depth-guide-trophies/) ·
  [Trophies — Clash Royale Wiki](https://clashroyale.fandom.com/wiki/Trophies)
- **Brawl Stars Ranked (2026).** Rank Score (Elo-style) replaced trophies; gains scale up against
  higher-ranked opponents and down against lower. Tier widths **250 Elo (bronze/silver) → 750 (legendary)
  → 1000 (masters)** — independent precedent for our widening `TIER_MIN`. Masters+ is solo-queue only and
  large rank differences cannot party. [Ranked — Brawl Stars Wiki](https://brawlstars.fandom.com/wiki/Ranked) ·
  [timesaver.gg — ranked guide July 2026](https://timesaver.gg/blog/brawl-stars-ranked-guide-july-2026)
- **Tekken 8.** **Inverted gap term**: you gain and lose the most against your **own** rank; the points on
  offer *decrease* per rank of separation and bottom out past 3 ranks apart. Beating a higher-prowess
  opponent pays "slightly more … the increase isn't dramatic". Higher ranks put more points on offer overall.
  [Bandai Namco — Ver. 2.01 ranked adjustment](https://www.bandainamcoent.com/news/tekken-8-ver-2-01-ranked-match-adjustment) ·
  [Steam — about rank differences](https://steamcommunity.com/app/1778820/discussions/0/682986810375166353/) ·
  [Dot Esports — Tekken 8 ranks](https://dotesports.com/tekken/news/tekken-8-ranks-all-ranks-and-how-to-increase-your-rating)
- **Street Fighter 6.** Floor values: **minimum +50 LP on a win, minimum −40 LP on a loss**. Streak bonus
  50 → 75 → 100 below Platinum, **none at Platinum+**. More LP for beating a higher-ranked opponent; in
  Master, the swing scales with the MR difference. [Mixups — SF6 ranks explained](https://mixups.app/blog/street-fighter-6-ranks-explained/) ·
  [esports.net — SF6 ranks guide](https://www.esports.net/wiki/guides/street-fighter-ranks/) ·
  [Steam — LP gain and loss](https://steamcommunity.com/app/1364780/discussions/0/5188757896271647183/)
- **CS2 Premier** (Glicko-2). Rating hidden until 10 Premier wins; placement swings **300–500** vs
  **50–150** once established. Carried from [`07`](07-opponent-strength-math.md) §7f.
- **Our own shipped code.** `RANK_TIERS`, `TIER_MIN = [0,200,500,900,1400,2200,3200]`, `BANDS`
  (30/0/10 · 28/−4/8 · 25/−8/8 · 20/−12/5 · 15/−16/4 · 12/−18/3 · 10/−20/2), `applyRankDelta`'s sticky
  floor (`next = max(TIER_MIN[floorIdx], round(raw), 0)`), `streakBonus` (+2/win, cap 10),
  `OPPONENT_DAILY_LIMIT = 3`, `countMeetings`, `seedRankFromXp` — all read directly from
  `pikme-server/data/football-rank.js` and `football-mock/shared/rank.js`.
  `result ∈ {win, loss, draw}` is validated end-to-end (`routes-pikme/user.js` L1244, counters at L1337).
  `test-rank-parity.mjs` asserts **only** `RANK_TIERS`, `TIER_MIN`, `botCeiling(0..11)` and `TIER_HE`
  (L34-49) — **no delta assertions**, so this table is a one-repo change.

**INFERRED — my design; no shipped game uses these exact numbers**

- The whole 9-row table (win `4/6/9/15/25/45/65/85/105`, loss `−26/−24/−22/−21/−20/−16/−11/−7/−5`,
  draw `−10/−8/−6/−3/+2/+8/+14/+19/+24`).
- The `+20 per tier` win slope, the halving below 0, and the choice of `WIN(0) = 25`.
- The **`P(win|g)` model** `86/80/72/62/50/38/28/20/14 %` and the draw-probability model
  `6/8/10/12/14/14/14/13/12 %`. **This is the load-bearing assumption of the entire doc** and it is a prior,
  not a measurement.
- The `p* ≈ P(win) − 8 pp` derivation rule for the loss row.
- `UPSET_BUDGET = 200`, `MAX_DELTA_TIER_FRAC = 0.4`, `UPSET_MIN_MATCHES = 5`, the placement exemption, and
  the "never cap a negative bonus" rule.
- The decision to **replace** `BANDS` with an absolute table, and the `if (before < TIER_MIN[1]) loss = 0`
  replacement for bronze protection.
- Fractional tier index with linear row interpolation.
- `mean + 0.5·(max − mean)` as the 3v3-safe generalisation. (The *tilt-toward-max principle* is verified —
  Rocket League and Apex both weight parties toward the highest-ranked member; carried from
  [`07`](07-opponent-strength-math.md). The 3v3 correction and the 0.5 tilt are mine.)
- Every simulation in §5 and §6: the thin-queue runaway, the honest-player budget spend, the placement
  landings, the sensitivity sweep, the inflation table. **All computed by me from the table above — the
  rank ladder has never run in production, so these are simulations on top of simulations.**
