# football-mock Reactivity & Sharpness Roadmap

Goal: make the game feel **extra reactive & sharp**, with **assets resident on the phone** and the wire carrying **only position/state data points**. Merged from four research domains + feasibility verification. Anchors are corrected to the verified line numbers; each item folds in the verifier's caveats.

---

## NOW — implement immediately (low risk, current stack)

Cheap, self-contained wins that can ship in ~a week with no protocol or platform change.

- **Instant muzzle flash + recoil + shake on the release edge** — S. `releaseShot()` fires audio but spawns *no* visual feedback today. Reuse the existing fx system (`client.js:152-201`), `shake()` (`:202`), and nudge `predVel` opposite aim. *Why:* masks ~ping/2 + 55ms of dead air before the authoritative bullet shows; purely cosmetic, cannot desync (stepPrediction re-eases predVel every step). *Anchor:* `client.js` releaseShot ~`:2989`.

- **Predict the carried ball to the local predicted body** — S/M. Ball is rendered ~55ms in the past; while `owner===me` snap it to the predicted position and reconcile on the next snapshot. Handle owner-change (strip/turnover) via the already-tracked `previousBallOwner` to avoid a double-render. *Why:* dribbling/shooting stop trailing your body a length behind. *Anchor:* `client.js:3714` (ball interp), `:2428` (holdingBall).

- **Adaptive interpolation delay + short-window extrapolation** — M. Replace the hard-coded 55ms with a delay sized to measured snapshot jitter (`tRecv`) clamped ~40-120ms; when render time overruns the buffer, extrapolate ~2 ticks from the wire's `vx/vy` instead of freezing on `snaps[0]`. The 1.5s ping/pong already runs — feed it in. *Why:* sharper on clean links, no hitch on cellular. Subsumes the "remote extrapolation" idea from the input domain. **Ship together with the snapshot-rate change (SOON).** *Anchor:* `client.js:37`, interpolated `:3692`, pong `:2496`.

- **Memoize `wallJoints`** — S. It's O(n²) with line-intersection math + per-cluster `Set`/`find`, recomputed every frame, but the hard-wall set only changes on arena swap. Cache `{cx,cy,r,poly}[]` keyed on the active arena identity. Zero visual change; leave the editor-path `fbRender` call alone. *Anchor:* per-frame call `client.js:5077`, fn `:5531`.

- **Prebake the procedural bush leaf texture per bush** — S. `drawBush` runs a nested hash+sin per-cell loop every frame; the code's own comment says the layout is "essentially static" with only a ±0.8px sway. Bake once per bush (keyed on scale/arena), blit, drop or single-jitter the sway. *Anchor:* `client.js:4965`, call `:5073`.

- **Opaque context hints + memoize `idSeed`** — S. Request `worldBuf` and `bgCanvas` with `{alpha:false}` (both are fully painted each frame) to skip per-pixel blending on the two biggest surfaces — **not** `mainCtx` (`:3573`), which composites the transparent HUD. Memoize the per-player `p.id.charCodeAt` loop in a small Map. No `getImageData` exists anywhere, so `willReadFrequently` stays false. *Anchor:* getContext `client.js:3582` & `:3587`; idSeed `:4407`.

- **Preload AND `decode()` the full card pool during lobby/countdown, before the first bake** — S. matchStart *already* preloads rosters (`:2547`), but nothing calls `img.decode()`, so every card that streams in flips `audNeedsRebake` and triggers a full 12-layer crowd re-bake — hundreds of re-bakes at kickoff for a large album. Extend the early preload to `allCards()` and gate readiness on `Promise.allSettled(imgs.map(i=>i.decode()))` so the crowd bakes **once** on a decoded pool. *Why:* kills the crowd pop-in and the re-bake storm; stands are full and sharp on frame one. *Anchor:* onload `client.js:698`, drawAudience `:3934`.

- **Tighten snapshot backpressure (64KB → ~1-4KB)** — S. At ~100B/frame the 64KB limit lets ~640 frames (~10s of stale state) queue before dropping; since every frame is a full keyframe, all but the newest are worthless. A stalled mobile client then resumes on near-current state instead of replaying a backlog. Tune against the `/s` counter at `client.js:4797`. *Anchor:* `server.js:25`, drop check `:701`.

- **WS-level heartbeat (ping / isAlive / terminate)** — S. The only ping/pong today is app-level for the RTT display; a half-open TCP socket (wifi→cellular, backgrounded) lingers as a zombie holding a match slot until OS timeout. Add a ~15-30s `ws.ping()`+isAlive sweep (browsers auto-pong, no client code). Note: the AFK→bot conversion is an *input*-inactivity timer, not socket liveness — this is not already covered. *Anchor:* `server.js:1004`.

- **Reconnect jitter + backoff** — S. `onclose` reconnects on a fixed 1500ms timer → synchronized reconnect storms on a deploy/flap. Add randomized jitter + a short ramp. *Anchor:* `client.js:2418`.

- **Cache-Control immutable split for `/assets/*`** — S. `server.js:54-59` blankets *every* static file with `no-store`, so `block-stadium.webp`/`fire-sheet.png`/saltiz marks re-download on every mount. Serve `/assets/*` `immutable, max-age=1y`, keep `no-store` only for `index.html`/`client.js`. **Mandatory pairing:** add a `?v=hash` cache-bust to the three script/style tags (`index.html:8`, `:745`, and the easily-missed `:751` `_layout-edit.js`) and add `.png` to the MIME map (`:36-44`, currently missing) — this is the `/api/claims` stale-cache trap, so get the split right or you ship stale `client.js`. *Anchor:* `server.js:54-59`.

---

## SOON — bigger, but proven on this stack

WebSocket/Canvas2D still; no new platform tech. The netcode headline (first item) is the top priority once the NOW batch lands.

- **★ Reconciliation WITH input replay + server per-tick input queue & seq ack** — M+M, the single biggest "reactive" win. Three coordinated changes: (1) carry the acked input seq back on the wire — `lastSeq` is currently a *deliberately-dropped* dead field (wire.js header comment) though `sim.js:549/664` records it; add a u16 for the **local slot only**. (2) Client keeps unacked inputs (tagged at `:3562`) in a ring buffer, and on each snapshot hard-sets to the authoritative own pos, drops acked inputs, and **replays** the rest through `stepPrediction` (`:2924`) — replacing the flat `*0.2` blend at `:2950`. (3) Server drains a per-player input **queue** in seq order (today `room.inputs.set` keeps only the newest packet), records the highest stepped seq as the ack, and bounds the queue (drop-oldest). This also lets the sticky fire/aim-lock anti-coalescing hack largely retire. **Honest caveat:** movement replay is exact *except* server knockback (`kvx/kvy`) and strips, which the client mirror doesn't model — a hit inside the unacked window produces a small bounded error until the next snapshot. Keep scope movement-only. *Anchor:* client `:2950/2924/3562`, wire.js encodeKeyframe, server `:1203/623/632`.

- **Prebake hero sprites to an offscreen frame-atlas** — L. `drawHero` is dozens of fillRects + articulated limb math + per-frame `shadowBlur` (`heroes.js:365/378`), ×up-to-8 players ×60fps. Bake each cosmetic's walk/idle cycle (~8 quantized phases) once, then blit one `drawImage` per player, `shadowBlur` baked in. Two nuances: front/back are **distinct** sprites (not L/R mirrors), and the horizontal mirror loses the eye-look offset (imperceptible at pixel scale). Keep the procedural path as fallback for rare dynamic poses (`resolvePose:292`). *Anchor:* `heroes.js:338`, call `client.js:4425`.

- **Prebake ad-board glow/text; fake the pulse with alpha** — M. 6 boards/frame each call `shadowBlur` + `measureText` + `createLinearGradient` — the most expensive Canvas2D primitives, live. Bake glow+text once per ad id/size, modulate `globalAlpha` for the pulse, keep only the cheap gloss-sweep live, scroll the marquee as a prebaked strip via source-x. Invalidate on the 3.5s `idxBase` rotation. *Anchor:* `client.js:4065`, shadowBlur `:4016/4023/4050/4062`.

- **Alloc-free `interpolated()`** — M. Runs every frame allocating: `map` with `{...pa}` spread, O(n²) `find` by id, a new Map for projectiles, new arrays + return object → steady GC hitches. Lerp into a reused scratch view. **Caveat:** decodeSnapshot emits only *present* (mask-filtered) slots, so naked index-pairing is unsafe when a player joins/leaves/dies between frames — pair by index but guard with `pb.id===pa.id` and fall back. The view is consumed same-frame, so reuse is safe. *Anchor:* `client.js:3692`.

- **Runtime crowd texture atlas** — M. `bakeAudience` downsamples each full-res Supabase webp into a 72×92 cell per seat (up to 800), re-run on every rebake. Draw each **distinct** card once into one atlas, then blit sub-rects. **Honest framing:** the win is *bake-time* (each card downsampled once, not up to 800×; re-bakes become blits), **not** per-frame — `drawAudience` already just blits the 12 pre-baked bob layers. *Anchor:* `client.js:3920`.

- **Off-thread decode via `createImageBitmap`** — S/M. Move card decode off the main thread. **Use `createImageBitmap(imgElement)` from the already-loaded `<img>`** — the research's `fetch→blob` path is subject to Supabase CORS (the `crossOrigin`-unset comment does *not* prove Supabase sends CORS headers), whereas decoding the element is CORS-free. OffscreenCanvas needs iOS 16.4+; guard and fall back to `Image()+decode()`. Pairs with the atlas. *Anchor:* `client.js:693`.

- **rAF fixed-step accumulator replacing the input `setInterval`** — M. Accumulate real dt inside the existing rAF loop, emit inputs + `stepPrediction` in fixed 1/60 steps, sample the stick just before paint; make the render ease (0.55/frame) and reconcile (0.2/snap) dt-independent so 60Hz and 120Hz feel identical. Clamp the accumulator against a spiral-of-death. Compatible with the already-shipped send-on-edge path (edges still flush immediately). *Anchor:* setInterval `client.js:3565`, ease `:5135`, reconcile `:2950`.

- **Delta-compressed snapshots + decouple snapshot rate from tick + harder quantization** — L. `MSG_DELTA` against a client-acked baseline (msgType byte + `rosterVersion:87` are the right seams), plus dropping broadcasts to ~20-30Hz while sim/input/prediction stay 60Hz. **Requires a new client→server snapshot-ack channel** (none exists) + periodic keyframes for lossy recovery. **Note the history:** 60Hz was *deliberately restored* once the binary wire killed the old JSON parse cost (constants comment `:18-21`) — downrating is still right for a phone WebView, but retune INTERP_DELAY to the larger interval and ship with the adaptive-delay NOW item. *Anchor:* wire.js `:14/61/87`, server `:766/767`, constants `:22/25`.

- **Lag compensation / server rewind** — L. Hits resolve against *current* positions though the shooter aimed ~55ms+RTT in the past. Keep a per-tick position ring buffer and rewind (positions only, bounded ~200-250ms) to `serverNow − RTT − interpDelay`. **Unstated prerequisite the research got wrong:** the server does **not** track RTT today (`:1225` only echoes pong) — first add a server-timestamped ping or a client-reported commandTime. Pure server-side logic otherwise. *Anchor:* sim.js hit resolution `:356/373/599`.

- **Full authoritative local projectile prediction (ghost→real handoff)** — M. Spawn a client-predicted bullet on release and match it exactly to the authoritative one. Needs a wire change (client sends a predicted-projectile id; server stamps it back in the projectiles section, `wire.js:62`) plus mirroring the server's quick-shot auto-aim rule client-side. Extension of the carried-ball NOW item. *Anchor:* wire.js `:62`.

- **Service worker + Cache API for card/stadium persistence** — M. New `public/sw.js`, cache-first for images, network-first for code. **Platform caveats:** registers only on the https Render origin (not Mac-dev LAN http — no localhost exemption); WKWebView SW support is OS/app-version dependent and **must be verified live on device**; this is runtime caching (still needs the first download), a step toward — not — true on-device bundling. Never cache-first the code files. *Anchor:* `index.html` registration.

- **Sub-frame touch via `getCoalescedEvents` + passive non-game listeners** — M. **Reduced scope:** the reticle *already* tracks the finger at touchmove rate (`manualAim:4525`), so the only real gain is 120Hz sub-frame freshness on the captured released-shot direction. Add an additive Pointer path with a Touch fallback; keep the joystick listener `passive:false` (needs preventDefault), mark hub/scroll listeners passive. *Anchor:* updateStick `client.js:3358-3375`.

- **Aim smoothing (± soft aim-assist)** — M, **product call not a default.** Low-pass smoothing of the aim vector is safe and trivial. Magnetism, however, **contradicts a deliberate design decision** — client auto-aim was explicitly removed ("you point where you shoot", `client.js:4519-4521`). `quickShotTarget:4538` picks nearest-enemy regardless of aim, so any assist needs an added aim-cone filter and is a bias-only change on the client-sent `aimX/aimY` (server still validates). Escalate to product before implementing. *Anchor:* `client.js:4519/4538`.

---

## FUTURE — needs technology not yet adopted

- **UDP-style transport — WebRTC DataChannel (today) or WebTransport/QUIC (later).** *Needs:* the current stack is `ws`-only over one TCP stream, so a single lost snapshot head-of-line-blocks everything behind it — the real source of cellular rubber-band the fixed interp delay papers over. WebRTC (unreliable+unordered) is the most-available path but needs STUN+TURN, a `react-native-webrtc` bridge/shim in the WebView, and a Node endpoint (`node-datachannel`/`werift`). WebTransport is the cleaner fit but needs iOS 26.4+ (tiny install base mid-2026) and immature Node QUIC tooling. **Both require migrating off Render's L7 proxy to a UDP-capable host (Fly.io/VM).** Keep the WebSocket for reliable control frames. *Unlocks:* newest-state-wins with no HOL stall — the biggest ceiling on reactivity over mobile networks.

- **GPU renderer — WebGL2/WebGPU batched sprites (PixiJS v8) or react-native-skia native canvas.** *Needs:* converting procedural art (heroes/bush/boards) into a texture atlas; Skia additionally drops the WebView bridge and is the **only** path to 120Hz (WKWebView rAF is hard-capped at 60, WebKit bug 173434). *Cost:* large rewrite of `public/*.js`. *Unlocks:* order-of-magnitude sprite headroom; native GPU sharpness; directly realizes "assets sampled from on-device atlas, wire carries only state."

- **OffscreenCanvas + Worker render thread.** *Needs:* `transferControlToOffscreen`; verify OffscreenCanvas on the target WKWebView/Android WebView versions (the gating constraint). Lighter than a full GPU port. *Unlocks:* GC/bake spikes no longer stall input or the socket receive path.

- **WASM client-side sim.** *Needs:* compile `shared/sim.js`'s hot path to WASM (Rust/AssemblyScript) with deterministic floats matching the Node server. *Unlocks:* full-state prediction (ball + projectiles), not just movement, with smaller corrections.

- **Phone-bundled assets — the end-state of "assets on the phone."** *Needs:* bundle `public/` shell + a packed card atlas into the RN app (expo-asset), serve the WebView from `file://` with `allowFileAccess`/`allowingReadAccessToURL`, and self-update new cards via a versioned manifest in `expo-file-system` (optionally AVIF with WebP fallback to cut transfer bytes). **Note the wire half is already done** — the roster control frame carries name/team/char + a small skin id *once*, snapshots carry no art, and audio is already served from bundled `public/`. This remaining work lives in the **app repos (pikmeTV-app / pikmeTV-saltiz)**, not football-mock. *Unlocks:* instant, native-res art on cellular; socket reduced to ~100B state frames.

- **ProMotion 120Hz.** *Needs:* a native CADisplayLink shim (WebKit private API — App Store review risk) or the Skia path. Only meaningful once the NOW per-frame CPU cost is already low. *Unlocks:* 120fps + lower input-to-photon latency.

- **Rollback netcode — documented as NOT worth adopting.** Wrong fit for a 2v2 authoritative-server *physics* football (it needs a deterministic fixed-point sim and would resimulate the whole world — bombs, knockback, walls — every rollback frame on a phone). The one thing worth borrowing, local-input immediacy, is already captured by the input-replay reconciliation (SOON ★) and carried-ball prediction (NOW). Recorded so the team doesn't chase it.

- **Interest management / per-client snapshot views.** Only justified beyond `MAX_PLAYERS=4` (bigger arenas/spectators). *Needs:* per-client spatial encode + per-client delta baseline. Defer until larger modes exist.

### Already done / dropped
- **Send-on-edge inputs** — *already implemented*: `flushInput()` fires synchronously on shot/build/special edges, and the server latches fire idempotently (`prev.fire || msg.fire`, edges consumed once/tick), so the "double-fire" risk is already mitigated. No work.
- **TCP_NODELAY** — *already set* (`server.js:1006`); its HOL limit is why the transport item is in FUTURE.
- **perMessageDeflate** — *already off* (ws default); just add a "keep off — frames are near-incompressible" comment to prevent a future regression.
- **"Only position/state on the wire"** — the **in-repo half is already done** (roster + skin-id model above); remaining is app-repo bundling (see Phone-bundled assets).

---

### Recommended sequence
1. Ship the entire **NOW** batch first (render bakes + backpressure + heartbeat + adaptive interp/extrapolation + muzzle/carried-ball feedback + cache headers) — a week of low-risk reactivity and sharpness with no protocol change.
2. Land the **★ input-replay reconciliation + server input queue/ack** (SOON) — the headline drift-free feel — then stack **projectile ghost prediction** and the **rAF fixed-step accumulator** on top of it.
3. Do the render-bake refactors (**hero sprite atlas, ad-board glow, alloc-free `interpolated()`, crowd atlas + off-thread decode**) to kill GC/bake hitches, and add **service-worker persistence** (verified on device).
4. Add **lag compensation** (after the RTT prerequisite) and **delta/downrate snapshots** (once the ack channel exists); treat **aim-assist** as a product decision, not a default.
5. Only then evaluate **FUTURE**: prototype **WebRTC on a UDP-capable host** as the transport ceiling and **app-side asset bundling** to finish "assets on the phone" — and explicitly skip **rollback**.