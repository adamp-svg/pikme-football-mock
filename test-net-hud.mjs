// DOM-level test for the connection-warning HUD, driven through jsdom so the real
// element/class behaviour is verified without a browser. The decision logic itself is
// covered by test-net-quality.mjs; this file checks that each level paints what the
// design doc says it should.
import { JSDOM } from 'jsdom';
import { NET_T } from './public/net-quality.js';

let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + '  ' + m); if (!c) fails++; };

// jsdom globals must exist BEFORE net-hud.js is imported: it reads location.search at
// module scope to pick up ?debug=net / ?netsim=.
const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://localhost:3012/' });
global.window = dom.window;
global.document = dom.window.document;
global.location = dom.window.location;
// NB: do NOT reassign global setTimeout/clearTimeout to jsdom's — jsdom's implementation
// calls the global one internally, so that recurses until the stack blows.

const hud = await import('./public/net-hud.js');

const bars = () => document.querySelector('.nq-bars');
const toast = () => document.querySelector('.nq-toast');
const stall = () => document.querySelector('.nq-stall');
const on = (el) => !!el && el.classList.contains('nq-on');

// Healthy frame. A snapshot must have been seen, otherwise snapRate is ignored by design.
const healthy = (now) => { hud.onSnapshot(now); return hud.renderNetHud({ snapRate: 60, unacked: 1, wsOpen: true, now }); };

console.log('--- mounts lazily on first render ---');
ok(bars() === null, 'nothing in the DOM before the first render');
hud.onPong(40);
const lvl0 = healthy(0);
ok(bars() !== null && toast() !== null && stall() !== null, 'first render mounts bars, toast and stall overlay');
ok(document.querySelector('style') !== null, 'injects its own <style> (no style.css edit needed)');
ok(lvl0 === 'good', 'a healthy frame is good');

console.log('\n--- good shows nothing at all ---');
ok(!on(bars()), 'bars hidden while healthy');
ok(!on(stall()), 'stall overlay hidden while healthy');
ok(!on(toast()), 'no toast while healthy');

console.log('\n--- stall paints immediately, and is NON-blocking ---');
{
  // A snapshot at t=0 then a frame at t=0+gap: no snapshot for longer than the limit.
  hud.onSnapshot(0);
  const lvl = hud.renderNetHud({ snapRate: 60, unacked: 1, wsOpen: true, now: NET_T.stallGapMs + 50 });
  ok(lvl === 'stalled', 'a snapshot gap over the limit reports stalled on the first frame');
  ok(on(stall()), 'stall overlay shown');
  ok(on(bars()) && bars().classList.contains('stalled'), 'bars shown in the stalled state');
  ok(on(toast()), 'the toast fires on a stall');
  const st = dom.window.getComputedStyle(stall());
  ok(st.pointerEvents === 'none', 'stall overlay is pointer-events:none so it cannot steal input');
}

console.log('\n--- recovering clears every layer (after the recover dwell) ---');
{
  const t0 = 10000;
  let lvl = 'stalled';
  for (let t = t0; t <= t0 + NET_T.recoverMs + 200; t += 100) lvl = healthy(t);
  ok(lvl === 'good', `back to good after sustained health (got ${lvl})`);
  ok(!on(bars()) && !on(stall()), 'bars and overlay both cleared');
}

console.log('\n--- fair paints amber, no toast (a warning, not a nag) ---');
{
  const t0 = 30000;
  let lvl = 'good';
  // rtt just over the fair threshold, sustained past the escalate dwell.
  for (let t = t0; t <= t0 + NET_T.escalateMs + 200; t += 100) {
    hud.onPong(NET_T.fair.rtt + 5);
    hud.onSnapshot(t);
    lvl = hud.renderNetHud({ snapRate: 60, unacked: 1, wsOpen: true, now: t });
  }
  ok(lvl === 'fair', `sustained mild latency reports fair (got ${lvl})`);
  ok(on(bars()) && bars().classList.contains('fair'), 'bars shown with the fair (amber) class');
  ok(!bars().classList.contains('poor'), 'not marked poor');
  ok(!on(stall()), 'no stall overlay at fair');
  ok(!on(toast()), 'fair does NOT toast');
}

console.log('\n--- offline when the socket is shut ---');
{
  hud.resetNetHud();
  hud.onSnapshot(50000);
  const lvl = hud.renderNetHud({ snapRate: 60, unacked: 0, wsOpen: false, now: 50000 });
  ok(lvl === 'offline', 'a closed socket reports offline immediately');
  ok(on(stall()), 'offline shows the reconnect overlay');
}

console.log('\n--- Hebrew copy matches the spec exactly ---');
ok(toast().textContent === 'חיבור לא יציב', `toast copy is the spec string (got "${toast().textContent}")`);
ok(stall().textContent.includes('מתחבר מחדש…'), 'stall overlay says מתחבר מחדש…');

console.log('\n--- reset() clears sampling state ---');
{
  hud.resetNetHud();
  const lvl = hud.renderNetHud({ snapRate: 60, unacked: 0, wsOpen: true, now: 60000 });
  ok(lvl === 'good', 'after reset, with no snapshot yet, we report good rather than a false stall');
}

console.log('\n' + (fails === 0 ? '✅ ALL PASS' : '❌ ' + fails + ' FAILED'));
process.exit(fails ? 1 : 0);
