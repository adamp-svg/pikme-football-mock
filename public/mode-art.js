// Pixel art for the mode-pick cards — Minecraft-style chunky blocks.
//
// Everything is drawn at a TINY internal resolution (see ART_W/ART_H) and then blown up
// by CSS with `image-rendering: pixelated`, so every source pixel becomes a fat square.
// That's the whole trick: never draw smooth shapes and shrink them — draw big pixels.
//
// Keep the palette in the same family as the game (block stadium greens + team colours).

export const ART_W = 60; // internal pixels across
export const ART_H = 46; // internal pixels down

const SKY_HI = '#2b4a63';
const SKY_LO = '#1b2f40';
const GRASS_A = '#4f8f3f';
const GRASS_B = '#437c36';
const GRASS_C = '#39692e';
const LINE = '#cfe3c4';
const BLUE = '#2e70df';
const BLUE_D = '#1d4a99';
const RED = '#e84b3c';
const RED_D = '#a32f24';
const SKIN = '#f0c9a0';
const WHITE = '#f4f4ef';
const DARK = '#101a12';
const GOLD = '#ffcb43';
const GOLD_D = '#a56a16';
const NET = '#b9c6bd';

function px(g, x, y, w, h, c) { g.fillStyle = c; g.fillRect(x | 0, y | 0, w | 0, h | 0); }

// Sky + a banded pitch. Bands (not a gradient) keep it readably blocky.
function pitch(g, horizon) {
  px(g, 0, 0, ART_W, horizon, SKY_LO);
  px(g, 0, 0, ART_W, (horizon / 2) | 0, SKY_HI);
  const bands = [GRASS_C, GRASS_B, GRASS_A, GRASS_B, GRASS_A];
  const h = Math.ceil((ART_H - horizon) / bands.length);
  for (let i = 0; i < bands.length; i++) px(g, 0, horizon + i * h, ART_W, h, bands[i]);
}

// A blocky little footballer: 5 wide, 9 tall. `dir` -1 faces left, 1 faces right.
function guy(g, x, y, body, shade, dir = 1) {
  px(g, x + 1, y, 3, 3, SKIN);          // head
  px(g, x + 1 + (dir > 0 ? 2 : 0), y + 1, 1, 1, DARK); // eye
  px(g, x, y + 3, 5, 4, body);          // torso
  px(g, x, y + 5, 5, 2, shade);         // torso shading
  px(g, x, y + 7, 2, 2, DARK);          // legs
  px(g, x + 3, y + 7, 2, 2, DARK);
}

function ball(g, x, y) {
  px(g, x, y, 4, 4, WHITE);
  px(g, x + 1, y + 1, 1, 1, DARK);
  px(g, x + 2, y + 2, 1, 1, DARK);
}

// Goal seen head-on: posts + a net lattice.
function goal(g, x, y, w, h) {
  for (let i = 2; i < w - 2; i += 3) px(g, x + i, y + 2, 1, h - 3, NET);
  for (let j = 2; j < h - 1; j += 3) px(g, x + 2, y + j, w - 4, 1, NET);
  px(g, x, y, 2, h, WHITE);             // left post
  px(g, x + w - 2, y, 2, h, WHITE);     // right post
  px(g, x, y, w, 2, WHITE);             // crossbar
}

const SCENES = {
  // כייף: confetti sky, your CROWNED super-partner leading the charge, two hapless reds.
  fun(g) {
    pitch(g, 16);
    for (const [cx, cy, c] of [[6, 4, GOLD], [16, 9, RED], [26, 3, WHITE], [38, 7, GOLD], [48, 4, BLUE], [55, 10, RED]]) px(g, cx, cy, 2, 2, c);
    px(g, ART_W / 2 - 1, 16, 2, ART_H - 16, LINE);
    guy(g, 12, 30, BLUE, BLUE_D, 1);          // you
    guy(g, 20, 20, BLUE, BLUE_D, 1);          // the רמה-12 partner…
    px(g, 20, 18, 5, 2, GOLD);                // …crowned
    px(g, 21, 17, 1, 1, GOLD); px(g, 23, 17, 1, 1, GOLD);
    guy(g, 42, 22, RED, RED_D, -1);
    guy(g, 46, 33, RED, RED_D, -1);
    px(g, 47, 31, 3, 1, DARK);                // a "?" of confusion over the far red
    px(g, 49, 29, 1, 2, DARK); px(g, 48, 28, 2, 1, DARK);
    ball(g, 30, 26);
  },
  // Classic 2v2: two blues, two reds, ball in the middle of a striped pitch.
  '2v2'(g) {
    pitch(g, 16);
    // Halfway line only. A centre circle at this resolution just reads as scattered
    // pixels once the players overlap it.
    px(g, ART_W / 2 - 1, 16, 2, ART_H - 16, LINE);
    guy(g, 10, 20, BLUE, BLUE_D, 1);
    guy(g, 16, 31, BLUE, BLUE_D, 1);
    guy(g, 40, 20, RED, RED_D, -1);
    guy(g, 34, 31, RED, RED_D, -1);
    ball(g, 28, 33);
  },
  // 1v1 duel: one blue, one red, staring each other down over the ball at the centre spot.
  '1v1'(g) {
    pitch(g, 16);
    px(g, ART_W / 2 - 1, 16, 2, ART_H - 16, LINE);
    px(g, 2, 20, 6, 16, LINE); px(g, 3, 21, 4, 14, GRASS_A);            // left box
    px(g, ART_W - 8, 20, 6, 16, LINE); px(g, ART_W - 7, 21, 4, 14, GRASS_A); // right box
    guy(g, 17, 24, BLUE, BLUE_D, 1);
    guy(g, 38, 24, RED, RED_D, -1);
    ball(g, 28, 31);
    px(g, 25, 33, 2, 1, WHITE);          // dust — the standoff is already moving
    px(g, 34, 33, 2, 1, WHITE);
  },
  // Goal brawl: the goal fills the frame, a striker winding up, ball mid-flight.
  brawl(g) {
    pitch(g, 14);
    goal(g, 14, 10, 32, 18);
    px(g, 6, 30, ART_W - 12, 1, LINE);            // penalty arc, flattened
    guy(g, 27, 30, BLUE, BLUE_D, 1);
    ball(g, 38, 22);
    px(g, 34, 25, 2, 1, WHITE);                   // motion streak
    px(g, 31, 27, 2, 1, WHITE);
  },
  // 3v3 on the long pitch: six figures, deeper perspective, wider markings.
  '3v3'(g) {
    pitch(g, 13);
    px(g, 0, 24, ART_W, 1, LINE);
    px(g, ART_W / 2 - 1, 13, 2, ART_H - 13, LINE);
    px(g, 2, 17, 8, 12, LINE); px(g, 3, 18, 6, 10, GRASS_A);      // left box
    px(g, ART_W - 10, 17, 8, 12, LINE); px(g, ART_W - 9, 18, 6, 10, GRASS_A);
    guy(g, 12, 16, BLUE, BLUE_D, 1);
    guy(g, 15, 27, BLUE, BLUE_D, 1);
    guy(g, 22, 36, BLUE, BLUE_D, 1);
    guy(g, 42, 16, RED, RED_D, -1);
    guy(g, 39, 27, RED, RED_D, -1);
    guy(g, 32, 36, RED, RED_D, -1);
    ball(g, 28, 30);
  },
  // Tournament: a chunky gold cup on a podium, confetti overhead.
  cup(g) {
    px(g, 0, 0, ART_W, ART_H, SKY_LO);
    px(g, 0, 0, ART_W, 20, SKY_HI);
    for (const [cx, cy, c] of [[8, 6, RED], [18, 3, GOLD], [46, 5, BLUE], [52, 12, WHITE], [12, 14, GOLD], [40, 2, RED]]) px(g, cx, cy, 2, 2, c);
    px(g, 22, 10, 16, 12, GOLD);        // cup bowl
    px(g, 22, 18, 16, 4, GOLD_D);       // bowl shadow
    px(g, 18, 11, 4, 6, GOLD); px(g, 19, 12, 2, 4, SKY_LO);  // left handle
    px(g, 38, 11, 4, 6, GOLD); px(g, 39, 12, 2, 4, SKY_LO);  // right handle
    px(g, 27, 22, 6, 4, GOLD_D);        // stem
    px(g, 23, 26, 14, 3, GOLD);         // base
    px(g, 14, 33, 32, 4, '#6b7a6d');    // podium top
    px(g, 14, 37, 32, 9, '#4a5750');
    px(g, 24, 39, 12, 5, '#38423c');    // podium face plate
  },
};

// Paint a mode's scene into a canvas. Falls back to the plain pitch for unknown ids,
// so a new MODES row renders something sane before it gets bespoke art.
export function drawModeArt(canvas, id) {
  if (!canvas) return;
  canvas.width = ART_W;
  canvas.height = ART_H;
  const g = canvas.getContext('2d');
  if (!g) return;
  g.imageSmoothingEnabled = false;
  (SCENES[id] || ((c) => { pitch(c, 16); ball(c, 28, 30); }))(g);
}
