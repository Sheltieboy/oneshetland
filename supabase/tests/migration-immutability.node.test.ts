/**
 * migration-immutability.node.test.ts — an applied migration can never be edited, renamed or renumbered.
 * Offline: compares every migration file with the snapshot of what production RECORDED (supabase/production/registered-migrations.json: names + hash of each
 * version's recorded statements, refreshed by scripts/snapshot-production-migrations.mjs). Run: node --test supabase/tests/migration-immutability.node.test.ts
 *
 * If this fails you edited a migration production has already applied. Do not "fix" the snapshot: revert the file and put the change in a NEW migration.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { hashOf } from '../../scripts/lib/migration-normalise.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
const MIG = join(ROOT, 'supabase', 'migrations');
const snap = JSON.parse(readFileSync(join(ROOT, 'supabase', 'production', 'registered-migrations.json'), 'utf8')) as { versions: string[]; names: Record<string, string>; content_sha256: Record<string, string> };
const hand = (JSON.parse(readFileSync(join(ROOT, 'supabase', 'production', 'hand-applied-migrations.json'), 'utf8')).migrations as { version: string }[]).map((m) => m.version);
const files = readdirSync(MIG).filter((f) => f.endsWith('.sql')).map((f) => { const m = /^(\d+)_(.+)\.sql$/.exec(f)!; return { file: f, version: m[1], name: m[2] }; });

test('the snapshot carries a name for every registered version and a content hash for every one that recorded statements', () => {
  assert.equal(snap.versions.length, Object.keys(snap.names).length);
  for (const v of snap.versions) assert.ok(snap.names[v], v);
  assert.ok(Object.keys(snap.content_sha256).length >= snap.versions.length - 1, 'only the baseline recorded no statements');
});
test('every registered version has exactly one file, under the NAME production recorded', () => {
  for (const v of snap.versions) {
    const f = files.filter((x) => x.version === v);
    assert.equal(f.length, 1, `${v} (${snap.names[v]}): expected one file, found ${f.length}`);
    assert.equal(f[0].name, snap.names[v], `${v} is registered as "${snap.names[v]}" but the file is "${f[0].name}"`);
  }
});
test('every applied migration is byte-for-byte what production recorded (ignoring comments and whitespace)', () => {
  const edited: string[] = [];
  for (const f of files) { const want = snap.content_sha256[f.version]; if (want && hashOf(readFileSync(join(MIG, f.file), 'utf8')) !== want) edited.push(f.file); }
  assert.deepEqual(edited, [], `applied migration(s) edited after being applied: ${edited.join(', ')}`);
});
test('no two files share a version, and a file production has never registered must be on the hand-applied list or is pending (and then not older than the newest applied version)', () => {
  const seen = new Set<string>(); for (const f of files) { assert.ok(!seen.has(f.version), `duplicate version ${f.version}`); seen.add(f.version); }
  const newest = [...snap.versions].sort().at(-1)!;
  for (const f of files.filter((x) => !snap.versions.includes(x.version))) {
    if (hand.includes(f.version)) continue;                                   // applied by hand, awaiting a deliberate `migration repair`
    assert.ok(f.version > newest, `${f.file} is unregistered AND older than production's newest version ${newest}: renumber it above ${newest}`);
  }
});
