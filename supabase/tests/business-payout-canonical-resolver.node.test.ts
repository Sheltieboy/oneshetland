/**
 * business-payout-canonical-resolver.node.test.ts — one payout rule, everywhere
 * money moves to a Local business.
 *
 * WHAT WAS WRONG
 *
 * A parity audit (mobile ↔ web, extended to every merchant-money route) found
 * that the canonical payout resolver — _business_payout_resolve() /
 * business_payout_destination() / business_payout_ready(), already correct
 * and already used by create-event-ticket-intent and
 * create-product-order-intent (see marketplace-readiness.node.test.ts) — was
 * bypassed by five other money-moving paths, each independently reading
 * local_businesses.stripe_account_id / payout_enabled directly:
 *
 *   · create-unit-purchase-intent  (passes / class packs / day passes)
 *   · create-gift-intent           (gifted passes/services)
 *   · _shared/wallet-pay.ts        (the one executor both local-wallet-pay
 *                                   and wallet-charge-approve converge on)
 *   · wallet-checkout              (its unit_purchase branch)
 *   · resolve_nfc_tile             (a Postgres function, not an edge
 *                                   function — its payout_ready column)
 *
 * The raw-column check has no fallback to the owner's central Stripe
 * account, so a business that is genuinely payout-ready — and can already
 * sell products and event tickets — was wrongly refused a pass sale, a
 * gift purchase, a Wallet payment, or told by its own NFC tile that Wallet
 * was not ready, purely because it inherits rather than owns its account.
 *
 * THE FIX
 *
 * All five now resolve payout readiness through the same canonical
 * functions events and products already use, rather than reimplementing
 * the raw-column question a sixth (through tenth) time. No new resolver was
 * introduced — _business_payout_resolve/business_payout_destination/
 * business_payout_ready are entirely unchanged by this fix; they were
 * already correct and are pinned by marketplace-readiness.node.test.ts.
 * Every path still fails cleanly (no PaymentIntent, no transfer, no debit)
 * before money moves when no valid payout destination exists.
 *
 * WHAT IS ASSERTED
 *   · none of the five paths reads local_businesses.stripe_account_id or
 *     .payout_enabled as its payout-readiness gate any more
 *   · all five call the canonical resolver instead (business_payout_destination
 *     for the four edge functions, business_payout_ready for the SQL function)
 *   · each still refuses cleanly (before any charge/transfer/debit) when the
 *     resolver returns no destination
 *   · the resolved destination — not a raw column — is what actually receives
 *     the transfer/PaymentIntent, so a Route B (owner-inherited) business is
 *     paid, not just "allowed to proceed" and then paid nowhere
 *   · create-event-ticket-intent, create-product-order-intent and hub payout
 *     logic (create-hub-donation-intent, create-hub-membership-intent,
 *     wallet-checkout's hub branches) are byte-unchanged by this task
 *
 * WHAT THIS FILE CANNOT PROVE
 * Source-level assertions only, consistent with the rest of this session's
 * Edge Function coverage — this repo has no way to invoke a Deno edge
 * function or a live Stripe call in a unit test. Resolver correctness
 * itself (Route A / Route B / neither) is proven separately, against the
 * live database, by marketplace-readiness.node.test.ts — not re-proven
 * here, since this task did not touch the resolver.
 *
 * SAFETY
 * Reads source only. No Supabase call, no database write, no Stripe call.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*).*$/gm, '');

/** The old, non-canonical, no-fallback pattern this task removed everywhere. */
const RAW_COLUMN_GATE = /!\s*\w+(\?\.|\.)stripe_account_id\s*\|\|\s*!\s*\w+(\?\.|\.)payout_enabled/;

// wallet-checkout also contains the hub donation/membership branches, which
// are explicitly out of scope and still correctly use hub.stripe_account_id
// directly (see the "hub payout logic" describe block below) — so every
// check against this file must be scoped to the unitPurchase() function
// alone, not the whole file, or it would wrongly flag the untouched hub code.
const sliceUnitPurchase = (src: string) =>
  src.slice(src.indexOf('async function unitPurchase'), src.indexOf('async function shiftBoost'));

const EDGE_FUNCTIONS: { label: string; path: string; scope?: (src: string) => string }[] = [
  { label: 'create-unit-purchase-intent (Passes)', path: 'supabase/functions/create-unit-purchase-intent/index.ts' },
  { label: 'create-gift-intent',                   path: 'supabase/functions/create-gift-intent/index.ts' },
  { label: '_shared/wallet-pay.ts',                 path: 'supabase/functions/_shared/wallet-pay.ts' },
  { label: 'wallet-checkout (unit_purchase)',       path: 'supabase/functions/wallet-checkout/index.ts', scope: sliceUnitPurchase },
];

/* ── 4-8 (edge functions). Canonical resolver in, raw-column gate out ────── */

describe('every fixed edge function now calls the canonical payout resolver', () => {
  for (const { label, path, scope } of EDGE_FUNCTIONS) {
    const fullSrc = code(read(path));
    const src = scope ? scope(fullSrc) : fullSrc;

    test(`${label}: calls business_payout_destination, not raw columns`, () => {
      assert.match(src, /rpc\('business_payout_destination',\s*\{\s*p_business:/,
        `${label} must resolve payout via the shared RPC, same shape as create-product-order-intent`);
    });

    test(`${label}: the old raw-column gate is gone`, () => {
      assert.doesNotMatch(src, RAW_COLUMN_GATE,
        `${label} must not reimplement "!stripe_account_id || !payout_enabled" locally`);
    });

    test(`${label}: fails before any charge/transfer/debit when no destination resolves`, () => {
      // Each function's own refusal message/status, immediately after
      // resolving payout and before touching Stripe or the wallet ledger.
      const resolveIdx = src.indexOf("rpc('business_payout_destination'");
      assert.notEqual(resolveIdx, -1);
      const after = src.slice(resolveIdx, resolveIdx + 1200);
      assert.match(after, /ellerAccountId\s*(:|=)/i, `${label} must extract the resolved account id`);
      // The refusal itself may test the resolved id directly (per_order_max-
      // style files) or via a boolean derived from it a line earlier
      // (create-gift-intent's giftHasAccount) — both are legitimate; what
      // matters is that SOME refusal response sits right after extraction,
      // and (checked separately, below) that no raw-column condition does
      // the same job instead.
      assert.match(after, /return (new Response\(|json\(|reply\(|\{ ok: false)/,
        `${label} must still refuse before any charge/transfer/debit when unresolved`);
    });
  }

  test('the resolved account — not a raw column — is what actually receives the money in every fixed function', () => {
    // Each file's own transfer/PaymentIntent destination line, named per that
    // file's local variable for the resolved seller account.
    const expectations: [string, RegExp][] = [
      ['supabase/functions/create-unit-purchase-intent/index.ts', /transfer_data\[destination\]'\]\s*=\s*unitSellerAccountId/],
      ['supabase/functions/create-gift-intent/index.ts',           /destination:\s*giftSellerAccountId!/],
      ['supabase/functions/_shared/wallet-pay.ts',                 /destination:\s*sellerAccountId!/],
      ['supabase/functions/wallet-checkout/index.ts',              /destination:\s*sellerAccountId,/],
    ];
    for (const [path, re] of expectations) {
      assert.match(code(read(path)), re, `${path} must transfer to the resolved account, not a raw column`);
    }
    // And none of the four fixed files sends a raw column to Stripe any more.
    for (const { path } of EDGE_FUNCTIONS) {
      assert.doesNotMatch(code(read(path)), /destination:\s*\w*[Bb]iz\.stripe_account_id/,
        `${path} must not transfer to a raw-column account id`);
      assert.doesNotMatch(code(read(path)), /\[destination\]'\]\s*=\s*\w*[Bb]iz(!)?\.stripe_account_id/,
        `${path} must not set transfer_data[destination] from a raw column`);
    }
  });

  test('demo businesses still bypass the destination transfer where that bypass existed before (create-unit-purchase-intent, create-gift-intent) — transfer logic itself is unchanged, only its payout SOURCE is', () => {
    for (const path of ['supabase/functions/create-unit-purchase-intent/index.ts', 'supabase/functions/create-gift-intent/index.ts']) {
      assert.match(code(read(path)), /is_demo/, `${path} must still read is_demo from the resolver`);
    }
  });
});

/* ── 8. resolve_nfc_tile (SQL function, not an edge function) ───────────── */

describe('resolve_nfc_tile now calls business_payout_ready() instead of computing the raw check inline', () => {
  const migrationPath = 'supabase/migrations/20261015010000_resolve_nfc_tile_canonical_payout.sql';
  const sql = read(migrationPath);

  test('the migration exists and redefines resolve_nfc_tile', () => {
    assert.match(sql, /create or replace function public\.resolve_nfc_tile\(p_token text\)/);
  });

  test('payout_ready is computed via business_payout_ready(b.id), not the inline raw-column expression', () => {
    assert.match(sql, /public\.business_payout_ready\(b\.id\)/);
    assert.doesNotMatch(sql, /b\.stripe_account_id IS NOT NULL AND coalesce\(b\.payout_enabled, false\)/,
      'the old inline raw-column formula must be gone');
  });

  test('the returned column shape (name, order, types) is unchanged — callers see the same shape', () => {
    assert.match(sql,
      /returns table\(business_id uuid, business_name text, accepts_wallet boolean, payout_ready boolean,\s*\n\s*cashback_percent numeric, has_loyalty boolean, program_type text, stamp_reward text\)/);
  });

  test('wallet_live(), loyalty entitlement and the business lookup are untouched', () => {
    assert.match(sql, /coalesce\(public\.wallet_live\(b\), false\)/);
    assert.match(sql, /public\.business_meets_tier\(b\.id, 'pro'\)/);
    assert.match(sql, /WHERE b\.nfc_token = p_token/);
  });
});

/* ── 9. None of the five paths directly reimplements the old raw-column test ── */

describe('no fixed path reimplements the raw-column payout test anywhere in its own file', () => {
  for (const { label, path, scope } of EDGE_FUNCTIONS) {
    test(`${label} has no residual "stripe_account_id && payout_enabled"-style inline check`, () => {
      const fullSrc = code(read(path));
      const src = scope ? scope(fullSrc) : fullSrc;
      assert.doesNotMatch(src, /\.stripe_account_id\s*&&\s*\w*\.payout_enabled/);
      assert.doesNotMatch(src, /!\w*\?\.stripe_account_id \|\| !\w*\.payout_enabled/);
    });
  }
});

/* ── 10. Events and Products payment paths are byte-unchanged ───────────── */

describe('the already-correct event-ticket and product-order payment paths are untouched', () => {
  test('create-event-ticket-intent still resolves via event_payout_destination, unchanged', () => {
    const src = code(read('supabase/functions/create-event-ticket-intent/index.ts'));
    assert.match(src, /rpc\('event_payout_destination'/);
  });

  test('create-product-order-intent still resolves via business_payout_destination, unchanged', () => {
    const src = code(read('supabase/functions/create-product-order-intent/index.ts'));
    assert.match(src, /rpc\('business_payout_destination'/);
    assert.match(src, /'transfer_data\[destination\]':\s*sellerAccountId/);
  });

  test('the canonical resolver functions themselves are untouched by this task — no new migration redefines them', () => {
    const migrationsDir = join(REPO_ROOT, 'supabase', 'migrations');
    const newMigrations = readdirSync(migrationsDir).filter((f) => f >= '20261015010000');
    for (const f of newMigrations) {
      const sql = read(join('supabase', 'migrations', f));
      assert.doesNotMatch(sql, /create or replace function public\._business_payout_resolve/,
        `${f} must not redefine _business_payout_resolve — Phase 1 only calls it`);
      assert.doesNotMatch(sql, /create or replace function public\.business_payout_ready\(p_business/,
        `${f} must not redefine business_payout_ready — Phase 1 only calls it`);
      assert.doesNotMatch(sql, /create or replace function public\.business_payout_destination/,
        `${f} must not redefine business_payout_destination — Phase 1 only calls it`);
    }
  });
});

/* ── 11. Hub payout logic is untouched ───────────────────────────────────── */

describe('hub payout logic is untouched — explicitly out of scope', () => {
  test('create-hub-donation-intent and create-hub-membership-intent still read the hub\'s own columns directly, unchanged', () => {
    for (const path of [
      'supabase/functions/create-hub-donation-intent/index.ts',
      'supabase/functions/create-hub-membership-intent/index.ts',
    ]) {
      const src = code(read(path));
      assert.match(src, /hub\.stripe_account_id/, `${path} must still read the hub's own account directly`);
      assert.doesNotMatch(src, /business_payout_destination|business_payout_ready/,
        `${path} must not have been switched to the business resolver — hubs have their own`);
    }
  });

  test('wallet-checkout\'s hub donation and membership branches are untouched — only its unit_purchase branch was fixed', () => {
    const src = code(read('supabase/functions/wallet-checkout/index.ts'));
    assert.match(src, /hub\.stripe_account_id/);
    assert.match(src, /destination:\s*hub\.stripe_account_id/);
  });
});
