// DOM-level test for the profile page, driven through jsdom (same approach as test-net-hud.mjs).
//
// The maths is covered by test-profile-stats.mjs. This file checks the things only a DOM can answer:
// every section PAINTS, a brand-new player sees words instead of a wall of zeros, rendering twice does
// not duplicate the page, no emoji sneaks in as an icon, and there is exactly ONE scroll region —
// nested scrollers on a phone swallow the drag, which is why the design doc calls it load-bearing.
import { JSDOM } from 'jsdom';
import { buildProfileModel, PROFILE_CAREER_ROWS } from './shared/profile-stats.js';

let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + '  ' + m); if (!c) fails++; };

const dom = new JSDOM('<!doctype html><html><head></head><body><div id="profile" class="screen hidden"></div></body></html>',
  { url: 'http://localhost:3012/' });
global.window = dom.window;
global.document = dom.window.document;
global.location = dom.window.location;
// jsdom has no 2d context. The page MUST tolerate that (a real client can also lose its context).
dom.window.HTMLCanvasElement.prototype.getContext = () => null;

const { renderProfile, PROFILE_SECTIONS } = await import('./public/profile.js');
const root = document.getElementById('profile');

// ── 1. a brand-new player ───────────────────────────────────────────────────────────────────────
renderProfile(root, buildProfileModel({}), { name: 'שחקן' });
for (const id of PROFILE_SECTIONS) ok(!!root.querySelector(`[data-section="${id}"]`), `empty model renders section ${id}`);
ok(root.querySelectorAll('.pf-empty').length >= 3, `empty model shows explicit empty states (${root.querySelectorAll('.pf-empty').length})`);
ok(!/undefined|NaN/.test(root.textContent), 'no undefined/NaN leaks into the copy');
ok(root.textContent.includes('אין נתונים עדיין'), 'the empty state says so in Hebrew');
ok(!!document.getElementById('pf-css'), 'the page injected its own stylesheet');

// ── 2. a populated player ───────────────────────────────────────────────────────────────────────
const model = buildProfileModel({
  stats: { matchesPlayed: 42, wins: 18, losses: 17, draws: 7, winsVsHuman: 15, winsVsBot: 3,
    goalsFor: 88, goalsAgainst: 60, streak: 2, bestStreak: 6, careerGoals: 31, assists: 12, strips: 40,
    saves: 9, shotsFired: 220, bombsPlanted: 55, wallsBuilt: 77, touches: 900, possSeconds: 605, distanceM: 4210 },
  xpState: { xp: 3970, level: 9 }, rank: { rank: 3, totalPlayers: 27, rankPoints: 454, rankTier: 'silver' },
  cards: [{ r: 'legendary', n: 5, c: 2, w: 90000 }, { r: 'epic', n: 7, c: 1, w: 40000 },
    { r: 'rare', n: 22, c: 3, w: 7000 }],
  heroPlays: { alien: 30 }, bestBotLevel: 10, arenaCount: 4, friendCount: 6,
  cosmetic: 'alien:holo', unlockedHeroes: 5, loadout: [{ r: 'legendary', n: 5 }, null, null],
});
renderProfile(root, model, { name: 'אדם' });
for (const id of PROFILE_SECTIONS) ok(!!root.querySelector(`[data-section="${id}"]`), `full model renders section ${id}`);
ok(root.textContent.includes('43%'), 'the win rate is on the page');
ok(root.textContent.includes('10:05'), 'possession time is formatted on the page');
ok(root.textContent.includes('אדם'), 'the player name is on the page');
ok(root.textContent.includes('רמה 11'), 'the peak bot level is shown as a DISPLAY level (index 10 -> רמה 11)');
ok(root.textContent.includes('מקום 3 מתוך 27'), 'the leaderboard position is shown');
ok(root.textContent.includes('כסף'), 'the rank tier is named in Hebrew');
ok(root.querySelectorAll('[data-section="album"] .pf-card img').length === 3, 'top cards render art');
ok(root.querySelectorAll('[data-section="album"] .pf-card.eq').length === 1, 'the equipped card is marked');
ok(root.querySelectorAll('[data-section="career"] .pf-row').length === PROFILE_CAREER_ROWS.length,
  'every career row is painted');
// ...and with no readable stats the career section says so instead of printing ten zeros.
renderProfile(root, buildProfileModel({ heroPlays: { alien: 2 } }), { name: 'אדם' });
ok(root.querySelectorAll('[data-section="career"] .pf-row').length === 0,
  'no readable stats -> career prints no zero rows');
ok(root.querySelector('[data-section="career"] .pf-empty'), 'no readable stats -> career shows its empty state');
renderProfile(root, model, { name: 'אדם' });   // restore the populated render for the checks below
// The W/L/D bar must print its numbers, not rely on colour.
const segs = [...root.querySelectorAll('[data-section="record"] .pf-bar span')];
ok(segs.length === 3, 'the record bar has three segments');
ok(segs.every((s) => s.style.width), 'each segment is sized by share');
ok(root.querySelector('[data-section="record"] .pf-sum').textContent.includes('נצחונות'),
  'a text summary accompanies the bar (meaning never depends on colour alone)');

// ── 3. idempotent ───────────────────────────────────────────────────────────────────────────────
const before = root.querySelectorAll('[data-section]').length;
renderProfile(root, model, { name: 'אדם' });
ok(root.querySelectorAll('[data-section]').length === before, 'rendering twice does not duplicate sections');
ok(document.querySelectorAll('#pf-css').length === 1, 'the stylesheet is injected once, not per render');

// ── 4. the two rules that are easy to break later ───────────────────────────────────────────────
ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(root.innerHTML), 'no emoji used as icons');
ok([...root.querySelectorAll('img.pf-ic')].every((i) => i.getAttribute('alt') === ''),
  'decorative icons are alt="" so a screen reader reads the label, not the filename');
const scrollers = [...root.querySelectorAll('*')].filter((el) => {
  const s = (el.getAttribute('style') || '') + (el.className || '');
  return /pf-body\b/.test(s);
});
ok(scrollers.length === 1, `exactly one scroll region (found ${scrollers.length})`);

// ── 5. the back button is wired and reachable ───────────────────────────────────────────────────
let backed = 0;
renderProfile(root, model, { name: 'אדם', onBack: () => { backed++; } });
root.querySelector('.pf-back').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
ok(backed === 1, 'the back button calls onBack');
ok(root.querySelector('.pf-back').getAttribute('aria-label') === 'חזרה', 'the back button has an aria-label');

console.log(fails ? `❌ test-profile-page: ${fails} FAILED` : '✅ test-profile-page passed');
process.exit(fails ? 1 : 0);
