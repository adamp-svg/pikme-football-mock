// DOM-level test for the hub RANK layer, driven through jsdom so the real element/class behaviour is
// verified without a browser (same approach as test-net-hud.mjs). The rank NUMBERS are the server's and
// are covered by pikme-server/test-football-rank.mjs; the ladder itself by test-rank.mjs. This file
// checks what actually gets PAINTED into the badge over the hero — especially the case the XP reveal
// never had to handle: the number going DOWN.
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + '  ' + m); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
// The RANKED MODE rule + the לא מדורג copy live here, and the badge must not keep a second copy of
// either. Imported so a drift fails THIS file rather than shipping two different Hebrew labels.
const ranked = await import('./shared/ranked.js');

// RED-run guard: the new exports do not exist yet on the first (deliberately failing) run, and calling
// `undefined(...)` would abort the file instead of COUNTING the failures. Same trick the rank-core seat
// used in test-football-upset.mjs. Harmless once everything is implemented.
const F = (n) => (typeof rk[n] === 'function' ? rk[n] : () => undefined);
const V = (n) => rk[n];

const badge = () => document.getElementById('hub-tier');
const meter = () => document.getElementById('hub-tier-fill');
const txt = () => badge().textContent;
const tip = () => badge().title || '';
// The chip layer. It is deliberately NOT inside #hub-tier — see the clip-path block below.
const chips = () => document.getElementById('hub-tier-chips');
const chipTxt = () => (chips() ? chips().textContent : '');
const clearChips = () => { if (chips()) chips().innerHTML = ''; };
const RANK_CSS = readFileSync(new URL('./public/rank.css', import.meta.url), 'utf8');

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
window.SALTIZ_RANK = { rankPoints: 950, delta: 0, botLevel: null };
rk.renderHubRank();
ok(tip().includes('פלטינה'), '950 = פלטינה');
ok(tip().includes('דרגה'), 'the tooltip names the track "דרגה" (rank), not גביעים');
ok(tip().includes('450'), 'and counts the 450 remaining to יהלום');
// REWRITTEN 2026-07-26: "0 = ברונזה" was the LIE this slice exists to delete. Under the humans-only
// ruling a player at 0 points has never earned a rank point, so 0 is לא מדורג, not the bottom rung.
// The bronze branch is still reachable and still asserted — by a player who has PLAYED ranked (below).
window.SALTIZ_RANK = { rankPoints: 0, delta: 0, botLevel: null };
rk.renderHubRank();
ok(!tip().includes('ברונזה'), '0 points is NOT ברונזה any more — nobody starts on the ladder');
window.SALTIZ_RANK = { rankPoints: 30, delta: 0, botLevel: null, rankedMatches: 4 };
rk.renderHubRank();
ok(tip().includes('ברונזה'), '30 points after 4 ranked matches IS ברונזה');

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

// ══════════════════════════════════════════════════════════════════════════════════════════════
// NEW 2026-07-26 — STATE 1 of 3: לא מדורג (UNRANKED)
// Rank is earned ONLY in ranked events, humans only (spec §1). Every player today renders ברונזה 0,
// which is a lie for the ~87% of the base that has never played a ranked match.
// ══════════════════════════════════════════════════════════════════════════════════════════════
console.log('--- UNRANKED: 0 points = לא מדורג, with its own visual treatment ---');
window.SALTIZ_RANK = { rankPoints: 0, delta: 0, botLevel: null };
ok(rk.renderHubRank() === true, 'unranked still TAKES the badge — it is a state, not an absence of data');
ok(badge().classList.contains('hub-tier-unranked'), 'the badge carries its own hub-tier-unranked state class');
ok(badge().classList.contains('hub-tier-rank'), 'and still opts into the rank layout so the box does not reflow');
ok(txt().includes('לא מדורג'), 'the Hebrew label is on the badge, not only in the tooltip');
ok(badge().querySelector('.px-unr') !== null, 'a dashed pixel-shield glyph element is rendered');
ok(badge().querySelector('.px-ic') === null, 'and NO emoji: ❔/🥉 both read as a reward the player owns');
ok(badge().style.getPropertyValue('--c1') === '#d4dae0', 'greyscale c1 per spec §4');
ok(badge().style.getPropertyValue('--c2') === '#8a939c', 'greyscale c2 per spec §4');
ok(meter().style.width === '0%', 'the meter carries NO fill — a 0%-wide SOLID bar is pixel-identical to "ברונזה, no progress"');
ok(tip().includes('לא מדורג'), 'the tooltip names the state');
ok(tip().includes('3 משחקי דירוג'), 'and the tooltip says HOW to become ranked (3 placement matches)');
ok(!badge().classList.contains('hub-tier-capped'), 'unranked never also paints the 🔒 — two states stacked at 50×42px is noise');
ok((V('UNRANKED_HE') || '') === 'לא מדורג', 'UNRANKED_HE is exported so copy cannot drift');

console.log('--- UNRANKED: the discriminator is BOTH halves of spec §4 ---');
// §4: unranked = (rankedMatches|0) === 0 && (rankPoints|0) === 0. Dropping the second half would
// de-badge every legacy account seedRankFromXp already placed.
window.SALTIZ_RANK = { rankPoints: 640, delta: 0, botLevel: null, rankedMatches: 0 };
rk.renderHubRank();
ok(!badge().classList.contains('hub-tier-unranked'), 'a legacy account seeded to 640 with 0 ranked matches is NOT unranked');
ok(tip().includes('זהב'), 'it reads זהב, unmarked — "nobody is reduced"');
window.SALTIZ_RANK = { rankPoints: 0, delta: 0, botLevel: null, rankedMatches: 7 };
rk.renderHubRank();
ok(!badge().classList.contains('hub-tier-unranked'), 'a player who PLAYED 7 ranked matches and sits at 0 is ranked, not unranked');
window.SALTIZ_RANK = { rankPoints: 0, delta: 0, botLevel: null, rankedMatches: 0 };
rk.renderHubRank();
ok(badge().classList.contains('hub-tier-unranked'), 'both zeros = unranked');
window.SALTIZ_RANK = { rankPoints: -50, delta: 0, botLevel: null };
rk.renderHubRank();
ok(badge().classList.contains('hub-tier-unranked'), 'a negative injected count clamps to 0, which is unranked (was: "reads as ברונזה")');
ok(!txt().includes('NaN'), 'and never paints NaN');

console.log('--- UNRANKED: inferred WITHOUT any new injected field, and from an explicit one when present ---');
// rankState() reads window.SALTIZ_RANK, injected by an app build we do not own and which is OFF our
// release train. So the state must be inferable from what is ALREADY in the shape.
window.SALTIZ_RANK = { rankPoints: 0, delta: 0, botLevel: 11 };
rk.renderHubRank();
ok(badge().classList.contains('hub-tier-unranked'), 'inferred from rankPoints alone on TODAY\'s injected shape');
window.SALTIZ_RANK = { rankPoints: 0, rankTier: 'unranked', delta: 0 };
rk.renderHubRank();
ok(badge().classList.contains('hub-tier-unranked'), 'rankTier:"unranked" is an EXISTING field carrying a NEW value — no new inject needed');
window.SALTIZ_RANK = { rankTier: 'unranked', delta: 0 };
rk.renderHubRank();
ok(badge().classList.contains('hub-tier-unranked'), 'and it works with no rankPoints at all — there is no number to show anyway');
window.SALTIZ_RANK = { rankPoints: 0, rankKnown: false, delta: 0 };
rk.renderHubRank();
ok(badge().classList.contains('hub-tier-unranked'), 'rankKnown:false (a token minted with no stats doc) also reads unranked');
window.SALTIZ_RANK = { rankPoints: 'abc' };
ok(rk.renderHubRank() === false, 'garbage with NO unranked signal is still "we do not know" → legacy XP badge');
ok(!badge().classList.contains('hub-tier-unranked'), 'and the dashed state does not survive into the legacy render');
ok(!badge().classList.contains('hub-tier-rank'), 'nor does the rank layout — client.js only clears the two classes it knows about');

console.log('--- PLACEMENTS: דירוג 2/3 while the badge is still withheld ---');
window.SALTIZ_RANK = { rankPoints: 0, delta: 0, rankedMatches: 2 };
rk.renderHubRank();
ok(badge().classList.contains('hub-tier-unranked'), 'mid-placements is the SAME visual state — one dashed treatment, two labels');
ok(txt().includes('דירוג'), 'the label switches to דירוג');
ok(txt().includes('2/3'), 'and shows the placement progress');
ok(badge().querySelector('[dir="ltr"]') !== null, '2/3 is LTR-isolated so it does not render as 3/2 in the RTL run');
ok(tip().includes('עוד'), 'the tooltip counts what is left');
ok((V('PLACEMENTS') | 0) === 3, 'PLACEMENTS = 3 (Rocket League / spec §3)');
// The badge is withheld until 3 are played even once points EXIST — spec §3, "badge hidden until 3 are
// played". `inPlacements` needs rankedMatches >= 1, so a legacy seed (0 matches, 640 points) is never
// caught by this and never gets told it is unplaced.
window.SALTIZ_RANK = { rankPoints: 240, delta: 0, rankedMatches: 2 };
rk.renderHubRank();
ok(badge().classList.contains('hub-tier-unranked'), 'points earned mid-placements do NOT reveal the badge early');
ok(!txt().includes('240'), 'the number is withheld with it');
window.SALTIZ_RANK = { rankPoints: 240, delta: 0, rankedMatches: 3 };
rk.renderHubRank();
ok(!badge().classList.contains('hub-tier-unranked'), 'the 3rd placement reveals it');
ok(txt().includes('240'), 'and the points appear');

console.log('--- STEP 9: points can outrun the badge, and the meter must not lie about it ---');
// 499 + 105 = 604 buys gold POINTS through one max upset, but the badge is the ratcheted floor until 3
// matches confirm the entry. A 26%-through-gold meter would advertise a tier the player does not hold.
window.SALTIZ_RANK = { rankPoints: 604, rankPointsRaw: 604, rankFloor: 1, floorProgress: 1, delta: 0 };
rk.renderHubRank();
ok(tip().includes('כסף'), 'the badge reads the CONFIRMED floor (כסף), not the points tier (זהב)');
ok(!tip().startsWith('דרגה: זהב'), 'the badge does not CLAIM זהב — it is named only as the tier being confirmed');
ok(meter().style.width === '100%', 'and the meter is FULL — promotion pending, not 26% through a tier it is not in');
ok(tip().includes('לאישור זהב'), 'the tooltip says what is actually needed: confirmations of זהב');
ok(!tip().includes('296'), 'and NOT a 296-point countdown toward פלטינה, a tier this player is two rungs from');
const stPromo = rk.rankState();
ok(stPromo && stPromo.promoting === true, 'rankState() reports promoting');
ok(stPromo && stPromo.promoNeeded === 2, 'and how many confirmations are left');
// Step 8 with a real floor: the display is max(raw, TIER_MIN[floor]).
window.SALTIZ_RANK = { rankPoints: 1400, rankPointsRaw: 1374, rankFloor: 4, delta: 0 };
rk.renderHubRank();
ok(txt().includes('1400'), 'a raw ledger under the floor still displays the floor');
ok(tip().includes('יהלום'), 'so the badge holds יהלום');
ok(rk.rankState().debt === 26, 'and the 26-point debt is exposed rather than hidden');
// …and the SAME shapes with rankPeak alongside them: the peak only ever CAPS the floor, so an honest
// badge is untouched by supplying it.
window.SALTIZ_RANK = { rankPoints: 1400, rankPointsRaw: 1374, rankPeak: 1400, rankFloor: 4, delta: 0 };
rk.renderHubRank();
ok(txt().includes('1400'), 'an honest יהלום is unchanged when rankPeak comes with the floor');
ok(tip().includes('יהלום'), 'badge still יהלום');
// THE REPAIR (2026-07-26): a stored floor was authoritative on its own, so a doc whose points were wiped
// underneath its badge repainted אגדה here — client-side, with an empty ledger and no match involved.
// footballPublicStats ships rankFloor, so this shape is reachable. The peak is the evidence that stops it.
window.SALTIZ_RANK = { rankPoints: 0, rankPointsRaw: 0, rankPeak: 0, rankFloor: 6, delta: 0 };
rk.renderHubRank();
ok(!tip().includes('אגדה'), 'a wiped standing does NOT paint אגדה off a bare floor');
ok(!txt().includes('3200'), 'and does not resurrect 3,200 points that no longer exist');

// ══════════════════════════════════════════════════════════════════════════════════════════════
// NEW — STATE 3 of 3: "this mode pays no rank". hub-tier-capped exists in rank.css and was applied by
// NOTHING after atBotCeiling was deleted. It is now driven by the REAL mode signal — shared/ranked.js
// rankLockedForMode — whose default is "paint nothing", because painting a lock on ignorance is exactly
// the bug atBotCeiling shipped.
// ══════════════════════════════════════════════════════════════════════════════════════════════
console.log('--- THREE STATES at 50×42px, and the lock is never painted on a guess ---');
window.SALTIZ_RANK = { rankPoints: 640, delta: 0, botLevel: 11 };
rk.renderHubRank();
ok(!badge().classList.contains('hub-tier-capped'), 'default (no mode set) = no lock, at any botLevel');
F('setRankMode')('quick');
ok(badge().classList.contains('hub-tier-capped'), 'quick match is a NAMED unranked mode, so it DOES paint the lock');
ok(!badge().classList.contains('hub-tier-unranked'), 'and it is not confused with unranked — you still ARE זהב');
ok(txt().includes('640'), 'the points stay visible: only the PROGRESS affordance is suspended');
ok(tip().includes('לא מזיז דרגה'), 'the tooltip says this mode cannot move rank');
for (const m of ['brawl', '3v3', 'training', 'builder', 'botgame', 'private', 'party']) {
  F('setRankMode')(m);
  ok(badge().classList.contains('hub-tier-capped'), `${m} pays no rank, so it locks`);
}
F('setRankMode')(ranked.RANKED_MODE);
ok(!badge().classList.contains('hub-tier-capped'), 'the ranked mode itself clears it');
F('setRankMode')('quick');
F('setRankMode')(null);
ok(!badge().classList.contains('hub-tier-capped'), 'and an UNSET mode clears it too — ignorance is not a lock');
F('setRankMode')('some-future-mode-nobody-listed');
ok(!badge().classList.contains('hub-tier-capped'), 'nor does a mode shared/ranked.js cannot NAME (the atBotCeiling failure mode)');
F('setRankMode')(null);
window.SALTIZ_RANK = { rankPoints: 0, delta: 0 };
F('setRankMode')('quick');
rk.renderHubRank();
ok(!badge().classList.contains('hub-tier-capped'), 'unranked + pays-nothing shows only the dashed state — the 🔒 would be pure noise');
F('setRankMode')(null);
// The mode may also ride on the injected object, for whoever writes SALTIZ_RANK themselves.
window.SALTIZ_RANK = { rankPoints: 640, delta: 0, mode: 'brawl' };
rk.renderHubRank();
ok(badge().classList.contains('hub-tier-capped'), 'an injected `mode` is honoured as a fallback carrier');
window.SALTIZ_RANK = { rankPoints: 640, delta: 0 };
rk.renderHubRank();

console.log('--- NO COPY DRIFT: the labels come from shared/ranked.js, not from a second literal ---');
ok(V('UNRANKED_HE') === ranked.RANK_UNRANKED_HE, 'UNRANKED_HE is shared/ranked.js RANK_UNRANKED_HE');
ok((V('PLACEMENTS') | 0) === ranked.RANKED_PLACEMENTS, 'PLACEMENTS is shared/ranked.js RANKED_PLACEMENTS');
window.SALTIZ_RANK = { rankPoints: 0, delta: 0 };
rk.renderHubRank();
ok(tip().includes(ranked.RANKED_UNRANKED_SUB_HE), 'and the how-to-get-ranked sub-line is the spec string from shared/ranked.js');

// ══════════════════════════════════════════════════════════════════════════════════════════════
// NEW — THE GAP CHIP. Spec §1: "Ship the chip or don't ship the table." A win paying anywhere from +4
// to +105 with no explanation reads as randomness.
// ══════════════════════════════════════════════════════════════════════════════════════════════
console.log('--- the gap labels, spec §1 verbatim ---');
const GAP_EXPECT = [
  [-4, '4 דרגות מתחתיך'], [-3, '3 דרגות מתחתיך'], [-2, '2 דרגות מתחתיך'], [-1, 'דרגה מתחתיך'],
  [0, 'דרגה שווה'],
  [1, 'דרגה מעליך'], [2, '2 דרגות מעליך'], [3, '3 דרגות מעליך'], [4, '4 דרגות מעליך'],
];
for (const [g, he] of GAP_EXPECT) ok(F('gapLabelHe')(g) === he, `g=${g} → "${he}"`);
ok(F('gapLabelHe')(-9) === '4 דרגות מתחתיך', 'g clamps at −4 (the table itself clamps ±4)');
ok(F('gapLabelHe')(9) === '4 דרגות מעליך', 'g clamps at +4');
// g is FRACTIONAL by design (integer buckets put a +20 cliff on a 1-point difference at 899 vs 900).
// "Display rounded" — spec §1.
ok(F('gapLabelHe')(2.4) === '2 דרגות מעליך', 'a fractional g=2.40 displays as the 2 bucket');
ok(F('gapLabelHe')(2.6) === '3 דרגות מעליך', 'and g=2.60 rounds up to the 3 bucket');
ok(F('gapLabelHe')(-2.9975) === '3 דרגות מתחתיך', 'the real gold-vs-bronze g=−2.9975 displays as 3, not 4');
ok(F('gapLabelHe')(NaN) === null, 'an unknown g has NO label — a wrong explanation is worse than none');

console.log('--- the ×multiplier column, spec §1 ---');
const MULT_EXPECT = [[-4, 0.16], [-3, 0.24], [-2, 0.36], [-1, 0.6], [0, 1], [1, 1.8], [2, 2.6], [3, 3.4], [4, 4.2]];
for (const [g, m] of MULT_EXPECT) ok(F('gapMult')(g) === m, `g=${g} → ×${m} vs the even win`);
ok(F('gapMultText')(2) === '×2.6', 'formatted for the chip');
ok(F('gapMultText')(-2) === '×0.36', 'and below the even row it keeps 2 decimals rather than rounding to ×0.4');
ok(F('gapMultText')(0) === null, 'g=0 has NO multiplier text — "×1" at 50×42px is pure noise');

// ══════════════════════════════════════════════════════════════════════════════════════════════
// NEW — THE TRANSITION. unranked → ranked is a PROMOTION, not a count-up from 0.
// ══════════════════════════════════════════════════════════════════════════════════════════════
console.log('--- unranked → ranked is a promotion moment, not a tween from 0 ---');
await sleep(40);
badge().classList.remove('hub-tier-promote');
clearChips();
window.SALTIZ_RANK = { rankPoints: 0, delta: 0, botLevel: null, rankedMatches: 0 };
rk.renderHubRank();
ok(badge().classList.contains('hub-tier-unranked'), 'start unranked');
rk.armRankReveal();
window.SALTIZ_RANK = { rankPoints: 240, delta: 25, botLevel: null, rankedMatches: 3, g: 1, gKnown: true };
rk.pollRank();
ok(!badge().classList.contains('hub-tier-unranked'), 'the dashed state is gone');
ok(txt().includes('240'), 'the FINAL number is on the badge immediately — there was no 0 to count up from');
ok(!txt().includes('לא מדורג'), 'and the label is gone with it');
ok(F('isRevealing')() !== true, 'no count-up tween is running (a tween would claim the player earned 240 this match)');
ok(badge().classList.contains('hub-tier-promote'), 'it gets the promotion celebration instead');
ok(chipTxt().includes('דרגה מעליך'), 'and the gap chip explains the first settle');

console.log('--- the DISPLAY never drops even while the raw ledger does ---');
// Step 8: rankPoints (displayed) = max(rankPointsRaw, TIER_MIN[rankFloor]). A thrown loss at a tier
// entry moves the LEDGER and not the badge. Showing nothing would re-create the "zero stakes" feeling
// the unfloored ledger exists to remove; moving the number would break "the badge never drops".
await sleep(40);
badge().classList.remove('hub-tier-promote');
clearChips();
window.SALTIZ_RANK = { rankPoints: 1400, delta: 0, botLevel: null, rankedMatches: 30, rankPointsRaw: 1400 };
rk.renderHubRank();
ok(tip().includes('יהלום'), 'a יהלום at the tier entry');
rk.armRankReveal();
window.SALTIZ_RANK = { rankPoints: 1400, delta: -26, botLevel: null, rankedMatches: 31, rankPointsRaw: 1374, g: 4, gKnown: true };
rk.pollRank();
ok(txt().includes('1400'), 'the badge number does NOT move — the floor is holding it');
ok(tip().includes('יהלום'), 'and the tier is unchanged');
ok(!badge().classList.contains('hub-tier-promote'), 'a loss never celebrates');
ok(chipTxt().includes('26'), 'but the chip reports the real −26 — the ledger moved, so say so');
const heldChip = chips() && chips().querySelector('.rk-flash-down');
ok(!!heldChip, 'and it is the muted DOWN treatment');
ok(chipTxt().includes('הדרגה נשמרת'), 'plus a chip saying the rank itself is protected');
ok(F('isRevealing')() !== true, 'nothing is tweening: from === to');
const stHeld = rk.rankState();
ok(stHeld && stHeld.floorHeld === true, 'rankState() exposes floorHeld so the tooltip/chip can explain it');
ok(tip().includes('מוגנת') || tip().includes('נשמרת'), 'the tooltip says the rank is protected');

console.log('--- the chip RENDERS on the post-match reveal ---');
clearChips();
window.SALTIZ_RANK = { rankPoints: 580, delta: 80, botLevel: null, rankedMatches: 9, g: 4, gKnown: true };
rk.playRankReveal(500, 580, 80, rk.rankState());
ok(chips() !== null, 'a chip layer exists');
ok(chipTxt().includes('4 דרגות מעליך'), 'the gap chip explains the gap in Hebrew');
ok(chipTxt().includes('×4.2'), 'and shows the multiplier that produced the number');
const gapEl = chips() && chips().querySelector('.rk-gap');
ok(!!gapEl, 'the gap chip has its own class');
ok(gapEl && gapEl.querySelector('[dir="ltr"]') !== null, 'every number inside it is LTR-isolated');
ok(chipTxt().includes('+80'), 'the +N flash chip is there too — WHAT happened above, WHY below');

console.log('--- the meeting-decay chip: יריב חוזר · 60% ---');
clearChips();
window.SALTIZ_RANK = { rankPoints: 595, delta: 15, botLevel: null, rankedMatches: 9, g: 0, gKnown: true, meetRate: 0.6 };
rk.playRankReveal(580, 595, 15, rk.rankState());
ok(chipTxt().includes('יריב חוזר'), 'the repeat-opponent chip appears when the decay bit');
ok(chipTxt().includes('60%'), 'and names the rate');
const meetEl = chips() && chips().querySelector('.rk-gap-meet');
ok(meetEl && meetEl.querySelector('[dir="ltr"]') !== null, 'the percentage is LTR-isolated');
ok(chipTxt().includes('דרגה שווה'), 'an even match still gets its label — silence would read as randomness');
ok(!chipTxt().includes('×1'), 'but no ×1 multiplier');
clearChips();
window.SALTIZ_RANK = { rankPoints: 610, delta: 15, botLevel: null, rankedMatches: 9, meetings: 2 };
rk.playRankReveal(595, 610, 15, rk.rankState());
ok(chipTxt().includes('60%'), 'a 1-based `meetings` count maps through MEET_RATES [1, .6, .3, 0] too');
clearChips();
window.SALTIZ_RANK = { rankPoints: 625, delta: 15, botLevel: null, rankedMatches: 9, meetings: 1 };
rk.playRankReveal(610, 625, 15, rk.rankState());
ok(!chipTxt().includes('יריב חוזר'), 'a FIRST meeting pays 100% and says nothing');

console.log('--- with no receipt (what ships today) the chip claims NOTHING ---');
// HARD CONSTRAINT: opponent tier is not on the wire yet, so the server settles at g=0 with gKnown
// false. Rendering "דרגה שווה" then would be a fabricated explanation.
clearChips();
window.SALTIZ_RANK = { rankPoints: 650, delta: 25, botLevel: null, rankedMatches: 9, g: 0, gKnown: false };
rk.playRankReveal(625, 650, 25, rk.rankState());
ok(!chipTxt().includes('דרגה שווה'), 'gKnown:false → no gap chip');
ok(chipTxt().includes('+25'), 'the delta itself is still shown');
clearChips();
window.SALTIZ_RANK = { rankPoints: 675, delta: 25, botLevel: null, rankedMatches: 9 };
rk.playRankReveal(650, 675, 25, rk.rankState());
ok(!chipTxt().includes('דרגה'), 'no g field at all → no gap chip either');

console.log('--- clip-path regression: chips must NOT be children of the badge ---');
// style.css .hub-tier carries a clip-path for its notched pixel corners, and clip-path clips
// DESCENDANTS. A chip parented to the badge is therefore invisible the instant it leaves the 50×42px
// box — which is where every chip lives (the flash sits at top:-12px). The badge is also z-index 3
// UNDER the hero (z4), so the layer needs its own stacking context.
ok(chips() && chips().parentNode === badge().parentNode, 'the chip layer is a SIBLING of #hub-tier');
ok(badge().querySelector('.rk-gap') === null, 'no gap chip inside the clipped badge');
ok(badge().querySelector('.rk-flash') === null, 'no flash chip inside the clipped badge either');
ok(/\.rk-chips[^{]*\{[^}]*z-index/.test(RANK_CSS), 'and rank.css gives the layer a z-index so it paints over the hero');

console.log('--- a GAIN reveal ---');
clearChips();
window.SALTIZ_RANK = { rankPoints: 645, delta: 25, botLevel: 11 };
rk.playRankReveal(620, 645, 25);
const up = chips() && chips().querySelector('.rk-flash');
ok(!!up, 'a flash chip appears');
ok(up && !up.classList.contains('rk-flash-down'), 'a gain is NOT styled as a drop');
ok(up && up.textContent.includes('+25'), 'it reads +25');
ok(up && up.querySelector('[dir="ltr"]') !== null, 'the signed number is LTR-isolated');

console.log('--- a DROP reveal: muted, never celebratory ---');
clearChips();
badge().classList.remove('hub-tier-promote');
window.SALTIZ_RANK = { rankPoints: 612, delta: -8, botLevel: 11 };
rk.playRankReveal(620, 612, -8);
const down = chips() && chips().querySelector('.rk-flash');
ok(!!down, 'a chip appears on a loss too');
ok(down && down.classList.contains('rk-flash-down'), 'it carries the muted down style');
ok(down && down.textContent.includes('8'), 'it shows the amount');
ok(down && down.textContent.includes('−'), 'with a real minus sign (U+2212, not a hyphen)');
ok(!badge().classList.contains('hub-tier-promote'), 'a drop never triggers the promotion celebration');

console.log('--- a zero delta says nothing ---');
clearChips();
window.SALTIZ_RANK = { rankPoints: 940, delta: 0, botLevel: 11 };
rk.playRankReveal(940, 940, 0);
ok(!chipTxt().includes('+') && !chipTxt().includes('−'), 'no chip for a 0 delta — nothing happened, so claim nothing');

console.log('--- rank.css carries the three states, and hub-tier-capped survives ---');
ok(RANK_CSS.includes('.hub-tier-unranked'), 'rank.css styles the unranked state');
ok(/hub-tier-unranked[\s\S]{0,900}dashed/.test(RANK_CSS), 'with a DASHED treatment, not merely different text');
ok(RANK_CSS.includes('#d4dae0') && RANK_CSS.includes('#8a939c'), 'and the spec\'s greyscale pair is in the stylesheet');
ok(RANK_CSS.includes('.px-unr'), 'the dashed pixel-shield glyph is drawn in CSS (no emoji, no image request)');
ok(RANK_CSS.includes('.hub-tier-capped'), 'hub-tier-capped is still defined — the state is real and now reachable');
ok(RANK_CSS.includes('.rk-gap'), 'and the gap chip has styles');
ok(/prefers-reduced-motion[\s\S]*rk-gap|rk-gap[\s\S]*prefers-reduced-motion/.test(RANK_CSS), 'reduced-motion is honoured for the new chips too');

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
