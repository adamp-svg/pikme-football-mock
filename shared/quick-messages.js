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

// ---- FREE TEXT — PARTY ROOMS ONLY -------------------------------------------------------------
// The header of this file says free text was deliberately excluded so there would be nothing to
// moderate. That still holds for PUBLIC matchmade rooms and for friend threads. A PRIVATE party room
// is a different audience: everyone in it was invited by the host out of their own friends list, so
// the only people who can read your message are people you chose. The product decision (2026-07-26)
// is therefore "free text in party rooms, presets everywhere else", and `FREE_TEXT_ROOMS` is the one
// place that policy is written down — the server refuses free text for any other room kind.
//
// ONE SHARED SANITIZER, so the composer's live counter and the server's validation can never
// disagree about what "40 characters" means:
//   * length is counted in CODE POINTS, not UTF-16 units, so an emoji is one character rather than
//     two — a 40-char limit that allowed 20 emoji and then sliced one in half mid-surrogate would
//     put a lone surrogate on the wire and render as a replacement box;
//   * control characters, line breaks and the zero-width/bidi-override range are stripped: this is a
//     one-line bubble, and U+202E in a nickname-adjacent string is a display attack, not a message;
//   * runs of whitespace collapse, so a message cannot be padded out to shove the layout around.
// Returns '' for anything not worth sending; callers treat '' as "drop it".
export const FREE_TEXT_MAX = 40;
export const FREE_TEXT_ROOMS = ['private'];

const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\u2028\u2029\ufeff]/g;

export function sanitizeFreeText(raw) {
  if (typeof raw !== 'string') return '';
  const collapsed = raw.replace(UNSAFE_CHARS, ' ').replace(/\s+/g, ' ').trim();
  const points = Array.from(collapsed);
  return points.length > FREE_TEXT_MAX ? points.slice(0, FREE_TEXT_MAX).join('') : collapsed;
}
// Characters still available, counted the same way the sanitizer counts them.
export function freeTextLeft(raw) {
  return FREE_TEXT_MAX - Array.from(sanitizeFreeText(raw)).length;
}
