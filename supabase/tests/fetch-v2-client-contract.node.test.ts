/**
 * fetch-v2-client-contract.node.test.ts — Fetch v2 Step 13: the website's and the app's shared client (lib/fetch-api.ts, byte-identical
 * in both since Step 12) still matches this backend. Pure: reads source files only; no database, no network.
 *
 *   - every database function the client may call exists here (its latest definition), with every argument name the client sends;
 *   - every edge function the client may call exists;
 *   - the create body is a subset of exactly what fetch-v2-create forwards, and carries no money, status or driver field.
 *
 * Reads the client from the web worktree (../oneshetland-web-fetch-v2, or FETCH_WEB_ROOT); skips with a reason when it is absent.
 * Run: node --test supabase/tests/fetch-v2-client-contract.node.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_ROOT = process.env.FETCH_WEB_ROOT ?? join(REPO_ROOT, '..', 'oneshetland-web-fetch-v2');
const CLIENT = join(WEB_ROOT, 'lib/fetch-api.ts');
const skip = existsSync(CLIENT) ? false : `the shared client is not at ${CLIENT} (set FETCH_WEB_ROOT)`;
const client = skip ? '' : readFileSync(CLIENT, 'utf8');

const list = (name: string) => [...(client.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const`))?.[1] ?? '').matchAll(/"([a-z0-9_-]+)"/g)].map((m) => m[1]);

/** The parameter names of each public function's LATEST definition across all migrations (later files win). */
function signatures(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const dir = join(REPO_ROOT, 'supabase/migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(dir, f), 'utf8');
    for (const m of sql.matchAll(/create\s+or\s+replace\s+function\s+public\.([a-z0-9_]+)\s*\(([^)]*)\)/gi)) {
      out.set(m[1], m[2].split(',').map((p) => p.trim().split(/\s+/)[0]).filter(Boolean));
    }
  }
  return out;
}

describe('the shared Fetch client matches this backend', { skip }, () => {
  const sigs = skip ? new Map<string, string[]>() : signatures();
  test('every allow-listed database function exists', () => {
    const rpcs = list('FETCH_RPCS');
    assert.ok(rpcs.length >= 20, `found ${rpcs.length}`);
    for (const fn of rpcs) assert.ok(sigs.has(fn), `${fn} is not defined by any migration`);
  });
  test('every argument the client sends is a parameter of that function', () => {
    let calls = 0;
    for (const m of client.matchAll(/this\.rpc(?:<[^>]*>)?\("([a-z0-9_]+)"(?:,\s*\{([^}]*)\})?\)/g)) {
      const fn = m[1];
      const args = [...(m[2] ?? '').matchAll(/\b(p_[a-z_]+)\s*:/g)].map((a) => a[1]);
      for (const a of args) assert.ok(sigs.get(fn)?.includes(a), `${fn}(${a}) — the function takes (${sigs.get(fn)?.join(', ')})`);
      calls++;
    }
    assert.ok(calls >= 20, `parsed ${calls} rpc calls`);
  });
  test('every allow-listed edge function exists', () => {
    for (const fn of list('FETCH_EDGES')) assert.ok(existsSync(join(REPO_ROOT, 'supabase/functions', fn, 'index.ts')), `supabase/functions/${fn}/index.ts`);
  });
  test('the create body is what fetch-v2-create forwards — no money, status or driver field', () => {
    const intake = readFileSync(join(REPO_ROOT, 'supabase/functions/_shared/fetch-v2-intake.ts'), 'utf8');
    const forwarded = [...(intake.match(/const FORWARDED = \[([\s\S]*?)\] as const/)?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    const accepted = new Set([...forwarded, 'idempotency_key', 'pickup', 'destination']);
    const body = client.match(/create\(c: CreateInput\) \{[\s\S]*?const body: Record<string, unknown> = \{([\s\S]*?)\};/)?.[1] ?? '';
    const keys = [...body.matchAll(/\b([a-z_]+):/g)].map((m) => m[1]);
    assert.ok(keys.length >= 15, `parsed ${keys.length} create keys`);
    for (const k of keys) assert.ok(accepted.has(k), `the client sends ${k}, which the server does not forward`);
    for (const k of keys) assert.ok(!/pence|price|fee|total|amount|hold|^status$|^payment|^driver_id$|(^|_)(lat|lng)$/.test(k), `money/state field ${k}`);
  });
});
