/**
 * fetch-first-card.node.test.ts — a customer's very first card.
 *
 * Fix 5 turned up a dead end at the START of the Fetch payment rail:
 *
 *     if (!customerProfile?.stripe_customer_id) return 400
 *
 * A customer who had never paid for anything had no Stripe Customer, so a
 * driver's accept answered 400 BEFORE any PaymentIntent existed. That left a
 * matched delivery with no attempt, no intent, and — because Fix 2's cardless
 * recovery continues an intent that must ALREADY exist — no route back for the
 * customer at all. Measured on this database: 179 of 186 profiles have no
 * Stripe Customer. It was the ordinary case.
 *
 * The fix is not "create one if it is missing". The only place that had ever
 * created a Customer (create-setup-intent) did it as read-null → create →
 * write, with nothing holding the gap: two concurrent calls make two Customers
 * and orphan one. Copying that for Fetch would have doubled the defect, so
 * there is now ONE mechanism and create-setup-intent is moved onto it.
 *
 * The registry tests run against the real database inside transactions that are
 * always rolled back.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_ROOT  = join(REPO_ROOT, '..', 'oneshetland-web');
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*|\{\/\*).*$/gm, '');

const read    = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const readWeb = (p: string) => readFileSync(join(WEB_ROOT, p), 'utf8');

const migration = read('supabase/migrations/20260911120000_canonical_stripe_customer.sql');
const helper    = code(read('supabase/functions/_shared/stripe-customer.ts'));
const authorise = code(read('supabase/functions/authorise-payment/index.ts'));
const continueFn = code(read('supabase/functions/fetch-authorise/index.ts'));
const setupFn   = code(read('supabase/functions/create-setup-intent/index.ts'));
const panel     = code(readWeb('components/fetch/AuthorisePanel.tsx'));

/** Rolled back, always: the guard row makes an accidental commit impossible. */
function sql(body: string): Record<string, unknown>[] {
  const out = execFileSync('npx',
    ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${body}`, '--output-format', 'json'],
    { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 });
  const parsed = JSON.parse(out) as { rows?: Record<string, unknown>[]; error?: unknown };
  if (parsed.error) throw new Error(JSON.stringify(parsed.error).slice(0, 300));
  return parsed.rows ?? [];
}

const U1 = '11111111-bbbb-1111-1111-111111111111';
const U2 = '22222222-bbbb-2222-2222-222222222222';

const users = `
begin;
  insert into auth.users (id, email) values
    ('${U1}', 'firstcard-1@probe.invalid'), ('${U2}', 'firstcard-2@probe.invalid');
`;

/* ─────────────────── 1. The dead end, and its replacement ───────────────── */

describe('a first-time customer is no longer a dead end', () => {
  test('the 400 that stranded the delivery is gone', () => {
    assert.ok(!/Customer has no payment method on file/.test(authorise),
      'the driver is still told the customer has no card, before any intent exists');
  });

  test('the Customer is established before the authorisation is claimed', () => {
    const est = authorise.indexOf('canonicalStripeCustomer(');
    const claim = authorise.indexOf("rpc('claim_fetch_authorisation'");
    assert.ok(est > 0, 'nothing establishes a Stripe Customer on the Fetch path');
    assert.ok(est < claim, 'the Customer must exist before the intent is claimed');
  });

  test('and only after the driver has been proven', () => {
    const guard = authorise.indexOf("Forbidden — not the assigned driver");
    assert.ok(guard > 0 && guard < authorise.indexOf('canonicalStripeCustomer('),
      'a stranger must not be able to make Stripe Customers for other people');
  });

  test('a Customer that cannot be established refuses rather than half-proceeding', () => {
    assert.match(authorise, /customer\.kind === 'pending'[\s\S]{0,300}CUSTOMER_IN_FLIGHT/);
    assert.match(authorise, /customer\.kind === 'error'[\s\S]{0,300}CUSTOMER_UNAVAILABLE/);
    assert.ok(authorise.indexOf('CUSTOMER_UNAVAILABLE') < authorise.indexOf("rpc('claim_fetch_authorisation'"),
      'no attempt row is claimed on behalf of a customer we could not set up');
  });
});

/* ───────────────────── 2. One user, one Stripe Customer ─────────────────── */

describe('the customer registry decides, not a read-then-write', () => {
  test('creation is claimed exactly once', () => {
    const [row] = sql(users + `
  create temp table _o on commit drop as
    select (public.claim_stripe_customer('${U1}'::uuid)).*;
  select outcome, coalesce(stripe_customer_id, 'none') as cust from _o;
rollback;`);
    assert.equal(row.outcome, 'claimed');
    assert.equal(row.cust, 'none');
  });

  test('twenty simultaneous callers produce exactly one creator', () => {
    const [row] = sql(users + `
  create temp table _o on commit drop as
    select (public.claim_stripe_customer('${U1}'::uuid)).* from generate_series(1, 20);
  select (select count(*) from _o where outcome = 'claimed')::int    as claimed,
         (select count(*) from _o where outcome = 'in_flight')::int  as in_flight,
         (select count(*) from public.stripe_customer_claims where user_id = '${U1}')::int as rows;
rollback;`);
    assert.equal(row.claimed, 1, 'exactly one caller may create the Customer');
    assert.equal(row.in_flight, 19, 'the rest are asked to wait rather than racing');
    assert.equal(row.rows, 1, 'one registry row, for ever');
  });

  test('once settled, every later caller is handed the same Customer', () => {
    const [row] = sql(users + `
  select public.claim_stripe_customer('${U1}'::uuid);
  select public.settle_stripe_customer('${U1}'::uuid, 'cus_probe_one', null);
  create temp table _o on commit drop as
    select (public.claim_stripe_customer('${U1}'::uuid)).* from generate_series(1, 5);
  select (select count(distinct stripe_customer_id) from _o)::int as distinct_ids,
         (select count(*) from _o where outcome = 'bound')::int   as bound,
         (select stripe_customer_id from public.profiles where id = '${U1}') as on_profile;
rollback;`);
    assert.equal(row.distinct_ids, 1);
    assert.equal(row.bound, 5);
    assert.equal(row.on_profile, 'cus_probe_one', 'the profile is kept in step');
  });

  test('an existing profile binding always wins, and is adopted', () => {
    const [row] = sql(users + `
  update public.profiles set stripe_customer_id = 'cus_probe_existing' where id = '${U1}';
  create temp table _o on commit drop as select (public.claim_stripe_customer('${U1}'::uuid)).*;
  select o.outcome, o.stripe_customer_id as cust,
         (select status from public.stripe_customer_claims where user_id = '${U1}') as claim_status
    from _o o;
rollback;`);
    assert.equal(row.outcome, 'bound');
    assert.equal(row.cust, 'cus_probe_existing');
    assert.equal(row.claim_status, 'bound', 'the registry adopts it rather than racing it');
  });

  test('a second, different Customer for one user is refused, not chosen between', () => {
    const [row] = sql(users + `
  select public.claim_stripe_customer('${U1}'::uuid);
  select public.settle_stripe_customer('${U1}'::uuid, 'cus_probe_one', null);
  do $p$ begin
    perform public.settle_stripe_customer('${U1}'::uuid, 'cus_probe_TWO', null);
  exception when others then null; end $p$;
  select stripe_customer_id as cust from public.stripe_customer_claims where user_id = '${U1}';
rollback;`);
    assert.equal(row.cust, 'cus_probe_one', 'the first Customer is never orphaned by a second');
  });

  test('a settle that carries no id cannot erase the one that makes recovery possible', () => {
    const [row] = sql(users + `
  select public.claim_stripe_customer('${U1}'::uuid);
  select public.settle_stripe_customer('${U1}'::uuid, 'cus_probe_one', null);
  select public.settle_stripe_customer('${U1}'::uuid, null, 'a later failure');
  select stripe_customer_id as cust, status from public.stripe_customer_claims where user_id = '${U1}';
rollback;`);
    assert.equal(row.cust, 'cus_probe_one');
    assert.equal(row.status, 'bound');
  });

  test('two people cannot share one Stripe Customer', () => {
    const [row] = sql(users + `
  select public.claim_stripe_customer('${U1}'::uuid);
  select public.settle_stripe_customer('${U1}'::uuid, 'cus_probe_shared', null);
  select public.claim_stripe_customer('${U2}'::uuid);
  do $p$ begin
    perform public.settle_stripe_customer('${U2}'::uuid, 'cus_probe_shared', null);
  exception when others then null; end $p$;
  select (select count(*) from public.profiles
           where stripe_customer_id = 'cus_probe_shared')::int as holders;
rollback;`);
    assert.equal(row.holders, 1, 'a Stripe Customer belongs to exactly one person');
  });

  test('the registry was seeded from the bindings that already existed', () => {
    const [row] = sql(`
      select (select count(*) from public.profiles where stripe_customer_id is not null)::int as bound_profiles,
             (select count(*) from public.stripe_customer_claims c
                join public.profiles p on p.id = c.user_id
               where p.stripe_customer_id = c.stripe_customer_id)::int as seeded;`);
    assert.equal(row.seeded, row.bound_profiles,
      'an existing customer must never "claim" creation and get a second Customer');
  });
});

/* ─────────────────── 3. Recovering rather than duplicating ──────────────── */

describe('a Customer created by a process that then died', () => {
  test('the metadata lookup runs before anything is created', () => {
    assert.ok(helper.indexOf('findByMetadata') < helper.indexOf(`${'`'}${'$'}{STRIPE}/customers${'`'}`),
      'an orphan must be recovered before a second Customer is made');
  });

  test('creation carries a deterministic idempotency key', () => {
    assert.match(helper, /Idempotency-Key['"]?\]?:\s*`oneshetland-customer-\$\{userId\}`/);
    assert.ok(!/Date\.now\(\)|Math\.random\(\)|crypto\.randomUUID/.test(helper),
      'nothing time-based or random may appear in the key');
  });

  test('an ambiguous metadata search binds nobody', () => {
    const fn = helper.slice(helper.indexOf('async function findByMetadata'));
    assert.match(fn, /rows\.length !== 1/);
    assert.match(fn, /return null/);
  });

  test('the search is a recovery, never the identity', () => {
    // Stripe documents its search index as unsuitable for read-after-write and
    // normally under a minute behind, so a miss proves nothing.
    assert.ok(helper.indexOf("rpc('claim_stripe_customer'") < helper.indexOf('await findByMetadata('),
      'the durable claim is taken before Stripe is asked anything');
  });

  test('the id is recorded before anything else can fail', () => {
    const create = helper.slice(helper.indexOf(`${'`'}${'$'}{STRIPE}/customers${'`'}`));
    assert.ok(create.indexOf("settle_stripe_customer") < create.indexOf("return { kind: 'ok'"),
      'a function that dies after creating must retry into the same Customer');
  });
});

/* ─────────────────────── 4. What the customer then does ─────────────────── */

describe('the first card goes on the intent that already exists', () => {
  test('no card means an unconfirmed intent, not a refusal', () => {
    assert.match(authorise, /if \(paymentMethodId\) \{[\s\S]{0,160}piBody\.confirm = 'true';/);
    assert.ok(!/confirm: 'true'[\s\S]{0,80}\n\s*\};/.test(authorise),
      'the intent must not be confirmed when there is no card to confirm against');
  });

  test('the truthful state is stored, and it is not "failed"', () => {
    const truth = code(read('supabase/functions/_shared/fetch-authorisation.ts'));
    assert.match(truth, /case 'requires_payment_method': return 'requires_payment_method'/);
    assert.ok(!/case 'requires_payment_method':\s*return 'failed'/.test(truth),
      'a first card is not a failure');
  });

  test('the customer completes THAT intent — no second one', () => {
    const serveBody = continueFn.slice(0, continueFn.indexOf('async function reauthorise'));
    assert.match(serveBody, /client_secret:\s*pi\.client_secret/);
    assert.ok(!/method: 'POST'[\s\S]{0,200}payment_intents/.test(serveBody));
  });

  test('the panel offers the card entry without a detour to Account', () => {
    assert.match(panel, /Add a card/);
    assert.match(panel, /<PaymentCheckout/);
    assert.ok(!/\/account|create-setup-intent/.test(panel),
      'the customer must not be sent somewhere else to add their first card');
  });

  test('SCA on that first card stays on the same intent', () => {
    assert.match(panel, /onPaid=\{async \(\) => \{ setPaying\(false\); await check\(true\); \}\}/);
    const serveBody = continueFn.slice(0, continueFn.indexOf('async function reauthorise'));
    assert.match(serveBody, /request\.payment_intent_id/);
    assert.ok(!/body\?\.payment_intent_id/.test(serveBody), 'a caller can name an intent');
  });

  test('a customer who already has a card is unaffected', () => {
    assert.match(authorise, /defaultCardFor\(stripeKey, stripeCustomerId\)/);
    assert.match(authorise, /piBody\.payment_method = paymentMethodId;/);
  });

  test('the global saved-card policy is untouched', () => {
    assert.ok(!/setup_future_usage/.test(authorise) && !/setup_future_usage/.test(continueFn),
      'cards are saved by create-setup-intent, and that policy is not changed here');
  });
});

/* ───────────────────────── 5. Identity and boundaries ───────────────────── */

describe('whose Customer it is', () => {
  test('the Fetch Customer is the delivery customer\'s, never the caller\'s', () => {
    const block = authorise.slice(authorise.indexOf('canonicalStripeCustomer({'));
    assert.match(block, /userId: request\.customer_id/);
    assert.ok(!/userId: user\.id/.test(block), 'the driver must not get their own Customer charged');
  });

  test('no caller can name a Stripe Customer', () => {
    for (const [name, src] of [['authorise-payment', authorise], ['fetch-authorise', continueFn]] as const) {
      assert.ok(!/body\??\.\s*(stripe_)?customer(_id)?\b/.test(src), `${name} reads a customer id from the body`);
    }
    // The helper's INPUT is a user. It returns a customer id; it never accepts one.
    const signature = helper.slice(helper.indexOf('export async function canonicalStripeCustomer'),
                                   helper.indexOf('}): Promise<CustomerResult>'));
    assert.match(signature, /userId: string/);
    assert.ok(!/customerId|customer_id/.test(signature), 'the helper takes a user, not a customer id');
  });

  test('the registry is server-only', () => {
    const [row] = sql(`
      select relrowsecurity as rls,
             (select count(*)::int from pg_policies
               where schemaname='public' and tablename='stripe_customer_claims') as policies,
             has_table_privilege('authenticated','public.stripe_customer_claims','select') as auth_read,
             has_table_privilege('anon','public.stripe_customer_claims','insert')          as anon_write
        from pg_class where oid = 'public.stripe_customer_claims'::regclass;`);
    assert.equal(row.rls, true);
    assert.equal(row.policies, 0, 'RLS on with no policy: clients match nothing');
    assert.equal(row.auth_read, false);
    assert.equal(row.anon_write, false);
  });

  test('the customer RPCs are service-role only', () => {
    const rows = sql(`
      select p.proname as fn,
             coalesce(has_function_privilege('authenticated', p.oid, 'execute'), false) as auth_can,
             coalesce(has_function_privilege('anon', p.oid, 'execute'), false)          as anon_can,
             coalesce(has_function_privilege('service_role', p.oid, 'execute'), false)  as svc_can
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname in ('claim_stripe_customer', 'settle_stripe_customer');`);
    assert.equal(rows.length, 2);
    for (const r of rows) {
      assert.equal(r.auth_can, false, `${r.fn} must not be callable by a signed-in client`);
      assert.equal(r.anon_can, false, `${r.fn} must not be callable anonymously`);
      assert.equal(r.svc_can, true);
    }
  });

  test('a client still cannot bind a Stripe Customer to themselves', () => {
    const [row] = sql(users + `
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"${U1}","role":"authenticated"}';
  do $p$ begin
    update public.profiles set stripe_customer_id = 'cus_attacker' where id = '${U1}';
  exception when others then null; end $p$;
  reset role;
  select coalesce(stripe_customer_id, 'none') as cust from public.profiles where id = '${U1}';
rollback;`);
    assert.equal(row.cust, 'none', 'stripe_customer_id remains the server\'s');
  });
});

/* ──────────────────── 6. Fixes 1–5 are not disturbed ────────────────────── */

describe('the guarantees this sits on top of', () => {
  test('one delivery still means one PaymentIntent', () => {
    assert.match(authorise, /rpc\('claim_fetch_authorisation'/);
    assert.match(authorise, /Idempotency-Key.*fetch-auth-\$\{request_id\}/s);
    assert.ok(authorise.indexOf("rpc('claim_fetch_authorisation'") < authorise.indexOf("fetch('https://api.stripe.com/v1/payment_intents'"),
      'the intent is still created only inside the claim');
  });

  test('re-authorisation reuses the canonical Customer, not a new one per generation', () => {
    const reauth = continueFn.slice(continueFn.indexOf('async function reauthorise'));
    assert.match(reauth, /canonicalStripeCustomer\(\{/);
    assert.match(reauth, /customer: stripeCustomerId,/);
    assert.match(reauth, /Idempotency-Key.*fetch-auth-\$\{request\.id\}-g\$\{generation\}/s);
  });

  test('the frozen commercial terms are still the ones re-authorisation uses', () => {
    const reauth = continueFn.slice(continueFn.indexOf('async function reauthorise'));
    assert.match(reauth, /attempt\.service_fee_pence/);
    assert.ok(!/getCommissionConfig|calculateCommission|delivery_pricing_config/.test(reauth));
  });

  test('card setup was moved onto the one mechanism, not given a second', () => {
    assert.match(setupFn, /canonicalStripeCustomer\(\{/);
    const personal = setupFn.slice(setupFn.indexOf('} else {'));
    assert.ok(!/api\.stripe\.com\/v1\/customers'/.test(personal),
      'the personal-card branch must not create Customers of its own any more');
  });

  test('exactly one module creates a PERSONAL Stripe Customer', () => {
    // Every POST to the customers collection, in either spelling.
    const creators = execFileSync('grep',
      ['-rlE', "(api\\.stripe\\.com/v1|\\$\\{STRIPE\\})/customers'|\\$\\{STRIPE\\}/customers`",
       'supabase/functions', '--include=*.ts'],
      { cwd: REPO_ROOT, encoding: 'utf8' }).trim().split('\n').filter(Boolean).sort();
    assert.deepEqual(creators, [
      'supabase/functions/_shared/stripe-customer.ts',
      // create-setup-intent still creates a BUSINESS-scoped Customer, which is a
      // different model on a different table
      // (local_businesses.business_stripe_customer_id) and out of scope here.
      // Its personal branch no longer creates anything of its own.
      'supabase/functions/create-setup-intent/index.ts',
    ], 'a second personal-customer model has appeared');

    const personal = setupFn.slice(setupFn.indexOf('} else {'));
    assert.ok(!/\/v1\/customers'/.test(personal) && !/\$\{STRIPE\}\/customers/.test(personal),
      'the personal branch must create no Customer of its own');
  });
});
