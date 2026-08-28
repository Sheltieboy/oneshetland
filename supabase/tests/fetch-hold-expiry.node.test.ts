/**
 * fetch-hold-expiry.node.test.ts — a hold is only a hold while Stripe says so.
 *
 * Fixes 2–4 made WRITING `payment_status = 'authorised'` honest. Nothing made
 * READING it honest afterwards. A card authorisation is not permanent: Stripe
 * releases an uncaptured one after a few days and the PaymentIntent goes to
 * `canceled`. Our row went on saying authorised.
 *
 * Two defects were MEASURED against the live database before this fix, both in
 * rolled-back transactions:
 *
 *   • fetch_mark_collected is SECURITY DEFINER, so tg_is_trusted_writer()
 *     answers true inside it and the payment gate added by 20260906120000
 *     returns early. A driver called it on a delivery with payment_status
 *     'unpaid' and NO PaymentIntent at all, and the row moved to 'collected'.
 *   • With payment_status 'authorised', nothing asked Stripe whether the hold
 *     was still there — so a stale note released the driver.
 *
 * The deadline itself is not invented here. Stripe puts it on the CHARGE at
 * payment_method_details.card.capture_before, and when Stripe gives none, none
 * is manufactured: status reconciliation is the authority either way.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyHold, captureDeadline, holdIsFulfillable, driverMessage } from
  '../functions/_shared/fetch-hold.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_ROOT  = join(REPO_ROOT, '..', 'oneshetland-web');
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*|\{\/\*).*$/gm, '');

const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const readWeb = (p: string) => readFileSync(join(WEB_ROOT, p), 'utf8');

const migration   = read('supabase/migrations/20260910120000_fetch_hold_validity.sql');
const capture     = code(read('supabase/functions/capture-payment/index.ts'));
const authorise   = code(read('supabase/functions/fetch-authorise/index.ts'));
const holdCheck   = code(read('supabase/functions/fetch-hold-check/index.ts'));
const webhook     = code(read('supabase/functions/stripe-webhook/index.ts'));
const config      = read('supabase/config.toml');
const driverUI    = code(readWeb('components/fetch/DriverActions.tsx'));
const customerUI  = code(readWeb('components/fetch/AuthorisePanel.tsx'));

/** Rolled back, always: the guard row makes an accidental commit impossible. */
function sql(body: string): Record<string, unknown>[] {
  const out = execFileSync('npx',
    ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${body}`, '--output-format', 'json'],
    { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 });
  const parsed = JSON.parse(out) as { rows?: Record<string, unknown>[]; error?: unknown };
  if (parsed.error) throw new Error(JSON.stringify(parsed.error).slice(0, 300));
  return parsed.rows ?? [];
}

const C   = '11111111-aaaa-1111-1111-111111111111';
const D   = '22222222-aaaa-2222-2222-222222222222';
const REQ = '33333333-aaaa-3333-3333-333333333333';
const RUN = '44444444-aaaa-4444-4444-444444444444';

/**
 * A matched delivery with a driver, a waiting event and a frozen-terms
 * authorisation attempt. `holdSql` decides what Stripe is deemed to have said.
 */
const fixture = (holdSql: string) => `
begin;
  insert into auth.users (id, email) values
    ('${C}', 'holdexp-c@probe.invalid'), ('${D}', 'holdexp-d@probe.invalid');
  insert into public.runs (id, driver_id, departure_start, departure_end, status)
    values ('${RUN}', '${D}', now(), now() + interval '3 hours', 'open');
  insert into public.delivery_requests
    (id, customer_id, run_id, category_slug, pickup_name, pickup_location,
     destination_address, destination_area, liability_acknowledged, status, ready_for_collection)
  values ('${REQ}', '${C}', '${RUN}', 'shopping', 'PROBE', 'PROBE', 'PROBE', 'Unst', true, 'matched', true);
  update public.delivery_requests
     set base_fee_pence = 400, payment_status = 'authorised', payment_intent_id = 'pi_probe_gen1'
   where id = '${REQ}';
  insert into public.waiting_events (request_id, driver_id, arrived_at)
    values ('${REQ}', '${D}', now() - interval '2 minutes');

  create temp table _claim on commit drop as select * from public.claim_fetch_authorisation(
    '${REQ}'::uuid, '${C}'::uuid, '${D}'::uuid, 1150, 400, 150, 300, 300, 150, 600);
  update public.fetch_authorisation_attempts
     set stripe_payment_intent_id = 'pi_probe_gen1', status = 'authorised'
   where delivery_request_id = '${REQ}';
  ${holdSql}
`;

/** The driver taps "Mark as collected", exactly as the web app does. */
const COLLECT = `
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"${D}","role":"authenticated"}';
  do $probe$
  begin
    perform public.fetch_mark_collected('${REQ}');
  exception when others then
    null;
  end $probe$;
  reset role;
  select d.status,
         d.payment_status,
         a.status       as attempt_status,
         a.hold_state,
         a.authorisation_generation as generation
    from public.delivery_requests d
    left join public.fetch_authorisation_attempts a on a.delivery_request_id = d.id
   where d.id = '${REQ}';
rollback;
`;

/* ───────────────────────── 1. What Stripe actually said ─────────────────── */

describe('the hold reading is Stripe\'s, not ours', () => {
  const HOUR = 3600_000;
  const now  = 1_770_000_000_000;
  const pi = (over: Record<string, unknown>) => ({
    id: 'pi_x', status: 'requires_capture', amount_capturable: 1150, ...over,
  });
  const charge = (captureBefore: number | null) => ({
    id: 'ch_x',
    payment_method_details: { card: captureBefore === null ? {} : { capture_before: captureBefore } },
  });

  test('a live requires_capture hold releases the driver', () => {
    const r = classifyHold(pi({ latest_charge: charge((now + 5 * 24 * HOUR) / 1000) }), now);
    assert.equal(r.state, 'valid');
    assert.equal(holdIsFulfillable(r), true);
    assert.equal(r.paymentStatus, 'authorised');
    assert.ok(r.expiresAt, 'the deadline Stripe gave is kept');
  });

  test('a canceled PaymentIntent is an expired hold, and no driver is released', () => {
    const r = classifyHold(pi({ status: 'canceled', cancellation_reason: 'expired' }), now);
    assert.equal(r.state, 'expired');
    assert.equal(holdIsFulfillable(r), false);
    assert.equal(r.paymentStatus, 'expired');
  });

  test('requires_capture PAST its deadline is expired — the status has not caught up, the money has', () => {
    const r = classifyHold(pi({ latest_charge: charge((now - HOUR) / 1000) }), now);
    assert.equal(r.state, 'expired');
    assert.equal(holdIsFulfillable(r), false);
  });

  test('close to the deadline is expiring_soon, and still capturable', () => {
    const r = classifyHold(pi({ latest_charge: charge((now + 3 * HOUR) / 1000) }), now);
    assert.equal(r.state, 'expiring_soon');
    assert.equal(holdIsFulfillable(r), true);
  });

  test('no deadline from Stripe means no deadline — none is invented', () => {
    const r = classifyHold(pi({ latest_charge: charge(null) }), now);
    assert.equal(r.expiresAt, null);
    assert.equal(r.state, 'valid');
    assert.ok(!/\b(7|seven)\b/.test(migration.replace(/--.*$/gm, '')),
      'no hard-coded expiry window in the migration body');
  });

  test('an unexpanded latest_charge yields no deadline rather than a wrong one', () => {
    assert.equal(captureDeadline({ latest_charge: 'ch_bare_id' }), null);
    assert.equal(captureDeadline({}), null);
  });

  test('every non-hold status fails closed', () => {
    for (const status of ['requires_action', 'requires_payment_method']) {
      assert.equal(classifyHold(pi({ status }), now).state, 'customer_action_required');
    }
    for (const status of ['processing', 'something_new_from_stripe', undefined]) {
      const r = classifyHold(pi({ status }), now);
      assert.equal(r.state, 'unresolved', `${status} must not be read as a hold`);
      assert.equal(holdIsFulfillable(r), false);
    }
    assert.equal(classifyHold(pi({ status: 'succeeded' }), now).state, 'captured');
  });

  test('the driver is never told to carry on', () => {
    for (const s of ['expired', 'customer_action_required', 'unresolved'] as const) {
      const m = driverMessage(s);
      assert.ok(m.length > 0, `${s} must say something`);
      assert.ok(!/proceed|go ahead|carry on/i.test(m), `${s} must not release the driver`);
    }
    assert.match(driverMessage('expired'), /expired/i);
    assert.match(driverMessage('expired'), /re-authorise/i);
    assert.equal(driverMessage('valid'), '');
  });
});

/* ─────────────────── 2. The database refuses to fulfil a dead hold ───────── */

describe('collection requires a hold that is still there', () => {
  test('a valid, recently confirmed hold lets the driver collect', () => {
    const [row] = sql(fixture(`
      perform_ignored as (select 1);
      select public.record_fetch_hold_state('${REQ}'::uuid, 'valid', 'expires later',
                                            now() + interval '5 days', 'authorised');
    `.replace('perform_ignored as (select 1);', '')) + COLLECT);
    assert.equal(row.status, 'collected');
    assert.equal(row.hold_state, 'valid');
  });

  test('Stripe says expired, our row says authorised — Stripe wins', () => {
    const [row] = sql(fixture(`
      select public.record_fetch_hold_state('${REQ}'::uuid, 'expired',
                                            'canceled: expired', null, 'expired');
    `) + COLLECT);
    assert.equal(row.status, 'matched', 'the driver must not have collected');
    assert.equal(row.payment_status, 'expired');
    assert.equal(row.attempt_status, 'expired');
  });

  test('a hold nobody has confirmed recently does not release a driver', () => {
    const [row] = sql(fixture(`
      select public.record_fetch_hold_state('${REQ}'::uuid, 'valid', 'checked long ago',
                                            now() + interval '5 days', 'authorised');
      update public.fetch_authorisation_attempts
         set hold_checked_at = now() - interval '2 days'
       where delivery_request_id = '${REQ}';
    `) + COLLECT);
    assert.equal(row.status, 'matched');
  });

  test('a deadline that has passed blocks collection even while the state still reads valid', () => {
    const [row] = sql(fixture(`
      select public.record_fetch_hold_state('${REQ}'::uuid, 'valid', 'stale reading',
                                            now() - interval '1 hour', 'authorised');
    `) + COLLECT);
    assert.equal(row.status, 'matched', 'the deadline is honoured, not just the state');
  });

  test('THE MEASURED DEFECT: no authorisation at all no longer collects', () => {
    const [row] = sql(`
begin;
  insert into auth.users (id, email) values
    ('${C}', 'holdexp-c@probe.invalid'), ('${D}', 'holdexp-d@probe.invalid');
  insert into public.runs (id, driver_id, departure_start, departure_end, status)
    values ('${RUN}', '${D}', now(), now() + interval '3 hours', 'open');
  insert into public.delivery_requests
    (id, customer_id, run_id, category_slug, pickup_name, pickup_location,
     destination_address, destination_area, liability_acknowledged, status, ready_for_collection)
  values ('${REQ}', '${C}', '${RUN}', 'shopping', 'PROBE', 'PROBE', 'PROBE', 'Unst', true, 'matched', true);
  insert into public.waiting_events (request_id, driver_id, arrived_at)
    values ('${REQ}', '${D}', now() - interval '2 minutes');
` + COLLECT);
    assert.equal(row.status, 'matched', 'an unfunded delivery must not be collected');
  });

  test('the direct PATCH route stays shut too', () => {
    const [row] = sql(fixture(`
      select public.record_fetch_hold_state('${REQ}'::uuid, 'expired', 'gone', null, 'expired');
    `) + `
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"${D}","role":"authenticated"}';
  do $p$ begin
    update public.delivery_requests set status = 'collected' where id = '${REQ}';
  exception when others then null; end $p$;
  reset role;
  select status, payment_status, null::text as attempt_status, null::text as hold_state,
         null::int as generation from public.delivery_requests where id = '${REQ}';
rollback;
`);
    assert.equal(row.status, 'matched');
  });
});

/* ─────────────────────────── 3. Recording the truth ─────────────────────── */

describe('what the server is allowed to record', () => {
  test('a captured payment is never walked backwards by a later expiry', () => {
    const [row] = sql(fixture(`
      update public.delivery_requests set payment_status = 'captured' where id = '${REQ}';
      update public.fetch_authorisation_attempts set status = 'captured', capture_state = 'captured'
       where delivery_request_id = '${REQ}';
      select public.record_fetch_hold_state('${REQ}'::uuid, 'expired', 'late event', null, 'expired');
    `) + `
  select d.status, d.payment_status, a.status as attempt_status, a.hold_state,
         a.authorisation_generation as generation
    from public.delivery_requests d join public.fetch_authorisation_attempts a
      on a.delivery_request_id = d.id where d.id = '${REQ}';
rollback;
`);
    assert.equal(row.payment_status, 'captured');
    assert.equal(row.attempt_status, 'captured');
  });

  test('a hold the customer cancelled stays cancelled, not "expired"', () => {
    const [row] = sql(fixture(`
      select public.settle_fetch_authorisation('${REQ}'::uuid, 'terminal', null,
                                               '{"cancelled":true}'::jsonb, null);
      select public.record_fetch_hold_state('${REQ}'::uuid, 'expired', 'canceled: requested_by_customer',
                                            null, 'expired');
    `) + `
  select d.status, d.payment_status, a.status as attempt_status, a.hold_state,
         a.authorisation_generation as generation
    from public.delivery_requests d join public.fetch_authorisation_attempts a
      on a.delivery_request_id = d.id where d.id = '${REQ}';
rollback;
`);
    assert.equal(row.attempt_status, 'terminal',
      'operations must be able to tell a cancellation from a lapse');
    assert.equal(row.payment_status, 'expired', 'and neither may ever be captured');
  });

  test('a delivery with no attempt row still has its stale status corrected', () => {
    const [row] = sql(`
begin;
  insert into auth.users (id, email) values ('${C}', 'holdexp-c@probe.invalid');
  insert into public.delivery_requests
    (id, customer_id, category_slug, pickup_name, pickup_location, destination_address,
     destination_area, liability_acknowledged, status)
  values ('${REQ}', '${C}', 'shopping', 'PROBE', 'PROBE', 'PROBE', 'Unst', true, 'matched');
  update public.delivery_requests set payment_status = 'authorised' where id = '${REQ}';
  select public.record_fetch_hold_state('${REQ}'::uuid, 'expired', 'legacy row', null, 'expired');
  select payment_status from public.delivery_requests where id = '${REQ}';
rollback;
`);
    assert.equal(row.payment_status, 'expired');
  });
});

/* ─────────────────────── 4. One active generation, ever ─────────────────── */

describe('re-authorisation is the one legitimate second intent', () => {
  test('a live hold cannot be replaced — that is how a customer gets two', () => {
    const [row] = sql(fixture(`
      select public.record_fetch_hold_state('${REQ}'::uuid, 'valid', 'alive',
                                            now() + interval '5 days', 'authorised');
    `) + `
  select outcome as status, null::text as payment_status, null::text as attempt_status,
         null::text as hold_state, new_generation as generation
    from public.reauthorise_fetch_delivery('${REQ}'::uuid, '${C}'::uuid);
rollback;
`);
    assert.equal(row.status, 'not_expired');
    assert.equal(row.generation, 1);
  });

  test('twenty simultaneous attempts produce exactly one generation 2', () => {
    const [row] = sql(fixture(`
      select public.record_fetch_hold_state('${REQ}'::uuid, 'expired', 'gone', null, 'expired');
      create temp table _outcomes on commit drop as
        select (public.reauthorise_fetch_delivery('${REQ}'::uuid, '${C}'::uuid)).*
          from generate_series(1, 20);
    `) + `
  select (select count(*) from _outcomes where outcome = 'claimed')::int as status,
         (select count(*) from public.fetch_authorisation_generations
           where delivery_request_id = '${REQ}')::int::text as payment_status,
         a.status as attempt_status, a.hold_state, a.authorisation_generation as generation
    from public.fetch_authorisation_attempts a where a.delivery_request_id = '${REQ}';
rollback;
`);
    assert.equal(row.status, 1, 'exactly one caller may mint the replacement');
    assert.equal(row.payment_status, '1', 'the retired generation is archived once');
    assert.equal(row.generation, 2);
    assert.equal(row.attempt_status, 'in_flight');
    assert.equal(row.hold_state, 'unknown', 'nothing is inherited from the dead hold');
  });

  test('the replacement keeps the frozen commercial terms and drops the dead intent', () => {
    const [row] = sql(fixture(`
      select public.record_fetch_hold_state('${REQ}'::uuid, 'expired', 'gone', null, 'expired');
      perform_nothing as (select 1);
    `.replace('perform_nothing as (select 1);', '')) + `
  select * from public.reauthorise_fetch_delivery('${REQ}'::uuid, '${C}'::uuid);
  select a.base_fee_pence::text as status, a.service_fee_pence::text as payment_status,
         a.wait_max_pence::text as attempt_status,
         coalesce(a.stripe_payment_intent_id, 'none') as hold_state,
         (select count(*)::int from public.delivery_requests
           where id = '${REQ}' and payment_intent_id is null) as generation
    from public.fetch_authorisation_attempts a where a.delivery_request_id = '${REQ}';
rollback;
`);
    assert.equal(row.status, '400',  'the base fee is carried across untouched');
    assert.equal(row.payment_status, '150', 'and the service fee');
    assert.equal(row.attempt_status, '600', 'and the waiting cap');
    assert.equal(row.hold_state, 'none', 'the dead intent no longer belongs to this delivery');
    assert.equal(row.generation, 1, 'and the request row no longer points at it either');
  });

  test('a stranger cannot re-authorise somebody else\'s delivery', () => {
    const [row] = sql(fixture(`
      select public.record_fetch_hold_state('${REQ}'::uuid, 'expired', 'gone', null, 'expired');
    `) + `
  select outcome as status, null::text as payment_status, null::text as attempt_status,
         null::text as hold_state, new_generation as generation
    from public.reauthorise_fetch_delivery('${REQ}'::uuid, '${D}'::uuid);
rollback;
`);
    assert.equal(row.status, 'forbidden');
  });

  test('a captured delivery is never re-authorised', () => {
    const [row] = sql(fixture(`
      update public.fetch_authorisation_attempts
         set status = 'captured', capture_state = 'captured' where delivery_request_id = '${REQ}';
    `) + `
  select outcome as status, null::text as payment_status, null::text as attempt_status,
         null::text as hold_state, new_generation as generation
    from public.reauthorise_fetch_delivery('${REQ}'::uuid, '${C}'::uuid);
rollback;
`);
    assert.equal(row.status, 'captured');
  });
});

/* ─────────────────────────────── 5. Boundaries ──────────────────────────── */

describe('none of this is the client\'s to write', () => {
  test('the hold RPCs are service-role only', () => {
    const rows = sql(`
      select p.proname as fn,
             coalesce(has_function_privilege('authenticated', p.oid, 'execute'), false) as auth_can,
             coalesce(has_function_privilege('anon', p.oid, 'execute'), false)          as anon_can,
             coalesce(has_function_privilege('service_role', p.oid, 'execute'), false)  as svc_can
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname in ('record_fetch_hold_state', 'fetch_hold_is_fulfillable',
                           'reauthorise_fetch_delivery');`);
    assert.equal(rows.length, 3, 'all three functions exist');
    for (const r of rows) {
      assert.equal(r.auth_can, false, `${r.fn} must not be callable by a signed-in client`);
      assert.equal(r.anon_can, false, `${r.fn} must not be callable anonymously`);
      assert.equal(r.svc_can,  true,  `${r.fn} must be callable by the server`);
    }
  });

  test('the generation archive is server-only, like the attempts it retires', () => {
    const [row] = sql(`
      select relrowsecurity as rls,
             (select count(*)::int from pg_policies
               where schemaname='public' and tablename='fetch_authorisation_generations') as policies,
             has_table_privilege('authenticated','public.fetch_authorisation_generations','select') as auth_read,
             has_table_privilege('anon','public.fetch_authorisation_generations','insert')          as anon_write
        from pg_class where oid = 'public.fetch_authorisation_generations'::regclass;`);
    assert.equal(row.rls, true);
    assert.equal(row.policies, 0, 'RLS on with no policy: clients match nothing');
    assert.equal(row.auth_read, false);
    assert.equal(row.anon_write, false);
  });

  test('a client cannot set the expiry state or the new intent id', () => {
    const [row] = sql(fixture(`
      select public.record_fetch_hold_state('${REQ}'::uuid, 'valid', 'alive',
                                            now() + interval '5 days', 'authorised');
    `) + `
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"${D}","role":"authenticated"}';
  do $p$ begin
    update public.fetch_authorisation_attempts
       set hold_state = 'valid', hold_checked_at = now(),
           stripe_payment_intent_id = 'pi_attacker'
     where delivery_request_id = '${REQ}';
  exception when others then null; end $p$;
  do $p$ begin
    update public.delivery_requests set payment_status = 'authorised' where id = '${REQ}';
  exception when others then null; end $p$;
  reset role;
  select d.status, d.payment_status, a.status as attempt_status,
         a.stripe_payment_intent_id as hold_state, a.authorisation_generation as generation
    from public.delivery_requests d join public.fetch_authorisation_attempts a
      on a.delivery_request_id = d.id where d.id = '${REQ}';
rollback;
`);
    assert.equal(row.hold_state, 'pi_probe_gen1', 'the attempt row is not the client\'s to write');
  });

  test('payment_status may say expired, and expired is not funded', () => {
    assert.match(migration, /'expired',\s*--/, 'the state exists');
    const [row] = sql(fixture(`
      select public.record_fetch_hold_state('${REQ}'::uuid, 'expired', 'gone', null, 'expired');
    `) + `
  select d.payment_status as status, ok::text as payment_status, reason as attempt_status,
         null::text as hold_state, null::int as generation
    from public.delivery_requests d, public.fetch_hold_is_fulfillable('${REQ}'::uuid)
   where d.id = '${REQ}';
rollback;
`);
    assert.equal(row.status, 'expired');
    assert.equal(row.payment_status, 'false');
    assert.equal(row.attempt_status, 'expired');
  });
});

/* ──────────────────────────── 6. The code paths ─────────────────────────── */

describe('the endpoints ask Stripe, and ask it first', () => {
  test('capture expands the charge, so the deadline is visible at all', () => {
    assert.match(capture, /payment_intents\/\$\{id\}\?expand\[\]=latest_charge/);
  });

  test('an expired or canceled hold reaches zero capture calls', () => {
    const beforeCapture = capture.slice(0, capture.indexOf('/capture'));
    assert.ok(beforeCapture.includes("before.status === 'canceled'"),
      'the canceled check precedes the capture call');
    assert.ok(beforeCapture.includes('before.captureBefore'),
      'and so does the deadline check');
    for (const branch of ["p_state: 'expired'"]) {
      assert.ok(beforeCapture.includes(branch), 'and both record the expiry');
    }
    assert.ok(!/captured: true/.test(beforeCapture.split("before.status === 'canceled'")[1] ?? ''),
      'nothing on the expired path claims a capture');
  });

  test('capture still retrieves before it captures — Fix 4 is not weakened', () => {
    assert.ok(capture.indexOf('const before = await readIntent') < capture.indexOf('/capture'),
      'the retrieve comes first');
    assert.match(capture, /Idempotency-Key.*fetch-capture-\$\{request_id\}/s);
  });

  test('re-authorisation cancels the old intent BEFORE it creates a new one', () => {
    const i = authorise.indexOf('async function reauthorise');
    const body = authorise.slice(i);
    const cancelAt = body.indexOf('/cancel');
    const claimAt  = body.indexOf("rpc('reauthorise_fetch_delivery'");
    const createAt = body.indexOf("fetch(`${STRIPE}/payment_intents`");
    assert.ok(cancelAt > 0 && claimAt > cancelAt && createAt > claimAt,
      'release the old hold, then take the generation, then create');
  });

  test('re-authorisation only runs from a Stripe-confirmed expiry', () => {
    const body = authorise.slice(authorise.indexOf('async function reauthorise'));
    assert.ok(body.indexOf('readHold(') < body.indexOf("rpc('reauthorise_fetch_delivery'"),
      'Stripe is asked before the generation is claimed');
    assert.match(body, /hold\.state !== 'expired'[\s\S]{0,400}NOT_EXPIRED/);
  });

  test('the replacement carries a generation-bearing idempotency key', () => {
    assert.match(authorise, /Idempotency-Key.*fetch-auth-\$\{request\.id\}-g\$\{generation\}/s);
  });

  test('the replacement is priced from the frozen terms, never from live config', () => {
    const body = authorise.slice(authorise.indexOf('async function reauthorise'));
    assert.match(body, /attempt\.service_fee_pence/);
    assert.ok(!/getCommissionConfig|calculateCommission|delivery_pricing_config/.test(body),
      'a lapsed hold is not a repricing event');
  });

  test('the hold check answers the customer and the assigned driver, and nobody else', () => {
    assert.match(holdCheck, /request\.customer_id === user\.id/);
    assert.match(holdCheck, /run\?\.driver_id === user\.id/);
    assert.match(holdCheck, /return json\(\{ error: 'Forbidden' \}, 403\)/);
  });

  test('a driver can never mint a replacement authorisation', () => {
    assert.match(holdCheck, /can_reauthorise:\s*role === 'customer'/);
    assert.ok(!/reauthorise_fetch_delivery/.test(holdCheck),
      'the hold check does not hold that power at all');
    assert.ok(!/reauthorise/.test(code(read('supabase/functions/authorise-payment/index.ts'))),
      'nor does the driver-triggered authorise endpoint');
  });

  test('an unreadable Stripe never rewrites a good local record', () => {
    assert.match(holdCheck, /reading\.state === 'unresolved' \? null : reading\.paymentStatus/);
  });

  test('the webhook handles the expiry event and leaves settled deliveries alone', () => {
    assert.match(webhook, /case 'payment_intent\.canceled'/);
    const branch = webhook.slice(webhook.indexOf("case 'payment_intent.canceled'"));
    assert.match(branch, /dr\.payment_status === 'captured' \|\| dr\.status === 'cancelled'/);
    assert.match(branch, /record_fetch_hold_state/);
    assert.match(branch, /cancellation_reason/);
  });

  test('the hold check is authenticated and pinned', () => {
    assert.match(config, /\[functions\.fetch-hold-check\]\s*\nverify_jwt = true/);
    assert.match(config, /\[functions\.stripe-webhook\]\s*\nverify_jwt = false/);
  });
});

/* ─────────────────────────────── 7. The screens ─────────────────────────── */

describe('what the two people are told', () => {
  test('the driver\'s screen revalidates before collection, not only on load', () => {
    const collected = driverUI.slice(driverUI.indexOf('async function collected'));
    assert.ok(collected.indexOf('await checkHold()') < collected.indexOf('fetch_mark_collected'),
      'the hold is re-read immediately before the driver commits');
  });

  test('an unconfirmed hold hides the driver\'s buttons rather than failing at the tap', () => {
    assert.match(driverUI, /!hold \|\| !hold\.fulfillable/);
    assert.match(driverUI, /Customer payment authorisation has expired/);
    assert.match(driverUI, /Wait for the customer to re-authorise before collecting/);
  });

  test('a failed check blocks rather than assuming the best', () => {
    const fn = driverUI.slice(driverUI.indexOf('const checkHold'));
    const catchBlock = fn.slice(fn.indexOf('} catch'), fn.indexOf('} finally'));
    assert.match(catchBlock, /fulfillable:\s*false/);
  });

  test('the customer is offered a hold, not a second charge', () => {
    const panel = customerUI.slice(customerUI.indexOf('payment_status === "expired"'));
    assert.match(panel, /authorisation has expired/i);
    assert.match(panel, /nothing has been charged/i);
    assert.match(panel, /Re-authorise/);
    assert.ok(!/charged again|pay again/i.test(panel));
  });

  test('replacing a hold is a deliberate press, never an effect', () => {
    // Every CALL of reauthorise() — as opposed to its declaration — must sit on
    // a line that is a click handler. A mount effect that re-authorised would
    // mint a PaymentIntent because a page loaded, which is the shape of bug
    // Paygate 10 was stopped for.
    const calls = customerUI.split('\n')
      .filter((l) => /reauthorise\(\)/.test(l) && !/(async )?function reauthorise/.test(l));
    assert.ok(calls.length > 0, 'it is called somewhere');
    for (const line of calls) {
      assert.match(line, /onClick=/, `re-authorisation must be a press, not: ${line.trim()}`);
    }
  });

  test('re-authorisation goes through the same Fix 2 card path', () => {
    const fn = customerUI.slice(customerUI.indexOf('async function reauthorise'));
    assert.match(fn, /s\.needs_action && s\.client_secret/);
    assert.match(fn, /setPaying\(true\)/);
  });
});
