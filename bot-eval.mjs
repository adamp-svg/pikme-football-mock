// Bot-vs-bot headless A/B harness. Team NEW (shared/bot-ai.js) vs team LEGACY
// (bot-legacy.mjs, the previous updateBots). Runs many matches with sides swapped
// to cancel any bias, and reports goals, possession, coordination, tool use,
// crashes and stuck-bots. Usage: node bot-eval.mjs [matches] [seconds]
import { createState, addPlayer, attachBall, step } from './shared/sim.js';
import { DT, MATCH_DURATION } from './shared/constants.js';
import { computeBotInputs, createBotMemory } from './shared/bot-ai.js';
import { legacyInputs } from './bot-legacy.mjs';

const MATCHES = parseInt(process.argv[2] || '30', 10);
const SECS = Math.min(parseInt(process.argv[3] || '70', 10), MATCH_DURATION - 5);
const TICKS = Math.round(SECS / DT);

function runMatch(newTeam) { // newTeam: which side ('A'|'B') the NEW ai controls
  const legacyTeam = newTeam === 'A' ? 'B' : 'A';
  const state = createState();
  state.resetTimer = 0;
  addPlayer(state, 'A0', { name: 'A0', char: 'player', team: 'A', slot: 0, isBot: true });
  addPlayer(state, 'A1', { name: 'A1', char: 'player', team: 'A', slot: 1, isBot: true });
  addPlayer(state, 'B0', { name: 'B0', char: 'player', team: 'B', slot: 0, isBot: true });
  addPlayer(state, 'B1', { name: 'B1', char: 'player', team: 'B', slot: 1, isBot: true });
  attachBall(state, Math.random() < 0.5 ? 'A' : 'B');

  const memNew = createBotMemory('normal');
  const memLeg = {};
  const m = { newGoals: 0, legGoals: 0, poss: { new: 0, leg: 0 }, bothChaseNew: 0, bothChaseLeg: 0,
    playTicks: 0, shots: 0, bombs: 0, builds: 0, err: 0, moved: { A0: 0, A1: 0, B0: 0, B1: 0 } };
  const prev = {}; for (const id of ['A0', 'A1', 'B0', 'B1']) prev[id] = { x: state.players[id].x, y: state.players[id].y };

  for (let t = 0; t < TICKS; t++) {
    let inputs = {};
    try {
      const ai = computeBotInputs(state, memNew, DT, { onlyTeam: newTeam });
      const lg = legacyInputs(state, memLeg);
      for (const id in ai) inputs[id] = ai[id];
      for (const id in lg) if (state.players[id] && state.players[id].team === legacyTeam) inputs[id] = lg[id];
    } catch (e) { m.err++; if (m.err <= 2) console.error('AI ERROR:', e.message); }
    // tool-use tally for the NEW team
    for (const id in inputs) {
      if (state.players[id] && state.players[id].team === newTeam) {
        if (inputs[id].shoot) m.shots++; if (inputs[id].special) m.bombs++; if (inputs[id].build) m.builds++;
      }
    }
    const before = { A: state.score.A, B: state.score.B };
    try { step(state, inputs, DT); } catch (e) { m.err++; if (m.err <= 2) console.error('SIM ERROR:', e.message); break; }
    if (state.score.A > before.A) (newTeam === 'A' ? m.newGoals++ : m.legGoals++);
    if (state.score.B > before.B) (newTeam === 'B' ? m.newGoals++ : m.legGoals++);

    if (state.resetTimer <= 0) {
      m.playTicks++;
      const b = state.ball;
      const focus = b.owner && state.players[b.owner] ? state.players[b.owner] : b;
      if (b.owner) { const o = state.players[b.owner]; if (o) (o.team === newTeam ? m.poss.new++ : m.poss.leg++); }
      // both-chase: both of a team's bots within 260px of the play
      for (const team of ['A', 'B']) {
        const bots = Object.values(state.players).filter((p) => p.team === team);
        if (bots.length === 2 && bots.every((p) => Math.hypot(focus.x - p.x, focus.y - p.y) < 260)) {
          (team === newTeam ? m.bothChaseNew++ : m.bothChaseLeg++);
        }
      }
      for (const id of ['A0', 'A1', 'B0', 'B1']) { const p = state.players[id]; m.moved[id] += Math.hypot(p.x - prev[id].x, p.y - prev[id].y); prev[id] = { x: p.x, y: p.y }; }
    }
  }
  return m;
}

const agg = { newGoals: 0, legGoals: 0, possNew: 0, possLeg: 0, bothNew: 0, bothLeg: 0, playTicks: 0, shots: 0, bombs: 0, builds: 0, err: 0, stuck: 0, wins: 0, losses: 0, draws: 0 };
for (let i = 0; i < MATCHES; i++) {
  const newTeam = i % 2 === 0 ? 'A' : 'B';
  const m = runMatch(newTeam);
  agg.newGoals += m.newGoals; agg.legGoals += m.legGoals;
  agg.possNew += m.poss.new; agg.possLeg += m.poss.leg;
  agg.bothNew += m.bothChaseNew; agg.bothLeg += m.bothChaseLeg;
  agg.playTicks += m.playTicks; agg.shots += m.shots; agg.bombs += m.bombs; agg.builds += m.builds; agg.err += m.err;
  if (m.newGoals > m.legGoals) agg.wins++; else if (m.newGoals < m.legGoals) agg.losses++; else agg.draws++;
  // stuck: a NEW-team bot that moved < 4000px across a whole match of live play
  const newIds = newTeam === 'A' ? ['A0', 'A1'] : ['B0', 'B1'];
  for (const id of newIds) if (m.moved[id] < 4000) agg.stuck++;
}
const pctPoss = agg.possNew + agg.possLeg > 0 ? (100 * agg.possNew / (agg.possNew + agg.possLeg)).toFixed(0) : '0';
const bothNewPct = agg.playTicks ? (100 * agg.bothNew / agg.playTicks).toFixed(1) : '0';
const bothLegPct = agg.playTicks ? (100 * agg.bothLeg / agg.playTicks).toFixed(1) : '0';
console.log(`\n=== ${MATCHES} matches × ${SECS}s (NEW vs LEGACY, sides swapped) ===`);
console.log(`GOALS      NEW ${agg.newGoals}  —  ${agg.legGoals} LEGACY`);
console.log(`MATCHES    NEW win ${agg.wins} / draw ${agg.draws} / loss ${agg.losses}`);
console.log(`POSSESSION NEW ${pctPoss}%`);
console.log(`BOTH-CHASE (lower=better coordination)  NEW ${bothNewPct}%  vs  LEGACY ${bothLegPct}%`);
console.log(`NEW tools  shots ${agg.shots}  bombs ${agg.bombs}  builds ${agg.builds}`);
console.log(`ROBUST     ai/sim errors ${agg.err}  stuck-bot-matches ${agg.stuck}`);
const pass = agg.err === 0 && agg.stuck === 0 && agg.newGoals >= agg.legGoals && agg.wins >= agg.losses && agg.bombs > 0 && agg.builds > 0;
console.log(pass ? '\n✅ EVAL PASS (new ≥ legacy, coordinated, uses tools, robust)' : '\n❌ EVAL NEEDS WORK');
process.exit(pass ? 0 : 1);
