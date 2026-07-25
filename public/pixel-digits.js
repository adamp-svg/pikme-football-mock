// A 4×7 pixel bitmap font for the match clock and score.
//
// WHY NOT A FONT FILE: the game ships offline inside a WebView, so an @font-face download is not
// available and a bundled .ttf would still be hinted/antialiased by the text renderer — the digits
// would come out soft next to the hard-edged heroes, walls and pixel trophy. Drawing the glyphs as
// real blocks keeps every edge on the pixel grid at any size.
//
// HOW: one element per glyph. Its lit pixels are painted with `box-shadow` (the same trick the hub's
// pixel trophy uses) in `currentColor`, so all the existing colour classes keep working untouched —
// `.timer.urgent` red, `.timer.overtime` gold, `.team-a` / `.team-b` kit colours. No JS knows about
// colour at all.
//
// PERF: drawHUD() runs every frame, but a glyph's box-shadow is only rebuilt when its character or
// pixel size actually changes (the clock ticks once a second, the score almost never), and the
// shadow strings are memoised per (char, size). A steady frame does zero DOM work.

// Each glyph is 7 rows of a 4-wide bitmap. '1' is drawn 4 wide too, so the clock never reflows as
// the digits change — a proportional '1' makes a tabular clock jitter.
const GLYPHS = {
  '0': ['1111', '1001', '1001', '1001', '1001', '1001', '1111'],
  '1': ['0110', '0010', '0010', '0010', '0010', '0010', '0111'],
  '2': ['1111', '0001', '0001', '1111', '1000', '1000', '1111'],
  '3': ['1111', '0001', '0001', '1111', '0001', '0001', '1111'],
  '4': ['1001', '1001', '1001', '1111', '0001', '0001', '0001'],
  '5': ['1111', '1000', '1000', '1111', '0001', '0001', '1111'],
  '6': ['1111', '1000', '1000', '1111', '1001', '1001', '1111'],
  '7': ['1111', '0001', '0001', '0010', '0010', '0100', '0100'],
  '8': ['1111', '1001', '1001', '1111', '1001', '1001', '1111'],
  '9': ['1111', '1001', '1001', '1111', '0001', '0001', '1111'],
  ':': ['0000', '0110', '0110', '0000', '0110', '0110', '0000'],
  '-': ['0000', '0000', '0000', '1111', '0000', '0000', '0000'],
  '–': ['0000', '0000', '0000', '1111', '0000', '0000', '0000'],
  '?': ['1111', '1001', '0001', '0011', '0010', '0000', '0010'],
};
export const GLYPH_W = 4, GLYPH_H = 7;
// A space is a real glyph so a padded string keeps its width.
const BLANK = ['0000', '0000', '0000', '0000', '0000', '0000', '0000'];

const shadowCache = new Map();   // `${ch}@${px}` -> box-shadow string

// The lit pixels of one glyph as a box-shadow list. The carrier element is 1 pixel-unit square and
// transparent; every block — including the one at (0,0) — is a shadow, so an unlit top-left corner
// is genuinely empty rather than a stray dot.
function shadowFor(ch, px) {
  const key = `${ch}@${px}`;
  const hit = shadowCache.get(key);
  if (hit !== undefined) return hit;
  const rows = GLYPHS[ch] || BLANK;
  const parts = [];
  for (let r = 0; r < GLYPH_H; r++) {
    const row = rows[r] || '0000';
    for (let c = 0; c < GLYPH_W; c++) {
      if (row[c] === '1') parts.push(`${c * px}px ${r * px}px 0 0 currentColor`);
    }
  }
  const out = parts.join(',') || 'none';
  shadowCache.set(key, out);
  return out;
}

// Paint `str` into `el` as pixel glyphs. `px` is the size of one pixel block.
//
// Reuses the existing glyph elements when the length is unchanged, so a clock tick rewrites two
// style properties rather than rebuilding the subtree. Returns true if anything actually changed.
export function setPixelText(el, str, px) {
  if (!el) return false;
  const s = String(str);
  if (el._pdText === s && el._pdPx === px) return false;   // nothing to do — the common case
  el._pdText = s; el._pdPx = px;

  el.classList.add('pd');
  el.style.setProperty('--pd-px', `${px}px`);

  // Rebuild the glyph list only when the length changes; otherwise repoint the existing ones.
  if (el.childElementCount !== s.length || !el.firstElementChild || !el.firstElementChild.classList.contains('pd-g')) {
    el.textContent = '';
    for (let i = 0; i < s.length; i++) {
      const g = document.createElement('span');
      g.className = 'pd-g';
      g.appendChild(document.createElement('i'));
      el.appendChild(g);
    }
  }
  for (let i = 0; i < s.length; i++) {
    const g = el.children[i];
    const ch = s[i];
    // A colon is narrower than a digit — a clock reading "1:45" should not have a gaping gap.
    g.style.width = `${(ch === ':' ? 2 : GLYPH_W) * px}px`;
    g.firstElementChild.style.boxShadow = shadowFor(ch, px);
  }
  return true;
}

// The CSS the glyphs need. Injected by the caller (see mountPixelDigitCss) rather than living in
// style.css, which several agents edit concurrently.
export const PIXEL_DIGIT_CSS = `
.pd { display: inline-flex; align-items: flex-start; gap: var(--pd-px); line-height: 0;
  font-size: 0; /* kill any inherited text metrics — the glyphs are pure boxes */ }
.pd .pd-g { position: relative; display: block; height: calc(${GLYPH_H} * var(--pd-px)); flex: none; }
.pd .pd-g > i { position: absolute; top: 0; left: 0;
  width: var(--pd-px); height: var(--pd-px); background: transparent; }
`;

let mounted = false;
export function mountPixelDigitCss() {
  if (mounted || typeof document === 'undefined') return;
  mounted = true;
  const st = document.createElement('style');
  st.textContent = PIXEL_DIGIT_CSS;
  document.head.appendChild(st);
}
