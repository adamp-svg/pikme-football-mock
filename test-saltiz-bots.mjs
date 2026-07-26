// The four named SALTIZ bot friends (shared/saltiz-bots.js) — the roster the friends panel searches
// and the server resolves `addBot { botId }` against.
//
// What matters here, in order:
//   §1 the roster the user specified: אורי 5 · פז 7 · נווה 8 · שובל 11
//   §2 display רמה → bot-difficulty index is level−1 (the displayLevelForBot convention). Off by one
//      and שובל plays a rung below what his card says.
//   §3 the 3 power slots are LEVEL-APPROPRIATE — inside that level's CARD_POWER_BAND, with the
//      guaranteed legendaries the ramp promises.
//   §4 the roll is STABLE and SEEDED PER BOT: the client draws the friend card and the server rolls the
//      match loadout independently, so if these two disagreed the cards shown would not be the cards
//      played — and no test would notice.
//   §5 search finds them by the substrings a player actually types.
import assert from 'node:assert';
import { SALTIZ_BOTS, SALTIZ_BOT_BY_ID, botLevelOf, xpForSaltizBot, saltizBotLoadout, searchSaltizBots } from './shared/saltiz-bots.js';
import { RARITY_BY_LEVEL, CARD_POWER_BAND, RARITY_BUFF_PCT } from './shared/bot-buffs.js';
import { displayLevelForBot, xpForBotLevel } from './shared/difficulty.js';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); pass++; };

// §1 — the roster, exactly as specified.
const WANT = [['אורי', 5], ['פז', 7], ['נווה', 8], ['שובל', 11]];
eq(SALTIZ_BOTS.length, WANT.length, '§1 four bots');
for (const [name, level] of WANT) {
  const bot = SALTIZ_BOTS.find((b) => b.nickName === name);
  ok(bot, `§1 ${name} is in the roster`);
  eq(bot.level, level, `§1 ${name} display level`);
  ok(/^#[0-9a-f]{6}$/i.test(bot.color), `§1 ${name} has an avatar colour`);
  eq(SALTIZ_BOT_BY_ID.get(bot.id), bot, `§1 ${name} resolves by id`);
}
eq(new Set(SALTIZ_BOTS.map((b) => b.id)).size, SALTIZ_BOTS.length, '§1 ids are unique');

// §2 — display רמה vs the 0-based difficulty index, both directions.
for (const b of SALTIZ_BOTS) {
  eq(botLevelOf(b), b.level - 1, `§2 ${b.nickName} botLevel = רמה − 1`);
  eq(displayLevelForBot(botLevelOf(b)), b.level, `§2 ${b.nickName} round-trips through displayLevelForBot`);
  eq(xpForSaltizBot(b), xpForBotLevel(botLevelOf(b)), `§2 ${b.nickName} XP is on the shared curve`);
}
eq(botLevelOf({ level: 11 }), 10, '§2 שובל sits at difficulty index 10');
eq(botLevelOf({ level: 1 }), 0, '§2 רמה 1 clamps to 0');
eq(botLevelOf({ level: 99 }), 11, '§2 above the ladder clamps to the top');

// §3 — the cards fit the level.
const bp = (lo) => lo.reduce((s, x) => s + (x ? Math.round(RARITY_BUFF_PCT[x.r] * 100) : 0), 0);
for (const b of SALTIZ_BOTS) {
  const L = botLevelOf(b);
  const lo = saltizBotLoadout(b);
  eq(lo.length, 3, `§3 ${b.nickName} has exactly 3 slots`);
  const [loPct, hiPct] = CARD_POWER_BAND[L];
  const total = bp(lo);
  ok(total >= Math.round(loPct * 100) && total <= Math.round(hiPct * 100),
    `§3 ${b.nickName} power ${total}bp inside band [${Math.round(loPct * 100)},${Math.round(hiPct * 100)}]`);
  const legs = lo.filter((s) => s && s.r === 'legendary').length;
  ok(legs >= RARITY_BY_LEVEL[L].leg, `§3 ${b.nickName} keeps its ${RARITY_BY_LEVEL[L].leg} guaranteed legendaries (has ${legs})`);
  for (const s of lo.filter(Boolean)) {
    ok(['common', 'rare', 'epic', 'legendary'].includes(s.r), `§3 ${b.nickName} slot rarity is real`);
    ok(Number.isInteger(s.n) && s.n >= 1 && s.n <= 50, `§3 ${b.nickName} card number ${s.n} is in the album`);
  }
}
// שובל is the top of the ladder: index 10 guarantees all three legendary.
eq(saltizBotLoadout(SALTIZ_BOT_BY_ID.get('saltiz-shuval')).filter((s) => s && s.r === 'legendary').length, 3,
  '§3 שובל carries three legendaries');
// ...and אורי, five rungs down, must NOT.
ok(saltizBotLoadout(SALTIZ_BOT_BY_ID.get('saltiz-uri')).filter((s) => s && s.r === 'legendary').length < 3,
  '§3 אורי does not carry a full legendary loadout');

// §4 — the roll is deterministic per bot (client card == server match cards) and differs between bots.
for (const b of SALTIZ_BOTS) {
  eq(JSON.stringify(saltizBotLoadout(b)), JSON.stringify(saltizBotLoadout(b)), `§4 ${b.nickName} rolls the same twice`);
}
const sigs = new Set(SALTIZ_BOTS.map((b) => JSON.stringify(saltizBotLoadout(b))));
ok(sigs.size >= 3, `§4 the four bots do not all share one loadout (${sigs.size} distinct)`);
// A different id must draw a different seed, or "seeded per bot" is just a constant.
const cloneA = { id: 'saltiz-uri-x', level: 5 }, cloneB = { id: 'saltiz-uri-y', level: 5 };
ok(JSON.stringify(saltizBotLoadout(cloneA)) !== JSON.stringify(saltizBotLoadout(cloneB)),
  '§4 the seed comes from the id, not the level');

// §5 — search: what a player actually types.
const names = (q) => searchSaltizBots(q).map((b) => b.nickName);
assert.deepStrictEqual(names('פז'), ['פז'], '§5 exact name'); pass++;
assert.deepStrictEqual(names('שוב'), ['שובל'], '§5 prefix'); pass++;
assert.deepStrictEqual(names('ווה'), ['נווה'], '§5 mid-word substring'); pass++;
eq(names('אורי').length, 1, '§5 אורי matches one bot');
eq(searchSaltizBots('').length, 0, '§5 empty query matches nothing');
eq(searchSaltizBots('   ').length, 0, '§5 whitespace matches nothing');
eq(searchSaltizBots('זזזז').length, 0, '§5 a miss is a miss');
eq(searchSaltizBots(null).length, 0, '§5 null is safe');

console.log(`✅ test-saltiz-bots: ${pass} assertions passed`);
