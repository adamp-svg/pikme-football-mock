// The on-screen half of the connection warning. Self-contained ON PURPOSE: it injects its
// own elements and its own <style>, so wiring it up costs public/client.js only a handful
// of one-line hooks and costs index.html / style.css nothing at all. Several agents edit
// those files concurrently (see CLAUDE.md), so a small footprint is a feature here.
//
// All the decision logic lives in net-quality.js, which is pure and unit-tested
// (test-net-quality.mjs). This file is deliberately dumb: sample in, pixels out.
//
// Design doc: docs/superpowers/specs/2026-07-25-connection-quality-warnings-design.md

// Relative, not '/net-quality.js': resolves the same in the browser (both files live in
// public/) and ALSO resolves under node, which is what lets test-net-hud.mjs drive this
// file through jsdom.
import { createNetMonitor, rttJitter } from './net-quality.js';

const qs = new URLSearchParams(location.search);
export const NET_DEBUG = qs.get('debug') === 'net';   // show the raw numbers
const NET_SIM = qs.get('netsim') || null;             // force a level for visual QA

const monitor = createNetMonitor();
let rttSamples = [];   // last 8 round trips -> jitter
let lastRtt = 0;
let lastSnapAt = null; // performance.now() of the newest snapshot; null = none seen yet.
                       // Must be null, NOT 0: 0 is falsy, so a gap measured from t=0 would
                       // silently read as 'no snapshot yet' and miss a real stall.
let els = null;
let toastArmed = true; // one toast per bad episode, not a repeating nag
let toastT = null;

const CSS = `
.nq-bars { position: fixed; top: 10px; right: 12px; z-index: 6; display: none;
  align-items: flex-end; gap: 3px; height: 16px; pointer-events: none;
  opacity: 0; transition: opacity .25s ease; }
.nq-bars.nq-on { display: flex; opacity: 1; }
.nq-bars i { width: 4px; background: rgba(240,228,185,.25); border-radius: 1px; }
.nq-bars i:nth-child(1) { height: 6px; }
.nq-bars i:nth-child(2) { height: 11px; }
.nq-bars i:nth-child(3) { height: 16px; }
.nq-bars.fair i:nth-child(1), .nq-bars.fair i:nth-child(2) { background: #e8b23a; }
.nq-bars.poor i:nth-child(1),
.nq-bars.stalled i:nth-child(1),
.nq-bars.offline i:nth-child(1) { background: #e5484d; }
.nq-bars.poor, .nq-bars.stalled, .nq-bars.offline { animation: nq-flash .9s steps(1,end) infinite; }
@keyframes nq-flash { 0%,60% { opacity: 1; } 61%,100% { opacity: .3; } }

.nq-toast { position: fixed; top: 32px; right: 12px; z-index: 6; direction: rtl;
  font-size: 12px; font-weight: 700; color: #ffdede; background: rgba(140,20,24,.9);
  padding: 4px 9px; border-radius: 3px; pointer-events: none;
  opacity: 0; transition: opacity .2s ease; }
.nq-toast.nq-on { opacity: 1; }

.nq-stall { position: fixed; inset: 0; z-index: 7; display: none;
  flex-direction: column; align-items: center; justify-content: center; gap: 14px;
  background: rgba(6,10,7,.55); pointer-events: none; /* non-blocking: match keeps running */
  opacity: 0; transition: opacity .18s ease; }
.nq-stall.nq-on { display: flex; opacity: 1; }
.nq-spin { width: 34px; height: 34px; border-radius: 50%;
  border: 3px solid rgba(240,228,185,.25); border-top-color: #f0e4b9;
  animation: nq-spin .8s linear infinite; }
@keyframes nq-spin { to { transform: rotate(360deg); } }
.nq-txt { direction: rtl; font-size: 15px; font-weight: 800; color: #f0e4b9;
  text-shadow: 0 2px 10px rgba(0,0,0,.6); }

.nq-dbg { position: fixed; bottom: 8px; left: 12px; z-index: 6; font-size: 11px;
  color: #6b7ea3; background: rgba(11,16,12,.78); padding: 4px 8px; pointer-events: none; }

@media (prefers-reduced-motion: reduce) {
  .nq-bars.poor, .nq-bars.stalled, .nq-bars.offline { animation: none; }
  .nq-spin { animation: none; }
}
`;

function mount() {
  if (els) return els;
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const mk = (cls, html) => { const d = document.createElement('div'); d.className = cls; if (html) d.innerHTML = html; document.body.appendChild(d); return d; };
  els = {
    bars: mk('nq-bars', '<i></i><i></i><i></i>'),
    toast: mk('nq-toast'),
    stall: mk('nq-stall', '<div class="nq-spin"></div><div class="nq-txt">מתחבר מחדש…</div>'),
    dbg: NET_DEBUG ? mk('nq-dbg') : null,
  };
  els.bars.setAttribute('aria-hidden', 'true');
  els.toast.textContent = 'חיבור לא יציב';
  return els;
}

// ---- hooks called from client.js -------------------------------------------------
export function onPong(rtt) {
  lastRtt = rtt;
  rttSamples.push(rtt);
  if (rttSamples.length > 8) rttSamples.shift();
}

// `now` is injectable so the jsdom test can drive time; the game always uses the default.
export function onSnapshot(now = performance.now()) { lastSnapAt = now; }

// A fresh socket must not inherit the dead one's samples.
export function resetNetHud() { monitor.reset(); rttSamples = []; lastSnapAt = null; lastRtt = 0; toastArmed = true; }

// Call once per HUD frame. `snapRate` is snapshots/sec, `unacked` the pending-input
// backlog (a growing backlog means our INPUT is not landing, which RTT alone can miss).
export function renderNetHud({ snapRate, unacked, wsOpen, now = performance.now() }) {
  const e = mount();
  const sample = {
    rtt: lastRtt,
    jitter: rttJitter(rttSamples),
    snapGapMs: lastSnapAt == null ? 0 : now - lastSnapAt,
    snapRate: lastSnapAt == null ? null : snapRate, // null until the first snapshot: no lobby false alarm
    unacked: unacked || 0,
    wsOpen: !!wsOpen,
  };
  const st = NET_SIM
    ? { level: NET_SIM, reason: 'sim', raw: { level: NET_SIM, reason: 'sim' } }
    : monitor.update(sample, now);

  const level = st.level;
  const bad = level !== 'good';
  const stalled = level === 'stalled' || level === 'offline';

  e.bars.classList.toggle('nq-on', bad);
  for (const c of ['fair', 'poor', 'stalled', 'offline']) e.bars.classList.toggle(c, level === c);
  e.stall.classList.toggle('nq-on', stalled);

  // Fire the toast once on entering poor-or-worse; re-arm only after a full recovery.
  const wantToast = level === 'poor' || stalled;
  if (wantToast && toastArmed) {
    toastArmed = false;
    e.toast.classList.add('nq-on');
    if (toastT) clearTimeout(toastT);
    toastT = setTimeout(() => e.toast.classList.remove('nq-on'), 3000);
  } else if (!wantToast) {
    // Improved before the 3s timer ran out — drop the warning now rather than leaving a
    // stale "unstable" message on screen over a connection that has already recovered.
    e.toast.classList.remove('nq-on');
    if (toastT) { clearTimeout(toastT); toastT = null; }
    if (level === 'good') toastArmed = true;   // re-arm only after a FULL recovery
  }

  if (e.dbg) {
    e.dbg.textContent = `${Math.round(sample.rtt)}ms ±${Math.round(sample.jitter)} · ${snapRate}/s`
      + ` · gap ${Math.round(sample.snapGapMs)}ms · q${sample.unacked} · ${level}/${st.raw.level}:${st.reason}`;
  }
  return level;
}
