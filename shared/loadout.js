// THE POWER SLOTS: which three cards a player actually plays with.
//
// Lives here, not in client.js, for two reasons. It is the rule the whole game reads the same way
// (lobby render, the wire, the profile), and — the reason it moved — a 10k-line browser module
// cannot be imported by a node test, so the one piece of logic that decides whether a player gets
// any card buffs at all had no unit test. See test-loadout-backfill.mjs.
//
// THE RULING (Adam, 2026-07-31, emphatic): "the power slots must auto-fill with the player's BEST
// cards when entering the game." A player who never opened the card screen used to play with three
// empty slots and no buffs. Empty is now only ever a deliberate, in-session choice.

import { RARITY_LADDER } from './bot-buffs.js';

// Weakest→strongest as a lookup. Derived from bot-buffs' RARITY_LADDER rather than re-typed:
// that array is already this repo's single source for rarity ORDER, and a second hand-written
// table is exactly how "2 legendaries + 1 epic instead of 3 legendaries" got shipped once already.
export const RARITY_RANK = Object.fromEntries(RARITY_LADDER.map((r, i) => [r, i]));

const keyOf = (c) => c.r + '_' + (+c.n);

// "Best" loadout ranking: RARITY first, then DUPLICATION (copies), then worth as a tiebreak.
// Deliberately distinct from the carousel's worth-first rankCards — the equipped powers should be
// the rarest / most-owned cards, which is what «הכי טוב» has always promised.
export function rankForLoadout(cards) {
  return [...(cards || [])].sort((a, b) =>
    (RARITY_RANK[b.r] || 0) - (RARITY_RANK[a.r] || 0) ||
    (b.c || 0) - (a.c || 0) ||
    (b.w || 0) - (a.w || 0));
}

// Fill every EMPTY slot with the best still-unequipped card. Never touches a slot that already
// holds one — a deliberate pick is never downgraded, reordered or replaced, only holes are filled.
//
//   slots      [{r,n}|null] x3, ALREADY validated against the album by the caller (the client
//              drops slots whose card the player no longer owns before calling in).
//   cards      the album, [{r,n,c,w}].
//   heldEmpty  optional (i) => boolean: slots the player emptied ON PURPOSE, left alone. Without
//              it the remove gesture would be a no-op — the freed card is by definition the best
//              unequipped one, so it would re-equip itself on the very next render.
//
// Returns a fresh array; the input is never mutated.
export function backfillLoadout(slots, cards, heldEmpty) {
  const src = Array.isArray(slots) ? slots : [];
  // One instance per card, and the FIRST slot to claim it wins — the same rule server.js's
  // sanitizeLoadout applies. A duplicate arriving from a malformed inject becomes a hole here rather
  // than a slot the lobby draws and the sim then throws away, which is how the two ends disagree.
  const used = new Set();
  const out = [0, 1, 2].map((i) => {
    const s = src[i];
    if (!s || !s.r || s.n == null) return null;
    const k = keyOf(s);
    if (used.has(k)) return null;
    used.add(k);
    return { r: s.r, n: +s.n };
  });
  if (!out.some((s) => !s)) return out;                 // already full — nothing to decide
  const pool = [];
  for (const c of rankForLoadout(cards)) {
    if (!c || !c.r || c.n == null) continue;
    const k = keyOf(c);
    if (used.has(k)) continue;
    used.add(k);
    pool.push(c);
  }
  for (let i = 0; i < 3 && pool.length; i++) {
    if (out[i]) continue;
    if (heldEmpty && heldEmpty(i)) continue;
    const c = pool.shift();
    out[i] = { r: c.r, n: +c.n };
  }
  return out;
}

// How many of the three slots are actually carrying a card. Used by tests and by callers that only
// need "is this player buffed at all".
export function equippedCount(loadout) {
  return (Array.isArray(loadout) ? loadout : []).filter((s) => s && s.r).length;
}
