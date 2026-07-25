# 16 — CURVE REFERENCE (the numbers, computed from the shipped code)

> Generated 2026-07-26 by executing `pikme-server/data/football-xp.js` + `football-rank.js`.
> Not a proposal — this is what the code does TODAY, plus the agreed slice-2 numbers where marked.
> Design rulings: [`11-DECISION-v2-progression.md`](11-DECISION-v2-progression.md) · ranked event: [`15-RANKED-EVENT-SPEC.md`](15-RANKED-EVENT-SPEC.md).

## The two tracks

| | גביעים / trophies | דרגה / rank |
|---|---|---|
| Field | `xp` / `level` | `rankPoints` / `rankTier` |
| Direction | **monotonic** — only up | up and down |
| Earned in | every match, incl. bots | **ranked event only, humans only** (user ruling 2026-07-26) |
| Measures | volume / hours | skill vs humans |
| Solo player | climbs forever | `לא מדורג` until they play ranked |

## Trophy level curve — TRIANGULAR, not linear

`xp to go L → L+1 = 100 × L` · `cumulative to reach L = 50 × L × (L−1)` · `levelFromXp` is the inverse.

| Level | This level costs | Cumulative |
|---|---|---|
| 2 | 100 | 100 |
| 5 | 400 | 1,000 |
| 10 | 900 | 4,500 |
| **12** | 1,100 | **6,600** ← unlocks the top bot ceiling |
| 15 | 1,400 | 10,500 |
| 20 | 1,900 | 19,000 |
| 30 | 2,900 | 43,500 |
| 50 | 4,900 | 122,500 |

## Trophies per match

Today: `base(win 100 / draw 50 / loss 30) + 10 × goalsFor`, × `clamp(xpFactor, 0.5, 1.0)`, `+200` first win of day.
Slice 2: `(20 PLAYED + 80 win / 30 tie / 10 loss + 10 × min(goalsFor,5)) × roster × meetTaper × botTaper`, `+200` first win of day.

| Roster | Win @3 goals | Draw | Loss | Note |
|---|---|---|---|---|
| 3 bots (×0.50) | 65 | 30–35 | 15–20 | unchanged |
| 2 bots + 1H (×0.65) | 65 → **85** | 35 → 39 | 20 → 20 | **+31% — the roster bug fix** |
| 1 bot + 2H (×0.80) | 95 → **104** | 51 → 48 | 29 → 24 | |
| 3 humans (×1.00) | 130 | 60–70 | 30–40 | unchanged |

Pre-roster totals are **100 / 50 / 30 — byte-identical to today**, so ask #2 adds four visible line items without moving any total.
`roster` is derived from the `xpFactor` the game already sends: `humanFrac = clamp((xpFactor − 0.20)/0.80, 0, 1)`, then thresholds `0.50 / 0.65 / 0.80 / 1.00`.

## Wins / games / days to each level

| Level | Total | Solo wins | Solo games @60% WR | Human wins | Human games @50% WR | Days @6/day solo |
|---|---|---|---|---|---|---|
| 5 | 1,000 | 16 | 22 | 8 | 12 | 3 |
| 10 | 4,500 | 70 | 96 | 35 | 53 | 10 |
| **12** | 6,600 | 102 | 141 | 51 | 78 | 14 |
| 20 | 19,000 | 293 | 405 | 147 | 224 | 40 |
| 30 | 43,500 | 670 | 926 | 335 | 512 | 91 |

⚠️ **The `+200` first-win-of-day bonus is worth 1.5–3.1 wins.** For a solo player at 6 matches/day it is **41% of daily trophies** — progression is
driven more by logging in than by playing well. Biggest single lever in the economy; flagged to the user 2026-07-26.

## Badge tiers on the trophy track (`XP_TIER_MIN`)

| Tier | Trophies | ≈ Level |
|---|---|---|
| ברונזה bronze | 0 | 1 |
| כסף silver | 1,000 | 5 |
| זהב gold | 4,000 | 9 |
| פלטינה platinum | 10,000 | 14 |
| יהלום diamond | 20,000 | 20 |
| אלוף champion | 40,000 | 28 |
| אגדה legend | 80,000 | 40 |

⚠️ The farm gates in `tierFromStats` (`winsVsHuman < 25` → cap gold) freeze a bots-only player at **gold at ANY total** — verified,
`{xp:1000000, wh:0}` → gold. With rank now event-only these gates are being **removed**: rank is the human-only badge, so the trophy badge
does not need to police bots.

## Rank ladder — today's flat bands (being replaced by the upset table)

| Tier | Points | Win | Loss | Draw | Wins to next |
|---|---|---|---|---|---|
| bronze | 0 | +30 | 0 | +10 | 7 |
| silver | 200 | +28 | −4 | +8 | 11 |
| gold | 500 | +25 | −8 | +8 | 16 |
| platinum | 900 | +20 | −12 | +5 | 25 |
| diamond | 1,400 | +15 | −16 | +4 | 54 |
| champion | 2,200 | +12 | −18 | +3 | 84 |
| legend | 3,200 | +10 | −20 | +2 | — |

≈197 wins to legend. That was sized for everyday play; with rank now event-only (4–10 ranked matches per event) the ladder needs rescaling —
see [`15-RANKED-EVENT-SPEC.md`](15-RANKED-EVENT-SPEC.md).

## Reproduce

```bash
cd pikme-server && node -e "
const x=require('./data/football-xp'), R=require('./data/football-rank');
console.log(x.cumulativeXpForLevel(12), x.computeMatchXp({result:'win',goalsFor:3,xpFactor:0.47}));
R.TIER_MIN.forEach((t,i)=>console.log(R.RANK_TIERS[i], t, R.BANDS[i]));
"
```
