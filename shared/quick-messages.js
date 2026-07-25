// Preset quick-messages for friend threads. There is deliberately NO free text in the game —
// players pick from this list, so there is nothing to moderate.
//
// The backend stores ONLY the phrase `id` (an opaque string), never the Hebrew wording. That means
// phrases can be added, reworded or reordered with a game deploy and no backend deploy — and an old
// client that doesn't know a new id simply skips that message instead of rendering garbage.
//
// Every id must match PRESET_ID_RE (the same shape pikme-server validates on send).

export const PRESET_ID_RE = /^[a-z0-9_]{1,24}$/;

// Shown as tabs in the composer, in this order.
export const QUICK_GROUPS = [
  {
    id: 'greet',
    name: 'ברכות',
    phrases: [
      { id: 'greet_hi', text: 'היי! 👋' },
      { id: 'greet_how', text: 'מה נשמע?' },
      { id: 'greet_bye', text: 'להתראות!' },
      { id: 'greet_respect', text: 'אחרי כבוד' },
    ],
  },
  {
    id: 'play',
    name: 'משחק',
    phrases: [
      { id: 'play_lets', text: 'בוא נשחק!' },
      { id: 'play_train', text: 'בוא נתאמן' },
      { id: 'play_ready', text: 'מוכן?' },
      { id: 'play_onemore', text: 'עוד משחק אחד' },
    ],
  },
  {
    id: 'praise',
    name: 'שבחים',
    phrases: [
      { id: 'praise_wd', text: 'כל הכבוד!' },
      { id: 'praise_goal', text: 'איזה שער! ⚽' },
      { id: 'praise_gg', text: 'משחק טוב' },
      { id: 'praise_champ', text: 'אלוף! 🏆' },
    ],
  },
  {
    id: 'react',
    name: 'תגובות',
    phrases: [
      { id: 'react_thanks', text: 'תודה!' },
      { id: 'react_noway', text: 'חבל על הזמן' },
      { id: 'react_ok', text: 'אוקי' },
      { id: 'react_lol', text: 'חחח 😂' },
      { id: 'react_wow', text: 'ואו! 🔥' },
    ],
  },
];

export const QUICK_PHRASES = QUICK_GROUPS.flatMap((g) => g.phrases);

const BY_ID = new Map(QUICK_PHRASES.map((p) => [p.id, p]));

// null for an id this build doesn't know (newer sender, older client) — callers skip those.
export function phraseById(id) {
  return BY_ID.get(id) || null;
}

// Emoji a player can react to a single message with. Kept short so the reaction bar fits one row
// on a phone. Stored verbatim by the backend, which validates membership in this set.
export const REACTION_EMOJI = ['👍', '🔥', '😂', '⚽', '🏆'];

export function isReactionEmoji(e) {
  return REACTION_EMOJI.indexOf(e) >= 0;
}
