// The settings panel's bot + connection readout, rendered against the REAL index.html under jsdom.
// The panel used to hold audio sliders only in a live match, so this is the first thing a player
// sees about their opponents and their connection — it has to be right without a device to check on.
//
// Loads the real markup (like test-modes-table.mjs) so a change to the settings card that removes
// the mount point fails HERE rather than silently showing nothing on the phone.
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buffsFromLoadout, EXTREME_BOT_BUFFS } from './shared/bot-buffs.js';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, 'public/index.html'), 'utf8');

let failed = 0;
const ok = (label, cond, extra = '') => { if (!cond) failed++; console.log(`  ${cond ? '✅' : '❌'} ${label}${extra ? ` — ${extra}` : ''}`); };

// jsdom globals must exist BEFORE net-hud.js is imported (it reads location.search at module
// scope), and match-info.js imports net-hud, so the order here matters.
const dom = new JSDOM(html, { url: 'http://localhost:3012/' });
global.window = dom.window;
global.document = dom.window.document;
global.location = dom.window.location;
global.performance = dom.window.performance;

const hud = await import('./public/net-hud.js');
const mi = await import('./public/match-info.js');

const LEG = { r: 'legendary', n: 1 }, EPI = { r: 'epic', n: 7 }, COM = { r: 'common', n: 3 };
const txt = (sel) => { const e = document.querySelector(sel); return e ? e.textContent : null; };
const all = (sel) => [...document.querySelectorAll(sel)];

console.log('--- mount point exists in the real markup ---');
ok('nothing injected before the first render', document.querySelector('.mi-block') === null);
mi.renderMatchInfo({ bots: [], diffLevel: null, myTeam: null, inMatch: false });
ok('mounts two blocks into the settings card', all('.mi-block').length === 2);
ok('injected its own <style> (no style.css edit needed)',
  [...document.querySelectorAll('style')].some((s) => s.textContent.includes('.mi-block')));
ok('landed inside the settings GRID so it lines up with the sliders',
  !!document.querySelector('#settings .settings-card .settings-grid .mi-block'));
ok('both blocks span the full grid width',
  [...document.querySelectorAll('style')].some((s) => s.textContent.includes('.mi-block { grid-column: 1 / -1')));

console.log('\n--- connection: no data outside a match ---');
ok('says it is match-only rather than showing a fake 0ms', (txt('.mi-net-body') || '').includes('נמדד רק בזמן משחק'));

console.log('\n--- connection: a healthy match ---');
{
  let t = 0;
  hud.onPong(38); hud.onPong(42); hud.onPong(40);
  hud.onSnapshot(t);
  hud.renderNetHud({ snapRate: 60, unacked: 1, wsOpen: true, now: t });
  mi.renderMatchInfo({ bots: [], diffLevel: 5, myTeam: 'A', inMatch: true });
  const body = txt('.mi-net-body') || '';
  ok('shows the ping in ms', /40\s*ms/.test(body.replace(/\s+/g, ' ')), body.trim().slice(0, 80));
  ok('labels it יציב', body.includes('יציב'));
  ok('three bars lit while healthy', !!document.querySelector('.mi-bars.b3'));
  ok('carries the good colour class', !!document.querySelector('.mi-net.good'));
  ok('reports jitter', body.includes('ריצוד'));
  ok('reports the snapshot rate', body.includes('60/s'));
  ok('reports the input queue', body.includes('תור שליחה'));
}

console.log('\n--- connection: a bad match ---');
{
  // 300ms RTT is past the poor threshold; escalation needs escalateMs of dwell.
  let t = 10000;
  for (let i = 0; i < 8; i++) hud.onPong(300);
  for (let k = 0; k < 4; k++) { t += 250; hud.onSnapshot(t); hud.renderNetHud({ snapRate: 60, unacked: 2, wsOpen: true, now: t }); }
  mi.renderMatchInfo({ bots: [], diffLevel: 5, myTeam: 'A', inMatch: true });
  const body = txt('.mi-net-body') || '';
  ok('drops to חלש on a sustained 300ms RTT', body.includes('חלש'), body.trim().slice(0, 60));
  ok('only one bar lit', !!document.querySelector('.mi-bars.b1'));
  ok('carries the poor colour class', !!document.querySelector('.mi-net.poor'));
  ok('explains WHY, not just that it is bad', (txt('.mi-net-reason') || '').length > 0, txt('.mi-net-reason'));
}

console.log('\n--- connection: socket down ---');
{
  let t = 30000;
  hud.renderNetHud({ snapRate: 0, unacked: 0, wsOpen: false, now: t });
  mi.renderMatchInfo({ bots: [], diffLevel: 5, myTeam: 'A', inMatch: true });
  ok('reads מנותק with zero bars', (txt('.mi-net-body') || '').includes('מנותק') && !!document.querySelector('.mi-bars.b0'));
}

console.log('\n--- bots: empty states are distinguishable ---');
mi.renderMatchInfo({ bots: [], diffLevel: 5, myTeam: 'A', inMatch: true });
ok('in a match with no bots says all players are human', (txt('.mi-bots-body') || '').includes('כל השחקנים אנושיים'));
mi.renderMatchInfo({ bots: [], diffLevel: null, myTeam: null, inMatch: false });
ok('outside a match says there is no data', (txt('.mi-bots-body') || '').includes('נמדד רק בזמן משחק'));

console.log('\n--- bots: a normal opponent ---');
{
  const loadout = [EPI, COM, null];
  mi.renderMatchInfo({
    bots: [{ id: 'b1', name: 'Bot', team: 'B', isBot: true, loadout, buffs: buffsFromLoadout(loadout), skill: 0.5, botLevel: 5 }],
    diffLevel: 5, myTeam: 'A', inMatch: true,
  });
  const row = document.querySelector('.mi-bot');
  ok('renders one bot row', all('.mi-bot').length === 1);
  ok('an opposing bot is marked יריב', (row.textContent || '').includes('יריב') && row.classList.contains('mi-foe'));
  ok('shows its difficulty as a player-equivalent level', (row.textContent || '').includes('רמה 6'), row.textContent.replace(/\s+/g, ' ').trim());
  ok('shows the skill word + percentage', /רגיל\s*50%/.test(row.textContent.replace(/\s+/g, ' ')));
  ok('renders exactly three slots', all('.mi-bot .mi-slot').length === 3);
  const slots = all('.mi-bot .mi-slot').map((s) => s.textContent.replace(/\s+/g, ' ').trim());
  ok('slot 1 = the shot card, at its real boost', slots[0].includes('אדיר') && slots[0].includes('+12%'), slots[0]);
  ok('slot 2 = the speed card, at its real boost', slots[1].includes('נפוץ') && slots[1].includes('+3%'), slots[1]);
  ok('slot 3 is shown as empty, not as a 0% card', slots[2].includes('ריק') && all('.mi-bot .mi-slot.mi-off').length === 1, slots[2]);
  ok('totals the card power', (txt('.mi-total') || '').includes('+15%'), txt('.mi-total'));
  ok('a normal bot is NOT flagged as cheating', document.querySelector('.mi-cheat') === null);
  ok('the room difficulty is named in the header', (txt('.mi-diff') || '').includes('שלב 5'), txt('.mi-diff'));
}

console.log('\n--- bots: the cheat tier is called out ---');
{
  // The reason the roster carries `buffs`: this bot's boosts EXCEED its three legendaries. If the
  // panel re-derived them from the cards it would report 60% instead of ~94%.
  mi.renderMatchInfo({
    bots: [{ id: 'b1', name: 'Bot', team: 'B', isBot: true, loadout: [LEG, LEG, LEG], buffs: EXTREME_BOT_BUFFS, skill: 1, botLevel: 11 }],
    diffLevel: 11, myTeam: 'A', inMatch: true,
  });
  const row = document.querySelector('.mi-bot');
  ok('flags the flat cheat buffs', !!document.querySelector('.mi-cheat'));
  ok('reports the REAL boost, above what 3 legendaries give', (txt('.mi-total') || '').includes('+94%'), txt('.mi-total'));
  ok('reads קטלני', row.textContent.includes('קטלני'));
}

console.log('\n--- bots: team-mates are listed before opponents ---');
{
  mi.renderMatchInfo({
    bots: [
      { id: 'foe', name: 'Bot', team: 'B', isBot: true, loadout: [LEG, null, null], buffs: buffsFromLoadout([LEG, null, null]), skill: 0.82, botLevel: 8 },
      { id: 'ally', name: 'Bot', team: 'A', isBot: true, loadout: [COM, null, null], buffs: buffsFromLoadout([COM, null, null]), skill: 0.25, botLevel: 8 },
    ],
    diffLevel: 8, myTeam: 'A', inMatch: true,
  });
  const rows = all('.mi-bot');
  ok('both bots rendered', rows.length === 2);
  ok('my own team-mate comes first', rows[0].classList.contains('mi-ally') && rows[0].textContent.includes('שותף'));
  ok('the opponent is second and marked יריב', rows[1].classList.contains('mi-foe') && rows[1].textContent.includes('יריב'));
  ok('ally and foe are visually distinct', rows[0].className !== rows[1].className);
}

console.log('\n--- robustness: partial / hostile data must not throw ---');
{
  const bad = [
    { id: 'x', isBot: true },                                        // no team, loadout or buffs
    { id: 'y', isBot: true, team: 'B', loadout: null, buffs: null },
    { id: 'z', isBot: true, team: 'B', loadout: [{ r: 'mythic', n: 1 }], buffs: { cardShot: 0 } },
    null,
    { id: 'human', isBot: false, team: 'B' },                        // must be filtered out
  ];
  let threw = null;
  try { mi.renderMatchInfo({ bots: bad, diffLevel: undefined, myTeam: null, inMatch: true }); } catch (e) { threw = e; }
  ok('renders junk without throwing', threw === null, threw && threw.message);
  ok('drops the non-bot entry', all('.mi-bot').length === 3, `${all('.mi-bot').length} rows`);
  ok('no NaN reaches the screen', !(txt('.mi-bots-body') || '').includes('NaN'), txt('.mi-bots-body'));
  ok('a bot with no level still renders a row', all('.mi-bot').length === 3);
}

console.log('\n--- the repaint loop starts and stops ---');
{
  let calls = 0;
  mi.openMatchInfo(() => { calls++; return { bots: [], diffLevel: 5, myTeam: 'A', inMatch: true }; });
  ok('paints immediately on open', calls === 1);
  mi.closeMatchInfo();
  const at = calls;
  await new Promise((r) => setTimeout(r, 700));   // longer than the 500ms refresh
  ok('stops repainting once closed', calls === at, `${calls} vs ${at}`);
  mi.openMatchInfo(null);
  ok('a missing data callback is a no-op, not a crash', true);
}

console.log(failed ? `\n${failed} FAILED` : '\nall match-info checks passed');
process.exit(failed ? 1 : 0);
