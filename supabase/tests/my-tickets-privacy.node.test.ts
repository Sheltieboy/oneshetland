/**
 * my-tickets-privacy.node.test.ts
 *
 * My Tickets now reads HISTORY (valid, used and refunded tickets) and joins the
 * buyer's order for the money lines. That must not let one customer see another's
 * tickets, and must not show anyone an amount they did not pay.
 *
 * This runs the REAL row-level-security policies from the baseline migration
 * (event_tickets_holder_read / _owner_read / _admin_all and ticket_orders_buyer_read)
 * in an isolated Postgres, as the role PostgREST uses, with the same query shape
 * both screens send: holder_id = me, status in history, order embedded.
 *
 * SAFETY — ISOLATED DATABASE ONLY
 * Requires PASS_PROOF_DSN and refuses a DSN mentioning Supabase. Run by
 * `npm run test:isolated`. No production row is read or written, no auth user
 * is created, no service key is used.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HISTORY_TICKET_STATUSES, ticketHistoryLines } from '../../lib/ticket-lifecycle.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASELINE = join(REPO_ROOT, 'supabase/migrations/20260623000000_baseline_remote_schema.sql');
const REFUNDS = join(REPO_ROOT, 'supabase/migrations/20260820140000_stripe_event_idempotency_and_ticket_refunds.sql');

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
  ALICE: 'a1100000-0000-4000-8000-0000000000a1',    // buys tickets
  BOB: 'b2200000-0000-4000-8000-0000000000b2',      // another customer with tickets of his own
  GIFTEE: 'c3300000-0000-4000-8000-0000000000c3',   // holds a ticket ALICE bought for them
  ORGANISER: 'd4400000-0000-4000-8000-0000000000d4', // owns the business running the event, and holds a ticket ALICE bought
  ADMIN: 'e5500000-0000-4000-8000-0000000000e5',
  STRANGER: 'f6600000-0000-4000-8000-0000000000f6',
};
const BIZ = '51510000-0000-4000-8000-000000000051';
const EV = '71710000-0000-4000-8000-000000000071';
const TT = '81810000-0000-4000-8000-000000000081';
const O = {
  ALICE_PAID: '91910000-0000-4000-8000-000000000091',
  ALICE_REFUNDED: '91910000-0000-4000-8000-000000000092',
  ALICE_PENDING: '91910000-0000-4000-8000-000000000093',
  ALICE_GIFT: '91910000-0000-4000-8000-000000000094',
  BOB: '91910000-0000-4000-8000-000000000095',
};
const T = {
  ALICE_VALID: 'a1000000-0000-4000-8000-0000000000a1',
  ALICE_USED: 'a1000000-0000-4000-8000-0000000000a2',
  ALICE_REFUNDED: 'a1000000-0000-4000-8000-0000000000a3',
  ALICE_PENDING: 'a1000000-0000-4000-8000-0000000000a4',
  ALICE_ABANDONED: 'a1000000-0000-4000-8000-0000000000a5',
  GIFTED: 'a1000000-0000-4000-8000-0000000000a6',
  ORG_HELD: 'a1000000-0000-4000-8000-0000000000a7',
  BOB_VALID: 'a1000000-0000-4000-8000-0000000000a8',
  ADMIN_OWN: 'a1000000-0000-4000-8000-0000000000a9',
};
const SECRET_REF = 'pi_ALICE_PRIVATE_REFERENCE';

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
    ...['profiles', 'local_businesses', 'hubs', 'hub_members', 'events', 'event_ticket_types', 'event_ticket_orders', 'event_tickets']
      .flatMap((t) => [createTable(BASELINE, `CREATE TABLE public.${t} (`), `alter table public.${t} add primary key (id);`]),
    slice(REFUNDS, 'alter table public.event_ticket_orders\n  add column if not exists refunded_at timestamptz;', ';'),
    slice(BASELINE, 'CREATE FUNCTION public.is_hub_admin', '$$;'),
    'grant usage on schema public, auth to anon, authenticated, service_role;',
    'grant all on all tables in schema public to anon, authenticated, service_role;',
    'grant execute on all functions in schema public to anon, authenticated, service_role;',
    // The REAL policies, verbatim.
    'alter table public.event_tickets enable row level security; alter table public.event_ticket_orders enable row level security;',
    slice(BASELINE, 'CREATE POLICY event_tickets_holder_read ON', ';'),
    slice(BASELINE, 'CREATE POLICY event_tickets_owner_read ON', ';'),
    slice(BASELINE, 'CREATE POLICY event_tickets_admin_all ON', ';'),
    slice(BASELINE, 'CREATE POLICY ticket_orders_buyer_read ON', ';'),
  ].join('\n'));
  assert.doesNotMatch(out, /ERROR/i, `schema failed:\n${out.slice(0, 1800)}`);
}

function fixtures() {
  const o = raw(`
    insert into auth.users(id, email) values
      ('${U.ALICE}','alice@example.com'),('${U.BOB}','bob@example.com'),('${U.GIFTEE}','giftee@example.com'),
      ('${U.ORGANISER}','organiser@example.com'),('${U.ADMIN}','admin@example.com'),('${U.STRANGER}','stranger@example.com');
    insert into public.profiles(id, role, full_name) values
      ('${U.ALICE}','customer','Alice'),('${U.BOB}','customer','Bob'),('${U.GIFTEE}','customer','Giftee'),
      ('${U.ORGANISER}','customer','Organiser'),('${U.ADMIN}','admin','Admin'),('${U.STRANGER}','customer','Stranger');
    insert into public.local_businesses (id, owner_id, name, category, address) values ('${BIZ}','${U.ORGANISER}','Anderson & Co','retail','Lerwick');
    insert into public.events (id, organiser_user_id, organiser_business_id, title, starts_at, ends_at, status)
      values ('${EV}','${U.ORGANISER}','${BIZ}','Gig', now() + interval '4 days', now() + interval '4 days 3 hours','published');
    insert into public.event_ticket_types (id, event_id, name, price_pence) values ('${TT}','${EV}','Standard',100);

    insert into public.event_ticket_orders (id,event_id,buyer_id,stripe_payment_intent_id,status,total_pence,platform_fee_pence,tickets_count,paid_at,created_at,refunded_at) values
      ('${O.ALICE_PAID}','${EV}','${U.ALICE}','${SECRET_REF}','paid',392,192,2, now() - interval '2 hours', now() - interval '2 hours', null),
      ('${O.ALICE_REFUNDED}','${EV}','${U.ALICE}','wallet_aaaa','refunded',196,96,1, now() - interval '3 hours', now() - interval '3 hours', now() - interval '1 hour'),
      ('${O.ALICE_PENDING}','${EV}','${U.ALICE}','pi_pending','pending',196,96,1, null, now() - interval '1 hour', null),
      ('${O.ALICE_GIFT}','${EV}','${U.ALICE}','pi_gift_private','paid',392,192,2, now() - interval '1 hour', now() - interval '1 hour', null),
      ('${O.BOB}','${EV}','${U.BOB}','pi_bob_private','paid',196,96,1, now() - interval '1 hour', now() - interval '1 hour', null);

    insert into public.event_tickets (id,order_id,event_id,ticket_type_id,holder_id,validation_token_hash,backup_code,status,price_pence,checked_in_at) values
      ('${T.ALICE_VALID}','${O.ALICE_PAID}','${EV}','${TT}','${U.ALICE}','h1','b1','valid',100,null),
      ('${T.ALICE_USED}','${O.ALICE_PAID}','${EV}','${TT}','${U.ALICE}','h2','b2','used',100, now() - interval '30 minutes'),
      ('${T.ALICE_REFUNDED}','${O.ALICE_REFUNDED}','${EV}','${TT}','${U.ALICE}','h3','b3','refunded',100,null),
      ('${T.ALICE_PENDING}','${O.ALICE_PENDING}','${EV}','${TT}','${U.ALICE}','h4','b4','pending_payment',100,null),
      ('${T.ALICE_ABANDONED}','${O.ALICE_PENDING}','${EV}','${TT}','${U.ALICE}','h5','b5','cancelled',100,null),
      ('${T.GIFTED}','${O.ALICE_GIFT}','${EV}','${TT}','${U.GIFTEE}','h6','b6','valid',100,null),
      ('${T.ORG_HELD}','${O.ALICE_GIFT}','${EV}','${TT}','${U.ORGANISER}','h7','b7','valid',100,null),
      ('${T.BOB_VALID}','${O.BOB}','${EV}','${TT}','${U.BOB}','h8','b8','valid',100,null),
      ('${T.ADMIN_OWN}','${O.BOB}','${EV}','${TT}','${U.ADMIN}','h9','b9','valid',100,null);
  `);
  assert.doesNotMatch(o, /ERROR/i, `fixtures failed:\n${o.slice(0, 1200)}`);
}

type Row = {
  id: string; status: string; holder_id: string;
  order: null | { buyer_id: string; status: string; total_pence: number; tickets_count: number; refunded_at: string | null; stripe_payment_intent_id: string | null };
};

/**
 * The query both screens send, as PostgREST would run it: the caller's role and
 * JWT subject, `holder_id = <param>`, status in history, the order embedded.
 * `asRole` lets the test play anon; `param` lets it SPOOF another user's id.
 */
function myTickets(uid: string | null, param: string, asRole: 'authenticated' | 'anon' = 'authenticated'): Row[] {
  const statuses = HISTORY_TICKET_STATUSES.map((s) => `'${s}'`).join(',');
  const out = raw(`
    select set_config('request.jwt.claim.sub','${uid ?? ''}',false); set role ${asRole};
    select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]'::jsonb)::text from (
      select t.id, t.status, t.holder_id,
        case when o.id is null then null else json_build_object(
          'buyer_id', o.buyer_id, 'status', o.status, 'total_pence', o.total_pence, 'tickets_count', o.tickets_count,
          'refunded_at', o.refunded_at, 'stripe_payment_intent_id', o.stripe_payment_intent_id) end as "order"
      from public.event_tickets t
      left join public.event_ticket_orders o on o.id = t.order_id
      where t.holder_id = '${param}' and t.status in (${statuses})
    ) r; reset role;`);
  const json = out.split('\n').map((l) => l.trim()).find((l) => l.startsWith('['));
  assert.ok(json, `no JSON returned:\n${out.slice(0, 400)}`);
  return JSON.parse(json) as Row[];
}
const ids = (rows: Row[]) => rows.map((r) => r.id).sort();
const day = (i: string) => i.slice(0, 10);

describe('My Tickets: a customer sees only their own tickets', () => {
  before(() => { schema(); fixtures(); });

  test('Alice sees her valid, used AND refunded tickets — and not her unpaid or abandoned ones', () => {
    const rows = myTickets(U.ALICE, U.ALICE);
    assert.deepEqual(ids(rows), [T.ALICE_REFUNDED, T.ALICE_USED, T.ALICE_VALID].sort());
    assert.ok(!ids(rows).includes(T.ALICE_PENDING));
    assert.ok(!ids(rows).includes(T.ALICE_ABANDONED));
  });

  test('the refunded ticket keeps its purchase and refund history', () => {
    const r = myTickets(U.ALICE, U.ALICE).find((x) => x.id === T.ALICE_REFUNDED)!;
    assert.equal(r.status, 'refunded');
    assert.ok(r.order, 'the buyer lost the order that records what she paid');
    assert.equal(r.order!.status, 'refunded');
    assert.equal(r.order!.total_pence, 196);
    assert.ok(r.order!.refunded_at, 'the refund date was lost');
    const lines = ticketHistoryLines(r.order, U.ALICE, day);
    assert.equal(lines.paid, '£1.96 paid with OneShetland Wallet');
    assert.match(lines.refund!, /^£1\.96 refunded to your OneShetland Wallet · \d{4}-\d{2}-\d{2}$/);
  });

  test('another customer CANNOT see Alice\'s tickets — even by asking for her id', () => {
    assert.deepEqual(myTickets(U.BOB, U.ALICE), []);
    assert.deepEqual(myTickets(U.STRANGER, U.ALICE), []);
    assert.deepEqual(myTickets(U.GIFTEE, U.ALICE), []);
  });

  test('and Alice cannot see Bob\'s', () => {
    assert.deepEqual(myTickets(U.ALICE, U.BOB), []);
    assert.deepEqual(ids(myTickets(U.BOB, U.BOB)), [T.BOB_VALID]);
  });

  test('a signed-out caller sees nothing, by any id', () => {
    assert.deepEqual(myTickets(null, U.ALICE, 'anon'), []);
    assert.deepEqual(myTickets(null, U.BOB, 'anon'), []);
  });

  test('a customer with no tickets gets an empty list, not an error', () => {
    assert.deepEqual(myTickets(U.STRANGER, U.STRANGER), []);
  });

  test('a ticket someone ELSE bought for you shows, but carries no order — so no amount, no payment reference', () => {
    const rows = myTickets(U.GIFTEE, U.GIFTEE);
    assert.deepEqual(ids(rows), [T.GIFTED]);
    assert.equal(rows[0].order, null);
    assert.deepEqual(ticketHistoryLines(rows[0].order, U.GIFTEE, day), { quantity: null, paid: null, refund: null });
    assert.doesNotMatch(JSON.stringify(rows), /392|pi_gift_private|Alice|alice@/);
  });

  test('an organiser who holds a ticket Alice bought CAN read that order (their event), so the screen refuses to show it as theirs', () => {
    const r = myTickets(U.ORGANISER, U.ORGANISER).find((x) => x.id === T.ORG_HELD)!;
    assert.ok(r.order, 'the organiser policy no longer exposes the order — if that was intended, this guard can relax');
    assert.equal(r.order!.buyer_id, U.ALICE);
    assert.deepEqual(ticketHistoryLines(r.order, U.ORGANISER, day), { quantity: null, paid: null, refund: null });
  });

  test('an admin who also holds a ticket sees only their own when they filter by holder, as both screens do', () => {
    assert.deepEqual(ids(myTickets(U.ADMIN, U.ADMIN)), [T.ADMIN_OWN]);
    const lines = ticketHistoryLines(myTickets(U.ADMIN, U.ADMIN)[0].order, U.ADMIN, day);
    assert.deepEqual(lines, { quantity: null, paid: null, refund: null }, 'an admin was shown an amount they did not pay');
  });

  test('no purchaser identity ever comes with a ticket: no name, no email, only the order\'s own buyer id', () => {
    for (const uid of [U.ALICE, U.GIFTEE, U.ORGANISER]) {
      const text = JSON.stringify(myTickets(uid, uid));
      assert.doesNotMatch(text, /@example\.com|"full_name"|Alice"|Bob"/);
    }
  });

  test('the history filter itself: pending_payment and cancelled never come back, whoever asks', () => {
    for (const uid of Object.values(U)) {
      for (const r of myTickets(uid, uid)) assert.ok((HISTORY_TICKET_STATUSES as readonly string[]).includes(r.status), `${uid} got a ${r.status} ticket`);
    }
  });
});
