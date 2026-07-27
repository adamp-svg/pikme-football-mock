// MATCHMAKING, end to end over real sockets.
//
// test-matchmaker.mjs owns the POLICY (pure, no timers). This owns the WIRING: that trophies reach
// the bands, that the searching message is actually sent, that humans land on opposite teams, and
// that a full room does not wait out its budget.
//
// Boots its own server (boot-test-server.mjs). Never point this at a long-running process: a stale
// server produced a FALSE GREEN in this repo before, which is worse than no server.
import { WebSocket } from 'ws';
import { bootServer } from './boot-test-server.mjs';
import { MM_ALONE_MS, MM_BUDGET_QUICK_MS, MM_REVEAL_MS } from './shared/constants.js';

const { url: URL } = await bootServer();
let failed = 0;
const ok = (l, c, x = '') => { if (!c) failed++; console.log(`  ${c ? '✅' : '❌'} ${l}${x ? ` — ${x}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(name) {
  const ws = new WebSocket(URL);
  const seen = [], waiters = [];
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (!m || !m.type) return;
    seen.push(m);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].type === m.type) { waiters[i].resolve(m); waiters.splice(i, 1); }
    }
  });
  return {
    name, seen,
    open: () => new Promise((res) => ws.once('open', res)),
    send: (o) => ws.send(JSON.stringify(o)),
    all: (type) => seen.filter((m) => m.type === type),
    last: (type) => [...seen].reverse().find((m) => m.type === type) || null,
    wait: (type, ms = 20000) => {
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
// A joined client, ready to queue.
async function join(name, trophies) {
  const c = client(name);
  await c.open();
  c.send({ type: 'join', name, cards: [] });
  await c.wait('welcome').catch(() => null);   // some builds name it differently; presence is enough
  c.trophies = trophies;
  return c;
}

console.log('1) a lone player short-circuits to bots, fast');
{
  const a = await join('Solo', 1000);
  const t0 = Date.now();
  a.send({ type: 'quickMatch', trophies: 1000, diffLevel: 4 });
  const s = await a.wait('searching');
  ok('a searching message arrives before any room', !!s && !a.last('roomJoined'), JSON.stringify(s && s.phase));
  ok('...reporting my own band', s.slots && s.slots.total === 4, JSON.stringify(s.slots));
  const rj = await a.wait('roomJoined');
  const dt = Date.now() - t0;
  ok('resolves near MM_ALONE_MS, not the full budget', dt < MM_BUDGET_QUICK_MS, `${dt}ms`);
  ok('...as a single human', rj.humans === 1, String(rj.humans));
  const ms = await a.wait('matchStart');
  ok('the match starts after the reveal hold', Date.now() - t0 >= MM_ALONE_MS + MM_REVEAL_MS - 400, `${Date.now() - t0}ms`);
  ok('...with a full roster of 4', (ms.players || []).filter(Boolean).length === 4, String((ms.players || []).length));
  ok('...and every bot has a real name, not "Bot"',
    (ms.players || []).filter((p) => p && p.isBot).every((p) => p.name && p.name !== 'Bot'),
    JSON.stringify((ms.players || []).filter((p) => p && p.isBot).map((p) => p.name)));
  a.close();
}

console.log('\n2) two same-band players are matched, on OPPOSITE teams');
{
  const a = await join('Ay', 1000), b = await join('Bee', 1100);
  a.send({ type: 'quickMatch', trophies: 1000, diffLevel: 4 });
  await sleep(150);
  b.send({ type: 'quickMatch', trophies: 1100, diffLevel: 4 });
  const [ra, rb] = await Promise.all([a.wait('roomJoined'), b.wait('roomJoined')]);
  ok('both see 2 humans', ra.humans === 2 && rb.humans === 2, `${ra.humans}/${rb.humans}`);
  const ms = await a.wait('matchStart');
  const humans = (ms.players || []).filter((p) => p && !p.isBot);
  ok('two humans in the match', humans.length === 2, String(humans.length));
  ok('...on opposite teams', new Set(humans.map((p) => p.team)).size === 2, JSON.stringify(humans.map((p) => p.team)));
  a.close(); b.close();
}

console.log('\n3) far-apart bands are NOT matched together');
{
  // L1 (0 trophies) and L11 (5500) must never share a room, however long either waits.
  const a = await join('Rookie', 0), b = await join('Veteran', 5500);
  a.send({ type: 'quickMatch', trophies: 0, diffLevel: 0 });
  b.send({ type: 'quickMatch', trophies: 5500, diffLevel: 10 });
  const [ra, rb] = await Promise.all([a.wait('roomJoined'), b.wait('roomJoined')]);
  ok('each gets its OWN room', ra.humans === 1 && rb.humans === 1, `${ra.humans}/${rb.humans}`);
  const [ma, mb] = await Promise.all([a.wait('matchStart'), b.wait('matchStart')]);
  const lv = (m) => (m.players || []).find((p) => p && p.isBot)?.level;
  ok('the rookie faces low-level bots and the veteran high-level ones', lv(ma) < lv(mb), `${lv(ma)} vs ${lv(mb)}`);
  a.close(); b.close();
}

console.log('\n4) a full room kicks off without waiting out the budget');
{
  const cs = await Promise.all([join('P1', 1000), join('P2', 1000), join('P3', 1000), join('P4', 1000)]);
  const t0 = Date.now();
  for (const c of cs) c.send({ type: 'matchmade', format: 'quick', trophies: 1000, diffLevel: 4 });
  const rjs = await Promise.all(cs.map((c) => c.wait('roomJoined')));
  const dt = Date.now() - t0;
  ok('all four land in one room', rjs.every((r) => r.humans === 4), JSON.stringify(rjs.map((r) => r.humans)));
  // Budget for a mode card is 10s; a full room must not wait for it.
  ok('resolved well under the 10s budget', dt < 3000, `${dt}ms`);
  const ms = await cs[0].wait('matchStart');
  ok('no bots in a full human room', !(ms.players || []).some((p) => p && p.isBot), JSON.stringify((ms.players || []).map((p) => p && p.isBot)));
  ok('teams are 2-2', (ms.players || []).filter((p) => p && p.team === 'A').length === 2);
  for (const c of cs) c.close();
}

console.log('\n5) cancelling removes the ticket');
{
  const a = await join('Quitter', 1000), b = await join('Stayer', 1000);
  a.send({ type: 'quickMatch', trophies: 1000, diffLevel: 4 });
  b.send({ type: 'quickMatch', trophies: 1000, diffLevel: 4 });
  await b.wait('searching');
  await sleep(400);
  const before = b.last('searching');
  ok('with company, b sees 2 searching', before.searchingCount === 2, String(before.searchingCount));
  a.send({ type: 'cancelSearch' });
  await sleep(600);
  const after = b.last('searching');
  ok('after a cancels, b sees 1 searching', after.searchingCount === 1, String(after.searchingCount));
  ok('a is sent home', !!a.last('toHome'));
  a.close(); b.close();
}

console.log('\n6) the other room types still bypass matchmaking');
{
  const a = await join('Trainer', 1000);
  a.send({ type: 'training', diffLevel: 3 });
  const ms = await a.wait('matchStart');
  ok('training starts immediately, with no searching message', !a.last('searching'), JSON.stringify(a.all('searching').length));
  ok('...and is a real match', !!ms);
  a.close();
  const h = await join('Host', 1000);
  h.send({ type: 'createRoom' });
  const rj = await h.wait('roomJoined');
  ok('a private room is not matchmade', rj.matchmade !== true, JSON.stringify(rj.matchmade));
  ok('...and produced no searching message', !h.last('searching'));
  h.close();
}

console.log(failed ? `\n❌ ${failed} failed` : '\n✅ all passed');
process.exit(failed ? 1 : 0);
