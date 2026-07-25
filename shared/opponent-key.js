// SERVER-ONLY. Opaque per-opponent id for the backend's win-trading cap (3rd+ match vs the same
// opponent pays 0 trophies — see pikme-server data/football-trophies.js countMeetings).
//
// ⚠️ Do NOT import this from public/client.js — it uses node:crypto and would break in the browser.
//
// Three properties this must have, and why:
//   1. STABLE ACROSS MATCHES — member.id is `m-<counter>`, minted fresh on every connection, so a key
//      built from it would differ every match and the cap would silently never fire. We key on the
//      account identity (userId from the football token) instead.
//   2. ORDER-INDEPENDENT — both sides of the same pairing must derive the SAME key, so the ids are
//      sorted before hashing.
//   3. NON-IDENTIFYING — the result is a hash, and it's only ever sent to the player it describes
//      opponents FOR, so no client ever learns another player's account id.
//
// Guests have no userId; they fall back to their per-connection id, so a guest opponent produces an
// unstable key and simply isn't capped. That's the honest trade: only logged-in accounts have
// trophies to farm in the first place.

import { createHash } from 'crypto';

// ids: the opponents' stable identities (userId, or the connection id for a guest).
// Returns '' when there are no human opponents — a bots-only match has nobody to farm.
export function opponentKeyFrom(ids) {
  const clean = (Array.isArray(ids) ? ids : [])
    .map((v) => String(v == null ? '' : v))
    .filter((s) => s.length > 0)
    .sort();
  if (!clean.length) return '';
  return createHash('sha256').update(clean.join('|')).digest('hex').slice(0, 32);
}

// Pick out the human opponents of `me` from a room's [member, team] assignment list, and key them.
export function opponentKeyFor(assignedList, me, myTeam) {
  const ids = (assignedList || [])
    .filter((entry) => entry && entry[0] !== me && entry[1] && entry[1] !== myTeam)
    .map((entry) => entry[0].userId || entry[0].id);
  return opponentKeyFrom(ids);
}
