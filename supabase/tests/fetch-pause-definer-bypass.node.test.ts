/**
 * fetch-pause-definer-bypass.node.test.ts — ISOLATED Postgres 17 only (a throwaway local cluster; never a Supabase DSN). Proves:
 *   CONTROL  with only migration 20261212 a SECURITY DEFINER function reached through the API (session_user = authenticator) can still create a request while paused;
 *   FIX      with migration 20261213 the same call is blocked, while SQL run directly as the database owner, cancelling an existing request, and rejecting a driver still work;
 *   MASTER   fetch_v2_audience() (the root of every v2 gate) is 'off' for everyone while paused and follows fetch.v2.audience once Fetch is open.
 * Run: node --test supabase/tests/fetch-pause-definer-bypass.node.test.ts   (skips itself without /opt/homebrew/opt/postgresql@17)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BIN = '/opt/homebrew/opt/postgresql@17/bin';
const have = existsSync(join(BIN, 'initdb'));
const MIG = join(import.meta.dirname, '..', 'migrations');
const file = (prefix: string) => readFileSync(join(MIG, readdirNames().find((f) => f.startsWith(prefix))!), 'utf8');
import { readdirSync } from 'node:fs';
const readdirNames = () => readdirSync(MIG);
const env = { ...process.env, LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8' };
let dir = '', sock = '';
const sql = (q: string, user = 'postgres') => { const r = spawnSync(join(BIN, 'psql'), ['-h', sock, '-U', user, '-d', 't', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', q], { env, encoding: 'utf8' }); return { ok: r.status === 0, out: r.stdout.trim(), err: r.stderr }; };
const as = (role: string, q: string) => sql(`begin; set local role ${role}; select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001","role":"${role}"}', true); ${q}; commit`, 'authenticator');

test('isolated cluster: control, fix and master pause', { skip: !have }, () => {
  dir = mkdtempSync(join(tmpdir(), 'fp-')); sock = mkdtempSync(join('/tmp', 'fps-'));
  try {
    execFileSync(join(BIN, 'initdb'), ['--locale=en_US.UTF-8', '-D', join(dir, 'pg'), '-A', 'trust', '-U', 'postgres'], { env, stdio: 'ignore' });
    execFileSync(join(BIN, 'pg_ctl'), ['-D', join(dir, 'pg'), '-o', `-c listen_addresses='' -c unix_socket_directories=${sock} -c fsync=off`, '-l', join(dir, 'log'), '-w', 'start'], { env });
    execFileSync(join(BIN, 'psql'), ['-h', sock, '-U', 'postgres', '-X', '-q', '-c', 'create database t'], { env });
    sql(`create role anon nologin; create role authenticated nologin; create role service_role nologin; create role authenticator login noinherit; grant anon, authenticated, service_role to authenticator;
      create schema auth; create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid $$;
      create table public.admin_config(key text primary key, value text, category text, description text, is_secret boolean);
      create table public.profiles(id uuid primary key, role text);
      create function public.get_my_role() returns text language sql stable security definer as $$ select role from public.profiles where id = auth.uid() $$;
      create table public.delivery_requests(id uuid primary key default gen_random_uuid(), customer_id uuid, status text default 'pending', destination_address text);
      create table public.runs(id uuid primary key default gen_random_uuid(), driver_id uuid);
      create table public.driver_profiles(id uuid primary key, driver_status text);
      grant usage on schema public, auth to anon, authenticated, service_role; grant all on all tables in schema public to anon, authenticated, service_role;
      grant execute on all functions in schema public to anon, authenticated, service_role; grant execute on function auth.uid() to anon, authenticated, service_role;
      insert into public.profiles values ('00000000-0000-0000-0000-000000000001', 'customer');
      create function public.fetch_v2_definer_create() returns void language plpgsql security definer as $$ begin insert into public.delivery_requests(status) values ('pending'); end $$;
      create function public.fetch_v2_definer_approve(p uuid) returns void language plpgsql security definer as $$ begin update public.driver_profiles set driver_status = 'approved' where id = p; end $$;
      grant execute on function public.fetch_v2_definer_create(), public.fetch_v2_definer_approve(uuid) to authenticated, service_role;`);
    assert.ok(sql(file('20261212000000')).ok, 'migration 20261212 applies');
    sql(`insert into public.driver_profiles values ('00000000-0000-0000-0000-0000000000d1', 'pending'), ('00000000-0000-0000-0000-0000000000d2', 'pending'); insert into public.delivery_requests(id, status) values ('00000000-0000-0000-0000-0000000000a1', 'pending');`);
    assert.equal(sql(`select public.fetch_is_open()`).out, 'f', 'paused by default');

    // CONTROL: the gap that 20261213 closes
    assert.equal(as('authenticated', 'select public.fetch_v2_definer_create()').ok, true, 'CONTROL: before the fix a definer function reached through the API gets past the guard while paused');
    assert.equal(as('authenticated', `select public.fetch_v2_definer_approve('00000000-0000-0000-0000-0000000000d1')`).ok, true, 'CONTROL: approvals get past too');

    // DIRECT (invoker) paths: the guard triggers run AS the API role, so every helper they call must be executable by it. Paused: the pause message, never "permission denied".
    sql(`create or replace function public.tmp_probe() returns void language sql as $$ select 1 $$;`);
    // FIX
    assert.ok(sql(file('20261213000000')).ok, 'migration 20261213 applies');
    const c = as('authenticated', 'select public.fetch_v2_definer_create()'); assert.equal(c.ok, false); assert.match(c.err, /New delivery requests are paused/);
    const a = as('service_role', `select public.fetch_v2_definer_approve('00000000-0000-0000-0000-0000000000d2')`); assert.equal(a.ok, false); assert.match(a.err, /Driver approvals are paused/);
    assert.equal(as('service_role', `update public.driver_profiles set driver_status = 'rejected' where id = '00000000-0000-0000-0000-0000000000d2'`).ok, true, 'rejecting stays possible');
    assert.equal(as('service_role', `update public.delivery_requests set status = 'cancelled' where id = '00000000-0000-0000-0000-0000000000a1'`).ok, true, 'cancelling an existing request stays possible');
    for (const role of ['authenticated', 'anon', 'service_role']) {
      const d = as(role, `insert into public.delivery_requests(status) values ('pending')`); assert.equal(d.ok, false, `${role}: a DIRECT insert is blocked while paused`); assert.match(d.err, /New delivery requests are paused/, `${role}: the pause message, not a permission error: ${d.err}`);
      const r = as(role, `insert into public.runs(driver_id) values ('00000000-0000-0000-0000-000000000001')`); assert.match(r.err, /New runs are paused/, `${role}: ${r.err}`);
      const p = as(role, `insert into public.driver_profiles(id, driver_status) values (gen_random_uuid(), 'pending')`); assert.match(p.err, /Driver applications are paused/, `${role}: ${p.err}`);
    }
    assert.equal(sql(`select public.fetch_v2_definer_create()`).ok, true, 'SQL run directly as the database owner is not blocked');
    assert.equal(sql(`update public.admin_config set value = 'open' where key = 'fetch.operations'`).ok, true);
    assert.equal(as('authenticated', 'select public.fetch_v2_definer_create()').ok, true, 'open means open');
    for (const role of ['authenticated', 'service_role']) assert.equal(as(role, `insert into public.delivery_requests(status) values ('pending')`).ok, true, `${role}: a DIRECT insert works when open (no permission error from the guard)`);
    sql(`update public.admin_config set value = 'banana' where key = 'fetch.operations'`);
    assert.equal(as('authenticated', 'select public.fetch_v2_definer_create()').ok, false, 'garbage means paused');

    // MASTER: the v2 audience root
    if (!readdirNames().some((f) => f.startsWith('20261214000000_fetch_v2_feature_flag'))) return;   // the v2 migrations are not on this branch
    const aud = /create or replace function public\.fetch_v2_audience\(\)[\s\S]*?\$\$;/i.exec(file('20261214000000'))![0];
    assert.ok(sql(aud).ok); sql(`insert into public.admin_config(key, value) values ('fetch.v2.audience', 'everyone') on conflict (key) do update set value = excluded.value`);
    assert.equal(sql(`select public.fetch_v2_audience()`).out, 'off', 'paused: off for everyone even when the audience says everyone');
    sql(`update public.admin_config set value = 'open' where key = 'fetch.operations'`);
    assert.equal(sql(`select public.fetch_v2_audience()`).out, 'everyone', 'open: follows the audience');
    sql(`update public.admin_config set value = 'admins' where key = 'fetch.v2.audience'`); assert.equal(sql(`select public.fetch_v2_audience()`).out, 'admins');
  } finally { spawnSync(join(BIN, 'pg_ctl'), ['-D', join(dir, 'pg'), '-m', 'immediate', 'stop'], { env, stdio: 'ignore' }); rmSync(dir, { recursive: true, force: true }); rmSync(sock, { recursive: true, force: true }); }
});
