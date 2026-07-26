// HUB RANK LAYER — self-contained, additive. Fills the existing tier badge OVER THE HERO (#hub-tier)
// with the player's RANK: tier icon, tier name, and a small meter inside the badge showing progress to
// the next tier. Also owns the post-match rank reveal — including the two cases the XP reveal never had
// to handle: the number going DOWN, and the player having no rank at all.
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
// ⚠️ THE INJECTED SHAPE IS NOT OURS. window.SALTIZ_RANK is written by the iOS WebView host, owned by
// another dev and OFF our release train, and `football.jsx` relays a FIXED literal field list — a NEW
// field is hard-blocked. So every field below TIER_MIN is read as OPTIONAL, and the states this module
// draws are inferred from what is already in the shape wherever that is possible. The three optional
// reads and what each buys:
//   rankedMatches  → exact לא מדורג / placements. Absent: inferred from rankPoints === 0.
//   rankPointsRaw  → "the ledger dropped but the badge held". Absent: a floored loss looks like nothing.
//   g / meetRate   → the post-match gap chip. Absent: the chip is withheld rather than guessed.
// The one field worth asking for is `rankedMatches` (see the report / spec §4 S3).
//
// THREE STATES, ONE 50×42px BOX. Visual hierarchy, deliberately not three equal treatments:
//   1. RANKED         tier icon + colour = identity · points = the ledger · 4px meter = progress.
//   2. לא מדורג        the same box with identity and ledger REMOVED: greyscale dashed frame, a dashed
//                     pixel shield instead of a medal, an empty dashed meter with no fill. It is the
//                     LOWEST-contrast state on the hub on purpose — ~87% of the base lives in it and it
//                     must not shout. (spec §4)
//   3. pays-no-rank   full tier identity KEPT (you still are זהב); only the PROGRESS affordance is
//                     suspended — hatched meter + a corner 🔒. Exactly the thing that is suspended is
//                     the thing that changes.
//
// Before this, #hub-tier was driven by XP level (rankTierFromLevel in client.js). Rank is what a tier
// badge should actually mean, so it now drives it.

// RELATIVE import so this resolves in BOTH the browser (served at /hub-rank.js → ../shared/ = /shared/)
// and Node/jsdom (public/hub-rank.js → ../shared/ = football-mock/shared/).
import {
  TIER_MIN, TIER_HE, RANK_HE, UPSET_G_CLAMP,
  tierIndexFromRank, tierNameHe, nextTierAt, rankBadge, meetRate as meetRateFor,
} from '../shared/rank.js';
// The RANKED MODE rule: which modes pay rank, and the לא מדורג discriminator + its Hebrew copy. Imported
// rather than re-derived — this module used to own its own copy of both, and "unranked" is a word that
// must be identical on the badge, the leaderboard row and the post-match screen.
import {
  RANK_UNRANKED_HE, RANKED_PLACEMENTS, RANKED_UNRANKED_SUB_HE,
  isUnranked, inPlacements, placementsLeft, placementLabelHe, rankLockedForMode,
} from '../shared/ranked.js';

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

// UNRANKED art — spec §4 verbatim. Greyscale, so it cannot be mistaken for a rung of the ladder; the
// dash is what says "not yet", and it is drawn (CSS) rather than emoji: ❔ reads as "mystery reward"
// and 🥉 is a medal the player has not earned.
const UNRANKED_ART = { c1: '#d4dae0', c2: '#8a939c' };
// Re-exported, NOT redefined: shared/ranked.js is the one owner of both.
export const UNRANKED_HE = RANK_UNRANKED_HE;
export const PLACEMENTS = RANKED_PLACEMENTS;

// ── THE GAP CHIP (spec §1) ───────────────────────────────────────────────────────────────────────
// "Ship the chip or don't ship the table." The same win pays +4 … +105 depending on the tier gap, and
// an unexplained 26x spread reads as randomness — the #1 complaint in 05-psychology. These are the
// Hebrew labels and the ×vs-even-win column from the spec's own table, index = g + UPSET_G_CLAMP.
const GAP_COUNT = [4, 3, 2, null, null, null, 2, 3, 4];
const GAP_WORD = [
  'דרגות מתחתיך', 'דרגות מתחתיך', 'דרגות מתחתיך', 'דרגה מתחתיך',
  'דרגה שווה',
  'דרגה מעליך', 'דרגות מעליך', 'דרגות מעליך', 'דרגות מעליך',
];
const GAP_MULT = [0.16, 0.24, 0.36, 0.60, 1.00, 1.80, 2.60, 3.40, 4.20];
const MEET_HE = 'יריב חוזר';
const HELD_HE = 'הדרגה נשמרת';

const REDUCE = matchMedia('(prefers-reduced-motion: reduce)').matches;

let shown = null;          // rank points currently drawn
let shownUnranked = false; // whether the badge currently draws the לא מדורג state
let revealing = false;     // while true the reveal owns the DOM; the poll must not snap it
let pendingReveal = false; // a match ended -> animate the next change instead of snapping

// "Can the mode I am in move my rank?" — the honest replacement for the deleted `atBotCeiling`, which
// decayed into an unconditional `true` and latched a 🔒 onto every badge the app injected a botLevel for.
// The answer is a property of the MODE, so the RULE lives in shared/ranked.js (`rankLockedForMode`: only
// a mode we can NAME as unranked earns the lock; an unknown mode paints nothing). This module owns the
// CONSUMER side: one entry point that whoever knows the current mode calls.
//
// Nothing calls it yet, so the default is null (UNKNOWN → no lock) and today's badge is unchanged.
//
// ⚠️ DO NOT WIRE IT TO A LIVE MODE YET, and the earlier comment here had this backwards. It is not true
// that "no live mode pays rank": pikme-server's record-match settles EVERY human match in EVERY mode at
// the g = 0 row (+25 / −20 / +2) because its `isRanked` is hard-false until S7. So calling
// `setRankMode('quick')` today would paint 🔒 + "המצב הזה לא מזיז דרגה" on a mode that DOES move rank —
// the atBotCeiling lie in mirror image, and this time in the copy as well as the pixels. The correct
// wiring point is the ranked queue (S7), in the same commit that makes the gate real; the call itself is
// one line from wherever `roomJoined.mode` is handled.
let rankMode = null;
export function setRankMode(mode) {
  rankMode = (typeof mode === 'string' && mode) ? mode : null;
  if (!revealing) renderHubRank();
  return rankMode;
}
export function rankModeState() { return rankMode; }
function modeLocked(injectedMode) {
  return rankLockedForMode(rankMode || injectedMode || '');
}

function intOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

export function rankState() {
  const s = window.SALTIZ_RANK;
  if (!s) return null;

  const tierRaw = typeof s.rankTier === 'string' ? s.rankTier.trim().toLowerCase() : '';
  // `unranked` on the EXISTING rankTier field is the cheap path: footballPublicStats learns the value
  // (spec §4), the app already relays rankTier, and no new injected field is needed.
  const tierSaysUnranked = tierRaw === 'unranked' || tierRaw === 'unrated' || tierRaw === 'none';
  const rankKnownFalse = s.rankKnown === false;   // token minted with no FootballStats doc (spec S4)
  const rankedMatches = intOrNull(s.rankedMatches);

  const rpNum = Number(s.rankPoints);
  const rpOk = Number.isFinite(rpNum);
  // Garbage with NO unranked signal is "we were not told", not rank 0 — return null so client.js keeps
  // the legacy XP badge rather than painting a confident wrong state. Garbage WITH an unranked signal is
  // still fully renderable: there is no number to show in that state anyway.
  if (!rpOk && !(tierSaysUnranked || rankKnownFalse || rankedMatches === 0)) return null;
  const injected = Math.max(0, rpOk ? rpNum : 0);

  const rawNum = Number(s.rankPointsRaw);
  const rankPointsRaw = Number.isFinite(rawNum) ? Math.max(0, rawNum) : null;

  // STEPS 8 + 9, read (never re-derived) through shared/rank.js so the hub cannot disagree with the
  // server about which tier a player is.
  //   • rankFloor INJECTED → rankBadge() reproduces step 8 (max(raw, TIER_MIN[floor])) and step 9 (the
  //     badge is min(pointsTier, floor)), and the meter fills inside the BADGE tier, so gold points on a
  //     silver badge read as a FULL silver meter — promotion pending — not 34% through gold.
  //   • rankFloor ABSENT (today) → `rankPoints` as injected is ALREADY the server's step-8 display, so
  //     only it is passed. Handing rankBadge a bare raw with no floor would UNDO step 8: a 1400 יהלום
  //     whose ledger sits at 1374 would be re-floored to 1374 and the badge would drop to פלטינה — the
  //     exact thing step 8 exists to prevent.
  //   • rankPeak, when it comes with the floor, BOUNDS it (shared/rank.js floorEvidenceIndex). A stored
  //     floor alone was enough to repaint אגדה here off an empty ledger — footballPublicStats ships
  //     rankFloor, so an account whose points were wiped underneath its badge did exactly that, with no
  //     match involved. Absent (which is every injection today) there is no bound and nothing changes.
  const floorKnown = Number.isFinite(Number(s.rankFloor));
  const bdg = floorKnown
    ? rankBadge({
      rankPointsRaw, rankPoints: injected, rankFloor: s.rankFloor, floorProgress: s.floorProgress,
      ...(Number.isFinite(Number(s.rankPeak)) ? { rankPeak: Number(s.rankPeak) } : {}),
    })
    : rankBadge({ rankPoints: injected });
  const rankPoints = bdg.points;
  // How far the honest ledger has fallen UNDER the sticky badge. Without the floor we can still see it
  // whenever raw is injected alongside the display.
  const debt = floorKnown ? bdg.debt : (rankPointsRaw != null ? Math.max(0, rankPoints - rankPointsRaw) : 0);

  // Spec §4 discriminator, owned by shared/ranked.js: unranked = no ranked matches AND no points. BOTH
  // halves matter. Dropping the points half de-badges every legacy account seedRankFromXp already placed
  // (a 640-point veteran has 0 ranked matches and must still read זהב — "nobody is reduced"); dropping
  // the matches half calls a player who ground their ledger down to 0 "unranked", which is also a lie.
  // rankedMatches is not injected today, so rankPoints === 0 carries the test alone — see the header.
  // ⚠️ AND THAT MAKES THIS STATE SHORT-LIVED, not the ~87%-of-the-base state §4 sizes: every human match
  // in every mode currently pays the g = 0 row, so ONE quick-match win or draw ends לא מדורג and paints a
  // real ברונזה badge for a player who has never seen a ranked event. Not fixable here — the predicate is
  // right and both halves are load-bearing (see above); it becomes true when the S7 isRanked gate lands.
  const stats = { rankedMatches, rankPoints, rankPointsRaw };
  const placing = inPlacements(stats);
  // ONE dashed visual state, two labels: never placed, or placing. `inPlacements` needs at least one
  // ranked match, so a legacy seed is never told it is unplaced.
  const unranked = tierSaysUnranked || rankKnownFalse || isUnranked(stats) || placing;

  const gNum = Number(s.g);
  const gOk = Number.isFinite(gNum);
  // gKnown is the route's own flag (detail.gKnown). Absent, a NON-ZERO g is self-evidently measured,
  // while a zero g is exactly what the route reports when no opponent tier reached it — so a bare 0 is
  // treated as unknown and the chip stays silent instead of inventing "דרגה שווה".
  const gKnown = s.gKnown === true ? gOk : (s.gKnown === false ? false : (gOk && gNum !== 0));

  let meetRate = null;
  const mr = Number(s.meetRate);
  if (Number.isFinite(mr)) meetRate = Math.max(0, Math.min(1, mr));
  // 1-based "this is my Nth meeting with them" → the shared MEET_RATES map. meetings 0/absent is
  // "we don't know who that was" and never tapers.
  else if (Number.isFinite(Number(s.meetings)) && Number(s.meetings) >= 1) meetRate = meetRateFor(s.meetings);

  return {
    rankPoints,
    rankPointsRaw,
    debt,
    // The sticky badge floor is holding the number up: the ledger moved and the badge did not. Saying so
    // is what stops a thrown loss from LOOKING free, which is the whole point of the split ledger.
    floorHeld: debt > 0,
    tierIdx: bdg.tierIdx,
    tierHe: bdg.tierHe,
    progress: bdg.progress,
    promoting: bdg.promoting,
    promoDone: bdg.promoDone,
    promoNeeded: bdg.promoNeeded,
    // The tier being confirmed. `promoting` means the points already cleared TIER_MIN[floor + 1] and
    // bdg.tierIdx is pinned to the floor, so the target is exactly one rung up.
    promoToHe: bdg.promoting ? TIER_HE[Math.min(bdg.tierIdx + 1, TIER_HE.length - 1)] : null,
    unranked,
    placing,
    rankedMatches,
    placementsLeft: rankedMatches == null ? null : placementsLeft(stats),
    delta: Number.isFinite(Number(s.delta)) ? Number(s.delta) : 0,
    g: gOk ? gNum : null,
    gKnown,
    meetRate,
    // Must distinguish "level 0" from "not reported": Number(null) and Number('') are both 0, and
    // level 0's ceiling is 60 — which would show the "raise the difficulty" nudge to every player.
    botLevel: (s.botLevel == null || s.botLevel === '' || !Number.isFinite(Number(s.botLevel)))
      ? null
      : Number(s.botLevel),
    // "This mode cannot move your rank". `s.mode` is read as an optional carrier for whoever writes
    // SALTIZ_RANK itself (the ranked settle does — spec §7); setRankMode() wins.
    locked: modeLocked(s.mode),
  };
}

function badge() { return document.getElementById('hub-tier'); }

export function isRevealing() { return revealing; }

// Fills #hub-tier. Returns false when there's no rank data, so client.js can fall back to the legacy
// XP-level badge instead of leaving it blank.
export function renderHubRank() {
  const box = badge();
  if (!box) return false;
  const st = rankState();
  if (!st) {
    // Clear OUR classes here. client.js's XP fallback only removes hub-tier-rank/hub-tier-capped (the
    // two it knew about when it was written), so a dashed unranked badge would otherwise survive into
    // the legacy render and paint a greyscale frame around an XP level.
    box.classList.remove('hub-tier-rank', 'hub-tier-unranked', 'hub-tier-capped');
    return false;
  }
  if (!revealing) { shown = st.rankPoints; shownUnranked = st.unranked; }
  if (st.unranked) paintUnranked(box, st);
  else paint(box, st.rankPoints, st.botLevel, st);
  return true;
}

function paint(box, rankPoints, botLevel, st) {
  // The BADGE tier, not the points tier: with a rankFloor injected these differ, and step 9's whole
  // point is that one bought +105 upset lifts the points without painting the next rung.
  const idx = st && st.tierIdx != null && rankPoints === st.rankPoints
    ? st.tierIdx
    : tierIndexFromRank(rankPoints);
  const art = TIER_ART[idx];
  // During the count-up tween `rankPoints` is an intermediate value, so the meter is derived from it
  // rather than from the settled st.progress.
  const pct = (progressFor(rankPoints, idx) * 100).toFixed(1);
  box.style.setProperty('--c1', art.c1);
  box.style.setProperty('--c2', art.c2);
  box.classList.add('hub-tier-rank'); // opts into the rank styling in rank.css
  box.classList.remove('hub-tier-unranked');
  // The 'capped' state is back, but driven by shared/ranked.js's rankLockedForMode, which paints nothing
  // for a mode it cannot name. It used to be `botLevel != null && atBotCeiling(...)`, and once
  // atBotCeiling became an unconditional true (humans-only rank), that latched a hatched meter and a 🔒
  // onto every badge the app injected a botLevel for.
  box.classList.toggle('hub-tier-capped', !!(st && st.locked));
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
  setTip(box, tooltip(rankPoints, botLevel, st));
}

// The meter fills inside the tier the BADGE shows. Delegated to shared/rank.js when the settled state is
// what we are drawing; during a tween the intermediate number needs the same formula applied live.
function progressFor(rankPoints, tierIdx) {
  const lo = TIER_MIN[tierIdx];
  const next = tierIdx >= TIER_MIN.length - 1 ? null : TIER_MIN[tierIdx + 1];
  if (next == null) return 1;
  return Math.max(0, Math.min(1, (Math.max(0, rankPoints) - lo) / (next - lo)));
}

// STATE 2: לא מדורג. Same box, same idiom, identity and ledger removed.
function paintUnranked(box, st) {
  box.style.setProperty('--c1', UNRANKED_ART.c1);
  box.style.setProperty('--c2', UNRANKED_ART.c2);
  box.classList.add('hub-tier-rank', 'hub-tier-unranked');
  // Never stack the 🔒 on the dashed state. "You have no rank" already answers "why is nothing moving",
  // and two overlays on a 50×42px box is the noise this design is trying to avoid.
  box.classList.remove('hub-tier-capped');
  const lbl = document.getElementById('hub-tier-lbl');
  const fill = document.getElementById('hub-tier-fill');
  if (lbl) {
    // The TEXT comes from shared/ranked.js; isolating its digits is explicitly the caller's job (its own
    // comment points here). `דירוג 2/3` renders as `דירוג 3/2` in an RTL run without dir="ltr".
    const label = st.placing
      ? placementLabelHe(st.rankedMatches).replace(/([\d/]+)/, '<span dir="ltr">$1</span>')
      : UNRANKED_HE;
    lbl.innerHTML = '<span class="px-unr" aria-hidden="true"></span>'
      + '<span class="px-unr-t">' + label + '</span>';
  }
  // NO FILL. tierProgress(0) returns 0 and a 0%-wide SOLID meter is pixel-identical to "ברונזה, with no
  // progress" — the exact confusion this state exists to remove. rank.css makes the TRACK dashed and
  // hides <b> outright, so the strip reads as "no ladder yet" rather than "ladder, empty". (spec §4)
  if (fill) fill.style.width = '0%';
  setTip(box, unrankedTooltip(st));
}

function setTip(box, text) {
  box.title = text;
  box.setAttribute('aria-label', text);   // the badge is 50×42px; the detail has to be reachable
}

// The badge is small, so the detail lives in the tooltip/aria rather than cluttering it.
function tooltip(rankPoints, botLevel, st) {
  const next = nextTierAt(rankPoints);
  const tierHe = (st && st.tierHe && rankPoints === st.rankPoints) ? st.tierHe : tierNameHe(rankPoints);
  let head = RANK_HE + ': ' + tierHe + ' · ' + rankPoints;
  // Step 8 made visible: the ledger fell, the badge did not. Saying so is what stops "my rank froze" bug
  // reports, and it is the honest version of "no relegation".
  if (st && st.floorHeld) head += ' · הדרגה מוגנת';
  // A mode that pays no rank is the most specific thing we can say, so it wins.
  if (st && st.locked) return head + ' — המצב הזה לא מזיז דרגה';
  // Step 9 made visible, and it REPLACES the points countdown rather than joining it. A player at 604
  // with a כסף badge has already cleared זהב on points, so "עוד 296 לדרגה הבאה" (which counts toward
  // פלטינה) is nonsense to them: what they actually need is confirmations, not points.
  if (st && st.promoting) {
    return head + ' — ' + (st.promoNeeded === 1
      ? 'עוד משחק אחד לאישור ' + st.promoToHe
      : 'עוד ' + st.promoNeeded + ' משחקים לאישור ' + st.promoToHe);
  }
  // 2026-07-26: rank is HUMANS-ONLY, so any bot-populated mode leaves it frozen — at every difficulty.
  // The retired branch ("raise the difficulty to keep climbing") must not return: difficulty is no
  // longer a rank lever, so it would send the player somewhere that still pays nothing.
  if (botLevel != null) {
    return head + ' — רק משחק מול שחקנים אמיתיים מעלה דרגה';
  }
  if (next == null) return head + ' — הדרגה הגבוהה ביותר';
  return head + ' — עוד ' + Math.max(0, next - rankPoints) + ' לדרגה הבאה';
}

// The unranked tooltip's whole job is to say HOW to get a rank. A dead-end "you have no rank" is worse
// than the bronze lie it replaces.
function unrankedTooltip(st) {
  const head = RANK_HE + ': ' + UNRANKED_HE;
  const left = st.placementsLeft;
  if (st.placing && left != null && left > 0) {
    return head + ' — ' + (left === 1
      ? 'עוד משחק דירוג אחד כדי לקבל דרגה'
      : 'עוד ' + left + ' משחקי דירוג כדי לקבל דרגה');
  }
  // The spec's own sub-line, imported so the badge and the mode card cannot word it differently.
  return head + ' — ' + RANKED_UNRANKED_SUB_HE;
}

// ── GAP CHIP TEXT ────────────────────────────────────────────────────────────────────────────────
// g is FRACTIONAL on the wire (integer buckets would put a +20 cliff on a 1-point difference at 899 vs
// 900). Display is rounded — spec §1.
function gapBucket(g) {
  const n = Number(g);
  if (!Number.isFinite(n)) return null;
  return Math.max(-UPSET_G_CLAMP, Math.min(UPSET_G_CLAMP, Math.round(n)));
}

export function gapLabelHe(g) {
  const b = gapBucket(g);
  if (b == null) return null;
  const i = b + UPSET_G_CLAMP;
  return GAP_COUNT[i] == null ? GAP_WORD[i] : GAP_COUNT[i] + ' ' + GAP_WORD[i];
}

// Same label with the leading COUNT isolated. "2 דרגות מעליך" starts with a digit inside an RTL run,
// which is the exact bidi shape that renders 04:12 as 12:04 elsewhere in the hub.
export function gapLabelHtml(g) {
  const b = gapBucket(g);
  if (b == null) return null;
  const i = b + UPSET_G_CLAMP;
  return GAP_COUNT[i] == null
    ? GAP_WORD[i]
    : '<span dir="ltr">' + GAP_COUNT[i] + '</span> ' + GAP_WORD[i];
}

export function gapMult(g) {
  const b = gapBucket(g);
  return b == null ? null : GAP_MULT[b + UPSET_G_CLAMP];
}

// "×2.6". Below the even row the numbers are 0.16…0.60, where one decimal would round 0.16 and 0.24 to
// the same ×0.2 — so those keep two. At g=0 there is no multiplier text at all: "×1" on a 50px badge is
// noise, and the label already says דרגה שווה.
export function gapMultText(g) {
  const m = gapMult(g);
  if (m == null || m === 1) return null;
  const s = m < 1 ? m.toFixed(2) : m.toFixed(1);
  return '×' + s.replace(/0+$/, '').replace(/\.$/, '');
}

export function meetRateText(rate) {
  if (!Number.isFinite(Number(rate))) return null;
  return Math.round(Number(rate) * 100) + '%';
}

// ── CHIP LAYER ───────────────────────────────────────────────────────────────────────────────────
// The chips are NOT children of #hub-tier, and that is a fix rather than a preference:
//   • style.css .hub-tier carries a clip-path for its notched pixel corners, and clip-path clips
//     DESCENDANTS. Every chip lives OUTSIDE the 50×42px box (the flash sits at top:-12px), so a chip
//     parented to the badge is clipped away — the +N flash has never actually been visible on a device.
//   • .hub > #hub-tier is z-index 3 and .hub-hero is z-index 4, so the hero paints over the badge.
// So: one sibling layer tracking the badge's box, with its own z-index.
function chipHost() {
  const box = badge();
  const parent = box && box.parentNode;
  if (!parent) return null;
  let host = document.getElementById('hub-tier-chips');
  if (!host) {
    host = document.createElement('div');
    host.id = 'hub-tier-chips';
    host.className = 'rk-chips';
    host.setAttribute('aria-hidden', 'true');   // the badge's aria-label already carries the state
    parent.appendChild(host);
  }
  // Track the badge. offsetParent is .hub (position:absolute), the same box the baked layout positions
  // the badge in, so these are the same coordinate space. jsdom reports 0 and simply gets 0.
  host.style.left = box.offsetLeft + 'px';
  host.style.top = box.offsetTop + 'px';
  host.style.width = (box.offsetWidth || 50) + 'px';
  host.style.height = (box.offsetHeight || 42) + 'px';
  return host;
}

// Floating "+25 / −8" chip ABOVE the badge: WHAT happened.
function flash(host, amount, down) {
  if (!host || !amount) return; // nothing happened (e.g. a mode that pays no rank) — so claim nothing
  const chip = document.createElement('div');
  chip.className = 'rk-flash' + (down ? ' rk-flash-down' : '');
  chip.innerHTML = '<span dir="ltr">' + (amount > 0 ? '+' : '−') + Math.abs(amount) + '</span>';
  host.appendChild(chip);
  setTimeout(() => chip.remove(), down ? 1600 : 2000);
}

// The gap chips BELOW the badge: WHY it happened. Secondary by position, size and contrast — they
// explain the number, they never compete with it.
function gapChips(host, info) {
  if (!host) return;
  host.querySelectorAll('.rk-gaps').forEach((n) => n.remove());
  if (!info) return;
  const rows = [];

  if (info.gKnown && info.g != null) {
    const mult = gapMultText(info.g);
    const b = gapBucket(info.g);
    rows.push({
      cls: 'rk-gap-tier' + (b < 0 ? ' rk-gap-down' : ''),
      html: gapLabelHtml(info.g) + (mult ? ' · <b dir="ltr">' + mult + '</b>' : ''),
    });
  }
  // Only when the decay actually BIT. At the first meeting the rate is 1.0 and there is nothing to
  // explain. Note the decay is symmetric now (it scales losses too), so this chip can accompany a drop.
  if (info.meetRate != null && info.meetRate < 1) {
    rows.push({
      cls: 'rk-gap-meet',
      html: MEET_HE + ' · <b dir="ltr">' + meetRateText(info.meetRate) + '</b>',
    });
  }
  // The badge did not move but the ledger did. Without this the player reads a −26 chip against an
  // unchanged number as a bug; with it, "sticky badge, honest points" is legible in one line.
  if (info.floorHeld) rows.push({ cls: 'rk-gap-held', html: HELD_HE });

  if (!rows.length) return;
  const wrap = document.createElement('div');
  wrap.className = 'rk-gaps';
  wrap.innerHTML = rows.map((r) => '<div class="rk-gap ' + r.cls + '">' + r.html + '</div>').join('');
  host.appendChild(wrap);
  setTimeout(() => wrap.remove(), 4600);   // long enough to read two short Hebrew lines
}

// Arm the reveal: called once a match result has been posted, so the NEXT injected change animates.
export function armRankReveal() { pendingReveal = true; }

// Poll hook — rank arrives on its own channel, so it needs its own check.
export function pollRank() {
  const st = rankState();
  if (!st || revealing) return;
  if (shown == null) { renderHubRank(); return; }
  const wasUnranked = shownUnranked;

  if (st.unranked) {
    // Nothing to animate INTO the unranked state: there is no number, and a "count down to nothing"
    // would be a relegation animation for a ladder that has no relegation.
    if (!wasUnranked || shown !== st.rankPoints) { pendingReveal = false; renderHubRank(); }
    return;
  }

  if (wasUnranked) {
    // לא מדורג → ranked is a PROMOTION MOMENT, not a count-up from 0. There was no 0 to count from —
    // the player was off the ladder — and tweening 0→240 claims all 240 points were earned in this one
    // match. Land on the final number and celebrate the arrival instead.
    pendingReveal = false;
    playRankPlacement(st.rankPoints, st);
    return;
  }

  if (st.rankPoints === shown) {
    // The DISPLAY did not move. The LEDGER may still have: rankPoints = max(rankPointsRaw, floor), so a
    // thrown loss at a tier entry costs raw points and zero badge. Report the delta, never move the
    // number — the badge must never appear to drop.
    if (pendingReveal && st.delta) { pendingReveal = false; playRankHeld(st); }
    return;
  }

  const from = shown, to = st.rankPoints;
  if (pendingReveal) { pendingReveal = false; playRankReveal(from, to, st.delta, st); }
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
export function playRankReveal(from, to, delta, info) {
  const box = badge();
  const st = info || rankState();
  if (!box) { shown = to; return; }
  const host = chipHost();
  const down = to < from;
  const amount = delta || (to - from);
  flash(host, amount, down);
  gapChips(host, st);
  if (REDUCE || from === to) { shown = to; shownUnranked = false; renderHubRank(); return; }
  revealing = true;
  const lvl = st ? st.botLevel : null;
  tween(down ? 700 : 1000, (p) => {
    shown = Math.round(from + (to - from) * p);
    paint(box, shown, lvl, st);
  }, () => {
    revealing = false;
    shown = to;
    shownUnranked = false;
    renderHubRank();
    if (!down && tierIndexFromRank(to) > tierIndexFromRank(from)) promote(box);
  });
}

// לא מדורג → ranked. No tween: the number appears at its final value and the badge celebrates.
export function playRankPlacement(to, info) {
  const box = badge();
  shown = to;
  shownUnranked = false;
  renderHubRank();
  if (!box) return;
  const host = chipHost();
  gapChips(host, info);
  if (info && info.delta) flash(host, info.delta, info.delta < 0);
  promote(box);
}

// The delta landed on the raw ledger but the sticky floor held the display. Chip only, number frozen.
export function playRankHeld(info) {
  const box = badge();
  shown = info ? info.rankPoints : shown;
  shownUnranked = false;
  renderHubRank();
  if (!box) return;
  const host = chipHost();
  const amount = info ? info.delta : 0;
  flash(host, amount, amount < 0);
  gapChips(host, info);
}

function promote(box) {
  if (REDUCE) return;
  box.classList.add('hub-tier-promote');
  setTimeout(() => box.classList.remove('hub-tier-promote'), 1400);
}

// LOCALHOST dev path (no app to inject SALTIZ_RANK) so the reveal can be eyeballed without a device.
// `from: 0` now exercises the לא מדורג → ranked promotion instead of a count-up from bronze.
export function devSimulate(from, delta, extra) {
  window.SALTIZ_RANK = { rankPoints: from, delta: 0, botLevel: 11, ...(extra && extra.before) };
  shown = from;
  shownUnranked = false;
  renderHubRank();
  shownUnranked = !!(rankState() && rankState().unranked);
  armRankReveal();
  setTimeout(() => {
    window.SALTIZ_RANK = {
      rankPoints: Math.max(0, from + delta), delta, botLevel: 11,
      g: 2, gKnown: true, rankedMatches: 9,
      ...(extra && extra.after),
    };
    pollRank();
  }, 600);
}

export { TIER_MIN };
