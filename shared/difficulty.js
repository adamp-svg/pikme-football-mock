// Difficulty ladder — shared by the client (level picker) and server (bot skill mapping).
//
// Skill is a FLUENT 0..1 scalar per side (see skillVec in bot-ai.js): 0 = tutorial-weak,
// 0.5 ≈ the old "normal", 1 = the EXTREME cheat tier. Each LEVEL sets the ENEMY side and the
// PARTNER side independently, so difficulty can shape "how tough the enemy is" separately from
// "how much my team-mate helps". The ladder is ordered easiest→hardest overall and is the single
// source both ends read, so it can later be matched to game progression (player level → diffLevel).

// Named scalar stops on the 0..1 skill axis (just for readable level definitions below).
export const T = {
  veryEasy: 0.05,   // barely moves — tutorial fodder
  easy:     0.25,
  normal:   0.50,
  harder:   0.68,
  hard:     0.82,
  veryHard: 0.92,
  extreme:  1.00,   // cheat tier
};

// A 0..1 skill scalar -> the word the settings readout shows for that bot. Lives here, beside the
// T stops it reads, so a retune of the ladder can't leave the labels describing the old numbers.
// Ordered easiest-first; the first stop the scalar fits into wins.
const SKILL_WORDS = [
  [T.veryEasy, 'חלש מאוד'], [T.easy, 'קל'], [T.normal, 'רגיל'], [T.harder, 'חזק'],
  [T.hard, 'קשה'], [T.veryHard, 'קשה מאוד'], [T.extreme, 'קטלני'],
];
export function skillWord(scalar) {
  const s = Math.max(0, Math.min(1, Number(scalar) || 0));
  for (const [stop, word] of SKILL_WORDS) if (s <= stop + 1e-9) return word;
  return 'קטלני';
}

// enemy = the all-bot opposing team; partner = the bot(s) on the human's team.
//
// RE-CUT 2026-07-26 against MEASURED player-felt difficulty (test-bot-levels.mjs), which models
// what a player actually meets: [human-proxy + partner] vs [two enemies], scored by the player
// side's goal differential. The previous table was cut when the underlying skill ladder was
// INVERTED, and it showed:
//     L2 (enemy 0.25 / partner 0.68) was the EASIEST LEVEL IN THE GAME at +0.75 goals/match —
//     easier than L0 (+0.22) — because its partner helped the player more than its enemy hurt.
//     L1 (-0.03) was harder than L3 (+0.09) and L4 (+0.19); L9 (+0.16) was easier than L8 (-0.38).
//     Spearman(level, felt) was -0.66 with a +0.78 backwards cliff at L2.
// The enemy column being sorted proved nothing, because a level sets TWO scalars and the partner
// was swinging 0.05 -> 0.68 -> 0.05 underneath it.
//
// THE RULE THIS TABLE NOW FOLLOWS: both sides improve as you climb — your team-mate genuinely gets
// better, which is what progression should feel like — but the ENEMY improves FASTER, so the net
// is monotonically harder. Enemy +~0.086/level, partner +~0.057/level.
// bot-buffs.js EXTREME_SKILL (0.95) gates the fixed strong bot loadout, so only L11's enemy now
// sits above that line; L10 previously did too, which is part of why 10 and 11 felt identical.
// The partner ARCS: it rises to a competent 0.50 by the middle of the ladder and then eases back,
// while the enemy keeps climbing to 1.00. A first attempt had both rise together (+0.086/level
// enemy, +0.057 partner) and MEASURED almost flat — the whole felt range across all 12 levels was
// 0.54 goals/match, because a better team-mate kept cancelling a better enemy. The arc is what
// gives the late levels their teeth: your team-mate is good, but the opposition outgrows them.
const LEVEL_PAIRS = [
  // [enemy, partner]
  [0.05, 0.10], [0.13, 0.18], [0.22, 0.26], [0.31, 0.34],
  [0.40, 0.42], [0.49, 0.48], [0.58, 0.50], [0.67, 0.50],
  [0.76, 0.48], [0.85, 0.45], [0.93, 0.42], [1.00, 0.38],
];
const LEVEL_NAMES = ['אימון', 'שלב 1', 'שלב 2', 'שלב 3', 'שלב 4', 'שלב 5',
                     'שלב 6', 'שלב 7', 'שלב 8', 'שלב 9', 'שלב 10', 'קטלני'];
// The hint is GENERATED from the scalars, never hand-written. Hand-written hints had already
// drifted from the numbers they describe, and a retune silently leaves them lying.
export const DIFFICULTY_LEVELS = LEVEL_PAIRS.map(([enemy, partner], id) => ({
  id, name: LEVEL_NAMES[id], enemy, partner,
  hint: `אויב ${skillWord(enemy)} · שותף ${skillWord(partner)}`,
}));

export const DEFAULT_LEVEL = 5; // "normal / normal" — matches the old default feel

export function clampLevel(i) {
  i = Math.round(Number(i));
  if (!Number.isFinite(i)) return DEFAULT_LEVEL;
  return Math.max(0, Math.min(DIFFICULTY_LEVELS.length - 1, i));
}
export function levelAt(i) { return DIFFICULTY_LEVELS[clampLevel(i)]; }

// Legacy bridge: map an old string tier (easy/normal/hard/extreme) to a level index, so a
// stale client that still sends { botDifficulty } keeps working.
export function levelFromLegacy(tier) {
  const idx = { easy: 3, normal: 5, hard: 8, extreme: 11 }[tier];
  return idx == null ? DEFAULT_LEVEL : idx;
}

// --- XP-driven bot level (Task: bots reflect player XP) --------------------------------
// Player XP -> football level, per the experience-agent spec shared with the hub XP bar:
// level = floor((1+sqrt(1+xp/12.5))/2), min 1. Kept here so client + server agree.
export function playerLevelFromXp(xp) {
  return Math.max(1, Math.floor((1 + Math.sqrt(1 + Math.max(0, Number(xp) || 0) / 12.5)) / 2));
}
// Bot difficulty level (0..11) derived from the player's XP. Player level 1 (xp 0) => bot
// level 0, so bots "start at level 0" and climb with the player, capping at 11 (the bot
// stops progressing once the player passes it). TUNABLE: change the -1 offset / cap here.
export function botLevelFromXp(xp) {
  return clampLevel(playerLevelFromXp(xp) - 1);
}
// Representative XP for a bot at level L, shown in the countdown lobby. A bot at level L is
// the player-equivalent of level (L+1); its XP is that level's start (base = 50*p*(p-1)),
// matching the hub XP-bar math. So the badge reads like a real player of comparable XP.
export function xpForBotLevel(level) {
  const p = clampLevel(level) + 1; // player-equivalent level
  return 50 * p * (p - 1);
}
// The רמה (level number) shown for a bot at difficulty level L — the player-equivalent level.
export function displayLevelForBot(level) { return clampLevel(level) + 1; }
