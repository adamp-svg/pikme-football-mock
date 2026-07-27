// PRACTICE PAYS NOTHING (user, 2026-07-27: "I want the trophies and rank to never increase from
// training ground games").
//
// The only thing that can move either track is the client's `matchResult` post — pikme-server credits
// xpDelta (the גביעים/trophy track) and rankDelta off it. So the rule is enforced by NOT posting.
//
// Why `botgame` is the one that mattered: `training` and `builder` set state.noClock, so they never
// reach phase 'ended' and the post was unreachable. `botgame` — the practice "full 2v2 vs bots" — has a
// real win condition, so it ended, posted, and paid out at a merely-DISCOUNTED rate (TROPHY_BOT_FLOOR,
// botTaper). Discounted is not zero, which is what the user was seeing.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PRACTICE_MODES, isPracticeMode } from './shared/constants.js';

const here = dirname(fileURLToPath(import.meta.url));
const R = (p) => readFileSync(join(here, p), 'utf8');
let failed = 0;
const ok = (l, c, x = '') => { if (!c) failed++; console.log(`  ${c ? '✅' : '❌'} ${l}${x ? ` — ${x}` : ''}`); };

console.log('the practice set');
ok('all three training-ground rooms are practice',
  ['training', 'builder', 'botgame'].every((m) => isPracticeMode(m)), PRACTICE_MODES.join(','));
// A matchmade room whose empty slots got bot backfill is a REAL match the player queued for. Blocking
// it would leave almost no progression at this population, since most matchmade games end up part-bot.
ok('a matchmade/quick room is NOT practice', !isPracticeMode('quick') && !isPracticeMode('brawl') && !isPracticeMode('3v3'));
ok('a private/party room is NOT practice', !isPracticeMode('private'));
ok('an unknown mode is not practice by accident', !isPracticeMode('') && !isPracticeMode(undefined));

console.log('\nthe client suppresses the post for practice');
const client = R('public/client.js');
const ended = client.slice(client.indexOf("latest.phase === 'ended'"), client.indexOf("latest.phase === 'ended'") + 2200);
ok('the ended branch guards the post on isPracticeMode', /isPracticeMode\(roomMode\)/.test(ended));
ok('...and postMatchResult is INSIDE that guard, not beside it',
  ended.indexOf('isPracticeMode(roomMode)') < ended.indexOf('postMatchResult('));
// A bare `return` here would silently skip the rest of the per-frame HUD update.
ok('the guard is a conditional, not an early return out of the frame',
  /if \(!isPracticeMode\(roomMode\)\) \{/.test(ended) && !/if \(isPracticeMode\(roomMode\)\) return/.test(ended));
// The celebration is not a payout — you won, you should still see it.
ok('the win/lose celebration still fires for practice',
  ended.indexOf('triggerCelebration(') < ended.indexOf('isPracticeMode(roomMode)'));
ok('the one-shot latch still trips, so the sting cannot double-fire',
  ended.indexOf('matchResultSent = true') < ended.indexOf('isPracticeMode(roomMode)'));

console.log('\nthe mode list is shared, not a third hand-kept copy');
ok('client imports isPracticeMode from shared/constants.js',
  /\bisPracticeMode\b/.test(client.slice(0, client.indexOf("} from '/shared/constants.js'"))));
const server = R('server.js');
ok('the server still labels those rooms with exactly these mode strings',
  PRACTICE_MODES.every((m) => new RegExp(`mode: '${m}'|'${m}'`).test(server)),
  PRACTICE_MODES.filter((m) => !new RegExp(`'${m}'`).test(server)).join(',') || 'all present');

console.log('\nthe two endless modes could never have paid out anyway');
for (const fn of ['startTraining', 'startBuilderMatch']) {
  const body = server.slice(server.indexOf(`function ${fn}`), server.indexOf(`function ${fn}`) + 1400);
  ok(`${fn} sets noClock, so it never reaches 'ended'`, /noClock = true/.test(body));
}
const bot = server.slice(server.indexOf('function startBotGame'), server.indexOf('function startBotGame') + 1400);
ok('startBotGame does NOT set noClock — it really did end and pay', !/noClock = true/.test(bot));

console.log(failed ? `\n❌ ${failed} failed` : '\n✅ all passed');
process.exit(failed ? 1 : 0);
