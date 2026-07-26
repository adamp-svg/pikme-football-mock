// e2e: the picked mode must actually reach the match.
//
// Two bugs this pins down:
//   1. goal-brawl was rendered «בקרוב» in 3 of 4 pickers while goalBrawl() was live.
//   2. `selectedGame` was CLIENT-ONLY state — the server never learned it, so a private
//      room always played first-to-3 no matter which card was tapped.
// Both are only observable now that matchStart carries `goalsToWin`.
//
// BOOTS ITS OWN SERVER (boot-test-server.mjs). This used to say "needs a live server: PORT=3013" and
// was then reported as a pre-existing failure for whole sessions whenever nobody had one up — the code
// was fine, the fixture was missing. Set PORT= to aim at a specific running server on purpose.
import { WebSocket } from 'ws';
import { GOALS_TO_WIN } from './shared/constants.js';
import { bootServer } from './boot-test-server.mjs';

const { url: URL } = await bootServer();
let failed = 0;

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
  const api = {
    ws,
    open: () => new Promise((res) => ws.once('open', res)),
    send: (o) => ws.send(JSON.stringify(o)),
    wait: (type, ms = 12000) => {
      const hit = seen.find((m) => m.type === type);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        waiters.push({ type, resolve });
        setTimeout(() => reject(new Error(`timeout waiting for ${type} (${name})`)), ms);
      });
    },
    close: () => ws.close(),
  };
  return api;
}

function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(`   ${ok ? '✅' : '❌'} ${label}: goalsToWin=${actual} (expected ${expected})`);
}

// A public queue join: quickMatch = first-to-N, goalBrawl = timed (0).
async function publicMode(msg, label, expected) {
  const c = client(label);
  await c.open();
  c.send({ type: 'join', name: label });
  await c.wait('welcome');
  c.send(msg);
  const joined = await c.wait('roomJoined');
  const start = await c.wait('matchStart');
  console.log(`${label}: roomJoined.mode=${joined.mode}`);
  check(label, start.goalsToWin, expected);
  c.close();
}

// A private room: the host picks a card, then Play Now sends { ready, game }.
async function privateMode(game, label, expected) {
  const c = client(label);
  await c.open();
  c.send({ type: 'join', name: label });
  await c.wait('welcome');
  c.send({ type: 'createRoom' });
  await c.wait('roomJoined');
  c.send({ type: 'ready', game });
  const start = await c.wait('matchStart');
  check(`${label} (game:'${game}')`, start.goalsToWin, expected);
  c.close();
}

console.log('1) public queues');
await publicMode({ type: 'quickMatch', diffLevel: 3 }, 'quickMatch', GOALS_TO_WIN);
await publicMode({ type: 'goalBrawl', diffLevel: 3 }, 'goalBrawl', 0);

console.log('2) private room honours the picked card');
await privateMode('brawl', 'private', 0);
await privateMode('2v2', 'private', GOALS_TO_WIN);

console.log(failed ? `\n❌ ${failed} FAILED` : '\n✅ ALL PASS');
process.exit(failed ? 1 : 0);
