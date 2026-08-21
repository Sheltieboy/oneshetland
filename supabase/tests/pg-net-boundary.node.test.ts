/**
 * pg-net-boundary.node.test.ts — the outbound-HTTP primitive stays unreachable.
 *
 * WHAT THIS GUARDS, AND WHAT IT CANNOT FIX
 *
 * pg_net gives the database an outbound HTTP primitive. In this project it is
 * the transport for the whole scheduler: pg_cron runs as postgres, calls
 * net.http_post, and that reaches the Edge Functions.
 *
 * anon and authenticated can also call it. Proven directly against production,
 * inside a rolled-back transaction, against a local blackhole address:
 *
 *   anon           net.http_post()             ALLOWED (request queued)
 *   anon           INSERT into request queue   ALLOWED
 *   anon           SELECT request queue        ALLOWED  ← headers in flight
 *   anon           SELECT responses            ALLOWED
 *   authenticated  ... the same four
 *
 * The queue row matters as much as the function: net.http_request_queue holds
 * the HEADERS of pending requests, and the scheduler's requests carry the
 * Vault-backed x-cron-secret. Being able to INSERT there is also a second route
 * to the same primitive that revoking EXECUTE would not have closed.
 *
 * THIS CANNOT BE REVOKED FROM THIS DATABASE ROLE. Proven, not assumed:
 *
 *   REVOKE EXECUTE ... FROM PUBLIC     ran, ACL unchanged (=X/supabase_admin)
 *   REVOKE ALL ON queue FROM PUBLIC    ran, ACL byte-identical
 *   REVOKE USAGE ON SCHEMA net         ran, anon still has USAGE
 *   ALTER FUNCTION ... OWNER TO postgres   42501 must be owner
 *   ALTER TABLE ... OWNER TO postgres      42501 must be owner
 *   SET ROLE supabase_admin                42501
 *   ALTER EVENT TRIGGER ... DISABLE        42501 must be owner
 *
 * Every pg_net object is owned by supabase_admin. postgres is not a superuser,
 * not a member of that role, and holds no grant option — so REVOKE is a silent
 * no-op: it succeeds, warns, and changes nothing. A migration full of those
 * revokes would look like a fix and be none, which is why there is no Step 10C
 * migration and this test exists instead.
 *
 * SO WHAT ACTUALLY PROTECTS THIS
 *
 * Containment, not privilege: the primitive is unreachable from the internet
 * because PostgREST does not expose the `net` schema and nothing client-callable
 * wraps it. Every probe returns 404 or 406.
 *
 * That containment is the thing this test defends. The grant is latent; it
 * becomes a live SSRF the moment somebody exposes the schema, or writes one
 * SECURITY DEFINER helper in `public` that passes a URL through to net.http_*.
 * Those are the changes a person here can actually make, so those are what is
 * asserted.
 *
 * Run: npm test
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The pg_net functions client roles can execute TODAY. This is a record of an
 * unfixed platform-owned exposure, not an approval of it.
 *
 * If this set GROWS, a new outbound primitive has appeared and the containment
 * argument must be re-made for it. If it SHRINKS, Supabase has tightened pg_net
 * and this finding can finally be closed. Either way a human should look.
 */
const KNOWN_CLIENT_EXECUTABLE = [
  '_await_response', '_encode_url_with_params_array', '_http_collect_response',
  '_urlencode_string', 'check_worker_is_up', 'http_collect_response',
  'http_delete', 'http_get', 'http_post', 'wait_until_running', 'wake',
  'worker_restart',
].sort();

/** The three that actually send traffic. */
const OUTBOUND_PRIMITIVES = ['http_get', 'http_post', 'http_delete'];

function runSql(sql: string): string {
  try {
    return execFileSync('npx', ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${sql}`, '--output-format', 'json'],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 });
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; message?: string };
    throw new Error(`supabase db query failed: ${err.stdout || err.stderr || err.message}`);
  }
}
function rowsOf(out: string): Record<string, unknown>[] {
  const parsed = JSON.parse(out) as { rows?: Record<string, unknown>[]; _tag?: string; error?: unknown };
  if (parsed._tag === 'Error' || parsed.error) {
    throw new Error(`supabase db query returned an error: ${JSON.stringify(parsed.error).slice(0, 400)}`);
  }
  return parsed.rows ?? [];
}
const queryAll = (sql: string) => rowsOf(runSql(sql));
const query = (sql: string) => queryAll(sql)[0] ?? {};

function publicConfig(): { url: string; anonKey: string } | null {
  let url = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
  let anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';
  if (!url || !anonKey) {
    try {
      for (const line of readFileSync(join(REPO_ROOT, '.env'), 'utf8').split('\n')) {
        const m = line.match(/^\s*(EXPO_PUBLIC_SUPABASE_URL|EXPO_PUBLIC_SUPABASE_ANON_KEY)\s*=\s*(.+)\s*$/);
        if (!m) continue;
        const v = m[2].trim().replace(/^["']|["']$/g, '');
        if (m[1].endsWith('URL')) url ||= v; else anonKey ||= v;
      }
    } catch { /* handled below */ }
  }
  return url && anonKey ? { url, anonKey } : null;
}
const cfg = publicConfig();

// ── 1. The containment boundary — this is the part with teeth ───────────────

describe('pg_net is not reachable from the internet', () => {
  test('PostgREST does not expose the net schema', { skip: cfg ? false : 'no local Supabase config' }, async () => {
    // The latent grant only matters if something can reach it. These are the
    // routes an attacker holding nothing but the public anon key would try.
    const { url, anonKey } = cfg!;
    const headers = { apikey: anonKey, Authorization: `Bearer ${anonKey}`, 'Content-Type': 'application/json' };
    const attempts: Array<[string, Promise<Response>]> = [
      ['rpc/http_post', fetch(`${url}/rest/v1/rpc/http_post`, { method: 'POST', headers, body: '{"url":"http://127.0.0.1:1/"}' })],
      ['rpc/http_get',  fetch(`${url}/rest/v1/rpc/http_get`,  { method: 'POST', headers, body: '{"url":"http://127.0.0.1:1/"}' })],
      ['http_request_queue', fetch(`${url}/rest/v1/http_request_queue?limit=1`, { headers })],
      ['_http_response',     fetch(`${url}/rest/v1/_http_response?limit=1`,     { headers })],
      ['queue via Accept-Profile: net', fetch(`${url}/rest/v1/http_request_queue?limit=1`, { headers: { ...headers, 'Accept-Profile': 'net' } })],
    ];
    for (const [label, p] of attempts) {
      const res = await p;
      assert.ok(res.status === 404 || res.status === 406,
        `${label} answered ${res.status} — the net schema may be exposed, which turns a latent grant into a live SSRF`);
    }
  });

  test('no client-callable function anywhere wraps net.http_*', () => {
    // The other way this becomes reachable: one SECURITY DEFINER helper in a
    // schema PostgREST does expose, taking a URL and passing it through.
    const wrappers = queryAll(`
      select n.nspname as schema_name, p.proname, p.prosecdef::text as secdef,
             has_function_privilege('anon', p.oid, 'EXECUTE')::text          as anon_exec,
             has_function_privilege('authenticated', p.oid, 'EXECUTE')::text as auth_exec
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname not in ('net', 'pg_catalog', 'information_schema')
         and p.prosrc ~* 'net\\.http_'
       order by 1, 2;`);

    // grant_pg_net_access is Supabase's own event-trigger function. It lives in
    // `extensions` (not exposed), takes no arguments, and calls
    // pg_event_trigger_ddl_commands(), which errors outside a DDL event — so it
    // cannot be used as a request-forwarding wrapper.
    const risky = wrappers.filter((w) =>
      !(w.schema_name === 'extensions' && w.proname === 'grant_pg_net_access'));

    assert.deepEqual(risky, [],
      `a function outside net now references net.http_*: ` +
      risky.map((w) => `${w.schema_name}.${w.proname} (anon=${w.anon_exec}, authenticated=${w.auth_exec})`).join(', ') +
      ` — if it is client-callable and takes a URL, that is an SSRF route.`);
  });

  test('nothing in public exposes pg_net under another name', () => {
    const r = query(`
      select count(*)::text as n
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and (p.prosrc ~* 'net\\.http_' or p.prosrc ~* 'http_request_queue');`);
    assert.equal(r.n, '0', 'a function in the exposed public schema now references pg_net');
  });
});

// ── 2. The surface itself, pinned so any change is noticed ──────────────────

describe('the pg_net client-executable surface is unchanged', () => {
  let live: Record<string, unknown>[] = [];
  before(() => {
    live = queryAll(`
      select p.proname,
             has_function_privilege('anon', p.oid, 'EXECUTE')::text          as anon_exec,
             has_function_privilege('authenticated', p.oid, 'EXECUTE')::text as auth_exec,
             has_function_privilege('postgres', p.oid, 'EXECUTE')::text      as pg_exec
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'net'
       order by p.proname;`);
  });

  test('the set of client-executable pg_net functions is exactly the known set', () => {
    assert.ok(live.length > 0, 'read no pg_net functions — this check would pass vacuously');
    const clientExec = live
      .filter((f) => f.anon_exec === 'true' || f.auth_exec === 'true')
      .map((f) => f.proname as string).sort();

    const added   = clientExec.filter((f) => !KNOWN_CLIENT_EXECUTABLE.includes(f));
    const removed = KNOWN_CLIENT_EXECUTABLE.filter((f) => !clientExec.includes(f));

    assert.deepEqual(added, [],
      `NEW pg_net functions are client-executable: ${added.join(', ')}. ` +
      `A new outbound primitive needs its own containment review.`);

    assert.deepEqual(removed, [],
      `pg_net functions are NO LONGER client-executable: ${removed.join(', ')}. ` +
      `This is good news — Supabase appears to have tightened pg_net. Update ` +
      `KNOWN_CLIENT_EXECUTABLE and close the Step 10C finding.`);
  });

  test('postgres retains execution — the scheduler depends on it', () => {
    for (const fn of OUTBOUND_PRIMITIVES) {
      const row = live.find((f) => f.proname === fn);
      assert.ok(row, `net.${fn} has disappeared — the scheduler transport is gone`);
      assert.equal(row!.pg_exec, 'true',
        `postgres lost EXECUTE on net.${fn} — every scheduled Edge Function call would fail`);
    }
  });

  test('pg_net stays on a version whose event trigger does NOT re-grant execute', () => {
    // extensions.grant_pg_net_access() runs on every pg_net DDL. For versions
    // 0.2 … 0.11.0 it makes http_get/http_post SECURITY DEFINER — owned by
    // supabase_admin — and grants EXECUTE explicitly to anon and authenticated.
    // A downgrade into that range would make this materially worse, not better.
    const r = query(`select extversion from pg_extension where extname = 'pg_net';`);
    const v = String(r.extversion ?? '');
    assert.ok(v, 'pg_net is not installed — the scheduler transport is gone');
    const [maj, min] = v.split('.').map((x) => parseInt(x, 10));
    assert.ok(maj > 0 || min >= 12,
      `pg_net is ${v}. Below 0.12.0 the Supabase event trigger makes net.http_get/http_post ` +
      `SECURITY DEFINER as supabase_admin and grants EXECUTE to anon and authenticated.`);
  });

  test('the re-granting event trigger is still the one we analysed', () => {
    // If this disappears or is replaced, the assumptions above need redoing.
    const r = query(`
      select count(*)::text as n
        from pg_event_trigger et join pg_proc p on p.oid = et.evtfoid
       where et.evtname = 'issue_pg_net_access' and p.proname = 'grant_pg_net_access';`);
    assert.equal(r.n, '1',
      'the issue_pg_net_access event trigger changed — re-derive how pg_net grants are applied');
  });
});

// ── 3. The queue is the other half of the primitive ─────────────────────────

describe('the pg_net queue tables', () => {
  test('their client access is recorded and unchanged', () => {
    // Documented, not endorsed: PUBLIC holds arwdDxtm on both, granted by
    // supabase_admin, and postgres cannot revoke it. Recorded here so a change
    // in either direction is noticed.
    const rows = queryAll(`
      select c.relname,
             has_table_privilege('anon', c.oid, 'SELECT')::text as anon_sel,
             has_table_privilege('anon', c.oid, 'INSERT')::text as anon_ins
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'net' and c.relkind in ('r','p')
       order by c.relname;`);
    assert.deepEqual(rows.map((r) => r.relname).sort(), ['_http_response', 'http_request_queue'],
      'the pg_net storage tables changed shape — re-derive the exposure');
    for (const r of rows) {
      assert.equal(r.anon_sel, 'true',
        `anon can no longer read net.${r.relname} — Supabase may have fixed this; update the test and close the finding`);
    }
  });
});
