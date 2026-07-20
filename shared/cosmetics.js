// Cosmetic catalog — shared by the server (bot skins + validating human picks) and
// the client (picker UI + rendering). A cosmetic is a compact "hero:skin" id, e.g.
// "cat:holo". Cosmetics are PURELY VISUAL — they never touch physics or the sim.

export const HERO_KEYS = ['striker', 'dwarf', 'cowboy', 'cat', 'ninja', 'robot', 'pirate', 'wizard', 'alien'];

export const HERO_NAMES = {
  striker: 'Striker', dwarf: 'Dwarf', cowboy: 'Cowboy', cat: 'Cat', ninja: 'Ninja',
  robot: 'Robot', pirate: 'Pirate', wizard: 'Wizard', alien: 'Alien',
};

// The per-hero Signature (sig) gets a unique name; used by the picker UI.
export const SIGNATURE_NAMES = {
  striker: 'Winged Captain', dwarf: 'Warforged', cowboy: 'Sheriff', cat: 'Kitsune',
  ninja: 'Shogun', robot: 'Overclocked', pirate: 'Ghost', wizard: 'Cosmic', alien: 'Mothership',
};

// Skin tiers, cheapest → rarest. 'sig' is the hero's one-off Signature.
export const SKIN_KEYS = ['base', 'gold', 'holo', 'sig'];
export const SKIN_RARITY = { base: 'Common', gold: 'Rare', holo: 'Epic', sig: 'Legendary' };
export const SKIN_NAMES = { base: 'Base', gold: 'Gold', holo: 'Holo', sig: 'Signature' };

export const DEFAULT_COSMETIC = 'striker:base';

// Every valid hero×skin combination, "hero:skin".
export const ALL_COSMETICS = HERO_KEYS.flatMap((h) => SKIN_KEYS.map((s) => `${h}:${s}`));

export function isValidCosmetic(id) {
  if (typeof id !== 'string') return false;
  const [h, s] = id.split(':');
  return HERO_KEYS.includes(h) && SKIN_KEYS.includes(s);
}

// Coerce any untrusted value to a valid cosmetic id (falls back to the default).
export function normalizeCosmetic(id) {
  return isValidCosmetic(id) ? id : DEFAULT_COSMETIC;
}

// Bots get a uniformly-random skin across all hero×skin combos (per product call).
export function randomBotCosmetic(rand = Math.random) {
  return ALL_COSMETICS[Math.floor(rand() * ALL_COSMETICS.length)];
}
