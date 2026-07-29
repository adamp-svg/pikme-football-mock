// Saltiz ambient sky band.
//
// Screen-fixed scenery for the spare strip above/below the fixed-height play window on tablets.
// Intentionally knows nothing about the match, world Y, camera Y, or client.js internals.
//
// Public API:
//   SkyBand.draw(ctx, { x, y, w, h }, {
//     camX, camY, t, side, bannerText
//   })
//
// `camY` is accepted only as part of the shared call shape and is NEVER read. Horizontal camera
// movement produces restrained depth parallax; vertical movement must never slide the band.
(() => {
  'use strict';

  const C = {
    ink: '#101512',
    sky0: '#142b49', // value/saturation shifts of team blue — no added hue
    sky1: '#18385f',
    sky2: '#1d4779',
    cloud0: '#1b3f6b',
    cloud1: '#24558e',
    cloud2: '#2b62a2',
    blue: '#2e70df',
    blueD: '#2052a8',
    blueL: '#4a83df',
    red: '#e84b3c',
    redD: '#a9372e',
    redL: '#ed7166',
    gold: '#ffcb43',
    goldD: '#ad7f22',
    goldL: '#ffdc78',
    cream: '#fff0c2',
  };

  const pxi = (g, x, y, w, h, col) => {
    g.fillStyle = col;
    g.fillRect(Math.round(x), Math.round(y), Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
  };
  const hash = (x, y) => {
    const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return n - Math.floor(n);
  };
  const mod = (n, d) => ((n % d) + d) % d;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  const makeCanvas = (w, h, paint) => {
    const c = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(w, h)
      : document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d', { alpha: true });
    g.imageSmoothingEnabled = false;
    paint(g, w, h);
    return c;
  };

  // Block-cloud silhouettes are deliberately blue, never white/cream: no cloud can be confused
  // with the 26-unit cream ball, and the whole band stays below the pitch's contrast.
  const makeCloud = (w, h, seed) => makeCanvas(w, h, (g) => {
    const rows = [
      { x: 8, y: Math.round(h * 0.48), w: w - 16, h: Math.round(h * 0.31) },
      { x: Math.round(w * 0.22), y: Math.round(h * 0.27), w: Math.round(w * 0.50), h: Math.round(h * 0.48) },
      { x: Math.round(w * 0.42), y: Math.round(h * 0.13), w: Math.round(w * 0.25), h: Math.round(h * 0.52) },
      { x: Math.round(w * 0.08), y: Math.round(h * 0.38), w: Math.round(w * 0.30), h: Math.round(h * 0.35) },
    ];
    // Restrained two-pixel extrusion.
    for (const r of rows) pxi(g, r.x + 2, r.y + 2, r.w, r.h, C.sky0);
    for (const r of rows) pxi(g, r.x, r.y, r.w, r.h, C.cloud0);
    for (const r of rows) pxi(g, r.x + 2, r.y + 2, r.w - 4, r.h - 4, C.cloud1);
    for (const r of rows) pxi(g, r.x + 2, r.y + 2, r.w - 6, 2, C.cloud2);
    // A handful of large blocks, never noisy stipple.
    for (let i = 0; i < 4; i++) {
      const bx = 8 + Math.floor(hash(seed, i) * Math.max(4, w - 24));
      const by = Math.floor(h * 0.42 + hash(i, seed) * h * 0.2);
      pxi(g, bx, by, 5 + (i % 2) * 3, 2, i & 1 ? C.cloud0 : C.cloud2);
    }
  });

  const makeSmallBalloon = (base, dark, light) => makeCanvas(18, 34, (g) => {
    // 14x19 stepped teardrop + visible 8px string: intentionally not a ball-like circle.
    pxi(g, 6, 1, 6, 2, C.ink);
    pxi(g, 3, 3, 12, 3, C.ink);
    pxi(g, 1, 6, 16, 9, C.ink);
    pxi(g, 3, 15, 12, 5, C.ink);
    pxi(g, 6, 20, 6, 4, C.ink);
    pxi(g, 6, 3, 6, 2, light);
    pxi(g, 3, 6, 11, 8, base);
    pxi(g, 5, 14, 8, 5, dark);
    pxi(g, 7, 19, 4, 3, dark);
    pxi(g, 4, 7, 3, 6, light);
    pxi(g, 8, 24, 2, 6, C.ink);       // string
    pxi(g, 6, 30, 6, 3, C.goldD);     // tiny squared basket
  });

  // 5x7 Hebrew bitmap. The lab/default uses a subset, but the full alphabet + finals means callers
  // can supply any short Hebrew house message without falling back to antialiased browser text.
  const GLYPHS = {
    'א': ['10001','01010','00100','01010','10001','10001','10001'],
    'ב': ['11110','00010','00010','11110','10000','10000','11111'],
    'ג': ['00111','00001','00001','00001','10001','10001','01110'],
    'ד': ['11111','00001','00001','00001','00001','00001','00001'],
    'ה': ['11111','10001','10001','10001','10001','10001','10001'],
    'ו': ['00110','00110','00110','00110','00110','00110','00110'],
    'ז': ['11111','00010','00100','00100','00100','00100','00100'],
    'ח': ['10001','10001','10001','10001','10001','10001','11111'],
    'ט': ['10001','10001','01001','00101','00011','10001','01110'],
    'י': ['00110','00110','00110','00000','00000','00000','00000'],
    'כ': ['11110','00001','00001','00001','00001','00001','11110'],
    'ך': ['11110','00001','00001','00001','00001','00001','00001'],
    'ל': ['00010','00010','00010','00110','01010','10010','01100'],
    'מ': ['10001','11001','10101','10011','10001','10001','11111'],
    'ם': ['11111','10001','10001','10001','10001','10001','11111'],
    'נ': ['00111','00001','00001','00001','00001','00001','11110'],
    'ן': ['00111','00001','00001','00001','00001','00001','00001'],
    'ס': ['01110','10001','10001','10001','10001','10001','01110'],
    'ע': ['10001','10001','10001','10001','01010','01010','00100'],
    'פ': ['11110','10001','10001','11110','10000','10000','10000'],
    'ף': ['11110','10001','10001','11110','10000','10000','10000'],
    'צ': ['10001','01001','00101','00011','00101','01001','10001'],
    'ץ': ['10001','01001','00101','00011','00101','00001','00001'],
    'ק': ['11111','10001','10001','10101','10011','10000','10000'],
    'ר': ['11110','00001','00001','00001','00001','00001','00001'],
    'ש': ['10101','10101','10101','10101','10101','10101','11111'],
    'ת': ['11111','10001','10001','10001','10001','10001','10001'],
    ' ': ['00000','00000','00000','00000','00000','00000','00000'],
  };

  const cleanBannerText = (value) => {
    const src = String(value == null ? 'שחקו יחד' : value).trim().slice(0, 12);
    const chars = [...src].filter((ch) => GLYPHS[ch]);
    return chars.length ? chars.join('') : 'שחקו יחד';
  };

  const bannerCache = new Map();
  const makeAirAd = (rawText) => {
    const text = cleanBannerText(rawText);
    if (bannerCache.has(text)) return bannerCache.get(text);
    const c = makeCanvas(174, 70, (g) => {
      // Balloon: stepped/teardrop main silhouette, charcoal 2px outline, lower-right extrusion.
      pxi(g, 7, 4, 28, 2, C.ink);
      pxi(g, 3, 6, 36, 5, C.ink);
      pxi(g, 1, 11, 40, 18, C.ink);
      pxi(g, 3, 29, 36, 9, C.ink);
      pxi(g, 7, 38, 28, 7, C.ink);
      pxi(g, 13, 45, 16, 4, C.ink);
      pxi(g, 5, 8, 32, 20, C.red);
      pxi(g, 7, 28, 28, 9, C.redD);
      pxi(g, 11, 37, 20, 6, C.redD);
      pxi(g, 9, 8, 8, 27, C.redL);
      pxi(g, 19, 7, 6, 34, C.gold);
      pxi(g, 15, 49, 2, 7, C.ink);
      pxi(g, 27, 49, 2, 7, C.ink);
      pxi(g, 13, 56, 18, 7, C.ink);
      pxi(g, 15, 56, 14, 5, C.goldD);

      // Banner cords and pixel plate, styled like the perimeter ad boards without their neon glow.
      pxi(g, 35, 25, 14, 2, C.ink);
      pxi(g, 35, 35, 14, 2, C.ink);
      pxi(g, 45, 23, 124, 27, C.ink);       // outline
      pxi(g, 49, 50, 120, 3, C.sky0);       // lower-right extrusion
      pxi(g, 47, 25, 120, 23, C.blueD);
      pxi(g, 49, 27, 116, 3, C.blueL);       // upper-left light
      pxi(g, 49, 30, 116, 16, C.blue);
      pxi(g, 49, 44, 116, 2, C.blueD);

      // RTL: logical first character is drawn at the right edge, then the pen moves left.
      const px = 2;
      const advance = 6 * px;
      const total = text.length * advance - px;
      let ox = 49 + Math.floor((116 + total) / 2) - 5 * px;
      const oy = 31;
      for (const ch of text) {
        const rows = GLYPHS[ch] || GLYPHS[' '];
        for (let yy = 0; yy < 7; yy++) {
          for (let xx = 0; xx < 5; xx++) {
            if (rows[yy][xx] === '1') pxi(g, ox + xx * px, oy + yy * px, px, px, C.cream);
          }
        }
        ox -= advance;
      }
    });
    bannerCache.set(text, c);
    // A malicious/high-churn caller cannot grow this forever.
    if (bannerCache.size > 8) bannerCache.delete(bannerCache.keys().next().value);
    return c;
  };

  let sprites = null;
  const ensureSprites = () => {
    if (sprites) return sprites;
    sprites = {
      clouds: [
        makeCloud(62, 24, 11),
        makeCloud(94, 32, 29),
        makeCloud(126, 42, 47),
      ],
      balloons: [
        makeSmallBalloon(C.red, C.redD, C.redL),
        makeSmallBalloon(C.blue, C.blueD, C.blueL),
        makeSmallBalloon(C.gold, C.goldD, C.goldL),
      ],
    };
    return sprites;
  };

  let reduced = false;
  if (typeof matchMedia === 'function') {
    const mq = matchMedia('(prefers-reduced-motion: reduce)');
    reduced = mq.matches;
    const onChange = (e) => { reduced = e.matches; };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }

  const bandY = (side, h, spriteH, seed, quiet) => {
    const room = Math.max(0, h - spriteH - quiet * 2);
    const local = quiet + Math.round(room * clamp(seed, 0, 1));
    return side === 'top' ? local : h - local - spriteH;
  };

  function draw(ctx, rect, options = {}) {
    const x = Math.round(Number(rect && rect.x) || 0);
    const y = Math.round(Number(rect && rect.y) || 0);
    const w = Math.max(0, Math.round(Number(rect && rect.w) || 0));
    const h = Math.max(0, Math.round(Number(rect && rect.h) || 0));
    // Phone fast path: no allocation, media work, save/clip, or sprite-cache creation.
    if (!ctx || w <= 0 || h <= 0) return;

    const side = options.side === 'bottom' ? 'bottom' : 'top';
    const camX = Number(options.camX) || 0;
    // DO NOT read the vertical camera option. Vertical camera coupling is forbidden by design.
    const t = reduced ? 0 : Math.max(0, Number(options.t) || 0);
    const s = ensureSprites();
    const oldSmooth = ctx.imageSmoothingEnabled;

    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.imageSmoothingEnabled = false;

    // Three broad value bands. The innermost 16px are deliberately plain and low-frequency so the
    // ambient art never competes with the touchline or implies gameplay.
    pxi(ctx, x, y, w, h, C.sky0);
    const q1 = Math.round(h * 0.34);
    const q2 = Math.round(h * 0.70);
    if (side === 'top') {
      pxi(ctx, x, y + q1, w, h - q1, C.sky1);
      pxi(ctx, x, y + q2, w, h - q2, C.sky2);
    } else {
      pxi(ctx, x, y, w, h - q1, C.sky1);
      pxi(ctx, x, y, w, h - q2, C.sky2);
    }

    const quiet = Math.min(18, Math.max(4, Math.floor(h * 0.16)));
    const sideSeed = side === 'top' ? 0 : 17;

    // Far clouds: 0.8–1.7 art px/s, 1.2% camera parallax.
    if (h >= 18) {
      for (let i = 0; i < 4; i++) {
        const cloud = s.clouds[(i + sideSeed) % s.clouds.length];
        const speed = 0.8 + i * 0.3;
        const span = w + cloud.width + 90;
        const cx = x - cloud.width - 30 + mod(i * 173 + t * speed - camX * 0.012, span);
        const seed = 0.08 + hash(i + sideSeed, 5) * 0.68;
        const cy = y + bandY(side, h, cloud.height, seed, quiet);
        ctx.globalAlpha = 0.72 + (i % 2) * 0.10;
        ctx.drawImage(cloud, Math.round(cx), Math.round(cy));
      }
      ctx.globalAlpha = 1;
    }

    // Small floating balloons: clearly teardrop-shaped, saturated, and stringed. Their 18x34
    // silhouette is unlike the cream 26-unit ball. Kept out of very shallow bands.
    if (h >= 46) {
      for (let i = 0; i < 3; i++) {
        const balloon = s.balloons[(i + (side === 'bottom' ? 1 : 0)) % s.balloons.length];
        const span = w + 140;
        const bx = x - 70 + mod(88 + i * 241 + t * (0.45 + i * 0.16) - camX * 0.026, span);
        const seed = 0.12 + hash(i + 31, sideSeed + 9) * 0.50;
        const by = y + bandY(side, h, balloon.height, seed, quiet);
        ctx.globalAlpha = 0.82;
        ctx.drawImage(balloon, Math.round(bx), Math.round(by));
      }
      ctx.globalAlpha = 1;
    }

    // One hero balloon, top band only. 4.2px/s crosses a tablet-width band in roughly 90–140s.
    if (side === 'top' && h >= 72) {
      const airAd = makeAirAd(options.bannerText);
      const span = w + airAd.width + 110;
      // Phase it on-screen at t=0 so a static lab/screenshot shows the hero asset immediately.
      const bx = x - airAd.width - 55 + mod(260 + t * 4.2 - camX * 0.045, span);
      const by = y + bandY(side, h, airAd.height, 0.14, Math.min(quiet, 12));
      ctx.globalAlpha = 0.90;
      ctx.drawImage(airAd, Math.round(bx), Math.round(by));
      ctx.globalAlpha = 1;
    }

    ctx.imageSmoothingEnabled = oldSmooth;
    ctx.restore();
  }

  window.SkyBand = Object.freeze({
    draw,
    // Lab/test observability; production callers only need draw().
    palette: Object.freeze({ ...C }),
    rates: Object.freeze({
      cloudDrift: '0.8–1.7 art px/s',
      smallBalloonDrift: '0.45–0.77 art px/s',
      airAdDrift: '4.2 art px/s',
      cloudParallax: 0.012,
      smallBalloonParallax: 0.026,
      airAdParallax: 0.045,
    }),
    reducedMotion: () => reduced,
  });
})();
