// Connection-quality classifier: threshold boundaries, worst-first precedence, and the
// hysteresis that stops the on-screen warning from strobing on a marginal connection.
import { NET_T, NET_RANK, rttJitter, classify, createNetMonitor } from './public/net-quality.js';

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

console.log('\n' + (fails === 0 ? '✅ ALL PASS' : '❌ ' + fails + ' FAILED'));
process.exit(fails ? 1 : 0);
