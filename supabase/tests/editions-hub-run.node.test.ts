/**
 * editions-hub-run.node.test.ts — ISOLATED Postgres only. Hub-RUN Editions. An organiser linked to a Hub is managed by that Hub's CURRENT owner and committee, read
 * live at every check (no copying, no sync): entering Editions from the Hub, the role mapping, instant effect of committee changes, what each role can and cannot do, uploads, notifications,
 * the team list, account deletion, and data isolation from every other Hub, business and member. (Identity and entry are covered in depth by editions-complete.)
 * Run: ISOLATED_ONLY=editions-hub-run npm run test:isolated   (never `npm test`)
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Env, USERS, seed, enter, draftEdition, d, last, failed, type Who } from './_support/editions-env.ts';

let E: Env;
let S: ReturnType<typeof seed>;
let HUB = '', HUB2 = '', HUB_ADMIN = '', HUB_FOLK = '', ORG = '', ED = '', ORG_PLAIN = '';
const role = (w: Who, org = ORG) => E.one(w, `select coalesce(public.edition_org_role('${org}'), 'none')`);
const setHubRole = (user: string, r: string) => { E.sup(`update hub_members set role='${r}' where hub_id='${HUB}' and user_id='${user}'`); E.sup(`update hub_members set status='active' where hub_id='${HUB}' and user_id='${user}'`); };
// the people this suite used before, mapped onto the shared fixture users
const U = { ADMIN: USERS.ADMIN, HUB_OWNER: USERS.HUB_OWNER, HUB_COMMITTEE: USERS.HUB_COMMITTEE, HUB_MEMBER: USERS.HUB_MEMBER, HUB2_OWNER: USERS.HUB2_OWNER, BIZ: USERS.BIZ_OWNER, STRANGER: USERS.STRANGER, TEAM: USERS.HELPER } as const;

before(() => {
  E = new Env('editionshubrun');
  S = seed(E);
  HUB = S.HUB; HUB2 = S.HUB2;
  E.sup(`update hubs set logo_url='https://x.example/logo.png', brand_color='#7a3b8f' where id='${HUB}'`);
  HUB_FOLK = last(E.sup(`insert into hubs (owner_id, name, slug, type, area, is_active) values ('${U.HUB2_OWNER}','ZZ Folk Festival Society','zz-folk-society','community','Lerwick',true) returning id`));
  HUB_ADMIN = last(E.sup(`insert into hubs (owner_id, name, slug, type, area, is_active) values ('${U.HUB2_OWNER}','ZZ Third Hub','zz-third-hub','community','Lerwick',true) returning id`));
  ORG = enter(E, 'HUB_OWNER', 'hub', HUB);
  ORG_PLAIN = enter(E, 'BIZ_OWNER', 'business', S.BIZ); // a Business organiser: the Hub's authority must not reach it
});
after(() => E?.drop());

describe('who can enter Editions for a Hub', () => {
  test('the organiser exists, linked to the Hub, named after it, with no copied branding (so the Hub\'s own identity is inherited live)', () => {
    assert.equal(E.q(`select hub_id from edition_organisers where id='${ORG}'`), HUB);
    assert.equal(E.q(`select name from edition_organisers where id='${ORG}'`), 'ZZ Test Hub');
    assert.equal(E.q(`select coalesce(logo_url,'') || coalesce(cover_url,'') || coalesce(brand_color,'') || coalesce(description,'') from edition_organisers where id='${ORG}'`), '');
    assert.equal(E.q(`select count(*) from edition_organiser_members where organiser_id='${ORG}'`), '0', 'no membership rows are copied from the Hub');
    assert.ok(Number(E.q(`select count(*) from edition_audit_log where action='organiser_created_from_hub'`)) >= 1);
  });
  test('only the Hub\'s owner or an active committee member; one organiser per Hub; ordinary members, other Hubs\' owners, business owners, strangers and signed-out visitors cannot', () => {
    for (const w of ['HUB_MEMBER', 'HUB2_OWNER', 'BIZ_OWNER', 'STRANGER'] as Who[]) assert.ok(failed(E.try(w, `select public.edition_ensure_organiser('hub','${HUB}')`)), w);
    assert.ok(failed(E.try('anon', `select public.edition_ensure_organiser('hub','${HUB}')`)));
    assert.equal(enter(E, 'HUB_COMMITTEE', 'hub', HUB), ORG, 'the committee gets the same single profile, not a second');
    assert.equal(E.q(`select count(*) from edition_organisers where hub_id='${HUB}'`), '1');
    E.sup(`update hubs set is_active=false where id='${HUB_ADMIN}'`);
    assert.match(E.try('HUB2_OWNER', `select public.edition_ensure_organiser('hub','${HUB_ADMIN}')`), /not found/, 'an inactive Hub cannot');
    E.sup(`update hubs set is_active=true where id='${HUB_ADMIN}'`);
  });
  test('the committee can enter Editions for a Hub that has none', () => {
    E.sup(`insert into hub_members (hub_id, user_id, role, status) values ('${HUB_ADMIN}','${U.HUB_COMMITTEE}','committee','active') on conflict do nothing`);
    assert.ok(enter(E, 'HUB_COMMITTEE', 'hub', HUB_ADMIN));
  });
  test('the generated address and the reserved-name review follow the parent\'s name', () => {
    const o = enter(E, 'HUB2_OWNER', 'hub', HUB_FOLK);
    assert.equal(E.q(`select slug from edition_organisers where id='${o}'`), 'zz-folk-festival-society');
    assert.equal(E.q(`select reserved_name_flag from edition_organisers where id='${o}'`), 't', 'a real-event name is flagged for careful review');
  });
});

describe('the Hub\'s committee IS the authority, read live', () => {
  test('role mapping: Hub owner = owner, committee = admin, ordinary member / other Hub / business owner / stranger / anon = none', () => {
    assert.equal(role('HUB_OWNER'), 'owner'); assert.equal(role('HUB_COMMITTEE'), 'admin');
    for (const w of ['HUB_MEMBER', 'HUB2_OWNER', 'BIZ_OWNER', 'STRANGER'] as Who[]) assert.equal(role(w), 'none', w);
    assert.ok(failed(E.try('anon', `select public.edition_org_role('${ORG}')`)), 'signed-out visitors cannot even ask');
  });
  test('changes in the Hub take effect on the very next check: demote, leave, promote, owner role, Hub deactivated', () => {
    setHubRole(U.HUB_COMMITTEE, 'member'); assert.equal(role('HUB_COMMITTEE'), 'none', 'demoted');
    setHubRole(U.HUB_COMMITTEE, 'committee'); assert.equal(role('HUB_COMMITTEE'), 'admin', 'restored');
    E.sup(`update hub_members set status='left' where hub_id='${HUB}' and user_id='${U.HUB_COMMITTEE}'`); assert.equal(role('HUB_COMMITTEE'), 'none', 'left the Hub');
    setHubRole(U.HUB_COMMITTEE, 'committee');
    setHubRole(U.HUB_MEMBER, 'committee'); assert.equal(role('HUB_MEMBER'), 'admin', 'promoted'); setHubRole(U.HUB_MEMBER, 'owner'); assert.equal(role('HUB_MEMBER'), 'owner', 'made a Hub owner'); setHubRole(U.HUB_MEMBER, 'member'); assert.equal(role('HUB_MEMBER'), 'none');
    E.sup(`update hubs set is_active=false where id='${HUB}'`); assert.equal(role('HUB_OWNER'), 'none', 'a deactivated Hub holds no authority'); E.sup(`update hubs set is_active=true where id='${HUB}'`); assert.equal(role('HUB_OWNER'), 'owner');
    // (unlinking an organiser from its Hub is retired: every organiser keeps exactly one parent)
  });
  test('an explicit team role and the Hub-derived role combine: the higher wins, and explicit members keep working when the Hub changes', () => {
    E.sup(`insert into edition_organiser_members (organiser_id, user_id, role) values ('${ORG}','${U.TEAM}','editor'),('${ORG}','${U.HUB_COMMITTEE}','editor')`);
    assert.equal(role('HELPER'), 'editor'); assert.equal(role('HUB_COMMITTEE'), 'admin', 'committee (admin) beats explicit editor');
    setHubRole(U.HUB_COMMITTEE, 'member'); assert.equal(role('HUB_COMMITTEE'), 'editor', 'explicit editor remains after demotion');
    setHubRole(U.HUB_COMMITTEE, 'committee'); E.sup(`delete from edition_organiser_members where user_id='${U.HUB_COMMITTEE}' and organiser_id='${ORG}'`);
  });
  test('another Hub, a business owner or a member of an unrelated organiser holds no authority here', () => {
    assert.equal(role('STRANGER', ORG), 'none'); assert.equal(E.one('BIZ_OWNER', `select coalesce(public.edition_org_role('${ORG_PLAIN}'), 'none')`), 'owner');
    assert.equal(E.one('HUB_OWNER', `select coalesce(public.edition_org_role('${ORG_PLAIN}'), 'none')`), 'none', 'the Hub\'s authority is only over ITS organiser');
  });
});

describe('what each role can do through the existing permissions', () => {
  test('the committee builds Editions (insert, edit the profile); the Hub owner invites explicit team members; an ordinary Hub member and a stranger can do neither', () => {
    ED = draftEdition(E, 'HUB_COMMITTEE', ORG, 'zz-slippit-2027', 'ZZ Slippit 2027');
    assert.ok(ED);
    for (const w of ['HUB_MEMBER', 'STRANGER', 'HUB2_OWNER'] as Who[]) assert.ok(failed(E.try(w, `insert into public.editions (organiser_id, slug, title, summary, kind, starts_on, ends_on) values ('${ORG}','zz-nope-${w.toLowerCase()}','x','x','single_day',${d(10)},${d(10)})`)), w);
    assert.equal(E.one('HUB_COMMITTEE', `with u as (update public.edition_organisers set tagline='ZZ tag' where id='${ORG}' returning 1) select count(*) from u`), '1');
    assert.equal(E.one('HUB_MEMBER', `with u as (update public.edition_organisers set tagline='HACK' where id='${ORG}' returning 1) select count(*) from u`), '0');
    assert.match(E.try('HUB_COMMITTEE', `select public.invite_edition_member('${ORG}', 'new-person@x.invalid', 'editor')`), /owners only/, 'managing the explicit team stays with an owner (the Hub\'s owner)');
    assert.doesNotMatch(E.do('HUB_OWNER', `select public.invite_edition_member('${ORG}', 'new-person@x.invalid', 'editor')`), /ERROR/);
  });
  test('owner-only actions stay with the Hub owner: inviting helpers is refused to the committee; the committee (an admin) can submit for review and choose a package, an ordinary Hub member cannot', () => {
    assert.match(E.try('HUB_COMMITTEE', `select public.invite_edition_member('${ORG}', 'x-person@x.invalid', 'editor')`), /owners only/);
    assert.match(E.try('HUB_MEMBER', `select public.edition_create_order('${ORG}','${ED}','${E.q(`select id from edition_packages limit 1`)}','attempt-member-1')`), /only an owner or admin/);
    assert.match(E.try('HUB_COMMITTEE', `select public.edition_create_order('${ORG}','${ED}','${E.q(`select id from edition_packages limit 1`)}','attempt-committee-1')`), /payments are not switched on/, 'permitted as an admin; stopped only by the payments switch');
    assert.match(E.try('HUB_MEMBER', `select public.edition_submit_for_review('${ED}')`), /not permitted|not found|only/i);
    assert.doesNotMatch(E.do('HUB_COMMITTEE', `select public.edition_submit_for_review('${ED}')`), /ERROR/);
  });
  test('publishing needs approval and an entitlement: a Hub gets nothing free', () => {
    assert.ok(failed(E.try('HUB_COMMITTEE', `select public.edition_set_status('${ED}', 'published')`)));
    E.do('ADMIN', `select public.admin_review_edition('${ED}', 'approve', 'approved by the suite')`);
    assert.ok(failed(E.try('HUB_COMMITTEE', `select public.edition_set_status('${ED}', 'published')`)), 'approved but no entitlement');
    E.do('ADMIN', `select public.admin_grant_edition_entitlement('${ED}', 'publish', now(), now() + interval '60 days', 'ZZ hub run suite')`);
    E.do('HUB_COMMITTEE', `select public.edition_set_status('${ED}', 'published')`);
    assert.equal(E.one('anon', `select count(*) from public.editions where id='${ED}'`), '1');
  });
  test('the team list names who is on it through the Hub and who explicitly; only an organiser administrator may read it', () => {
    const t = E.one('HUB_OWNER', `select string_agg(role || ':' || via_hub::text, ',' order by role, via_hub::text) from public.edition_org_team('${ORG}')`);
    assert.match(t, /owner:true/); assert.match(t, /admin:true/); assert.match(t, /editor:false/);
    for (const w of ['HUB_MEMBER', 'STRANGER', 'HELPER'] as Who[]) assert.equal(E.one(w, `select count(*) from public.edition_org_team('${ORG}')`), '0', w);
  });
  test('the organiser\'s private contact email is readable by the Hub\'s administrators (they are its team) and nobody else, administrators of the platform through the admin function only', () => {
    E.sup(`update edition_organisers set contact_email='hub-fest@x.invalid' where id='${ORG}'`);
    assert.equal(E.one('HUB_COMMITTEE', `select public.edition_org_contact_email('${ORG}')`), 'hub-fest@x.invalid');
    for (const w of ['HUB_MEMBER', 'STRANGER', 'HUB2_OWNER'] as Who[]) assert.equal(E.one(w, `select coalesce(public.edition_org_contact_email('${ORG}'), 'none')`), 'none', w);
    assert.ok(failed(E.try('HUB_OWNER', `select contact_email from public.edition_organisers`)));
    assert.ok(failed(E.try('HUB_COMMITTEE', `select * from public.admin_edition_org_contacts()`)));
  });
});

describe('private and isolated', () => {
  test('a draft Hub-run Edition is visible to the Hub\'s administrators and platform staff only', () => {
    const ed2 = last(E.do('HUB_COMMITTEE', `insert into public.editions (organiser_id, slug, title, summary, kind, starts_on, ends_on) values ('${ORG}','zz-slippit-draft','ZZ Draft','x','single_day',${d(20)},${d(20)}) returning id`));
    for (const w of ['HUB_OWNER', 'HUB_COMMITTEE', 'ADMIN'] as Who[]) assert.equal(E.one(w, `select count(*) from public.editions where id='${ed2}'`), '1', w);
    for (const w of ['HUB_MEMBER', 'HUB2_OWNER', 'BIZ_OWNER', 'STRANGER', 'anon'] as Who[]) assert.equal(E.one(w, `select count(*) from public.editions where id='${ed2}'`), '0', w);
    setHubRole(U.HUB_COMMITTEE, 'member'); assert.equal(E.one('HUB_COMMITTEE', `select count(*) from public.editions where id='${ed2}'`), '0', 'a demoted committee member loses sight of it at once'); setHubRole(U.HUB_COMMITTEE, 'committee');
  });
  test('another Hub\'s administrators see and change nothing here; the organiser audit trail is not theirs', () => {
    assert.equal(E.one('HUB2_OWNER', `select count(*) from public.edition_organisers where id='${ORG}'`), E.one('anon', `select count(*) from public.edition_organisers where id='${ORG}'`), 'only what the public can see');
    assert.equal(E.one('HUB2_OWNER', `select count(*) from public.edition_audit_log where organiser_id='${ORG}'`), '0', 'not this organiser\'s trail (their own Hub\'s organisers are theirs)');
    assert.equal(E.one('HUB2_OWNER', `with u as (update public.editions set title='HACK' where id='${ED}' returning 1) select count(*) from u`), '0');
    assert.equal(E.one('HUB_OWNER', `select count(*) from public.edition_audit_log where organiser_id='${ORG}'`) !== '0', true, 'the Hub\'s owner reads its own organiser\'s trail');
  });
  test('the Hub branding the Edition inherits is public Hub data only: logo, colour, name, description, area readable by anyone; owner and members never', () => {
    assert.equal(E.one('anon', `select logo_url || '|' || brand_color from public.hubs where id='${HUB}'`), 'https://x.example/logo.png|#7a3b8f');
    assert.ok(failed(E.try('anon', `select owner_id from public.hubs where id='${HUB}'`)));
    assert.equal(E.one('anon', `select count(*) from public.hub_members`) === '0' || failed(E.try('anon', `select * from public.hub_members`)), true);
  });
});

describe('the Hub administrator\'s own entry points', () => {
  test('my organisers: the Hub\'s owner and committee get it, with the derived role; members, other Hubs and strangers get nothing; explicit team members get theirs', () => {
    assert.equal(E.one('HUB_OWNER', `select role || ':' || via_hub::text from public.edition_my_organisers() where organiser_id='${ORG}'`), 'owner:true');
    assert.equal(E.one('HUB_COMMITTEE', `select role || ':' || via_hub::text from public.edition_my_organisers() where organiser_id='${ORG}'`), 'admin:true');
    assert.equal(E.one('HELPER', `select role || ':' || via_hub::text from public.edition_my_organisers() where organiser_id='${ORG}'`), 'editor:false');
    for (const w of ['HUB_MEMBER', 'HUB2_OWNER', 'BIZ_OWNER'] as Who[]) assert.equal(E.one(w, `select count(*) from public.edition_my_organisers() where organiser_id='${ORG}'`), '0', w);
    assert.equal(E.one('HUB_OWNER', `select public.edition_has_organiser_access()`), 't'); assert.equal(E.one('BIZ_OWNER', `select public.edition_has_organiser_access()`), 't', 'a Business owner has the same access to a Business-run organiser'); assert.equal(E.one('STRANGER', `select public.edition_has_organiser_access()`), 'f');
  });
  test('my Hubs: the Hubs a person runs, with where each stands; never a Hub they merely belong to', () => {
    assert.equal(E.one('HUB_OWNER', `select hub_role || ':' || coalesce(organiser_slug,'-') || ':' || edition_count from public.edition_my_hubs() where hub_id='${HUB}'`), 'owner:zz-test-hub:2');
    assert.equal(E.one('HUB_COMMITTEE', `select hub_role from public.edition_my_hubs() where hub_id='${HUB}'`), 'committee');
    assert.equal(E.one('HUB_COMMITTEE', `select count(*) from public.edition_my_hubs() where hub_id='${HUB_ADMIN}'`), '1');
    assert.equal(E.one('HUB_MEMBER', `select count(*) from public.edition_my_hubs()`), '0'); assert.equal(E.one('BIZ_OWNER', `select count(*) from public.edition_my_hubs()`), '0'); assert.ok(failed(E.try('anon', `select * from public.edition_my_hubs()`)));
  });
});

describe('uploads follow the same authority', () => {
  test('the Hub\'s administrators can upload to the organiser\'s media folder; members, strangers and other organisers\' folders are refused', () => {
    // The storage policies' own predicate (the isolated stand-in has no object grants, so the predicate is evaluated directly as each person; the post-check pins the policy text)
    const may = (w: Who, folder: string) => E.one(w, `select exists (select 1 from public.edition_organisers o where o.id::text = split_part('${folder}/hero.png', '/', 1) and public.edition_org_can(o.id, 'editor'))`);
    assert.equal(may('HUB_COMMITTEE', ORG), 't'); assert.equal(may('HUB_OWNER', ORG), 't');
    for (const w of ['HUB_MEMBER', 'STRANGER', 'HUB2_OWNER'] as Who[]) assert.equal(may(w, ORG), 'f', w);
    assert.equal(may('HUB_OWNER', ORG_PLAIN), 'f', 'not another organiser\'s folder');
    setHubRole(U.HUB_COMMITTEE, 'member'); assert.equal(may('HUB_COMMITTEE', ORG), 'f', 'a demoted committee member can no longer upload'); setHubRole(U.HUB_COMMITTEE, 'committee');
    assert.equal(E.q(`select count(*) from pg_policies where schemaname='storage' and tablename='objects' and policyname like 'edition-media member%' and coalesce(qual,'')||coalesce(with_check,'') like '%edition_org_can%'`), '3');
  });
});

describe('notifications and account deletion', () => {
  test('organiser-side notices (requests, answers) reach the Hub\'s owner and active committee as well as explicit admins', () => {
    const got = E.q(`select string_agg(u::text, ',' order by u::text) from public.edition_org_admin_users('${ORG}') u`);
    assert.equal(got, [U.HUB_OWNER, U.HUB_COMMITTEE].sort().join(','));
    setHubRole(U.HUB_COMMITTEE, 'member'); assert.doesNotMatch(E.q(`select string_agg(u::text, ',') from public.edition_org_admin_users('${ORG}') u`), new RegExp(U.HUB_COMMITTEE)); setHubRole(U.HUB_COMMITTEE, 'committee');
  });
  test('deleting an account: a sole-owner refusal can no longer arise (a helper can never be an owner), and Hub-run or Business-run organisers never block: the parent always has authority', () => {
    // (the old "sole owner of an organiser" refusal is retired by design: ownership always comes from the Hub or Business)
    E.sup(`insert into edition_organiser_members (organiser_id, user_id, role) values ('${ORG}','${U.TEAM}','editor') on conflict (organiser_id, user_id) do update set role='editor'`);
    assert.doesNotMatch(E.sup(`select public.delete_member_editions('${U.TEAM}')`), /ERROR/);
    assert.equal(E.q(`select count(*) from edition_organiser_members where user_id='${U.TEAM}'`), '0');
    assert.doesNotMatch(E.sup(`select public.delete_member_editions('${U.HUB_OWNER}')`), /ERROR/, 'a Hub owner with no explicit rows deletes cleanly');
    assert.doesNotMatch(E.sup(`select public.delete_member_editions('${U.BIZ}')`), /ERROR/, 'so does a Business owner');
    assert.equal(E.q(`select count(*) from edition_organisers where id in ('${ORG}','${ORG_PLAIN}')`), '2', 'the organisers and their Editions stay with their parents');
  });
});

describe('no existing behaviour changed', () => {
  test('a Business-run organiser: its owner is the only authority, and the Hub\'s people hold none over it', () => {
    assert.equal(E.one('BIZ_OWNER', `select public.edition_org_role('${ORG_PLAIN}')`), 'owner');
    for (const w of ['HUB_OWNER', 'HUB_COMMITTEE', 'STRANGER'] as Who[]) assert.equal(E.one(w, `select coalesce(public.edition_org_role('${ORG_PLAIN}'), 'none')`), 'none', w);
  });
  test('no column was added to any Hub or hub_members table and the Hub tables\' policies are untouched', () => {
    assert.equal(E.q(`select count(*) from information_schema.columns where table_schema='public' and table_name in ('hubs','hub_members') and column_name like '%edition%'`), '0');
    assert.equal(E.q(`select count(*) from pg_policies where tablename in ('hubs','hub_members') and (qual ilike '%edition%' or with_check ilike '%edition%')`), '0');
  });
});
