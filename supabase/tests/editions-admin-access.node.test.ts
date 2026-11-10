/**
 * editions-admin-access.node.test.ts — ISOLATED Postgres only. Production issue 10 Nov 2026: the Editions admin pages selected edition_organisers.contact_email directly, a column the
 * authenticated role may not read, so the Verification queue, Organisers list and organiser detail failed with "permission denied for table edition_organisers", administrators included.
 * This pins (1) the failure and why, (2) the admin-only function that fixes it, (3) that every query the admin pages now run works for an administrator and exposes nothing to anyone
 * else, and (4) that the strict table grants did not change. Run: ISOLATED_ONLY=editions-admin-access npm run test:isolated   (never `npm test`)
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createReplayDb, type ReplayDb } from './_support/replay-db.ts';

const id = (n: number) => `${n.toString(16).padStart(2, '0')}000000-0000-4000-8000-0000000000${n.toString(16).padStart(2, '0')}`;
const U = { ADMIN: id(1), MOD: id(2), ORG_OWNER: id(3), ORG_EDITOR: id(4), BIZ: id(5), HUB_ADMIN: id(6), STRANGER: id(7) } as const;
type Who = keyof typeof U | 'anon';
const rowsTag = /^(SET|RESET|BEGIN|COMMIT|ROLLBACK|DO|GRANT|REVOKE|COMMENT|CREATE .*|DROP .*|ALTER .*|INSERT \d+ \d+|UPDATE \d+|DELETE \d+)$/;
const rowsOf = (o: string) => o.split('\n').map((l) => l.trim()).filter((l) => l && !rowsTag.test(l) && !/^ERROR|^psql:|^LINE |^\s*\^|^DETAIL|^HINT|^CONTEXT|^WARNING|^NOTICE/.test(l));
const last = (o: string) => rowsOf(o).pop() ?? '';
const failed = (o: string) => /^ERROR:|permission denied|row-level security|not permitted/im.test(o);
let db: ReplayDb; let ORG = '', ORG2 = '', ED = '';
const as = (w: Who) => w === 'anon' ? 'set local role anon;' : `set local request.jwt.claims = '{"sub":"${U[w]}","email":"${U[w]}@x.invalid","role":"authenticated"}'; set local request.jwt.claim.sub = '${U[w]}'; set local role authenticated;`;
const run = (w: Who, sql: string, commit = false) => db.raw(`begin; ${as(w)} ${sql}; ${commit ? 'commit' : 'rollback'};`);
const one = (w: Who, sql: string) => last(run(w, sql));
const q = (sql: string) => last(db.raw(sql));
const d = (n: number) => `(current_date + ${n})`;

before(() => {
  db = createReplayDb('editionsadminaccess');
  db.raw(`alter default privileges for role postgres in schema public grant execute on functions to anon, authenticated;`);
  db.raw(`insert into auth.users (id, email) select x, x::text || '@x.invalid' from unnest(array[${Object.values(U).map((u) => `'${u}'::uuid`).join(',')}]) x on conflict do nothing;
    insert into profiles (id, role, full_name) values ('${U.ADMIN}','admin','Zed Admin'),('${U.MOD}','moderator','Mo Mod'),('${U.ORG_OWNER}','customer','Orla Owner'),('${U.ORG_EDITOR}','customer','Eddie Editor'),
      ('${U.BIZ}','customer','Bea Biz'),('${U.HUB_ADMIN}','customer','Hugh Hub'),('${U.STRANGER}','customer','Sam Stranger') on conflict (id) do update set role = excluded.role, full_name = excluded.full_name;
    insert into admin_config (key, value, category) values ('editions.enabled','false','features') on conflict (key) do update set value='false';`);
  db.raw(`insert into local_businesses (owner_id, name, category, address, is_active) values ('${U.BIZ}','ZZ Cafe','food_drink','x',true);
    insert into hubs (owner_id, name, slug, type, is_active) values ('${U.HUB_ADMIN}','ZZ Hub','zz-hub','community',true);`);
  ORG = q(`insert into public.edition_organisers (slug, name, status, contact_email, created_by, verification_note, reserved_name_flag) values ('zz-org','ZZ Org','pending','private-org@x.invalid','${U.ORG_OWNER}','INTERNAL NOTE',true) returning id`);
  ORG2 = q(`insert into public.edition_organisers (slug, name, status, contact_email, created_by) values ('zz-org-two','ZZ Org Two','verified','two@x.invalid','${U.ORG_OWNER}') returning id`);
  db.raw(`insert into public.edition_organiser_members (organiser_id, user_id, role) values ('${ORG}','${U.ORG_OWNER}','owner'),('${ORG}','${U.ORG_EDITOR}','editor');
    insert into public.edition_organiser_verifications (organiser_id, requested_by, evidence, status) values ('${ORG}','${U.ORG_OWNER}','We run the annual festival','pending');`);
  ED = q(`insert into public.editions (organiser_id, slug, title, summary, kind, starts_on, ends_on) values ('${ORG2}','zz-fest','ZZ Fest','x','multi_day',${d(10)},${d(12)}) returning id`);
  run('ADMIN', `select public.admin_grant_edition_entitlement('${ED}', 'publish', now(), now() + interval '30 days', 'ZZ admin access suite')`, true);
});
after(() => { try { db?.drop(); } catch { /* */ } });

describe('the production failure, reproduced: contact_email cannot be read directly by anyone signed in', () => {
  test('the exact old admin queries fail with permission denied, for the administrator too', () => {
    const queue = `select v.id, (select row_to_json(o) from (select id, name, slug, status, is_test, contact_email, created_at from public.edition_organisers o where o.id = v.organiser_id) o) from public.edition_organiser_verifications v where status='pending'`;
    for (const w of ['ADMIN', 'MOD', 'ORG_OWNER', 'STRANGER'] as Who[]) {
      assert.match(run(w, queue), /permission denied for table edition_organisers/, `${w}: queue`);
      assert.match(run(w, `select id, name, slug, status, is_test, contact_email, created_at from public.edition_organisers`), /permission denied for table edition_organisers/, `${w}: list`);
      assert.match(run(w, `select id, name, contact_email from public.edition_organisers where id='${ORG}'`), /permission denied for table edition_organisers/, `${w}: detail`);
    }
  });
});

describe('admin_edition_org_contacts: platform administrators only', () => {
  test('an administrator reads one organiser\'s contact email, or all of them', () => {
    assert.equal(one('ADMIN', `select contact_email from public.admin_edition_org_contacts('${ORG}')`), 'private-org@x.invalid');
    assert.equal(one('ADMIN', `select count(*) from public.admin_edition_org_contacts()`), '2');
    assert.equal(one('ADMIN', `select contact_email from public.admin_edition_org_contacts('${ORG2}')`), 'two@x.invalid');
    assert.equal(one('ADMIN', `select count(*) from public.admin_edition_org_contacts('00000000-0000-4000-8000-000000000000')`), '0');
  });
  test('nobody else can: moderator, organiser owner and editor, business owner, Hub administrator, ordinary user; and signed-out visitors cannot even call it', () => {
    for (const w of ['MOD', 'ORG_OWNER', 'ORG_EDITOR', 'BIZ', 'HUB_ADMIN', 'STRANGER'] as Who[]) {
      assert.match(run(w, `select * from public.admin_edition_org_contacts('${ORG}')`), /not permitted/, w);
      assert.match(run(w, `select * from public.admin_edition_org_contacts()`), /not permitted/, `${w} (all)`);
    }
    assert.match(run('anon', `select * from public.admin_edition_org_contacts('${ORG}')`), /permission denied for function/);
  });
  test('the organiser team still reads its own contact email only through the team-only function', () => {
    assert.equal(one('ORG_OWNER', `select public.edition_org_contact_email('${ORG}')`), 'private-org@x.invalid');
    assert.equal(one('STRANGER', `select coalesce(public.edition_org_contact_email('${ORG}'), 'none')`), 'none');
  });
});

describe('every query the admin pages now run works for an administrator', () => {
  test('verification queue, organisers list, organiser detail (without the hidden column), with the internal flags and note through their admin functions', () => {
    assert.equal(one('ADMIN', `select v.evidence from public.edition_organiser_verifications v where status='pending'`), 'We run the annual festival');
    assert.equal(one('ADMIN', `select (select name from public.edition_organisers o where o.id = v.organiser_id) from public.edition_organiser_verifications v where status='pending'`), 'ZZ Org');
    assert.equal(one('ADMIN', `select count(*) from (select id, name, slug, status, is_test, created_at from public.edition_organisers order by created_at desc limit 300) x`), '2');
    assert.equal(one('ADMIN', `select name from (select id, name, slug, tagline, description, website, status, verified_at, is_test, hub_id, created_at from public.edition_organisers where id='${ORG}') x`), 'ZZ Org');
    assert.equal(one('ADMIN', `select verification_note from public.admin_edition_org_internal('${ORG}')`), 'INTERNAL NOTE');
    assert.equal(one('ADMIN', `select reserved_name_flag from public.admin_edition_org_flags() where id='${ORG}'`), 't');
  });
  test('Editions, Entitlements and Audit log tabs, and the Edition detail page counts', () => {
    assert.equal(one('ADMIN', `select title from public.editions e join public.edition_organisers o on o.id = e.organiser_id where e.id='${ED}'`), 'ZZ Fest');
    assert.equal(one('ADMIN', `select count(*) from public.edition_entitlements n join public.editions e on e.id = n.edition_id join public.edition_organisers o on o.id = n.organiser_id`), '1');
    assert.ok(Number(one('ADMIN', `select count(*) from public.edition_audit_log`)) >= 1, 'the grant was audited');
    assert.equal(one('ADMIN', `select count(*) from public.edition_organiser_members where organiser_id='${ORG}'`), '2');
    for (const t of ['edition_pages', 'edition_sessions', 'edition_updates', 'edition_sponsors']) assert.doesNotMatch(run('ADMIN', `select count(*) from public.${t} where edition_id='${ED}'`), /ERROR|denied/, t);
  });
});

describe('everyone else sees none of it', () => {
  test('ordinary users, business owners, Hub administrators and organiser team members of OTHER organisers see no queue, no pending organiser, no entitlements and no audit rows', () => {
    for (const w of ['BIZ', 'HUB_ADMIN', 'STRANGER'] as Who[]) {
      assert.equal(one(w, `select count(*) from public.edition_organiser_verifications`), '0', `${w}: queue`);
      assert.equal(one(w, `select count(*) from public.edition_organisers`), '0', `${w}: organisers (the verified one is hidden while the feature is off, the pending one always)`);
      assert.equal(one(w, `select count(*) from public.edition_entitlements`), '0', `${w}: entitlements`);
      assert.equal(one(w, `select count(*) from public.edition_audit_log`), '0', `${w}: audit`);
      assert.equal(one(w, `select count(*) from public.edition_organiser_members`), '0', `${w}: team`);
      assert.match(run(w, `select * from public.admin_edition_org_internal('${ORG}')`), /not permitted/, `${w}: internal`);
      assert.match(run(w, `select * from public.admin_edition_org_flags()`), /not permitted/, `${w}: flags`);
    }
  });
  test('an organiser team member sees only their own organiser, never the verification queue of others, never the audit log', () => {
    assert.equal(one('ORG_EDITOR', `select count(*) from public.edition_organisers`), '1');
    assert.equal(one('ORG_EDITOR', `select count(*) from public.edition_audit_log`), '0');
    assert.match(run('ORG_EDITOR', `select * from public.admin_edition_org_contacts()`), /not permitted/);
  });
  test('signed-out visitors read nothing while Editions is off', () => {
    for (const t of ['edition_organisers', 'editions', 'edition_entitlements', 'edition_audit_log', 'edition_organiser_verifications']) {
      const r = run('anon', `select count(*) from public.${t}`); assert.ok(failed(r) || last(r) === '0', t);
    }
  });
});

describe('the strict model is unchanged', () => {
  test('exactly these columns stay hidden from signed-in and signed-out users (the website test pins the same list; change both together)', () => {
    const hidden = (t: string) => q(`select coalesce(string_agg(c.column_name, ',' order by c.column_name), '') from information_schema.columns c where c.table_schema='public' and c.table_name='${t}' and not exists (select 1 from information_schema.column_privileges p where p.table_schema='public' and p.table_name='${t}' and p.column_name=c.column_name and p.grantee='authenticated' and p.privilege_type='SELECT')`);
    assert.equal(hidden('edition_organisers'), 'contact_email,created_by,reserved_name_flag,verification_note,verified_by');
    assert.equal(hidden('edition_updates'), 'created_by');
    assert.equal(hidden('edition_payout_accounts'), 'stripe_account_id');
    assert.equal(q(`select count(*) from information_schema.column_privileges where table_schema='public' and table_name='edition_organisers' and column_name='contact_email' and grantee in ('anon','authenticated') and privilege_type='SELECT'`), '0');
  });
  test('no new anonymous capability: the signed-out role still executes exactly seven Editions functions (six reviewed helpers plus edition_pilot_visible)', () => {
    assert.equal(q(`select count(*) from pg_proc p where p.pronamespace='public'::regnamespace and p.proname ilike '%edition%' and has_function_privilege('anon', p.oid, 'execute')`), '7');
    assert.equal(q(`select count(*) from information_schema.role_table_grants where grantee='anon' and table_schema='public' and table_name like 'edition%' and privilege_type <> 'SELECT'`), '0');
  });
  test('rollback removes only the function and is safe to run twice', () => {
    db.rawFile(new URL('../rollbacks/20270102150000_editions_admin_contacts.rollback.sql', import.meta.url).pathname);
    db.rawFile(new URL('../rollbacks/20270102150000_editions_admin_contacts.rollback.sql', import.meta.url).pathname);
    assert.equal(q(`select count(*) from pg_proc where proname = 'admin_edition_org_contacts'`), '0');
    assert.equal(q(`select count(*) from pg_proc where proname = 'admin_edition_org_flags'`), '1');
  });
});
