/**
 * job-shift-boost.node.test.ts — paid job and shift promotion is server-managed.
 *
 * WHAT WAS WRONG (F2, the final clean-room audit's only HIGH)
 *
 * jobs.is_featured, jobs.boosted_until and shifts.boosted_until carry
 * column-level UPDATE grants to authenticated, and both tables have an
 * owner-scoped UPDATE policy. Neither table had a column lock, so an employer
 * could grant themselves the paid promotion with one PostgREST call:
 *
 *     control: owner edits own title     ALLOWED (1)
 *     owner sets is_featured=true        ALLOWED (1)
 *     owner sets boosted_until           ALLOWED (1)
 *
 * The intended path is create-boost-intent → payment → confirm-boost (or
 * wallet-checkout), where the SERVICE ROLE writes the boost only after the
 * Stripe PaymentIntent is verified. The direct write skipped the payment.
 *
 * Same defect as C2 on local_businesses; same fix as Step 2, reusing
 * tg_is_trusted_writer().
 *
 * THE TRAP THIS GUARDS
 *
 * A lock marked SECURITY DEFINER runs as its owner, so current_user becomes
 * 'postgres', tg_is_trusted_writer() returns true for every caller, and the
 * lock silently protects nothing while looking correct. One test below asserts
 * both functions are INVOKER, because that failure mode is invisible otherwise.
 *
 * SAFETY
 * Every write happens inside a transaction that is never committed, against
 * synthetic rows. Nothing here touches a real listing, and the routine suite
 * stays production-row safe. No Stripe object is created.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

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
 * Creates a synthetic job and shift owned by a real account, acts on them as
 * that account through the same role and JWT claims PostgREST would set, and
 * rolls the whole thing back.
 */
const SCENARIO = `
begin;
create temp table r(step text, outcome text);
do $$
declare u1 uuid; u2 uuid; jid uuid; sid uuid; n int; mal_j uuid; mal_s uuid;
        v_feat boolean; v_boost timestamptz; v_title text;
begin
  select id into u1 from auth.users order by created_at limit 1;
  select id into u2 from auth.users order by created_at desc limit 1;

  insert into public.jobs (id, title, employer_id)
    values (gen_random_uuid(), 'probe job', u1) returning id into jid;
  insert into public.shifts (id, title, employer_id, category, location_text, start_at, end_at)
    values (gen_random_uuid(), 'probe shift', u1, 'general', 'Lerwick',
            now() + interval '1 day', now() + interval '2 days') returning id into sid;

  perform set_config('role','authenticated',true);
  perform set_config('request.jwt.claims', json_build_object('sub',u1,'role','authenticated')::text, true);
  update public.jobs   set title='owner edited this' where id=jid;
  update public.jobs   set is_featured=true where id=jid;
  update public.jobs   set boosted_until=now()+interval '30 days' where id=jid;
  update public.shifts set title='owner edited shift' where id=sid;
  update public.shifts set boosted_until=now()+interval '30 days' where id=sid;
  begin
    insert into public.jobs (id,title,employer_id,is_featured,boosted_until)
      values (gen_random_uuid(),'malicious job',u1,true,now()+interval '30 days') returning id into mal_j;
  exception when others then mal_j := null; end;
  begin
    insert into public.shifts (id,title,employer_id,category,location_text,start_at,end_at,boosted_until)
      values (gen_random_uuid(),'malicious shift',u1,'general','Lerwick',
              now()+interval '1 day',now()+interval '2 days',now()+interval '30 days') returning id into mal_s;
  exception when others then mal_s := null; end;
  perform set_config('role','postgres',true);

  select title,is_featured,boosted_until into v_title,v_feat,v_boost from public.jobs where id=jid;
  insert into r values ('job_title_edit',    case when v_title='owner edited this' then 'allowed' else 'blocked' end);
  insert into r values ('job_is_featured',   case when v_feat then 'bypass' else 'preserved' end);
  insert into r values ('job_boosted_until', case when v_boost is null then 'preserved' else 'bypass' end);

  select title,boosted_until into v_title,v_boost from public.shifts where id=sid;
  insert into r values ('shift_title_edit',    case when v_title='owner edited shift' then 'allowed' else 'blocked' end);
  insert into r values ('shift_boosted_until', case when v_boost is null then 'preserved' else 'bypass' end);

  insert into r values ('job_malicious_insert',
    case when mal_j is null then 'rejected'
         else (select case when is_featured or boosted_until is not null then 'bypass' else 'defaults' end
                 from public.jobs where id=mal_j) end);
  insert into r values ('shift_malicious_insert',
    case when mal_s is null then 'rejected'
         else (select case when boosted_until is not null then 'bypass' else 'defaults' end
                 from public.shifts where id=mal_s) end);

  perform set_config('role','authenticated',true);
  perform set_config('request.jwt.claims', json_build_object('sub',u2,'role','authenticated')::text, true);
  update public.jobs set title='stranger' where id=jid; get diagnostics n = row_count;
  perform set_config('role','postgres',true);
  insert into r values ('cross_owner_update', case when n=0 then 'denied' else 'allowed' end);

  perform set_config('role','service_role',true);
  perform set_config('request.jwt.claims', null, true);
  update public.jobs   set boosted_until=now()+interval '24 hours', is_featured=true where id=jid;
  update public.shifts set boosted_until=now()+interval '24 hours' where id=sid;
  perform set_config('role','postgres',true);
  insert into r values ('service_role_job',
    (select case when is_featured and boosted_until is not null then 'applied' else 'blocked' end from public.jobs where id=jid));
  insert into r values ('service_role_shift',
    (select case when boosted_until is not null then 'applied' else 'blocked' end from public.shifts where id=sid));
end $$;
select step, outcome from r;
`;

let cached: Record<string, string> | null = null;
function scenario(): Record<string, string> {
  if (!cached) {
    cached = Object.fromEntries(runSql(SCENARIO).map((r) => [String(r.step), String(r.outcome)]));
  }
  return cached;
}

// ── jobs ────────────────────────────────────────────────────────────────────

describe('jobs: paid promotion is not self-service', () => {
  test('an employer can still edit their own listing', () => {
    // The control. Without this, "blocked" below could just mean the harness
    // never had a writable row — which is exactly how the original probe lied.
    assert.equal(scenario().job_title_edit, 'allowed');
  });

  test('an employer cannot set is_featured', () => {
    assert.equal(scenario().job_is_featured, 'preserved');
  });

  test('an employer cannot set boosted_until', () => {
    assert.equal(scenario().job_boosted_until, 'preserved');
  });

  test('a job cannot be created with paid state already set', () => {
    assert.ok(['defaults', 'rejected'].includes(scenario().job_malicious_insert),
      'INSERT must force safe defaults rather than accept seeded promotion');
  });

  test('the trusted writer can still apply a paid boost', () => {
    assert.equal(scenario().service_role_job, 'applied',
      'if this fails, confirm-boost cannot deliver what a customer paid for');
  });
});

// ── shifts ──────────────────────────────────────────────────────────────────

describe('shifts: paid promotion is not self-service', () => {
  test('an employer can still edit their own shift', () => {
    assert.equal(scenario().shift_title_edit, 'allowed');
  });

  test('an employer cannot set boosted_until', () => {
    assert.equal(scenario().shift_boosted_until, 'preserved');
  });

  test('a shift cannot be created with a boost already set', () => {
    assert.ok(['defaults', 'rejected'].includes(scenario().shift_malicious_insert));
  });

  test('the trusted writer can still apply a paid boost', () => {
    assert.equal(scenario().service_role_shift, 'applied');
  });
});

// ── the guard itself ────────────────────────────────────────────────────────

describe('the locks are installed the way they must be', () => {
  test('both locks exist, are attached, and are SECURITY INVOKER', () => {
    const r = one(`
      select
        (select count(*)::text from pg_trigger g join pg_class c on c.oid=g.tgrelid
          where c.relname='jobs'   and g.tgname='lock_job_columns')   as job_trigger,
        (select count(*)::text from pg_trigger g join pg_class c on c.oid=g.tgrelid
          where c.relname='shifts' and g.tgname='lock_shift_columns') as shift_trigger,
        (select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          where n.nspname='public' and p.proname in ('tg_lock_job_columns','tg_lock_shift_columns')
            and p.prosecdef)                                          as definer_count,
        (select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          where n.nspname='public' and p.proname in ('tg_lock_job_columns','tg_lock_shift_columns')
            and p.proconfig is not null)                              as pinned_count;`);
    assert.equal(r.job_trigger, '1', 'the jobs lock is not attached');
    assert.equal(r.shift_trigger, '1', 'the shifts lock is not attached');
    assert.equal(r.definer_count, '0',
      'SECURITY DEFINER makes current_user the owner, so tg_is_trusted_writer() returns true for everyone and the lock protects nothing');
    assert.equal(r.pinned_count, '2', 'both locks need a pinned search_path');
  });

  test('every protected field is named by both locks', () => {
    const r = one(`
      select
        (select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          where n.nspname='public' and p.proname='tg_lock_job_columns')   as job_src,
        (select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          where n.nspname='public' and p.proname='tg_lock_shift_columns') as shift_src;`);
    for (const f of ['is_featured', 'boosted_until']) {
      assert.match(String(r.job_src), new RegExp(f), `the jobs lock does not cover ${f}`);
    }
    assert.match(String(r.shift_src), /boosted_until/, 'the shifts lock does not cover boosted_until');
  });

  test('no production listing carries paid state that was never paid for', () => {
    // This used to assert both counts were zero, which was true only because
    // nobody had bought a boost yet. The first real £2.99 purchase made it fail
    // — correctly: it is a tripwire, and a shift had genuinely changed. What it
    // should assert is not "none", but "none without a payment behind it".
    //
    // Jobs stay at zero: no code path sells jobs.is_featured or
    // jobs.boosted_until at all, so any value there would be a bypass.
    //
    // Shifts must each trace back to a payment — a card boost claimed in
    // consumed_payment_intents, or a wallet debit described by wallet-checkout.
    const r = one(`
      select (select count(*)::text from public.jobs where is_featured or boosted_until is not null) as paid_jobs,
             (select count(*)::text from public.shifts where boosted_until is not null)              as boosted_shifts,
             (select count(*)::text
                from public.shifts s
               where s.boosted_until is not null
                 and not exists (
                   select 1 from public.consumed_payment_intents c
                    where c.purpose = 'shift_boost' and c.user_id = s.employer_id)
                 and not exists (
                   select 1 from public.local_wallet_transactions w
                    where w.user_id = s.employer_id
                      and w.description = 'Shift boost (24h)')
             ) as unpaid_shifts;`);
    assert.equal(r.paid_jobs, '0');
    assert.equal(r.unpaid_shifts, '0',
      `${r.unpaid_shifts} of ${r.boosted_shifts} boosted shifts have no payment behind them`);
  });
});
