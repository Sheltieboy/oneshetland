/**
 * stripe-idempotency.node.test.ts — a Stripe event pays out once, and a
 * refunded ticket stops working.
 *
 * WHY THIS TEST EXISTS
 *
 * Two defects, both reproduced against production on 2026-08-20 before the fix:
 *
 *   1. BOOST REPLAY (H4). The boost handler read subscription_until, added the
 *      purchased weeks and wrote it back. Stacking is intentional — a customer
 *      may buy consecutive boosts — but replay stacks just as happily. ONE paid
 *      two-week boost, delivered three times, granted SIX weeks: 28 free days.
 *      The UNIQUE constraint on local_boost_purchases.stripe_payment_intent_id
 *      did not help, because that path UPDATEs the row rather than inserting it.
 *
 *      The rest of the fulfilByType family was already safe — each one guards on
 *      a UNIQUE payment-intent column or a conditional update. That is
 *      domain-level idempotency, and it was real; it just was not event-level,
 *      and it did not cover boost.
 *
 *   2. A REFUNDED TICKET STILL OPENED THE DOOR. charge.refunded updated
 *      delivery_requests and nothing else. A ticket payment intent matches no
 *      delivery row, so a fully refunded order stayed 'paid', its tickets stayed
 *      'valid', and the scanner answered VALID.
 *
 * WHAT IS ASSERTED
 *   · one Stripe event id can be claimed once, sequentially and concurrently
 *   · a claim is never mistaken for proof the work happened
 *   · a failed or crashed attempt stays retryable
 *   · a boost is granted once however many times its event arrives
 *   · a full refund voids unused tickets and the scanner then refuses them
 *   · an already-used ticket keeps its status, so attendance is not erased
 *   · capacity never moves, so a duplicate refund cannot move it twice
 *   · a refund racing a scan has exactly one coherent winner
 *   · the ledger and its RPCs are unreachable from a browser
 *   · an unsigned or wrongly signed webhook is refused
 *
 * SAFETY
 * Everything is rolled back except the two concurrency tests, which cannot be:
 * proving two transactions contend requires rows both can see. Those create a
 * namespaced fixture, race it, and remove it in after(). Fixtures are also
 * re-cleaned on entry, so an interrupted run leaves nothing for the next one to
 * trip over.
 *
 * Run: npm test
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const EV_RACE  = 'c5000004-0000-4000-8000-00000000000a';
const TT_RACE  = 'c5000004-0000-4000-8000-0000000000ea';
const OR_RACE  = 'c5000004-0000-4000-8000-0000000000fa';

function publicConfig(): { url: string; anonKey: string } | null {
  let url = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
  let anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';
  if (!url || !anonKey) {
    try {
      for (const line of readFileSync(join(REPO_ROOT, '.env'), 'utf8').split('\n')) {
        const m = line.match(/^\s*(EXPO_PUBLIC_SUPABASE_URL|EXPO_PUBLIC_SUPABASE_ANON_KEY)\s*=\s*(.+)\s*$/);
        if (!m) continue;
        const v = m[2].trim().replace(/^["']|["']$/g, '');
        if (m[1].endsWith('URL')) url ||= v; else anonKey ||= v;
      }
    } catch { /* handled below */ }
  }
  return url && anonKey ? { url, anonKey } : null;
}
const cfg = publicConfig();

/** Throws on failure rather than returning null — a broken query must fail, not skip. */
function lastRow(out: string): Record<string, unknown> {
  const parsed = JSON.parse(out) as { rows?: Record<string, unknown>[]; _tag?: string; error?: unknown };
  if (parsed._tag === 'Error' || parsed.error) {
    throw new Error(`supabase db query returned an error: ${JSON.stringify(parsed.error).slice(0, 400)}`);
  }
  const rows = parsed.rows ?? [];
  return rows[rows.length - 1] ?? {};
}

function runSql(sql: string): string {
  // The guard select stops a leading "--" comment being read as a CLI flag.
  const wrapped = `select 1 as _guard where false;\n${sql}`;
  try {
    return execFileSync('npx', ['supabase', 'db', 'query', '--linked', wrapped, '--output-format', 'json'],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 });
  } catch (e) {
    // stdout carries the actual SQL error; stderr is only the CLI banner, so
    // preferring stderr here would hide the one thing worth reading.
    const err = e as { stderr?: string; stdout?: string; message?: string };
    throw new Error(`supabase db query failed: ${err.stdout || err.stderr || err.message}`);
  }
}

const query = (sql: string) => lastRow(runSql(sql));

async function queryAsync(sql: string): Promise<Record<string, unknown>> {
  const { stdout } = await execFileAsync('npx',
    ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${sql}`, '--output-format', 'json'],
    { cwd: REPO_ROOT, encoding: 'utf8', timeout: 180_000 });
  return lastRow(stdout);
}

type Case = { area: string; case_name: string; expected: string; actual: string; verdict: string };

function matrix(sql: string): Case[] {
  const parsed = JSON.parse(runSql(sql)) as { rows?: Case[]; _tag?: string; error?: unknown };
  if (parsed._tag === 'Error' || parsed.error) {
    throw new Error(`matrix returned an error: ${JSON.stringify(parsed.error).slice(0, 400)}`);
  }
  return (parsed.rows ?? []).filter((r) => r.verdict);
}

function assertAllPass(rows: Case[], area: string) {
  const mine = rows.filter((r) => r.area === area);
  assert.ok(mine.length > 0, `no cases ran for "${area}"`);
  const failed = mine.filter((r) => r.verdict !== 'PASS');
  if (failed.length) {
    assert.fail(`REGRESSION in ${area}:\n` +
      failed.map((f) => `  • ${f.case_name}: expected ${JSON.stringify(f.expected)}, got ${JSON.stringify(f.actual)}`).join('\n'));
  }
}

// ── 1. The event ledger ─────────────────────────────────────────────────────

describe('a Stripe event id can be claimed once', () => {
  let rows: Case[] = [];

  before(() => {
    rows = matrix(`begin;
create temp table res (n int generated always as identity, area text, case_name text, expected text, actual text);

insert into res (area, case_name, expected, actual)
select 'ledger', 'a new event is claimed', 'claimed',
       public.claim_stripe_event('evt_t_a','payment_intent.succeeded','pi_a');

insert into res (area, case_name, expected, actual)
select 'ledger', 'a duplicate arriving mid-flight is refused', 'in_progress',
       public.claim_stripe_event('evt_t_a','payment_intent.succeeded','pi_a');

insert into res (area, case_name, expected, actual)
select 'ledger', 'completion is recorded', 'true',
       public.mark_stripe_event_processed('evt_t_a')::text;

insert into res (area, case_name, expected, actual)
select 'ledger', 'a processed event replays as a no-op', 'already_processed',
       public.claim_stripe_event('evt_t_a','payment_intent.succeeded','pi_a');

insert into res (area, case_name, expected, actual)
select 'ledger', 'a processed event can never be marked failed', 'processed',
       (select status from (select public.mark_stripe_event_failed('evt_t_a','late')) _,
        lateral (select status from public.stripe_webhook_events where stripe_event_id='evt_t_a') s);

-- The distinction that matters: a row existing is NOT proof the work happened.
insert into res (area, case_name, expected, actual)
select 'ledger', 'a FAILED attempt stays retryable', 'claimed',
       (select public.claim_stripe_event('evt_t_b','x','pi_b')
          from (select public.claim_stripe_event('evt_t_b','x','pi_b')) _1,
        lateral (select public.mark_stripe_event_failed('evt_t_b','boom')) _2);

insert into res (area, case_name, expected, actual)
select 'ledger', 'retries are counted', '2',
       (select attempts::text from public.stripe_webhook_events where stripe_event_id='evt_t_b');

create temp table _c as select public.claim_stripe_event('evt_t_c','x','pi_c') r;
update public.stripe_webhook_events set received_at = now() - interval '20 minutes'
 where stripe_event_id='evt_t_c';

insert into res (area, case_name, expected, actual)
select 'ledger', 'an attempt that died mid-flight is reclaimed once stale', 'claimed',
       public.claim_stripe_event('evt_t_c','x','pi_c');

insert into res (area, case_name, expected, actual)
select 'ledger', 'a live attempt is never stolen', 'in_progress',
       public.claim_stripe_event('evt_t_c','x','pi_c');

create or replace function pg_temp.try_blank() returns text language plpgsql as $f$
begin perform public.claim_stripe_event('', 'x', null); return 'accepted';
exception when others then return 'refused'; end $f$;

insert into res (area, case_name, expected, actual)
select 'ledger', 'a blank event id is refused', 'refused', pg_temp.try_blank();

select n, area, case_name, expected, actual,
       case when expected is not distinct from actual then 'PASS' else 'FAIL' end as verdict
  from res order by n;
rollback;`);
    assert.equal(rows.length, 10, `expected all 10 ledger cases, got ${rows.length}`);
  });

  test('claim, replay, failure and staleness all behave', () => assertAllPass(rows, 'ledger'));
});

// ── 2. Concurrent delivery of the same event ────────────────────────────────

describe('two deliveries of one event arriving together', () => {
  const EVT = 'evt_t_concurrent';
  const cleanup = () => query(`delete from public.stripe_webhook_events where stripe_event_id like 'evt_t_%'; select 1;`);

  before(cleanup);
  after(cleanup);

  test('exactly one delivery may proceed', async () => {
    // A claims and holds its transaction open. B's INSERT contends on the
    // primary key, blocks until A commits, then finds the row already there.
    const a = queryAsync(`begin;
create temp table ca as select public.claim_stripe_event('${EVT}','payment_intent.succeeded','pi_x') r;
select pg_sleep(6);
select r from ca;
commit;`);
    const b = queryAsync(`select pg_sleep(3);
select public.claim_stripe_event('${EVT}','payment_intent.succeeded','pi_x') as r;`);

    const [ra, rb] = await Promise.all([a, b]);
    const results = [String(ra.r), String(rb.r)];
    const claims = results.filter((x) => x === 'claimed').length;

    assert.equal(claims, 1,
      `${claims} deliveries were allowed to fulfil the same Stripe event — expected exactly one. Got ${JSON.stringify(results)}`);
    assert.ok(results.includes('in_progress'),
      `the losing delivery should be told to retry, got ${JSON.stringify(results)}`);

    const state = query(`select count(*)::int as n from public.stripe_webhook_events where stripe_event_id='${EVT}';`);
    assert.equal(state.n, 1, 'the ledger holds more than one row for a single event id');
  });
});

// ── 3. Boost, refunds and capacity ──────────────────────────────────────────

describe('payment fulfilment and refunds', () => {
  let rows: Case[] = [];

  before(() => {
    rows = matrix(`begin;
create temp table pp as select
  (select id from public.profiles where coalesce(role,'')<>'admin' and coalesce(is_platform_owner,false)=false order by id limit 1) u;
create temp table res (n int generated always as identity, area text, case_name text, expected text, actual text);

-- ══ Boost: the claim the webhook performs ═══════════════════════════════════
insert into public.local_businesses (id,name,category,address,owner_id,subscription_tier,subscription_until)
select 'b0057004-0000-4000-8000-00000000ab01','__T5__ biz','other','t',u,'free',null from pp;
insert into public.local_boost_purchases (business_id,owner_id,weeks,amount_pence,stripe_payment_intent_id,status)
select 'b0057004-0000-4000-8000-00000000ab01',u,2,2000,'pi_t_boost','pending' from pp;

create or replace function pg_temp.deliver() returns text language plpgsql as $f$
declare v_w int; v_b uuid; v_start timestamptz; v_new timestamptz;
begin
  update public.local_boost_purchases set status='succeeded'
   where stripe_payment_intent_id='pi_t_boost' and status <> 'succeeded'
  returning weeks, business_id into v_w, v_b;
  if not found then return 'already_granted'; end if;
  select case when subscription_until is not null and subscription_until > now() then subscription_until else now() end
    into v_start from public.local_businesses where id=v_b;
  v_new := v_start + (v_w * interval '7 days');
  update public.local_businesses set subscription_tier='pro', subscription_until=v_new where id=v_b;
  update public.local_boost_purchases set expires_at=v_new where stripe_payment_intent_id='pi_t_boost';
  return 'granted';
end $f$;

create temp table d1 as select pg_temp.deliver() r;
create temp table e1 as select subscription_until e from public.local_businesses where id='b0057004-0000-4000-8000-00000000ab01';
create temp table d2 as select pg_temp.deliver() r;
create temp table d3 as select pg_temp.deliver() r;
create temp table d4 as select pg_temp.deliver() r;
create temp table d5 as select pg_temp.deliver() r;

insert into res (area, case_name, expected, actual)
select 'boost', 'the first delivery grants it', 'granted', (select r from d1);

insert into res (area, case_name, expected, actual)
select 'boost', 'deliveries two to five grant nothing', '4',
       (select count(*)::text from (select r from d2 union all select r from d3
                                    union all select r from d4 union all select r from d5) z
         where z.r='already_granted');

insert into res (area, case_name, expected, actual)
select 'boost', 'five deliveries buy exactly fourteen days', '14',
       (select round(extract(epoch from (subscription_until - now()))/86400)::text
          from public.local_businesses where id='b0057004-0000-4000-8000-00000000ab01');

insert into res (area, case_name, expected, actual)
select 'boost', 'the expiry never moved after the first grant', 'true',
       (select (subscription_until = (select e from e1))::text
          from public.local_businesses where id='b0057004-0000-4000-8000-00000000ab01');

-- ══ Ticket refunds ══════════════════════════════════════════════════════════
insert into public.events (id,title,starts_at,organiser_user_id)
select 'e5000004-0000-4000-8000-00000000ab01','__T5__ ev',now()+interval '7 days',u from pp;
insert into public.event_ticket_types (id,event_id,name,price_pence,quantity_available,quantity_sold,is_active,per_order_max)
values ('e5000004-0000-4000-8000-00000000ab02','e5000004-0000-4000-8000-00000000ab01','__T5__ tt',1000,100,3,true,10);
insert into public.event_ticket_orders (id,event_id,buyer_id,status,total_pence,platform_fee_pence,tickets_count,stripe_payment_intent_id,client_request_id,paid_at)
select 'e5000004-0000-4000-8000-00000000ab03','e5000004-0000-4000-8000-00000000ab01',u,'paid',3000,0,3,'pi_t_full','__T5__1',now() from pp;
insert into public.event_tickets (order_id,event_id,ticket_type_id,holder_id,validation_token_hash,backup_code,status,price_pence)
select 'e5000004-0000-4000-8000-00000000ab03','e5000004-0000-4000-8000-00000000ab01','e5000004-0000-4000-8000-00000000ab02',u,
       encode(sha256(('__T5__t'||g)::bytea),'hex'),'T5X-'||g,'valid',1000 from pp, generate_series(1,3) g;

update public.event_tickets set status='used', checked_in_at=now(), checked_in_by=(select u from pp) where backup_code='T5X-3';
insert into public.event_checkins (ticket_id,event_id,scanner_id,result)
select id,'e5000004-0000-4000-8000-00000000ab01',(select u from pp),'valid'
  from public.event_tickets where backup_code='T5X-3';

create temp table c0 as select quantity_sold s from public.event_ticket_types where id='e5000004-0000-4000-8000-00000000ab02';

insert into res (area, case_name, expected, actual)
select 'refund', 'a full refund voids only the unused tickets', '2',
       (public.refund_event_tickets_for_payment('pi_t_full', true)->>'tickets_voided');

create temp table c1 as select quantity_sold s from public.event_ticket_types where id='e5000004-0000-4000-8000-00000000ab02';

insert into res (area, case_name, expected, actual)
select 'refund', 'the order becomes refunded', 'refunded',
       (select status from public.event_ticket_orders where id='e5000004-0000-4000-8000-00000000ab03');

insert into res (area, case_name, expected, actual)
select 'refund', 'refunded_at is stamped', 'true',
       (select (refunded_at is not null)::text from public.event_ticket_orders where id='e5000004-0000-4000-8000-00000000ab03');

insert into res (area, case_name, expected, actual)
select 'refund', 'an already-used ticket keeps its status', 'used',
       (select status from public.event_tickets where backup_code='T5X-3');

insert into res (area, case_name, expected, actual)
select 'refund', 'its attendance record survives the refund', '1',
       (select count(*)::text from public.event_checkins c join public.event_tickets t on t.id=c.ticket_id
         where t.backup_code='T5X-3' and c.result='valid');

insert into res (area, case_name, expected, actual)
select 'refund', 'the scanner refuses a refunded ticket', 'refunded',
       public.validate_and_checkin_ticket('__T5__t1','e5000004-0000-4000-8000-00000000ab01',(select u from pp))->>'result';

insert into res (area, case_name, expected, actual)
select 'refund', 'the scanner still refuses the used one', 'already_used',
       public.validate_and_checkin_ticket('__T5__t3','e5000004-0000-4000-8000-00000000ab01',(select u from pp))->>'result';

insert into res (area, case_name, expected, actual)
select 'refund', 'a duplicate refund is a no-op', 'already_refunded',
       (public.refund_event_tickets_for_payment('pi_t_full', true)->>'action');

insert into res (area, case_name, expected, actual)
select 'refund', 'a duplicate refund voids nothing further', '0',
       coalesce((public.refund_event_tickets_for_payment('pi_t_full', true)->>'tickets_voided'),'0');

create temp table c2 as select quantity_sold s from public.event_ticket_types where id='e5000004-0000-4000-8000-00000000ab02';

insert into res (area, case_name, expected, actual)
select 'capacity', 'a refund never returns a sold seat', '0',
       ((select s from c1) - (select s from c0))::text;

insert into res (area, case_name, expected, actual)
select 'capacity', 'and three refund deliveries cannot return it either', '0',
       ((select s from c2) - (select s from c0))::text;

-- Partial refunds must be reported, never guessed at.
insert into public.event_ticket_orders (id,event_id,buyer_id,status,total_pence,platform_fee_pence,tickets_count,stripe_payment_intent_id,client_request_id,paid_at)
select 'e5000004-0000-4000-8000-00000000ab04','e5000004-0000-4000-8000-00000000ab01',u,'paid',2000,0,2,'pi_t_part','__T5__2',now() from pp;
insert into public.event_tickets (order_id,event_id,ticket_type_id,holder_id,validation_token_hash,backup_code,status,price_pence)
select 'e5000004-0000-4000-8000-00000000ab04','e5000004-0000-4000-8000-00000000ab01','e5000004-0000-4000-8000-00000000ab02',u,
       encode(sha256(('__T5__p'||g)::bytea),'hex'),'T5P-'||g,'valid',1000 from pp, generate_series(1,2) g;

insert into res (area, case_name, expected, actual)
select 'refund', 'a partial refund is flagged, not guessed', 'partial_refund_not_mapped',
       (public.refund_event_tickets_for_payment('pi_t_part', false)->>'action');

insert into res (area, case_name, expected, actual)
select 'refund', 'a partial refund voids nobody', '2',
       (select count(*)::text from public.event_tickets where order_id='e5000004-0000-4000-8000-00000000ab04' and status='valid');

insert into res (area, case_name, expected, actual)
select 'refund', 'a refund for something else is ignored', 'false',
       (public.refund_event_tickets_for_payment('pi_a_delivery_not_a_ticket', true)->>'matched');

select n, area, case_name, expected, actual,
       case when expected is not distinct from actual then 'PASS' else 'FAIL' end as verdict
  from res order by n;
rollback;`);
    assert.equal(rows.length, 18, `expected all 18 fulfilment cases, got ${rows.length}`);
  });

  test('a boost is granted exactly once', () => assertAllPass(rows, 'boost'));
  test('refunds map to tickets correctly', () => assertAllPass(rows, 'refund'));
  test('capacity is never adjusted by a refund', () => assertAllPass(rows, 'capacity'));
});

// ── 4. A refund racing a scan ───────────────────────────────────────────────

describe('a refund and a scan arriving together', () => {
  let scanner = '';

  const cleanup = () => query(`
    delete from public.event_checkins where event_id='${EV_RACE}'
       or ticket_id in (select id from public.event_tickets where backup_code like 'T5R-%');
    delete from public.event_tickets where backup_code like 'T5R-%';
    delete from public.event_ticket_orders where id='${OR_RACE}';
    delete from public.event_ticket_types where id='${TT_RACE}';
    delete from public.events where id='${EV_RACE}';
    select 1;`);

  const seed = (suffix: string) => query(`
    delete from public.event_checkins where ticket_id in (select id from public.event_tickets where backup_code like 'T5R-%');
    delete from public.event_tickets where backup_code like 'T5R-%';
    update public.event_ticket_orders set status='paid', refunded_at=null,
           stripe_payment_intent_id='pi_t_race_${suffix}' where id='${OR_RACE}';
    insert into public.event_tickets (order_id,event_id,ticket_type_id,holder_id,validation_token_hash,backup_code,status,price_pence)
    select '${OR_RACE}','${EV_RACE}','${TT_RACE}','${scanner}',
           encode(sha256('__T5R__tok${suffix}'::bytea),'hex'),'T5R-${suffix}','valid',1000;
    select 1;`);

  before(() => {
    cleanup();
    const r = query(`
      insert into public.events (id,title,starts_at,organiser_user_id)
      select '${EV_RACE}','__T5R__ race', now()+interval '7 days',
             (select id from public.profiles where coalesce(role,'')<>'admin' and coalesce(is_platform_owner,false)=false order by id limit 1);
      insert into public.event_ticket_types (id,event_id,name,price_pence,quantity_available,quantity_sold,is_active,per_order_max)
      values ('${TT_RACE}','${EV_RACE}','__T5R__ tt',1000,100,1,true,10);
      insert into public.event_ticket_orders (id,event_id,buyer_id,status,total_pence,platform_fee_pence,tickets_count,stripe_payment_intent_id,client_request_id,paid_at)
      select '${OR_RACE}','${EV_RACE}',
             (select id from public.profiles where coalesce(role,'')<>'admin' and coalesce(is_platform_owner,false)=false order by id limit 1),
             'paid',1000,0,1,'pi_t_race_seed','__T5R__seed',now();
      select (select id::text from public.profiles where coalesce(role,'')<>'admin' and coalesce(is_platform_owner,false)=false order by id limit 1) as scanner;`);
    scanner = String(r.scanner);
    assert.match(scanner, /^[0-9a-f-]{36}$/, 'no scanner profile was found for the race fixture');
  });

  after(cleanup);

  test('when the door wins, attendance stands and nothing is voided', async () => {
    seed('A');
    const scan = queryAsync(`begin;
create temp table x as select public.validate_and_checkin_ticket('__T5R__tokA','${EV_RACE}','${scanner}')->>'result' r;
select pg_sleep(6); select r from x; commit;`);
    const refund = queryAsync(`select pg_sleep(3);
select public.refund_event_tickets_for_payment('pi_t_race_A', true)::text as r;`);
    const [s, f] = await Promise.all([scan, refund]);

    assert.equal(s.r, 'valid', 'the scan that started first should have admitted the holder');
    const res = JSON.parse(String(f.r)) as Record<string, unknown>;
    assert.equal(res.tickets_voided, 0, 'the refund voided a ticket that had already been used');
    assert.equal(res.tickets_kept_used, 1, 'the refund did not notice the ticket had been used');

    const st = query(`select t.status, o.status ord,
      (select count(*)::int from public.event_checkins c where c.ticket_id=t.id and c.result='valid') ck,
      (select quantity_sold::int from public.event_ticket_types where id='${TT_RACE}') cap
      from public.event_tickets t join public.event_ticket_orders o on o.id=t.order_id where t.backup_code='T5R-A';`);
    assert.equal(st.status, 'used', 'the admitted ticket should stay used');
    assert.equal(st.ord, 'refunded', 'the money was refunded, so the order should say so');
    assert.equal(st.ck, 1, 'the attendance record was destroyed by the refund');
    assert.equal(st.cap, 1, 'capacity moved during a refund');
  });

  test('when the refund wins, the door is closed', async () => {
    seed('B');
    const refund = queryAsync(`begin;
create temp table y as select public.refund_event_tickets_for_payment('pi_t_race_B', true)::text r;
select pg_sleep(6); select r from y; commit;`);
    const scan = queryAsync(`select pg_sleep(3);
select public.validate_and_checkin_ticket('__T5R__tokB','${EV_RACE}','${scanner}')->>'result' as r;`);
    const [f, s] = await Promise.all([refund, scan]);

    const res = JSON.parse(String(f.r)) as Record<string, unknown>;
    assert.equal(res.tickets_voided, 1, 'the refund should have voided the unused ticket');
    assert.equal(s.r, 'refunded',
      `SPLIT BRAIN: the refund voided the ticket but the scanner answered "${s.r}"`);

    const st = query(`select t.status,
      (select count(*)::int from public.event_checkins c where c.ticket_id=t.id and c.result='valid') ck,
      (select quantity_sold::int from public.event_ticket_types where id='${TT_RACE}') cap
      from public.event_tickets t where t.backup_code='T5R-B';`);
    assert.equal(st.status, 'refunded');
    assert.equal(st.ck, 0, 'a refunded ticket was recorded as having been admitted');
    assert.equal(st.cap, 1, 'capacity moved during a refund');
  });
});

// ── 5. None of it is reachable, and unsigned events are refused ─────────────

describe('the webhook surface stays closed', () => {
  before(() => {
    if (!cfg) throw new Error('Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY (or provide a .env).');
  });

  const denied: Array<[string, Record<string, unknown>]> = [
    ['claim_stripe_event',               { p_event_id: 'evt_x', p_type: 't' }],
    ['mark_stripe_event_processed',      { p_event_id: 'evt_x' }],
    ['mark_stripe_event_failed',         { p_event_id: 'evt_x' }],
    ['refund_event_tickets_for_payment', { p_payment_intent_id: 'pi_x', p_fully_refunded: true }],
  ];

  for (const [fn, body] of denied) {
    test(`anon cannot call ${fn}`, async () => {
      const res = await fetch(`${cfg!.url}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: { apikey: cfg!.anonKey, Authorization: `Bearer ${cfg!.anonKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.notEqual(res.status, 404, `${fn}: signature drifted — this probe stopped testing anything`);
      assert.equal(res.status, 401, `SECURITY REGRESSION: ${fn} answered the anon key with HTTP ${res.status}`);
    });
  }

  // Each verb is filtered, because an unfiltered DELETE trips PostgREST's own
  // "requires a WHERE clause" guard and returns 400 before it ever consults the
  // ACL — which would look like a pass while proving nothing.
  const verbs: Array<[string, string, string | undefined]> = [
    ['GET',    '?select=*',                     undefined],
    ['POST',   '',                              '{"stripe_event_id":"evt_forged","event_type":"x","status":"processed"}'],
    ['PATCH',  '?stripe_event_id=eq.evt_x',     '{"status":"processed"}'],
    ['DELETE', '?stripe_event_id=eq.evt_x',     undefined],
  ];

  for (const [verb, qs, body] of verbs) {
    test(`anon cannot ${verb} the event ledger`, async () => {
      const res = await fetch(`${cfg!.url}/rest/v1/stripe_webhook_events${qs}`, {
        method: verb,
        headers: { apikey: cfg!.anonKey, Authorization: `Bearer ${cfg!.anonKey}`, 'Content-Type': 'application/json' },
        ...(body ? { body } : {}),
      });
      assert.equal(res.status, 401,
        `anon ${verb} on stripe_webhook_events returned HTTP ${res.status} — the idempotency ledger must not be client-writable`);
    });
  }

  const forged = JSON.stringify({
    id: 'evt_forged_by_test',
    type: 'payment_intent.succeeded',
    data: { object: { id: 'pi_forged', amount: 999999, metadata: { type: 'local_boost', weeks: '52' } } },
  });

  test('an unsigned webhook is refused', async () => {
    const res = await fetch(`${cfg!.url}/functions/v1/stripe-webhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: forged,
    });
    assert.equal(res.status, 400, `an unsigned event returned HTTP ${res.status} instead of being refused`);
  });

  test('a wrongly signed webhook is refused', async () => {
    const res = await fetch(`${cfg!.url}/functions/v1/stripe-webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}` },
      body: forged,
    });
    assert.equal(res.status, 400, `a forged signature returned HTTP ${res.status} instead of being refused`);
  });

  test('a refused event never reaches the ledger', () => {
    const r = query(`select count(*)::int as n from public.stripe_webhook_events where stripe_event_id='evt_forged_by_test';`);
    assert.equal(r.n, 0, 'an event that failed signature verification was still claimed');
  });
});
