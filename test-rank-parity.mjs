// CROSS-REPO PARITY: the game's trophy ladder (shared/rank.js) must match the server's
// (pikme-server/data/football-rank.js) exactly. Run: node test-rank-parity.mjs
//
// Why this test exists: the server OWNS every trophy number, but the game has to draw the tier badge
// and the bar. If the two ladders drift, the hub shows a player as "זהב 480" while the server has
// already promoted them — a silent, confusing, hard-to-trace bug. This fails loudly instead.
//
// The server repo is a SIBLING checkout, not a dependency. If it isn't present (someone cloned only
// the game), this test SKIPS rather than fails — it can't verify parity, and pretending otherwise
// would be worse than saying so.

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { RANK_TIERS, TIER_MIN, botCeiling } from './shared/rank.js';

const require = createRequire(import.meta.url);
const SERVER_MODULE = '../pikme-server/data/football-rank.js';
const serverPath = new URL(SERVER_MODULE, import.meta.url).pathname;

if (!existsSync(serverPath)) {
  console.log(`SKIP — sibling server checkout not found at ${SERVER_MODULE}; cannot verify parity.`);
  process.exit(0);
}

const server = require(SERVER_MODULE);

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log('  ✓', msg);
  else { console.error('  ✗', msg); failures++; }
}

console.log('game shared/rank.js  ==  server data/football-rank.js:');
assert(RANK_TIERS.join(',') === server.RANK_TIERS.join(','),
  `tier names match (game ${RANK_TIERS.join('/')} vs server ${server.RANK_TIERS.join('/')})`);
assert(TIER_MIN.join(',') === server.TIER_MIN.join(','),
  `tier thresholds match (game ${TIER_MIN.join('/')} vs server ${server.TIER_MIN.join('/')})`);

// Every difficulty level, not just the ends — an off-by-one in the formula would slip past a 2-point check.
let ceilMismatch = null;
for (let L = 0; L <= 11; L++) {
  if (botCeiling(L) !== server.botCeiling(L)) { ceilMismatch = `L${L}: game ${botCeiling(L)} vs server ${server.botCeiling(L)}`; break; }
}
assert(ceilMismatch === null, `botCeiling matches at every difficulty level 0..11${ceilMismatch ? ' — ' + ceilMismatch : ''}`);

// A Hebrew name for every tier the server can return, or the badge renders blank.
import { TIER_HE } from './shared/rank.js';
assert(TIER_HE.length === server.RANK_TIERS.length, 'a Hebrew label exists for every server tier');
assert(TIER_HE.every((s) => typeof s === 'string' && s.length > 0), 'no Hebrew label is empty');

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
