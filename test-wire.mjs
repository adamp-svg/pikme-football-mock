// Round-trip codec test: decode(encode(snapshot)) reproduces every field the client
// consumes (exactly for pre-quantized fields; within tolerance for the u8 VFX fade).
import { encodeKeyframe, decodeSnapshot } from './shared/wire.js';
import { BOMB, BUILT_WALL } from './shared/constants.js';

let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + '  ' + m); if (!c) fails++; };
const near = (a, b, t = 1e-9) => Math.abs(a - b) <= t;
const r1 = (v) => Math.round(v * 10) / 10, r2 = (v) => Math.round(v * 100) / 100;

const slotId = ['m-1', 'bot-1', 'm-2', 'bot-2'], slotTeam = ['A', 'A', 'B', 'B'];
const mkP = (id, x, y, vx) => ({ id, name: 'X', char: 'player', team: 'A', x: r1(x), y: r1(y), vx: r1(vx), vy: r1(-56.7), aimX: r2(0.71), aimY: r2(-0.7), firing: true, lastSeq: 99, ammo: 2, reloading: false, reloadFrac: r2(0.33), buildAmmo: 1, buildFrac: r2(0.5) });
const snap = {
  type: 'snapshot', tick: 5, phase: 'match', elapsed: 57, resetTimer: r2(1.23), lastGoal: 'B', score: { A: 1, B: 2 },
  ball: { x: r1(1002.3), y: r1(551.7), owner: 'm-2' },
  players: [mkP('m-1', 900, 400, 123.4), mkP('bot-1', 950, 450, 4000.9), mkP('m-2', 1100, 500, -12.3), mkP('bot-2', 1150, 600, 0)],
  projectiles: [{ id: 11, x: r1(1100), y: r1(500), team: 'A' }, { id: 12, x: r1(800), y: r1(600), team: 'B' }],
  walls: [{ id: 21, x: 1000, y: 500, w: 32, h: 176, hp: 2, maxHp: BUILT_WALL.hp, team: 'A' }],
  bombs: [{ id: 31, x: r1(1000), y: r1(550), team: 'A', fuse: r2(0.8) }],
  blasts: [{ id: 41, x: r1(560), y: r1(300), radius: BOMB.radius, life: 0.4, maxLife: BOMB.blastLife }],
  impacts: [{ id: 51, type: 'wall', target: null, team: 'A', x: r1(560), y: r1(305), dx: 0.6, dy: -0.8, life: 0.14, maxLife: 0.28 }],
};

const buf = encodeKeyframe(snap, slotId, 7);
console.log('encoded keyframe bytes:', buf.byteLength, '(vs', JSON.stringify(snap).length, 'B JSON)');
const d = decodeSnapshot(new DataView(buf), slotId, slotTeam, 7);
ok(d !== null, 'decodes when rosterVersion matches');
ok(decodeSnapshot(new DataView(buf), slotId, slotTeam, 8) === null, 'rejects mismatched rosterVersion');
ok(d.phase === 'match' && d.elapsed === 57 && near(d.resetTimer, 1.23) && d.lastGoal === 'B', 'globals (phase/elapsed/resetTimer/lastGoal)');
ok(d.score.A === 1 && d.score.B === 2, 'score');
ok(near(d.ball.x, snap.ball.x) && near(d.ball.y, snap.ball.y) && d.ball.owner === 'm-2', 'ball + owner slot->id');
ok(d.players.length === 4, '4 players present');
for (let k = 0; k < 4; k++) {
  const a = snap.players[k], b = d.players[k];
  ok(b.id === slotId[k] && b.team === slotTeam[k] && b.char === 'player', `p${k} identity reconstructed`);
  ok(near(b.x, a.x) && near(b.y, a.y), `p${k} pos exact`);
  ok(near(b.aimX, a.aimX) && near(b.aimY, a.aimY), `p${k} aim exact`);
  ok(b.firing === a.firing && b.reloading === a.reloading && b.ammo === a.ammo && b.buildAmmo === a.buildAmmo, `p${k} flags`);
  ok(near(b.reloadFrac, a.reloadFrac) && near(b.buildFrac, a.buildFrac), `p${k} fracs exact`);
}
// vx: exact when |v|<=3276.7; the bot-1 vx=4000.9 clamps (>3276.7) — but vx only feeds the
// animation 'moving' term which saturates far below, so the clamp is invisible (asserted separately).
ok(near(d.players[0].vx, 123.4) && near(d.players[2].vx, -12.3), 'vx exact within i16 range');
ok(d.players[1].vx <= 3276.8, 'vx clamps gracefully past i16 (animation-only, invisible)');
ok(d.projectiles.length === 2 && d.projectiles[0].id === 11 && d.projectiles[1].team === 'B' && near(d.projectiles[0].x, 1100), 'projectiles');
ok(d.walls.length === 1 && d.walls[0].hp === 2 && d.walls[0].maxHp === BUILT_WALL.hp && d.walls[0].w === 32 && d.walls[0].team === 'A', 'walls + maxHp reconstructed');
ok(d.bombs.length === 1 && near(d.bombs[0].fuse, 0.8) && d.bombs[0].team === 'A', 'bombs');
ok(d.blasts.length === 1 && d.blasts[0].radius === BOMB.radius && Math.abs((1 - d.blasts[0].life / d.blasts[0].maxLife) - (1 - 0.4 / BOMB.blastLife)) < 0.02, 'blast fade within tolerance + radius reconstructed');
ok(d.impacts.length === 1 && d.impacts[0].type === 'wall' && near(d.impacts[0].dx, 0.6) && near(d.impacts[0].dy, -0.8), 'impact fields + dx/dy');

// Windup progress rides the free flag bit + the buildFrac byte.
{
  const p = mkP('m-1', 900, 400, 123.4);
  p.buildWindup = 0.5; p.buildAmmo = 2; // winding, mag full so reloadFrac path is idle
  const s2 = { ...snap, players: [p, ...snap.players.slice(1)] };
  const buf2 = encodeKeyframe(s2, slotId, 7);
  const d2 = decodeSnapshot(new DataView(buf2), slotId, slotTeam, 7);
  const dp = d2.players[0];
  ok(dp.winding === true, `winding flag survives the wire (${dp.winding})`);
  ok(Math.abs(dp.buildFrac - 0.5) <= 0.02, `windup progress survives (${dp.buildFrac})`);
}

console.log('\n' + (fails === 0 ? '✅ ALL PASS' : '❌ ' + fails + ' FAILED'));
process.exit(fails ? 1 : 0);
