// bot-feel.mjs — the "does it FEEL right" meter. Not a gated test: a paired A/B instrument.
//
// Usage:  MATCHES=6 SECS=60 SKA=0.5 SKB=0.5 node bot-feel.mjs        # main arena (the default)
//         ARENA=default node bot-feel.mjs                            # the bare 4-wall arena
//         SEEDBASE=777 node bot-feel.mjs                             # a second, independent draw
//
// It is deliberately API-MINIMAL (createState/addPlayer/attachBall/step/setField/computeBotInputs)
// so the SAME file can be dropped into a `git archive <rev> shared` checkout of an OLD revision and
// run there — that is how the 2026-07-26 wall-jam regression was bisected to a single commit.
// Cross-revision bot "feel" meter: every revision is measured by its OWN sim + bot-ai with
// IDENTICAL inputs.
//
// Determinism: Math.random is replaced by a seeded LCG before any sim call, so revisions that
// predate makeRng() are just as reproducible as the current one. Paired seeds => a real A/B.
//
// Metrics (all on the REAL arena geometry, capsules included — the repo's own test-behavior.mjs
// tests pinning against the DEFAULT arena's 4 boxes even when it loads MAIN_FIELD, so its
// "pinned%" on main is measuring phantom walls):
//   pinned%      wants to move, moved < 1.2px, and is actually touching a wall/edge
//   stuckWorst   longest single pinned run, seconds  (the felt symptom is DURATION)
//   stuck>0.5s   how many pinned runs lasted over half a second, per match
//   idleBall%    carrier moved < 1.2px
//   ballGapPx    mean distance from a LOOSE ball to the nearest player
//   notClosing%  loose-ball ticks where the nearest player is NOT getting closer
//   reachS       mean seconds from "ball goes loose" to "someone picks it up"
//   speedPx      mean player speed while wanting to move
//   goals/shots/touches per match
import { createState, addPlayer, attachBall, step, setField } from './shared/sim.js';
import { MAIN_FIELD } from './shared/main-field.js';
import { DT, FIELD } from './shared/constants.js';
import { computeBotInputs, createBotMemory } from './shared/bot-ai.js';

const SK_A = parseFloat(process.env.SKA || '0.50');
const SK_B = parseFloat(process.env.SKB || '0.50');
const MATCHES = parseInt(process.env.MATCHES || '8', 10);
const SECS = parseInt(process.env.SECS || '60', 10);
const SEEDBASE = parseInt(process.env.SEEDBASE || '1234', 10);
const USE_MAIN = process.env.ARENA !== 'default';
const TICKS = Math.round(SECS / DT);

// ---- seeded RNG installed over Math.random (works on every revision) ----
let _s = 1;
function lcg() { _s = (_s * 1664525 + 1013904223) >>> 0; return _s / 4294967296; }
Math.random = lcg;

const R = 21; // CHARACTERS.player.radius
function nearestOnW(w, px, py) {
  if (w.angle != null) {
    const ca = Math.cos(w.angle), sa = Math.sin(w.angle);
    const ax = w.cx - ca * w.hl, ay = w.cy - sa * w.hl, bx = w.cx + ca * w.hl, by = w.cy + sa * w.hl;
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
    return { x: ax + dx * t, y: ay + dy * t, rad: w.ht };
  }
  return { x: Math.max(w.x, Math.min(px, w.x + w.w)), y: Math.max(w.y, Math.min(py, w.y + w.h)), rad: 0 };
}
function touchingWall(s, p) {
  if (p.x < R + 14 || p.x > FIELD.W - R - 14 || p.y < R + 14 || p.y > FIELD.H - R - 14) return true;
  const arena = s.arena || { walls: [] };
  for (const w of arena.walls.concat(s.builtWalls || [])) {
    const np = nearestOnW(w, p.x, p.y);
    if (Math.hypot(p.x - np.x, p.y - np.y) - (np.rad || 0) < R + 14) return true;
  }
  return false;
}

let movingTicks = 0, pinned = 0, carryTicks = 0, idleBall = 0, playTicks = 0;
let stuckWorst = 0, stuckLong = 0, speedSum = 0;
let looseTicks = 0, gapSum = 0, notClosing = 0;
let reachSum = 0, reachN = 0, reachTimeouts = 0;
let goals = 0, shots = 0, touches = 0;

for (let mi = 0; mi < MATCHES; mi++) {
  _s = (SEEDBASE * 7919 + mi * 104729) >>> 0;
  const s = createState(); s.resetTimer = 0;
  if (USE_MAIN) setField(s, MAIN_FIELD);
  if (s.rng !== undefined) s.rng = lcg; // newer sims route randomness through state.rng
  for (const [id, team, slot] of [['A0', 'A', 0], ['A1', 'A', 1], ['B0', 'B', 0], ['B1', 'B', 1]])
    addPlayer(s, id, { name: id, char: 'player', team, slot, isBot: true });
  attachBall(s, lcg() < 0.5 ? 'A' : 'B');
  const mem = createBotMemory('normal');
  mem.teamSkill = { A: SK_A, B: SK_B };

  const prev = {}, run = {};
  for (const id in s.players) { prev[id] = { x: s.players[id].x, y: s.players[id].y }; run[id] = 0; }
  let prevOwner = s.ball.owner, prevScore = s.score.A + s.score.B, looseAt = null, prevGap = null;

  for (let t = 0; t < TICKS; t++) {
    const inp = computeBotInputs(s, mem, DT);
    for (const id in inp) if (inp[id] && inp[id].fire) shots++;
    step(s, inp, DT);
    if (s.score.A + s.score.B !== prevScore) { goals += s.score.A + s.score.B - prevScore; prevScore = s.score.A + s.score.B; }
    if (s.resetTimer > 0) {
      for (const id in s.players) { prev[id] = { x: s.players[id].x, y: s.players[id].y }; run[id] = 0; }
      prevOwner = s.ball.owner; looseAt = null; prevGap = null; continue;
    }
    playTicks++;
    // possession transitions
    if (s.ball.owner !== prevOwner) {
      if (s.ball.owner) {
        touches++;
        if (looseAt != null) { reachSum += (t - looseAt) * DT; reachN++; looseAt = null; }
      } else looseAt = t;
      prevOwner = s.ball.owner;
    }
    // loose-ball closing behaviour
    if (!s.ball.owner) {
      looseTicks++;
      let gap = 1e9;
      for (const id in s.players) gap = Math.min(gap, Math.hypot(s.players[id].x - s.ball.x, s.players[id].y - s.ball.y));
      gapSum += gap;
      if (prevGap != null && gap > prevGap - 0.2) notClosing++;
      prevGap = gap;
      if (looseAt != null && (t - looseAt) * DT > 4) { reachTimeouts++; looseAt = t; } // nobody got there in 4s
    } else prevGap = null;

    for (const id in s.players) {
      const p = s.players[id], i = inp[id]; if (!i) continue;
      const disp = Math.hypot(p.x - prev[id].x, p.y - prev[id].y);
      const wantMove = Math.hypot(i.moveX, i.moveY) > 0.3;
      if (wantMove) {
        movingTicks++; speedSum += disp / DT;
        if (disp < 1.2 && touchingWall(s, p)) {
          pinned++; run[id]++;
          const secs = run[id] * DT;
          if (secs > stuckWorst) stuckWorst = secs;
          if (Math.abs(secs - 0.5) < DT / 2) stuckLong++;
        } else run[id] = 0;
      } else run[id] = 0;
      if (s.ball.owner === id) { carryTicks++; if (disp < 1.2) idleBall++; }
      prev[id] = { x: p.x, y: p.y };
    }
  }
}
const pct = (a, b) => (100 * a / Math.max(1, b));
const out = {
  rev: process.env.REV || '?', skA: SK_A, skB: SK_B, arena: USE_MAIN ? 'main' : 'default',
  pinnedPct: +pct(pinned, movingTicks).toFixed(2),
  stuckWorstS: +stuckWorst.toFixed(2),
  stuckOver05PerMatch: +(stuckLong / MATCHES).toFixed(2),
  idleBallPct: +pct(idleBall, carryTicks).toFixed(2),
  ballGapPx: +(gapSum / Math.max(1, looseTicks)).toFixed(0),
  notClosingPct: +pct(notClosing, looseTicks).toFixed(1),
  reachS: +(reachSum / Math.max(1, reachN)).toFixed(2),
  reachTimeoutsPerMatch: +(reachTimeouts / MATCHES).toFixed(2),
  speedPx: +(speedSum / Math.max(1, movingTicks)).toFixed(0),
  goalsPerMatch: +(goals / MATCHES).toFixed(2),
  shotsPerMatch: +(shots / MATCHES).toFixed(1),
  touchesPerMatch: +(touches / MATCHES).toFixed(1),
  loosePct: +pct(looseTicks, playTicks).toFixed(1),
};
console.log(JSON.stringify(out));
