// TEAM ALTERNATION regression (carry-over from Task 3's review of formGroup, server.js).
//
// "Humans land on opposite teams" is an explicit product decision, delivered by sorting the group's
// members by trophies and then inserting them one at a time into a still-EMPTY room: addToRoom()
// stamps each member's team via balancedTeam(room), which ties towards 'A' when both sides are equal,
// so insertion order into an empty room alone produces A,B,A,B. There used to be an extra
// `members.forEach((m,i)=>{m.team=i%2===0?'A':'B'})` line that LOOKED like it delivered this, but it
// was dead — addToRoom() unconditionally overwrote m.team a few lines below it. Nothing in the suite
// correlated `team` with `trophies`, so a future change to balancedTeam's tie-break could silently
// break the alternation with no test noticing. This is that test.
//
// BOOTS ITS OWN SERVER (boot-test-server.mjs) — see that file for why a hand-started process produces
// false reds/greens in this suite.
import { WebSocket } from 'ws';
import { bootServer } from './boot-test-server.mjs';

const { url: URL } = await bootServer();
let failed = 0;
const ok = (label, cond, extra = '') => { if (!cond) failed++; console.log(`  ${cond ? '✅' : '❌'} ${label}${extra ? ` — ${extra}` : ''}`); };

function client(name) {
  const ws = new WebSocket(URL);
  const seen = [], waiters = [];
  ws.on('message', (raw) => {
    if (typeof raw !== 'string' && !Buffer.isBuffer(raw)) return; // binary snapshots aren't JSON
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

// Four CLEARLY different trophy values, all inside the SAME matchmaking band — bandOf(1000..1499)
// is L5 (see test-matchmaker.mjs's own "1000 trophies -> L5" case) — so the matcher forms one 'full'
// group immediately instead of waiting out a widening budget that isn't what this test is about.
const TROPHIES = { p1000: 1000, p1150: 1150, p1300: 1300, p1450: 1450 };
const names = Object.keys(TROPHIES);

console.log('4 humans, clearly different trophies, same band -> queued via matchmade');
const clients = names.map((n) => client(n));
await Promise.all(clients.map((c) => c.open()));
clients.forEach((c, i) => c.send({ type: 'join', name: names[i] }));
await Promise.all(clients.map((c) => c.wait('welcome')));
clients.forEach((c, i) => c.send({ type: 'matchmade', format: 'quick', trophies: TROPHIES[names[i]] }));

const joined = await Promise.all(clients.map((c) => c.wait('roomJoined')));
ok('all 4 resolve with reason "full" (no widening needed — same band)',
  joined.every((j) => j.mmReason === 'full'), joined.map((j) => j.mmReason).join(','));
ok('all 4 see 4 humans in the group', joined.every((j) => j.humans === 4), joined.map((j) => j.humans).join(','));

const starts = await Promise.all(clients.map((c) => c.wait('matchStart')));
clients.forEach((c) => c.close());

const byName = names.map((n, i) => ({ name: n, trophies: TROPHIES[n], team: starts[i].team }));
console.log('  teams from matchStart:', JSON.stringify(byName));

ok('every human landed on team A or B', byName.every((h) => h.team === 'A' || h.team === 'B'));
ok('exactly 2 humans on each team (2v2)',
  byName.filter((h) => h.team === 'A').length === 2 && byName.filter((h) => h.team === 'B').length === 2,
  `A=${byName.filter((h) => h.team === 'A').length} B=${byName.filter((h) => h.team === 'B').length}`);

const ranked = [...byName].sort((a, b) => b.trophies - a.trophies);
console.log('  ranked by trophies (desc):', ranked.map((h) => `${h.name}(${h.trophies}):${h.team}`).join(' , '));
const alternates = ranked.every((h, i) => i === 0 || h.team !== ranked[i - 1].team);
ok('ranking the 4 humans by trophies gives ALTERNATING teams (the product decision this pins down)',
  alternates, ranked.map((h) => h.team).join(''));

console.log(failed ? `\n❌ ${failed} FAILED` : '\n✅ ALL PASS');
process.exit(failed ? 1 : 0);
