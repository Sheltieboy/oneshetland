/**
 * business-claims-flow.node.test.ts — claim → admin approval → owner, against the real SQL.
 *
 * WHAT WAS WRONG
 *
 * "Users manage their own claims" was FOR ALL, so a claimant could edit or delete a claim after submitting it:
 * swap business_id after the admin had read it (approve_business_claim reads the row at approval time, so the
 * admin could hand over a different, more valuable listing than the one they were shown), forge 'approved' or
 * the reviewer, or erase the record. And one free account could queue hundreds of pending claims. Migration
 * 20261031030000 leaves claimants able to SUBMIT a pending claim and READ their own, nothing else, and caps open
 * claims at five.
 *
 * WHAT IS ASSERTED — against the real function, policies and trigger, executed
 *   A  a claimant submits a pending claim and can read it (and only theirs)
 *   B  a claimant cannot submit it pre-approved / pre-reviewed, nor for someone else
 *   C  a claimant cannot edit, re-point, self-approve or delete a claim
 *   D  at most five claims wait for review per person; a decision frees a slot; one pending per listing
 *   E  only an admin can approve; approval makes the claimant the verified owner, records who decided, and
 *      auto-rejects rival pending claims; it cannot be applied twice
 *   F  the new owner can manage their listing and a stranger cannot — the last step, "to the dashboard"
 *   G  an admin can reject, and the claimant sees the outcome — with the decider and time on record
 *
 * SAFETY — ISOLATED DATABASE ONLY: requires PASS_PROOF_DSN, refuses a DSN mentioning Supabase.
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
const FIX = join(MIG, '20261031030000_business_claims_claimants_submit_only.sql');
const DECIDER = join(MIG, '20261031040000_business_claims_record_the_decider.sql');
const DSN = process.env.PASS_PROOF_DSN ?? '';
const PSQL = process.env.PASS_PROOF_PSQL ?? 'psql';
const src = (p: string) => readFileSync(p, 'utf8');

function raw(body: string): string {
  try {
    return execFileSync(PSQL, [DSN, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=0', '-c', body],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
  } catch (e) { const err = e as { stdout?: string; stderr?: string }; return `${err.stdout ?? ''}${err.stderr ?? ''}`; }
}
const TAG = /^(SET|RESET|BEGIN|COMMIT|DO|GRANT|REVOKE|COMMENT|CREATE .*|DROP .*|INSERT \d+ \d+|UPDATE \d+|DELETE \d+)$/;
const rowsOf = (out: string) => out.split('\n').map((l) => l.trim()).filter((l) => l && !TAG.test(l));
const scalar = (sql: string) => rowsOf(raw(sql)).pop() ?? '';
const asUser = (uid: string | null, sql: string) =>
  raw(`begin; ${uid ? `set local request.jwt.claim.sub = '${uid}';` : ''} set local role ${uid ? 'authenticated' : 'anon'}; ${sql}; commit;`);

function slice(file: string, opener: string, closer: string): string {
  const s = src(file); const start = s.indexOf(opener);
  assert.notEqual(start, -1, `${opener} is gone from ${file}`);
  const end = s.indexOf(closer, start); assert.notEqual(end, -1);
  return s.slice(start, end + closer.length);
}
function createTable(file: string, opener: string): string {
  const s = src(file); const start = s.indexOf(opener); assert.notEqual(start, -1, `${opener} is gone`);
  const open = s.indexOf('(', start); let d = 0, end = -1;
  for (let i = open; i < s.length; i++) { if (s[i] === '(') d++; else if (s[i] === ')') { d--; if (d === 0) { end = i; break; } } }
  return s.slice(start, end + 1) + ';';
}
const policies = (table: string) =>
  [...src(BASELINE).matchAll(new RegExp(`CREATE POLICY "[^"]+" ON public\\.${table}[^;]*;`, 'g'))].map((m) => m[0]);

const ADMIN = 'a0a0a0a0-0000-4000-8000-a0a0a0a0a0a0';
const ALICE = 'a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1';
const BOB = 'b2b2b2b2-2222-4222-8222-b2b2b2b2b2b2';
const EVE = 'e3e3e3e3-3333-4333-8333-e3e3e3e3e3e3';
const CAFE = 'c1c1c1c1-aaaa-4aaa-8aaa-c1c1c1c1c1c1';
const SHOP = 'c2c2c2c2-bbbb-4bbb-8bbb-c2c2c2c2c2c2';
const BAKERY = 'c3c3c3c3-cccc-4ccc-8ccc-c3c3c3c3c3c3';
const listing = (n: number) => `d${n}d${n}d${n}d${n}-0000-4000-8000-${String(n).padStart(12, '0')}`;

before(() => {
  assert.ok(DSN, 'PASS_PROOF_DSN is not set — run `npm run test:isolated`.');
  assert.ok(!/supabase\.co|pooler\.supabase/.test(DSN), 'PASS_PROOF_DSN points at Supabase. Refusing to run.');
  const out = raw([
    'drop schema if exists public cascade; create schema public;',
    'drop schema if exists auth cascade; create schema auth;',
    `do $r$ begin
       if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
       if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
       if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
     end $r$;`,
    'alter role service_role bypassrls;',
    'grant usage on schema public, auth to anon, authenticated, service_role;',
    'create table auth.users (id uuid primary key);',
    `create or replace function auth.uid() returns uuid language sql stable as $$
       select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;`,
    'grant execute on function auth.uid() to anon, authenticated, service_role;',
    'create table public.profiles (id uuid primary key, role text default \'customer\');',
    `create table public.local_businesses (id uuid primary key, name text, owner_id uuid, is_active boolean default true,
       is_claimed boolean default false, is_verified boolean default false, claimed_at timestamptz, verified_at timestamptz,
       description text);`,
    'alter table public.local_businesses enable row level security;',
    ...policies('local_businesses'),
    createTable(BASELINE, 'CREATE TABLE public.business_claims ('),
    'alter table public.business_claims add primary key (id);',
    'alter table public.business_claims add foreign key (business_id) references public.local_businesses(id) on delete cascade;',
    'CREATE UNIQUE INDEX uq_business_claims_open ON public.business_claims USING btree (business_id, user_id) WHERE (status = \'pending\'::text);',
    'alter table public.business_claims enable row level security;',
    ...policies('business_claims'),          // the PRE-fix policies, exactly as production had them
    slice(BASELINE, 'CREATE FUNCTION public.approve_business_claim', '$$;'),
    'grant all on all tables in schema public to anon, authenticated, service_role;',
    'grant execute on all functions in schema public to anon, authenticated, service_role, public;',
    src(FIX),
    src(DECIDER),
  ].join('\n'));
  assert.doesNotMatch(out, /ERROR/i, `fixture did not build:\n${out.slice(0, 1500)}`);
  const seed = raw(`
    insert into public.profiles (id, role) values ('${ADMIN}', 'admin'), ('${ALICE}', 'customer'), ('${BOB}', 'customer'), ('${EVE}', 'customer');
    insert into public.local_businesses (id, name) values ('${CAFE}', 'Harbour Café'), ('${SHOP}', 'Voe Gift Shop'), ('${BAKERY}', 'Bakery');
    ${[1,2,3,4,5,6,7].map((n) => `insert into public.local_businesses (id, name) values ('${listing(n)}', 'Filler ${n}');`).join('\n')}`);
  assert.doesNotMatch(seed, /ERROR/i, `seed failed:\n${seed.slice(0, 600)}`);
});

const submit = (uid: string, biz: string, extra = '') =>
  asUser(uid, `insert into public.business_claims (user_id, business_id, contact_name, status${extra ? ', ' + extra.split('=')[0] : ''})
               values ('${uid}', '${biz}', 'Alice', 'pending'${extra ? ', ' + extra.split('=')[1] : ''})`);
const claimId = (uid: string, biz: string) => scalar(`select id from public.business_claims where user_id='${uid}' and business_id='${biz}' order by created_at desc limit 1`);
const statusOf = (id: string) => scalar(`select status from public.business_claims where id='${id}'`);

describe('A — submitting and reading', () => {
  test('a signed-in person submits a pending claim, and sees it', () => {
    const out = submit(ALICE, CAFE);
    assert.doesNotMatch(out, /ERROR|violates|denied/i, out);
    assert.equal(rowsOf(asUser(ALICE, `select status from public.business_claims where business_id='${CAFE}'`)).pop(), 'pending');
  });
  test('they cannot see anyone else\'s claim; nor can a signed-out visitor', () => {
    submit(BOB, SHOP);
    assert.deepEqual(rowsOf(asUser(ALICE, `select id from public.business_claims where user_id='${BOB}'`)), []);
    assert.deepEqual(rowsOf(asUser(null, 'select id from public.business_claims')), []);
    assert.match(asUser(null, `insert into public.business_claims (user_id, business_id, status) values ('${ALICE}', '${BAKERY}', 'pending')`), /row-level security|denied/i);
  });
});

describe('B0 — the app\'s own submission (no status sent) still works', () => {
  test('mobile submitBusinessClaim sends no status; the column default is pending and passes the policy', () => {
    const out = asUser(ALICE, `insert into public.business_claims (user_id, business_id, contact_name, evidence) values ('${ALICE}', '${listing(4)}', 'Alice', 'Owner since 2019')`);
    assert.doesNotMatch(out, /ERROR|violates|denied/i, out);
    assert.equal(scalar(`select status from public.business_claims where user_id='${ALICE}' and business_id='${listing(4)}'`), 'pending');
    raw(`delete from public.business_claims where user_id='${ALICE}' and business_id='${listing(4)}'`);
  });
});

describe('B — a claim cannot arrive pre-decided or in someone else\'s name', () => {
  test('THE DEFECT: inserting as approved is refused', () => {
    const out = asUser(EVE, `insert into public.business_claims (user_id, business_id, status) values ('${EVE}', '${BAKERY}', 'approved')`);
    assert.match(out, /row-level security/i);
  });
  test('inserting with a reviewer or reviewed time is refused', () => {
    assert.match(asUser(EVE, `insert into public.business_claims (user_id, business_id, status, reviewed_by) values ('${EVE}', '${BAKERY}', 'pending', '${ADMIN}')`), /row-level security/i);
    assert.match(asUser(EVE, `insert into public.business_claims (user_id, business_id, status, reviewed_at) values ('${EVE}', '${BAKERY}', 'pending', now())`), /row-level security/i);
    assert.match(asUser(EVE, `insert into public.business_claims (user_id, business_id, status, admin_note) values ('${EVE}', '${BAKERY}', 'pending', 'approved already')`), /row-level security/i);
  });
  test('a claim in another person\'s name is refused', () => {
    assert.match(asUser(EVE, `insert into public.business_claims (user_id, business_id, status) values ('${ALICE}', '${BAKERY}', 'pending')`), /row-level security/i);
  });
});

describe('C — a claimant cannot alter or remove their claim', () => {
  test('THE DEFECT: re-pointing a claim at a different listing changes nothing', () => {
    const id = claimId(ALICE, CAFE);
    asUser(ALICE, `update public.business_claims set business_id = '${BAKERY}' where id = '${id}'`);
    assert.equal(scalar(`select business_id from public.business_claims where id='${id}'`), CAFE);
  });
  test('self-approval, a forged reviewer and an edited note all change nothing', () => {
    const id = claimId(ALICE, CAFE);
    asUser(ALICE, `update public.business_claims set status='approved', reviewed_by='${ADMIN}', reviewed_at=now(), admin_note='ok' where id='${id}'`);
    assert.equal(statusOf(id), 'pending');
    assert.equal(scalar(`select reviewed_by is null and admin_note is null from public.business_claims where id='${id}'`), 't');
  });
  test('deleting the claim removes nothing', () => {
    const id = claimId(ALICE, CAFE);
    asUser(ALICE, `delete from public.business_claims where id='${id}'`);
    assert.equal(scalar(`select count(*) from public.business_claims where id='${id}'`), '1');
  });
  test('and nobody else can touch it either', () => {
    const id = claimId(ALICE, CAFE);
    asUser(BOB, `update public.business_claims set status='rejected' where id='${id}'; delete from public.business_claims where id='${id}'`);
    assert.equal(statusOf(id), 'pending');
  });
});

describe('D — limits', () => {
  test('a sixth waiting claim is refused, with a message a person can act on', () => {
    for (let n = 1; n <= 4; n++) submit(EVE, listing(n));         // 4 + the earlier refused attempts that never inserted
    submit(EVE, BAKERY);                                           // the fifth
    assert.equal(scalar(`select count(*) from public.business_claims where user_id='${EVE}' and status='pending'`), '5');
    const out = submit(EVE, listing(5));
    assert.match(out, /already have 5 claims waiting for review/i);
    assert.equal(scalar(`select count(*) from public.business_claims where user_id='${EVE}'`), '5');
  });
  test('a decision frees a slot', () => {
    const one = claimId(EVE, listing(1));
    raw(`update public.business_claims set status='rejected' where id='${one}'`);
    assert.doesNotMatch(submit(EVE, listing(6)), /already have 5|ERROR/i);
  });
  test('only one pending claim per person per listing', () => {
    assert.match(submit(ALICE, CAFE), /duplicate key|uq_business_claims_open/i);
  });
  test('other people are not held back by someone else\'s five', () => {
    assert.doesNotMatch(submit(BOB, listing(7)), /ERROR|already have 5/i);
  });
});

describe('E — approval makes the claimant the verified owner', () => {
  test('a non-admin cannot approve — not the claimant, not a stranger', () => {
    const id = claimId(ALICE, CAFE);
    assert.match(asUser(ALICE, `select public.approve_business_claim('${id}')`), /Only admins can approve claims/);
    assert.match(asUser(BOB, `select public.approve_business_claim('${id}')`), /Only admins can approve claims/);
    assert.equal(scalar(`select owner_id is null from public.local_businesses where id='${CAFE}'`), 't');
    assert.equal(statusOf(id), 'pending');
  });
  test('an admin approves: owner set, listing claimed and verified, the decision and decider recorded', () => {
    // a rival claim on the same listing
    submit(BOB, CAFE);
    const id = claimId(ALICE, CAFE);
    const out = asUser(ADMIN, `select public.approve_business_claim('${id}')`);
    assert.doesNotMatch(out, /ERROR/i, out);
    assert.equal(scalar(`select owner_id from public.local_businesses where id='${CAFE}'`), ALICE);
    assert.equal(scalar(`select is_claimed and is_verified and claimed_at is not null and verified_at is not null from public.local_businesses where id='${CAFE}'`), 't');
    assert.equal(statusOf(id), 'approved');
    assert.equal(scalar(`select reviewed_by from public.business_claims where id='${id}'`), ADMIN);
    assert.equal(scalar(`select reviewed_at is not null from public.business_claims where id='${id}'`), 't');
  });
  test('the rival claim on the same listing is auto-rejected, with a note', () => {
    const rival = claimId(BOB, CAFE);
    assert.equal(statusOf(rival), 'rejected');
    assert.match(scalar(`select admin_note from public.business_claims where id='${rival}'`), /auto-rejected: another claim approved/);
  });
  test('approving a decided claim again is refused and changes nothing', () => {
    const id = claimId(ALICE, CAFE);
    assert.match(asUser(ADMIN, `select public.approve_business_claim('${id}')`), /Claim already approved/);
    assert.match(asUser(ADMIN, `select public.approve_business_claim('00000000-0000-4000-8000-000000000000')`), /Claim not found/);
    assert.equal(scalar(`select owner_id from public.local_businesses where id='${CAFE}'`), ALICE);
  });
  test('an unrelated listing the claimant did not claim is untouched', () => {
    assert.equal(scalar(`select owner_id is null from public.local_businesses where id='${BAKERY}'`), 't');
  });
});

describe('F — the new owner can manage the listing; a stranger cannot', () => {
  test('the owner can edit their own listing', () => {
    asUser(ALICE, `update public.local_businesses set description = 'Fresh coffee by the harbour' where id='${CAFE}'`);
    assert.equal(scalar(`select description from public.local_businesses where id='${CAFE}'`), 'Fresh coffee by the harbour');
  });
  test('a stranger (including the rejected rival) cannot edit it', () => {
    asUser(BOB, `update public.local_businesses set description = 'defaced' where id='${CAFE}'`);
    assert.equal(scalar(`select description from public.local_businesses where id='${CAFE}'`), 'Fresh coffee by the harbour');
  });
  test('before approval the claimant could not edit it (the claim itself grants nothing)', () => {
    asUser(BOB, `update public.local_businesses set description = 'mine' where id='${SHOP}'`);
    assert.notEqual(scalar(`select description from public.local_businesses where id='${SHOP}'`), 'mine');
  });
});

describe('G — rejection', () => {
  test('an admin can reject; the claimant reads the outcome; the listing stays unclaimed', () => {
    const id = claimId(BOB, SHOP);
    asUser(ADMIN, `update public.business_claims set status='rejected', reviewed_at=now(), reviewed_by='${ADMIN}', admin_note='Could not verify' where id='${id}'`);
    assert.equal(rowsOf(asUser(BOB, `select status from public.business_claims where id='${id}'`)).pop(), 'rejected');
    assert.equal(scalar(`select owner_id is null from public.local_businesses where id='${SHOP}'`), 't');
  });
  test('a non-admin cannot reject someone else\'s claim', () => {
    submit(EVE, listing(2));
    const id = claimId(EVE, listing(2));
    asUser(BOB, `update public.business_claims set status='rejected' where id='${id}'`);
    assert.equal(statusOf(id), 'pending');
  });
});

describe('H — every decision records who made it', () => {
  test('a rejection from the web screen (status only) still records the admin and the time', () => {
    submit(ALICE, BAKERY);
    const id = claimId(ALICE, BAKERY);
    asUser(ADMIN, `update public.business_claims set status='rejected' where id='${id}'`);
    assert.equal(scalar(`select reviewed_by from public.business_claims where id='${id}'`), ADMIN);
    assert.equal(scalar(`select reviewed_at is not null from public.business_claims where id='${id}'`), 't');
  });
  test('a rejection from the app (time only) still records the admin', () => {
    submit(BOB, BAKERY);
    const id = claimId(BOB, BAKERY);
    asUser(ADMIN, `update public.business_claims set status='rejected', reviewed_at=now(), admin_note='No link to the business' where id='${id}'`);
    assert.equal(scalar(`select reviewed_by from public.business_claims where id='${id}'`), ADMIN);
  });
  test('an explicit decider is kept, and editing a decided claim does not rewrite the record', () => {
    const id = claimId(BOB, BAKERY);
    const t = scalar(`select reviewed_at::text from public.business_claims where id='${id}'`);
    asUser(ADMIN, `update public.business_claims set admin_note='Updated note' where id='${id}'`);
    assert.equal(scalar(`select reviewed_at::text from public.business_claims where id='${id}'`), t);
    assert.equal(scalar(`select reviewed_by from public.business_claims where id='${id}'`), ADMIN);
  });
  test('the trigger function is not callable by clients', () => {
    assert.match(asUser(ALICE, 'select public.business_claims_record_decider()'), /permission denied|trigger functions can only be called as triggers/i);
  });
});
