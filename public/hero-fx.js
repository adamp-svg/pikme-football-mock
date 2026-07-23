// Hero-custom ambience — a per-hero pixel particle field drawn as the background
// of the wardrobe's central stage (behind the live hero preview). Purely visual;
// no sim, no hero sprite (the real preview canvas sits in front of this one).
//
//   const fx = mountHeroFx(canvas);
//   fx.setHero('striker'); fx.start();  ...  fx.stop();
//
// The effect set is the one locked in the design pitch: one ambience per hero.
// Each hero has 1–2 particle "layers" (e.g. cowboy = tumbleweed + drifting motes).

const PI = Math.PI;
// Logical (pixelated) canvas space — recomputed from the canvas box on resize().
let W = 120, H = 134, OX = 60, FEET = 120;

const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (a) => a[(Math.random() * a.length) | 0];
const rect = (ctx, x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(Math.round(x), Math.round(y), Math.max(1, w), Math.max(1, h)); };

/* --- effect builders (config captured in closure; state lives on each particle) --- */
function faller(o) { return {
  rate: o.rate, ground: o.ground,
  emit() { return { x: rnd(-8, W + 8), y: rnd(-24, -2), vy: rnd(o.vy[0], o.vy[1]),
    vx: o.vx ? rnd(o.vx[0] == null ? -o.vx : o.vx[0], o.vx[1] == null ? o.vx : o.vx[1]) : 0,
    ph: rnd(0, 6.28), sway: o.sway || 0, size: pick(o.sizes || [1]), col: pick(o.colors),
    fg: Math.random() < (o.fg ?? 0.35), streak: o.streak || 0 }; },
  update(p, dt) { p.y += p.vy * dt; p.x += p.vx * dt; if (p.sway) { p.ph += dt * (o.swf || 3); p.x += Math.sin(p.ph) * p.sway * dt; } return p.y < H + 8; },
  render(ctx, p) { if (o.leaf) rect(ctx, p.x, p.y, p.size, 1, p.col);
    else rect(ctx, p.x, p.y, p.size, p.streak ? p.size + p.streak : p.size, p.col); }
}; }
function storm(o) {
  const base = faller({ rate: o.rate, ground: o.ground, vy: o.vy, sizes: [1], streak: o.streak || 5,
    vx: o.vx, fg: o.fg ?? 0.4, colors: o.colors || ['#8fa6c4', '#adc0da', '#c8d6ea'] });
  base.overlay = function (ctx, dt, s) {
    if (s.t == null) { s.t = rnd(o.every[0], o.every[1]); s.flash = 0; s.bolts = null; }
    s.t -= dt;
    if (s.t <= 0) { s.t = rnd(o.every[0], o.every[1]); s.flash = o.flash || 0.22; s.bolts = [];
      const forks = o.forks || 1;
      for (let f = 0; f < forks; f++) { let x = rnd(W * 0.18, W * 0.82), y = -2; const bolt = [[x, y]];
        while (y < H) { y += rnd(10, 20); x += rnd(-14, 14); bolt.push([Math.max(4, Math.min(W - 4, x)), y]); }
        s.bolts.push(bolt); } }
    if (s.flash > 0) { ctx.fillStyle = `rgba(205,222,255,${s.flash * (o.flashMul || 0.6)})`; ctx.fillRect(0, 0, W, H);
      if (s.bolts) for (const bolt of s.bolts) for (const b of bolt) rect(ctx, b[0] - 1, b[1], 2, rnd(3, 6), '#eaf2ff');
      s.flash -= dt * 1.4; }
  };
  return base;
}
function tumble(o) { return {
  rate: o.rate, max: o.max || 2, ground: o.ground, event: true,   // a rolling singleton, not an ambient field — don't area-scale
  emit() { const R = rnd(o.size[0], o.size[1]); return { x: -R - 4, y: rnd(H - R - 12, H - R - 2), R, r: rnd(0, 6.28),
    vr: rnd(4, 7), vx: rnd(o.vx[0], o.vx[1]), dust: o.dust, fg: !!o.front }; },
  update(p, dt) { p.x += p.vx * dt; p.r += p.vr * dt; return p.x < W + p.R + 6; },
  render(ctx, p) { const c = '#9c7f4a', c2 = '#b89a5e', c3 = '#7a6236'; const R = p.R;
    for (let a = 0; a < 8; a++) { const ang = p.r + a * PI / 4; for (let d = 2; d <= R; d += 2) { rect(ctx, p.x + Math.cos(ang) * d, p.y + Math.sin(ang) * d, 1, d > R - 2 ? 2 : 1, a % 2 ? c : c2); } }
    for (let a = 0; a < 14; a++) { const ang = p.r * 0.6 + a * PI / 7; rect(ctx, p.x + Math.cos(ang) * R, p.y + Math.sin(ang) * R, 2, 2, c3); }
    if (p.dust) { for (let i = 0; i < 3; i++) rect(ctx, p.x - R - rnd(0, 7), p.y + rnd(-2, 5), 1, 1, '#c8a86a'); } }
}; }
function brownMotes(o) { return {
  rate: o.rate || 0.5, max: o.max || 4,
  emit() { return { x: -6, baseY: rnd(24, H - 40), t: rnd(0, 6.28), vx: rnd(o.vx[0], o.vx[1]),
    loopR: rnd(5, 10), loopS: rnd(2.4, 3.8), size: pick([1, 2]), col: pick(o.colors), fg: true }; },
  update(p, dt) { p.t += dt * p.loopS; p.x += p.vx * dt; return p.x < W + 10; },
  render(ctx, p) { const x = p.x + Math.cos(p.t) * p.loopR, y = p.baseY + Math.sin(p.t) * p.loopR; rect(ctx, x, y, p.size, p.size, p.col); }
}; }
function fireflies(o) { return {
  rate: 0, max: o.count, ground: o.ground,
  emit() { return { x: rnd(8, W - 8), y: rnd(14, H - 14), ph: rnd(0, 6.28), ph2: rnd(0, 6.28), fk: rnd(0, 6.28), col: pick(o.cols) }; },
  update(p, dt) { p.ph += dt * 1.7; p.ph2 += dt * 1.2; p.fk += dt * (o.flick || 10); p.x += Math.cos(p.ph) * 10 * dt; p.y += Math.sin(p.ph2) * 10 * dt;
    p.x = Math.max(4, Math.min(W - 4, p.x)); p.y = Math.max(10, Math.min(H - 8, p.y)); return true; },
  render(ctx, p) { const fl = Math.sin(p.fk) + Math.sin(p.fk * 2.7) * 0.5; const on = fl > rnd(-0.5, 0.3);
    const b = on ? (0.55 + 0.45 * Math.sin(p.ph * 2)) : 0.05; ctx.globalAlpha = Math.max(0.04, b); rect(ctx, p.x, p.y, 2, 2, p.col);
    if (b > 0.75) { ctx.globalAlpha = (b - 0.75) * 1.4; rect(ctx, p.x - 1, p.y, 4, 1, p.col); rect(ctx, p.x, p.y - 1, 1, 4, p.col); } ctx.globalAlpha = 1; }
}; }
function looper(o) { return {
  rate: o.rate || 0.5, max: o.max || 2,
  emit() { return { x: -8, y: rnd(28, H - 40), vx: rnd(o.vx[0], o.vx[1]), R: rnd(10, 16), enter: rnd(W * 0.25, W * 0.37),
    size: pick([3, 4]), col: pick(o.colors), fg: Math.random() < 0.5 }; },
  update(p, dt) { p.x += p.vx * dt; return p.x < W + 14; },
  render(ctx, p) { const exit = p.enter + W * 0.34; let q = (p.x - p.enter) / (exit - p.enter); q = q < 0 ? 0 : q > 1 ? 1 : q;
    const ang = q * PI * 2, lx = Math.sin(ang) * p.R, ly = -(1 - Math.cos(ang)) * p.R;
    rect(ctx, p.x + lx, p.y + ly, p.size, Math.max(1, p.size - 1), p.col); rect(ctx, p.x + lx + 1, p.y + ly - 1, 1, 1, p.col); }
}; }
function byteSpark(o) { return {
  rate: o.rate, ground: o.ground,
  emit() { return { x: (rnd(6, W - 8) | 0), y: rnd(8, H - 12), life: rnd(0.25, 0.6), age: 0,
    ch: Math.random() < 0.5 ? '0' : '1', col: pick(o.colors), fg: Math.random() < 0.4 }; },
  update(p, dt) { p.age += dt; return p.age < p.life; },
  render(ctx, p) { const k = p.age / p.life; ctx.globalAlpha = Math.max(0, Math.sin(k * PI)); const x = p.x, y = p.y, c = p.col;
    if (p.ch === '1') { rect(ctx, x + 1, y, 1, 5, c); rect(ctx, x, y, 2, 1, c); }
    else { rect(ctx, x, y, 3, 1, c); rect(ctx, x, y + 4, 3, 1, c); rect(ctx, x, y, 1, 5, c); rect(ctx, x + 2, y, 1, 5, c); }
    ctx.globalAlpha = 1; }
}; }
function starfield(o) { return {
  rate: 0, max: o.count,
  emit() { return { x: rnd(2, W - 2), y: rnd(2, H - 14), ph: rnd(0, 6.28), spd: rnd(o.spd ? o.spd[0] : 1.6, o.spd ? o.spd[1] : 4.2),
    size: o.small ? 1 : (Math.random() < 0.22 ? 2 : 1), col: pick(o.cols), drift: rnd(o.drift ? o.drift[0] : 1, o.drift ? o.drift[1] : 4), fg: Math.random() < 0.3 }; },
  update(p, dt) { p.ph += dt * p.spd; if (p.drift) { p.y += p.drift * dt; if (p.y > H - 2) { p.y = 2; p.x = rnd(2, W - 2); } } return true; },
  render(ctx, p) { const tw = Math.sin(p.ph) * 0.5 + 0.5; let a = 0.08 + tw * 0.92;
    if (o.flick && Math.random() < 0.3) a *= 0.12;
    ctx.globalAlpha = Math.max(0.02, a); rect(ctx, p.x, p.y, p.size, p.size, p.col);
    if (o.spark && tw > 0.88) { ctx.globalAlpha = (tw - 0.88) * 6; rect(ctx, p.x - 1, p.y, 3, 1, p.col); rect(ctx, p.x, p.y - 1, 1, 3, p.col); }
    ctx.globalAlpha = 1; }
}; }
const RUNE_G = [[[0, 0], [2, 0], [4, 0], [1, 1], [2, 2], [2, 3], [3, 3]], [[0, 0], [3, 0], [0, 1], [0, 2], [3, 2], [3, 3], [0, 4], [3, 4]],
  [[1, 0], [1, 1], [0, 2], [1, 2], [2, 2], [1, 3], [1, 4]], [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4], [2, 1], [3, 2], [2, 3]],
  [[0, 0], [2, 0], [1, 1], [1, 2], [0, 3], [2, 3], [1, 4]]];
function runes(o) { return {
  rate: o.rate || 2.2, max: o.max || 7, ground: o.ground,
  emit() { return { x: rnd(10, W - 16), y: rnd(16, H - 24), life: rnd(1.6, 2.8), age: 0, g: (rnd(0, 5) | 0), hue: rnd(0, 360), fg: Math.random() < 0.3 }; },
  update(p, dt) { p.age += dt; p.hue = (p.hue + dt * (o.shift || 130)) % 360; return p.age < p.life; },
  render(ctx, p) { const k = p.age / p.life, a = Math.sin(k * PI), shiny = 0.5 + 0.5 * Math.sin(p.age * 9);
    const col = `hsl(${p.hue | 0}, 95%, ${52 + shiny * 24}%)`; ctx.globalAlpha = a;
    for (const q of RUNE_G[p.g]) rect(ctx, p.x + q[0] * 2, p.y + q[1] * 2, 2, 2, col);
    if (shiny > 0.85) { ctx.globalAlpha = a * (shiny - 0.85) * 4; rect(ctx, p.x + 2, p.y - 2, 1, 1, '#ffffff'); } ctx.globalAlpha = 1; }
}; }
function drawParrot(ctx, x, y, s, ph, feathers) {
  const flap = Math.sin(ph), wy = Math.round(flap * 3);
  const R = '#e64a4f', B = '#2f7fe0', Y = '#f2c14e', G = '#3fb36a', K = '#141414';
  rect(ctx, x - s * 7, y + 1, 4, 1, B); rect(ctx, x - s * 8, y + 1, 1, 1, Y); rect(ctx, x - s * 8, y + 2, 1, 1, G);
  rect(ctx, x - 2, y, 5, 3, R);
  rect(ctx, x + s * 2, y - 1, 2, 2, R);
  rect(ctx, x + s * 4, y, 1, 1, Y);
  rect(ctx, x + s * 3, y - 1, 1, 1, K);
  rect(ctx, x - 1, y - 1 + wy, 3, 2, B);
  rect(ctx, x, y + 1 - Math.round(flap * 2), 2, 2, G);
  if (feathers && flap > 0.85) rect(ctx, x - s * 4, y + rnd(-1, 3), 1, 1, pick([R, B, Y]));
}
function parrots(o) { return {
  rate: o.rate || 0.3, max: o.max || 2, ground: o.ground, event: true,   // flyby event, not a density field
  emit() { const dir = Math.random() < 0.5 ? 1 : -1; return { dir, x: dir > 0 ? -16 : W + 16, y: rnd(16, Math.max(30, H * 0.45)), vx: dir * rnd(28, 44), ph: rnd(0, 6.28),
    pair: o.pair && Math.random() < 0.6, fg: o.behind ? false : (Math.random() < 0.5) }; },
  prime(parts) { const p = this.emit(); p.x = p.dir > 0 ? W * 0.35 : W * 0.65; parts.push(p); },  // one bird already on screen
  update(p, dt) { p.x += p.vx * dt; p.ph += dt * 11; return p.dir > 0 ? p.x < W + 18 : p.x > -18; },
  render(ctx, p) { drawParrot(ctx, p.x, p.y, p.dir, p.ph, o.feathers);
    if (p.pair) drawParrot(ctx, p.x - p.dir * 11, p.y + 8, p.dir, p.ph + 1.6, o.feathers); }
}; }

/* --- the locked set: one ambience per hero --- */
function heroEffects(hk) {
  switch (hk) {
    case 'striker': return { ground: ['#123a2a', '#081712'], effects: [faller({ rate: 30, fg: 0.4, vy: [26, 46], sizes: [1, 1, 2], sway: 5, swf: 4,
      colors: ['#e64a4f', '#3fe0d0', '#f2c14e', '#f5f5ef', '#7bd06a', '#e88aa0'] })] };
    case 'dwarf': return { ground: ['#1a2230', '#0b0f15'], effects: [storm({ rate: 40, fg: 0.4, vy: [150, 200], streak: 5, vx: 6, every: [2.5, 6], flash: 0.22, forks: 1 })] };
    case 'cowboy': return { ground: ['#3a2a18', '#160f08'], effects: [
      tumble({ rate: 0.45, max: 1, front: true, size: [10, 12], vx: [34, 44] }),
      brownMotes({ rate: 0.45, max: 4, vx: [16, 26], colors: ['#8a6a3a', '#9c7f4a', '#7a5a2f', '#b89a5e'] })] };
    case 'cat': return { ground: ['#221d10', '#0d0a04'], effects: [fireflies({ count: 12, flick: 16, cols: ['#ffe08a', '#fff2c0', '#ffcf6a'] })] };
    case 'ninja': return { ground: ['#141626', '#08090f'], effects: [
      faller({ rate: 50, leaf: true, fg: 0.4, vy: [14, 24], vx: [22, 42], sizes: [3, 3, 4], sway: 9, swf: 2.6,
        colors: ['#f4b8cc', '#e88aa0', '#ffd9e6', '#f4b8cc', '#e88aa0', '#ffc2d6', '#f8cede'] }),
      looper({ rate: 0.5, max: 2, vx: [24, 34], colors: ['#f4b8cc', '#e88aa0', '#ffd9e6'] })] };
    case 'robot': return { ground: ['#0c2226', '#050f0d'], effects: [byteSpark({ rate: 24, colors: ['#39e6d6', '#8ffff2', '#2ab5a8', '#c0fffa'] })] };
    case 'pirate': return { ground: ['#0c2028', '#06121a'], effects: [parrots({ rate: 0.3, max: 2, behind: true, feathers: true })] };
    case 'wizard': return { ground: ['#161038', '#09071c'], effects: [runes({ rate: 3, max: 9, shift: 240 })] };
    case 'alien': return { ground: ['#0c1e14', '#040a07'], effects: [starfield({ count: 54, small: true, flick: true, spark: true, drift: [0, 0], spd: [4, 9],
      cols: ['#ffffff', '#eef4ff', '#f2f6ff', '#e6eeff'] })] };
    default: return heroEffects('striker');
  }
}

export function mountHeroFx(canvas) {
  const ctx = canvas.getContext('2d');
  let ground = ['#123a2a', '#081712'];
  let layers = [];
  let raf = null, last = null;

  function resize() {
    const bw = canvas.clientWidth || canvas.offsetWidth || 220;
    const bh = canvas.clientHeight || canvas.offsetHeight || 300;
    const chunk = 3;                          // pixelation: 1 backing px ≈ 3 css px
    W = Math.max(48, Math.round(bw / chunk));
    H = Math.max(48, Math.round(bh / chunk));
    OX = W / 2; FEET = H;
    canvas.width = W; canvas.height = H;
  }
  const GROUND_ALPHA = 0.5;                         // translucent wash — the effect, not a solid panel, is the point
  function areaScale() { return Math.max(1, Math.min(6, (W * H) / (120 * 134))); }  // keep density ~constant full-screen
  function advance(dt) {
    const as = areaScale();
    for (const L of layers) { const fx = L.eff;
      const sc = fx.event ? 1 : as;                 // singleton/flyby effects (tumbleweed, parrots) don't area-scale
      if (fx.rate) { L.acc += fx.rate * sc * dt; const cap = fx.max || 9999;
        while (L.acc >= 1) { L.acc -= 1; if (L.parts.length < cap) L.parts.push(fx.emit()); } }
      else if (fx.max) { const target = Math.round(fx.max * sc); while (L.parts.length < target) L.parts.push(fx.emit()); }
      for (let i = L.parts.length - 1; i >= 0; i--) { if (!fx.update(L.parts[i], dt, L.s)) L.parts.splice(i, 1); }
    }
  }
  function setHero(hk) {
    const def = heroEffects(hk);
    ground = def.ground;
    layers = def.effects.map((eff) => ({ eff, parts: [], acc: 0, s: {} }));
    for (let i = 0; i < 50; i++) advance(0.05);      // warm to steady-state so fields fill the WHOLE screen, not just the top
    for (const L of layers) if (L.eff.prime) L.eff.prime(L.parts);  // guarantee extras (e.g. a bird already on screen)
  }
  function render(dt) {
    ctx.clearRect(0, 0, W, H);                       // transparent base → the ground wash below is translucent
    const g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, ground[0]); g.addColorStop(1, ground[1]);
    ctx.globalAlpha = GROUND_ALPHA; ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1;
    for (const L of layers) for (const p of L.parts) L.eff.render(ctx, p);
    for (const L of layers) if (L.eff.overlay) L.eff.overlay(ctx, dt, L.s);
  }
  function step(dt) { advance(dt); render(dt); }
  function frame(ts) {
    const dt = last == null ? 0.016 : Math.min(0.05, (ts - last) / 1000); last = ts;
    step(dt);
    raf = requestAnimationFrame(frame);
  }
  function start() { if (raf == null) { last = null; raf = requestAnimationFrame(frame); } }
  function stop() { if (raf != null) { cancelAnimationFrame(raf); raf = null; } }

  return { setHero, start, stop, resize };
}
