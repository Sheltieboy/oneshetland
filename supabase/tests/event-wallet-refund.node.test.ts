/**
 * event-wallet-refund.node.test.ts
 *
 * A Wallet-funded event ticket (order bc622739…, 2 Oct 2026) has no PaymentIntent:
 * its payment reference is the synthetic wallet_<ledger id>. Its refund is the
 * Wallet refund, built from the canonical primitives — claw back the organiser's
 * Connect transfer (a Stripe step, proved in event-wallet-refund-core.node.test.ts),
 * then wallet_reverse_debit, then void the tickets.
 *
 * This proves the DATABASE half against real Postgres, using the real
 * wallet_reverse_debit, wallet_credit_with_ledger, refund_event_tickets_for_payment
 * and get_event_orders:
 *
 *   · the customer gets the full £1.96 back, exactly once, as ONE linked ledger row
 *   · a duplicate — or two genuinely concurrent requests — cannot credit twice
 *   · the order becomes refunded, the ticket void, a second void changes nothing
 *   · the original transfer is marked reversed, and admins see a Wallet refund
 *     reconciled only when the ledger really shows it
 *   · the organiser screen is told which rail paid
 *
 * SAFETY — ISOLATED DATABASE ONLY
 * Requires PASS_PROOF_DSN and refuses a DSN mentioning Supabase. Run by
 * `npm run test:isolated`. No production row is read or written, no auth user is
 * created, no service key is used, and no Stripe call is made.
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
const BASELINE = join(MIG, '20260623000000_baseline_remote_schema.sql');
const LEDGER = join(MIG, '20260820160000_wallet_atomic_ledger.sql');
const POINTS = join(MIG, '20261006120000_wallet_loyalty_points.sql');
const TICKETS = join(MIG, '20260820120000_atomic_ticket_redemption.sql');
const REFUNDS = join(MIG, '20260820140000_stripe_event_idempotency_and_ticket_refunds.sql');

/** The refund function now releases seats and uses the held-seat helper: install the whole migration (minus its cron line). */
const CAPACITY_MIGRATION = join(MIG, '20261030000000_refund_releases_capacity.sql');
const capacityMigration = () => { const s = readFileSync(CAPACITY_MIGRATION, 'utf8'); return s.slice(0, s.indexOf('-- Self-heal.')); };
const RECON = join(MIG, '20261028000000_refund_reconciliation.sql');
const ORDERS_1 = join(MIG, '20261029000000_event_orders_for_organisers.sql');
const ORDERS_2 = join(MIG, '20261029000100_event_orders_payment_method.sql');

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

const U = {
  ADMIN: 'a0000000-0000-4000-8000-0000000000a1',
  OWNER: 'b0000000-0000-4000-8000-0000000000b1',
  BUYER: 'd0000000-0000-4000-8000-0000000000d1',
  BUYER2: 'd0000000-0000-4000-8000-0000000000d2',
};
const BIZ = '51510000-0000-4000-8000-000000000051';
const EV = '71710000-0000-4000-8000-000000000071';
const TT = '81810000-0000-4000-8000-000000000081';
const ORDER = '91910000-0000-4000-8000-000000000091';
const CARD_ORDER = '91910000-0000-4000-8000-000000000092';
const FREE_ORDER = '91910000-0000-4000-8000-000000000093';
const SPEND = 'c1c10000-0000-4000-8000-0000000000c1';       // the Wallet spend that paid ORDER
const REF = `wallet_${SPEND}`;
const KEY = `event-tickets:${ORDER}`;

function schema() {
  const out = raw([
    'drop schema if exists public cascade; create schema public;',
    'drop schema if exists auth cascade; create schema auth;',
    'create table auth.users (id uuid primary key, email text);',
    `create or replace function auth.uid() returns uuid language sql stable as $$
       select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;`,
    `do $$ begin
       if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
       if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
       if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
     end $$;`,
    'alter role service_role bypassrls;',
    ...['profiles', 'local_businesses', 'hubs', 'hub_members', 'events', 'event_ticket_types', 'event_ticket_orders', 'event_tickets',
        'local_wallet_balances', 'local_wallet_transactions']
      .flatMap((t) => [createTable(BASELINE, `CREATE TABLE public.${t} (`),
        t === 'local_wallet_balances' ? 'alter table public.local_wallet_balances add primary key (user_id);' : `alter table public.${t} add primary key (id);`]),
    slice(REFUNDS, 'alter table public.event_ticket_orders\n  add column if not exists refunded_at timestamptz;', ';'),
    // The ledger columns later migrations added, as production has them.
    `alter table public.local_wallet_transactions
       add column idempotency_key text,
       add column transfer_state text,
       add column reverses_transaction_id uuid references public.local_wallet_transactions(id);`,
    `create unique index local_wallet_transactions_idempotency_key
       on public.local_wallet_transactions (idempotency_key) where idempotency_key is not null;`,
    `alter table public.local_wallet_transactions add constraint local_wallet_transactions_transfer_state_check
       check (transfer_state is null or transfer_state in ('none','pending','sent','failed','unresolved','reversed'));`,
    createTable(RECON, 'create table if not exists public.refund_reconciliation ('),
    // REAL functions, verbatim from their migrations.
    slice(LEDGER, 'create or replace function public.wallet_credit_with_ledger', '$$;'),
    slice(POINTS, 'create or replace function public.wallet_reverse_debit', '$$;'),
    slice(TICKETS, 'create or replace function public.can_scan_event', '$$;'),
    capacityMigration(),
    'grant usage on schema public, auth to anon, authenticated, service_role;',
    'grant execute on function auth.uid() to anon, authenticated, service_role;',
    // The migrations under test, in order.
    src(ORDERS_1),
    src(ORDERS_2),
  ].join('\n'));
  assert.doesNotMatch(out, /ERROR/i, `schema failed:\n${out.slice(0, 1800)}`);
}

/** The order as the production checkout left it: £5.00 wallet, £1.96 spend, £1.00 transferred, order paid, ticket valid. */
function fixtures(opts: { transferState?: string | null; transferId?: string | null } = {}) {
  const ts = opts.transferState === undefined ? 'sent' : opts.transferState;
  const tid = opts.transferId === undefined ? 'tr_test_1' : opts.transferId;
  const o = raw(`
    delete from public.event_tickets; delete from public.event_ticket_orders; delete from public.event_ticket_types;
    delete from public.events; delete from public.local_wallet_transactions; delete from public.local_wallet_balances;
    delete from public.local_businesses; delete from public.profiles; delete from auth.users; delete from public.refund_reconciliation;

    insert into auth.users(id, email) values ('${U.ADMIN}','admin@example.com'),('${U.OWNER}','owner@example.com'),
      ('${U.BUYER}','james@example.com'),('${U.BUYER2}','kim@example.com');
    insert into public.profiles(id, role, full_name) values ('${U.ADMIN}','admin','Ada Admin'),('${U.OWNER}','customer','Bea Owner'),
      ('${U.BUYER}','customer','James Fullerton'),('${U.BUYER2}','customer','Kim Card');
    insert into public.local_businesses (id, owner_id, name, category, address) values ('${BIZ}','${U.OWNER}','ZZ TEST','retail','Lerwick');
    insert into public.events (id, organiser_user_id, organiser_business_id, title, starts_at, status)
      values ('${EV}','${U.OWNER}','${BIZ}','Acceptance Event', now() + interval '5 days','published');
    insert into public.event_ticket_types (id, event_id, name, price_pence) values ('${TT}','${EV}','Paid Entry',100);

    insert into public.local_wallet_balances (user_id, balance_pence) values ('${U.BUYER}', 304);
    insert into public.local_wallet_transactions (id, user_id, type, amount_pence, description, idempotency_key, transfer_state, stripe_transfer_id)
      values ('${SPEND}','${U.BUYER}','spend',-196,'Tickets — Acceptance Event','${KEY}', ${ts === null ? 'null' : `'${ts}'`}, ${tid === null ? 'null' : `'${tid}'`});

    insert into public.event_ticket_orders (id,event_id,buyer_id,stripe_payment_intent_id,status,total_pence,platform_fee_pence,tickets_count,paid_at) values
      ('${ORDER}','${EV}','${U.BUYER}','${REF}','paid',196,96,1, now()),
      ('${CARD_ORDER}','${EV}','${U.BUYER2}','pi_card_1','paid',196,96,1, now()),
      ('${FREE_ORDER}','${EV}','${U.BUYER2}',null,'paid',0,0,1, now());
    insert into public.event_tickets (id,order_id,event_id,ticket_type_id,holder_id,validation_token_hash,backup_code,status,price_pence) values
      ('a1000000-0000-4000-8000-0000000000a1','${ORDER}','${EV}','${TT}','${U.BUYER}','h1','b1','valid',100);
  `);
  assert.doesNotMatch(o, /ERROR/i, `fixtures failed:\n${o.slice(0, 900)}`);
}

const balance = () => Number(scalar(`select balance_pence::text from public.local_wallet_balances where user_id='${U.BUYER}';`));
const reversalRows = () => Number(scalar(`select count(*)::text from public.local_wallet_transactions where reverses_transaction_id='${SPEND}';`));
const reverse = (merchant: string) =>
  raw(`select balance_pence, already_reversed from public.wallet_reverse_debit('${SPEND}'::uuid, 'Refund · event tickets', '${merchant}');`);
const voidTickets = () => raw(`select public.refund_event_tickets_for_payment('${REF}', true)::text;`);
const asUser = (uid: string, sql: string) =>
  raw(`select set_config('request.jwt.claim.sub','${uid}',false); set role authenticated; ${sql} reset role;`);
type View = { orders: { id: string; status: string; payment_method: string; refundable: boolean; reconciliation_state: string | null;
  tickets: { status: string }[] }[]; can_refund: boolean };
function viewAs(uid: string): View {
  const out = asUser(uid, `select public.get_event_orders('${EV}')::text;`);
  const json = out.split('\n').map((l) => l.trim()).find((l) => l.startsWith('{'));
  assert.ok(json, `no JSON:\n${out.slice(0, 300)}`);
  return JSON.parse(json) as View;
}
const orderRow = (v: View, id = ORDER) => v.orders.find((o) => o.id === id)!;

describe('the organiser screen is told which rail paid, and a Wallet order is refundable', () => {
  before(() => { schema(); fixtures(); });

  test('payment_method distinguishes wallet, card and free', () => {
    const v = viewAs(U.OWNER);
    assert.equal(orderRow(v).payment_method, 'wallet');
    assert.equal(orderRow(v, CARD_ORDER).payment_method, 'card');
    assert.equal(orderRow(v, FREE_ORDER).payment_method, 'free');
  });

  test('the Wallet-funded paid order offers Refund to the owner and to an admin; the free order does not', () => {
    for (const uid of [U.OWNER, U.ADMIN]) {
      const v = viewAs(uid);
      assert.equal(orderRow(v).refundable, true, `${uid}`);
      assert.equal(orderRow(v, FREE_ORDER).refundable, false);
    }
  });
});

describe('the Wallet refund restores the customer exactly once and settles everything else', () => {
  before(() => { schema(); fixtures(); });

  test('before: balance £3.04, order paid, ticket valid, organiser transfer sent', () => {
    assert.equal(balance(), 304);
    assert.equal(scalar(`select status from public.event_ticket_orders where id='${ORDER}';`), 'paid');
    assert.equal(scalar(`select transfer_state from public.local_wallet_transactions where id='${SPEND}';`), 'sent');
  });

  test('wallet_reverse_debit credits the FULL £1.96 back (the booking fee returns with it) as one linked refund row', () => {
    const out = reverse('clawed_back');
    assert.match(out, /500\|f/, `unexpected result: ${out}`);
    assert.equal(balance(), 500);
    assert.equal(reversalRows(), 1);
    assert.equal(scalar(`select amount_pence::text from public.local_wallet_transactions where reverses_transaction_id='${SPEND}';`), '196');
    assert.equal(scalar(`select type from public.local_wallet_transactions where reverses_transaction_id='${SPEND}';`), 'refund');
    assert.equal(scalar(`select idempotency_key from public.local_wallet_transactions where reverses_transaction_id='${SPEND}';`), `${KEY}:reversal`);
  });

  test('the original spend records that the organiser was clawed back', () => {
    assert.equal(scalar(`select transfer_state from public.local_wallet_transactions where id='${SPEND}';`), 'reversed');
  });

  test('voiding the tickets makes the order refunded with refunded_at set and the ticket void', () => {
    assert.match(voidTickets(), /"action": "refunded"/);
    assert.equal(scalar(`select status from public.event_ticket_orders where id='${ORDER}';`), 'refunded');
    assert.equal(scalar(`select (refunded_at is not null)::text from public.event_ticket_orders where id='${ORDER}';`), 'true');
    assert.equal(scalar(`select status from public.event_tickets where order_id='${ORDER}';`), 'refunded');
  });

  test('afterwards the order offers no second refund, and an admin sees the Wallet refund RECONCILED with no gap', () => {
    const owner = viewAs(U.OWNER);
    assert.equal(orderRow(owner).status, 'refunded');
    assert.equal(orderRow(owner).refundable, false);
    assert.equal(orderRow(owner).tickets[0].status, 'refunded');
    assert.equal(orderRow(owner).reconciliation_state, null, 'organisers do not see reconciliation state');
    assert.equal(orderRow(viewAs(U.ADMIN)).reconciliation_state, 'reconciled');
  });

  test('a duplicate refund credits NOTHING more and creates no second row', () => {
    const again = reverse('clawed_back');
    assert.match(again, /500\|t/, `second call should report already reversed: ${again}`);
    assert.equal(balance(), 500);
    assert.equal(reversalRows(), 1);
    assert.match(voidTickets(), /"action": "already_refunded"/);
    assert.equal(scalar(`select status from public.event_tickets where order_id='${ORDER}';`), 'refunded');
  });
});

describe('two simultaneous refund requests (a double tap that beats the screen guard) credit once', () => {
  before(() => { schema(); fixtures(); });

  test('concurrent wallet_reverse_debit calls end with one credit, one refund row', async () => {
    const call = () => rawAsync(`select balance_pence, already_reversed from public.wallet_reverse_debit('${SPEND}'::uuid, 'Refund', 'clawed_back');`);
    const results = await Promise.all([call(), call(), call(), call()]);
    assert.equal(balance(), 500, `balance should be restored once, not multiplied:\n${results.join('---')}`);
    assert.equal(reversalRows(), 1);
    const fresh = results.filter((r) => /\|f/.test(r)).length;
    const replays = results.filter((r) => /\|t/.test(r)).length;
    assert.equal(fresh, 1, 'exactly one request performs the credit');
    assert.equal(replays, 3, 'the others are reported as already reversed');
  });
});

describe('the ledger refuses refunds it cannot vouch for', () => {
  test('an unresolved organiser transfer is refused — nothing is credited', () => {
    schema(); fixtures({ transferState: 'unresolved' });
    assert.match(reverse('clawed_back'), /unresolved/);
    assert.equal(balance(), 304);
    assert.equal(reversalRows(), 0);
  });

  test('an organiser who was never sent anything (no transfer) is credited without a clawback', () => {
    schema(); fixtures({ transferState: 'none', transferId: null });
    assert.match(reverse('no_transfer'), /500\|f/);
    assert.equal(balance(), 500);
  });

  test('a sent transfer cannot be reported as never paid, and nothing is sent cannot be reported as clawed back', () => {
    schema(); fixtures();
    assert.match(reverse('never_paid'), /transfer was sent/);
    assert.equal(balance(), 304);
    schema(); fixtures({ transferState: 'none', transferId: null });
    assert.match(reverse('clawed_back'), /nothing was sent/);
    assert.equal(balance(), 304);
  });
});

describe('a Wallet refund is only called reconciled when the ledger really shows it', () => {
  test('refunded order with NO ledger reversal reads needs_review to an admin — never reconciled', () => {
    schema(); fixtures();
    raw(`update public.event_ticket_orders set status='refunded', refunded_at=now() where id='${ORDER}';`);
    assert.equal(orderRow(viewAs(U.ADMIN)).reconciliation_state, 'needs_review');
  });

  test('reversal recorded but the organiser transfer still marked sent reads needs_review (the clawback is unproven)', () => {
    schema(); fixtures();
    reverse('clawed_back');
    raw(`update public.local_wallet_transactions set transfer_state='sent' where id='${SPEND}';
         update public.event_ticket_orders set status='refunded', refunded_at=now() where id='${ORDER}';`);
    assert.equal(orderRow(viewAs(U.ADMIN)).reconciliation_state, 'needs_review');
  });

  test('a card order is reconciled from the card reconciliation table, unaffected by the Wallet logic', () => {
    schema(); fixtures();
    raw(`update public.event_ticket_orders set status='refunded', refunded_at=now() where id='${CARD_ORDER}';`);
    assert.equal(orderRow(viewAs(U.ADMIN), CARD_ORDER).reconciliation_state, 'unverified');
    raw(`insert into public.refund_reconciliation (charge_id, payment_intent_id, rail, state, charge_amount_pence, amount_refunded_pence)
         values ('ch_x','pi_card_1','event_ticket','reconciled',196,196);`);
    assert.equal(orderRow(viewAs(U.ADMIN), CARD_ORDER).reconciliation_state, 'reconciled');
  });
});
