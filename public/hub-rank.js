// HUB RANK LAYER — self-contained, additive. Fills the existing tier badge OVER THE HERO (#hub-tier)
// with the player's RANK: tier icon, tier name, and a small meter inside the badge showing progress to
// the next tier. Also owns the post-match rank reveal — including the case the XP reveal never had to
// handle: the number going DOWN.
//
// ⚠️ TERMINOLOGY: "rank" (דרגה) is the losable ladder drawn here. The word גביעים/"trophies" belongs to
// the MONOTONIC xp-derived number in the top-row bar (renderHubXp in client.js). See shared/rank.js.
//
// ⚠️ The SERVER owns every number. This module reads what the app injects and never computes a delta:
//     window.SALTIZ_RANK = { rankPoints, rankTier, delta, botLevel }
//   `delta` is what the last match applied (may be negative, may be 0), echoed by
//   /football/record-match. Absent on old app builds → the badge falls back to the legacy XP-level
//   ladder that was there before, so the hub never looks broken.
//
// Before this, #hub-tier was driven by XP level (rankTierFromLevel in client.js). Rank is what a tier
// badge should actually mean, so it now drives it.

// RELATIVE import so this resolves in BOTH the browser (served at /hub-rank.js → ../shared/ = /shared/)
// and Node/jsdom (public/hub-rank.js → ../shared/ = football-mock/shared/).
import {
  TIER_MIN, TIER_HE, RANK_HE, tierIndexFromRank, tierProgress, nextTierAt, atBotCeiling, BOT_LEVEL_MAX,
} from '../shared/rank.js';

// Badge art per tier index — the 7 rungs of the server ladder.
const TIER_ART = [
  { ic: '🥉', c1: '#f2b578', c2: '#a6702f' }, // ברונזה
  { ic: '🥈', c1: '#e9eff4', c2: '#98a6b2' }, // כסף
  { ic: '🥇', c1: '#ffe27a', c2: '#e0a92a' }, // זהב
  { ic: '🛡️', c1: '#bfe7d6', c2: '#4f9e86' }, // פלטינה
  { ic: '💎', c1: '#96e6f7', c2: '#3f9fc0' }, // יהלום
  { ic: '🏆', c1: '#ffe9a0', c2: '#d99a1e' }, // אלוף
  { ic: '👑', c1: '#ffa8ba', c2: '#e0435f' }, // אגדה
];

const REDUCE = matchMedia('(prefers-reduced-motion: reduce)').matches;

let shown = null;         // rank points currently drawn
let revealing = false;    // while true the reveal owns the DOM; the poll must not snap it
let pendingReveal = false; // a match ended -> animate the next change instead of snapping

export function rankState() {
  const s = window.SALTIZ_RANK;
  if (!s) return null;
  const rankPoints = Number(s.rankPoints);
  if (!Number.isFinite(rankPoints)) return null;
  return {
    rankPoints: Math.max(0, rankPoints),
    delta: Number.isFinite(Number(s.delta)) ? Number(s.delta) : 0,
    // Must distinguish "level 0" from "not reported": Number(null) and Number('') are both 0, and
    // level 0's ceiling is 60 — which would show the "raise the difficulty" nudge to every player.
    botLevel: (s.botLevel == null || s.botLevel === '' || !Number.isFinite(Number(s.botLevel)))
      ? null
      : Number(s.botLevel),
  };
}

function badge() { return document.getElementById('hub-tier'); }

// Fills #hub-tier. Returns false when there's no rank data, so client.js can fall back to the legacy
// XP-level badge instead of leaving it blank.
export function renderHubRank() {
  const box = badge();
  if (!box) return false;
  const st = rankState();
  if (!st) return false;
  if (!revealing) shown = st.rankPoints;
  paint(box, st.rankPoints, st.botLevel);
  return true;
}

function paint(box, rankPoints, botLevel) {
  const idx = tierIndexFromRank(rankPoints);
  const art = TIER_ART[idx];
  const pct = (tierProgress(rankPoints) * 100).toFixed(1);
  box.style.setProperty('--c1', art.c1);
  box.style.setProperty('--c2', art.c2);
  box.classList.add('hub-tier-rank'); // opts into the rank styling in rank.css
  box.classList.toggle('hub-tier-capped', botLevel != null && atBotCeiling(rankPoints, botLevel));
  const lbl = document.getElementById('hub-tier-lbl');
  const fill = document.getElementById('hub-tier-fill');
  if (lbl) {
    // The badge is 50x42px, so it stays MINIMAL — icon + points only. The tier itself is read from the
    // icon and colour (the badge's existing design intent), and the Hebrew tier name lives in the
    // tooltip. The number is LTR-isolated: a bare number in an RTL run puts its sign on the wrong
    // side, so a "-8" would read as "8-".
    lbl.innerHTML = '<span class="px-ic">' + art.ic + '</span>'
      + '<span class="px-pts" dir="ltr">' + rankPoints + '</span>';
  }
  if (fill) fill.style.width = pct + '%';
  box.title = tooltip(rankPoints, botLevel);
}

// The badge is small, so the detail lives in the tooltip/aria rather than cluttering it.
function tooltip(rankPoints, botLevel) {
  const next = nextTierAt(rankPoints);
  const idx = tierIndexFromRank(rankPoints);
  const head = RANK_HE + ': ' + TIER_HE[idx] + ' · ' + rankPoints;
  if (botLevel != null && atBotCeiling(rankPoints, botLevel)) {
    return head + ' — ' + (botLevel >= BOT_LEVEL_MAX
      ? 'רק משחק מול שחקנים אמיתיים מעלה דרגה מכאן'
      : 'העלה את רמת הקושי כדי להמשיך לעלות');
  }
  if (next == null) return head + ' — הדרגה הגבוהה ביותר';
  return head + ' — עוד ' + Math.max(0, next - rankPoints) + ' לדרגה הבאה';
}

// Arm the reveal: called once a match result has been posted, so the NEXT injected change animates.
export function armRankReveal() { pendingReveal = true; }

// Poll hook — rank arrives on its own channel, so it needs its own check.
export function pollRank() {
  const st = rankState();
  if (!st || revealing) return;
  if (shown == null) { renderHubRank(); return; }
  if (st.rankPoints === shown) return;
  const from = shown, to = st.rankPoints;
  if (pendingReveal) { pendingReveal = false; playRankReveal(from, to, st.delta); }
  else renderHubRank();
}

function ease(p) { return 1 - Math.pow(1 - p, 3); }

function tween(dur, upd, done) {
  const t0 = performance.now();
  function frame(now) {
    const p = Math.min(1, (now - t0) / dur);
    upd(ease(p));
    if (p < 1) requestAnimationFrame(frame);
    else if (done) done();
  }
  requestAnimationFrame(frame);
}

// The post-match moment. A GAIN counts up; a LOSS counts down with a muted treatment — never confetti
// on a drop. Only a TIER PROMOTION gets a real celebration.
export function playRankReveal(from, to, delta) {
  const box = badge();
  if (!box) { shown = to; return; }
  const down = to < from;
  const amount = delta || (to - from);
  flash(box, amount, down);
  if (REDUCE || from === to) { shown = to; renderHubRank(); return; }
  revealing = true;
  const st = rankState();
  const lvl = st ? st.botLevel : null;
  tween(down ? 700 : 1000, (p) => {
    shown = Math.round(from + (to - from) * p);
    paint(box, shown, lvl);
  }, () => {
    revealing = false;
    shown = to;
    renderHubRank();
    if (!down && tierIndexFromRank(to) > tierIndexFromRank(from)) {
      box.classList.add('hub-tier-promote');
      setTimeout(() => box.classList.remove('hub-tier-promote'), 1400);
    }
  });
}

// Floating "+25 / −8 דרגה" chip beside the badge.
function flash(box, amount, down) {
  if (!amount) return; // nothing happened (e.g. a bot match at the ceiling) — so claim nothing
  const chip = document.createElement('div');
  chip.className = 'rk-flash' + (down ? ' rk-flash-down' : '');
  chip.innerHTML = '<span dir="ltr">' + (amount > 0 ? '+' : '−') + Math.abs(amount) + '</span>';
  box.appendChild(chip);
  setTimeout(() => chip.remove(), down ? 1600 : 2000);
}

// LOCALHOST dev path (no app to inject SALTIZ_RANK) so the reveal can be eyeballed without a device.
export function devSimulate(from, delta) {
  window.SALTIZ_RANK = { rankPoints: from, delta: 0, botLevel: 11 };
  shown = from;
  renderHubRank();
  armRankReveal();
  setTimeout(() => {
    window.SALTIZ_RANK = { rankPoints: Math.max(0, from + delta), delta, botLevel: 11 };
    pollRank();
  }, 600);
}

export { TIER_MIN };
