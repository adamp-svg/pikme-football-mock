// The cap's ONLY real consequence: above dpr 2 the canvas backing store stops growing, so the compositor
// scales the canvas element up to the physical pixels. canvas.style.imageRendering='pixelated' (client.js
// 6304) means that upscale should be nearest-neighbour, i.e. blockier rather than blurrier. Measure it
// instead of asserting it: horizontal run lengths of identical RGB in a grass row. Nearest-neighbour
// upscaling multiplies run lengths; a smooth filter destroys them (runs collapse to 1).
import { readFileSync } from 'node:fs';
import { decodePng } from './_png.mjs';
const DIR = '/private/tmp/claude-501/-Users-adamleeperelman-Documents-pikeme/984e7843-a957-4d6b-97c1-5edee68d8436/scratchpad/dpr/';

function runStats(img, yFrac, x0Frac, x1Frac) {
  const y = Math.round(img.h * yFrac);
  const x0 = Math.round(img.w * x0Frac), x1 = Math.round(img.w * x1Frac);
  const runs = []; let len = 1;
  const at = (x) => { const i = (y * img.w + x) * img.ch; return (img.data[i] << 16) | (img.data[i + 1] << 8) | img.data[i + 2]; };
  for (let x = x0 + 1; x < x1; x++) { if (at(x) === at(x - 1)) len++; else { runs.push(len); len = 1; } }
  runs.push(len);
  const mean = runs.reduce((a, b) => a + b, 0) / runs.length;
  const hist = {}; for (const r of runs) hist[r] = (hist[r] || 0) + 1;
  const top = Object.entries(hist).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k}px×${v}`);
  return { n: runs.length, mean: +mean.toFixed(2), max: Math.max(...runs), top };
}

const CASES = [
  ['phone844-dpr2', 1688, 780, 2], ['phone844-dpr2_5', 1688, 780, 2.5], ['phone844-dpr3', 1688, 780, 3],
  ['ipad1194-dpr2', 2388, 1668, 2], ['ipad1194-dpr2_5', 2388, 1668, 2.5], ['ipad1194-dpr3', 2388, 1668, 3],
];
console.log('shot'.padEnd(20) + 'canvas backing'.padEnd(16) + 'shot(device)'.padEnd(15) + 'composite upscale'.padEnd(19)
  + 'grass-row identical-RGB runs (device px)');
for (const [tag, cw, ch, dpr] of CASES) {
  const img = decodePng(readFileSync(`${DIR}${tag}.png`));
  const s = runStats(img, 0.62, 0.55, 0.95);
  console.log(tag.padEnd(20) + `${cw}x${ch}`.padEnd(16) + `${img.w}x${img.h}`.padEnd(15)
    + `${(img.w / cw).toFixed(3)}x`.padEnd(19)
    + `n=${s.n} mean=${s.mean} max=${s.max} | ${s.top.join(' ')}`);
}
