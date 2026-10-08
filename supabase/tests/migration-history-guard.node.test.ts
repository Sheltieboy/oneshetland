/**
 * migration-history-guard.node.test.ts — `supabase db push` must not look safe while production's REGISTERED history and the repository differ.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyse, parseRegistered, localVersions } from '../../scripts/check-migration-history.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const snapshot = JSON.parse(readFileSync(join(ROOT, 'supabase/production/registered-migrations.json'), 'utf8'));
const hand = JSON.parse(readFileSync(join(ROOT, 'supabase/production/hand-applied-migrations.json'), 'utf8')).migrations;
const local = localVersions();

describe('the comparison', () => {
  test('agreement is the only safe state', () => { assert.equal(analyse(['1', '2'], ['1', '2'], []).safe_to_push, true); });
  test('a file production has not registered, a registered version with no file, and a stale hand-applied entry are each reported', () => {
    const r = analyse(['1', '2', '3'], ['1', '2', '9'], ['2', '3']);
    assert.deepEqual(r.unregistered_known, ['3']); assert.deepEqual(r.unregistered_unknown, []);
    assert.deepEqual(r.registered_without_file, ['9']); assert.deepEqual(r.stale_hand_applied_entries, ['2']); assert.equal(r.safe_to_push, false);
  });
  test('an unregistered file that is NOT on the hand-applied list is flagged as possibly unapplied', () => {
    assert.deepEqual(analyse(['1', '2'], ['1'], []).unregistered_unknown, ['2']);
  });
  test('reads both a JSON list and `supabase migration list` output', () => {
    assert.deepEqual(parseRegistered('["20260101000000","20260102000000"]'), ['20260101000000', '20260102000000']);
    assert.deepEqual(parseRegistered('   Local          | Remote         | Time (UTC)\n  ----------------|----------------|------\n   20260101000000 | 20260101000000 | 2026-01-01 00:00:00\n   20260102000000 |                | 2026-01-02 00:00:00\n'), ['20260101000000']);
  });
});

describe('the repository against the production snapshot', () => {
  test('migration files are unique and in ascending order (no version collisions)', () => {
    const files = readdirSync(join(ROOT, 'supabase/migrations')).filter((f) => f.endsWith('.sql'));
    const versions = files.map((f) => f.split('_')[0]);
    assert.equal(new Set(versions).size, versions.length);
    assert.deepEqual([...versions], [...versions].sort());
    for (const f of files) assert.match(f, /^\d{14}_[a-z0-9_]+\.sql$/, f);
  });
  test('every registered production version has a file', () => {
    for (const v of snapshot.versions) assert.ok(local.includes(v), `registered version ${v} has no migration file`);
  });
  test('the files production has not registered are EXACTLY the documented hand-applied list', () => {
    const unregistered = local.filter((v) => !snapshot.versions.includes(v));
    assert.deepEqual(unregistered, hand.map((m: any) => m.version));
    assert.equal(hand.length, 29);
  });
  test('the command refuses (exit 1) while they differ, and says why', () => {
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts/check-migration-history.mjs'), '--snapshot'], { encoding: 'utf8' });
    assert.equal(r.status, 1); assert.match(r.stdout, /DO NOT RUN `supabase db push`/); assert.match(r.stdout, /29 migration\(s\) are applied in production but not registered/);
  });
  test('it passes once the history agrees (simulated: snapshot with the hand-applied versions registered)', () => {
    const all = local; const r = analyse(local, all, hand.map((m: any) => m.version)); assert.equal(r.safe_to_push, true);
  });
});

describe('hand-applied supplements are recorded, not hidden', () => {
  const dir = join(ROOT, 'supabase/production/hand-applied-supplements');
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql'));
  test('there are exactly the documented supplements, each attached to an existing migration version, and none lives in supabase/migrations', () => {
    assert.deepEqual(files.sort(), [
      '20260807160000_listing_source.supplement.sql',
      '20260903120000_subscription_same_second_reconcile.supplement.sql',
      '20260925120000_public_business_view.supplement.sql',
    ]);
    for (const f of files) {
      assert.ok(local.includes(f.split('_')[0]), `${f}: no migration with that version`);
      assert.match(readFileSync(join(dir, f), 'utf8'), /NOT A MIGRATION, NOT run by `supabase db push`/);
    }
    assert.equal(readdirSync(join(ROOT, 'supabase/migrations')).filter((f) => f.includes('supplement')).length, 0);
  });
});
