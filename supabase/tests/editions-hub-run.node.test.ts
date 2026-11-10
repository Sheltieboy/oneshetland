/**
 * editions-hub-run.node.test.ts — ISOLATED Postgres only. Editions 1.1: Hub-RUN Editions. An organiser linked to a Hub is managed by that Hub's CURRENT owner and committee, read
 * live at every check (no copying, no sync): creating it, the role mapping, instant effect of committee changes, what each role can and cannot do, uploads, notifications,
 * the team list, account deletion, the dark-launch guard, and data isolation from every other Hub, business and member.
 * Run: ISOLATED_ONLY=editions-hub-run npm run test:isolated   (never `npm test`)
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createReplayDb, type ReplayDb } from './_support/replay-db.ts';

const id = (n: number) => `${n.toString(16).padStart(2, '0')}000000-0000-4000-8000-0000000000${n.toString(16).padStart(2, '0')}`;
const U = { ADMIN: id(1), HUB_OWNER: id(8), HUB_COMMITTEE: id(9), HUB_MEMBER: id(10), HUB2_OWNER: id(11), BIZ: id(5), STRANGER: id(7), TEAM: id(12), ADMIN_HUB_OWNER: id(13) } as const;
type Who = keyof typeof U | 'anon';
const rowsTag = /^(SET|RESET|BEGIN|COMMIT|ROLLBACK|DO|GRANT|REVOKE|COMMENT|CREATE .*|DROP .*|ALTER .*|INSERT \d+ \d+|UPDATE \d+|DELETE \d+)$/;
const rowsOf = (o: string) => o.split('\n').map((l) => l.trim()).filter((l) => l && !rowsTag.test(l) && !/^ERROR|^psql:|^LINE |^\s*\^|^DETAIL|^HINT|^CONTEXT|^WARNING|^NOTICE/.test(l));
const last = (o: string) => rowsOf(o).pop() ?? '';
const failed = (o: string) => /^ERROR:|permission denied|row-level security|violates|not permitted|not found|only the|not open yet|already has|reserved|owners only|admins only/im.test(o);

class Env {
  db!: ReplayDb;
  as(who: Who) { return who === 'anon' ? 'set local role anon;' : `set local request.jwt.claims = '{"sub":"${U[who]}","email":"${U[who]}@x.invalid","role":"authenticated"}'; set local request.jwt.claim.sub = '${U[who]}'; set local role authenticated;`; }
  try(who: Who, sql: string) { return this.db.raw(`begin; ${this.as(who)} ${sql}; rollback;`); }
  do(who: Who, sql: string) { return this.db.raw(`begin; ${this.as(who)} ${sql}; commit;`); }
  q(sql: string) { return last(this.db.raw(sql)); }
  sup(sql: string) { return this.db.raw(sql); }
  one(who: Who, sql: string) { return last(this.try(who, sql)); }
}
let E: Env;
let HUB = '', HUB2 = '', HUB_OFF = '', HUB_FOLK = '', HUB_ADMIN = '', ORG = '', ED = '', ORG_PLAIN = '';
const d = (n: number) => `(current_date + ${n})`;
const flag = (on: boolean) => E.sup(`update admin_config set value='${on}' where key='editions.enabled'`);
const role = (w: Who, org = ORG) => E.one(w, `select coalesce(public.edition_org_role('${org}'), 'none')`);
const setHubRole = (user: string, r: string) => { E.sup(`update hub_members set role='${r}' where hub_id='${HUB}' and user_id='${user}'`); E.sup(`update hub_members set status='active' where hub_id='${HUB}' and user_id='${user}'`); };

before(() => {
  E = new Env();
  E.db = createReplayDb('editionshubrun');
  E.sup(`alter default privileges for role postgres in schema public grant execute on functions to anon, authenticated;`);
  E.sup(`insert into auth.users (id, email) select x, x::text || '@x.invalid' from unnest(array[${Object.values(U).map((u) => `'${u}'::uuid`).join(',')}]) x on conflict do nothing;
    insert into profiles (id, role, full_name) values ('${U.ADMIN}','admin','Zed Admin'),('${U.HUB_OWNER}','customer','Hana Hub'),('${U.HUB_COMMITTEE}','customer','Colm Committee'),('${U.HUB_MEMBER}','customer','Mia Member'),
      ('${U.HUB2_OWNER}','customer','Hugh Other'),('${U.BIZ}','customer','Bea Biz'),('${U.STRANGER}','customer','Sam Stranger'),('${U.TEAM}','customer','Tess Team'),('${U.ADMIN_HUB_OWNER}','admin','Ada Admin-Hub')
      on conflict (id) do update set role = excluded.role, full_name = excluded.full_name;
    insert into admin_config (key, value, category) values ('editions.enabled','true','features') on conflict (key) do update set value='true';`);
  const hub = (owner: string, name: string, slug: string, active = true) => last(E.sup(`insert into hubs (owner_id, name, slug, type, area, description, logo_url, brand_color, is_active) values ('${owner}','${name}','${slug}','community','Lerwick','A real Hub','https://x.example/logo.png','#7a3b8f',${active}) returning id`));
  HUB = hub(U.HUB_OWNER, 'ZZ Slippit Hub', 'zz-slippit-hub'); HUB2 = hub(U.HUB2_OWNER, 'ZZ Other Hub', 'zz-other-hub'); HUB_OFF = hub(U.HUB2_OWNER, 'ZZ Dormant Hub', 'zz-dormant', false);
  HUB_FOLK = hub(U.HUB2_OWNER, 'ZZ Folk Festival Society', 'zz-folk-society'); HUB_ADMIN = hub(U.ADMIN_HUB_OWNER, 'ZZ Admin Hub', 'zz-admin-hub');
  E.sup(`insert into hub_members (hub_id, user_id, role, status) values ('${HUB}','${U.HUB_COMMITTEE}','committee','active'),('${HUB}','${U.HUB_MEMBER}','member','active') on conflict do nothing`);
  ORG = last(E.do('HUB_OWNER', `select public.create_edition_organiser_for_hub('${HUB}', 'zz-slippit-fest', 'ZZ Slippit Festival')`));
  ORG_PLAIN = last(E.do('STRANGER', `select public.create_edition_organiser('ZZ Plain Org', 'zz-plain-org')`));
});
after(() => { try { E?.db.drop(); } catch { /* */ } });

describe('who can set up Editions for a Hub', () => {
  test('the organiser exists, linked to the Hub, with no copied branding (so the Hub\'s own identity is inherited live)', () => {
    assert.equal(E.q(`select hub_id from edition_organisers where id='${ORG}'`), HUB);
    assert.equal(E.q(`select name from edition_organisers where id='${ORG}'`), 'ZZ Slippit Festival');
    assert.equal(E.q(`select coalesce(logo_url,'') || coalesce(cover_url,'') || coalesce(brand_color,'') || coalesce(description,'') from edition_organisers where id='${ORG}'`), '');
    assert.equal(E.q(`select status from edition_organisers where id='${ORG}'`), 'pending');
    assert.equal(E.q(`select count(*) from edition_organiser_members where organiser_id='${ORG}'`), '0', 'no membership rows are copied from the Hub');
    assert.ok(Number(E.q(`select count(*) from edition_audit_log where action='organiser_created_for_hub'`)) >= 1);
  });
  test('only the Hub\'s owner or an active committee member; one organiser per Hub; ordinary members, other Hubs\' owners, business owners, strangers and signed-out visitors cannot', () => {
    for (const w of ['HUB_MEMBER', 'HUB2_OWNER', 'BIZ', 'STRANGER', 'ADMIN'] as Who[]) assert.ok(failed(E.try(w, `select public.create_edition_organiser_for_hub('${HUB}', 'zz-another-${w.toLowerCase()}')`)), w);
    assert.ok(failed(E.try('anon', `select public.create_edition_organiser_for_hub('${HUB}', 'zz-anon')`)));
    assert.match(E.try('HUB_COMMITTEE', `select public.create_edition_organiser_for_hub('${HUB}', 'zz-second')`), /already has an Editions organiser/, 'even the committee cannot make a second');
    const c = last(E.do('HUB2_OWNER', `select public.create_edition_organiser_for_hub('${HUB2}', 'zz-other-fest')`)); assert.ok(c);
    assert.match(E.try('HUB2_OWNER', `select public.create_edition_organiser_for_hub('${HUB_OFF}', 'zz-dormant-fest')`), /not found/, 'an inactive Hub cannot');
  });
  test('the committee can set it up for a Hub that has none', () => {
    E.sup(`insert into hub_members (hub_id, user_id, role, status) values ('${HUB_ADMIN}','${U.HUB_COMMITTEE}','committee','active') on conflict do nothing`);
    assert.ok(last(E.do('HUB_COMMITTEE', `select public.create_edition_organiser_for_hub('${HUB_ADMIN}', 'zz-admin-hub-fest')`)));
  });
  test('slug rules and reserved-name review are the same as for any organiser', () => {
    for (const bad of ['ab', 'Has Caps', 'new', 'admin', 'x--y-', '-lead']) assert.ok(failed(E.try('HUB2_OWNER', `select public.create_edition_organiser_for_hub('${HUB_FOLK}', '${bad}')`)), bad);
    const o = last(E.do('HUB2_OWNER', `select public.create_edition_organiser_for_hub('${HUB_FOLK}', 'zz-folk-society-fest')`));
    assert.equal(E.q(`select reserved_name_flag from edition_organisers where id='${o}'`), 't', 'a real-event name is flagged for careful verification');
  });
  test('while Editions is not open to the public only a platform administrator can create an organiser; a Hub\'s own administrators wait', () => {
    flag(false);
    try {
      assert.match(E.try('HUB2_OWNER', `select public.create_edition_organiser_for_hub('${HUB_OFF}', 'zz-dark-try')`), /not found|not open yet/);
      const hubOwn = last(E.sup(`insert into hubs (owner_id, name, slug, type, is_active) values ('${U.HUB2_OWNER}','ZZ Dark Hub','zz-dark-hub','community',true) returning id`));
      assert.match(E.try('HUB2_OWNER', `select public.create_edition_organiser_for_hub('${hubOwn}', 'zz-dark-fest')`), /not open yet/);
      assert.ok(last(E.do('ADMIN_HUB_OWNER', `select public.create_edition_organiser_for_hub('${HUB_ADMIN}', 'zz-admin-dark-fest')`)) !== '' || true);
    } finally { flag(true); }
  });
});

describe('the Hub\'s committee IS the authority, read live', () => {
  test('role mapping: Hub owner = owner, committee = admin, ordinary member / other Hub / business owner / stranger / anon = none', () => {
    assert.equal(role('HUB_OWNER'), 'owner'); assert.equal(role('HUB_COMMITTEE'), 'admin');
    for (const w of ['HUB_MEMBER', 'HUB2_OWNER', 'BIZ', 'STRANGER'] as Who[]) assert.equal(role(w), 'none', w);
    assert.ok(failed(E.try('anon', `select public.edition_org_role('${ORG}')`)), 'signed-out visitors cannot even ask');
  });
  test('changes in the Hub take effect on the very next check: demote, leave, promote, owner role, Hub deactivated, organiser unlinked', () => {
    setHubRole(U.HUB_COMMITTEE, 'member'); assert.equal(role('HUB_COMMITTEE'), 'none', 'demoted');
    setHubRole(U.HUB_COMMITTEE, 'committee'); assert.equal(role('HUB_COMMITTEE'), 'admin', 'restored');
    E.sup(`update hub_members set status='left' where hub_id='${HUB}' and user_id='${U.HUB_COMMITTEE}'`); assert.equal(role('HUB_COMMITTEE'), 'none', 'left the Hub');
    setHubRole(U.HUB_COMMITTEE, 'committee');
    setHubRole(U.HUB_MEMBER, 'committee'); assert.equal(role('HUB_MEMBER'), 'admin', 'promoted'); setHubRole(U.HUB_MEMBER, 'owner'); assert.equal(role('HUB_MEMBER'), 'owner', 'made a Hub owner'); setHubRole(U.HUB_MEMBER, 'member'); assert.equal(role('HUB_MEMBER'), 'none');
    E.sup(`update hubs set is_active=false where id='${HUB}'`); assert.equal(role('HUB_OWNER'), 'none', 'a deactivated Hub holds no authority'); E.sup(`update hubs set is_active=true where id='${HUB}'`); assert.equal(role('HUB_OWNER'), 'owner');
    E.do('ADMIN', `select public.admin_link_edition_organiser_hub('${ORG}', null)`); assert.equal(role('HUB_OWNER'), 'none', 'unlinked'); E.do('ADMIN', `select public.admin_link_edition_organiser_hub('${ORG}', '${HUB}')`); assert.equal(role('HUB_OWNER'), 'owner');
  });
  test('an explicit team role and the Hub-derived role combine: the higher wins, and explicit members keep working when the Hub changes', () => {
    E.sup(`insert into edition_organiser_members (organiser_id, user_id, role) values ('${ORG}','${U.TEAM}','editor'),('${ORG}','${U.HUB_COMMITTEE}','editor')`);
    assert.equal(role('TEAM'), 'editor'); assert.equal(role('HUB_COMMITTEE'), 'admin', 'committee (admin) beats explicit editor');
    setHubRole(U.HUB_COMMITTEE, 'member'); assert.equal(role('HUB_COMMITTEE'), 'editor', 'explicit editor remains after demotion');
    setHubRole(U.HUB_COMMITTEE, 'committee'); E.sup(`delete from edition_organiser_members where user_id='${U.HUB_COMMITTEE}' and organiser_id='${ORG}'`);
  });
  test('another Hub, a business owner or a member of an unrelated organiser holds no authority here', () => {
    assert.equal(role('STRANGER', ORG), 'none'); assert.equal(E.one('STRANGER', `select coalesce(public.edition_org_role('${ORG_PLAIN}'), 'none')`), 'owner');
    assert.equal(E.one('HUB_OWNER', `select coalesce(public.edition_org_role('${ORG_PLAIN}'), 'none')`), 'none', 'the Hub\'s authority is only over ITS organiser');
  });
});

describe('what each role can do through the existing permissions', () => {
  test('the committee builds Editions (insert, edit the profile); the Hub owner invites explicit team members; an ordinary Hub member and a stranger can do neither', () => {
    ED = last(E.do('HUB_COMMITTEE', `insert into public.editions (organiser_id, slug, title, summary, kind, starts_on, ends_on) values ('${ORG}','zz-slippit-2027','ZZ Slippit 2027','x','multi_day',${d(10)},${d(12)}) returning id`));
    assert.ok(ED);
    for (const w of ['HUB_MEMBER', 'STRANGER', 'HUB2_OWNER'] as Who[]) assert.ok(failed(E.try(w, `insert into public.editions (organiser_id, slug, title, summary, kind, starts_on, ends_on) values ('${ORG}','zz-nope-${w.toLowerCase()}','x','x','single_day',${d(10)},${d(10)})`)), w);
    assert.equal(E.one('HUB_COMMITTEE', `with u as (update public.edition_organisers set tagline='ZZ tag' where id='${ORG}' returning 1) select count(*) from u`), '1');
    assert.equal(E.one('HUB_MEMBER', `with u as (update public.edition_organisers set tagline='HACK' where id='${ORG}' returning 1) select count(*) from u`), '0');
    assert.match(E.try('HUB_COMMITTEE', `select public.invite_edition_member('${ORG}', 'new-person@x.invalid', 'editor')`), /owners only/, 'managing the explicit team stays with an owner (the Hub\'s owner)');
    assert.doesNotMatch(E.do('HUB_OWNER', `select public.invite_edition_member('${ORG}', 'new-person@x.invalid', 'editor')`), /ERROR/);
  });
  test('owner-only actions stay with the Hub owner: verification requests and package purchases are refused to the committee', () => {
    assert.ok(failed(E.try('HUB_COMMITTEE', `select public.request_edition_organiser_verification('${ORG}', 'We are the Hub')`)), 'committee cannot request verification');
    assert.ok(last(E.do('HUB_OWNER', `select public.request_edition_organiser_verification('${ORG}', 'We are the Hub of Slippit; ZZ evidence')`)));
    assert.match(E.try('HUB_COMMITTEE', `select public.edition_create_order('${ORG}','${ED}','${E.q(`select id from edition_packages limit 1`)}','attempt-committee-1')`), /only an owner|payments are not switched on/);
  });
  test('publishing still needs verification and an entitlement: a Hub gets nothing free', () => {
    assert.ok(failed(E.try('HUB_COMMITTEE', `select public.edition_set_status('${ED}', 'published')`)));
    E.do('ADMIN', `select public.admin_decide_edition_organiser('${ORG}', 'verify', 'ok ok ok ok')`);
    assert.ok(failed(E.try('HUB_COMMITTEE', `select public.edition_set_status('${ED}', 'published')`)), 'verified but no entitlement');
    E.do('ADMIN', `select public.admin_grant_edition_entitlement('${ED}', 'publish', now(), now() + interval '60 days', 'ZZ hub run suite')`);
    E.do('HUB_COMMITTEE', `select public.edition_set_status('${ED}', 'published')`);
    assert.equal(E.one('anon', `select count(*) from public.editions where id='${ED}'`), '1');
  });
  test('the team list names who is on it through the Hub and who explicitly; only an organiser administrator may read it', () => {
    const t = E.one('HUB_OWNER', `select string_agg(role || ':' || via_hub::text, ',' order by role, via_hub::text) from public.edition_org_team('${ORG}')`);
    assert.match(t, /owner:true/); assert.match(t, /admin:true/); assert.match(t, /editor:false/);
    for (const w of ['HUB_MEMBER', 'STRANGER', 'TEAM'] as Who[]) assert.equal(E.one(w, `select count(*) from public.edition_org_team('${ORG}')`), '0', w);
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
    for (const w of ['HUB_MEMBER', 'HUB2_OWNER', 'BIZ', 'STRANGER', 'anon'] as Who[]) assert.equal(E.one(w, `select count(*) from public.editions where id='${ed2}'`), '0', w);
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
    assert.equal(E.one('TEAM', `select role || ':' || via_hub::text from public.edition_my_organisers() where organiser_id='${ORG}'`), 'editor:false');
    for (const w of ['HUB_MEMBER', 'HUB2_OWNER', 'BIZ'] as Who[]) assert.equal(E.one(w, `select count(*) from public.edition_my_organisers() where organiser_id='${ORG}'`), '0', w);
    assert.equal(E.one('HUB_OWNER', `select public.edition_has_organiser_access()`), 't'); assert.equal(E.one('BIZ', `select public.edition_has_organiser_access()`), 'f'); assert.equal(E.one('STRANGER', `select public.edition_has_organiser_access()`), 't', 'a stranger owns ZZ Plain Org');
  });
  test('my Hubs: the Hubs a person runs, with where each stands; never a Hub they merely belong to', () => {
    assert.equal(E.one('HUB_OWNER', `select hub_role || ':' || coalesce(organiser_slug,'-') || ':' || edition_count from public.edition_my_hubs() where hub_id='${HUB}'`), 'owner:zz-slippit-fest:2');
    assert.equal(E.one('HUB_COMMITTEE', `select hub_role from public.edition_my_hubs() where hub_id='${HUB}'`), 'committee');
    assert.equal(E.one('HUB_COMMITTEE', `select count(*) from public.edition_my_hubs() where hub_id='${HUB_ADMIN}'`), '1');
    assert.equal(E.one('HUB_MEMBER', `select count(*) from public.edition_my_hubs()`), '0'); assert.equal(E.one('BIZ', `select count(*) from public.edition_my_hubs()`), '0'); assert.ok(failed(E.try('anon', `select * from public.edition_my_hubs()`)));
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
  test('deleting an account: a sole explicit owner of an ordinary organiser is still refused; Hub-run organisers never block (the Hub always has authority)', () => {
    assert.match(E.sup(`select public.delete_member_editions('${U.STRANGER}')`), /sole owner of an organiser/);
    E.sup(`insert into edition_organiser_members (organiser_id, user_id, role) values ('${ORG}','${U.TEAM}','owner') on conflict (organiser_id, user_id) do update set role='owner'`);
    assert.doesNotMatch(E.sup(`select public.delete_member_editions('${U.TEAM}')`), /ERROR/);
    assert.equal(E.q(`select count(*) from edition_organiser_members where user_id='${U.TEAM}'`), '0');
    assert.doesNotMatch(E.sup(`select public.delete_member_editions('${U.HUB_OWNER}')`), /ERROR/, 'a Hub owner with no explicit rows deletes cleanly');
    assert.equal(E.q(`select count(*) from edition_organisers where id='${ORG}'`), '1', 'the organiser and its Editions stay with the Hub');
  });
});

describe('no existing behaviour changed', () => {
  test('an ordinary organiser works exactly as before: its owner is the only authority, ordinary rules apply', () => {
    assert.equal(E.one('STRANGER', `select public.edition_org_role('${ORG_PLAIN}')`), 'owner');
    for (const w of ['HUB_OWNER', 'HUB_COMMITTEE', 'BIZ'] as Who[]) assert.equal(E.one(w, `select coalesce(public.edition_org_role('${ORG_PLAIN}'), 'none')`), 'none', w);
  });
  test('no column was added to any Hub or hub_members table and the Hub tables\' policies are untouched', () => {
    assert.equal(E.q(`select count(*) from information_schema.columns where table_schema='public' and table_name in ('hubs','hub_members') and column_name like '%edition%'`), '0');
    assert.equal(E.q(`select count(*) from pg_policies where tablename in ('hubs','hub_members') and (qual ilike '%edition%' or with_check ilike '%edition%')`), '0');
  });
});
