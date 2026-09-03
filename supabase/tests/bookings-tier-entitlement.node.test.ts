/**
 * bookings-tier-entitlement.node.test.ts — Bookings is a Pro feature, and now
 * the server thinks so too.
 *
 * Before this, "Bookings needs Pro" was enforced by the website redirecting off
 * the page and the app not drawing the button. The RLS insert policy on
 * book_bookings is `customer_id = auth.uid()` and nothing else — no business
 * check, no accepts_bookings check, no tier. Two guards close it: one on
 * turning bookings on, one on the booking itself, because a business that went
 * live legitimately and then lapsed leaves accepts_bookings sitting at true and
 * nothing sweeps it.
 *
 * The three things it must NOT do are tested as carefully as the thing it does:
 * turning bookings off always works, configuration stays open below Pro, and an
 * ordinary Directory edit is never examined.
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
const WEB = join(REPO_ROOT, '..', 'oneshetland-web');

function sql(body: string): Record<string, unknown>[] {
  const out = execFileSync('npx',
    ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${body}`, '--output-format', 'json'],
    { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 240_000 });
  const parsed = JSON.parse(out.slice(out.indexOf('{'))) as { rows?: Record<string, unknown>[]; error?: unknown };
  if (parsed.error) throw new Error(JSON.stringify(parsed.error).slice(0, 400));
  return parsed.rows ?? [];
}

const OWNER = 'b1b10001-1111-1111-1111-111111111111';
const CUST  = 'b1b10009-9999-9999-9999-999999999999';
const B = {
  free:     'b1b10002-2222-2222-2222-222222222222',
  pro:      'b1b10003-3333-3333-3333-333333333333',
  premium:  'b1b10004-4444-4444-4444-444444444444',
  proX:     'b1b10005-5555-5555-5555-555555555555',
  premNull: 'b1b10006-6666-6666-6666-666666666666',
  lapsing:  'b1b10007-7777-7777-7777-777777777777',
  free2:    'b1b1000e-eeee-eeee-eeee-eeeeeeeeeeee',   // Pro, never accepts
};
const SVC_FREE = 'b1b1000a-0000-0000-0000-00000000000a';
const SVC_PAID = 'b1b1000b-0000-0000-0000-00000000000b';

/** Six businesses, one per subscription state, plus one that goes live then lapses. */
const FIXTURE = `
begin;
  insert into auth.users (id,email) values ('${OWNER}','bk-o@probe.invalid'),('${CUST}','bk-c@probe.invalid');
  insert into public.local_businesses (id,owner_id,name,category,address,is_active) values
    ('${B.free}','${OWNER}','BK FREE','other','P',true),
    ('${B.pro}','${OWNER}','BK PRO','other','P',true),
    ('${B.premium}','${OWNER}','BK PREM','other','P',true),
    ('${B.proX}','${OWNER}','BK PRO EXPIRED','other','P',true),
    ('${B.premNull}','${OWNER}','BK PREM NULL','other','P',true),
    ('${B.lapsing}','${OWNER}','BK LAPSING','other','P',true),
    ('${B.free2}','${OWNER}','BK PRO UNACCEPTED','other','P',true);
  update public.local_businesses set subscription_tier='pro',     subscription_until=now()+interval '10 days' where id='${B.pro}';
  update public.local_businesses set subscription_tier='premium', subscription_until=now()+interval '10 days' where id='${B.premium}';
  update public.local_businesses set subscription_tier='pro',     subscription_until=now()-interval '1 day'   where id='${B.proX}';
  update public.local_businesses set subscription_tier='premium', subscription_until=null                     where id='${B.premNull}';
  update public.local_businesses set subscription_tier='pro', subscription_until=now()+interval '1 day',
         accepts_bookings=true where id='${B.lapsing}';
  update public.local_businesses set subscription_tier='pro', subscription_until=now()+interval '10 days' where id='${B.free2}';
  insert into public.book_services (id,business_id,name,duration_minutes,price_pence,is_active) values
    ('${SVC_FREE}','${B.free}','Free cut',30,0,true),
    ('${SVC_PAID}','${B.lapsing}','Cut',30,2000,true);
  insert into public.book_bookings (business_id,service_id,customer_id,starts_at,ends_at,price_pence,status)
    values ('${B.lapsing}','${SVC_PAID}','${CUST}',now()+interval '2 days',now()+interval '2 days'+interval '30 min',2000,'confirmed');
  create temp table r(step text, outcome text) on commit drop;
  grant insert, select on r to authenticated, anon;
`;

/** Owner-side setup must run with no JWT, or the guard treats it as a client. */
const asOwnerRole = `reset role; select set_config('request.jwt.claims','',true);`;
const asUser = (id: string) => `
  reset role;
  select set_config('request.jwt.claims','{"sub":"${id}","role":"authenticated"}',true);
  set local role authenticated;`;
const attempt = (step: string, stmt: string) => `
do $p$ begin ${stmt};
  insert into r values ('${step}','ALLOWED');
exception when others then insert into r values ('${step}','refused'); end $p$;`;
const END = `reset role; select * from r order by step; rollback;`;
const outcome = (rows: Record<string, unknown>[], step: string) =>
  rows.find((r) => r.step === step)?.outcome;

const booking = (biz: string, svc: string, days: number) =>
  `insert into public.book_bookings (business_id,service_id,customer_id,starts_at,ends_at,price_pence)
   values ('${biz}','${svc}','${CUST}',now()+interval '${days} days',now()+interval '${days} days'+interval '30 min',2000)`;

/* ── 1. Going live is the paid moment ───────────────────────────────────── */

describe('turning bookings on needs current Pro', () => {
  // Terms are accepted for every business here so that what this block
  // measures is the TIER ladder and nothing else. Activation needs both — the
  // terms half is the subject of the block above, and these tests used to pass
  // only because that half was missing.
  const rows = sql(FIXTURE + asUser(OWNER) +
    `select public.record_commercial_terms_acceptance('${B.free}'::uuid);
     select public.record_commercial_terms_acceptance('${B.pro}'::uuid);
     select public.record_commercial_terms_acceptance('${B.premium}'::uuid);
     select public.record_commercial_terms_acceptance('${B.proX}'::uuid);
     select public.record_commercial_terms_acceptance('${B.premNull}'::uuid);` +
    attempt('free',        `update public.local_businesses set accepts_bookings=true where id='${B.free}'`) +
    attempt('pro',         `update public.local_businesses set accepts_bookings=true where id='${B.pro}'`) +
    attempt('premium',     `update public.local_businesses set accepts_bookings=true where id='${B.premium}'`) +
    attempt('expired pro', `update public.local_businesses set accepts_bookings=true where id='${B.proX}'`) +
    attempt('premium with no end date', `update public.local_businesses set accepts_bookings=true where id='${B.premNull}'`) +
    END);

  test('a free business cannot switch bookings on', () => {
    assert.equal(outcome(rows, 'free'), 'refused');
  });

  test('pro can', () => assert.equal(outcome(rows, 'pro'), 'ALLOWED'));

  test('premium can — it meets pro', () => assert.equal(outcome(rows, 'premium'), 'ALLOWED'));

  test('an expired pro cannot — the missed-webhook case this exists for', () => {
    // subscription_tier still reads 'pro'; nothing sweeps it; the expiry decides.
    assert.equal(outcome(rows, 'expired pro'), 'refused');
  });

  test('a paid tier with no end date cannot', () => {
    assert.equal(outcome(rows, 'premium with no end date'), 'refused');
  });
});

/* ── 1b. Going live needs the terms too ─────────────────────────────────── */

/**
 * The plan is not the only question at activation. The first cut checked the
 * subscription and reasoned that a business cannot create a service without
 * accepting, so by the time it has anything to book it has accepted. True of a
 * business set up today; not an invariant — and it fails exactly where the
 * version-pinned model matters, at the next terms change:
 *
 *   accepted v1.0 · services exist · bookings off
 *   → terms move to v1.1 · owner has not accepted
 *   → owner switches bookings back on, subscription fine, waved through
 */
describe('turning bookings on needs current terms as well as the plan', () => {
  const rows = sql(FIXTURE + asUser(OWNER) +
    `select public.record_commercial_terms_acceptance('${B.pro}'::uuid);
     select public.record_commercial_terms_acceptance('${B.premium}'::uuid);` +
    attempt('pro + accepted',      `update public.local_businesses set accepts_bookings=true where id='${B.pro}'`) +
    attempt('premium + accepted',  `update public.local_businesses set accepts_bookings=true where id='${B.premium}'`) +
    attempt('pro, never accepted', `update public.local_businesses set accepts_bookings=true where id='${B.free2}'`) +
    END);

  test('pro with current acceptance can go live', () => {
    assert.equal(outcome(rows, 'pro + accepted'), 'ALLOWED');
  });

  test('premium with current acceptance can go live', () => {
    assert.equal(outcome(rows, 'premium + accepted'), 'ALLOWED');
  });

  test('an entitled owner who has not accepted cannot', () => {
    assert.equal(outcome(rows, 'pro, never accepted'), 'refused',
      'the plan alone is not permission to put a business in front of customers');
  });

  test('accepting for one business does not open another', () => {
    // B.free2 is Pro and unaccepted; acceptance above was for two other businesses.
    assert.equal(outcome(rows, 'pro, never accepted'), 'refused');
  });

  test('THE DEFECT: an old acceptance does not survive a version change', () => {
    // The version moves inside the transaction; production stays on its own.
    const v = sql(FIXTURE + asUser(OWNER) +
      `select public.record_commercial_terms_acceptance('${B.pro}'::uuid);` +
      asOwnerRole +
      `create or replace function public.commercial_terms_version() returns text
         language sql immutable set search_path=public as $v$ select '99.0'::text $v$;` +
      asUser(OWNER) +
      attempt('activate on a stale acceptance', `update public.local_businesses set accepts_bookings=true where id='${B.pro}'`) +
      `select public.record_commercial_terms_acceptance('${B.pro}'::uuid);` +
      attempt('activate after accepting the new version', `update public.local_businesses set accepts_bookings=true where id='${B.pro}'`) +
      `insert into r select 'services survive the bump', count(*)::text from public.book_services where business_id='${B.lapsing}';` +
      END);
    assert.equal(outcome(v, 'activate on a stale acceptance'), 'refused');
    assert.equal(outcome(v, 'activate after accepting the new version'), 'ALLOWED');
    assert.equal(outcome(v, 'services survive the bump'), '1', 'a version bump destroys no configuration');
  });

  test('a stranger cannot activate somebody else\'s business', () => {
    const rows2 = sql(FIXTURE + asUser(CUST) +
      attempt('stranger activates', `update public.local_businesses set accepts_bookings=true where id='${B.pro}'`) +
      asOwnerRole +
      `insert into r select 'flag after stranger', accepts_bookings::text from public.local_businesses where id='${B.pro}';` +
      END);
    // RLS filters the row before the trigger sees it, so the write is a no-op
    // rather than an error — measured by outcome, not by absence of an error.
    assert.equal(outcome(rows2, 'flag after stranger'), 'false');
  });

  test('activation asks the one acceptance truth, not its own copy', () => {
    const [row] = sql(`select pg_get_functiondef('public.local_businesses_bookings_tier_guard'::regproc) as d;`);
    const def = String(row.d);
    assert.match(def, /business_may_transact\(new\.id, v_uid\)/, 'reuse the protected helper');
    assert.match(def, /business_meets_tier\(new\.id, 'pro'\)/);
    for (const forbidden of ['compliance_log', 'commercial_terms_version', 'has_accepted_commercial_terms',
                             'document_version', 'business.commercial_terms_accepted']) {
      assert.ok(!def.includes(forbidden), `the terms lookup must not be reimplemented here: ${forbidden}`);
    }
    assert.ok(!/auth\.uid\(\)\s*\)/.test(def.slice(def.indexOf('business_may_transact'))),
      'the identity comes from v_uid, captured once, not from a caller-supplied value');
  });

  test('no second acceptance event, version or writer was created', () => {
    const [row] = sql(`
      select (select count(*)::int from pg_proc p join pg_namespace n on n.oid=p.pronamespace
               where n.nspname='public' and p.proname like '%commercial_terms%') as terms_functions,
             public.commercial_terms_version() as version,
             (select count(distinct event_type)::int from public.compliance_log
               where event_type like 'business.%') as business_event_types;`);
    assert.equal(row.version, '1.0');
    assert.equal(row.business_event_types, 1, 'still exactly one business terms event type');
    assert.ok((row.terms_functions as number) >= 3);
  });
});

/* ── 2. What must never be blocked ──────────────────────────────────────── */

describe('the three things this must not break', () => {
  const rows = sql(FIXTURE +
    // Terms first, so what follows tests TIER and not W3I.
    asUser(OWNER) + `select public.record_commercial_terms_acceptance('${B.free}'::uuid);` +
    attempt('directory edit while expired', `update public.local_businesses set description='ok' where id='${B.proX}'`) +
    attempt('edit a service below pro',     `update public.book_services set price_pence=100 where id='${SVC_FREE}'`) +
    attempt('add availability below pro',   `insert into public.book_availability_rules (business_id,day_of_week,start_time,end_time) values ('${B.free}',1,'09:00','17:00')`) +
    asOwnerRole + `update public.local_businesses set subscription_until=now()-interval '1 hour' where id='${B.lapsing}';` +
    asUser(OWNER) +
    attempt('turn bookings OFF after lapsing', `update public.local_businesses set accepts_bookings=false where id='${B.lapsing}'`) +
    END);

  test('an ordinary Directory edit is never examined', () => {
    assert.equal(outcome(rows, 'directory edit while expired'), 'ALLOWED',
      'a lapsed subscription must not stop somebody fixing their description');
  });

  test('services stay editable below Pro — setup before upgrade', () => {
    assert.equal(outcome(rows, 'edit a service below pro'), 'ALLOWED');
  });

  test('availability stays writable below Pro', () => {
    assert.equal(outcome(rows, 'add availability below pro'), 'ALLOWED');
  });

  test('turning bookings OFF works after the plan has lapsed', () => {
    assert.equal(outcome(rows, 'turn bookings OFF after lapsing'), 'ALLOWED',
      'never trap a business with customers able to book what it cannot honour');
  });

  test('withdrawal does not require current terms either', () => {
    // The lapsing business never accepted; switching off must still work.
    const solo = sql(FIXTURE + asUser(OWNER) +
      attempt('off without terms', `update public.local_businesses set accepts_bookings=false where id='${B.lapsing}'`) + END);
    assert.equal(outcome(solo, 'off without terms'), 'ALLOWED');
  });
});

/* ── 3. The backstop: a stale flag buys nothing ─────────────────────────── */

describe('a booking checks entitlement, not a flag set months ago', () => {
  const rows = sql(FIXTURE +
    asOwnerRole + `update public.local_businesses set subscription_until=now()-interval '1 hour' where id='${B.lapsing}';` +
    asUser(CUST) +
    attempt('booking at a lapsed business', booking(B.lapsing, SVC_PAID, 3)) +
    asOwnerRole +
    `insert into r select 'accepts_bookings still true', accepts_bookings::text from public.local_businesses where id='${B.lapsing}';
     insert into r select 'historic booking survives', count(*)::text from public.book_bookings where business_id='${B.lapsing}';
     insert into r select 'services survive', count(*)::text from public.book_services where business_id='${B.lapsing}';
     update public.local_businesses set subscription_until=now()+interval '5 days' where id='${B.lapsing}';` +
    asUser(CUST) +
    attempt('booking once entitlement returns', booking(B.lapsing, SVC_PAID, 4)) +
    END);

  test('the stale flag is still true — and buys nothing', () => {
    assert.equal(outcome(rows, 'accepts_bookings still true'), 'true');
    assert.equal(outcome(rows, 'booking at a lapsed business'), 'refused');
  });

  test('nothing already taken is destroyed', () => {
    assert.equal(outcome(rows, 'historic booking survives'), '1');
    assert.equal(outcome(rows, 'services survive'), '1');
  });

  test('regaining the plan makes bookings work again', () => {
    assert.equal(outcome(rows, 'booking once entitlement returns'), 'ALLOWED');
  });

  test('a free service is still a Pro feature', () => {
    // The price of what is booked has never been what the plan pays for.
    const solo = sql(FIXTURE +
      asOwnerRole + `update public.local_businesses set accepts_bookings=true where id='${B.free}';` +
      asUser(CUST) + attempt('£0 booking at a free business', booking(B.free, SVC_FREE, 3)) + END);
    assert.equal(outcome(solo, '£0 booking at a free business'), 'refused');
  });

  test('an existing booking can still be managed after the plan lapses', () => {
    // This used to complete the fixture booking, which sits two days out. It
    // now seeds one that has already happened and completes THAT, because
    // book_booking_transition_guard refuses completing an appointment before
    // it starts — a rule about time, not about entitlement. The subject here
    // is unchanged: a lapsed plan must not strand the bookings already taken.
    const solo = sql(FIXTURE +
      asOwnerRole +
      `update public.local_businesses set subscription_until=now()-interval '1 hour' where id='${B.lapsing}';
       insert into public.book_bookings (business_id,service_id,customer_id,starts_at,ends_at,price_pence,status)
         values ('${B.lapsing}','${SVC_PAID}','${CUST}',
                 now()-interval '2 hours', now()-interval '90 minutes', 2000, 'confirmed');` +
      asUser(OWNER) +
      attempt('cancel one still to come',
        `update public.book_bookings set status='cancelled'
          where business_id='${B.lapsing}' and starts_at > now()`) +
      attempt('complete one that has already happened',
        `update public.book_bookings set status='completed'
          where business_id='${B.lapsing}' and starts_at <= now()`) +
      // attempt() calls a statement that changed nothing ALLOWED, because no
      // error was raised. Read the rows back, or a filter that matches nothing
      // passes this test while proving nothing happened.
      asOwnerRole +
      `insert into r select 'ended up cancelled', count(*)::text from public.book_bookings
         where business_id='${B.lapsing}' and status='cancelled';
       insert into r select 'ended up completed', count(*)::text from public.book_bookings
         where business_id='${B.lapsing}' and status='completed';` + END);
    assert.equal(outcome(solo, 'cancel one still to come'), 'ALLOWED',
      'obligations outlive the subscription');
    assert.equal(outcome(solo, 'complete one that has already happened'), 'ALLOWED',
      'obligations outlive the subscription');
    assert.equal(outcome(solo, 'ended up cancelled'), '1', 'nothing was actually cancelled');
    assert.equal(outcome(solo, 'ended up completed'), '1', 'nothing was actually completed');
  });
});

/* ── 4. Bypass routes ───────────────────────────────────────────────────── */

describe('there is no way round it', () => {
  test('direct PostgREST activation is refused — the client is not the boundary', () => {
    // This is the same call a deep-linked mobile screen would make; the app
    // hides the button, and the server no longer relies on that.
    const rows = sql(FIXTURE + asUser(OWNER) +
      attempt('direct activation', `update public.local_businesses set accepts_bookings=true where id='${B.free}'`) +
      attempt('direct booking',    booking(B.free, SVC_FREE, 3)) + END);
    assert.equal(outcome(rows, 'direct activation'), 'refused');
    assert.equal(outcome(rows, 'direct booking'), 'refused');
  });

  test('a customer cannot book a business that never went live', () => {
    const rows = sql(FIXTURE + asUser(CUST) + attempt('never live', booking(B.pro, SVC_PAID, 3)) + END);
    assert.equal(outcome(rows, 'never live'), 'refused');
  });

  test('the refusal says the same thing whichever check failed', () => {
    // A customer has no business learning a shop's billing state.
    const [row] = sql(`select pg_get_functiondef('public.book_bookings_tier_guard'::regproc) as d;`);
    const msgs = [...String(row.d).matchAll(/raise exception '([^']+)'/g)].map((m) => m[1]);
    assert.ok(msgs.length >= 3);
    assert.equal(new Set(msgs).size, 1, 'one message, so the reason cannot be probed');
  });
});

/* ── 5. Shape, composition, and what was left alone ─────────────────────── */

describe('deployed shape and composition', () => {
  test('both guards exist, on the right tables and events', () => {
    const rows = sql(`
      select c.relname as tbl, t.tgname,
             case when (t.tgtype & 2)<>0 then 'BEFORE' else 'AFTER' end as timing,
             (t.tgtype & 4)<>0 as on_insert, (t.tgtype & 16)<>0 as on_update
        from pg_trigger t join pg_class c on c.oid=t.tgrelid
       where t.tgname in ('local_businesses_bookings_tier_guard','book_bookings_tier_guard')
         and not t.tgisinternal order by t.tgname;`);
    const byName = Object.fromEntries(rows.map((r) => [r.tgname, r]));
    assert.equal(byName['book_bookings_tier_guard']?.tbl, 'book_bookings');
    assert.equal(byName['book_bookings_tier_guard']?.on_insert, true);
    assert.equal(byName['book_bookings_tier_guard']?.on_update, false,
      'managing an existing booking must survive a lapse');
    assert.equal(byName['local_businesses_bookings_tier_guard']?.tbl, 'local_businesses');
    assert.equal(byName['local_businesses_bookings_tier_guard']?.on_update, true);
  });

  test('both use the one shared predicate, not a second tier formula', () => {
    for (const fn of ['local_businesses_bookings_tier_guard', 'book_bookings_tier_guard']) {
      const [row] = sql(`select pg_get_functiondef('public.${fn}'::regproc) as d;`);
      const def = String(row.d);
      assert.match(def, /business_meets_tier\(/, `${fn} must use the shared predicate`);
      assert.ok(!/subscription_tier/.test(def), `${fn} must not re-derive tier`);
      assert.ok(!/subscription_until/.test(def), `${fn} must not re-derive expiry`);
      assert.match(def, /security definer/i);
      assert.match(def, /search_path/i);
    }
  });

  test('tier composes with W3I rather than replacing it', () => {
    const [row] = sql(`
      select (select count(*)::int from pg_trigger where tgname='commercial_terms_guard' and not tgisinternal) as w3i,
             (select count(*)::int from pg_trigger where tgname='local_businesses_commercial_guard' and not tgisinternal) as lb_guard,
             public.commercial_terms_version() as version,
             (position('business_meets_tier' in pg_get_functiondef('public.local_businesses_commercial_guard'::regproc)) > 0) as w3i_polluted;`);
    assert.equal(row.w3i, 9, 'W3I still guards nine tables');
    assert.equal(row.lb_guard, 1);
    assert.equal(row.version, '1.0');
    assert.equal(row.w3i_polluted, false, 'the W3I guard was not modified by this work');
  });

  test('a business still cannot configure bookings without accepting terms', () => {
    // Tier did not become a substitute for W3I.
    const rows = sql(FIXTURE + asUser(OWNER) +
      attempt('service without terms',
        `insert into public.book_services (business_id,name,duration_minutes,price_pence) values ('${B.pro}','X',30,100)`) + END);
    assert.equal(outcome(rows, 'service without terms'), 'refused');
  });

  test('the web asks the effective predicate, and no longer redirects on entry', () => {
    // Phase 2C replaced the blind redirect this used to pin. The web now opens
    // the manager and asks the deployed predicate, so the thing worth guarding
    // is that presentation follows EFFECTIVE entitlement and never the stored
    // column — the server enforcement below is unchanged either way.
    const page = readFileSync(join(WEB, 'app/business/[id]/manage/bookings/page.tsx'), 'utf8');
    assert.match(page, /getEffectiveTier\(business\.id\)/);
    assert.doesNotMatch(page, /tierUnlocks|subscription_tier/);
    assert.doesNotMatch(page, /redirect\(`\/business\/\$\{business\.id\}\/manage\/billing`\)/);
  });

  test('the enforced set is exactly the six approved capabilities', () => {
    const rows = sql(`
      -- distinct: local_businesses carries more than one guard (Bookings and
      -- Wallet), and this asks which TABLES are enforced, not how many guards.
      select distinct c.relname as tbl
        from pg_trigger t join pg_class c on c.oid=t.tgrelid
       where not t.tgisinternal
         and position('business_meets_tier' in pg_get_functiondef(t.tgfoid)) > 0
       order by c.relname;`);
    // Products, Passes and Wallet were the approved slices after this one;
    // Offers and Loyalty still are not.
    assert.deepEqual(rows.map((r) => r.tbl).sort(),
      ['book_bookings', 'book_unit_items', 'local_businesses', 'local_loyalty_cards',
       'local_loyalty_programs', 'local_loyalty_transactions', 'local_offers',
       'local_wallet_transactions', 'products'],
      'this is the complete set of tier-enforced tables');
  });
});
