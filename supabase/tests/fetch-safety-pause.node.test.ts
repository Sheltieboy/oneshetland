/**
 * fetch-safety-pause.node.test.ts — repository guards for the Fetch urgent safety fix (migration 20261212000000). No database, no network.
 * Run: node --test supabase/tests/fetch-safety-pause.node.test.ts
 *
 * They fail the build if a later change would undo the protections: re-create the dropped driver-read/accept policies, flip the switch open from a migration, remove the
 * guards, ship a function that bypasses the pause, or reuse a migration version number. The live behaviour is proved by supabase/tests/fetch-safety-pause.verify.sql.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const MIG = join(ROOT, 'supabase', 'migrations');
const SAFETY = '20261212000000';
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--.*$/gm, '');
const files = readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
const read = (f: string) => readFileSync(join(MIG, f), 'utf8');
const PROTECTED_POLICIES = ['Approved drivers can read all pending requests', 'Approved drivers can read pending requests', 'Approved drivers can accept pending requests', 'Drivers must have bank connected to accept requests'];

test('the safety migration, its rollback and the verification script are all present, and the rollback is NOT in the migrations folder', () => {
  assert.ok(files.some((f) => f.startsWith(`${SAFETY}_fetch_safety_pause`)));
  assert.ok(existsSync(join(ROOT, 'supabase', 'rollbacks', `${SAFETY}_fetch_safety_pause.rollback.sql`)));
  assert.ok(!files.some((f) => /rollback/i.test(f)), 'a rollback inside migrations/ could be applied by accident');
  const v = readFileSync(join(ROOT, 'supabase', 'tests', 'fetch-safety-pause.verify.sql'), 'utf8');
  assert.match(strip(v).trim(), /rollback;$/i); assert.doesNotMatch(strip(v), /\bcommit\b/i);
});
test('no two migrations share a version number', () => {
  const seen = new Map<string, string>(); for (const f of files) { const v = f.split('_')[0]; assert.ok(!seen.has(v), `${f} reuses version ${v} (also ${seen.get(v)})`); seen.set(v, f); }
});
test('the safety migration defaults to paused, drops the four dangerous policies, installs all three guards, and never opens Fetch', () => {
  const sql = strip(read(files.find((f) => f.startsWith(SAFETY))!));
  assert.match(sql, /'fetch\.operations', 'paused'/); assert.match(sql, /'paused'\) = 'open'/);
  for (const p of PROTECTED_POLICIES) assert.match(sql, new RegExp(`drop policy if exists "${p}"`));
  for (const t of ['delivery_requests_a_fetch_pause', 'runs_a_fetch_pause', 'driver_profiles_a_fetch_pause']) assert.match(sql, new RegExp(`create trigger ${t}`));
  assert.doesNotMatch(sql, /set value = 'open'|values \('fetch\.operations', 'open'/i);
});
test('NO LATER migration can undo it: it may not re-create the dropped policies, open the switch, remove the guards or switch, or grant drivers a read of pending requests', () => {
  for (const f of files.filter((x) => x.split('_')[0] > SAFETY)) {
    const sql = strip(read(f));
    for (const p of PROTECTED_POLICIES) assert.doesNotMatch(sql, new RegExp(`create policy "${p}"`, 'i'), `${f} re-creates "${p}"`);
    assert.doesNotMatch(sql, /fetch\.operations/i, `${f} touches the pause switch (reopening Fetch must be a deliberate, separately approved act)`);
    assert.doesNotMatch(sql, /drop (trigger|function)[^;]*(a_fetch_pause|fetch_is_open|tg_fetch_pause)/i, `${f} removes a guard`);
    assert.doesNotMatch(sql, /create policy[^;]*on\s+(public\.)?delivery_requests[^;]*for select[^;]*status\s*=\s*'pending'[^;]*driver_profiles/is, `${f} lets drivers read pending requests`);
  }
});
test('NO LATER migration may add a definer function that writes Fetch tables without consulting the pause (SECURITY DEFINER bypasses the guard triggers)', () => {
  for (const f of files.filter((x) => x.split('_')[0] > SAFETY)) {
    const sql = strip(read(f));
    const writesFetch = /security\s+definer[\s\S]*?(insert\s+into|update)\s+public\.(delivery_requests|runs|driver_profiles)\b/i.test(sql);
    if (writesFetch) assert.match(sql, /fetch_is_open\(\)/, `${f} adds a SECURITY DEFINER function that writes Fetch tables but never calls public.fetch_is_open()`);
  }
});
