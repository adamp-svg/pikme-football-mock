// Fog of war: a bot must NOT perceive an enemy hidden in a bush (beyond the reveal
// radius, not carrying, not firing) — not for targeting, and not for lane planning.
// Run: node test-fog.mjs
import { createState, addPlayer } from './shared/sim.js';
import { botCanSee, laneClear } from './shared/bot-ai.js';
import { ARENA, pointInBush } from './shared/arena.js';
import { BUSH_REVEAL_DIST, VISION_RANGE } from './shared/constants.js';

let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };

const g = ARENA.bushes[0];
const bx = g.x + g.w / 2, by = g.y + g.h / 2;
ok(pointInBush(bx, by), 'bush centre reads as in-bush');

const s = createState(); s.resetTimer = 0;
addPlayer(s, 'A', { name: 'a', char: 'player', team: 'A', slot: 0, isBot: true });
addPlayer(s, 'B', { name: 'b', char: 'player', team: 'B', slot: 0, isBot: true });
const A = s.players.A, B = s.players.B;
B.x = bx; B.y = by; // enemy hidden in the bush, not carrying, not firing

// Far (> reveal radius): invisible, and NOT counted as a lane blocker.
A.x = bx - (BUSH_REVEAL_DIST + 200); A.y = by;
ok(!botCanSee(A, B, s), 'a bushed enemy beyond the reveal radius is INVISIBLE to a bot');
ok(laneClear(A.x, A.y, 2000, by, s, 'A', { enemies: true, viewer: A }),
  "a hidden enemy does NOT block the bot's lane (fog-aware laneClear)");

// Close (< reveal radius): revealed, and now blocks the lane.
A.x = bx - (BUSH_REVEAL_DIST - 30);
ok(botCanSee(A, B, s), 'a bushed enemy within the reveal radius becomes visible');
ok(!laneClear(A.x, A.y, 2000, by, s, 'A', { enemies: true, viewer: A }),
  'a now-visible enemy blocks the lane');

// Carrying reveals a bushed enemy — but only WITHIN view range.
A.x = bx - (BUSH_REVEAL_DIST + 120); s.ball.owner = 'B'; // ~230px, within VISION_RANGE
ok(botCanSee(A, B, s), 'carrying the ball reveals a bushed enemy (in view)');
s.ball.owner = null;

// LIMITED VISION: an enemy in the OPEN (no bush) is only seen within view range.
B.x = 200; B.y = 200; // open field
A.x = B.x + VISION_RANGE + 150; A.y = B.y; // beyond view
ok(!botCanSee(A, B, s), 'an open-field enemy BEYOND view range is unseen (no seeing across the pitch)');
A.x = B.x + VISION_RANGE - 150; // within view
ok(botCanSee(A, B, s), 'an open-field enemy WITHIN view range is seen');

console.log(`\n${fails === 0 ? '✅ FOG PASS' : '❌ ' + fails + ' FAILED'}`);
process.exit(fails === 0 ? 0 : 1);
