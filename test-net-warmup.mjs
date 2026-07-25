// Two FALSE «חיבור לא יציב» warnings on a flawless connection, pinned so they can't come back.
//
// The user hit this: the game reported an unstable connection while his internet was fine. Neither
// cause had anything to do with the network.
//
//  (1) client.js published snapRate from a FIXED-PHASE 1s sampler started at page load, so the
//      value was up to a second stale. At kickoff that stale value was the lobby's 0 — under the
//      poor threshold of 30 — and 600ms later the toast fired on a 3ms LAN.
//  (2) renderFrame() early-returns off the pitch, so whatever the last in-game frame painted (lit
//      bars, toast, reconnect spinner) froze on top of the hub with no frame coming to clear it.
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createNetMonitor, NET_T } from './public/net-quality.js';

const here = dirname(fileURLToPath(import.meta.url));
let failed = 0;
const ok = (label, cond, extra = '') => { if (!cond) failed++; console.log(`  ${cond ? '✅' : '❌'} ${label}${extra ? ` — ${extra}` : ''}`); };

// A flawless LAN frame: 3ms round trip, no jitter, a snapshot every 16.7ms, nothing unacked.
const PERFECT = { rtt: 3, jitter: 0, snapGapMs: 5, unacked: 0, wsOpen: true };
const FRAME_MS = 1000 / 60;

// Drive `frames` frames of a perfect connection at a given snapRate and return the worst level.
function run(snapRate, frames = 120) {
  const m = createNetMonitor();
  let worst = 'good', first = null;
  for (let f = 0; f < frames; f++) {
    const now = f * FRAME_MS;
    const st = m.update({ ...PERFECT, snapRate }, now);
    if (st.level !== 'good') { worst = st.level; if (!first) first = { ms: Math.round(now), reason: st.reason }; }
  }
  return { worst, first };
}

console.log('--- the classifier itself: a stale 0 IS judged as poor (that was the trap) ---');
{
  const r = run(0);
  ok('a reported rate of 0 escalates to poor on a perfect link',
    r.worst === 'poor' && r.first && r.first.reason === 'rate', JSON.stringify(r.first));
  ok('...within one escalate dwell', r.first && r.first.ms <= NET_T.escalateMs + FRAME_MS * 2, `${r.first && r.first.ms}ms`);
  // Hence: an UNKNOWN rate must be null, never 0.
  const n = run(null);
  ok('a rate of null is ignored and stays good', n.worst === 'good', n.worst);
  ok('a real 60/s stays good', run(60).worst === 'good');
}

console.log('\n--- FIX 1: client.js must publish a rolling window, and null while warming ---');
{
  const src = readFileSync(join(here, 'public/client.js'), 'utf8');
  // Check the DECLARATION, not the shape of the old expression: the comment above the fix quotes
  // the old sampler verbatim, so a naive grep for it matches the documentation and always "fails".
  ok('the fixed-phase sampler and its counter are gone', !/^\s*let snapCount/m.test(src));
  ok('snapRate starts as null, not 0', /let snapRate = null/.test(src));
  ok('there is a rolling window function', /function noteSnapshotRate\(/.test(src));
  ok('it is fed on every snapshot', /noteSnapshotRate\(/.test(src.slice(src.indexOf('latest = snap;'))));
  ok('the window resets with the socket', /resetSnapshotRate\(\)/.test(src));

  // Run the REAL functions out of client.js rather than a replica — a replica would only test
  // itself. (client.js can't be imported: it opens a WebSocket and touches canvas on load.)
  const from = src.indexOf('const SNAP_WIN_MS');
  const to = src.indexOf('function resetSnapshotRate');
  const end = src.indexOf('\n', to);
  const block = src.slice(from, end);
  const api = new Function(`${block}; return { noteSnapshotRate, resetSnapshotRate, get rate() { return snapRate; }, SNAP_WIN_MS };`)();

  api.resetSnapshotRate();
  ok('reports null before any snapshot', api.rate === null);
  // A fresh 60Hz stream: the first second must read as UNKNOWN, not as a dying 1/s, 2/s, 3/s…
  let t = 0, sawLowNumber = false;
  for (; t < 1000; t += FRAME_MS) { api.noteSnapshotRate(t); if (typeof api.rate === 'number' && api.rate < NET_T.poor.snapRate) sawLowNumber = true; }
  ok('never publishes a below-threshold number during the first second', !sawLowNumber, `rate=${api.rate}`);
  for (; t < 2000; t += FRAME_MS) api.noteSnapshotRate(t);
  ok('once warm it reports the real rate', api.rate >= 55 && api.rate <= 61, String(api.rate));

  // THE match-to-match case: the socket outlives a match, so a second kickoff must re-warm.
  const gap = t + 30000;                       // half a minute in the hub between matches
  api.noteSnapshotRate(gap);
  ok('a long break re-warms instead of reading 1/s', api.rate === null, String(api.rate));
  for (let u = gap; u < gap + 1000; u += FRAME_MS) api.noteSnapshotRate(u);
  ok('...and stays unknown for that whole first second', api.rate === null || api.rate >= NET_T.poor.snapRate, String(api.rate));
  for (let u = gap + 1000; u < gap + 2000; u += FRAME_MS) api.noteSnapshotRate(u);
  ok('...then reports honestly again', api.rate >= 55 && api.rate <= 61, String(api.rate));

  // A GENUINE rate collapse must still be caught — the fix must not blind the signal.
  api.resetSnapshotRate();
  let v = 0;
  for (; v < 2000; v += FRAME_MS) api.noteSnapshotRate(v);          // healthy, warm
  ok('reads ~60/s while healthy', api.rate >= 55 && api.rate <= 61, String(api.rate));
  // Drop to 10/s. The rolling window BLENDS across the transition (at v=3000 it still holds the
  // tail of the 60Hz burst and reads ~15), so measure once the window sits wholly inside the slump.
  for (; v < 4100; v += 100) api.noteSnapshotRate(v);
  ok('a real sustained drop to 10/s is still reported', api.rate >= 9 && api.rate <= 12, String(api.rate));
  ok('...and the classifier calls that poor', run(api.rate).worst === 'poor');
}

console.log('\n--- FIX 2: the warning must not survive leaving the pitch ---');
{
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://localhost:3012/' });
  global.window = dom.window; global.document = dom.window.document; global.location = dom.window.location;
  const hud = await import('./public/net-hud.js');

  // Paint a genuinely bad state, as the last frame of a match would.
  let t = 0;
  for (let i = 0; i < 8; i++) hud.onPong(400);
  for (let k = 0; k < 5; k++) { t += 200; hud.onSnapshot(t); hud.renderNetHud({ snapRate: 60, unacked: 2, wsOpen: true, now: t }); }
  const bars = document.querySelector('.nq-bars');
  const toast = document.querySelector('.nq-toast');
  const stall = document.querySelector('.nq-stall');
  ok('a bad connection lights the bars in-match', bars.classList.contains('nq-on'));
  ok('...and shows the toast', toast.classList.contains('nq-on'));

  hud.hideNetHud();
  ok('hideNetHud clears the bars', !bars.classList.contains('nq-on'));
  ok('hideNetHud clears the toast', !toast.classList.contains('nq-on'));
  ok('hideNetHud clears the reconnect spinner', !stall.classList.contains('nq-on'));

  // Same for a stall, which is the one that paints a full-screen overlay.
  t += 5000; hud.onSnapshot(t);
  hud.renderNetHud({ snapRate: 60, unacked: 0, wsOpen: true, now: t + NET_T.stallGapMs + 100 });
  ok('a stall shows the full-screen spinner', stall.classList.contains('nq-on'));
  hud.hideNetHud();
  ok('...and leaving the pitch clears it', !stall.classList.contains('nq-on'));

  ok('resetNetHud also clears the screen', (() => {
    hud.renderNetHud({ snapRate: 60, unacked: 0, wsOpen: false, now: t + 20000 });   // offline -> overlay
    const wasOn = stall.classList.contains('nq-on');
    hud.resetNetHud();
    return wasOn && !stall.classList.contains('nq-on');
  })());

  const src = readFileSync(join(here, 'public/client.js'), 'utf8');
  ok('client.js hides it on every screen change away from the pitch',
    /if \(name !== 'game'\) hideNetHud\(\);/.test(src));
  ok('...and imports it', /hideNetHud/.test(src.slice(0, src.indexOf('net-hud.js') + 40)));
}

console.log(failed ? `\n${failed} FAILED` : '\nall net-warmup checks passed');
process.exit(failed ? 1 : 0);
