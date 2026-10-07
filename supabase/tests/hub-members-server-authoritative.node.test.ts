/**
 * hub-members-server-authoritative.node.test.ts — a person joins a hub FREE; paid time and tier come from the server.
 *
 * WHAT WAS WRONG
 *
 * hub_members had a guard on UPDATE (tg_hub_members_guard) but none on INSERT. "hub_members join" only checked
 * user_id = auth.uid() AND role = 'member', and tg_hub_member_join_status only sets status — so a signed-in user could insert
 * their own row carrying a PAID tier, paid_until NULL (read everywhere as "lifetime"), last_payment_pence, a Stripe payment id
 * and a member number, without paying. The UPDATE policy had no WITH CHECK and the guard never looked at hub_id / user_id, so a
 * member could also re-point their row at another hub (skipping its approval) or at another person.
 * Migration 20261117000000 adds an INSERT guard and an identity lock for DIRECT client writes only.
 *
 * HOW IT PROVES IT
 *
 * The pre-fix state is rebuilt from the REAL source: the baseline's tables and policies, the migrations that define the current
 * guard, join-status trigger, activate_hub_membership, hub_rejoin, hub_leave and membership_entitlement, with Supabase's default
 * grants. Each attack is run first and must SUCCEED (a control). The migration is then applied exactly as written and every attack
 * must fail, while a genuine free join, a paid activation through the server function, a hub admin's approvals, leave and rejoin
 * all still work.
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
const HISTORY = join(MIG, '20260827120000_membership_history_and_safe_leave.sql');
const REJECTED = join(MIG, '20260827140000_rejected_can_apply_again.sql');
const REFUNDS = join(MIG, '20260828120000_membership_refunds.sql');
const NUMBERING = join(MIG, '20260929120000_hub_member_no_allocation.sql');
const SERVER_WRITE = join(MIG, '20261007120000_business_wallet_refunds.sql');
const FIX = join(MIG, '20261117000000_hub_members_server_authoritative.sql');
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

function createTable(file: string, opener: string): string {
  const s = src(file); const start = s.toLowerCase().indexOf(opener.toLowerCase()); assert.notEqual(start, -1, `${opener} is gone from ${file}`);
  const open = s.indexOf('(', start); let d = 0, end = -1;
  for (let i = open; i < s.length; i++) { if (s[i] === '(') d++; else if (s[i] === ')') { d--; if (d === 0) { end = i; break; } } }
  return s.slice(start, end + 1) + ';';
}
/** A whole function, from its header to the closing dollar-quote — whichever tag it uses. */
function fn(file: string, header: string): string {
  const s = src(file); const start = s.toLowerCase().indexOf(header.toLowerCase()); assert.notEqual(start, -1, `${header} is gone from ${file}`);
  const open = s.slice(start).match(/\$(\w*)\$/); assert.ok(open, `no body for ${header}`);
  const tag = open![0]; const bodyStart = start + open!.index! + tag.length;
  const end = s.indexOf(`${tag};`, bodyStart); assert.notEqual(end, -1, `no end for ${header}`);
  return s.slice(start, end + tag.length + 1).replace(/^create function/i, 'create or replace function');
}
const policy = (file: string, name: string, table: string) =>
  src(file).match(new RegExp(`create policy "?${name}"? on public\\.${table}[^;]*;`, 'i'))?.[0] ?? assert.fail(`policy ${name} is gone from ${file}`);

// ── the cast ────────────────────────────────────────────────────────────────
const HUB_A = 'a1a1a1a1-1111-4111-8111-111111111111';      // approval-mode
const HUB_OPEN = 'a2a2a2a2-2222-4222-8222-222222222222';   // open
const HUB_B = 'a3a3a3a3-3333-4333-8333-333333333333';      // approval-mode, a different hub
const HUB_OFF = 'a4a4a4a4-4444-4444-8444-444444444444';    // open, but switched off
const T_PAID_A = 'c1c1c1c1-0000-4000-8000-000000000001';
const T_FREE_A = 'c1c1c1c1-0000-4000-8000-000000000002';
const T_PAID_OPEN = 'c2c2c2c2-0000-4000-8000-000000000001';
const T_FREE_OPEN = 'c2c2c2c2-0000-4000-8000-000000000002';
const T_FREE_B = 'c3c3c3c3-0000-4000-8000-000000000002';
const T_FREE_OFF = 'c4c4c4c4-0000-4000-8000-000000000002';
const ADMIN = 'ad000000-0000-4000-8000-0000000000ad';      // platform administrator
const OWNER = 'e0000000-0000-4000-8000-0000000000e0';      // owns HUB_A and HUB_OPEN
const COMMITTEE = 'e1000000-0000-4000-8000-0000000000e1';  // committee of HUB_A
const ALICE = 'a1000000-0000-4000-8000-0000000000a1';      // an honest joiner
const EVE = 'e3000000-0000-4000-8000-0000000000e3';        // an attacker
const BOB = 'b2000000-0000-4000-8000-0000000000b2';        // somebody else
const CAROL = 'ca000000-0000-4000-8000-0000000000ca';

type Who = 'anon' | 'alice' | 'eve' | 'bob' | 'owner' | 'committee' | 'admin' | 'service';
const SUB: Record<string, string> = { alice: ALICE, eve: EVE, bob: BOB, owner: OWNER, committee: COMMITTEE, admin: ADMIN };
const roleSql = (who: Who) => who === 'anon' ? 'set local role anon;' : who === 'service' ? 'set local role service_role;'
  : `set local request.jwt.claim.sub = '${SUB[who]}'; set local role authenticated;`;
/** One statement as `who`, ROLLED BACK — a write that succeeds leaves nothing behind. */
const tryAs = (who: Who, sql: string) => raw(`begin; ${roleSql(who)} ${sql}; rollback;`);
/** As `who`, committed. */
const doAs = (who: Who, sql: string) => raw(`begin; ${roleSql(who)} ${sql}; commit;`);
const refused = (o: string) => /permission denied|row-level security|42501|has to be bought|set by the server|as yourself|new members join|not open to new|cannot be moved/i.test(o);
const touched = (who: Who, write: string) => Number(rowsOf(tryAs(who, `with w as (${write} returning 1) select count(*) from w`)).pop() ?? NaN);
const row = (hub: string, user: string, cols = `status, coalesce(membership_type_id::text,'-'), coalesce(paid_until::text,'-'), coalesce(last_payment_pence::text,'-'), coalesce(stripe_payment_intent_id,'-'), coalesce(member_no,'-')`) =>
  scalar(`select concat_ws('|', ${cols}) from public.hub_members where hub_id='${hub}' and user_id='${user}'`);

const FORGED_INSERT = (hub: string, user: string, tier: string) =>
  `insert into public.hub_members (hub_id, user_id, role, membership_type_id, paid_until, last_payment_pence, stripe_payment_intent_id, member_no)
   values ('${hub}', '${user}', 'member', '${tier}', null, 1000, 'pi_FORGED_${user.slice(0, 2)}', '99999999999')`;

let CONTROL: Record<string, string> = {};
let POLICIES_BEFORE = '';
let OTHER_BEFORE = '';
const policiesOf = () => raw(`select string_agg(format('%s|%s|%s|%s|%s|%s', tablename, policyname, cmd, roles, qual, with_check), E'\\n' order by tablename, policyname)
  from pg_policies where schemaname='public'`);
const otherObjects = () => raw(`select string_agg(c.relname||':'||c.relrowsecurity, ',' order by c.relname) from pg_class c where c.relnamespace='public'::regnamespace and c.relkind='r'`);

before(() => {
  assert.ok(DSN, 'PASS_PROOF_DSN is not set — run `npm run test:isolated`.');
  assert.ok(!/supabase\.co|pooler\.supabase/.test(DSN), 'PASS_PROOF_DSN points at Supabase. Refusing to run.');

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
    `create table auth.users (id uuid primary key);
     create table public.profiles (id uuid primary key, role text default 'customer', is_platform_owner boolean);
     create function public.is_discovery_hidden(t text, id uuid) returns boolean language sql stable as $$ select false $$;`,
    createTable(BASELINE, 'CREATE TABLE public.hubs ('), 'alter table public.hubs add primary key (id);',
    createTable(BASELINE, 'CREATE TABLE public.hub_members ('), 'alter table public.hub_members add primary key (id);',
    'alter table public.hub_members add constraint hub_members_hub_id_user_id_key unique (hub_id, user_id);',
    'alter table public.hub_members add column if not exists ended_at timestamptz;',
    'create unique index hub_members_stripe_payment_intent_id_key on public.hub_members (stripe_payment_intent_id) where stripe_payment_intent_id is not null;',
    'create unique index uq_hub_members_hub_member_no on public.hub_members (hub_id, member_no) where member_no is not null;',
    createTable(BASELINE, 'CREATE TABLE public.hub_membership_types ('), 'alter table public.hub_membership_types add primary key (id);',
    createTable(HISTORY, 'create table if not exists public.hub_membership_purchases'),
    src(REFUNDS).match(/alter table public\.hub_membership_purchases[^;]*;/i)![0],
    'create unique index if not exists uq_hub_membership_purchases_pi on public.hub_membership_purchases (payment_intent_id) where payment_intent_id is not null;',
    // the real current functions
    fn(BASELINE, 'CREATE FUNCTION public.is_hub_admin('),
    fn(BASELINE, 'CREATE FUNCTION public.is_hub_member('),
    fn(BASELINE, 'CREATE FUNCTION public.tg_hub_member_join_status('),
    fn(BASELINE, 'CREATE FUNCTION public.tg_hub_owner_membership('),
    fn(REJECTED, 'create or replace function public.tg_hub_members_guard('),
    fn(SERVER_WRITE, 'create or replace function public.tg_is_server_write('),
    fn(REFUNDS, 'create or replace function public.membership_entitlement('),
    fn(HISTORY, 'create or replace function public.hub_leave('),
    fn(REFUNDS, 'create or replace function public.hub_rejoin('),
    fn(NUMBERING, 'create or replace function public.activate_hub_membership('),
    // the triggers production has on these tables
    `create trigger trg_hub_member_join_status before insert on public.hub_members for each row execute function public.tg_hub_member_join_status();
     create trigger trg_hub_members_guard before update on public.hub_members for each row execute function public.tg_hub_members_guard();
     create trigger trg_hub_owner_membership after insert on public.hubs for each row execute function public.tg_hub_owner_membership();`,
    // RLS and the four policies, verbatim (the delete policy was replaced by the history migration)
    'alter table public.hub_members enable row level security; alter table public.hub_membership_types enable row level security;',
    policy(BASELINE, 'hub_members join', 'hub_members'),
    policy(BASELINE, 'hub_members read', 'hub_members'),
    policy(BASELINE, 'hub_members update', 'hub_members'),
    policy(HISTORY, 'hub_members delete', 'hub_members'),
    policy(BASELINE, 'hub_membership_types manage', 'hub_membership_types'),
    policy(BASELINE, 'hub_membership_types read', 'hub_membership_types'),
    'grant all on all tables in schema public to anon, authenticated, service_role;',
    'grant execute on all functions in schema public to anon, authenticated, service_role, public;',
    'revoke execute on function public.activate_hub_membership(uuid,uuid,uuid,text,integer,text,integer,text) from public, anon, authenticated;',
  ].join('\n'));
  assert.doesNotMatch(out, /ERROR/i, `fixture did not build:\n${out.slice(0, 2000)}`);

  const seed = raw(`
    insert into auth.users (id) values ('${ADMIN}'),('${OWNER}'),('${COMMITTEE}'),('${ALICE}'),('${EVE}'),('${BOB}'),('${CAROL}');
    insert into public.profiles (id, role) values ('${ADMIN}','admin'),('${OWNER}','customer'),('${COMMITTEE}','customer'),('${ALICE}','customer'),('${EVE}','customer'),('${BOB}','customer'),('${CAROL}','customer');
    insert into public.hubs (id, owner_id, name, slug, type, join_mode, is_active) values
      ('${HUB_A}','${OWNER}','Hub A','hub-a','club','approval',true),
      ('${HUB_OPEN}','${OWNER}','Hub Open','hub-open','club','open',true),
      ('${HUB_B}','${OWNER}','Hub B','hub-b','club','approval',true),
      ('${HUB_OFF}','${OWNER}','Hub Off','hub-off','club','open',false);
    insert into public.hub_membership_types (id, hub_id, name, price_pence, period, is_active) values
      ('${T_PAID_A}','${HUB_A}','Paid',1000,'year',true), ('${T_FREE_A}','${HUB_A}','Friend',0,'once',true),
      ('${T_PAID_OPEN}','${HUB_OPEN}','Paid',1000,'year',true), ('${T_FREE_OPEN}','${HUB_OPEN}','Friend',0,'once',true),
      ('${T_FREE_B}','${HUB_B}','Friend',0,'once',true), ('${T_FREE_OFF}','${HUB_OFF}','Friend',0,'once',true);
    insert into public.hub_members (hub_id, user_id, role, status) values ('${HUB_A}','${COMMITTEE}','committee','active');`);
  assert.doesNotMatch(seed, /ERROR/i, `seed failed:\n${seed.slice(0, 800)}`);

  // CONTROL — every attack against the PRE-FIX state; rolled back, so nothing persists.
  CONTROL.paidInsertOpen = String(touched('eve', FORGED_INSERT(HUB_OPEN, EVE, T_PAID_OPEN)));
  CONTROL.paidInsertApproval = String(touched('eve', FORGED_INSERT(HUB_A, EVE, T_PAID_A)));
  CONTROL.forgedRow = rowsOf(raw(`begin; ${roleSql('eve')} ${FORGED_INSERT(HUB_OPEN, EVE, T_PAID_OPEN)};
    reset role; select concat_ws('|', status, membership_type_id = '${T_PAID_OPEN}', paid_until is null, last_payment_pence, stripe_payment_intent_id, member_no) from public.hub_members where user_id='${EVE}'; rollback;`)).pop() ?? '';
  // the member-number DoS: a forged huge number breaks the NEXT genuine paid join to that hub
  CONTROL.dos = raw(`begin; ${roleSql('eve')} ${FORGED_INSERT(HUB_OPEN, EVE, T_PAID_OPEN)}; reset role;
    select public.activate_hub_membership('${HUB_OPEN}','${ALICE}','${T_PAID_OPEN}','year',1000,'pi_alice_1',95,null); rollback;`);
  // re-pointing a row at another hub: an honest open-hub member moves themselves into an approval-only hub
  raw(`insert into public.hub_members (hub_id, user_id, role, status) values ('${HUB_OPEN}','${EVE}','member','active')`);
  // (measured by looking at the row afterwards: an UPDATE ... RETURNING of a row that has left the caller's view is an RLS error)
  let lastWriteOutput = '';
  const afterWrite = (write: string, check: string) => {
    lastWriteOutput = raw(`begin; ${roleSql('eve')} ${write}; reset role; select count(*) from public.hub_members where ${check}; rollback;`);
    return rowsOf(lastWriteOutput).pop();
  };
  CONTROL.moveHub = String(afterWrite(`update public.hub_members set hub_id = '${HUB_A}' where user_id = '${EVE}'`, `hub_id = '${HUB_A}' and user_id = '${EVE}' and status = 'active'`));
  CONTROL.moveHubOut = lastWriteOutput;
  raw(`delete from public.hub_members where user_id = '${EVE}'`);
  POLICIES_BEFORE = policiesOf();
  OTHER_BEFORE = otherObjects();

  const fix = spawnSync(PSQL, [DSN, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', FIX], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(fix.status, 0, `migration failed:\n${fix.stderr}`);
});

describe('CONTROL — the attacks all worked before the fix (production’s own policies, grants and functions)', () => {
  test('a signed-in user inserted themselves into an OPEN hub on a PAID tier with lifetime-looking money fields', () => {
    assert.equal(CONTROL.paidInsertOpen, '1');
    assert.match(CONTROL.forgedRow, /^active\|t\|t\|1000\|pi_FORGED_e3\|99999999999$/, CONTROL.forgedRow);
  });
  test('…and into an APPROVAL hub with a paid tier attached to the pending request', () => assert.equal(CONTROL.paidInsertApproval, '1'));
  test('a forged member number made the NEXT genuine paid join to that hub fail (integer overflow)', () => {
    assert.match(CONTROL.dos, /out of range/i, CONTROL.dos);
  });
  test('a member could re-point their own row at an approval-only hub, keeping status active (skipping that hub’s approval)', () => {
    assert.equal(CONTROL.moveHub, '1', CONTROL.moveHubOut);
  });
});

describe('1, 3, 12  a signed-in user cannot self-insert a paid tier, or any payment / entitlement field', () => {
  test('a paid tier is refused — open hub and approval hub', () => {
    for (const [hub, tier] of [[HUB_OPEN, T_PAID_OPEN], [HUB_A, T_PAID_A]]) {
      const o = tryAs('eve', `insert into public.hub_members (hub_id, user_id, role, membership_type_id) values ('${hub}', '${EVE}', 'member', '${tier}')`);
      assert.match(o, /has to be bought/, o);
    }
  });
  test('the full forgery (paid tier + paid_until + payment + Stripe id + member number) is refused and leaves no row', () => {
    assert.ok(refused(tryAs('eve', FORGED_INSERT(HUB_OPEN, EVE, T_PAID_OPEN))));
    assert.equal(scalar(`select count(*) from public.hub_members where user_id='${EVE}'`), '0');
  });
  for (const [col, val] of [['paid_until', `now() + interval '1 year'`], ['last_payment_pence', '1000'], ['stripe_payment_intent_id', `'pi_forged'`], ['member_no', `'7'`], ['ended_at', 'now()']]) {
    test(`${col} cannot be set on a join, even on the free path`, () => {
      const o = tryAs('eve', `insert into public.hub_members (hub_id, user_id, role, ${col}) values ('${HUB_OPEN}', '${EVE}', 'member', ${val})`);
      assert.match(o, /set by the server/, o);
    });
  }
  test('a free tier of ANOTHER hub, or a tier that does not exist, is refused', () => {
    assert.match(tryAs('eve', `insert into public.hub_members (hub_id, user_id, role, membership_type_id) values ('${HUB_OPEN}', '${EVE}', 'member', '${T_FREE_B}')`), /has to be bought/);
    assert.ok(refused(tryAs('eve', `insert into public.hub_members (hub_id, user_id, role, membership_type_id) values ('${HUB_OPEN}', '${EVE}', 'member', 'ffffffff-0000-4000-8000-000000000000')`)));
  });
  test('a hub that is switched off takes no new members', () => {
    const o = tryAs('eve', `insert into public.hub_members (hub_id, user_id, role) values ('${HUB_OFF}', '${EVE}', 'member')`);
    assert.match(o, /not open to new members/, o);
  });
  test('the forgery cannot have created an entitlement: eve is a member of nothing and holds no paid time', () => {
    assert.equal(scalar(`select public.is_hub_member('${HUB_OPEN}', '${EVE}')::text`), 'false');
    assert.equal(scalar(`select (public.membership_entitlement('${HUB_OPEN}', '${EVE}')).entitled::text`), 'false');
  });
});

describe('6, 7  who a join can be for', () => {
  test('the caller cannot join as somebody else, or as an owner or committee member', () => {
    assert.ok(refused(tryAs('eve', `insert into public.hub_members (hub_id, user_id, role) values ('${HUB_OPEN}', '${BOB}', 'member')`)));
    assert.ok(refused(tryAs('eve', `insert into public.hub_members (hub_id, user_id, role) values ('${HUB_OPEN}', '${EVE}', 'owner')`)));
    assert.ok(refused(tryAs('eve', `insert into public.hub_members (hub_id, user_id, role) values ('${HUB_OPEN}', '${EVE}', 'committee')`)));
  });
});

describe('5  a genuine free join still works, and ends in the right state', () => {
  test('open hub, no tier: active at once, no payment fields, no member number, joined now', () => {
    assert.equal(touched('alice', `insert into public.hub_members (hub_id, user_id, role) values ('${HUB_OPEN}', '${ALICE}', 'member')`), 1);
    doAs('alice', `insert into public.hub_members (hub_id, user_id, role) values ('${HUB_OPEN}', '${ALICE}', 'member')`);
    assert.equal(row(HUB_OPEN, ALICE), 'active|-|-|-|-|-');
    assert.equal(scalar(`select (joined_at > now() - interval '1 minute')::text from public.hub_members where hub_id='${HUB_OPEN}' and user_id='${ALICE}'`), 'true');
  });
  test('the join time cannot be back-dated on the way in', () => {
    doAs('bob', `insert into public.hub_members (hub_id, user_id, role) values ('${HUB_OPEN}', '${BOB}', 'member')`);
    // the guard stamps joined_at; a client-supplied value is overwritten
    const o = tryAs('eve', `insert into public.hub_members (hub_id, user_id, role, joined_at) values ('${HUB_OPEN}', '${EVE}', 'member', '2001-01-01'); select (joined_at > now() - interval '1 minute')::text from public.hub_members where user_id='${EVE}'`);
    assert.match(o, /true/, o);
  });
  test('approval hub, free tier: a PENDING request that carries the free tier, nothing paid', () => {
    doAs('alice', `insert into public.hub_members (hub_id, user_id, role, membership_type_id) values ('${HUB_A}', '${ALICE}', 'member', '${T_FREE_A}')`);
    assert.equal(row(HUB_A, ALICE), `pending|${T_FREE_A}|-|-|-|-`);
    assert.equal(scalar(`select public.is_hub_member('${HUB_A}', '${ALICE}')::text`), 'false', 'a pending request must not be a member');
  });
  test('the FREE tier of an open hub is accepted', () => {
    assert.equal(touched('eve', `insert into public.hub_members (hub_id, user_id, role, membership_type_id) values ('${HUB_OPEN}', '${EVE}', 'member', '${T_FREE_OPEN}')`), 1);
  });
  test('duplicate: joining again is refused by the unique key, and changes nothing', () => {
    const o = tryAs('alice', `insert into public.hub_members (hub_id, user_id, role) values ('${HUB_OPEN}', '${ALICE}', 'member')`);
    assert.match(o, /duplicate key|unique/i, o);
    assert.equal(scalar(`select count(*) from public.hub_members where hub_id='${HUB_OPEN}' and user_id='${ALICE}'`), '1');
  });
  test('creating a hub still gives its creator an owner row (the definer trigger path is not a direct client write)', () => {
    const newHub = 'a9a9a9a9-9999-4999-8999-999999999999';
    doAs('alice', `insert into public.hubs (id, owner_id, name, slug, type, join_mode, is_active) values ('${newHub}', '${ALICE}', 'Alice Hub', 'alice-hub', 'club', 'open', true)`);
    assert.equal(scalar(`select role||'/'||status from public.hub_members where hub_id='${newHub}' and user_id='${ALICE}'`), 'owner/active');
  });
});

describe('2, 4  an existing membership cannot be upgraded, moved, or changed by someone else', () => {
  test('a member cannot move themselves to another hub or person (the row stays where it is)', () => {
    for (const set of [`hub_id = '${HUB_A}'`, `user_id = '${CAROL}'`, `id = gen_random_uuid()`]) {
      const o = tryAs('alice', `update public.hub_members set ${set} where user_id = '${ALICE}' and hub_id = '${HUB_OPEN}'`);
      assert.match(o, /cannot be moved/, `${set}: ${o}`);
    }
    assert.equal(row(HUB_OPEN, ALICE), 'active|-|-|-|-|-');
  });
  test('free → paid by direct UPDATE changes nothing (the existing guard holds)', () => {
    doAs('alice', `update public.hub_members set membership_type_id = '${T_PAID_OPEN}' where user_id = '${ALICE}' and hub_id = '${HUB_OPEN}'`);
    assert.equal(row(HUB_OPEN, ALICE), 'active|-|-|-|-|-', 'a member upgraded themselves');
  });
  test('payment / expiry / member-number fields cannot be written by UPDATE', () => {
    doAs('alice', `update public.hub_members set paid_until = now() + interval '1 year', last_payment_pence = 1000, stripe_payment_intent_id = 'pi_x', member_no = '1' where user_id = '${ALICE}' and hub_id = '${HUB_OPEN}'`);
    assert.equal(row(HUB_OPEN, ALICE), 'active|-|-|-|-|-');
  });
  test('role and status are guarded: no self-promotion, no self-approval', () => {
    doAs('alice', `update public.hub_members set role = 'owner' where user_id = '${ALICE}' and hub_id = '${HUB_OPEN}'`);
    assert.equal(scalar(`select role from public.hub_members where user_id='${ALICE}' and hub_id='${HUB_OPEN}'`), 'member');
    doAs('alice', `update public.hub_members set status = 'active' where user_id = '${ALICE}' and hub_id = '${HUB_A}'`);
    assert.equal(scalar(`select status from public.hub_members where user_id='${ALICE}' and hub_id='${HUB_A}'`), 'pending');
  });
  test('4 — somebody else’s membership cannot be changed or deleted by a stranger', () => {
    assert.equal(touched('eve', `update public.hub_members set status = 'removed' where user_id = '${ALICE}'`), 0);
    assert.equal(touched('eve', `update public.hub_members set membership_type_id = '${T_FREE_OPEN}' where user_id = '${ALICE}'`), 0);
    assert.equal(touched('eve', `delete from public.hub_members where user_id = '${ALICE}'`), 0);
    assert.equal(rowsOf(tryAs('eve', `select count(*) from public.hub_members where user_id = '${ALICE}'`)).pop(), '0', 'a stranger can read it');
  });
});

describe('9, 10, 11  the trusted paths still grant, approve and renew', () => {
  test('9, 11 — a confirmed payment (activate_hub_membership, service_role only) grants the paid tier, a member number and a receipt', () => {
    const o = doAs('service', `select public.activate_hub_membership('${HUB_OPEN}','${BOB}','${T_PAID_OPEN}','year',1000,'pi_bob_1',95,null)`);
    assert.doesNotMatch(o, /ERROR/, o);
    const r = row(HUB_OPEN, BOB, `status, membership_type_id, (paid_until > now() + interval '300 days')::text, last_payment_pence, stripe_payment_intent_id, member_no`);
    assert.equal(r, `active|${T_PAID_OPEN}|true|1000|pi_bob_1|1`);
    assert.equal(scalar(`select count(*) from public.hub_membership_purchases where payment_intent_id='pi_bob_1'`), '1');
    assert.equal(scalar(`select public.is_hub_member('${HUB_OPEN}', '${BOB}')::text`), 'true');
  });
  test('a replay of the same payment grants nothing more; a new payment extends', () => {
    const before = scalar(`select paid_until::text from public.hub_members where hub_id='${HUB_OPEN}' and user_id='${BOB}'`);
    doAs('service', `select public.activate_hub_membership('${HUB_OPEN}','${BOB}','${T_PAID_OPEN}','year',1000,'pi_bob_1',95,null)`);
    assert.equal(scalar(`select paid_until::text from public.hub_members where hub_id='${HUB_OPEN}' and user_id='${BOB}'`), before);
    doAs('service', `select public.activate_hub_membership('${HUB_OPEN}','${BOB}','${T_PAID_OPEN}','year',1000,'pi_bob_2',95,null)`);
    assert.notEqual(scalar(`select paid_until::text from public.hub_members where hub_id='${HUB_OPEN}' and user_id='${BOB}'`), before);
  });
  test('a client cannot run the payment function', () => {
    assert.ok(refused(tryAs('eve', `select public.activate_hub_membership('${HUB_OPEN}','${EVE}','${T_PAID_OPEN}','year',1000,'pi_forged',95,null)`)));
  });
  test('10 — the hub owner approves a pending request, re-tiers a member, and promotes to committee; a committee member cannot promote', () => {
    assert.equal(touched('owner', `update public.hub_members set status = 'active' where hub_id = '${HUB_A}' and user_id = '${ALICE}'`), 1);
    doAs('owner', `update public.hub_members set status = 'active' where hub_id = '${HUB_A}' and user_id = '${ALICE}'`);
    assert.equal(scalar(`select status from public.hub_members where hub_id='${HUB_A}' and user_id='${ALICE}'`), 'active');
    doAs('owner', `update public.hub_members set membership_type_id = '${T_PAID_A}' where hub_id = '${HUB_A}' and user_id = '${ALICE}'`);
    assert.equal(scalar(`select membership_type_id::text from public.hub_members where hub_id='${HUB_A}' and user_id='${ALICE}'`), T_PAID_A, 'a hub admin can still comp a tier — a hub decision, no payment fields involved');
    assert.equal(scalar(`select coalesce(paid_until::text,'-')||'/'||coalesce(last_payment_pence::text,'-') from public.hub_members where hub_id='${HUB_A}' and user_id='${ALICE}'`), '-/-');
    doAs('owner', `update public.hub_members set role = 'committee' where hub_id = '${HUB_A}' and user_id = '${ALICE}'`);
    assert.equal(scalar(`select role from public.hub_members where hub_id='${HUB_A}' and user_id='${ALICE}'`), 'committee');
    doAs('committee', `update public.hub_members set role = 'owner' where hub_id = '${HUB_A}' and user_id = '${COMMITTEE}'`);
    assert.equal(scalar(`select role from public.hub_members where hub_id='${HUB_A}' and user_id='${COMMITTEE}'`), 'committee');
  });
  test('a hub admin still cannot write money fields on a member, nor move the row to another hub', () => {
    doAs('owner', `update public.hub_members set paid_until = now() + interval '9 years', last_payment_pence = 5000 where hub_id = '${HUB_A}' and user_id = '${ALICE}'`);
    assert.equal(scalar(`select coalesce(paid_until::text,'-')||'/'||coalesce(last_payment_pence::text,'-') from public.hub_members where hub_id='${HUB_A}' and user_id='${ALICE}'`), '-/-');
    assert.match(tryAs('owner', `update public.hub_members set hub_id = '${HUB_B}' where hub_id = '${HUB_A}' and user_id = '${ALICE}'`), /cannot be moved/);
    assert.match(tryAs('owner', `update public.hub_members set user_id = '${CAROL}' where hub_id = '${HUB_A}' and user_id = '${ALICE}'`), /cannot be moved/);
  });
  test('leave and rejoin (definer functions) still work, and paid time survives a leave', () => {
    assert.equal(scalar(`begin; ${roleSql('bob')} select (public.hub_leave('${HUB_OPEN}'))->>'left'; commit;`), 'true');
    assert.equal(scalar(`select status from public.hub_members where hub_id='${HUB_OPEN}' and user_id='${BOB}'`), 'left');
    assert.equal(scalar(`begin; ${roleSql('bob')} select (public.hub_rejoin('${HUB_OPEN}', null))->>'reason'; commit;`), 'paid_time_remaining');
    assert.equal(scalar(`select status from public.hub_members where hub_id='${HUB_OPEN}' and user_id='${BOB}'`), 'active');
  });
});

describe('13–16  anon, RLS, service_role, and nothing else moved', () => {
  test('anon cannot write memberships — and holds no write privilege', () => {
    for (const sql of [`insert into public.hub_members (hub_id, user_id, role) values ('${HUB_OPEN}', '${EVE}', 'member')`, `update public.hub_members set status = 'active'`, 'delete from public.hub_members']) {
      assert.match(tryAs('anon', sql), /permission denied/, sql);
    }
    for (const p of ['INSERT', 'UPDATE', 'DELETE', 'REFERENCES', 'TRIGGER']) assert.equal(scalar(`select has_table_privilege('anon','public.hub_members','${p}')::text`), 'false', p);
  });
  test('anon can still SELECT (an empty answer, not an error, on any public page that embeds the table)', () => {
    assert.equal(rowsOf(tryAs('anon', 'select count(*) from public.hub_members')).pop(), '0');
  });
  test('RLS is still enabled and every policy is exactly as before the migration', () => {
    assert.equal(scalar(`select relrowsecurity::text from pg_class where oid='public.hub_members'::regclass`), 'true');
    assert.equal(policiesOf(), POLICIES_BEFORE);
    assert.equal(otherObjects(), OTHER_BEFORE);
  });
  test('service_role keeps full access: it can insert any membership, including a paid one, and update any field', () => {
    assert.equal(touched('service', FORGED_INSERT(HUB_B, CAROL, T_FREE_B).replace(`'${T_FREE_B}', null, 1000`, `'${T_FREE_B}', now(), 1000`)), 1);
    assert.equal(touched('service', `update public.hub_members set hub_id = '${HUB_B}' where hub_id = '${HUB_A}' and user_id = '${COMMITTEE}'`), 1);
  });
  test('the three new triggers are present, and the existing UPDATE guard is untouched', () => {
    assert.equal(rowsOf(raw(`select tgname from pg_trigger where tgrelid='public.hub_members'::regclass and not tgisinternal order by 1`)).join(','),
      'trg_hub_member_join_status,trg_hub_members_guard,trg_hub_members_identity_lock,trg_hub_members_insert_guard');
  });
  test('the migration names only hub_members and its own helpers, changes no rows, and is idempotent', () => {
    const sql = src(FIX).split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    const tables = new Set([...sql.matchAll(/\b(?:on|from|table|into)\s+public\.([a-z_]+)/gi)].map((m) => m[1]));
    assert.deepEqual([...tables].sort(), ['hub_members', 'hub_membership_types', 'hubs']);
    assert.doesNotMatch(sql, /\b(insert\s+into|update\s+public|delete\s+from)\b/i);
    const again = spawnSync(PSQL, [DSN, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', FIX], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.equal(again.status, 0, again.stderr);
  });
  test('the migration refuses to commit if anon can still write the table', () => {
    const broken = src(FIX).replace('revoke insert, update, delete, references, trigger on table public.hub_members from anon;', '-- (removed for the test)');
    const r = spawnSync(PSQL, [DSN, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-c', 'grant insert on public.hub_members to anon;', '-c', broken], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    raw('revoke insert on public.hub_members from anon;');
  });
});
