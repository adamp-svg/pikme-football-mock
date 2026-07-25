// The in-game settings panel's two INFO sections: who the bots are, and how the connection is doing.
//
// Until now the in-match settings panel only had the two audio sliders (everything else is gated to
// the training ground), so a player in a real match had no way to see what they were up against or
// why the game felt laggy.
//
// SELF-CONTAINED, same reasoning as net-hud.js: this file injects its own <style> and its own DOM
// into the settings card, so wiring it up costs public/client.js three one-line hooks and costs
// index.html / style.css nothing. Several agents edit those two files concurrently (see CLAUDE.md).
//
// Genre reference (the user's standing rule — check the big games before inventing):
//  - Connection: Fortnite's "Net Debug Stats" and Roblox's settings readout both show a NUMBER
//    (ms) rather than only bars, and Brawl Stars pairs bars with the ms figure. So: bars + ms +
//    the two signals that actually explain a bad match here (jitter and snapshot rate).
//  - Bots: Brawl Stars' pre-battle screen lists each player's power level and their equipped
//    gadget/star-power. Same shape here — difficulty level per bot, then its three card slots with
//    the boost each one is really giving.

// RELATIVE imports so this file resolves in BOTH the browser (served at /match-info.js, so
// ../shared/ = /shared/) and under node, which is what lets test-match-info.mjs drive it through
// jsdom. Same convention as hub-rank.js and net-hud.js.
import { buffPercents, totalBoostPct, loadoutTotalPct, RARITY_LABEL_HE } from '../shared/bot-buffs.js';
import { levelAt, displayLevelForBot, skillWord } from '../shared/difficulty.js';
import { netStats } from './net-hud.js';
import { NET_T } from './net-quality.js';

const REFRESH_MS = 500;   // the panel is paused-ish UI; 2Hz is plenty and costs nothing

// Hebrew label + bar count per connection level. Bar count doubles as the colour class.
const NET_LABEL = {
  good:    { he: 'יציב',      bars: 3 },
  fair:    { he: 'בינוני',    bars: 2 },
  poor:    { he: 'חלש',       bars: 1 },
  stalled: { he: 'קופא',      bars: 1 },
  offline: { he: 'מנותק',     bars: 0 },
};

const CSS = `
.mi-block { grid-column: 1 / -1; margin: 10px 0 2px; }
.mi-h { display: flex; align-items: center; justify-content: space-between; gap: 8px;
  font-size: 12px; font-weight: 800; color: #f0e4b9; letter-spacing: .2px;
  border-bottom: 1px solid rgba(240,228,185,.18); padding-bottom: 4px; margin-bottom: 6px; }
.mi-h em { font-style: normal; font-weight: 700; color: #8fa2c4; font-size: 11px; }

/* --- connection --- */
.mi-net { display: flex; align-items: center; gap: 10px; }
.mi-bars { display: flex; align-items: flex-end; gap: 3px; height: 16px; flex: none; }
.mi-bars i { width: 5px; background: rgba(240,228,185,.18); border-radius: 1px; }
.mi-bars i:nth-child(1) { height: 6px; }
.mi-bars i:nth-child(2) { height: 11px; }
.mi-bars i:nth-child(3) { height: 16px; }
.mi-bars.b1 i:nth-child(1), .mi-bars.b2 i:nth-child(1), .mi-bars.b3 i:nth-child(1),
.mi-bars.b2 i:nth-child(2), .mi-bars.b3 i:nth-child(2),
.mi-bars.b3 i:nth-child(3) { background: currentColor; }
.mi-net.good { color: #7CF0A9; } .mi-net.fair { color: #e8b23a; }
.mi-net.poor, .mi-net.stalled, .mi-net.offline { color: #e5484d; }
.mi-ping { font-size: 20px; font-weight: 800; font-variant-numeric: tabular-nums; line-height: 1; }
.mi-ping small { font-size: 11px; font-weight: 700; opacity: .75; margin-inline-start: 2px; }
.mi-word { font-size: 13px; font-weight: 800; }
.mi-sub { font-size: 11px; color: #8fa2c4; margin-top: 5px; line-height: 1.5;
  font-variant-numeric: tabular-nums; }
.mi-sub b { color: #cdd8ef; font-weight: 700; }
.mi-empty { font-size: 12px; color: #8fa2c4; opacity: .8; padding: 2px 0; }

/* --- bots --- */
.mi-bot { border: 1px solid rgba(240,228,185,.12); border-radius: 4px;
  padding: 6px 8px; margin-bottom: 6px; background: rgba(240,228,185,.04); }
.mi-bot.mi-foe { border-color: rgba(229,72,77,.3); }
.mi-bot.mi-ally { border-color: rgba(124,240,169,.28); }
.mi-brow { display: flex; align-items: center; justify-content: space-between; gap: 6px;
  font-size: 12px; font-weight: 700; color: #cdd8ef; }
.mi-side { font-size: 10px; font-weight: 800; padding: 1px 5px; border-radius: 2px; }
.mi-foe .mi-side { background: rgba(229,72,77,.22); color: #ffb3b5; }
.mi-ally .mi-side { background: rgba(124,240,169,.18); color: #9df3c1; }
.mi-lvl { font-variant-numeric: tabular-nums; color: #f0e4b9; }
.mi-slots { display: flex; gap: 4px; margin-top: 5px; }
.mi-slot { flex: 1; text-align: center; border-radius: 3px; padding: 3px 1px;
  background: rgba(0,0,0,.28); font-size: 10px; line-height: 1.35; }
.mi-slot .mi-ic { font-size: 13px; display: block; }
.mi-slot .mi-rar { display: block; color: #cdd8ef; font-weight: 700; }
.mi-slot .mi-pct { display: block; color: #7CF0A9; font-weight: 800;
  font-variant-numeric: tabular-nums; }
.mi-slot.mi-off { opacity: .45; }
.mi-slot.mi-off .mi-pct { color: #8fa2c4; }
.mi-total { font-size: 11px; color: #8fa2c4; margin-top: 4px; }
.mi-total b { color: #7CF0A9; font-variant-numeric: tabular-nums; }
.mi-cheat { font-size: 10px; font-weight: 800; color: #ffb3b5; margin-top: 3px; }
`;

// Slot icons/labels mirror SLOT_META in client.js (shot / speed / utility, in that order).
const SLOTS = [
  { icon: '⚡', label: 'בעיטה' },
  { icon: '🏃', label: 'מהירות' },
  { icon: '🛡️', label: 'הגנה' },
];

let els = null;
let timer = null;
let getData = null;

// Inject into the settings GRID (so `.setting-wide`-style full-width rows line up with the
// sliders) if it exists, else fall back to the card. Returns null when the panel isn't in the DOM
// at all, which is what lets client.js call the hooks unconditionally.
function mount() {
  if (els) return els;
  const card = document.querySelector('#settings .settings-card');
  if (!card) return null;
  const host = card.querySelector('.settings-grid') || card;

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const net = document.createElement('div');
  net.className = 'mi-block';
  net.innerHTML =
    '<div class="mi-h"><span>📶 חיבור</span><em class="mi-net-reason"></em></div>'
    + '<div class="mi-net-body"></div>';

  const bots = document.createElement('div');
  bots.className = 'mi-block';
  bots.innerHTML =
    '<div class="mi-h"><span>🤖 בוטים במשחק</span><em class="mi-diff"></em></div>'
    + '<div class="mi-bots-body"></div>';

  host.appendChild(net);
  host.appendChild(bots);

  els = {
    net, bots,
    netBody: net.querySelector('.mi-net-body'),
    netReason: net.querySelector('.mi-net-reason'),
    botsBody: bots.querySelector('.mi-bots-body'),
    diff: bots.querySelector('.mi-diff'),
  };
  return els;
}

const pct = (v) => (v > 0 ? '+' : '') + Math.round(v * 100) + '%';

// ---- connection -----------------------------------------------------------------------------
function renderNet(e) {
  const s = netStats();
  if (!s) {
    e.netBody.innerHTML = '<div class="mi-empty">אין נתונים — נמדד רק בזמן משחק</div>';
    e.netReason.textContent = '';
    return;
  }
  const meta = NET_LABEL[s.level] || NET_LABEL.good;
  // rtt is meaningless before the first ping round-trip lands; show the level, not a fake 0ms.
  const havePing = s.samples > 0;
  const ping = havePing ? Math.round(s.rtt) : null;

  e.netBody.className = 'mi-net-body';
  e.netBody.innerHTML =
    `<div class="mi-net ${s.level}">`
    + `<span class="mi-bars b${meta.bars}"><i></i><i></i><i></i></span>`
    + `<span class="mi-ping">${havePing ? ping : '—'}<small>ms</small></span>`
    + `<span class="mi-word">${meta.he}</span>`
    + '</div>'
    + '<div class="mi-sub">'
    + `ריצוד <b>±${Math.round(s.jitter)}ms</b> · עדכונים <b>${s.snapRate == null ? '—' : s.snapRate}/s</b>`
    + ` · תור שליחה <b>${s.unacked}</b></div>`;

  // The threshold the player is closest to failing — turns "חלש" into something actionable.
  const why = { rtt: 'השהיה גבוהה', jitter: 'חיבור לא יציב', rate: 'עדכונים חסרים',
    unacked: 'הפקודות לא מגיעות', gap: 'התמונה קפואה', socket: 'החיבור נפל', ok: '' }[s.reason] || '';
  e.netReason.textContent = s.level === 'good' && s.rawLevel === 'good' ? `עד ${NET_T.fair.rtt}ms תקין` : why;
}

// ---- bots -----------------------------------------------------------------------------------
function botRowEl(bot, myTeam) {
  const ally = myTeam && bot.team === myTeam;
  const row = document.createElement('div');
  row.className = 'mi-bot ' + (ally ? 'mi-ally' : 'mi-foe');

  // A bot's level: prefer the one the server stamped on it; fall back to the room level.
  const lvl = Number.isFinite(bot.botLevel) ? bot.botLevel : null;
  const skill = Number.isFinite(bot.skill) ? bot.skill : null;
  const shown = lvl == null ? '?' : displayLevelForBot(lvl);

  const head = document.createElement('div');
  head.className = 'mi-brow';
  head.innerHTML =
    `<span>🤖 ${bot.name || 'בוט'} <span class="mi-side">${ally ? 'שותף' : 'יריב'}</span></span>`
    + `<span class="mi-lvl">רמה ${shown}${skill == null ? '' : ` · ${skillWord(skill)} ${Math.round(skill * 100)}%`}</span>`;
  row.appendChild(head);

  // Per-slot: the CARD sits in the loadout, the BOOST comes from the buffs the sim is really
  // running. They match for a normal bot and deliberately diverge for a cheat-tier one.
  const p = buffPercents(bot.buffs);
  const perSlot = [p.shot, p.speed, p.util];
  const loadout = Array.isArray(bot.loadout) ? bot.loadout : [];
  const slots = document.createElement('div');
  slots.className = 'mi-slots';
  SLOTS.forEach((meta, i) => {
    const card = loadout[i];
    const boost = perSlot[i] || 0;
    const d = document.createElement('div');
    d.className = 'mi-slot' + (card || boost > 0 ? '' : ' mi-off');
    d.innerHTML = `<span class="mi-ic">${meta.icon}</span>`
      // Unknown rarity falls back to '?', not the raw key — a stray English word in an RTL
      // Hebrew panel reads as a bug. (The server validates rarities, so this is belt-and-braces.)
      + `<span class="mi-rar">${card ? (RARITY_LABEL_HE[card.r] || '?') : 'ריק'}</span>`
      + `<span class="mi-pct">${boost > 0 ? pct(boost) : '—'}</span>`;
    d.title = meta.label;
    slots.appendChild(d);
  });
  row.appendChild(slots);

  const total = document.createElement('div');
  total.className = 'mi-total';
  total.innerHTML = `סה״כ חוזק קלפים <b>${pct(totalBoostPct(bot.buffs))}</b>`;
  row.appendChild(total);

  // Flag the cheat tier explicitly: at the top of the ladder a bot's boosts are a FLAT set, not
  // what its cards would give — so say so instead of letting the numbers look like a card bug.
  if (totalBoostPct(bot.buffs) > loadoutTotalPct(loadout) + 1e-6) {
    const c = document.createElement('div');
    c.className = 'mi-cheat';
    c.textContent = '⚠ בוט קטלני — חיזוקים קבועים מעל הקלפים שלו';
    row.appendChild(c);
  }
  return row;
}

function renderBots(e, data) {
  const bots = Array.isArray(data.bots) ? data.bots.filter((b) => b && b.isBot) : [];
  const lvl = Number.isFinite(data.diffLevel) ? data.diffLevel : null;
  const L = lvl == null ? null : levelAt(lvl);
  e.diff.textContent = L ? `קושי ${lvl} · ${L.name} · ${L.hint}` : '';

  e.botsBody.innerHTML = '';
  if (!bots.length) {
    e.botsBody.innerHTML = data.inMatch
      ? '<div class="mi-empty">אין בוטים במשחק — כל השחקנים אנושיים</div>'
      : '<div class="mi-empty">אין נתונים — נמדד רק בזמן משחק</div>';
    return;
  }
  // Team-mates first, then opponents — you scan your own side before theirs.
  const myTeam = data.myTeam || null;
  const sorted = bots.slice().sort((a, b) => {
    const aa = myTeam && a.team === myTeam ? 0 : 1, bb = myTeam && b.team === myTeam ? 0 : 1;
    return aa - bb;
  });
  for (const b of sorted) e.botsBody.appendChild(botRowEl(b, myTeam));
}

// ---- hooks called from client.js -------------------------------------------------------------
export function renderMatchInfo(data) {
  const e = mount();
  if (!e) return;
  const d = data || {};
  renderNet(e);
  renderBots(e, d);
}

// Repaint while the settings panel is open. `fn` returns fresh data each tick, so client.js state
// (roster, my team, room difficulty) is read at paint time rather than captured once.
export function openMatchInfo(fn) {
  getData = typeof fn === 'function' ? fn : null;
  if (!getData) return;
  renderMatchInfo(getData());
  if (timer) clearInterval(timer);
  timer = setInterval(() => { if (getData) renderMatchInfo(getData()); }, REFRESH_MS);
}

export function closeMatchInfo() {
  if (timer) { clearInterval(timer); timer = null; }
  getData = null;
}
