// GUARD: the CSS outline mitigation and the artwork must never drift out of step.
//
// BACKGROUND. The bomb and wall ability buttons shipped looking like their black parts were
// transparent. Cause: the icon pack's source art has an OPEN outline — the silhouette edge is a
// scatter of isolated dark pixels rather than a continuous line, so the button colour shows through
// the gaps. It is only obvious on the two icons big enough to notice (56px and 40px, upscaled again
// by device pixel ratio); at lobby size the downscale averages it away.
//
// The current fix is a CSS mitigation in icon-system.css: four 1px drop-shadows that give every
// opaque pixel a dark neighbour, closing the ring. It is deliberately temporary — codex is
// regenerating the pack with closed outlines.
//
// THIS FILE EXISTS SO THE HANDOVER CANNOT GO WRONG IN EITHER DIRECTION:
//   art still open  + mitigation present  -> OK (today)
//   art fixed       + mitigation removed  -> OK (the goal)
//   art still open  + mitigation removed  -> FAIL, the bug is back
//   art fixed       + mitigation present  -> FAIL, outlines get doubled/muddy
//
// It lives in its own file rather than inside test-icon-system.mjs because that file ships WITH the
// asset pack and would be overwritten by a regeneration.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
let failed = 0;
const ok = (label, cond, extra = '') => { if (!cond) failed++; console.log(`  ${cond ? '✅' : '❌'} ${label}${extra ? ` — ${extra}` : ''}`); };

const css = readFileSync(join(here, 'public/icon-system.css'), 'utf8');

// The two icons this is about, and where they live in the 12x8 grid.
const TARGETS = [{ id: 'bomb', col: 4, row: 1 }, { id: 'build-wall', col: 5, row: 1 }];
// Above this, an outline is too broken to render without help. Today: bomb 5.5%, build-wall 20.1%.
// A closed outline measures near zero — a pixel on a real line has >= 2 dark neighbours along it.
const OPEN_THRESHOLD = 3.0;

let PNG;
try {
  const { default: sharpOrPil } = { default: null };   // no image dep in this repo
  void sharpOrPil;
} catch { /* unused */ }

// Decoding a PNG without a dependency is not worth it here, so shell out to python3+PIL, which the
// asset pipeline already relies on. If it is unavailable, SKIP rather than fail: this guard must
// never be the reason a green suite goes red on someone else's machine.
import { spawnSync } from 'node:child_process';
const py = spawnSync('python3', ['-c', `
import json
try:
    from PIL import Image
except Exception:
    print(json.dumps({"skip": "PIL unavailable"})); raise SystemExit
im = Image.open(${JSON.stringify(join(here, 'public/assets/pixel-icon-system-01/sprite-pack.png'))}).convert('RGBA')
W, H = im.size; CW, CH = W // 12, H // 8
out = {}
for name, c, r in ${JSON.stringify(TARGETS.map((t) => [t.id, t.col, t.row]))}:
    cell = im.crop((c * CW, r * CH, (c + 1) * CW, (r + 1) * CH)); px = cell.load()
    dark = lambda x, y: px[x, y][3] > 120 and sum(px[x, y][:3]) < 260
    iso = tot = 0
    for x in range(1, CW - 1):
        for y in range(1, CH - 1):
            if not dark(x, y): continue
            tot += 1
            n = sum(dark(x + dx, y + dy) for dx in (-1, 0, 1) for dy in (-1, 0, 1) if (dx, dy) != (0, 0))
            if n <= 2: iso += 1
    out[name] = round(100 * iso / tot, 1) if tot else 0.0
print(json.dumps(out))
`], { encoding: 'utf8' });

let measured = null;
try { measured = JSON.parse((py.stdout || '').trim().split('\n').pop()); } catch { /* handled below */ }

console.log('icon outline guard');
if (!measured || measured.skip) {
  console.log(`  ⏭  SKIPPED (${measured?.skip || 'could not measure the sheet'}) — nothing asserted`);
  process.exit(0);
}

// Is the mitigation currently in place? Match the intent, not the exact shadow list.
const block = css.slice(Math.max(0, css.indexOf('SYNTHESIZED OUTLINE')));
const mitigated = css.includes('SYNTHESIZED OUTLINE') && /drop-shadow\([^)]*\)\s*drop-shadow/.test(block);

for (const { id } of TARGETS) {
  const open = measured[id];
  console.log(`  ℹ  ${id}: ${open}% of outline pixels are isolated (threshold ${OPEN_THRESHOLD}%)`);
  if (open > OPEN_THRESHOLD) {
    ok(`${id} art is still open, so the CSS mitigation must stay`, mitigated,
      mitigated ? '' : 'REMOVE-ME: the drop-shadow block is gone but the art still has gaps — the "transparent black parts" bug is back');
  } else {
    ok(`${id} art is fixed, so the CSS mitigation must be REMOVED`, !mitigated,
      mitigated ? 'The new pack has closed outlines. Delete the SYNTHESIZED OUTLINE block in public/icon-system.css — leaving it doubles the outline.' : '');
  }
}

console.log(failed ? `\n❌ ${failed} failed` : '\n✅ art and mitigation are in step');
process.exit(failed ? 1 : 0);
