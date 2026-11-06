/**
 * admin-driver-applicant-contacts.node.test.ts — ISOLATED Postgres 17 only (throwaway local cluster). Proves the applicant-contact function is administrator-only,
 * returns only (driver_id, email), cannot be executed by anonymous callers, and leaves other people's data unreachable.
 * Run: node --test supabase/tests/admin-driver-applicant-contacts.node.test.ts   (skips itself without /opt/homebrew/opt/postgresql@17)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BIN = '/opt/homebrew/opt/postgresql@17/bin';
const have = existsSync(join(BIN, 'initdb'));
const MIGFILE = join(import.meta.dirname, '..', 'migrations', '20261212010000_admin_driver_applicant_contacts.sql');
const env = { ...process.env, LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8' };
let sock = '';
const sql = (q: string, user = 'postgres') => { const r = spawnSync(join(BIN, 'psql'), ['-h', sock, '-U', user, '-d', 't', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', q], { env, encoding: 'utf8' }); return { ok: r.status === 0, out: r.stdout.trim(), err: r.stderr }; };
const as = (role: string, uid: string, q: string) => sql(`begin; set local role ${role}; select set_config('request.jwt.claims', '{"sub":"${uid}","role":"${role}"}', true); ${q}; commit`, 'authenticator');
const ADMIN = '00000000-0000-0000-0000-0000000000a1', DRIVER = '00000000-0000-0000-0000-0000000000d1', CUST = '00000000-0000-0000-0000-0000000000c1', GONE = '00000000-0000-0000-0000-0000000000e1', NOMAIL = '00000000-0000-0000-0000-0000000000f1';

test('administrator-only applicant contacts', { skip: !have }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-')); sock = mkdtempSync(join('/tmp', 'acs-'));
  try {
    execFileSync(join(BIN, 'initdb'), ['--locale=en_US.UTF-8', '-D', join(dir, 'pg'), '-A', 'trust', '-U', 'postgres'], { env, stdio: 'ignore' });
    execFileSync(join(BIN, 'pg_ctl'), ['-D', join(dir, 'pg'), '-o', `-c listen_addresses='' -c unix_socket_directories=${sock} -c fsync=off`, '-l', join(dir, 'log'), '-w', 'start'], { env });
    execFileSync(join(BIN, 'psql'), ['-h', sock, '-U', 'postgres', '-X', '-q', '-c', 'create database t'], { env });
    sql(`create role anon nologin; create role authenticated nologin; create role service_role nologin; create role authenticator login noinherit; grant anon, authenticated, service_role to authenticator;
      create schema auth; create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid $$;
      create table auth.users(id uuid primary key, email text, deleted_at timestamptz);
      create table public.profiles(id uuid primary key, role text, phone text);
      create table public.driver_profiles(id uuid primary key, driver_status text, contact_phone text);
      create function public.is_admin() returns boolean language sql stable security definer as $$ select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin') $$;
      alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;   -- what Supabase does for every new function: the migration must take it back from anon
      grant usage on schema public, auth to anon, authenticated, service_role; grant execute on function public.is_admin() to anon, authenticated, service_role; grant execute on function auth.uid() to anon, authenticated, service_role;
      insert into auth.users values ('${ADMIN}', 'admin@example.org', null), ('${DRIVER}', 'driver@example.org', null), ('${CUST}', 'cust@example.org', null), ('${GONE}', 'gone@example.org', now()), ('${NOMAIL}', null, null);
      insert into public.profiles values ('${ADMIN}', 'admin', null), ('${DRIVER}', 'customer', '07000000001'), ('${CUST}', 'customer', null), ('${GONE}', 'customer', null), ('${NOMAIL}', 'customer', null);
      insert into public.driver_profiles values ('${DRIVER}', 'pending', '07000000001'), ('${GONE}', 'pending', null), ('${NOMAIL}', 'approved', null), ('${ADMIN}', 'approved', null);`);
    assert.ok(sql(readFileSync(MIGFILE, 'utf8')).ok, 'the migration applies');

    const a = as('authenticated', ADMIN, 'select driver_id::text || \'|\' || email from public.admin_driver_applicant_contacts() order by 1');
    assert.equal(a.ok, true); assert.deepEqual(a.out.split('\n').filter((l) => l.includes('@')).sort(), [`${ADMIN}|admin@example.org`, `${DRIVER}|driver@example.org`].sort(), 'an administrator gets (id, email) for live accounts with an email; nothing for deleted or email-less ones');
    for (const [who, uid] of [['a driver applicant', DRIVER], ['a customer', CUST]] as const) {
      const r = as('authenticated', uid, 'select * from public.admin_driver_applicant_contacts()'); assert.equal(r.ok, false, who); assert.match(r.err, /Only an administrator can do this/, who);
    }
    const anon = as('anon', '', 'select * from public.admin_driver_applicant_contacts()'); assert.equal(anon.ok, false); assert.match(anon.err, /permission denied/i, 'anonymous callers cannot execute it');
    assert.equal(sql(`select has_function_privilege('anon', 'public.admin_driver_applicant_contacts()', 'execute')`).out, 'f');
    const cols = sql(`select string_agg(a.attname, ',' order by a.attnum) from pg_proc p, lateral unnest(p.proargnames) with ordinality a(attname, attnum) where p.proname = 'admin_driver_applicant_contacts' and p.proargmodes is not null`).out;
    assert.match(cols, /driver_id,email/); assert.doesNotMatch(cols, /phone|name|address/, 'only the id and the email');
    assert.doesNotMatch(readFileSync(MIGFILE, 'utf8').replace(/--.*$/gm, ''), /contact_phone|\binsert\b|\bupdate\b|\bdelete\b|net\.http|notify/i, 'it reads two columns and writes or sends nothing');
  } finally { spawnSync(join(BIN, 'pg_ctl'), ['-D', join(dir, 'pg'), '-m', 'immediate', 'stop'], { env, stdio: 'ignore' }); rmSync(dir, { recursive: true, force: true }); rmSync(sock, { recursive: true, force: true }); }
});
