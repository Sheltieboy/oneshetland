/**
 * editions-pilot.node.test.ts — ISOLATED Postgres only. The controlled Editions pilot: a per-organiser, administrator-only approval that makes ONE organiser's published, entitled Editions
 * public while editions.enabled stays off for everyone else. Proves scoping, the Hub-verification rule, 90-day renewable grants, closed registration, payments off, instant removal on every
 * withdrawal route, admin-only audited controls, and that no other privacy rule moved.
 * Run: ISOLATED_ONLY=editions-pilot npm run test:isolated   (never `npm test`)
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createReplayDb, type ReplayDb } from './_support/replay-db.ts';

const id = (n: number) => `${n.toString(16).padStart(2, '0')}000000-0000-4000-8000-0000000000${n.toString(16).padStart(2, '0')}`;
const U = { ADMIN: id(1), HUB_OWNER: id(8), HUB_COMMITTEE: id(9), HUB_MEMBER: id(10), HUB2_OWNER: id(11), STRANGER: id(7), BIZ: id(5) } as const;
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
let HUB = '', HUB_B = '', ORG = '', ORG_B = '', ORG_PLAIN = '', ED = '', ED_B = '', ED_DRAFT = '', ORG_TEST = '';
const d = (n: number) => `(current_date + ${n})`;
const pilot = (on: boolean) => E.do('ADMIN', `select public.admin_set_editions_pilot(${on}, 'suite')`);
const pubEd = (ed = ED) => E.one('anon', `select public.edition_is_public('${ed}')`) === 't';
const seesEd = (ed = ED) => E.one('anon', `select count(*) from public.editions where id='${ed}'`) === '1';
const seesOrg = (org = ORG) => E.one('anon', `select count(*) from public.edition_organisers where id='${org}'`) === '1';
const seesPage = (ed = ED) => E.one('anon', `select count(*) from public.edition_pages where edition_id='${ed}'`) === '1';
const approve = (org = ORG) => E.do('ADMIN', `select public.admin_approve_edition_pilot('${org}', 'approved for the pilot')`);
const revoke = (org = ORG) => E.do('ADMIN', `select public.admin_revoke_edition_pilot('${org}', 'withdrawn in the suite')`);

before(() => {
  E = new Env();
  E.db = createReplayDb('editionspilot');
  E.sup(`alter default privileges for role postgres in schema public grant execute on functions to anon, authenticated;`);
  E.sup(`insert into auth.users (id, email) select x, x::text || '@x.invalid' from unnest(array[${Object.values(U).map((u) => `'${u}'::uuid`).join(',')}]) x on conflict do nothing;
    insert into profiles (id, role, full_name) values ('${U.ADMIN}','admin','Zed Admin'),('${U.HUB_OWNER}','customer','Hana Hub'),('${U.HUB_COMMITTEE}','customer','Colm Committee'),('${U.HUB_MEMBER}','customer','Mia Member'),
      ('${U.HUB2_OWNER}','customer','Hugh Other'),('${U.STRANGER}','customer','Sam Stranger'),('${U.BIZ}','customer','Bea Biz')
      on conflict (id) do update set role = excluded.role, full_name = excluded.full_name;`);
  // NOTE: editions.enabled is deliberately NEVER set in this suite. It stays absent (off) throughout, except in the one test that proves open mode still works.
  const hub = (owner: string, name: string, slug: string, active = true) => last(E.sup(`insert into hubs (owner_id, name, slug, type, area, description, logo_url, brand_color, is_active) values ('${owner}','${name}','${slug}','community','Lerwick','A real Hub','https://x.example/logo.png','#7a3b8f',${active}) returning id`));
  HUB = hub(U.HUB_OWNER, 'ZZ Pilot Hub', 'zz-pilot-hub'); HUB_B = hub(U.HUB2_OWNER, 'ZZ Other Hub', 'zz-other-hub');
  E.sup(`insert into hub_members (hub_id, user_id, role, status) values ('${HUB}','${U.HUB_COMMITTEE}','committee','active'),('${HUB}','${U.HUB_MEMBER}','member','active') on conflict do nothing`);
  // administrator sets up both Hubs' organisers (the only way while dark); Hub B stays UNAPPROVED throughout, as the scoping control
  ORG = last(E.do('ADMIN', `select public.admin_create_edition_organiser_for_hub('${HUB}', 'zz-pilot-fest', 'ZZ Pilot Festival', 'setup for the suite')`));
  ORG_B = last(E.do('ADMIN', `select public.admin_create_edition_organiser_for_hub('${HUB_B}', 'zz-other-fest', 'ZZ Other Festival', 'setup for the suite')`));
  ORG_PLAIN = last(E.do('ADMIN', `select public.create_edition_organiser('ZZ Plain Org', 'zz-plain-org')`));
  E.do('ADMIN', `select public.admin_decide_edition_organiser('${ORG_PLAIN}', 'verify', 'checked by hand')`);
  ED = last(E.do('HUB_COMMITTEE', `insert into public.editions (organiser_id, slug, title, summary, kind, starts_on, ends_on) values ('${ORG}','zz-pilot-2027','ZZ Pilot 2027','x','multi_day',${d(10)},${d(12)}) returning id`));
  ED_DRAFT = last(E.do('HUB_COMMITTEE', `insert into public.editions (organiser_id, slug, title, summary, kind, starts_on, ends_on) values ('${ORG}','zz-pilot-draft','ZZ Draft','x','single_day',${d(30)},${d(30)}) returning id`));
  ED_B = last(E.sup(`insert into public.editions (organiser_id, slug, title, summary, kind, starts_on, ends_on) values ('${ORG_B}','zz-other-2027','ZZ Other 2027','x','multi_day',${d(10)},${d(12)}) returning id`));
  E.sup(`insert into public.edition_pages (edition_id, slug, nav_label, title, body, position, in_nav, is_home) values ('${ED}','about','About','About','x',0,true,true),('${ED_B}','about','About','About','x',0,true,true)`);
  // BOTH published editions hold an administrator's ordinary publish grant (the generic tool): a grant alone must never make anything public in the pilot
  for (const e of [ED, ED_B]) E.do('ADMIN', `select public.admin_grant_edition_entitlement('${e}', 'publish', now(), now() + interval '90 days', 'ZZ generic grant')`);
  E.sup(`update public.editions set status='published', published_at=now() where id in ('${ED}','${ED_B}')`);
});
after(() => { try { E?.db.drop(); } catch { /* */ } });

describe('the pilot switch alone exposes nothing', () => {
  test('fresh: both switches absent, nothing public, payments off', () => {
    assert.equal(E.q(`select public.editions_enabled()`), 'f'); assert.equal(E.q(`select public.editions_pilot()`), 'f');
    assert.equal(E.q(`select public.edition_commerce_enabled()`), 'f');
    assert.equal(pubEd(), false); assert.equal(seesEd(), false); assert.equal(seesOrg(), false);
  });
  test('switch ON, no approval anywhere: a published, verified, entitled Edition is STILL invisible (scoping)', () => {
    pilot(true);
    assert.equal(E.q(`select public.editions_pilot()`), 't');
    for (const [e, o] of [[ED, ORG], [ED_B, ORG_B]] as const) { assert.equal(pubEd(e), false); assert.equal(seesEd(e), false); assert.equal(seesOrg(o), false); assert.equal(seesPage(e), false); }
    assert.equal(E.q(`select public.editions_enabled()`), 'f', 'the pilot switch never flips the open flag');
  });
  test('fail closed: a malformed or empty value means off', () => {
    for (const v of ['yes', '1', '', 'TRUEISH']) { E.sup(`update admin_config set value='${v}' where key='editions.pilot'`); assert.equal(E.q(`select public.editions_pilot()`), 'f', v); }
    E.sup(`update admin_config set value=' TRUE ' where key='editions.pilot'`); assert.equal(E.q(`select public.editions_pilot()`), 't', 'case and spaces are tolerated, like editions.enabled');
    E.sup(`delete from admin_config where key='editions.pilot'`); assert.equal(E.q(`select public.editions_pilot()`), 'f'); pilot(true);
  });
});

describe('approving: administrators only, one organiser at a time, Hub must be verified', () => {
  test('nobody but an administrator can approve, revoke, switch or set up', () => {
    for (const w of ['HUB_OWNER', 'HUB_COMMITTEE', 'HUB_MEMBER', 'STRANGER', 'BIZ', 'anon'] as Who[]) {
      assert.ok(failed(E.try(w, `select public.admin_approve_edition_pilot('${ORG}', 'trying it on')`)), `approve ${w}`);
      assert.ok(failed(E.try(w, `select public.admin_revoke_edition_pilot('${ORG}', 'trying it on')`)), `revoke ${w}`);
      assert.ok(failed(E.try(w, `select public.admin_set_editions_pilot(true, 'x')`)), `switch ${w}`);
      assert.ok(failed(E.try(w, `select public.admin_create_edition_organiser_for_hub('${HUB}', 'zz-nope-${w.toLowerCase()}', 'x', 'x')`)), `setup ${w}`);
      assert.ok(failed(E.try(w, `select public.admin_grant_edition_pilot_publish('${ED}', 'trying it on')`)), `grant ${w}`);
    }
    assert.equal(E.q(`select count(*) from edition_pilot_approvals`), '0');
  });
  test('a Hub that is not yet verified cannot be approved; the administrator verifies the Hub separately, then approval works', () => {
    assert.match(E.try('ADMIN', `select public.admin_approve_edition_pilot('${ORG}', 'approved for the pilot')`), /must be verified by a OneShetland administrator/);
    E.sup(`update hubs set is_verified = true where id = '${HUB}'`);
    assert.match(E.try('ADMIN', `select public.admin_approve_edition_pilot('${ORG}', 'ok')`), /a note is required/, 'a real note is required');
    const a = last(approve()); assert.ok(a);
    assert.match(E.try('ADMIN', `select public.admin_approve_edition_pilot('${ORG}', 'approved again')`), /already approved/);
  });
  test('an inactive Hub, a test organiser and an unverified organiser cannot be approved', () => {
    const hubOff = last(E.sup(`insert into hubs (owner_id, name, slug, type, area, description, is_active, is_verified) values ('${U.HUB2_OWNER}','ZZ Dormant','zz-dormant','community','Lerwick','x',true,true) returning id`));
    const rawOff = E.do('ADMIN', `select public.admin_create_edition_organiser_for_hub('${hubOff}', 'zz-dormant-fest', 'ZZ Dormant Fest', 'setup suite')`);
    const orgOff = last(rawOff); assert.match(orgOff, /^[0-9a-f-]{36}$/, rawOff);
    E.sup(`update hubs set is_active=false where id='${hubOff}'`);
    assert.match(E.try('ADMIN', `select public.admin_approve_edition_pilot('${orgOff}', 'approved for the pilot')`), /Hub is not active/);
    ORG_TEST = last(E.do('ADMIN', `select public.create_edition_organiser('ZZ Test Org', 'zz-test-org')`));
    assert.match(E.try('ADMIN', `select public.admin_approve_edition_pilot('${ORG_TEST}', 'approved for the pilot')`), /must be verified first/);
    E.do('ADMIN', `select public.admin_decide_edition_organiser('${ORG_TEST}', 'verify', 'checked by hand')`); E.do('ADMIN', `select public.admin_mark_edition_test('${ORG_TEST}')`);
    assert.match(E.try('ADMIN', `select public.admin_approve_edition_pilot('${ORG_TEST}', 'approved for the pilot')`), /test organiser is never shown/);
  });
  test('approval history and the audit trail are kept; approvals are append-only', () => {
    assert.equal(E.q(`select count(*) from edition_audit_log where action='pilot_approved' and organiser_id='${ORG}' and actor='${U.ADMIN}'`), '1');
    assert.ok(failed(E.sup(`update edition_pilot_approvals set note='rewritten history' where organiser_id='${ORG}'`)));
    assert.ok(failed(E.sup(`delete from edition_pilot_approvals`)));
    assert.equal(E.q(`select count(*) from edition_audit_log where action='pilot_switch_on' and actor='${U.ADMIN}'`) >= '1', true);
  });
});

describe('approved + pilot on + published + entitled = public; only that organiser', () => {
  test('the approved organiser\'s Edition, page and organiser row are public to a signed-out visitor; the other Hub\'s are not; drafts are not', () => {
    assert.equal(pubEd(), true); assert.equal(seesEd(), true); assert.equal(seesOrg(), true); assert.equal(seesPage(), true);
    assert.equal(pubEd(ED_B), false); assert.equal(seesEd(ED_B), false); assert.equal(seesOrg(ORG_B), false); assert.equal(seesPage(ED_B), false);
    assert.equal(seesEd(ED_DRAFT), false, 'an unpublished Edition of an approved organiser stays private');
    assert.equal(E.one('STRANGER', `select count(*) from public.editions where id='${ED_DRAFT}'`), '0');
    assert.equal(E.one('HUB_COMMITTEE', `select count(*) from public.editions where id='${ED_DRAFT}'`), '1', 'its team still sees its own draft');
    assert.equal(E.one('HUB_MEMBER', `select count(*) from public.editions where id='${ED_DRAFT}'`), '0', 'an ordinary Hub member is not on the team');
  });
  test('a test Edition of an approved organiser is never public', () => {
    E.sup(`set app.edition_test_mark='on'; update public.editions set is_test=true where id='${ED}'`); assert.equal(pubEd(), false);
    E.sup(`set app.edition_test_mark='on'; update public.editions set is_test=false where id='${ED}'`); assert.equal(pubEd(), true);
  });
});

describe('instant removal on every withdrawal route', () => {
  test('withdrawing the pilot approval', () => {
    revoke(); assert.equal(pubEd(), false); assert.equal(seesEd(), false); assert.equal(seesOrg(), false); assert.equal(seesPage(), false);
    assert.equal(E.q(`select count(*) from edition_audit_log where action='pilot_revoked' and organiser_id='${ORG}'`), '1');
    assert.match(E.try('ADMIN', `select public.admin_revoke_edition_pilot('${ORG}', 'again again')`), /no live pilot approval/);
    assert.match(E.try('ADMIN', `select public.admin_revoke_edition_pilot('${ORG}', 'no')`), /a reason is required/);
    approve(); assert.equal(pubEd(), true, 're-approval restores it'); assert.equal(E.q(`select count(*) from edition_pilot_approvals where organiser_id='${ORG}'`), '2', 'history kept');
  });
  test('suspending / deactivating the Hub, and removing its verification', () => {
    E.sup(`update hubs set is_active=false where id='${HUB}'`); assert.equal(pubEd(), false); assert.equal(seesOrg(), false); E.sup(`update hubs set is_active=true where id='${HUB}'`); assert.equal(pubEd(), true);
    E.sup(`update hubs set is_verified=false where id='${HUB}'`); assert.equal(pubEd(), false); assert.equal(seesOrg(), false); E.sup(`update hubs set is_verified=true where id='${HUB}'`); assert.equal(pubEd(), true);
  });
  test('suspending the organiser or the Edition', () => {
    E.do('ADMIN', `select public.admin_decide_edition_organiser('${ORG}', 'suspend', 'suite')`); assert.equal(pubEd(), false); assert.equal(seesOrg(), false);
    E.do('ADMIN', `select public.admin_decide_edition_organiser('${ORG}', 'reinstate', 'suite suite')`); assert.equal(pubEd(), true);
    E.do('ADMIN', `select public.edition_moderate('${ED}', 'suspend', 'suite reason')`); assert.equal(pubEd(), false);
    E.do('ADMIN', `select public.edition_moderate('${ED}', 'restore', null)`); E.sup(`update public.editions set status='published' where id='${ED}'`); assert.equal(pubEd(), true);
  });
  test('turning the pilot switch off', () => {
    pilot(false); assert.equal(pubEd(), false); assert.equal(seesEd(), false); assert.equal(seesOrg(), false); assert.equal(seesPage(), false);
    assert.equal(E.one('HUB_COMMITTEE', `select count(*) from public.editions where id='${ED}'`), '1', 'the team keeps authoring access'); pilot(true); assert.equal(pubEd(), true);
  });
  test('voiding or letting the publish entitlement expire', () => {
    const ent = E.q(`select id from edition_entitlements where edition_id='${ED}' and feature='publish' and voided_at is null`);
    E.do('ADMIN', `select public.admin_void_edition_entitlement('${ent}', 'voided in suite')`); assert.equal(pubEd(), false);
    // a real expiry: a grant that ends two seconds from now, observed before and after
    E.sup(`insert into edition_entitlements (organiser_id, edition_id, feature, starts_at, ends_at, source, granted_by, reason) values ('${ORG}','${ED}','publish', now() - interval '1 hour', clock_timestamp() + interval '3 seconds', 'admin_grant', '${U.ADMIN}', 'short grant for the expiry test')`);
    assert.equal(pubEd(), true, 'visible while the grant is live');
    E.sup(`select pg_sleep(3.5)`); assert.equal(pubEd(), false, 'gone the moment it lapses'); assert.equal(seesEd(), false);
  });
});

describe('pilot grants: 90 days by default, renewable, approved organisers only', () => {
  test('default 90 days, capped at 90, needs an approved organiser, writes an ordinary admin-grant ledger row with a Pilot reason', () => {
    assert.match(E.try('ADMIN', `select public.admin_grant_edition_pilot_publish('${ED_B}', 'not approved')`), /not approved for the pilot/);
    assert.match(E.try('ADMIN', `select public.admin_grant_edition_pilot_publish('${ED}', 'too long', 91)`), /1 to 90 days/);
    assert.match(E.try('ADMIN', `select public.admin_grant_edition_pilot_publish('${ED}', 'too short', 0)`), /1 to 90 days/);
    const g = last(E.do('ADMIN', `select public.admin_grant_edition_pilot_publish('${ED}', 'Slippit first season')`)); assert.ok(g);
    assert.equal(E.q(`select round(extract(epoch from (ends_at - starts_at)) / 86400) from edition_entitlements where id='${g}'`), '90');
    assert.equal(E.q(`select source || '|' || (reason like 'Pilot: Slippit first season')::text || '|' || granted_by from edition_entitlements where id='${g}'`), `admin_grant|true|${U.ADMIN}`);
    assert.equal(pubEd(), true);
    assert.match(E.try('ADMIN', `select public.admin_grant_edition_pilot_publish('${ED}', 'again')`), /more than 30 days/, 'no stacking years of access');
  });
  test('renewal: allowed in the last 30 days, starts where the live window ends, never overlaps, never gaps', () => {
    // shorten the story: a second Edition with a 20-day grant
    const e2 = last(E.sup(`insert into public.editions (organiser_id, slug, title, summary, kind, starts_on, ends_on) values ('${ORG}','zz-pilot-2028','ZZ Pilot 2028','x','multi_day',${d(400)},${d(402)}) returning id`));
    const g1 = last(E.do('ADMIN', `select public.admin_grant_edition_pilot_publish('${e2}', 'twenty days', 20)`));
    const end1 = E.q(`select ends_at from edition_entitlements where id='${g1}'`);
    const g2 = last(E.do('ADMIN', `select public.admin_grant_edition_pilot_publish('${e2}', 'renewal')`));
    assert.equal(E.q(`select starts_at = (select ends_at from edition_entitlements where id='${g1}') from edition_entitlements where id='${g2}'`), 't', 'new window starts at the old end');
    assert.equal(E.q(`select round(extract(epoch from (ends_at - starts_at)) / 86400) from edition_entitlements where id='${g2}'`), '90');
    assert.ok(end1);
    assert.equal(E.q(`select count(*) from edition_entitlements where edition_id='${e2}' and feature='publish' and voided_at is null`), '2');
  });
  test('a withdrawn approval blocks new grants', () => {
    revoke(); assert.match(E.try('ADMIN', `select public.admin_grant_edition_pilot_publish('${ED}', 'blocked')`), /not approved for the pilot/); approve();
  });
});

describe('everything else stays closed', () => {
  test('general organiser registration remains closed while the pilot is on (and approval does not open it)', () => {
    for (const w of ['STRANGER', 'HUB_OWNER', 'HUB_COMMITTEE', 'HUB2_OWNER', 'BIZ'] as Who[]) {
      assert.match(E.try(w, `select public.create_edition_organiser('ZZ Sneaky ${w}', 'zz-sneaky-${w.toLowerCase()}')`), /not open yet/, w);
    }
    assert.match(E.try('HUB2_OWNER', `select public.create_edition_organiser_for_hub('${HUB_B}', 'zz-sneaky-hub')`), /not open yet|already has/);
    assert.match(E.try('HUB_OWNER', `select public.create_edition_organiser_for_hub('${HUB}', 'zz-sneaky-hub2')`), /not open yet|already has/);
    assert.match(E.try('ADMIN', `select public.admin_create_edition_organiser_for_hub('${HUB}', 'zz-second', 'x', 'x')`), /already has an Editions organiser/);
    assert.equal(E.q(`select count(*) from edition_organisers where slug like 'zz-sneaky%'`), '0');
  });
  test('payments and commerce stay impossible even with the commerce flag set', () => {
    E.do('ADMIN', `select public.admin_set_edition_commerce_config('editions.commerce.enabled', 'true')`);
    assert.equal(E.q(`select public.edition_commerce_enabled()`), 'f'); assert.equal(E.q(`select public.editions_enabled()`), 'f');
    const pkg = E.q(`select id from edition_packages where code='community_publish'`);
    assert.match(E.try('HUB_OWNER', `select public.edition_create_order('${ORG}', '${ED}', '${pkg}', 'attempt-0001-suite')`), /payments are not switched on/);
    assert.equal(E.q(`select count(*) from edition_orders`), '0'); assert.equal(E.q(`select count(*) from edition_packages where active`), '0');
    E.do('ADMIN', `select public.admin_set_edition_commerce_config('editions.commerce.enabled', 'false')`);
  });
  test('structurally: the pilot predicate is referenced by exactly one function and one policy; creation, commerce and membership predicates do not mention it', () => {
    assert.equal(E.q(`select string_agg(p.proname, ',' order by p.proname) from pg_proc p where p.pronamespace='public'::regnamespace and p.prosrc like '%edition_pilot_visible%' and p.proname not like 'admin_%'`), 'edition_is_public');
    assert.equal(E.q(`select string_agg(policyname, ',') from pg_policies where schemaname='public' and (coalesce(qual,'') || coalesce(with_check,'')) like '%edition_pilot_visible%'`), 'edition_organisers public read');
    for (const f of ['edition_dark_launch_guard', 'edition_commerce_enabled', 'edition_tier_public', 'create_edition_organiser', 'create_edition_organiser_for_hub', 'edition_create_order']) {
      assert.equal(E.q(`select count(*) from pg_proc where proname='${f}' and (prosrc like '%pilot%')`), '0', f);
    }
  });
  test('open mode still works unchanged (editions.enabled true): any verified, published, entitled Edition is public without an approval', () => {
    E.sup(`insert into admin_config (key, value, category) values ('editions.enabled','true','features') on conflict (key) do update set value='true'`);
    assert.equal(pubEd(ED_B), true, 'open mode needs no approval (unchanged behaviour)');
    E.sup(`delete from admin_config where key='editions.enabled'`); assert.equal(E.q(`select public.editions_enabled()`), 'f');
    assert.equal(pubEd(ED_B), false, 'back to dark: unapproved organiser hidden again');
  });
});

describe('Hub committee permissions and privacy are untouched', () => {
  test('roles are still derived live from the Hub; an ordinary member and strangers have none', () => {
    assert.equal(E.one('HUB_OWNER', `select public.edition_org_role('${ORG}')`), 'owner'); assert.equal(E.one('HUB_COMMITTEE', `select public.edition_org_role('${ORG}')`), 'admin');
    assert.equal(E.one('HUB_MEMBER', `select coalesce(public.edition_org_role('${ORG}'),'none')`), 'none'); assert.equal(E.one('STRANGER', `select coalesce(public.edition_org_role('${ORG}'),'none')`), 'none');
    E.sup(`update hub_members set status='removed' where hub_id='${HUB}' and user_id='${U.HUB_COMMITTEE}'`);
    assert.equal(E.one('HUB_COMMITTEE', `select coalesce(public.edition_org_role('${ORG}'),'none')`), 'none', 'demotion is immediate');
    E.sup(`update hub_members set status='active' where hub_id='${HUB}' and user_id='${U.HUB_COMMITTEE}'`);
  });
  test('the committee can draft and publish within the grant but cannot approve, grant or switch anything', () => {
    assert.equal(E.one('HUB_COMMITTEE', `select count(*) from public.edition_organisers where id='${ORG}'`), '1');
    for (const sql of [`select public.admin_approve_edition_pilot('${ORG}', 'self approve')`, `select public.admin_grant_edition_pilot_publish('${ED}', 'self grant')`, `select public.admin_set_editions_pilot(false, 'x')`,
      `select public.admin_grant_edition_entitlement('${ED}', 'publish', now(), now() + interval '1 day', 'self grant')`]) assert.ok(failed(E.try('HUB_COMMITTEE', sql)), sql);
  });
  test('approvals are invisible to everyone but administrators; anon runs exactly seven Editions helpers; internal helpers are not exposed', () => {
    assert.ok(failed(E.try('anon', `select count(*) from edition_pilot_approvals`)));
    assert.equal(E.one('STRANGER', `select count(*) from edition_pilot_approvals`), '0'); assert.equal(E.one('HUB_OWNER', `select count(*) from edition_pilot_approvals`), '0');
    assert.ok(Number(E.one('ADMIN', `select count(*) from edition_pilot_approvals`)) >= 2);
    assert.equal(E.q(`select count(*) from pg_proc p where p.pronamespace='public'::regnamespace and p.proname ilike '%edition%' and has_function_privilege('anon', p.oid, 'execute')`), '7');
    assert.equal(E.q(`select string_agg(p.proname, ',' order by p.proname) from pg_proc p where p.pronamespace='public'::regnamespace and p.proname ilike '%edition%' and has_function_privilege('anon', p.oid, 'execute') and p.proname like '%pilot%'`), 'edition_pilot_visible');
    for (const w of ['anon', 'STRANGER'] as Who[]) assert.ok(failed(E.try(w, `select public.editions_pilot()`)), `editions_pilot is internal (${w})`);
    assert.equal(E.q(`select count(*) from pg_proc where proname in ('admin_set_editions_pilot','admin_create_edition_organiser_for_hub','admin_approve_edition_pilot','admin_revoke_edition_pilot','admin_grant_edition_pilot_publish') and has_function_privilege('anon', oid, 'execute')`), '0');
  });
  test('the contact-email, membership and business columns stay private: pilot visibility reveals only the existing public organiser columns', () => {
    assert.ok(failed(E.try('anon', `select contact_email from public.edition_organisers where id='${ORG}'`)));
    assert.ok(failed(E.try('anon', `select verification_note from public.edition_organisers where id='${ORG}'`)));
    assert.ok(failed(E.try('anon', `select count(*) from public.organiser_membership_tiers`)), 'membership tiers stay closed to a signed-out visitor');
  });
  test('admin set-up for a Hub creates a verified organiser with no copied members; the Hub\'s own committee is the authority at once', () => {
    assert.equal(E.q(`select status || '|' || coalesce(hub_id::text,'') || '|' || (select count(*) from edition_organiser_members m where m.organiser_id=o.id)::text from edition_organisers o where id='${ORG}'`), `verified|${HUB}|0`);
    assert.equal(E.q(`select count(*) from edition_audit_log where action='organiser_created_for_hub_by_admin' and actor='${U.ADMIN}'`) >= '2', true);
    assert.match(E.try('ADMIN', `select public.admin_create_edition_organiser_for_hub('${HUB}', 'editions', 'x', 'x')`), /already has|reserved/);
    assert.match(E.try('ADMIN', `select public.admin_create_edition_organiser_for_hub('${HUB_B}', 'Bad Slug', 'x', 'x')`), /already has|web address/);
  });
});

describe('administrator-only Hub verification (no database edits needed)', () => {
  let H = '';
  before(() => { H = last(E.sup(`insert into hubs (owner_id, name, slug, type, area, description, is_active) values ('${U.HUB2_OWNER}','ZZ Verify Hub','zz-verify-hub','community','Lerwick','x',true) returning id`)); });
  test('only a platform administrator can verify or un-verify; owners, committees, moderators, strangers and signed-out visitors cannot, and a Hub owner cannot self-verify by any route', () => {
    for (const w of ['HUB_OWNER', 'HUB_COMMITTEE', 'HUB2_OWNER', 'STRANGER', 'BIZ', 'anon'] as Who[]) assert.ok(failed(E.try(w, `select public.admin_set_hub_verified('${H}', true, 'self verification')`)), w);
    assert.ok(failed(E.try('HUB2_OWNER', `update public.hubs set is_verified = true where id='${H}'`)) || E.q(`select is_verified from hubs where id='${H}'`) === 'f');
    assert.equal(E.q(`select is_verified from hubs where id='${H}'`), 'f');
    E.sup(`update profiles set role='moderator' where id='${U.STRANGER}'`);
    assert.ok(failed(E.try('STRANGER', `select public.admin_set_hub_verified('${H}', true, 'moderator try')`)), 'moderators have no route');
    E.sup(`update profiles set role='customer' where id='${U.STRANGER}'`);
    assert.equal(E.q(`select count(*) from pg_proc where proname='admin_set_hub_verified' and has_function_privilege('anon', oid, 'execute')`), '0');
  });
  test('a note is required; an unknown Hub and a no-change request are refused in words', () => {
    assert.match(E.try('ADMIN', `select public.admin_set_hub_verified('${H}', true, 'no')`), /a note is required/);
    assert.match(E.try('ADMIN', `select public.admin_set_hub_verified(gen_random_uuid(), true, 'unknown hub here')`), /Hub not found/);
    assert.match(E.try('ADMIN', `select public.admin_set_hub_verified('${H}', false, 'already unverified')`), /already in that state/);
  });
  test('an administrator verifies, then removes verification; each change is audited with actor, Hub and note', () => {
    E.do('ADMIN', `select public.admin_set_hub_verified('${H}', true, 'checked the committee by hand')`);
    assert.equal(E.q(`select is_verified from hubs where id='${H}'`), 't');
    assert.equal(E.q(`select count(*) from edition_audit_log where action='hub_verified' and actor='${U.ADMIN}' and detail->>'hub_id'='${H}' and detail->>'note'='checked the committee by hand'`), '1');
    E.do('ADMIN', `select public.admin_set_hub_verified('${H}', false, 'committee changed, re-check')`);
    assert.equal(E.q(`select is_verified from hubs where id='${H}'`), 'f');
    assert.equal(E.q(`select count(*) from edition_audit_log where action='hub_verification_removed' and detail->>'hub_id'='${H}'`), '1');
  });
  test('verification does not by itself approve anything: a verified Hub with no approval is still not public in the pilot', () => {
    E.do('ADMIN', `select public.admin_set_hub_verified('${HUB_B}', true, 'verified for the scoping test')`);
    assert.equal(pubEd(ED_B), false); assert.equal(seesOrg(ORG_B), false);
    E.do('ADMIN', `select public.admin_set_hub_verified('${HUB_B}', false, 'back to unverified')`);
  });
});
