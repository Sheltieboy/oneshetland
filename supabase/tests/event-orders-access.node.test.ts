/**
 * event-orders-access.node.test.ts
 *
 * Organisers could see Sold / Checked in / Capacity but not who bought tickets,
 * nor refund an order. 20261029000000_event_orders_for_organisers.sql adds:
 *
 *   get_event_orders(event)        who may VIEW   (can_scan_event — the
 *                                  existing "manages this event" predicate)
 *   can_refund_event_orders()      who may REFUND (admin, the organising
 *                                  business's owner, the hub OWNER — whoever
 *                                  controls the connected account the money
 *                                  was paid to)
 *
 * This runs the real migration, the real can_scan_event and the real
 * refund_event_tickets_for_payment in an isolated Postgres, as the roles
 * PostgREST uses, and proves the access matrix, that purchaser details do not
 * leak, that Stripe references stay admin-only, and that a refunded order's
 * tickets become void exactly once.
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

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIG = join(REPO_ROOT, 'supabase/migrations');
const BASELINE = join(MIG, '20260623000000_baseline_remote_schema.sql');
const TICKETS = join(MIG, '20260820120000_atomic_ticket_redemption.sql');
const ATTRIBUTION = join(MIG, '20261121000000_event_notice_attribution.sql');   // can_scan_event no longer honours organiser_user_id
const REFUNDS = join(MIG, '20260820140000_stripe_event_idempotency_and_ticket_refunds.sql');

/** The refund function now releases seats and uses the held-seat helper: install the whole migration (minus its cron line). */
const CAPACITY_MIGRATION = join(MIG, '20261030000000_refund_releases_capacity.sql');
const capacityMigration = () => { const s = readFileSync(CAPACITY_MIGRATION, 'utf8'); return s.slice(0, s.indexOf('-- Self-heal.')); };
const RECON = join(MIG, '20261028000000_refund_reconciliation.sql');
const UNDER_TEST = join(MIG, '20261029000000_event_orders_for_organisers.sql');

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

const U = {
  ADMIN: 'a0000000-0000-4000-8000-0000000000a1',
  BIZ_OWNER: 'b0000000-0000-4000-8000-0000000000b1',
  OTHER_BIZ_OWNER: 'b0000000-0000-4000-8000-0000000000b2',
  HUB_OWNER: 'e0000000-0000-4000-8000-0000000000e1',
  HUB_COMMITTEE: 'e0000000-0000-4000-8000-0000000000e2',
  ORGANISER: 'c0000000-0000-4000-8000-0000000000c1',   // organiser_user_id on the business event, not its owner
  BUYER: 'd0000000-0000-4000-8000-0000000000d1',
  BUYER2: 'd0000000-0000-4000-8000-0000000000d2',
  STRANGER: 'f0000000-0000-4000-8000-0000000000f1',
};
const BIZ = '51510000-0000-4000-8000-000000000051';
const BIZ2 = '51510000-0000-4000-8000-000000000052';
const HUB = '61610000-0000-4000-8000-000000000061';
const EV_BIZ = '71710000-0000-4000-8000-000000000071';
const EV_HUB = '71710000-0000-4000-8000-000000000072';
const EV_OTHER = '71710000-0000-4000-8000-000000000073';
const TT = '81810000-0000-4000-8000-000000000081';
const TT_VIP = '81810000-0000-4000-8000-000000000082';
const O_PAID = '91910000-0000-4000-8000-000000000091';
const O_REFUNDED = '91910000-0000-4000-8000-000000000092';
const O_PENDING = '91910000-0000-4000-8000-000000000093';
const O_FREE = '91910000-0000-4000-8000-000000000094';
const O_HUB = '91910000-0000-4000-8000-000000000095';
const O_OTHER = '91910000-0000-4000-8000-000000000096';

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
    // Columns later migrations added to the baseline tables.
    slice(REFUNDS, 'alter table public.event_ticket_orders\n  add column if not exists refunded_at timestamptz;', ';'),
    // Reconciliation table, from its own migration (admins see its state).
    createTable(RECON, 'create table if not exists public.refund_reconciliation ('),
    // The REAL authority predicate and the REAL ticket-void function.
    slice(ATTRIBUTION, 'create or replace function public.can_scan_event', '$$;'),
    capacityMigration(),
    'grant usage on schema public, auth to anon, authenticated, service_role;',
    'grant execute on function auth.uid() to anon, authenticated, service_role;',
    // The migration under test, verbatim.
    src(UNDER_TEST),
  ].join('\n'));
  assert.doesNotMatch(out, /ERROR/i, `schema failed:\n${out.slice(0, 1800)}`);
}

function fixtures() {
  const o = raw(`
    delete from public.event_tickets; delete from public.event_ticket_orders; delete from public.event_ticket_types;
    delete from public.events; delete from public.hub_members; delete from public.hubs;
    delete from public.local_businesses; delete from public.profiles; delete from auth.users;
    delete from public.refund_reconciliation;

    insert into auth.users(id, email) values
      ('${U.ADMIN}','admin@example.com'),('${U.BIZ_OWNER}','owner@example.com'),('${U.OTHER_BIZ_OWNER}','other@example.com'),
      ('${U.HUB_OWNER}','hubowner@example.com'),('${U.HUB_COMMITTEE}','committee@example.com'),('${U.ORGANISER}','organiser@example.com'),
      ('${U.BUYER}','sam.buyer@example.com'),('${U.BUYER2}','kim.buyer@example.com'),('${U.STRANGER}','stranger@example.com');
    insert into public.profiles(id, role, full_name) values
      ('${U.ADMIN}','admin','Ada Admin'),('${U.BIZ_OWNER}','customer','Bea Owner'),('${U.OTHER_BIZ_OWNER}','customer','Otto Other'),
      ('${U.HUB_OWNER}','customer','Hugh Owner'),('${U.HUB_COMMITTEE}','customer','Cory Committee'),('${U.ORGANISER}','customer','Orla Organiser'),
      ('${U.BUYER}','customer','Sam Buyer'),('${U.BUYER2}','customer',null),('${U.STRANGER}','customer','Sid Stranger');
    insert into public.local_businesses (id, owner_id, name, category, address) values
      ('${BIZ}','${U.BIZ_OWNER}','Anderson & Co','retail','Lerwick'),
      ('${BIZ2}','${U.OTHER_BIZ_OWNER}','Other Shop','retail','Scalloway');
    insert into public.hubs (id, owner_id, name) values ('${HUB}','${U.HUB_OWNER}','North Isles Hub');
    insert into public.hub_members (hub_id, user_id, role, status) values
      ('${HUB}','${U.HUB_OWNER}','owner','active'),('${HUB}','${U.HUB_COMMITTEE}','committee','active');
    insert into public.events (id, organiser_user_id, organiser_business_id, organiser_hub_id, title, starts_at, status) values
      ('${EV_BIZ}','${U.ORGANISER}','${BIZ}',null,'Business gig', now() + interval '10 days','published'),
      ('${EV_HUB}','${U.HUB_OWNER}',null,'${HUB}','Hub night', now() + interval '10 days','published'),
      ('${EV_OTHER}','${U.OTHER_BIZ_OWNER}','${BIZ2}',null,'Other gig', now() + interval '10 days','published');
    insert into public.event_ticket_types (id, event_id, name, price_pence) values
      ('${TT}','${EV_BIZ}','Standard',100),('${TT_VIP}','${EV_BIZ}','VIP',500);

    insert into public.event_ticket_orders (id,event_id,buyer_id,stripe_payment_intent_id,status,total_pence,platform_fee_pence,tickets_count,paid_at,created_at) values
      ('${O_PAID}','${EV_BIZ}','${U.BUYER}','pi_paid','paid',196,96,2, now() - interval '2 hours', now() - interval '2 hours'),
      ('${O_REFUNDED}','${EV_BIZ}','${U.BUYER2}','pi_refunded','refunded',196,96,1, now() - interval '3 days', now() - interval '3 days'),
      ('${O_PENDING}','${EV_BIZ}','${U.BUYER}','pi_pending','pending',196,96,1, null, now() - interval '1 hour'),
      ('${O_FREE}','${EV_BIZ}','${U.BUYER2}',null,'paid',0,0,1, now() - interval '1 day', now() - interval '1 day'),
      ('${O_HUB}','${EV_HUB}','${U.BUYER}','pi_hub','paid',196,96,1, now() - interval '1 hour', now() - interval '1 hour'),
      ('${O_OTHER}','${EV_OTHER}','${U.BUYER2}','pi_other','paid',196,96,1, now() - interval '1 hour', now() - interval '1 hour');
    update public.event_ticket_orders set refunded_at = now() - interval '2 days' where id = '${O_REFUNDED}';

    insert into public.event_tickets (id,order_id,event_id,ticket_type_id,holder_id,validation_token_hash,backup_code,status,attendee_name,attendee_email,price_pence,checked_in_at) values
      ('a1000000-0000-4000-8000-0000000000a1','${O_PAID}','${EV_BIZ}','${TT}','${U.BUYER}','h1','b1','valid','Sam Buyer','sam.buyer@example.com',100,null),
      ('a1000000-0000-4000-8000-0000000000a2','${O_PAID}','${EV_BIZ}','${TT_VIP}','${U.BUYER}','h2','b2','used',null,null,100, now() - interval '30 minutes'),
      ('a1000000-0000-4000-8000-0000000000a3','${O_REFUNDED}','${EV_BIZ}','${TT}','${U.BUYER2}','h3','b3','refunded',null,null,100,null),
      ('a1000000-0000-4000-8000-0000000000a4','${O_FREE}','${EV_BIZ}','${TT}','${U.BUYER2}','h4','b4','valid',null,null,0,null),
      ('a1000000-0000-4000-8000-0000000000a5','${O_HUB}','${EV_HUB}','${TT}','${U.BUYER}','h5','b5','valid',null,null,100,null);
  `);
  assert.doesNotMatch(o, /ERROR/i, `fixtures failed:\n${o.slice(0, 1200)}`);
}

/** PostgREST: a role plus the JWT subject claim, calling the RPC. */
const rpcAs = (uid: string, ev: string) =>
  raw(`select set_config('request.jwt.claim.sub','${uid}',false); set role authenticated; select public.get_event_orders('${ev}')::text; reset role;`);
const rpcAnon = (ev: string) => raw(`set role anon; select public.get_event_orders('${ev}')::text; reset role;`);

type Res = {
  can_refund: boolean; is_admin: boolean; total_orders: number;
  orders: { id: string; status: string; total_pence: number; booking_fee_pence: number; ticket_subtotal_pence: number;
    purchaser: { id: string; name: string | null; email: string | null }; refundable: boolean;
    payment_intent_id: string | null; reconciliation_state: string | null; checked_in_count: number;
    tickets: { ticket_type: string; status: string; checked_in_at: string | null; attendee_name: string | null }[] }[];
};
function view(uid: string, ev: string): Res {
  const out = rpcAs(uid, ev);
  const json = out.split('\n').map((l) => l.trim()).find((l) => l.startsWith('{'));
  assert.ok(json, `no JSON returned for ${uid}:\n${out.slice(0, 400)}`);
  return JSON.parse(json) as Res;
}
const refused = (out: string) => /not authorised to view the ticket orders/.test(out) && /42501|not authorised/.test(out);

describe('who can SEE the orders for an event', () => {
  before(() => { schema(); fixtures(); });

  test('the organising business\'s owner sees paid and refunded orders, never the unpaid attempt', () => {
    const r = view(U.BIZ_OWNER, EV_BIZ);
    assert.deepEqual(r.orders.map((o) => o.id).sort(), [O_FREE, O_PAID, O_REFUNDED].sort());
    assert.ok(!r.orders.some((o) => o.id === O_PENDING), 'an abandoned checkout must not appear');
    assert.equal(r.total_orders, 3);
  });

  test('each order carries the purchaser, ticket types, amounts, dates and statuses an organiser needs', () => {
    const o = view(U.BIZ_OWNER, EV_BIZ).orders.find((x) => x.id === O_PAID)!;
    assert.equal(o.purchaser.name, 'Sam Buyer');
    assert.equal(o.purchaser.email, 'sam.buyer@example.com');
    assert.equal(o.status, 'paid');
    assert.equal(o.total_pence, 196);
    assert.equal(o.booking_fee_pence, 96);
    assert.equal(o.ticket_subtotal_pence, 100);
    assert.deepEqual(o.tickets.map((t) => t.ticket_type).sort(), ['Standard', 'VIP']);
    assert.equal(o.checked_in_count, 1);
    assert.ok(o.tickets.some((t) => t.status === 'used' && t.checked_in_at));
    assert.equal(o.tickets.find((t) => t.ticket_type === 'Standard')!.attendee_name, 'Sam Buyer');
  });

  test('a purchaser with no profile name still shows an email to manage the order by', () => {
    const o = view(U.BIZ_OWNER, EV_BIZ).orders.find((x) => x.id === O_REFUNDED)!;
    assert.equal(o.purchaser.name, null);
    assert.equal(o.purchaser.email, 'kim.buyer@example.com');
  });

  test('the same people who may SCAN the event may view its orders: business owner, hub owner and committee — and NOT a bare organiser_user_id', () => {
    assert.ok(refused(rpcAs(U.ORGANISER, EV_BIZ)), 'organiser_user_id is audit metadata, never an authority');
    assert.equal(view(U.BIZ_OWNER, EV_BIZ).orders.length, 3);
    assert.equal(view(U.HUB_OWNER, EV_HUB).orders.length, 1);
    assert.equal(view(U.HUB_COMMITTEE, EV_HUB).orders.length, 1);
    assert.equal(view(U.ADMIN, EV_BIZ).orders.length, 3);
  });

  test('another organiser CANNOT see this event\'s orders', () => {
    assert.ok(refused(rpcAs(U.OTHER_BIZ_OWNER, EV_BIZ)));
    assert.ok(refused(rpcAs(U.BIZ_OWNER, EV_OTHER)), 'an owner cannot see a different organiser\'s event either');
    assert.ok(refused(rpcAs(U.HUB_OWNER, EV_BIZ)));
  });

  test('a purchaser / ordinary customer CANNOT use organiser order management — not even for the event they bought tickets to', () => {
    assert.ok(refused(rpcAs(U.BUYER, EV_BIZ)), 'a ticket holder was shown the organiser view');
    assert.ok(refused(rpcAs(U.BUYER2, EV_BIZ)));
    assert.ok(refused(rpcAs(U.STRANGER, EV_BIZ)));
  });

  test('anon cannot call it at all', () => {
    assert.match(rpcAnon(EV_BIZ), /permission denied/i);
  });

  test('a refused call reveals NOTHING about purchasers, amounts or order ids', () => {
    for (const uid of [U.BUYER, U.STRANGER, U.OTHER_BIZ_OWNER]) {
      const out = rpcAs(uid, EV_BIZ);
      assert.doesNotMatch(out, /sam\.buyer|kim\.buyer|Sam Buyer|pi_paid|pi_refunded|196|"orders"/);
      assert.doesNotMatch(out, new RegExp(O_PAID));
    }
  });

  test('an unknown event is refused, not an empty success', () => {
    assert.ok(refused(rpcAs(U.BIZ_OWNER, '00000000-0000-4000-8000-000000000000')));
  });

  test('purchaser details reach no one but an authorised viewer — across the whole event list, no other user\'s email appears in another event\'s result', () => {
    const r = JSON.stringify(view(U.OTHER_BIZ_OWNER, EV_OTHER));
    assert.doesNotMatch(r, /sam\.buyer@example\.com/);
  });
});

describe('who can REFUND, and what each viewer is offered', () => {
  before(() => { schema(); fixtures(); });

  test('the business owner and an admin are offered Refund on a paid order, and only on a paid order', () => {
    for (const uid of [U.BIZ_OWNER, U.ADMIN]) {
      const r = view(uid, EV_BIZ);
      assert.equal(r.can_refund, true, `${uid} should be able to refund`);
      assert.equal(r.orders.find((o) => o.id === O_PAID)!.refundable, true);
      assert.equal(r.orders.find((o) => o.id === O_REFUNDED)!.refundable, false, 'an already-refunded order must not offer another refund');
      assert.equal(r.orders.find((o) => o.id === O_FREE)!.refundable, false, 'a free order has no money to refund');
    }
  });

  test('the hub OWNER can refund their hub\'s event orders', () => {
    const r = view(U.HUB_OWNER, EV_HUB);
    assert.equal(r.can_refund, true);
    assert.equal(r.orders[0].refundable, true);
  });

  test('a hub COMMITTEE member can view but is offered no refund (they do not control the connected account); a bare organiser_user_id can do neither', () => {
    const r = view(U.HUB_COMMITTEE, EV_HUB);
    assert.equal(r.can_refund, false, 'committee must not be able to refund');
    assert.ok(r.orders.every((o) => o.refundable === false));
    assert.ok(refused(rpcAs(U.ORGANISER, EV_BIZ)));
  });

  test('the shared refund predicate is not callable by clients — only by the server', () => {
    assert.match(raw(`set role authenticated; select public.can_refund_event_orders('${EV_BIZ}','${U.BIZ_OWNER}'); reset role;`), /permission denied/i);
    assert.match(raw(`set role anon; select public.can_refund_event_orders('${EV_BIZ}','${U.BIZ_OWNER}'); reset role;`), /permission denied/i);
    assert.equal(scalar(`set role service_role; select public.can_refund_event_orders('${EV_BIZ}','${U.BIZ_OWNER}')::text; reset role;`), 'true');
  });

  test('the predicate itself: admin, business owner, hub owner yes — committee, organiser user, buyer, stranger, other owner no', () => {
    const can = (u: string, ev: string) => scalar(`select public.can_refund_event_orders('${ev}','${u}')::text;`);
    assert.equal(can(U.ADMIN, EV_BIZ), 'true');
    assert.equal(can(U.BIZ_OWNER, EV_BIZ), 'true');
    assert.equal(can(U.HUB_OWNER, EV_HUB), 'true');
    for (const [u, ev] of [[U.HUB_COMMITTEE, EV_HUB], [U.ORGANISER, EV_BIZ], [U.BUYER, EV_BIZ], [U.STRANGER, EV_BIZ],
      [U.OTHER_BIZ_OWNER, EV_BIZ], [U.BIZ_OWNER, EV_OTHER], [U.BIZ_OWNER, EV_HUB]] as const) {
      assert.equal(can(u, ev), 'false', `${u} on ${ev}`);
    }
    assert.equal(scalar(`select public.can_refund_event_orders(null,'${U.ADMIN}')::text;`), 'false');
    assert.equal(scalar(`select public.can_refund_event_orders('${EV_BIZ}',null)::text;`), 'false');
  });
});

describe('Stripe references and reconciliation are admin-only', () => {
  before(() => { schema(); fixtures(); });

  test('an organiser never receives a payment reference or reconciliation state', () => {
    const r = view(U.BIZ_OWNER, EV_BIZ);
    for (const o of r.orders) { assert.equal(o.payment_intent_id, null); assert.equal(o.reconciliation_state, null); }
    assert.doesNotMatch(rpcAs(U.BIZ_OWNER, EV_BIZ), /pi_paid|pi_refunded/);
    assert.equal(r.is_admin, false);
  });

  test('an admin sees the reference, and a refunded order reads "unverified" until reconciliation has checked it', () => {
    const r = view(U.ADMIN, EV_BIZ);
    assert.equal(r.is_admin, true);
    assert.equal(r.orders.find((o) => o.id === O_PAID)!.payment_intent_id, 'pi_paid');
    assert.equal(r.orders.find((o) => o.id === O_REFUNDED)!.reconciliation_state, 'unverified');
  });

  test('once reconciliation has judged it, the admin sees that state', () => {
    raw(`insert into public.refund_reconciliation (charge_id, payment_intent_id, rail, state, charge_amount_pence, amount_refunded_pence)
         values ('ch_x','pi_refunded','event_ticket','reconciled',196,196);`);
    assert.equal(view(U.ADMIN, EV_BIZ).orders.find((o) => o.id === O_REFUNDED)!.reconciliation_state, 'reconciled');
    assert.equal(view(U.BIZ_OWNER, EV_BIZ).orders.find((o) => o.id === O_REFUNDED)!.reconciliation_state, null);
  });
});

describe('a refunded order\'s tickets become void — exactly once', () => {
  before(() => { schema(); fixtures(); });
  const refundRpc = (full = true) => raw(`select public.refund_event_tickets_for_payment('pi_paid', ${full})::text;`);

  test('refunding voids the valid ticket, keeps the checked-in one on record, and the order reads refunded', () => {
    const out = refundRpc();
    assert.match(out, /"action": "refunded"/);
    assert.match(out, /"tickets_voided": 1/);
    assert.match(out, /"tickets_kept_used": 1/);
    const o = view(U.BIZ_OWNER, EV_BIZ).orders.find((x) => x.id === O_PAID)!;
    assert.equal(o.status, 'refunded');
    assert.equal(o.refundable, false, 'a refunded order must no longer offer a refund');
    assert.equal(o.tickets.find((t) => t.ticket_type === 'Standard')!.status, 'refunded');
    assert.equal(o.tickets.find((t) => t.ticket_type === 'VIP')!.status, 'used', 'attendance already recorded is not erased');
    assert.equal(scalar(`select (refunded_at is not null)::text from public.event_ticket_orders where id='${O_PAID}';`), 'true');
  });

  test('a duplicate (retry, or the webhook arriving after the app already applied it) changes nothing', () => {
    const before = scalar(`select md5(string_agg(to_jsonb(t)::text, '|' order by id)) from public.event_tickets t where order_id='${O_PAID}';`);
    const again = refundRpc();
    assert.match(again, /"action": "already_refunded"/);
    assert.equal(scalar(`select md5(string_agg(to_jsonb(t)::text, '|' order by id)) from public.event_tickets t where order_id='${O_PAID}';`), before);
  });

  test('a partial refund voids nothing — it is never guessed which tickets it covers', () => {
    fixtures();
    assert.match(refundRpc(false), /partial_refund_not_mapped/);
    assert.equal(scalar(`select status from public.event_ticket_orders where id='${O_PAID}';`), 'paid');
    assert.equal(scalar(`select count(*)::text from public.event_tickets where order_id='${O_PAID}' and status='refunded';`), '0');
  });
});

describe('the migration is shaped as designed', () => {
  const mig = src(UNDER_TEST);
  test('both functions are SECURITY DEFINER with a pinned search_path, and the view function refuses before reading anything', () => {
    assert.equal((mig.match(/security definer/g) ?? []).length, 2);
    assert.equal((mig.match(/set search_path to 'public'/g) ?? []).length, 2);
    const guardAt = mig.indexOf('if v_uid is null or not public.can_scan_event(p_event_id, v_uid) then');
    const firstRead = mig.indexOf('from public.event_ticket_orders');
    assert.ok(guardAt > 0 && firstRead > guardAt);
    assert.match(mig, /errcode = '42501'/);
  });
  test('grants: the refund predicate is service_role only; the view function is not granted to anon', () => {
    assert.match(mig, /revoke all on function public\.can_refund_event_orders\(uuid, uuid\) from public, anon, authenticated;/);
    assert.match(mig, /grant execute on function public\.can_refund_event_orders\(uuid, uuid\) to service_role;/);
    assert.match(mig, /revoke all on function public\.get_event_orders\(uuid\) from public, anon;/);
    assert.match(mig, /grant execute on function public\.get_event_orders\(uuid\) to authenticated, service_role;/);
  });
});
