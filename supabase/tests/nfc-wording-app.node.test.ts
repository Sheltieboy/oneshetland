/**
 * nfc-wording-app.node.test.ts — the app's business dashboard says NFC tiles are coming soon, promises no timescale, and still calls the same request mechanism.
 * Source-level: no network, no database.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'app', 'local-business-dashboard.tsx'), 'utf8');

test('no promise that a tile is included, or will be posted within a time', () => {
  assert.doesNotMatch(src, /included with your subscription/); assert.doesNotMatch(src, /within 3 working days/); assert.doesNotMatch(src, /We\\'ll print your branded NFC tile/); assert.doesNotMatch(src, /Request my NFC tile/);
});
test('the section and the plan row say coming soon, and the button joins a waiting list', () => {
  assert.match(src, /NFC tile · coming soon/); assert.match(src, /label: 'NFC tap-to-stamp tile \(coming soon\)', req: 'pro'/); assert.match(src, /Join the tile waiting list/);
  assert.match(src, /Tap-to-stamp tiles are coming soon\. Join the waiting list — nothing is posted yet\./); assert.match(src, /no delivery date yet/);
});
test('the mechanism and the plan requirement are unchanged', () => {
  assert.match(src, /await requestNfcTile\(activeBusiness\.id\)/); assert.match(src, /activeBusiness\.nfc_status === 'none'/); assert.match(src, /track\('nfc_tile_requested'/); assert.match(src, /NFC_TILE_URL_PREFIX\}\{activeBusiness\.nfc_token\}/);
  assert.match(src, /\{ label: 'In-app bookings',\s+req: 'pro'/);
});
