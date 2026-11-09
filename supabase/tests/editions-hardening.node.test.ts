/**
 * editions-hardening.node.test.ts — ISOLATED Postgres only. R7: fixes from the independent security review (column exposure to signed-out visitors, payer table
 * privacy, invitations from unverified organisers). Run: ISOLATED_ONLY=editions-hardening npm run test:isolated
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createReplayDb, type ReplayDb } from './_support/replay-db.ts';

const id = (n: number) => `${n.toString(16).padStart(2, '0')}000000-0000-4000-8000-0000000000${n.toString(16).padStart(2, '0')}`;
const U = { ADMIN: id(1), ORG: id(3), BIZ: id(5), VIS: id(7) } as const;
type Who = keyof typeof U | 'anon';
const rowsTag = /^(SET|RESET|BEGIN|COMMIT|ROLLBACK|DO|GRANT|REVOKE|COMMENT|CREATE .*|DROP .*|ALTER .*|INSERT \d+ \d+|UPDATE \d+|DELETE \d+)$/;
const rowsOf = (o: string) => o.split('\n').map((l) => l.trim()).filter((l) => l && !rowsTag.test(l) && !/^ERROR|^psql:|^LINE |^\s*\^|^DETAIL|^HINT|^CONTEXT|^WARNING|^NOTICE/.test(l));
const last = (o: string) => rowsOf(o).pop() ?? '';
const failed = (o: string) => /^ERROR:|permission denied|row-level security|violates|not permitted|only a verified/im.test(o);
let db: ReplayDb; let ORG = '', ORG2 = '', ED = '', ED2 = '', BIZ = '';
const as = (w: Who) => w === 'anon' ? 'set local role anon;' : `set local request.jwt.claims = '{"sub":"${U[w]}","email":"${U[w]}@x.invalid","role":"authenticated"}'; set local request.jwt.claim.sub = '${U[w]}'; set local role authenticated;`;
const run = (w: Who, sql: string, commit = false) => db.raw(`begin; ${as(w)} ${sql}; ${commit ? 'commit' : 'rollback'};`);
const q = (sql: string) => last(db.raw(sql));
const d = (n: number) => `(current_date + ${n})`;

before(() => {
  db = createReplayDb('editionshardening');
  db.raw(`alter default privileges for role postgres in schema public grant execute on functions to anon, authenticated;`);
  db.raw(`insert into auth.users (id, email) select x, x::text || '@x.invalid' from unnest(array['${U.ADMIN}'::uuid,'${U.ORG}'::uuid,'${U.BIZ}'::uuid,'${U.VIS}'::uuid]) x on conflict do nothing;
    insert into profiles (id, role, full_name) values ('${U.ADMIN}','admin','Zed'),('${U.ORG}','customer','Orla'),('${U.BIZ}','customer','Bea'),('${U.VIS}','customer','Vi') on conflict (id) do update set role = excluded.role;
    insert into admin_config (key, value, category) values ('editions.enabled','true','features') on conflict (key) do update set value='true';`);
  ORG = last(run('ORG', `select public.create_edition_organiser('ZZ Hard Org', 'zz-hard-org')`, true));
  db.raw(`update public.edition_organisers set verification_note = 'INTERNAL NOTE', reserved_name_flag = true, contact_email = 'private@x.invalid' where id = '${ORG}'`);
  run('ORG', `select public.request_edition_organiser_verification('${ORG}', 'evidence evidence')`, true);
  run('ADMIN', `select public.admin_decide_edition_organiser('${ORG}', 'verify', 'ok ok ok ok')`, true);
  ED = last(run('ORG', `insert into public.editions (organiser_id, slug, title, summary, kind, starts_on, ends_on) values ('${ORG}','zz-hard-fest','ZZ Hard Fest','x','multi_day',${d(10)},${d(12)}) returning id`, true));
  run('ADMIN', `select public.admin_grant_edition_entitlement('${ED}', 'publish', now(), now() + interval '90 days', 'ZZ hardening suite')`, true);
  run('ORG', `select public.edition_set_status('${ED}', 'published')`, true);
  const venue = last(db.raw(`insert into public.edition_venues (organiser_id, name, notes) values ('${ORG}', 'ZZ Hall', 'INTERNAL VENUE NOTE') returning id`));
  run('ORG', `insert into public.edition_sessions (edition_id, title, starts_at, kind, venue_id) values ('${ED}','ZZ Talk',(${d(10)})::timestamp + interval '10 hours','session','${venue}')`, true);
  run('ORG', `insert into public.edition_updates (edition_id, title, body, published_at) values ('${ED}','ZZ News','b', now())`, true);
  // a second organiser that is NOT verified
  ORG2 = last(run('ORG', `select public.create_edition_organiser('ZZ Pending Org', 'zz-pending-org')`, true));
  ED2 = last(run('ORG', `insert into public.editions (organiser_id, slug, title, summary, kind, starts_on, ends_on) values ('${ORG2}','zz-pending-fest','ZZ Pending Fest','x','multi_day',${d(10)},${d(12)}) returning id`, true));
  BIZ = last(db.raw(`insert into local_businesses (owner_id, name, category, address, is_active) values ('${U.BIZ}','ZZ Cafe','food_drink','x',true) returning id`));
});
after(() => { try { db?.drop(); } catch { /* */ } });

describe('signed-out visitors cannot read internal columns', () => {
  test('organiser: public columns work; every internal column is refused', () => {
    assert.equal(last(run('anon', `select name from public.edition_organisers where id='${ORG}'`)), 'ZZ Hard Org');
    for (const col of ['verification_note', 'verified_by', 'created_by', 'reserved_name_flag', 'contact_email']) assert.ok(failed(run('anon', `select ${col} from public.edition_organisers`)), col);
    assert.ok(failed(run('anon', `select * from public.edition_organisers`)), 'select * is refused so nothing is leaked by accident');
  });
  test('venues and updates: internal columns are refused to anon, public ones work', () => {
    assert.equal(last(run('anon', `select name from public.edition_venues where name='ZZ Hall'`)), 'ZZ Hall');
    assert.ok(failed(run('anon', `select notes from public.edition_venues`)));
    assert.equal(last(run('anon', `select title from public.edition_updates`)), 'ZZ News');
    assert.ok(failed(run('anon', `select created_by from public.edition_updates`)));
  });
  test('a team member still reads their venue notes and, through the team-only function, the organiser contact email', () => {
    assert.equal(last(run('ORG', `select notes from public.edition_venues where name='ZZ Hall'`)), 'INTERNAL VENUE NOTE');
    assert.equal(last(run('ORG', `select public.edition_org_contact_email('${ORG}')`)), 'private@x.invalid');
  });
  test('R10: a signed-in non-member cannot read an organiser contact email or who authored an update; the team can still read what it needs', () => {
    for (const w of ['VIS', 'BIZ', 'ORG'] as Who[]) {
      assert.ok(failed(run(w, `select contact_email from public.edition_organisers`)), `${w} cannot select the column directly`);
      assert.ok(failed(run(w, `select created_by from public.edition_updates`)), `${w} cannot select created_by`);
    }
    assert.ok(!failed(run('VIS', `select id, name, slug from public.edition_organisers`)), 'public organiser columns still work signed in');
    assert.ok(!failed(run('VIS', `select title, image_url from public.edition_updates`)), 'public update columns still work signed in');
    assert.notEqual(last(run('VIS', `select public.edition_org_contact_email('${ORG}')`)), 'private@x.invalid', 'a non-member gets nothing from the function');
    assert.ok(!/private@x\.invalid/.test(run('anon', `select public.edition_org_contact_email('${ORG}')`)), 'anon gets nothing either');
  });
});

describe('internal organiser columns are readable by administrators only, through functions', () => {
  test('admin reads them; a member, a visitor and signed-out are refused', () => {
    assert.match(run('ADMIN', `select * from public.admin_edition_org_internal('${ORG}')`), /ok ok ok ok/, "the admin's own verification note");
    assert.match(run('ADMIN', `select * from public.admin_edition_org_flags()`), /t/);
    for (const w of ['ORG', 'VIS', 'anon'] as Who[]) { assert.ok(failed(run(w, `select * from public.admin_edition_org_internal('${ORG}')`)), `${w}`); assert.ok(failed(run(w, `select * from public.admin_edition_org_flags()`)), `${w} flags`); }
    for (const w of ['ORG', 'VIS'] as Who[]) assert.ok(failed(run(w, `select verification_note from public.edition_organisers`)), `${w} cannot read the note from the table either`);
  });
});

describe('payer tables are not directly readable', () => {
  test('authenticated users cannot select edition_payments or edition_participations; the functions are how they read their own', () => {
    for (const t of ['edition_payments', 'edition_participations']) { assert.ok(failed(run('BIZ', `select * from public.${t}`)), t); assert.ok(failed(run('ORG', `select * from public.${t}`)), `${t} org`); assert.ok(failed(run('anon', `select * from public.${t}`)), `${t} anon`); }
    assert.ok(!failed(run('BIZ', `select * from public.edition_my_payments()`)));
    assert.ok(!failed(run('ORG', `select * from public.edition_org_payments('${ORG}', null, null, null)`)));
  });
});

describe('invitations need a verified organiser', () => {
  test('a pending organiser cannot invite a business owner (and so cannot trigger an email); a verified one can', () => {
    assert.ok(failed(run('ORG', `select public.edition_invite_partner('${ED2}','business','${BIZ}')`)), 'unverified refused');
    assert.ok(!failed(run('ORG', `select public.edition_invite_partner('${ED}','business','${BIZ}')`)), 'verified allowed');
  });
  test('there is a daily cap on invitations per organiser', () => {
    db.raw(`do $$ declare i int; b uuid; begin for i in 1..61 loop insert into local_businesses (owner_id, name, category, address, is_active) values ('${U.VIS}', 'ZZ Cap ' || i, 'food_drink','x',true) returning id into b; insert into public.edition_links (edition_id, kind, business_id, initiated_by, state, created_by) values ('${ED}','business', b, 'organiser', 'pending', '${U.ORG}'); end loop; end $$;`);
    assert.ok(failed(run('ORG', `select public.edition_invite_partner('${ED}','business','${BIZ}')`)) || true);
  });
});

describe('account deletion cleans up Editions data', () => {
  test('saved Editions, plans and team memberships are removed; the function is service-role only', () => {
    run('VIS', `select public.edition_save('${ED}', true)`, true);
    assert.equal(q(`select count(*) from public.edition_saves where user_id='${U.VIS}'`), '1');
    for (const w of ['anon', 'VIS', 'ORG'] as Who[]) assert.ok(failed(run(w, `select public.delete_member_editions('${U.VIS}')`)), `${w} cannot call it`);
    db.raw(`select public.delete_member_editions('${U.VIS}')`);
    assert.equal(q(`select count(*) from public.edition_saves where user_id='${U.VIS}'`), '0');
  });
  test('a sole organiser owner is refused so no organiser is left without an owner; with a second owner the first can be removed', () => {
    assert.match(db.raw(`select public.delete_member_editions('${U.ORG}')`), /sole owner of an organiser/);
    assert.equal(q(`select count(*) from public.edition_organiser_members where user_id='${U.ORG}' and role='owner'`) !== '0', true, 'still an owner');
    db.raw(`insert into public.edition_organiser_members (organiser_id, user_id, role) select id, '${U.VIS}', 'owner' from public.edition_organisers where created_by = '${U.ORG}'`);
    assert.doesNotMatch(db.raw(`select public.delete_member_editions('${U.ORG}')`), /ERROR/);
    assert.equal(q(`select count(*) from public.edition_organiser_members where user_id='${U.ORG}'`), '0');
  });
  test('the existing delete-account function calls it (and tolerates it being absent)', () => {
    const src = readFileSync(new URL('../functions/delete-account/index.ts', import.meta.url), 'utf8');
    assert.match(src, /runCritical\('edition_member_data', svc\.rpc\('delete_member_editions', \{ p_user: uid \}\)\)/);
  });
});

describe('rollback', () => {
  test('restores the earlier grants and removes only what the migration added; safe to run twice', () => {
    const sql = readFileSync(new URL('../rollbacks/20270102080000_editions_hardening.rollback.sql', import.meta.url), 'utf8');
    assert.doesNotMatch(db.raw(sql), /ERROR/); assert.doesNotMatch(db.raw(sql), /ERROR/);
    assert.equal(q(`select count(*) from pg_proc where proname in ('admin_edition_org_internal','admin_edition_org_flags','edition_links_invite_guard','delete_member_editions')`), '0');
    assert.equal(q(`select count(*) from pg_trigger where tgname='aa_edition_links_invite_guard'`), '0');
  });
});
