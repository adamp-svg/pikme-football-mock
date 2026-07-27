// BOT SKILL CENSUS — "can the bots actually USE every skill, on ANY arena?"
//
// The two research handoffs (summery/bots logic handoff/) catalogue 16 measured skills and claim
// several of them are unreachable in a real match. Both measured them in FIXTURES (hand-authored
// scenes). This harness answers the different question: in a REAL match, at a REAL difficulty
// level, on SEVERAL DIFFERENT ARENAS — which of them ever fires?
//
// Two instruments in one pass:
//   1. TAG HISTOGRAM — every `bm.lastTrick` episode (46 tags exist in bot-ai.js). A tag with 0
//      episodes is a branch the game never reaches; a skill with no tag at all is measured below.
//   2. MECHANICAL EVENTS — the catalogue skills that have NO tag are detected from sim state
//      transitions instead (bullet-ball, snooker deflection, bomb clearance, cannon pass, fragile
//      snipe, rocket jump, super earn/spend, out-of-range shots).
//
// ARENA SENSITIVITY is the point of the arena loop: the game ships a FIELD BUILDER, so the layout
// is data. Anything in bot-ai that is hardcoded to one arena shows up here as a per-arena split.
// `ballBlind%` in particular is the phantom-bush defect (shared/arena.js pointInBush ignores
// state.arena) measured on each layout.
//
// Usage:  node bot-skill-census.mjs                       (L10 as shipped, 4x60s per arena)
//         MATCHES=8 SECS=90 MIRROR=1 node bot-skill-census.mjs
//         JSON=out.json node bot-skill-census.mjs         (dump the raw counters)
import { createState, addPlayer, attachBall, step, setField } from './shared/sim.js';
import { MAIN_FIELD } from './shared/main-field.js';
import { FIELD_3V3 } from './shared/field-3v3.js';
import { computeBotInputs, createBotMemory, bmemForTest } from './shared/bot-ai.js';
import { pointInBush } from './shared/arena.js';
import { levelAt } from './shared/difficulty.js';
import {
  DT, FIELD, GOAL, BALL_RADIUS, BOMB, BUSH_REVEAL_DIST, FULL_CHARGE,
} from './shared/constants.js';
import fs from 'node:fs';

const LEVEL = parseInt(process.env.LEVEL || '10', 10);
const MIRROR = process.env.MIRROR === '1';        // both sides get the ENEMY skill (a fair bot-vs-bot show match)
const MATCHES = parseInt(process.env.MATCHES || '4', 10);
const SECS = parseInt(process.env.SECS || '60', 10);
const SEEDBASE = parseInt(process.env.SEEDBASE || '20260726', 10);
const TICKS = Math.round(SECS / DT);
const L = levelAt(LEVEL);
const SKILLS = MIRROR ? { A: L.enemy, B: L.enemy } : { A: L.partner, B: L.enemy };

// ---------- seeded RNG (installed over Math.random AND state.rng, like bot-feel.mjs) ----------
let _s = 1;
function lcg() { _s = (_s * 1664525 + 1013904223) >>> 0; return _s / 4294967296; }
Math.random = lcg;

// ---------- the arenas ----------
// A procedural layout generator, because "the arena can change" is the whole question: the field
// builder can emit layouts nobody has ever tested the bots on. Mirror-symmetric about both axes,
// like every shipped field, and it never blocks a goal mouth outright.
function randomField(seed) {
  let r = seed >>> 0;
  const rnd = () => ((r = (r * 1664525 + 1013904223) >>> 0) / 4294967296);
  const pick = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const snap = (v) => Math.round(v / 50) * 50;
  const f = { version: 1, bushes: [], hardWalls: [], dryWalls: [], crates: [] };
  const mirror4 = (x, y, w, h, push) => {
    push(x, y, w, h); push(FIELD.W - x - w, y, w, h);
    push(x, FIELD.H - y - h, w, h); push(FIELD.W - x - w, FIELD.H - y - h, w, h);
  };
  for (let i = 0; i < pick(1, 3); i++) {
    const w = snap(pick(120, 320)), h = snap(pick(120, 300));
    const x = snap(pick(150, 900 - w / 2)), y = snap(pick(60, 480 - h / 2));
    mirror4(x, y, w, h, (a, b, c, d) => f.bushes.push({ x: a, y: b, w: c, h: d }));
  }
  for (let i = 0; i < pick(1, 3); i++) {
    const s = snap(pick(50, 150));
    const x = snap(pick(250, 900)), y = snap(pick(100, 500));
    mirror4(x, y, s, s, (a, b, c, d) => f.crates.push({ x: a, y: b, w: c, h: d }));
  }
  for (let i = 0; i < pick(1, 2); i++) {
    const hl = pick(90, 200), vert = rnd() < 0.5;
    const cx = snap(pick(320, 900)), cy = snap(pick(180, 480));
    const ang = vert ? Math.PI / 2 : 0;
    // 4-way mirror of a capsule centre
    for (const [mx, my] of [[cx, cy], [FIELD.W - cx, cy], [cx, FIELD.H - cy], [FIELD.W - cx, FIELD.H - cy]])
      f.hardWalls.push({ cx: mx, cy: my, angle: ang, hl, ht: 16 });
  }
  return f;
}

const CLASSIC = {
  version: 1,
  bushes: [{ x: 850, y: 430, w: 300, h: 240 }, { x: 250, y: 470, w: 180, h: 160 }, { x: 1570, y: 470, w: 180, h: 160 }],
  hardWalls: [], dryWalls: [],
  crates: [{ x: 560, y: 250, w: 120, h: 120 }, { x: 1320, y: 250, w: 120, h: 120 },
           { x: 560, y: 730, w: 120, h: 120 }, { x: 1320, y: 730, w: 120, h: 120 }],
};
const ARENAS = [
  ['main (ships)', MAIN_FIELD],
  ['threes (3v3 layout)', FIELD_3V3],
  ['classic (old default)', CLASSIC],
  ['empty', { version: 1, bushes: [], hardWalls: [], dryWalls: [], crates: [] }],
  ['random#1', randomField(11)],
  ['random#2', randomField(4242)],
  ['random#3', randomField(991)],
];

// ---------- helpers mirrored from the sim/bot rules ----------
const hyp = Math.hypot;
const R = 21; // CHARACTERS.player.radius
function inRealBush(state, x, y) {
  for (const g of (state.arena && state.arena.bushes) || []) {
    if (x > g.x && x < g.x + g.w && y > g.y && y < g.y + g.h) return true;
  }
  return false;
}
// what a full-charge kick reaches (bot-ai.js ballRollPx(state,1) — kept in sync by formula)
function maxReach(state) {
  const v0 = (state.settings.shotPower || 1400) * 1;
  return Math.max(0, 0.468 * (v0 - 18));
}

// ---------- run ----------
const rows = [];
const tagTotals = {};
const evTotals = {};
for (const [aname, field] of ARENAS) {
  const tags = {};
  const ev = {
    bulletBall: 0, snooker: 0, bombClear: 0, cannonPass: 0, cannonPassLost: 0, rocketJump: 0,
    fragileSnipe: 0, wallShotDown: 0, superEarn: 0, superSpend: 0,
    goals: 0, releases: 0, goalwardKicks: 0, goalwardShort: 0, shotsAtGoal: 0, shotsAtGoalShort: 0, bullets: 0, bombs: 0, builds: 0,
    relChargeSum: 0, dribbleTouch: 0, weakKick: 0,
    ticks: 0, looseTicks: 0, blindTicks: 0, phantomTicks: 0, realBushLoose: 0, blindWorst: 0,
  };
  for (let mi = 0; mi < MATCHES; mi++) {
    _s = (SEEDBASE * 7919 + mi * 104729) >>> 0;
    const s = createState(); s.resetTimer = 0; s.goalsToWin = 0;
    if (field) setField(s, field);
    s.rng = lcg;
    for (const [id, team, slot] of [['A0', 'A', 0], ['A1', 'A', 1], ['B0', 'B', 0], ['B1', 'B', 1]])
      addPlayer(s, id, { name: id, char: 'player', team, slot, isBot: true });
    attachBall(s, lcg() < 0.5 ? 'A' : 'B');
    const mem = createBotMemory('normal');
    mem.teamSkill = { ...SKILLS };
    const REACH = maxReach(s);

    const lastTag = {};
    let prevScore = 0, blindRun = 0;
    for (let t = 0; t < TICKS; t++) {
      const inp = computeBotInputs(s, mem, DT);
      // FROZEN = the goal celebration (sim.js:646 returns before the player loop). Bots keep
      // emitting `fire` all the way through it — a charging latch has nothing to cancel it — so
      // counting inputs here inflated one match's releases from ~12 to 171. Check it BEFORE the
      // step: after it, resetTimer has already been decremented (and cleared) for this tick.
      const frozen = s.resetTimer > 0;
      // --- pre-step snapshot of everything a detector needs ---
      const pre = {
        owner: s.ball.owner,
        ball: { x: s.ball.x, y: s.ball.y, sp: hyp(s.ball.vx, s.ball.vy) },
        bombs: s.bombs.map((b) => ({ id: b.id, x: b.x, y: b.y, owner: b.owner, fuse: b.fuse })),
        walls: s.builtWalls.map((w) => ({ id: w.wallId != null ? w.wallId : w.id, maxHp: w.maxHp || w.hp || 3, cx: w.cx, cy: w.cy, x: w.x, y: w.y })),
        proj: s.projectiles.map((p) => ({ x: p.x, y: p.y, vx: p.vx, vy: p.vy, team: p.team })),
        pl: {},
      };
      for (const id in s.players) {
        const p = s.players[id];
        pre.pl[id] = { x: p.x, y: p.y, sp: hyp((p.vx || 0) + (p.kvx || 0), (p.vy || 0) + (p.kvy || 0)), kv: hyp(p.kvx || 0, p.kvy || 0), power: !!p.power };
      }
      // inputs the bot ASKED for
      if (!frozen) for (const id in inp) {
        const i = inp[id]; if (!i) continue;
        if (i.fire) { if (s.ball.owner === id) ev.releases++; else ev.bullets++; }
        if (i.special) ev.bombs++;
        if (i.build) ev.builds++;
        // A RELEASE, classified by its OWN aim — not by a tag, because the release ladder's
        // first rung (bot-ai.js:1727 `distGoal < 1150`) sets no tag at all. That rung is the
        // documented out-of-range-shot defect, so this is the only way to count it.
        if (i.fire && s.ball.owner === id) {
          const p = s.players[id];
          const egX = p.team === 'A' ? FIELD.W : 0, GY = FIELD.H / 2;
          const dGoal = hyp(egX - p.x, GY - p.y);
          const ga = Math.atan2(GY - p.y, egX - p.x), aa = Math.atan2(i.aimY, i.aimX);
          const off = Math.abs(((aa - ga + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
          // AIM-ANGLE metric, kept for continuity — but it counts `clearForward` too, which is a
          // goalward CLEARANCE fired from out of range ON PURPOSE. Treat it as "goalward kicks", not
          // as "shots at goal".
          if (off < 0.44) {
            ev.goalwardKicks++;
            if (dGoal > REACH) ev.goalwardShort++;
          }
          // THE SHARP ONE: the release ladder's shot-at-goal rung, which is now tagged. A single one of
          // these beyond `ballRollPx(state, 1)` means the range gate leaked.
          const tag = bmemForTest(mem, id).lastTrick;
          if (tag === 'ladderShot' || tag === 'drive' || tag === 'postFinish' || tag === 'cornerFinish' || tag === 'overFinish') {
            ev.shotsAtGoal++;
            if (dGoal > REACH) ev.shotsAtGoalShort++;
          }
          // How hard was it actually kicked? Under QUICK_CHARGE the sim turns the release into a
          // 64px DRIBBLE TOUCH (sim.js:834), which is a different act from a kick and explains
          // any arena where the release count explodes.
          const ch = s.players[id]._charge || 0;
          ev.relChargeSum += ch;
          if (ch < 0.25) ev.dribbleTouch++;
          else if (ch < FULL_CHARGE) ev.weakKick++;  // below FULL_CHARGE a field defender CATCHES it
        }
      }
      step(s, inp, DT);
      ev.ticks++;

      // --- tag histogram (episodes: a tag counts once per continuous run) ---
      if (!frozen) for (const id in s.players) {
        const tag = bmemForTest(mem, id).lastTrick || null;
        if (tag && tag !== lastTag[id]) tags[tag] = (tags[tag] || 0) + 1;
        lastTag[id] = tag;
      }

      if (s.score.A + s.score.B !== prevScore) { ev.goals += s.score.A + s.score.B - prevScore; prevScore = s.score.A + s.score.B; }
      if (frozen || s.resetTimer > 0) { blindRun = 0; continue; }

      // --- bullet-vs-loose-ball (T4 bullet-ball / S3 snooker) ---
      const nowSp = hyp(s.ball.vx, s.ball.vy);
      if (!pre.owner && !s.ball.owner && nowSp > pre.ball.sp + 120) {
        let near = null, bd = 1e9;
        for (const pr of pre.proj) { const d = hyp(pr.x - pre.ball.x, pr.y - pre.ball.y); if (d < bd) { bd = d; near = pr; } }
        if (near && bd < 90) {
          ev.bulletBall++;
          const a0 = Math.atan2(near.vy, near.vx), a1 = Math.atan2(s.ball.vy, s.ball.vx);
          let dth = Math.abs(((a1 - a0 + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
          if (dth > 0.35) ev.snooker++;   // >20 deg off the bullet's line = a deliberate-looking deflection
        }
      }
      // --- bomb blasts: who did it move? (T1 cannon pass, T5 bomb clearance, rocket jump) ---
      const gone = pre.bombs.filter((b) => !s.bombs.some((x) => x.id === b.id) && b.fuse <= DT * 2 + 0.001);
      for (const b of gone) {
        if (!pre.owner && hyp(b.x - pre.ball.x, b.y - pre.ball.y) < BOMB.radius && nowSp > pre.ball.sp + 80) ev.bombClear++;
        for (const id in s.players) {
          const p = s.players[id], q = pre.pl[id];
          if (hyp(b.x - q.x, b.y - q.y) > BOMB.radius) continue;
          const jumped = hyp((p.vx || 0) + (p.kvx || 0), (p.vy || 0) + (p.kvy || 0)) > q.sp + 250
            || hyp(p.kvx || 0, p.kvy || 0) > q.kv + 250;
          if (!jumped) continue;
          if (b.owner === id) ev.rocketJump++;
          else if (pre.owner === id) { if (s.ball.owner === id) ev.cannonPass++; else ev.cannonPassLost++; }
        }
      }
      // --- built walls destroyed (T6 fragile snipe / shooting a wall down) ---
      for (const w of pre.walls) {
        if (s.builtWalls.some((x) => (x.wallId != null ? x.wallId : x.id) === w.id)) continue;
        const wx = w.cx != null ? w.cx : (w.x || 0), wy = w.cy != null ? w.cy : (w.y || 0);
        const hitByBullet = pre.proj.some((pr) => hyp(pr.x - wx, pr.y - wy) < 190);
        if (!hitByBullet) continue;
        ev.wallShotDown++;
        if ((w.maxHp || 3) <= 1) ev.fragileSnipe++;
      }
      // --- super meter ---
      for (const id in s.players) {
        const now = !!s.players[id].power;
        if (now && !pre.pl[id].power) ev.superEarn++;
        if (!now && pre.pl[id].power) ev.superSpend++;
      }
      // --- the phantom-bush blind spot, per arena ---
      if (!s.ball.owner) {
        ev.looseTicks++;
        const phantom = pointInBush(s.ball.x, s.ball.y);        // what bot-ai BELIEVES (default arena!)
        const real = inRealBush(s, s.ball.x, s.ball.y);          // what this arena actually has
        if (phantom && !real) ev.phantomTicks++;
        if (real) ev.realBushLoose++;
        let close = false;
        for (const id in s.players) if (hyp(s.players[id].x - s.ball.x, s.players[id].y - s.ball.y) < BUSH_REVEAL_DIST) close = true;
        if (phantom && !close) { ev.blindTicks++; blindRun++; ev.blindWorst = Math.max(ev.blindWorst, blindRun * DT); }
        else blindRun = 0;
      } else blindRun = 0;
    }
  }
  rows.push([aname, tags, ev]);
  for (const k in tags) tagTotals[k] = (tagTotals[k] || 0) + tags[k];
  for (const k in ev) evTotals[k] = (evTotals[k] || 0) + ev[k];
}

// ---------- report ----------
const MM = MATCHES * ARENAS.length; // matches per column total
const per = (n) => (n / MATCHES).toFixed(1);
console.log(`\nBOT SKILL CENSUS — level ${LEVEL} (${L.name}) skills A=${SKILLS.A} B=${SKILLS.B}${MIRROR ? ' [mirrored]' : ''}`);
console.log(`${MATCHES} matches x ${SECS}s per arena, ${ARENAS.length} arenas, seedbase ${SEEDBASE}\n`);

console.log('--- MECHANICAL EVENTS, per match, by arena ---');
const evKeys = ['goals', 'releases', 'dribbleTouch', 'weakKick', 'shotsAtGoal', 'shotsAtGoalShort', 'goalwardKicks', 'goalwardShort', 'bullets', 'bombs', 'builds', 'rocketJump',
  'cannonPass', 'cannonPassLost', 'bulletBall', 'snooker', 'bombClear', 'fragileSnipe', 'wallShotDown',
  'superEarn', 'superSpend'];
const w0 = 22;
console.log('event'.padEnd(w0) + rows.map(([n]) => n.slice(0, 11).padStart(12)).join('') + '     TOTAL');
for (const k of evKeys) {
  const cells = rows.map(([, , ev]) => (ev[k] / MATCHES).toFixed(1).padStart(12)).join('');
  console.log(k.padEnd(w0) + cells + (evTotals[k] / MM).toFixed(2).padStart(10));
}
console.log('\n--- BALL VISIBILITY (the phantom-bush defect, per arena) ---');
console.log('metric'.padEnd(w0) + rows.map(([n]) => n.slice(0, 11).padStart(12)).join(''));
for (const [k, f] of [
  ['loose%', ([, , e]) => (100 * e.looseTicks / e.ticks).toFixed(1)],
  ['phantom% of loose', ([, , e]) => (100 * e.phantomTicks / (e.looseTicks || 1)).toFixed(1)],
  ['BLIND% of loose', ([, , e]) => (100 * e.blindTicks / (e.looseTicks || 1)).toFixed(1)],
  ['blind s/match', ([, , e]) => (e.blindTicks * DT / MATCHES).toFixed(2)],
  ['worst blind run s', ([, , e]) => e.blindWorst.toFixed(2)],
  ['inRealBush% loose', ([, , e]) => (100 * e.realBushLoose / (e.looseTicks || 1)).toFixed(1)],
]) console.log(k.padEnd(w0) + rows.map((r) => String(f(r)).padStart(12)).join(''));

console.log('\n--- lastTrick EPISODES, per match, by arena (0 = the branch never runs) ---');
const allTags = Object.keys(tagTotals).sort((a, b) => tagTotals[b] - tagTotals[a]);
console.log('tag'.padEnd(w0) + rows.map(([n]) => n.slice(0, 11).padStart(12)).join('') + '     TOTAL');
for (const tg of allTags) {
  const cells = rows.map(([, tags]) => ((tags[tg] || 0) / MATCHES).toFixed(1).padStart(12)).join('');
  console.log(tg.padEnd(w0) + cells + (tagTotals[tg] / MM).toFixed(2).padStart(10));
}
// tags that exist in the source but never fired anywhere
const src = fs.readFileSync(new URL('./shared/bot-ai.js', import.meta.url), 'utf8');
const declared = new Set([...src.matchAll(/lastTrick\s*=\s*'([\w]+)'/g)].map((m) => m[1]));
for (const m of src.matchAll(/lastTrick\s*=\s*[\w.]+\s*\?\s*'([\w]+)'\s*:\s*'([\w]+)'/g)) { declared.add(m[1]); declared.add(m[2]); }
const dead = [...declared].filter((t) => !tagTotals[t]).sort();
console.log(`\nDECLARED IN SOURCE BUT NEVER FIRED (${dead.length}/${declared.size}): ${dead.join(', ') || '(none)'}`);

if (process.env.JSON) {
  fs.writeFileSync(process.env.JSON, JSON.stringify({ level: LEVEL, skills: SKILLS, matches: MATCHES, secs: SECS, rows }, null, 1));
  console.log(`\nwrote ${process.env.JSON}`);
}
