// Spawns the football server with a known secret, connects two authenticated
// clients, and asserts presence + (Task 6) the challenge handshake.
import assert from 'assert';
import { spawn } from 'child_process';
import WebSocket from 'ws';
import jwt from 'jsonwebtoken';

const SECRET = 'test-secret-123';
const PORT = 3999;
const tok = (id, nick) => jwt.sign({ id, nickName: nick, image: null }, SECRET, { expiresIn: '1h' });

function connect(id, nick, friends) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    const inbox = [];
    const waiters = [];
    const pump = () => { for (let i = waiters.length - 1; i >= 0; i--) { const w = waiters[i]; const hit = inbox.find(w.pred); if (hit) { waiters.splice(i, 1); w.resolve(hit); } } };
    ws.on('message', (d, isBin) => { if (isBin) return; inbox.push(JSON.parse(d.toString())); pump(); });
    ws.on('open', () => ws.send(JSON.stringify({ type: 'join', authToken: tok(id, nick), cards: [] })));
    const api = {
      ws,
      send: (o) => ws.send(JSON.stringify(o)),
      waitFor: (pred, ms = 3000) => new Promise((res, rej) => { const w = { pred, resolve: res }; waiters.push(w); pump(); setTimeout(() => rej(new Error('timeout waiting for ' + pred)), ms); }),
      close: () => ws.close(),
    };
    api.waitFor((m) => m.type === 'home').then(() => { if (friends) api.send({ type: 'setFriends', friends }); resolve(api); });
  });
}

const srv = spawn(process.execPath, ['server.js'], { cwd: process.cwd(), env: { ...process.env, PORT: String(PORT), FOOTBALL_TOKEN_SECRET: SECRET }, stdio: ['ignore', 'pipe', 'inherit'] });

async function ready() { return new Promise((res) => { srv.stdout.on('data', (b) => { if (b.toString().includes('running')) res(); }); }); }

async function main() {
  await ready();
  await new Promise((r) => setTimeout(r, 200));

  // A and B are friends of each other.
  const A = await connect('A', 'Alice', ['B']);
  const B = await connect('B', 'Bob', ['A']);

  // A already got a friendsPresence when it set friends; after B connects, A gets an
  // updated one showing B online.
  const p = await A.waitFor((m) => m.type === 'friendsPresence' && m.online.includes('B'));
  assert.ok(p.online.includes('B'), 'A sees B online');
  console.log('✅ presence PASS');

  // A challenges B; B receives it.
  A.send({ type: 'challenge', toUserId: 'B' });
  const recv = await B.waitFor((m) => m.type === 'challengeReceived' && m.fromUserId === 'A');
  assert.ok(recv.challengeId, 'B receives challenge from A');

  // B accepts → both get roomJoined (private) then matchStart.
  B.send({ type: 'challengeRespond', challengeId: recv.challengeId, accept: true });
  const [ja, jb] = await Promise.all([
    A.waitFor((m) => m.type === 'roomJoined' && m.mode === 'private'),
    B.waitFor((m) => m.type === 'roomJoined' && m.mode === 'private'),
  ]);
  assert.strictEqual(ja.code, jb.code, 'both joined the same room code');
  const [ma, mb] = await Promise.all([
    A.waitFor((m) => m.type === 'matchStart', 9000),
    B.waitFor((m) => m.type === 'matchStart', 9000),
  ]);
  assert.strictEqual(ma.matchId, mb.matchId, 'both entered the same match');
  console.log('✅ challenge PASS');

  // Non-friend challenge is rejected.
  const C = await connect('C', 'Carol', []); // C has no friends
  C.send({ type: 'challenge', toUserId: 'A' });
  const err = await C.waitFor((m) => m.type === 'challengeError');
  assert.ok(err, 'challenge to non-friend rejected');
  console.log('✅ challenge-guard PASS');
  C.close();
  A.close(); B.close(); srv.kill(); process.exit(0);
}
main().catch((e) => { console.error('❌', e.message); srv.kill(); process.exit(1); });
