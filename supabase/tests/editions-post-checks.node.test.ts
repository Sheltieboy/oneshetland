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
    for (const must of ['foundation', 'partners', 'commerce', 'branding', 'hardening', 'update-images', 'stage-a', 'stripe-lifecycle', 'complete']) assert.ok(files.some((f) => f.includes(must)), `missing post-check: ${must}`);
    assert.ok(!files.some((f) => f.includes('pilot')), 'the pilot post-check is retired with the pilot');
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
  let HUB = '';
  before(() => {
    db.raw(`insert into auth.users (id, email) values ('${U}','pc-user@x.invalid'),('${A}','pc-admin@x.invalid') on conflict do nothing;
      insert into profiles (id, role, full_name) values ('${U}','customer','PC User'),('${A}','admin','PC Admin') on conflict (id) do update set role = excluded.role;`);
    // every organiser now has a parent: a real Hub (the finished service has no standalone organiser)
    HUB = db.raw(`insert into hubs (owner_id, name, slug, type, area, description, is_active) values ('${U}','ZZ PC Hub','zz-pc-hub','club','Lerwick','x',true) returning id`).split('\n').map((l) => l.trim()).find((l) => /^[0-9a-f-]{36}$/.test(l)) ?? '';
  });
  test('staff-created test records (an administrator organiser, a private draft Edition) pass while Editions is dark', () => {
    db.raw(`insert into edition_organisers (slug, name, created_by, status, is_test, hub_id) values ('zz-pc-staff','ZZ PC Staff','${A}','pending',true,'${HUB}');
      insert into edition_organiser_members (organiser_id, user_id, role) select id, '${A}', 'admin' from edition_organisers where slug='zz-pc-staff';
      insert into editions (organiser_id, slug, title, kind, starts_on, ends_on, status) select id, 'zz-pc-draft','ZZ PC Draft','single_day', current_date+30, current_date+30,'draft' from edition_organisers where slug='zz-pc-staff';`);
    assert.deepEqual(bad(), [], 'a private staff test organiser and draft must not be reported as a regression');
  });
  test('an organiser member who is not an administrator is reported', () => {
    db.raw(`insert into edition_organiser_members (organiser_id, user_id, role) select id, '${U}', 'editor' from edition_organisers where slug='zz-pc-staff'`);
    try { assert.ok(bad().some((l) => /no external organiser access/.test(l))); } finally { db.raw(`delete from edition_organiser_members where user_id='${U}'`); }
    assert.deepEqual(bad(), []);
  });
  test('a published real Edition that was never approved is reported (the publish gate is bypassed here on purpose)', () => {
    db.raw(`alter table editions disable trigger user; update editions set status='published' where slug='zz-pc-draft'; alter table editions enable trigger user`);
    try { assert.ok(bad().some((l) => /has been approved by OneShetland/.test(l))); } finally { db.raw(`alter table editions disable trigger user; update editions set status='draft' where slug='zz-pc-draft'; alter table editions enable trigger user`); }
    assert.deepEqual(bad(), []);
  });
  test('an organiser created by a non-administrator is reported', () => {
    db.raw(`insert into hubs (owner_id, name, slug, type, area, description, is_active) values ('${U}','ZZ PC Hub 2','zz-pc-hub-2','club','Lerwick','x',true)`);
    db.raw(`alter table edition_organisers disable trigger user; insert into edition_organisers (slug, name, created_by, status, hub_id) select 'zz-pc-ext','ZZ PC Ext','${U}','pending', id from hubs where slug='zz-pc-hub-2'; alter table edition_organisers enable trigger user`);
    try { assert.ok(bad().some((l) => /no external organiser access/.test(l))); } finally { db.raw(`delete from edition_organisers where slug='zz-pc-ext'`); }
    assert.deepEqual(bad(), []);
  });
});

describe('the finished-service rows detect an unapproved public Edition, an exposed function, a writable review column and a stray pilot object (mutation controls)', () => {
  const complete = join(DIR, 'editions-complete.post-check.sql'), foundation = join(DIR, 'editions-foundation.post-check.sql');
  const bad = (f: string) => db.rawFile(f).split('\n').map((l) => l.trim()).filter((l) => l.endsWith('|f'));
  const mutate = (apply: string, undo: string, file: string, expect: RegExp) => {
    db.raw(apply);
    try { assert.ok(bad(file).some((l) => expect.test(l)), `expected a failing row matching ${expect}; got ${JSON.stringify(bad(file))}`); } finally { db.raw(undo); }
    assert.deepEqual(bad(file), [], 'restored');
  };
  test('clean database: the new file and the foundation file pass', () => { assert.deepEqual(bad(complete), []); assert.deepEqual(bad(foundation), []); });
  test('granting a signed-in-only function (entry, review, package) to anon is reported by the new file and by the foundation allow-list', () => {
    mutate(`grant execute on function public.edition_ensure_organiser(text, uuid) to anon`, `revoke execute on function public.edition_ensure_organiser(text, uuid) from anon`, complete, /signed-in only: callable by authenticated|signed-out role can execute only/);
    mutate(`grant execute on function public.edition_claim_free_package(uuid, uuid, uuid, text) to anon`, `revoke execute on function public.edition_claim_free_package(uuid, uuid, uuid, text) from anon`, complete, /free-claim, order and package functions are signed-in only|signed-out role can execute only/);
    mutate(`grant execute on function public.admin_review_edition(uuid, text, text) to anon`, `revoke execute on function public.admin_review_edition(uuid, text, text) from anon`, complete, /reviewer and owner functions are signed-in only|signed-out role can execute only/);
    mutate(`grant execute on function public.edition_ensure_organiser(text, uuid) to anon`, `revoke execute on function public.edition_ensure_organiser(text, uuid) from anon`, foundation, /nine reviewed public helpers/);
  });
  test('making a review column client-writable is reported', () => {
    mutate(`grant update (review_state) on public.editions to authenticated`, `revoke update (review_state) on public.editions from authenticated`, complete, /review columns on editions are readable but not client-writable/);
    mutate(`grant update (name) on public.edition_organisers to authenticated`, `revoke update (name) on public.edition_organisers from authenticated`, complete, /organiser name is no longer client-writable/);
  });
  test('a write grant on the review history, or removing its append-only trigger, is reported', () => {
    mutate(`grant update on public.edition_reviews to authenticated`, `revoke update on public.edition_reviews from authenticated`, complete, /review history table has RLS on/);
    mutate(`alter table public.edition_reviews disable trigger edition_reviews_no_update; drop trigger edition_reviews_no_update on public.edition_reviews`, `create trigger edition_reviews_no_update before update on public.edition_reviews for each row execute function public.edition_reviews_append_only()`, complete, /review history table has RLS on/);
  });
  test('a published Edition that was never approved is reported (both files)', () => {
    const A = 'bb000000-0000-4000-8000-0000000000b1';
    db.raw(`insert into auth.users (id, email) values ('${A}','pc-owner@x.invalid') on conflict do nothing; insert into profiles (id, role, full_name) values ('${A}','customer','PC Owner') on conflict (id) do nothing;
      insert into hubs (owner_id, name, slug, type, area, description, is_active) values ('${A}','ZZ PC Hub 3','zz-pc-hub-3','club','Lerwick','x',true);
      insert into edition_organisers (slug, name, status, hub_id, created_by) select 'zz-pc-pub','ZZ PC Pub','verified', id, '${A}' from hubs where slug='zz-pc-hub-3';
      insert into editions (organiser_id, slug, title, kind, starts_on, ends_on, summary) select id, 'zz-pc-pub-ed','ZZ PC Pub Ed','single_day', current_date+30, current_date+30,'x' from edition_organisers where slug='zz-pc-pub';`);
    mutate(`alter table editions disable trigger user; update editions set status='published' where slug='zz-pc-pub-ed'; alter table editions enable trigger user`, `alter table editions disable trigger user; update editions set status='draft' where slug='zz-pc-pub-ed'; alter table editions enable trigger user`, complete, /no Edition is published or public without approval/);
  });
  test('a pilot-named function, or an organiser with no parent, is reported', () => {
    mutate(`create function public.edition_pilot_visible_x() returns boolean language sql as $$ select true $$`, `drop function public.edition_pilot_visible_x()`, complete, /no pilot object remains/);
    mutate(`alter table public.edition_organisers drop constraint edition_organisers_one_parent`, `alter table public.edition_organisers add constraint edition_organisers_one_parent check (num_nonnulls(hub_id, business_id) = 1)`, complete, /exactly one parent/);
  });
  test('a pound-zero active package, a flipped Hub switch default and a disabled Hub column lock are reported', () => {
    mutate(`alter table public.edition_packages drop constraint edition_packages_active_is_priced_or_free`, `alter table public.edition_packages add constraint edition_packages_active_is_priced_or_free check (not active or price_pence > 0 or is_free)`, complete, /package constraints hold/);
    mutate(`alter table public.hubs alter column events_auto_approve set default true`, `alter table public.hubs alter column events_auto_approve set default false`, complete, /events_auto_approve exists, is NOT NULL, defaults to false/);
    mutate(`alter table public.hubs disable trigger tg_zz_lock_hub_columns`, `alter table public.hubs enable trigger tg_zz_lock_hub_columns`, complete, /events_auto_approve exists|Hub column lock resets/);
  });
});
