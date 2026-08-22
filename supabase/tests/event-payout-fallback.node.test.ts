/**
 * event-payout-fallback.node.test.ts — a business inherits its owner's bank.
 *
 * WHAT WAS WRONG
 *
 * The mobile event screen decided whether to offer a Buy button with:
 *
 *     const payoutReady = !!(event.business as any)?.payout_enabled;
 *
 * That asks only whether the BUSINESS has its own connected Stripe account. The
 * product model — stated on the Payments & banking screen — is that a business
 * uses its owner's central card and bank unless explicitly given its own. So a
 * real organiser with a working central Connect account, running an event
 * through a business that inherits it, was shown "Tickets coming soon".
 *
 * create-event-ticket-intent had ALWAYS resolved this correctly and would have
 * taken the money. Only the button refused. The two now share one resolver, so
 * they cannot drift apart again.
 *
 * WHY IT LIVES IN SQL
 *
 * profiles RLS is own-row-only: a BUYER cannot read the organiser's payout state
 * at all, so no client-side logic could ever have computed this.
 *
 * WHAT IS ASSERTED
 *   · a business with no payout of its own inherits its owner's central account
 *   · a business given its own payout account overrides the owner's
 *   · neither configured → not purchasable
 *   · a wholly free event needs no payout route
 *   · the client-facing function returns a boolean and nothing else, and the one
 *     that returns an account id is unreachable from a client
 *   · both account screens derive card/payout state the same way
 *   · the buyer's card is resolved from the buyer, never from the organiser
 *
 * SAFETY
 * Every fixture is created inside a transaction that is never committed. No
 * Stripe call, no PaymentIntent, no money, no production row.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_ROOT = join(REPO_ROOT, '..', 'oneshetland-web');
const read = (p: string) => readFileSync(p, 'utf8');

function rowsOf(out: string): Record<string, unknown>[] {
  const p = JSON.parse(out) as { rows?: Record<string, unknown>[]; _tag?: string; error?: unknown };
  if (p._tag === 'Error' || p.error) throw new Error(`db query error: ${JSON.stringify(p.error).slice(0, 300)}`);
  return p.rows ?? [];
}
const runSql = (sql: string) => rowsOf(execFileSync('npx',
  ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${sql}`, '--output-format', 'json'],
  { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 }));
const one = (sql: string) => runSql(sql)[0] ?? {};

/**
 * Builds four organiser shapes as synthetic rows, asks the resolver about each,
 * and rolls the lot back.
 *
 * The owner's central account is put on profiles for the inherit case and the
 * business's own on local_businesses for the override case, so the two paths are
 * distinguishable by which account id comes back.
 */
const SCENARIOS = `
begin;
create temp table t(label text, ready boolean, dest text, free boolean);
do $$
declare
  u_inherit uuid; u_override uuid; u_none uuid;
  b_inherit uuid; b_override uuid; b_none uuid;
  e_inherit uuid; e_override uuid; e_none uuid; e_free uuid;
  r record;
begin
  select id into u_inherit  from auth.users order by created_at limit 1;
  select id into u_override from auth.users order by created_at desc limit 1;
  u_none := u_inherit;

  -- Owner with a working central account (the inherit case).
  update public.profiles
     set stripe_account_id = 'acct_test_owner_central', stripe_payouts_enabled = true
   where id = u_inherit;

  -- Owner with nothing anywhere (the unconfigured case). Cleared explicitly
  -- because a real account on this row would make the business inherit one —
  -- which is the resolver behaving correctly, and would hide the case under test.
  update public.profiles
     set stripe_account_id = null, stripe_payouts_enabled = false
   where id = u_override;
  update public.driver_profiles
     set stripe_account_id = null, stripe_payouts_enabled = false
   where id = u_override;

  b_inherit := gen_random_uuid(); b_override := gen_random_uuid(); b_none := gen_random_uuid();
  insert into public.local_businesses (id, name, category, address, slug, owner_id, use_business_payout, payout_enabled, stripe_account_id)
  values (b_inherit,  'T Inherit',  'other', 'Lerwick', 't-inherit-'||left(b_inherit::text,8),  u_inherit,  false, false, null),
         (b_override, 'T Override', 'other', 'Lerwick', 't-override-'||left(b_override::text,8), u_inherit, true,  true,  'acct_test_business_own'),
         (b_none,     'T None',     'other', 'Lerwick', 't-none-'||left(b_none::text,8),         u_override, false, false, null);

  e_inherit := gen_random_uuid(); e_override := gen_random_uuid(); e_none := gen_random_uuid(); e_free := gen_random_uuid();
  insert into public.events (id, title, status, organiser_business_id, starts_at, has_tickets)
  values (e_inherit,  'T inherit ev',  'published', b_inherit,  now() + interval '7 days', true),
         (e_override, 'T override ev', 'published', b_override, now() + interval '7 days', true),
         (e_none,     'T none ev',     'published', b_none,     now() + interval '7 days', true),
         (e_free,     'T free ev',     'published', b_none,     now() + interval '7 days', true);

  insert into public.event_ticket_types (id, event_id, name, price_pence, is_active)
  values (gen_random_uuid(), e_inherit,  'Std', 1000, true),
         (gen_random_uuid(), e_override, 'Std', 1000, true),
         (gen_random_uuid(), e_none,     'Std', 1000, true),
         (gen_random_uuid(), e_free,     'Free',   0, true);

  for r in
    select 'inherit'  as label, e_inherit  as id union all
    select 'override', e_override            union all
    select 'none',     e_none                union all
    select 'free',     e_free
  loop
    insert into t
    select r.label, public.event_payout_ready(r.id), d.account_id, d.all_free
      from public.event_payout_destination(r.id) d;
  end loop;
end $$;
select label, ready, coalesce(dest,'(none)') as dest, free from t order by label;
`;

let cached: Record<string, { ready: boolean; dest: string; free: boolean }> | null = null;
function scenarios() {
  if (!cached) {
    cached = {};
    for (const r of runSql(SCENARIOS)) {
      cached[String(r.label)] = {
        ready: r.ready === true || r.ready === 't',
        dest: String(r.dest),
        free: r.free === true || r.free === 't',
      };
    }
  }
  return cached;
}

// ── 1. The rule ─────────────────────────────────────────────────────────────

describe('a business inherits its owner’s bank unless given its own', () => {
  test('central payout only — the business inherits it', () => {
    const s = scenarios().inherit;
    assert.equal(s.ready, true, 'an organiser with a working central account can sell');
    assert.equal(s.dest, 'acct_test_owner_central', 'the money must go to the owner’s central account');
  });

  test('business-specific payout overrides the central one', () => {
    const s = scenarios().override;
    assert.equal(s.ready, true);
    assert.equal(s.dest, 'acct_test_business_own',
      'business revenue must not be routed to the owner when the business has its own account');
  });

  test('neither configured — not purchasable', () => {
    const s = scenarios().none;
    assert.equal(s.ready, false);
    assert.equal(s.dest, '(none)');
  });

  test('a wholly free event needs no payout route at all', () => {
    const s = scenarios().free;
    assert.equal(s.free, true);
    assert.equal(s.ready, true, 'free tickets move no money, so payout setup is irrelevant');
  });
});

// ── 2. The gate uses it, and leaks nothing ─────────────────────────────────

describe('the ticket gate and the charge agree', () => {
  test('the mobile gate asks the resolver, not the business row', () => {
    const src = read(join(REPO_ROOT, 'app', 'events', '[id].tsx'));
    assert.match(src, /event\.payout_ready === true/, 'the gate must use the resolved flag');
    assert.ok(!/business as any\)\?\.payout_enabled/.test(src),
      'the old business-only check must be gone, not merely supplemented');
  });

  test('the event fetch resolves it server-side', () => {
    const src = read(join(REPO_ROOT, 'lib', 'events-api.ts'));
    assert.match(src, /rpc\('event_payout_ready'/);
  });

  test('the charge resolves its destination from the same function', () => {
    const src = read(join(REPO_ROOT, 'supabase', 'functions', 'create-event-ticket-intent', 'index.ts'));
    assert.match(src, /rpc\('event_payout_destination'/,
      'the Edge Function must share the resolver so button and charge cannot drift');
  });

  test('clients get a boolean; the account id is server-only', () => {
    const r = one(`
      select
        (select case when has_function_privilege('anon', p.oid, 'EXECUTE') then 'yes' else 'no' end
           from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          where n.nspname='public' and p.proname='event_payout_ready')            as ready_anon,
        (select case when has_function_privilege('authenticated', p.oid, 'EXECUTE') then 'yes' else 'no' end
           from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          where n.nspname='public' and p.proname='event_payout_destination')      as dest_authd,
        (select case when has_function_privilege('anon', p.oid, 'EXECUTE') then 'yes' else 'no' end
           from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          where n.nspname='public' and p.proname='_event_payout_resolve')         as resolve_anon,
        (select coalesce(array_to_string(p.proconfig, ','), '')
           from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          where n.nspname='public' and p.proname='_event_payout_resolve')         as cfg;`);
    assert.equal(r.ready_anon, 'yes', 'the public gate must be callable by a signed-out viewer');
    assert.equal(r.dest_authd, 'no', 'a function returning acct_… must not be client-callable');
    assert.equal(r.resolve_anon, 'no');
    assert.match(String(r.cfg), /search_path=/, 'a SECURITY DEFINER resolver needs a pinned search_path');
  });
});

// ── 3. The account screens agree ───────────────────────────────────────────

describe('My Account and Manage report the same state', () => {
  test('one derivation exists and both screens use it', () => {
    const helper = join(WEB_ROOT, 'lib', 'payment-state.ts');
    assert.ok(existsSync(helper), 'the shared payment-state helper is missing');
    for (const page of ['app/account/page.tsx', 'app/account/payments/page.tsx']) {
      assert.match(read(join(WEB_ROOT, page)), /getPaymentState/, `${page} does not use the shared derivation`);
    }
  });

  test('the summary no longer reads fields nobody fetched', () => {
    const src = read(join(WEB_ROOT, 'app', 'account', 'page.tsx'));
    assert.ok(!/as \{ has_payment_method\?: boolean \}/.test(src),
      'this cast hid the fact that getAccount never selected the column');
    assert.ok(!/as \{ stripe_payouts_enabled\?: boolean \}/.test(src));
  });

  test('payout state coalesces both places a Connect account can live', () => {
    const src = read(join(WEB_ROOT, 'lib', 'payment-state.ts'));
    assert.match(src, /driver_profiles/,
      'a driver who connected in the app keeps their account on driver_profiles');
    assert.match(src, /profiles/);
  });

  test('the account screens consume booleans, not Stripe identifiers', () => {
    const src = read(join(WEB_ROOT, 'lib', 'payment-state.ts'));
    const returned = src.slice(src.indexOf('return {'));
    for (const leak of ['stripe_account_id', 'stripe_customer_id', 'acct_', 'cus_']) {
      assert.ok(!returned.includes(leak), `payment state must not hand ${leak} to a screen`);
    }
  });
});

// ── 4. Buyer and seller stay separate ──────────────────────────────────────

describe('the buyer pays with their own card', () => {
  test('the buyer’s Stripe customer comes from the authenticated buyer', () => {
    const src = read(join(REPO_ROOT, 'supabase', 'functions', 'create-event-ticket-intent', 'index.ts'));
    // The customer is read from the buyer's own profile row, keyed on the JWT
    // user — never from the organiser, the business, or anything in the body.
    assert.match(src, /profile\?\.stripe_customer_id/);
    assert.ok(!/organiser[^\n]*stripe_customer_id/i.test(src),
      'the organiser must never be the payer');
  });

  test('the destination is a transfer, separate from who is charged', () => {
    const src = read(join(REPO_ROOT, 'supabase', 'functions', 'create-event-ticket-intent', 'index.ts'));
    assert.match(src, /transfer_data\[destination\]/);
    assert.match(src, /stripeAccountId/);
  });
});
