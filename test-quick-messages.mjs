// The quick-message catalogue is a wire contract: pikme-server stores phrase IDs, so an id that
// doesn't match PRESET_ID_RE is silently rejected on send, and a duplicate id makes two different
// phrases render as one. Both are invisible in the UI until a real user hits them — assert here.
import { QUICK_GROUPS, QUICK_PHRASES, PRESET_ID_RE, phraseById, REACTION_EMOJI, isReactionEmoji } from './shared/quick-messages.js';

let fails = 0, ran = 0;
const ok = (c, m) => { ran++; console.log((c ? 'PASS' : 'FAIL') + '  ' + m); if (!c) fails++; };

ok(QUICK_GROUPS.length > 0, 'there is at least one group');
ok(QUICK_PHRASES.length === QUICK_GROUPS.reduce((n, g) => n + g.phrases.length, 0), 'QUICK_PHRASES is the flattened groups');

// Every id must survive the server's validation regex.
const badId = QUICK_PHRASES.filter((p) => !PRESET_ID_RE.test(p.id));
ok(badId.length === 0, `every phrase id matches PRESET_ID_RE${badId.length ? ' — bad: ' + badId.map((p) => p.id).join(', ') : ''}`);

const badGroup = QUICK_GROUPS.filter((g) => !PRESET_ID_RE.test(g.id));
ok(badGroup.length === 0, 'every group id matches PRESET_ID_RE');

// Duplicate ids would collapse two phrases into one on lookup.
const ids = QUICK_PHRASES.map((p) => p.id);
ok(new Set(ids).size === ids.length, 'phrase ids are unique');
ok(new Set(QUICK_GROUPS.map((g) => g.id)).size === QUICK_GROUPS.length, 'group ids are unique');

// Text is what the player sees — an empty one renders a blank bubble.
ok(QUICK_PHRASES.every((p) => typeof p.text === 'string' && p.text.trim().length > 0), 'every phrase has non-empty text');
ok(QUICK_GROUPS.every((g) => typeof g.name === 'string' && g.name.trim().length > 0), 'every group has a name');
ok(QUICK_GROUPS.every((g) => g.phrases.length > 0), 'no empty group (an empty composer tab)');

// Lookup: known id resolves, unknown id is null (NOT undefined-crash) so old clients skip cleanly.
ok(phraseById(QUICK_PHRASES[0].id) === QUICK_PHRASES[0], 'phraseById resolves a known id');
ok(phraseById('phrase_from_the_future') === null, 'phraseById returns null for an unknown id');
ok(phraseById('') === null && phraseById(undefined) === null, 'phraseById is null-safe for empty/undefined');

// Reactions are stored verbatim, so the set is also a contract.
ok(REACTION_EMOJI.length > 0 && new Set(REACTION_EMOJI).size === REACTION_EMOJI.length, 'reaction emoji are non-empty and unique');
ok(REACTION_EMOJI.every(isReactionEmoji), 'isReactionEmoji accepts every listed emoji');
ok(!isReactionEmoji('💩') && !isReactionEmoji('') && !isReactionEmoji(undefined), 'isReactionEmoji rejects anything not in the set');

console.log(fails ? `\n${fails} of ${ran} FAILED` : `\nall ${ran} checks passed`);
process.exit(fails ? 1 : 0);
