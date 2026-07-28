// SHIPPED DEFAULTS — does a brand-new player really start on the tuned pad?
//
// The layout, aim feel and audio levels in client.js (CTL_SHIPPED_LAYOUT, aimSens, aimSensPx,
// soundVol, musicUserVol) came from the user's own dev instance. A default is only worth anything if
// it reaches a player who has saved nothing, and only safe if it leaves alone a player who has.
//
// So two profiles, both real Chrome with real touch:
//   FRESH   nothing in localStorage  → the sticks must sit on the shipped fractions
//   SAVED   an `fbControls` of its own → must be untouched by the new default
//
// Both are checked INSIDE the training ground, because that is the only place the sticks exist
// (refreshSticks hides them off the pitch and on desktop, hence the touch emulation).
//
// Needs the server: PORT=3013 node server.js
// Run: node _defaults-verify.mjs        (BASE=https://… to check a deployed origin)
import { WebSocket } from 'ws';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { networkInterfaces } from 'node:os';

const PORT = process.env.PORT || 3013;
const lanIp = () => Object.values(networkInterfaces()).flat()
  .filter((n) => n && n.family === 'IPv4' && !n.internal).map((n) => n.address)[0];
const BASE = (process.env.BASE || `http://${lanIp() || '127.0.0.1'}:${PORT}`).replace(/\/$/, '');
const SHOTS = new URL('./_tu-shots/', import.meta.url).pathname;
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// The values shipped in client.js. Kept here as the test's own copy on purpose: a test that imports the
// thing it checks cannot notice the thing changing.
const SHIPPED = {
  move: { cx: 0.12585812356979406, cy: 0.72636815920398, size: 120 },
  aim: { cx: 0.8730726309151596, cy: 0.7168876775903686, size: 120 },
  bomb: { cx: 0.76893819405958, cy: 0.7204075880942454, size: 74.5455322265625 },
  wall: { cx: 0.827914214293849, cy: 0.5100672741377829, size: 54.89776611328125 },
};
const SHIPPED_AUDIO = { sfx: 0.35, music: 0 };

let failures = 0;
const check = (cond, msg) => { console.log((cond ? '  ✅ ' : '  ❌ ') + msg); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(SHOTS, { recursive: true });

async function browser(cdpPort, label) {
  const profile = `/tmp/defaults-${label}-${process.pid}`;
  rmSync(profile, { recursive: true, force: true });
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
    '--window-size=844,390', 'about:blank',
  ], { stdio: 'ignore' });
  let wsUrl = null;
  for (let i = 0; i < 60 && !wsUrl; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
      const pages = (await r.json()).filter((t) => t.type === 'page');
      if (pages.length) wsUrl = pages[0].webSocketDebuggerUrl;
    } catch { /* not up */ }
    if (!wsUrl) await sleep(250);
  }
  if (!wsUrl) throw new Error('Chrome never exposed a page target');
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.once('open', r));
  let id = 0; const pending = new Map(); const errors = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
    if (m.method === 'Runtime.exceptionThrown') { const d = m.params?.exceptionDetails; errors.push(d?.exception?.description || d?.text || 'unknown'); }
  });
  const cdp = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id; pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
    setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error(`CDP timeout: ${method}`)); } }, 20000);
  });
  await cdp('Page.enable'); await cdp('Runtime.enable');
  // IS_TOUCH gates the sticks entirely — without emulation there is nothing to measure.
  await cdp('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 2, mobile: true });
  await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await cdp('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });
  const api = {
    errors,
    close() { try { ws.close(); } catch {} try { chrome.kill(); } catch {} try { rmSync(profile, { recursive: true, force: true }); } catch {} },
    ev: async (e) => (await cdp('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result.value,
    go: (url) => cdp('Page.navigate', { url }),
    async shot(name) { const { data } = await cdp('Page.captureScreenshot', { format: 'png' }); writeFileSync(`${SHOTS}${name}.png`, Buffer.from(data, 'base64')); console.log(`     📸 _tu-shots/${name}.png`); },
    touch: (type, x, y) => cdp('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] }),
  };
  api.vis = (sel) => api.ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return 'missing';const s=getComputedStyle(e);return (s.display!=='none'&&s.visibility!=='hidden'&&e.getClientRects().length)?'shown':'hidden';})()`);
  api.waitFor = async (fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(200); } return null; };
  api.rect = (sel) => api.ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,w:r.width};})()`);
  api.settled = async (sel, tries = 40) => { let last = null; for (let i = 0; i < tries; i++) { const r = await api.rect(sel); if (r && last && Math.abs(r.x - last.x) < 0.5 && Math.abs(r.y - last.y) < 0.5) return r; last = r; await sleep(120); } return last; };
  api.tapAt = async (sel) => { const r = await api.settled(sel); if (!r) throw new Error(`no ${sel}`); await api.touch('touchStart', r.x, r.y); await sleep(40); await api.touch('touchEnd', r.x, r.y); await sleep(350); };
  // Into the training ground, the only screen where the sticks exist. The lobby tour is waved off first
  // (it gates the hub while it runs), the same way a returning player's device would have it off.
  api.toTraining = async () => {
    await api.ev("localStorage.setItem('fbHubTourSkipped','1');localStorage.setItem('fbTuDone','basics,combat,tricks');localStorage.setItem('fbTutorialDone','1')");
    await api.go(`${BASE}/`);
    await api.waitFor(async () => (await api.vis('#home')) === 'shown');
    // Wait for the stylesheets: until style.css lands there is no `.hidden { display: none }`, so every
    // screen reports itself visible and every rect is unscaled. Invisible on a dev server, long enough
    // to matter against a deployed origin.
    await api.waitFor(async () => (await api.ev("getComputedStyle(document.querySelector('#settings')).display === 'none'")) === true, 20000);
    // Retried, and each tap re-measured: the hub is a scaled stage that keeps re-laying out as art
    // arrives, so a tap can land where a button no longer is. On prod the first attempt missed and the
    // run then reported four bogus stick positions instead of "we never got there".
    for (let attempt = 1; attempt <= 3; attempt++) {
      if ((await api.vis('#train-choose')) !== 'shown') await api.tapAt('#training-btn');
      if (await api.waitFor(async () => (await api.vis('#train-choose')) === 'shown', 4000)) {
        await api.tapAt('#tc-ground');
        const up = await api.waitFor(async () => (await api.vis('#stickL')) === 'shown' && (await api.vis('#stickR')) === 'shown', 15000);
        if (up) return up;
      }
      console.log(`     (training-ground entry attempt ${attempt} did not land — retrying)`);
      await sleep(800);
    }
    // Say WHERE we actually are, so a failure here is never mistaken for a layout fault.
    const where = await api.ev("JSON.stringify({home:getComputedStyle(document.querySelector('#home')).display, game:getComputedStyle(document.querySelector('#game')).display, chooser:getComputedStyle(document.querySelector('#train-choose')).display})");
    console.log(`     ✖ never reached the training ground — ${where}`);
    return null;
  };
  return api;
}

// Where a control ACTUALLY is, in the same fractions the setting is written in.
const layoutOf = (api) => api.ev(`JSON.stringify((()=>{
  const out = {};
  for (const [k, sel] of [['move','#stickL'],['aim','#stickR'],['bomb','#special'],['wall','#build']]) {
    const e = document.querySelector(sel); if (!e) { out[k] = null; continue; }
    const r = e.getBoundingClientRect();
    out[k] = { cx: (r.x + r.width/2) / innerWidth, cy: (r.y + r.height/2) / innerHeight, size: r.width };
  }
  out._audio = { sfxSlider: +document.querySelector('#s-soundvol').value, musicSlider: +document.querySelector('#s-musicvol').value };
  return out;
})())`);

console.log(`\n🧪 SHIPPED DEFAULTS — ${BASE}/\n`);

// ---- FRESH PROFILE: the shipped layout is what a new player gets -----------------------------
console.log('▶ a brand-new player, nothing saved');
const fresh = await browser(9511, 'fresh');
try {
  const ready = await fresh.toTraining();
  check(!!ready, 'the sticks are on screen in the training ground');
  if (!ready) { console.log('     (skipping the layout checks — nothing to measure)'); failures++; }
  const got = ready ? JSON.parse(await layoutOf(fresh)) : null;
  for (const c of ready ? ['move', 'aim', 'bomb', 'wall'] : []) {
    const want = SHIPPED[c], have = got[c];
    // 6px of slack on position (the buttons carry borders/shadows the setting does not) and 2px on size.
    const dx = have ? Math.abs(have.cx - want.cx) * 844 : 999;
    const dy = have ? Math.abs(have.cy - want.cy) * 390 : 999;
    const ds = have ? Math.abs(have.size - want.size) : 999;
    check(dx < 6 && dy < 6 && ds < 3,
      `${c} sits where the setting says — Δx ${dx.toFixed(1)}px Δy ${dy.toFixed(1)}px Δsize ${ds.toFixed(1)}px`);
  }
  await fresh.shot('defaults-01-fresh-pad');
  // Audio: the sliders read the shipped numbers, and 0 music means the game opens silent.
  await fresh.tapAt('#pause-btn');
  await fresh.waitFor(async () => (await fresh.vis('#settings')) === 'shown', 6000);
  const a = JSON.parse(await layoutOf(fresh))._audio;
  check(Math.abs(a.sfxSlider - SHIPPED_AUDIO.sfx) < 0.03, `the SFX slider starts at ${SHIPPED_AUDIO.sfx} (${a.sfxSlider})`);
  check(Math.abs(a.musicSlider - SHIPPED_AUDIO.music) < 0.03, `and music starts at ${SHIPPED_AUDIO.music} — the game opens with no music (${a.musicSlider})`);
  check(fresh.errors.length === 0, `no uncaught JS errors${fresh.errors.length ? `\n     ${fresh.errors.slice(0, 3).join('\n     ')}` : ''}`);
} finally { fresh.close(); }

// ---- A PLAYER WHO ALREADY HAS A LAYOUT: leave it alone ---------------------------------------
// A default is not a migration. Someone who has been in the controls editor must keep what they set.
console.log('\n▶ a player who already customised their controls');
const saved = await browser(9512, 'saved');
try {
  // Seed a layout that is deliberately nothing like the shipped one, then load.
  await saved.go(`${BASE}/`);
  await saved.waitFor(async () => (await saved.ev("!!document.querySelector('#home')")) === true);
  const MINE = { move: { cx: 0.3, cy: 0.5, size: 100, locked: true }, aim: { cx: 0.6, cy: 0.5, size: 100, locked: true },
                 bomb: { cx: 0.5, cy: 0.3, size: 70, sens: 90, locked: true }, wall: { cx: 0.5, cy: 0.15, size: 60, sens: 90, locked: true } };
  await saved.ev(`localStorage.setItem('fbControls', ${JSON.stringify(JSON.stringify(MINE))})`);
  const ready2 = await saved.toTraining();
  check(!!ready2, 'the sticks are on screen');
  const got2 = JSON.parse(await layoutOf(saved));
  let kept = 0;
  for (const c of ['move', 'aim']) {
    const dx = Math.abs(got2[c].cx - MINE[c].cx) * 844;
    const dy = Math.abs(got2[c].cy - MINE[c].cy) * 390;
    if (dx < 6 && dy < 6) kept++;
    else console.log(`     ${c}: Δx ${dx.toFixed(1)} Δy ${dy.toFixed(1)} — moved!`);
  }
  check(kept === 2, 'their own layout survived — the new default did not overwrite it');
  check(saved.errors.length === 0, `no uncaught JS errors${saved.errors.length ? `\n     ${saved.errors.slice(0, 3).join('\n     ')}` : ''}`);
} finally { saved.close(); }

console.log(`\n${failures ? '❌' : '✅'} ${failures ? failures + ' FAILED' : 'ALL PASS'}\n`);
process.exit(failures ? 1 : 0);
