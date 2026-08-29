/**
 * commercial-terms-acceptance.node.test.ts — an acceptance nobody can fake.
 *
 * A business will later have to accept the commercial section of the Terms
 * before it can sell. That gate is NOT built yet; this is the record it will
 * one day read, and the record had to be made trustworthy first.
 *
 * It was not. compliance_log's insert policy is `user_id = auth.uid()`, and
 * every writer in the product is an authenticated client — there is no
 * service-role writer anywhere. Measured before this change: a signed-in owner
 * could POST straight to PostgREST and manufacture their own acceptance, with
 * the right version and their own business id, having seen nothing. A gate
 * reading that row would have been satisfied by a row the seller wrote.
 *
 * Three protections, none of which works alone:
 *   1. the policy refuses ONE event type to clients;
 *   2. a SECURITY DEFINER writer is the only thing that can create it;
 *   3. a partial unique index makes it idempotent under concurrency, because
 *      the writer's check-then-insert races with itself otherwise.
 *
 * Everything below runs against the real database inside transactions that are
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
const WEB = join(REPO_ROOT, '..', 'oneshetland-web');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const readWeb = (p: string) => readFileSync(join(WEB, p), 'utf8');

const migration = read('supabase/migrations/20260913120000_commercial_terms_acceptance.sql');
const terms     = readWeb('app/terms/page.tsx');

function sql(body: string): Record<string, unknown>[] {
  const out = execFileSync('npx',
    ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${body}`, '--output-format', 'json'],
    { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 });
  const parsed = JSON.parse(out) as { rows?: Record<string, unknown>[]; error?: unknown };
  if (parsed.error) throw new Error(JSON.stringify(parsed.error).slice(0, 400));
  return parsed.rows ?? [];
}

const OWNER    = 'c0de0001-1111-1111-1111-111111111111';
const STRANGER = 'c0de0003-3333-3333-3333-333333333333';
const BIZ_A    = 'c0de0002-2222-2222-2222-222222222222';
const BIZ_B    = 'c0de0004-4444-4444-4444-444444444444';

/** Two owners, two businesses, and a place to collect outcomes. */
const FIXTURE = `
begin;
  insert into auth.users (id, email) values
    ('${OWNER}',    'ct-owner@probe.invalid'),
    ('${STRANGER}', 'ct-stranger@probe.invalid');
  insert into public.local_businesses (id, owner_id, name, category, address, is_active) values
    ('${BIZ_A}', '${OWNER}',    'PROBE Mine',   'other', 'PROBE', true),
    ('${BIZ_B}', '${STRANGER}', 'PROBE Theirs', 'other', 'PROBE', true);
  create temp table r(label text, outcome text) on commit drop;
  grant insert, select on r to authenticated, anon;
`;
const asOwner = `
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"${OWNER}","role":"authenticated"}';
`;
const commercialRows = `
  (select count(*)::int from public.compliance_log
    where event_type = 'business.commercial_terms_accepted')`;

/* ── 1. Ordinary logging is untouched ───────────────────────────────────── */

describe('every existing compliance event still works', () => {
  test('the fourteen legitimate event types are all still insertable', () => {
    const types = ['terms.accepted', 'privacy.accepted', 'age.confirmed', 'email.verified',
      'marketing.opted_in', 'marketing.opted_out', 'password.changed', 'email.changed',
      'data.export_requested', 'account.deletion_req', 'driver.terms_accepted',
      'fetch.liability_ack', 'payment.method_added', 'booking.terms_accepted'];
    const inserts = types.map((t, i) => `
      do $p$ begin
        insert into public.compliance_log (user_id, user_email, event_type, document_version, metadata)
        values ('${OWNER}', 'ct-owner@probe.invalid', '${t}', '1.0', '{}'::jsonb);
        insert into r values ('${i}', 'accepted');
      exception when others then insert into r values ('${i}', 'REFUSED '||sqlstate); end $p$;`).join('\n');
    const [row] = sql(FIXTURE + asOwner + inserts + `
  select (select count(*)::int from r where outcome = 'accepted') as accepted,
         (select string_agg(outcome, ',') from r where outcome <> 'accepted') as failures;
rollback;`);
    assert.equal(row.accepted, types.length, `some legitimate events were refused: ${row.failures}`);
  });
});

/* ── 2. The protected event cannot be fabricated ────────────────────────── */

describe('a client cannot write its own acceptance', () => {
  test('THE DEFECT: direct insert of the protected event is refused', () => {
    const [row] = sql(FIXTURE + asOwner + `
  do $p$ begin
    insert into public.compliance_log (user_id, user_email, event_type, document_version, metadata)
    values ('${OWNER}', 'x', 'business.commercial_terms_accepted', '1.0',
            '{"business_id":"${BIZ_A}"}'::jsonb);
    insert into r values ('fabricate', 'ACCEPTED — HOLE');
  exception when others then insert into r values ('fabricate', 'refused '||sqlstate); end $p$;
  reset role;
  select (select outcome from r where label='fabricate') as outcome, ${commercialRows} as rows;
rollback;`);
    assert.equal(row.outcome, 'refused 42501');
    assert.equal(row.rows, 0, 'nothing was written');
  });

  test('nor by naming somebody else as the user', () => {
    const [row] = sql(FIXTURE + asOwner + `
  do $p$ begin
    insert into public.compliance_log (user_id, user_email, event_type, document_version, metadata)
    values ('${STRANGER}', 'x', 'business.commercial_terms_accepted', '1.0', '{}'::jsonb);
    insert into r values ('forge', 'ACCEPTED — HOLE');
  exception when others then insert into r values ('forge', 'refused'); end $p$;
  reset role;
  select (select outcome from r where label='forge') as outcome, ${commercialRows} as rows;
rollback;`);
    assert.equal(row.outcome, 'refused');
    assert.equal(row.rows, 0);
  });

  test('and an accepted record cannot be mutated or deleted by a client', () => {
    const [row] = sql(FIXTURE + asOwner + `
  perform_placeholder as (select 1);`.replace('perform_placeholder as (select 1);', '') + `
  select public.record_commercial_terms_acceptance('${BIZ_A}'::uuid);
  do $p$ begin
    update public.compliance_log set document_version = '9.9'
     where event_type = 'business.commercial_terms_accepted';
    insert into r values ('update', 'ACCEPTED — HOLE');
  exception when others then insert into r values ('update', 'refused'); end $p$;
  do $p$ begin
    delete from public.compliance_log where event_type = 'business.commercial_terms_accepted';
    insert into r values ('delete', 'ACCEPTED — HOLE');
  exception when others then insert into r values ('delete', 'refused'); end $p$;
  reset role;
  select (select count(*)::int from public.compliance_log
           where event_type='business.commercial_terms_accepted' and document_version='1.0') as still_v1,
         ${commercialRows} as rows;
rollback;`);
    // No UPDATE or DELETE policy exists, so both are no-ops rather than errors —
    // either way the record must survive untouched.
    assert.equal(row.rows, 1, 'the record survives');
    assert.equal(row.still_v1, 1, 'and its version was not rewritten');
  });
});

/* ── 3. The writer ──────────────────────────────────────────────────────── */

describe('only the protected writer may record acceptance', () => {
  test('an owner can accept for their own business, once', () => {
    const [row] = sql(FIXTURE + asOwner + `
  create temp table a on commit drop as
    select public.record_commercial_terms_acceptance('${BIZ_A}'::uuid) as v;
  reset role;
  select (select v->>'already' from a) as already, (select v->>'version' from a) as version,
         ${commercialRows} as rows;
rollback;`);
    assert.equal(row.already, 'false');
    assert.equal(row.version, '1.0');
    assert.equal(row.rows, 1, 'exactly one record');
  });

  test('a repeat call is idempotent and honest about it', () => {
    const [row] = sql(FIXTURE + asOwner + `
  create temp table a on commit drop as select
    (public.record_commercial_terms_acceptance('${BIZ_A}'::uuid))->>'already' as first,
    (public.record_commercial_terms_acceptance('${BIZ_A}'::uuid))->>'already' as second,
    (public.record_commercial_terms_acceptance('${BIZ_A}'::uuid))->>'already' as third;
  reset role;
  select (select first from a) as first, (select second from a) as second,
         (select third from a) as third, ${commercialRows} as rows;
rollback;`);
    assert.equal(row.first, 'false');
    assert.equal(row.second, 'true');
    assert.equal(row.third, 'true');
    assert.equal(row.rows, 1, 'still exactly one record');
  });

  test('an owner cannot accept for a business they do not own', () => {
    const [row] = sql(FIXTURE + asOwner + `
  do $p$ begin
    perform public.record_commercial_terms_acceptance('${BIZ_B}'::uuid);
    insert into r values ('other', 'ACCEPTED — HOLE');
  exception when others then insert into r values ('other', 'refused'); end $p$;
  reset role;
  select (select outcome from r where label='other') as outcome, ${commercialRows} as rows;
rollback;`);
    assert.equal(row.outcome, 'refused');
    assert.equal(row.rows, 0);
  });

  test('an anonymous caller is refused', () => {
    const [row] = sql(FIXTURE + `
  set local role anon;
  do $p$ begin
    perform public.record_commercial_terms_acceptance('${BIZ_A}'::uuid);
    insert into r values ('anon', 'ACCEPTED — HOLE');
  exception when others then insert into r values ('anon', 'refused'); end $p$;
  reset role;
  select (select outcome from r where label='anon') as outcome, ${commercialRows} as rows;
rollback;`);
    assert.equal(row.outcome, 'refused');
    assert.equal(row.rows, 0);
  });

  test('the caller cannot supply a user, an event type or a version', () => {
    // Not a runtime check — the parameters do not exist. One uuid, nothing else.
    const [row] = sql(`
      select pg_get_function_identity_arguments(p.oid) as args
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname='record_commercial_terms_acceptance';`);
    assert.equal(row.args, 'p_business_id uuid');
    assert.match(migration, /v_user\s+uuid := auth\.uid\(\)/);
    assert.match(migration, /v_version text := public\.commercial_terms_version\(\)/);
    assert.match(migration, /'business\.commercial_terms_accepted'/);
  });

  test('two businesses are accepted separately, and a new version is a new acceptance', () => {
    const [row] = sql(`
begin;
  insert into auth.users (id, email) values ('${OWNER}', 'ct-owner@probe.invalid');
  insert into public.local_businesses (id, owner_id, name, category, address, is_active) values
    ('${BIZ_A}', '${OWNER}', 'PROBE One', 'other', 'PROBE', true),
    ('${BIZ_B}', '${OWNER}', 'PROBE Two', 'other', 'PROBE', true);
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"${OWNER}","role":"authenticated"}';
  select public.record_commercial_terms_acceptance('${BIZ_A}'::uuid);
  select public.record_commercial_terms_acceptance('${BIZ_B}'::uuid);
  reset role;
  -- A later version is a distinct acceptance, not a duplicate.
  insert into public.compliance_log (user_id, user_email, event_type, document_version, metadata)
  values ('${OWNER}', 'x', 'business.commercial_terms_accepted', '2.0',
          jsonb_build_object('business_id', '${BIZ_A}'));
  select ${commercialRows} as rows,
         (select count(distinct metadata->>'business_id')::int from public.compliance_log
           where event_type='business.commercial_terms_accepted') as businesses,
         (select count(distinct document_version)::int from public.compliance_log
           where event_type='business.commercial_terms_accepted') as versions;
rollback;`);
    assert.equal(row.rows, 3);
    assert.equal(row.businesses, 2);
    assert.equal(row.versions, 2);
  });

  test('the record carries the right user, business, version and a timestamp', () => {
    const [row] = sql(FIXTURE + asOwner + `
  select public.record_commercial_terms_acceptance('${BIZ_A}'::uuid);
  reset role;
  select user_id::text as user_id, metadata->>'business_id' as business_id,
         document_version as version, (created_at is not null) as has_timestamp,
         user_email, description
    from public.compliance_log where event_type='business.commercial_terms_accepted';
rollback;`);
    assert.equal(row.user_id, OWNER);
    assert.equal(row.business_id, BIZ_A);
    assert.equal(row.version, '1.0');
    assert.equal(row.has_timestamp, true);
    assert.equal(row.user_email, 'ct-owner@probe.invalid');
    assert.match(String(row.description), /business & selling terms/i);
  });
});

/* ── 4. The index is the concurrency guarantee ──────────────────────────── */

describe('one acceptance per user, business and version', () => {
  test('the partial unique index exists and is scoped to this event only', () => {
    const [row] = sql(`
      select indexdef from pg_indexes
       where schemaname='public' and indexname='compliance_log_commercial_terms_once';`);
    assert.match(String(row.indexdef), /UNIQUE/);
    assert.match(String(row.indexdef), /user_id/);
    assert.match(String(row.indexdef), /document_version/);
    assert.match(String(row.indexdef), /business_id/);
    assert.match(String(row.indexdef), /WHERE \(event_type = 'business\.commercial_terms_accepted'/);
  });

  test('a duplicate is refused even when the writer is bypassed entirely', () => {
    // The writer's check-then-insert has a race window; this is what closes it.
    const [row] = sql(`
begin;
  insert into auth.users (id, email) values ('${OWNER}', 'ct-owner@probe.invalid');
  create temp table r(label text, outcome text) on commit drop;
  insert into public.compliance_log (user_id, user_email, event_type, document_version, metadata)
  values ('${OWNER}', 'x', 'business.commercial_terms_accepted', '1.0', '{"business_id":"${BIZ_A}"}'::jsonb);
  do $p$ begin
    insert into public.compliance_log (user_id, user_email, event_type, document_version, metadata)
    values ('${OWNER}', 'x', 'business.commercial_terms_accepted', '1.0', '{"business_id":"${BIZ_A}"}'::jsonb);
    insert into r values ('dup', 'ACCEPTED — NOT IDEMPOTENT');
  exception when unique_violation then insert into r values ('dup', 'refused by index');
  end $p$;
  select (select outcome from r where label='dup') as outcome, ${commercialRows} as rows;
rollback;`);
    assert.equal(row.outcome, 'refused by index');
    assert.equal(row.rows, 1);
  });

  test('the writer answers honestly if the index beats it to the insert', () => {
    assert.match(migration, /exception when unique_violation then[\s\S]{0,300}'already', true/);
  });
});

/* ── 5. The read helper, and what it is NOT wired to ────────────────────── */

describe('reading the answer, without gating anything yet', () => {
  test('it answers true only after acceptance, for that business', () => {
    const [row] = sql(FIXTURE + asOwner + `
  create temp table q on commit drop as select
    public.has_accepted_commercial_terms('${BIZ_A}'::uuid) as before_accept;
  select public.record_commercial_terms_acceptance('${BIZ_A}'::uuid);
  create temp table q2 on commit drop as select
    public.has_accepted_commercial_terms('${BIZ_A}'::uuid) as after_accept,
    public.has_accepted_commercial_terms('${BIZ_B}'::uuid) as other_business;
  reset role;
  select (select before_accept from q) as before_accept,
         (select after_accept from q2) as after_accept,
         (select other_business from q2) as other_business;
rollback;`);
    assert.equal(row.before_accept, false);
    assert.equal(row.after_accept, true);
    assert.equal(row.other_business, false);
  });

  test('NO commercial-write policy has been changed — the gate is not live', () => {
    const rows = sql(`
      select c.relname as tbl,
             coalesce(pg_get_expr(p.polwithcheck,p.polrelid), pg_get_expr(p.polqual,p.polrelid)) as expr
        from pg_policy p join pg_class c on c.oid=p.polrelid
       where c.relname in ('products','product_variants','business_shipping','book_services',
                           'book_unit_items','book_availability_rules','local_offers',
                           'local_loyalty_programs','events','local_businesses')
         and p.polcmd <> 'r';`);
    assert.ok(rows.length >= 10, 'the commercial policies were found');
    for (const r of rows) {
      assert.ok(!/has_accepted_commercial_terms|business_may_transact|commercial_terms/.test(String(r.expr)),
        `${r.tbl} is already gated — commercial enforcement must not be live yet`);
    }
  });
});

/* ── 6. One version, three places ───────────────────────────────────────── */

describe('the version has one source of truth', () => {
  test('the database holds it', () => {
    const [row] = sql(`select public.commercial_terms_version() as v;`);
    assert.equal(row.v, '1.0');
  });

  test('and web and app only mirror it', () => {
    const [row] = sql(`select public.commercial_terms_version() as v;`);
    assert.match(readWeb('lib/compliance.ts'),
      new RegExp(`COMMERCIAL_TERMS_VERSION = "${row.v}"`));
    assert.match(read('lib/compliance.ts'),
      new RegExp(`COMMERCIAL_TERMS_VERSION = '${row.v}'`));
  });
});

/* ── 7. The Terms themselves ────────────────────────────────────────────── */

describe('the terms say what is being accepted', () => {
  test('the commercial section exists at 11, and later sections renumbered', () => {
    assert.match(terms, /<L h="11\. Businesses &amp; selling on OneShetland">/);
    for (const [n, t] of [[12, 'AI features'], [15, 'Liability'], [18, 'Contact']] as const) {
      assert.ok(terms.includes(`<L h="${n}. ${t}">`), `section ${n} ${t}`);
    }
    assert.equal((terms.match(/<L h=/g) ?? []).length, 18, 'seventeen sections became eighteen');
  });

  test('it covers what W3C found missing', () => {
    const sec = terms.slice(terms.indexOf('<L h="11.'), terms.indexOf('<L h="12.'));
    for (const [label, re] of [
      ['authority',    /authorised to act for the business/i],
      ['accuracy',     /descriptions, prices, availability/i],
      ['legality',     /must be lawful/i],
      ['trader',       /You&rsquo;re the trader in that transaction/i],
      ['fulfilment',   /responsible for providing what you&rsquo;ve offered/i],
      ['refunds',      /Cancellations, returns and refunds/i],
      ['tax',          /Your tax position is your own/i],
      ['disputes',     /doesn&rsquo;t make us the seller/i],
      ['removal',      /remove a listing, product, service, pass, offer or event/i],
    ] as const) assert.match(sec, re, `missing: ${label}`);
  });

  test('it does not turn a Directory-only owner into a seller', () => {
    const sec = terms.slice(terms.indexOf('<L h="11.'), terms.indexOf('<L h="12.'));
    assert.match(sec, /does not apply to simply having a Directory listing/i);
    assert.match(terms, /Having a listing doesn&rsquo;t oblige you to sell anything/);
  });

  test('it invents none of the things it was told not to', () => {
    const sec = terms.slice(terms.indexOf('<L h="11.'), terms.indexOf('<L h="12.'));
    for (const banned of [/within \d+ days/i, /\d+ hours/i, /insurance/i, /VAT[- ]registered/i,
                          /chargeback fee/i, /reserve/i, /payout hold/i]) {
      assert.ok(!banned.test(sec), `invented an obligation: ${banned}`);
    }
  });

  test('the three minimal amendments landed', () => {
    assert.match(terms, /remove accounts, and remove listings or individual items, that breach these terms/);
    assert.match(terms, /Section 11 sets out what businesses selling through OneShetland are responsible for/);
    assert.match(terms, /if you choose to, section 11 applies/);
  });

  test('the solicitor-review warning is still there', () => {
    assert.match(readWeb('components/site/LegalLayout.tsx'), /reviewed by a solicitor before launch/);
  });
});
