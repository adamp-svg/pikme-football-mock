// Bundles the REAL shared modules into ONE self-contained HTML file, so the published page runs the
// same sim.js + bot-ai.js the server runs — no reimplementation, no drift, and no network requests
// (an Artifact page is served under a CSP that blocks every external host).
//
// Same ESM -> registry transform as build-bot-scope.mjs, minus that file's two A/B switches. Kept as
// a separate script on purpose: the scope page is another agent's instrument and this must not
// change how it builds.
//
//   node scripts/build-arena-watch.mjs <out.html>              # standalone (publishable), from the WORKTREE
//   node scripts/build-arena-watch.mjs <out.html> --from=HEAD  # ...from committed HEAD instead
//   node scripts/build-arena-watch.mjs --dev                   # also write public/_arena-watch.html
//                                                              (live /shared imports, restart-to-refresh)
//   node scripts/build-arena-watch.mjs --check <out.html>      # is that file still current? exit 1 if stale
//
// ---- WHY --from=HEAD EXISTS, AND WHY A PUBLISH USUALLY WANTS IT --------------------------------
// Several agents edit `shared/` at once in this repo, so the worktree is routinely a half-finished
// state that does not run. Measured 2026-07-26: the tree carried `server.js` calling `require()` in
// an ESM file (the server would not boot) and `bot-ai.js:876` referencing an undefined
// `FROZEN_ARRIVAL_PENALTY` (a ReferenceError inside the bot tick) — both uncommitted, both invisible
// to a bundler that just reads the files. A page published from that tree is a broken page with a
// convincing provenance line. `--from=HEAD` bundles the committed tree instead, and the SMOKE TEST
// below plays a real headless match over whichever source was chosen and refuses to write if it
// throws. A publish should be reproducible from a commit; a worktree is not a commit.
//
// ---- WHAT THE STAMP IS FOR --------------------------------------------------------------------
// A published Artifact cannot fetch anything at runtime (its CSP blocks every external host), so the
// page CANNOT self-update — it is a snapshot by construction. The honest substitute is to make the
// snapshot say exactly what it is: the stamp records the commit, its subject, the build time and a
// sha256 fingerprint over the exact module sources that went in. `--check` compares a built file's
// fingerprint against the current source, which is what lets a hook or a scheduled job notice the
// page has gone stale and rebuild + redeploy it to the same URL.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const REPO = path.resolve(new URL('.', import.meta.url).pathname, '..');
const ARGV = process.argv.slice(2);
const flag = (name) => ARGV.some((a) => a === `--${name}` || a.startsWith(`--${name}=`));
const val = (name, dflt) => {
  const hit = ARGV.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const OUT = ARGV.find((a) => !a.startsWith('--')) || null;
const CHECK = flag('check');
const DEV = flag('dev');
const FROM = val('from', 'worktree');
if (FROM !== 'worktree' && FROM !== 'HEAD') throw new Error(`--from must be worktree or HEAD, got ${FROM}`);
const TEMPLATE = path.join(REPO, 'scripts', 'arena-watch.template.html');
const ENTRIES = ['sim.js', 'bot-ai.js', 'difficulty.js', 'main-field.js', 'field-3v3.js', 'constants.js', 'arena.js'];

const git = (...args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim();
const gitSafe = (...args) => { try { return git(...args); } catch { return null; } };

// ---- where the module sources come from -------------------------------------------------------
// worktree: read shared/ off disk. HEAD: extract the committed tree into a temp dir once, so the
// smoke test can `import()` real files instead of eval-ing a string.
let SRC_DIR = path.join(REPO, 'shared');
let tmpDir = null;
if (FROM === 'HEAD') {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-watch-head-'));
  const tarPath = path.join(tmpDir, 'head.tar');
  fs.writeFileSync(tarPath, execFileSync('git', ['archive', 'HEAD', 'shared'], { cwd: REPO, maxBuffer: 1 << 28 }));
  execFileSync('tar', ['-x', '-f', tarPath, '-C', tmpDir]);
  SRC_DIR = path.join(tmpDir, 'shared');
}
const cleanup = () => { if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true }); };

const seen = new Map();
function load(file) {
  if (seen.has(file)) return;
  const src = fs.readFileSync(path.join(SRC_DIR, file), 'utf8');
  seen.set(file, src);
  for (const m of src.matchAll(/from\s+'\.\/([\w.-]+)'/g)) load(m[1]);
}
for (const e of ENTRIES) load(e);

// ---- the fingerprint: sha256 over "name\0source" for every bundled module, in load order -------
// Byte-exact, so it changes when and only when the bundled CODE changes. Deliberately not the commit
// sha: a commit touching no shared module leaves the page genuinely current, and a dirty worktree
// that edits one is genuinely stale even though HEAD has not moved.
function fingerprint(mods) {
  const h = crypto.createHash('sha256');
  for (const [name, src] of mods) { h.update(name); h.update('\0'); h.update(src); h.update('\0'); }
  return h.digest('hex');
}
// The portable one, for the per-module hashes the PAGE has to be able to recompute. Kept
// behaviourally identical to `fnvHash()` in arena-watch.template.html — if you change one, change
// both, or the page's update check will report every module as changed.
//
// ⚠️ OVER BYTES, NOT OVER A DECODED STRING. Hashing text makes the answer depend on how the
// transport labelled its charset: a server that serves `/shared/x.js` without `charset=utf-8` hands
// the browser a differently-decoded string for identical bytes, and every module reads as changed.
// (server.js does send it — `.js: text/javascript; charset=utf-8` — but the page can be served by
// anything, and a false "BEHIND" on a correct build is the worst failure this check has.) These
// modules contain non-ASCII: Hebrew strings and the — in comments.
function fnv1a(bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8');
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}
const FP = fingerprint(seen);

// ---- --check: is a previously built file still current? ----------------------------------------
if (CHECK) {
  if (!OUT) throw new Error('--check needs a file: node scripts/build-arena-watch.mjs --check out.html');
  cleanup();
  if (!fs.existsSync(OUT)) { console.log(`STALE ${OUT} — does not exist`); process.exit(1); }
  const m = fs.readFileSync(OUT, 'utf8').match(/<script type="application\/json" id="build-stamp">([\s\S]*?)<\/script>/);
  if (!m) { console.log(`STALE ${OUT} — no build stamp (built before stamping existed)`); process.exit(1); }
  const stamp = JSON.parse(m[1]);
  if (stamp.fingerprint === FP) {
    console.log(`CURRENT ${path.basename(OUT)} — shared/ fingerprint ${FP.slice(0, 12)} matches ${FROM}`);
    process.exit(0);
  }
  console.log(`STALE ${path.basename(OUT)}
  page was built from  ${String(stamp.fingerprint).slice(0, 12)}  (${stamp.commit || '?'} ${stamp.builtAt || ''})
  ${FROM} is now        ${FP.slice(0, 12)}
  rebuild:   node scripts/build-arena-watch.mjs ${OUT} --from=${FROM}
  then redeploy the artifact from the SAME file path, so it keeps its URL.`);
  process.exit(1);
}

// ---- SMOKE TEST: play a real match over the chosen source before writing anything ---------------
// The bundle is dead HTML until a browser runs it, so a broken `shared/` yields a page that fails
// only in front of the viewer. This imports the same modules Node-side and plays 30 s at BOTH team
// sizes, which is also the cheapest guard that 3v3 still spawns six bots.
async function smoke() {
  const url = (f) => 'file://' + path.join(SRC_DIR, f);
  const sim = await import(url('sim.js'));
  const ai = await import(url('bot-ai.js'));
  const C = await import(url('constants.js'));
  const mainField = await import(url('main-field.js'));
  const f3 = await import(url('field-3v3.js'));
  for (const [label, teamSize, field] of [['2v2', 2, mainField.MAIN_FIELD], ['3v3', 3, f3.FIELD_3V3]]) {
    const s = sim.createState();
    s.teamSize = teamSize;                 // BEFORE setField/addPlayer — the spawn plan is per slot
    s.goalsToWin = 0;
    sim.setField(s, field);
    s.rng = sim.makeRng(20260726);
    for (const team of ['A', 'B']) {
      for (let slot = 0; slot < teamSize; slot++) {
        const id = team + slot;
        sim.addPlayer(s, id, { name: id, char: 'player', team, slot, isBot: true });
      }
    }
    sim.attachBall(s, 'A');
    const mem = ai.createBotMemory('normal');
    mem.teamSkill = { A: 0.93, B: 0.93 };
    for (let i = 0; i < 1800; i++) sim.step(s, ai.computeBotInputs(s, mem, C.DT), C.DT);
    const n = Object.keys(s.players).length;
    if (n !== teamSize * 2) throw new Error(`smoke ${label}: expected ${teamSize * 2} players, got ${n}`);
    if (!isFinite(s.ball.x) || !isFinite(s.ball.y)) throw new Error(`smoke ${label}: ball went non-finite`);
    console.log(`  smoke ${label}: 30 s played, ${n} bots, score ${s.score.A}:${s.score.B} — ok`);
  }
}
console.log(`bundling shared/ from ${FROM}${FROM === 'HEAD' ? ` (${gitSafe('rev-parse', '--short', 'HEAD') || '?'})` : ''} — smoke test first:`);
try {
  await smoke();
} catch (e) {
  console.error(`\nSMOKE TEST FAILED — refusing to build a page that does not run.\n  ${(e && e.message) || e}`);
  if (FROM === 'worktree') console.error('  Is the worktree mid-edit by another agent? Try --from=HEAD.');
  cleanup();
  process.exit(2);
}

function transform(file, src) {
  const exports = new Set();
  let out = src;
  out = out.replace(/import\s*\{([\s\S]*?)\}\s*from\s*'\.\/([\w.-]+)'\s*;?/g, (_m, names, mod) => {
    const cleaned = names.split(',').map((s) => s.trim()).filter(Boolean)
      .map((s) => (s.includes(' as ') ? s.replace(/\s+as\s+/, ': ') : s)).join(', ');
    return `const { ${cleaned} } = __req(${JSON.stringify(mod)});`;
  });
  if (/^\s*import\s/m.test(out)) throw new Error(`${file}: unhandled import form`);
  out = out.replace(/export\s*\{([^}]*)\}\s*;?/g, (_m, names) => {
    names.split(',').map((s) => s.trim()).filter(Boolean).forEach((n) => exports.add(n.split(/\s+as\s+/).pop()));
    return '';
  });
  out = out.replace(/export\s+(const|let|var|function\*?|class|async function)\s+([A-Za-z_$][\w$]*)/g, (_m, kind, name) => {
    exports.add(name);
    return `${kind} ${name}`;
  });
  if (/\bexport\b/.test(out.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''))) {
    throw new Error(`${file}: leftover export`);
  }
  return { code: out, exports: [...exports] };
}

const parts = [];
for (const [file, src] of seen) {
  const { code, exports } = transform(file, src);
  parts.push(`__def(${JSON.stringify(file)}, function (__req) {\n${code}\nreturn { ${exports.join(', ')} };\n});`);
}
const bundle = `(() => {
const __mods = {}, __cache = {};
function __def(name, fn) { __mods[name] = fn; }
function __req(name) {
  if (!(name in __cache)) {
    if (!__mods[name]) throw new Error('missing module ' + name);
    __cache[name] = null;
    __cache[name] = __mods[name](__req);
  }
  return __cache[name];
}
${parts.join('\n')}
window.SALTIZ = { req: __req };
})();`;

// ---- the stamp the page renders ---------------------------------------------------------------
const dirtyShared = (gitSafe('status', '--porcelain', '--', 'shared') || '').split('\n').filter(Boolean).map((l) => l.slice(3));
const stamp = {
  source: FROM,
  commit: gitSafe('rev-parse', '--short', 'HEAD'),
  subject: gitSafe('log', '-1', '--format=%s'),
  commitAt: gitSafe('log', '-1', '--format=%cI'),
  builtAt: new Date().toISOString(),
  fingerprint: FP,
  modules: [...seen.keys()],
  // PER-MODULE hashes, so the page's "Check for a newer build" button can fetch /shared/<name> —
  // which only resolves when the page is served BY the game server, never inside the artifact
  // sandbox — and name the modules that differ instead of just saying "something changed".
  //
  // ⚠️ FNV-1a, NOT sha256, and that is deliberate: the browser side of this comparison has to
  // compute the same value, and `crypto.subtle` is undefined outside a secure context. The dev
  // server is plain HTTP on a LAN IP (http://10.100.102.36:3012 — the user's own test surface), so
  // WebCrypto is unavailable exactly where the button is meant to work. This hash needs to detect
  // change, not resist an attacker.
  moduleHashes: Object.fromEntries([...seen].map(([n, src]) => [n, fnv1a(src)])),
  // Only meaningful for a worktree build: which shared modules were uncommitted when it was bundled.
  dirtyShared: FROM === 'worktree' ? dirtyShared : [],
};
const stampTag = `<script type="application/json" id="build-stamp">${JSON.stringify(stamp)}</script>`;

const tpl = fs.readFileSync(TEMPLATE, 'utf8');
if (!tpl.includes('<!--BUNDLE-->')) throw new Error('template is missing the <!--BUNDLE--> marker');
if (!tpl.includes('<!--STAMP-->')) throw new Error('template is missing the <!--STAMP--> marker');

if (OUT) {
  fs.writeFileSync(OUT, tpl.replace('<!--BUNDLE-->', `<script>\n${bundle}\n</script>`).replace('<!--STAMP-->', stampTag));
  console.log(`${OUT} ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB standalone — from ${FROM} ${stamp.commit || ''}, fingerprint ${FP.slice(0, 12)}`);
  console.log(`  modules: ${[...seen.keys()].join(', ')}`);
  if (FROM === 'worktree' && dirtyShared.length) console.log(`  ⚠️  bundled UNCOMMITTED changes in: ${dirtyShared.join(', ')}`);
}
if (DEV) {
  const names = [...seen.keys()];
  const live = `<script type="module">
${names.map((n, i) => `import * as m${i} from '/shared/${n}';`).join('\n')}
const __m = { ${names.map((n, i) => `${JSON.stringify(n)}: m${i}`).join(', ')} };
window.SALTIZ = { req: (n) => __m[n] };
</script>`;
  // The dev page is the one that IS always current: it imports /shared live off the server, so it
  // reflects whatever the tree holds after a restart. No fingerprint could be honest about that, so
  // its stamp says `live` instead of claiming a build identity.
  const devStamp = `<script type="application/json" id="build-stamp">${JSON.stringify({
    source: 'live', commit: stamp.commit, subject: stamp.subject, commitAt: stamp.commitAt,
    builtAt: stamp.builtAt, fingerprint: null, modules: names, dirtyShared: [],
  })}</script>`;
  const page = tpl.replace('<!--BUNDLE-->', live).replace('<!--STAMP-->', devStamp)
    .replace('<title>', '<!-- GENERATED by scripts/build-arena-watch.mjs from arena-watch.template.html — edit the template. -->\n<title>');
  fs.writeFileSync(path.join(REPO, 'public', '_arena-watch.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
</head><body>
${page}
</body></html>`);
  console.log('public/_arena-watch.html written (live imports — always current; restart the server after a shared/ edit)');
}
cleanup();
