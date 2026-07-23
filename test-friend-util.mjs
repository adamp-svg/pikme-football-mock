// football-mock/test-friend-util.mjs — run: node test-friend-util.mjs
import { rankTopCards, RARITY_ORDER } from './shared/friend-cards.js';

let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };

ok(RARITY_ORDER.legendary > RARITY_ORDER.epic, 'rarity order');
ok(rankTopCards([{ r:'epic', n:1, c:9 }, { r:'legendary', n:2, c:1 }], 1)[0].n === 2, 'rarity beats copies');
ok(rankTopCards([{ r:'rare', n:1, c:1, w:5 }, { r:'rare', n:2, c:3, w:1 }], 1)[0].n === 2, 'copies tie-break');
ok(rankTopCards([{ r:'rare', n:1, c:2, w:5 }, { r:'rare', n:2, c:2, w:9 }], 1)[0].n === 2, 'worth tie-break');
ok(rankTopCards([{ r:'common', n:1 }, { r:'common', n:2 }, { r:'common', n:3 }, { r:'common', n:4 }], 3).length === 3, 'caps at n');
ok(JSON.stringify(rankTopCards([{ r:'rare', n:'7', c:1 }], 1)[0]) === JSON.stringify({ r:'rare', n:7 }), 'shape {r,n} numeric n');
ok(rankTopCards(null).length === 0, 'null-safe');

process.exit(fails ? 1 : 0);
