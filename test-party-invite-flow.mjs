// PARTY INVITE FLOW, end to end over real sockets — the item-4 regression test.
//
// Covers exactly what the team-first party redesign claims:
//   1) a host queues into a party (createRoom) and is its host.
//   2) a second client is invited, accepts, and lands in the SAME room as the host.
//   3) that second client (a NON-host) invites a THIRD client — all three end up in ONE room,
//      and the ORIGINAL host is still `hostId`. This is the regression test for the server bug at
//      server.js's `inviteFriend` handler: `r.hostId !== member.id` used to treat every non-host's
//      invite as "I have no room", so createPrivateRoom silently forked the inviter into a brand-new
//      room they now hosted — the party split in two with nobody told. Run this file against the
//      commit BEFORE the fix (b3faeba) and section 3 fails; after it, section 3 passes. See the
//      report for the actual before/after run.
//   4) a non-host's `partyGame` is refused; the host's is honoured.
//   5) a non-host's `kick` is refused; the host's kick works.
//
// Boots its own server (boot-test-server.mjs) with a private FOOTBALL_TOKEN_SECRET, so identity is
// real (userId + friends), matching how inviteFriend/kick/partyGame gate on it. Never point this at
// a long-running process: a stale server produced a false green in this repo before.
import { WebSocket } from 'ws';
import jwt from 'jsonwebtoken';
import { bootServer } from './boot-test-server.mjs';

const SECRET = 'party-invite-flow-test-secret';
const { url: URL } = await bootServer({ FOOTBALL_TOKEN_SECRET: SECRET });
const tok = (id, nick) => jwt.sign({ id, nickName: nick }, SECRET, { expiresIn: '1h' });

let failed = 0;
const ok = (label, cond, extra = '') => { if (!cond) failed++; console.log(`  ${cond ? '✅' : '❌'} ${label}${extra ? ` — ${extra}` : ''}`); };

function client(id, nick) {
  const ws = new WebSocket(URL);
  const seen = [], waiters = [];
  ws.on('message', (raw) => {
    if (typeof raw !== 'string' && !(raw instanceof Buffer)) return; // ignore binary snapshots
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (!m || !m.type) return;
    seen.push(m);
    for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].type === m.type) { waiters[i].resolve(m); waiters.splice(i, 1); }
  });
  return {
    id, nick, ws, seen,
    open: () => new Promise((res) => ws.once('open', res)),
    send: (o) => ws.send(JSON.stringify(o)),
    last: (type) => [...seen].reverse().find((m) => m.type === type) || null,
    wait: (type, ms = 4000) => {
      const hit = seen.find((m) => m.type === type);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        waiters.push({ type, resolve });
        setTimeout(() => reject(new Error(`timeout waiting for ${type} (${nick})`)), ms);
      });
    },
    close: () => ws.close(),
  };
}

async function join(id, nick) {
  const c = client(id, nick);
  await c.open();
  c.send({ type: 'join', authToken: tok(id, nick), name: nick, cards: [], cosmetic: null, loadout: [null, null, null] });
  await c.wait('welcome');
  return c;
}

try {
  console.log('1) host queues into a party via createRoom');
  const host = await join('u-host', 'Host');
  const hostMemberId = host.last('welcome').id;   // the host's OWN lobby-member id — what room.hostId must equal, throughout
  host.send({ type: 'createRoom' });
  const hostRoom = await host.wait('roomJoined');
  ok('host is private-room host', hostRoom.mode === 'private' && hostRoom.host === true && !!hostRoom.code, JSON.stringify(hostRoom));
  const roomCode = hostRoom.code;

  console.log('\n2) a second client is invited, accepts, lands in the SAME room');
  const mem2 = await join('u-mem2', 'Mem2');
  host.send({ type: 'setFriends', friends: ['u-mem2'] });
  mem2.send({ type: 'setFriends', friends: ['u-host'] });
  host.send({ type: 'inviteFriend', toUserId: 'u-mem2' });
  const invite2 = await mem2.wait('partyInvite');
  ok('mem2 receives the invite for the host\'s room', invite2.code === roomCode, JSON.stringify(invite2));
  mem2.send({ type: 'partyRespond', code: invite2.code, accept: true });
  const mem2Room = await mem2.wait('roomJoined');
  ok('mem2 lands in the SAME room, as a non-host', mem2Room.code === roomCode && mem2Room.host === false, JSON.stringify(mem2Room));
  {
    const lob = await mem2.wait('lobby');
    const names = (lob.members || []).map((m) => m.name).sort();
    ok('the room lists both Host and Mem2', names.join(',') === 'Host,Mem2', names.join(','));
  }

  console.log('\n3) THE REGRESSION: mem2 (non-host) invites a third client — one room, original host unchanged');
  const mem3 = await join('u-mem3', 'Mem3');
  mem2.send({ type: 'setFriends', friends: ['u-host', 'u-mem3'] });
  mem3.send({ type: 'setFriends', friends: ['u-mem2'] });
  mem2.send({ type: 'inviteFriend', toUserId: 'u-mem3' });
  // If the bug is present, mem2 gets self-healed into a BRAND NEW room and this arrives with a
  // DIFFERENT code — the party silently splits in two. `partyError`/timeout is the other failure
  // shape (mem3's client never even sees a matching invite). Race both so a wrong-code invite still
  // fails the assertion below instead of hanging.
  const invite3 = await Promise.race([
    mem3.wait('partyInvite', 4000),
    mem2.wait('partyError', 4000).then((e) => ({ partyError: e })),
  ]);
  ok('mem2\'s invite did not error out', !invite3.partyError, invite3.partyError ? JSON.stringify(invite3.partyError) : '');
  ok('mem3 is invited into the HOST\'S ORIGINAL room code, not a fresh one', !invite3.partyError && invite3.code === roomCode,
    `expected ${roomCode}, got ${invite3 && invite3.code}`);
  mem3.send({ type: 'partyRespond', code: invite3.code || roomCode, accept: true });
  const mem3Room = await mem3.wait('roomJoined', 4000).catch((e) => ({ error: e.message }));
  ok('mem3 successfully joins', !mem3Room.error && mem3Room.code === roomCode, JSON.stringify(mem3Room));
  let lob3;
  {
    lob3 = await mem3.wait('lobby');
    const names = (lob3.members || []).map((m) => m.name).sort();
    ok('all THREE are in ONE room', names.length === 3 && names.join(',') === 'Host,Mem2,Mem3', names.join(','));
  }
  // THE DIRECT PROOF: `lobby.host` carries the room's `hostId` (a member id — see lobbyPayload in
  // server.js), so this must still equal the ORIGINAL host's own member id, not mem2's (the inviter
  // of mem3) and not some fourth, freshly-forked room's host. This is exactly the field the bug
  // corrupted: before the fix, mem2's invite created a SEPARATE room hosted by mem2, so mem3 would
  // never even reach this shared lobby broadcast to be checked against.
  ok('the ORIGINAL host (not mem2, not a new room) is still hostId', lob3.host === hostMemberId, `hostId=${lob3.host}, expected=${hostMemberId}`);
  ok('host\'s own room code never changed (no self-heal fork)', host.last('roomJoined').code === roomCode, host.last('roomJoined').code);

  console.log('\n4) only the ORIGINAL host\'s partyGame is honoured');
  mem2.send({ type: 'partyGame', game: '3v3' });
  const refused = await mem2.wait('partyError', 3000).catch(() => null);
  ok('a non-host\'s partyGame is refused', !!refused && /מארח/.test(refused.msg || ''), JSON.stringify(refused));
  host.send({ type: 'partyGame', game: '3v3' });
  {
    const lob = await host.wait('lobby');
    // lobbyPayload broadcasts on every change; poll for the one carrying the new game/format.
    let applied = lob;
    for (let i = 0; i < 20 && applied.game !== '3v3'; i++) {
      await new Promise((r) => setTimeout(r, 50));
      applied = host.last('lobby') || applied;
    }
    ok('the HOST\'s pick actually applies (game=3v3, teamSize=3)', applied.game === '3v3' && applied.teamSize === 3, JSON.stringify({ game: applied.game, teamSize: applied.teamSize }));
  }

  console.log('\n5) kick: non-host refused, host\'s works');
  const mem3MemberId = mem3.last('welcome').id;
  mem2.send({ type: 'kick', memberId: mem3MemberId });
  // A non-host's kick is a silent no-op server-side (no error message at all) — there is no event to
  // wait for, so the standard way to prove "nothing happened" is a bounded sleep + assert-unchanged.
  await new Promise((r) => setTimeout(r, 300));
  {
    const lob = host.last('lobby');
    const names = (lob.members || []).map((m) => m.name).sort();
    ok('a non-host\'s kick has NO effect — all three still present', names.length === 3, names.join(','));
  }
  host.send({ type: 'kick', memberId: mem3MemberId });
  const kicked = await mem3.wait('kicked', 3000).catch(() => null);
  ok('the HOST\'s kick removes mem3', !!kicked && kicked.code === roomCode, JSON.stringify(kicked));
  {
    let lob = host.last('lobby');
    for (let i = 0; i < 20 && (lob.members || []).length !== 2; i++) {
      await new Promise((r) => setTimeout(r, 50));
      lob = host.last('lobby') || lob;
    }
    const names = (lob.members || []).map((m) => m.name).sort();
    ok('the room now has just Host and Mem2', names.join(',') === 'Host,Mem2', names.join(','));
  }

  host.close(); mem2.close(); mem3.close();
} catch (e) {
  console.log('❌ EXCEPTION:', e.stack || e.message);
  failed++;
}

console.log(failed ? `\n❌ ${failed} failed` : '\n✅ all passed');
process.exit(failed ? 1 : 0);
