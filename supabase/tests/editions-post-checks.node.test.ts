/**
 * editions-post-checks.node.test.ts — ISOLATED Postgres only. The production post-check SQL files are what Darren runs after applying each migration, so each one must itself be
 * correct: this replays the REAL migrations into a throwaway database and runs every Editions post-check, failing on any SQL error or any row that is not ok = true.
 * Run: ISOLATED_ONLY=editions-post-checks npm run test:isolated
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReplayDb, type ReplayDb } from './_support/replay-db.ts';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '../production/post-checks');
let db: ReplayDb;
before(() => { db = createReplayDb('editionspostchecks'); });
after(() => { try { db?.drop(); } catch { /* */ } });

describe('every Editions post-check passes on a freshly replayed database', () => {
  const files = readdirSync(DIR).filter((f) => /^editions-.*\.post-check\.sql$/.test(f)).sort();
  test('there is a post-check for each release step', () => {
    for (const must of ['foundation', 'partners', 'commerce', 'branding', 'hardening', 'update-images', 'stage-a', 'stripe-lifecycle', 'pilot']) assert.ok(files.some((f) => f.includes(must)), `missing post-check: ${must}`);
  });
  for (const f of files) {
    test(f, () => {
      const out = db.rawFile(join(DIR, f));
      assert.doesNotMatch(out, /ERROR|syntax error/i, `${f} raised an SQL error:\n${out.slice(0, 600)}`);
      const rows = out.split('\n').map((l) => l.trim()).filter((l) => /\|[tf]$/.test(l));
      assert.ok(rows.length > 0, `${f} printed no check rows`);
      const bad = rows.filter((l) => l.endsWith('|f'));
      assert.deepEqual(bad, [], `${f} has failing checks`);
    });
  }
});

describe('the permission assertion actually detects an exposure (mutation controls)', () => {
  const foundation = join(DIR, 'editions-foundation.post-check.sql');
  const badRows = () => db.rawFile(foundation).split('\n').map((l) => l.trim()).filter((l) => l.endsWith('|f'));
  const target = `public.edition_org_contact_email(uuid)`;
  test('granting a private Editions function to anon fails the check; revoking it restores the pass', () => {
    assert.deepEqual(badRows(), []);
    db.raw(`grant execute on function ${target} to anon`);
    try { assert.ok(badRows().some((l) => /ONLY Editions functions anon can execute/.test(l)), 'the exposure must be reported'); }
    finally { db.raw(`revoke execute on function ${target} from anon`); }
    assert.deepEqual(badRows(), []);
  });
  test('a PUBLIC grant (inherited by anon) also fails the check', () => {
    db.raw(`grant execute on function ${target} to public`);
    try { assert.ok(badRows().length >= 1); } finally { db.raw(`revoke execute on function ${target} from public`); }
    assert.deepEqual(badRows(), []);
  });
});

describe('the dark-state assertions detect a real regression, and do not fire on legitimate staff test records', () => {
  const foundation = join(DIR, 'editions-foundation.post-check.sql');
  const rows = () => db.rawFile(foundation).split('\n').map((l) => l.trim());
  const bad = () => rows().filter((l) => l.endsWith('|f'));
  const U = 'aa000000-0000-4000-8000-0000000000a1', A = 'aa000000-0000-4000-8000-0000000000a2';
  before(() => { db.raw(`insert into auth.users (id, email) values ('${U}','pc-user@x.invalid'),('${A}','pc-admin@x.invalid') on conflict do nothing;
    insert into profiles (id, role, full_name) values ('${U}','customer','PC User'),('${A}','admin','PC Admin') on conflict (id) do update set role = excluded.role;`); });
  test('staff-created test records (an administrator organiser, a private draft Edition) pass while Editions is dark', () => {
    db.raw(`insert into edition_organisers (slug, name, created_by, status, is_test) values ('zz-pc-staff','ZZ PC Staff','${A}','pending',true);
      insert into edition_organiser_members (organiser_id, user_id, role) select id, '${A}', 'owner' from edition_organisers where slug='zz-pc-staff';
      insert into editions (organiser_id, slug, title, kind, starts_on, ends_on, status) select id, 'zz-pc-draft','ZZ PC Draft','single_day', current_date+30, current_date+30, 'draft' from edition_organisers where slug='zz-pc-staff';`);
    assert.deepEqual(bad(), [], 'a private staff test organiser and draft must not be reported as a regression');
  });
  test('an organiser member who is not an administrator is reported', () => {
    db.raw(`insert into edition_organiser_members (organiser_id, user_id, role) select id, '${U}', 'editor' from edition_organisers where slug='zz-pc-staff'`);
    try { assert.ok(bad().some((l) => /no external organiser access/.test(l))); } finally { db.raw(`delete from edition_organiser_members where user_id='${U}'`); }
    assert.deepEqual(bad(), []);
  });
  test('a published real Edition while Editions is dark is reported', () => {
    db.raw(`alter table editions disable trigger user; update editions set status='published' where slug='zz-pc-draft'; alter table editions enable trigger user`);
    try { assert.ok(bad().some((l) => /no real \(non-test\) Edition is published/.test(l))); } finally { db.raw(`alter table editions disable trigger user; update editions set status='draft' where slug='zz-pc-draft'; alter table editions enable trigger user`); }
    assert.deepEqual(bad(), []);
  });
  test('an organiser created by a non-administrator is reported', () => {
    db.raw(`alter table edition_organisers disable trigger user; insert into edition_organisers (slug, name, created_by, status) values ('zz-pc-ext','ZZ PC Ext','${U}','pending'); alter table edition_organisers enable trigger user`);
    try { assert.ok(bad().some((l) => /no external organiser access/.test(l))); } finally { db.raw(`delete from edition_organisers where slug='zz-pc-ext'`); }
    assert.deepEqual(bad(), []);
  });
});

describe('the pilot rows detect an unapproved public Edition, an exposed function and a stray predicate (mutation controls)', () => {
  const pilot = join(DIR, 'editions-pilot.post-check.sql'), foundation = join(DIR, 'editions-foundation.post-check.sql');
  const bad = (f: string) => db.rawFile(f).split('\n').map((l) => l.trim()).filter((l) => l.endsWith('|f'));
  const A = 'bb000000-0000-4000-8000-0000000000b1';
  let ORG = '', ED = '';
  before(() => {
    db.raw(`insert into auth.users (id, email) values ('${A}','pc-pilot-admin@x.invalid') on conflict do nothing; insert into profiles (id, role, full_name) values ('${A}','admin','PC Pilot Admin') on conflict (id) do update set role = excluded.role;`);
    ORG = db.raw(`insert into edition_organisers (slug, name, created_by, status) values ('zz-pc-pilot','ZZ PC Pilot','${A}','verified') returning id`).split('\n').map((l) => l.trim()).find((l) => /^[0-9a-f-]{36}$/.test(l)) ?? '';
    ED = db.raw(`insert into editions (organiser_id, slug, title, kind, starts_on, ends_on, summary) values ('${ORG}','zz-pc-pilot-ed','ZZ PC Pilot Ed','single_day', current_date+30, current_date+30,'x') returning id`).split('\n').map((l) => l.trim()).find((l) => /^[0-9a-f-]{36}$/.test(l)) ?? '';
  });
  test('clean database: both files pass', () => { assert.deepEqual(bad(pilot), []); assert.deepEqual(bad(foundation), []); });
  test('a published real Edition WITHOUT a live approval, while dark, is reported; WITH one it passes', () => {
    db.raw(`alter table editions disable trigger user; update editions set status='published' where id='${ED}'; alter table editions enable trigger user`);
    try {
      assert.ok(bad(foundation).some((l) => /no real \(non-test\) Edition is published/.test(l)));
      db.raw(`insert into edition_pilot_approvals (organiser_id, approved_by, note) values ('${ORG}','${A}','pilot approved for the post-check test')`);
      assert.deepEqual(bad(foundation), [], 'an approved pilot organiser\'s published Edition is legitimate');
    } finally { db.raw(`alter table edition_pilot_approvals disable trigger user; delete from edition_pilot_approvals; alter table edition_pilot_approvals enable trigger user; alter table editions disable trigger user; update editions set status='draft' where id='${ED}'; alter table editions enable trigger user`); }
    assert.deepEqual(bad(foundation), []);
  });
  test('granting the pilot switch reader to anon is reported', () => {
    db.raw(`grant execute on function public.editions_pilot() to anon`);
    try { assert.ok(bad(pilot).length >= 1); } finally { db.raw(`revoke execute on function public.editions_pilot() from anon`); }
    assert.deepEqual(bad(pilot), []);
  });
  test('a second function mentioning the pilot predicate is reported', () => {
    db.raw(`create function public.edition_tier_public_x() returns boolean language sql as $$ select public.edition_pilot_visible(null::uuid) $$`);
    try { assert.ok(bad(pilot).some((l) => /referenced by exactly one function/.test(l))); } finally { db.raw(`drop function public.edition_tier_public_x()`); }
    assert.deepEqual(bad(pilot), []);
  });
});
