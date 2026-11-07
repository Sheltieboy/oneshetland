#!/usr/bin/env node
/**
 * events-release-dryrun.mjs — assemble the ROLLED-BACK production dry run for the three Events migrations from the actual migration files.
 *
 *   node scripts/events-release-dryrun.mjs --ids ids.json [--minimal] > dryrun.sql
 *   supabase db query --linked -f dryrun.sql -o json > result.json        (ONE transaction, short lock/statement timeouts, ends in ROLLBACK)
 *
 * Why this exists: each migration wraps itself in `begin; ... commit;`. Pasted into a dry run as they are, the first `commit;` would make the
 * migration PERMANENT. This tool strips exactly those lines (it refuses unless each file has exactly one of each), sets lock_timeout 1.5s /
 * statement_timeout 15s / idle_in_transaction_session_timeout 30s, and refuses to emit anything containing another commit / abort / savepoint,
 * more than one begin, or anything but a single final rollback. It only READS files and prints SQL; it never touches the database.
 *
 * ids.json supplies the production identifiers the checks act as (found with the read-only query in docs/events-staged-release-plan.md):
 *   { "ADMIN_ID", "MEMBER_ID", "BUSINESS_OWNER_ID", "BUSINESS_ID", "BUSINESS_EVENT_ID", "PLAIN_PLATFORM_EVENT_ID", "TICKETED_EVENT_ID", "TICKET_TYPE_ID" }
 * --minimal: apply the migrations and run the structural checks only (about 150 ms of lock), no behavioural checks.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const MIGRATIONS = ['20261230000000_event_occurrences.sql', '20261230010000_event_member_submissions.sql', '20261230020000_event_contributor_self_service.sql'];
const REL = join(ROOT, 'supabase/production/events-release');
export const TOKEN_KEYS = ['ADMIN_ID', 'MEMBER_ID', 'BUSINESS_OWNER_ID', 'BUSINESS_ID', 'BUSINESS_EVENT_ID', 'PLAIN_PLATFORM_EVENT_ID', 'TICKETED_EVENT_ID', 'TICKET_TYPE_ID'];

/** Remove the migration's own transaction wrapper. Refuses unless there is exactly one `begin;` and one `commit;` line. */
export function stripTransaction(sql, name) {
  let begins = 0, commits = 0;
  const out = sql.split('\n').filter((line) => {
    if (/^\s*begin\s*;\s*$/i.test(line)) { begins++; return false; }
    if (/^\s*commit\s*;\s*$/i.test(line)) { commits++; return false; }
    return true;
  });
  if (begins !== 1 || commits !== 1) throw new Error(`${name}: expected exactly one begin; and one commit; line, found ${begins} and ${commits}`);
  return out.join('\n');
}

export function assemble({ ids, minimal = false, migrationsDir = join(ROOT, 'supabase/migrations'), read = (p) => readFileSync(p, 'utf8') }) {
  const missing = TOKEN_KEYS.filter((k) => !ids?.[k] || !/^[0-9a-f-]{36}$/i.test(ids[k]));
  if (missing.length) throw new Error(`ids.json needs a UUID for: ${missing.join(', ')}`);
  let head = read(join(REL, 'dryrun-template.sql'));
  if (!head.includes('-- @@MIGRATIONS@@')) throw new Error('template has no migration marker');
  const mig = MIGRATIONS.map((f) => `insert into dr(k,v) values ('t.before.${f.slice(0, 14)}', clock_timestamp()::text);\n${stripTransaction(read(join(migrationsDir, f)), f)}\ninsert into dr(k,v) values ('t.after.${f.slice(0, 14)}', clock_timestamp()::text);`).join('\n');
  // a replacer FUNCTION: a plain replacement string would treat `$$` (every function body in the migrations) as the special pattern for a single `$`
  let sql = head.replace('-- @@MIGRATIONS@@', () => mig);
  if (!minimal) sql += '\n' + read(join(REL, 'dryrun-behaviour.sql'));
  sql += "\ninsert into dr(k,v) values ('t.end', clock_timestamp()::text);\nselect k, v from dr order by n;\nrollback;\n";
  for (const k of TOKEN_KEYS) sql = sql.split(`@@${k}@@`).join(ids[k]);
  verify(sql);
  return sql;
}

/** The safety gate: refuse to emit anything that could end or escape the transaction. */
export function verify(sql) {
  const lines = sql.split('\n');
  const count = (re) => lines.filter((l) => re.test(l)).length;
  if (/@@/.test(sql)) throw new Error('unresolved @@token@@ left in the SQL');
  if (count(/^begin;$/) !== 1 || lines[0] !== 'begin;') throw new Error('the SQL must start with exactly one begin;');
  if (count(/^rollback;$/) !== 1 || lines.filter((l) => l.trim()).at(-1) !== 'rollback;') throw new Error('the SQL must end with exactly one rollback;');
  const body = sql.replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, (m) => m);   // dollar-quoted bodies are checked too: a commit inside a function body is still a smell
  const forbidden = body.split('\n').filter((l) => /^\s*(commit|abort|end\s+transaction|savepoint|release\s+savepoint|prepare\s+transaction|start\s+transaction)\b/i.test(l));
  if (forbidden.length) throw new Error(`forbidden transaction control: ${forbidden[0].trim()}`);
  for (const need of ["set local lock_timeout = '1500ms'", "set local statement_timeout = '15s'", "set local idle_in_transaction_session_timeout = '30s'"]) if (!sql.includes(need)) throw new Error(`missing ${need}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--ids');
  if (at < 0) { console.error('usage: node scripts/events-release-dryrun.mjs --ids ids.json [--minimal] > dryrun.sql'); process.exit(2); }
  try {
    const sql = assemble({ ids: JSON.parse(readFileSync(args[at + 1], 'utf8')), minimal: args.includes('--minimal') });
    process.stdout.write(sql);
    console.error(`assembled ${sql.split('\n').length} lines: 1 begin, 1 final rollback, no commit; ${args.includes('--minimal') ? 'structural checks only' : 'structural + behavioural checks'}`);
  } catch (e) { console.error(`REFUSED: ${e.message}`); process.exit(1); }
}
