# New Saltiz icon record

Copy this section into the relevant design handoff before producing a new
asset. Delete the instructional text in parentheses.

```md
## <semantic-id>

- ID: `<lowercase-kebab-case>`
- Collection: `<new numbered expansion>`
- Category: `<existing category or justified new category>`
- Status: `future` (change to `live` only after runtime integration)
- Purpose: `<one sentence; one semantic meaning>`
- Used on: `<screens, buttons, messages, or planned feature>`
- Must not mean: `<nearest confusing asset and how this differs>`
- Primary silhouette: `<one object>`
- Supporting prop: `<zero or one object>`
- Semantic color: `<green/gold/red/blue/cream and why>`
- State/family relationship: `<paired icon or none>`
- Association-football check: `<round soccer ball/kit/goal, or not applicable>`
- 24px readability check: `<pass and what remains recognizable>`
- Transparent export: `<relative path>`
- Presentation tile: `<relative path>`
- Review sheet: `<relative path and cell>`
- Runtime mapping: `<CSS class and atlas cell, or not integrated>`
- Accessibility label: `<visible text or aria-label supplied by UI>`
```

## Required art brief

Start with the reusable brief in `GRAPHIC_LANGUAGE.md`, then append only:

> Subject: [primary silhouette] with [optional supporting prop]. Meaning:
> [purpose]. Dominant semantic color: [palette role]. Preserve the established
> geometry of [family], if applicable.

Do not replace the shared brief with a new style description. This library is
one graphic language, not a collection of unrelated visual treatments.

## Export contract

- Logical master: 24×24 pixels.
- Integration export: 256×256 RGBA PNG with a transparent background.
- Review tile: 256×256 PNG on the canonical dark presentation background.
- Scaling: nearest-neighbor only.
- Filename: exact semantic ID.
- No text baked into the art unless the meaning cannot exist without it.
- No animation inside the base PNG. Optional sparkle/shine animation is a
  separate derivative using the same stable ID plus a documented suffix.

## Registration commands

After adding the CSV row and files:

```sh
node scripts/validate-icon-assets.mjs --write
node scripts/validate-icon-assets.mjs
node test-icon-system.mjs
```

If validation reports a stale registry, regenerate it; do not hand-edit
`ASSET_REGISTRY.json`.
