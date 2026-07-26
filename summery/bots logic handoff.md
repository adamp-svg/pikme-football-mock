# Bots — logic handoff for the next bot agent

**Written 2026-07-26 by agent `bot-review`, after a session that fixed a real regression and got a
lot of things wrong first.** This file is the TRANSFERABLE part: the defect patterns, the measurement
traps, and the one design law that decided every argument today. The blow-by-blow changelog lives in
[`BOT_HANDOFF.md`](BOT_HANDOFF.md) (read §00000b → §00000 → §0000 → §000 → §4) and the request history
in [`../AGENT_REQUEST_LOG.md`](../AGENT_REQUEST_LOG.md).

Read this file first. It is short on purpose.

---

## 1. THE RECURRING DEFECT: a committed action whose wind-up outlives the branch that asked for it

Three separate bugs this session were the SAME bug wearing different clothes. `decideBot` is a chain
of branches, one of which is selected per tick. When a branch opens a multi-tick commitment
(`bm.charging`, `bm.buildHold`, a pass) and is then NOT re-selected next tick, the commitment survives
while **a different branch supplies the aim**. The commitment then completes, aimed at whatever that
other branch wanted.

| symptom the user reported | the branch that opened it | what actually fired |
|---|---|---|
| "the enemy shoots the other way" (releases 91-109° off) | a pass | a **shot at the enemy goal** |
| walls that don't block anything | `blockDrive` / `catapultWall` | a wall rotated **38-116°** off its lane |
| "the enemy shoots the other way" (bullets >45° off) | one of 5 press branches | a **bullet at the enemy goal**, hitting a player **0** times |

**How to spot the next one:** grep for anything stored on `bm.` that spans ticks, then ask "which
branch writes the aim on the tick this COMMITS?". If the answer isn't "the same one", it's this bug.
Every fix was the same shape: **latch the target/normal at arm time, re-derive only the magnitude,
and cancel when the premise dies.** Do not widen a tolerance instead — `dThetaAbs` is measured
against the *current* branch's aim, so a stale commitment reads as perfectly converged at 170° off.

Latched today, do not un-latch: `bm.passTo`, `bm.shootTgt`, the wall normal in `finalize()`,
`bm.cornerLatch`, `bm.detourSide`, `bm.pincer`, `bm.deflect`, `bm.cata`.

### 1b. The sibling defect: a TARGET recomputed from your own live position

Same family, different mechanism, and it produced the "the friend goes the other way" report.
`receivePass` moved a receiver "90px toward the carrier to show for the ball" — but that target was
**re-derived from the receiver's OWN live position every tick**, i.e. 90px behind wherever it had just
got to, re-issued ~50 times a second for the whole 1.4s call. A carrot on a stick: the receiver never
checked back 90px, it **retreated continuously, up to ~210px**, and the pass latch dutifully followed
it backwards. (It was already ahead of the carrier on **88%** of those ticks, so the whole manoeuvre
was wrong to begin with.)

**The tell:** a relative offset (`p.x - dir * k`) written into a target that is recomputed each tick is
a treadmill, not a destination. Either latch the spot **or** budget the total ground it may give up —
the fix here is `RECV_GIVE_MAX = 20`, a cap on cumulative retreat per call, because latching an
absolute spot measured WORSE (completion 86% → 70%, ladder rho −0.10). This file has now hit the
recomputed-target trap four times: the wall-cannon "pad" (0 arrivals of 449), `deflectSetup`'s stand
spot, `blockDrive`'s arm-on-arrival gate, and this.

---

## 2. THE DESIGN LAW: a behaviour made equally reliable for every tier FLATTENS THE LADDER

This decided four separate arguments today, and it cost three re-measurements to learn:

- the **pass latch** (round 5) raised completed passes 11→31 and dropped ladder rho 0.90→0.30
- **`clearForward` + `fetchBall`** ungraded: spread 1.10 → **−0.04**, top tier stopped beating the bottom
- the same two **graded by execution** (how much care about where the ball lands, how far the bot
  notices): the behaviour itself became a ladder — retreat-while-nearest **45.6% at t=0.05, 16% at 0.50**
- **`MOBILITY_GAP` flat** fixed the bomb-fuse idle and removed a real top-tier edge; a mild tier tilt
  (8.1s → 5.5s) kept both

**The pattern that works: same verb, graded execution.** Everyone clears the ball forward; a weak bot
clears it onto a defender. Everyone fetches; a weak bot only notices inside 345px. Never gate a whole
ability off for low tiers, and never hand a skill-independent ability to everyone.

**The pattern that does NOT work, measured seven-plus times (§4):** stochastic handicaps.
`decisionHz` in seven variants, `mistakeP`, and this session's skill-gated carry-aim deflection
(rho 0.90 → 0.70). A coin flip adds variance faster than it adds ranking, and the high tiers pay too.

---

## 3. MEASUREMENT TRAPS THAT COST THIS SESSION HOURS

**Every one of these produced a confident wrong conclusion that survived until someone re-measured.**

1. **THE WRONG ARENA, TWICE.** §00 opens with "every bot test ran on an arena the game does not use".
   It happened again: every ladder run for a full day used the bare 4-wall arena, because
   `test-bot-ladder.mjs` needed `ARENA=main` and nobody passed it. Same bots, same seeds:
   **rho 0.10 on the bare arena, rho 0.90 on the real one.** `ARENA=main` is now the DEFAULT there
   (opt out with `ARENA=default`). **Check every other harness before you quote it.**
2. **A THRESHOLD 0.015px OFF A REAL SPEED.** `bot-idle.mjs` called a bot "stationary" under 1.2px/tick.
   A wall wind-up walks at **1.185px/tick** (142.2px/s × `BUILD_WINDUP_SLOW` 0.5). The reported "idle
   moments" at L10 were a half-speed walk. At 0.8px: zero episodes. When a metric reads dramatic,
   check its threshold against the game's own speeds before believing it.
3. **A METRIC THAT CANNOT ANSWER THE QUESTION.** `bot-feel.mjs`'s `goalsPerMatch` is BOTH teams'
   combined score in a SYMMETRIC match — a scoring RATE. It cannot show a difficulty differential,
   and it was quoted as ladder evidence anyway. Only `test-bot-ladder.mjs` (anchor vs fixed reference)
   can rank tiers.
4. **A GATE TIGHTER THAN ITS OWN NOISE.** The ladder's zero-check tolerance (±0.15) was **1.2 SE**, so
   an unbiased harness failed it ~24% of runs — and those failures were read as "the instrument is
   broken". Tolerances are now 3 SE of the run's own SD. **A tolerance smaller than its SE is a coin
   flip.** Same story: `test-bot-cannon`'s agreement gate reads 63-88% across seed bases on identical
   code, and `test-bot-ladder`'s spread gate was calibrated on an arena that scores **2.2× more goals**
   (1.55/match vs 0.72), making a 0.60 *differential* arithmetically unreachable on the real one.
5. **A/B RUNS CONFOUNDED BY OTHER AGENTS — and a frozen base is not a safe answer either.** Three
   agents edited `shared/bot-ai.js` concurrently; at least two A/Bs were silently ruined (one tripled
   its shot count between "before" and "after"). Build both arms from `git archive HEAD shared`,
   differ by one line, and prove the OFF arm reproduces the pristine baseline first.
   **But then re-measure on the INTEGRATED tree before you ship.** One fix measured 90% → 92% on its
   own frozen base and **86% → 70% on the combined HEAD** once three other agents' commits landed; it
   was withdrawn and rebuilt. **Four individually correct measurements can integrate into a
   regression** — the last measurement of the day must be on the tree that ships.
   **THE METHOD THAT ACTUALLY WORKS — A/B `HEAD` against `HEAD` minus YOUR OWN hunks**
   (`git apply -R` of your commit; it applies clean if nobody touched your lines). That measures your
   marginal effect on the tree that ships and it **cannot go stale while you measure**, unlike a frozen
   base. The `git archive` advice above is only for reaching an OLD revision (bisecting); using it as
   your A/B baseline is what quietly encouraged three agents to freeze three different bases. Re-run
   that way, the wall fix reproduced and the defect was WORSE than first reported: commit aim drift up
   to **156°** on `catapultWall` and **206px** of placement error, against 0° / 44px shipped.
7. **A TEST THAT ONLY FAILS IN A SCRATCH CHECKOUT.** `test-rank-parity.mjs` requires the sibling repo
   `../pikme-server/data/football-rank.js` and deliberately refuses to self-disable ("a check that
   turns itself off is not a check"). It is **6/6 PASS in the real working tree** and a hard fail in any
   `git archive` scratch copy. It was reported as a new pre-existing failure; it was the LOCATION, not
   the revision. Before calling a test flaky, check whether it needs something outside the repo.
6. **UNSEEDED RUNS.** Identical code has reported wall-pinning from 0.27% to 0.51%. Always seed.

---

## 4. THE INSTRUMENTS (use these before writing any bot code)

| tool | question it answers |
|---|---|
| `node bot-feel.mjs` | the felt metrics: jam %, worst jam, wall-pops, possession, **advance per release**, **retreat-while-nearest**. `SKA=/SKB=` per side. API-minimal so it runs inside a `git archive <rev> shared` checkout — that is how the regression was bisected across a day of commits |
| `LVL=10 node bot-idle.mjs` | what is HOLDING a bot still, attributed by state. `STOP_PX` sweepable; read its header before trusting a number |
| `node bot-passes.mjs` | do called passes reach a team-mate (should be ≥85%) |
| `node bot-aim.mjs` | every shot classified: release vs bullet, angle off target, ghost or live, what it hit |
| `node bot-noise.mjs collect / analyze` | measures the LADDER HARNESS: noise floor, sample size for a given effect, 16 candidate ranking statistics, pairing schemes |
| `shared/arena-plan.js` | per-arena facts (shoot spots etc.), cached like the nav grid. **Unwired on purpose** — see §5 |
| `/_bot-scope.html` | bird's-eye 2v2 on the real arena, live `shared/` modules, every play announced in words. Generated from `scripts/bot-scope.template.html` — edit the template |
| `?watch=1&diff=N` | **watch an all-bot match in the real game** (real renderer, real server AI). Camera follows the ball |

**The LAN browser runs difficulty LEVEL 0 unless you pass `?diff=N`** — no `window.SALTIZ_XP` outside
the app. Half the "the bots are dumb" reports in this repo's history are that. Node does not
hot-reload: restart the server after any `shared/` edit.

---

## 5. THINGS THAT SOUND RIGHT AND ARE MEASURED WRONG

Additions to §4's refuted list. **Do not re-propose these without new evidence:**

- **A per-map playbook of tactical spots.** Built and measured. The map facts are real (54.8% of
  MAIN_FIELD has no clear ball lane to goal; 65% of positions can get a wall-cannon boost), and both
  consumers measured WORSE: routing a carrier to a shoot spot gave **0% arrival** (possessions last
  under a second — episodes lasted 0.28s and closed 303→283px), and moving it off-ball reintroduced
  **6.9-9.1s jams**. Module kept, unwired, refutations written at the ex-call-sites.
- **Walking to a computed spot, in general.** Third and fourth occurrence this session (after the old
  wall-cannon pad's 0-of-449). If a fix requires a bot to ARRIVE somewhere, measure arrival before
  measuring outcome. Prefer moving the *bomb* (`cannonPlant` lobs it) or acting from where the bot
  already stands.
- **Aborting a wind-up whose premise moved.** Every `ambushWall` hold aborted; builds 1.75 → 0.38/match.
  The strip that ends the wind-up wins the ball, which flips `wallSpotOk`'s own-lane test — the trigger
  destroys its own precondition.
- **A "pressure only" gate on the forward clearance.** Sounds safer; advance/release stayed at 4px,
  retreat got worse (23% → 29%), touches −27%.
- **Distance-scaled aim tolerance.** Indistinguishable once the bullet latch exists — only 3 bullets
  in 899 exceed 26° of aim error.
- **Antithetic seed pairing** in the ladder: ×0.5-0.6, i.e. worse. Its "perfect" null is an arithmetic
  identity, not precision. **Common random numbers, by contrast, is a free ×2** and is adopted.

---

## 6. WHAT IS ACTUALLY STILL WRONG (in the order a player would notice)

0. **"The friend goes the other way" is mostly the FLOW FIELD, and that part is correct.** Of the
   raw 22% of support ticks moving away from their own attack, **87-91% is the nav field routing
   around a capsule** (`bot-support.mjs` splits on `bm.wp`). Of the remainder: holding shape behind
   the carrier 7-12%, MIN_SEP 1-2%, past-the-outlet-line ~0%. So **read `awayNoDetour%`, never raw
   `away%`** — the raw number cannot fall below ~23% while walls exist, and chasing it means fighting
   the pathfinder. `receivePass` picks a TARGET; `steer()` picks the PATH; only the second one owns
   the remaining number.
1. **At high skill the ball sits loose ~71-79% of the match**, `notClosingPct` ~45%, and ~3.6-5×/match
   nobody reaches it for 4 seconds. **A bot walking away from a loose ball looks identical to a bot
   standing still**, which is why "they're idle" keeps getting reported after every idle fix. Strong
   bots shoot long and the off-ball bot holds `MIN_SEP` 320px. This is the biggest remaining feel bug.
2. **The middle three difficulty levels are indistinguishable.** On the real arena the ladder ranks at
   the ends (rho 0.90 goals / 0.90 strips / 0.90 shots-on-goal, top beats bottom) and the felt range is
   ~36% of the arena's scoring rate against a 39% design ask — but per-anchor order in the middle
   scrambles. A 12-level re-cut is pending the user's decision; it changes difficulty for every player,
   so it is not a tuning task.
3. **`backwardReleasePct` is ~15% at skill 0.93 vs 3.7% at 0.50** and it is NOT the opponent's
   counter-kick (re-measured with a 0.75s settle window). One backward-release path at the top of the
   ladder is still unfound.
4. **`laneClear` over-claims three ways** and everything shooting-related inherits it: it treats the
   ball as a point (radius is 32px), ignores the **goal posts** (6 of 26 "clear" shoot spots died on the
   woodwork), and its roll model is ~2% optimistic at the limit.
5. **`steer()` repels bots from the very walls the wall-cannon needs behind them** — which is why
   deliberate cannons sit at ~4% of launches while 65% of positions could support one. Best lead in the
   file for a real bomb-mobility improvement.
6. **Bots still body-block each other** for ~2% of move ticks at L10 (enemy bodies; team-mates are
   solved at ~1%). `seekContact` suppresses avoidance inside 140px of a carrier on purpose.

---

## 7. REPO HYGIENE THAT BIT US

- Take the orchestration lock (`football-mock:<path>`) before editing a shared file, and **re-read the
  file after acquiring it** — three agents were in `shared/bot-ai.js` at once today.
- **Commit by pathspec: `git commit -F msg.txt -- <paths>`.** `git add` swept another agent's staged
  files into someone else's commit twice. **Never `git reset`** in this repo — it undid a concurrent
  agent's commit and needed recovery.
- Numbers are only comparable within one snapshot. Say which arena, which seeds, and how many matches
  every time you quote one.
- **"Commit locally, never push" IS NOT A SAFETY BOUNDARY IN THIS REPO — measured 2026-07-26.**
  This repo is pushed **many times a day as a matter of course**: the full reflog holds **117
  `update by push` entries over eight days** (20 · 9 · 31 · 11 · 13 · 5 · 11 · 17 per day, from
  2026-07-19), and today's 17:07 push carried this agent's commits **5 minutes** after they were made.
  Combined with the game service autodeploying (CLAUDE.md, corrected in `0314eda`), **whatever you
  commit reaches production within the hour whether or not you push it**, so the decision point is the
  **commit**, not the push. Do not commit a change you would not ship.
  **The full six-instance "a window mistaken for the whole" table lives in `BOT_HANDOFF.md` §3 — read
  it before you quote any number.** It is the most useful thing this session produced.
  ⚠️ **And read the correction that goes with this, because two agents plus the lead all made it:**
  the first three reports of the above said "12/14 pushes today, starting 00:43, nothing explains it,
  probably a rogue sibling session" — because all three ran `git reflog | head`. **A `head`-limited
  window read as the START of a pattern is the same error as the frozen A/B base**: a bounded view of
  an unbounded thing, mistaken for the thing. `grep -c` the whole log before describing a cadence.
