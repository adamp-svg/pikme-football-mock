// 3v3 end-to-end: joining the 3v3 queue must produce SIX players in six distinct spots, on the
// 3v3 arena, with every bot holding a real role.
//
// The three things this pins, all of which were silently broken before:
//   1. `MAX_PLAYERS = 4` was a module constant, so a 3v3 room capped at 4 players.
//   2. `spawnPos` was `slot === 0 ? .36 : .64` — every slot past the first spawned on ONE spot,
//      so at 3v3 two players per team started inside each other.
//   3. `assignRoles` only had jobs for two bots (`bots[0]`/`bots[1]`); a third got no role and
//      would run the same support tactics as the second, stacking on it.
//
// 2v2 must be untouched — its kickoff is asserted to be the exact original 0.36/0.64 pair.
//
// Needs a live server:  PORT=3015 node server.js
import { WebSocket } from 'ws';
import { GOALS_TO_WIN, FIELD, MAX_PLAYERS } from './shared/constants.js';
import { createState, addPlayer } from './shared/sim.js';
import { assignRoles, createBotMemory } from './shared/bot-ai.js';

const PORT = process.env.PORT || 3015;
const URL = `ws://localhost:${PORT}`;
let failed = 0;
const ok = (label, cond, extra = '') => { if (!cond) failed++; console.log(`  ${cond ? '✅' : '❌'} ${label}${extra ? ` — ${extra}` : ''}`); };

function client(name) {
  const ws = new WebSocket(URL);
  const seen = [], waiters = [];
  ws.on('message', (raw) => {
    if (typeof raw !== 'string' && !Buffer.isBuffer(raw)) return;
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (!m || !m.type) return;
    seen.push(m);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].type === m.type) { waiters[i].resolve(m); waiters.splice(i, 1); }
    }
  });
  return {
    open: () => new Promise((res) => ws.once('open', res)),
    send: (o) => ws.send(JSON.stringify(o)),
    wait: (type, ms = 14000) => {
      const hit = seen.find((m) => m.type === type);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        waiters.push({ type, resolve });
        setTimeout(() => reject(new Error(`timeout waiting for ${type} (${name})`)), ms);
      });
    },
    close: () => ws.close(),
  };
}

async function joinFormat(launch, label) {
  const c = client(label);
  await c.open();
  c.send({ type: 'join', name: label });
  await c.wait('welcome');
  c.send(launch);
  const joined = await c.wait('roomJoined');
  const lobby = await c.wait('lobby');
  const start = await c.wait('matchStart');
  const roster = await c.wait('roster');
  c.close();
  return { joined, lobby, start, roster };
}

// Join a format, then wait for the first BINARY snapshot frame plus the roster that decodes it.
// The intro promo freezes the sim for a beat, so give it room.
function liveFrame(launch, label) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    let roster = null, done = false;
    const to = setTimeout(() => { if (!done) { done = true; ws.close(); reject(new Error(`no binary frame (${label})`)); } }, 20000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'join', name: label })));
    ws.on('message', (raw, isBinary) => {
      if (done) return;
      if (isBinary || (Buffer.isBuffer(raw) && raw[0] !== 0x7b)) {
        if (roster) { done = true; clearTimeout(to); ws.close(); resolve({ bin: raw, slots: roster.slots, v: roster.v }); }
        return;
      }
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type === 'welcome') ws.send(JSON.stringify(launch));
      else if (m.type === 'roster') roster = m;
    });
    ws.on('error', reject);
  });
}

console.log('1) the 3v3 queue actually fields six players');
const trio = await joinFormat({ type: 'matchmade', format: '3v3', diffLevel: 3 }, 'trio');
ok('roomJoined is matchmade', trio.joined.matchmade === true && trio.joined.mode === '3v3');
ok('lobby.teamSize is 3', trio.lobby.teamSize === 3, `got ${trio.lobby.teamSize}`);
ok('matchStart carries teamSize 3', trio.start.teamSize === 3, `got ${trio.start.teamSize}`);
ok('SIX players in the match', trio.start.players.length === 6, `${trio.start.players.length} players`);
ok('three per side', ['A', 'B'].every((t) => trio.start.players.filter((p) => p.team === t).length === 3),
  trio.start.players.map((p) => p.team).sort().join(''));
ok('the room cap really moved past MAX_PLAYERS', trio.start.players.length > MAX_PLAYERS, `MAX_PLAYERS=${MAX_PLAYERS}`);
ok('roster snapshot lists six slots', (trio.roster.slots || []).length === 6, `${(trio.roster.slots || []).length}`);
ok('every bot has cards', trio.start.players.filter((p) => p.isBot).every((p) => Array.isArray(p.loadout)));
ok('first-to-3 rule applies', trio.start.goalsToWin === GOALS_TO_WIN, `got ${trio.start.goalsToWin}`);

console.log('2) 3v3 plays on its own arena, not the main field');
{
  const quick = await joinFormat({ type: 'quickMatch', diffLevel: 3 }, 'quick2');
  ok('2v2 is still four players', quick.start.players.length === 4, `${quick.start.players.length}`);
  const sig = (a) => JSON.stringify([a?.bushes?.length, a?.crates?.length, a?.hardWalls?.length, a?.dryWalls?.length]);
  ok('the two formats send DIFFERENT arenas', sig(trio.start.arena) !== sig(quick.start.arena),
    `3v3=${sig(trio.start.arena)} 2v2=${sig(quick.start.arena)}`);
  ok('the 3v3 arena is non-empty', (trio.start.arena?.bushes?.length || 0) > 0 && (trio.start.arena?.crates?.length || 0) > 0);
}

console.log('3) kickoff spots are distinct (the stacking bug)');
for (const n of [2, 3, 5]) {
  const st = createState();
  st.teamSize = n;
  for (const team of ['A', 'B']) for (let s = 0; s < n; s++) addPlayer(st, `${team}${s}`, { name: 's', char: 'player', team, slot: s, isBot: true });
  const spots = Object.values(st.players).map((p) => `${Math.round(p.x)},${Math.round(p.y)}`);
  ok(`  ${n}v${n}: ${n * 2} distinct spawn spots`, new Set(spots).size === n * 2, spots.join(' '));
  // Nobody may spawn inside a teammate: min separation across a side.
  for (const team of ['A', 'B']) {
    const ps = Object.values(st.players).filter((p) => p.team === team);
    let minD = Infinity;
    for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) minD = Math.min(minD, Math.hypot(ps[i].x - ps[j].x, ps[i].y - ps[j].y));
    ok(`  ${n}v${n}: team ${team} min separation > 120px`, minD > 120, `${Math.round(minD)}px`);
  }
  const inside = Object.values(st.players).every((p) => p.x > 0 && p.x < FIELD.W && p.y > 0 && p.y < FIELD.H);
  ok(`  ${n}v${n}: everyone is on the pitch`, inside);
}

console.log('4) 2v2 kickoff is byte-for-byte what it always was');
{
  const st = createState(); // teamSize defaults to 2
  addPlayer(st, 'a0', { name: 's', char: 'player', team: 'A', slot: 0, isBot: true });
  addPlayer(st, 'a1', { name: 's', char: 'player', team: 'A', slot: 1, isBot: true });
  addPlayer(st, 'b0', { name: 's', char: 'player', team: 'B', slot: 0, isBot: true });
  ok('A slot0 at (.15W, .36H)', st.players.a0.x === FIELD.W * 0.15 && st.players.a0.y === FIELD.H * 0.36);
  ok('A slot1 at (.15W, .64H)', st.players.a1.x === FIELD.W * 0.15 && st.players.a1.y === FIELD.H * 0.64);
  ok('B slot0 at (.85W, .36H)', st.players.b0.x === FIELD.W * 0.85 && st.players.b0.y === FIELD.H * 0.36);
}

console.log('5) every bot gets a real role at 3v3');
{
  const st = createState();
  st.teamSize = 3;
  for (let s = 0; s < 3; s++) addPlayer(st, `b${s}`, { name: 'bot', char: 'player', team: 'B', slot: s, isBot: true });
  addPlayer(st, 'h0', { name: 'me', char: 'player', team: 'A', slot: 0, isBot: false });
  const mem = createBotMemory(); mem.t = 1;
  const role = assignRoles(st, 'B', mem, 1 / 60);
  ok('an onBall bot', !!role.onBall);
  ok('a support bot, different from onBall', !!role.support && role.support !== role.onBall);
  ok('the third bot has a COVER lane', role.lanes === 1 && Object.keys(role.lane).length === 1,
    `lanes=${role.lanes} lane=${JSON.stringify(role.lane)}`);
  const jobs = new Set([role.onBall, role.support, ...Object.keys(role.lane)]);
  ok('all three bots have a distinct job', jobs.size === 3, [...jobs].join(','));

  // 2v2: exactly onBall + support, no cover lanes at all (proves the new branch is dead there).
  const st2 = createState();
  for (let s = 0; s < 2; s++) addPlayer(st2, `c${s}`, { name: 'bot', char: 'player', team: 'B', slot: s, isBot: true });
  const r2 = assignRoles(st2, 'B', createBotMemory(), 1 / 60);
  ok('2v2 has no cover lanes', r2.lanes === 0 && Object.keys(r2.lane).length === 0, `lanes=${r2.lanes}`);
  ok('2v2 still fills onBall + support', !!r2.onBall && !!r2.support && r2.onBall !== r2.support);
}

console.log('6) six players survive the real binary snapshot (8-slot mask; 5v5 would NOT fit)');
{
  // Decode an ACTUAL frame off a live 3v3 match rather than a hand-built fixture — that is what
  // proves the u8 presence mask carries 6 players. It has room for 8, which is exactly why 5v5
  // (10 players) needs a wire bump first: summery/TEAM_FORMATS_PLAN.md §2.2.
  const { decodeSnapshot } = await import('./shared/wire.js');
  const frame = await liveFrame({ type: 'matchmade', format: '3v3', diffLevel: 3 }, 'wire3v3');
  ok('got a binary frame + its roster', !!frame && !!frame.bin && frame.slots.length === 6,
    `${frame?.slots?.length} slots, ${frame?.bin?.byteLength} bytes`);
  const dv = new DataView(frame.bin.buffer, frame.bin.byteOffset, frame.bin.byteLength);
  const snap = decodeSnapshot(dv, frame.slots.map((s) => s.id), frame.slots.map((s) => s.team), frame.v);
  ok('all six players decode out of it', !!snap && snap.players.length === 6, `${snap?.players?.length}`);
  ok('both teams present after decode',
    !!snap && new Set(snap.players.map((p) => p.team)).size === 2,
    snap ? snap.players.map((p) => p.team).sort().join('') : '');
}

console.log('7) a private-room host who picks 3v3 gets a real 3v3');
{
  // The `ready` handler used to read only `game === 'brawl'`, so a host picking the 3v3 card got a
  // 4-player first-to-3 match and no error — the format was silently downgraded.
  const c = client('host3v3');
  await c.open();
  c.send({ type: 'join', name: 'host3v3' });
  await c.wait('welcome');
  c.send({ type: 'createRoom' });
  await c.wait('roomJoined');
  c.send({ type: 'ready', game: '3v3' });
  const start = await c.wait('matchStart');
  c.close();
  ok('six players in the private room', start.players.length === 6, `${start.players.length}`);
  ok('teamSize 3', start.teamSize === 3, `got ${start.teamSize}`);
  ok('first-to-3', start.goalsToWin === GOALS_TO_WIN, `got ${start.goalsToWin}`);
  ok('on the 3v3 arena', (start.arena?.bushes?.length || 0) === 10, `${start.arena?.bushes?.length} bushes`);

  // ...and the other two cards still resolve correctly through the same path.
  for (const [card, wantGoals, wantSize] of [['brawl', 0, 2], ['2v2', GOALS_TO_WIN, 2]]) {
    const d = client(`host-${card}`);
    await d.open();
    d.send({ type: 'join', name: `host-${card}` });
    await d.wait('welcome');
    d.send({ type: 'createRoom' });
    await d.wait('roomJoined');
    d.send({ type: 'ready', game: card });
    const s = await d.wait('matchStart');
    d.close();
    ok(`  card '${card}' → ${wantSize}v${wantSize}, goalsToWin ${wantGoals}`,
      s.teamSize === wantSize && s.goalsToWin === wantGoals && s.players.length === wantSize * 2,
      `teamSize=${s.teamSize} goals=${s.goalsToWin} players=${s.players.length}`);
  }
}

console.log(failed ? `\n❌ ${failed} FAILED` : '\n✅ ALL PASS');
process.exit(failed ? 1 : 0);
