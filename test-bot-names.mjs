// BOT IDENTITIES for the VS screen. Bots stopped being "Bot" — they carry names, so the countdown
// reads like a lineup instead of a placeholder. Named saltiz bots are preferred when their level
// fits, because those already have cards, colours and a friend card the player may have seen.
import { pickBotIdentities, SALTIZ_BOTS } from './shared/saltiz-bots.js';

let failed = 0;
const ok = (l, c, x = '') => { if (!c) failed++; console.log(`  ${c ? '✅' : '❌'} ${l}${x ? ` — ${x}` : ''}`); };

console.log('count and shape');
for (const n of [1, 2, 3, 5]) {
  const got = pickBotIdentities(n, 4, 'room-1');
  ok(`${n} requested -> ${n} returned`, got.length === n, String(got.length));
  ok(`${n}: every one has a non-empty name`, got.every((b) => typeof b.name === 'string' && b.name.length > 0));
  ok(`${n}: names are unique`, new Set(got.map((b) => b.name)).size === n);
}

console.log('\nnamed saltiz bots are preferred when the level fits');
{
  // אורי is display level 5 -> botLevelOf 4. A room at botLevel 4 should reach for him first.
  const got = pickBotIdentities(1, 4, 'seed-a');
  ok('a level-4 room gets a saltiz bot', got[0].isSaltiz, JSON.stringify(got[0]));
  ok('...and it is the closest-level one (אורי)', got[0].name === 'אורי', got[0].name);
}
{
  // Nobody in the roster is near botLevel 0 (closest is אורי at 4), so fall back to generated names.
  const got = pickBotIdentities(2, 0, 'seed-b');
  ok('a level-0 room gets generated names, not a mis-levelled saltiz bot', got.every((b) => !b.isSaltiz), JSON.stringify(got.map((b) => b.name)));
  ok('...and no generated name collides with a saltiz name',
    got.every((b) => !SALTIZ_BOTS.some((s) => s.nickName === b.name)));
}

console.log('\nstability');
ok('the same seed gives the same identities',
  JSON.stringify(pickBotIdentities(3, 5, 'room-9')) === JSON.stringify(pickBotIdentities(3, 5, 'room-9')));
ok('a different seed gives a different set (usually)',
  JSON.stringify(pickBotIdentities(3, 5, 'room-9')) !== JSON.stringify(pickBotIdentities(3, 5, 'room-10')));

console.log('\nevery identity reports the room level, so the badge cannot disagree with the bot');
ok('level is the requested one', pickBotIdentities(3, 7, 's').every((b) => b.level === 7));

console.log(failed ? `\n❌ ${failed} failed` : '\n✅ all passed');
process.exit(failed ? 1 : 0);
