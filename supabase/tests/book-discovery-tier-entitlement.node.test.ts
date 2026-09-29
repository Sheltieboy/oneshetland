/**
 * book-discovery-tier-entitlement.node.test.ts
 *
 * Server-side, Bookings has always correctly required Pro-and-above:
 * local_businesses_bookings_tier_guard (gating the accepts_bookings toggle)
 * and book_bookings_tier_guard (gating the booking itself, checked fresh —
 * not inherited from a flag set months ago) both call
 * business_meets_tier(id, 'pro') live in production — proven directly
 * against pg_get_functiondef below, and already covered end-to-end by
 * bookings-tier-entitlement.node.test.ts.
 *
 * Client-side, two DISPLAY-eligibility functions disagreed with that server
 * rule: mobile's isBookableLive() and web's getBookableServices() both
 * required subscription_tier to be exactly 'premium'. A legitimate Pro
 * business could turn bookings on — the server trigger would allow it — and
 * a real customer could book it — the server trigger would allow that too —
 * while never seeing a "Book now" anywhere: not on its own business-detail
 * page, not in Local's "Book now" section, not on the "Book in Shetland"
 * browse page. Entitled by the only two places that actually enforce
 * anything, invisible everywhere a customer would find out.
 *
 * Fixed: isBookableLive() now delegates to tierUnlocks(tier, 'bookable')
 * (TIER_FEATURES.bookable = 'pro' in listing-tiers.ts — the same map
 * business-detail's own shows('bookable') / showServices gates already
 * read) instead of hand-rolling the comparison. getBookableServices() now
 * filters subscription_tier .in(["pro","premium"]), the same idiom this
 * file already uses for identical "Pro or above" questions elsewhere
 * (getFeaturedBusinesses).
 *
 * accepts_bookings is NOT weakened by this fix — both checks below prove a
 * Premium business with accepts_bookings=false is still excluded on both
 * platforms, tier alone was never sufficient and still is not.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { tierUnlocks } from '../../lib/listing-tiers.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_ROOT   = join(REPO_ROOT, '..', 'oneshetland-web');
const read    = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const readWeb = (p: string) => readFileSync(join(WEB_ROOT, p), 'utf8');

function sql(body: string): Record<string, unknown>[] {
  const out = execFileSync('npx',
    ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${body}`, '--output-format', 'json'],
    { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 240_000 });
  const parsed = JSON.parse(out.slice(out.indexOf('{'))) as { rows?: Record<string, unknown>[]; error?: unknown };
  if (parsed.error) throw new Error(JSON.stringify(parsed.error).slice(0, 400));
  return parsed.rows ?? [];
}

/* ── 1. isBookableLive() delegates to the real, imported tierUnlocks() ───── */

describe('mobile isBookableLive() accepts Pro and above, not just Premium', () => {
  const src = read('lib/book-api.ts');
  const start = src.indexOf('export function isBookableLive');
  const body = src.slice(start, src.indexOf('\n}\n', start) + 2);

  test('the source delegates to tierUnlocks(subscription_tier, \'bookable\') rather than hand-rolling the comparison', () => {
    assert.match(body, /tierUnlocks\(b\.subscription_tier, 'bookable'\)/);
    assert.doesNotMatch(body, /subscription_tier === 'premium'/, 'the exact-match bug this fix replaced must not come back');
  });

  test('accepts_bookings and is_active are still both required alongside the tier check — not weakened', () => {
    assert.match(body, /Boolean\(b\.accepts_bookings\)/);
    assert.match(body, /b\.is_active !== false/);
  });

  // tierUnlocks itself is real and imported (not reimplemented) — this
  // proves the actual composed answer for 'bookable' at each tier, which is
  // exactly what isBookableLive's delegation reduces to once the AND-chain
  // above is confirmed present.
  test('tierUnlocks rejects free for \'bookable\'', () => {
    assert.equal(tierUnlocks('free', 'bookable'), false);
  });
  test('tierUnlocks accepts pro for \'bookable\'', () => {
    assert.equal(tierUnlocks('pro', 'bookable'), true);
  });
  test('tierUnlocks accepts premium for \'bookable\' — it exceeds pro', () => {
    assert.equal(tierUnlocks('premium', 'bookable'), true);
  });
});

/* ── 2. Web getBookableServices() asks the equivalent Pro-or-above question ── */

describe('web getBookableServices() applies the same Pro-or-above rule, not reconstructed differently', () => {
  const src = readWeb('lib/local-data.ts');
  const start = src.indexOf('export async function getBookableServices');
  const body = src.slice(start, src.indexOf('export type BookableService', start) >= 0 ? start : src.length);
  const fnEnd = body.indexOf('\n/* ── Profile');
  const fn = fnEnd === -1 ? body : body.slice(0, fnEnd);

  test('the tier filter enumerates ["pro","premium"], not an exact match on "premium"', () => {
    assert.match(fn, /\.in\("subscription_tier", \["pro", "premium"\]\)/);
    assert.doesNotMatch(fn, /\.eq\("subscription_tier", "premium"\)/);
  });

  test('accepts_bookings is still required alongside the tier check — not weakened', () => {
    assert.match(fn, /\.eq\("accepts_bookings", true\)/);
  });

  test('this is the same idiom the file already uses for an identical "Pro or above" question elsewhere (getFeaturedBusinesses), not a new pattern', () => {
    const featured = src.slice(src.indexOf('export async function getFeaturedBusinesses'), src.indexOf('export async function getFeaturedBusinesses') + 600);
    assert.match(featured, /\.in\("subscription_tier", \["pro", "premium"\]\)/);
  });
});

/* ── 3. Server: both live guards actually require 'pro', not 'premium' ───── */

describe('nothing on the server needed correcting — both guards already say pro, live, right now', () => {
  test('the accepts_bookings toggle guard requires business_meets_tier(id, \'pro\')', () => {
    const [row] = sql(`select pg_get_functiondef('public.local_businesses_bookings_tier_guard'::regproc) as d;`);
    assert.match(String(row.d), /business_meets_tier\(new\.id, 'pro'\)/);
    assert.doesNotMatch(String(row.d), /business_meets_tier\(new\.id, 'premium'\)/);
  });

  test('the booking-creation guard re-checks entitlement fresh, also at \'pro\' — not inherited from a stale flag', () => {
    const [row] = sql(`select pg_get_functiondef('public.book_bookings_tier_guard'::regproc) as d;`);
    assert.match(String(row.d), /business_meets_tier\(new\.business_id, 'pro'\)/);
    assert.match(String(row.d), /not coalesce\(v_open, false\)/, 'accepts_bookings is still checked here too, independent of tier');
  });

  test('business_meets_tier itself treats premium as meeting a pro requirement (rank-based, not an exact match)', () => {
    const [row] = sql(`select pg_get_functiondef('public.business_meets_tier'::regproc) as d;`);
    assert.match(String(row.d), /v_actual < v_required/, 'a >= comparison, not an exact-tier match');
  });
});

/* ── 4. Parity: both platforms now ask the identical question ────────────── */

describe('mobile and web now agree on what "bookable" means', () => {
  test('TIER_FEATURES.bookable is \'pro\' in both repos\' listing-tiers.ts — the map both fixes ultimately read from', () => {
    const mobile = read('lib/listing-tiers.ts');
    const web = readWeb('lib/listing-tiers.ts');
    assert.match(mobile, /bookable:\s*"pro"/);
    assert.match(web, /bookable:\s*"pro"/);
  });

  test('business-detail\'s own tier gates on both platforms already agreed with this — only the cross-business discovery queries were wrong', () => {
    const mobileDetail = read('app/local-business-detail.tsx');
    const webDetail = readWeb('app/directory/[id]/page.tsx');
    assert.match(mobileDetail, /shows\('bookable'\)/);
    assert.match(webDetail, /tierUnlocks\(tier, "services"\)/);
  });
});
