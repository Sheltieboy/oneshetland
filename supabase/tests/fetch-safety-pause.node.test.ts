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
// Functions that legitimately write Fetch tables WITHOUT consulting the pause. Each is deliberate; a NEW definer writer must be classified here or gated.
const PAUSE_EXEMPT: Record<string, string> = {
  // keep protecting jobs and money that already exist while paused
  fetch_v2_release_internal: 'releases an existing hold', fetch_v2_cancel_matched_internal: 'cancels an existing job', fetch_v2_expire_due: 'expires existing requests/holds',
  fetch_v2_escalate_cancel_requests: 'escalates an existing cancel request', fetch_v2_retire_authorisation: 'retires an existing authorisation', fetch_v2_apply_payment_state: 'records the real state of an existing payment',
  fetch_v2_rotate_authorisation: 'renews an existing hold', fetch_v2_escalate_payment: 'escalates an existing payment problem', fetch_v2_bump_member: 'counter on an existing member',
  // audit trails and the notification outbox
  fetch_v2_log: 'audit log', fetch_v2_vlog: 'audit log', tg_driver_verification_file_deleted: 'audit trigger', fetch_v2_enqueue_notice: 'outbox (sending is separately gated)', fetch_v2_settle_notification: 'outbox bookkeeping',
  // verification administration: nothing here creates, accepts or approves; approving a driver changes driver_profiles.driver_status, which the driver_profiles guard blocks on every API path
  fetch_v2_decide_driver: 'approval -> driver_status, blocked by tg_fetch_pause_drivers (reject/suspend must stay possible)', fetch_v2_sync_verification: 'recomputes verification state', fetch_v2_open_verification_issue: 'staff issue',
  fetch_v2_apply_vehicle: 'applicant data', fetch_v2_discard_evidence_upload: 'cleanup', fetch_v2_review_evidence: 'staff review', fetch_v2_set_requirement: 'staff config', fetch_v2_record_evidence_file_deleted: 'cleanup',
  fetch_v2_verification_sweep: 'scheduled expiry of evidence', fetch_v2_discard_photo_upload: 'cleanup',
};
const FETCH_TABLES = /(delivery_requests|\bruns\b|driver_profiles|fetch_[a-z_]+|waiting_events|driver_verification_[a-z_]+)/;
function functionsIn(sql: string) {
  const out: { name: string; definer: boolean; writes: boolean; body: string }[] = [];
  for (const m of sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+public\.(\w+)\s*\((.*?)\)\s*(.*?)\$(\w*)\$(.*?)\$\4\$/gis))
    out.push({ name: m[1], definer: /security\s+definer/i.test(m[3]), writes: new RegExp(`(insert\\s+into|update|delete\\s+from)\\s+public\\.${FETCH_TABLES.source}`, 'i').test(m[5]), body: m[5] });
  return out;
}
test('EVERY definer function in a later migration that writes Fetch tables is gated by the pause (directly or through a gated helper) or deliberately exempt', () => {
  const fns = files.filter((x) => x.split('_')[0] > SAFETY).flatMap((f) => functionsIn(strip(read(f))));
  const gated = new Set(['fetch_is_open', 'fetch_is_api_call', 'fetch_v2_enabled_for', 'fetch_v2_enabled', 'fetch_v2_require', 'fetch_v2_audience']);
  for (let changed = true; changed;) { changed = false; for (const f of fns) if (!gated.has(f.name) && [...gated].some((g) => new RegExp(`\\b${g}\\s*\\(`).test(f.body))) { gated.add(f.name); changed = true; } }
  const loose = fns.filter((f) => f.definer && f.writes && !gated.has(f.name) && !(f.name in PAUSE_EXEMPT)).map((f) => f.name);
  assert.deepEqual(loose, [], `SECURITY DEFINER writer(s) with no pause check and no explicit exemption (add fetch_v2_require()/fetch_is_open(), or classify in PAUSE_EXEMPT): ${loose.join(', ')}`);
});
test('Fetch v2 can never be more open than Fetch: fetch_v2_audience() is off unless the master pause is open, so every v2 gate inherits it', () => {
  const f = files.find((x) => /_fetch_v2_feature_flag\.sql$/.test(x));
  if (!f) return;                                                      // the v2 migrations are not on every branch
  const a = functionsIn(strip(read(f))).find((x) => x.name === 'fetch_v2_audience')!;
  assert.match(a.body, /when not public\.fetch_is_open\(\) then 'off'/);
});
test('NO rollback script (other than the safety fix\'s own) may re-create the four dropped policies: rolling back must never re-open the privacy hole', () => {
  const RB = join(ROOT, 'supabase', 'rollbacks');
  for (const f of readdirSync(RB).filter((x) => x.endsWith('.sql') && !x.startsWith(`${SAFETY}_fetch_safety_pause`))) {
    const sql = strip(readFileSync(join(RB, f), 'utf8'));
    for (const p of PROTECTED_POLICIES) assert.doesNotMatch(sql, new RegExp(`create policy "${p}"`, 'i'), `${f} would re-create "${p}"`);
  }
});
