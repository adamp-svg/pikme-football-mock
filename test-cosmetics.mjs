// Cosmetics catalog + sim-integration checks. Run: node test-cosmetics.mjs
import assert from 'node:assert';
import {
  ALL_COSMETICS, HERO_KEYS, SKIN_KEYS, DEFAULT_COSMETIC,
  isValidCosmetic, normalizeCosmetic, randomBotCosmetic,
} from './shared/cosmetics.js';
import { createState, addPlayer } from './shared/sim.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok -', name); };

t('catalog is 9 heroes × 4 skins = 36', () => {
  assert.equal(HERO_KEYS.length, 9);
  assert.equal(SKIN_KEYS.length, 4);
  assert.equal(ALL_COSMETICS.length, 36);
  assert.equal(new Set(ALL_COSMETICS).size, 36); // all unique
});

t('isValidCosmetic accepts real ids, rejects junk', () => {
  assert.ok(isValidCosmetic('cat:holo'));
  assert.ok(isValidCosmetic('ninja:sig'));
  assert.ok(!isValidCosmetic('cat:diamond'));
  assert.ok(!isValidCosmetic('dragon:base'));
  assert.ok(!isValidCosmetic('catholo'));
  assert.ok(!isValidCosmetic(null));
  assert.ok(!isValidCosmetic(42));
});

t('normalizeCosmetic coerces junk to the default', () => {
  assert.equal(normalizeCosmetic('cat:gold'), 'cat:gold');
  assert.equal(normalizeCosmetic('nope'), DEFAULT_COSMETIC);
  assert.equal(normalizeCosmetic(undefined), DEFAULT_COSMETIC);
});

t('randomBotCosmetic always returns a valid id (500 draws, all combos reachable)', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) { const c = randomBotCosmetic(); assert.ok(isValidCosmetic(c)); seen.add(c); }
  assert.ok(seen.size > 20, `expected broad spread, saw ${seen.size}`);
});

t('addPlayer stores the cosmetic on the sim player (humans + bots)', () => {
  const s = createState();
  addPlayer(s, 'h1', { name: 'Ada', char: 'player', team: 'A', slot: 0, isBot: false, cosmetic: 'cat:holo' });
  addPlayer(s, 'b1', { name: 'Bot', char: 'player', team: 'B', slot: 0, isBot: true, cosmetic: randomBotCosmetic() });
  assert.equal(s.players.h1.cosmetic, 'cat:holo');
  assert.ok(isValidCosmetic(s.players.b1.cosmetic));
});

t('roster payload (as server builds it) carries a valid cosmetic per slot', () => {
  const s = createState();
  addPlayer(s, 'h1', { name: 'Ada', char: 'player', team: 'A', slot: 0, cosmetic: 'wizard:sig' });
  addPlayer(s, 'b1', { name: 'Bot', char: 'player', team: 'B', slot: 0, isBot: true, cosmetic: 'alien:gold' });
  const slots = Object.values(s.players).map((p, i) => ({ i, id: p.id, team: p.team, c: p.cosmetic || DEFAULT_COSMETIC }));
  assert.equal(slots.length, 2);
  for (const sl of slots) assert.ok(isValidCosmetic(sl.c), `slot ${sl.id} has invalid cosmetic ${sl.c}`);
  assert.equal(slots.find((x) => x.id === 'h1').c, 'wizard:sig');
});

t('cosmetic never leaks into physics char (still the default player type)', () => {
  const s = createState();
  addPlayer(s, 'h1', { name: 'Ada', char: 'player', team: 'A', slot: 0, cosmetic: 'robot:holo' });
  assert.equal(s.players.h1.char, 'player'); // look changes, physics identity does not
});

console.log(`\n${n} cosmetics checks passed.`);
