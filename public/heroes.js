// Canvas renderer for the hero cosmetics (client-only). A cosmetic is a
// "hero:skin" id (see /shared/cosmetics.js). Everything draws through integer
// pixel-rects so it matches the game's crisp voxel look. Purely visual.
import { normalizeCosmetic } from '/shared/cosmetics.js';

function px(ctx, x, y, w, h, col) {
  ctx.fillStyle = col;
  ctx.fillRect(Math.round(x), Math.round(y), Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
}
function shade(hex, amt) {
  amt = amt || 26; if (!hex || hex[0] !== '#') return hex;
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) - amt, g = ((n >> 8) & 255) - amt, b = (n & 255) - amt;
  r = Math.max(0, r); g = Math.max(0, g); b = Math.max(0, b);
  return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
}

// ---- accessory helpers (sprite-unit coords via H.p) ----------------------
function wingsAngel(H) { const { p, swing } = H, w = '#f5f5ef', wS = '#d4d4cb', f = swing;
  p(-13, 6 + f, 4, 2, w); p(-12, 8 + f, 5, 2, w); p(-11, 10 + f, 5, 2, wS); p(-10, 12 + f, 4, 2, w); p(-10, 4 + f, 3, 2, w);
  p(9, 6 - f, 4, 2, w); p(7, 8 - f, 5, 2, w); p(6, 10 - f, 5, 2, wS); p(6, 12 - f, 4, 2, w); p(7, 4 - f, 3, 2, w); }
function wingsTech(H) { const { p, swing } = H, m = '#8b95a1', mS = '#5f6772', e = '#39e6d6', f = swing;
  p(-12, 7 + f, 5, 2, m); p(-13, 9 + f, 6, 2, mS); p(-12, 11 + f, 5, 1, e);
  p(7, 7 - f, 5, 2, m); p(7, 9 - f, 6, 2, mS); p(7, 11 - f, 5, 1, e); }
function cape(H, col) { const { p, swing } = H, s = swing * 0.6, cS = shade(col, 30);
  p(-5, 9, 10, 3, col); p(-5 + s, 12, 10, 4, col); p(-4 + s * 1.4, 16, 8, 4, cS); p(-3 + s * 1.8, 20, 6, 3, col); }
function tails(H, n, col, colS) { const { p, swing } = H;
  for (let i = 0; i < n; i++) { const off = (i - (n - 1) / 2) * 2.4, f = swing * 0.6 + i * 0.5;
    p(5 + i, 13, 2, 2, col); p(6 + i + off * 0.3, 10, 2, 3, col); p(7 + i + off * 0.6, 7 + f, 2, 3, col); p(8 + i + off, 5 + f, 2, 2, colS); } }
function katana(H) { const { p } = H;
  p(-8, 20, 2, 2, '#20242b'); p(-6, 17, 2, 2, '#20242b'); p(-4, 14, 2, 2, '#20242b');
  p(-2, 11, 2, 2, '#cdd3da'); p(0, 8, 2, 2, '#cdd3da'); p(2, 5, 2, 2, '#e6ebf0'); p(-3, 11, 2, 1, '#8a6a2a'); }
function kimono(H, col, sashCol) { const { p } = H, cS = shade(col, 28);
  p(-6, 9, 12, 9, col); p(-6, 9, 2, 9, cS); p(4, 9, 2, 9, cS); p(-1, 9, 2, 6, cS);
  p(-6, 17, 12, 4, col); p(-7, 21, 14, 3, col); p(-7, 24, 14, 1, cS);
  p(-6, 15, 12, 2, sashCol); p(-1, 15, 2, 5, shade(sashCol, 30)); }
function shoulderPads(H, col) { const { p } = H; p(-8, 8, 4, 3, col); p(4, 8, 4, 3, col); }
function poncho(H, col) { const { p } = H, cS = shade(col, 26);
  p(-7, 9, 14, 2, col); p(-6, 11, 12, 5, col); p(-5, 16, 10, 2, cS); p(-1, 9, 2, 7, cS); p(-6, 13, 12, 1, '#e8c060'); }
function starBadge(H) { const { p } = H; p(-1, 10, 2, 3, '#f2c14e'); p(-2, 11, 4, 1, '#f2c14e'); p(-1, 10, 1, 1, '#ffe08a'); }
function starryRobe(H) { const { p, phase } = H, c = '#171247', cS = '#0d0a2b', tw = Math.sin(phase * 2) > 0;
  p(-6, 9, 12, 10, c); p(-6, 9, 2, 10, cS); p(4, 9, 2, 10, cS); p(-6, 19, 12, 3, c); p(-7, 22, 14, 2, c);
  p(-3, 11, 1, 1, tw ? '#fff' : '#8899bb'); p(2, 13, 1, 1, '#fff'); p(0, 16, 1, 1, tw ? '#cfe' : '#7788aa'); p(-4, 15, 1, 1, '#fff'); p(3, 10, 1, 1, '#fff'); }
function chestCore(H, col) { const { p } = H; p(-2, 12, 4, 3, col); p(-1, 11, 2, 1, '#eafffb'); p(-1, 15, 2, 1, shade(col, 40)); }

// ---- heroes: head (+ optional back) + one Signature skin each ------------
const HERO_DEFS = {
  striker: {
    head(H) { const { p, hair, hairS, skS } = H; p(-5, 0, 10, 3, hair); p(-5, 0, 2, 6, hairS); p(3, 0, 2, 6, hairS); H.eyes(); p(-1, 7, 3, 1, skS); },
    signature: { back: (H) => wingsAngel(H), front: (H) => { const { p } = H; p(-8, 10, 3, 1, '#f2c14e'); starBadge(H); } },
  },
  dwarf: {
    head(H) { const { p, ex, wht, eye } = H; const beard = '#c8671f', beardS = '#a3521a', met = '#8a8f98', metS = '#5f646c', iv = '#e8e2d0';
      p(-6, -2, 12, 4, met); p(-6, 1, 12, 1, metS); p(-9, -3, 3, 2, iv); p(-9, -4, 1, 1, iv); p(6, -3, 3, 2, iv); p(8, -4, 1, 1, iv);
      p(-3 + ex, 3, 2, 2, wht); p(1 + ex, 3, 2, 2, wht); p(-2 + ex, 3, 1, 2, eye); p(2 + ex, 3, 1, 2, eye);
      p(-3, 5, 6, 1, beardS); p(-5, 6, 10, 6, beard); p(-4, 12, 8, 2, beard); p(-2, 14, 4, 1, beard); p(-5, 6, 2, 6, beardS); p(3, 6, 2, 6, beardS); },
    signature: { glow: true, glowCol: '#ffb347', back: (H) => cape(H, '#7a1f1f'), front: (H) => { const { p } = H; p(-4, -1, 2, 2, '#ffd76a'); p(2, -1, 2, 2, '#ffd76a'); } },
  },
  cowboy: {
    head(H) { const { p, skS, K } = H; H.eyes(); p(-4, 7, 8, 1, skS); p(-1, 8, 3, 1, skS); p(-5, 8.5, 10, 2, K.J);
      p(-4, -4, 8, 4, '#6f4a24'); p(-4, -2, 8, 1, '#5a3a1c'); p(-4, -1, 8, 1, '#8a5e30'); p(-8, -1, 16, 2, '#7a5228'); p(-8, 1, 16, 1, '#5a3a1c'); },
    signature: { jersey: '#caa76b', jerseyShade: '#9c7f4a', front: (H) => { poncho(H, '#8a5a2f'); starBadge(H); } },
  },
  cat: {
    back(H) { const { p, swing, sk, skS } = H; p(6, 14, 2, 2, sk); p(7, 11, 2, 3, sk); p(8, 8 + swing, 2, 3, sk); p(9, 6 + swing, 2, 2, skS); },
    head(H) { const { p, ex, wht, sk, skS } = H; const pink = '#e88aa0', ce = '#7bd06a', slit = '#12300c';
      p(-5, -3, 3, 3, sk); p(2, -3, 3, 3, sk); p(-4, -2, 1, 1, pink); p(3, -2, 1, 1, pink);
      p(-3 + ex, 4, 2, 2, ce); p(1 + ex, 4, 2, 2, ce); p(-2 + ex, 4, 1, 2, slit); p(2 + ex, 4, 1, 2, slit);
      p(-1, 6, 2, 1, pink); p(-9, 6, 4, 1, wht); p(5, 6, 4, 1, wht); p(-9, 7, 3, 1, wht); p(6, 7, 3, 1, wht); p(-1, 7, 3, 1, skS); },
    signature: { jersey: '#f0e6cf', jerseyShade: '#d8b46a', glow: true, glowCol: '#ffcf6a', back: (H) => tails(H, 3, '#f3ead3', '#e0b25c') },
  },
  ninja: {
    back(H) { const { p, swing, K } = H; p(6, 1, 4, 1, K.J); p(8, 2 + swing, 3, 1, K.JS); p(10, 3 + swing, 2, 1, K.J); },
    head(H) { const { p, ex, wht, eye, K } = H; const cloth = '#26303a', clothS = '#161d24';
      p(-5, 0, 10, 9, cloth); p(-5, 0, 2, 9, clothS); p(3, 0, 2, 9, clothS); p(-5, 3, 10, 1, K.J); p(-4, 4.5, 8, 2, '#e7b072');
      p(-3 + ex, 4.5, 2, 2, wht); p(1 + ex, 4.5, 2, 2, wht); p(-2 + ex, 4.5, 1, 2, eye); p(2 + ex, 4.5, 1, 2, eye); },
    signature: { jersey: '#3a1f22', jerseyShade: '#241315', back: (H) => katana(H), front: (H) => { kimono(H, '#8a1f2b', '#e8c060'); shoulderPads(H, '#2a2a2f'); const { p } = H; p(-2, -1, 4, 1, '#e8c060'); } },
  },
  robot: {
    skin: '#aab2bc', skinS: '#79828d',
    head(H) { const { p, ex, phase } = H; const met = '#aab2bc', metS = '#79828d', metH = '#d8dde2';
      p(-5, 0, 10, 9, met); p(-5, 0, 10, 1, metH); p(-5, 8, 10, 1, metS); p(-5, 0, 2, 9, metS); p(3, 0, 2, 9, metS);
      p(-1, -4, 1, 4, metS); p(-2, -5, 3, 2, Math.sin(phase * 1.5) > 0 ? '#ff5a5a' : '#7a2020');
      p(-4, 4, 8, 2, '#0f2430'); p(-3 + ex, 4, 3, 2, '#39e6d6'); p(-3, 7, 6, 1, metS); p(-2, 7, 1, 1, met); p(0, 7, 1, 1, met); p(2, 7, 1, 1, met); },
    signature: { glow: true, glowCol: '#39e6d6', back: (H) => wingsTech(H), front: (H) => chestCore(H, '#39e6d6') },
  },
  pirate: {
    head(H) { const { p, ex, wht, eye, skS } = H;
      p(-5, 0, 10, 3, '#c23b3b'); p(-5, 0, 10, 1, '#dd6a6a'); p(-3, 1, 1, 1, wht); p(1, 1, 1, 1, wht);
      p(-8, 2, 2, 2, '#c23b3b'); p(-9, 3, 2, 3, '#9a2f2f'); p(-5, 3, 10, 1, '#0c0c0c');
      p(-3 + ex, 4, 2, 2, wht); p(-2 + ex, 4, 1, 2, eye); p(1, 4, 3, 3, '#0c0c0c');
      p(-4, 7, 8, 2, skS); p(-1, 8, 3, 1, '#2a1e14'); p(-6, 7, 1, 2, '#f2c14e'); },
    signature: { jersey: '#5f7d6e', jerseyShade: '#3f5749', alpha: 0.5, glow: true, glowCol: '#7bffb0' },
  },
  wizard: {
    head(H) { const { p, ex, wht, eye } = H; const bd = '#e9e7de', bdS = '#c8c6bd', ht = '#5a3aa8', htS = '#3f2a7a';
      p(-3 + ex, 3, 2, 2, wht); p(1 + ex, 3, 2, 2, wht); p(-2 + ex, 3, 1, 2, eye); p(2 + ex, 3, 1, 2, eye);
      p(-4, 4, 8, 1, bd); p(-5, 5, 10, 7, bd); p(-4, 12, 8, 2, bd); p(-2, 14, 4, 2, bd); p(-5, 5, 2, 7, bdS); p(3, 5, 2, 7, bdS);
      p(-5, -1, 10, 2, ht); p(-4, -3, 8, 2, ht); p(-3, -5, 6, 2, ht); p(-2, -7, 4, 2, ht); p(-1, -9, 2, 2, ht);
      p(-4, -3, 2, 4, htS); p(-5, -1, 10, 1, '#f2c14e'); p(-1, -4, 2, 2, '#f2c14e'); },
    signature: { jersey: '#1b1740', jerseyShade: '#0f0d26', glow: true, glowCol: '#a97bff', hover: 0.5, front: (H) => starryRobe(H) },
  },
  alien: {
    skin: '#7ad46a', skinS: '#4fa843',
    head(H) { const { p, ex } = H; const g = '#7ad46a', gS = '#4fa843', gH = '#a2e894';
      p(-5, 0, 10, 9, g); p(-4, -1, 8, 1, g); p(-5, 0, 10, 1, gH); p(-5, 0, 2, 9, gS); p(3, 0, 2, 9, gS);
      p(-4 + ex, 4, 3, 3, '#0a0a0a'); p(1 + ex, 4, 3, 3, '#0a0a0a'); p(-3 + ex, 4, 1, 1, '#fff'); p(2 + ex, 4, 1, 1, '#fff');
      p(-1, 8, 2, 1, gS); p(-3, -3, 1, 3, g); p(-4, -5, 2, 1, gH); p(-4, -4, 2, 1, g); p(2, -3, 1, 3, g); p(3, -5, 2, 1, gH); p(3, -4, 2, 1, g); },
    signature: { glow: true, glowCol: '#9dff6a', hover: 1.2 },
  },
};

// generic finishes shared by every hero (Signature is per-hero, above)
const FINISHES = {
  base: {},
  gold: { jersey: '#f4c752', jerseyShade: '#b8892b', sparkle: true },
  holo: { hue: true },
};

// Draw one player. Signature: matches how the game already calls its avatar
// (feet-anchored sprite; `dir` mirrors toward the aim; walk driven by movement).
//   kit = { J, JS } team colours.   t = seconds, drives time-based effects.
export function drawHero(ctx, ox, feetY, sf, dir, walkPhase, moving, firing, cosmeticId, kit, t) {
  const id = normalizeCosmetic(cosmeticId);
  const cut = id.indexOf(':'), hk = id.slice(0, cut), sKey = id.slice(cut + 1);
  const hero = HERO_DEFS[hk] || HERO_DEFS.striker;
  const skin = sKey === 'sig' ? (hero.signature || {}) : (FINISHES[sKey] || {});
  const trueK = kit || { J: '#e64a4f', JS: '#b8383c' };
  const time = t || 0;

  const S = (u) => u * sf, X = (u) => ox + S(u);
  const swing = Math.sin(walkPhase) * 2 * moving;
  const bob = Math.abs(Math.cos(walkPhase)) * moving;
  const lift = skin.hover ? (skin.hover * 4 + Math.sin(time * 3.2) * 1.5) : 0;
  const feet = feetY - S(lift);
  const topY = -28 + bob, Y = (u) => feet + S(topY + u);
  const ex = dir >= 0 ? 1 : -1;

  let J = skin.jersey || trueK.J, JS = skin.jerseyShade || trueK.JS;
  if (skin.hue) { const h = (time * 70) % 360; J = `hsl(${h}, 85%, 60%)`; JS = `hsl(${h}, 70%, 42%)`; }
  const effK = { J, JS };
  const skCol = hero.skin || '#e7b072', skS = hero.skinS || '#c8925a';
  const hair = '#3a2a17', hairS = '#2c2012', eye = '#20242b', wht = '#f2efe4', boot = '#20232a', bootS = '#0f1116';
  const p = (u, v, w, h, c) => px(ctx, X(u), Y(v), S(w), S(h), c);
  const H = { p, X, Y, S, ex, dir, sk: skCol, skS, hair, hairS, eye, wht, boot, bootS, K: effK, trueK, phase: time * 7, swing,
    eyes(col) { const e = col || eye; p(-3 + ex, 4, 2, 2, wht); p(1 + ex, 4, 2, 2, wht); p(-2 + ex, 4, 1, 2, e); p(2 + ex, 4, 1, 2, e); } };

  ctx.save();
  if (skin.alpha != null) ctx.globalAlpha = skin.alpha;

  // ground shadow OR hover disc
  if (skin.hover) {
    const gc = skin.glowCol || '#9dff6a';
    ctx.save(); ctx.globalAlpha = .5; ctx.fillStyle = gc; ctx.shadowColor = gc; ctx.shadowBlur = sf * 2.4;
    ctx.beginPath(); ctx.ellipse(ox, feetY, S(7), S(2), 0, 0, 7); ctx.fill(); ctx.restore();
  } else {
    px(ctx, ox + S(-7), feetY + S(-1), S(14), S(3), 'rgba(0,0,0,.30)');
  }

  if (skin.glow) { ctx.shadowColor = skin.glowCol || trueK.J; ctx.shadowBlur = sf * 2.2; }

  if (skin.back) skin.back(H);
  if (hero.back) hero.back(H);

  // body — team colour rides on sleeves/shorts/socks/collar so red vs blue reads
  const override = !!(skin.jersey || skin.hue);
  const shC = override ? trueK.J : '#eef0f2', shS = override ? trueK.JS : '#c9cdd2';
  p(-4, 20, 3, 6 + swing, skCol); if (override) p(-4, 22, 3, 4 + swing, trueK.J);
  p(-4, 26 + swing, 4, 2, boot); p(-4, 27 + swing, 4, 1, bootS);
  p(1, 20, 3, 6 - swing, skCol); if (override) p(1, 22, 3, 4 - swing, trueK.J);
  p(1, 26 - swing, 4, 2, boot); p(1, 27 - swing, 4, 1, bootS);
  p(-5, 17, 10, 4, shC); p(-5, 20, 10, 1, shS);
  p(-5, 9, 10, 9, J); p(-5, 9, 2, 9, JS); p(3, 9, 2, 9, JS); p(-1, 11, 2, 5, '#f2efe4');
  p(-5, 9, 10, override ? 2 : 1, trueK.J);
  p(-8, 9 - swing, 3, 6, trueK.J); p(-8, 15 - swing, 3, 2, skCol);
  p(5, 9 + swing, 3, 6, trueK.J); p(5, 15 + swing, 3, 2, skCol);
  p(-5, 0, 10, 9, skCol);
  hero.head(H);

  if (skin.front) skin.front(H);

  if (skin.glow) ctx.shadowBlur = 0;
  if (skin.sparkle) {
    const spots = [[-4, 3], [4, 12], [-2, 19], [3, 6], [0, 15]];
    spots.forEach((s, i) => { const tw = Math.sin(time * 4 + i * 1.7); if (tw > 0.3) { ctx.globalAlpha = tw; p(s[0], s[1], 1, 1, '#fff6cf'); p(s[0], s[1] - 1, 1, 1, '#fff6cf'); } });
    ctx.globalAlpha = 1;
  }
  // muzzle-flash outline while firing (matches the legacy avatar)
  if (firing) {
    const tk = Math.max(1, Math.round(sf));
    px(ctx, X(-9), Y(-1), S(18), tk, '#ffd54c'); px(ctx, X(-9), Y(29), S(18), tk, '#ffd54c');
    px(ctx, X(-9), Y(-1), tk, S(30), '#ffd54c'); px(ctx, X(9) - tk, Y(-1), tk, S(30), '#ffd54c');
  }
  ctx.restore();
}
