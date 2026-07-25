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
//
// Design doc: docs/superpowers/specs/2026-07-25-connection-quality-warnings-design.md

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
  let candRank = -1, candSince = 0, candDir = 0; // pending change: dir +1 up / -1 down, 0 none

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
