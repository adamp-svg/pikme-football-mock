// End-to-end test of the party-invite flow (no DB): two authenticated WS clients become
// friends via setFriends, host invites, invitee accepts + auto-joins, host starts 2v2.
// Run: FOOTBALL_TOKEN_SECRET=testsecret node test-party.mjs   (server started with same secret)
import { WebSocket } from 'ws';
import jwt from 'jsonwebtoken';

const SECRET = process.env.FOOTBALL_TOKEN_SECRET || 'testsecret';
const URL = process.env.URL || 'ws://localhost:3010';
const tok = (id, nick) => jwt.sign({ id, nickName: nick }, SECRET, { expiresIn: '1h' });

function client(id, nick) {
  const ws = new WebSocket(URL);
  const got = [];
  const waiters = [];
  ws.on('message', (raw) => {
    if (typeof raw !== 'string' && !(raw instanceof Buffer)) return;
    let m; try { m = JSON.parse(raw.toString()); } catch { return; } // ignore binary snapshots
    if (!m || !m.type) return;
    got.push(m);
    for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].type === m.type) { waiters[i].resolve(m); waiters.splice(i, 1); }
  });
  const api = {
    ws, id, got,
    open: () => new Promise((r) => ws.on('open', r)),
    send: (o) => ws.send(JSON.stringify(o)),
    wait: (type, ms = 3000) => new Promise((resolve, reject) => {
      const hit = got.find((m) => m.type === type);
      if (hit) return resolve(hit);
      const w = { type, resolve };
      waiters.push(w);
      setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); reject(new Error('timeout waiting ' + type)); } }, ms);
    }),
  };
  return api;
}

const A = client('userA', 'Alice');
const B = client('userB', 'Bob');
let failed = false;
const ok = (c, m) => console.log(`${c ? '✓' : '✗'} ${m}`) || (c || (failed = true));

try {
  await Promise.all([A.open(), B.open()]);
  A.send({ type: 'join', authToken: tok('userA', 'Alice'), name: 'Alice', cards: [], cosmetic: null, loadout: [null, null, null] });
  B.send({ type: 'join', authToken: tok('userB', 'Bob'), name: 'Bob', cards: [], cosmetic: null, loadout: [null, null, null] });
  const wa = await A.wait('welcome'); const wb = await B.wait('welcome');
  ok(wa.userId === 'userA' && wb.userId === 'userB', `both authenticated (A=${wa.userId}, B=${wb.userId})`);

  // Become mutual friends (client-provided list, as the real client does).
  A.send({ type: 'setFriends', friends: ['userB'] });
  B.send({ type: 'setFriends', friends: ['userA'] });

  // A hosts a party room.
  A.send({ type: 'createRoom' });
  const rj = await A.wait('roomJoined');
  ok(rj.mode === 'private' && rj.host === true && rj.code, `A hosts private room ${rj.code}`);

  // A invites B.
  A.send({ type: 'inviteFriend', toUserId: 'userB' });
  const inv = await B.wait('partyInvite');
  ok(inv.code === rj.code && inv.fromName === 'Alice', `B receives partyInvite (from ${inv.fromName}, code ${inv.code})`);
  const sent = await A.wait('partyInviteSent');
  ok(sent.toUserId === 'userB', 'A gets partyInviteSent');

  // B accepts → auto-joins (no host approval).
  B.send({ type: 'partyRespond', code: inv.code, accept: true });
  const brj = await B.wait('roomJoined');
  ok(brj.code === rj.code && brj.host === false, 'B auto-joined the room (host:false)');
  const acc = await A.wait('partyInviteAccepted');
  ok(acc.name === 'Bob', `A notified: ${acc.name} joined`);

  // Lobby should now list BOTH members.
  const lob = await B.wait('lobby');
  const names = (lob.members || []).map((m) => m.name).sort();
  ok(lob.members && lob.members.length === 2 && names.join(',') === 'Alice,Bob', `lobby has 2 members: ${names.join(', ')}`);

  // Host picks the game → ready → countdown/match starts.
  A.send({ type: 'ready' });
  const ms = await A.wait('matchStart', 8000);
  ok(!!ms.matchId, `match started (matchId ${ms.matchId})`);

  // Negative: an UNINVITED third party can't join by guessing the code.
  const C = client('userC', 'Carol');
  await C.open();
  C.send({ type: 'join', authToken: tok('userC', 'Carol'), name: 'Carol', cards: [], cosmetic: null, loadout: [null, null, null] });
  await C.wait('welcome');
  C.send({ type: 'partyRespond', code: rj.code, accept: true });
  const err = await C.wait('partyError', 3000).catch(() => null);
  ok(err && /הזמנה|התחיל|מלא/.test(err.msg || ''), `uninvited join rejected (${err ? err.msg : 'no error?'})`);
  C.ws.close();
} catch (e) {
  console.log('✗ EXCEPTION:', e.message); failed = true;
}
A.ws.close(); B.ws.close();
console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS');
process.exit(failed ? 1 : 0);
