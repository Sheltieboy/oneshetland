/**
 * product-import-foundation.node.test.ts
 *
 * Stage 0 of product import (migration 20261105000000), run against the REAL SQL, real RLS policies, the real
 * terms guard, the real tier guard and the real stock RPCs, as the roles PostgREST uses (authenticated / anon with
 * the JWT subject claim) and as service_role.
 *
 * WHAT IS PROVED
 *   A  a merchant's client write can no longer touch reserved, sold_at or import provenance (products AND variants),
 *      while ordinary manual product/variant editing, and the service-role reserve/commit/release path, still work
 *   B  field locks: a manual edit of an imported field locks exactly that field; a later import skips it and says so;
 *      unlocking releases it; native products never lock; a client cannot forge or clear a lock
 *   C  the import RPCs: drafts only, repeat imports cannot duplicate (ref unique), idempotent create / add / start,
 *      resumable chunks, one running import per business
 *   D  SKU and ref are scoped to one business: the same SKU in two businesses is fine, a duplicate in one is not,
 *      and an import row can never target another business's product
 *   E  variants: created flat with signed deltas, product-vs-variant stock conflict refused, a repeat import updates
 *      by SKU instead of duplicating, nothing is ever deleted, reserved stock is respected
 *   F  publishing: free plan can import drafts but not publish, Premium can, an expired plan cannot, a launch-style
 *      grant behaves exactly like a paid plan, terms are required even to import drafts, withdrawing is always allowed
 *   G  undo: a clean batch is removed; a published draft, an ordered product, held stock, an edited draft or an expired
 *      window blocks the WHOLE undo and changes nothing; an updated product reverts only fields still holding the
 *      imported value
 *   H  visibility: owners read their own batches/rows only; no client write path exists on any import table;
 *      credential_ref and webhook events are unreadable; anon cannot call any import function
 *   I  image hand-off: only files already stored in the owner's own business-media folder are accepted
 *
 * SAFETY — ISOLATED DATABASE ONLY. Requires PASS_PROOF_DSN and refuses a DSN mentioning Supabase.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIG = join(REPO_ROOT, 'supabase/migrations');
const BASELINE = join(MIG, '20260623000000_baseline_remote_schema.sql');
const COMMERCE = join(MIG, '20260801130000_commerce_engine.sql');
const STOCK = join(MIG, '20260801140000_product_stock_rpcs.sql');
const REFUNDFIX = join(MIG, '20261007120000_business_wallet_refunds.sql');
const MEETS = join(MIG, '20260916120000_business_meets_tier.sql');
const TERMS = join(MIG, '20260915120000_commercial_terms_enforcement.sql');
const TIER = join(MIG, '20260919120000_products_tier_entitlement.sql');
const IMPORT = join(MIG, '20261105000000_product_import_foundation.sql');

const DSN = process.env.PASS_PROOF_DSN ?? '';
const PSQL = process.env.PASS_PROOF_PSQL ?? 'psql';
const src = (p: string) => readFileSync(p, 'utf8');

if (!DSN) throw new Error('PASS_PROOF_DSN is required — run via `npm run test:isolated`');
if (/supabase/i.test(DSN)) throw new Error('Refusing to run against a DSN that mentions Supabase');

function raw(body: string): string {
  try {
    return execFileSync(PSQL, [DSN, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=0', '-c', body],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
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

const OWNER = '0a0a0a0a-0000-4000-8000-00000000000a';   // owns BIZ (Premium, accepted terms)
const OTHER = 'a0a0a0a0-0000-4000-8000-00000000000a';   // owns BIZ2 (free, accepted terms)
const NOTERMS = 'b0b0b0b0-0000-4000-8000-00000000000b'; // owns BIZ3 (Premium, has NOT accepted terms)
const BUYER = 'c0c0c0c0-0000-4000-8000-00000000000c';
const BIZ = 'd0d0d0d0-0000-4000-8000-00000000000d';
const BIZ2 = 'd1d1d1d1-0000-4000-8000-00000000000d';
const BIZ3 = 'd2d2d2d2-0000-4000-8000-00000000000d';
const SUPA = 'https://proj.supabase.co/storage/v1/object/public/business-media';

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
    'alter role service_role bypassrls;',
    // Supabase's default privileges: every NEW table and function in public is open to the API roles. The migration
    // has to take the import tables back, so reproduce the defaults it is applied under.
    'alter default privileges in schema public grant all on tables to anon, authenticated, service_role;',
    'alter default privileges in schema public grant all on functions to anon, authenticated, service_role;',
    'create table public.profiles (id uuid primary key, role text, is_platform_owner boolean default false);',
    createTable(BASELINE, 'CREATE TABLE public.local_businesses ('),
    'alter table public.local_businesses add primary key (id);',
    createTable(COMMERCE, 'create table if not exists public.products ('),
    createTable(COMMERCE, 'create table if not exists public.product_variants ('),
    createTable(COMMERCE, 'create table if not exists public.product_orders ('),
    createTable(COMMERCE, 'create table if not exists public.product_order_items ('),
    `create or replace function public.set_updated_at() returns trigger language plpgsql as $$
       begin new.updated_at = now(); return new; end; $$;`,
    `create trigger products_updated_at before update on public.products
       for each row execute function public.set_updated_at();`,
    // Production's owner policies, verbatim in effect.
    'alter table public.products enable row level security;',
    'alter table public.product_variants enable row level security;',
    slice(COMMERCE, 'create policy "owner manages products" on public.products', 'b.owner_id = auth.uid()));'),
    slice(COMMERCE, 'create policy "owner manages variants" on public.product_variants', 'b.owner_id = auth.uid()));'),
    // The real entitlement function and the real terms guard + tier guard.
    slice(MEETS, 'create or replace function public.business_meets_tier(', '$$;'),
    // Terms acceptance is a table lookup here; everything AROUND it is the real code.
    `create table public.test_terms (business_id uuid, user_id uuid);
     create or replace function public.has_accepted_commercial_terms(p_business_id uuid, p_user_id uuid default null)
       returns boolean language sql stable security definer set search_path = public as $$
         select exists (select 1 from public.test_terms where business_id = p_business_id and user_id = coalesce(p_user_id, auth.uid())) $$;`,
    slice(TERMS, 'create or replace function public.business_may_transact(', '$$;'),
    slice(TERMS, 'create or replace function public.commercial_terms_write_guard()', '$$;'),
    `create trigger commercial_terms_guard before insert or update on public.products
       for each row execute function public.commercial_terms_write_guard('business_id', 'is_active=false');`,
    `create trigger commercial_terms_guard before insert or update on public.product_variants
       for each row execute function public.commercial_terms_write_guard('product_id', 'is_active=false');`,
    slice(TIER, 'create or replace function public.products_tier_guard()', '$$;'),
    slice(TIER, 'create trigger products_tier_guard', 'products_tier_guard();'),
    slice(REFUNDFIX, 'create or replace function public.tg_is_server_write', '$$;'),
    slice(STOCK, 'create or replace function public.reserve_product_stock', 'revoke all on function public.commit_product_stock(uuid, uuid, int) from public, anon, authenticated;'),
    'grant usage on schema public, auth to anon, authenticated, service_role;',
    'grant execute on function auth.uid() to anon, authenticated, service_role;',
    'grant select, insert, update, delete on all tables in schema public to anon, authenticated, service_role;',
    src(IMPORT),
  ].join('\n'));
  assert.doesNotMatch(out, /ERROR/i, `schema failed:\n${out.slice(0, 2400)}`);
}

function fixtures() {
  const o = raw(`
    truncate public.import_rows, public.import_batches, public.product_order_items, public.product_orders, public.product_variants,
             public.products, public.test_terms, public.shop_connections, public.shop_webhook_events cascade;
    delete from public.local_businesses; delete from public.profiles; delete from auth.users;
    insert into auth.users(id) values ('${OWNER}'),('${OTHER}'),('${NOTERMS}'),('${BUYER}');
    insert into public.profiles(id) values ('${OWNER}'),('${OTHER}'),('${NOTERMS}'),('${BUYER}');
    insert into public.local_businesses (id, owner_id, name, category, address, subscription_tier, subscription_until) values
      ('${BIZ}','${OWNER}','Anderson & Co','retail','Lerwick','premium', now() + interval '30 days'),
      ('${BIZ2}','${OTHER}','Free Shop','retail','Scalloway','free', null),
      ('${BIZ3}','${NOTERMS}','No Terms Shop','retail','Brae','premium', now() + interval '30 days');
    insert into public.test_terms values ('${BIZ}','${OWNER}'),('${BIZ2}','${OTHER}');
  `);
  assert.doesNotMatch(o, /ERROR/i, `fixtures failed:\n${o.slice(0, 900)}`);
}

const asUser = (uid: string, sql: string) =>
  raw(`select set_config('request.jwt.claim.sub','${uid}',false); set role authenticated; ${sql} reset role;`);
const asAnon = (sql: string) => raw(`set role anon; ${sql} reset role;`);
const asServer = (sql: string) => raw(`set role service_role; ${sql} reset role;`);
const q = (s: string) => s.replace(/'/g, "''");
const json = (v: unknown) => `'${q(JSON.stringify(v))}'::jsonb`;
// First line of an asUser() result is set_config's echo of the subject; drop it so an empty result reads as empty.
const val = (uid: string, sql: string) => value(asUser(uid, sql).split('\n').slice(1).join('\n'));

// ── import helpers ──────────────────────────────────────────────────────────────────────────────────────────────────
type Item = {
  item_index: number; action: 'create' | 'update' | 'unchanged' | 'skip' | 'error';
  title?: string; ext_ref?: string; sku?: string; target_product_id?: string; row_numbers?: number[];
  payload?: Record<string, unknown>; errors?: unknown[]; warnings?: unknown[];
};
const fields = (o: Record<string, unknown>) => ({ title: 'Thing', price_pence: 1000, stock_mode: 'tracked', ...o });
let n = 0;
const key = () => `key-${Date.now()}-${++n}-abcdefgh`;

function createBatch(uid: string, biz: string, total: number, k = key()) {
  return val(uid, `select public.import_create_batch('${biz}','csv','oneshetland','f.csv','abc123','{}'::jsonb,'{}'::jsonb,${total},'${k}');`);
}
function runImport(uid: string, biz: string, items: Item[], opts: { chunk?: number } = {}) {
  const batch = createBatch(uid, biz, items.length);
  assert.match(batch, /^[0-9a-f-]{36}$/, `batch not created: ${batch}`);
  const add = asUser(uid, `select public.import_add_rows('${batch}', ${json(items)});`);
  assert.doesNotMatch(add, /ERROR/, add);
  const start = asUser(uid, `select public.import_start_batch('${batch}');`);
  assert.doesNotMatch(start, /ERROR/, start);
  for (let i = 0; i < 100; i++) {
    const r = JSON.parse(val(uid, `select public.import_apply_next('${batch}', ${opts.chunk ?? 25})::text;`));
    if (r.remaining === 0) break;
  }
  return batch;
}
const rowOf = (batch: string, idx: number) => JSON.parse(scalar(
  `select to_jsonb(r)::text from public.import_rows r where batch_id='${batch}' and item_index=${idx};`));
const pid = (biz: string, title: string) => scalar(`select id from public.products where business_id='${biz}' and title='${q(title)}';`);
const prod = (id: string) => JSON.parse(scalar(`select to_jsonb(p)::text from public.products p where id='${id}';`));
const batchStatus = (b: string) => scalar(`select status from public.import_batches where id='${b}';`);
const count = (sql: string) => Number(scalar(sql));

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('the migration itself', () => {
  before(() => { schema(); fixtures(); });

  test('applies a second time without error (idempotent)', () => {
    const out = raw(src(IMPORT));
    assert.doesNotMatch(out, /ERROR/i, out.slice(0, 1500));
  });

  test('existing native products are not disturbed: new columns are null/default', () => {
    fixtures();
    raw(`insert into public.products (business_id, title, price_pence, is_active) values ('${BIZ}','Native',500,true);`);
    const p = prod(pid(BIZ, 'Native'));
    assert.equal(p.external_source, null);
    assert.equal(p.external_ref, null);
    assert.equal(p.sku, null);
    assert.equal(p.sync_state, 'manual');
    assert.deepEqual(p.source_locked_fields, []);
  });
});

describe('A · system fields are not client-writable', () => {
  before(() => { schema(); fixtures(); });

  test('manual product create, edit, variant add / change / delete still work for the owner', () => {
    const c = asUser(OWNER, `insert into public.products (business_id, title, price_pence, stock_mode, stock, is_active)
                             values ('${BIZ}','Hand made',1500,'tracked',5,false) returning id;`);
    assert.doesNotMatch(c, /ERROR/, c);
    const id = pid(BIZ, 'Hand made');
    assert.doesNotMatch(asUser(OWNER, `update public.products set title='Hand made 2', price_pence=1600, description='x' where id='${id}';`), /ERROR/);
    assert.doesNotMatch(asUser(OWNER, `update public.products set stock=null where id='${id}';`), /ERROR/);
    const v = asUser(OWNER, `insert into public.product_variants (product_id, name, price_delta_pence, stock, is_active) values ('${id}','Large',200,3,true) returning id;`);
    assert.doesNotMatch(v, /ERROR/, v);
    assert.doesNotMatch(asUser(OWNER, `update public.product_variants set stock=4, price_delta_pence=250 where product_id='${id}';`), /ERROR/);
    assert.doesNotMatch(asUser(OWNER, `delete from public.product_variants where product_id='${id}';`), /ERROR/);
    assert.doesNotMatch(asUser(OWNER, `update public.products set is_active=true where id='${id}';`), /ERROR/, 'Premium owner can publish');
    assert.doesNotMatch(asUser(OWNER, `update public.products set is_active=false where id='${id}';`), /ERROR/, 'and withdraw');
  });

  test('a merchant cannot set reserved or sold_at on their own product', () => {
    const id = pid(BIZ, 'Hand made 2');
    for (const set of ['reserved = 5', `sold_at = now()`, 'reserved = reserved + 1']) {
      const o = asUser(OWNER, `update public.products set ${set} where id='${id}';`);
      assert.match(o, /maintained by the platform/, `${set} was allowed:\n${o}`);
    }
    assert.equal(prod(id).reserved, 0);
    assert.equal(prod(id).sold_at, null);
  });

  test('…nor on insert', () => {
    for (const cols of ['reserved', 'sold_at']) {
      const v = cols === 'reserved' ? '4' : 'now()';
      const o = asUser(OWNER, `insert into public.products (business_id, title, price_pence, ${cols}) values ('${BIZ}','Sneaky',500,${v});`);
      assert.match(o, /set by the platform/, o);
    }
    assert.equal(count(`select count(*) from public.products where title='Sneaky'`), 0);
  });

  test('every provenance column is server-only, on update and on insert', () => {
    const id = pid(BIZ, 'Hand made 2');
    for (const set of [`external_source = 'csv'`, `external_ref = 'x'`, `source_hash = 'h'`, `last_synced_at = now()`,
                       `sync_state = 'synced'`, `connection_id = gen_random_uuid()`]) {
      const o = asUser(OWNER, `update public.products set ${set} where id='${id}';`);
      assert.match(o, /maintained by the platform|violates/, `${set} was allowed:\n${o}`);
    }
    const o = asUser(OWNER, `insert into public.products (business_id, title, price_pence, external_source, external_ref) values ('${BIZ}','Forged',500,'csv','r1');`);
    assert.match(o, /set by the platform/, o);
  });

  test('a merchant cannot forge, widen or clear source_locked_fields', () => {
    const id = pid(BIZ, 'Hand made 2');
    assert.match(asUser(OWNER, `update public.products set source_locked_fields = array['title'] where id='${id}';`), /unlock action/);
  });

  test('variant reserved and external_ref are server-only', () => {
    const id = pid(BIZ, 'Hand made 2');
    assert.match(asUser(OWNER, `insert into public.product_variants (product_id, name, reserved) values ('${id}','V',2);`), /set by the platform/);
    assert.match(asUser(OWNER, `insert into public.product_variants (product_id, name, external_ref) values ('${id}','V','r');`), /set by the platform/);
    asUser(OWNER, `insert into public.product_variants (product_id, name) values ('${id}','Plain');`);
    assert.match(asUser(OWNER, `update public.product_variants set reserved = 9 where product_id='${id}';`), /set by the platform/);
    assert.match(asUser(OWNER, `update public.product_variants set external_ref = 'z' where product_id='${id}';`), /set by the platform/);
  });

  test('sending the unchanged value is harmless (a client that echoes a whole row keeps working)', () => {
    const id = pid(BIZ, 'Hand made 2');
    const o = asUser(OWNER, `update public.products set reserved = reserved, sold_at = sold_at, sync_state = sync_state, title = 'Hand made 2' where id='${id}';`);
    assert.doesNotMatch(o, /ERROR/, o);
  });

  test('checkout still works: the service-role reserve → commit → release path moves reserved and stock', () => {
    const id = pid(BIZ, 'Hand made 2');
    raw(`update public.products set stock_mode='tracked', stock=5, is_active=true where id='${id}';`);
    assert.equal(value(asServer(`select public.reserve_product_stock('${id}', null, 2);`)), 't');
    assert.equal(prod(id).reserved, 2);
    asServer(`select public.commit_product_stock('${id}', null, 2);`);
    assert.equal(prod(id).reserved, 0);
    assert.equal(prod(id).stock, 3);
    assert.equal(value(asServer(`select public.reserve_product_stock('${id}', null, 1);`)), 't');
    asServer(`select public.release_product_stock('${id}', null, 1);`);
    assert.equal(prod(id).reserved, 0);
  });

  test('the same path works with a variant, and a one-off sets sold_at without a client being able to', () => {
    const id = pid(BIZ, 'Hand made 2');
    raw(`update public.products set stock=null where id='${id}'; delete from public.product_variants where product_id='${id}';
         insert into public.product_variants (product_id, name, stock, is_active) values ('${id}','Big',5,true);`);
    const vid = scalar(`select id from public.product_variants where product_id='${id}';`);
    assert.equal(value(asServer(`select public.reserve_product_stock('${id}', '${vid}', 2);`)), 't');
    assert.equal(Number(scalar(`select reserved from public.product_variants where id='${vid}'`)), 2);
    asServer(`select public.release_product_stock('${id}', '${vid}', 2);`);
    assert.equal(Number(scalar(`select reserved from public.product_variants where id='${vid}'`)), 0);
  });

  test('the service role can still write reserved / sold_at directly (webhooks, reconciliation)', () => {
    const id = pid(BIZ, 'Hand made 2');
    assert.doesNotMatch(asServer(`update public.products set reserved = 1, sold_at = now() where id='${id}';`), /ERROR/);
    assert.equal(prod(id).reserved, 1);
  });

  test('another business owner cannot touch this product at all (RLS)', () => {
    const id = pid(BIZ, 'Hand made 2');
    asUser(OTHER, `update public.products set title='Stolen' where id='${id}';`);
    assert.notEqual(prod(id).title, 'Stolen');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('C · import RPCs: drafts, no duplicates, idempotent, resumable', () => {
  before(() => { schema(); fixtures(); });

  const three: Item[] = [
    { item_index: 0, row_numbers: [2], action: 'create', title: 'Fair Isle hat', ext_ref: 'HAT', sku: 'S-HAT', payload: { fields: fields({ title: 'Fair Isle hat', price_pence: 2500, sku: 'S-HAT' }), source_hash: 'h1' } },
    { item_index: 1, row_numbers: [3], action: 'create', title: 'Fair Isle scarf', ext_ref: 'SCARF', payload: { fields: fields({ title: 'Fair Isle scarf', price_pence: 3000 }) } },
    { item_index: 2, row_numbers: [4], action: 'create', title: 'Mug', ext_ref: 'MUG', payload: { fields: fields({ title: 'Mug', price_pence: 900, stock: 12, category: 'home', collect_only: true }) } },
  ];

  test('1 · a simple 3-product import creates three DRAFTS with provenance and no photos', () => {
    const b = runImport(OWNER, BIZ, three);
    assert.equal(batchStatus(b), 'complete');
    assert.equal(count(`select count(*) from public.products where business_id='${BIZ}' and external_source='csv'`), 3);
    for (const t of ['Fair Isle hat', 'Fair Isle scarf', 'Mug']) {
      const p = prod(pid(BIZ, t));
      assert.equal(p.is_active, false, `${t} must be a draft`);
      assert.equal(p.sync_state, 'imported');
      assert.deepEqual(p.photos, []);
      assert.equal(p.reserved, 0);
      assert.notEqual(p.last_synced_at, null);
    }
    const hat = prod(pid(BIZ, 'Fair Isle hat'));
    assert.equal(hat.external_ref, 'HAT');
    assert.equal(hat.sku, 'S-HAT');
    assert.equal(hat.source_hash, 'h1');
    assert.equal(prod(pid(BIZ, 'Mug')).collect_only, true);
    assert.equal(prod(pid(BIZ, 'Mug')).stock, 12);
  });

  test('15 · nothing an import writes is live, even if the payload says so', () => {
    fixtures();
    const b = runImport(OWNER, BIZ, [{ item_index: 0, action: 'create', title: 'Pushy', ext_ref: 'P', payload: { fields: { ...fields({ title: 'Pushy' }), is_active: true } } }]);
    assert.equal(prod(pid(BIZ, 'Pushy')).is_active, false);
    assert.equal(batchStatus(b), 'complete');
  });

  test('2 · repeating an import cannot create a duplicate: the ref is unique and the row fails cleanly', () => {
    fixtures();
    runImport(OWNER, BIZ, three);
    const b2 = runImport(OWNER, BIZ, three);
    assert.equal(count(`select count(*) from public.products where business_id='${BIZ}'`), 3, 'no duplicates');
    assert.equal(batchStatus(b2), 'complete_with_errors');
    assert.match(JSON.stringify(rowOf(b2, 0).errors), /already uses that ref/);
    assert.equal(rowOf(b2, 0).status, 'failed');
  });

  test('3 · an update changes the matched product, leaves the rest, and keeps it a draft', () => {
    fixtures();
    runImport(OWNER, BIZ, three);
    const hat = pid(BIZ, 'Fair Isle hat');
    const b = runImport(OWNER, BIZ, [{ item_index: 0, action: 'update', title: 'Fair Isle hat', ext_ref: 'HAT', target_product_id: hat,
      payload: { fields: { price_pence: 2800, description: 'Warm.' }, source_hash: 'h2' } }]);
    const p = prod(hat);
    assert.equal(p.price_pence, 2800);
    assert.equal(p.description, 'Warm.');
    assert.equal(p.title, 'Fair Isle hat');
    assert.equal(p.is_active, false);
    assert.equal(p.source_hash, 'h2');
    assert.deepEqual(rowOf(b, 0).result.changed_fields.sort(), ['description', 'price_pence']);
    assert.equal(count(`select count(*) from public.products where business_id='${BIZ}'`), 3);
  });

  test('a blank / absent field in an update never clears the product', () => {
    const hat = pid(BIZ, 'Fair Isle hat');
    runImport(OWNER, BIZ, [{ item_index: 0, action: 'update', ext_ref: 'HAT', target_product_id: hat, payload: { fields: { price_pence: 2900 } } }]);
    assert.equal(prod(hat).description, 'Warm.');
  });

  test('a restricted product row (action error) is stored for the report but writes nothing', () => {
    fixtures();
    const b = runImport(OWNER, BIZ, [
      { item_index: 0, action: 'error', title: 'Vape juice', row_numbers: [2], errors: [{ message: 'Not allowed' }] },
      { item_index: 1, action: 'create', title: 'Ok', ext_ref: 'OK', payload: { fields: fields({ title: 'Ok' }) } },
    ]);
    assert.equal(count(`select count(*) from public.products where business_id='${BIZ}'`), 1);
    assert.equal(rowOf(b, 0).status, 'skipped');
    assert.equal(batchStatus(b), 'complete');
  });

  test('create / add / start are idempotent; the same retry key returns the same batch', () => {
    fixtures();
    const k = key();
    const a = createBatch(OWNER, BIZ, 3, k);
    const b = createBatch(OWNER, BIZ, 3, k);
    assert.equal(a, b);
    asUser(OWNER, `select public.import_add_rows('${a}', ${json(three)});`);
    asUser(OWNER, `select public.import_add_rows('${a}', ${json(three)});`);
    assert.equal(count(`select count(*) from public.import_rows where batch_id='${a}'`), 3);
    asUser(OWNER, `select public.import_start_batch('${a}');`);
    assert.doesNotMatch(asUser(OWNER, `select public.import_start_batch('${a}');`), /ERROR/);
  });

  test('an incomplete plan cannot start', () => {
    fixtures();
    const a = createBatch(OWNER, BIZ, 3);
    asUser(OWNER, `select public.import_add_rows('${a}', ${json(three.slice(0, 2))});`);
    assert.match(asUser(OWNER, `select public.import_start_batch('${a}');`), /plan is incomplete/);
  });

  test('resumable: applying in chunks of one, interrupted and resumed, applies each product exactly once', () => {
    fixtures();
    const a = createBatch(OWNER, BIZ, 3);
    asUser(OWNER, `select public.import_add_rows('${a}', ${json(three)});`);
    asUser(OWNER, `select public.import_start_batch('${a}');`);
    const r1 = JSON.parse(val(OWNER, `select public.import_apply_next('${a}', 1)::text;`));
    assert.equal(r1.applied, 1); assert.equal(r1.remaining, 2);
    assert.equal(batchStatus(a), 'applying');
    // "the browser closed" — a later call simply continues.
    const r2 = JSON.parse(val(OWNER, `select public.import_apply_next('${a}', 25)::text;`));
    assert.equal(r2.applied, 2); assert.equal(r2.remaining, 0);
    assert.equal(batchStatus(a), 'complete');
    assert.equal(count(`select count(*) from public.products where business_id='${BIZ}'`), 3);
    assert.match(asUser(OWNER, `select public.import_apply_next('${a}', 25);`), /not running/);
  });

  test('only one import may run per business at a time, and the daily cap holds', () => {
    fixtures();
    const a = createBatch(OWNER, BIZ, 1);
    assert.match(asUser(OWNER, `select public.import_create_batch('${BIZ}','csv','x','f.csv','a','{}','{}',1,'${key()}');`), /still running/);
    asUser(OWNER, `select public.import_cancel_batch('${a}');`);
    raw(`update public.import_batches set status='complete' where business_id='${BIZ}';`);
    for (let i = 0; i < 19; i++) raw(`insert into public.import_batches (business_id, created_by, total_items, status) values ('${BIZ}','${OWNER}',1,'complete');`);
    assert.match(asUser(OWNER, `select public.import_create_batch('${BIZ}','csv','x','f.csv','a','{}','{}',1,'${key()}');`), /Too many imports today/);
  });

  test('a batch cannot hold more than 500 items, and a bad action is refused', () => {
    fixtures();
    assert.match(asUser(OWNER, `select public.import_create_batch('${BIZ}','csv','x','f.csv','a','{}','{}',501,'${key()}');`), /1 to 500/);
    const a = createBatch(OWNER, BIZ, 1);
    assert.match(asUser(OWNER, `select public.import_add_rows('${a}', ${json([{ item_index: 0, action: 'delete' }])});`), /Unknown action/);
    assert.match(asUser(OWNER, `select public.import_add_rows('${a}', ${json([{ item_index: 0, action: 'create', errors: [{ message: 'bad' }] }])});`), /errors cannot be imported/);
  });

  test('one bad row fails alone: the rest of the batch still imports', () => {
    fixtures();
    const b = runImport(OWNER, BIZ, [
      { item_index: 0, action: 'create', title: 'Cheap', ext_ref: 'C', payload: { fields: fields({ title: 'Cheap', price_pence: 10 }) } },
      { item_index: 1, action: 'create', title: 'Fine', ext_ref: 'F', payload: { fields: fields({ title: 'Fine' }) } },
    ]);
    assert.equal(rowOf(b, 0).status, 'failed');
    assert.match(JSON.stringify(rowOf(b, 0).errors), /at least £0\.50/);
    assert.equal(rowOf(b, 1).status, 'applied');
    assert.equal(count(`select count(*) from public.products where business_id='${BIZ}'`), 1);
    assert.equal(batchStatus(b), 'complete_with_errors');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('D · SKU and ref are scoped to one business', () => {
  before(() => { schema(); fixtures(); });

  test('4 · the same SKU and ref in two businesses never collide', () => {
    const item = (t: string): Item => ({ item_index: 0, action: 'create', title: t, ext_ref: 'R1', sku: 'ABC-1', payload: { fields: fields({ title: t, sku: 'ABC-1' }) } });
    runImport(OWNER, BIZ, [item('A')]);
    runImport(OTHER, BIZ2, [item('B')]);
    assert.equal(count(`select count(*) from public.products where sku='ABC-1'`), 2);
    assert.notEqual(pid(BIZ, 'A'), pid(BIZ2, 'B'));
  });

  test('a duplicate SKU inside one business is refused by the database', () => {
    const b = runImport(OWNER, BIZ, [{ item_index: 0, action: 'create', title: 'C', ext_ref: 'R2', sku: 'abc-1', payload: { fields: fields({ title: 'C', sku: 'abc-1' }) } }]);
    assert.match(JSON.stringify(rowOf(b, 0).errors), /already uses that SKU/);
    assert.equal(count(`select count(*) from public.products where business_id='${BIZ}'`), 1);
  });

  test('an update row can never target another business’s product', () => {
    const theirs = pid(BIZ2, 'B');
    const a = createBatch(OWNER, BIZ, 1);
    const o = asUser(OWNER, `select public.import_add_rows('${a}', ${json([{ item_index: 0, action: 'update', target_product_id: theirs, payload: { fields: { title: 'Hijack' } } }])});`);
    assert.match(o, /not in this business/);
    assert.equal(prod(theirs).title, 'B');
  });

  test('a merchant cannot import into somebody else’s business', () => {
    assert.match(asUser(OTHER, `select public.import_create_batch('${BIZ}','csv','x','f.csv','a','{}','{}',1,'${key()}');`), /business you own/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('E · variants on the existing flat model', () => {
  before(() => { schema(); fixtures(); });

  const withVariants = (extra: Record<string, unknown> = {}): Item => ({
    item_index: 0, row_numbers: [2, 3, 4], action: 'create', title: 'Jumper', ext_ref: 'JUMP',
    payload: {
      fields: fields({ title: 'Jumper', price_pence: 8500, stock_mode: 'tracked', ...extra }),
      variants: [
        { name: 'Small', price_delta_pence: 0, stock: 3, sku: 'J-S' },
        { name: 'Medium', price_delta_pence: 0, stock: 4, sku: 'J-M' },
        { name: 'Large', price_delta_pence: 500, stock: 2, sku: 'J-L' },
      ],
    },
  });

  test('6 + 7 · a product with 3 variants: deltas, per-variant stock and SKUs are stored, product stock stays null', () => {
    const b = runImport(OWNER, BIZ, [withVariants()]);
    assert.equal(batchStatus(b), 'complete');
    const id = pid(BIZ, 'Jumper');
    assert.equal(prod(id).stock, null);
    const vs = JSON.parse(scalar(`select jsonb_agg(to_jsonb(v) order by position)::text from public.product_variants v where product_id='${id}'`));
    assert.deepEqual(vs.map((v: any) => [v.name, v.price_delta_pence, v.stock, v.sku, v.external_ref, v.position, v.is_active]),
      [['Small', 0, 3, 'J-S', 'J-S', 0, true], ['Medium', 0, 4, 'J-M', 'J-M', 1, true], ['Large', 500, 2, 'J-L', 'J-L', 2, true]]);
  });

  test('product-level stock cannot be combined with variants', () => {
    fixtures();
    const b = runImport(OWNER, BIZ, [withVariants({ stock: 10 })]);
    assert.equal(rowOf(b, 0).status, 'failed');
    assert.match(JSON.stringify(rowOf(b, 0).errors), /stock on the variants/);
    assert.equal(count(`select count(*) from public.products`), 0, 'a failed row leaves nothing behind (no half-made product)');
  });

  test('a one-off cannot have variants; a variant cannot sell under £0.50', () => {
    fixtures();
    let b = runImport(OWNER, BIZ, [withVariants({ stock_mode: 'one_off' })]);
    assert.match(JSON.stringify(rowOf(b, 0).errors), /one-off item cannot have variants/);
    const bad = withVariants(); (bad.payload as any).variants[0].price_delta_pence = -8480;
    b = runImport(OWNER, BIZ, [bad]);
    assert.match(JSON.stringify(rowOf(b, 0).errors), /less than £0\.50/);
    assert.equal(count(`select count(*) from public.products`), 0);
  });

  test('a repeat import updates variants by SKU: no duplicates, never deletes the ones left out of the file', () => {
    fixtures();
    runImport(OWNER, BIZ, [withVariants()]);
    const id = pid(BIZ, 'Jumper');
    const b = runImport(OWNER, BIZ, [{ item_index: 0, action: 'update', ext_ref: 'JUMP', target_product_id: id, payload: {
      fields: { price_pence: 8500 },
      variants: [{ name: 'Small', price_delta_pence: 100, stock: 9, sku: 'J-S' }, { name: 'XL', price_delta_pence: 800, stock: 1, sku: 'J-XL' }],
    } }]);
    assert.equal(batchStatus(b), 'complete');
    const vs = JSON.parse(scalar(`select jsonb_agg(to_jsonb(v) order by position)::text from public.product_variants v where product_id='${id}'`));
    assert.equal(vs.length, 4, 'Small updated, Medium and Large kept, XL added');
    const small = vs.find((v: any) => v.sku === 'J-S');
    assert.equal(small.stock, 9); assert.equal(small.price_delta_pence, 100);
    assert.ok(vs.find((v: any) => v.sku === 'J-M') && vs.find((v: any) => v.sku === 'J-L'));
  });

  test('a variant matches by name when it has no SKU, case-insensitively', () => {
    const id = pid(BIZ, 'Jumper');
    runImport(OWNER, BIZ, [{ item_index: 0, action: 'update', target_product_id: id, payload: { variants: [{ name: 'medium', price_delta_pence: 0, stock: 40 }] } }]);
    assert.equal(count(`select count(*) from public.product_variants where product_id='${id}'`), 4);
    assert.equal(count(`select stock from public.product_variants where product_id='${id}' and sku='J-M'`), 40);
  });

  test('held stock is respected: a variant cannot be set below what open orders have reserved', () => {
    const id = pid(BIZ, 'Jumper');
    const vid = scalar(`select id from public.product_variants where product_id='${id}' and sku='J-S'`);
    raw(`update public.product_variants set reserved = 5 where id='${vid}'; update public.products set is_active = true where id='${id}';`);
    const b = runImport(OWNER, BIZ, [{ item_index: 0, action: 'update', target_product_id: id, payload: { variants: [{ name: 'Small', stock: 2, sku: 'J-S' }] } }]);
    assert.match(JSON.stringify(rowOf(b, 0).errors), /below the 5 held/);
    assert.equal(count(`select stock from public.product_variants where id='${vid}'`), 9);
  });

  test('a variant with an order or a reservation survives every import (nothing is ever deleted)', () => {
    const id = pid(BIZ, 'Jumper');
    const before = count(`select count(*) from public.product_variants where product_id='${id}'`);
    runImport(OWNER, BIZ, [{ item_index: 0, action: 'update', target_product_id: id, payload: { fields: { price_pence: 8600 }, variants: [{ name: 'Only one', price_delta_pence: 0, stock: 1 }] } }]);
    assert.equal(count(`select count(*) from public.product_variants where product_id='${id}'`), before + 1);
  });

  test('product stock cannot be set on an existing variant product, nor below reserved on a plain one', () => {
    fixtures();
    runImport(OWNER, BIZ, [withVariants(),
      { item_index: 1, action: 'create', title: 'Plain', ext_ref: 'PLAIN', payload: { fields: fields({ title: 'Plain', stock: 10 }) } }]);
    const jump = pid(BIZ, 'Jumper'), plain = pid(BIZ, 'Plain');
    let b = runImport(OWNER, BIZ, [{ item_index: 0, action: 'update', target_product_id: jump, payload: { fields: { stock: 5 } } }]);
    assert.match(JSON.stringify(rowOf(b, 0).errors), /stock is kept on the variants/);
    raw(`update public.products set reserved = 6 where id='${plain}';`);
    b = runImport(OWNER, BIZ, [{ item_index: 0, action: 'update', target_product_id: plain, payload: { fields: { stock: 4 } } }]);
    assert.match(JSON.stringify(rowOf(b, 0).errors), /below the 6 currently held/);
    assert.equal(prod(plain).stock, 10);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('B · field locks', () => {
  before(() => { schema(); fixtures(); });

  test('5 · a manual edit locks exactly the edited fields; re-sending unchanged values locks nothing', () => {
    runImport(OWNER, BIZ, [{ item_index: 0, action: 'create', title: 'Lock me', ext_ref: 'L1', payload: { fields: fields({ title: 'Lock me', price_pence: 1000, description: 'Orig' }) } }]);
    const id = pid(BIZ, 'Lock me');
    asUser(OWNER, `update public.products set title='Lock me', price_pence=1000, description='Orig' where id='${id}';`);
    assert.deepEqual(prod(id).source_locked_fields, []);
    asUser(OWNER, `update public.products set title='Lock me (mine)', price_pence=1000 where id='${id}';`);
    assert.deepEqual(prod(id).source_locked_fields, ['title']);
    asUser(OWNER, `update public.products set description='Mine', is_active=false where id='${id}';`);
    assert.deepEqual(prod(id).source_locked_fields.sort(), ['description', 'title']);
  });

  test('a later import skips locked fields, applies the rest, and reports what it kept', () => {
    const id = pid(BIZ, 'Lock me (mine)');
    const b = runImport(OWNER, BIZ, [{ item_index: 0, action: 'update', ext_ref: 'L1', target_product_id: id,
      payload: { fields: { title: 'Lock me', description: 'From file', price_pence: 1200 } } }]);
    const p = prod(id);
    assert.equal(p.title, 'Lock me (mine)');
    assert.equal(p.description, 'Mine');
    assert.equal(p.price_pence, 1200);
    assert.deepEqual(rowOf(b, 0).result.locked_skipped.sort(), ['description', 'title']);
    assert.deepEqual(rowOf(b, 0).result.changed_fields, ['price_pence']);
  });

  test('a client cannot clear or forge a lock directly — only the unlock action releases one', () => {
    const id = pid(BIZ, 'Lock me (mine)');
    assert.match(asUser(OWNER, `update public.products set source_locked_fields = '{}' where id='${id}';`), /unlock action/);
    assert.match(asUser(OWNER, `update public.products set source_locked_fields = array['title','price_pence'] where id='${id}';`), /unlock action/);
    assert.deepEqual(prod(id).source_locked_fields.sort(), ['description', 'title']);
  });

  test('unlocking a field lets the next import apply it; locks are owner-only', () => {
    const id = pid(BIZ, 'Lock me (mine)');
    assert.match(asUser(OTHER, `select public.product_unlock_fields('${id}', array['title']);`), /business you own/);
    assert.equal(val(OWNER, `select public.product_unlock_fields('${id}', array['title'])::text;`), '{description}');
    runImport(OWNER, BIZ, [{ item_index: 0, action: 'update', target_product_id: id, payload: { fields: { title: 'Lock me' } } }]);
    assert.equal(prod(id).title, 'Lock me');
    assert.equal(val(OWNER, `select public.product_unlock_fields('${id}')::text;`), '{}');
  });

  test('editing a variant of an imported product locks "variants"; the next import leaves its variants alone', () => {
    fixtures();
    runImport(OWNER, BIZ, [{ item_index: 0, action: 'create', title: 'V', ext_ref: 'V1', payload: { fields: fields({ title: 'V' }), variants: [{ name: 'A', price_delta_pence: 0, stock: 1, sku: 'VA' }] } }]);
    const id = pid(BIZ, 'V');
    asUser(OWNER, `update public.product_variants set stock = 7 where product_id='${id}';`);
    assert.deepEqual(prod(id).source_locked_fields, ['variants']);
    const b = runImport(OWNER, BIZ, [{ item_index: 0, action: 'update', target_product_id: id, payload: { variants: [{ name: 'A', price_delta_pence: 0, stock: 99, sku: 'VA' }] } }]);
    assert.equal(rowOf(b, 0).status, 'applied', JSON.stringify(rowOf(b, 0).errors));
    assert.equal(count(`select stock from public.product_variants where product_id='${id}'`), 7);
    assert.deepEqual(rowOf(b, 0).result.locked_skipped, ['variants']);
  });

  test('adding and deleting a variant by hand also lock, and a native product never accrues locks', () => {
    fixtures();
    runImport(OWNER, BIZ, [{ item_index: 0, action: 'create', title: 'V2', ext_ref: 'V2', payload: { fields: fields({ title: 'V2' }) } }]);
    const id = pid(BIZ, 'V2');
    asUser(OWNER, `insert into public.product_variants (product_id, name) values ('${id}','Hand');`);
    assert.deepEqual(prod(id).source_locked_fields, ['variants']);
    raw(`insert into public.products (business_id, title, price_pence) values ('${BIZ}','Native',700);`);
    const nid = pid(BIZ, 'Native');
    asUser(OWNER, `update public.products set title='Native 2', price_pence=800 where id='${nid}'; insert into public.product_variants (product_id, name) values ('${nid}','X');`);
    assert.deepEqual(prod(nid).source_locked_fields, []);
  });

  test('system-side writes (checkout stock movement) never lock anything', () => {
    fixtures();
    runImport(OWNER, BIZ, [{ item_index: 0, action: 'create', title: 'Sold', ext_ref: 'S', payload: { fields: fields({ title: 'Sold', stock: 5 }) } }]);
    const id = pid(BIZ, 'Sold');
    raw(`update public.products set is_active = true where id='${id}';`);
    asServer(`select public.reserve_product_stock('${id}', null, 2);`);
    asServer(`select public.commit_product_stock('${id}', null, 2);`);
    const p = prod(id);
    assert.equal(p.stock, 3);
    assert.deepEqual(p.source_locked_fields, [], 'a sale is not a manual edit');
  });

  test('an imported product cannot be moved to another business by a client', () => {
    fixtures();
    raw(`insert into public.local_businesses (id, owner_id, name, category, address) values ('${BIZ2}', '${OWNER}', 'Second', 'retail', 'x') on conflict (id) do update set owner_id='${OWNER}';
         insert into public.test_terms values ('${BIZ2}','${OWNER}');`);
    runImport(OWNER, BIZ, [{ item_index: 0, action: 'create', title: 'Mover', ext_ref: 'M', payload: { fields: fields({ title: 'Mover' }) } }]);
    const id = pid(BIZ, 'Mover');
    assert.match(asUser(OWNER, `update public.products set business_id='${BIZ2}' where id='${id}';`), /cannot be moved/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('F · publishing keeps every existing commercial check', () => {
  before(() => { schema(); fixtures(); });

  const one = (t: string, ref: string): Item => ({ item_index: 0, action: 'create', title: t, ext_ref: ref, payload: { fields: fields({ title: t }) } });

  test('17 · a free-plan merchant can import DRAFTS but cannot publish them', () => {
    const b = runImport(OTHER, BIZ2, [one('Free draft', 'F1')]);
    assert.equal(batchStatus(b), 'complete');
    const id = pid(BIZ2, 'Free draft');
    assert.equal(prod(id).is_active, false);
    const o = asUser(OTHER, `update public.products set is_active = true where id='${id}';`);
    assert.match(o, /Selling needs a Premium plan/);
    assert.equal(prod(id).is_active, false);
  });

  test('a Premium merchant can publish an imported draft with the same plain update the manual toggle uses', () => {
    runImport(OWNER, BIZ, [one('Prem draft', 'P1')]);
    const id = pid(BIZ, 'Prem draft');
    assert.doesNotMatch(asUser(OWNER, `update public.products set is_active = true where id='${id}';`), /ERROR/);
    assert.equal(prod(id).is_active, true);
  });

  test('18 · a launch-style grant (tier + future expiry, written like admin_grant_launch_plan) follows normal entitlement: publish works, then stops at expiry', () => {
    raw(`update public.local_businesses set subscription_tier='premium', subscription_until = now() + interval '60 days' where id='${BIZ2}';`);
    const id = pid(BIZ2, 'Free draft');
    assert.doesNotMatch(asUser(OTHER, `update public.products set is_active = true where id='${id}';`), /ERROR/);
    raw(`update public.local_businesses set subscription_until = now() - interval '1 day' where id='${BIZ2}';`);
    runImport(OTHER, BIZ2, [one('After expiry', 'F2')]);
    const id2 = pid(BIZ2, 'After expiry');
    assert.match(asUser(OTHER, `update public.products set is_active = true where id='${id2}';`), /Selling needs a Premium plan/);
    assert.equal(prod(id2).is_active, false);
  });

  test('a lapsed plan can still WITHDRAW a live product, and still import more drafts', () => {
    const id = pid(BIZ2, 'Free draft');
    assert.doesNotMatch(asUser(OTHER, `update public.products set is_active = false where id='${id}';`), /ERROR/);
    const b = runImport(OTHER, BIZ2, [one('Another draft', 'F3')]);
    assert.equal(batchStatus(b), 'complete');
  });

  test('the platform bypass is not available through the import: the owner session is what decides', () => {
    // An import cannot publish: even a Premium owner's batch leaves every row inactive.
    fixtures();
    runImport(OWNER, BIZ, [one('A1', 'A1'), one('A2', 'A2')].map((x, i) => ({ ...x, item_index: i })));
    assert.equal(count(`select count(*) from public.products where business_id='${BIZ}' and is_active`), 0);
  });

  test('terms are required even to import drafts: no batch is created for a business that has not accepted', () => {
    const o = asUser(NOTERMS, `select public.import_create_batch('${BIZ3}','csv','x','f.csv','a','{}','{}',1,'${key()}');`);
    assert.match(o, /Accept the business & selling terms/);
    assert.equal(count(`select count(*) from public.import_batches where business_id='${BIZ3}'`), 0);
  });

  test('terms revoked mid-import: every remaining row fails on the real guard, nothing is written, the batch reports it', () => {
    fixtures();
    const a = createBatch(OWNER, BIZ, 2);
    asUser(OWNER, `select public.import_add_rows('${a}', ${json([one('T1', 'T1'), { ...one('T2', 'T2'), item_index: 1 }])});`);
    asUser(OWNER, `select public.import_start_batch('${a}');`);
    raw(`delete from public.test_terms where business_id='${BIZ}';`);
    asUser(OWNER, `select public.import_apply_next('${a}', 25);`);
    assert.equal(count(`select count(*) from public.products`), 0);
    assert.equal(batchStatus(a), 'complete_with_errors');
    assert.match(JSON.stringify(rowOf(a, 0).errors), /terms/);
  });

  test('a lapsed owner editing a variant of an active imported product is not refused by lock bookkeeping', () => {
    fixtures();
    runImport(OWNER, BIZ, [{ item_index: 0, action: 'create', title: 'Live', ext_ref: 'LV', payload: { fields: fields({ title: 'Live' }), variants: [{ name: 'A', price_delta_pence: 0, stock: 1 }] } }]);
    const id = pid(BIZ, 'Live');
    raw(`update public.products set is_active = true where id='${id}'; update public.local_businesses set subscription_until = now() - interval '1 day' where id='${BIZ}';`);
    const o = asUser(OWNER, `update public.product_variants set stock = 5 where product_id='${id}';`);
    assert.doesNotMatch(o, /ERROR/, o);
    assert.deepEqual(prod(id).source_locked_fields, ['variants']);
    // …but changing the product itself is still a commercial change and is still refused.
    assert.match(asUser(OWNER, `update public.products set price_pence = 1234 where id='${id}';`), /Selling needs a Premium plan/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('G · undo', () => {
  before(() => { schema(); fixtures(); });

  const mk = (i: number, t: string, extra: Partial<Item> = {}): Item => ({ item_index: i, action: 'create', title: t, ext_ref: `U${i}`, payload: { fields: fields({ title: t }) }, ...extra });
  const undo = (b: string, uid = OWNER) => JSON.parse(val(uid, `select public.import_undo_batch('${b}')::text;`));

  test('19 · a clean import is undone completely: created drafts removed, batch and rows marked undone', () => {
    const b = runImport(OWNER, BIZ, [mk(0, 'U-one'), mk(1, 'U-two')]);
    assert.equal(count(`select count(*) from public.products where business_id='${BIZ}'`), 2);
    const r = undo(b);
    assert.equal(r.ok, true); assert.equal(r.deleted, 2);
    assert.equal(count(`select count(*) from public.products where business_id='${BIZ}'`), 0);
    assert.equal(batchStatus(b), 'undone');
    assert.equal(count(`select count(*) from public.import_rows where batch_id='${b}' and status='undone'`), 2);
    assert.equal(undo(b).already, true, 'undo is idempotent');
  });

  test('after undo the same file can be imported again (the unique ref is free)', () => {
    const b = runImport(OWNER, BIZ, [mk(0, 'U-one')]);
    assert.equal(batchStatus(b), 'complete');
    assert.equal(count(`select count(*) from public.products where business_id='${BIZ}'`), 1);
  });

  test('20 · undo is REFUSED, whole, when a product has an order — nothing is deleted', () => {
    fixtures();
    const b = runImport(OWNER, BIZ, [mk(0, 'O-one'), mk(1, 'O-two')]);
    const id = pid(BIZ, 'O-one');
    raw(`insert into public.product_orders (business_id, buyer_id, fulfilment, items_pence, total_pence) values ('${BIZ}','${BUYER}','collect',1000,1000);
         insert into public.product_order_items (order_id, product_id, title, unit_pence, qty)
           select id, '${id}', 'O-one', 1000, 1 from public.product_orders limit 1;`);
    const r = undo(b);
    assert.equal(r.ok, false);
    assert.equal(r.blockers.length, 1);
    assert.match(r.blockers[0].reason, /appears on an order/);
    assert.equal(r.blockers[0].title, 'O-one');
    assert.equal(count(`select count(*) from public.products where business_id='${BIZ}'`), 2, 'the clean product is also kept');
    assert.equal(batchStatus(b), 'complete');
  });

  test('refused when a product has been published, has held stock, or was edited since', () => {
    for (const [label, sql, re] of [
      ['published', (id: string) => `update public.products set is_active=true where id='${id}'`, /published/],
      ['held stock', (id: string) => `update public.products set reserved=1 where id='${id}'`, /held by an order/],
      ['edited', (id: string) => `update public.products set title='Mine' where id='${id}'`, /edited it since/],
    ] as const) {
      fixtures();
      const b = runImport(OWNER, BIZ, [mk(0, 'X-one')]);
      const id = pid(BIZ, 'X-one');
      if (label === 'edited') asUser(OWNER, `${sql(id)};`); else raw(`${sql(id)};`);
      const r = undo(b);
      assert.equal(r.ok, false, label);
      assert.match(r.blockers[0].reason, re, label);
      assert.equal(count(`select count(*) from public.products where business_id='${BIZ}'`), 1, `${label}: nothing deleted`);
    }
  });

  test('refused after the 7-day window, and for a batch that is still running', () => {
    fixtures();
    const b = runImport(OWNER, BIZ, [mk(0, 'W-one')]);
    raw(`update public.import_batches set undo_expires_at = now() - interval '1 minute' where id='${b}';`);
    assert.match(asUser(OWNER, `select public.import_undo_batch('${b}');`), /7-day undo window/);
    const a = createBatch(OWNER, BIZ, 1);
    assert.match(asUser(OWNER, `select public.import_undo_batch('${a}');`), /Only a finished import/);
  });

  test('an update is reverted field-by-field, but a field the merchant changed afterwards is kept', () => {
    fixtures();
    runImport(OWNER, BIZ, [{ ...mk(0, 'R-one'), payload: { fields: fields({ title: 'R-one', price_pence: 1000, description: 'before' }) } }]);
    const id = pid(BIZ, 'R-one');
    const b = runImport(OWNER, BIZ, [{ item_index: 0, action: 'update', ext_ref: 'U0', target_product_id: id, payload: { fields: { price_pence: 1500, description: 'after' } } }]);
    asUser(OWNER, `update public.products set description = 'merchant wrote this' where id='${id}';`);
    const r = undo(b);
    assert.equal(r.ok, true);
    assert.equal(r.reverted_fields, 1); assert.equal(r.kept_edited_fields, 1);
    assert.equal(prod(id).price_pence, 1000);
    assert.equal(prod(id).description, 'merchant wrote this');
  });

  test('undoing an update removes variants the import added but keeps one an order has touched', () => {
    fixtures();
    runImport(OWNER, BIZ, [{ ...mk(0, 'Var'), payload: { fields: fields({ title: 'Var' }), variants: [{ name: 'Base', stock: 1, sku: 'B' }] } }]);
    const id = pid(BIZ, 'Var');
    const b = runImport(OWNER, BIZ, [{ item_index: 0, action: 'update', target_product_id: id, payload: { variants: [{ name: 'New1', stock: 1, sku: 'N1' }, { name: 'New2', stock: 1, sku: 'N2' }] } }]);
    raw(`update public.product_variants set reserved = 1 where product_id='${id}' and sku='N2';`);
    const r = undo(b);
    assert.equal(r.ok, true);
    assert.equal(count(`select count(*) from public.product_variants where product_id='${id}' and sku='N1'`), 0);
    assert.equal(count(`select count(*) from public.product_variants where product_id='${id}' and sku='N2'`), 1, 'reserved stock is never deleted');
  });

  test('undo returns the hosted image paths so the server can remove them, and only its own', () => {
    fixtures();
    const b = runImport(OWNER, BIZ, [{ ...mk(0, 'Img'), payload: { fields: fields({ title: 'Img' }), image_urls: ['https://example.com/a.jpg'] } }]);
    const rowId = scalar(`select id from public.import_rows where batch_id='${b}'`);
    const claim = JSON.parse(val(OWNER, `select public.import_claim_image_row('${b}')::text;`));
    assert.equal(claim.row_id, rowId);
    assert.deepEqual(claim.urls, ['https://example.com/a.jpg']);
    const url = `${SUPA}/${BIZ}/products/${claim.product_id}/imp-abc.jpg`;
    asUser(OWNER, `select public.import_set_row_images('${rowId}', array['${url}'], ${json([{ url: 'https://example.com/a.jpg', ok: true }])});`);
    const r = undo(b);
    assert.equal(r.ok, true);
    assert.deepEqual(r.storage_paths, [`${BIZ}/products/${claim.product_id}/imp-abc.jpg`]);
  });

  test('another owner cannot undo or cancel this import', () => {
    fixtures();
    const b = runImport(OWNER, BIZ, [mk(0, 'Z')]);
    assert.match(asUser(OTHER, `select public.import_undo_batch('${b}');`), /business you own/);
    assert.equal(count(`select count(*) from public.products where business_id='${BIZ}'`), 1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('I · image hand-off', () => {
  before(() => { schema(); fixtures(); });

  const seed = () => {
    fixtures();
    const b = runImport(OWNER, BIZ, [{ item_index: 0, action: 'create', title: 'Pic', ext_ref: 'PIC', payload: { fields: fields({ title: 'Pic' }), image_urls: ['https://a.example/1.jpg', 'https://a.example/2.jpg'] } }]);
    const rowId = scalar(`select id from public.import_rows where batch_id='${b}'`);
    const claim = JSON.parse(val(OWNER, `select public.import_claim_image_row('${b}')::text;`));
    return { b, rowId, id: claim.product_id as string };
  };
  const ok = (u: string) => ({ url: u, ok: true });

  test('14 · re-hosted images are attached to the draft, the row and batch are closed, and the product stays a draft', () => {
    const { b, rowId, id } = seed();
    const u1 = `${SUPA}/${BIZ}/products/${id}/imp-1.jpg`, u2 = `${SUPA}/${BIZ}/products/${id}/imp-2.png`;
    const r = JSON.parse(val(OWNER, `select public.import_set_row_images('${rowId}', array['${u1}','${u2}'], ${json([ok('a'), ok('b')])})::text;`));
    assert.equal(r.status, 'done'); assert.equal(r.added, 2);
    assert.deepEqual(prod(id).photos, [u1, u2]);
    assert.equal(prod(id).is_active, false);
    assert.equal(batchStatus(b), 'complete');
    assert.equal(JSON.parse(val(OWNER, `select public.import_claim_image_row('${b}')::text;`) || 'null'), null);
  });

  test('a partial or total image failure is reported, never fatal: the batch finishes "with errors" and the product exists', () => {
    const { b, rowId, id } = seed();
    asUser(OWNER, `select public.import_set_row_images('${rowId}', array[]::text[], ${json([{ url: 'a', ok: false, error: 'not an image' }, { url: 'b', ok: false }])});`);
    assert.equal(scalar(`select image_status from public.import_rows where id='${rowId}'`), 'failed');
    assert.equal(batchStatus(b), 'complete_with_errors');
    assert.deepEqual(prod(id).photos, []);
    assert.equal(count(`select count(*) from public.products where id='${id}'`), 1);
  });

  test('only files in the owner’s OWN business-media folder are accepted — never an external URL or another business', () => {
    for (const bad of ['https://evil.example/x.jpg', `${SUPA}/${BIZ2}/products/x/imp.jpg`, `http://proj.supabase.co/storage/v1/object/public/business-media/${BIZ}/x.jpg`]) {
      const { rowId, id } = seed();
      assert.match(asUser(OWNER, `select public.import_set_row_images('${rowId}', array['${bad}'], '[]'::jsonb);`), /own business-media folder/, bad);
      assert.deepEqual(prod(id).photos, []);
    }
  });

  test('at most five photos in total, existing ones kept first; the same file twice is added once', () => {
    const { rowId, id } = seed();
    const urls = [1, 2, 3, 4, 5, 6].map((i) => `${SUPA}/${BIZ}/products/${id}/imp-${i}.jpg`);
    raw(`update public.products set photos = array['${SUPA}/${BIZ}/p/mine.jpg'] where id='${id}';`);
    asUser(OWNER, `select public.import_set_row_images('${rowId}', array[${[...urls, urls[0]].map((u) => `'${u}'`).join(',')}], ${json([ok('x')])});`);
    const p = prod(id);
    assert.equal(p.photos.length, 5);
    assert.equal(p.photos[0], `${SUPA}/${BIZ}/p/mine.jpg`);
  });

  test('photos the merchant has edited are locked: the import skips them', () => {
    const { b, rowId, id } = seed();
    raw(`update public.products set source_locked_fields = array['photos'] where id='${id}';`);
    const r = JSON.parse(val(OWNER, `select public.import_set_row_images('${rowId}', array['${SUPA}/${BIZ}/products/${id}/imp-1.jpg'], '[]'::jsonb)::text;`));
    assert.equal(r.added, 0);
    assert.deepEqual(prod(id).photos, []);
    assert.equal(batchStatus(b), 'complete');
  });

  test('an abandoned claim is picked up again after 90 seconds (resumable image phase)', () => {
    const { b, rowId } = seed();
    assert.equal(val(OWNER, `select public.import_claim_image_row('${b}')::text;`), '');   // still claimed
    assert.equal(val(OWNER, `select public.import_claim_image_row('${b}')::text;`), '', 'a claim made seconds ago is not stolen');
    raw(`update public.import_rows set image_claimed_at = now() - interval '2 minutes' where id='${rowId}';`);
    assert.equal(JSON.parse(val(OWNER, `select public.import_claim_image_row('${b}')::text;`)).row_id, rowId);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('H · visibility and write access to the import tables', () => {
  before(() => {
    schema(); fixtures();
    runImport(OWNER, BIZ, [{ item_index: 0, action: 'create', title: 'Vis', ext_ref: 'V', payload: { fields: fields({ title: 'Vis' }) } }]);
    raw(`insert into public.shop_connections (business_id, provider, external_account, credential_ref) values ('${BIZ}','shopify','x.myshopify.com','vault/secret-1');
         insert into public.shop_webhook_events (provider, event_id) values ('shopify','evt-1');`);
  });

  test('an owner reads their own batches and rows; another owner sees none; anon sees none', () => {
    assert.equal(Number(val(OWNER, `select count(*) from public.import_batches;`)), 1);
    assert.equal(Number(val(OWNER, `select count(*) from public.import_rows;`)), 1);
    assert.equal(Number(val(OTHER, `select count(*) from public.import_batches;`)), 0);
    assert.equal(Number(val(OTHER, `select count(*) from public.import_rows;`)), 0);
    assert.match(asAnon(`select count(*) from public.import_batches;`), /permission denied/);
    assert.match(asAnon(`select count(*) from public.import_rows;`), /permission denied/);
  });

  test('no client can insert, update or delete an import table directly — owner included', () => {
    for (const t of ['import_batches', 'import_rows', 'shop_connections', 'sync_runs', 'shop_webhook_events']) {
      for (const stmt of [`delete from public.${t}`, `update public.${t} set id = id`]) {
        assert.match(asUser(OWNER, `${stmt};`), /permission denied/, `${t}: ${stmt}`);
      }
    }
    assert.match(asUser(OWNER, `insert into public.import_batches (business_id, total_items) values ('${BIZ}', 1);`), /permission denied/);
    assert.match(asUser(OWNER, `insert into public.shop_connections (business_id, provider, external_account) values ('${BIZ}','shopify','y');`), /permission denied/);
    assert.match(asUser(OWNER, `insert into public.import_rows (batch_id, business_id, item_index, action) select id, business_id, 9, 'create' from public.import_batches;`), /permission denied/);
  });

  test('the owner can see their shop connection but never its credential reference; webhook events are server-only', () => {
    assert.equal(Number(val(OWNER, `select count(*) from public.shop_connections;`)), 1);
    assert.match(asUser(OWNER, `select credential_ref from public.shop_connections;`), /permission denied/);
    assert.match(asUser(OWNER, `select * from public.shop_connections;`), /permission denied/);
    assert.equal(Number(val(OTHER, `select count(*) from public.shop_connections;`)), 0);
    assert.match(asUser(OWNER, `select count(*) from public.shop_webhook_events;`), /permission denied/);
    assert.match(asAnon(`select count(*) from public.shop_connections;`), /permission denied/);
  });

  test('anon cannot execute any import function; a signed-in non-owner is refused by each', () => {
    const calls = [
      `select public.import_create_batch('${BIZ}','csv','x','f','a','{}','{}',1,'${key()}')`,
      `select public.import_add_rows(gen_random_uuid(), '[]')`,
      `select public.import_start_batch(gen_random_uuid())`,
      `select public.import_apply_next(gen_random_uuid())`,
      `select public.import_claim_image_row(gen_random_uuid())`,
      `select public.import_set_row_images(gen_random_uuid(), '{}', '[]')`,
      `select public.import_cancel_batch(gen_random_uuid())`,
      `select public.import_undo_batch(gen_random_uuid())`,
      `select public.product_unlock_fields(gen_random_uuid())`,
    ];
    for (const c of calls) assert.match(asAnon(`${c};`), /permission denied for function/, c);
    // internal helpers are not callable by clients either
    assert.match(asUser(OWNER, `select public._import_apply_item(null::public.import_rows);`), /permission denied for function/);
    assert.match(asUser(OWNER, `select public._import_assert_owner('${BIZ}');`), /permission denied for function/);
    // …the one helper a client trigger must reach is ownership-checked: it cannot lock someone else's product.
    const theirs = scalar(`select id from public.products where business_id='${BIZ}' limit 1;`);
    asUser(OTHER, `select public._product_lock_variants('${theirs}');`);
    assert.deepEqual(prod(theirs).source_locked_fields, []);
  });

  test('a stored import row of another business cannot be added to, started or applied by a non-owner', () => {
    const batch = scalar(`select id from public.import_batches limit 1;`);
    for (const c of [`import_add_rows('${batch}', '[]')`, `import_start_batch('${batch}')`, `import_apply_next('${batch}')`, `import_claim_image_row('${batch}')`, `import_cancel_batch('${batch}')`]) {
      assert.match(asUser(OTHER, `select public.${c};`), /business you own|not running|already started/, c);
    }
  });
});
