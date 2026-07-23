// football-mock/shared/friend-cards.js
// Rank a friend's owned cards exactly like the hub "select best" (rarity → copies → worth).
// Pure + DOM-free so it is unit-testable and shared by the client's friend UI.
export const RARITY_ORDER = { legendary: 3, epic: 2, rare: 1, common: 0 };

export function rankTopCards(cards, n = 3) {
  const arr = Array.isArray(cards) ? cards.filter((c) => c && c.r != null && c.n != null) : [];
  arr.sort((a, b) =>
    ((RARITY_ORDER[b.r] ?? -1) - (RARITY_ORDER[a.r] ?? -1)) ||
    ((b.c || 0) - (a.c || 0)) ||
    ((b.w || 0) - (a.w || 0)),
  );
  return arr.slice(0, n).map((c) => ({ r: c.r, n: +c.n }));
}
