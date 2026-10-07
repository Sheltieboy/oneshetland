/**
 * event-ticket-orders-server-only.node.test.ts — nobody but the server can write a ticket order.
 *
 * WHAT WAS WRONG
 *
 * ticket_orders_buyer_insert (baseline) let any signed-in user INSERT into event_ticket_orders with only `buyer_id =
 * auth.uid()` checked, under `GRANT ALL ... TO authenticated`. status 'paid', the total, the event, the id and the
 * stripe_payment_intent_id were all the caller's to choose; there was no insert trigger. refund-payment then trusted the
 * payment id on such a row. Migration 20261116000000 removes the policy and every client write privilege, and adds a trigger
 * that refuses a client-role write even if privileges are ever re-granted.
 *
 * HOW IT PROVES IT
 *
 * The pre-fix state is rebuilt from the BASELINE's own CREATE TABLE and CREATE POLICY text with Supabase's default grants.
 * The forgery is run first and must SUCCEED (a control). The migration is then applied exactly as written and the same
 * forgery — and every variant of it — must fail. The real reserve_ticket_basket / refund_event_tickets_for_payment /
 * release_ticket_order / claim_stripe_event run as service_role to prove the genuine checkout still works end to end.
 *
 * SAFETY — ISOLATED DATABASE ONLY: requires PASS_PROOF_DSN, refuses a DSN mentioning Supabase. No Stripe, no network.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIG = join(REPO_ROOT, 'supabase/migrations');
const BASELINE = join(MIG, '20260623000000_baseline_remote_schema.sql');
const BASKET = join(MIG, '20260819220000_atomic_ticket_basket.sql');
const TICKETIDEM = join(MIG, '20260819260000_ticket_checkout_idempotency.sql');
const STRIPEIDEM = join(MIG, '20260820140000_stripe_event_idempotency_and_ticket_refunds.sql');
const CAPACITY = join(MIG, '20261030000000_refund_releases_capacity.sql');
const SERVER_WRITE = join(MIG, '20261007120000_business_wallet_refunds.sql');
const FIX = join(MIG, '20261116000000_event_ticket_orders_server_only.sql');
const DSN = process.env.PASS_PROOF_DSN ?? '';
const PSQL = process.env.PASS_PROOF_PSQL ?? 'psql';
const src = (p: string) => readFileSync(p, 'utf8');

/** Everything psql said — stdout AND stderr — so a refusal is visible. Never throws. */
function raw(body: string): string {
  const r = spawnSync(PSQL, [DSN, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=0', '-c', body], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000 });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
}
const TAG = /^(SET|RESET|BEGIN|COMMIT|ROLLBACK|DO|GRANT|REVOKE|COMMENT|CREATE .*|DROP .*|ALTER .*|INSERT \d+ \d+|UPDATE \d+|DELETE \d+)$/;
const rowsOf = (out: string) => out.split('\n').map((l) => l.trim()).filter((l) => l && !TAG.test(l) && !/^ERROR|^psql:|^LINE |^\s*\^|^DETAIL|^HINT|^CONTEXT/.test(l));
const scalar = (sql: string) => rowsOf(raw(sql)).pop() ?? '';

function slice(file: string, opener: string, closer: string): string {
  const s = src(file); const start = s.indexOf(opener);
  assert.notEqual(start, -1, `${opener} is gone from ${file}`);
  const end = s.indexOf(closer, start); assert.notEqual(end, -1, `no end for ${opener}`);
  return s.slice(start, end + closer.length);
}
function createTable(file: string, opener: string): string {
  const s = src(file); const start = s.indexOf(opener); assert.notEqual(start, -1, `${opener} is gone`);
  const open = s.indexOf('(', start); let d = 0, end = -1;
  for (let i = open; i < s.length; i++) { if (s[i] === '(') d++; else if (s[i] === ')') { d--; if (d === 0) { end = i; break; } } }
  return s.slice(start, end + 1) + ';';
}
const policy = (table: string, name: string) =>
  src(BASELINE).match(new RegExp(`CREATE POLICY ${name} ON public\\.${table}[^;]*;`))?.[0] ?? assert.fail(`policy ${name} is gone from the baseline`);

const EV = '71710000-0000-4000-8000-000000000071';
const EV_OTHER = '71710000-0000-4000-8000-000000000072';
const TT_PAID = '81810000-0000-4000-8000-000000000081';
const BIZ = 'b1b10000-0000-4000-8000-0000000000b1';
const ADMIN = 'a0a0a0a0-0000-4000-8000-a0a0a0a0a0a0';
const ALICE = 'a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1';   // a buyer
const EVE   = 'e3e3e3e3-3333-4333-8333-e3e3e3e3e3e3';   // an attacker
const OWNER = 'c0c0c0c0-0000-4000-8000-0000000000c0';   // owns the business that organises EV

type Who = 'anon' | 'alice' | 'eve' | 'owner' | 'admin' | 'service';
const SUB: Record<string, string> = { alice: ALICE, eve: EVE, owner: OWNER, admin: ADMIN };
const roleSql = (who: Who) => who === 'anon' ? 'set local role anon;' : who === 'service' ? 'set local role service_role;'
  : `set local request.jwt.claim.sub = '${SUB[who]}'; set local role authenticated;`;
/** One statement as `who`, ROLLED BACK — a write that succeeds leaves nothing behind. */
const tryAs = (who: Who, sql: string) => raw(`begin; ${roleSql(who)} ${sql}; rollback;`);
/** As `who`, committed. */
const doAs = (who: Who, sql: string) => raw(`begin; ${roleSql(who)} ${sql}; commit;`);
const denied = (o: string) => /permission denied|server only|42501/i.test(o);
const touched = (who: Who, write: string) => Number(rowsOf(tryAs(who, `with w as (${write} returning 1) select count(*) from w`)).pop() ?? NaN);

const FORGED_ID = 'f0f0f0f0-0000-4000-8000-0000000000f0';
const FORGE_PAID = `insert into public.event_ticket_orders (id, event_id, buyer_id, status, total_pence, platform_fee_pence, tickets_count, stripe_payment_intent_id, paid_at)
                    values ('${FORGED_ID}', '${EV}', '${EVE}', 'paid', 196, 96, 1, 'pi_FORGED_TOPUP', now())`;

let CONTROL_FORGED = NaN;
let POLICIES_OUTSIDE_BEFORE = '';
let GRANTS_OUTSIDE_BEFORE = '';
const policiesOutside = () => raw(`select string_agg(format('%s|%s|%s|%s|%s|%s', tablename, policyname, cmd, roles, qual, with_check), E'\\n' order by tablename, policyname)
  from pg_policies where schemaname='public' and tablename <> 'event_ticket_orders'`);
const grantsOutside = () => raw(`select string_agg(format('%s|%s|%s', table_name, grantee, privilege_type), E'\\n' order by table_name, grantee, privilege_type)
  from information_schema.role_table_grants where table_schema='public' and table_name <> 'event_ticket_orders'`);

let seq = 0;
function reserve(buyer: string, event = EV): string {
  seq += 1;
  const t = `{"ticket_type_id":"${TT_PAID}","token_hash":"${'a'.repeat(40)}${seq}"}`;
  const out = doAs('service', `select public.reserve_ticket_basket('${event}','${buyer}','[${t}]'::jsonb,196,96,'{}'::jsonb,'req-${seq}-abcdefgh')->>'order_id'`);
  const v = rowsOf(out).pop() ?? '';
  assert.match(v, /^[0-9a-f-]{36}$/, `reserve_ticket_basket failed as service_role:\n${out}`);
  return v;
}

before(() => {
  assert.ok(DSN, 'PASS_PROOF_DSN is not set — run `npm run test:isolated`.');
  assert.ok(!/supabase\.co|pooler\.supabase/.test(DSN), 'PASS_PROOF_DSN points at Supabase. Refusing to run.');

  const migration = src(CAPACITY);
  const upto = migration.indexOf('-- Self-heal.');
  assert.notEqual(upto, -1, 'the capacity migration lost its self-heal section');

  const out = raw([
    'drop schema if exists public cascade; create schema public; drop schema if exists auth cascade; create schema auth;',
    `do $$ begin
       if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
       if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
       if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
     end $$;`,
    'alter role service_role bypassrls;',
    'grant usage on schema public, auth to anon, authenticated, service_role;',
    `create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;`,
    'grant execute on function auth.uid() to anon, authenticated, service_role;',
    // what the read policy points at
    `create table public.profiles (id uuid primary key, role text default 'customer', is_platform_owner boolean);
     create table public.local_businesses (id uuid primary key, owner_id uuid);
     create function public.is_hub_admin(h uuid, u uuid) returns boolean language sql as $$ select false $$;`,
    ...['events', 'event_ticket_types', 'event_ticket_orders', 'event_tickets']
      .flatMap((t) => [createTable(BASELINE, `CREATE TABLE public.${t} (`), `alter table public.${t} add primary key (id);`]),
    `alter table public.event_ticket_orders add constraint event_ticket_orders_stripe_payment_intent_id_key unique (stripe_payment_intent_id);`,
    slice(TICKETIDEM, 'alter table public.event_ticket_orders\n  add column if not exists client_request_id', ';'),
    slice(TICKETIDEM, 'create unique index if not exists event_ticket_orders_buyer_request_key', ';'),
    slice(STRIPEIDEM, 'alter table public.event_ticket_orders\n  add column if not exists refunded_at', ';'),
    slice(BASELINE, 'CREATE FUNCTION public.generate_ticket_backup_code', '$$;'),
    slice(BASKET, 'create or replace function public.release_ticket_order', '$$;'),
    migration.slice(0, upto),
    createTable(STRIPEIDEM, 'create table if not exists public.stripe_webhook_events ('),
    slice(STRIPEIDEM, 'create or replace function public.claim_stripe_event(', '$$;'),
    slice(STRIPEIDEM, 'create or replace function public.mark_stripe_event_processed(', '$$;'),
    slice(SERVER_WRITE, 'create or replace function public.tg_is_server_write()', '$$;'),
    // the two policies the table had, verbatim — plus RLS on, and Supabase's default grants
    'alter table public.event_ticket_orders enable row level security;',
    policy('event_ticket_orders', 'ticket_orders_buyer_insert'),
    policy('event_ticket_orders', 'ticket_orders_buyer_read'),
    'grant all on all tables in schema public to anon, authenticated, service_role;',
    'grant execute on all functions in schema public to anon, authenticated, service_role, public;',
  ].join('\n').replace(/create table if not exists public\.stripe_webhook_events/i, 'create table if not exists public.stripe_webhook_events'));
  assert.doesNotMatch(out, /ERROR/i, `fixture did not build:\n${out.slice(0, 1800)}`);

  const seed = raw(`
    insert into public.profiles (id, role) values ('${ADMIN}', 'admin'), ('${ALICE}', 'customer'), ('${EVE}', 'customer'), ('${OWNER}', 'customer');
    insert into public.local_businesses (id, owner_id) values ('${BIZ}', '${OWNER}');
    insert into public.events (id, title, starts_at, status, tickets_sold, capacity, organiser_business_id) values
      ('${EV}', 'Gig', now() + interval '10 days', 'published', 0, null, '${BIZ}'),
      ('${EV_OTHER}', 'Other gig', now() + interval '10 days', 'published', 0, 50, null);
    insert into public.event_ticket_types (id, event_id, name, price_pence, quantity_available, quantity_sold, is_active, per_order_max)
      values ('${TT_PAID}', '${EV}', 'Paid', 100, 100, 0, true, 10);`);
  assert.doesNotMatch(seed, /ERROR/i, `seed failed:\n${seed.slice(0, 800)}`);

  // CONTROL — the forgery, against the PRE-FIX state, must work. Rolled back.
  CONTROL_FORGED = touched('eve', FORGE_PAID);
  POLICIES_OUTSIDE_BEFORE = policiesOutside();
  GRANTS_OUTSIDE_BEFORE = grantsOutside();

  const fix = spawnSync(PSQL, [DSN, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', FIX], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(fix.status, 0, `migration failed:\n${fix.stderr}`);
});

describe('CONTROL — before the fix (the baseline’s own policy and grants)', () => {
  test('a signed-in user could insert a PAID order they wrote themselves: chosen id, total and payment id', () => {
    assert.equal(CONTROL_FORGED, 1);
  });
});

describe('1–5  a signed-in user cannot write payment state any more', () => {
  test('cannot insert a paid order', () => assert.ok(denied(tryAs('eve', FORGE_PAID)), tryAs('eve', FORGE_PAID)));
  test('cannot insert an order at all — not even a pending one for themselves', () => {
    const o = tryAs('eve', `insert into public.event_ticket_orders (event_id, buyer_id, status, total_pence) values ('${EV}', '${EVE}', 'pending', 0)`);
    assert.ok(denied(o), o);
  });
  test('cannot set a Stripe payment identifier on an insert', () => {
    const o = tryAs('eve', `insert into public.event_ticket_orders (event_id, buyer_id, total_pence, stripe_payment_intent_id) values ('${EV}', '${EVE}', 1, 'pi_x')`);
    assert.ok(denied(o), o);
  });
  test('cannot choose the order id, amount, refunded or paid timestamps on an insert', () => {
    for (const cols of [`id`, `total_pence`, `refunded_at`, `paid_at`, `platform_fee_pence`]) {
      const val = cols === 'id' ? `'${FORGED_ID}'` : cols.endsWith('_at') ? 'now()' : '5';
      const o = tryAs('eve', `insert into public.event_ticket_orders (event_id, buyer_id, ${cols}) values ('${EV}', '${EVE}', ${val})`);
      assert.ok(denied(o), `${cols}: ${o}`);
    }
  });
});

describe('3–5  nor can they change an order that exists (their own included)', () => {
  const order = () => reserve(ALICE);
  test('pending → paid is refused', () => {
    const id = order();
    const o = tryAs('alice', `update public.event_ticket_orders set status = 'paid', paid_at = now() where id = '${id}'`);
    assert.ok(denied(o), o);
    assert.equal(scalar(`select status from public.event_ticket_orders where id = '${id}'`), 'pending');
  });
  test('amount, fee and ticket count cannot be changed', () => {
    const id = order();
    for (const set of [`total_pence = 1`, `platform_fee_pence = 0`, `tickets_count = 9`]) {
      assert.ok(denied(tryAs('alice', `update public.event_ticket_orders set ${set} where id = '${id}'`)), set);
    }
    assert.equal(scalar(`select total_pence from public.event_ticket_orders where id = '${id}'`), '196');
  });
  test('payment identifier, refund and cancellation fields cannot be changed', () => {
    const id = order();
    for (const set of [`stripe_payment_intent_id = 'pi_mine'`, `status = 'refunded', refunded_at = now()`, `cancelled_at = now()`, `buyer_id = '${EVE}'`, `event_id = '${EV_OTHER}'`]) {
      assert.ok(denied(tryAs('alice', `update public.event_ticket_orders set ${set} where id = '${id}'`)), set);
    }
    assert.equal(scalar(`select coalesce(stripe_payment_intent_id,'none') from public.event_ticket_orders where id = '${id}'`), 'none');
  });
  test('an order cannot be deleted by its buyer, and TRUNCATE is refused', () => {
    const id = order();
    assert.ok(denied(tryAs('alice', `delete from public.event_ticket_orders where id = '${id}'`)));
    assert.ok(denied(tryAs('alice', 'truncate public.event_ticket_orders')));
    assert.equal(scalar(`select count(*) from public.event_ticket_orders where id = '${id}'`), '1');
  });
  test('the privileges themselves are gone', () => {
    for (const r of ['anon', 'authenticated']) for (const p of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
      assert.equal(scalar(`select has_table_privilege('${r}', 'public.event_ticket_orders', '${p}')`), 'f', `${r} still has ${p}`);
    }
  });
});

describe('belt and braces — even if privileges AND a policy were re-granted, the trigger refuses a client write', () => {
  const REOPEN = `grant insert, update, delete on public.event_ticket_orders to authenticated;
                  create policy reopened on public.event_ticket_orders for all to authenticated using (true) with check (true);`;
  const attempt = (sql: string) => raw(`begin; ${REOPEN} set local request.jwt.claim.sub='${EVE}'; set local role authenticated; ${sql}; rollback;`);
  test('insert, update and delete are all refused by the trigger itself', () => {
    const id = reserve(ALICE);
    for (const sql of [FORGE_PAID, `update public.event_ticket_orders set status='paid' where id='${id}'`, `delete from public.event_ticket_orders where id='${id}'`]) {
      const o = attempt(sql);
      assert.match(o, /ticket orders are created and settled by the server only/, o);
    }
  });
  test('the trigger exists and is enabled', () => {
    assert.equal(scalar(`select tgenabled from pg_trigger where tgrelid='public.event_ticket_orders'::regclass and tgname='tg_zz_event_ticket_orders_server_only'`), 'O');
  });
});

describe('6–7, 20  a genuine ticket purchase still works, end to end, as the server', () => {
  test('reserve_ticket_basket (service_role) creates a SAFE initial order: pending, unpaid, no payment id, nothing refunded', () => {
    const id = reserve(ALICE);
    const row = scalar(`select concat_ws('|', status, coalesce(paid_at::text,'-'), coalesce(stripe_payment_intent_id,'-'), coalesce(refunded_at::text,'-'), coalesce(cancelled_at::text,'-'), total_pence, platform_fee_pence, buyer_id) from public.event_ticket_orders where id='${id}'`);
    assert.equal(row, `pending|-|-|-|-|196|96|${ALICE}`);
  });
  test('the server then attaches the payment id and settles it (what create-event-ticket-intent / the webhook do)', () => {
    const id = reserve(ALICE);
    assert.equal(touched('service', `update public.event_ticket_orders set stripe_payment_intent_id = 'pi_real_1' where id='${id}'`), 1);
    assert.equal(touched('service', `update public.event_ticket_orders set status='paid', paid_at=now(), stripe_payment_intent_id='pi_real_1' where id='${id}' and status='pending'`), 1);
    doAs('service', `update public.event_ticket_orders set status='paid', paid_at=now(), stripe_payment_intent_id='pi_real_1' where id='${id}' and status='pending'`);
    assert.equal(scalar(`select status from public.event_ticket_orders where id='${id}'`), 'paid');
  });
  test('paid is settled EXACTLY once: the compare-and-swap lets a second delivery through nowhere', () => {
    const id = reserve(ALICE);
    const swap = `update public.event_ticket_orders set status='paid', paid_at=now() where id='${id}' and status='pending'`;
    assert.equal(touched('service', swap), 1);
    doAs('service', swap);
    assert.equal(touched('service', swap), 0, 'a second settle claimed the order again');
  });
  test('a payment id already on one order cannot be put on another (UNIQUE) — the order cannot reuse another order’s payment', () => {
    const a = reserve(ALICE); const b = reserve(ALICE);
    doAs('service', `update public.event_ticket_orders set stripe_payment_intent_id='pi_shared' where id='${a}'`);
    const o = tryAs('service', `update public.event_ticket_orders set stripe_payment_intent_id='pi_shared' where id='${b}'`);
    assert.match(o, /duplicate key|unique/i, o);
  });
  test('refund_event_tickets_for_payment (definer, called by the webhook and refund-payment) still refunds, and is idempotent', () => {
    const id = reserve(ALICE);
    doAs('service', `update public.event_ticket_orders set status='paid', paid_at=now(), stripe_payment_intent_id='pi_refundme' where id='${id}'`);
    doAs('service', `update public.event_tickets set status='valid' where order_id='${id}'`);
    const first = scalar(`begin; set local role service_role; select (public.refund_event_tickets_for_payment('pi_refundme', true))->>'action'; commit;`);
    assert.equal(first, 'refunded');
    assert.equal(scalar(`select status from public.event_ticket_orders where id='${id}'`), 'refunded');
    const second = scalar(`begin; set local role service_role; select (public.refund_event_tickets_for_payment('pi_refundme', true))->>'action'; commit;`);
    assert.equal(second, 'already_refunded');
  });
  test('release_ticket_order (definer) still releases an unpaid order', () => {
    const id = reserve(ALICE);
    const o = scalar(`begin; set local role service_role; select public.release_ticket_order('${id}')::text; commit;`);
    assert.equal(o, 'true');
  });
  test('duplicate Stripe webhook delivery: the event ledger lets exactly one delivery work', () => {
    const claim = (id: string) => scalar(`begin; set local role service_role; select public.claim_stripe_event('${id}', 'payment_intent.succeeded', 'pi_x'); commit;`);
    assert.equal(claim('evt_dup_1'), 'claimed');
    assert.equal(claim('evt_dup_1'), 'in_progress');
    doAs('service', `select public.mark_stripe_event_processed('evt_dup_1')`);
    assert.equal(claim('evt_dup_1'), 'already_processed');
  });
});

describe('who can still READ orders (the My Tickets and organiser screens)', () => {
  test('the buyer reads their own order and not another buyer’s', () => {
    const mine = reserve(ALICE);
    assert.equal(rowsOf(tryAs('alice', `select count(*) from public.event_ticket_orders where id='${mine}'`)).pop(), '1');
    assert.equal(rowsOf(tryAs('eve', `select count(*) from public.event_ticket_orders where id='${mine}'`)).pop(), '0');
  });
  test('the organiser (owner of the organising business) and an administrator read it; a stranger does not', () => {
    const id = reserve(ALICE);
    assert.equal(rowsOf(tryAs('owner', `select count(*) from public.event_ticket_orders where id='${id}'`)).pop(), '1');
    assert.equal(rowsOf(tryAs('admin', `select count(*) from public.event_ticket_orders where id='${id}'`)).pop(), '1');
    assert.equal(rowsOf(tryAs('eve', `select count(*) from public.event_ticket_orders where id='${id}'`)).pop(), '0');
  });
});

describe('21–23  RLS, anon, and nothing else moved', () => {
  test('RLS is still enabled', () => assert.equal(scalar(`select relrowsecurity from pg_class where oid='public.event_ticket_orders'::regclass`), 't'));
  test('only the read policy remains — no INSERT, UPDATE, DELETE or ALL policy', () => {
    assert.deepEqual(rowsOf(raw(`select policyname||':'||cmd from pg_policies where tablename='event_ticket_orders' order by 1`)), ['ticket_orders_buyer_read:SELECT']);
  });
  test('anon has no access of any kind (read included) and gains none', () => {
    for (const sql of ['select count(*) from public.event_ticket_orders', FORGE_PAID, `update public.event_ticket_orders set status='paid'`, 'delete from public.event_ticket_orders']) {
      assert.ok(denied(tryAs('anon', sql)), sql);
    }
    assert.equal(scalar(`select has_table_privilege('anon', 'public.event_ticket_orders', 'SELECT')`), 'f');
  });
  test('service_role keeps full access', () => {
    for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) assert.equal(scalar(`select has_table_privilege('service_role', 'public.event_ticket_orders', '${p}')`), 't');
    assert.equal(touched('service', FORGE_PAID.replace(FORGED_ID, 'f1f1f1f1-0000-4000-8000-0000000000f1').replace('pi_FORGED_TOPUP', 'pi_service_insert')), 1);
  });
  test('no policy or grant on any OTHER table changed', () => {
    assert.equal(policiesOutside(), POLICIES_OUTSIDE_BEFORE);
    assert.equal(grantsOutside(), GRANTS_OUTSIDE_BEFORE);
  });
  test('the migration touches only event_ticket_orders (and its own trigger function), and no rows', () => {
    const sql = src(FIX).split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    const tables = new Set([...sql.matchAll(/\b(?:on|from|table|into)\s+public\.([a-z_]+)/gi)].map((m) => m[1]));
    assert.deepEqual([...tables].sort(), ['event_ticket_orders']);
    assert.doesNotMatch(sql, /\b(insert\s+into|update\s+public|delete\s+from)\b/i);
  });
  test('the migration is idempotent and refuses to commit while a client write policy exists', () => {
    const again = spawnSync(PSQL, [DSN, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', FIX], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.equal(again.status, 0, again.stderr);
    raw('create policy reopened on public.event_ticket_orders for insert to authenticated with check (true);');
    const blocked = spawnSync(PSQL, [DSN, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', FIX], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /still has a client write policy/);
    raw('drop policy reopened on public.event_ticket_orders;');
  });
});
