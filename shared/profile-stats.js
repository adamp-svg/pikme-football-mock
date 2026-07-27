// Everything the PROFILE PAGE computes — and nothing it draws.
//
// Pure by design: no DOM, no fetch, no localStorage (the two counter readers take an accessor).
// That split is the point. The page (public/profile.js) is then dumb enough to be obvious, and every
// number on it is covered by test-profile-stats.mjs without a browser.
//
// Design: docs/superpowers/specs/2026-07-27-player-profile-page-design.md
// Plan:   docs/superpowers/plans/2026-07-27-player-profile-page.md
import { clampLevel, displayLevelForBot } from './difficulty.js';
import { HERO_KEYS } from './cosmetics.js';

// Coerce anything the app/backend/localStorage hands us into a finite number. Used EVERYWHERE below,
// because this page reads three sources it does not control (an app inject, a possibly-undeployed
// API, and localStorage) and a single NaN on a stat page is visible to the player.
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// ── the small derivations ───────────────────────────────────────────────────────────────────────
export function winRate(wins, matches) {
  const m = num(matches), w = num(wins);
  if (m <= 0 || w < 0) return 0;
  return Math.round((Math.min(w, m) / m) * 100);
}

export const goalDiff = (goalsFor, goalsAgainst) => num(goalsFor) - num(goalsAgainst);

// "hero:skin" -> "hero". Unknown heroes return '' so a stale/garbled cosmetic can never open a
// section keyed on a hero that does not exist in the catalog.
export function heroKeyOf(cosmetic) {
  const key = String(cosmetic || '').split(':')[0];
  return HERO_KEYS.includes(key) ? key : '';
}

export function bumpHeroPlays(playsMap, heroKey) {
  const base = playsMap && typeof playsMap === 'object' && !Array.isArray(playsMap) ? playsMap : {};
  if (!heroKey) return base;
  return { ...base, [heroKey]: num(base[heroKey]) + 1 };
}

// The most-played hero, or null when nothing has been measured yet. `>` and not `>=` so a tie keeps
// the FIRST hero seen — otherwise "best hero" would flip between two equal heroes on every render.
export function bestHero(playsMap) {
  if (!playsMap || typeof playsMap !== 'object' || Array.isArray(playsMap)) return null;
  let key = null, plays = 0;
  for (const k of Object.keys(playsMap)) {
    const n = num(playsMap[k]);
    if (n > plays) { key = k; plays = n; }
  }
  return key ? { key, plays } : null;
}

// Monotone: the peak can only rise. `null` in and nothing to record stays `null`, which is how the
// page tells "never played a bot" apart from "beat level 0" — level 0 is a real level.
export function bumpBestBotLevel(prev, botLevel) {
  // `prev != null` FIRST, and that is load-bearing: Number(null) is 0, which is finite, so testing
  // only isFinite would turn "never measured" into "measured level 0" — and level 0 is a real level,
  // so the mistake is invisible afterwards.
  const hasPrev = prev != null && prev !== '' && Number.isFinite(Number(prev));
  const p = hasPrev ? clampLevel(prev) : null;
  // Same null-is-zero trap on the incoming level: an absent botLevel must leave the peak alone,
  // while a genuine 0 must be recorded.
  if (botLevel == null || botLevel === '') return p;
  const n = Number(botLevel);
  if (!Number.isFinite(n) || n < 0) return p;
  const lvl = clampLevel(n);
  return p == null ? lvl : Math.max(p, lvl);
}

export function fmtDuration(seconds) {
  const s = Math.max(0, Math.floor(num(seconds)));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ── the two counter readers ─────────────────────────────────────────────────────────────────────
// `getItem` is injected (not localStorage) so these are testable in node AND so a private-mode
// browser, where localStorage THROWS on access, degrades to the empty state instead of taking down
// the caller — postMatchResult is the caller, and it runs on every finished match.
export function readHeroPlays(getItem) {
  try {
    const raw = JSON.parse(getItem('fbHeroPlays') || '{}');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out = {};
    for (const k of Object.keys(raw)) if (Number.isFinite(Number(raw[k]))) out[k] = Number(raw[k]);
    return out;
  } catch { return {}; }
}

export function readBestBotLevel(getItem) {
  try {
    const raw = getItem('fbBestBotLevel');
    if (raw == null || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? clampLevel(n) : null;
  } catch { return null; }
}

// ── the page's content tables — DATA lives here, pixels live in public/profile.js ────────────────
// Icon ids are from public/assets/pixel-icon-system-01/ASSET_REGISTRY.json (all `live`). No emoji:
// the repo ships 96 icons, so there is never a reason to reach for one.
export const PROFILE_CAREER_ROWS = [
  { id: 'careerGoals', label: 'שערים', icon: 'goal-net' },
  { id: 'assists', label: 'בישולים', icon: 'power-kick' },
  { id: 'strips', label: 'חטיפות', icon: 'defense' },
  { id: 'saves', label: 'הצלות', icon: 'goal-net' },
  { id: 'shotsFired', label: 'בעיטות', icon: 'fire' },
  { id: 'bombsPlanted', label: 'פצצות', icon: 'bomb' },
  { id: 'wallsBuilt', label: 'קירות', icon: 'build-wall' },
  { id: 'touches', label: 'נגיעות', icon: 'ball-placement' },
  { id: 'possSeconds', label: 'זמן עם הכדור', icon: 'timer', fmt: 'duration' },
  { id: 'distanceM', label: 'מרחק', icon: 'speed', fmt: 'metres' },
];

// The 6 tiles at the top of the scrolling body. Order is the reading order in RTL.
//
// `hasRecord` false means the backend gave us nothing (undeployed route, no identity, offline) — the
// five match-derived tiles then print an em dash. Printing 0 there would state as fact that the player
// has never won a match, which is a different claim from "we could not read it". Arenas is local, so it
// is always a real number.
const UNKNOWN = '—';
function kpiTiles({ stats, rate, arenaCount, hasRecord }) {
  const stat = (v) => (hasRecord ? num(v) : UNKNOWN);
  return [
    { id: 'matches', label: 'משחקים', value: stat(stats.matchesPlayed), icon: 'play' },
    { id: 'wins', label: 'ניצחונות', value: stat(stats.wins), icon: 'champion-reaction' },
    { id: 'rate', label: 'אחוז ניצחון', value: hasRecord ? `${rate}%` : UNKNOWN, icon: 'rank' },
    { id: 'goals', label: 'שערים', value: stat(stats.goalsFor), icon: 'goal-net' },
    { id: 'streak', label: 'רצף שיא', value: stat(stats.bestStreak), icon: 'season-star' },
    { id: 'arenas', label: 'מגרשים', value: num(arenaCount), icon: 'field-library' },
  ];
}

// Best-first: worth, then copies. Deliberately NOT importing the client's rankCards — that lives in
// public/client.js (a 7000-line browser module) and this file must stay node-importable.
function topCards(cards, n) {
  if (!Array.isArray(cards)) return [];
  return cards
    .filter((c) => c && typeof c.r === 'string' && c.n != null)
    .slice()
    .sort((a, b) => num(b.w) - num(a.w) || num(b.c) - num(a.c))
    .slice(0, n);
}

// ── the one function the renderer consumes ──────────────────────────────────────────────────────
// Every input is optional. A missing input becomes an explicit `hasData: false` section — never a
// throw, and never a fabricated zero presented as a measurement.
export function buildProfileModel(input) {
  const i = input && typeof input === 'object' ? input : {};
  const stats = i.stats && typeof i.stats === 'object' && !Array.isArray(i.stats) ? i.stats : {};
  const xpState = i.xpState && typeof i.xpState === 'object' ? i.xpState : {};
  const rank = i.rank && typeof i.rank === 'object' ? i.rank : {};
  const cards = Array.isArray(i.cards) ? i.cards : [];
  const matches = num(stats.matchesPlayed);
  const rate = winRate(stats.wins, matches);

  const hero = bestHero(i.heroPlays);
  const peak = Number.isFinite(Number(i.bestBotLevel)) ? clampLevel(i.bestBotLevel) : null;
  // The bot ladder is 0-based internally and 1-based on screen (displayLevelForBot), the same
  // convention the countdown badge and the Saltiz bot friends use. Mixing them is how שובל ends up
  // advertised a rung below what he plays at.
  // PRECEDENCE: the fetched server row wins over the injected/dev globals. The whole page must
  // describe ONE snapshot — mixing a stale window.SALTIZ_XP into the header while the body shows a
  // freshly fetched career block puts two different truths on screen, which reads as a bug. It showed
  // up immediately in the browser: the header said רמה 5 · 1.2K (the dev default) next to a body
  // reporting 42 matches. In the app both sources are the same Mongo row, so they agree anyway.
  const xp = num(stats.xp !== undefined ? stats.xp : xpState.xp);
  const currentBot = clampLevel(levelFromTrophies(xp) - 1);

  return {
    head: {
      xp,
      level: num(stats.level !== undefined ? stats.level : xpState.level) || levelFromTrophies(xp),
      rankPoints: num(stats.rankPoints !== undefined ? stats.rankPoints : rank.rankPoints),
      rankTier: (stats.rankTier || rank.rankTier || 'bronze'),
      boardRank: Number.isFinite(Number(rank.rank)) ? Number(rank.rank) : null,
      boardTotal: Number.isFinite(Number(rank.totalPlayers)) ? Number(rank.totalPlayers) : null,
      cosmetic: i.cosmetic || 'striker:base',
    },
    kpis: kpiTiles({ stats, rate, arenaCount: i.arenaCount, hasRecord: matches > 0 }),
    hero: {
      key: hero ? hero.key : '',
      plays: hero ? hero.plays : 0,
      cosmetic: i.cosmetic || 'striker:base',
      unlocked: num(i.unlockedHeroes),
      total: HERO_KEYS.length,
      hasData: !!hero,
    },
    record: {
      wins: num(stats.wins), losses: num(stats.losses), draws: num(stats.draws),
      matches, rate, vsHuman: num(stats.winsVsHuman), vsBot: num(stats.winsVsBot),
      streak: num(stats.streak), bestStreak: num(stats.bestStreak),
      hasData: matches > 0,
    },
    goals: {
      for: num(stats.goalsFor), against: num(stats.goalsAgainst),
      diff: goalDiff(stats.goalsFor, stats.goalsAgainst),
      hasData: num(stats.goalsFor) > 0 || num(stats.goalsAgainst) > 0,
    },
    career: PROFILE_CAREER_ROWS.map((row) => ({
      id: row.id, label: row.label, icon: row.icon,
      value: row.fmt === 'duration' ? fmtDuration(stats[row.id]) : num(stats[row.id]),
      unit: row.fmt === 'metres' ? 'מ׳' : '',
    })),
    bots: {
      peak, peakDisplay: peak == null ? null : displayLevelForBot(peak),
      current: currentBot, currentDisplay: displayLevelForBot(currentBot),
      hasData: peak != null,
    },
    album: {
      top: topCards(cards, 6),
      worth: cards.reduce((s, c) => s + num(c && c.w), 0),
      owned: cards.reduce((s, c) => s + (c && c.c != null ? num(c.c) : 1), 0),
      distinct: new Set(cards.filter((c) => c && c.r != null).map((c) => `${c.r}/${c.n}`)).size,
      loadout: [0, 1, 2].map((s) => (Array.isArray(i.loadout) && i.loadout[s]) || null),
      hasData: cards.length > 0,
    },
    social: { friends: num(i.friendCount), arenas: num(i.arenaCount) },
  };
}

// Trophies -> player level, the same triangular curve pikme-server uses (data/football-xp.js
// levelFromXp). Duplicated here rather than imported because that file is in the OTHER repo; the
// formula is pinned by test-profile-stats.mjs so a drift shows up as a failure, not as a wrong badge.
function levelFromTrophies(xp) {
  const x = num(xp);
  if (x <= 0) return 1;
  return Math.floor((1 + Math.sqrt(1 + x / 12.5)) / 2);
}
