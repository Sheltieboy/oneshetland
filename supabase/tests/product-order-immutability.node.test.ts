/**
 * product-order-immutability.node.test.ts
 *
 * The 2 Oct 2026 live reconciliation found that a business owner could edit the
 * money columns of their own product orders straight through the API:
 * "business updates its orders" has no column restriction, authenticated holds
 * blanket table-level UPDATE (measured in production), and the only trigger
 * locked the refund columns. 20261028000100_product_order_financial_lock.sql
 * adds an ALLOWLIST trigger: a client role may change only the lifecycle
 * fields the apps write; everything else — including columns added later — is
 * locked.
 *
 * This suite runs the real migration SQL, under real RLS policies and the real
 * blanket grants, as the roles PostgREST would use (authenticated / anon, with
 * the JWT subject claim), and proves the merchant:
 *   · CAN accept, ready, post (with tracking), complete and cancel an order
 *   · CANNOT change ANY other column — checked for every column that exists,
 *     not a hand-picked list — alone or alongside a legitimate change
 *   · CAN'T touch an order that isn't theirs
 * and that server writes (service_role) and the refund-state rules still work.
 *
 * SAFETY — ISOLATED DATABASE ONLY
 * Requires PASS_PROOF_DSN and refuses a DSN mentioning Supabase. Run by
 * `npm run test:isolated`. No production row is read or written.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_ROOT = join(REPO_ROOT, '..', 'oneshetland-web');
const MIG = join(REPO_ROOT, 'supabase/migrations');
const BASELINE = join(MIG, '20260623000000_baseline_remote_schema.sql');
const COMMERCE = join(MIG, '20260801130000_commerce_engine.sql');
const REFUNDFIX = join(MIG, '20261007120000_business_wallet_refunds.sql');
const LOCK = join(MIG, '20261028000100_product_order_financial_lock.sql');

const DSN = process.env.PASS_PROOF_DSN ?? '';
const PSQL = process.env.PASS_PROOF_PSQL ?? 'psql';
const src = (p: string) => readFileSync(p, 'utf8');
const args = (b: string) => [DSN, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=0', '-c', b];

function raw(body: string): string {
  try {
    return execFileSync(PSQL, args(body), { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}
const TAG = /^(SET|RESET|BEGIN|COMMIT|ROLLBACK|DO|GRANT|REVOKE|COMMENT|CREATE .*|DROP .*|ALTER .*|INSERT \d+ \d+|UPDATE \d+|DELETE \d+)$/;
const value = (out: string) => out.split('\n').map((l) => l.trim()).filter((l) => l && !TAG.test(l)).pop() ?? '';
const scalar = (sql: string) => value(raw(sql));

function slice(file: string, opener: string, closer: string): string {
  const s = src(file);
  const start = s.indexOf(opener);
  assert.notEqual(start, -1, `${opener} is gone from ${file}`);
  const end = s.indexOf(closer, start);
  assert.notEqual(end, -1, `no end for ${opener}`);
  return s.slice(start, end + closer.length);
}
function createTable(file: string, opener: string): string {
  const s = src(file);
  const start = s.indexOf(opener);
  assert.notEqual(start, -1, `${opener} is gone`);
  const open = s.indexOf('(', start);
  let d = 0, end = -1;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') d++; else if (s[i] === ')') { d--; if (d === 0) { end = i; break; } }
  }
  return s.slice(start, end + 1) + ';';
}

const OWNER = '0a0a0a0a-0000-4000-8000-00000000000a';   // owns the business
const BUYER = 'c0c0c0c0-0000-4000-8000-00000000000c';
const OTHER = 'a0a0a0a0-0000-4000-8000-00000000000a';   // another business owner
const BIZ = 'd0d0d0d0-0000-4000-8000-00000000000d';
const BIZ2 = 'd1d1d1d1-0000-4000-8000-00000000000d';
const ORDER = '55550000-0000-4000-8000-000000000055';
const ORDER2 = '55550000-0000-4000-8000-000000000056';

/** Production's own columns that later migrations added to the engine's table. */
const LATER_COLUMNS = [
  'paid_via text', 'fetch_nudged_at timestamptz', 'delivery_region_slug text', 'delivery_request_id uuid',
  'tracking_ref text', 'accepted_at timestamptz', 'ready_at timestamptz', 'posted_at timestamptz',
  'completed_at timestamptz', 'cancelled_at timestamptz', 'paid_at timestamptz', 'expires_at timestamptz',
  'delivery_name text', 'delivery_address text', 'delivery_postcode text', 'contact_phone text', 'buyer_note text',
];

function schema() {
  const out = raw([
    'drop schema if exists public cascade; create schema public;',
    'drop schema if exists auth cascade; create schema auth;',
    'create table auth.users (id uuid primary key);',
    `create or replace function auth.uid() returns uuid language sql stable as $$
       select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;`,
    `do $$ begin
       if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
       if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
       if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
     end $$;`,
    // Supabase's service_role bypasses RLS; reproduce that so server writes are tested as they run.
    'alter role service_role bypassrls;',
    'create table public.profiles (id uuid primary key, role text, is_platform_owner boolean default false);',
    createTable(BASELINE, 'CREATE TABLE public.local_businesses ('),
    'alter table public.local_businesses add primary key (id);',
    createTable(BASELINE, 'CREATE TABLE public.local_wallet_transactions ('),
    'alter table public.local_wallet_transactions add primary key (id);',
    createTable(COMMERCE, 'create table if not exists public.products ('),
    createTable(COMMERCE, 'create table if not exists public.product_orders ('),
    ...LATER_COLUMNS.map((c) => `alter table public.product_orders add column if not exists ${c};`),
    `alter table public.product_orders drop constraint if exists product_orders_status_check;
     alter table public.product_orders add constraint product_orders_status_check
       check (status = any (array['pending','paid','accepted','ready','handed_over','posted','completed','cancelled','refunded','expired']));`,
    // The real refund-state lock this change sits alongside.
    slice(REFUNDFIX, 'alter table public.product_orders\n  add column if not exists refund_state', ';'),
    slice(REFUNDFIX, 'create or replace function public.tg_is_server_write', '$$;'),
    slice(REFUNDFIX, 'create or replace function public.tg_lock_order_refund_columns', '$$;'),
    slice(REFUNDFIX, 'drop trigger if exists tg_zz_lock_order_refund_columns', 'tg_lock_order_refund_columns();'),
    `create or replace function public.set_updated_at() returns trigger language plpgsql as $$
       begin new.updated_at = now(); return new; end; $$;`,
    `create trigger product_orders_updated_at before update on public.product_orders
       for each row execute function public.set_updated_at();`,
    // Production's RLS exactly: the owning business reads and updates its orders; the buyer reads own.
    'alter table public.product_orders enable row level security;',
    `create policy "business reads its orders" on public.product_orders for select
       using (exists (select 1 from public.local_businesses b where b.id = product_orders.business_id and b.owner_id = auth.uid()));`,
    `create policy "buyer reads own orders" on public.product_orders for select using (buyer_id = auth.uid());`,
    `create policy "business updates its orders" on public.product_orders for update
       using (exists (select 1 from public.local_businesses b where b.id = product_orders.business_id and b.owner_id = auth.uid()));`,
    // Production grants authenticated blanket table-level UPDATE — measured — so
    // the trigger, not a missing privilege, must be what refuses a merchant.
    'grant usage on schema public, auth to anon, authenticated, service_role;',
    'grant execute on function auth.uid() to anon, authenticated, service_role;',
    'grant select, insert, update, delete on all tables in schema public to anon, authenticated, service_role;',
    // The migration under test, verbatim.
    src(LOCK),
  ].join('\n'));
  assert.doesNotMatch(out, /ERROR/i, `schema failed:\n${out.slice(0, 1600)}`);
}

function fixtures() {
  const o = raw(`
    delete from public.product_orders; delete from public.local_businesses; delete from public.profiles; delete from auth.users;
    insert into auth.users(id) values ('${OWNER}'),('${BUYER}'),('${OTHER}');
    insert into public.profiles(id) values ('${OWNER}'),('${BUYER}'),('${OTHER}');
    insert into public.local_businesses (id, owner_id, name, category, address) values
      ('${BIZ}','${OWNER}','Anderson & Co','retail','Lerwick'),
      ('${BIZ2}','${OTHER}','Other Shop','retail','Scalloway');
    insert into public.product_orders
      (id, business_id, buyer_id, status, fulfilment, items_pence, shipping_pence, total_pence, commission_pence, paid_via,
       payment_intent_id, paid_at, delivery_name, delivery_address, delivery_postcode, contact_phone, buyer_note, expires_at)
    values
      ('${ORDER}','${BIZ}','${BUYER}','paid','collect',200,0,200,10,'card','pi_real_one', now(),'Sam','1 High St','ZE1 0AA','07000','note', now() + interval '1 day'),
      ('${ORDER2}','${BIZ2}','${BUYER}','paid','collect',500,0,500,25,'card','pi_real_two', now(),'Sam','1 High St','ZE1 0AA','07000','note', now() + interval '1 day');
  `);
  assert.doesNotMatch(o, /ERROR/i, `fixtures failed:\n${o.slice(0, 900)}`);
}

/** Exactly what PostgREST does: a role plus the JWT subject claim. */
const asUser = (uid: string, sql: string) =>
  raw(`select set_config('request.jwt.claim.sub','${uid}',false); set role authenticated; ${sql} reset role;`);
const asAnon = (sql: string) => raw(`set role anon; ${sql} reset role;`);
const asServer = (sql: string) => raw(`set role service_role; ${sql} reset role;`);
const snapshot = (id = ORDER) => scalar(`select to_jsonb(o)::text from public.product_orders o where id='${id}';`);
const field = (col: string, id = ORDER) => scalar(`select ${col}::text from public.product_orders where id='${id}';`);

const LIFECYCLE = ['status', 'tracking_ref', 'accepted_at', 'ready_at', 'posted_at', 'completed_at', 'cancelled_at', 'updated_at'];

describe('a merchant can still run an order through its lifecycle', () => {
  before(() => { schema(); fixtures(); });

  test('accept → ready → posted (with tracking) → completed, each persisted', () => {
    for (const [status, extra] of [
      ['accepted', `accepted_at='${new Date().toISOString()}'`],
      ['ready', `ready_at='${new Date().toISOString()}'`],
      ['posted', `posted_at='${new Date().toISOString()}', tracking_ref='RM123456789GB'`],
      ['completed', `completed_at='${new Date().toISOString()}'`],
    ] as const) {
      const o = asUser(OWNER, `update public.product_orders set status='${status}', ${extra} where id='${ORDER}' returning id;`);
      assert.doesNotMatch(o, /ERROR/, `${status} was refused:\n${o}`);
      assert.match(o, new RegExp(ORDER), `${status} affected no row`);
      assert.equal(field('status'), status);
    }
    assert.equal(field('tracking_ref'), 'RM123456789GB');
    assert.notEqual(field('completed_at'), '');
  });

  test('an order can be cancelled with its cancellation time', () => {
    fixtures();
    const o = asUser(OWNER, `update public.product_orders set status='cancelled', cancelled_at=now() where id='${ORDER}' returning id;`);
    assert.doesNotMatch(o, /ERROR/, o);
    assert.equal(field('status'), 'cancelled');
  });

  test('re-sending an unchanged money value is harmless (a client that echoes the whole row still works)', () => {
    fixtures();
    const o = asUser(OWNER, `update public.product_orders set status='accepted', total_pence=total_pence, commission_pence=commission_pence where id='${ORDER}' returning id;`);
    assert.doesNotMatch(o, /ERROR/, o);
    assert.equal(field('status'), 'accepted');
  });
});

describe('a merchant cannot change ANY other column of their own order — every column, alone', () => {
  before(() => { schema(); fixtures(); });

  const cols = (): { name: string; type: string }[] =>
    raw(`select column_name || '|' || data_type from information_schema.columns
          where table_schema='public' and table_name='product_orders' order by ordinal_position;`)
      .split('\n').map((l) => l.trim()).filter((l) => l.includes('|'))
      .map((l) => { const [name, type] = l.split('|'); return { name, type }; });

  /** An expression that is guaranteed to DIFFER from the current value, per type. */
  const changed = (c: { name: string; type: string }): string => {
    switch (c.type) {
      case 'uuid': return 'gen_random_uuid()';
      case 'integer': case 'bigint': case 'smallint': case 'numeric': return `coalesce(${c.name}, 0) + 7`;
      case 'boolean': return `not coalesce(${c.name}, false)`;
      case 'jsonb': return `'{"tampered":true}'::jsonb`;
      case 'date': return `coalesce(${c.name}, current_date) + 3`;
      case 'timestamp with time zone': case 'timestamp without time zone': return `coalesce(${c.name}, now()) + interval '3 days'`;
      default: return `coalesce(${c.name}, '') || '-tampered'`;
    }
  };

  test('the real table has the money, payment, ownership and refund columns we expect to be locked', () => {
    const names = cols().map((c) => c.name);
    for (const must of ['total_pence', 'items_pence', 'shipping_pence', 'commission_pence', 'payment_intent_id', 'paid_via',
      'paid_at', 'buyer_id', 'business_id', 'refund_state', 'refunded_at', 'refund_transaction_id']) {
      assert.ok(names.includes(must), `${must} missing from the test table`);
    }
  });

  test('every non-lifecycle column is refused when a merchant changes it, and the order is left exactly as it was', () => {
    const locked = cols().filter((c) => !LIFECYCLE.includes(c.name));
    assert.ok(locked.length >= 20, `expected the full column set, got ${locked.length}`);
    const before = snapshot();
    for (const c of locked) {
      const o = asUser(OWNER, `update public.product_orders set ${c.name} = ${changed(c)} where id='${ORDER}';`);
      assert.match(o, /server-managed/, `a merchant changed ${c.name} (${c.type}):\n${o.slice(0, 300)}`);
      assert.equal(snapshot(), before, `${c.name} was altered despite the refusal`);
    }
  });

  test('a legitimate change cannot smuggle a locked one through in the same statement', () => {
    const before = snapshot();
    for (const col of ['total_pence = 1', 'commission_pence = 0', `payment_intent_id = 'pi_other'`, `buyer_id = '${OTHER}'`, `business_id = '${BIZ2}'`]) {
      const o = asUser(OWNER, `update public.product_orders set status='accepted', accepted_at=now(), ${col} where id='${ORDER}';`);
      assert.match(o, /server-managed/, `${col} slipped through:\n${o.slice(0, 300)}`);
    }
    assert.equal(snapshot(), before, 'status changed even though the statement was refused');
  });

  test('the headline cases, spelled out: total, commission, payment reference, buyer, business', () => {
    const before = snapshot();
    for (const sql of [
      `update public.product_orders set total_pence = 1 where id='${ORDER}';`,
      `update public.product_orders set commission_pence = 0 where id='${ORDER}';`,
      `update public.product_orders set payment_intent_id = 'pi_forged' where id='${ORDER}';`,
      `update public.product_orders set buyer_id = '${OWNER}' where id='${ORDER}';`,
      `update public.product_orders set business_id = '${BIZ2}' where id='${ORDER}';`,
      `update public.product_orders set refund_state = 'refunded' where id='${ORDER}';`,
    ]) assert.match(asUser(OWNER, sql), /server-managed/, sql);
    assert.equal(snapshot(), before);
  });
});

describe('nobody else can touch the order from a client role', () => {
  before(() => { schema(); fixtures(); });

  test('another merchant updating this order changes nothing (RLS hides it)', () => {
    const before = snapshot();
    const o = asUser(OTHER, `update public.product_orders set status='cancelled' where id='${ORDER}' returning id;`);
    assert.doesNotMatch(o, new RegExp(ORDER));
    assert.equal(snapshot(), before);
  });

  test('the buyer cannot update the order', () => {
    const before = snapshot();
    asUser(BUYER, `update public.product_orders set status='completed', total_pence = 1 where id='${ORDER}';`);
    assert.equal(snapshot(), before);
  });

  test('anon cannot update the order', () => {
    const before = snapshot();
    asAnon(`update public.product_orders set total_pence = 1 where id='${ORDER}';`);
    assert.equal(snapshot(), before);
  });

  test('a merchant cannot reach another business\'s order either', () => {
    const before = snapshot(ORDER2);
    asUser(OWNER, `update public.product_orders set total_pence = 1 where id='${ORDER2}';`);
    assert.equal(snapshot(ORDER2), before);
  });
});

describe('server-side writes and the refund rules are unaffected', () => {
  before(() => { schema(); fixtures(); });

  test('service_role (the edge functions) can still write money and payment fields', () => {
    const o = asServer(`update public.product_orders set total_pence = 250, commission_pence = 13, payment_intent_id = 'pi_corrected' where id='${ORDER}' returning id;`);
    assert.doesNotMatch(o, /ERROR/, o);
    assert.equal(field('total_pence'), '250');
    assert.equal(field('payment_intent_id'), 'pi_corrected');
  });

  test('the migration/superuser path (the session user that applies migrations) can still write', () => {
    const o = raw(`update public.product_orders set commission_pence = 14 where id='${ORDER}' returning id;`);
    assert.doesNotMatch(o, /ERROR/, o);
    assert.equal(field('commission_pence'), '14');
  });

  test('a SECURITY DEFINER function (how the real refund RPCs work) called BY a merchant can still write refund and money fields', () => {
    fixtures();
    raw(`create or replace function public._test_definer_write(p_id uuid) returns void language plpgsql security definer set search_path = public as $$
           begin update public.product_orders set refund_state = 'pending', commission_pence = commission_pence where id = p_id; end; $$;
         grant execute on function public._test_definer_write(uuid) to authenticated;`);
    const o = asUser(OWNER, `select public._test_definer_write('${ORDER}');`);
    assert.doesNotMatch(o, /ERROR/, o);
    assert.equal(field('refund_state'), 'pending');
    // ...while the same merchant writing the column directly is still refused.
    assert.match(asUser(OWNER, `update public.product_orders set refund_state = 'none' where id='${ORDER}';`), /server-managed/);
    assert.equal(field('refund_state'), 'pending');
  });

  test('refund-state rules still apply on top: no status change while a refund is pending or after it completed', () => {
    fixtures();
    asServer(`update public.product_orders set refund_state='pending' where id='${ORDER}';`);
    assert.match(asUser(OWNER, `update public.product_orders set status='completed' where id='${ORDER}';`), /order_refund_in_progress/);
    asServer(`update public.product_orders set refund_state='refunded' where id='${ORDER}';`);
    assert.match(asUser(OWNER, `update public.product_orders set status='completed' where id='${ORDER}';`), /order_refunded/);
  });
});

/* ── The allowlist is exactly what the apps write — no more, no less ──────── */

describe('the allowlist matches what the real clients send', () => {
  const sqlSrc = src(LOCK);
  const allow = (sqlSrc.match(/lifecycle text\[\] := array\[([\s\S]*?)\];/)?.[1] ?? '')
    .match(/'([a-z_]+)'/g)?.map((s) => s.replace(/'/g, '')) ?? [];

  test('the migration\'s allowlist is the lifecycle set and nothing monetary', () => {
    assert.deepEqual([...allow].sort(), [...LIFECYCLE].sort());
    for (const forbidden of ['total_pence', 'items_pence', 'shipping_pence', 'commission_pence', 'payment_intent_id', 'paid_via',
      'paid_at', 'buyer_id', 'business_id', 'refund_state', 'refunded_at', 'refund_transaction_id', 'id', 'created_at']) {
      assert.ok(!allow.includes(forbidden), `${forbidden} must not be client-writable`);
    }
  });

  test('every key the mobile app writes to product_orders is allowed', () => {
    const api = src(join(REPO_ROOT, 'lib/products-api.ts'));
    const fn = api.slice(api.indexOf('export async function updateOrderStatus'), api.indexOf('export async function updateOrderStatus') + 900);
    const keys = new Set([...fn.matchAll(/patch\.([a-z_]+)\s*=/g)].map((m) => m[1]).concat(fn.includes('{ status: to }') ? ['status'] : []));
    assert.ok(keys.size >= 5, `parsed too few keys: ${[...keys]}`);
    for (const k of keys) assert.ok(allow.includes(k), `mobile writes ${k}, which the lock would refuse`);
  });

  test('every key the web orders inbox writes to product_orders is allowed', () => {
    const inbox = readFileSync(join(WEB_ROOT, 'components/business/OrdersInbox.tsx'), 'utf8');
    const start = inbox.indexOf('const patch: Record<string, unknown>');
    const block = inbox.slice(start, start + 900);
    const keys = new Set([...block.matchAll(/patch\.([a-z_]+)\s*=/g)].map((m) => m[1]).concat(block.includes('{ status: to }') ? ['status'] : []));
    assert.ok(keys.size >= 5, `parsed too few keys: ${[...keys]}`);
    for (const k of keys) assert.ok(allow.includes(k), `web writes ${k}, which the lock would refuse`);
  });

  test('server writes are exempt via tg_is_server_write, and only UPDATE is guarded', () => {
    assert.match(sqlSrc, /if public\.tg_is_server_write\(\) then return new; end if;/);
    assert.match(sqlSrc, /if tg_op <> 'UPDATE' then return new; end if;/);
    assert.match(sqlSrc, /\(to_jsonb\(new\) - lifecycle\) is distinct from \(to_jsonb\(old\) - lifecycle\)/);
  });
});
