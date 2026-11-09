/**
 * editions-visitor.node.test.ts — ISOLATED Postgres only. R3: save an Edition, build a plan, privacy, drop-out of withdrawn/suspended items.
 * Run: ISOLATED_ONLY=editions-visitor npm run test:isolated
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createReplayDb, type ReplayDb } from './_support/replay-db.ts';

const id = (n: number) => `${n.toString(16).padStart(2, '0')}000000-0000-4000-8000-0000000000${n.toString(16).padStart(2, '0')}`;
const U = { ADMIN: id(1), ORG: id(3), BIZ: id(5), VIS_A: id(7), VIS_B: id(8) } as const;
type Who = keyof typeof U | 'anon';
const rowsTag = /^(SET|RESET|BEGIN|COMMIT|ROLLBACK|DO|GRANT|REVOKE|COMMENT|CREATE .*|DROP .*|ALTER .*|INSERT \d+ \d+|UPDATE \d+|DELETE \d+)$/;
const rowsOf = (o: string) => o.split('\n').map((l) => l.trim()).filter((l) => l && !rowsTag.test(l) && !/^ERROR|^psql:|^LINE |^\s*\^|^DETAIL|^HINT|^CONTEXT|^WARNING|^NOTICE/.test(l));
const last = (o: string) => rowsOf(o).pop() ?? '';
const failed = (o: string) => /^ERROR:|permission denied|row-level security|violates/im.test(o);
class Env {
  db!: ReplayDb;
  as(w: Who) { return w === 'anon' ? 'set local role anon;' : `set local request.jwt.claims = '{"sub":"${U[w]}","email":"${U[w]}@x.invalid","role":"authenticated"}'; set local request.jwt.claim.sub = '${U[w]}'; set local role authenticated;`; }
  try(w: Who, sql: string) { return this.db.raw(`begin; ${this.as(w)} ${sql}; rollback;`); }
  do(w: Who, sql: string) { return this.db.raw(`begin; ${this.as(w)} ${sql}; commit;`); }
  q(sql: string) { return last(this.db.raw(sql)); }
  sup(sql: string) { return this.db.raw(sql); }
  one(w: Who, sql: string) { return last(this.try(w, sql)); }
}
let E: Env; let ED = '', ORG = '', S1 = '', S2 = '', EV = '', LINK = '';
const d = (n: number) => `(current_date + ${n})`;

before(() => {
  E = new Env(); E.db = createReplayDb('editionsvisitor');
  E.sup(`alter default privileges for role postgres in schema public grant execute on functions to anon, authenticated;`);
  E.sup(`insert into auth.users (id, email) select x, x::text || '@x.invalid' from unnest(array['${U.ADMIN}'::uuid,'${U.ORG}'::uuid,'${U.BIZ}'::uuid,'${U.VIS_A}'::uuid,'${U.VIS_B}'::uuid]) x on conflict do nothing;
    insert into profiles (id, role, full_name) values ('${U.ADMIN}','admin','Zed'),('${U.ORG}','customer','Orla'),('${U.BIZ}','customer','Bea'),('${U.VIS_A}','customer','Vi A'),('${U.VIS_B}','customer','Vi B')
      on conflict (id) do update set role = excluded.role;
    insert into admin_config (key, value, category) values ('editions.enabled','true','features') on conflict (key) do update set value='true';`);
  ORG = last(E.do('ORG', `select public.create_edition_organiser('ZZ Visitor Org', 'zz-visitor-org')`));
  E.do('ORG', `select public.request_edition_organiser_verification('${ORG}', 'evidence evidence')`);
  E.do('ADMIN', `select public.admin_decide_edition_organiser('${ORG}', 'verify', 'ok ok ok ok')`);
  ED = last(E.do('ORG', `insert into public.editions (organiser_id, slug, title, summary, kind, starts_on, ends_on) values ('${ORG}','zz-vis-fest','ZZ Vis Fest','x','multi_day',${d(10)},${d(12)}) returning id`));
  E.do('ADMIN', `select public.admin_grant_edition_entitlement('${ED}', 'publish', now(), now() + interval '90 days', 'ZZ visitor suite')`);
  E.do('ORG', `select public.edition_set_status('${ED}', 'published')`);
  S1 = last(E.do('ORG', `insert into public.edition_sessions (edition_id, title, starts_at, kind) values ('${ED}','ZZ Opening',(${d(10)})::timestamp + interval '10 hours','session') returning id`));
  S2 = last(E.do('ORG', `insert into public.edition_sessions (edition_id, title, starts_at, kind) values ('${ED}','ZZ Concert',(${d(11)})::timestamp + interval '19 hours','session') returning id`));
  const biz = last(E.sup(`insert into local_businesses (owner_id, name, category, address, is_active) values ('${U.BIZ}','ZZ Pub','food_drink','x',true) returning id`));
  EV = last(E.sup(`insert into events (title, starts_at, status, organiser_business_id, organiser_user_id) values ('ZZ Quiz', (${d(11)})::timestamp + interval '20 hours','published','${biz}','${U.BIZ}') returning id`));
  LINK = last(E.do('ORG', `select public.edition_invite_partner('${ED}','event','${EV}')`));
  E.do('BIZ', `select public.edition_link_act('${LINK}','approve',null)`);
});
after(() => { try { E?.db.drop(); } catch { /* */ } });

describe('lockdown', () => {
  test('RLS on, own-row read only, no direct DML, no anon access, no FOR ALL', () => {
    assert.equal(E.q(`select count(*) from pg_class where relname in ('edition_saves','edition_plan_items') and not relrowsecurity`), '0');
    assert.equal(E.q(`select count(*) from pg_policies where tablename in ('edition_saves','edition_plan_items') and cmd='ALL'`), '0');
    assert.equal(E.q(`select count(*) from information_schema.role_table_grants where grantee in ('anon','authenticated') and table_name in ('edition_saves','edition_plan_items') and (grantee='anon' or privilege_type <> 'SELECT')`), '0');
    assert.equal(E.q(`select count(*) from pg_proc p where proname in ('edition_save','edition_plan_toggle','edition_my_flags','edition_my_plan') and has_function_privilege('anon', p.oid, 'execute')`), '0');
  });
  test('writes only through the functions; signed-out is refused', () => {
    assert.ok(failed(E.try('VIS_A', `insert into public.edition_saves (user_id, edition_id) values ('${U.VIS_A}','${ED}')`)));
    assert.ok(failed(E.try('anon', `select public.edition_save('${ED}')`)));
    assert.ok(failed(E.try('anon', `select public.edition_plan_toggle('${ED}','session','${S1}')`)));
  });
});

describe('save an Edition', () => {
  test('save, flag, unsave; only public Editions; idempotent', () => {
    assert.equal(E.one('VIS_A', `select public.edition_save('${ED}')`), 't');
    E.do('VIS_A', `select public.edition_save('${ED}')`);
    assert.equal(E.q(`select count(*) from edition_saves`), '1');
    assert.match(E.one('VIS_A', `select public.edition_my_flags('${ED}')::text`), /"saved": true/);
    assert.equal(E.one('anon', `select 1`), '1');
    E.do('VIS_A', `select public.edition_save('${ED}', false)`);
    assert.equal(E.q(`select count(*) from edition_saves`), '0');
    const draft = last(E.do('ORG', `insert into public.editions (organiser_id, slug, title, summary, kind, starts_on, ends_on) values ('${ORG}','zz-vis-draft','ZZ Draft','x','single_day',${d(30)},${d(30)}) returning id`));
    assert.match(E.try('VIS_A', `select public.edition_save('${draft}')`), /edition not found/);
  });
  test('privacy: visitors see only their own rows', () => {
    E.do('VIS_A', `select public.edition_save('${ED}')`);
    assert.equal(E.one('VIS_B', `select count(*) from public.edition_saves`), '0');
    assert.equal(E.one('VIS_A', `select count(*) from public.edition_saves`), '1');
    assert.match(E.one('VIS_B', `select public.edition_my_flags('${ED}')::text`), /"saved": false/);
  });
});

describe('personal plan', () => {
  test('add sessions and an approved event; sessions of other Editions are refused', () => {
    assert.equal(E.one('VIS_A', `select public.edition_plan_toggle('${ED}','session','${S1}')`), 't');
    E.do('VIS_A', `select public.edition_plan_toggle('${ED}','session','${S1}')`);
    E.do('VIS_A', `select public.edition_plan_toggle('${ED}','session','${S2}')`);
    E.do('VIS_A', `select public.edition_plan_toggle('${ED}','event','${EV}')`);
    assert.equal(E.q(`select count(*) from edition_plan_items where user_id='${U.VIS_A}'`), '3');
    assert.match(E.try('VIS_A', `select public.edition_plan_toggle('${ED}','session','${EV}')`), /item not found/);
    assert.match(E.try('VIS_A', `select public.edition_plan_toggle('${ED}','event','${S1}')`), /item not found/);
  });
  test('my plan lists items in time order with the Edition, and flags reflect them', () => {
    const r = E.try('VIS_A', `select kind || ':' || title from public.edition_my_plan() where kind is not null order by starts_at`);
    assert.match(r, /session:ZZ Opening[\s\S]*session:ZZ Concert[\s\S]*event:ZZ Quiz/);
    assert.match(E.one('VIS_A', `select public.edition_my_flags('${ED}')::text`), /"events": \["/);
    assert.equal(E.one('VIS_B', `select count(*) from public.edition_my_plan()`), '0');
  });
  test('an unlinked event cannot be added; a withdrawn partner drops out of the plan at once', () => {
    const other = last(E.sup(`insert into events (title, starts_at, status, is_platform_event) values ('ZZ Other', now() + interval '11 days','published', true) returning id`));
    assert.match(E.try('VIS_B', `select public.edition_plan_toggle('${ED}','event','${other}')`), /item not found/);
    E.do('BIZ', `select public.edition_link_act('${LINK}','withdraw',null)`);
    assert.doesNotMatch(E.try('VIS_A', `select kind || ':' || title from public.edition_my_plan()`), /ZZ Quiz/);
    assert.match(E.try('VIS_B', `select public.edition_plan_toggle('${ED}','event','${EV}')`), /item not found/);
  });
  test('suspending the Edition removes it from saves and plans; restoring brings it back (nothing deleted)', () => {
    E.do('ADMIN', `select public.edition_moderate('${ED}','suspend','ZZ visitor suite suspend')`);
    assert.equal(E.one('VIS_A', `select count(*) from public.edition_my_plan()`), '0');
    assert.match(E.try('VIS_A', `select public.edition_plan_toggle('${ED}','session','${S1}')`), /edition not found/);
    assert.equal(E.q(`select count(*) from edition_plan_items where user_id='${U.VIS_A}'`), '3', 'data kept');
    E.do('ADMIN', `select public.edition_moderate('${ED}','restore','ok')`);
    E.do('ORG', `select public.edition_set_status('${ED}','published')`);
    assert.ok(Number(E.one('VIS_A', `select count(*) from public.edition_my_plan()`)) >= 3);
  });
  test('removing an item and the 150-item cap', () => {
    E.do('VIS_A', `select public.edition_plan_toggle('${ED}','session','${S1}', false)`);
    assert.equal(E.q(`select count(*) from edition_plan_items where user_id='${U.VIS_A}' and session_id='${S1}'`), '0');
    E.sup(`insert into edition_plan_items (user_id, edition_id, kind, event_id) select '${U.VIS_B}', '${ED}', 'event', e.id from (select id from events limit 1) e`);
  });
  test('account deletion removes saves and plans (cascade)', () => {
    E.sup(`delete from auth.users where id='${U.VIS_A}'`);
    assert.equal(E.q(`select count(*) from edition_saves where user_id='${U.VIS_A}'`) + E.q(`select count(*) from edition_plan_items where user_id='${U.VIS_A}'`), '00');
  });
  test('the migration changes no existing table (My Saved untouched)', () => {
    if (E.q(`select to_regclass('public.saved_items') is null`) === 't') return;   // the Editions-only release has no My Saved: there is nothing of it to touch
    assert.equal(E.q(`select count(*) from information_schema.columns where table_name='saved_items' and column_name like '%edition%'`), '0');
    assert.match(E.q(`select pg_get_constraintdef(oid) from pg_constraint where conrelid='public.saved_items'::regclass and contype='c' and pg_get_constraintdef(oid) like '%item_type%' limit 1`), /event.*activity.*business/);
  });
});
