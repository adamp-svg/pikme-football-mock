// DOM-level test for the hub RANK layer, driven through jsdom so the real element/class behaviour is
// verified without a browser (same approach as test-net-hud.mjs). The rank NUMBERS are the server's and
// are covered by pikme-server/test-football-rank.mjs; the ladder itself by test-rank.mjs. This file
// checks what actually gets PAINTED into the badge over the hero — especially the case the XP reveal
// never had to handle: the number going DOWN.
import { JSDOM } from 'jsdom';

let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + '  ' + m); if (!c) fails++; };

const dom = new JSDOM(
  '<!doctype html><html><body><div class="hub">'
  // The real badge markup from index.html: the icon/sub label + the small meter INSIDE the badge.
  + '<div id="hub-tier" class="hub-tier">'
  +   '<span id="hub-tier-lbl" class="hub-tier-lbl"><span class="px-ic">🥉</span><span class="px-sub">1</span></span>'
  +   '<span class="hub-tier-bar"><b id="hub-tier-fill"></b></span>'
  + '</div>'
  + '<div class="hub-xpbar"><div id="hub-xp"></div></div>'
  + '</div></body></html>',
  { url: 'http://localhost:3012/' },
);
global.window = dom.window;
global.document = dom.window.document;
global.location = dom.window.location;
global.requestAnimationFrame = (fn) => setTimeout(() => fn(performance.now()), 0);
global.matchMedia = dom.window.matchMedia || (() => ({ matches: false }));
dom.window.matchMedia = dom.window.matchMedia || (() => ({ matches: false }));

const rk = await import('./public/hub-rank.js');

const badge = () => document.getElementById('hub-tier');
const meter = () => document.getElementById('hub-tier-fill');
const txt = () => badge().textContent;
const tip = () => badge().title || '';

console.log('--- GRACEFUL DEGRADATION: no SALTIZ_RANK (old app build) ---');
delete window.SALTIZ_RANK;
ok(rk.renderHubRank() === false, 'renderHubRank() returns false so client.js can fall back to the legacy XP badge');
ok(rk.rankState() === null, 'rankState() reports nothing to show');
ok(!badge().classList.contains('hub-tier-rank'), 'the badge is NOT switched into rank mode');

console.log('--- renders rank into the badge over the hero ---');
window.SALTIZ_RANK = { rankPoints: 620, delta: 0, botLevel: 11 };
ok(rk.renderHubRank() === true, 'renderHubRank() reports it took the badge');
ok(badge().classList.contains('hub-tier-rank'), 'the badge opts into rank styling');
ok(txt().includes('620'), 'the rank points are shown');
ok(badge().querySelector('.px-pts') !== null, 'the points get their own element');
ok(badge().querySelector('.px-pts').getAttribute('dir') === 'ltr', 'the number is LTR-isolated so a sign stays on the correct side in RTL');
ok(badge().style.getPropertyValue('--c1') !== '', 'the tier colour is applied to the badge');

console.log('--- the small METER inside the badge tracks progress to the next tier ---');
ok(meter().style.width === '30%', '620 is 30% through זהב (500→900)');
window.SALTIZ_RANK = { rankPoints: 500, delta: 0, botLevel: 11 };
rk.renderHubRank();
ok(meter().style.width === '0%', 'entering a tier resets the meter to empty');
window.SALTIZ_RANK = { rankPoints: 3500, delta: 0, botLevel: null };
rk.renderHubRank();
ok(meter().style.width === '100%', 'the TOP tier reads FULL, not empty (an empty meter at max rank looks like a bug)');
ok(tip().includes('הדרגה הגבוהה ביותר'), 'and the tooltip says it is the highest tier');

console.log('--- the tier itself ---');
window.SALTIZ_RANK = { rankPoints: 0, delta: 0, botLevel: null };
rk.renderHubRank();
ok(tip().includes('ברונזה'), '0 = ברונזה');
window.SALTIZ_RANK = { rankPoints: 950, delta: 0, botLevel: null };
rk.renderHubRank();
ok(tip().includes('פלטינה'), '950 = פלטינה');
ok(tip().includes('דרגה'), 'the tooltip names the track "דרגה" (rank), not גביעים');
ok(tip().includes('450'), 'and counts the 450 remaining to יהלום');

// REWRITTEN 2026-07-26. This block asserted a LOCK on the badge, driven by atBotCeiling. That function
// became an unconditional `true` under the humans-only ruling, which latched the hatched meter and the
// 🔒 onto every badge carrying an injected botLevel. The lock is gone; the tooltip carries the message.
console.log('--- BOT MODES: no lock on the badge, but the tooltip is honest ---');
window.SALTIZ_RANK = { rankPoints: 460, delta: 0, botLevel: 5 };
rk.renderHubRank();
ok(!badge().classList.contains('hub-tier-capped'), 'a bot mode does NOT paint the badge as locked');
ok(tip().includes('רק משחק מול שחקנים אמיתיים מעלה דרגה'), 'the tooltip says only real players raise rank');
window.SALTIZ_RANK = { rankPoints: 459, delta: 0, botLevel: 5 };
rk.renderHubRank();
ok(!badge().classList.contains('hub-tier-capped'), 'and no difficulty paints it either — difficulty is not a rank lever');
window.SALTIZ_RANK = { rankPoints: 940, delta: 0, botLevel: 11 };
rk.renderHubRank();
ok(!badge().classList.contains('hub-tier-capped'), 'not at the hardest difficulty either');
// Regression guard on retired copy: "raise the difficulty" was the old nudge, and it must never come
// back — difficulty is no longer a rank lever at any level, so it would send the player nowhere.
ok(!tip().includes('העלה את רמת הקושי'), 'the retired "raise the difficulty" nudge never appears');
ok(tip().includes('שחקנים אמיתיים'), 'it says only real players raise your rank from here');

console.log('--- botLevel absence must not read as difficulty 0 ---');
// Number(null) === 0 and Number('') === 0, so a naive read turns "we were not told" into "difficulty 0".
// It used to matter because level 0 had the lowest ceiling and would have marked every player capped.
// The lock is gone, but the distinction still drives the TOOLTIP: with no botLevel we do not know the
// player is in a bot mode, so promising "only real players raise rank" would be a guess.
for (const missing of [null, undefined, '']) {
  window.SALTIZ_RANK = { rankPoints: 620, delta: 0, botLevel: missing };
  rk.renderHubRank();
  ok(!tip().includes('שחקנים אמיתיים'), `botLevel=${JSON.stringify(missing)} is UNKNOWN, so the bot-mode message is withheld`);
  ok(tip().includes('לדרגה הבאה'), `botLevel=${JSON.stringify(missing)} falls back to the progress-to-next-tier tooltip`);
}
window.SALTIZ_RANK = { rankPoints: 620, delta: 0, botLevel: 0 };
rk.renderHubRank();
ok(!badge().classList.contains('hub-tier-capped'), 'a real level 0 does not lock a 620-point player');
ok(tip().includes('שחקנים אמיתיים'), 'but a KNOWN level 0 does explain that only real players move rank');

console.log('--- a GAIN reveal ---');
window.SALTIZ_RANK = { rankPoints: 645, delta: 25, botLevel: 11 };
rk.playRankReveal(620, 645, 25);
const up = badge().querySelector('.rk-flash');
ok(!!up, 'a flash chip appears');
ok(up && !up.classList.contains('rk-flash-down'), 'a gain is NOT styled as a drop');
ok(up && up.textContent.includes('+25'), 'it reads +25');
ok(up && up.querySelector('[dir="ltr"]') !== null, 'the signed number is LTR-isolated');

console.log('--- a DROP reveal: muted, never celebratory ---');
badge().querySelectorAll('.rk-flash').forEach((n) => n.remove());
window.SALTIZ_RANK = { rankPoints: 612, delta: -8, botLevel: 11 };
rk.playRankReveal(620, 612, -8);
const down = badge().querySelector('.rk-flash');
ok(!!down, 'a chip appears on a loss too');
ok(down && down.classList.contains('rk-flash-down'), 'it carries the muted down style');
ok(down && down.textContent.includes('8'), 'it shows the amount');
ok(down && down.textContent.includes('−'), 'with a real minus sign (U+2212, not a hyphen)');
ok(!badge().classList.contains('hub-tier-promote'), 'a drop never triggers the promotion celebration');

console.log('--- a zero delta says nothing ---');
badge().querySelectorAll('.rk-flash').forEach((n) => n.remove());
window.SALTIZ_RANK = { rankPoints: 940, delta: 0, botLevel: 11 };
rk.playRankReveal(940, 940, 0);
ok(badge().querySelector('.rk-flash') === null, 'no chip for a 0 delta — nothing happened, so claim nothing');

console.log('--- bad injected data cannot break the badge ---');
window.SALTIZ_RANK = { rankPoints: 'abc' };
ok(rk.renderHubRank() === false, 'a non-numeric count is treated as no data rather than painting NaN');
window.SALTIZ_RANK = { rankPoints: -50, delta: 0, botLevel: null };
rk.renderHubRank();
ok(txt().includes('0'), 'a negative count clamps to 0');
ok(tip().includes('ברונזה'), 'and reads as ברונזה');

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
