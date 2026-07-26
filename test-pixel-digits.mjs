// The pixel-block clock/score font, under jsdom. Two things matter and neither is visible from
// reading the code: that the glyphs are the right SHAPE (a bug here is a wrong-looking digit on a
// phone, not an exception), and that a per-frame repaint does NO DOM work — drawHUD calls this
// 60×/second, so a naive rebuild would churn the subtree every frame of every match.
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
let failed = 0;
const ok = (label, cond, extra = '') => { if (!cond) failed++; console.log(`  ${cond ? '✅' : '❌'} ${label}${extra ? ` — ${extra}` : ''}`); };

const dom = new JSDOM('<!doctype html><html><head></head><body><div id="t"></div></body></html>', { url: 'http://localhost:3012/' });
global.window = dom.window; global.document = dom.window.document;

const pd = await import('./public/pixel-digits.js');
const el = document.getElementById('t');
const glyphs = () => [...el.querySelectorAll('.pd-g')];
// Recover the lit grid of glyph i straight from its box-shadow, so this asserts what will actually
// be painted rather than what the source table says.
function litGrid(i, px) {
  const sh = glyphs()[i].firstElementChild.style.boxShadow || '';
  const set = new Set();
  for (const m of sh.matchAll(/(-?\d+)px\s+(-?\d+)px/g)) set.add(`${+m[1] / px},${+m[2] / px}`);
  const rows = [];
  for (let r = 0; r < pd.GLYPH_H; r++) {
    let s = '';
    for (let c = 0; c < pd.GLYPH_W; c++) s += set.has(`${c},${r}`) ? '1' : '0';
    rows.push(s);
  }
  return rows;
}

console.log('--- renders one glyph per character ---');
pd.setPixelText(el, '1:45', 2);
ok('four characters -> four glyphs', glyphs().length === 4, `${glyphs().length}`);
ok('adds the .pd class', el.classList.contains('pd'));
ok('publishes the pixel size as a custom property', el.style.getPropertyValue('--pd-px') === '2px');
ok('every glyph carries a box-shadow', glyphs().every((g) => (g.firstElementChild.style.boxShadow || '').includes('px')));
ok('the shadows paint in currentColor, so CSS colour classes still drive them',
  glyphs().every((g) => g.firstElementChild.style.boxShadow.includes('currentColor')));

console.log('\n--- the glyph SHAPES are right ---');
{
  pd.setPixelText(el, '0123456789', 3);
  ok('ten digits render', glyphs().length === 10);
  // A '0' must be a closed ring: full top and bottom, both walls lit, middle hollow.
  const zero = litGrid(0, 3);
  ok("'0' has a solid top and bottom bar", zero[0] === '1111' && zero[6] === '1111', zero.join('|'));
  ok("'0' is hollow in the middle", zero.slice(1, 6).every((r) => r === '1001'), zero.join('|'));
  // A '1' must be 4 cells wide like every other digit, or the clock jitters as it ticks.
  const one = litGrid(1, 3);
  ok("'1' occupies the full 4-cell width like the rest", one.every((r) => r.length === 4));
  ok("'1' has a stem every row", one.every((r) => r.includes('1')), one.join('|'));
  // '8' is the densest glyph: three bars and both walls.
  const eight = litGrid(8, 3);
  ok("'8' has three horizontal bars", eight[0] === '1111' && eight[3] === '1111' && eight[6] === '1111', eight.join('|'));
  // Every digit must actually differ from every other one.
  const shapes = [...Array(10)].map((_, i) => litGrid(i, 3).join('|'));
  ok('all ten digits are distinct', new Set(shapes).size === 10, `${new Set(shapes).size} unique`);
  ok('no digit is blank', shapes.every((s) => s.includes('1')));
}

console.log('\n--- separators ---');
{
  pd.setPixelText(el, ':', 3);
  const colon = litGrid(0, 3);
  ok('the colon is two dots, not a bar', colon[0] === '0000' && colon[3] === '0000' && colon[1].includes('1') && colon[5].includes('1'), colon.join('|'));
  ok('the colon is narrower than a digit', glyphs()[0].style.width === '6px', glyphs()[0].style.width);
  pd.setPixelText(el, '2–1', 3);
  const dash = litGrid(1, 3);
  ok('the score dash is a single mid bar', dash[3] === '1111' && dash.filter((r) => r.includes('1')).length === 1, dash.join('|'));
  ok('digits keep the full 4-cell width', glyphs()[0].style.width === '12px');
}

console.log('\n--- an unknown character degrades to a blank, it must never throw ---');
{
  let threw = null;
  try { pd.setPixelText(el, 'X 9', 2); } catch (e) { threw = e; }
  ok('renders unknown characters without throwing', threw === null, threw && threw.message);
  ok('...as three glyphs still', glyphs().length === 3);
  ok('...with the blank ones empty', litGrid(0, 2).every((r) => r === '0000'));
  ok('...and the known one drawn', litGrid(2, 2).some((r) => r.includes('1')));
}

console.log('\n--- PERF: a repaint with identical text does nothing ---');
{
  pd.setPixelText(el, '1:23', 2);
  const before = glyphs()[0].firstElementChild;
  const changed = pd.setPixelText(el, '1:23', 2);
  ok('a same-text repaint reports no change', changed === false);
  ok('...and does not replace the glyph elements', glyphs()[0].firstElementChild === before);
  // 60 frames of an unchanged clock, the real drawHUD pattern.
  let churn = 0;
  for (let f = 0; f < 60; f++) if (pd.setPixelText(el, '1:23', 2)) churn++;
  ok('60 frames of an unchanged clock cause zero DOM writes', churn === 0, `${churn} writes`);
  ok('a real tick DOES repaint', pd.setPixelText(el, '1:22', 2) === true);
  ok('a size change repaints too', pd.setPixelText(el, '1:22', 3) === true);
}

console.log('\n--- same-length changes reuse the elements ---');
{
  pd.setPixelText(el, '2:00', 2);
  const kept = glyphs()[0];
  pd.setPixelText(el, '1:59', 2);
  ok('a same-length tick keeps the existing glyph nodes', glyphs()[0] === kept);
  pd.setPixelText(el, '9', 2);
  ok('a length change rebuilds', glyphs().length === 1);
}

console.log('\n--- the CSS it needs ---');
{
  pd.mountPixelDigitCss();
  const styles = [...document.querySelectorAll('style')].map((s) => s.textContent).join('\n');
  ok('injects its own <style> (no style.css edit needed)', styles.includes('.pd-g'));
  ok('kills inherited text metrics so the boxes are the only geometry', styles.includes('font-size: 0'));
  pd.mountPixelDigitCss();
  ok('mounting twice does not duplicate the <style>',
    [...document.querySelectorAll('style')].filter((s) => s.textContent.includes('.pd-g')).length === 1);
}

console.log('\n--- the HUD is wired to it, and stacked clock-over-score ---');
{
  const css = readFileSync(join(here, 'public/style.css'), 'utf8');
  const src = readFileSync(join(here, 'public/client.js'), 'utf8');
  // 2026-07-26: #hud became a 3-COLUMN GRID — my team's power cards · the clock/score/caption stack ·
  // the opponents' cards. The stack itself is unchanged (clock, score, caption, top to bottom), but it
  // is now expressed as explicit grid rows in the middle column instead of flex `order:`.
  const hud = css.match(/^#hud \{[^}]*\}/m);
  ok('#hud is a grid', !!hud && /display: grid/.test(hud[0]));
  ok('#hud has three columns (cards · stack · cards)', !!hud && /grid-template-columns: 1fr auto 1fr/.test(hud[0]));
  ok('#hud forces PHYSICAL columns (RTL would mirror my team to the right)', !!hud && /direction: ltr/.test(hud[0]));
  const timer = css.match(/^\.timer \{[^}]*\}/m);
  ok('the clock is the first row of the centre column', !!timer && /grid-area: 1 \/ 2/.test(timer[0]), timer && timer[0].slice(0, 60));
  ok('the clock is no longer pinned top-right', !/^\.timer \{[^}]*position: fixed/m.test(css));
  ok('the score is the second row', /^\.score \{[^}]*grid-area: 2 \/ 2/m.test(css));
  ok('the caption is the third row', /^\.score-fmt \{[^}]*grid-area: 3 \/ 2/m.test(css));
  ok('both have a pixel-size knob', /^\.timer \{[^}]*--pd-px/m.test(css) && /^\.score \{[^}]*--pd-px/m.test(css));
  ok('the card powers moved off the old clock offset', !/\.match-powers \{[^}]*right: 118px/.test(css));
  // The rails flank the stack: mine in column 1 (physically left), opponents in column 3.
  ok('my team rail sits left of the stack', /^\.match-powers \{[^}]*grid-area: 1 \/ 1/m.test(css));
  ok('opponent rail sits right of the stack', /^\.match-powers-foe \{[^}]*grid-area: 1 \/ 3/m.test(css));
  ok('the score keeps its RTL order inside the LTR grid', /#hud \.score,[^{]*\{[^}]*direction: rtl/.test(css));
  ok('client.js renders the clock through the pixel font', /setPixelText\(timerEl/.test(src));
  ok('client.js renders both score halves through it', (src.match(/setPixelText\(/g) || []).length >= 4, `${(src.match(/setPixelText\(/g) || []).length} call sites`);
}

console.log(failed ? `\n${failed} FAILED` : '\nall pixel-digit checks passed');
process.exit(failed ? 1 : 0);
