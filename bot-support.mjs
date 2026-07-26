// "DOES THE SUPPORT BOT RUN THE WRONG WAY, AND DOES THE CARRIER KICK THE WRONG WAY?"
//
// Written for the level-10 report: *"the friend sometimes goes the other way"* and *"the enemy
// shoots the other way"*. `bot-feel.mjs` measures the ball; this measures the DECISION, tagged by
// the branch (`bm.lastTrick`) that made it, so a percentage points at code instead of a vibe.
//
// Default shape is L10 from shared/difficulty.js: team A = partner 0.42 (the "friend"),
// team B = enemy 0.93. Both teams are measured, so one run gives both halves of the report.
//
// Metrics
//   supportAway%   support bot, its MATE carries, it wants to move, and moveX * forwardDir < -0.5
//                  => actively running away from the goal its own team is attacking. Split by tag.
//   backRelease%   carrier fire ticks whose EMITTED aim is > 90deg off the enemy goal. Split by tag.
//   sideRelease%   ditto for 60..90deg (sideways-ish), printed for context.
//   passLatchOff   mean |angle off the enemy goal| of every [passLatch] release.
//
// Env: MATCHES SECS SEEDBASE SKA SKB (SKA/SKB override the L10 pair), TAGS=1 for the full histogram.
import { createState, addPlayer, attachBall, step, setField } from './shared/sim.js';
import { MAIN_FIELD } from './shared/main-field.js';
import { DT, FIELD } from './shared/constants.js';
import { computeBotInputs, createBotMemory, bmemForTest } from './shared/bot-ai.js';

const SK_A = parseFloat(process.env.SKA || '0.42');   // the human's PARTNER at L10
const SK_B = parseFloat(process.env.SKB || '0.93');   // the ENEMY at L10
const MATCHES = parseInt(process.env.MATCHES || '8', 10);
const SECS = parseInt(process.env.SECS || '60', 10);
const SEEDBASE = parseInt(process.env.SEEDBASE || '1234', 10);
const TICKS = Math.round(SECS / DT);
const GY = FIELD.H / 2;

let _s = 1;
function lcg() { _s = (_s * 1664525 + 1013904223) >>> 0; return _s / 4294967296; }
Math.random = lcg;

const bump = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };
const pct = (a, b) => (100 * a / Math.max(1, b));
const top = (o, tot, n = 6) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n)
  .map(([k, v]) => `${k} ${pct(v, tot).toFixed(0)}%`).join(' · ');

// per-side accumulators
const S = { A: mk(), B: mk() };
function mk() {
  return {
    supTicks: 0, awayTicks: 0, awayTags: {}, supTags: {}, awayNoDetour: 0, awayNdTags: {},
    rel: 0, back: 0, side: 0, backTags: {}, relTags: {},
    latchN: 0, latchOffSum: 0, latchBack: 0,
    // WHY was it away? sub-reasons for the untagged (plain support/outlet) slice
    noneWhy: {}, recvWhy: {},
    // was the RECEIVER already ahead of the carrier when it ran away? (the stated diagnosis)
    recvAhead: 0, recvBehind: 0,
    // pass latch geometry at the moment the ball leaves: + = the receiver gains ground
    latchGainSum: 0, latchLoss: 0, latchLossSum: 0,
    // for the >90deg latch releases: is the RECEIVER geometrically backwards, or is the emitted
    // aim only backwards because of leadAim / the aim slew? (different bugs, different fixes)
    lb: 0, lbGeomBack: 0, lbAxisBack: 0, lbGeomOffSum: 0,
  };
}

for (let mi = 0; mi < MATCHES; mi++) {
  _s = (SEEDBASE * 7919 + mi * 104729) >>> 0;
  const s = createState(); s.resetTimer = 0; setField(s, MAIN_FIELD);
  if (s.rng !== undefined) s.rng = lcg;
  for (const [id, team, slot] of [['A0', 'A', 0], ['A1', 'A', 1], ['B0', 'B', 0], ['B1', 'B', 1]])
    addPlayer(s, id, { name: id, char: 'player', team, slot, isBot: true });
  attachBall(s, lcg() < 0.5 ? 'A' : 'B');
  const mem = createBotMemory('normal');
  mem.teamSkill = { A: SK_A, B: SK_B };

  for (let t = 0; t < TICKS; t++) {
    const inp = computeBotInputs(s, mem, DT);
    for (const team of ['A', 'B']) {
      const role = mem.teams[team]; if (!role) continue;
      const acc = S[team];
      const fwd = team === 'A' ? 1 : -1;          // +x for A, -x for B
      const egX = team === 'A' ? FIELD.W : 0;
      const carrier = s.ball.owner ? s.players[s.ball.owner] : null;

      // ---- 1. the SUPPORT bot running away from the attack ----
      if (role.support && carrier && carrier.team === team && carrier.id !== role.support) {
        const q = s.players[role.support], i = inp[role.support];
        if (q && i && Math.hypot(i.moveX, i.moveY) > 0.3) {
          const bmq = bmemForTest(mem, role.support);
          const tag = bmq.lastTrick || '[none]';
          acc.supTicks++; bump(acc.supTags, tag);
          if (i.moveX * fwd < -0.5) {
            acc.awayTicks++; bump(acc.awayTags, tag);
            const aheadX = egX - (team === 'A' ? 300 : -300);          // bot-ai's own outlet line
            const pastAhead = (q.x - aheadX) * fwd > 0;
            const aheadOfCarrier = (q.x - carrier.x) * fwd > 0;
            // bm.wp is set ONLY while the flow field has overridden the straight line, i.e. the
            // backward step is a WALL DETOUR and not the branch's choice of target.
            const why = bmq.wp ? 'navDetour(wall)' : pastAhead ? 'pastOutletLine' : aheadOfCarrier ? 'aheadOfCarrier(minSep?)' : 'behindCarrier(shape)';
            if (!bmq.wp) { acc.awayNoDetour++; bump(acc.awayNdTags, tag); }
            if (tag === 'receivePass') { if (aheadOfCarrier) acc.recvAhead++; else acc.recvBehind++; bump(acc.recvWhy, why); }
            if (tag === '[none]') bump(acc.noneWhy, why);
          }
        }
      }

      // ---- 2. a carrier's RELEASE pointing the wrong way ----
      for (const p of Object.values(s.players)) {
        if (p.team !== team) continue;
        const i = inp[p.id]; if (!i || !i.fire || s.ball.owner !== p.id) continue;
        const tag = bmemForTest(mem, p.id).lastTrick || '[none]';
        const [gx, gy] = [egX - p.x, GY - p.y];
        const gl = Math.hypot(gx, gy) || 1;
        const dot = (i.aimX * gx + i.aimY * gy) / gl;
        const off = Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI;
        acc.rel++; bump(acc.relTags, tag);
        if (off > 90) { acc.back++; bump(acc.backTags, tag); }
        else if (off > 60) acc.side++;
        if (tag === 'passLatch') {
          acc.latchN++; acc.latchOffSum += off; if (off > 90) acc.latchBack++;
          const bmp = bmemForTest(mem, p.id), rx = bmp.passTo && s.players[bmp.passTo.id];
          if (rx) {
            const gain = Math.hypot(egX - p.x, GY - p.y) - Math.hypot(egX - rx.x, GY - rx.y);
            acc.latchGainSum += gain;
            if (gain < -20) { acc.latchLoss++; acc.latchLossSum += gain; }
            if (off > 90) {
              acc.lb++;
              const rl = Math.hypot(rx.x - p.x, rx.y - p.y) || 1;
              const gdot = ((rx.x - p.x) * gx + (rx.y - p.y) * gy) / (rl * gl);
              const goff = Math.acos(Math.max(-1, Math.min(1, gdot))) * 180 / Math.PI;
              acc.lbGeomOffSum += goff;
              if (goff > 90) acc.lbGeomBack++;                        // the RECEIVER is behind
              if ((rx.x - p.x) * fwd < -40) acc.lbAxisBack++;          // ...on the attacking AXIS
            }
          }
        }
      }
    }
    step(s, inp, DT);
  }
}

for (const [team, label, sk] of [['A', 'FRIEND (partner)', SK_A], ['B', 'ENEMY', SK_B]]) {
  const a = S[team];
  console.log(`${label}  team ${team}  skill ${sk}`);
  console.log(`  supportAway%  ${pct(a.awayTicks, a.supTicks).toFixed(1)}%  (${a.awayTicks}/${a.supTicks} support move-ticks)`);
  console.log(`    by tag      ${top(a.awayTags, a.awayTicks)}`);
  console.log(`  awayNoDetour% ${pct(a.awayNoDetour, a.supTicks).toFixed(1)}%  <- the flow field is NOT routing round a wall, so the BRANCH chose it`);
  console.log(`    by tag      ${top(a.awayNdTags, a.awayNoDetour)}`);
  if (process.env.TAGS) console.log(`    support mix ${top(a.supTags, a.supTicks, 10)}`);
  console.log(`  backRelease%  ${pct(a.back, a.rel).toFixed(1)}%  side(60-90) ${pct(a.side, a.rel).toFixed(1)}%  of ${a.rel} releases`);
  console.log(`    by tag      ${top(a.backTags, a.back)}`);
  console.log(`  passLatch     ${a.latchN} releases · mean ${(a.latchOffSum / Math.max(1, a.latchN)).toFixed(0)}deg off goal · ${pct(a.latchBack, a.latchN).toFixed(0)}% >90deg`);
  console.log(`    >90deg latch releases: ${a.lb} · receiver geometrically >90deg ${pct(a.lbGeomBack, a.lb).toFixed(0)}% · behind on the AXIS ${pct(a.lbAxisBack, a.lb).toFixed(0)}% · mean receiver bearing ${(a.lbGeomOffSum / Math.max(1, a.lb)).toFixed(0)}deg`);
  console.log(`    geometry    mean ground GAINED by the receiver ${(a.latchGainSum / Math.max(1, a.latchN)).toFixed(0)}px · LOSES ground on ${pct(a.latchLoss, a.latchN).toFixed(0)}% (mean ${(a.latchLossSum / Math.max(1, a.latchLoss)).toFixed(0)}px)`);
  console.log(`    receivePass away-ticks: receiver was AHEAD of the carrier ${pct(a.recvAhead, a.recvAhead + a.recvBehind).toFixed(0)}% (${a.recvAhead}) · behind ${a.recvBehind}`);
  console.log(`      why       ${top(a.recvWhy, Object.values(a.recvWhy).reduce((x, y) => x + y, 0), 5)}`);
  console.log(`    [none] away-ticks: ${top(a.noneWhy, Object.values(a.noneWhy).reduce((x, y) => x + y, 0), 5)}`);
}
const C = mk();
for (const t of ['A', 'B']) for (const k in C) {
  if (typeof C[k] === 'number') C[k] += S[t][k];
  else for (const kk in S[t][k]) bump(C[k], kk, S[t][k][kk]);
}
console.log(`BOTH TEAMS  away ${pct(C.awayTicks, C.supTicks).toFixed(1)}%  awayNoDetour ${pct(C.awayNoDetour, C.supTicks).toFixed(1)}%  (${C.supTicks} ticks)`);
console.log(`  awayNoDetour by tag  ${top(C.awayNdTags, C.awayNoDetour, 8)}`);
console.log(`  >90deg latch: ${C.lb} · receiver geom >90deg ${pct(C.lbGeomBack, C.lb).toFixed(0)}% · axis-back ${pct(C.lbAxisBack, C.lb).toFixed(0)}% · mean bearing ${(C.lbGeomOffSum / Math.max(1, C.lb)).toFixed(0)}deg`);
console.log(`  releases ${C.rel} · >90deg ${pct(C.back, C.rel).toFixed(1)}% · 60-90deg ${pct(C.side, C.rel).toFixed(1)}% · passLatch ${C.latchN} mean ${(C.latchOffSum / Math.max(1, C.latchN)).toFixed(0)}deg · latch>90 ${pct(C.latchBack, C.latchN).toFixed(1)}% · latch loses ground ${pct(C.latchLoss, C.latchN).toFixed(1)}%`);
console.log(JSON.stringify({
  away: +pct(C.awayTicks, C.supTicks).toFixed(1), awayNd: +pct(C.awayNoDetour, C.supTicks).toFixed(1),
  backRel: +pct(C.back, C.rel).toFixed(1), sideRel: +pct(C.side, C.rel).toFixed(1),
  latchOff: +(C.latchOffSum / Math.max(1, C.latchN)).toFixed(0), latchBack: +pct(C.latchBack, C.latchN).toFixed(1),
  latchLoseGround: +pct(C.latchLoss, C.latchN).toFixed(1), latchN: C.latchN, rel: C.rel,
}));
console.log(JSON.stringify({
  awayA: +pct(S.A.awayTicks, S.A.supTicks).toFixed(1), awayB: +pct(S.B.awayTicks, S.B.supTicks).toFixed(1),
  backRelA: +pct(S.A.back, S.A.rel).toFixed(1), backRelB: +pct(S.B.back, S.B.rel).toFixed(1),
  latchOffA: +(S.A.latchOffSum / Math.max(1, S.A.latchN)).toFixed(0), latchOffB: +(S.B.latchOffSum / Math.max(1, S.B.latchN)).toFixed(0),
  latchBackA: +pct(S.A.latchBack, S.A.latchN).toFixed(0), latchBackB: +pct(S.B.latchBack, S.B.latchN).toFixed(0),
}));
