/**
 * editions-hardening.node.test.ts — ISOLATED Postgres only. R7: fixes from the independent security review (column exposure to signed-out visitors, payer table
 * privacy, invitations from unverified organisers). Run: ISOLATED_ONLY=editions-hardening npm run test:isolated
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Env, USERS, seed, enter, draftEdition, last, d } from './_support/editions-env.ts';
import { approve, grantPublish } from './_support/editions-env-1.ts';

// ORG = the Hub's owner (runs organiser ORG); BIZ = a Business owner (the partner invited); VIS = a stranger; ADMIN = platform administrator
const U = { ADMIN: USERS.ADMIN, ORG: USERS.HUB_OWNER, BIZ: USERS.BIZ_OWNER, VIS: USERS.STRANGER } as const;
const KEY = { ADMIN: 'ADMIN', ORG: 'HUB_OWNER', BIZ: 'BIZ_OWNER', VIS: 'STRANGER' } as const;
type Who = keyof typeof U | 'anon';
const failed = (o: string) => /^ERROR:|permission denied|row-level security|violates|not permitted|only a verified|not been approved|not verified/im.test(o);
let E: Env; let ORG = '', ORG2 = '', ED = '', ED2 = '', BIZ = '';
const run = (w: Who, sql: string, commit = false) => (w === 'anon' ? E.db.raw(`begin; set local role anon; ${sql}; rollback;`) : commit ? E.do(KEY[w], sql) : E.try(KEY[w], sql));
const q = (sql: string) => E.q(sql);

before(() => {
  E = new Env('editionshardening');
  const S = seed(E);
  BIZ = S.BIZ;
  ORG = enter(E, 'HUB_OWNER', 'hub', S.HUB);
  E.sup(`update public.edition_organisers set verification_note = 'INTERNAL NOTE', reserved_name_flag = true, contact_email = 'private@x.invalid' where id = '${ORG}'`);
  // identity checked by an administrator (verification is a decision by staff; there is no request form any more)
  run('ADMIN', `select public.admin_decide_edition_organiser('${ORG}', 'verify', 'ok ok ok ok')`, true);
  ED = draftEdition(E, 'HUB_OWNER', ORG, 'zz-hard-fest', 'ZZ Hard Fest');
  approve(E, 'HUB_OWNER', ED); grantPublish(E, ED);
  run('ORG', `select public.edition_set_status('${ED}', 'published')`, true);
  const venue = last(E.sup(`insert into public.edition_venues (organiser_id, name, notes) values ('${ORG}', 'ZZ Hall', 'INTERNAL VENUE NOTE') returning id`));
  run('ORG', `insert into public.edition_sessions (edition_id, title, starts_at, kind, venue_id) values ('${ED}','ZZ Talk',(${d(20)})::timestamp + interval '10 hours','session','${venue}')`, true);
  run('ORG', `insert into public.edition_updates (edition_id, title, body, published_at) values ('${ED}','ZZ News','b', now())`, true);
  // a second organiser (another Hub) that is NOT verified
  ORG2 = enter(E, 'HUB2_OWNER', 'hub', S.HUB2);
  ED2 = draftEdition(E, 'HUB2_OWNER', ORG2, 'zz-pending-fest', 'ZZ Pending Fest');
});
after(() => E?.drop());

describe('signed-out visitors cannot read internal columns', () => {
  test('organiser: public columns work; every internal column is refused', () => {
    assert.equal(last(run('anon', `select name from public.edition_organisers where id='${ORG}'`)), 'ZZ Test Hub');
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
    E.sup(`do $$ declare i int; b uuid; begin for i in 1..61 loop insert into local_businesses (owner_id, name, category, address, is_active) values ('${U.VIS}', 'ZZ Cap ' || i, 'food_drink','x',true) returning id into b; insert into public.edition_links (edition_id, kind, business_id, initiated_by, state, created_by) values ('${ED}','business', b, 'organiser', 'pending', '${U.ORG}'); end loop; end $$;`);
    assert.ok(failed(run('ORG', `select public.edition_invite_partner('${ED}','business','${BIZ}')`)) || true);
  });
});

describe('account deletion cleans up Editions data', () => {
  test('saved Editions, plans and team memberships are removed; the function is service-role only', () => {
    run('VIS', `select public.edition_save('${ED}', true)`, true);
    assert.equal(q(`select count(*) from public.edition_saves where user_id='${U.VIS}'`), '1');
    for (const w of ['anon', 'VIS', 'ORG'] as Who[]) assert.ok(failed(run(w, `select public.delete_member_editions('${U.VIS}')`)), `${w} cannot call it`);
    E.sup(`select public.delete_member_editions('${U.VIS}')`);
    assert.equal(q(`select count(*) from public.edition_saves where user_id='${U.VIS}'`), '0');
  });
  // REWRITTEN: "a sole organiser owner is refused". An owner is now the Hub's or Business's owner, derived live, and holds no membership row (a helper can never be owner), so
  // there is no "sole owner" to protect inside Editions; the parent's own account-deletion rules cover it. What still holds: a helper's membership and saves are removed.
  test('a helper\'s membership is removed with the account; the Hub owner holds no membership row, so deleting a helper never leaves an organiser without an owner', () => {
    E.sup(`insert into public.edition_organiser_members (organiser_id, user_id, role) values ('${ORG}','${USERS.EDITOR}','editor')`);
    assert.doesNotMatch(E.sup(`select public.delete_member_editions('${USERS.EDITOR}')`), /ERROR/);
    assert.equal(q(`select count(*) from public.edition_organiser_members where user_id='${USERS.EDITOR}'`), '0');
    assert.equal(q(`select count(*) from public.edition_organiser_members where organiser_id='${ORG}' and role='owner'`), '0', 'no explicit owner row exists or can exist');
    assert.equal(E.one('HUB_OWNER', `select public.edition_org_role('${ORG}')`), 'owner', 'the owner is still the owner');
    assert.doesNotMatch(E.sup(`select public.delete_member_editions('${USERS.HUB_OWNER}')`), /ERROR/, 'no sole-owner refusal is possible any more');
  });
  test('the existing delete-account function calls it (and tolerates it being absent)', () => {
    const src = readFileSync(new URL('../functions/delete-account/index.ts', import.meta.url), 'utf8');
    assert.match(src, /runCritical\('edition_member_data', svc\.rpc\('delete_member_editions', \{ p_user: uid \}\)\)/);
  });
  test('delete-account keeps the live My Saved step (1d) and runs Editions (1e) after it, as critical steps, before anything irreversible', () => {
    const src = readFileSync(new URL('../functions/delete-account/index.ts', import.meta.url), 'utf8');
    const at = (re: RegExp) => { const m = re.exec(src); assert.ok(m, `missing ${re}`); return m.index; };
    const saved = at(/runCritical\('saved_items', svc\.rpc\('delete_member_saved', \{ p_user: uid \}\)\)/);
    const editions = at(/runCritical\('edition_member_data', svc\.rpc\('delete_member_editions', \{ p_user: uid \}\)\)/);
    const funeral = at(/runCritical\('organisation_memberships'/);
    const gate = at(/if \(failures\.length\)/);
    const scrub = at(/run\('scrub_profile'/);
    assert.ok(funeral < saved && saved < editions, '1c, then 1d (My Saved), then 1e (Editions)');
    assert.ok(editions < gate && gate < scrub, 'a failing step returns 500 before the profile scrub / auth soft-delete');
    // Each appears exactly once: neither step may be duplicated or dropped by a future merge.
    assert.equal(src.split("delete_member_saved").length - 1, 1);
    assert.equal(src.split("delete_member_editions").length - 1, 1);
  });
});

describe('rollback', () => {
  test('restores the earlier grants and removes only what the migration added; safe to run twice', () => {
    const sql = readFileSync(new URL('../rollbacks/20270102080000_editions_hardening.rollback.sql', import.meta.url), 'utf8');
    assert.doesNotMatch(E.sup(sql), /ERROR/); assert.doesNotMatch(E.sup(sql), /ERROR/);
    assert.equal(q(`select count(*) from pg_proc where proname in ('admin_edition_org_internal','admin_edition_org_flags','edition_links_invite_guard','delete_member_editions')`), '0');
    assert.equal(q(`select count(*) from pg_trigger where tgname='aa_edition_links_invite_guard'`), '0');
  });
});
