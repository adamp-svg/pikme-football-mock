// THE NAMED SALTIZ BOTS — the four house players you can add as FRIENDS.
//
// They are not real users: they have no Pikme account, no phone, no presence socket. So this file is
// their whole identity, shared by BOTH ends on purpose:
//   • public/client.js  — searches them by name in the add-friend tab, and draws their friend card
//                         (level + the 3 power slots).
//   • server.js         — resolves an `addBot { botId }` to the level it PLAYS at, and to the cards
//                         it plays WITH.
// The client never sends the level or the cards; it sends the id and the server looks them up here.
// A client that could name its own opponent's difficulty is a client that can pick a free win.
//
// `level` is the DISPLAY level (רמה N) the friend card shows — the player-equivalent number, same
// convention as displayLevelForBot() in shared/difficulty.js. The bot-difficulty index used by
// RARITY_BY_LEVEL / levelAt() is one lower, which is what botLevelOf() returns. Getting those two
// confused is the difference between שובל playing at the top of the ladder and playing one rung down.
import { botLoadoutForLevel } from './bot-buffs.js';
import { clampLevel } from './difficulty.js';

export const SALTIZ_BOTS = [
  { id: 'saltiz-uri', nickName: 'אורי', level: 5, color: '#4ea0ff' },
  { id: 'saltiz-paz', nickName: 'פז', level: 7, color: '#f0a934' },
  { id: 'saltiz-nave', nickName: 'נווה', level: 8, color: '#b46bff' },
  { id: 'saltiz-shuval', nickName: 'שובל', level: 11, color: '#e0556b' },
];

export const SALTIZ_BOT_BY_ID = new Map(SALTIZ_BOTS.map((b) => [b.id, b]));

// Display רמה → the 0-based difficulty index everything else keys on.
export function botLevelOf(bot) { return clampLevel((bot && bot.level ? bot.level : 1) - 1); }

// The XP number the friend card prints, on the same triangular curve as a human's
// (cumulative XP to reach level L = 50·L·(L−1)) so "רמה 8 · 2.8K XP" reads like a real player.
export function xpForSaltizBot(bot) {
  const L = Math.max(1, Math.round(Number(bot && bot.level) || 1));
  return 50 * L * (L - 1);
}

// ── The 3 power slots ────────────────────────────────────────────────────────────────────────────
// Rolled from the bot's OWN level through the shared ramp (RARITY_BY_LEVEL + CARD_POWER_BAND), so a
// level-5 bot carries level-5 cards and level-11 carries three legendaries — the same roll a match
// bot at that level gets, nothing hand-written.
//
// The roll is RANDOM but SEEDED from the bot's id, which makes it stable: a friend's album must not
// reshuffle every time the list repaints, and — the load-bearing half — the client and the server
// roll the SAME three cards from the same seed. That is what keeps "display == gameplay" true here
// without the client ever being trusted to state its opponent's cards.
// TUNABLE: mix the seed with a season/day if these should ever rotate.
function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function saltizBotLoadout(bot) {
  if (!bot) return [null, null, null];
  return botLoadoutForLevel(botLevelOf(bot), mulberry32(hash32(String(bot.id))));
}

// Name match for the add-friend search box. Substring + case-insensitive, mirroring the server's
// nickName search (routes-pikme/friends.js), so typing "פז" or "שוב" finds them. Hebrew has no
// case, but the app also ships Latin nicknames, so lowercase both sides anyway.
export function searchSaltizBots(q) {
  const s = String(q || '').trim().toLowerCase();
  if (s.length < 1) return [];
  return SALTIZ_BOTS.filter((b) => b.nickName.toLowerCase().includes(s) || b.id.includes(s));
}

// Generated names for the slots the four named bots cannot cover. A 3v3 can need five bots at an
// arbitrary level, and reusing a named bot at the wrong level would contradict the friend card the
// player was shown.
const BOT_NAME_POOL = ['יואב', 'מאיה', 'איתי', 'רוני', 'גיא', 'תמר', 'עומר', 'ליאור', 'נועם', 'שירה', 'אלון', 'דנה'];

// Tiny string hash -> a stable per-room sequence. Seeded from the room id so the VS screen's preview
// and the bots that actually spawn are the same identities (the preview==match rule the countdown
// already relies on for cards).
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < String(str).length; i++) { h ^= String(str).charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/**
 * `count` bot identities for a room at difficulty `botLevel` (0..11), stable for `seed`.
 * A named saltiz bot is used when its own level is within 1 of the room's; otherwise a generated
 * name, so a level-0 room never fields שובל.
 */
export function pickBotIdentities(count, botLevel, seed) {
  const n = Math.max(0, count | 0);
  const out = [];
  const used = new Set();
  const fits = SALTIZ_BOTS
    .filter((b) => Math.abs(botLevelOf(b) - botLevel) <= 1)
    .sort((a, b) => Math.abs(botLevelOf(a) - botLevel) - Math.abs(botLevelOf(b) - botLevel));
  let h = hash(seed);
  const next = () => { h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0; return h; };
  for (let i = 0; i < n; i++) {
    const named = fits.find((b) => !used.has(b.nickName));
    if (named) { used.add(named.nickName); out.push({ name: named.nickName, isSaltiz: true, level: botLevel, botId: named.id }); continue; }
    let name = null;
    for (let tries = 0; tries < BOT_NAME_POOL.length && !name; tries++) {
      const cand = BOT_NAME_POOL[next() % BOT_NAME_POOL.length];
      if (!used.has(cand)) name = cand;
    }
    if (!name) name = `${BOT_NAME_POOL[0]} ${i + 1}`; // pool exhausted (needs >12 bots) — still unique
    used.add(name);
    out.push({ name, isSaltiz: false, level: botLevel, botId: null });
  }
  return out;
}
