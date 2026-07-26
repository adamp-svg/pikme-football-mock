// IN-MATCH QUICK CHAT — the one catalogue both sides agree on.
//
// Shared on purpose: the server must validate what it relays. If the list lived only in the client,
// a crafted socket frame could broadcast arbitrary text to every player in the room — the same shape
// of hole as the record-match one that was closed on 2026-07-26 (it trusted req.body). The wire
// carries an ID and nothing else; the words live here and are looked up on receipt.
//
// Content is per the user's choice (2026-07-26): 8 short Hebrew calls + 8 of the social emotes drawn
// for exactly this, all visible to EVERY player. codex's asset spec
// (assets/pixel-icon-system-01/expansion-64/COMMUNICATION_SET.md) also defines a TEAM-ONLY tactical
// wheel (call-pass / call-shoot / …). That is deliberately NOT here: it needs team-scoped delivery and
// a directional HUD ping, and shipping it as "visible to all" would leak your own tactics.
//
// The existing shared/quick-messages.js presets are for FRIEND THREADS and are wrong mid-match
// («להתראות!», «בוא נתאמן»), which is why this is a separate, shorter vocabulary.

// Words. Kept to 1-2 tokens: a bubble has ~2.2s to be read while you are also playing.
export const CHAT_WORDS = [
  { id: 'w_pass',  text: 'פס!' },
  { id: 'w_shoot', text: 'שוט!' },
  { id: 'w_guard', text: 'שמור!' },
  { id: 'w_go',    text: 'קדימה!' },
  { id: 'w_nice',  text: 'יפה!' },
  { id: 'w_sorry', text: 'מצטער' },
  { id: 'w_thanks',text: 'תודה!' },
  { id: 'w_oops',  text: 'אופס' },
];

// Emotes. `icon` is the semantic id from the pack's manifest; `col`/`row` are its cell in the COMBINED
// 160-asset sheet (expansion-64/sprite-pack-160.webp), which is a 16x10 grid of 128px cells ordered
// "the original 96 first, then the 64 expansion" per that pack's README. Resolved once here rather
// than parsed at runtime, and pinned by test-quick-chat.mjs against the real manifests so a re-cut of
// the sheet cannot silently point these at the wrong art.
export const CHAT_EMOTES = [
  { id: 'e_wave',      icon: 'emote-wave',       col: 0,  row: 8 },
  { id: 'e_thumbsup',  icon: 'emote-thumbs-up',  col: 1,  row: 8 },
  { id: 'e_clap',      icon: 'emote-clap',       col: 2,  row: 8 },
  { id: 'e_heart',     icon: 'emote-heart',      col: 3,  row: 8 },
  { id: 'e_celebrate', icon: 'emote-celebrate',  col: 7,  row: 8 },
  { id: 'e_laugh',     icon: 'emote-laugh',      col: 8,  row: 8 },
  { id: 'e_wow',       icon: 'emote-wow',        col: 9,  row: 8 },
  { id: 'e_fire',      icon: 'emote-fire',       col: 14, row: 8 },
];

export const CHAT_SHEET = {
  url: '/assets/pixel-icon-system-01/expansion-64/sprite-pack-160.webp?v=1',
  cols: 16, rows: 10, cell: 128,
};

// Display + anti-spam, straight from COMMUNICATION_SET.md's "Display behavior" section.
export const CHAT_BUBBLE_MS = 2200;   // "Show an emote above the player for about 2.2 seconds"
export const CHAT_SEND_GAP_MS = 1500; // "Allow one send every 1.5 seconds"
export const CHAT_BURST_N = 3;        // "After three sends in six seconds, apply a short cooldown"
export const CHAT_BURST_MS = 6000;
export const CHAT_COOLDOWN_MS = 5000;

const BY_ID = new Map();
for (const w of CHAT_WORDS) BY_ID.set(w.id, { kind: 'word', ...w });
for (const e of CHAT_EMOTES) BY_ID.set(e.id, { kind: 'emote', ...e });

/** The catalogue entry for an id, or null. Null means "do not relay" — never a fallback. */
export function chatById(id) {
  return (typeof id === 'string' && BY_ID.get(id)) || null;
}
export function isChatId(id) { return BY_ID.has(id); }
export const CHAT_IDS = [...BY_ID.keys()];
