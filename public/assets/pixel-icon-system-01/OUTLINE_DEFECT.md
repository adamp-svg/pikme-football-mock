# Outline defect — spec for the regenerated pack

**For:** whoever rebuilds this pack (codex, in progress 2026-07-26).
**Reported by the user as:** *"the bomb and wall build icons are still broken, it looks like some black
parts are transparent."*

## What is actually wrong

The silhouette outlines are **open**. The edge is a scatter of isolated dark pixels rather than a
continuous line, so whatever is behind the icon shows through the gaps. On the two ability buttons
(`#special` 56px, `#build` 40px) the orange/brown button colour leaks through the bomb's ring and the
brick outlines, and it reads as holes in the black.

This is in the **source art**, not the packing and not the runtime:

- `transparent/bomb.png` at its native 256px already has it. Mapping its alpha shows a solid body
  surrounded by loose single pixels.
- The packed 128px cell reproduces the source faithfully.
- Compositing the 256px source over the real button colours (`#d69122`, `#b06a34`) reproduces exactly
  what the user photographed.

It is worse at high DPR. `image-rendering: pixelated` + a phone at DPR 3 upscales a 56px box to ~168
device px, magnifying every near-invisible edge pixel into a visible hole. At lobby icon sizes the
downscale averages it away, which is why it went unnoticed.

## The measurement

An outline pixel that belongs to a real line has **at least 2 dark neighbours** along that line. Count
the dark pixels with ≤2 dark neighbours and divide by all dark pixels — call it *openness*.

Measured on the shipped pack (`sprite-pack.png`, 12×8 grid of 128px cells):

| icon | isolated / total dark px | openness |
|---|---|---|
| `build-wall` | 205 / 1019 | **20.1%** |
| `cards` | 212 / 3313 | 6.4% |
| `play` | 63 / 971 | 6.5% |
| `bomb` | 143 / 2611 | 5.5% |

Two things to take from that:

1. **`build-wall` is a 3× outlier** and is the worst icon in the set.
2. **~6% is the pack's baseline**, so this is a pack-wide trait, not two bad icons. `bomb` only looked
   worst because it is rendered largest. Any icon promoted to a large surface later will show the same
   defect.

## Acceptance criteria

- **Openness ≤ 3%** for every icon, measured as above. Near-zero is the real target; 3% is where the
  runtime guard trips.
- A 1px-minimum **closed** outline around each silhouette — no single-pixel gaps.
- Keep the existing grid, cell size, IDs and `manifest.csv` order. `icon-system.css` maps IDs to grid
  positions by index; reordering silently repoints every icon.
- Export `sprite-pack.webp` **lossless**. It was lossy, which blurs pixel art. Budget is 1.5 MB and
  `test-icon-system.mjs` enforces it.
- Do **not** draw guide lines into the sheet. The previous build had translucent grid lines at cell
  boundaries which bled into the bomb and wall cells as stray dark rules.

## Two things to do at integration, or the fix will look wrong

1. **Bump the cache-buster.** `sprite-pack.webp` is served `max-age=31536000, immutable`, so a phone
   that already loaded the pack will keep the old art no matter what the file contains. Only the
   `?v=N` query frees it — there are 4 references in `public/icon-system.css`. (`icon-system.css`
   itself is `no-store`, so the CSS change is picked up immediately.)
2. **Delete the mitigation.** `public/icon-system.css` has a block marked `SYNTHESIZED OUTLINE` — four
   1px drop-shadows that close the ring in CSS for these two icons only. Once the art is fixed it must
   go, or outlines double up and look muddy.

`test-icon-outline-guard.mjs` enforces both halves of that handover: it fails if the mitigation is
removed while the art is still open, **and** fails if the art is fixed while the mitigation is still
there. Run it after dropping in the new pack — it will tell you exactly which state you are in.
