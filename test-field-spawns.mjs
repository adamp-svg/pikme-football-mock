// Authored START SLOTS (shared/field-spawns.js + the sim/server paths that consume them).
//
// What this pins down:
//   1. A field that declares NOTHING must produce byte-identical spawns/ball to before the feature.
//      That is the whole safety property — every existing field, preset and format goes through the
//      same code now.
//   2. Capacity is min(A,B) — a 3-vs-1 map seats 1v1, not 3v3 (which would stack two B players).
//   3. MORE slots than players => a RANDOM subset, never the same two every match, never one marker
//      handed to two slots (the bug a per-slot `pool[rnd*len]` would ship).
//   4. FEWER slots than players => authored spots used, remaining slots fall back to the formula.
//   5. An authored BALL spot is ignored: since 2026-07-26 the kickoff is centre, and post-goal it
//      goes to the conceding team. test-kickoff-rule.mjs owns that rule; §5 here guards the old
//      per-field override staying dead.
//   6. Both normalizers clamp to the field's own size and cap the per-team count.
import { createState, addPlayer, setField, attachBall, step } from './shared/sim.js';
import { normSpawns, normBall, spawnCapacity, spawnCounts, planSpawns, teamForX, MAX_SPAWNS_PER_TEAM } from './shared/field-spawns.js';
import { FIELD } from './shared/constants.js';
import { sizeOf } from './shared/field-sizes.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const near = (a, b, e = 0.001) => Math.abs(a - b) <= e;

const S = sizeOf('s2v2');
const emptyField = { version: 3, size: 's2v2', bushes: [], hardWalls: [], dryWalls: [], crates: [], spawns: [], ball: null };
const withSpawns = (spawns, ball = null) => ({ ...emptyField, spawns, ball });
// Deterministic rng so a draw can be asserted; matches the sim's state.rng contract.
function seeded(seed) { let a = seed >>> 0 || 1; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function mkMatch(field, { teamSize = 2, seed = null } = {}) {
  const st = createState();
  st.teamSize = teamSize;
  if (seed != null) st.rng = seeded(seed);
  setField(st, field);
  const ids = [];
  for (const team of ['A', 'B']) for (let s = 0; s < teamSize; s++) {
    const id = `${team}${s}`; ids.push(id);
    addPlayer(st, id, { name: id, char: 'striker', team, slot: s, isBot: false });
  }
  return { st, ids };
}

console.log('\n== 1. no authored data => unchanged behaviour ==');
{
  const a = mkMatch(emptyField).st;
  const b = createState(); b.teamSize = 2; // pre-feature path: addPlayer with no setField at all
  for (const team of ['A', 'B']) for (let s = 0; s < 2; s++) addPlayer(b, `${team}${s}`, { name: 'x', char: 'striker', team, slot: s });
  let same = true;
  for (const id of ['A0', 'A1', 'B0', 'B1']) same = same && near(a.players[id].x, b.players[id].x) && near(a.players[id].y, b.players[id].y);
  ok(same, 'spawn positions identical to the formula when the field declares no slots');
  ok(a.spawnPlan === null, 'no slots => no plan (formula path, no per-match draw)');
  attachBall(a, 'A');
  ok(a.ball.owner === 'A0', 'no authored ball => kickoff still ATTACHES to the team (old behaviour)');
}

console.log('\n== 2. capacity = min(A,B) ==');
{
  const three = [{ x: 200, y: 200, team: 'A' }, { x: 200, y: 550, team: 'A' }, { x: 200, y: 900, team: 'A' }, { x: 1800, y: 550, team: 'B' }];
  ok(spawnCapacity(three) === 1, '3 A-slots + 1 B-slot seats 1v1');
  ok(spawnCounts(three).A === 3 && spawnCounts(three).B === 1, 'per-team counts reported for the badge');
  ok(spawnCapacity([]) === 0, 'no slots => capacity 0 (= "use the formula")');
  const six = [...three, { x: 1800, y: 200, team: 'B' }, { x: 1800, y: 900, team: 'B' }];
  ok(spawnCapacity(six) === 3, 'balanced 3+3 seats 3v3');
}

console.log('\n== 3. more slots than players => random subset, no double-booking ==');
{
  // 3 slots per side, 2 players per side: each match draws 2 of the 3.
  const spawns = [
    { x: 200, y: 150, team: 'A' }, { x: 200, y: 550, team: 'A' }, { x: 200, y: 950, team: 'A' },
    { x: 1800, y: 150, team: 'B' }, { x: 1800, y: 550, team: 'B' }, { x: 1800, y: 950, team: 'B' },
  ];
  const seen = new Set();
  let distinctAlways = true, authoredAlways = true;
  for (let seed = 1; seed <= 40; seed++) {
    const plan = planSpawns(spawns, 2, seeded(seed));
    for (const t of ['A', 'B']) {
      const [p0, p1] = plan[t];
      if (!p0 || !p1) { authoredAlways = false; continue; }
      if (p0.x === p1.x && p0.y === p1.y) distinctAlways = false;
      if (!spawns.some((s) => s.team === t && s.x === p0.x && s.y === p0.y)) authoredAlways = false;
      seen.add(`${t}:${p0.y}`); seen.add(`${t}:${p1.y}`);
    }
  }
  ok(distinctAlways, 'two slots never draw the SAME marker (Fisher-Yates, not per-slot sampling)');
  ok(authoredAlways, 'every drawn spot is one the author actually placed');
  ok(seen.size === 6, `all 6 markers get used across seeds (random, not fixed) — saw ${seen.size}`);
  // End-to-end through the sim: players land on drawn markers.
  const { st } = mkMatch(withSpawns(spawns), { seed: 7 });
  const onMarker = (p) => spawns.some((s) => s.team === p.team && near(s.x, p.x) && near(s.y, p.y));
  ok(['A0', 'A1', 'B0', 'B1'].every((id) => onMarker(st.players[id])), 'all 4 players spawn ON authored markers');
  ok(st.players.A0.y !== st.players.A1.y, 'team-mates do not stack');
}

console.log('\n== 4. fewer slots than players => formula fills the rest ==');
{
  const one = [{ x: 300, y: 300, team: 'A' }, { x: 1700, y: 800, team: 'B' }];
  const { st } = mkMatch(withSpawns(one), { teamSize: 2, seed: 3 });
  ok(near(st.players.A0.x, 300) && near(st.players.A0.y, 300), 'slot 0 uses the single authored A spot');
  ok(near(st.players.B0.x, 1700) && near(st.players.B0.y, 800), 'slot 0 uses the single authored B spot');
  const ref = createState(); ref.teamSize = 2;
  addPlayer(ref, 'r', { name: 'r', char: 'striker', team: 'A', slot: 1 });
  ok(near(st.players.A1.x, ref.players.r.x) && near(st.players.A1.y, ref.players.r.y), 'slot 1 falls back to the formation formula');
  // 3v3 on a 1-slot map: two of three fall back, and nobody shares a spot.
  const trio = mkMatch(withSpawns(one), { teamSize: 3, seed: 5 }).st;
  const pts = ['A0', 'A1', 'A2'].map((id) => `${Math.round(trio.players[id].x)},${Math.round(trio.players[id].y)}`);
  ok(new Set(pts).size === 3, '3v3 on a 1-slot map: three distinct start spots');
}

console.log('\n== 5. an authored ball spot is IGNORED (superseded 2026-07-26) ==');
// This section used to assert the opposite: a field could name the kickoff spot and the ball started
// there, loose. The user replaced that with one rule for every field and format — centre at kickoff,
// conceding team after a goal (see test-kickoff-rule.mjs, which owns the rule). These three cases are
// kept, inverted, so a future re-introduction of the per-field override fails loudly here too.
{
  const spawns = [{ x: 250, y: 550, team: 'A' }, { x: 1750, y: 550, team: 'B' }];
  const { st } = mkMatch(withSpawns(spawns, { x: 700, y: 250 }), { seed: 2 });
  attachBall(st);
  ok(near(st.ball.x, FIELD.W / 2) && near(st.ball.y, FIELD.H / 2), 'match start centres the ball, ignoring the authored spot');
  ok(st.ball.owner === null, 'and it starts loose — both teams race for it');
  ok(st.ball.vx === 0 && st.ball.vy === 0, 'ball starts still');
  attachBall(st, 'A');
  const holder = st.players[st.ball.owner];
  ok(!!holder && holder.team === 'A', 'a concede hands it to the conceding team, not to the authored spot');
  // Post-goal kickoff must follow the same rule through the real reset path, not just at match start.
  st.resetTimer = 0;
  // Park the bodies away from the goal mouth so nobody intercepts the shot on the way in.
  for (const id in st.players) { st.players[id].x = FIELD.W / 2; st.players[id].y = 60; }
  // lastTouch must be the ATTACKING team or the goal line is a solid wall (no own goals — sim.js:498).
  st.ball.x = FIELD.W - 40; st.ball.y = FIELD.H / 2; st.ball.owner = null; st.ball.pickupCd = 9; st.ball.lastTouch = 'A'; st.ball.vx = 900; st.ball.vy = 0;
  for (let i = 0; i < 600 && st.score.A === 0; i++) step(st, {}, 1 / 60);
  ok(st.score.A === 1, 'scored (setup for the reset check)');
  for (let i = 0; i < 600; i++) step(st, {}, 1 / 60);
  const kicker = st.players[st.ball.owner];
  ok(!!kicker && kicker.team === 'B', 'post-goal kickoff gives it to B (who conceded), not the authored spot');
}

console.log('\n== 6. normalizers ==');
{
  const dirty = [
    { x: -500, y: 99999, team: 'A' }, { x: 100, y: 100, team: 'zzz' }, { x: 'no', y: 1, team: 'B' }, null,
  ];
  const n = normSpawns(dirty, S);
  ok(n.length === 2, 'malformed entries dropped');
  ok(n[0].x === 0 && n[0].y === S.H, 'coordinates clamped into the pitch');
  ok(n[1].team === 'A', 'unknown team falls back to A');
  const many = Array.from({ length: 20 }, (_, i) => ({ x: 100 + i, y: 100, team: 'A' }));
  ok(normSpawns(many, S).length === MAX_SPAWNS_PER_TEAM, `per-team cap enforced (${MAX_SPAWNS_PER_TEAM})`);
  ok(normSpawns([...many, { x: 1900, y: 100, team: 'B' }], S).length === MAX_SPAWNS_PER_TEAM + 1, 'cap is PER TEAM, not overall');
  ok(normBall(null, S) === null && normBall({ x: 1 }, S) === null, 'malformed ball => null (formula ball)');
  ok(normBall({ x: -9, y: 99999 }, S).y === S.H, 'ball clamped into the pitch');
  ok(teamForX(10, S) === 'A' && teamForX(S.W - 10, S) === 'B', 'placement team guessed from the half (A defends left)');
  ok(spawnCapacity(normSpawns([{ x: 1, y: 1, team: 'A' }, { x: 2, y: 2, team: 'B' }], S)) === 1, 'capacity survives normalization');
}

console.log(`\n${fail === 0 ? '✅' : '❌'} field-spawns: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
