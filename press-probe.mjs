// Does pressing actually take the ball off the enemy? bot-feel measures loose-ball engagement, not
// dispossession, so this measures the press's OWN job: how long a team keeps the ball once it has it,
// and how often a carry ends in a STRIP (ball taken while carrying) rather than a kick.
// Symmetric match, so both teams run the same code: the numbers are per-carry, not per-side.
// Freeze ticks excluded (resetTimer > 0 checked BEFORE step) — ARENA-AUDIT §0.
import { createState, addPlayer, attachBall, step, setField } from './shared/sim.js';
import { MAIN_FIELD } from './shared/main-field.js';
import { computeBotInputs, createBotMemory } from './shared/bot-ai.js';
import { DT } from './shared/constants.js';

const SK = parseFloat(process.env.SK || '0.93');
const MATCHES = parseInt(process.env.MATCHES || '24', 10);
const SECS = parseInt(process.env.SECS || '60', 10);
const SEEDBASE = parseInt(process.env.SEEDBASE || '1234', 10);
let _s = 1; const lcg = () => { _s = (_s * 1664525 + 1013904223) >>> 0; return _s / 4294967296; };
Math.random = lcg;

let carries = 0, carrySec = 0, strips = 0, kicks = 0, maxCarry = 0;
for (let mi = 0; mi < MATCHES; mi++) {
  _s = (SEEDBASE * 7919 + mi * 104729) >>> 0;
  const s = createState(); s.resetTimer = 0; s.goalsToWin = 0; setField(s, MAIN_FIELD); s.rng = lcg;
  for (const [id, team, slot] of [['A0','A',0],['A1','A',1],['B0','B',0],['B1','B',1]])
    addPlayer(s, id, { name: id, char: 'player', team, slot, isBot: true });
  attachBall(s, lcg() < 0.5 ? 'A' : 'B');
  const mem = createBotMemory('normal'); mem.teamSkill = { A: SK, B: SK };
  let owner = s.ball.owner, since = 0, t = 0;
  for (; t < Math.round(SECS / DT); t++) {
    const frozen = s.resetTimer > 0;
    const inp = computeBotInputs(s, mem, DT);
    const fired = owner && inp[owner] && inp[owner].fire;
    step(s, inp, DT);
    if (frozen) { owner = s.ball.owner; since = t; continue; }
    if (s.ball.owner !== owner) {
      if (owner) {                                   // a carry just ended
        const dur = (t - since) * DT;
        carries++; carrySec += dur; maxCarry = Math.max(maxCarry, dur);
        if (fired) kicks++; else strips++;            // ended by our own kick, or taken off us
      }
      owner = s.ball.owner; since = t;
    }
  }
}
console.log(JSON.stringify({
  sk: SK, matches: MATCHES, seedbase: SEEDBASE,
  carriesPerMatch: +(carries / MATCHES).toFixed(2),
  meanCarryS: +(carrySec / Math.max(1, carries)).toFixed(3),
  longestCarryS: +maxCarry.toFixed(2),
  stripPct: +(100 * strips / Math.max(1, carries)).toFixed(1),
  stripsPerMatch: +(strips / MATCHES).toFixed(2),
  kicksPerMatch: +(kicks / MATCHES).toFixed(2),
}));
