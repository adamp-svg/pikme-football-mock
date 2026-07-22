// Canvas renderer for the hero cosmetics + animation (client-only). A cosmetic is
// a "hero:skin" id (see /shared/cosmetics.js). Everything draws through integer
// pixel-rects to match the game's crisp voxel look. Purely visual.
//
// drawHero(ctx, ox, feetY, sf, dir, walkPhase, moving, firing, cosmeticId, kit, t, anim?)
//   anim is optional { action, u, power, aimSign, dir:[x,y], strength, force, facing }.
//   Without it (home dancer / picker previews) the sprite idles or runs by `moving`.
//   Legs & arms are 2-segment limbs posed per action; head/finish/accessories layer on.
import { normalizeCosmetic } from '/shared/cosmetics.js';

const PI = Math.PI;
const lerp = (a, b, t) => a + (b - a) * (t < 0 ? 0 : t > 1 ? 1 : t);

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

// ---- heroes: head (front) + optional back-accessory + one Signature ------
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

const FINISHES = { base: {}, gold: { jersey: '#f4c752', jerseyShade: '#b8892b', sparkle: true }, holo: { hue: true } };

// ======================================================================
//  ANIMATION — action poses. Each returns limb targets (Lf/Rf/Lh/Rh in
//  sprite units) + body transforms (bob up-positive, rot, dx/dy, shScale).
//  Directional actions are authored aim-RIGHT; the caller flips for aim-left.
// ======================================================================
export const ACTION_DUR = { kick: 0.5, shoot: 0.5, bomb: 0.42, wall: 0.6, fly: 0.85, hit: 0.6 };

function idlePose(time) { const b = Math.sin(time * 2.2);
  return { bob: (b * 0.5 + 0.5) * 0.8, pt: { Lf: [-2.5, 27], Rf: [2.5, 27], Lh: [-6.5, 17 + b * 0.5], Rh: [6.5, 17 - b * 0.5] } }; }

function runScurry(walkPhase, moving) {              // Scurry: quick tiny steps
  const ph = walkPhase * 1.5, s = Math.sin(ph) * moving;
  return { swing: Math.sin(ph) * 2 * moving, bob: Math.abs(Math.cos(ph)) * moving,
    pt: { Lf: [-2.5 + s * 0.6, 27 - Math.max(0, s) * 2.2], Rf: [2.5 - s * 0.6, 27 - Math.max(0, -s) * 2.2],
      Lh: [-6.5 - s * 0.7, 17], Rh: [6.5 + s * 0.7, 17], Lk: [0, -1], Rk: [0, -1] } }; }

function kickPose(u, power) {                        // Quick tap ↔ Power drive by charge
  const c = power ? { wp: .32, sp: .55, wind: .9, swing: 1.25, reach: 7, lift: 12, windLift: 5, lean: .15, step: 1 }
                  : { wp: .18, sp: .42, wind: .3, swing: .85, reach: 6, lift: 5, windLift: 2, lean: .08, step: .4 };
  let m; if (u < c.wp) m = -(u / c.wp) * c.wind;
  else if (u < c.sp) m = -c.wind + ((u - c.wp) / (c.sp - c.wp)) * (c.wind + c.swing);
  else m = c.swing * (1 - (u - c.sp) / (1 - c.sp));
  const fx = 2.5 + m * c.reach, fy = 27 - (m > 0 ? m * c.lift : (-m) * c.windLift);
  return { rot: m * c.lean, dx: Math.max(m, 0) * c.step, bob: 0,
    pt: { Lf: [-2.5, 27], Rf: [fx, fy], Lk: [0, -1], Rk: [Math.max(m, 0) * 1.3, -1],
      Lh: [-6.5 + Math.max(m, 0) * 3, 17 - Math.max(m, 0) * 3], Rh: [6.5 - Math.max(m, 0) * 2.5, 17 + Math.max(m, 0)] } }; }

function shootPose(u, power) {                        // Punch ↔ Blast by charge
  if (power) {
    let lx, ly, rx, ry, rot = 0, dx = 0;
    if (u < 0.28) { const p = u / 0.28; lx = lerp(-6.5, -2, p); ly = lerp(17, 12, p); rx = lerp(6.5, 2, p); ry = lerp(17, 13, p); rot = lerp(0, -0.05, p); }
    else if (u < 0.46) { const p = (u - 0.28) / 0.18; lx = lerp(-2, 8, p); ly = lerp(12, 10, p); rx = lerp(2, 9, p); ry = lerp(13, 12, p); dx = lerp(0, -1.6, p); rot = lerp(-0.05, 0.03, p); }
    else { const p = (u - 0.46) / 0.54; lx = lerp(8, -6.5, p); ly = lerp(10, 17, p); rx = lerp(9, 6.5, p); ry = lerp(12, 17, p); dx = lerp(-1.6, 0, p); }
    return { rot, dx, bob: 0, pt: { Lf: [-2.5, 27], Rf: [2.5, 27], Lh: [lx, ly], Rh: [rx, ry] } };
  }
  let rx, ry, rot = 0, dx = 0;
  if (u < 0.25) { const p = u / 0.25; rx = lerp(6.5, 3.5, p); ry = lerp(17, 13, p); }
  else if (u < 0.42) { const p = (u - 0.25) / 0.17; rx = lerp(3.5, 10, p); ry = lerp(13, 11, p); dx = lerp(0, 1, p); rot = lerp(0, 0.06, p); }
  else { const p = (u - 0.42) / 0.58; rx = lerp(10, 6.5, p); ry = lerp(11, 17, p); dx = lerp(1, 0, p); rot = lerp(0.06, 0, p); }
  return { rot, dx, bob: 0, pt: { Lf: [-2.5, 27], Rf: [2.5, 27], Lh: [-6.5, 17], Rh: [rx, ry] } };
}

function bombPose(u) {                                // Quick drop
  let rh, rot = 0;
  if (u < 0.45) { const p = u / 0.45; rh = [lerp(6.5, 3, p), lerp(17, 24, p)]; rot = lerp(0, 0.14, p); }
  else { const p = (u - 0.45) / 0.55; rh = [lerp(3, 6.5, p), lerp(24, 17, p)]; rot = lerp(0.14, 0, p); }
  return { rot, bob: 0, pt: { Lf: [-2.5, 27], Rf: [2.5, 27], Lh: [-6.5, 17], Rh: rh } };
}

function buildWindPose(time) {                        // Channel — braced, both hands up-forward, trembling
  const tr = Math.sin(time * 34) * 0.5;              // effort tremble
  const brace = Math.sin(time * 6) * 0.5;            // slow strain sway
  return { rot: Math.sin(time * 26) * 0.02, bob: 2.2,
    pt: { Lf: [-3.5, 27], Rf: [3.5, 27], Lh: [-7.5 + tr, 9 + brace], Rh: [7.5 + tr, 9 + brace] } };
}

function wallPose(u) {                                // Stomp
  let lh, rh, bob = 0, rot = 0;
  if (u < 0.42) { const p = u / 0.42; lh = [lerp(-6.5, -7, p), lerp(17, 6, p)]; rh = [lerp(6.5, 7, p), lerp(17, 6, p)]; bob = lerp(0, 2.5, p); }
  else if (u < 0.54) { const p = (u - 0.42) / 0.12; lh = [lerp(-7, -8, p), lerp(6, 16, p)]; rh = [lerp(7, 8, p), lerp(6, 16, p)]; bob = lerp(2.5, -1, p); rot = lerp(0, 0.06, p); }
  else { const p = (u - 0.54) / 0.46; lh = [lerp(-8, -6.5, p), lerp(16, 17, p)]; rh = [lerp(8, 6.5, p), lerp(16, 17, p)]; bob = lerp(-1, 0, p); rot = lerp(0.06, 0, p); }
  return { rot, bob, pt: { Lf: [-2.5, 27], Rf: [2.5, 27], Lh: lh, Rh: rh } };
}

function looseLimbs(u, amp) { const f = u * 26; return {
  Lf: [-3 + Math.sin(f * 1.1) * 2.5 * amp, 30 + Math.cos(f) * 3 * amp], Rf: [3 + Math.sin(f + 1) * 2.5 * amp, 30 + Math.cos(f * 1.2) * 3 * amp],
  Lh: [-7 + Math.sin(f) * 3.5 * amp, 13 + Math.cos(f * 1.3) * 5 * amp], Rh: [7 + Math.sin(f + 2) * 3.5 * amp, 13 + Math.cos(f) * 5 * amp] }; }
function panicLimbs(u, amp) { const j = u * 60; return {
  Lf: [-3 + Math.sin(j * 1.2) * 2 * amp, 29 + Math.cos(j) * 2.6 * amp], Rf: [3 + Math.sin(j + 2) * 2 * amp, 29 + Math.cos(j * 1.5) * 2.6 * amp],
  Lh: [-6 + Math.sin(j) * 2.6 * amp, 12 + Math.cos(j * 1.7) * 3.4 * amp], Rh: [6 + Math.sin(j + 3) * 2.6 * amp, 12 + Math.cos(j * 1.3) * 3.4 * amp] }; }

function flyPose(u, strength, dir) {                  // Loose (short/normal) → Panic (full)
  const panic = strength > 0.7, amp = 0.6 + strength * 0.65, trail = 1.8 + strength * 1.2, tilt = 0.14 + strength * 0.12;
  const n = Math.hypot(dir[0], dir[1]) || 1, ux = dir[0] / n, uy = dir[1] / n;
  // The sim's knockback slides him across the pitch (p.x/p.y); the pose only adds a
  // vertical hop. One SYMMETRIC arc (sin) drives limbs + hop + lean — apex mid-flight
  // (while he's still moving fast), landing as the glide fades — so it reads as a
  // single fluid launch, not a pop then a ground slide. Upright at both ends.
  const peak = 4 + strength * 6;
  const env = Math.sin(u * PI), H = env * peak;        // symmetric arc: apex mid-flight, so the hop
  const raw = panic ? panicLimbs(u, amp) : looseLimbs(u, amp), bx = -ux, bv = -uy; // tracks the glide as one fluid launch
  const rest = { Lf: [-2.5, 27], Rf: [2.5, 27], Lh: [-6.5, 17], Rh: [6.5, 17] }, lim = {};
  for (const k of ['Lf', 'Rf', 'Lh', 'Rh']) {
    const tx = raw[k][0] + bx * trail, tv = raw[k][1] + bv * trail;    // full flail + trailing target
    lim[k] = [lerp(rest[k][0], tx, env), lerp(rest[k][1], tv, env)];   // ease from/to a neutral standing pose
  }
  return { pt: lim, bob: 0, rot: ux * tilt * env, dx: 0, dy: -H, shScale: 1 - (H / peak) * 0.7 };
}

function hitPose(u, force, dir) {                     // subtle flinch (small) → stumble-back (big push)
  const hx = (dir && dir[0] < 0) ? -1 : 1;            // knocked along the bullet's horizontal travel
  if (force <= 0.5) { const s = Math.sin(u * PI);     // much-less flinch
    return { dx: hx * s * 3, rot: -hx * s * 0.10, bob: -s * 0.8,
      pt: { Lf: [-2.5, 27], Rf: [2.5 - hx * s * 2, 27], Lh: [-7 - s * 0.5, 17 - s * 3], Rh: [7 + s * 0.5, 17 - s * 3] } }; }
  const back = 1 - (1 - u) * (1 - u), st = Math.sin(u * 17), w = u * 15;
  return { dx: hx * back * 11, rot: -hx * 0.12 * Math.sin(u * PI), bob: 0,
    pt: { Lf: [-2.5 + st * 3, 27 - Math.max(0, st) * 3], Rf: [2.5 - st * 3, 27 - Math.max(0, -st) * 3],
      Lh: [-8 + Math.cos(w) * 3, 12 + Math.sin(w) * 4], Rh: [8 + Math.cos(w + PI) * 3, 12 + Math.sin(w + PI) * 4] } };
}

function shufflePose(time) { const ph = time * 5, s = Math.sin(ph);   // celebrate
  return { dx: s * 3, rot: s * 0.06, bob: Math.abs(Math.cos(ph)) * 0.8,
    pt: { Lf: [-2.5 + s * 2, 27 - Math.max(0, s) * 2], Rf: [2.5 + s * 2, 27 - Math.max(0, -s) * 2],
      Lh: [-6 + s * 3, 13 + Math.cos(ph) * 3], Rh: [6 + s * 3, 13 - Math.cos(ph) * 3] } }; }
function headHandsPose(time) { const ph = time * 1.8;                 // concede
  return { rot: 0.09 + Math.sin(ph) * 0.03, bob: -1,
    pt: { Lf: [-2.5, 27], Rf: [2.5, 27], Lh: [-3, 1 + Math.sin(ph) * 0.4], Rh: [3, 1 + Math.sin(ph) * 0.4] } }; }

const REST = { Lf: [-2.5, 27], Rf: [2.5, 27], Lh: [-6.5, 17], Rh: [6.5, 17] };
function resolvePose(anim, walkPhase, moving, time, dir) {
  const base = { pt: REST, bob: 0, rot: 0, dx: 0, dy: 0, flip: 1, facing: 'front', exSign: dir >= 0 ? 1 : -1, swing: 0, shScale: 1 };
  if (!anim) return { ...base, ...(moving > 0.12 ? runScurry(walkPhase, moving) : idlePose(time)) };
  const a = anim, u = a.u || 0, aimFlip = (a.aimSign < 0) ? -1 : 1;
  switch (a.action) {
    case 'run': return { ...base, facing: a.facing || 'front', ...runScurry(walkPhase, Math.max(moving, 0.4)) };
    case 'idle': return { ...base, facing: a.facing || 'front', ...idlePose(time) };
    case 'kick': return { ...base, flip: aimFlip, exSign: 1, ...kickPose(u, a.power) };
    case 'shoot': return { ...base, flip: aimFlip, exSign: 1, ...shootPose(u, a.power) };
    case 'bomb': return { ...base, ...bombPose(u) };
    case 'buildwind': return { ...base, flip: aimFlip, exSign: 1, ...buildWindPose(time) };
    case 'wall': return { ...base, flip: aimFlip, exSign: 1, ...wallPose(u) };
    case 'fly': return { ...base, ...flyPose(u, a.strength == null ? 0.6 : a.strength, a.dir || [0, -1]) };
    case 'hit': return { ...base, ...hitPose(u, a.force || 0, a.dir || [-1, 0]) };
    case 'celebrate': return { ...base, ...shufflePose(time) };
    case 'concede': return { ...base, ...headHandsPose(time) };
  }
  return base;
}

// 2-segment limb (hip→knee→foot / shoulder→elbow→hand)
function segLine(P, x0, v0, x1, v1, w, col, endCol) {
  const dx = x1 - x0, dv = v1 - v0, n = Math.max(1, Math.ceil(Math.hypot(dx, dv) / 1.02));
  for (let i = 0; i <= n; i++) { const t = i / n; P(x0 + dx * t - w / 2, v0 + dv * t - w / 2, w, w, (endCol && i >= n - 1) ? endCol : col); }
}
function limb2(P, hx, hv, fx, fv, bx, bv, w, col, endCol) {
  const kx = (hx + fx) / 2 + bx, kv = (hv + fv) / 2 + bv;
  segLine(P, hx, hv, kx, kv, w, col); segLine(P, kx, kv, fx, fv, w, col, endCol);
}

// ======================================================================
//  DRAW
// ======================================================================
export function drawHero(ctx, ox, feetY, sf, dir, walkPhase, moving, firing, cosmeticId, kit, t, anim) {
  const id = normalizeCosmetic(cosmeticId);
  const cut = id.indexOf(':'), hk = id.slice(0, cut), sKey = id.slice(cut + 1);
  const hero = HERO_DEFS[hk] || HERO_DEFS.striker;
  const skin = sKey === 'sig' ? (hero.signature || {}) : (FINISHES[sKey] || {});
  const trueK = kit || { J: '#e64a4f', JS: '#b8383c' };
  const time = t || 0;

  const A = resolvePose(anim, walkPhase, moving, time, dir);
  const facing = A.facing;
  const lift = skin.hover ? (skin.hover * 4 + Math.sin(time * 3.2) * 1.5) : 0;
  const bob = A.bob;

  const S = (u) => u * sf, X = (u) => ox + S(u), Y = (v) => feetY + S(-28 - bob + v);
  const p = (u, v, w, h, c) => px(ctx, X(u), Y(v), S(w), S(h), c);
  let J = skin.jersey || trueK.J, JS = skin.jerseyShade || trueK.JS;
  if (skin.hue) { const h = (time * 70) % 360; J = `hsl(${h}, 85%, 60%)`; JS = `hsl(${h}, 70%, 42%)`; }
  const effK = { J, JS };
  const skCol = hero.skin || '#e7b072', skS = hero.skinS || '#c8925a';
  const hair = '#3a2a17', hairS = '#2c2012', eye = '#20242b', wht = '#f2efe4', boot = '#20232a', bootS = '#0f1116';
  const H = { p, X, Y, S, ex: A.exSign, dir, sk: skCol, skS, hair, hairS, eye, wht, boot, bootS, K: effK, trueK, phase: time * 7, swing: A.swing || 0,
    eyes(col) { const e = col || eye; p(-3 + A.exSign, 4, 2, 2, wht); p(1 + A.exSign, 4, 2, 2, wht); p(-2 + A.exSign, 4, 1, 2, e); p(2 + A.exSign, 4, 1, 2, e); } };

  ctx.save();
  if (skin.alpha != null) ctx.globalAlpha = skin.alpha;

  // ground shadow / hover disc (stays on the ground, follows horizontal travel)
  if (skin.hover) { const gc = skin.glowCol || '#9dff6a'; ctx.save(); ctx.globalAlpha = .5; ctx.fillStyle = gc; ctx.shadowColor = gc; ctx.shadowBlur = sf * 2.4;
    ctx.beginPath(); ctx.ellipse(ox, feetY, S(7), S(2), 0, 0, 7); ctx.fill(); ctx.restore(); }
  else { const shx = ox + A.flip * (A.dx || 0) * sf, sc = A.shScale == null ? 1 : A.shScale;
    ctx.save(); ctx.globalAlpha = 0.30 * Math.max(0.25, sc); ctx.fillStyle = '#000';
    ctx.beginPath(); ctx.ellipse(shx, feetY, S(7) * Math.max(0.3, sc), S(2.2) * Math.max(0.3, sc), 0, 0, 7); ctx.fill(); ctx.restore(); }

  // body transforms: aim flip, translate (incl. hover lift), lean/tumble about the feet
  if (A.flip < 0) { ctx.translate(ox, 0); ctx.scale(-1, 1); ctx.translate(-ox, 0); }
  ctx.translate((A.dx || 0) * sf, ((A.dy || 0) - lift) * sf);
  if (A.rot) { ctx.translate(ox, feetY); ctx.rotate(A.rot); ctx.translate(-ox, -feetY); }

  if (skin.glow) { ctx.shadowColor = skin.glowCol || trueK.J; ctx.shadowBlur = sf * 2.2; }
  if (skin.back) skin.back(H);
  if (hero.back) hero.back(H);

  // legs (articulated; skin colour, boot at the foot)
  const lk = A.pt.Lk || [0, -1], rk = A.pt.Rk || [0, -1];
  limb2(p, -3, 18, A.pt.Lf[0], A.pt.Lf[1], lk[0], lk[1], 3, skCol, boot);
  limb2(p, 3, 18, A.pt.Rf[0], A.pt.Rf[1], rk[0], rk[1], 3, skCol, boot);
  // shorts + torso + team collar (team colour on sleeves/collar keeps red vs blue readable under finishes)
  const override = !!(skin.jersey || skin.hue);
  p(-5, 17, 10, 4, override ? trueK.J : '#eef0f2'); p(-5, 20, 10, 1, override ? trueK.JS : '#c9cdd2');
  p(-5, 9, 10, 9, J); p(-5, 9, 2, 9, JS); p(3, 9, 2, 9, JS);
  if (facing === 'back') { p(-2, 11, 4, 5, wht); p(-1, 12, 2, 3, JS); } else p(-1, 11, 2, 5, wht);
  p(-5, 9, 10, override ? 2 : 1, trueK.J);
  // arms (articulated; team sleeve, skin hand)
  limb2(p, -6, 10, A.pt.Lh[0], A.pt.Lh[1], -0.6, 1, 3, trueK.J, skCol);
  limb2(p, 6, 10, A.pt.Rh[0], A.pt.Rh[1], 0.6, 1, 3, trueK.J, skCol);
  // head
  p(-5, 0, 10, 9, skCol);
  if (facing === 'back') { const cap = skCol === '#e7b072' ? hair : shade(skCol, 30);
    p(-5, 0, 10, 5, cap); p(-5, 0, 2, 9, shade(skCol, 20)); p(3, 0, 2, 9, shade(skCol, 20)); }
  else hero.head(H);

  if (skin.front) skin.front(H);
  if (skin.glow) ctx.shadowBlur = 0;
  if (skin.sparkle) { const spots = [[-4, 3], [4, 12], [-2, 19], [3, 6], [0, 15]];
    spots.forEach((s, i) => { const tw = Math.sin(time * 4 + i * 1.7); if (tw > 0.3) { ctx.globalAlpha = tw; p(s[0], s[1], 1, 1, '#fff6cf'); p(s[0], s[1] - 1, 1, 1, '#fff6cf'); } });
    ctx.globalAlpha = 1; }
  ctx.restore();
}
