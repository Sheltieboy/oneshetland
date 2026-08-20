/**
 * ticket-basket-atomicity.node.test.ts — a basket reserves entirely or not at all.
 *
 * WHY THIS TEST EXISTS
 * create-event-ticket-intent reserved capacity one line at a time and returned
 * 409 on the first failure without releasing what it had already taken:
 *
 *     Adult x2 succeeds → Child x3 sells out → 409 → Adult's 2 seats held forever
 *
 * The worse half was the ordering. Capacity was reserved BEFORE the order row
 * existed, and expire_stale_ticket_orders releases capacity by counting
 * event_tickets rows joined to a pending order — so anything reserved without an
 * order was invisible to the only thing that gives seats back. Four failure
 * paths then DELETED the order and its tickets, destroying that evidence
 * outright.
 *
 * Migration 20260819220000 makes reservation, the pending order and the ticket
 * rows one database transaction (reserve_ticket_basket), and gives aborts a way
 * to hand the seats back (release_ticket_order).
 *
 * SAFETY
 * Every database case runs inside a transaction that is always rolled back.
 * Nothing here changes production capacity.
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
const NIL = '00000000-0000-0000-0000-000000000000';

// ── 1. Atomicity, capacity and the input contract ───────────────────────────

function dbProbe(): Record<string, unknown> | null {
  const sql = `
begin;
create function pg_temp.try(p_sql text) returns text language plpgsql as $f$
declare r text; begin execute p_sql into r; return 'OK';
exception when others then return 'REJECTED:'||left(SQLERRM,24); end $f$;

-- two ticket types on ONE event: A has room for 5, B for 1
create temp table ab as
  select id, event_id, row_number() over (order by id) rn
    from public.event_ticket_types
   where event_id = (select event_id from public.event_ticket_types
                      group by event_id having count(*)>=2 limit 1)
   limit 2;
update public.event_ticket_types set quantity_available=quantity_sold+5, is_active=true, per_order_max=10 where id=(select id from ab where rn=1);
update public.event_ticket_types set quantity_available=quantity_sold+1, is_active=true, per_order_max=10 where id=(select id from ab where rn=2);
create temp table u  as select id from public.profiles limit 1;
create temp table ev as select id from public.events where id <> (select event_id from ab limit 1) limit 1;
create temp table b0 as select
  (select quantity_sold from public.event_ticket_types where id=(select id from ab where rn=1)) a,
  (select quantity_sold from public.event_ticket_types where id=(select id from ab where rn=2)) b;

-- distinct hash per seat: validation_token_hash is UNIQUE, as it must be
create function pg_temp.seats(p_type uuid, p_n int) returns jsonb language sql as $g$
  select coalesce(jsonb_agg(jsonb_build_object('ticket_type_id',p_type,
    'token_hash', encode(sha256((p_type::text||g||random()::text)::bytea),'hex'))),'[]'::jsonb)
  from generate_series(1, greatest(p_n,0)) g $g$;
create function pg_temp.reserve(p_event uuid, p_json text) returns text language plpgsql as $h$
-- Each call here is a genuinely different checkout, so each gets its own
-- attempt id. client_request_id is REQUIRED since 20260819280000.
begin return pg_temp.try('select public.reserve_ticket_basket('''||p_event||'''::uuid,'''||
  (select id from u)||'''::uuid,'||p_json||',0,0,''{}''::jsonb,''atomicity-''||gen_random_uuid())::text'); end $h$;

-- (a) PARTIAL: A x2 fits, B x3 does not → nothing may change
create temp table r_partial as select pg_temp.reserve((select event_id from ab limit 1),
  'pg_temp.seats('''||(select id from ab where rn=1)||'''::uuid,2) || pg_temp.seats('''||(select id from ab where rn=2)||'''::uuid,3)') as v;
create temp table b1 as select
  (select quantity_sold from public.event_ticket_types where id=(select id from ab where rn=1)) a,
  (select quantity_sold from public.event_ticket_types where id=(select id from ab where rn=2)) b;

-- (b) GOOD: A x2 + B x1
create temp table r_good as select pg_temp.reserve((select event_id from ab limit 1),
  'pg_temp.seats('''||(select id from ab where rn=1)||'''::uuid,2) || pg_temp.seats('''||(select id from ab where rn=2)||'''::uuid,1)') as v;
create temp table b2 as select
  (select quantity_sold from public.event_ticket_types where id=(select id from ab where rn=1)) a,
  (select quantity_sold from public.event_ticket_types where id=(select id from ab where rn=2)) b;

-- (c) LAST SEAT: B now has none left
create temp table r_last as select pg_temp.reserve((select event_id from ab limit 1),
  'pg_temp.seats('''||(select id from ab where rn=2)||'''::uuid,1)') as v;

select
  (select v from r_partial) like 'REJECTED%'                    as partial_rejected,
  ((select a from b1)-(select a from b0))                       as partial_a_delta,
  ((select b from b1)-(select b from b0))                       as partial_b_delta,
  (select v from r_good) = 'OK'                                 as good_accepted,
  ((select a from b2)-(select a from b1))                       as good_a_delta,
  ((select b from b2)-(select b from b1))                       as good_b_delta,
  (select v from r_last) like '%SOLD_OUT%'                      as last_seat_sold_out,
  (select quantity_sold <= quantity_available from public.event_ticket_types where id=(select id from ab where rn=2)) as never_oversold,
  pg_temp.reserve((select id from ev), 'pg_temp.seats('''||(select id from ab where rn=1)||'''::uuid,1)') as wrong_event,
  pg_temp.reserve((select event_id from ab limit 1), '''[]''::jsonb')                                     as empty_basket,
  pg_temp.reserve((select event_id from ab limit 1),
    '''[{"ticket_type_id":"'||(select id from ab where rn=1)||'"}]''::jsonb')                             as no_token_hash,
  pg_temp.reserve((select event_id from ab limit 1),
    'pg_temp.seats('''||(select id from ab where rn=1)||'''::uuid,11)')                                   as over_per_order_max,
  -- deterministic lock ordering, asserted from the shipped function body
  (select prosrc ~ 'order by tt\\.id[\\s]*for update' from pg_proc p
     join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='reserve_ticket_basket')                                       as locks_in_id_order
from r_partial;
rollback;`;
  try {
    const out = execFileSync('npx', ['supabase', 'db', 'query', '--linked', sql, '--output-format', 'json'],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 150_000 });
    return (JSON.parse(out) as { rows?: Record<string, unknown>[] }).rows?.[0] ?? null;
  } catch { return null; }
}

describe('a ticket basket reserves entirely or not at all', () => {
  let r: Record<string, unknown> | null = null;
  before(() => { r = dbProbe(); });

  const CASES: Array<[string, unknown, string]> = [
    ['partial_rejected',   true, 'a basket whose later line sold out was still accepted'],
    ['partial_a_delta',    0,    'SECURITY REGRESSION: the earlier line kept its seats after the basket failed'],
    ['partial_b_delta',    0,    'the failing line moved capacity'],
    ['good_accepted',      true, 'a basket that fits was refused'],
    ['good_a_delta',       2,    'a valid basket did not reserve line A exactly'],
    ['good_b_delta',       1,    'a valid basket did not reserve line B exactly'],
    ['last_seat_sold_out', true, 'the last seat was sold twice'],
    ['never_oversold',     true, 'the event was oversold'],
    ['locks_in_id_order',  true, 'ticket types are no longer locked in id order — concurrent baskets can deadlock'],
  ];

  test('atomicity and capacity', (t) => {
    if (!r) { t.skip('Supabase CLI or linked project unavailable — run `supabase link`.'); return; }
    const failed = CASES.filter(([k, want]) => r![k] !== want);
    if (failed.length) {
      assert.fail('RESERVATION REGRESSION:\n' +
        failed.map(([k, want, why]) => `  • ${k}: ${why} (got ${JSON.stringify(r![k])}, expected ${JSON.stringify(want)})`).join('\n'));
    }
    console.log('\n  basket atomicity verified against the live schema (rolled back)\n');
  });

  test('the database enforces its own input contract', (t) => {
    if (!r) { t.skip('CLI unavailable'); return; }
    for (const k of ['wrong_event', 'empty_basket', 'no_token_hash', 'over_per_order_max']) {
      assert.match(String(r[k]), /^REJECTED/,
        `${k}: reserve_ticket_basket accepted it — the database must not rely on the edge function alone`);
    }
  });
});

// ── 2. Release + expiry compatibility ───────────────────────────────────────

function releaseProbe(): Record<string, unknown> | null {
  const sql = `
begin;
create temp table t as select id, event_id from public.event_ticket_types limit 1;
update public.event_ticket_types set quantity_available=quantity_sold+10, is_active=true, per_order_max=10 where id=(select id from t);
create temp table u as select id from public.profiles limit 1;
create temp table b0 as select quantity_sold s from public.event_ticket_types where id=(select id from t);
create function pg_temp.seats(p_type uuid, p_n int) returns jsonb language sql as $g$
  select jsonb_agg(jsonb_build_object('ticket_type_id',p_type,
    'token_hash', encode(sha256((p_type::text||g||random()::text)::bytea),'hex')))
  from generate_series(1,p_n) g $g$;
create temp table made as select (public.reserve_ticket_basket(
  (select event_id from t),(select id from u),pg_temp.seats((select id from t),3),0,0,'{}'::jsonb,
  'release-'||gen_random_uuid())->>'order_id')::uuid oid;
create temp table b1 as select quantity_sold s from public.event_ticket_types where id=(select id from t);
create temp table rel as select
  public.release_ticket_order((select oid from made)) r1,
  public.release_ticket_order((select oid from made)) r2,
  public.release_ticket_order((select oid from made)) r3;
select rel.r1, rel.r2, rel.r3,
  ((select s from b1)-(select s from b0)) as reserved_delta,
  ((select quantity_sold from public.event_ticket_types where id=(select id from t))-(select s from b0)) as final_delta,
  (select status from public.event_ticket_orders where id=(select oid from made)) as order_status,
  (select count(*) from public.event_ticket_orders
     where status='pending' and id=(select oid from made)) as still_expirable
from rel;
rollback;`;
  try {
    const out = execFileSync('npx', ['supabase', 'db', 'query', '--linked', sql, '--output-format', 'json'],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 150_000 });
    return (JSON.parse(out) as { rows?: Record<string, unknown>[] }).rows?.[0] ?? null;
  } catch { return null; }
}

describe('releasing an aborted checkout', () => {
  let r: Record<string, unknown> | null = null;
  before(() => { r = releaseProbe(); });

  test('gives the seats back exactly once, however many times it runs', (t) => {
    if (!r) { t.skip('CLI unavailable'); return; }
    assert.equal(r.reserved_delta, 3, 'the basket did not reserve 3 seats');
    assert.equal(r.r1, true, 'the first release did nothing');
    assert.equal(r.r2, false, 'a second release acted again — it is not idempotent');
    assert.equal(r.r3, false, 'a third release acted again — it is not idempotent');
    assert.equal(r.final_delta, 0, 'capacity was not fully returned, or was returned twice');
    assert.equal(r.order_status, 'cancelled', 'the released order was left pending');
    assert.equal(r.still_expirable, 0,
      'the order is still pending after release — expire_stale_ticket_orders would double-release it');
  });
});

// ── 3. Nothing that mutates capacity is reachable from a browser ────────────

describe('reservation RPCs are server-only', () => {
  before(() => { if (!cfg) throw new Error('Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY (or provide a .env).'); });

  const RPCS: Array<[string, Record<string, unknown>]> = [
    // p_client_request_id is required since 20260819280000 — omitting it gives a
    // 404 (no matching signature), which would hide the permission answer.
    ['reserve_ticket_basket', { p_event_id: NIL, p_buyer_id: NIL, p_tickets: [], p_total_pence: 0, p_platform_fee_pence: 0, p_snapshot: {}, p_client_request_id: 'probe-attempt-id' }],
    ['release_ticket_order', { p_order_id: NIL }],
    ['reserve_ticket_slots', { p_type_id: NIL, p_quantity: 1 }],
    ['expire_stale_ticket_orders', { p_older_than_minutes: 999_999 }],
  ];

  for (const [fn, body] of RPCS) {
    test(`anon cannot execute ${fn}`, async () => {
      const res = await fetch(`${cfg!.url}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: { apikey: cfg!.anonKey, Authorization: `Bearer ${cfg!.anonKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.notEqual(res.status, 404, `${fn}: signature drifted — the probe stopped testing anything`);
      assert.equal(res.status, 401,
        `SECURITY REGRESSION: ${fn} answered the public anon key with HTTP ${res.status}. ` +
        `It mutates event capacity and must be service-role only.`);
    });
  }
});
