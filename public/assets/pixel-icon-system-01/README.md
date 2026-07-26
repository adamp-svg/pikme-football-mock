# Saltiz Pixel Icon System 01

The selected chunky 16-bit language expanded into a 96-icon replacement
library for the football game.

## Deliverables

- `giant-atlas-96.png` — full-resolution 2-by-3 master atlas.
- `giant-atlas-96-preview.png` — half-size review copy.
- `labeled-catalog-96.png` — alphabetical visual catalog with stable IDs.
- `sheets/` — six category sheets with 16 icons each.
- `tiles/` — named 256px icons on the canonical dark background.
- `transparent/` — named 256px transparent PNG exports for integration.
- `manifest.csv` — stable asset IDs, categories, and current UI meanings.
- `GRAPHIC_LANGUAGE.md` — canonical rules for drawing new matching assets.
- `ASSET_USAGE.md` — when and where to use every individual asset.
- `sprite-pack.webp` — production 12-by-8 pack downloaded once by the phone.

The six categories are:

1. Lobby and navigation
2. Gameplay and HUD
3. Field builder
4. Builder and social actions
5. Economy and ranks
6. Reactions and system states

Use the files in `transparent/` for UI prototypes. Keep the filename as the
stable semantic ID even if the artwork is revised later.

The live game uses `sprite-pack.webp` through `/icon-system.css` and
`/icon-system.js`. The compatibility runtime also converts icons inserted later
by `client.js`, so dynamic friends, bots, ranks, quick messages, and builder
labels remain in the same visual language.
