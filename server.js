// Authoritative game server + tiny static file server.
// - Serves the web game from /public and /shared
// - Room manager: a public QUICK-MATCH room + private code rooms (play with friends)
// - Each room runs its own LOBBY -> COUNTDOWN -> MATCH state machine
// - Fills empty match slots with bots; idle players convert to bots (reclaimable)

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { randomBytes } from 'crypto';

import {
  createState, addPlayer, removePlayer, step, attachBall, setField,
} from './shared/sim.js';
import {
  TICK_RATE, DT, SNAPSHOT_RATE, MAX_PLAYERS, FIELD, GOAL, CHARACTERS, DEFAULT_CHAR, ENDED_HOLD, INTRO_PROMO,
  MAG_SIZE, AMMO_REGEN, EMPTY_RELOAD, BUILD_MAG, BUILD_RELOAD, GOALS_TO_WIN,
  MM_BUDGET_QUICK_MS, MM_BUDGET_MODE_MS, MM_REVEAL_MS,
} from './shared/constants.js';
import { ARENA } from './shared/arena.js';
import { coalesceInput, consumeEdges } from './shared/input-merge.js';
import { MAIN_FIELD } from './shared/main-field.js';
import { FIELD_3V3 } from './shared/field-3v3.js';
import { sanitizeFreeText, FREE_TEXT_ROOMS } from './shared/quick-messages.js';
import { sizeOfField, canHost, sizeOf } from './shared/field-sizes.js';
import { normSpawns, normBall } from './shared/field-spawns.js';
import { encodeKeyframe } from './shared/wire.js';
import { normalizeCosmetic, randomBotCosmetic, DEFAULT_COSMETIC, HERO_KEYS, SKIN_KEYS } from './shared/cosmetics.js';
import { verifyFootballToken } from './shared/football-auth.js';
import { opponentKeyFor } from './shared/opponent-key.js';
import { buffsFromLoadout, loadoutTotalPct, EXTREME_SKILL, EXTREME_BOT_BUFFS, botSideScalar, botLoadoutForLevel } from './shared/bot-buffs.js';
const BACKPRESSURE_LIMIT = 8 * 1024; // drop a snapshot to a backed-up client. Small on purpose: every frame is a full ~150B keyframe, so a stalled mobile client should SKIP to fresh state, not replay ~10s of stale frames (was 64KB ≈ 400+ frames).
import { computeBotInputs, createBotMemory } from './shared/bot-ai.js';
import { DIFFICULTY_LEVELS, DEFAULT_LEVEL, clampLevel, levelAt, levelFromLegacy, xpForBotLevel, displayLevelForBot, botLevelFromXp } from './shared/difficulty.js';
import { planMatches, bandOf } from './shared/matchmaker.js';
import { isChatId, chatById, CHAT_SEND_GAP_MS, CHAT_BURST_N, CHAT_BURST_MS, CHAT_COOLDOWN_MS } from './shared/quick-chat.js';
import { SALTIZ_BOT_BY_ID, botLevelOf, saltizBotLoadout } from './shared/saltiz-bots.js';
import { TRAIN_ARENA, TRAIN_ENEMIES, TRAIN_HOME_LEASH, createSentryMem, trainingSentryInput, trainingStillInput, trainingKeeperInput, leashSentry, keeperClamp } from './shared/training.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3010;

// ---------------------------------------------------------------------------
// Static file server (so the browser can import /shared/*.js ES modules)
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.mp3': 'audio/mpeg',
};

// pikme-server's CORS is an ALLOWLIST: it echoes access-control-allow-origin for
// https://pikme-football.onrender.com but sends NONE for http://localhost:* or a LAN IP. So in the
// app and on prod the client can call the API directly, while on the dev surfaces the browser
// discards every response — which is why the גביעים bar read a hardcoded 0 on 10.100.102.36 while
// the account actually held 1840 trophies.
// This is a SAME-ORIGIN read-only passthrough for exactly the progression read, so the dev surface
// behaves like the app without needing the API's allowlist widened. Server-to-server, so CORS never
// applies. Whitelisted to one upstream path, GET only, and it forwards the football token when the
// caller has one. Harmless on prod, where the direct call already works.
const PIKME_UPSTREAM = process.env.PIKME_API || 'https://server.pikme.tv';
function proxyProgress(req, res) {
  const q = new URL(req.url, 'http://x').searchParams;
  const phone = (q.get('phone') || '').replace(/[^\d+]/g, '').slice(0, 20);
  const auth = req.headers['football-auth'];
  const upstream = auth
    ? `${PIKME_UPSTREAM}/handle-friends/rank`
    : `${PIKME_UPSTREAM}/handle-user/football/stats?phone=${encodeURIComponent(phone)}`;
  if (!auth && !phone) { res.writeHead(400); return res.end('{"error":"phone or football-auth required"}'); }
  fetch(upstream, { headers: auth ? { 'football-auth': auth } : {} })
    .then(async (r) => {
      const body = await r.text();
      res.writeHead(r.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(body);
    })
    .catch(() => { res.writeHead(502); res.end('{"error":"upstream unreachable"}'); });
}

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/dev/progress') return proxyProgress(req, res);
  if (urlPath === '/') urlPath = '/public/index.html';
  if (!urlPath.startsWith('/shared/') && !urlPath.startsWith('/public/')) {
    urlPath = '/public' + urlPath;
  }
  const filePath = path.normalize(path.join(__dirname, urlPath));
  if (!filePath.startsWith(__dirname)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    // Art/audio never change per build -> let the device KEEP them (assets live on the phone).
    // Code/markup stay no-store so a new client.js/index.html always lands (no stale-code trap).
    const immutable = urlPath.startsWith('/public/assets/') || urlPath.startsWith('/public/audio/');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-store, must-revalidate',
    });
    res.end(data);
  });
});

// ---------------------------------------------------------------------------
// Room manager
// ---------------------------------------------------------------------------
const COUNTDOWN_TIME = 5;    // seconds from start to kickoff
const AFK_SECONDS = 10;      // no meaningful input for this long -> becomes a bot
const TEAM_CAP = 2;          // players per team in a 2v2 match

const members = new Map();   // ws -> member (a connected client)
const FOOTBALL_TOKEN_SECRET = process.env.FOOTBALL_TOKEN_SECRET || null;
const onlineByUser = new Map(); // userId -> member (authenticated connections only)
const challenges = new Map(); // challengeId -> { fromUserId, toUserId }
let challengeCounter = 0;
const rooms = new Map();     // roomId -> room
// FORMATS is the single source of truth for every public matchmade mode. One row per mode; the
// row is the ONLY thing that differs between them — everything downstream (lobby, 5s window,
// XP-scaled bot fill, the VS/teams page, the countdown) is shared. Adding 3v3/5v5 is a new row
// here plus the per-room teamSize work listed in summery/TEAM_FORMATS_PLAN.md — never a copy of
// joinMatchmade(). Two near-identical copies is exactly how goal-brawl drifted off the VS page.
const FORMATS = {
  quick: { prefix: 'pub',   teamSize: 2, goalsToWin: GOALS_TO_WIN, rule: 'ראשון ל-3 · עד 2 דק׳' },
  brawl: { prefix: 'brawl', teamSize: 2, goalsToWin: 0,            rule: 'הכי הרבה גולים · 2 דקות' },
  // 3v3 — 6 players. Fits the 8-slot snapshot mask as-is, so no wire change (5v5 would NOT; see
  // summery/TEAM_FORMATS_PLAN.md §2.2). Its own arena, because MAIN_FIELD's dense centre turns into
  // a scrum with six bodies.
  '3v3': { prefix: 'trio',  teamSize: 3, goalsToWin: GOALS_TO_WIN, rule: 'ראשון ל-3 · 3 נגד 3', field: FIELD_3V3 },
};
// Players per side / total cap for a room. Private + training rooms keep the MAX_PLAYERS default.
const roomTeamSize = (room) => Math.max(1, (room && room.teamSize) | 0 || MAX_PLAYERS / 2);
const roomMax = (room) => roomTeamSize(room) * 2;
// How long a chat bubble lives on the TEAM PAGE. The in-match bubble is 2.2s because you are also
// playing; in a lobby you are reading, and a 40-character line needs longer than that.
const LOBBY_BUBBLE_MS = 8000;
// The arena a room plays on: its format's field, else the shared main one.
const roomField = (room) => ((FORMATS[room && room.format] || {}).cleanField) || MAIN_FIELD_CLEAN;
// MODES card id (client-side) -> FORMATS key (server-side). The picker's '2v2' card is the 'quick'
// format; every other card id matches its format key. Unknown ids fall back to quick.
const CARD_TO_FORMAT = { '2v2': 'quick', brawl: 'brawl', '3v3': '3v3' };
const formatForCard = (cardId) => CARD_TO_FORMAT[cardId] || 'quick';
// Stamp a format onto a room. One place, so the public queue and a private room's "Play Now" can
// never disagree about what a format means.
function applyFormat(room, mode) {
  const fmt = FORMATS[mode] || FORMATS.quick;
  room.format = mode;
  room.teamSize = fmt.teamSize;
  room.goalsToWin = fmt.goalsToWin;
}
// mode -> the room currently forming for that mode. Each format matchmakes in its OWN pool so
// first-to-3 and timed players never mix. Was two hand-rolled `publicRoom*` globals.
const publicRooms = new Map();
const formingRoom = (mode) => publicRooms.get(mode) || null;
// Drop a room from its matchmaking pool (it started, or it died) so the next joiner forms a fresh one.
function clearForming(room) { for (const [mode, r] of publicRooms) if (r === room) publicRooms.delete(mode); }

// --- MATCHMAKING QUEUE -----------------------------------------------------------------------
// Waiting players hold a TICKET, not a room. The old model kept one forming room per mode and put
// whoever arrived into it, which is why trophies were never consulted: there was nowhere to consult
// them. It also made widening impossible — widening under that model means MERGING two half-full
// rooms that each hold members, a countdown and a botPlan, mid-tick.
//
// A ticket is the ONLY state a searching player has, so cancelling is a single delete.
const tickets = new Map(); // memberId -> { memberId, mode, level, trophies, queuedAt, budgetMs, graceUntil, member }

function enqueue(member, mode, budgetMs, trophies) {
  dequeue(member.id);                     // a member never holds two tickets
  leaveCurrentRoom(member);
  const t = Number.isFinite(+trophies) ? Math.max(0, +trophies) : null;
  member.trophies = t;
  tickets.set(member.id, {
    memberId: member.id, mode, budgetMs,
    trophies: t == null ? 0 : t,
    level: bandOf(t == null ? xpFallbackTrophies(member) : t),
    queuedAt: nowMs(), graceUntil: null, member,
  });
  send(member.ws, { type: 'searching', mode, phase: 'searching', bandLo: 0, bandHi: 0,
    searchingCount: 0, remainingMs: budgetMs, slots: { filled: 1, total: roomMaxForMode(mode) } });
}
function dequeue(memberId) { tickets.delete(memberId); }

// An OLDER CLIENT sends no trophies. Defaulting those to 0 would put a veteran on a stale build into
// L1 and feed them to beginners, so fall back to the diffLevel they already send (client-derived from
// the same XP), then to DEFAULT_LEVEL. Such a ticket is also never granted the grace extension.
function xpFallbackTrophies(member) {
  const lv = Number.isFinite(+member.diffLevel) ? clampLevel(+member.diffLevel) : DEFAULT_LEVEL;
  return xpForBotLevel(lv);
}
// Player level -> a representative trophy total for that level, matching the hub XP-bar curve
// (base = 50*p*(p-1), the same formula xpForBotLevel uses). Needed because a group carries a player
// LEVEL (1..12+) while botLevelFromXp wants trophies. The two ladders are off by one and clamp
// differently, so never assign across them without going through here.
const xpForPlayerLevel = (level) => 50 * Math.max(1, level | 0) * (Math.max(1, level | 0) - 1);
const roomMaxForMode = (mode) => ((FORMATS[mode] || FORMATS.quick).teamSize) * 2;

let memberCounter = 0, roomCounter = 0;
// Monotonic match counter. It is only monotonic WITHIN ONE PROCESS — the "never resets" in the old
// comment here was wrong, and it cost real matches.
//
// ⚠️ WHY BOOT_ID EXISTS (2026-07-26). matchId used to be `${room.id}-${++matchSeq}`, and BOTH parts
// restart at 1 on every process start: roomCounter and matchSeq are module-level `let`s. Render
// restarts the process on every deploy, so a day with ten deploys regenerates `bots-1-1`, `pub-1-1`,
// `trio-3-3` … over and over. pikme-server's record-match is idempotent on
// { phone, recordedMatchIds: { $ne: matchId } } — so a brand-new match arriving with an id the account
// already holds is treated as a duplicate REPLAY and SILENTLY DROPPED. No trophies, no xp, no reveal
// animation, no error anywhere. Diagnosed from a real account holding pub-1-1 … pub-8-8, bots-2-2,
// brawl-1-1, trio-3-3: every one of those is reachable again after a restart.
// A per-boot token makes the id unique across restarts while keeping it STABLE for a given match, so
// genuine replay protection (the same match reported twice) still works.
const BOOT_ID = randomBytes(3).toString('hex');
let matchSeq = 0;
// Every matchStart must use this — never build the id inline again.
const nextMatchId = (room) => `${BOOT_ID}-${room.id}-${++matchSeq}`;
let msgErrCount = 0, tickErrCount = 0, bcErrCount = 0;

const nowMs = () => Date.now();
// member = { id, ws, name, avatar, team, inMatch, afk, lastInputAt, room }

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) { try { ws.send(JSON.stringify(obj)); } catch { /* dead socket */ } }
}
function onlineCount() { return members.size; }

function makeRoom(id, isPrivate, mode = 'match') {
  return {
    id, isPrivate: !!isPrivate,
    mode,                    // 'match' | 'training' (solo practice vs a penned dummy)
    goalsToWin: GOALS_TO_WIN, // normal 2v2 = first to 3 goals (2-min cap). goal-brawl overrides to 0 (timed).
    phase: 'lobby',          // lobby | countdown | match
    countdownT: 0, endHoldT: 0, introT: 0, statsSent: false,
    state: createState(),
    inputs: new Map(),       // playerId -> input
    botMem: createBotMemory(), // persistent bot-AI memory (roles, aim, beliefs)
    diffLevel: DEFAULT_LEVEL,   // difficulty ladder index (enemy + partner skill) — see shared/difficulty.js
    botCounter: 0,
    matchCounter: 0,         // increments each match — feeds the stable per-match id
    hostId: null,            // member.id of a private room's creator/HOST — only they may accept/reject/kick
    pending: new Map(),      // memberId -> member awaiting the host's approval to join (private rooms)
    invited: new Set(),      // userIds the host invited to the party — they auto-admit (no approval step)
    lobbyBots: [],           // bots invited from the friends list — shown in the lobby, become match bots at kickoff
    members: new Set(),      // member objects
    slotIds: null, slotTeam: null, rosterVersion: 0, // binary-snapshot slot->id/team mapping
  };
}

// Private-room codes are 3-digit numeric strings "000".."999" (zero-padded), unique among ALL active
// rooms (public "pub-*" / training "train-*" ids can never collide with a 3-digit code). Returns null
// only if all 1000 codes are somehow taken.
function genCode() {
  for (let tries = 0; tries < 4000; tries++) {
    const code = String(Math.floor(Math.random() * 1000)).padStart(3, '0');
    if (!rooms.has(code)) return code;
  }
  return null;
}
// Normalize a user-typed join code to the stored 3-digit form: keep digits, pad to 3 ("7" -> "007").
// Empty -> '' (never matches). A >3-digit string is returned as-is (also won't match a real code).
function normalizeRoomCode(raw) {
  const digits = String(raw == null ? '' : raw).replace(/\D/g, '');
  if (!digits) return '';
  return digits.length <= 3 ? digits.padStart(3, '0') : digits;
}

function emptyInput() {
  return { seq: 0, moveX: 0, moveY: 0, aimX: 0, aimY: 0, hold: false, fire: false, special: false, build: false, buildHold: false, sax: 0, say: 0 };
}
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr;
}

function applySettings(room, s) {
  const c = (v, lo, hi, d) => (typeof v === 'number' && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  const cur = room.state.settings;
  room.state.settings = {
    speedMul: c(s.speedMul, 0.1, 3, cur.speedMul),
    sizeMul: c(s.sizeMul, 0.2, 3, cur.sizeMul),
    ballSizeMul: c(s.ballSizeMul, 0.2, 4, cur.ballSizeMul),
    carrySpeedMul: c(s.carrySpeedMul, 0.1, 1, cur.carrySpeedMul),
    shotPower: c(s.shotPower, 100, 3000, cur.shotPower),
    bulletSpeed: c(s.bulletSpeed, 50, 1500, cur.bulletSpeed),
    bulletKnockback: c(s.bulletKnockback, 0, 2500, cur.bulletKnockback),
    bombPower: c(s.bombPower, 0, 5000, cur.bombPower),
    bombReloadSpeed: c(s.bombReloadSpeed, 0.25, 5, cur.bombReloadSpeed ?? 1), // training reload-speed knobs
    wallReloadSpeed: c(s.wallReloadSpeed, 0.25, 5, cur.wallReloadSpeed ?? 1),
  };
}

// Emptier team among a room's members (for auto-balancing on join).
function balancedTeam(room) {
  let A = 0, B = 0;
  for (const m of room.members) (m.team === 'B' ? B++ : A++);
  for (const b of (room.lobbyBots || [])) (b.team === 'B' ? B++ : A++);
  return A <= B ? 'A' : 'B';
}
// Lowest slot index not already taken on this team. Was `used.has(0) ? 1 : 0`, which only ever
// produced 0 or 1 — at 3v3 that handed slot 1 to both of the last two bots, and they spawned inside
// each other. Falls back to the last index if somehow all are taken.
function firstFreeSlot(used, teamSize) {
  for (let i = 0; i < teamSize; i++) if (!used.has(i)) return i;
  return teamSize - 1;
}
// All slot indices for a team, in order: [0,1] at 2v2, [0,1,2] at 3v3.
const teamSlotList = (teamSize) => Array.from({ length: teamSize }, (_, i) => i);
// Keep humans + invited lobby bots within the room cap (drop excess bots when humans arrive).
function trimLobbyBots(room) {
  while (room.lobbyBots.length && room.members.size + room.lobbyBots.length > roomMax(room)) room.lobbyBots.pop();
}

// req6 — a match bot is drawn only UP TO the highest hero tier any human in the room has
// selected (HERO_KEYS = the rarity ladder striker→alien). Below the cap it's uniform; very
// rarely (1/20) one tier ABOVE the cap, clamped at alien. Skin stays random. Empty room ⇒ striker cap.
function botCosmeticForRoom(room, rand = Math.random) {
  let maxIdx = 0;
  for (const m of (room.members || [])) {
    if (m.inMatch) continue;
    const i = HERO_KEYS.indexOf(normalizeCosmetic(m.cosmetic).split(':')[0]);
    if (i > maxIdx) maxIdx = i;
  }
  const top = HERO_KEYS.length - 1;
  const heroIdx = (rand() < 1 / 20 && maxIdx < top) ? maxIdx + 1 : Math.floor(rand() * (maxIdx + 1));
  return `${HERO_KEYS[heroIdx]}:${SKIN_KEYS[Math.floor(rand() * SKIN_KEYS.length)]}`;
}

function fillBots(room, rosterOut) {
  if (room.mode === 'training') return; // training has its own fixed dummy + sentry — no backfill
  const teamCount = (t) => Object.values(room.state.players).filter((p) => p.team === t).length;
  const usedSlots = (t) => new Set(Object.values(room.state.players).filter((p) => p.team === t).map((p) => p.slot));
  // #18 — consume the countdown PREVIEW plan (room.botPlan) so the bots that actually spawn keep the
  // team/slot/loadout/cosmetic the VS/countdown already showed (preview == match). Matched by
  // (team,slot); a leftover entry is reused in order, and with no plan we fall back to generating.
  const plan = Array.isArray(room.botPlan) ? room.botPlan.slice() : [];
  const takePlanned = (team, slot) => { let i = plan.findIndex((p) => p.team === team && p.slot === slot); if (i < 0) i = plan.length ? 0 : -1; return i >= 0 ? plan.splice(i, 1)[0] : null; };
  // Live bot dossier for the in-match settings readout (difficulty + card slots + real buffs).
  // Kept on the ROOM, not just in `rosterOut`, because the mid-match backfill path calls us with
  // no rosterOut — without this a bot that replaces a leaver would be missing from the panel.
  // Pruned against the live sim so a reclaimed slot drops out on its own.
  room.botRoster = (Array.isArray(room.botRoster) ? room.botRoster : []).filter((b) => room.state.players[b.id]);
  while (Object.keys(room.state.players).length < roomMax(room)) {
    const team = teamCount('A') <= teamCount('B') ? 'A' : 'B';
    const slot = firstFreeSlot(usedSlots(team), roomTeamSize(room));
    const id = `bot-${room.id}-${++room.botCounter}`;
    const planned = takePlanned(team, slot);
    const cosmetic = (planned && planned.cosmetic) || botCosmeticForRoom(room);
    // Task 18 — a bot's CARDS mirror the humans: EXTREME bots keep a fixed strong 3-card loadout +
    // their movement-SPEED/power cheat; every other bot reuses its PREVIEWED loadout (or a fresh
    // RANDOM 1..human-equipped-count when no preview exists), and its buffs are DERIVED from that
    // same loadout (buffsFromLoadout) so what the intro/countdown shows == what the bot plays with.
    // A bot gets the EXTREME fixed loadout + cheat buffs only when ITS side is at the top of the
    // ladder: the partner scalar if this team holds a human, else the enemy scalar.
    const teamHasHuman = Object.values(room.state.players).some((p) => !p.isBot && p.team === team);
    // A NAMED bot friend plays at ITS OWN level, not the room's, and keeps the exact three cards its
    // friend card advertised — including at the top of the ladder, where it takes the honest
    // card-derived buffs rather than the EXTREME flat cheat set. Swapping in extremeBotLoadout() here
    // would silently replace the cards the player was shown, and "display == gameplay" is the one
    // promise this whole card system rests on.
    const namedLevel = planned && Number.isFinite(planned.namedLevel) ? planned.namedLevel : null;
    const botLvl = namedLevel != null ? namedLevel : clampLevel(room.diffLevel);
    const sideScalar = botSideScalar(levelAt(botLvl), teamHasHuman);
    let loadout, buffs;
    if (namedLevel == null && sideScalar >= EXTREME_SKILL) {
      loadout = extremeBotLoadout();
      buffs = EXTREME_BOT_BUFFS;
    } else {
      loadout = planned ? planned.loadout : botLoadoutForLevel(room.diffLevel);
      buffs = buffsFromLoadout(loadout);
    }
    const botName = (planned && planned.name) || 'Bot';
    addPlayer(room.state, id, { name: botName, char: DEFAULT_CHAR, team, slot, isBot: true, cosmetic, buffs });
    room.inputs.set(id, emptyInput());
    // `buffs` + `skill` + `botLevel` ride along so the settings panel shows what the sim ACTUALLY
    // applies. An EXTREME bot's buffs are the flat cheat set, not f(cards), so a client that
    // re-derived them from `loadout` would under-report it by a third.
    const entry = {
      id, name: botName, avatar: null, team, cards: loadoutToCards(loadout), cosmetic, loadout, isBot: true,
      buffs, skill: sideScalar, botLevel: botLvl, partnerSide: teamHasHuman,
      // Set only for an invited house bot. It is what pins this bot's skill (applyTeamSkill) and keeps
      // relevelBots off it — its level is its identity, not the room's difficulty setting.
      ...(namedLevel != null ? { namedLevel } : {}),
    };
    room.botRoster.push(entry);
    if (rosterOut) rosterOut.push(entry);
  }
}

// Re-apply the room's CURRENT difficulty level to bots that already exist.
//
// Bot difficulty is two things: SKILL (applyTeamSkill, read live by the AI every tick) and CARD BUFFS
// (rolled once in fillBots from the level). A mid-match level change used to move only the first, so
// after switching from שלב 2 to קטלני the bots played at the new skill while still carrying the old
// level's card buffs — and the settings dossier reported those stale buffs as fact. This rolls the
// buffs/loadout for the new level, writes them into the live sim players, and refreshes the dossier
// entries so the readout describes what the sim is actually running.
// Training is untouched: its enemies are role-driven (updateTrainingDummy reads the enemy scalar
// live) and carry no card buffs, and room.botRoster is empty there.
function relevelBots(room) {
  if (!room || !Array.isArray(room.botRoster) || !room.botRoster.length) return;
  const level = clampLevel(room.diffLevel);
  for (const b of room.botRoster) {
    const p = room.state.players[b.id];
    if (!p) continue;
    // An invited house bot is exempt: its level came with its identity, so a host sliding the room
    // difficulty must not re-roll שובל into a level-2 player mid-match.
    if (Number.isFinite(b.namedLevel)) continue;
    const teamHasHuman = Object.values(room.state.players).some((q) => !q.isBot && q.team === p.team);
    const sideScalar = botSideScalar(levelAt(level), teamHasHuman);
    let loadout, buffs;
    if (sideScalar >= EXTREME_SKILL) { loadout = extremeBotLoadout(); buffs = EXTREME_BOT_BUFFS; }
    else { loadout = botLoadoutForLevel(level); buffs = buffsFromLoadout(loadout); }
    p.cardShot = buffs.cardShot; p.speedBuff = buffs.speedBuff; p.cardUtil = buffs.cardUtil;
    b.loadout = loadout; b.cards = loadoutToCards(loadout); b.buffs = buffs;
    b.skill = sideScalar; b.botLevel = level; b.partnerSide = teamHasHuman;
  }
}

// Rooms where a client may set the bot difficulty LIVE. The training ground, vs-bots and a builder
// test match exist to be tinkered with, and a private room is the host's own game. A PUBLIC matchmade
// room takes its level ONCE, at join, from the player's XP: accepting a live change there would let
// anyone weaken the enemy bots mid-match, and the level reported in matchResult (which sets the
// trophy BOT CEILING) would stop describing the level actually played.
const DIFF_LIVE_MODES = new Set(['training', 'botgame', 'builder']);
const canSetDiffLive = (room) => !!room && (room.isPrivate || DIFF_LIVE_MODES.has(room.mode));

// Push the bot dossier to everyone in the match. Called after a mid-match backfill, whose bots the
// original `matchStart` roster could not have contained.
function broadcastBots(room) {
  const payload = { type: 'bots', bots: Array.isArray(room.botRoster) ? room.botRoster : [], diffLevel: clampLevel(room.diffLevel) };
  for (const m of room.members) if (m.inMatch && m.ws.readyState === m.ws.OPEN) send(m.ws, payload);
}

// ---------------------------------------------------------------------------
// Bot AI (per room) — delegates to the shared, testable controller in
// shared/bot-ai.js (team coordinator + utility action selection + context
// steering + fog-of-war stealth + skill/latency). Tests: test-bot-ai.mjs; A/B: bot-eval.mjs.
// ---------------------------------------------------------------------------
function updateBots(room) {
  applyTeamSkill(room); // set per-team difficulty (enemy vs partner) before deciding inputs
  const inputs = computeBotInputs(room.state, room.botMem, DT);
  for (const id in inputs) room.inputs.set(id, inputs[id]);
}
// Map the room's difficulty LEVEL to a per-team skill scalar: the team(s) holding a human get
// the PARTNER skill, the all-bot team gets the ENEMY skill. (No human on a team, e.g. pure-bot
// or training, is treated as an enemy side.) Read live each tick by the bot AI.
function applyTeamSkill(room) {
  const lvl = levelAt(room.diffLevel);
  const human = { A: false, B: false };
  for (const p of Object.values(room.state.players)) if (!p.isBot && (p.team === 'A' || p.team === 'B')) human[p.team] = true;
  room.botMem.teamSkill = { A: human.A ? lvl.partner : lvl.enemy, B: human.B ? lvl.partner : lvl.enemy };
  // PER-BOT override for the invited house bots (mem.botSkill, honoured by memSkillVec in
  // shared/bot-ai.js): the team scalar above is the room's difficulty, and the whole point of adding
  // שובל (רמה 11) to a party is that HE is level 11 while an unnamed backfill bot stays at the room's
  // level. Skill is picked from the bot's own side — partner scalar if its team holds a human, enemy
  // scalar otherwise — recomputed live, so it follows a team change or a human leaving.
  const named = (room.botRoster || []).filter((b) => Number.isFinite(b.namedLevel));
  if (!named.length) { if (room.botMem.botSkill) room.botMem.botSkill = null; return; }
  const out = {};
  for (const b of named) {
    const p = room.state.players[b.id];
    if (!p) continue;
    const teamHasHuman = p.team === 'A' ? human.A : human.B;
    out[b.id] = botSideScalar(levelAt(b.namedLevel), teamHasHuman);
  }
  room.botMem.botSkill = out;
}

// Training ground: drive each role-based enemy from the shared, testable controllers.
function updateTrainingDummy(room) {
  const et = levelAt(room.diffLevel).enemy;                       // sentry difficulty from the enemy scalar
  const sentryTier = et < 0.18 ? 'easy' : et < 0.66 ? 'normal' : 'hard';
  for (const e of room.trainEnemies || []) {
    let inp = null;
    if (e.role === 'sentry') inp = trainingSentryInput(room.state, e.id, e.mem, DT, sentryTier, e.home);
    else if (e.role === 'keeper') inp = trainingKeeperInput(room.state, e.id);
    else inp = trainingStillInput(room.state, e.id, e.home);      // 'still'
    if (inp) room.inputs.set(e.id, inp);
  }
}

// ---------------------------------------------------------------------------
// Room membership + matchmaking
// ---------------------------------------------------------------------------
function addToRoom(member, room) {
  member.room = room;
  member.team = balancedTeam(room);
  member.inMatch = false; member.afk = false;
  room.members.add(member);
}

// --- Host approval helpers (private rooms) --------------------------------------------------------
// The HOST is the member whose id === room.hostId. Only they may accept/reject/kick (enforced in the
// message handlers, never trusted from the client).
function hostMember(room) {
  if (!room || !room.hostId) return null;
  for (const m of room.members) if (m.id === room.hostId) return m;
  return null;
}
function notifyHost(room, payload) {
  const h = hostMember(room);
  if (h) send(h.ws, payload);
}
// A pending (un-admitted) joiner is dropped from its room's pending map + the host is told to remove
// the request row. Safe to call for a member with no pending request.
function clearPending(member) {
  const room = member.pendingRoom;
  if (!room) return;
  member.pendingRoom = null;
  room.pending.delete(member.id);
  notifyHost(room, { type: 'joinRequestCancelled', joinerId: member.id });
}
// The host left a still-populated room: hand host to any remaining member and repopulate that new
// host's pending-request UI so waiting joiners aren't stranded.
function transferHost(room) {
  const next = room.members.values().next().value;
  if (!next) return;
  room.hostId = next.id;
  for (const p of room.pending.values()) {
    send(next.ws, { type: 'joinRequest', joinerId: p.id, userId: p.userId || null, name: p.name, avatar: p.avatar || null, cosmetic: p.cosmetic || DEFAULT_COSMETIC, cards: p.cards || [] });
  }
}

// Enter the matchmaking QUEUE. No room exists yet — planMatches decides when one should.
// `budgetMs` comes from the ENTRY POINT, not the format: the yellow משחק מהיר button and the 2v2
// picker card both resolve to format 'quick', so 5s-vs-10s can only be expressed per ticket.
function joinMatchmade(member, mode, diffLevel, trophies, budgetMs) {
  if (typeof diffLevel === 'number') member.diffLevel = clampLevel(diffLevel);
  enqueue(member, FORMATS[mode] ? mode : 'quick', budgetMs || MM_BUDGET_MODE_MS, trophies);
}

// One matcher pass. Called from tickAll, so it runs at TICK_RATE with the rest of the sim.
function runMatchmaker() {
  if (!tickets.size) return;
  const { groups, waiting, grants } = planMatches(tickets.values(), nowMs(), { roomMaxFor: roomMaxForMode });
  // Stamp the grants the pure function asked for. It never mutates its input, so this is the one
  // place graceUntil is written — which is also what makes "granted at most once" enforceable.
  for (const g of grants) {
    const t = tickets.get(g.memberId);
    // A ticket with unknown trophies never gets extended: we do not know its band well enough to
    // justify making it wait longer.
    if (t && t.member.trophies != null) t.graceUntil = g.graceUntil;
    else if (t) t.graceUntil = nowMs(); // mark spent so it resolves next tick instead of looping
  }
  for (const w of waiting) {
    const t = tickets.get(w.memberId);
    if (!t) continue;
    send(t.member.ws, { type: 'searching', mode: t.mode, phase: w.phase,
      bandLo: w.bandLo, bandHi: w.bandHi, searchingCount: w.searchingCount,
      remainingMs: Math.round(w.remainingMs), slots: { filled: 1, total: roomMaxForMode(t.mode) } });
  }
  for (const g of groups) formGroup(g);
}

// Turn a decided group into a real room. Every side effect lives here; planMatches has none.
function formGroup(group) {
  const fmt = FORMATS[group.mode] || FORMATS.quick;
  const room = makeRoom(`${fmt.prefix}-${++roomCounter}`, false);
  applyFormat(room, group.mode);
  rooms.set(room.id, room);
  // Bot difficulty from the group's MEDIAN human, computed ONCE. The old code set room.diffLevel from
  // whoever joined most recently, so in a shared public room the newest arrival picked the difficulty
  // for everyone already waiting.
  room.diffLevel = botLevelFromXp(xpForPlayerLevel(group.level));
  room.mmReason = group.reason;         // diagnostics + the client's screen hint
  room.mmBandLo = group.bandLo; room.mmBandHi = group.bandHi;
  // HUMANS ON OPPOSITE TEAMS: sorted by trophies and alternated, so the two closest-matched players
  // are the ones opposed and the human contest decides the match.
  const members = group.memberIds.map((id) => tickets.get(id)).filter(Boolean)
    .sort((a, b) => b.trophies - a.trophies).map((t) => t.member);
  members.forEach((m, i) => { m.team = i % 2 === 0 ? 'A' : 'B'; });
  for (const m of members) {
    dequeue(m.id);
    addToRoom(m, room);
    send(m.ws, { type: 'roomJoined', mode: group.mode, matchmade: true, code: null,
      mmReason: group.reason, humans: members.length });
  }
  // Fixed reveal on EVERY path, however the group formed. A full room used to call startMatch
  // directly — fast, but with no VS beat at all.
  room.phase = 'countdown';
  room.countdownT = MM_REVEAL_MS / 1000;
  broadcastLobby(room);
}

// Solo training ground: instant entry, no lobby/countdown, endless clock, and
// two enemies — a penned roaming dummy by the far goal + a midfield sentry that
// fires at you. Reuses the whole match render/snapshot pipeline.
function startTraining(member, diffLevel) {
  leaveCurrentRoom(member);
  const room = makeRoom(`train-${++roomCounter}`, false, 'training');
  rooms.set(room.id, room);
  addToRoom(member, room);
  // The training ground opens at the level the player PICKED, not at DEFAULT_LEVEL. Without this the
  // sentry always started at "normal" and the picker only took effect once you opened settings
  // mid-session — so the level shown in the panel disagreed with the enemy you were shooting at.
  if (typeof diffLevel === 'number') room.diffLevel = clampLevel(diffLevel);

  room.state = createState();
  room.state.noClock = true;      // never transitions to 'ended'
  room.state.arena = TRAIN_ARENA; // custom field: top-left bush + bottom-right steel wall
  room.inputs.clear();
  room.botCounter = 0;

  // You are team A (spawn left, attack the right goal).
  addPlayer(room.state, member.id, { name: member.name, char: DEFAULT_CHAR, team: 'A', slot: 0, isBot: false, cosmetic: member.cosmetic || DEFAULT_COSMETIC, buffs: buffsFromLoadout(member.loadout) });
  room.inputs.set(member.id, emptyInput());
  member.team = 'A'; member.inMatch = true; member.afk = false; member.lastInputAt = nowMs();

  // Team-B enemies, one per builder crate: a top-left SENTRY (shoots), two STILL targets
  // (bottom-left + middle), and a KEEPER at the far goal. Each holds/returns to its home spot.
  room.trainEnemies = [];
  TRAIN_ENEMIES.forEach((e, i) => {
    const id = `${e.key}-${room.id}`;
    addPlayer(room.state, id, { name: e.role, char: DEFAULT_CHAR, team: 'B', slot: i, isBot: true, cosmetic: randomBotCosmetic() });
    room.inputs.set(id, emptyInput());
    const p = room.state.players[id]; p.x = e.x; p.y = e.y;
    room.trainEnemies.push({ id, role: e.role, home: { x: e.x, y: e.y }, leash: e.leash !== false, mem: e.role === 'sentry' ? createSentryMem() : null });
  });

  const matchId = nextMatchId(room);
  const roster = [{ id: member.id, name: member.name, avatar: member.avatar || null, team: 'A', cards: member.cards || [] }];
  attachBall(room.state);   // MATCH START: ball loose in the middle, both sides race for it
  room.endHoldT = 0; room.statsSent = false;
  room.phase = 'match';
  send(member.ws, { type: 'roomJoined', mode: 'training', code: null });
  // diffLevel rides along so the client's settings/dossier readout reports the level the room is
  // actually running (matchDiffLevel was null here, which read as "unknown difficulty").
  send(member.ws, { type: 'matchStart', mode: 'training', diffLevel: clampLevel(room.diffLevel), matchId, playerId: member.id, team: 'A', field: FIELD, chars: CHARACTERS, settings: room.state.settings, players: roster });
  room.rosterVersion++; broadcastRoster(room);
}

// Validate + clamp a client-supplied field layout (never trust the wire). Caps counts
// and clamps every number into the pitch / sane capsule sizes.
// Clamps a client-supplied field to sane values. Coordinates clamp to the field's OWN size (see
// shared/field-sizes.js), not to the global FIELD — clamping a 2600-wide layout against 2000
// silently collapsed its whole right-hand side onto the touchline with no error, which made a
// bigger authored stadium impossible to round-trip. The resolved size id is echoed back so every
// downstream consumer (setField, matchStart's arena) agrees on which pitch this layout is for.
// An unknown/missing size resolves to s2v2 — the pitch every pre-sizes layout was drawn on.
function sanitizeField(field) {
  if (!field || typeof field !== 'object') return null;
  const size = sizeOfField(field);
  const num = (v, lo, hi, d) => (typeof v === 'number' && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  const cap = (w) => ({
    cx: num(w && w.cx, 0, size.W, size.W / 2), cy: num(w && w.cy, 0, size.H, size.H / 2),
    angle: num(w && w.angle, -Math.PI * 2, Math.PI * 2, 0),
    hl: num(w && w.hl, 20, 300, 88), ht: num(w && w.ht, 8, 60, 16),
  });
  const arr = (a) => (Array.isArray(a) ? a : []);
  return {
    version: 3,
    size: size.id,
    // Authored kickoff data (shared/field-spawns.js): start slots + the ball's spot. Their own
    // normalizers clamp to THIS size and cap the per-team slot count, so the sim can trust them.
    spawns: normSpawns(field.spawns, size),
    ball: normBall(field.ball, size),
    bushes: arr(field.bushes).slice(0, 20).map((b) => ({ x: num(b && b.x, 0, size.W, 0), y: num(b && b.y, 0, size.H, 0), w: num(b && b.w, 40, 600, 200), h: num(b && b.h, 40, 600, 150) })),
    hardWalls: arr(field.hardWalls).slice(0, 20).map(cap),
    dryWalls: arr(field.dryWalls).slice(0, 20).map(cap),
    // Crates: single-cell solid boxes (indestructible, like a hard wall). Clamp to a sane cell size.
    crates: arr(field.crates).slice(0, 40).map((c) => ({ x: num(c && c.x, 0, size.W, 0), y: num(c && c.y, 0, size.H, 0), w: num(c && c.w, 30, 160, 50), h: num(c && c.h, 30, 160, 50) })),
  };
}

// The main arena, sanitized once — applied to normal (2v2) + bot-game matches via setField,
// and sent to the client in matchStart (arena:...) so it renders + collides identically.
const MAIN_FIELD_CLEAN = sanitizeField(MAIN_FIELD);
// Sanitize each format's own arena ONCE at boot (same treatment MAIN_FIELD gets) and cache it on the
// FORMATS row, so roomField() is a lookup rather than a per-match sanitize.
for (const f of Object.values(FORMATS)) if (f.field) f.cleanField = sanitizeField(f.field);

// Solo "play my field vs bots": instant, endless, custom field + backfilled bots (2v2).
function startBuilderMatch(member, field, diffLevel) {
  // The client gates ▶ שחק on the size being hostable, but never trust it: the sim still reads its
  // geometry from the global FIELD, so hosting a non-base size would run 2000x1100 goal lines and
  // spawns underneath a bigger-looking pitch. Refuse instead of playing a lie. Widen RUNTIME_SIZES
  // once per-match geometry lands — see summery/ARENA-SIZES-PLAN.md.
  const wanted = sizeOfField(field);
  if (!canHost(wanted.id)) { send(member.ws, { type: 'roomError', msg: `מגרש ${wanted.name} — אפשר לבנות, משחק בקרוב` }); return; }
  leaveCurrentRoom(member);
  const room = makeRoom(`build-${++roomCounter}`, false, 'builder');
  rooms.set(room.id, room);
  addToRoom(member, room);
  room.state = createState();
  room.state.noClock = true; // endless — tinker + playtest freely
  // Test your field against the bots YOU chose. This path ignored diffLevel entirely, so every
  // builder playtest ran at DEFAULT_LEVEL however the picker was set.
  if (typeof diffLevel === 'number') room.diffLevel = clampLevel(diffLevel);
  const clean = sanitizeField(field);
  if (clean) setField(room.state, clean);
  room.inputs.clear();
  room.botCounter = 0;
  addPlayer(room.state, member.id, { name: member.name, char: DEFAULT_CHAR, team: 'A', slot: 0, isBot: false, cosmetic: member.cosmetic || DEFAULT_COSMETIC, buffs: buffsFromLoadout(member.loadout) });
  room.inputs.set(member.id, emptyInput());
  member.team = 'A'; member.inMatch = true; member.afk = false; member.lastInputAt = nowMs();
  const matchId = nextMatchId(room);
  const roster = [{ id: member.id, name: member.name, avatar: member.avatar || null, team: 'A', cards: member.cards || [], cosmetic: member.cosmetic || DEFAULT_COSMETIC, loadout: sanitizeLoadout(member.loadout, member.cards), isBot: false }];
  room.phase = 'match';
  fillBots(room, roster); // backfill bots on both teams
  attachBall(room.state);   // MATCH START: ball loose in the middle, both sides race for it
  room.endHoldT = 0; room.statsSent = false;
  send(member.ws, { type: 'roomJoined', mode: 'builder', code: null });
  send(member.ws, { type: 'matchStart', mode: 'builder', diffLevel: clampLevel(room.diffLevel), matchId, playerId: member.id, team: 'A', field: FIELD, chars: CHARACTERS, settings: room.state.settings, players: roster, arena: clean });
  room.rosterVersion++; broadcastRoster(room);
}

// Training option: a full 2v2 MATCH vs bots only (default arena, real clock). Instant,
// solo entry; the human is team A and every other slot is a bot. Difficulty from the client.
function startBotGame(member, diffLevel) {
  leaveCurrentRoom(member);
  // mode 'botgame', not 'match': this is a solo practice room, and the room has to SAY so for the
  // difficulty gate (canSetDiffLive) to tell it apart from a public matchmade room. `roomJoined`
  // already reported 'botgame' to the client; only the room object was still calling itself a match.
  // (room.mode is compared against 'training' and nothing else, so nothing downstream shifts.)
  const room = makeRoom(`bots-${++roomCounter}`, false, 'botgame');
  rooms.set(room.id, room);
  addToRoom(member, room);
  room.state = createState();
  room.state.goalsToWin = room.goalsToWin || 0; // vs-bots is a normal 2v2 → first to 3
  setField(room.state, MAIN_FIELD_CLEAN); // play on the main arena (custom field)
  if (typeof diffLevel === 'number') room.diffLevel = clampLevel(diffLevel);
  room.inputs.clear();
  room.botCounter = 0;
  addPlayer(room.state, member.id, { name: member.name, char: DEFAULT_CHAR, team: 'A', slot: 0, isBot: false, cosmetic: member.cosmetic || DEFAULT_COSMETIC, buffs: buffsFromLoadout(member.loadout) });
  room.inputs.set(member.id, emptyInput());
  member.team = 'A'; member.inMatch = true; member.afk = false; member.lastInputAt = nowMs();
  const matchId = nextMatchId(room);
  const roster = [{ id: member.id, name: member.name, avatar: member.avatar || null, team: 'A', cards: member.cards || [], cosmetic: member.cosmetic || DEFAULT_COSMETIC, loadout: sanitizeLoadout(member.loadout, member.cards), isBot: false }];
  room.phase = 'match';
  fillBots(room, roster); // fill the other 3 slots with bots
  attachBall(room.state);   // MATCH START: ball loose in the middle, both sides race for it
  room.endHoldT = 0; room.statsSent = false;
  send(member.ws, { type: 'roomJoined', mode: 'botgame', code: null });
  send(member.ws, { type: 'matchStart', mode: 'botgame', diffLevel: room.diffLevel, matchId, playerId: member.id, team: 'A', field: FIELD, chars: CHARACTERS, settings: room.state.settings, players: roster, arena: MAIN_FIELD_CLEAN, goalsToWin: room.state.goalsToWin | 0 });
  room.rosterVersion++; broadcastRoster(room);
}

// ---- SPECTATE: an ALL-BOT match a human can WATCH ------------------------------------------
// Requested: "I don't want to play it, I want to watch a real life simulation for all bots."
// Same room lifecycle as startBotGame, with three deliberate differences:
//   * NO human player is added to the sim, so fillBots fills EVERY slot and the match is bot-vs-bot
//     with the real server-side AI, the real arena and the real physics;
//   * goalsToWin 0 — endless, so a watcher is not thrown back to the lobby after three goals;
//   * matchStart carries playerId: null. That single null is what makes the client a spectator:
//     flushInput() already bails on `!me.playerId`, so no input can reach the room, and checkAfk
//     skips a member with no player (`if (!p) continue`), so the watcher is never turned into a bot.
// The member still JOINS the room, so it receives exactly the snapshots a player would.
function startSpectate(member, diffLevel) {
  leaveCurrentRoom(member);
  const room = makeRoom(`watch-${++roomCounter}`, false, 'botgame');
  rooms.set(room.id, room);
  addToRoom(member, room);
  room.state = createState();
  room.state.goalsToWin = 0;                       // endless — this is a demo, not a match
  setField(room.state, MAIN_FIELD_CLEAN);
  if (typeof diffLevel === 'number') room.diffLevel = clampLevel(diffLevel);
  room.inputs.clear();
  room.botCounter = 0;
  member.team = 'A'; member.inMatch = true; member.afk = false; member.lastInputAt = nowMs();
  const matchId = nextMatchId(room);
  const roster = [];
  room.phase = 'match';
  fillBots(room, roster);                          // no humans in the sim -> every slot is a bot
  attachBall(room.state);   // MATCH START: ball loose in the middle, both sides race for it
  room.endHoldT = 0; room.statsSent = false;
  send(member.ws, { type: 'roomJoined', mode: 'botgame', code: null });
  send(member.ws, { type: 'matchStart', mode: 'botgame', spectate: true, diffLevel: room.diffLevel, matchId,
    playerId: null, team: 'A', field: FIELD, chars: CHARACTERS, settings: room.state.settings,
    players: roster, arena: MAIN_FIELD_CLEAN, goalsToWin: 0 });
  room.rosterVersion++; broadcastRoster(room);
}

// A challenge accept drops both players into a fresh private room on opposite teams
// and starts the normal countdown → match. Reuses the private-room lifecycle.
function startChallengeMatch(a, b) {
  leaveCurrentRoom(a);
  leaveCurrentRoom(b);
  const code = genCode();
  if (!code) { send(a.ws, { type: 'challengeError', msg: 'אין קודי חדר פנויים' }); send(b.ws, { type: 'challengeError', msg: 'אין קודי חדר פנויים' }); return; }
  const room = makeRoom(code, true);
  rooms.set(room.id, room);
  room.hostId = a.id; // challenger nominally hosts; both are auto-admitted (a challenge IS mutual consent — no approval step)
  addToRoom(a, room);
  addToRoom(b, room);
  a.team = 'A';
  b.team = 'B';
  send(a.ws, { type: 'roomJoined', mode: 'private', code: room.id, host: true });
  send(b.ws, { type: 'roomJoined', mode: 'private', code: room.id, host: false });
  startCountdown(room);
  broadcastLobby(room);
}

function createPrivateRoom(member) {
  leaveCurrentRoom(member);
  const code = genCode();
  if (!code) { send(member.ws, { type: 'roomError', msg: 'אין קודי חדר פנויים, נסו שוב' }); return; }
  const room = makeRoom(code, true);
  rooms.set(room.id, room);
  room.hostId = member.id; // the creator is the HOST — only they may accept/reject/kick
  addToRoom(member, room);
  send(member.ws, { type: 'roomJoined', mode: 'private', code: room.id, host: true });
  broadcastLobby(room);
}

// Join-by-code: the joiner does NOT enter the room yet — they go PENDING and the HOST is notified.
// The host's joinDecision (accept) admits them; reject/leave/disconnect drops them.
function joinPrivateRoom(member, code) {
  const room = rooms.get(normalizeRoomCode(code));
  if (!room || !room.isPrivate) { send(member.ws, { type: 'roomError', msg: 'החדר לא נמצא' }); return; }
  if (room.phase === 'match') { send(member.ws, { type: 'roomError', msg: 'המשחק כבר התחיל' }); return; }
  if (room.members.size >= roomMax(room)) { send(member.ws, { type: 'roomError', msg: 'החדר מלא' }); return; }
  if (room.pending.size >= roomMax(room)) { send(member.ws, { type: 'roomError', msg: 'יותר מדי בקשות, נסו שוב' }); return; }
  leaveCurrentRoom(member); // leaves any current room AND clears a prior pending request (clearPending runs first)
  member.pendingRoom = room;
  room.pending.set(member.id, member);
  send(member.ws, { type: 'joinPending', code: room.id });
  notifyHost(room, { type: 'joinRequest', joinerId: member.id, userId: member.userId || null, name: member.name, avatar: member.avatar || null, cosmetic: member.cosmetic || DEFAULT_COSMETIC, cards: member.cards || [] });
}

// Remove a member from their room; clean up / keep the match alive as needed.
function leaveCurrentRoom(member) {
  dequeue(member.id); // a member leaving/disconnecting while merely QUEUED (no room yet) must still drop its ticket
  clearPending(member); // if this member had an outstanding join request, drop it + tell that host
  const room = member.room;
  if (!room) return;
  const wasInMatch = member.inMatch;
  const wasHost = room.hostId === member.id;
  room.members.delete(member);
  member.room = null; member.inMatch = false;
  if (wasInMatch && room.phase === 'match') {
    if (room.state.players[member.id]) { removePlayer(room.state, member.id); room.inputs.delete(member.id); }
    fillBots(room);
    if (humansInRoom(room) === 0) endRoom(room);
    else if (room.phase === 'match') { room.rosterVersion++; broadcastRoster(room); broadcastBots(room); } // a bot backfilled a slot
  }
  if (room.members.size === 0) destroyRoom(room);
  else { if (wasHost) transferHost(room); broadcastLobby(room); } // host disconnect/leave -> hand off to a remaining member
}

function destroyRoom(room) {
  rooms.delete(room.id);
  clearForming(room);
  // Any joiners still waiting on this (now gone) room's host must be returned to the lobby.
  if (room.pending) {
    for (const p of room.pending.values()) { p.pendingRoom = null; send(p.ws, { type: 'joinRejected', code: room.id, reason: 'closed' }); }
    room.pending.clear();
  }
}

function startCountdown(room) {
  room.phase = 'countdown';
  room.countdownT = COUNTDOWN_TIME;
  broadcastLobby(room);
}

// Everyone still in the room (not already playing) starts the match, honouring
// chosen teams (up to 2 each); empty slots become bots.
function startMatch(room) {
  const humans = [...room.members].filter((m) => !m.inMatch).slice(0, roomMax(room));
  if (humans.length === 0) { endRoom(room); return; }

  // Fold the invited bots into the plan BEFORE the reservation list is dropped — the plan is what
  // carries their name / level / cards into fillBots. A private lobby normally has a fresh plan from
  // the last broadcast; this makes the match path not depend on that having happened.
  ensureBotPlan(room);
  room.lobbyBots = []; // reservation consumed — fillBots creates the real match bots
  room.state = createState();
  room.state.teamSize = roomTeamSize(room); // spawnPos reads this for the kickoff formation
  room.state.goalsToWin = room.goalsToWin || 0; // first-to-N (normal 2v2 = 3; goal-brawl = 0 = timed)
  setField(room.state, roomField(room)); // this format's arena (3v3 has its own; else the main one)
  room.botMem = createBotMemory();
  room.inputs.clear();
  room.botCounter = 0;

  const teamSlots = { A: teamSlotList(roomTeamSize(room)), B: teamSlotList(roomTeamSize(room)) };
  const assigned = [];
  for (const m of humans) { // first pass — honour chosen team when a slot is free
    const t = m.team === 'B' ? 'B' : 'A';
    if (teamSlots[t].length) assigned.push([m, t, teamSlots[t].shift()]);
    else assigned.push([m, null, null]);
  }
  for (const a of assigned) { // overflow -> any open slot
    if (a[1]) continue;
    const t = teamSlots.A.length ? 'A' : 'B';
    a[1] = t; a[2] = teamSlots[t].shift();
  }
  // Stable per-match id (roomId + GLOBAL monotonic match seq): unique per match instance across the
  // whole process — a reused private-room code can't collide with an earlier room's matchId — and
  // identical if the same matchStart is resent. Feeds matchResult idempotency downstream (app -> backend).
  const matchId = nextMatchId(room);
  const introMs = Math.round(INTRO_PROMO * 1000);
  // Roster for the team-intro overlay: EACH participant's team + album (cards) + equipped card-powers
  // (loadout). Built BEFORE matchStart is sent, and bots are APPENDED below (Task 18) so the countdown/
  // intro payload carries bot cards too — the client reads players[].loadout to render them.
  const roster = assigned.map(([m, team]) => ({ id: m.id, name: m.name, avatar: m.avatar || null, team, cards: m.cards || [], cosmetic: m.cosmetic || DEFAULT_COSMETIC, loadout: sanitizeLoadout(m.loadout, m.cards), isBot: false }));
  for (const [m, team, slot] of assigned) {
    addPlayer(room.state, m.id, { name: m.name, char: DEFAULT_CHAR, team, slot, isBot: false, cosmetic: m.cosmetic || DEFAULT_COSMETIC, buffs: buffsFromLoadout(m.loadout) });
    room.inputs.set(m.id, emptyInput());
    m.team = team; m.inMatch = true; m.afk = false; m.lastInputAt = nowMs();
  }
  // Size this match's bots to the humans: total card-power target + equipped-count ceiling + a pool of
  // the humans' real card numbers (for valid bot card art), then fill empty slots — collecting each
  // bot's synthesized loadout into `roster` so the intro shows bot cards too (Task 18).
  room.botBuffTarget = humanBuffTarget(assigned);
  room.botLoadoutParams = botLoadoutParamsFromHumans(assigned);
  fillBots(room, roster);
  for (const [m, team] of assigned) {
    // goalsToWin tells the client the match FORMAT (first-to-N, or 0 = timed/most-goals).
    // Without it the HUD renders bare digits with no target and no match-point cue.
    // opponentKey is computed PER RECIPIENT (see opponentKeyFor) so no player ever learns another
    // player's identity — each client only gets an opaque hash describing who it just played.
    send(m.ws, { type: 'matchStart', diffLevel: room.diffLevel, matchId, playerId: m.id, team, field: FIELD, chars: CHARACTERS, settings: room.state.settings, players: roster, intro: introMs, arena: roomField(room), teamSize: roomTeamSize(room), goalsToWin: room.state.goalsToWin | 0, opponentKey: opponentKeyFor(assigned, m, team) });
  }
  attachBall(room.state);   // MATCH START: ball loose in the middle, both sides race for it
  room.endHoldT = 0; room.statsSent = false;
  room.introT = INTRO_PROMO;   // hold the sim frozen while the client plays the promo (see tickRoom)
  room.phase = 'match';
  room.rosterVersion++; broadcastRoster(room); // slot->id map for binary snapshots — sent before any snapshot
  clearForming(room); // it's playing now — the next joiners of this format form a fresh room
  broadcastLobby(room);
}

// Match over (time up, or last human left). Public rooms dissolve -> home;
// private rooms return to their lobby so friends can rematch with the same code.
function endRoom(room) {
  const hadHumans = [...room.members];
  if (room.isPrivate && room.members.size > 0) {
    room.phase = 'lobby'; room.countdownT = 0; room.endHoldT = 0;
    room.state = createState(); room.state.goalsToWin = room.goalsToWin || 0; room.botMem = createBotMemory(); room.inputs.clear(); room.botCounter = 0;
    for (const m of room.members) { m.inMatch = false; m.afk = false; }
    for (const m of room.members) send(m.ws, { type: 'toLobby' });
    broadcastLobby(room);
  } else {
    for (const m of hadHumans) { m.room = null; m.inMatch = false; send(m.ws, { type: 'toHome', online: onlineCount() }); }
    destroyRoom(room);
  }
}

function checkAfk(room) {
  const t = nowMs();
  for (const m of room.members) {
    if (!m.inMatch || m.afk) continue;
    const p = room.state.players[m.id];
    if (!p) continue;
    if (t - m.lastInputAt > AFK_SECONDS * 1000) { m.afk = true; p.isBot = true; }
  }
}
function humansInRoom(room) {
  let n = 0;
  for (const m of room.members) if (m.inMatch) n++;
  return n;
}

// ---------------------------------------------------------------------------
// Per-room tick
// ---------------------------------------------------------------------------
function tickRoom(room) {
  if (room.phase === 'countdown') {
    room.countdownT -= DT;
    if (room.countdownT <= 0) startMatch(room);
    return;
  }
  if (room.phase !== 'match') return;
  if (room.introT > 0) {                    // pre-kickoff promo: freeze the sim so the clock + play wait for the cinematic
    room.introT -= DT;
    for (const inp of room.inputs.values()) consumeEdges(inp);
    return;                                 // snapshots keep broadcasting the frozen kickoff state
  }
  if (room.mode === 'training') {
    updateTrainingDummy(room);
  } else {
    checkAfk(room);
    updateBots(room);
  }
  const inputMap = {};
  for (const [id, inp] of room.inputs) inputMap[id] = inp;
  step(room.state, inputMap, DT);
  if (room.mode === 'training') {
    for (const e of room.trainEnemies || []) {
      if (e.role === 'keeper') keeperClamp(room.state, e.id);               // pin the keeper to the box
      else if (e.leash) leashSentry(room.state, e.id, e.home, TRAIN_HOME_LEASH); // sentry + leashed still: return-home
      // no-leash enemies (middle bot) fly off freely; their walk-home input still returns them
    }
  }
  for (const inp of room.inputs.values()) consumeEdges(inp); // edges + their payloads are one-shot; hold persists as a level
  if (room.state.phase === 'ended') {
    if (!room.statsSent) { // one-shot: hand each human their per-player match tallies for logging
      room.statsSent = true;
      for (const m of room.members) {
        if (!m.inMatch || m.ws.readyState !== m.ws.OPEN) continue;
        const pl = room.state.players[m.id];
        // Round the accumulators (seconds / metres) so the wire + the logged stats stay tidy ints.
        if (pl && pl.stat) send(m.ws, { type: 'matchStats', stats: {
          ...pl.stat,
          possSec: Math.round(pl.stat.possSec),
          distM: Math.round(pl.stat.distPx / 100), // ~100px = 1 "metre" of pitch
          distPx: undefined,
        } });
      }
    }
    room.endHoldT += DT;
    if (room.endHoldT >= ENDED_HOLD) endRoom(room);
  } else if (humansInRoom(room) === 0) {
    endRoom(room);
  }
}

function tickAll() {
  try {
    runMatchmaker();
    for (const room of [...rooms.values()]) tickRoom(room);
  } catch (e) { if (tickErrCount++ < 5) console.error('TICK ERROR:', (e && e.stack) || e); }
}

// ---------------------------------------------------------------------------
// Snapshots + lobby/home presence
// ---------------------------------------------------------------------------
function snapshot(room) {
  const state = room.state;
  const r1 = (v) => Math.round(v * 10) / 10;
  const players = Object.values(state.players).map((p) => ({
    id: p.id, name: p.name, char: p.char, team: p.team,
    x: r1(p.x), y: r1(p.y),
    vx: r1(p.vx + p.kvx), vy: r1(p.vy + p.kvy),
    aimX: Math.round(p.aimX * 100) / 100, aimY: Math.round(p.aimY * 100) / 100,
    firing: p.firing, lastSeq: p.lastSeq, power: p.power,
    ammo: p.ammo, reloading: p.reloadLock > 0,
    reloadFrac: Math.round(100 * (p.reloadLock > 0
      ? 1 - p.reloadLock / EMPTY_RELOAD
      : (p.ammo < MAG_SIZE ? p.ammoT / AMMO_REGEN : 0))) / 100,
    buildAmmo: p.buildAmmo,
    // Ring progress uses the SAME effective reload the sim does (cdMul/cardUtil) so a full circle
    // takes exactly as long as one charge actually reloads — the ring completes when the charge lands.
    buildFrac: Math.round(100 * (p.buildAmmo < BUILD_MAG ? p.buildAmmoT / (BUILD_RELOAD * (p.cdMul || 1) * (p.cardUtil || 1)) : 0)) / 100,
    buildWindup: p.buildWindup, // winding flag (wire.js overloads buildFrac with this when > 0)
  }));
  return {
    type: 'snapshot',
    tick: state.tick, phase: state.phase, elapsed: Math.floor(state.elapsed),
    resetTimer: state.resetTimer, lastGoal: state.lastGoal, score: state.score,
    ball: { x: r1(state.ball.x), y: r1(state.ball.y), owner: state.ball.owner },
    players,
    projectiles: state.projectiles.map((p) => ({ id: p.id, x: r1(p.x), y: r1(p.y), team: p.team })),
    walls: state.builtWalls.map((w) => ({ id: w.id, x: w.x, y: w.y, w: w.w, h: w.h, hp: w.hp, maxHp: w.maxHp, team: w.team, fragile: w.fragile, angle: w.angle, hl: w.hl, ht: w.ht })),
    bombs: state.bombs.map((b) => ({ id: b.id, x: r1(b.x), y: r1(b.y), team: b.team, fuse: Math.round(b.fuse * 100) / 100, owner: b.owner })), // owner → client arcs the throw FROM the planter (else it teleports)
    blasts: state.blasts.map((b) => ({ id: b.id, x: r1(b.x), y: r1(b.y), radius: b.radius, life: b.life, maxLife: b.maxLife })),
    impacts: state.impacts.map((i) => ({ id: i.id, type: i.type, target: i.target, team: i.team, x: r1(i.x), y: r1(i.y), dx: i.dx, dy: i.dy, life: i.life, maxLife: i.maxLife })),
  };
}

// Roster: the slot->id/team mapping for the compact binary snapshots, sent as a JSON
// control frame whenever the player set changes (match start + mid-match bot backfill).
// TCP ordering guarantees it precedes the snapshots that reference its rosterVersion.
function broadcastRoster(room) {
  const ps = Object.values(room.state.players);
  room.slotIds = ps.map((p) => p.id);
  room.slotTeam = ps.map((p) => p.team);
  const payload = { type: 'roster', v: room.rosterVersion, slots: ps.map((p, i) => ({ i, id: p.id, team: p.team, c: p.cosmetic || DEFAULT_COSMETIC })) };
  for (const m of room.members) if (m.inMatch && m.ws.readyState === m.ws.OPEN) send(m.ws, payload);
}

function broadcastSnapshots() {
  try {
    for (const room of rooms.values()) {
      if (room.phase !== 'match' || !room.slotIds) continue;
      const buf = encodeKeyframe(snapshot(room), room.slotIds, room.rosterVersion); // compact binary, encoded once per room
      for (const m of room.members) {
        if (!m.inMatch || m.ws.readyState !== m.ws.OPEN) continue;
        if (m.ws.bufferedAmount > BACKPRESSURE_LIMIT) continue; // backpressure: drop a stale frame for a backed-up client
        try { m.ws.send(buf); } catch { /* dead socket */ }
      }
    }
  } catch (e) { if (bcErrCount++ < 5) console.error('BROADCAST ERROR:', (e && e.stack) || e); }
}

function lobbyPayload(room) {
  ensureBotPlan(room); // #18: keep the previewed bot fill fresh for the matchmaking VS/countdown
  // #18 fix: send each human's EQUIPPED loadout (not just their album) so the VS/countdown shows the
  // cards they actually picked in their power slots — matching what the pre-kickoff reveal shows. Without
  // this the client falls back to album top-3 during the countdown, so humans and bots looked inconsistent.
  // `chat` is the member's LAST message and when it was sent; the client fades the bubble itself, so
  // one field carries it and no extra packet type is needed. Expired bubbles are dropped here rather
  // than kept forever, so a member who spoke once at the start of a long lobby is not still talking.
  const chatOf = (m) => (m.chat && nowMs() - m.chat.at < LOBBY_BUBBLE_MS ? { text: m.chat.text, chatId: m.chat.chatId || null, at: m.chat.at } : null);
  const list = [...room.members].map((m) => ({ id: m.id, name: m.name, avatar: m.avatar || null, team: m.team, inMatch: m.inMatch, cosmetic: m.cosmetic || DEFAULT_COSMETIC, cards: m.cards || [], loadout: sanitizeLoadout(m.loadout, m.cards), chat: chatOf(m) }));
  // Invited lobby bots render as members (isBot) so the party looks populated before kickoff.
  // A NAMED bot (שובל/נווה/פז/אורי) carries its own cards + level, so the party lobby shows the same
  // three power slots its friend card advertised. An unnamed one still shows empty slots.
  for (const b of (room.lobbyBots || [])) list.push({ id: b.id, name: b.name, avatar: null, team: b.team, inMatch: false, isBot: true, cosmetic: b.cosmetic || DEFAULT_COSMETIC,
    cards: b.cards || [], loadout: b.loadout || [null, null, null],
    ...(Number.isFinite(b.namedLevel) ? { level: displayLevelForBot(b.namedLevel), xp: xpForBotLevel(b.namedLevel) } : {}) });
  // #18: on the quick-match VS, show the bots that WILL fill the empty slots (with their cards) while
  // you wait. Private rooms also backfill bots at kickoff, but their lobby is for real friends, so we
  // don't preview bots there — they still appear at the pre-kickoff reveal.
  const showBots = !room.isPrivate && room.phase !== 'match';
  const bots = (showBots && Array.isArray(room.botPlan))
    ? room.botPlan.map((b, i) => ({ id: `botprev-${room.id}-${i}`, name: 'Bot', avatar: null, team: b.team, isBot: true, cards: b.cards, loadout: b.loadout,
        level: displayLevelForBot(room.diffLevel), xp: xpForBotLevel(room.diffLevel) })) // bot level+XP for the countdown badge
    : [];
  const fmt = FORMATS[room.format] || FORMATS.quick;
  return {
    type: 'lobby',
    mode: room.isPrivate ? 'private' : 'quick',
    // Which format this room is playing, so the VS/teams page can print the win rule and size its
    // columns. `mode` above stays private|quick for the older lobby/party readers — don't reuse it.
    format: room.format || (room.isPrivate ? 'private' : 'quick'),
    game: room.game || null,           // the MODES card id the host picked, so every client agrees
    maxPlayers: roomMax(room),         // teamSize x 2 — the team page prints "up to N"
    freeText: room.isPrivate,          // may this room's members type? (party rooms only)
    rule: room.goalsToWin > 0 ? `ראשון ל-${room.goalsToWin} · עד 2 דק׳` : fmt.rule,
    teamSize: fmt.teamSize,
    goalsToWin: room.goalsToWin | 0,
    code: room.isPrivate ? room.id : null,
    phase: room.phase,
    countdown: room.phase === 'countdown' ? Math.max(0, Math.ceil(room.countdownT)) : 0,
    online: onlineCount(),
    host: room.hostId || null, // member.id of the HOST; a client shows host controls when host === its own welcome id
    members: list,
    bots,
  };
}
function broadcastLobby(room) {
  const payload = lobbyPayload(room);
  for (const m of room.members) if (!m.inMatch) send(m.ws, payload);
}

// Presence: which of THIS member's friends are currently connected.
function sendPresenceTo(member) {
  if (!member) return;
  const online = (member.friends || []).filter((uid) => onlineByUser.has(uid));
  send(member.ws, { type: 'friendsPresence', online });
}
// When user `userId` connects/disconnects, refresh presence for everyone who has
// them as a friend.
function notifyFriendsOfPresence(userId) {
  for (const m of members.values()) {
    if (m.userId && Array.isArray(m.friends) && m.friends.includes(userId)) sendPresenceTo(m);
  }
}

// 5Hz presence: home count to roomless clients, lobby state to waiting room members.
function broadcastPresence() {
  const online = onlineCount();
  for (const m of members.values()) {
    if (!m.room) send(m.ws, { type: 'home', online });
  }
  for (const room of rooms.values()) {
    if (room.phase !== 'match') broadcastLobby(room);
  }
}

setInterval(tickAll, 1000 / TICK_RATE);
setInterval(broadcastSnapshots, 1000 / SNAPSHOT_RATE);
setInterval(broadcastPresence, 200);
// WS heartbeat: reap half-open sockets (phone switched wifi↔cellular / backgrounded) that would
// otherwise linger as zombies holding a match slot until the OS TCP timeout. Browsers auto-pong.
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch {} continue; }
    ws.isAlive = false; try { ws.ping(); } catch {}
  }
}, 20000);

// Sanitize the album handed over from the app (join.cards): a compact, non-PII list
// [{r,n,c,w}]. Validate rarity/number, clamp copies/worth, cap the length.
const CARD_RARITIES = ['common', 'rare', 'epic', 'legendary'];
// The full card album: numbers 1..50 in EACH rarity => 200 cards total (see saltiz-cards migration
// 0003: card_number between 1 and 50). Bots draw their card art from this whole range.
const CARDS_PER_RARITY = 50;
const randomCardNum = () => 1 + Math.floor(Math.random() * CARDS_PER_RARITY);
function sanitizeCards(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const card of raw) {
    if (!card || !CARD_RARITIES.includes(card.r)) continue;
    const n = Math.trunc(Number(card.n));
    if (!Number.isFinite(n) || n < 1 || n > 200) continue;
    out.push({
      r: card.r, n,
      c: Math.max(1, Math.min(99, Math.trunc(Number(card.c)) || 1)),
      w: Math.max(0, Number(card.w) || 0),
    });
    if (out.length >= 256) break;
  }
  return out;
}

// Card-powers loadout: 3 slots, each holding one owned card {r,n} (or null). Slot 0 =
// Shot, 1 = Speed, 2 = Utility. Validate every slotted card is actually IN the member's
// sanitized album (drop anything not owned) — the client only says WHICH card in WHICH
// slot; the server owns rarity->strength so a client can't send an arbitrary buff.
function sanitizeLoadout(raw, memberCards) {
  const owned = Array.isArray(memberCards) ? memberCards : [];
  const used = new Set(); // one card instance per loadout: first slot to claim a card wins
  const pick = (slot) => {
    if (!slot || !CARD_RARITIES.includes(slot.r)) return null;
    const n = Math.trunc(Number(slot.n));
    if (!Number.isFinite(n) || n < 1 || n > 200) return null;
    const key = slot.r + '#' + n;
    if (used.has(key)) return null; // already consumed by an earlier slot — no cross-slot duplicates
    if (!owned.some((c) => c.r === slot.r && c.n === n)) return null;
    used.add(key);
    return { r: slot.r, n };
  };
  const arr = Array.isArray(raw) ? raw : [];
  return [pick(arr[0]), pick(arr[1]), pick(arr[2])];
}

// Rarity -> buff percentage ("album matters") now lives in shared/bot-buffs.js, imported at the
// top of this file: the settings panel DISPLAYS these same numbers, and a second hand-copied table
// is how the readout drifts from the sim. Server still derives them from its OWN card record —
// never a client-sent %.

// --- Bots get RANDOM card powers roughly matching the human players in the match ------------------
// Average card power across a match's assigned humans — the level bots are sized to. 0 if nobody has cards.
function humanBuffTarget(assigned) {
  const humans = (assigned || []).filter((a) => a && a[0]);
  if (!humans.length) return 0;
  return humans.reduce((s, a) => s + loadoutTotalPct(a[0].loadout), 0) / humans.length;
}
// Probabilistically round a per-slot target to an ADJACENT rarity step so the EXPECTED buff equals the
// target (unbiased even at the legendary 0.20 cap) while still varying between bots. Each slot lands on
// a real rarity, so a bot's buff always equals "a card".
const RARITY_PCT_STEPS = [0, 0.03, 0.07, 0.12, 0.20]; // empty / common / rare / epic / legendary
function pickRarityPct(target) {
  const t = Math.max(0, Math.min(0.20, Number(target) || 0));
  let lo = 0, hi = 0.20;
  for (let i = 0; i < RARITY_PCT_STEPS.length - 1; i++) {
    if (t >= RARITY_PCT_STEPS[i] && t <= RARITY_PCT_STEPS[i + 1]) { lo = RARITY_PCT_STEPS[i]; hi = RARITY_PCT_STEPS[i + 1]; break; }
  }
  if (hi === lo) return lo;
  return Math.random() < (t - lo) / (hi - lo) ? hi : lo;
}
// A RANDOM bot loadout whose 3 slot buffs roughly match `targetTotal` (the human average): each slot is
// target/3 probabilistically rounded to a rarity, so E[total] == target. Same shape as buffsFromLoadout.
function randomBotBuffs(targetTotal) {
  const per = Math.max(0, Number(targetTotal) || 0) / 3;
  const shot = pickRarityPct(per), speed = pickRarityPct(per), util = pickRarityPct(per);
  return { cardShot: 1 / (1 - shot), speedBuff: 1 + speed, cardUtil: 1 - util };
}

// --- Bot DISPLAY loadouts (Task 18): match the humans' card COUNT + rarities, shown in the intro -----
// Non-empty slots in a sanitized loadout = a player's equipped card count.
function equippedCount(loadout) {
  const L = Array.isArray(loadout) ? loadout : [];
  return (L[0] ? 1 : 0) + (L[1] ? 1 : 0) + (L[2] ? 1 : 0);
}
// Inverse of RARITY_BUFF_PCT: a rarity-step pct -> its rarity name.
const PCT_TO_RARITY = { 0.03: 'common', 0.07: 'rare', 0.12: 'epic', 0.20: 'legendary' };
// Per-match bot sizing derived from the assigned humans: the MAX equipped count (ceiling for a bot's
// random card count) and the per-slot rarity target (human avg total / 3). Bot card NUMBERS are drawn
// from the whole 200-card album (randomCardNum), not the humans' owned cards, so bots get variety.
function botLoadoutParamsFromHumans(assigned) {
  const humans = (assigned || []).filter((a) => a && a[0]);
  let maxCount = 0;
  for (const a of humans) maxCount = Math.max(maxCount, equippedCount(sanitizeLoadout(a[0].loadout, a[0].cards)));
  return { maxCount, perSlotTarget: humanBuffTarget(assigned) / 3 };
}
// A random bot loadout: k = random 1..maxCount cards (humans equip N -> bot gets 1..N), each dropped in
// a random slot at a rarity roughly matching the humans (a chosen slot is never empty — >= common). Each
// card's NUMBER is drawn RANDOMLY from the full 1..50 album for its rarity (all 200 cards in play), so
// bots no longer just mirror the human's owned cards. Same [s0,s1,s2] shape as sanitizeLoadout, so
// buffsFromLoadout consumes it directly (display == gameplay).
function randomBotLoadout(params) {
  const p = params || {};
  const maxCount = Math.max(0, Math.floor(Number(p.maxCount) || 0));
  const out = [null, null, null];
  if (maxCount < 1) return out; // humans have no cards -> bot has none either
  const perSlotTarget = Math.max(0, Number(p.perSlotTarget) || 0);
  const k = 1 + Math.floor(Math.random() * maxCount); // 1..maxCount
  for (const s of shuffle([0, 1, 2]).slice(0, k)) {
    let pct = pickRarityPct(perSlotTarget);
    if (!pct) pct = 0.03; // a chosen slot always holds a real card (>= common)
    const r = PCT_TO_RARITY[pct] || 'common';
    out[s] = { r, n: randomCardNum() };
  }
  // "Make sense" rule: you cannot have empty slots if you hold a card stronger than RARE. A bot with an
  // epic/legendary must be full — fill every remaining empty slot with a COMMON (e.g. one epic + two
  // commons, never one epic + two empty). A bot whose best card is only common/rare may keep empties.
  const strongRank = CARD_RARITIES.indexOf('rare'); // > rare == epic/legendary
  const topRank = out.reduce((m, s) => (s ? Math.max(m, CARD_RARITIES.indexOf(s.r)) : m), -1);
  if (topRank > strongRank) {
    for (let s = 0; s < 3; s++) if (!out[s]) out[s] = { r: 'common', n: randomCardNum() };
  }
  return out;
}
// EXTREME bots show 3 fixed legendary cards (matching their fixed strong buffs).
function extremeBotLoadout() { return [{ r: 'legendary', n: 1 }, { r: 'legendary', n: 2 }, { r: 'legendary', n: 3 }]; }

// --- Level-based bot cards: a bot's cards reflect ITS OWN level (0..11), not the humans' -----
// `botLoadoutForLevel` + the RARITY_BY_LEVEL ramp + the per-level CARD_POWER_BAND now live in
// shared/bot-buffs.js, beside the rarity→buff table they have to agree with. Two hand-copied
// rarity tables is the exact drift that module exists to stop, and the band needed unit tests
// (test-bot-cards.mjs) that a server-local function could not have.
//
// ⚠️ DEAD CODE ABOVE, verified unreachable, safe to delete — the "size bots to the humans' album"
// subsystem this superseded: `humanBuffTarget`, `botLoadoutParamsFromHumans`, `randomBotBuffs`,
// `randomBotLoadout`, `pickRarityPct`, `RARITY_PCT_STEPS`, `PCT_TO_RARITY`, and the write-only
// `room.botBuffTarget` / `room.botLoadoutParams` (set in startMatch, read by nothing). Left in place
// only to keep this diff off a file other agents are working in — see OPEN_ITEMS.md hygiene.
// A loadout -> the compact [{r,n,c,w}] card list the roster/album UI expects.
function loadoutToCards(loadout) {
  return (Array.isArray(loadout) ? loadout : []).filter(Boolean).map((s) => ({ r: s.r, n: s.n, c: 1, w: 0 }));
}
// #18 — preview the bots that will fill this room's empty slots (team/slot/loadout/cosmetic) so the
// quick-match VS/countdown can show opponent bots + their cards BEFORE kickoff. Mirrors startMatch's
// human team/slot assignment + fillBots' balancing so the (team,slot) keys line up, and reuses the
// same rarity-matching as match time. fillBots then consumes this plan verbatim (preview == match).
function computeBotPlan(room) {
  const humans = [...room.members].filter((m) => !m.inMatch).slice(0, roomMax(room));
  const teamSlots = { A: teamSlotList(roomTeamSize(room)), B: teamSlotList(roomTeamSize(room)) };
  const assigned = [];
  for (const m of humans) { const t = m.team === 'B' ? 'B' : 'A'; if (teamSlots[t].length) assigned.push([m, t, teamSlots[t].shift()]); else assigned.push([m, null, null]); }
  for (const a of assigned) { if (a[1]) continue; const t = teamSlots.A.length ? 'A' : 'B'; a[1] = t; a[2] = teamSlots[t].shift(); }
  const plan = [];
  const countT = (t) => assigned.filter((a) => a[1] === t).length + plan.filter((b) => b.team === t).length;
  const usedT = (t) => new Set([...assigned.filter((a) => a[1] === t).map((a) => a[2]), ...plan.filter((b) => b.team === t).map((b) => b.slot)]);
  const humanT = { A: assigned.some((a) => a[1] === 'A'), B: assigned.some((a) => a[1] === 'B') };
  const lvl = levelAt(room.diffLevel);
  // INVITED bots claim their slots FIRST, keeping the name / level / cards they were invited with.
  // They have to be in the plan (and not merely in room.lobbyBots) because startMatch consumes the
  // reservation list before fillBots runs — the plan is the only thing that survives into the match.
  for (const lb of (room.lobbyBots || [])) {
    if (humans.length + plan.length >= roomMax(room)) break;
    // Keep the side it was invited onto, unless that side is already full — firstFreeSlot() falls back
    // to the LAST index when every slot is taken, and two bots on one slot spawn inside each other.
    const want = lb.team === 'B' || lb.team === 'A' ? lb.team : (countT('A') <= countT('B') ? 'A' : 'B');
    const team = countT(want) < roomTeamSize(room) ? want : (want === 'A' ? 'B' : 'A');
    const slot = firstFreeSlot(usedT(team), roomTeamSize(room));
    const named = Number.isFinite(lb.namedLevel);
    const loadout = named ? lb.loadout : botLoadoutForLevel(room.diffLevel);
    plan.push({ team, slot, loadout, cards: loadoutToCards(loadout), cosmetic: botCosmeticForRoom(room),
      name: lb.name, ...(named ? { namedLevel: lb.namedLevel } : {}) });
  }
  while (humans.length + plan.length < roomMax(room)) {
    const team = countT('A') <= countT('B') ? 'A' : 'B';
    const slot = firstFreeSlot(usedT(team), roomTeamSize(room));
    const sideScalar = humanT[team] ? lvl.partner : lvl.enemy; // this preview-bot's side skill
    const loadout = sideScalar >= 0.95 ? extremeBotLoadout() : botLoadoutForLevel(room.diffLevel);
    plan.push({ team, slot, loadout, cards: loadoutToCards(loadout), cosmetic: botCosmeticForRoom(room) });
  }
  return plan;
}
// Signature of the human roster (+ difficulty) — the bot plan is re-rolled only when this changes, so
// previewed cards stay STABLE across the 5Hz countdown ticks instead of flickering every frame.
function humanSignature(room) {
  const hs = [...room.members].filter((m) => !m.inMatch)
    .map((m) => `${m.id}:${m.team || ''}:${equippedCount(sanitizeLoadout(m.loadout, m.cards))}`).sort();
  // Invited bots belong in the signature too — otherwise inviting or kicking שובל leaves a stale plan
  // (his reserved slot missing, or still held after he's gone).
  const bs = (room.lobbyBots || []).map((b) => `${b.id}:${b.team || ''}:${b.namedLevel ?? ''}`);
  return `${room.diffLevel}|${hs.join(',')}|${bs.join(',')}`;
}
function ensureBotPlan(room) {
  if (!room || room.mode === 'training' || room.phase === 'match') { room.botPlan = null; room.botPlanSig = null; return; }
  const sig = humanSignature(room);
  if (room.botPlanSig === sig && Array.isArray(room.botPlan)) return; // unchanged roster -> keep stable cards
  room.botPlanSig = sig;
  room.botPlan = computeBotPlan(room);
}

// ---------------------------------------------------------------------------
// WebSocket handling
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  let member = null;
  try { req.socket.setNoDelay(true); } catch { /* disable Nagle so tiny 60Hz frames aren't batched */ }
  ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; }); // liveness (see the heartbeat sweep)

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    try {
      if (msg.type === 'join') {
        if (member) return;
        const id = `m-${++memberCounter}`;
        const ident = verifyFootballToken(msg.authToken, FOOTBALL_TOKEN_SECRET);
        // Authenticated → use Pikme identity; guest → typed name, no userId.
        let name = (ident?.nickName || msg.name || 'Player').toString().slice(0, 16);
        let avatar = (ident?.image || msg.avatar || '').toString().slice(0, 400) || null;
        if (avatar && avatar.startsWith('http://')) avatar = 'https://' + avatar.slice(7);
        const cards = sanitizeCards(msg.cards);
        member = { id, ws, userId: ident?.userId || null, name, avatar, cards, loadout: sanitizeLoadout(msg.loadout, cards), cosmetic: normalizeCosmetic(msg.cosmetic), team: 'A', inMatch: false, afk: false, lastInputAt: nowMs(), room: null, pendingRoom: null, friends: [] };
        members.set(ws, member);
        if (member.userId) { onlineByUser.set(member.userId, member); notifyFriendsOfPresence(member.userId); }
        send(ws, { type: 'welcome', id, field: FIELD, chars: CHARACTERS, userId: member.userId });
        send(ws, { type: 'home', online: onlineCount() });
        return;
      }
      if (!member) return;

      // Cosmetic (hero+skin) chosen on the home screen; applied at the next match start.
      if (msg.type === 'setCosmetic') { member.cosmetic = normalizeCosmetic(msg.cosmetic); return; }
      // Card-powers loadout chosen on the home screen; validated vs the member's album,
      // baked into buffs at the next match start.
      if (msg.type === 'setLoadout') { member.loadout = sanitizeLoadout(msg.loadout, member.cards); return; }
      // Album changed mid-session (the app re-injected SALTIZ_CARDS): refresh the member's cards so
      // loadout validation + bot buff-matching use the CURRENT album (was frozen at join until reconnect).
      if (msg.type === 'setCards') { member.cards = sanitizeCards(msg.cards); member.loadout = sanitizeLoadout(member.loadout, member.cards); return; }
      // Both public modes go through the ONE matchmade path (see joinMatchmade). Keep the two
      // legacy msg types — old clients/builds still send them — and route by format.
      if (msg.type === 'quickMatch') { joinMatchmade(member, 'quick', msg.diffLevel, msg.trophies, MM_BUDGET_QUICK_MS); return; }
      if (msg.type === 'goalBrawl') { joinMatchmade(member, 'brawl', msg.diffLevel, msg.trophies, MM_BUDGET_MODE_MS); return; }
      if (msg.type === 'matchmade') { joinMatchmade(member, FORMATS[msg.format] ? msg.format : 'quick', msg.diffLevel, msg.trophies, MM_BUDGET_MODE_MS); return; }
      if (msg.type === 'cancelSearch') { dequeue(member.id); send(member.ws, { type: 'toHome', online: onlineCount() }); return; }
      if (msg.type === 'training') { startTraining(member, msg.diffLevel); return; }
      if (msg.type === 'builderMatch') { startBuilderMatch(member, msg.field, msg.diffLevel); return; }
      if (msg.type === 'botGame') { startBotGame(member, msg.diffLevel); return; }
      if (msg.type === 'spectate') { startSpectate(member, msg.diffLevel); return; }
      // IN-MATCH QUICK CHAT. The wire carries an ID only — never text — and the server validates it
      // against the shared catalogue before relaying. A crafted frame therefore cannot broadcast
      // arbitrary content to the room; the worst it can do is name a word that already exists.
      // Rate limits are enforced HERE, not in the UI, for the same reason: the client's cooldown is a
      // courtesy, this is the rule. Thresholds come from COMMUNICATION_SET.md.
      if (msg.type === 'chat') {
        const r = member.room;
        if (!r || r.phase !== 'match' || !member.inMatch) return;   // no lobby/menu spam
        if (!isChatId(msg.id)) return;                             // unknown id -> dropped silently
        const now = Date.now();
        if (member.chatMuteUntil && now < member.chatMuteUntil) return;
        if (member.chatLastAt && now - member.chatLastAt < CHAT_SEND_GAP_MS) return;
        member.chatBurst = (member.chatBurst || []).filter((t) => now - t < CHAT_BURST_MS);
        if (member.chatBurst.length >= CHAT_BURST_N) { member.chatMuteUntil = now + CHAT_COOLDOWN_MS; return; }
        member.chatBurst.push(now);
        member.chatLastAt = now;
        // Visible to EVERYONE in the room (the user's ask), attributed to the sender's PLAYER id so
        // each client can draw the bubble over the right hero. Spectators included — they are watching
        // the same match. Bots have no ws and are skipped by the readyState check.
        for (const m of r.members) {
          if (!m.inMatch || m.ws.readyState !== m.ws.OPEN) continue;
          send(m.ws, { type: 'chat', pid: member.id, id: msg.id });
        }
        return;
      }
      if (msg.type === 'resetBall') { // training only: recenter the ball on demand
        const r = member.room;
        if (r && r.mode === 'training' && r.phase === 'match') attachBall(r.state);   // 'reset ball' = recentre it, per its own label
        return;
      }
      if (msg.type === 'createRoom') { createPrivateRoom(member); return; }
      if (msg.type === 'joinRoom') { joinPrivateRoom(member, msg.code); return; }
      if (msg.type === 'joinDecision') { // HOST accepts/rejects a pending joiner (host-only, enforced server-side)
        const r = member.room;
        if (!r || !r.isPrivate || r.hostId !== member.id) return;
        const joinerId = (msg.joinerId || '').toString();
        const joiner = r.pending.get(joinerId);
        if (!joiner) return; // already resolved / left
        r.pending.delete(joinerId);
        joiner.pendingRoom = null;
        if (msg.accept && r.members.size < roomMax(r) && r.phase !== 'match') {
          addToRoom(joiner, r);
          trimLobbyBots(r); // a real human takes priority over an invited bot
          send(joiner.ws, { type: 'roomJoined', mode: 'private', code: r.id, host: false });
          broadcastLobby(r); // updated roster to everyone waiting in the room
        } else {
          send(joiner.ws, { type: 'joinRejected', code: r.id, reason: msg.accept ? 'full' : 'rejected' });
        }
        return;
      }
      if (msg.type === 'kick') { // HOST removes an already-joined member (host-only, enforced server-side)
        const r = member.room;
        if (!r || r.hostId !== member.id) return;
        const targetId = (msg.memberId || '').toString();
        if (!targetId || targetId === r.hostId) return; // a host can't kick themselves
        // A "lobby bot" (invited from the friends list) is just a reservation — drop it directly.
        if (targetId.startsWith('lbot-')) {
          const n = r.lobbyBots.length;
          r.lobbyBots = r.lobbyBots.filter((b) => b.id !== targetId);
          if (r.lobbyBots.length !== n) broadcastLobby(r);
          return;
        }
        let target = null;
        for (const t of r.members) if (t.id === targetId) { target = t; break; }
        if (!target) return;
        send(target.ws, { type: 'kicked', code: r.id });
        leaveCurrentRoom(target); // drops them (+ bot backfill if mid-match) and re-broadcasts the lobby
        return;
      }
      if (msg.type === 'setFriends') {
        const list = Array.isArray(msg.friends) ? msg.friends.filter((x) => typeof x === 'string').slice(0, 500) : [];
        member.friends = list;
        sendPresenceTo(member);
        return;
      }
      if (msg.type === 'challenge') {
        const toUserId = (msg.toUserId || '').toString();
        if (!member.userId) { send(ws, { type: 'challengeError', msg: 'לא מחובר' }); return; }
        if (!member.friends.includes(toUserId)) { send(ws, { type: 'challengeError', msg: 'לא חבר' }); return; }
        const target = onlineByUser.get(toUserId);
        if (!target) { send(ws, { type: 'challengeError', msg: 'לא מחובר כרגע' }); return; }
        const challengeId = `c-${++challengeCounter}`;
        challenges.set(challengeId, { fromUserId: member.userId, toUserId });
        send(target.ws, { type: 'challengeReceived', challengeId, fromUserId: member.userId, fromName: member.name });
        send(ws, { type: 'challengeSent', toUserId });
        return;
      }
      if (msg.type === 'challengeRespond') {
        const c = challenges.get((msg.challengeId || '').toString());
        if (!c || c.toUserId !== member.userId) return;
        challenges.delete(msg.challengeId);
        const challenger = onlineByUser.get(c.fromUserId);
        if (!msg.accept) { if (challenger) send(challenger.ws, { type: 'challengeDeclined', byUserId: member.userId }); return; }
        if (!challenger) { send(ws, { type: 'challengeError', msg: 'היריב התנתק' }); return; }
        startChallengeMatch(challenger, member);
        return;
      }
      // Party invite: host invites an ONLINE friend into their private room. No 3-digit code
      // and no host-approval step (the host initiated it — mutual consent, like a challenge).
      if (msg.type === 'inviteFriend') {
        const toUserId = (msg.toUserId || '').toString();
        if (!member.userId) { send(ws, { type: 'partyError', msg: 'לא מחובר' }); return; }
        if (!member.friends.includes(toUserId)) { send(ws, { type: 'partyError', msg: 'לא חבר' }); return; }
        // Ensure I host a private room to invite into (self-heal if I lost/left it).
        let r = member.room;
        if (!r || !r.isPrivate || r.hostId !== member.id) { createPrivateRoom(member); r = member.room; }
        if (!r) { send(ws, { type: 'partyError', msg: 'לא ניתן ליצור חדר' }); return; }
        if (r.phase === 'match') { send(ws, { type: 'partyError', msg: 'המשחק כבר התחיל' }); return; }
        if (r.members.size >= roomMax(r)) { send(ws, { type: 'partyError', msg: 'החדר מלא' }); return; }
        const target = onlineByUser.get(toUserId);
        if (!target) { send(ws, { type: 'partyError', msg: 'החבר לא מחובר' }); return; }
        r.invited.add(toUserId);
        send(target.ws, { type: 'partyInvite', code: r.id, fromUserId: member.userId, fromName: member.name });
        send(ws, { type: 'partyInviteSent', toUserId });
        return;
      }
      if (msg.type === 'partyRespond') {
        if (!msg.accept) return; // decline: nothing to clean up (nothing joined yet)
        const r = rooms.get(normalizeRoomCode(msg.code));
        if (!r || !r.isPrivate) { send(ws, { type: 'partyError', msg: 'החדר לא נמצא' }); return; }
        if (!member.userId || !r.invited.has(member.userId)) { send(ws, { type: 'partyError', msg: 'ההזמנה פגה' }); return; }
        if (r.phase === 'match') { send(ws, { type: 'partyError', msg: 'המשחק כבר התחיל' }); return; }
        if (r.members.size >= roomMax(r)) { send(ws, { type: 'partyError', msg: 'החדר מלא' }); return; }
        leaveCurrentRoom(member);            // drop any current room / pending request first
        addToRoom(member, r);                // AUTO-admit — the host invited them
        trimLobbyBots(r);                    // a real human takes priority over an invited bot
        send(ws, { type: 'roomJoined', mode: 'private', code: r.id, host: false });
        const host = hostMember(r);
        if (host) send(host.ws, { type: 'partyInviteAccepted', name: member.name });
        broadcastLobby(r);
        return;
      }
      // Add a BOT to the party (invited from the friends list). Host-only; shows in the lobby
      // and becomes a match bot at kickoff (fillBots). name is the friend-list bot's display name.
      //
      // `botId` names one of the four SALTIZ house bots (shared/saltiz-bots.js). When it resolves, the
      // bot brings its OWN level and its own 3 cards into the match instead of inheriting the room's
      // difficulty — שובל is genuinely hard, אורי genuinely easy. Level and cards are looked up from
      // the shared roster, never taken from the message: a client that could state its opponent's
      // difficulty could order itself a free win. An unknown/absent botId keeps the old behaviour
      // (a generic bot at room difficulty), so older clients are unaffected.
      if (msg.type === 'addBot') {
        const r = member.room;
        if (!r || !r.isPrivate || r.hostId !== member.id) return;
        if (r.phase === 'match') { send(ws, { type: 'partyError', msg: 'המשחק כבר התחיל' }); return; }
        if (r.members.size + r.lobbyBots.length >= roomMax(r)) { send(ws, { type: 'partyError', msg: 'החדר מלא' }); return; }
        const named = SALTIZ_BOT_BY_ID.get((msg.botId || '').toString());
        const name = named ? named.nickName : (msg.name || 'בוט').toString().slice(0, 24);
        const entry = { id: `lbot-${r.id}-${++r.botCounter}`, name, team: balancedTeam(r) };
        if (named) {
          entry.namedLevel = botLevelOf(named);          // 0-based difficulty index (רמה − 1)
          entry.loadout = saltizBotLoadout(named);       // same seeded roll the friend card drew
          entry.cards = loadoutToCards(entry.loadout);
        }
        r.lobbyBots.push(entry);
        broadcastLobby(r);
        return;
      }
      if (msg.type === 'leaveRoom') {
        dequeue(member.id);
        leaveCurrentRoom(member);
        send(ws, { type: 'toHome', online: onlineCount() });
        return;
      }

      const room = member.room;
      if (msg.type === 'setTeam') {
        // Team picking only in a private room's lobby.
        if (!room || !room.isPrivate || member.inMatch || room.phase === 'match') return;
        if (msg.team === 'A' || msg.team === 'B') {
          // A SIDE HOLDS teamSize, NO MORE. Nothing enforced this: at 2v2 the roster was small enough
          // that it never showed, but a 3v3 party could put five members on team A and the match then
          // started with one side over-filled and slots stolen from the other.
          const size = roomTeamSize(room);
          const onTeam = [...room.members].filter((q) => q !== member && q.team === msg.team).length
            + (room.lobbyBots || []).filter((b) => b.team === msg.team).length;
          if (onTeam >= size) { send(ws, { type: 'partyError', msg: `קבוצה זו מלאה (${size})` }); return; }
          member.team = msg.team; broadcastLobby(room);
        }
        return;
      }
      // THE HOST'S GAME PICK, APPLIED TO THE ROOM (not just remembered by their client).
      // `ready` already resolves the card to a format, but only at match start — and a room's
      // CAPACITY is teamSize x 2, so until the format landed a party physically could not seat more
      // than 4 people. Picking 3v3 and then inviting five friends failed on "החדר מלא" with no way to
      // tell why. Now the pick lands here the moment it is made, so roomMax grows with it and every
      // member's lobby shows the mode and the new capacity.
      if (msg.type === 'partyGame') {
        if (!room || !room.isPrivate) { send(ws, { type: 'partyError', msg: 'החדר לא נמצא' }); return; }
        if (room.hostId && room.hostId !== member.id) { send(ws, { type: 'partyError', msg: 'רק המארח בוחר משחק' }); return; }
        if (room.phase !== 'lobby') { send(ws, { type: 'partyError', msg: 'המשחק כבר התחיל' }); return; }
        const mode = formatForCard(msg.game);
        const fmt = FORMATS[mode] || FORMATS.quick;
        // SHRINKING is the case that can strand people: 6 in the room and the host taps 2v2. Refuse
        // rather than silently dropping whoever is last in the Set — the host can remove a member and
        // pick again. GROWING is always safe.
        const seated = room.members.size + (room.lobbyBots || []).length;
        if (seated > fmt.teamSize * 2) {
          send(ws, { type: 'partyError', msg: `יש ${seated} שחקנים — צריך לצמצם ל-${fmt.teamSize * 2}` });
          return;
        }
        applyFormat(room, mode);
        room.game = msg.game || null;      // the CARD id, so every client can show the same pick
        broadcastLobby(room);
        return;
      }
      // ---- TEAM-PAGE CHAT: the IN-MATCH vocabulary, plus up to 40 characters of free text --------
      // Deliberately the same catalogue as the in-game wheel (shared/quick-chat.js: 8 calls + 8
      // emotes), not the friend-thread presets — a lobby is a moment before a match, so "פס!" and a
      // thumbs-up are the right words and «בוא נתאמן» is not. Same wire shape as the in-game chat too:
      // an ID is relayed and the words are looked up on receipt, so a crafted frame cannot broadcast
      // arbitrary text. FREE TEXT is the one exception and it is private-rooms-only (FREE_TEXT_ROOMS).
      // The in-game anti-spam numbers are reused rather than reinvented: one send per 1.5s, and three
      // in six seconds earns a 5s cooldown.
      if (msg.type === 'partyChat') {
        if (!room) return;
        const now = nowMs();
        if (member.chatMuteUntil && now < member.chatMuteUntil) return;
        if (member.lastChatAt && now - member.lastChatAt < CHAT_SEND_GAP_MS) return;
        member.chatBurstLobby = (member.chatBurstLobby || []).filter((t) => now - t < CHAT_BURST_MS);
        if (member.chatBurstLobby.length >= CHAT_BURST_N) { member.chatMuteUntil = now + CHAT_COOLDOWN_MS; return; }
        let text = '', chatId = null;
        if (msg.chatId) {
          const item = chatById(String(msg.chatId));
          if (!item) return;                                     // unknown id (newer client) — ignore
          chatId = item.id;
          text = item.kind === 'word' ? item.text : '';          // an emote has no words: the client draws the sprite
        } else {
          const kind = room.isPrivate ? 'private' : 'public';
          if (!FREE_TEXT_ROOMS.includes(kind)) { send(ws, { type: 'partyError', msg: 'אין צ׳אט חופשי במשחק ציבורי' }); return; }
          text = sanitizeFreeText(msg.text);
          if (!text) return;                                     // empty after sanitizing — drop it
        }
        member.chatBurstLobby.push(now);
        member.lastChatAt = now;
        member.chat = { text, chatId, at: now };
        broadcastLobby(room);
        return;
      }
      if (msg.type === 'ready') { // "Play Now" in a private room
        if (!room || member.inMatch) return;
        // The party / game-select pickers set `game` (a MODES card id); until now it was
        // client-only state, so a private room ALWAYS played first-to-3 no matter which card was
        // tapped. Resolve the card to a FORMATS row so a private room honours the FULL format —
        // win rule AND team size AND arena. Reading only `=== 'brawl'` meant a host who picked
        // 3v3 silently got a 4-player first-to-3 match.
        if (msg.game) applyFormat(room, formatForCard(msg.game));
        if (room.phase === 'lobby') startCountdown(room);
        return;
      }
      if (msg.type === 'input') {
        if (!room || !member.inMatch) return;
        const active = (Math.abs(msg.moveX || 0) + Math.abs(msg.moveY || 0) > 0.1) || !!msg.hold || !!msg.fire || !!msg.special || !!msg.build || !!msg.buildHold;
        if (active) {
          member.lastInputAt = nowMs();
          if (member.afk) {
            member.afk = false;
            const p = room.state.players[member.id];
            if (p) {
              p.isBot = false;
              // While AFK, bot-ai drove this human and set the DIFFICULTY multipliers (chargeRate/cdMul).
              // Strip them so the returning human has no bot difficulty; their CARD buffs (cardShot/
              // cardUtil/speedBuff) were never touched by bot-ai, so they persist untouched.
              p.chargeRate = 1; p.cdMul = 1;
            }
          }
        }
        const prev = room.inputs.get(member.id) || {};
        // Several packets can land between two ticks (the client edge-flushes every action), so
        // they merge into one input. Each action EDGE locks the payload it arrived with — see
        // shared/input-merge.js for why (it's the same class of bug three times over: the shot
        // aim, the lob vector, and the wall's aim + push distance).
        room.inputs.set(member.id, coalesceInput(prev, msg));
        return;
      }
      if (msg.type === 'settings' && room) {
        if (msg.settings) applySettings(room, msg.settings);
        // Difficulty LADDER — a level index that sets enemy + partner skill. Legacy clients may still
        // send a string tier; bridge it to a level index.
        const wanted = msg.diffLevel != null ? clampLevel(msg.diffLevel)
          : (['easy', 'normal', 'hard', 'extreme'].includes(msg.botDifficulty) ? levelFromLegacy(msg.botDifficulty) : null);
        // Only where a live change is legitimate (see canSetDiffLive) — and only when it's a real
        // change, so a repeated settings frame can't reroll bot cards on every keystroke.
        if (wanted != null && canSetDiffLive(room) && wanted !== clampLevel(room.diffLevel)) {
          room.diffLevel = wanted;
          if (room.botMem) applyTeamSkill(room); // skill applies live (also re-applied each tick)
          relevelBots(room);                     // ...and so must the CARD BUFFS + the dossier
          broadcastBots(room);                   // every client in the room sees the new truth
        }
        return;
      }
      if (msg.type === 'ping') { send(ws, { type: 'pong', t: msg.t }); return; }
    } catch (e) { if (msgErrCount++ < 5) console.error('MSG ERROR:', (e && e.stack) || e); }
  });

  ws.on('close', () => {
    if (!member) return;
    members.delete(ws);
    dequeue(member.id);
    if (member.userId && onlineByUser.get(member.userId) === member) {
      onlineByUser.delete(member.userId);
      notifyFriendsOfPresence(member.userId);
    }
    leaveCurrentRoom(member);
  });
});

server.listen(PORT, () => {
  console.log(`\n⚽ Football mock running:`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   Home -> Quick Match (public room) or Play With Friends (private code room).\n`);
});
