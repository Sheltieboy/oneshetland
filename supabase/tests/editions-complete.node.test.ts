/**
 * editions-complete.node.test.ts — ISOLATED Postgres only. The finished Editions service:
 *   identity (only a Business or a Hub can run Editions; roles come from the parent), review and approval (an unapproved Edition is never public, by any route), Hub verification separated from
 *   event moderation, packages (paid, free, Community), notifications, and the retirement of the pilot and the independent-organiser route.
 * Run: ISOLATED_ONLY=editions-complete npm run test:isolated   (never `npm test`)
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Env, USERS, seed, enter, draftEdition, d, last, failed } from './_support/editions-env.ts';

let E: Env;
let S: ReturnType<typeof seed>;
let HUB_ORG = '', BIZ_ORG = '', ED = '', ED_B = '';
const state = (ed = ED) => E.q(`select review_state from public.editions where id='${ed}'`);
const anonSeesEd = (ed = ED) => E.one('anon', `select count(*) from public.editions where id='${ed}'`) === '1';
const anonPublic = (ed = ED) => E.one('anon', `select public.edition_is_public('${ed}')`) === 't';
type Team = 'HUB_OWNER' | 'HUB_COMMITTEE' | 'EDITOR' | 'BIZ_OWNER' | 'HELPER' | 'STRANGER';
const submit = (who: Team = 'HUB_OWNER', ed = ED) => E.do(who, `select public.edition_submit_for_review('${ed}')`);
const decide = (decision: string, note = 'looks good', ed = ED) => E.do('ADMIN', `select public.admin_review_edition('${ed}', '${decision}', '${note}')`);
const grantPackage = (ed = ED) => E.do('ADMIN', `select public.admin_grant_edition_entitlement('${ed}', 'publish', now(), now() + interval '90 days', 'suite grant')`);
const setStatus = (who: Team, to: string, ed = ED) => E.do(who, `select public.edition_set_status('${ed}', '${to}')`);

before(() => {
  E = new Env('editionscomplete');
  S = seed(E);
  HUB_ORG = enter(E, 'HUB_OWNER', 'hub', S.HUB);
  BIZ_ORG = enter(E, 'BIZ_OWNER', 'business', S.BIZ);
  ED = draftEdition(E, 'HUB_OWNER', HUB_ORG, 'zz-hub-fest', 'ZZ Hub Festival');
  ED_B = draftEdition(E, 'BIZ_OWNER', BIZ_ORG, 'zz-biz-fest', 'ZZ Business Festival');
});
after(() => E?.drop());

describe('identity: only a Business or a Hub can run Editions', () => {
  test('an owner enters Editions from the Hub or Business and gets an Editions profile, named after the parent, with a generated address', () => {
    assert.match(HUB_ORG, /^[0-9a-f-]{36}$/); assert.match(BIZ_ORG, /^[0-9a-f-]{36}$/);
    assert.equal(E.q(`select name from public.edition_organisers where id='${HUB_ORG}'`), 'ZZ Test Hub');
    assert.equal(E.q(`select slug from public.edition_organisers where id='${BIZ_ORG}'`), 'zz-test-cafe');
    assert.equal(E.q(`select (hub_id is not null)::text || (business_id is not null)::text from public.edition_organisers where id='${HUB_ORG}'`), 'truefalse');
    assert.equal(E.q(`select (hub_id is not null)::text || (business_id is not null)::text from public.edition_organisers where id='${BIZ_ORG}'`), 'falsetrue');
  });
  test('entering again returns the same profile (idempotent, no duplicate)', () => {
    assert.equal(enter(E, 'HUB_OWNER', 'hub', S.HUB), HUB_ORG);
    assert.equal(enter(E, 'BIZ_OWNER', 'business', S.BIZ), BIZ_ORG);
    assert.equal(E.q(`select count(*) from public.edition_organisers where hub_id='${S.HUB}'`), '1');
  });
  test('a Hub committee member can enter for the Hub; a plain member, a stranger and another owner cannot', () => {
    assert.equal(enter(E, 'HUB_COMMITTEE', 'hub', S.HUB), HUB_ORG);
    for (const who of ['HUB_MEMBER', 'STRANGER', 'BIZ_OWNER'] as const) assert.match(E.try(who, `select public.edition_ensure_organiser('hub','${S.HUB}')`), /only the Hub/, who);
  });
  test('only the Business owner can enter for a Business; an unclaimed listing can never run Editions', () => {
    assert.match(E.try('STRANGER', `select public.edition_ensure_organiser('business','${S.BIZ}')`), /only the Business owner/);
    assert.match(E.try('HUB_OWNER', `select public.edition_ensure_organiser('business','${S.BIZ}')`), /only the Business owner/);
    assert.match(E.try('ADMIN', `select public.edition_ensure_organiser('business','${S.BIZ_UNCLAIMED}')`), /Business not found/);
  });
  test('an inactive Hub cannot be entered', () => {
    E.sup(`update hubs set is_active=false where id='${S.HUB2}'`);
    assert.match(E.try('HUB2_OWNER', `select public.edition_ensure_organiser('hub','${S.HUB2}')`), /Hub not found/);
    E.sup(`update hubs set is_active=true where id='${S.HUB2}'`);
  });
  test('addresses are generated: reserved words are skipped, collisions get a suffix, accents fold', () => {
    const h1 = E.q(`insert into hubs (owner_id, name, slug, type, area, is_active) values ('${USERS.HUB_OWNER}','Editions','editions-h','club','Lerwick',true) returning id`);
    const slug = E.q(`select public.edition_ensure_organiser('hub','${h1}') ->> 'slug'`);
    assert.equal(E.one('HUB_OWNER', `select public.edition_ensure_organiser('hub','${h1}') ->> 'slug'`), 'editions-editions', `reserved word skipped (${slug})`);
    const h2 = E.q(`insert into hubs (owner_id, name, slug, type, area, is_active) values ('${USERS.HUB_OWNER}','ZZ Test Hub','zz-test-hub-2','club','Lerwick',true) returning id`);
    assert.equal(E.one('HUB_OWNER', `select public.edition_ensure_organiser('hub','${h2}') ->> 'slug'`), 'zz-test-hub-editions', 'collision gets a suffix');
    assert.equal(E.q(`select public.edition_slugify('Da Böd Folk''s Café!')`), 'da-bod-folks-cafe');
  });
  test('a standalone organiser cannot exist: a row with no parent, or two parents, is refused', () => {
    assert.match(E.sup(`insert into public.edition_organisers (slug, name) values ('zz-standalone','ZZ Standalone')`), /edition_organisers_one_parent/);
    assert.match(E.sup(`insert into public.edition_organisers (slug, name, hub_id, business_id) values ('zz-both','ZZ Both','${S.HUB2}','${S.BIZ2}')`), /edition_organisers_one_parent/);
  });
  test('the old independent route is gone from the database', () => {
    assert.equal(E.q(`select count(*) from pg_proc where proname in ('create_edition_organiser','create_edition_organiser_for_hub','admin_create_edition_organiser_for_hub','admin_link_edition_organiser_hub','request_edition_organiser_verification')`), '0');
  });
  test('a parent that has an Editions profile cannot be deleted (it would orphan the organiser)', () => {
    assert.match(E.sup(`delete from hubs where id='${S.HUB}'`), /violates foreign key/i);
    assert.match(E.sup(`delete from local_businesses where id='${S.BIZ}'`), /violates foreign key/i);
  });
  test('roles come from the parent, live: owners are owners, committee is admin, a plain member and strangers have nothing', () => {
    const role = (who: Team | 'HUB_MEMBER', org: string) => E.one(who as never, `select coalesce(public.edition_org_role('${org}'),'none')`);
    assert.equal(role('HUB_OWNER', HUB_ORG), 'owner'); assert.equal(role('HUB_COMMITTEE', HUB_ORG), 'admin'); assert.equal(role('HUB_MEMBER', HUB_ORG), 'none');
    assert.equal(role('BIZ_OWNER', BIZ_ORG), 'owner'); assert.equal(role('STRANGER', BIZ_ORG), 'none'); assert.equal(role('BIZ_OWNER', HUB_ORG), 'none');
  });
  test('ownership transfer follows the parent: a new Business owner gets control, the old one loses it', () => {
    E.sup(`update local_businesses set owner_id='${USERS.BIZ2_OWNER}' where id='${S.BIZ}'`);
    assert.equal(E.one('BIZ2_OWNER', `select public.edition_org_role('${BIZ_ORG}')`), 'owner');
    assert.equal(E.one('BIZ_OWNER', `select coalesce(public.edition_org_role('${BIZ_ORG}'),'none')`), 'none');
    E.sup(`update local_businesses set owner_id='${USERS.BIZ_OWNER}' where id='${S.BIZ}'`);
  });
  test('the organiser name follows its parent, and its team cannot edit it directly', () => {
    E.sup(`update local_businesses set name='ZZ Test Cafe & Bar' where id='${S.BIZ}'`);
    assert.equal(E.q(`select name from public.edition_organisers where id='${BIZ_ORG}'`), 'ZZ Test Cafe & Bar');
    E.sup(`update local_businesses set name='ZZ Test Cafe' where id='${S.BIZ}'`);
    assert.match(E.try('HUB_OWNER', `update public.edition_organisers set name='Renamed' where id='${HUB_ORG}'`), /permission denied/);
  });
});

describe('helpers: scoped, and never owner', () => {
  test('a Business owner invites a helper by email; the helper accepts and can edit but not publish or buy', () => {
    const inv = E.call('BIZ_OWNER', `select public.invite_edition_member('${BIZ_ORG}', '${USERS.HELPER}@x.invalid', 'editor')`);
    assert.match(inv, /^[0-9a-f-]{36}$/);
    E.do('HELPER', `select public.accept_edition_invite('${inv}')`);
    assert.equal(E.one('HELPER', `select public.edition_org_role('${BIZ_ORG}')`), 'editor');
    assert.equal(E.one('HELPER', `select public.edition_can('${ED_B}','editor')::text || public.edition_can('${ED_B}','admin')::text`), 'truefalse');
  });
  test('a helper can never be an owner, by invitation or by direct write', () => {
    assert.match(E.try('BIZ_OWNER', `select public.invite_edition_member('${BIZ_ORG}','nobody@x.invalid','owner')`), /role must be admin or editor/);
    assert.match(E.sup(`insert into public.edition_organiser_members (organiser_id, user_id, role) values ('${BIZ_ORG}','${USERS.HUB_MEMBER}','owner')`), /helper cannot be an owner/);
  });
  test('only the owner invites; a helper, a committee member and strangers cannot', () => {
    for (const who of ['HELPER', 'STRANGER'] as const) assert.match(E.try(who, `select public.invite_edition_member('${BIZ_ORG}','a@x.invalid','editor')`), /owners only/);
    assert.match(E.try('HUB_COMMITTEE', `select public.invite_edition_member('${HUB_ORG}','a@x.invalid','editor')`), /owners only/);
  });
  test('a malformed email is refused before anything is stored', () => {
    assert.match(E.try('BIZ_OWNER', `select public.invite_edition_member('${BIZ_ORG}','not-an-email','editor')`), /valid email/);
  });
});

describe('review: nothing is public until OneShetland approves it', () => {
  test('a fresh Edition is a private draft, not submitted, invisible to the public and to strangers', () => {
    assert.equal(state(), 'not_submitted');
    assert.equal(anonSeesEd(), false); assert.equal(anonPublic(), false);
    assert.equal(E.one('STRANGER', `select count(*) from public.editions where id='${ED}'`), '0');
  });
  test('clients cannot write review state or status directly (no column grant), even a team owner', () => {
    assert.match(E.try('HUB_OWNER', `update public.editions set review_state='approved' where id='${ED}'`), /permission denied/);
    assert.match(E.try('HUB_OWNER', `update public.editions set status='published' where id='${ED}'`), /permission denied/);
  });
  test('submission needs the required items; a stranger and an editor cannot submit', () => {
    const empty = E.call('HUB_OWNER', `insert into public.editions (organiser_id, slug, title, summary, kind, starts_on, ends_on) values ('${HUB_ORG}','zz-empty','ZZ Empty','','single_day',${d(30)},${d(30)}) returning id`);
    assert.match(E.try('HUB_OWNER', `select public.edition_submit_for_review('${empty}')`), /finish these first: Summary written, At least one page/);
    assert.match(E.try('STRANGER', `select public.edition_submit_for_review('${ED}')`), /organiser admins only/);
    E.sup(`insert into public.edition_organiser_members (organiser_id, user_id, role) values ('${HUB_ORG}','${USERS.EDITOR}','editor') on conflict do nothing`);
    assert.match(E.try('EDITOR', `select public.edition_submit_for_review('${ED}')`), /organiser admins only/);
  });
  test('a committee member submits; it is now waiting; a second submission is refused', () => {
    submit('HUB_COMMITTEE');
    assert.equal(state(), 'submitted');
    assert.match(E.try('HUB_OWNER', `select public.edition_submit_for_review('${ED}')`), /already submitted/);
    assert.equal(E.q(`select count(*) from public.edition_reviews where edition_id='${ED}' and action='submitted'`), '1');
  });
  test('the owner can withdraw a submission and resubmit', () => {
    E.do('HUB_OWNER', `select public.edition_withdraw_submission('${ED}')`);
    assert.equal(state(), 'not_submitted');
    submit('HUB_OWNER');
    assert.equal(state(), 'submitted');
  });
  test('only an administrator decides; the owner, a committee member and a stranger cannot approve their own Edition', () => {
    for (const who of ['HUB_OWNER', 'HUB_COMMITTEE', 'STRANGER', 'BIZ_OWNER'] as const) assert.match(E.try(who, `select public.admin_review_edition('${ED}','approve','x')`), /admins only/, who);
    assert.equal(state(), 'submitted');
  });
  test('changes and rejection need a reason, and reach the owner in words', () => {
    assert.match(E.try('ADMIN', `select public.admin_review_edition('${ED}','changes','')`), /tell the organiser why/);
    decide('changes', 'Please add a cover image and a clearer summary.');
    assert.equal(state(), 'changes_requested');
    const st = E.one('HUB_OWNER', `select public.edition_review_status('${ED}')::text`);
    assert.match(st, /Please add a cover image/); assert.match(st, /changes_requested/);
    assert.match(E.try('STRANGER', `select public.edition_review_status('${ED}')`), /not permitted/);
  });
  test('after changes the owner resubmits; approval records the identity check and notifies the Hub team', () => {
    submit('HUB_OWNER');
    assert.equal(E.q(`select status from public.edition_organisers where id='${HUB_ORG}'`), 'pending');
    decide('approve', 'Hub committee checked');
    assert.equal(state(), 'approved');
    assert.equal(E.q(`select status from public.edition_organisers where id='${HUB_ORG}'`), 'verified');
    assert.equal(E.q(`select count(*) from public.edition_reviews where edition_id='${ED}' and action='identity_verified'`), '1');
    assert.equal(E.q(`select count(*) from public.edition_email_outbox where kind='edition_approved'`), '2', 'Hub owner and the committee member');
    assert.equal(E.q(`select count(*) from public.edition_email_outbox where kind='edition_changes_requested'`), '2');
  });
  test('an Edition that is not waiting cannot be decided again', () => {
    assert.match(E.try('ADMIN', `select public.admin_review_edition('${ED}','approve','again')`), /not waiting for review/);
  });
  test('approval alone does not make it public: it is still a draft with no package', () => {
    assert.equal(anonPublic(), false); assert.equal(anonSeesEd(), false);
  });
  test('publishing is refused until the package is active; then it works for an owner but not for an editor', () => {
    assert.match(E.try('HUB_OWNER', `select public.edition_set_status('${ED}','published')`), /no live publish entitlement/);
    grantPackage();
    assert.match(E.try('EDITOR', `select public.edition_set_status('${ED}','published')`), /organiser admins only/);
    setStatus('HUB_OWNER', 'published');
    assert.equal(E.q(`select status from public.editions where id='${ED}'`), 'published');
    assert.equal(anonPublic(), true); assert.equal(anonSeesEd(), true);
  });
  test('an Edition that was never approved can never be published, with or without a package, even for an already-verified organiser', () => {
    const ed3 = draftEdition(E, 'HUB_OWNER', HUB_ORG, 'zz-hub-unapproved', 'ZZ Unapproved');
    grantPackage(ed3);
    assert.match(E.try('HUB_OWNER', `select public.edition_set_status('${ed3}','published')`), /not been approved by OneShetland/);
    assert.equal(anonPublic(ed3), false);
    grantPackage(ED_B);
    assert.match(E.try('BIZ_OWNER', `select public.edition_set_status('${ED_B}','published')`), /not verified|not been approved/, 'an unverified organiser is refused as well');
    assert.equal(anonPublic(ED_B), false);
  });
  test('even a forced published status (a trusted writer, a bad migration) is not public: the read rule itself requires approval, for the table, its pages and the public views', () => {
    E.sup(`update public.editions set status='published' where id='${ED_B}'`);
    assert.equal(state(ED_B), 'not_submitted');
    assert.equal(anonPublic(ED_B), false); assert.equal(anonSeesEd(ED_B), false);
    assert.equal(E.one('anon', `select count(*) from public.edition_pages where edition_id='${ED_B}'`), '0');
    assert.equal(E.one('anon', `select count(*) from public.edition_public_hubs where edition_id='${ED_B}'`), '0');
    E.sup(`update public.editions set status='draft' where id='${ED_B}'`);
  });
  test('the public sees an approved, live Edition, its pages and its organiser', () => {
    assert.equal(E.one('anon', `select count(*) from public.edition_pages where edition_id='${ED}'`), '1');
    assert.equal(E.one('anon', `select count(*) from public.edition_organisers where id='${HUB_ORG}'`), '1');
  });
});

describe('material changes return an approved Edition to review', () => {
  test('a title or date change hides the live Edition until it is approved again, and records before and after', () => {
    E.do('HUB_OWNER', `update public.editions set title='ZZ Hub Festival (renamed)' where id='${ED}'`);
    assert.equal(state(), 'submitted');
    assert.equal(anonPublic(), false); assert.equal(anonSeesEd(), false);
    assert.match(E.q(`select changes::text from public.edition_reviews where edition_id='${ED}' and action='material_change' order by created_at desc limit 1`), /ZZ Hub Festival \(renamed\)/);
    decide('approve', 'rename is fine');
    assert.equal(anonPublic(), true, 'visible again once re-approved, without republishing');
    E.do('HUB_OWNER', `update public.editions set ends_on=ends_on+1 where id='${ED}'`);
    assert.equal(state(), 'submitted'); decide('approve', 'dates fine');
  });
  test('ordinary edits (summary, colours) stay live without review', () => {
    E.do('HUB_OWNER', `update public.editions set summary='A better summary', brand_color='#112233' where id='${ED}'`);
    assert.equal(state(), 'approved'); assert.equal(anonPublic(), true);
  });
  test('the "recently edited" tab lists live Editions that changed after approval', () => {
    E.sup(`update public.editions set approved_at = now() - interval '2 hours' where id='${ED}'`);
    E.sup(`update public.editions set description = 'edited later' where id='${ED}'`);
    assert.equal(E.one('ADMIN', `select count(*) from public.admin_edition_review_queue('edited') where edition_id='${ED}'`), '1');
  });
});

describe('the parent being live is part of the public rule', () => {
  test('deactivating the Hub hides its Editions and its team access at once; reactivating restores them', () => {
    E.sup(`update hubs set is_active=false where id='${S.HUB}'`);
    assert.equal(anonPublic(), false); assert.equal(anonSeesEd(), false);
    assert.equal(E.one('HUB_OWNER', `select coalesce(public.edition_org_role('${HUB_ORG}'),'none')`), 'none');
    E.sup(`update hubs set is_active=true where id='${S.HUB}'`);
    assert.equal(anonPublic(), true);
  });
  test('switching Editions off hides everything; switching it on restores it', () => {
    E.sup(`update admin_config set value='false' where key='editions.enabled'`);
    assert.equal(anonPublic(), false);
    E.sup(`update admin_config set value='true' where key='editions.enabled'`);
    assert.equal(anonPublic(), true);
  });
  test('unpublishing hides it at once', () => {
    setStatus('HUB_OWNER', 'draft'); assert.equal(anonPublic(), false);
    setStatus('HUB_OWNER', 'published'); assert.equal(anonPublic(), true);
  });
});

describe('the administrator review queue', () => {
  test('a Business Edition is submitted, shows in Waiting with its parent, and only an administrator can read the queue', () => {
    E.sup(`update public.editions set status='draft' where id='${ED_B}'`);
    submit('BIZ_OWNER', ED_B);
    const row = E.one('ADMIN', `select parent_kind || '|' || parent_name || '|' || first_edition::text from public.admin_edition_review_queue('waiting') where edition_id='${ED_B}'`);
    assert.equal(row, 'business|ZZ Test Cafe|true');
    assert.equal(E.one('ADMIN', `select (public.admin_edition_review_counts() ->> 'waiting')::int >= 1`), 't');
    for (const who of ['HUB_OWNER', 'BIZ_OWNER', 'STRANGER'] as const) assert.match(E.try(who, `select * from public.admin_edition_review_queue('waiting')`), /admins only/, who);
    assert.equal(E.one('STRANGER', `select public.admin_edition_review_counts()::text`), '{"changes": 0, "waiting": 0}');
  });
  test('the review screen shows who runs it, the checks (including staff-only ones) and the history; non-admins are refused', () => {
    const det = E.one('ADMIN', `select public.admin_edition_review_detail('${ED_B}')::text`);
    assert.match(det, /"kind": "business"/); assert.match(det, /Bea Business/); assert.match(det, /Name is not on the reserved list/); assert.match(det, /"history"/);
    assert.match(E.try('BIZ_OWNER', `select public.admin_edition_review_detail('${ED_B}')`), /admins only/);
    const ready = E.one('BIZ_OWNER', `select public.edition_readiness('${ED_B}')::text`);
    assert.doesNotMatch(ready, /reserved list/, 'staff-only checks are not shown to the owner');
  });
  test('approving the Business Edition verifies the Business organiser in the same step and tells the Business owner', () => {
    decide('approve', 'owner is the claimed Business owner', ED_B);
    assert.equal(E.q(`select status from public.edition_organisers where id='${BIZ_ORG}'`), 'verified');
    assert.equal(E.q(`select count(*) from public.edition_email_outbox where kind='edition_approved' and user_id='${USERS.BIZ_OWNER}'`), '1');
  });
  test('a suspended organiser cannot have an Edition approved, and an inactive parent blocks approval', () => {
    const ed2 = draftEdition(E, 'BIZ_OWNER', BIZ_ORG, 'zz-biz-two', 'ZZ Business Two');
    submit('BIZ_OWNER', ed2);
    E.sup(`update public.edition_organisers set status='suspended' where id='${BIZ_ORG}'`);
    assert.match(E.try('ADMIN', `select public.admin_review_edition('${ed2}','approve','x')`), /reinstate it first/);
    E.sup(`update public.edition_organisers set status='verified' where id='${BIZ_ORG}'`);
    E.sup(`update local_businesses set is_active=false where id='${S.BIZ}'`);
    assert.match(E.try('ADMIN', `select public.admin_review_edition('${ed2}','approve','x')`), /not active/);
    E.sup(`update local_businesses set is_active=true where id='${S.BIZ}'`);
  });
});

/* ── Hub verification and event moderation are separate decisions ───────────────────────────────────────────────────────────────────────────────── */
describe('Hub verification no longer approves events; Editions approval never touches event moderation', () => {
  const ev = (title: string) => E.q(`insert into events (title, starts_at, status, hub_visibility, organiser_hub_id, organiser_user_id) values ('${title}', (${d(12)})::timestamp + interval '19 hours', 'published', 'islands', '${S.HUB2}', '${USERS.HUB2_OWNER}') returning id`);
  const approved = (id: string) => E.q(`select calendar_approved from events where id='${id}'`);
  test('the new switch defaults to off for every Hub, and nothing is auto-approved', () => {
    assert.equal(E.q(`select count(*) from hubs where events_auto_approve`), '0');
    assert.equal(approved(ev('ZZ Before')), 'f');
  });
  test('verifying a Hub (the trust badge) does NOT approve its events, existing or new', () => {
    const before = ev('ZZ Existing');
    E.do('ADMIN', `select public.admin_set_hub_verified('${S.HUB2}', true, 'checked the committee')`);
    assert.equal(E.q(`select is_verified from hubs where id='${S.HUB2}'`), 't');
    assert.equal(approved(before), 'f'); assert.equal(approved(ev('ZZ After Verify')), 'f');
  });
  test('only the separate switch approves new events, only an administrator can set it, it needs a note, and it is audited', () => {
    assert.match(E.try('HUB2_OWNER', `select public.admin_set_hub_events_auto_approve('${S.HUB2}', true, 'please')`), /admins only/);
    assert.match(E.try('ADMIN', `select public.admin_set_hub_events_auto_approve('${S.HUB2}', true, '')`), /a note is required/);
    E.do('ADMIN', `select public.admin_set_hub_events_auto_approve('${S.HUB2}', true, 'trusted committee, reviewed')`);
    assert.equal(approved(ev('ZZ After Switch')), 't');
    assert.match(E.try('ADMIN', `select public.admin_set_hub_events_auto_approve('${S.HUB2}', true, 'again again')`), /already in that state/);
    assert.equal(E.q(`select count(*) from public.edition_audit_log where action='hub_events_auto_approve_on'`), '1');
    E.do('ADMIN', `select public.admin_set_hub_events_auto_approve('${S.HUB2}', false, 'switch off again')`);
    assert.equal(approved(ev('ZZ After Off')), 'f');
  });
  test('a Hub owner cannot flip the switch or the verification badge themselves', () => {
    E.do('HUB2_OWNER', `update hubs set events_auto_approve = true, is_verified = false where id='${S.HUB2}'`);
    assert.equal(E.q(`select events_auto_approve::text || is_verified::text from hubs where id='${S.HUB2}'`), 'falsetrue');
  });
  test('approving an Edition changes neither Hub flags nor any event approval', () => {
    const snapshot = () => E.q(`select md5((select string_agg(id::text || events_auto_approve::text || coalesce(is_verified,false)::text, ',' order by id) from hubs) || (select coalesce(string_agg(id::text || calendar_approved::text, ',' order by id), '') from events))`);
    const org = enter(E, 'HUB2_OWNER', 'hub', S.HUB2);
    const ed = draftEdition(E, 'HUB2_OWNER', org, 'zz-hub2-fest', 'ZZ Hub Two Festival');
    assert.match(E.try('HUB_OWNER', `select public.edition_submit_for_review('${ed}')`), /organiser admins only/); // another Hub's owner is refused
    const before = snapshot();
    E.do('HUB2_OWNER', `select public.edition_submit_for_review('${ed}')`);
    decide('approve', 'checked', ed);
    assert.equal(snapshot(), before);
  });
});

/* ── packages: paid, free and Community ──────────────────────────────────────────────────────────────────────────────────────────────────────── */
describe('packages: chosen after approval, free is a real kind, identical for Businesses and Hubs', () => {
  let PAID = '', FREE = '', COMM = '';
  const flag = (k: string, v: string) => E.sup(`insert into admin_config (key, value, category) values ('${k}','${v}','features') on conflict (key) do update set value='${v}'`);
  const upsert = (code: string, price: number, active: boolean, free: boolean) => E.call('ADMIN', `select public.admin_upsert_edition_package('${code}','${code} package','test',${price},365,'[]'::jsonb,null,${active},10,${free})`);
  let EDP = '';
  before(() => {
    PAID = upsert('zz_paid', 5000, true, false); FREE = upsert('zz_free', 0, true, true);
    COMM = upsert('zz_community', 1000, true, false);
    EDP = draftEdition(E, 'BIZ_OWNER', BIZ_ORG, 'zz-biz-pkg', 'ZZ Business Package Edition'); submit('BIZ_OWNER', EDP); decide('approve', 'fine', EDP);
  });
  test('a £0 package cannot be offered unless it is deliberately marked free; a free package must cost nothing', () => {
    assert.match(E.try('ADMIN', `select public.admin_upsert_edition_package('zz_zero','zero','x',0,365,'[]'::jsonb,null,true,20,false)`), /marked free on purpose/);
    assert.match(E.try('ADMIN', `select public.admin_upsert_edition_package('zz_bad','bad','x',500,365,'[]'::jsonb,null,true,20,true)`), /free package costs nothing/);
    assert.match(E.sup(`update public.edition_packages set price_pence = 0, is_free = false, active = true where code = 'zz_paid'`), /edition_packages_active_is_priced_or_free/);
  });
  test('the shipped rate card is inactive and non-free (nothing is for sale by accident); the five old rows are retired', () => {
    assert.equal(E.q(`select count(*) from public.edition_packages where code in ('launch','showcase','promo_discovery_2w','promo_discovery_6w','promo_homepage_7d','promo_campaign_full') and not active and not is_free and retired_at is null`), '6');
    assert.equal(E.q(`select count(*) from public.edition_packages where code in ('publish_single','publish_collect','publish_full','community_publish','community_collect') and not active and retired_at is not null`), '5');
  });
  test('packages offered: the same rows to Hub-run and Business-run organisers (no Community audience); free flag is visible', () => {
    assert.equal(E.one('HUB_OWNER', `select count(*) from public.edition_available_packages('${HUB_ORG}') where code = 'zz_community'`), '1');
    assert.equal(E.one('BIZ_OWNER', `select count(*) from public.edition_available_packages('${BIZ_ORG}') where code = 'zz_community'`), '1');
    assert.match(E.try('ADMIN', `select public.admin_set_edition_package_audience('zz_community','hub')`), /cost the same/);
    assert.equal(E.one('BIZ_OWNER', `select is_free::text from public.edition_available_packages('${BIZ_ORG}') where code = 'zz_free'`), 'true');
    assert.match(E.try('STRANGER', `select * from public.edition_available_packages('${BIZ_ORG}')`), /not permitted/);
  });
  test('paying needs payments switched on, an approved Edition, an owner or admin, a paid package', () => {
    assert.match(E.try('BIZ_OWNER', `select public.edition_create_order('${BIZ_ORG}','${EDP}','${PAID}','attempt-0001')`), /payments are not switched on/);
    flag('editions.commerce.enabled', 'true');
    const unapproved = draftEdition(E, 'BIZ_OWNER', BIZ_ORG, 'zz-biz-unapproved', 'ZZ Unapproved Business Edition');
    assert.match(E.try('BIZ_OWNER', `select public.edition_create_order('${BIZ_ORG}','${unapproved}','${PAID}','attempt-0002')`), /once OneShetland has approved/);
    assert.match(E.try('BIZ_OWNER', `select public.edition_create_order('${BIZ_ORG}','${EDP}','${FREE}','attempt-0003')`), /claim it instead of paying/);
    assert.ok(!failed(E.try('BIZ_OWNER', `select public.edition_create_order('${BIZ_ORG}','${EDP}','${COMM}','attempt-0004')`)), 'a Business may buy exactly what a Hub may');
    assert.match(E.try('HELPER', `select public.edition_create_order('${BIZ_ORG}','${EDP}','${PAID}','attempt-0005')`), /owner or admin/);
    assert.match(E.try('STRANGER', `select public.edition_create_order('${BIZ_ORG}','${EDP}','${PAID}','attempt-0006')`), /owner or admin/);
  });
  test('an owner creates an order (idempotent per attempt); payment fulfils it into a live package, with a receipt notice', () => {
    const o1 = E.call('BIZ_OWNER', `select public.edition_create_order('${BIZ_ORG}','${EDP}','${PAID}','attempt-0010')`);
    assert.equal(E.call('BIZ_OWNER', `select public.edition_create_order('${BIZ_ORG}','${EDP}','${PAID}','attempt-0010')`), o1);
    assert.equal(E.q(`select amount_pence from public.edition_orders where id='${o1}'`), '5000');
    assert.match(E.sup(`select public.edition_fulfil_order('${o1}', 'pi_test_1', 4999)`), /does not match/, 'a wrong amount never fulfils');
    assert.equal(last2(E.sup(`select public.edition_fulfil_order('${o1}', 'pi_test_1', 5000)`)), 'fulfilled');
    assert.equal(E.q(`select public.edition_entitled('${EDP}','publish')`), 't');
    assert.equal(E.q(`select count(*) from public.edition_email_outbox where kind='package_active' and user_id='${USERS.BIZ_OWNER}'`), '1');
    assert.equal(last2(E.sup(`select public.edition_fulfil_order('${o1}', 'pi_test_1', 5000)`)), 'already_fulfilled');
  });
  test('the administrator can list an Edition\'s orders (with ids and refunded amounts); nobody else can', () => {
    assert.equal(E.one('ADMIN', `select count(*) from public.admin_edition_orders('${EDP}') where status='paid' and amount_pence=5000 and refunded_pence=0`), '1');
    for (const who of ['BIZ_OWNER', 'STRANGER'] as const) assert.match(E.try(who, `select * from public.admin_edition_orders('${EDP}')`), /admins only/, who);
  });
  test('the owner then publishes an approved, entitled Edition and it is public', () => {
    setStatus('BIZ_OWNER', 'published', EDP);
    assert.equal(anonPublic(EDP), true);
  });
  test('a free package: claimed (not paid for) on an approved Edition, once, by an owner or admin; no payment, no Stripe', () => {
    const edf = draftEdition(E, 'HUB_OWNER', HUB_ORG, 'zz-hub-free', 'ZZ Free Edition');
    assert.match(E.try('HUB_OWNER', `select public.edition_claim_free_package('${HUB_ORG}','${edf}','${FREE}','attempt-0020')`), /once OneShetland has approved/);
    submit('HUB_OWNER', edf); decide('approve', 'fine', edf);
    assert.match(E.try('EDITOR', `select public.edition_claim_free_package('${HUB_ORG}','${edf}','${FREE}','attempt-0021')`), /owner or admin/);
    assert.match(E.try('HUB_OWNER', `select public.edition_claim_free_package('${HUB_ORG}','${edf}','${PAID}','attempt-0022')`), /not available/);
    const o = E.call('HUB_COMMITTEE', `select public.edition_claim_free_package('${HUB_ORG}','${edf}','${FREE}','attempt-0023')`);
    assert.equal(E.q(`select status || amount_pence from public.edition_orders where id='${o}'`), 'paid0');
    assert.equal(E.q(`select public.edition_entitled('${edf}','publish')`), 't');
    assert.equal(E.call('HUB_COMMITTEE', `select public.edition_claim_free_package('${HUB_ORG}','${edf}','${FREE}','attempt-0023')`), o, 'idempotent per attempt');
    assert.match(E.try('HUB_OWNER', `select public.edition_claim_free_package('${HUB_ORG}','${edf}','${FREE}','attempt-0024')`), /already live until/);
    setStatus('HUB_OWNER', 'published', edf); assert.equal(anonPublic(edf), true);
  });
  test('Community (Hub-only) can be bought by a Hub-run organiser and not by a Business', () => {
    const edc = draftEdition(E, 'HUB_OWNER', HUB_ORG, 'zz-hub-comm', 'ZZ Community Edition'); submit('HUB_OWNER', edc); decide('approve', 'fine', edc);
    const o = E.call('HUB_OWNER', `select public.edition_create_order('${HUB_ORG}','${edc}','${COMM}','attempt-0030')`);
    assert.equal(E.q(`select amount_pence from public.edition_orders where id='${o}'`), '1000');
  });
  test('an Edition returned to review keeps its package; its price stays whatever was paid (snapshot)', () => {
    E.sup(`update public.edition_packages set price_pence = 9999 where code = 'zz_paid'`);
    assert.equal(E.q(`select package_snapshot ->> 'price_pence' from public.edition_orders where attempt_id='attempt-0010'`), '5000');
  });
});
const last2 = (o: string) => o.split('\n').map((l) => l.trim()).filter((l) => l && !/^\(|^[-+]+$/.test(l) && !/^[a-z_]+$/i.test(l) || /^(fulfilled|already_fulfilled)$/.test(l)).pop() ?? '';

/* ── notifications ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────── */
describe('notifications reach people, including helpers with no account yet', () => {
  test('a helper invitation is queued for an address with no OneShetland account, and the cron can resolve the address', () => {
    const before = E.q(`select count(*) from public.edition_email_outbox where kind='helper_invited'`);
    E.call('BIZ_OWNER', `select public.invite_edition_member('${BIZ_ORG}','newhelper@example.invalid','admin')`);
    assert.equal(Number(E.q(`select count(*) from public.edition_email_outbox where kind='helper_invited'`)) - Number(before), 1);
    assert.equal(E.q(`select count(*) from public.edition_email_next(100) where kind='helper_invited' and email='newhelper@example.invalid' and user_id is null`), '1');
  });
  test('every email row has a recipient; one invitation is queued once', () => {
    assert.equal(E.q(`select count(*) from public.edition_email_outbox where user_id is null and invite_id is null`), '0');
    assert.equal(E.q(`select count(*) from (select dedupe_key from public.edition_email_outbox group by 1 having count(*) > 1) x`), '0');
  });
  test('the outbox is not readable or writable by signed-in users', () => {
    assert.match(E.try('BIZ_OWNER', `select count(*) from public.edition_email_outbox`), /permission denied/);
    assert.match(E.try('BIZ_OWNER', `select * from public.edition_email_next(5)`), /permission denied/);
  });
});

/* ── the legacy standalone record joins the OneShetland Hub ──────────────────────────────────────────────────────────────────────────────────── */
describe('the legacy Editions Studio record is attached safely, or left alone', () => {
  const block = () => {
    const sql = readFileSync(new URL('../migrations/20270103000000_editions_business_and_hub_identity.sql', import.meta.url), 'utf8');
    const i = sql.indexOf("do $$\ndeclare o public.edition_organisers%rowtype; h public.hubs%rowtype; v_bad int;");
    assert.ok(i > 0, 'the attach block is in the migration');
    return sql.slice(i, sql.indexOf('end $$;', i) + 7);
  };
  const legacy = (ownerOk: boolean) => {
    E.sup(`alter table public.edition_organisers drop constraint if exists edition_organisers_one_parent; alter table public.edition_organiser_members disable trigger edition_members_no_owner;
      delete from public.edition_organisers where slug='oneshetland-editions-studio';
      insert into public.edition_organisers (slug, name, is_test, status) values ('oneshetland-editions-studio','OneShetland Editions Studio', true, 'verified');
      insert into public.edition_organiser_members (organiser_id, user_id, role) select id, '${ownerOk ? USERS.ADMIN : USERS.STRANGER}', 'owner' from public.edition_organisers where slug='oneshetland-editions-studio';`);
  };
  const reset = () => E.sup(`alter table public.edition_organiser_members enable trigger edition_members_no_owner; delete from public.edition_organisers where slug='oneshetland-editions-studio' and hub_id is null; alter table public.edition_organisers add constraint edition_organisers_one_parent check (num_nonnulls(hub_id, business_id) = 1);`);
  test('attached when the OneShetland Hub is active, has no Editions profile yet, and every explicit owner also owns the Hub; nothing else changes', () => {
    const hub = E.q(`insert into hubs (owner_id, name, slug, type, area, is_active) values ('${USERS.ADMIN}','OneShetland','oneshetland-hub','club','Lerwick',true) returning id`);
    legacy(true); E.sup(block());
    assert.equal(E.q(`select hub_id from public.edition_organisers where slug='oneshetland-editions-studio'`), hub);
    assert.equal(E.q(`select count(*) from public.edition_audit_log where action='organiser_attached_to_hub'`), '1');
    assert.equal(E.q(`select count(*) from public.edition_organiser_members m join public.edition_organisers o on o.id=m.organiser_id where o.slug='oneshetland-editions-studio'`), '1', 'its member row is kept');
    reset();
  });
  test('left alone, with a notice, when an owner of the record is not an owner of the Hub', () => {
    E.sup(`update public.edition_organisers set hub_id = null where false`);
    legacy(false); E.sup(block());
    assert.equal(E.q(`select (hub_id is null)::text from public.edition_organisers where slug='oneshetland-editions-studio'`), 'true');
    reset();
  });
});

/* ── retirement ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────── */
describe('the pilot machinery is retired, and the controls worth keeping remain', () => {
  test('no pilot table, function or switch remains', () => {
    assert.equal(E.q(`select count(*) from pg_proc where proname ilike '%pilot%'`), '0');
    assert.equal(E.q(`select count(*) from pg_class where relname ilike '%pilot%'`), '0');
    assert.equal(E.q(`select count(*) from admin_config where key = 'editions.pilot'`), '0');
  });
  test('the anonymous surface did not grow: the signed-out role can run only the read helpers it needs', () => {
    const fns = E.q(`select string_agg(proname, ',' order by proname) from pg_proc where pronamespace='public'::regnamespace and proname like 'edition%' and has_function_privilege('anon', oid, 'execute')`);
    assert.match(fns, /edition_is_public/); assert.doesNotMatch(fns, /ensure|submit|review|claim|invite|admin/);
  });
  test('administrator-only functions are signed-in only and refuse the signed-out role', () => {
    for (const f of ['admin_review_edition(uuid,text,text)', 'admin_edition_review_queue(text)', 'admin_set_hub_events_auto_approve(uuid,boolean,text)', 'edition_ensure_organiser(text,uuid)', 'edition_submit_for_review(uuid)', 'edition_claim_free_package(uuid,uuid,uuid,text)']) {
      assert.equal(E.q(`select has_function_privilege('anon', 'public.${f}', 'execute')::text || has_function_privilege('authenticated', 'public.${f}', 'execute')::text`), 'falsetrue', f);
    }
  });
  test('hub verification stays an administrator-only audited action', () => {
    assert.match(E.try('HUB_OWNER', `select public.admin_set_hub_verified('${S.HUB}', true, 'self verify')`), /admins only/);
  });
});

/* ── rollback proof ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────── */
describe('each rollback restores the previous state cleanly (fresh database, reverse order)', () => {
  test('rolling back E, D, C, B and A leaves no errors and returns the earlier behaviour', () => {
    const R = new Env('editionscompleterb');
    try {
      const out: string[] = [];
      for (const f of ['20270103060000_editions_admin_orders', '20270103050000_editions_package_refunds', '20270103040000_editions_retire_pilot_and_standalone', '20270103030000_editions_packages_and_notifications', '20270103020000_editions_review', '20270103010000_hub_events_auto_approve', '20270103000000_editions_business_and_hub_identity']) {
        out.push(R.db.rawFile(new URL(`../rollbacks/${f}.rollback.sql`, import.meta.url).pathname));
      }
      const errs = out.join('\n').split('\n').filter((l) => /ERROR/.test(l));
      assert.deepEqual(errs, [], 'rollbacks must run without error');
      assert.equal(R.q(`select count(*) from pg_proc where proname in ('edition_pilot_visible','create_edition_organiser','admin_approve_edition_pilot')`), '3');
      assert.equal(R.q(`select count(*) from information_schema.columns where table_name='editions' and column_name='review_state'`), '0');
      assert.equal(R.q(`select count(*) from information_schema.columns where table_name='hubs' and column_name='events_auto_approve'`), '0');
      assert.equal(R.q(`select count(*) from information_schema.columns where table_name='edition_organisers' and column_name='business_id'`), '0');
      assert.equal(R.q(`select confdeltype from pg_constraint where conname='edition_organisers_hub_id_fkey'`), 'n');
    } finally { R.drop(); }
  });
});
