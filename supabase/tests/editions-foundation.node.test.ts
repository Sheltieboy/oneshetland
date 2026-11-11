/**
 * editions-foundation.node.test.ts — ISOLATED Postgres only (PASS_PROOF_DSN, the throwaway cluster). Fake users, no network.
 *
 * Replays every REAL migration (so 20270102000000_editions_foundation.sql replaying clean is itself checked) and proves, through the real
 * roles (anon / authenticated with a JWT subject), the R1 acceptance cases: S1-S4, S6-S10, S13-ish, P-entitlement basics, O1-O5, O9, A1-A4, A6, A7, V4.
 *
 * Run: ISOLATED_ONLY=editions npm run test:isolated   (never `npm test`)
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Env, USERS, seed, enter, last, d } from './_support/editions-env.ts';
import { MOD, addModerator, verifyOrg } from './_support/editions-env-1.ts';

// The cast, in the finished model (a Hub and a Business run Editions; nobody registers an organiser):
//   OWNER_A  = the Hub's owner (owner of organiser A)      ADMIN_A  = the Hub's committee member (admin through the Hub)
//   EDITOR_A = an invited helper (editor)                  OWNER_B  = the Business owner (owner of organiser B)
//   VISITOR  = a stranger                                  MOD      = a platform moderator;  ADMIN = a platform administrator
const U = { ADMIN: USERS.ADMIN, MOD, OWNER_A: USERS.HUB_OWNER, ADMIN_A: USERS.HUB_COMMITTEE, EDITOR_A: USERS.EDITOR, HELPER_A: USERS.HELPER, OWNER_B: USERS.BIZ_OWNER, VISITOR: USERS.STRANGER } as const;
type Who = keyof typeof U | 'anon';
const EMAIL = (w: keyof typeof U) => `${U[w]}@x.invalid`;
const failed = (o: string) => /^ERROR:|permission denied|row-level security|violates check constraint|violates exclusion|violates unique|violates foreign/im.test(o);
const asUser = (env: Env, who: Who, sql: string, commit: boolean) => who === 'anon'
  ? env.db.raw(`begin; set local role anon; ${sql}; rollback;`)
  : env.db.raw(`begin; set local request.jwt.claims = '{"sub":"${U[who]}","email":"${EMAIL(who)}","role":"authenticated"}'; set local request.jwt.claim.sub = '${U[who]}'; set local role authenticated; ${sql}; ${commit ? 'commit' : 'rollback'};`);

/** thin wrapper: same method names the old suite used, over the shared Env (plus the moderator) */
class Wrap {
  env: Env;
  constructor(env: Env) { this.env = env; }
  get db() { return this.env.db; }
  try(who: Who, sql: string) { return asUser(this.env, who, sql, false); }
  do(who: Who, sql: string) { return asUser(this.env, who, sql, true); }
  q(sql: string) { return this.env.q(sql); }
  sup(sql: string) { return this.env.sup(sql); }
  one(who: Who, sql: string) { return last(this.try(who, sql)); }
}

let E: Wrap;
let ENV: Env;
let S: ReturnType<typeof seed>;
const flag = (on: boolean) => E.sup(on
  ? `insert into admin_config (key, value, category) values ('editions.enabled','true','features') on conflict (key) do update set value='true'`
  : `delete from admin_config where key='editions.enabled'`);
let ORG_A = '', ORG_B = '', ED_A = '', ED_B = '';

before(() => {
  ENV = new Env('editions');
  E = new Wrap(ENV);
  S = seed(ENV);
  addModerator(ENV);
  // organisers are created by entering Editions from a real Hub / Business, as its owner (the only way there is)
  ORG_A = enter(ENV, 'HUB_OWNER', 'hub', S.HUB);
  ORG_B = enter(ENV, 'BIZ_OWNER', 'business', S.BIZ);
  assert.match(ORG_A, /^[0-9a-f-]{36}$/, ORG_A);
  assert.match(ORG_B, /^[0-9a-f-]{36}$/, ORG_B);
  flag(false);
});
after(() => ENV?.drop());

describe('S8 every edition table is locked down by default', () => {
  test('RLS on every edition table, no FOR ALL policy, nothing granted to PUBLIC', () => {
    assert.equal(E.q(`select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relname like 'edition%' and not c.relrowsecurity`), '0');
    assert.equal(E.q(`select count(*) from pg_policies where schemaname='public' and tablename like 'edition%' and cmd = 'ALL'`), '0');
    assert.equal(E.q(`select count(*) from pg_policies where schemaname='public' and tablename = 'editions' and cmd = 'ALL'`), '0');
  });
  test('anon has no write privilege on any edition table, and authenticated has none on the ledger/audit/members/invites', () => {
    assert.equal(E.q(`select count(*) from information_schema.role_table_grants where grantee='anon' and table_name like 'edition%' and privilege_type <> 'SELECT'`), '0');
    assert.equal(E.q(`select count(*) from information_schema.role_table_grants where grantee='authenticated' and table_name in ('edition_entitlements','edition_audit_log','edition_organiser_members','edition_organiser_invites','edition_organiser_verifications','edition_reserved_names') and privilege_type <> 'SELECT'`), '0');
  });
  test('no edition definer function is executable by anon except the public-read helpers', () => {
    const open = E.q(`select coalesce(string_agg(p.proname, ',' order by p.proname), '') from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.prosecdef and (p.proname like 'edition%' or p.proname like 'admin_%edition%' or p.proname like '%edition_%') and has_function_privilege('anon', p.oid, 'execute')`);
    assert.equal(open, 'edition_business_role,edition_controls_business,edition_entitled,edition_featured,edition_is_public,edition_parent_live,edition_participation_ok,edition_promo_track,edition_public_tiers,editions_enabled'); // the pilot reader is gone; the three parent helpers are read-only booleans used by the public policies
  });
  test('S7: the R1 edition tables reference only each other, auth.users, hubs and local_businesses (the two parents) (later releases add their own, tested in their suites)', () => {
    const refs = E.q(`select coalesce(string_agg(distinct ccl.relname, ',' order by ccl.relname), '') from pg_constraint c join pg_class cl on cl.oid=c.conrelid join pg_class ccl on ccl.oid=c.confrelid
      where c.contype='f' and cl.relname in ('edition_reserved_names','edition_organisers','edition_organiser_members','edition_organiser_invites','edition_organiser_verifications','edition_series','editions','edition_pages','edition_venues','edition_sessions','edition_updates','edition_sponsors','edition_entitlements','edition_audit_log') and ccl.relname not like 'edition%' and ccl.relname <> 'editions'`);
    assert.equal(refs, 'hubs,local_businesses,users');
  });
});

describe('O1/O2/A1/A7 organisers and verification', () => {
  test('anon cannot enter Editions; direct inserts and status writes are refused for everyone', () => {
    assert.ok(failed(E.try('anon', `select public.edition_ensure_organiser('hub', '${S.HUB}')`)));
    assert.ok(failed(E.try('OWNER_A', `insert into public.edition_organisers (slug, name, hub_id) values ('sneaky','Sneaky','${S.HUB2}')`)));
    assert.ok(failed(E.try('OWNER_A', `update public.edition_organisers set status = 'verified' where id = '${ORG_A}'`)));
    assert.ok(failed(E.try('OWNER_A', `update public.edition_organisers set is_test = true where id = '${ORG_A}'`)));
  });
  test('the Hub owner is the owner; the organiser starts pending', () => {
    assert.equal(E.one('OWNER_A', `select public.edition_org_role('${ORG_A}')`), 'owner');
    assert.equal(E.one('OWNER_B', `select public.edition_org_role('${ORG_B}')`), 'owner');
    assert.equal(E.q(`select status from edition_organisers where id='${ORG_A}'`), 'pending');
  });
  test('DARK LAUNCH is enforced in the database: while editions.enabled is off an owner cannot enter Editions for the first time; when it is open they can', () => {
    flag(false);
    assert.match(ENV.try('HUB2_OWNER', `select public.edition_ensure_organiser('hub', '${S.HUB2}')`), /not open yet/);
    assert.equal(E.q(`select count(*) from edition_organisers where hub_id='${S.HUB2}'`), '0');
    flag(true);
    assert.match(last(ENV.do('HUB2_OWNER', `select public.edition_ensure_organiser('hub', '${S.HUB2}') ->> 'id'`)), /^[0-9a-f-]{36}$/);
    E.sup(`delete from edition_organisers where hub_id='${S.HUB2}'`); flag(false);
  });
  test('the address is generated (never typed): reserved words are skipped; a real-festival-looking name is flagged for careful verification', () => {
    flag(true);
    const h = last(E.sup(`insert into hubs (owner_id, name, slug, type, area, is_active) values ('${USERS.HUB2_OWNER}','Friends of Wool Week','zz-friends-wool','club','Lerwick',true) returning id`));
    const o = last(ENV.do('HUB2_OWNER', `select public.edition_ensure_organiser('hub', '${h}') ->> 'id'`));
    assert.equal(E.q(`select reserved_name_flag from edition_organisers where id='${o}'`), 't');
    // a flagged organiser cannot be verified without a written note
    assert.match(E.try('ADMIN', `select public.admin_decide_edition_organiser('${o}', 'verify', null)`), /reserved-name organiser needs a written/);
    E.sup(`delete from edition_organisers where id='${o}'; delete from hubs where id='${h}'`);
    flag(false);
  });
  // RETIRED: "per-user organiser cap" (one profile per Hub/Business now; covered by the one-per-parent index in editions-complete) and "only the owner can request verification" (the request form no longer exists: the identity check is recorded with the first Edition approval, proved in editions-complete)
  test('moderators and members cannot verify; the administrator can', () => {
    flag(true);
    const o = last(ENV.do('HUB2_OWNER', `select public.edition_ensure_organiser('hub', '${S.HUB2}') ->> 'id'`));
    for (const who of ['MOD', 'OWNER_A', 'VISITOR'] as Who[]) assert.match(E.try(who, `select public.admin_decide_edition_organiser('${o}', 'verify', 'ok ok ok ok ok')`), /admins only/, who);
    assert.ok(!failed(E.do('ADMIN', `select public.admin_decide_edition_organiser('${o}', 'verify', 'Checked the committee minutes.')`)));
    assert.equal(E.q(`select status from edition_organisers where id='${o}'`), 'verified');
    E.sup(`delete from edition_organisers where id='${o}'`); flag(false);
  });
  test('organiser B is verified too, so isolation tests are meaningful', () => {
    verifyOrg(ENV, ORG_B);
    assert.equal(E.q(`select status from edition_organisers where id='${ORG_B}'`), 'verified');
  });
});

describe('O3/S3/S4 team, roles and invitations', () => {
  let INV_ADMIN = '', INV_EDITOR = '';
  test('only the owner invites; the invitation is for an email, not a user lookup', () => {
    assert.ok(failed(E.try('VISITOR', `select public.invite_edition_member('${ORG_A}', 'a@b.invalid', 'editor')`)));
    INV_ADMIN = last(E.do('OWNER_A', `select public.invite_edition_member('${ORG_A}', '${EMAIL('HELPER_A')}', 'admin')`));
    INV_EDITOR = last(E.do('OWNER_A', `select public.invite_edition_member('${ORG_A}', '${EMAIL('EDITOR_A').toUpperCase()}', 'editor')`));
    assert.match(INV_ADMIN, /^[0-9a-f-]{36}$/);
    assert.ok(failed(E.try('OWNER_A', `select public.invite_edition_member('${ORG_A}', 'x@y.invalid', 'owner')`)), 'cannot invite as owner');
  });
  test('only the addressed email can accept; a stranger cannot', () => {
    assert.match(E.try('VISITOR', `select public.accept_edition_invite('${INV_ADMIN}')`), /invitation not available/);
    assert.match(E.try('EDITOR_A', `select public.accept_edition_invite('${INV_ADMIN}')`), /invitation not available/);
    assert.ok(!failed(E.do('HELPER_A', `select public.accept_edition_invite('${INV_ADMIN}')`)));
    assert.ok(!failed(E.do('EDITOR_A', `select public.accept_edition_invite('${INV_EDITOR}')`)));
    assert.equal(E.one('HELPER_A', `select public.edition_org_role('${ORG_A}')`), 'admin');
    assert.equal(E.one('EDITOR_A', `select public.edition_org_role('${ORG_A}')`), 'editor');
    assert.equal(E.one('ADMIN_A', `select public.edition_org_role('${ORG_A}')`), 'admin', 'the Hub committee is admin without any invitation');
    assert.match(E.try('HELPER_A', `select public.accept_edition_invite('${INV_ADMIN}')`), /invitation not available/, 'single use');
  });
  test('team list: admins see it with names (the Hub owner and committee through the Hub, plus the two helpers); editors and outsiders see nothing', () => {
    assert.equal(E.one('ADMIN_A', `select count(*) from public.edition_org_team('${ORG_A}')`), '4');
    assert.equal(E.one('HELPER_A', `select count(*) from public.edition_org_team('${ORG_A}')`), '4');
    assert.equal(E.one('EDITOR_A', `select count(*) from public.edition_org_team('${ORG_A}')`), '0');
    assert.equal(E.one('OWNER_B', `select count(*) from public.edition_org_team('${ORG_A}')`), '0');
  });
  test('editors and admins cannot manage members; an owner can', () => {
    for (const who of ['EDITOR_A', 'ADMIN_A', 'HELPER_A'] as Who[]) {
      assert.ok(failed(E.try(who, `select public.set_edition_member_role('${ORG_A}', '${U.EDITOR_A}', 'admin')`)), who);
      assert.ok(failed(E.try(who, `select public.remove_edition_member('${ORG_A}', '${U.OWNER_A}')`)), who);
      assert.ok(failed(E.try(who, `select public.invite_edition_member('${ORG_A}', 'z@z.invalid', 'editor')`)), who);
    }
    assert.ok(!failed(E.do('OWNER_A', `select public.set_edition_member_role('${ORG_A}', '${U.EDITOR_A}', 'editor')`)));
  });
  // REWRITTEN: "the last owner cannot be removed or demoted". Ownership is no longer a membership row: it comes live from the Hub/Business owner, so there is nothing to remove and nobody can make a helper an owner.
  test('S4 ownership comes from the parent: a helper can never be made owner, and removing every helper leaves the owner in control', () => {
    assert.match(E.sup(`insert into edition_organiser_members (organiser_id, user_id, role) values ('${ORG_A}','${USERS.STRANGER}','owner')`), /helper cannot be an owner/);
    assert.match(E.sup(`update edition_organiser_members set role='owner' where organiser_id='${ORG_A}' and user_id='${U.EDITOR_A}'`), /helper cannot be an owner/);
    assert.equal(E.q(`select count(*) from edition_organiser_members where organiser_id='${ORG_A}' and role='owner'`), '0');
    assert.equal(E.one('OWNER_A', `select public.edition_org_role('${ORG_A}')`), 'owner');
  });
  test('a member may leave; a revoked or expired invitation cannot be accepted', () => {
    const inv = last(E.do('OWNER_A', `select public.invite_edition_member('${ORG_A}', '${EMAIL('VISITOR')}', 'editor')`));
    E.do('OWNER_A', `select public.revoke_edition_invite('${inv}')`);
    assert.match(E.try('VISITOR', `select public.accept_edition_invite('${inv}')`), /invitation not available/);
    const inv2 = last(E.do('OWNER_A', `select public.invite_edition_member('${ORG_A}', '${EMAIL('VISITOR')}', 'editor')`));
    E.sup(`update edition_organiser_invites set expires_at = now() - interval '1 minute' where id='${inv2}'`);
    assert.match(E.try('VISITOR', `select public.accept_edition_invite('${inv2}')`), /invitation not available/);
    E.do('HELPER_A', `select public.remove_edition_member('${ORG_A}', '${U.HELPER_A}')`);
    assert.equal(E.one('HELPER_A', `select coalesce(public.edition_org_role('${ORG_A}'),'none')`), 'none');
  });
});

describe('S1/S2 isolation between organisers and from the public', () => {
  test('B cannot see A’s organiser row, members, invites, verifications or audit; A cannot see B’s', () => {
    assert.equal(E.one('OWNER_B', `select count(*) from public.edition_organisers where id='${ORG_A}'`), '0');
    assert.equal(E.one('OWNER_B', `select count(*) from public.edition_organiser_members where organiser_id='${ORG_A}'`), '0');
    assert.equal(E.one('OWNER_B', `select count(*) from public.edition_organiser_invites where organiser_id='${ORG_A}'`), '0');
    assert.equal(E.one('OWNER_B', `select count(*) from public.edition_organiser_verifications where organiser_id='${ORG_A}'`), '0');
    assert.equal(E.one('OWNER_B', `select count(*) from public.edition_audit_log where organiser_id='${ORG_A}'`), '0');
    assert.equal(E.one('OWNER_A', `select count(*) from public.edition_organisers where id='${ORG_B}'`), '0');
  });
  test('B cannot edit A’s organiser profile', () => {
    const o = E.try('OWNER_B', `update public.edition_organisers set name = 'hijacked' where id='${ORG_A}'; select name from public.edition_organisers where id='${ORG_A}'`);
    assert.ok(failed(o) || last(o) !== 'hijacked', o);
    assert.equal(E.q(`select name from edition_organisers where id='${ORG_A}'`), 'ZZ Test Hub');
  });
  test('editors cannot edit the organiser profile; admins and owners can (allowed columns only)', () => {
    const e = E.try('EDITOR_A', `update public.edition_organisers set tagline = 'x' where id='${ORG_A}'; select tagline from public.edition_organisers where id='${ORG_A}'`);
    assert.notEqual(last(e), 'x');
    assert.ok(!failed(E.do('ADMIN_A', `update public.edition_organisers set tagline = 'Made by admin' where id='${ORG_A}'`)));
    assert.equal(E.q(`select tagline from edition_organisers where id='${ORG_A}'`), 'Made by admin');
    assert.ok(failed(E.try('ADMIN_A', `update public.edition_organisers set status = 'verified', hub_id = null where id='${ORG_A}'`)));
    assert.ok(failed(E.try('ADMIN_A', `update public.edition_organisers set brand_color = 'red' where id='${ORG_A}'`)));
  });
});

describe('O4/O5/S10 editions: creation, dates, immutability', () => {
  const mk = (who: Who, org: string, slug: string, kind = 'multi_day', from = d(10), to = d(12)) =>
    E.do(who, `insert into public.editions (organiser_id, slug, title, summary, kind, starts_on, ends_on) values ('${org}','${slug}','ZZ TEST ${slug}','Sample summary','${kind}',${from},${to}) returning id`);
  test('an organiser admin can create; an editor and an outsider cannot', () => {
    ED_A = last(mk('ADMIN_A', ORG_A, 'zz-test-edition-2027'));
    assert.match(ED_A, /^[0-9a-f-]{36}$/, ED_A);
    assert.ok(failed(mk('EDITOR_A', ORG_A, 'zz-by-editor')));
    assert.ok(failed(mk('VISITOR', ORG_A, 'zz-by-stranger')));
    assert.ok(failed(mk('OWNER_B', ORG_A, 'zz-by-other-org')));
    ED_B = last(mk('OWNER_B', ORG_B, 'zz-other-edition'));
  });
  test('new editions are drafts, never published or test, whatever the client sends', () => {
    assert.ok(failed(E.try('ADMIN_A', `insert into public.editions (organiser_id, slug, title, kind, starts_on, ends_on, status) values ('${ORG_A}','zz-x1','T','single_day',${d(1)},${d(1)},'published')`)));
    assert.ok(failed(E.try('ADMIN_A', `insert into public.editions (organiser_id, slug, title, kind, starts_on, ends_on, is_test) values ('${ORG_A}','zz-x2','T','single_day',${d(1)},${d(1)},true)`)));
    assert.equal(E.q(`select status || ',' || is_test from editions where id='${ED_A}'`), 'draft,false');
  });
  test('the five date kinds are enforced in the database', () => {
    const ok = (k: string, a: string, b: string, n: string) => assert.ok(!failed(mk('ADMIN_A', ORG_A, `zz-date-${n}`, k, a, b)), `${k} ok`);
    const bad = (k: string, a: string, b: string, n: string) => assert.ok(failed(mk('ADMIN_A', ORG_A, `zz-date-${n}`, k, a, b)), `${k} bad`);
    ok('single_day', d(20), d(20), 'a'); bad('single_day', d(20), d(21), 'b');
    ok('multi_day', d(20), d(22), 'c'); bad('multi_day', d(20), d(20), 'd'); bad('multi_day', d(20), d(40), 'e');
    ok('week', d(30), d(36), 'f'); bad('week', d(30), d(32), 'g');
    ok('season', d(50), d(150), 'h'); ok('campaign', d(50), d(60), 'i'); bad('season', d(50), d(10), 'j'); bad('season', d(50), d(600), 'k');
    E.sup(`delete from editions where slug like 'zz-date-%'`);
  });
  test('slug, organiser, status and is_test cannot be changed by an organiser', () => {
    for (const set of [`slug = 'renamed'`, `organiser_id = '${ORG_B}'`, `status = 'published'`, `is_test = true`, `published_at = now()`]) {
      assert.ok(failed(E.try('ADMIN_A', `update public.editions set ${set} where id='${ED_A}'`)), set);
    }
    assert.match(E.sup(`update editions set slug = 'renamed' where id='${ED_A}'`), /slug cannot change/);
    assert.match(E.sup(`update editions set organiser_id = '${ORG_B}' where id='${ED_A}'`), /cannot change organiser/);
  });
  test('editors may edit content; outsiders may not; colours and URLs are validated', () => {
    assert.ok(!failed(E.do('EDITOR_A', `update public.editions set description = 'Edited by editor', brand_color = '#0a7c6a' where id='${ED_A}'`)));
    assert.equal(E.q(`select description from editions where id='${ED_A}'`), 'Edited by editor');
    const o = E.try('OWNER_B', `update public.editions set description = 'owned' where id='${ED_A}'; select description from public.editions where id='${ED_A}'`);
    assert.ok(failed(o) || last(o) !== 'owned');
    assert.ok(failed(E.try('EDITOR_A', `update public.editions set brand_color = 'javascript:x' where id='${ED_A}'`)));
    assert.ok(failed(E.try('EDITOR_A', `update public.editions set logo_url = 'http://insecure.example/x.png' where id='${ED_A}'`)));
    assert.ok(failed(E.try('EDITOR_A', `update public.editions set theme = '{"evil":"1"}' where id='${ED_A}'`)));
    assert.ok(!failed(E.do('EDITOR_A', `update public.editions set theme = '{"hero":"band"}' where id='${ED_A}'`)));
  });
  test('drafts are private: B, a visitor and anon cannot read A’s draft even with the flag on', () => {
    flag(true);
    for (const who of ['OWNER_B', 'VISITOR', 'anon'] as Who[]) assert.equal(E.one(who, `select count(*) from public.editions where id='${ED_A}'`), '0', who);
    for (const who of ['EDITOR_A', 'ADMIN', 'MOD'] as Who[]) assert.equal(E.one(who, `select count(*) from public.editions where id='${ED_A}'`), '1', who);
    flag(false);
  });
});

describe('O10/A4/P5/P11 the publish gate and the entitlement ledger', () => {
  const publish = (who: Who, ed: string) => E.try(who, `select public.edition_set_status('${ed}', 'published')`);
  test('without OneShetland approval nobody can publish: not owner, not admin, not even the service role', () => {
    assert.match(publish('OWNER_A', ED_A), /organiser is not verified/, 'a pending organiser is refused first');
    assert.match(E.sup(`update editions set status='published' where id='${ED_A}'`), /organiser is not verified/);
    E.sup(`update edition_organisers set status='verified' where id='${ORG_A}'`);
    assert.match(publish('OWNER_A', ED_A), /not been approved/, 'then an unapproved Edition is refused');
    E.sup(`update edition_organisers set status='pending' where id='${ORG_A}'`);
  });
  test('the owner builds a welcome page, submits, and the administrator approves; approval records the identity check too', () => {
    assert.ok(!failed(E.do('EDITOR_A', `insert into public.edition_pages (edition_id, slug, nav_label, title, body, is_home, position) values ('${ED_A}','welcome','Welcome','Welcome','## Hello', true, 0)`)));
    assert.equal(E.q(`select status from edition_organisers where id='${ORG_A}'`), 'pending');
    E.do('OWNER_A', `select public.edition_submit_for_review('${ED_A}')`);
    assert.ok(!failed(E.do('ADMIN', `select public.admin_review_edition('${ED_A}', 'approve', 'ZZ TEST approved')`)));
    assert.equal(E.q(`select review_state || ',' || (select status from edition_organisers where id='${ORG_A}') from editions where id='${ED_A}'`), 'approved,verified');
  });
  test('approved but without a package nobody can publish: not owner, not admin, not even the service role', () => {
    assert.match(publish('OWNER_A', ED_A), /no live publish entitlement/);
    assert.match(E.sup(`update editions set status='published' where id='${ED_A}'`), /no live publish entitlement/);
  });
  test('only an editor-or-below cannot publish at all (admin+ only)', () => {
    assert.match(publish('EDITOR_A', ED_A), /organiser admins only/);
    assert.match(publish('OWNER_B', ED_A), /organiser admins only/);
  });
  test('only the platform administrator can grant; moderators, owners and visitors cannot', () => {
    const g = `select public.admin_grant_edition_entitlement('${ED_A}', 'publish', now(), now() + interval '90 days', 'ZZ TEST grant for acceptance')`;
    for (const who of ['MOD', 'OWNER_A', 'ADMIN_A', 'VISITOR', 'anon'] as Who[]) assert.ok(failed(E.try(who, g)), who);
  });
  test('grant guards: reason, end after start, no longer than 24 months, no overlap', () => {
    const g = (s: string, e: string, r: string) => `select public.admin_grant_edition_entitlement('${ED_A}', 'publish', ${s}, ${e}, '${r}')`;
    assert.match(E.try('ADMIN', g('now()', "now() - interval '1 day'", 'ZZ TEST reason')), /end after its start/);
    assert.match(E.try('ADMIN', g('now()', "now() + interval '30 months'", 'ZZ TEST reason')), /24 months/);
    assert.ok(failed(E.try('ADMIN', g('now()', "now() + interval '5 days'", 'x'))), 'reason required');
  });
  let GRANT = '';
  test('a real admin grant lets the organiser publish through the normal function (no bypass)', () => {
    GRANT = last(E.do('ADMIN', `select public.admin_grant_edition_entitlement('${ED_A}', 'publish', now(), now() + interval '90 days', 'ZZ TEST grant for acceptance')`));
    assert.match(GRANT, /^[0-9a-f-]{36}$/);
    assert.match(E.try('ADMIN', `select public.admin_grant_edition_entitlement('${ED_A}', 'publish', now() + interval '1 day', now() + interval '30 days', 'ZZ TEST overlapping grant')`), /overlapping admin grant/);
    assert.equal(E.q(`select public.edition_entitled('${ED_A}', 'publish')::text`), 'true');
    assert.ok(!failed(E.do('OWNER_A', `select public.edition_set_status('${ED_A}', 'published')`)));
    assert.equal(E.q(`select status from editions where id='${ED_A}'`), 'published');
  });
  test('organiser B has no entitlement, so B cannot publish; A’s grant is visible only to A’s admins and staff', () => {
    assert.match(publish('OWNER_B', ED_B), /not been approved/);
    assert.equal(E.one('OWNER_B', `select count(*) from public.edition_entitlements`), '0');
    assert.equal(E.one('EDITOR_A', `select count(*) from public.edition_entitlements`), '0');
    assert.equal(E.one('ADMIN_A', `select count(*) from public.edition_entitlements`), '1');
    assert.equal(E.one('ADMIN', `select count(*) from public.edition_entitlements`), '1');
  });
  test('V4 public visibility needs the flag, a verified organiser, an approved and published edition and a live entitlement', () => {
    flag(false);
    assert.equal(E.one('anon', `select count(*) from public.editions`), '0', 'flag off');
    flag(true);
    assert.equal(E.one('anon', `select count(*) from public.editions where id='${ED_A}'`), '1', 'flag on');
    assert.equal(E.one('VISITOR', `select count(*) from public.editions where id='${ED_A}'`), '1');
    assert.equal(E.one('anon', `select count(*) from public.edition_organisers where id='${ORG_A}'`), '1', 'verified organiser public');
    assert.equal(E.one('anon', `select count(*) from public.editions where id='${ED_B}'`), '0', 'B still a draft');
  });
  test('P5 expiry hides at once; a void hides at once; a later grant restores', () => {
    E.sup(`alter table edition_entitlements disable trigger edition_entitlements_append_only; update edition_entitlements set ends_at = now() - interval '1 second', starts_at = now() - interval '2 days' where id='${GRANT}'; alter table edition_entitlements enable trigger edition_entitlements_append_only;`);
    assert.equal(E.one('anon', `select count(*) from public.editions where id='${ED_A}'`), '0', 'expired');
    E.sup(`alter table edition_entitlements disable trigger edition_entitlements_append_only; update edition_entitlements set ends_at = now() + interval '40 days', starts_at = now() - interval '1 day' where id='${GRANT}'; alter table edition_entitlements enable trigger edition_entitlements_append_only;`);
    assert.equal(E.one('anon', `select count(*) from public.editions where id='${ED_A}'`), '1', 'live again');
    assert.match(E.try('MOD', `select public.admin_void_edition_entitlement('${GRANT}', 'ZZ TEST void')`), /admins only/);
    E.do('ADMIN', `select public.admin_void_edition_entitlement('${GRANT}', 'ZZ TEST void for acceptance')`);
    assert.equal(E.one('anon', `select count(*) from public.editions where id='${ED_A}'`), '0', 'voided');
    // a replacement grant restores public visibility (the edition is still `published`)
    E.do('ADMIN', `select public.admin_grant_edition_entitlement('${ED_A}', 'publish', now(), now() + interval '60 days', 'ZZ TEST replacement grant')`);
    assert.equal(E.one('anon', `select count(*) from public.editions where id='${ED_A}'`), '1');
  });
  test('the ledger is append-only: no delete, no change except voiding (even for the superuser)', () => {
    assert.match(E.sup(`delete from edition_entitlements`), /cannot be deleted/);
    assert.match(E.sup(`update edition_entitlements set amount_pence = 1`), /append-only/);
    assert.match(E.sup(`update edition_entitlements set ends_at = ends_at + interval '1 year'`), /append-only/);
    assert.ok(failed(E.try('ADMIN', `update public.edition_entitlements set ends_at = now() + interval '5 years'`)));
  });
  test('an unverified or suspended organiser cannot publish and is hidden publicly', () => {
    assert.match(E.try('MOD', `select public.admin_decide_edition_organiser('${ORG_A}', 'suspend', 'ZZ TEST suspend')`), /admins only/, 'moderators cannot suspend');
    E.do('ADMIN', `select public.admin_decide_edition_organiser('${ORG_A}', 'suspend', 'ZZ TEST suspend')`);
    assert.equal(E.one('anon', `select count(*) from public.editions where id='${ED_A}'`), '0', 'organiser suspended hides editions');
    assert.equal(E.one('anon', `select count(*) from public.edition_organisers where id='${ORG_A}'`), '0');
    assert.match(E.try('MOD', `select public.admin_decide_edition_organiser('${ORG_A}', 'reinstate', 'ZZ TEST reinstate')`), /admins only/);
    E.do('ADMIN', `select public.admin_decide_edition_organiser('${ORG_A}', 'reinstate', 'ZZ TEST reinstated after review')`);
    assert.equal(E.one('anon', `select count(*) from public.editions where id='${ED_A}'`), '1');
  });
  test('test editions are never public, but still go through the real gate', () => {
    const t = last(E.do('OWNER_A', `insert into public.editions (organiser_id, slug, title, summary, kind, starts_on, ends_on) values ('${ORG_A}','zz-test-private','ZZ TEST private','Sample','single_day',${d(5)},${d(5)}) returning id`));
    E.sup(`insert into public.edition_pages (edition_id, slug, nav_label, title, body, position, in_nav, is_home) values ('${t}','welcome','Welcome','Welcome','Hello',0,true,true)`);
    E.do('OWNER_A', `select public.edition_submit_for_review('${t}')`);
    E.do('ADMIN', `select public.admin_review_edition('${t}', 'approve', 'ZZ TEST approved')`);
    assert.match(E.try('ADMIN', `select public.admin_mark_edition_test('${ORG_A}', '${t}')`).replace(/\s+/g, ' '), /^(?!.*ERROR)/);
    assert.match(E.try('OWNER_A', `select public.admin_mark_edition_test('${ORG_A}', '${t}')`), /admins only/);
    E.do('ADMIN', `select public.admin_mark_edition_test('${ORG_A}', '${t}')`);
    assert.match(E.try('OWNER_A', `select public.edition_set_status('${t}', 'published')`), /no live publish entitlement/);
    E.do('ADMIN', `select public.admin_grant_edition_entitlement('${t}', 'publish', now(), now() + interval '30 days', 'ZZ TEST private test edition')`);
    E.do('OWNER_A', `select public.edition_set_status('${t}', 'published')`);
    assert.equal(E.q(`select status from editions where id='${t}'`), 'published');
    assert.equal(E.one('anon', `select count(*) from public.editions where id='${t}'`), '0', 'test edition invisible to the public');
    assert.equal(E.one('EDITOR_A', `select count(*) from public.editions where id='${t}'`), '1', 'visible to its members');
    assert.equal(E.q(`select is_test::text from edition_organisers where id='${ORG_A}'`), 'true', 'the whole organiser was marked test too');
    // undo the marker so later tests still treat organiser A as public
    E.sup(`select set_config('app.edition_test_mark','on',false); update edition_organisers set is_test=false where id='${ORG_A}';`);
  });
});

describe('O6/O9/S10 programme, pages, updates and sponsors', () => {
  const ins = (who: Who, table: string, cols: string, vals: string) => E.try(who, `insert into public.${table} (${cols}) values (${vals})`);
  test('editors can build content for their own edition; outsiders cannot', () => {
    // (the welcome page was built by the editor in the publish-gate section above)
    assert.ok(!failed(E.do('EDITOR_A', `insert into public.edition_pages (edition_id, slug, nav_label, title, body, position) values ('${ED_A}','visit','Visit','Visit us','Getting here', 1)`)));
    assert.ok(failed(ins('OWNER_B', 'edition_pages', 'edition_id, slug, nav_label, title', `'${ED_A}','x','X','X'`)));
    assert.ok(failed(ins('anon', 'edition_pages', 'edition_id, slug, nav_label, title', `'${ED_A}','x','X','X'`)));
    assert.ok(failed(ins('VISITOR', 'edition_updates', 'edition_id, title', `'${ED_A}','x'`)));
  });
  test('one home page only; slugs unique per edition; script/iframe content refused', () => {
    assert.ok(failed(ins('EDITOR_A', 'edition_pages', 'edition_id, slug, nav_label, title, is_home', `'${ED_A}','second-home','Home2','Home2', true`)));
    assert.ok(failed(ins('EDITOR_A', 'edition_pages', 'edition_id, slug, nav_label, title', `'${ED_A}','visit','Visit','dup'`)));
    assert.ok(failed(ins('EDITOR_A', 'edition_pages', 'edition_id, slug, nav_label, title, body', `'${ED_A}','evil','E','E','<script>alert(1)</script>'`)));
    assert.ok(failed(ins('EDITOR_A', 'edition_updates', 'edition_id, title, body', `'${ED_A}','E','<iframe src=x></iframe>'`)));
  });
  test('venues belong to the organiser; a session cannot use another organiser’s venue', () => {
    const vA = last(E.do('EDITOR_A', `insert into public.edition_venues (organiser_id, name, address) values ('${ORG_A}','ZZ TEST Hall','1 Sample Road') returning id`));
    const vB = last(E.do('OWNER_B', `insert into public.edition_venues (organiser_id, name) values ('${ORG_B}','ZZ Other Hall') returning id`));
    assert.ok(failed(ins('OWNER_B', 'edition_venues', 'organiser_id, name', `'${ORG_A}','sneaky'`)));
    assert.ok(failed(E.try('EDITOR_A', `insert into public.edition_sessions (edition_id, title, starts_at, venue_id) values ('${ED_A}','Talk', ${d(10)}::timestamptz + interval '10 hours', '${vB}')`)));
    assert.ok(!failed(E.do('EDITOR_A', `insert into public.edition_sessions (edition_id, title, starts_at, ends_at, venue_id, ticket_mode, ticket_url, price_text) values ('${ED_A}','ZZ TEST Opening', ${d(10)}::timestamptz + interval '10 hours', ${d(10)}::timestamptz + interval '12 hours','${vA}','external','https://tickets.example/zz','Sample £5')`)));
  });
  test('sessions must fall inside the edition dates and ticket links must be https and consistent', () => {
    assert.match(E.try('EDITOR_A', `insert into public.edition_sessions (edition_id, title, starts_at) values ('${ED_A}','Too early', ${d(1)}::timestamptz)`), /outside the edition dates/);
    assert.match(E.try('EDITOR_A', `insert into public.edition_sessions (edition_id, title, starts_at) values ('${ED_A}','Too late', ${d(40)}::timestamptz)`), /outside the edition dates/);
    assert.ok(failed(E.try('EDITOR_A', `insert into public.edition_sessions (edition_id, title, starts_at, ticket_mode, ticket_url) values ('${ED_A}','Bad link', ${d(11)}::timestamptz, 'external','http://nope.example')`)));
    assert.ok(failed(E.try('EDITOR_A', `insert into public.edition_sessions (edition_id, title, starts_at, ticket_mode) values ('${ED_A}','No url', ${d(11)}::timestamptz, 'external')`)));
    assert.ok(failed(E.try('EDITOR_A', `insert into public.edition_sessions (edition_id, title, starts_at, ends_at) values ('${ED_A}','Backwards', ${d(11)}::timestamptz, ${d(10)}::timestamptz)`)));
  });
  test('updates and sponsors: pinned/draft handling and https links', () => {
    assert.ok(!failed(E.do('EDITOR_A', `insert into public.edition_updates (edition_id, title, body, pinned, published_at) values ('${ED_A}','ZZ TEST announcement','Sample body', true, now())`)));
    assert.ok(!failed(E.do('EDITOR_A', `insert into public.edition_updates (edition_id, title) values ('${ED_A}','ZZ TEST draft update')`)));
    assert.equal(E.q(`select count(*) from edition_updates where created_by='${U.EDITOR_A}'`), '2', 'created_by is stamped from the session');
    assert.ok(!failed(E.do('EDITOR_A', `insert into public.edition_sponsors (edition_id, name, level, url) values ('${ED_A}','ZZ TEST Sponsor','Sample level','https://example.com')`)));
    assert.ok(failed(ins('EDITOR_A', 'edition_sponsors', 'edition_id, name, url', `'${ED_A}','Bad','javascript:alert(1)'`)));
  });
  test('the public reads the programme of a public edition and nothing else', () => {
    flag(true);
    assert.equal(E.one('anon', `select count(*) from public.edition_pages where edition_id='${ED_A}'`), '2');
    assert.equal(E.one('anon', `select count(*) from public.edition_sessions where edition_id='${ED_A}'`), '1');
    assert.equal(E.one('anon', `select count(*) from public.edition_sponsors where edition_id='${ED_A}'`), '1');
    assert.equal(E.one('anon', `select count(*) from public.edition_venues`), '1', 'only the venue used by a public session');
    assert.equal(E.one('anon', `select count(*) from public.edition_updates where edition_id='${ED_A}' and published_at <= now()`), '1');
    // organiser B’s content (a draft) stays hidden
    E.do('OWNER_B', `insert into public.edition_pages (edition_id, slug, nav_label, title) values ('${ED_B}','p','P','P')`);
    assert.equal(E.one('anon', `select count(*) from public.edition_pages where edition_id='${ED_B}'`), '0');
    assert.equal(E.one('OWNER_A', `select count(*) from public.edition_pages where edition_id='${ED_B}'`), '0');
    flag(false);
  });
  test('deleting an edition cascades its content but only drafts can be deleted by organisers', () => {
    assert.ok(failed(E.try('OWNER_A', `delete from public.editions where id='${ED_A}'`)) || E.one('OWNER_A', `select count(*) from public.editions where id='${ED_A}'`) === '1');
    const dr = last(E.do('ADMIN_A', `insert into public.editions (organiser_id, slug, title, kind, starts_on, ends_on) values ('${ORG_A}','zz-delete-me','Del','single_day',${d(3)},${d(3)}) returning id`));
    E.do('ADMIN_A', `insert into public.edition_pages (edition_id, slug, nav_label, title) values ('${dr}','p','P','P')`);
    E.do('ADMIN_A', `delete from public.editions where id='${dr}'`);
    assert.equal(E.q(`select count(*) from edition_pages where edition_id='${dr}'`), '0');
    assert.equal(E.q(`select count(*) from editions where id='${dr}'`), '0');
  });
});

describe('A2/A6/A7 moderation, audit and series', () => {
  test('only administrators can suspend and restore (moderators cannot); organisers cannot republish a suspended edition', () => {
    flag(true);
    assert.ok(failed(E.try('OWNER_A', `select public.edition_moderate('${ED_A}', 'suspend', 'ZZ TEST abusive')`)));
    assert.ok(failed(E.try('VISITOR', `select public.edition_moderate('${ED_A}', 'suspend', 'ZZ TEST abusive')`)));
    assert.match(E.try('MOD', `select public.edition_moderate('${ED_A}', 'suspend', 'ZZ TEST misleading branding')`), /admins only/, 'moderators have no suspension route');
    assert.match(E.try('ADMIN', `select public.edition_moderate('${ED_A}', 'suspend', 'x')`), /reason is required/);
    E.do('ADMIN', `select public.edition_moderate('${ED_A}', 'suspend', 'ZZ TEST misleading branding')`);
    assert.equal(E.one('anon', `select count(*) from public.editions where id='${ED_A}'`), '0', 'hidden at once');
    assert.match(E.try('OWNER_A', `select public.edition_set_status('${ED_A}', 'published')`), /suspended by OneShetland/);
    assert.match(E.try('MOD', `select public.edition_moderate('${ED_A}', 'restore', 'resolved')`), /admins only/);
    E.do('ADMIN', `select public.edition_moderate('${ED_A}', 'restore', 'resolved')`);
    assert.equal(E.q(`select status from editions where id='${ED_A}'`), 'draft', 'restored to draft, never straight back to published');
    E.do('OWNER_A', `select public.edition_set_status('${ED_A}', 'published')`);
    assert.equal(E.one('anon', `select count(*) from public.editions where id='${ED_A}'`), '1');
    flag(false);
  });
  test('A6 the audit log recorded the sensitive actions and is invisible to other organisers', () => {
    const acts = E.q(`select string_agg(distinct action, ',' order by action) from edition_audit_log where organiser_id='${ORG_A}'`);
    for (const a of ['organiser_created_from_hub', 'edition_submitted', 'edition_review_approve', 'member_invited', 'member_joined', 'entitlement_granted', 'entitlement_voided', 'edition_status', 'organiser_status', 'edition_suspend', 'edition_restore']) {
      assert.ok(acts.split(',').includes(a), `missing audit action ${a}: ${acts}`);
    }
    assert.equal(E.one('OWNER_B', `select count(*) from public.edition_audit_log where organiser_id='${ORG_A}'`), '0');
    assert.ok(Number(E.one('ADMIN_A', `select count(*) from public.edition_audit_log where organiser_id='${ORG_A}'`)) > 5);
    assert.ok(failed(E.try('OWNER_A', `delete from public.edition_audit_log`)));
    assert.ok(failed(E.try('ADMIN', `insert into public.edition_audit_log (action) values ('forged')`)));
  });
  test('O11 an organiser can keep several editions in one series (annual repeats)', () => {
    const s = last(E.do('ADMIN_A', `insert into public.edition_series (organiser_id, name) values ('${ORG_A}','ZZ TEST Annual') returning id`));
    assert.ok(failed(E.try('EDITOR_A', `insert into public.edition_series (organiser_id, name) values ('${ORG_A}','nope')`)));
    assert.ok(failed(E.try('OWNER_B', `insert into public.edition_series (organiser_id, name) values ('${ORG_A}','nope')`)));
    E.do('ADMIN_A', `update public.editions set series_id='${s}', year_label='2027' where id='${ED_A}'`);
    const y2 = last(E.do('ADMIN_A', `insert into public.editions (organiser_id, series_id, slug, title, kind, starts_on, ends_on, year_label) values ('${ORG_A}','${s}','zz-test-edition-2028','ZZ TEST 2028','multi_day',${d(400)},${d(402)},'2028') returning id`));
    assert.equal(E.q(`select count(*) from editions where series_id='${s}'`), '2');
    assert.ok(y2);
  });
});

describe('S7/S12 existing functionality is untouched', () => {
  test('no existing table gained a column or trigger from Editions, except the two name-follows-its-parent triggers (hubs, local_businesses)', () => {
    assert.equal(E.q(`select count(*) from information_schema.columns where table_schema='public' and table_name in ('local_businesses','events','hubs','hub_members','saved_items','event_ticket_orders') and column_name like '%edition%'`), '0');
    assert.equal(E.q(`select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid where c.relname in ('events','hub_members') and t.tgname like '%edition%'`), '0');
    assert.equal(E.q(`select string_agg(c.relname || '.' || t.tgname, ',' order by c.relname) from pg_trigger t join pg_class c on c.oid=t.tgrelid where c.relname in ('local_businesses','hubs') and t.tgname like '%edition%' and not t.tgisinternal`), 'hubs.edition_sync_hub_name,local_businesses.edition_sync_business_name');
  });
  test('the storage bucket and its organiser-scoped policies exist', () => {
    assert.equal(E.q(`select count(*) from storage.buckets where id='edition-media' and public and file_size_limit = 10485760`), '1');
    assert.equal(E.q(`select count(*) from pg_policies where schemaname='storage' and policyname like 'edition-media %'`), '4');
  });
  test('analytics definitions registered', () => {
    assert.equal(E.q(`select count(*) from analytics_event_defs where event_name in ('edition_viewed','edition_session_viewed','edition_ticket_clicked')`), '3');
  });
});
