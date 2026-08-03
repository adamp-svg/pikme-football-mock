// The CONNECTED-PLAYERS roster (whoOnline → onlineList) and the invite relaxation that page needs.
//
// Asked for 2026-08-03: the hub's «מחוברים» chip opens a page listing everyone connected, from which
// you can friend-request or invite them. Two server-side pieces are under test here:
//   1. onlineRoster() — everyone AUTHENTICATED and connected, minus the caller. Guests are absent by
//      construction (no userId → not in onlineByUser), and the field list is the privacy boundary.
//   2. inviteFriend no longer requires friendship (it used to answer 'לא חבר'), with a per-inviter
//      cooldown taking over as the anti-flood guard.
//
// Pattern copied from test-challenge.mjs.
import assert from 'assert';
import { spawn } from 'child_process';
import WebSocket from 'ws';
import jwt from 'jsonwebtoken';

const SECRET = 'test-secret-123';
const PORT = 3998;
const tok = (id, nick) => jwt.sign({ id, nickName: nick, image: null }, SECRET, { expiresIn: '1h' });

function connect(join = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    const inbox = [];
    const waiters = [];
    const pump = () => { for (let i = waiters.length - 1; i >= 0; i--) { const w = waiters[i]; const hit = inbox.find(w.pred); if (hit) { waiters.splice(i, 1); w.resolve(hit); } } };
    ws.on('message', (d, isBin) => { if (isBin) return; inbox.push(JSON.parse(d.toString())); pump(); });
    ws.on('open', () => ws.send(JSON.stringify({ type: 'join', cards: [], ...join })));
    const api = {
      ws,
      send: (o) => ws.send(JSON.stringify(o)),
      waitFor: (pred, ms = 3000) => new Promise((res, rej) => { const w = { pred, resolve: res }; waiters.push(w); pump(); setTimeout(() => rej(new Error('timeout waiting for a message')), ms); }),
      // The inbox is RETAINED, so waitFor can be satisfied by an old message. Anything asked for
      // twice (the roster, a second invite) must drop the previous one first or it asserts on stale
      // data — that mistake made this test read level 2 after setStats had already set 9.
      drop: (pred) => { for (let i = inbox.length - 1; i >= 0; i--) if (pred(inbox[i])) inbox.splice(i, 1); },
      // Nothing arrived matching `pred` within `ms` — used to assert a REFUSAL is silent-to-the-target.
      expectNothing: (pred, ms = 600) => new Promise((res, rej) => { const t = setTimeout(() => res(true), ms); api.waitFor(pred, ms + 200).then(() => { clearTimeout(t); rej(new Error('expected no matching message, got one')); }).catch(() => {}); }),
      close: () => ws.close(),
    };
    api.waitFor((m) => m.type === 'home').then(() => resolve(api));
  });
}

const srv = spawn(process.execPath, ['server.js'], { cwd: process.cwd(), env: { ...process.env, PORT: String(PORT), FOOTBALL_TOKEN_SECRET: SECRET }, stdio: ['ignore', 'pipe', 'inherit'] });
async function ready() { return new Promise((res) => { srv.stdout.on('data', (b) => { if (b.toString().includes('running')) res(); }); }); }

const roster = async (c) => {
  c.drop((m) => m.type === 'onlineList');   // a retained older roster would answer this ask
  c.send({ type: 'whoOnline' });
  return (await c.waitFor((m) => m.type === 'onlineList')).players;
};
const byId = (list, id) => list.find((p) => p.userId === id);

let pass = 0;
function ok(label) { pass++; console.log(`✅ ${label}`); }

async function main() {
  await ready();
  await new Promise((r) => setTimeout(r, 200));

  // A and B are authenticated STRANGERS (no setFriends anywhere in this test). G is a guest: it
  // joins with no authToken, so it has no userId.
  const A = await connect({ authToken: tok('A', 'Alice'), trophies: 250, level: 4, cosmetic: 'tank:default' });
  const B = await connect({ authToken: tok('B', 'Bob'), trophies: 40, level: 2 });
  const G = await connect({ name: 'GuestGus' });

  // --- 1. the roster ------------------------------------------------------------------------
  const rA = await roster(A);
  assert.ok(byId(rA, 'B'), 'A sees B on the roster although they are not friends');
  ok('roster lists a connected non-friend');

  assert.strictEqual(byId(rA, 'A'), undefined, 'the caller must not be in its own roster');
  ok('roster excludes the caller');

  assert.ok(!rA.some((p) => !p.userId || p.name === 'GuestGus'), 'a guest has no userId and must not appear');
  ok('roster excludes unauthenticated guests');

  const b = byId(rA, 'B');
  assert.strictEqual(b.name, 'Bob', 'nickname comes from the token');
  assert.strictEqual(b.level, 2, 'level reported at join is carried on the roster');
  assert.strictEqual(b.inMatch, false, 'B is on the hub, not in a match');
  ok('roster row carries name + level + inMatch');

  // THE PRIVACY BOUNDARY: only these keys, ever. A member object also holds cards, loadout, friends
  // and (in other repos' shapes) phone — none of them may leak onto this wire.
  assert.deepStrictEqual(Object.keys(b).sort(), ['avatar', 'cosmetic', 'inMatch', 'level', 'name', 'userId'], 'roster row has exactly the public fields');
  ok('roster row leaks no extra fields');

  // --- 2. late stats (SALTIZ_XP lands after join) -------------------------------------------
  B.send({ type: 'setStats', trophies: 900, level: 9 });
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(byId(await roster(A), 'B').level, 9, 'setStats updates the level shown to others');
  ok('setStats updates a hub-sitting player level');

  // A junk level must not overwrite a good one.
  B.send({ type: 'setStats', level: 0 });
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(byId(await roster(A), 'B').level, 9, 'level 0 is rejected, previous value kept');
  ok('setStats rejects an out-of-range level');

  // --- 3. inviting a STRANGER (the relaxation) ----------------------------------------------
  A.send({ type: 'inviteFriend', toUserId: 'B' });
  const inv = await B.waitFor((m) => m.type === 'partyInvite');
  assert.strictEqual(inv.fromUserId, 'A', 'the invite names its sender');
  assert.ok(inv.code, 'the invite carries a room code');
  ok('a non-friend party invite is DELIVERED (was refused with לא חבר)');

  await A.waitFor((m) => m.type === 'partyInviteSent' && m.toUserId === 'B');
  ok('the inviter is told the invite went out');

  // --- 4. the cooldown that replaced the friend check ---------------------------------------
  A.send({ type: 'inviteFriend', toUserId: 'B' });
  const err = await A.waitFor((m) => m.type === 'partyError');
  assert.ok(err.msg, 'a too-fast second invite is refused');
  ok('the invite cooldown refuses an immediate repeat');

  // ⚠️ THE COOLDOWN IS PER PAIR, and it has to be: a blanket per-inviter gap broke the ordinary way a
  // party is built (test-party-3v3-chat seats two friends 280ms apart, and that test caught it). So an
  // invite to a DIFFERENT person, immediately, must still go out.
  const C = await connect({ authToken: tok('C', 'Carol'), level: 3 });
  A.send({ type: 'inviteFriend', toUserId: 'C' });
  await C.waitFor((m) => m.type === 'partyInvite');
  ok('a back-to-back invite to a DIFFERENT player is not throttled');

  await new Promise((r) => setTimeout(r, 1600));
  B.drop((m) => m.type === 'partyInvite');  // the first invite is still in B's inbox
  A.send({ type: 'inviteFriend', toUserId: 'B' });
  await B.waitFor((m) => m.type === 'partyInvite');
  ok('after the cooldown elapses the same player can be invited again');

  // --- 5. accepting works across a non-friendship -------------------------------------------
  B.send({ type: 'partyRespond', code: inv.code, accept: true });
  await B.waitFor((m) => m.type === 'roomJoined' && m.mode === 'private');
  await A.waitFor((m) => m.type === 'partyInviteAccepted');
  ok('a stranger who accepts lands in the inviter party');

  // --- 6. a guest cannot be invited (it has no userId to address) ---------------------------
  await G.expectNothing((m) => m.type === 'partyInvite');
  ok('a guest is never reachable by invite');

  A.close(); B.close(); G.close();
  console.log(`\n${pass}/${pass} PASS`);
  srv.kill();
  process.exit(0);
}

main().catch((e) => { console.error('❌ FAIL', e.message); srv.kill(); process.exit(1); });
