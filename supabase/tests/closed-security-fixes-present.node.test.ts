/**
 * closed-security-fixes-present.node.test.ts — the source and the regression tests for every CLOSED security finding must stay in the repository.
 *
 * A fix that is live in production but whose migration, server code or tests have been dropped from git can be lost by the next rebuild.
 * This pins, per finding: its migration, the server code that depends on it, and the suites that prove it (registered to actually run).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const has = (p: string) => existsSync(join(ROOT, p));
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const runner = read('scripts/isolated-pg.mjs');
const pkgTest = read('package.json');

const FIXES: { name: string; migrations: string[]; code: string[]; isolated: string[]; hermetic: string[]; marker?: [string, RegExp] }[] = [
  { name: '1 email-table lockdown', migrations: ['20261115000000_email_tables_lock_down'], code: [], isolated: ['email-tables-lockdown'], hermetic: [] },
  { name: '2 forged event_ticket_orders / refund binding', migrations: ['20261116000000_event_ticket_orders_server_only', '20261007120000_business_wallet_refunds', '20261030000000_refund_releases_capacity'],
    code: ['_shared/ticket-payment-binding.ts', '_shared/fulfilment.ts', 'confirm-event-tickets/index.ts', 'refund-payment/index.ts', 'stripe-webhook/index.ts'], isolated: ['event-ticket-orders-server-only'], hermetic: ['ticket-payment-integrity'] },
  { name: '3 hub_members paid-tier protection', migrations: ['20261117000000_hub_members_server_authoritative', '20260929120000_hub_member_no_allocation'], code: [], isolated: ['hub-members-server-authoritative'], hermetic: [] },
  { name: '4 PaymentIntent / card-testing abuse controls', migrations: ['20261118000000_payment_start_abuse_limits', '20260821280000_rate_limits'],
    code: ['_shared/rate-limit.ts', '_shared/payment-failure-brake.ts', 'create-event-ticket-intent/index.ts', 'create-gift-intent/index.ts', 'create-product-order-intent/index.ts', 'stripe-webhook/index.ts'], isolated: ['payment-abuse-limits'], hermetic: ['payment-abuse-controls'] },
  { name: '5 wallet cash-out / self-payment', migrations: ['20260826200000_wallet_self_payment_guard'], code: ['_shared/self-payment.ts', 'create-event-ticket-intent/index.ts', 'create-gift-intent/index.ts', 'wallet-checkout/index.ts'], isolated: ['wallet-card-cashout'], hermetic: ['wallet-ticket-gift-self-payment'] },
  { name: '6 card self-payment to controlled accounts', migrations: ['20261119000000_self_payment_guard_covers_central_accounts'], code: ['_shared/self-payment.ts', 'authorise-payment/index.ts', 'create-hub-donation-intent/index.ts', 'create-unit-purchase-intent/index.ts', 'fetch-authorise/index.ts'], isolated: ['wallet-card-cashout'], hermetic: ['card-self-payment'] },
  { name: '7 product / gift duplicate-submit idempotency', migrations: ['20261120010000_purchase_attempt_idempotency'], code: ['_shared/purchase-attempt.ts', 'create-product-order-intent/index.ts', 'create-gift-intent/index.ts', 'confirm-gift/index.ts'], isolated: ['purchase-attempt-idempotency', 'purchase-attempt-handlers', 'purchase-attempt-baseline'], hermetic: [] },
  { name: '9 notification entity authorisation (seven notify-* functions)', migrations: [],
    code: ['_shared/shift-notify-auth.ts', '_shared/fetch-notify-auth.ts', '_shared/notify-decision.ts', '_shared/require-caller.ts', 'notify-application-update/index.ts', 'notify-shift-application/index.ts', 'notify-worker-checkin/index.ts', 'notify-shift-complete/index.ts', 'notify-matching-workers/index.ts', 'notify-drivers/index.ts', 'notify-collected/index.ts'],
    isolated: [], hermetic: ['notify-entity-authorisation'] },
  { name: '8 event / notice attribution', migrations: ['20261121000000_event_notice_attribution'], code: ['_shared/event-update-notify-auth.ts', 'delete-account/index.ts'], isolated: ['event-notice-attribution'], hermetic: ['notify-fanout-authz'] },
  { name: '10 Stripe customer ids not client-reachable (shift_employer_profiles.stripe_customer_id)', migrations: ['20261122000000_shift_employer_stripe_customer_lock'], code: [], isolated: ['stripe-customer-exposure'], hermetic: [] },
];

describe('every closed security finding is fully represented', () => {
  for (const f of FIXES) {
    test(f.name, () => {
      for (const m of f.migrations) assert.ok(has(`supabase/migrations/${m}.sql`), `migration ${m} is missing`);
      for (const c of f.code) assert.ok(has(`supabase/functions/${c}`), `server code ${c} is missing`);
      for (const t of f.isolated) {
        assert.ok(has(`supabase/tests/${t}.node.test.ts`), `isolated suite ${t} is missing`);
        assert.ok(runner.includes(`supabase/tests/${t}.node.test.ts`), `isolated suite ${t} is not registered in scripts/isolated-pg.mjs, so it would never run`);
      }
      for (const t of f.hermetic) {
        assert.ok(has(`supabase/tests/${t}.node.test.ts`), `suite ${t} is missing`);
        assert.ok(pkgTest.includes(`supabase/tests/${t}.node.test.ts`), `suite ${t} is not in the npm test script`);
      }
    });
  }
  test('the helpers the later fixes stand on exist: tg_is_server_write, enforcePaymentStart, selfPaymentBlock, attribution guards', () => {
    assert.match(read('supabase/migrations/20261007120000_business_wallet_refunds.sql'), /tg_is_server_write/);
    assert.match(read('supabase/functions/_shared/rate-limit.ts'), /export (async )?function enforcePaymentStart/);
    assert.match(read('supabase/functions/_shared/self-payment.ts'), /export (async )?function selfPaymentBlock/);
    assert.match(read('supabase/migrations/20261121000000_event_notice_attribution.sql'), /aa_events_attribution_guard[\s\S]*aa_notices_attribution_guard/);
  });
  test('the generic Stripe customer-id exposure guard exists and runs against the whole replayed schema', () => {
    assert.ok(has('scripts/lib/stripe-customer-exposure.mjs'));
    assert.match(read('scripts/migration-replay/replay.mjs'), /stripe-customer-exposure\.mjs[\s\S]*guard\.violations/);
  });
});
