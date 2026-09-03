/**
 * booking-capacity-concurrency.node.test.ts — a place can only be taken once.
 *
 * WHAT WAS WRONG
 *
 * Both clients booked like this:
 *
 *   const free = await isSlotAvailable(...);    // read,  its own transaction
 *   if (!free) throw ...;
 *   await sb.from('book_bookings').insert(...)  // write, its own transaction
 *
 * A counting SELECT takes no locks. Two customers read the same count and both
 * proceed. Proved against an isolated capacity-1 fixture before the fix: two
 * sessions both saw taken=0, both inserted 127 ms apart, and a service with one
 * chair had two confirmed bookings in it.
 *
 * The fix is a BEFORE INSERT OR UPDATE trigger rather than an RPC, because an
 * RPC only protects callers who use it and installed mobile builds insert
 * straight into the table. The lock is keyed on the SERVICE, not on starts_at:
 * 10:00-10:30 and 10:15-10:45 compete for the same place without sharing a
 * start, so a start-scoped lock would put them in different queues.
 *
 * WHAT IS ASSERTED
 *   · two genuinely concurrent attempts on one place: one wins, one is refused
 *   · two concurrent OVERLAPPING attempts with DIFFERENT starts: same
 *   · capacity 2 admits two and refuses the third, concurrently
 *   · bookings that do not overlap both succeed
 *   · completed / cancelled / no_show free the place, as they always have
 *
 * Concurrency is real: each attempt is a separate OS process holding its own
 * connection, launched together. Nothing here is sequential and relabelled.
 *
 * SAFETY
 * Builds an INACTIVE fixture business with its own services, and removes it in
 * after(), asserting the row is gone. No existing booking is read, moved or
 * touched.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SLUG = 'zz-capacity-concurrency';

function rowsOf(out: string): Record<string, unknown>[] {
  const parsed = JSON.parse(out.slice(out.indexOf('{'))) as
    { rows?: Record<string, unknown>[]; error?: unknown };
  if (parsed.error) throw new Error(JSON.stringify(parsed.error).slice(0, 300));
  return parsed.rows ?? [];
}
/**
 * Where to run. Unset, this is the linked project like every other suite.
 * BOOKING_PROOF_DSN points it at a throwaway Postgres instead — which is how
 * the guard was proved before it was ever allowed near production, and how it
 * can be re-proved without booking anything real.
 */
const DSN = process.env.BOOKING_PROOF_DSN ?? '';
const PSQL = process.env.BOOKING_PROOF_PSQL ?? 'psql';

/**
 * Every body ends with jsonRows(...), so both targets hand back the same shape:
 * one cell containing a JSON array. psql prints a command tag per statement and
 * supabase db query wraps rows in an envelope; normalising at the source means
 * neither quirk reaches a test.
 */
export const jsonRows = (finalSelect: string) =>
  `select coalesce(json_agg(x)::text, '[]') as j from (${finalSelect}) x;`;

const invoke = (body: string): [string, string[]] => DSN
  ? [PSQL, [DSN, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=0', '-c', body]]
  : ['npx', ['supabase', 'db', 'query', '--linked', body, '--output-format', 'json']];

function parse(out: string): Record<string, unknown>[] {
  const text = DSN
    ? (out.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('[') || l === '[]').pop() ?? '[]')
    : String((rowsOf(out)[0] ?? {}).j ?? '[]');
  return JSON.parse(text || '[]') as Record<string, unknown>[];
}

function sql(body: string): Record<string, unknown>[] {
  const [bin, a] = invoke(body);
  return parse(execFileSync(bin, a,
    { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 240_000 }));
}
/** A separate process, and therefore a separate connection and transaction. */
async function sqlAsync(body: string): Promise<Record<string, unknown>[]> {
  const [bin, a] = invoke(body);
  const { stdout } = await execFileAsync(bin, a, { cwd: REPO_ROOT, encoding: 'utf8', timeout: 240_000 });
  return parse(stdout);
}

const one = (body: string) => sql(body)[0] ?? {};

let biz = '';
let customer = '';
const svc: Record<string, string> = {};

/**
 * One booking attempt, shaped exactly like the clients: read availability,
 * pause, then insert. The pause stands in for the network round trip that
 * separates those two steps in production, so the attempts genuinely overlap
 * instead of relying on luck.
 */
const attempt = (serviceId: string, startsAt: string, endsAt: string) => `
  create temp table decision as
    select (select count(*) from public.book_bookings
              where service_id='${serviceId}'::uuid
                and starts_at < '${endsAt}'::timestamptz and ends_at > '${startsAt}'::timestamptz
                and status in ('confirmed','pending_payment')) as taken,
           (select capacity from public.book_services where id='${serviceId}'::uuid) as cap;
  select pg_sleep(2);
  create temp table refused (msg text);
  do $do$
  begin
    if (select taken < cap from decision) then
      insert into public.book_bookings
        (business_id, service_id, customer_id, starts_at, ends_at, status, price_pence)
      values ('${biz}'::uuid, '${serviceId}'::uuid, '${customer}'::uuid,
              '${startsAt}'::timestamptz, '${endsAt}'::timestamptz, 'confirmed', 1000);
    end if;
  exception when others then
    insert into refused values (sqlerrm);
  end $do$;
  ${jsonRows("select coalesce((select 'refused: ' || left(msg, 40) from refused limit 1), 'accepted') as outcome")}`;

const consuming = (serviceId: string, startsAt: string, endsAt: string): number =>
  Number(one(jsonRows(`select count(*)::text as n from public.book_bookings
               where service_id='${serviceId}'::uuid
                 and starts_at < '${endsAt}'::timestamptz and ends_at > '${startsAt}'::timestamptz
                 and status in ('confirmed','pending_payment')`)).n);

const clear = (serviceId: string) =>
  sql(`delete from public.book_bookings where service_id='${serviceId}'::uuid;
       ${jsonRows('select 1 as done')}`);

before(() => {
  const r = one(`
    with owner as (select id from public.profiles order by id offset 0 limit 1),
         cust  as (select id from public.profiles order by id offset 5 limit 1),
         b as (
           insert into public.local_businesses
             (id,name,slug,category,address,owner_id,subscription_tier,subscription_until,is_active,accepts_bookings)
           select gen_random_uuid(),'ZZ Capacity Concurrency','${SLUG}','other','Lerwick',
                  id,'premium', now() + interval '30 days', false, true from owner
           returning id),
         s1 as (
           insert into public.book_services
             (business_id,name,duration_minutes,buffer_minutes,price_pence,deposit_pence,requires_deposit,capacity,is_active)
           select id,'one place',30,0,1000,0,false,1,true from b returning id),
         s2 as (
           insert into public.book_services
             (business_id,name,duration_minutes,buffer_minutes,price_pence,deposit_pence,requires_deposit,capacity,is_active)
           select id,'two places',30,0,1000,0,false,2,true from b returning id)
    ${jsonRows(`select (select id from b)::text as biz, (select id from s1)::text as s1,
           (select id from s2)::text as s2, (select id from cust)::text as cust`)}`);
  biz = String(r.biz); customer = String(r.cust);
  svc.one = String(r.s1); svc.two = String(r.s2);
  assert.match(biz, /^[0-9a-f-]{36}$/, 'the fixture business was not created');
});

after(() => {
  sql(`delete from public.book_bookings b using public.local_businesses lb
        where lb.id = b.business_id and lb.slug = '${SLUG}';
       delete from public.book_services s using public.local_businesses lb
        where lb.id = s.business_id and lb.slug = '${SLUG}';
       delete from public.local_businesses where slug = '${SLUG}';
       ${jsonRows('select 1 as done')}`);
  const left = one(jsonRows(`select count(*)::text as n from public.local_businesses where slug='${SLUG}'`));
  assert.equal(left.n, '0', 'the capacity fixture leaked into production');
});

describe('the database is the one that decides', () => {
  test('the guard exists on the table, not only in a function nobody has to call', () => {
    const t = one(jsonRows(`
      select count(*)::text as n from pg_trigger t join pg_class c on c.oid=t.tgrelid
       where c.relname='book_bookings' and t.tgname='book_capacity_guard'
         and (t.tgtype & 2) > 0 and (t.tgtype & 4) > 0`));
    assert.equal(t.n, '1', 'no BEFORE INSERT capacity trigger — a direct insert is unprotected');
  });

  test('it runs as definer with a pinned search_path, because RLS hides other customers', () => {
    const d = one(jsonRows(`select pg_get_functiondef('public.book_capacity_guard'::regproc) as d`));
    assert.match(String(d.d), /SECURITY DEFINER/i, 'as the caller it would count only their own bookings');
    assert.match(String(d.d), /SET search_path TO ['"]?public/i, 'search_path is not pinned');
  });

  test('the lock is keyed on the service, not on the start time', () => {
    const d = one(jsonRows(`select pg_get_functiondef('public.book_capacity_guard'::regproc) as d`));
    assert.match(String(d.d), /pg_advisory_xact_lock/, 'nothing serialises competing attempts');
    assert.match(String(d.d), /book_capacity:' \|\| new\.service_id/,
      'the lock key must be the service — overlapping bookings need not share a start time');
  });
});

describe('CASE A — one place, two people, at the same moment', () => {
  test('exactly one wins and exactly one is refused', async () => {
    clear(svc.one);
    const s = '2026-12-01 10:00:00+00', e = '2026-12-01 10:30:00+00';
    const [a, b] = await Promise.all([sqlAsync(attempt(svc.one, s, e)), sqlAsync(attempt(svc.one, s, e))]);
    const outcomes = [String(a[0]?.outcome), String(b[0]?.outcome)].sort();

    assert.equal(consuming(svc.one, s, e), 1,
      `capacity 1 ended up with ${consuming(svc.one, s, e)} bookings`);
    assert.equal(outcomes.filter((o) => o === 'accepted').length, 1, `outcomes: ${outcomes.join(', ')}`);
    assert.equal(outcomes.filter((o) => o.startsWith('refused')).length, 1, `outcomes: ${outcomes.join(', ')}`);
    assert.match(outcomes.find((o) => o.startsWith('refused'))!, /slot_full/,
      'the loser was refused for some reason other than the slot being full');
  });
});

describe('CASE B — overlapping, but not starting together', () => {
  test('only one of two concurrent overlapping bookings survives', async () => {
    // 10:00-10:30 against 10:15-10:45. A lock keyed on starts_at would file
    // these under different keys and let both through; this is the case that
    // makes the key the service.
    clear(svc.one);
    const [a, b] = await Promise.all([
      sqlAsync(attempt(svc.one, '2026-12-01 10:00:00+00', '2026-12-01 10:30:00+00')),
      sqlAsync(attempt(svc.one, '2026-12-01 10:15:00+00', '2026-12-01 10:45:00+00')),
    ]);
    const outcomes = [String(a[0]?.outcome), String(b[0]?.outcome)];
    const n = Number(one(jsonRows(`select count(*)::text as n from public.book_bookings
                           where service_id='${svc.one}'::uuid and status in ('confirmed','pending_payment')`)).n);
    assert.equal(n, 1, `two overlapping bookings were both accepted (${outcomes.join(', ')})`);
    assert.equal(outcomes.filter((o) => o.startsWith('refused')).length, 1, outcomes.join(', '));
  });
});

describe('CASE C — two places, three people', () => {
  test('two are seated and the third is refused', async () => {
    clear(svc.two);
    const s = '2026-12-01 10:00:00+00', e = '2026-12-01 10:30:00+00';
    const outs = (await Promise.all([
      sqlAsync(attempt(svc.two, s, e)), sqlAsync(attempt(svc.two, s, e)), sqlAsync(attempt(svc.two, s, e)),
    ])).map((r) => String(r[0]?.outcome));

    assert.equal(consuming(svc.two, s, e), 2, `capacity 2 admitted ${consuming(svc.two, s, e)}`);
    assert.equal(outs.filter((o) => o === 'accepted').length, 2, outs.join(', '));
    assert.equal(outs.filter((o) => o.startsWith('refused')).length, 1, outs.join(', '));
  });
});

describe('CASE D — bookings that do not overlap', () => {
  test('both are accepted, concurrently', async () => {
    clear(svc.one);
    const outs = (await Promise.all([
      sqlAsync(attempt(svc.one, '2026-12-02 10:00:00+00', '2026-12-02 10:30:00+00')),
      sqlAsync(attempt(svc.one, '2026-12-02 10:30:00+00', '2026-12-02 11:00:00+00')),
    ])).map((r) => String(r[0]?.outcome));
    assert.deepEqual(outs, ['accepted', 'accepted'],
      `back-to-back bookings must both stand: ${outs.join(', ')}`);
    const n = Number(one(jsonRows(`select count(*)::text as n from public.book_bookings
                           where service_id='${svc.one}'::uuid and status in ('confirmed','pending_payment')`)).n);
    assert.equal(n, 2);
  });
});

describe('the UPDATE path cannot walk around the guard', () => {
  const S = '2026-12-05 10:00:00+00', E = '2026-12-05 10:30:00+00';

  /** Seat one booking, then try to move a second onto it by UPDATE. */
  const moveOnto = (setClause: string, seed: { starts: string; ends: string; status?: string; service?: string }) => {
    clear(svc.one); clear(svc.two);
    sql(`insert into public.book_bookings
           (business_id,service_id,customer_id,starts_at,ends_at,status,price_pence)
         values ('${biz}'::uuid,'${svc.one}'::uuid,'${customer}'::uuid,
                 '${S}'::timestamptz,'${E}'::timestamptz,'confirmed',1000);
         insert into public.book_bookings
           (id,business_id,service_id,customer_id,starts_at,ends_at,status,price_pence)
         values ('11111111-2222-3333-4444-555555555555'::uuid,'${biz}'::uuid,
                 '${seed.service ?? svc.one}'::uuid,'${customer}'::uuid,
                 '${seed.starts}'::timestamptz,'${seed.ends}'::timestamptz,
                 '${seed.status ?? 'confirmed'}',1000);
         ${jsonRows('select 1 as done')}`);
    return one(`
      create temp table refused (msg text);
      do $do$ begin
        update public.book_bookings set ${setClause}
         where id='11111111-2222-3333-4444-555555555555'::uuid;
      exception when others then insert into refused values (sqlerrm);
      end $do$;
      ${jsonRows("select coalesce((select 'refused' from refused limit 1), 'ALLOWED') as outcome")}`).outcome;
  };

  test('moving starts_at/ends_at onto an occupied place is refused', () => {
    // The booking starts life somewhere harmless, then tries to slide on top.
    assert.equal(moveOnto(`starts_at='${S}'::timestamptz, ends_at='${E}'::timestamptz`,
      { starts: '2026-12-05 14:00:00+00', ends: '2026-12-05 14:30:00+00' }), 'refused');
  });

  test('moving service_id onto an occupied place is refused', () => {
    // Same time, wrong service, then switched to the busy one.
    assert.equal(moveOnto(`service_id='${svc.one}'::uuid`,
      { starts: S, ends: E, service: svc.two }), 'refused');
  });

  test('reviving a cancelled booking into a taken place is refused', () => {
    assert.equal(moveOnto(`status='confirmed'`,
      { starts: S, ends: E, status: 'cancelled' }), 'refused');
  });

  test('but an ordinary edit that consumes nothing new still goes through', () => {
    clear(svc.one);
    sql(`insert into public.book_bookings
           (id,business_id,service_id,customer_id,starts_at,ends_at,status,price_pence)
         values ('22222222-2222-3333-4444-555555555555'::uuid,'${biz}'::uuid,'${svc.one}'::uuid,
                 '${customer}'::uuid,'${S}'::timestamptz,'${E}'::timestamptz,'confirmed',1000);
         ${jsonRows('select 1 as done')}`);
    const r = one(`
      create temp table refused (msg text);
      do $do$ begin
        update public.book_bookings set price_pence = 1200
         where id='22222222-2222-3333-4444-555555555555'::uuid;
      exception when others then insert into refused values (sqlerrm);
      end $do$;
      ${jsonRows("select coalesce((select 'refused' from refused limit 1), 'allowed') as outcome")}`);
    assert.equal(r.outcome, 'allowed', 'the guard refused a booking that took no new place');
    clear(svc.one);
  });
});

describe('RLS cannot make the guard under-count', () => {
  test('a customer who cannot SEE the booking in the way is still refused', () => {
    // The whole reason the guard is SECURITY DEFINER. Customer B cannot select
    // customer A's booking, so a guard running as the caller would count zero
    // and wave them in. Run the insert as authenticated, as B, and see.
    clear(svc.one);
    const S = '2026-12-06 10:00:00+00', E = '2026-12-06 10:30:00+00';
    // Neither the customer nor the OWNER: an owner sees every booking of their
    // own business by policy, which would hide the thing this test is for.
    const other = String(one(jsonRows(
      `select p.id::text as id from public.profiles p
        where p.id <> '${customer}'::uuid
          and p.id <> (select owner_id from public.local_businesses where id='${biz}'::uuid)
        order by p.id limit 1`)).id);

    sql(`insert into public.book_bookings
           (business_id,service_id,customer_id,starts_at,ends_at,status,price_pence)
         values ('${biz}'::uuid,'${svc.one}'::uuid,'${customer}'::uuid,
                 '${S}'::timestamptz,'${E}'::timestamptz,'confirmed',1000);
         ${jsonRows('select 1 as done')}`);

    const r = one(`
      create temp table refused (msg text);
      grant insert on refused to authenticated;
      -- book_bookings_tier_guard waves through anything with a null auth.uid()
      -- as server-side and trusted, and refuses an inactive business for
      -- everyone else. This test has to arrive as a real customer, so the
      -- fixture is active for exactly these few statements and is put back
      -- below — it must never be visible in a live Directory.
      update public.local_businesses set is_active = true where id='${biz}'::uuid;
      create temp table seen (n int);
      grant insert on seen to authenticated;
      -- Session role, not SET LOCAL: each psql statement is its own
      -- transaction here, so a local setting would be gone by the next line.
      set role authenticated;
      select set_config('request.jwt.claims',
        json_build_object('sub','${other}','role','authenticated')::text, false);
      insert into seen
        select count(*)::int from public.book_bookings
         where service_id='${svc.one}'::uuid and status in ('confirmed','pending_payment');
      do $do$ begin
        insert into public.book_bookings
          (business_id,service_id,customer_id,starts_at,ends_at,status,price_pence)
        values ('${biz}'::uuid,'${svc.one}'::uuid,'${other}'::uuid,
                '${S}'::timestamptz,'${E}'::timestamptz,'confirmed',1000);
      exception when others then insert into refused values (sqlerrm);
      end $do$;
      reset role;
      update public.local_businesses set is_active = false where id='${biz}'::uuid;
      ${jsonRows(`select (select n from seen)::text as visible_to_them,
                         coalesce((select left(msg, 60) from refused limit 1), 'ALLOWED') as outcome`)}`);

    assert.equal(r.visible_to_them, '0',
      'this test proves nothing unless RLS really did hide the other booking');
    // Not merely "refused": a permission error would also refuse, and would
    // pass this test while proving nothing about capacity.
    assert.match(String(r.outcome), /slot_full/,
      `expected the capacity guard to refuse this, got: ${String(r.outcome)}`);
    clear(svc.one);
  });
});

describe('CASE E — a place a terminal booking is not using', () => {
  test('completed, cancelled and no_show all free it, exactly as before', () => {
    const s = '2026-12-03 10:00:00+00', e = '2026-12-03 10:30:00+00';
    for (const terminal of ['completed', 'cancelled', 'no_show']) {
      clear(svc.one);
      sql(`insert into public.book_bookings
             (business_id,service_id,customer_id,starts_at,ends_at,status,price_pence)
           values ('${biz}'::uuid,'${svc.one}'::uuid,'${customer}'::uuid,
                   '${s}'::timestamptz,'${e}'::timestamptz,'${terminal}',1000);
           ${jsonRows('select 1 as done')}`);
      const r = one(`
        create temp table refused (msg text);
        do $do$ begin
          insert into public.book_bookings
            (business_id,service_id,customer_id,starts_at,ends_at,status,price_pence)
          values ('${biz}'::uuid,'${svc.one}'::uuid,'${customer}'::uuid,
                  '${s}'::timestamptz,'${e}'::timestamptz,'confirmed',1000);
        exception when others then
          insert into refused values (sqlerrm);
        end $do$;
        ${jsonRows("select coalesce((select 'refused' from refused limit 1), 'accepted') as outcome")}`);
      assert.equal(r.outcome, 'accepted', `a ${terminal} booking is still holding the place`);
    }
    clear(svc.one);
  });

  test('a metering write on a live booking is not refused by its own reflection', () => {
    clear(svc.one);
    const s = '2026-12-04 10:00:00+00', e = '2026-12-04 10:30:00+00';
    sql(`insert into public.book_bookings
           (business_id,service_id,customer_id,starts_at,ends_at,status,price_pence)
         values ('${biz}'::uuid,'${svc.one}'::uuid,'${customer}'::uuid,
                 '${s}'::timestamptz,'${e}'::timestamptz,'confirmed',1000);
         ${jsonRows('select 1 as done')}`);
    const r = one(`
      create temp table refused (msg text);
      do $do$ begin
        update public.book_bookings set metering_state='reporting'
         where service_id='${svc.one}'::uuid and starts_at='${s}'::timestamptz;
      exception when others then insert into refused values (sqlerrm);
      end $do$;
      ${jsonRows("select coalesce((select 'refused' from refused limit 1), 'updated') as outcome")}`);
    assert.equal(r.outcome, 'updated',
      'the guard counted the row against itself — every metering write would fail');
    clear(svc.one);
  });
});
