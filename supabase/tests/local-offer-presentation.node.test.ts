/**
 * local-offer-presentation.node.test.ts — /local with nothing to offer (Local V2).
 *
 * The earlier Local page HID the Offers pillar (and its #offers anchor) when there were no live offers, so a launch
 * visitor saw a page that said nothing about offers at all. Local V2 reverses that deliberately: every pillar is
 * permanent, and low inventory changes how it is TREATED (an "Opening soon" chip, a proposition panel), never whether
 * it exists. What must still hold is that nothing links to an anchor the page is not rendering, and that the first
 * published offer simply fills the section that was already there.
 *
 * Needs the sibling ../oneshetland-web checkout.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModule } from './_support/load-source.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_ROOT  = join(REPO_ROOT, '..', 'oneshetland-web');
const have = existsSync(join(WEB_ROOT, 'lib/preview-v2.ts'));
const opts = { skip: have ? false : 'sibling oneshetland-web checkout not found' };
const web = (p: string) => readFileSync(join(WEB_ROOT, p), 'utf8');
const code = (p: string) => web(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('Offers on Local V2 — present at every inventory level', opts, () => {
  test('the Offers pillar tile is built for any count, with an "Opening soon" chip when there are none', () => {
    const l = code('components/preview/v2/LocalV2.tsx');
    assert.match(l, /key: "offers"/);
    assert.match(l, /href: "#offers"/);
    assert.match(l, /Opening soon/);
  });
  test('the #offers section the tile points at is rendered unconditionally by PillarBand, so the anchor is never dead', () => {
    const page = code('app/local/page.tsx');
    assert.match(page, /<PillarBand pillar="offers" items=\{commerce\.offers\} \/>/);
    assert.match(code('components/preview/v2/Merch.tsx'), /<section id=\{id\}/);
  });
  test('zero offers → the proposition panel; the first offer fills the same section (one rule, no flag)', () => {
    const m = loadModule('../oneshetland-web/lib/preview-v2.ts');
    assert.equal(m.density(0), 'none');
    assert.equal(m.density(1), 'few');
    assert.ok(!/OFFERS_ENABLED|NEXT_PUBLIC_.*OFFER|featureFlag/i.test(web('app/local/page.tsx')));
  });
  test('live offers map to cards linking to the business that runs them', () => {
    const m = loadModule('../oneshetland-web/lib/preview-v2.ts');
    const out = m.mapLiveCommerce({ products: [], passes: [], services: [], offers: [{ id: 'o1', title: '10% off', valid_until: '2026-12-01T00:00:00Z', business: { id: 'b1', name: 'Café' } }] });
    assert.equal(out.offers.length, 1);
    assert.equal(out.offers[0].href, '/directory/b1');
  });
});

describe('nothing else was touched', opts, () => {
  test('/loyalty keeps its own honest empty state', () => {
    assert.match(web('app/loyalty/page.tsx'), /coming soon/i);
  });
  test('business-facing Offers routes still exist', () => {
    for (const p of ['app/business/[id]/manage/offers/page.tsx', 'app/local/page.tsx']) assert.ok(existsSync(join(WEB_ROOT, p)), `${p} must remain`);
  });
  test('Shifts is untouched by this change', () => {
    for (const p of ['app/shifts/new/page.tsx', 'app/shifts/manage/page.tsx', 'app/jobs/page.tsx']) assert.ok(existsSync(join(WEB_ROOT, p)), `${p} must remain`);
  });
});
