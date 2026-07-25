# 📌 OPEN ITEMS — what every agent left behind (audit 2026-07-25, agent `handoff-audit`)

> One board for **everything still open** across all agent handoffs. Perf/netcode detail stays in
> [`OPTIMIZATION_TODO.md`](OPTIMIZATION_TODO.md); rules in [`CLAUDE.md`](CLAUDE.md); history in
> [`AGENT_REQUEST_LOG.md`](AGENT_REQUEST_LOG.md).
>
> **Update 2026-07-25 21:5x (agent `handoff-audit`, 2nd pass).** User: *"leave 120hz, keep all heroes
> unlocked for now; other stuff fix and research and build if needed."* So **#4 (120Hz) and #6
> (`DEV_UNLOCK_ALL`) are PARKED BY DECISION — do not pick them up.** Everything else in my lane is
> now done or reduced to a user/env action; see the ✅ marks below.
>
> Test suite is **fully GREEN (35/35)** — the two "known pre-existing fails" were both test bugs, not
> product bugs, and are fixed. Nothing is pushed (standing rule).

---

## 🔴 P0 — do first

### 1. ~~Wall build-position fix — MISSING FROM HEAD~~ ✅ DONE (`2710141`)
- Not lost — it was still in flight when this board was written. Landed as commit `2710141`, **not pushed**.
- Build edge now latches its aim + `buildDist` in `shared/input-merge.js`; the ghost and the sim share one `wallPlacement()` in `shared/arena.js`; covered by `test-wall-place.mjs`.
- Measured E2E: **143.6px + 45° wrong → 2.4px, 0°**. Details in the `wall-place` entry in [`AGENT_REQUEST_LOG.md`](AGENT_REQUEST_LOG.md).
- **Left open from it — both now ✅ DONE:**
  - (a) `sim.js buildWall()` calls the shared `wallPlacement()` (landed inside `d383099`; sim.js's duplicate `WALL_ANGLE_STEPS/QUANT` deleted so there is exactly one copy of the formula). `test-wall-place` now measures **0.000px** ghost-vs-sim disagreement across 126 cases.
  - (b) the "full ring, no wall" window — `0821ee2`. `currentWindup()` runs on the local clock for one round-trip of grace, then follows the snapshot's `winding` flag; not winding ⇒ ring empty ⇒ release cancels instead of eating the input. Covered by the new cooldown case in `test-build-windup.mjs`.

### 2. ~~`FOOTBALL_TOKEN_SECRET` must MATCH on both Render services~~ ✅ VERIFIED — they already match
- Checked via the Render API on both `srv-d9ebcvtaeets73ar91sg` (pikme-football) and `srv-chgb1k67avjbbju8aoig` (pikmeTV-server): **same 96-char value, identical SHA-256**. Friends / challenges / party auth is correctly configured in prod. Nothing to do.
- Re-check this the same way if friends ever start silently behaving as guests (`render` CLI v2.5.0 has no `env-vars` command — use `GET https://api.render.com/v1/services/<id>/env-vars` with the token in `~/.render/cli.yaml`, and compare HASHES, never print the value).

### 3. New TestFlight build — the whole stats/XP/prefs feature is invisible without it
- App branch `pikmeTV-saltiz@feat/football-store`, commit `d1b411a`.
- Game + backend are already LIVE; the app-side inject/forward only ships in a fresh build.
- Blocks any on-device verification below.

---

## 🟠 P1 — high value, ready to start

### 4. ⛔ 120Hz sim — PARKED BY THE USER (2026-07-25: "leave 120hz")
- Do NOT pick this up. Kept here only so nobody re-discovers it as an obvious win.
- If it is ever un-parked: re-tune the tick-counting tests to assert on elapsed TIME, then re-apply `TICK_RATE=120` + `SNAPSHOT_RATE=90` (`shared/constants.js`) and `INPUT_RATE=120` + `INTERP_DELAY=35` (`public/client.js`).

### 5. On-device feel-check of `USE_REPLAY` reconciliation
- Mechanically verified (ack echoes seq) but never felt on a phone. Watch for jitter during knockback. Kill switch: `USE_REPLAY=false` in `public/client.js`.
- Gated on item 3.

### 6. ⛔ `DEV_UNLOCK_ALL` — DECIDED: stays `true` (2026-07-25: "keep all heros unlocked for now")
- Every hero stays unlocked for everyone; the 7-cards-per-hero gating and the hero-demote reconcile stay dormant on purpose. Don't "fix" this.

### 7. ~~Surface career stats in the app~~ ✅ DONE (app `c51d8a1`, backend `a40fe5e`)
- `app/pages/football-profile.jsx` now has a **הקריירה שלי** section: goals, assists, strips, saves, shots, touches, bombs, walls, ball-time, running distance + goals-per-match.
- Formatters extracted to `app/pages/football-profile.format.js` (repo convention: pure logic in a sibling module) with 9 unit tests — the counters are client-reported, so the screen must never print `NaN`. App suite 148/148 green.
- Backend: `footballPublicStats()` now includes the career tallies, so **another player's** profile (opened by `profileToken` from the leaderboard) shows the same section instead of all zeros. Still no phone/userId in that projection.
- Still needs a TestFlight build (item 3) to be seen on a device.

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

- ~~**App: call `__pikmeApplyPrefs` mid-session**~~ ✅ DONE (`c51d8a1`). `football.jsx` pushes hero/loadout/prefs into an already-open game when the stats query changes. The echo hazard is handled: the game POSTs prefs → query invalidates → we would inject the same values back, so the effect remembers the last payload signature and the first resolve is seeded (bootJs already carried it), not injected.
- ~~**Stat attribution polish**~~ — ✅ INVESTIGATED, nothing to fix. Assists crediting only the immediately-previous holder is *correct football* (the last pass); own goals are structurally impossible (`shared/sim.js:79` — the own goal line is solid, and `goal()` only credits the scoring team); keeper `saves` = catch in own box is the intended definition. Deeper attribution (second assists, etc.) would be a new feature, not a bug fix.
- ~~**`test-power.mjs`**~~ ✅ FIXED (`d57d007`). It was the TEST that was stale — it still asserted the old 1/2 partial overcharge gain after the rebalance moved it to 1/3. It now derives the hit count from `OVERCHARGE_PARTIAL_GAIN` so a retune can't rot it again. The 1/2-vs-1/3 comments in `sim.js` + `MECHANICS.md` were wrong too, now corrected.
- ~~**`test-party.mjs`**~~ ✅ FIXED (`d57d007`). Never a product bug: it pointed at `:3010`, a server another agent had started WITHOUT `FOOTBALL_TOKEN_SECRET=testsecret`, so both clients authed as guests and the invite never arrived. It now boots its own server on a private port. **Whole suite is green — if you see a red test, it is real.**
- **pikme-server never DB-verified**: `GET /handle-friends/rank` and the phone-variant friend search are still logic-checked only. Blocked here: no node 18/20 on this machine (only 24/26 via brew; pikme-server's old `jsonwebtoken` needs the removed `SlowBuffer`), and booting it locally would need prod Mongo credentials — **a user call, not something to do unasked.**
- **Bot rarity mirroring is probabilistic** — a single-legendary human often faces a bot showing rare/common. Empty-slot weirdness is fixed; visual mirroring is a separate rarity-model change if the user wants it.
- **`summery/HANDOFF-EXTERNAL-TODO.md` item 1 is STALE** — it asks the backend to consume `xpFactor`; `computeMatchXp` already applies it and is live. Ignore that item.
- **Field-builder handoff is STALE** — `summery/TASK-field-builder.md` lists a "REMAINING" section, but the `builderMatch` handler (`server.js:1095`) and the client wiring (`public/client.js:6143`) both landed. Nothing left there.
- ~~Follow-ups noted and never done: bots don't avoid hazard/terrain zones; the ball isn't slowed by water~~ — **OBSOLETE, do not build these.** The whole terrain/hazard-zone feature (`ZONE_FX`: water/mud/sand/ice/thorns/cactus/fire + 11 builder tools) was implemented on 07-24 and then **deliberately reverted — the user disliked it** (`798d022`: "field-obstacles + tree-walls experiments were DONE then REVERTED by their agents"). `ZONE_FX` exists nowhere in the code today; only the log entry remains, which is what makes these two look like open work.
