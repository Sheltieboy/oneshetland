#!/usr/bin/env node
/**
 * events-testers-release.mjs — the ROLLED-BACK production dry run (and post-apply check) for migration 20261230030000, the tester allowlist.
 *
 *   node scripts/events-testers-release.mjs --ids ids.json > testers-check.sql
 *   supabase db query --linked -f testers-check.sql -o json > result.json
 *   node scripts/events-release-check.mjs result.json --expect supabase/production/events-release/testers-expectations.json
 *
 * Default mode APPLIES the migration inside the transaction (its own begin;/commit; stripped, so it can never persist) and checks it; `--post-apply`
 * leaves the migration out and checks the already-applied one. Either way ONE transaction, short lock/statement timeouts, ends in ROLLBACK, and the same
 * safety gate as events-release-dryrun.mjs refuses to emit anything that could commit. The checks act as real accounts under real roles and change the
 * submissions switch only INSIDE the transaction. Reads files and prints SQL; never touches the database.
 * ids.json: { "MEMBER_ID": <an ordinary adult account>, "OTHER_ID": <a different ordinary account>, "ADMIN_ID": <a staff account> }
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { stripTransaction, verify } from './events-release-dryrun.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const MIGRATION = '20261230030000_event_submissions_testers.sql';
export const TOKEN_KEYS = ['MEMBER_ID', 'OTHER_ID', 'ADMIN_ID'];

const blk = (key, role, uid, body, kind = 'val') => {
  const as = role === 'super' ? '' : `perform set_config('request.jwt.claims','{"sub":"${uid ?? ''}","role":"${role}"}',true); perform set_config('request.jwt.claim.sub','${uid ?? ''}',true); set local role ${role};`;
  const run = kind === 'val' ? `execute $q$${body}$q$ into r;` : `execute $q$${body}$q$; r := 'OK';`;
  return `do $do$ declare r text; begin ${as}\n  begin ${run}\n  exception when others then r := 'ERR '||sqlstate||': '||left(sqlerrm,110); end;\n  ${role === 'super' ? '' : 'reset role;'}\n  insert into dr(k,v) values ('${key}', coalesce(r,'(null)'));\nend $do$;`;
};
const iso = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10) + ' 19:00:00+00';
const payload = (req) => `$j$${JSON.stringify({ request_id: req, organiser_name: 'Tester Check Players', title: 'Tester Check Show', description: 'A short evening of songs in the village hall.', category: 'theatre_performing_arts', venue: 'Town Hall', locality: 'Lerwick', price_text: 'Free', contact_info: 'check@example.org', ticket_url: null, cover_url: null, adult_confirmed: true, occurrences: [{ starts_at: iso(60) }] })}$j$::jsonb`;
const SW = (v, list) => `delete from public.admin_config where key in ('events.member_submissions','events.member_submissions.testers'); ` + (v ? `insert into public.admin_config (key,value,category) values ('events.member_submissions','${v}','events'); ` : '') + (list ? `insert into public.admin_config (key,value,category) values ('events.member_submissions.testers','${list}','events');` : '');

export function build({ ids, postApply = false, migrationsDir = join(ROOT, 'supabase/migrations'), read = (p) => readFileSync(p, 'utf8') }) {
  const missing = TOKEN_KEYS.filter((k) => !ids?.[k] || !/^[0-9a-f-]{36}$/i.test(ids[k]));
  if (missing.length) throw new Error(`ids.json needs a UUID for: ${missing.join(', ')}`);
  const { MEMBER_ID: M, OTHER_ID: O, ADMIN_ID: A } = ids;
  const L = [
    'begin;', "set local lock_timeout = '1500ms';", "set local statement_timeout = '15s';", "set local idle_in_transaction_session_timeout = '30s';",
    'create temp table dr(n serial primary key, k text, v text);', 'grant all on dr to public;',
    "insert into dr(k,v) values ('t.start', clock_timestamp()::text);",
    "insert into dr(k,v) select 'pre.switch_rows', count(*)::text from public.admin_config where key like 'events.member_submissions%';",
    "insert into dr(k,v) select 'pre.notification_rows', count(*)::text from public.notification_log;",
    "insert into dr(k,v) select 'pre.events', count(*)::text from public.events;",
    "insert into dr(k,v) select 'pre.community_events', count(*)::text from public.events where source = 'community_submission';",
  ];
  if (!postApply) L.push("insert into dr(k,v) values ('t.migration.start', clock_timestamp()::text);", stripTransaction(read(join(migrationsDir, MIGRATION)), MIGRATION), "insert into dr(k,v) values ('t.migration.end', clock_timestamp()::text);");
  L.push(
    blk('c01.tester_fn_acl', 'super', null, "select has_function_privilege('anon','public.event_submissions_tester()','execute')::text||'|'||has_function_privilege('authenticated','public.event_submissions_tester()','execute')::text||'|'||has_function_privilege('service_role','public.event_submissions_tester()','execute')::text"),
    blk('c02.open_fn_acl_unchanged', 'super', null, "select has_function_privilege('anon','public.event_submissions_open()','execute')::text||'|'||has_function_privilege('authenticated','public.event_submissions_open()','execute')::text||'|'||has_function_privilege('service_role','public.event_submissions_open()','execute')::text"),
    blk('c03.anon_cannot_call_tester', 'anon', null, 'select public.event_submissions_tester()::text'),
    blk('c04.closed_member', 'authenticated', M, 'select public.event_submissions_tester()::text||\'|\'||public.event_submissions_open()::text'),
    blk('c05.set_testers', 'super', null, SW('testers', M), 'stmt'),
    blk('c06.listed_tester', 'authenticated', M, 'select public.event_submissions_tester()::text||\'|\'||public.event_submissions_open()::text'),
    blk('c07.unlisted_member', 'authenticated', O, 'select public.event_submissions_tester()::text||\'|\'||public.event_submissions_open()::text'),
    blk('c08.staff_not_listed', 'authenticated', A, 'select public.event_submissions_tester()::text||\'|\'||public.event_submissions_open()::text'),
    blk('c09.listed_tester_can_submit', 'authenticated', M, `select public.submit_event_submission(${payload('00000000-0000-4000-8000-0000000000c1')})::text`),
    blk('c10.unlisted_member_refused', 'authenticated', O, `select public.submit_event_submission(${payload('00000000-0000-4000-8000-0000000000c2')})::text`),
    blk('c11.staff_may_still_submit', 'authenticated', A, `select public.submit_event_submission(${payload('00000000-0000-4000-8000-0000000000c3')})::text`),
    blk('c12.set_open', 'super', null, SW('open', M), 'stmt'),
    blk('c13.open_unchanged', 'authenticated', O, 'select public.event_submissions_tester()::text||\'|\'||public.event_submissions_open()::text'),
    blk('c14.set_closed', 'super', null, SW(null, M), 'stmt'),
    blk('c15.closed_again_refused', 'authenticated', M, `select public.submit_event_submission(${payload('00000000-0000-4000-8000-0000000000c4')})::text`),
    blk('c16.nothing_published', 'super', null, "select ((select count(*) from public.events where source = 'community_submission') - (select v::bigint from dr where k='pre.community_events'))::text||'|'||((select count(*) from public.notification_log) - (select v::bigint from dr where k='pre.notification_rows'))::text||'|'||((select count(*) from public.events) - (select v::bigint from dr where k='pre.events'))::text"),
    "insert into dr(k,v) values ('t.end', clock_timestamp()::text);", 'select k, v from dr order by n;', 'rollback;',
  );
  const sql = L.join('\n') + '\n';
  verify(sql);
  return sql;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2); const at = a.indexOf('--ids');
  if (at < 0) { console.error('usage: node scripts/events-testers-release.mjs --ids ids.json [--post-apply] > check.sql'); process.exit(2); }
  try { process.stdout.write(build({ ids: JSON.parse(readFileSync(a[at + 1], 'utf8')), postApply: a.includes('--post-apply') })); console.error(`assembled: 1 begin, 1 final rollback, no commit; ${a.includes('--post-apply') ? 'post-apply checks only' : 'migration applied INSIDE the transaction, then checked'}`); }
  catch (e) { console.error(`REFUSED: ${e.message}`); process.exit(1); }
}
