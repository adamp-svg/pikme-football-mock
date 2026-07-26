// Skill-progression model: technique unlocks earned from training drills.
// Run: node test-techniques.mjs
//
// Design: summery/research-trophies/00-DECISION.md §4. The research verdict was HORIZONTAL only —
// techniques unlock new THINGS YOU CAN DO, never higher stats, because the card powers are already the
// vertical axis and stacking a second one is how mobile games earn their pay-to-win reputation.
// These tests exist mostly to hold that line: every technique must be non-stat, and nothing may be
// buyable or trophy-gated.

import {
  TECHNIQUES, DRILLS, MEDALS, EFFECT,
  techniqueById, drillById, medalFor, unlockedTechniques, isUnlocked,
  drillProgress, recordDrillResult, emptyDrillState, techniqueCount,
} from './shared/techniques.js';

let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + '  ' + m); if (!c) fails++; };
const eq = (a, b, m) => ok(a === b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

console.log('--- the catalogue ---');
ok(TECHNIQUES.length >= 5, `at least 5 techniques (${TECHNIQUES.length})`);
ok(DRILLS.length >= 5, `at least 5 drills (${DRILLS.length})`);
ok(TECHNIQUES.every((t) => t.id && t.he && t.desc), 'every technique has an id, a Hebrew name and a description');
ok(new Set(TECHNIQUES.map((t) => t.id)).size === TECHNIQUES.length, 'technique ids are unique');
ok(new Set(DRILLS.map((d) => d.id)).size === DRILLS.length, 'drill ids are unique');
eq(MEDALS.join(','), 'bronze,silver,gold', 'three medals per drill');

console.log('--- THE LINE: horizontal only, no stat buffs, no purchases ---');
// A technique may add an ABILITY (a new action/option). It must never carry a numeric multiplier that
// makes the player simply stronger — that's the card-power axis, and doubling up is pay-to-win.
ok(TECHNIQUES.every((t) => t.kind === 'ability'), 'every technique is kind:"ability" — none is a stat buff');
const statish = ['mul', 'bonus', 'dmg', 'speed', 'power', 'hp', 'scale'];
ok(
  TECHNIQUES.every((t) => !Object.keys(t).some((k) => statish.includes(k.toLowerCase()))),
  'no technique carries a stat-multiplier field',
);
ok(TECHNIQUES.every((t) => !t.price && !t.cost && !t.iap), 'no technique can be bought');
ok(TECHNIQUES.every((t) => t.trophyReq == null), 'no technique is gated behind trophies — skill, not rank');
ok(TECHNIQUES.every((t) => t.drill && drillById(t.drill)), 'every technique is earned from a real drill');

// WHERE THIS FILE'S GUARANTEE STOPS. The two assertions above check the technique's METADATA — that no
// object literal carries a `mul`/`bonus`/`speed` field. A stat buff can pass that gate simply by keeping
// its magnitude out of the literal and putting it in the sim hook instead, which is exactly what the
// specced `precise-strip` ("a more forgiving strip threshold") would have done. Horizontality at the
// EFFECT level is asserted in test-technique-effects.mjs (a curve conserves ball speed; a clean strip has
// the same power; the super bank is capped at what you already earned). Keep both halves.
console.log('--- the effect id is the contract with the sim ---');
// `effect` is the ONLY string the sim hooks read, so a duplicate would make two techniques
// indistinguishable to hasEffect() — unlocking one would silently grant the other.
ok(new Set(TECHNIQUES.map((t) => t.effect)).size === TECHNIQUES.length, 'effect ids are unique — no two techniques share a sim hook');
ok(TECHNIQUES.every((t) => typeof t.effect === 'string' && t.effect.length > 0), 'every technique names its effect');
const EFFECT_VALUES = new Set(Object.values(EFFECT));
ok(TECHNIQUES.every((t) => EFFECT_VALUES.has(t.effect)), 'every effect has a named EFFECT constant — a new technique cannot be added without one');
eq(Object.keys(EFFECT).length, TECHNIQUES.length, 'and no EFFECT constant is left pointing at a technique that no longer exists');

console.log('--- drills map to techniques and to real game mechanics ---');
ok(DRILLS.every((d) => d.he && d.goal), 'every drill has a Hebrew name and a stated goal');
ok(DRILLS.every((d) => Number.isFinite(d.target) && d.target > 0), 'every drill has a positive target score');
ok(DRILLS.every((d) => d.mechanic), 'every drill names the mechanic it teaches (kick/super/bomb/wall/strip)');
const taught = new Set(DRILLS.map((d) => d.id));
ok(TECHNIQUES.every((t) => taught.has(t.drill)), 'no technique points at a missing drill');

console.log('--- medalFor: score vs the drill target ---');
const d0 = DRILLS[0];
eq(medalFor(d0.id, 0), null, 'a score of 0 earns no medal');
eq(medalFor(d0.id, d0.target - 1), null, 'just short of target = no medal');
eq(medalFor(d0.id, d0.target), 'bronze', 'hitting the target earns bronze');
eq(medalFor(d0.id, Math.ceil(d0.target * 1.5)), 'silver', '1.5x target = silver');
eq(medalFor(d0.id, d0.target * 2), 'gold', '2x target = gold');
eq(medalFor(d0.id, d0.target * 99), 'gold', 'gold is the ceiling');
eq(medalFor('nope', 999), null, 'an unknown drill never awards a medal');

console.log('--- unlocking: BRONZE on a drill grants its technique ---');
let st = emptyDrillState();
eq(unlockedTechniques(st).length, 0, 'a fresh player has no techniques');
const tech0 = TECHNIQUES.find((t) => t.drill === d0.id);
ok(!isUnlocked(st, tech0.id), 'and specifically not this one');
st = recordDrillResult(st, d0.id, d0.target - 1);
eq(unlockedTechniques(st).length, 0, 'a failed attempt unlocks nothing');
st = recordDrillResult(st, d0.id, d0.target);
ok(isUnlocked(st, tech0.id), 'bronze unlocks the technique');
eq(medalFor(d0.id, drillProgress(st, d0.id).best), 'bronze', 'the medal is recorded as bronze');

console.log('--- progress is a personal BEST and never regresses ---');
st = recordDrillResult(st, d0.id, d0.target * 2);
eq(drillProgress(st, d0.id).medal, 'gold', 'a better run upgrades the medal to gold');
st = recordDrillResult(st, d0.id, 0);
eq(drillProgress(st, d0.id).medal, 'gold', 'a later BAD run does not take the medal away');
eq(drillProgress(st, d0.id).best, d0.target * 2, 'the best score is kept');
ok(isUnlocked(st, tech0.id), 'and the technique stays unlocked — you cannot lose a skill you learned');
eq(drillProgress(st, d0.id).attempts, 4, 'attempts are counted');

console.log('--- unlocking is per-drill, not global ---');
const other = DRILLS.find((d) => d.id !== d0.id);
const otherTech = TECHNIQUES.find((t) => t.drill === other.id);
ok(!isUnlocked(st, otherTech.id), 'clearing one drill does not unlock another drill\'s technique');
st = recordDrillResult(st, other.id, other.target);
ok(isUnlocked(st, otherTech.id), 'clearing that drill unlocks its own technique');
eq(unlockedTechniques(st).length, 2, 'two techniques unlocked');
eq(techniqueCount(st), 2, 'techniqueCount agrees');

console.log('--- state is survivable garbage-in ---');
eq(unlockedTechniques(null).length, 0, 'null state = nothing unlocked');
eq(unlockedTechniques({ drills: 'nonsense' }).length, 0, 'malformed state = nothing unlocked');
eq(drillProgress(null, d0.id).best, 0, 'progress on a null state reads 0');
ok(isUnlocked(null, tech0.id) === false, 'isUnlocked on a null state is false, not a throw');
const bad = recordDrillResult(null, d0.id, d0.target);
ok(isUnlocked(bad, tech0.id), 'recording onto a null state still produces valid state');
const neg = recordDrillResult(emptyDrillState(), d0.id, -50);
eq(drillProgress(neg, d0.id).best, 0, 'a negative score clamps to 0');
const unknown = recordDrillResult(emptyDrillState(), 'nope', 10);
eq(JSON.stringify(unknown), '{"drills":{}}', 'an unknown drill id records nothing (and does not throw)');
ok(unlockedTechniques(recordDrillResult(emptyDrillState(), 'nope', 999)).length === 0, 'and unlocks nothing');
// recordDrillResult must not mutate the state it was handed — the caller may still be holding it.
const before = emptyDrillState();
before.drills[d0.id] = { best: 3, attempts: 1 };
const snapshot = JSON.stringify(before);
recordDrillResult(before, d0.id, 99);
eq(JSON.stringify(before), snapshot, 'recordDrillResult does not mutate its input');

console.log('--- techniqueById / drillById ---');
ok(techniqueById(tech0.id) === tech0, 'techniqueById finds a technique');
eq(techniqueById('nope'), null, 'unknown technique id = null');
eq(drillById('nope'), null, 'unknown drill id = null');

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
