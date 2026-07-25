// E2E over a REAL socket: does `matchStart` actually carry each bot's difficulty, card slots and
// the buffs the sim is applying? The settings readout is only as honest as this payload, and a
// jsdom test can't prove the server sends it — it can only prove the panel draws what it's given.
//
// Boots its own server on a free port so it never collides with the dev servers on :3010-:3013.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import WebSocket from 'ws';
import { buffsFromLoadout, loadoutTotalPct, totalBoostPct, EXTREME_SKILL, botSideScalar } from './shared/bot-buffs.js';
import { levelAt } from './shared/difficulty.js';

const here = dirname(fileURLToPath(import.meta.url));
let failed = 0;
const ok = (label, cond, extra = '') => { if (!cond) failed++; console.log(`  ${cond ? '✅' : '❌'} ${label}${extra ? ` — ${extra}` : ''}`); };

// A real free-port probe. test-party.mjs picked `3900 + pid%90` and a squatter on that port could
// resurrect a false failure (noted in the request log) — don't repeat it.
const freePort = () => new Promise((res, rej) => {
  const s = createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

const PORT = await freePort();
const srv = spawn(process.execPath, [join(here, 'server.js')], {
  env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
});
const kill = () => { try { srv.kill('SIGKILL'); } catch { /* already gone */ } };
process.on('exit', kill);

// Wait for the listener rather than sleeping a fixed amount.
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('server did not start in 8s')), 8000);
  srv.stdout.on('data', (b) => { if (String(b).includes(String(PORT))) { clearTimeout(t); res(); } });
  srv.stderr.on('data', (b) => process.stderr.write(b));
});

// Ask for a vs-bots match at a given difficulty and return its matchStart payload.
function playAt(diffLevel) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const t = setTimeout(() => { ws.close(); rej(new Error(`no matchStart at level ${diffLevel}`)); }, 15000);
    // `join` first — every other message is dropped until the member exists. Send a real album +
    // loadout so the bot sizing has humans to match against (botLoadoutParamsFromHumans).
    ws.on('open', () => ws.send(JSON.stringify({
      type: 'join', name: 'Tester',
      cards: [{ r: 'legendary', n: 1, c: 1 }, { r: 'epic', n: 2, c: 1 }, { r: 'rare', n: 3, c: 1 }],
      loadout: [{ r: 'legendary', n: 1 }, { r: 'epic', n: 2 }, { r: 'rare', n: 3 }],
    })));
    ws.on('message', (raw) => {
      if (typeof raw !== 'string' && !Buffer.isBuffer(raw)) return;
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }   // binary snapshots
      if (msg.type === 'welcome') {
        ws.send(JSON.stringify({ type: 'settings', diffLevel }));
        ws.send(JSON.stringify({ type: 'botGame', diffLevel }));
      } else if (msg.type === 'matchStart') { clearTimeout(t); ws.close(); res(msg); }
    });
    ws.on('error', (e) => { clearTimeout(t); rej(e); });
  });
}

try {
  console.log('--- a mid-ladder vs-bots match (level 5) ---');
  const m5 = await playAt(5);
  const bots5 = (m5.players || []).filter((p) => p.isBot);
  ok('matchStart carries the room difficulty', m5.diffLevel === 5, `got ${m5.diffLevel}`);
  ok('the roster contains bots', bots5.length > 0, `${bots5.length} bots`);
  ok('every bot reports its difficulty level', bots5.every((b) => b.botLevel === 5), JSON.stringify(bots5.map((b) => b.botLevel)));
  ok('every bot reports its skill scalar', bots5.every((b) => typeof b.skill === 'number' && b.skill >= 0 && b.skill <= 1),
    JSON.stringify(bots5.map((b) => b.skill)));
  ok('every bot reports the buffs the sim applies', bots5.every((b) => b.buffs
    && typeof b.buffs.cardShot === 'number' && typeof b.buffs.speedBuff === 'number' && typeof b.buffs.cardUtil === 'number'));
  ok('every bot carries a 3-slot loadout', bots5.every((b) => Array.isArray(b.loadout) && b.loadout.length === 3),
    JSON.stringify(bots5.map((b) => (b.loadout || []).length)));

  // The point of sending `buffs` rather than letting the client derive them: below the cheat tier
  // the two must AGREE exactly, so any disagreement means the sim and the panel have drifted.
  ok('below the cheat tier, buffs == f(loadout) exactly', bots5.every((b) => {
    const want = buffsFromLoadout(b.loadout);
    return Math.abs(want.cardShot - b.buffs.cardShot) < 1e-9
      && Math.abs(want.speedBuff - b.buffs.speedBuff) < 1e-9
      && Math.abs(want.cardUtil - b.buffs.cardUtil) < 1e-9;
  }), JSON.stringify(bots5.map((b) => b.buffs)));

  // A bot on the human's team plays at the PARTNER scalar, the far side at the ENEMY scalar.
  const L5 = levelAt(5);
  ok('partner/enemy scalars are assigned by side', bots5.every((b) => b.skill === botSideScalar(L5, !!b.partnerSide)),
    `partner ${L5.partner} / enemy ${L5.enemy} vs ${JSON.stringify(bots5.map((b) => [b.partnerSide, b.skill]))}`);

  console.log('\n--- the cheat tier (level 11) ---');
  const m11 = await playAt(11);
  const bots11 = (m11.players || []).filter((p) => p.isBot);
  const cheaters = bots11.filter((b) => b.skill >= EXTREME_SKILL);
  ok('level 11 produces at least one cheat-tier bot', cheaters.length > 0,
    JSON.stringify(bots11.map((b) => b.skill)));
  ok('a cheat-tier bot shows 3 legendaries', cheaters.every((b) => b.loadout.every((s) => s && s.r === 'legendary')));
  ok('...and its real buffs EXCEED those cards — the panel would lie if it re-derived them',
    cheaters.every((b) => totalBoostPct(b.buffs) > loadoutTotalPct(b.loadout) + 1e-6),
    cheaters.map((b) => `${(totalBoostPct(b.buffs) * 100).toFixed(1)}% vs ${(loadoutTotalPct(b.loadout) * 100).toFixed(1)}%`).join(' · '));

  console.log('\n--- an easy match still reports honestly (level 0) ---');
  const m0 = await playAt(0);
  const bots0 = (m0.players || []).filter((p) => p.isBot);
  ok('level 0 bots report level 0', bots0.every((b) => b.botLevel === 0));
  ok('level 0 bots are weak, not cheating', bots0.every((b) => b.skill < EXTREME_SKILL));
  ok('a weak bot may legitimately have empty slots', bots0.every((b) => b.loadout.length === 3));
} catch (e) {
  failed++;
  console.log(`  ❌ threw — ${e.message}`);
} finally {
  kill();
}

console.log(failed ? `\n${failed} FAILED` : '\nall bot-dossier checks passed');
process.exit(failed ? 1 : 0);
