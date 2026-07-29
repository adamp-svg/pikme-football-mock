// Is the CACHED STATIC FIELD in the same place as the entities drawn on top of it?
//
// The grass, lines, goals and stands are baked once into bgCanvas and blitted each frame; the players,
// ball, walls and bushes are drawn live through wx/wy. Those are two different code paths to the same
// coordinate system, and they only agree if the blit uses the same offsets. Twice they did not: the blit
// destination was written out by hand as `-(camY + BAND*scale)`, which omits viewOffY. On a phone
// viewOffY is 0 so nothing showed; on an iPad it slid the entire pitch `viewOffY` art px away from
// everything standing on it — reported as "all the field elements are in the wrong place".
//
// bgCanvas pixel (0,0) IS world (-BACK, -BAND). So its destination must be exactly that corner mapped by
// wx/wy. This OBSERVES THE ACTUAL drawImage CALL — hooked on the 2D prototype — and compares it against
// the corner recomputed from __view().winWorld, which is derived independently from camX/camY.
//
// It deliberately does NOT read a `bgOrigin` reported by __view(). The first version of this test did, and
// it passed with the bug deliberately reinstated: the readout computed wy(-BAND) with the same helper the
// fix uses, so the assertion reduced to wy(-BAND) == wy(-BAND) no matter what the blit did. Same shape as
// the hwPerArt guard that could not fail. Watch the call, not a restatement of the intent.
//
// A viewport with viewOffY == 0 cannot catch this, so the tablets here are the point, not padding.
//
// Needs a game server (any port): PORT=3017 node server.js   (override with URL=/PORT=)
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

const PORT = process.env.PORT || 3012;
const PAGE = process.env.URL || `http://127.0.0.1:${PORT}/`;
const CDP = Number(process.env.CDP_PORT || 9496);
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// world geometry, mirrored from client.js
const AUD = { seatW: 72, seatH: 92, gapX: 6, gapY: 8 };
const ROWS = 3, LANE = 56;
const ROW_X = AUD.seatW + AUD.gapX, ROW_Y = AUD.seatH + AUD.gapY;
const BACK = ROWS * ROW_X + LANE;     // 290
const BAND = ROWS * ROW_Y + LANE;     // 356

const DEVS = [
  { name: 'iPhone 17 Pro', w: 874, h: 402, dpr: 3 },   // viewOffY 0 — the control
  { name: 'iPad Pro 11"', w: 1210, h: 834, dpr: 2 },
  { name: 'iPad Pro 13"', w: 1366, h: 1024, dpr: 2 },
  { name: 'Galaxy Tab S9', w: 1280, h: 800, dpr: 2 },
];

const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP}`,
  `--user-data-dir=/tmp/falign-${process.pid}`, '--no-first-run', '--disable-gpu',
  '--hide-scrollbars', '--window-size=1400,1100', 'about:blank'], { stdio: 'ignore' });
process.on('exit', () => { try { chrome.kill(); } catch {} });

let url;
for (let i = 0; i < 60 && !url; i++) {
  try {
    const r = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
    const p = r.filter(t => t.type === 'page');
    if (p.length) url = p[0].webSocketDebuggerUrl;
  } catch {}
  if (!url) await sleep(250);
}
const ws = new WebSocket(url); await new Promise(r => ws.once('open', r));
let id = 0; const pend = new Map();
ws.on('message', raw => {
  const m = JSON.parse(raw.toString());
  if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
});
const cdp = (m, p = {}) => new Promise((res, rej) => {
  const i = ++id; pend.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method: m, params: p }));
  setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('t/o ' + m)); } }, 25000);
});
const ev = async e => (await cdp('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result.value;

await cdp('Page.enable'); await cdp('Runtime.enable');

let fails = 0;
const ok = (c, m) => { console.log((c ? '  ✅ ' : '  ❌ ') + m); if (!c) fails++; };
const rows = [];

for (const d of DEVS) {
  await cdp('Emulation.setDeviceMetricsOverride', { width: d.w, height: d.h, deviceScaleFactor: d.dpr, mobile: true });
  await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await cdp('Page.navigate', { url: PAGE }); await sleep(700);
  await ev(`(()=>{try{localStorage.setItem('fbHubTourSkipped','1');localStorage.setItem('fbHubTourDone','1');localStorage.removeItem('fbTutorialDoneSet');localStorage.removeItem('fbTutorialDone');localStorage.removeItem('fbTutorialSkipped');}catch{}return 1})()`);
  await cdp('Page.navigate', { url: PAGE }); await sleep(9500);
  // Hook AFTER load so the bake itself is not recorded.
  //
  // TWO TRAPS, both hit on the way to this version:
  //  1. The audience layers are blitted with the SAME (dx,dy) shape and the SAME canvas width as the
  //     cached field, so width alone cannot tell them apart. The field goes first in a frame, so record
  //     only the FIRST qualifying blit per animation frame.
  //  2. Screen shake perturbs camX/camY mid-frame (`camX += random*amp`), so a __view() read taken
  //     afterwards describes a different camera than the blit did — that alone produced ~6 art px of
  //     noise and made the test look like it was failing when it was not. So __view() is sampled INSIDE
  //     the hook, at the instant of the blit, and each dest is paired with its own camera.
  await ev(`(() => {
    window.__bgPairs = [];
    const proto = CanvasRenderingContext2D.prototype;
    if (!proto.__alignHooked) {
      let fid = 0, lastFid = -1;
      const rAF = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (cb) => rAF((t) => { fid++; return cb(t); });
      const orig = proto.drawImage;
      proto.drawImage = function (src, ...rest) {
        if (rest.length === 2 && src && src.tagName === 'CANVAS' && src.width > 900 && fid !== lastFid) {
          lastFid = fid;
          try {
            const v = window.__view && window.__view();
            if (v) window.__bgPairs.push({ dx: +rest[0].toFixed(2), dy: +rest[1].toFixed(2), v });
          } catch {}
          if (window.__bgPairs.length > 30) window.__bgPairs.shift();
        }
        return orig.call(this, src, ...rest);
      };
      proto.__alignHooked = true;
    }
    return 1;
  })()`);
  await sleep(900);
  const pairs = await ev('window.__bgPairs || []');
  if (!pairs.length) { console.log(`${d.name.padEnd(16)} never saw the cached-field blit — hook missed it`); fails++; continue; }
  const P = pairs[pairs.length - 1];
  const v = P.v, obsX = P.dx, obsY = P.dy;

  // winWorld is the world point at the play window's top-left, derived from camX/camY independently of
  // the blit. bgCanvas(0,0) is world (-BACK,-BAND), which is that many world units up and left of it.
  const expX = v.bandX + (-BACK - v.winWorld.x) * v.scale;
  const expY = v.bandY + (-BAND - v.winWorld.y) * v.scale;
  const dx = +(obsX - expX).toFixed(2), dy = +(obsY - expY).toFixed(2);
  rows.push({ d, v, expX, expY, dx, dy });
  console.log(`${d.name.padEnd(16)} viewOffY ${String(v.bandY).padStart(3)} · blit y ${String(obsY).padStart(9)} · expected ${expY.toFixed(2).padStart(9)} · off by ${dy}`);
}
console.log('');

for (const r of rows) {
  ok(Math.abs(r.dy) <= 1.01,
    `${r.d.name}: the OBSERVED blit is where wy() puts it (off by ${r.dy} art px)`);
  ok(Math.abs(r.dx) <= 1.01,
    `${r.d.name}: ...and horizontally too (off by ${r.dx} art px)`);
}
// The control matters: if no device in the run has headroom, a regression here would pass unnoticed.
const withBand = rows.filter(r => r.v.bandY > 0);
ok(withBand.length >= 2,
  `at least two devices in this run actually HAVE headroom, so the test can see the bug (${withBand.length})`);

console.log('');
console.log(fails ? `❌ ${fails} FAILED` : '✅ static field and live entities share one coordinate system');
ws.close(); process.exit(fails ? 1 : 0);
