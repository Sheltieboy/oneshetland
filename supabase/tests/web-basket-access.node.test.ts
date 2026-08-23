/**
 * web-basket-access.node.test.ts — the way back into the web basket.
 *
 * WHAT WAS WRONG
 *
 * Adding a product showed a "Go to basket" button for 2.5 seconds — AddToBasket
 * set `added`, a timer cleared it — and that was the ONLY route to /basket
 * anywhere on the site. Once it vanished the customer had no way back, so a web
 * marketplace purchase could not reasonably be finished.
 *
 * The basket itself was never lost. lib/basket.ts persists to localStorage and
 * already exposed subscribeBasket "so the header pill stays live" — the pill it
 * was written for had simply never been built, and basketCount() had no callers
 * at all. State was fine; navigation was missing.
 *
 * WHAT IS ASSERTED
 *   · a header pill exists, links to /basket, and is mounted where small screens
 *     can still see it
 *   · its count comes from the basket store rather than a second copy that can
 *     drift, and it re-reads on every change
 *   · the quantity is available as text and in the accessible label, not by
 *     colour alone
 *   · the in-reach "Go to basket" now follows the basket instead of the flash,
 *     while the flash itself survives as feedback
 *   · /basket still handles items, quantity changes, removal and empty
 *
 * The web repo has no component-test harness, so these are structural checks of
 * the same kind this suite already makes against web source. Behaviour was
 * verified separately in a real browser against the live site.
 *
 * SAFETY
 * Source inspection only. No network, no database, no payment.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'oneshetland-web');
const web = (p: string) => readFileSync(join(WEB_ROOT, p), 'utf8');

// ── 1. A persistent way back ───────────────────────────────────────────────

describe('the basket is reachable from anywhere', () => {
  test('the header pill exists and points at /basket', () => {
    const p = join(WEB_ROOT, 'components', 'shop', 'BasketPill.tsx');
    assert.ok(existsSync(p), 'there is no persistent basket control');
    const src = web('components/shop/BasketPill.tsx');
    assert.match(src, /href="\/basket"/);
  });

  test('it is mounted in the site header, not inside a screen-size-hidden cluster', () => {
    const header = web('components/site/SiteHeader.tsx');
    assert.match(header, /import \{ BasketPill \}/);
    assert.match(header, /<BasketPill \/>/);
    // The signed-in cluster is `hidden ... sm:flex`; the pill must sit before it
    // so it survives at small widths.
    const pillAt = header.indexOf('<BasketPill />');
    const clusterAt = header.indexOf('hidden items-center gap-2 sm:flex');
    assert.ok(pillAt > 0 && (clusterAt === -1 || pillAt < clusterAt),
      'the basket must not be hidden on mobile web — it is the only route to checkout');
  });

  test('the pill is not the transient confirmation in disguise', () => {
    const src = web('components/shop/BasketPill.tsx');
    assert.ok(!/setTimeout/.test(src), 'a timer would put the customer back where they started');
  });
});

// ── 2. One count, no drift ─────────────────────────────────────────────────

describe('the item count cannot drift from the basket', () => {
  test('it is derived from the store and re-read on change', () => {
    const src = web('components/shop/BasketPill.tsx');
    assert.match(src, /basketCount\(\)/, 'the count must come from the basket, not a copy');
    assert.match(src, /subscribeBasket\(/, 'it must update when the basket changes');
    assert.ok(!/useState\(basketCount\(\)\)/.test(src),
      'reading localStorage during render is a hydration mismatch');
  });

  test('another tab is kept in step', () => {
    assert.match(web('components/shop/BasketPill.tsx'), /addEventListener\("storage"/);
  });

  test('the store is the single source of truth and persists locally', () => {
    const store = web('lib/basket.ts');
    assert.match(store, /localStorage/);
    assert.match(store, /export function basketCount/);
    assert.match(store, /listeners\.forEach/, 'writes must notify subscribers');
  });
});

// ── 3. Accessible ──────────────────────────────────────────────────────────

describe('the control is usable without a mouse or colour vision', () => {
  test('it is a link with a labelled count and a visible focus state', () => {
    const src = web('components/shop/BasketPill.tsx');
    assert.match(src, /aria-label=\{`Basket, \$\{count\} item/, 'the count must be in the label');
    assert.match(src, /focus-visible:outline/, 'keyboard focus must be visible');
    assert.match(src, /aria-hidden="true"/, 'the decorative icon must be hidden from assistive tech');
    // The number is rendered as text, so it is not conveyed by colour alone.
    assert.match(src, /\{count > 9 \? "9\+" : count\}/);
  });
});

// ── 4. The in-reach button, and the feedback ───────────────────────────────

describe('adding to the basket', () => {
  const src = () => web('components/shop/AddToBasket.tsx');

  test('the immediate confirmation is still there', () => {
    assert.match(src(), /added \? "✓ In your basket"/, 'the post-add feedback should remain');
    assert.match(src(), /setTimeout\(\(\) => setAdded\(false\), 2500\)/);
  });

  test('but "Go to basket" no longer disappears with it', () => {
    const s = src();
    assert.match(s, /\{hasItems && \(/, 'the button must follow the basket, not the flash');
    assert.ok(!/\{added && \([\s\S]{0,200}router\.push\("\/basket"\)/.test(s),
      'the only route back must not be tied to a 2.5 second timer');
    assert.match(s, /subscribeBasket\(read\)/);
  });
});

// ── 5. The basket page itself ──────────────────────────────────────────────

describe('/basket still does its job', () => {
  test('it lists lines, changes quantities and handles empty', () => {
    const src = web('app/basket/page.tsx');
    assert.match(src, /getBasket\(\)/);
    assert.match(src, /setLineQty\(/, 'quantities must be changeable');
    assert.match(src, /basket&rsquo;s empty|basket's empty/, 'an empty basket needs its own state');
    assert.match(src, /subscribeBasket\(/, 'the page must react to changes it makes');
  });

  test('a line keeps its variant, not just the parent product', () => {
    const store = web('lib/basket.ts');
    assert.match(store, /variant_id: string \| null/);
    assert.match(store, /variant_name: string \| null/);
    // Identity is product + variant, so Small and Large are separate lines.
    assert.match(store, /\$\{l\.product_id\}:\$\{l\.variant_id \?\? ""\}/);
  });

  test('checkout still goes through the shared endpoint', () => {
    assert.match(web('app/basket/page.tsx'), /create-product-order-intent/);
  });
});
