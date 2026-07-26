// THE KICKOFF RULE (user, 2026-07-26): "the ball starting position in all games starting from the
// middle. when a team concedes then the ball starts with one of their players."
//
// Two rules that are easy to break by accident and invisible in a screenshot:
//   1. Every match starts with the ball LOOSE in the exact centre — not handed to a team, and not at
//      a per-field authored spot. `field.ball` used to override this, so a saved arena could start
//      the ball in a corner.
//   2. After a goal it starts WITH the conceding team — and with their most CENTRAL player, because
//      handing it to slot 0 in 3v3/5v5 restarts the game from a wing.
//
// Also pinned: the builder draws the same formation the match uses. That coupling is the whole point
// of formationSlot living in field-spawns.js — a field with no authored slots used to render an
// EMPTY pitch in the builder while the match used an invisible formula.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createState, addPlayer, attachBall, setField, step } from './shared/sim.js';
import { FIELD, GOAL_RESET } from './shared/constants.js';
import { formationSlot, defaultSpawns } from './shared/field-spawns.js';

const here = dirname(fileURLToPath(import.meta.url));
const R = (p) => readFileSync(join(here, p), 'utf8');
let failed = 0;
const ok = (l, c, x = '') => { if (!c) failed++; console.log(`  ${c ? '✅' : '❌'} ${l}${x ? ` — ${x}` : ''}`); };

const CX = FIELD.W / 2, CY = FIELD.H / 2;
const mk = (n) => {
  const s = createState();
  s.teamSize = n;
  for (const t of ['A', 'B']) for (let i = 0; i < n; i++) addPlayer(s, `${t}${i}`, { team: t, slot: i, name: `${t}${i}` });
  return s;
};

console.log('1) every match starts with the ball loose in the middle');
for (const n of [1, 2, 3, 5]) {
  const s = mk(n);
  attachBall(s);
  ok(`${n}v${n}`, Math.round(s.ball.x) === CX && Math.round(s.ball.y) === CY && s.ball.owner === null,
    `(${Math.round(s.ball.x)},${Math.round(s.ball.y)}) owner=${s.ball.owner}`);
}
{
  const s = mk(2);
  attachBall(s);
  ok('and it is not moving', s.ball.vx === 0 && s.ball.vy === 0);
  ok('and nobody is credited with the last touch (a kickoff is not a pass)',
    !s.ball.lastPlayer && !s.ball.prevPlayer);
}

console.log('\n2) after a goal the ball starts with the CONCEDING team');
for (const n of [1, 2, 3, 5]) for (const conceded of ['A', 'B']) {
  const s = mk(n);
  attachBall(s, conceded);
  const h = s.players[s.ball.owner];
  ok(`${n}v${n}, ${conceded} conceded`, !!h && h.team === conceded, h ? `owner is on ${h.team}` : 'NO OWNER');
}
console.log('   ...and with their most CENTRAL player, not a winger');
for (const n of [3, 5]) for (const conceded of ['A', 'B']) {
  const s = mk(n);
  attachBall(s, conceded);
  const h = s.players[s.ball.owner];
  const mates = Object.values(s.players).filter((p) => p.team === conceded);
  const best = Math.min(...mates.map((p) => Math.abs(p.y - CY)));
  ok(`${n}v${n} ${conceded}`, !!h && Math.abs(h.y - CY) <= best + 1,
    h ? `owner y ${Math.round(h.y)} (best ${Math.round(best + CY)} off-centre by ${Math.round(best)})` : 'NO OWNER');
}
{
  // A team can be short-handed (a disconnect between the goal and the kickoff). Falling through to
  // "no owner anywhere" would leave the ball nowhere; it must degrade to the centre.
  const s = createState(); s.teamSize = 2;
  addPlayer(s, 'B0', { team: 'B', slot: 0 });
  attachBall(s, 'A');
  ok('a conceding team with no players left falls back to the centre, loose',
    Math.round(s.ball.x) === CX && s.ball.owner === null, `(${Math.round(s.ball.x)},${Math.round(s.ball.y)}) owner=${s.ball.owner}`);
}

console.log('\n3) a per-field authored ball spot can no longer override the rule');
{
  const s = mk(2);
  setField(s, { version: 3, size: 'sMid', ball: { x: 120, y: 90 }, spawns: [] });
  ok('setField does not keep an authored ball spot at all', s.ballSpawn === undefined,
    `ballSpawn=${JSON.stringify(s.ballSpawn)}`);
  attachBall(s);
  ok('match start still centres it', Math.round(s.ball.x) === CX && Math.round(s.ball.y) === CY,
    `(${Math.round(s.ball.x)},${Math.round(s.ball.y)})`);
  attachBall(s, 'A');
  ok('a concede still hands it to a player', s.ball.owner !== null, `owner=${s.ball.owner}`);
}
const sim = R('shared/sim.js');
ok('there is no ballStart() left to reintroduce the override', !/function ballStart/.test(sim));
// The post-goal path used to seed the ball from the authored spot and only call attachBall when a
// team was known — two places deciding one thing. attachBall must be called unconditionally.
const rk = sim.slice(sim.indexOf('function repositionKickoff'), sim.indexOf('function repositionKickoff') + 1400);
ok('repositionKickoff always defers to attachBall (not `if (ballTeam)`)',
  /attachBall\(state, ballTeam\)/.test(rk) && !/if \(ballTeam\) attachBall/.test(rk));

console.log('\n4) the builder and the match agree on where players stand');
// formationSlot is the single source. If sim.js ever re-inlines the maths, the builder's markers and
// the real spawns drift apart silently — the exact bug this replaced.
// Read the BODY of spawnPos, not the whole file — the comment above it quotes the old broken
// formula on purpose, and matching prose made this assert fail while the code was correct.
const spBody = sim.slice(sim.indexOf('function spawnPos('));
const spOnly = spBody.slice(spBody.indexOf('{'), spBody.indexOf('\n}')).replace(/\/\/[^\n]*/g, '');
ok('spawnPos is a pure delegation to formationSlot, with no fy maths of its own',
  /formationSlot\(/.test(spOnly) && !/0?\.\d/.test(spOnly), spOnly.trim().replace(/\s+/g, ' ').slice(0, 90));
const client = R('public/client.js');
ok('the builder seeds the default formation when a field has no authored slots',
  /function fbSeedSpawns\(/.test(client) && /defaultSpawns\(/.test(client));
for (const n of [1, 2, 3, 5]) {
  const seeded = defaultSpawns(n, { W: FIELD.W, H: FIELD.H });
  const live = mk(n);
  const drift = Object.values(live.players).map((p) => {
    const want = seeded.find((s) => s.team === p.team && Math.round(s.x) === Math.round(p.x) && Math.round(s.y) === Math.round(p.y));
    return want ? 0 : 1;
  }).reduce((a, b) => a + b, 0);
  ok(`${n}v${n}: every real spawn has a matching builder marker`, seeded.length === n * 2 && drift === 0,
    `${seeded.length} markers, ${drift} unmatched`);
}
{
  // Mirrored halves: A's slot i and B's slot i must be the same distance from their own goal, or one
  // team kicks off closer to the middle than the other.
  let asym = 0;
  for (const n of [2, 3, 5]) for (let i = 0; i < n; i++) {
    const a = formationSlot('A', i, n, { W: FIELD.W, H: FIELD.H });
    const b = formationSlot('B', i, n, { W: FIELD.W, H: FIELD.H });
    if (Math.abs(a.x - (FIELD.W - b.x)) > 0.5 || Math.abs(a.y - b.y) > 0.5) asym++;
  }
  ok('the two halves are exact mirrors', asym === 0, `${asym} asymmetric slots`);
}
{
  // Nobody may start inside a teammate, which is what `slot === 0 ? .36 : .64` did for 3+.
  let stacked = 0;
  for (const n of [2, 3, 5]) {
    const pts = defaultSpawns(n, { W: FIELD.W, H: FIELD.H });
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
      if (Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y) < 40) stacked++;
    }
  }
  ok('no two players share a spot in any format', stacked === 0, `${stacked} overlapping pairs`);
}
{
  // Everyone starts in their OWN half, near their own goal — A defends left.
  let wrong = 0;
  for (const n of [1, 2, 3, 5]) for (const p of defaultSpawns(n, { W: FIELD.W, H: FIELD.H })) {
    if (p.team === 'A' ? p.x >= CX : p.x <= CX) wrong++;
    if (p.y < 0 || p.y > FIELD.H) wrong++;
  }
  ok('every slot is in its own half and on the pitch', wrong === 0, `${wrong} bad slots`);
}

console.log('\n5) the builder no longer offers a ball tool');
const html = R('public/index.html');
ok('no ⚽ tool button in the materials rail', !/data-tool="ball"/.test(html));
ok('the client has no ball-placement branch', !/fbTool === 'ball'/.test(client));
ok('and no ball marker is drawn', !/mk\('ball'/.test(client));
// The capacity badge used to append a ⚽ chip and show the ball rule ONLY when the field carried a
// legacy ball point — i.e. the fields where it was least true. It now applies to every field, so it
// is stated unconditionally and the chip is gone.
const cap = client.slice(client.indexOf('function fbUpdateCap'), client.indexOf('function fbUpdateCap') + 1400);
ok('no ⚽ chip on the capacity badge', !/ballTx/.test(cap));
ok('the kickoff rule is in the tooltip for EVERY field, not gated on fbField.ball',
  /הכדור תמיד מתחיל במרכז/.test(cap) && !/fbField\.ball \?/.test(cap));
ok('the format hint is spaced like the capacity ("2 נגד 2", not "2נגד2")',
  !/\}נגד\$\{/.test(cap));

console.log('\n6) END TO END: a real goal, stepped through the sim, restarts with the conceding team');
// Everything above calls attachBall directly. This drives an actual goal through step() so the whole
// chain is covered: goal() picking pendingBallTeam, the GOAL_RESET freeze, rollBallIntoNet, and
// repositionKickoff. A unit test on attachBall alone would still pass if goal() named the wrong team.
for (const n of [2, 3, 5]) for (const scorer of ['A', 'B']) {
  const s = mk(n);
  s.phase = 'match';
  const b = s.ball;
  // A attacks the RIGHT net, B the LEFT. lastTouch must name the attacker or the goal line acts as a
  // solid wall (no own goals), and the ball simply bounces.
  b.owner = null; b.lastTouch = scorer; b.lastKicker = `${scorer}0`;
  b.y = CY; b.x = scorer === 'A' ? FIELD.W - 10 : 10; b.vx = scorer === 'A' ? 600 : -600; b.vy = 0;
  let scored = false;
  for (let i = 0; i < 60 && !scored; i++) { step(s, {}, 1 / 60); if (s.score.A || s.score.B) scored = true; }
  const conceded = scorer === 'A' ? 'B' : 'A';
  const pb = s.pendingBallTeam;
  for (let i = 0; i < Math.ceil((GOAL_RESET + 0.5) * 60); i++) step(s, {}, 1 / 60);
  const h = s.players[s.ball.owner];
  const mates = Object.values(s.players).filter((p) => p.team === conceded);
  const best = Math.min(...mates.map((p) => Math.abs(p.y - CY)));
  ok(`${n}v${n}: ${scorer} scores -> ${conceded} restarts with it`,
    scored && pb === conceded && !!h && h.team === conceded && Math.abs(h.y - CY) <= best + 1,
    !scored ? 'NO GOAL DETECTED' : `pendingBallTeam=${pb}, restart owner ${s.ball.owner} (team ${h && h.team}, y ${h && Math.round(h.y)})`);
}
{
  const s = mk(2); s.phase = 'match';
  for (let i = 0; i < 10; i++) step(s, {}, 1 / 60);
  ok('a fresh match stepped forward still has the ball loose in the centre',
    Math.abs(s.ball.x - CX) < 1 && s.ball.owner === null, `(${Math.round(s.ball.x)},${Math.round(s.ball.y)}) owner=${s.ball.owner}`);
}

console.log(failed ? `\n❌ ${failed} failed` : '\n✅ all passed');
process.exit(failed ? 1 : 0);
