/**
 * social-recipes-migration.node.test.ts — migration 20261202000000 on an ISOLATED Postgres, layered on the real earlier social migrations.
 *
 * PROVES: the six new kinds are accepted and unknown kinds still refused; an essential_alert can never be 'scheduled' (autopilot's status) but
 * can be draft/approved; the essential_alert recipe can never have autopilot switched on, by insert or update; other recipes still can;
 * the seven recipes arrive DISABLED with autopilot OFF; existing recipes (config, enabled, autopilot) and a synthetic 125-draft backlog plus
 * posted history are byte-identical afterwards; the migration is re-runnable; promotion permissions are admin-only; the rollback restores the original state.
 * ISOLATED DATABASE ONLY. Synthetic rows only.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DSN = process.env.PASS_PROOF_DSN ?? '', PSQL = process.env.PASS_PROOF_PSQL ?? 'psql';
if (!DSN) throw new Error('PASS_PROOF_DSN is required (isolated database only): run via `npm run test:isolated`');
if (/supabase/i.test(DSN)) throw new Error('refusing to run against a Supabase DSN');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const mig = (n: string) => readFileSync(join(ROOT, 'supabase', 'migrations', n), 'utf8');
const rb = readFileSync(join(ROOT, 'supabase', 'rollbacks', '20261202000000_social_recipes_expansion_rollback.sql'), 'utf8');
const sql = (q: string) => { try { return execFileSync(PSQL, [DSN, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-c', q], { encoding: 'utf8' }).trim(); } catch (e) { return `ERROR ${(e as any).stderr ?? e}`; } };
const file = (q: string) => execFileSync(PSQL, [DSN, '-X', '-q', '-v', 'ON_ERROR_STOP=1'], { input: q, encoding: 'utf8' });
const as = (uid: string | null, q: string) => sql(`begin; select set_config('request.jwt.claim.sub','${uid ?? ''}',true); set local role authenticated; ${q}; commit;`);
const ADMIN = 'a0000000-0000-4000-8000-000000000001', USER = 'a0000000-0000-4000-8000-000000000002';
const NEW = ['notice_update', 'essential_alert', 'aald_memory', 'hub_community', 'game_challenge', 'cruise_visit'];
const fingerprint = () => sql(`select md5(coalesce((select string_agg(p::text, '|' order by id) from social_posts p),'')) || '/' || md5(coalesce((select string_agg(key||enabled||autopilot||config::text||label, '|' order by key) from social_recipes where key in ('wird_of_day','whats_on_roundup','event_spotlight','jobs_roundup','new_product')),''))`);

before(() => {
  file(`
    drop schema if exists public cascade; create schema public; drop schema if exists auth cascade; create schema auth;
    do $$ begin if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if; if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if; end $$;
    grant usage on schema public, auth to authenticated, anon;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create table public.profiles (id uuid primary key, role text default 'customer');
    create table public.local_businesses (id uuid primary key default gen_random_uuid());
    create function public.set_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
    create table public.admin_config (key text primary key, value text, category text, description text, is_secret boolean default false, updated_at timestamptz default now(), updated_by uuid);
    grant select, insert, update, delete on all tables in schema public to authenticated;`);
  // the REAL earlier social migrations, in order
  for (const n of ['20260731100000_social_seeding.sql', '20260801090000_social_plain_english_copy.sql', '20260801110000_social_jobs_recipe.sql', '20260801150000_social_new_product_recipe.sql']) file(mig(n));
  file(`grant select, insert, update, delete on all tables in schema public to authenticated;`);   // as Supabase's default privileges do for tables that already exist
  file(`
    insert into profiles values ('${ADMIN}','admin'), ('${USER}','customer');
    -- a synthetic 125-draft backlog (all in the past) + some posted history
    insert into social_posts (kind, entity_type, entity_id, caption, status, scheduled_for, created_at)
      select case when g % 5 = 0 then 'jobs_roundup' else 'wird_of_day' end, 'x', 'e'||g, 'old '||g, 'draft', now() - (g||' days')::interval, now() - (g||' days')::interval from generate_series(1,125) g;
    insert into social_posts (kind, entity_id, caption, status, scheduled_for, posted_at, posted_ids) values ('wird_of_day','h1','posted','posted', now() - interval '90 days', now() - interval '90 days', '{"facebook":"123"}');
    update social_recipes set enabled = true, autopilot = false where key = 'wird_of_day';`);
});

const BEFORE = { fp: '' };
describe('forward migration', () => {
  test('applies cleanly and leaves the existing posts and recipes byte-identical', () => {
    BEFORE.fp = fingerprint();
    assert.equal(sql(`select count(*) from social_posts where status='draft'`), '125');
    file(mig('20261202000000_social_recipes_expansion.sql'));
    assert.equal(fingerprint(), BEFORE.fp);
    assert.equal(sql(`select count(*) from social_posts where status='draft'`), '125');
  });
  test('is re-runnable (idempotent)', () => { file(mig('20261202000000_social_recipes_expansion.sql')); assert.equal(fingerprint(), BEFORE.fp); assert.equal(sql(`select count(*) from social_recipes`), '12'); });
  test('seven new recipes, all disabled with autopilot off; the original five untouched', () => {
    assert.equal(sql(`select count(*) from social_recipes where key in ('notice_update','essential_alert','aald_memory','business_spotlight','hub_community','game_challenge','cruise_visit') and enabled = false and autopilot = false`), '7');
    assert.equal(sql(`select count(*) from social_recipes where key in ('whats_on_roundup','event_spotlight','jobs_roundup','new_product') and enabled = true`), '4');
    assert.equal(sql(`select config::text from social_recipes where key='wird_of_day'`), '{"hour": 8}');
  });
  test('every new kind is accepted; an unknown kind is still refused', () => {
    for (const k of [...NEW, 'business_spotlight']) assert.doesNotMatch(sql(`insert into social_posts (kind, entity_id, caption) values ('${k}','t-${k}','c')`), /ERROR/, k);
    assert.match(sql(`insert into social_posts (kind, entity_id, caption) values ('made_up','t','c')`), /check constraint/);
    sql(`delete from social_posts where entity_id like 't-%'`);
  });
});

describe('essential alerts always need a human', () => {
  test('an essential_alert row can be draft or approved but never scheduled (autopilot’s status)', () => {
    assert.doesNotMatch(sql(`insert into social_posts (kind, entity_id, caption, status) values ('essential_alert','a1','c','draft'), ('essential_alert','a2','c','approved')`), /ERROR/);
    assert.match(sql(`insert into social_posts (kind, entity_id, caption, status) values ('essential_alert','a3','c','scheduled')`), /essential_needs_human/);
    assert.match(sql(`update social_posts set status='scheduled' where entity_id='a1'`), /essential_needs_human/);
    assert.equal(sql(`select status from social_posts where entity_id='a1'`), 'draft');
    sql(`delete from social_posts where entity_id in ('a1','a2')`);
  });
  test('its recipe cannot be put on autopilot — as an update, as an insert, or by an admin through the client', () => {
    assert.match(sql(`update social_recipes set autopilot = true where key='essential_alert'`), /always need explicit administrator approval/);
    assert.match(as(ADMIN, `update social_recipes set autopilot = true where key='essential_alert'`), /always need explicit administrator approval/);
    assert.match(sql(`delete from social_recipes where key='essential_alert'; insert into social_recipes (key,label,autopilot) values ('essential_alert','x',true)`), /always need explicit administrator approval/);
    assert.equal(sql(`select autopilot from social_recipes where key='essential_alert'`), 'f');
  });
  test('enabling it is still allowed, and the other recipes can still use autopilot', () => {
    assert.doesNotMatch(sql(`update social_recipes set enabled = true where key='essential_alert'`), /ERROR/);
    sql(`update social_recipes set enabled = false where key='essential_alert'`);
    for (const k of ['notice_update', 'aald_memory', 'business_spotlight', 'hub_community', 'game_challenge', 'cruise_visit', 'wird_of_day']) {
      assert.doesNotMatch(sql(`update social_recipes set autopilot = true where key='${k}'`), /ERROR/, k);
      sql(`update social_recipes set autopilot = false where key='${k}'`);
    }
  });
});

describe('promotion permissions', () => {
  test('admin-only: an admin can grant, a signed-in member cannot read or write, anon has nothing', () => {
    assert.doesNotMatch(as(ADMIN, `insert into social_promotion_permissions (entity_type, entity_id, allowed) values ('memory','m1',true)`), /ERROR/);
    assert.equal(as(USER, `select count(*) from social_promotion_permissions`).split('\n').pop(), '0');
    assert.match(as(USER, `insert into social_promotion_permissions (entity_type, entity_id, allowed) values ('memory','m2',true)`), /row-level security/);
    assert.match(sql(`set role anon; select count(*) from social_promotion_permissions`), /permission denied/);
  });
  test('entity types are constrained', () => {
    assert.match(sql(`insert into social_promotion_permissions (entity_type, entity_id, allowed) values ('person','p1',true)`), /check constraint/);
  });
});

describe('spacing configuration', () => {
  test('defaults are seeded: 3 per day, 120 minute gap, 08-20 window', () => {
    assert.equal(sql(`select string_agg(key||'='||value, ',' order by key) from admin_config where category='social'`), 'social.max_posts_per_day=3,social.min_gap_minutes=120,social.window_hours=8-20');
  });
});

describe('rollback', () => {
  test('restores the original kinds, recipes and tables, and leaves the backlog and history intact', () => {
    file(rb);
    assert.equal(fingerprint(), BEFORE.fp);
    assert.equal(sql(`select count(*) from social_recipes`), '5');
    assert.match(sql(`insert into social_posts (kind, entity_id, caption) values ('notice_update','z','c')`), /check constraint/);
    assert.match(sql(`select count(*) from social_promotion_permissions`), /does not exist/);
    assert.equal(sql(`select count(*) from social_posts where status='draft'`), '125');
  });
});
