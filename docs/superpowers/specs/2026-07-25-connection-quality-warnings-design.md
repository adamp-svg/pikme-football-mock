# Connection-quality warnings (in-game network alerts)

- **Date:** 2026-07-25
- **Repo:** `football-mock` (Saltiz football game)
- **Status:** design approved, implementation not started
- **Slice:** own connection only, client-side only

## Problem

The game gives the player no usable feedback when their internet degrades. When packets stall the
player freezes, teleports, or watches their shot not register — and reads it as *the game is broken*
rather than *my connection is bad*.

What exists today is a developer diagnostic, not a player warning: a small `#net` chip at
bottom-left rendering `` `${ping}ms · ${snapRate}/s` `` ([`public/client.js:5228`](../../../public/client.js)).
It is always visible, unlabeled, in Latin characters on an otherwise Hebrew HUD, and it means nothing
to a player. There is also `setNet()` with `מחובר / מתחבר מחדש… / מנותק`, but nothing calls it for
*degraded* — only for connect/close.

## Goal

Tell the player, in Hebrew, when their own connection is unstable — clearly enough that a freeze
reads as "my wifi" and not "this game is broken" — without adding HUD clutter when the connection
is fine.

## Non-goals (explicitly out of this slice)

- **Opponent/teammate lag warnings** ("היריב מתקשה בחיבור"). Needs `server.js` + `shared/wire.js`
  changes; deferred to a later slice to avoid colliding with other agents' in-flight server work.
- **A packet-loss percentage.** Not measurable on this transport — see Transport reality below.
- **Any fix for lag itself.** This is diagnosis and communication only. Actual latency work is
  tracked in [`OPTIMIZATION_TODO.md`](../../../OPTIMIZATION_TODO.md) and
  `summery/REACTIVITY_ROADMAP.md`.
- **A player-facing settings toggle** for detailed net stats.

## Transport reality (constrains the whole design)

Transport is **WebSocket, i.e. TCP**. TCP retransmits, so lost packets are never *missing* at the
application layer — they arrive late, behind a head-of-line block. Therefore:

- A "packet loss %" like Fortnite's **cannot be computed** here and must not be faked. Fortnite can
  show one because it runs on UDP.
- Loss manifests instead as **jitter and burst gaps** between snapshots. Those are the primary
  signals this design keys on.
- Real loss statistics are one of the wins listed in `summery/WEBRTC_TRANSPORT_PLAN.md`; if the game
  moves to WebRTC/UDP, the classifier gains a genuine `loss` input and the thresholds below get
  revisited.

## Reference behavior (what the big mobile/BR games do)

- **Brawl Stars** — a wifi glyph appears amber/red only when the connection degrades; red means a
  severe spike (~200ms+) or loss, and it flashes while the client is not exchanging data. Detailed
  network numbers are opt-in in settings. The match keeps running behind the warning.
- **Fortnite** — warning icon on the HUD (yellow/red), plus an opt-in "Net Debug Stats" overlay with
  ping, packets up/down, and loss %. Practical thresholds it teaches players: <30ms excellent,
  30–60 good, >100 noticeable.
- **Roblox** — historically showed a red bar while letting the player keep moving in a dead world,
  which reads as a broken game; the fix was making the lost-connection state unmistakable with a
  reconnect prompt. Lesson taken: a stall must be *visibly* a connection stall.

Adopted: Brawl Stars' show-only-when-bad escalation, Fortnite's threshold intuitions, and Roblox's
lesson that a full stall needs an unmistakable overlay.

## Signals

All available client-side today; none require a server or wire-format change.

| Signal | Source | Detects |
|---|---|---|
| `rtt` | existing `ping`/`pong` round trip, probe interval 1500ms → **1000ms**, last 8 samples retained | baseline latency |
| `jitter` | mean absolute deviation of the RTT ring buffer | instability — the thing that actually ruins feel at acceptable ping |
| `snapGapMs` | `performance.now() - lastSnapAt`; expected ~16.7ms at `SNAPSHOT_RATE = 60` | freezes, in milliseconds rather than seconds — fastest signal available |
| `snapRate` | existing snapshots/sec counter vs 60 | congestion, throttled or backgrounded tab |
| `unacked` | `inputSeq - server.lastSeq` (`lastSeq` is already on the wire from the input-replay work) | **upstream** stalls, which the RTT probe alone can miss |
| `wsOpen` | `ws.readyState === OPEN`, existing `onclose` | offline / reconnecting |

## Classifier

A pure function in a new `public/net-quality.js`. No DOM access, no globals, fully unit-testable.

```js
classify({ rtt, jitter, snapGapMs, snapRate, unacked, wsOpen }) → { level, reason }
```

Levels, evaluated worst-first:

| Level | Condition |
|---|---|
| `offline` | `wsOpen === false` |
| `stalled` | `snapGapMs > 400` |
| `poor` | `rtt > 180` \|\| `jitter > 60` \|\| `snapRate < 30` \|\| `unacked > 12` |
| `fair` | `rtt > 110` \|\| `jitter > 30` \|\| `snapRate < 48` \|\| `unacked > 6` |
| `good` | none of the above |

`reason` names the signal that tripped the level (e.g. `'jitter'`, `'gap'`) — used by the debug
readout and by log lines, never shown to the player.

Thresholds are exported constants, tuned for a 60Hz sim with `INTERP_DELAY = 55ms`, and live in one
place so they can be retuned without touching UI code.

### Hysteresis (the part that makes or breaks this feature)

Raw per-frame classification strobes on a marginal connection, and a flickering warning icon is
worse than no icon at all. So the state machine wraps the classifier with:

- **Escalation dwell:** a worse level must persist ~600ms before it is shown.
- **De-escalation dwell:** `good` must hold ~2500ms before the indicator hides.
- `offline` and `stalled` escalate immediately (no dwell) — a freeze must be acknowledged instantly.

Both dwell times are exported constants.

## UI

Three escalating layers. Hebrew, RTL, consistent with the existing HUD. Anchored top-right near the
timer — deliberately outside the thumb zones occupied by the joysticks.

| Level | On screen |
|---|---|
| `good` | nothing |
| `fair` | 3-bar wifi glyph fades in, amber, 2 of 3 bars lit |
| `poor` | 1 of 3 bars, red, flashing, plus a one-shot toast `חיבור לא יציב` that auto-hides after ~3s |
| `stalled` / `offline` | field dimmed + spinner + `מתחבר מחדש…`; local prediction keeps running so recovery is seamless |

Rules:

- The toast fires **once per poor episode**, not on a repeating timer. It warns; it does not nag.
- The stall overlay is **non-blocking** — input is still accepted and the match keeps running, so a
  brief stall recovers without the player losing control. It clears as soon as snapshots resume.
- The stall layer reuses the existing reconnect path and `setNet()` states rather than adding a
  parallel mechanism.
- The existing `` `${ping}ms · ${snapRate}/s` `` chip becomes debug-only, shown under `?debug=net`.

## Files

| File | Change |
|---|---|
| `public/net-quality.js` | **new** — thresholds, `classify()`, hysteresis state machine. Pure, ~100 lines. |
| `test-net-quality.mjs` | **new** — node test, repo `test*.mjs` convention. |
| `public/client.js` | RTT ring buffer + 1000ms probe, stamp `lastSnapAt`, feed the classifier each frame, render the three layers, move the dev chip behind `?debug=net`. |
| `public/index.html` | markup for the bars icon, toast, stall overlay. |
| `public/style.css` | bars, amber/red states, flash animation, dim overlay. |

**No `server.js` and no `shared/` changes.** This keeps the 26-test suite untouched, needs no server
restart, and cannot collide with the other agents' in-flight `shared/sim.js` stats work.

## Verification

- **Unit** (`test-net-quality.mjs`): each threshold boundary maps to the expected level; worst-first
  precedence holds when several signals trip at once; escalation and de-escalation dwell behave;
  an oscillating input sequence produces **no** level flapping; `offline`/`stalled` bypass dwell.
- **Manual:** `?netsim=fair|poor|stalled` forces a level so each visual state can be verified without
  degrading a real network. Also spot-checked with browser network throttling.
- **Regression:** `node --check` on touched files + the full suite (`for f in test*.mjs; do node $f; done`),
  reporting real output and listing the known pre-existing failures separately.

## Risks

- **Threshold miscalibration** — numbers are informed estimates for this sim, not measured against
  real Saltiz player traffic. They are isolated as exported constants, and `?debug=net` surfaces live
  values so they can be retuned from observation rather than guesswork.
- **False alarms from a backgrounded tab** — phone lock or app switch tanks `snapRate` and looks like
  a stall. The overlay is non-blocking and self-clearing, so the cost of the false positive is small;
  a `document.hidden` suppression can be added if it proves annoying in practice.

## Later slices (not now)

1. Opponent/teammate lag indicator (server tracks per-client ack gaps → broadcast).
2. Genuine loss statistics once/if WebRTC lands (`summery/WEBRTC_TRANSPORT_PLAN.md`).
3. Optional player-facing net-stats toggle in settings, if players ask for it.
