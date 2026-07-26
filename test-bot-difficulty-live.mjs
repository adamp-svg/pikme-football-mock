// BOT DIFFICULTY, end to end over a real socket: does the level you pick actually reach the match,
// can you change it MID-GAME, and does everything that reports it still tell the truth afterwards?
//
// The three bugs this pins down (all found 2026-07-26):
//   1. `training` and `builderMatch` never carried a diffLevel, so BOTH always ran at DEFAULT_LEVEL
//      however the picker was set — and their matchStart sent no diffLevel, so the client's readout
//      had nothing to show.
//   2. A live change moved bot SKILL only. Bot CARD BUFFS are rolled from the level once, at fill
//      time, so after switching levels the bots played at the new skill while carrying the old
//      level's buffs — and the dossier reported those stale buffs as fact.
//   3. The live change was ungated: any client in a PUBLIC matchmade room could re-level the enemy
//      bots mid-match, which also desynced the level reported for the trophy bot-ceiling.
import WebSocket from 'ws';
import { bootServer } from './boot-test-server.mjs';
import { levelAt, DEFAULT_LEVEL, clampLevel } from './shared/difficulty.js';
import { botSideScalar, buffsFromLoadout, EXTREME_SKILL } from './shared/bot-buffs.js';

const { url: URL } = await bootServer();
let failed = 0;
const ok = (label, cond, extra = '') => { if (!cond) failed++; console.log(`  ${cond ? '✅' : '❌'} ${label}${extra ? ` — ${extra}` : ''}`); };

function client(name) {
  const ws = new WebSocket(URL);
  const seen = [], waiters = [];
  ws.on('message', (raw, isBinary) => {
    if (isBinary) return;
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (!m || !m.type) return;
    seen.push(m);
    for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].type === m.type) { waiters[i].resolve(m); waiters.splice(i, 1); }
  });
  return {
    open: () => new Promise((res) => ws.once('open', res)),
    send: (o) => ws.send(JSON.stringify(o)),
    // `after` skips frames already buffered — needed to wait for the SECOND `bots` frame (the one a
    // live difficulty change causes) rather than matching the one that arrived at match start.
    wait: (type, { ms = 14000, after = 0 } = {}) => {
      const hit = seen.filter((m) => m.type === type)[after];
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        waiters.push({ type, resolve });
        setTimeout(() => reject(new Error(`timeout waiting for ${type} (${name})`)), ms);
      });
    },
    count: (type) => seen.filter((m) => m.type === type).length,
    close: () => ws.close(),
  };
}
async function enter(launch, label) {
  const c = client(label);
  await c.open();
  c.send({ type: 'join', name: label });
  await c.wait('welcome');
  c.send(launch);
  return c;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\n1) the picked level REACHES training + the builder playtest');
{
  const LVL = 9;
  const t = await enter({ type: 'training', diffLevel: LVL }, 'trainee');
  const ts = await t.wait('matchStart');
  ok('training matchStart carries diffLevel', ts.diffLevel === LVL, `got ${ts.diffLevel}`);
  ok('training mode still reported', ts.mode === 'training');
  t.close();

  const field = { version: 3, size: 's2v2', bushes: [], hardWalls: [], dryWalls: [], crates: [], spawns: [], ball: null };
  const b = await enter({ type: 'builderMatch', field, diffLevel: LVL }, 'builder');
  const bs = await b.wait('matchStart');
  ok('builder matchStart carries diffLevel', bs.diffLevel === LVL, `got ${bs.diffLevel}`);
  b.close();

  // No diffLevel sent => the room keeps the default, and still SAYS so (it used to say nothing).
  const d = await enter({ type: 'training' }, 'default');
  const ds = await d.wait('matchStart');
  ok('no level sent => default reported, not undefined', ds.diffLevel === DEFAULT_LEVEL, `got ${ds.diffLevel}`);
  d.close();
}

console.log('\n2) MID-GAME change: skill AND card buffs AND the dossier all move');
{
  const c = await enter({ type: 'botGame', diffLevel: 2 }, 'vsbots');
  const start = await c.wait('matchStart');
  ok('vs-bots starts at the picked level', start.diffLevel === 2, `got ${start.diffLevel}`);
  const before = (start.players || []).filter((p) => p.isBot);
  ok('bots come with a dossier (buffs + skill + level)', before.length > 0 && before.every((p) => p.buffs && typeof p.skill === 'number' && typeof p.botLevel === 'number'));
  ok('their reported level matches the room', before.every((p) => p.botLevel === 2));
  ok('their reported buffs are the ones their loadout implies',
    before.every((p) => Math.abs(p.buffs.cardShot - buffsFromLoadout(p.loadout).cardShot) < 1e-9
      || p.skill >= EXTREME_SKILL)); // an extreme bot carries the flat cheat set, not f(cards)

  // Switch to the top of the ladder mid-match.
  const seenBots = c.count('bots');
  c.send({ type: 'settings', diffLevel: 11 });
  const frame = await c.wait('bots', { after: seenBots });
  ok('the server echoes the applied level back', frame.diffLevel === 11, `got ${frame.diffLevel}`);
  const after = frame.bots || [];
  ok('every bot is re-stamped with the new level', after.length > 0 && after.every((b) => b.botLevel === 11));
  // Level 11 = extreme enemy, easy partner. The bot on MY team must NOT get the enemy scalar.
  const lvl = levelAt(11);
  ok('skill is per SIDE (partner vs enemy), not one number for everyone',
    after.every((b) => Math.abs(b.skill - botSideScalar(lvl, b.partnerSide)) < 1e-9),
    after.map((b) => `${b.partnerSide ? 'mate' : 'foe'}:${b.skill}`).join(' '));
  ok('the ENEMY side reaches the cheat tier at level 11', after.some((b) => !b.partnerSide && b.skill >= EXTREME_SKILL));
  ok('card buffs were re-rolled with the level (not left at the old one)',
    after.every((b) => Math.abs(b.buffs.cardShot - buffsFromLoadout(b.loadout).cardShot) < 1e-9 || b.skill >= EXTREME_SKILL));
  ok('the dossier cards match the new loadout', after.every((b) => Array.isArray(b.cards) && b.cards.length === (b.loadout || []).filter(Boolean).length));

  // Re-sending the SAME level must not churn (no reroll, no extra frame).
  const n = c.count('bots');
  c.send({ type: 'settings', diffLevel: 11 });
  await sleep(300);
  ok('re-sending the same level is a no-op (no reroll storm)', c.count('bots') === n, `${c.count('bots')} vs ${n}`);
  c.close();
}

console.log('\n2b) the TRAINING GROUND accepts a mid-game change too');
{
  // Training's enemies are role-driven (sentry/keeper/still) and carry no card buffs, so the proof
  // that the room took the change is the echoed level — updateTrainingDummy reads
  // levelAt(room.diffLevel).enemy every tick, so the sentry retunes on the next frame.
  const c = await enter({ type: 'training', diffLevel: 0 }, 'train-live');
  const s = await c.wait('matchStart');
  ok('training opens at the picked level', s.diffLevel === 0, `got ${s.diffLevel}`);
  const n = c.count('bots');
  c.send({ type: 'settings', diffLevel: 10 });
  const frame = await c.wait('bots', { after: n });
  ok('training echoes the new level mid-game', frame.diffLevel === 10, `got ${frame.diffLevel}`);
  ok('training reports no card-buff dossier (its enemies have none)', Array.isArray(frame.bots) && frame.bots.length === 0);
  // The sentry tier the enemy scalar maps to must actually have moved (easy -> hard band).
  ok('the enemy scalar moved into the hard band', levelAt(10).enemy > 0.66 && levelAt(0).enemy < 0.18,
    `${levelAt(0).enemy} -> ${levelAt(10).enemy}`);
  c.close();
}

console.log('\n3) a PUBLIC matchmade room refuses a live re-level');
{
  const c = await enter({ type: 'quickMatch', diffLevel: 4 }, 'ranked');
  const start = await c.wait('matchStart');
  const asked = start.diffLevel;
  ok('quick match reports the level it was joined at', typeof asked === 'number', `got ${asked}`);
  const n = c.count('bots');
  c.send({ type: 'settings', diffLevel: 11 });
  await sleep(400);
  ok('no bots frame → the change was rejected', c.count('bots') === n, `${c.count('bots')} vs ${n}`);
  // And the level the room still reports is the one it started with: ask for a fresh dossier by
  // changing nothing else, then read the last frame we have.
  const frames = [];
  for (let i = 0; i < c.count('bots'); i++) frames.push(await c.wait('bots', { after: i }));
  const last = frames[frames.length - 1];
  if (last) ok('the room level is unchanged', last.diffLevel === asked, `${last.diffLevel} vs ${asked}`);
  else ok('the room level is unchanged (no dossier frame to contradict it)', true);
  c.close();
}

console.log('\n4) clamping: a junk level can never land in a room');
{
  const c = await enter({ type: 'training', diffLevel: 999 }, 'junk');
  const s = await c.wait('matchStart');
  ok('an out-of-range level is clamped, not stored raw', s.diffLevel === clampLevel(999), `got ${s.diffLevel}`);
  c.close();
  const c2 = await enter({ type: 'training', diffLevel: 'hard' }, 'junk2');
  const s2 = await c2.wait('matchStart');
  ok('a non-numeric level falls back to the default', s2.diffLevel === DEFAULT_LEVEL, `got ${s2.diffLevel}`);
  c2.close();
}

console.log(`\n${failed === 0 ? '✅ ALL PASS' : `❌ ${failed} FAILED`}\n`);
process.exit(failed ? 1 : 0);
