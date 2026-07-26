// TECHNIQUE EFFECTS — the acceptance suite for wiring the 6 techniques into the sim.
// Run: node test-technique-effects.mjs
//
// WHY THIS FILE EXISTS
// shared/techniques.js defines 6 techniques, unit-tests them (test-techniques.mjs), and NONE of them
// does anything in a match. shared/sim.js is the highest-regression file in the repo — server + every
// client read it — so the effects were specced but never hooked in. This file makes the hook-up SAFE
// instead of doing it: it locks the pure helpers each effect needs (so the sim change becomes a
// one-line call to a tested function, never new logic inside sim.js), and it states, as executable
// assertions, what each effect must DO in a real match.
//
// TWO TIERS, and the difference matters:
//   ok()  = HARD assertion. Either a helper contract, or a "this must NOT change" regression guard on
//           today's sim behaviour. A failure here fails the suite.
//   acc() = ACCEPTANCE CRITERION for a sim change that has NOT been made yet. It prints PENDING and
//           does NOT fail the suite (house rule: `for f in test*.mjs` must stay green while several
//           agents are live). The instant someone wires the effect it prints NOW GREEN and asks to be
//           promoted to ok(). Every acc() below is written so it CANNOT pass unwired — its
//           discriminating clause is named in the comment above it.
//
// So: the PENDING count is the honest RED count for the sim work. The ok() count is what is done.
//
// Design doc (hook point + risk + wire-format impact per technique):
//   docs/superpowers/specs/2026-07-26-technique-wiring-design.md

import {
  EFFECT, hasEffect, effectList,
  FEINT_CD, FEINT_MIN_CHARGE, feintPatch,
  CURVE_RATE, curveStep,
  COOK_GRACE, COOK_MIN_FUSE, cookedFuse, cookOverdone,
  vaultsWall, passableWalls,
  stripDetachSide,
  SUPER_BANK_MAX, bankSuperUses, superUsesOnFill,
} from './shared/techniques.js';
import { TECHNIQUES, activeEffects, emptyDrillState, recordDrillResult, DRILLS } from './shared/techniques.js';
import { createState, addPlayer, step, makeRng } from './shared/sim.js';
import {
  DT, TICK_RATE, SNAPSHOT_RATE, BOMB, BOMB_LOB_RANGE, DETACH_SIDE, SUPER_USES, OVERCHARGE_TTL,
  QUICK_CHARGE, FULL_CHARGE, SHOOT_CHARGE_TIME, CHARACTERS,
} from './shared/constants.js';

let fails = 0, pending = 0, promoted = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}     ${m}`); if (!c) fails++; };
const eq = (a, b, m) => ok(a === b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const near = (a, b, tol, m) => ok(Math.abs(a - b) <= tol, `${m} (got ${a}, want ${b}±${tol})`);
// Acceptance criterion for the un-wired sim change. See the header.
const acc = (c, m) => {
  if (c) { promoted++; console.log(`NOW GREEN  ${m}   <-- WIRED: promote this to ok()`); }
  else { pending++; console.log(`PENDING    ${m}`); }
};

// ---------------------------------------------------------------------------
// 0. The effect ids are the contract between techniques.js and the sim
// ---------------------------------------------------------------------------
console.log('--- effect ids ---');
const declared = new Set(TECHNIQUES.map((t) => t.effect));
for (const k of Object.keys(EFFECT)) ok(declared.has(EFFECT[k]), `EFFECT.${k} ("${EFFECT[k]}") is a real technique effect`);
eq(Object.keys(EFFECT).length, TECHNIQUES.length, 'one EFFECT constant per technique — no effect can be wired without a name');

console.log('--- hasEffect tolerates every shape the roster can hand it ---');
// activeEffects() returns a Set; a Set does NOT survive JSON, so anything that reaches the sim through
// a roster message / snapshot arrives as an ARRAY. The sim must not care which it got.
ok(hasEffect(new Set([EFFECT.COOK]), EFFECT.COOK), 'Set works');
ok(hasEffect([EFFECT.COOK], EFFECT.COOK), 'Array works (JSON-safe shape)');
ok(!hasEffect([EFFECT.COOK], EFFECT.VAULT), 'a different effect is not claimed');
ok(!hasEffect(null, EFFECT.COOK), 'null → false, not a throw');
ok(!hasEffect(undefined, EFFECT.COOK), 'undefined (an un-migrated player) → false');
ok(!hasEffect('hold-fuse', EFFECT.COOK), 'a bare string is not a valid effect bag');
ok(!hasEffect({ 'hold-fuse': true }, EFFECT.COOK), 'a plain object is not a valid effect bag');
ok(!hasEffect(new Set([EFFECT.COOK]), 'not-an-effect'), 'an unknown id is never active');
let st = recordDrillResult(emptyDrillState(), DRILLS.find((d) => d.id === 'bomb-timing').id, 99);
ok(Array.isArray(effectList(st)) && effectList(st).includes(EFFECT.COOK), 'effectList gives the JSON-safe array form of activeEffects');
eq(effectList(st).length, activeEffects(st).size, 'effectList and activeEffects agree');
eq(effectList(null).length, 0, 'effectList(null) is empty, not a throw');

// ---------------------------------------------------------------------------
// 1. feint (cancel-charge) — sell a fake shot: the TELL fires, the ball does not
// ---------------------------------------------------------------------------
console.log('\n--- feint helper ---');
const FX = { feint: [EFFECT.FEINT], cook: [EFFECT.COOK], vault: [EFFECT.VAULT], curve: [EFFECT.CURVE], strip: [EFFECT.STRIP], chain: [EFFECT.CHAIN] };
eq(feintPatch({ effects: [], charge: 1, cd: 0 }), null, 'no technique → no feint');
eq(feintPatch({ effects: FX.feint, charge: 0.05, cd: 0 }), null, 'you cannot sell a fake you never wound up (charge below the minimum)');
eq(feintPatch({ effects: FX.feint, charge: 1, cd: 0.2 }), null, 'on cooldown → no feint (a strobing tell is not a fake)');
ok(FEINT_MIN_CHARGE >= QUICK_CHARGE, `the feint needs at least a real quick windup (${FEINT_MIN_CHARGE} >= ${QUICK_CHARGE})`);
ok(FEINT_CD > 0, 'the feint has a cooldown');
{
  const raw = feintPatch({ effects: FX.feint, charge: 0.9, cd: 0 });
  ok(raw != null, 'a wound-up player with the technique can feint');
  const p = raw || {};
  eq(p.firing, true, 'the feint raises the FIRE TELL — that is the whole ability (wire flag bit 0)');
  eq(p._charge, 0, 'the windup is spent');
  eq(p._superLatched, false, 'and the super latch is dropped with it');
  near(p.feintCd, FEINT_CD, 1e-9, 'the cooldown is armed');
  // Whitelist: the patch is Object.assign'd onto a live player, so it must not be able to smuggle
  // anything else into sim state — that is what keeps the sim change reviewable.
  eq(Object.keys(p).sort().join(','), '_charge,_superLatched,feintCd,firing', 'the patch touches EXACTLY those 4 fields and nothing else');
  ok(!('power' in p) && !('powerUses' in p) && !('powerMeter' in p), 'a feint never spends super');
}

console.log('--- feint in a match ---');
function duel(effectsA, effectsB) {
  const s = createState();
  s.resetTimer = 0;
  addPlayer(s, 'A', { name: 'a', char: 'player', team: 'A', slot: 0, effects: effectsA });
  addPlayer(s, 'B', { name: 'b', char: 'player', team: 'B', slot: 0, effects: effectsB });
  s.players.A.x = 900; s.players.A.y = 550; s.players.A.aimX = 1; s.players.A.aimY = 0;
  s.players.B.x = 1000; s.players.B.y = 550; s.players.B.aimX = -1; s.players.B.aimY = 0;
  s.players.A.ammo = 9; s.players.B.ammo = 9;
  return s;
}
const inp = (o = {}) => ({ seq: 1, moveX: 0, moveY: 0, aimX: 1, aimY: 0, hold: false, fire: false, aimed: false, special: false, build: false, buildHold: false, sax: 0, say: 0, ...o });
const idle = (s, n, extra = {}) => { for (let i = 0; i < n; i++) step(s, { A: inp(), B: inp(), ...extra }, DT); };
// Hold the trigger for `frac` of a full windup.
function charge(s, frac, extra = {}) {
  const n = Math.max(0, Math.round(frac * SHOOT_CHARGE_TIME * TICK_RATE));
  for (let i = 0; i < n; i++) step(s, { A: inp({ hold: true, ...extra }), B: inp() }, DT);
}
function giveBall(s, id) {
  const p = s.players[id];
  s.ball.owner = id; s.ball.lastTouch = p.team; s.ball.lastPlayer = id;
  s.ball.x = p.x + p.aimX * 30; s.ball.y = p.y; s.ball.vx = 0; s.ball.vy = 0;
}
{
  const s = duel(FX.feint, []);
  giveBall(s, 'A');
  charge(s, 0.9);
  step(s, { A: inp({ feint: true }), B: inp() }, DT);
  const A = s.players.A;
  // DISCRIMINATOR: A.firing. Releasing `hold` without `fire` already zeroes the charge and already
  // keeps the ball today — silently. The ability IS the broadcast tell, so only `firing` can flip.
  const tell1 = A.firing === true, kept = s.ball.owner === 'A' && A._charge === 0;
  // Second feint on the very next tick: the cooldown must swallow it, or the "fake" is a strobe
  // light. Folded into the same criterion — on its own it passes unwired (firing is false anyway).
  step(s, { A: inp({ feint: true }), B: inp() }, DT);
  const tell2 = s.players.A.firing === true;
  acc(kept && tell1 && !tell2,
    'feint: a charged carrier fakes the kick — ball KEPT, windup spent, the fire tell goes out on the wire, and a second feint inside FEINT_CD raises no tell');
}
{
  // MUST NOT CHANGE: a plain release-without-fire is still a silent cancel for a player who has no
  // technique. If wiring the feint makes every cancelled charge broadcast a tell, every player in the
  // game suddenly twitches — this is the regression guard for that.
  const s = duel([], []);
  giveBall(s, 'A');
  charge(s, 0.9);
  step(s, { A: inp({ feint: true }), B: inp() }, DT);
  ok(s.players.A.firing === false, 'no technique: a cancelled charge stays SILENT (no tell)');
  ok(s.ball.owner === 'A' && s.players.A._charge === 0, 'no technique: the charge is still cancelled and the ball kept');
}

// ---------------------------------------------------------------------------
// 2. banana (curve-kick) — bend the ball WITHOUT making the kick stronger
// ---------------------------------------------------------------------------
console.log('\n--- curve helper ---');
{
  // The horizontal-only rule (techniques.js header) in one assertion: a curve may change WHERE the
  // ball goes, never how hard it was hit. If curveStep changes speed it is a stat buff.
  const v0 = { vx: 700, vy: 0 };
  let c = curveStep(v0.vx, v0.vy, 1, DT);
  near(Math.hypot(c.vx, c.vy), 700, 1e-9, 'one curve step conserves ball SPEED exactly (a curve is not power)');
  ok(c.vy > 0, 'positive spin bends one way');
  const c2 = curveStep(700, 0, -1, DT);
  ok(c2.vy < 0, 'negative spin bends the other way');
  near(c.vy, -c2.vy, 1e-9, 'the two directions are mirror images');
  // 1 s of full spin, integrated: still the same speed, and it has actually turned.
  let vx = 700, vy = 0, spin = 1;
  for (let i = 0; i < TICK_RATE; i++) { const r = curveStep(vx, vy, spin, DT); vx = r.vx; vy = r.vy; spin = r.spin; }
  near(Math.hypot(vx, vy), 700, 1e-6, 'a full second of curve still conserves speed (no energy injection)');
  ok(Math.atan2(vy, vx) > 0.05, `a second of spin visibly turns the ball (${(Math.atan2(vy, vx) * 180 / Math.PI).toFixed(1)}°)`);
  ok(spin < 1 && spin >= 0, `spin decays toward 0 (${spin.toFixed(3)}) — a curve is a bend, not an orbit`);
  ok(Math.abs(Math.atan2(vy, vx)) < Math.PI / 2, 'and it can never turn the ball back on itself');
}
{
  // Zero spin must be BIT-IDENTICAL to no call at all, or wiring it changes every ball in the game.
  const c = curveStep(123.456, -78.9, 0, DT);
  ok(c.vx === 123.456 && c.vy === -78.9 && c.spin === 0, 'spin 0 is the exact identity — an unwired/uncurved ball is untouched');
  const g = curveStep(700, 0, 99, DT);   // a hacked client sending spin 99
  const gm = curveStep(700, 0, 1, DT);
  near(Math.atan2(g.vy, g.vx), Math.atan2(gm.vy, gm.vx), 1e-9, 'spin is CLAMPED to ±1 — a client cannot send a 99-rad/s banana');
  const n = curveStep(700, 0, NaN, DT);
  ok(n.vx === 700 && n.vy === 0, 'NaN spin is inert, not a NaN ball');
  ok(CURVE_RATE > 0 && CURVE_RATE < Math.PI, `CURVE_RATE is a sane turn rate (${CURVE_RATE} rad/s)`);
}
console.log('--- curve in a match ---');
{
  // DISCRIMINATOR: lateral drift. An uncurved kick travels dead straight, so drift is 0 unwired.
  const straight = duel([], []); giveBall(straight, 'A');
  charge(straight, 1); step(straight, { A: inp({ fire: true, aimed: true }), B: inp() }, DT);
  const banana = duel(FX.curve, []); giveBall(banana, 'A');
  charge(banana, 1); step(banana, { A: inp({ fire: true, aimed: true, curve: 1 }), B: inp() }, DT);
  banana.players.B.x = -999; straight.players.B.x = -999;  // keep B out of the flight path
  for (let i = 0; i < 25; i++) { idle(straight, 1); idle(banana, 1); }
  const drift = Math.abs(banana.ball.y - straight.ball.y);
  const sp = (s) => Math.hypot(s.ball.vx, s.ball.vy);
  acc(drift > 30 && Math.abs(sp(banana) - sp(straight)) < sp(straight) * 0.02,
    `banana: the ball bends off the straight line (${drift.toFixed(0)}px) at the SAME speed`);
  ok(Math.abs(straight.ball.y - 550) < 1, 'MUST NOT CHANGE: a kick with no curve input flies dead straight');
}

// ---------------------------------------------------------------------------
// 3. cook (hold-fuse) — burn the fuse in your hand; hold too long and it blows there
// ---------------------------------------------------------------------------
console.log('\n--- cook helper ---');
eq(cookedFuse(BOMB.fuse, 0), BOMB.fuse, 'no hold → the stock fuse, unchanged');
eq(cookedFuse(BOMB.fuse, COOK_GRACE), BOMB.fuse, 'inside the grace window the fuse is untouched');
// THE regression that matters: aiming a lob today is ALREADY a press-drag-release, i.e. already a
// hold. If cook started burning from t=0, unlocking it would silently cook every bomb you aim.
ok(COOK_GRACE >= 0.3, `the grace covers a normal aim-drag (${COOK_GRACE}s) so unlocking cook cannot cook your aiming`);
near(cookedFuse(BOMB.fuse, COOK_GRACE + 0.5), BOMB.fuse - 0.5, 1e-9, 'past the grace the fuse burns 1:1 with the hold');
{
  let prev = Infinity, monotone = true, floored = true;
  for (let h = 0; h < BOMB.fuse + COOK_GRACE + 1; h += 0.01) {
    const f = cookedFuse(BOMB.fuse, h);
    if (f > prev + 1e-12) monotone = false;
    if (f < COOK_MIN_FUSE - 1e-12) floored = false;
    prev = f;
  }
  ok(monotone, 'the fuse only ever gets shorter as you hold');
  ok(floored, `and never drops below COOK_MIN_FUSE (${COOK_MIN_FUSE}s)`);
}
ok(COOK_MIN_FUSE >= 2 / SNAPSHOT_RATE, `COOK_MIN_FUSE (${COOK_MIN_FUSE}s) survives at least 2 snapshots at ${SNAPSHOT_RATE}Hz — a bomb that never renders reads as a desync, not as skill`);
ok(COOK_MIN_FUSE < 0.25, `...but is below human reaction time (${COOK_MIN_FUSE}s) — an un-dodgeable bomb is the POINT of cooking (CoD)`);
ok(!cookOverdone(BOMB.fuse, 0), 'a fresh bomb is not overdone');
ok(!cookOverdone(BOMB.fuse, COOK_GRACE + BOMB.fuse - 0.05), 'just before the end of the fuse: still in hand, still safe');
ok(cookOverdone(BOMB.fuse, COOK_GRACE + BOMB.fuse + 0.01), 'holding past the WHOLE fuse blows it in your hand (CoD cooking, verbatim)');
eq(cookedFuse(BOMB.fuse, NaN), BOMB.fuse, 'NaN hold → stock fuse');
eq(cookedFuse(BOMB.fuse, -5), BOMB.fuse, 'negative hold → stock fuse');
ok(cookedFuse(undefined, 1) > 0, 'a missing base fuse falls back to BOMB.fuse rather than NaN');

console.log('--- cook in a match ---');
{
  // DISCRIMINATOR: the planted bomb's fuse. Unwired, cookHold is ignored and the fuse is BOMB.fuse.
  const s = duel(FX.cook, []);
  const held = COOK_GRACE + 0.8;
  for (let i = 0; i < Math.round(held * TICK_RATE); i++) step(s, { A: inp({ cookHold: true, sax: 1, say: 0 }), B: inp() }, DT);
  step(s, { A: inp({ special: true, cookHold: false, sax: 1, say: 0 }), B: inp() }, DT);
  const bomb = s.bombs[0];
  // The lob clause alone passes unwired (the lob already works), so it rides along here.
  acc(!!bomb && bomb.fuse < BOMB.fuse - 0.5 && Math.abs(bomb.x - (900 + BOMB_LOB_RANGE)) < 4,
    `cook: a cooked bomb blows sooner (fuse ${bomb ? bomb.fuse.toFixed(2) : 'n/a'} < ${BOMB.fuse}) and still lands where you aimed it`);
}
{
  // DISCRIMINATOR: an overdone bomb detonates AT THE PLANTER, ignoring the lob. Unwired it lobs
  // 250px away with a full fuse and nothing explodes on that tick.
  const s = duel(FX.cook, []);
  for (let i = 0; i < Math.round((COOK_GRACE + BOMB.fuse + 0.2) * TICK_RATE); i++) step(s, { A: inp({ cookHold: true, sax: 1, say: 0 }), B: inp() }, DT);
  step(s, { A: inp({ special: true, cookHold: false, sax: 1, say: 0 }), B: inp() }, DT);
  const A = s.players.A;
  acc(s.bombs.length === 0 && s.blasts.length === 1 && Math.abs(s.blasts[0].x - 900) < 40 && Math.hypot(A.kvx, A.kvy) > 0,
    'cook: held past the whole fuse it detonates IN YOUR HAND — at your feet, and it flings you');
}
{
  // MUST NOT CHANGE: a player without the technique gets the stock fuse no matter how long they hold
  // the aim (which is what every bomb throw in the game does today).
  const s = duel([], []);
  for (let i = 0; i < Math.round((COOK_GRACE + 1.0) * TICK_RATE); i++) step(s, { A: inp({ cookHold: true, sax: 1, say: 0 }), B: inp() }, DT);
  step(s, { A: inp({ special: true, sax: 1, say: 0 }), B: inp() }, DT);
  ok(s.bombs.length === 1, 'no technique: the bomb is planted');
  near(s.bombs[0].fuse, BOMB.fuse - DT, DT * 1.5, 'no technique: a long aim-hold does NOT cook — stock fuse');
}

// ---------------------------------------------------------------------------
// 4. vault (hop-own-wall) — your own wall is not your problem
// ---------------------------------------------------------------------------
console.log('\n--- vault helper ---');
const wallOf = (team, extra = {}) => ({ id: 1, wallId: 7, x: 940, y: 480, w: 20, h: 140, hp: 3, maxHp: 3, team, ttl: 30, ...extra });
const pA = { team: 'A' }, pB = { team: 'B' };
ok(vaultsWall(FX.vault, pA, wallOf('A')), 'your own built wall is vaultable');
ok(!vaultsWall(FX.vault, pA, wallOf('B')), "an ENEMY's wall is not — vault must never be a free pass through their cover");
ok(!vaultsWall(FX.vault, pA, wallOf('A', { field: true })), 'a FIELD dry wall is arena geometry, not yours to hop');
ok(!vaultsWall([], pA, wallOf('A')), 'without the technique nothing is vaultable');
ok(!vaultsWall(FX.vault, pB, wallOf('A')), 'the team check is per-player, not global');
ok(!vaultsWall(FX.vault, pA, null), 'a null wall is not vaultable (no throw)');
{
  const walls = [wallOf('A'), wallOf('B'), wallOf('A', { field: true })];
  // Zero-alloc fast path: this runs inside the per-substep movement loop for every player, every
  // tick. A player without the technique must get the SAME ARRAY back, not a copy.
  ok(passableWalls([], pA, walls) === walls, 'no technique → the identical array (no allocation in the hot path)');
  ok(passableWalls(null, pA, walls) === walls, 'null effects → the identical array');
  const f = passableWalls(FX.vault, pA, walls);
  eq(f.length, 2, 'with vault, your own built wall is filtered out of the collision set');
  ok(f.includes(walls[1]) && f.includes(walls[2]), 'the enemy wall and the field wall still collide');
  const aOnly = [wallOf('A'), wallOf('A', { field: true })];
  ok(passableWalls(FX.vault, pB, aOnly) === aOnly, "a team-B vaulter facing only team A's walls gets the identical array back");
  ok(passableWalls(FX.vault, pA, null) == null, 'a null wall list survives (resolveWalls already guards it)');
  eq(passableWalls(FX.vault, pA, []).length, 0, 'an empty wall list is fine');
}
console.log('--- vault in a match ---');
function ownWall(s, team) {
  const w = wallOf(team);
  s.builtWalls.push(w);
  return w;
}
{
  // DISCRIMINATOR: crossing x. Unwired, resolveWalls stops the body at the wall face.
  const s = duel(FX.vault, []);
  s.players.B.x = 200; // out of the way
  const w = ownWall(s, 'A');
  for (let i = 0; i < 90; i++) step(s, { A: inp({ moveX: 1 }), B: inp() }, DT);
  const rad = CHARACTERS.player.radius;
  acc(s.players.A.x > w.x + w.w + rad, `vault: you run straight over your OWN wall (x=${s.players.A.x.toFixed(0)} past ${w.x + w.w})`);
}
{
  // MUST NOT CHANGE: an enemy wall is still a wall. If wiring the vault leaks into enemy cover the
  // whole build mechanic dies.
  const s = duel(FX.vault, []);
  s.players.B.x = 200;
  const w = ownWall(s, 'B');
  for (let i = 0; i < 90; i++) step(s, { A: inp({ moveX: 1 }), B: inp() }, DT);
  ok(s.players.A.x < w.x, `an ENEMY wall still blocks a vaulter (x=${s.players.A.x.toFixed(0)} < ${w.x})`);
}
{
  // MUST NOT CHANGE: no technique = blocked by your own wall (today's behaviour).
  const s = duel([], []);
  s.players.B.x = 200;
  const w = ownWall(s, 'A');
  for (let i = 0; i < 90; i++) step(s, { A: inp({ moveX: 1 }), B: inp() }, DT);
  ok(s.players.A.x < w.x, `no technique: your own wall blocks you (x=${s.players.A.x.toFixed(0)} < ${w.x})`);
}
{
  // The ball does NOT come with you: vault is a BODY exemption, the ball still collides. Carrying it
  // into your own wall pops it loose exactly as it does today.
  // DISCRIMINATOR: A ends up PAST the wall (unwired it never gets there, though the ball does pop).
  const s = duel(FX.vault, []);
  s.players.B.x = 200;
  const w = ownWall(s, 'A');
  giveBall(s, 'A');
  for (let i = 0; i < 90; i++) step(s, { A: inp({ moveX: 1 }), B: inp() }, DT);
  acc(s.players.A.x > w.x + w.w && s.ball.owner !== 'A', 'vault: the BODY hops the wall, the ball is left behind (pops loose)');
}

// ---------------------------------------------------------------------------
// 5. precise-strip (strip-window) — a clean strip instead of a lucky one
// ---------------------------------------------------------------------------
console.log('\n--- strip helper ---');
{
  // Today the detach side is the sim's ONLY strip randomness: (rnd()*2-1)*DETACH_SIDE.
  let identical = true;
  for (let i = 0; i <= 100; i++) { const r = i / 100; if (stripDetachSide([], r) !== (r * 2 - 1) * DETACH_SIDE) identical = false; }
  ok(identical, 'without the technique the detach side is BIT-IDENTICAL to the formula in sim.js today');
  let clean = true, bounded = true;
  for (let i = 0; i <= 100; i++) {
    const r = i / 100;
    if (stripDetachSide(FX.strip, r) !== 0) clean = false;
    if (Math.abs(stripDetachSide([], r)) > DETACH_SIDE) bounded = true && bounded && false;
  }
  ok(clean, 'with precise-strip the ball comes off CLEAN — zero sideways scatter, for every possible roll');
  ok(bounded, `the legacy side is bounded by DETACH_SIDE (${DETACH_SIDE})`);
  eq(stripDetachSide(FX.strip, NaN), 0, 'garbage roll + technique → still a clean 0');
  eq(stripDetachSide([], 0.5), 0, 'a mid roll is 0 either way (the formula is centred)');
}
console.log('--- strip in a match ---');
// A full AIMED bullet from A strips carrier B. Returns the ball velocity at the instant it detaches.
function stripBall(effectsA, seed) {
  const s = duel(effectsA, []);
  s.rng = makeRng(seed);
  giveBall(s, 'B');
  s.ball.x = s.players.B.x - 10; // between them, so the bullet hits the held ball
  charge(s, 1);
  step(s, { A: inp({ fire: true, aimed: true }), B: inp() }, DT);
  for (let t = 0; t < 30; t++) {
    step(s, { A: inp(), B: inp() }, DT);
    if (s.ball.owner !== 'B') return { vx: s.ball.vx, vy: s.ball.vy };
  }
  return null;
}
{
  const a = stripBall([], 1), b = stripBall([], 12345);
  ok(a && b, 'a full aimed shot strips the carrier (both seeds)');
  ok(a && b && Math.abs(a.vy) > 1 && Math.abs(a.vy - b.vy) > 1,
    `MUST NOT CHANGE: without the technique the detach is RANDOM per seed (vy ${a ? a.vy.toFixed(0) : '?'} vs ${b ? b.vy.toFixed(0) : '?'})`);
  const c = stripBall(FX.strip, 1), d = stripBall(FX.strip, 12345);
  // DISCRIMINATOR: vy === 0 exactly. Unwired both seeds keep their random sideways kick. The
  // same-power clause rides along (on its own it passes unwired — the strip power is unchanged).
  acc(!!c && !!d && Math.abs(c.vy) < 1e-9 && Math.abs(d.vy) < 1e-9 && c.vx === d.vx
      && Math.abs(Math.hypot(c.vx, c.vy) - Math.abs(a.vx)) < Math.abs(a.vx) * 0.2,
    'precise-strip: the ball detaches straight down the shot line at the SAME power — identical on every seed (removes the sim\'s last RNG for this player)');
}

// ---------------------------------------------------------------------------
// 6. chain-super (carry-super-use) — an unused use is banked, never multiplied
// ---------------------------------------------------------------------------
console.log('\n--- chain-super helper ---');
eq(bankSuperUses([], 3), 0, 'no technique → nothing is banked');
eq(bankSuperUses(FX.chain, 0), 0, 'nothing left over → nothing to bank');
eq(bankSuperUses(FX.chain, 1), 1, 'one unused use is kept');
eq(bankSuperUses(FX.chain, SUPER_USES), SUPER_USES > SUPER_BANK_MAX ? SUPER_BANK_MAX : SUPER_USES, `the bank is capped at SUPER_BANK_MAX (${SUPER_BANK_MAX}) — hoarding a whole super is a stat buff`);
eq(bankSuperUses(FX.chain, -2), 0, 'a negative leftover banks nothing');
eq(bankSuperUses(FX.chain, NaN), 0, 'NaN leftover banks nothing');
eq(superUsesOnFill([], 1), SUPER_USES, 'no technique → a fresh super is EXACTLY SUPER_USES even if a stale bank exists');
eq(superUsesOnFill(FX.chain, 0), SUPER_USES, 'with the technique but an empty bank → unchanged');
eq(superUsesOnFill(FX.chain, 1), SUPER_USES + 1, 'a banked use rides along into the next super');
eq(superUsesOnFill(FX.chain, 99), SUPER_USES + SUPER_BANK_MAX, 'and the ceiling holds against a corrupt bank');
ok(SUPER_BANK_MAX === 1, 'SUPER_BANK_MAX is 1 — see the design doc: Supercell moved Gadgets OFF banked uses onto cooldowns');

console.log('--- chain-super in a match ---');
// Let a READY super lapse with `leftover` uses unspent, then earn a fresh one and report its uses.
function lapseThenRefill(effectsA, leftover) {
  const s = duel(effectsA, []);
  const A = s.players.A;
  A.power = true; A.powerT = DT * 1.5; A.powerUses = leftover; A.powerMeter = 0;
  idle(s, 3);                       // TTL lapses → spendSuper
  if (A.power) return { lapsed: false, uses: A.powerUses };
  A.powerMeter = 0.8;               // one quick hit (+1/3) will fill it
  step(s, { A: inp({ fire: true, aimed: false }), B: inp() }, DT);
  for (let t = 0; t < 20 && !A.power; t++) idle(s, 1);
  return { lapsed: true, uses: A.powerUses, power: A.power };
}
{
  const plain = lapseThenRefill([], 2);
  ok(plain.lapsed && plain.power, 'a lapsed super can be re-earned by landing a hit');
  eq(plain.uses, SUPER_USES, 'MUST NOT CHANGE: without the technique a fresh super is exactly SUPER_USES');
  const chained = lapseThenRefill(FX.chain, 2);
  // DISCRIMINATOR: uses === SUPER_USES + 1. Unwired the leftover is destroyed by spendSuper.
  acc(chained.power === true && chained.uses === SUPER_USES + 1,
    `chain-super: an unused use survives the lapse into the next super (${chained.uses} vs ${SUPER_USES})`);
  const spentDry = lapseThenRefill(FX.chain, 0);
  ok(spentDry.uses === SUPER_USES, 'a super you used up completely banks nothing (conservation, not amplification)');
}
{
  // MUST NOT CHANGE: a kickoff wipes super state. Whatever the bank is, it cannot cross a goal —
  // otherwise it stops being "don't waste this cycle" and becomes a stockpile.
  const s = duel(FX.chain, []);
  const A = s.players.A;
  A.power = true; A.powerUses = 3; A.superBank = 1;
  s.score.A = 1; s.lastGoal = 'A'; s.pendingReset = true; s.pendingBallTeam = 'B'; s.resetTimer = 3;
  for (let i = 0; i < 200 && s.resetTimer > 0; i++) idle(s, 1);
  ok(A.power === false && (A.powerUses | 0) === 0, 'a kickoff clears super + uses (today\'s repositionKickoff)');
  acc(!A.superBank, 'chain-super: ...and it must clear the BANK too, or the bank becomes a match-long stockpile');
}

// ---------------------------------------------------------------------------
console.log('');
console.log(fails === 0 ? `ALL PASS  (${pending} acceptance criteria PENDING — sim not wired; ${promoted} newly green)`
                        : `${fails} FAILURE(S)   (${pending} PENDING, ${promoted} newly green)`);
if (promoted > 0) console.log('NOTE: some acceptance criteria now pass — the effect got wired. Promote those acc() calls to ok().');
process.exit(fails === 0 ? 0 : 1);
