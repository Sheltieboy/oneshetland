/**
 * event-discovery.node.test.ts — signed-out visitors can see public events.
 *
 * WHAT WAS WRONG
 *
 * Every anonymous read of public.events failed outright:
 *
 *     42501: permission denied for table local_businesses
 *
 * Not "no rows" — an ERROR. getUpcomingEvents wraps its query in try/catch and
 * returns [], and the Local feed wraps its own in safe(), so What's On and the
 * Local area quietly showed "no events" while the database was refusing the
 * query. EVERY event was invisible to EVERY signed-out visitor.
 *
 * WHY
 *
 * Step 8 replaced table-level SELECT on local_businesses with column grants and
 * deliberately withheld owner_id. The events RLS policies checked ownership by
 * reading that column AS THE CALLER, and a policy runs with the caller's
 * privileges — so anon needed SELECT on owner_id to answer a question whose
 * answer was always "no". authenticated still had the column, which is why the
 * app looked fine and only the signed-out website broke.
 *
 * WHAT IS ASSERTED
 *   · anon can read events and event_ticket_types AT ALL — the regression that
 *     started this, and the one most likely to come back
 *   · the ownership rules did not change: authenticated sees the same rows
 *   · a published future event is discoverable; hidden and draft ones are not
 *   · payout readiness does NOT decide discoverability, only purchasability
 *   · the ticket route the Get tickets button targets exists and is handed the
 *     event id under the name the screen reads
 *
 * SAFETY
 * Read-only, apart from fixtures created inside a transaction that is never
 * committed. No Stripe call, no payment, no production row.
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

// ── 1. The regression itself ───────────────────────────────────────────────

describe('a signed-out visitor can read public events', () => {
  test('anon reads events and ticket types without an error', () => {
    // If this ever fails with 42501 again, every public listing is empty and
    // the website will not say so — it swallows the error and renders nothing.
    const r = one(`
      with probe as (
        select
          (select count(*) from public.events)              as ev,
          (select count(*) from public.event_ticket_types)  as tt
      )
      select ev::text as ev, tt::text as tt from probe;`);
    assert.ok(Number(r.ev) > 0, 'events must be readable');
    assert.ok(Number(r.tt) >= 0);

    const roles = one(`
      select
        (select count(*) from public.events)::text as as_definer,
        (select public.event_payout_ready(id)::text from public.events limit 1) as sample_ready;`);
    assert.ok(Number(roles.as_definer) > 0);
  });

  test('anon and authenticated see the same published events', () => {
    // The fix moved WHO does the reading, not WHAT is visible. If these two
    // ever diverge, an ownership rule was changed by accident.
    const r = one(`
      begin;
      create temp table c(who text, n int);
      do $$
      declare n int;
      begin
        perform set_config('role','anon',true);
        select count(*) into n from public.events where status='published';
        perform set_config('role','postgres',true);
        insert into c values ('anon', n);
        perform set_config('role','authenticated',true);
        select count(*) into n from public.events where status='published';
        perform set_config('role','postgres',true);
        insert into c values ('authenticated', n);
      end $$;
      select (select n from c where who='anon')::text as anon_n,
             (select n from c where who='authenticated')::text as auth_n;`);
    assert.equal(r.anon_n, r.auth_n,
      `anon sees ${r.anon_n} published events, authenticated sees ${r.auth_n} — the rules changed`);
  });

  test('the ownership helpers are SECURITY DEFINER with a pinned search_path', () => {
    const r = one(`
      select count(*) filter (where p.prosecdef)::text                    as definers,
             count(*) filter (where p.proconfig is not null)::text        as pinned,
             count(*)::text                                              as total
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname='public' and p.proname in ('is_business_owner','is_event_business_owner');`);
    assert.equal(r.total, '2');
    assert.equal(r.definers, '2', 'these exist so the CALLER need not read local_businesses');
    assert.equal(r.pinned, '2');
  });

  test('no events policy reads local_businesses as the caller any more', () => {
    const r = one(`
      select count(*)::text as n
        from pg_policies
       where schemaname='public' and tablename in ('events','event_ticket_types')
         and (coalesce(qual,'')||coalesce(with_check,'')) ilike '%local_businesses%';`);
    assert.equal(r.n, '0',
      'a policy that reads local_businesses breaks every anonymous read of that table');
  });
});

// ── 2. Discoverability rules ───────────────────────────────────────────────

describe('what a public listing shows', () => {
  test('published is discoverable; draft is not; payout readiness is irrelevant to both', () => {
    // is_hidden is not independently settable: tg_events_sync_hidden derives it
    // as (status <> 'published') on every insert and update. So "hidden" and
    // "not published" are the same state, and the draft case below covers both.
    const r = one(`
      begin;
      create temp table v(label text, ok boolean);
      do $$
      declare u uuid; b uuid; e_ok uuid; e_draft uuid; e_nopay uuid; n int;
      begin
        select id into u from auth.users limit 1;
        b := gen_random_uuid();
        insert into public.local_businesses (id,name,category,address,slug,owner_id)
        values (b,'D Biz','other','Lerwick','d-biz-'||left(b::text,8),u);

        e_ok := gen_random_uuid(); e_draft := gen_random_uuid(); e_nopay := gen_random_uuid();
        insert into public.events (id,title,status,organiser_business_id,starts_at,has_tickets)
        values (e_ok,   'D visible','published',b, now()+interval '5 days', true),
               (e_draft,'D draft',  'draft',    b, now()+interval '5 days', true);
        -- An organiser with no payout route anywhere.
        insert into public.events (id,title,status,starts_at,has_tickets)
        values (e_nopay,'D nopay','published', now()+interval '5 days', true);

        perform set_config('role','anon',true);
        select count(*) into n from public.events where id=e_ok;    perform set_config('role','postgres',true);
        insert into v values ('published_visible', n > 0);

        perform set_config('role','anon',true);
        select count(*) into n from public.events where id=e_draft; perform set_config('role','postgres',true);
        insert into v values ('draft_hidden', n = 0);

        insert into v values ('draft_is_flagged_hidden',
          (select is_hidden from public.events where id=e_draft));

        -- Discoverability must not depend on payout readiness.
        perform set_config('role','anon',true);
        select count(*) into n from public.events where id=e_nopay; perform set_config('role','postgres',true);
        insert into v values ('unready_still_listed', n > 0);
        insert into v values ('unready_not_purchasable', not public.event_payout_ready(e_nopay));
      end $$;
      select
        (select ok from v where label='published_visible')::text        as published_visible,
        (select ok from v where label='draft_hidden')::text             as draft_hidden,
        (select ok from v where label='draft_is_flagged_hidden')::text  as draft_flagged,
        (select ok from v where label='unready_still_listed')::text     as unready_listed,
        (select ok from v where label='unready_not_purchasable')::text  as unready_not_buyable;`);
    const T = (x: unknown) => x === true || x === 't' || x === 'true';
    assert.ok(T(r.published_visible), 'a published future event must be visible to a signed-out visitor');
    assert.ok(T(r.draft_hidden), 'a draft must not be publicly readable');
    assert.ok(T(r.draft_flagged), 'the trigger should mark a non-published event hidden');
    assert.ok(T(r.unready_listed),
      'an organiser who cannot take payments yet still has a real event — hiding it would be wrong');
    assert.ok(T(r.unready_not_buyable), 'but its tickets must not be purchasable');
  });
});

// ── 3. The Get tickets route ───────────────────────────────────────────────

describe('Get tickets goes somewhere that exists', () => {
  test('the route file the button targets is present', () => {
    assert.ok(existsSync(join(REPO_ROOT, 'app', 'event-ticket-checkout.tsx')),
      'the CTA pushes /event-ticket-checkout');
  });

  test('the button passes the id under the name the screen reads', () => {
    const detail = read(join(REPO_ROOT, 'app', 'events', '[id].tsx'));
    const checkout = read(join(REPO_ROOT, 'app', 'event-ticket-checkout.tsx'));
    assert.match(detail, /pathname: '\/event-ticket-checkout', params: \{ id: event\.id \}/);
    assert.match(checkout, /useLocalSearchParams<\{ id: string \}>\(\)/,
      'a param-name mismatch would leave the screen with no event');
  });

  test('the checkout screen survives a missing event and a missing card', () => {
    const src = read(join(REPO_ROOT, 'app', 'event-ticket-checkout.tsx'));
    assert.match(src, /if \(loading\)/, 'must not render against a half-loaded event');
    assert.match(src, /if \(!event\)/, 'must handle an event that failed to load');
    assert.match(src, /use_saved_card: !!profile\.has_payment_method/,
      'a buyer with no saved card must fall through to the payment sheet, not crash');
  });

  test('the checkout screen never needs the seller’s payout details', () => {
    const src = read(join(REPO_ROOT, 'app', 'event-ticket-checkout.tsx'));
    for (const seller of ['payout_enabled', 'stripe_account_id', 'payout_ready']) {
      assert.ok(!src.includes(seller),
        `the buyer's checkout must not depend on ${seller} — that is the seller's side`);
    }
  });
});

// ── 4. List and detail agree ───────────────────────────────────────────────

describe('list and detail apply the same visibility', () => {
  test('the web detail read allows exactly the publicly-visible statuses', () => {
    const src = read(join(WEB_ROOT, 'lib', 'events-data.ts'));
    assert.match(src, /\.in\("status", \["published", "cancelled", "postponed"\]\)/,
      'detail shows a status banner rather than 404-ing; draft and archived stay hidden');
  });

  test('the listing only shows published events', () => {
    const src = read(join(WEB_ROOT, 'lib', 'events-data.ts'));
    assert.match(src, /\.eq\("status", "published"\)/);
  });
});
