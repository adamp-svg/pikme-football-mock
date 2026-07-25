# 📌 OPEN ITEMS — what every agent left behind (audit 2026-07-25, agent `handoff-audit`)

> One board for **everything still open** across all agent handoffs. Perf/netcode detail stays in
> [`OPTIMIZATION_TODO.md`](OPTIMIZATION_TODO.md); rules in [`CLAUDE.md`](CLAUDE.md); history in
> [`AGENT_REQUEST_LOG.md`](AGENT_REQUEST_LOG.md).
>
> State at audit time: `main` = `a82e6bb`, **3 commits ahead of `origin/main`** (docs only, not pushed).
> Test suite **27/28 green** — only `test-power.mjs` fails (PRE-EXISTING, stale vs the shipped shot rebalance).
> Working tree clean except untracked `CLAUDE.md` + `summery/research-trophies/`.

---

## 🔴 P0 — do first

### 1. ~~Wall build-position fix — MISSING FROM HEAD~~ ✅ DONE (`2710141`)
- Not lost — it was still in flight when this board was written. Landed as commit `2710141`, **not pushed**.
- Build edge now latches its aim + `buildDist` in `shared/input-merge.js`; the ghost and the sim share one `wallPlacement()` in `shared/arena.js`; covered by `test-wall-place.mjs`.
- Measured E2E: **143.6px + 45° wrong → 2.4px, 0°**. Details in the `wall-place` entry in [`AGENT_REQUEST_LOG.md`](AGENT_REQUEST_LOG.md).
- **Left open from it (P2):** (a) make `sim.js buildWall()` call the shared `wallPlacement()` once `shared/sim.js` is free — the test already asserts they agree; (b) the ~0.35s "full ring, no wall" window inside `buildCd` (client ring is wall-clock, sim pins windup to 0) — gate the ring on the server's `buildCd`/ammo.

### 2. `FOOTBALL_TOKEN_SECRET` must MATCH on both Render services
- pikme-football + pikmeTV-server. If they differ, **every player silently becomes a guest** → friends, challenges and party invites all break with no error.
- Needs the user (env var, not code).

### 3. New TestFlight build — the whole stats/XP/prefs feature is invisible without it
- App branch `pikmeTV-saltiz@feat/football-store`, commit `d1b411a`.
- Game + backend are already LIVE; the app-side inject/forward only ships in a fresh build.
- Blocks any on-device verification below.

---

## 🟠 P1 — high value, ready to start

### 4. 120Hz sim (user explicitly asked for it) — unblock the tests
- Built and verified once, then **reverted** because ~8 tests count TICKS not TIME.
- Do: re-tune those tests to assert on elapsed time, then re-apply `TICK_RATE=120` + `SNAPSHOT_RATE=90` (`shared/constants.js`) and `INPUT_RATE=120` + `INTERP_DELAY=35` (`public/client.js`).
- Note: all suites now pass at 60Hz, so the failing set must be re-derived at 120Hz.

### 5. On-device feel-check of `USE_REPLAY` reconciliation
- Mechanically verified (ack echoes seq) but never felt on a phone. Watch for jitter during knockback. Kill switch: `USE_REPLAY=false` in `public/client.js`.
- Gated on item 3.

### 6. Decide `DEV_UNLOCK_ALL` (`public/client.js:764`, currently `true`)
- Every hero is unlocked for everyone. Real 7-cards-per-hero gating never activates; the hero-demote reconcile is a no-op until flipped.
- **Product decision, not a bug** — the user should say ship-unlocked or flip to `false`.

### 7. Surface career stats in the app
- Backend returns `careerGoals, assists, strips, saves, shotsFired, bombsPlanted, wallsBuilt, touches, possSeconds, distanceM` from `GET /handle-user/football/stats` — **nothing renders them**.
- Obvious next feature: player profile / post-match summary screen.

---

## 🟡 P2 — in-flight lanes (agents may still be running; coordinate before touching)

### 8. `modes-lead` — modes & lobby overhaul (DESIGN ONLY so far)
- 5 design agents writing to `docs/specs/2026-07-25-*.md`: lobby picker, **3v3 bigger/longer pitch**, mode polish (overtime/results), new minigames, roster research.
- ⚠️ At audit time **no 2026-07-25 spec has landed** in `docs/specs/` (only the 07-20/07-21 files). If the specs never appear, that pass died — re-run or write them from the log entry.
- Highest technical risk called out: making `FIELD` per-match (wire packing) for 3v3.

### 9. `social` — friends & shareable artifacts (scope logged, NOTHING built)
- Exists already: friends list/add/requests, challenge→match, party invite, 3 bot friends, rank sub-line.
- Missing: **DM/messaging** (no chat anywhere — transport, unread badge, rate-limit all undesigned) and **arena sharing** (`pikme-fields` in localStorage → send to a friend).
- ⚠️ Gotcha: `public/client.js:84` silently **drops `pikme-fields`** from the account sync when the prefs bag exceeds `PREF_MAX_BYTES` (200 KB) — a share feature can't rely on that sync.

### 10. Untracked work sitting in the tree
- `summery/research-trophies/` (3 docs: brawl-stars, other-games, skill-progression) — a trophy/progression research pass with **no owner entry in the log and no implementation**.
- `CLAUDE.md` — the standing-rules file, still untracked at audit time (its author should commit it).

---

## 🟢 P3 — netcode / perf queue (detail in `OPTIMIZATION_TODO.md`)

- Server per-tick input FIFO + ack (retires the aim-latch hack — and would have prevented item 1).
- **WebRTC / UDP transport** — biggest real gap vs Brawl Stars (WS/TCP head-of-line-blocks on mobile). Needs a UDP-capable host; Render can't. Plan: `summery/WEBRTC_TRANSPORT_PLAN.md`.
- Lag compensation (server rewind) — needs per-client RTT tracking first.
- Render-perf batch: prebake hero-sprite atlas / ad-board glow / bush texture; alloc-free `interpolated()`.
- Assets fully on-device (service worker → bundled atlas).

---

## 🔵 P4 — small / stale / verification debt

- **App: call `__pikmeApplyPrefs` mid-session** — the game hook is live, nothing calls it (`football.jsx` `injectJavaScript`). Low value, prefs rarely change mid-match.
- **Stat attribution polish** — assists credit only the immediately-previous holder; own goals unattributed; keeper `saves` = catch in own box only (`shared/sim.js` `touchBall`).
- **`test-power.mjs`** — the one red test. Stale vs the committed shot rebalance; either update it to the new spec or delete it. It has been reported as "known pre-existing" for 3 sessions.
- **pikme-server never DB-verified**: `GET /handle-friends/rank` and the phone-variant friend search were logic-checked only — local node 26 can't boot pikme-server (old `jsonwebtoken` / `SlowBuffer`). Needs node 18/20 + a real token.
- **Bot rarity mirroring is probabilistic** — a single-legendary human often faces a bot showing rare/common. Empty-slot weirdness is fixed; visual mirroring is a separate rarity-model change if the user wants it.
- **`summery/HANDOFF-EXTERNAL-TODO.md` item 1 is STALE** — it asks the backend to consume `xpFactor`; `computeMatchXp` already applies it and is live. Ignore that item.
- **Field-builder handoff is STALE** — `summery/TASK-field-builder.md` lists a "REMAINING" section, but the `builderMatch` handler (`server.js:1095`) and the client wiring (`public/client.js:6143`) both landed. Nothing left there.
- Follow-ups noted and never done: bots don't avoid hazard/terrain zones; the ball isn't slowed by water (player-only).
