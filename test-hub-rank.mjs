// DOM-level test for the hub trophy layer, driven through jsdom so the real element/class behaviour is
// verified without a browser (same approach as test-net-hud.mjs). The trophy NUMBERS are the server's
// and are covered in pikme-server/test-football-trophies.mjs; the ladder itself in test-trophies.mjs.
// This file checks what actually gets PAINTED — especially the case the XP reveal never had: a DROP.
import { JSDOM } from 'jsdom';

let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + '  ' + m); if (!c) fails++; };

const dom = new JSDOM(
  '<!doctype html><html><body><div class="hub">'
  + '<div class="hub-trwrap"><div id="hub-trophies" class="hub-trophies hidden"></div></div>'
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

const tr = await import('./public/hub-trophies.js');

const box = () => document.getElementById('hub-trophies');
const hub = () => document.querySelector('.hub');
const txt = () => box().textContent;

console.log('--- GRACEFUL DEGRADATION: no SALTIZ_TROPHIES (old app build) ---');
delete window.SALTIZ_TROPHIES;
tr.renderHubTrophies();
ok(box().classList.contains('hidden'), 'the trophy box stays hidden with no injected data');
ok(!hub().classList.contains('has-trophies'), 'the hub does NOT get has-trophies, so the XP bar keeps its original slot');
ok(tr.trophyState() === null, 'trophyState() reports nothing to show');

console.log('--- renders an injected count ---');
window.SALTIZ_TROPHIES = { trophies: 620, delta: 0, botLevel: 11 };
tr.renderHubTrophies();
ok(!box().classList.contains('hidden'), 'the box becomes visible');
ok(hub().classList.contains('has-trophies'), 'the hub gains has-trophies so the XP bar shifts down');
ok(txt().includes('620'), 'the count is shown');
ok(txt().includes('גביעים'), 'labelled גביעים');
ok(txt().includes('זהב'), '620 shows the זהב tier');
ok(box().querySelector('.tr-bar > b').style.width === '30%', 'the bar fills 30% through gold (500→900)');

console.log('--- tier badge tracks the tier ---');
window.SALTIZ_TROPHIES = { trophies: 0, delta: 0, botLevel: 0 };
tr.renderHubTrophies();
ok(txt().includes('ברונזה'), '0 trophies = ברונזה');
window.SALTIZ_TROPHIES = { trophies: 3500, delta: 0, botLevel: null };
tr.renderHubTrophies();
ok(txt().includes('אגדה'), '3500 = אגדה');
ok(txt().includes('הדרגה הגבוהה ביותר'), 'the top tier says so instead of counting to a next tier');
ok(box().querySelector('.tr-bar > b').style.width === '100%', "legend's bar reads FULL, not empty");

console.log('--- the bot-ceiling nudge (the whole point of the ceiling rule) ---');
window.SALTIZ_TROPHIES = { trophies: 460, delta: 0, botLevel: 5 };
tr.renderHubTrophies();
ok(txt().includes('העלה את רמת הקושי'), 'at the L5 ceiling the player is told to raise the difficulty');
window.SALTIZ_TROPHIES = { trophies: 459, delta: 0, botLevel: 5 };
tr.renderHubTrophies();
ok(!txt().includes('העלה את רמת הקושי'), 'one trophy below the ceiling there is no nudge');
ok(txt().includes('עוד'), 'instead it counts down to the next tier');
window.SALTIZ_TROPHIES = { trophies: 940, delta: 0, botLevel: 11 };
tr.renderHubTrophies();
ok(!txt().includes('העלה את רמת הקושי'), 'at the TOP difficulty it must NOT say "raise the difficulty" — there is none higher');
ok(txt().includes('שחקנים אמיתיים'), 'it says only real players raise your rank from here');
window.SALTIZ_TROPHIES = { trophies: 3500, delta: 0, botLevel: 11 };
tr.renderHubTrophies();
ok(txt().includes('שחקנים אמיתיים'), 'same for a legend player grinding max-level bots');

console.log('--- a GAIN reveal ---');
window.SALTIZ_TROPHIES = { trophies: 645, delta: 25, botLevel: 11 };
tr.playTrophyReveal(620, 645, 25);
const upChip = box().querySelector('.tr-flash');
ok(!!upChip, 'a flash chip appears');
ok(!upChip.classList.contains('tr-flash-down'), 'a gain is NOT styled as a drop');
ok(upChip.textContent.includes('+25'), 'it reads +25');
ok(upChip.querySelector('[dir="ltr"]') !== null, 'the signed number is LTR-isolated so the sign stays on the correct side in RTL');

console.log('--- a DROP reveal: muted, never celebratory ---');
box().innerHTML = '';
window.SALTIZ_TROPHIES = { trophies: 612, delta: -8, botLevel: 11 };
tr.playTrophyReveal(620, 612, -8);
const downChip = box().querySelector('.tr-flash');
ok(!!downChip, 'a flash chip appears on a loss too');
ok(downChip.classList.contains('tr-flash-down'), 'it carries the muted down style');
ok(downChip.textContent.includes('8'), 'it shows the amount');
ok(downChip.textContent.includes('−'), 'with a minus sign (U+2212, not a hyphen)');
ok(!hub().classList.contains('tr-promote'), 'a drop never triggers the promotion celebration');

console.log('--- a zero delta (bot match at the ceiling) says nothing ---');
box().innerHTML = '';
window.SALTIZ_TROPHIES = { trophies: 940, delta: 0, botLevel: 11 };
tr.playTrophyReveal(940, 940, 0);
ok(box().querySelector('.tr-flash') === null, 'no chip for a 0 delta — nothing happened, so claim nothing');

console.log('--- bad injected data cannot break the hub ---');
window.SALTIZ_TROPHIES = { trophies: 'abc' };
tr.renderHubTrophies();
ok(box().classList.contains('hidden'), 'a non-numeric count is treated as no data rather than rendering NaN');
window.SALTIZ_TROPHIES = { trophies: -50, delta: 0, botLevel: 0 };
tr.renderHubTrophies();
ok(txt().includes('0') && txt().includes('ברונזה'), 'a negative count clamps to 0 / ברונזה');

console.log('--- botLevel absence must not read as difficulty 0 ---');
// Number(null) === 0 and Number('') === 0, so a blank level would look like difficulty 0, whose
// ceiling is 60 — that would show the "raise the difficulty" nudge to essentially every player.
for (const missing of [null, undefined, '']) {
  window.SALTIZ_TROPHIES = { trophies: 620, delta: 0, botLevel: missing };
  tr.renderHubTrophies();
  ok(!txt().includes('העלה את רמת הקושי'), `botLevel=${JSON.stringify(missing)} is treated as UNKNOWN, not level 0`);
}
window.SALTIZ_TROPHIES = { trophies: 620, delta: 0, botLevel: 0 };
tr.renderHubTrophies();
ok(txt().includes('העלה את רמת הקושי'), 'a real level 0 (ceiling 60) still nudges a 620-trophy player');

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
