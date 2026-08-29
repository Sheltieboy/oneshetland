/**
 * local-offer-presentation.node.test.ts — /local with nothing to offer.
 *
 * The page led with "0 live offers" and an "Offers & deals" tile pointing at
 * `#offers`. The section that anchor belongs to only renders when there ARE
 * offers, so with none the tile was a link that scrolled nowhere — a dead
 * control on a public page, not merely a bare number.
 *
 * All three now hang off one value derived from the offers themselves, so the
 * first published offer restores the stat, the tile and the section together.
 * No flag, nothing to remember to switch back on.
 *
 * The conditionals are EXTRACTED FROM THE SOURCE and evaluated here rather than
 * re-described, so this cannot pass by agreeing with a copy of the logic — if
 * either condition is removed the arrays come out wrong and the tests fail.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_ROOT  = join(REPO_ROOT, '..', 'oneshetland-web');
const web = (p: string) => readFileSync(join(WEB_ROOT, p), 'utf8');

const localPage = web('app/local/page.tsx');
const loyalty   = web('app/loyalty/page.tsx');

type Tile = { title: string; href: string };
type Stat = { n: number; label: string };

/** Pull a bracketed array literal out of the source, starting at `marker`. */
function arrayLiteralAt(src: string, marker: string): string {
  const start = src.indexOf(marker);
  assert.ok(start > 0, `could not find ${marker}`);
  const open = src.indexOf('[', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '[') depth++;
    else if (src[i] === ']') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  throw new Error(`unbalanced array literal at ${marker}`);
}

/** Evaluate one of the page's arrays with a chosen offer count. */
function evalWith<T>(literal: string, offerCount: number): T[] {
  const offers = Array.from({ length: offerCount }, (_, i) => ({ id: `o${i}` }));
  const hasOffers = offers.length > 0;
  return new Function(
    'offers', 'hasOffers', 'bookableCount', 'cashbackCount', 'OFFERS_COLOR', 'LOCAL',
    `return ${literal};`,
  )(offers, hasOffers, 4, 2, '#2a8b5c', '#7c3aed') as T[];
}

const PILLARS = arrayLiteralAt(localPage, 'const pillars =');
// Anchored on the element that OPENS the stats strip, so the extractor finds
// the array containing the counts rather than the next bracket after them.
const STATS   = arrayLiteralAt(localPage, 'divide-x divide-line px-5');

/* ── 1. Nothing to offer ────────────────────────────────────────────────── */

describe('with no live offers the page says nothing about them', () => {
  test('the "0 live offers" statistic is not rendered', () => {
    const stats = evalWith<Stat>(STATS, 0);
    assert.ok(!stats.some((s) => s.label === 'live offers'),
      'a headline reading "0 live offers" is worse than no headline');
  });

  test('the Offers pillar — and its dead #offers link — is not rendered', () => {
    const tiles = evalWith<Tile>(PILLARS, 0);
    assert.ok(!tiles.some((t) => t.title === 'Offers & deals'));
    assert.ok(!tiles.some((t) => t.href === '#offers'),
      'nothing may link to an anchor the page is not rendering');
  });

  test('the other statistics and tiles are untouched', () => {
    const stats = evalWith<Stat>(STATS, 0).map((s) => s.label);
    assert.deepEqual(stats, ['bookable spots', 'cashback partners']);
    const tiles = evalWith<Tile>(PILLARS, 0);
    assert.deepEqual(tiles.map((t) => t.title), ['Bookable experiences', 'Cashback partners']);
    assert.deepEqual(tiles.map((t) => t.href), ['/directory/bookable', '/directory']);
  });

  test('the row still fills its width rather than leaving a hole', () => {
    assert.match(localPage, /pillars\.length === 3 \? "sm:grid-cols-3" : "sm:grid-cols-2"/);
  });
});

/* ── 2. The moment a business publishes one ─────────────────────────────── */

describe('with live offers everything comes back on its own', () => {
  test('the statistic appears, counting the real offers', () => {
    const stats = evalWith<Stat>(STATS, 3);
    const offersStat = stats.find((s) => s.label === 'live offers');
    assert.ok(offersStat, 'the statistic returns without anyone switching it on');
    assert.equal(offersStat!.n, 3);
  });

  test('the pillar returns, linking to #offers', () => {
    const tiles = evalWith<Tile>(PILLARS, 1);
    const offersTile = tiles.find((t) => t.title === 'Offers & deals');
    assert.ok(offersTile);
    assert.equal(offersTile!.href, '#offers');
    assert.equal(tiles.length, 3, 'all three pillars, in their original order');
    assert.equal(tiles[0].title, 'Offers & deals');
  });

  test('and the #offers section it points at is rendered', () => {
    assert.match(localPage, /\{hasOffers && \(\s*\n\s*<section id="offers"/);
  });

  test('all three are driven by the SAME value, so they cannot drift apart', () => {
    assert.match(localPage, /const hasOffers = offers\.length > 0;/);
    const uses = localPage.match(/hasOffers/g) ?? [];
    assert.ok(uses.length >= 4, 'declared once and used by stat, tile and section');
    assert.ok(!/OFFERS_ENABLED|NEXT_PUBLIC_.*OFFER|featureFlag/i.test(localPage),
      'no flag and no manual configuration — the data decides');
  });
});

/* ── 3. What must not have moved ────────────────────────────────────────── */

describe('nothing else was touched', () => {
  test('/loyalty keeps its own honest empty state', () => {
    assert.match(loyalty, /coming soon/i);
    assert.ok(!/hasOffers/.test(loyalty), '/loyalty was not given this page\'s conditional');
  });

  test('business-facing Offers routes still exist', () => {
    for (const p of [
      'app/business/[id]/manage/offers/page.tsx',
      'app/local/page.tsx',
    ]) {
      assert.ok(existsSync(join(WEB_ROOT, p)), `${p} must remain`);
    }
  });

  test('Shifts is untouched by this change', () => {
    assert.ok(!/shift/i.test(PILLARS), 'no Shifts tile was added or removed here');
    for (const p of ['app/shifts/new/page.tsx', 'app/shifts/manage/page.tsx', 'app/jobs/page.tsx']) {
      assert.ok(existsSync(join(WEB_ROOT, p)), `${p} must remain`);
    }
  });

  test('the offers query itself is unchanged — presentation only', () => {
    const dataLayer = web('lib/local-data.ts');
    assert.match(dataLayer, /business:local_businesses!inner\(/);
    assert.match(dataLayer, /\.eq\("business\.is_active", true\)/);
  });
});
