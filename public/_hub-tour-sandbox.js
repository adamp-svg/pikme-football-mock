// HUB TOUR LAB — the sandbox. Injected as the FIRST script in <body>, so it runs before the
// client.js module evaluates. Design: docs/superpowers/specs/2026-07-28-hub-tour-lab-design.md
//
// Everything here is done through inputs the APP already owns (window.SALTIZ_*) or through
// platform seams (Storage.prototype, WebSocket.prototype, setInterval). No client.js internal is
// touched, nothing is monkey-patched inside the game, and no shipped file is edited — which is why
// this whole lesson can exist without colliding with the other agents working this repo.
//
// It has four jobs:
//   1. hand the hub a 7-card dummy album, empty slots and the basic hero;
//   2. make sure nothing the lesson does can be written or sent anywhere;
//   3. stop the real tutorials from auto-launching over the lesson;
//   4. hold the carousel still.
(function labSandbox() {
  'use strict';

  // ---- 1. the album -------------------------------------------------------------------------
  // 6 common + 1 rare, exactly as asked. The numbers are not arbitrary: card art is fetched from
  // a remote bucket as `<rarity>/<n>.webp` (CARD_ART_BASE in client.js), so a number with no art
  // behind it shows a broken image and the "exact clone" claim dies on the first screenshot.
  // Every pair below was HEAD-checked: 200.
  //
  // `w` (worth) is what the carousel ranks by, and the RARE is given the top worth so the
  // mechanism itself brings it to the front — no hand-placed order, which is what the user asked
  // for. It matters that the rare is reachable: it is the only card whose drop on the hero does
  // anything visible (RARITY_SKIN.common === 'base', and the hero already IS base).
  const CARDS = [
    { r: 'rare',   n: 22, c: 1, w: 900000 },
    { r: 'common', n: 3,  c: 4, w: 420000 },
    { r: 'common', n: 8,  c: 2, w: 380000 },
    { r: 'common', n: 1,  c: 1, w: 330000 },
    { r: 'common', n: 5,  c: 3, w: 280000 },
    { r: 'common', n: 6,  c: 1, w: 240000 },
    { r: 'common', n: 11, c: 2, w: 190000 },
  ];
  window.SALTIZ_CARDS = CARDS;
  // Slots start EMPTY. Without this, effectiveLoadout() auto-fills the album's top three and
  // lesson 1 is already finished before the kid has touched anything — one of the four bugs that
  // sank the last attempt at teaching on the live hub.
  window.SALTIZ_LOADOUT = [null, null, null];
  // The basic hero, which is the whole point of lesson 2: base → gold is a visible change.
  window.SALTIZ_COSMETIC = 'striker:base';

  // ---- the lab's own record, read by the coach and by _hub-tour-verify.mjs -------------------
  const lab = {
    cards: CARDS,
    writes: [],        // every BLOCKED localStorage write: {k, v}
    sends: [],         // every BLOCKED socket message: the parsed object
    intervals: [],     // delays seen, so a changed carousel constant is visible instead of silent
    carouselFrozen: false,
    write(k, v) { this.writes.push({ k, v }); },
    lastWrite(k) { for (let i = this.writes.length - 1; i >= 0; i--) if (this.writes[i].k === k) return this.writes[i].v; return null; },
  };
  window.__lab = lab;

  // ---- 3. no tutorial may ambush the lesson --------------------------------------------------
  // Seeded BEFORE the write block goes up, on purpose: a fresh profile takes a brand-new player
  // straight into level 1, and «מרכז» auto-launches on the first hub visit. Either one would run
  // its own coach on top of this one. Separate origin from the user's real surfaces (:3013 vs
  // :3012), so this cannot touch their progress.
  try {
    localStorage.setItem('fbTuDone', 'basics,combat,tricks,mercaz');
    localStorage.setItem('fbTutorialDone', '1');
    localStorage.setItem('fbTuHubSkipped', '1');
  } catch { /* private mode — then nothing was going to auto-launch anyway */ }

  // ---- 2a. nothing persists ------------------------------------------------------------------
  // RECORD AND DROP, not just drop. saveLoadout / saveCosmetic reach postPrefs(), which the app
  // saves under the player's PHONE NUMBER — so a leak here is a leak into a real account. And the
  // record is not merely an assertion: it is the completion signal the coach latches on, so the
  // lesson needs neither a socket nor access to client.js's module-private state.
  //   setSlotCard        → saveLoadout   → attempts 'pikme-loadout'
  //   setHeroSkinByRarity→ saveCosmetic  → attempts 'pikme_cosmetic'
  const realSet = Storage.prototype.setItem;
  Storage.prototype.setItem = function (k, v) { lab.write(String(k), String(v)); };
  // Kept so the lab itself can seed if it ever needs to, without going through the block.
  lab._realSet = realSet;

  // ---- 2b. nothing reaches the server --------------------------------------------------------
  // The dummy album must never be described to the game server as this player's loadout or hero.
  // Only those two messages are dropped; join/ping/everything else passes, so the page behaves
  // normally otherwise.
  const DROP = new Set(['setLoadout', 'setCosmetic']);
  const realSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    if (typeof data === 'string' && data.charCodeAt(0) === 123 /* { */) {
      let msg = null;
      try { msg = JSON.parse(data); } catch { /* not ours */ }
      if (msg && DROP.has(msg.type)) { lab.sends.push(msg); return; }
    }
    return realSend.call(this, data);
  };

  // ---- 4. the carousel holds still -----------------------------------------------------------
  // startCarouselAuto() spins the coverflow every 2600ms (client.js). It moves the card the hand
  // is pointing at, and in the last attempt at a live-hub tour it COMPLETED A STEP with no input
  // at all. The timer is module-private, so it is filtered here by its delay.
  //
  // Keyed on the delay because that is the only handle a caller has from outside — and if someone
  // retunes that constant, `lab.carouselFrozen` stays false and the coach shouts about it in the
  // console instead of the kid quietly chasing a moving card.
  const CAROUSEL_MS = 2600;
  const realInterval = window.setInterval;
  window.setInterval = function (fn, ms, ...rest) {
    lab.intervals.push(ms);
    if (ms === CAROUSEL_MS) { lab.carouselFrozen = true; return 0; }
    return realInterval.call(window, fn, ms, ...rest);
  };
})();
