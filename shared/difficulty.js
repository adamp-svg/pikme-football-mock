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

// enemy = the all-bot opposing team; partner = the bot(s) on the human's team.
export const DIFFICULTY_LEVELS = [
  { id: 0,  name: 'אימון',   hint: 'אויב חלש · שותף חלש',   enemy: T.veryEasy, partner: T.veryEasy }, // tutorial
  { id: 1,  name: 'שלב 1',   hint: 'אויב חלש · שותף קל',    enemy: T.veryEasy, partner: T.easy },
  { id: 2,  name: 'שלב 2',   hint: 'אויב קל · שותף חזק',    enemy: T.easy,     partner: T.harder },
  { id: 3,  name: 'שלב 3',   hint: 'אויב קל · שותף קל',     enemy: T.easy,     partner: T.easy },
  { id: 4,  name: 'שלב 4',   hint: 'אויב קל · שותף חלש',    enemy: T.easy,     partner: T.veryEasy },
  { id: 5,  name: 'שלב 5',   hint: 'רגיל · שותף רגיל',      enemy: T.normal,   partner: T.normal },
  { id: 6,  name: 'שלב 6',   hint: 'רגיל · שותף קל',        enemy: T.normal,   partner: T.easy },
  { id: 7,  name: 'שלב 7',   hint: 'קשה · שותף רגיל',       enemy: T.harder,   partner: T.normal },
  { id: 8,  name: 'שלב 8',   hint: 'קשה · שותף קל',         enemy: T.hard,     partner: T.easy },
  { id: 9,  name: 'שלב 9',   hint: 'קשה מאוד · שותף רגיל',  enemy: T.veryHard, partner: T.normal },
  { id: 10, name: 'שלב 10',  hint: 'קטלני · שותף קשה',      enemy: T.extreme,  partner: T.hard },
  { id: 11, name: 'קטלני',   hint: 'קטלני · שותף קל',       enemy: T.extreme,  partner: T.easy },
];

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
