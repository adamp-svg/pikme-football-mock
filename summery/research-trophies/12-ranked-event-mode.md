# 12 — THE RANKED EVENT MODE (מדורג)

> **Seat: the ranked event itself.** Date 2026-07-26. RESEARCH + SPEC ONLY — no `.js` touched.
> Operates under the user's two rulings of 01:22: **rank is earned ONLY in a humans-only ranked event**,
> and **upsets must pay 3–5×**. `BOT_RATE` / `BOT_DAILY_CAP` / `botCeiling` are dead on the rank track.
> The upset multiplier itself is another seat's; every band below is the **base at equal rank (g=0)** that
> multiplier scales.

---

## 0. CONCLUSION — 9 rulings, in the order they matter

1. **SCHEDULED WINDOW, not an always-on queue.** Always-on at our size gives ~1 concurrent ranked player
   and a queue that never fills. Windowing is the only lever we have. **(§2b)**
2. **SHORT windows beat long ones, and the arithmetic is brutal about it.** Concurrency = attendees ×
   session ÷ window. A 3-hour window with 40 attendees gives C̄≈6.7; the *same 40 people* in a 75-minute
   window give C̄≈24. **Recommend 75 minutes, twice a week.** **(§2b)**
3. **Thursday 20:30 + Saturday 21:00 Israel time — NOT Friday.** The brief's suggested Fri 19:00–22:00 is
   the worst slot in the Israeli week: Shabbat dinner, and it excludes every shomer-Shabbat teen outright.
   Thursday night is the Israeli teen weekend-eve; Saturday 21:00 clears Shabbat end year-round
   (~20:25 July, ~17:10 December). **(§2b)**
4. **RANKED IS 1v1 (‎1 נגד ‎1 מדורג), not 2v2.** Highest-leverage call in this seat. 1v1 hits the 60s
   wait target at **C=2**; 2v2 needs **C=6** — 3× the population for the same wait. 1v1 also deletes
   teammate variance from a *losable* ladder and gives the upset multiplier exactly one opponent rank to
   read. And you need the 1v1 path anyway: it is the only honest 60s fallback for a starved 2v2 queue.
   `spawnPos` already handles `k===1` (VERIFIED `shared/sim.js:175` → `fy = 0.5`). **(§2b, §2c)**
5. **No bots, ever, on any ranked path — including the leaver path.** `fillBots` runs at four sites
   (`server.js` 483 / 510 / 576 / 646) *plus* `leaveCurrentRoom`, which backfills a bot mid-match. A ranked
   leaver **forfeits**; the room does not get a bot. **(§4 blocker 2)**
6. **Entry gate = 1,000 גביעים + 3 placement matches.** 1,000 is not arbitrary: it is literally
   `XP_TIER_MIN[1]` in shipped code (VERIFIED `football-xp.js:55`) *and* Brawl Stars' literal Ranked gate.
   3 placements, not Rocket League's 10 — with a 10-match event budget, 10 placements would eat a whole
   event. **(§2d)**
7. **NO seasonal rank reset. Reset the EVENT LEADERBOARD instead.** Every cited game resets because it has
   hundreds of ranked matches per season to re-climb; we will have 8–20 per *month*. Rocket League
   *Tournaments* is the right precedent — fresh bracket every session, persistent rating. **(§2e)**
8. **Rescale the ladder ~3.9× by raising `BANDS` only, not `TIER_MIN`.** VERIFIED: `test-rank-parity.mjs`
   compares `RANK_TIERS`, `TIER_MIN`, `botCeiling`, `TIER_HE` — **it does not touch `BANDS`**, and
   `shared/rank.js` does not export `BANDS`. So the band rescale is a **one-repo, no-parity-risk change**;
   editing `TIER_MIN` is two repos. Today's curve needs **975 matches at a 65% win rate to reach אגדה**;
   the rescale brings it to **251**. **(§2e)**
9. **`OPPONENT_DAILY_LIMIT = 3` will fire innocently on ~60% of players every event.** In a 10-match
   event against a ~9-player queue, the expected number of opponents you meet 3+ times is **0.96**
   (Binom(10, 1/8), P(X≥3)=0.119 × 8). Their 3rd win pays 0 and looks like a bug. Ranked needs a
   **decaying** repeat rate (100/60/30/0%), not a cliff. **(§2c)**

**Honest caveat up front:** *none* of the 7 cited games runs a windowed **rank ladder**. The windowed ones
(FUT Champions, Rocket League Tournaments) are windowed **tournaments layered on an always-on ladder**.
Our design has no exact precedent — it is FUT Champions' *structure* (windowed, gated, fixed match budget)
grafted onto Path of Legends' *persistent step ladder*. That is a defensible synthesis, not a copy.

---

## 1. PRECEDENT (a) — all VERIFIED, cited

| Game | Always-on / windowed | Entry gate | What resets | Queue starves → |
|---|---|---|---|---|
| **Brawl Stars Ranked** (replaced Power League, live 2024-03-04 09:00 UTC) | Always-on | **1,000 trophies**; Bronze–Gold needs **3 brawlers at Power 9**, Diamond+ needs **12 at Power 9** | **Monthly.** Feb-2025 rework: **−6 minor ranks** above Diamond I (was: reset to Bronze 1) | **Refuses to widen.** 2025 rework: *"matchmaking no longer increases Elo search range outside of your Rank restriction"* → longer wait over a bad match. **No bots in Ranked** — bots live in *trophy* matchmaking below ~100–400 trophies, far under the 1,000-trophy gate |
| **Fortnite Ranked** | Always-on, separate queue per mode | None beyond account | **Per season**, but underlying skill rating carries over so placements re-seat you fast | **The one cited game that allows bots in ranked** — but it is a 100-player BR where bots fill the lobby *tail*, not your opponent, and they "contribute less" as rank rises. Not transferable to 2v2/1v1 |
| **Rocket League Competitive** | Always-on | None | **Soft MMR reset** toward the ~600 median + **10 placement matches** per playlist, badge **hidden** until all 10 done; placement swings 12–15 pts vs the usual 8–10 | **Expands the MMR search band the longer you wait** ("widening search to include ALL levels"); v2.26 added an **average-wait counter** so the wait itself is the UI |
| **Rocket League Tournaments** | **WINDOWED** — fixed daily times per region (EU / US-E / US-W / Asia×3 / India / SAM / OCE), schedule in UTC in the in-game Tournaments tab | Registration only | Bracket is fresh every session; **rating persists** | **32-team single-elim bracket with byes** — a short-handed bracket advances people rather than cancelling |
| **EA FC Mobile Division Rivals** | Always-on play, **weekly points window** | Division standing | **Every Thursday**: points clear, **division standing persists**. Season end: **−5 ranks**, floored at Professional V. **Star Shields** absorb a relegation loss | n/a (huge population) |
| **FUT Champions** (EA FC 26) | **FULLY WINDOWED** — starts **Friday 11:00 PT** each week | **1,000 Champions Qualification Points + Division 6** (Div 7 and below get "Challengers" instead) | Weekly | n/a. Key structural borrow: a **fixed match budget** — **15 matches** (Champions Finals) / **5** (Challengers). Playoffs stage was *removed* in FC 26 to simplify entry |
| **Clash Royale Path of Legends** | Always-on | League standing | **Monthly, first Monday.** End of season → placed back at **Master 1** (a fixed point, not zero). Ultimate Champion starting rating **1,200–2,000** from prior win rate | n/a. Borrow: **step-based** win/loss + **Golden Steps** that a loss cannot remove |
| **CoD Mobile Ranked** | Always-on | None | **Seasonal**, scaled from last season's finish, not to zero. **5 placement matches** set the starting tier (5–0 can exceed your prior peak; 0–5 drops a full tier) | n/a |

**What the table decides for us**

- Entry gate: **1,000 trophies** is the single most-copied number in the set (Brawl Stars, literally). Take it.
- Placements: **everybody** cold-starts with placements (RL 10, CoDM 5, Fortnite "a few"). Non-negotiable.
- Reset: **everybody resets — because everybody has the match volume to re-climb.** We do not. Ruling 7.
- Starvation: the two games with any humility about population (**Brawl Stars** refusing to widen,
  **RL Tournaments** using byes) both accept a *worse experience* over a *fake* one. Neither backfills bots.
- Match budget: FUT Champions' 15/5 budget is the mechanism that makes a *windowed* ladder fair to people
  with less time. Adopt it at **10**.

---

## 2. THE NUMBERS

### (b) Always-on vs windowed — the arithmetic

**Queue model.** C = players in the ranked loop; each loops WAIT `w` → PLAY `p`; batch size N.
Poisson arrivals, batch-of-N service:

```
w = (N − 1) · p / (2C − N + 1)
```

`p` = 3.0 min INFERRED = countdown 5s (VERIFIED `COUNTDOWN_TIME = 5`, `server.js:75`) + match ≤120s
(`MATCH_DURATION = 120`) + VS/intro ~15s + post-match celebration & reveal ~40s.

**Median wait vs concurrency (p = 3.0 min):**

| C (concurrent) | 2 | 3 | 4 | 6 | 8 | 9 | 12 | 16 | 20 | 24 |
|---|---|---|---|---|---|---|---|---|---|---|
| **2v2 (N=4)** | — | 180s | 108s | **60s** | 42s | 36s | 26s | 19s | 15s | 12s |
| **1v1 (N=2)** | **60s** | 36s | 26s | 16s | 12s | 11s | 8s | 6s | 5s | 4s |

> Read the two thresholds: **2v2 needs C ≥ 6 to hit 60s. 1v1 needs C ≥ 2.** Split the queue into two rank
> bands and each halves: **2v2 needs C ≥ 12**, 1v1 needs C ≥ 4. This is ruling 4.

**Population side.** 300 registered (given). MAU/registered ≈ 50% for a niche single-language app
(INFERRED) → **150 reachable**. Event attendance for a recurring, push-notified, twice-weekly event:
25–40% of MAU (INFERRED) → **A = 38–60 attendees**, with a **floor case A = 15** (launch week, or a flop).

**Concurrency = A × session ÷ window.** With a 10-match budget ≈ 40 min of play, attendees stay resident:

| Window | Resident session | A=15 | A=40 | A=60 |
|---|---|---|---|---|
| 180 min (3h) | 30 min | **2.5** | **6.7** | **10.0** |
| 120 min | 35 min | 4.4 | 11.7 | 17.5 |
| **75 min** | **45 min** | **9.0** | **24.0** | **36.0** |
| 60 min | 45 min | 11.3 | 30.0 | 45.0 |

**A 75-min window is 3.6× the concurrency of a 3-hour window with identical attendance.** That is ruling 2.
The mechanism: a long window lets attendees *spread out*; a short one forces overlap. The match budget is
what keeps them resident — 10 matches × ~4 min cycle = 40 min, which is why 75 min is the floor, not 60.

**Resulting waits, 75-min window:**

| Scenario | C̄ (peak/mid) | C (last 15 min ≈ 0.3 C̄) | 2v2 median | 2v2 **tail** | 1v1 median | 1v1 **tail** |
|---|---|---|---|---|---|---|
| Floor, A=15 | 9 | 3 | 36s ✅ | **180s ❌** | 11s ✅ | 36s ✅ |
| Pessimistic, A=40 | 24 | 7 | 12s ✅ | 49s ✅ | 4s ✅ | 14s ✅ |
| Good, A=60 | 36 | 11 | 8s ✅ | 28s ✅ | 3s ✅ | 9s ✅ |

**Always-on, for contrast.** DAU ≈ 15% of 150 = ~22; avg 25 min/player/day → 550 player-min/day →
0.38 average concurrent; peak factor 6× for a single-timezone teen audience → **PCU ≈ 2–3 across the
whole game**, of whom maybe a third would pick ranked → **C ≈ 1**. Formula returns a negative wait for
2v2 at C<1.5 — i.e. **the queue never fills**. That is the death spiral, quantified.

### (c) Queue mechanics with no bots

**Escalation ladder** (INFERRED; modelled on Rocket League's expanding band, against Brawl Stars' refusal
to widen — Brawl Stars can afford to wait because it has millions of players, we cannot):

| t | Behaviour | Hebrew shown |
|---|---|---|
| 0–20s | Strict band: **±1 דרגה** | `מחפש יריב… 0:12` |
| 20–45s | Widen: **±2 דרגות** | `מרחיב חיפוש (±2 דרגות)` |
| 45–120s | **No band** — any rank pairs | `מחפש בכל הדרגות` |
| **120s** | **Stop.** Offer: keep waiting, or a normal match | `התור דליל כרגע` + `[ המשך לחכות ]` `[ משחק רגיל · גביעים בלבד ]` |

- **Max acceptable wait = 120s hard stop, 45s median target.** Rocket League's own answer to long waits was
  to *display* the average wait (v2.26) rather than fake a match — so surface the number and let the player
  decide.
- **After 60s with 3 players (the brief's question):** with 1v1 ranked this case **cannot occur** — 3 in
  queue means one match starts instantly and one player waits. That is the cleanest possible answer, and
  it is the strongest single argument for ruling 4. *If the user overrules and ranked is 2v2:* pair the two
  closest-ranked into a **1v1 ranked** match (full rank stakes — a 1v1 is a *cleaner* skill test than 2v2,
  not a lesser one), leave the 3rd queued with priority. **Never 2v1. Never a bot. Never a cancel** —
  a cancel teaches the player the mode is broken and they don't come back next window.
- **Repeat-opponent decay (replaces the `OPPONENT_DAILY_LIMIT = 3` cliff in ranked):**

  | Meeting # this event | 1st | 2nd | 3rd | 4th+ |
  |---|---|---|---|---|
  | Rank paid | **100%** | **60%** | **30%** | **0%** |

  Required, not cosmetic: at C=9 and a 10-match budget, opponents are drawn from ~8 others, so
  P(meeting a given person ≥3×) = **0.119** and the expected count of such opponents is **0.96 per player
  per event** — ~60% of players hit today's cliff *innocently*, every event. The cliff was designed against
  win-trading in an always-on ladder with thousands of possible opponents; in a 9-person queue repeats are
  *unavoidable and legitimate*. Keep the hard 0 at the 4th meeting for the actual win-traders.
- **Leaver = forfeit, and it must cost.** A humans-only ladder with a free quit is a ladder where every
  losing position is abandoned. Recommend: leaving a live ranked match records a **loss at 100% of the
  band**; the opponent gets the **win**. This is why `leaveCurrentRoom`'s `fillBots` call must be skipped
  for ranked rooms (blocker 2).

### (d) Entry gate + placements

| Gate | Value | Why |
|---|---|---|
| **גביעים** | **≥ 1,000** | VERIFIED double-anchor: it is exactly `XP_TIER_MIN[1]` in shipped code (`football-xp.js:55`) *and* Brawl Stars' literal Ranked gate. At doc-11 trophy rates (60 bot win / 120 human win / 15 loss floor) that is **~9–17 matches** — filters fresh installs, not skill |
| **Card / hero power gate** | **NONE** | Brawl Stars gates on 3 brawlers @ Power 9 because its ranked meta has a ban/pick phase. We have none. A card gate would lock the newest players out of the *only* human content we have — at 300 users we cannot spare them |
| **Tutorial** | Implied by the trophy gate | Don't add a second gate; one number the player can see is worth more than two they can't |
| **Placement matches** | **3** | RL uses 10, CoDM 5. With a **10-match event budget**, 10 placements = an entire event and the player leaves without a badge. 3 = 30% of one event, badge earned the same night |

**Placements pay trophies normally throughout; the tier badge stays hidden until placed** (Rocket League's
hidden-badge rule, VERIFIED). Placement seeding (INFERRED):

| Record | Seeded `rankPoints` | Tier |
|---|---|---|
| 3–0 | **560** | זהב |
| 2–1 | **340** | כסף |
| 1–2 | **210** | כסף (entry) |
| 0–3 | **70** | ברונזה |

**Final = `max(existing rankPoints, placementSeed)`** — this is what makes placements compatible with the
settled "nobody is reduced" rule for the `seedRankFromXp` cohort (up to 900 from bot-earned trophies).
A legacy player's first ranked event runs placements that can only **raise** them.

### (e) Season / reset, and the rescaled ladder

**No rank reset.** The reason every cited game resets is match volume: RL re-places you in 10 games,
Brawl Stars gives you a month of always-on play, CoDM 5 placements. We will produce **8–20 ranked matches
per player per month** at perfect attendance. A reset would consume the player's entire month. Adopt
**Rocket League Tournaments** instead: *the bracket is fresh every session, the rating persists.*

- **What resets:** a per-event leaderboard — `לוח האירוע`, best record in *that* window, own reward track.
  This is the competitive object; `rankPoints` is the long-term identity.
- **What does not:** `rankPoints`, `rankFloor`, `rankPeak`.
- **Inactivity:** a player who misses 4 consecutive events gets a **`לא פעיל`** marker on the badge — a
  *label*, not a points loss. A points decay would violate the sticky floor and read as erasure.

**Rescale: raise `BANDS`, leave `TIER_MIN` alone.** VERIFIED engineering reason: `test-rank-parity.mjs`
asserts `RANK_TIERS`, `TIER_MIN`, `botCeiling(0..11)` and `TIER_HE` — **`BANDS` is not checked and
`shared/rank.js` does not export it.** So this is a one-file, one-repo change with zero parity risk.

**Proposed `BANDS` v2 — base at equal rank (g=0), before the upset multiplier** (INFERRED):

| Tier | Points | Width | win | loss | draw | Today's win |
|---|---|---|---|---|---|---|
| **ברונזה** | 0–199 | 200 | **+70** | **0** | **+22** | +30 |
| **כסף** | 200–499 | 300 | **+60** | **−16** | **+18** | +28 |
| **זהב** | 500–899 | 400 | **+52** | **−24** | **+15** | +25 |
| **פלטינה** | 900–1399 | 500 | **+45** | **−32** | **+12** | +20 |
| **יהלום** | 1400–2199 | 800 | **+38** | **−38** | **+9** | +15 |
| **אלוף** | 2200–3199 | 1000 | **+34** | **−40** | **+7** | +12 |
| **אגדה** | 3200+ | — | **+28** | **−44** | **+5** | +10 |

Bronze losses stay 0 (shipped decision). The **win = loss crossover stays at יהלום** (±38), which is what
caps inflation at the top — same structural property as the shipped table, 2.5× the magnitude.

**Matches to reach each tier, cumulative:**

| Tier | @100% WR (new) | @100% WR (today) | @65% WR (new) | @65% WR (**today**) | Events @10/event | Weeks @2 events |
|---|---|---|---|---|---|---|
| כסף | 3 | 7 | **4** | 10 | 0.4 | **event 1** |
| זהב | 8 | 18 | **13** | 28 | 1.3 | **event 2** |
| פלטינה | 16 | 34 | **29** | 58 | 2.9 | week 2 |
| יהלום | 27 | 59 | **57** | 115 | 5.7 | week 3 |
| אלוף | 48 | 113 | **127** | 308 | 12.7 | week 7 |
| **אגדה** | 77 | **197** | **251** | **975** | 25.1 | **week 13** |

The `@100% WR (today)` column reproduces the brief's own figure — **197 wins to אגדה** (bronze 7 · silver 11 ·
gold 16 · platinum 25 · diamond 54 · champion 84) — so the model is calibrated against a number the user
already holds. **Net speedup 2.6× at a perfect record, 3.9× at a realistic 65%** (975 → 251); the gap between
the two is the loss term, which is why the realistic speedup is the larger one.

The shape is the point: **כסף and זהב land inside the first two events**
(a player leaves their first ranked night with a real badge), פלטינה/יהלום inside a month, and **אגדה is a
~3-month, 65%-win-rate achievement that 0–2 people out of 300 will hold.** That is what an אגדה should be.

**Interaction with the upset multiplier (other seat, 3–5×) — needs a cap.** At bronze, +70 × 5 = **+350**,
which skips ברונזה *and* most of כסף in one match. Recommend a hard per-match cap:

> **A single ranked match can never move you more than the width of your current tier.**
> ברונזה ±200 · כסף ±300 · זהב ±400 · פלטינה ±500 · יהלום ±800 · אלוף ±1000.

One rule, one line, and it still lets a genuine prodigy clear an entire tier in one upset — which is
exactly the drama ruling 2 asks for, without letting them skip two.

### (f) Hebrew / RTL UX

**Mode card — CLOSED** (dimmed, **never hidden**; hiding it means nobody learns the mode exists):

```
┌───────────────────────────────────┐
│  🏅 מדורג                  [ סגור ] │
│  נפתח בעוד ‎1 ימים ‎04:12            │
│  חמישי ‎20:30 · שבת ‎21:00            │
│  [ 🔔 תזכיר לי ]                     │
└───────────────────────────────────┘
```

- Countdown granularity: `>24h` → `נפתח בעוד ‎1 ימים ‎04:12` · `<1h` → `נפתח בעוד ‎41:12` (mm:ss) ·
  `<5min` → pulsing `נפתח בעוד ‎4:12`.
- **RTL bug class to pre-empt:** wrap every timer in `<span dir="ltr">` or `04:12` renders as `12:04`.
  Same for `‎7 מ-‎10` and all rank-point deltas.
- **`תזכיר לי` is load-bearing, not a nicety.** A window with no reminder is a window nobody attends;
  Rocket League and Brawl Stars both ship an in-client schedule surface for exactly this.

**Mode card — OPEN:**

```
┌───────────────────────────────────┐
│  🏅 מדורג   ● פתוח      נסגר ‎41:12 │
│  ‎9 בתור · ‎3 משחקים כרגע             │
│  נשארו ‎7 מ-‎10 משחקים                 │
│  [ שחק מדורג ]                       │
└───────────────────────────────────┘
```

- **`‎9 בתור` is the single most important anti-death-spiral element in this whole doc** — nobody queues
  because nobody is queueing; showing the queue is populated is the fix. Cheap: the server already
  broadcasts `{ type: 'home', online }` to every lobby member (VERIFIED `server.js:871-873`), so
  `rankedQueue` is a field on an existing broadcast, not new plumbing.
- **Never render a bare `0 בתור`.** At 0–1, show `‎1 בתור · הזמן חברים` + a share button.

**Searching / starving:** `מחפש יריב… ‎0:23` → `מרחיב חיפוש (±2 דרגות)` → `מחפש בכל הדרגות` →
`התור דליל כרגע` + `[ המשך לחכות ]` `[ משחק רגיל · גביעים בלבד ]`.
**The word `בוט` must never appear anywhere in the ranked flow.**

**`לא מדורג` on the hero badge** (`#hub-tier`, owned by `public/hub-rank.js`):

- **Not an 8th `TIER_MIN` entry** — that breaks `test-rank-parity.mjs` and every `TIER_ART[idx]` lookup.
  A separate render branch keyed on a new boolean.
- **Art:** dashed outline, greyscale `c1 '#d4dae0' / c2 '#8a939c'`. Prefer a **dashed shield glyph over an
  emoji** so it cannot be mistaken for a real tier (`❔` reads as "mystery reward", not "unranked").
- **Meter: dashed empty track, NO fill.** VERIFIED failure mode: `tierProgress(0)` returns `0`, and a
  0%-filled *solid* meter is visually identical to "ברונזה, no progress" — the exact confusion we're
  removing.
- **Label:** `לא מדורג` · **sub-line on tap:** `שחק ‎3 משחקי דירוג באירוע הבא כדי לקבל דרגה`
- **During placements:** `דירוג ‎2/3`, tier still hidden (Rocket League's rule).
- **The grandfathering condition, VERIFIED.** `rankSeeded` is **NOT** the discriminator —
  `footballDefaults` (`user.js:1190`) sets `rankPoints: 0, rankTier: 'bronze', rankSeeded: true` on
  brand-new accounts too. Correct test:

  > `unranked = (rankedMatches | 0) === 0 && (rankPoints | 0) === 0`

  A legacy account seeded to 640 shows **זהב**, unmarked. A brand-new account shows **לא מדורג**.
  Needs exactly one new field (`rankedMatches`). Note `footballPublicStats` has two
  `|| 'bronze'` fallbacks (`user.js:1148`) that will need the same treatment or the leaderboard shows
  unranked players as bronze.
- **Consider showing the TROPHY tier badge in that slot for unranked players.** At 300 users and ~40
  attendees, **~87% of the base will never touch rank**. The badge over the hero is the most valuable
  pixels in the app; showing a permanently frozen or `לא מדורג` state to 87% of players wastes them.
  Doc 11 §6 already established the trophy tier badge exists and is free (`tierFromStats` / `XP_TIER_MIN`).
  Swap in the rank badge only once placed.

---

## 3. RISKS

1. **The first window flops and kills the mode on arrival.** A ranked event with 5 attendees teaches
   everyone the mode is dead, and window 2 is smaller. **Mitigation:** announce 48h ahead with an in-app
   countdown, push at T−1h and T−5min, and have the user personally in the queue for the first 3 events.
   Set a kill-switch: if 3 consecutive events draw <10 attendees, fold ranked into a monthly single event.
2. **Thursday/Saturday is a guess about *this* audience.** The Shabbat and school-week reasoning is solid,
   but the actual peak hour is measurable and isn't measured. **Mitigation:** log `onlineCount()` hourly for
   two weeks *before* picking the slot. Cheap — the counter already exists.
3. **1v1 ranked measures a different game than the one people play.** The product is 2v2 football with a
   partner; a 1v1 ladder is honest about skill and dishonest about the game. Real cost, no clean fix.
   Partial mitigation: the 10-match budget makes ranked feel like a *tournament format*, which players
   accept being different (FUT Champs vs Rivals is exactly this).
4. **The sticky floor makes the top of the ladder riskless.** `applyRankDelta` never drops you below your
   peak tier's entry (VERIFIED). Combined with event-only rank, an אלוף can queue forever with **zero
   downside** — and the top of the ladder collapses back into "who attended the most", the precise
   trophy/rank confusion this whole redesign exists to remove. **Recommend the per-event leaderboard carry
   the competitive weight**, and consider softening the floor to *one tier below peak* above יהלום.
5. **Upset multiplier × rescaled bands can move 350 points in one match** if the per-match tier-width cap
   (§2e) is not shipped in the same commit as the multiplier.
6. **Repeat-opponent decay creates a new complaint:** "why did that win pay less?" Needs an explicit
   post-match line — `יריב חוזר · ‎60%` — or it reads as a bug, same as the cliff it replaces.
7. **Smurf / alt farming at 300 users.** A 1,000-trophy gate is ~10 matches, cheap to re-farm on an alt.
   `opponentKey = sha256(sorted userIds)` is per-*pair*, so it catches repeat matches but not a ring of 3
   alts rotating. At this population one determined teen can distort the whole top of the ladder. Partial
   cover from the decay table; full cover needs device- or phone-level linkage that doesn't exist.
8. **Windowed ranked concentrates load.** Every current match is a bot match spread thin; a window puts
   ~24 concurrent humans on one Render instance in 75 minutes, which is the first time this server has ever
   been asked to run ~6–12 simultaneous human rooms. Load-test before the first event.

---

## 4. BLOCKERS

1. **There is no trusted "this match was ranked" signal, and a client-sent one is a rank mint.** VERIFIED:
   `record-match` (`pikme-server/routes-pikme/user.js` ~L1240-1300) reads **only** client-posted body
   fields — `matchId`, `result`, `vsHuman`, `goalsFor`, `goalsAgainst`, `xpFactor`, `botLevel`,
   `opponentKey`, `stats`. There is **no `mode` field and no server-to-server channel**: the game server
   makes zero outbound calls to pikme-server, and results travel game → WebView → app → pikme-server.
   A modified client posting `ranked: true` would print rank forever.
   **Fix, and it is precedented:** the game server signs a short-lived per-match receipt with
   `FOOTBALL_TOKEN_SECRET` — already shared **both ways** (VERIFIED `shared/football-auth.js` verifies
   pikme-server-signed JWTs with it) — and relays it through the client exactly as `opponentKey` already
   is relayed for exactly this trust reason (`client.js:562-564`, `3459`). Bounded: +1 field on
   `matchStart`, +1 on `matchResult`, +1 verify in the route.
   **→ But `saltizFootball.js:32,35` DROPS unknown fields (doc 11 item 12), so this needs an iOS build.
   Ranked cannot ship on the backend-only release train.** This is the hard blocker.
2. **`fillBots` is unconditional on every match path, including the leaver path.** VERIFIED call sites:
   `server.js:483` (builder), `510` (bot game), `576`/`646` (matchmade + `startMatch`), and **inside
   `leaveCurrentRoom`** — which backfills a bot into a *live* match when someone quits. A ranked room must
   skip all of them, and a ranked leaver must forfeit. Note `fillBots` also pushes bot entries into the
   same `roster` the client receives, which is the live `vsHuman=true` bug (doc 11 §0) — so a ranked room
   that accidentally calls it would both cheat *and* mislabel itself.
3. **No scheduler exists anywhere in either repo.** No cron, no window state, nothing that opens or closes
   a mode. The window must be **server-authoritative** (a client clock is user-settable) and both repos need
   to agree on it — the game server gates the queue, pikme-server gates the rank write.
4. **No queue that waits.** `joinMatchmade` (`server.js:374-393`) opens a 5-second countdown
   (`COUNTDOWN_TIME = 5`) and starts with bots. A ranked queue is a genuinely new object: a persistent
   waiting pool, rank bands, an escalation timer, and no backfill. It is not a parameter on the existing path.
5. **1v1 has never existed** — `grep -rn "1v1|teamSize: 1"` across `server.js`, `shared/`, `public/client.js`
   returns **nothing**. The sim is ready (`spawnPos` handles `k===1`, VERIFIED `sim.js:175`) and `FORMATS`
   already supports a per-format field (the `FIELD_3V3` precedent), but the **field choice is unmade**: the
   2v2 main arena may be too wide for two players, and `roomTeamSize`/`roomMax`/`teamSlotList` at 1 are
   untested end-to-end.
6. **`rankedMatches` and the unranked state are new schema.** Plus `footballPublicStats`' two
   `|| 'bronze'` fallbacks (`user.js:1148`) must learn `'unranked'` or the leaderboard mislabels every
   unranked player as ברונזה.
7. **Push notification capability is unverified.** The whole window model depends on `תזכיר לי` actually
   delivering. I did not confirm the app has push wired. Verify before committing to a windowed design.

---

## 5. SOURCES

**Brawl Stars Ranked** — [Ranked · Brawl Stars Wiki](https://brawlstars.fandom.com/wiki/Ranked) ·
[@BrawlStars launch post (3 brawlers @ P9 / 12 @ P9)](https://x.com/BrawlStars/status/1764576844366430607?lang=en) ·
["RANKED IS DEAD, AND RANKED IS BACK" — Supercell, Feb 2025 (−6 ranks, Elo search range)](https://supercell.com/en/games/brawlstars/blog/news/ranked-is-dead-and-ranked-is-back/) ·
[All Brawl Stars Ranked mode details — 1,000-trophy gate](https://www.sportskeeda.com/esports/all-brawl-stars-ranked-mode-details) ·
[Ranked system rework](https://wowvendor.com/media/brawl-stars/ranked-system-rework/) ·
[Bot matchmaking below ~100–400 trophies](https://sportskeeda.com/esports/brawl-stars-trophy-pushing)

**Fortnite Ranked** — [How Fortnite Ranks Work](https://www.esports.net/wiki/guides/fortnite-ranks/) ·
[Ranked Mode Guide](https://boostmatch.gg/blog/fortnite/articles/fortnite-ranked-mode-guide) ·
[Bots in ranked lobbies, 2026](https://alviran.net/blog/fortnite-bots-bot-lobbies-guide-2026/)

**Rocket League** — [Party Skill and Matchmaking — Epic support](https://www.epicgames.com/help/en-US/rocket-league-c5719357623323/gameplay-c7262179951387/rocket-league-party-skill-and-matchmaking-a5720141173147) ·
[MMR guide 2026 — soft reset to ~600, 10 placements, expanding search range](https://electronmagazine.com/mmr-ranks-in-rocket-league-the-complete-2026-guide-to-understanding-and-climbing-the-competitive-ladder/) ·
[v2.26 patch notes — Average Wait Time counter](https://www.sportskeeda.com/esports/news-rocket-league-patch-v2-26-official-notes-average-wait-time-counter-added-fixes-known-issues-bugs) ·
[In-game Competitive Tournament Schedules — Epic support](https://www.epicgames.com/help/c-202300000001622/rocket-league-in-game-competitive-tournament-schedules-a202300000017270) ·
[Revamped Tournaments: A Closer Look](https://www.rocketleague.com/news/revamped-tournaments--a-closer-look) ·
[Tournament times by region](https://www.ggrecon.com/guides/rocket-league-tournament-times/)

**EA FC Mobile / EA FC Division Rivals** — [Division Rivals Deep Dive — EA](https://www.ea.com/games/ea-sports-fc/fc-mobile/news/rivals-update-division-rivals) ·
[Rivals Update patch notes — EA](https://www.ea.com/en/games/ea-sports-fc/fc-mobile/news/rivals-update-patch-notes) ·
[FC 26 Rivals format — Dexerto](https://www.dexerto.com/wikis/ea-fc-26-guides-walkthrough-tips/ea-fc-26-rivals-format/) ·
[Relegation & promotion explained](https://www.dexerto.com/ea-sports-fc/ea-fc-25-rivals-relegation-promotion-explained-2957998/)

**FUT Champions** — [How to qualify for FUT Champs in EA FC 26 — Dexerto](https://www.dexerto.com/wikis/ea-fc-26-guides-walkthrough-tips/how-to-qualify-for-fut-champs/) ·
[FC 26 Weekend League start/end times](https://www.thickaccent.com/2025/10/28/fc-26-fut-champs-weekend-league-start-and-end-times-revealed/) ·
[FC 26 FUT Champions guide — 15 / 5 match formats](https://timesaver.gg/blog/ea-fc-26-fut-champions-guide)

**Clash Royale Path of Legends** — [Ranked · Clash Royale Wiki](https://clashroyale.fandom.com/wiki/Ranked) ·
[Guide to the Path of Legends](https://mobilematters.gg/clash-royale/clash-royale-guide-to-the-path-of-legends) ·
[Path of Legends launch blog — RoyaleAPI](https://royaleapi.com/blog/2022-q3-update?lang=en)

**CoD Mobile Ranked** — [CODM ranked system — Rookie to Legendary](https://playaware.in/guides/codm-ranked-system) ·
[COD Mobile ranks 2026](https://vpesports.com/guides/call-of-duty-mobile-rank-table)

**Code, verified this session (not a source — the ground truth)** —
`football-mock/server.js` 75, 225-283, 374-393, 483, 510, 576, 596, 646, 871-873 ·
`football-mock/shared/sim.js:171-184` · `football-mock/shared/rank.js` ·
`football-mock/shared/football-auth.js` · `football-mock/test-rank-parity.mjs` ·
`football-mock/public/client.js` 559-582, 3456-3465 · `football-mock/public/hub-rank.js` 1-60 ·
`pikme-server/data/football-rank.js` · `pikme-server/data/football-xp.js:55` ·
`pikme-server/routes-pikme/user.js` 1140-1157, 1178-1195, 1240-1300
