// DOES THE HUMAN'S OWN TEAM-MATE USE ITS TOOLS? ("my team-mate does nothing" — the other half of
// the standing complaint.)
//
// MEASURED (bot-eval.mjs behave, 24 matches x 70s per level, sides swapped, per-match averages):
//   partner skill 0.05 (L0/L4)   bombs 0.63   rocket-jumps 0.08
//   partner skill 0.25 (L1/3/6/8/11) bombs 0.21-0.29   rocket-jumps 0.04-0.13
//   partner skill 0.50 (L5/7/9)  bombs 5.42   rocket-jumps 4.00
// A 20x cliff between skill 0.25 and 0.50, and it is NOT the ladder being steep — it is one
// threshold. Both bomb-for-MOBILITY plays (the catch-up jump and the co-op push) are gated on
//     sk.toolSkill >= 0.72
// and skillVec interpolates toolSkill as 0.32 @ t=0, 0.58 @ t=0.25 (easy), 0.85 @ t=0.50 (normal).
// So the gate opens at t ~= 0.38: `easy` (0.58) is EXCLUDED. DIFFICULTY_LEVELS puts the partner at
// veryEasy or easy on SEVEN of the twelve levels (0,1,3,4,6,8,11), so on most of the ladder the bot
// standing next to the human never uses a bomb at all.
//
// This is an off-by-one-tier on a fix that was already attempted: the branch comment records the
// gate being lowered from 0.9 to 0.72 for exactly this reason ("most levels put the partner at
// 0.25-0.85"), but 0.25 maps to 0.58, not to something above 0.72.
//
// THE FIX these tests drive: a weak bot should use its tools RARELY AND BADLY, not never. Replace
// the cliff with a rate — open the gate below `easy` (TOOL_MOBILITY_MIN 0.45) and make FREQUENCY the
// thing that ranks with skill. The tutorial tier (veryEasy = skill 0.05, toolSkill 0.372) stays out.
//
// WHAT THE RATE IS, because the obvious version does not work: scaling the RE-ARM INTERVAL by toolSkill
// was tried first and rejected — it barely moved the count (easy 5.92 vs normal 6.67 bombs/match) because
// these branches are limited by how often their preconditions line up, not by a timer, so it flattened
// the ladder instead of ranking it. Shipped instead is `toolNotice()` (bot-ai.js:889), a skill-scaled
// chance of SPOTTING the opportunity, which is monotone in skill by construction. Section 3 is the guard.
//
// Run: node test-bot-partner.mjs
import { levelAt } from './shared/difficulty.js';
import { skillVec } from './shared/bot-ai.js';
import { measureLevel } from './bot-eval.mjs';

let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };

// 1) Document the shape of the gate itself, so a future retune of skillVec that re-opens the cliff
//    fails here instead of silently muting half the ladder again.
{
  const ts = (t) => skillVec(t).toolSkill;
  ok(ts(0.25) < 0.72, `the old 0.72 gate really did exclude 'easy': toolSkill(0.25) = ${ts(0.25).toFixed(2)}`);
  const weakPartnerLevels = [];
  for (let i = 0; i <= 11; i++) if (levelAt(i).partner <= 0.25) weakPartnerLevels.push(i);
  ok(weakPartnerLevels.length >= 6,
    `levels whose PARTNER is veryEasy/easy: ${weakPartnerLevels.join(',')} (${weakPartnerLevels.length} of 12) — this is why the cliff mattered`);
  ok(ts(0.25) >= 0.45 && ts(0.05) < 0.45,
    `a 0.45 gate admits 'easy' (${ts(0.25).toFixed(2)}) and still keeps the tutorial tier out (${ts(0.05).toFixed(2)})`);
}

// 2+3) THE BEHAVIOUR, and then THE LADDER SURVIVING IT. Both read the same measurement pass.
//
// WHY THIS POOLS OVER SEED BASES. The first version of section 3 hardcoded ONE seed base (measureLevel's
// default 4100) at 12 matches and asserted normal > 1.6x easy. That passed by 1.2% — and a challenger
// showed it REVERSES on sample size: at that base the ratio is 1.62 at n=12, 1.56 at n=20, 1.53 at n=24.
// The harness has no Math.random, so this is not run-to-run flake; it is one seeded trajectory family
// being mistaken for the statistic. Measured per base at n=12: 1.62 1.62 1.37 0.98 1.74 — at base 7400
// the `easy` partner out-bombs the `normal` one outright. A single base cannot carry this claim, which
// is the exact defect this file's own header criticises in test-bot-ladder.mjs; do not reintroduce it.
//
// POOLED, 5 bases x 12 matches = 60 matches per anchor (two disjoint pools, to check the pool itself):
//   pool 4100..8500   easy 3.56 bombs/match  2.67 rockets/match  normal 5.45  ratio 1.53
//   pool 9600..14000  easy 3.30 bombs/match  2.48 rockets/match  normal 5.78  ratio 1.75
// So the ratio the statistic actually supports is ~1.5-1.75, not 1.6-with-no-margin. Gate at 1.25.
//
// AND THE POOLING IS WHAT FIXED IT, verified rather than assumed — pooled ratio vs sample size:
//   n=8 -> 1.55    n=12 -> 1.53    n=20 -> 1.55        (single base, for contrast: 1.62 / 1.56 / 1.53)
// The pooled statistic is flat in n; the single-base one drifted straight through its own gate. If you
// change MATCHES, re-run that sweep instead of trusting one number.
const SEED_BASES = [4100, 5200, 6300, 7400, 8500];
const MATCHES = 12, SECS = 70;
{
  let easyBombs = 0, easyRockets = 0, easyMatches = 0, normBombs = 0, normMatches = 0;
  const ratios = [];
  for (const base of SEED_BASES) {
    let bb = 0, rr = 0, mm = 0;
    for (const lvl of [8, 11]) {                     // enemy hard/deadly, partner `easy` — the levels a good player reaches
      const p = measureLevel(lvl, MATCHES, SECS, base).partner;
      bb += p.bombs; rr += p.rocketJumps; mm += MATCHES;
    }
    const nn = measureLevel(5, MATCHES, SECS, base).partner.bombs;   // partner skill 0.50 (`normal`)
    easyBombs += bb; easyRockets += rr; easyMatches += mm; normBombs += nn; normMatches += MATCHES;
    ratios.push((nn / MATCHES) / (bb / mm));
    console.log(`      base ${base}: easy ${(bb / mm).toFixed(2)} bombs ${(rr / mm).toFixed(2)} rockets | normal ${(nn / MATCHES).toFixed(2)} bombs`);
  }
  const bpm = easyBombs / easyMatches, rpm = easyRockets / easyMatches, nbpm = normBombs / normMatches;

  // 2) A weak team-mate must use its tools RARELY AND BADLY, not never.
  console.log(`      => easy-partner pooled: ${bpm.toFixed(2)} bombs/match, ${rpm.toFixed(2)} rocket-jumps/match (was 0.21-0.29 and 0.04-0.13)`);
  // 1 bomb/match is deliberately a LOW bar: the point is "not never", and a weak partner should stay
  // clearly worse than the ~5.5 bombs/match a `normal` partner manages. Pooled measures 3.30-3.56 and
  // the WORST single base is 3.00, so this gate has ~3x of headroom rather than 1.2%.
  ok(bpm >= 1.0, `an 'easy' team-mate plants bombs at all: ${bpm.toFixed(2)}/match (need >= 1.0; measured 0.21-0.29 before)`);
  ok(rpm >= 0.5, `...and actually rides one to cover ground: ${rpm.toFixed(2)} rocket-jumps/match (need >= 0.5; measured 0.04-0.13 before)`);

  // 3) THE LADDER MUST SURVIVE IT. A weak partner has to stay clearly weaker than a normal one, or
  //    "fix the cliff" has just flattened the difficulty range the ladder test protects.
  const ratio = nbpm / bpm;
  console.log(`      easy ${bpm.toFixed(2)} vs normal ${nbpm.toFixed(2)} bombs/match — pooled ratio ${ratio.toFixed(2)} (per base: ${ratios.map((r) => r.toFixed(2)).join(' ')})`);
  ok(ratio >= 1.25,
    `frequency still RANKS with skill: normal is ${ratio.toFixed(2)}x easy over ${SEED_BASES.length} seed bases x ${MATCHES} (need >= 1.25; pooled measures 1.53 and 1.75 on two disjoint pools, single bases scatter 0.98-2.06)`);
}

console.log(`\n${fails === 0 ? '✅ ALL PASS' : '❌ ' + fails + ' FAILURE(S)'}`);
process.exit(fails === 0 ? 0 : 1);
