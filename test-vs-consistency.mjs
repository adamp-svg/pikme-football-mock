// Every public matchmade mode must show the SAME pre-match screen: the VS/teams page with both
// squads, the bots that will fill the empty slots, and everyone's power cards.
//
// The bug this pins down: the client gated that page on `roomJoined.mode === 'quick'`, so
// קרב על השער (goal-brawl) — matchmade identically on the server — fell through to the bare
// #lobby member list. Two live modes, two different pre-match experiences, for no reason but a
// string compare. Now gated on the server's `matchmade` flag, so a NEW format (3v3/5v5) cannot be
// born on the wrong screen.
//
// Also pins the 3v3/5v5 seams that already exist: the format table drives the win rule, and the
// VS column renders N rows per side instead of a hardcoded 2.
//
// BOOTS ITS OWN SERVER (boot-test-server.mjs). It used to connect to whatever was on :3014, and that is
// how this test produced the worst outcome available: a FALSE GREEN. It was cited as covering a change
// to the bot loadout generator while passing against a :3014 process started hours before that generator
// existed — Node had cached the old module, so the assertion "the lobby previews the bots WITH cards"
// exercised code nobody had edited. Set PORT= to aim at a specific running server on purpose.
import { WebSocket } from 'ws';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { GOALS_TO_WIN } from './shared/constants.js';
import { bootServer } from './boot-test-server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const { url: URL } = await bootServer();
let failed = 0;
const ok = (label, cond, extra = '') => { if (!cond) failed++; console.log(`  ${cond ? '✅' : '❌'} ${label}${extra ? ` — ${extra}` : ''}`); };

function client(name) {
  const ws = new WebSocket(URL);
  const seen = [], waiters = [];
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
    open: () => new Promise((res) => ws.once('open', res)),
    send: (o) => ws.send(JSON.stringify(o)),
    wait: (type, ms = 12000) => {
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

// Join a public queue and report what the pre-match wire looks like.
async function joinPublic(msg, label) {
  const c = client(label);
  await c.open();
  c.send({ type: 'join', name: label });
  await c.wait('welcome');
  c.send(msg);
  const joined = await c.wait('roomJoined');
  const lobby = await c.wait('lobby');
  const start = await c.wait('matchStart');
  c.close();
  return { joined, lobby, start };
}

console.log('1) both live modes are flagged matchmade → same VS/teams page');
const quick = await joinPublic({ type: 'quickMatch', diffLevel: 3 }, 'quick');
const brawl = await joinPublic({ type: 'goalBrawl', diffLevel: 3 }, 'brawl');
for (const [label, r] of [['quick', quick], ['brawl', brawl]]) {
  ok(`[${label}] roomJoined.matchmade === true`, r.joined.matchmade === true, `got ${r.joined.matchmade}`);
  ok(`[${label}] roomJoined.mode names the format`, r.joined.mode === label, `got ${r.joined.mode}`);
}

console.log('2) the lobby payload carries what the VS page prints');
for (const [label, r] of [['quick', quick], ['brawl', brawl]]) {
  ok(`[${label}] lobby.format`, r.lobby.format === label, `got ${r.lobby.format}`);
  ok(`[${label}] lobby.rule is non-empty text`, typeof r.lobby.rule === 'string' && r.lobby.rule.length > 3, r.lobby.rule);
  ok(`[${label}] lobby.teamSize`, r.lobby.teamSize === 2, `got ${r.lobby.teamSize}`);
  ok(`[${label}] lobby previews the bots WITH cards`,
    Array.isArray(r.lobby.bots) && r.lobby.bots.length > 0 && r.lobby.bots.every((b) => Array.isArray(b.loadout)),
    `${r.lobby.bots?.length} bots`);
}
ok('the two formats still differ ONLY in the win rule',
  quick.lobby.goalsToWin === GOALS_TO_WIN && brawl.lobby.goalsToWin === 0,
  `quick=${quick.lobby.goalsToWin} brawl=${brawl.lobby.goalsToWin}`);
ok('...and the rule text differs too', quick.lobby.rule !== brawl.lobby.rule);

console.log('3) the client gate is the flag, not a mode name');
const src = readFileSync(join(here, 'public/client.js'), 'utf8');
const gate = src.slice(src.indexOf("} else if (msg.type === 'roomJoined') {"));
const gateLine = gate.slice(0, gate.indexOf('else if (partyFlow)'));
ok('VS page is gated on msg.matchmade', gateLine.includes('msg.matchmade'));
ok('quickVs is set from that gate', gateLine.includes('quickVs = true'));

console.log('4) every live matchmade mode maps to a server format');
const serverSrc = readFileSync(join(here, 'server.js'), 'utf8');
const fmtBlock = serverSrc.slice(serverSrc.indexOf('const FORMATS = {'), serverSrc.indexOf('const publicRooms'));
const modesSrc = src.slice(src.indexOf('const MODES = ['), src.indexOf('function renderAllModeLists'));
const dom = new JSDOM(readFileSync(join(here, 'public/index.html'), 'utf8'));
global.document = dom.window.document;
const { drawModeArt } = await import('./public/mode-art.js');
const { MODES } = new Function('document', 'drawModeArt', `${modesSrc}; return { MODES };`)(dom.window.document, drawModeArt);
const live = MODES.filter((m) => m.state === 'live');
ok('every live mode declares a format', live.every((m) => !!m.format), live.map((m) => `${m.id}:${m.format}`).join(', '));
// FORMATS keys may be quoted ('3v3' is not a bare identifier), so match either form.
const hasFormatKey = (k) => new RegExp(`(^|[{\\s])['"]?${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]?\\s*:`, 'm').test(fmtBlock);
ok('every declared format exists in the server FORMATS table',
  live.every((m) => hasFormatKey(m.format)),
  live.map((m) => `${m.format}${hasFormatKey(m.format) ? '✓' : '✗'}`).join(' '));

console.log('5) the duplicated matchmaker is gone (that is how the drift happened)');
ok('no quickMatch()/goalBrawl() function definitions left',
  !/function quickMatch\(/.test(serverSrc) && !/function goalBrawl\(/.test(serverSrc));
ok('single joinMatchmade entry point', (serverSrc.match(/function joinMatchmade\(/g) || []).length === 1);
ok('no hand-rolled publicRoom / publicRoomBrawl globals',
  !/let publicRoom\b/.test(serverSrc) && !/let publicRoomBrawl\b/.test(serverSrc));
ok('legacy quickMatch/goalBrawl wire messages still route',
  serverSrc.includes("joinMatchmade(member, 'quick'") && serverSrc.includes("joinMatchmade(member, 'brawl'"));

console.log('6) the VS column is N-per-team ready (3v3 / 5v5)');
{
  const introSrc = src.slice(src.indexOf('function fillIntroCol('), src.indexOf('function fillIntroCol(') + 2600);
  ok('fillIntroCol takes a perTeam count', /function fillIntroCol\(colEl, players, team, perTeam/.test(introSrc));
  ok('...and loops to it, not to a hardcoded 2', introSrc.includes('i < perTeam'));
  ok('updateVsCountdown reads teamSize off the lobby payload', src.includes('+msg.teamSize'));
  // Render the real column markup at 2/3/5 and count the rows.
  const colHtml = '<div class="ti-col"><div class="ti-team-title">t</div><div class="ti-rows"></div></div>';
  for (const n of [2, 3, 5]) {
    const d = new JSDOM(`<body>${colHtml}</body>`);
    const col = d.window.document.querySelector('.ti-col');
    // Minimal stand-ins for the module-scope helpers fillIntroCol reaches for.
    const run = new Function('colEl', 'players', 'team', 'perTeam', 'document', 'deps', `
      const { memberInitials, introCardsFor, introCardEl, fmtCompact } = deps;
      ${introSrc.slice(0, introSrc.indexOf('\n}\n') + 3)}
      return fillIntroCol(colEl, players, team, perTeam);`);
    run(col, [], 'A', n, d.window.document, {
      memberInitials: () => 'X', introCardsFor: () => [], fmtCompact: (v) => String(v),
      introCardEl: () => d.window.document.createElement('div'),
    });
    const rows = col.querySelectorAll('.ti-row').length;
    ok(`  ${n} per team renders ${n} rows`, rows === n, `${rows} rows, data-size=${col.dataset.size}`);
  }
}

console.log(failed ? `\n❌ ${failed} FAILED` : '\n✅ ALL PASS');
process.exit(failed ? 1 : 0);
