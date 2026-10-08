#!/usr/bin/env node
/**
 * check-migration-history.mjs — is it safe to run `supabase db push` against production?
 *
 * Not while the repository's migration files and the versions production has REGISTERED differ. Some production migrations were applied
 * by hand and never recorded in supabase_migrations.schema_migrations (supabase/production/hand-applied-migrations.json); `db push`
 * would try to apply them a second time. This compares the two lists and exits non-zero until they agree.
 *
 *   node scripts/check-migration-history.mjs                       reads the registered versions with `supabase migration list --linked` (READ-ONLY)
 *   node scripts/check-migration-history.mjs --snapshot            offline: uses supabase/production/registered-migrations.json
 *   node scripts/check-migration-history.mjs --registered <file>   offline: a JSON array of versions, or saved `migration list` output
 *   add --json for machine-readable output
 *
 * Exit 0 = repository and registered history agree. Exit 1 = they differ (do not db push). Exit 2 = could not read the history.
 * Never writes to production and carries no credentials: the CLI handles its own login.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const localVersions = (dir = join(ROOT, 'supabase/migrations')) =>
  readdirSync(dir).filter((f) => /^\d{14}_.+\.sql$/.test(f)).map((f) => f.slice(0, 14)).sort();

/** Registered versions out of JSON ([..] or {versions:[..]}) or `supabase migration list` text (Local | Remote | Time). */
export function parseRegistered(text) {
  const t = text.trim();
  if (t.startsWith('[') || t.startsWith('{')) { const j = JSON.parse(t); return (Array.isArray(j) ? j : j.versions).map(String).sort(); }
  const out = [];
  for (const line of t.split('\n')) {
    const cols = line.split('|').map((c) => c.trim());
    if (cols.length >= 2 && /^\d{14}$/.test(cols[1])) out.push(cols[1]);
  }
  return out.sort();
}

export function analyse(local, registered, handApplied) {
  const reg = new Set(registered), loc = new Set(local), hand = new Set(handApplied);
  const localOnly = local.filter((v) => !reg.has(v));
  return {
    unregistered_known: localOnly.filter((v) => hand.has(v)),
    unregistered_unknown: localOnly.filter((v) => !hand.has(v)),
    registered_without_file: registered.filter((v) => !loc.has(v)),
    stale_hand_applied_entries: handApplied.filter((v) => !localOnly.includes(v)),
    safe_to_push: localOnly.length === 0 && registered.every((v) => loc.has(v)),
  };
}

function main(argv) {
  const a = argv.slice(2); const opt = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const hand = JSON.parse(readFileSync(join(ROOT, 'supabase/production/hand-applied-migrations.json'), 'utf8')).migrations.map((m) => m.version);
  let registered;
  try {
    if (a.includes('--snapshot')) registered = parseRegistered(readFileSync(join(ROOT, 'supabase/production/registered-migrations.json'), 'utf8'));
    else if (opt('--registered')) registered = parseRegistered(readFileSync(opt('--registered'), 'utf8'));
    else registered = parseRegistered(execFileSync('supabase', ['migration', 'list', '--linked'], { encoding: 'utf8' }));
  } catch (e) { console.error(`could not read the registered migration history: ${e.message}`); return 2; }
  const r = analyse(localVersions(), registered, hand);
  if (a.includes('--json')) console.log(JSON.stringify(r, null, 2));
  else if (r.safe_to_push) console.log('Repository migrations and registered production history agree.');
  else {
    console.log('DO NOT RUN `supabase db push` AGAINST PRODUCTION.');
    if (r.unregistered_known.length) console.log(`  ${r.unregistered_known.length} migration(s) are applied in production but not registered (hand-applied); db push would run them again:\n    ${r.unregistered_known.join('\n    ')}`);
    if (r.unregistered_unknown.length) console.log(`  ${r.unregistered_unknown.length} migration file(s) are neither registered nor listed as hand-applied — they may be UNAPPLIED:\n    ${r.unregistered_unknown.join('\n    ')}`);
    if (r.registered_without_file.length) console.log(`  ${r.registered_without_file.length} registered version(s) have no file in the repository:\n    ${r.registered_without_file.join('\n    ')}`);
    if (r.stale_hand_applied_entries.length) console.log(`  hand-applied list has stale entries (now registered or missing): ${r.stale_hand_applied_entries.join(', ')}`);
    console.log('  See docs/MIGRATION-HISTORY.md. Registration is a separate, explicitly approved step.');
  }
  return r.safe_to_push ? 0 : 1;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv));
