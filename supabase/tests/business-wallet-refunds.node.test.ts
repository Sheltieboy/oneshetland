/**
 * business-wallet-refunds.node.test.ts — giving a business Wallet payment back.
 *
 * Four rails take money from a customer's wallet for a LOCAL BUSINESS, and none
 * of them could be refunded. refund-payment is the only other caller of
 * wallet_reverse_debit and it resolves hub memberships, whose wallet rows carry
 * business_id = NULL — the exact thing loyalty_award_for_wallet_spend refuses as
 * 'not_a_business_spend'. So the refundable set and the business set were
 * disjoint by construction, and the platform took money it could not return.
 *
 * What this proves, in order of how badly it would hurt to get wrong:
 *
 *   · a first pass use and a refund claim cannot both win — they serialise on
 *     the purchase row, and whichever takes the lock first decides
 *   · a merchant cannot write refund state, or a pass's use balance, directly
 *   · nothing ever says "refunded" unless the money actually went back: every
 *     failure lands on pending, and pending is retryable
 *   · a rollback inside finalisation takes the wallet credit and the Loyalty
 *     reversal down with it, rather than leaving a half-refund
 *   · stock comes back exactly once, and `reserved` is never touched
 *
 * SAFETY — ISOLATED DATABASE ONLY
 * Requires PASS_PROOF_DSN and refuses a DSN mentioning Supabase. Run by
 * `npm run test:isolated`. No production row is read or written.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIG = join(REPO_ROOT, 'supabase/migrations');
const FN = join(REPO_ROOT, 'supabase/functions');

const BASELINE = join(MIG, '20260623000000_baseline_remote_schema.sql');
const LEDGER = join(MIG, '20260820160000_wallet_atomic_ledger.sql');
const REMINDERS = join(MIG, '20260721020000_loyalty_reminders.sql');
const TIERS = join(MIG, '20260721030000_loyalty_reward_tiers.sql');
const BACKBONE = join(MIG, '20260721000000_loyalty_redemption_backbone.sql');
const COMMERCE = join(MIG, '20260801130000_commerce_engine.sql');
const POINTS = join(MIG, '20261006120000_wallet_loyalty_points.sql');
const RATELIMITS = join(MIG, '20260821280000_rate_limits.sql');
const FIX = join(MIG, '20261007120000_business_wallet_refunds.sql');
const RECEIPTS = join(MIG, '20261008120000_receipt_refund_state.sql');

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
async function rawAsync(body: string): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(PSQL, args(body), { cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000 });
    return stdout + stderr;
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}
const TAG = /^(SET|RESET|BEGIN|COMMIT|ROLLBACK|DO|GRANT|REVOKE|COMMENT|CREATE .*|DROP .*|ALTER .*|INSERT \d+ \d+|UPDATE \d+|DELETE \d+)$/;
const value = (out: string) => out.split('\n').map((l) => l.trim()).filter((l) => l && !TAG.test(l)).pop() ?? '';
const scalar = (sql: string) => value(raw(sql));
const num = (sql: string) => Number(scalar(sql));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

const OWNER = 'b0000000-0000-4000-8000-00000000000b';
const OTHER = 'a0000000-0000-4000-8000-00000000000a';
const CUST  = 'c0000000-0000-4000-8000-00000000000c';
const BIZ   = 'd0000000-0000-4000-8000-00000000000d';
const PROG  = 'e0000000-0000-4000-8000-00000000000e';
const ITEM  = 'f0000000-0000-4000-8000-00000000000f';
const PASS  = '11110000-0000-4000-8000-000000000011';
const SPEND = '22220000-0000-4000-8000-000000000022';
const RED   = '33330000-0000-4000-8000-000000000033';
const TOKEN = '44440000-0000-4000-8000-000000000044';
const ORDER = '55550000-0000-4000-8000-000000000055';
const OSPEND = '66660000-0000-4000-8000-000000000066';
const PRODUCT = '77770000-0000-4000-8000-000000000077';
const VARIANT = '88880000-0000-4000-8000-000000000088';
const HUBSPEND = '99990000-0000-4000-8000-000000000099';

/** Real tables and real functions, then the migration under test. */
function schema() {
  const out = raw([
    'drop schema if exists public cascade; create schema public;',
    'drop schema if exists auth cascade; create schema auth;',
    'create table auth.users (id uuid primary key);',
    `do $$ begin
       if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
       if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
       if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
     end $$;`,
    'create table public.profiles (id uuid primary key, role text, is_platform_owner boolean default false);',
    createTable(BASELINE, 'CREATE TABLE public.local_businesses ('),
    'alter table public.local_businesses add primary key (id);',
    createTable(BASELINE, 'CREATE TABLE public.local_wallet_balances ('),
    'alter table public.local_wallet_balances add primary key (user_id);',
    createTable(BASELINE, 'CREATE TABLE public.local_wallet_transactions ('),
    'alter table public.local_wallet_transactions add primary key (id);',
    `alter table public.local_wallet_transactions
       add column idempotency_key text,
       add column transfer_state text,
       add column reverses_transaction_id uuid references public.local_wallet_transactions(id);`,
    `create unique index local_wallet_transactions_idempotency_key
       on public.local_wallet_transactions (idempotency_key) where idempotency_key is not null;`,
    `alter table public.local_wallet_transactions add constraint local_wallet_transactions_transfer_state_check
       check (transfer_state is null or transfer_state in ('none','pending','sent','failed','unresolved','reversed'));`,
    // Loyalty, because wallet_reverse_debit reaches into it.
    createTable(BASELINE, 'CREATE TABLE public.local_loyalty_programs ('),
    'alter table public.local_loyalty_programs add primary key (id);',
    slice(TIERS, 'alter table public.local_loyalty_programs', ';'),
    createTable(BASELINE, 'CREATE TABLE public.local_loyalty_cards ('),
    'alter table public.local_loyalty_cards add primary key (id);',
    'alter table public.local_loyalty_cards add constraint local_loyalty_cards_user_id_program_id_key unique (user_id, program_id);',
    slice(REMINDERS, 'alter table public.local_loyalty_cards\n  add column if not exists reward_reminded_at', ';'),
    slice(REMINDERS, 'alter table public.local_loyalty_cards\n  add column if not exists nudge_reminded_at', ';'),
    slice(TIERS, 'alter table public.local_loyalty_cards\n  add column if not exists tiers_redeemed_upto', ';'),
    createTable(BASELINE, 'CREATE TABLE public.local_loyalty_transactions ('),
    'alter table public.local_loyalty_transactions add primary key (id);',
    // Passes.
    createTable(BASELINE, 'CREATE TABLE public.book_unit_items ('),
    'alter table public.book_unit_items add primary key (id);',
    createTable(BASELINE, 'CREATE TABLE public.book_unit_purchases ('),
    'alter table public.book_unit_purchases add primary key (id);',
    // The real purchase-time stock decrement, so "+1 back" is measured against
    // the same arithmetic production actually performs.
    slice(BASELINE, 'CREATE FUNCTION public.tg_decrement_unit_stock()', '$$;'),
    `create trigger book_unit_purchases_decrement_stock after insert on public.book_unit_purchases
       for each row execute function public.tg_decrement_unit_stock();`,
    createTable(BACKBONE, 'create table if not exists public.local_redemptions ('),
    // Shop.
    createTable(COMMERCE, 'create table if not exists public.products ('),
    createTable(COMMERCE, 'create table if not exists public.product_variants ('),
    createTable(COMMERCE, 'create table if not exists public.product_orders ('),
    createTable(COMMERCE, 'create table if not exists public.product_order_items ('),
    // The live status vocabulary, verified against production.
    `alter table public.product_orders drop constraint if exists product_orders_status_check;
     alter table public.product_orders add constraint product_orders_status_check
       check (status = any (array['pending','paid','accepted','ready','handed_over','posted','completed','cancelled','refunded','expired']));`,
    `create or replace function public.business_meets_tier(p_biz uuid, p_tier text)
       returns boolean language sql stable as $$ select true $$;`,
    `create or replace function public.is_admin() returns boolean language sql stable as $$ select false $$;`,
    slice(LEDGER, 'create or replace function public.wallet_credit_with_ledger', '$$;'),
    // Loyalty points + the wallet_reverse_debit that calls them.
    slice(POINTS, 'alter table public.local_loyalty_transactions\n  add column if not exists source_transaction_id', ';'),
    slice(POINTS, 'create unique index if not exists local_loyalty_tx_one_per_source_and_type', ';'),
    slice(POINTS, 'alter table public.local_loyalty_cards\n  add column if not exists points_deficit', ';'),
    slice(POINTS, 'do $$\nbegin\n  if not exists (select 1 from pg_constraint', 'end $$;'),
    slice(POINTS, 'alter table public.local_loyalty_transactions\n  drop constraint if exists', ';'),
    slice(POINTS, 'alter table public.local_loyalty_transactions\n  add constraint local_loyalty_transactions_type_check', ']));'),
    slice(POINTS, 'create table if not exists public.loyalty_award_due', ');'),
    slice(POINTS, 'create index if not exists loyalty_award_due_unsettled', ';'),
    slice(POINTS, 'create or replace function public._loyalty_apply_award', '$$;'),
    slice(POINTS, 'create or replace function public.loyalty_award_for_wallet_spend', '$$;'),
    slice(POINTS, 'create or replace function public.loyalty_reverse_for_wallet_spend', '$$;'),
    slice(POINTS, 'create or replace function public.wallet_reverse_debit', '$$;'),
    // The REAL table, sliced from its own migration. A hand-written stub here
    // is what let a NOT NULL `note` column go unnoticed until production
    // refused the insert: the suite was green against a table that did not
    // exist anywhere but in this file.
    createTable(RATELIMITS, 'create table if not exists public.rate_limit_policies ('),
    // Production grants authenticated blanket table-level UPDATE on both of
    // these — measured, not assumed — so the trigger must be the thing that
    // refuses a merchant, not a missing privilege.
    'grant usage on schema public to anon, authenticated, service_role;',
    'grant select, insert, update, delete on all tables in schema public to anon, authenticated, service_role;',
  ].join('\n'));
  assert.doesNotMatch(out, /ERROR/i, `schema failed:\n${out.slice(0, 1600)}`);
}

/** The migration under test. */
const fixSql = () => [
  slice(FIX, 'alter table public.book_unit_purchases\n  add column if not exists refund_state', ';'),
  slice(FIX, 'do $$\nbegin\n  if not exists (select 1 from pg_constraint\n                  where conrelid = \'public.book_unit_purchases\'::regclass', 'end $$;'),
  slice(FIX, 'alter table public.product_orders\n  add column if not exists refund_state', ';'),
  slice(FIX, 'do $$\nbegin\n  if not exists (select 1 from pg_constraint\n                  where conrelid = \'public.product_orders\'::regclass', 'end $$;'),
  slice(FIX, 'create index if not exists book_unit_purchases_refund_pending', ';'),
  slice(FIX, 'create index if not exists product_orders_refund_pending', ';'),
  slice(FIX, 'create or replace function public.tg_is_server_write', '$$;'),
  slice(FIX, 'create or replace function public.tg_lock_pass_refund_columns', '$$;'),
  slice(FIX, 'drop trigger if exists tg_zz_lock_pass_refund_columns', 'tg_lock_pass_refund_columns();'),
  slice(FIX, 'create or replace function public.tg_lock_order_refund_columns', '$$;'),
  slice(FIX, 'drop trigger if exists tg_zz_lock_order_refund_columns', 'tg_lock_order_refund_columns();'),
  slice(FIX, 'CREATE OR REPLACE FUNCTION public.redeem_pass_atomic', '$function$;'),
  slice(FIX, 'create or replace function public._business_refund_source', '$$;'),
  slice(FIX, 'create or replace function public.business_refund_claim', '$$;'),
  slice(FIX, 'create or replace function public.business_refund_finalise', '$$;'),
  slice(FIX, 'insert into public.rate_limit_policies', ';'),
  slice(FIX, 'revoke all on function public._business_refund_source',
             'public.business_refund_finalise(uuid, text, text) to service_role;'),
].join('\n');

function installFix(mutate?: (s: string) => string) {
  const sql = mutate ? mutate(fixSql()) : fixSql();
  const out = raw(sql);
  assert.doesNotMatch(out, /ERROR:/, `migration failed:\n${out.slice(0, 1600)}`);
}

/**
 * The receipts RPC, plus the two things it needs that the refund functions do
 * not: the caller's identity, and the customer's name. Supabase's auth.uid() is
 * reproduced faithfully — the subject claim of the caller's JWT — so the
 * ownership rule is tested the way production enforces it.
 */
function installReceipts() {
  const out = raw([
    `create or replace function auth.uid() returns uuid language sql stable as $$
       select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;`,
    'grant usage on schema auth to anon, authenticated, service_role;',
    'grant execute on function auth.uid() to anon, authenticated, service_role;',
    'alter table public.profiles add column if not exists full_name text;',
    src(RECEIPTS),
  ].join('\n'));
  assert.doesNotMatch(out, /ERROR:/, `receipts migration failed:\n${out.slice(0, 1600)}`);
}

/** The receipt list exactly as a signed-in merchant would receive it. */
function receiptsAs(uid: string, limit = 20): Record<string, unknown>[] {
  const out = raw(`select set_config('request.jwt.claim.sub','${uid}',false);
    select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)::text
      from public.get_business_wallet_receipts('${BIZ}'::uuid, ${limit}) t;`);
  const line = value(out);
  assert.match(line, /^\[/, `receipts did not return JSON:\n${out.slice(0, 600)}`);
  return JSON.parse(line) as Record<string, unknown>[];
}
const receiptFor = (id: string, uid = OWNER) =>
  receiptsAs(uid).find((r) => r.id === id) as Record<string, unknown> | undefined;

/** A business, a customer, a £3 wallet-funded pass, and a shop order. */
function fixtures(opts: { itemStock?: string; uses?: number; passState?: string } = {}) {
  const o = raw(`
    delete from public.local_redemptions;
    delete from public.book_unit_purchases;
    delete from public.book_unit_items;
    delete from public.product_order_items;
    delete from public.product_orders;
    delete from public.product_variants;
    delete from public.products;
    delete from public.local_loyalty_transactions;
    delete from public.local_loyalty_cards;
    delete from public.local_wallet_transactions;
    delete from public.local_wallet_balances;
    delete from public.local_businesses;
    delete from public.profiles;
    delete from auth.users;

    insert into auth.users(id) values ('${OWNER}'),('${CUST}'),('${OTHER}');
    insert into public.profiles(id) values ('${OWNER}'),('${CUST}'),('${OTHER}');
    insert into public.local_businesses (id, owner_id, name, category, address)
      values ('${BIZ}','${OWNER}','Anderson & Co','retail','Lerwick');
    insert into public.local_wallet_balances (user_id, balance_pence) values ('${CUST}', 1500);

    -- The £3 pass, exactly as wallet-checkout writes it.
    insert into public.book_unit_items (id, business_id, name, price_pence, uses_per_purchase, stock)
      values ('${ITEM}','${BIZ}','DEMO — 3 Session Pass', 300, 3, ${opts.itemStock ?? '5'});
    insert into public.local_wallet_transactions
      (id,user_id,business_id,type,amount_pence,platform_fee_pence,cashback_pence,description,idempotency_key,transfer_state,stripe_transfer_id)
      values ('${SPEND}','${CUST}','${BIZ}','spend',-300,15,0,'DEMO — 3 Session Pass · Anderson & Co','wallet-attempt:one','sent','tr_test');
    insert into public.book_unit_purchases
      (id,item_id,business_id,owner_id,paid_amount_pence,uses_remaining,payment_intent_id,expires_at)
      values ('${PASS}','${ITEM}','${BIZ}','${CUST}',300,${opts.uses ?? 3},'wallet_${SPEND}', now() + interval '30 days');
    ${opts.passState ? `update public.book_unit_purchases set refund_state='${opts.passState}' where id='${PASS}';` : ''}

    -- A shop order paid from the wallet. The order stores no wallet reference;
    -- the debit's idempotency key is the only link, which is why resolution
    -- reads it rather than trusting a caller.
    insert into public.products (id, business_id, title, price_pence, stock_mode, stock, reserved)
      values ('${PRODUCT}','${BIZ}','Gansey', 5000, 'tracked', 4, 2);
    insert into public.product_variants (id, product_id, name, stock, reserved)
      values ('${VARIANT}','${PRODUCT}','Large', 3, 1);
    insert into public.local_wallet_transactions
      (id,user_id,business_id,type,amount_pence,platform_fee_pence,cashback_pence,description,idempotency_key,transfer_state,stripe_transfer_id)
      values ('${OSPEND}','${CUST}','${BIZ}','spend',-5000,250,0,'Shop order at Anderson & Co','product-order-${ORDER}','sent','tr_test2');
    insert into public.product_orders (id, business_id, buyer_id, status, fulfilment, items_pence, shipping_pence, total_pence, commission_pence, paid_via)
      values ('${ORDER}','${BIZ}','${CUST}','paid','collect',5000,0,5000,250,'wallet');
    insert into public.product_order_items (order_id, product_id, variant_id, title, unit_pence, qty)
      values ('${ORDER}','${PRODUCT}','${VARIANT}','Gansey',5000,2);

    -- A hub-shaped spend: no business, so this route must never touch it.
    insert into public.local_wallet_transactions
      (id,user_id,business_id,type,amount_pence,platform_fee_pence,description,idempotency_key,transfer_state)
      values ('${HUBSPEND}','${CUST}',null,'spend',-195,95,'Membership · a hub','wallet-attempt:hub','sent');
  `);
  assert.doesNotMatch(o, /ERROR/i, `fixtures failed:\n${o.slice(0, 1200)}`);
}

/** Consume `n` uses of the pass through the real redemption path. */
function consume(n: number) {
  for (let i = 0; i < n; i++) {
    const id = `${RED.slice(0, -1)}${i}`;
    const tok = `${TOKEN.slice(0, -1)}${i}`;
    const o = raw(`
      insert into public.local_redemptions (id, user_id, business_id, kind, ref_id, status, code, token, expires_at)
        values ('${id}','${CUST}','${BIZ}','pass','${PASS}','pending','C00${i}','${tok}', now() + interval '15 minutes');
      select public.redeem_pass_atomic('${OWNER}', null, '${tok}');`);
    assert.match(o, /"ok"\s*:\s*true/, `use ${i + 1} did not land:\n${o.slice(0, 600)}`);
  }
}
function pendingCode(): string {
  const o = raw(`insert into public.local_redemptions (id, user_id, business_id, kind, ref_id, status, code, token, expires_at)
      values ('${RED}','${CUST}','${BIZ}','pass','${PASS}','pending','ZZZZ','${TOKEN}', now() + interval '15 minutes');`);
  assert.doesNotMatch(o, /ERROR/i, o.slice(0, 400));
  return TOKEN;
}

const claim = (txn = SPEND) => raw(`select public.business_refund_claim('${txn}');`);
const finalise = (txn = SPEND, merchant = 'clawed_back') =>
  raw(`select public.business_refund_finalise('${txn}', 'Refund · test', '${merchant}');`);
const passState = () => scalar(`select refund_state from public.book_unit_purchases where id='${PASS}';`);
const orderState = () => scalar(`select refund_state from public.product_orders where id='${ORDER}';`);
const orderStatus = () => scalar(`select status from public.product_orders where id='${ORDER}';`);
const balance = () => num(`select balance_pence::text from public.local_wallet_balances where user_id='${CUST}';`);
const refundRows = (txn = SPEND) =>
  num(`select count(*)::text from public.local_wallet_transactions where reverses_transaction_id='${txn}';`);
const itemStock = () => scalar(`select coalesce(stock::text,'NULL') from public.book_unit_items where id='${ITEM}';`);
const productStock = () => num(`select stock::text from public.products where id='${PRODUCT}';`);
const productReserved = () => num(`select reserved::text from public.products where id='${PRODUCT}';`);
const variantStock = () => num(`select stock::text from public.product_variants where id='${VARIANT}';`);

before(() => {
  assert.ok(DSN, 'PASS_PROOF_DSN is required — run via `npm run test:isolated`');
  assert.ok(!/supabase/i.test(DSN), 'refusing to run against anything that looks like Supabase');
});

// ───────────────────────────────────────────────────────────────────────────
describe('the migration installs what it claims', () => {
  before(() => { schema(); installFix(); fixtures(); });

  test('both tables carry refund state, defaulting to none', () => {
    assert.equal(passState(), 'none');
    assert.equal(orderState(), 'none');
  });

  test('refund_state is constrained to the three honest values', () => {
    const o = raw(`update public.book_unit_purchases set refund_state='vanished' where id='${PASS}';`);
    assert.match(o, /ERROR:/, 'any string could be written into refund_state');
    assert.equal(passState(), 'none');
  });

  test('refund_transaction_id points at the ledger', () => {
    assert.equal(num(`select count(*)::text from pg_constraint
      where conrelid='public.book_unit_purchases'::regclass and contype='f'
        and pg_get_constraintdef(oid) ilike '%refund_transaction_id%local_wallet_transactions%';`), 1);
  });

  test('the refund functions are service-role only', () => {
    for (const fn of ['business_refund_claim', 'business_refund_finalise']) {
      assert.equal(scalar(`select has_function_privilege('authenticated', p.oid, 'execute')::text
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='${fn}';`), 'false', `${fn} is callable by a client`);
      assert.equal(scalar(`select has_function_privilege('service_role', p.oid, 'execute')::text
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='${fn}';`), 'true');
    }
  });

  test('the rate-limit action exists, because an unclassified action is denied', () => {
    assert.equal(num(`select count(*)::text from public.rate_limit_policies where action='business_refund';`), 1);
  });

  test('tg_is_server_write is SECURITY INVOKER, or it would pass for everyone', () => {
    assert.equal(scalar(`select prosecdef::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='tg_is_server_write';`), 'false');
  });

  test('it has no platform-admin escape hatch, unlike tg_is_trusted_writer', () => {
    const body = scalar(`select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='tg_is_server_write';`);
    assert.ok(!/is_admin/.test(raw(`select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='tg_is_server_write';`)),
      'an admin could stamp refunded_at from a browser with no money moving');
    assert.ok(body !== undefined);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('a merchant cannot write refund state by hand', () => {
  before(() => { schema(); installFix(); fixtures(); });

  const asMerchant = (sql: string) =>
    raw(`set role authenticated; ${sql} reset role;`);

  for (const [col, val] of [
    ['refund_state', `'refunded'`],
    ['refunded_at', 'now()'],
    ['refund_transaction_id', `'${SPEND}'`],
  ] as const) {
    test(`pass ${col} is refused from a client role`, () => {
      const o = asMerchant(`update public.book_unit_purchases set ${col}=${val} where id='${PASS}';`);
      assert.match(o, /server-managed/, `a merchant wrote ${col} directly:\n${o.slice(0, 400)}`);
    });
    test(`order ${col} is refused from a client role`, () => {
      const o = asMerchant(`update public.product_orders set ${col}=${val} where id='${ORDER}';`);
      assert.match(o, /server-managed/, `a merchant wrote ${col} directly:\n${o.slice(0, 400)}`);
    });
  }

  test('a pass use balance is refused from a client role', () => {
    const o = asMerchant(`update public.book_unit_purchases set uses_remaining=0 where id='${PASS}';`);
    assert.match(o, /server-managed/);
    assert.equal(num(`select uses_remaining::text from public.book_unit_purchases where id='${PASS}';`), 3);
  });

  test('fully_used_at cannot be fabricated from a client role', () => {
    const o = asMerchant(`update public.book_unit_purchases set fully_used_at=now() where id='${PASS}';`);
    assert.match(o, /server-managed/);
  });

  test('but the redemption RPC still spends a use, because it is a definer path', () => {
    pendingCode();
    const o = raw(`select public.redeem_pass_atomic('${OWNER}', null, '${TOKEN}');`);
    assert.match(o, /"ok"\s*:\s*true/, o.slice(0, 400));
    assert.equal(num(`select uses_remaining::text from public.book_unit_purchases where id='${PASS}';`), 2);
  });

  test('ordinary fulfilment still works while no refund is in flight', () => {
    const o = asMerchant(`update public.product_orders set status='accepted' where id='${ORDER}';`);
    assert.doesNotMatch(o, /ERROR:/, `the guard broke normal fulfilment:\n${o.slice(0, 400)}`);
    assert.equal(orderStatus(), 'accepted');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('a pass is refundable only while nothing has been used', () => {
  before(() => { schema(); installFix(); });

  test('zero consumed uses claims', () => {
    fixtures();
    assert.match(claim(), /"outcome"\s*:\s*"claimed"/);
    assert.equal(passState(), 'pending');
  });

  test('one consumed use refuses, and says so', () => {
    fixtures();
    consume(1);
    const o = claim();
    assert.match(o, /"outcome"\s*:\s*"pass_used"/, o.slice(0, 400));
    assert.equal(passState(), 'none', 'a refused claim still froze the pass');
  });

  test('a partly used pass refuses', () => {
    fixtures();
    consume(2);
    assert.match(claim(), /"outcome"\s*:\s*"pass_used"/);
  });

  test('a fully used pass refuses', () => {
    fixtures();
    consume(3);
    assert.equal(num(`select uses_remaining::text from public.book_unit_purchases where id='${PASS}';`), 0);
    assert.match(claim(), /"outcome"\s*:\s*"pass_used"/);
  });

  test('eligibility is read from the redemption trail, not the catalogue', () => {
    fixtures();
    consume(1);
    // The merchant edits the item afterwards. uses_remaining vs
    // uses_per_purchase now agree at 2, which is exactly the comparison that
    // would call a used pass untouched.
    raw(`update public.book_unit_items set uses_per_purchase=2 where id='${ITEM}';`);
    assert.equal(num(`select uses_remaining::text from public.book_unit_purchases where id='${PASS}';`), 2);
    assert.equal(num(`select uses_per_purchase::text from public.book_unit_items where id='${ITEM}';`), 2);
    assert.match(claim(), /"outcome"\s*:\s*"pass_used"/,
      'the catalogue was edited and a used pass became refundable');
  });

  test('a hub spend is refused: it is not a business payment', () => {
    fixtures();
    assert.match(claim(HUBSPEND), /"outcome"\s*:\s*"not_a_business_spend"/);
  });

  test('a claim is idempotent', () => {
    fixtures();
    claim();
    assert.match(claim(), /"outcome"\s*:\s*"already_pending"/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('a first use and a refund claim cannot both win', () => {
  before(() => { schema(); installFix(); });

  test('redemption takes the lock first → the refund is refused', async () => {
    fixtures();
    pendingCode();
    const a = rawAsync(`begin; select public.redeem_pass_atomic('${OWNER}', null, '${TOKEN}'); select pg_sleep(0.6); commit;`);
    await sleep(150);
    const b = rawAsync(`select public.business_refund_claim('${SPEND}');`);
    const [red, ref] = await Promise.all([a, b]);
    assert.match(red, /"ok"\s*:\s*true/, `the use did not land:\n${red.slice(0, 400)}`);
    assert.match(ref, /"outcome"\s*:\s*"pass_used"/, `the refund won anyway:\n${ref.slice(0, 400)}`);
    assert.equal(passState(), 'none');
    assert.equal(num(`select uses_remaining::text from public.book_unit_purchases where id='${PASS}';`), 2);
  });

  test('the refund takes the lock first → the redemption is refused', async () => {
    fixtures();
    pendingCode();
    const a = rawAsync(`begin; select public.business_refund_claim('${SPEND}'); select pg_sleep(0.6); commit;`);
    await sleep(150);
    const b = rawAsync(`select public.redeem_pass_atomic('${OWNER}', null, '${TOKEN}');`);
    const [ref, red] = await Promise.all([a, b]);
    assert.match(ref, /"outcome"\s*:\s*"claimed"/, `the claim failed:\n${ref.slice(0, 400)}`);
    assert.match(red, /"error"\s*:\s*"pass_refunded"/, `a refunded pass was still spent:\n${red.slice(0, 400)}`);
    assert.equal(passState(), 'pending');
    assert.equal(num(`select uses_remaining::text from public.book_unit_purchases where id='${PASS}';`), 3,
      'the use was taken from a pass being refunded');
  });

  test('the use count is read under the lock, not before it', () => {
    // Mutation: move the consumed-use test above the FOR UPDATE and the first
    // race above stops refusing, because the count is taken on a stale snapshot.
    const body = src(FIX);
    const lockFirst = body.indexOf('where id = v_src.source_id for update');
    const countAfter = body.indexOf('where r.kind = \'pass\' and r.ref_id = v_purchase.id');
    assert.ok(lockFirst > -1 && countAfter > lockFirst,
      'the consumed-use count no longer runs after the purchase row lock');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('orders freeze and refuse correctly', () => {
  before(() => { schema(); installFix(); });

  for (const s of ['paid', 'accepted']) {
    test(`a ${s} order can be claimed`, () => {
      fixtures();
      raw(`update public.product_orders set status='${s}' where id='${ORDER}';`);
      assert.match(claim(OSPEND), /"outcome"\s*:\s*"claimed"/);
      assert.equal(orderState(), 'pending');
    });
  }
  for (const s of ['ready', 'posted', 'handed_over', 'completed']) {
    test(`a ${s} order is refused`, () => {
      fixtures();
      raw(`update public.product_orders set status='${s}' where id='${ORDER}';`);
      const o = claim(OSPEND);
      assert.match(o, /"outcome"\s*:\s*"order_not_refundable"/, o.slice(0, 400));
      assert.equal(orderState(), 'none');
    });
  }

  test('a pending order cannot be advanced by a client', () => {
    fixtures();
    claim(OSPEND);
    const o = raw(`set role authenticated; update public.product_orders set status='ready' where id='${ORDER}'; reset role;`);
    assert.match(o, /order_refund_in_progress/, o.slice(0, 400));
    assert.equal(orderStatus(), 'paid');
  });

  test('a refunded order cannot be reopened by a client', () => {
    fixtures();
    claim(OSPEND);
    finalise(OSPEND);
    assert.equal(orderState(), 'refunded');
    const o = raw(`set role authenticated; update public.product_orders set status='accepted' where id='${ORDER}'; reset role;`);
    assert.match(o, /order_refunded/, o.slice(0, 400));
    assert.equal(orderStatus(), 'refunded');
  });

  test('a client advancing an order and a claim cannot both win', async () => {
    fixtures();
    const a = rawAsync(`begin; select public.business_refund_claim('${OSPEND}'); select pg_sleep(0.6); commit;`);
    await sleep(150);
    const b = rawAsync(`set role authenticated; update public.product_orders set status='ready' where id='${ORDER}'; reset role;`);
    const [c, adv] = await Promise.all([a, b]);
    assert.match(c, /"outcome"\s*:\s*"claimed"/);
    assert.match(adv, /order_refund_in_progress/, `fulfilment advanced during a refund:\n${adv.slice(0, 400)}`);
    assert.equal(orderStatus(), 'paid');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('the money only moves at finalisation', () => {
  before(() => { schema(); installFix(); });

  test('after a claim, before Stripe: frozen, and nothing else happened', () => {
    fixtures();
    claim();
    assert.equal(passState(), 'pending');
    assert.equal(balance(), 1500, 'the wallet was credited before the transfer came back');
    assert.equal(refundRows(), 0);
    assert.equal(itemStock(), '4', 'stock came back before the refund did');
    assert.equal(num(`select count(*)::text from public.local_loyalty_transactions;`), 0);
  });

  test('a pending refund is discoverable, so a stuck one can be found', () => {
    assert.equal(num(`select count(*)::text from public.book_unit_purchases where refund_state='pending';`), 1);
  });

  test('the retry completes it exactly once', () => {
    const o = finalise();
    assert.match(o, /"ok"\s*:\s*true/, o.slice(0, 500));
    assert.equal(passState(), 'refunded');
    assert.equal(balance(), 1800);
    assert.equal(refundRows(), 1);
    assert.equal(itemStock(), '5');
  });

  test('the pass keeps its uses, because it was never used', () => {
    assert.equal(num(`select uses_remaining::text from public.book_unit_purchases where id='${PASS}';`), 3);
    assert.equal(scalar(`select coalesce(fully_used_at::text,'NULL') from public.book_unit_purchases where id='${PASS}';`), 'NULL');
  });

  test('and it is linked to the reversal that paid for it', () => {
    assert.equal(scalar(`select (p.refund_transaction_id = t.id)::text
      from public.book_unit_purchases p join public.local_wallet_transactions t
        on t.reverses_transaction_id='${SPEND}' where p.id='${PASS}';`), 'true');
    assert.notEqual(scalar(`select coalesce(refunded_at::text,'NULL') from public.book_unit_purchases where id='${PASS}';`), 'NULL');
  });

  test('a refunded pass cannot be redeemed', () => {
    pendingCode();
    assert.match(raw(`select public.redeem_pass_atomic('${OWNER}', null, '${TOKEN}');`), /"error"\s*:\s*"pass_refunded"/);
  });

  test('finalising cannot run on a source nobody claimed', () => {
    fixtures();
    assert.match(finalise(), /"error"\s*:\s*"not_claimed"/);
    assert.equal(balance(), 1500, 'money moved without a claim');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('a failure inside finalisation takes the money back with it', () => {
  before(() => { schema(); installFix(); });

  test('the whole refund rolls back, rather than half happening', () => {
    fixtures();
    // Award points first, so there is a Loyalty reversal to roll back too.
    raw(`insert into public.local_loyalty_programs (id, business_id, type, points_per_pound, points_for_pound, is_active)
           values ('${PROG}','${BIZ}','points',10,100,true);
         select public.loyalty_award_for_wallet_spend('${SPEND}');`);
    assert.equal(num(`select points_balance::text from public.local_loyalty_cards where user_id='${CUST}';`), 28);

    claim();
    // Break the terminal half only: the reversal itself is fine, the stock
    // restore is what dies.
    raw(`alter table public.book_unit_items add constraint probe_break check (stock < 5);`);
    const o = finalise();
    raw(`alter table public.book_unit_items drop constraint probe_break;`);

    assert.match(o, /ERROR:/, `finalisation swallowed a failure:\n${o.slice(0, 500)}`);
    assert.equal(refundRows(), 0, 'a refund row survived a rolled-back finalisation');
    assert.equal(balance(), 1500, 'the wallet kept a credit from a rolled-back refund');
    assert.equal(passState(), 'pending', 'the source did not stay retryable');
    assert.equal(itemStock(), '4');
    assert.equal(num(`select points_balance::text from public.local_loyalty_cards where user_id='${CUST}';`), 28,
      'the Loyalty reversal committed while the refund did not');
    assert.equal(num(`select count(*)::text from public.local_loyalty_transactions where type='points_reverse';`), 0);
  });

  test('and the retry, once unblocked, completes it', () => {
    const o = finalise();
    assert.match(o, /"ok"\s*:\s*true/, o.slice(0, 500));
    assert.equal(passState(), 'refunded');
    assert.equal(balance(), 1800);
    assert.equal(refundRows(), 1);
    assert.equal(itemStock(), '5');
    assert.equal(num(`select points_balance::text from public.local_loyalty_cards where user_id='${CUST}';`), 0,
      'the points survived the refund');
    assert.equal(num(`select count(*)::text from public.local_loyalty_transactions where type='points_reverse';`), 1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('replaying a completed refund changes nothing', () => {
  before(() => { schema(); installFix(); fixtures(); claim(); finalise(); });

  test('the first one landed', () => {
    assert.equal(balance(), 1800);
    assert.equal(refundRows(), 1);
    assert.equal(itemStock(), '5');
  });

  test('a second finalise credits nothing more', () => {
    const o = finalise();
    assert.match(o, /"ok"\s*:\s*true/, o.slice(0, 400));
    assert.equal(balance(), 1800, 'the wallet was credited twice');
    assert.equal(refundRows(), 1, 'a second reversal row appeared');
    assert.equal(itemStock(), '5', 'stock was restored twice');
  });

  test('a second claim reports it is already done', () => {
    assert.match(claim(), /"outcome"\s*:\s*"already_refunded"/);
  });

  test('and a third round trip is still inert', () => {
    claim(); finalise();
    assert.equal(balance(), 1800);
    assert.equal(refundRows(), 1);
    assert.equal(itemStock(), '5');
    assert.equal(num(`select count(*)::text from public.local_loyalty_transactions where type='points_reverse';`), 0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('stock comes back exactly, and only what went out', () => {
  before(() => { schema(); installFix(); });

  test('a tracked pass item gets exactly one unit back', () => {
    fixtures();                       // stock 5, minus one at purchase = 4
    assert.equal(itemStock(), '4');
    claim(); finalise();
    assert.equal(itemStock(), '5');
  });

  test('one unit, not one per use — a three-use pass is still one unit', () => {
    fixtures({ uses: 3 });
    claim(); finalise();
    assert.equal(itemStock(), '5', 'uses were mistaken for inventory');
  });

  test('an untracked item is left alone', () => {
    fixtures({ itemStock: 'null' });
    assert.equal(itemStock(), 'NULL');
    claim(); finalise();
    assert.equal(itemStock(), 'NULL');
  });

  test('a tracked product and variant get the committed quantity back', () => {
    fixtures();
    assert.equal(productStock(), 4);
    assert.equal(variantStock(), 3);
    claim(OSPEND); finalise(OSPEND);
    assert.equal(productStock(), 6, 'the ordered quantity did not come back');
    assert.equal(variantStock(), 5);
    assert.equal(orderStatus(), 'refunded');
  });

  test('reserved is never touched — commit already released it', () => {
    assert.equal(productReserved(), 2, 'the refund inflated reserved and withheld inventory');
  });

  test('a one_off product becomes buyable again', () => {
    fixtures();
    raw(`update public.products set stock_mode='one_off', sold_at=now(), is_active=false where id='${PRODUCT}';`);
    claim(OSPEND); finalise(OSPEND);
    assert.equal(scalar(`select coalesce(sold_at::text,'NULL') from public.products where id='${PRODUCT}';`), 'NULL');
    assert.equal(scalar(`select is_active::text from public.products where id='${PRODUCT}';`), 'true');
  });

  test('a one_off is not double-restored on replay', () => {
    const before = productStock();
    finalise(OSPEND);
    assert.equal(productStock(), before);
    assert.equal(scalar(`select is_active::text from public.products where id='${PRODUCT}';`), 'true');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('rails with no purchase object still refund', () => {
  before(() => { schema(); installFix(); });

  test('a wallet-pay spend has nothing to freeze and refunds anyway', () => {
    fixtures();
    // No pass, no order: the ledger row is the whole record.
    raw(`delete from public.book_unit_purchases where id='${PASS}';
         update public.local_wallet_transactions set idempotency_key='wallet-attempt:till' where id='${SPEND}';`);
    assert.match(claim(), /"source_type"\s*:\s*"none"/);
    const o = finalise();
    assert.match(o, /"ok"\s*:\s*true/, o.slice(0, 400));
    assert.equal(balance(), 1800);
    assert.equal(refundRows(), 1);
  });

  test('and replaying it credits nothing more', () => {
    finalise();
    assert.equal(balance(), 1800);
    assert.equal(refundRows(), 1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('the source is resolved from our own rows', () => {
  before(() => { schema(); installFix(); });

  test('a pass whose payment reference points elsewhere is refused', () => {
    fixtures();
    raw(`update public.book_unit_purchases set payment_intent_id='wallet_${OSPEND}' where id='${PASS}';`);
    // Resolution keys on the reference, so this pass is no longer this debit's.
    assert.match(claim(), /"source_type"\s*:\s*"none"/,
      'a purchase belonging to another payment was picked up');
  });

  test('a pass owned by somebody else is refused', () => {
    fixtures();
    raw(`update public.book_unit_purchases set owner_id='${OTHER}' where id='${PASS}';`);
    assert.match(claim(), /"outcome"\s*:\s*"not_linked"/);
  });

  test('an order belonging to another business is refused', () => {
    fixtures();
    raw(`insert into public.local_businesses (id, owner_id, name, category, address)
           values ('${OTHER}','${OTHER}','Other','retail','Lerwick');
         update public.product_orders set business_id='${OTHER}' where id='${ORDER}';`);
    assert.match(claim(OSPEND), /"outcome"\s*:\s*"not_linked"/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('the transfer verdict model is untouched', () => {
  before(() => { schema(); installFix(); });

  test('an unresolved transfer is still refused by the ledger', () => {
    fixtures();
    raw(`update public.local_wallet_transactions set transfer_state='unresolved' where id='${SPEND}';`);
    claim();
    const o = finalise(SPEND, 'clawed_back');
    assert.match(o, /unresolved/i, `an unresolved transfer was refunded:\n${o.slice(0, 400)}`);
    assert.equal(balance(), 1500);
    assert.equal(passState(), 'pending', 'a refusal left the source in the wrong state');
  });

  test('clawed_back on a transfer that was never sent is still refused', () => {
    fixtures();
    raw(`update public.local_wallet_transactions set transfer_state='none' where id='${SPEND}';`);
    claim();
    const o = finalise(SPEND, 'clawed_back');
    assert.match(o, /nothing was sent/i, o.slice(0, 400));
    assert.equal(balance(), 1500);
  });

  test('a sent transfer clawed back lands on reversed', () => {
    fixtures();
    claim(); finalise(SPEND, 'clawed_back');
    assert.equal(scalar(`select transfer_state from public.local_wallet_transactions where id='${SPEND}';`), 'reversed');
  });

  test('wallet_reverse_debit itself was not modified by this migration', () => {
    assert.ok(!/create or replace function public\.wallet_reverse_debit/i.test(src(FIX)),
      'the migration redefines wallet_reverse_debit; the whole design says it must not');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('the historical Anderson & Co pass', () => {
  before(() => { schema(); installFix(); fixtures(); });

  test('migrates to refund_state none, with no backfill', () => {
    assert.equal(passState(), 'none');
    assert.equal(scalar(`select coalesce(refunded_at::text,'NULL') from public.book_unit_purchases where id='${PASS}';`), 'NULL');
  });

  test('is recognised as unused from the redemption trail', () => {
    assert.equal(num(`select count(*)::text from public.local_redemptions
      where kind='pass' and ref_id='${PASS}' and status='consumed';`), 0);
  });

  test('resolves from the wallet debit by its payment reference', () => {
    assert.equal(scalar(`select source_type from public._business_refund_source('${SPEND}');`), 'pass');
    assert.equal(scalar(`select source_id::text from public._business_refund_source('${SPEND}');`), PASS);
  });

  test('and would be eligible — claimed, then rolled back untouched', () => {
    const o = raw(`begin; select public.business_refund_claim('${SPEND}'); rollback;`);
    assert.match(o, /"outcome"\s*:\s*"claimed"/, o.slice(0, 400));
    assert.equal(passState(), 'none', 'the probe left the pass changed');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('a merchant can see which receipts were refunded', () => {
  before(() => { schema(); installFix(); installReceipts(); fixtures(); });

  test('a live payment reads none, with no refund timestamp', () => {
    const r = receiptFor(SPEND)!;
    assert.ok(r, 'the spend is missing from the receipt list');
    assert.equal(r.refund_state, 'none');
    assert.equal(r.refunded_at, null);
    assert.equal(r.refund_transaction_id, null);
  });

  test('every field the clients already read survives the new columns', () => {
    const r = receiptFor(SPEND)!;
    assert.equal(r.gross_pence, 300);
    assert.equal(r.fee_pence, 15);
    assert.equal(r.cashback_pence, 0);
    assert.equal(r.net_pence, 285);          // 300 − 15 − 0
    assert.equal(r.stripe_transfer_id, 'tr_test');
  });

  test('a real refund flips it, and only it', () => {
    fixtures();
    claim();
    finalise();
    assert.equal(passState(), 'refunded', 'the refund did not complete');

    assert.equal(receiptFor(SPEND)!.refund_state, 'refunded');
    // The shop order was never refunded. One receipt cannot borrow another's.
    assert.equal(receiptFor(OSPEND)!.refund_state, 'none');
    assert.equal(receiptFor(OSPEND)!.refunded_at, null);
  });

  test('refunded_at and the id come from the reversal row itself', () => {
    const r = receiptFor(SPEND)!;
    const revId = scalar(`select id::text from public.local_wallet_transactions
                           where reverses_transaction_id='${SPEND}' and type='refund';`);
    const revAt = scalar(`select created_at::text from public.local_wallet_transactions
                           where reverses_transaction_id='${SPEND}' and type='refund';`);
    assert.equal(r.refund_transaction_id, revId);
    assert.ok(revAt.startsWith(String(r.refunded_at).slice(0, 19).replace('T', ' ')),
      `refunded_at ${r.refunded_at} is not the reversal's ${revAt}`);
  });

  test('the original payment stays in history, unaltered', () => {
    const r = receiptFor(SPEND)!;
    assert.equal(r.gross_pence, 300, 'the historical amount was rewritten');
    assert.equal(r.net_pence, 285);
    assert.equal(receiptsAs(OWNER).length, 2, 'a refund removed a receipt from history');
  });

  test('only a row of type refund counts — a spend pointing back does not', () => {
    fixtures();
    // Same link, wrong type. If the state were read from the link alone, this
    // would report the shop order as refunded without a penny moving.
    const o = raw(`insert into public.local_wallet_transactions
      (id,user_id,business_id,type,amount_pence,reverses_transaction_id,idempotency_key)
      values ('${RED}','${CUST}','${BIZ}','spend',-1,'${OSPEND}','decoy');`);
    assert.doesNotMatch(o, /ERROR/i, o.slice(0, 400));
    assert.equal(receiptFor(OSPEND)!.refund_state, 'none');
  });

  test('the auth rule is unchanged — no caller, no receipts', () => {
    const o = raw(`select set_config('request.jwt.claim.sub','',false);
                   select * from public.get_business_wallet_receipts('${BIZ}'::uuid, 20);`);
    assert.match(o, /auth_required/, o.slice(0, 400));
  });

  test('the ownership rule is unchanged — another user gets nothing', () => {
    const o = raw(`select set_config('request.jwt.claim.sub','${OTHER}',false);
                   select * from public.get_business_wallet_receipts('${BIZ}'::uuid, 20);`);
    assert.match(o, /not_business_owner/, o.slice(0, 400));
  });

  test('ordering is still newest first', () => {
    fixtures();
    const rows = receiptsAs(OWNER);
    const times = rows.map((r) => String(r.created_at));
    assert.deepEqual([...times].sort().reverse(), times, 'receipts are no longer newest first');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('the callers are wired to the guards', () => {
  const fn = (p: string) => src(join(FN, p, 'index.ts'));

  test('wallet-refund-business takes only a transaction id from the client', () => {
    const s = fn('wallet-refund-business');
    assert.match(s, /body\?\.transaction_id/);
    for (const forbidden of ['body.business_id', 'body.source_id', 'body.source_type', 'body.amount_pence']) {
      assert.ok(!s.includes(forbidden), `${forbidden} is trusted from the client`);
    }
  });

  test('it authorises from the ledger row, not from the caller', () => {
    const s = fn('wallet-refund-business');
    assert.match(s, /\.eq\('id', txn\.business_id\)/);
    assert.match(s, /biz\.owner_id === user\.id/);
    assert.match(s, /is_platform_owner/);
  });

  test('it refuses a spend with no business', () => {
    assert.match(fn('wallet-refund-business'), /if \(!txn\.business_id\)/);
  });

  test('it claims before Stripe, and finalises after', () => {
    const s = fn('wallet-refund-business');
    const claimAt = s.indexOf("business_refund_claim");
    const stripeAt = s.indexOf('reverseTransfer(txn.stripe_transfer_id)');
    const finalAt = s.indexOf('business_refund_finalise');
    assert.ok(claimAt > -1 && stripeAt > claimAt && finalAt > stripeAt,
      'the order is not claim → Stripe → finalise');
  });

  test('it never claims clawed_back for a transfer it did not reverse', () => {
    const s = fn('wallet-refund-business');
    assert.match(s, /transferReversed \? 'clawed_back' : 'no_transfer'/);
  });

  test('it refuses an unresolved transfer in words a merchant can act on', () => {
    assert.match(fn('wallet-refund-business'), /state === 'unresolved'/);
  });

  test('it is rate limited', () => {
    assert.match(fn('wallet-refund-business'), /enforceRateLimit\(\s*\n?\s*'wallet-refund-business'/);
  });

  test('local-redeem-start will not mint a code for a refunded pass', () => {
    assert.match(fn('local-redeem-start'), /pass\.refund_state \?\? 'none'\) !== 'none'/);
  });

  test('reminder-runner will not chase a refunded pass', () => {
    assert.match(fn('reminder-runner'), /\.eq\('refund_state', 'none'\)/);
  });

  // The merchant's own view of a refund. The RPC carries the state; these
  // assert both clients actually spend it, because for a while neither could:
  // a refunded payment read as an ordinary one and offered Refund again.
  const WEB = join(REPO_ROOT, '..', 'oneshetland-web');
  const web = (rel: string) => readFileSync(join(WEB, rel), 'utf8');
  const appLib = () => src(join(REPO_ROOT, 'lib/local-api.ts'));
  const appUi = () => src(join(REPO_ROOT, 'app/local-business-dashboard.tsx'));
  const webUi = () => web('components/business/WalletManager.tsx');

  test('the mobile receipt model carries the refund state', () => {
    assert.match(appLib(), /refund_state:\s*'none' \| 'refunded'/,
      'BusinessWalletReceipt cannot express a refunded receipt');
    assert.match(appLib(), /refunded_at:\s*string \| null/);
  });

  test('a refunded mobile receipt says so, and offers nothing to press', () => {
    const s = appUi();
    assert.match(s, /r\.refund_state === 'refunded'/,
      'the dashboard never asks whether a receipt was refunded');
    assert.match(s, /styles\.receiptRefundedText[\s\S]{0,80}Refunded/,
      'no visible Refunded state on the receipt');
    // The Refund action must sit on the other side of that branch, not beside it.
    const branchAt = s.indexOf("r.refund_state === 'refunded'");
    const elseAt = s.indexOf(') : (', branchAt);
    const btnAt = s.indexOf('onPress={() => confirmRefund(r)}', branchAt);
    assert.ok(elseAt > -1 && btnAt > elseAt,
      'the Refund button is still reachable for a refunded receipt');
  });

  test('an ordinary mobile receipt keeps its Refund action', () => {
    assert.match(appUi(), /onPress=\{\(\) => confirmRefund\(r\)\}/,
      'the refund flow was removed from live payments');
  });

  test('a refunded web receipt says so, and offers nothing to press', () => {
    const s = webUi();
    assert.match(s, /r\.refund_state === "refunded"/,
      'WalletManager never asks whether a receipt was refunded');
    assert.match(s, />\s*Refunded\s*</, 'no visible Refunded state on the web receipt');
    const branchAt = s.indexOf('r.refund_state === "refunded"');
    const elseAt = s.indexOf(') : (', branchAt);
    const btnAt = s.indexOf('setConfirm(r)', branchAt);
    assert.ok(elseAt > -1 && btnAt > elseAt,
      'the Refund button is still reachable for a refunded web receipt');
  });

  test('an ordinary web receipt keeps its Refund action', () => {
    assert.match(webUi(), /setConfirm\(r\)/, 'the refund flow was removed from live payments');
  });

  test('the receipts RPC is what tells them — neither client guesses', () => {
    const rpc = src(RECEIPTS);
    assert.match(rpc, /reverses_transaction_id = t\.id/, 'refund state is not derived from the ledger link');
    assert.match(rpc, /r\.type = 'refund'/, 'any reversing row would count, not just a refund');
    assert.match(rpc, /and t\.type\s*= 'spend'/, 'the original spend no longer anchors the receipt');
  });
});
