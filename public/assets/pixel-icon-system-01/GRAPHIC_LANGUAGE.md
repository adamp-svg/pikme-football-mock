# Saltiz Chunky Pixel — Graphic Language 01

This is the canonical visual language selected from concept 01. New icons
should look as if they came from the same small association-football world,
not from an emoji set or a generic operating-system library.

## Core construction

- Author on a **24 by 24 logical-pixel grid**.
- Export at 1x, 2x, 4x, or larger using **nearest-neighbor only**.
- Use hard horizontal, vertical, and stepped diagonal edges. No antialiasing.
- Give the main silhouette a **2-logical-pixel charcoal outline**.
- Add a restrained **2-pixel lower-right extrusion/shadow**.
- Light all objects from the upper left.
- Build each complex icon from one primary object and at most one supporting
  prop. Examples: boot + ball, wall + trowel, jersey + swatches.
- Preserve at least two logical pixels of breathing room around the silhouette.

## Palette

| Role | Hex | Use |
| --- | --- | --- |
| Turf green | `#2f7d45` | Positive actions, pitch, active play |
| Warm gold | `#ffcb43` | Primary actions, rewards, highlights |
| Cream | `#fff0c2` | Key light, ball panels, readable accents |
| Team red | `#e84b3c` | Danger, opponent, destructive action |
| Team blue | `#2e70df` | Player, neutral action, tools |
| Charcoal | `#101512` | Outline, shadow, dark surfaces |

Each object normally gets three material tones: shadow, base, and light, plus
one cream specular highlight. Do not introduce a new hue when a value shift of
an existing palette color will work.

## Shape grammar

- Silhouettes must remain recognizable at **24px** before interior detail is
  considered.
- Corners are squared or stair-stepped. Avoid smooth vector curves.
- Circles use deliberate pixel stepping, not blurred round edges.
- Directional actions should lean or point clearly: play/right, back/left,
  redo/clockwise, undo/counterclockwise.
- Positive actions use green or gold. Destructive actions use red. Neutral
  tools use blue, steel, or cream.
- Repeated families share geometry. Rank badges use one hexagonal plate;
  only metal, emblem, pip count, and studs escalate.
- State pairs keep the same base silhouette: sound on/off, accept/decline,
  pause/resume, square/round joint.

## Association-football rule

“Football” always means **association football / soccer**:

- Balls are round with black-and-cream pentagon panels.
- Players wear jerseys, shorts, socks, and football boots.
- Never draw an oval brown ball, helmet, shoulder pads, or American-football
  goalposts.

## Detail hierarchy

1. Primary silhouette
2. Semantic prop or action mark
3. Material shading
4. One tiny football-world detail
5. Highlight and extrusion

If an icon is unclear at 24px, remove detail before increasing complexity.

## UI sizing

- `18–22px`: chips and compact HUD indicators; use the silhouette only.
- `24–32px`: standard buttons; full icon is visible.
- `40–64px`: lobby satellites, shop items, and builder tools.
- `96px+`: promotional presentation only; do not add details that disappear
  at the standard 24px test.

CSS should use `image-rendering: pixelated`. Do not use browser blur,
drop-shadow blur, or non-integer scaling on final production assets.

## Runtime integration

- Production UI uses the single `sprite-pack.webp` atlas.
- Use `<span class="saltiz-icon si-ASSET_ID" aria-hidden="true"></span>` in
  new static markup.
- In JavaScript, prefer `SaltizIcons.icon('ASSET_ID')`.
- The mutation compatibility layer converts legacy emoji inserted through
  `textContent`, but it is not the preferred API for new code.
- Keep adjacent visible text or an `aria-label`; sprite icons are decorative
  and marked `aria-hidden`.
- Bump the `?v=` cache key in `icon-system.css` whenever the sprite pixels or
  grid order changes, ensuring installed phone WebViews fetch the new pack.

## New-asset checklist

Before accepting a new icon:

1. Does it read correctly at 24px?
2. Does it use the shared palette and upper-left light?
3. Is the outline two logical pixels?
4. Is the supporting prop necessary?
5. Does it avoid emoji and vector-library styling?
6. If it contains a ball or player, is it unmistakably association football?
7. Does it preserve the geometry of any existing family?
8. Was it exported with nearest-neighbor scaling and transparent background?

## Reusable generation brief

> Premium chunky 16-bit association-football icon, authored on a 24x24
> logical-pixel grid, hard nearest-neighbor edges, no antialiasing, three-tone
> object plus cream highlight, two-pixel charcoal outline, two-pixel
> lower-right extrusion, upper-left lighting, Saltiz turf-green/warm-gold/
> cream/team-red/team-blue palette, one primary silhouette plus one supporting
> prop, instantly readable at 24px, transparent background, never emoji,
> never gradients or blur, never American football.
