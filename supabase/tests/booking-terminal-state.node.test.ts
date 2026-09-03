/**
 * booking-terminal-state.node.test.ts — who may move a booking, and when.
 *
 * WHAT WAS WRONG
 *
 * Two holes, both found during the booking end-to-end and both reachable
 * without the UI, because PostgREST is a public API:
 *
 *   An owner could mark next week's appointment completed. Capacity counts
 *   only confirmed and pending_payment, so the booking stopped holding its
 *   place and the slot went quietly back on sale. That is how one 09:30 slot
 *   came to hold two bookings for a service with one chair.
 *
 *   A customer holds column-level UPDATE on status and the RLS policy checks
 *   only that the row is theirs. Its comment says "e.g. cancel"; nothing
 *   enforced the "e.g.". A customer could mark their own booking completed or
 *   no_show — releasing the place while their own screen still said upcoming.
 *
 * WHAT IS ASSERTED
 *   · an owner cannot mark a booking completed or no_show before it starts
 *   · an owner can once it has started — the product has never required the
 *     appointment to have ENDED, and finishing early is ordinary
 *   · a customer may cancel, and may not do anything else
 *   · a stranger may move nothing
 *   · trusted server-side writes are untouched, or metering and payment break
 *   · a refused transition leaves the booking exactly as it was, still holding
 *     its place
 *   · an allowed one after the start still releases it, exactly as today
 *   · no customer surface files a terminal booking under Upcoming
 *
 * SAFETY
 * Synthetic fixtures on an INACTIVE business, removed in after(). Never
 * activates anything, so nothing it makes can appear in a live Directory.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = join(REPO_ROOT, '..', 'oneshetland-web');
const SLUG = 'zz-terminal-state';

const DSN = process.env.BOOKING_PROOF_DSN ?? '';
const PSQL = process.env.BOOKING_PROOF_PSQL ?? 'psql';

const jsonRows = (finalSelect: string) =>
  `select coalesce(json_agg(x)::text, '[]') as j from (${finalSelect}) x;`;

const invoke = (body: string): [string, string[]] => DSN
  ? [PSQL, [DSN, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=0', '-c', body]]
  : ['npx', ['supabase', 'db', 'query', '--linked', body, '--output-format', 'json']];

function parse(out: string): Record<string, unknown>[] {
  if (DSN) {
    const line = out.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('[')).pop() ?? '[]';
    return JSON.parse(line) as Record<string, unknown>[];
  }
  const env = JSON.parse(out.slice(out.indexOf('{'))) as { rows?: Record<string, unknown>[] };
  return JSON.parse(String((env.rows ?? [{}])[0]?.j ?? '[]')) as Record<string, unknown>[];
}
function sql(body: string): Record<string, unknown>[] {
  const [bin, a] = invoke(body);
  return parse(execFileSync(bin, a,
    { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 240_000 }));
}
const one = (body: string) => sql(body)[0] ?? {};

let biz = '', owner = '', customer = '', stranger = '', svc = '';

/**
 * Put one confirmed booking on the fixture, at a chosen time. Trusted write.
 * startsAt/endsAt are SQL EXPRESSIONS, not literals — the tests need times
 * relative to now(), because "before it starts" is the whole subject.
 */
function seed(startsAt: string, endsAt: string, status = 'confirmed'): string {
  sql(`delete from public.book_bookings where service_id='${svc}'::uuid;
       insert into public.book_bookings
         (id,business_id,service_id,customer_id,starts_at,ends_at,status,price_pence)
       values ('33333333-4444-5555-6666-777777777777'::uuid,'${biz}'::uuid,'${svc}'::uuid,
               '${customer}'::uuid, ${startsAt}, ${endsAt}, '${status}',1000);
       ${jsonRows('select 1 as done')}`);
  return '33333333-4444-5555-6666-777777777777';
}

/** Attempt a status change as a given signed-in user, and report what happened. */
function moveAs(actor: string, id: string, status: string): { outcome: string; now: string } {
  const r = one(`
    create temp table refused (msg text);
    grant insert on refused to authenticated;
    set role authenticated;
    select set_config('request.jwt.claims',
      json_build_object('sub','${actor}','role','authenticated')::text, false);
    do $do$ begin
      update public.book_bookings set status='${status}' where id='${id}'::uuid;
    exception when others then insert into refused values (sqlerrm);
    end $do$;
    reset role;
    select set_config('request.jwt.claims', null, false);
    ${jsonRows(`select coalesce((select left(msg,70) from refused limit 1),'ALLOWED') as outcome,
                       (select b.status from public.book_bookings b where b.id='${id}'::uuid) as now`)}`);
  return { outcome: String(r.outcome), now: String(r.now) };
}

const consuming = (): number => Number(one(jsonRows(
  `select count(*)::text as n from public.book_bookings
    where service_id='${svc}'::uuid and status in ('confirmed','pending_payment')`)).n);

before(() => {
  const r = one(`
    with o as (select id from public.profiles order by id offset 0 limit 1),
         c as (select id from public.profiles order by id offset 3 limit 1),
         s as (select id from public.profiles order by id offset 4 limit 1),
         b as (
           insert into public.local_businesses
             (id,name,slug,category,address,owner_id,subscription_tier,subscription_until,is_active,accepts_bookings)
           select gen_random_uuid(),'ZZ Terminal State','${SLUG}','other','Lerwick',
                  id,'premium', now() + interval '30 days', false, true from o
           returning id, owner_id),
         sv as (
           insert into public.book_services
             (business_id,name,duration_minutes,buffer_minutes,price_pence,deposit_pence,requires_deposit,capacity,is_active)
           select id,'terminal probe',30,0,1000,0,false,1,true from b returning id)
    ${jsonRows(`select (select id from b)::text as biz, (select owner_id from b)::text as owner,
                       (select id from c)::text as cust, (select id from s)::text as stranger,
                       (select id from sv)::text as svc`)}`);
  biz = String(r.biz); owner = String(r.owner); customer = String(r.cust);
  stranger = String(r.stranger); svc = String(r.svc);
  assert.match(biz, /^[0-9a-f-]{36}$/, 'the fixture business was not created');
  assert.notEqual(owner, customer, 'owner and customer must be different people');
  assert.notEqual(stranger, customer, 'the stranger must not be the customer');
  assert.notEqual(stranger, owner, 'the stranger must not be the owner');
});

after(() => {
  sql(`delete from public.book_bookings b using public.local_businesses lb
        where lb.id = b.business_id and lb.slug='${SLUG}';
       delete from public.book_services s using public.local_businesses lb
        where lb.id = s.business_id and lb.slug='${SLUG}';
       delete from public.local_businesses where slug='${SLUG}';
       ${jsonRows('select 1 as done')}`);
  const left = one(jsonRows(`select count(*)::text as n from public.local_businesses where slug='${SLUG}'`));
  assert.equal(left.n, '0', 'the terminal-state fixture leaked into production');
});

const FUTURE = ["now() + interval '3 days'", "now() + interval '3 days' + interval '30 minutes'"];
const STARTED = ["now() - interval '10 minutes'", "now() + interval '20 minutes'"];

describe('an appointment that has not happened cannot have been attended or missed', () => {
  for (const status of ['completed', 'no_show']) {
    test(`the owner cannot mark a FUTURE booking ${status}`, () => {
      const id = seed(FUTURE[0], FUTURE[1]);
      const r = moveAs(owner, id, status);
      assert.match(r.outcome, /booking_not_started/,
        `expected the transition guard to refuse this, got: ${r.outcome}`);
      assert.equal(r.now, 'confirmed', 'the booking moved anyway');
    });
  }

  for (const status of ['completed', 'no_show']) {
    test(`the owner CAN mark it ${status} once it has started`, () => {
      const id = seed(STARTED[0], STARTED[1]);
      const r = moveAs(owner, id, status);
      assert.equal(r.outcome, 'ALLOWED', `the owner was refused: ${r.outcome}`);
      assert.equal(r.now, status);
    });
  }

  test('a refused future completion leaves the place occupied', () => {
    const id = seed(FUTURE[0], FUTURE[1]);
    assert.equal(consuming(), 1, 'the seeded booking is not holding its place');
    moveAs(owner, id, 'completed');
    assert.equal(one(jsonRows(`select status from public.book_bookings where id='${id}'::uuid`)).status,
      'confirmed', 'the status changed despite the refusal');
    assert.equal(consuming(), 1, 'a refused completion released the place anyway');
  });

  test('an allowed completion after the start releases it, exactly as before', () => {
    const id = seed(STARTED[0], STARTED[1]);
    assert.equal(consuming(), 1);
    const r = moveAs(owner, id, 'completed');
    assert.equal(r.outcome, 'ALLOWED');
    assert.equal(consuming(), 0, 'a completed booking should no longer hold its place');
  });

  test('the owner may still cancel a future booking', () => {
    const id = seed(FUTURE[0], FUTURE[1]);
    const r = moveAs(owner, id, 'cancelled');
    assert.equal(r.outcome, 'ALLOWED', `owner cancellation was refused: ${r.outcome}`);
    assert.equal(r.now, 'cancelled');
  });
});

describe('a customer may call it off, and nothing else', () => {
  test('cancelling their own booking is allowed', () => {
    const id = seed(FUTURE[0], FUTURE[1]);
    const r = moveAs(customer, id, 'cancelled');
    assert.equal(r.outcome, 'ALLOWED', `a customer could not cancel: ${r.outcome}`);
    assert.equal(r.now, 'cancelled');
  });

  for (const status of ['completed', 'no_show']) {
    test(`the customer cannot mark their own booking ${status}`, () => {
      const id = seed(FUTURE[0], FUTURE[1]);
      const r = moveAs(customer, id, status);
      assert.match(r.outcome, /booking_customer_may_only_cancel/,
        `expected the guard to refuse this, got: ${r.outcome}`);
      assert.equal(r.now, 'confirmed');
    });
  }

  test('nor even on a booking that has already started', () => {
    // The timing rule is the owner's. A customer never gets these states.
    const id = seed(STARTED[0], STARTED[1]);
    const r = moveAs(customer, id, 'completed');
    assert.match(r.outcome, /booking_customer_may_only_cancel/, r.outcome);
    assert.equal(r.now, 'confirmed');
  });

  test('a stranger may move nothing', () => {
    // RLS gets here first and simply does not show them the row, so the UPDATE
    // matches nothing and raises nothing. Silence is the correct answer; what
    // matters is that the booking did not move, not that anyone complained.
    const id = seed(FUTURE[0], FUTURE[1]);
    const r = moveAs(stranger, id, 'cancelled');
    assert.equal(r.now, 'confirmed', 'somebody else cancelled this booking');
    assert.equal(consuming(), 1, 'a stranger released the place');
  });
});

describe('the processes that do not sign in still work', () => {
  test('a trusted server-side write may move a booking however it needs to', () => {
    // auth.uid() is null: payment confirmation, metering and reminders all
    // arrive this way, and a guard that blocked them would break the product.
    const id = seed(FUTURE[0], FUTURE[1]);
    const r = one(`
      create temp table refused (msg text);
      do $do$ begin
        update public.book_bookings set status='completed' where id='${id}'::uuid;
      exception when others then insert into refused values (sqlerrm);
      end $do$;
      ${jsonRows(`select coalesce((select left(msg,60) from refused limit 1),'ALLOWED') as outcome,
                         (select status from public.book_bookings where id='${id}'::uuid) as now`)}`);
    assert.equal(r.outcome, 'ALLOWED', `a trusted write was refused: ${String(r.outcome)}`);
    assert.equal(r.now, 'completed');
  });

  test('an update that does not touch status is never governed', () => {
    // Metering writes land on confirmed bookings constantly. They arrive
    // trusted — authenticated holds no grant on metering_state at all, which
    // is a deliberate earlier lockdown — so this is what the real path looks
    // like. If the guard charged it for a lookup or refused it, the meter
    // would stop.
    const id = seed(FUTURE[0], FUTURE[1]);
    const r = one(`
      create temp table refused (msg text);
      do $do$ begin
        update public.book_bookings set metering_state='reporting' where id='${id}'::uuid;
      exception when others then insert into refused values (sqlerrm);
      end $do$;
      ${jsonRows(`select coalesce((select left(msg,60) from refused limit 1),'ALLOWED') as outcome,
                         (select status from public.book_bookings where id='${id}'::uuid) as now`)}`);
    assert.equal(r.outcome, 'ALLOWED', `a non-status update was refused: ${String(r.outcome)}`);
    assert.equal(r.now, 'confirmed', 'a metering write changed the status');
  });

  test('a customer cannot reach the metering columns at all', () => {
    // Not this guard's doing — an earlier lockdown — but worth holding, since
    // the transition guard would wave a metering write straight through.
    const id = seed(FUTURE[0], FUTURE[1]);
    const r = one(`
      create temp table refused (msg text);
      grant insert on refused to authenticated;
      set role authenticated;
      select set_config('request.jwt.claims',
        json_build_object('sub','${customer}','role','authenticated')::text, false);
      do $do$ begin
        update public.book_bookings set metering_state='reported' where id='${id}'::uuid;
      exception when others then insert into refused values (sqlerrm);
      end $do$;
      reset role;
      select set_config('request.jwt.claims', null, false);
      ${jsonRows(`select coalesce((select left(msg,60) from refused limit 1),'ALLOWED') as outcome`)}`);
    assert.match(String(r.outcome), /permission denied/,
      `a customer wrote a metering column: ${String(r.outcome)}`);
  });
});

describe('the guard is at the boundary, not in a screen', () => {
  test('it is a BEFORE UPDATE trigger on the table', () => {
    const t = one(jsonRows(`
      select count(*)::text as n from pg_trigger t join pg_class c on c.oid=t.tgrelid
       where c.relname='book_bookings' and t.tgname='book_booking_transition_guard'
         and (t.tgtype & 2) > 0 and (t.tgtype & 16) > 0`));
    assert.equal(t.n, '1', 'no BEFORE UPDATE transition trigger — a direct request is unguarded');
  });

  test('it is definer with a pinned search_path, and reads auth.uid() itself', () => {
    const d = String(one(jsonRows(
      `select pg_get_functiondef('public.book_booking_transition_guard'::regproc) as d`)).d);
    assert.match(d, /SECURITY DEFINER/i);
    assert.match(d, /SET search_path TO ['"]?public/i);
    assert.match(d, /auth\.uid\(\)/, 'the actor must come from the session, never from the row');
  });

  test('it refuses before the capacity guard does its work', () => {
    const order = String(one(jsonRows(`
      select string_agg(t.tgname, ' -> ' order by t.tgname) as o
        from pg_trigger t join pg_class c on c.oid=t.tgrelid
       where c.relname='book_bookings' and not t.tgisinternal
         and (t.tgtype & 2) > 0 and (t.tgtype & 16) > 0`)).o);
    assert.equal(order,
      'book_booking_transition_guard -> book_capacity_guard -> enforce_gift_funded_booking');
  });
});

describe('no customer surface calls a finished booking upcoming', () => {
  const surfaces: [string, string][] = [
    ['web', join(WEB, 'app/account/bookings/BookingsClient.tsx')],
    ['mobile', join(REPO_ROOT, 'app/local-my-bookings.tsx')],
  ];

  /**
   * Lift the screen's OWN grouping expression out of source and run it.
   * Asserting that the file mentions the word "completed" proves nothing — it
   * mentions it in the status badges too, so a revert to cancelled-only sailed
   * past an earlier version of this test. Execute the real lines instead.
   */
  function classifier(path: string): (status: string, startMs: number, now: number) => boolean {
    const src = readFileSync(path, 'utf8');
    const closed = /const closed = ([^;]+);/.exec(src);
    const upcoming = /const isUpcoming = ([^;]+);/.exec(src);
    assert.ok(closed, `${path}: no 'closed' line to lift — has the grouping been rewritten?`);
    assert.ok(upcoming, `${path}: no 'isUpcoming' line to lift`);
    const body = `
      const b = { status, starts_at: new Date(startMs).toISOString() };
      const startMs_ = startMs;
      const closed = ${closed![1]};
      const isUpcoming = ${upcoming![1].replace(/\bstartMs\b/g, 'startMs_')};
      return isUpcoming;`;
    return new Function('status', 'startMs', 'now', body) as
      (status: string, startMs: number, now: number) => boolean;
  }

  for (const [name, path] of surfaces) {
    test(`${name}: a FUTURE terminal booking is not upcoming`, () => {
      const isUpcoming = classifier(path);
      const now = Date.UTC(2026, 8, 3, 12, 0, 0);
      const future = now + 3 * 86_400_000;
      for (const status of ['cancelled', 'completed', 'no_show']) {
        assert.equal(isUpcoming(status, future, now), false,
          `${name} files a future ${status} booking under Upcoming`);
      }
    });

    test(`${name}: a future confirmed booking still IS upcoming`, () => {
      // The other half. A rule that hides everything would pass the test above.
      const isUpcoming = classifier(path);
      const now = Date.UTC(2026, 8, 3, 12, 0, 0);
      assert.equal(isUpcoming('confirmed', now + 3 * 86_400_000, now), true,
        `${name} stopped showing genuine upcoming bookings`);
      assert.equal(isUpcoming('confirmed', now - 3 * 86_400_000, now), false,
        `${name} calls a past confirmed booking upcoming`);
    });
  }

  test('the owner surfaces, which were already right, are unchanged', () => {
    for (const p of [join(WEB, 'components/business/BookingsManager.tsx'),
                     join(REPO_ROOT, 'app/local-book-bookings.tsx')]) {
      const src = readFileSync(p, 'utf8');
      for (const st of ['cancelled', 'completed', 'no_show']) {
        assert.ok(src.includes(`'${st}'`) || src.includes(`"${st}"`), `${p} lost ${st}`);
      }
    }
  });

  test('neither owner surface offers to finish an appointment that has not begun', () => {
    const web = readFileSync(join(WEB, 'components/business/BookingsManager.tsx'), 'utf8');
    assert.match(web, /const hasStarted = new Date\(b\.starts_at\)\.getTime\(\) <= Date\.now\(\)/,
      'the web owner screen no longer asks whether the appointment has started');
    assert.match(web, /disabled=\{isActing \|\| !hasStarted\}/,
      'the web Mark complete / No-show buttons are no longer gated on that');

    const mob = readFileSync(join(REPO_ROOT, 'app/local-book-bookings.tsx'), 'utf8');
    assert.match(mob, /const hasStarted = Date\.now\(\) >= start\.getTime\(\)/,
      'the mobile owner screen no longer asks whether the appointment has started');
    assert.match(mob, /\{hasStarted && \(/, 'the mobile actions are no longer gated on that');
    assert.doesNotMatch(mob, /tab === 'today' \|\| /,
      "the Today tab is showing the buttons again for appointments that have not started");
  });
});
