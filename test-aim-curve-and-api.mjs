// Three deliberate decisions that are easy to "helpfully" undo, so they're pinned here.
//
// 1. עקומת משיכה is NOT a setting. The user removed the slider and fixed the pull curve at the
//    precise end (2.2). A future controls-editor pass must not re-add the slider.
// 2. PIKME_API's browser fallback must be the LIVE api host. It used to be
//    pikme-server.onrender.com, which is dead (plain-text 404) — in-app that was invisible because
//    the app injects window.PIKME_API, so friends/DMs broke silently in every browser test.
// 3. The hub must be able to fetch its OWN rank standing. window.SALTIZ_RANK comes from an app
//    inject that only exists in app builds we don't control, so the self-fetch is the only thing
//    making the RANK badge visible in a browser or a pre-rank app build.
//
// client.js can't be imported here (browser module: opens a WebSocket and touches canvas on load),
// so these are source/markup assertions — same approach as test-modes-table.mjs.
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, 'public/index.html'), 'utf8');
const src = readFileSync(join(here, 'public/client.js'), 'utf8');

let failed = 0;
const ok = (label, cond, extra = '') => { if (!cond) failed++; console.log(`  ${cond ? '✅' : '❌'} ${label}${extra ? ` — ${extra}` : ''}`); };
// Comments legitimately NAME the things we're banning (they explain why the dead host was dropped),
// so "is it gone" questions have to be asked of the code only.
const code = src.replace(/^\s*\/\/.*$/gm, '');

const { window } = new JSDOM(html);
const doc = window.document;

console.log('pull curve — pinned, not a slider');
ok('no עקומת משיכה slider input in the editor', !doc.getElementById('s-aimCurve'));
ok('no value readout for it either', !doc.getElementById('v-aimCurve'));
ok('the Hebrew label is gone from the markup', !html.includes('עקומת משיכה'));
ok('the idle-opacity slider survived', !!doc.getElementById('s-ctlOpacity'));
// The editor's slider row should now hold exactly that one control.
ok('editor exposes exactly 1 slider', doc.querySelectorAll('.ce-sliders .ce-slider').length === 1,
  `found ${doc.querySelectorAll('.ce-sliders .ce-slider').length}`);
const curve = src.match(/const AIM_CURVE = ([\d.]+);/);
ok('AIM_CURVE is a const', !!curve);
ok('AIM_CURVE === 2.2', curve && Number(curve[1]) === 2.2, curve ? curve[1] : 'missing');
ok('aimFrac applies it', /return Math\.pow\(t, AIM_CURVE\)/.test(src));
ok('no live aimCurve variable is left', !/\baimCurve\b/.test(code));
ok('it is not in the slider registry', !/'s-aimCurve'/.test(src));

console.log('PIKME_API fallback host');
const api = src.match(/const PIKME_API = \([^)]*window\.PIKME_API[\s\S]*?\)\.replace/);
ok('PIKME_API resolution found', !!api);
ok('falls back to server.pikme.tv', /'https:\/\/server\.pikme\.tv'/.test(api ? api[0] : ''));
ok('the dead onrender host is gone from the code', !code.includes('pikme-server.onrender.com'));
ok('a true localhost page still assumes a local api', /localhost:3001/.test(api ? api[0] : ''));

console.log('rank self-fetch');
ok('fetchOwnRank exists', /async function fetchOwnRank\(\)/.test(src));
ok('an app inject is never overwritten', (src.match(/if \(window\.SALTIZ_RANK\) return;/g) || []).length >= 2);
ok('token path uses /handle-friends/rank', /apiGet\('\/handle-friends\/rank'\)/.test(src));
ok('browser path uses ?phone= against football\/stats', /handle-user\/football\/stats\?phone=/.test(src));
ok('a missing rankPoints is treated as "not deployed", not 0', /if \(!Number\.isFinite\(rp\)\) return;/.test(src));
ok('delta is 0 on a standing read', /delta: 0, botLevel: null/.test(src));
ok('it is rate-limited', /RANK_SELF_MS/.test(src));
ok('the hub loop calls it', /fetchOwnRank\(\);\s*\n\s*pollRank\(\);/.test(src));

// TDZ ORDER — this shipped broken once. startHomeDance() is INVOKED at module level and its loop()
// runs synchronously on the first frame, so it reaches fetchOwnRank() during module evaluation.
// `function` declarations hoist; `let`/`const` do not. State declared after that invocation throws
// "Cannot access '_rankSelfAt' before initialization" and the whole hub dies — on a device only,
// because neither a source assertion nor a curl of the served bytes executes the module.
const lineOf = (re) => { const l = src.split('\n').findIndex((s) => re.test(s)); return l < 0 ? Infinity : l + 1; };
const stateLine = lineOf(/^let _rankSelfAt = 0, _rankSelfBusy = false;/);
const msLine = lineOf(/^const RANK_SELF_MS = /);
const invokeLine = lineOf(/^startHomeDance\(\);/);
ok('startHomeDance() is invoked at module level (the hazard is real)', invokeLine !== Infinity, `line ${invokeLine}`);
ok('_rankSelfAt/_rankSelfBusy initialize BEFORE it', stateLine < invokeLine, `state ${stateLine} vs invoke ${invokeLine}`);
ok('RANK_SELF_MS initializes BEFORE it', msLine < invokeLine, `const ${msLine} vs invoke ${invokeLine}`);

console.log(failed ? `\n❌ ${failed} failed` : '\n✅ all passed');
process.exit(failed ? 1 : 0);
