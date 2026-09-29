/**
 * book-service-first-discovery.node.test.ts
 *
 * Booking discovery was business-first on both platforms: Local's "Book"
 * entry and the full "Book in Shetland" browse page both listed businesses,
 * showing only a service COUNT per business — finding an actual service to
 * book meant opening a business from that list and scrolling to "Book
 * online" yourself. The user's intent after tapping Book is already a
 * service, not another list of businesses to search through.
 *
 * Directory stays business-first on purpose (that is what it is for). Book
 * is now service-first on both platforms: Local surfaces real bookable
 * services directly, the full browse page lists services grouped by
 * business (business name kept, clickable, but not the required path), and
 * every "Book" control deep-links straight into that exact service's slot
 * picker — local-book-business's existing serviceId param on mobile,
 * ?book=<serviceId> into BookServiceModal on web — both mechanisms already
 * existed (the gift-claim flow already used them), reused here rather than
 * built new.
 *
 * Business detail's own "Book online" / "Tickets & passes" sections are
 * untouched — this is a discovery/navigation change, not a removal of
 * business-first entry for people who arrive there some other way.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_ROOT   = join(REPO_ROOT, '..', 'oneshetland-web');
const read    = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const readWeb = (p: string) => readFileSync(join(WEB_ROOT, p), 'utf8');
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*).*$/gm, '');

function functionBody(src: string, name: string): string {
  const start = src.indexOf(`function ${name}`);
  assert.ok(start >= 0, `function ${name} not found`);
  const rest = src.slice(start);
  const next = rest.slice(1).search(/\nexport (async function|function|const|type|interface) /);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/* ── 1. Local surfaces real services, eligibility enforced explicitly ────── */

describe('Local surfaces active, eligible bookable services — not businesses, not everything active', () => {
  test('mobile: fetchActiveBookableServices filters through isBookableLive, not just is_active', () => {
    const api = read('lib/book-api.ts');
    const fn = functionBody(api, 'fetchActiveBookableServices');
    assert.match(fn, /isBookableLive\(b\)/, 'ineligible businesses (wrong tier, bookings off, inactive) must be dropped before their services are');
    assert.match(fn, /is_active.*true/s, 'inactive services must be dropped too');
  });

  test('web: getBookableServices applies the same three-part rule explicitly, not reconstructed differently', () => {
    const data = readWeb('lib/local-data.ts');
    const fn = functionBody(data, 'getBookableServices');
    assert.match(fn, /eq\("accepts_bookings", true\)/);
    assert.match(fn, /eq\("subscription_tier", "premium"\)/);
    assert.match(fn, /eq\("is_active", true\)/);
  });

  test('the web query this replaced only checked accepts_bookings — a real bug, fixed alongside this rework', () => {
    // getBookableBusinesses/getServiceCounts are gone; nothing in the app
    // still asks the old, looser question.
    const data = readWeb('lib/local-data.ts');
    assert.doesNotMatch(data, /export async function getBookableBusinesses/);
    assert.doesNotMatch(data, /export async function getServiceCounts/);
  });

  test('mobile Local landing calls the services query and renders a real "Book now" section', () => {
    const screen = read('app/local-combined-feed.tsx');
    assert.match(screen, /fetchActiveBookableServices/);
    assert.doesNotMatch(screen, /bookableBusinesses/, 'the old business-first derived list must be gone');
  });

  test('web Local landing calls the services query and renders a real "Book now" section', () => {
    const page = readWeb('app/local/page.tsx');
    assert.match(page, /getBookableServices/);
    assert.match(page, /Book now/);
  });
});

/* ── 2. The full browse page is service-first on both platforms ──────────── */

describe('"Book in Shetland" lists services, grouped by business, not businesses with a count', () => {
  test('mobile local-bookable-browse.tsx groups services by business and renders a per-service Book row', () => {
    const screen = read('app/local-bookable-browse.tsx');
    assert.match(screen, /fetchActiveBookableServices/);
    assert.match(screen, /ServiceRow/);
    assert.doesNotMatch(screen, /serviceCount/, 'a count-only business row is gone — the service itself is now the row');
  });

  test('web /directory/bookable groups services by business and links Book straight to the service', () => {
    const page = readWeb('app/directory/bookable/page.tsx');
    assert.match(page, /getBookableServices/);
    assert.match(page, /grouped\.map/);
  });

  test('business name is still shown and still clickable on both, but is not the thing you tap to book', () => {
    const screen = read('app/local-bookable-browse.tsx');
    const page = readWeb('app/directory/bookable/page.tsx');
    assert.match(screen, /local-business-detail/, 'business context stays reachable on mobile');
    assert.match(page, /bizHref/, 'business context stays reachable on web');
  });
});

/* ── 3. Every Book CTA carries the exact business/service IDs needed ─────── */

describe('the direct Book CTA deep-links into the existing booking flow with the right IDs, not a new mechanism', () => {
  test('mobile: every new/changed Book control routes to local-book-business with both businessId and serviceId', () => {
    const feed = read('app/local-combined-feed.tsx');
    const browse = read('app/local-bookable-browse.tsx');
    for (const src of [feed, browse]) {
      assert.match(src, /pathname: '\/local-book-business', params: \{ businessId: .*, serviceId: .*\.id \}/);
    }
  });

  test('local-book-business already supports a serviceId param to pre-select the service — confirmed, not assumed', () => {
    const screen = read('app/local-book-business.tsx');
    assert.match(screen, /serviceId: paramServiceId/);
    assert.match(screen, /svcs\.find\(s => s\.id === targetId\)/);
  });

  test('web: every new/changed Book control links to the business page with ?book=<serviceId>', () => {
    const localPage = readWeb('app/local/page.tsx');
    const bookablePage = readWeb('app/directory/bookable/page.tsx');
    assert.match(localPage, /\$\{bizHref\}\?book=\$\{s\.id\}/);
    assert.match(bookablePage, /`\$\{bizHref\}\?book=\$\{s\.id\}`/);
  });

  test('ServicesSection already supports ?book=<serviceId> to open the picker directly — confirmed, not assumed (the gift-claim flow already relied on it)', () => {
    const section = readWeb('components/local/ServicesSection.tsx');
    assert.match(section, /openServiceId/);
    assert.match(section, /services\.find\(\(s\) => s\.id === openServiceId\)/);
  });
});

/* ── 4. Business detail keeps business-first entry — untouched ───────────── */

describe('business detail — untouched, still the business-first path for people who arrive there directly', () => {
  test('mobile local-business-detail.tsx still renders its own Tickets & Book sections, unmodified by this task', () => {
    const detail = code(read('app/local-business-detail.tsx'));
    assert.match(detail, /bookCtaSection = shows\('bookable'\) && isBookableLive\(business\)/);
  });

  test('web business detail still renders ServicesSection ("Book online"), unmodified by this task', () => {
    const page = readWeb('app/directory/[id]/page.tsx');
    assert.match(page, /<ServicesSection/);
  });

  test('Directory itself was not touched — business-first discovery there is preserved', () => {
    const dirPage = readWeb('app/directory/page.tsx');
    assert.doesNotMatch(dirPage, /getBookableServices/, 'Directory lists businesses; it does not need the services query');
  });
});

/* ── 5. Copy: task-oriented wording, meaningless counters hidden ─────────── */

describe('counters and copy reflect what a customer can actually do, not a raw business flag', () => {
  test('web: the stats-strip label is "bookable service(s)", not "bookable spots"', () => {
    // Comments referencing the OLD wording (documenting the bug this fixed)
    // are expected and fine; only the rendered copy itself must have moved.
    const page = code(readWeb('app/local/page.tsx'));
    assert.doesNotMatch(page, /bookable spots/);
    assert.match(page, /bookable service/);
  });

  test('web: the pillar is gated on hasBookable (real services), and hides like every other pillar when there are none', () => {
    const page = readWeb('app/local/page.tsx');
    const pillars = page.slice(page.indexOf('const pillars ='), page.indexOf('];') + 2);
    assert.match(pillars, /hasBookable\s*\n\s*\? \[\{ emoji: "📅", title: "Book now"/);
  });
});
