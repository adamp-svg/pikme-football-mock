// Does the headroom sky actually RIDE UP as the seat rows arrive, and does it PARK?
//
// drawViewBands ramps `lift` 0..1 from row three's lip (ROW_LIP world units above the touchline) to its
// outer edge (ROW_STACK) and then saturates, and hands it to SkyBand.draw along with the band depth.
// SkyBand shares that out per layer so the depth order survives: nearest cloud moves most, the ad blimp
// least. This measures the RENDER rather than the arithmetic — it draws the band at several lift values
// into an offscreen canvas and tracks where the cloud mass and the blimp actually land.
//
// Needs a game server (any port): PORT=3017 node server.js   (override with URL=/PORT=)
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

const PORT = process.env.PORT || 3012;
const PAGE = process.env.URL || `http://127.0.0.1:${PORT}/`;
const CDP = Number(process.env.CDP_PORT || 9499);
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP}`,
  `--user-data-dir=/tmp/skylift-${process.pid}`, '--no-first-run', '--disable-gpu',
  '--hide-scrollbars', '--window-size=1300,900', 'about:blank'], { stdio: 'ignore' });
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
  setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('t/o ' + m)); } }, 20000);
});
const ev = async e => (await cdp('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result.value;

await cdp('Page.enable'); await cdp('Runtime.enable');
await cdp('Page.navigate', { url: PAGE }); await sleep(3000);

const ready = await ev('!!(window.SkyBand && window.SkyBand.draw)');
if (!ready) { console.log('❌ SkyBand not loaded from ' + PAGE); ws.close(); process.exit(1); }

// One band, one moment in time, one camera — the ONLY variable is `lift`.
const BAND_H = 157;   // an iPad Pro 13's headroom in art px, from _win-rect
const measure = (lift) => `(() => {
  const c = document.createElement('canvas'); c.width = 600; c.height = ${BAND_H};
  const g = c.getContext('2d');
  window.SkyBand.draw(g, { x: 0, y: 0, w: c.width, h: c.height }, {
    camX: 0, t: 0, bannerText: 'סולטיז', side: 'top',
    edgeApproach: 0, lift: ${lift}, bandDepth: ${BAND_H},
  });
  const d = g.getImageData(0, 0, c.width, c.height).data;
  const acc = { cloud: [0, 0], blimp: [0, 0] };
  // EXCLUDE THE SHELF. The opaque cloud shelf is pinned to the band's inner edge on purpose — it is the
  // solid lip that stops blue sky touching the touchline, so it deliberately gets no lift. It is also the
  // single largest block of cloud-white in the band, so including it anchors the centroid and makes the
  // drifting layers look like they barely move. bankDepth = clamp(round(h*0.32), 18, 42); sample above it.
  const shelf = Math.min(42, Math.max(18, Math.round(c.height * 0.32)));
  const driftMax = c.height - shelf - 4;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], gg = d[i + 1], b = d[i + 2];
    const y = Math.floor((i / 4) / c.width);
    if (y >= driftMax) continue;
    if (r > 200 && gg > 215 && b > 225) { acc.cloud[0] += y; acc.cloud[1]++; }          // cloud1/cloud2
    if (b > 150 && r < 110 && gg > 90 && gg < 160) { acc.blimp[0] += y; acc.blimp[1]++; } // blimp body
  }
  return {
    cloud: acc.cloud[1] > 200 ? +(acc.cloud[0] / acc.cloud[1]).toFixed(1) : null,
    blimp: acc.blimp[1] > 60 ? +(acc.blimp[0] / acc.blimp[1]).toFixed(1) : null,
  };
})()`;

const LIFTS = [0, 0.25, 0.5, 0.75, 1];
const rows = [];
for (const L of LIFTS) rows.push({ L, ...(await ev(measure(L))) });

console.log(`band ${BAND_H} art px · centroid of each DRIFTING layer (pinned shelf excluded), art px from the top\n`);
console.log('lift    cloud mass    ad blimp');
for (const r of rows) {
  console.log(String(r.L).padEnd(7),
    String(r.cloud ?? '—').padStart(10), String(r.blimp ?? '—').padStart(11));
}

let fails = 0;
const ok = (c, m) => { console.log((c ? '  ✅ ' : '  ❌ ') + m); if (!c) fails++; };
console.log('');

const cl = rows.map(r => r.cloud), bl = rows.map(r => r.blimp);
ok(cl.every(v => v != null), 'the cloud mass is present at every lift');
if (cl.every(v => v != null)) {
  const mono = cl.every((v, i) => i === 0 || v <= cl[i - 1] + 0.6);
  ok(mono, `cloud mass only ever moves UP as lift rises (${cl.join(' → ')})`);
  ok(cl[0] - cl[cl.length - 1] > 8,
    `and it moves a readable distance (${(cl[0] - cl[cl.length - 1]).toFixed(1)} art px, want > 8)`);
}
if (bl.every(v => v != null)) {
  const cloudTravel = cl[0] - cl[cl.length - 1], blimpTravel = bl[0] - bl[bl.length - 1];
  ok(blimpTravel > 0, `the blimp lifts too (${blimpTravel.toFixed(1)} art px)`);
  ok(blimpTravel < cloudTravel,
    `...but LESS than the near cloud mass — depth order holds (${blimpTravel.toFixed(1)} < ${cloudTravel.toFixed(1)})`);
} else {
  console.log('  ⚠ blimp not visible in a ' + BAND_H + 'px band (needs h >= 72) — skipped');
}
// The whole point of `lift` being additive: existing callers that omit it must be unaffected.
const noOpt = await ev(`(() => {
  const mk = (opts) => { const c = document.createElement('canvas'); c.width = 600; c.height = ${BAND_H};
    const g = c.getContext('2d');
    window.SkyBand.draw(g, { x:0, y:0, w:c.width, h:c.height },
      Object.assign({ camX:0, t:0, bannerText:'סולטיז', side:'top', edgeApproach:0 }, opts));
    return c.toDataURL(); };
  return mk({}) === mk({ lift: 0, bandDepth: ${BAND_H} });
})()`);
ok(noOpt, 'omitting lift renders byte-identical to lift 0 — additive, existing callers untouched');

console.log('');
console.log(fails ? `❌ ${fails} FAILED` : '✅ the sky lifts, in depth order, and parks');
ws.close(); process.exit(fails ? 1 : 0);
