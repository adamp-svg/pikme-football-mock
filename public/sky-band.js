// Saltiz ambient sky band.
//
// Screen-fixed scenery for the spare strip above/below the fixed-height play window on tablets.
// Intentionally knows nothing about match/world units; callers pass a normalized top-edge approach.
//
// Public API:
//   SkyBand.draw(ctx, { x, y, w, h }, {
//     camX, t, side, bannerText, topApproach
//   })
//
// `topApproach` is 0 at midfield and 1 at the upper stadium edge. The cloud bank moves toward the
// field edge as the stadium camera reveals upward, intentionally reversing the previous direction.
(() => {
  'use strict';

  const C = {
    ink: '#101512',
    sky0: '#142b49', // value/saturation shifts of team blue — no added hue
    sky1: '#18385f',
    sky2: '#1d4779',
    cloud0: '#9fb5c8',
    cloud1: '#dbe8f2',
    cloud2: '#f7fbff',
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

  // Large, unmistakably cloud-shaped white pixel masses. Their long irregular silhouettes and
  // overlapping bank keep them visually distinct from the small cream gameplay ball.
  const CLOUD_FORMS = [
    [[.05,.56,.90,.25],[.18,.36,.34,.35],[.43,.18,.27,.51],[.67,.43,.20,.29]],
    [[.04,.59,.92,.22],[.16,.43,.25,.27],[.36,.27,.25,.43],[.58,.38,.29,.32]],
    [[.03,.54,.94,.28],[.12,.35,.27,.39],[.34,.19,.29,.55],[.60,.27,.24,.46],[.77,.46,.14,.28]],
    [[.06,.61,.88,.21],[.19,.42,.23,.29],[.40,.31,.20,.40],[.58,.18,.22,.53],[.76,.48,.15,.25]],
    [[.03,.58,.94,.24],[.12,.43,.22,.30],[.30,.27,.24,.45],[.50,.37,.20,.34],[.67,.24,.22,.47],[.82,.49,.12,.25]],
    [[.02,.57,.96,.26],[.10,.39,.22,.37],[.27,.19,.26,.57],[.48,.30,.21,.46],[.64,.12,.20,.64],[.80,.39,.15,.37]],
  ];

  const makeCloud = (w, h, seed, formIndex) => makeCanvas(w, h, (g) => {
    const rows = CLOUD_FORMS[formIndex].map(([rx, ry, rw, rh]) => ({
      x: Math.round(w * rx),
      y: Math.round(h * ry),
      w: Math.round(w * rw),
      h: Math.round(h * rh),
    }));
    // Blue-grey extrusion, white body, and cold-white top pixels.
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

  const makeSmallBalloon = (w, h, base, dark, light, stripe) => makeCanvas(w, h, (g) => {
    // Stepped tapered envelope + visible ropes/basket: intentionally not a ball-like circle.
    const envH = h - 11;
    const mid = Math.floor(w / 2);
    pxi(g, mid - 3, 1, 6, 2, C.ink);
    pxi(g, 4, 3, w - 8, 3, C.ink);
    pxi(g, 1, 6, w - 2, Math.max(8, envH - 11), C.ink);
    pxi(g, 3, envH - 5, w - 6, 6, C.ink);
    pxi(g, mid - 3, envH + 1, 6, 4, C.ink);
    pxi(g, 3, 5, w - 6, Math.max(8, envH - 10), base);
    pxi(g, 5, envH - 6, w - 10, 5, dark);
    pxi(g, mid - 2, 4, 4, envH - 5, stripe);
    pxi(g, 5, 6, 3, Math.max(5, envH - 13), light);
    pxi(g, mid - 4, envH + 5, 2, 5, C.ink);
    pxi(g, mid + 2, envH + 5, 2, 5, C.ink);
    pxi(g, mid - 5, h - 4, 10, 3, C.goldD);
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
        makeCloud(54, 21, 11, 0),
        makeCloud(68, 24, 19, 1),
        makeCloud(82, 29, 29, 2),
        makeCloud(98, 33, 37, 3),
        makeCloud(118, 39, 47, 4),
        makeCloud(136, 44, 59, 5),
      ],
      balloons: [
        makeSmallBalloon(18, 34, C.red, C.redD, C.redL, C.cream),
        makeSmallBalloon(24, 42, C.blue, C.blueD, C.blueL, C.cream),
        makeSmallBalloon(28, 48, C.gold, C.goldD, C.goldL, C.red),
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
    const topApproach = side === 'top' ? clamp(Number(options.topApproach) || 0, 0, 1) : 0;
    const bankDepth = clamp(Math.round(h * 0.32), 18, 42);
    const cloudPush = Math.round(topApproach * bankDepth * 0.55);
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

    // Opaque cloud shelf: the complete first row touching the field is cloud, never blue sky.
    // It moves in the newly requested (reversed) vertical direction but always leaves a solid cloud
    // lip against the field edge.
    if (h >= 18) {
      if (side === 'top') {
        const bankY = y + h - bankDepth + cloudPush;
        pxi(ctx, x, bankY, w, y + h - bankY, C.cloud1);
        pxi(ctx, x, bankY, w, 4, C.cloud0);
        for (let bx = x - 24; bx < x + w + 24; bx += 48) {
          pxi(ctx, bx + mod(Math.round(camX * 0.018), 24), bankY + 4, 30, 4, C.cloud2);
        }
      } else {
        pxi(ctx, x, y, w, bankDepth, C.cloud1);
        pxi(ctx, x, y + bankDepth - 4, w, 4, C.cloud0);
        for (let bx = x - 24; bx < x + w + 24; bx += 48) {
          pxi(ctx, bx + mod(Math.round(camX * 0.018), 24), y + bankDepth - 8, 30, 4, C.cloud2);
        }
      }
    }

    // A loose far row. It follows the reversed motion less than the foreground bank.
    if (h >= 18) {
      for (let i = 0; i < 5; i++) {
        const cloud = s.clouds[(i * 2 + sideSeed) % s.clouds.length];
        const speed = 0.65 + i * 0.22;
        const span = w + cloud.width + 90;
        const cx = x - cloud.width - 30 + mod(i * 177 + t * speed - camX * 0.008, span);
        const seed = 0.18 + hash(i + sideSeed, 5) * 0.34;
        const cy = y + bandY(side, h, cloud.height, seed, quiet) + cloudPush * 0.38;
        ctx.globalAlpha = 0.68 + (i % 2) * 0.08;
        ctx.drawImage(cloud, Math.round(cx), Math.round(cy));
      }

      // White foreground bank: fourteen clouds on a tight pitch-side cadence, deliberately
      // overlapping. As topApproach rises they push toward the field faster than the far row.
      const nearCount = Math.max(14, Math.ceil(w / 54));
      const cadence = Math.max(42, Math.floor(w / nearCount));
      for (let i = 0; i < nearCount; i++) {
        const cloud = s.clouds[(i * 5 + sideSeed) % s.clouds.length];
        const speed = 0.88 + (i % 6) * 0.15;
        const span = w + cloud.width + cadence;
        const cx = x - cloud.width + mod(21 + i * cadence + t * speed - camX * 0.018, span);
        const seed = 0.79 + hash(i + sideSeed, 13) * 0.17;
        const cy = y + bandY(side, h, cloud.height, seed, Math.min(quiet, 8)) + cloudPush;
        ctx.globalAlpha = 0.88 + (i % 3) * 0.04;
        ctx.drawImage(cloud, Math.round(cx), Math.round(cy));
      }
      ctx.globalAlpha = 1;
    }

    // Balloons live ONLY in the distant outer sky. The entire pitch-side bank is clouds alone.
    if (h >= 46) {
      for (let i = 0; i < 3; i++) {
        const balloon = s.balloons[(i + (side === 'bottom' ? 1 : 0)) % s.balloons.length];
        const span = w + 140;
        const bx = x - 70 + mod(88 + i * 241 + t * (0.45 + i * 0.16) - camX * 0.026, span);
        const seed = 0.05 + hash(i + 31, sideSeed + 9) * 0.22;
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
      const by = y + bandY(side, h, airAd.height, 0.06, Math.min(quiet, 12));
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
      cloudDrift: '0.65–1.70 art px/s',
      smallBalloonDrift: '0.45–0.77 art px/s',
      airAdDrift: '4.2 art px/s',
      farCloudParallax: 0.008,
      nearCloudParallax: 0.018,
      topApproachPush: 0.55,
      smallBalloonParallax: 0.026,
      airAdParallax: 0.045,
    }),
    reducedMotion: () => reduced,
  });
})();
