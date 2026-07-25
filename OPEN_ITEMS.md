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
- The 5 design specs DID land in `docs/specs/2026-07-25-*.md` (3v3, lobby picker, mode polish, new minigames, roster research) — ~3200 lines of design, **none of it implemented yet**.
- Biggest one: **3v3 on a bigger/longer pitch** — highest technical risk is making `FIELD` per-match (wire packing).
- ⚠️ Their `test-mode-format.mjs` red-fails unless something is listening on `:3013`. Copy the self-boot block from the top of `test-party.mjs` — that exact trap made `test-party` look broken for three sessions.

### 6. `social` — friends & shareable artifacts
- Exists already: friends list/add/requests, challenge→match, party invite, 3 bot friends, rank sub-line, quick-message catalogue.
- Still open: **DM/messaging** end-to-end (transport, unread badge, rate-limit) and **arena sharing** (`pikme-fields` → send to a friend).
- ⚠️ Gotcha: `public/client.js:84` silently **drops `pikme-fields`** from the account sync once the prefs bag exceeds `PREF_MAX_BYTES` (200 KB) — a share feature cannot rely on that sync.

### 7. `trophies` — ranked ladder
- Research + decision landed (`summery/research-trophies/`, incl. `00-DECISION.md`); trophy math, persistence, record-match wiring and a lazy migration are committed in **pikme-server**, with the game-side display module + parity test in this repo.
- Open: it is **all local** — see the release-train note below; the game reports `botLevel`/`opponentKey` that only the unpushed server understands.

---

> 📦 **Preparing a shipment?** The cross-repo handoff for the reconciliation agent is
> `../summery/HANDOFF-2026-07-25-reconciliation.md` (outside this repo — it covers football-mock +
> pikme-server + pikmeTV-saltiz together, with the ship order, the verification gaps and the clashes).

## 🚚 Release train — ~56 local commits, nothing on any remote

These three repos are **coupled** and must go out together, in this order:

1. **pikme-server** — 5 commits: trophy math + persistence + lazy migration, friend-messaging API, career-stats projection.
2. **football-mock** — 38 commits (9 feat / 5 fix / 2 test / 22 docs; 55 files, +8.8k lines). ⚠️ `autoDeploy=yes` — **pushing this deploys the game to production immediately**, so the server must be live first or the game will report trophy fields nothing understands.
3. **pikmeTV-saltiz** (`feat/football-store`) — 1 commit (career-stats screen + mid-session prefs); ships only via a TestFlight build.

Suite is green in football-mock and the app; the server's own tests should be run before its push.

---

## 🟢 P3 — netcode / perf queue (detail in `OPTIMIZATION_TODO.md`)

- Server per-tick input FIFO + ack — retires the aim-latch hack that caused the wall-placement bug.
- **WebRTC / UDP transport** — the biggest real gap vs Brawl Stars (WS/TCP head-of-line-blocks on mobile). Needs a UDP-capable host; Render can't. Plan: `summery/WEBRTC_TRANSPORT_PLAN.md`.
- Lag compensation (server rewind) — needs per-client RTT tracking first.
- Render-perf batch: prebake hero-sprite atlas / ad-board glow / bush texture; alloc-free `interpolated()`.
- Assets fully on-device (service worker → bundled atlas).

---

## 🧹 Repo hygiene (found in the 2026-07-25 git sweep)

- **Two merged branches can be deleted.** `feat/build-bomb-cancel` and `feat/friends-hub-upgrades` are **0 commits ahead** of `main` (78 / 68 behind). Nothing is stranded on them — `feat/build-bomb-cancel` also exists on origin.
- **Five tracked scratch scripts at the repo root**: `_repro.mjs`, `_smoke-hard.mjs`, `_smoke-play.mjs`, `_smoke-training.mjs`, `_test-dismiss.mjs`. All need a live `:3010`, none is part of the suite, last touched 07-19…07-23. Delete them or move them under a `scratch/` that `.gitignore` covers.
- **Two spec directories** — `docs/specs/` (7 files) and `docs/superpowers/specs/` (11) — with no rule for which is which. Pick one.
- **Four overlapping request logs**: root `AGENT_REQUEST_LOG.md` (503 lines, the live one) plus `summery/AGENT-REQUEST-LOG.md`, `summery/REQUEST-LOG.md`, `summery/REQUEST-LOG-session-ddd7c78b.md` — old per-session copies that read as current. Fold or delete.
- **Uncommitted in sibling repos**: `pikmeTV-tf` has a dev-only `GAME_PORT 3010→3012` tweak; `pikmeTV-app` has iOS pod artifacts (`Podfile.lock`, `project.pbxproj`); `saltiz-cards` has an untracked `web/package-lock.json` (lockfiles normally belong in the repo).
- **Credentials sit beside the repos, untracked**: `AuthKey_*.p8`, `cer-nave.p12`, `project & accounts.text` in the parent folder. The parent is not a git repo, so nothing is leaked — keep it that way and never `git add` from there.

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
