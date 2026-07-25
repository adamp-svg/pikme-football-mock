# Mode polish — making the existing matches feel better

> Design spec, 2026-07-25. Scope: the **existing** modes (`quick`, `brawl`, `botgame`, `private`).
> No new modes, no new mechanics — this is about match *flow*, *tension*, *feedback* and the *loop back*.
> Written from a read of the live code; every claim below is cited `file:line`. Nothing here was edited.
>
> **Coordination:** `server.js` and `shared/sim.js` are being edited by other agents right now
> (assists/touches landed in `75b7c1c`). A `mode-3v3` agent and a `lobby-picker` agent are also live —
> §6 (mode roster) must be reconciled with whatever 3v3 lands as. Take `football-mock:<path>` locks.

---

## 0. What the match actually is today (verified)

| Thing | Value | Where |
|---|---|---|
| Match clock | 120 s | `shared/constants.js:57` |
| Win target (normal 2v2) | first to 3 | `shared/constants.js:58`, applied `server.js:550`, `server.js:440`, `server.js:607` |
| Goal-brawl | `goalsToWin = 0` → timed only | `server.js:328` |
| Pre-match countdown | 5 s | `server.js:71` |
| Pre-kickoff promo (sim frozen) | 4.6 s | `shared/constants.js:63`, `server.js:642-646` |
| Kickoff freeze | 0.7 s | `shared/constants.js:59` |
| Post-goal reset | 5 s total, 2 s of it frozen in the scoring pose | `shared/constants.js:60-61`, `shared/sim.js:564-584` |
| Final-score hold before you're kicked out | 6 s | `shared/constants.js:62`, `server.js:679-680` |
| Per-player stats | `goals/assists/strips/saves/shots/bombs/walls/touches/possSec/distPx` | `shared/sim.js:229` |
| Stats delivery | one JSON `matchStats` to **each human, their own row only** | `server.js:664-678` |
| Stats usage | forwarded to the RN app; **never rendered** | `public/client.js:2786-2789`, `:510-542` |
| End-of-match UI | one canvas word (`ניצחון!` / `כמעט!` / `תיקו`) over a frozen pitch | `public/client.js:4630-4642` |

---

## 1. Play the tape — the lifecycle, beat by beat

### 1.1 Pick mode → lobby
- Hub has **two public 2v2 buttons** that look and play almost identically: `quick-match-btn`
  (`public/index.html:81`, handler `public/client.js:1990`) and `goal-brawl-btn`
  (`public/index.html:125`, handler `public/client.js:1969`). The only difference is `goalsToWin`.
  A player cannot tell from the pitch which one they're in — see §3.1 and §6.
- **DEAD MOMENT — the matchmaking window is 5 s and never extends.** `quickMatch()` opens the
  countdown on the *first* joiner (`server.js:317`) and `startCountdown` is only called
  `if (room.phase === 'lobby')`, so a second human arriving at t=4.9 s gets 0.1 s of lobby and a
  third arriving at t=5.1 s forms a *brand new room*. With a small live population you are almost
  always playing three bots. This is not cosmetic: `xpFactor` scales earned XP by the human
  fraction, `0.2 → 1.0` (`public/client.js:516-524`). **A bot-filled match pays 20% XP.** The 5 s
  window is quietly the biggest XP tax in the game.
- **UNCLEAR STATE:** the quick-match wait shows a VS overlay with *previewed bots* and their cards
  (`server.js:761-768`). It reads as "these are your opponents" — there is no "מחפש יריבים…"
  language, so a human who *would* have joined at t=6 s never registers as a missed opportunity.

### 1.2 Countdown → kickoff
- 5 s lobby countdown → `matchStart` → 4.6 s promo (`INTRO_PROMO`, sim frozen server-side,
  `server.js:642-646`) → 0.7 s `KICKOFF_FREEZE`. **~10.3 s from tap to first input.** The promo is
  skippable at the client (`ti-tap` "הקש לדילוג", `public/index.html`), but the *server* still holds
  `room.introT` for the full 4.6 s, so skipping only hides the overlay — you stare at a frozen pitch.
  **Fix:** either drop `INTRO_PROMO` to ~3.0 s, or let a client `skipIntro` message zero `room.introT`
  once every human has tapped.

### 1.3 In play
- Score is two bare numbers, `#scoreA` / `#scoreB` (`public/index.html:611-613`,
  `public/client.js:5215-5216`, styled `public/style.css:93`). **There is no indication of the win
  target.** The client is never told `goalsToWin` — grep confirms the constant never crosses the wire
  (`shared/wire.js:30-44` carries `score.A/score.B` as raw u8; `matchStart` at `server.js:589` omits
  it). So in `quick` you're playing first-to-3 and the HUD only ever says "1 – 2".
- Timer counts down from 2:00 (`public/client.js:5218-5226`). At ≤10 s it turns red — and that is the
  entire last-30-seconds treatment (`public/style.css:457` is literally `.timer.urgent { color: #ff5a4d; }`).
  No pulse, no tick, no music change, no crowd.
- **THE BIG ONE — the clock runs during dead time.** `shared/sim.js:549` does
  `state.elapsed += dt` *unconditionally*, before the `resetTimer > 0` early return at `:564`.
  So the 0.7 s kickoff freeze and every 5 s post-goal reset are billed to the 120 s match clock.
  A 3–2 match burns **25 s of its 120 s (21%) frozen**. Verified against the code path; the goal
  freeze also cannot be "saved" — `GOAL_RESET` is a wall-clock spend.

### 1.4 Goal → celebration → restart
- `goal()` (`shared/sim.js:437-458`) credits scorer + assist, sets `resetTimer = GOAL_RESET` (5 s) and
  `pendingBallTeam` to the conceding team (a nice, already-shipped comeback nudge — keep it).
- The ball keeps rolling into the net during the hold (`rollBallIntoNet`, `shared/sim.js:479-502`) —
  this is genuinely good and worth protecting in any timing change.
- Client: comic word (`goal-us` 2.3 s / `goal-them` 1.7 s, `public/client.js:4632-4633`), confetti,
  haptic, crowd hype (`:548-555`).
- **DEAD MOMENT:** celebration fades at ~2.3 s, then the DOM banner counts **3 · 2 · 1**
  (`public/client.js:5255-5260`) over a static kickoff formation. ~2.7 s of nothing, five times a
  match. This is where Rocket League puts the goal replay and Brawl Stars puts *nothing at all* —
  its Brawl Ball reset is much shorter.
- **MISSING BEAT:** nobody is told *who* scored. `scorer` is computed server-side
  (`shared/sim.js:443-449`) and thrown away. No "GOAL — <name>" line, no assist credit shown, even
  though `stat.assists` now exists.

### 1.5 Final whistle
- Two ways to end, and they behave differently:
  - **Time cap** (`shared/sim.js:554`): fires regardless of `goalsToWin`.
  - **Goal target** (`shared/sim.js:577-584`): only checked *after* `resetTimer` hits 0, so it reads
    "גול! → ניצחון!".
- **DRAW AT THE CAP IS UNHANDLED (confirmed by harness run).** With `goalsToWin = 3` and the score
  1–1, `step()` ends the match at `elapsed 120.02` with `phase: 'ended'` and no winner concept on
  state at all. The client then computes `myScore === opScore` → `triggerCelebration('draw')` →
  the word **תיקו** (`public/client.js:5248`, `:4636`). So a first-to-3 mode routinely ends in a
  draw with nobody having hit 3. That is the single biggest tension hole in the game.
- **BUG-ADJACENT edge case:** a goal scored after ~1:55 sets a 5 s freeze that the time cap
  interrupts (`:554` is evaluated before the `resetTimer` branch at `:564`), so the goal-target win
  check at `:581` never runs. The result is still correct by score, but the intended
  "גול! → ניצחון!" beat is silently replaced by a flat time-up. Worth a guard.
- **DEAD MOMENT — 11 s of frozen pitch to win a match.** A match-winning 3rd goal costs the full 5 s
  `GOAL_RESET` (including a pointless reposition-to-kickoff at `:569-572` for a match that is over)
  and then `ENDED_HOLD = 6 s` (`server.js:679-680`) with nothing on screen but one word.

### 1.6 Results → next
- **There is no results screen.** `matchStats` arrives (`public/client.js:2786`), is stashed in
  `myMatchStats`, and is used only as a field in the RN bridge payload (`:538`). The player never
  sees their own goals, assists, saves, strips, possession or distance.
- Then: `endRoom()` (`server.js:603-615`). Private rooms return to their lobby (`toLobby`) — that is
  the entire "rematch". **Public `quick`/`brawl` and `botgame` get `toHome`** — dumped to the hub,
  no rematch, no "play again", no opponent context.
- The only payoff is the XP bar animating on the hub (`_awaitXpReveal` → `playXpReveal`,
  `public/client.js:915`, `:1045`), which lands *after* the transition, disconnected from the match.

---

## 2. Match rules that create tension

### 2.1 Golden goal overtime — replaces the draw (HIGH impact / SMALL effort)

Both reference games solve exactly this. Rocket League: tie at full time → sudden-death overtime,
first goal wins, no time limit. Brawl Stars Brawl Ball: tie at full time → **1 minute of overtime
during which the map's walls break down**, and if it's still level it's a draw.

Take the Brawl Stars shape (bounded, so a mobile match can't run forever) with the Rocket League
first-goal-wins rule.

**Rule.** In any mode with `goalsToWin > 0`: at `MATCH_DURATION`, if `score.A === score.B`, enter
`state.overtime = true` instead of ending. Overtime lasts `OVERTIME_DURATION = 45` seconds; the
first goal ends the match immediately (skip the reposition, go straight to `'ended'` after the
`GOAL_FREEZE_HOLD`). Still level at the end of overtime → draw, as today.

**Where.**
- `shared/constants.js`: add `OVERTIME_DURATION = 45`.
- `shared/sim.js:554` — replace the flat time-cap branch:
  ```
  if (!state.noClock && state.phase === 'playing' && state.elapsed >= MATCH_DURATION) {
    if (state.goalsToWin && state.score.A === state.score.B && !state.overtime) {
      state.overtime = true; state.otT = OVERTIME_DURATION;   // golden goal
    } else if (!state.overtime) { state.phase = 'ended'; }
  }
  if (state.overtime) { state.otT -= dt; if (state.otT <= 0) state.phase = 'ended'; }
  ```
- `shared/sim.js:437` `goal()` — when `state.overtime`, set a `state.suddenWin = team` flag; the
  reset branch at `:577-584` ends the match on that flag as well as on `goalsToWin`.

**Wire gotcha (must not be missed):** `shared/wire.js:41` encodes elapsed as
`u8(Math.min(255, s.elapsed | 0))`. A 120 s match + 45 s overtime = 165 s, fine — but an *unbounded*
Rocket-League-style overtime would clamp at 255 s and the client clock would freeze. This is the
reason to keep overtime **bounded**. Also add an `overtime` bit to the keyframe header (there is
already a spare u8 slot pattern at `:40`/`:44`) so the client can flip the HUD.

**Client.** Timer switches to `+0:45` in gold with a "מוות פתאומי" tag; the goal celebration in
overtime uses the `win` treatment directly.

### 2.2 Overtime escalation — the Brawl Stars wall break (MED / MED)

Brawl Ball's overtime destroys the map obstacles, forcing contact. The direct analogue here: the
arena is full of built walls (`state.builtWalls`) plus static crates/stone from `MAIN_FIELD_CLEAN`.

**Rule.** On entering overtime: (a) built-wall building is disabled (`p.buildAmmo` frozen at 0),
(b) every built wall loses 1 HP per second until gone. Optionally the destructible `dryWalls`
crumble too. Do **not** remove static stone — it's load-bearing for the pitch layout.

**Where.** `shared/sim.js` — one decay loop next to the existing wall handling; gate the build branch
at `:609` on `!state.overtime`.

Same treatment is the right *last-30-seconds* ramp for `brawl` (see §2.5), just softer.

### 2.3 Comeback mechanic (HIGH / SMALL)

Two already exist and should be named as such rather than reinvented: the conceding team restarts
with the ball (`shared/sim.js:456`) and bots scale to player XP. What's missing is late-game
escalation for the trailing *human* team.

**Rule — "Momentum".** While a team is behind by ≥2 goals, its players earn overcharge faster:
`OVERCHARGE_*_GAIN × MOMENTUM_MUL (1.35)`. Down by ≥2 *and* under 30 s left → `1.6`.

**Where.** `shared/sim.js:160` `earnPower(p, amt)` currently takes only the player. Give it
`state` (all four call sites are in the same file: `:896`, `:1234`, `:1244`, `:1279`, `:1288`) and
scale `amt` by a `momentumMul(state, p.team)` helper. Constants in `shared/constants.js` next to
`OVERCHARGE_FULL_GAIN` (`:167-168`).

Why this and not a damage/speed buff: overcharge is *already* the game's swing mechanic
(`OVERCHARGE_MUL 2.0`, `SUPER_USES 3`), it's earned by playing aggressively, and boosting its
*rate* rewards the losing team for engaging rather than handing them a free goal. It is
skill-preserving rubber-banding — Rocket League's boost economy does the same thing implicitly.

### 2.4 The 2-minute cap on first-to-3 (HIGH / TINY) — stop the clock

Covered in §1.3. **One line.** `shared/sim.js:549`:

```
if (state.resetTimer <= 0) state.elapsed += dt;   // dead time isn't billed to the match clock
```

This alone gives every match ~20% more actual football and makes "first to 3 in 2 minutes" a
reachable target rather than an aspiration. Cross-check: `wire.js:41` sends `elapsed` as an int, the
client derives `remain` from it (`public/client.js:5223`), so nothing else needs to change.

Pair it with a shorter reset: `GOAL_RESET 5 → 3`, `GOAL_FREEZE_HOLD 2 → 1.6`
(`shared/constants.js:60-61`). Verify `rollBallIntoNet` still settles the ball in 1.6 s — at
`NET_ROLL_SPEED 340` and `BALL_FRICTION` it reaches the back netting in well under a second
(`shared/sim.js:462`, `:492-500`), so 1.6 s is safe. Also shorten the goal celebration
`goal-us` 2.3 → 1.5 s and `goal-them` 1.7 → 1.2 s (`public/client.js:4632-4633`) so the word never
outlives the freeze.

### 2.5 Score-based intensity ramp + last 30 seconds (MED / SMALL)

Layered cues, cheapest first:
1. **≤30 s:** crowd bed rises, music filter/duck, the `timer` element gets a `.warn` pulse
   (`public/style.css:457` currently only recolours at ≤10 s).
2. **≤10 s:** a per-second tick SFX (reuse `ui-click.mp3`) + `timer` scale pulse + a thin red
   vignette on the canvas. Skip the tick when `phase === 'ended'`.
3. **Match point** (either team one goal from `goalsToWin`): a persistent "נקודת ניצחון" flag next
   to the score, pulsing on the leading side. This is the single strongest tension cue available and
   it costs one class toggle once `goalsToWin` reaches the client (§3.1).
4. **In `brawl` only, last 30 s:** the §2.2 wall decay, softened — no new builds, existing walls
   decay. Forces the open-pitch scramble that makes a timed mode's ending feel like an ending.

---

## 3. Moment-to-moment feedback

### 3.1 Score readability — ship `goalsToWin` to the client (HIGH / SMALL)

The client literally does not know the win condition. Cheapest fix: add `goalsToWin` (and `mode`) to
the `matchStart` JSON at `server.js:589` / `:455` / `:428` / `:377` — it's constant per match, so it
does **not** need a wire change.

Then render the score as **pips, not digits**: three slots per side, filled as goals land, with the
final pip pulsing at match point. Timed modes (`goalsToWin === 0`) keep the digits and get a
"הכי הרבה גולים" eyebrow. `public/index.html:609-618`, `public/client.js:5210-5216`,
`public/style.css:93-96`.

### 3.2 Who scored (HIGH / SMALL)

`goal()` already resolves `scorer` and the assisting team-mate (`shared/sim.js:443-449`) and throws
them away. Put `scorerId` / `assistId` on state (they clear with `lastGoal` at `:578`), encode two
slot-index bytes in the keyframe next to `lastGoal` (`shared/wire.js:44`), and print
`⚽ <name>  ·  🅰 <name>` under the comic word in `drawCelebration` (`public/client.js:4643`).
This is the difference between "a goal happened" and "**I** scored".

### 3.3 Save / strip / block acknowledgement (MED / SMALL)

`stat.saves` (`shared/sim.js:880`) and `stat.strips` (`:368`, `:1240`, `:1256`) tick up completely
silently. There is a generic `impacts` channel already flowing to the client
(`server.js:724`, rendered `public/client.js:5157`). Add impact types `'save'` and `'strip'`, and on
the client show a small floating word at the event position — `הצלה!` / `חטיפה!` — plus a distinct
sting. This is the cheapest possible "the game noticed what you did" beat and it directly rewards
the two stats nobody currently experiences.

Streak variant (cheap, high delight): two strips inside 6 s → `×2 חטיפה`; three saves in a match →
a one-shot "חומה" toast.

### 3.4 "You're the carrier" (MED / SMALL)

Today the only carrier signal is the ball being drawn attached, plus the generic local-player
bracket (`public/client.js:4860-4869`). Under pressure, with four bodies overlapping, players lose
track of who has it. Add:
- a soft team-coloured ground ring under whoever owns the ball (`latest.ball.owner`), brighter for me;
- a subtle "carrying" tint on the local charge arc (`:4824-4833`), since the carrier's tap is a
  *dribble touch* not a shot (`BALL_TAP_SPEED`, `shared/constants.js:40`) — a rule players routinely
  don't internalise;
- when an **enemy** carries into your half, a short red pip on the goal side.

### 3.5 Super-ready cue (LOW / TINY)

Reasonable already — pulsing red dashed ring on any powered player (`public/client.js:4818-4823`)
plus a DOM `⚡ עוצמה` chip (`:5235-5236`, `public/style.css:246-253`). Two gaps:
- the ring shows for *every* powered player including enemies, with no distinction — an enemy going
  super should read as a **threat** (add a short inward-collapsing flash on the enemy ring the frame
  it fires);
- `SUPER_USES = 3` (`shared/constants.js:162`) is invisible. Show three small ticks on the ring.
- Nothing signals the `OVERCHARGE_TTL = 4 s` expiry (`:161`) — make the ring's dash speed accelerate
  over the last second.

### 3.6 Teammate / enemy state (MED / MED)

Nothing communicates a team-mate's super, ammo or position pressure. Minimum viable: a two-row team
strip under the score — per player, a dot for alive/active, a filled bolt when super-ready, and the
ball icon on the carrier. Reads at a glance, costs one DOM row, and makes 2v2 feel like a *team*.

---

## 4. Results + the loop back

Today: 6 s of frozen pitch and one word, then the hub. Everything needed for a real results screen
already exists server-side and is being thrown away.

### 4.1 Broadcast every player's stats, not just mine (HIGH / SMALL)

`server.js:664-678` sends each human only their own `stat` row. Change it to build **one payload with
all four players** (bots included — bot rows make the MVP calculation honest and the screen full) and
send that same payload to every human:

```
{ type: 'matchEnd', score, winner: 'A'|'B'|null, overtime: bool,
  players: [{ id, name, team, isBot, cosmetic, stat: {...} }], mvpId }
```

Keep the existing per-player `matchStats` message as-is until the RN bridge is migrated — the app
reads `stats` from `postMatchResult` (`public/client.js:538`) and must not regress.

### 4.2 The screen

Shown during `ENDED_HOLD` — and `ENDED_HOLD` should grow **6 → 9 s** (`shared/constants.js:62`) once
there is something worth looking at, with an explicit "המשך" button that ends the hold early.

Layout, top to bottom:
1. **Verdict** — the existing comic word, reduced to a header band (keep `drawCelebration`'s
   treatment, it's good), plus the final score and a `מוות פתאומי` badge if it went to overtime.
2. **MVP** — hero art + name + the one stat that earned it. Formula (server-side, deterministic):
   `3×goals + 2×assists + 2×saves + 1×strips + 0.5×walls + 0.02×possSec`, ties broken by goals then
   possession. Winning team gets a +1 bias so the MVP is almost always from the winning side (Brawl
   Stars' Star Player behaves this way, and it reads as fair). A losing-team MVP is allowed when the
   margin is large — that's the consolation beat.
3. **The four rows** — name, ⚽ goals, 🅰 assists, 🧤 saves, 🥊 strips. Team-coloured, my row
   highlighted. Bots labelled.
4. **XP payoff, in place.** Right now the XP bar animates on the *hub* after the transition
   (`public/client.js:1045`, `:2752-2755`), fully divorced from the match. Move the reveal onto this
   screen: base XP + the `xpFactor` human-bonus (`:516-524`) shown as a line item ("+40% משחק מול
   שחקנים"), then the bar fills. This is the single biggest "why did I play that" fix in the doc.
5. **Next** — two buttons: **משחק חוזר** (primary) and **חזרה ללובי**.

### 4.3 Rematch for public modes (MED / MED)

`endRoom()` (`server.js:603-615`) only rematches private rooms. Extend it: for `quick`/`brawl`/
`botgame`, keep the room alive for the `ENDED_HOLD` window; if **both/all** humans press rematch,
re-run `startMatch(room)` with the same roster and teams (swap ends). If only some press, the
pressers are re-queued into a fresh public room with a pre-warmed countdown so they don't wait the
full 5 s again. `botgame` rematch is trivial — one human, restart immediately, keep `diffLevel`.

Ranking note: rematch matters *less* than the results screen, because the reason people don't
re-queue is that the last match had no payoff, not that the button is two taps away.

---

## 5. Ranked backlog (impact / effort)

| # | Change | Impact | Effort | Files |
|---|---|---|---|---|
| 1 | Stop the clock during freezes (`elapsed += dt` gated on `resetTimer <= 0`) | ★★★★★ | XS | `shared/sim.js:549` |
| 2 | Merge the public pool — one 2v2 queue (§6) | ★★★★★ | XS | `server.js:81-82,324-338`, `public/index.html:125`, `public/client.js:1969` |
| 3 | Golden-goal overtime instead of a draw | ★★★★★ | S | `shared/sim.js:554,437,577`, `shared/constants.js`, `shared/wire.js:40-44` |
| 4 | Results screen + MVP + XP payoff in place | ★★★★★ | M | `server.js:664-678`, `public/client.js` (new), `public/index.html` |
| 5 | Cut post-goal dead air (`GOAL_RESET 5→3`, hold `2→1.6`, win-goal ends at the hold) | ★★★★ | XS | `shared/constants.js:60-61`, `shared/sim.js:569-584` |
| 6 | Ship `goalsToWin` in `matchStart` → score pips + match-point flag | ★★★★ | S | `server.js:589`, `public/client.js:5210-5216` |
| 7 | Matchmaking window that extends when a 2nd human joins | ★★★★ | S | `server.js:317,336,536` |
| 8 | Scorer + assist name under the goal word | ★★★★ | S | `shared/sim.js:443-449`, `shared/wire.js:44`, `public/client.js:4643` |
| 9 | Momentum: trailing team earns overcharge faster | ★★★★ | S | `shared/sim.js:160` + 5 call sites |
| 10 | Last-30s / overtime treatment (pulse, tick, crowd, wall decay) | ★★★ | S–M | `public/style.css:457`, `public/client.js:5218-5226`, `shared/sim.js` |
| 11 | Save / strip acknowledgement + streaks | ★★★ | S | `shared/sim.js:880,1240`, `public/client.js:5157` |
| 12 | Carrier ring + enemy-carrier pip | ★★★ | S | `public/client.js:4813-4872` |
| 13 | Rematch for public / bot modes | ★★★ | M | `server.js:603-615` |
| 14 | Team strip (team-mate super / ball state) | ★★ | M | `public/index.html:609`, `public/client.js:5210` |
| 15 | Server-side intro skip once all humans tap | ★★ | S | `server.js:642-646`, `shared/constants.js:63` |
| 16 | Super polish: 3 use-ticks, TTL urgency, enemy-super threat flash | ★★ | S | `public/client.js:4818-4823` |

Items 1, 2, 5 are all ≤ a handful of lines and together they change the *pace* of every match in the
game. Do them first, in one commit, and feel the difference before building #4.

---

## 6. Should `brawl` and `quick` stay separate modes?

**No. Merge them. Ship one public 2v2 queue.**

The straight case:

1. **They are the same match.** Same arena (`MAIN_FIELD_CLEAN`), same 2v2, same 120 s, same bots,
   same everything — `goalBrawl()` (`server.js:324-338`) is a copy of `quickMatch()`
   (`server.js:302-319`) with `goalsToWin = 0`. A player cannot tell them apart in-match because the
   client is never told the win condition (§3.1).
2. **They split the matchmaking pool, and the pool is the scarce resource.** `publicRoom` and
   `publicRoomBrawl` are separate singletons (`server.js:81-82`) — a quick-match player and a brawl
   player can never meet. With a 5 s matchmaking window (§1.1) on an app-sized concurrent
   population, halving the pool roughly halves the humans per room, which by `xpFactor`
   (`public/client.js:516-524`) directly cuts what everyone earns. **Two half-empty queues is
   strictly worse than one.**
3. **First-to-3-with-a-cap already contains "most goals".** Once overtime (§2.1) resolves the tie,
   the timed format has no rule left that the merged mode doesn't express better.

**Recommended roster:**

| Mode | Keep? | Why |
|---|---|---|
| `quick` — public 2v2, first to 3, 2-min cap, golden-goal OT | **KEEP — the mode** | The default match. Everything in §2-§4 is aimed here. |
| `brawl` — public timed 2v2 | **RETIRE as a queue** | Fold the name into a *rotating event* on the one queue (`goalsToWin = 0` for a weekend), or drop it. Do not run it as a permanent parallel pool. |
| `botgame` — solo vs bots, first to 3 | **KEEP** | Warm-up + offline path. Needs rematch (#13) more than anything else. |
| `private` — friend rooms + challenges | **KEEP** | Social layer; already has the best loop-back (lobby rematch). |
| `training` / `builder` | **KEEP, unchanged** | Endless sandboxes (`noClock`), not match modes; explicitly out of scope here. |

Implementation of the retirement is cheap: delete the `goal-brawl-btn` handler
(`public/client.js:1969`), revert the button to the coming-soon card it was before `8e36416`
(`public/index.html:125`), and leave the `goalBrawl` server path in place behind the unbound message
so an event can re-enable it with one line. Keep `publicRoomBrawl` — it becomes the event pool.

**Caveat for the `mode-3v3` agent:** if 3v3 ships as a *third* public queue, the same pool-splitting
argument applies with more force (6 slots to fill instead of 4). The right structure is **one public
queue with a rotating format**, not N permanent queues — decide that before 3v3 gets its own button.

---

## 7. Constants touched (summary for whoever implements)

`shared/constants.js`
- `GOAL_RESET` 5 → **3**
- `GOAL_FREEZE_HOLD` 2 → **1.6**
- `ENDED_HOLD` 6 → **9** (only once a results screen exists)
- `INTRO_PROMO` 4.6 → **3.0** (or add a server-side skip)
- new: `OVERTIME_DURATION = 45`, `MOMENTUM_MUL = 1.35`, `MOMENTUM_LATE_MUL = 1.6`,
  `MOMENTUM_DEFICIT = 2`

`server.js`
- `COUNTDOWN_TIME` 5 → **8**, with an "extend/shorten on join" rule rather than a flat window

Nothing above changes shot/super/bomb/body balance, so `docs/MECHANICS.md` needs no edit — except a
new short section if §2.2 (overtime wall decay) or §2.3 (momentum overcharge) ships, since both
change *when* the existing rules apply.

## 8. Test impact

The suite is tick/time sensitive. Expect to touch:
- `test-match-stats.mjs` — goal/assist credit paths if `goal()` gains scorer plumbing.
- `test-net-roll.mjs` — directly asserts the ball settles inside `GOAL_FREEZE_HOLD`; **shortening
  the hold to 1.6 s must be re-verified here.**
- `test-mechanics.mjs`, `test-power.mjs` — `earnPower` signature change (§2.3).
- `test-wire.mjs` — any keyframe header addition (overtime bit, scorer slot bytes).
- New: a `test-overtime.mjs` covering tie→OT, OT goal ends immediately, OT expiry → draw, and
  `goalsToWin = 0` never entering OT.

Run `for f in test*.mjs; do node $f; done`; `test-party` and `test-power` have pre-existing failures
per `OPTIMIZATION_TODO.md` — report them separately.

---

## Sources (patterns taken, not products)

- Brawl Stars — Brawl Ball overtime: 1 minute, obstacles break, still level = draw.
  <https://brawlstars.fandom.com/wiki/Brawl_Ball>
- Rocket League — tie at full time → sudden-death overtime, first goal wins.
  <https://eloking.com/glossary/rocket-league/overtime>
- Fortnite — the storm as a *pacing* device: escalation is scheduled, visible, and shrinks the
  playable space so contact is forced. Applied here as §2.2/§2.5, not as a literal shrinking pitch.
  <https://www.macobserver.com/tips/the-psychology-of-the-storm-why-fortnites-circle-creates-real-panic/>
