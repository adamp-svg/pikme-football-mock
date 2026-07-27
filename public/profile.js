// THE PROFILE PAGE — pixels only.
//
// Self-contained on purpose: it injects its own markup and its own <style>, so wiring it up costs
// public/client.js a handful of one-line hooks and costs index.html / style.css almost nothing.
// Several agents edit those files concurrently (see CLAUDE.md), and on 2026-07-27 a one-line edit of
// client.js was overwritten mid-session — a small footprint in shared files is a feature here, not
// tidiness. Same precedent as public/net-hud.js.
//
// Every number is computed in shared/profile-stats.js (pure, unit-tested by test-profile-stats.mjs).
// This file must contain NO arithmetic beyond percentages for the bar widths: if you find yourself
// deriving a stat here, it belongs in the pure module where a test can see it.
//
// Design: docs/superpowers/specs/2026-07-27-player-profile-page-design.md
// NB: drawHero is INJECTED via opts.drawHero, not imported. public/heroes.js imports
// '/shared/cosmetics.js' — an absolute browser path node cannot resolve — so importing it here would
// make this file unloadable in test-profile-page.mjs. The relative '../shared/…' imports below
// resolve in BOTH the browser (public/ → /shared/) and node, which is the whole trick.
import { HERO_NAMES } from '../shared/cosmetics.js';
import { TIER_HE, RANK_TIERS as RANK_TIER_KEYS, TROPHIES_HE } from '../shared/rank.js';

// Pixel icons, from the repo's own set (ASSET_REGISTRY.json, all `live`). No emoji as structural
// icons — the game ships 96 of these, so there is never a reason.
const IC = (id) => `/assets/pixel-icon-system-01/transparent/${id}.png`;
const CARD_ART = 'https://pxsjmychuxwufcvqixgu.supabase.co/storage/v1/object/public/cards';
// The hub's own hero-preview kit colours, so the profile hero matches the one on the home screen.
const PREVIEW_KIT = { J: '#3f7bd6', JS: '#2c5aa6' };

// Ordered section ids. Exported so the test asserts coverage against THIS list instead of a second
// hardcoded copy that could drift.
export const PROFILE_SECTIONS = ['kpis', 'hero', 'album', 'record', 'career', 'bots', 'social'];

const CSS = `
.pf-wrap { position: absolute; inset: 0; display: flex; direction: rtl; gap: 10px; padding: 10px;
  box-sizing: border-box; font-family: "Arial Black", sans-serif; }
/* The FIXED pane. flex-basis in px (not %) so the hero never squeezes to nothing in landscape. */
.pf-side { flex: 0 0 176px; display: flex; flex-direction: column; align-items: center; gap: 4px;
  background: rgba(19,27,22,.94); border: 3px solid #46543f; box-shadow: 0 4px 0 #070b08;
  padding: 10px 8px; overflow: hidden; }
.pf-hero-canvas { width: 132px; height: 137px; image-rendering: pixelated; }
.pf-name { font: 900 13px "Arial Black", sans-serif; color: #f2ead0; max-width: 100%;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pf-badge { display: flex; align-items: center; gap: 5px; font: 900 11px "Arial Black", sans-serif;
  color: #e7dcae; background: #22301f; border: 2px solid #46543f; padding: 3px 7px; }
.pf-trophies { display: flex; align-items: center; gap: 5px; font: 900 12px "Arial Black", sans-serif;
  color: #ffd76a; font-variant-numeric: tabular-nums; }
.pf-board { font: 900 10px "Arial Black", sans-serif; color: #9fb0a2; font-variant-numeric: tabular-nums; }
.pf-side-slots { display: flex; gap: 4px; margin-top: 4px; }
/* THE ONLY SCROLL REGION on this page. A second one here is a bug: nested scrollers on a phone
   swallow the drag and the outer list stops responding. */
.pf-body { flex: 1; overflow-y: auto; overflow-x: hidden; display: flex; flex-direction: column;
  gap: 8px; padding-left: 2px; }
.pf-sec { background: rgba(19,27,22,.9); border: 3px solid #3f4d3a; box-shadow: 0 3px 0 #070b08; padding: 8px 9px; }
.pf-sec-head { display: flex; align-items: center; gap: 6px; margin-bottom: 7px; }
.pf-sec-title { font: 900 11px "Arial Black", sans-serif; color: #b9c7ab; }
.pf-ic { width: 15px; height: 15px; image-rendering: pixelated; flex: 0 0 auto; }
.pf-ic-lg { width: 22px; height: 22px; }
.pf-tiles { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
.pf-tile { background: #16211a; border: 2px solid #46543f; padding: 6px 4px; text-align: center; min-height: 46px; }
.pf-tile b { display: block; font: 900 15px "Arial Black", sans-serif; color: #f2ead0;
  font-variant-numeric: tabular-nums; }
.pf-tile small { display: block; font: 900 9px "Arial Black", sans-serif; color: #9fb0a2; margin-top: 2px; }
.pf-row { display: flex; align-items: center; gap: 6px; padding: 3px 0; font: 900 11px "Arial Black", sans-serif;
  color: #cfd8c4; }
.pf-row b { margin-inline-start: auto; color: #f2ead0; font-variant-numeric: tabular-nums; }
.pf-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 12px; }
.pf-cards { display: flex; gap: 5px; flex-wrap: wrap; }
.pf-card { width: 40px; height: 56px; background: #10171a; border: 2px solid #4a5a4c; overflow: hidden; }
.pf-card img { width: 100%; height: 100%; object-fit: cover; image-rendering: pixelated; }
.pf-card.eq { border-color: #ffd76a; }
.pf-slot { width: 34px; height: 34px; background: #10171a; border: 2px solid #4a5a4c; overflow: hidden; }
.pf-slot img { width: 100%; height: 100%; object-fit: cover; }
.pf-slot.empty { border-style: dashed; opacity: .55; }
/* W/L/D: sized by share, but every segment prints its own number and a text summary follows, so the
   meaning never depends on colour alone. */
.pf-bar { display: flex; height: 20px; border: 2px solid #46543f; background: #10171a; overflow: hidden; }
.pf-bar span { display: flex; align-items: center; justify-content: center; font: 900 10px "Arial Black", sans-serif;
  color: #0b120c; min-width: 0; }
.pf-bar .w { background: #6fdc8c; } .pf-bar .l { background: #e0556b; } .pf-bar .d { background: #b9c7ab; }
.pf-sum { margin-top: 5px; font: 900 10px "Arial Black", sans-serif; color: #9fb0a2; }
.pf-empty { font: 900 10px "Arial Black", sans-serif; color: #8b9a86; background: #131b16;
  border: 2px dashed #3f4d3a; padding: 7px 8px; text-align: center; }
.pf-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
/* 44px minimum touch target, per the UI checklist. */
.pf-back { min-width: 44px; min-height: 44px; cursor: pointer; background: #2c3a2e; color: #e7dcae;
  border: 2px solid #4a5a4c; font: 900 15px "Arial Black", sans-serif; }
.pf-title { font: 900 13px "Arial Black", sans-serif; color: #f2ead0; }
.pf-sec { animation: pf-in .22s ease-out both; }
@keyframes pf-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { .pf-sec { animation: none; } }
`;

let cssMounted = false;
function mountCss() {
  if (cssMounted || !document.head) return;
  const st = document.createElement('style');
  st.id = 'pf-css';
  st.textContent = CSS;
  document.head.appendChild(st);
  cssMounted = true;
}

const el = (tag, cls, text) => {
  const d = document.createElement(tag);
  if (cls) d.className = cls;
  if (text != null) d.textContent = String(text);
  return d;
};
function icon(id, cls = 'pf-ic') {
  const im = el('img', cls);
  im.src = IC(id);
  im.alt = '';                       // decorative: the label beside it carries the meaning
  im.loading = 'lazy';
  return im;
}
function section(id, title, iconId) {
  const s = el('div', 'pf-sec');
  s.dataset.section = id;
  const h = el('div', 'pf-sec-head');
  h.append(icon(iconId, 'pf-ic'), el('span', 'pf-sec-title', title));
  s.appendChild(h);
  return s;
}
const empty = (msg) => el('div', 'pf-empty', msg);
function row(label, value, iconId) {
  const r = el('div', 'pf-row');
  if (iconId) r.appendChild(icon(iconId));
  r.append(el('span', null, label), el('b', null, value));
  return r;
}
function cardTile(c, equipped) {
  const d = el('div', 'pf-card' + (equipped ? ' eq' : ''));
  const im = el('img');
  im.loading = 'lazy';
  im.alt = '';
  im.onerror = () => im.removeAttribute('src');   // same guard as paintFriendSlots
  im.src = `${CARD_ART}/${c.r}/${c.n}.webp`;
  d.appendChild(im);
  return d;
}
// Compact numbers, mirroring the hub's fmtCompact so the two screens agree.
function compact(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return (v / 1e6).toFixed(v >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(v >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'K';
  return String(v);
}

// The fixed pane: hero, name, rank badge, trophies, board position, equipped powers.
function sidePane(model, name, drawHero) {
  const side = el('div', 'pf-side');
  const cv = el('canvas', 'pf-hero-canvas');
  cv.width = 208; cv.height = 216;
  side.appendChild(cv);
  // jsdom (and a lost GPU context) return null here. Guard rather than throw: a stat page must not
  // depend on a canvas to show numbers.
  try {
    const g = cv.getContext && cv.getContext('2d');
    if (g && drawHero) drawHero(g, cv.width / 2, cv.height - 10, 3.3, 0.4, 0, 0.6, false, model.head.cosmetic, PREVIEW_KIT, 0);
  } catch { /* no 2d context — numbers still render */ }

  side.appendChild(el('div', 'pf-name', name || 'שחקן'));

  const tierIdx = Math.max(0, RANK_TIER_KEYS.indexOf(model.head.rankTier));
  const badge = el('div', 'pf-badge');
  badge.append(icon(`rank-${RANK_TIER_KEYS[tierIdx] || 'bronze'}`, 'pf-ic'),
    el('span', null, `${TIER_HE[tierIdx] || TIER_HE[0]} · ${model.head.rankPoints}`));
  side.appendChild(badge);

  const tro = el('div', 'pf-trophies');
  tro.append(icon('season-star', 'pf-ic'), el('span', null, `${compact(model.head.xp)} ${TROPHIES_HE}`));
  side.appendChild(tro);
  side.appendChild(el('div', 'pf-board', `רמה ${model.head.level}`));
  if (model.head.boardRank != null && model.head.boardTotal != null) {
    side.appendChild(el('div', 'pf-board', `מקום ${model.head.boardRank} מתוך ${model.head.boardTotal}`));
  }

  const slots = el('div', 'pf-side-slots');
  for (const s of model.album.loadout) {
    const d = el('div', 'pf-slot' + (s ? '' : ' empty'));
    if (s) { const im = el('img'); im.alt = ''; im.loading = 'lazy'; im.onerror = () => im.removeAttribute('src'); im.src = `${CARD_ART}/${s.r}/${s.n}.webp`; d.appendChild(im); }
    slots.appendChild(d);
  }
  side.appendChild(slots);
  return side;
}

/**
 * Render the whole page into `root`. Idempotent: call it again with a fuller model (e.g. once the
 * API answers) and it replaces the content rather than appending a second copy.
 */
export function renderProfile(root, model, opts = {}) {
  if (!root || !model) return;
  mountCss();
  root.innerHTML = '';
  const wrap = el('div', 'pf-wrap');
  wrap.dir = 'rtl';

  const body = el('div', 'pf-body');

  // head (back + title) sits INSIDE the scrolling body's sibling so the title never scrolls away
  const head = el('div', 'pf-head');
  const back = el('button', 'pf-back', '‹');
  back.setAttribute('aria-label', 'חזרה');
  if (opts.onBack) back.addEventListener('click', opts.onBack);
  head.append(back, el('span', 'pf-title', 'הפרופיל שלי'));

  // ── kpis ─────────────────────────────────────────────────────────────────────────────────────
  const kpis = section('kpis', 'מבט מהיר', 'rank');
  const tiles = el('div', 'pf-tiles');
  for (const t of model.kpis) {
    const tile = el('div', 'pf-tile');
    tile.append(el('b', null, typeof t.value === 'number' ? compact(t.value) : t.value),
      el('small', null, t.label));
    tiles.appendChild(tile);
  }
  kpis.appendChild(tiles);
  body.appendChild(kpis);

  // ── hero ─────────────────────────────────────────────────────────────────────────────────────
  const hero = section('hero', 'הגיבור שלי', 'hero-outfit');
  if (model.hero.hasData) {
    hero.appendChild(row('הגיבור המשוחק ביותר', `${HERO_NAMES[model.hero.key] || model.hero.key} · ${model.hero.plays}`, 'skin'));
  } else {
    hero.appendChild(empty('אין נתונים עדיין — שחקו משחק כדי לגלות את הגיבור שלכם'));
  }
  hero.appendChild(row('גיבורים שנפתחו', `${model.hero.unlocked}/${model.hero.total}`, 'lock'));
  body.appendChild(hero);

  // ── album ────────────────────────────────────────────────────────────────────────────────────
  const album = section('album', 'הקלפים החזקים שלי', 'cards');
  if (model.album.hasData) {
    const eq = new Set(model.album.loadout.filter(Boolean).map((s) => `${s.r}/${s.n}`));
    const strip = el('div', 'pf-cards');
    for (const c of model.album.top) strip.appendChild(cardTile(c, eq.has(`${c.r}/${c.n}`)));
    album.appendChild(strip);
    const g = el('div', 'pf-grid2');
    g.append(row('שווי', compact(model.album.worth), 'gem'),
      row('קלפים', model.album.owned, 'cards'),
      row('שונים', model.album.distinct, 'crate'));
    album.appendChild(g);
  } else {
    album.appendChild(empty('האלבום ייטען מהאפליקציה'));
  }
  body.appendChild(album);

  // ── record ───────────────────────────────────────────────────────────────────────────────────
  const rec = section('record', 'מאזן', 'champion-reaction');
  if (model.record.hasData) {
    const total = Math.max(1, model.record.wins + model.record.losses + model.record.draws);
    const bar = el('div', 'pf-bar');
    for (const [cls, n] of [['w', model.record.wins], ['l', model.record.losses], ['d', model.record.draws]]) {
      const sp = el('span', cls, n || '');
      sp.style.width = `${(n / total) * 100}%`;
      bar.appendChild(sp);
    }
    rec.appendChild(bar);
    rec.appendChild(el('div', 'pf-sum',
      `${model.record.wins} נצחונות · ${model.record.losses} הפסדים · ${model.record.draws} תיקו · ${model.record.rate}%`));
    const g = el('div', 'pf-grid2');
    g.append(row('נצחונות מול שחקנים', model.record.vsHuman, 'friends'),
      row('נצחונות מול בוטים', model.record.vsBot, 'bot'),
      row('רצף נוכחי', model.record.streak, 'speed'),
      row('רצף שיא', model.record.bestStreak, 'season-star'));
    rec.appendChild(g);
    rec.appendChild(row('שערים', `${model.goals.for} : ${model.goals.against}  (${model.goals.diff >= 0 ? '+' : ''}${model.goals.diff})`, 'goal-net'));
  } else {
    rec.appendChild(empty('אין משחקים עדיין'));
  }
  body.appendChild(rec);

  // ── career ───────────────────────────────────────────────────────────────────────────────────
  const car = section('career', 'הקריירה שלי', 'training');
  // Gated on the SAME signal as the record section: with no readable stats these would all be 0, and
  // "0 שערים" is a claim about the player, while the truth is only that we could not read it. Ten
  // qualified zeros are worse than one honest sentence.
  if (model.record.hasData) {
    const cg = el('div', 'pf-grid2');
    for (const c of model.career) {
      cg.appendChild(row(c.label, typeof c.value === 'number' ? `${compact(c.value)}${c.unit ? ' ' + c.unit : ''}` : c.value, c.icon));
    }
    car.appendChild(cg);
  } else {
    car.appendChild(empty('אין נתונים עדיין — הקריירה תתמלא אחרי המשחק הראשון'));
  }
  body.appendChild(car);

  // ── bots ─────────────────────────────────────────────────────────────────────────────────────
  const bots = section('bots', 'בוטים', 'bot');
  if (model.bots.hasData) bots.appendChild(row('הרמה הגבוהה ששיחקתי', `רמה ${model.bots.peakDisplay}`, 'rank'));
  else bots.appendChild(empty('אין נתונים עדיין — שחקו מול בוטים'));
  bots.appendChild(row('הרמה שלי כרגע', `רמה ${model.bots.currentDisplay}`, 'bot'));
  body.appendChild(bots);

  // ── social ───────────────────────────────────────────────────────────────────────────────────
  const soc = section('social', 'חברים ומגרשים', 'friends');
  const sg = el('div', 'pf-grid2');
  sg.append(row('חברים', model.social.friends, 'friends'), row('מגרשים שבניתי', model.social.arenas, 'field-library'));
  soc.appendChild(sg);
  body.appendChild(soc);

  const col = el('div', 'pf-col');
  col.style.cssText = 'flex:1; display:flex; flex-direction:column; min-width:0;';
  col.append(head, body);
  // side FIRST: the wrapper is dir=rtl, so the first child sits at the START edge (the right), which
  // is where the approved mockup puts the hero. Appending it second mirrors the whole page.
  wrap.append(sidePane(model, opts.name, opts.drawHero), col);
  root.appendChild(wrap);
}
