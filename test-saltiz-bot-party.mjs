// End-to-end: inviting a NAMED Saltiz bot friend into a party puts it in the match at ITS OWN level
// with the cards its friend card advertised. Boots its own server on a private port (same pattern as
// test-party.mjs). Run: node test-saltiz-bot-party.mjs
//
// What this pins that a unit test cannot:
//   §1 addBot { botId } → the lobby shows the bot with its 3 cards and its רמה.
//   §2 at kickoff it is in the match roster under its own NAME, at its own botLevel, with the SAME
//      three cards — the client drew those cards from the shared roster, so a mismatch here is the
//      "display != gameplay" bug this feature could most easily ship.
//   §3 its skill comes from its own level, not the room's difficulty (that is the whole feature).
//   §4 a client CANNOT dictate the level: a forged `level`/`loadout` in the message is ignored.
//   §5 an old client's plain `addBot { name }` still works (generic bot at room difficulty).
import { WebSocket } from 'ws';
import jwt from 'jsonwebtoken';
import { spawn } from 'node:child_process';
import { SALTIZ_BOT_BY_ID, botLevelOf, saltizBotLoadout } from './shared/saltiz-bots.js';
import { levelAt } from './shared/difficulty.js';
import { botSideScalar } from './shared/bot-buffs.js';

const SECRET = process.env.FOOTBALL_TOKEN_SECRET || 'testsecret';
const OWN_PORT = 3800 + (process.pid % 90);
let child = null;
if (!process.env.URL) {
  child = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, PORT: String(OWN_PORT), FOOTBALL_TOKEN_SECRET: SECRET },
    stdio: 'ignore',
  });
  process.on('exit', () => child?.kill());
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try { const res = await fetch(`http://localhost:${OWN_PORT}/`); if (res.ok) break; } catch { /* not up yet */ }
  }
}
const URL = process.env.URL || `ws://localhost:${OWN_PORT}`;
const tok = (id, nick) => jwt.sign({ id, nickName: nick }, SECRET, { expiresIn: '1h' });

function client(id, nick) {
  const ws = new WebSocket(URL);
  const got = [];
  const waiters = [];
  ws.on('message', (raw) => {
    if (typeof raw !== 'string' && !(raw instanceof Buffer)) return;
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (!m || !m.type) return;
    got.push(m);
    for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].type === m.type) { waiters[i].resolve(m); waiters.splice(i, 1); }
  });
  return {
    ws, id, got,
    open: () => new Promise((r) => ws.on('open', r)),
    send: (o) => ws.send(JSON.stringify(o)),
    wait: (type, ms = 4000) => new Promise((resolve, reject) => {
      const hit = got.find((m) => m.type === type);
      if (hit) return resolve(hit);
      const w = { type, resolve };
      waiters.push(w);
      setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); reject(new Error('timeout waiting ' + type)); } }, ms);
    }),
    // Poll the LATEST lobby frame for a member (several arrive per second).
    lobbyMember: async (pred, tries = 25) => {
      for (let i = 0; i < tries; i++) {
        await new Promise((r) => setTimeout(r, 100));
        const last = got.filter((m) => m.type === 'lobby').pop();
        const hit = (last?.members || []).find(pred);
        if (hit) return hit;
      }
      return null;
    },
  };
}

let failed = false;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) failed = true; };
const sig = (lo) => JSON.stringify((lo || []).map((s) => (s ? `${s.r}${s.n}` : '-')));

const SHUVAL = SALTIZ_BOT_BY_ID.get('saltiz-shuval');   // רמה 11 → botLevel 10
const URI = SALTIZ_BOT_BY_ID.get('saltiz-uri');         // רמה 5  → botLevel 4

try {
  // ── §1/§2/§3 — invite שובל, then kick off. ────────────────────────────────────────────────────
  const A = client('userA', 'Alice');
  await A.open();
  A.send({ type: 'join', authToken: tok('userA', 'Alice'), name: 'Alice', cards: [], cosmetic: null, loadout: [null, null, null] });
  await A.wait('welcome');
  A.send({ type: 'createRoom' });
  await A.wait('roomJoined');
  // Room difficulty deliberately set LOW, so anything that reads the room level instead of the bot's
  // own shows up as a failure below rather than passing by coincidence.
  A.send({ type: 'settings', diffLevel: 1 });   // a private room is a canSetDiffLive room
  A.send({ type: 'addBot', botId: SHUVAL.id, name: SHUVAL.nickName });

  const lb = await A.lobbyMember((m) => m.isBot && m.name === SHUVAL.nickName);
  ok(!!lb, `§1 ${SHUVAL.nickName} is in the party lobby`);
  ok(lb && lb.level === SHUVAL.level, `§1 lobby shows רמה ${SHUVAL.level} (got ${lb && lb.level})`);
  ok(lb && (lb.cards || []).length === 3, `§1 lobby shows 3 power cards (got ${lb ? (lb.cards || []).length : 0})`);
  ok(lb && sig(lb.loadout) === sig(saltizBotLoadout(SHUVAL)),
    `§1 lobby cards are the roster's seeded roll ${sig(saltizBotLoadout(SHUVAL))} (got ${lb ? sig(lb.loadout) : 'none'})`);

  A.send({ type: 'ready' });
  const ms = await A.wait('matchStart', 10000);
  const inMatch = (ms.players || []).find((p) => p.isBot && p.name === SHUVAL.nickName);
  ok(!!inMatch, `§2 ${SHUVAL.nickName} is in the match roster under his own name`);
  ok(inMatch && inMatch.botLevel === botLevelOf(SHUVAL),
    `§2 plays at botLevel ${botLevelOf(SHUVAL)} while the room is at 1 (got ${inMatch && inMatch.botLevel})`);
  ok(inMatch && sig(inMatch.loadout) === sig(saltizBotLoadout(SHUVAL)),
    `§2 match cards == the cards his friend card showed (${sig(saltizBotLoadout(SHUVAL))})`);
  const want = botSideScalar(levelAt(botLevelOf(SHUVAL)), inMatch && inMatch.partnerSide);
  ok(inMatch && Math.abs(inMatch.skill - want) < 1e-9,
    `§3 skill ${inMatch && inMatch.skill} comes from HIS level (want ${want}), not the room's`);
  // The other bots that backfilled the room must still be at the ROOM's level — the override is
  // per-bot, not a room-wide difficulty change.
  const others = (ms.players || []).filter((p) => p.isBot && p.name !== SHUVAL.nickName);
  ok(others.length > 0 && others.every((p) => p.botLevel === 1),
    `§3 the ${others.length} backfill bots stay at the room level 1 (got ${others.map((p) => p.botLevel).join(',')})`);
  A.ws.close();

  // ── §4 — a forged level/loadout in the message must be ignored. ───────────────────────────────
  const B = client('userB', 'Bob');
  await B.open();
  B.send({ type: 'join', authToken: tok('userB', 'Bob'), name: 'Bob', cards: [], cosmetic: null, loadout: [null, null, null] });
  await B.wait('welcome');
  B.send({ type: 'createRoom' });
  await B.wait('roomJoined');
  B.send({ type: 'addBot', botId: URI.id, name: 'לא-אורי', level: 11, namedLevel: 11,
    loadout: [{ r: 'legendary', n: 1 }, { r: 'legendary', n: 2 }, { r: 'legendary', n: 3 }] });
  const forged = await B.lobbyMember((m) => m.isBot);
  ok(forged && forged.name === URI.nickName, `§4 the name comes from the roster, not the message (got ${forged && forged.name})`);
  ok(forged && forged.level === URI.level, `§4 level stays רמה ${URI.level} (got ${forged && forged.level})`);
  ok(forged && sig(forged.loadout) === sig(saltizBotLoadout(URI)), '§4 the forged legendary loadout was ignored');
  ok(forged && !(forged.loadout || []).every((s) => s && s.r === 'legendary'), '§4 אורי did not get three legendaries');
  B.ws.close();

  // ── §5 — the old message shape still works. ───────────────────────────────────────────────────
  const C = client('userC', 'Carol');
  await C.open();
  C.send({ type: 'join', authToken: tok('userC', 'Carol'), name: 'Carol', cards: [], cosmetic: null, loadout: [null, null, null] });
  await C.wait('welcome');
  C.send({ type: 'createRoom' });
  await C.wait('roomJoined');
  C.send({ type: 'addBot', name: 'רובי' });
  const legacy = await C.lobbyMember((m) => m.isBot && m.name === 'רובי');
  ok(!!legacy, '§5 a plain addBot { name } still adds a generic bot');
  ok(legacy && legacy.level === undefined, '§5 a generic bot advertises no level of its own');
  C.ws.close();
} catch (e) {
  failed = true;
  console.log('✗ threw:', e && e.message);
}
child?.kill();
console.log(failed ? '❌ test-saltiz-bot-party FAILED' : '✅ test-saltiz-bot-party passed');
process.exit(failed ? 1 : 0);
