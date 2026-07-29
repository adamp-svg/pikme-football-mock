// The resize() arithmetic in isolation (client.js 6301-6329), swept over every plausible viewport and dpr
// INCLUDING uncapped values, to test whether dpr can change the visible world region at all.
const ART_PX = 3.25, CAM_ZOOM = 1.65, FIELD = { W: 2000, H: 1100 };
const PLAY_W = FIELD.W / CAM_ZOOM, PLAY_H = 560;
const view = (iw, ih, rawDpr, cap = 2) => {
  const dpr = Math.min(rawDpr || 1, cap);
  const cw = iw * dpr, chh = ih * dpr;
  const wbW = Math.max(1, Math.ceil(cw / ART_PX)), wbH = Math.max(1, Math.ceil(chh / ART_PX));
  const scale = Math.min(wbW / PLAY_W, wbH / PLAY_H);
  const playW = Math.min(wbW, PLAY_W * scale), playH = Math.min(wbH, PLAY_H * scale);
  return { dpr, cw, chh, wbW, wbH, scale, playW, playH,
           bandX: Math.round((wbW - playW) / 2), bandY: Math.round((wbH - playH) / 2),
           seesW: Math.round(playW / scale), seesH: Math.round(playH / scale) };
};
let n = 0, bad = [];
const sees = new Set();
for (let iw = 320; iw <= 1400; iw++) for (const d of [1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3, 3.5, 4]) {
  for (const ih of [ Math.round(iw / 2.4), Math.round(iw / 2.16), Math.round(iw / 1.9), Math.round(iw / 1.43), Math.round(iw / 1.33) ]) {
    const v = view(iw, ih, d); n++;
    sees.add(`${v.seesW}x${v.seesH}`);
    if (v.seesW !== 1212 || v.seesH !== 560) bad.push({ iw, ih, d, sees: `${v.seesW}x${v.seesH}` });
  }
}
console.log(`swept ${n} (viewport x dpr) combinations, dpr 1..4, aspect 1.33..2.4, width 320..1400`);
console.log(`distinct seesWorld: ${sees.size} -> ${[...sees].join(' | ')}`);
console.log(`combinations NOT 1212x560: ${bad.length}` + (bad.length ? '  e.g. ' + JSON.stringify(bad.slice(0, 5)) : ''));
// And the cap with NO cap at all, to answer "would removing the cap change the world region?"
let bad2 = 0; const sees2 = new Set();
for (let iw = 320; iw <= 1400; iw++) for (const d of [2, 3, 4]) for (const ih of [Math.round(iw/2.16), Math.round(iw/1.43)]) {
  const v = view(iw, ih, d, Infinity); sees2.add(`${v.seesW}x${v.seesH}`); if (v.seesW !== 1212 || v.seesH !== 560) bad2++;
}
console.log(`\nSAME SWEEP WITH THE CAP REMOVED (cap=Infinity): distinct seesWorld ${sees2.size} -> ${[...sees2].join(' | ')}, off-spec ${bad2}`);
// What the cap DOES change, at the reference iPhone metric:
console.log('\nWhat dpr actually moves at 874x402 (cap 2):');
for (const d of [1, 1.5, 2, 3]) { const v = view(874, 402, d);
  console.log(`  dpr ${String(d).padEnd(4)} -> canvas ${v.cw}x${v.chh}  wb ${v.wbW}x${v.wbH}  scale ${v.scale.toFixed(4)}  band ${v.bandX},${v.bandY}art  SEES ${v.seesW}x${v.seesH}  art-pixel on glass = ${(ART_PX / v.dpr * d).toFixed(3)} device px`); }
