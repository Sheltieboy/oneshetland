/**
 * commercial-terms-enforcement.node.test.ts — the terms as a rule, not a screen.
 *
 * W3G made an acceptance record nobody can forge. W3H put it in front of every
 * commercial screen. This is the part that does not depend on a screen: an
 * owner with the anon key and curl gets the same answer as an owner tapping a
 * button, because the boundary is in the database.
 *
 * Everything here runs against the live project inside transactions that are
 * rolled back, using disposable probe identities. Nothing genuine is touched.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');

function sql(body: string): Record<string, unknown>[] {
  const out = execFileSync('npx',
    ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${body}`, '--output-format', 'json'],
    { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 240_000 });
  const parsed = JSON.parse(out.slice(out.indexOf('{'))) as { rows?: Record<string, unknown>[]; error?: unknown };
  if (parsed.error) throw new Error(JSON.stringify(parsed.error).slice(0, 400));
  return parsed.rows ?? [];
}

const OWNER    = 'e0e00001-1111-1111-1111-111111111111';
const BIZ_A    = 'e0e00002-2222-2222-2222-222222222222';
const BIZ_B    = 'e0e00003-3333-3333-3333-333333333333';
const STRANGER = 'e0e00004-4444-4444-4444-444444444444';
const PRODUCT  = 'e0e00005-5555-5555-5555-555555555555';

/** Two businesses under one owner, plus an unrelated stranger. */
const FIXTURE = `
begin;
  insert into auth.users (id, email) values
    ('${OWNER}','w3i-owner@probe.invalid'), ('${STRANGER}','w3i-stranger@probe.invalid');
  insert into public.local_businesses (id, owner_id, name, category, address, is_active) values
    ('${BIZ_A}', '${OWNER}', 'PROBE A', 'other', 'PROBE', true),
    ('${BIZ_B}', '${OWNER}', 'PROBE B', 'other', 'PROBE', true);
  -- These suites are about commercial TERMS. Selling and taking bookings are
  -- also tier-gated now, so the fixture businesses are given the plans their
  -- writes require — otherwise a refusal here could be either boundary and the
  -- test would no longer be measuring the one it is named after.
  update public.local_businesses set subscription_tier='premium',
         subscription_until = now() + interval '30 days'
   where id in ('${BIZ_A}', '${BIZ_B}');
  create temp table r(step text, outcome text) on commit drop;
  grant insert, select on r to authenticated, anon;
`;

const asUser = (id: string) => `
  reset role;
  select set_config('request.jwt.claims','{"sub":"${id}","role":"authenticated"}',true);
  set local role authenticated;
`;

/** Attempt a write and record whether it was allowed, without aborting. */
const attempt = (step: string, statement: string) => `
do $p$ begin
  ${statement};
  insert into r values ('${step}','ALLOWED');
exception when others then insert into r values ('${step}','refused'); end $p$;
`;

const END = `reset role; select * from r order by step; rollback;`;
const outcome = (rows: Record<string, unknown>[], step: string) =>
  rows.find((r) => r.step === step)?.outcome;

/**
 * One INSERT per commercial table. A product is created first so variants have
 * a parent; every statement is the smallest legal row for that table.
 */
const WRITES: [string, string][] = [
  ['products',                `insert into public.products (id,business_id,title,price_pence,is_active) values ('${PRODUCT}','${BIZ_A}','PROBE',100,true)`],
  ['product_variants',        `insert into public.product_variants (product_id,name) values ('${PRODUCT}','PROBE')`],
  ['business_shipping',       `insert into public.business_shipping (business_id) values ('${BIZ_A}')`],
  ['book_services',           `insert into public.book_services (business_id,name,duration_minutes,price_pence) values ('${BIZ_A}','PROBE',30,100)`],
  ['book_unit_items',         `insert into public.book_unit_items (business_id,name,price_pence) values ('${BIZ_A}','PROBE',100)`],
  ['book_availability_rules', `insert into public.book_availability_rules (business_id,day_of_week,start_time,end_time) values ('${BIZ_A}',1,'09:00','17:00')`],
  ['local_offers',            `insert into public.local_offers (business_id,title,valid_until) values ('${BIZ_A}','PROBE',now()+interval '7 days')`],
  ['local_loyalty_programs',  `insert into public.local_loyalty_programs (business_id,type) values ('${BIZ_A}','stamps')`],
  ['events',                  `insert into public.events (organiser_business_id,organiser_user_id,title,starts_at) values ('${BIZ_A}','${OWNER}','PROBE',now()+interval '7 days')`],
];

/* ── 1. Every commercial boundary, both sides of acceptance ─────────────── */

describe('nine tables, one rule', () => {
  const rows = sql(
    FIXTURE + asUser(OWNER) +
    WRITES.map(([t, s]) => attempt(`before ${t}`, s)).join('') +
    `select public.record_commercial_terms_acceptance('${BIZ_A}'::uuid);` +
    WRITES.map(([t, s]) => attempt(`after ${t}`, s)).join('') +
    END,
  );

  for (const [table] of WRITES) {
    test(`${table}: refused without acceptance, allowed with it`, () => {
      assert.equal(outcome(rows, `before ${table}`), 'refused',
        `${table} accepted a write from an owner who has not accepted the terms`);
      assert.equal(outcome(rows, `after ${table}`), 'ALLOWED',
        `${table} refused a legitimate write after acceptance — a regression, not a gate`);
    });
  }
});

/* ── 2. Who the acceptance is for ───────────────────────────────────────── */

describe('the acceptance is one user, one business, one version', () => {
  test('a stranger cannot write, even having accepted for their own business', () => {
    const rows = sql(
      FIXTURE +
      `insert into public.local_businesses (id, owner_id, name, category, address, is_active)
         values ('e0e00006-6666-6666-6666-666666666666','${STRANGER}','PROBE S','other','PROBE',true);` +
      asUser(STRANGER) +
      `select public.record_commercial_terms_acceptance('e0e00006-6666-6666-6666-666666666666'::uuid);` +
      attempt('stranger writes to A', WRITES[0][1]) +
      END,
    );
    assert.equal(outcome(rows, 'stranger writes to A'), 'refused');
  });

  test('accepting for business A does not open business B', () => {
    const rows = sql(
      FIXTURE + asUser(OWNER) +
      `select public.record_commercial_terms_acceptance('${BIZ_A}'::uuid);` +
      attempt('write to A', `insert into public.products (business_id,title,price_pence) values ('${BIZ_A}','PROBE',100)`) +
      attempt('write to B', `insert into public.products (business_id,title,price_pence) values ('${BIZ_B}','PROBE',100)`) +
      END,
    );
    assert.equal(outcome(rows, 'write to A'), 'ALLOWED');
    assert.equal(outcome(rows, 'write to B'), 'refused');
  });

  test('an acceptance of an older version does not permit a write today', () => {
    const rows = sql(
      FIXTURE +
      `insert into public.compliance_log (user_id, user_email, event_type, document_version, metadata)
         values ('${OWNER}','w3i-owner@probe.invalid','business.commercial_terms_accepted','0.9',
                 jsonb_build_object('business_id','${BIZ_A}'));` +
      asUser(OWNER) +
      attempt('write on a stale acceptance', WRITES[0][1]) +
      `select public.record_commercial_terms_acceptance('${BIZ_A}'::uuid);` +
      attempt('write on the current one', WRITES[0][1]) +
      END,
    );
    assert.equal(outcome(rows, 'write on a stale acceptance'), 'refused');
    assert.equal(outcome(rows, 'write on the current one'), 'ALLOWED');
  });

  test('the predicate refuses to answer about anybody else', () => {
    // W3G.1's boundary, kept: it must be callable by authenticated for the
    // policies to run, so it guards itself.
    const rows = sql(
      FIXTURE + asUser(OWNER) +
      attempt('ask about the stranger', `perform public.business_may_transact('${BIZ_A}'::uuid, '${STRANGER}'::uuid)`) +
      attempt('ask about yourself', `perform public.business_may_transact('${BIZ_A}'::uuid, '${OWNER}'::uuid)`) +
      END,
    );
    assert.equal(outcome(rows, 'ask about the stranger'), 'refused');
    assert.equal(outcome(rows, 'ask about yourself'), 'ALLOWED');
  });
});

/* ── 3. The Directory must keep working ─────────────────────────────────── */

describe('a Directory listing is not a shopfront', () => {
  const rows = sql(
    FIXTURE + asUser(OWNER) +
    attempt('directory description', `update public.local_businesses set description='PROBE edit' where id='${BIZ_A}'`) +
    attempt('directory hours',       `update public.local_businesses set opening_hours='{"mon":"9-5"}'::jsonb where id='${BIZ_A}'`) +
    attempt('use_business_payment',  `update public.local_businesses set use_business_payment=true where id='${BIZ_A}'`) +
    attempt('accepts_wallet',        `update public.local_businesses set accepts_wallet=true where id='${BIZ_A}'`) +
    attempt('cashback_percent',      `update public.local_businesses set cashback_percent=5 where id='${BIZ_A}'`) +
    attempt('use_business_payout',   `update public.local_businesses set use_business_payout=true where id='${BIZ_A}'`) +
    `select public.record_commercial_terms_acceptance('${BIZ_A}'::uuid);` +
    attempt('accepts_wallet after',      `update public.local_businesses set accepts_wallet=true where id='${BIZ_A}'`) +
    attempt('cashback_percent after',    `update public.local_businesses set cashback_percent=5 where id='${BIZ_A}'`) +
    attempt('use_business_payout after', `update public.local_businesses set use_business_payout=true where id='${BIZ_A}'`) +
    END,
  );

  for (const field of ['directory description', 'directory hours']) {
    test(`${field} still works without accepting anything`, () => {
      assert.equal(outcome(rows, field), 'ALLOWED', 'Directory management must never require seller terms');
    });
  }

  test('use_business_payment is not seller activity and stays open', () => {
    assert.equal(outcome(rows, 'use_business_payment'), 'ALLOWED');
  });

  for (const field of ['accepts_wallet', 'cashback_percent', 'use_business_payout']) {
    test(`${field} is refused before acceptance and allowed after`, () => {
      assert.equal(outcome(rows, field), 'refused');
      assert.equal(outcome(rows, `${field} after`), 'ALLOWED');
    });
  }

  test('an unrelated update to the same row does not trip the guard', () => {
    // The row holds commercial columns; touching anything else must not care.
    const solo = sql(
      FIXTURE + asUser(OWNER) +
      `update public.local_businesses set accepts_wallet = accepts_wallet where id='${BIZ_A}';` +
      attempt('no-op on a commercial column', `update public.local_businesses set description='PROBE' where id='${BIZ_A}'`) +
      END,
    );
    assert.equal(outcome(solo, 'no-op on a commercial column'), 'ALLOWED');
  });
});

/* ── 3b. Taking something down is not selling ───────────────────────────── */

/**
 * The rule that made this a trigger rather than a policy. An owner who has not
 * accepted may withdraw what they already offer — and may change nothing else
 * while doing it. Withdrawal mechanisms are the product's own: is_active on
 * most tables, the three enabled flags on shipping, is_hidden and status on
 * events.
 */
describe('an owner who has not accepted may still withdraw', () => {
  const LIVE = `
    insert into public.products (id,business_id,title,price_pence,is_active,stock,stock_mode)
      values ('e0e0000a-0000-0000-0000-00000000000a','${BIZ_A}','PROBE',100,true,5,'tracked');
    insert into public.product_variants (id,product_id,name,is_active)
      values ('e0e0000b-0000-0000-0000-00000000000b','e0e0000a-0000-0000-0000-00000000000a','V',true);
    insert into public.business_shipping (business_id,collect_enabled,fetch_enabled,post_enabled)
      values ('${BIZ_A}',true,true,false);
    insert into public.book_services (id,business_id,name,duration_minutes,price_pence,is_active)
      values ('e0e0000c-0000-0000-0000-00000000000c','${BIZ_A}','S',30,100,true);
    insert into public.book_unit_items (id,business_id,name,price_pence,is_active)
      values ('e0e0000d-0000-0000-0000-00000000000d','${BIZ_A}','U',100,true);
    insert into public.book_availability_rules (id,business_id,day_of_week,start_time,end_time,is_active)
      values ('e0e0000e-0000-0000-0000-00000000000e','${BIZ_A}',1,'09:00','17:00',true);
    insert into public.local_offers (id,business_id,title,valid_until,is_active)
      values ('e0e0000f-0000-0000-0000-00000000000f','${BIZ_A}','O',now()+interval '7 days',true);
    insert into public.local_loyalty_programs (id,business_id,type,is_active)
      values ('e0e00010-0000-0000-0000-000000000010','${BIZ_A}','stamps',true);
    insert into public.events (id,organiser_business_id,organiser_user_id,title,starts_at,is_hidden,status)
      values ('e0e00011-0000-0000-0000-000000000011','${BIZ_A}','${OWNER}','E',now()+interval '7 days',false,'published');
  `;

  const WITHDRAWALS: [string, string][] = [
    ['products',                `update public.products set is_active=false where id='e0e0000a-0000-0000-0000-00000000000a'`],
    ['product_variants',        `update public.product_variants set is_active=false where id='e0e0000b-0000-0000-0000-00000000000b'`],
    ['business_shipping',       `update public.business_shipping set fetch_enabled=false where business_id='${BIZ_A}'`],
    ['book_services',           `update public.book_services set is_active=false where id='e0e0000c-0000-0000-0000-00000000000c'`],
    ['book_unit_items',         `update public.book_unit_items set is_active=false where id='e0e0000d-0000-0000-0000-00000000000d'`],
    ['book_availability_rules', `update public.book_availability_rules set is_active=false where id='e0e0000e-0000-0000-0000-00000000000e'`],
    ['local_offers',            `update public.local_offers set is_active=false where id='e0e0000f-0000-0000-0000-00000000000f'`],
    ['local_loyalty_programs',  `update public.local_loyalty_programs set is_active=false where id='e0e00010-0000-0000-0000-000000000010'`],
    ['events (hide)',           `update public.events set is_hidden=true where id='e0e00011-0000-0000-0000-000000000011'`],
    ['events (cancel)',         `update public.events set status='cancelled' where id='e0e00011-0000-0000-0000-000000000011'`],
  ];

  const REFUSED: [string, string][] = [
    ['reactivate a product',      `update public.products set is_active=true where id='e0e0000a-0000-0000-0000-00000000000a'`],
    ['change the price',          `update public.products set price_pence=200 where id='e0e0000a-0000-0000-0000-00000000000a'`],
    ['change the title',          `update public.products set title='NEW' where id='e0e0000a-0000-0000-0000-00000000000a'`],
    ['increase stock',            `update public.products set stock=99 where id='e0e0000a-0000-0000-0000-00000000000a'`],
    ['withdraw + change price',   `update public.products set is_active=false, price_pence=60 where id='e0e0000a-0000-0000-0000-00000000000a'`],
    ['withdraw + change title',   `update public.products set is_active=false, title='SNEAK' where id='e0e0000a-0000-0000-0000-00000000000a'`],
    ['withdraw + change stock',   `update public.products set is_active=false, stock=99 where id='e0e0000a-0000-0000-0000-00000000000a'`],
    ['enable a shipping method',  `update public.business_shipping set post_enabled=true where business_id='${BIZ_A}'`],
    ['republish an event',        `update public.events set status='published' where id='e0e00011-0000-0000-0000-000000000011'`],
    ['unhide an event',           `update public.events set is_hidden=false where id='e0e00011-0000-0000-0000-000000000011'`],
    ['create something inactive', `insert into public.local_offers (business_id,title,valid_until,is_active) values ('${BIZ_A}','NEW',now()+interval '1 day',false)`],
  ];

  const unaccepted = sql(
    FIXTURE + LIVE + asUser(OWNER) +
    WITHDRAWALS.map(([t, q]) => attempt(`w ${t}`, q)).join('') +
    REFUSED.map(([t, q]) => attempt(`x ${t}`, q)).join('') + END,
  );
  const accepted = sql(
    FIXTURE + LIVE + asUser(OWNER) +
    `select public.record_commercial_terms_acceptance('${BIZ_A}'::uuid);` +
    REFUSED.map(([t, q]) => attempt(`x ${t}`, q)).join('') + END,
  );

  for (const [table] of WITHDRAWALS) {
    test(`${table}: withdrawal is allowed without acceptance`, () => {
      assert.equal(outcome(unaccepted, `w ${table}`), 'ALLOWED',
        `${table} would trap a seller with content they cannot take down`);
    });
  }

  for (const [what] of REFUSED) {
    test(`${what}: refused without acceptance, allowed with it`, () => {
      assert.equal(outcome(unaccepted, `x ${what}`), 'refused',
        'the carve-out is withdrawal only — this is not a withdrawal');
      assert.equal(outcome(accepted, `x ${what}`), 'ALLOWED',
        'accepting the current version must restore ordinary owner behaviour');
    });
  }

  test('no guard is wired for DELETE, and the function survives it if one ever is', () => {
    const [row] = sql(`
      select (select count(*)::int from pg_trigger
               where tgname='commercial_terms_guard' and (tgtype & 8) <> 0) as delete_wired,
             (pg_get_functiondef('public.commercial_terms_write_guard()'::regprocedure)
                ilike '%TG_OP = ''DELETE''%') as handles_delete;`);
    assert.equal(row.delete_wired, 0, 'withdrawing what you offer must never be blocked');
    // On a BEFORE DELETE there is no NEW row; without this the guard would
    // return null and silently swallow the row instead of refusing it.
    assert.equal(row.handles_delete, true);
  });

  test('DELETE stays open, as W3I intended', () => {
    const rows = sql(
      FIXTURE + LIVE + asUser(OWNER) +
      attempt('delete a product', `delete from public.products where id='e0e0000a-0000-0000-0000-00000000000a'`) + END,
    );
    assert.equal(outcome(rows, 'delete a product'), 'ALLOWED');
  });

  test('a version move leaves content live, permits withdrawal, and blocks the rest', () => {
    // The scenario this carve-out exists for. The version is moved inside the
    // transaction; production stays on whatever it is.
    const rows = sql(
      FIXTURE + asUser(OWNER) +
      `select public.record_commercial_terms_acceptance('${BIZ_A}'::uuid);
       insert into public.products (id,business_id,title,price_pence,is_active)
         values ('e0e0000a-0000-0000-0000-00000000000a','${BIZ_A}','PROBE',100,true);
       reset role;
       create or replace function public.commercial_terms_version() returns text
         language sql immutable set search_path=public as $v$ select '99.0'::text $v$;` +
      asUser(OWNER) +
      `insert into r select 'still readable', count(*)::text from public.products
         where id='e0e0000a-0000-0000-0000-00000000000a' and is_active;` +
      attempt('edit under the new version',     `update public.products set price_pence=200 where id='e0e0000a-0000-0000-0000-00000000000a'`) +
      attempt('withdraw under the new version', `update public.products set is_active=false where id='e0e0000a-0000-0000-0000-00000000000a'`) +
      attempt('reactivate under the new version', `update public.products set is_active=true where id='e0e0000a-0000-0000-0000-00000000000a'`) +
      `select public.record_commercial_terms_acceptance('${BIZ_A}'::uuid);` +
      attempt('reactivate after accepting it', `update public.products set is_active=true where id='e0e0000a-0000-0000-0000-00000000000a'`) +
      END,
    );
    assert.equal(outcome(rows, 'still readable'), '1', 'existing content must not disappear on a version move');
    assert.equal(outcome(rows, 'edit under the new version'), 'refused');
    assert.equal(outcome(rows, 'withdraw under the new version'), 'ALLOWED');
    assert.equal(outcome(rows, 'reactivate under the new version'), 'refused');
    assert.equal(outcome(rows, 'reactivate after accepting it'), 'ALLOWED');
  });
});

/* ── 4. Everything that is not a business seller ────────────────────────── */

describe('hubs, admins and people are not sellers', () => {
  test('a hub admin can still create a hub event', () => {
    const rows = sql(
      FIXTURE +
      `insert into public.hubs (id, owner_id, name) values
         ('e0e00007-7777-7777-7777-777777777777','${STRANGER}','PROBE HUB');
       -- Creating a hub already enrols its owner; make sure the row says what
       -- is_hub_admin actually looks for.
       insert into public.hub_members (hub_id, user_id, role, status) values
         ('e0e00007-7777-7777-7777-777777777777','${STRANGER}','owner','active')
       on conflict (hub_id, user_id) do update set role='owner', status='active';` +
      asUser(STRANGER) +
      attempt('hub event', `insert into public.events (organiser_hub_id, title, starts_at)
                            values ('e0e00007-7777-7777-7777-777777777777','PROBE',now()+interval '7 days')`) +
      END,
    );
    assert.equal(outcome(rows, 'hub event'), 'ALLOWED',
      'business seller terms must not be required to run a community hub event');
  });

  test('a person can still create their own event', () => {
    const rows = sql(
      FIXTURE + asUser(STRANGER) +
      attempt('personal event', `insert into public.events (organiser_user_id, title, starts_at)
                                 values ('${STRANGER}','PROBE',now()+interval '7 days')`) +
      END,
    );
    assert.equal(outcome(rows, 'personal event'), 'ALLOWED');
  });

  test('a platform admin is still deliberately able to manage products', () => {
    const rows = sql(
      FIXTURE +
      `update public.profiles set role='admin' where id='${STRANGER}';` +
      asUser(STRANGER) +
      attempt('admin writes a product', WRITES[0][1]) +
      END,
    );
    assert.equal(outcome(rows, 'admin writes a product'), 'ALLOWED',
      'the admin branch of these policies is intentional and must survive');
  });
});

/* ── 5. Reads, and what already exists ──────────────────────────────────── */

describe('nothing that was live stopped being live', () => {
  test('an owner who has not accepted can still read their own commercial rows', () => {
    const rows = sql(
      FIXTURE +
      // Content that already existed before enforcement, owned by somebody who
      // has never accepted. The acceptance log is append-only, so this is
      // seeded directly rather than accepted and then undone.
      `insert into public.products (id,business_id,title,price_pence,is_active)
         values ('${PRODUCT}','${BIZ_A}','PROBE',100,false);` +
      asUser(OWNER) +
      `insert into r select 'reads own inactive product', count(*)::text
         from public.products where id='${PRODUCT}';` +
      attempt('can still delete it', `delete from public.products where id='${PRODUCT}'`) +
      END,
    );
    assert.equal(outcome(rows, 'reads own inactive product'), '1',
      'enforcement is on writes; it must not take away an owner\'s sight of their own rows');
    assert.equal(outcome(rows, 'can still delete it'), 'ALLOWED',
      'withdrawing what you offer must never be blocked');
  });

  test('the public still sees published commercial content', () => {
    const [row] = sql(`
      begin;
        set local role anon;
        create temp table c on commit drop as
          select (select count(*)::int from public.products where is_active) as products,
                 (select count(*)::int from public.local_offers) as offers,
                 (select count(*)::int from public.events) as events;
        reset role;
        select * from c;
      rollback;`);
    assert.ok((row.products as number) >= 0);
    assert.ok((row.events as number) >= 1, 'published events are still readable signed out');
  });
});

/* ── 6. The foundation underneath is unchanged ──────────────────────────── */

describe('the acceptance record itself is as it was', () => {
  test('fabrication is still impossible', () => {
    const rows = sql(
      FIXTURE + asUser(OWNER) +
      attempt('forge an acceptance', `insert into public.compliance_log (user_id,user_email,event_type,document_version,metadata)
        values ('${OWNER}','w3i-owner@probe.invalid','business.commercial_terms_accepted','1.0',
                jsonb_build_object('business_id','${BIZ_A}'))`) +
      attempt('then write a product', WRITES[0][1]) +
      END,
    );
    assert.equal(outcome(rows, 'forge an acceptance'), 'refused');
    assert.equal(outcome(rows, 'then write a product'), 'refused',
      'a forged row must not become a licence to trade');
  });

  test('the writer is still idempotent', () => {
    const [row] = sql(FIXTURE + asUser(OWNER) + `
      create temp table s on commit drop as
        select public.record_commercial_terms_acceptance('${BIZ_A}'::uuid) as first,
               public.record_commercial_terms_acceptance('${BIZ_A}'::uuid) as second;
      reset role;
      select (select first::text from s) as first, (select second::text from s) as second,
             (select count(*)::int from public.compliance_log
               where event_type='business.commercial_terms_accepted' and user_id in (select id from auth.users where email like '%@probe.invalid')) as rows;
      rollback;`);
    assert.match(String(row.second), /"already": ?true/);
    assert.equal(row.rows, 1);
  });

  test('ordinary compliance logging is unaffected', () => {
    const rows = sql(
      FIXTURE + asUser(OWNER) +
      attempt('ordinary compliance event', `insert into public.compliance_log (user_id,user_email,event_type,document_version)
        values ('${OWNER}','w3i-owner@probe.invalid','terms.accepted','1.0')`) +
      END,
    );
    assert.equal(outcome(rows, 'ordinary compliance event'), 'ALLOWED');
  });
});

/* ── 7. The path RLS cannot see ─────────────────────────────────────────── */

describe('the Connect boundary is on the server, before Stripe', () => {
  const fn = read('supabase/functions/local-business-onboard/index.ts');

  test('acceptance is checked before any Stripe call', () => {
    const check = fn.indexOf('business_may_transact');
    const firstStripe = fn.indexOf("stripePost('accounts'");
    const link = fn.indexOf("stripePost('account_links'");
    assert.ok(check > 0, 'the Connect path does not check acceptance at all');
    assert.ok(firstStripe > check && link > check,
      'no Stripe side effect may precede the acceptance check');
  });

  test('it refuses on a missing or unreadable answer', () => {
    assert.match(fn, /if \(termsErr \|\| mayTransact !== true\)/,
      'an error must refuse, not fall through');
    assert.match(fn, /}, 403\);/);
  });

  test('it derives the user server-side and confirms ownership first', () => {
    const user = fn.indexOf('anon.auth.getUser()');
    const owner = fn.indexOf("business.owner_id !== user.id");
    const check = fn.indexOf('business_may_transact');
    assert.ok(user > 0 && owner > user && check > owner,
      'authenticate, then ownership, then acceptance');
    assert.ok(!/business_may_transact[^]{0,200}req\.json/.test(fn),
      'the user must not come from the request body');
  });

  test('nothing else about Connect changed', () => {
    for (const kept of ["type:                          'express'", "country:                       'GB'",
                        'account_onboarding', 'connect-redirect']) {
      assert.ok(fn.includes(kept), `Connect behaviour changed: ${kept}`);
    }
  });
});

/* ── 8. Enforcement is on, and points at one truth ──────────────────────── */

describe('enforcement is live', () => {
  test('every commercial table is guarded, and the guard asks the shared truth', () => {
    // The rule is about CHANGES, so it lives where the old row is visible.
    const rows = sql(`
      select c.relname as tbl
        from pg_trigger t join pg_class c on c.oid = t.tgrelid
       where t.tgname = 'commercial_terms_guard' and not t.tgisinternal;`);
    const guarded = new Set(rows.map((r) => r.tbl));
    for (const t of ['products', 'product_variants', 'business_shipping', 'book_services',
                     'book_unit_items', 'book_availability_rules', 'local_offers',
                     'local_loyalty_programs', 'events']) {
      assert.ok(guarded.has(t), `${t} is not guarded`);
    }
    const [fn] = sql(`select pg_get_functiondef('public.commercial_terms_write_guard()'::regprocedure) as def;`);
    assert.match(String(fn.def), /business_may_transact/, 'the guard must ask the shared acceptance truth');
    assert.match(String(fn.def), /security definer/i);
    assert.match(String(fn.def), /search_path/i);
  });

  test('the existing policies were left exactly as they were', () => {
    // Enforcement was added beside them, not by rewriting them: public reads,
    // admin management, hub events and ticket-holder reads are untouched.
    const [row] = sql(`
      select count(*)::int as touched
        from pg_policy p join pg_class c on c.oid = p.polrelid
       where c.relname in ('products','product_variants','business_shipping','book_services',
                           'book_unit_items','book_availability_rules','local_offers',
                           'local_loyalty_programs','events','local_businesses')
         and coalesce(pg_get_expr(p.polwithcheck,p.polrelid),'') || coalesce(pg_get_expr(p.polqual,p.polrelid),'')
             ilike '%may_transact%';`);
    assert.equal(row.touched, 0, 'no policy should have been rewritten to carry this rule');
  });

  test('a client cannot switch the guard off', () => {
    // A trigger is only a boundary if the roles clients use cannot disable it.
    const rows = sql(
      FIXTURE + asUser(OWNER) +
      attempt('set replica mode', `set session_replication_role = replica`) +
      attempt('disable the trigger', `alter table public.products disable trigger commercial_terms_guard`) +
      END,
    );
    assert.equal(outcome(rows, 'set replica mode'), 'refused');
    assert.equal(outcome(rows, 'disable the trigger'), 'refused');
  });

  test('local_businesses is guarded by column, not by policy', () => {
    const [row] = sql(`
      select (select count(*)::int from pg_trigger
               where tgrelid='public.local_businesses'::regclass
                 and tgname='local_businesses_commercial_guard') as trg,
             (select count(*)::int from pg_policy p join pg_class c on c.oid=p.polrelid
               where c.relname='local_businesses'
                 and coalesce(pg_get_expr(p.polwithcheck,p.polrelid),
                              pg_get_expr(p.polqual,p.polrelid)) ilike '%may_transact%') as pol;`);
    assert.equal(row.trg, 1, 'the column guard is missing');
    assert.equal(row.pol, 0, 'gating the whole local_businesses policy would gate the Directory');
  });

  test('the predicate is not readable by the world', () => {
    const [row] = sql(`
      select has_function_privilege('anon','public.business_may_transact(uuid,uuid)','execute') as anon,
             has_function_privilege('authenticated','public.business_may_transact(uuid,uuid)','execute') as auth,
             has_function_privilege('authenticated','public.has_accepted_commercial_terms(uuid,uuid)','execute') as internal;`);
    assert.equal(row.anon, false, 'signed-out callers have no business asking');
    assert.equal(row.auth, true, 'policies run as the caller and need EXECUTE');
    assert.equal(row.internal, false, 'W3G.1: the arbitrary-user reader stays revoked');
  });
});
