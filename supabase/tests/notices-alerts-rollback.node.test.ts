/**
 * notices-alerts-rollback.node.test.ts — the rollback scripts really restore the pre-feature database, and the migrations can be re-applied afterwards.
 * ISOLATED DATABASE ONLY. Order: apply 1-5, roll back 5→1, check, apply 1-5 again, check.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildDatabase, rd, file, scalar, NEW_MIGRATIONS, N_LEGACY, as } from './_support/notices-alerts-harness.ts';

const NEW_TABLES = ['official_publishers', 'official_publisher_members', 'essential_alert_grants', 'notice_audit_log', 'member_areas', 'notice_notification_prefs', 'notice_dispatches', 'notice_deliveries',
  'funeral_directors', 'funeral_director_members', 'funeral_notices', 'funeral_change_requests', 'notice_import_sources', 'notice_import_items', 'notice_import_runs'];
const NEW_COLS = ['official_publisher_id', 'is_essential', 'action_text', 'review_at', 'link_url', 'essential_set_by', 'essential_set_at'];
const exists = (t: string) => scalar(`select count(*) from information_schema.tables where table_schema='public' and table_name='${t}'`) === '1';
const colCount = () => Number(scalar(`select count(*) from information_schema.columns where table_schema='public' and table_name='notices' and column_name in (${NEW_COLS.map((c) => `'${c}'`).join(',')})`));
const fnCount = () => Number(scalar(`select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname ~ '^(official_|admin_(upsert_official|verify_official|set_official|grant_essential|revoke_essential|list_official|notice_audit|funeral|import|retire|set_funeral|set_import|upsert_import|notice_dispatch)|get_(essential|public_notices|funeral)|set_my_notice|my_notice|my_official|my_funeral|submit_funeral|import_|funeral_|notice_(dispatch|claim|record|complete|fail|audit|essential|is_public|matches|publisher_display$)|can_dispatch|area_neighbourhood|is_safe_https|notices_admin|withdraw_my_funeral|update_my_funeral|request_funeral)'`));

before(() => { buildDatabase(); });

test('1 after applying all five migrations the feature objects exist', () => {
  for (const t of NEW_TABLES) assert.ok(exists(t), t);
  assert.equal(colCount(), NEW_COLS.length);
  assert.ok(fnCount() > 40, String(fnCount()));
});
test('2 rolling back in reverse order succeeds and removes every table, column and function the feature added; the legacy notice and its public read are untouched', () => {
  const before = scalar(`select md5(row(id, title, body, severity, is_pinned, publisher_hub_id)::text) from notices where id='${N_LEGACY}'`);
  for (const m of [...NEW_MIGRATIONS].reverse()) {
    const o = file(rd(`supabase/rollbacks/${m.replace(/\.sql$/, '')}_rollback.sql`));
    assert.doesNotMatch(o, /ERROR/, `${m}: ${o.slice(0, 500)}`);
  }
  for (const t of NEW_TABLES) assert.ok(!exists(t), `${t} should be gone`);
  assert.equal(colCount(), 0);
  assert.equal(scalar(`select md5(row(id, title, body, severity, is_pinned, publisher_hub_id)::text) from notices where id='${N_LEGACY}'`), before);
  assert.equal(as('anon', `select count(*) from notices where id='${N_LEGACY}'`).split('\n').pop()!.trim(), '1');
  assert.equal(scalar(`select public.notice_publisher_display('${N_LEGACY}')->>'byline'`), 'Posted by Voe Hall', 'the Stage 2 publisher label is restored');
  assert.equal(Number(scalar(`select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('get_public_notices','get_essential_alerts','official_publish_notice','notices_admin','notice_dispatchable','submit_funeral_notice')`)), 0);
});
test('3 the migrations re-apply cleanly after a rollback (forward recovery works)', () => {
  for (const m of NEW_MIGRATIONS) { const o = file(rd(`supabase/migrations/${m}`)); assert.doesNotMatch(o, /ERROR/, `${m}: ${o.slice(0, 500)}`); }
  for (const t of NEW_TABLES) assert.ok(exists(t), t);
  assert.equal(colCount(), NEW_COLS.length);
});
