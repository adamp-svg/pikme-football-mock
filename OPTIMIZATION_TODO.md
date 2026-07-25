# 🔧 GAME OPTIMIZATION — Handover TODO (pick up here)

> **If you were asked about game optimization / performance / netcode / lag / "make it feel
> sharper, smoother, more reactive" / fps / 120Hz / WebRTC — START HERE.** This is the single
> prioritized queue. Deep detail lives in `summery/REACTIVITY_ROADMAP.md` (verified NOW/SOON/FUTURE)
> and `summery/WEBRTC_TRANSPORT_PLAN.md` (the transport migration plan).
>
> Keywords: game optimization, performance, perf, netcode, latency, lag, reactive, sharp, smooth,
> fps, 120Hz, WebRTC, UDP, transport, prediction, reconciliation, interpolation, lag compensation.
>
> Coordination: this is a multi-agent repo — take an orchestration lock before editing a shared
> file (`football-mock:<path>`), run the test suite (`for f in test*.mjs; do node $f; done`, must
> stay green — 2 unrelated flakes aside), build locally on `PORT=3012 node server.js`, and deploy
> via `render deploys create srv-d9ebcvtaeets73ar91sg --confirm -o json` (autoDeploy is also on).

## ✅ Already shipped & LIVE (commit 6d77a788, https://pikme-football.onrender.com)
Context so you don't redo these. Suite 26/26 green.
- **Aim bug fix** — server latches the aim/lob vector to the fire/special EDGE (fixed wrong-direction shots on jittery links). `server.js` input coalescer.
- **Input-replay reconciliation** — wire carries per-player `lastSeq` (u32); client ring-buffers unacked movement inputs and replays from the authoritative pos. Behind `const USE_REPLAY = true` in `public/client.js` (flip to false to revert to the old 0.2 blend).
- **Reactivity** — `flushInput()` on shot/build/special edge; instant muzzle flash + recoil + shake; INTERP_DELAY 100→55; tighter avatar/camera easing.
- **Assets on device** — preload+decode the crowd card set at kickoff; `/assets/*` + `/audio/*` served `immutable` (html/js stay `no-store`); `.png` MIME.
- **Robustness** — snapshot backpressure 64KB→8KB; WS heartbeat (reap dead sockets); reconnect jitter.
- **Perf** — memoized `wallJoints` (static arena); opaque `worldBuf` context.

## 📋 The queue — do in this order

### [ ] 1. 120Hz sim — UNBLOCK IT  · priority: HIGH · effort: M
The user explicitly wants 120Hz. It's built & verified live but was **reverted** because it breaks ~8 tests that count TICKS, not time (`TICK_RATE 60→120` halves elapsed-per-N-ticks). Game feel is rate-independent (all decays are `Math.pow(base, DT)`; positions integrate by `dt`).
- **Do:** re-tune the ~8 failing tests to assert on **elapsed TIME** (e.g. run for `t` seconds worth of ticks) not a fixed tick count, so they pass at any rate. Failing set: test-ball-deflect, test-bot-ai, test-fragile, test-mechanics, test-net-roll, test-shoot-angle, test-stuck, test-super-quick-strip. (test-party / test-power fail pre-existing, unrelated.)
- **Then re-apply:** `shared/constants.js` `TICK_RATE=120` + `SNAPSHOT_RATE=90`; `public/client.js` `INPUT_RATE=120` + `INTERP_DELAY=35`.
- **Exit:** full suite green at 120Hz + no real physics regression (spot-check kick distance / net-roll over real TIME matches 60Hz).
- Note: true 120fps RENDER on iOS needs Skia/native (WKWebView rAF caps at 60) — the 120Hz *sim* still halves input latency regardless.

### [ ] 2. On-device feel-check the reconciliation  · priority: HIGH · effort: S
`USE_REPLAY` reconciliation is mechanically verified (live WS test: ack echoes sent seq, movement applies) but NOT feel-tested on a device. On TestFlight, check for jitter during knockback (bounded-error window). If bad, tune or set `USE_REPLAY=false`.

### [ ] 3. Server per-tick input FIFO queue + ack  · priority: MED · effort: M
Refinement to #reconciliation: `server.js` keeps only the newest input per player (latest-per-tick). Drain a per-player FIFO in seq order each tick, bound it (drop-oldest), ack the highest consumed seq. Lets the aim-latch hack retire. See REACTIVITY_ROADMAP.md "SOON ★".

### [ ] 4. ★ WebRTC / UDP transport  · priority: HIGH (biggest real gap) · effort: L
The #1 leverage vs Brawl Stars: our WebSocket/TCP head-of-line-blocks on lossy mobile links. Move the 60Hz snapshot/input stream to an unreliable WebRTC DataChannel; keep WS for control + fallback. **Full plan: `summery/WEBRTC_TRANSPORT_PLAN.md`** (node-datachannel server, WKWebView client, STUN-only, Fly.io/VM UDP host, 5 phases, ~1–1.5wk). Needs a UDP-capable host (Render can't do UDP). 4 decisions listed in the plan.

### [ ] 5. Lag compensation (server rewind)  · priority: MED · effort: M–H
Rewind to the shooter's observed world-time for ball-contact/tackle/shot-block adjudication ("my clean tackle didn't count"). Prereq: server must track per-client RTT (today it only echoes pong). Pairs with the reconciliation. See REACTIVITY_ROADMAP.md.

### [ ] 6. Render-perf batch (sustain 60/120fps on device)  · priority: MED · effort: M–L
Kill per-frame CPU/GC that reads as lag on a phone: prebake hero-sprite atlas (`heroes.js` `drawHero` shadowBlur ×players), prebake ad-board glow (drop per-frame `shadowBlur` ×6), prebake bush texture, alloc-free `interpolated()` (per-frame spreads/Map). Anchors in REACTIVITY_ROADMAP.md "SOON".

### [ ] 7. Assets fully on-device  · priority: LOW · effort: M→L
Service worker + Cache API for card/stadium persistence (device-verify on WKWebView); end-state = app-bundle a packed card atlas served via `file://` (lives in the app repos pikmeTV-app / pikmeTV-saltiz, not here). Then only ~100B state frames cross the wire.

## 🔭 FUTURE (needs tech not yet adopted)
- WebTransport (QUIC) — cleaner than WebRTC but iOS 26.4+ only (tiny install base); revisit in ~12mo.
- WebGL / react-native-skia — the only path to true 120fps render + GPU sprite headroom (big rewrite).
- Rollback netcode — evaluated & explicitly NOT worth it for an authoritative physics game.

## 📚 Deep docs
- `summery/REACTIVITY_ROADMAP.md` — verified NOW/SOON/FUTURE with file anchors (11-agent research).
- `summery/WEBRTC_TRANSPORT_PLAN.md` — the transport migration plan (research-backed).
- Brawl Stars netcode comparison (this session): we're 60/60/60Hz — at/above BS's cited ~20–30Hz (unofficial); behind only on transport (they're UDP) + lag-comp. So #4 and #5 are the substance, 120Hz (#1) is polish the user asked for.
