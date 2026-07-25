# Connection-Quality Warnings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the player, in Hebrew, when their own internet connection is unstable — amber/red wifi bars that appear only when the connection degrades, plus a non-blocking dim+spinner on a full stall.

**Architecture:** A new pure module `public/net-quality.js` holds the thresholds, a `classify()` function, and a hysteresis state machine. It touches no DOM, no timers, and never calls `performance.now()` — the caller passes `now` and the raw samples in, so the same file runs unchanged under node for unit tests. `public/client.js` collects the samples it already has (RTT, snapshot gap, snapshot rate, unacked inputs, socket state), feeds them to the monitor once per HUD frame, and renders three escalating layers.

**Tech Stack:** Vanilla ES modules (no bundler — `public/` is served at the web root, `client.js` is loaded as `<script type="module" src="/client.js">`), node for tests (`package.json` has `"type": "module"`), plain `console.log` PASS/FAIL test harness matching the repo's existing `test*.mjs` convention.

**Spec:** [`docs/superpowers/specs/2026-07-25-connection-quality-warnings-design.md`](../specs/2026-07-25-connection-quality-warnings-design.md)

## Global Constraints

- **Do NOT modify `server.js` or anything in `shared/`.** Other agents have in-flight uncommitted work in `shared/sim.js` and `shared/constants.js`. Touching those files would collide with them and put the test suite at risk. Everything in this plan is client-side.
- **Do NOT invent a packet-loss percentage.** Transport is WebSocket = TCP; retransmits mean lost packets arrive late rather than going missing, so there is no loss % to measure. Loss surfaces as jitter and gaps.
- **`public/net-quality.js` must stay pure** — no DOM, no `setInterval`, no `performance.now()`, no imports from `client.js`. Time enters only as a `now` argument. This is what makes it node-testable.
- **All player-facing copy is Hebrew**, matching the existing RTL HUD. Exact strings: `חיבור לא יציב` (poor toast), `מתחבר מחדש…` (stall overlay).
- **Threshold values are exported constants** in one object (`NET_T`), never inlined at a call site.
- Commit locally after every task. **Never `git push`** unless the user asks in that message (see `CLAUDE.md`).
- Before claiming a task done: `node --check` the touched files and run the full suite `for f in test*.mjs; do node $f; done`. Report real output; list pre-existing failures separately.
- Test server is `PORT=3012 node server.js` (`:3010`/`:3011` belong to other agents). Client-only changes need just a browser reload, not a server restart.
- **⚠️ Never trust a line number in this plan.** Other agents edit `public/client.js` and `public/index.html` concurrently, and the numbers drifted by ~30 lines *while this plan was being written*. Every edit site below is identified by a **unique greppable anchor string**; find it first, then edit. Line numbers, where mentioned at all, are stale hints only.

## Locating the edit sites

Run this first; each anchor should return exactly one line:

```bash
grep -n "import { decodeSnapshot }\|^let snapRate\|setInterval(() => { snapRate\|pingIv = setInterval(sendPing\|ping = Math.round(performance.now() - msg.t)\|^      snapCount++;\|setNet('reconnecting…')\|^function drawHUD\|getElementById('net').textContent = \`" public/client.js
grep -n 'class="net" id="net"\|<div id="hud">' public/index.html
grep -n "^\.net {" public/style.css
```

If any anchor returns zero or multiple hits, another agent has rewritten that area — re-read the surrounding code and adapt rather than forcing the edit.

---

### Task 1: Pure classifier — thresholds and level selection

**Files:**
- Create: `public/net-quality.js`
- Test: `test-net-quality.mjs`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `NET_T` — threshold constants object: `{ fair: {rtt, jitter, snapRate, unacked}, poor: {rtt, jitter, snapRate, unacked}, stallGapMs, escalateMs, recoverMs }`
  - `NET_RANK` — `{ good: 0, fair: 1, poor: 2, stalled: 3, offline: 4 }`
  - `NET_LEVEL_BY_RANK` — `['good','fair','poor','stalled','offline']`, the inverse of `NET_RANK` (Task 2 maps a rank back to a level name with it)
  - `rttJitter(samples: number[]) → number` — mean absolute deviation; `0` for fewer than 2 samples
  - `classify(sample, T = NET_T) → { level: 'good'|'fair'|'poor'|'stalled'|'offline', reason: string }` where `sample` is `{ rtt, jitter, snapGapMs, snapRate, unacked, wsOpen }`

- [ ] **Step 1: Write the failing test**

Create `test-net-quality.mjs`:

```js
// Connection-quality classifier: threshold boundaries, worst-first precedence, and the
// hysteresis that stops the on-screen warning from strobing on a marginal connection.
import { NET_T, NET_RANK, rttJitter, classify } from './public/net-quality.js';

let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + '  ' + m); if (!c) fails++; };

// A sample that classifies as 'good', so each test can perturb exactly one field.
const GOOD = { rtt: 40, jitter: 5, snapGapMs: 17, snapRate: 60, unacked: 1, wsOpen: true };
const s = (over) => ({ ...GOOD, ...over });
const lvl = (over) => classify(s(over)).level;

console.log('--- jitter helper ---');
ok(rttJitter([]) === 0, 'no samples -> 0 jitter');
ok(rttJitter([50]) === 0, 'one sample -> 0 jitter (needs 2 to deviate)');
ok(rttJitter([50, 50, 50]) === 0, 'flat samples -> 0 jitter');
ok(rttJitter([40, 60]) === 10, 'mean 50, mean-abs-deviation 10');
ok(rttJitter([10, 10, 10, 50]) === 15, 'one spike raises the deviation (mean 20 -> 15)');

console.log('\n--- baseline ---');
ok(lvl({}) === 'good', 'a healthy sample is good');

console.log('\n--- fair thresholds (at = good, over = fair) ---');
ok(lvl({ rtt: NET_T.fair.rtt }) === 'good', 'rtt exactly at the fair threshold is still good');
ok(lvl({ rtt: NET_T.fair.rtt + 1 }) === 'fair', 'rtt just over -> fair');
ok(lvl({ jitter: NET_T.fair.jitter + 1 }) === 'fair', 'jitter just over -> fair');
ok(lvl({ snapRate: NET_T.fair.snapRate - 1 }) === 'fair', 'snapRate just under -> fair');
ok(lvl({ unacked: NET_T.fair.unacked + 1 }) === 'fair', 'unacked just over -> fair');

console.log('\n--- poor thresholds ---');
ok(lvl({ rtt: NET_T.poor.rtt }) === 'fair', 'rtt exactly at the poor threshold is still fair');
ok(lvl({ rtt: NET_T.poor.rtt + 1 }) === 'poor', 'rtt just over -> poor');
ok(lvl({ jitter: NET_T.poor.jitter + 1 }) === 'poor', 'jitter just over -> poor');
ok(lvl({ snapRate: NET_T.poor.snapRate - 1 }) === 'poor', 'snapRate just under -> poor');
ok(lvl({ unacked: NET_T.poor.unacked + 1 }) === 'poor', 'unacked just over -> poor');

console.log('\n--- stalled / offline ---');
ok(lvl({ snapGapMs: NET_T.stallGapMs + 1 }) === 'stalled', 'a snapshot gap over the limit -> stalled');
ok(lvl({ snapGapMs: NET_T.stallGapMs }) === 'good', 'a gap exactly at the limit is not yet a stall');
ok(lvl({ wsOpen: false }) === 'offline', 'a closed socket -> offline');
ok(lvl({ wsOpen: false, snapGapMs: 9999, rtt: 9999 }) === 'offline', 'offline outranks stalled and poor');
ok(lvl({ snapGapMs: 9999, rtt: 9999 }) === 'stalled', 'stalled outranks poor');
ok(lvl({ rtt: 9999, jitter: NET_T.fair.jitter + 1 }) === 'poor', 'poor outranks fair');

console.log('\n--- reason names the signal that tripped ---');
ok(classify(s({ rtt: 500 })).reason === 'rtt', 'rtt spike reports reason rtt');
ok(classify(s({ jitter: 200 })).reason === 'jitter', 'jitter reports reason jitter');
ok(classify(s({ snapGapMs: 9999 })).reason === 'gap', 'a stall reports reason gap');
ok(classify(s({ wsOpen: false })).reason === 'socket', 'offline reports reason socket');
ok(classify(s({ snapRate: 5 })).reason === 'rate', 'a snapshot-rate dip reports reason rate');
ok(classify(s({ unacked: 99 })).reason === 'unacked', 'an input backlog reports reason unacked');
ok(classify(s({})).reason === 'ok', 'a healthy sample reports reason ok');

console.log('\n--- rank ordering ---');
ok(NET_RANK.good < NET_RANK.fair && NET_RANK.fair < NET_RANK.poor
  && NET_RANK.poor < NET_RANK.stalled && NET_RANK.stalled < NET_RANK.offline, 'ranks ascend by severity');

console.log('\n--- missing fields must not crash or false-alarm ---');
ok(classify({ wsOpen: true }).level === 'good', 'an empty sample with an open socket is good, not a false alarm');

console.log('\n' + (fails === 0 ? '✅ ALL PASS' : '❌ ' + fails + ' FAILED'));
process.exit(fails ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test-net-quality.mjs`
Expected: FAIL — `Cannot find module '.../public/net-quality.js'`

- [ ] **Step 3: Write minimal implementation**

Create `public/net-quality.js`:

```js
// Connection-quality classifier for the in-game network warning.
//
// PURE BY DESIGN: no DOM, no timers, and no performance.now() — the caller passes `now`
// and the raw samples in. That is what lets this exact file run under node in
// test-net-quality.mjs instead of needing a browser.
//
// TRANSPORT NOTE (shapes every threshold below): the game speaks WebSocket, i.e. TCP.
// TCP retransmits, so a lost packet is never MISSING at the application layer — it
// arrives late, behind a head-of-line block. There is therefore no packet-loss % to
// report here (Fortnite can show one only because it runs on UDP). Loss surfaces as
// JITTER and BURST GAPS, which is why those two are the primary signals.

// Severity order. Used by the hysteresis machine to tell escalation from recovery.
export const NET_RANK = { good: 0, fair: 1, poor: 2, stalled: 3, offline: 4 };
export const NET_LEVEL_BY_RANK = ['good', 'fair', 'poor', 'stalled', 'offline'];

// Tuned for the 60Hz sim (SNAPSHOT_RATE 60) with INTERP_DELAY = 55ms. Single source of
// truth so the numbers can be retuned from observation — ?debug=net prints the live
// values next to these thresholds.
export const NET_T = {
  fair: { rtt: 110, jitter: 30, snapRate: 48, unacked: 6 },
  poor: { rtt: 180, jitter: 60, snapRate: 30, unacked: 12 },
  stallGapMs: 400,   // no snapshot for this long = a visible freeze
  escalateMs: 600,   // a worse level must persist this long before we show it
  recoverMs: 2500,   // a better level must persist this long before we downgrade/hide
};

// Mean absolute deviation of the RTT ring buffer. Cheap, and unlike a standard
// deviation it does not let one huge spike dominate the whole window.
export function rttJitter(samples) {
  if (!samples || samples.length < 2) return 0;
  let sum = 0;
  for (const v of samples) sum += v;
  const mean = sum / samples.length;
  let dev = 0;
  for (const v of samples) dev += Math.abs(v - mean);
  return dev / samples.length;
}

// Classify one instantaneous sample. Worst-first: the first matching level wins, so a
// closed socket is never reported as merely 'poor'.
export function classify(sample, T = NET_T) {
  const rtt = sample.rtt || 0;
  const jitter = sample.jitter || 0;
  const gap = sample.snapGapMs || 0;
  // A missing snapRate must not read as a dip to 0 and cry wolf before the first sample.
  const rate = sample.snapRate == null ? Infinity : sample.snapRate;
  const unacked = sample.unacked || 0;

  if (sample.wsOpen === false) return { level: 'offline', reason: 'socket' };
  if (gap > T.stallGapMs) return { level: 'stalled', reason: 'gap' };

  if (rtt > T.poor.rtt) return { level: 'poor', reason: 'rtt' };
  if (jitter > T.poor.jitter) return { level: 'poor', reason: 'jitter' };
  if (rate < T.poor.snapRate) return { level: 'poor', reason: 'rate' };
  if (unacked > T.poor.unacked) return { level: 'poor', reason: 'unacked' };

  if (rtt > T.fair.rtt) return { level: 'fair', reason: 'rtt' };
  if (jitter > T.fair.jitter) return { level: 'fair', reason: 'jitter' };
  if (rate < T.fair.snapRate) return { level: 'fair', reason: 'rate' };
  if (unacked > T.fair.unacked) return { level: 'fair', reason: 'unacked' };

  return { level: 'good', reason: 'ok' };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test-net-quality.mjs`
Expected: PASS on every line, ending `✅ ALL PASS`

- [ ] **Step 5: Commit**

```bash
git add public/net-quality.js test-net-quality.mjs
git commit -m "feat(net): connection-quality classifier (rtt/jitter/gap/rate/backlog)"
```

---

### Task 2: Hysteresis — stop the indicator strobing

**Files:**
- Modify: `public/net-quality.js` (append `createNetMonitor`)
- Test: `test-net-quality.mjs` (append a hysteresis section before the summary lines)

**Interfaces:**
- Consumes: `NET_T`, `NET_RANK`, `NET_LEVEL_BY_RANK`, `classify` from Task 1.
- Produces: `createNetMonitor(T = NET_T) → { update(sample, now) → { level, reason, raw }, reset() }`
  - `level` is the **displayed** level after hysteresis; `raw` is the un-smoothed `classify()` result (used by the `?debug=net` readout).
  - `now` is milliseconds, monotonic, supplied by the caller.

**Why this task exists:** raw per-frame classification strobes on a marginal connection, and a flickering warning icon is worse than showing nothing at all. This is the single most important behavior in the feature.

- [ ] **Step 1: Write the failing test**

Append to `test-net-quality.mjs`, immediately **before** the final `console.log('\n' + ...)` summary line:

```js
console.log('\n--- hysteresis: escalation needs sustained badness ---');
{
  const m = createNetMonitor();
  const bad = s({ rtt: 500 });                                   // classifies raw 'poor'
  ok(m.update(bad, 0).level === 'good', 'a single bad frame shows nothing yet');
  ok(m.update(bad, NET_T.escalateMs - 1).level === 'good', 'still hidden just before the dwell elapses');
  ok(m.update(bad, NET_T.escalateMs).level === 'poor', 'shows poor once the dwell has elapsed');
  ok(m.update(bad, NET_T.escalateMs).raw.level === 'poor', 'raw reports the un-smoothed level');
}

console.log('\n--- hysteresis: recovery needs sustained good ---');
{
  const m = createNetMonitor();
  const bad = s({ rtt: 500 });
  m.update(bad, 0); m.update(bad, NET_T.escalateMs);             // now showing poor
  ok(m.update(s({}), NET_T.escalateMs + 1).level === 'poor', 'one good frame does not hide the warning');
  ok(m.update(s({}), NET_T.escalateMs + NET_T.recoverMs).level === 'poor', 'still shown until good has held long enough');
  ok(m.update(s({}), NET_T.escalateMs + NET_T.recoverMs + 1).level === 'good', 'hides after good holds for recoverMs');
}

console.log('\n--- hysteresis: a stall shows immediately, no dwell ---');
{
  const m = createNetMonitor();
  ok(m.update(s({ snapGapMs: 9999 }), 0).level === 'stalled', 'a freeze is acknowledged on the first frame');
}
{
  const m = createNetMonitor();
  ok(m.update(s({ wsOpen: false }), 0).level === 'offline', 'offline is acknowledged on the first frame');
}

console.log('\n--- hysteresis: no flapping (the whole point) ---');
{
  const m = createNetMonitor();
  const bad = s({ rtt: 500 });
  let shown = 'good', flips = 0;
  // Alternate good/bad every 100ms for 10s. Neither state ever holds long enough to
  // win, so the icon must never appear -- and above all must never blink.
  for (let t = 0; t <= 10000; t += 100) {
    const r = m.update(t % 200 === 0 ? bad : s({}), t);
    if (r.level !== shown) { flips++; shown = r.level; }
  }
  ok(flips === 0, `an alternating connection produced ${flips} visible changes (must be 0)`);
}

console.log('\n--- hysteresis: sustained-worst wins while escalating ---');
{
  const m = createNetMonitor();
  // Oscillate poor/fair. 'fair' is continuously satisfied (poor is worse than fair), so
  // after the dwell we must show at least fair rather than nothing.
  let r = { level: 'good' };
  for (let t = 0; t <= NET_T.escalateMs; t += 100) {
    r = m.update(t % 200 === 0 ? s({ rtt: 500 }) : s({ rtt: NET_T.fair.rtt + 1 }), t);
  }
  ok(r.level === 'fair', `a connection flapping poor/fair still warns (got ${r.level})`);
}

console.log('\n--- reset() returns to a clean slate ---');
{
  const m = createNetMonitor();
  const bad = s({ rtt: 500 });
  m.update(bad, 0); m.update(bad, NET_T.escalateMs);
  ok(m.update(bad, NET_T.escalateMs).level === 'poor', 'showing poor before reset');
  m.reset();
  ok(m.update(bad, 0).level === 'good', 'after reset the dwell starts over');
}
```

Also extend the import at the top of `test-net-quality.mjs` to pull in the new factory:

```js
import { NET_T, NET_RANK, rttJitter, classify, createNetMonitor } from './public/net-quality.js';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test-net-quality.mjs`
Expected: FAIL — `createNetMonitor is not a function` (the Task 1 assertions still pass)

- [ ] **Step 3: Write minimal implementation**

Append to `public/net-quality.js`:

```js
// Hysteresis wrapper. Raw classification strobes on a marginal connection, and a
// blinking warning icon is worse than no icon at all — so a worse level must be
// SUSTAINED for escalateMs before it shows, and a better one for recoverMs before we
// downgrade. A freeze (stalled/offline) skips the dwell: the player is already staring
// at a frozen screen and needs to know why now.
//
// While escalating we track the WORST level that has been continuously satisfied, so a
// connection flapping poor/fair still warns at fair instead of silently cancelling
// itself. (A true good/poor flap is caught by the jitter signal, which stays high
// throughout such a pattern.)
export function createNetMonitor(T = NET_T) {
  let shownRank = 0;              // what the HUD is currently displaying
  let candRank = -1, candSince = 0, candDir = 0; // pending change: -1 = none, dir +1 up / -1 down

  const clearCand = () => { candRank = -1; candDir = 0; };

  return {
    reset() { shownRank = 0; clearCand(); },

    update(sample, now) {
      const raw = classify(sample, T);
      const rank = NET_RANK[raw.level];

      if (rank === shownRank) {
        clearCand();                                    // back to what we already show
      } else if (rank > shownRank) {                     // worse than displayed -> escalate
        if (candDir !== 1) { candRank = rank; candSince = now; candDir = 1; }
        else candRank = Math.min(candRank, rank);        // worst CONTINUOUSLY satisfied level
        const immediate = candRank >= NET_RANK.stalled;
        if (immediate || now - candSince >= T.escalateMs) { shownRank = candRank; clearCand(); }
      } else {                                           // better than displayed -> recover
        if (candDir !== -1) { candRank = rank; candSince = now; candDir = -1; }
        else candRank = Math.max(candRank, rank);        // best CONTINUOUSLY satisfied level
        if (now - candSince >= T.recoverMs) { shownRank = candRank; clearCand(); }
      }

      return { level: NET_LEVEL_BY_RANK[shownRank], reason: raw.reason, raw };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test-net-quality.mjs`
Expected: PASS on every line including the new hysteresis sections, ending `✅ ALL PASS`

- [ ] **Step 5: Commit**

```bash
git add public/net-quality.js test-net-quality.mjs
git commit -m "feat(net): hysteresis so the connection warning cannot strobe"
```

---

### Task 3: Sample the signals in the client

**Files:**
- Modify: `public/client.js` at six anchors — `import { decodeSnapshot }` (imports) · `setInterval(() => { snapRate = snapCount` (net state) · `pingIv = setInterval(sendPing` (probe rate) · `ping = Math.round(performance.now() - msg.t)` (pong handler) · `snapCount++;` (snapshot receive) · `setNet('reconnecting…')` (close handler)

**Interfaces:**
- Consumes: `createNetMonitor`, `rttJitter`, `NET_T` from Tasks 1-2.
- Produces, for Task 4:
  - `netSample() → { rtt, jitter, snapGapMs, snapRate, unacked, wsOpen }`
  - `netMonitor` — the module-level monitor instance
  - `netState` — `{ level, reason, raw }`, refreshed by `updateNetQuality()`
  - `updateNetQuality() → netState` — call once per HUD frame
  - `NET_DEBUG` — boolean, true when the URL carries `?debug=net`
  - `NET_SIM` — forced level string from `?netsim=`, or `null`

**Note on `offline`:** `ws.onclose` already calls `setNet('reconnecting…')`, `showScreen('home')` and `resetPlayNow()`, so a genuinely closed socket drops the player out of the match HUD entirely. The `offline` level therefore exists mainly for completeness; the level that matters in-match is `stalled` (a gap while the socket is still open). Do not add a second reconnect mechanism.

- [ ] **Step 1: Add the import**

In `public/client.js`, directly after the `import { decodeSnapshot } from '/shared/wire.js';` line, add:

```js
import { createNetMonitor, rttJitter, NET_T } from '/net-quality.js';
```

- [ ] **Step 2: Add the sampling state**

Find the anchor `setInterval(() => { snapRate = snapCount` in `public/client.js` and replace that line together with the three `let` lines above it, which currently read:

```js
let ping = 0;
let snapCount = 0;   // snapshots received since last sample
let snapRate = 0;    // snapshots/sec (on-screen diagnostic)
setInterval(() => { snapRate = snapCount; snapCount = 0; }, 1000);
```

with:

```js
let ping = 0;
let snapCount = 0;   // snapshots received since last sample
let snapRate = 0;    // snapshots/sec (on-screen diagnostic)
setInterval(() => { snapRate = snapCount; snapCount = 0; }, 1000);

// ---- Connection quality (see public/net-quality.js + docs/.../connection-quality-warnings) ----
// Everything here is already-available client state; nothing is added to the wire.
let rttSamples = [];           // ring buffer of the last 8 ping/pong round trips -> jitter
let lastSnapAt = 0;            // performance.now() of the newest snapshot -> freeze detection
const netMonitor = createNetMonitor();
let netState = { level: 'good', reason: 'ok', raw: { level: 'good', reason: 'ok' } };
const NET_DEBUG = new URLSearchParams(location.search).get('debug') === 'net';
const NET_SIM = new URLSearchParams(location.search).get('netsim') || null; // force a level for visual QA

// One instantaneous reading of every signal. unacked comes from pendingInputs, which the
// reconciler already trims to the server's lastSeq ack — a growing backlog means our
// INPUT is not landing, which an RTT probe alone can miss.
function netSample() {
  return {
    rtt: ping,
    jitter: rttJitter(rttSamples),
    snapGapMs: lastSnapAt ? performance.now() - lastSnapAt : 0,
    snapRate: lastSnapAt ? snapRate : null,     // null until the first snapshot: no false alarm in the lobby
    unacked: pendingInputs.length,
    wsOpen: !!(ws && ws.readyState === ws.OPEN),
  };
}

// Call once per HUD frame. NET_SIM short-circuits the monitor so ?netsim=poor can be
// used to eyeball each visual state without degrading a real network.
function updateNetQuality() {
  if (NET_SIM) { netState = { level: NET_SIM, reason: 'sim', raw: { level: NET_SIM, reason: 'sim' } }; return netState; }
  netState = netMonitor.update(netSample(), performance.now());
  return netState;
}
```

- [ ] **Step 3: Feed the RTT ring buffer**

Find the anchor `ping = Math.round(performance.now() - msg.t)` (the `pong` branch of `ws.onmessage`), which currently reads:

```js
    } else if (msg.type === 'pong') {
      ping = Math.round(performance.now() - msg.t);
```

change it to:

```js
    } else if (msg.type === 'pong') {
      ping = Math.round(performance.now() - msg.t);
      rttSamples.push(ping);                    // jitter window (mean abs deviation over the last 8)
      if (rttSamples.length > 8) rttSamples.shift();
```

- [ ] **Step 4: Stamp the snapshot arrival time**

Find the anchor `snapCount++;` (the binary-snapshot branch of `ws.onmessage` — note there is also a `snapCount = 0` in the interval you edited in Step 2; you want the bare `snapCount++;`). It becomes:

```js
      snapCount++;
      lastSnapAt = performance.now();           // freeze detector: gap since the newest snapshot
```

- [ ] **Step 5: Probe RTT once a second instead of every 1.5s**

Find the anchor `pingIv = setInterval(sendPing` and change:

```js
    pingIv = setInterval(sendPing, 1500);
```

to:

```js
    pingIv = setInterval(sendPing, 1000);       // 1s: enough samples for a usable jitter figure
```

The server already answers `{type:'ping'}` with `{type:'pong', t}` — grep `msg.type === 'ping'` in `server.js` to confirm — so this needs **no** server change.

- [ ] **Step 6: Reset the monitor on a fresh socket**

Find the anchor `setNet('reconnecting…')` inside `ws.onclose` and add directly after it:

```js
    netMonitor.reset(); rttSamples = []; lastSnapAt = 0;  // stale samples must not haunt the next socket
```

- [ ] **Step 7: Verify it collects sane numbers**

```bash
node --check public/client.js
node --check public/net-quality.js
PORT=3012 node server.js
```

Open `http://localhost:3012/?debug=net`, start a match, and confirm in the browser console that `netSample()` returns a plausible reading — `rtt` a small number, `snapRate` near 60, `snapGapMs` under ~30, `unacked` in the low single digits. There is no visible UI yet; that is Task 4.

- [ ] **Step 8: Commit**

```bash
git add public/client.js
git commit -m "feat(net): sample rtt/jitter/snapshot-gap/backlog on the client"
```

---

### Task 4: The three HUD layers

**Files:**
- Modify: `public/index.html` at anchor `<div class="net" id="net">מתחבר…</div>`, inside the `<div id="hud">` block
- Modify: `public/style.css` — append after the existing `.net {` rule
- Modify: `public/client.js` at anchors `function drawHUD()` and the chip line `getElementById('net').textContent = \`${ping}ms · ${snapRate}/s\``

**Interfaces:**
- Consumes: `updateNetQuality()`, `netState`, `NET_DEBUG`, `netSample()` from Task 3.
- Produces: `renderNetQuality(level)` — sets classes/text on `#net-bars`, `#net-toast`, `#net-stall`.

- [ ] **Step 1: Add the markup**

In `public/index.html`, find the anchor `<div class="net" id="net">` inside the `<div id="hud">` block. It currently reads:

```html
      <div class="net" id="net">מתחבר…</div>
```

with:

```html
      <!-- Connection quality. The bars are HIDDEN while the connection is healthy (Brawl
           Stars behaviour) — the icon appearing IS the warning. #net is now a debug-only
           readout, shown with ?debug=net. -->
      <div class="net-bars hidden" id="net-bars" aria-hidden="true">
        <i></i><i></i><i></i>
      </div>
      <div class="net-toast hidden" id="net-toast">חיבור לא יציב</div>
      <div class="net hidden" id="net">מתחבר…</div>
```

Then, immediately **after** the closing `</div>` of `<div id="hud">`, add the stall overlay:

```html
    <!-- Full-stall overlay: dims the field so a freeze reads as "my connection" instead of
         "the game is broken". Deliberately NON-blocking (pointer-events:none) — input keeps
         working and local prediction keeps running, so a brief stall recovers seamlessly. -->
    <div id="net-stall" class="net-stall hidden">
      <div class="net-stall-spin"></div>
      <div class="net-stall-txt">מתחבר מחדש…</div>
    </div>
```

- [ ] **Step 2: Add the styles**

In `public/style.css`, find the anchor `^.net {` and append after that rule's closing `}`:

```css
/* ---- Connection-quality warning (see public/net-quality.js) ------------------------ */
/* Anchored top-right by the timer, deliberately clear of the joystick thumb zones. */
.net-bars {
  position: fixed; top: 10px; right: 12px; z-index: 6;
  display: flex; align-items: flex-end; gap: 3px; height: 16px;
  pointer-events: none; opacity: 0; transition: opacity .25s ease;
}
.net-bars.show { opacity: 1; }
.net-bars i { width: 4px; background: rgba(240, 228, 185, .25); border-radius: 1px; }
.net-bars i:nth-child(1) { height: 6px; }
.net-bars i:nth-child(2) { height: 11px; }
.net-bars i:nth-child(3) { height: 16px; }
/* fair = 2 of 3 lit, amber. poor = 1 of 3, red, flashing. */
.net-bars.fair i:nth-child(1), .net-bars.fair i:nth-child(2) { background: #e8b23a; }
.net-bars.poor i:nth-child(1) { background: #e5484d; }
.net-bars.poor, .net-bars.stalled, .net-bars.offline { animation: net-flash .9s steps(1, end) infinite; }
.net-bars.stalled i:nth-child(1), .net-bars.offline i:nth-child(1) { background: #e5484d; }
@keyframes net-flash { 0%, 60% { opacity: 1; } 61%, 100% { opacity: .25; } }

.net-toast {
  position: fixed; top: 32px; right: 12px; z-index: 6;
  font-size: 12px; font-weight: 700; color: #ffdede;
  background: rgba(140, 20, 24, .88); padding: 4px 9px; border-radius: 3px;
  pointer-events: none; opacity: 0; transition: opacity .2s ease;
}
.net-toast.show { opacity: 1; }

.net-stall {
  position: fixed; inset: 0; z-index: 7;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px;
  background: rgba(6, 10, 7, .55);
  pointer-events: none;                    /* non-blocking: the match keeps running */
  opacity: 0; transition: opacity .18s ease;
}
.net-stall.show { opacity: 1; }
.net-stall-spin {
  width: 34px; height: 34px; border-radius: 50%;
  border: 3px solid rgba(240, 228, 185, .25); border-top-color: #f0e4b9;
  animation: net-spin .8s linear infinite;
}
@keyframes net-spin { to { transform: rotate(360deg); } }
.net-stall-txt { font-size: 15px; font-weight: 800; color: #f0e4b9; text-shadow: 0 2px 10px rgba(0,0,0,.6); }

/* Reduced-motion users get the colour change without the flashing/spinning. */
@media (prefers-reduced-motion: reduce) {
  .net-bars.poor, .net-bars.stalled, .net-bars.offline { animation: none; }
  .net-stall-spin { animation: none; }
}
```

- [ ] **Step 3: Render the layers**

In `public/client.js`, find the anchor `function drawHUD()` and add `renderNetQuality` immediately **before** it:

```js
// Paint the three escalating layers from the (already hysteresis-smoothed) level.
// 'good' shows nothing at all — the icon appearing IS the warning.
let netToastFor = null;   // level whose toast we already fired: one toast per episode, no nagging
let netToastT = null;
function renderNetQuality(level) {
  const bars = document.getElementById('net-bars');
  const toast = document.getElementById('net-toast');
  const stall = document.getElementById('net-stall');
  if (!bars || !toast || !stall) return;

  const bad = level !== 'good';
  bars.classList.toggle('hidden', !bad);
  bars.classList.toggle('show', bad);
  for (const c of ['fair', 'poor', 'stalled', 'offline']) bars.classList.toggle(c, level === c);

  const stalled = level === 'stalled' || level === 'offline';
  stall.classList.toggle('hidden', !stalled);
  stall.classList.toggle('show', stalled);

  // Fire the toast once when we ENTER poor (or worse), not on a repeating timer.
  const wantToast = level === 'poor' || stalled;
  if (wantToast && netToastFor !== 'on') {
    netToastFor = 'on';
    toast.classList.remove('hidden'); toast.classList.add('show');
    if (netToastT) clearTimeout(netToastT);
    netToastT = setTimeout(() => { toast.classList.remove('show'); toast.classList.add('hidden'); }, 3000);
  } else if (!wantToast && netToastFor === 'on' && level === 'good') {
    netToastFor = null;                                  // armed again for the next episode
  }
}
```

- [ ] **Step 4: Drive it from the HUD frame and demote the dev chip**

In `public/client.js`, find the net chip anchor `getElementById('net').textContent = `` `${ping}ms` ``, currently:

```js
  document.getElementById('net').textContent = `${ping}ms · ${snapRate}/s`;
```

with:

```js
  // Connection quality: warn the player when their own link degrades.
  renderNetQuality(updateNetQuality().level);
  // The raw numbers are a developer diagnostic, not player-facing — ?debug=net only.
  const netEl = document.getElementById('net');
  if (NET_DEBUG) {
    const q = netSample();
    netEl.classList.remove('hidden');
    netEl.textContent = `${ping}ms ±${Math.round(q.jitter)} · ${snapRate}/s · gap ${Math.round(q.snapGapMs)}ms · q${q.unacked} · ${netState.level}/${netState.raw.level}:${netState.reason}`;
  } else {
    netEl.classList.add('hidden');
  }
```

**Important:** `drawHUD()` returns early on `if (!latest) return;`. That is fine — `latest` holds the last snapshot during a stall, so the indicator keeps rendering while frozen. But it also means the warning only shows once a match is under way, which is the intent.

- [ ] **Step 5: Verify the visuals**

```bash
node --check public/client.js
PORT=3012 node server.js
```

Check each state in the browser, confirming against the spec's UI table:

| URL | Expect |
|---|---|
| `http://localhost:3012/` | nothing on the HUD (healthy) |
| `http://localhost:3012/?netsim=fair` | 2 amber bars, top-right, no toast |
| `http://localhost:3012/?netsim=poor` | 1 red flashing bar + `חיבור לא יציב` toast that fades after ~3s |
| `http://localhost:3012/?netsim=stalled` | dimmed field + spinner + `מתחבר מחדש…`, and **the game still responds to input** |
| `http://localhost:3012/?debug=net` | the numeric readout returns, bottom-left |

Then confirm the real detector fires: with the tab open in a match, throttle the connection in Chrome DevTools (Network → custom profile, ~300ms latency) and check the bars appear on their own within roughly a second, then clear a couple of seconds after throttling is removed.

- [ ] **Step 6: Run the full suite**

```bash
for f in test*.mjs; do echo "== $f"; node $f; done
```

Expected: `test-net-quality.mjs` passes. Every other file is unchanged by this plan — no `server.js` or `shared/` edits — so any failure elsewhere is pre-existing and must be reported separately, not "fixed" here.

- [ ] **Step 7: Commit**

```bash
git add public/index.html public/style.css public/client.js
git commit -m "feat(net): show amber/red bars, toast and stall overlay when the connection degrades"
```

---

### Task 5: Log the work and hand off

**Files:**
- Modify: `AGENT_REQUEST_LOG.md` (the existing `🚧 IN PROGRESS — in-game connection / lag warnings` entry under `## 2026-07-25`)

- [ ] **Step 1: Flip the log entry to done**

Change the entry's `🚧 IN PROGRESS` marker to `✅ DONE`, and add sub-bullets recording: the files actually touched, the real test output (`test-net-quality.mjs` assertion count), which `?netsim=` states were eyeballed, the DevTools-throttle result, and any threshold that needed retuning against a real connection.

- [ ] **Step 2: Check the tree before committing**

```bash
git status --short
```

Other agents have uncommitted work in `shared/` (`sim.js`, `constants.js`, `quick-messages.js`). **Commit only the files this plan touched.** Never `git add -A`.

- [ ] **Step 3: Commit**

```bash
git add AGENT_REQUEST_LOG.md
git commit -m "docs(log): connection-quality warnings shipped"
```

- [ ] **Step 4: Report, do not push**

Tell the user it is committed locally and list the commits. **Do not `git push`** unless they ask in that message.

---

## Deferred (explicitly not in this plan)

1. **Opponent/teammate lag indicator** (`היריב מתקשה בחיבור`) — needs `server.js` to track per-client ack gaps plus a `shared/wire.js` field. Held back to avoid colliding with other agents' in-flight server work.
2. **Genuine packet-loss statistics** — only possible if `summery/WEBRTC_TRANSPORT_PLAN.md` (UDP) lands.
3. **A player-facing net-stats toggle** in settings, if players ask for it.
4. **`document.hidden` suppression** — a backgrounded tab tanks `snapRate` and can look like a stall. The overlay is non-blocking and self-clearing so the cost is low; add suppression only if it proves annoying in practice.
