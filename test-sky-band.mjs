// Structural/runtime checks for public/sky-band.js without needing a browser canvas.
// Visual review lives in public/_sky-band.html; these checks pin the API, caching, integer-pixel
// discipline, approved sprite variety, vertical reveal parallax, reduced motion, and the zero-height fast path.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('./public/sky-band.js', import.meta.url), 'utf8');
const labSource = readFileSync(new URL('./public/_sky-band.html', import.meta.url), 'utf8');
let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures++;
};

function loadSky({ reduce = false } = {}) {
  let allocations = 0;

  class FakeContext {
    constructor() {
      this.ops = [];
      this.fillStyle = '';
      this.globalAlpha = 1;
      this.imageSmoothingEnabled = true;
    }
    save() { this.ops.push(['save']); }
    restore() { this.ops.push(['restore']); }
    beginPath() { this.ops.push(['beginPath']); }
    rect(...a) { this.ops.push(['rect', ...a]); }
    clip() { this.ops.push(['clip']); }
    fillRect(...a) { this.ops.push(['fillRect', ...a, this.fillStyle]); }
    drawImage(img, ...a) { this.ops.push(['drawImage', img.width, img.height, ...a, this.globalAlpha]); }
  }

  class FakeCanvas {
    constructor(w = 0, h = 0) {
      allocations++;
      this.width = w;
      this.height = h;
      this.ctx = new FakeContext();
    }
    getContext() { return this.ctx; }
  }

  const window = {};
  const sandbox = {
    window,
    OffscreenCanvas: FakeCanvas,
    document: { createElement: () => new FakeCanvas() },
    matchMedia: () => ({
      matches: reduce,
      addEventListener() {},
      addListener() {},
    }),
    Math,
    Number,
    String,
    Object,
  };
  vm.runInNewContext(source, sandbox, { filename: 'public/sky-band.js' });
  return {
    SkyBand: window.SkyBand,
    FakeContext,
    allocations: () => allocations,
  };
}

{
  const h = loadSky();
  check(h.SkyBand && typeof h.SkyBand.draw === 'function', 'exposes window.SkyBand.draw');
  check(h.allocations() === 0, 'loading the module allocates no sprite canvases');

  const phone = new h.FakeContext();
  h.SkyBand.draw(phone, { x: 0, y: 0, w: 700, h: 0 },
    { camX: 50, camY: 999, t: 10, side: 'top' });
  check(phone.ops.length === 0 && h.allocations() === 0,
    'zero-height phone band is a true no-op with zero lazy allocations');

  const top = new h.FakeContext();
  h.SkyBand.draw(top, { x: 3, y: 5, w: 700, h: 174 },
    { camX: 120, camY: -500, t: 18, side: 'top', bannerText: 'שחקו יחד' });
  const afterFirst = h.allocations();
  check(afterFirst === 10, `first visible top band pre-renders 10 cached sprites (${afterFirst})`);
  check(top.ops.some((o) => o[0] === 'clip'), 'visible draw clips to the supplied band rect');
  const drawnSizes = new Set(top.ops
    .filter((o) => o[0] === 'drawImage')
    .map((o) => `${o[1]}x${o[2]}`));
  check(['54x21','68x24','82x29','98x33','118x39','136x44'].every((size) => drawnSizes.has(size)),
    'all six approved cloud silhouettes are drawn');
  check(['18x34','24x42','28x48','174x70'].every((size) => drawnSizes.has(size)),
    'all four approved hot-air balloon silhouettes are drawn');
  const pitchSideBalloons = top.ops.filter((o) =>
    o[0] === 'drawImage'
    && ['18x34','24x42','28x48','174x70'].includes(`${o[1]}x${o[2]}`)
    && o[4] > 5 + 174 * 0.55);
  check(pitchSideBalloons.length === 0,
    'the field-facing half contains clouds only; every balloon stays in the distant sky');

  const again = new h.FakeContext();
  h.SkyBand.draw(again, { x: 3, y: 5, w: 700, h: 174 },
    { camX: 120, topApproach: 0, t: 18, side: 'top', bannerText: 'שחקו יחד' });
  check(h.allocations() === afterFirst, 'same banner and sprites are reused without rebuilding');
  check(JSON.stringify(top.ops) === JSON.stringify(again.ops),
    'same parallax inputs reproduce the same drawing operations');

  const edge = new h.FakeContext();
  h.SkyBand.draw(edge, { x: 3, y: 5, w: 700, h: 174 },
    { camX: 120, topApproach: 1, t: 18, side: 'top', bannerText: 'שחקו יחד' });
  const cloudYs = (ops) => ops
    .filter((o) => o[0] === 'drawImage' && o[1] <= 136 && o[2] <= 44)
    .map((o) => o[4]);
  const centerYs = cloudYs(top.ops);
  const edgeYs = cloudYs(edge.ops);
  check(edgeYs.length === centerYs.length
    && edgeYs.reduce((sum, value, i) => sum + (value - centerYs[i]), 0) > edgeYs.length * 8,
  'approaching the top stadium edge moves clouds in the corrected inverted direction');

  const nearClouds = top.ops.filter((o) =>
    o[0] === 'drawImage' && o[1] <= 136 && o[2] <= 44 && o[o.length - 1] >= 0.88);
  check(nearClouds.length >= 14, 'pitch-side white bank contains at least fourteen overlapping clouds');
  check(top.ops.some((o) => o[0] === 'fillRect'
    && o[1] === 3 && o[3] === 700 && o[5] === '#dbe8f2'
    && o[2] <= 5 + 173 && o[2] + o[4] > 5 + 173),
  'the complete field-facing row is opaque white cloud with no blue gaps');

  const numericArgs = top.ops.flatMap((o) => {
    if (o[0] === 'fillRect' || o[0] === 'rect') return o.slice(1, 5);
    if (o[0] === 'drawImage') return o.slice(3, -1); // skip cached source size + global alpha
    return [];
  });
  check(numericArgs.every(Number.isInteger), 'all destination geometry is integer-snapped');

  const custom = new h.FakeContext();
  h.SkyBand.draw(custom, { x: 0, y: 0, w: 700, h: 174 },
    { camX: 0, camY: 0, t: 0, side: 'top', bannerText: 'יחד' });
  check(h.allocations() === afterFirst + 1, 'a custom short Hebrew banner is cached once');

  const bottom = new h.FakeContext();
  h.SkyBand.draw(bottom, { x: 0, y: 300, w: 700, h: 99 },
    { camX: 0, camY: 123, t: 4, side: 'bottom' });
  check(!bottom.ops.some((o) => o[0] === 'drawImage' && o[1] === 174 && o[2] === 70),
    'hero advertising balloon appears only once, in the top band');
}

{
  const reduced = loadSky({ reduce: true });
  const a = new reduced.FakeContext();
  const b = new reduced.FakeContext();
  reduced.SkyBand.draw(a, { x: 0, y: 0, w: 700, h: 174 },
    { camX: 20, camY: 0, t: 1, side: 'top' });
  reduced.SkyBand.draw(b, { x: 0, y: 0, w: 700, h: 174 },
    { camX: 20, camY: 0, t: 9999, side: 'top' });
  check(JSON.stringify(a.ops) === JSON.stringify(b.ops),
    'prefers-reduced-motion freezes every time-based drawing operation');
}

check(!source.includes('fillText('), 'Hebrew banner uses bitmap glyphs, not antialiased canvas text');
check(source.includes("cloud2: '#f7fbff'"), 'cloud highlights use the requested near-white palette');
check(labSource.includes("{ canvas: document.getElementById('iphone'), band: 0 }"),
  'artifact gives iPhone a zero-height cloud band');
check(labSource.includes("{ canvas: document.getElementById('ipad'), band: 101 }"),
  'artifact gives iPad visible upper and lower cloud bands');

console.log(`\n${failures ? `❌ ${failures} FAILED` : '✅ ALL PASS'}`);
process.exit(failures ? 1 : 0);
