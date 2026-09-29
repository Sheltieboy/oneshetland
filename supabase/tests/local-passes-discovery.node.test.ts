/**
 * local-passes-discovery.node.test.ts
 *
 * Passes / unit purchases (class packs, day passes) had no discovery surface
 * anywhere on Local, on either platform: a business's own detail page showed
 * them correctly (gated on the same 'passesOnListing' Premium feature the
 * checkout itself enforces), but nothing on the Local landing page — the
 * screen the app actually funnels browsing to — ever pointed at one. A real
 * pass bought on a real business was consequently invisible from Local, even
 * though the business itself ranked #1 in the feed.
 *
 * This pins:
 *   1. a cross-business passes query exists on both platforms and is wired
 *      into the Local landing screen (not left orphaned, the way the mobile
 *      repo's original fetchActiveUnitItems was — defined, never called);
 *   2. Local no longer duplicates What's On's own event carousel;
 *   3. two adjacent bugs found during the same audit stay fixed:
 *      - mobile's area filter asked `local_businesses_public` (a view with
 *        no locality column) for `locality`, which fails outright — a
 *        4xx the caller swallows as "no businesses in that area", on every
 *        area, always;
 *      - web ordered businesses by `subscription_tier` as raw text, which
 *        sorts 'pro' above 'premium' the moment both exist.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read    = (p: string) => readFileSync(join(REPO, p), 'utf8');
const webRoot = join(REPO, '..', 'oneshetland-web');
const readWeb = (p: string) => readFileSync(join(webRoot, p), 'utf8');

/** The body of one `export (async )?function NAME(` up to the next top-level export. */
function functionBody(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `function ${name} not found`);
  const rest = src.slice(start);
  const next = rest.slice(1).search(/\nexport (async function|function|const|type|interface) /);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe('passes are discoverable from Local, not just from a business page', () => {
  test('mobile: fetchActiveLocalPasses exists, is business-active-aware, and is wired into the Local landing screen', () => {
    const api = read('lib/local-api.ts');
    assert.match(api, /export async function fetchActiveLocalPasses/);
    // The gate a customer can actually buy against (RLS/business_meets_tier)
    // is enforced server-side; this only has to additionally drop a
    // deactivated business, which that RLS rule does not check.
    const fn = functionBody(api, 'fetchActiveLocalPasses');
    assert.match(fn, /is_active.*true/s, 'drops items that are not active');
    assert.match(fn, /b\.is_active/, 'drops businesses that have been deactivated');

    const screen = read('app/local-combined-feed.tsx');
    assert.match(screen, /fetchActiveLocalPasses/, 'the Local landing screen must call it');
    assert.match(screen, /Passes (&amp;|&) experiences/, 'and render a passes section');
  });

  test('web: getActiveLocalPasses exists, is business-active-aware, and is wired into the Local landing page', () => {
    const data = readWeb('lib/local-data.ts');
    assert.match(data, /export async function getActiveLocalPasses/);
    const fn = functionBody(data, 'getActiveLocalPasses');
    assert.match(fn, /is_active.*true/s, 'drops items that are not active');
    assert.match(fn, /b\.is_active/, 'drops businesses that have been deactivated');

    const page = readWeb('app/local/page.tsx');
    assert.match(page, /getActiveLocalPasses/, 'the Local landing page must call it');
    assert.match(page, /Passes (&amp;|&) experiences/, 'and render a passes section');
  });

  test('the old orphaned marketplace query is not what either platform relies on for this', () => {
    // fetchActiveUnitItems predates this fix, was never called from any
    // screen, and does not check business eligibility at all (no tier, no
    // is_active) — reviving it as-is would have surfaced a pass from a
    // business that can no longer sell them. The new functions replace it
    // for this purpose rather than exposing that gap on Local.
    const screen = read('app/local-combined-feed.tsx');
    assert.doesNotMatch(screen, /fetchActiveUnitItems/);
  });
});

describe('Local no longer duplicates What\'s On\'s own event carousel', () => {
  test('mobile Local landing has no Upcoming events section', () => {
    const screen = read('app/local-combined-feed.tsx');
    assert.doesNotMatch(screen, /Upcoming events/);
    assert.doesNotMatch(screen, /EventCard/);
  });

  test('web Local landing has no Upcoming events section', () => {
    const page = readWeb('app/local/page.tsx');
    assert.doesNotMatch(page, /Upcoming events/);
  });
});

describe('the two adjacent eligibility/ordering bugs found during this audit', () => {
  test('mobile area filter asks for a column local_businesses_public actually has', () => {
    const api = read('lib/local-api.ts');
    const fn = functionBody(api, 'fetchLocalFeed');
    // The businesses branch must not filter on `locality` — the view has no
    // such column, so PostgREST 400s and the caller reads that as "no
    // businesses", on every area filter, silently.
    const bizBranch = fn.slice(fn.indexOf('BUSINESS_PUBLIC_SOURCE'));
    const bizFilterLine = bizBranch.split('\n').find(l => l.includes('ilike') && l.includes('bizQ'));
    assert.ok(bizFilterLine, 'the businesses branch must still filter by area');
    assert.match(bizFilterLine!, /ilike\('address'/);
    assert.doesNotMatch(bizFilterLine!, /ilike\('locality'/);
  });

  test('web Local businesses are not ordered by subscription_tier as raw text', () => {
    // "pro" > "premium" as plain strings (o > e), so a raw text-descending
    // sort ranks a lower tier above a higher one the moment both exist.
    // is_verified + recency is also the same order the mobile app's own
    // Local feed already uses.
    const data = readWeb('lib/local-data.ts');
    const fn = functionBody(data, 'getLocalFeed');
    const bizBranch = fn.slice(fn.indexOf('PUBLIC_BUSINESS'));
    assert.doesNotMatch(bizBranch, /order\("subscription_tier"/);
    assert.match(bizBranch, /order\("is_verified"/);
    assert.match(bizBranch, /order\("created_at"/);
  });
});

describe('empty sections do not advertise zero content', () => {
  test('web stats strip hides bookable/cashback the same way it already hid offers', () => {
    const page = readWeb('app/local/page.tsx');
    const stripStart = page.indexOf('Stats strip');
    assert.ok(stripStart >= 0);
    const strip = page.slice(stripStart, stripStart + 1500);
    assert.match(strip, /hasBookable \? \[\{ n: bookableCount/);
    assert.match(strip, /hasCashback \? \[\{ n: cashbackCount/);
  });
});
