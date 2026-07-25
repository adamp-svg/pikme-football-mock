# 📌 OPEN ITEMS — the cross-agent board (last swept 2026-07-25, agent `handoff-audit`)

> Everything still open across all agent handoffs. Perf/netcode detail: [`OPTIMIZATION_TODO.md`](OPTIMIZATION_TODO.md).
> Rules: [`CLAUDE.md`](CLAUDE.md). History: [`AGENT_REQUEST_LOG.md`](AGENT_REQUEST_LOG.md).
>
> Suite is **fully green** (`for f in test*.mjs; do node $f; done`) — a red test is now a real red test.
> Nothing is pushed (standing rule).

## ⛔ Decided — do NOT pick these up

- **120Hz sim — dropped.** The user does not want it (2026-07-25). Removed from this board and from the optimization queue; the game stays 60Hz. Don't re-propose it as an easy latency win.
- **`DEV_UNLOCK_ALL` stays `true`** — all heroes unlocked for everyone on purpose. The 7-cards-per-hero gating and the hero-demote reconcile stay dormant. Not a bug.

---

## 🔴 P0 — needs the user, not an agent

### 1. New TestFlight build
- App branch `pikmeTV-saltiz@feat/football-store` (`c51d8a1`).
- Game + backend are already live on Render; **nothing app-side ships without a build** — XP inject, stats forwarding, prefs sync and the new career-stats screen are all invisible until then.
- Blocks every on-device check below.

### 2. DB-verify the friends endpoints
- `GET /handle-friends/rank` and the phone-variant friend search are logic-checked only, never run against Mongo.
- Blocked locally: this machine has node 24/26 only, and pikme-server's old `jsonwebtoken` needs the removed `SlowBuffer`; booting it also needs prod credentials. Needs node 18/20 + a real football token.

---

## 🟠 P1 — ready to start

### 3. On-device feel-check of `USE_REPLAY` reconciliation
- Mechanically verified (the ack echoes the sent seq) but never felt on a phone. Watch for jitter during knockback.
- Kill switch: `USE_REPLAY = false` in `public/client.js`. Gated on P0 #1.

### 4. Bot rarity mirroring is probabilistic
- A single-legendary human often faces a bot showing rare/common. The empty-slot weirdness is fixed; making the bot's TOP card mirror the human's top rarity is a separate change to the rarity model.
- Product call: only worth doing if the mismatch actually reads as unfair in play.

---

## 🟡 P2 — in-flight lanes (coordinate before touching)

### 5. `modes-lead` — modes & lobby overhaul
- Owns the mode list, lobby/game picker, match lifecycle. Shipped so far: golden-goal overtime, first-to-3, a single source of truth for the mode surfaces.
- Still open in that lane: **3v3 on a bigger/longer pitch** — highest technical risk is making `FIELD` per-match (wire packing).
- ⚠️ Their `test-mode-format.mjs` red-fails unless something is listening on `:3013`. Copy the self-boot block from the top of `test-party.mjs` — that exact trap made `test-party` look broken for three sessions.

### 6. `social` — friends & shareable artifacts
- Exists already: friends list/add/requests, challenge→match, party invite, 3 bot friends, rank sub-line, quick-message catalogue.
- Still open: **DM/messaging** end-to-end (transport, unread badge, rate-limit) and **arena sharing** (`pikme-fields` → send to a friend).
- ⚠️ Gotcha: `public/client.js:84` silently **drops `pikme-fields`** from the account sync once the prefs bag exceeds `PREF_MAX_BYTES` (200 KB) — a share feature cannot rely on that sync.

### 7. Trophy research with no owner
- `summery/research-trophies/` (brawl-stars, other-games, skill-progression) — research done, nothing implemented, no log entry claiming it. Either someone owns it or it should be deleted.

---

## 🟢 P3 — netcode / perf queue (detail in `OPTIMIZATION_TODO.md`)

- Server per-tick input FIFO + ack — retires the aim-latch hack that caused the wall-placement bug.
- **WebRTC / UDP transport** — the biggest real gap vs Brawl Stars (WS/TCP head-of-line-blocks on mobile). Needs a UDP-capable host; Render can't. Plan: `summery/WEBRTC_TRANSPORT_PLAN.md`.
- Lag compensation (server rewind) — needs per-client RTT tracking first.
- Render-perf batch: prebake hero-sprite atlas / ad-board glow / bush texture; alloc-free `interpolated()`.
- Assets fully on-device (service worker → bundled atlas).

---

## 🔵 Stale docs — believe this file, not those

- **`summery/HANDOFF-EXTERNAL-TODO.md` item 1** ("backend must consume `xpFactor`") — already live in `computeMatchXp`.
- **`summery/TASK-field-builder.md` "REMAINING"** — done: the `builderMatch` handler (`server.js:1095`) and the client wiring both landed.

---

## ✅ Closed on 2026-07-25 (so nobody re-opens them)

- Wall build-position bug (`2710141`) + its two leftovers: one shared `wallPlacement()` for ghost and sim (0.000px disagreement over 126 cases), and the "full ring, no wall" cooldown window (`0821ee2`).
- Test suite green (`d57d007`): `test-power` asserted a superseded ½ overcharge gain; `test-party` was pointing at a server booted without the test secret. Both were test bugs.
- `FOOTBALL_TOKEN_SECRET` verified **identical** on both Render services (compared SHA-256 via the Render API — the CLI has no `env-vars` command). The "everyone silently becomes a guest" risk is not present.
- Career stats render in the app (`c51d8a1` + backend `a40fe5e`), and `__pikmeApplyPrefs` is called mid-session with an echo-loop guard.
