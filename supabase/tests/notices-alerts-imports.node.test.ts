/**
 * notices-alerts-imports.node.test.ts — Notices & Alerts step 5: the controlled official-import framework, proven in an ISOLATED Postgres.
 *
 * PROVES: every source starts disabled and only a platform administrator can enable one (with a recorded reuse confirmation); a disabled / unapproved / retired
 * source cannot import; runs are rate limited; an item is identified by (source, reference) so a re-fetch updates in place and can never duplicate; summaries and
 * titles are length-capped (originals, not copies); the item link must be https on an allow-listed host; imports are always severity 'info', must expire, can
 * never be essential or carry an organisation, and are SILENT (not dispatchable; no delivery row); items the source drops are withdrawn (kept) only on a clean run
 * and never when that looks like a broken feed; a notice staff hid or withdrew is never resurrected; a reappearing item republishes; retiring a source for a
 * direct publisher withdraws its live imports; imports appear as Level 2 with source attribution. SAFETY — ISOLATED DATABASE ONLY; no network, nothing fetched.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildDatabase, U, as, asScalar, raw, file, scalar, failed, idOf, areaIds } from './_support/notices-alerts-harness.ts';

const SRC = 'sic_council';
const HOSTS = `array['www.shetland.gov.uk']`;
const svc = (sql: string) => as('service', sql);
const startRun = () => { const o = svc(`select public.import_start_run('${SRC}')`); return failed(o) ? o : idOf(o); };
const upsert = (ref: string, o: Partial<{ title: string; summary: string; url: string; exp: string; cat: string; areas: string }> = {}) => {
  const a = { title: 'Roadworks on the A970 near Brae', summary: 'Temporary traffic lights will operate near Brae for resurfacing this week.', url: 'https://www.shetland.gov.uk/news/roadworks-brae', exp: 'null', cat: 'null', areas: 'null', ...o };
  return svc(`select public.import_upsert_notice('${SRC}','${ref}','${a.title}','${a.summary}','${a.url}', now() - interval '1 hour', ${a.cat === 'null' ? 'null' : `'${a.cat}'`}, ${a.areas}, ${a.exp})`);
};
const result = (o: string) => (o.match(/created|updated|unchanged|skipped_\w+/) ?? [o.slice(0, 200)])[0];
const noticeFor = (ref: string) => scalar(`select id from notices where source='${SRC}' and source_reference='${ref}'`);
const resetRate = () => raw(`update notice_import_sources set last_run_at = null where id='${SRC}'`);
const finish = (run: string, status = 'ok', fetched = 0) => svc(`select public.import_finish_run('${run}','${status}',${fetched},0,0,0,0, null)`);

before(() => { buildDatabase(); });

describe('sources are disabled until an administrator approves them', () => {
  test('1 only a platform administrator can configure or enable a source; a source starts DISABLED and cannot import', () => {
    for (const who of ['A', 'O', 'H', 'P'] as const) {
      assert.match(as(who, `select public.admin_upsert_import_source('${SRC}','Shetland Islands Council (Official Notices)','rss','https://www.shetland.gov.uk/rss',${HOSTS})`), /Platform administrators only/, who);
      assert.match(as(who, `select public.admin_import_status()`), /Platform administrators only/, who);
    }
    const o = as('S', `select public.admin_upsert_import_source('${SRC}','Shetland Islands Council (Official Notices)','rss','https://www.shetland.gov.uk/rss',${HOSTS})`);
    assert.ok(!failed(o), o);
    assert.equal(scalar(`select is_enabled::text from notice_import_sources where id='${SRC}'`), 'false');
    assert.match(startRun(), /not enabled/);
    assert.match(upsert('x1'), /not enabled/);
  });
  test('2 enabling needs an administrator AND a recorded reuse confirmation; the database refuses an enabled source without approval metadata', () => {
    assert.match(as('A', `select public.admin_set_import_source_enabled('${SRC}', true, 'x')`), /Platform administrators only/);
    assert.match(as('S', `select public.admin_set_import_source_enabled('${SRC}', true)`), /reuse conditions were confirmed/);
    assert.match(as('S', `select public.admin_set_import_source_enabled('${SRC}', true, '   ')`), /reuse conditions were confirmed/);
    assert.match(raw(`update notice_import_sources set is_enabled = true where id='${SRC}'`), /import_enabled_needs_approval/);
    assert.ok(!failed(as('S', `select public.admin_set_import_source_enabled('${SRC}', true, 'Council terms permit summarising with a link; confirmed by email, 31 Oct')`)));
    assert.equal(scalar(`select (approved_by is not null and approved_at is not null and reuse_confirmed_at is not null)::text from notice_import_sources where id='${SRC}'`), 'true');
    assert.match(as('S', `select public.admin_upsert_import_source('${SRC}','New label','rss','https://www.shetland.gov.uk/rss',${HOSTS})`), /Disable a source before changing it/, 'an enabled source is frozen');
  });
  test('3 runs are rate limited: a second run inside the minimum interval is refused; configuration enforces a 15 minute floor and https feeds only', () => {
    const r = startRun(); assert.match(r, /^[0-9a-f-]{36}$/, r);
    assert.match(startRun(), /too recently/);
    assert.match(raw(`insert into notice_import_sources (id,label,feed_kind,feed_url,allowed_hosts,rate_limit_minutes) values ('fast','x','rss','https://a.example/f',array['a.example'],5)`), /violates check/);
    assert.match(raw(`insert into notice_import_sources (id,label,feed_kind,feed_url,allowed_hosts) values ('plain','x','rss','http://a.example/f',array['a.example'])`), /violates check/);
    finish(r, 'ok'); resetRate();
  });
});

describe('importing: identity, safety, silence', () => {
  test('4 an item is created as an attributed platform notice (severity info, published, expiring, areas set, never essential, no organisation)', () => {
    resetRate(); const run = startRun();
    assert.equal(result(upsert('item-1')), 'created');
    const id = noticeFor('item-1');
    assert.equal(scalar(`select is_platform_notice::text || severity || status || is_essential::text || (official_publisher_id is null)::text || (expires_at is not null)::text from notices where id='${id}'`), 'trueinfopublishedfalsetruetrue');
    assert.equal(scalar(`select source_label from notices where id='${id}'`), 'Shetland Islands Council (Official Notices)');
    assert.equal(scalar(`select string_agg(area_id, ',') from notice_areas where notice_id='${id}'`), 'shetland_wide');
    assert.equal(scalar(`select public.notice_publisher_display('${id}')->>'byline'`), 'Source: Shetland Islands Council (Official Notices)');
    assert.equal(scalar(`select level from public.get_public_notices('official', null, null, 50) where id='${id}'`), '2');
    assert.equal(asScalar('anon', `select count(*) from notices where id='${id}'`), '1');
    finish(run);
  });
  test('5 (source, reference) is the identity: a re-fetch is "unchanged" and a changed item UPDATES IN PLACE — never a duplicate', () => {
    resetRate(); const run = startRun();
    assert.equal(result(upsert('item-1')), 'unchanged');
    assert.equal(result(upsert('item-1', { title: 'Roadworks on the A970 near Brae: new dates', summary: 'The traffic lights now operate until Friday while resurfacing is completed.' })), 'updated');
    assert.equal(scalar(`select count(*) from notices where source='${SRC}' and source_reference='item-1'`), '1');
    assert.equal(scalar(`select title from notices where source='${SRC}' and source_reference='item-1'`), 'Roadworks on the A970 near Brae: new dates');
    assert.match(file(`insert into notices (is_platform_notice, source, source_reference, source_label, source_url, expires_at, title, body) values (true,'${SRC}','item-1','x','https://www.shetland.gov.uk/x', now()+interval '1 day','dup','dup body here')`), /notices_source_uq|duplicate key/);
    finish(run);
  });
  test('6 content rules: https link on an allow-listed host only; title and summary length caps; expiry mandatory and capped; unknown category falls back; expired items are skipped', () => {
    resetRate(); const run = startRun();
    assert.match(upsert('bad-1', { url: 'http://www.shetland.gov.uk/x' }), /plain https/);
    assert.match(upsert('bad-2', { url: 'https://evil.example/x' }), /not on an allowed host/);
    assert.match(upsert('bad-3', { url: 'https://www.shetland.gov.uk.evil.example/x' }), /not on an allowed host/);
    assert.match(upsert('bad-4', { url: 'https://user:pw@www.shetland.gov.uk/x' }), /plain https/);
    assert.match(upsert('bad-5', { summary: 'x'.repeat(601) }), /summary must be 10 to 600/);
    assert.match(upsert('bad-6', { title: 'x'.repeat(201) }), /title must be 3 to 200/);
    assert.match(upsert('bad-7', { summary: 'short' }), /summary must be 10 to 600/);
    assert.match(svc(`select public.import_upsert_notice('${SRC}','  ','t t t','a long enough summary','https://www.shetland.gov.uk/x', null)`), /stable source reference/);
    assert.equal(result(upsert('exp-1', { exp: "now() - interval '1 day'" })), 'skipped_expired');
    assert.equal(result(upsert('cap-1', { exp: "now() + interval '400 days'", cat: 'made_up' })), 'created');
    assert.equal(scalar(`select (expires_at <= now() + interval '91 days')::text || category from notices where source='${SRC}' and source_reference='cap-1'`), 'trueother');
    finish(run);
  });
  test('7 IMPORTS ARE SILENT: never dispatchable (any audience), never in a recipient list, no delivery row can exist — whatever else is true of them', () => {
    const id = noticeFor('item-1');
    for (const k of ['essential', 'official', 'community', 'hub']) {
      assert.match(scalar(`select public.notice_dispatchable('${id}','${k}')`), /never announced/, k);
      assert.match(svc(`select public.notice_claim_dispatch('${id}','${k}')`), /never announced/, k);
      assert.equal(raw(`select count(*) from public.notice_dispatch_recipients('${id}','${k}')`), '0', k);
    }
    assert.match(file(`insert into notice_deliveries (subject_type, subject_id, user_id, kind) values ('notice','${id}','${U.A}','official')`), /never announced/);
    assert.match(file(`update notices set is_essential = true, official_publisher_id = null where id='${id}'`), /notices_essential_check|does not hold the Essential Alert entitlement/);
  });
});

describe('what happens when the source drops, repeats or breaks', () => {
  const seed = (n: number) => { resetRate(); const run = startRun(); for (let i = 0; i < n; i++) upsert(`keep-${i}`, { title: `Imported item ${i} here` }); return run; };
  test('8 on a clean run, items the source no longer lists are WITHDRAWN (kept, not deleted); a reappearing item is republished', () => {
    finish(seed(4));
    resetRate(); const run = startRun();
    for (const i of [0, 1, 2]) upsert(`keep-${i}`, { title: `Imported item ${i} here` });
    assert.equal(finish(run, 'ok', 3).split('\n').pop()!.trim(), '1', 'one item dropped');
    const gone = noticeFor('keep-3');
    assert.equal(scalar(`select status from notices where id='${gone}'`), 'withdrawn');
    assert.equal(asScalar('anon', `select count(*) from notices where id='${gone}'`), '0');
    resetRate(); const r2 = startRun();
    assert.equal(result(upsert('keep-3', { title: 'Imported item 3 here' })), 'updated');
    assert.equal(scalar(`select status from notices where id='${gone}'`), 'published', 'the item came back');
    finish(r2);
  });
  test('9 a failed or partial run withdraws NOTHING; a run that would withdraw more than half the live items is refused as a probable broken feed', () => {
    resetRate(); const failedRun = startRun();
    assert.equal(finish(failedRun, 'failed').split('\n').pop()!.trim(), '0');
    assert.ok(Number(scalar(`select count(*) from notices where source='${SRC}' and status='withdrawn' and source_reference like 'keep-%'`)) === 0);
    resetRate(); const run = startRun();
    upsert('keep-0', { title: 'Imported item 0 here' });                     // the feed "lost" everything else
    const out = finish(run, 'ok', 1);
    assert.equal(out.split('\n').pop()!.trim(), '0', 'nothing withdrawn');
    assert.equal(scalar(`select status from notice_import_runs where id='${run}'`), 'partial');
    assert.match(scalar(`select error_summary from notice_import_runs where id='${run}'`), /broken feed/);
    assert.equal(scalar(`select count(*) from notices where source='${SRC}' and status='published' and source_reference like 'keep-%'`), '4');
    assert.equal(scalar(`select consecutive_failures from notice_import_sources where id='${SRC}'`), '0', 'a partial run is not a failure');
  });
  test('10 consecutive failures are counted for monitoring (and reset by a good run); the administrator status view shows them', () => {
    resetRate(); finish(startRun(), 'failed'); resetRate(); finish(startRun(), 'failed');
    assert.equal(scalar(`select consecutive_failures from notice_import_sources where id='${SRC}'`), '2');
    assert.match(asScalar('S', `select (select string_agg(consecutive_failures::text || last_status, '') from public.admin_import_status() where id='${SRC}')`), /^2failed$/);
    resetRate(); finish(startRun(), 'ok');
    assert.equal(scalar(`select consecutive_failures from notice_import_sources where id='${SRC}'`), '0');
    assert.ok(Number(scalar(`select count(*) from notice_audit_log where event='import_run'`)) >= 5);
  });
  test('11 a notice staff hid or withdrew is NEVER resurrected by the feed', () => {
    resetRate(); const run = startRun();
    const id = noticeFor('keep-1');
    raw(`update notices set is_hidden = true where id='${id}'`);
    assert.equal(result(upsert('keep-1', { title: 'Changed title for the hidden item' })), 'skipped_staff');
    raw(`update notices set is_hidden = false, status = 'withdrawn' where id='${id}'`);       // withdrawn by staff (not by the importer)
    assert.equal(result(upsert('keep-1', { title: 'Changed title for the withdrawn item' })), 'skipped_staff');
    assert.equal(scalar(`select status from notices where id='${id}'`), 'withdrawn');
    finish(run);
  });
  test('12 retiring a source for a direct publisher disables it for good and withdraws its live imports (no duplicates alongside direct notices); administrators only', () => {
    const org = idOf(as('S', `select public.admin_upsert_official_publisher('shetland-islands-council','Shetland Islands Council','council')`));
    assert.match(as('A', `select public.admin_retire_import_source('${SRC}','${org}')`), /Platform administrators only/);
    const n = Number(asScalar('S', `select public.admin_retire_import_source('${SRC}','${org}', true)`));
    assert.ok(n >= 1, String(n));
    assert.equal(scalar(`select count(*) from notices where source='${SRC}' and status='published'`), '0');
    assert.equal(scalar(`select (retired_at is not null and not is_enabled)::text from notice_import_sources where id='${SRC}'`), 'true');
    assert.match(as('S', `select public.admin_set_import_source_enabled('${SRC}', true, 'trying to re-enable')`), /Unknown \(or retired\)/);
    assert.match(startRun(), /not enabled/);
  });
  test('13 no client can call the importer functions, read import tables, or write a source directly', () => {
    for (const who of ['A', 'S', 'anon'] as const) {
      assert.match(as(who, `select public.import_start_run('${SRC}')`), /permission denied/, who);
      assert.match(as(who, `select public.import_finish_run(gen_random_uuid(),'ok',0,0,0,0,0)`), /permission denied/, who);
      for (const t of ['notice_import_sources', 'notice_import_items', 'notice_import_runs']) assert.match(as(who, `select count(*) from ${t}`), /permission denied/, `${who} ${t}`);
    }
    assert.match(as('A', `insert into notices (is_platform_notice, source, source_reference, source_label, source_url, expires_at, title, body) values (true,'${SRC}','forged','x','https://x.example', now()+interval '1 day','t','b')`), /Only OneShetland staff|row-level security|set only by|permission/);
  });
});
