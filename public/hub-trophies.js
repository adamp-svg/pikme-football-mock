// HUB TROPHY LAYER — self-contained, additive. Renders the player's trophy count + tier badge in the
// hub, and the post-match reveal (including the case the XP reveal never had to handle: the number
// going DOWN).
//
// Design: summery/research-trophies/00-DECISION.md. Decision #3 — trophies are the HEADLINE number,
// the existing XP bar stays as a thin secondary bar underneath. Decision #2 — no relegation, so the
// tier badge never regresses.
//
// ⚠️ The SERVER owns every number. This module reads what the app injects and never computes a delta:
//     window.SALTIZ_TROPHIES = { trophies, trophyTier, delta, botCeiling, botLevel }
//   `delta` is what the last match awarded (may be negative, may be 0), echoed by
//   /football/record-match. Absent on old app builds → the layer stays hidden and the hub looks
//   exactly as it does today. That graceful degradation is deliberate: the app half only ships in a
//   new TestFlight build.
//
// Kept OUT of client.js on purpose: the hub is being reworked concurrently, and net-hud.js set the
// precedent for a self-contained HUD layer.

// RELATIVE import on purpose (same reason net-hud.js uses one): it resolves in BOTH environments —
// in the browser this module is served at /hub-trophies.js so `../shared/` → /shared/, and under Node
// it sits in public/ so `../shared/` → football-mock/shared/. An absolute '/shared/...' would work in
// the browser but make this file untestable in jsdom.
import { TIER_MIN, TIER_HE, tierIndexFromTrophies, tierProgress, nextTierAt, atBotCeiling, TROPHY_HE } from '../shared/trophies.js';

// Badge art per tier index — same 7 rungs as the server ladder
// (bronze/silver/gold/platinum/diamond/champion/legend).
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

// Trophy count currently drawn on the bar. Tracked so a reveal can animate FROM it, and so we can
// tell a real change from a repeated poll.
let shown = null;
let revealing = false;   // while true the reveal owns the DOM; the poll must not snap it
let pendingReveal = null; // a match ended -> celebrate (or mourn) the next change

export function trophyState() {
  const s = window.SALTIZ_TROPHIES;
  if (!s) return null;
  const trophies = Number(s.trophies);
  if (!Number.isFinite(trophies)) return null;
  return {
    trophies: Math.max(0, trophies),
    delta: Number.isFinite(Number(s.delta)) ? Number(s.delta) : 0,
    // botLevel must distinguish "level 0" from "not reported". Number(null) is 0 (and Number('') too),
    // so a null/blank level would otherwise read as difficulty 0 — whose ceiling is 60, which would
    // show the "raise the difficulty" nudge to literally every player. Check for absence first.
    botLevel: (s.botLevel == null || s.botLevel === '' || !Number.isFinite(Number(s.botLevel)))
      ? null
      : Number(s.botLevel),
  };
}

function host() { return document.getElementById('hub-trophies'); }

// Full render. Safe to call repeatedly; skipped while a reveal animates.
export function renderHubTrophies() {
  const el = host();
  if (!el) return;
  const st = trophyState();
  if (!st) { el.classList.add('hidden'); setHubFlag(false); return; } // old app build / not in app — invisible
  if (!revealing) shown = st.trophies;
  el.innerHTML = markup(st.trophies, st.botLevel);
  el.classList.remove('hidden');
  setHubFlag(true);
}

// `.hub.has-trophies` is what shifts the XP bar down to make room (see trophies.css). Only set once we
// actually have data, so an old app build keeps the original hub layout with no empty gap.
function setHubFlag(on) {
  const hub = document.querySelector('.hub');
  if (hub) hub.classList.toggle('has-trophies', !!on);
}

function markup(trophies, botLevel) {
  const idx = tierIndexFromTrophies(trophies);
  const art = TIER_ART[idx];
  const next = nextTierAt(trophies);
  const pct = (tierProgress(trophies) * 100).toFixed(1);
  // The count is forced LTR-isolated: a bare number inside an RTL run renders its sign on the wrong
  // side (a "-8" reads as "8-").
  return ''
    + '<div class="tr-badge" style="--c1:' + art.c1 + ';--c2:' + art.c2 + '">'
    +   '<span class="tr-ic">' + art.ic + '</span>'
    + '</div>'
    + '<div class="tr-main">'
    +   '<div class="tr-top">'
    +     '<span class="tr-count"><b>' + trophies + '</b> ' + TROPHY_HE + '</span>'
    +     '<span class="tr-tier">' + TIER_HE[idx] + '</span>'
    +   '</div>'
    +   '<div class="tr-bar"><b style="width:' + pct + '%"></b></div>'
    +   '<div class="tr-sub">' + subLine(trophies, next, botLevel) + '</div>'
    + '</div>';
}

const BOT_LEVEL_MAX = 11; // matches DIFFICULTY_LEVELS / the server's clamp

function subLine(trophies, next, botLevel) {
  // The bot-ceiling nudge is the whole point of the ceiling rule: without it a solo player just sees
  // their trophies stop moving and assumes the game is broken.
  if (botLevel != null && atBotCeiling(trophies, botLevel)) {
    // At the TOP difficulty there is no higher level to pick, so "raise the difficulty" would be a
    // dead end. Past 940 only human matches pay, and the copy has to say that instead.
    return botLevel >= BOT_LEVEL_MAX
      ? '<span class="tr-nudge">רק משחק מול שחקנים אמיתיים מעלה דרגה מכאן 👥</span>'
      : '<span class="tr-nudge">העלה את רמת הקושי כדי להמשיך לעלות 🔒</span>';
  }
  if (next == null) return '<span class="tr-max">הדרגה הגבוהה ביותר</span>';
  return '<span class="tr-next">עוד ' + Math.max(0, next - trophies) + ' לדרגה הבאה</span>';
}

// Arm the reveal: called when a match result has been posted, so the NEXT change to
// window.SALTIZ_TROPHIES animates instead of silently snapping.
export function armTrophyReveal() { pendingReveal = true; }

// Poll hook — call alongside the existing XP poll. Detects an injected change and reveals it.
export function pollTrophies() {
  const st = trophyState();
  if (!st || revealing) return;
  if (shown == null) { renderHubTrophies(); return; }
  if (st.trophies === shown) return;
  const from = shown, to = st.trophies;
  if (pendingReveal) { pendingReveal = false; playTrophyReveal(from, to, st.delta); }
  else renderHubTrophies(); // a change we weren't waiting for (e.g. first load) — just draw it
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

// The post-match moment. A GAIN pops the delta and counts up; a LOSS counts down with a muted,
// non-celebratory treatment — never confetti on a drop, and never a bare negative number with nothing
// positive beside it (the XP gain is shown by the existing XP reveal right after).
export function playTrophyReveal(from, to, delta) {
  const el = host();
  if (!el) { shown = to; return; }
  const down = to < from;
  const amount = delta || (to - from);
  if (REDUCE || from === to) { shown = to; renderHubTrophies(); flash(amount, down); return; }
  revealing = true;
  flash(amount, down);
  tween(down ? 700 : 1000, (p) => {
    const v = Math.round(from + (to - from) * p);
    shown = v;
    const st = trophyState();
    el.innerHTML = markup(v, st ? st.botLevel : null);
    el.classList.remove('hidden');
  }, () => {
    revealing = false;
    shown = to;
    renderHubTrophies();
    const el2 = host();
    if (el2 && !down) {
      // A tier promotion is the one moment worth a real celebration.
      if (tierIndexFromTrophies(to) > tierIndexFromTrophies(from)) el2.classList.add('tr-promote');
      setTimeout(() => el2.classList.remove('tr-promote'), 1400);
    }
  });
}

// The floating "+25 גביעים" / "−8 גביעים" chip above the bar.
function flash(amount, down) {
  const el = host();
  if (!el || !amount) return;
  const chip = document.createElement('div');
  chip.className = 'tr-flash' + (down ? ' tr-flash-down' : '');
  // LTR isolate so the sign stays on the left of the digits in the RTL layout.
  chip.innerHTML = '<span dir="ltr">' + (amount > 0 ? '+' : '−') + Math.abs(amount) + '</span> ' + TROPHY_HE;
  el.appendChild(chip);
  setTimeout(() => chip.remove(), down ? 1600 : 2000);
}

// Exposed for the localhost dev path (no app to inject SALTIZ_TROPHIES) so the reveal can be eyeballed
// without a device. Never called in the app.
export function devSimulate(from, delta) {
  window.SALTIZ_TROPHIES = { trophies: from, delta: 0, botLevel: 11 };
  shown = from;
  renderHubTrophies();
  armTrophyReveal();
  setTimeout(() => {
    window.SALTIZ_TROPHIES = { trophies: Math.max(0, from + delta), delta, botLevel: 11 };
    pollTrophies();
  }, 600);
}

export { TIER_MIN };
