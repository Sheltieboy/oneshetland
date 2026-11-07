/**
 * OneShetland Launch 50: source-level contract for the checkout, webhook, plan-change guard and reminder function, plus the migration's
 * privilege and counting rules. No network, no database. The behaviour itself is proven by the rolled-back production test recorded in
 * docs (limit of 50, expiry, replays, phases, privileges) and by the Stripe-side configuration check.
 * Run: node --test supabase/tests/launch50-contract.node.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const intent = read('supabase/functions/local-subscription-intent/index.ts');
const webhook = read('supabase/functions/stripe-webhook/index.ts');
const change = read('supabase/functions/local-subscription-change/index.ts');
const reminders = read('supabase/functions/launch50-reminders/index.ts');
const mig = read('supabase/migrations/20261230080000_launch50.sql');

describe('checkout (local-subscription-intent)', () => {
  test('Launch 50 is opt-in and never changes the standard path', () => {
    assert.match(intent, /launch50 = false \} = await req\.json\(\)/);
    assert.match(intent, /if \(launch50 === true\)/);
    assert.match(intent, /\.\.\.\(launch50CouponId \? \{ discounts: \[\{ coupon: launch50CouponId \}\] \} : \{\}\)/);
    assert.match(intent, /\.\.\.\(launch50CouponId \? \{ launch50: '1' \} : \{\}\)/);
  });
  test('fails closed: monthly only, configured + verified coupon (amount, currency, repeating, 12 months), live reservation', () => {
    assert.match(intent, /LAUNCH50_MONTHLY_ONLY/);
    assert.match(intent, /stripe\.coupon\.launch50_\$\{tier\}/);
    assert.match(intent, /const wantOff = tier === 'pro' \? 300 : 700/);
    assert.match(intent, /c\.valid === true && c\.amount_off === wantOff && c\.currency === 'gbp' && c\.duration === 'repeating' && c\.duration_in_months === 12/);
    assert.match(intent, /launch50_begin_checkout/);
    assert.match(intent, /LAUNCH50_NO_PLACE/);
  });
  test('order: coupon verified and place held immediately BEFORE the subscription is created; place returned if creation throws', () => {
    const iCoupon = intent.indexOf('launch50_begin_checkout'), iCreate = intent.indexOf('subscription = await stripe.subscriptions.create(');
    assert.ok(iCoupon > 0 && iCreate > iCoupon);
    assert.match(intent, /catch \(createErr\) \{[\s\S]*launch50_abort_checkout[\s\S]*throw createErr;/);
    assert.match(intent, /launch50_attach_subscription/);
  });
  test('idempotency key and attempt registry still decide duplicates (Launch 50 adds a suffix, nothing else)', () => {
    assert.match(intent, /idempotencyKey: `local-sub-\$\{user\.id\}-\$\{business_id\}-\$\{tier\}-\$\{period_norm\}-\$\{client_request_id\}\$\{launch50CouponId \? '-l50' : ''\}`/);
    assert.match(intent, /claim_subscription_attempt/);
    assert.match(intent, /assertPriceMatches/);
  });
});

describe('webhook (stripe-webhook)', () => {
  test('activation requires our launch50 metadata, an active subscription and the CONFIGURED coupon verified at Stripe', () => {
    assert.match(webhook, /meta\.launch50 === '1' && metaBusiness/);
    assert.match(webhook, /stripe\.coupon\.launch50_\$\{tier\}/);
    assert.match(webhook, /couponId === expected/);
    assert.match(webhook, /'Stripe-Version': '2023-10-16'/);
    assert.match(webhook, /launch50_activate/);
    assert.match(webhook, /place NOT activated/);
  });
  test('the hook can never fail the webhook or the existing tier logic', () => {
    assert.match(webhook, /launch50 hook failed/);
    assert.match(webhook, /launch50 end hook failed/);
    const a = webhook.indexOf("apply_subscription_state"), l = webhook.indexOf('launch50_activate');
    assert.ok(l > a, 'tier handling runs first');
  });
  test('cancelled / never-started subscriptions end or release the place', () => {
    assert.match(webhook, /\['canceled', 'incomplete_expired', 'unpaid'\]\.includes\(status\)/);
    assert.match(webhook, /launch50_subscription_ended/);
  });
});

describe('plan changes and reminders', () => {
  test('plan changes are refused while a place is active or held', () => {
    assert.match(change, /launch50_blocks_plan_change/);
    assert.match(change, /LAUNCH50_PLAN_LOCKED/);
    assert.ok(change.indexOf('LAUNCH50_PLAN_LOCKED') < change.indexOf('NO_EXISTING_SUBSCRIPTION'));
  });
  test('the reminder is cron-authenticated, stamped only after an accepted send, and shows the right prices', () => {
    assert.match(reminders, /requireCronSecret\(req, \{\}\)/);
    assert.match(reminders, /res\.ok && !res\.skipped/);
    assert.match(reminders, /pro: \{ label: 'Pro', founding: '£9', standard: '£12' \}/);
    assert.match(reminders, /premium: \{ label: 'Premium', founding: '£22', standard: '£29' \}/);
  });
});

describe('migration', () => {
  test('writes only through functions: no client privileges on the table beyond owner SELECT', () => {
    assert.match(mig, /revoke all on public\.launch50_places from public, anon, authenticated;\s*grant select on public\.launch50_places to authenticated;/);
    assert.match(mig, /create policy launch50_owner_read[\s\S]*owner_id = auth\.uid\(\)/);
  });
  test('server-only functions are service_role only; owner functions are authenticated only; summary/showcase are public', () => {
    assert.match(mig, /grant execute on function public\.launch50_begin_checkout[\s\S]*launch50_mark_reminded\(uuid\) to service_role/);
    assert.match(mig, /grant execute on function public\.launch50_reserve\(uuid, text, boolean\) to authenticated/);
    assert.match(mig, /grant execute on function public\.launch50_status\(\) to anon, authenticated, service_role/);
    assert.match(mig, /grant execute on function public\.launch50_showcase\(\) to anon, authenticated, service_role/);
  });
  test('the limit is one decision at a time and counts completed memberships permanently', () => {
    assert.match(mig, /pg_advisory_xact_lock\(50505050\)/);
    assert.match(mig, /status in \('pending_payment', 'active', 'ended'\) or \(status = 'reserved' and reservation_expires_at > now\(\)\)/);
    assert.match(mig, /if public\.launch50_used\(\) >= 50 then raise exception 'All 50 places are taken\./);
  });
  test('off by default: closed unless launch50.enabled = on and opens_at has passed; 14-day first access for already-claimed listings', () => {
    assert.match(mig, /v_on is distinct from 'on' then return 'closed'/);
    assert.match(mig, /now\(\) < v_open \+ interval '14 days' then return 'claimed_only'/);
    assert.match(mig, /b\.owner_activated_at is null or b\.owner_activated_at >= v_open/);
  });
  test('the showcase never exposes the tier and has no ranking', () => {
    const fn = mig.slice(mig.indexOf('create or replace function public.launch50_showcase'));
    assert.ok(!/\btier\b/.test(fn.split('language sql')[0]));
    assert.match(fn, /order by md5\(b\.id::text \|\| current_date::text\)/);
  });
});
