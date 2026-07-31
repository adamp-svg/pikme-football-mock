// THE POWER SLOTS: which three cards a player actually plays with.
//
// Lives here, not in client.js, for two reasons. It is the rule the whole game reads the same way
// (lobby render, the wire, the profile), and — the reason it moved — a 10k-line browser module
// cannot be imported by a node test, so the one piece of logic that decides whether a player gets
// any card buffs at all had no unit test. See test-loadout-backfill.mjs.
//
// THE RULING (Adam, 2026-07-31, eight exclamation marks): "make the cards power slots always have
// the best cards by default whenever a user is in the main lobby ALWAYS!!!!!!!!"
// So: every EMPTY slot fills with the best still-unequipped card, UNCONDITIONALLY — on the first
// paint, on every return to the hub from a match or a sub-page, after a remove, and for a player
// whose album lands after the socket joined. Standing in the lobby with an empty slot while an
// unequipped card sits in the album is no longer a state the game can be in.
// A slot the player DELIBERATELY filled is still never touched: "best by default" means the default
// (an empty slot), not an override of a pick. Swapping a specific card into a specific slot sticks.
//
// SUPERSEDED, kept visible so it is not re-litigated (Adam, 2026-07-31, EARLIER the same day):
// the first ruling was "the power slots must auto-fill with the player's BEST cards when entering
// the game", and it carved out one exception — a slot the player emptied on purpose was held empty
// for the rest of the session by an `{off:1}` marker, honoured through a `heldEmpty` predicate that
// was this function's third argument (commit 82b2651 kept that deliberately). The instruction above
// overrides it. The marker, the predicate and the argument are all deleted: removing a card is now
// a SWAP-OUT (the slot immediately takes the next-best unequipped card — see setSlotCard() in
// public/client.js), and when the album has nothing else to offer the removal is refused with a
// toast rather than leaving a hole.
//
// TWO SLOTS CAN STILL BE DRAWN EMPTY, and neither is an exception to the rule:
//   • an album with fewer than 3 cards — there is simply nothing to fill with;
//   • INSIDE the lobby tour's sandbox (public/hub-tour.js), whose lesson is literally "drag a card
//     into this slot". That is client.js's `tuHub` branch and never reaches this file; the WIRE is
//     protected there by playerLoadoutBehindTour(), so the server still hears the real slots.

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
//   slots  [{r,n}|null] x3, ALREADY validated against the album by the caller (the client drops
//          slots whose card the player no longer owns before calling in).
//   cards  the album, [{r,n,c,w}].
//
// TWO ARGUMENTS, not three. The old `heldEmpty` predicate (a slot the player emptied on purpose is
// left alone) is deleted with the {off:1} marker it read — see the superseded ruling at the top.
// There is deliberately no way for a caller to ask for a hole any more: that is what made "always"
// only true at the moments someone remembered to hook.
//
// Returns a fresh array; the input is never mutated.
export function backfillLoadout(slots, cards) {
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
    const c = pool.shift();
    out[i] = { r: c.r, n: +c.n };
  }
  return out;
}

// THE REMOVE GESTURE, as a rule rather than a client detail: the card that takes over a slot whose
// card is being pulled out. It is the best album card sitting in NONE of the three slots — and the
// outgoing card is one of those three, because `slots` is read BEFORE the slot is cleared. That
// exclusion is the whole point: the freed card is usually the best unequipped one, so without it
// "remove" hands the slot straight back the card it just took out and the gesture does nothing.
//
// Null means the album has nothing else to offer. The caller must then REFUSE the removal (toast)
// rather than leave a hole — see setSlotCard() in public/client.js. Under the superseded ruling
// this case produced an {off:1} empty slot, which is exactly what the 2026-07-31 ruling forbids.
export function bestUnequipped(slots, cards) {
  const taken = new Set();
  for (const s of (Array.isArray(slots) ? slots : [])) {
    if (s && s.r && s.n != null) taken.add(keyOf(s));
  }
  const c = rankForLoadout(cards).find((x) => x && x.r && x.n != null && !taken.has(keyOf(x)));
  return c ? { r: c.r, n: +c.n } : null;
}

// How many of the three slots are actually carrying a card. Used by tests and by callers that only
// need "is this player buffed at all".
export function equippedCount(loadout) {
  return (Array.isArray(loadout) ? loadout : []).filter((s) => s && s.r).length;
}
