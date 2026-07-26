# Bot personalities — behavior design and implementation direction

**Date:** 2026-07-26  
**Scope:** research/design only; no game code changed.

## Recommendation in one paragraph

Keep **skill** and **personality** as two different systems:

- **Skill** decides how well the bot executes: reaction time, aim, prediction, navigation, full-charge
  readiness, and whether it notices tactical opportunities.
- **Personality** decides what it wants: attack a body, protect a carrier, defend the goal, fetch the
  ball, pass, build, or spend bombs.

The current personas (`presser`, `poacher`, `tinkerer`, `anchor`) only add small offsets to
`aggro`, `toolSkill`, `wallCommit`, and `bushLove`. That can make bots statistically different, but
not visibly different. A real personality needs its own **priority profile, preferred targets,
formation position, charge policy, and tool budget**.

---

## Design rules

1. **A personality changes preference, not competence.** A weak Enforcer and a smart Enforcer should
   want the same things; the smart one predicts, aims, and times them better.
2. **“Always” means a dominant default, not permission to act impossibly.** An Enforcer should shoot
   whenever a valid enemy lane exists, but should not fire through stone, shoot a teammate’s new
   wall, or abandon a free goal.
3. **The objective overrides personality in emergencies.** If nobody else can collect a loose ball,
   the assigned chaser must fetch it. Personality may influence who becomes chaser, but must not let
   both bots refuse.
4. **Commitments must survive branch changes.** A charged shot, escort lane, wall build, or bomb push
   owns a target, premise, and expiry. Do not recompute it from scratch every tick.
5. **Use the sim’s physics.** Charge, interception, blast cover, wall collision, and kick reach must
   use authoritative sim helpers rather than new personality-specific estimates.
6. **Personality should be readable within 10–15 seconds.** The player should be able to say “this
   one hunts me” or “this one protects its mate” without reading a label.
7. **Keep teams fair.** Persona assignment must remain slot/mirror based. Do not key it on bot IDs;
   that previously gave one team a permanent statistical advantage.

---

## Core personality set

### 1. Enforcer — aggressive, full-power enemy shooter

This is the clearest version of the aggressive bot suggested by the user.

**Identity:** “If I can see an enemy, I am preparing to hit them.”

**Priorities**

1. Shoot the visible enemy carrier.
2. Shoot the closest visible enemy threatening the ball or goal.
3. Shoot a visible enemy even when they do not carry, especially to interrupt a wind-up.
4. Chase/intercept the enemy carrier.
5. Fetch the loose ball only when assigned as the team chaser.
6. Pass less often; prefer a forward clearance or direct attack.

**Charge policy**

- At high skill, begin charging **before** an enemy enters the firing gate.
- Bank the meter at **1.0 true maximum power**, not merely `FULL_CHARGE = 0.70`.
- Hold the charge while tracking a likely lane; release when a valid target appears.
- Revalidate the exact firing lane at release time.
- If the original target disappears, retarget the paid-for charge to another useful enemy, fragile
  wall, or loose ball. Cancel only when no useful target exists.

**Tool policy**

- Bomb tackle is preferred over mobility when the carrier is catchable.
- Walls are low priority except to trap an enemy carrier.
- Super is spent offensively rather than saved.

**Visible tell:** weapon is frequently charged; advances directly; fires fewer weak shots but more
maximum-knockback hits.

**Counterplay:** break line of sight, bait the shot into stone, change direction during its tracked
wind-up, or exploit the space it abandons.

---

### 2. Fortress — defensive builder and blast controller

This is the defensive bot suggested by the user.

**Identity:** “You do not get a clean route to our goal.”

**Priorities**

1. Stay goal-side of the ball.
2. Cover the carrier-to-goal lane, not merely the carrier’s body.
3. Build a wall across a predicted drive or shot lane.
4. Bomb beside/behind an attacker to push them away from goal.
5. Clear a loose ball from the defensive box.
6. Become keeper when the other bot is already contesting.

**Wall policy**

- Save at least one build charge for a real defensive event.
- Prefer walls that block an enemy lane while preserving the teammate’s outlet.
- Never build on the teammate, across the teammate carrier’s intended lane, or into a shot already
  winding up.
- Predict where the attacker will be when the wall appears; the build wind-up must own that target.

**Bomb policy**

- Aim the blast so push direction is **away from our goal or toward a touchline**.
- Do not plant at the enemy’s exact center because the current sim has a zero-direction bullseye
  singularity.
- Respect static-wall cover: a bomb behind stone does not push the protected target.
- Prefer bomb clearance when the ball is loose in the box.

**Possession policy**

- Low dribble appetite.
- On collection, make a safe forward outlet or clear the ball; do not carry through traffic.

**Visible tell:** retreats early, patrols the danger lane, builds before contact, and uses bombs to
reset pressure rather than to travel.

**Counterplay:** switch sides, force it to spend both wall charges, destroy fragile walls, then
attack during reload.

---

### 3. Bodyguard — carrier escort and enemy suppressor

This is the teammate-following personality suggested by the user.

**Identity:** “The carrier gets a protected route; I do not compete with them for the ball.”

**Formation**

- When a teammate carries, occupy one of two escort points:
  - **Ahead and goal-side:** between the carrier and the nearest defender.
  - **Side/rear screen:** between a chasing defender and the carrier.
- Pick the point that covers the most dangerous enemy firing/approach lane.
- Do not stand directly on the carrier or block the carrier’s shot/pass lane.

**Priorities**

1. Push or shoot the enemy most likely to reach the carrier.
2. Body-screen a chasing defender.
3. Clear fragile walls or enemies from the carrier’s route.
4. Receive a pass only when the carrier explicitly calls it.
5. Rarely fetch the ball; do so only if the team has no valid chaser or the ball is within an
   emergency radius.

**Shot policy**

- A suppressing shot must push the enemy **away from the carrier’s future path**.
- Never shoot from behind in the enemy’s travel direction; measurements show that this can make a
  chaser arrive sooner.
- High skill pre-charges while escorting so protection is ready before the enemy closes.

**Tool policy**

- Build screen walls between carrier and threat, but preserve the carrier’s movement/aim corridor.
- Bomb enemy intercept points, not the carrier’s feet.
- May use a cannon-pass setup only when the carrier’s route and landing space are safe.

**Visible tell:** mirrors the teammate’s advance, stays just ahead or to the threatened side, and
attacks defenders more often than it touches the ball.

**Counterplay:** attack from two sides, force the escort to choose one threat, or pass behind it.

---

### 4. Ball Hawk — objective-first collector

**Identity:** “Loose ball means my current plan is cancelled and I get there first.”

**Priorities**

1. Fetch every loose ball assigned to it.
2. Predict the rolling ball’s intercept point rather than chasing its current position.
3. Use a bomb jump only when it clearly beats walking and the flight path is safe.
4. After collection, make a quick forward pass or controlled clearance.
5. Avoid long combat wind-ups that could leave the team without a chaser.

**Possession policy:** short possessions, low trick appetite, high reliability.

**Why add it:** it gives the team an explicit solution to the repeated “nobody gets the objective”
failure without forcing every personality to behave the same.

**Counterplay:** bait it away with a loose ball, then win the second ball or attack the space behind.

---

### 5. Playmaker — pass-first field reader

**Identity:** “Move the defender, then move the ball.”

**Priorities**

1. Look for a forward or square pass before a contested shot.
2. Move to a visible outlet when the teammate carries.
3. Call and honor give-and-go runs.
4. Shoot only from a makeable range or to punish a completely open lane.
5. Use walls/bombs to create a passing lane rather than for personal mobility.

**Charge policy**

- Pre-charge the pass when the receiver’s run is stable.
- Size kick power from authoritative ball-roll physics.
- A high-skill Playmaker may hold a maximum charge for a long switch, but should not turn every
  short pass into a slow, over-telegraphed full-power kick.

**Visible tell:** moves into space, releases earlier, and deliberately involves the teammate.

**Counterplay:** deny the receiver, show a false lane, or pressure during the pass wind-up.

---

### 6. Saboteur — trap, wall-break, and bomb specialist

**Identity:** “Change the pitch and disrupt the opponent’s prepared play.”

**Priorities**

1. Destroy fragile walls cheaply.
2. Bomb predicted carrier positions.
3. Build anticipation walls in drive lanes.
4. Attack enemy builds before they become useful.
5. Use bank/deflection plays only when the solver finds a physically valid result.

**Difference from Fortress:** Fortress preserves territory; Saboteur spends tools proactively and is
willing to leave shape to disrupt.

**Visible tell:** high tool use, attacks constructions, creates scrambles.

**Counterplay:** bait tool spending, change direction continuously, then attack during cooldowns.

---

### 7. Keeper — dedicated last defender

**Identity:** “I protect the goal mouth and only leave when the danger is gone.”

**Priorities**

1. Stay between ball and goal.
2. Cover the most likely scoring lane while respecting kick reach.
3. Catch/block ordinary shots inside the penalty area.
4. Clear rebounds and loose balls in the box.
5. Leave the box only if the teammate has become the deeper defender.

**Tool policy**

- Defensive wall is a last-lane blocker, not a random nearby build.
- Bomb clears crowded rebounds away from the mouth.

**Risk:** in 2v2, a permanent keeper can make the teammate play 1v2. Use this personality only on
wall-rich/small arenas, or let it advance to a midfield anchor when the ball is safely far away.

---

### 8. Finisher — space-finding scorer

**Identity:** “Stay available, receive near goal, finish.”

**Priorities**

1. Move ahead of the teammate carrier without entering the same lane.
2. Find the open post/angle.
3. Receive passes and shoot quickly from makeable range.
4. Avoid unnecessary tackles and tool spending.
5. Chase a loose ball only in the attacking third or when assigned.

**Charge policy:** pre-charge as the pass approaches, then convert the reception into a full shot
without a second long wind-up.

**Visible tell:** fewer defensive touches, more off-ball runs and goal-area receptions.

**Counterplay:** track the run and deny the receiving lane.

---

## Smart-bot full-power readiness

The user specifically wants smart bots to power up **before** finding an enemy. This should be a
general high-skill capability, with persona-specific frequency.

### Proposed behavior: `readyCharge`

A smart bot may enter a persistent readiness plan:

```text
intent: readyCharge
chargeTarget: 1.0
aimPolicy: persona threat lane
releasePolicy: valid target + clear lane + useful push direction
expiry: short renewable window
```

It keeps holding until the meter reaches **1.0**, then remains ready. It does not need a currently
selected victim to start charging.

### Who uses it

| Personality | High-skill readiness |
|---|---|
| Enforcer | Almost constant when any enemy may enter view |
| Bodyguard | While teammate carries and a threat is approaching |
| Fortress | While defending a dangerous lane |
| Keeper | While a makeable enemy shot/drive is developing |
| Ball Hawk | Rare; movement and pickup are more important |
| Playmaker | For long passes, not every short pass |
| Saboteur | Before attacking enemies/builds |
| Finisher | While preparing to receive near goal |

### Difficulty scaling

- **Low skill:** begins charging after acquiring a target; may release at the minimum full threshold.
- **Medium skill:** pre-charges in obvious danger/attack states; reaches 0.70–0.85.
- **High skill:** anticipates the next engagement and banks 1.0.
- **Top skill:** banks 1.0, tracks a likely intercept point, rechecks the lane at release, and
  retargets rather than wasting the charge.

This creates a clean intelligence difference without random misses: smarter bots are ready earlier
and preserve paid-for wind-ups.

### Required safeguards

- Charging must not freeze movement.
- A banked charge must not accidentally become a kick when the bot picks up the ball; convert the
  plan deliberately to a kick or cancel it.
- Do not fire at an enemy just because one exists: verify wall lane, range/usefulness, teammate wall,
  and push direction.
- Preserve a visible tell. Constant perfect pre-charge with instant release can feel unfair; the
  charged weapon/aim direction should remain readable.
- Separate **maximum power 1.0** from the sim’s **full-effect threshold 0.70**. The current bot
  release path often treats these as equivalent, but the Enforcer request needs the true maximum
  knockback.

---

## Personality data model

Avoid another list of tiny scalar offsets. Use explicit policy fields:

```js
{
  id: 'bodyguard',
  roleBias: { chase: -0.7, support: +1.0, keeper: 0.1 },
  targetBias: { carrierThreat: +1.0, looseBall: -0.6, nearestEnemy: +0.4 },
  possession: { appetite: 0.2, passBias: 0.8, maxCarryS: 0.8 },
  shooting: { precharge: 0.9, maxCharge: 1.0, bodyShotBias: 0.8 },
  tools: { wall: 0.7, bombPush: 0.8, mobilityBomb: 0.1 },
  formation: 'escort',
  risk: 0.35
}
```

The numbers rank candidate intentions; they should not directly rewrite physics or bypass validity
checks.

### Selection model

1. Generate valid candidates from the current named plays.
2. Apply hard emergency rules: goal danger, only available loose-ball chaser, impossible lane.
3. Score candidates using game state + persona biases.
4. Add a commitment bonus to the currently executing plan.
5. Select a new plan only when it clearly beats the current one or the current premise fails.
6. Execute the plan every tick while selection may run less frequently.

This preserves named-play instrumentation while making personalities much stronger than small scalar
tilts.

---

## Team composition

In 2v2, do not pick two personas independently. Use complementary pairs:

| Pair | Feel |
|---|---|
| Enforcer + Fortress | pressure plus defensive safety |
| Bodyguard + Finisher | escort-and-score attack |
| Ball Hawk + Playmaker | reliable possession and passing |
| Saboteur + Enforcer | chaotic high-pressure team |
| Keeper + Finisher | deep counterattack; arena-dependent |
| Fortress + Playmaker | controlled, lower-risk team |

Avoid:

- two Keepers: nobody advances;
- two Bodyguards: both wait for a carrier;
- two Finishers: nobody reliably fetches;
- two Enforcers without an objective override: both may abandon the loose ball;
- two Saboteurs: tool spam and no stable formation.

For a human’s bot partner, personality can react to the human’s recent style:

- human carries often → Bodyguard or Finisher;
- human shoots constantly → Fortress or Ball Hawk;
- human stays deep → Playmaker or Enforcer;
- human rarely contests → Ball Hawk.

Do not change personality every possession. Select it at match start, or allow at most one clear
half-time/respawn adaptation so the identity remains readable.

---

## Additional personality details that make them feel alive

- Distinct preferred distance: Enforcer close-medium, Fortress medium-deep, Bodyguard 100–220px from
  carrier, Finisher ahead and wide.
- Distinct tool conservation: Fortress hoards one wall; Saboteur spends early; Ball Hawk saves bombs
  for travel.
- Distinct possession duration: Finisher/Enforcer carry longer, Fortress/Ball Hawk release earlier.
- Distinct target persistence: Enforcer tracks a victim longer; Playmaker abandons combat for an
  outlet; Bodyguard switches when the carrier’s main threat changes.
- Distinct aim tells: Fortress points at the danger lane, Bodyguard at the pursuing enemy, Finisher
  toward the expected pass/goal.
- Distinct mistake style at low skill:
  - Enforcer overcommits and can be sidestepped.
  - Fortress builds slightly late.
  - Bodyguard screens the wrong side.
  - Ball Hawk predicts too little lead.
  - Playmaker sees fewer passing options.
  - Saboteur chooses simpler traps.
  - Keeper reacts late to the post choice.
  - Finisher starts its run late.

These are deterministic execution limitations, not random “forget to act” rolls.

---

## Acceptance tests

Each personality needs behavior-distribution tests plus live-match outcomes.

### Identity tests

- Enforcer: highest enemy-shot rate, highest mean requested charge, most banked-charge time.
- Fortress: highest goal-side time, defensive builds, and attacker-away blast direction.
- Bodyguard: highest teammate-carrier proximity/coverage, lowest unassigned loose-ball touches.
- Ball Hawk: fastest loose-ball close time and highest assigned pickup share.
- Playmaker: highest called/completed pass rate and outlet availability.
- Saboteur: highest enemy-wall damage and tactical bomb/build attempts.
- Keeper: highest penalty-area occupancy, saves, and box clearances.
- Finisher: highest attacking-third off-ball time and pass-to-shot conversions.

### Safety tests

- Exactly one committed loose-ball chaser per team.
- No personality can refuse an emergency goal-line clearance.
- No shot releases into a teammate wall built during its wind-up.
- No defensive bomb pushes an attacker toward the defended goal.
- Bodyguard shots do not accelerate a chaser toward the carrier.
- Pre-charge does not convert accidentally when possession changes.
- Persona pairing is mirrored and does not change the difficulty ladder ordering.

### Measurement rule

Test both:

1. controlled fixtures proving the personality chooses its intended action; and
2. seeded whole matches on `MAIN_FIELD` plus generated arenas proving it actually reaches those
   actions.

Count sim effects, not repeated inputs during goal freezes.

---

## Suggested delivery order

1. Add first-class plan ownership and release-time lane revalidation.
2. Implement `readyCharge` and distinguish 0.70 full-effect from 1.0 maximum power.
3. Replace persona scalar offsets with explicit policy fields.
4. Ship three high-contrast personas first:
   - Enforcer
   - Fortress
   - Bodyguard
5. Add Ball Hawk as the objective-safety fallback.
6. Add Playmaker, Saboteur, Keeper, and Finisher after the first four are measurably distinct.
7. Add complementary team-pair selection and optional human-style matching.

The first release should favor **obvious identity over eight subtle variants**. Three personalities
that a player recognizes immediately are more valuable than eight that differ only in telemetry.

---

## Local evidence used

- `shared/bot-ai.js`: current four scalar-offset personas and the named play catalogue.
- `summery/bots logic handoff/README.md`: live shooting, pass, wall, visibility, and push-direction
  defects.
- `summery/bots logic handoff/LOGIC-HANDOFF-session.md`: commitment ownership and difficulty design
  law.
- `summery/bots logic handoff/SKILL_CATALOGUE.md`: measured wall, bomb, escort, shooting, and
  interception mechanics.
- `summery/bots logic handoff/ARENA-AUDIT-2026-07-26.md`: which named plays actually fire in whole
  matches.
- `summery/bots logic handoff/ARCHITECTURE-REVIEW-2026-07-26.md`: recommendation to preserve named
  plays while separating plan selection from execution.

No external research was needed for this pass: the repo already contains measured results for the
exact mechanics these personalities would use, which is stronger evidence than generic game-AI
patterns.

---

# FEEDBACK + IMPLEMENTATION NOTES (agent `chase-press`, 2026-07-26 19:2x)

**The design is right and I built the first slice of it.** What follows is measured feedback, not
opinion: three of this document's items were already delivered by the chase/press/belief work that
landed in `bc01c77`, `a232e9a`, `6fb0510`, and two of its acceptance tests cannot measure what they
claim. Numbers are MAIN_FIELD, both sides at the level-10 enemy skill 0.93, paired seeds, freeze
ticks excluded, and every one is a two-seed-base result — single-base numbers in this repo swing
enough to invent findings (I nearly shipped one; see "what fooled me" below).

## 1. Already built — delivery-order items 1 and 3's prerequisites, and the whole objective override

| this doc asks for | status |
|---|---|
| Design rule 3, "the objective overrides personality... must not let both bots refuse" | **BUILT.** `assignRoles` now publishes `role.chaser`: exactly one committed loose-ball chaser per team, picked by reach in GROUND with a rooted bot (bomb fuse / wall wind-up / catapult / kick-and-fly) charged `speed x 1.2s` and a rooted incumbent losing the role outright. Your safety test "exactly one committed loose-ball chaser per team" is satisfied by construction and asserted in `test-bot-chase.mjs`. |
| Ball Hawk's "predict the intercept point rather than chasing its current position" | **BUILT** for the chaser (`predictBall`) and for pressing a carrier (`interceptPoint`). |
| Ball Hawk's "bomb jump only when the flight path is safe" | **BUILT.** `cannonPlant` screens every candidate with `launchPathClear`, and its fallback — previously returned unscreened — now returns `null`. |
| Bodyguard's "never shoot from behind in the enemy's travel direction" | **NOT built**, and worth its own note: `clearMarker` still has no angle term. This document is right that it matters. |
| "Personality decides what it wants; skill decides how well" | Adopted. The persona table is now policy fields, not scalar tilts (below). |

## 2. Two acceptance tests cannot measure what they say

- **"Ball Hawk: fastest loose-ball close time."** `bot-feel.mjs`'s `reachS` is the time from the ball
  coming loose to *anybody* collecting it, in a symmetric match — so both personas move it, and a
  faster Hawk can raise it by contesting balls that previously sat untouched. Measured: my chase work
  improved `notClosingPct` (46.6 → 42.0, both seed bases) while `reachS` got **worse** (0.97 → 1.15s),
  because bots now chase balls they used to ignore, and some of those chases are long. Use
  *per-bot assigned-pickup share* and *closing rate while assigned*, never the team-wide `reachS`.
- **"No defensive bomb pushes an attacker toward the defended goal."** True and untestable today:
  `sim.js:1476 explode()` has a bullseye singularity (`ux = uy = 0` at dead centre, so maximum power
  produces **zero** knockback). A Fortress aiming "away from our goal" has no defined push direction
  when it lands on the target's centre. Fix or avoid `BOMB_CENTER_R`-range plants before asserting a
  direction.

## 3. `readyCharge` — right, and the constant it needs is already wrong in the file

Your §"Smart-bot full-power readiness" is the highest-value item here because the file currently
**cannot express it**: `finalize()` clamps every bullet to `FULL_CHARGE + 0.01 = 0.71`
(`bot-ai.js:3023`), so "bank 1.0 true maximum power" is unreachable by any bot at any level. Measured
consequence: **250px of knockback drift instead of 343px**, and the break-even head start in a 50/50
falls from 320px to 220px. Separating *full-effect 0.70* from *maximum power 1.0* is a two-line
change with a real, visible effect — do it in the same commit as the Enforcer or the persona will not
read as different.

Two safeguards to keep from your list, because both are live hazards rather than theory: a banked
charge must not silently become a kick on pickup (the existing `lostBall` cancel covers the reverse
case only, and the file records that cancelling the bullet-side wind-up costs a third of all releases
— **retarget, never cancel**), and the tell must survive (`preChargeP` already ramps from t=0.92 for
exactly this reason).

## 4. What fooled me, so it does not fool the next agent

Two traps, both directly relevant to your "Measurement rule" section — I would strengthen that
section with them:

1. **A single seed base invents findings.** My first A/B (6 matches) read "shots per match 83 → 52,
   touches 24.3 → 18" and looked like a serious regression. At 24 matches on two seed bases the same
   comparison is 46.8 → 43.0 and 30.6 → 49.6 — i.e. **noise with opposite signs**. Nothing below
   `MATCHES=24` on `>= 2` seed bases should be quoted, for any metric.
2. **`bot-feel` cannot see a press.** The press features measured *worse* on every felt metric
   (retreat-while-nearest 14.0 → 21.4) while doing their job well: a purpose-built dispossession probe
   (`press-probe.mjs`, added) shows strip rate **34.1/35.4% → 42.0/43.0% of all carries**, two seed
   bases, versus the same tree without them. A personality whose job is pressure will look bad on
   loose-ball tidiness metrics. **Each persona needs its own instrument before it is judged** — which
   is your §"Identity tests", and this is the evidence for why that section is not optional.

## 5. Scope note on the persona rewrite

I have replaced the four scalar-offset personas with the policy-field model from §"Personality data
model", shipped the three high-contrast identities plus Ball Hawk, and wired the fields into the
gates the named plays already read — **not** into a new scoring engine. Your §"Selection model"
(candidate generation → emergency rules → score → commitment bonus → less-frequent selection) is the
same object as `ARCHITECTURE-REVIEW` §3's A2 plan object, and it should be built once, deliberately,
rather than twice: a persona-specific scorer now would be the ninth hand-rolled instance of the
missing abstraction. The policy fields are written so that when A2 lands they become its weights
unchanged.

Full delivery notes, per-persona measurements and the surviving risks are in
`summery/BOT_HANDOFF.md` (this session's round) and `docs/superpowers/specs/`.
