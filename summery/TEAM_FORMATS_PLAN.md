# Team formats — 3v3 and 5v5

> Plan doc. Nothing here is built yet except the seams called out as **DONE**.
> Written 2026-07-26 alongside the fix that put קרב על השער on the same VS/teams page as
> ראשון ל-3 (see `AGENT_REQUEST_LOG.md`, that date).

## 0. Why this doc exists

Goal-brawl drifted onto a different pre-match screen than quick match, even though the server
matchmade them identically. The cause was not a hard problem — it was **two copies of the
matchmaker** (`quickMatch()` / `goalBrawl()`) and a client gate that read `mode === 'quick'`.
Adding 3v3 and 5v5 by copying again would reproduce that bug twice over. So the entry point is now
one function driven by a table, and this doc lists what a new row in that table still can't do.

## 1. What is already in place — DONE

- **`FORMATS` table** (`server.js`, near the top) — one row per public matchmade mode:
  `{ prefix, teamSize, goalsToWin, rule }`. It is the only place the modes differ.
- **`joinMatchmade(member, mode, diffLevel)`** — the single entry point. Own matchmaking pool per
  format (`publicRooms` Map), so formats never mix players.
- **`roomJoined.matchmade: true`** — what the client gates the VS/teams page on. A new format gets
  the right pre-match screen for free; it can no longer be born on the wrong one.
- **`lobby.format` / `.rule` / `.teamSize` / `.goalsToWin`** on the wire.
- **VS page is N-per-team** — `fillIntroCol(col, roster, team, perTeam)` loops to `perTeam`
  (from `lobby.teamSize`), and `.ti-col[data-size="3"|"5"]` CSS tightens the rows. Verified
  rendering 2 / 3 / 5 rows in `test-vs-consistency.mjs` §6.
- **Mode label on the VS page** (`#ti-mode`) — name from the `MODES` table, rule from the room.

So the **pre-match surface is format-ready today.** Everything below is the match itself.

## 2. Hard blockers, in the order they bite

### 2.1 `MAX_PLAYERS` is a module constant — 🔴 must become per-room

`shared/constants.js:316` → `export const MAX_PLAYERS = 4; // 2 per team`, read in ~14 places in
`server.js` (room-full checks, bot backfill, `humans.slice(0, MAX_PLAYERS)`).

Fix: `room.maxPlayers = fmt.teamSize * 2`, set in `joinMatchmade`/`makeRoom`; keep the constant as
the default for private rooms and training. Mechanical, but touches every join/backfill path — do
it as its own commit with the suite green before anything else.

### 2.2 The binary snapshot caps at 8 slots — 🔴 blocks 5v5, not 3v3

`shared/wire.js:51`:

```js
for (let k = 0; k < 8; k++) { ... mask |= 1 << k; }  // presence mask is a u8
```

- **3v3 = 6 players** → fits, no wire change.
- **5v5 = 10 players** → **does not fit.** The mask must go u8 → u16 (and the decoder loop to 16).
  `ownerSlot`/bomb-owner use `0xff` as the "none" sentinel in a u8, which still holds to 254 slots,
  so those are fine — it is only the mask.

This is a **wire-format bump**: `encodeKeyframe`/`decodeSnapshot` must change together, and an old
client against a new server would mis-parse every frame. Gate it on a version byte, and note that
the app ships a WebView pointed at the deployed game, so old clients are real (see
[`../AGENT_RULES.md`](../AGENT_RULES.md) on the release train). Do 3v3 first and land 5v5's wire
bump on its own.

### 2.3 Spawns are binary — 🔴 all of slot 2+ stack on one spot

`shared/sim.js:166`:

```js
function spawnPos(team, slot) {
  const y = slot === 0 ? FIELD.H * 0.36 : FIELD.H * 0.64;
```

Slots 2, 3, 4 all land at `0.64` — on top of each other. Needs a formation per team size, e.g.
evenly spread `y = H * (slot + 1) / (teamSize + 1)` with a depth stagger so the back player starts
deeper (defender) and the front one higher (striker). Kickoff spacing is a feel decision — worth
tuning on the phone, not in a test.

### 2.4 Bot AI has exactly two roles — 🟠 3v3+ leaves bots with no job

`shared/bot-ai.js:438 assignRoles()` is written around `bots[0]` / `bots[1]`:
`onBall` + one `support`, `support = bots.find((p) => p.id !== onBall)`. With 3+ bots per team the
third and beyond get **no role**, so they inherit whatever the roleless default does — they will
look idle or clump.

Needs an N-role model. Minimum viable: `onBall` (nearest to the ball) + `support` (attack outlet) +
`cover` (goal-side, one per remaining bot, spread across lanes). The existing hysteresis
(`SWITCH_MARGIN`, `MIN_HOLD`) should be kept — it is what stops role thrash — and applied per role.
This is the largest single piece of work here, and the one most likely to make 3v3 feel bad if
skipped.

### 2.5 The field is one fixed size — 🟠 a design call, not just code

`FIELD = { W: 2000, H: 1100 }`, and the goal mouth is `GOAL.width = 300`. Ten players on a 2v2
pitch is a scrum. Either scale the field per format or author dedicated arenas (see §3 — Brawl
Stars authors per-mode maps rather than scaling one).

Watch out: the field builder, saved fields (`fields/`), `MAIN_FIELD_CLEAN`, and the arena/stadium
camera all assume the current dimensions. Scaling `FIELD` per room is a wider blast radius than it
looks.

### 2.6 Smaller ones

- `computeBotPlan` / `ensureBotPlan` fill to `MAX_PLAYERS` — follows §2.1.
- Bot card rarity ramp (`RARITY_BY_LEVEL`) is per-bot, so it scales, but 5 legendaries × 5 bots at
  L10 is a very different power budget than 2. Re-check balance per format.
- `MODES` rows for `3v3`/`5v5` need `format` + `state: 'live'` + a `launch` that sends
  `{ type: 'matchmade', format }` (already handled server-side).
- Per-player match stats and XP (`xpFactor`) are per-participant, so they scale, but the XP economy
  per match changes with roster size — check the ladder doesn't inflate.

## 3. What the big games do (per the standing rule — don't guess, cite)

**Brawl Stars.** Nearly every mode is **3v3** — Gem Grab, Brawl Ball, Bounty, Heist, Hot Zone,
Knockout — and the exception (Showdown) is the battle-royale one, not a differently-sized team game.
The lesson is the one the goal-brawl bug just taught us from the other direction: **vary the
objective, hold the roster size fixed.** Their pre-match screen is also identical across every mode
— mode name and objective, then both teams' brawlers side by side — which is exactly the
consistency being asked for here. They also author **maps per mode** rather than reusing one pitch
at different player counts.

**Fortnite.** Solo / Duos / Trios / Squads is a **playlist axis orthogonal to the mode** — same
map, same mechanics, only the roster size changes. That maps cleanly onto the `FORMATS` table:
`teamSize` is a column, not a new mode.

**Roblox football/sports games** typically treat team size as a server-config value with the lobby
listing both team rosters — the same shape as the `teamSize`-driven VS page now in place.

**Recommendation from the above:** make **3v3 the canonical size** and let the *objective* vary
(first-to-N, timed, and whatever comes next), rather than shipping 2v2/3v3/5v5 as three parallel
ladders that each split the matchmaking pool. Keep 2v2 as the fast/entry format. Treat 5v5 as a
separate event/limited-time format — it costs a wire bump (§2.2) and its own field (§2.5), and it
quarters the player pool a fourth way.

Honest note: the Brawl Stars 3v3 fact and the Fortnite playlist split are well established. The
"authors maps per mode" point is a strong inference from how their maps are shipped, not a quoted
design statement. The specific recommendation is mine, not theirs.

## 4. Suggested order

1. §2.1 per-room `maxPlayers` — mechanical, unblocks everything, suite must stay green.
2. §2.3 formation spawns — small, immediately visible on the phone.
3. §2.4 N-role bot AI — the real work; 3v3 lives or dies on this.
4. §2.5 field sizing for 3v3 — a feel pass on device.
5. Flip the `3v3` MODES row live.
6. Only then 5v5, starting with §2.2's versioned wire bump.

## 5. Tests that already guard this

- `test-vs-consistency.mjs` — both live formats flagged matchmade, lobby carries
  format/rule/teamSize, the client gate is the flag not a mode name, no duplicated matchmaker, and
  the VS column renders 2/3/5 rows. Needs a live server (`PORT=3014 node server.js`).
- `test-modes-table.mjs` — every mode-pick surface renders from the one `MODES` table.
- `test-mode-format.mjs` — the picked mode's win rule actually reaches `matchStart`. Live server too.
