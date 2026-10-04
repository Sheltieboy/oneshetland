/**
 * local-page-layout.node.test.ts — the Local landing page fits a phone.
 *
 * Production audit (3 Oct 2026): at 375 px and at 390 px the page scrolled to 846 px. Two of its card grids
 * (Featured businesses, and Jobs & shifts) had no base grid column, so on a phone the implicit auto track grew
 * to the longest nowrap line — 495 px in one, 826 px in the other — and every card went with it. Same bug as the
 * Events and Jobs lists. A base `grid-cols-1` is minmax(0,1fr), which can shrink.
 *
 * Source-level and read-only. Needs the sibling ../oneshetland-web checkout.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'oneshetland-web');
const have = existsSync(join(WEB, 'components/preview/v2/LocalV2.tsx'));
const opts = { skip: have ? false : 'sibling oneshetland-web checkout not found' };
const src = () => ['components/preview/v2/LocalV2.tsx', 'components/preview/v2/Merch.tsx', 'components/preview/v2/WorkV2.tsx'].map((f) => readFileSync(join(WEB, f), 'utf8')).join('\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('every card grid on /local starts from a shrinkable column', opts, () => {
  test('THE DEFECT: no responsive card grid is left with an implicit auto column', () => {
    const grids = (src().match(/className=(?:"|\{")grid [^"]*"/g) ?? []).filter((g) => /(sm|md|lg):grid-cols-/.test(g));
    assert.ok(grids.length >= 3, `expected the page's card grids, found ${grids.length}`);
    for (const g of grids) assert.match(g, /grid grid-cols-\d/, g);
  });
});
