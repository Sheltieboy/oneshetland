/**
 * identity-binding.node.test.ts — a client must not be able to choose which
 * user an RPC operates on.
 *
 * WHY THIS TEST EXISTS
 * ensure_member_code(p_user) and ensure_referral_code(p_user) were SECURITY
 * DEFINER, granted to anon and authenticated, and read the code straight out of
 * profiles WHERE id = p_user. profiles RLS otherwise keeps member_code private
 * — SELECT is limited to your own row — but these walked past it, so anyone
 * holding a user's UUID could read that user's permanent code. member_code is
 * how loyalty-till and wallet-charge-request identify a customer at a counter.
 *
 * Migration 20260819160000 pins an authenticated caller to auth.uid() and adds
 * no-argument versions that take no user id at all.
 *
 * TWO LAYERS, because they catch different regressions:
 *   1. HTTP with the public anon key — portable, needs no credentials, and
 *      proves the internet cannot reach these at all.
 *   2. Role simulation over the linked project — sets request.jwt.claims and
 *      SET ROLE exactly as PostgREST does, so it can test User A vs User B.
 *      Skipped with a clear message when the Supabase CLI or link is absent.
 *
 * SAFETY
 * Layer 2 runs inside a transaction that is always rolled back, so a code
 * minted during the test never persists. Codes are masked before printing.
 *
 * Run: npm test
 */

import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function publicConfig(): { url: string; anonKey: string } | null {
  let url = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
  let anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';
  if (!url || !anonKey) {
    try {
      for (const line of readFileSync(join(REPO_ROOT, '.env'), 'utf8').split('\n')) {
        const m = line.match(/^\s*(EXPO_PUBLIC_SUPABASE_URL|EXPO_PUBLIC_SUPABASE_ANON_KEY)\s*=\s*(.+)\s*$/);
        if (!m) continue;
        const value = m[2].trim().replace(/^["']|["']$/g, '');
        if (m[1].endsWith('URL')) url ||= value; else anonKey ||= value;
      }
    } catch { /* handled below */ }
  }
  return url && anonKey ? { url, anonKey } : null;
}

const cfg = publicConfig();
const SOME_UUID = '11111111-1111-1111-1111-111111111111';

async function callAsAnon(fn: string, body: unknown): Promise<{ status: number; message: string }> {
  const res = await fetch(`${cfg!.url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: cfg!.anonKey,
      Authorization: `Bearer ${cfg!.anonKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  let message = '';
  try { message = ((await res.json()) as { message?: string })?.message ?? ''; } catch { /* empty */ }
  return { status: res.status, message };
}

// ── Layer 1: the internet boundary ──────────────────────────────────────────

describe('anon cannot obtain anybody\'s member or referral code', () => {
  before(() => {
    if (!cfg) throw new Error('Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY (or provide a .env).');
  });

  const cases = [
    { fn: 'ensure_member_code', body: {}, label: 'no-arg' },
    { fn: 'ensure_member_code', body: { p_user: SOME_UUID }, label: 'with p_user' },
    { fn: 'ensure_referral_code', body: {}, label: 'no-arg' },
    { fn: 'ensure_referral_code', body: { p_user: SOME_UUID }, label: 'with p_user' },
  ];

  for (const { fn, body, label } of cases) {
    test(`${fn} (${label}) → denied to anon`, async () => {
      const { status, message } = await callAsAnon(fn, body);
      // 404 would mean PostgREST does not know this signature. For the no-arg
      // cases that is a real failure: clients depend on it existing.
      assert.notEqual(status, 404, `${fn} (${label}): PostgREST returned 404 — the overload is missing.`);
      assert.equal(
        status, 401,
        `SECURITY REGRESSION: ${fn} (${label}) answered the public anon key with HTTP ${status}. ` +
        `member_code is how the till identifies a customer; it must never be reachable anonymously.`,
      );
      assert.match(message, /permission denied/i);
    });
  }
});

// ── Layer 2: User A vs User B ───────────────────────────────────────────────

/** One round-trip through the CLI; returns the row, or null if unavailable. */
function simulateRoles(): Record<string, string> | null {
  const sql = `
begin;
create function pg_temp.as_role(p_role text, p_sub text, p_sql text) returns text
language plpgsql as $f$
declare r text;
begin
  if p_sub is null then perform set_config('request.jwt.claims','{"role":"'||p_role||'"}',true);
  else perform set_config('request.jwt.claims','{"sub":"'||p_sub||'","role":"'||p_role||'"}',true); end if;
  execute format('set local role %I', p_role);
  execute p_sql into r;
  execute 'reset role';
  return coalesce(left(r,3)||'~masked', '(null)');
exception
  when insufficient_privilege then execute 'reset role'; return 'DENIED';
  when others then execute 'reset role'; return 'DENIED:'||left(SQLERRM,30);
end $f$;
with u as (select id::text as id, row_number() over (order by created_at) rn from public.profiles limit 2)
select
  pg_temp.as_role('authenticated',(select id from u where rn=1),'select public.ensure_member_code()')   as a_first,
  pg_temp.as_role('authenticated',(select id from u where rn=1),'select public.ensure_member_code()')   as a_again,
  pg_temp.as_role('authenticated',(select id from u where rn=1),
      'select public.ensure_member_code('''||(select id from u where rn=2)||'''::uuid)')                as a_asks_b,
  pg_temp.as_role('authenticated',(select id from u where rn=2),'select public.ensure_member_code()')   as b_own,
  pg_temp.as_role('authenticated',(select id from u where rn=1),'select public.ensure_referral_code()') as a_ref,
  pg_temp.as_role('authenticated',(select id from u where rn=1),
      'select public.ensure_referral_code('''||(select id from u where rn=2)||'''::uuid)')              as a_ref_asks_b,
  pg_temp.as_role('authenticated',(select id from u where rn=1),
      'select public.ensure_member_code(''${SOME_UUID}''::uuid)')                                       as a_asks_ghost;
rollback;`;
  try {
    const out = execFileSync('npx', ['supabase', 'db', 'query', '--linked', sql, '--output-format', 'json'],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 90_000 });
    const parsed = JSON.parse(out) as { rows?: Record<string, string>[] };
    return parsed.rows?.[0] ?? null;
  } catch {
    return null;
  }
}

describe('an authenticated user is pinned to their own row', () => {
  let r: Record<string, string> | null = null;
  before(() => { r = simulateRoles(); });

  test('cross-user and identity assertions', (t) => {
    if (!r) {
      t.skip('Supabase CLI or linked project unavailable — run `supabase link` to exercise this layer.');
      return;
    }
    console.log('\n  role simulation (codes masked):\n' +
      Object.entries(r).map(([k, v]) => `    ${k.padEnd(14)} → ${v}`).join('\n') + '\n');

    // A gets a code, and the same one on a second call.
    assert.notEqual(r.a_first, 'DENIED', 'User A could not obtain their own member code.');
    assert.equal(r.a_again, r.a_first, 'Repeated calls returned different member codes.');

    // B gets a different code — proving the code really is per-user.
    assert.notEqual(r.b_own, 'DENIED', 'User B could not obtain their own member code.');
    assert.notEqual(r.b_own, r.a_first, 'Two users received the SAME member code.');

    // The attack: A naming B.
    assert.equal(r.a_asks_b, 'DENIED',
      'SECURITY REGRESSION: User A obtained User B\'s member code by passing p_user.');
    assert.equal(r.a_ref_asks_b, 'DENIED',
      'SECURITY REGRESSION: User A obtained User B\'s referral code by passing p_user.');

    // Naming a user that does not exist is refused for the same reason —
    // there is no longer any p_user an authenticated caller can pass but their own.
    assert.equal(r.a_asks_ghost, 'DENIED',
      'SECURITY REGRESSION: an authenticated caller passed an arbitrary p_user.');

    // Referral code works for the caller.
    assert.notEqual(r.a_ref, 'DENIED', 'User A could not obtain their own referral code.');
  });
});
