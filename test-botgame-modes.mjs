// e2e: training's «משחק מול בוטים» and the public queue honour the picked MODE.
//
// Three things this pins down:
//   1. `botGame` now carries a picker card id (`game`) — the vs-bots room must take the format's
//      teamSize (roster size), win rule AND arena, not hardwire the classic 2v2. A missing/unknown
//      pick must still be the classic 2v2 (the old message shape keeps working).
//   2. The '1v1' FORMATS row — a matchmade 1v1 must start with ONE player per side.
//   3. כייף (game:'fun') — a 2v2 whose partner bot is pinned to the ladder's TOP (רמה 12) and both
//      enemies to its bottom, via the invited-house-bot namedLevel mechanism.
//
// BOOTS ITS OWN SERVER (boot-test-server.mjs), same pattern as test-mode-format.mjs.
import { WebSocket } from 'ws';
import { GOALS_TO_WIN } from './shared/constants.js';
import { bootServer } from './boot-test-server.mjs';

const { url: URL } = await bootServer();
let failed = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(`   ${ok ? '✅' : '❌'} ${label}: ${actual} (expected ${expected})`);
};

function client(name) {
  const ws = new WebSocket(URL);
  const seen = [];
  const waiters = [];
  ws.on('message', (raw) => {
    if (typeof raw !== 'string' && !Buffer.isBuffer(raw)) return;
    let m; try { m = JSON.parse(raw.toString()); } catch { return; } // binary snapshots aren't JSON
    if (!m || !m.type) return;
    seen.push(m);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].type === m.type) { waiters[i].resolve(m); waiters.splice(i, 1); }
    }
  });
  return {
    ws,
    open: () => new Promise((res) => ws.once('open', res)),
    send: (o) => ws.send(JSON.stringify(o)),
    wait: (type, ms = 25000) => {
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

// One vs-bots match: send botGame (optionally with a card id), return its matchStart.
async function botGame(game, label) {
  const c = client(label);
  await c.open();
  c.send({ type: 'join', name: label });
  await c.wait('welcome');
  c.send({ type: 'botGame', diffLevel: 3, ...(game ? { game } : {}) });
  const start = await c.wait('matchStart');
  c.close();
  return start;
}

console.log("1) botGame honours the picked card (training's game picker)");
const duel = await botGame('1v1', 'bots-1v1');
check("1v1 roster is 2 (me + 1 bot)", duel.players.length, 2);
check('1v1 goalsToWin', duel.goalsToWin, GOALS_TO_WIN);
check('1v1 teamSize', duel.teamSize, 1);

const trio = await botGame('3v3', 'bots-3v3');
check('3v3 roster is 6', trio.players.length, 6);
check('3v3 teamSize', trio.teamSize, 3);
check('3v3 plays on its own arena (walls differ from 2v2)',
  JSON.stringify(trio.arena) !== JSON.stringify(duel.arena), true);

const brawl = await botGame('brawl', 'bots-brawl');
check('brawl is timed (goalsToWin 0)', brawl.goalsToWin, 0);
check('brawl roster is 4', brawl.players.length, 4);

console.log('2) כייף — partner pinned to the ladder top, enemies to its bottom');
const fun = await botGame('fun', 'bots-fun');
check('roster is 4 (a 2v2)', fun.players.length, 4);
check('goalsToWin', fun.goalsToWin, GOALS_TO_WIN);
{
  const partner = fun.players.find((p) => p.isBot && p.team === 'A');
  const foes = fun.players.filter((p) => p.isBot && p.team === 'B');
  check('partner shows רמה 12 (top namedLevel)', partner && partner.level, 12);
  check('partner is level-pinned (namedLevel 11)', partner && partner.namedLevel, 11);
  check('two enemies', foes.length, 2);
  check('both enemies pinned to the bottom', foes.every((p) => p.namedLevel === 0), true);
  check('enemies show רמה 1', foes.every((p) => p.level === 1), true);
  check('bots have real names, not "Bot"', fun.players.filter((p) => p.isBot).every((p) => p.name && p.name !== 'Bot'), true);
}

console.log('3) the old message shape (no game) is still the classic 2v2');
const legacy = await botGame(null, 'bots-legacy');
check('roster is 4', legacy.players.length, 4);
check('goalsToWin', legacy.goalsToWin, GOALS_TO_WIN);

console.log('4) a matchmade 1v1 seats one player per side');
{
  const c = client('mm-1v1');
  await c.open();
  c.send({ type: 'join', name: 'mm-1v1' });
  await c.wait('welcome');
  c.send({ type: 'matchmade', format: '1v1', diffLevel: 3, trophies: 0 });
  const start = await c.wait('matchStart'); // alone → bot-filled after the budget runs out
  check('players', start.players.length, 2);
  check('teamSize', start.teamSize, 1);
  const teams = start.players.map((p) => p.team).sort().join('');
  check('one per side', teams, 'AB');
  c.close();
}

console.log(failed ? `\n❌ ${failed} FAILED` : '\n✅ ALL PASS');
process.exit(failed ? 1 : 0);
