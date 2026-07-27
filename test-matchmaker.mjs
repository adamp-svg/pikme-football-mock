// MATCHMAKING POLICY — pure, no sockets, no timers.
//
// `now` is a PARAMETER, so this drives time by passing timestamps. The suite already has one test
// that hangs (test-bot-ladder.mjs); do not add a second by sleeping.
import { bandOf, acceptedBand, mutuallyCompatible, widenFor } from './shared/matchmaker.js';
import { MM_BUDGET_QUICK_MS, MM_BAND_TOP } from './shared/constants.js';

let failed = 0;
const ok = (l, c, x = '') => { if (!c) failed++; console.log(`  ${c ? '✅' : '❌'} ${l}${x ? ` — ${x}` : ''}`); };

console.log('bands');
ok('0 trophies -> L1', bandOf(0) === 1, String(bandOf(0)));
ok('340 trophies -> L3', bandOf(340) === 3, String(bandOf(340)));
ok('1000 trophies -> L5', bandOf(1000) === 5, String(bandOf(1000)));
// playerLevelFromXp(30000) is 25; without the ceiling the top player matches nobody.
ok('30000 trophies collapses to the top band', bandOf(30000) === MM_BAND_TOP, String(bandOf(30000)));
ok('12000 trophies also collapses to the top band', bandOf(12000) === MM_BAND_TOP, String(bandOf(12000)));
ok('garbage is treated as the floor, not NaN', bandOf(undefined) === 1 && bandOf(-5) === 1);

console.log('\naccepted band');
ok('widen 0 is exact', JSON.stringify(acceptedBand(5, 0)) === '{"lo":5,"hi":5}');
ok('widen 1 is +/-1', JSON.stringify(acceptedBand(5, 1)) === '{"lo":4,"hi":6}');
ok('widen 2 is +/-2', JSON.stringify(acceptedBand(5, 2)) === '{"lo":3,"hi":7}');
// The floor is ASYMMETRIC: at the bottom of the ladder a one-level gap is a far bigger skill gap.
ok('L1 widened by 1 accepts L1-L2 only, never below', JSON.stringify(acceptedBand(1, 1)) === '{"lo":1,"hi":2}');
ok('L1 widened by 2 still stops at L2', JSON.stringify(acceptedBand(1, 2)) === '{"lo":1,"hi":2}');
ok('L2 widened by 2 stops at L1 below and L4 above', JSON.stringify(acceptedBand(2, 2)) === '{"lo":1,"hi":4}');
ok('the top band does not widen past itself', acceptedBand(MM_BAND_TOP, 2).hi === MM_BAND_TOP);

console.log('\nmutual compatibility');
ok('same level always matches', mutuallyCompatible({ level: 5, widen: 0 }, { level: 5, widen: 0 }));
ok('a widened L3 does NOT capture an unwidened L1',
  !mutuallyCompatible({ level: 3, widen: 2 }, { level: 1, widen: 0 }));
ok('...and still does not once L1 has widened, because L1 caps at L2',
  !mutuallyCompatible({ level: 3, widen: 2 }, { level: 1, widen: 2 }));
ok('L4 and L5 match only when at least one has widened',
  !mutuallyCompatible({ level: 4, widen: 0 }, { level: 5, widen: 0 })
  && mutuallyCompatible({ level: 4, widen: 1 }, { level: 5, widen: 1 }));
ok('compatibility is symmetric',
  mutuallyCompatible({ level: 4, widen: 1 }, { level: 5, widen: 1 })
  === mutuallyCompatible({ level: 5, widen: 1 }, { level: 4, widen: 1 }));

console.log('\nwiden schedule');
const B = MM_BUDGET_QUICK_MS; // 5000
ok('t=0 is exact', widenFor(0, B, false) === 0);
ok('t=39% is still exact', widenFor(B * 0.39, B, false) === 0);
ok('t=40% widens to +/-1', widenFor(B * 0.40, B, false) === 1);
ok('t=99% is still +/-1', widenFor(B * 0.99, B, false) === 1);
ok('grace widens to +/-2', widenFor(B * 1.2, B, true) === 2);
ok('past budget WITHOUT grace stays at +/-1 (it is about to resolve)', widenFor(B * 1.2, B, false) === 1);

console.log(failed ? `\n❌ ${failed} failed` : '\n✅ all passed');
process.exit(failed ? 1 : 0);
