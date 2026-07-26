// Does a called pass actually REACH the team-mate it was called to? (the metric feature #2 is for)
import { createState, addPlayer, attachBall, step, setField, makeRng } from './shared/sim.js';
import { MAIN_FIELD } from './shared/main-field.js';
import { DT } from './shared/constants.js';
import { computeBotInputs, createBotMemory, bmemForTest } from './shared/bot-ai.js';
const M = +(process.env.MATCHES || 6), SECS = +(process.env.SECS || 60), SK = +(process.env.SK || 0.5);
let called = 0, toMate = 0, toEnemy = 0, toNobody = 0, releases = 0;
for (let mi = 0; mi < M; mi++) {
  const s = createState(); s.resetTimer = 0; setField(s, MAIN_FIELD); s.rng = makeRng(99 * 7919 + mi * 104729);
  for (const [id, team, slot] of [['A0','A',0],['A1','A',1],['B0','B',0],['B1','B',1]]) addPlayer(s, id, { name: id, char: 'player', team, slot, isBot: true });
  attachBall(s, s.rng() < 0.5 ? 'A' : 'B');
  const mem = createBotMemory('normal'); mem.teamSkill = { A: SK, B: SK };
  let pending = null, seenCalls = new Set();
  for (let t = 0; t < Math.round(SECS / DT); t++) {
    const inp = computeBotInputs(s, mem, DT);
    for (const id in inp) {
      const bm = bmemForTest(mem, id);
      if (bm.passTo && !seenCalls.has(id + ':' + bm.passTo.until)) { seenCalls.add(id + ':' + bm.passTo.until); called++; }
      if (inp[id] && inp[id].fire && s.ball.owner === id && bm.passTo) { releases++; pending = { to: bm.passTo.id, from: id, team: s.players[id].team, at: t }; }
    }
    step(s, inp, DT);
    if (pending) {
      if (s.ball.owner) {
        if (s.ball.owner === pending.to) toMate++;
        else if (s.players[s.ball.owner].team !== pending.team) toEnemy++;
        else toMate++; // reached the right team (the other mate at 3v3+)
        pending = null;
      } else if (t - pending.at > 150) { toNobody++; pending = null; }
    }
  }
}
const done = toMate + toEnemy + toNobody;
console.log(`calls ${(called / M).toFixed(1)}/match · releases ${(releases / M).toFixed(1)}/match`);
console.log(`  reached a TEAM-MATE ${(100 * toMate / Math.max(1, done)).toFixed(0)}%   an ENEMY ${(100 * toEnemy / Math.max(1, done)).toFixed(0)}%   nobody ${(100 * toNobody / Math.max(1, done)).toFixed(0)}%`);
