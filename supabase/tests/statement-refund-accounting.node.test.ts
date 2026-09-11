/**
 * statement-refund-accounting.node.test.ts — a refunded Wallet payment on the
 * merchant's Money & transactions statement.
 *
 * A real £3 Anderson & Co payment was refunded in full — the customer had their
 * £3.00 back and the merchant's £2.85 transfer was reversed — and the statement
 * went on reporting it as earned, because branch 1 of get_business_transactions
 * reads `type = 'spend'` and the reversal is written as its own `type = 'refund'`
 * row. Nothing was wrong with the money. It was never reported.
 *
 * What this proves, in order of how badly it would hurt to get wrong:
 *
 *   · the merchant loses the £2.85 they were credited — not the £3.00 the
 *     customer received, and not the 15p fee they never paid
 *   · the sale stays in the month it was earned; the refund lands in the month
 *     the money went back, and neither moves the other
 *   · one merchant's refund can never surface on another merchant's statement,
 *     and a second reversal row cannot double-count
 *   · every pre-existing statement type still reports exactly as before
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
const STATEMENT = join(MIG, '20261010120000_statement_one_event_one_row.sql');

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

const OWNER  = 'b0000000-0000-4000-8000-00000000000b';
const OTHER  = 'a0000000-0000-4000-8000-00000000000a';
const CUST   = 'c0000000-0000-4000-8000-00000000000c';
const BIZ    = 'd0000000-0000-4000-8000-00000000000d';
const BIZ2   = 'd0000000-0000-4000-8000-00000000000e';
const SPEND  = '22220000-0000-4000-8000-000000000022';
const REFUND = '33330000-0000-4000-8000-000000000033';
const AUGUST = '44440000-0000-4000-8000-000000000044';
const AUGREF = '55550000-0000-4000-8000-000000000055';

/** Real tables, then the statement function under test. */
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
    // Supabase's auth.uid(), faithfully: the subject claim of the caller's JWT.
    `create or replace function auth.uid() returns uuid language sql stable as $$
       select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;`,
    'create table public.profiles (id uuid primary key, full_name text, display_name text);',
    createTable(BASELINE, 'CREATE TABLE public.local_businesses ('),
    'alter table public.local_businesses add primary key (id);',
    createTable(BASELINE, 'CREATE TABLE public.local_wallet_transactions ('),
    'alter table public.local_wallet_transactions add primary key (id);',
    `alter table public.local_wallet_transactions
       add column idempotency_key text,
       add column transfer_state text,
       add column reverses_transaction_id uuid references public.local_wallet_transactions(id);`,
    `create unique index local_wallet_transactions_idempotency_key
       on public.local_wallet_transactions (idempotency_key) where idempotency_key is not null;`,
    // Every other branch of the statement, so "nothing else changed" is measured
    // against the real tables rather than an absence.
    createTable(BASELINE, 'CREATE TABLE public.book_unit_items ('),
    createTable(BASELINE, 'CREATE TABLE public.book_unit_purchases ('),
    createTable(BASELINE, 'CREATE TABLE public.book_gifts ('),
    createTable(BASELINE, 'CREATE TABLE public.book_services ('),
    createTable(BASELINE, 'CREATE TABLE public.book_bookings ('),
    createTable(BASELINE, 'CREATE TABLE public.events ('),
    createTable(BASELINE, 'CREATE TABLE public.event_ticket_orders ('),
    createTable(BASELINE, 'CREATE TABLE public.local_boost_purchases ('),
    createTable(COMMERCE, 'create table if not exists public.products ('),
    createTable(COMMERCE, 'create table if not exists public.product_variants ('),
    createTable(COMMERCE, 'create table if not exists public.product_orders ('),
    createTable(COMMERCE, 'create table if not exists public.product_order_items ('),
    'grant usage on schema public, auth to anon, authenticated, service_role;',
    'grant execute on function auth.uid() to anon, authenticated, service_role;',
    src(STATEMENT),
  ].join('\n'));
  assert.doesNotMatch(out, /ERROR/i, `schema failed:\n${out.slice(0, 1600)}`);
}

/** Two businesses, a September sale that was refunded, and an August pair. */
function fixtures() {
  const o = raw(`
    delete from public.local_wallet_transactions;
    delete from public.local_businesses;
    delete from public.profiles;
    delete from auth.users;
    insert into auth.users(id) values ('${OWNER}'),('${CUST}'),('${OTHER}');
    insert into public.profiles(id, full_name) values ('${OWNER}','Owner One'),('${CUST}','Darren Fullerton'),('${OTHER}','Other Owner');
    insert into public.local_businesses (id, owner_id, name, category, address)
      values ('${BIZ}','${OWNER}','Anderson & Co','retail','Lerwick'),
             ('${BIZ2}','${OTHER}','Someone Else','retail','Scalloway');

    -- The September sale: £3.00 gross, 15p fee, £2.85 to the merchant.
    insert into public.local_wallet_transactions
      (id,user_id,business_id,type,amount_pence,platform_fee_pence,cashback_pence,description,idempotency_key,transfer_state,stripe_transfer_id,created_at)
      values ('${SPEND}','${CUST}','${BIZ}','spend',-300,15,0,'DEMO — 3 Session Pass','wallet-attempt:one','sent','tr_test','2026-09-06 21:19:12+00');

    -- An August sale of £10.00 with a 50p fee, refunded in September, so the
    -- month boundary is a real one rather than a same-period convenience.
    insert into public.local_wallet_transactions
      (id,user_id,business_id,type,amount_pence,platform_fee_pence,cashback_pence,description,idempotency_key,transfer_state,stripe_transfer_id,created_at)
      values ('${AUGUST}','${CUST}','${BIZ}','spend',-1000,50,0,'August pass','wallet-attempt:aug','sent','tr_aug','2026-08-14 10:00:00+00');
  `);
  assert.doesNotMatch(o, /ERROR/i, `fixtures failed:\n${o.slice(0, 1200)}`);
}

const refundSept = () => raw(`insert into public.local_wallet_transactions
  (id,user_id,business_id,type,amount_pence,reverses_transaction_id,idempotency_key,created_at)
  values ('${REFUND}','${CUST}','${BIZ}','refund',300,'${SPEND}','wallet-attempt:one:reversal','2026-09-09 11:23:49+00');`);
const refundAugustSaleInSeptember = () => raw(`insert into public.local_wallet_transactions
  (id,user_id,business_id,type,amount_pence,reverses_transaction_id,idempotency_key,created_at)
  values ('${AUGREF}','${CUST}','${BIZ}','refund',1000,'${AUGUST}','wallet-attempt:aug:reversal','2026-09-02 09:00:00+00');`);

interface Row {
  occurred_at: string; direction: string; kind: string; description: string; counterparty: string;
  gross_pence: number; fee_pence: number; cashback_pence: number; net_pence: number;
  status: string; reference: string | null;
}
function statement(from: string | null, to: string | null, biz = BIZ, uid = OWNER): Row[] {
  const f = from ? `'${from}'::timestamptz` : 'null';
  const t = to ? `'${to}'::timestamptz` : 'null';
  const out = raw(`select set_config('request.jwt.claim.sub','${uid}',false);
    select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)::text
      from public.get_business_transactions('${biz}'::uuid, ${f}, ${t}, 5000) x;`);
  const line = value(out);
  assert.match(line, /^\[/, `statement did not return JSON:\n${out.slice(0, 700)}`);
  return JSON.parse(line) as Row[];
}

/** The four figures the merchant actually reads, summed exactly as both clients sum them. */
function totals(rows: Row[]) {
  let moneyIn = 0, refunds = 0, fees = 0, cashback = 0, netIn = 0, costsOut = 0;
  for (const r of rows) {
    if (r.direction === 'in') { moneyIn += r.gross_pence; fees += r.fee_pence; cashback += r.cashback_pence; netIn += r.net_pence; }
    else if (r.direction === 'refund') { refunds += Math.abs(r.gross_pence); fees += r.fee_pence; cashback += r.cashback_pence; netIn += r.net_pence; }
    else costsOut += r.gross_pence;
  }
  return { moneyIn, refunds, fees, cashback, net: netIn - costsOut };
}

const SEPT = '2026-09-01T00:00:00Z';
const OCT  = '2026-10-01T00:00:00Z';
const AUG  = '2026-08-01T00:00:00Z';

before(() => {
  assert.ok(DSN, 'PASS_PROOF_DSN is required — run via `npm run test:isolated`');
  assert.ok(!/supabase/i.test(DSN), 'refusing to run against anything that looks like Supabase');
});

// ───────────────────────────────────────────────────────────────────────────
describe('a Wallet sale that was never refunded', () => {
  before(() => { schema(); fixtures(); });

  test('reports as earned, with its fee and its net', () => {
    const rows = statement(SEPT, OCT);
    const sale = rows.find((r) => r.kind === 'wallet_payment')!;
    assert.ok(sale, 'the sale is missing from the statement');
    assert.equal(sale.direction, 'in');
    assert.equal(sale.gross_pence, 300);
    assert.equal(sale.fee_pence, 15);
    assert.equal(sale.net_pence, 285);
  });

  test('and no refund row exists for it', () => {
    assert.equal(statement(SEPT, OCT).filter((r) => r.direction === 'refund').length, 0);
  });

  test('the totals are the ones the merchant sees today', () => {
    const t = totals(statement(SEPT, OCT));
    assert.deepEqual(t, { moneyIn: 300, refunds: 0, fees: 15, cashback: 0, net: 285 });
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('a Wallet sale refunded in full', () => {
  before(() => { schema(); fixtures(); refundSept(); });

  test('the original sale is still there, unrewritten', () => {
    const sale = statement(SEPT, OCT).find((r) => r.kind === 'wallet_payment')!;
    assert.equal(sale.gross_pence, 300, 'the historical sale was rewritten');
    assert.equal(sale.fee_pence, 15);
    assert.equal(sale.net_pence, 285);
  });

  test('a separate refund row appears, on the date the money went back', () => {
    const ref = statement(SEPT, OCT).find((r) => r.direction === 'refund')!;
    assert.ok(ref, 'no refund row on the statement');
    assert.equal(ref.kind, 'wallet_refund');
    assert.match(ref.occurred_at, /^2026-09-09/, 'the refund did not take the refund date');
    assert.equal(ref.counterparty, 'Darren Fullerton');
    assert.equal(ref.reference, SPEND, 'the refund does not name the sale it reverses');
  });

  test('the merchant loses the 285 they were credited — not the 300, not the fee', () => {
    const ref = statement(SEPT, OCT).find((r) => r.direction === 'refund')!;
    assert.equal(ref.gross_pence, -300, 'gross refund is not the mirror of the sale');
    assert.equal(ref.fee_pence, -15, 'the platform fee was not reversed');
    assert.equal(ref.net_pence, -285, 'the merchant net reversal is wrong');
  });

  test('the pair nets to exactly nothing', () => {
    const rows = statement(SEPT, OCT).filter((r) => r.kind === 'wallet_payment' || r.kind === 'wallet_refund');
    assert.equal(rows.reduce((s, r) => s + r.gross_pence, 0), 0, 'customer gross does not net to 0');
    assert.equal(rows.reduce((s, r) => s + r.fee_pence, 0), 0, 'platform fee does not net to 0');
    assert.equal(rows.reduce((s, r) => s + r.net_pence, 0), 0, 'merchant net does not net to 0');
  });

  test('the summary reconciles, and the invariant holds', () => {
    const t = totals(statement(SEPT, OCT));
    assert.deepEqual(t, { moneyIn: 300, refunds: 300, fees: 0, cashback: 0, net: 0 });
    assert.equal(t.moneyIn - t.refunds - t.fees - t.cashback, t.net,
      'Net to you is not Money in − Refunds − Fees − Cashback');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('a sale in one month, refunded in the next', () => {
  before(() => { schema(); fixtures(); refundAugustSaleInSeptember(); });

  test('August keeps what August earned', () => {
    const t = totals(statement(AUG, SEPT));
    assert.deepEqual(t, { moneyIn: 1000, refunds: 0, fees: 50, cashback: 0, net: 950 },
      'the refund retrospectively rewrote the month the sale was earned in');
  });

  test('September carries the refund, and only the refund', () => {
    const rows = statement(SEPT, OCT);
    assert.equal(rows.filter((r) => r.reference === AUGUST && r.direction === 'refund').length, 1);
    assert.equal(rows.filter((r) => r.kind === 'wallet_payment' && r.gross_pence === 1000).length, 0,
      'the August sale leaked into September');
  });

  test('the refund does not disappear from a later period', () => {
    // September also holds its own unrefunded £3 sale, so the period figures are
    // the sale plus the August reversal — stated as that arithmetic rather than
    // pretending the month contains only one event.
    const t = totals(statement(SEPT, OCT));
    assert.equal(t.refunds, 1000, 'the August refund vanished from September');
    assert.equal(t.fees, 15 - 50, 'the fee reversal was lost');
    assert.equal(t.net, 285 - 950, 'the merchant net reversal was lost');
  });

  test('across both months the refunded pair cancels and the rest survives', () => {
    // £10 sale + £3 sale in, £10 refunded out. What is left is exactly the sale
    // nobody refunded — the reversal cancels its own sale and nothing else.
    const t = totals(statement(AUG, OCT));
    assert.equal(t.moneyIn, 1300);
    assert.equal(t.refunds, 1000);
    assert.equal(t.moneyIn - t.refunds, 300, 'the surviving sale is wrong');
    assert.equal(t.fees, 15, 'the untouched sale lost its fee, or a reversed fee lingered');
    assert.equal(t.net, 285, 'the merchant kept or lost more than the one live sale');
    assert.equal(t.moneyIn - t.refunds - t.fees - t.cashback, t.net);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('a refund cannot reach where it does not belong', () => {
  before(() => { schema(); fixtures(); refundSept(); });

  test("another merchant's statement is untouched", () => {
    assert.equal(statement(SEPT, OCT, BIZ2, OTHER).length, 0,
      "one business's refund surfaced on another's statement");
  });

  test('a refund pointing at a row that is not a spend is ignored', () => {
    const o = raw(`insert into public.local_wallet_transactions
      (id,user_id,business_id,type,amount_pence,reverses_transaction_id,idempotency_key,created_at)
      values ('66660000-0000-4000-8000-000000000066','${CUST}','${BIZ}','refund',100,'${REFUND}','decoy','2026-09-10 09:00:00+00');`);
    assert.doesNotMatch(o, /ERROR/i, o.slice(0, 300));
    assert.equal(statement(SEPT, OCT).filter((r) => r.direction === 'refund').length, 1,
      'a reversal of a reversal was counted as a refund');
  });

  test('the ledger cannot hold a second reversal of the same sale', () => {
    // The derived idempotency key is UNIQUE, which is what stops a replayed
    // refund being counted twice on the statement.
    const o = raw(`insert into public.local_wallet_transactions
      (id,user_id,business_id,type,amount_pence,reverses_transaction_id,idempotency_key,created_at)
      values ('77770000-0000-4000-8000-000000000077','${CUST}','${BIZ}','refund',300,'${SPEND}','wallet-attempt:one:reversal','2026-09-09 12:00:00+00');`);
    assert.match(o, /duplicate key|unique/i, 'a replayed reversal was accepted');
    assert.equal(totals(statement(SEPT, OCT)).refunds, 300, 'the refund was double-counted');
  });

  test('the ownership rule still guards the whole statement', () => {
    const o = raw(`select set_config('request.jwt.claim.sub','${OTHER}',false);
                   select count(*) from public.get_business_transactions('${BIZ}'::uuid, null, null, 100);`);
    assert.match(o, /Not your business/i, o.slice(0, 300));
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('cashback is reversed exactly as the money was', () => {
  before(() => { schema(); fixtures(); });

  test('a business-funded cashback sale reverses gross, fee AND cashback', () => {
    // wallet_reverse_debit returns abs(amount) - cashback to the customer, and
    // the merchant's transfer of gross - fee - cashback is clawed back whole,
    // so the merchant's cashback contribution unwinds with everything else.
    raw(`insert into public.local_wallet_transactions
      (id,user_id,business_id,type,amount_pence,platform_fee_pence,cashback_pence,idempotency_key,transfer_state,created_at)
      values ('88880000-0000-4000-8000-000000000088','${CUST}','${BIZ}','spend',-500,25,50,'cb','sent','2026-09-07 10:00:00+00');
      insert into public.local_wallet_transactions
      (id,user_id,business_id,type,amount_pence,reverses_transaction_id,idempotency_key,created_at)
      values ('99990000-0000-4000-8000-000000000099','${CUST}','${BIZ}','refund',450,'88880000-0000-4000-8000-000000000088','cb:reversal','2026-09-08 10:00:00+00');`);
    const ref = statement(SEPT, OCT).find((r) => r.reference === '88880000-0000-4000-8000-000000000088')!;
    assert.equal(ref.gross_pence, -500, 'gross refund must mirror the sale, not the cash returned');
    assert.equal(ref.fee_pence, -25);
    assert.equal(ref.cashback_pence, -50, 'the funded cashback was not reversed');
    assert.equal(ref.net_pence, -425, 'net reversal must be -(gross - fee - cashback)');
  });

  test('and that pair also nets to nothing', () => {
    // The RPC labels every wallet sale 'Wallet payment', so the pair is picked
    // out by its amounts: the £5 sale and the reversal that names it.
    const rows = statement(SEPT, OCT).filter((r) =>
      r.reference === '88880000-0000-4000-8000-000000000088'
      || (r.direction === 'in' && r.gross_pence === 500));
    assert.equal(rows.length, 2, 'the cashback sale and its reversal were not both found');
    assert.equal(rows.reduce((s, r) => s + r.gross_pence, 0), 0);
    assert.equal(rows.reduce((s, r) => s + r.fee_pence, 0), 0);
    assert.equal(rows.reduce((s, r) => s + r.cashback_pence, 0), 0);
    assert.equal(rows.reduce((s, r) => s + r.net_pence, 0), 0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('a shop order paid from the Wallet is reported once, not twice', () => {
  // A wallet-funded order writes a wallet spend AND a product_orders row. Both
  // branches used to emit it, so the merchant's income was counted twice.
  const CARD_ORDER   = 'aaaa0000-0000-4000-8000-00000000aaaa';
  const WALLET_ORDER = 'bbbb0000-0000-4000-8000-00000000bbbb';
  const WSPEND       = 'cccc0000-0000-4000-8000-00000000cccc';
  const WREFUND      = 'eeee0000-0000-4000-8000-00000000eeee';

  function orders() {
    const o = raw(`
      delete from public.product_orders;
      -- Card-funded: no wallet row, a real payment intent.
      insert into public.product_orders (id, business_id, buyer_id, status, fulfilment,
        items_pence, shipping_pence, total_pence, commission_pence, paid_via, paid_at, payment_intent_id)
        values ('${CARD_ORDER}','${BIZ}','${CUST}','paid','collect',2000,0,2000,100,'card','2026-09-04 10:00:00+00','pi_card');
      -- Wallet-funded: the ledger row carries the id-based key, and the order
      -- carries no payment intent, exactly as create-product-order-intent writes it.
      insert into public.product_orders (id, business_id, buyer_id, status, fulfilment,
        items_pence, shipping_pence, total_pence, commission_pence, paid_via, paid_at)
        values ('${WALLET_ORDER}','${BIZ}','${CUST}','paid','collect',5000,0,5000,250,'wallet','2026-09-05 10:00:00+00');
      insert into public.local_wallet_transactions
        (id,user_id,business_id,type,amount_pence,platform_fee_pence,cashback_pence,idempotency_key,transfer_state,created_at)
        values ('${WSPEND}','${CUST}','${BIZ}','spend',-5000,250,0,'product-order-${WALLET_ORDER}','sent','2026-09-05 10:00:00+00');
    `);
    assert.doesNotMatch(o, /ERROR/i, o.slice(0, 600));
  }

  before(() => { schema(); fixtures(); orders(); });

  test('a card-funded shop order still appears, exactly once', () => {
    const rows = statement(SEPT, OCT).filter((r) => r.reference === 'pi_card');
    assert.equal(rows.length, 1, 'the card order was lost or duplicated');
    assert.equal(rows[0].kind, 'product_sale');
    assert.equal(rows[0].gross_pence, 2000);
    assert.equal(rows[0].fee_pence, 100);
    assert.equal(rows[0].net_pence, 1900);
  });

  test('a wallet-funded shop order appears exactly once', () => {
    const rows = statement(SEPT, OCT).filter((r) => r.gross_pence === 5000 && r.direction === 'in');
    assert.equal(rows.length, 1, 'the wallet-paid order was counted twice');
  });

  test('and it is reported from the ledger, wearing the order it paid for', () => {
    const row = statement(SEPT, OCT).find((r) => r.gross_pence === 5000 && r.direction === 'in')!;
    assert.equal(row.kind, 'product_sale', 'the merchant cannot tell it was a shop order');
    assert.equal(row.description, 'Shop order');
    assert.equal(row.reference, WALLET_ORDER, 'the order reference was lost');
    assert.equal(row.fee_pence, 250);
    assert.equal(row.net_pence, 4750);
  });

  test('the totals do not double-count it', () => {
    const t = totals(statement(SEPT, OCT));
    // £3 wallet sale + £20 card order + £50 wallet order.
    assert.equal(t.moneyIn, 300 + 2000 + 5000, 'a sale was counted twice, or lost');
    assert.equal(t.fees, 15 + 100 + 250);
    assert.equal(t.net, 285 + 1900 + 4750);
    assert.equal(t.moneyIn - t.refunds - t.fees - t.cashback, t.net);
  });

  test('an ordinary Wallet payment is untouched by the change', () => {
    const row = statement(SEPT, OCT).find((r) => r.gross_pence === 300 && r.direction === 'in')!;
    assert.equal(row.kind, 'wallet_payment');
    assert.equal(row.description, 'Wallet payment');
    assert.equal(row.reference, 'tr_test', 'a plain wallet payment lost its transfer reference');
  });

  test('refunded, it is one sale and one reversal — never four rows', () => {
    // The real rail: business_refund_finalise credits the wallet AND marks the
    // order refunded. Branch 6 would drop the sale from history; branch 1 keeps
    // it, and branch 8 mirrors it.
    const o = raw(`
      insert into public.local_wallet_transactions
        (id,user_id,business_id,type,amount_pence,reverses_transaction_id,idempotency_key,created_at)
        values ('${WREFUND}','${CUST}','${BIZ}','refund',5000,'${WSPEND}','product-order-${WALLET_ORDER}:reversal','2026-09-20 09:00:00+00');
      update public.product_orders set status='refunded' where id='${WALLET_ORDER}';`);
    assert.doesNotMatch(o, /ERROR/i, o.slice(0, 400));

    const rows = statement(SEPT, OCT);
    const sales = rows.filter((r) => r.direction === 'in' && r.gross_pence === 5000);
    const refs  = rows.filter((r) => r.direction === 'refund' && r.reference === WSPEND);
    assert.equal(sales.length, 1, 'the refunded order lost or duplicated its sale');
    assert.equal(refs.length, 1, 'the reversal is missing or duplicated');
    assert.equal(refs[0].gross_pence, -5000);
    assert.equal(refs[0].fee_pence, -250);
    assert.equal(refs[0].net_pence, -4750);
  });

  test('and that pair nets to zero, leaving the other sales untouched', () => {
    const t = totals(statement(SEPT, OCT));
    assert.equal(t.moneyIn, 300 + 2000 + 5000, 'the refund rewrote the sale');
    assert.equal(t.refunds, 5000);
    assert.equal(t.fees, 15 + 100, 'the order fee did not reverse cleanly');
    assert.equal(t.net, 285 + 1900, 'the merchant kept or lost more than the order was worth');
    assert.equal(t.moneyIn - t.refunds - t.fees - t.cashback, t.net);
  });

  test('CSV sees the same single row the screen totals', () => {
    // Both clients build CSV from these rows verbatim, so one row on the screen
    // is one line in the file.
    const rows = statement(SEPT, OCT);
    const forOrder = rows.filter((r) => r.reference === WALLET_ORDER || r.reference === WSPEND);
    assert.equal(forOrder.length, 2, 'the order exports as more or fewer than sale + refund');
    assert.deepEqual(forOrder.map((r) => r.direction).sort(), ['in', 'refund']);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('one commercial event, one statement row', () => {
  // Every rail that can be paid from the Wallet writes BOTH a wallet spend and
  // its own domain row. Anderson's live statement showed a £3 pass twice.
  const PASSW = '10000000-0000-4000-8000-000000000001';  const PASSC = '10000000-0000-4000-8000-000000000002';
  const GIFTW = '20000000-0000-4000-8000-000000000001';  const GIFTC = '20000000-0000-4000-8000-000000000002';
  const TIXW  = '30000000-0000-4000-8000-000000000001';  const TIXC  = '30000000-0000-4000-8000-000000000002';
  const EVT   = '30000000-0000-4000-8000-0000000000ee';
  const ITEM  = '10000000-0000-4000-8000-0000000000ii'.replace(/i/g, '9');
  const SW = '40000000-0000-4000-8000-000000000001';   // spend funding the pass
  const SG = '40000000-0000-4000-8000-000000000002';   // spend funding the gift
  const ST = '40000000-0000-4000-8000-000000000003';   // spend funding the tickets
  const SD = '40000000-0000-4000-8000-000000000004';   // a direct wallet payment
  const RW = '50000000-0000-4000-8000-000000000001';   // refund of the pass spend

  function rails() {
    const spend = (id: string, amt: number, fee: number, key: string, at: string) =>
      `insert into public.local_wallet_transactions
         (id,user_id,business_id,type,amount_pence,platform_fee_pence,cashback_pence,idempotency_key,transfer_state,stripe_transfer_id,created_at)
         values ('${id}','${CUST}','${BIZ}','spend',-${amt},${fee},0,'${key}','sent','tr_${key}','${at}');`;
    const o = raw(`
      delete from public.book_unit_purchases; delete from public.book_unit_items;
      delete from public.book_gifts; delete from public.event_ticket_orders; delete from public.events;
      insert into public.book_unit_items (id, business_id, name, price_pence, uses_per_purchase)
        values ('${ITEM}','${BIZ}','DEMO — 3 Session Pass',300,3);
      insert into public.events (id, organiser_business_id, title, starts_at)
        values ('${EVT}','${BIZ}','Launch Test Event','2026-09-20 19:00:00+00');

      ${spend(SW, 300, 15, 'wallet-attempt:pass', '2026-09-06 10:00:00+00')}
      ${spend(SG, 500, 25, 'wallet-attempt:gift', '2026-09-06 11:00:00+00')}
      ${spend(ST, 800, 40, 'wallet-attempt:tix',  '2026-09-06 12:00:00+00')}
      ${spend(SD, 900, 45, 'wallet-attempt:direct','2026-09-06 13:00:00+00')}

      -- Wallet-funded, stamped by the writer as wallet_<txid>.
      insert into public.book_unit_purchases (id,item_id,business_id,owner_id,paid_amount_pence,uses_remaining,payment_intent_id)
        values ('${PASSW}','${ITEM}','${BIZ}','${CUST}',300,3,'wallet_${SW}');
      insert into public.book_gifts (id,business_id,purchaser_id,recipient_email,price_paid_pence,status,code,kind,unit_item_id,payment_intent_id,created_at)
        values ('${GIFTW}','${BIZ}','${CUST}','a@example.com',500,'sent','GIFTW','unit','${ITEM}','wallet_${SG}','2026-09-06 11:00:00+00');
      insert into public.event_ticket_orders (id,event_id,buyer_id,status,total_pence,platform_fee_pence,stripe_payment_intent_id,paid_at)
        values ('${TIXW}','${EVT}','${CUST}','paid',800,40,'wallet_${ST}','2026-09-06 12:00:00+00');

      -- Card-funded equivalents, which must be untouched.
      insert into public.book_unit_purchases (id,item_id,business_id,owner_id,paid_amount_pence,uses_remaining,payment_intent_id,created_at)
        values ('${PASSC}','${ITEM}','${BIZ}','${CUST}',300,3,'pi_card_pass','2026-09-07 10:00:00+00');
      insert into public.book_gifts (id,business_id,purchaser_id,recipient_email,price_paid_pence,status,code,kind,unit_item_id,payment_intent_id,created_at)
        values ('${GIFTC}','${BIZ}','${CUST}','a@example.com',500,'sent','GIFTC','unit','${ITEM}','pi_card_gift','2026-09-07 11:00:00+00');
      insert into public.event_ticket_orders (id,event_id,buyer_id,status,total_pence,platform_fee_pence,stripe_payment_intent_id,paid_at)
        values ('${TIXC}','${EVT}','${CUST}','paid',800,40,'pi_card_tix','2026-09-07 12:00:00+00');
    `);
    assert.doesNotMatch(o, /ERROR/i, o.slice(0, 800));
  }

  before(() => { schema(); fixtures(); rails(); });

  const rowsFor = (kind: string) => statement(SEPT, OCT).filter((r) => r.kind === kind && r.direction === 'in');

  test('a wallet-funded pass appears once, from the ledger', () => {
    const rows = rowsFor('pass_sale').filter((r) => r.gross_pence === 300 && r.fee_pence === 15);
    assert.equal(rows.length, 1, 'the wallet pass was counted twice, or lost');
    assert.equal(rows[0].description, 'DEMO — 3 Session Pass', 'it lost the item it bought');
    assert.equal(rows[0].reference, PASSW, 'it lost the purchase reference');
    assert.equal(rows[0].net_pence, 285, 'the pass branch would have claimed 300');
  });

  test('a card-funded pass still appears once, unchanged', () => {
    const rows = rowsFor('pass_sale').filter((r) => r.reference === 'pi_card_pass');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].gross_pence, 300);
    assert.equal(rows[0].net_pence, 300, 'a card pass carries no wallet fee');
  });

  test('a wallet-funded gift appears once, from the ledger', () => {
    const rows = rowsFor('gift_sale').filter((r) => r.fee_pence === 25);
    assert.equal(rows.length, 1, 'the wallet gift was counted twice, or lost');
    assert.equal(rows[0].gross_pence, 500);
    assert.equal(rows[0].net_pence, 475);
  });

  test('a card-funded gift still appears once', () => {
    assert.equal(rowsFor('gift_sale').filter((r) => r.reference === 'GIFTC').length, 1);
  });

  test('a wallet-funded event ticket appears once, from the ledger', () => {
    const rows = rowsFor('ticket_sale').filter((r) => r.reference === TIXW);
    assert.equal(rows.length, 1, 'the wallet ticket order was counted twice, or lost');
    assert.equal(rows[0].gross_pence, 800);
    assert.equal(rows[0].fee_pence, 40);
    assert.equal(rows[0].net_pence, 760);
  });

  test('a card-funded event ticket still appears once', () => {
    assert.equal(rowsFor('ticket_sale').filter((r) => r.reference === 'pi_card_tix').length, 1);
  });

  test('a Wallet payment that bought nothing else stays a Wallet payment', () => {
    const rows = rowsFor('wallet_payment');
    assert.equal(rows.length, 2, 'the direct payments were relabelled or lost');
    assert.ok(rows.every((r) => r.description === 'Wallet payment'));
  });

  test('no commercial event is emitted twice', () => {
    const rows = statement(SEPT, OCT).filter((r) => r.direction === 'in');
    const refs = rows.map((r) => r.reference);
    assert.equal(refs.length, new Set(refs).size, `a reference appears twice: ${refs.join(', ')}`);
  });

  test('the totals count each sale once', () => {
    const t = totals(statement(SEPT, OCT));
    // 4 wallet spends (300+500+800+900) + 3 card sales (300+500+800), and the
    // September fixture sale of 300.
    assert.equal(t.moneyIn, 300 + 500 + 800 + 900 + 300 + 500 + 800 + 300);
    assert.equal(t.moneyIn - t.refunds - t.fees - t.cashback, t.net);
  });

  test('a refunded wallet pass is one sale and one refund, netting to zero', () => {
    const o = raw(`insert into public.local_wallet_transactions
      (id,user_id,business_id,type,amount_pence,reverses_transaction_id,idempotency_key,created_at)
      values ('${RW}','${CUST}','${BIZ}','refund',300,'${SW}','wallet-attempt:pass:reversal','2026-09-11 09:00:00+00');`);
    assert.doesNotMatch(o, /ERROR/i, o.slice(0, 400));
    const rows = statement(SEPT, OCT);
    const sale = rows.filter((r) => r.reference === PASSW && r.direction === 'in');
    const ref  = rows.filter((r) => r.reference === SW && r.direction === 'refund');
    assert.equal(sale.length, 1, 'the refunded pass lost or duplicated its sale');
    assert.equal(ref.length, 1, 'the reversal is missing or duplicated');
    assert.equal(sale[0].gross_pence + ref[0].gross_pence, 0);
    assert.equal(sale[0].fee_pence + ref[0].fee_pence, 0, 'the fee did not net to zero');
    assert.equal(sale[0].net_pence + ref[0].net_pence, 0, 'the merchant net did not net to zero');
  });

  test('date filtering still places each row in its own period', () => {
    assert.equal(statement(AUG, SEPT).filter((r) => r.reference === PASSW).length, 0,
      'a September sale leaked into August');
    assert.equal(statement(SEPT, OCT).filter((r) => r.reference === PASSW).length, 1);
  });

  test('CSV carries one line per commercial event', () => {
    // Both clients build CSV from these rows verbatim.
    const rows = statement(SEPT, OCT).filter((r) => r.direction === 'in');
    const refs = rows.map((r) => r.reference);
    assert.equal(refs.length, new Set(refs).size, 'CSV would repeat a commercial event');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('the rest of the statement is exactly as it was', () => {
  before(() => { schema(); fixtures(); refundSept(); });

  test('every pre-existing kind is still produced by the function', () => {
    const fn = src(STATEMENT);
    for (const kind of ['wallet_payment', 'pass_sale', 'gift_sale', 'booking_deposit',
                        'ticket_sale', 'product_sale', 'boost']) {
      assert.ok(fn.includes(`'${kind}'`), `statement kind lost: ${kind}`);
    }
  });

  test('the statement still has eight branches, and the funding lookup four arms', () => {
    // 7 top-level UNION ALLs join the 8 statement branches; the funding lateral
    // adds 3 more of its own for the four rails a Wallet payment can buy.
    const fn = src(STATEMENT);
    assert.equal((fn.match(/UNION ALL/g) ?? []).length, 10);
    const lateral = fn.slice(fn.indexOf('LEFT JOIN LATERAL ('), fn.indexOf(') funded ON true'));
    assert.equal((lateral.match(/UNION ALL/g) ?? []).length, 3, 'the funding lookup lost or gained a rail');
    for (const kind of ['product_sale', 'pass_sale', 'gift_sale', 'ticket_sale']) {
      assert.ok(lateral.includes(`'${kind}'`), `the funding lookup cannot recognise ${kind}`);
    }
  });

  test('bookings and boosts keep their branches — they have no Wallet rail', () => {
    const fn = src(STATEMENT);
    assert.ok(fn.includes("'booking_deposit'") && fn.includes("'boost'"));
    const lateral = fn.slice(fn.indexOf('LEFT JOIN LATERAL ('), fn.indexOf(') funded ON true'));
    assert.ok(!lateral.includes('book_bookings') && !lateral.includes('local_boost_purchases'),
      'a rail with no Wallet path was added to the funding lookup');
  });

  test('the sale branch still anchors on a spend', () => {
    assert.match(src(STATEMENT), /t\.type = 'spend'/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('the exported CSV survives a spreadsheet', () => {
  // Darren's export came out as mojibake. The data was always valid UTF-8 and
  // every row had its 11 columns — the file simply carried no byte-order mark,
  // so Excel guessed the encoding and mangled the em dash and the × sign.
  const appSrc = () => src(join(REPO_ROOT, 'app/local-business-transactions.tsx'));
  const webSrc = () => readFileSync(join(REPO_ROOT, '..', 'oneshetland-web',
    'components/business/TransactionsLedger.tsx'), 'utf8');

  /** The escape function as actually shipped, lifted out of the source and run. */
  function escaper(source: string, which: string): (v: string) => string {
    const m = source.match(/const esc = \(v: string\) => (.*);\n/);
    assert.ok(m, which + ' no longer has a single-expression esc()');
    return new Function('v', 'return ' + m![1] + ';') as (v: string) => string;
  }
  const clients = () => [
    ['mobile', appSrc(), escaper(appSrc(), 'mobile')] as const,
    ['web', webSrc(), escaper(webSrc(), 'web')] as const,
  ];

  const DQ = String.fromCharCode(34);

  test('both exports begin with the UTF-8 BOM', () => {
    for (const [name, source] of clients()) {
      assert.match(source, /['"]\\uFEFF['"] \+ \[head\.join/, name + ' CSV does not start with U+FEFF');
    }
    // And that mark really is EF BB BF once encoded.
    assert.deepEqual([...Buffer.from('﻿' + 'Date,Type', 'utf8').subarray(0, 3)],
      [0xEF, 0xBB, 0xBF]);
  });

  test('an em dash round-trips untouched', () => {
    const v = 'DEMO — 3 Session Pass';
    for (const [name, , esc] of clients()) {
      assert.equal(esc(v), v, name + ' altered an em dash');
      assert.equal(Buffer.from(esc(v), 'utf8').toString('utf8'), v, name + ' lost bytes');
    }
  });

  test('a multiplication sign round-trips untouched', () => {
    const v = '1× DEMO — Launch Test Product';
    for (const [name, , esc] of clients()) {
      assert.equal(esc(v), v, name + ' altered the × sign');
      assert.equal(Buffer.from(esc(v), 'utf8').toString('utf8'), v);
    }
  });

  test('a value containing a comma is quoted', () => {
    for (const [name, , esc] of clients()) {
      assert.equal(esc('Gansey, large'), DQ + 'Gansey, large' + DQ, name + ' would split a row');
    }
  });

  test('a value containing a quote is escaped by doubling', () => {
    const input = 'He said ' + DQ + 'hello' + DQ;
    const want = DQ + 'He said ' + DQ + DQ + 'hello' + DQ + DQ + DQ;
    for (const [name, , esc] of clients()) {
      assert.equal(esc(input), want, name + ' quote escaping is wrong');
    }
  });

  test('values containing CR or LF are quoted', () => {
    for (const [name, , esc] of clients()) {
      assert.equal(esc('one\ntwo'), DQ + 'one\ntwo' + DQ, name + ' would split on LF');
      assert.equal(esc('one\rtwo'), DQ + 'one\rtwo' + DQ, name + ' would split on CR');
      assert.equal(esc('a\r\nb'), DQ + 'a\r\nb' + DQ, name + ' would split on CRLF');
    }
  });

  test('an ordinary value is left alone', () => {
    for (const [name, , esc] of clients()) {
      assert.equal(esc('Wallet payment'), 'Wallet payment', name + ' quotes values needlessly');
    }
  });

  test('the financial columns and their values are unchanged', () => {
    for (const [name, source] of clients()) {
      for (const col of ['Date', 'Type', 'Description', 'Customer', 'Direction',
                         'Gross', 'Cashback', 'Net', 'Status', 'Reference']) {
        assert.ok(source.includes(DQ + col) || source.includes("'" + col),
          name + ' CSV lost the ' + col + ' column');
      }
      assert.match(source, /\(n: number\) => \(n \/ 100\)\.toFixed\(2\)/, name + ' changed the money format');
      for (const f of ['gross_pence', 'fee_pence', 'cashback_pence', 'net_pence']) {
        assert.ok(source.includes('p(r.' + f + ')'),
          name + ' CSV no longer exports ' + f + ' as the screen totals it');
      }
    }
  });

  test('mobile and web escape identically', () => {
    const [[, , appEsc], [, , webEsc]] = clients();
    for (const v of ['DEMO — 3 Session Pass', '1× thing', 'a,b', 'q' + DQ + 'q', 'a\nb', 'a\rb', 'plain']) {
      assert.equal(appEsc(v), webEsc(v), 'the two clients disagree on escaping ' + JSON.stringify(v));
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('both clients read the one accounting model', () => {
  const app = () => src(join(REPO_ROOT, 'app/local-business-transactions.tsx'));
  const web = () => src(join(WEB_ROOT, 'components/business/TransactionsLedger.tsx'));

  test('neither client recomputes refund arithmetic of its own', () => {
    for (const [name, s] of [['mobile', app()], ['web', web()]] as const) {
      assert.ok(!/reverses_transaction_id|platform_fee_pence/.test(s),
        `${name} derives refund figures itself instead of reading the statement`);
    }
  });

  test('both bucket refunds separately from Money in', () => {
    assert.match(app(), /direction === 'refund'/);
    assert.match(web(), /direction === "refund"/);
    assert.match(app(), /label="Refunds"/);
    assert.match(web(), /label="Refunds"/);
  });

  test('both widened the direction union', () => {
    assert.match(app(), /'in' \| 'out' \| 'refund'/);
    assert.match(web(), /"in" \| "out" \| "refund"/);
  });

  test('CSV exports the same rows the screen totals, refund reference included', () => {
    for (const [name, s] of [['mobile', app()], ['web', web()]] as const) {
      assert.ok(/r\.reference/.test(s), `${name} CSV drops the original-transaction reference`);
      assert.ok(/r\.fee_pence/.test(s) && /r\.net_pence/.test(s),
        `${name} CSV does not export the fee and net the screen sums`);
    }
  });
});
