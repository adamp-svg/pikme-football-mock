// e2e: the ARENA SIZE a field was authored on must survive the trip to the server, and the server
// must refuse to HOST a size it cannot honestly simulate.
//
// The two bugs this pins down:
//   1. `sanitizeField` clamped every coordinate to the global FIELD (2000x1100), so a layout drawn
//      on a bigger pitch came back with its whole right-hand side collapsed onto the touchline —
//      silently, with no error. A bigger stadium could not round-trip at all.
//   2. The builder's ▶ שחק gate is CLIENT state. A crafted `builderMatch` could ask the server to
//      host a 2900x1700 pitch while the sim still ran 2000x1100 goal lines, penalty boxes and
//      spawns underneath it — wrong in a way that reads as a physics bug, not a rejected request.
//
// Needs a live server:  PORT=3013 node server.js
import { WebSocket } from 'ws';
import { FIELD_SIZES, RUNTIME_SIZES, canHost } from './shared/field-sizes.js';
import { FIELD } from './shared/constants.js';

const PORT = process.env.PORT || 3013;
const URL = `ws://localhost:${PORT}`;
let failed = 0;
const ok = (cond, msg) => { console.log(`   ${cond ? '✅' : '❌'} ${msg}`); if (!cond) failed++; };

function client(name) {
  const ws = new WebSocket(URL);
  const seen = [];
  const waiters = [];
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
    ws,
    open: () => new Promise((res) => ws.once('open', res)),
    send: (o) => ws.send(JSON.stringify(o)),
    wait: (type, ms = 8000) => {
      const hit = seen.find((m) => m.type === type);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        waiters.push({ type, resolve });
        setTimeout(() => reject(new Error(`timeout waiting for ${type} (${name})`)), ms);
      });
    },
    // Resolve with the FIRST of several types to arrive — used to assert a REJECT beats a start.
    race: (types, ms = 4000) => new Promise((resolve) => {
      const hit = seen.find((m) => types.includes(m.type));
      if (hit) return resolve(hit);
      for (const t of types) waiters.push({ type: t, resolve });
      setTimeout(() => resolve(null), ms);
    }),
    close: () => ws.close(),
  };
}

// A layout whose elements sit far out on the X axis — beyond the base pitch, inside a big one.
// If the size is honoured these coordinates come back untouched; if it is clamped to FIELD.W they
// collapse to 2000 and the crate lands on the touchline.
const bigField = (sizeId) => ({
  version: 2, size: sizeId,
  bushes: [], hardWalls: [], dryWalls: [],
  crates: [{ x: 2400, y: 1300, w: 50, h: 50 }],
});

console.log('1) a hostable size starts a match and keeps its coordinates');
{
  const a = client('host-ok');
  await a.open();
  a.send({ type: 'join', name: 'sizer' });
  a.send({ type: 'builderMatch', field: { version: 2, size: 's2v2', bushes: [], hardWalls: [], dryWalls: [], crates: [{ x: 1500, y: 800, w: 50, h: 50 }] } });
  const start = await a.wait('matchStart');
  ok(!!start.arena, `s2v2 builderMatch starts a match (arena present)`);
  const crate = (start.arena && start.arena.crates && start.arena.crates[0]) || null;
  ok(!!crate && crate.x === 1500 && crate.y === 800, `an in-bounds crate round-trips exactly (got ${crate ? `${crate.x},${crate.y}` : 'none'})`);
  ok(start.arena.size === 's2v2', `the server echoes the resolved size id back (got ${start.arena.size})`);
  a.close();
}

console.log('2) a size the sim cannot host is REFUSED, not silently downgraded');
{
  const notHostable = Object.keys(FIELD_SIZES).filter((id) => !canHost(id));
  ok(notHostable.length > 0, `there is at least one authorable-but-not-hostable size to test (${notHostable.join(', ')})`);
  for (const id of notHostable) {
    const c = client(`host-no-${id}`);
    await c.open();
    c.send({ type: 'join', name: 'sizer' });
    c.send({ type: 'builderMatch', field: bigField(id) });
    const first = await c.race(['roomError', 'matchStart']);
    ok(first && first.type === 'roomError', `${id}: server answers roomError, NOT matchStart (got ${first ? first.type : 'nothing'})`);
    c.close();
  }
}

console.log('3) a legacy size-less field is treated as the shipped pitch, never rescaled');
{
  const a = client('legacy');
  await a.open();
  a.send({ type: 'join', name: 'sizer' });
  // Exactly what a pre-sizes save looks like: version 1, no `size`.
  a.send({ type: 'builderMatch', field: { version: 1, bushes: [], hardWalls: [], dryWalls: [], crates: [{ x: 900, y: 500, w: 50, h: 50 }] } });
  const start = await a.wait('matchStart');
  ok(start.arena && start.arena.size === 's2v2', `a v1 save resolves to s2v2 (got ${start.arena && start.arena.size})`);
  const crate = start.arena.crates[0];
  ok(crate.x === 900 && crate.y === 500, `its coordinates are untouched (got ${crate.x},${crate.y})`);
  ok(FIELD.W === FIELD_SIZES.s2v2.W && FIELD.H === FIELD_SIZES.s2v2.H, `and s2v2 still IS the global FIELD ${FIELD.W}x${FIELD.H}`);
  a.close();
}

console.log(`\nRUNTIME_SIZES = [${RUNTIME_SIZES.join(', ')}]`);
console.log(failed ? `\n❌ ${failed} FAILED` : '\n✅ ALL PASS');
process.exit(failed ? 1 : 0);
