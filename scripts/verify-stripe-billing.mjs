#!/usr/bin/env node
/**
 * READ-ONLY billing check. Makes GET requests only: it cannot charge, refund, create or change anything.
 *
 *   STRIPE_SECRET_KEY=sk_live_...  node scripts/verify-stripe-billing.mjs      # the mode customers pay in
 *   STRIPE_SECRET_KEY=sk_test_...  node scripts/verify-stripe-billing.mjs      # sandbox
 *   (or: `stripe login` then: STRIPE_SECRET_KEY=$(stripe config --list ...) is NOT needed; just pass a read-only restricted key)
 *
 * Reads the four configured Price ids from production admin_config (via the linked supabase CLI), then for each Price checks that it
 * exists in THIS mode, is active, the amount matches what the website advertises, and prints interval/usage/tax behaviour.
 * Also lists the webhook endpoints and whether they subscribe to every event the subscription lifecycle needs.
 */
import { execFileSync } from 'node:child_process';

const KEY = process.env.STRIPE_SECRET_KEY;
if (!KEY) { console.error('Set STRIPE_SECRET_KEY (a read-only restricted key is enough).'); process.exit(2); }
const mode = KEY.startsWith('sk_live') || KEY.startsWith('rk_live') ? 'LIVE' : 'TEST';

const get = async (path) => {
  const r = await fetch('https://api.stripe.com/v1/' + path, { headers: { Authorization: `Bearer ${KEY}` } });
  return { status: r.status, body: await r.json() };
};

const sql = "select key, value from admin_config where key in ('stripe.price.local_pro','stripe.price.local_premium','stripe.price.local_premium_annual','stripe.price.booking_meter')";
const out = execFileSync('supabase', ['db', 'query', '--linked', sql, '-o', 'json'], { encoding: 'utf8' });
const rows = JSON.parse(out.slice(out.indexOf('{'))).rows;

const EXPECT = { 'stripe.price.local_pro': 1200, 'stripe.price.local_premium': 2900, 'stripe.price.local_premium_annual': 29000, 'stripe.price.booking_meter': null };
console.log(`Checking in ${mode} mode\n`);
let problems = 0;
for (const { key, value } of rows) {
  const { status, body: p } = await get('prices/' + value);
  if (status !== 200) { console.log(`✗ ${key} ${value}: not found in ${mode} mode (${p.error?.message ?? status})`); problems++; continue; }
  const want = EXPECT[key];
  const amountOk = want == null ? true : p.unit_amount === want;
  const flags = [];
  if (!p.active) flags.push('INACTIVE');
  if (!amountOk) flags.push(`AMOUNT ${p.unit_amount} != advertised ${want}`);
  if (p.currency !== 'gbp') flags.push('CURRENCY ' + p.currency);
  if (p.livemode !== (mode === 'LIVE')) flags.push('MODE MISMATCH');
  console.log(`${flags.length ? '✗' : '✓'} ${key}: ${p.unit_amount ?? '(metered)'} ${p.currency} / ${p.recurring?.interval ?? 'one-off'} usage=${p.recurring?.usage_type ?? '-'} tax_behavior=${p.tax_behavior} livemode=${p.livemode} ${flags.join(' ')}`);
  if (flags.length) problems++;
}

const wh = await get('webhook_endpoints?limit=20');
console.log('\nWebhook endpoints:');
const need = ['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'invoice.payment_succeeded', 'invoice.payment_failed'];
for (const e of wh.body.data ?? []) {
  const have = new Set(e.enabled_events);
  const all = have.has('*');
  const missing = need.filter((n) => !all && !have.has(n));
  console.log(`  ${e.status === 'enabled' ? '✓' : '✗'} ${e.url} [${e.status}] ${missing.length ? 'MISSING: ' + missing.join(', ') : 'has all lifecycle events'}`);
  if (e.status !== 'enabled' || missing.length) problems++;
}
if (!(wh.body.data ?? []).length) { console.log('  ✗ none found'); problems++; }

const tax = await get('tax/settings');
console.log('\nStripe Tax settings:', tax.status === 200 ? JSON.stringify({ status: tax.body.status, defaults: tax.body.defaults }) : 'not readable / not enabled');
console.log(problems ? `\n${problems} problem(s) found.` : '\nAll checks passed.');
process.exit(problems ? 1 : 0);
