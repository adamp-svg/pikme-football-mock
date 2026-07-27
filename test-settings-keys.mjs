// The settings panel must be able to format EVERY key it iterates.
//
// The bug this pins (reported from a device, 2026-07-27): public/client.js kept its own hand-written
// copy of the sim's default settings, and it had drifted to 8 of the 10 keys in SETTING_KEYS —
// `bombReloadSpeed` and `wallReloadSpeed` were added to defaultSettings() and never mirrored. Opening
// the settings panel runs syncSliderUI(), which does `SETTING_FMT[k](settings[k])` for every key, so a
// missing value hit `undefined.toFixed` and painted
// «TypeError: undefined is not an object (evaluating 'v.toFixed')» across a live match.
//
// It reproduced only sometimes, which is why it survived: `matchStart` carries `settings` and
// Object.assign patched the holes afterwards, so the crash needed the panel opened BEFORE that landed.
//
// Three separate lists have to agree — the sim's defaults, the keys the UI walks, and the formatters —
// and nothing structural forces them to. That is what this checks.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { defaultSettings } from './shared/constants.js';

const here = dirname(fileURLToPath(import.meta.url));
const client = readFileSync(join(here, 'public/client.js'), 'utf8');
let failed = 0;
const ok = (l, c, x = '') => { if (!c) failed++; console.log(`  ${c ? '✅' : '❌'} ${l}${x ? ` — ${x}` : ''}`); };

// Parse the two lists out of client.js rather than importing it (it is a browser module that touches
// document/window at load).
const keysLine = client.slice(client.indexOf('const SETTING_KEYS ='));
const SETTING_KEYS = keysLine.slice(keysLine.indexOf('['), keysLine.indexOf(']') + 1)
  .match(/'[^']+'/g).map((s) => s.slice(1, -1));
const fmtBlock = client.slice(client.indexOf('const SETTING_FMT ='), client.indexOf('function syncSliderUI'));
const FMT_KEYS = [...fmtBlock.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);
const defaults = Object.keys(defaultSettings());

console.log('the three lists agree');
ok(`SETTING_KEYS parsed (${SETTING_KEYS.length})`, SETTING_KEYS.length > 0, SETTING_KEYS.join(','));
ok('every SETTING_KEY has a default in the SIM', SETTING_KEYS.every((k) => defaults.includes(k)),
  `missing from defaultSettings(): ${SETTING_KEYS.filter((k) => !defaults.includes(k)).join(',') || 'none'}`);
ok('every SETTING_KEY has a formatter', SETTING_KEYS.every((k) => FMT_KEYS.includes(k)),
  `no formatter: ${SETTING_KEYS.filter((k) => !FMT_KEYS.includes(k)).join(',') || 'none'}`);
ok('no formatter exists for a key the UI never walks', FMT_KEYS.every((k) => SETTING_KEYS.includes(k)),
  `orphans: ${FMT_KEYS.filter((k) => !SETTING_KEYS.includes(k)).join(',') || 'none'}`);

console.log('\nthe client does not keep its own copy of the defaults');
// The literal is what drifted. Importing the function is the only thing that makes drift impossible.
ok('client.js imports defaultSettings from shared/constants.js', /\bdefaultSettings\b/.test(client.slice(0, client.indexOf("} from '/shared/constants.js'"))));
ok('`settings` is defaultSettings(), not a hand-written object literal',
  /const settings = defaultSettings\(\)/.test(client));

console.log('\nevery formatter survives every default value');
// The actual crash, executed rather than reasoned about: run each formatter on the real default.
const FMT = {};
for (const m of fmtBlock.matchAll(/^\s{2}(\w+): \((\w)\) => (.+?),\s*$/gm)) {
  // eslint-disable-next-line no-new-func
  FMT[m[1]] = new Function(m[2], `return ${m[3]}`);
}
const d = defaultSettings();
let threw = 0;
for (const k of SETTING_KEYS) {
  try { const out = FMT[k](d[k]); if (typeof out !== 'string' || !out.length) threw++; }
  catch { threw++; console.log(`     ↳ ${k} threw on ${d[k]}`); }
}
ok('all formatters produce a non-empty string from the sim defaults', threw === 0, `${threw} failed`);

console.log('\nsyncSliderUI cannot take a live match down over one missing value');
const sync = client.slice(client.indexOf('function syncSliderUI'), client.indexOf('function syncSliderUI') + 900);
ok('it skips a non-finite value instead of formatting it', /Number\.isFinite\(v\)/.test(sync));
ok('...and reads the value ONCE rather than re-indexing per use', /const v = settings\[k\]/.test(sync));

console.log(failed ? `\n❌ ${failed} failed` : '\n✅ all passed');
process.exit(failed ? 1 : 0);
