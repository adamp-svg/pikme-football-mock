// PIXEL PROOF, take 2. Take 1 used a near-white pitch-line detector; it worked on the phone shots and
// found nothing on the iPad (the terrace/grass boundary there sits behind a dark tutorial panel and the
// penalty line is a low-alpha wash), so its cross-correlation was degenerate and its "-40 px" was noise,
// not a measurement. Reported as a failed probe, not a finding.
//
// Two probes instead:
//  A. GRASS EDGE. World x = 0 (the pitch edge / goal line) is the highest-contrast static vertical feature
//     on screen: dark terrace to its left, green grass to its right. Find it as the steepest positive
//     gradient of per-column "greenness" and compare the measured CSS x against the prediction derived
//     from __view() (win.x, playW, bandX). Same world region => same measured edge within a pixel or two.
//  B. FULL-FRAME 2-D SHIFT. Downscale both shots to CSS px and search shifts -24..+24 on both axes for the
//     minimum SSD of the greenness field. If dpr changed the world region, the best fit would be non-zero
//     (or flat). Reported with the error curve so a flat/degenerate fit is visible instead of silent.
import { readFileSync } from 'node:fs';
import { decodePng } from './_png.mjs';

const DIR = '/private/tmp/claude-501/-Users-adamleeperelman-Documents-pikeme/984e7843-a957-4d6b-97c1-5edee68d8436/scratchpad/dpr/';
const rows = JSON.parse(readFileSync(DIR + 'rows.json', 'utf8'));
const ART = 3.25;

// greenness field, downsampled to CSS px by box-averaging dpr x dpr device px
function greenField(img, dpr) {
  const w = Math.floor(img.w / dpr), h = Math.floor(img.h / dpr);
  const f = new Float32Array(w * h);
  for (let cy = 0; cy < h; cy++) {
    const ys = Math.round(cy * dpr), ye = Math.max(ys + 1, Math.round((cy + 1) * dpr));
    for (let cx = 0; cx < w; cx++) {
      const xs = Math.round(cx * dpr), xe = Math.max(xs + 1, Math.round((cx + 1) * dpr));
      let s = 0, n = 0;
      for (let y = ys; y < ye && y < img.h; y++) for (let x = xs; x < xe && x < img.w; x++) {
        const i = (y * img.w + x) * img.ch;
        s += img.data[i + 1] - Math.max(img.data[i], img.data[i + 2]); n++;
      }
      f[cy * w + cx] = n ? s / n : 0;
    }
  }
  return { w, h, f };
}

function colGreen(g, yLo, yHi) {
  const p = new Float64Array(g.w);
  const y0 = Math.max(0, Math.round(yLo)), y1 = Math.min(g.h, Math.round(yHi));
  for (let x = 0; x < g.w; x++) { let s = 0; for (let y = y0; y < y1; y++) s += g.f[y * g.w + x]; p[x] = s / Math.max(1, y1 - y0); }
  return p;
}

// steepest positive gradient over a K-px window, searched only in the left half (the pitch edge is there)
function grassEdge(prof, K = 4, limit = null) {
  const hi = limit ?? Math.floor(prof.length * 0.5);
  let best = { x: -1, d: -1e9 };
  for (let x = K; x < hi - K; x++) {
    let a = 0, b = 0;
    for (let k = 1; k <= K; k++) { a += prof[x - k]; b += prof[x + k - 1]; }
    const d = (b - a) / K;
    if (d > best.d) best = { x, d };
  }
  return best;
}

function ssdShift(A, B, maxS, y0, y1, x0, x1) {
  const out = [];
  let best = null;
  for (let sy = -maxS; sy <= maxS; sy++) for (let sx = -maxS; sx <= maxS; sx++) {
    let s = 0, n = 0;
    for (let y = y0; y < y1; y += 2) {
      const yy = y + sy; if (yy < 0 || yy >= B.h) continue;
      for (let x = x0; x < x1; x += 2) {
        const xx = x + sx; if (xx < 0 || xx >= B.w) continue;
        const d = A.f[y * A.w + x] - B.f[yy * B.w + xx]; s += d * d; n++;
      }
    }
    if (n < 1000) continue;
    const err = s / n; out.push({ sx, sy, err });
    if (!best || err < best.err) best = { sx, sy, err };
  }
  const zero = out.find(o => o.sx === 0 && o.sy === 0);
  return { best, zero, spread: Math.max(...out.map(o => o.err)) / Math.min(...out.map(o => o.err)) };
}

const byVp = new Map();
for (const r of rows) {
  if (r.wbW == null) { console.log(`SKIP ${r.vp} dpr${r.dpr}: __view() undefined (match never started)`); continue; }
  const img = decodePng(readFileSync(`${DIR}${r.vp}-dpr${String(r.dpr).replace('.', '_')}.png`));
  const g = greenField(img, r.dpr);
  const cap = Math.min(r.dpr, 2);
  const bandCss = r.bandY * ART / cap, playHCss = r.playH * ART / cap, playWCss = r.playW * ART / cap;
  const w2c = playWCss / r.win.w;
  const predEdge = (0 - r.win.x) * w2c + r.bandX * ART / cap;   // world x=0 -> CSS x
  const prof = colGreen(g, bandCss + playHCss * 0.25, bandCss + playHCss * 0.75);
  const e = grassEdge(prof);
  const rec = { r, g, bandCss, playHCss, playWCss, predEdge, edge: e.x, edgeStrength: +e.d.toFixed(1) };
  if (!byVp.has(r.vp)) byVp.set(r.vp, []); byVp.get(r.vp).push(rec);
}

for (const [vp, grp] of byVp) {
  const r0 = grp[0].r;
  console.log(`\n=== ${vp}  css ${r0.cssW}x${r0.cssH} ===`);
  console.log('dpr'.padEnd(6) + 'shot(dev)'.padEnd(13) + 'canvas'.padEnd(12) + 'scale'.padEnd(9)
    + 'sees'.padEnd(11) + 'win rect'.padEnd(24) + 'grass edge css: pred / MEASURED / err'.padEnd(40) + 'edge strength');
  for (const g of grp) {
    console.log(String(g.r.dpr).padEnd(6) + `${Math.round(g.r.cssW * g.r.dpr)}x${Math.round(g.r.cssH * g.r.dpr)}`.padEnd(13)
      + `${g.r.cw}x${g.r.ch}`.padEnd(12) + String(g.r.scale).padEnd(9) + g.r.sees.padEnd(11)
      + `${g.r.win.w}x${g.r.win.h}@${g.r.win.x},${g.r.win.y}`.padEnd(24)
      + `${g.predEdge.toFixed(1)} / ${g.edge} / ${(g.edge - g.predEdge).toFixed(1)}`.padEnd(40) + g.edgeStrength);
  }
  const ref = grp.find(x => x.r.dpr === 2);
  if (ref) {
    const y0 = Math.round(ref.bandCss + ref.playHCss * 0.15), y1 = Math.round(ref.bandCss + ref.playHCss * 0.85);
    console.log(`  --- full-frame 2-D shift vs dpr2, greenness field, rows ${y0}..${y1} css ---`);
    for (const g of grp) {
      if (g === ref) { console.log(`  dpr 2  : reference`); continue; }
      const s = ssdShift(ref.g, g.g, 24, y0, y1, 20, Math.min(ref.g.w, g.g.w) - 20);
      console.log(`  dpr ${String(g.r.dpr).padEnd(4)}: best shift (${s.best.sx >= 0 ? '+' : ''}${s.best.sx},${s.best.sy >= 0 ? '+' : ''}${s.best.sy}) err ${s.best.err.toFixed(1)} | err at (0,0) ${s.zero.err.toFixed(1)} | ratio zero/best ${(s.zero.err / s.best.err).toFixed(3)} | err spread over search ${s.spread.toFixed(2)}x`);
    }
  }
  const edges = grp.filter(x => x.r.dpr >= 2).map(x => x.edge);
  console.log(`  dpr>=2 measured grass-edge columns: ${edges.join(', ')} css  -> spread ${Math.max(...edges) - Math.min(...edges)} px`);
}
