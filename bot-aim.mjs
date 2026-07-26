// BULLET AIM AUDIT — "the bots shoot the other way" (level 10 report), measured per SHOT.
//
// Not a gated test: an A/B instrument, paired seeds, same shape as bot-feel.mjs.
//   MATCHES=8 SECS=60 SKA=0.42 SKB=0.93 node bot-aim.mjs        # the level-10 pair
//   SKA=0.93 SKB=0.93 MATCHES=12 node bot-aim.mjs               # symmetric top tier
//
// WHAT IT CLASSIFIES, and why each class is defensible rather than a guess:
//
//  * RELEASE vs BULLET — `state.ball.owner === id` on the fire tick. Ball releases are ANOTHER
//    agent's area (the pass latch); they are counted and printed, never diagnosed here.
//
//  * angle off the nearest enemy — the emitted (aimX,aimY) vs the direction to EVERY enemy, taking
//    the best. Every bullet branch in bot-ai.js aims at an enemy PLAYER (press strip, cover strip,
//    keeper strip, ambush strip, clearMarker), so "more than 45deg off every enemy on the pitch"
//    needs no assumption about which one was intended: the bullet was pointed at nobody.
//
//  * GHOST (dead-reckoned) — perceivedPos() deliberately aims at an enemy's last-seen spot after
//    losing sight (anti-omniscience). That is CORRECT and must not be counted as a mis-aim, so the
//    aim is also compared against the shooter's own `bm.seen` memory, dead-reckoned exactly the way
//    perceivedPos does it. Within 45deg of the ghost => tagged ghost, not wide.
//
//  * STALE-CHARGE PROOF (`noBranch`) — the decisive one, and it needs no re-derivation of any
//    branch's conditions. EVERY bullet branch lives under `else if (carrier)` with the carrier an
//    ENEMY (press / cover / keeper / ambush), except `clearMarker`, which lives under "my MATE
//    carries" and always tags itself. So a bullet fired on a tick when the ball is LOOSE, or held
//    by our own team without a clearMarker tag, cannot have been asked for by any branch on that
//    tick: it is a `bm.charging` wind-up completing after its premise died, aimed by whatever
//    branch happened to run instead.
//
//  * OUTCOME — the projectile object is tracked by reference from the tick it spawns until the sim
//    consumes it, then matched to the impact the sim emitted on that tick (every consumption path in
//    updateProjectiles calls addImpact). player/ball = the bullet did something; wall = wasted.
import { createState, addPlayer, attachBall, step, setField } from './shared/sim.js';
import { MAIN_FIELD } from './shared/main-field.js';
import { DT, FIELD } from './shared/constants.js';
import { computeBotInputs, createBotMemory, bmemForTest, botCanSee, skillVec } from './shared/bot-ai.js';

const SK_A = parseFloat(process.env.SKA || '0.42');
const SK_B = parseFloat(process.env.SKB || '0.93');
const MATCHES = parseInt(process.env.MATCHES || '8', 10);
const SECS = parseInt(process.env.SECS || '60', 10);
const SEEDBASE = parseInt(process.env.SEEDBASE || '1234', 10);
const USE_MAIN = process.env.ARENA !== 'default';
const WIDE = parseFloat(process.env.WIDE || '45') * Math.PI / 180;
const TICKS = Math.round(SECS / DT);

let _s = 1;
function lcg() { _s = (_s * 1664525 + 1013904223) >>> 0; return _s / 4294967296; }
Math.random = lcg;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const angOff = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

// counters -----------------------------------------------------------------------------------
const C = {
  releases: 0, bullets: 0, strips: 0, goals: 0,
  // bullet classes (mutually exclusive, in this order)
  bNoVis: 0,        // no enemy visible to the shooter at all
  bGhost: 0,        // wide of every live enemy but ON the shooter's dead-reckoned memory (CORRECT)
  bWide: 0,         // > WIDE off every enemy, and not explained by a ghost
  bOk: 0,           // within WIDE of some enemy
  // why the wide/no-vis ones happened
  bNoBranch: 0,     // provably a stale wind-up: ball loose / ours, and not clearMarker
  bLoose: 0,        // ball was loose on the fire tick
  bOurs: 0,         // ball was held by our team on the fire tick
  bEnemyHeld: 0,    // ball was held by an enemy on the fire tick
  // outcomes
  oPlayer: 0, oBall: 0, oWall: 0, oUnknown: 0,
  oPlayerWide: 0, oBallWide: 0, oWallWide: 0,
};
const tagWide = {}, tagAll = {}, offHist = { '0-10': 0, '10-26': 0, '26-45': 0, '45-90': 0, '90-180': 0 };
const distWide = { '<200': 0, '200-400': 0, '400-600': 0, '>600': 0 };
const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };
// arm-vs-fire: did the wind-up outlive the premise that opened it?
const A = { armed: 0, ownerChanged: 0, ownerChangedBad: 0, sameTick: 0, ageSum: 0, ageBadSum: 0, ageBadN: 0 };
const byTeam = { A: { n: 0, bad: 0 }, B: { n: 0, bad: 0 } };
// IS THE FLAT `tol` ITSELF THE PROBLEM? A body is ~21px + 7px bullet, so the LATERAL miss at the
// target's own distance (d*sin(off)) is what decides a hit, not the angle. Bucketing the sim's
// verdict by angle AND by lateral miss says whether a distance-scaled tol would buy anything.
const BUCK = ['0-10', '10-26', '26-45', '45+'];
const hitBy = {}; for (const k of BUCK) hitBy[k] = { n: 0, player: 0, ball: 0, wall: 0 };
const latMiss = { '<30': 0, '30-80': 0, '80-200': 0, '>200': 0 };

for (let mi = 0; mi < MATCHES; mi++) {
  _s = (SEEDBASE * 7919 + mi * 104729) >>> 0;
  const s = createState(); s.resetTimer = 0;
  if (USE_MAIN) setField(s, MAIN_FIELD);
  s.rng = lcg;
  for (const [id, team, slot] of [['A0', 'A', 0], ['A1', 'A', 1], ['B0', 'B', 0], ['B1', 'B', 1]])
    addPlayer(s, id, { name: id, char: 'player', team, slot, isBot: true });
  attachBall(s, lcg() < 0.5 ? 'A' : 'B');
  const mem = createBotMemory('normal');
  mem.teamSkill = { A: SK_A, B: SK_B };
  const skOf = (p) => skillVec(p.team === 'A' ? SK_A : SK_B);

  const pending = [];   // projectiles awaiting a verdict: { pr, cls, tag }
  const arm = {};       // id -> { t, owner, tag } captured on the tick a BULLET wind-up opened
  let prevScore = 0;

  for (let t = 0; t < TICKS; t++) {
    const impBefore = new Set(s.impacts.map((i) => i.id));
    const known = new Set(s.projectiles);
    const inp = computeBotInputs(s, mem, DT);
    const fired = [];
    for (const id in inp) {
      const i = inp[id]; if (!i || !i.fire) continue;
      const p = s.players[id];
      if (s.ball.owner === id) { C.releases++; continue; }   // ball release — not ours to diagnose
      C.bullets++;
      byTeam[p.team].n++;
      const bm = bmemForTest(mem, id);
      const tag = bm.lastTrick || 'none';
      bump(tagAll, tag);
      const sk = skOf(p);
      const ang = Math.atan2(i.aimY, i.aimX);
      const enemies = Object.values(s.players).filter((q) => q.team !== p.team);
      let best = Math.PI, bestD = 0, nVis = 0, bestVis = Math.PI;
      for (const e of enemies) {
        const off = angOff(ang, Math.atan2(e.y - p.y, e.x - p.x));
        if (off < best) { best = off; bestD = Math.hypot(e.x - p.x, e.y - p.y); }
        if (botCanSee(p, e, s, sk)) { nVis++; if (off < bestVis) bestVis = off; }
      }
      // GHOST: aim sitting on the shooter's own dead-reckoned memory of an enemy it cannot see now
      let ghost = false;
      if (bm.seen) {
        const q = s.players[bm.seen.id];
        if (q && q.team !== p.team && !botCanSee(p, q, s, sk)) {
          const adv = clamp(mem.t - bm.seen.t, 0, sk.memoryS || 0.9);
          const gx = bm.seen.x + bm.seen.vx * adv, gy = bm.seen.y + bm.seen.vy * adv;
          if (angOff(ang, Math.atan2(gy - p.y, gx - p.x)) <= WIDE) ghost = true;
        }
      }
      const deg = best * 180 / Math.PI;
      offHist[deg < 10 ? '0-10' : deg < 26 ? '10-26' : deg < 45 ? '26-45' : deg < 90 ? '45-90' : '90-180']++;
      const buck = deg < 10 ? '0-10' : deg < 26 ? '10-26' : deg < 45 ? '26-45' : '45+';
      hitBy[buck].n++;
      const lat = bestD * Math.sin(Math.min(best, Math.PI / 2));
      latMiss[lat < 30 ? '<30' : lat < 80 ? '30-80' : lat < 200 ? '80-200' : '>200']++;
      let cls;
      if (nVis === 0 && !ghost) { C.bNoVis++; cls = 'noVis'; }
      else if (best > WIDE && ghost) { C.bGhost++; cls = 'ghost'; }
      else if (best > WIDE) { C.bWide++; cls = 'wide'; }
      else { C.bOk++; cls = 'ok'; }
      const bad = cls === 'wide' || cls === 'noVis';
      // arm-vs-fire bookkeeping (the "wind-up outlived its target" instrument)
      const a = arm[id];
      if (!a) A.sameTick++;
      else {
        A.armed++; A.ageSum += mem.t - a.t;
        if (a.owner !== s.ball.owner) { A.ownerChanged++; if (bad) A.ownerChangedBad++; }
        if (bad) { A.ageBadSum += mem.t - a.t; A.ageBadN++; }
      }
      if (bad) {
        byTeam[p.team].bad++;
        bump(tagWide, tag);
        bump(distWide, bestD < 200 ? '<200' : bestD < 400 ? '200-400' : bestD < 600 ? '400-600' : '>600');
        const owner = s.ball.owner ? s.players[s.ball.owner] : null;
        if (!owner) { C.bLoose++; C.bNoBranch++; }
        else if (owner.team === p.team) { C.bOurs++; if (tag !== 'clearMarker') C.bNoBranch++; }
        else C.bEnemyHeld++;
      }
      fired.push({ id, cls, tag, buck });
    }
    // refresh the arm records AFTER the fire pass (a fire nulls bm.charging, so the record above
    // is the one captured on an earlier tick — exactly what "outlived its premise" needs)
    for (const id in inp) {
      const bm = bmemForTest(mem, id), ch = bm.charging;
      if (ch && !ch.ball) { if (!arm[id]) arm[id] = { t: mem.t, owner: s.ball.owner, tag: bm.lastTrick || 'none' }; }
      else arm[id] = null;
    }
    step(s, inp, DT);
    // new projectiles from this tick's fires -> start tracking (by object reference)
    for (const pr of s.projectiles) {
      if (known.has(pr)) continue;
      const f = fired.find((q) => q.id === pr.owner);
      if (f) pending.push({ pr, cls: f.cls, buck: f.buck });
    }
    // verdicts: a tracked projectile that left s.projectiles was consumed this tick
    if (pending.length) {
      const live = new Set(s.projectiles);
      const fresh = s.impacts.filter((i) => !impBefore.has(i.id));
      for (let k = pending.length - 1; k >= 0; k--) {
        const it = pending[k];
        if (live.has(it.pr)) continue;
        pending.splice(k, 1);
        let bestI = null, bd = 1e9;
        for (const im of fresh) {
          const d = Math.hypot(im.x - it.pr.x, im.y - it.pr.y);
          if (d < bd) { bd = d; bestI = im; }
        }
        const kind = bestI && bd < 90 ? bestI.type : 'unknown';
        if (hitBy[it.buck] && kind !== 'unknown') hitBy[it.buck][kind]++;
        if (kind === 'player') { C.oPlayer++; if (it.cls === 'wide' || it.cls === 'noVis') C.oPlayerWide++; }
        else if (kind === 'ball') { C.oBall++; if (it.cls === 'wide' || it.cls === 'noVis') C.oBallWide++; }
        else if (kind === 'wall') { C.oWall++; if (it.cls === 'wide' || it.cls === 'noVis') C.oWallWide++; }
        else C.oUnknown++;
      }
    }
    if (s.score.A + s.score.B !== prevScore) { C.goals += s.score.A + s.score.B - prevScore; prevScore = s.score.A + s.score.B; }
  }
  for (const id in s.players) C.strips += s.players[id].stat.strips;
}

const per = (n) => +(n / MATCHES).toFixed(2);
const pct = (n, d) => +(100 * n / Math.max(1, d)).toFixed(1);
const top = (o, n = 6) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n)
  .map(([k, v]) => `${k}:${v}`).join(' ');

console.log(JSON.stringify({
  skA: SK_A, skB: SK_B, matches: MATCHES, secs: SECS, arena: USE_MAIN ? 'main' : 'default',
  bulletsPerMatch: per(C.bullets), releasesPerMatch: per(C.releases),
  stripsPerMatch: per(C.strips), goalsPerMatch: per(C.goals),
  // THE HEADLINE: share of bullets that pointed at nobody
  badBulletPct: pct(C.bWide + C.bNoVis, C.bullets),
  widePct: pct(C.bWide, C.bullets), noVisPct: pct(C.bNoVis, C.bullets),
  ghostPct: pct(C.bGhost, C.bullets), okPct: pct(C.bOk, C.bullets),
  badPerMatch: per(C.bWide + C.bNoVis),
  // where the bad ones come from
  noBranchPerMatch: per(C.bNoBranch),
  badBallState: { loose: C.bLoose, ourTeam: C.bOurs, enemyHeld: C.bEnemyHeld },
  // outcomes
  hitPlayerPct: pct(C.oPlayer, C.oPlayer + C.oBall + C.oWall + C.oUnknown),
  hitBallPct: pct(C.oBall, C.oPlayer + C.oBall + C.oWall + C.oUnknown),
  hitWallPct: pct(C.oWall, C.oPlayer + C.oBall + C.oWall + C.oUnknown),
  badHits: { player: C.oPlayerWide, ball: C.oBallWide, wall: C.oWallWide },
  offHistDeg: offHist, badTargetDistPx: distWide,
  lateralMissPx: latMiss,
  hitByAimErr: Object.fromEntries(BUCK.map((k) => [k, `n=${hitBy[k].n} player=${pct(hitBy[k].player, hitBy[k].n)}% ball=${pct(hitBy[k].ball, hitBy[k].n)}% wall=${pct(hitBy[k].wall, hitBy[k].n)}%`])),
  // did the wind-up outlive the premise that opened it?
  armFireOwnerChangedPct: pct(A.ownerChanged, A.armed),
  badArmFireOwnerChanged: A.ownerChangedBad, badN: C.bWide + C.bNoVis,
  windupS: +(A.ageSum / Math.max(1, A.armed)).toFixed(2),
  windupBadS: +(A.ageBadSum / Math.max(1, A.ageBadN)).toFixed(2),
  firedOnArmTick: A.sameTick,
  perTeam: { A: `${byTeam.A.bad}/${byTeam.A.n}`, B: `${byTeam.B.bad}/${byTeam.B.n}` },
  tagsAll: top(tagAll, 8), tagsBad: top(tagWide, 8),
}, null, 0));
