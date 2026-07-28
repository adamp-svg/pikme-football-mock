#!/usr/bin/env node
// Generate public/_hub-tour.html — the LAB page for the two hub drag lessons.
//
// Design: docs/superpowers/specs/2026-07-28-hub-tour-lab-design.md
//
// The user's requirement was "clone the lobby exactly as it is". This does not clone it by hand:
// it reads the REAL public/index.html and injects two script tags plus one stylesheet. The output
// therefore loads the real markup, the real style.css, the real client.js and — the part that
// matters — the REAL drag handlers. Nothing about the lobby is reimplemented, so nothing can drift
// apart from it except by forgetting to regenerate — so regenerate whenever the hub changes.
//
// Why a generated FILE and not a runtime iframe (srcdoc / blob:), which would need no build step:
// those documents report `about:srcdoc` (or an opaque blob path) for `location`, and client.js reads
// location.hostname (DEV_LOCAL) and builds its WebSocket URL out of `location`. A fabricated
// document URL breaks both. A real file on a real port keeps every one of those reads honest.
//
// Run: node scripts/make-hub-tour.mjs   then   PORT=3013 node server.js
//      → http://<lan-ip>:3013/_hub-tour.html
// (package.json is deliberately NOT touched: it is a shared file and this lab needs nothing from it.)
import { readFileSync, writeFileSync } from 'node:fs';

const PUB = new URL('../public/', import.meta.url);
const SRC = new URL('index.html', PUB);
const OUT = new URL('_hub-tour.html', PUB);

const src = readFileSync(SRC, 'utf8');

// Every anchor is asserted rather than assumed. index.html is edited by several agents, and a
// silent no-match would produce a page that looks right and teaches nothing — the exact failure
// mode this lab exists to stop having.
const need = (needle, why) => {
  if (!src.includes(needle)) {
    console.error(`✖ make-hub-tour: anchor not found in index.html — ${needle}\n  (${why})`);
    process.exit(1);
  }
};
need('<body>', 'the sandbox has to be the FIRST script in the body, before the client.js module');
need('/hub-tour.js', 'index.html must already load the SHIPPED tour — the lab does not carry its own copy');
need('id="home"', 'no hub in this file means nothing to teach on');
need('id="home-carousel"', 'lesson 1 and 2 both start on the carousel');
need('id="power-slots"', 'lesson 1 drops here');
need('id="pick-hero-btn"', 'lesson 2 drops here');
need('id="tutorial"', 'the coach overlay is reused from the shipped tutorial, not redrawn');

const BANNER = `<!-- ============================================================================
     GENERATED FILE — DO NOT EDIT. Regenerate with: node scripts/make-hub-tour.mjs

     This is public/index.html with a sandbox + a two-lesson coach injected. It exists so the
     hub tour can be taught on an EXACT clone of the lobby (real markup, real CSS, real client.js,
     real drag handlers) with a dummy album, on its own port, writing nothing.

     Design: docs/superpowers/specs/2026-07-28-hub-tour-lab-design.md
     ============================================================================ -->\n`;

let out = src
  // The sandbox must beat the client.js module to the window: it sets SALTIZ_CARDS / _LOADOUT /
  // _COSMETIC, which client.js reads at module-evaluation time and never re-reads.
  .replace('<body>', '<body>\n  <script src="/_hub-tour-sandbox.js"></script>')
  // NOTHING ELSE IS INJECTED. index.html already loads the real /hub-tour.js and /hub-tour.css — the
  // lab runs the SHIPPED tour, not a copy of it, which is the only way the two cannot drift. All the
  // lab adds is the sandbox above: a dummy album, blocked writes, a frozen carousel.
  .replace('<title>סולטיז כדורגל בלוקים</title>', '<title>שיעור לובי — קלפים וכוחות</title>');

out = BANNER + out;

// Belt and braces: a replace that silently matched nothing would ship a page with no lesson on it.
for (const marker of ['_hub-tour-sandbox.js', '/hub-tour.js']) {
  if (!out.includes(marker)) { console.error(`✖ make-hub-tour: injection failed for ${marker}`); process.exit(1); }
}

writeFileSync(OUT, out);
console.log(`✅ wrote public/_hub-tour.html  (${out.length} bytes, from index.html ${src.length})`);
