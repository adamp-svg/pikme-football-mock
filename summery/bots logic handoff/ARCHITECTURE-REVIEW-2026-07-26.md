# Is the bots' way of THINKING the right one? — an architecture review

**Written 2026-07-26 ~18:3x, HEAD `27cd6e8`, by the agent the user asked three questions:**
*is the bot thinking option good · what alternatives are there · what are Brawl Stars and Fortnite
doing.* Research only — **nothing in `shared/`, `public/` or any `test*.mjs` was touched.** One file
was added: `bot-cost.mjs`, the instrument §1 is measured with. `test-bot-ladder.mjs` was already
modified by another agent and was left alone.

This is the fourth document in this folder and it is the only one about *architecture* rather than
defects. Read it **after** the other three, because it takes their findings as given:

| file | what it gives this one |
|---|---|
| [`README.md`](README.md) | 9 live defects, 16 measured skills, 6 refuted rules — the raw material for §2 |
| [`LOGIC-HANDOFF-session.md`](LOGIC-HANDOFF-session.md) | §1 "the wind-up outlives its branch" and §2 the ladder design law — the two structural claims below are its claims, generalised |
| [`ARENA-AUDIT-2026-07-26.md`](ARENA-AUDIT-2026-07-26.md) | re-verified every code claim on HEAD, and measured what the bots actually reach for in whole matches |

**What is new here:** a cost measurement nobody had taken, and the conclusion it forces.

---

## 0. The one-paragraph answer

The branch-chain controller is **good, and it is close to the end of its life as a *single* layer.**
It is not the wrong architecture for a 2v2 phone brawler — 43 of 46 named plays fire in live matches,
the ladder ranks rho 0.90 at its ends, and it is deterministic, seedable and better instrumented than
most shipped game AI. But two of its problems are **structural, not incidental**, and no number of
new branches will close either: `bot-ai.js` maintains a **second, wrong model of the sim's physics**,
and a multi-tick commitment is **not owned by the branch that armed it**. Both were rediscovered
independently by two agents this session, from opposite directions. And the measurement in §1 says
the thing everyone assumed was the constraint — CPU — **is not a constraint at all**: the entire bot
brain costs **0.31 µs per bot per tick**, 0.0075% of a 60 Hz tick. The design is not over-budget.
It is *under-powered relative to a budget nobody has spent*.

---

## 1. THE NUMBER NOBODY HAD TAKEN — `bot-cost.mjs`

Every "should the bots plan / look ahead / think less often?" argument in this repo's history has been
made without a cost figure. Here it is. MAIN_FIELD, 4 bots, seeded, 6 × 60 s, live ticks only:

```
node bot-cost.mjs                       # defaults: main, skill 0.82, 6x60s
SKILL=0.93 MATCHES=8 node bot-cost.mjs
ARENA=default node bot-cost.mjs
JSON=cost.json node bot-cost.mjs
```

| | µs / tick | share of a 60 Hz tick |
|---|---|---|
| **full tick** (`computeBotInputs` + `step`) | **5.84** | **0.035%** |
| …`computeBotInputs`, all four bots | 1.24 | 0.0074% |
| …**per bot** | **0.31** | 0.0019% |
| …`step()` | 4.25 | **3.4× the thinking** |
| `structuredClone(state)` | 36.5 | — |
| `JSON.parse(JSON.stringify(state))` | 20.0 | — |

Per-match spread 5.47–6.33 µs, so this is stable, not a lucky run. Three things in it are load-bearing:

1. **The sim is 3.4× more expensive than the bots' entire decision layer.** A 3,127-line hand-tuned
   brain with 46 tagged plays, a coordinator, a flow field and a fog-of-war belief model costs a third
   of a microsecond per bot.
2. **Thinking costs the same at every difficulty and on every arena.** Skill 0.82 → 1.24 µs, skill
   0.93 → 1.26 µs; MAIN_FIELD → 1.21 µs, bare arena → 1.21 µs. Meanwhile `step()` swings **4.25 µs on
   MAIN_FIELD vs 1.21 µs on the bare arena** — the *geometry* is what costs, not the deciding. So the
   ladder's problems are not compute-shaped, and the arena is where the sim's own budget goes.
3. **A rollout branch is dominated by the state COPY, not by simulating.** 20 µs to clone, 4.25 µs to
   step. Any lookahead work should start with a slim hand-rolled snapshot (players / ball /
   projectiles), not with optimising the sim.

### Can the bots afford to think AHEAD?

0.5 s horizon at 20 Hz = 10 coarse steps per candidate action, each charged at **full** `step()` cost
(pessimistic — a coarse step should be cheaper), 4 bots planning:

| candidates K | replan 60 Hz | 20 Hz | 10 Hz | 5 Hz |
|---|---|---|---|---|
| 4 | 1.00 ms (6%) | 0.33 ms (2%) | 0.17 ms (1%) | 0.08 ms (0%) |
| 8 | 2.00 ms (12%) | 0.67 ms (4%) | 0.33 ms (2%) | 0.17 ms (1%) |
| 16 | 4.00 ms (24%) | 1.33 ms (8%) | 0.67 ms (4%) | 0.33 ms (2%) |
| 32 | 8.00 ms (48%) | 2.67 ms (16%) | 1.33 ms (8%) | 0.67 ms (4%) |

**8 candidates replanned at 10 Hz costs 2% of a tick.** Lookahead is affordable, and it has been
affordable this whole time.

⚠️ **Three caveats, and they are in the instrument's header too:**
- **One room, on a developer Mac.** Render's CPU is slower and a box holds many rooms. The real budget
  is `tick cost × concurrent rooms`. **Divide every % above by the room count and re-measure on
  Render before believing it.** I have not run this on Render.
- **A finished match is free.** `step()` early-returns once the match is over and skips the player loop
  while `resetTimer > 0` (`sim.js:646`). My first attempt ran 20 k ticks on a dead state and reported
  `step()` at **0.0 µs**. This is `ARENA-AUDIT` §0's celebration-freeze trap in a new costume —
  the third time this session a harness has been fooled by a tick that does nothing. `bot-cost.mjs`
  counts freeze ticks separately and excludes any block containing one.
- **The timer is not free.** At ~1 µs per measurement, two `hrtime` calls are a real fraction of the
  thing measured. The tool calibrates the clock against itself (0.02 µs/call) and reports the split net
  of it; the *block* measurement is the authoritative total and the split is only the attribution.

---

## 2. What is actually wrong with the current way of thinking

The architecture, as the header of `bot-ai.js` describes it: a per-team **coordinator** assigns roles
with hysteresis → a per-bot **chain of ~46 plays** evaluated every tick → multi-tick commitments
latched on `bm.*` → **context steering** + flow-field nav → a 16-key **skill vector** interpolated
over `t ∈ [0,1]` → a per-team **fog-of-war belief**.

Three pathologies, and the point of this section is that they are **properties of the design**, not
bugs in it. All the specific defects are the other handoffs' findings, re-verified on HEAD by
`ARENA-AUDIT` §1 — I did not re-derive them and I have not re-measured their magnitudes.

### 2.1 There is a SHADOW PHYSICS MODEL, and it keeps diverging from `sim.js`

Read the live defect list as one class instead of nine items:

| what the bot believes | what the sim does | measured consequence |
|---|---|---|
| release gate `distGoal < 1150` | a full kick rolls **647 px** | **77% of L10 shots at goal cannot arrive** |
| pass charge `dist / 950` | reaches the receiver only to ~558 px, and anything below `FULL_CHARGE` is caught outright | **the completable and the safe pass sets are disjoint** |
| `laneClear` enemy radius 40.25 px | interception at **58.25 px** | the lane test is 18 px more optimistic than the physics |
| shot solved from `p.x, p.y` | the ball launches from the glue spot **58.25 px** ahead | 9–14 px of cross-error |
| `leadAim` speed = `full × charge` | `shotPower × (0.25 + 0.75c)`, then friction decay | the lead is systematically short |
| a wall bank is a mirror | **`atan(tan i / 0.62)`** | `goalBank`: **0 banks in 1103** positions, **0 fires in 28 matches** |
| `pointInBush()` | never reads `arenaOf(state).bushes` | both teams blind to a loose ball for up to **48 s** on one layout |
| `settings.shotPower \|\| 1850` | it is **1400** | 7 occurrences |

**Seven of the nine "live defects" are the same defect: `bot-ai.js` re-derives physics that `sim.js`
already computes.** You cannot fix that class instance by instance, and the file proves it —
`FINISH_RANGE` was rebuilt on the roll model in `64e0218` *specifically to kill this*, and the release
ladder at `bot-ai.js:1727` still carries `1150`. Survivors are structural. `docs/MECHANICS.md` being
stale in five places is the same disease in prose.

### 2.2 A COMMITMENT IS NOT OWNED by the branch that armed it

This is `LOGIC-HANDOFF` §1, and its own framing is the right one: three separate bugs this session
were one bug in different clothes, plus **four** hits of the recomputed-target treadmill (§1b). The
architecture selects a branch **per tick** but executes actions **across many ticks**, and there is no
first-class object for *"the plan I am executing, its target, its premise, and when it expires."* The
`bm.*` latches ARE that object — discovered one bug at a time, one field at a time. `bm.passTo`,
`bm.shootTgt`, `bm.cornerLatch`, `bm.detourSide`, `bm.pincer`, `bm.deflect`, `bm.cata`, the wall
normal in `finalize()`: eight hand-rolled instances of one missing abstraction. `bm.screenUntil`
being **shared by two unrelated behaviours** is what that looks like when it goes wrong.

### 2.3 Difficulty is ENTANGLED with the architecture — which is why `decisionHz` cannot work

`decisionHz` failed **seven times** across two councils, and `mistakeP` failed an eighth time when an
adversarial agent rebuilt it line-for-line. §4's autopsy is architectural, not a tuning story:
`carryT` / `blindT` / the progress ratchet are **integrators that must advance every tick**, and eight
branches early-return into `finalize()` with a hand-built aim.

**You cannot stale the thinking, because thinking and acting are the same function call.** That is the
whole finding. It is also why the middle three levels are indistinguishable and why the handoff
records "there is currently no working lever to make the bottom tier characterfully dumb" — the lever
does not exist because the layer it would act on does not exist.

So, to the user's question directly: **thinking at a lower rate is not a good option and never will be
in this shape — stop re-proposing it** (§4 already says so, eight times over). Thinking *deeper*, with
plan **selection** separated from plan **execution**, has never been tried, and §1 says it is cheap.

### 2.4 What is RIGHT about it, and must survive any change

Not everything here is a complaint, and a rewrite that loses these would be a regression:

- **Named plays.** 46 tags, 43 of which fire. The entire instrument suite — `bot-feel`, `bot-aim`,
  `bot-passes`, `bot-idle`, `bot-skill-census` — depends on a bot that can say what it was trying to
  do. This is the repo's single biggest asset and the reason bugs here get *measured* instead of argued.
- **Determinism.** Seeded, replayable, `personaOf` keyed on slot with no `Math.random`. A/Bs are
  possible at all because of this.
- **No cheating below the top tier**, and the top tier's cheats deliberately capped and probabilistic.
- **Graded execution over stochastic handicap** (§2's design law) — arrived at empirically, and it is
  the same conclusion Supercell and Epic ship (§4).

---

## 3. The alternatives, ranked by what this repo's own evidence supports

### A. Keep the chain; extract the two abstractions it is missing ✅ RECOMMENDED, DO FIRST
- **A1 · One physics oracle.** A single module answering *"where does this kick / bullet / lob end up,
  and does anything intercept it?"*, used by the bot and by the sim — or better, the bot calling sim
  primitives directly. `ballRollPx()` / `chargeForRoll()` already exist at `bot-ai.js:40-49`; the bug
  is that only some call sites use them. This retires §2.1 **permanently** instead of one line at a
  time. External precedent in §4: Rocket League's bot ecosystem ships a shared ball-prediction service
  precisely so that no bot re-derives trajectories.
- **A2 · A first-class plan object.** `{ intent, latched target, premise predicate, expiry, owner }`,
  one per bot. The chain **proposes**, an executor **disposes**, the premise is re-validated every
  tick, and cancellation is one code path instead of eight. This retires §2.2 — and it is what finally
  makes a deliberation-rate knob *possible*: stale **plan selection** at 5 Hz while **execution** stays
  60 Hz, so the integrators keep advancing. That is exactly the failure mode all seven `decisionHz`
  variants died of.
- Cost: refactors of code you already trust, no new behaviour, and both are re-measurable with the
  existing harnesses. ⚠️ Both change how often a bot wins the ball, so **`SEEDS=6 test-bot-ladder.mjs`
  after each**, and A/B `HEAD` against `HEAD` minus your own hunks (§3.5's method), not a frozen base.

### B. Real utility AI
The header calls the layer "utility"; it is a priority chain — first satisfied branch wins. Real
utility scores every candidate each tick and takes argmax with a commitment bonus. Buys organisation
and makes "why did it do that?" answerable as a score table. **The trap:** noise on the utility score
is a stochastic handicap, and this repo has measured stochastic handicaps failing eight times. The
version that fits your own design law is **deterministic myopia** — a weak bot evaluates *fewer
considerations*, not noisier ones.

### C. Rollout planning against the real sim — the strongest "thinking" option 🎯 THEN THIS
Enumerate K candidates (aim bucket × charge bucket × tool), snapshot the state, roll forward 0.3–0.8 s,
score the outcome, take the best. §1 measured it: **8 candidates × 4 bots at 10 Hz ≈ 2% of a tick.**
Why this shape fits *this* game specifically:
- It **deletes §2.1 by construction.** You do not model the physics, you run it. The
  77%-of-shots-cannot-arrive defect is *one rollout deep*.
- The difficulty ladder becomes **horizon × candidate count** — deterministic, monotone, and it spreads
  across `t` where `toolSkill` has saturated (`skillVec`'s own comment: L5→L11 spreads 0.150 on
  `toolSkill` and 0.500 on `t`). `t=0`: one candidate, no lookahead. `t=1`: 32 candidates, 0.8 s.
  It gives the middle three levels something to actually differ *by*.
- It reuses the asset you already have and Brawl Stars/Fortnite bots do not: **a cheap, deterministic,
  headless-runnable authoritative sim.**

Risks, stated honestly:
- **Opponent modelling.** Frozen-opponent rollouts overestimate. Hold enemy inputs constant, score
  conservatively, and never let a rollout's optimism become a gate.
- **Determinism / replay.** Verify `step()` on a clone touches nothing global (`state.rng` is the point
  of `makeRng`, but confirm it) or rollouts will perturb the match they are planning for.
- **The arrival trap.** Score the state **at the horizon**, never "did I reach the spot". Plans
  requiring arrival have measured ~0% arrival **four** times in this repo (`LOGIC-HANDOFF` §5).
- **Per-room budget.** §1's caveat. This is the one that could kill it, and it is a measurement on
  Render, not an argument.

### D. A learned policy (RL / imitation) — as an ORACLE, not as the shipped bot
`bot-cost` says a full tick is 5.84 µs ⇒ **~171 k ticks/s/core ≈ 2,850× realtime**. That is a
genuinely good RL environment, and Rocket League — the closest domain, physics + ball + boost
mobility — is the proof that this works, with community RL agents at roughly Grand Champion 1
(top ~0.5% of players). Against shipping it: inference on the game server, no tflite/ONNX in the
stack, 12 levels needing N policies or a conditioned one, replay determinism, and the total loss of
**named plays** (§2.4) — the entire instrument suite assumes a bot that can explain itself.
**Verdict: wrong for shipping, right as an oracle.** Train it offline, let it find the plays the
hand-written bot never takes, hand-code those. That is `decision-audit.mjs`'s job, automated.

### E. Behavior tree / StateTree / GOAP / HTN
The standard industry answers (§4: Epic's own stack). A rewrite buys organisation, not correctness —
the defects here are physics-model and commitment-ownership defects, and a BT ticking a tree has the
same selection-vs-duration problem. **The one property worth stealing is that a BT/StateTree task owns
its own duration** — which is A2 wearing engine clothes. Take the property, skip the rewrite.

### F. An LLM in the loop
No. 60 Hz, phone latency, cost, nondeterminism. Defensible only offline: design-time play discovery,
or Hebrew commentary / taunt text.

---

## 4. What Brawl Stars and Fortnite actually do

**Caveat first, and it matters: neither company publishes bot internals.** What exists publicly is
(a) observed behaviour, (b) the engine frameworks they build on, (c) stated design intent. Anything
more specific than that found on the web is inference, including some of the inference below — it is
marked.

### Brawl Stars (Supercell)
- **Why bots exist:** filling lobbies and sheltering new / low-trophy players. Supercell deliberately
  dresses them as real players (names, skins) so nobody feels palmed off.
- **Observed behaviour** — a short reactive rule set with deliberate tells: they aim at where you
  **are**, never lead (they use the same auto-aim the player gets); ~**0.125 s** of movement headstart
  after "Brawl!" and after respawn; ~**0.5 s** between tapping Super and firing it; and **per-mode
  scripted openers** (in Heist, defenders break left/right by spawn side; attackers move NE from the
  right spawn).
- **Inferred:** tile-grid pathfinding, per-brawler behaviour variation, no wallhack — bushes conceal
  you from a bot exactly as from a player.
- **The lesson `bot-ai.js:184` already cites:** variety comes from the **character**, difficulty from
  **information and reaction**, never from cheating. You have one character, which is why `PERSONAS`
  exists — that was the right call, and keying it on slot rather than id was the right fix.

### Fortnite (Epic)
- **Bots arrived in Ch2 S1 *with* SBMM, and this is the part this repo has not copied:** the **bot
  count** scales with player skill — low-skill lobbies are mostly bots — plus dynamic difficulty
  adjustment reacting to performance. **A large part of Epic's difficulty ladder lives in the
  matchmaker, not in the bot.** Players cannot configure bots at all.
- **Observed:** poor aim but very long detection range on clear line of sight; real building (ramps,
  walls); weapon use; storm avoidance.
- **Underneath:** navmesh navigation, LOS perception, and Epic's own AI stack — Behavior Trees + EQS
  historically, now **StateTree**, a hierarchical state machine merging BT selectors with FSM states
  and transitions (Mikko Mononen's deep dive, Unreal Fest Prague 2024; shipped for AI in *The Matrix
  Awakens* and *City Sample*), plus Mass AI for crowds.
- **The most useful artifact is the one Epic actually documents**, because it is a statement of which
  dimensions they believe bot difficulty lives on — **UEFN's Guard Spawner** exposes exactly:
  `Visibility Range` (default 40 m), `Visibility Range Restriction` (always / only-when-unaware),
  `Accuracy`, `Enable Patrol` + `Max Patrol Distance`, `Team Awareness Propagation`, and awareness
  states **unaware → suspicious → alerted → target-lost**. **There is no reaction-time knob and no
  "smartness" knob.** Perception, accuracy, leash, information sharing.
  Two of those you already have: `Team Awareness Propagation` is your per-team belief model, and
  `VIEW_BOX` is `Visibility Range` done more honestly than a radius. Two you do not: an explicit
  **awareness state machine** (a bot that is *suspicious* and searching, rather than seeing or not
  seeing) and a **leash**.

### So what does the AAA evidence actually argue?
**Both answers put difficulty in perception + accuracy + how many bots you face — not in degraded
planning.** That is the same conclusion this repo reached by deleting `decisionHz` seven times, and it
should be read as independent confirmation of §2.3 rather than as new information.

It also means **options C and D would put this game ahead of what Brawl Stars and Fortnite ship**, so
the justification has to be domain-specific rather than aspirational. It is: *a battle-royale bot does
not have a "will this kick physically arrive" problem.* **A football game does, and 77% of the level-10
shots at goal are that problem.** Which is why the right comparison is neither of them but
**Rocket League**, the other physics-ball game — where the two relevant facts are that the bot
ecosystem ships a shared **ball-prediction oracle** so nobody re-derives physics (= A1), and that the
strongest agents are **RL-trained rather than scripted** (= D, the long game).

---

## 5. If you are deciding what to do next, this is the order the evidence argues for

The defect-level order is `ARENA-AUDIT` §4 and it is still right — do that first, it is three lines
for the biggest leak in the file. This is the **architecture** order, which runs *underneath* it:

1. **A1 · the physics oracle.** Every fix in `ARENA-AUDIT` §4 is an instance of it; do the first two by
   hand, then hoist the model rather than fixing the seventh.
2. **A2 · the plan object.** Retires §2.2's whole family, and it is the prerequisite for any
   deliberation-rate lever ever working.
3. **Then C behind a flag, top tiers only.** With A1 done there is no shadow model left to disagree
   with, so a rollout is cheap to add and easy to falsify. Measure on **Render**, per room, before
   believing §1's table.
4. **Independently of all of it: put some of the ladder in the MATCHMAKER** (§4, Fortnite). The middle
   three levels are indistinguishable *as bots*; the partner/enemy skill pairing and — once 3v3 lands —
   the bot **count** are levers that do not require the bot to be smarter. This is the cheapest
   remaining difficulty axis in the game and nothing in `bot-ai.js` can reach it.

---

## 6. Where I could be wrong

- **§1 is one room on a developer Mac.** Not Render, not with concurrent rooms, not on a phone's
  client-side sim. The rollout table is a feasibility argument, not a production budget. **This is the
  claim most likely to be wrong in a way that changes the recommendation.**
- **I re-derived none of the defect magnitudes in §2.1.** They are the other three documents' numbers;
  `ARENA-AUDIT` §1 re-verified the *code claims* on HEAD, and per its own §348-style warning, the
  magnitudes were measured on older trees. Re-measure anything you act on.
- **Nothing here is implemented, and no behaviour was changed.** The only new file is an instrument.
- **§4 is thin by nature.** Supercell and Epic publish behaviour and frameworks, not bot source. I
  have marked inference as inference; do not let "Brawl Stars does X" harden into a citation when the
  evidence is a wiki page written by players.
- **A2 is the claim I am least able to prove.** That a plan object would have prevented the
  wind-up-outlives-its-branch family is an argument from the shape of the bugs, not a measurement.
  The cheap test is to build it for **one** behaviour (the bullet strip, which has the best
  instrumentation in `bot-aim.mjs`) and see whether the latch fields disappear.
- **I did not try to make the case for the status quo.** If the next agent thinks the chain plus
  disciplined latches is the right end state, the strongest evidence for that position is §2.4 — the
  named plays and the determinism are worth more than architectural tidiness, and any change that
  costs them is a bad trade even if it is a better design.
