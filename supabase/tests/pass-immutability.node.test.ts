/**
 * pass-immutability.node.test.ts
 *
 * The 2 Oct 2026 reconciliation found the same weakness on pass purchases that
 * it found on product_orders: "Businesses redeem uses on their items" lets the
 * owning business UPDATE any column of its passes' purchase rows, authenticated
 * holds blanket table-level UPDATE (measured in production), and the only
 * trigger locked the refund columns and the use balance.
 * 20261028000200_pass_financial_lock.sql adds an allowlist trigger whose
 * allowlist is EMPTY — derived from an inspection showing no client write to
 * this table exists (see the migration header; asserted again below).
 *
 * This suite runs the real migration SQL under real RLS policies and the real
 * blanket grants, as the roles PostgREST uses (authenticated / anon with the
 * JWT subject claim), and proves:
 *   · the merchant cannot change ANY column — every column that exists
 *   · the purchaser, another merchant, and anon cannot change the row either
 *   · server writes, SECURITY DEFINER functions (how claim/redeem/refund
 *     actually write) and service_role still work
 *   · the protection is the TRIGGER: with it neutralised the same merchant
 *     CAN rewrite the amount, so the refusals above are not an accident of RLS
 *
 * SAFETY — ISOLATED DATABASE ONLY
 * Requires PASS_PROOF_DSN and refuses a DSN mentioning Supabase. Run by
 * `npm run test:isolated`. No production row is read or written, no auth user
 * is created, and no service key is used.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_ROOT = join(REPO_ROOT, '..', 'oneshetland-web');
const MIG = join(REPO_ROOT, 'supabase/migrations');
const BASELINE = join(MIG, '20260623000000_baseline_remote_schema.sql');
const REFUNDFIX = join(MIG, '20261007120000_business_wallet_refunds.sql');
// The reminder columns arrived with 20260803120000 (production's loyalty_reminders migration, as applied, did not add them).
const REMINDERS = join(MIG, '20260803120000_fix_missing_nudge_reminded_at.sql');
const LOCK = join(MIG, '20261028000200_pass_financial_lock.sql');

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

const OWNER = '0a0a0a0a-0000-4000-8000-00000000000a';   // owns the business that sold the pass
const BUYER = 'c0c0c0c0-0000-4000-8000-00000000000c';   // the purchaser (owner_id of the pass)
const OTHER = 'a0a0a0a0-0000-4000-8000-00000000000a';   // another business owner
const BIZ = 'd0d0d0d0-0000-4000-8000-00000000000d';
const BIZ2 = 'd1d1d1d1-0000-4000-8000-00000000000d';
const ITEM = 'f0f0f0f0-0000-4000-8000-00000000000f';
const ITEM2 = 'f1f1f1f1-0000-4000-8000-00000000000f';
const PASS = '11110000-0000-4000-8000-000000000011';
const PASS2 = '11110000-0000-4000-8000-000000000012';
const GIFT = '99990000-0000-4000-8000-000000000099';

const REAL_LOCK = () => src(LOCK);
/** The migration with its refusal removed — what the suite must be able to detect. */
const NEUTERED_LOCK = () => REAL_LOCK().replace(
  /raise exception 'pass payment, amount and ownership fields are server-managed'\s*using errcode = '42501';/, 'null;');

function schema(lockSql: string = REAL_LOCK()) {
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
    createTable(BASELINE, 'CREATE TABLE public.book_unit_items ('),
    'alter table public.book_unit_items add primary key (id);',
    createTable(BASELINE, 'CREATE TABLE public.book_unit_purchases ('),
    'alter table public.book_unit_purchases add primary key (id);',
    // The column the expiry reminder job maintains (a later migration) — production has 15 columns, so must the test.
    slice(REMINDERS, 'alter table public.book_unit_purchases\n  add column if not exists expiry_reminded_at', ';'),
    // The real refund-state lock this change sits alongside.
    slice(REFUNDFIX, 'alter table public.book_unit_purchases\n  add column if not exists refund_state', ';'),
    slice(REFUNDFIX, 'do $$\nbegin\n  if not exists (select 1 from pg_constraint\n                  where conrelid = \'public.book_unit_purchases\'::regclass', 'end $$;'),
    slice(REFUNDFIX, 'create or replace function public.tg_is_server_write', '$$;'),
    slice(REFUNDFIX, 'create or replace function public.tg_lock_pass_refund_columns', '$$;'),
    slice(REFUNDFIX, 'drop trigger if exists tg_zz_lock_pass_refund_columns', 'tg_lock_pass_refund_columns();'),
    // Production's RLS exactly (pg_policies, read 2 Oct 2026): two SELECT policies and ONE UPDATE policy
    // for the owning business, with the same expression as USING and WITH CHECK.
    'alter table public.book_unit_purchases enable row level security;',
    `create policy "Businesses see purchases of their items" on public.book_unit_purchases for select
       using (business_id in (select id from public.local_businesses where owner_id = auth.uid()));`,
    `create policy "Owners see their unit purchases" on public.book_unit_purchases for select using (owner_id = auth.uid());`,
    `create policy "Businesses redeem uses on their items" on public.book_unit_purchases for update
       using (business_id in (select id from public.local_businesses where owner_id = auth.uid()))
       with check (business_id in (select id from public.local_businesses where owner_id = auth.uid()));`,
    // Production grants authenticated (and anon) blanket table-level UPDATE — measured —
    // so the trigger, not a missing privilege, must be what refuses a merchant.
    'grant usage on schema public, auth to anon, authenticated, service_role;',
    'grant execute on function auth.uid() to anon, authenticated, service_role;',
    'grant select, insert, update, delete on all tables in schema public to anon, authenticated, service_role;',
    // The migration under test (or, for the mutation proof, the same with its refusal removed).
    lockSql,
  ].join('\n'));
  assert.doesNotMatch(out, /ERROR/i, `schema failed:\n${out.slice(0, 1600)}`);
}

function fixtures() {
  const o = raw(`
    delete from public.book_unit_purchases; delete from public.book_unit_items;
    delete from public.local_businesses; delete from public.profiles; delete from auth.users;
    insert into auth.users(id) values ('${OWNER}'),('${BUYER}'),('${OTHER}');
    insert into public.profiles(id) values ('${OWNER}'),('${BUYER}'),('${OTHER}');
    insert into public.local_businesses (id, owner_id, name, category, address) values
      ('${BIZ}','${OWNER}','Anderson & Co','retail','Lerwick'),
      ('${BIZ2}','${OTHER}','Other Shop','retail','Scalloway');
    insert into public.book_unit_items (id, business_id, name, price_pence, uses_per_purchase, stock) values
      ('${ITEM}','${BIZ}','3 Session Pass', 300, 3, 5),
      ('${ITEM2}','${BIZ2}','Other Pass', 500, 5, 5);
    insert into public.book_unit_purchases
      (id, item_id, business_id, owner_id, paid_amount_pence, uses_remaining, payment_intent_id, expires_at) values
      ('${PASS}','${ITEM}','${BIZ}','${BUYER}',300,3,'pi_real_one', now() + interval '30 days'),
      ('${PASS2}','${ITEM2}','${BIZ2}','${BUYER}',500,5,'pi_real_two', now() + interval '30 days');
  `);
  assert.doesNotMatch(o, /ERROR/i, `fixtures failed:\n${o.slice(0, 900)}`);
}

/** Exactly what PostgREST does: a role plus the JWT subject claim. */
const asUser = (uid: string, sql: string) =>
  raw(`select set_config('request.jwt.claim.sub','${uid}',false); set role authenticated; ${sql} reset role;`);
const asAnon = (sql: string) => raw(`set role anon; ${sql} reset role;`);
const asServer = (sql: string) => raw(`set role service_role; ${sql} reset role;`);
const snapshot = (id = PASS) => scalar(`select to_jsonb(p)::text from public.book_unit_purchases p where id='${id}';`);
const field = (col: string, id = PASS) => scalar(`select ${col}::text from public.book_unit_purchases where id='${id}';`);

const cols = (): { name: string; type: string }[] =>
  raw(`select column_name || '|' || data_type from information_schema.columns
        where table_schema='public' and table_name='book_unit_purchases' order by ordinal_position;`)
    .split('\n').map((l) => l.trim()).filter((l) => l.includes('|'))
    .map((l) => { const [name, type] = l.split('|'); return { name, type }; });

/** An expression guaranteed to DIFFER from the current value, per type. */
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

describe('a merchant cannot change ANY column of a pass purchase — every column, alone', () => {
  before(() => { schema(); fixtures(); });

  test('the real table has the money, payment, ownership, identity, quantity and refund columns we expect locked', () => {
    const names = cols().map((c) => c.name);
    for (const must of ['paid_amount_pence', 'payment_intent_id', 'owner_id', 'business_id', 'item_id', 'gift_id', 'uses_remaining',
      'fully_used_at', 'expires_at', 'created_at', 'expiry_reminded_at', 'refund_state', 'refunded_at', 'refund_transaction_id']) {
      assert.ok(names.includes(must), `${must} missing from the test table`);
    }
  });

  test('every column is refused when the owning business changes it, and the row is left exactly as it was', () => {
    const all = cols();
    assert.equal(all.length, 15, `production has 15 columns; the test table has ${all.length}`);
    const before = snapshot();
    for (const c of all) {
      const o = asUser(OWNER, `update public.book_unit_purchases set ${c.name} = ${changed(c)} where id='${PASS}';`);
      assert.match(o, /server-managed/, `a merchant changed ${c.name} (${c.type}):\n${o.slice(0, 300)}`);
      assert.equal(snapshot(), before, `${c.name} was altered despite the refusal`);
    }
  });

  test('the headline cases, spelled out: amount, payment reference, purchaser, business, item, gift link, original quantity', () => {
    const before = snapshot();
    for (const sql of [
      `update public.book_unit_purchases set paid_amount_pence = 1 where id='${PASS}';`,
      `update public.book_unit_purchases set payment_intent_id = 'pi_forged' where id='${PASS}';`,
      `update public.book_unit_purchases set owner_id = '${OWNER}' where id='${PASS}';`,
      `update public.book_unit_purchases set business_id = '${BIZ2}' where id='${PASS}';`,
      `update public.book_unit_purchases set item_id = '${ITEM2}' where id='${PASS}';`,
      `update public.book_unit_purchases set gift_id = '${GIFT}' where id='${PASS}';`,
      `update public.book_unit_purchases set uses_remaining = 99 where id='${PASS}';`,
      `update public.book_unit_purchases set expires_at = now() + interval '10 years' where id='${PASS}';`,
      `update public.book_unit_purchases set refund_state = 'refunded' where id='${PASS}';`,
    ]) assert.match(asUser(OWNER, sql), /server-managed/, sql);
    assert.equal(snapshot(), before);
  });

  test('redeeming a use directly (the old "businesses redeem uses" intent) is refused — redemption is a server function', () => {
    const before = snapshot();
    const o = asUser(OWNER, `update public.book_unit_purchases set uses_remaining = uses_remaining - 1, fully_used_at = null where id='${PASS}';`);
    assert.match(o, /server-managed/);
    assert.equal(snapshot(), before);
  });

  test('a multi-column update cannot smuggle one locked column through with others', () => {
    const before = snapshot();
    const o = asUser(OWNER, `update public.book_unit_purchases set paid_amount_pence = 1, expires_at = expires_at, uses_remaining = uses_remaining where id='${PASS}';`);
    assert.match(o, /server-managed/);
    assert.equal(snapshot(), before);
  });

  test('re-sending unchanged values is harmless (a client echoing the whole row is not broken)', () => {
    const o = asUser(OWNER, `update public.book_unit_purchases set paid_amount_pence = paid_amount_pence, payment_intent_id = payment_intent_id where id='${PASS}' returning id;`);
    assert.doesNotMatch(o, /ERROR/, o);
    assert.match(o, new RegExp(PASS));
  });
});

describe('nobody else can touch the purchase from a client role', () => {
  before(() => { schema(); fixtures(); });

  test('the PURCHASER cannot change financial fields (no UPDATE policy) — nor anything else', () => {
    const before = snapshot();
    for (const sql of [
      `update public.book_unit_purchases set paid_amount_pence = 1 where id='${PASS}' returning id;`,
      `update public.book_unit_purchases set uses_remaining = 99 where id='${PASS}' returning id;`,
      `update public.book_unit_purchases set owner_id = '${OTHER}' where id='${PASS}' returning id;`,
      `update public.book_unit_purchases set payment_intent_id = 'pi_forged' where id='${PASS}' returning id;`,
    ]) assert.doesNotMatch(asUser(BUYER, sql), new RegExp(PASS), `the purchaser's update reached the row: ${sql}`);
    assert.equal(snapshot(), before);
  });

  test('another merchant cannot change this purchase (RLS hides it)', () => {
    const before = snapshot();
    const o = asUser(OTHER, `update public.book_unit_purchases set paid_amount_pence = 1 where id='${PASS}' returning id;`);
    assert.doesNotMatch(o, new RegExp(PASS));
    assert.equal(snapshot(), before);
  });

  test('a merchant cannot change a purchase belonging to another business either', () => {
    const before = snapshot(PASS2);
    asUser(OWNER, `update public.book_unit_purchases set paid_amount_pence = 1 where id='${PASS2}';`);
    assert.equal(snapshot(PASS2), before);
  });

  test('anon cannot change the purchase', () => {
    const before = snapshot();
    asAnon(`update public.book_unit_purchases set paid_amount_pence = 1 where id='${PASS}';`);
    assert.equal(snapshot(), before);
  });

  test('no client role can insert or delete a purchase either', () => {
    const before = scalar(`select count(*)::text from public.book_unit_purchases;`);
    asUser(OWNER, `insert into public.book_unit_purchases (id,item_id,business_id,owner_id,paid_amount_pence,uses_remaining) values (gen_random_uuid(),'${ITEM}','${BIZ}','${OWNER}',1,1);`);
    asUser(OWNER, `delete from public.book_unit_purchases where id='${PASS}';`);
    asAnon(`delete from public.book_unit_purchases where id='${PASS}';`);
    assert.equal(scalar(`select count(*)::text from public.book_unit_purchases;`), before);
  });
});

describe('server-side writes keep working', () => {
  before(() => { schema(); fixtures(); });

  test('service_role (the edge functions) can write money, payment, ownership and use-balance fields', () => {
    const o = asServer(`update public.book_unit_purchases set paid_amount_pence = 250, payment_intent_id = 'pi_corrected', uses_remaining = 2, expiry_reminded_at = now() where id='${PASS}' returning id;`);
    assert.doesNotMatch(o, /ERROR/, o);
    assert.equal(field('paid_amount_pence'), '250');
    assert.equal(field('payment_intent_id'), 'pi_corrected');
    assert.equal(field('uses_remaining'), '2');
  });

  test('the migration/superuser path can still write', () => {
    const o = raw(`update public.book_unit_purchases set paid_amount_pence = 300 where id='${PASS}' returning id;`);
    assert.doesNotMatch(o, /ERROR/, o);
    assert.equal(field('paid_amount_pence'), '300');
  });

  test('SECURITY DEFINER functions — how claim_gift, redeem_pass_atomic and the refund RPCs write — work when a CLIENT calls them', () => {
    fixtures();
    raw(`
      create or replace function public._t_redeem(p_id uuid) returns void language plpgsql security definer set search_path = public as $$
        begin update public.book_unit_purchases set uses_remaining = uses_remaining - 1 where id = p_id; end; $$;
      create or replace function public._t_refund_claim(p_id uuid) returns void language plpgsql security definer set search_path = public as $$
        begin update public.book_unit_purchases set refund_state = 'pending' where id = p_id; end; $$;
      create or replace function public._t_claim_gift(p_id uuid, p_owner uuid) returns void language plpgsql security definer set search_path = public as $$
        begin insert into public.book_unit_purchases (id,item_id,business_id,owner_id,paid_amount_pence,uses_remaining,gift_id)
              values (p_id,'${ITEM}','${BIZ}',p_owner,300,3,'${GIFT}'); end; $$;
      grant execute on function public._t_redeem(uuid), public._t_refund_claim(uuid), public._t_claim_gift(uuid, uuid) to authenticated;`);
    // The merchant redeems a use through the function, but cannot do the same write directly.
    assert.doesNotMatch(asUser(OWNER, `select public._t_redeem('${PASS}');`), /ERROR/);
    assert.equal(field('uses_remaining'), '2');
    assert.match(asUser(OWNER, `update public.book_unit_purchases set uses_remaining = uses_remaining - 1 where id='${PASS}';`), /server-managed/);
    // The refund claim writes refund state through the function.
    assert.doesNotMatch(asUser(OWNER, `select public._t_refund_claim('${PASS}');`), /ERROR/);
    assert.equal(field('refund_state'), 'pending');
    // A gift claim by the recipient inserts the purchase row (gift-funded pass).
    const NEWP = '22220000-0000-4000-8000-000000000022';
    assert.doesNotMatch(asUser(BUYER, `select public._t_claim_gift('${NEWP}', '${BUYER}');`), /ERROR/);
    assert.equal(field('gift_id', NEWP), GIFT);
    assert.equal(field('owner_id', NEWP), BUYER);
  });

  test('the existing refund and use-balance rules still apply to a client on top', () => {
    fixtures();
    assert.match(asUser(OWNER, `update public.book_unit_purchases set refund_state='refunded' where id='${PASS}';`), /server-managed/);
    assert.match(asUser(OWNER, `update public.book_unit_purchases set fully_used_at = now() where id='${PASS}';`), /server-managed/);
  });
});

/* ── The protection is the trigger: mutate it away and the merchant gets through ── */

describe('mutation: with the protection trigger neutralised, the same merchant CAN rewrite the purchase', () => {
  test('on a schema whose lock trigger no longer refuses, a merchant changes the amount, payment reference and owner', () => {
    schema(NEUTERED_LOCK()); fixtures();
    const o = asUser(OWNER, `update public.book_unit_purchases set paid_amount_pence = 1, payment_intent_id = 'pi_forged', owner_id = '${OWNER}', item_id = '${ITEM}' where id='${PASS}' returning id;`);
    // The pre-existing refund/use trigger does not cover these columns, so only OUR trigger stood in the way.
    assert.doesNotMatch(o, /ERROR/, `the mutated schema still refused — the suite would not notice a disabled trigger:\n${o}`);
    assert.equal(field('paid_amount_pence'), '1');
    assert.equal(field('payment_intent_id'), 'pi_forged');
    assert.equal(field('owner_id'), OWNER);
  });

  test('restoring the real migration refuses the very same statement', () => {
    schema(); fixtures();
    const before = snapshot();
    const o = asUser(OWNER, `update public.book_unit_purchases set paid_amount_pence = 1, payment_intent_id = 'pi_forged', owner_id = '${OWNER}' where id='${PASS}';`);
    assert.match(o, /server-managed/);
    assert.equal(snapshot(), before);
  });

  test('the mutation really removed only the refusal (the test is not mutating something else)', () => {
    const real = REAL_LOCK(); const mutated = NEUTERED_LOCK();
    assert.notEqual(real, mutated);
    assert.match(real, /raise exception 'pass payment, amount and ownership fields are server-managed'/);
    assert.doesNotMatch(mutated, /raise exception 'pass payment/);
    assert.match(mutated, /to_jsonb\(new\) - lifecycle/);
  });
});

/* ── The allowlist is empty because no client writes this table — keep it so ─ */

describe('the empty allowlist matches reality: no client or non-service code writes this table', () => {
  const sqlSrc = REAL_LOCK();

  test('the migration\'s allowlist is empty and server writes are exempt; only UPDATE is guarded', () => {
    assert.match(sqlSrc, /lifecycle text\[\] := array\[\]::text\[\];/);
    assert.match(sqlSrc, /if public\.tg_is_server_write\(\) then return new; end if;/);
    assert.match(sqlSrc, /if tg_op <> 'UPDATE' then return new; end if;/);
    assert.match(sqlSrc, /\(to_jsonb\(new\) - lifecycle\) is distinct from \(to_jsonb\(old\) - lifecycle\)/);
  });

  const walk = (dir: string, out: string[] = []): string[] => {
    if (!existsSync(dir)) return out;
    for (const name of readdirSync(dir)) {
      if (['node_modules', '.next', '.git', 'tests', 'migrations', 'migrations_archive', '_shared'].includes(name)) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) out.push(full);
    }
    return out;
  };
  const WRITE = /\.from\(\s*['"]book_unit_purchases['"]\s*\)\s*\.\s*(insert|update|upsert|delete)\b/;

  test('no mobile or web client code writes to book_unit_purchases (a new write site must add its column to the allowlist)', () => {
    const roots = [
      ...['app', 'lib', 'components', 'hooks'].map((d) => join(REPO_ROOT, d)),
      ...['app', 'lib', 'components'].map((d) => join(WEB_ROOT, d)),
    ];
    const files = roots.flatMap((r) => walk(r));
    assert.ok(files.length > 100, `scanned too few client files (${files.length})`);
    const offenders = files.filter((f) => WRITE.test(readFileSync(f, 'utf8').replace(/\s+/g, ' ')));
    assert.deepEqual(offenders, [], 'a client writes book_unit_purchases — add exactly that column to the lock\'s allowlist');
  });

  test('every edge function that writes it uses the service-role client', () => {
    const fnDir = join(REPO_ROOT, 'supabase/functions');
    const writers = walk(fnDir).concat(
      readdirSync(join(fnDir, '_shared')).filter((n) => n.endsWith('.ts')).map((n) => join(fnDir, '_shared', n)))
      .filter((f) => /book_unit_purchases/.test(readFileSync(f, 'utf8')))
      .filter((f) => /\.from\(\s*['"]book_unit_purchases['"]\s*\)\s*\.\s*(insert|update|upsert|delete)\b/.test(readFileSync(f, 'utf8').replace(/\s+/g, ' ')));
    assert.ok(writers.length >= 3, `expected the known server writers, found ${writers.length}`);
    for (const f of writers) {
      const s = readFileSync(f, 'utf8');
      const viaShared = f.includes('_shared');
      assert.ok(viaShared || /SUPABASE_SERVICE_ROLE_KEY/.test(s), `${f} writes the table without a service-role client`);
    }
  });

  test('the client-callable RPCs that create a purchase (claim_gift, claim_gift_by_id) are SECURITY DEFINER in their migrations', () => {
    const all = readdirSync(MIG).filter((n) => n.endsWith('.sql')).sort();
    for (const fn of ['claim_gift', 'claim_gift_by_id']) {
      let last = '';
      for (const f of all) {
        const s = src(join(MIG, f));
        const m = [...s.matchAll(new RegExp(`create (?:or replace )?function public\\.${fn}\\([^$]*?\\$(?:function)?\\$`, 'gi'))];
        if (m.length) last = m[m.length - 1][0];
      }
      assert.ok(last, `${fn} definition not found`);
      assert.match(last, /security definer/i, `${fn} must be SECURITY DEFINER`);
    }
  });
});
