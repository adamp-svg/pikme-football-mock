# Asset handoff — start here

This directory is the canonical Saltiz football icon library. It contains
**160 unique semantic assets in one visual language**:

- `core-96`: 96 assets currently mapped into the live game.
- `expansion-64`: 64 approved future, social-emote, and tactical-call assets.
  Their art exists, but they are not in the live runtime yet.

Do not infer runtime status from the existence of a PNG. Read
`ASSET_REGISTRY.json` and check the asset's `status`.

## Source-of-truth files

| File | Authority |
| --- | --- |
| `ASSET_REGISTRY.json` | Machine-readable list of all 160 IDs, purposes, status, paths, sheet, and atlas cell. |
| `labeled-catalog-160.png` | Human-readable visual index of every asset and its exact ID. |
| `GRAPHIC_LANGUAGE.md` | Binding visual rules and reusable generation brief. |
| `ASSET_USAGE.md` | Detailed use rules for the live `core-96`. |
| `expansion-64/EXPANSION_USAGE.md` | Detailed use rules for the future 64. |
| `expansion-64/COMMUNICATION_SET.md` | Emote/tactical-wheel behavior and safety rules. |
| `NEW_ASSET_TEMPLATE.md` | Checklist and record template for extending the pack. |
| `manifest.csv` | Human-editable source rows for the original 96. |
| `expansion-64/manifest.csv` | Human-editable source rows for the expansion 64. |

The CSV manifests are the editable inventory sources. The JSON registry is
generated from them and must never be hand-edited.

## File meaning

For each semantic ID:

- `transparent/<id>.png` or `expansion-64/transparent/<id>.png` is the
  integration-ready 256×256 alpha image.
- `tiles/<id>.png` or `expansion-64/tiles/<id>.png` is the 256×256 dark
  presentation tile for review.
- `sheets/` contains the original 4×4 review sheets.
- `sprite-pack.webp` is the current phone-downloaded 96-icon runtime pack.
- `expansion-64/sprite-pack-160.webp` is the combined 160-icon candidate pack.
  It does not become production merely by existing.
- `giant-atlas-96.png`, `expansion-64/giant-atlas-160.png`, and labeled
  catalogs are review artifacts, not runtime downloads.

The filename is a stable API. Revise pixels without renaming an established
semantic ID. Create a new ID when the meaning changes.

## Current production art revision

Sprite pack cache revision `v3` rebuilds three previously fragile assets:

| ID | Reason |
| --- | --- |
| `play` | Larger closed silhouette that remains readable in the 30px Quick Play slot. |
| `bomb` | Continuous outline with no transparent perimeter gaps at the 56px controller size. |
| `build-wall` | Continuous brick/trowel outlines at the 40px controller size. |

Their stable IDs and atlas coordinates did not change. The generated registry
marks them `artRevision: v3-closed-outline`. Do not restore the old CSS
drop-shadow mitigation; the repaired alpha masters are now authoritative.

## Adding an existing future asset to the game

1. Find the ID in `ASSET_REGISTRY.json`; confirm `status` is `future`.
2. Read its purpose and the applicable per-asset usage document.
3. Add it to the production atlas and map `.si-<id>` in
   `public/icon-system.css`.
4. Use `<span class="saltiz-icon si-<id>" aria-hidden="true"></span>` or
   `SaltizIcons.icon('<id>')`; keep visible text or an `aria-label`.
5. Change the manifest collection/status only after the runtime mapping is
   actually present.
6. Regenerate the registry and bump the sprite cache version.
7. Run the asset validator, icon-system tests, and real-size phone QA.

Never silently replace a live icon's meaning, load 160 individual PNGs at
runtime, or mark future art live before its CSS atlas mapping exists.

## Creating a brand-new asset

1. Read all of `GRAPHIC_LANGUAGE.md`.
2. Search `ASSET_REGISTRY.json` to avoid a duplicate meaning.
3. Choose a lowercase kebab-case semantic ID, not a screen-specific name.
4. Complete `NEW_ASSET_TEMPLATE.md`.
5. Produce both a named presentation tile and transparent 256×256 PNG.
6. Add one CSV row and place the asset in a 16-item numbered review sheet.
7. Update the appropriate per-asset usage document.
8. Regenerate and validate:

   ```sh
   node scripts/validate-icon-assets.mjs --write
   node scripts/validate-icon-assets.mjs
   node test-icon-system.mjs
   ```

9. Update the labeled catalog so humans can find the new ID visually.
10. Commit the artwork, manifest, registry, documentation, and tests together.

If the pack grows beyond 160, create a new numbered expansion instead of
placing loose images at the root.

## Naming rules

- Use nouns for destinations/objects: `profile`, `reward-chest`.
- Use verbs for commands/actions: `claim`, `upgrade`.
- Prefix conversational faces with `emote-`.
- Prefix tactical communication with `call-`.
- Prefix ranked tiers with `rank-`.
- Use one meaning per ID. Similar art with different behavior needs distinct
  semantic IDs.
- Avoid UI-position names such as `top-left-button` and temporary names such
  as `new-icon-2`.

## Handoff definition of done

An asset addition is complete only when:

- the semantic ID, category, purpose, collection, and status are documented;
- tile, transparent export, and review-sheet location all resolve;
- the 24px silhouette test and association-football rules pass;
- the generated registry and labeled visual catalog are current;
- `node scripts/validate-icon-assets.mjs` passes;
- live assets have CSS/JavaScript runtime mappings and phone-size QA;
- future assets remain explicitly marked `future`.
