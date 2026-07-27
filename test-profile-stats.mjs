// Pure derivations behind the profile page (shared/profile-stats.js).
//
// The point of this file: every number the page shows must survive the two states the page will
// really meet — a brand-new player (all zeros, no counters, possibly no backend at all) and a
// mid-season player — without inventing data, printing NaN, or throwing on the hub's hot path.
//
// Plan: docs/superpowers/plans/2026-07-27-player-profile-page.md (Task 1 + Task 2)
import assert from 'node:assert';
import {
  winRate, goalDiff, bumpHeroPlays, bestHero, bumpBestBotLevel, fmtDuration, heroKeyOf,
  readHeroPlays, readBestBotLevel, buildProfileModel, PROFILE_CAREER_ROWS,
} from './shared/profile-stats.js';

let pass = 0;
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); pass++; };
const ok = (c, m) => { assert.ok(c, m); pass++; };

// ── winRate — integer percent, and 0 matches must not be NaN/Infinity ────────────────────────────
eq(winRate(18, 42), 43, 'winRate rounds to an integer percent');
eq(winRate(0, 0), 0, 'winRate of a new player is 0, not NaN');
eq(winRate(3, 3), 100, 'winRate can reach 100');
eq(winRate(5, 0), 0, 'winRate ignores impossible input');
eq(winRate(null, null), 0, 'winRate of nulls is 0');

eq(goalDiff(88, 60), 28, 'goalDiff subtracts');
eq(goalDiff(0, 0), 0, 'goalDiff of nothing is 0');
eq(goalDiff(2, 9), -7, 'goalDiff can be negative');
eq(goalDiff(undefined, undefined), 0, 'goalDiff of nothing at all is 0');

// ── heroKeyOf — a cosmetic is "hero:skin" ───────────────────────────────────────────────────────
eq(heroKeyOf('striker:gold'), 'striker', 'heroKeyOf takes the part before the colon');
eq(heroKeyOf('alien'), 'alien', 'heroKeyOf accepts a bare hero');
eq(heroKeyOf(''), '', 'heroKeyOf of empty is empty');
eq(heroKeyOf(null), '', 'heroKeyOf of null is empty');
eq(heroKeyOf('nosuchhero:gold'), '', 'heroKeyOf rejects a hero that is not in the catalog');

// ── bumpHeroPlays — immutable, counts up ────────────────────────────────────────────────────────
const p0 = {};
const p1 = bumpHeroPlays(p0, 'striker');
eq(JSON.stringify(p0), '{}', 'bumpHeroPlays does not mutate its input');
eq(p1.striker, 1, 'first play counts 1');
eq(bumpHeroPlays(p1, 'striker').striker, 2, 'second play counts 2');
eq(bumpHeroPlays(p1, 'alien').striker, 1, 'a different hero leaves the first alone');
eq(JSON.stringify(bumpHeroPlays(p1, '')), JSON.stringify(p1), 'an empty hero key is ignored');
eq(JSON.stringify(bumpHeroPlays(null, 'cat')), '{"cat":1}', 'a missing map starts a fresh one');

// ── bestHero — the "best hero" answer, and its empty state ──────────────────────────────────────
eq(bestHero({}), null, 'no plays yet -> null, which the page renders as an empty state');
eq(bestHero(null), null, 'null map -> null');
eq(bestHero({ striker: 3, alien: 9, dwarf: 1 }).key, 'alien', 'bestHero picks the most played');
eq(bestHero({ striker: 3, alien: 9 }).plays, 9, 'bestHero reports the count');
eq(bestHero({ striker: 4, alien: 4 }).key, 'striker', 'a tie keeps the first-seen hero (stable across renders)');
eq(bestHero({ striker: 0 }), null, 'a zero count is not a played hero');

// ── bumpBestBotLevel — monotone and clamped ─────────────────────────────────────────────────────
eq(bumpBestBotLevel(0, 7), 7, 'a higher level raises the peak');
eq(bumpBestBotLevel(9, 4), 9, 'a lower level does NOT lower the peak');
eq(bumpBestBotLevel(undefined, 3), 3, 'no previous peak starts at the new level');
eq(bumpBestBotLevel(null, 0), 0, 'level 0 is a real level and IS recorded');
eq(bumpBestBotLevel(5, 99), 11, 'above the ladder clamps to 11');
eq(bumpBestBotLevel(5, -3), 5, 'below the ladder is ignored');
eq(bumpBestBotLevel(5, null), 5, 'a missing level is ignored');
eq(bumpBestBotLevel(null, null), null, 'nothing in, nothing out — still "never measured"');

// ── fmtDuration ─────────────────────────────────────────────────────────────────────────────────
eq(fmtDuration(0), '0:00', 'zero possession reads 0:00');
eq(fmtDuration(65), '1:05', 'seconds pad to two digits');
eq(fmtDuration(605), '10:05', 'ten minutes and change');
eq(fmtDuration(3599), '59:59', 'just under an hour');
eq(fmtDuration(null), '0:00', 'invalid input is 0:00, not NaN:NaN');
eq(fmtDuration(-5), '0:00', 'negative input is 0:00');

// ── the counter readers — storage injected, so no localStorage is needed here ────────────────────
// A corrupt or absent value must never throw: these run on the hub's hot path at match end.
eq(JSON.stringify(readHeroPlays(() => null)), '{}', 'absent hero plays read as {}');
eq(JSON.stringify(readHeroPlays(() => 'not json')), '{}', 'corrupt hero plays read as {}');
eq(JSON.stringify(readHeroPlays(() => '{"striker":3}')), '{"striker":3}', 'valid hero plays parse');
eq(JSON.stringify(readHeroPlays(() => '[1,2]')), '{}', 'an array is not a plays map');
eq(JSON.stringify(readHeroPlays(() => '{"striker":"x","alien":4}')), '{"alien":4}', 'non-numeric counts are dropped');
eq(JSON.stringify(readHeroPlays(() => { throw new Error('private mode'); })), '{}', 'a throwing storage reads as {}');
// The load-bearing distinction: an absent peak is null ("never measured"), NOT 0 ("beat level 0").
eq(readBestBotLevel(() => null), null, 'absent peak reads null (= no data), NOT 0');
eq(readBestBotLevel(() => '7'), 7, 'stored peak parses');
eq(readBestBotLevel(() => '0'), 0, 'a stored 0 is a real measurement and survives');
eq(readBestBotLevel(() => 'x'), null, 'corrupt peak reads null');
eq(readBestBotLevel(() => '99'), 11, 'stored peak is clamped on read too');
eq(readBestBotLevel(() => { throw new Error('private mode'); }), null, 'a throwing storage reads null');

// ── buildProfileModel — the EMPTY case first, because that is a new player's real experience ─────
const empty = buildProfileModel({});
ok(empty && empty.kpis.length > 0, 'an empty model still has KPI tiles');
eq(empty.record.hasData, false, 'no matches -> record section flags no data');
eq(empty.bots.hasData, false, 'no bot level yet -> bots section flags no data');
eq(empty.hero.hasData, false, 'no hero plays yet -> hero section flags no data');
eq(empty.album.top.length, 0, 'no cards -> no top cards');
eq(empty.album.hasData, false, 'no cards -> album flags no data');
eq(empty.social.arenas, 0, 'no arenas -> 0');
eq(empty.career.length, PROFILE_CAREER_ROWS.length, 'career rows always render');
ok(empty.kpis.every((t) => t.value !== undefined && t.label && t.icon), 'every KPI tile has label, value and icon');
// An unreadable backend must not be reported as "0 matches, 0 wins" — that is a claim we cannot make.
eq(empty.kpis.find((t) => t.id === 'matches').value, '—', 'unknown match count reads as a dash, not 0');
eq(empty.kpis.find((t) => t.id === 'rate').value, '—', 'unknown win rate reads as a dash, not 0%');
eq(empty.kpis.find((t) => t.id === 'arenas').value, 0, 'arenas is LOCAL, so a real 0 is a real 0');
ok(empty.career.every((c) => c.value !== undefined), 'every career row has a value');
ok(!JSON.stringify(empty).includes('NaN'), 'an empty model contains no NaN');
ok(!JSON.stringify(empty).includes('undefined'), 'an empty model contains no undefined');

// ── buildProfileModel — a populated player ──────────────────────────────────────────────────────
const full = buildProfileModel({
  stats: {
    matchesPlayed: 42, wins: 18, losses: 17, draws: 7, winsVsHuman: 15, winsVsBot: 3,
    goalsFor: 88, goalsAgainst: 60, streak: 2, bestStreak: 6,
    careerGoals: 31, assists: 12, strips: 40, saves: 9, shotsFired: 220,
    bombsPlanted: 55, wallsBuilt: 77, touches: 900, possSeconds: 605, distanceM: 4210,
  },
  xpState: { xp: 3970, level: 9 },
  rank: { rank: 3, totalPlayers: 27, rankPoints: 454, rankTier: 'silver' },
  cards: [
    { r: 'legendary', n: 5, c: 2, w: 90000 }, { r: 'epic', n: 7, c: 1, w: 40000 },
    { r: 'rare', n: 22, c: 3, w: 7000 }, { r: 'common', n: 8, c: 5, w: 500 },
  ],
  heroPlays: { striker: 12, alien: 30 },
  bestBotLevel: 10,
  arenaCount: 4,
  friendCount: 6,
  cosmetic: 'alien:neon',
  unlockedHeroes: 5,
  loadout: [{ r: 'legendary', n: 5 }, null, { r: 'rare', n: 22 }],
});
eq(full.kpis.find((t) => t.id === 'matches').value, 42, 'a played player gets real KPI numbers');
eq(full.kpis.find((t) => t.id === 'rate').value, '43%', 'the rate tile prints a percent');
eq(full.record.rate, 43, 'model carries the win rate');
eq(full.record.hasData, true, 'a played player has record data');
eq(full.record.wins, 18, 'model carries wins');
eq(full.record.vsHuman, 15, 'model splits wins vs humans');
eq(full.record.vsBot, 3, 'model splits wins vs bots');
eq(full.goals.diff, 28, 'model carries the goal difference');
eq(full.hero.key, 'alien', 'model names the most-played hero');
eq(full.hero.plays, 30, 'model carries its play count');
eq(full.hero.cosmetic, 'alien:neon', 'model carries the worn cosmetic for the canvas');
eq(full.hero.unlocked, 5, 'model carries heroes unlocked');
eq(full.bots.peak, 10, 'model carries the peak bot level');
eq(full.bots.peakDisplay, 11, 'the peak is SHOWN as רמה 11 — display level is index + 1');
eq(full.bots.hasData, true, 'a measured peak has data');
eq(full.album.owned, 11, 'album owned = total copies');
eq(full.album.distinct, 4, 'album distinct = unique cards');
eq(full.album.worth, 137500, 'album worth = sum of worth');
ok(full.album.top.length && full.album.top[0].r === 'legendary', 'top cards are best-first');
ok(full.album.top.length <= 6, 'top cards are capped at 6');
eq(full.album.loadout.length, 3, 'the equipped loadout is always 3 slots');
eq(full.career.length, 10, 'all ten career counters are present');
ok(full.career.every((c) => c.label && c.icon), 'every career row has a label and an icon id');
ok(full.career.some((c) => c.id === 'possSeconds' && c.value === '10:05'), 'possession is formatted as time');
ok(full.career.some((c) => c.id === 'careerGoals' && c.value === 31), 'career goals come through as a number');
eq(full.social.friends, 6, 'model carries the friend count');
eq(full.social.arenas, 4, 'model carries the arena count');
eq(full.head.xp, 3970, 'the fixed pane gets trophies');
eq(full.head.level, 9, 'the fixed pane gets the level');
eq(full.head.rankTier, 'silver', 'the fixed pane gets the rank tier for its badge art');
eq(full.head.boardRank, 3, 'the fixed pane gets the leaderboard position');
eq(full.head.boardTotal, 27, 'the fixed pane gets the leaderboard size');

// ── a partially-deployed backend (rank route without the career block) must not break the page ──
const partial = buildProfileModel({ stats: { xp: 500, level: 4 }, xpState: { xp: 500, level: 4 } });
eq(partial.career.length, 10, 'career rows still render (as zeros) when the backend omits them');
eq(partial.record.hasData, false, 'but the record section honestly says it has no data');
ok(partial.career.every((c) => c.value === 0 || c.value === '0:00'), 'omitted career fields read as zero, not undefined');

// ── a hostile/garbled payload must not take the hub down ────────────────────────────────────────
const junk = buildProfileModel({
  stats: { matchesPlayed: 'x', wins: {}, goalsFor: [], possSeconds: 'NaN' },
  cards: 'not an array', heroPlays: 7, bestBotLevel: 'nine', loadout: 'nope', rank: 5,
});
ok(junk && junk.kpis.length > 0, 'a garbled payload still produces a renderable model');
ok(!JSON.stringify(junk).includes('NaN'), 'a garbled payload produces no NaN');
eq(junk.album.top.length, 0, 'a non-array album is empty, not a crash');
eq(junk.bots.hasData, false, 'an unparseable peak is treated as never measured');

console.log(`✅ test-profile-stats: ${pass} assertions passed`);
