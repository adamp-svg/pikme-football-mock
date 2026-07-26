#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetRoot = path.join(repoRoot, 'public/assets/pixel-icon-system-01');
const registryPath = path.join(assetRoot, 'ASSET_REGISTRY.json');

const collections = [
  {
    id: 'core-96',
    manifest: 'manifest.csv',
    status: 'live',
    tileDir: 'tiles',
    transparentDir: 'transparent',
    sheets: [
      'sheets/01-lobby-navigation.png',
      'sheets/02-gameplay-hud.png',
      'sheets/03-field-builder.png',
      'sheets/04-builder-social-actions.png',
      'sheets/05-economy-ranks.png',
      'sheets/06-reactions-system.png',
    ],
  },
  {
    id: 'expansion-64',
    manifest: 'expansion-64/manifest.csv',
    status: 'future',
    tileDir: 'expansion-64/tiles',
    transparentDir: 'expansion-64/transparent',
    sheets: [
      'expansion-64/sheets/07-future-gameplay.png',
      'expansion-64/sheets/08-future-progression.png',
      'expansion-64/sheets/09-social-emotes.png',
      'expansion-64/sheets/10-tactical-calls.png',
    ],
  },
];

function parseManifest(relativePath) {
  const text = fs.readFileSync(path.join(assetRoot, relativePath), 'utf8').trim();
  const [header, ...lines] = text.split(/\r?\n/);
  if (!/^id,category,/.test(header)) {
    throw new Error(`${relativePath}: expected id,category,... header`);
  }
  return lines.map((line, index) => {
    const first = line.indexOf(',');
    const second = line.indexOf(',', first + 1);
    if (first < 1 || second < first + 2) {
      throw new Error(`${relativePath}:${index + 2}: invalid CSV row`);
    }
    return {
      id: line.slice(0, first),
      category: line.slice(first + 1, second),
      purpose: line.slice(second + 1),
    };
  });
}

function buildRegistry() {
  const assets = [];
  for (const collection of collections) {
    const rows = parseManifest(collection.manifest);
    rows.forEach((row, localIndex) => {
      const globalIndex = assets.length;
      assets.push({
        ordinal: globalIndex + 1,
        id: row.id,
        category: row.category,
        purpose: row.purpose,
        collection: collection.id,
        status: collection.status,
        files: {
          transparent: `${collection.transparentDir}/${row.id}.png`,
          presentationTile: `${collection.tileDir}/${row.id}.png`,
          reviewSheet: collection.sheets[Math.floor(localIndex / 16)],
        },
        combinedAtlas160: {
          file: 'expansion-64/sprite-pack-160.webp',
          cellPx: 128,
          column: globalIndex % 16,
          row: Math.floor(globalIndex / 16),
        },
        runtime:
          collection.status === 'live'
            ? {
                cssClass: `saltiz-icon si-${row.id}`,
                javascript: `SaltizIcons.icon('${row.id}')`,
              }
            : null,
      });
    });
  }

  return {
    schemaVersion: 1,
    packId: 'saltiz-pixel-icon-system-01',
    graphicLanguage: 'GRAPHIC_LANGUAGE.md',
    agentHandoff: 'ASSET_HANDOFF.md',
    totalAssets: assets.length,
    statusMeaning: {
      live: 'Mapped in the current 96-icon game runtime.',
      future: 'Approved matching artwork; not mapped into the live runtime yet.',
    },
    collections: [
      { id: 'core-96', count: 96, status: 'live' },
      { id: 'expansion-64', count: 64, status: 'future' },
    ],
    assets,
  };
}

function inspectPng(relativePath, requireAlpha) {
  const fullPath = path.join(assetRoot, relativePath);
  const data = fs.readFileSync(fullPath);
  const pngSignature = '89504e470d0a1a0a';
  if (data.subarray(0, 8).toString('hex') !== pngSignature) {
    throw new Error(`${relativePath}: not a PNG`);
  }
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  const colorType = data[25];
  if (width !== 256 || height !== 256) {
    throw new Error(`${relativePath}: expected 256x256, got ${width}x${height}`);
  }
  if (requireAlpha && colorType !== 4 && colorType !== 6) {
    throw new Error(`${relativePath}: expected an alpha channel`);
  }
}

function validate(registry) {
  const expected = buildRegistry();
  const errors = [];
  const fail = (message) => errors.push(message);

  if (JSON.stringify(registry) !== JSON.stringify(expected)) {
    fail('ASSET_REGISTRY.json is stale; run this script with --write');
  }
  if (expected.totalAssets !== 160) fail(`expected 160 assets, got ${expected.totalAssets}`);

  const ids = new Set();
  for (const asset of expected.assets) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(asset.id)) {
      fail(`${asset.id}: ID must be lowercase kebab-case`);
    }
    if (ids.has(asset.id)) fail(`${asset.id}: duplicate semantic ID`);
    ids.add(asset.id);
    if (!asset.purpose.trim()) fail(`${asset.id}: missing purpose`);

    try {
      inspectPng(asset.files.transparent, true);
    } catch (error) {
      fail(error.message);
    }
    try {
      inspectPng(asset.files.presentationTile, false);
    } catch (error) {
      fail(error.message);
    }
    if (!fs.existsSync(path.join(assetRoot, asset.files.reviewSheet))) {
      fail(`${asset.id}: missing review sheet ${asset.files.reviewSheet}`);
    }
  }

  const requiredPackFiles = [
    'GRAPHIC_LANGUAGE.md',
    'ASSET_HANDOFF.md',
    'NEW_ASSET_TEMPLATE.md',
    'labeled-catalog-160.png',
    'sprite-pack.webp',
    'expansion-64/sprite-pack-160.webp',
  ];
  for (const relativePath of requiredPackFiles) {
    if (!fs.existsSync(path.join(assetRoot, relativePath))) {
      fail(`missing required pack file: ${relativePath}`);
    }
  }

  const css = fs.readFileSync(path.join(repoRoot, 'public/icon-system.css'), 'utf8');
  for (const asset of expected.assets.filter((item) => item.status === 'live')) {
    if (!css.includes(`.si-${asset.id}`)) fail(`${asset.id}: missing live CSS mapping`);
  }

  if (errors.length) {
    console.error(`Icon asset validation failed (${errors.length}):`);
    errors.forEach((error) => console.error(`- ${error}`));
    process.exit(1);
  }
  console.log(
    `Icon assets valid: ${expected.totalAssets} unique IDs ` +
      `(${expected.collections[0].count} live, ${expected.collections[1].count} future).`,
  );
}

const expected = buildRegistry();
if (process.argv.includes('--write')) {
  fs.writeFileSync(registryPath, `${JSON.stringify(expected, null, 2)}\n`);
  console.log(`Wrote ${path.relative(repoRoot, registryPath)}`);
}

if (!fs.existsSync(registryPath)) {
  console.error('ASSET_REGISTRY.json is missing; run this script with --write');
  process.exit(1);
}
validate(JSON.parse(fs.readFileSync(registryPath, 'utf8')));
