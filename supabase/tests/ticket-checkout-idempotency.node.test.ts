/**
 * ticket-checkout-idempotency.node.test.ts — one checkout, one order.
 *
 * WHY THIS TEST EXISTS
 * Nothing tied two ticket-checkout requests together as the same attempt, so a
 * lost response or a double tap produced a second order and a second capacity
 * reservation. Reproduced on production before the fix: two identical calls →
 * 2 orders, capacity delta 4 for a basket of 2.
 *
 * The key is the ATTEMPT, not the basket. Adult x2 today and Adult x2 tomorrow
 * are two purchases; any key derived from buyer + event + basket would refuse
 * the second genuine sale.
 *
 * WHAT IS ASSERTED
 *   · a retry returns the original order and reserves nothing
 *   · two ids make two orders (idempotency is not deduplication by basket)
 *   · a reused id with a different basket is a conflict, not a silent swap
 *   · an expired attempt cannot be resurrected
 *   · a paid attempt replays without re-reserving
 *   · the unique index makes a duplicate order impossible, not merely unlikely
 *   · capacity is claimed AFTER the attempt, so a loser changes no counter
 *   · both clients mint the id at the checkout boundary, not per HTTP call
 *   · the RPC stays server-only
 *
 * SAFETY
 * Every database case runs inside a transaction that is always rolled back.
 *
 * Live concurrency was additionally verified by hand against production with
 * two simultaneous connections (one order, capacity once, loser flagged
 * already=true) and the test rows removed afterwards. That cannot be repeated
 * safely from a test suite, so what is asserted here is the mechanism that
 * makes it true: the unique index, and the order of operations inside the RPC.
 *
 * Run: npm test
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_ROOT = join(REPO_ROOT, '..', 'oneshetland-web');

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

function query(sql: string): Record<string, unknown> | null {
  try {
    const out = execFileSync('npx', ['supabase', 'db', 'query', '--linked', sql, '--output-format', 'json'],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 180_000 });
    return (JSON.parse(out) as { rows?: Record<string, unknown>[] }).rows?.[0] ?? null;
  } catch { return null; }
}

// ── 1. Replay semantics against the live schema ─────────────────────────────

const SQL = `
begin;
create function pg_temp.try(p_sql text) returns text language plpgsql as $f$
declare r text; begin execute p_sql into r; return r;
exception when others then return 'ERR:'||left(SQLERRM,44); end $f$;
create temp table t as select id, event_id from public.event_ticket_types limit 1;
update public.event_ticket_types set quantity_available=quantity_sold+60, is_active=true, per_order_max=10 where id=(select id from t);
create temp table u as select id from public.profiles limit 1;
create temp table b0 as select quantity_sold s from public.event_ticket_types where id=(select id from t);
create temp table o0 as select count(*) n from public.event_ticket_orders;
create function pg_temp.seats(p_type uuid, p_n int) returns jsonb language sql as $g$
  select jsonb_agg(jsonb_build_object('ticket_type_id',p_type,
    'token_hash', encode(sha256((p_type::text||g||random()::text)::bytea),'hex')))
  from generate_series(1,p_n) g $g$;
create function pg_temp.call(p_id text, p_n int) returns text language plpgsql as $h$
begin return pg_temp.try('select public.reserve_ticket_basket('''||(select event_id from t)||'''::uuid,'''
  ||(select id from u)||'''::uuid, pg_temp.seats('''||(select id from t)||'''::uuid,'||p_n||'),0,0,''{}''::jsonb,'''||p_id||''')::text'); end $h$;

create temp table c1 as select pg_temp.call('attempt-AAAAAAAA',2) v;
create temp table c2 as select pg_temp.call('attempt-AAAAAAAA',2) v;
create temp table c3 as select pg_temp.call('attempt-AAAAAAAA',5) v;
create temp table c4 as select pg_temp.call('attempt-BBBBBBBB',2) v;

-- expire the first attempt, then retry it
update public.event_ticket_orders set created_at = now() - interval '3 hours'
 where id = ((select v from c1)::jsonb->>'order_id')::uuid;
create temp table sweep as select public.expire_stale_ticket_orders(60) n;
create temp table c5 as select pg_temp.call('attempt-AAAAAAAA',2) v;

-- a paid attempt replays without re-reserving
create temp table p1 as select pg_temp.call('attempt-PAIDPAID',2) v;
update public.event_ticket_orders set status='paid', paid_at=now()
 where id = ((select v from p1)::jsonb->>'order_id')::uuid;
create temp table bp as select quantity_sold s from public.event_ticket_types where id=(select id from t);
create temp table p2 as select pg_temp.call('attempt-PAIDPAID',2) v;

-- the unique index must make a duplicate order impossible on its own
create temp table dup as select pg_temp.try(
  'insert into public.event_ticket_orders (event_id,buyer_id,status,total_pence,platform_fee_pence,tickets_count,client_request_id)
   values ('''||(select event_id from t)||''','''||(select id from u)||''',''pending'',0,0,1,''attempt-BBBBBBBB'') returning ''inserted''') v;

select
  ((select v from c1)::jsonb->>'order_id') = ((select v from c2)::jsonb->>'order_id') as retry_same_order,
  ((select v from c2)::jsonb->>'already')                    as retry_already,
  ((select v from c1)::jsonb->>'already')                    as first_already,
  (select v from c3) like '%IDEMPOTENCY_CONFLICT%'           as changed_basket_conflict,
  ((select v from c4)::jsonb->>'order_id') <> ((select v from c1)::jsonb->>'order_id') as second_id_new_order,
  (select v from c5) like '%CHECKOUT_EXPIRED%'               as expired_not_resurrected,
  ((select v from p2)::jsonb->>'order_id') = ((select v from p1)::jsonb->>'order_id') as paid_replay_same_order,
  ((select quantity_sold from public.event_ticket_types where id=(select id from t))-(select s from bp)) as paid_replay_capacity_delta,
  (select v from dup) like 'ERR:%'                           as duplicate_insert_blocked,
  ((select count(*) from public.event_ticket_orders)-(select n from o0)) as total_orders_created,
  -- claim-before-capacity: the order INSERT must appear before the counter UPDATE
  (select position('insert into public.event_ticket_orders' in prosrc)
        < position('set quantity_sold = tt.quantity_sold + w.qty' in prosrc)
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='reserve_ticket_basket')  as claims_before_reserving;
rollback;`;

describe('one checkout attempt, one order', () => {
  let r: Record<string, unknown> | null = null;
  before(() => { r = query(SQL); });

  const CASES: Array<[string, unknown, string]> = [
    ['retry_same_order',        true,   'a retry created a DIFFERENT order — capacity is held twice'],
    ['retry_already',           'true', 'a retry was not flagged as a replay, so the caller would pay again'],
    ['first_already',           'false','the first call was wrongly reported as a replay'],
    ['changed_basket_conflict', true,   'the same id was reused for a different basket and silently accepted'],
    ['second_id_new_order',     true,   'a genuinely new purchase was refused — idempotency became deduplication'],
    ['expired_not_resurrected', true,   'an expired attempt was resurrected, re-taking seats under a dead id'],
    ['paid_replay_same_order',  true,   'replaying a paid attempt did not resolve to the original order'],
    ['paid_replay_capacity_delta', 0,   'replaying a paid attempt reserved capacity again'],
    ['duplicate_insert_blocked',true,   'the unique index does not exist — two orders can share one attempt id'],
    ['total_orders_created',    3,      'wrong number of orders: expected AAAA, BBBB and PAID only'],
    ['claims_before_reserving', true,   'capacity is incremented BEFORE the attempt is claimed — a concurrent loser would leave the counter raised'],
  ];

  test('replay, conflict, expiry and the uniqueness guarantee', (t) => {
    if (!r) { t.skip('Supabase CLI or linked project unavailable — run `supabase link`.'); return; }
    const failed = CASES.filter(([k, want]) => r![k] !== want);
    if (failed.length) {
      assert.fail('IDEMPOTENCY REGRESSION:\n' +
        failed.map(([k, want, why]) => `  • ${k}: ${why} (got ${JSON.stringify(r![k])}, expected ${JSON.stringify(want)})`).join('\n'));
    }
    console.log('\n  checkout idempotency verified against the live schema (rolled back)\n');
  });
});

// ── 2. The attempt id is minted in the right place ──────────────────────────
//
// This is the mistake that would silently remove the whole protection: mint the
// id inside the API helper and every retry gets a new one. A grep test is crude
// but it catches exactly that, in both repos.

describe('both clients mint the attempt id at the checkout boundary', () => {
  const read = (p: string) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };

  test('mobile: the screen mints it, the API layer does not', () => {
    const screen = read(join(REPO_ROOT, 'app', 'event-ticket-checkout.tsx'));
    const api = read(join(REPO_ROOT, 'lib', 'events-api.ts'));
    assert.ok(screen?.includes('newCheckoutAttemptId'), 'the checkout screen no longer mints an attempt id');
    assert.ok(screen?.includes('client_request_id'), 'the checkout screen does not send client_request_id');
    assert.ok(!api?.includes('newCheckoutAttemptId'),
      'lib/events-api.ts mints the attempt id — every retry would get a new one and the protection is gone');
  });

  test('web: the modal mints it, the API layer does not', (t) => {
    const modal = read(join(WEB_ROOT, 'components', 'events', 'TicketModal.tsx'));
    const api = read(join(WEB_ROOT, 'lib', 'events-client.ts'));
    if (modal === null || api === null) { t.skip('oneshetland-web not checked out alongside this repo'); return; }
    assert.ok(modal.includes('newCheckoutAttemptId'), 'TicketModal no longer mints an attempt id');
    assert.ok(modal.includes('useRef'), 'TicketModal must hold the id in a ref so a re-render cannot mint a new one');
    assert.ok(!api.includes('newCheckoutAttemptId'),
      'lib/events-client.ts mints the attempt id — every retry would get a new one and the protection is gone');
  });

  test('the mobile attempt id comes from a CSPRNG, with no weak fallback', () => {
    const helper = read(join(REPO_ROOT, 'lib', 'checkout-attempt.ts'));
    assert.ok(helper, 'lib/checkout-attempt.ts is missing');
    assert.ok(helper!.includes("from 'expo-crypto'"),
      'the mobile attempt id no longer comes from expo-crypto — React Native has no crypto polyfill of its own');

    // Comments may discuss the old Math.random fallback; executable code may not
    // use it. Strip block-comment and line-comment content before checking.
    const code = helper!
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/Math\.random/.test(code),
      'Math.random is back in the checkout attempt id — a predictable identifier in a payment path');

    const pkg = read(join(REPO_ROOT, 'package.json'));
    assert.match(pkg ?? '', /"expo-crypto"\s*:/,
      'expo-crypto is not a declared dependency, so the shipped app would fail to resolve it');
  });

  test('the Stripe idempotency key is derived from the order, so it is stable across retries', () => {
    const fn = read(join(REPO_ROOT, 'supabase', 'functions', 'create-event-ticket-intent', 'index.ts'));
    assert.ok(fn?.includes('`evt-order-${order.id}`'),
      'the Stripe idempotency key is no longer derived from the order id — a retry could create a second PaymentIntent');
  });
});

// ── 3. Still server-only ────────────────────────────────────────────────────

describe('reserve_ticket_basket stays server-only', () => {
  before(() => { if (!cfg) throw new Error('Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY (or provide a .env).'); });

  test('anon cannot execute it, with or without an attempt id', async () => {
    const res = await fetch(`${cfg!.url}/rest/v1/rpc/reserve_ticket_basket`, {
      method: 'POST',
      headers: { apikey: cfg!.anonKey, Authorization: `Bearer ${cfg!.anonKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        p_event_id: '00000000-0000-0000-0000-000000000000',
        p_buyer_id: '00000000-0000-0000-0000-000000000000',
        p_tickets: [], p_total_pence: 0, p_platform_fee_pence: 0, p_snapshot: {},
        p_client_request_id: 'probe-attempt-id',
      }),
    });
    assert.notEqual(res.status, 404, 'signature drifted — the probe stopped testing anything');
    assert.equal(res.status, 401, `reserve_ticket_basket answered the anon key with HTTP ${res.status}`);
  });
});
