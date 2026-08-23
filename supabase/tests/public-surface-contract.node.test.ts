/**
 * public-surface-contract.node.test.ts — the website, signed out.
 *
 * WHY THIS EXISTS
 *
 * Two launch outages shipped because every test in this suite ran as
 * service_role or as an authenticated user. Step 8 replaced anon's table-wide
 * SELECT on local_businesses with a column whitelist that withholds owner_id,
 * and every RLS policy that answers "does the caller own this business?" by
 * reading that column AS THE CALLER started failing with
 *
 *     42501: permission denied for table local_businesses
 *
 * for anonymous visitors — an ERROR, not an empty result. Public events
 * vanished from What's On. Public products vanished from the shop. Both were
 * invisible to the whole test suite because nothing exercised the site the way
 * a signed-out visitor does, and every call site turned the error into [].
 *
 * WHAT THIS ASSERTS
 *
 * An explicit, hand-maintained CONTRACT rather than "everything returns 200":
 *
 *   PUBLIC_CONTRACT  — surfaces a signed-out visitor must be able to read.
 *                      Each names the page that breaks when it fails.
 *   HIDDEN_CONTRACT  — the publication rules those same tables must keep:
 *                      an inactive offer or service stays invisible.
 *   PRIVATE_CONTRACT — tables anon must NEVER read, so a future "fix" that
 *                      makes the 42501 go away by opening the table up fails
 *                      here instead of in production.
 *   PROTECTED_COLUMNS — Step 8 itself: the local_businesses columns anon must
 *                      still be refused.
 *
 * Adding a public browsing surface means adding a line to PUBLIC_CONTRACT.
 * That is the point: the list is the specification.
 *
 * SAFETY
 * Read-only. Anonymous requests only — no service key, no auth, no writes, no
 * payment. Skips cleanly if the anon config is not present.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function publicConfig(): { url: string; anonKey: string } | null {
  let url = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
  let anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';
  if (!url || !anonKey) {
    try {
      for (const line of readFileSync(join(REPO_ROOT, '.env'), 'utf8').split('\n')) {
        const m = line.match(/^\s*(EXPO_PUBLIC_SUPABASE_URL|EXPO_PUBLIC_SUPABASE_ANON_KEY)\s*=\s*(.+)\s*$/);
        if (!m) continue;
        const v = m[2].trim().replace(/^["']|["']$/g, '');
        if (m[1].endsWith('URL')) url ||= v; else anonKey ||= v;
      }
    } catch { /* handled by the null return */ }
  }
  return url && anonKey ? { url, anonKey } : null;
}
const cfg = publicConfig();
const skip = cfg ? false : 'no anon config (.env) — cannot test the signed-out surface';

/** One anonymous PostgREST GET. No Authorization beyond the public anon key. */
async function anon(path: string): Promise<{ status: number; code?: string; rows: unknown[] }> {
  const res = await fetch(`${cfg!.url}/rest/v1/${path}`, {
    headers: { apikey: cfg!.anonKey, Authorization: `Bearer ${cfg!.anonKey}` },
  });
  const text = await res.text();
  let body: unknown = null;
  try { body = JSON.parse(text); } catch { /* non-JSON error body */ }
  if (Array.isArray(body)) return { status: res.status, rows: body };
  const err = (body ?? {}) as { code?: string };
  return { status: res.status, code: err.code, rows: [] };
}

/* ── The contract ─────────────────────────────────────────────────────────── */

/** Surfaces a signed-out visitor must be able to read. `where` breaks if this does. */
const PUBLIC_CONTRACT: { table: string; select: string; where: string }[] = [
  { table: 'local_businesses',      select: 'id,name,slug,category,logo_url', where: 'the Directory list and every business page' },
  { table: 'events',                select: 'id,title',                       where: "What's On" },
  { table: 'event_ticket_types',    select: 'id,name',                        where: 'the ticket picker on a public event page' },
  { table: 'products',              select: 'id,title',                       where: 'the Shop' },
  { table: 'product_variants',      select: 'id,name',                        where: 'a product page' },
  { table: 'local_offers',          select: 'id,title',                       where: '/loyalty, /local and business-page offers' },
  { table: 'local_loyalty_programs', select: 'business_id,type',              where: 'the Shop Local Shetland showcase' },
  { table: 'book_services',         select: 'id,name',                        where: '/directory/bookable and business-page services' },
  { table: 'book_unit_items',       select: 'id,name',                        where: 'passes and packs on a business page' },
  { table: 'partner_alerts',        select: 'id,message',                     where: 'the home-page alert strip' },
  { table: 'hubs',                  select: 'id,name',                        where: 'the hubs directory' },
  { table: 'jobs',                  select: 'id,title',                       where: 'the jobs board' },
];

/** Publication rules those public tables must keep. Nothing draft leaks. */
const HIDDEN_CONTRACT: { table: string; filter: string; what: string }[] = [
  { table: 'local_offers',   filter: 'is_active=eq.false', what: 'an offer switched off' },
  { table: 'book_services',  filter: 'is_active=eq.false', what: 'a service switched off' },
  { table: 'book_unit_items', filter: 'is_active=eq.false', what: 'a pass switched off' },
  { table: 'products',       filter: 'is_active=eq.false', what: 'an unpublished product' },
];

/** Tables anon must NEVER read. A "fix" that opens one of these fails here. */
const PRIVATE_CONTRACT: { table: string; select: string; why: string }[] = [
  { table: 'product_orders',           select: 'id',                  why: "another buyer's marketplace orders" },
  { table: 'product_order_items',      select: 'id',                  why: 'what another buyer bought' },
  { table: 'book_bookings',            select: 'id',                  why: "a customer's appointments" },
  { table: 'book_unit_purchases',      select: 'id',                  why: 'passes somebody else paid for' },
  { table: 'event_tickets',            select: 'id',                  why: "somebody else's tickets" },
  { table: 'event_ticket_orders',      select: 'id',                  why: 'ticket purchase records' },
  { table: 'local_loyalty_cards',      select: 'id',                  why: 'who collects stamps where' },
  { table: 'local_wallet_transactions', select: 'id',                 why: 'wallet movements' },
  { table: 'local_business_follows',   select: 'business_id,user_id', why: 'who follows whom' },
  { table: 'local_offer_redemptions',  select: 'offer_id',            why: 'who redeemed what' },
];

/** Step 8 — local_businesses columns anon must still be refused. */
const PROTECTED_COLUMNS = [
  'owner_id', 'stripe_account_id', 'stripe_customer_id', 'stripe_subscription_id',
  'business_stripe_account_id', 'nfc_token', 'business_stripe_payouts_enabled',
];

/* ── 1. The signed-out visitor can browse ─────────────────────────────────── */

describe('the public browsing surface works signed out', { skip }, () => {
  for (const s of PUBLIC_CONTRACT) {
    test(`${s.table} — ${s.where}`, async () => {
      const r = await anon(`${s.table}?select=${s.select}&limit=3`);
      assert.equal(
        r.status, 200,
        `anon read of ${s.table} returned ${r.status}${r.code ? ` (${r.code})` : ''} — ${s.where} is broken for signed-out visitors`,
      );
    });
  }

  test('no public surface answers with a permission error', async () => {
    const denied: string[] = [];
    for (const s of PUBLIC_CONTRACT) {
      const r = await anon(`${s.table}?select=${s.select}&limit=1`);
      if (r.code === '42501') denied.push(`${s.table} (${s.where})`);
    }
    assert.deepEqual(denied, [], `42501 on public surfaces: ${denied.join(', ')}`);
  });

  test('`select *` on local_businesses is still refused — the whitelist holds', async () => {
    const r = await anon('local_businesses?select=*&limit=1');
    assert.notEqual(r.status, 200, 'select * on local_businesses must not be allowed');
  });
});

/* ── 2. Draft and disabled rows stay invisible ────────────────────────────── */

describe('publication rules survive the repair', { skip }, () => {
  for (const h of HIDDEN_CONTRACT) {
    test(`${h.what} is not shown to the public`, async () => {
      const r = await anon(`${h.table}?select=id&${h.filter}&limit=5`);
      assert.equal(r.status, 200, `${h.table} should evaluate, not error`);
      assert.equal(r.rows.length, 0, `${h.what} leaked to an anonymous visitor`);
    });
  }
});

/* ── 3. Private data is still private ─────────────────────────────────────── */

describe('a signed-out visitor cannot reach anybody’s private data', { skip }, () => {
  for (const p of PRIVATE_CONTRACT) {
    test(`${p.table} — ${p.why}`, async () => {
      const r = await anon(`${p.table}?select=${p.select}&limit=1`);
      const ok = r.status !== 200 || r.rows.length === 0;
      assert.ok(ok, `anon read ${r.rows.length} row(s) of ${p.table} — ${p.why} is exposed`);
    });
  }
});

/* ── 4. Step 8 is not weakened ────────────────────────────────────────────── */

describe('protected business columns stay protected', { skip }, () => {
  for (const col of PROTECTED_COLUMNS) {
    test(`anon cannot select local_businesses.${col}`, async () => {
      const r = await anon(`local_businesses?select=id,${col}&limit=1`);
      assert.notEqual(r.status, 200, `anon was allowed to read ${col}`);
    });
  }
});

/* ── 5. The shape of the repair ───────────────────────────────────────────── */

describe('public policies ask a predicate instead of reading the table', () => {
  const migration = readFileSync(
    join(REPO_ROOT, 'supabase/migrations/20260823180000_public_browsing_without_business_select.sql'),
    'utf8',
  );

  test('no repaired policy selects from local_businesses inline', () => {
    assert.ok(
      !/from\s+public\.local_businesses/i.test(migration),
      'a repaired policy still reads local_businesses as the caller',
    );
  });

  test('it reuses the existing helper rather than a near-duplicate', () => {
    assert.match(migration, /public\.is_business_owner\(business_id, auth\.uid\(\)\)/);
    assert.ok(
      !/create or replace function/i.test(migration),
      'this migration should not define a new helper — is_business_owner already exists',
    );
  });

  test('it grants anon nothing on local_businesses', () => {
    assert.ok(
      !/grant\s+select.*local_businesses.*anon/is.test(migration),
      'Step 8 must not be undone to make a policy evaluate',
    );
  });

  test('public reads keep their is_active rule', () => {
    for (const t of ['local_offers', 'book_services', 'book_unit_items']) {
      const policy = migration.match(new RegExp(`create policy "Anyone can read[^"]*" on public\\.${t}[\\s\\S]*?;`))?.[0];
      assert.ok(policy, `no public read policy for ${t}`);
      assert.match(policy, /is_active = true/, `${t} lost its publication rule`);
    }
  });
});
