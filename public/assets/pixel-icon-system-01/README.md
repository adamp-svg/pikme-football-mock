# Saltiz Pixel Icon System 01

The selected chunky 16-bit language expanded into a 96-icon replacement
library for the football game, plus a clearly marked 64-asset future and
player-communication expansion.

> **Agents: start with [`ASSET_HANDOFF.md`](ASSET_HANDOFF.md).** It explains
> the live/future boundary, stable naming, runtime integration, validation,
> and how to extend the system. Use `ASSET_REGISTRY.json` as the complete
> machine-readable inventory and `labeled-catalog-160.png` as the visual index.

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
- `ASSET_REGISTRY.json` — generated registry of all 160 assets and their
  live/future status.
- `labeled-catalog-160.png` — combined visual index with every stable ID.
- `ASSET_HANDOFF.md` — authoritative pickup instructions for another agent.
- `NEW_ASSET_TEMPLATE.md` — required record for future additions.
- `expansion-64/` — 64 matching future icons, emotes, and tactical calls.

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

The expansion artwork is deliberately marked `future` in the registry until
each asset is added to the runtime atlas and CSS. Validate the complete library
with `node scripts/validate-icon-assets.mjs`.

Production sprite revision `v3` rebuilds `play`, `bomb`, and `build-wall` from
closed-outline alpha masters. Their semantic IDs and atlas coordinates remain
stable.
