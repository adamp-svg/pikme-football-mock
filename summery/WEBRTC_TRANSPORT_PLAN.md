# Plan — Move the battle stream off TCP → WebRTC DataChannel (UDP)

> Research-backed **plan only** (no code yet). Goal: eliminate TCP head-of-line (HOL) blocking on
> mobile networks — the #1 real gap vs Brawl Stars — by carrying the 60Hz snapshot/input stream
> over an **unreliable + unordered WebRTC DataChannel (UDP)**, while keeping WebSocket for reliable
> control. Everything stays **feature-flagged with a WebSocket fallback** so the game never breaks.

## 1. Why (the problem this solves)
- Today: one **WebSocket over TCP** stream carries everything (join/lobby/roster + 60Hz binary
  snapshots + inputs). `TCP_NODELAY` is on, so latency is fine on a clean link.
- On a lossy mobile link (wifi↔cellular handoff, congestion), **one lost TCP segment stalls every
  byte queued behind it** until retransmit (~1 RTT) → the classic "freeze, then snap" rubber-band.
  Our reconciliation + interpolation only *hide* this; they can't remove it.
- BS (and every twin-stick mobile action game) almost certainly runs **UDP**: a lost packet is just
  superseded by the next snapshot. This plan gives us the same property.

## 2. Target architecture (hybrid, not a rewrite)
Keep the WebSocket; **add** a DataChannel next to it. Two lanes:

| Lane | Transport | Carries | Reliability |
|---|---|---|---|
| **Control** | existing WebSocket (TCP) | join, lobby, roster, matchStart, settings, chat, **WebRTC signaling** | reliable, ordered |
| **Realtime** | **WebRTC DataChannel** (SCTP/DTLS/UDP) | 60Hz binary snapshots (server→client) + inputs (client→server) | **unreliable, unordered** (`ordered:false, maxRetransmits:0`) |

- The **existing binary wire codec (`shared/wire.js`) is unchanged** — the same ~100–150B keyframe
  bytes just travel over the DataChannel instead of `ws.send`. Client `decodeSnapshot` is unchanged.
- **Signaling reuses the WebSocket** we already have (SDP offer/answer + ICE candidates as JSON
  control messages). No separate signaling server needed.
- **Fallback:** if the DataChannel fails to open within a timeout (or errors mid-match), transparently
  keep using the WebSocket for snapshots/inputs. A `USE_WEBRTC` flag gates the whole thing.

## 3. Tech choices (from research)
- **Server WebRTC:** [`node-datachannel`](https://www.npmjs.com/package/node-datachannel) (Node bindings for the C++ `libdatachannel`) — mature, production-ready, supports `ordered:false` + `maxRetransmits:0` for a true unreliable channel. (`werift` is pure-TS but early-stage — no TURN, missing pieces — so not for v1. [comparison](https://www.webrtc-developers.com/did-i-choose-the-right-webrtc-stack/))
- **Client WebRTC:** the game runs in an **iOS WKWebView**, which supports `RTCPeerConnection` + DataChannels natively. Since the **server has a public IP**, the client only needs to *reach* the server — the WKWebView "no host candidate" limitation doesn't block client→public-server. **Fallback** if a target WKWebView/Android-WebView version misbehaves: run WebRTC in the RN layer (`react-native-webrtc`) and bridge bytes to the WebView via `postMessage`. ([react-native-webrtc](https://github.com/react-native-webrtc/react-native-webrtc), [WebRTC-in-WebView notes](https://medium.com/@akinkuotubright/webrtc-in-react-native-webview-eda6d236c394))
- **NAT traversal:** server on a **public IP** → client connects directly. Start **STUN-only** (a public STUN like Google's for the client's reflexive candidate, or even a static server host-candidate); **defer TURN** — it's only needed as a relay for symmetric-NAT clients and adds a hop+infra. Add a TURN fallback later only if connect-success telemetry shows gaps. ([STUN vs TURN](https://getstream.io/resources/projects/webrtc/advanced/stun-turn/))
- **Host (the forcing move):** **Render's managed L7 proxy cannot pass UDP** → migrate the realtime server to a **UDP-capable host**. [**Fly.io**](https://fly.io/docs/networking/udp-and-tcp/) supports UDP but needs a **dedicated IPv4** (~$2/mo, waived under the monthly threshold), binds UDP to `fly-global-services`, and **does not do UDP over IPv6**. A plain VM (Hetzner/DigitalOcean) with a public IP is the simpler alternative. WebSocket/control can stay on the same host.

## 4. Signaling flow (reuses the WebSocket)
1. Client joins over WebSocket as today.
2. On `matchStart` (or right after join), client creates `RTCPeerConnection`, creates the DataChannel (`ordered:false, maxRetransmits:0, negotiated` or in-band), makes an **SDP offer**, sends it as a `{type:'rtcOffer', sdp}` WS control message.
3. Server (`node-datachannel`) sets remote description, creates an **answer**, returns `{type:'rtcAnswer', sdp}`; both sides trickle **ICE candidates** as `{type:'rtcIce', cand}` WS messages.
4. DataChannel `open` → flip that client's snapshot egress + input ingress to the DataChannel; WS goes quiet except control + heartbeat.
5. DataChannel `close`/`error` or open-timeout → fall back to WS transport for that client.

## 5. What changes in our code (seam map — for when we build)
- **Server (`server.js` / new `rtc.js`):** add a `node-datachannel` peer per member; signaling handlers on the existing WS message switch; in `broadcastSnapshots`, if a member has an open DataChannel send the encoded keyframe there (`dc.sendMessageBinary`) instead of `ws.send`, else WS. Input ingress: also accept binary/JSON inputs from the DataChannel `onmessage`.
- **Client (`public/client.js`):** add an `RTCPeerConnection` + DataChannel setup after `matchStart`; route `decodeSnapshot` off `dc.onmessage` when open (same code path as the current `ws.onmessage` binary branch); send inputs via `dc.send` when open (the existing `flushInput` just picks the transport). Keep `binaryType='arraybuffer'`.
- **Wire (`shared/wire.js`):** **no change** — same bytes, new pipe.
- **Flag:** `USE_WEBRTC` (default off until proven on device), plus per-client auto-fallback.

## 6. Phased plan (each phase has a clear exit criterion)
- **Phase 0 — Spike / de-risk (½–1 day).** Standalone Node `node-datachannel` server + a browser page opening an unreliable DataChannel to it over localhost/LAN; echo our real ~120B keyframe bytes both ways. **Exit:** bytes round-trip over the DataChannel; confirm `ordered:false/maxRetransmits:0` is honored.
- **Phase 1 — Host + reachability (½–1 day).** Stand up a UDP-capable host (Fly.io dedicated-IPv4 or a VM); open the DataChannel from a **real device on cellular** to the public server (STUN-only). **Exit:** a phone on LTE connects and round-trips bytes; measure connect time + success rate.
- **Phase 2 — Hybrid integration (2–3 days).** Wire signaling over the existing WS; move snapshot egress + input ingress onto the DataChannel behind `USE_WEBRTC`, with WS fallback. **Exit:** a full 2v2 match plays over WebRTC locally; killing the DataChannel mid-match falls back to WS seamlessly.
- **Phase 3 — Loss/jitter validation (1–2 days).** Compare WebRTC vs WS under **simulated packet loss** (e.g. `tc netem` / Network Link Conditioner): rubber-band frequency, recovery time, perceived smoothness. **Exit:** under 2–5% loss WebRTC shows the newest-state-wins behavior (a skip) vs WS's freeze-then-catch-up.
- **Phase 4 — Rollout (1 day).** Ship `USE_WEBRTC` on for a % of sessions with telemetry (connect success, fallback rate, RTT); dial up. Keep WS as the permanent reliable fallback.

## 7. Risks & mitigations
- **WKWebView WebRTC quirks / OS-version variance** → verify on the real target OS versions in Phase 1; RN-layer `react-native-webrtc` + postMessage bridge is the escape hatch.
- **Symmetric-NAT clients can't connect STUN-only** → measure connect-success in Phase 1/4; add a small TURN relay only if the gap is real.
- **Hosting migration off Render** (control plane, TLS, deploy pipeline) → keep WS/control + the Render deploy working; run the UDP host in parallel and point only the DataChannel at it initially. Or move everything to the VM/Fly and keep WSS there too.
- **MTU / fragmentation** for larger frames (bombs+walls snapshots) → our keyframes are ~100–200B, well under the ~1200B safe DTLS/SCTP payload; watch it if snapshots grow.
- **Added infra + ops complexity** → the WS path stays as a first-class fallback, so WebRTC is strictly additive; we can turn it off instantly.

## 8. Effort & sequencing
- Rough total: **~1–1.5 weeks** engineering for Phases 0–3, +telemetry rollout.
- **Prerequisite from the roadmap:** this pairs with **lag compensation** (server rewind) as the two substance items; do transport **first** (bigger felt win on mobile), lag-comp second. (Raising the tick rate is NOT on the table — the user dropped 120Hz on 2026-07-25.)

## 9. Decisions needed before building
1. **Host:** Fly.io (managed, dedicated IPv4, UDP caveats) vs a plain VM (full control, more ops). 
2. **Scope of migration:** move only the realtime UDP path to the new host and keep control/deploy on Render, or move the whole server?
3. **TURN:** ship STUN-only v1 and add TURN reactively, or stand up TURN (coturn) from day one for worst-case coverage?
4. **Client WebRTC path:** native WKWebView WebRTC first (simplest), or go straight to the RN `react-native-webrtc` bridge for maximum control?

---
*Sources: [Fly.io UDP/TCP](https://fly.io/docs/networking/udp-and-tcp/) · [node-datachannel](https://www.npmjs.com/package/node-datachannel) · [WebRTC stack choice](https://www.webrtc-developers.com/did-i-choose-the-right-webrtc-stack/) · [STUN vs TURN](https://getstream.io/resources/projects/webrtc/advanced/stun-turn/) · [react-native-webrtc](https://github.com/react-native-webrtc/react-native-webrtc) · [MDN WebRTC data channels](https://developer.mozilla.org/en-US/docs/Games/Techniques/WebRTC_data_channels). Prior in-repo research: summery/REACTIVITY_ROADMAP.md (transport section).*
